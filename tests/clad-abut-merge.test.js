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
import { rectilinearUnion, clusterRingsByTouch, isRectilinearRing } from '../src/export/rect-union.js';
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

  it('keeps touching-but-unmergeable groups direct with a caveat', () => {
    // A diamond polyshape touching a rect — non-rectilinear, union bails.
    const scene = normalizeScene({
      params: {}, snaps: [],
      components: [
        polyshape('psA', 0, 0, 10, 5),
        { id: 'dia', kind: 'polyshape', layer: 'waveguide', cx: 10, cy: 2, w: '0', h: '0', closed: true,
          cutouts: [], transforms: [],
          vertices: [
            { kind: 'rel', dx: '0', dy: '0' },
            { kind: 'rel', dx: '4', dy: '4' },
            { kind: 'rel', dx: '4', dy: '-4' },
            { kind: 'rel', dx: '-4', dy: '-4' },
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
    expect(direct[1].split(',')).toContain('dia');
  });
});
