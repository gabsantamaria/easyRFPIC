// Guard-rail tests for the solver and geometry helpers:
//   - cyclic boolean operand structures must not hang (visited /
//     in-progress guards in refreshBooleanBbox and resolveBooleanBboxes)
//   - validateSnapGraph structural checks (duplicate-to, self-snap,
//     missing-from/to, cycle)
//   - INTERSECT boolean bbox = AABB intersection of operand bboxes,
//     falling back to the base bbox when operands are disjoint
//   - polylineBbox clamps negative widths
//   - getLastSolveDiagnostics convergence / NaN-snap-offset reporting
import { describe, it, expect } from 'vitest';
import {
  solveLayout,
  resolveBooleanBboxes,
  validateSnapGraph,
  getLastSolveDiagnostics,
} from '../src/scene/solver.js';
import { polylineBbox } from '../src/geometry/polyline.js';
import { makeDefaultScene } from '../src/scene/schema.js';
import { resolveParams } from '../src/scene/params.js';

const rect = (id, cx, cy, w, h, extra = {}) => ({
  id, kind: 'rect', layer: 'electrode',
  cx, cy, w: String(w), h: String(h),
  cutouts: [], transforms: [], label: id,
  ...extra,
});

const bool = (id, op, operandIds, extra = {}) => ({
  id, kind: 'boolean', op, operandIds,
  layer: 'electrode', cx: 0, cy: 0, w: '0', h: '0',
  cutouts: [], transforms: [], label: id,
  ...extra,
});

describe('cyclic boolean operand guards', () => {
  it('solveLayout terminates on mutually-cyclic union operands', () => {
    const comps = [
      rect('ra', 0, 0, 10, 10),
      rect('rb', 20, 0, 10, 10),
      bool('A', 'union', ['B', 'ra']),
      bool('B', 'union', ['A', 'rb']),
    ];
    const out = solveLayout(comps, [], {});
    // Rects untouched; booleans either got a finite bbox from the
    // non-cyclic operands or were skipped — never a hang / overflow.
    const ra = out.find(c => c.id === 'ra');
    expect(ra.cx).toBe(0);
    const A = out.find(c => c.id === 'A');
    const aw = typeof A.w === 'number' ? A.w : Number(A.w);
    expect(Number.isFinite(aw)).toBe(true);
  }, 5000);

  it('solveLayout terminates on cyclic subtract base operands', () => {
    // Exercises the refreshBooleanBbox → refreshBooleanBbox recursion
    // (subtract base that is itself a boolean) with a cycle.
    const comps = [
      rect('r1', 0, 0, 10, 10),
      rect('r2', 20, 0, 10, 10),
      bool('S1', 'subtract', ['S2', 'r1']),
      bool('S2', 'subtract', ['S1', 'r2']),
    ];
    const out = solveLayout(comps, [], {});
    expect(out.find(c => c.id === 'r2').cx).toBe(20);
  }, 5000);

  it('resolveBooleanBboxes terminates on cyclic operand structures', () => {
    const solved = [
      rect('ra', 0, 0, 10, 10),
      rect('rb', 20, 0, 10, 10),
      bool('A', 'union', ['B', 'ra']),
      bool('B', 'union', ['A', 'rb']),
    ];
    const out = resolveBooleanBboxes(solved, {});
    expect(out).toHaveLength(4);
  }, 5000);
});

describe('validateSnapGraph', () => {
  const comps = [rect('a', 0, 0, 10, 10), rect('b', 0, 0, 10, 10), rect('c', 0, 0, 10, 10)];
  const snap = (id, fromId, toId) => ({
    id, from: { compId: fromId, anchor: 'E' }, to: { compId: toId, anchor: 'W' }, dx: '0', dy: '0',
  });

  it('returns [] for a clean chain', () => {
    expect(validateSnapGraph(comps, [snap('s1', 'a', 'b'), snap('s2', 'b', 'c')])).toEqual([]);
  });

  it('flags duplicate-to on each extra snap sharing a target', () => {
    const out = validateSnapGraph(comps, [snap('s1', 'a', 'b'), snap('s2', 'c', 'b')]);
    const dups = out.filter(f => f.kind === 'duplicate-to');
    expect(dups).toHaveLength(1);
    expect(dups[0].snapId).toBe('s2');
    expect(dups[0].compId).toBe('b');
  });

  it('flags self-snap', () => {
    const out = validateSnapGraph(comps, [snap('s1', 'a', 'a')]);
    expect(out.some(f => f.kind === 'self-snap' && f.snapId === 's1' && f.compId === 'a')).toBe(true);
  });

  it('flags missing-from and missing-to', () => {
    const out = validateSnapGraph(comps, [snap('s1', 'ghost', 'b'), snap('s2', 'a', 'ghost2')]);
    expect(out.some(f => f.kind === 'missing-from' && f.compId === 'ghost')).toBe(true);
    expect(out.some(f => f.kind === 'missing-to' && f.compId === 'ghost2')).toBe(true);
  });

  it('flags a snap cycle', () => {
    const out = validateSnapGraph(comps, [snap('s1', 'a', 'b'), snap('s2', 'b', 'c'), snap('s3', 'c', 'a')]);
    const cycles = out.filter(f => f.kind === 'cycle');
    expect(cycles).toHaveLength(1);
    expect(cycles[0].message).toContain('cycle');
  });
});

describe('intersect boolean bbox = AABB intersection', () => {
  // a spans x[-5, 5] y[-5, 5]; b spans x[1, 11] y[-1, 9].
  // Intersection: x[1, 5] y[-1, 5] → cx=3, cy=2, w=4, h=6.
  it('solveLayout computes the intersection for overlapping rects', () => {
    const comps = [rect('a', 0, 0, 10, 10), rect('b', 6, 4, 10, 10), bool('i', 'intersect', ['a', 'b'])];
    const out = solveLayout(comps, [], {});
    const i = out.find(c => c.id === 'i');
    expect(i.cx).toBe(3);
    expect(i.cy).toBe(2);
    expect(i.w).toBe(4);
    expect(i.h).toBe(6);
  });

  it('solveLayout falls back to the base bbox for disjoint rects', () => {
    const comps = [rect('a', 0, 0, 10, 10), rect('b', 100, 0, 10, 10), bool('i', 'intersect', ['a', 'b'])];
    const out = solveLayout(comps, [], {});
    const i = out.find(c => c.id === 'i');
    expect(i.cx).toBe(0);
    expect(i.cy).toBe(0);
    expect(i.w).toBe(10);
    expect(i.h).toBe(10);
  });

  it('resolveBooleanBboxes computes the intersection for overlapping rects', () => {
    const solved = [rect('a', 0, 0, 10, 10), rect('b', 6, 4, 10, 10), bool('i', 'intersect', ['a', 'b'])];
    const out = resolveBooleanBboxes(solved, {});
    const i = out.find(c => c.id === 'i');
    expect(i.cx).toBe(3);
    expect(i.cy).toBe(2);
    expect(i.w).toBe(4);
    expect(i.h).toBe(6);
  });

  it('resolveBooleanBboxes falls back to the base bbox for disjoint rects', () => {
    const solved = [rect('a', 0, 0, 10, 10), rect('b', 100, 0, 10, 10), bool('i', 'intersect', ['a', 'b'])];
    const out = resolveBooleanBboxes(solved, {});
    const i = out.find(c => c.id === 'i');
    expect(i.cx).toBe(0);
    expect(i.w).toBe(10);
    expect(i.h).toBe(10);
  });

  it('subtract keeps base-bbox behavior', () => {
    const comps = [rect('a', 0, 0, 10, 10), rect('b', 5, 0, 4, 4), bool('d', 'subtract', ['a', 'b'])];
    const out = solveLayout(comps, [], {});
    const d = out.find(c => c.id === 'd');
    expect(d.cx).toBe(0);
    expect(d.w).toBe(10);
    expect(d.h).toBe(10);
  });
});

describe('polylineBbox width clamping', () => {
  const verts = [[0, 0], [10, 0]];

  it('clamps a negative width to 0 (no bbox shrink)', () => {
    const bb = polylineBbox({ cx: 0, cy: 0, width: '-4' }, verts, {});
    expect(bb.w).toBe(10);
    expect(bb.h).toBe(0);
  });

  it('still pads with a positive width', () => {
    const bb = polylineBbox({ cx: 0, cy: 0, width: '4' }, verts, {});
    expect(bb.w).toBe(14);
    expect(bb.h).toBe(4);
  });
});

describe('getLastSolveDiagnostics', () => {
  it('reports converged=true on the default scene', async () => {
    const scene = await makeDefaultScene();
    const { values } = resolveParams(scene.params);
    solveLayout(scene.components, scene.snaps, values);
    const d = getLastSolveDiagnostics();
    expect(d.converged).toBe(true);
    expect(d.iterations).toBeGreaterThanOrEqual(1);
    expect(d.iterations).toBeLessThan(100);
  });

  it('records a nan-snap-offset issue and zeroes the offset', () => {
    const comps = [rect('a', 0, 0, 10, 10), rect('b', 999, 999, 10, 10)];
    const snaps = [{ id: 's1', from: { compId: 'a', anchor: 'E' }, to: { compId: 'b', anchor: 'W' }, dx: 'Infinity', dy: '0' }];
    const out = solveLayout(comps, snaps, {});
    const b = out.find(c => c.id === 'b');
    // dx treated as 0: a.E = (5, 0), b.W local = (-5, 0) → b.cx = 10.
    expect(b.cx).toBe(10);
    expect(b.cy).toBe(0);
    const d = getLastSolveDiagnostics();
    expect(d.issues.some(i => i.kind === 'nan-snap-offset')).toBe(true);
  });
});
