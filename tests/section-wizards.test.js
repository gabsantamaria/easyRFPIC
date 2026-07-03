// Section-wizard settings + role heuristic. Deliberately does NOT import the
// .jsx wizard files (no DOM in the vitest node env) — everything testable
// lives in src/ui/sectionWizardSettings.js: the layered prefs store (session
// cache → window.storage/IndexedDB → localStorage, per-wizard partial merge)
// and the pure defaultRoles(cross) signal/ground heuristic.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  SECTION_WIZARD_KEY,
  defaultRoles,
  loadSectionWizardPrefs,
  saveSectionWizardPrefs,
  hydrateSectionWizardPrefs,
  _resetSectionWizardPrefsForTests,
} from '../src/ui/sectionWizardSettings.js';

// Canonical cross-section contract fixture (CPW on thin-film LN) — local copy
// per the contract instructions (fixtures are NOT shared between modules).
const FIXTURE_CROSS = {
  ok: true, sectionId: 'sec1',
  line: { p0: { x: -60, y: 0 }, p1: { x: 60, y: 0 }, lengthUm: 120, axis: 'h' },
  domain: { tMin: 0, tMax: 120, zMin: -54.7, zMax: 21.4 },
  slabs: [
    { layerId: 'l_si',   name: 'Si',       material: 'silicon', color: '#64748b', role: 'substrate', z0: -54.7, z1: -4.7 },
    { layerId: 'l_sio2', name: 'SiO2',     material: 'SiO2',    color: '#94a3b8', role: 'substrate', z0: -4.7,  z1: 0 },
    { layerId: 'l_wg',   name: 'LN film',  material: 'LiNbO3',  color: '#7dd3fc', role: 'waveguide', z0: 0, z1: 0.6, z0Expr: '(0)um', z1Expr: '(h_wg)um' },
    { layerId: 'l_clad', name: 'cladding', material: 'SiO2',    color: '#cbd5e1', role: 'cladding',  z0: 0.6, z1: 5.3 },
    { layerId: '__air',  name: 'air',      material: 'vacuum',  color: '#e2e8f0', role: 'air',       z0: 5.3, z1: 21.4 },
  ],
  conductors: [
    { id: 'gnd_top', label: 'gnd_top', layerId: 'l_cond', material: 'gold', color: '#fbbf24', zeroThickness: false, areaUm2: 32,
      z0: 0.6, z1: 1.4, z0Expr: '(h_wg)um', z1Expr: '(h_wg + h_cond)um',
      intervals: [ { t0: 0, t1: 40, t0Expr: '(0)um', t1Expr: '(40)um' } ] },
    { id: 'sig', label: 'sig', layerId: 'l_cond', material: 'gold', color: '#fbbf24', zeroThickness: false, areaUm2: 8,
      z0: 0.6, z1: 1.4, intervals: [ { t0: 45, t1: 55 } ] },
    { id: 'gnd_bot', label: 'gnd_bot', layerId: 'l_cond', material: 'gold', color: '#fbbf24', zeroThickness: false, areaUm2: 32,
      z0: 0.6, z1: 1.4, intervals: [ { t0: 60, t1: 100 } ] },
  ],
  waveguides: [
    { id: 'wg1', layerId: 'l_wg', material: 'LiNbO3', color: '#7dd3fc',
      slabBand: { z0: 0, z1: 0.3, intervals: [ { t0: 0, t1: 120 } ] },
      core: { zBot: 0.3, zTop: 0.6, segments: [ { botT0: 48.9, botT1: 51.1, topT0: 49.25, topT1: 50.75 } ] } },
  ],
  wgCenter: { t: 50, z: 0.45, compId: 'wg1' },
  params: { h_wg: 0.6, h_cond: 0.8 },
  warnings: [],
};

const condsWithAreas = (areas) => ({
  ok: true,
  conductors: areas.map((a, i) => ({ id: `c${i}`, areaUm2: a })),
});

describe('defaultRoles heuristic', () => {
  it('CPW fixture: two big pours → ground, the small strip → signal', () => {
    expect(defaultRoles(FIXTURE_CROSS)).toEqual({
      gnd_top: 'ground',
      sig: 'signal',
      gnd_bot: 'ground',
    });
  });

  it('the 0.8·maxArea threshold is inclusive (near-tie pours stay ground)', () => {
    // 26 ≥ 0.8·32 → still a ground pour; 8 < 0.8·32 → signal.
    const roles = defaultRoles(condsWithAreas([32, 26, 8]));
    expect(roles).toEqual({ c0: 'ground', c1: 'ground', c2: 'signal' });
  });

  it('all-equal areas → everything would be ground; the smallest (first on tie) flips to signal', () => {
    const roles = defaultRoles(condsWithAreas([10, 10, 10]));
    expect(roles).toEqual({ c0: 'signal', c1: 'ground', c2: 'ground' });
    expect(Object.values(roles).filter((r) => r === 'signal')).toHaveLength(1);
  });

  it('near-equal areas: the strictly-smallest flips to signal', () => {
    // 9 ≥ 0.8·10 so nothing classifies as signal — the 9 flips.
    const roles = defaultRoles(condsWithAreas([10, 9, 10]));
    expect(roles).toEqual({ c0: 'ground', c1: 'signal', c2: 'ground' });
  });

  it('single conductor → signal (the ≥2-conductor failure is validation, not defaults)', () => {
    expect(defaultRoles(condsWithAreas([32]))).toEqual({ c0: 'signal' });
  });

  it('no conductors / malformed input → empty map', () => {
    expect(defaultRoles({ ok: true, conductors: [] })).toEqual({});
    expect(defaultRoles(null)).toEqual({});
    expect(defaultRoles({})).toEqual({});
  });

  it('non-finite areas count as 0 (they never claim the ground pour role)', () => {
    const roles = defaultRoles(condsWithAreas([32, NaN]));
    expect(roles).toEqual({ c0: 'ground', c1: 'signal' });
  });
});

describe('prefs store — partial merge + normalization (session cache only)', () => {
  beforeEach(() => _resetSectionWizardPrefsForTests());
  afterEach(() => { _resetSectionWizardPrefsForTests(); delete globalThis.window; });

  it('starts empty', () => {
    expect(loadSectionWizardPrefs()).toBeNull();
  });

  it('saving one wizard slice never clobbers the other', () => {
    saveSectionWizardPrefs({ q2d: { freqStart: '5', cgErr: '0.05' } });
    saveSectionWizardPrefs({ tidy3d: { lambdaUm: '1.31', eoAxis: 'horizontal' } });
    const p = loadSectionWizardPrefs();
    expect(p.q2d.freqStart).toBe('5');
    expect(p.q2d.cgErr).toBe('0.05');
    expect(p.tidy3d.lambdaUm).toBe('1.31');
    expect(p.tidy3d.eoAxis).toBe('horizontal');
  });

  it('per-field merge within a slice: a later partial save keeps earlier fields', () => {
    saveSectionWizardPrefs({ q2d: { freqStart: '5' } });
    saveSectionWizardPrefs({ q2d: { freqStop: '67' } });
    const p = loadSectionWizardPrefs();
    expect(p.q2d.freqStart).toBe('5');
    expect(p.q2d.freqStop).toBe('67');
  });

  it('normalizes: numbers → strings, unknown keys dropped, invalid roles/eoAxis rejected', () => {
    saveSectionWizardPrefs({
      q2d: { minPass: 3, bogus: 'x', roles: { a: 'ground', b: 'signal', c: 'floating', d: 42 } },
      tidy3d: { eoAxis: 'diagonal', ne: 2.2 },
    });
    const p = loadSectionWizardPrefs();
    expect(p.q2d.minPass).toBe('3');
    expect(p.q2d).not.toHaveProperty('bogus');
    expect(p.q2d.roles).toEqual({ a: 'ground', b: 'signal' });
    expect(p.tidy3d.eoAxis).toBe('vertical'); // anything not 'horizontal' → the z-cut default
    expect(p.tidy3d.ne).toBe('2.2');
  });
});

describe('layered persistence (session cache → window.storage → localStorage)', () => {
  // The user's browser SILENTLY DROPS localStorage writes — the store must
  // survive on the session cache + window.storage (IndexedDB) alone. Mirrors
  // tests/settings.test.js's layered block.
  const withDeadLocalStorage = (idb) => {
    globalThis.window = {
      storage: {
        get: async (k) => (idb.has(k) ? { value: idb.get(k) } : null),
        set: async (k, v) => { idb.set(k, v); },
      },
      localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    };
  };

  beforeEach(() => _resetSectionWizardPrefsForTests());
  afterEach(() => { _resetSectionWizardPrefsForTests(); delete globalThis.window; });

  it('save writes through to window.storage; the session cache serves loads despite dead localStorage', async () => {
    const idb = new Map();
    withDeadLocalStorage(idb);
    saveSectionWizardPrefs({ q2d: { freqStart: '10' } });
    expect(loadSectionWizardPrefs().q2d.freqStart).toBe('10');
    await new Promise((r) => setTimeout(r, 0)); // fire-and-forget IDB write lands
    expect(idb.has(SECTION_WIZARD_KEY)).toBe(true);
    expect(JSON.parse(idb.get(SECTION_WIZARD_KEY)).q2d.freqStart).toBe('10');
  });

  it('hydrate restores durable values on a fresh boot (localStorage empty)', async () => {
    const idb = new Map([[SECTION_WIZARD_KEY, JSON.stringify({ q2d: { freqStop: '110' }, tidy3d: { lambdaUm: '1.31' } })]]);
    withDeadLocalStorage(idb);
    const p = await hydrateSectionWizardPrefs();
    expect(p.q2d.freqStop).toBe('110');
    expect(p.tidy3d.lambdaUm).toBe('1.31');
    expect(loadSectionWizardPrefs().q2d.freqStop).toBe('110'); // cache populated by hydrate
  });

  it('a session save made before hydrate resolves wins over the durable value', async () => {
    const idb = new Map([[SECTION_WIZARD_KEY, JSON.stringify({ q2d: { freqStop: '110' } })]]);
    withDeadLocalStorage(idb);
    saveSectionWizardPrefs({ q2d: { freqStop: '67' } });
    const p = await hydrateSectionWizardPrefs();
    expect(p.q2d.freqStop).toBe('67'); // session cache authoritative
  });

  it('hydrate is a no-op when the durable store is empty', async () => {
    withDeadLocalStorage(new Map());
    expect(await hydrateSectionWizardPrefs()).toBeNull();
    expect(loadSectionWizardPrefs()).toBeNull();
  });

  it('a working localStorage gives a synchronous restore on a fresh boot', () => {
    // No window at first save; then a "reload" with only localStorage holding the value.
    const map = new Map([[SECTION_WIZARD_KEY, JSON.stringify({ tidy3d: { numModes: '4' } })]]);
    globalThis.window = {
      localStorage: {
        getItem: (k) => (map.has(k) ? map.get(k) : null),
        setItem: (k, v) => { map.set(k, v); },
      },
    };
    expect(loadSectionWizardPrefs().tidy3d.numModes).toBe('4');
  });
});

describe('defaultRoles: zero-thickness (sheet) conductors', () => {
  // areaUm2 === 0 for every sheet (z1 === z0) — the heuristic must fall back
  // to crossed WIDTH, so a wide ground pour beats a narrow signal strip.
  it('widths pick the ground on an h_cond=0 CPW', () => {
    const cross = {
      ok: true,
      conductors: [
        { id: 'gnd_a', areaUm2: 0, zeroThickness: true, intervals: [{ t0: 0, t1: 40 }] },
        { id: 'sig',   areaUm2: 0, zeroThickness: true, intervals: [{ t0: 45, t1: 55 }] },
        { id: 'gnd_b', areaUm2: 0, zeroThickness: true, intervals: [{ t0: 60, t1: 100 }] },
      ],
    };
    const roles = defaultRoles(cross);
    expect(roles).toEqual({ gnd_a: 'ground', sig: 'signal', gnd_b: 'ground' });
  });
});
