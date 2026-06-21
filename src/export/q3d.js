// Q3D Extractor capacitance for the meander Z0 route.
//
// For a MEANDERED (non-uniform) line there's no uniform cross-section, so the
// per-length capacitance C can't come from Q2D. But the FULL 3-D folded
// geometry solves in Q3D Extractor: read C between the two line conductors,
// divide by the line's PHYSICAL length → C (F/m), then Z0 = γ/(jωC) (γ from the
// 2-line method). C is electrostatic ⇒ kinetic-inductance-correct.
//
// PARAMETRIC: the scene parameters are declared as Q3D design variables, and the
// conductor rectangles + dielectric stack are emitted as EXPRESSIONS referencing
// them (size from the component w/h, inter-strip gap from the repeat offset,
// stack Z from the layer thickness vars), plus q3d_cond_thk (conductor
// thickness) and q3d_line_len_um (length for C/length). So you can sweep
// width / gap / thickness / dielectric directly in Q3D and watch C change.
// Non-rectangular or rotated conductors fall back to baked numeric geometry.
//
// Modeling: conductors are THIN CONDUCTORS (a covered sheet swept up by the
// thickness); each conductor object gets its own SIGNAL NET; a capacitance setup
// + frequency sweep; the design is SOLVED, then a raw C-matrix report + a
// per-length (differential) C report are created (matrix quantities don't exist
// pre-solve). The line capacitance is the DIFFERENTIAL capacitance
// ((C11+C22)/2 − C12)/2 — the port drives the strips differentially — NOT |C12|.
//
// Two emitters: generateQ3DCapacitance (standalone, own project) and
// generateQ3DCombinedBlock (appended to the 2-line HFSS script, same project).
// Only the SELECTED line conductor(s) are emitted; feeds excluded (they'd short
// the nets electrostatically). The Q3D-specific COM (nets/setup/sweep/reports)
// is NOT validated in this repo — wrapped in try/except; expect release tweaks.
import { normalizeScene, migrateStackCoplanarGroups } from '../scene/schema.js';
import { resolveParams, evalExpr } from '../scene/params.js';
import { solveLayout } from '../scene/solver.js';
import { expandTransforms } from '../scene/transforms.js';
import { shapeInstanceToRing } from '../geometry/rings.js';

const ascii = (s) => String(s ?? '').replace(/[^\x00-\x7F]/g, '?');
const num = (v) => (Number.isFinite(v) ? (Math.round(v * 1e6) / 1e6) : 0);
// Plain decimal (no exponent, no float noise) for literals/values the Q3D expr
// engine reads. Rounds to 1e-9 (sub-femtometre) and trims trailing zeros.
const dec = (x) => { if (!Number.isFinite(x)) return '0'; let s = (Math.round(x * 1e9) / 1e9).toFixed(9); if (s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\.$/, ''); return s || '0'; };
const unitFor = (u) => (u === 'µm' ? 'um' : (u === 'deg' ? 'deg' : ''));

// Group-aware Z walk: numeric (zBottom/zTop) AND parametric (zBottomExpr/
// zTopExpr, in terms of the layer thickness vars h_si/h_wg/…). Mirrors
// hfss-native's layerZ.
function computeLayerZ(stack, pv) {
  const layers = migrateStackCoplanarGroups(stack || []);
  const thkNum = (l) => { const v = evalExpr(l.thickness, pv); return Number.isFinite(v) ? Math.abs(v) : 0; };
  const thkExpr = (l) => (l.thickness ? `(${l.thickness})` : '0');
  const zBottom = {}, zTop = {}, zBottomExpr = {}, zTopExpr = {};
  let datum = layers.findIndex((l) => l.role !== 'substrate' || l.coplanarGroup);
  if (datum < 0) datum = layers.length;
  // Substrates below the datum, stacked downward (negative Z).
  let zc = 0, zcE = '0';
  for (let i = datum - 1; i >= 0; i--) {
    const l = layers[i], t = thkNum(l);
    zTop[l.id] = zc; zTopExpr[l.id] = zcE;
    zBottom[l.id] = zc - t; zBottomExpr[l.id] = `${zcE} - ${thkExpr(l)}`;
    zc -= t; zcE = zBottomExpr[l.id];
  }
  // From the datum up; coplanar groups share zBottom; advance past a group by
  // its cladding top (thickest cladding, else thickest member).
  zc = 0; zcE = '0';
  let i = datum;
  while (i < layers.length) {
    const l = layers[i];
    if (l.coplanarGroup) {
      const gid = l.coplanarGroup, members = [];
      while (i < layers.length && layers[i].coplanarGroup === gid) { members.push(layers[i]); i++; }
      for (const m of members) { zBottom[m.id] = zc; zBottomExpr[m.id] = zcE; zTop[m.id] = zc + thkNum(m); zTopExpr[m.id] = `${zcE} + ${thkExpr(m)}`; }
      const clad = members.filter((m) => m.role === 'cladding');
      const advMembers = clad.length ? clad : members;
      const adv = advMembers.reduce((mx, m) => Math.max(mx, thkNum(m)), 0);
      const advL = advMembers.slice().sort((p, q) => thkNum(q) - thkNum(p))[0];
      zc += adv; zcE = `${zcE} + ${thkExpr(advL)}`;
    } else {
      zBottom[l.id] = zc; zBottomExpr[l.id] = zcE; zTop[l.id] = zc + thkNum(l); zTopExpr[l.id] = `${zcE} + ${thkExpr(l)}`;
      zc += thkNum(l); zcE = zTopExpr[l.id]; i++;
    }
  }
  return { zBottom, zTop, zBottomExpr, zTopExpr };
}

// Per-instance PARAMETRIC translation offsets {dx,dy} (expression strings or
// null) for a repeat/displace chain — so the inter-strip gap stays parametric.
function parametricOffsets(transforms, pv) {
  const mul = (k, e) => { e = String(e ?? '').trim(); if (!e || e === '0' || k === 0) return null; return k === 1 ? `(${e})` : `${k}*(${e})`; };
  const add = (a, b) => (!a ? b : (!b ? a : `${a} + ${b}`));
  let offs = [{ dx: null, dy: null }];
  let hasRot = false;
  for (const t of (transforms || [])) {
    if (t.enabled === false) continue;
    if (t.kind === 'displace') {
      const dx = mul(1, t.dx), dy = mul(1, t.dy);
      offs = offs.map((o) => ({ dx: add(o.dx, dx), dy: add(o.dy, dy) }));
    } else if (t.kind === 'repeat') {
      const n = Math.max(0, Math.round(evalExpr(t.n, pv) || 0));
      const inc = t.includeOriginal !== false;
      const out = [];
      for (const o of offs) for (let k = (inc ? 0 : 1); k <= n; k++) out.push({ dx: add(o.dx, mul(k, t.dx)), dy: add(o.dy, mul(k, t.dy)) });
      offs = out;
    } else if (t.kind === 'rotate') {
      hasRot = true;
    }
  }
  return { offs, hasRot };
}

// Shared geometry/material body. boxFn/polyFn/sweepFn are Python helper names.
// opts: { conductorIds, thicknessUm, lengthUm }.
function buildQ3DBody(scene, paramValues, opts, boxFn, polyFn, sweepFn) {
  const src = normalizeScene(scene);
  const pv = paramValues || resolveParams(src.params || {}).values;
  const solved = solveLayout(src.components, src.snaps, pv);
  const stack = src.stack || [];
  const { zBottom, zTop, zBottomExpr } = computeLayerZ(stack, pv);

  const wantIds = new Set(opts.conductorIds || []);
  const condComps = solved.filter((c) => wantIds.has(c.id) && c.kind !== 'boolean');
  if (condComps.length === 0) throw new Error('Select at least one line conductor for the Q3D capacitance run.');

  const condLayer = stack.find((l) => l.role === 'conductor');
  const condMat = (condLayer && condLayer.material) || 'gold';
  const hCond = condLayer ? (evalExpr(condLayer.thickness, pv) || 0) : 0;
  let effThk = Number.isFinite(opts.thicknessUm) && opts.thicknessUm > 0 ? opts.thicknessUm : (hCond > 0 ? hCond : 0.1);
  effThk = num(effThk);
  const condZBotExpr = condLayer ? `(${zBottomExpr[condLayer.id]})` : '0';

  // ---- Design variables: scene params + thickness + line length + bases ----
  const varDecls = [];
  for (const name of Object.keys(src.params || {})) {
    if (!/^[A-Za-z_]\w*$/.test(name)) continue;
    const v = pv[name];
    if (!Number.isFinite(v)) continue;
    varDecls.push(`set_var("${name}", "${dec(v)}${unitFor(src.params[name].unit)}")`);
  }
  varDecls.push(`set_var("q3d_cond_thk", "${effThk}um")  # thin-conductor thickness`);

  // ---- Conductors (parametric rects; numeric fallback otherwise) ----
  const condObjs = [];
  const condBlocks = [];
  let bb = { xMin: Infinity, xMax: -Infinity, yMin: Infinity, yMax: -Infinity };
  let lineLengthUm = 0;

  const polySheet = (name, pts) => {
    const ptStr = [...pts, pts[0]].map(([x, y]) =>
      `["NAME:PLPoint", "X:=", "${x}", "Y:=", "${y}", "Z:=", "${condZBotExpr}um"]`
    ).join(',\n          ');
    const segs = pts.map((_, j) => `["NAME:PLSegment", "SegmentType:=", "Line", "StartIndex:=", ${j}, "NoOfPoints:=", 2]`).join(',\n          ');
    return `${polyFn}(
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
     "Name:=", "${name}", "Flags:=", "", "Color:=", "(218 165 32)",
     "Transparency:=", 0.0, "PartCoordinateSystem:=", "Global",
     "MaterialValue:=", "\\"${ascii(condMat)}\\"", "SolveInside:=", False],
    "${name}")
${sweepFn}("${name}", "q3d_cond_thk")  # thin conductor: sweep up by thickness`;
  };

  for (const c of condComps) {
    const cid = c.id.replace(/[^A-Za-z0-9_]/g, '_');
    const insts = expandTransforms([c], pv);
    for (const inst of insts) {
      const w = Math.abs(inst.w), h = Math.abs(inst.h);
      if (Number.isFinite(w) && w > 0) lineLengthUm = Math.max(lineLengthUm, w, h);
    }
    const ring0 = shapeInstanceToRing(insts[0]);
    if (ring0) for (const [x, y] of ring0) { bb.xMin = Math.min(bb.xMin, x); bb.xMax = Math.max(bb.xMax, x); bb.yMin = Math.min(bb.yMin, y); bb.yMax = Math.max(bb.yMax, y); }
    const { offs, hasRot } = parametricOffsets(c.transforms, pv);
    const rot = evalExpr(c.rotation ?? '0', pv) || 0;
    const paramRect = c.kind === 'rect' && !hasRot && Math.abs(rot) < 1e-9
      && Number.isFinite(evalExpr(c.w, pv)) && Number.isFinite(evalExpr(c.h, pv));

    if (paramRect) {
      // base center vars + parametric corners from component w/h and per-
      // instance offset (so width AND inter-strip gap stay parametric).
      varDecls.push(`set_var("${cid}_q3cx", "${dec(c.cx)}um")`, `set_var("${cid}_q3cy", "${dec(c.cy)}um")`);
      const wE = `(${c.w})`, hE = `(${c.h})`;
      offs.forEach((o, k) => {
        const cx = o.dx ? `${cid}_q3cx + ${o.dx}` : `${cid}_q3cx`;
        const cy = o.dy ? `${cid}_q3cy + ${o.dy}` : `${cid}_q3cy`;
        const xm = `(${cx}) - ${wE}/2`, xp = `(${cx}) + ${wE}/2`;
        const ym = `(${cy}) - ${hE}/2`, yp = `(${cy}) + ${hE}/2`;
        const name = `${cid}_i${k}`;
        condObjs.push(name);
        condBlocks.push(polySheet(name, [[xm, ym], [xp, ym], [xp, yp], [xm, yp]]));
        // numeric bbox for the dielectric footprint
        const ni = insts[k] || insts[0];
        if (ni) { const r = shapeInstanceToRing(ni); if (r) for (const [x, y] of r) { bb.xMin = Math.min(bb.xMin, x); bb.xMax = Math.max(bb.xMax, x); bb.yMin = Math.min(bb.yMin, y); bb.yMax = Math.max(bb.yMax, y); } }
      });
    } else {
      // numeric fallback (rotated / non-rect): bake the ring per instance.
      insts.forEach((inst, k) => {
        if (!Number.isFinite(inst.w) || inst.w <= 0) return;
        const ring = shapeInstanceToRing(inst);
        if (!ring || ring.length < 3) return;
        for (const [x, y] of ring) { bb.xMin = Math.min(bb.xMin, x); bb.xMax = Math.max(bb.xMax, x); bb.yMin = Math.min(bb.yMin, y); bb.yMax = Math.max(bb.yMax, y); }
        const name = `${cid}_i${k}`;
        condObjs.push(name);
        condBlocks.push(polySheet(name, ring.map(([x, y]) => [`${num(x)}um`, `${num(y)}um`])));
      });
    }
  }
  if (!Number.isFinite(bb.xMin)) throw new Error('Selected conductors have no resolvable geometry.');

  const lengthUm = (Number.isFinite(opts.lengthUm) && opts.lengthUm > 0) ? opts.lengthUm : num(lineLengthUm);
  varDecls.push(`set_var("q3d_line_len_um", "${dec(lengthUm)}")  # line PHYSICAL length (um) for C/length -- VERIFY (esp. meander)`);

  // ---- Dielectric stack: parametric Z, numeric footprint (generous pad) ----
  const spanX = bb.xMax - bb.xMin, spanY = bb.yMax - bb.yMin;
  const pad = Math.max(50, spanX, spanY);
  const xPos = num(bb.xMin - pad), yPos = num(bb.yMin - pad);
  const xSize = num(spanX + 2 * pad), ySize = num(spanY + 2 * pad);
  const dielBlocks = [];
  for (const l of stack) {
    if (l.role === 'conductor') continue;
    if (zBottom[l.id] == null) continue;
    if (num(zTop[l.id] - zBottom[l.id]) <= 0) continue;
    const nm = `diel_${l.id}`.replace(/[^A-Za-z0-9_]/g, '_');
    dielBlocks.push(`${boxFn}(
    ["NAME:BoxParameters",
     "XPosition:=", "${xPos}um", "YPosition:=", "${yPos}um", "ZPosition:=", "(${zBottomExpr[l.id]})um",
     "XSize:=", "${xSize}um", "YSize:=", "${ySize}um", "ZSize:=", "(${l.thickness || '0'})um"],
    ["NAME:Attributes",
     "Name:=", "${nm}", "Flags:=", "", "Color:=", "(160 160 200)",
     "Transparency:=", 0.7, "PartCoordinateSystem:=", "Global",
     "MaterialValue:=", "\\"${ascii(l.material || 'vacuum')}\\"", "SolveInside:=", True],
    "${nm}")`);
  }

  const STD = new Set(['vacuum', 'air', 'copper', 'gold', 'aluminum', 'silicon', 'silicon_dioxide', 'silicon_nitride', 'FR4_epoxy', 'polyimide', 'Pec', 'Teflon_based']);
  const CUSTOM = { lithium_tantalate: [41.4, 1, 0, 0.001], lithium_niobate: [28.0, 1, 0, 0.001] };
  const usedMats = new Set([condMat, ...stack.filter((l) => l.role !== 'conductor').map((l) => l.material)]);
  const matDefs = [...usedMats].filter((m) => m && !STD.has(m)).map((m) => {
    const p = CUSTOM[m] || [4.0, 1, 0, 0.001];
    return `define_material("${ascii(m)}", ${p[0]}, ${p[1]}, ${p[2]}, ${p[3]})`;
  }).join('\n');

  const fAdaptGHz = (() => { const f = evalExpr(src.simSetup?.fnominal ?? '4', pv); return Number.isFinite(f) && f > 0 ? f : 4; })();
  return { varDecls, matDefs, dielBlocks, condBlocks, condObjs, fAdaptGHz, effThk, lengthUm: num(lengthUm) };
}

const CAP_SETUP = (fGHz) => `["NAME:Setup1",
         "AdaptiveFreq:=", "${fGHz}GHz", "SaveFields:=", False, "Enabled:=", True,
         ["NAME:Cap", "MaxPass:=", 10, "MinPass:=", 1, "MinConvPass:=", 1,
          "PerError:=", 1, "PerRefine:=", 30, "AutoIncreaseSolutionOrder:=", True,
          "SolutionOrder:=", "High", "Solver Type:=", "Iterative"]]`;

// Nets + setup + frequency sweep + SOLVE + C reports (shared, top-level). Q3D
// matrix quantities C(netA,netB) DON'T EXIST until solved → Analyze FIRST, then
// create the reports (else "'C' is not a function name").
function q3dNetsSetupReports({ condObjs, fAdaptGHz, sweep }) {
  const nets = condObjs.map((o) => `q3d_signal_net("net_${o}", "${o}")`).join('\n');
  const s = sweep || {};
  const startG = Number.isFinite(s.startGHz) ? s.startGHz : 1;
  const stopG = Number.isFinite(s.stopGHz) ? s.stopGHz : 40;
  const pts = (Number.isFinite(s.points) && s.points >= 1) ? Math.round(s.points) : 201;
  const a = condObjs.length >= 2 ? `net_${condObjs[0]}` : null;
  const b = condObjs.length >= 2 ? `net_${condObjs[1]}` : null;

  let extract = '# (need >=2 conductor nets for a conductor-to-conductor C/length)';
  if (a && b) {
    extract = `# Solve the (fast) electrostatic capacitance so the C matrix quantities exist —
# they DON'T pre-solve, which is why the reports below come AFTER Analyze.
# Comment this out to mesh/solve manually first; then make the reports from
# Results -> Create Report -> Matrix.
try:
    oDesign.Analyze("Setup1")
except Exception as e:
    oDesktop.AddMessage("", "", 2, "Q3D Analyze failed (solve manually, then report from Results -> Matrix): " + str(e))
# Raw Maxwell C-matrix report. Off-diagonal C(netA,netB) is NEGATIVE by Maxwell
# convention; |C(netA,netB)| is the mutual capacitance.
try:
    oDesign.GetModule("ReportSetup").CreateReport("Capacitance", "Matrix", "Data Table",
        "Setup1 : LastAdaptive", ["Context:=", "Original"], [],
        ["X Component:=", "Freq", "Y Component:=", ["C(${a},${b})", "C(${a},${a})", "C(${b},${b})"]], [])
except Exception as e:
    oDesktop.AddMessage("", "", 1, "Capacitance report skipped (create from Results -> Matrix): " + str(e))
# Per-length DIFFERENTIAL line capacitance (the port drives the strips
# differentially): C_line = ((C11+C22)/2 - C12)/2, NOT |C12|. q3d_line_len_um is
# the line physical length (um) — VERIFY for a meander.
try:
    oDesign.GetModule("OutputVariable").CreateOutputVariable(
        "C_per_m", "((C(${a},${a})+C(${b},${b}))/2-C(${a},${b}))/2/(q3d_line_len_um*1e-6)", "Setup1 : LastAdaptive", "Matrix", [])
    oDesign.GetModule("ReportSetup").CreateReport("C per length", "Matrix", "Data Table",
        "Setup1 : LastAdaptive", ["Context:=", "Original"], [],
        ["X Component:=", "Freq", "Y Component:=", ["C_per_m"]], [])
except Exception as e:
    oDesktop.AddMessage("", "", 1, "C_per_m report skipped: " + str(e))
oDesktop.AddMessage("", "", 0, "C per length = ((C11+C22)/2 - C12)/2 / (q3d_line_len_um*1e-6). Paste C_per_m into the 2-line wizard.")`;
  }

  return `# ===== Nets (one signal net per conductor object) =====
oBnd = oDesign.GetModule("BoundarySetup")
def q3d_signal_net(net, obj):
    try:
        oBnd.AssignSignalNet(["NAME:" + net, "Objects:=", [obj]])
    except Exception as e:
        oDesktop.AddMessage("", "", 1, "AssignSignalNet " + net + " failed: " + str(e))
${nets}

# ===== Capacitance setup + frequency sweep (same band as the 2-line wizard) =====
oAna = oDesign.GetModule("AnalysisSetup")
try:
    oAna.InsertSetup("Matrix", ${CAP_SETUP(fAdaptGHz)})
except Exception as e:
    oDesktop.AddMessage("", "", 2, "InsertSetup(Matrix) failed: " + str(e))
try:
    oAna.InsertSweep("Setup1",
        ["NAME:Sweep1", "IsEnabled:=", True, "RangeType:=", "LinearCount",
         "RangeStart:=", "${startG}GHz", "RangeEnd:=", "${stopG}GHz", "RangeCount:=", ${pts},
         "Type:=", "Interpolating", "SaveFields:=", False])
except Exception as e:
    oDesktop.AddMessage("", "", 1, "InsertSweep failed (add a sweep from the GUI): " + str(e))

# ===== Solve + capacitance-per-length reports (post-solve!) =====
${extract}`;
}

const Q3D_HELPERS = (boxFn, polyFn, sweepFn, delFn) => `def ${delFn}(name):
    try:
        oEditor.Delete(["NAME:Selections", "Selections:=", name])
    except:
        pass
def ${boxFn}(bp, attr, name):
    ${delFn}(name)
    try:
        oEditor.CreateBox(bp, attr)
    except Exception as e:
        oDesktop.AddMessage("", "", 1, "CreateBox " + name + " failed: " + str(e))
def ${polyFn}(pp, attr, name):
    ${delFn}(name)
    try:
        oEditor.CreatePolyline(pp, attr)
    except Exception as e:
        oDesktop.AddMessage("", "", 1, "CreatePolyline " + name + " failed: " + str(e))
def ${sweepFn}(name, dz):
    try:
        oEditor.SweepAlongVector(
            ["NAME:Selections", "Selections:=", name, "NewPartsModelFlag:=", "Model"],
            ["NAME:VectorSweepParameters", "DraftAngle:=", "0deg", "DraftType:=", "Round",
             "CheckFaceFaceIntersection:=", False,
             "SweepVectorX:=", "0um", "SweepVectorY:=", "0um", "SweepVectorZ:=", dz])
    except Exception as e:
        oDesktop.AddMessage("", "", 1, "Sweep " + name + " failed: " + str(e))`;

// Standalone Q3D capacitance script (own project + design).
export function generateQ3DCapacitance(scene, paramValues, opts = {}) {
  const body = buildQ3DBody(scene, paramValues, opts, 'safe_create_box', 'safe_create_polyline', 'safe_sweep_z');
  const design = (opts.designName || 'q3d_cap').replace(/[^A-Za-z0-9_]/g, '_');
  const sweep = { startGHz: opts.freqStartGHz, stopGHz: opts.freqStopGHz, points: opts.freqPoints };
  const code = `# -*- coding: utf-8 -*-
# Auto-generated PARAMETRIC Q3D Extractor capacitance script (AEDT: Tools -> Run Script).
# Per-length capacitance C of a MEANDERED line for Z0 = gamma/(j*w*C). Selected
# line conductor(s) as THIN CONDUCTORS (thickness var q3d_cond_thk = ${body.effThk}um):
# ${body.condObjs.length} object(s). Feeds excluded. Geometry references design variables
# (sweep width/gap/thickness/dielectric in Q3D and re-Analyze).
# CAVEAT: Q3D net/setup/sweep/report COM is not validated here — fix in the GUI
# if a call errors (the geometry is correct).
import ScriptEnv
ScriptEnv.Initialize("Ansoft.ElectronicsDesktop")
oDesktop.RestoreWindow()
oProject = oDesktop.NewProject()
oProject.InsertDesign("Q3D Extractor", "${design}", "", "")
oDesign = oProject.SetActiveDesign("${design}")
oEditor = oDesign.SetActiveEditor("3D Modeler")
try:
    oEditor.SetModelUnits(["NAME:Units Parameter", "Units:=", "um", "Rescale:=", True])
except Exception as e:
    oDesktop.AddMessage("", "", 1, "SetModelUnits failed: " + str(e))

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
            oDesktop.AddMessage("", "", 1, "set_var " + name + " failed: " + str(e))
${Q3D_HELPERS('safe_create_box', 'safe_create_polyline', 'safe_sweep_z', '_del')}
def define_material(name, eps_r, mu_r, sigma, tand):
    try:
        oProject.GetDefinitionManager().AddMaterial(
            ["NAME:" + name, "CoordinateSystemType:=", "Cartesian", ["NAME:AttachedData"],
             "permittivity:=", str(eps_r), "permeability:=", str(mu_r),
             "conductivity:=", str(sigma), "dielectric_loss_tangent:=", str(tand)])
    except Exception as e:
        oDesktop.AddMessage("", "", 1, "AddMaterial " + name + " failed: " + str(e))

# ===== Design variables (edit + re-Analyze to sweep) =====
${body.varDecls.join('\n')}

# ===== Materials =====
${body.matDefs || '# (all materials are AEDT built-ins)'}

# ===== Dielectric stack (parametric Z) =====
${body.dielBlocks.join('\n') || '# (no dielectric layers)'}

# ===== Line conductor(s) — thin conductors (parametric) =====
${body.condBlocks.join('\n')}

${q3dNetsSetupReports({ condObjs: body.condObjs, fAdaptGHz: body.fAdaptGHz, sweep })}

oProject.Save()
oDesktop.AddMessage("", "", 0, "Parametric Q3D capacitance built + solved. Read 'C per length' (verify q3d_line_len_um) -> paste C (F/m) into the 2-line wizard.")
`;
  return ascii(code);
}

// A Python block adding a parametric Q3D design to the EXISTING 2-line project.
export function generateQ3DCombinedBlock(scene, paramValues, opts = {}) {
  const body = buildQ3DBody(scene, paramValues, opts, 'q3d_box', 'q3d_poly', 'q3d_sweep');
  const design = (opts.designName || 'q3d_cap').replace(/[^A-Za-z0-9_]/g, '_');
  const hfss = (opts.hfssDesignName || 'Layout').replace(/[^A-Za-z0-9_]/g, '_');
  const cVar = (opts.cVarName || 'tl_C_F_per_m');
  const sweep = { startGHz: opts.freqStartGHz, stopGHz: opts.freqStopGHz, points: opts.freqPoints };
  const code = `
# ===== Q3D capacitance design (same project, PARAMETRIC) — for Z0 = gamma/(j*w*C) =====
# Adds a Q3D Extractor design solving per-length C of the SINGLE line (only the
# selected conductor(s) as thin conductors; feeds excluded). After it solves,
# read 'C per length' and set the HFSS variable "${cVar}" on design "${hfss}".
# Reuses set_var + materials from the HFSS script above.
try:
    oProject.InsertDesign("Q3D Extractor", "${design}", "", "")
    oDesign = oProject.SetActiveDesign("${design}")
    oEditor = oDesign.SetActiveEditor("3D Modeler")
    oEditor.SetModelUnits(["NAME:Units Parameter", "Units:=", "um", "Rescale:=", True])
except Exception as e:
    oDesktop.AddMessage("", "", 2, "Q3D design create failed: " + str(e))

${Q3D_HELPERS('q3d_box', 'q3d_poly', 'q3d_sweep', '_q3d_del')}

# ===== Design variables (on the Q3D design) =====
${body.varDecls.join('\n')}

# ===== Dielectric stack (parametric Z) =====
${body.dielBlocks.join('\n')}
# ===== Line conductor(s) — thin conductors (parametric) =====
${body.condBlocks.join('\n')}

${q3dNetsSetupReports({ condObjs: body.condObjs, fAdaptGHz: body.fAdaptGHz, sweep })}

oProject.Save()
oDesktop.AddMessage("", "", 0, "Q3D design '${design}' built + solved. Read 'C per length' (verify q3d_line_len_um), set ${cVar} on design '${hfss}'.")

# --- Optional AUTO-TRANSFER (uncomment after verifying the matrix read in your
#     AEDT release; a wrong read would silently corrupt Z0, so it's off by default) ---
# try:
#     oDesign = oProject.SetActiveDesign("${design}")
#     # ... read C_per_m from the solution, then: ...
#     oDesign = oProject.SetActiveDesign("${hfss}")
#     set_var("${cVar}", str(C_per_m_value))
# except Exception as e:
#     oDesktop.AddMessage("", "", 2, "Auto-transfer failed: " + str(e))
oDesign = oProject.SetActiveDesign("${hfss}")
`;
  return ascii(code);
}
