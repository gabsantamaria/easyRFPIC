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
  const vars = twoLineOutputVariables({ a1: 1, a2: 2, b1: 3, b2: 4 });
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

  it('Δl variable tracks tl_L2 − tl_L1 in metres', () => {
    expect(byName.tl_DeltaL_m).toBe(`${TL_DL}*1e-6`);
  });

  it('is in dependency order (every referenced output var is defined earlier)', () => {
    // The scene-level HFSS variables (tl_dL, tl_L1, tl_L2) are declared up front
    // via set_var — pre-seed them; every OTHER tl_ reference must be an
    // output variable defined by an earlier row.
    const defined = new Set(['tl_dL', 'tl_L1', 'tl_L2']);
    for (const v of vars) {
      const refs = (v.expr.match(/tl_[A-Za-z0-9_]+/g) || []);
      for (const r of refs) expect(defined.has(r)).toBe(true);
      defined.add(v.name);
    }
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
describe('generateHfssNative options.twoLine — script emits the εeff/α math', () => {
  it('parses as Python and contains the output variables + reports', () => {
    const { scene, portIndices } = buildTwoLineScene(makeLineScene(500), {
      lengthParam: 'Lc', l1: 300, l2: 900, freqStart: 1, freqStop: 40, freqPoints: 201,
    });
    const pv = resolveParams(scene.params).values;
    const py = generateHfssNative(scene, pv, { twoLine: { portIndices } });

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
});
