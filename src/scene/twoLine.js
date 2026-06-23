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

// Expand a number to a plain decimal string (no scientific exponent) so the
// HFSS report-expression parser reads it unambiguously.
function plainDecimal(x) {
  if (!Number.isFinite(x)) return '0';
  let s = x.toFixed(15);
  if (s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s === '' || s === '-' ? '0' : s;
}

// The ordered list of HFSS Output Variables implementing the 2-line εeff/α
// extraction, given the verified 4-port S-index map. Each entry is
// { name, expr, note }; the exporter emits CreateOutputVariable in this order
// (dependency order — later rows reference earlier ones). HFSS report-expression
// syntax: S(i,j) complex, functions re/im/abs/ln/sqrt, `pi`, and the reserved
// sweep variable `Freq` (Hz).
//   pi = { a1, a2, b1, b2 } — HFSS S-indices (a1<a2 line A input/output; b1<b2
//   line B).
//   dLMeters = Δl in METRES, baked as a numeric LITERAL. We do NOT reference the
//   tl_dL design variable here: a length design variable (tl_dL = tl_L2 − tl_L1
//   with both in µm) resolves to its SI value (metres) inside a report/output
//   expression, so `tl_dL*1e-6` double-converts and inflates εeff by ~1e12 and
//   α by ~1e6. A literal removes that unit ambiguity entirely (the 2-line method
//   uses two FIXED lengths, so a literal is exact).
//   includeZ0 (optional bool) — when true, appends the characteristic impedance
//   Z0 = γ/(jωC): Re(Z0)=β/(ωC), Im(Z0)=−α/(ωC), |Z0|=|γ|/(ωC). Sign-free like
//   εeff. These reference the HFSS DESIGN VARIABLE `tl_C_F_per_m` (the caller
//   emits a set_var for it) so C is editable in HFSS / settable from a Q3D
//   capacitance solve. C is electrostatic ⇒ unaffected by kinetic inductance,
//   so Z0 is kinetic-inductance-correct (γ carries L_kin).
export function twoLineOutputVariables(pi, dLMeters, includeZ0) {
  const { a1, a2, b1, b2 } = pi;
  const S = (i, j) => `S(${i},${j})`;
  const rows = [
    { name: 'tl_DeltaL_m', expr: plainDecimal(dLMeters), note: 'Δl in metres (baked literal L2−L1)' },
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
  // Characteristic impedance Z0 = γ/(jωC), appended only when requested. The
  // rows reference the post-processing variable `tl_C_F_per_m` (F/m), settable
  // from a Q3D solve. MUST be sign-free: the 2-line eigenvalue method resolves γ
  // only up to a GLOBAL SIGN (the two eigenvalues are e^±γΔl, so the off branch
  // flips re(γ) and im(γ) TOGETHER). For a passive forward wave α=re(γ)≥0 and
  // β=im(γ)≥0, so we take magnitudes — otherwise Re Z0 = β/(ωC) comes out NEGATIVE
  // on the wrong branch. (εeff is even in γ and α uses abs already; Z0 needs the
  // same treatment. The 2π phase-wrap caveat on β is separate — see below.)
  //   Z0 = γ/(jωC) = β/(ωC) − jα/(ωC)  ⇒  Re Z0 = β/(ωC) > 0, Im Z0 = −α/(ωC) ≤ 0.
  if (includeZ0) {
    rows.push(
      { name: 'tl_Z0_re', expr: 'abs(tl_gim)/(tl_TwoPiF*tl_C_F_per_m)', note: 'Re Z0 = β/(ωC) = |Im γ|/(ωC) (sign-free)' },
      { name: 'tl_Z0_im', expr: '-abs(tl_gre)/(tl_TwoPiF*tl_C_F_per_m)', note: 'Im Z0 = -α/(ωC) = -|Re γ|/(ωC) (≤0, sign-free)' },
      { name: 'tl_Z0_mag', expr: 'sqrt(tl_gre*tl_gre+tl_gim*tl_gim)/(tl_TwoPiF*tl_C_F_per_m)', note: '|Z0| = |γ|/(ωC)' },
    );
  }
  return rows;
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

// --- Replica flattening (wizard-only) --------------------------------------
// Real single-line designs frequently place their two ports by putting a
// `repeat` (or `displace`) transform on ONE port component, and likewise build
// the feed/launch at each end by repeating a boolean. The lumped-port exporter
// emits one port per port COMPONENT at its base position — it does NOT turn a
// repeat replica into a second port, and the port-adjacency detector can't see
// a flanker that exists only as a repeated boolean (its operands live at the
// base position only). So a "single line with two ports" built via a repeat
// would yield just ONE detectable port.
//
// flattenReplicas materializes every translation replica (repeat/displace) into
// a distinct STATIC component — and, crucially, replicates a boolean's whole
// operand cluster so the punch-hole feed exists at each end as real geometry.
// Cross-cluster references (a punch clone's `cloneOf` pointing at the port in a
// different cluster) are remapped to the SAME replica index via a global
// registry, so the detector's clone/sameBbox match works at every replica.
// Rotate transforms are left intact (a warning is emitted) — they're rare on
// the port path and not needed for the 2-line method.

// Per-instance translation offsets for a repeat/displace transform chain
// (mirrors expandTransforms' translation behaviour). Returns { offs, hasRot }.
function translationOffsets(transforms, pv) {
  let offs = [{ dx: 0, dy: 0 }];
  let hasRot = false;
  for (const t of (transforms || [])) {
    if (t.enabled === false) continue;
    if (t.kind === 'displace') {
      const dx = evalExpr(t.dx, pv) || 0, dy = evalExpr(t.dy, pv) || 0;
      offs = offs.map((o) => ({ dx: o.dx + dx, dy: o.dy + dy }));
    } else if (t.kind === 'repeat') {
      const n = Math.max(0, Math.round(evalExpr(t.n, pv) || 0));
      const dx = evalExpr(t.dx, pv) || 0, dy = evalExpr(t.dy, pv) || 0;
      const inc = t.includeOriginal !== false;
      const out = [];
      for (const o of offs) for (let i = (inc ? 0 : 1); i <= n; i++) out.push({ dx: o.dx + i * dx, dy: o.dy + i * dy });
      offs = out;
    } else if (t.kind === 'rotate') {
      hasRot = true;
    }
  }
  return { offs, hasRot };
}

// A boolean's consumed operand subtree (the cluster that moves together).
function clusterOf(c, byId, acc = []) {
  if (acc.some((m) => m.id === c.id)) return acc;
  acc.push(c);
  if (Array.isArray(c.operandIds)) for (const oid of c.operandIds) { const o = byId[oid]; if (o) clusterOf(o, byId, acc); }
  return acc;
}

// Flatten translation replicas of every top-level component (and its boolean
// cluster) into distinct static components. `components` should be SOLVED
// (resolved cx/cy) so baked positions account for any snap chain. Returns
// { components, warnings }.
function flattenReplicas(components, pv) {
  const byId = Object.fromEntries(components.map((c) => [c.id, c]));
  const tops = components.filter((c) => !c.consumedBy); // operands ride their boolean
  const info = [];
  const idK = {}; // id -> number of instances (for cross-cluster index match)
  for (const c of tops) {
    const { offs, hasRot } = translationOffsets(c.transforms, pv);
    const members = clusterOf(c, byId);
    const useOffs = hasRot ? [{ dx: 0, dy: 0 }] : offs;
    info.push({ root: c, members, offs: useOffs, hasRot });
    for (const m of members) idK[m.id] = useOffs.length;
  }
  const newId = (id, k) => (k > 0 && idK[id] !== undefined ? `${id}__r${k}` : id);
  // Remap an id reference to the SAME replica index (falls back to base if the
  // referenced component has fewer replicas than k).
  const remapRef = (id, k) => {
    if (idK[id] === undefined) return id;
    return newId(id, k < idK[id] ? k : 0);
  };
  const out = [];
  const warnings = [];
  for (const { root, members, offs, hasRot } of info) {
    if (hasRot && offs.length >= 1 && (root.transforms || []).some((t) => t.kind !== 'rotate' && t.enabled !== false)) {
      warnings.push(`${root.id}: has a rotate transform — its replicas were not auto-expanded for port detection.`);
    } else if (hasRot) {
      warnings.push(`${root.id}: rotate transform left intact (not auto-expanded).`);
    }
    offs.forEach((o, k) => {
      for (const m of members) {
        out.push({
          ...m,
          id: newId(m.id, k),
          cx: (Number.isFinite(m.cx) ? m.cx : 0) + o.dx,
          cy: (Number.isFinite(m.cy) ? m.cy : 0) + o.dy,
          transforms: hasRot ? m.transforms : [],
          consumedBy: m.consumedBy ? remapRef(m.consumedBy, k) : m.consumedBy,
          cloneOf: m.cloneOf ? remapRef(m.cloneOf, k) : m.cloneOf,
          operandIds: Array.isArray(m.operandIds) ? m.operandIds.map((id) => remapRef(id, k)) : m.operandIds,
        });
      }
    });
  }
  return { components: out, warnings };
}

// Auto-enable a lumped port on every port-layer rect that the adjacency
// detector flanks (preserving any user-set impedance). Returns a new component
// list. Designers draw on the `port` layer to declare a port; the separate
// "enable lumped port" flag is easy to miss, so the wizard infers it.
function autoEnableFlankedPorts(components, snaps, pv) {
  const solved = solveLayout(components, snaps, pv);
  const dir = {};
  for (const c of solved) {
    if (c.layer !== 'port' || c.kind !== 'rect') continue;
    const det = detectPortIntegrationLine(c, solved, pv);
    if (det.direction) dir[c.id] = true;
  }
  return components.map((c) => (c.layer === 'port' && c.kind === 'rect' && dir[c.id])
    ? { ...c, lumpedPort: { enabled: true, impedance: (c.lumpedPort && c.lumpedPort.impedance) || '50' } }
    : c);
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
      // PRESERVE the original design's params FIRST — especially the stack
      // thickness params (h_cond, h_wg, h_si, …) that no component expression
      // references, so the cell closure (instA/instB.params) does NOT carry
      // them. Without this they'd be dropped and normalizeScene would re-inject
      // STACK DEFAULTS (e.g. h_cond=0.8), silently overriding a design's
      // h_cond=0 — which both shows the wrong thickness AND skips the
      // zero-thickness conductor → 2-D impedance-sheet path.
      ...src.params,
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
  // Interpolating sweep, with the wizard's band if supplied. The εeff/α/Z0
  // eigenvalue extraction runs on the interpolated S(i,j) at each requested point
  // — fine for a smooth TL and much faster than a per-point Discrete solve. Min/
  // max ADAPTIVE passes mirror the wizard's convergence fields so the HFSS solve
  // uses the same pass budget as the bundled Q3D CG solve.
  const sim = { ...(src.simSetup || {}) };
  sim.sweepEnabled = true;
  sim.sweepType = 'Interpolating';
  if (cfg.freqStart != null) sim.sweepStart = String(cfg.freqStart);
  if (cfg.freqStop != null) sim.sweepStop = String(cfg.freqStop);
  if (cfg.freqPoints != null) sim.sweepPoints = String(cfg.freqPoints);
  const posInt = (v) => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n > 0 ? n : null; };
  const mx = posInt(cfg.maxPass), mn = posInt(cfg.minPass);
  if (mx != null) sim.maxPasses = String(mx);
  if (mn != null) sim.minPasses = String(mx != null ? Math.min(mn, mx) : mn); // min ≤ max
  combined.simSetup = sim;

  let out = normalizeScene(combined);

  // Materialize translation replicas (repeat/displace) into static geometry so
  // ports built via a repeat — and the boolean feeds that flank them — become
  // distinct, detectable components; then auto-enable every flanked port-layer
  // rect. Solve FIRST so baked positions account for the snap chain. Geometry
  // POSITIONS bake numeric (the 2-line method uses two FIXED lengths, so this
  // is exact); line-size expressions and the tl_L1/tl_L2/tl_dL params stay live
  // for the in-HFSS Δl math.
  const pv = resolveParams(out.params || {}).values;
  const preSolved = solveLayout(out.components, out.snaps, pv);
  const { components: flatComps, warnings: flatWarn } = flattenReplicas(preSolved, pv);
  warnings.push(...flatWarn);
  const enabledComps = autoEnableFlankedPorts(flatComps, [], pv);
  out = normalizeScene({ ...out, components: enabledComps, snaps: [], groups: [], mirrors: [] });

  // Verify the 4-port contract before trusting the S-indices.
  const solved = solveLayout(out.components, out.snaps, pv);
  const ports = findLumpedPortOrder(solved, pv);
  if (ports.length !== 4) {
    const portRects = out.components.filter((c) => c.layer === 'port' && c.kind === 'rect').length;
    const hint = portRects === 0
      ? 'No port-layer rectangles were found. Draw a port at each end of the line (a rect on the "port" layer flanked by the conductor/electrode).'
      : `Found ${portRects} port-layer rect(s), but only ${ports.length} resolved to a valid lumped port. Each port must sit between two electrodes (or in a punched gap) so an integration line can be drawn across it.`;
    throw new Error(
      `Expected exactly 4 lumped ports (2 per line) but found ${ports.length}. ${hint}`
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
  // Δl in METRES for the in-HFSS εeff/α math — baked as a literal (see
  // twoLineOutputVariables) so HFSS variable-unit handling can't double-convert.
  const dLMeters = (evalExpr(TL_L2, pv) - evalExpr(TL_L1, pv)) * 1e-6;
  return { scene: out, portIndices, portNames, dLMeters, warnings };
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
