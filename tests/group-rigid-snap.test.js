// GROUP-RIGID SNAP: a snap whose CHILD is a group member with a transform
// chain that MOVES its instance-0 base (rotate pivot:'group') must
// (1) land the child's RENDERED anchor on the target — not the invisible
//     base-frame anchor (the old behavior teleported the member to a
//     garbage pose), and
// (2) translate the WHOLE group rigidly — moving one member alone shifts
//     the pivot centroid every other member rotates about, warping the
//     assembly (the "shape in the group deforms" bug, KI_lumped balun).
// The HFSS export mirrors the same decomposition parametrically via
// grp_rigid_<group>_dx/dy design variables. Legacy patterns (unmoved-base
// chains like an IDC repeat, intra-group snap chains) keep their old
// per-member semantics BYTE-EXACT — the rigid gate requires both a
// chain-moved base AND an external parent.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { normalizeScene } from '../src/scene/schema.js';
import { resolveParams, evalExpr } from '../src/scene/params.js';
import { solveLayout, getLastSolveDiagnostics } from '../src/scene/solver.js';
import { expandTransforms } from '../src/scene/transforms.js';
import { resolveInstanceAnchorNumeric } from '../src/scene/instance-positions.js';
import { anchorWorld } from '../src/scene/anchors.js';
import { computeParametricPositions, stripUnitsForGuard, generateHfssNative } from '../src/export/hfss-native.js';

const ROT_G = { id: 't1', kind: 'rotate', enabled: true, angle: '-90', pivot: 'group' };
const rect = (id, cx, cy, extra = {}) => ({
  transforms: [], id, kind: 'rect', layer: 'electrode', cx, cy, w: '20', h: '10', cutouts: [], ...extra,
});
const mkGroupScene = () => normalizeScene({
  params: { gL: { expr: '100', unit: 'µm' }, gOff: { expr: '30', unit: 'µm' } },
  components: [
    rect('m1', 0, 0,   { group: 'g', transforms: [{ ...ROT_G }], cxExpr: '0', cyExpr: '0' }),
    rect('m2', 100, 0, { group: 'g', transforms: [{ ...ROT_G }], cxExpr: 'gL', cyExpr: '0' }),
    rect('m3', 50, 40, { group: 'g', transforms: [{ ...ROT_G }] }), // no posExpr (numeric natural)
    rect('P', 300, 200, { w: 'gOff', h: '16' }),
  ],
  snaps: [{ id: 's1', from: { compId: 'P', anchor: 'S' }, to: { compId: 'm2', anchor: 'N' }, dx: '0', dy: '0' }],
  groups: [{ id: 'gg', name: 'g', memberIds: ['m1', 'm2', 'm3'], aliases: {} }],
});

const pose = (insts, id) => {
  const i = insts.find(x => x.compId === id && x.idx === 0);
  return [i.cx, i.cy, i.rotation || 0];
};

describe('solver: group-rigid snap child', () => {
  it('rendered anchor lands on the target and the group translates rigidly', () => {
    const scene = mkGroupScene();
    const pv = resolveParams(scene.params).values;
    // Baseline WITHOUT the snap: natural poses.
    const solved0 = solveLayout(scene.components, [], pv);
    const insts0 = expandTransforms(solved0, pv);
    const solved = solveLayout(scene.components, scene.snaps, pv);
    const insts = expandTransforms(solved, pv);
    // (1) rendered anchor of m2 exactly on P.S
    const byId = Object.fromEntries(solved.map(c => [c.id, c]));
    const pA = anchorWorld(byId.P, 'S', pv);
    const cA = resolveInstanceAnchorNumeric('m2', 'N', 0, byId, insts, pv);
    expect(Math.hypot(pA.x - cA.x, pA.y - cA.y)).toBeLessThan(1e-9);
    // (2) identical rendered delta for every member, zero rotation change
    const deltas = ['m1', 'm2', 'm3'].map(id => {
      const a = pose(insts0, id), b = pose(insts, id);
      return [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    });
    for (const d of deltas) {
      expect(d[0]).toBeCloseTo(deltas[0][0], 9);
      expect(d[1]).toBeCloseTo(deltas[0][1], 9);
      expect(d[2]).toBeCloseTo(0, 9);
    }
    // (3) deterministic across solves
    const solvedB = solveLayout(scene.components, scene.snaps, pv);
    for (let i = 0; i < solved.length; i++) {
      expect(solvedB[i].cx).toBeCloseTo(solved[i].cx, 12);
      expect(solvedB[i].cy).toBeCloseTo(solved[i].cy, 12);
    }
    expect(getLastSolveDiagnostics().issues.filter(x => x.kind === 'rigid-snap-singular')).toHaveLength(0);
  });

  it('constraint holds under a param sweep (assembly re-solves rigidly)', () => {
    const scene = mkGroupScene();
    const swept = { ...scene.params, gL: { ...scene.params.gL, expr: '140' } };
    const pv = resolveParams(swept).values;
    const solved = solveLayout(scene.components, scene.snaps, pv);
    const insts = expandTransforms(solved, pv);
    const byId = Object.fromEntries(solved.map(c => [c.id, c]));
    const pA = anchorWorld(byId.P, 'S', pv);
    const cA = resolveInstanceAnchorNumeric('m2', 'N', 0, byId, insts, pv);
    expect(Math.hypot(pA.x - cA.x, pA.y - cA.y)).toBeLessThan(1e-9);
  });

  it('ungrouped moved-base child: rendered anchor still lands on target', () => {
    const scene = normalizeScene({
      params: {},
      components: [
        rect('solo', 10, 20, { transforms: [{ id: 't', kind: 'displace', enabled: true, dx: '15', dy: '-5' }] }),
        rect('P', 200, 100),
      ],
      snaps: [{ id: 's1', from: { compId: 'P', anchor: 'W' }, to: { compId: 'solo', anchor: 'E' }, dx: '0', dy: '0' }],
    });
    const pv = {};
    const solved = solveLayout(scene.components, scene.snaps, pv);
    const insts = expandTransforms(solved, pv);
    const byId = Object.fromEntries(solved.map(c => [c.id, c]));
    const pA = anchorWorld(byId.P, 'W', pv);
    const cA = resolveInstanceAnchorNumeric('solo', 'E', 0, byId, insts, pv);
    expect(Math.hypot(pA.x - cA.x, pA.y - cA.y)).toBeLessThan(1e-9);
  });

  it('LEGACY: unmoved-base chains + intra-group snap chains are untouched', () => {
    // IDC-style: repeat (keeps base) + members snapped to EACH OTHER.
    const mk = (withGroup) => normalizeScene({
      params: { s: { expr: '25', unit: 'µm' } },
      components: [
        rect('a', 0, 0,  withGroup ? { group: 'idc', transforms: [{ id: 't', kind: 'repeat', enabled: true, n: '1', dx: 's', dy: '0', includeOriginal: true }] } : { transforms: [{ id: 't', kind: 'repeat', enabled: true, n: '1', dx: 's', dy: '0', includeOriginal: true }] }),
        rect('b', 99, 99, withGroup ? { group: 'idc', transforms: [{ id: 't', kind: 'repeat', enabled: true, n: '1', dx: 's', dy: '0', includeOriginal: true }] } : { transforms: [{ id: 't', kind: 'repeat', enabled: true, n: '1', dx: 's', dy: '0', includeOriginal: true }] }),
      ],
      snaps: [{ id: 's1', from: { compId: 'a', anchor: 'E' }, to: { compId: 'b', anchor: 'W' }, dx: '4', dy: '0' }],
      groups: withGroup ? [{ id: 'gi', name: 'idc', memberIds: ['a', 'b'], aliases: {} }] : [],
    });
    const pv = resolveParams(mk(true).params).values;
    const withG = solveLayout(mk(true).components, mk(true).snaps, pv);
    const withoutG = solveLayout(mk(false).components, mk(false).snaps, pv);
    for (let i = 0; i < withG.length; i++) {
      expect(withG[i].cx).toBeCloseTo(withoutG[i].cx, 12);
      expect(withG[i].cy).toBeCloseTo(withoutG[i].cy, 12);
    }
  });
});

describe('HFSS export: group-rigid parametric emission', () => {
  it('synthetic: member positions sweep-track via grp_rigid vars', () => {
    const scene = mkGroupScene();
    const basePV = resolveParams(scene.params).values;
    const solvedA = solveLayout(scene.components, scene.snaps, basePV);
    const meta = {};
    const pp = computeParametricPositions(solvedA, scene.snaps, basePV, meta);
    expect((meta.rigidVars || []).map(v => v.name)).toEqual(['grp_rigid_g_dx', 'grp_rigid_g_dy']);
    const swept = { ...scene.params, gL: { ...scene.params.gL, expr: '140' }, gOff: { ...scene.params.gOff, expr: '44' } };
    const pvS = resolveParams(swept).values;
    const pvR = { ...pvS };
    for (const rv of meta.rigidVars) pvR[rv.name] = evalExpr(stripUnitsForGuard(rv.expr), pvS);
    const solvedB = solveLayout(scene.components, scene.snaps, pvS);
    const byIdB = Object.fromEntries(solvedB.map(c => [c.id, c]));
    for (const id of ['m1', 'm2', 'm3', 'P']) {
      const e = pp[id];
      const gx = evalExpr(stripUnitsForGuard(e.cxExpr), pvR);
      const gy = evalExpr(stripUnitsForGuard(e.cyExpr), pvR);
      expect(Math.hypot(gx - byIdB[id].cx, gy - byIdB[id].cy), id).toBeLessThan(1e-5);
    }
  });

  it('user balun fixture: rigid snap stays sub-nm parametric under sweeps; script is sane', () => {
    const d = JSON.parse(fs.readFileSync(new URL('./fixtures/ki-lumped-balun.json', import.meta.url), 'utf8'));
    const scene = normalizeScene(d.scene);
    const userSnap = { id: 'user_snap', from: { compId: 'cond22_copy_copy_copy', anchor: 'S' }, to: { compId: 'dyb2_s0n_copy_copy', anchor: 'N' }, dx: '0', dy: '0' };
    const snaps2 = [...scene.snaps, userSnap];
    const basePV = resolveParams(scene.params).values;
    // ORIGINAL design (no rigid snap): parity must be EXACT (regression
    // guard — the cap group's IDC pattern must keep legacy semantics).
    {
      const solvedA = solveLayout(scene.components, scene.snaps, basePV);
      const pp = computeParametricPositions(solvedA, scene.snaps, basePV, {});
      const swept = { ...scene.params, cap_s: { ...scene.params.cap_s, expr: String((basePV.cap_s || 0) + 3) } };
      const pvS = resolveParams(swept).values;
      const solvedB = solveLayout(scene.components, scene.snaps, pvS);
      const byIdB = Object.fromEntries(solvedB.map(c => [c.id, c]));
      for (const c of solvedA) {
        const e = pp[c.id];
        const gx = evalExpr(stripUnitsForGuard(e.cxExpr), pvS);
        const gy = evalExpr(stripUnitsForGuard(e.cyExpr), pvS);
        expect(Math.hypot(gx - byIdB[c.id].cx, gy - byIdB[c.id].cy), c.id).toBeLessThan(1e-6);
      }
    }
    // WITH the user's snap: all 31 members rigid + sweep-parametric.
    const solvedA = solveLayout(scene.components, snaps2, basePV);
    const meta = {};
    const pp = computeParametricPositions(solvedA, snaps2, basePV, meta);
    expect((meta.rigidVars || []).length).toBe(2);
    for (const sw of [{ dyb2_Lo: 14 }, { feedZ0_L2: 7 }, { cap_s: 3 }]) {
      const swept = { ...scene.params };
      for (const [k, dv] of Object.entries(sw)) swept[k] = { ...scene.params[k], expr: String((basePV[k] || 0) + dv) };
      const pvS = resolveParams(swept).values;
      const pvR = { ...pvS };
      for (const rv of meta.rigidVars) pvR[rv.name] = evalExpr(stripUnitsForGuard(rv.expr), pvS);
      const solvedB = solveLayout(scene.components, snaps2, pvS);
      const byIdB = Object.fromEntries(solvedB.map(c => [c.id, c]));
      let worst = 0;
      for (const c of solvedA) {
        const e = pp[c.id];
        const gx = evalExpr(stripUnitsForGuard(e.cxExpr), pvR);
        const gy = evalExpr(stripUnitsForGuard(e.cyExpr), pvR);
        worst = Math.max(worst, Math.hypot(gx - byIdB[c.id].cx, gy - byIdB[c.id].cy));
      }
      expect(worst).toBeLessThan(1e-5);
    }
    // Script: bounded size (the inline form exploded to 60 MB), has the
    // rigid + pivot vars, and stays AEDT-clean (no unary plus).
    const scene2 = { ...scene, snaps: snaps2 };
    const script = generateHfssNative(scene2, basePV, {});
    expect(script.length).toBeLessThan(2_000_000);
    expect(script).toContain('set_var("grp_rigid_group2_dx"');
    expect(script).toContain('set_var("grp_pivot_group2_x"');
    expect(script).not.toMatch(/\(\+\(/);
    // AEDT lexes "- -1.0*(...)" as the illegal '--' operator (and "+ -"
    // fails the same way) — the δ trig coefficients must be emitted
    // parenthesized (real shipped import failure: the grp_rigid set_var
    // parse-failed and every member position cascaded).
    expect(script).not.toMatch(/[-+]\s*-\s*\d/);
  });
});

describe('adversarial-review regressions (round 2)', () => {
  it('orientation-only chains (rotate pivot C) keep LEGACY placement — solver and export agree', () => {
    const mk = (withChain) => normalizeScene({
      params: {},
      components: [
        rect('kid', 0, 0, withChain ? { transforms: [{ id: 't', kind: 'rotate', enabled: true, angle: '90', pivot: 'C' }] } : {}),
        rect('P', 200, 100),
      ],
      snaps: [{ id: 's1', from: { compId: 'P', anchor: 'W' }, to: { compId: 'kid', anchor: 'E' }, dx: '0', dy: '0' }],
    });
    const a = solveLayout(mk(true).components, mk(true).snaps, {});
    const b = solveLayout(mk(false).components, mk(false).snaps, {});
    const kidA = a.find(c => c.id === 'kid');
    const kidB = b.find(c => c.id === 'kid');
    expect(kidA.cx).toBeCloseTo(kidB.cx, 12);
    expect(kidA.cy).toBeCloseTo(kidB.cy, 12);
    // export parity: legacy formula evaluates to the solved pose
    const scene = mk(true);
    const pp = computeParametricPositions(a, scene.snaps, {}, {});
    expect(evalExpr(stripUnitsForGuard(pp.kid.cxExpr), {})).toBeCloseTo(kidA.cx, 6);
  });

  it('ungrouped moved-base child: export bakes the solved pose (canvas↔HFSS agree)', () => {
    const scene = normalizeScene({
      params: {},
      components: [
        rect('solo', 10, 20, { transforms: [{ id: 't', kind: 'displace', enabled: true, dx: '50', dy: '0' }] }),
        rect('P', 200, 100),
      ],
      snaps: [{ id: 's1', from: { compId: 'P', anchor: 'W' }, to: { compId: 'solo', anchor: 'E' }, dx: '0', dy: '0' }],
    });
    const solved = solveLayout(scene.components, scene.snaps, {});
    const solo = solved.find(c => c.id === 'solo');
    const meta = {};
    const pp = computeParametricPositions(solved, scene.snaps, {}, meta);
    expect(evalExpr(stripUnitsForGuard(pp.solo.cxExpr), {})).toBeCloseTo(solo.cx, 5);
    expect((meta.groupRigid || []).some(n => /ungrouped moved-base/.test(n.detail))).toBe(true);
  });

  it('intra-group snap child does not contaminate the rigid centroid (pre-pin)', () => {
    // B is positioned by an INTRA-group snap off A and its raw is stale by
    // hundreds of µm; the rigid correction must still land A's rendered
    // anchor exactly on the target.
    const scene = normalizeScene({
      params: {},
      components: [
        rect('A', 0, 0,   { group: 'g', transforms: [{ ...ROT_G }] }),
        rect('B', 999, 777, { group: 'g', transforms: [{ ...ROT_G }] }),
        rect('P', 300, 200),
      ],
      snaps: [
        { id: 's1', from: { compId: 'P', anchor: 'S' }, to: { compId: 'A', anchor: 'N' }, dx: '0', dy: '0' },
        { id: 's2', from: { compId: 'A', anchor: 'E' }, to: { compId: 'B', anchor: 'W' }, dx: '4', dy: '0' },
      ],
      groups: [{ id: 'gg', name: 'g', memberIds: ['A', 'B'], aliases: {} }],
    });
    const pv = {};
    const solved = solveLayout(scene.components, scene.snaps, pv);
    const byId = Object.fromEntries(solved.map(c => [c.id, c]));
    const insts = expandTransforms(solved, pv);
    const pA = anchorWorld(byId.P, 'S', pv);
    const cA = resolveInstanceAnchorNumeric('A', 'N', 0, byId, insts, pv);
    expect(Math.hypot(pA.x - cA.x, pA.y - cA.y)).toBeLessThan(1e-6);
  });

  it('sanitized group names cannot collide: "g 1" and "g_1" mint distinct vars', () => {
    const mkMember = (id, cx, g, extra = {}) => rect(id, cx, 0, { group: g, transforms: [{ ...ROT_G }], ...extra });
    const scene = normalizeScene({
      params: {},
      components: [
        mkMember('a1', 0, 'g 1', { cxExpr: '0', cyExpr: '0' }),
        mkMember('a2', 100, 'g 1', { cxExpr: '100', cyExpr: '0' }),
        mkMember('b1', 0, 'g_1', { cxExpr: '0', cyExpr: '0' }),
        mkMember('b2', 100, 'g_1', { cxExpr: '100', cyExpr: '0' }),
        rect('P1', 300, 200), rect('P2', -300, -200),
      ],
      snaps: [
        { id: 's1', from: { compId: 'P1', anchor: 'S' }, to: { compId: 'a2', anchor: 'N' }, dx: '0', dy: '0' },
        { id: 's2', from: { compId: 'P2', anchor: 'N' }, to: { compId: 'b2', anchor: 'S' }, dx: '0', dy: '0' },
      ],
      groups: [
        { id: 'gg1', name: 'g 1', memberIds: ['a1', 'a2'], aliases: {} },
        { id: 'gg2', name: 'g_1', memberIds: ['b1', 'b2'], aliases: {} },
      ],
    });
    const pv = {};
    const solved = solveLayout(scene.components, scene.snaps, pv);
    const meta = {};
    const pp = computeParametricPositions(solved, scene.snaps, pv, meta);
    const names = (meta.rigidVars || []).map(v => v.name);
    expect(new Set(names).size).toBe(names.length); // no collisions
    // each group's members reproduce their own solved positions
    const pvR = { ...pv };
    for (const rv of meta.rigidVars || []) pvR[rv.name] = evalExpr(stripUnitsForGuard(rv.expr), pv);
    const byId = Object.fromEntries(solved.map(c => [c.id, c]));
    for (const id of ['a1', 'a2', 'b1', 'b2']) {
      expect(evalExpr(stripUnitsForGuard(pp[id].cxExpr), pvR), id).toBeCloseTo(byId[id].cx, 4);
    }
  });

  it('meta-less computeParametricPositions gets a bounded frozen δ', () => {
    const scene = mkGroupScene();
    const pv = resolveParams(scene.params).values;
    const solved = solveLayout(scene.components, scene.snaps, pv);
    const pp = computeParametricPositions(solved, scene.snaps, pv); // NO meta
    // member exprs stay bounded (frozen δ, not the inline centroid sum)
    for (const id of ['m1', 'm2', 'm3']) {
      expect(pp[id].cxExpr.length).toBeLessThan(300);
      expect(evalExpr(stripUnitsForGuard(pp[id].cxExpr), pv)).toBeCloseTo(solved.find(c => c.id === id).cx, 4);
    }
  });
});

describe('rigid-group interaction fixes (drag fold + port flankers)', () => {
  const loadV2 = () => {
    const d = JSON.parse(fs.readFileSync(new URL('./fixtures/ki-lumped-balun-v2.json', import.meta.url), 'utf8'));
    return normalizeScene(d.scene);
  };

  it('group drag folds the rigid child natural too — assembly snaps back whole', async () => {
    const { translateWithPosExprs, isPosExprActive } = await import('../src/scene/posexpr.js');
    const scene = loadV2();
    const pv = resolveParams(scene.params).values;
    const solved0 = solveLayout(scene.components, scene.snaps, pv);
    const insts0 = expandTransforms(solved0, pv);
    const g2 = scene.components.filter(c => c.group === 'group2').map(c => c.id);
    // the rigid CHILD's posExpr must be ACTIVE for the fold
    const child = scene.components.find(c => c.id === 'dyb2_s0n_copy_copy');
    expect(isPosExprActive(child, scene.snaps, scene.components, pv)).toBe(true);
    // simulate the canvas group-drag commit: fold (50, 30) into every member
    const comps2 = scene.components.map(c => g2.includes(c.id)
      ? translateWithPosExprs(c, c, 50, 30, isPosExprActive(c, scene.snaps, scene.components, pv))
      : c);
    const solved1 = solveLayout(comps2, scene.snaps, pv);
    const insts1 = expandTransforms(solved1, pv);
    for (const id of g2) {
      const a = insts0.find(i => i.compId === id && i.idx === 0);
      const b = insts1.find(i => i.compId === id && i.idx === 0);
      // snap-bound group: re-solve returns EVERY member to the constraint
      // (1e-3 tolerance = foldPosExprDelta's 4-decimal mouse rounding)
      expect(Math.hypot(b.cx - a.cx, b.cy - a.cy), id).toBeLessThan(1e-3);
    }
  });

  it('lumped port on a group-rotated member finds flankers at the RENDERED pose', async () => {
    const { detectPortIntegrationLine } = await import('../src/scene/lumpedPort.js');
    const scene = loadV2();
    const pv = resolveParams(scene.params).values;
    const solved = solveLayout(scene.components, scene.snaps, pv);
    const port = solved.find(c => c.id === 'dyb2_portW_copy_copy');
    const det = detectPortIntegrationLine(port, solved, pv);
    expect(det.direction).toBe('NS');
    // IntLine endpoints must lie on the RENDERED port sheet
    const insts = expandTransforms(solved, pv);
    const p0 = insts.find(i => i.compId === port.id && i.idx === 0);
    const rad = (p0.rotation || 0) * Math.PI / 180;
    const wEff = Math.abs(Math.cos(rad)) * p0.w + Math.abs(Math.sin(rad)) * p0.h;
    const hEff = Math.abs(Math.sin(rad)) * p0.w + Math.abs(Math.cos(rad)) * p0.h;
    expect(det.line.midX).toBeCloseTo(p0.cx, 6);
    expect(det.line.startY).toBeCloseTo(p0.cy - hEff / 2, 6);
    expect(det.line.endY).toBeCloseTo(p0.cy + hEff / 2, 6);
    expect(wEff).toBeGreaterThan(0);
    // and the generated script emits the AssignLumpedPort with those endpoints
    const script = generateHfssNative(scene, pv, {});
    expect(script).toContain('AssignLumpedPort');
    expect(script).toContain(`"${det.line.midX}um"`);
    expect(script).not.toContain('Frequency sweep skipped');
  });

  it('unrotated legacy port detection is unchanged (regression)', async () => {
    const { detectPortIntegrationLine } = await import('../src/scene/lumpedPort.js');
    // simple EW: conductor | port | conductor, no transforms
    const scene = normalizeScene({
      params: {},
      components: [
        rect('L', -15, 0, {}),
        { transforms: [], id: 'P', kind: 'rect', layer: 'port', cx: 0, cy: 0, w: '10', h: '10', cutouts: [], lumpedPort: { enabled: true, impedance: '50' } },
        rect('R', 15, 0, {}),
      ],
      snaps: [],
    });
    const pv = {};
    const solved = solveLayout(scene.components, scene.snaps, pv);
    const det = detectPortIntegrationLine(solved.find(c => c.id === 'P'), solved, pv);
    expect(det.direction).toBe('EW');
    expect(det.from).toBe('L');
    expect(det.to).toBe('R');
  });
});

describe('group drag = external-root drag (no deformation)', () => {
  it('dragging the balun group translates the whole chain rigidly via cond1', async () => {
    const { translateWithPosExprs, isPosExprActive } = await import('../src/scene/posexpr.js');
    const d = JSON.parse(fs.readFileSync(new URL('./fixtures/ki-lumped-balun-v2.json', import.meta.url), 'utf8'));
    const scene = normalizeScene(d.scene);
    const pv = resolveParams(scene.params).values;
    // the Canvas drag-init rule: an externally-snapped group co-moves ONLY
    // its external chain root — reproduce it here
    const members = new Set(scene.components.filter(c => c.group === 'group2').map(c => c.id));
    const findRoot = (startId) => {
      let rid = startId; const seen = new Set();
      while (!seen.has(rid)) {
        seen.add(rid);
        const inc = scene.snaps.find(s => s.to.compId === rid);
        if (!inc) break;
        rid = inc.from.compId;
      }
      return rid;
    };
    let extRoot = null;
    for (const mid of members) {
      const inc = scene.snaps.find(s => s.to.compId === mid);
      if (inc && !members.has(inc.from.compId)) { extRoot = findRoot(mid); break; }
    }
    expect(extRoot).toBe('cond1');
    // The Canvas dragRootFor rule: EVERY member — including free ones
    // like dyb2_c3_copy_copy (the reported deform entry point) — must
    // map to the external root, never to itself. A self-mapping seed
    // re-mixed the regimes and offset that member by the drag delta.
    for (const mid of members) {
      const grpExt = (() => {
        for (const m2 of members) {
          const inc = scene.snaps.find(sn => sn.to.compId === m2);
          if (inc && !members.has(inc.from.compId)) return findRoot(m2);
        }
        return null;
      })();
      expect(grpExt ?? findRoot(mid), `dragRootFor(${mid})`).toBe('cond1');
    }
    const solved0 = solveLayout(scene.components, scene.snaps, pv);
    const insts0 = expandTransforms(solved0, pv);
    const comps2 = scene.components.map(c => c.id === extRoot
      ? translateWithPosExprs(c, c, 50, 30, isPosExprActive(c, scene.snaps, scene.components, pv))
      : c);
    const solved1 = solveLayout(comps2, scene.snaps, pv);
    const insts1 = expandTransforms(solved1, pv);
    for (const id of members) {
      const a = insts0.find(i => i.compId === id && i.idx === 0);
      const b = insts1.find(i => i.compId === id && i.idx === 0);
      expect(b.cx - a.cx, id).toBeCloseTo(50, 9);
      expect(b.cy - a.cy, id).toBeCloseTo(30, 9);
      expect((b.rotation || 0) - (a.rotation || 0), id).toBeCloseTo(0, 9);
    }
  });
});

describe('snap-pinned path vertices re-resolve after rigid placement', () => {
  it('a polyshape pinned to the rigid child keeps stash === render', async () => {
    const { shapeInstanceToRing, remapPointsToInstance } = await import('../src/geometry/rings.js');
    const { tessellatePolylinePath } = await import('../src/geometry/polyline.js');
    // Group: rigid child A (rotate pivot:'group', snapped to external P)
    // + polyshape K whose first vertex is PINNED to A.NW. K is a free
    // root, placed (and its verts stashed) BEFORE the snap loop moves A —
    // without the final re-resolve, K's stashed ring sits at A's stale
    // pose while the canvas re-tessellation shows the true one.
    const scene = normalizeScene({
      params: {},
      components: [
        rect('A', 999, 777, { group: 'g', transforms: [{ ...ROT_G }], cxExpr: '40', cyExpr: '10' }),
        rect('B', 100, 0, { group: 'g', transforms: [{ ...ROT_G }], cxExpr: '100', cyExpr: '0' }),
        {
          transforms: [{ ...ROT_G }], id: 'K', kind: 'polyshape', layer: 'electrode',
          cx: 0, cy: 0, w: '0', h: '0', closed: true, cutouts: [], group: 'g',
          vertices: [
            { kind: 'snap', compId: 'A', anchor: 'NW' },
            { kind: 'rel', dx: '30', dy: '0' },
            { kind: 'rel', dx: '0', dy: '20' },
          ],
        },
        rect('P', 300, 200),
      ],
      snaps: [{ id: 's1', from: { compId: 'P', anchor: 'S' }, to: { compId: 'A', anchor: 'N' }, dx: '0', dy: '0' }],
      groups: [{ id: 'gg', name: 'g', memberIds: ['A', 'B', 'K'], aliases: {} }],
    });
    const pv = {};
    const solved = solveLayout(scene.components, scene.snaps, pv);
    const insts = expandTransforms(solved, pv);
    const byId = Object.fromEntries(solved.map(c => [c.id, c]));
    const K = byId.K;
    const inst = insts.find(i => i.compId === 'K' && i.idx === 0);
    const render = remapPointsToInstance(tessellatePolylinePath(K, byId, pv, insts), inst, K.cx, K.cy);
    const stashRing = shapeInstanceToRing(inst);
    expect(stashRing.length).toBeGreaterThanOrEqual(3);
    for (let i = 0; i < Math.min(render.length, stashRing.length); i++) {
      expect(stashRing[i][0], `vx${i}`).toBeCloseTo(render[i][0], 9);
      expect(stashRing[i][1], `vy${i}`).toBeCloseTo(render[i][1], 9);
    }
  });
});
