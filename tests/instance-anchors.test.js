// Snap-to-instance consistency (the "meander last-cell anchors don't work"
// + "snap mode shows fewer anchors" report). One shared truth: an explicit
// from.instanceIdx (INCLUDING 0) addresses the RENDERED instance's anchor —
// expandTransforms pose + anchor in the instance's own frame (mirror scale
// then rotation). The solver, the alt-drag index, the snap-mode dots, and
// the HFSS export must all agree on it for every chain kind.
import { describe, it, expect } from 'vitest';
import { normalizeScene, makeBlankScene } from '../src/scene/schema.js';
import { resolveParams, evalExpr } from '../src/scene/params.js';
import { solveLayout } from '../src/scene/solver.js';
import { expandTransforms } from '../src/scene/transforms.js';
import { anchorLocalInstance, anchorWorld } from '../src/scene/anchors.js';
import { instanceChainOffsetExpr, resolveInstanceAnchorNumeric } from '../src/scene/instance-positions.js';
import { computeParametricPositions } from '../src/export/hfss-native.js';
import { buildAltDragTargetIndex, findAltDragSnapCandidate } from '../src/ui/canvas/Canvas.jsx';

// Meander-shaped fixture: a 2-operand union with the SAME chain family as
// the user's meander (repeat → rotate 180 about the cluster centroid →
// duplicate_mirror) — the chain that MOVES instance 0 away from the base.
function meanderishScene() {
  const s = makeBlankScene();
  s.params.pitch = { expr: '27', unit: 'µm', desc: '' };
  s.params.moff = { expr: '120', unit: 'µm', desc: '' };
  s.components.push(
    { id: 'barA', kind: 'rect', layer: 'electrode', cx: 0, cy: 0, w: '10', h: '2', cutouts: [], transforms: [], consumedBy: 'u1' },
    { id: 'barB', kind: 'rect', layer: 'electrode', cx: 0, cy: 10, w: '10', h: '2', cutouts: [], transforms: [], consumedBy: 'u1' },
    {
      id: 'u1', kind: 'boolean', op: 'union', operandIds: ['barA', 'barB'],
      layer: 'electrode', cx: 0, cy: 5, w: '0', h: '0', cutouts: [],
      transforms: [
        { id: 't1', kind: 'repeat', enabled: true, n: '2', dx: '0', dy: 'pitch', includeOriginal: true },
        { id: 't2', kind: 'rotate', enabled: true, angle: '180', pivot: 'C' },
        { id: 't3', kind: 'duplicate_mirror', enabled: true, axis: 'x', offset: 'moff', includeOriginal: true },
      ],
    },
    { id: 'child0', kind: 'rect', layer: 'electrode', cx: 50, cy: 50, w: '2', h: '2', cutouts: [], transforms: [] },
    { id: 'child3', kind: 'rect', layer: 'electrode', cx: 60, cy: 50, w: '2', h: '2', cutouts: [], transforms: [] },
  );
  return normalizeScene(s);
}

const renderedAnchor = (solvedBool, pv, idx, anchor) => {
  const insts = expandTransforms([solvedBool], pv);
  const i = insts.find(x => x.idx === idx);
  const lp = anchorLocalInstance(anchor, i.w, i.h, i.rotation || 0, i.scaleX ?? 1, i.scaleY ?? 1);
  return { x: i.cx + lp.x, y: i.cy + lp.y };
};

describe('instanceChainOffsetExpr angle handling', () => {
  const comp = {
    id: 'r', cx: 0, cy: 0, w: '10', h: '2',
    transforms: [
      { id: 't1', kind: 'repeat', enabled: true, n: '2', dx: '0', dy: '20', includeOriginal: true },
      { id: 't2', kind: 'rotate', enabled: true, angle: '180', pivot: 'C' },
    ],
  };
  it("numeric mode evaluates rotate chains (the 'cos(180deg)' bug is gone)", () => {
    const off = instanceChainOffsetExpr(comp, 2, {
      paramValues: {}, exprWithUm: (x) => `(${x})`,
      baseCxExpr: '0', baseCyExpr: '0', angleMode: 'numeric',
    });
    const dy = evalExpr(off.dyExpr, {});
    // Offsets before rotation: [0, 20, 40]; 180° about the offset
    // centroid (20) maps old → 40−old, so idx 2 lands at 0 — DIFFERENT
    // from the repeat-only 40, proving the rotation actually evaluated
    // (the old 'cos(180deg)' form was unevaluable by evalExpr).
    expect(Number.isFinite(dy)).toBe(true);
    expect(dy).toBeCloseTo(0, 6);
    const off1 = instanceChainOffsetExpr(comp, 1, {
      paramValues: {}, exprWithUm: (x) => `(${x})`,
      baseCxExpr: '0', baseCyExpr: '0', angleMode: 'numeric',
    });
    expect(evalExpr(off1.dyExpr, {})).toBeCloseTo(20, 6);
  });
  it('honest idx 0: a rotate-about-centroid chain gives instance 0 a NONZERO offset', () => {
    const off0 = instanceChainOffsetExpr(comp, 0, {
      paramValues: {}, exprWithUm: (x) => `(${x})`,
      baseCxExpr: '0', baseCyExpr: '0', angleMode: 'numeric',
    });
    const dy0 = evalExpr(off0.dyExpr, {});
    expect(dy0).toBeCloseTo(40, 6); // base cell maps to the TOP under 180°
  });
  it('hfss mode emits angles as ((angle))*1deg (HFSS quantity, not radians)', () => {
    const off = instanceChainOffsetExpr(comp, 1, {
      paramValues: {}, exprWithUm: (x) => `(${x})`,
      baseCxExpr: '0', baseCyExpr: '0',
    });
    expect(off.dyExpr).toContain('*1deg');
  });
  it('repeat-only chains keep a zero idx-0 offset (legacy fast path)', () => {
    const rep = { id: 'p', transforms: [{ id: 't', kind: 'repeat', enabled: true, n: '2', dx: '5', dy: '0', includeOriginal: true }] };
    const off = instanceChainOffsetExpr(rep, 0, { paramValues: {}, exprWithUm: (x) => `(${x})`, angleMode: 'numeric' });
    expect(evalExpr(off.dxExpr, {})).toBeCloseTo(0, 9);
  });
});

describe('solver: explicit from.instanceIdx lands on the RENDERED instance anchor', () => {
  const scene = meanderishScene();
  scene.snaps.push(
    { id: 's0', from: { compId: 'u1', anchor: 'SE', instanceIdx: 0 }, to: { compId: 'child0', anchor: 'C' }, dx: '0', dy: '0' },
    { id: 's3', from: { compId: 'u1', anchor: 'SE', instanceIdx: 3 }, to: { compId: 'child3', anchor: 'C' }, dx: '0', dy: '0' },
  );
  const pv = resolveParams(scene.params).values;
  const solved = solveLayout(scene.components, scene.snaps, pv);
  const u1 = solved.find(c => c.id === 'u1');

  it('instance 0 (moved by rotate-about-centroid) — the "red cell"', () => {
    const c = solved.find(x => x.id === 'child0');
    const r = renderedAnchor(u1, pv, 0, 'SE');
    expect(c.cx).toBeCloseTo(r.x, 6);
    expect(c.cy).toBeCloseTo(r.y, 6);
  });
  it('instance 3 (mirrored copy)', () => {
    const c = solved.find(x => x.id === 'child3');
    const r = renderedAnchor(u1, pv, 3, 'SE');
    expect(c.cx).toBeCloseTo(r.x, 6);
    expect(c.cy).toBeCloseTo(r.y, 6);
  });
  it('legacy snap WITHOUT instanceIdx keeps the base/displayBbox semantics', () => {
    const scene2 = meanderishScene();
    scene2.snaps.push({ id: 'sb', from: { compId: 'u1', anchor: 'SE' }, to: { compId: 'child0', anchor: 'C' }, dx: '0', dy: '0' });
    const pv2 = resolveParams(scene2.params).values;
    const solved2 = solveLayout(scene2.components, scene2.snaps, pv2);
    const u = solved2.find(c => c.id === 'u1');
    const base = anchorWorld(u, 'SE', pv2);
    const c = solved2.find(x => x.id === 'child0');
    expect(c.cx).toBeCloseTo(base.x, 6);
    expect(c.cy).toBeCloseTo(base.y, 6);
  });
});

describe('HFSS parity + parametricity', () => {
  it('non-translation chain: emitted expr evaluates EXACTLY to the solver position', () => {
    const scene = meanderishScene();
    scene.snaps.push(
      { id: 's0', from: { compId: 'u1', anchor: 'SE', instanceIdx: 0 }, to: { compId: 'child0', anchor: 'C' }, dx: '0', dy: '0' },
      { id: 's3', from: { compId: 'u1', anchor: 'SE', instanceIdx: 3 }, to: { compId: 'child3', anchor: 'C' }, dx: '0', dy: '0' },
    );
    const pv = resolveParams(scene.params).values;
    const solved = solveLayout(scene.components, scene.snaps, pv);
    const pp = computeParametricPositions(solved, scene.snaps, pv);
    // HFSS-expr evaluator: strip units, convert the '((angle))*1deg' HFSS
    // quantity form to radians for evalExpr. The non-translation from-term
    // is now PARAMETRIC (parent center + chain offset + numeric-trig
    // instance-frame anchor), so it references cos/sin of the chain angle.
    const ev = (e) => evalExpr(String(e).replace(/\*1deg/g, '*pi/180').replace(/um/g, ''), pv);
    for (const id of ['child0', 'child3']) {
      const c = solved.find(x => x.id === id);
      expect(ev(pp[id].cxExpr)).toBeCloseTo(c.cx, 4);
      expect(ev(pp[id].cyExpr)).toBeCloseTo(c.cy, 4);
    }
  });
  it('translation-only chain: instanceIdx (including 0) stays PARAMETRIC in the pitch', () => {
    const s = makeBlankScene();
    s.params.pitch = { expr: '30', unit: 'µm', desc: '' };
    s.components.push(
      {
        id: 'r1', kind: 'rect', layer: 'electrode', cx: 0, cy: 0, w: '10', h: '4', cutouts: [],
        transforms: [{ id: 't', kind: 'repeat', enabled: true, n: '2', dx: 'pitch', dy: '0', includeOriginal: true }],
      },
      { id: 'kid', kind: 'rect', layer: 'electrode', cx: 50, cy: 0, w: '2', h: '2', cutouts: [], transforms: [] },
    );
    const scene = normalizeScene(s);
    scene.snaps.push({ id: 'sk', from: { compId: 'r1', anchor: 'E', instanceIdx: 2 }, to: { compId: 'kid', anchor: 'W' }, dx: '0', dy: '0' });
    const pv = resolveParams(scene.params).values;
    const solved = solveLayout(scene.components, scene.snaps, pv);
    const pp = computeParametricPositions(solved, scene.snaps, pv);
    expect(pp.kid.cxExpr).toContain('pitch'); // parametric, not baked
    const ev = (e) => evalExpr(String(e).replace(/um/g, ''), pv);
    expect(ev(pp.kid.cxExpr)).toBeCloseTo(solved.find(c => c.id === 'kid').cx, 6);
  });
});

describe('alt-drag index offers the moved instance 0 (the red cell)', () => {
  const scene = meanderishScene();
  const pv = resolveParams(scene.params).values;
  const solved = solveLayout(scene.components, scene.snaps, pv);
  // resolveBooleanBboxes analog: give u1 numeric w/h like the app does.
  const u1 = solved.find(c => c.id === 'u1');
  u1.w = 10; u1.h = 12; // operand-cluster bbox
  const dims = Object.fromEntries(solved.map(c => [c.id, { w: typeof c.w === 'number' ? c.w : evalExpr(c.w, pv), h: typeof c.h === 'number' ? c.h : evalExpr(c.h, pv) }]));
  const instances = expandTransforms([u1], pv);
  const index = buildAltDragTargetIndex(solved, pv, dims, instances);

  it('instance 0 SE has a candidate at the RENDERED position', () => {
    const r = renderedAnchor(u1, pv, 0, 'SE');
    const found = findAltDragSnapCandidate(index, {
      proposedCx: r.x + 1, proposedCy: r.y + 1, dw: 2, dh: 2,
      worldThresh: 3,
    });
    expect(found.best).toBeTruthy();
    expect(found.best.kind).toBe('anchor');
    expect(found.best.target.compId).toBe('u1');
    expect(found.best.target.instanceIdx).toBe(0);
  });
  it('an unmoved base (plain rect, no transforms) gains NO idx-0 duplicate (byte-compat)', () => {
    const plain = solved.filter(c => !c.consumedBy);
    const inst2 = expandTransforms(plain, pv);
    const idx2 = buildAltDragTargetIndex(solved, pv, dims, inst2.filter(i => i.compId === 'child0'));
    // child0 has no transforms: its only anchors are the base block —
    // querying near its center must yield a candidate WITHOUT instanceIdx.
    const c0 = solved.find(c => c.id === 'child0');
    const f = findAltDragSnapCandidate(idx2, { proposedCx: c0.cx + 0.5, proposedCy: c0.cy + 0.5, dw: 1, dh: 1, worldThresh: 2 });
    expect(f.best).toBeTruthy();
    expect(f.best.target.instanceIdx).toBeUndefined();
  });
});

describe('resolveInstanceAnchorNumeric is rotation/scale-aware', () => {
  it('a 180°-rotated instance anchor lands on the flipped corner', () => {
    const scene = meanderishScene();
    const pv = resolveParams(scene.params).values;
    const solved = solveLayout(scene.components, scene.snaps, pv);
    const u1 = solved.find(c => c.id === 'u1');
    u1.w = 10; u1.h = 12;
    const insts = expandTransforms([u1], pv);
    const byId = Object.fromEntries(solved.map(c => [c.id, c]));
    const got = resolveInstanceAnchorNumeric('u1', 'SE', 0, byId, insts, pv);
    const want = renderedAnchor(u1, pv, 0, 'SE');
    expect(got.x).toBeCloseTo(want.x, 6);
    expect(got.y).toBeCloseTo(want.y, 6);
  });
});

describe('HFSS SWEEP parity (the "snapped to meander breaks under cell_w sweep" bug)', () => {
  // Gold test: expressions are computed ONCE at export values, then
  // re-evaluated at a DIFFERENT parameter value and compared against a
  // FRESH canvas solve at that value — exactly what an HFSS-side sweep
  // does. Covers all three formerly-frozen pieces: the cluster-root
  // operand offset, the boolean-as-child bbox anchor, and the
  // instance-anchor from-term on a rotate/mirror chain.
  it('operands + instance-snapped children track a cell-size sweep exactly', () => {
    const build = (pitchExpr) => {
      const s = makeBlankScene();
      s.params.pitch = { expr: pitchExpr, unit: 'µm', desc: '' };
      s.params.moff = { expr: '120', unit: 'µm', desc: '' };
      s.components.push(
        { id: 'anchorEl', kind: 'rect', layer: 'electrode', cx: -30, cy: -30, w: '8', h: '8', cutouts: [], transforms: [] },
        { id: 'barA', kind: 'rect', layer: 'electrode', cx: 0, cy: 0, w: '10', h: '2', cutouts: [], transforms: [], consumedBy: 'u1' },
        { id: 'barB', kind: 'rect', layer: 'electrode', cx: 0, cy: 10, w: '10', h: 'pitch/5', cutouts: [], transforms: [], consumedBy: 'u1' },
        {
          id: 'u1', kind: 'boolean', op: 'union', operandIds: ['barA', 'barB'],
          layer: 'electrode', cx: 0, cy: 5, w: '0', h: '0', cutouts: [],
          transforms: [
            { id: 't1', kind: 'repeat', enabled: true, n: '2', dx: '0', dy: 'pitch', includeOriginal: true },
            { id: 't2', kind: 'rotate', enabled: true, angle: '180', pivot: 'C' },
            { id: 't3', kind: 'duplicate_mirror', enabled: true, axis: 'x', offset: 'moff', includeOriginal: true },
          ],
        },
        { id: 'kid', kind: 'rect', layer: 'electrode', cx: 50, cy: 50, w: '2', h: '2', cutouts: [], transforms: [] },
        { id: 'kid2', kind: 'rect', layer: 'electrode', cx: 70, cy: 50, w: '2', h: '2', cutouts: [], transforms: [] },
      );
      const scene = normalizeScene(s);
      scene.snaps.push(
        // internal snap: barB positioned from barA (pitch-dependent)
        { id: 'si', from: { compId: 'barA', anchor: 'N' }, to: { compId: 'barB', anchor: 'S' }, dx: '0', dy: 'pitch/4' },
        // the boolean is a CHILD (bbox SE pinned to anchorEl.N)
        { id: 'sb', from: { compId: 'anchorEl', anchor: 'N' }, to: { compId: 'u1', anchor: 'SE' }, dx: '0', dy: '2' },
        // children snapped to instance anchors (moved idx 0 + mirrored idx 3)
        { id: 's0', from: { compId: 'u1', anchor: 'SW', instanceIdx: 0 }, to: { compId: 'kid', anchor: 'NW' }, dx: '1', dy: '0' },
        { id: 's3', from: { compId: 'u1', anchor: 'SE', instanceIdx: 3 }, to: { compId: 'kid2', anchor: 'C' }, dx: '0', dy: '0' },
      );
      return scene;
    };
    const evH = (e, pv) => evalExpr(String(e).replace(/\*1deg/g, '*pi/180').replace(/um/g, ''), pv);
    // Export at pitch = 27
    const sceneA = build('27');
    const pvA = resolveParams(sceneA.params).values;
    const solvedA = solveLayout(sceneA.components, sceneA.snaps, pvA);
    const pp = computeParametricPositions(solvedA, sceneA.snaps, pvA);
    const ids = ['barA', 'barB', 'kid', 'kid2'];
    for (const id of ids) {
      const c = solvedA.find(x => x.id === id);
      expect(evH(pp[id].cxExpr, pvA)).toBeCloseTo(c.cx, 6);
      expect(evH(pp[id].cyExpr, pvA)).toBeCloseTo(c.cy, 6);
    }
    // SWEEP: pitch 27 → 40 with the SAME expressions vs a FRESH solve
    const sceneB = build('40');
    const pvB = resolveParams(sceneB.params).values;
    const solvedB = solveLayout(sceneB.components, sceneB.snaps, pvB);
    for (const id of ids) {
      const c = solvedB.find(x => x.id === id);
      expect(evH(pp[id].cxExpr, pvB)).toBeCloseTo(c.cx, 6);
      expect(evH(pp[id].cyExpr, pvB)).toBeCloseTo(c.cy, 6);
    }
  });
});
