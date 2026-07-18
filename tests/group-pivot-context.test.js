// pivot:'group' needs the FULL component pool. Many consumers expand a
// SINGLE component (expandTransforms([c], pv)) — without the pool the
// sibling lookup collapsed to the component itself and the rotation
// silently degraded to rotate-about-own-center: a grouped+rotated balun
// LOOKED right on canvas (full-array expansion) while the solver's
// snap-to-instance branch and every numeric exporter placed members at
// un-translated poses (real user bug: snapping to the rotated CPS feed
// landed the child at the pre-rotation position).
import { describe, it, expect } from 'vitest';
import { normalizeScene } from '../src/scene/schema.js';
import { resolveParams, evalExpr } from '../src/scene/params.js';
import { solveLayout } from '../src/scene/solver.js';
import { expandTransforms } from '../src/scene/transforms.js';
import { resolveInstanceAnchorNumeric } from '../src/scene/instance-positions.js';
import { generateHfssNative } from '../src/export/hfss-native.js';
import { generateGDS } from '../src/export/gds.js';

const ROT = [{ id: 't1', kind: 'rotate', enabled: true, angle: '90', pivot: 'group' }];
const mkScene = () => normalizeScene({
  params: { L1: { expr: '100', unit: 'µm' } },
  components: [
    { transforms: [...ROT], id: 'ga', kind: 'rect', layer: 'electrode', cx: 0, cy: 0, w: 'L1', h: '20', cutouts: [], group: 'g1' },
    { transforms: [...ROT], id: 'gb', kind: 'rect', layer: 'electrode', cx: 200, cy: 0, w: 'L1', h: '20', cutouts: [], group: 'g1' },
    { transforms: [...ROT], id: 'gc', kind: 'rect', layer: 'electrode', cx: 100, cy: 80, w: '40', h: '40', cutouts: [], group: 'g1' },
  ],
  snaps: [],
  groups: [{ id: 'grp1', name: 'g1', memberIds: ['ga', 'gb', 'gc'], aliases: {} }],
});

describe('expandTransforms group-pivot pool', () => {
  it('subset expansion with the pool matches the full expansion exactly', () => {
    const scene = mkScene();
    const pv = resolveParams(scene.params).values;
    const solved = solveLayout(scene.components, scene.snaps, pv);
    const full = expandTransforms(solved, pv);
    for (const c of solved) {
      const one = expandTransforms([c], pv, solved)[0];
      const ref = full.find(i => i.compId === c.id && i.idx === 0);
      expect(one.cx).toBeCloseTo(ref.cx, 9);
      expect(one.cy).toBeCloseTo(ref.cy, 9);
      expect(one.rotation || 0).toBeCloseTo(ref.rotation || 0, 9);
    }
    // And WITHOUT the pool, the group centroid genuinely degrades (the
    // bug this guards): position must differ for off-centroid members.
    const ga = solved.find(c => c.id === 'ga');
    const degraded = expandTransforms([ga], pv)[0];
    const ref = full.find(i => i.compId === 'ga' && i.idx === 0);
    expect(Math.hypot(degraded.cx - ref.cx, degraded.cy - ref.cy)).toBeGreaterThan(1);
  });

  it('solver: snap onto a group-rotated instance anchor lands at the RENDERED pose', () => {
    const scene = mkScene();
    scene.components.push({ transforms: [], id: 'child', kind: 'rect', layer: 'electrode', cx: 0, cy: 0, w: '10', h: '10', cutouts: [] });
    scene.snaps.push({ id: 's1', from: { compId: 'ga', anchor: 'SE', instanceIdx: 0 }, to: { compId: 'child', anchor: 'NW' }, dx: '0', dy: '0' });
    const pv = resolveParams(scene.params).values;
    const solved = solveLayout(scene.components, scene.snaps, pv);
    const byId = Object.fromEntries(solved.map(c => [c.id, c]));
    const insts = expandTransforms(solved, pv);
    const A = resolveInstanceAnchorNumeric('ga', 'SE', 0, byId, insts, pv);
    const child = solved.find(c => c.id === 'child');
    expect(child.cx - 5).toBeCloseTo(A.x, 6);
    expect(child.cy + 5).toBeCloseTo(A.y, 6);
  });

  it('HFSS: the snapped child position expr evaluates to the solver pose', () => {
    const scene = mkScene();
    scene.components.push({ transforms: [], id: 'child', kind: 'rect', layer: 'electrode', cx: 0, cy: 0, w: '10', h: '10', cutouts: [] });
    scene.snaps.push({ id: 's1', from: { compId: 'ga', anchor: 'SE', instanceIdx: 0 }, to: { compId: 'child', anchor: 'NW' }, dx: '0', dy: '0' });
    const pv = resolveParams(scene.params).values;
    const solved = solveLayout(scene.components, scene.snaps, pv);
    const child = solved.find(c => c.id === 'child');
    const script = generateHfssNative(scene, pv, {});
    const hdr = script.indexOf('Name:=", "child"');
    expect(hdr).toBeGreaterThan(0);
    const blk = script.slice(Math.max(0, hdr - 60000), hdr);
    const ms = [...blk.matchAll(/"X(?:Start|Position):=", "((?:[^"\\]|\\.)+)", "Y(?:Start|Position):=", "((?:[^"\\]|\\.)+)", "Z/g)];
    const mm = ms[ms.length - 1];
    const strip = (x) => x.replace(/\*\s*1um\b/g, '*1').replace(/(\d|\))\s*um\b/g, '$1');
    expect(evalExpr(strip(mm[1]), pv)).toBeCloseTo(child.cx - 5, 3);
    expect(evalExpr(strip(mm[2]), pv)).toBeCloseTo(child.cy - 5, 3);
  });

  it('GDS: a group-rotated member emits at its rendered position', () => {
    const scene = mkScene();
    const pv = resolveParams(scene.params).values;
    const solved = solveLayout(scene.components, scene.snaps, pv);
    const insts = expandTransforms(solved, pv);
    const ref = insts.find(i => i.compId === 'ga' && i.idx === 0);
    const bytes = generateGDS(scene, pv);
    // Parse XY records crudely: collect all 4-byte ints, find a coordinate
    // pair near the rendered center (GDS unit = nm).
    const dv = new DataView(bytes.buffer || bytes);
    let found = false;
    for (let o = 0; o + 8 <= dv.byteLength; o += 2) {
      const x = dv.getInt32(o) / 1000, y = dv.getInt32(o + 4) / 1000;
      if (Math.abs(x - ref.cx) < ref.w && Math.abs(y - ref.cy) < ref.w) { found = true; break; }
    }
    expect(found).toBe(true);
  });
});

describe('adversarial-review regressions', () => {
  it('solver centroid uses IN-SOLVE sibling positions (not stale raw cx/cy)', () => {
    // Sibling B is snap-positioned: raw cx/cy is garbage (999,999); the
    // solver moves it to (10,0)-ish. The group centroid for A's rotate
    // must use the SOLVED B, or the snapped child C lands ~1000 um off
    // (the critical review find: raw `components` passed as the pool).
    const scene = normalizeScene({
      params: {},
      components: [
        { transforms: [{ id: 't', kind: 'rotate', enabled: true, angle: '90', pivot: 'group' }], id: 'A', kind: 'rect', layer: 'electrode', cx: 100, cy: 50, w: '40', h: '20', cutouts: [], group: 'g1' },
        { transforms: [{ id: 't', kind: 'rotate', enabled: true, angle: '90', pivot: 'group' }], id: 'B', kind: 'rect', layer: 'electrode', cx: 999, cy: 999, w: '40', h: '20', cutouts: [], group: 'g1' },
        { transforms: [], id: 'Rf', kind: 'rect', layer: 'electrode', cx: 10, cy: 0, w: '20', h: '20', cutouts: [] },
        { transforms: [], id: 'C', kind: 'rect', layer: 'electrode', cx: 0, cy: 0, w: '10', h: '10', cutouts: [] },
      ],
      snaps: [
        { id: 's1', from: { compId: 'Rf', anchor: 'C' }, to: { compId: 'B', anchor: 'C' }, dx: '0', dy: '0' },
        { id: 's2', from: { compId: 'A', anchor: 'SE', instanceIdx: 0 }, to: { compId: 'C', anchor: 'NW' }, dx: '0', dy: '0' },
      ],
      groups: [{ id: 'grp1', name: 'g1', memberIds: ['A', 'B'], aliases: {} }],
    });
    const pv = resolveParams(scene.params).values;
    const solved = solveLayout(scene.components, scene.snaps, pv);
    const byId = Object.fromEntries(solved.map(c => [c.id, c]));
    const insts = expandTransforms(solved, pv);       // canvas truth (solved pool)
    const A = resolveInstanceAnchorNumeric('A', 'SE', 0, byId, insts, pv);
    const C = solved.find(c => c.id === 'C');
    expect(C.cx - 5).toBeCloseTo(A.x, 5);
    expect(C.cy + 5).toBeCloseTo(A.y, 5);
  });

  it('instantiateCell remaps the group tag per instance (no merged centroids)', async () => {
    const { makeCellFromSelection, instantiateCell } = await import('../src/scene/cells.js');
    const scene = normalizeScene({
      params: {},
      components: [
        { transforms: [{ id: 't', kind: 'rotate', enabled: true, angle: '90', pivot: 'group' }], id: 'A', kind: 'rect', layer: 'electrode', cx: 0, cy: 0, w: '40', h: '20', cutouts: [], group: 'g1' },
        { transforms: [{ id: 't', kind: 'rotate', enabled: true, angle: '90', pivot: 'group' }], id: 'B', kind: 'rect', layer: 'electrode', cx: 100, cy: 0, w: '40', h: '20', cutouts: [], group: 'g1' },
      ],
      snaps: [],
      groups: [{ id: 'grp1', name: 'g1', memberIds: ['A', 'B'], aliases: {} }],
    });
    const def = makeCellFromSelection(scene, new Set(['A', 'B']), 'cellX').def
      || makeCellFromSelection(scene, new Set(['A', 'B']), 'cellX');
    const i1 = instantiateCell(def, 'u1', {}, 0, 0);
    const i2 = instantiateCell(def, 'u2', {}, 500, 0);
    for (const c of i1.components) expect(c.group).toBe('u1_g1');
    for (const c of i2.components) expect(c.group).toBe('u2_g1');
    // Two instances expanded together: each rotates about ITS OWN centroid.
    const all = [...i1.components, ...i2.components];
    const pv = {};
    const insts = expandTransforms(all, pv);
    const a1 = insts.find(i => i.compId === 'u1_A' && i.idx === 0);
    const a2 = insts.find(i => i.compId === 'u2_A' && i.idx === 0);
    const c1 = all.filter(c => c.group === 'u1_g1');
    const gx1 = (c1[0].cx + c1[1].cx) / 2, gy1 = (c1[0].cy + c1[1].cy) / 2;
    // u1_A rotated 90 about u1's centroid only:
    const src = all.find(c => c.id === 'u1_A');
    const ex = gx1 - (src.cy - gy1), ey = gy1 + (src.cx - gx1);
    expect(a1.cx).toBeCloseTo(ex, 6);
    expect(a1.cy).toBeCloseTo(ey, 6);
    expect(Math.hypot(a1.cx - a2.cx, a1.cy - a2.cy)).toBeGreaterThan(100); // instances independent
  });
});
