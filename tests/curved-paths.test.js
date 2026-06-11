// Curved-path vertex model: arcs, splines, and tapers on polyline /
// polyshape components.
//
// Covers the geometry layer (arc endpoint math, tessellation, bbox
// bulges, Catmull-Rom, tapered band quads, synthArc90 side-picking),
// the solver's bbox refresh, schema normalization of the new vertex
// fields, and the rename / tokenize walkers. Export-level assertions
// (AngularArc / Spline / taper emission + AST checks) live in
// exports.test.js.
import { describe, it, expect } from 'vitest';
import {
  arcEndpoint, arcSegCount, synthArc90,
  resolvePolylineVertices, tessellatePolylinePath,
  catmullRomTessellate, taperedBandQuads, polylineIsTapered,
  effectiveVertexWidth, polylineBbox, polyshapeBbox,
} from '../src/geometry/polyline.js';
import { solveLayout } from '../src/scene/solver.js';
import { renameIdentInScene } from '../src/scene/rename-ident.js';
import { tokenizeComponentExprs } from '../src/scene/params.js';
import { normalizeScene } from '../src/scene/schema.js';

// ── Arc endpoint math ───────────────────────────────────────────────────

describe('arcEndpoint', () => {
  it('90° quarter circle: start (0,0), center (0,10) → endpoint (10,10)', () => {
    const [x, y] = arcEndpoint(0, 0, 0, 10, 90);
    expect(x).toBeCloseTo(10, 9);
    expect(y).toBeCloseTo(10, 9);
  });
  it('-90° (CW) quarter circle: start (0,0), center (0,10) → endpoint (-10,10)', () => {
    const [x, y] = arcEndpoint(0, 0, 0, 10, -90);
    expect(x).toBeCloseTo(-10, 9);
    expect(y).toBeCloseTo(10, 9);
  });
  it('180° half circle: start (0,0), center (5,0) → endpoint (10,0)', () => {
    const [x, y] = arcEndpoint(0, 0, 5, 0, 180);
    expect(x).toBeCloseTo(10, 9);
    expect(y).toBeCloseTo(0, 9);
  });
  it('360° returns to the start', () => {
    const [x, y] = arcEndpoint(3, 4, 7, -2, 360);
    expect(x).toBeCloseTo(3, 9);
    expect(y).toBeCloseTo(4, 9);
  });
});

describe('arcSegCount', () => {
  it('scales with sweep: full circle = 64 segments (CIRCLE_TESSELATION parity)', () => {
    expect(arcSegCount(360)).toBe(64);
  });
  it('90° arc = 16 segments', () => {
    expect(arcSegCount(90)).toBe(16);
  });
  it('floors at 8 for short arcs', () => {
    expect(arcSegCount(5)).toBe(8);
    expect(arcSegCount(0)).toBe(8);
  });
  it('uses |angle| (CW arcs tessellate like CCW)', () => {
    expect(arcSegCount(-90)).toBe(16);
  });
});

// ── Vertex resolution + tessellation ────────────────────────────────────

const mkPolyline = (vertices, extra = {}) => ({
  id: 'pl', kind: 'polyline', layer: 'electrode',
  cx: 0, cy: 0, width: '2', w: '0', h: '0',
  cutouts: [], transforms: [], vertices, ...extra,
});

describe('resolvePolylineVertices with arcs', () => {
  it('arc vertex resolves to the arc ENDPOINT (one point per vertex spec)', () => {
    const c = mkPolyline([
      { kind: 'rel', dx: '0', dy: '0' },
      { kind: 'arc', cdx: '0', cdy: '10', angle: '90' },
    ]);
    const verts = resolvePolylineVertices(c, {}, {});
    expect(verts).toHaveLength(2);
    expect(verts[1][0]).toBeCloseTo(10, 9);
    expect(verts[1][1]).toBeCloseTo(10, 9);
  });
  it('chains: a rel step after an arc starts from the arc endpoint', () => {
    const c = mkPolyline([
      { kind: 'rel', dx: '0', dy: '0' },
      { kind: 'arc', cdx: '0', cdy: '10', angle: '90' },
      { kind: 'rel', dx: '5', dy: '0' },
    ]);
    const verts = resolvePolylineVertices(c, {}, {});
    expect(verts[2][0]).toBeCloseTo(15, 9);
    expect(verts[2][1]).toBeCloseTo(10, 9);
  });
  it('arc cdx/cdy/angle are parametric expressions', () => {
    const c = mkPolyline([
      { kind: 'rel', dx: '0', dy: '0' },
      { kind: 'arc', cdx: 'arc_r', cdy: '0', angle: 'arc_a' },
    ]);
    const verts = resolvePolylineVertices(c, {}, { arc_r: 5, arc_a: 180 });
    expect(verts[1][0]).toBeCloseTo(10, 9);
    expect(verts[1][1]).toBeCloseTo(0, 9);
  });
});

describe('tessellatePolylinePath', () => {
  it('expands a 90° arc into arcSegCount(90)=16 sub-segments', () => {
    const c = mkPolyline([
      { kind: 'rel', dx: '0', dy: '0' },
      { kind: 'arc', cdx: '0', cdy: '10', angle: '90' },
    ]);
    const pts = tessellatePolylinePath(c, {}, {});
    // v0 (1 point) + 16 arc points (start excluded, end included)
    expect(pts).toHaveLength(17);
    const last = pts[pts.length - 1];
    expect(last[0]).toBeCloseTo(10, 9);
    expect(last[1]).toBeCloseTo(10, 9);
  });
  it('arc tessellation includes the bulge beyond the endpoint AABB', () => {
    // 180° arc from (0,0) to (10,0) about (5,0) dips to (5,-5).
    const c = mkPolyline([
      { kind: 'rel', dx: '0', dy: '0' },
      { kind: 'arc', cdx: '5', cdy: '0', angle: '180' },
    ]);
    const pts = tessellatePolylinePath(c, {}, {});
    const minY = Math.min(...pts.map(p => p[1]));
    expect(minY).toBeCloseTo(-5, 6);
  });
  it('line vertices pass through 1:1 (vertex indexing parity)', () => {
    const c = mkPolyline([
      { kind: 'rel', dx: '0', dy: '0' },
      { kind: 'rel', dx: '10', dy: '0' },
      { kind: 'rel', dx: '0', dy: '7' },
    ]);
    const pts = tessellatePolylinePath(c, {}, {});
    expect(pts).toEqual([[0, 0], [10, 0], [10, 7]]);
  });
  it('spline runs interpolate through the control points (Catmull-Rom)', () => {
    const c = mkPolyline([
      { kind: 'rel', dx: '0', dy: '0' },
      { kind: 'rel', dx: '10', dy: '0', spline: true },
      { kind: 'rel', dx: '10', dy: '10', spline: true },
      { kind: 'rel', dx: '10', dy: '-10', spline: true },
    ]);
    const pts = tessellatePolylinePath(c, {}, {});
    // 1 anchor + 3 spans × 8 segs = 25 points.
    expect(pts).toHaveLength(25);
    // Control points are hit exactly at span boundaries.
    expect(pts[8][0]).toBeCloseTo(10, 9);
    expect(pts[8][1]).toBeCloseTo(0, 9);
    expect(pts[16][0]).toBeCloseTo(20, 9);
    expect(pts[16][1]).toBeCloseTo(10, 9);
    expect(pts[24][0]).toBeCloseTo(30, 9);
    expect(pts[24][1]).toBeCloseTo(0, 9);
  });
});

describe('catmullRomTessellate', () => {
  it('passes through every control point', () => {
    const ctrl = [[0, 0], [10, 5], [20, -5], [30, 0]];
    const out = catmullRomTessellate(ctrl, 8);
    expect(out).toHaveLength(1 + 3 * 8);
    for (let i = 0; i < ctrl.length; i++) {
      expect(out[i * 8][0]).toBeCloseTo(ctrl[i][0], 9);
      expect(out[i * 8][1]).toBeCloseTo(ctrl[i][1], 9);
    }
  });
  it('degenerates gracefully for < 2 points', () => {
    expect(catmullRomTessellate([[1, 2]], 8)).toEqual([[1, 2]]);
    expect(catmullRomTessellate([], 8)).toEqual([]);
  });
});

// ── Solver bbox refresh includes arc bulges ─────────────────────────────

describe('solver polyline/polyshape bbox with arcs', () => {
  it('polyline AABB includes the 180° arc bulge + half-width padding', () => {
    const c = mkPolyline([
      { kind: 'rel', dx: '0', dy: '0' },
      { kind: 'arc', cdx: '5', cdy: '0', angle: '180' },
    ]);
    const solved = solveLayout([c], [], {});
    const pl = solved.find(s => s.id === 'pl');
    // Vertex extent: x ∈ [0,10], y ∈ [-5,0]; width 2 pads each face by 1.
    expect(pl.w).toBeCloseTo(12, 6);
    expect(pl.h).toBeCloseTo(7, 6);
    // Tessellated path stashed for ring consumers.
    expect(Array.isArray(pl._resolvedVerts)).toBe(true);
    expect(pl._resolvedVerts.length).toBeGreaterThan(2);
  });
  it('polyshape AABB includes arc bulges (no width padding)', () => {
    const c = {
      id: 'ps', kind: 'polyshape', layer: 'electrode',
      cx: 0, cy: 0, w: '0', h: '0', closed: true,
      cutouts: [], transforms: [],
      vertices: [
        { kind: 'rel', dx: '0', dy: '0' },
        { kind: 'arc', cdx: '5', cdy: '0', angle: '180' },
        { kind: 'rel', dx: '0', dy: '10' },
      ],
    };
    const solved = solveLayout([c], [], {});
    const ps = solved.find(s => s.id === 'ps');
    expect(ps.w).toBeCloseTo(10, 6);
    expect(ps.h).toBeCloseTo(15, 6); // y ∈ [-5, 10]
  });
  it('tapered polyline AABB pads by the WIDEST per-vertex width', () => {
    const c = mkPolyline([
      { kind: 'rel', dx: '0', dy: '0' },
      { kind: 'rel', dx: '10', dy: '0', width: '6' },
    ]);
    const solved = solveLayout([c], [], {});
    const pl = solved.find(s => s.id === 'pl');
    expect(pl.w).toBeCloseTo(16, 6); // 10 + 2*(6/2)
    expect(pl.h).toBeCloseTo(6, 6);
  });
});

// ── Tapered band quads ──────────────────────────────────────────────────

describe('taperedBandQuads', () => {
  it('polylineIsTapered triggers on any non-empty per-vertex width', () => {
    expect(polylineIsTapered(mkPolyline([{ kind: 'rel', dx: '0', dy: '0' }]))).toBe(false);
    expect(polylineIsTapered(mkPolyline([{ kind: 'rel', dx: '0', dy: '0', width: '4' }]))).toBe(true);
    expect(polylineIsTapered(mkPolyline([{ kind: 'rel', dx: '0', dy: '0', width: '  ' }]))).toBe(false);
  });
  it('single line segment → one quad with linearly-varying width, butt joins', () => {
    const c = mkPolyline([
      { kind: 'rel', dx: '0', dy: '0' },           // eff width = base = 2
      { kind: 'rel', dx: '10', dy: '0', width: '6' },
    ]);
    const { quads, curvedFallback } = taperedBandQuads(c, {}, {});
    expect(curvedFallback).toBe(false);
    expect(quads).toHaveLength(1);
    const q = quads[0];
    // Direction +x → unit normal (0, -1). Corners:
    //   start+n·w0/2 = (0,-1), end+n·w1/2 = (10,-3),
    //   end-n = (10,3), start-n = (0,1)
    expect(q[0][0]).toBeCloseTo(0, 9);  expect(q[0][1]).toBeCloseTo(-1, 9);
    expect(q[1][0]).toBeCloseTo(10, 9); expect(q[1][1]).toBeCloseTo(-3, 9);
    expect(q[2][0]).toBeCloseTo(10, 9); expect(q[2][1]).toBeCloseTo(3, 9);
    expect(q[3][0]).toBeCloseTo(0, 9);  expect(q[3][1]).toBeCloseTo(1, 9);
  });
  it('arc segments fall back to constant base width (curvedFallback flag)', () => {
    const c = mkPolyline([
      { kind: 'rel', dx: '0', dy: '0', width: '4' },
      { kind: 'arc', cdx: '0', cdy: '10', angle: '90' },
    ]);
    const { quads, curvedFallback } = taperedBandQuads(c, {}, {});
    expect(curvedFallback).toBe(true);
    expect(quads.length).toBe(arcSegCount(90)); // one quad per tessellated sub-segment
  });
  it('effectiveVertexWidth: arc vertices pin to the base width', () => {
    const c = mkPolyline([]);
    expect(effectiveVertexWidth(c, { kind: 'arc', width: '9' }, {})).toBeCloseTo(2, 9);
    expect(effectiveVertexWidth(c, { kind: 'rel', width: '9' }, {})).toBeCloseTo(9, 9);
    expect(effectiveVertexWidth(c, { kind: 'rel' }, {})).toBeCloseTo(2, 9);
  });
});

// ── Draw-UX 90° arc synthesis ───────────────────────────────────────────

describe('synthArc90', () => {
  it('center sits on the perpendicular bisector at |SE|/2 (90° geometry)', () => {
    const arc = synthArc90({ x: 0, y: 0 }, { x: 10, y: 0 }, null);
    expect(arc).toBeTruthy();
    // Default (no prevDir): +90 CCW side → center (5, 5).
    expect(arc.angle).toBe(90);
    expect(arc.cdx).toBeCloseTo(5, 9);
    expect(arc.cdy).toBeCloseTo(5, 9);
    // The synthesized arc actually lands on E.
    const [ex, ey] = arcEndpoint(0, 0, arc.cdx, arc.cdy, arc.angle);
    expect(ex).toBeCloseTo(10, 9);
    expect(ey).toBeCloseTo(0, 9);
  });
  it('picks the side whose initial tangent follows the previous direction', () => {
    // Coming from below (moving +y), then clicking to the right: the
    // arc should start upward → CW (-90) side, center below the chord.
    const arc = synthArc90({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 1 });
    expect(arc.angle).toBe(-90);
    expect(arc.cdy).toBeCloseTo(-5, 9);
    const [ex, ey] = arcEndpoint(0, 0, arc.cdx, arc.cdy, arc.angle);
    expect(ex).toBeCloseTo(10, 9);
    expect(ey).toBeCloseTo(0, 9);
  });
  it('returns null for a degenerate zero-length chord', () => {
    expect(synthArc90({ x: 3, y: 3 }, { x: 3, y: 3 }, null)).toBeNull();
  });
});

// ── Schema normalization ────────────────────────────────────────────────

describe('normalizeScene vertex-field coercion', () => {
  it('coerces numeric cdx/cdy/angle/width/dx/dy to strings; spline to boolean', () => {
    const s = normalizeScene({
      params: {},
      components: [{
        id: 'pl', kind: 'polyline', layer: 'electrode',
        cx: 0, cy: 0, width: '2', w: '0', h: '0', cutouts: [], transforms: [],
        vertices: [
          { kind: 'rel', dx: 0, dy: 0 },
          { kind: 'arc', cdx: 5, cdy: -2.5, angle: 90, width: 3 },
          { kind: 'rel', dx: 1, dy: 2, spline: 1 },
        ],
      }],
      snaps: [], mirrors: [], groups: [], booleans: [],
    });
    const v = s.components.find(c => c.id === 'pl').vertices;
    expect(v[0].dx).toBe('0');
    expect(v[1].cdx).toBe('5');
    expect(v[1].cdy).toBe('-2.5');
    expect(v[1].angle).toBe('90');
    expect(v[1].width).toBe('3');
    expect(v[2].spline).toBe(true);
  });
  it('backfills missing arc fields with sane defaults', () => {
    const s = normalizeScene({
      params: {},
      components: [{
        id: 'pl', kind: 'polyline', layer: 'electrode',
        cx: 0, cy: 0, width: '2', w: '0', h: '0', cutouts: [], transforms: [],
        vertices: [{ kind: 'rel', dx: '0', dy: '0' }, { kind: 'arc' }],
      }],
      snaps: [], mirrors: [], groups: [], booleans: [],
    });
    const arc = s.components.find(c => c.id === 'pl').vertices[1];
    expect(arc.cdx).toBe('0');
    expect(arc.cdy).toBe('0');
    expect(arc.angle).toBe('90');
  });
});

// ── Rename walker + unused-param tokenizer coverage ─────────────────────

describe('rename / tokenize walkers cover the new vertex fields', () => {
  const scene = {
    params: { foo: { expr: '10', unit: 'µm', desc: '' } },
    components: [{
      id: 'pl', kind: 'polyline', layer: 'electrode',
      cx: 0, cy: 0, width: 'foo/3', w: '0', h: '0', cutouts: [], transforms: [],
      vertices: [
        { kind: 'rel', dx: '0', dy: '0' },
        { kind: 'arc', cdx: 'foo', cdy: 'foo/2', angle: 'foo + 90' },
        { kind: 'rel', dx: '2*foo', dy: '0', spline: true, width: 'foo*2' },
        { kind: 'snap', compId: 'other', anchor: 'C', width: 'foo - 1' },
      ],
    }],
    snaps: [], mirrors: [], groups: [], booleans: [], stack: [],
  };
  it('renameIdentInScene rewrites cdx/cdy/angle/width on every vertex kind', () => {
    const out = renameIdentInScene(scene, 'foo', 'bar');
    const v = out.components[0].vertices;
    expect(v[1].cdx).toBe('bar');
    expect(v[1].cdy).toBe('bar/2');
    expect(v[1].angle).toBe('bar + 90');
    expect(v[2].dx).toBe('2*bar');
    expect(v[2].width).toBe('bar*2');
    expect(v[3].width).toBe('bar - 1');
    expect(v[3].compId).toBe('other'); // non-expression fields untouched
    expect(out.components[0].width).toBe('bar/3');
  });
  it('tokenizeComponentExprs surfaces idents from width + all vertex fields', () => {
    const idents = tokenizeComponentExprs(scene.components[0]);
    // width (foo/3), arc cdx/cdy/angle, spline rel dx + width, snap width
    const fooCount = idents.filter(i => i === 'foo').length;
    expect(fooCount).toBeGreaterThanOrEqual(7);
  });
});
