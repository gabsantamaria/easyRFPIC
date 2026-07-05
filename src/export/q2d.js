// Ansys 2D Extractor (Q2D) cross-section export.
//
// Input is a CROSS-SECTION DATA CONTRACT object (buildCrossSection): a vertical
// slice through the layer stack along a user-drawn section line. The script
// rebuilds that slice as planar sheets in a fresh "2D Extractor" design —
// x = t (µm along the section line from p0), y = stack Z (µm), z = 0 — assigns
// signal/ground conductors, inserts a CG+RL matrix setup + interpolating
// frequency sweep, and creates Z0 / sqrt(eps_eff) reports (plus an optional
// E-field probe at the crossed waveguide core center).
//
// COM signatures are copied from pyAEDT source (verified 2026-07; AEDT 2023R+):
//   - AssignSingleSignalLine / AssignSingleReferenceGround props
//     ["NAME:<n>", "Objects:=", [...], "SolveOption:=", "...", "Thickness:=", "..."]:
//     https://github.com/ansys/pyaedt/blob/main/src/ansys/aedt/core/q3d.py
//       (Q2d.assign_single_conductor builds {"Objects","SolveOption","Thickness"})
//     https://github.com/ansys/pyaedt/blob/main/src/ansys/aedt/core/modules/boundary/common.py
//       (bound_type "SignalLine" -> oboundary.AssignSingleSignalLine(_get_args()))
//   - InsertSetup type string "2DMatrix" + the Open template's
//     AdaptiveFreq/SaveFields/Enabled/MeshLink/CGDataBlock/RLDataBlock/
//     CacheSaveKind/ConstantDelta blocks:
//     https://github.com/ansys/pyaedt/blob/main/src/ansys/aedt/core/modules/setup_templates.py
//       (Open = template index 30; SetupKeys.SetupNames[30] == "2DMatrix")
//   - InsertSweep(setup, [NAME:..., IsEnabled, RangeType, ..., Type, SaveFields]):
//     https://github.com/ansys/pyaedt/blob/main/src/ansys/aedt/core/modules/solve_sweeps.py
//       (SweepMatrix -> oanalysis.InsertSweep(setup_name, _get_args()))
//   - CreateRectangle 2-D form (IsCovered/XStart/YStart/ZStart/Width/Height/WhichAxis "Z"):
//     https://github.com/ansys/pyaedt/blob/main/src/ansys/aedt/core/modeler/cad/primitives_2d.py
//   - CreatePoint (PointParameters + Attributes):
//     https://github.com/ansys/pyaedt/blob/main/src/ansys/aedt/core/modeler/cad/primitives.py
//   - FieldsReporter EnterQty / CalcOp verbs:
//     https://github.com/ansys/pyaedt/blob/main/src/ansys/aedt/core/visualization/post/post_common_3d.py
//     (AddNamedExpression is the classic recorded-script verb; current pyAEDT
//      routes named expressions through LoadNamedExpressions/a TOML catalog, so
//      the whole field-point block stays inside one try/except.)
//
// PARAMETRIC NOTE (units — read before touching set_var): the contract's *Expr
// strings carry the µm unit OUTSIDE the parens ("(h_wg)um", "(h_wg + h_cond)um").
// That form only works if the referenced design variables are DIMENSIONLESS —
// a length-typed variable inside "(...)um" double-converts (the exact
// "(h_si)um -> picometre layers" bug documented in q3d.js/CLAUDE.md). So every
// cross.params variable is declared as a BARE NUMBER (set_var("h_wg", "0.6"))
// and the model units are forced to um: "(h_wg)um" is then 0.6*um, and the
// hfss-native-style compound form "(0um) + (h_wg)" also resolves (dimensionless
// terms read in model units = um). Do NOT append "um" to these declarations.
//
// The "(X)um" form is a standalone-only AEDT parser quirk: accepted as a whole
// field value, REJECTED inside any compound (after ")" it wants an operator,
// not "u" — see hfss-native.js exprWithUm). Positions emit the contract expr
// VERBATIM (standalone field). Sizes are (end - start) COMPOUNDS, so the µm
// suffix is stripped off both operands first (balanced-paren check) and the
// difference re-typed with *1um; mismatched/unstrippable expr pairs fall back
// to the always-present numerics.

import { simplifyExpr } from '../scene/expr-simplify.js';

// ASCII sanitizer for the emitted script. Common typographic chars map to
// readable ASCII first (the emitted comments use em-dashes/arrows) so the
// generated Python stays legible; anything else non-ASCII becomes '?'.
const ascii = (s) => String(s ?? '')
  .replace(/—|–/g, '-').replace(/→/g, '->')
  .replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
  .replace(/µ|μ/g, 'u').replace(/⇒/g, '=>')
  .replace(/[^\x00-\x7F]/g, '?');
// Plain decimal (no exponent, no float noise), same as q3d.js.
const dec = (x) => { if (!Number.isFinite(x)) return '0'; let s = (Math.round(x * 1e9) / 1e9).toFixed(9); if (s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\.$/, ''); return s || '0'; };
const sane = (s) => String(s ?? '').replace(/[^A-Za-z0-9_]/g, '_');
// '#7dd3fc' -> '(125 211 252)' for the AEDT Color attribute; fallback grey.
const rgb = (hex) => {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(String(hex ?? '').trim());
  if (!m) return '(160 160 160)';
  const v = parseInt(m[1], 16);
  return `(${(v >> 16) & 255} ${(v >> 8) & 255} ${v & 255})`;
};

// If expr has the contract's standalone "(X)um" shape — ONE outer balanced
// paren group followed by exactly "um" — return the inner "(X)" (unit
// stripped, still parenthesized); else null. The balance check matters:
// "(a)um + (b)um" must NOT match (its first ")" closes before the end).
const innerOf = (expr) => {
  const s = String(expr ?? '').trim();
  if (!s.startsWith('(') || !s.endsWith(')um')) return null;
  const body = s.slice(0, -2); // "(X)"
  let depth = 0;
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '(') depth++;
    else if (body[i] === ')') {
      depth--;
      if (depth < 0) return null;
      if (depth === 0 && i !== body.length - 1) return null; // closed early -> compound
    }
  }
  return depth === 0 ? body : null;
};

// Position field: contract expr VERBATIM when present (standalone fields accept
// the "(X)um" quirk form), else the numeric baked in µm. The contract emits
// ENORMOUS composed exprs (snap-chain + transform-matrix + boolean-bbox
// fallbacks) full of `+ (0)`, `* (1)`, `cos(180deg)`, and float noise — so the
// INNER (unit-free) part is run through simplifyExpr, which is numeric-identity
// self-guarded (any risk -> it returns the inner unchanged). Non-quirk exprs
// (rare here) pass through verbatim.
const posStr = (expr, numeric) => {
  const s = String(expr ?? '').trim();
  if (!s) return `${dec(numeric)}um`;
  const inner = innerOf(s); // "(X)" if the standalone quirk form, else null
  if (inner) return `(${simplifyExpr(inner)})um`;
  return s;
};

// Size field: (end - start). Compound context, so "(X)um" operands must be
// unit-stripped and the difference re-typed via *1um (variables are declared
// dimensionless — see the units note in the module header). Two exprs that
// BOTH lack the quirk form are assumed hfss-native compound-safe ("(0um) +
// (h_wg)") and differenced directly. Anything mixed/absent -> numeric.
//
// The difference is simplifyExpr'd BEFORE re-typing so structurally-cancelling
// spans collapse — e.g. a real conductor width `(BIG + w/2) - (BIG - w/2)`
// becomes the single width param `w`. KEEP the `*1um` suffix: AEDT rejects the
// standalone "(X)um" form inside a compound field value, so a simplified span
// that reduces to a lone variable still needs the multiply to carry the unit.
const spanStr = (e0, e1, n0, n1) => {
  const s0 = String(e0 ?? '').trim(), s1 = String(e1 ?? '').trim();
  if (s0 && s1) {
    const i0 = innerOf(s0), i1 = innerOf(s1);
    if (i0 && i1) return `(${simplifyExpr(`${i1} - ${i0}`)})*1um`;
    if (!i0 && !i1) return `(${simplifyExpr(`(${s1}) - (${s0})`)})`;
  }
  return `${dec(n1 - n0)}um`;
};

// AEDT built-in material names that must NOT be re-defined (AddMaterial on an
// existing sysdb name errors) — same set as q3d.js, plus the common aliases the
// stack editor uses.
const STD_MATS = new Set(['vacuum', 'air', 'copper', 'gold', 'aluminum', 'silicon', 'silicon_dioxide', 'silicon_nitride', 'FR4_epoxy', 'polyimide', 'Pec', 'Teflon_based']);
// [eps_r, mu_r, sigma, tan_d] for known non-built-ins. LiNbO3/LiTaO3 are
// emitted as SCALAR eps (RF, single-value approx; LN 28 is the CLAMPED eps33 (c-axis) — the ordinary eps11 is ~43; anisotropy is not modeled here) — Q2D's AddMaterial
// here is isotropic; edit the material in AEDT for the full anisotropic tensor
// if the cut orientation matters to your Z0/eps_eff.
const CUSTOM_DIEL = {
  lithium_tantalate: [41.4, 1, 0, 0.001],
  lithium_niobate: [28.0, 1, 0, 0.001],
  LiNbO3: [28.0, 1, 0, 0.001],
  LiTaO3: [41.4, 1, 0, 0.001],
  SiO2: [3.9, 1, 0, 0.0001],
};

// ── Role validation (UI helper + generate gate) ─────────────────────────
// Every conductor crossed by the section line needs an explicit port role;
// the Q2D matrix needs at least one SignalLine and one ReferenceGround.
export function validateQ2DRoles(cross, roles) {
  const conds = (cross && cross.conductors) || [];
  if (conds.length === 0) return { ok: false, error: 'The section line crosses no conductors — nothing to solve in Q2D.' };
  const r = roles || {};
  const missing = conds.filter((c) => r[c.id] !== 'signal' && r[c.id] !== 'ground').map((c) => c.id);
  if (missing.length) return { ok: false, error: `Assign signal/ground to every crossed conductor (missing: ${missing.join(', ')}).` };
  if (!conds.some((c) => r[c.id] === 'signal')) return { ok: false, error: 'At least one conductor must be a SIGNAL.' };
  if (!conds.some((c) => r[c.id] === 'ground')) return { ok: false, error: 'At least one conductor must be a GROUND (reference).' };
  return { ok: true };
}

// Guarded logger — AddMessage can itself throw on a stale handle and escalate a
// caught error into an "abnormal script termination" (see q3d.js). Never let it.
const Q2D_MSG_DEF = `def q2d_msg(sev, text):
    try:
        oDesktop.AddMessage("", "", sev, str(text))
    except:
        pass`;

// Modal-COM-error discipline (CLAUDE.md "abnormal script termination"): in AEDT
// IronPython, deleting/uniting a NON-EXISTENT object raises a MODAL error that
// try/except cannot catch — the script macro aborts. Every destructive call is
// therefore existence-gated via GetObjectsInGroup first.
const Q2D_HELPERS = `def _existing_objs():
    objs = set()
    for grp in ("Solids", "Sheets", "Unclassified"):
        try:
            for o in oEditor.GetObjectsInGroup(grp):
                objs.add(o)
        except:
            pass
    return objs
def _q2d_del(name):
    # Delete only if the object ALREADY exists — deleting a missing object is a
    # MODAL error IronPython cannot catch (one abort per object on a fresh design).
    try:
        if name in _existing_objs():
            oEditor.Delete(["NAME:Selections", "Selections:=", name])
    except:
        pass
def q2d_rect(rp, attr, name):
    _q2d_del(name)
    try:
        oEditor.CreateRectangle(rp, attr)
    except Exception as e:
        q2d_msg(1, "CreateRectangle " + name + " failed: " + str(e))
def q2d_poly(pp, attr, name):
    _q2d_del(name)
    try:
        oEditor.CreatePolyline(pp, attr)
    except Exception as e:
        q2d_msg(1, "CreatePolyline " + name + " failed: " + str(e))
def q2d_subtract(blank, tools):
    # Carve overlapping objects out of a background slab. KeepOriginals=True —
    # the tools are REAL conductors/waveguide bodies that must survive; only the
    # slab loses material. Existence-filtered (modal-error discipline above).
    have = _existing_objs()
    if blank not in have:
        return
    sel = [t for t in tools if t in have]
    if not sel:
        return
    try:
        oEditor.Subtract(
            ["NAME:Selections", "Blank Parts:=", blank, "Tool Parts:=", ",".join(sel)],
            ["NAME:SubtractParameters", "KeepOriginals:=", True])
    except Exception as e:
        q2d_msg(1, "Subtract " + blank + " failed: " + str(e))`;

// ── Main emitter ────────────────────────────────────────────────────────
export function generateQ2DExtractor(cross, opts = {}) {
  if (!cross || cross.ok === false) {
    throw new Error(`Cross-section is unusable: ${(cross && cross.error) || 'no cross-section data'}`);
  }
  const roles = opts.roles || {};
  const rv = validateQ2DRoles(cross, roles);
  if (!rv.ok) throw new Error(rv.error);

  const design = sane(opts.designName || 'q2d_section');
  const fStart = Number.isFinite(opts.freqStartGHz) && opts.freqStartGHz > 0 ? opts.freqStartGHz : 1;
  const fStop = Number.isFinite(opts.freqStopGHz) && opts.freqStopGHz > fStart ? opts.freqStopGHz : Math.max(fStart * 2, 50);
  const fPoints = Number.isFinite(opts.freqPoints) && opts.freqPoints >= 2 ? Math.round(opts.freqPoints) : 200;
  // Adaptive frequency: geometric mean of the band — one adaptive mesh that is
  // reasonable at both band edges (arithmetic mean over-weights the top).
  const fAdapt = Number.isFinite(opts.adaptFreqGHz) && opts.adaptFreqGHz > 0
    ? opts.adaptFreqGHz : Math.round(Math.sqrt(fStart * fStop) * 1e6) / 1e6;
  const cgPerError = Number.isFinite(opts.cgPerError) && opts.cgPerError > 0 ? opts.cgPerError : 0.1;
  const rlPerError = Number.isFinite(opts.rlPerError) && opts.rlPerError > 0 ? opts.rlPerError : 0.1;
  const minPasses = Number.isFinite(opts.minPasses) && opts.minPasses >= 1 ? Math.round(opts.minPasses) : 1;
  let maxPasses = Number.isFinite(opts.maxPasses) && opts.maxPasses >= 1 ? Math.round(opts.maxPasses) : 16;
  if (maxPasses < minPasses) maxPasses = minPasses;
  const zeroThk = Number.isFinite(opts.condThicknessUm) && opts.condThicknessUm > 0 ? opts.condThicknessUm : 0.5;
  const includeFieldPoint = opts.includeFieldPoint !== false;
  // The Z0 / sqrt(eps_eff) reports read the SWEEP solution and the E-field
  // named expressions read the LastAdaptive FIELD solution — neither exists
  // until Setup1 is solved. So the script SOLVES the (fast, 2-D) setup before
  // creating them; without this, report + field-calculator calls fail with
  // "No Solution found" / "Unable to find list of variables for this context"
  // (the errors this script hit on first run). Set opts.autoSolve = false to
  // build-only (then Analyze + create the reports manually).
  const autoSolve = opts.autoSolve !== false;

  const dom = cross.domain || { tMin: 0, tMax: cross.line?.lengthUm || 0 };
  const tMin = Number.isFinite(dom.tMin) ? dom.tMin : 0;
  const tMax = Number.isFinite(dom.tMax) ? dom.tMax : 0;
  const slabs = cross.slabs || [];
  const conductors = cross.conductors || [];
  const waveguides = cross.waveguides || [];

  // ---- Design variables: contract params, declared DIMENSIONLESS ----
  // (see the units note in the module header — the "(param)um" expr form
  // requires bare-number variables + model units um; length-typing them here
  // would double-convert every parametric position).
  const varDecls = [];
  for (const [name, v] of Object.entries(cross.params || {})) {
    if (!/^[A-Za-z_]\w*$/.test(name) || !Number.isFinite(v)) continue;
    varDecls.push(`set_var("${name}", "${dec(v)}")  # dimensionless; used as (${name})um in geometry`);
  }

  // ---- Materials ----
  const dielMats = new Set();
  for (const s of slabs) if (s.material) dielMats.add(s.material);
  for (const w of waveguides) if (w.material) dielMats.add(w.material);
  const condMats = new Set();
  for (const c of conductors) if (c.material) condMats.add(c.material);
  const matDefs = [];
  for (const m of dielMats) {
    if (!m || STD_MATS.has(m) || m === 'vacuum' || m === 'air') continue;
    const p = CUSTOM_DIEL[m] || [4.0, 1, 0, 0.001];
    matDefs.push(`define_material("${ascii(m)}", ${p[0]}, ${p[1]}, ${p[2]}, ${p[3]})`);
  }
  for (const m of condMats) {
    if (!m || STD_MATS.has(m) || dielMats.has(m)) continue;
    // Unknown CONDUCTOR material: define with a gold-ish conductivity so the RL
    // solve has finite loss (edit sigma in AEDT for the real metal).
    matDefs.push(`define_material("${ascii(m)}", 1, 1, 4.1e7, 0)  # conductor fallback sigma`);
  }

  // ---- Geometry ----
  // Every emitted object is tracked with its numeric z-range (and t-range) so
  // the per-slab overlap subtraction below can be computed HERE (numerically,
  // the contract guarantees numerics) rather than in AEDT.
  const geoBlocks = [];
  const tools = []; // { name, zLo, zHi, tLo, tHi } — non-slab objects
  const rectBlock = (name, xs, ys, w, h, color, mat, transparency, solveInside) => `q2d_rect(
    ["NAME:RectangleParameters", "IsCovered:=", True,
     "XStart:=", "${xs}", "YStart:=", "${ys}", "ZStart:=", "0um",
     "Width:=", "${w}", "Height:=", "${h}", "WhichAxis:=", "Z"],
    ["NAME:Attributes", "Name:=", "${name}", "Flags:=", "", "Color:=", "${color}",
     "Transparency:=", ${transparency}, "PartCoordinateSystem:=", "Global",
     "MaterialValue:=", "\\"${ascii(mat)}\\"", "SolveInside:=", ${solveInside}],
    "${name}")`;

  // Slabs: full-width background dielectrics, bottom -> top. X spans the whole
  // section domain (numeric — the domain has no exprs in the contract); Y uses
  // the layer-Z exprs when present so a thickness sweep moves the slice.
  const slabInfos = []; // { name, z0, z1 }
  for (const s of slabs) {
    const z0 = s.z0, z1 = s.z1;
    if (!Number.isFinite(z0) || !Number.isFinite(z1) || z1 - z0 <= 0) continue;
    // WAVEGUIDE-role slabs are NOT drawn. The contract's slab list carries the
    // full unetched film band with PAINT-ORDER semantics (later slab overpaints
    // earlier) — the SVG preview and the tidy3d notebook honor that, but Q2D
    // has no painting concept: drawing the film slab produced two full-width
    // rects claiming the same area on every COPLANAR stack (film + cladding
    // both z0..z1 — the app's default LTOI stack), an AMBIGUOUS model AEDT
    // rejects or resolves arbitrarily. The film material exists ONLY as the
    // waveguides' slabBand + core entries below (etched-film physics); the
    // region beside them is cladding (coplanar) or background vacuum
    // (sequential stack) — matching what generateHfssNative builds in 3-D.
    if (s.role === 'waveguide') continue;
    const name = `slab_${sane(s.layerId)}`;
    slabInfos.push({ name, z0, z1 });
    geoBlocks.push(`# slab: ${ascii(s.name || s.layerId)} (${ascii(s.role || '')}, ${ascii(s.material || 'vacuum')}) z ${dec(z0)}..${dec(z1)} um
${rectBlock(name, `${dec(tMin)}um`, posStr(s.z0Expr, z0), `${dec(tMax - tMin)}um`,
    spanStr(s.z0Expr, s.z1Expr, z0, z1), rgb(s.color), s.material || 'vacuum',
    s.role === 'air' ? 0.9 : 0.6, 'True')}`);
  }

  // Conductors: one rect per crossed interval, named <condId>_i<k>. Zero-
  // thickness conductors (h_cond = 0 in the stack) are drawn as THIN RECTS of
  // height condThicknessUm CENTERED on z0 — Q2D has no true zero-thickness
  // sheet conductor (no AssignImpedance equivalent on a 1-D edge), so a thin
  // solid stands in. CAVEAT: this replaces the HFSS sheet-impedance model — a
  // kinetic-inductance surface reactance (superconductor Lk) can NOT be
  // represented here; the RL solve sees only the bulk sigma of the material.
  const condBoundaries = []; // { name, role, objects[], thicknessUm }
  for (const c of conductors) {
    const cid = sane(c.id);
    const objs = [];
    const isSheet = !!c.zeroThickness;
    const z0 = c.z0, z1 = c.z1;
    const zLo = isSheet ? z0 - zeroThk / 2 : z0;
    const zHi = isSheet ? z0 + zeroThk / 2 : z1;
    // Y start/height: parametric when the contract provides exprs. The thin-
    // rect half-shift is a compound, so it reuses the unit-strip transform.
    let ys, hs;
    if (isSheet) {
      const i0 = innerOf(c.z0Expr);
      // Thin-sheet YStart = (conductor bottom) - half the drawn thickness.
      // Simplify the compound so a parametric z0 like "(h_wg)" collapses the
      // redundant parens; self-guarded, so numerically identical.
      ys = i0 ? `(${simplifyExpr(`${i0} - ${dec(zeroThk / 2)}`)})*1um` : `${dec(zLo)}um`;
      hs = `${dec(zeroThk)}um`;
    } else {
      ys = posStr(c.z0Expr, z0);
      hs = spanStr(c.z0Expr, c.z1Expr, z0, z1);
    }
    (c.intervals || []).forEach((iv, k) => {
      if (!Number.isFinite(iv.t0) || !Number.isFinite(iv.t1) || iv.t1 - iv.t0 <= 0) return;
      const name = `${cid}_i${k}`;
      objs.push(name);
      tools.push({ name, zLo, zHi, tLo: iv.t0, tHi: iv.t1 });
      geoBlocks.push(`# conductor ${ascii(c.label || c.id)} [${roles[c.id]}] interval ${k}: t ${dec(iv.t0)}..${dec(iv.t1)} um${isSheet ? ` — ZERO-THICKNESS conductor drawn ${dec(zeroThk)}um thick centered on z=${dec(z0)} (no kinetic-inductance/surface-impedance model in Q2D)` : ''}
${rectBlock(name, posStr(iv.t0Expr, iv.t0), ys, spanStr(iv.t0Expr, iv.t1Expr, iv.t0, iv.t1), hs,
      rgb(c.color), c.material || 'gold', 0, 'True')}`);
    });
    if (objs.length) {
      condBoundaries.push({ name: cid, role: roles[c.id], objects: objs, thicknessUm: isSheet ? zeroThk : Math.max(z1 - z0, 1e-6) });
    }
  }

  // Waveguides: partially-etched slab band rect(s) + the etch-angle trapezoid
  // core(s) as covered+closed polylines. The contract now carries parametric
  // t/z exprs for perpendicular axis-aligned cuts (emitted verbatim in the
  // standalone position fields); a missing expr bakes the numeric.
  for (const w of waveguides) {
    const wid = sane(w.id);
    const mat = w.material || 'vacuum';
    if (w.slabBand && Number.isFinite(w.slabBand.z0) && Number.isFinite(w.slabBand.z1) && w.slabBand.z1 - w.slabBand.z0 > 0) {
      const sb = w.slabBand;
      (sb.intervals || []).forEach((iv, k) => {
        if (!Number.isFinite(iv.t0) || !Number.isFinite(iv.t1) || iv.t1 - iv.t0 <= 0) return;
        const name = `wg_${wid}_slab${k}`;
        tools.push({ name, zLo: sb.z0, zHi: sb.z1, tLo: iv.t0, tHi: iv.t1 });
        geoBlocks.push(`# waveguide ${ascii(w.id)} slab band ${k}: t ${dec(iv.t0)}..${dec(iv.t1)}, z ${dec(sb.z0)}..${dec(sb.z1)} um
${rectBlock(name, posStr(iv.t0Expr, iv.t0), posStr(sb.z0Expr, sb.z0),
    spanStr(iv.t0Expr, iv.t1Expr, iv.t0, iv.t1), spanStr(sb.z0Expr, sb.z1Expr, sb.z0, sb.z1),
    rgb(w.color), mat, 0.2, 'True')}`);
      });
    }
    const core = w.core;
    if (core && Number.isFinite(core.zBot) && Number.isFinite(core.zTop) && core.zTop - core.zBot > 0) {
      (core.segments || []).forEach((sg, j) => {
        const pts = [
          [sg.botT0, core.zBot, sg.botT0Expr, core.zBotExpr], [sg.botT1, core.zBot, sg.botT1Expr, core.zBotExpr],
          [sg.topT1, core.zTop, sg.topT1Expr, core.zTopExpr], [sg.topT0, core.zTop, sg.topT0Expr, core.zTopExpr],
        ];
        if (pts.some(([a, b]) => !Number.isFinite(a) || !Number.isFinite(b))) return;
        const name = j === 0 ? `wg_${wid}_core` : `wg_${wid}_core_${j}`;
        tools.push({ name, zLo: core.zBot, zHi: core.zTop, tLo: Math.min(sg.botT0, sg.topT0), tHi: Math.max(sg.botT1, sg.topT1) });
        // Covered CLOSED polyline: explicit closure (first point repeated, 4
        // Line segments) — an implicitly-closed covered fill self-intersects
        // in AEDT (same contract as the hfss-native ring emission). PLPoint
        // X/Y are standalone fields, so a parametric expr goes in verbatim.
        const ring = [...pts, pts[0]];
        const ptStr = ring.map(([x, y, xE, yE]) => `["NAME:PLPoint", "X:=", "${posStr(xE, x)}", "Y:=", "${posStr(yE, y)}", "Z:=", "0um"]`).join(',\n          ');
        const segs = pts.map((_, s2) => `["NAME:PLSegment", "SegmentType:=", "Line", "StartIndex:=", ${s2}, "NoOfPoints:=", 2]`).join(',\n          ');
        geoBlocks.push(`# waveguide ${ascii(w.id)} core trapezoid ${j} (etch-angle sidewalls): z ${dec(core.zBot)}..${dec(core.zTop)} um
q2d_poly(
    ["NAME:PolylineParameters",
     "IsPolylineCovered:=", True, "IsPolylineClosed:=", True,
     ["NAME:PolylinePoints",
      ${ptStr}],
     ["NAME:PolylineSegments",
      ${segs}],
     ["NAME:PolylineXSection", "XSectionType:=", "None", "XSectionOrient:=", "Auto",
      "XSectionWidth:=", "0um", "XSectionTopWidth:=", "0um", "XSectionHeight:=", "0um",
      "XSectionNumSegments:=", "0", "XSectionBendType:=", "Corner"]],
    ["NAME:Attributes",
     "Name:=", "${name}", "Flags:=", "", "Color:=", "${rgb(w.color)}",
     "Transparency:=", 0.0, "PartCoordinateSystem:=", "Global",
     "MaterialValue:=", "\\"${ascii(mat)}\\"", "SolveInside:=", True],
    "${name}")`);
      });
    }
  }

  // ---- Overlap resolution ----
  // Overlapping objects are AMBIGUOUS in 2D Extractor (two materials claiming
  // the same area) — so every background slab has the objects that overlap its
  // z-range carved out (KeepOriginals=True: the tools survive; the slab becomes
  // the complement). Overlap is decided from the NUMERIC ranges (always present
  // in the contract); touching edges (zero-area overlap) do not subtract.
  const EPS = 1e-9;
  const subBlocks = [];
  for (const s of slabInfos) {
    const hit = tools.filter((t) =>
      Math.min(s.z1, t.zHi) - Math.max(s.z0, t.zLo) > EPS &&
      Math.min(tMax, t.tHi) - Math.max(tMin, t.tLo) > EPS);
    if (!hit.length) continue;
    subBlocks.push(`q2d_subtract("${s.name}", [${hit.map((t) => `"${t.name}"`).join(', ')}])`);
  }

  // ---- Conductor boundary assignment ----
  // ONE assignment per physical conductor covering ALL its interval rects
  // (pyAEDT: props {"Objects","SolveOption","Thickness"} -> AssignSingleSignalLine
  // / AssignSingleReferenceGround). SolveOption "SolveInside" solves the metal
  // volume (finite conductivity / skin effect); "SolveOnBoundary" is the faster
  // alternative for thick good conductors — edit in AEDT if wanted.
  const sigNames = condBoundaries.filter((b) => b.role === 'signal').map((b) => b.name);
  const bndCalls = condBoundaries.map((b) => {
    const fn = b.role === 'signal' ? 'q2d_signal' : 'q2d_ground';
    return `${fn}("${b.name}", [${b.objects.map((o) => `"${o}"`).join(', ')}], "${dec(b.thicknessUm)}um")`;
  }).join('\n');
  const sig = sigNames[0]; // first signal drives the Z0/Gamma report indices

  // ---- Field probe at the waveguide core center ----
  // Both in-plane components are emitted because "the field at the WG center"
  // is ambiguous for an EO overlap integral: E_along_section = ScalarX(E) (the
  // horizontal component along the section line — the relevant one for X-cut
  // LN with a horizontal optical axis) and E_vertical = ScalarY(E) (the stack
  // normal — the relevant one for Z-cut). Pick per your crystal cut.
  const wgc = includeFieldPoint && cross.wgCenter && Number.isFinite(cross.wgCenter.t) && Number.isFinite(cross.wgCenter.z) ? cross.wgCenter : null;
  // Short vertical probe LINE through the wg core center (±0.5 µm in z). A
  // Fields report's Context MUST be a POLYLINE (or a reduced matrix), NEVER a
  // bare point — pyAEDT's Fields._context builds ["Context:=", <polyline>,
  // "PointCount:=", N] and a point object is only ever a Fields-Calculator
  // EVALUATION location, not a report context. The earlier point-context
  // report silently produced no traces. A short line reported vs Distance
  // reads E across the core; the midpoint is the wg center.
  const probeHalf = 0.5;
  const fieldBlock = wgc ? `# ===== E-field probe THROUGH the waveguide core center (t=${dec(wgc.t)}, z=${dec(wgc.z)} um; comp ${ascii(wgc.compId || '?')}) =====
# Whole block is release-fragile (FieldsReporter named expressions + field
# reports change across AEDT versions) — one guarded unit.
try:
    # A Fields report needs a POLYLINE context (not a point). Short vertical
    # segment through the core center; E is read vs Distance, midpoint = center.
    oEditor.CreatePolyline(
        ["NAME:PolylineParameters", "IsPolylineCovered:=", False, "IsPolylineClosed:=", False,
         ["NAME:PolylinePoints",
          ["NAME:PLPoint", "X:=", "${dec(wgc.t)}um", "Y:=", "${dec(wgc.z - probeHalf)}um", "Z:=", "0um"],
          ["NAME:PLPoint", "X:=", "${dec(wgc.t)}um", "Y:=", "${dec(wgc.z + probeHalf)}um", "Z:=", "0um"]],
         ["NAME:PolylineSegments",
          ["NAME:PLSegment", "SegmentType:=", "Line", "StartIndex:=", 0, "NoOfPoints:=", 2]]],
        ["NAME:Attributes", "Name:=", "wg_probe", "Color:=", "(143 175 143)"])
    oFld = oDesign.GetModule("FieldsReporter")
    # Named expressions via the calculator (recorded-script verbs). 2D Extractor
    # fields live under the CG solution: the fields categories are exactly
    # "Matrix", "CG Fields", "RL Fields" (pyaedt Extractor2dConstants.
    # report_templates). Plain "Fields" is HFSS-only and throws here.
    oFld.CalcStack("clear")
    oFld.EnterQty("E")
    oFld.CalcOp("ScalarX")
    oFld.AddNamedExpression("E_along_section", "CG Fields")
    oFld.CalcStack("clear")
    oFld.EnterQty("E")
    oFld.CalcOp("ScalarY")
    oFld.AddNamedExpression("E_vertical", "CG Fields")
    oRpt = oDesign.GetModule("ReportSetup")
    # Fields exist only where the solve SAVED them — the Interpolating sweep
    # carries no field data, so the probe reports over LastAdaptive (the
    # adaptive frequency). Context = the polyline + PointCount; the primary
    # sweep of a field-over-geometry report is Distance (µm along the line).
    oRpt.CreateReport("E through WG center", "CG Fields", "Rectangular Plot",
        "Setup1 : LastAdaptive", ["Context:=", "wg_probe", "PointCount:=", 1001],
        ["Distance:=", ["All"]],
        ["X Component:=", "Distance", "Y Component:=", ["mag(E_along_section)", "mag(E_vertical)"]])
except Exception as e:
    q2d_msg(1, "Field-probe block failed (create the polyline + named expressions in the GUI): " + str(e))` : '# (no waveguide center crossed — E-field probe skipped)';

  // ---- Header ----
  const line = cross.line || { p0: { x: 0, y: 0 }, p1: { x: 0, y: 0 }, lengthUm: 0, axis: null };
  const roleTable = conductors.map((c) => `#   ${ascii(c.label || c.id).padEnd(24)} ${roles[c.id]}${c.zeroThickness ? '  (zero-thickness -> thin rect)' : ''}`).join('\n');
  const warnLines = (cross.warnings || []).map((w) => `# WARNING [${ascii(w.code)}]: ${ascii(w.msg)}`).join('\n');

  const code = `# -*- coding: utf-8 -*-
# Auto-generated Ansys 2D Extractor (Q2D) cross-section script (AEDT: Tools -> Run Script).
# ${autoSolve ? 'Builds the cross-section, SOLVES Setup1 (fast 2-D), then creates the Z0 / sqrt(eps_eff) / E reports.' : 'Builds the cross-section + setup; Analyze Setup1 from the GUI, then re-run the report block.'}
# Generated by PhotonicLayout — section "${ascii(cross.sectionId)}".
# Section line: (${dec(line.p0?.x)}, ${dec(line.p0?.y)}) -> (${dec(line.p1?.x)}, ${dec(line.p1?.y)}) um, length ${dec(line.lengthUm)} um, axis: ${line.axis || 'oblique'}.
# Plane mapping: X = t (um along the section line from p0), Y = stack Z (um), Z = 0.
# Conductor roles:
${roleTable}
# PARAMETRIC vs BAKED: layer-Z positions/heights referencing design variables are
# emitted LIVE where the cross-section provided exprs (axis-aligned line +
# unrotated parts); everything else — the t-axis footprint, waveguide trapezoids,
# oblique/rotated geometry — is BAKED numeric at the current parameter values.
# Re-export after changing anything baked.
${warnLines || '# (no cross-section warnings)'}
import ScriptEnv
ScriptEnv.Initialize("Ansoft.ElectronicsDesktop")
oDesktop.RestoreWindow()
oProject = oDesktop.NewProject()
oProject.InsertDesign("2D Extractor", "${design}", "", "")
oDesign = oProject.SetActiveDesign("${design}")
oEditor = oDesign.SetActiveEditor("3D Modeler")
${Q2D_MSG_DEF}
# Q2D solution types are "Open"/"Close" (pyaedt setup_templates index 30/31);
# Open = fields may extend beyond the drawn region. Some releases preset this
# on insert — guarded.
try:
    oDesign.SetSolutionType("Open")
except Exception as e:
    q2d_msg(1, "SetSolutionType(Open) failed (check Design Settings): " + str(e))
try:
    oEditor.SetModelUnits(["NAME:Units Parameter", "Units:=", "um", "Rescale:=", True])
except Exception as e:
    q2d_msg(1, "SetModelUnits failed: " + str(e))

def set_var(name, value):
    try:
        oDesign.SetVariableValue(name, value)
    except:
        try:
            oDesign.ChangeProperty(
                ["NAME:AllTabs", ["NAME:LocalVariableTab",
                 ["NAME:PropServers", "LocalVariables"],
                 ["NAME:NewProps", ["NAME:" + name, "PropType:=", "VariableProp",
                  "UserDef:=", True, "Value:=", value]]]])
        except Exception as e:
            q2d_msg(1, "set_var " + name + " failed: " + str(e))
${Q2D_HELPERS}
def define_material(name, eps_r, mu_r, sigma, tand):
    try:
        oProject.GetDefinitionManager().AddMaterial(
            ["NAME:" + name, "CoordinateSystemType:=", "Cartesian", ["NAME:AttachedData"],
             "permittivity:=", str(eps_r), "permeability:=", str(mu_r),
             "conductivity:=", str(sigma), "dielectric_loss_tangent:=", str(tand)])
    except Exception as e:
        q2d_msg(1, "AddMaterial " + name + " failed: " + str(e))

# ===== Design variables (DIMENSIONLESS — geometry types them via (var)um) =====
${varDecls.join('\n') || '# (no parametric variables in this cross-section)'}

# ===== Materials =====
${matDefs.join('\n') || '# (all materials are AEDT built-ins)'}

# ===== Cross-section geometry (covered sheets in the XY plane) =====
${geoBlocks.join('\n')}

# ===== Overlap resolution: carve conductors/waveguides out of the slabs =====
${subBlocks.join('\n') || '# (no overlaps — nothing to subtract)'}

# ===== Conductor assignment (pyAEDT AssignSingleSignalLine / AssignSingleReferenceGround) =====
oBnd = oDesign.GetModule("BoundarySetup")
def q2d_signal(name, objs, thk):
    try:
        oBnd.AssignSingleSignalLine(["NAME:" + name, "Objects:=", objs,
            "SolveOption:=", "SolveInside", "Thickness:=", thk])
    except Exception as e:
        q2d_msg(2, "AssignSingleSignalLine " + name + " failed: " + str(e))
def q2d_ground(name, objs, thk):
    try:
        oBnd.AssignSingleReferenceGround(["NAME:" + name, "Objects:=", objs,
            "SolveOption:=", "SolveInside", "Thickness:=", thk])
    except Exception as e:
        q2d_msg(2, "AssignSingleReferenceGround " + name + " failed: " + str(e))
${bndCalls}

# ===== Analysis setup (setup type "2DMatrix" = pyaedt Q2D "Open" template) =====
# CG PerError ${cgPerError}% / RL PerError ${rlPerError}%, passes ${minPasses}..${maxPasses}.
# (pyaedt's template ships DataType "CG" in BOTH blocks; GUI recordings use "RL"
# in the RL block — AEDT keys the block by its NAME, both are accepted.)
oAna = oDesign.GetModule("AnalysisSetup")
try:
    oAna.InsertSetup("2DMatrix",
        ["NAME:Setup1",
         "AdaptiveFreq:=", "${dec(fAdapt)}GHz",
         "SaveFields:=", True,
         "Enabled:=", True,
         ["NAME:MeshLink", "ImportMesh:=", False],
         ["NAME:CGDataBlock",
          "MaxPass:=", ${maxPasses}, "MinPass:=", ${minPasses}, "MinConvPass:=", 1,
          "PerError:=", ${cgPerError}, "PerRefine:=", 30, "DataType:=", "CG",
          "Included:=", True, "UseParamConv:=", True, "UseLossyParamConv:=", False,
          "PerErrorParamConv:=", 1, "UseLossConv:=", True],
         ["NAME:RLDataBlock",
          "MaxPass:=", ${maxPasses}, "MinPass:=", ${minPasses}, "MinConvPass:=", 1,
          "PerError:=", ${rlPerError}, "PerRefine:=", 30, "DataType:=", "RL",
          "Included:=", True, "UseParamConv:=", True, "UseLossyParamConv:=", False,
          "PerErrorParamConv:=", 1, "UseLossConv:=", True],
         "CacheSaveKind:=", "Delta",
         "ConstantDelta:=", "0s"])
except Exception as e:
    q2d_msg(2, "InsertSetup(2DMatrix) failed: " + str(e))
# SaveFields MUST be False on an INTERPOLATING sweep — AEDT rejects
# "Fields can not be saved for an interpolating sweep" and the whole
# InsertSweep fails, cascading into "No Solution found" on every report.
# The E-field probe reads fields from LastAdaptive (always saved), not the
# sweep, so the sweep needs no field data.
try:
    oAna.InsertSweep("Setup1",
        ["NAME:Sweep1", "IsEnabled:=", True, "RangeType:=", "LinearCount",
         "RangeStart:=", "${dec(fStart)}GHz", "RangeEnd:=", "${dec(fStop)}GHz", "RangeCount:=", ${fPoints},
         "Type:=", "Interpolating", "SaveFields:=", False, "SaveRadFields:=", False])
except Exception as e:
    q2d_msg(1, "InsertSweep failed (add a sweep from the GUI): " + str(e))
${autoSolve ? `
# ===== Solve =====
# The reports below read the SWEEP (Z0 / sqrt(eps_eff) vs Freq) and the
# LastAdaptive FIELD solution (E at the wg center) — both require a solved
# Setup1. This is a fast 2-D solve; comment this block out to build-only and
# Analyze from the GUI yourself (then re-run the report block).
q2d_msg(0, "Solving Setup1 (adaptive mesh + interpolating sweep) — this can take a minute...")
try:
    oDesign.Analyze("Setup1")
    q2d_msg(0, "Setup1 solved.")
except Exception as e:
    try:
        oDesign.AnalyzeSetup("Setup1")
        q2d_msg(0, "Setup1 solved.")
    except Exception as e2:
        q2d_msg(1, "Analyze failed — solve Setup1 from the GUI, then re-run the report block: " + str(e2))
` : `
# ===== Build-only (autoSolve off) =====
# The reports below need a solved Setup1 — Analyze it from the GUI first, or
# they will report "No Solution found" until the solve completes.`}
# ===== Reports =====
oRpt = oDesign.GetModule("ReportSetup")
${autoSolve ? `# oDesign.Analyze can RETURN BEFORE a distributed solve finishes (it does on
# some setups — the reports then race the solve and hit "Unable to find list
# of variables for this context", the exact error this fixes). So each report
# is RETRIED while the solution populates — up to ~3 min — then it gives up
# softly (view the matrix from Results -> Solution Data -> Matrix instead).
try:
    import System
    _have_sleep = True
except:
    _have_sleep = False
def _mk_report(fn, label):
    last = ""
    for _attempt in range(36):
        try:
            fn()
            q2d_msg(0, label + " created.")
            return True
        except Exception as e:
            last = str(e)
            if not _have_sleep:
                break
            try:
                System.Threading.Thread.Sleep(5000)  # wait for the solve to populate
            except:
                break
    q2d_msg(1, label + " not created (solution not ready yet). Once Setup1 finishes solving, re-run this report block, or read Z0/C from Results -> Solution Data -> Matrix: " + last)
    return False
` : `def _mk_report(fn, label):
    # autoSolve off: Analyze Setup1 from the GUI first, then re-run this block.
    try:
        fn(); q2d_msg(0, label + " created."); return True
    except Exception as e:
        q2d_msg(1, label + " failed (is Setup1 solved?): " + str(e)); return False
`}def _rep_z0():
    oRpt.CreateReport("Z0 vs Freq", "Matrix", "Rectangular Plot",
        "Setup1 : Sweep1", ["Context:=", "Original"], ["Freq:=", ["All"]],
        ["X Component:=", "Freq",
         "Y Component:=", ["re(Z0(${sig},${sig}))", "im(Z0(${sig},${sig}))"]])
_mk_report(_rep_z0, "Z0 report")
# UNITS (critical — see the tl_DeltaL_m 1e12 lesson in CLAUDE.md): in a report
# expression Gamma(${sig},${sig}) resolves in SI — im(Gamma) = beta in rad/m —
# and the reserved Freq resolves in Hz. sqrt(eps_eff) = beta*c/omega =
# im(Gamma)*299792458/(2*pi*Freq), a clean DIMENSIONLESS number. If a future
# AEDT changes either SI resolution, this trace scales by a power of ten —
# check this expression first when sqrt(eps_eff) looks absurd.
def _rep_eps():
    oRpt.CreateReport("sqrt(eps_eff) vs Freq", "Matrix", "Rectangular Plot",
        "Setup1 : Sweep1", ["Context:=", "Original"], ["Freq:=", ["All"]],
        ["X Component:=", "Freq",
         "Y Component:=", ["im(Gamma(${sig},${sig}))*299792458/(2*pi*Freq)"]])
_mk_report(_rep_eps, "sqrt(eps_eff) report")

${fieldBlock}

q2d_msg(0, ${autoSolve ? '"Q2D cross-section solved — see the Z0 / sqrt(eps_eff) reports (and the E-field report if a waveguide was crossed)."' : '"Q2D cross-section built — Analyze Setup1, then re-run the report block."'})
`;
  return ascii(code);
}
