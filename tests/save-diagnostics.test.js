// saveDesign structured result + describeSaveFailure diagnostics.
//
// The old saveDesign returned a bare boolean and swallowed the real
// storage error (the user saw only "Save failed."). These pin the new
// structured result and the human-readable failure message — including
// the quota case, which is the leading cause of a single large design
// failing to save (localStorage is ~5 MB, shared across everything, and
// the payload carries scene + up to 50 undo/redo steps + full-scene
// snapshots per version).
import { describe, it, expect, afterEach } from 'vitest';
import { saveDesign, describeSaveFailure, designPrefix } from '../src/storage/workspace.js';

const origStorage = globalThis.window?.storage;

function installStorage(setImpl) {
  globalThis.window = globalThis.window || {};
  globalThis.window.storage = {
    async set(key, value) { return setImpl(key, value); },
    async get() { return null; },
    async list() { return { keys: [] }; },
    async delete() {},
  };
}

afterEach(() => {
  if (globalThis.window) globalThis.window.storage = origStorage;
});

const quotaError = () => {
  const e = new Error("Failed to execute 'setItem' on 'Storage': exceeded the quota.");
  e.name = 'QuotaExceededError';
  e.code = 22;
  return e;
};

describe('saveDesign result shape', () => {
  it('returns { ok: true, bytes } on success', async () => {
    let storedKey = null, storedVal = null;
    installStorage((k, v) => { storedKey = k; storedVal = v; });
    const res = await saveDesign('', 'my_design', { scene: { components: [] } });
    expect(res.ok).toBe(true);
    expect(res.bytes).toBeGreaterThan(0);
    expect(storedKey).toBe(designPrefix('') + 'my_design');
    expect(JSON.parse(storedVal).scene.components).toEqual([]);
  });

  it('flags a quota write failure with a size breakdown', async () => {
    installStorage(() => { throw quotaError(); });
    const payload = {
      scene: { components: [{ id: 'a' }] },
      history: [{ x: 1 }, { x: 2 }],
      future: [],
      versions: [{ id: 'v1', scene: { components: [] } }],
    };
    const res = await saveDesign('', 'big', payload);
    expect(res.ok).toBe(false);
    expect(res.phase).toBe('write');
    expect(res.isQuota).toBe(true);
    expect(res.name).toBe('QuotaExceededError');
    expect(res.bytes).toBeGreaterThan(0);
    expect(res.breakdown.historyCount).toBe(2);
    expect(res.breakdown.versionCount).toBe(1);
    expect(res.breakdown.sceneBytes).toBeGreaterThan(0);
  });

  it('reports a serialize failure (non-JSON payload) distinctly', async () => {
    installStorage(() => {}); // never reached
    const circular = {};
    circular.self = circular;
    const res = await saveDesign('', 'bad', { scene: circular });
    expect(res.ok).toBe(false);
    expect(res.phase).toBe('serialize');
  });

  it('non-quota write errors are reported but not flagged as quota', async () => {
    installStorage(() => { throw new Error('host storage offline'); });
    const res = await saveDesign('', 'x', { scene: {} });
    expect(res.ok).toBe(false);
    expect(res.isQuota).toBe(false);
    expect(res.message).toContain('host storage offline');
  });
});

describe('describeSaveFailure', () => {
  it('is empty for a successful result', () => {
    expect(describeSaveFailure({ ok: true })).toBe('');
    expect(describeSaveFailure(null)).toBe('');
  });

  it('quota message names the cause, the size breakdown, and the fixes', () => {
    const res = {
      ok: false, phase: 'write', name: 'QuotaExceededError',
      message: 'exceeded the quota', bytes: 6 * 1024 * 1024, isQuota: true,
      breakdown: { sceneBytes: 1024 * 1024, historyBytes: 3 * 1024 * 1024, historyCount: 50, versionsBytes: 2 * 1024 * 1024, versionCount: 7 },
    };
    const msg = describeSaveFailure(res);
    expect(msg).toContain('QuotaExceededError');
    expect(msg).toContain('6.00 MB');           // payload size
    expect(msg).toMatch(/undo history.*50 steps/);
    expect(msg).toMatch(/snapshots.*\(7\)/);
    expect(msg).toContain('Link this workspace to a file'); // remediation
    expect(msg).toContain('Delete snapshots');
  });

  it('serialize failures get a JSON-specific explanation', () => {
    const msg = describeSaveFailure({ ok: false, phase: 'serialize', name: 'TypeError', message: 'circular structure' });
    expect(msg).toContain('serialize');
    expect(msg).toContain('circular structure');
  });

  it('non-quota write failures report the raw error without quota fixes', () => {
    const msg = describeSaveFailure({ ok: false, phase: 'write', name: 'Error', message: 'host storage offline', bytes: 1024, breakdown: {}, isQuota: false });
    expect(msg).toContain('host storage offline');
    expect(msg).not.toContain('local-storage quota');
  });
});
