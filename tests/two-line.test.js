// Marks' 2-line method wizard (src/scene/twoLine.js + the generateHfssNative
// options.twoLine hook). Three contracts:
//   1. twoLineExtractNumeric recovers γ (hence α, εeff) from synthetic ideal-line
//      S-parameters — the numeric reference the HFSS output-variable exprs mirror.
//   2. buildTwoLineScene stamps a single parametric line twice (lineA=tl_L1,
//      lineB=tl_L2), produces exactly 4 lumped ports grouped (A,A,B,B) in
//      solved order, and keeps both lengths parametric.
//   3. The native HFSS script generated with options.twoLine parses as Python
//      and carries the εeff/α output variables + reports.
import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import { writeFileSync, mkdirSync } from 'fs';
import {
  buildTwoLineScene, twoLineOutputVariables, twoLineExtractNumeric,
  TL_L1, TL_L2, TL_DL,
} from '../src/scene/twoLine.js';
import { generateHfssNative } from '../src/export/hfss-native.js';
import { generateQ3DCapacitance } from '../src/export/q3d.js';
import { makeDefaultScene, normalizeScene, paramsForStack } from '../src/scene/schema.js';
import { resolveParams, evalExpr } from '../src/scene/params.js';
import { solveLayout } from '../src/scene/solver.js';

const defaults = makeDefaultScene();

// ---------------------------------------------------------------------------
// A single PARAMETRIC transmission line: a central signal conductor of length
// `Lc`, a port at each end (flanked EW by the conductor and a launch pad), with
// positions driven by SNAPS so changing Lc re-flows the whole structure. This
// is the shape the wizard expects (length param flows through HFSS).
//   padL ]-[ port1 ]-[ ===== line (Lc) ===== ]-[ port2 ]-[ padR
function makeLineScene(Lc = 500) {
  const comp = (id, extra) => ({ id, kind: 'rect', cutouts: [], transforms: [], ...extra });
  const components = [
    comp('line', { layer: 'electrode', cx: 0, cy: 0, w: 'Lc', h: '6' }),
    comp('port1', { layer: 'port', cx: -260, cy: 0, w: '2', h: '6', lumpedPort: { enabled: true, impedance: '50' } }),
    comp('port2', { layer: 'port', cx: 260, cy: 0, w: '2', h: '6', lumpedPort: { enabled: true, impedance: '50' } }),
    comp('padL', { layer: 'electrode', cx: -270, cy: 0, w: '10', h: '8' }),
    comp('padR', { layer: 'electrode', cx: 270, cy: 0, w: '10', h: '8' }),
  ];
  const snaps = [
    { id: 's1', from: { compId: 'line', anchor: 'W' }, to: { compId: 'port1', anchor: 'E' }, dx: '0', dy: '0' },
    { id: 's2', from: { compId: 'line', anchor: 'E' }, to: { compId: 'port2', anchor: 'W' }, dx: '0', dy: '0' },
    { id: 's3', from: { compId: 'port1', anchor: 'W' }, to: { compId: 'padL', anchor: 'E' }, dx: '0', dy: '0' },
    { id: 's4', from: { compId: 'port2', anchor: 'E' }, to: { compId: 'padR', anchor: 'W' }, dx: '0', dy: '0' },
  ];
  return normalizeScene({
    params: { ...paramsForStack(defaults.stack), Lc: { expr: String(Lc), unit: 'µm', desc: 'line length' } },
    components, snaps, mirrors: [], groups: [], booleans: [],
    stack: defaults.stack, stackName: defaults.stackName, simSetup: defaults.simSetup,
  });
}

// ---------------------------------------------------------------------------
describe('twoLineExtractNumeric — recovers γ from synthetic ideal lines', () => {
  // Build the 2-port S-block of a uniform line of length L: matched-at-ends
  // (Z0 ≠ Zref → reflections) so S11/S21 are non-trivial and the extraction
  // must do real cascade algebra.
  const C = (re, im = 0) => ({ re, im });
  const mul = (a, b) => C(a.re * b.re - a.im * b.im, a.re * b.im + a.im * b.re);
  const add = (a, b) => C(a.re + b.re, a.im + b.im);
  const sub = (a, b) => C(a.re - b.re, a.im - b.im);
  const div = (a, b) => { const d = b.re * b.re + b.im * b.im; return C((a.re * b.re + a.im * b.im) / d, (a.im * b.re - a.re * b.im) / d); };
  const neg = (a) => C(-a.re, -a.im);
  const cexp = (z) => { const e = Math.exp(z.re); return C(e * Math.cos(z.im), e * Math.sin(z.im)); };

  const c = 2.99792458e8, eeff = 6.5, Z0 = 45, Zref = 50, alpha = 12; // α in Np/m
  function lineS(L, fHz) {
    const w = 2 * Math.PI * fHz, beta = (w / c) * Math.sqrt(eeff);
    const gamma = C(alpha, beta);
    const G = div(sub(C(Z0), C(Zref)), add(C(Z0), C(Zref)));
    const e = cexp(neg(mul(gamma, C(L)))), e2 = mul(e, e);
    const den = sub(C(1), mul(mul(G, G), e2));
    const S11 = div(mul(G, sub(C(1), e2)), den);
    const S21 = div(mul(sub(C(1), mul(G, G)), e), den);
    return { S11, S21, S12: S21, S22: S11 };
  }

  it('extracts α and εeff at 10 GHz', () => {
    const f = 10e9, L1 = 1e-3, L2 = 2.7e-3, w = 2 * Math.PI * f;
    const r = twoLineExtractNumeric(lineS(L1, f), lineS(L2, f), L2 - L1, f);
    expect(r.alpha).toBeCloseTo(alpha, 4);
    // εeff returned is the complex-consistent value (c/ω)²(β²−α²) — α adds a tiny
    // correction below εeff; assert against that exact definition.
    const expected = eeff - (alpha * c / w) ** 2;
    expect(r.eeff).toBeCloseTo(expected, 4);
  });

  it('is robust across the band (Δl chosen so βΔl < π)', () => {
    for (const f of [5e9, 20e9, 40e9]) {
      const L1 = 0.5e-3, L2 = 1.0e-3; // βΔl at 40 GHz ≈ 0.5mm·(ω/c)√eeff < π
      const r = twoLineExtractNumeric(lineS(L1, f), lineS(L2, f), L2 - L1, f);
      expect(r.alpha).toBeCloseTo(alpha, 3);
    }
  });
});

// ---------------------------------------------------------------------------
describe('twoLineOutputVariables — εeff/α expression list', () => {
  const vars = twoLineOutputVariables({ a1: 1, a2: 2, b1: 3, b2: 4 }, 6e-4);
  const byName = Object.fromEntries(vars.map((v) => [v.name, v.expr]));

  it('references the correct S-indices for each line', () => {
    expect(byName.tl_TA22).toBe('1/S(2,1)'); // line A uses ports 1,2
    expect(byName.tl_TB22).toBe('1/S(4,3)'); // line B uses ports 3,4
  });

  it('emits sign-free outputs (abs for α, even-in-γ for εeff)', () => {
    expect(byName.tl_alpha_Np_per_m).toBe('abs(tl_gre)');
    expect(byName.tl_alpha_dB_per_m).toContain('8.685889638');
    expect(byName.tl_eeff).toContain('tl_gim*tl_gim-tl_gre*tl_gre');
  });

  it('Δl is a baked numeric LITERAL in metres — NOT the unit-ambiguous tl_dL var', () => {
    // tl_dL is an HFSS length variable → resolves to metres in report exprs;
    // `tl_dL*1e-6` would double-convert (εeff×1e12). The literal avoids that.
    expect(byName.tl_DeltaL_m).toBe('0.0006');
    expect(byName.tl_DeltaL_m).not.toMatch(/tl_dL/);
    expect(byName.tl_DeltaL_m).not.toMatch(/e-/i); // plain decimal, no exponent
  });

  it('appends Z₀ = γ/(jωC) rows only when includeZ0; they reference the C variable', () => {
    const noZ0 = twoLineOutputVariables({ a1: 1, a2: 2, b1: 3, b2: 4 });
    expect(noZ0.some((v) => v.name === 'tl_Z0_re')).toBe(false);
    const withZ0 = twoLineOutputVariables({ a1: 1, a2: 2, b1: 3, b2: 4 }, 6e-4, true);
    const m = Object.fromEntries(withZ0.map((v) => [v.name, v.expr]));
    // C is a post-processing variable (set by the exporter), NOT an output var.
    expect(m.tl_C_F_per_m).toBeUndefined();
    // Z0 must be SIGN-FREE: the eigenvalue method resolves γ only up to a global
    // sign, so re/im γ must be abs()'d or Re Z0 = β/(ωC) flips negative.
    expect(m.tl_Z0_re).toBe('abs(tl_gim)/(tl_TwoPiF*tl_C_F_per_m)'); // Re Z0 = β/(ωC) ≥ 0
    expect(m.tl_Z0_im).toBe('-abs(tl_gre)/(tl_TwoPiF*tl_C_F_per_m)'); // Im Z0 = -α/(ωC) ≤ 0
    expect(m.tl_Z0_mag).toContain('sqrt(tl_gre*tl_gre+tl_gim*tl_gim)');
  });

  it('is in dependency order (every referenced output var is defined earlier)', () => {
    // No design-variable references remain in the output-var exprs now (Δl is a
    // literal); every tl_ reference must be an output var defined by an earlier row.
    const defined = new Set();
    for (const v of vars) {
      const refs = (v.expr.match(/tl_[A-Za-z0-9_]+/g) || []);
      for (const r of refs) expect(defined.has(r)).toBe(true);
      defined.add(v.name);
    }
  });
});

describe('2-line Δl unit bug — εeff stays physical (~6, not ~1e12)', () => {
  it('correct Δl in metres recovers εeff≈6.5; the old tl_dL*1e-6 double-convert blows up', () => {
    // Synthetic ideal line, L1=300µm, L2=900µm (Δl=600µm=6e-4 m).
    const C = (re, im = 0) => ({ re, im });
    const mul = (a, b) => C(a.re * b.re - a.im * b.im, a.re * b.im + a.im * b.re);
    const add = (a, b) => C(a.re + b.re, a.im + b.im);
    const sub = (a, b) => C(a.re - b.re, a.im - b.im);
    const div = (a, b) => { const d = b.re * b.re + b.im * b.im; return C((a.re * b.re + a.im * b.im) / d, (a.im * b.re - a.re * b.im) / d); };
    const neg = (a) => C(-a.re, -a.im);
    const cexp = (z) => { const e = Math.exp(z.re); return C(e * Math.cos(z.im), e * Math.sin(z.im)); };
    const c = 2.99792458e8, f = 10e9, w = 2 * Math.PI * f, eeff = 6.5, Z0 = 45, Zref = 50, alpha = 12;
    const beta = (w / c) * Math.sqrt(eeff), gamma = C(alpha, beta);
    const lineS = (L) => {
      const G = div(sub(C(Z0), C(Zref)), add(C(Z0), C(Zref)));
      const e = cexp(neg(mul(gamma, C(L)))), e2 = mul(e, e);
      const den = sub(C(1), mul(mul(G, G), e2));
      const S11 = div(mul(G, sub(C(1), e2)), den);
      const S21 = div(mul(sub(C(1), mul(G, G)), e), den);
      return { S11, S21, S12: S21, S22: S11 };
    };
    const dL = 600e-6; // metres
    const good = twoLineExtractNumeric(lineS(300e-6), lineS(900e-6), dL, f);
    expect(good.eeff).toBeCloseTo(eeff - (alpha * c / w) ** 2, 2);
    expect(good.alpha).toBeCloseTo(alpha, 2);
    // The old bug (Δl off by 1e6) inflates εeff by ~1e12 — guard the magnitude.
    const bug = twoLineExtractNumeric(lineS(300e-6), lineS(900e-6), dL * 1e-6, f);
    expect(bug.eeff).toBeGreaterThan(1e11);
  });
});

// ---------------------------------------------------------------------------
describe('buildTwoLineScene — 4-port two-line design', () => {
  it('stamps the line twice with parametric lengths and 4 grouped ports', () => {
    const { scene, portIndices, portNames, warnings } = buildTwoLineScene(makeLineScene(500), {
      lengthParam: 'Lc', l1: 300, l2: 900, freqStart: 1, freqStop: 40, freqPoints: 201,
    });
    expect(portIndices).toEqual({ a1: 1, a2: 2, b1: 3, b2: 4 });
    expect(portNames).toHaveLength(4);

    // Both injected length params present and parametric (Δl = L2 − L1).
    expect(scene.params[TL_L1].expr).toBe('300');
    expect(scene.params[TL_L2].expr).toBe('900');
    expect(scene.params[TL_DL].expr).toBe(`${TL_L2} - ${TL_L1}`);

    // Exactly 4 enabled lumped ports, two per line instance.
    const ports = scene.components.filter((c) => c.layer === 'port' && c.lumpedPort && c.lumpedPort.enabled);
    expect(ports).toHaveLength(4);
    const insts = ports.map((c) => c.cellInstance && c.cellInstance.inst);
    expect(insts.filter((i) => i === 'lineA')).toHaveLength(2);
    expect(insts.filter((i) => i === 'lineB')).toHaveLength(2);

    // The two lines genuinely differ in length after solving (parametric flow).
    const pv = resolveParams(scene.params).values;
    const solved = solveLayout(scene.components, scene.snaps, pv);
    const lineA = solved.find((c) => c.id === 'lineA_line');
    const lineB = solved.find((c) => c.id === 'lineB_line');
    expect(evalExpr(lineA.w, pv)).toBeCloseTo(300, 6);
    expect(evalExpr(lineB.w, pv)).toBeCloseTo(900, 6);

    // Interpolating sweep (eigenvalue math runs on the interpolated S).
    expect(scene.simSetup.sweepEnabled).toBe(true);
    expect(scene.simSetup.sweepType).toBe('Interpolating');
    expect(warnings).toBeDefined();
  });

  it('bakes the wizard min/max passes into simSetup and the HFSS setup emits them', () => {
    const { scene, portIndices, dLMeters } = buildTwoLineScene(makeLineScene(500), {
      lengthParam: 'Lc', l1: 300, l2: 900, minPass: 15, maxPass: 20,
    });
    expect(scene.simSetup.maxPasses).toBe('20');
    expect(scene.simSetup.minPasses).toBe('15');
    const pv = resolveParams(scene.params).values;
    const py = generateHfssNative(scene, pv, { twoLine: { portIndices, dLMeters } });
    expect(py).toContain('"MaximumPasses:=", 20');
    expect(py).toContain('"MinimumPasses:=", 15');
    expect(py).toContain('"Type:=", "Interpolating"');
  });

  it('clamps minPass to maxPass (HFSS requires MinimumPasses ≤ MaximumPasses)', () => {
    const { scene } = buildTwoLineScene(makeLineScene(500), {
      lengthParam: 'Lc', l1: 300, l2: 900, minPass: 30, maxPass: 12,
    });
    expect(scene.simSetup.maxPasses).toBe('12');
    expect(scene.simSetup.minPasses).toBe('12'); // clamped down
  });

  it('Δl uses the ACTUAL-length expression (default = the param) — fixes the count-param case', () => {
    const scene = makeLineScene(500); // length param Lc (a direct µm length)
    // Default lengthExpr = the param itself ⇒ Δl = L2 − L1 (correct for a direct length).
    const r1 = buildTwoLineScene(scene, { lengthParam: 'Lc', l1: 300, l2: 900 });
    expect(r1.dLMeters).toBeCloseTo((900 - 300) * 1e-6, 12);
    // If the param were a COUNT and the actual length were 10× it, Δl must use
    // the EXPRESSION (10*Lc), not the raw L2−L1: 10× larger.
    const r2 = buildTwoLineScene(scene, { lengthParam: 'Lc', l1: 300, l2: 900, lengthExpr: '10*Lc' });
    expect(r2.dLMeters).toBeCloseTo(10 * (900 - 300) * 1e-6, 12);
    // A derived param re-resolves when the length param is overridden at L1/L2.
    const r3 = buildTwoLineScene(scene, { lengthParam: 'Lc', l1: 300, l2: 900, lengthExpr: 'Lc/2' });
    expect(r3.dLMeters).toBeCloseTo(0.5 * (900 - 300) * 1e-6, 12);
  });

  it('rejects a length param the line does not use', () => {
    expect(() => buildTwoLineScene(makeLineScene(), { lengthParam: 'nope', l1: 300, l2: 900 }))
      .toThrow(/not a parameter/i);
  });

  it('rejects a design without exactly 4 ports', () => {
    // Drop one port → instances yield only 2 ports total.
    const s = makeLineScene();
    s.components = s.components.filter((c) => c.id !== 'port2');
    s.snaps = s.snaps.filter((sn) => sn.to.compId !== 'port2' && sn.from.compId !== 'port2');
    expect(() => buildTwoLineScene(s, { lengthParam: 'Lc', l1: 300, l2: 900 }))
      .toThrow(/4 lumped ports/i);
  });

  it('rejects mismatched port impedances', () => {
    const s = makeLineScene();
    s.components = s.components.map((c) => c.id === 'port2'
      ? { ...c, lumpedPort: { enabled: true, impedance: '75' } } : c);
    expect(() => buildTwoLineScene(s, { lengthParam: 'Lc', l1: 300, l2: 900 }))
      .toThrow(/same reference impedance/i);
  });
});

// ---------------------------------------------------------------------------
// Real single-line designs place their two ports by REPEATING one port
// component (and the feed that flanks it), and often leave the lumped-port flag
// off. The wizard must materialize the replicas into distinct ports and
// auto-enable flanked port rects. Two structures exercised:
//   (1) repeat-replica ports flanked by repeated plain electrodes;
//   (2) a port sitting in a PUNCH gap whose feed boolean is itself repeated
//       (the cross-cluster cloneOf case).
describe('buildTwoLineScene — auto-handles repeat-replica ports', () => {
  // (1) port + W/E flankers, all repeated by L; lumped port NOT pre-enabled.
  function repeatPortScene(L = 200) {
    const comp = (id, extra) => ({ id, kind: 'rect', cutouts: [], transforms: [], ...extra });
    const rep = () => [{ id: 'rp', kind: 'repeat', enabled: true, n: '1', dx: 'L', dy: '0', includeOriginal: true }];
    const components = [
      comp('p', { layer: 'port', cx: 0, cy: 0, w: '4', h: '4', transforms: rep() }),
      comp('wE', { layer: 'electrode', cx: -7, cy: 0, w: '10', h: '4', transforms: rep() }),
      comp('eE', { layer: 'electrode', cx: 7, cy: 0, w: '10', h: '4', transforms: rep() }),
    ];
    return normalizeScene({
      params: { ...paramsForStack(defaults.stack), L: { expr: String(L), unit: 'µm', desc: 'length' } },
      components, snaps: [], mirrors: [], groups: [], booleans: [],
      stack: defaults.stack, stackName: defaults.stackName, simSetup: defaults.simSetup,
    });
  }

  it('expands repeat replicas + auto-enables → 4 ports grouped A,A,B,B', () => {
    const { scene, portIndices } = buildTwoLineScene(repeatPortScene(200), {
      lengthParam: 'L', l1: 200, l2: 600, freqStart: 1, freqStop: 40, freqPoints: 101,
    });
    expect(portIndices).toEqual({ a1: 1, a2: 2, b1: 3, b2: 4 });
    const ports = scene.components.filter((c) => c.layer === 'port' && c.lumpedPort && c.lumpedPort.enabled);
    expect(ports).toHaveLength(4);
    const insts = ports.map((c) => c.cellInstance && c.cellInstance.inst);
    expect(insts.filter((i) => i === 'lineA')).toHaveLength(2);
    expect(insts.filter((i) => i === 'lineB')).toHaveLength(2);
    const pv = resolveParams(scene.params).values;
    const py = generateHfssNative(scene, pv, { twoLine: { portIndices } });
    expect((py.match(/AssignLumpedPort/g) || []).length).toBe(4);
  });

  // (2) the user's structure: port in a punched gap, feed boolean repeated.
  function punchPortScene(L = 200) {
    const comp = (id, extra) => ({ id, kind: 'rect', cutouts: [], transforms: [], ...extra });
    const rep = (id) => [{ id, kind: 'repeat', enabled: true, n: '1', dx: 'L', dy: '0', includeOriginal: true }];
    const components = [
      comp('bar', { layer: 'electrode', cx: 0, cy: 0, w: '8', h: '40', consumedBy: 'pn' }),
      comp('toolClone', { layer: 'electrode', cx: 0, cy: 0, w: '8', h: '8', consumedBy: 'pn', cloneOf: 'prt' }),
      comp('prt', { layer: 'port', cx: 0, cy: 0, w: '8', h: '8', transforms: rep('rp1') }),
      { id: 'pn', kind: 'boolean', op: 'punch', operandIds: ['bar', 'toolClone'], layer: 'electrode',
        cx: 0, cy: 0, w: '0', h: '0', cutouts: [], label: '', transforms: rep('rp2') },
    ];
    return normalizeScene({
      params: { ...paramsForStack(defaults.stack), L: { expr: String(L), unit: 'µm', desc: 'length' } },
      components, snaps: [], mirrors: [], groups: [], booleans: [],
      stack: defaults.stack, stackName: defaults.stackName, simSetup: defaults.simSetup,
    });
  }

  it('punch-gap port with a repeated feed boolean → 4 ports (cross-cluster cloneOf)', () => {
    const { scene, portIndices } = buildTwoLineScene(punchPortScene(200), {
      lengthParam: 'L', l1: 200, l2: 600, freqStart: 1, freqStop: 40, freqPoints: 101,
    });
    const ports = scene.components.filter((c) => c.layer === 'port' && c.lumpedPort && c.lumpedPort.enabled);
    expect(ports).toHaveLength(4);
    const pv = resolveParams(scene.params).values;
    const py = generateHfssNative(scene, pv, { twoLine: { portIndices } });
    expect((py.match(/AssignLumpedPort/g) || []).length).toBe(4);
  });

  // (3) a mirrored electrode boolean (the meander analog) alongside the ports.
  // Bug: flattenReplicas materialized the repeat but DROPPED the in-place mirror,
  // so the stamped line exported UN-mirrored in HFSS (no Mirror command at all).
  function mirroredBoolScene(L = 200) {
    const comp = (id, extra) => ({ id, kind: 'rect', cutouts: [], transforms: [], ...extra });
    const rep = (id) => [{ id, kind: 'repeat', enabled: true, n: '1', dx: 'L', dy: '0', includeOriginal: true }];
    const components = [
      comp('p', { layer: 'port', cx: 0, cy: 0, w: '4', h: '4', transforms: rep('rp0') }),
      comp('wE', { layer: 'electrode', cx: -7, cy: 0, w: '10', h: '4', transforms: rep('rp1') }),
      comp('eE', { layer: 'electrode', cx: 7, cy: 0, w: '10', h: '4', transforms: rep('rp2') }),
      // Vertically ASYMMETRIC union (top + bottom bar at different cy) so a
      // y-mirror is geometrically observable; repeat THEN mirror, like a meander.
      comp('mtop', { layer: 'electrode', cx: 0, cy: 22, w: '6', h: '2', consumedBy: 'mb' }),
      comp('mbot', { layer: 'electrode', cx: 0, cy: 14, w: '6', h: '2', consumedBy: 'mb' }),
      { id: 'mb', kind: 'boolean', op: 'union', operandIds: ['mtop', 'mbot'], layer: 'electrode',
        cx: 0, cy: 18, w: '0', h: '0', cutouts: [], label: '', transforms: [
          { id: 'mbrep', kind: 'repeat', enabled: true, n: '1', dx: 'L', dy: '0', includeOriginal: true },
          { id: 'mbmir', kind: 'mirror', enabled: true, axis: 'y', pivot: 'C' },
        ] },
    ];
    return normalizeScene({
      params: { ...paramsForStack(defaults.stack), L: { expr: String(L), unit: 'µm', desc: 'length' } },
      components, snaps: [], mirrors: [], groups: [], booleans: [],
      stack: defaults.stack, stackName: defaults.stackName, simSetup: defaults.simSetup,
    });
  }

  it('preserves an in-place mirror through replica flattening → HFSS emits Mirror (regression)', () => {
    const { scene, portIndices } = buildTwoLineScene(mirroredBoolScene(200), {
      lengthParam: 'L', l1: 200, l2: 600, freqStart: 1, freqStop: 40, freqPoints: 101,
    });
    // Every materialized replica of the mirrored boolean (base + __rN) keeps the
    // mirror but NOT the repeat (which is baked into the replica positions).
    const mbRoots = scene.components.filter((c) => c.kind === 'boolean' && c.id.startsWith('lineA_mb'));
    expect(mbRoots.length).toBeGreaterThanOrEqual(2); // base + at least one replica
    for (const r of mbRoots) {
      const kinds = (r.transforms || []).map((t) => t.kind);
      expect(kinds).toContain('mirror');
      expect(kinds).not.toContain('repeat');
    }
    // The export emits a Mirror per replica, always about the trivial origin base
    // (the parametric centroid lives in the surrounding Move calls).
    const pv = resolveParams(scene.params).values;
    const py = generateHfssNative(scene, pv, { twoLine: { portIndices } });
    expect((py.match(/oEditor\.Mirror\(/g) || []).length).toBeGreaterThan(0);
    const mBaseY = [...py.matchAll(/"MirrorBaseY:=",\s*"([^"]*)"/g)].map((x) => x[1]);
    expect(mBaseY.length).toBeGreaterThan(0);
    expect(mBaseY.every((v) => v === '0um')).toBe(true);
    // And the 4-port contract still holds (the mirror is on the electrode, not a port).
    expect((py.match(/AssignLumpedPort/g) || []).length).toBe(4);
  });
});

describe('buildTwoLineScene — flattened replicas keep PARAMETRIC positions', () => {
  // Bug: flattenReplicas baked operand CENTERS numerically while keeping sizes
  // parametric, so a cell-dimension sweep (e.g. cell_h) resized the bars about
  // fixed centers → "cells deform in HFSS" (unlike the canvas). Fix: each
  // flattened operand carries cxExpr/cyExpr = its snap-chain position + the
  // symbolic replica offset, so the export emits LIVE positions.
  function paramCellScene(L = 200) {
    const comp = (id, extra) => ({ id, kind: 'rect', cutouts: [], transforms: [], ...extra });
    const rep = (id) => [{ id, kind: 'repeat', enabled: true, n: '1', dx: 'L', dy: '0', includeOriginal: true }];
    const components = [
      comp('p', { layer: 'port', cx: 0, cy: 0, w: '4', h: '4', transforms: rep('rp0') }),
      comp('wE', { layer: 'electrode', cx: -7, cy: 0, w: '10', h: '4', transforms: rep('rp1') }),
      comp('eE', { layer: 'electrode', cx: 7, cy: 0, w: '10', h: '4', transforms: rep('rp2') }),
      // A 2-rect cell: the bar is snapped ABOVE the anchor by the PARAMETRIC
      // cell_h, and the union repeats twice with a parametric pitch.
      comp('anchor', { layer: 'electrode', cx: 0, cy: 30, w: '6', h: '2', consumedBy: 'cb' }),
      comp('bar', { layer: 'electrode', cx: 0, cy: 40, w: '6', h: '2', consumedBy: 'cb' }),
      { id: 'cb', kind: 'boolean', op: 'union', operandIds: ['anchor', 'bar'], layer: 'electrode', cx: 0, cy: 35, w: '0', h: '0', cutouts: [], label: '',
        transforms: [{ id: 'cbr', kind: 'repeat', enabled: true, n: '2', dx: 'cell_w', dy: '0', includeOriginal: true }] },
    ];
    return normalizeScene({
      params: { ...paramsForStack(defaults.stack), L: { expr: String(L), unit: 'µm', desc: '' }, cell_h: { expr: '10', unit: 'µm', desc: '' }, cell_w: { expr: '20', unit: 'µm', desc: '' } },
      components,
      snaps: [{ id: 's', from: { compId: 'anchor', anchor: 'C' }, to: { compId: 'bar', anchor: 'C' }, dx: '0', dy: 'cell_h' }],
      mirrors: [], groups: [], booleans: [],
      stack: defaults.stack, stackName: defaults.stackName, simSetup: defaults.simSetup,
    });
  }

  it('operands carry cxExpr/cyExpr that reference the cell params and evaluate to the baked center', () => {
    const { scene } = buildTwoLineScene(paramCellScene(200), { lengthParam: 'L', l1: 200, l2: 600, freqStart: 1, freqStop: 40, freqPoints: 101 });
    const pv = resolveParams(scene.params).values;
    const bar = scene.components.find((c) => c.id === 'lineA_bar');
    const barR1 = scene.components.find((c) => c.id === 'lineA_bar__r1');
    expect(bar).toBeTruthy();
    expect(barR1).toBeTruthy();
    // The bar's cy is parametric in cell_h (it's snapped above the anchor by it).
    expect(bar.cyExpr).toMatch(/lineA_cell_h/);
    // cxExpr/cyExpr evaluate EXACTLY to the baked center at current params.
    expect(evalExpr(bar.cxExpr, pv)).toBeCloseTo(bar.cx, 6);
    expect(evalExpr(bar.cyExpr, pv)).toBeCloseTo(bar.cy, 6);
    // Replica r1's x is offset by ONE parametric pitch (cell_w) from the base.
    expect(barR1.cxExpr).toMatch(/lineA_cell_w/);
    expect(evalExpr(barR1.cxExpr, pv) - evalExpr(bar.cxExpr, pv)).toBeCloseTo(pv.lineA_cell_w, 6);
    // Sweep cell_h → the bar's exported cy MOVES (parametric), not just its size.
    const pv2 = resolveParams({ ...scene.params, lineA_cell_h: { ...scene.params.lineA_cell_h, expr: '40' } }).values;
    expect(evalExpr(bar.cyExpr, pv2)).not.toBeCloseTo(bar.cy, 1);
    // And the HFSS create call for the bar (a 3-D electrode box) references
    // cell_h in its Y position — i.e. the position is LIVE, not baked numeric.
    const py = generateHfssNative(scene, pv, { twoLine: { portIndices: { a1: 1, a2: 2, b1: 3, b2: 4 } } });
    const block = py.match(/safe_create_box\(\s*\["NAME:BoxParameters",[\s\S]*?"Name:=", "lineA_bar"/);
    expect(block).toBeTruthy();
    expect(block[0]).toMatch(/YPosition:=", "[^"]*lineA_cell_h/);
  });
});

// ---------------------------------------------------------------------------
// The cell closure only captures params referenced by component EXPRESSIONS, so
// stack thickness params (h_cond, h_wg, …) that nothing references would be
// dropped — and normalizeScene would then re-inject STACK DEFAULTS, silently
// overriding a design's h_cond=0 with 0.8. That both shows the wrong thickness
// AND skips the zero-thickness conductor → 2-D impedance-sheet path.
describe('buildTwoLineScene — preserves the design stack params', () => {
  it('keeps h_cond=0 (not the stack default) → conductor stays a 2-D impedance sheet', () => {
    const base = makeLineScene(500);
    const scene = normalizeScene({
      ...base,
      params: { ...base.params, h_cond: { expr: '0', unit: 'µm', desc: 'conductor thickness' } },
    });
    const { scene: built, portIndices, dLMeters } = buildTwoLineScene(scene, {
      lengthParam: 'Lc', l1: 300, l2: 900,
    });
    const pv = resolveParams(built.params).values;
    expect(pv.h_cond).toBe(0); // NOT re-defaulted to 0.8
    const py = generateHfssNative(built, pv, { twoLine: { portIndices, dLMeters } });
    expect(py).toMatch(/set_var\("h_cond", "0(\.0)?um"\)/); // zero, not 0.8um
    expect(py).toContain('PEC_sheets'); // zero-thickness sheet impedance boundary
  });

  it('keeps a non-default stack value (h_wg) instead of the stack default', () => {
    const base = makeLineScene(500);
    const scene = normalizeScene({
      ...base,
      params: { ...base.params, h_wg: { expr: '0.7363', unit: 'µm', desc: 'wg height' } },
    });
    const { scene: built } = buildTwoLineScene(scene, { lengthParam: 'Lc', l1: 300, l2: 900 });
    expect(resolveParams(built.params).values.h_wg).toBeCloseTo(0.7363, 6);
  });
});

// ---------------------------------------------------------------------------
describe('generateHfssNative options.twoLine — script emits the εeff/α math', () => {
  it('parses as Python and contains the output variables + reports', () => {
    const { scene, portIndices, dLMeters } = buildTwoLineScene(makeLineScene(500), {
      lengthParam: 'Lc', l1: 300, l2: 900, freqStart: 1, freqStop: 40, freqPoints: 201,
    });
    expect(dLMeters).toBeCloseTo(6e-4, 12);
    const pv = resolveParams(scene.params).values;
    const py = generateHfssNative(scene, pv, { twoLine: { portIndices, dLMeters } });
    // Δl baked as a metres literal — never the unit-ambiguous tl_dL*1e-6.
    expect(py).toContain('"tl_DeltaL_m", "0.0006"');
    expect(py).not.toContain('tl_dL*1e-6');

    mkdirSync('tests/out', { recursive: true });
    writeFileSync('tests/out/two_line_hfss.py', py);
    execSync('python3 -c "import ast; ast.parse(open(\'tests/out/two_line_hfss.py\').read())"');

    // Output variables for the eigenvalue extraction.
    expect(py).toContain('GetModule("OutputVariable")');
    expect(py).toContain('CreateOutputVariable');
    expect(py).toContain('tl_eeff');
    expect(py).toContain('tl_alpha_dB_per_m');
    expect(py).toContain('tl_gamma');
    // Reports.
    expect(py).toContain('GetModule("ReportSetup")');
    expect(py).toContain('"eeff vs Freq"');
    expect(py).toContain('"alpha vs Freq"');
    // The 4 lumped ports are emitted.
    expect((py.match(/AssignLumpedPort/g) || []).length).toBe(4);
    // Interpolating sweep present so the report context "Setup1 : Sweep" exists.
    expect(py).toContain('InsertFrequencySweep');
    expect(py).toContain('"Type:=", "Interpolating"');
  });

  it('without options.twoLine, the script carries no tl_ output variables', () => {
    const scene = makeLineScene(500);
    const pv = resolveParams(scene.params).values;
    const py = generateHfssNative(scene, pv);
    expect(py).not.toContain('CreateOutputVariable');
    expect(py).not.toContain('tl_eeff');
  });

  it('with cFperM, emits the Z₀ vars + a post-processing C var + Z0 report; without, none', () => {
    const { scene, portIndices, dLMeters } = buildTwoLineScene(makeLineScene(500), {
      lengthParam: 'Lc', l1: 300, l2: 900,
    });
    const pv = resolveParams(scene.params).values;
    const withC = generateHfssNative(scene, pv, { twoLine: { portIndices, dLMeters, cFperM: 1.6e-10 } });
    expect(withC).toContain('tl_Z0_re');
    // C is a POST-PROCESSING variable: editing it after a solve re-scales Z0
    // WITHOUT invalidating the field solution (it only feeds the Z0 output vars).
    expect(withC).toContain('_tl_pp_var("tl_C_F_per_m", "0.00000000016")');
    expect(withC).toContain('"PropType:=", "PostProcessingVariableProp"');
    expect(withC).not.toContain('set_var("tl_C_F_per_m"'); // NOT a design var
    expect(withC).toContain('"Z0 vs Freq"');
    const noC = generateHfssNative(scene, pv, { twoLine: { portIndices, dLMeters } });
    expect(noC).not.toContain('tl_Z0_re');
    expect(noC).not.toContain('"Z0 vs Freq"');
  });

  it('bundled q3d: appends a Q3D design + AUTO-TRANSFERS C → Z0 in the same script; parses', () => {
    const single = makeLineScene(500);
    const { scene, portIndices, dLMeters } = buildTwoLineScene(single, {
      lengthParam: 'Lc', l1: 300, l2: 900,
    });
    const pv = resolveParams(scene.params).values;
    const py = generateHfssNative(scene, pv, {
      // 2 conductors → 2 nets → differential C → the auto-transfer is emitted.
      twoLine: { portIndices, dLMeters, q3d: { scene: single, conductorIds: ['line', 'padL'], thicknessUm: 0.2, freqStartGHz: 1, freqStopGHz: 40, freqPoints: 101 } },
    });
    expect(py).toContain('InsertDesign("HFSS"');            // the 2-line design
    expect(py).toContain('InsertDesign("Q3D Extractor"');   // bundled in same project
    expect(py).toContain('_tl_pp_var("tl_C_F_per_m"');      // post-processing scale, Q3D sets it
    expect(py).toContain('tl_Z0_re');                       // Z0 still emitted
    expect(py).toContain('AssignSignalNet');                // explicit nets
    expect(py).toContain('SweepAlongVector');               // thin conductors
    expect(py).toContain('InsertSweep');                    // freq sweep
    // Auto-transfer block (no separate script/button): read C, set the post-proc
    // var, plot Re/Im Z0 — all in ONE generated script.
    expect(py).toContain('oDesign.ExportMatrixData(');
    expect(py).toContain('"Capacitance Matrix"');
    expect(py).toContain('_d[("net_line", "net_padL")]');   // C12 by net name
    expect(py).toContain('((_C11 + _C22) / 2.0 - _C12) / 2.0'); // differential C
    expect(py).toContain('1e-12 < _z0_C < 1e-8');           // loud sanity bound
    expect(py).toContain('CreateReport("Z0 re+im (from Q3D C)"');
    expect(py).toContain('["tl_Z0_re", "tl_Z0_im"]');
    expect(py).toMatch(/SetActiveDesign\("Layout"\)/);      // leaves HFSS design active
    mkdirSync('tests/out', { recursive: true });
    writeFileSync('tests/out/two_line_q3d.py', py);
    execSync('python3 -c "import ast; ast.parse(open(\'tests/out/two_line_q3d.py\').read())"');
  });
});

// ---------------------------------------------------------------------------
// Meander Z₀ route: per-length C comes from a full-3-D Q3D solve of the line
// conductors (no uniform cross-section exists for a meander). The wizard emits a
// separate Q3D script for the SELECTED line conductor(s); the user divides
// conductor-to-conductor C by physical length and feeds it back as cFperM.
describe('generateQ3DCapacitance — meander C extraction script', () => {
  it('builds a PARAMETRIC Q3D design: thin conductors, nets, sweep, CG controls; parses', () => {
    const scene = makeLineScene(500);
    const pv = resolveParams(scene.params).values;
    const q = generateQ3DCapacitance(scene, pv, {
      conductorIds: ['line', 'padL'], thicknessUm: 0.2, lengthUm: 500, // 2 conductors → C between nets
      freqStartGHz: 1, freqStopGHz: 50, freqPoints: 201,
      perError: 0.01, minPass: 15, maxPass: 20, designName: 'mtl',
    });
    expect(q).toContain('InsertDesign("Q3D Extractor"');
    expect(q).toContain('line_i0');                 // a conductor instance object
    expect(q).toMatch(/diel_/);                     // dielectric stack boxes
    // UNIT SAFETY: thickness/Z exprs reference unit-carrying vars WITHOUT
    // re-appending "um" — "(h_si)um" double-converts (h_si is already µm) to
    // picometre-thin layers. Bare numerics get the unit INSIDE: "(6um)".
    expect(q).toContain('"ZSize:=", "(h_si)"');     // variable thickness, no double unit
    expect(q).toMatch(/"ZPosition:=", "\(0um/);     // Z cursor seeded in µm, unit inside
    expect(q).not.toMatch(/\([A-Za-z_][^)]*\)um/);  // NO "(varexpr)um" double-unit anywhere
    // Parametric design variables + geometry referencing them.
    expect(q).toContain('set_var("Lc"');            // scene param declared as a Q3D var
    expect(q).toContain('set_var("q3d_cond_thk", "0.2um")');
    expect(q).toContain('set_var("q3d_line_len_um", "500um")'); // length-typed (bare number → um)
    expect(q).toContain('set_var("line_q3cx"');     // editable base position
    expect(q).toMatch(/\(line_q3cx\) \+ \(Lc\)\/2|\(Lc\)\/2/); // size from the line's w expr (Lc)
    // Thin conductor = swept sheet by the thickness VARIABLE.
    expect(q).toContain('SweepAlongVector');
    expect(q).toMatch(/safe_sweep_z\("line_i0", "q3d_cond_thk"\)/);
    // Signal nets: ONE per conductor COMPONENT (all its sheets joined), not per
    // sheet — so the C matrix is conductor-to-conductor (2 nets for 2 conductors).
    expect(q).toContain('AssignSignalNet');
    expect(q).toContain('q3d_signal_net("net_line", ["line_i0"])');
    expect(q).toContain('q3d_signal_net("net_padL", ["padL_i0"])');
    expect(q).not.toContain('net_line_i0');         // not per-object anymore
    // Capacitance setup with CG convergence controls + frequency sweep.
    expect(q).toContain('InsertSetup("Matrix"');
    expect(q).toContain('"PerError:=", 0.01');
    expect(q).toContain('"MinPass:=", 15');
    expect(q).toContain('"MaxPass:=", 20');
    expect(q).toContain('InsertSweep');
    expect(q).toContain('"1GHz"');
    expect(q).toContain('"50GHz"');
    // Solve, then EXPORT the C matrix to CSV (Q3D rejects a scripted C report/
    // output var). The differential per-length formula is printed.
    expect(q).toContain('oDesign.Analyze("Setup1")');
    expect(q).toContain('oDesign.ExportMatrixData(');  // direct matrix dump
    expect(q).toContain('"C",');                       // capacitance problem type
    expect(q).toContain('mtl_Cmatrix.csv');            // CSV named after the design
    expect(q).toContain('Results -> Solution Data -> Matrix');
    expect(q).toContain('((C11+C22)/2 - C12)/2');   // differential, in the message
    // Auto-generated C-per-length PLOT. The report engine accepts C(net,net)
    // arithmetic and divides by the q3d_line_len_um VARIABLE (so the plot tracks
    // geometry sweeps) — NOT a baked literal.
    expect(q).toContain('GetModule("ReportSetup")');
    expect(q).toContain('CreateReport("C_per_length_F_per_m", "Matrix", "Rectangular Plot"');
    expect(q).toContain('"Context:=", "Original"');
    expect(q).toContain('((C(net_line,net_line)+C(net_padL,net_padL))/2-C(net_line,net_padL))/2)/q3d_line_len_um');
    expect(q).not.toMatch(/\)\/0\.000\d/); // not a baked /<metres> literal
    expect(q).not.toContain('CreateOutputVariable');
    expect(q).not.toMatch(/abs\(C\(/);
    // Resilience: guarded logger + existence-checked delete (the abnormal-
    // termination fix), no raw oDesktop.AddMessage in the Q3D body.
    expect(q).toContain('def q3d_msg(');
    expect(q).toContain('_existing_objs()');
    expect(q).toContain('GetObjectsInGroup');
    mkdirSync('tests/out', { recursive: true });
    writeFileSync('tests/out/q3d_cap.py', q);
    execSync('python3 -c "import ast; ast.parse(open(\'tests/out/q3d_cap.py\').read())"');
  });

  it('falls back to h_cond for thickness when none supplied', () => {
    const scene = makeLineScene(500); // default stack h_cond = 0.8
    const pv = resolveParams(scene.params).values;
    const q = generateQ3DCapacitance(scene, pv, { conductorIds: ['line'] });
    expect(q).toContain('set_var("q3d_cond_thk", "0.8um")'); // swept by h_cond
  });

  it('uses the actual-length EXPRESSION as a swept Q3D variable for C/length', () => {
    const scene = makeLineScene(500);
    const pv = resolveParams(scene.params).values;
    // The line length is driven by Lc; the user enters "Lc" (the actual length).
    const q = generateQ3DCapacitance(scene, pv, { conductorIds: ['line', 'padL'], thicknessUm: 0.2, lengthExpr: 'Lc' });
    expect(q).toContain('set_var("q3d_line_len_um", "Lc")');   // expression, not a baked number
    expect(q).toContain(')/q3d_line_len_um');                  // report divides by the variable
    expect(q).not.toMatch(/\)\/0\.000\d/);                     // no baked metres literal
  });

  it('throws when no conductor is selected', () => {
    expect(() => generateQ3DCapacitance(makeLineScene(500), resolveParams(makeLineScene(500).params).values, { conductorIds: [] }))
      .toThrow(/at least one line conductor/i);
  });

  it('expands a BOOLEAN conductor (e.g. a meander union) into operand sheets under ONE net', () => {
    // Two union electrodes; one with a 3× repeat. The picker now exposes booleans
    // (a meander is a union), and buildQ3DBody must emit all operand sheets of a
    // selected boolean under a single net_<id> — not skip the boolean.
    const rect = (id, extra) => ({ id, kind: 'rect', layer: 'electrode', cutouts: [], transforms: [], ...extra });
    const boolU = (id, ops, extra) => ({ id, kind: 'boolean', op: 'union', operandIds: ops, layer: 'electrode', cx: 0, cy: 0, w: '0', h: '0', cutouts: [], transforms: [], ...extra });
    const scene = normalizeScene({
      params: paramsForStack(defaults.stack),
      components: [
        rect('a1', { cx: 0, cy: 10, w: '20', h: '2', consumedBy: 'condA' }),
        rect('a2', { cx: 0, cy: 13, w: '20', h: '2', consumedBy: 'condA' }),
        boolU('condA', ['a1', 'a2'], { cx: 0, cy: 11.5, transforms: [{ id: 'r', kind: 'repeat', enabled: true, n: '2', dx: '30', dy: '0', includeOriginal: true }] }),
        rect('b1', { cx: 0, cy: -10, w: '20', h: '2', consumedBy: 'condB' }),
        rect('b2', { cx: 0, cy: -13, w: '20', h: '2', consumedBy: 'condB' }),
        boolU('condB', ['b1', 'b2']),
      ],
      snaps: [], mirrors: [], groups: [], booleans: [],
      stack: defaults.stack, stackName: defaults.stackName, simSetup: defaults.simSetup,
    });
    const pv = resolveParams(scene.params).values;
    const q = generateQ3DCapacitance(scene, pv, { conductorIds: ['condA', 'condB'], thicknessUm: 0.2, lengthUm: 80, designName: 'mtl' });
    // condA = 2 operands × 3 repeats = 6 sheets — UNITED into ONE solid so Q3D
    // meshes it as a single net body (no internal intersection faces), then the
    // net references just the survivor (Unite keeps the first object's name).
    expect(q).toMatch(/safe_unite\(\["condA_b0"(?:, "condA_b\d+"){5}\]\)/); // all 6 united
    expect(q).toMatch(/q3d_signal_net\("net_condA", \["condA_b0"\]\)/);     // net → survivor only
    expect(q).toMatch(/safe_unite\(\["condB_b0", "condB_b1"\]\)/);          // condB's 2 sheets united
    expect(q).toMatch(/q3d_signal_net\("net_condB", \["condB_b0"\]\)/);
    expect((q.match(/condA_b\d+/g) || []).filter((s, i, a) => a.indexOf(s) === i).length).toBe(6); // all 6 still created
    expect(q).toContain('def safe_unite(');
    expect(q).toContain('((C11+C22)/2 - C12)/2'); // 2 nets → differential C
    mkdirSync('tests/out', { recursive: true });
    writeFileSync('tests/out/q3d_bool.py', q);
    execSync('python3 -c "import ast; ast.parse(open(\'tests/out/q3d_bool.py\').read())"');
  });

  it('applies an in-place mirror to a BOOLEAN conductor footprint (Q3D C uses the flipped geometry)', () => {
    // ASYMMETRIC cell: a WIDE bar on top (cy 20, w 10) + a NARROW bar on the
    // bottom (cy 8, w 4); union centroid (0, 14). A y-mirror swaps them, so the
    // wide bar moves to the BOTTOM. The Q3D footprint must reflect this — the
    // mirror was previously dropped (only warned), giving a wrong C.
    const rect = (id, extra) => ({ id, kind: 'rect', layer: 'electrode', cutouts: [], transforms: [], ...extra });
    const mk = (withMirror) => normalizeScene({
      params: paramsForStack(defaults.stack),
      components: [
        rect('a1', { cx: 0, cy: 20, w: '10', h: '2', consumedBy: 'condM' }),
        rect('a2', { cx: 0, cy: 8, w: '4', h: '2', consumedBy: 'condM' }),
        { id: 'condM', kind: 'boolean', op: 'union', operandIds: ['a1', 'a2'], layer: 'electrode', cx: 0, cy: 14, w: '0', h: '0', cutouts: [], label: '',
          transforms: withMirror ? [{ id: 'm', kind: 'mirror', enabled: true, axis: 'y', pivot: 'C' }] : [] },
        rect('g1', { cx: 60, cy: 14, w: '6', h: '26', consumedBy: 'condG' }),
        { id: 'condG', kind: 'boolean', op: 'union', operandIds: ['g1'], layer: 'electrode', cx: 60, cy: 14, w: '0', h: '0', cutouts: [], label: '', transforms: [] },
      ],
      snaps: [], mirrors: [], groups: [], booleans: [],
      stack: defaults.stack, stackName: defaults.stackName, simSetup: defaults.simSetup,
    });
    const plPts = (q) => [...q.matchAll(/"X:=", "(-?[\d.]+)um", "Y:=", "(-?[\d.]+)um"/g)].map((m) => [parseFloat(m[1]), parseFloat(m[2])]);
    const sMir = mk(true), sNo = mk(false);
    const opts = { conductorIds: ['condM', 'condG'], thicknessUm: 0.2, lengthUm: 80, designName: 'mtl' };
    const qMir = generateQ3DCapacitance(sMir, resolveParams(sMir.params).values, opts);
    const qNo = generateQ3DCapacitance(sNo, resolveParams(sNo.params).values, opts);
    // The mirror is APPLIED now — no "NOT applied" warning for it.
    expect(qMir).not.toMatch(/mirror[^\n]*NOT applied/i);
    // A wide-bar corner (|x| = 5) near the BOTTOM (y ≈ 7–9) exists ONLY when the
    // cell is mirrored; un-mirrored, the bottom bar is narrow (|x| = 2).
    const wideBottom = (pts) => pts.some(([x, y]) => Math.abs(Math.abs(x) - 5) < 0.6 && y > 6 && y < 10);
    expect(wideBottom(plPts(qMir))).toBe(true);
    expect(wideBottom(plPts(qNo))).toBe(false);
  });
});

