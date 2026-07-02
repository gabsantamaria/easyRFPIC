// Pure parts of the git-ready folder mirror (src/storage/dir-mirror.js).
// The FSA handle plumbing is browser-only; these lock the on-disk naming
// contract (append-only snapshot files keyed by version number + id) and
// the generated git helper.
import { describe, it, expect } from 'vitest';
import { safeDesignDirName, versionFileName, SYNC_SCRIPT } from '../src/storage/dir-mirror.js';

describe('safeDesignDirName', () => {
  it('keeps friendly names, sanitizes path-hostile characters', () => {
    expect(safeDesignDirName('menadered_TL_current')).toBe('menadered_TL_current');
    expect(safeDesignDirName('my design v2.1')).toBe('my design v2.1');
    expect(safeDesignDirName('a/b\\c:d*e?')).toBe('a_b_c_d_e_');
    expect(safeDesignDirName('')).toBe('design');
    expect(safeDesignDirName(null)).toBe('design');
  });
});

describe('versionFileName', () => {
  it('is stable and collision-resistant: zero-padded number + sanitized id', () => {
    expect(versionFileName({ versionNumber: 7, id: 'ab12cd34' })).toBe('v007_ab12cd34.json');
    expect(versionFileName({ versionNumber: 123, id: 'ab12cd34' })).toBe('v123_ab12cd34.json');
    // Same version object always maps to the same file — the append-only
    // contract (mirror writes each snapshot at most once) depends on this.
    const v = { versionNumber: 2, id: 'ffff0000' };
    expect(versionFileName(v)).toBe(versionFileName(v));
    // Hostile ids can't escape the directory.
    expect(versionFileName({ versionNumber: 1, id: '../../x' })).toBe('v001_x.json');
    expect(versionFileName({ versionNumber: 0, id: null })).toBe('v000_unknown.json');
  });
});

describe('SYNC_SCRIPT', () => {
  it('commits with the mirrored snapshot message and pushes', () => {
    expect(SYNC_SCRIPT).toContain('git add -A');
    expect(SYNC_SCRIPT).toContain('git commit -F .photonic/commit_msg');
    expect(SYNC_SCRIPT).toContain('git push');
    // cd's to its own directory so it can run from anywhere.
    expect(SYNC_SCRIPT).toContain('cd "$(dirname "$0")"');
  });
});
