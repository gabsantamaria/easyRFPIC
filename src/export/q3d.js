// Q3D Extractor capacitance for the meander Z0 route.
//
// For a MEANDERED (non-uniform) line there's no uniform cross-section, so the
// per-length capacitance C can't come from Q2D. But the FULL 3-D folded
// geometry solves in Q3D Extractor: read the capacitance between the two line
// conductors, divide by the line's PHYSICAL length → C (F/m), then Z0 = γ/(jωC)
// (γ from the 2-line method). C is electrostatic ⇒ unaffected by kinetic
// inductance ⇒ Z0 is kinetic-inductance-correct.
//
// This module emits the Q3D geometry two ways:
//   * generateQ3DCapacitance  — a standalone Q3D script (own project + design).
//   * generateQ3DCombinedBlock — a Python block that adds a Q3D design to the
//     SAME project as the 2-line HFSS script, so one file builds both. The
//     conductor-to-conductor C is reported (and a commented auto-transfer sets
//     the HFSS `tl_C_F_per_m` design variable → Z0). The block builds the
//     SINGLE line (C/length is a one-line quantity), not the doubled 2-line scene.
//
// Only the SELECTED line conductor(s) are emitted — the feed/launch is excluded
// on purpose (it bridges the conductors across the port gap and would short the
// nets in an electrostatic solve). The Q3D-specific COM (AutoIdentifyNets,
// Matrix setup, ExportMatrixData) is NOT validated in this repo — wrapped in
// try/except; expect per-AEDT-release tweaks. The geometry uses the same proven
// modeler calls as the HFSS/GDS exporters.
import { normalizeScene, migrateStackCoplanarGroups } from '../scene/schema.js';
import { resolveParams, evalExpr } from '../scene/params.js';
import { solveLayout } from '../scene/solver.js';
import { expandTransforms } from '../scene/transforms.js';
import { shapeInstanceToRing } from '../geometry/rings.js';

const ascii = (s) => String(s ?? '').replace(/[^\x00-\x7F]/g, '?');
const num = (v) => (Number.isFinite(v) ? (Math.round(v * 1e6) / 1e6) : 0);

// Group-aware numeric Z walk (mirrors hfss-native's layerZ / pyaedt's
// numericLayerZ): substrates below the device datum go negative; coplanar-group
// members share zBottom and the group advances past its cladding top.
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

// Shared geometry/material body. boxFn/polyFn are the Python helper names the
// emitted blocks call (so the standalone and the embedded-in-HFSS variants can
// use differently-named helpers without clashing).
function buildQ3DBody(scene, paramValues, opts, boxFn, polyFn) {
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
  const condZBot = condLayer ? (zBottom[condLayer.id] ?? 0) : 0;
  const condZTop = condLayer ? (zTop[condLayer.id] ?? 0) : 0;
  const condZ = num((condZBot + condZTop) / 2);

  const condObjs = [];
  const condBlocks = [];
  let bb = { xMin: Infinity, xMax: -Infinity, yMin: Infinity, yMax: -Infinity };
  let lineLengthUm = 0; // best-effort: max single-conductor extent
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
        `["NAME:PLPoint", "X:=", "${num(x)}um", "Y:=", "${num(y)}um", "Z:=", "${condZ}um"]`
      ).join(',\n          ');
      const segs = ring.map((_, j) =>
        `["NAME:PLSegment", "SegmentType:=", "Line", "StartIndex:=", ${j}, "NoOfPoints:=", 2]`
      ).join(',\n          ');
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
    "${name}")`);
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
  const matNames = [...usedMats].filter((m) => m && !STD.has(m));
  const matDefs = matNames.map((m) => {
    const p = CUSTOM[m] || [4.0, 1, 0, 0.001];
    return `define_material("${ascii(m)}", ${p[0]}, ${p[1]}, ${p[2]}, ${p[3]})`;
  }).join('\n');

  const fAdaptGHz = (() => { const f = evalExpr(src.simSetup?.fnominal ?? '4', pv); return Number.isFinite(f) && f > 0 ? f : 4; })();
  return { matDefs, dielBlocks, condBlocks, condObjs, fAdaptGHz, lineLengthUm: num(lineLengthUm) };
}

const CAP_SETUP = (fGHz) => `["NAME:Setup1",
         "AdaptiveFreq:=", "${fGHz}GHz", "SaveFields:=", False, "Enabled:=", True,
         ["NAME:Cap", "MaxPass:=", 10, "MinPass:=", 1, "MinConvPass:=", 1,
          "PerError:=", 1, "PerRefine:=", 30, "AutoIncreaseSolutionOrder:=", True,
          "SolutionOrder:=", "High", "Solver Type:=", "Iterative"]]`;

// Standalone Q3D capacitance script (own project + design).
export function generateQ3DCapacitance(scene, paramValues, opts = {}) {
  const body = buildQ3DBody(scene, paramValues, opts, 'safe_create_box', 'safe_create_polyline');
  const design = (opts.designName || 'q3d_cap').replace(/[^A-Za-z0-9_]/g, '_');
  const code = `# -*- coding: utf-8 -*-
# Auto-generated Q3D Extractor capacitance script (AEDT: Tools -> Run Script).
# Goal: per-length capacitance C of a MEANDERED line for Z0 = gamma/(j*w*C).
# Builds ONLY the selected line conductor(s): ${body.condObjs.length} object(s).
# (Feeds/launches excluded — they short the nets in an electrostatic solve.)
#
# AFTER SOLVING: Results -> Solution Data -> Matrix (Capacitance). Take the
# conductor-to-conductor C, divide by the line's PHYSICAL (unfolded) length in
# metres, paste that C (F/m) into the 2-line wizard "C per length" field.
# Best-effort length guess from geometry: LINE_LENGTH_UM = ${body.lineLengthUm} um (VERIFY).
#
# CAVEAT: AutoIdentifyNets / setup / export COM are Q3D-specific and NOT
# validated here — fix in the GUI if one errors (the geometry is correct).
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

# ===== Line conductor(s) =====
${body.condBlocks.join('\n')}

# ===== Nets + capacitance setup =====
try:
    oDesign.GetModule("BoundarySetup").AutoIdentifyNets()
except Exception as e:
    oDesktop.AddMessage("", "", 2, "AutoIdentifyNets failed (assign nets manually): " + str(e))
try:
    oDesign.GetModule("AnalysisSetup").InsertSetup("Matrix", ${CAP_SETUP(body.fAdaptGHz)})
except Exception as e:
    oDesktop.AddMessage("", "", 2, "InsertSetup(Matrix) failed (create a Cap setup manually): " + str(e))

oProject.Save()
oDesktop.AddMessage("", "", 0, "Q3D capacitance model built. Analyze Setup1, read the C matrix; C_line / physical_length (m) -> 2-line wizard.")
`;
  return ascii(code);
}

// A Python block that adds a Q3D design to the EXISTING 2-line project (so one
// script builds both). Reuses the project's already-defined materials; defines
// its own q3d_* modeler helpers to avoid clashing with the HFSS script's. After
// solving it reports C_line and the suggested C (F/m); a commented auto-transfer
// sets the HFSS `${'${cVar}'}` design variable on `hfssDesignName`.
export function generateQ3DCombinedBlock(scene, paramValues, opts = {}) {
  const body = buildQ3DBody(scene, paramValues, opts, 'q3d_box', 'q3d_poly');
  const design = (opts.designName || 'q3d_cap').replace(/[^A-Za-z0-9_]/g, '_');
  const hfss = (opts.hfssDesignName || 'Layout').replace(/[^A-Za-z0-9_]/g, '_');
  const cVar = (opts.cVarName || 'tl_C_F_per_m');
  const code = `
# ===== Q3D capacitance design (same project) — for Z0 = gamma/(j*w*C) =====
# Adds a Q3D Extractor design that solves the per-length capacitance C of the
# SINGLE line (only the selected conductor(s); feeds excluded so they don't
# short the nets). After it solves, read C_line from the matrix and set the HFSS
# variable "${cVar}" = C_line / (LINE_LENGTH_UM*1e-6) on design "${hfss}" — then
# the Z0 reports populate. (Q3D COM is not validated here; fix in GUI if needed.)
LINE_LENGTH_UM = ${body.lineLengthUm}   # <-- VERIFY: line PHYSICAL (unfolded) length in um
try:
    oProject.InsertDesign("Q3D Extractor", "${design}", "", "")
    oDesign = oProject.SetActiveDesign("${design}")
    oEditor = oDesign.SetActiveEditor("3D Modeler")
    oEditor.SetModelUnits(["NAME:Units Parameter", "Units:=", "um", "Rescale:=", True])

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

    # Dielectric stack (materials already defined at project level by the HFSS design)
${body.dielBlocks.map((b) => '    ' + b.replace(/\n/g, '\n    ')).join('\n')}
    # Line conductor(s)
${body.condBlocks.map((b) => '    ' + b.replace(/\n/g, '\n    ')).join('\n')}

    try:
        oDesign.GetModule("BoundarySetup").AutoIdentifyNets()
    except Exception as e:
        oDesktop.AddMessage("", "", 2, "Q3D AutoIdentifyNets failed: " + str(e))
    try:
        oDesign.GetModule("AnalysisSetup").InsertSetup("Matrix", ${CAP_SETUP(body.fAdaptGHz)})
    except Exception as e:
        oDesktop.AddMessage("", "", 2, "Q3D InsertSetup failed: " + str(e))

    oProject.Save()
    oDesktop.AddMessage("", "", 0, "Q3D design '${design}' built. Analyze it, read C_line (Results -> Matrix), then set ${cVar} = C_line/(LINE_LENGTH_UM*1e-6) on design '${hfss}'.")
except Exception as e:
    oDesktop.AddMessage("", "", 2, "Q3D design build failed: " + str(e))

# --- Optional AUTO-TRANSFER (uncomment after verifying the matrix read in your
#     AEDT release; a wrong read would silently corrupt Z0, so it's off by default) ---
# try:
#     oDesign = oProject.SetActiveDesign("${design}")
#     oDesign.Analyze("Setup1")
#     import os
#     _cf = os.path.join(oProject.GetPath(), "${design}_C.txt")
#     oDesign.ExportMatrixData(_cf, "C", "", "Setup1 : LastAdaptive", "Original",
#         "ohm", "nH", "fF", "mSie", ${body.fAdaptGHz}000000000, "Maxwell", 0, False, 5, 99)
#     # parse _cf, take the conductor-to-conductor C in fF -> Farads:
#     C_line = 0.0  # <-- set from the parsed matrix (Farads)
#     C_per_m = C_line / (LINE_LENGTH_UM * 1e-6)
#     oDesign = oProject.SetActiveDesign("${hfss}")
#     set_var("${cVar}", str(C_per_m))
#     oDesktop.AddMessage("", "", 0, "Set ${cVar} = " + str(C_per_m) + " F/m")
# except Exception as e:
#     oDesktop.AddMessage("", "", 2, "Auto-transfer failed: " + str(e))
oDesign = oProject.SetActiveDesign("${hfss}")
`;
  return ascii(code);
}
