// Tidy3D jupyter notebook for a section-line cross-section: quasi-TEM RF line
// mode -> Z0(f) and sqrt(eps_eff)(f) = n_eff(f), optical mode(s) at lambda, and
// the electro-optic VpiL from the 1 V-normalized RF field overlapped with the
// optical mode over the EO layer (Wooten et al. JSTQE 2000; C. Wang et al.
// Nature 2018).
//
// Consumes the CROSS-SECTION DATA CONTRACT v1 object (buildCrossSection):
// numeric t/z geometry always present, optional HFSS-style *Expr strings
// ("(h_wg)um", "(h_wg + h_cond)um", "0um + (h_wg)") that we translate to plain
// python referencing the cross.params values emitted as python variables — so
// the PARAMS CELL is the single user-editable surface and stack-thickness edits
// re-flow the whole notebook.
//
// Coordinate convention (stated in the notebook): tidy3d x = t (um along the
// section line from p0), y = stack z (um), z = propagation; mode plane at z=0.
// The rib-core trapezoid therefore lives in the tidy3d (x, y) plane and is
// extruded along z -> td.PolySlab(axis=2).
//
// Tidy3D API verified against the flexcompute/tidy3d source (develop, 2026-07)
// and docs.flexcompute.com:
//   - tidy3d.plugins.mode.ModeSolver(simulation, plane, mode_spec, freqs)
//     .solve() runs LOCALLY (no cloud account; skips subpixel averaging).
//   - tidy3d.plugins.microwave: VoltageIntegralAxisAligned /
//     CurrentIntegralAxisAligned / CustomCurrentIntegral2D are kept as
//     backwards-compat ALIASES of the 2.11 renames (AxisAlignedVoltageIntegral
//     / AxisAlignedCurrentIntegral / Custom2DCurrentIntegral), so the classic
//     names work on 2.7 through 2.11+. ImpedanceCalculator(voltage_integral=,
//     current_integral=).compute_impedance(mode_solver_data) -> Z0 DataArray.
//   - td.AnisotropicMedium(xx=td.Medium(...), yy=..., zz=...) (diagonal only),
//     td.PECMedium(), td.LossyMetalMedium(conductivity [S/um],
//     frequency_range) (SIBC lossy metal).
// Pinned in the notebook: tidy3d >= 2.7, < 3.
//
// RF vs OPTICAL materials: the RF mode solve MUST NOT use optical indices
// (SiO2 n=1.444 -> eps 2.08 vs RF eps 3.9; LN eps_RF 28/43 vs n^2 ~ 4.7) or
// sqrt(eps_eff) comes out ~2x off. The notebook therefore carries TWO material
// tables (MATERIAL_INDEX for optics, MATERIAL_EPS_RF for RF) — a deliberate
// extension beyond the bare contract.

const PY_KEYWORDS = new Set([
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break',
  'class', 'continue', 'def', 'del', 'elif', 'else', 'except', 'finally',
  'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal',
  'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield',
]);

// Python names the notebook itself defines — a scene param colliding with one
// of these would shadow it, so such params are dropped (exprs referencing them
// fall back to baked numerics).
const NB_RESERVED = new Set([
  'np', 'plt', 'td', 'mw', 'ModeSolver', 'dict',
  'T_MIN', 'T_MAX', 'Z_MIN', 'Z_MAX', 'T_MID', 'T_SPAN', 'Z_MID', 'Z_SPAN',
  'SLABS', 'CONDUCTORS', 'ROLES', 'WAVEGUIDES', 'WG_FILL_MATERIAL',
  'WG_CENTER_T', 'WG_CENTER_Z', 'SHEET_THICK_UM',
  'LAMBDA_UM', 'NE', 'NO', 'R33_PM_PER_V', 'R13_PM_PER_V', 'EO_AXIS',
  'EO_COMP', 'EO_MATERIAL', 'EO_LAYER_Z0', 'EO_LAYER_Z1', 'EO_LAYER_ID', 'N_OPT_MODES',
  'FREQS_RF_HZ', 'GRID_DL_RF', 'NEFF_GUESS_RF', 'MATERIAL_INDEX',
  'MATERIAL_EPS_RF', 'EO_EPS_RF_E', 'EO_EPS_RF_O', 'X_PAD', 'Z_EXT',
  'OPT_CENTER_T', 'OPT_CENTER_Z', 'OPT_WIN_X', 'OPT_WIN_Z', 'FREQ0',
]);

// Python float literal without float noise (0.30000000000000004 -> '0.3').
// 10 significant digits is far below um-scale meaning and far above rounding.
const pf = (x) => {
  if (!Number.isFinite(x)) return '0.0';
  const r = Number(Number(x).toPrecision(10));
  const s = String(r);
  return (s.includes('.') || s.includes('e') || s.includes('E')) ? s : `${s}.0`;
};
const pint = (x) => String(Math.max(1, Math.round(Number(x) || 0)));
const pstr = (s) => `"${String(s ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

// HFSS length expression -> python expression over the emitted param variables.
// The contract's *Expr strings carry HFSS "um" unit tokens in two shapes
// (mirroring hfss-native exprWithUm / layerZ): bare-numeric-with-unit
// ("(0.6um)", "0um") and paren-suffixed ("(h_wg)um", "(h_wg + h_cond)um").
// Both strip to plain arithmetic; every remaining identifier must be one of
// the params we emitted as python variables, else we bail (caller falls back
// to the baked numeric — consumers MUST fall back per the contract).
function exprToPy(expr, emittedParams) {
  if (expr == null) return null;
  let s = String(expr)
    .replace(/(\d(?:\.\d+)?)\s*um\b/g, '$1')
    .replace(/\)\s*um\b/g, ')');
  if (!/^[\w\s+\-*/().]*$/.test(s)) return null; // unexpected grammar -> bake
  for (const m of s.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
    const id = m[0];
    if (id === 'um' || !emittedParams.has(id)) return null;
  }
  const t = s.trim();
  return t === '' ? null : t;
}

// nbformat-4.5 cells (id required at minor 5).
let _cellSeq = 0;
const mdCell = (lines) => ({
  cell_type: 'markdown', id: `cell-${_cellSeq++}`, metadata: {},
  source: lines.map((l, i) => (i < lines.length - 1 ? `${l}\n` : l)),
});
const codeCell = (lines) => ({
  cell_type: 'code', id: `cell-${_cellSeq++}`, metadata: {},
  execution_count: null, outputs: [],
  source: lines.map((l, i) => (i < lines.length - 1 ? `${l}\n` : l)),
});

// Optical index defaults; the EO material itself is handled by the
// anisotropic builder, never by this table. Keys MUST cover the app's
// defaultStack material ids ('silicon_dioxide', 'lithium_tantalate',
// 'lithium_niobate') — missing them silently dropped the whole default
// stack to the FIXME placeholders (optical 1.5 / RF 4.0), so the BOX and
// substrate of every default design solved with wrong permittivity.
const DEFAULT_MATERIAL_INDEX = {
  SiO2: 1.444, sio2: 1.444, silicon_dioxide: 1.444,
  Si: 3.476, silicon: 3.476,
  // isotropic FALLBACKS for the EO crystals when they appear as a
  // non-EO slab (e.g. a passive LN layer); the EO layer itself goes
  // through the anisotropic ne/no builder instead.
  LiNbO3: 2.21, lithium_niobate: 2.21,
  LiTaO3: 2.12, lithium_tantalate: 2.12,
  vacuum: 1.0, air: 1.0,
};
// RF relative permittivity defaults (quasi-static/clamped values, NOT
// optical n^2). LN: eps11~43, eps33~28; LT: eps11~41, eps33~43 — the
// scalar here is the in-plane (eps11) value; the EO layer's RF tensor is
// refined in the notebook's EO_EPS_RF variables.
const DEFAULT_MATERIAL_EPS_RF = {
  SiO2: 3.9, sio2: 3.9, silicon_dioxide: 3.9,
  Si: 11.7, silicon: 11.7,
  LiNbO3: 43, lithium_niobate: 43,
  LiTaO3: 41, lithium_tantalate: 41,
  vacuum: 1.0, air: 1.0,
};

export function generateTidy3DNotebook(cross, opts = {}) {
  if (!cross || cross.ok === false) {
    throw new Error(`tidy3d notebook: unusable cross-section${cross && cross.error ? ` — ${cross.error}` : ''}`);
  }
  _cellSeq = 0;
  const warnings = [];
  for (const w of cross.warnings || []) warnings.push(`${w.code}: ${w.msg}`);

  const designName = opts.designName || 'eo_section';
  const freqStartGHz = Number.isFinite(opts.freqStartGHz) ? opts.freqStartGHz : 1;
  const freqStopGHz = Number.isFinite(opts.freqStopGHz) ? opts.freqStopGHz : 50;
  const freqPoints = Number.isFinite(opts.freqPoints) ? opts.freqPoints : 25;
  const lambdaUm = Number.isFinite(opts.lambdaUm) ? opts.lambdaUm : 1.55;
  const nOpticalModes = Number.isFinite(opts.nOpticalModes) ? opts.nOpticalModes : 2;
  const ne = Number.isFinite(opts.ne) ? opts.ne : 2.138;
  const no = Number.isFinite(opts.no) ? opts.no : 2.211;
  const eoAxis = opts.extraordinaryAxis === 'horizontal' ? 'horizontal' : 'vertical';
  const r33 = Number.isFinite(opts.r33) ? opts.r33 : 30.8;
  const r13 = Number.isFinite(opts.r13) ? opts.r13 : 8.6;

  const slabs = cross.slabs || [];
  const conds = cross.conductors || [];
  const wgs = cross.waveguides || [];
  const dom = cross.domain || { tMin: 0, tMax: 100, zMin: -10, zMax: 10 };
  const line = cross.line || { p0: { x: 0, y: 0 }, p1: { x: 0, y: 0 }, lengthUm: 0, axis: null };

  // ---- which params survive as python variables (exprs bail on the rest) ----
  const emittedParams = new Set();
  const paramLines = [];
  for (const [name, val] of Object.entries(cross.params || {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || PY_KEYWORDS.has(name) || NB_RESERVED.has(name)) {
      warnings.push(`param '${name}' collides with a python keyword/notebook name — geometry referencing it is baked numeric`);
      continue;
    }
    if (!Number.isFinite(val)) continue;
    emittedParams.add(name);
    paramLines.push(`${name} = ${pf(val)}`);
  }
  // numeric-with-optional-expr emitter: parametric where derivable, else baked
  const pv = (num, expr) => exprToPy(expr, emittedParams) ?? pf(num);

  // ---- RF drive roles: explicit opts.roles, else nearest-to-waveguide guess ----
  const roles = {};
  if (opts.roles && Object.keys(opts.roles).length) {
    for (const c of conds) {
      const r = opts.roles[c.id];
      if (r === 'signal' || r === 'ground') roles[c.id] = r;
      else { roles[c.id] = 'ground'; warnings.push(`conductor '${c.id}' missing from opts.roles — defaulted to ground`); }
    }
  } else if (conds.length) {
    const tRef = cross.wgCenter ? cross.wgCenter.t : 0.5 * (dom.tMin + dom.tMax);
    const mid = (c) => {
      const ivs = c.intervals || [];
      if (!ivs.length) return Infinity;
      const lo = Math.min(...ivs.map((i) => i.t0)), hi = Math.max(...ivs.map((i) => i.t1));
      return 0.5 * (lo + hi);
    };
    let best = null;
    for (const c of conds) { const d = Math.abs(mid(c) - tRef); if (!best || d < best.d) best = { c, d }; }
    for (const c of conds) roles[c.id] = (best && c.id === best.c.id) ? 'signal' : 'ground';
    warnings.push(`RF roles inferred (signal = conductor nearest ${cross.wgCenter ? 'the waveguide' : 'the section midpoint'}) — edit ROLES in the notebook if wrong`);
  }
  const nSignal = Object.values(roles).filter((r) => r === 'signal').length;
  const nGround = Object.values(roles).filter((r) => r === 'ground').length;
  const hasRf = conds.length >= 2 && nSignal >= 1 && nGround >= 1;
  if (conds.length && !hasRf) warnings.push('RF solve skipped: need at least one signal AND one ground conductor crossed by the section line');
  if (!conds.length) warnings.push('RF solve skipped: no conductors crossed by the section line');
  const hasWg = wgs.length > 0 && !!cross.wgCenter;
  if (!hasWg) warnings.push('optical / VpiL skipped: no waveguide core crossed by the section line');
  const hasVpil = hasWg && hasRf;

  // ---- materials ----
  const eoLayerId = opts.eoLayerId
    ?? (wgs[0] && wgs[0].layerId)
    ?? (slabs.find((s) => s.role === 'waveguide') || {}).layerId ?? null;
  const eoSlab = slabs.find((s) => s.layerId === eoLayerId) || null;
  const eoMaterial = (eoSlab && eoSlab.material) || (wgs[0] && wgs[0].material) || 'LiNbO3';
  const matIndex = { ...DEFAULT_MATERIAL_INDEX, ...(opts.materialIndices || {}) };
  const allMaterials = new Set();
  for (const s of slabs) allMaterials.add(s.material);
  for (const w of wgs) allMaterials.add(w.material);
  const unknownMats = [...allMaterials].filter((m) => m && m !== eoMaterial && !(m in matIndex));
  for (const m of unknownMats) warnings.push(`unknown material '${m}' — placeholder n=1.5 / eps_rf=4.0 emitted, edit the tables in the notebook`);

  // ---- geometry-derived defaults ----
  const tSpan = dom.tMax - dom.tMin;
  // uniform RF grid: resolve the smallest signal-ground gap and the conductor
  // thickness, bounded so the 2-D plane stays a tractable local eigenproblem
  const ivsAll = [];
  for (const c of conds) for (const iv of (c.intervals || [])) ivsAll.push([iv.t0, iv.t1]);
  ivsAll.sort((a, b) => a[0] - b[0]);
  let minGap = Infinity;
  for (let i = 1; i < ivsAll.length; i++) { const g = ivsAll[i][0] - ivsAll[i - 1][1]; if (g > 1e-9 && g < minGap) minGap = g; }
  const anyZeroThk = conds.some((c) => c.zeroThickness);
  // ONE source of truth for the sheet inflation — used in the emitted python
  // (params cell) AND in the JS grid heuristic below.
  const SHEET_THICK_UM = 0.05;
  let minThk = Infinity;
  for (const c of conds) { const t = (c.z1 - c.z0); if (t > 1e-9 && t < minThk) minThk = t; }
  // Zero-thickness conductors are inflated to SHEET_THICK_UM in the emitted
  // geometry — the grid MUST resolve that inflated sheet, or the uniform-grid
  // eigensolve (no subpixel averaging locally) samples right past the PEC and
  // silently returns a dielectric-stack mode (Z0/eps_eff garbage). Real case:
  // h_cond=0 NbN CPW, 2.5 um gap -> dl was 0.42 um vs 0.05 um sheets.
  if (anyZeroThk) minThk = Math.min(minThk, SHEET_THICK_UM);
  let dlRf = Math.min(
    Number.isFinite(minGap) ? minGap / 6 : Infinity,
    Number.isFinite(minThk) ? minThk / 2 : Infinity,
    tSpan / 200 || 0.5,
  );
  if (!Number.isFinite(dlRf) || dlRf <= 0) dlRf = (tSpan || 100) / 200;
  // Floor drops to SHEET_THICK_UM/2 when sheets are present — the generic
  // 0.02 floor is fine (0.05/2 = 0.025 > 0.02) but keep the ceiling tight.
  dlRf = Math.min(Math.max(dlRf, tSpan / 2000 || 0.02, 0.02), 5);

  if (anyZeroThk) warnings.push('zero-thickness conductor(s) inflated to SHEET_THICK_UM in the notebook (mode solver needs a meshable thickness)');

  // waveguide-layer fill material (the etched region): first non-air slab above
  // the wg layer, else vacuum. Contract slabs are bottom -> top.
  let wgFillMaterial = 'vacuum';
  if (wgs.length) {
    const wLayer = wgs[0].layerId;
    const idx = slabs.findIndex((s) => s.layerId === wLayer);
    if (idx >= 0 && idx + 1 < slabs.length && slabs[idx + 1].role !== 'air') wgFillMaterial = slabs[idx + 1].material;
  }

  // optical window around the crossed core (clamped to the domain)
  let optCT = 0, optCZ = 0, optWX = 10, optWZ = 6, coreW = 1;
  if (hasWg) {
    const w0 = wgs[0];
    coreW = Math.max(0.5, ...((w0.core && w0.core.segments) || []).map((s) => Math.abs(s.botT1 - s.botT0)));
    const zLo = Math.max(dom.zMin, ((w0.slabBand && w0.slabBand.z0) ?? w0.core.zBot) - 2.5);
    const zHi = Math.min(dom.zMax, w0.core.zTop + 2.5);
    optCT = cross.wgCenter.t; optCZ = 0.5 * (zLo + zHi);
    optWX = Math.min(tSpan, Math.max(8, 6 * coreW));
    optWZ = Math.max(2, zHi - zLo);
  }

  // ---------------------------------------------------------------- cells --
  const cells = [];
  const axisWord = line.axis === 'h' ? 'horizontal' : line.axis === 'v' ? 'vertical' : 'oblique';

  cells.push(mdCell([
    `# EO cross-section: Z0, √εeff and VπL — \`${designName}\``,
    '',
    'Generated by **PhotonicLayout** (section-line cross-section export).',
    '',
    `**Section line** \`${cross.sectionId || 'section'}\`: (${pf(line.p0.x)}, ${pf(line.p0.y)}) → (${pf(line.p1.x)}, ${pf(line.p1.y)}) µm, length ${pf(line.lengthUm)} µm, ${axisWord}.`,
    '',
    '**What this computes**',
    `1. RF quasi-TEM line mode over ${pf(freqStartGHz)}–${pf(freqStopGHz)} GHz: n_eff(f) = √εeff(f) and characteristic impedance Z0(f) (V/I definition via the microwave-plugin path integrals).`,
    `2. Optical eigenmode(s) at λ = ${pf(lambdaUm)} µm.`,
    '3. Electro-optic VπL: RF mode field normalized to a 1 V drive, overlapped with the optical mode intensity over the EO layer.',
    '',
    '**Runs locally** — `ModeSolver.solve()` uses the LOCAL eigenmode solver; **no Tidy3D cloud account is required**. (The local solve skips subpixel averaging; for higher accuracy `pip install "tidy3d[extras]"` or run the remote solver via `tidy3d.web`.)',
    '',
    '**Assumptions**',
    '- Quasi-TEM RF line mode (for it, n_eff **is** √εeff).',
    '- **Phase-matched**: RF and optical indices assumed matched, so the VπL below is the DC-overlap value — no velocity-mismatch / walk-off integral.',
    '- No bend or roughness loss.',
    '- Conductors are PEC for the optical solve; PEC (or optionally a surface-impedance lossy metal) for the RF solve.',
    '- The cross-section is translationally invariant along the section normal.',
    '',
    '**Tidy3D API verified against** (2026-07, pinned `tidy3d >= 2.7, < 3`):',
    '- https://docs.flexcompute.com/projects/tidy3d/en/latest/api/mode.html (`tidy3d.plugins.mode.ModeSolver`, local `.solve()`)',
    '- https://docs.flexcompute.com/projects/tidy3d/en/latest/api/plugins/microwave.html (`VoltageIntegralAxisAligned` / `CurrentIntegralAxisAligned` / `ImpedanceCalculator` — kept as aliases of the 2.11 renames `AxisAlignedVoltageIntegral` / `AxisAlignedCurrentIntegral`)',
    '- https://github.com/flexcompute/tidy3d (source of record for the alias table and `AnisotropicMedium` / `PECMedium` / `LossyMetalMedium`)',
    '- Worked example: https://www.flexcompute.com/tidy3d/examples/notebooks/CharacteristicImpedanceCalculator/',
    '',
    '**Coordinates**: tidy3d `x` = t (µm along the section line from p0), `y` = stack z (µm), `z` = propagation. Mode plane at z = 0.',
  ]));

  cells.push(codeCell([
    '# %pip install "tidy3d[extras]>=2.7,<3" numpy xarray matplotlib',
    'import numpy as np',
    'import matplotlib.pyplot as plt',
    'import tidy3d as td',
    'from tidy3d.plugins.mode import ModeSolver',
    'import tidy3d.plugins.microwave as mw',
    '',
    '# np.trapz was renamed np.trapezoid in NumPy 2 — resolve once, use everywhere.',
    '_trapz = getattr(np, "trapezoid", getattr(np, "trapz", None))',
  ]));

  // ---- params cell: THE user-editable surface ----
  const P = [];
  P.push('# ===================== USER-EDITABLE PARAMETERS =====================');
  P.push('# All lengths in um (tidy3d native unit). Section-line frame:');
  P.push('#   x = t (um along the section line from p0)   y = stack z (um)   z = propagation');
  P.push('# Geometry below is PARAMETRIC in these scene parameters where the cross-section');
  P.push('# was parametrically derivable — edit a thickness here and the slabs/conductors');
  P.push('# that referenced it re-flow. Everything else is a baked numeric from the layout.');
  if (paramLines.length) {
    P.push('');
    P.push('# --- scene parameters (um) ---');
    for (const l of paramLines) P.push(l);
  }
  P.push('');
  P.push('# --- domain of the cut (um) ---');
  P.push(`T_MIN, T_MAX = ${pf(dom.tMin)}, ${pf(dom.tMax)}`);
  P.push(`Z_MIN, Z_MAX = ${pf(dom.zMin)}, ${pf(dom.zMax)}`);
  P.push('T_MID = 0.5 * (T_MIN + T_MAX); T_SPAN = T_MAX - T_MIN');
  P.push('Z_MID = 0.5 * (Z_MIN + Z_MAX); Z_SPAN = Z_MAX - Z_MIN');
  P.push('');
  P.push('# --- background dielectric slabs, bottom -> top (full width) ---');
  P.push('SLABS = [');
  for (const s of slabs) {
    P.push(`    dict(layer_id=${pstr(s.layerId)}, name=${pstr(s.name)}, material=${pstr(s.material)}, role=${pstr(s.role)}, color=${pstr(s.color || '#dddddd')},`);
    P.push(`         z0=${pv(s.z0, s.z0Expr)}, z1=${pv(s.z1, s.z1Expr)}),`);
  }
  P.push(']');
  P.push('');
  P.push('# --- conductors crossed by the section line (one dict per conductor object;');
  P.push('#     each interval is one [t0, t1] crossing) ---');
  P.push('CONDUCTORS = [');
  for (const c of conds) {
    P.push(`    dict(id=${pstr(c.id)}, label=${pstr(c.label || c.id)}, layer_id=${pstr(c.layerId)}, color=${pstr(c.color || '#fbbf24')},`);
    P.push(`         zero_thickness=${c.zeroThickness ? 'True' : 'False'}, z0=${pv(c.z0, c.z0Expr)}, z1=${pv(c.z1, c.z1Expr)},`);
    P.push(`         intervals=[${(c.intervals || []).map((iv) => `dict(t0=${pv(iv.t0, iv.t0Expr)}, t1=${pv(iv.t1, iv.t1Expr)})`).join(', ')}]),`);
  }
  P.push(']');
  P.push(`SHEET_THICK_UM = ${SHEET_THICK_UM}  # zero-thickness conductors are inflated to this for meshing`);
  P.push('');
  P.push('# --- RF drive roles (EDIT to change which conductor is driven) ---');
  P.push(`ROLES = {${conds.map((c) => `${pstr(c.id)}: ${pstr(roles[c.id] || 'ground')}`).join(', ')}}`);
  P.push('');
  P.push('# --- rib waveguide(s) crossed (etch-angle trapezoid core + partially-etched slab band) ---');
  P.push('WAVEGUIDES = [');
  for (const w of wgs) {
    const wSlab = slabs.find((s) => s.layerId === w.layerId) || null;
    const lz0 = wSlab ? pv(wSlab.z0, wSlab.z0Expr) : pf((w.slabBand && w.slabBand.z0) ?? w.core.zBot);
    const lz1 = wSlab ? pv(wSlab.z1, wSlab.z1Expr) : pf(w.core.zTop);
    const sb = w.slabBand || null;
    P.push(`    dict(id=${pstr(w.id)}, layer_id=${pstr(w.layerId)}, material=${pstr(w.material)}, color=${pstr(w.color || '#7dd3fc')},`);
    P.push(`         layer_z0=${lz0}, layer_z1=${lz1},`);
    P.push(`         slab_z0=${pf(sb ? sb.z0 : w.core.zBot)}, slab_z1=${pf(sb ? sb.z1 : w.core.zBot)},`);
    P.push(`         slab_intervals=[${(sb ? sb.intervals || [] : []).map((iv) => `dict(t0=${pf(iv.t0)}, t1=${pf(iv.t1)})`).join(', ')}],`);
    P.push(`         core_z_bot=${pf(w.core.zBot)}, core_z_top=${pf(w.core.zTop)},`);
    P.push(`         core_segments=[${(w.core.segments || []).map((sg) => `dict(bot_t0=${pf(sg.botT0)}, bot_t1=${pf(sg.botT1)}, top_t0=${pf(sg.topT0)}, top_t1=${pf(sg.topT1)})`).join(', ')}]),`);
  }
  P.push(']');
  P.push(`WG_FILL_MATERIAL = ${pstr(wgFillMaterial)}  # fills the ETCHED region of the waveguide layer`);
  if (cross.wgCenter) P.push(`WG_CENTER_T, WG_CENTER_Z = ${pf(cross.wgCenter.t)}, ${pf(cross.wgCenter.z)}  # crossed core nearest the line midpoint`);
  P.push('');
  P.push('# --- EO / optical constants ---');
  P.push(`LAMBDA_UM = ${pf(lambdaUm)}  # optical wavelength`);
  P.push(`NE = ${pf(ne)}  # extraordinary index (along the crystal c axis) @ LAMBDA_UM`);
  P.push(`NO = ${pf(no)}  # ordinary index @ LAMBDA_UM`);
  P.push(`R33_PM_PER_V = ${pf(r33)}  # EO coefficient r33 (pm/V)`);
  P.push(`R13_PM_PER_V = ${pf(r13)}  # EO coefficient r13 (pm/V)`);
  P.push(`EO_AXIS = ${pstr(eoAxis)}  # "vertical" = c along stack z (z-cut) | "horizontal" = c along the section line (x-cut)`);
  P.push(`EO_COMP = ${pstr(eoAxis === 'vertical' ? 'Ey' : 'Ex')}  # RF/optical field component along c in tidy3d axes (y = stack z, x = t)`);
  {
    const z0e = eoSlab ? pv(eoSlab.z0, eoSlab.z0Expr) : (hasWg ? pf((wgs[0].slabBand && wgs[0].slabBand.z0) ?? wgs[0].core.zBot) : pf(0));
    const z1e = eoSlab ? pv(eoSlab.z1, eoSlab.z1Expr) : (hasWg ? pf(wgs[0].core.zTop) : pf(0));
    P.push(`EO_LAYER_Z0, EO_LAYER_Z1 = ${z0e}, ${z1e}  # EO material band (layer ${eoLayerId ? `'${eoLayerId}'` : 'n/a'}) — masks the VpiL overlap`);
  P.push(`EO_LAYER_ID = ${pstr(eoLayerId || '')}  # when this is a WAVEGUIDE layer, the VpiL mask follows the etched film (slab band + core), not the full z-band`);
  }
  P.push(`N_OPT_MODES = ${pint(nOpticalModes)}`);
  P.push('');
  P.push('# --- RF sweep + solver knobs ---');
  P.push(`FREQS_RF_HZ = np.linspace(${pf(freqStartGHz)}, ${pf(freqStopGHz)}, ${pint(freqPoints)}) * 1e9`);
  P.push(`GRID_DL_RF = ${pf(dlRf)}  # uniform RF-plane grid (um): ~gap/6 & thickness/2; refine for convergence`);
  P.push('NEFF_GUESS_RF = 2.25  # initial n_eff guess (TFLN CPW microwave index ~2.2-2.5); the solver returns the modes NEAREST this');
  if (hasWg) {
    P.push('');
    P.push('# --- optical solve window (um; clamped to the domain) ---');
    P.push(`OPT_CENTER_T, OPT_CENTER_Z = ${pf(optCT)}, ${pf(optCZ)}`);
    P.push(`OPT_WIN_X, OPT_WIN_Z = ${pf(optWX)}, ${pf(optWZ)}`);
  }
  cells.push(codeCell(P));

  // ---- materials + geometry builders ----
  const G = [];
  G.push('# ===================== materials & geometry builders =====================');
  G.push('# TWO material tables on purpose: optical indices are NOT RF permittivities');
  G.push('# (SiO2: n=1.444 vs eps_rf=3.9; LN: n^2~4.7 vs eps_rf 28/43). Using one table');
  G.push('# for both silently corrupts sqrt(eps_eff).');
  G.push('MATERIAL_INDEX = {  # optical refractive index (isotropic backgrounds)');
  {
    const entries = { SiO2: matIndex.SiO2 ?? 1.444, Si: matIndex.Si ?? 3.476, silicon: matIndex.silicon ?? 3.476, vacuum: 1.0, air: 1.0 };
    for (const [k, v] of Object.entries(matIndex)) if (!(k in entries)) entries[k] = v;
    for (const [k, v] of Object.entries(entries)) G.push(`    ${pstr(k)}: ${pf(v)},`);
    for (const m of unknownMats) G.push(`    ${pstr(m)}: 1.5,  # FIXME: unknown material — set the real index`);
  }
  G.push('}');
  G.push('MATERIAL_EPS_RF = {  # RF relative permittivity (quasi-static)');
  G.push('    "SiO2": 3.9, "sio2": 3.9, "Si": 11.7, "silicon": 11.7, "vacuum": 1.0, "air": 1.0,');
  for (const m of unknownMats) G.push(`    ${pstr(m)}: 4.0,  # FIXME: unknown material — set the real RF permittivity`);
  G.push('}');
  G.push(`EO_MATERIAL = ${pstr(eoMaterial)}  # this material is built ANISOTROPIC (optics: ne/no; RF: eps below)`);
  // RF permittivity tensor of the EO crystal, keyed to the ACTUAL material —
  // hardcoded LN values on the app's default LT stack silently skewed the
  // RF mode solve (LT: eps33≈43 along c, eps11≈41 perpendicular; LN: 28/43).
  const eoMatLc = String(eoMaterial).toLowerCase();
  const eoRf = /tantalate|litao/.test(eoMatLc) ? { e: 43.0, o: 41.0, tag: 'LiTaO3' }
    : /niobate|linbo/.test(eoMatLc) ? { e: 28.0, o: 43.0, tag: 'LiNbO3' }
    : { e: 28.0, o: 43.0, tag: `UNKNOWN EO material "${eoMaterial}" — LiNbO3 values used, EDIT THESE` };
  if (eoRf.tag.startsWith('UNKNOWN')) warnings.push(`EO material "${eoMaterial}" not recognized — RF permittivities default to LiNbO3; edit EO_EPS_RF_E/O in the notebook.`);
  G.push(`EO_EPS_RF_E = ${pf(eoRf.e)}  # ${eoRf.tag} RF (clamped) permittivity along c`);
  G.push(`EO_EPS_RF_O = ${pf(eoRf.o)}  # ${eoRf.tag} RF permittivity perpendicular to c`);
  G.push('');
  G.push('X_PAD = 20.0  # slabs extended past the domain edge so the mode window has no side gaps');
  G.push('Z_EXT = 1e3   # extrusion half-length along propagation (must exceed the sim z size)');
  G.push('');
  G.push('def make_aniso(eps_e, eps_o):');
  G.push('    """Diagonal anisotropic medium; extraordinary axis placed per EO_AXIS.');
  G.push('');
  G.push('    tidy3d axes here: x = along the section line, y = stack z, z = propagation.');
  G.push('    "vertical"   (z-cut film): c along stack z  -> yy = eps_e, xx = zz = eps_o');
  G.push('    "horizontal" (x-cut film): c along the line -> xx = eps_e, yy = zz = eps_o');
  G.push('    """');
  G.push('    e = td.Medium(permittivity=eps_e)');
  G.push('    o = td.Medium(permittivity=eps_o)');
  G.push('    if EO_AXIS == "vertical":');
  G.push('        return td.AnisotropicMedium(xx=o, yy=e, zz=o)');
  G.push('    if EO_AXIS == "horizontal":');
  G.push('        return td.AnisotropicMedium(xx=e, yy=o, zz=o)');
  G.push('    raise ValueError("EO_AXIS must be \'vertical\' or \'horizontal\'")');
  G.push('');
  G.push('def medium_for(material, rf=False):');
  G.push('    if material == EO_MATERIAL:');
  G.push('        return make_aniso(EO_EPS_RF_E, EO_EPS_RF_O) if rf else make_aniso(NE ** 2, NO ** 2)');
  G.push('    if rf:');
  G.push('        return td.Medium(permittivity=MATERIAL_EPS_RF.get(material, 1.0))');
  G.push('    return td.Medium(permittivity=MATERIAL_INDEX.get(material, 1.0) ** 2)');
  G.push('');
  G.push('CONDUCTOR_MEDIUM = td.PECMedium()  # optical solve: PEC is the standard assumption');
  G.push('# RF conductor loss (optional): swap in a surface-impedance lossy metal, e.g. gold');
  G.push('# (sigma = 4.1e7 S/m = 41 S/um — tidy3d conductivity unit is S/um):');
  G.push('# CONDUCTOR_MEDIUM_RF = td.LossyMetalMedium(conductivity=41.0,');
  G.push('#     frequency_range=(float(FREQS_RF_HZ[0]), float(FREQS_RF_HZ[-1])))');
  G.push('CONDUCTOR_MEDIUM_RF = CONDUCTOR_MEDIUM');
  G.push('');
  G.push('def _box(t0, t1, z0, z1):');
  G.push('    return td.Box(center=(0.5 * (t0 + t1), 0.5 * (z0 + z1), 0.0),');
  G.push('                  size=(max(t1 - t0, 0.0), max(z1 - z0, 0.0), td.inf))');
  G.push('');
  G.push('_WG_LAYER_IDS = set(w["layer_id"] for w in WAVEGUIDES)');
  G.push('');
  G.push('def build_structures(rf=False):');
  G.push('    """td.Structure list for the cross-section. Later entries OVERRIDE earlier');
  G.push('    ones in tidy3d, which is how the rib etch is realized: the waveguide layer');
  G.push('    is laid down as cladding fill, then the partially-etched slab band, then');
  G.push('    the trapezoid core (PolySlab in the (x, y) mode plane, extruded along z).');
  G.push('    """');
  G.push('    S = []');
  G.push('    for s in SLABS:');
  G.push('        if s["role"] == "air":');
  G.push('            continue  # background medium is already vacuum/air');
  G.push('        if s["layer_id"] in _WG_LAYER_IDS:');
  G.push('            continue  # rebuilt from WAVEGUIDES below (fill + slab band + core)');
  G.push('        S.append(td.Structure(geometry=_box(T_MIN - X_PAD, T_MAX + X_PAD, s["z0"], s["z1"]),');
  G.push('                              medium=medium_for(s["material"], rf)))');
  G.push('    for w in WAVEGUIDES:');
  G.push('        S.append(td.Structure(geometry=_box(T_MIN - X_PAD, T_MAX + X_PAD, w["layer_z0"], w["layer_z1"]),');
  G.push('                              medium=medium_for(WG_FILL_MATERIAL, rf)))  # etched region');
  G.push('        for iv in w["slab_intervals"]:');
  G.push('            S.append(td.Structure(geometry=_box(iv["t0"], iv["t1"], w["slab_z0"], w["slab_z1"]),');
  G.push('                                  medium=medium_for(w["material"], rf)))');
  G.push('        for seg in w["core_segments"]:');
  G.push('            verts = [(seg["bot_t0"], w["core_z_bot"]), (seg["bot_t1"], w["core_z_bot"]),');
  G.push('                     (seg["top_t1"], w["core_z_top"]), (seg["top_t0"], w["core_z_top"])]');
  G.push('            S.append(td.Structure(geometry=td.PolySlab(vertices=verts, axis=2, slab_bounds=(-Z_EXT, Z_EXT)),');
  G.push('                                  medium=medium_for(w["material"], rf)))');
  G.push('    for c in CONDUCTORS:');
  G.push('        cz0, cz1 = c["z0"], c["z1"]');
  G.push('        if c["zero_thickness"]:');
  G.push('            cz0, cz1 = cz0 - 0.5 * SHEET_THICK_UM, cz0 + 0.5 * SHEET_THICK_UM');
  G.push('        for iv in c["intervals"]:');
  G.push('            S.append(td.Structure(geometry=_box(iv["t0"], iv["t1"], cz0, cz1),');
  G.push('                                  medium=(CONDUCTOR_MEDIUM_RF if rf else CONDUCTOR_MEDIUM)))');
  G.push('    return S');
  cells.push(codeCell(G));

  // ---- RF cell ----
  if (hasRf) {
    const R = [];
    R.push('# ============== RF: quasi-TEM line mode -> sqrt(eps_eff)(f), Z0(f) ==============');
    R.push('sim_rf = td.Simulation(');
    R.push('    center=(T_MID, Z_MID, 0.0),');
    R.push('    size=(T_SPAN, Z_SPAN, 4.0 * GRID_DL_RF),');
    R.push('    grid_spec=td.GridSpec.uniform(dl=GRID_DL_RF),');
    R.push('    structures=build_structures(rf=True),');
    R.push('    medium=td.Medium(permittivity=1.0),');
    R.push('    boundary_spec=td.BoundarySpec.all_sides(boundary=td.Periodic()),');
    R.push('    run_time=1e-12,  # required by the schema; unused by the mode solver');
    R.push(')');
    R.push('solver_rf = ModeSolver(');
    R.push('    simulation=sim_rf,');
    R.push('    plane=td.Box(center=(T_MID, Z_MID, 0.0), size=(T_SPAN, Z_SPAN, 0.0)),');
    R.push('    mode_spec=td.ModeSpec(num_modes=1, target_neff=NEFF_GUESS_RF),');
    R.push('    freqs=[float(f) for f in FREQS_RF_HZ],');
    R.push(')');
    R.push('rf_data = solver_rf.solve()  # LOCAL eigenmode solve — no cloud account');
    R.push('');
    R.push('n_eff_rf = rf_data.n_eff.sel(mode_index=0)');
    R.push('sqrt_eps_eff = n_eff_rf  # for the quasi-TEM line mode, n_eff IS sqrt(eps_eff)');
    R.push('');
    R.push('# --- V and I path integrals (microwave plugin) ---');
    R.push('# Voltage: straight axis-aligned path across the signal -> nearest-ground gap');
    R.push('# (gap midline, at conductor mid-height). Current: Ampere loop enclosing ONLY');
    R.push('# the signal conductor. Both are computed FROM the parameter-cell geometry, so');
    R.push('# edits up there re-target the integrals.');
    R.push('_sig = [c for c in CONDUCTORS if ROLES.get(c["id"]) == "signal"]');
    R.push('_gnd = [c for c in CONDUCTORS if ROLES.get(c["id"]) == "ground"]');
    R.push('if not _sig or not _gnd:');
    R.push('    raise ValueError("ROLES needs at least one \'signal\' and one \'ground\' conductor")');
    R.push('sig = _sig[0]');
    R.push('if len(_sig) > 1:');
    R.push('    print("NOTE: multiple signal conductors — using", sig["id"], "for the V path / I loop")');
    R.push('sig_t0 = min(iv["t0"] for iv in sig["intervals"])');
    R.push('sig_t1 = max(iv["t1"] for iv in sig["intervals"])');
    R.push('sig_zmid = 0.5 * (sig["z0"] + sig["z1"])');
    R.push('');
    R.push('gap = None  # (t_from, t_to): nearest lateral signal->ground gap');
    R.push('for g in _gnd:');
    R.push('    for iv in g["intervals"]:');
    R.push('        if iv["t0"] >= sig_t1:');
    R.push('            cand = (sig_t1, iv["t0"])');
    R.push('        elif iv["t1"] <= sig_t0:');
    R.push('            cand = (iv["t1"], sig_t0)');
    R.push('        else:');
    R.push('            continue  # overlapping in t (different layer) — no lateral gap');
    R.push('        if gap is None or (cand[1] - cand[0]) < (gap[1] - gap[0]):');
    R.push('            gap = cand');
    R.push('if gap is None:');
    R.push('    raise ValueError("no lateral signal->ground gap found; place the V path manually")');
    R.push('');
    R.push('voltage_integral = mw.VoltageIntegralAxisAligned(');
    R.push('    center=(0.5 * (gap[0] + gap[1]), sig_zmid, 0.0),');
    R.push('    size=(gap[1] - gap[0], 0.0, 0.0),');
    R.push('    sign="+",');
    R.push('    extrapolate_to_endpoints=True,  # fields at PEC surfaces need extrapolation');
    R.push('    snap_path_to_grid=True,');
    R.push(')');
    R.push('_margin = 0.45 * (gap[1] - gap[0])  # keep the loop off the neighboring ground');
    R.push('current_integral = mw.CurrentIntegralAxisAligned(');
    R.push('    center=(0.5 * (sig_t0 + sig_t1), sig_zmid, 0.0),');
    R.push('    size=(sig_t1 - sig_t0 + 2.0 * _margin, (sig["z1"] - sig["z0"]) + 2.0 * _margin, 0.0),');
    R.push('    sign="+",');
    R.push('    extrapolate_to_endpoints=False,');
    R.push('    snap_contour_to_grid=True,');
    R.push(')');
    R.push('');
    R.push('imp_calc = mw.ImpedanceCalculator(voltage_integral=voltage_integral,');
    R.push('                                  current_integral=current_integral)');
    R.push('z0_da = imp_calc.compute_impedance(rf_data).sel(mode_index=0)');
    R.push('if float(np.real(z0_da.isel(f=0).values)) < 0.0:');
    R.push('    print("NOTE: flipped V-path sign so Re(Z0) > 0 (path-direction convention).")');
    R.push('    z0_da = -z0_da');
    R.push('');
    R.push('fghz = np.array([float(f) for f in n_eff_rf.coords["f"].values]) / 1e9');
    R.push('fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(11, 4))');
    R.push('ax1.plot(fghz, np.real(z0_da.values), label="Re Z0")');
    R.push('ax1.plot(fghz, np.imag(z0_da.values), label="Im Z0")');
    R.push('ax1.set_xlabel("f (GHz)"); ax1.set_ylabel("Z0 (Ohm)"); ax1.legend(); ax1.grid(True)');
    R.push('ax2.plot(fghz, np.real(n_eff_rf.values))');
    R.push('ax2.set_xlabel("f (GHz)"); ax2.set_ylabel("sqrt(eps_eff) = RF n_eff"); ax2.grid(True)');
    R.push('plt.tight_layout(); plt.show()');
    R.push('print("Z0 @ f0          :", complex(z0_da.isel(f=0).values))');
    R.push('print("sqrt(eps_eff) @ f0:", float(np.real(n_eff_rf.isel(f=0).values)))');
    cells.push(codeCell(R));
  } else {
    cells.push(mdCell([
      '## RF solve skipped',
      '',
      'The section line does not cross at least one **signal** and one **ground** conductor, so the quasi-TEM Z0 / √εeff extraction cannot be set up. Draw the section across the full transmission-line cross-section (signal and grounds) and re-export.',
    ]));
  }

  // ---- optical cell ----
  if (hasWg) {
    const O = [];
    O.push('# ===================== optical eigenmode(s) at LAMBDA_UM =====================');
    O.push('FREQ0 = td.C_0 / LAMBDA_UM  # td.C_0 in um/s -> FREQ0 in Hz');
    O.push('sim_opt = td.Simulation(');
    O.push('    center=(OPT_CENTER_T, OPT_CENTER_Z, 0.0),');
    O.push('    size=(OPT_WIN_X, OPT_WIN_Z, 1.0),');
    O.push('    grid_spec=td.GridSpec.auto(min_steps_per_wvl=20, wavelength=LAMBDA_UM),');
    O.push('    structures=build_structures(rf=False),');
    O.push('    medium=td.Medium(permittivity=1.0),');
    O.push('    boundary_spec=td.BoundarySpec.all_sides(boundary=td.Periodic()),');
    O.push('    run_time=1e-12,');
    O.push(')');
    O.push('solver_opt = ModeSolver(');
    O.push('    simulation=sim_opt,');
    O.push('    plane=td.Box(center=(OPT_CENTER_T, OPT_CENTER_Z, 0.0), size=(OPT_WIN_X, OPT_WIN_Z, 0.0)),');
    O.push('    mode_spec=td.ModeSpec(num_modes=N_OPT_MODES, target_neff=max(NE, NO)),');
    O.push('    freqs=[FREQ0],');
    O.push(')');
    O.push('opt_data = solver_opt.solve()  # LOCAL solve');
    O.push('print("optical n_eff per mode:", np.real(opt_data.n_eff.isel(f=0).values))');
    O.push('');
    O.push('def _mode_field(data, comp, m):');
    O.push('    """One field component of one mode on the (x, y) plane (fields are colocated)."""');
    O.push('    da = getattr(data, comp).isel(f=0, mode_index=m)');
    O.push('    return da.isel(z=0) if "z" in da.dims else da');
    O.push('');
    O.push('def _int2(arr, x, y):');
    O.push('    """Integrate arr(x, y) over the plane (trapezoid rule on the solver grid)."""');
    O.push('    return _trapz(_trapz(arr, y, axis=1), x, axis=0)');
    O.push('');
    O.push('def _pol_fraction(data, m):');
    O.push('    """Fraction of transverse E energy in the EO_COMP component (mode m)."""');
    O.push('    ex = _mode_field(data, "Ex", m); ey = _mode_field(data, "Ey", m)');
    O.push('    x = ex.coords["x"].values; y = ex.coords["y"].values');
    O.push('    pc = _int2(np.abs(_mode_field(data, EO_COMP, m).values) ** 2, x, y)');
    O.push('    pt = _int2(np.abs(ex.values) ** 2, x, y) + _int2(np.abs(ey.values) ** 2, x, y)');
    O.push('    return pc / pt');
    O.push('');
    O.push('# pick the FUNDAMENTAL mode with dominant polarization along the EO axis');
    O.push('# (modes come sorted by decreasing n_eff, so the first >0.5 fraction wins)');
    O.push('fracs = [float(_pol_fraction(opt_data, m)) for m in range(N_OPT_MODES)]');
    O.push('M_OPT = next((m for m in range(N_OPT_MODES) if fracs[m] > 0.5), int(np.argmax(fracs)))');
    O.push('print("EO-axis polarization fraction per mode:", fracs, "-> using mode", M_OPT)');
    O.push('n_eff_opt = float(np.real(opt_data.n_eff.isel(f=0, mode_index=M_OPT).values))');
    O.push('print("optical n_eff (chosen mode):", n_eff_opt)');
    O.push('');
    O.push('fig, axes = plt.subplots(1, N_OPT_MODES, figsize=(5 * N_OPT_MODES, 4), squeeze=False)');
    O.push('for m in range(N_OPT_MODES):');
    O.push('    solver_opt.plot_field("E", "abs", f=FREQ0, mode_index=m, ax=axes[0][m])');
    O.push('    axes[0][m].set_title("mode %d  n_eff=%.4f" % (m, float(np.real(opt_data.n_eff.isel(f=0, mode_index=m).values))))');
    O.push('plt.show()');
    cells.push(codeCell(O));
  }

  // ---- VpiL cells (markdown physics + code) ----
  if (hasVpil) {
    cells.push(mdCell([
      '### VπL extraction (perturbation-theory overlap)',
      '',
      'The RF mode fields are normalized to a **1 V drive**: V_rf is the mode-field voltage over the same signal→ground path used for Z0, and E⁽¹ⱽ⁾ = E_RF / V_rf. The EO index perturbation along the crystal axis *c* (both polarizations are driven by the **same** RF component E⁽¹ⱽ⁾_c):',
      '',
      '- light polarized ∥ c:  Δn_e = −½ n_e³ r₃₃ E⁽¹ⱽ⁾_c',
      '- light polarized ⊥ c:  Δn_o = −½ n_o³ r₁₃ E⁽¹ⱽ⁾_c',
      '',
      'First-order perturbation of the optical mode (weight w = |E_pol|², the intensity of the mode\'s dominant transverse polarization; valid for the moderate index contrast and dominant-polarization modes of a rib guide):',
      '',
      '  Δn_eff(1V) = ∫∫_EO Δn(x, y) · w(x, y) dA / ∫∫ w dA',
      '',
      'with the numerator restricted to the EO layer region. Then **VπL = λ / (2 |Δn_eff(1V)|)**, reported in V·cm. Quasi-static: the RF field is taken at the lowest sweep frequency, in phase with the drive (real part). References: Wooten et al., *IEEE JSTQE* **6**, 69 (2000); C. Wang et al., *Nature* **562**, 101 (2018).',
    ]));
    const V = [];
    V.push('# ===================== EO VpiL: 1 V-normalized overlap =====================');
    V.push('F_EO_INDEX = 0  # RF sweep row used for the overlap (quasi-static -> lowest f)');
    V.push('');
    V.push('# --- 1 V normalization: V_rf = mode-field voltage across the drive gap ---');
    V.push('v_rf = voltage_integral.compute_voltage(rf_data).sel(mode_index=0).isel(f=F_EO_INDEX)');
    V.push('v_rf = complex(v_rf.values)');
    V.push('print("RF mode-field gap voltage V_rf =", v_rf, "V")');
    V.push('');
    V.push('e_rf_c = getattr(rf_data, EO_COMP).sel(mode_index=0).isel(f=F_EO_INDEX)');
    V.push('if "z" in e_rf_c.dims:');
    V.push('    e_rf_c = e_rf_c.isel(z=0)');
    V.push('e1v = e_rf_c / v_rf  # RF field per volt applied signal->ground (V/um per V)');
    V.push('');
    V.push('# --- optical weight w = |E_major|^2 of the chosen mode ---');
    V.push('maj = EO_COMP if fracs[M_OPT] > 0.5 else ("Ex" if EO_COMP == "Ey" else "Ey")');
    V.push('w_da = _mode_field(opt_data, maj, M_OPT)');
    V.push('w = np.abs(w_da.values) ** 2');
    V.push('x_o = w_da.coords["x"].values; y_o = w_da.coords["y"].values');
    V.push('');
    V.push('# --- RF field interpolated onto the optical grid (mode data are xarray) ---');
    V.push('e1v_o = e1v.interp(x=w_da.coords["x"], y=w_da.coords["y"]).values');
    V.push('e1v_o = np.nan_to_num(np.real(e1v_o))  # quasi-static: field in phase with the drive');
    V.push('');
    V.push('# --- EO index perturbation per volt on the optical grid ---');
    V.push('# r in pm/V, E in V/um -> r*E*1e-6 is the dimensionless index shift factor');
    V.push('if fracs[M_OPT] > 0.5:');
    V.push('    dn = -0.5 * NE ** 3 * (R33_PM_PER_V * 1e-6) * e1v_o  # light along c: r33');
    V.push('else:');
    V.push('    dn = -0.5 * NO ** 3 * (R13_PM_PER_V * 1e-6) * e1v_o  # light perp c: r13');
    V.push('');
    V.push('# --- restrict the perturbation to the EO layer band ---');
    // The EO material only exists where the FILM does. A plain z-band mask
    // credited the Pockels effect to the cladding/fill regions inside the
    // film band (the film is etched away there) — inflating Gamma and
    // faking a lower VpiL. When the EO layer is the waveguide layer, build
    // the mask from the actual slab-band intervals + core trapezoid bbox;
    // any other (unetched) EO layer keeps the full-width z-band.
    V.push('zz = y_o[None, :]');
    V.push('xx = x_o[:, None]');
    V.push('eo_wgs = [w for w in WAVEGUIDES if w["layer_id"] == EO_LAYER_ID]');
    V.push('if eo_wgs:');
    V.push('    eo_mask = np.zeros((x_o.size, y_o.size), dtype=bool)');
    V.push('    for w in eo_wgs:');
    V.push('        for iv in w["slab_intervals"]:');
    V.push('            eo_mask |= ((zz >= w["slab_z0"]) & (zz <= w["slab_z1"])');
    V.push('                        & (xx >= iv["t0"]) & (xx <= iv["t1"]))');
    V.push('        for sg in w["core_segments"]:');
    V.push('            x0 = min(sg["bot_t0"], sg["top_t0"]); x1 = max(sg["bot_t1"], sg["top_t1"])');
    V.push('            eo_mask |= ((zz >= w["core_z_bot"]) & (zz <= w["core_z_top"]) & (xx >= x0) & (xx <= x1))');
    V.push('    eo_mask = eo_mask.astype(float)');
    V.push('else:');
    V.push('    eo_mask = ((zz >= EO_LAYER_Z0) & (zz <= EO_LAYER_Z1)) * np.ones((x_o.size, 1))');
    V.push('');
    V.push('num = _int2(dn * w * eo_mask, x_o, y_o)');
    V.push('den = _int2(w, x_o, y_o)');
    V.push('dn_eff = num / den                      # Delta n_eff for a 1 V drive');
    V.push('gamma_eo = _int2(w * eo_mask, x_o, y_o) / den  # optical power fraction in the EO layer');
    V.push('');
    V.push('vpil_v_cm = (LAMBDA_UM / (2.0 * abs(dn_eff))) * 1e-4  # V*um -> V*cm');
    V.push('print("Gamma (optical fraction in EO layer) =", float(gamma_eo))');
    V.push('print("dn_eff per volt                      =", float(dn_eff))');
    V.push('print("VpiL                                 =", float(vpil_v_cm), "V*cm")');
    cells.push(codeCell(V));
  } else {
    cells.push(mdCell([
      '## VπL skipped',
      '',
      hasWg
        ? 'A VπL needs the RF mode fields, and the RF solve was skipped above (no signal/ground conductor pair crossed). Re-export with the section line crossing the electrodes.'
        : 'A VπL calculation **requires a waveguide**: the section line does not cross any rib-waveguide core, so there is no optical mode to overlap with the RF field. Draw the section line across the modulator waveguide (between/under the electrodes) and re-export. The RF-only part of this notebook (Z0, √εeff) still runs.',
    ]));
  }

  // ---- cross-section preview ----
  const C = [];
  C.push('# ===================== cross-section sanity view =====================');
  C.push('from matplotlib.patches import Polygon as _MplPoly, Rectangle as _MplRect');
  C.push('fig, ax = plt.subplots(figsize=(10, 5))');
  C.push('for s in SLABS:');
  C.push('    ax.add_patch(_MplRect((T_MIN, s["z0"]), T_SPAN, s["z1"] - s["z0"],');
  C.push('                          facecolor=s["color"], edgecolor="none", alpha=0.6))');
  C.push('for w in WAVEGUIDES:');
  C.push('    for iv in w["slab_intervals"]:');
  C.push('        ax.add_patch(_MplRect((iv["t0"], w["slab_z0"]), iv["t1"] - iv["t0"], w["slab_z1"] - w["slab_z0"],');
  C.push('                              facecolor=w["color"], edgecolor="none", alpha=0.9))');
  C.push('    for seg in w["core_segments"]:');
  C.push('        ax.add_patch(_MplPoly([(seg["bot_t0"], w["core_z_bot"]), (seg["bot_t1"], w["core_z_bot"]),');
  C.push('                               (seg["top_t1"], w["core_z_top"]), (seg["top_t0"], w["core_z_top"])],');
  C.push('                              closed=True, facecolor=w["color"], edgecolor="k", lw=0.5))');
  C.push('for c in CONDUCTORS:');
  C.push('    for iv in c["intervals"]:');
  C.push('        ax.add_patch(_MplRect((iv["t0"], c["z0"]), iv["t1"] - iv["t0"],');
  C.push('                              max(c["z1"] - c["z0"], SHEET_THICK_UM),');
  C.push('                              facecolor=c["color"], edgecolor="k", lw=0.5))');
  C.push('ax.set_xlim(T_MIN, T_MAX); ax.set_ylim(Z_MIN, Z_MAX)');
  C.push('ax.set_xlabel("t (um along section)"); ax.set_ylabel("z (um)")');
  C.push('ax.set_title("cross-section (drawn from the parameter cell)")');
  C.push('plt.show()');
  if (hasRf) {
    C.push('');
    C.push('# permittivity sanity view of the ACTUAL RF simulation (should match the sketch)');
    C.push('sim_rf.plot_eps(z=0.0, freq=float(FREQS_RF_HZ[0]))');
    C.push('plt.show()');
  }
  cells.push(codeCell(C));

  // ---- final caveats ----
  const F = [];
  F.push('## Caveats');
  F.push('');
  F.push('- **Phase matching assumed**: VπL is the DC/low-frequency overlap value. Velocity mismatch, RF loss walk-off and electrode microwave loss reduce the effective bandwidth — those live in the traveling-wave model, not here.');
  F.push('- **PEC optical electrodes**: real metals absorb; if the optical mode overlaps the metal noticeably (small gap), the mode solve underestimates loss and slightly mis-shapes the mode.');
  F.push(`- **Quasi-static overlap**: the RF field pattern is taken at the lowest sweep frequency (${pf(freqStartGHz)} GHz).`);
  F.push('- **Local mode solver**: `.solve()` skips subpixel averaging — refine `GRID_DL_RF` / `min_steps_per_wvl` and check convergence, or run the remote solver.');
  F.push('- **RF material table**: `MATERIAL_EPS_RF` and the EO crystal RF permittivities (28/43 for clamped LiNbO3) are generic defaults — set your film\'s measured values.');
  if ((cross.warnings || []).length) {
    F.push('');
    F.push('**Cross-section generator warnings** (verbatim):');
    for (const w of cross.warnings) F.push(`- \`${w.code}\`: ${w.msg}`);
  }
  cells.push(mdCell(F));

  const nb = {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' },
      language_info: { name: 'python', version: '3' },
      photonic_layout: { generator: 'tidy3d-notebook', design: designName, section: cross.sectionId || null },
    },
    cells,
  };
  return { ipynb: JSON.stringify(nb, null, 1), warnings };
}
