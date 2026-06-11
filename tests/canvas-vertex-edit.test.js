// C3 / C5 — pure-math helpers behind on-canvas vertex editing and the
// smart alignment guides. These live at module scope in Canvas.jsx
// (exported) so the geometry-rewrite rules can be verified without a DOM:
//   - dragVertexPatch:            handle-drag dx/dy rewrite + follower fixup
//   - insertVertexInSegment:      segment split (incl. closing edge)
//   - deleteVertexFixDownstream:  delete + downstream-position preservation
//   - nearestPolySegment:         segment hit-testing for dbl-click insert
//   - alignAxis:                  alignment-candidate search (C5)
import { describe, it, expect } from 'vitest';
import {
  fmtVertexLit, isRelNumericVertex, vertexDragBlock,
  dragVertexPatch, nearestPolySegment, insertVertexInSegment,
  deleteVertexFixDownstream, alignAxis,
} from '../src/ui/canvas/Canvas.jsx';
import { resolvePolylineVertices } from '../src/geometry/polyline.js';

const rel = (dx, dy, extra = {}) => ({ kind: 'rel', dx: String(dx), dy: String(dy), ...extra });

// A 3-vertex L-shaped polyline at origin: v0=(0,0), v1=(10,0), v2=(10,8).
const mkComp = (overrides = {}) => ({
  id: 'pl1', kind: 'polyline', cx: 0, cy: 0, width: '2',
  vertices: [rel(0, 0), rel(10, 0), rel(0, 8)],
  ...overrides,
});
const resolve = (c) => resolvePolylineVertices(c, {}, {});

describe('fmtVertexLit / isRelNumericVertex / vertexDragBlock', () => {
  it('formats literals cleanly (4 decimals, no negative zero)', () => {
    expect(fmtVertexLit(1.23456789)).toBe('1.2346');
    expect(fmtVertexLit(-0.00001)).toBe('0');
    expect(fmtVertexLit(5)).toBe('5');
    expect(fmtVertexLit(NaN)).toBe('0');
  });

  it('classifies vertex specs', () => {
    expect(isRelNumericVertex(rel(3, -4.5))).toBe(true);
    expect(isRelNumericVertex(rel('2*(3+1)', '0'))).toBe(true); // pure-numeric arithmetic counts
    expect(isRelNumericVertex(rel(1, 2, { spline: true }))).toBe(true); // spline flag doesn't block
    expect(isRelNumericVertex(rel('gap_x', '0'))).toBe(false);
    expect(isRelNumericVertex({ kind: 'snap', compId: 'a', anchor: 'C' })).toBe(false);
    expect(isRelNumericVertex({ kind: 'arc', cdx: '0', cdy: '5', angle: '90' })).toBe(false);
    // missing kind defaults to rel
    expect(isRelNumericVertex({ dx: '1', dy: '2' })).toBe(true);
  });

  it('explains why a vertex is not draggable', () => {
    expect(vertexDragBlock(rel(1, 2))).toBeNull();
    expect(vertexDragBlock({ kind: 'snap', compId: 'wg1', anchor: 'E' })).toMatch(/snap-bound to wg1\.E/);
    expect(vertexDragBlock({ kind: 'arc', cdx: '0', cdy: '5', angle: '90' })).toMatch(/arc/);
    expect(vertexDragBlock(rel('trace_w/2', '0'))).toMatch(/driven by 'trace_w\/2'/);
  });
});

describe('dragVertexPatch (C3 handle drag)', () => {
  it('moves only the dragged vertex: follower gets the inverse adjustment', () => {
    const c = mkComp();
    const verts = resolve(c); // [[0,0],[10,0],[10,8]]
    const out = dragVertexPatch(c, verts, 1, { x: 12, y: 3 });
    expect(out[1]).toMatchObject({ dx: '12', dy: '3' });
    // v2's resolved position must stay (10, 8): dx = 10-12, dy = 8-3.
    expect(out[2]).toMatchObject({ dx: '-2', dy: '5' });
    const moved = resolvePolylineVertices({ ...c, vertices: out }, {}, {});
    expect(moved[2][0]).toBeCloseTo(10, 9);
    expect(moved[2][1]).toBeCloseTo(8, 9);
  });

  it('vertex 0 drags relative to the component cx/cy', () => {
    const c = mkComp({ cx: 5, cy: 5 });
    const verts = resolve(c);
    const out = dragVertexPatch(c, verts, 0, { x: 7, y: 4 });
    expect(out[0]).toMatchObject({ dx: '2', dy: '-1' });
    // follower (rel-numeric) keeps its resolved position
    const moved = resolvePolylineVertices({ ...c, vertices: out }, {}, {});
    expect(moved[1][0]).toBeCloseTo(verts[1][0], 9);
    expect(moved[1][1]).toBeCloseTo(verts[1][1], 9);
  });

  it('leaves a snap / arc / expression follower untouched (chain shifts)', () => {
    for (const follower of [
      { kind: 'snap', compId: 'a', anchor: 'C' },
      { kind: 'arc', cdx: '0', cdy: '5', angle: '90' },
      rel('gap_x', '0'),
    ]) {
      const c = mkComp({ vertices: [rel(0, 0), rel(10, 0), follower] });
      const verts = resolve(c);
      const out = dragVertexPatch(c, verts, 1, { x: 11, y: 1 });
      expect(out[1]).toMatchObject({ dx: '11', dy: '1' });
      expect(out[2]).toBe(follower); // same object — not rewritten
    }
  });
});

describe('nearestPolySegment (C3 dbl-click hit test)', () => {
  it('finds the closest segment and the clamped projection', () => {
    const verts = [[0, 0], [10, 0], [10, 8]];
    const hit = nearestPolySegment(verts, { x: 4, y: 1 });
    expect(hit.endIdx).toBe(1);
    expect(hit.dist).toBeCloseTo(1, 9);
    expect(hit.point.x).toBeCloseTo(4, 9);
    expect(hit.point.y).toBeCloseTo(0, 9);
  });

  it('reports the closing edge as endIdx === n when closed', () => {
    const verts = [[0, 0], [10, 0], [10, 8], [0, 8]];
    const hit = nearestPolySegment(verts, { x: 0.5, y: 4 }, true);
    expect(hit.endIdx).toBe(4); // closing edge (0,8) → (0,0)
  });

  it('returns null for degenerate input', () => {
    expect(nearestPolySegment([[0, 0]], { x: 0, y: 0 })).toBeNull();
    expect(nearestPolySegment(null, { x: 0, y: 0 })).toBeNull();
  });
});

describe('insertVertexInSegment (C3 dbl-click insert)', () => {
  it('splits a rel-numeric segment preserving geometry', () => {
    const c = mkComp();
    const verts = resolve(c);
    const res = insertVertexInSegment(c, verts, 1, { x: 4, y: 0 });
    expect(res.error).toBeUndefined();
    expect(res.vertices).toHaveLength(4);
    expect(res.vertices[1]).toMatchObject({ kind: 'rel', dx: '4', dy: '0' });
    expect(res.vertices[2]).toMatchObject({ dx: '6', dy: '0' });
    const after = resolvePolylineVertices({ ...c, vertices: res.vertices }, {}, {});
    expect(after[2][0]).toBeCloseTo(10, 9); // old v1 position unchanged
    expect(after[3][1]).toBeCloseTo(8, 9);  // old v2 position unchanged
  });

  it('appends on the closing edge without touching vertex 0', () => {
    const c = mkComp({ kind: 'polyshape', closed: true });
    const verts = resolve(c);
    const res = insertVertexInSegment(c, verts, 3, { x: 5, y: 4 }); // endIdx === specs.length
    expect(res.error).toBeUndefined();
    expect(res.vertices).toHaveLength(4);
    expect(res.vertices[0]).toBe(c.vertices[0]);
    expect(res.vertices[3]).toMatchObject({ dx: '-5', dy: '-4' }); // from (10,8) to (5,4)
  });

  it('refuses snap / arc / spline / expression neighbors', () => {
    const cases = [
      { vertices: [{ kind: 'snap', compId: 'a', anchor: 'C' }, rel(10, 0), rel(0, 8)], endIdx: 1, re: /snap-bound/ },
      { vertices: [rel(0, 0), { kind: 'arc', cdx: '0', cdy: '5', angle: '90' }, rel(0, 8)], endIdx: 1, re: /arc/ },
      { vertices: [rel(0, 0), rel(10, 0, { spline: true }), rel(0, 8, { spline: true })], endIdx: 2, re: /spline/ },
      { vertices: [rel(0, 0), rel('gap_x', '0'), rel(0, 8)], endIdx: 1, re: /driven by/ },
    ];
    for (const { vertices, endIdx, re } of cases) {
      const c = mkComp({ vertices });
      const res = insertVertexInSegment(c, resolve(c), endIdx, { x: 1, y: 1 });
      expect(res.error).toMatch(re);
    }
  });
});

describe('deleteVertexFixDownstream (C3 Alt+click delete)', () => {
  it('merges into a rel-numeric follower so downstream stays fixed', () => {
    const c = mkComp({ vertices: [rel(0, 0), rel(10, 0), rel(0, 8), rel(5, 0)] });
    const verts = resolve(c); // [[0,0],[10,0],[10,8],[15,8]]
    const res = deleteVertexFixDownstream(c, verts, 1);
    expect(res.error).toBeUndefined();
    expect(res.vertices).toHaveLength(3);
    const after = resolvePolylineVertices({ ...c, vertices: res.vertices }, {}, {});
    expect(after[1][0]).toBeCloseTo(10, 9); // old v2 stays at (10, 8)
    expect(after[1][1]).toBeCloseTo(8, 9);
    expect(after[2][0]).toBeCloseTo(15, 9); // old v3 stays at (15, 8)
  });

  it('deleting vertex 0 rebases the new first vertex onto cx/cy', () => {
    const c = mkComp({ cx: 3, cy: 2, vertices: [rel(1, 1), rel(10, 0), rel(0, 8)] });
    const verts = resolve(c); // v0=(4,3), v1=(14,3), v2=(14,11)
    const res = deleteVertexFixDownstream(c, verts, 0);
    expect(res.error).toBeUndefined();
    const after = resolvePolylineVertices({ ...c, vertices: res.vertices }, {}, {});
    expect(after[0][0]).toBeCloseTo(14, 9);
    expect(after[0][1]).toBeCloseTo(3, 9);
  });

  it('needs no rewrite for a snap follower; drops the last vertex freely', () => {
    const snapV = { kind: 'snap', compId: 'a', anchor: 'C' };
    const c = mkComp({ vertices: [rel(0, 0), rel(10, 0), snapV] });
    const res = deleteVertexFixDownstream(c, resolve(c), 1);
    expect(res.error).toBeUndefined();
    expect(res.vertices[1]).toBe(snapV);
    const c2 = mkComp();
    const res2 = deleteVertexFixDownstream(c2, resolve(c2), 2);
    expect(res2.error).toBeUndefined();
    expect(res2.vertices).toHaveLength(2);
  });

  it('refuses below the minimum vertex count (2 polyline / 3 polyshape)', () => {
    const pl = mkComp({ vertices: [rel(0, 0), rel(10, 0)] });
    expect(deleteVertexFixDownstream(pl, resolve(pl), 1).error).toMatch(/at least 2/);
    const ps = mkComp({ kind: 'polyshape', closed: true });
    expect(deleteVertexFixDownstream(ps, resolve(ps), 1).error).toMatch(/at least 3/);
  });

  it('refuses arc / expression followers', () => {
    const cArc = mkComp({ vertices: [rel(0, 0), rel(10, 0), { kind: 'arc', cdx: '0', cdy: '5', angle: '90' }, rel(1, 1)] });
    expect(deleteVertexFixDownstream(cArc, resolve(cArc), 1).error).toMatch(/arc/);
    const cExpr = mkComp({ vertices: [rel(0, 0), rel(10, 0), rel('gap_x', '0'), rel(1, 1)] });
    expect(deleteVertexFixDownstream(cExpr, resolve(cExpr), 1).error).toMatch(/driven by/);
  });
});

describe('alignAxis (C5 smart alignment)', () => {
  it('picks the smallest delta within threshold', () => {
    const res = alignAxis([5, 10, 15], [{ val: 15.4, compId: 'a' }, { val: 3, compId: 'b' }], 1);
    expect(res.delta).toBeCloseTo(0.4, 9);
    expect(res.guides).toHaveLength(1);
    expect(res.guides[0]).toMatchObject({ val: 15.4, compId: 'a' });
  });

  it('reports every coordinate satisfied by the chosen shift', () => {
    // delta 0.4 lands L on b's 5.4 AND R on a's 15.4 simultaneously.
    const res = alignAxis([5, 10, 15], [{ val: 15.4, compId: 'a' }, { val: 5.4, compId: 'b' }], 1);
    expect(res.delta).toBeCloseTo(0.4, 9);
    expect(res.guides.map(g => g.val).sort((x, y) => x - y)).toEqual([5.4, 15.4]);
  });

  it('returns null when nothing is in reach (or threshold invalid)', () => {
    expect(alignAxis([0, 5, 10], [{ val: 50, compId: 'a' }], 1)).toBeNull();
    expect(alignAxis([0], [{ val: 0.1, compId: 'a' }], 0)).toBeNull();
  });
});
