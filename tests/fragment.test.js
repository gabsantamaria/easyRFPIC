// Shape-fragment build/insert (src/scene/fragment.js) — the pure core
// behind Copy/Paste, "Download selection", and "Upload shapes here…".
//
// Regression for the cross-design upload bug pair:
//   (1) params merged dest-wins silently reshaped the import (feezZ0_W
//       10 vs 40 squeezed the CPW feed) → fragmentParamConflicts surfaces
//       only DIFFERING collisions; insert honors keep-current/use-imported.
//   (2) snap-kind polyline/polyshape VERTICES weren't remapped through
//       the fresh-id map — cross-design pins dangled and the shape
//       collapsed to a point (the "missing piece").
import { describe, it, expect } from 'vitest';
import { buildFragmentFromScene, insertFragmentIntoScene, fragmentParamConflicts } from '../src/scene/fragment.js';
import { normalizeScene } from '../src/scene/schema.js';
import { resolveParams } from '../src/scene/params.js';
import { solveLayout, applyMirrors } from '../src/scene/solver.js';
import { resolvePolylineVertices } from '../src/geometry/polyline.js';

// Source design: a rect pair + a polyshape pinned to their corners, all
// sized by params. Mirrors the user's CPW/pshape12 topology.
const srcScene = () => normalizeScene({
  params: {
    fw: { expr: '40', unit: 'µm', desc: 'feed width' },
    fg: { expr: '4', unit: 'µm', desc: 'gap' },
    shared_eq: { expr: '7', unit: 'µm', desc: 'same value both designs' },
  },
  components: [
    { id: 'a', kind: 'rect', layer: 'electrode', cx: 0, cy: 0, w: 'fw', h: '20', cutouts: [], transforms: [] },
    { id: 'b', kind: 'rect', layer: 'electrode', cx: 60, cy: 0, w: 'fw', h: '20', cutouts: [], transforms: [] },
    { id: 'ps', kind: 'polyshape', layer: 'electrode', cx: 0, cy: -30, w: '0', h: '0',
      vertices: [
        { kind: 'snap', compId: 'a', anchor: 'SE' },
        { kind: 'snap', compId: 'b', anchor: 'SW' },
        { kind: 'rel', dx: '0', dy: '-15' },
      ],
      closed: true, cutouts: [], transforms: [] },
    { id: 'outside', kind: 'rect', layer: 'electrode', cx: -100, cy: 0, w: '10', h: '10', cutouts: [], transforms: [] },
    { id: 'ps_ext', kind: 'polyshape', layer: 'electrode', cx: -80, cy: -30, w: '0', h: '0',
      vertices: [
        { kind: 'snap', compId: 'outside', anchor: 'SE' }, // EXTERNAL pin
        { kind: 'rel', dx: '20', dy: '0' },
        { kind: 'rel', dx: '0', dy: '-10' },
      ],
      closed: true, cutouts: [], transforms: [] },
  ],
  snaps: [
    { id: 's1', from: { compId: 'a', anchor: 'E' }, to: { compId: 'b', anchor: 'W' }, dx: 'fg', dy: '0' },
    { id: 's_ext', from: { compId: 'outside', anchor: 'E' }, to: { compId: 'a', anchor: 'W' }, dx: '5', dy: '0' },
  ],
  mirrors: [], groups: [], booleans: [],
});

// Destination design: SAME param names, DIFFERENT values for fw/fg.
const destScene = () => normalizeScene({
  params: {
    fw: { expr: '10', unit: 'µm', desc: 'feed width (dest)' },
    fg: { expr: '20', unit: 'µm', desc: 'gap (dest)' },
    shared_eq: { expr: '7', unit: 'µm', desc: 'same value both designs' },
    dest_only: { expr: '3', unit: 'µm', desc: '' },
  },
  components: [
    { id: 'd1', kind: 'rect', layer: 'electrode', cx: 500, cy: 0, w: 'fw', h: 'fw', cutouts: [], transforms: [] },
    // Same id as a fragment component — forces the _copy rename:
    { id: 'a', kind: 'rect', layer: 'electrode', cx: 600, cy: 0, w: '5', h: '5', cutouts: [], transforms: [] },
  ],
  snaps: [], mirrors: [], groups: [], booleans: [],
});

describe('buildFragmentFromScene', () => {
  it('keeps INTERNAL vertex pins symbolic, freezes EXTERNAL pins to geometry-preserving rel steps', () => {
    const src = srcScene();
    const pv = resolveParams(src.params).values;
    const ids = new Set(['a', 'b', 'ps', 'ps_ext']); // 'outside' NOT selected
    const frag = buildFragmentFromScene(src, ids, pv);
    const ps = frag.components.find(c => c.id === 'ps');
    expect(ps.vertices.every(v => v.kind === 'snap' || v.kind === 'rel')).toBe(true);
    expect(ps.vertices[0].kind).toBe('snap'); // internal → symbolic
    expect(ps.vertices[1].kind).toBe('snap');
    const pe = frag.components.find(c => c.id === 'ps_ext');
    expect(pe.vertices[0].kind).toBe('rel');  // external → frozen
    // Frozen step reproduces the solved position: v0 = outside.SE = (−95, −5);
    // ps_ext cx/cy = (−80, −30) → dx = −15, dy = 25.
    expect(parseFloat(pe.vertices[0].dx)).toBeCloseTo(-15, 3);
    expect(parseFloat(pe.vertices[0].dy)).toBeCloseTo(25, 3);
  });

  it('drops external snaps, keeps internal ones, captures the param closure', () => {
    const src = srcScene();
    const pv = resolveParams(src.params).values;
    const frag = buildFragmentFromScene(src, new Set(['a', 'b', 'ps']), pv);
    expect(frag.snaps.map(s => s.id)).toEqual(['s1']); // s_ext dropped
    expect(Object.keys(frag.params).sort()).toEqual(['fg', 'fw']); // closure
  });
});

describe('fragmentParamConflicts', () => {
  it('lists ONLY collisions whose values differ', () => {
    const src = srcScene();
    const dest = destScene();
    const pv = resolveParams(src.params).values;
    const frag = buildFragmentFromScene(src, new Set(['a', 'b', 'ps']), pv);
    const conflicts = fragmentParamConflicts(dest.params, frag.params);
    expect(conflicts.map(c => c.name).sort()).toEqual(['fg', 'fw']);
    expect(conflicts.find(c => c.name === 'fw')).toEqual({ name: 'fw', current: '10', imported: '40' });
    // shared_eq (equal) and dest_only (no collision) are NOT flagged.
  });
});

describe('insertFragmentIntoScene', () => {
  const mkInsert = (useImported) => {
    const src = srcScene();
    const dest = destScene();
    const pv = resolveParams(src.params).values;
    const frag = buildFragmentFromScene(src, new Set(['a', 'b', 'ps']), pv);
    const ins = insertFragmentIntoScene(dest, frag, { at: { x: 0, y: 200 }, gridSize: 2, useImported });
    const scene2 = {
      ...dest,
      params: ins.params,
      components: [...dest.components, ...ins.components],
      snaps: [...dest.snaps, ...ins.snaps],
    };
    return { src, dest, frag, ins, scene2 };
  };

  it('remaps snap-kind vertices to the fresh ids (no dangling pins, no collapse)', () => {
    const { ins, scene2 } = mkInsert(true);
    const ps = ins.components.find(c => c.id.startsWith('ps'));
    expect(ps.vertices[0].kind).toBe('snap');
    expect(ins.newIds).toContain(ps.vertices[0].compId); // remapped
    expect(ins.newIds).toContain(ps.vertices[1].compId);
    // Solved: the polyshape spans the two rects — non-degenerate.
    const pv2 = resolveParams(scene2.params).values;
    const solved = applyMirrors(solveLayout(scene2.components, scene2.snaps, pv2), scene2.mirrors);
    const byId = Object.fromEntries(solved.map(c => [c.id, c]));
    const verts = resolvePolylineVertices(byId[ps.id], byId, pv2);
    // The pins sit on the two FACING edges: v0 on a_copy.SE, v1 on
    // b_copy.SW — their x-distance equals the parametric gap (fg = 4 with
    // imported values), pinning the shape to the moving pair. A dangling
    // pin would have collapsed both onto cx/cy (distance 0).
    const a2 = byId.a_copy, b2 = byId.b_copy;
    expect(verts[0][0]).toBeCloseTo(a2.cx + pv2.fw / 2, 6);
    expect(verts[1][0]).toBeCloseTo(b2.cx - pv2.fw / 2, 6);
    expect(verts[1][0] - verts[0][0]).toBeCloseTo(4, 6); // fg (imported)
    expect(verts.every(v => Number.isFinite(v[0]) && Number.isFinite(v[1]))).toBe(true);
  });

  it('useImported=true rewrites ONLY the conflicting dest params (import matches the source design)', () => {
    const { src, ins, scene2 } = mkInsert(true);
    expect(String(ins.params.fw.expr)).toBe('40');
    expect(String(ins.params.fg.expr)).toBe('4');
    expect(String(ins.params.dest_only.expr)).toBe('3');   // untouched
    expect(String(ins.params.shared_eq.expr)).toBe('7');   // untouched
    // The imported pair's gap solves to the SOURCE geometry (fg = 4):
    const pv2 = resolveParams(scene2.params).values;
    const solved = applyMirrors(solveLayout(scene2.components, scene2.snaps, pv2), scene2.mirrors);
    const a2 = solved.find(c => c.id === 'a_copy');
    const b2 = solved.find(c => c.id.startsWith('b_copy') || c.id === 'b_copy');
    const gap = (b2.cx - pv2.fw / 2) - (a2.cx + pv2.fw / 2);
    expect(gap).toBeCloseTo(4, 6);
    // Source truth:
    const pvS = resolveParams(src.params).values;
    expect(pvS.fg).toBe(4);
  });

  it('useImported=false keeps the dest values (import takes the destination sizing)', () => {
    const { ins, scene2 } = mkInsert(false);
    expect(String(ins.params.fw.expr)).toBe('10');
    expect(String(ins.params.fg.expr)).toBe('20');
    const pv2 = resolveParams(scene2.params).values;
    const solved = applyMirrors(solveLayout(scene2.components, scene2.snaps, pv2), scene2.mirrors);
    const a2 = solved.find(c => c.id === 'a_copy');
    const b2 = solved.find(c => c.id.startsWith('b_copy'));
    const gap = (b2.cx - pv2.fw / 2) - (a2.cx + pv2.fw / 2);
    expect(gap).toBeCloseTo(20, 6);
  });

  it('colliding component id gets a fresh _copy name; same-design paste external pins keep tracking', () => {
    const dest = destScene();
    // Paste WITHIN the same design: a fragment whose polyshape pins to a
    // component that stays in the DEST scene (not part of the fragment).
    const frag = {
      components: [
        { id: 'psx', kind: 'polyshape', layer: 'electrode', cx: 0, cy: 0, w: '0', h: '0',
          vertices: [
            { kind: 'snap', compId: 'd1', anchor: 'NE' }, // dest component
            { kind: 'rel', dx: '5', dy: '0' },
            { kind: 'rel', dx: '0', dy: '-5' },
          ],
          closed: true, cutouts: [], transforms: [] },
      ],
      snaps: [], params: {},
    };
    const ins = insertFragmentIntoScene(dest, frag, { gridSize: 2 });
    const psx = ins.components[0];
    expect(psx.vertices[0].kind).toBe('snap');
    expect(psx.vertices[0].compId).toBe('d1'); // dest target preserved
    // A pin that exists NOWHERE degrades to a zero rel step (defensive):
    const frag2 = {
      components: [
        { id: 'psy', kind: 'polyshape', layer: 'electrode', cx: 0, cy: 0, w: '0', h: '0',
          vertices: [ { kind: 'snap', compId: 'ghost', anchor: 'C' }, { kind: 'rel', dx: '5', dy: '0' }, { kind: 'rel', dx: '0', dy: '5' } ],
          closed: true, cutouts: [], transforms: [] },
      ],
      snaps: [], params: {},
    };
    const ins2 = insertFragmentIntoScene(dest, frag2, { gridSize: 2 });
    expect(ins2.components[0].vertices[0]).toEqual({ kind: 'rel', dx: '0', dy: '0' });
  });

  it('strips the group tag and drops snaps with any endpoint outside the fragment', () => {
    const src = srcScene();
    const dest = destScene();
    const pv = resolveParams(src.params).values;
    const frag = buildFragmentFromScene(src, new Set(['a', 'b', 'ps']), pv);
    frag.components[0].group = 'someGroup';
    frag.snaps.push({ id: 'sx', from: { compId: 'a', anchor: 'E' }, to: { compId: 'zzz', anchor: 'W' }, dx: '0', dy: '0' });
    const ins = insertFragmentIntoScene(dest, frag, { gridSize: 2 });
    expect(ins.components[0].group).toBeUndefined();
    expect(ins.snaps.some(s => s.to.compId === 'zzz' || !s.to.compId)).toBe(false);
  });
});
