// Regression: repeat / mirror / rotate transforms on polylines and
// polyshapes must MOVE the rendered geometry per instance.
//
// The bug: the canvas polyline/polyshape branches tessellated the path
// from the COMPONENT's base pose and ignored inst.cx/cy entirely — the
// render loop emitted one identical path per repeat instance, all
// stacked on the original, so the repeat button "did nothing" for these
// shapes. Exports (rings.js → GDS / boolean masks, HFSS DuplicateAlongLine)
// were already instance-correct; only the canvas drawing was frozen.
//
// Fix: rings.js exports remapPointsToInstance (the exact xform
// shapeInstanceToRing applies to solver-stashed _resolvedVerts) and the
// canvas remaps its base-pose tessellation through it per instance.
// These tests pin the helper's math to the ring builder's output so the
// two can never drift.
import { describe, it, expect } from 'vitest';
import { solveLayout } from '../src/scene/solver.js';
import { expandTransforms } from '../src/scene/transforms.js';
import { resolveParams } from '../src/scene/params.js';
import { tessellatePolylinePath } from '../src/geometry/polyline.js';
import { shapeInstanceToRing, remapPointsToInstance } from '../src/geometry/rings.js';

const triangle = (transforms) => ([{
  id: 'ps1', kind: 'polyshape', layer: 'electrode',
  cx: 10, cy: 5, w: '0', h: '0',
  vertices: [
    { kind: 'rel', dx: '0', dy: '0' },
    { kind: 'rel', dx: '20', dy: '0' },
    { kind: 'rel', dx: '-10', dy: '15' },
  ],
  closed: true, cutouts: [], transforms,
}]);

const solveAndExpand = (components) => {
  const { values } = resolveParams({});
  const solved = solveLayout(components, [], values);
  const insts = expandTransforms(solved, values);
  const comp = solved.find(c => c.id === 'ps1');
  return { values, solved, insts, comp };
};

describe('polyshape transform instances', () => {
  it('repeat clones land at shifted positions (not stacked on the base)', () => {
    const { values, solved, insts, comp } = solveAndExpand(triangle([
      { id: 't1', kind: 'repeat', enabled: true, n: 2, dx: 30, dy: -7, includeOriginal: true },
    ]));
    expect(insts.filter(i => i.compId === 'ps1')).toHaveLength(3);
    const byId = Object.fromEntries(solved.map(c => [c.id, c]));
    const base = tessellatePolylinePath(comp, byId, values);
    for (const inst of insts) {
      const remapped = remapPointsToInstance(base, inst, comp.cx, comp.cy);
      const k = inst.idx;
      // Every point shifted by exactly k*(dx, dy).
      for (let i = 0; i < base.length; i++) {
        expect(remapped[i][0]).toBeCloseTo(base[i][0] + 30 * k, 9);
        expect(remapped[i][1]).toBeCloseTo(base[i][1] - 7 * k, 9);
      }
      // Identity fast path: base instance returns the SAME array.
      if (k === 0) expect(remapped).toBe(base);
    }
  });

  it('remap matches shapeInstanceToRing for repeat + rotate chains', () => {
    const { values, solved, insts, comp } = solveAndExpand(triangle([
      { id: 't1', kind: 'repeat', enabled: true, n: 1, dx: 40, dy: 0, includeOriginal: true },
      { id: 't2', kind: 'rotate', enabled: true, angle: '30', pivot: 'C' },
    ]));
    const byId = Object.fromEntries(solved.map(c => [c.id, c]));
    const base = tessellatePolylinePath(comp, byId, values);
    for (const inst of insts.filter(i => i.compId === 'ps1')) {
      // Ring path: solver-stashed _resolvedVerts through the ring xform
      // (the geometry GDS and boolean masks consume).
      const ring = shapeInstanceToRing(inst);
      expect(ring.length).toBeGreaterThanOrEqual(3);
      // Canvas path: base tessellation through remapPointsToInstance.
      const remapped = remapPointsToInstance(base, inst, comp.cx, comp.cy);
      // Ring drops a duplicated closing vertex; compare the shared prefix.
      for (let i = 0; i < ring.length; i++) {
        expect(remapped[i][0]).toBeCloseTo(ring[i][0], 6);
        expect(remapped[i][1]).toBeCloseTo(ring[i][1], 6);
      }
    }
  });

  it('mirror transform reflects the remapped points (scaleX bake)', () => {
    const { values, solved, insts, comp } = solveAndExpand(triangle([
      { id: 't1', kind: 'duplicate_mirror', enabled: true, axis: 'x', offset: '25', includeOriginal: true },
    ]));
    const byId = Object.fromEntries(solved.map(c => [c.id, c]));
    const base = tessellatePolylinePath(comp, byId, values);
    const clones = insts.filter(i => i.compId === 'ps1');
    expect(clones).toHaveLength(2);
    const mirrored = clones.find(i => (i.scaleX ?? 1) === -1);
    expect(mirrored).toBeTruthy();
    const remapped = remapPointsToInstance(base, mirrored, comp.cx, comp.cy);
    const ring = shapeInstanceToRing(mirrored);
    for (let i = 0; i < ring.length; i++) {
      expect(remapped[i][0]).toBeCloseTo(ring[i][0], 6);
      expect(remapped[i][1]).toBeCloseTo(ring[i][1], 6);
    }
  });
});
