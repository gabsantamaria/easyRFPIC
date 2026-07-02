// Regression: importing a design over an EXISTING design name must NOT wipe
// that design's snapshot chain.
//
// The bug: handleImportDesignFile loaded the imported scene into the working
// state and reset versions=[] / currentVersionId=null, then left the design
// `unsaved`. The autosave effect fires precisely when
// (saveStatus==='unsaved' AND savedList.includes(designName)) — exactly the
// name-collision case — and persisted that empty versions array over the
// stored design, silently destroying every snapshot.
//
// The fix carries the EXISTING design's versions into the working state on a
// name collision, so the post-import save preserves the snapshot chain (the
// imported geometry just becomes the new "current" on top of it). This test
// exercises the REAL storage layer to (a) document the data loss and (b) lock
// in the preservation invariant the fix depends on.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { saveDesign, loadDesign } from '../src/storage/workspace.js';

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

async function freshShim() {
  globalThis.indexedDB = new IDBFactory();
  const ls = makeLocalStorage({});
  globalThis.localStorage = ls;
  globalThis.window = { localStorage: ls };
  vi.resetModules();
  const mod = await import('../src/storage/window-storage-shim.js');
  mod.installStorageShim();
}

beforeEach(() => {
  delete globalThis.window;
  delete globalThis.indexedDB;
  delete globalThis.localStorage;
});

describe('import over an existing design name preserves its snapshots', () => {
  const v1 = { id: 'v1', versionNumber: 1, scene: { components: [{ id: 'a' }] }, savedAt: 1 };
  const v2 = { id: 'v2', versionNumber: 2, scene: { components: [{ id: 'b' }] }, savedAt: 2 };
  const storedScene = { components: [{ id: 'b' }] };
  const importedScene = { components: [{ id: 'imported' }] };

  it('a versions=[] save can no longer wipe the snapshot chain (saveDesign read-merge)', async () => {
    await freshShim();
    await saveDesign('', 'Foo', { scene: storedScene, versions: [v1, v2], currentVersionId: 'v2' });
    // What the buggy import + autosave did: persist the imported scene with an
    // empty versions array under the same name. This USED to erase v1/v2
    // (this test originally asserted length 0 to document the loss). The
    // versions[] read-merge inside saveDesign now unions the stored snapshots
    // back in, so the erasure is structurally impossible — from ANY caller,
    // including a stale second tab.
    await saveDesign('', 'Foo', { scene: importedScene, versions: [], currentVersionId: null });
    const after = await loadDesign('', 'Foo');
    expect(after.versions.map((v) => v.id).sort()).toEqual(['v1', 'v2']); // snapshots survive
    expect(after.scene.components[0].id).toBe('imported');                // payload's scene still wins
  });

  it('carrying the existing versions through the post-import save keeps every snapshot', async () => {
    await freshShim();
    await saveDesign('', 'Foo', { scene: storedScene, versions: [v1, v2], currentVersionId: 'v2' });

    // The fix: before resetting the working-state version chain, load the
    // existing design and carry its versions/pointer forward.
    const existing = await loadDesign('', 'Foo');
    expect(existing.versions.map((v) => v.id)).toEqual(['v1', 'v2']);

    // Post-import autosave now persists the imported scene WITH the preserved chain.
    await saveDesign('', 'Foo', {
      scene: importedScene,
      versions: existing.versions,
      currentVersionId: existing.currentVersionId,
    });

    const after = await loadDesign('', 'Foo');
    expect(after.versions.map((v) => v.id)).toEqual(['v1', 'v2']); // snapshots preserved
    expect(after.currentVersionId).toBe('v2');                     // pointer preserved
    expect(after.scene.components[0].id).toBe('imported');         // geometry updated
    // The snapshot scenes themselves are intact (recoverable).
    expect(after.versions[0].scene.components[0].id).toBe('a');
    expect(after.versions[1].scene.components[0].id).toBe('b');
  });

  it('a brand-new (non-colliding) import starts a fresh empty chain', async () => {
    await freshShim();
    // No stored "Bar" → loadDesign returns null → fix falls back to [].
    const existing = await loadDesign('', 'Bar');
    expect(existing).toBeNull();
    const versions = (existing && Array.isArray(existing.versions) && existing.versions.length) ? existing.versions : [];
    expect(versions).toEqual([]);
  });
});
