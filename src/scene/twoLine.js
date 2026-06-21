// Marks' 2-line method wizard — build a single HFSS design holding the user's
// transmission line at TWO lengths (4 lumped ports), so the native exporter can
// add HFSS Output Variables + reports that extract the propagation constant γ
// and from it the effective permittivity εeff and attenuation α — all math done
// IN HFSS (Marks, IEEE-MTT 1991, "A multiline method of network analyzer
// calibration", the 2-line/TRL eigenvalue formulation).
//
// Physics: for two uniform lines of lengths l1, l2 (Δl = l2−l1) measured as
// 2-port S-blocks, form the wave-cascade T of each (T11=−detS/S21, T12=S11/S21,
// T21=−S22/S21, T22=1/S21); M = T_B·T_A⁻¹; the eigenvalues of M are e^∓γΔl.
// γ = ln(λ)/Δl ⇒ α=Re γ (Np/m), β=Im γ; εeff = −(γc/ω)². Two simplifications
// that remove the need for a sign/branch conditional in HFSS expressions:
//   • εeff is EVEN in γ (depends on γ²), so either eigenvalue/branch gives the
//     same εeff: εeff = (c/ω)²·(β²−α²) = (c/ω)²·(im(γ)²−re(γ)²).
//   • α = |Re γ| (passive line), so abs() resolves the sign.
// Both verified numerically against synthetic ideal-line S-parameters.
//
// The combined scene is built by reusing the parametric-cell machinery
// (makeCellFromSelection + instantiateCell): the line is stamped twice as
// `lineA` (length = tl_L1) and `lineB` (length = tl_L2), offset apart so the two
// 2-ports don't couple. lineA's components are merged BEFORE lineB's, which —
// because HFSS numbers lumped ports in creation (= component) order — fixes the
// S-indices to 1,2 for line A and 3,4 for line B. The wizard verifies this.
import { normalizeScene } from './schema.js';
import { makeCellFromSelection, instantiateCell } from './cells.js';
import { resolveParams, evalExpr } from './params.js';
import { solveLayout } from './solver.js';
import { detectPortIntegrationLine } from './lumpedPort.js';

// New top-level param names the wizard injects. Prefixed `tl_` so they can't
// collide with a user param literally named L1/L2/dL.
export const TL_L1 = 'tl_L1';
export const TL_L2 = 'tl_L2';
export const TL_DL = 'tl_dL';

// The ordered list of HFSS Output Variables implementing the 2-line εeff/α
// extraction, given the verified 4-port S-index map. Each entry is
// { name, expr, note }; the exporter emits CreateOutputVariable in this order
// (dependency order — later rows reference earlier ones). HFSS report-expression
// syntax: S(i,j) complex, functions re/im/abs/ln/sqrt, `pi`, and the reserved
// sweep variable `Freq` (Hz).
//   pi = { a1, a2, b1, b2 } — HFSS S-indices (a1<a2 line A input/output; b1<b2
//   line B). dLVar = the HFSS variable name carrying Δl in µm (tl_dL).
export function twoLineOutputVariables(pi, dLVar = TL_DL) {
  const { a1, a2, b1, b2 } = pi;
  const S = (i, j) => `S(${i},${j})`;
  return [
    { name: 'tl_DeltaL_m', expr: `${dLVar}*1e-6`, note: 'Δl in metres (tracks tl_L2 − tl_L1)' },
    { name: 'tl_TwoPiF', expr: '2*pi*Freq', note: 'angular frequency ω (Freq is HFSS Hz)' },
    { name: 'tl_cc', expr: '2.99792458e8', note: 'speed of light, m/s' },
    // Line A wave-cascade T from its 2-port S-block (ports a1, a2).
    { name: 'tl_TA11', expr: `-(${S(a1, a1)}*${S(a2, a2)}-${S(a1, a2)}*${S(a2, a1)})/${S(a2, a1)}`, note: 'T_A 11 = -det(S_A)/S21_A' },
    { name: 'tl_TA12', expr: `${S(a1, a1)}/${S(a2, a1)}`, note: 'T_A 12' },
    { name: 'tl_TA21', expr: `-${S(a2, a2)}/${S(a2, a1)}`, note: 'T_A 21' },
    { name: 'tl_TA22', expr: `1/${S(a2, a1)}`, note: 'T_A 22' },
    // Line B wave-cascade T (ports b1, b2).
    { name: 'tl_TB11', expr: `-(${S(b1, b1)}*${S(b2, b2)}-${S(b1, b2)}*${S(b2, b1)})/${S(b2, b1)}`, note: 'T_B 11' },
    { name: 'tl_TB12', expr: `${S(b1, b1)}/${S(b2, b1)}`, note: 'T_B 12' },
    { name: 'tl_TB21', expr: `-${S(b2, b2)}/${S(b2, b1)}`, note: 'T_B 21' },
    { name: 'tl_TB22', expr: `1/${S(b2, b1)}`, note: 'T_B 22' },
    // T_A^-1 = adj(T_A)/det(T_A).
    { name: 'tl_detTA', expr: 'tl_TA11*tl_TA22-tl_TA12*tl_TA21', note: 'det(T_A)' },
    { name: 'tl_TAi11', expr: 'tl_TA22/tl_detTA', note: 'inv(T_A) 11' },
    { name: 'tl_TAi12', expr: '-tl_TA12/tl_detTA', note: 'inv(T_A) 12' },
    { name: 'tl_TAi21', expr: '-tl_TA21/tl_detTA', note: 'inv(T_A) 21' },
    { name: 'tl_TAi22', expr: 'tl_TA11/tl_detTA', note: 'inv(T_A) 22' },
    // M = T_B · T_A^-1.
    { name: 'tl_M11', expr: 'tl_TB11*tl_TAi11+tl_TB12*tl_TAi21', note: 'M 11' },
    { name: 'tl_M12', expr: 'tl_TB11*tl_TAi12+tl_TB12*tl_TAi22', note: 'M 12' },
    { name: 'tl_M21', expr: 'tl_TB21*tl_TAi11+tl_TB22*tl_TAi21', note: 'M 21' },
    { name: 'tl_M22', expr: 'tl_TB21*tl_TAi12+tl_TB22*tl_TAi22', note: 'M 22' },
    // Eigenvalue λ+ = (trM + √(trM²−4detM))/2 = e^∓γΔl.
    { name: 'tl_trM', expr: 'tl_M11+tl_M22', note: 'trace(M)' },
    { name: 'tl_detM', expr: 'tl_M11*tl_M22-tl_M12*tl_M21', note: 'det(M)' },
    { name: 'tl_disc', expr: 'tl_trM*tl_trM-4*tl_detM', note: 'eigenvalue discriminant' },
    { name: 'tl_sqrtDisc', expr: 'sqrt(tl_disc)', note: 'complex √ (branch only flips ±γ; εeff/α are sign-free)' },
    { name: 'tl_lam', expr: '(tl_trM+tl_sqrtDisc)/2', note: 'eigenvalue λ = e^∓γΔl' },
    // γ from one eigenvalue (sign/branch ambiguous — both removed below).
    { name: 'tl_gamma', expr: '-ln(tl_lam)/tl_DeltaL_m', note: 'γ = -ln(λ)/Δl (complex; ±γ either way)' },
    { name: 'tl_gre', expr: 're(tl_gamma)', note: 'Re γ' },
    { name: 'tl_gim', expr: 'im(tl_gamma)', note: 'Im γ' },
    // OUTPUTS (sign-free):
    { name: 'tl_alpha_Np_per_m', expr: 'abs(tl_gre)', note: 'attenuation α (Np/m) — |Re γ|' },
    { name: 'tl_alpha_dB_per_m', expr: '8.685889638*abs(tl_gre)', note: 'attenuation α (dB/m)' },
    { name: 'tl_eeff', expr: '(tl_cc/tl_TwoPiF)*(tl_cc/tl_TwoPiF)*(tl_gim*tl_gim-tl_gre*tl_gre)', note: 'effective permittivity εeff = (c/ω)²(β²−α²) = Re[-(γc/ω)²]' },
  ];
}

// Replicate the exporter's lumped-port filter (hfss-native.js:4291-4297) over a
// SOLVED component list, in order, to discover the port S-index map. Returns the
// ordered array of qualifying port components.
export function findLumpedPortOrder(solved, paramValues) {
  const out = [];
  for (const c of solved) {
    if (c.layer !== 'port' || c.kind !== 'rect') continue;
    if (!c.lumpedPort || !c.lumpedPort.enabled) continue;
    const det = detectPortIntegrationLine(c, solved, paramValues);
    if (!det || !det.direction) continue;
    out.push(c);
  }
  return out;
}

// Build the combined two-line scene + verified port map.
// cfg: {
//   lengthParam,        // scene param that controls the line length
//   l1, l2,             // the two lengths (µm, numbers or expression strings)
//   separation,         // centre-to-centre offset between the two lines (µm)
//   freqStart, freqStop, freqPoints,  // sweep (GHz / count); optional
// }
// Returns { scene, portIndices, portNames, warnings } or throws Error with a
// user-facing message.
export function buildTwoLineScene(scene, cfg) {
  const warnings = [];
  const src = normalizeScene(scene);
  const allIds = (src.components || []).map((c) => c.id);
  if (allIds.length === 0) throw new Error('The design has no components to build a line from.');

  const { def, warnings: cellWarnings } = makeCellFromSelection(src, allIds, 'twoline');
  if (!def) throw new Error('Could not capture the line (empty selection).');
  warnings.push(...(cellWarnings || []));

  const P = cfg.lengthParam;
  if (!P || !def.params[P]) {
    throw new Error(`Length parameter "${P || '(none)'}" is not a parameter this line uses. Pick the workspace variable that sets the line length.`);
  }

  const sep = Number.isFinite(cfg.separation) && cfg.separation > 0
    ? cfg.separation
    : defaultSeparation(src, def);

  // lineA = length tl_L1, lineB = length tl_L2 (override the length param to the
  // injected top-level vars so both stay parametric and Δl is a live HFSS var).
  const instA = instantiateCell(def, 'lineA', { [P]: TL_L1 }, 0, 0);
  const instB = instantiateCell(def, 'lineB', { [P]: TL_L2 }, 0, sep);

  const combined = {
    ...src,
    params: {
      [TL_L1]: { expr: numExpr(cfg.l1), unit: 'µm', desc: '2-line method: short line length' },
      [TL_L2]: { expr: numExpr(cfg.l2), unit: 'µm', desc: '2-line method: long line length' },
      [TL_DL]: { expr: `${TL_L2} - ${TL_L1}`, unit: 'µm', desc: '2-line method: Δl = L2 − L1' },
      ...instA.params,
      ...instB.params,
    },
    components: [...instA.components, ...instB.components], // lineA FIRST — fixes port S-indices
    snaps: [...instA.snaps, ...instB.snaps],
    mirrors: [],
    groups: [],
  };
  // Force a Discrete sweep (per-point eigenvalue math must land on saved
  // points), with the wizard's band if supplied.
  const sim = { ...(src.simSetup || {}) };
  sim.sweepEnabled = true;
  sim.sweepType = 'Discrete';
  if (cfg.freqStart != null) sim.sweepStart = String(cfg.freqStart);
  if (cfg.freqStop != null) sim.sweepStop = String(cfg.freqStop);
  if (cfg.freqPoints != null) sim.sweepPoints = String(cfg.freqPoints);
  combined.simSetup = sim;

  const out = normalizeScene(combined);

  // Verify the 4-port contract before trusting the S-indices.
  const pv = resolveParams(out.params || {}).values;
  const solved = solveLayout(out.components, out.snaps, pv);
  const ports = findLumpedPortOrder(solved, pv);
  if (ports.length !== 4) {
    throw new Error(
      `Expected exactly 4 lumped ports (2 per line) but found ${ports.length}. ` +
      'Each line end needs a port-layer rectangle with its lumped port enabled and a valid integration line. ' +
      'Fix the single-line design (enable both ports) and try again.'
    );
  }
  const inst = (c) => c.cellInstance && c.cellInstance.inst;
  const groupOk = inst(ports[0]) === 'lineA' && inst(ports[1]) === 'lineA' &&
                  inst(ports[2]) === 'lineB' && inst(ports[3]) === 'lineB';
  if (!groupOk) {
    throw new Error(
      'Could not group the 4 ports as (lineA, lineA, lineB, lineB) in S-index order — ' +
      'the port numbering would be ambiguous. This usually means the two lines overlap; increase the line separation.'
    );
  }
  // Equal renormalization impedance across all 4 ports (T-from-S assumes one Zref).
  const z = (c) => String((c.lumpedPort && c.lumpedPort.impedance) || '50').trim();
  const z0 = z(ports[0]);
  if (!ports.every((p) => z(p) === z0)) {
    throw new Error('The 4 ports must all use the same reference impedance for the 2-line cascade math. Set every port to the same Ω value.');
  }

  const portIndices = { a1: 1, a2: 2, b1: 3, b2: 4 };
  const portNames = ports.map((c) => `LumpedPort_${c.id.replace(/[^A-Za-z0-9_]/g, '_')}`);
  return { scene: out, portIndices, portNames, warnings };
}

// Default line separation: keep the two lines well clear so the 2-ports don't
// couple. ~3× the line's bbox span (max of width/height), min 200 µm. A hint
// only — buildTwoLineScene's port grouping check catches real overlaps.
function defaultSeparation(scene, def) {
  const pv = resolveParams(scene.params || {}).values;
  let minY = Infinity, maxY = -Infinity, minX = Infinity, maxX = -Infinity;
  for (const c of def.components || []) {
    const cx = Number.isFinite(c.cx) ? c.cx : 0;
    const cy = Number.isFinite(c.cy) ? c.cy : 0;
    const w = Math.abs(evalExpr(c.w, pv)) || 0;
    const h = Math.abs(evalExpr(c.h, pv)) || 0;
    minX = Math.min(minX, cx - w / 2); maxX = Math.max(maxX, cx + w / 2);
    minY = Math.min(minY, cy - h / 2); maxY = Math.max(maxY, cy + h / 2);
  }
  const span = Number.isFinite(maxY) ? Math.max(maxX - minX, maxY - minY) : 0;
  return Math.max(200, span * 3);
}

function numExpr(v) {
  if (v == null) return '0';
  const s = String(v).trim();
  return s === '' ? '0' : s;
}

// Numeric reference implementation of the 2-line extraction — mirrors the HFSS
// output-variable expressions exactly, for unit tests. SA/SB are 2-port S
// matrices { S11, S21, S12, S22 } of complex numbers {re, im}. Returns
// { gamma:{re,im}, alpha, eeff }.
export function twoLineExtractNumeric(SA, SB, dLmeters, fHz) {
  const C = (re, im = 0) => ({ re, im });
  const add = (a, b) => C(a.re + b.re, a.im + b.im);
  const sub = (a, b) => C(a.re - b.re, a.im - b.im);
  const mul = (a, b) => C(a.re * b.re - a.im * b.im, a.re * b.im + a.im * b.re);
  const div = (a, b) => { const d = b.re * b.re + b.im * b.im; return C((a.re * b.re + a.im * b.im) / d, (a.im * b.re - a.re * b.im) / d); };
  const neg = (a) => C(-a.re, -a.im);
  const csqrt = (z) => { const r = Math.hypot(z.re, z.im); const re = Math.sqrt((r + z.re) / 2); let im = Math.sqrt((r - z.re) / 2); if (z.im < 0) im = -im; return C(re, im); };
  const cln = (z) => C(0.5 * Math.log(z.re * z.re + z.im * z.im), Math.atan2(z.im, z.re));
  const Tof = (s) => {
    const det = sub(mul(s.S11, s.S22), mul(s.S12, s.S21));
    return { T11: neg(div(det, s.S21)), T12: div(s.S11, s.S21), T21: neg(div(s.S22, s.S21)), T22: div(C(1), s.S21) };
  };
  const inv = (t) => { const d = sub(mul(t.T11, t.T22), mul(t.T12, t.T21)); return { T11: div(t.T22, d), T12: neg(div(t.T12, d)), T21: neg(div(t.T21, d)), T22: div(t.T11, d) }; };
  const matmul = (a, b) => ({
    T11: add(mul(a.T11, b.T11), mul(a.T12, b.T21)),
    T12: add(mul(a.T11, b.T12), mul(a.T12, b.T22)),
    T21: add(mul(a.T21, b.T11), mul(a.T22, b.T21)),
    T22: add(mul(a.T21, b.T12), mul(a.T22, b.T22)),
  });
  const TA = Tof(SA), TB = Tof(SB);
  const M = matmul(TB, inv(TA));
  const tr = add(M.T11, M.T22);
  const det = sub(mul(M.T11, M.T22), mul(M.T12, M.T21));
  const disc = csqrt(sub(mul(tr, tr), mul(C(4), det)));
  const lam = div(add(tr, disc), C(2));
  const gamma = div(neg(cln(lam)), C(dLmeters));
  const w = 2 * Math.PI * fHz, cOverW = 2.99792458e8 / w;
  const alpha = Math.abs(gamma.re);
  const eeff = cOverW * cOverW * (gamma.im * gamma.im - gamma.re * gamma.re);
  return { gamma, alpha, eeff };
}
