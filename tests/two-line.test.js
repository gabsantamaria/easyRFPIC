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
    // C is a design variable (emitted via set_var by the exporter), NOT an output var.
    expect(m.tl_C_F_per_m).toBeUndefined();
    expect(m.tl_Z0_re).toBe('tl_gim/(tl_TwoPiF*tl_C_F_per_m)'); // Re Z0 = β/(ωC)
    expect(m.tl_Z0_im).toBe('-tl_gre/(tl_TwoPiF*tl_C_F_per_m)'); // Im Z0 = -α/(ωC)
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

    // Discrete sweep forced (per-point eigenvalue math).
    expect(scene.simSetup.sweepEnabled).toBe(true);
    expect(scene.simSetup.sweepType).toBe('Discrete');
    expect(warnings).toBeDefined();
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
    // Discrete sweep present so the report context "Setup1 : Sweep" exists.
    expect(py).toContain('InsertFrequencySweep');
  });

  it('without options.twoLine, the script carries no tl_ output variables', () => {
    const scene = makeLineScene(500);
    const pv = resolveParams(scene.params).values;
    const py = generateHfssNative(scene, pv);
    expect(py).not.toContain('CreateOutputVariable');
    expect(py).not.toContain('tl_eeff');
  });

  it('with cFperM, emits the Z₀ vars (referencing the C set_var) + Z0 report; without, none', () => {
    const { scene, portIndices, dLMeters } = buildTwoLineScene(makeLineScene(500), {
      lengthParam: 'Lc', l1: 300, l2: 900,
    });
    const pv = resolveParams(scene.params).values;
    const withC = generateHfssNative(scene, pv, { twoLine: { portIndices, dLMeters, cFperM: 1.6e-10 } });
    expect(withC).toContain('tl_Z0_re');
    expect(withC).toContain('set_var("tl_C_F_per_m", "0.00000000016")'); // editable design var
    expect(withC).toContain('"Z0 vs Freq"');
    const noC = generateHfssNative(scene, pv, { twoLine: { portIndices, dLMeters } });
    expect(noC).not.toContain('tl_Z0_re');
    expect(noC).not.toContain('"Z0 vs Freq"');
  });

  it('bundled q3d: appends a Q3D design in the same project + C placeholder; parses', () => {
    const single = makeLineScene(500);
    const { scene, portIndices, dLMeters } = buildTwoLineScene(single, {
      lengthParam: 'Lc', l1: 300, l2: 900,
    });
    const pv = resolveParams(scene.params).values;
    const py = generateHfssNative(scene, pv, {
      twoLine: { portIndices, dLMeters, q3d: { scene: single, conductorIds: ['line'], thicknessUm: 0.2, freqStartGHz: 1, freqStopGHz: 40, freqPoints: 101 } },
    });
    expect(py).toContain('InsertDesign("HFSS"');            // the 2-line design
    expect(py).toContain('InsertDesign("Q3D Extractor"');   // bundled in same project
    expect(py).toContain('set_var("tl_C_F_per_m"');         // placeholder, Q3D sets it
    expect(py).toContain('tl_Z0_re');                       // Z0 still emitted
    expect(py).toContain('AssignSignalNet');                // explicit nets
    expect(py).toContain('SweepAlongVector');               // thin conductors
    expect(py).toContain('InsertSweep');                    // freq sweep
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
    expect(q).toContain('set_var("q3d_line_len_um", "500")');
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
    // Auto-generated C-per-length PLOT. The report engine (unlike the design
    // output-var parser) DOES accept C(net,net) arithmetic; baked length in
    // metres → F/m. lengthUm=500 → /0.0005.
    expect(q).toContain('GetModule("ReportSetup")');
    expect(q).toContain('CreateReport("C_per_length_F_per_m", "Matrix", "Rectangular Plot"');
    expect(q).toContain('"Context:=", "Original"');
    expect(q).toContain('((C(net_line,net_line)+C(net_padL,net_padL))/2-C(net_line,net_padL))/2)/0.0005');
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

  it('throws when no conductor is selected', () => {
    expect(() => generateQ3DCapacitance(makeLineScene(500), resolveParams(makeLineScene(500).params).values, { conductorIds: [] }))
      .toThrow(/at least one line conductor/i);
  });
});
