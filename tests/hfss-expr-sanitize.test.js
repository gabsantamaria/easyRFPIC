// AEDT expression sanitization — the unary-plus / deg-trig emission fix.
//
// AEDT's expression parser REJECTS unary plus: "(+(x))*sin(a)" fails with
// "Expected a value ... Instead found this: +(...)". evalExpr accepts unary
// plus, so a scene carrying "+(w/2 + g)" in a cxExpr looked correct on the
// canvas while EVERY emitted HFSS position failed to parse (a real shipped
// import failure — the double-Y balun asterisk fragment). The fix routes
// every emitted length expression through sanitizeLenExpr in
// generateHfssNative: degToRad → simplifyExpr (self-guarded) →
// stripUnaryPlus backstop. These tests pin the contract.
import { describe, it, expect } from 'vitest';
import { simplifyExpr, degToRad } from '../src/scene/expr-simplify.js';
import { evalExpr } from '../src/scene/params.js';
import { normalizeScene } from '../src/scene/schema.js';
import { resolveParams } from '../src/scene/params.js';
import { solveLayout } from '../src/scene/solver.js';
import { resolvePolylineVertices } from '../src/geometry/polyline.js';
import { generateHfssNative, hfssAngleDegExpr } from '../src/export/hfss-native.js';

// A '+' is unary iff it follows an opening context: start, '(', ',', or
// another operator. (Binary '+' is always preceded by an operand: \w or ')'.)
const hasUnaryPlus = (s) => /(^|[(,*/+\-])\s*\+(?=\s*[A-Za-z0-9_(.])/.test(s);

describe('degToRad (now canonical in expr-simplify.js)', () => {
  it('converts both HFSS deg forms to evalExpr-scoreable radians', () => {
    expect(degToRad('cos(120deg)')).toBe('cos((120*pi/180))');
    expect(degToRad('cos(((rot1))*1deg)')).toBe('cos(((rot1))*(pi/180))');
    const v = evalExpr(degToRad('cos(120deg)'), {});
    expect(v).toBeCloseTo(Math.cos((120 * Math.PI) / 180), 12);
  });
  it('cross-section re-export stays available', async () => {
    const cs = await import('../src/scene/cross-section.js');
    expect(cs.degToRad('90deg')).toBe('(90*pi/180)');
  });
});

describe('simplifyExpr drops unary plus and collapses noise', () => {
  it('kills the exact AEDT-fatal form', () => {
    const out = simplifyExpr('(+(a/2 + b))');
    expect(hasUnaryPlus(out)).toBe(false);
    for (const a of [1, 3.7]) {
      expect(evalExpr(out, { a, b: 2 })).toBeCloseTo(a / 2 + 2, 9);
    }
  });
  it('handles the REAL failing expression from the AEDT log', () => {
    // Verbatim (shortened tail) from the user's import errors — mixed
    // unary plus AND deg-typed trig in one position expression.
    const real = '((jy + (((cw/2 + cg + fw + ps/2 + pw)/sin(60*pi/180)) + (Lc)/2)*sin(120*pi/180) + (+(ps/2 + pw/2))*cos(120*pi/180))) + ((-(Lc)/2)*sin(120deg) + ((pw)/2)*cos(120deg))';
    const out = simplifyExpr(degToRad(real));
    expect(hasUnaryPlus(out)).toBe(false);
    expect(out).not.toMatch(/deg\b/);
    const pv = { jy: 3, cw: 20, cg: 12, fw: 60, ps: 4, pw: 50, Lc: 250 };
    expect(evalExpr(out, pv)).toBeCloseTo(evalExpr(degToRad(real), pv), 6);
    // And it actually SHRANK (the user's readability complaint).
    expect(out.length).toBeLessThan(real.length / 2);
  });
});

describe('hfssAngleDegExpr simplifies its unitless inner', () => {
  it('folds parenthesized numerics to the literal-deg branch', () => {
    expect(hfssAngleDegExpr('(60)')).toBe('60deg');
    expect(hfssAngleDegExpr('60 + 30')).toBe('90deg');
    expect(hfssAngleDegExpr('rot1')).toBe('(rot1)*1deg');
  });
  it('strips unary plus even when the never-expand gate bails (adversarial-review find)', () => {
    // simplifyExpr('+rot/2') bails ('0.5*rot' is longer... now rescued by
    // the unary-plus cruft rule, but the backstop must hold regardless).
    expect(hasUnaryPlus(hfssAngleDegExpr('+rot/2'))).toBe(false);
    expect(hasUnaryPlus(hfssAngleDegExpr('+(a1/b1/c1)'))).toBe(false);
    expect(hasUnaryPlus(hfssAngleDegExpr('+rot-5'))).toBe(false);
  });
});

describe('adversarial-review regressions', () => {
  it('never-expand gate no longer preserves unary plus (cruft rule)', () => {
    for (const e of ['+x/2', '+(w/2+g)', '+(a1/b1/c1)', '+rot-5']) {
      const out = simplifyExpr(e);
      expect(hasUnaryPlus(out)).toBe(false);
      const pv = { x: 3, w: 4, g: 5, a1: 2, b1: 3, c1: 5, rot: 7 };
      expect(evalExpr(out, pv)).toBeCloseTo(evalExpr(e, pv), 9);
    }
  });
  it('tiny coefficients survive (no silent fold-to-zero under the probe floor)', () => {
    const out = simplifyExpr('1.5e-12*LL');
    expect(evalExpr(out, { LL: 5 })).toBeCloseTo(7.5e-12, 20);
    const out2 = simplifyExpr('(a - a + 1.5e-12) * X');
    expect(evalExpr(out2, { a: 3, X: 2 })).toBeCloseTo(3e-12, 20);
  });
  it('sci-notation rescued by the cruft rule into a safe form', () => {
    const out = simplifyExpr('1e-3*LL');
    expect(evalExpr(out, { LL: 5 })).toBeCloseTo(5e-3, 12);
    // Either plain decimal or e-notation is fine — but never bail-then-
    // spaceHyphens-split (checked end-to-end below).
  });
});

describe('generateHfssNative emits AEDT-parseable expressions', () => {
  const buildScene = () => normalizeScene({
    params: {
      jx: { expr: '0', unit: 'µm' },
      w1: { expr: '20', unit: 'µm' },
      g1: { expr: '12', unit: 'µm' },
      L1: { expr: '200', unit: 'µm' },
    },
    components: [
      // Rotated rect whose root position carries UNARY PLUS + trig —
      // the balun failure class, verbatim in spirit.
      {
        transforms: [], id: 'arm', kind: 'rect', layer: 'electrode',
        cx: 100, cy: 173.2,
        cxExpr: 'jx + (+(L1))*cos(60*pi/180)',
        cyExpr: 'jx + (+(L1))*sin(60*pi/180)',
        rotation: '60', w: 'L1', h: 'w1', cutouts: [],
      },
      // Plain rect with unary plus in a dimension.
      {
        transforms: [], id: 'pad', kind: 'rect', layer: 'electrode',
        cx: 0, cy: 0, w: '+(w1 + 2*g1)', h: 'w1', cutouts: [],
      },
      // Polyshape with a snap vertex pinned to the ROTATED rect (the
      // CoverLine failure class: raw parametricPos + cos(60deg) anchor
      // wrap) plus rel steps carrying unary plus and a zero step.
      {
        transforms: [], id: 'wedge', kind: 'polyshape', layer: 'electrode',
        cx: 0, cy: 0, w: '0', h: '0', closed: true, cutouts: [],
        vertices: [
          { kind: 'snap', compId: 'arm', anchor: 'NW' },
          { kind: 'snap', compId: 'arm', anchor: 'SW' },
          { kind: 'rel', dx: '+(g1)*cos(60*pi/180)', dy: 'g1*sin(180*pi/180)' },
          { kind: 'rel', dx: '0', dy: '-(w1)' },
        ],
      },
    ],
    snaps: [],
  });

  it('no unary plus, no deg-typed trig in PLPoints, python-safe', () => {
    const scene = buildScene();
    const pv = resolveParams(scene.params).values;
    const script = generateHfssNative(scene, pv, {});
    // THE contract: nothing AEDT's parser rejects.
    expect(script).not.toMatch(/\(\s*\+/);
    // Position expressions must not carry deg-typed trig (folded/radians).
    const plPts = script.match(/PLPoint[^\n]*/g) || [];
    expect(plPts.length).toBeGreaterThan(0);
    for (const ln of plPts) expect(ln).not.toMatch(/deg\b/);
  });

  it('emitted wedge vertices evaluate EXACTLY to the solver, incl. under a sweep', () => {
    const scene = buildScene();
    const stripUm = (s) => s.replace(/(\d|\))\s*um\b/g, '$1');
    const pv = resolveParams(scene.params).values;
    const script = generateHfssNative(scene, pv, {});
    const hdr = script.indexOf('# wedge: polygon-path');
    expect(hdr).toBeGreaterThan(0);
    const pts = [...script.slice(hdr, hdr + 8000)
      .matchAll(/\["NAME:PLPoint", "X:=", "([^"]+)", "Y:=", "([^"]+)"/g)];
    // Base params AND a retuned set (the HFSS-side sweep) must both match
    // a fresh canvas solve — parametricity, not just frozen numerics.
    for (const params of [scene.params,
      { ...scene.params, g1: { expr: '9', unit: 'µm' }, w1: { expr: '26', unit: 'µm' } }]) {
      const pvK = resolveParams(params).values;
      const solved = solveLayout(scene.components, scene.snaps, pvK);
      const byId = Object.fromEntries(solved.map(c => [c.id, c]));
      const verts = resolvePolylineVertices(solved.find(c => c.id === 'wedge'), byId, pvK);
      expect(pts.length).toBeGreaterThanOrEqual(verts.length);
      for (let i = 0; i < verts.length; i++) {
        expect(evalExpr(stripUm(pts[i][1]), pvK)).toBeCloseTo(verts[i][0], 5);
        expect(evalExpr(stripUm(pts[i][2]), pvK)).toBeCloseTo(verts[i][1], 5);
      }
    }
  });

  it('set_var values are sanitized too', () => {
    const scene = buildScene();
    scene.params.g1 = { expr: '+(12)', unit: 'µm' };
    const pv = resolveParams(scene.params).values;
    const script = generateHfssNative(scene, pv, {});
    const m = script.match(/set_var\("g1", "([^"]+)"\)/);
    expect(m).toBeTruthy();
    expect(hasUnaryPlus(m[1])).toBe(false);
    expect(evalExpr(m[1].replace(/um$/, ''), {})).toBe(12);
  });

  it('set_var: never-expand-gate bail path still drops unary plus (review find)', () => {
    const scene = buildScene();
    scene.params.badp = { expr: '+(w1/2/g1)', unit: '' };
    const pv = resolveParams(scene.params).values;
    const script = generateHfssNative(scene, pv, {});
    const m = script.match(/set_var\("badp", "([^"]+)"\)/);
    expect(m).toBeTruthy();
    expect(hasUnaryPlus(m[1])).toBe(false);
  });

  it('sci-notation survives the transform-chain Move (spaceHyphens must not split e-3)', () => {
    const scene = buildScene();
    scene.components.push({
      transforms: [{ id: 't1', kind: 'displace', enabled: true, dx: '1e-3*L1', dy: '0' }],
      id: 'sci', kind: 'rect', layer: 'electrode',
      cx: 500, cy: 500, w: '10', h: '10', cutouts: [],
    });
    const pv = resolveParams(scene.params).values;
    const script = generateHfssNative(scene, pv, {});
    expect(script).not.toMatch(/\d[eE]\s+-\s+\d/); // the '1e - 3' corruption
    // The cruft rule rescues '1e-3*L1' into '0.001*L1' (or keeps a glued
    // e-form) — either way the displace Move must evaluate to 1e-3*200.
    const line = script.split('\n').find(l =>
      l.includes('TranslateVectorX') && (l.includes('0.001*L1') || l.includes('1e-3*L1')));
    expect(line).toBeTruthy();
    const expr = line.match(/TranslateVectorX:=",\s*"([^"]+)"/)[1];
    expect(evalExpr(expr.replace(/(\d|\))\s*um\b/g, '$1'), pv)).toBeCloseTo(0.2, 9); // 1e-3*200
  });

  it('bare additive constants in length exprs get um-typed (the 10-meters port bug)', () => {
    // AEDT resolves a bare number mixed with length-typed variables in a
    // NON-µm unit (SI/default) — a "- 10" inset in a port cxExpr put the
    // sheet ~10 m off its integration line ("port line endpoints must lie
    // on the port" + Parasolid size-box, a real shipped import failure).
    const scene = buildScene();
    scene.components.push({
      transforms: [], id: 'inset', kind: 'rect', layer: 'electrode',
      cx: 140, cy: 0, cxExpr: 'L1/2 - 10', cyExpr: '0', w: '15', h: '4', cutouts: [],
    });
    const pv = resolveParams(scene.params).values;
    const script = generateHfssNative(scene, pv, {});
    const line = script.split('\n').find(l => /X(?:Start|Position):=/.test(l) && l.includes('L1') && l.includes('10'));
    expect(line).toContain('(10*1um)');
    const expr = line.match(/X(?:Start|Position):=", "([^"]+)"/)[1];
    const strip = (s) => s.replace(/\*\s*1um\b/g, '*1').replace(/(\d|\))\s*um\b/g, '$1');
    expect(evalExpr(strip(expr), pv)).toBeCloseTo(100 - 10 - 7.5, 6); // L1/2 - 10 - w/2
  });

  it('um-typed param with a mixed expr gets its constant tagged; unitless does not', () => {
    const scene = buildScene();
    scene.params.rib_w = { expr: 'w1 + 0.6', unit: 'µm' };
    scene.params.n_cells = { expr: 'w1/10 + 2', unit: '' };
    const pv = resolveParams(scene.params).values;
    const script = generateHfssNative(scene, pv, {});
    expect(script.match(/set_var\("rib_w", "([^"]+)"\)/)[1]).toContain('(0.6*1um)');
    expect(script.match(/set_var\("n_cells", "([^"]+)"\)/)[1]).not.toContain('1um');
  });

  it('constants inside function args stay untagged (dimensionless trig context)', () => {
    const scene = buildScene();
    scene.components.push({
      transforms: [], id: 'trg', kind: 'rect', layer: 'electrode',
      cx: 170, cy: 0, cxExpr: 'jx + w1*cos(w1/40 + 1)', cyExpr: '0', w: '10', h: '4', cutouts: [],
    });
    const pv = resolveParams(scene.params).values;
    const script = generateHfssNative(scene, pv, {});
    const line = script.split('\n').find(l => /X(?:Start|Position):=/.test(l) && l.includes('cos('));
    expect(line).toBeTruthy();
    expect(line).not.toMatch(/cos\([^)]*1um/); // arg untouched
  });

  it('transform rotate: RotateAngle carries no unary plus (was raw ascii(t.angle))', () => {
    const scene = buildScene();
    scene.params.rot_a = { expr: '45', unit: '' };
    scene.components.push({
      transforms: [{ id: 't1', kind: 'rotate', enabled: true, angle: '+(rot_a)', pivot: 'origin' }],
      id: 'spun', kind: 'rect', layer: 'electrode',
      cx: 600, cy: 0, w: '10', h: '10', cutouts: [],
    });
    const pv = resolveParams(scene.params).values;
    const script = generateHfssNative(scene, pv, {});
    const rot = script.split('\n').filter(l => l.includes('RotateAngle'));
    expect(rot.length).toBeGreaterThan(0);
    for (const l of rot) expect(hasUnaryPlus(l.split('RotateAngle:=')[1])).toBe(false);
    expect(script).toContain('rot_a'); // still parametric
  });
});
