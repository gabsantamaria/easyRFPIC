// Storage-integrity regressions (data-loss audit fixes):
//  1. validateDesignName / sanitizeDesignName — names that save fine but
//     vanish from every list (leading '_', containing ':') are rejected /
//     sanitized at the entry points.
//  2. importDesign checks saveDesign's STRUCTURED result — a failed write
//     used to be reported as success ({ok:false} is truthy).
//  3. importWorkspace 'replace' writes FIRST and prunes ONLY after every
//     write succeeded — the old delete-first order destroyed the workspace
//     when a write failed mid-import, while still reporting success.
//  4. Workspace bundles round-trip the STACK library (was silently omitted).
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';

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

async function freshModules() {
  globalThis.indexedDB = new IDBFactory();
  const ls = makeLocalStorage({});
  globalThis.localStorage = ls;
  globalThis.window = { localStorage: ls };
  vi.resetModules();
  const shim = await import('../src/storage/window-storage-shim.js');
  shim.installStorageShim();
  const workspace = await import('../src/storage/workspace.js');
  const libraryItems = await import('../src/storage/library-items.js');
  const stacks = await import('../src/storage/stacks.js');
  return { workspace, libraryItems, stacks };
}

beforeEach(() => {
  delete globalThis.window;
  delete globalThis.indexedDB;
  delete globalThis.localStorage;
});

describe('validateDesignName / sanitizeDesignName', () => {
  it('rejects reserved and separator-bearing names, accepts normal ones', async () => {
    const { workspace } = await freshModules();
    const { validateDesignName, sanitizeDesignName } = workspace;
    expect(validateDesignName('my design').ok).toBe(true);
    expect(validateDesignName('  padded  ')).toEqual({ ok: true, name: 'padded' });
    expect(validateDesignName('').ok).toBe(false);
    expect(validateDesignName('   ').ok).toBe(false);
    // Leading '_' is reserved (listSavedDesigns filters `prefix + '_'`;
    // '_active' would even overwrite the active-design pointer key).
    expect(validateDesignName('_active').ok).toBe(false);
    expect(validateDesignName('_foo').ok).toBe(false);
    // ':' is the workspace prefix separator — the design saves but vanishes
    // from the default workspace's list.
    expect(validateDesignName('a:b').ok).toBe(false);
    // Sanitizer maps invalid → valid instead of rejecting (import path).
    expect(sanitizeDesignName('_foo')).toBe('foo');
    expect(sanitizeDesignName('a:b')).toBe('a-b');
    expect(sanitizeDesignName('___')).toBe('Imported design');
    expect(sanitizeDesignName('fine name')).toBe('fine name');
  });
});

describe('importDesign — structured save result', () => {
  const bundle = (name, scene) => ({
    format: 'easyrfpic_design', version: 1, exportedAt: 'now', name,
    payload: { scene, versions: [], currentVersionId: null },
  });

  it('imports and lists a design (happy path), sanitizing an invisible name', async () => {
    const { workspace, libraryItems } = await freshModules();
    const r = await libraryItems.importDesign('', bundle('_hidden:name', { components: [] }));
    // Sanitized: no leading underscore, ':' replaced — so it LISTS.
    expect(r.name).toBe('hidden-name');
    expect(await workspace.listSavedDesigns('')).toContain('hidden-name');
  });

  it('THROWS when the underlying write fails (was: silent success)', async () => {
    const { libraryItems } = await freshModules();
    // Make every storage write fail — saveDesign catches and returns
    // { ok:false }, which is TRUTHY; the old `if (!await saveDesign(...))`
    // therefore never threw and the import reported success with nothing saved.
    const origSet = window.storage.set;
    window.storage.set = async () => { throw new Error('quota'); };
    try {
      await expect(libraryItems.importDesign('', bundle('X', { components: [] })))
        .rejects.toThrow(/save failed/i);
    } finally {
      window.storage.set = origSet;
    }
  });
});

describe('importWorkspace — replace mode writes first, prunes after', () => {
  const wsBundle = (designs, stacks = {}) => ({
    format: 'photonic_layout_workspace', version: 1, exportedAt: 'now', workspace: '',
    designs, library: {}, libraryArchive: {}, cells: {}, stacks,
  });
  const payload = (tag) => ({ scene: { components: [{ id: tag }] }, versions: [], currentVersionId: null });

  it('replace: imports the bundle and prunes leftovers not in it', async () => {
    const { workspace, libraryItems } = await freshModules();
    await workspace.saveDesign('', 'Old1', payload('old1'));
    await workspace.saveDesign('', 'Old2', payload('old2'));
    const counts = await libraryItems.importWorkspace('', wsBundle({ New1: payload('new1'), Old2: payload('new-old2') }), 'replace');
    expect(counts.designs).toBe(2);
    expect(counts.failed).toEqual([]);
    const list = await workspace.listSavedDesigns('');
    expect(list.sort()).toEqual(['New1', 'Old2']); // Old1 pruned, Old2 replaced in place
    expect((await workspace.loadDesign('', 'Old2')).scene.components[0].id).toBe('new-old2');
  });

  it('replace with a FAILING write never deletes existing data (was: wipe-then-fail)', async () => {
    const { workspace, libraryItems } = await freshModules();
    await workspace.saveDesign('', 'Precious', payload('precious'));
    // Fail exactly the incoming design's write; everything else succeeds.
    const origSet = window.storage.set;
    window.storage.set = async (key, value) => {
      if (key.endsWith(':Incoming') || key === 'photonic_layout:Incoming') throw new Error('quota');
      return origSet.call(window.storage, key, value);
    };
    try {
      const counts = await libraryItems.importWorkspace('', wsBundle({ Incoming: payload('incoming') }), 'replace');
      expect(counts.designs).toBe(0);
      expect(counts.failed).toContain('design:Incoming');
      // CRITICAL: the pre-existing design SURVIVES — the old implementation
      // deleted it before attempting the failed write.
      expect(await workspace.listSavedDesigns('')).toContain('Precious');
      expect((await workspace.loadDesign('', 'Precious')).scene.components[0].id).toBe('precious');
    } finally {
      window.storage.set = origSet;
    }
  });

  it('merge mode still skips existing names', async () => {
    const { workspace, libraryItems } = await freshModules();
    await workspace.saveDesign('', 'Keep', payload('keep-orig'));
    const counts = await libraryItems.importWorkspace('', wsBundle({ Keep: payload('keep-new'), Fresh: payload('fresh') }), 'merge');
    expect(counts.designs).toBe(1);
    expect(counts.skipped).toContain('design:Keep');
    expect((await workspace.loadDesign('', 'Keep')).scene.components[0].id).toBe('keep-orig');
    expect(await workspace.listSavedDesigns('')).toContain('Fresh');
  });
});

describe('workspace bundle round-trips the stack library', () => {
  it('exportWorkspace includes stacks; importWorkspace restores them', async () => {
    const { libraryItems, stacks } = await freshModules();
    await stacks.saveStack('', 'LTOI600', { stack: [{ id: 'l_si', thickness: 'h_si' }] });
    const bundle = await libraryItems.exportWorkspace('');
    expect(Object.keys(bundle.stacks)).toContain('LTOI600');
    // Restore into a different (named) workspace.
    const counts = await libraryItems.importWorkspace('other', bundle, 'overwrite');
    expect(counts.stacks).toBe(1);
    expect(await stacks.loadStack('other', 'LTOI600')).toEqual({ stack: [{ id: 'l_si', thickness: 'h_si' }] });
  });
});
