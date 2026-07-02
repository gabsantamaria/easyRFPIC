// Settings model: load/save round-trip, legacy edit-dims migration, theme-id
// validation, and PARTIAL import semantics (only present-and-valid keys are
// applied; everything else keeps its current value).
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SETTINGS,
  SETTINGS_KEY,
  loadSettings,
  saveSettings,
  coerceSettings,
  buildSettingsExport,
  parseSettingsImport,
} from '../src/ui/settings.js';

const LEGACY_KEY = 'photonic_layout_edit_dims';

function makeLS(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    _map: map,
  };
}

describe('defaults + load/save round-trip', () => {
  it('empty storage yields DEFAULT_SETTINGS', () => {
    const ls = makeLS();
    expect(loadSettings(ls)).toEqual({ ...DEFAULT_SETTINGS });
  });

  it('save then load round-trips every key', () => {
    const ls = makeLS();
    const custom = { ...DEFAULT_SETTINGS, theme: 'midnight', gridSize: 5, gridSnap: false, showDimensionsOnSelect: false };
    expect(saveSettings(custom, ls)).toBe(true);
    expect(loadSettings(ls)).toEqual(custom);
  });

  it('save whitelists keys — sensitive/extraneous fields never persist', () => {
    const ls = makeLS();
    saveSettings({ ...DEFAULT_SETTINGS, theme: 'paper', apiKey: 'sk-secret', bogus: 1 }, ls);
    const stored = JSON.parse(ls.getItem(SETTINGS_KEY));
    expect(stored.apiKey).toBeUndefined();
    expect(stored.bogus).toBeUndefined();
    expect(stored.theme).toBe('paper');
    expect(Object.keys(stored).sort()).toEqual(Object.keys(DEFAULT_SETTINGS).sort());
  });

  it('corrupt stored JSON falls back to defaults', () => {
    const ls = makeLS({ [SETTINGS_KEY]: '{not valid json' });
    expect(loadSettings(ls)).toEqual({ ...DEFAULT_SETTINGS });
  });

  it('stored settings merge over defaults; unknown/invalid keys are dropped', () => {
    const ls = makeLS({ [SETTINGS_KEY]: JSON.stringify({ theme: 'blueprint', gridSize: 'oops', mystery: true }) });
    const loaded = loadSettings(ls);
    expect(loaded.theme).toBe('blueprint');
    expect(loaded.gridSize).toBe(DEFAULT_SETTINGS.gridSize); // invalid → default
    expect(loaded).not.toHaveProperty('mystery');
  });
});

describe('legacy edit-dims migration', () => {
  it('migrates legacy "0" → showDimensionsOnSelect false (only when no settings key)', () => {
    const ls = makeLS({ [LEGACY_KEY]: '0' });
    expect(loadSettings(ls).showDimensionsOnSelect).toBe(false);
  });

  it('legacy "1" (or absent) → showDimensionsOnSelect true', () => {
    expect(loadSettings(makeLS({ [LEGACY_KEY]: '1' })).showDimensionsOnSelect).toBe(true);
    expect(loadSettings(makeLS()).showDimensionsOnSelect).toBe(true);
  });

  it('does NOT consult legacy once a settings key exists', () => {
    // New settings say ON; legacy says OFF — new wins.
    const ls = makeLS({
      [SETTINGS_KEY]: JSON.stringify({ ...DEFAULT_SETTINGS, showDimensionsOnSelect: true }),
      [LEGACY_KEY]: '0',
    });
    expect(loadSettings(ls).showDimensionsOnSelect).toBe(true);
  });
});

describe('coerceSettings validation', () => {
  it('keeps valid present keys, rejects bad values', () => {
    const { values, applied, skipped } = coerceSettings({
      theme: 'midnight',
      gridSnap: 'yes',     // not a boolean → reject
      gridSize: -2,        // <= 0 → reject
      showDimensionsOnSelect: false,
    });
    expect(values).toEqual({ theme: 'midnight', showDimensionsOnSelect: false });
    expect(applied.sort()).toEqual(['showDimensionsOnSelect', 'theme']);
    expect(skipped.sort()).toEqual(['gridSize', 'gridSnap']);
  });

  it('rejects an unknown theme id', () => {
    expect(coerceSettings({ theme: 'neon' }).values).toEqual({});
    expect(coerceSettings({ theme: 'paper' }).values).toEqual({ theme: 'paper' });
  });

  it('clamps gridSize to the valid range', () => {
    expect(coerceSettings({ gridSize: 0.01 }).values.gridSize).toBe(0.1);
    expect(coerceSettings({ gridSize: '3.5' }).values.gridSize).toBe(3.5);
  });
});

describe('partial import', () => {
  const current = { ...DEFAULT_SETTINGS, theme: 'midnight', gridSize: 5, gridSnap: true };

  it('only present-and-valid keys are applied; the rest keep current values', () => {
    const { settings, applied } = parseSettingsImport({ settings: { gridVisible: false } }, current);
    expect(settings.gridVisible).toBe(false);   // applied
    expect(settings.theme).toBe('midnight');    // untouched
    expect(settings.gridSize).toBe(5);          // untouched
    expect(applied).toEqual(['gridVisible']);
  });

  it('a missing key is left at its current value (not reset to default)', () => {
    // current.theme is midnight; import omits theme entirely.
    const { settings } = parseSettingsImport({ settings: { gridSnap: false } }, current);
    expect(settings.theme).toBe('midnight');
    expect(settings.gridSnap).toBe(false);
  });

  it('an invalid value is skipped, leaving the current value intact', () => {
    const { settings, applied, skipped } = parseSettingsImport({ settings: { theme: 'bogus', gridVisible: false } }, current);
    expect(settings.theme).toBe('midnight'); // bad theme rejected → current kept
    expect(settings.gridVisible).toBe(false);
    expect(applied).toEqual(['gridVisible']);
    expect(skipped).toEqual(['theme']);
  });

  it('accepts a bare settings object (no { format, settings } wrapper)', () => {
    const { settings } = parseSettingsImport({ theme: 'paper' }, current);
    expect(settings.theme).toBe('paper');
  });

  it('merges over defaults when current is partial/missing', () => {
    const { settings } = parseSettingsImport({ settings: { theme: 'paper' } }, null);
    expect(settings).toEqual({ ...DEFAULT_SETTINGS, theme: 'paper' });
  });
});

describe('buildSettingsExport', () => {
  it('produces a tagged, versioned, whitelisted payload', () => {
    const payload = buildSettingsExport({ ...DEFAULT_SETTINGS, theme: 'blueprint', apiKey: 'sk-secret' }, '2026-06-20T00:00:00.000Z');
    expect(payload.format).toBe('photonic-layout-settings');
    expect(payload.version).toBe(1);
    expect(payload.exportedAt).toBe('2026-06-20T00:00:00.000Z');
    expect(payload.settings.theme).toBe('blueprint');
    expect(payload.settings).not.toHaveProperty('apiKey');
    expect(Object.keys(payload.settings).sort()).toEqual(Object.keys(DEFAULT_SETTINGS).sort());
  });

  it('round-trips through parseSettingsImport', () => {
    const original = { ...DEFAULT_SETTINGS, theme: 'midnight', gridSize: 4, showDimensionsOverlay: true };
    const payload = buildSettingsExport(original, null);
    const { settings } = parseSettingsImport(payload, DEFAULT_SETTINGS);
    expect(settings).toEqual(original);
  });
});

describe('layered persistence (session cache → window.storage → localStorage)', () => {
  // The no-arg load/save path must survive a browser that silently drops
  // localStorage writes (this user's environment) by writing through to
  // window.storage and holding a session cache. See twoLineSettings.js for
  // the pattern's origin. Explicit-storage calls (all tests above) bypass it.
  const withDeadLocalStorage = (idb) => {
    globalThis.window = {
      storage: {
        get: async (k) => (idb.has(k) ? { value: idb.get(k) } : null),
        set: async (k, v) => { idb.set(k, v); },
      },
      // localStorage that SILENTLY DROPS writes (the user's browser).
      localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    };
  };
  const setup = async (idb) => {
    withDeadLocalStorage(idb);
    const mod = await import('../src/ui/settings.js');
    mod._resetSettingsLayersForTests();
    return mod;
  };

  it('saveSettings writes through to window.storage and the session cache serves loads', async () => {
    const idb = new Map();
    const mod = await setup(idb);
    try {
      mod.saveSettings({ ...DEFAULT_SETTINGS, theme: 'midnight', gridSize: 7 });
      // Session cache: load restores despite the dead localStorage.
      expect(mod.loadSettings().theme).toBe('midnight');
      expect(mod.loadSettings().gridSize).toBe(7);
      // Durable layer got the write.
      await new Promise((r) => setTimeout(r, 0));
      expect(idb.has(SETTINGS_KEY)).toBe(true);
      expect(JSON.parse(idb.get(SETTINGS_KEY)).theme).toBe('midnight');
    } finally { mod._resetSettingsLayersForTests(); delete globalThis.window; }
  });

  it('hydrateSettings restores durable values on a fresh boot', async () => {
    const idb = new Map([[SETTINGS_KEY, JSON.stringify({ ...DEFAULT_SETTINGS, theme: 'paper' })]]);
    const mod = await setup(idb);
    try {
      const durable = await mod.hydrateSettings();
      expect(durable.theme).toBe('paper');
      expect(mod.loadSettings().theme).toBe('paper'); // cache populated by hydrate
    } finally { mod._resetSettingsLayersForTests(); delete globalThis.window; }
  });

  it('a session save made before hydrate resolves wins over the durable value', async () => {
    const idb = new Map([[SETTINGS_KEY, JSON.stringify({ ...DEFAULT_SETTINGS, theme: 'paper' })]]);
    const mod = await setup(idb);
    try {
      mod.saveSettings({ ...DEFAULT_SETTINGS, theme: 'blueprint' });
      const durable = await mod.hydrateSettings();
      expect(durable.theme).toBe('blueprint'); // session cache authoritative
    } finally { mod._resetSettingsLayersForTests(); delete globalThis.window; }
  });
});
