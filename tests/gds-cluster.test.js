// GDS boolean-cluster export (the "meander missing its replicas" fix).
//
// A boolean's OWN transform chain (repeat / rotate / duplicate_mirror on
// a union) multiplies the whole operand cluster. The exporter previously
// skipped booleans outright, so only base-pose operands landed in the
// GDS — a meander union with repeat(n)+rotate+duplicate_mirror exported
// just its 9 base bars. generateGDS now walks boolean clusters with
// scene3d's exact transform math; subtract/punch TOOLS emit as
// DATATYPE-1 cutouts.
import { describe, it, expect } from 'vitest';
import { normalizeScene } from '../src/scene/schema.js';
import { resolveParams } from '../src/scene/params.js';
import { generateGDS } from '../src/export/gds.js';
import { parseGDS, flattenGDSCell, topCellsOf } from '../src/gds/gds-import.js';
import { buildScene3D } from '../src/scene/scene3d.js';

const rect = (id, cx, cy, w, h, extra = {}) => ({
  id, kind: 'rect', layer: 'electrode', cx, cy, w: String(w), h: String(h),
  cutouts: [], transforms: [], ...extra,
});
const boolOp = (id, op, operandIds, extra = {}) => ({
  id, kind: 'boolean', op, operandIds, layer: 'electrode', cx: 0, cy: 0,
  w: '0', h: '0', cutouts: [], transforms: [], ...extra,
});

const gdsShapes = (scene, values) => {
  const bytes = generateGDS(scene, values);
  const lib = parseGDS(bytes);
  return flattenGDSCell(lib, topCellsOf(lib)[0]).shapes;
};
const centroid = (ptsIn) => {
  // Parsed GDS rings repeat the first vertex at the end (closed) —
  // drop it or the vertex mean is biased toward vertex 0.
  const pts = (ptsIn.length > 1 &&
    ptsIn[0][0] === ptsIn[ptsIn.length - 1][0] &&
    ptsIn[0][1] === ptsIn[ptsIn.length - 1][1]) ? ptsIn.slice(0, -1) : ptsIn;
  let x = 0, y = 0;
  for (const p of pts) { x += p[0]; y += p[1]; }
  return [x / pts.length, y / pts.length];
};
const ringArea = (pts) => Math.abs(pts.reduce((a, p, i) => {
  const q = pts[(i + 1) % pts.length];
  return a + p[0] * q[1] - q[0] * p[1];
}, 0)) / 2;

describe('GDS boolean-cluster export', () => {
  it('emits every replica of a union boolean with a repeat chain', () => {
    const scene = normalizeScene({
      params: {}, snaps: [],
      components: [
        rect('a', 0, 0, 10, 4, { consumedBy: 'u1' }),
        rect('b', 0, 6, 10, 4, { consumedBy: 'u1' }),
        boolOp('u1', 'union', ['a', 'b'], {
          transforms: [{ id: 't', kind: 'repeat', enabled: true, n: '2', dx: '30', dy: '0', includeOriginal: true }],
        }),
      ],
    });
    const { values } = resolveParams(scene.params);
    const shapes = gdsShapes(scene, values).filter((s) => s.datatype === 0);
    // 2 operands x 3 cluster instances.
    expect(shapes.length).toBe(6);
    const xs = shapes.map((s) => Math.round(centroid(s.pts)[0])).sort((p, q) => p - q);
    expect(xs).toEqual([0, 0, 30, 30, 60, 60]);
  });

  it('duplicate_mirror on the boolean emits mirrored operand copies (scene3d parity)', () => {
    const scene = normalizeScene({
      params: {}, snaps: [],
      components: [
        rect('a', 10, 0, 10, 4, { consumedBy: 'u1' }),
        rect('b', 25, 0, 6, 4, { consumedBy: 'u1' }),
        boolOp('u1', 'union', ['a', 'b'], {
          transforms: [{ id: 't', kind: 'duplicate_mirror', enabled: true, axis: 'y', px: '0', py: '0' }],
        }),
      ],
    });
    const { values } = resolveParams(scene.params);
    const shapes = gdsShapes(scene, values).filter((s) => s.datatype === 0);
    const s3 = buildScene3D(scene, values);
    const rings = s3.solids.filter((s) => s.role !== 'tool' && !String(s.layerKey || '').startsWith('stack') && s.ring);
    expect(shapes.length).toBe(rings.length);
    // Match every scene3d ring to a GDS polygon by centroid + area.
    for (const r of rings) {
      const [rx, ry] = centroid(r.ring);
      const match = shapes.find((s) => {
        const [gx2, gy2] = centroid(s.pts);
        return Math.abs(gx2 - rx) < 1e-3 && Math.abs(gy2 - ry) < 1e-3 &&
               Math.abs(ringArea(s.pts) - ringArea(r.ring)) < 1e-3;
      });
      expect(match, `scene3d ring at (${rx.toFixed(2)}, ${ry.toFixed(2)})`).toBeTruthy();
    }
  });

  it('rotated union cluster places operands at the rotated pose', () => {
    const scene = normalizeScene({
      params: {}, snaps: [],
      components: [
        rect('a', 20, 0, 10, 4, { consumedBy: 'u1' }),
        rect('b', 20, 10, 10, 4, { consumedBy: 'u1' }),
        boolOp('u1', 'union', ['a', 'b'], {
          transforms: [{ id: 't', kind: 'rotate', enabled: true, angle: '90', pivot: 'origin' }],
        }),
      ],
    });
    const { values } = resolveParams(scene.params);
    const shapes = gdsShapes(scene, values).filter((s) => s.datatype === 0);
    const s3 = buildScene3D(scene, values);
    const rings = s3.solids.filter((s) => s.role !== 'tool' && !String(s.layerKey || '').startsWith('stack') && s.ring);
    expect(shapes.length).toBe(rings.length);
    for (const r of rings) {
      const [rx, ry] = centroid(r.ring);
      const hit = shapes.some((s) => {
        const [gx2, gy2] = centroid(s.pts);
        return Math.abs(gx2 - rx) < 1e-3 && Math.abs(gy2 - ry) < 1e-3;
      });
      expect(hit, `ring at (${rx.toFixed(2)}, ${ry.toFixed(2)})`).toBe(true);
    }
  });

  it('subtract/punch tools emit as DATATYPE-1 cutouts, and follow the cluster chain', () => {
    const scene = normalizeScene({
      params: {}, snaps: [],
      components: [
        rect('base', 0, 0, 20, 20, { consumedBy: 'd1' }),
        rect('hole', 0, 0, 6, 6, { consumedBy: 'd1' }),
        boolOp('d1', 'subtract', ['base', 'hole'], {
          transforms: [{ id: 't', kind: 'repeat', enabled: true, n: '1', dx: '40', dy: '0', includeOriginal: true }],
        }),
      ],
    });
    const { values } = resolveParams(scene.params);
    const shapes = gdsShapes(scene, values);
    const solids = shapes.filter((s) => s.datatype === 0);
    const holes = shapes.filter((s) => s.datatype === 1);
    expect(solids.length).toBe(2); // base x 2 instances
    expect(holes.length).toBe(2);  // hole x 2 instances
    const hx = holes.map((s) => Math.round(centroid(s.pts)[0])).sort((p, q) => p - q);
    expect(hx).toEqual([0, 40]);
  });

  it('an operand with its OWN chain composes with the boolean chain', () => {
    const scene = normalizeScene({
      params: {}, snaps: [],
      components: [
        rect('bar', 0, 0, 4, 10, {
          consumedBy: 'u1',
          transforms: [{ id: 'r', kind: 'repeat', enabled: true, n: '1', dx: '8', dy: '0', includeOriginal: true }],
        }),
        boolOp('u1', 'union', ['bar'], {
          transforms: [{ id: 't', kind: 'repeat', enabled: true, n: '1', dx: '0', dy: '30', includeOriginal: true }],
        }),
      ],
    });
    const { values } = resolveParams(scene.params);
    const shapes = gdsShapes(scene, values).filter((s) => s.datatype === 0);
    // 2 own-chain instances x 2 cluster instances.
    expect(shapes.length).toBe(4);
    const cs = shapes.map((s) => centroid(s.pts).map(Math.round).join(',')).sort();
    expect(cs).toEqual(['0,0', '0,30', '8,0', '8,30']);
  });

  it('a dangling consumedBy still emits standalone (no silent loss)', () => {
    const scene = normalizeScene({
      params: {}, snaps: [],
      components: [rect('orphan', 5, 5, 10, 10, { consumedBy: 'gone' })],
    });
    const { values } = resolveParams(scene.params);
    const shapes = gdsShapes(scene, values).filter((s) => s.datatype === 0);
    expect(shapes.length).toBe(1);
  });
});

describe('GDS review-round fixes', () => {
  it('constant-width polyline emits the metal BAND, not the zero-area centerline', () => {
    const scene = normalizeScene({
      params: {}, snaps: [],
      components: [{
        id: 'tr', kind: 'polyline', layer: 'electrode', cx: 0, cy: 0, w: '0', h: '0',
        width: '4', cutouts: [], transforms: [],
        vertices: [
          { kind: 'rel', dx: '0', dy: '0' },
          { kind: 'rel', dx: '50', dy: '0' },
        ],
      }],
    });
    const { values } = resolveParams(scene.params);
    const shapes = gdsShapes(scene, values).filter((s) => s.datatype === 0);
    expect(shapes.length).toBe(1);
    expect(ringArea(shapes[0].pts)).toBeCloseTo(50 * 4, 3);
  });

  it('a 2-vertex widthful trace no longer vanishes (band ring has 4 corners)', () => {
    const scene = normalizeScene({
      params: {}, snaps: [],
      components: [{
        id: 'tr', kind: 'polyline', layer: 'electrode', cx: 10, cy: 10, w: '0', h: '0',
        width: '2', cutouts: [], transforms: [],
        vertices: [
          { kind: 'rel', dx: '0', dy: '0' },
          { kind: 'rel', dx: '0', dy: '30' },
        ],
      }],
    });
    const { values } = resolveParams(scene.params);
    const shapes = gdsShapes(scene, values).filter((s) => s.datatype === 0);
    expect(shapes.length).toBe(1);
    expect(ringArea(shapes[0].pts)).toBeCloseTo(30 * 2, 3);
  });

  it('subtract tool on a DIFFERENT layer cuts the blank layer (hole on blank layer)', () => {
    const scene = normalizeScene({
      params: {}, snaps: [],
      components: [
        rect('base', 0, 0, 20, 20, { consumedBy: 'd1' }),
        rect('holeP', 0, 0, 6, 6, { consumedBy: 'd1', layer: 'port' }),
        boolOp('d1', 'subtract', ['base', 'holeP']),
      ],
    });
    const { values } = resolveParams(scene.params);
    const shapes = gdsShapes(scene, values);
    const holes = shapes.filter((s) => s.datatype === 1);
    expect(holes.length).toBe(1);
    // Blank is electrode (layer 10) — the hole must land there, not 100.
    expect(holes[0].layer).toBe(10);
  });

  it('nested subtract used as a tool re-adds the kept island as DATATYPE 0', () => {
    const scene = normalizeScene({
      params: {}, snaps: [],
      components: [
        rect('blank', 0, 0, 40, 40, { consumedBy: 'outer' }),
        rect('toolBase', 0, 0, 12, 12, { consumedBy: 'inner' }),
        rect('toolHole', 0, 0, 4, 4, { consumedBy: 'inner' }),
        boolOp('inner', 'subtract', ['toolBase', 'toolHole'], { consumedBy: 'outer' }),
        boolOp('outer', 'subtract', ['blank', 'inner']),
      ],
    });
    const { values } = resolveParams(scene.params);
    const shapes = gdsShapes(scene, values);
    const dt0 = shapes.filter((s) => s.datatype === 0);
    const dt1 = shapes.filter((s) => s.datatype === 1);
    // blank (40x40) dt0 + toolBase (12x12) dt1 + toolHole kept island (4x4) dt0
    expect(dt1.length).toBe(1);
    expect(ringArea(dt1[0].pts)).toBeCloseTo(144, 3);
    const areas = dt0.map((s) => Math.round(ringArea(s.pts))).sort((a, b) => a - b);
    expect(areas).toEqual([16, 1600]);
  });

  it('consumedBy pointing at a boolean that does NOT list the comp emits standalone', () => {
    const scene = normalizeScene({
      params: {}, snaps: [],
      components: [
        rect('a', 0, 0, 10, 10, { consumedBy: 'u1' }),
        rect('x', 100, 0, 10, 10, { consumedBy: 'u1' }), // NOT in operandIds
        boolOp('u1', 'union', ['a']),
      ],
    });
    const { values } = resolveParams(scene.params);
    const shapes = gdsShapes(scene, values).filter((s) => s.datatype === 0);
    expect(shapes.length).toBe(2); // both a and x present
  });
});

describe('canvas F3 override parity for mirrored clusters with rotated operands', () => {
  it('override rotation sense matches scene3d for a single-axis cluster mirror', async () => {
    const { buildBoolOverridesForInstance } = await import('../src/ui/canvas/Canvas.jsx');
    const { expandTransforms } = await import('../src/scene/transforms.js');
    const { shapeInstanceToRing } = await import('../src/geometry/rings.js');
    const { solveLayout, resolveBooleanBboxes } = await import('../src/scene/solver.js');
    const scene = normalizeScene({
      params: {}, snaps: [],
      components: [
        rect('a', 10, 0, 20, 10, { consumedBy: 'u1', rotation: '30' }),
        rect('b', 40, 0, 6, 4, { consumedBy: 'u1' }),
        boolOp('u1', 'union', ['a', 'b'], {
          transforms: [{ id: 't', kind: 'mirror', enabled: true, axis: 'y', pivot: 'C' }],
        }),
      ],
    });
    const { values } = resolveParams(scene.params);
    const solved = resolveBooleanBboxes(solveLayout(scene.components, scene.snaps, values), values);
    const byId = Object.fromEntries(solved.map((c) => [c.id, c]));
    const b = byId.u1;
    const bInsts = expandTransforms([b], values, solved);
    const inst = bInsts[0];
    const baseInstOf = (c) => expandTransforms([c], values, solved)[0];
    const ov = buildBoolOverridesForInstance(b, inst, b.cx, b.cy, byId, baseInstOf);
    expect(ov).toBeTruthy();
    const canvasRing = shapeInstanceToRing(ov.a);
    // scene3d ground truth for operand a's mirrored ring.
    const s3 = buildScene3D(scene, values);
    const rings = s3.solids.filter((s) => s.role !== 'tool' && !String(s.layerKey || '').startsWith('stack') && s.ring);
    const [cxE, cyE] = centroid(canvasRing);
    const match = rings.find((r) => {
      const [rx, ry] = centroid(r.ring);
      return Math.abs(rx - cxE) < 1e-6 && Math.abs(ry - cyE) < 1e-6 && Math.abs(ringArea(r.ring) - 200) < 1e-6;
    });
    expect(match, 'scene3d ring at the canvas centroid').toBeTruthy();
    // Vertex-set parity (min over cyclic shifts, both orientations).
    const ringsEq = (p, q) => {
      if (p.length !== q.length) return false;
      const tryDir = (qq) => {
        for (let s = 0; s < qq.length; s++) {
          let ok = true;
          for (let i = 0; i < p.length; i++) {
            const t = qq[(i + s) % qq.length];
            if (Math.abs(p[i][0] - t[0]) > 1e-6 || Math.abs(p[i][1] - t[1]) > 1e-6) { ok = false; break; }
          }
          if (ok) return true;
        }
        return false;
      };
      return tryDir(q) || tryDir([...q].reverse());
    };
    expect(ringsEq(canvasRing, match.ring), 'canvas ring == scene3d ring').toBe(true);
  });
});

describe('constant-width band paint-union (choke fold fix)', () => {
  it('tight U-bend with a trailing duplicate vertex emits simple polygons covering the painted band', async () => {
    // The shipped choke: width == bend depth (2 um) + a zero-length final
    // vertex. The single miter OUTLINE folded over itself — KLayout
    // rendered wedge/chamfer artifacts. bandPieces + rectilinearUnion
    // must produce simple polygons whose union covers every point within
    // halfW of the centerline.
    const { ringSelfIntersects, tessellatePolylinePath } = await import('../src/geometry/polyline.js');
    const scene = normalizeScene({
      params: {}, snaps: [],
      components: [{
        id: 'choke', kind: 'polyline', layer: 'electrode', cx: 0, cy: 0, w: '0', h: '0',
        width: '2', cutouts: [], transforms: [],
        vertices: [
          { kind: 'rel', dx: '0', dy: '0' },
          { kind: 'rel', dx: '0', dy: '-2' },
          { kind: 'rel', dx: '5', dy: '0' },
          { kind: 'rel', dx: '0', dy: '2' },
          { kind: 'rel', dx: '0', dy: '0' }, // zero-length trailing vertex (as shipped)
        ],
      }],
    });
    const { values } = resolveParams(scene.params);
    const shapes = gdsShapes(scene, values).filter((s) => s.datatype === 0);
    expect(shapes.length).toBeGreaterThan(0);
    for (const sh of shapes) {
      const ring = sh.pts[0][0] === sh.pts[sh.pts.length - 1][0] && sh.pts[0][1] === sh.pts[sh.pts.length - 1][1]
        ? sh.pts.slice(0, -1) : sh.pts;
      expect(ringSelfIntersects(ring), 'simple polygon').toBe(false);
    }
    // Paint-coverage: sample within halfW*0.98 of the centerline.
    const solved = scene.components[0];
    const center = tessellatePolylinePath(solved, { choke: solved }, values);
    const inPoly = (px, py, ring) => { let ins = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const [xi, yi] = ring[i], [xj, yj] = ring[j]; if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) ins = !ins; } return ins; };
    // INTERIOR projection only: butt end caps (canvas + GDS semantics)
    // do not paint beyond the segment ends, so endpoint-region samples
    // must not count toward required coverage.
    const dSeg = (p, a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1]; const L2 = dx * dx + dy * dy || 1; const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2; if (t < 0.02 || t > 0.98) return Infinity; return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy); };
    let missed = 0;
    for (let x = -1.5; x <= 6.5; x += 0.07) {
      for (let y = -3.5; y <= 1.5; y += 0.07) {
        let d = 1e9;
        for (let i = 0; i + 1 < center.length; i++) d = Math.min(d, dSeg([x, y], center[i], center[i + 1]));
        if (d > 0.98) continue;
        if (!shapes.some((sh) => inPoly(x, y, sh.pts))) missed++;
      }
    }
    expect(missed).toBe(0);
  });
});
