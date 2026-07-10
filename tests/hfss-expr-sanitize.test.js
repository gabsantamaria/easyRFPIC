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
});
