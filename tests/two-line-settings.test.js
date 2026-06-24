// 2-line wizard preference persistence (src/ui/twoLineSettings.js).
//
// The wizard "remembers my last entries" across three layers — in-memory
// session cache, IndexedDB (window.storage), and best-effort localStorage.
// These tests pin the contract that matters for the real bug we chased: the
// in-memory cache makes same-session close→reopen survive EVEN WHEN the
// browser silently drops localStorage writes (privacy mode / blocked storage).
import { describe, it, expect, afterEach, vi } from 'vitest';

const KEY = 'photonic_layout_two_line';

// Fake localStorage. blockWrites=true simulates Safari private mode / a
// blocked-storage policy where setItem throws (and getItem yields nothing).
function makeLS({ blockWrites = false } = {}) {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { if (blockWrites) throw new Error('storage blocked'); map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    _map: map,
  };
}

// Fake window.storage (the IndexedDB-backed shim): async KV whose get returns
// the {value} wrapper the real shim uses.
function makeWinStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    get: async (k) => (map.has(k) ? { value: map.get(k) } : null),
    set: async (k, v) => { map.set(k, String(v)); },
    delete: async (k) => { map.delete(k); },
    _map: map,
  };
}

// Fresh module instance (resets the module-level cache/hydrated flags) wired
// to a fresh window.
async function freshModule({ ls, storage } = {}) {
  vi.resetModules();
  globalThis.window = {};
  if (ls !== null) globalThis.window.localStorage = ls || makeLS();
  if (storage) globalThis.window.storage = storage;
  return import('../src/ui/twoLineSettings.js');
}

afterEach(() => { delete globalThis.window; });

const SAMPLE = {
  lengthParam: 'mod_L', l1: '100', l2: '600', separation: '',
  freqStart: '0.1', freqStop: '50', freqPoints: '500', cFperM: '',
  q3dThk: '0.8', q3dLen: '', bundleQ3D: true, q3dIds: ['cond1', 'cond2'],
  q3dCg: '0.01', q3dMinP: '15', q3dMaxP: '20',
  sheetRs: '0', sheetXs: '2*pi*Freq*10e-12',
};

describe('save → load round-trip', () => {
  it('persists and restores every field within a session', async () => {
    const { saveTwoLinePrefs, loadTwoLinePrefs } = await freshModule({ storage: makeWinStorage() });
    saveTwoLinePrefs(SAMPLE);
    expect(loadTwoLinePrefs()).toEqual(SAMPLE);
  });

  it('writes through to localStorage and to the durable window.storage', async () => {
    const ls = makeLS();
    const storage = makeWinStorage();
    const { saveTwoLinePrefs } = await freshModule({ ls, storage });
    saveTwoLinePrefs(SAMPLE);
    // localStorage is synchronous
    expect(JSON.parse(ls._map.get(KEY))).toEqual(SAMPLE);
    // window.storage.set is async fire-and-forget — let the microtask settle
    await Promise.resolve();
    expect(JSON.parse(storage._map.get(KEY))).toEqual(SAMPLE);
  });
});

describe('same-session close→reopen — the real bug', () => {
  it('survives a browser that silently drops localStorage writes', async () => {
    // No durable store, localStorage throws on every set: the ONLY thing that
    // can carry the values across a wizard close→reopen is the in-memory cache.
    const ls = makeLS({ blockWrites: true });
    const { saveTwoLinePrefs, loadTwoLinePrefs } = await freshModule({ ls });
    // User changes L1 and closes the wizard:
    saveTwoLinePrefs({ ...SAMPLE, l1: '12345' });
    // localStorage really did reject the write:
    expect(ls._map.has(KEY)).toBe(false);
    // Reopen (same module instance / same session): value is still there.
    expect(loadTwoLinePrefs().l1).toBe('12345');
  });

  it('survives with no window.storage and no localStorage at all', async () => {
    const { saveTwoLinePrefs, loadTwoLinePrefs } = await freshModule({ ls: null });
    saveTwoLinePrefs({ ...SAMPLE, l2: '999' });
    expect(loadTwoLinePrefs().l2).toBe('999');
  });
});

describe('cross-session hydrate from durable store (reload)', () => {
  it('hydrateTwoLinePrefs restores from window.storage when localStorage is empty', async () => {
    // Simulate a reload: nothing in this session's cache or localStorage, but
    // a prior session persisted to IndexedDB.
    const storage = makeWinStorage({ [KEY]: JSON.stringify({ ...SAMPLE, l1: '777' }) });
    const mod = await freshModule({ storage });
    expect(mod.loadTwoLinePrefs()).toBe(null); // not yet hydrated, localStorage empty
    const hydrated = await mod.hydrateTwoLinePrefs();
    expect(hydrated.l1).toBe('777');
    expect(mod.loadTwoLinePrefs().l1).toBe('777'); // now served synchronously
  });

  it('a value saved this session is not clobbered by a late hydrate', async () => {
    const storage = makeWinStorage({ [KEY]: JSON.stringify({ ...SAMPLE, l1: 'STALE' }) });
    const mod = await freshModule({ storage });
    mod.saveTwoLinePrefs({ ...SAMPLE, l1: 'FRESH' });
    await mod.hydrateTwoLinePrefs(); // arrives after the user already edited
    expect(mod.loadTwoLinePrefs().l1).toBe('FRESH');
  });

  it('loadTwoLinePrefs falls back to a synchronous localStorage read before hydrate', async () => {
    const ls = makeLS();
    ls._map.set(KEY, JSON.stringify({ ...SAMPLE, l2: '4242' }));
    const { loadTwoLinePrefs } = await freshModule({ ls });
    expect(loadTwoLinePrefs().l2).toBe('4242');
  });
});

describe('normalize / coercion', () => {
  it('coerces numbers to strings, filters bad q3dIds, types bundleQ3D', async () => {
    const { saveTwoLinePrefs, loadTwoLinePrefs } = await freshModule({});
    saveTwoLinePrefs({
      lengthParam: 'mod_L', l1: 100, l2: 600, freqPoints: 500,
      bundleQ3D: 1, q3dIds: ['cond1', 5, null, 'cond2'],
    });
    const p = loadTwoLinePrefs();
    expect(p.l1).toBe('100');
    expect(p.l2).toBe('600');
    expect(p.freqPoints).toBe('500');
    expect(p.bundleQ3D).toBe(true);
    expect(p.q3dIds).toEqual(['cond1', 'cond2']);
    // missing fields normalize to empty strings, not undefined
    expect(p.separation).toBe('');
    expect(p.cFperM).toBe('');
  });

  it('load returns null when nothing is stored anywhere', async () => {
    const { loadTwoLinePrefs } = await freshModule({ storage: makeWinStorage() });
    expect(loadTwoLinePrefs()).toBe(null);
  });
});
