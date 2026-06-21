// Q3D Extractor capacitance for the meander Z0 route.
//
// For a MEANDERED (non-uniform) line there's no uniform cross-section, so the
// per-length capacitance C can't come from Q2D. But the FULL 3-D folded
// geometry solves in Q3D Extractor: read C between the two line conductors,
// divide by the line's PHYSICAL length → C (F/m), then Z0 = γ/(jωC) (γ from the
// 2-line method). C is electrostatic ⇒ kinetic-inductance-correct.
//
// Modeling:
//   * Conductors are THIN CONDUCTORS — a covered sheet swept up by the
//     conductor thickness (h_cond, or a wizard-supplied value when h_cond=0).
//   * Each conductor object is assigned its own SIGNAL NET.
//   * A capacitance setup + a frequency SWEEP (same band as the 2-line wizard).
//   * A "C per length" report (|C(netA,netB)| / physical length) + full C matrix.
//
// Two emitters: generateQ3DCapacitance (standalone script, own project) and
// generateQ3DCombinedBlock (a block appended to the 2-line HFSS script so one
// file builds both designs). Only the SELECTED line conductor(s) are emitted —
// feeds excluded (they'd short the nets electrostatically). The Q3D-specific COM
// (nets / setup / sweep / reports / export) is NOT validated in this repo —
// wrapped in try/except; expect per-AEDT-release tweaks. Geometry uses the
// proven modeler calls.
import { normalizeScene, migrateStackCoplanarGroups } from '../scene/schema.js';
import { resolveParams, evalExpr } from '../scene/params.js';
import { solveLayout } from '../scene/solver.js';
import { expandTransforms } from '../scene/transforms.js';
import { shapeInstanceToRing } from '../geometry/rings.js';

const ascii = (s) => String(s ?? '').replace(/[^\x00-\x7F]/g, '?');
const num = (v) => (Number.isFinite(v) ? (Math.round(v * 1e6) / 1e6) : 0);
// Plain decimal (no exponent) for literals the Q3D expr engine reads.
const dec = (x) => { if (!Number.isFinite(x)) return '0'; let s = x.toFixed(18); if (s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\.$/, ''); return s || '0'; };

function computeLayerZ(stack, pv) {
  const layers = migrateStackCoplanarGroups(stack || []);
  const thk = (l) => { const v = evalExpr(l.thickness, pv); return Number.isFinite(v) ? Math.abs(v) : 0; };
  const zBottom = {}, zTop = {};
  let datum = layers.findIndex((l) => l.role !== 'substrate' || l.coplanarGroup);
  if (datum < 0) datum = layers.length;
  let zc = 0;
  for (let i = datum - 1; i >= 0; i--) { const t = thk(layers[i]); zTop[layers[i].id] = zc; zBottom[layers[i].id] = zc - t; zc -= t; }
  zc = 0;
  let i = datum;
  while (i < layers.length) {
    const l = layers[i];
    if (l.coplanarGroup) {
      const gid = l.coplanarGroup; const members = [];
      while (i < layers.length && layers[i].coplanarGroup === gid) { members.push(layers[i]); i++; }
      for (const m of members) { zBottom[m.id] = zc; zTop[m.id] = zc + thk(m); }
      const clad = members.filter((m) => m.role === 'cladding');
      zc += (clad.length ? clad : members).reduce((mx, m) => Math.max(mx, thk(m)), 0);
    } else {
      zBottom[l.id] = zc; zTop[l.id] = zc + thk(l); zc += thk(l); i++;
    }
  }
  return { zBottom, zTop };
}

// Shared geometry/material body. boxFn/polyFn/sweepFn are Python helper names the
// emitted blocks call. opts: { conductorIds, thicknessUm }.
function buildQ3DBody(scene, paramValues, opts, boxFn, polyFn, sweepFn) {
  const src = normalizeScene(scene);
  const pv = paramValues || resolveParams(src.params || {}).values;
  const solved = solveLayout(src.components, src.snaps, pv);
  const stack = src.stack || [];
  const { zBottom, zTop } = computeLayerZ(stack, pv);

  const wantIds = new Set(opts.conductorIds || []);
  const condComps = solved.filter((c) => wantIds.has(c.id) && c.kind !== 'boolean');
  if (condComps.length === 0) throw new Error('Select at least one line conductor for the Q3D capacitance run.');

  const condLayer = stack.find((l) => l.role === 'conductor');
  const condMat = (condLayer && condLayer.material) || 'gold';
  const hCond = condLayer ? (evalExpr(condLayer.thickness, pv) || 0) : 0;
  // Thin-conductor thickness: explicit opt → else h_cond → else fallback.
  let effThk = Number.isFinite(opts.thicknessUm) && opts.thicknessUm > 0 ? opts.thicknessUm
    : (hCond > 0 ? hCond : 0.1);
  effThk = num(effThk);
  // Sit the swept conductor on the conductor layer's bottom.
  const condZBot = num(condLayer ? (zBottom[condLayer.id] ?? 0) : 0);

  const condObjs = [];
  const condBlocks = [];
  let bb = { xMin: Infinity, xMax: -Infinity, yMin: Infinity, yMax: -Infinity };
  let lineLengthUm = 0;
  for (const c of condComps) {
    const insts = expandTransforms([c], pv);
    insts.forEach((inst, k) => {
      if (!Number.isFinite(inst.w) || !Number.isFinite(inst.h) || inst.w <= 0 || inst.h <= 0) return;
      lineLengthUm = Math.max(lineLengthUm, Math.abs(inst.w), Math.abs(inst.h));
      const ring = shapeInstanceToRing(inst);
      if (!ring || ring.length < 3) return;
      for (const [x, y] of ring) { bb.xMin = Math.min(bb.xMin, x); bb.xMax = Math.max(bb.xMax, x); bb.yMin = Math.min(bb.yMin, y); bb.yMax = Math.max(bb.yMax, y); }
      const name = `${c.id}_i${k}`.replace(/[^A-Za-z0-9_]/g, '_');
      condObjs.push(name);
      const pts = [...ring, ring[0]].map(([x, y]) =>
        `["NAME:PLPoint", "X:=", "${num(x)}um", "Y:=", "${num(y)}um", "Z:=", "${condZBot}um"]`
      ).join(',\n          ');
      const segs = ring.map((_, j) =>
        `["NAME:PLSegment", "SegmentType:=", "Line", "StartIndex:=", ${j}, "NoOfPoints:=", 2]`
      ).join(',\n          ');
      // Covered sheet ...
      condBlocks.push(`${polyFn}(
    ["NAME:PolylineParameters",
     "IsPolylineCovered:=", True, "IsPolylineClosed:=", True,
     ["NAME:PolylinePoints",
      ${pts}],
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
${sweepFn}("${name}", "${effThk}um")  # thin conductor: sweep sheet up by thickness`);
    });
  }
  if (!Number.isFinite(bb.xMin)) throw new Error('Selected conductors have no resolvable geometry.');

  const spanX = bb.xMax - bb.xMin, spanY = bb.yMax - bb.yMin;
  const pad = Math.max(50, spanX, spanY);
  const xPos = num(bb.xMin - pad), yPos = num(bb.yMin - pad);
  const xSize = num(spanX + 2 * pad), ySize = num(spanY + 2 * pad);

  const dielBlocks = [];
  for (const l of stack) {
    if (l.role === 'conductor') continue;
    const zb = zBottom[l.id], zt = zTop[l.id];
    if (zb == null || zt == null) continue;
    const h = num(zt - zb);
    if (h <= 0) continue;
    const nm = `diel_${l.id}`.replace(/[^A-Za-z0-9_]/g, '_');
    dielBlocks.push(`${boxFn}(
    ["NAME:BoxParameters",
     "XPosition:=", "${xPos}um", "YPosition:=", "${yPos}um", "ZPosition:=", "${num(zb)}um",
     "XSize:=", "${xSize}um", "YSize:=", "${ySize}um", "ZSize:=", "${h}um"],
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
  return { matDefs, dielBlocks, condBlocks, condObjs, fAdaptGHz, lineLengthUm: num(lineLengthUm), effThk };
}

const CAP_SETUP = (fGHz) => `["NAME:Setup1",
         "AdaptiveFreq:=", "${fGHz}GHz", "SaveFields:=", False, "Enabled:=", True,
         ["NAME:Cap", "MaxPass:=", 10, "MinPass:=", 1, "MinConvPass:=", 1,
          "PerError:=", 1, "PerRefine:=", 30, "AutoIncreaseSolutionOrder:=", True,
          "SolutionOrder:=", "High", "Solver Type:=", "Iterative"]]`;

// Nets + setup + frequency sweep + SOLVE + C-per-length reports (top-level
// statements, shared by both emitters). Each conductor object → its own signal
// net. IMPORTANT: Q3D matrix quantities like C(netA,netB) DO NOT EXIST until the
// design is solved — creating a report/output-variable that references C(...)
// BEFORE solving fails with "'C' is not a function name". So we Analyze the
// (fast, electrostatic) capacitance setup FIRST, then create the reports.
function q3dNetsSetupReports({ condObjs, fAdaptGHz, lengthUm, sweep }) {
  const nets = condObjs.map((o) => `q3d_signal_net("net_${o}", "${o}")`).join('\n');
  const lenM = (Number.isFinite(lengthUm) && lengthUm > 0) ? lengthUm * 1e-6 : 1e-3;
  const s = sweep || {};
  const startG = Number.isFinite(s.startGHz) ? s.startGHz : 1;
  const stopG = Number.isFinite(s.stopGHz) ? s.stopGHz : 40;
  const pts = (Number.isFinite(s.points) && s.points >= 1) ? Math.round(s.points) : 201;
  const a = condObjs.length >= 2 ? `net_${condObjs[0]}` : null;
  const b = condObjs.length >= 2 ? `net_${condObjs[1]}` : null;

  let extract = '# (need >=2 conductor nets for a conductor-to-conductor C/length)';
  if (a && b) {
    extract = `# LINE_LENGTH_UM is a best-effort geometry guess — VERIFY it equals your line's
# PHYSICAL (unfolded) length, especially for a meander.
LINE_LENGTH_UM = ${dec(lengthUm)}
# Solve the (fast) electrostatic capacitance so the C matrix quantities exist —
# they DON'T pre-solve, which is why the reports below come AFTER Analyze.
# Comment this out if you'd rather mesh/solve manually first; then create the
# reports from Results -> Create Report -> Matrix.
try:
    oDesign.Analyze("Setup1")
except Exception as e:
    oDesktop.AddMessage("", "", 2, "Q3D Analyze failed (solve manually, then create the report from Results -> Matrix): " + str(e))
# Raw conductor-to-conductor capacitance report (most robust).
try:
    oDesign.GetModule("ReportSetup").CreateReport("Capacitance", "Matrix", "Data Table",
        "Setup1 : LastAdaptive", ["Context:=", "Original"], [],
        ["X Component:=", "Freq", "Y Component:=", ["C(${a},${b})"]], [])
except Exception as e:
    oDesktop.AddMessage("", "", 1, "Capacitance report skipped (create from Results -> Matrix): " + str(e))
# Per-length: C(netA,netB) / physical length. The output variable is valid only
# now (post-solve); if your release still rejects C(...) here, read C from the
# 'Capacitance' report and divide by LINE_LENGTH_UM*1e-6 yourself.
try:
    oDesign.GetModule("OutputVariable").CreateOutputVariable(
        "C_per_m", "abs(C(${a},${b}))/${dec(lenM)}", "Setup1 : LastAdaptive", "Matrix", [])
    oDesign.GetModule("ReportSetup").CreateReport("C per length", "Matrix", "Data Table",
        "Setup1 : LastAdaptive", ["Context:=", "Original"], [],
        ["X Component:=", "Freq", "Y Component:=", ["C_per_m"]], [])
except Exception as e:
    oDesktop.AddMessage("", "", 1, "C_per_m report skipped: " + str(e))
oDesktop.AddMessage("", "", 0, "C per length = abs(C(${a},${b})) / (LINE_LENGTH_UM*1e-6). Read C from the 'Capacitance' report (or Results -> Matrix); paste C_per_m into the 2-line wizard.")`;
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

// Standalone Q3D capacitance script (own project + design).
export function generateQ3DCapacitance(scene, paramValues, opts = {}) {
  const body = buildQ3DBody(scene, paramValues, opts, 'safe_create_box', 'safe_create_polyline', 'safe_sweep_z');
  const design = (opts.designName || 'q3d_cap').replace(/[^A-Za-z0-9_]/g, '_');
  const sweep = { startGHz: opts.freqStartGHz, stopGHz: opts.freqStopGHz, points: opts.freqPoints };
  const code = `# -*- coding: utf-8 -*-
# Auto-generated Q3D Extractor capacitance script (AEDT: Tools -> Run Script).
# Per-length capacitance C of a MEANDERED line for Z0 = gamma/(j*w*C).
# Builds ONLY the selected line conductor(s) as THIN CONDUCTORS (thickness
# ${body.effThk} um): ${body.condObjs.length} object(s). Feeds excluded.
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

def _del(name):
    try:
        oEditor.Delete(["NAME:Selections", "Selections:=", name])
    except:
        pass
def safe_create_box(bp, attr, name):
    _del(name)
    try:
        oEditor.CreateBox(bp, attr)
    except Exception as e:
        oDesktop.AddMessage("", "", 1, "CreateBox " + name + " failed: " + str(e))
def safe_create_polyline(pp, attr, name):
    _del(name)
    try:
        oEditor.CreatePolyline(pp, attr)
    except Exception as e:
        oDesktop.AddMessage("", "", 1, "CreatePolyline " + name + " failed: " + str(e))
def safe_sweep_z(name, dz):
    try:
        oEditor.SweepAlongVector(
            ["NAME:Selections", "Selections:=", name, "NewPartsModelFlag:=", "Model"],
            ["NAME:VectorSweepParameters", "DraftAngle:=", "0deg", "DraftType:=", "Round",
             "CheckFaceFaceIntersection:=", False,
             "SweepVectorX:=", "0um", "SweepVectorY:=", "0um", "SweepVectorZ:=", dz])
    except Exception as e:
        oDesktop.AddMessage("", "", 1, "Sweep " + name + " failed: " + str(e))
def define_material(name, eps_r, mu_r, sigma, tand):
    try:
        oProject.GetDefinitionManager().AddMaterial(
            ["NAME:" + name, "CoordinateSystemType:=", "Cartesian", ["NAME:AttachedData"],
             "permittivity:=", str(eps_r), "permeability:=", str(mu_r),
             "conductivity:=", str(sigma), "dielectric_loss_tangent:=", str(tand)])
    except Exception as e:
        oDesktop.AddMessage("", "", 1, "AddMaterial " + name + " failed: " + str(e))

# ===== Materials =====
${body.matDefs || '# (all materials are AEDT built-ins)'}

# ===== Dielectric stack =====
${body.dielBlocks.join('\n') || '# (no dielectric layers)'}

# ===== Line conductor(s) — thin conductors (${body.effThk} um) =====
${body.condBlocks.join('\n')}

${q3dNetsSetupReports({ condObjs: body.condObjs, fAdaptGHz: body.fAdaptGHz, lengthUm: opts.lengthUm ?? body.lineLengthUm, sweep })}

oProject.Save()
oDesktop.AddMessage("", "", 0, "Q3D capacitance built + solved. Read 'C per length' (verify LINE_LENGTH_UM) -> paste C (F/m) into the 2-line wizard.")
`;
  return ascii(code);
}

// A Python block adding a Q3D design to the EXISTING 2-line project (one file
// builds both). Defines its own q3d_* helpers; reuses the project's materials.
export function generateQ3DCombinedBlock(scene, paramValues, opts = {}) {
  const body = buildQ3DBody(scene, paramValues, opts, 'q3d_box', 'q3d_poly', 'q3d_sweep');
  const design = (opts.designName || 'q3d_cap').replace(/[^A-Za-z0-9_]/g, '_');
  const hfss = (opts.hfssDesignName || 'Layout').replace(/[^A-Za-z0-9_]/g, '_');
  const cVar = (opts.cVarName || 'tl_C_F_per_m');
  const sweep = { startGHz: opts.freqStartGHz, stopGHz: opts.freqStopGHz, points: opts.freqPoints };
  const code = `
# ===== Q3D capacitance design (same project) — for Z0 = gamma/(j*w*C) =====
# Adds a Q3D Extractor design solving the per-length C of the SINGLE line (only
# the selected conductor(s) as THIN CONDUCTORS, ${body.effThk} um; feeds excluded).
# After it solves, read 'C per length' and set the HFSS variable "${cVar}" on
# design "${hfss}" (or uncomment the auto-transfer). Q3D COM not validated here.
try:
    oProject.InsertDesign("Q3D Extractor", "${design}", "", "")
    oDesign = oProject.SetActiveDesign("${design}")
    oEditor = oDesign.SetActiveEditor("3D Modeler")
    oEditor.SetModelUnits(["NAME:Units Parameter", "Units:=", "um", "Rescale:=", True])
except Exception as e:
    oDesktop.AddMessage("", "", 2, "Q3D design create failed: " + str(e))

def _q3d_del(name):
    try:
        oEditor.Delete(["NAME:Selections", "Selections:=", name])
    except:
        pass
def q3d_box(bp, attr, name):
    _q3d_del(name)
    try:
        oEditor.CreateBox(bp, attr)
    except Exception as e:
        oDesktop.AddMessage("", "", 1, "Q3D CreateBox " + name + " failed: " + str(e))
def q3d_poly(pp, attr, name):
    _q3d_del(name)
    try:
        oEditor.CreatePolyline(pp, attr)
    except Exception as e:
        oDesktop.AddMessage("", "", 1, "Q3D CreatePolyline " + name + " failed: " + str(e))
def q3d_sweep(name, dz):
    try:
        oEditor.SweepAlongVector(
            ["NAME:Selections", "Selections:=", name, "NewPartsModelFlag:=", "Model"],
            ["NAME:VectorSweepParameters", "DraftAngle:=", "0deg", "DraftType:=", "Round",
             "CheckFaceFaceIntersection:=", False,
             "SweepVectorX:=", "0um", "SweepVectorY:=", "0um", "SweepVectorZ:=", dz])
    except Exception as e:
        oDesktop.AddMessage("", "", 1, "Q3D Sweep " + name + " failed: " + str(e))

# Dielectric stack (materials already defined at project level by the HFSS design)
${body.dielBlocks.join('\n')}
# Line conductor(s) — thin conductors
${body.condBlocks.join('\n')}

${q3dNetsSetupReports({ condObjs: body.condObjs, fAdaptGHz: body.fAdaptGHz, lengthUm: opts.lengthUm ?? body.lineLengthUm, sweep })}

oProject.Save()
oDesktop.AddMessage("", "", 0, "Q3D design '${design}' built + solved. Read 'C per length' (verify LINE_LENGTH_UM), set ${cVar} on design '${hfss}'.")

# --- Optional AUTO-TRANSFER (uncomment after verifying the matrix read in your
#     AEDT release; a wrong read would silently corrupt Z0, so it's off by default) ---
# try:
#     oDesign.Analyze("Setup1")
#     # ... read C_per_m from the solution, then: ...
#     oDesign = oProject.SetActiveDesign("${hfss}")
#     set_var("${cVar}", str(C_per_m_value))
# except Exception as e:
#     oDesktop.AddMessage("", "", 2, "Auto-transfer failed: " + str(e))
oDesign = oProject.SetActiveDesign("${hfss}")
`;
  return ascii(code);
}
