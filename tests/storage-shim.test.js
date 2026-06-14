// window.storage shim — IndexedDB backend, localStorage migration, and
// the >5 MB payload that motivated the switch.
//
// vitest runs in the `node` environment (no window/localStorage/indexedDB),
// so we stand up a fresh fake-indexeddb + a Map-backed localStorage per
// test and install the shim onto a synthetic window.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { saveDesign, loadDesign, listSavedDesigns } from '../src/storage/workspace.js';

let installStorageShim;

function makeLocalStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    get length() { return map.size; },
    key: (i) => Array.from(map.keys())[i] ?? null,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    _map: map,
  };
}

async function freshShim({ withIndexedDB = true, localStorageSeed = null } = {}) {
  // Each test gets an isolated module instance so the shim's memoized
  // backend promise doesn't leak across tests.
  if (withIndexedDB) globalThis.indexedDB = new IDBFactory();
  else delete globalThis.indexedDB;
  const ls = makeLocalStorage(localStorageSeed || {});
  globalThis.localStorage = ls;
  globalThis.window = { localStorage: ls };
  vi.resetModules();
  const mod = await import('../src/storage/window-storage-shim.js');
  installStorageShim = mod.installStorageShim;
  installStorageShim();
  return { ls };
}

beforeEach(() => {
  delete globalThis.window;
  delete globalThis.indexedDB;
  delete globalThis.localStorage;
});

describe('storage shim — IndexedDB backend', () => {
  it('round-trips get/set/delete/list through window.storage', async () => {
    await freshShim();
    await window.storage.set('photonic_layout:alpha', '{"x":1}');
    await window.storage.set('photonic_layout:beta', '{"y":2}');
    expect((await window.storage.get('photonic_layout:alpha')).value).toBe('{"x":1}');
    const { keys } = await window.storage.list('photonic_layout:');
    expect(keys.sort()).toEqual(['photonic_layout:alpha', 'photonic_layout:beta']);
    await window.storage.delete('photonic_layout:alpha');
    expect(await window.storage.get('photonic_layout:alpha')).toBe(null);
    expect((await window.storage.list('photonic_layout:')).keys).toEqual(['photonic_layout:beta']);
  });

  it('stores a >5 MB payload that localStorage could never hold', async () => {
    await freshShim();
    // ~8 MB string — well past the ~5 MB localStorage origin cap.
    const big = 'x'.repeat(8 * 1024 * 1024);
    const res = await saveDesign('', 'huge', { scene: { blob: big } });
    expect(res.ok).toBe(true);
    const back = await loadDesign('', 'huge');
    expect(back.scene.blob.length).toBe(big.length);
  });

  it('works through the real workspace API (saveDesign / listSavedDesigns)', async () => {
    await freshShim();
    expect((await saveDesign('', 'd1', { scene: {} })).ok).toBe(true);
    expect((await saveDesign('proj', 'd2', { scene: {} })).ok).toBe(true);
    expect(await listSavedDesigns('')).toContain('d1');
    expect(await listSavedDesigns('proj')).toContain('d2');
  });
});

describe('storage shim — localStorage migration', () => {
  it('copies existing photonic_layout* keys into IndexedDB on first use', async () => {
    await freshShim({ localStorageSeed: {
      'photonic_layout:olddesign': '{"scene":{"old":true}}',
      'photonic_layout_lib:item1': '{"lib":1}',
      'unrelated_key': 'keep-out',
    } });
    // Readable through the (now IndexedDB-backed) storage interface.
    expect((await window.storage.get('photonic_layout:olddesign')).value).toBe('{"scene":{"old":true}}');
    expect((await window.storage.get('photonic_layout_lib:item1')).value).toBe('{"lib":1}');
    // Non-app keys are not migrated.
    expect(await window.storage.get('unrelated_key')).toBe(null);
    // And the design loads through the real API.
    const d = await loadDesign('', 'olddesign');
    expect(d.scene.old).toBe(true);
  });

  it('does NOT migrate the AI settings key (stays in localStorage only)', async () => {
    await freshShim({ localStorageSeed: {
      'photonic_layout_ai_settings': '{"apiKey":"sk-ant-secret"}',
      'photonic_layout:keep': '{"a":1}',
    } });
    expect(await window.storage.get('photonic_layout_ai_settings')).toBe(null);
    expect((await window.storage.get('photonic_layout:keep')).value).toBe('{"a":1}');
  });

  it('migration runs once — a later localStorage edit is not re-imported', async () => {
    const { ls } = await freshShim({ localStorageSeed: { 'photonic_layout:one': 'v1' } });
    await window.storage.get('photonic_layout:one'); // triggers backend init + migration
    // Simulate a stale localStorage entry appearing after migration.
    ls.setItem('photonic_layout:one', 'STALE');
    // Re-install on the SAME indexedDB + localStorage (fresh module state,
    // and clear window.storage so the install runs again).
    delete window.storage;
    vi.resetModules();
    const mod = await import('../src/storage/window-storage-shim.js');
    mod.installStorageShim();
    // Flag persisted in IndexedDB → migration skipped → IDB value wins.
    expect((await window.storage.get('photonic_layout:one')).value).toBe('v1');
  });
});

describe('storage shim — fallback', () => {
  it('falls back to localStorage when IndexedDB is absent', async () => {
    await freshShim({ withIndexedDB: false });
    await window.storage.set('photonic_layout:fb', 'hello');
    expect((await window.storage.get('photonic_layout:fb')).value).toBe('hello');
    // It actually used localStorage (the fallback backend).
    expect(window.localStorage.getItem('photonic_layout:fb')).toBe('hello');
  });
});
