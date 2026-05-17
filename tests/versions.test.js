import { describe, it, expect } from 'vitest';
import {
  generateVersionId,
  ensureUniqueVersionId,
  nextVersionNumber,
  makeVersion,
  sortedVersions,
  findVersionById,
} from '../src/storage/versions.js';

describe('storage/versions', () => {
  it('generateVersionId returns an 8-char lowercase hex string', () => {
    const id = generateVersionId();
    expect(id).toMatch(/^[0-9a-f]{8}$/);
  });

  it('ensureUniqueVersionId avoids colliding with existing ids', () => {
    const existing = [{ id: 'aaaaaaaa' }, { id: 'bbbbbbbb' }];
    for (let i = 0; i < 20; i++) {
      const id = ensureUniqueVersionId(existing);
      expect(['aaaaaaaa', 'bbbbbbbb']).not.toContain(id);
      expect(id).toMatch(/^[0-9a-f]{8}$/);
    }
  });

  it('nextVersionNumber starts at 1 for empty arrays', () => {
    expect(nextVersionNumber([])).toBe(1);
    expect(nextVersionNumber(undefined)).toBe(1);
    expect(nextVersionNumber(null)).toBe(1);
  });

  it('nextVersionNumber returns max+1 across an existing chain', () => {
    expect(nextVersionNumber([{ versionNumber: 1 }, { versionNumber: 3 }, { versionNumber: 2 }])).toBe(4);
  });

  it('makeVersion captures a deep clone of the scene', () => {
    const scene = { params: { a: { expr: '1' } }, components: [{ id: 'r1', cx: 10 }] };
    const v = makeVersion(scene, 'first', []);
    expect(v.versionNumber).toBe(1);
    expect(v.id).toMatch(/^[0-9a-f]{8}$/);
    expect(v.description).toBe('first');
    expect(v.savedAt).toBeGreaterThan(0);
    // Snapshot is decoupled from later mutations.
    v.scene.components[0].cx = 999;
    expect(scene.components[0].cx).toBe(10);
  });

  it('makeVersion truncates very long descriptions to a sane cap', () => {
    const longDesc = 'x'.repeat(500);
    const v = makeVersion({}, longDesc, []);
    expect(v.description.length).toBeLessThanOrEqual(240);
  });

  it('sortedVersions orders most-recent first by savedAt', () => {
    const vs = [
      { id: 'a', versionNumber: 1, savedAt: 100 },
      { id: 'b', versionNumber: 2, savedAt: 300 },
      { id: 'c', versionNumber: 3, savedAt: 200 },
    ];
    const sorted = sortedVersions(vs);
    expect(sorted.map(v => v.id)).toEqual(['b', 'c', 'a']);
  });

  it('sortedVersions tolerates bad input', () => {
    expect(sortedVersions(undefined)).toEqual([]);
    expect(sortedVersions(null)).toEqual([]);
    expect(sortedVersions([null, { id: 'x', savedAt: 1 }, 'nope'])).toEqual([{ id: 'x', savedAt: 1 }]);
  });

  it('findVersionById returns the right entry or null', () => {
    const vs = [{ id: 'aa', savedAt: 1 }, { id: 'bb', savedAt: 2 }];
    expect(findVersionById(vs, 'bb')).toEqual({ id: 'bb', savedAt: 2 });
    expect(findVersionById(vs, 'cc')).toBeNull();
    expect(findVersionById(null, 'bb')).toBeNull();
  });

  it('legacy-style payload (no versions field) returns empty sortedVersions', () => {
    const legacyPayload = { scene: {}, history: [], future: [], updatedAt: 1 };
    expect(sortedVersions(legacyPayload.versions)).toEqual([]);
  });
});
