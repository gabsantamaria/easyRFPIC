// Re-root ("⇄ make root") — src/scene/reroot.js.
//
// Regression for the "everything falls apart on re-root" bug pair
// (user's HARQ chain: rect → rect → POLYSHAPE → rect → rect, re-rooted
// at the 4th component):
//   (1) plain swap-endpoints + negate-offsets is asymmetric through
//       PATH KINDS — a polyline/polyshape's CHILD pin is its vertex-0
//       root while its PARENT anchors sit on the displayBbox frame, so
//       flipping a snap through one shifted the upstream chain by the
//       frame↔v0 offset (~hundreds of µm on the real design);
//   (2) a snap child's raw cx/cy is STALE (the solver overwrites it
//       every solve) — promoting a stale child to root teleported the
//       whole assembly to the stale coordinates.
// reRootSnaps fixes both: solved-position offset capture for asymmetric
// flips + a solved-position bake of the new root's raw cx/cy.
import { describe, it, expect } from 'vitest';
import { reRootSnaps } from '../src/scene/reroot.js';
import { normalizeScene } from '../src/scene/schema.js';
import { resolveParams } from '../src/scene/params.js';
import { solveLayout, validateSnapGraph } from '../src/scene/solver.js';

const solveMap = (sc) => {
  const pv = resolveParams(sc.params).values;
  const solved = solveLayout(sc.components, sc.snaps, pv);
  return Object.fromEntries(solved.map(c => [c.id, c]));
};
const applyReRoot = (sc, rootId) => normalizeScene({ ...sc, ...reRootSnaps(sc, rootId) });
const expectPositionsPreserved = (before, after, tol = 1e-6) => {
  for (const id of Object.keys(before)) {
    expect(Math.abs(after[id].cx - before[id].cx), `${id}.cx`).toBeLessThan(tol);
    expect(Math.abs(after[id].cy - before[id].cy), `${id}.cy`).toBeLessThan(tol);
  }
};

// ---------- fixtures ----------

// Rect-only chain a → b → c with param offsets (the symbolic-negate path).
const rectChain = () => normalizeScene({
  params: {
    g1: { expr: '5', unit: 'µm', desc: 'gap a-b' },
    g2: { expr: '-8', unit: 'µm', desc: 'gap b-c' },
  },
  components: [
    { id: 'a', kind: 'rect', layer: 'electrode', cx: 0, cy: 0, w: '20', h: '10', cutouts: [], transforms: [] },
    { id: 'b', kind: 'rect', layer: 'electrode', cx: 999, cy: 999, w: '20', h: '10', cutouts: [], transforms: [] },
    { id: 'c', kind: 'rect', layer: 'electrode', cx: -999, cy: 123, w: '20', h: '10', cutouts: [], transforms: [] },
  ],
  snaps: [
    { id: 's_ab', from: { compId: 'a', anchor: 'E' }, to: { compId: 'b', anchor: 'W' }, dx: 'g1', dy: '0' },
    { id: 's_bc', from: { compId: 'b', anchor: 'NE' }, to: { compId: 'c', anchor: 'NW' }, dx: 'g2', dy: '2' },
  ],
  mirrors: [], groups: [], booleans: [],
});

// The user's actual topology: rect → rect → POLYSHAPE → rect → rect.
// pshape's v0 sits at its cx/cy; its bbox extends +60 x / −20 y from
// there, so parent-role anchors (displayBbox) ≠ child-role pin (v0).
const pathChain = () => normalizeScene({
  params: {
    gw: { expr: '60', unit: 'µm', desc: 'gnd width' },
    fw: { expr: '40', unit: 'µm', desc: 'feed width' },
    tL: { expr: '20', unit: 'µm', desc: 'taper length' },
    gap: { expr: '4', unit: 'µm', desc: 'feed gap' },
    gx21: { expr: '-60', unit: 'µm', desc: 'gnd SE → pshape NE dx' },
  },
  components: [
    { id: 'gnd', kind: 'rect', layer: 'electrode', cx: 37.3, cy: 356.5, w: 'gw', h: '10', cutouts: [], transforms: [] },
    { id: 'ps', kind: 'polyshape', layer: 'electrode', cx: 229.9, cy: 533.8, w: '0', h: '0',
      closed: true, cutouts: [], transforms: [],
      vertices: [
        { kind: 'rel', dx: '0', dy: '0' },
        { kind: 'rel', dx: 'gw', dy: '0' },
        { kind: 'rel', dx: '-(gw-fw)/2', dy: '-tL' },
        { kind: 'rel', dx: '-fw', dy: '0' },
      ] },
    { id: 'feedA', kind: 'rect', layer: 'electrode', cx: 279.9, cy: 511.8, w: 'fw', h: '20', cutouts: [], transforms: [] },
    { id: 'feedB', kind: 'rect', layer: 'electrode', cx: 378.6, cy: 473.8, w: 'fw', h: '20', cutouts: [], transforms: [] },
    { id: 'port', kind: 'rect', layer: 'electrode', cx: -5, cy: 330, w: 'gw', h: '15', cutouts: [], transforms: [] },
  ],
  snaps: [
    { id: 's_pg', from: { compId: 'port', anchor: 'SW' }, to: { compId: 'gnd', anchor: 'NW' }, dx: '0', dy: '0' },
    { id: 's_gp', from: { compId: 'gnd', anchor: 'SE' }, to: { compId: 'ps', anchor: 'NE' }, dx: 'gx21', dy: '0' },
    { id: 's_pf', from: { compId: 'ps', anchor: 'SE' }, to: { compId: 'feedA', anchor: 'NE' }, dx: '0', dy: '0' },
    { id: 's_ff', from: { compId: 'feedA', anchor: 'NE' }, to: { compId: 'feedB', anchor: 'NW' }, dx: 'gap', dy: '0' },
  ],
  mirrors: [], groups: [], booleans: [],
});

// Replica snap: child hangs off instance 2 of a repeated parent.
const replicaChain = () => normalizeScene({
  params: { pitch: { expr: '30', unit: 'µm', desc: 'repeat pitch' } },
  components: [
    { id: 'bar', kind: 'rect', layer: 'electrode', cx: 0, cy: 0, w: '10', h: '40', cutouts: [],
      transforms: [{ id: 't1', kind: 'repeat', enabled: true, n: 3, dx: 'pitch', dy: '0', includeOriginal: true }] },
    { id: 'tag', kind: 'rect', layer: 'electrode', cx: 500, cy: 500, w: '6', h: '6', cutouts: [], transforms: [] },
  ],
  snaps: [
    { id: 's_rt', from: { compId: 'bar', anchor: 'NE', instanceIdx: 2 }, to: { compId: 'tag', anchor: 'SW' }, dx: '1', dy: '1' },
  ],
  mirrors: [], groups: [], booleans: [],
});

// ---------- tests ----------

describe('reRootSnaps — rect chains (symbolic path)', () => {
  it('re-orients every snap away from the new root and keeps the graph valid', () => {
    const sc = rectChain();
    const next = applyReRoot(sc, 'c');
    expect(next.snaps.some(s => s.to.compId === 'c')).toBe(false);
    const parentOf = Object.fromEntries(next.snaps.map(s => [s.to.compId, s.from.compId]));
    expect(parentOf.b).toBe('c');
    expect(parentOf.a).toBe('b');
    expect(validateSnapGraph(next.components, next.snaps).length).toBe(0);
  });

  it('preserves every solved position (params negated in place, still live)', () => {
    const sc = rectChain();
    const before = solveMap(sc);
    const next = applyReRoot(sc, 'c');
    expectPositionsPreserved(before, solveMap(next));
    // Sole-reference params flip symbolically, not numerically.
    expect(next.params.g1.expr).toBe('-(5)');
    expect(next.params.g2.expr).toBe('-(-8)');
    expect(next.snaps.find(s => s.id === 's_ab').dx).toBe('g1');
  });

  it('bakes the new root position — a STALE raw cx/cy cannot teleport the chain', () => {
    const sc = rectChain(); // b, c carry absurd stale raw positions (999 / -999)
    const before = solveMap(sc);
    const next = applyReRoot(sc, 'c');
    const cRaw = next.components.find(x => x.id === 'c');
    expect(Math.abs(cRaw.cx - before.c.cx)).toBeLessThan(1e-9);
    expect(Math.abs(cRaw.cy - before.c.cy)).toBeLessThan(1e-9);
    expectPositionsPreserved(before, solveMap(next));
  });

  it('strips inert cxExpr/cyExpr from the new root (would go live and jump)', () => {
    const sc = rectChain();
    sc.components.find(x => x.id === 'c').cxExpr = '5000';
    const before = solveMap(sc); // cxExpr ignored while snapped
    const next = applyReRoot(sc, 'c');
    expect(next.components.find(x => x.id === 'c').cxExpr).toBeUndefined();
    expectPositionsPreserved(before, solveMap(next));
  });

  it('round-trips: re-root away and back preserves geometry', () => {
    const sc = rectChain();
    const before = solveMap(sc);
    const back = applyReRoot(applyReRoot(sc, 'c'), 'a');
    expectPositionsPreserved(before, solveMap(back));
    const parentOf = Object.fromEntries(back.snaps.map(s => [s.to.compId, s.from.compId]));
    expect(parentOf.b).toBe('a');
    expect(parentOf.c).toBe('b');
  });
});

describe('reRootSnaps — path kinds mid-chain (the HARQ bug)', () => {
  it('re-root DOWNSTREAM of the polyshape preserves every solved position', () => {
    const sc = pathChain();
    const before = solveMap(sc);
    const next = applyReRoot(sc, 'feedA'); // flips s_pf, s_gp, s_pg through ps
    const after = solveMap(next);
    expectPositionsPreserved(before, after, 1e-3);
    // The polyshape frame too, not just its v0 root.
    expect(Math.abs(after.ps.displayBbox.cx - before.ps.displayBbox.cx)).toBeLessThan(1e-3);
    expect(Math.abs(after.ps.displayBbox.cy - before.ps.displayBbox.cy)).toBeLessThan(1e-3);
    // Orientation fully reversed along the flipped path.
    const parentOf = Object.fromEntries(next.snaps.map(s => [s.to.compId, s.from.compId]));
    expect(parentOf.ps).toBe('feedA');
    expect(parentOf.gnd).toBe('ps');
    expect(parentOf.port).toBe('gnd');
    expect(parentOf.feedB).toBe('feedA');
    expect(validateSnapGraph(next.components, next.snaps).length).toBe(0);
  });

  it('re-root AT the polyshape preserves geometry (path kind as the new root)', () => {
    const sc = pathChain();
    const before = solveMap(sc);
    const next = applyReRoot(sc, 'ps');
    expectPositionsPreserved(before, solveMap(next), 1e-3);
    expect(next.snaps.some(s => s.to.compId === 'ps')).toBe(false);
  });

  it('the OLD plain swap+negate math scatters this chain (bug demonstration)', () => {
    const sc = pathChain();
    const before = solveMap(sc);
    const naiveSnaps = sc.snaps.map(s => {
      if (!['s_pg', 's_gp', 's_pf'].includes(s.id)) return s;
      return { ...s,
        from: { compId: s.to.compId, anchor: s.to.anchor },
        to: { compId: s.from.compId, anchor: s.from.anchor },
        dx: `-(${s.dx})`, dy: `-(${s.dy})` };
    });
    // Pin the new root where it was solved so ONLY the flip asymmetry shows.
    const comps = sc.components.map(c => (c.id === 'feedA' ? { ...c, cx: before.feedA.cx, cy: before.feedA.cy } : c));
    const naive = solveMap(normalizeScene({ ...sc, components: comps, snaps: naiveSnaps }));
    const drift = Math.hypot(naive.gnd.cx - before.gnd.cx, naive.gnd.cy - before.gnd.cy);
    expect(drift).toBeGreaterThan(10); // frame↔v0 asymmetry, tens of µm
  });

  it('keeps disconnected sub-graph snaps untouched', () => {
    const sc = pathChain();
    sc.components.push(
      { id: 'x1', kind: 'rect', layer: 'electrode', cx: 1000, cy: 0, w: '5', h: '5', cutouts: [], transforms: [] },
      { id: 'x2', kind: 'rect', layer: 'electrode', cx: 1010, cy: 0, w: '5', h: '5', cutouts: [], transforms: [] },
    );
    sc.snaps.push({ id: 's_xx', from: { compId: 'x1', anchor: 'E' }, to: { compId: 'x2', anchor: 'W' }, dx: '3', dy: '0' });
    const next = applyReRoot(normalizeScene(sc), 'feedA');
    const sxx = next.snaps.find(s => s.id === 's_xx');
    expect(sxx.from.compId).toBe('x1');
    expect(sxx.dx).toBe('3');
  });
});

describe('reRootSnaps — shared-param safety (latent sign bugs)', () => {
  it('param shared by dx AND dy of one flipped snap: negated once, both refs stay bare', () => {
    const sc = rectChain();
    sc.snaps[1] = { ...sc.snaps[1], dx: 'g2', dy: 'g2' }; // s_bc uses g2 on both axes
    const norm = normalizeScene(sc);
    const before = solveMap(norm);
    const next = applyReRoot(norm, 'c');
    const sbc = next.snaps.find(s => s.id === 's_bc');
    expect(sbc.dx).toBe('g2');
    expect(sbc.dy).toBe('g2');
    expect(next.params.g2.expr).toBe('-(-8)'); // negated exactly once
    expectPositionsPreserved(before, solveMap(next));
  });

  it('param shared with a KEPT snap is NOT negated in place (kept snap must not flip sign)', () => {
    const sc = rectChain();
    // Disconnected pair whose snap reuses g1 — g1 now has a reference
    // OUTSIDE the flip set, so in-place negation would corrupt it.
    sc.components.push(
      { id: 'x1', kind: 'rect', layer: 'electrode', cx: 500, cy: 0, w: '10', h: '10', cutouts: [], transforms: [] },
      { id: 'x2', kind: 'rect', layer: 'electrode', cx: 520, cy: 0, w: '10', h: '10', cutouts: [], transforms: [] },
    );
    sc.snaps.push({ id: 's_xx', from: { compId: 'x1', anchor: 'E' }, to: { compId: 'x2', anchor: 'W' }, dx: 'g1', dy: '0' });
    const norm = normalizeScene(sc);
    const before = solveMap(norm);
    const next = applyReRoot(norm, 'c');
    expect(next.params.g1.expr).toBe('5');                       // untouched
    expect(next.snaps.find(s => s.id === 's_ab').dx).toBe('-(g1)'); // flipped side wraps
    expect(next.snaps.find(s => s.id === 's_xx').dx).toBe('g1');    // kept side verbatim
    expectPositionsPreserved(before, solveMap(next));
  });

  it('param shared between a sym flip and a capture-corr flip is NOT negated in place', () => {
    // gnd→ps (path capture, corr ≠ 0 → wraps -(g)) and feedA→feedB (rect
    // sym flip on the same param). In-place negation would double-negate
    // the wrapped side.
    const sc = pathChain();
    sc.params.g = { expr: '4', unit: 'µm', desc: 'shared' };
    sc.snaps = sc.snaps.map(s => (s.id === 's_gp' ? { ...s, dx: 'g' } : s.id === 's_ff' ? { ...s, dx: 'g' } : s));
    const norm = normalizeScene(sc);
    const before = solveMap(norm);
    const next = applyReRoot(norm, 'feedB'); // flips BOTH s_ff (sym) and s_gp (corr)
    expect(next.params.g.expr).toBe('4'); // untouched
    expectPositionsPreserved(before, solveMap(next), 1e-3);
  });
});

describe('reRootSnaps — replica (from.instanceIdx) flips', () => {
  it('flipping a replica snap drops the idx and preserves both positions', () => {
    const sc = replicaChain();
    const before = solveMap(sc);
    const next = applyReRoot(sc, 'tag');
    const flipped = next.snaps.find(s => s.id === 's_rt');
    expect(flipped.from.compId).toBe('tag');
    expect(flipped.to.compId).toBe('bar');
    expect(flipped.from.instanceIdx).toBeUndefined();
    expect(flipped.to.instanceIdx).toBeUndefined();
    expectPositionsPreserved(before, solveMap(next), 1e-3);
  });
});
