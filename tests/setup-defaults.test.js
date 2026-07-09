// SETUP defaults — appendMode 'project' default + the layered
// setup-defaults store (src/ui/setupDefaults.js) that remembers the
// user's last-used simSetup config for seeding NEW designs.
import { describe, it, expect, beforeEach } from 'vitest';
import { normalizeScene } from '../src/scene/schema.js';
import {
  sanitizeSetup, loadSetupDefaults, hydrateSetupDefaults, saveSetupDefaults,
  _resetSetupDefaultsForTests,
} from '../src/ui/setupDefaults.js';

// ---------- normalizeScene appendMode migration ----------

describe('normalizeScene — export target default/migration', () => {
  const base = { params: {}, components: [], snaps: [], mirrors: [], groups: [], booleans: [] };

  it('defaults appendMode to "project" when absent', () => {
    expect(normalizeScene({ ...base }).simSetup.appendMode).toBe('project');
    expect(normalizeScene({ ...base, simSetup: { fnominal: '7' } }).simSetup.appendMode).toBe('project');
  });

  it('migrates the LEGACY boolean appendToActive:true to "design" (not shadowed by the default)', () => {
    const out = normalizeScene({ ...base, simSetup: { appendToActive: true } });
    expect(out.simSetup.appendMode).toBe('design');
  });

  it('preserves every explicit saved appendMode', () => {
    for (const m of ['new', 'project', 'design']) {
      expect(normalizeScene({ ...base, simSetup: { appendMode: m } }).simSetup.appendMode).toBe(m);
    }
    // explicit 'new' beats a stray legacy flag
    const out = normalizeScene({ ...base, simSetup: { appendMode: 'new', appendToActive: true } });
    expect(out.simSetup.appendMode).toBe('new');
  });

  it('is idempotent (sceneEquals/determinism contract)', () => {
    const once = normalizeScene({ ...base, simSetup: { appendToActive: true } });
    const twice = normalizeScene(once);
    expect(twice.simSetup.appendMode).toBe('design');
    expect(JSON.stringify(twice.simSetup)).toBe(JSON.stringify(once.simSetup));
  });
});

// ---------- layered store ----------

const SIM = {
  fnominal: '4', solveFreq: '', maxPasses: '15', maxDeltaS: '0.02',
  sweepEnabled: false, sweepStart: '0.5', sweepStop: '40', sweepPoints: '201',
  sweepType: 'Discrete', padXNeg: '80', padXPos: '80', padYNeg: '60', padYPos: '60',
  airPad: '120', appendMode: 'design', appendToActive: true,
};

// Minimal window.storage stand-in (returns the {value} wrapper the real
// backend uses).
const makeFakeStorage = (initial = {}) => {
  const map = new Map(Object.entries(initial));
  return {
    map,
    get: async (k) => (map.has(k) ? { value: map.get(k) } : null),
    set: async (k, v) => { map.set(k, v); },
  };
};

describe('setupDefaults store', () => {
  beforeEach(() => _resetSetupDefaultsForTests());

  it('sanitizeSetup keeps scalars, drops structured values, nulls empties', () => {
    expect(sanitizeSetup({ a: '1', b: true, c: 2.5, d: { nested: 1 }, e: [1], f: null, g: NaN }))
      .toEqual({ a: '1', b: true, c: 2.5 });
    expect(sanitizeSetup(null)).toBeNull();
    expect(sanitizeSetup([])).toBeNull();
    expect(sanitizeSetup({ only: { structured: true } })).toBeNull();
  });

  it('save → load round-trips through the in-memory cache (no window needed)', () => {
    expect(loadSetupDefaults()).toBeNull();
    expect(saveSetupDefaults(SIM)).toBe(true);
    expect(loadSetupDefaults()).toEqual(SIM);
  });

  it('save writes through to the durable store; a fresh session hydrates it back', async () => {
    const storage = makeFakeStorage();
    saveSetupDefaults(SIM, storage);
    await Promise.resolve(); // let the fire-and-forget set land
    expect(storage.map.get('photonic_layout_setup_defaults')).toBe(JSON.stringify(SIM));

    _resetSetupDefaultsForTests(); // "reload"
    expect(loadSetupDefaults()).toBeNull();
    const hydrated = await hydrateSetupDefaults(storage);
    expect(hydrated).toEqual(SIM);
    expect(loadSetupDefaults()).toEqual(SIM);
  });

  it('a late hydrate never clobbers a value saved earlier this session', async () => {
    const storage = makeFakeStorage({ photonic_layout_setup_defaults: JSON.stringify({ fnominal: 'STALE' }) });
    saveSetupDefaults(SIM, storage);
    const after = await hydrateSetupDefaults(storage);
    expect(after).toEqual(SIM); // not the STALE blob
  });

  it('a save landing WHILE the hydrate read is in flight wins over the durable blob', async () => {
    const storage = makeFakeStorage({ photonic_layout_setup_defaults: JSON.stringify({ fnominal: 'STALE' }) });
    let release;
    const gate = new Promise(r => { release = r; });
    const slowStorage = {
      get: async (k) => { await gate; return storage.get(k); },
      set: storage.set,
    };
    const pending = hydrateSetupDefaults(slowStorage); // read in flight
    saveSetupDefaults(SIM, storage);                   // user edit lands first
    release();
    await pending;
    expect(loadSetupDefaults()).toEqual(SIM); // not clobbered by the resolve
  });

  it('hydrate swallows a corrupted durable blob (falls back to null)', async () => {
    const storage = makeFakeStorage({ photonic_layout_setup_defaults: '{not json' });
    expect(await hydrateSetupDefaults(storage)).toBeNull();
  });

  it('refuses to persist garbage (no cache poisoning)', () => {
    expect(saveSetupDefaults(null)).toBe(false);
    expect(saveSetupDefaults({ only: { structured: true } })).toBe(false);
    expect(loadSetupDefaults()).toBeNull();
  });
});

// ---------- seeding semantics (pure helper contract) ----------

describe('fresh-scene seeding contract', () => {
  beforeEach(() => _resetSetupDefaultsForTests());

  it('remembered values override schema defaults but a design own simSetup wins over both at load', () => {
    saveSetupDefaults(SIM);
    const remembered = loadSetupDefaults();
    // Fresh scene: schema defaults + remembered (what seedSimSetup does).
    const fresh = normalizeScene({
      params: {}, components: [], snaps: [], mirrors: [], groups: [], booleans: [],
      simSetup: { ...remembered },
    });
    expect(fresh.simSetup.appendMode).toBe('design');
    expect(fresh.simSetup.sweepType).toBe('Discrete');
    expect(fresh.simSetup.sweepEnabled).toBe(false);
    // Loading an EXISTING design: its stored simSetup passes through
    // normalize untouched by the store (no seeding on load).
    const existing = normalizeScene({
      params: {}, components: [], snaps: [], mirrors: [], groups: [], booleans: [],
      simSetup: { appendMode: 'new', sweepType: 'Fast' },
    });
    expect(existing.simSetup.appendMode).toBe('new');
    expect(existing.simSetup.sweepType).toBe('Fast');
  });
});
