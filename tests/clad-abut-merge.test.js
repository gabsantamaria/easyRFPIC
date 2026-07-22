// Cladding abutment merge (Parasolid coincident-face guard).
//
// This kernel cannot boolean EXACTLY-ABUTTING solids at all — both the
// sequential multi-tool Subtract AND a clone+Unite workaround fail
// (PK_ERROR_missing_geom / PSUnite PK_boolean_result_failed_c, observed
// on the shipped KI-lumped design: fractured GDS rects gds1_12 abutting
// gds1_7/gds1_8 nulled the cladding). The exporter therefore merges
// same-z-band touching prism footprints EXACTLY in JS (rect-union.js)
// and emits one disposable numeric tool per merged region.
import { describe, it, expect } from 'vitest';
import { rectilinearUnion, clusterRingsByTouch, clusterRingsByEdgeShare, ringsShareEdge, isRectilinearRing } from '../src/export/rect-union.js';
import { normalizeScene } from '../src/scene/schema.js';
import { resolveParams } from '../src/scene/params.js';
import { generateHfssNative } from '../src/export/hfss-native.js';

const rectRing = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

describe('rectilinearUnion', () => {
  it('merges two abutting rects into one ring with exact area', () => {
    const u = rectilinearUnion([rectRing(0, 0, 10, 5), rectRing(0, 5, 10, 9)]);
    expect(u.ok).toBe(true);
    expect(u.rings.length).toBe(1);
    expect(u.area).toBeCloseTo(10 * 9, 9);
    expect(u.rings[0].length).toBe(4); // collinear seam removed
  });

  it('merges overlapping rects with inclusion-exclusion area', () => {
    const u = rectilinearUnion([rectRing(0, 0, 10, 10), rectRing(5, 5, 15, 15)]);
    expect(u.ok).toBe(true);
    expect(u.rings.length).toBe(1);
    expect(u.area).toBeCloseTo(100 + 100 - 25, 9);
  });

  it('keeps disjoint rects as separate rings', () => {
    const u = rectilinearUnion([rectRing(0, 0, 4, 4), rectRing(10, 0, 14, 4)]);
    expect(u.ok).toBe(true);
    expect(u.rings.length).toBe(2);
    expect(u.area).toBeCloseTo(32, 9);
  });

  it('handles the shipped gds1_7/gds1_8/gds1_12 configuration as one region', () => {
    const g7 = rectRing(-1628.333, 25.827346, -1625.0, 34.161346);
    const g8 = rectRing(-1633.333, 25.827346, -1630.0, 34.161346);
    const g12 = rectRing(-1631.667, 34.161346, -1626.667, 35.827346);
    const u = rectilinearUnion([g7, g8, g12]);
    expect(u.ok).toBe(true);
    expect(u.rings.length).toBe(1); // g12 bridges g7 and g8
    const expected = (3.333 * 8.334) * 2 + 5.0 * 1.666;
    expect(u.area).toBeCloseTo(expected, 3);
    expect(isRectilinearRing(u.rings[0])).toBe(true);
  });

  it('bails on non-rectilinear input', () => {
    const tri = [[0, 0], [10, 0], [5, 8]];
    expect(rectilinearUnion([tri, rectRing(0, 0, 4, 4)]).ok).toBe(false);
    const diamond = [[0, 0], [5, 5], [10, 0], [5, -5]];
    const u = rectilinearUnion([diamond]);
    expect(u.ok).toBe(false);
    expect(u.reason).toContain('non-rectilinear');
  });

  it('bails when the union produces a hole', () => {
    // Four rects forming a closed frame around an empty 4x4 center.
    const u = rectilinearUnion([
      rectRing(0, 0, 12, 4), rectRing(0, 8, 12, 12),
      rectRing(0, 4, 4, 8), rectRing(8, 4, 12, 8),
    ]);
    expect(u.ok).toBe(false);
    expect(u.reason).toContain('hole');
  });

  it('clusters rings transitively by touch', () => {
    const clusters = clusterRingsByTouch([
      rectRing(0, 0, 4, 4), rectRing(4, 0, 8, 4), rectRing(100, 0, 104, 4),
    ]);
    expect(clusters.length).toBe(2);
    const sizes = clusters.map((c) => c.length).sort();
    expect(sizes).toEqual([1, 2]);
  });

  it('bails on the keyhole pinch (self-touching boundary) instead of emitting a non-simple ring', () => {
    // 3x3 grid of 10x10 rects with (1,1) and (2,2) missing: the interior
    // notch connects to the outside through the single grid corner
    // (20,20). The old trace closed everything as ONE positive-area
    // self-touching loop that passed BOTH the hole check and the area
    // self-check (adversarial-review find, probe-confirmed) — and the
    // emitted covered polyline would be rejected by AEDT, silently
    // dropping the whole cluster's cladding cavity.
    const rings = [];
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        if ((i === 1 && j === 1) || (i === 2 && j === 2)) continue;
        rings.push(rectRing(i * 10, j * 10, i * 10 + 10, j * 10 + 10));
      }
    }
    const u = rectilinearUnion(rings);
    expect(u.ok).toBe(false);
    expect(u.reason).toContain('pinch');
    // All four corner orientations bail identically.
    for (const [gone1, gone2] of [[[1, 1], [0, 0]], [[1, 1], [0, 2]], [[1, 1], [2, 0]]]) {
      const rr = [];
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
          if ((i === gone1[0] && j === gone1[1]) || (i === gone2[0] && j === gone2[1])) continue;
          rr.push(rectRing(i * 10, j * 10, i * 10 + 10, j * 10 + 10));
        }
      }
      expect(rectilinearUnion(rr).ok).toBe(false);
    }
  });

  it('ringsShareEdge distinguishes abutment from transversal overlap and corner touch', () => {
    // Exact edge abutment — the coincident-face hazard.
    expect(ringsShareEdge(rectRing(0, 0, 10, 5), rectRing(0, 5, 10, 9))).toBe(true);
    // Partial-edge abutment (the shipped gds1_12-on-gds1_7 shape).
    expect(ringsShareEdge(rectRing(0, 0, 10, 5), rectRing(6, 5, 20, 9))).toBe(true);
    // Overlap WITH a collinear shared boundary segment.
    expect(ringsShareEdge(rectRing(0, 0, 10, 5), rectRing(4, 0, 14, 5))).toBe(true);
    // Pure transversal overlap: boundaries CROSS, no collinear segment —
    // Parasolid handles this fine; merging would only freeze parametrics.
    expect(ringsShareEdge(rectRing(0, 0, 10, 10), rectRing(5, 5, 15, 15))).toBe(false);
    // Corner touch only (point contact, no positive-length overlap).
    expect(ringsShareEdge(rectRing(0, 0, 10, 10), rectRing(10, 10, 20, 20))).toBe(false);
    // Disjoint.
    expect(ringsShareEdge(rectRing(0, 0, 4, 4), rectRing(100, 0, 104, 4))).toBe(false);
  });

  it('clusterRingsByEdgeShare only groups edge-sharing rings', () => {
    const clusters = clusterRingsByEdgeShare([
      rectRing(0, 0, 4, 4), rectRing(4, 0, 8, 4),      // abutting pair
      rectRing(20, 0, 30, 10), rectRing(25, 5, 35, 15), // transversal overlap — NOT clustered
    ]);
    const sizes = clusters.map((c) => c.length).sort();
    expect(sizes).toEqual([1, 1, 2]);
  });
});

describe('cladding abutment merge in generateHfssNative', () => {
  const polyshape = (id, cx, cy, w, h) => ({
    id, kind: 'polyshape', layer: 'waveguide', cx, cy, w: '0', h: '0', closed: true,
    cutouts: [], transforms: [],
    vertices: [
      { kind: 'rel', dx: '0', dy: '0' },
      { kind: 'rel', dx: String(w), dy: '0' },
      { kind: 'rel', dx: '0', dy: String(h) },
      { kind: 'rel', dx: String(-w), dy: '0' },
    ],
  });

  it('replaces abutting polyshapes with one merged tool; far tools stay direct', () => {
    const scene = normalizeScene({
      params: {}, snaps: [],
      components: [
        polyshape('psA', 0, 0, 10, 5),   // y 0..5
        polyshape('psB', 0, 5, 10, 4),   // y 5..9 — abuts psA exactly
        { id: 'far', kind: 'rect', layer: 'electrode', cx: 500, cy: 0, w: '10', h: '10', cutouts: [], transforms: [] },
      ],
    });
    const { values } = resolveParams(scene.params);
    const code = generateHfssNative(scene, values);
    // Merged tool emitted with the union footprint (10 x 9 rect).
    expect(code).toContain('_cladmrg_0');
    expect(code).toContain('merged cladding-cavity tool');
    // Direct subtract keeps 'far' but neither abutting polyshape.
    const direct = code.match(/Blank Parts:=", "l_clad", "Tool Parts:=", "([^"]+)"\],\s*\["NAME:SubtractParameters", "KeepOriginals:=", True\]/);
    expect(direct).toBeTruthy();
    const dTools = direct[1].split(',');
    expect(dTools).toContain('far');
    expect(dTools).not.toContain('psA');
    expect(dTools).not.toContain('psB');
    // Merged tool subtracted CONSUMED in its own call.
    expect(code).toMatch(/Blank Parts:=", "l_clad", "Tool Parts:=", "_cladmrg_0"\],\s*\["NAME:SubtractParameters", "KeepOriginals:=", False\]/);
    // Safety report caveat names both members.
    expect(code).toContain('exactly-abutting solids merged');
  });

  it('leaves non-touching polyshapes on the direct subtract, no synthetic tools', () => {
    const scene = normalizeScene({
      params: {}, snaps: [],
      components: [
        polyshape('psA', 0, 0, 10, 5),
        polyshape('psB', 100, 0, 10, 5), // far away
      ],
    });
    const { values } = resolveParams(scene.params);
    const code = generateHfssNative(scene, values);
    expect(code).not.toContain('_cladmrg_');
    const direct = code.match(/Blank Parts:=", "l_clad", "Tool Parts:=", "([^"]+)"\],\s*\["NAME:SubtractParameters", "KeepOriginals:=", True\]/);
    expect(direct).toBeTruthy();
    expect(direct[1].split(',')).toContain('psA');
    expect(direct[1].split(',')).toContain('psB');
  });

  it('keeps edge-sharing-but-unmergeable groups direct with a caveat', () => {
    // A pentagon whose LEFT edge exactly coincides with psA's right edge
    // (positive-length collinear overlap ⇒ clustered) but which carries a
    // diagonal edge ⇒ non-rectilinear ⇒ union bails ⇒ caveat + direct.
    const scene = normalizeScene({
      params: {}, snaps: [],
      components: [
        polyshape('psA', 0, 0, 10, 5),
        { id: 'pent', kind: 'polyshape', layer: 'waveguide', cx: 10, cy: 0, w: '0', h: '0', closed: true,
          cutouts: [], transforms: [],
          vertices: [
            { kind: 'rel', dx: '0', dy: '0' },
            { kind: 'rel', dx: '0', dy: '5' },
            { kind: 'rel', dx: '4', dy: '0' },
            { kind: 'rel', dx: '2', dy: '-2.5' },
            { kind: 'rel', dx: '-2', dy: '-2.5' },
          ] },
      ],
    });
    const { values } = resolveParams(scene.params);
    const code = generateHfssNative(scene, values);
    expect(code).not.toContain('_cladmrg_');
    expect(code).toContain('could not be merged');
    const direct = code.match(/Blank Parts:=", "l_clad", "Tool Parts:=", "([^"]+)"\],\s*\["NAME:SubtractParameters", "KeepOriginals:=", True\]/);
    expect(direct).toBeTruthy();
    expect(direct[1].split(',')).toContain('psA');
    expect(direct[1].split(',')).toContain('pent');
  });

  it('does NOT merge transversally overlapping parts (they boolean fine; parametrics preserved)', () => {
    // Pad + stub overlapping without any collinear shared boundary —
    // the standard continuity idiom. The review found bbox-touch
    // clustering merged (and froze) these needlessly.
    const scene = normalizeScene({
      params: {}, snaps: [],
      components: [
        { id: 'pad', kind: 'rect', layer: 'electrode', cx: 0, cy: 0, w: '20', h: '20', cutouts: [], transforms: [] },
        { id: 'stub', kind: 'rect', layer: 'electrode', cx: 15, cy: 0, w: '20', h: '4', cutouts: [], transforms: [] },
      ],
    });
    const { values } = resolveParams(scene.params);
    const code = generateHfssNative(scene, values);
    expect(code).not.toContain('_cladmrg_');
    const direct = code.match(/Blank Parts:=", "l_clad", "Tool Parts:=", "([^"]+)"\],\s*\["NAME:SubtractParameters", "KeepOriginals:=", True\]/);
    expect(direct).toBeTruthy();
    expect(direct[1].split(',')).toContain('pad');
    expect(direct[1].split(',')).toContain('stub');
  });

  it('merges exactly-abutting REPEAT replicas (pitch == width)', () => {
    const scene = normalizeScene({
      params: {}, snaps: [],
      components: [
        { id: 'bar', kind: 'rect', layer: 'electrode', cx: 0, cy: 0, w: '10', h: '4', cutouts: [],
          transforms: [{ id: 't1', kind: 'repeat', enabled: true, n: '2', dx: '10', dy: '0', includeOriginal: true }] },
      ],
    });
    const { values } = resolveParams(scene.params);
    const code = generateHfssNative(scene, values);
    expect(code).toContain('_cladmrg_0');
    // The merged region spans all three replicas: one 30 x 4 rect.
    const direct = code.match(/Blank Parts:=", "l_clad", "Tool Parts:=", "([^"]+)"\],\s*\["NAME:SubtractParameters", "KeepOriginals:=", True\]/);
    if (direct) {
      const dTools = direct[1].split(',');
      expect(dTools).not.toContain('bar');
      expect(dTools).not.toContain('bar_1');
      expect(dTools).not.toContain('bar_2');
    }
    expect(code).toMatch(/Tool Parts:=", "_cladmrg_0"\],\s*\["NAME:SubtractParameters", "KeepOriginals:=", False\]/);
  });

  it('warns loudly when a merged/mergeable ring abuts a waveguide slab (detection-only)', () => {
    // Film polyshape flush against the drawn waveguide's slab edge: the
    // slab is never merged (parametric wg build) but the coincident
    // edge is the probed scope-hole — a caveat must fire.
    const scene = normalizeScene({
      params: {}, snaps: [],
      components: [
        // wg rect 100 long, slab width w_slab (default 5) centered cy=0
        { id: 'wgA', kind: 'rect', layer: 'waveguide', cx: 0, cy: 0, w: '100', h: 'w_wg', cutouts: [], transforms: [] },
        // film polyshape whose bottom edge sits exactly on the slab's top edge (y = w_slab/2)
        { id: 'film', kind: 'polyshape', layer: 'waveguide', cx: -20, cy: 2.5, w: '0', h: '0', closed: true,
          cutouts: [], transforms: [],
          vertices: [
            { kind: 'rel', dx: '0', dy: '0' },
            { kind: 'rel', dx: '40', dy: '0' },
            { kind: 'rel', dx: '0', dy: '10' },
            { kind: 'rel', dx: '-40', dy: '0' },
          ] },
      ],
    });
    const { values } = resolveParams(scene.params);
    const code = generateHfssNative(scene, values);
    expect(code).toContain('coincident edge that the abutment merge cannot absorb');
  });

  it('cleans up stray merged tools if their subtract fails, and dodges user id collisions', () => {
    const scene = normalizeScene({
      params: {}, snaps: [],
      components: [
        polyshape('psA', 0, 0, 10, 5),
        polyshape('psB', 0, 5, 10, 4),
        // A user component squatting on the default synthetic prefix.
        { id: '_cladmrg_0', kind: 'rect', layer: 'electrode', cx: 300, cy: 0, w: '5', h: '5', cutouts: [], transforms: [] },
      ],
    });
    const { values } = resolveParams(scene.params);
    const code = generateHfssNative(scene, values);
    // Prefix shifted so the synthetic can't collide with the user part.
    expect(code).toContain('__cladmrg_0');
    // Failed-subtract cleanup loop present.
    expect(code).toContain('oEditor.Delete(["NAME:Selections", "Selections:=", _nm])');
  });
});
