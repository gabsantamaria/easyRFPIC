// Single-design (geometry-only) export / import transforms.
//
// Pins: the export payload carries the scene but NOT history/versions;
// import extracts a normalized scene from our format, a full design
// payload, and a bare scene, ignoring snapshots/history; and a full
// round-trip preserves the geometry.
import { describe, it, expect } from 'vitest';
import { buildDesignExport, parseDesignImport, designExportFilename, DESIGN_FILE_FORMAT } from '../src/scene/design-file.js';
import { makeBlankScene } from '../src/scene/schema.js';
import { resolveParams } from '../src/scene/params.js';
import { solveLayout } from '../src/scene/solver.js';

function sampleScene() {
  const s = makeBlankScene();
  s.params.gap = { expr: '12', unit: 'µm', desc: '' };
  s.components.push(
    { id: 'sig', kind: 'rect', layer: 'electrode', cx: 0, cy: 0, w: '100', h: '20', cutouts: [], transforms: [] },
    { id: 'gnd', kind: 'rect', layer: 'electrode', cx: 0, cy: 50, w: '100', h: '40', cutouts: [], transforms: [] },
  );
  s.snaps.push({ id: 'sn1', from: { compId: 'sig', anchor: 'N' }, to: { compId: 'gnd', anchor: 'S' }, dx: '0', dy: 'gap' });
  return s;
}

describe('buildDesignExport', () => {
  it('wraps the scene with format/version/name and NO history or versions', () => {
    const payload = buildDesignExport(sampleScene(), 'My CPW', '2026-06-14T00:00:00.000Z');
    expect(payload.format).toBe(DESIGN_FILE_FORMAT);
    expect(payload.version).toBe(1);
    expect(payload.name).toBe('My CPW');
    expect(payload.exportedAt).toBe('2026-06-14T00:00:00.000Z');
    expect(Array.isArray(payload.scene.components)).toBe(true);
    expect(payload.scene.components.length).toBe(2);
    // Geometry-only: no working-state or snapshot fields leak in.
    expect(payload).not.toHaveProperty('history');
    expect(payload).not.toHaveProperty('future');
    expect(payload).not.toHaveProperty('versions');
    expect(payload.scene).not.toHaveProperty('history');
    expect(payload.scene).not.toHaveProperty('versions');
  });

  it('defaults a blank/missing name to Untitled', () => {
    expect(buildDesignExport(makeBlankScene(), '', null).name).toBe('Untitled');
    expect(buildDesignExport(makeBlankScene(), '  ', null).name).toBe('Untitled');
  });
});

describe('parseDesignImport', () => {
  it('reads our export format and returns a normalized scene + name', () => {
    const payload = buildDesignExport(sampleScene(), 'My CPW', '2026-06-14T00:00:00.000Z');
    const r = parseDesignImport(payload, 'fallback');
    expect(r.error).toBeUndefined();
    expect(r.name).toBe('My CPW');
    expect(r.scene.components.map(c => c.id).sort()).toEqual(['gnd', 'sig']);
    expect(r.scene.snaps.length).toBe(1);
  });

  it('takes only .scene from a full design payload (ignores history/versions)', () => {
    const full = {
      name: 'Legacy',
      scene: sampleScene(),
      history: [{ junk: 1 }],
      future: [{ junk: 2 }],
      versions: [{ id: 'v1', scene: makeBlankScene() }],
      currentVersionId: 'v1',
    };
    const r = parseDesignImport(full, 'fallback');
    expect(r.error).toBeUndefined();
    expect(r.scene.components.length).toBe(2);
    // The returned scene is the geometry, not the wrapper — no versions on it.
    expect(r.scene).not.toHaveProperty('versions');
    expect(r.scene).not.toHaveProperty('history');
  });

  it('accepts a bare scene object', () => {
    const r = parseDesignImport(sampleScene(), 'fromfile');
    expect(r.error).toBeUndefined();
    // Bare scene has no name → falls back to the file name.
    expect(r.name).toBe('fromfile');
    expect(r.scene.components.length).toBe(2);
  });

  it('rejects non-objects and files with no scene', () => {
    expect(parseDesignImport(null).error).toBe('not-object');
    expect(parseDesignImport('a string').error).toBe('not-object');
    expect(parseDesignImport([1, 2, 3]).error).toBe('not-object');
    expect(parseDesignImport({ hello: 'world' }).error).toBe('no-scene');
    expect(parseDesignImport({ scene: { params: {} } }).error).toBe('no-scene'); // no components
  });

  it('round-trips: export → import yields a solvable, geometry-identical scene', () => {
    const original = sampleScene();
    const payload = JSON.parse(JSON.stringify(buildDesignExport(original, 'RT', '2026-06-14T00:00:00.000Z')));
    const r = parseDesignImport(payload, 'rt');
    expect(r.error).toBeUndefined();
    const { values } = resolveParams(r.scene.params);
    const solved = solveLayout(r.scene.components, r.scene.snaps, values);
    const gnd = solved.find(c => c.id === 'gnd');
    // gnd snapped above sig by gap: sig top (10) + gap (12) + gnd half-h (20) = 42.
    expect(gnd.cy).toBeCloseTo(10 + 12 + 20, 6);
    expect(r.scene.params.gap.expr).toBe('12');
  });
});

describe('designExportFilename', () => {
  it('sanitizes the name and appends the date', () => {
    expect(designExportFilename('My CPW v2', '2026-06-14')).toBe('My_CPW_v2_2026-06-14');
    expect(designExportFilename('', '2026-06-14')).toBe('design_2026-06-14');
    expect(designExportFilename('a/b\\c:d', '2026-06-14')).toBe('a_b_c_d_2026-06-14');
  });
});
