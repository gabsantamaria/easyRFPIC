// Per-component "exclude from export" (exportExclude): canvas-only
// features — reference outlines, construction geometry, kept alternates.
// The flag folds into the NON-MODEL contract (section lines / gdsundef):
// excluded components still solve, snap, and render (ghosted), but every
// physical exporter skips them. Consumed operands' own flag is INERT —
// the consuming boolean's flag governs the whole cluster (an
// individually-excluded operand would silently corrupt the exported
// boolean). Snap chains THROUGH an excluded parent stay parametric
// (computeParametricPositions runs on solvedAll, same as section lines).
import { describe, it, expect } from 'vitest';
import { normalizeScene, isNonModelComponent } from '../src/scene/schema.js';
import { resolveParams, evalExpr } from '../src/scene/params.js';
import { solveLayout } from '../src/scene/solver.js';
import { generateHfssNative, stripUnitsForGuard, computeParametricPositions } from '../src/export/hfss-native.js';
import { generatePyAEDT } from '../src/export/pyaedt.js';
import { generateGDS } from '../src/export/gds.js';
import { buildScene3D } from '../src/scene/scene3d.js';

const rect = (id, cx, cy, extra = {}) => ({
  transforms: [], id, kind: 'rect', layer: 'electrode', cx, cy, w: '20', h: '10', cutouts: [], ...extra,
});
const mkScene = () => normalizeScene({
  params: { gap: { expr: '5', unit: 'µm' } },
  components: [
    rect('keep', 0, 0),
    rect('ghost', 200, 0, { exportExclude: true }),
    rect('child', 300, 0),
  ],
  // child snaps THROUGH the excluded parent — the chain must stay live
  snaps: [{ id: 's1', from: { compId: 'ghost', anchor: 'E' }, to: { compId: 'child', anchor: 'W' }, dx: 'gap', dy: '0' }],
});

describe('exportExclude semantics', () => {
  it('normalizeScene syncs the flag across boolean clusters from the root', () => {
    expect(isNonModelComponent({ id: 'a', kind: 'rect', layer: 'electrode', exportExclude: true })).toBe(true);
    expect(isNonModelComponent({ id: 'a', kind: 'rect', layer: 'electrode' })).toBe(false);
    const sc = normalizeScene({
      params: {},
      components: [
        // stray operand flag + non-excluded root → CLEARED (self-heals)
        rect('op1', 0, 0, { consumedBy: 'u1', exportExclude: true }),
        rect('op2', 10, 0, { consumedBy: 'u1' }),
        { id: 'u1', kind: 'boolean', op: 'union', operandIds: ['op1', 'op2'], layer: 'electrode', cx: 5, cy: 0, w: '0', h: '0', cutouts: [], transforms: [] },
        // excluded root → operands INHERIT the flag
        rect('op3', 0, 50, { consumedBy: 'u2' }),
        rect('op4', 10, 50, { consumedBy: 'u2' }),
        { id: 'u2', kind: 'boolean', op: 'union', operandIds: ['op3', 'op4'], layer: 'electrode', cx: 5, cy: 50, w: '0', h: '0', cutouts: [], transforms: [], exportExclude: true },
      ],
      snaps: [],
    });
    const by = Object.fromEntries(sc.components.map(c => [c.id, c]));
    expect(!!by.op1.exportExclude).toBe(false);
    expect(!!by.op3.exportExclude).toBe(true);
    expect(!!by.op4.exportExclude).toBe(true);
  });

  it('flag survives normalizeScene', () => {
    const sc = mkScene();
    expect(sc.components.find(c => c.id === 'ghost').exportExclude).toBe(true);
  });

  it('HFSS native: excluded part not emitted; snap THROUGH it stays parametric', () => {
    const sc = mkScene();
    const pv = resolveParams(sc.params).values;
    const script = generateHfssNative(sc, pv, {});
    expect(script).toContain('"keep"');
    expect(script).not.toContain('Name:=", "ghost"');
    expect(script).toContain('"child"');
    // parametric chain through the ghost parent references `gap`
    const solved = solveLayout(sc.components, sc.snaps, pv);
    const pp = computeParametricPositions(solved, sc.snaps, pv, {});
    expect(pp.child.cxExpr).toContain('gap');
    const child = solved.find(c => c.id === 'child');
    expect(evalExpr(stripUnitsForGuard(pp.child.cxExpr), pv)).toBeCloseTo(child.cx, 6);
  });

  it('pyAEDT + GDS + 3-D skip excluded parts', () => {
    const sc = mkScene();
    const pv = resolveParams(sc.params).values;
    const py = generatePyAEDT(sc, pv);
    expect(py).not.toMatch(/"ghost"|'ghost'/);
    const gdsA = generateGDS(sc, pv);
    const scIncluded = normalizeScene(JSON.parse(JSON.stringify({ ...sc, components: sc.components.map(c => ({ ...c, exportExclude: false })) })));
    const gdsB = generateGDS(scIncluded, pv);
    expect(gdsB.length).toBeGreaterThan(gdsA.length); // ghost boundary absent
    const { solids } = buildScene3D(sc, pv);
    expect(solids.some(s => s.compId === 'ghost')).toBe(false);
    expect(solids.some(s => s.compId === 'keep')).toBe(true);
  });

  it('excluding a BOOLEAN drops the whole cluster from the HFSS script', () => {
    const sc = normalizeScene({
      params: {},
      components: [
        rect('a1', 0, 0, { consumedBy: 'u1' }),
        rect('a2', 10, 0, { consumedBy: 'u1' }),
        { id: 'u1', kind: 'boolean', op: 'union', operandIds: ['a1', 'a2'], layer: 'electrode', cx: 5, cy: 0, w: '0', h: '0', cutouts: [], transforms: [], exportExclude: true },
        rect('keep', 100, 100),
      ],
      snaps: [],
    });
    const pv = {};
    const script = generateHfssNative(sc, pv, {});
    expect(script).not.toContain('Name:=", "a1"');
    expect(script).not.toContain('Name:=", "a2"');
    expect(script).toContain('"keep"');
  });
});
