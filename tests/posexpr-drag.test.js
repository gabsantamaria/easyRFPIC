// Draggable posExpr roots: drag/nudge folds the delta into cxExpr/cyExpr.
//
// The solver re-applies an active cxExpr/cyExpr on every solve, so a plain
// numeric drag was overwritten and an expression-positioned assembly (the
// double-Y balun: 30 roots, all trig in dyb2_jx/jy) was immovable by
// mouse. translateWithPosExprs folds the gesture's delta into the
// expression — the part lands where dropped AND stays parametric.
import { describe, it, expect } from 'vitest';
import { foldPosExprDelta, isPosExprActive, translateWithPosExprs } from '../src/scene/posexpr.js';
import { evalExpr } from '../src/scene/params.js';
import { solveLayout } from '../src/scene/solver.js';

describe('foldPosExprDelta', () => {
  it('appends a delta to a pristine expression', () => {
    expect(foldPosExprDelta('jx + (L)*cos(60*pi/180)', 25)).toBe('jx + (L)*cos(60*pi/180) + 25');
    expect(foldPosExprDelta('jx', -12.5)).toBe('jx - 12.5');
  });
  it('merges into an existing depth-0 trailing constant (no residue accumulation)', () => {
    expect(foldPosExprDelta('jx + 25', 5)).toBe('jx + 30');
    expect(foldPosExprDelta('jx + 25', -30)).toBe('jx - 5');
    expect(foldPosExprDelta('jx - 10', 4)).toBe('jx - 6');
  });
  it('a cancelling merge restores the pristine expression', () => {
    const dragged = foldPosExprDelta('jx + (L)*cos(60*pi/180)', 25);
    expect(foldPosExprDelta(dragged, -25)).toBe('jx + (L)*cos(60*pi/180)');
  });
  it('never merges into parenthesized or function-arg constants', () => {
    expect(foldPosExprDelta('a*(b + 2)', 5)).toBe('a*(b + 2) + 5');
    expect(foldPosExprDelta('jx + cos(a + 3)', 5)).toBe('jx + cos(a + 3) + 5');
  });
  it('sci-notation tails are appended-to, never corrupted', () => {
    const out = foldPosExprDelta('jx + 1e-3', 5);
    expect(evalExpr(out, { jx: 0 })).toBeCloseTo(5.001, 9);
  });
  it('numeric equivalence holds for arbitrary folds', () => {
    const pv = { jx: 7, L: 200 };
    for (const [e, d] of [['jx + (L)*cos(60*pi/180)', 33.25], ['jx - 4', -2.5], ['0.5*L + jx - 10', 10]]) {
      expect(evalExpr(foldPosExprDelta(e, d), pv)).toBeCloseTo(evalExpr(e, pv) + d, 6);
    }
  });
  it('zero / non-finite deltas are no-ops', () => {
    expect(foldPosExprDelta('jx + 5', 0)).toBe('jx + 5');
    expect(foldPosExprDelta('jx + 5', NaN)).toBe('jx + 5');
  });
});

describe('isPosExprActive', () => {
  const snaps = [{ from: { compId: 'p', anchor: 'C' }, to: { compId: 'child', anchor: 'C' }, dx: '0', dy: '0' }];
  it('true for an unsnapped root with an expr', () => {
    expect(isPosExprActive({ id: 'a', kind: 'rect', cxExpr: 'jx + 1' }, snaps)).toBe(true);
  });
  it('false for snap-bound comps, booleans, and expr-less comps', () => {
    expect(isPosExprActive({ id: 'child', kind: 'rect', cxExpr: 'jx' }, snaps)).toBe(false);
    expect(isPosExprActive({ id: 'b', kind: 'boolean', cxExpr: 'jx' }, snaps)).toBe(false);
    expect(isPosExprActive({ id: 'c', kind: 'rect' }, snaps)).toBe(false);
    expect(isPosExprActive({ id: 'd', kind: 'rect', cxExpr: '   ' }, snaps)).toBe(false);
  });
});

describe('drag/nudge end-to-end through the solver', () => {
  const mkComps = () => ([{
    transforms: [], id: 'arm', kind: 'rect', layer: 'electrode',
    cx: 100, cy: 50, cxExpr: 'jx + (L)*cos(60*pi/180)', cyExpr: 'jy + 50',
    w: '20', h: '10', cutouts: [],
  }]);
  const pv = { jx: 0, jy: 0, L: 200 };

  it('the folded expression lands the part where it was dropped', () => {
    const comps = mkComps();
    const solved0 = solveLayout(comps, [], pv);
    const base = { cx: solved0[0].cx, cy: solved0[0].cy, cxExpr: comps[0].cxExpr, cyExpr: comps[0].cyExpr };
    const moved = translateWithPosExprs(comps[0], base, 30, -12, true);
    const solved = solveLayout([moved], [], pv);
    expect(solved[0].cx).toBeCloseTo(100 + 30, 6);
    expect(solved[0].cy).toBeCloseTo(50 - 12, 6);
  });

  it('stays parametric: a param sweep still moves the dragged part', () => {
    const comps = mkComps();
    const moved = translateWithPosExprs(comps[0], comps[0], 30, 0, true);
    const swept = solveLayout([moved], [], { ...pv, jx: 500 });
    expect(swept[0].cx).toBeCloseTo(500 + 100 + 30, 6);
  });

  it('re-folding from the drag-start base is idempotent (live drag frames)', () => {
    const comps = mkComps();
    const base = { cx: 100, cy: 50, cxExpr: comps[0].cxExpr, cyExpr: comps[0].cyExpr };
    let c = comps[0];
    for (const d of [5, 12, 30]) c = translateWithPosExprs(c, base, d, 0, true); // frames re-fold from base
    expect(c.cxExpr).toBe('jx + (L)*cos(60*pi/180) + 30');
    expect(solveLayout([c], [], pv)[0].cx).toBeCloseTo(130, 6);
  });

  it('inactive exprs (snap-bound) keep the plain numeric translate', () => {
    const c = { transforms: [], id: 'child', kind: 'rect', layer: 'electrode', cx: 0, cy: 0, cxExpr: 'jx', w: '10', h: '10', cutouts: [] };
    const moved = translateWithPosExprs(c, c, 7, 3, false);
    expect(moved.cxExpr).toBe('jx'); // untouched
    expect(moved.cx).toBe(7);
  });
});
