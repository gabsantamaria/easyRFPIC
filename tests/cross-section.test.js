// Cross-section extraction (src/scene/cross-section.js) — CONTRACT v1.
// Pure geometry tests: segment∩ring crossing, interval algebra, and the
// full buildCrossSection pipeline (solve → expand → slice) against
// hand-computed numbers, plus the parametric-expression round-trip and
// sweep-parity gold standard (exprs computed at one param value must
// re-evaluate at another to EXACTLY what a fresh build there computes).
import { describe, it, expect } from 'vitest';
import {
  buildCrossSection,
  intersectSegmentRing,
  unionIntervals,
  subtractIntervals,
  intersectIntervals,
} from '../src/scene/cross-section.js';
import { makeBlankScene, normalizeScene } from '../src/scene/schema.js';
import { resolveParams, evalExpr } from '../src/scene/params.js';
import { computeNumericLayerZ } from '../src/scene/layer-z.js';

// ── Canonical contract fixture (shape reference — embedded copy, NOT
// shared with other agents' test files) ────────────────────────────────
const FIXTURE_CROSS = {
  ok: true, sectionId: 'sec1',
  line: { p0: { x: -60, y: 0 }, p1: { x: 60, y: 0 }, lengthUm: 120, axis: 'h' },
  domain: { tMin: 0, tMax: 120, zMin: -54.7, zMax: 21.4 },
  slabs: [
    { layerId: 'l_si',   name: 'Si',       material: 'silicon', color: '#64748b', role: 'substrate', z0: -54.7, z1: -4.7 },
    { layerId: 'l_sio2', name: 'SiO2',     material: 'SiO2',    color: '#94a3b8', role: 'substrate', z0: -4.7,  z1: 0 },
    { layerId: 'l_wg',   name: 'LN film',  material: 'LiNbO3',  color: '#7dd3fc', role: 'waveguide', z0: 0, z1: 0.6, z0Expr: '(0)um', z1Expr: '(h_wg)um' },
    { layerId: 'l_clad', name: 'cladding', material: 'SiO2',    color: '#cbd5e1', role: 'cladding',  z0: 0.6, z1: 5.3 },
    { layerId: '__air',  name: 'air',      material: 'vacuum',  color: '#e2e8f0', role: 'air',       z0: 5.3, z1: 21.4 },
  ],
  conductors: [
    { id: 'gnd_top', label: 'gnd_top', layerId: 'l_cond', material: 'gold', color: '#fbbf24', zeroThickness: false, areaUm2: 32,
      z0: 0.6, z1: 1.4, z0Expr: '(h_wg)um', z1Expr: '(h_wg + h_cond)um',
      intervals: [{ t0: 0, t1: 40, t0Expr: '(0)um', t1Expr: '(40)um' }] },
    { id: 'sig', label: 'sig', layerId: 'l_cond', material: 'gold', color: '#fbbf24', zeroThickness: false, areaUm2: 8,
      z0: 0.6, z1: 1.4, intervals: [{ t0: 45, t1: 55 }] },
    { id: 'gnd_bot', label: 'gnd_bot', layerId: 'l_cond', material: 'gold', color: '#fbbf24', zeroThickness: false, areaUm2: 32,
      z0: 0.6, z1: 1.4, intervals: [{ t0: 60, t1: 100 }] },
  ],
  waveguides: [
    { id: 'wg1', layerId: 'l_wg', material: 'LiNbO3', color: '#7dd3fc',
      slabBand: { z0: 0, z1: 0.3, intervals: [{ t0: 0, t1: 120 }] },
      core: { zBot: 0.3, zTop: 0.6, segments: [{ botT0: 48.9, botT1: 51.1, topT0: 49.25, topT1: 50.75 }] } },
  ],
  wgCenter: { t: 50, z: 0.45, compId: 'wg1' },
  params: { h_wg: 0.6, h_cond: 0.8 },
  warnings: [],
};

// ── Scene builders ─────────────────────────────────────────────────────
const rect = (id, layer, cx, cy, w, h, extra = {}) => ({
  id, kind: 'rect', layer, cx, cy, w: String(w), h: String(h),
  cutouts: [], transforms: [], ...extra,
});
const sectionLine = (id, x0, y0, x1, y1) => ({
  id, kind: 'polyline', layer: 'section', cx: x0, cy: y0, width: '0',
  closed: false, cutouts: [], transforms: [],
  vertices: [
    { kind: 'rel', dx: '0', dy: '0' },
    { kind: 'rel', dx: String(x1 - x0), dy: String(y1 - y0) },
  ],
});
function sceneWith(components, extra = {}) {
  const blank = makeBlankScene();
  return normalizeScene({
    ...blank,
    ...extra,
    params: { ...blank.params, ...(extra.params || {}) },
    components,
  });
}
const pvOf = (scene) => resolveParams(scene.params).values;
const build = (scene, id = 'sec1') => buildCrossSection(scene, pvOf(scene), id);
const rectRing = (cx, cy, w, h) => [
  [cx - w / 2, cy - h / 2], [cx + w / 2, cy - h / 2],
  [cx + w / 2, cy + h / 2], [cx - w / 2, cy + h / 2],
];

// ── intersectSegmentRing ───────────────────────────────────────────────
describe('intersectSegmentRing', () => {
  const P = (x, y) => ({ x, y });

  it('simple rect crossing', () => {
    const ivs = intersectSegmentRing(P(-10, 0), P(10, 0), rectRing(0, 0, 4, 2));
    expect(ivs).toHaveLength(1);
    expect(ivs[0].t0).toBeCloseTo(8, 9);
    expect(ivs[0].t1).toBeCloseTo(12, 9);
  });

  it('endpoint inside the polygon', () => {
    const ivs = intersectSegmentRing(P(0, 0), P(10, 0), rectRing(0, 0, 4, 2));
    expect(ivs).toHaveLength(1);
    expect(ivs[0].t0).toBeCloseTo(0, 9);
    expect(ivs[0].t1).toBeCloseTo(2, 9);
  });

  it('tangent vertex produces no interval', () => {
    const diamond = [[0, 1], [1, 0], [0, -1], [-1, 0]];
    const ivs = intersectSegmentRing(P(-5, 1), P(5, 1), diamond);
    expect(ivs).toHaveLength(0);
  });

  it('crossing THROUGH two polygon vertices', () => {
    // Diamond crossed along y=0 through its (-1,0)/(1,0) vertices — the
    // duplicate flip candidates at each vertex must not break the interval.
    const diamond = [[0, 1], [1, 0], [0, -1], [-1, 0]];
    const ivs = intersectSegmentRing(P(-5, 0), P(5, 0), diamond);
    expect(ivs).toHaveLength(1);
    expect(ivs[0].t0).toBeCloseTo(4, 9);
    expect(ivs[0].t1).toBeCloseTo(6, 9);
  });

  it('segment fully inside → one full-length interval', () => {
    const ivs = intersectSegmentRing(P(-5, 0), P(5, 0), rectRing(0, 0, 20, 20));
    expect(ivs).toHaveLength(1);
    expect(ivs[0].t0).toBeCloseTo(0, 9);
    expect(ivs[0].t1).toBeCloseTo(10, 9);
  });

  it('segment fully outside → empty', () => {
    expect(intersectSegmentRing(P(-10, 5), P(10, 5), rectRing(0, 0, 4, 2))).toHaveLength(0);
  });

  it('concave polygon → multiple intervals', () => {
    // U-shape: two 1-µm-wide arms at x 0..1 and 4..5 above y=1.
    const U = [[0, 0], [5, 0], [5, 3], [4, 3], [4, 1], [1, 1], [1, 3], [0, 3]];
    const ivs = intersectSegmentRing(P(-1, 2), P(6, 2), U);
    expect(ivs).toHaveLength(2);
    expect(ivs[0].t0).toBeCloseTo(1, 9);
    expect(ivs[0].t1).toBeCloseTo(2, 9);
    expect(ivs[1].t0).toBeCloseTo(5, 9);
    expect(ivs[1].t1).toBeCloseTo(6, 9);
  });

  it('oblique 45° crossing of a square → chord length side·√2', () => {
    const ivs = intersectSegmentRing(P(-20, -20), P(20, 20), rectRing(0, 0, 10, 10));
    expect(ivs).toHaveLength(1);
    expect(ivs[0].t1 - ivs[0].t0).toBeCloseTo(10 * Math.SQRT2, 9);
    expect(ivs[0].t0).toBeCloseTo(15 * Math.SQRT2, 9);
  });
});

// ── Interval algebra ───────────────────────────────────────────────────
describe('interval algebra', () => {
  it('union merges overlapping and touching intervals; normalizes swapped ends', () => {
    const u = unionIntervals([{ t0: 2, t1: 4 }, { t0: 0, t1: 2 }, { t0: 10, t1: 8 }]);
    expect(u).toEqual([{ t0: 0, t1: 4 }, { t0: 8, t1: 10 }]);
  });

  it('union drops degenerate slivers', () => {
    expect(unionIntervals([{ t0: 1, t1: 1 + 1e-12 }])).toHaveLength(0);
  });

  it('subtract splits, clips, and can annihilate', () => {
    expect(subtractIntervals([{ t0: 0, t1: 10 }], [{ t0: 2, t1: 3 }, { t0: 5, t1: 7 }]))
      .toEqual([{ t0: 0, t1: 2 }, { t0: 3, t1: 5 }, { t0: 7, t1: 10 }]);
    expect(subtractIntervals([{ t0: 0, t1: 10 }], [{ t0: -1, t1: 11 }])).toHaveLength(0);
    expect(subtractIntervals([{ t0: 0, t1: 10 }], [{ t0: 20, t1: 30 }]))
      .toEqual([{ t0: 0, t1: 10 }]);
  });

  it('intersect overlaps only; touching intervals yield nothing', () => {
    expect(intersectIntervals([{ t0: 0, t1: 5 }], [{ t0: 3, t1: 8 }]))
      .toEqual([{ t0: 3, t1: 5 }]);
    expect(intersectIntervals([{ t0: 0, t1: 5 }], [{ t0: 5, t1: 8 }])).toHaveLength(0);
    expect(intersectIntervals([{ t0: 0, t1: 2 }], [{ t0: 3, t1: 4 }])).toHaveLength(0);
  });
});

// ── Full scene: CPW (3 rects) + rib waveguide on the default stack ─────
describe('buildCrossSection — CPW + rib waveguide', () => {
  const scene = sceneWith([
    rect('gnd_l', 'electrode', -30, 0, '20', '200'),
    rect('sig', 'electrode', 0, 0, '10', '200'),
    rect('gnd_r', 'electrode', 30, 0, '20', '200'),
    rect('wg1', 'waveguide', 0, 0, 'w_wg', '200'),
    sectionLine('sec1', -60, 0, 60, 0),
  ]);
  const pv = pvOf(scene);
  const out = build(scene);
  const layerZ = computeNumericLayerZ(scene.stack, pv);
  const condL = scene.stack.find((l) => l.role === 'conductor');
  const wgL = scene.stack.find((l) => l.role === 'waveguide');

  it('ok, line and domain basics', () => {
    expect(out.ok).toBe(true);
    expect(out.sectionId).toBe('sec1');
    expect(out.line.axis).toBe('h');
    expect(out.line.lengthUm).toBeCloseTo(120, 9);
    expect(out.line.p0).toEqual({ x: -60, y: 0 });
    expect(out.domain.tMin).toBe(0);
    expect(out.domain.tMax).toBeCloseTo(120, 9);
  });

  it('matches the contract fixture shape (top-level keys + entry keys)', () => {
    for (const k of Object.keys(FIXTURE_CROSS)) expect(out).toHaveProperty(k);
    for (const k of ['id', 'label', 'layerId', 'material', 'color', 'zeroThickness', 'areaUm2', 'z0', 'z1', 'intervals']) {
      expect(out.conductors[0]).toHaveProperty(k);
    }
    for (const k of ['layerId', 'name', 'material', 'color', 'role', 'z0', 'z1']) {
      expect(out.slabs[0]).toHaveProperty(k);
    }
    expect(out.waveguides[0]).toHaveProperty('core');
    expect(out.waveguides[0].core).toHaveProperty('segments');
  });

  it('3 conductors, sorted by t0, at the conductor layer Z', () => {
    expect(out.conductors.map((c) => c.id)).toEqual(['gnd_l', 'sig', 'gnd_r']);
    const [gl, sg, gr] = out.conductors;
    expect(gl.intervals).toHaveLength(1);
    expect(gl.intervals[0].t0).toBeCloseTo(20, 9);
    expect(gl.intervals[0].t1).toBeCloseTo(40, 9);
    expect(sg.intervals[0].t0).toBeCloseTo(55, 9);
    expect(sg.intervals[0].t1).toBeCloseTo(65, 9);
    expect(gr.intervals[0].t0).toBeCloseTo(80, 9);
    expect(gr.intervals[0].t1).toBeCloseTo(100, 9);
    for (const c of out.conductors) {
      expect(c.z0).toBeCloseTo(layerZ[condL.id].zBottom, 9);
      expect(c.z1).toBeCloseTo(layerZ[condL.id].zTop, 9);
      expect(c.zeroThickness).toBe(false);
      expect(c.layerId).toBe(condL.id);
    }
    expect(gl.areaUm2).toBeCloseTo(20 * pv.h_cond, 9);
    expect(sg.areaUm2).toBeCloseTo(10 * pv.h_cond, 9);
  });

  it('conductor intervals carry round-tripping t exprs (axis-aligned rects)', () => {
    const sg = out.conductors.find((c) => c.id === 'sig');
    expect(typeof sg.intervals[0].t0Expr).toBe('string');
    expect(typeof sg.intervals[0].t1Expr).toBe('string');
    expect(evalExpr(sg.intervals[0].t0Expr, pv)).toBeCloseTo(55, 6);
    expect(evalExpr(sg.intervals[0].t1Expr, pv)).toBeCloseTo(65, 6);
  });

  it('rib waveguide: slab band + etch-angle trapezoid, exact scene3d math', () => {
    expect(out.waveguides).toHaveLength(1);
    const wg = out.waveguides[0];
    expect(wg.id).toBe('wg1');
    expect(wg.layerId).toBe(wgL.id);
    // Slab band: w_slab wide, z 0..h_slab.
    expect(wg.slabBand.z0).toBeCloseTo(layerZ[wgL.id].zBottom, 9);
    expect(wg.slabBand.z1).toBeCloseTo(layerZ[wgL.id].zBottom + pv.h_slab, 9);
    expect(wg.slabBand.intervals).toHaveLength(1);
    expect(wg.slabBand.intervals[0].t0).toBeCloseTo(60 - pv.w_slab / 2, 9);
    expect(wg.slabBand.intervals[0].t1).toBeCloseTo(60 + pv.w_slab / 2, 9);
    // Core trapezoid: ref 'top' ⇒ top = w_wg, bottom = w_wg + 2·ribH/tan(etch).
    const ribH = layerZ[wgL.id].thickness - pv.h_slab;
    const inward = ribH / Math.tan((pv.etch_angle * Math.PI) / 180);
    expect(wg.core.zBot).toBeCloseTo(layerZ[wgL.id].zBottom + pv.h_slab, 9);
    expect(wg.core.zTop).toBeCloseTo(layerZ[wgL.id].zTop, 9);
    expect(wg.core.segments).toHaveLength(1);
    const seg = wg.core.segments[0];
    expect(seg.topT1 - seg.topT0).toBeCloseTo(pv.w_wg, 6);
    expect(seg.botT1 - seg.botT0).toBeCloseTo(pv.w_wg + 2 * inward, 6);
    expect((seg.botT0 + seg.botT1) / 2).toBeCloseTo(60, 6);
    // Perpendicular crossing — no obliquity warning.
    expect(out.warnings.some((w) => w.code === 'oblique-wg')).toBe(false);
  });

  it('wgCenter is the crossed core nearest the midpoint', () => {
    expect(out.wgCenter).toBeTruthy();
    expect(out.wgCenter.compId).toBe('wg1');
    expect(out.wgCenter.t).toBeCloseTo(60, 6);
    expect(out.wgCenter.z).toBeCloseTo((out.waveguides[0].core.zBot + out.waveguides[0].core.zTop) / 2, 9);
  });

  it('slabs: one per non-conductor stack layer + air, contiguous coverage', () => {
    // No slab for the conductor layer; air synthetic on top.
    expect(out.slabs.some((s) => s.layerId === condL.id)).toBe(false);
    expect(out.slabs[out.slabs.length - 1].role).toBe('air');
    expect(out.slabs[out.slabs.length - 1].layerId).toBe('__air');
    // Coverage of [zMin, zMax] without gaps (overlaps allowed — coplanar
    // wg film + cladding share a Z band by design).
    const sorted = [...out.slabs].sort((a, b) => a.z0 - b.z0);
    expect(sorted[0].z0).toBeCloseTo(out.domain.zMin, 9);
    let reach = sorted[0].z0;
    for (const s of sorted) {
      expect(s.z0).toBeLessThanOrEqual(reach + 1e-9);
      reach = Math.max(reach, s.z1);
    }
    expect(reach).toBeCloseTo(out.domain.zMax, 9);
  });

  it('domain z: substrate bottom → physical top + max(10, 0.3·span) air margin', () => {
    const zMin = layerZ['l_si'].zBottom;
    const physTop = Math.max(...Object.values(layerZ).map((z) => z.zTop));
    const span = physTop - zMin;
    expect(out.domain.zMin).toBeCloseTo(zMin, 9);
    expect(out.domain.zMax).toBeCloseTo(physTop + Math.max(10, 0.3 * span), 9);
    // Air starts at the top of the background slabs (cladding top here —
    // the conductor protrudes past it and is embedded in the air slab).
    const air = out.slabs[out.slabs.length - 1];
    expect(air.z0).toBeCloseTo(Math.max(...out.slabs.slice(0, -1).map((s) => s.z1)), 9);
  });

  it('slab + conductor z exprs round-trip against computeNumericLayerZ', () => {
    const wgSlab = out.slabs.find((s) => s.layerId === wgL.id);
    expect(typeof wgSlab.z0Expr).toBe('string');
    expect(typeof wgSlab.z1Expr).toBe('string');
    expect(evalExpr(wgSlab.z0Expr, pv)).toBeCloseTo(layerZ[wgL.id].zBottom, 6);
    expect(evalExpr(wgSlab.z1Expr, pv)).toBeCloseTo(layerZ[wgL.id].zTop, 6);
    const sg = out.conductors.find((c) => c.id === 'sig');
    expect(evalExpr(sg.z0Expr, pv)).toBeCloseTo(sg.z0, 6);
    expect(evalExpr(sg.z1Expr, pv)).toBeCloseTo(sg.z1, 6);
  });

  it('params holds every param referenced by an emitted expr', () => {
    // Conductor z1Expr references h_cond; wg slab z1Expr references h_wg.
    expect(out.params.h_cond).toBeCloseTo(pv.h_cond, 12);
    expect(out.params.h_wg).toBeCloseTo(pv.h_wg, 12);
    for (const [k, v] of Object.entries(out.params)) {
      expect(pv[k]).toBe(v);
    }
  });
});

// ── Booleans: union + repeat, punch hole ───────────────────────────────
describe('buildCrossSection — booleans', () => {
  it('union with repeat → ONE conductor entry with an interval per cell', () => {
    const scene = sceneWith([
      rect('mA', 'electrode', 0, 0, '4', '40', { consumedBy: 'u1' }),
      rect('mB', 'electrode', 10, 0, '4', '40', { consumedBy: 'u1' }),
      {
        id: 'u1', kind: 'boolean', op: 'union', operandIds: ['mA', 'mB'],
        layer: 'electrode', cx: 0, cy: 0, w: '0', h: '0', cutouts: [],
        transforms: [{ id: 't1', kind: 'repeat', enabled: true, n: '1', dx: '20', dy: '0', includeOriginal: true }],
        label: '',
      },
      sectionLine('sec1', -60, 0, 60, 0),
    ]);
    const out = build(scene);
    expect(out.ok).toBe(true);
    expect(out.conductors).toHaveLength(1);
    const u = out.conductors[0];
    expect(u.id).toBe('u1');
    const ivs = u.intervals.map((iv) => [iv.t0, iv.t1]);
    expect(ivs).toHaveLength(4);
    expect(ivs[0][0]).toBeCloseTo(58, 9);
    expect(ivs[0][1]).toBeCloseTo(62, 9);
    expect(ivs[1][0]).toBeCloseTo(68, 9);
    expect(ivs[2][0]).toBeCloseTo(78, 9);
    expect(ivs[3][1]).toBeCloseTo(92, 9);
  });

  it('punch hole splits the base interval; the ORIGINAL tool stays standalone', () => {
    const scene = sceneWith([
      rect('bar', 'electrode', 0, 0, '40', '10', { consumedBy: 'p1' }),
      rect('hole', 'electrode', 0, 0, '4', '20', { consumedBy: 'p1', cloneOf: 'tool1' }),
      rect('tool1', 'electrode', 0, 0, '4', '20'),
      {
        id: 'p1', kind: 'boolean', op: 'punch', operandIds: ['bar', 'hole'],
        layer: 'electrode', cx: 0, cy: 0, w: '0', h: '0', cutouts: [], transforms: [], label: '',
      },
      sectionLine('sec1', -60, 0, 60, 0),
    ]);
    const out = build(scene);
    expect(out.ok).toBe(true);
    const p = out.conductors.find((c) => c.id === 'p1');
    expect(p).toBeTruthy();
    expect(p.intervals).toHaveLength(2);
    expect(p.intervals[0].t0).toBeCloseTo(40, 9);
    expect(p.intervals[0].t1).toBeCloseTo(58, 9);
    expect(p.intervals[1].t0).toBeCloseTo(62, 9);
    expect(p.intervals[1].t1).toBeCloseTo(80, 9);
    // The original punch tool renders standalone (canvas parity) — its
    // own entry covers the punched gap.
    const t = out.conductors.find((c) => c.id === 'tool1');
    expect(t).toBeTruthy();
    expect(t.intervals[0].t0).toBeCloseTo(58, 9);
    expect(t.intervals[0].t1).toBeCloseTo(62, 9);
  });

  it('cutouts subtract from the owning instance', () => {
    const scene = sceneWith([
      rect('cc', 'electrode', 0, 0, '40', '10', {
        cutouts: [{ dx: '0', dy: '0', w: '4', h: '20' }],
      }),
      sectionLine('sec1', -60, 0, 60, 0),
    ]);
    const out = build(scene);
    const c = out.conductors.find((x) => x.id === 'cc');
    expect(c.intervals).toHaveLength(2);
    expect(c.intervals[0].t1).toBeCloseTo(58, 9);
    expect(c.intervals[1].t0).toBeCloseTo(62, 9);
  });
});

// ── Parametric exprs: round-trip + sweep parity (gold standard) ────────
describe('buildCrossSection — parametric t exprs', () => {
  const mkScene = (gapExpr) => sceneWith([
    rect('ref', 'electrode', -20, 0, '10', '200'),
    rect('c2', 'electrode', 0, 0, '10', '200'),
    sectionLine('sec1', -60, 0, 60, 0),
  ], {
    params: { gap: { expr: gapExpr, unit: 'µm', desc: 'test gap' } },
    snaps: [{ id: 's1', from: { compId: 'ref', anchor: 'E' }, to: { compId: 'c2', anchor: 'W' }, dx: 'gap', dy: '0' }],
  });

  it('snapped conductor gets a t0Expr that reproduces the numeric t0', () => {
    const scene = mkScene('5');
    const pv = pvOf(scene);
    const out = build(scene);
    const c2 = out.conductors.find((c) => c.id === 'c2');
    // ref.E = -15; c2.W = -15 + gap ⇒ x ∈ [-10, 0] ⇒ t ∈ [50, 60].
    expect(c2.intervals[0].t0).toBeCloseTo(50, 9);
    expect(c2.intervals[0].t1).toBeCloseTo(60, 9);
    expect(typeof c2.intervals[0].t0Expr).toBe('string');
    expect(/um$/.test(c2.intervals[0].t0Expr)).toBe(true);
    expect(evalExpr(c2.intervals[0].t0Expr, pv)).toBeCloseTo(c2.intervals[0].t0, 6);
    expect(evalExpr(c2.intervals[0].t1Expr, pv)).toBeCloseTo(c2.intervals[0].t1, 6);
    // The referenced param is surfaced in `params`.
    expect(out.params.gap).toBe(5);
  });

  it('SWEEP PARITY: exprs built at gap=5 re-evaluate at gap=9 to a fresh build', () => {
    const sceneA = mkScene('5');
    const sceneB = mkScene('9');
    const outA = build(sceneA);
    const outB = build(sceneB);
    const pvB = pvOf(sceneB);
    const a = outA.conductors.find((c) => c.id === 'c2');
    const b = outB.conductors.find((c) => c.id === 'c2');
    expect(b.intervals[0].t0).toBeCloseTo(54, 9);
    expect(evalExpr(a.intervals[0].t0Expr, pvB)).toBeCloseTo(b.intervals[0].t0, 6);
    expect(evalExpr(a.intervals[0].t1Expr, pvB)).toBeCloseTo(b.intervals[0].t1, 6);
  });

  it('SWEEP PARITY: slab/conductor z exprs track a stack-thickness change', () => {
    const sceneA = mkScene('5');
    const sceneB = sceneWith(sceneA.components, {
      params: {
        gap: { expr: '5', unit: 'µm' },
        h_wg: { expr: '0.9', unit: 'µm', desc: 'WG total height' },
      },
      snaps: sceneA.snaps,
    });
    const outA = build(sceneA);
    const outB = build(sceneB);
    const pvB = pvOf(sceneB);
    const wgId = sceneA.stack.find((l) => l.role === 'waveguide').id;
    const slabA = outA.slabs.find((s) => s.layerId === wgId);
    const slabB = outB.slabs.find((s) => s.layerId === wgId);
    expect(slabB.z1).toBeCloseTo(0.9, 9);
    expect(evalExpr(slabA.z1Expr, pvB)).toBeCloseTo(slabB.z1, 6);
    // Conductor Z rides the same walk (coplanar group bottom).
    const cA = outA.conductors[0];
    const cB = outB.conductors[0];
    expect(evalExpr(cA.z1Expr, pvB)).toBeCloseTo(cB.z1, 6);
  });

  it('repeat replicas carry per-replica edge exprs', () => {
    const scene = sceneWith([
      rect('bar', 'electrode', 0, 0, 'bar_w', '40', {
        transforms: [{ id: 't1', kind: 'repeat', enabled: true, n: '1', dx: 'pitch', dy: '0', includeOriginal: true }],
      }),
      sectionLine('sec1', -60, 0, 60, 0),
    ], {
      params: {
        bar_w: { expr: '4', unit: 'µm' },
        pitch: { expr: '20', unit: 'µm' },
      },
    });
    const pv = pvOf(scene);
    const out = build(scene);
    const bar = out.conductors.find((c) => c.id === 'bar');
    expect(bar.intervals).toHaveLength(2);
    // Replica interval [t 78, 82] — expr must reference pitch and round-trip.
    expect(typeof bar.intervals[1].t0Expr).toBe('string');
    expect(bar.intervals[1].t0Expr).toMatch(/pitch/);
    expect(evalExpr(bar.intervals[1].t0Expr, pv)).toBeCloseTo(78, 6);
    // Sweep the pitch: expr re-evaluates to the fresh-build position.
    const scene2 = sceneWith(scene.components, {
      params: {
        bar_w: { expr: '4', unit: 'µm' },
        pitch: { expr: '26', unit: 'µm' },
      },
    });
    const out2 = build(scene2);
    const bar2 = out2.conductors.find((c) => c.id === 'bar');
    expect(evalExpr(bar.intervals[1].t0Expr, pvOf(scene2))).toBeCloseTo(bar2.intervals[1].t0, 6);
  });
});

// ── Folded (meander-like) union boolean: repeat + rotate180 + mirror ────
// A zero-thickness conductor built as a UNION of axis-aligned rects with a
// repeat(Y) + rotate180(pivot C) + duplicate_mirror(axis x) chain — the KI
// meander's exact fold family. The CROSS AXIS (horizontal, ⟂ the vertical
// fold motion) must parametrize AND sweep-parity-match a fresh build at
// perturbed CELL-PERIOD params; the ALONG-FOLD axis (vertical) bakes the
// pivot-parallel endpoints (the frozen-fold caveat) — never emitting a WRONG
// expr (numeric stays exact).
describe('buildCrossSection — folded meander union (rotate180 + mirror)', () => {
  // Two vertical bars 10 µm apart form one "cell"; repeat 3× along +Y, fold
  // the cluster 180° about its centroid, then mirror-duplicate across a
  // vertical plane. Zero-thickness conductor (h_cond=0) — the KI regime.
  const meanderScene = (cellW, cellS) => sceneWith([
    rect('mA', 'electrode', 0, 0, 'bar_w', 'cell_w', { consumedBy: 'mnd', conductorLayerId: 'l_cond' }),
    rect('mB', 'electrode', 12, 0, 'bar_w', 'cell_w', { consumedBy: 'mnd', conductorLayerId: 'l_cond' }),
    {
      id: 'mnd', kind: 'boolean', op: 'union', operandIds: ['mA', 'mB'],
      layer: 'electrode', cx: 0, cy: 0, w: '0', h: '0', cutouts: [], label: 'Meander',
      conductorLayerId: 'l_cond',
      transforms: [
        { id: 'r1', kind: 'repeat', enabled: true, n: '2', dx: '0', dy: '(cell_w) + (cell_s)', includeOriginal: true },
        { id: 'rot', kind: 'rotate', enabled: true, angle: '180', pivot: 'C' },
        { id: 'dm', kind: 'duplicate_mirror', enabled: true, axis: 'x', offset: '40', includeOriginal: true },
      ],
    },
    sectionLine('sec1', -80, 0, 200, 0),   // HORIZONTAL cut (crosses the bars)
  ], {
    params: {
      bar_w: { expr: '2', unit: 'µm' },
      cell_w: { expr: String(cellW), unit: 'µm', desc: 'cell period along the fold' },
      cell_s: { expr: String(cellS), unit: 'µm', desc: 'cell spacing' },
      h_cond: { expr: '0', unit: 'µm', desc: 'zero-thickness conductor' },
    },
  });

  it('HORIZONTAL cut: the folded union parametrizes (t0Expr/t1Expr present, round-trip)', () => {
    const scene = meanderScene(37.5, 2);
    const pv = pvOf(scene);
    const out = build(scene);
    const m = out.conductors.find((c) => c.id === 'mnd');
    expect(m).toBeTruthy();
    expect(m.zeroThickness).toBe(true);
    // At least one interval endpoint carries a round-tripping expr — the fold
    // is parametric across the cross axis (BEFORE this feature it was 0).
    const par = m.intervals.flatMap((iv) => [iv.t0Expr, iv.t1Expr]).filter(Boolean);
    expect(par.length).toBeGreaterThan(0);
    for (const iv of m.intervals) {
      if (iv.t0Expr) expect(evalExpr(iv.t0Expr, pv)).toBeCloseTo(iv.t0, 6);
      if (iv.t1Expr) expect(evalExpr(iv.t1Expr, pv)).toBeCloseTo(iv.t1, 6);
    }
  });

  it('SWEEP PARITY: horizontal fold exprs re-evaluate to a fresh build at bumped cell period', () => {
    const base = meanderScene(37.5, 2);
    const fresh = meanderScene(38.2, 2.3); // cell_w +0.7, cell_s +0.3 (KI acceptance)
    const outA = build(base);
    const outB = build(fresh);
    const pvB = pvOf(fresh);
    const a = outA.conductors.find((c) => c.id === 'mnd');
    const b = outB.conductors.find((c) => c.id === 'mnd');
    const freshEnds = b.intervals.flatMap((iv) => [iv.t0, iv.t1]);
    let checked = 0;
    for (const iv of a.intervals) {
      for (const key of ['t0', 't1']) {
        const expr = iv[`${key}Expr`];
        if (!expr) continue; // baked exempt
        checked += 1;
        const v = evalExpr(expr, pvB);
        const near = freshEnds.reduce((best, e) => (Math.abs(e - v) < Math.abs(best - v) ? e : best), freshEnds[0]);
        expect(Math.abs(v - near)).toBeLessThan(1e-4); // sweep-parity contract
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('ALONG-FOLD (vertical) cut: pivot-parallel endpoints BAKE (never wrong), caveat warned', () => {
    // Same cluster, but a VERTICAL section line through a bar column — the
    // fold pivot Y drifts with cell period, so those endpoints must bake.
    const scene = meanderScene(37.5, 2);
    // Replace the section line with a vertical one through the mA column (x≈0).
    const comps = scene.components.filter((c) => c.id !== 'sec1');
    comps.push(sectionLine('sec1', 0, -80, 0, 200));
    const vScene = sceneWith(comps, {
      params: {
        bar_w: { expr: '2', unit: 'µm' },
        cell_w: { expr: '37.5', unit: 'µm' },
        cell_s: { expr: '2', unit: 'µm' },
        h_cond: { expr: '0', unit: 'µm' },
      },
    });
    const out = build(vScene);
    const m = out.conductors.find((c) => c.id === 'mnd');
    if (m) {
      // Sweep parity holds for whatever DID parametrize; the frozen ones are
      // numeric (never wrong). Confirm no emitted expr is WRONG under a sweep.
      const fresh = build(sceneWith(vScene.components, {
        params: {
          bar_w: { expr: '2', unit: 'µm' },
          cell_w: { expr: '38.2', unit: 'µm' },
          cell_s: { expr: '2.3', unit: 'µm' },
          h_cond: { expr: '0', unit: 'µm' },
        },
      }));
      const fm = fresh.conductors.find((c) => c.id === 'mnd');
      const fEnds = fm ? fm.intervals.flatMap((iv) => [iv.t0, iv.t1]) : [];
      const pvF = pvOf(sceneWith(vScene.components, {
        params: {
          bar_w: { expr: '2', unit: 'µm' }, cell_w: { expr: '38.2', unit: 'µm' },
          cell_s: { expr: '2.3', unit: 'µm' }, h_cond: { expr: '0', unit: 'µm' },
        },
      }));
      for (const iv of m.intervals) {
        for (const key of ['t0', 't1']) {
          const expr = iv[`${key}Expr`];
          if (!expr) continue;
          const v = evalExpr(expr, pvF);
          const near = fEnds.reduce((best, e) => (Math.abs(e - v) < Math.abs(best - v) ? e : best), fEnds[0] ?? v);
          expect(Math.abs(v - near)).toBeLessThan(1e-4);
        }
      }
      // At least one endpoint baked → the frozen-fold caveat fired.
      const anyBaked = m.intervals.some((iv) => !iv.t0Expr || !iv.t1Expr);
      if (anyBaked) {
        expect(out.warnings.some((w) => w.code === 'frozen-fold')).toBe(true);
      }
    }
  });

  it('never emits a WRONG parametric expr (round-trip guard holds at base)', () => {
    const scene = meanderScene(37.5, 2);
    const pv = pvOf(scene);
    const out = build(scene);
    for (const c of out.conductors) {
      for (const iv of c.intervals) {
        if (iv.t0Expr) expect(evalExpr(iv.t0Expr, pv)).toBeCloseTo(iv.t0, 6);
        if (iv.t1Expr) expect(evalExpr(iv.t1Expr, pv)).toBeCloseTo(iv.t1, 6);
      }
    }
  });

  // REGRESSION (the parametric-but-WRONG bug): a fold whose PIVOT drifts under
  // a cross-section-SHAPE param (not just the cell period). The baked pivot is
  // then stale under that sweep, so EVERY fold expr must BAKE (frozen-fold),
  // NOT emit a wrong parametric value. The gate probes ALL params, so a
  // pivot-moving shape param is no longer exempt. Here mB sits at 12 + `skew`,
  // so the union-bbox centre = 6 + skew/2 DRIFTS with skew.
  const skewMeander = (skew) => sceneWith([
    rect('mA', 'electrode', 0, 0, 'bar_w', 'cell_w', { consumedBy: 'mnd', conductorLayerId: 'l_cond' }),
    rect('mB', 'electrode', 12, 0, 'bar_w', 'cell_w', { consumedBy: 'mnd', conductorLayerId: 'l_cond', cxExpr: '12 + skew' }),
    {
      id: 'mnd', kind: 'boolean', op: 'union', operandIds: ['mA', 'mB'],
      layer: 'electrode', cx: 0, cy: 0, w: '0', h: '0', cutouts: [], label: 'Meander',
      conductorLayerId: 'l_cond',
      transforms: [
        { id: 'r1', kind: 'repeat', enabled: true, n: '2', dx: '0', dy: '(cell_w) + (cell_s)', includeOriginal: true },
        { id: 'rot', kind: 'rotate', enabled: true, angle: '180', pivot: 'C' },
        { id: 'dm', kind: 'duplicate_mirror', enabled: true, axis: 'x', offset: '40', includeOriginal: true },
      ],
    },
    sectionLine('sec1', -80, 0, 200, 0),
  ], {
    params: {
      bar_w: { expr: '2', unit: 'µm' },
      cell_w: { expr: '37.5', unit: 'µm' },
      cell_s: { expr: '2', unit: 'µm' },
      skew: { expr: String(skew), unit: 'µm', desc: 'shifts one bar → moves the fold pivot' },
      h_cond: { expr: '0', unit: 'µm' },
    },
  });

  it('a fold pivot that DRIFTS under a shape param → sweep-parity holds (wrong exprs BAKE)', () => {
    const base = skewMeander(0);
    const fresh = skewMeander(0.9); // shift a bar → the rotate-180 pivot moves
    const a = build(base).conductors.find((c) => c.id === 'mnd');
    const b = build(fresh).conductors.find((c) => c.id === 'mnd');
    const pvB = pvOf(fresh);
    const freshEnds = b.intervals.flatMap((iv) => [iv.t0, iv.t1]);
    // EVERY emitted expr must still land on a fresh endpoint under the skew
    // sweep — the whole point of the fix. (Before it, fold exprs carried a
    // stale pivot and missed by ~skew.) Baked endpoints are exempt.
    for (const iv of a.intervals) {
      for (const key of ['t0', 't1']) {
        const expr = iv[`${key}Expr`];
        if (!expr) continue;
        const v = evalExpr(expr, pvB);
        const near = freshEnds.reduce((best, e) => (Math.abs(e - v) < Math.abs(best - v) ? e : best), freshEnds[0]);
        expect(Math.abs(v - near)).toBeLessThan(1e-3);
      }
    }
  });
});

// ── Waveguide rib: parametric slab-band + core-trapezoid t/z exprs ──────
describe('buildCrossSection — parametric waveguide exprs', () => {
  const wgScene = (wWg, hSlab) => sceneWith([
    rect('wg1', 'waveguide', 0, 0, 'w_wg', '200'),
    sectionLine('sec1', -30, 0, 30, 0), // ⟂ the vertical guide
  ], {
    params: {
      w_wg: { expr: String(wWg), unit: 'µm' },
      h_slab: { expr: String(hSlab), unit: 'µm' },
    },
  });

  it('rib slab-band + core carry t and z exprs that round-trip', () => {
    const scene = wgScene(1.2, 0.1);
    const pv = pvOf(scene);
    const out = build(scene);
    const w = out.waveguides[0];
    expect(w).toBeTruthy();
    // slab band t + z
    expect(w.slabBand).toBeTruthy();
    const sb = w.slabBand;
    expect(typeof sb.intervals[0].t0Expr).toBe('string');
    expect(typeof sb.intervals[0].t1Expr).toBe('string');
    expect(evalExpr(sb.intervals[0].t0Expr, pv)).toBeCloseTo(sb.intervals[0].t0, 6);
    expect(evalExpr(sb.intervals[0].t1Expr, pv)).toBeCloseTo(sb.intervals[0].t1, 6);
    expect(evalExpr(sb.z0Expr, pv)).toBeCloseTo(sb.z0, 6);
    expect(evalExpr(sb.z1Expr, pv)).toBeCloseTo(sb.z1, 6);
    // core trapezoid corners + z
    const sg = w.core.segments[0];
    for (const f of ['botT0', 'botT1', 'topT0', 'topT1']) {
      expect(typeof sg[`${f}Expr`]).toBe('string');
      expect(evalExpr(sg[`${f}Expr`], pv)).toBeCloseTo(sg[f], 6);
    }
    expect(evalExpr(w.core.zBotExpr, pv)).toBeCloseTo(w.core.zBot, 6);
    expect(evalExpr(w.core.zTopExpr, pv)).toBeCloseTo(w.core.zTop, 6);
  });

  it('SWEEP PARITY: wg exprs track a core-width + slab-height sweep', () => {
    const base = wgScene(1.2, 0.1);
    const fresh = wgScene(1.6, 0.16);
    const outA = build(base);
    const outB = build(fresh);
    const pvB = pvOf(fresh);
    const a = outA.waveguides[0];
    const b = outB.waveguides[0];
    // slab band
    expect(evalExpr(a.slabBand.intervals[0].t0Expr, pvB)).toBeCloseTo(b.slabBand.intervals[0].t0, 4);
    expect(evalExpr(a.slabBand.intervals[0].t1Expr, pvB)).toBeCloseTo(b.slabBand.intervals[0].t1, 4);
    expect(evalExpr(a.slabBand.z1Expr, pvB)).toBeCloseTo(b.slabBand.z1, 4);
    // core corners (bottom widens with h_slab shrink; top = core width)
    const sa = a.core.segments[0];
    const sb2 = b.core.segments[0];
    for (const f of ['botT0', 'botT1', 'topT0', 'topT1']) {
      expect(evalExpr(sa[`${f}Expr`], pvB)).toBeCloseTo(sb2[f], 4);
    }
    expect(evalExpr(a.core.zBotExpr, pvB)).toBeCloseTo(b.core.zBot, 4);
  });

  it('oblique line omits wg exprs (numeric only)', () => {
    const scene = sceneWith([
      rect('wg1', 'waveguide', 0, 0, 'w_wg', '200'),
      sectionLine('sec1', -30, -30, 30, 30),
    ]);
    const out = build(scene);
    const w = out.waveguides[0];
    if (w && w.slabBand) {
      expect(w.slabBand.intervals[0].t0Expr).toBeUndefined();
      expect(w.core.segments[0].botT0Expr).toBeUndefined();
    }
  });
});

// ── Oblique line ───────────────────────────────────────────────────────
describe('buildCrossSection — oblique line', () => {
  const scene = sceneWith([
    rect('sq', 'electrode', 0, 0, '10', '10'),
    sectionLine('sec1', -20, -20, 20, 20),
  ]);
  const out = build(scene);

  it('axis null + oblique-numeric warning, exprs omitted, numerics exact', () => {
    expect(out.ok).toBe(true);
    expect(out.line.axis).toBeNull();
    expect(out.line.lengthUm).toBeCloseTo(40 * Math.SQRT2, 9);
    expect(out.warnings.some((w) => w.code === 'oblique-numeric')).toBe(true);
    const sq = out.conductors.find((c) => c.id === 'sq');
    expect(sq.intervals[0].t1 - sq.intervals[0].t0).toBeCloseTo(10 * Math.SQRT2, 6);
    expect(sq.intervals[0].t0).toBeCloseTo(15 * Math.SQRT2, 6);
    expect(sq.intervals[0].t0Expr).toBeUndefined();
    expect(sq.z0Expr).toBeUndefined();
    for (const s of out.slabs) {
      expect(s.z0Expr).toBeUndefined();
      expect(s.z1Expr).toBeUndefined();
    }
  });
});

// ── Zero-thickness conductor ───────────────────────────────────────────
describe('buildCrossSection — zero-thickness conductor', () => {
  it('h_cond = 0 → zeroThickness, z1 === z0', () => {
    const scene = sceneWith([
      rect('sig', 'electrode', 0, 0, '10', '200'),
      sectionLine('sec1', -60, 0, 60, 0),
    ], { params: { h_cond: { expr: '0', unit: 'µm', desc: 'Conductor thickness' } } });
    const out = build(scene);
    const c = out.conductors.find((x) => x.id === 'sig');
    expect(c.zeroThickness).toBe(true);
    expect(c.z1).toBe(c.z0);
    expect(c.areaUm2).toBe(0);
  });
});

// ── Skips + warnings: section line, ports, bridges, vias ───────────────
describe('buildCrossSection — non-physical / unsliceable components', () => {
  const scene = sceneWith([
    rect('sig', 'electrode', 0, 0, '10', '200'),
    rect('pt1', 'port', 20, 0, '5', '5'),
    { id: 'br1', kind: 'bridge', layer: 'bridge', cx: -20, cy: 0, w: '0', h: '0', cutouts: [], transforms: [] },
    { id: 'v1', kind: 'via', layer: 'via', cx: 40, cy: 0, r: '2', w: '', h: '', cutouts: [], transforms: [] },
    sectionLine('sec1', -60, 0, 60, 0),
    sectionLine('sec_other', -60, 5, 60, 5),
  ]);
  const out = build(scene);

  it('only the electrode lands in conductors', () => {
    expect(out.ok).toBe(true);
    expect(out.conductors.map((c) => c.id)).toEqual(['sig']);
  });

  it('bridge + via crossings push warnings; ports and section lines are silent', () => {
    expect(out.warnings.some((w) => w.code === 'bridge-crossed' && /br1/.test(w.msg))).toBe(true);
    expect(out.warnings.some((w) => w.code === 'via-crossed' && /v1/.test(w.msg))).toBe(true);
    expect(out.warnings.some((w) => /pt1|sec1|sec_other/.test(w.msg))).toBe(false);
  });

  it('an uncrossed bridge stays silent', () => {
    const s2 = sceneWith([
      rect('sig', 'electrode', 0, 0, '10', '200'),
      { id: 'br2', kind: 'bridge', layer: 'bridge', cx: 0, cy: 300, w: '0', h: '0', cutouts: [], transforms: [] },
      sectionLine('sec1', -60, 0, 60, 0),
    ]);
    const o2 = build(s2);
    expect(o2.warnings.some((w) => w.code === 'bridge-crossed')).toBe(false);
  });
});

// ── Unusable input → ok:false ──────────────────────────────────────────
describe('buildCrossSection — error gates', () => {
  it('missing section component', () => {
    const scene = sceneWith([rect('sig', 'electrode', 0, 0, '10', '10')]);
    const out = buildCrossSection(scene, pvOf(scene), 'nope');
    expect(out.ok).toBe(false);
    expect(typeof out.error).toBe('string');
  });

  it('wrong component kind/layer', () => {
    const scene = sceneWith([rect('sig', 'electrode', 0, 0, '10', '10')]);
    const out = buildCrossSection(scene, pvOf(scene), 'sig');
    expect(out.ok).toBe(false);
  });

  it('degenerate (zero-length) line', () => {
    const scene = sceneWith([sectionLine('sec1', 5, 5, 5, 5)]);
    const out = build(scene);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/degenerate/i);
  });

  it('vertical line works (axis v)', () => {
    const scene = sceneWith([
      rect('sig', 'electrode', 0, 0, '200', '10'),
      sectionLine('sec1', 0, -60, 0, 60),
    ]);
    const out = build(scene);
    expect(out.ok).toBe(true);
    expect(out.line.axis).toBe('v');
    const c = out.conductors.find((x) => x.id === 'sig');
    expect(c.intervals[0].t0).toBeCloseTo(55, 9);
    expect(c.intervals[0].t1).toBeCloseTo(65, 9);
    expect(evalExpr(c.intervals[0].t0Expr, pvOf(scene))).toBeCloseTo(55, 6);
  });
});
