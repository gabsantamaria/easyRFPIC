// Q3D Extractor capacitance script generator.
//
// For a MEANDERED (non-uniform) transmission line you can't get the per-length
// capacitance C from a 2-D cross-section (Q2D) — there's no uniform cross
// section. But you CAN solve the FULL 3-D folded geometry in Q3D Extractor and
// read the capacitance between the two line conductors. Divide that by the
// line's PHYSICAL length to get C (F/m), then feed it to the 2-line wizard:
// Z0 = γ/(jωC). Because C is electrostatic it is unaffected by kinetic
// inductance, so the resulting Z0 is kinetic-inductance-correct (γ carries L_kin).
//
// This emits a SEPARATE, self-contained Q3D script (the rest of the app targets
// HFSS). The geometry uses the same proven modeler calls (CreatePolyline /
// CreateBox) and ring helper as the GDS/HFSS exporters, so it matches the
// canvas exactly. The Q3D-SPECIFIC calls (AutoIdentifyNets, the capacitance
// setup, matrix export) differ from HFSS and are NOT validated in this repo —
// they're wrapped in try/except with messages; expect to tweak them for your
// AEDT release.
//
// IMPORTANT — only the SELECTED line conductor(s) are emitted. The feed/launch
// is deliberately excluded: in the real device the launch bridges the two
// conductors across the port gap, so including it would short the two nets in
// an electrostatic solve. C per length is a property of the line conductors
// alone.
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
  // Substrates below the datum, stacked downward (negative Z).
  let zc = 0;
  for (let i = datum - 1; i >= 0; i--) { const t = thk(layers[i]); zTop[layers[i].id] = zc; zBottom[layers[i].id] = zc - t; zc -= t; }
  // From the datum up; coplanar groups share zBottom.
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

// generateQ3DCapacitance(scene, paramValues, { conductorIds, designName })
// conductorIds: the component ids of the LINE conductor(s) (their transform
// instances each become a separate conductor object → AutoIdentifyNets gives
// one net per electrically-isolated conductor).
export function generateQ3DCapacitance(scene, paramValues, opts = {}) {
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
  // Conductor sheet Z = mid-height of its conductor layer (sheet for h=0).
  const condZBot = condLayer ? (zBottom[condLayer.id] ?? 0) : 0;
  const condZTop = condLayer ? (zTop[condLayer.id] ?? 0) : 0;
  const condZ = num((condZBot + condZTop) / 2);

  // Emit each selected conductor's transform instances as covered sheets.
  const condObjs = [];
  let bb = { xMin: Infinity, xMax: -Infinity, yMin: Infinity, yMax: -Infinity };
  const condBlocks = [];
  for (const c of condComps) {
    const insts = expandTransforms([c], pv);
    insts.forEach((inst, k) => {
      if (!Number.isFinite(inst.w) || !Number.isFinite(inst.h) || inst.w <= 0 || inst.h <= 0) return;
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
      condBlocks.push(`safe_create_polyline(
    ["NAME:PolylineParameters",
     "IsPolylineCovered:=", True,
     "IsPolylineClosed:=", True,
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

  // Dielectric footprint: conductor bbox + a generous lateral pad so the C
  // field isn't truncated. Pad = max(50 µm, span).
  const spanX = bb.xMax - bb.xMin, spanY = bb.yMax - bb.yMin;
  const pad = Math.max(50, spanX, spanY);
  const xPos = num(bb.xMin - pad), yPos = num(bb.yMin - pad);
  const xSize = num(spanX + 2 * pad), ySize = num(spanY + 2 * pad);

  // Dielectric boxes for every non-conductor layer (substrates + device
  // dielectrics) over the footprint, at their Z range.
  const dielBlocks = [];
  for (const l of stack) {
    if (l.role === 'conductor') continue;
    const zb = zBottom[l.id], zt = zTop[l.id];
    if (zb == null || zt == null) continue;
    const h = num(zt - zb);
    if (h <= 0) continue;
    const nm = `diel_${l.id}`.replace(/[^A-Za-z0-9_]/g, '_');
    dielBlocks.push(`safe_create_box(
    ["NAME:BoxParameters",
     "XPosition:=", "${xPos}um", "YPosition:=", "${yPos}um", "ZPosition:=", "${num(zb)}um",
     "XSize:=", "${xSize}um", "YSize:=", "${ySize}um", "ZSize:=", "${h}um"],
    ["NAME:Attributes",
     "Name:=", "${nm}", "Flags:=", "", "Color:=", "(160 160 200)",
     "Transparency:=", 0.7, "PartCoordinateSystem:=", "Global",
     "MaterialValue:=", "\\"${ascii(l.material || 'vacuum')}\\"", "SolveInside:=", True],
    "${nm}")`);
  }

  // Materials to define (non-standard dielectrics + conductor).
  const STD = new Set(['vacuum', 'air', 'copper', 'gold', 'aluminum', 'silicon', 'silicon_dioxide', 'silicon_nitride', 'FR4_epoxy', 'polyimide', 'Pec', 'Teflon_based']);
  const CUSTOM = { lithium_tantalate: [41.4, 1, 0, 0.001], lithium_niobate: [28.0, 1, 0, 0.001] };
  const usedMats = new Set([condMat, ...stack.filter((l) => l.role !== 'conductor').map((l) => l.material)]);
  const matDefs = [...usedMats].filter((m) => m && !STD.has(m)).map((m) => {
    const p = CUSTOM[m] || [4.0, 1, 0, 0.001];
    return `define_material("${ascii(m)}", ${p[0]}, ${p[1]}, ${p[2]}, ${p[3]})`;
  }).join('\n');

  const design = (opts.designName || 'q3d_cap').replace(/[^A-Za-z0-9_]/g, '_');
  const fAdaptGHz = (() => { const f = evalExpr(src.simSetup?.fnominal ?? '4', pv); return Number.isFinite(f) && f > 0 ? f : 4; })();

  const code = `# -*- coding: utf-8 -*-
# Auto-generated Q3D Extractor capacitance script (run via HFSS/AEDT: Tools -> Run Script)
# Goal: per-length capacitance C of a MEANDERED line for Z0 = gamma/(j*w*C).
#
# WHAT THIS DOES
#   * Builds ONLY the selected line conductor(s): ${condObjs.length} conductor object(s).
#     (Feeds/launches are excluded on purpose — they bridge the conductors across
#      the port gap and would short the nets in an electrostatic solve.)
#   * Builds the dielectric stack over the conductor footprint.
#   * AutoIdentifyNets -> one net per electrically-isolated conductor.
#   * Inserts a capacitance setup at ${fAdaptGHz} GHz.
#
# AFTER YOU SOLVE
#   Open Results -> Solution Data -> Matrix (Capacitance). Take the capacitance
#   between the TWO line-conductor nets (the off-diagonal / conductor-to-conductor
#   term), DIVIDE by the line's PHYSICAL (unfolded) length in metres, and paste
#   that C (F/m) into the 2-line wizard's "C per length" field.
#
# CAVEAT: the AutoIdentifyNets / setup / export COM calls below are Q3D-specific
# and are NOT validated in this tool. If one errors in your AEDT release, fix it
# in the GUI (it's a one-time setup) — the geometry above is correct.

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

# ===== Materials =====
def define_material(name, eps_r, mu_r, sigma, tand):
    try:
        oProject.GetDefinitionManager().AddMaterial(
            ["NAME:" + name, "CoordinateSystemType:=", "Cartesian",
             ["NAME:AttachedData"],
             "permittivity:=", str(eps_r), "permeability:=", str(mu_r),
             "conductivity:=", str(sigma), "dielectric_loss_tangent:=", str(tand)])
    except Exception as e:
        oDesktop.AddMessage("", "", 1, "AddMaterial " + name + " failed: " + str(e))
${matDefs || '# (all materials are AEDT built-ins)'}

# ===== Dielectric stack =====
${dielBlocks.join('\n') || '# (no dielectric layers)'}

# ===== Line conductor(s) — sheets at z=${condZ}um =====
${condBlocks.join('\n')}

# ===== Nets + capacitance setup =====
try:
    oBoundarySetup = oDesign.GetModule("BoundarySetup")
    oBoundarySetup.AutoIdentifyNets()
except Exception as e:
    oDesktop.AddMessage("", "", 2, "AutoIdentifyNets failed (assign nets manually): " + str(e))

try:
    oAnalysis = oDesign.GetModule("AnalysisSetup")
    oAnalysis.InsertSetup("Matrix",
        ["NAME:Setup1",
         "AdaptiveFreq:=", "${fAdaptGHz}GHz",
         "SaveFields:=", False,
         "Enabled:=", True,
         ["NAME:Cap",
          "MaxPass:=", 10, "MinPass:=", 1, "MinConvPass:=", 1,
          "PerError:=", 1, "PerRefine:=", 30,
          "AutoIncreaseSolutionOrder:=", True, "SolutionOrder:=", "High",
          "Solver Type:=", "Iterative"]])
except Exception as e:
    oDesktop.AddMessage("", "", 2, "InsertSetup(Matrix) failed (create a Cap setup manually): " + str(e))

oProject.Save()
oDesktop.AddMessage("", "", 0, "Q3D capacitance model built. Analyze Setup1, then read the C matrix (Results -> Matrix). C_line = conductor-to-conductor C; divide by physical length (m) -> paste into the 2-line wizard.")

# --- Optional: auto-solve + export the C matrix (uncomment; verify for your release) ---
# oDesign.Analyze("Setup1")
# import os
# out = os.path.join(oProject.GetPath(), "${design}_Cmatrix.txt")
# try:
#     oDesign.ExportMatrixData(out, "C", "", "Setup1 : LastAdaptive", "Original", "ohm", "nH", "fF", "mSie", ${fAdaptGHz}000000000, "Maxwell", 0, False, 5, 99)
#     oDesktop.AddMessage("", "", 0, "Wrote " + out)
# except Exception as e:
#     oDesktop.AddMessage("", "", 2, "ExportMatrixData failed: " + str(e))
`;
  return ascii(code);
}
