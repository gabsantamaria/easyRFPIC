// C8 (parametric root position: cxExpr / cyExpr) + C9 (custom (px, py)
// rotate pivot) coverage.
//
// C8: an UNSNAPPED component may carry cxExpr / cyExpr (expression
// strings, µm). The solver applies them on every solve (so editing the
// referenced param moves the part); snap-bound components ignore them
// (the snap wins). The native HFSS export uses the expressions as the
// ROOT of the parametric position chain, so every snapped child
// inherits the referenced parameters.
//
// C9: rotate transforms accept pivot='custom' with px / py expression
// strings (world µm). expandTransforms rotates each instance about the
// explicit point; the native HFSS export emits translate-rotate-
// translate with PARAMETRIC px/py; pyAEDT bakes numerics + comment.
import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import { writeFileSync, mkdirSync } from 'fs';
import { solveLayout } from '../src/scene/solver.js';
import { expandTransforms } from '../src/scene/transforms.js';
import { normalizeScene, makeDefaultScene, paramsForStack } from '../src/scene/schema.js';
import { renameIdentInScene } from '../src/scene/rename-ident.js';
import { tokenizeComponentExprs, resolveParams } from '../src/scene/params.js';
import { generateHfssNative, computeParametricPositions } from '../src/export/hfss-native.js';
import { generatePyAEDT } from '../src/export/pyaedt.js';

const defaultScene = makeDefaultScene();

// Minimal scene factory on the default stack (stack params get nominal
// defaults so layer Z math behaves; explicit `params` win).
const mkScene = (components, snaps = [], params = {}) => ({
  params: { ...paramsForStack(defaultScene.stack), ...params },
  components,
  snaps,
  mirrors: [], groups: [], booleans: [],
  stack: defaultScene.stack,
  stackName: defaultScene.stackName,
  simSetup: defaultScene.simSetup,
});

const mkRect = (id, extra = {}) => ({
  id, kind: 'rect', layer: 'electrode', cx: 0, cy: 0,
  w: '20', h: '10', cutouts: [], transforms: [], ...extra,
});

describe('C8: cxExpr/cyExpr in the solver', () => {
  it('root with cxExpr solves to the param value and re-solves after a param change', () => {
    const c = mkRect('root', { cx: 5, cy: 7, cxExpr: 'chip_w/2', cyExpr: 'chip_h/4' });
    const s1 = solveLayout([c], [], { chip_w: 200, chip_h: 80 });
    expect(s1[0].cx).toBeCloseTo(100, 9);
    expect(s1[0].cy).toBeCloseTo(20, 9);
    // Param edit → next solve moves the part (expressions re-applied
    // each solve, NOT baked at creation time).
    const s2 = solveLayout([c], [], { chip_w: 300, chip_h: 80 });
    expect(s2[0].cx).toBeCloseTo(150, 9);
    expect(s2[0].cy).toBeCloseTo(20, 9);
  });

  it('a numeric drag is overwritten by cxExpr on the next solve', () => {
    // Simulates drag-then-resolve: stored numeric cx differs from the
    // expression value; the solve snaps it back.
    const c = mkRect('root', { cx: 999, cy: -999, cxExpr: '50', cyExpr: '25' });
    const s = solveLayout([c], [], {});
    expect(s[0].cx).toBeCloseTo(50, 9);
    expect(s[0].cy).toBeCloseTo(25, 9);
  });

  it('snap-bound component IGNORES cxExpr/cyExpr (snap wins)', () => {
    const parent = mkRect('p', { cx: 0, cy: 0 });
    const child = mkRect('c', {
      cx: 123, cy: 456, w: '4', h: '4',
      cxExpr: 'chip_w/2', cyExpr: 'chip_w/2',
    });
    const snaps = [{ id: 's1', from: { compId: 'p', anchor: 'E' }, to: { compId: 'c', anchor: 'W' }, dx: '0', dy: '0' }];
    const solved = solveLayout([parent, child], snaps, { chip_w: 1000 });
    const sc = solved.find(x => x.id === 'c');
    // Parent E = (10, 0); child W local = (-2, 0) → center (12, 0).
    // NOT chip_w/2 = 500.
    expect(sc.cx).toBeCloseTo(12, 9);
    expect(sc.cy).toBeCloseTo(0, 9);
  });

  it('cyExpr alone works; missing cxExpr keeps the stored numeric cx', () => {
    const c = mkRect('root', { cx: 33, cy: 0, cyExpr: 'gap_v' });
    const s = solveLayout([c], [], { gap_v: -12.5 });
    expect(s[0].cx).toBeCloseTo(33, 9);
    expect(s[0].cy).toBeCloseTo(-12.5, 9);
  });

  it('a child snapped to a cxExpr root tracks the expression value', () => {
    const parent = mkRect('p', { cx: 0, cy: 0, cxExpr: 'chip_w/2' });
    const child = mkRect('c', { cx: 0, cy: 0, w: '4', h: '4' });
    const snaps = [{ id: 's1', from: { compId: 'p', anchor: 'E' }, to: { compId: 'c', anchor: 'W' }, dx: '0', dy: '0' }];
    const solved = solveLayout([parent, child], snaps, { chip_w: 200 });
    const sc = solved.find(x => x.id === 'c');
    // p center = 100, p.E = 110, child W local −2 → child cx = 112.
    expect(sc.cx).toBeCloseTo(112, 9);
  });
});

describe('C8: cxExpr/cyExpr in the native HFSS export', () => {
  it('unsnapped rect with cxExpr: param name lands in the root position; a snapped child inherits it', () => {
    const s = mkScene(
      [
        mkRect('host', { cx: 100, cy: 0, cxExpr: 'chip_w/2', cyExpr: '0' }),
        mkRect('kid', { cx: 130, cy: 0, w: '4', h: '4' }),
      ],
      [{ id: 's1', from: { compId: 'host', anchor: 'E' }, to: { compId: 'kid', anchor: 'W' }, dx: '0', dy: '0' }],
      { chip_w: { expr: '200', unit: 'µm' } },
    );
    const { values: pv } = resolveParams(s.params);
    // The chain itself: root cxExpr seeds the whole downstream chain.
    const solved = solveLayout(s.components, s.snaps, pv);
    const pp = computeParametricPositions(solved, s.snaps, pv);
    expect(pp.host.cxExpr).toContain('chip_w');
    expect(pp.kid.cxExpr).toContain('chip_w');
    // The emitted script: host's position vars carry the param name, and
    // the kid's emission (which chains through host) does too.
    const out = generateHfssNative(s, pv);
    const hostIdx = out.indexOf('"Name:=", "host"');
    expect(hostIdx).toBeGreaterThan(0);
    const hostBlock = out.slice(Math.max(0, hostIdx - 2500), hostIdx);
    expect(hostBlock).toContain('chip_w');
    const kidIdx = out.indexOf('"Name:=", "kid"');
    expect(kidIdx).toBeGreaterThan(0);
    const kidBlock = out.slice(Math.max(0, kidIdx - 2500), kidIdx);
    expect(kidBlock).toContain('chip_w');
  });

  it('snap-bound component does NOT use its own cxExpr in the export chain', () => {
    const s = mkScene(
      [
        mkRect('p', { cx: 0, cy: 0 }),
        mkRect('c', { cx: 12, cy: 0, w: '4', h: '4', cxExpr: 'stray_param' }),
      ],
      [{ id: 's1', from: { compId: 'p', anchor: 'E' }, to: { compId: 'c', anchor: 'W' }, dx: '0', dy: '0' }],
      { stray_param: { expr: '500', unit: 'µm' } },
    );
    const { values: pv } = resolveParams(s.params);
    const solved = solveLayout(s.components, s.snaps, pv);
    const pp = computeParametricPositions(solved, s.snaps, pv);
    expect(pp.c.cxExpr).not.toContain('stray_param');
  });

  it('bare-numeric cxExpr gets a um tag at the chain root', () => {
    const solved = solveLayout([mkRect('r', { cxExpr: '42' })], [], {});
    const pp = computeParametricPositions(solved, [], {});
    expect(pp.r.cxExpr).toBe('42um');
  });
});

describe('C9: custom (px, py) rotate pivot in expandTransforms', () => {
  it('matches manual rotation math about the explicit world point', () => {
    const c = mkRect('r1', {
      cx: 10, cy: 0,
      transforms: [{ id: 't1', kind: 'rotate', enabled: true, angle: '90', pivot: 'custom', px: 'piv_x', py: '0' }],
    });
    const insts = expandTransforms([c], { piv_x: 4 });
    expect(insts).toHaveLength(1);
    // Rotate (10, 0) 90° CCW about (4, 0): delta (6, 0) → (0, 6) → (4, 6).
    expect(insts[0].cx).toBeCloseTo(4, 9);
    expect(insts[0].cy).toBeCloseTo(6, 9);
    expect(insts[0].rotation).toBeCloseTo(90, 9);
  });

  it('parametric angle + pivot: arbitrary angle matches the rotation matrix', () => {
    const angle = 37, px = -3, py = 8, cx = 12, cy = -5;
    const c = mkRect('r1', {
      cx, cy,
      transforms: [{ id: 't1', kind: 'rotate', enabled: true, angle: 'a', pivot: 'custom', px: 'px0', py: 'py0' }],
    });
    const [inst] = expandTransforms([c], { a: angle, px0: px, py0: py });
    const rad = angle * Math.PI / 180;
    const ca = Math.cos(rad), sa = Math.sin(rad);
    expect(inst.cx).toBeCloseTo(px + (cx - px) * ca - (cy - py) * sa, 9);
    expect(inst.cy).toBeCloseTo(py + (cx - px) * sa + (cy - py) * ca, 9);
  });

  it('repeated cluster rotates as a rigid body about the one shared point', () => {
    const c = mkRect('r1', {
      cx: 0, cy: 0,
      transforms: [
        { id: 't1', kind: 'repeat', enabled: true, n: '1', dx: '10', dy: '0', includeOriginal: true },
        { id: 't2', kind: 'rotate', enabled: true, angle: '90', pivot: 'custom', px: '0', py: '0' },
      ],
    });
    const insts = expandTransforms([c], {});
    expect(insts).toHaveLength(2);
    // (0,0) → (0,0); (10,0) → (0,10): same world pivot for every instance.
    expect(insts[0].cx).toBeCloseTo(0, 9);
    expect(insts[0].cy).toBeCloseTo(0, 9);
    expect(insts[1].cx).toBeCloseTo(0, 9);
    expect(insts[1].cy).toBeCloseTo(10, 9);
  });
});

describe('C9: custom pivot in the exporters', () => {
  const pivotScene = () => mkScene(
    [mkRect('rot_part', {
      cx: 10, cy: 0,
      transforms: [{ id: 't1', kind: 'rotate', enabled: true, angle: '90', pivot: 'custom', px: 'piv_x', py: 'piv_y' }],
    })],
    [],
    { piv_x: { expr: '4', unit: 'µm' }, piv_y: { expr: '0', unit: 'µm' } },
  );

  it('native HFSS emission contains the px/py param names in the translate-rotate-translate', () => {
    const s = pivotScene();
    const { values: pv } = resolveParams(s.params);
    const out = generateHfssNative(s, pv);
    const idx = out.indexOf('Transforms for rot_part');
    expect(idx).toBeGreaterThan(0);
    const block = out.slice(idx, idx + 2500);
    // Pre-translate by -(px), rotate, translate back by (px) — parametric.
    expect(block).toContain('piv_x');
    expect(block).toContain('piv_y');
    expect(block).toContain('-((piv_x))');
    expect(block).toContain('oEditor.Rotate(');
    expect((block.match(/oEditor\.Move\(/g) || []).length).toBeGreaterThanOrEqual(2);
  });

  it('native HFSS + pyAEDT scripts ast.parse as Python', () => {
    const s = pivotScene();
    // Also exercise C8 in the same scripts.
    s.components.push(mkRect('posexpr_part', { cx: 0, cy: 30, cxExpr: 'piv_x*2' }));
    const { values: pv } = resolveParams(s.params);
    const hfss = generateHfssNative(s, pv);
    const py = generatePyAEDT(s, pv);
    mkdirSync('tests/out', { recursive: true });
    writeFileSync('tests/out/vitest_hfss_posexpr_pivot.py', hfss);
    writeFileSync('tests/out/vitest_pyaedt_posexpr_pivot.py', py);
    expect(() => execSync(
      `python3 -c "import ast; ast.parse(open('tests/out/vitest_hfss_posexpr_pivot.py').read())"`,
      { stdio: 'pipe' },
    )).not.toThrow();
    expect(() => execSync(
      `python3 -c "import ast; ast.parse(open('tests/out/vitest_pyaedt_posexpr_pivot.py').read())"`,
      { stdio: 'pipe' },
    )).not.toThrow();
  });

  it('pyAEDT bakes the custom pivot numerically with a comment', () => {
    const s = pivotScene();
    const { values: pv } = resolveParams(s.params);
    const out = generatePyAEDT(s, pv);
    expect(out).toContain('custom pivot (px=piv_x, py=piv_y)');
    // translate-rotate-translate with the evaluated pivot (4, 0).
    expect(out).toContain('["-4.0000um", "0.0000um", "0um"]');
    expect(out).toContain('["4.0000um", "0.0000um", "0um"]');
  });

  it('pyAEDT comments on baked cxExpr/cyExpr', () => {
    const s = mkScene([mkRect('px_part', { cx: 0, cy: 0, cxExpr: 'chip_w/2' })], [], { chip_w: { expr: '200', unit: 'µm' } });
    const { values: pv } = resolveParams(s.params);
    const out = generatePyAEDT(s, pv);
    expect(out).toContain('px_part: position expression (cxExpr=chip_w/2');
  });
});

describe('C8/C9: schema normalization, rename walker, tokenizer', () => {
  it('normalizeScene coerces numeric cxExpr/cyExpr to strings', () => {
    const s = normalizeScene(mkScene([mkRect('a', { cxExpr: 42, cyExpr: -7.5 })]));
    const a = s.components.find(c => c.id === 'a');
    expect(a.cxExpr).toBe('42');
    expect(a.cyExpr).toBe('-7.5');
  });

  it('normalizeScene defaults px/py to "0" on custom-pivot rotates and coerces numerics', () => {
    const s = normalizeScene(mkScene([
      mkRect('a', { transforms: [{ id: 't1', kind: 'rotate', enabled: true, angle: '90', pivot: 'custom' }] }),
      mkRect('b', { transforms: [{ id: 't2', kind: 'rotate', enabled: true, angle: '90', pivot: 'custom', px: 3, py: 4 }] }),
      mkRect('c', { transforms: [{ id: 't3', kind: 'rotate', enabled: true, angle: '90', pivot: 'C' }] }),
    ]));
    const a = s.components.find(c => c.id === 'a');
    expect(a.transforms[0].px).toBe('0');
    expect(a.transforms[0].py).toBe('0');
    const b = s.components.find(c => c.id === 'b');
    expect(b.transforms[0].px).toBe('3');
    expect(b.transforms[0].py).toBe('4');
    // Non-custom pivots don't grow phantom px/py.
    const cc = s.components.find(c => c.id === 'c');
    expect(cc.transforms[0].px).toBeUndefined();
  });

  it('renameIdentInScene rewrites cxExpr/cyExpr and transform px/py', () => {
    const scene = mkScene([
      mkRect('a', {
        cxExpr: 'chip_w/2', cyExpr: 'chip_w + gap',
        transforms: [{ id: 't1', kind: 'rotate', enabled: true, angle: '45', pivot: 'custom', px: 'chip_w', py: 'gap - chip_w' }],
      }),
    ], [], { chip_w: { expr: '200', unit: 'µm' }, gap: { expr: '5', unit: 'µm' } });
    const out = renameIdentInScene(scene, 'chip_w', 'die_w');
    const a = out.components.find(c => c.id === 'a');
    expect(a.cxExpr).toBe('die_w/2');
    expect(a.cyExpr).toBe('die_w + gap');
    expect(a.transforms[0].px).toBe('die_w');
    expect(a.transforms[0].py).toBe('gap - die_w');
    // Word-boundary safety: chip_w2 untouched.
    const scene2 = mkScene([mkRect('b', { cxExpr: 'chip_w2' })]);
    const out2 = renameIdentInScene(scene2, 'chip_w', 'die_w');
    expect(out2.components.find(c => c.id === 'b').cxExpr).toBe('chip_w2');
  });

  it('tokenizeComponentExprs collects idents from cxExpr/cyExpr/px/py', () => {
    const c = mkRect('a', {
      cxExpr: 'chip_w/2', cyExpr: 'off_y',
      transforms: [{ id: 't1', kind: 'rotate', enabled: true, angle: 'tilt', pivot: 'custom', px: 'piv_x', py: 'piv_y' }],
    });
    const ids = tokenizeComponentExprs(c);
    for (const name of ['chip_w', 'off_y', 'piv_x', 'piv_y', 'tilt']) {
      expect(ids).toContain(name);
    }
  });
});
