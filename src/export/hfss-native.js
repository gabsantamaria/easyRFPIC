// HFSS native COM script export.
//
// Emits a Python 2.7-compatible script that drives HFSS via the
// COM/ScriptEnv API directly (`oEditor.CreateBox` etc), wrapping each
// modeler call in a try/except so failures don't abort the run. Unlike
// the pyAEDT path, this script declares every scene parameter as an HFSS
// variable up front via set_var so primitives are created with parametric
// XYZ + size expressions.
//
// Includes computeParametricPositions, which walks the snap DAG to derive
// each component's cx/cy as an HFSS expression referencing snap-chain
// parameters, so a parameter sweep in HFSS actually moves the geometry.
//
// Extracted from PhotonicLayout.jsx as Stage 2.3 of the planned refactor.
import { evalExpr } from '../scene/params.js';
import { parseAnchor, anchorLocal } from '../scene/anchors.js';
import { solveLayout, applyMirrors } from '../scene/solver.js';
import { expandTransforms } from '../scene/transforms.js';
import { detectPortIntegrationLine } from '../scene/lumpedPort.js';
import { shapeInstanceToRing } from '../geometry/rings.js';
import { buildRacetrackCenterline, offsetCenterlineToBand } from '../geometry/racetrack.js';

// ----------------------------------------------------------------------
// PARAMETRIC POSITION EXPRESSIONS (for HFSS export)
// ----------------------------------------------------------------------
// The solver computes numeric cx/cy for each component. For HFSS export we
// instead want each component's position as an EXPRESSION that references the
// underlying snap-chain parameters, so that changing a parameter in HFSS
// (e.g., for a parameter sweep) actually moves the geometry.
//
// Returns { [compId]: { cxExpr, cyExpr } } where each expr is a string suitable
// for HFSS variable evaluation. Free components (no inbound snap) get a
// literal value as the expression. Children's expressions reference their
// parent's expression plus snap offsets and anchor offsets.
//
// Anchors contribute offset terms that depend on component width/height:
//   Fixed anchor like 'NW': (-w/2, +h/2)
//   Edge anchor 'T:0.3':    ((0.3 - 0.5) * w, +h/2)
// Component w/h are themselves expression strings (e.g., 'cap_W' or '20').
function computeParametricPositions(components, snaps) {
  const byId = Object.fromEntries(components.map(c => [c.id, c]));
  // Helper: produce an expression for the X/Y offset of an anchor on a comp
  // whose width-expression is wExpr and height-expression is hExpr.
  const anchorOffsetExpr = (anchorName, wExpr, hExpr) => {
    const a = parseAnchor(anchorName);
    let xOff = '0', yOff = '0';
    if (a.kind === 'edge') {
      if (a.side === 'T') { xOff = `(${a.t} - 0.5) * (${wExpr})`; yOff = `(${hExpr})/2`; }
      else if (a.side === 'B') { xOff = `(${a.t} - 0.5) * (${wExpr})`; yOff = `-(${hExpr})/2`; }
      else if (a.side === 'L') { xOff = `-(${wExpr})/2`; yOff = `(${a.t} - 0.5) * (${hExpr})`; }
      else if (a.side === 'R') { xOff = `(${wExpr})/2`;  yOff = `(${a.t} - 0.5) * (${hExpr})`; }
    } else {
      const n = a.name;
      if (n.includes('W')) xOff = `-(${wExpr})/2`;
      else if (n.includes('E')) xOff = `(${wExpr})/2`;
      if (n.includes('S')) yOff = `-(${hExpr})/2`;
      else if (n.includes('N')) yOff = `(${hExpr})/2`;
    }
    return { xOff, yOff };
  };

  // Build incoming-snap lookup
  const incomingSnap = new Map(); // toCompId -> snap
  for (const s of snaps) incomingSnap.set(s.to.compId, s);

  const positions = {}; // compId -> { cxExpr, cyExpr }
  const visiting = new Set();

  const resolve = (compId) => {
    if (positions[compId]) return positions[compId];
    if (visiting.has(compId)) {
      // Cycle — fall back to literal cx/cy to break it
      const c = byId[compId];
      const cx = (c && Number.isFinite(c.cx)) ? c.cx : 0;
      const cy = (c && Number.isFinite(c.cy)) ? c.cy : 0;
      positions[compId] = { cxExpr: `${cx}um`, cyExpr: `${cy}um` };
      return positions[compId];
    }
    visiting.add(compId);
    const c = byId[compId];
    if (!c) {
      visiting.delete(compId);
      const fallback = { cxExpr: '0um', cyExpr: '0um' };
      positions[compId] = fallback;
      return fallback;
    }
    const snap = incomingSnap.get(compId);
    if (!snap) {
      // Free component: position is its raw cx/cy literal. Append "um" so that
      // when this leaf is composed into a chain expression with parameters
      // (which are unit-bearing), HFSS evaluates the whole chain in length units.
      const cx = Number.isFinite(c.cx) ? c.cx : 0;
      const cy = Number.isFinite(c.cy) ? c.cy : 0;
      const result = { cxExpr: `${cx}um`, cyExpr: `${cy}um` };
      positions[compId] = result;
      visiting.delete(compId);
      return result;
    }
    // Recurse into parent
    const parent = byId[snap.from.compId];
    const parentPos = resolve(snap.from.compId);
    if (!parent) {
      const fallback = { cxExpr: '0um', cyExpr: '0um' };
      positions[compId] = fallback;
      visiting.delete(compId);
      return fallback;
    }
    const fromOff = anchorOffsetExpr(snap.from.anchor, parent.w, parent.h);
    const toOff   = anchorOffsetExpr(snap.to.anchor,   c.w,      c.h);
    // Solver: toComp.cx = fromAnchorWorld.x + dx - toAnchor.local.x
    //                  = (parent.cx + fromOff.x) + dx - toOff.x
    const cxExpr = `(${parentPos.cxExpr}) + (${fromOff.xOff}) + (${snap.dx}) - (${toOff.xOff})`;
    const cyExpr = `(${parentPos.cyExpr}) + (${fromOff.yOff}) + (${snap.dy}) - (${toOff.yOff})`;
    const result = { cxExpr, cyExpr };
    positions[compId] = result;
    visiting.delete(compId);
    return result;
  };

  for (const c of components) resolve(c.id);
  return positions;
}

// =========================================================================
// NATIVE HFSS COM SCRIPT (for use inside HFSS via Tools -> Run Script)
// Uses ScriptEnv.Initialize and oEditor.CreateBox with the two-array pattern.
// Python 2.7 compatible (no f-strings, ASCII only).
// =========================================================================
export function generateHfssNative(scene, paramValues, options = {}) {
  // options.appendToActive — if true, generate a script that adds the
  //   geometry to whatever HFSS project/design is currently active
  //   instead of creating a fresh one. Used when the user already has
  //   a design wired up with setups / sweeps / boundaries they don't
  //   want to recreate every export.
  const appendToActive = !!options.appendToActive;
  const { params, components, mirrors, snaps, stack } = scene;
  const solved = applyMirrors(solveLayout(components, snaps, paramValues), mirrors);

  // Parametric position expressions: each component's cx/cy as an expression
  // string referencing snap-chain parameters. Used so that changing parameters
  // in HFSS (e.g. for sweeps) actually moves the geometry, instead of baking
  // in literal numeric positions.
  // Note: applyMirrors makes mirrored components lose their parametric chain
  // (their position is tgt = 2*axis - src, computed numerically). For mirrored
  // components we fall back to numeric positions in HFSS too. Snap-chained
  // (non-mirrored) components stay parametric.
  const parametricPos = computeParametricPositions(components, snaps);
  // Identify mirror-target ids; those don't get parametric positions.
  const mirrorTargetIds = new Set();
  for (const m of mirrors || []) {
    for (const mem of (m.members || [])) {
      if (mem.locked && mem.mirrorId) mirrorTargetIds.add(mem.mirrorId);
    }
  }

  // ASCII sanitizer for safety
  const ascii = (s) => {
    if (typeof s !== 'string') return s;
    return s
      .replace(/µ/g, 'u')
      .replace(/[—–]/g, '-')
      .replace(/[“”]/g, '"')
      .replace(/[‘’]/g, "'")
      .replace(/×/g, 'x')
      .replace(/°/g, 'deg')
      .replace(/[^\x00-\x7F]/g, '?');
  };
  const unitFor = (u) => {
    if (!u) return '';
    if (u === 'µm') return 'um';
    if (u === 'deg') return 'deg';
    return ascii(u);
  };
  // Synthetic-position resolver. Span dimension parameters reference
  // `_comp_<id>_cx` / `_comp_<id>_cy` to track each parent's CURRENT solved
  // position. HFSS doesn't know about those synthetics — we expand them to
  // each parent's full parametric chain expression (which IS valid HFSS).
  const parametricPosForExport = computeParametricPositions(components, snaps);
  const compsById = Object.fromEntries(components.map(c => [c.id, c]));
  const resolveSynthetics = (expr) => {
    if (typeof expr !== 'string') return expr;
    // Match _comp_<id>_<cx|cy|w|h>. cx/cy expand to chain expressions;
    // w/h expand to the component's width/height expression text.
    return expr.replace(/_comp_([A-Za-z0-9_]+)_(cx|cy|w|h)/g, (_, compId, axis) => {
      if (axis === 'cx' || axis === 'cy') {
        const pp = parametricPosForExport[compId];
        if (!pp) return '0';
        return axis === 'cx' ? `(${pp.cxExpr})` : `(${pp.cyExpr})`;
      }
      // w / h: expand to the parent's expression. Recursively resolve in
      // case the parent's expression itself references synthetics.
      const c = compsById[compId];
      if (!c) return '0';
      const inner = axis === 'w' ? c.w : c.h;
      return `(${resolveSynthetics(String(inner ?? '0'))})`;
    });
  };

  // For position/size expressions: HFSS expects each variable reference to be
  // unit-bearing or the whole expression to be in a single unit. Our params
  // are saved with units (µm), so pure expressions in µm-context evaluate
  // correctly. For a literal-only expression (e.g. "0"), append "um" so HFSS
  // doesn't treat it as unitless. For mixed expressions, wrap parens and
  // append unit only if the expression has no identifiers.
  //
  // CRITICAL: HFSS's expression parser treats "foo-bar" (no spaces) as a
  // single (typically unknown) identifier rather than the binary
  // subtraction "foo - bar". A param expression like "cap_s-feed_w"
  // therefore evaluates to 0 and shifts geometry by tens of µm without
  // any error message. Insert spaces around any '-' that sits between
  // two identifier characters before handing the string to HFSS.
  const spaceHyphens = (s) => String(s).replace(/(\w)-(\w)/g, '$1 - $2');
  const exprWithUm = (expr) => {
    const s = spaceHyphens(ascii(resolveSynthetics(String(expr ?? '0'))));
    if (/^[\d\s+\-*/.()]+$/.test(s)) {
      // Pure numeric: parenthesize the whole and append um. HFSS will treat the
      // result as unit-bearing.
      return `(${s})um`;
    }
    return `(${s})`;
  };

  // Format a value for SetVariableValue. For bare numbers attach the unit; otherwise leave as expression.
  // Identifier-to-identifier hyphens get a space around them, same as
  // in exprWithUm — HFSS's parser otherwise reads "cap_s-feed_w" as a
  // single unknown identifier and silently evaluates the whole
  // expression to 0.
  const formatVarValue = (p) => {
    const expr = spaceHyphens(ascii(resolveSynthetics(String(p.expr ?? ''))));
    const unit = unitFor(p.unit);
    const isBareNumber = /^[\d\s+\-*/.()]+$/.test(expr);
    return expr + (unit && isBareNumber ? unit : '');
  };

  // Resolve cross-section
  const w_wg = evalExpr('w_wg', paramValues);
  const w_wg_um = `${(Number.isFinite(w_wg) ? w_wg : 1.2).toFixed(4)}um`;

  // Compute the WG layer's thickness
  const wgLayer = (stack || []).find(l => l.role === 'waveguide');
  const wgLayerThickness = wgLayer ? evalExpr(wgLayer.thickness, paramValues) : evalExpr('h_wg', paramValues);
  const wg_z = Number.isFinite(wgLayerThickness) ? wgLayerThickness : 0.6;
  const wg_z_um = `${wg_z.toFixed(4)}um`;
  const wgMaterial = wgLayer ? wgLayer.material : 'lithium_tantalate';

  // Compute per-layer Z map. Walk the stack bottom-up and assign each layer a
  // (zBottom, zTop) pair. Adjacent device-role layers (waveguide/conductor/cladding)
  // share zBottom — the level's top is the max of all their thicknesses.
  // A non-device layer above the device level stacks on top of the level top.
  const isDeviceRole = (r) => r === 'waveguide' || r === 'conductor' || r === 'cladding';
  const layerZ = {}; // layer.id -> { zBottom, zTop, thickness }

  // First, find the start of the array's first device-level run, so we can pin Z=0 there.
  // Substrates BEFORE the first device level go to negative Z; everything else stacks up from there.
  let firstDeviceIdx = stack.findIndex(l => isDeviceRole(l.role));
  if (firstDeviceIdx === -1) firstDeviceIdx = stack.length;

  // Compute thickness of each layer
  const tOf = (layer) => {
    const v = evalExpr(layer.thickness, paramValues);
    return Number.isFinite(v) ? v : 1;
  };

  // Substrates below the first device level (i = 0 to firstDeviceIdx-1, which should all be substrates).
  // Stack them at negative Z, with the highest one ending at Z=0.
  let zCursor = 0;
  for (let i = firstDeviceIdx - 1; i >= 0; i--) {
    const layer = stack[i];
    const t = tOf(layer);
    layerZ[layer.id] = { zBottom: zCursor - t, zTop: zCursor, thickness: t };
    zCursor -= t;
  }

  // Now walk upward from the first device level. Group adjacent device-role layers,
  // and non-device layers each get their own Z slot above the previous level top.
  zCursor = 0;
  let i = firstDeviceIdx;
  while (i < stack.length) {
    const layer = stack[i];
    if (isDeviceRole(layer.role)) {
      // Find the run of adjacent device-role layers
      const runStart = i;
      let runEnd = i;
      while (runEnd + 1 < stack.length && isDeviceRole(stack[runEnd + 1].role)) runEnd++;
      // All layers in the run share zBottom; level top = zBottom + max thickness
      const zBottom = zCursor;
      let maxT = 0;
      for (let j = runStart; j <= runEnd; j++) {
        const t = tOf(stack[j]);
        layerZ[stack[j].id] = { zBottom, zTop: zBottom + t, thickness: t };
        if (t > maxT) maxT = t;
      }
      zCursor = zBottom + maxT;
      i = runEnd + 1;
    } else {
      const t = tOf(layer);
      layerZ[layer.id] = { zBottom: zCursor, zTop: zCursor + t, thickness: t };
      zCursor += t;
      i++;
    }
  }

  // Conductor layer: thickness from the stack (or fall back to legacy electrode_h param).
  // Used as the *default* conductor for components without an explicit conductorLayerId.
  const condLayer = (stack || []).find(l => l.role === 'conductor');
  const condThickness = condLayer
    ? evalExpr(condLayer.thickness, paramValues)
    : evalExpr('electrode_h', paramValues);
  const cond_z = Number.isFinite(condThickness) ? condThickness : 0.8;
  const cond_z_um = `${cond_z.toFixed(4)}um`;
  const condMaterial = condLayer ? condLayer.material : 'gold';

  // Substrate Z positions, bottom-up (now derived from layerZ)
  const substrateLayers = (stack || []).filter(l => l.role === 'substrate');
  const substratePositions = substrateLayers.map(layer => ({
    layer,
    z: layerZ[layer.id]?.zBottom ?? 0,
    thickness: layerZ[layer.id]?.thickness ?? 1,
  }));
  // Cladding layers: each fills the WG region (Z = its zBottom to zTop), with WGs and electrodes subtracted.
  const claddingLayers = (stack || []).filter(l => l.role === 'cladding');

  // Substrate / cladding bounding extent: device-area bbox expanded by
  // per-face padding from scene.simSetup. Pads default to 50 µm each;
  // a fallback 100×100 µm minimum protects empty scenes.
  const padXNeg = Math.max(0, parseFloat((scene.simSetup && scene.simSetup.padXNeg) ?? '50') || 0);
  const padXPos = Math.max(0, parseFloat((scene.simSetup && scene.simSetup.padXPos) ?? '50') || 0);
  const padYNeg = Math.max(0, parseFloat((scene.simSetup && scene.simSetup.padYNeg) ?? '50') || 0);
  const padYPos = Math.max(0, parseFloat((scene.simSetup && scene.simSetup.padYPos) ?? '50') || 0);
  let minX = -50, minY = -50, maxX = 50, maxY = 50;
  if (solved.length > 0) {
    // Expand transforms so repeats/displace/rotate are reflected in the
    // device bbox — otherwise a 'repeat n=1 dx=cap_s' on a conductor
    // doubles the device width but the substrate only sizes to the
    // base instance, putting the chip off-center.
    const instances = expandTransforms(solved, paramValues);
    let lx = Infinity, ly = Infinity, hx = -Infinity, hy = -Infinity;
    for (const inst of instances) {
      const w = Number.isFinite(inst.w) ? inst.w : (evalExpr(inst.w, paramValues) || 10);
      const h = Number.isFinite(inst.h) ? inst.h : (evalExpr(inst.h, paramValues) || 10);
      lx = Math.min(lx, inst.cx - w / 2);
      hx = Math.max(hx, inst.cx + w / 2);
      ly = Math.min(ly, inst.cy - h / 2);
      hy = Math.max(hy, inst.cy + h / 2);
    }
    minX = lx - padXNeg;
    maxX = hx + padXPos;
    minY = ly - padYNeg;
    maxY = hy + padYPos;
  }
  // The bb* strings are used as HFSS expressions for the substrate /
  // cladding / radiation-box footprint. Reference the chip-dimension
  // variables defined below so the user can sweep chip_x_size /
  // chip_y_size / chip_x_min / chip_y_min in HFSS to resize the chip
  // without re-exporting. The numeric defaults are baked into the
  // variable values, not these references.
  const bbXPos = `(chip_x_min)`;
  const bbYPos = `(chip_y_min)`;
  const bbXSize = `(chip_x_size)`;
  const bbYSize = `(chip_y_size)`;

  // Convert hex color string "#rrggbb" to HFSS "(r g b)" format
  const hexToHfssColor = (hex) => {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '#888888');
    if (!m) return '(136 136 136)';
    return `(${parseInt(m[1], 16)} ${parseInt(m[2], 16)} ${parseInt(m[3], 16)})`;
  };

  // Pre-flight check: scan every component for zero-or-negative dimensions and report.
  const dimWarnings = [];
  for (const c of solved) {
    const cw = evalExpr(c.w, paramValues);
    const ch = evalExpr(c.h, paramValues);
    if (!Number.isFinite(cw) || cw <= 0) dimWarnings.push(`${c.id}: w=${c.w} -> ${cw}`);
    if (!Number.isFinite(ch) || ch <= 0) dimWarnings.push(`${c.id}: h=${c.h} -> ${ch}`);
  }
  // Also check key globals
  if (!Number.isFinite(w_wg) || w_wg <= 0) dimWarnings.push(`global w_wg -> ${w_wg}`);
  if (!Number.isFinite(wg_z) || wg_z <= 0) dimWarnings.push(`global h_wg -> ${wg_z}`);

  let code = `# -*- coding: utf-8 -*-
# Auto-generated HFSS native script
# Photonic IC RF layout
# Run via HFSS: Tools -> Run Script... (Python 2.7 inside HFSS)
${dimWarnings.length > 0 ? `#
# !!! WARNING: ${dimWarnings.length} dimension(s) are zero or invalid:
${dimWarnings.map(w => `#   ${w}`).join('\n')}
# These components will be skipped. Fix the parameters and re-export.
` : ''}
import ScriptEnv
ScriptEnv.Initialize("Ansoft.ElectronicsDesktop")
oDesktop.RestoreWindow()

# --- Project / design setup ---
${appendToActive ? `# Append mode: attach to the currently active project/design instead of
# making a new one. Useful when the design already has its own setups,
# sweeps, and boundary assignments that we don't want to overwrite.
oProject = oDesktop.GetActiveProject()
if oProject is None:
    raise Exception("No active HFSS project. Open a project before running this script.")
oDesign = oProject.GetActiveDesign()
if oDesign is None:
    raise Exception("No active HFSS design. Open a design before running this script.")
oEditor = oDesign.SetActiveEditor("3D Modeler")` : `oProject = oDesktop.NewProject()
oProject.InsertDesign("HFSS", "Layout", "DrivenModal", "")
oDesign = oProject.SetActiveDesign("Layout")
oEditor = oDesign.SetActiveEditor("3D Modeler")`}

# ===== Parameters =====
# Robust variable create-or-update.
# We try multiple strategies because the working method varies across HFSS versions
# and design types (Driven Modal, Hybrid Modal Network, etc.).
def set_var(name, value):
    # Strategy 1: if variable already exists, just update it
    try:
        existing = list(oDesign.GetVariables())
    except:
        existing = []
    if name in existing:
        try:
            oDesign.SetVariableValue(name, value)
            return
        except:
            pass
    # Strategy 2: create as a new local variable via ChangeProperty (Name:NewProps form, lowercase)
    try:
        oDesign.ChangeProperty(
            ["NAME:AllTabs",
             ["NAME:LocalVariableTab",
              ["NAME:PropServers", "LocalVariables"],
              ["Name:NewProps",
               ["NAME:" + name,
                "PropType:=", "VariableProp",
                "UserDef:=", True,
                "Value:=", value]]]])
        return
    except:
        pass
    # Strategy 3: same but with NAME:NewProps (uppercase, older HFSS form)
    try:
        oDesign.ChangeProperty(
            ["NAME:AllTabs",
             ["NAME:LocalVariableTab",
              ["NAME:PropServers", "LocalVariables"],
              ["NAME:NewProps",
               ["NAME:" + name,
                "PropType:=", "VariableProp",
                "UserDef:=", True,
                "Value:=", value]]]])
        return
    except:
        pass
    # Strategy 4: project-level variable (some HFSS configurations only allow project vars)
    try:
        oProject.ChangeProperty(
            ["NAME:AllTabs",
             ["NAME:ProjectVariableTab",
              ["NAME:PropServers", "ProjectVariables"],
              ["Name:NewProps",
               ["NAME:$" + name,
                "PropType:=", "VariableProp",
                "UserDef:=", True,
                "Value:=", value]]]])
        return
    except:
        pass
    # Strategy 5: bare SetVariableValue (creates if absent in some versions)
    try:
        oDesign.SetVariableValue(name, value)
        return
    except:
        pass
    # All strategies failed; report quietly
    try:
        oDesktop.AddMessage("", "", 1, "set_var failed for: " + name)
    except:
        pass

`;
  for (const [name, p] of Object.entries(params)) {
    code += `set_var("${ascii(name)}", "${formatVarValue(p)}")\n`;
  }

  // Substrate / chip dimension variables, so the user can retune the
  // chip footprint in HFSS without re-exporting. Substrate and cladding
  // boxes (plus the air-region radiation box) reference these by name.
  // Values are the export-time numeric extents computed from the
  // device bbox + simSetup pads.
  code += `set_var("chip_x_min", "${minX.toFixed(4)}um")\n`;
  code += `set_var("chip_y_min", "${minY.toFixed(4)}um")\n`;
  code += `set_var("chip_x_size", "${(maxX - minX).toFixed(4)}um")\n`;
  code += `set_var("chip_y_size", "${(maxY - minY).toFixed(4)}um")\n`;

  // ===== Materials =====
  // HFSS doesn't ship lithium_tantalate (or any non-standard material) by default.
  // We define any unknown material via oDefinitionManager.AddMaterial before geometry creation.
  // Standard materials shipped with HFSS that we don't need to define:
  //   vacuum, air, copper, gold, aluminum, silicon, silicon_dioxide, silicon_nitride,
  //   FR4_epoxy, polyimide, Pec, Teflon_based, etc.
  const STD_MATERIALS = new Set([
    'vacuum', 'air', 'copper', 'gold', 'aluminum', 'silicon', 'silicon_dioxide',
    'silicon_nitride', 'FR4_epoxy', 'polyimide', 'Pec', 'Teflon_based',
  ]);
  // Catalog of custom materials with reasonable RF-relevant property defaults.
  const CUSTOM_MATERIALS = {
    lithium_tantalate: { eps_r: 41.4, mu_r: 1, sigma: 0, loss_tangent: 0.001 },
    lithium_niobate:   { eps_r: 28.0, mu_r: 1, sigma: 0, loss_tangent: 0.001 },
  };
  // Collect every material name actually used by this layout (layers + components).
  const usedMaterials = new Set();
  for (const layer of (stack || [])) {
    if (layer.material) usedMaterials.add(layer.material);
  }
  if (wgMaterial) usedMaterials.add(wgMaterial);
  if (condMaterial) usedMaterials.add(condMaterial);
  // Anything used but not standard and not in our catalog falls back to a generic dielectric.
  const materialsToDefine = [];
  for (const m of usedMaterials) {
    if (STD_MATERIALS.has(m)) continue;
    const props = CUSTOM_MATERIALS[m] || { eps_r: 4.0, mu_r: 1, sigma: 0, loss_tangent: 0.001 };
    materialsToDefine.push({ name: m, ...props });
  }

  if (materialsToDefine.length > 0) {
    code += `
# ===== Custom materials =====
oDefinitionManager = oProject.GetDefinitionManager()
def define_material(name, eps_r, mu_r, sigma, loss_tangent):
    # Skip if this material is already defined (HFSS will reject duplicates).
    try:
        if oDefinitionManager.DoesMaterialExist(name):
            return
    except:
        pass
    try:
        oDefinitionManager.AddMaterial(
            ["NAME:" + name,
             "CoordinateSystemType:=", "Cartesian",
             "BulkOrSurfaceType:=", 1,
             ["NAME:PhysicsTypes", "set:=", ["Electromagnetic"]],
             "permittivity:=", str(eps_r),
             "permeability:=", str(mu_r),
             "conductivity:=", str(sigma),
             "dielectric_loss_tangent:=", str(loss_tangent)])
    except Exception as e:
        try:
            oDesktop.AddMessage("", "", 1, "Failed to define material " + name + ": " + str(e))
        except:
            pass

`;
    for (const m of materialsToDefine) {
      code += `define_material("${ascii(m.name)}", ${m.eps_r}, ${m.mu_r}, ${m.sigma}, ${m.loss_tangent})\n`;
    }
  }

  code += `
# ===== Geometry helper =====
APPEND_MODE = ${appendToActive ? 'True' : 'False'}

def _delete_geom_if_exists(name):
    # In append mode, the script may be re-run against a project that
    # already contains objects with these names from a previous run.
    # HFSS would otherwise auto-rename the new objects (e.g. port1
    # becomes port1_1), leaving the old ones — with stale dimensions
    # — in place, which breaks downstream boundary references.
    if not APPEND_MODE:
        return
    # Check existence first so we don't log spurious "Abnormal script
    # termination" errors on every Delete attempt against a missing
    # object (HFSS prints to the message log even when the COM call's
    # exception is caught in Python).
    try:
        existing = list(oEditor.GetMatchedObjectName(name))
    except:
        existing = []
    if name not in existing:
        return
    try:
        oEditor.Delete(["NAME:Selections", "Selections:=", name])
    except:
        pass

def _delete_boundary_if_exists(name):
    if not APPEND_MODE:
        return
    try:
        oModule = oDesign.GetModule("BoundarySetup")
        existing = list(oModule.GetBoundaries())
    except:
        existing = []
    if name not in existing:
        return
    try:
        oModule.DeleteBoundaries(["NAME:Boundaries", name])
    except:
        pass

# Wrap CreateBox so one bad call doesn't abort the whole script.
def safe_create_box(box_params, attributes, name):
    _delete_geom_if_exists(name)
    try:
        oEditor.CreateBox(box_params, attributes)
    except Exception as e:
        try:
            oDesktop.AddMessage("", "", 1, "CreateBox failed for '" + name + "': " + str(e))
        except:
            pass

def safe_create_rectangle(rect_params, attributes, name):
    _delete_geom_if_exists(name)
    try:
        oEditor.CreateRectangle(rect_params, attributes)
    except Exception as e:
        try:
            oDesktop.AddMessage("", "", 1, "CreateRectangle failed for '" + name + "': " + str(e))
        except:
            pass

def safe_create_polyline(poly_params, attributes, name):
    _delete_geom_if_exists(name)
    try:
        oEditor.CreatePolyline(poly_params, attributes)
    except Exception as e:
        try:
            oDesktop.AddMessage("", "", 1, "CreatePolyline failed for '" + name + "': " + str(e))
        except:
            pass

# ===== Layer stack: substrates =====
`;
  // Substrate layers (Z < 0)
  for (const sp of substratePositions) {
    const id = ascii(sp.layer.id);
    const matName = ascii(sp.layer.material);
    const colorHfss = hexToHfssColor(sp.layer.color);
    code += `safe_create_box(
    ["NAME:BoxParameters",
     "XPosition:=", "${bbXPos}", "YPosition:=", "${bbYPos}", "ZPosition:=", "${sp.z.toFixed(4)}um",
     "XSize:=", "${bbXSize}", "YSize:=", "${bbYSize}", "ZSize:=", "${sp.thickness.toFixed(4)}um"],
    ["NAME:Attributes",
     "Name:=", "${id}", "Flags:=", "", "Color:=", "${colorHfss}",
     "Transparency:=", 0.5, "PartCoordinateSystem:=", "Global",
     "MaterialValue:=", "\\"${matName}\\"", "SolveInside:=", True],
    "${id}")
`;
  }

  code += `
# ===== Components =====
`;
  // Collect emitted component names so cladding can subtract them.
  // WGs are named "<id>_rib", electrodes are named "<id>".
  const emittedWgNames = [];
  const emittedElecNames = [];
  const emittedPortNames = [];
  for (const c of solved) {
    // Boolean components are emitted separately AFTER all primitives are
    // built (see the Boolean operations section below). Their operands are
    // emitted here as normal boxes; the boolean op then combines them.
    if (c.kind === 'boolean') continue;
    const cx = c.cx;
    const cy = c.cy;
    const shapeKind = c.kind || 'rect';
    const w = evalExpr(c.w, paramValues);
    const h = evalExpr(c.h, paramValues);
    if (!Number.isFinite(w) || !Number.isFinite(h)) {
      code += `# Skipped ${c.id} (could not resolve dimensions)\n`;
      continue;
    }
    if (w <= 0 || h <= 0) {
      code += `# Skipped ${c.id} (zero or negative dimensions: w=${w}, h=${h})\n`;
      continue;
    }
    const x0 = (cx - w / 2).toFixed(4);
    const y0 = (cy - h / 2).toFixed(4);
    const wStr = w.toFixed(4);
    const hStr = h.toFixed(4);
    const id = c.id.replace(/[^A-Za-z0-9_]/g, '_');

    // Non-rectangular shapes: emit as a polygonal sheet built from the
    // shape's perimeter ring, then thicken via SweepAlongVector. We
    // don't preserve parametric ties (cx, cy, r are baked numerically),
    // but the resulting geometry matches the canvas. The rib-waveguide
    // cross-section profile is only meaningful for rectangles, so for
    // non-rect waveguides we fall back to a simple polygonal slab.
    if (shapeKind !== 'rect') {
      // Build the perimeter ring at the base position. expandTransforms
      // is used so the instance carries the shape-specific numeric
      // parameters (r, rx/ry, n) and any rotation from transforms.
      const insts = expandTransforms([c], paramValues);
      const baseInst = insts[0];
      if (!baseInst) continue;
      const ring = shapeInstanceToRing(baseInst);
      // Determine Z range from the layer.
      let zBottom = 0, zSize = evalExpr('h_wg', paramValues) || 0.6;
      if (c.layer === 'electrode') {
        const boundLayer = c.conductorLayerId
          ? (stack || []).find(l => l.id === c.conductorLayerId && l.role === 'conductor')
          : null;
        const elecLayer = boundLayer || condLayer;
        if (elecLayer && layerZ[elecLayer.id]) {
          zBottom = layerZ[elecLayer.id].zBottom;
          zSize = layerZ[elecLayer.id].thickness;
        }
      } else if (c.layer === 'port') {
        // Ports are 2-D sheets — needed for lumped/wave port excitation.
        // Place at the waveguide top by default; skip the sweep so the
        // result stays a sheet instead of a slab. zSize=0 signals "no
        // sweep" to the conditional emission below.
        zBottom = evalExpr('h_wg', paramValues) || 0.6;
        zSize = 0;
      }
      const materialName = c.layer === 'waveguide'
        ? (wgLayer ? wgLayer.material : 'lithium_niobate')
        : (c.layer === 'electrode' ? 'gold'
        : (c.layer === 'port' ? 'vacuum' : 'pec'));
      // Build the points list. CreatePolyline expects a sequence of
      // PolylinePoint records.
      const ptRecords = ring.map(([px, py]) =>
        `["NAME:PLPoint", "X:=", "${px.toFixed(4)}um", "Y:=", "${py.toFixed(4)}um", "Z:=", "${zBottom.toFixed(4)}um"]`
      ).join(', ');
      const segRecords = ring.map((_, i) =>
        `["NAME:PLSegment", "SegmentType:=", "Line", "StartIndex:=", ${i}, "NoOfPoints:=", 2]`
      ).join(', ');
      // For ports (zSize=0) the closed polyline IS the final geometry —
      // a 2-D sheet usable as a port assignment. For everything else we
      // also SweepAlongVector to extrude into a 3-D body.
      const isPortSheet = (c.layer === 'port');
      code += `# ${c.id}: ${shapeKind} as polygonal ${isPortSheet ? 'sheet (port)' : 'sheet'} (tessellation = ${ring.length} verts)\n`;
      code += `try:
    _delete_geom_if_exists("${id}")
    oEditor.CreatePolyline(
        ["NAME:PolylineParameters",
         "IsPolylineCovered:=", True,
         "IsPolylineClosed:=", True,
         ["NAME:PolylinePoints", ${ptRecords}],
         ["NAME:PolylineSegments", ${segRecords}],
         ["NAME:PolylineXSection",
          "XSectionType:=", "None",
          "XSectionOrient:=", "Auto",
          "XSectionWidth:=", "0um",
          "XSectionTopWidth:=", "0um",
          "XSectionHeight:=", "0um",
          "XSectionNumSegments:=", "0",
          "XSectionBendType:=", "Corner"]],
        ["NAME:Attributes",
         "Name:=", "${id}",
         "Flags:=", "",
         "Color:=", "${isPortSheet ? '(255 100 100)' : '(200 200 200)'}",
         "Transparency:=", ${isPortSheet ? '0.5' : '0.0'},
         "PartCoordinateSystem:=", "Global",
         "MaterialValue:=", "\\"${ascii(materialName)}\\"",
         "SolveInside:=", ${c.layer === 'waveguide' ? 'True' : (isPortSheet ? 'True' : 'False')}])${isPortSheet ? '' : `
    oEditor.SweepAlongVector(
        ["NAME:Selections", "Selections:=", "${id}", "NewPartsModelFlag:=", "Model"],
        ["NAME:VectorSweepParameters",
         "DraftAngle:=", "0deg", "DraftType:=", "Round",
         "CheckFaceFaceIntersection:=", False,
         "SweepVectorX:=", "0um",
         "SweepVectorY:=", "0um",
         "SweepVectorZ:=", "${zSize.toFixed(4)}um"])`}
except Exception as e:
    try:
        oDesktop.AddMessage("", "", 1, "Failed to build ${shapeKind} ${id}: " + str(e))
    except:
        pass
`;
      if (c.layer === 'electrode') emittedElecNames.push(id);
      else if (c.layer === 'waveguide') emittedWgNames.push(id);
      else if (c.layer === 'port') emittedPortNames.push(id);
      // For racetracks: the outer ring above is the OUTER perimeter of
      // the waveguide band. We also need to subtract an INNER cylinder-
      // like body so the result is the hollow band, not a filled disc.
      if (shapeKind === 'racetrack') {
        const R = Number.isFinite(baseInst.R) ? baseInst.R : 100;
        const Ls = Number.isFinite(baseInst.L_straight) ? baseInst.L_straight : 300;
        const pE = Number.isFinite(baseInst.p) ? baseInst.p : 1;
        const wgW = Number.isFinite(baseInst.wgWidth) ? baseInst.wgWidth : 1.2;
        const centerline = buildRacetrackCenterline(R, Ls, pE);
        const { inner } = offsetCenterlineToBand(centerline, wgW / 2);
        // Apply instance rotation.
        const rotRad2 = (baseInst.rotation || 0) * Math.PI / 180;
        const ca2 = Math.cos(rotRad2), sa2 = Math.sin(rotRad2);
        const innerPts = inner.map(([lx, ly]) => [
          baseInst.cx + lx * ca2 - ly * sa2,
          baseInst.cy + lx * sa2 + ly * ca2,
        ]);
        const innerId = `${id}_hole`;
        const innerPtRecords = innerPts.map(([px, py]) =>
          `["NAME:PLPoint", "X:=", "${px.toFixed(4)}um", "Y:=", "${py.toFixed(4)}um", "Z:=", "${zBottom.toFixed(4)}um"]`
        ).join(', ');
        const innerSegRecords = innerPts.map((_, i) =>
          `["NAME:PLSegment", "SegmentType:=", "Line", "StartIndex:=", ${i}, "NoOfPoints:=", 2]`
        ).join(', ');
        code += `# ${c.id}: subtract inner of racetrack to leave hollow band\n`;
        code += `try:
    _delete_geom_if_exists("${innerId}")
    oEditor.CreatePolyline(
        ["NAME:PolylineParameters",
         "IsPolylineCovered:=", True,
         "IsPolylineClosed:=", True,
         ["NAME:PolylinePoints", ${innerPtRecords}],
         ["NAME:PolylineSegments", ${innerSegRecords}],
         ["NAME:PolylineXSection",
          "XSectionType:=", "None",
          "XSectionOrient:=", "Auto",
          "XSectionWidth:=", "0um",
          "XSectionTopWidth:=", "0um",
          "XSectionHeight:=", "0um",
          "XSectionNumSegments:=", "0",
          "XSectionBendType:=", "Corner"]],
        ["NAME:Attributes",
         "Name:=", "${innerId}",
         "Flags:=", "",
         "Color:=", "(255 200 200)",
         "Transparency:=", 0.0,
         "PartCoordinateSystem:=", "Global",
         "MaterialValue:=", "\\"vacuum\\"",
         "SolveInside:=", True])
    oEditor.SweepAlongVector(
        ["NAME:Selections", "Selections:=", "${innerId}", "NewPartsModelFlag:=", "Model"],
        ["NAME:VectorSweepParameters",
         "DraftAngle:=", "0deg", "DraftType:=", "Round",
         "CheckFaceFaceIntersection:=", False,
         "SweepVectorX:=", "0um",
         "SweepVectorY:=", "0um",
         "SweepVectorZ:=", "${zSize.toFixed(4)}um"])
    oEditor.Subtract(
        ["NAME:Selections",
         "Blank Parts:=", "${id}",
         "Tool Parts:=", "${innerId}"],
        ["NAME:SubtractParameters", "KeepOriginals:=", False])
except Exception as e:
    try:
        oDesktop.AddMessage("", "", 1, "Failed to hollow racetrack ${id}: " + str(e))
    except:
        pass
`;
      }
      continue;
    }

    // Parametric expressions (with um units) so that changing parameters in
    // HFSS actually moves geometry. Mirror targets fall back to numeric.
    const isMirrorTgt = mirrorTargetIds.has(c.id);
    const pp = parametricPos[c.id];
    const wExprUm = exprWithUm(c.w);
    const hExprUm = exprWithUm(c.h);
    const cxExprUm = (!isMirrorTgt && pp) ? exprWithUm(pp.cxExpr) : `(${cx.toFixed(4)})um`;
    const cyExprUm = (!isMirrorTgt && pp) ? exprWithUm(pp.cyExpr) : `(${cy.toFixed(4)})um`;
    const xLoExprUm = `${cxExprUm} - ${wExprUm}/2`;
    const yLoExprUm = `${cyExprUm} - ${hExprUm}/2`;

    if (c.layer === 'waveguide') {
      // Rib waveguide: a slab plus a trapezoidal rib swept along the WG axis.
      // The WG axis is whichever of w/h is longer; the perpendicular direction holds the
      // rib cross-section (slab + rib).
      const axis = (w >= h) ? 'x' : 'y';   // direction the WG runs
      const length = (axis === 'x') ? w : h;
      if (length <= 0) {
        code += `# Skipped ${c.id} (zero WG length)\n`;
        continue;
      }
      // Resolve cross-section parameters from the waveguide-role layer
      const coreW = wgLayer ? evalExpr(wgLayer.core_width || 'w_wg', paramValues) : w_wg;
      const slabH = wgLayer ? evalExpr(wgLayer.slab_height || 'h_slab', paramValues) : evalExpr('h_slab', paramValues);
      const slabW = wgLayer ? evalExpr(wgLayer.slab_width || 'w_slab', paramValues) : evalExpr('w_slab', paramValues);
      const etchAngleDeg = wgLayer ? evalExpr(wgLayer.etch_angle || 'etch_angle', paramValues) : evalExpr('etch_angle', paramValues);
      // Fallbacks for any missing/invalid values
      const safeCoreW = (Number.isFinite(coreW) && coreW > 0) ? coreW : 1.2;
      const safeSlabH = (Number.isFinite(slabH) && slabH > 0) ? slabH : 0.1;
      const safeSlabW = (Number.isFinite(slabW) && slabW > 0) ? slabW : 5.0;
      const safeAngle = (Number.isFinite(etchAngleDeg) && etchAngleDeg > 0 && etchAngleDeg <= 90) ? etchAngleDeg : 70;
      // WG layer base / total
      const wgZ = wgLayer && layerZ[wgLayer.id] ? layerZ[wgLayer.id].zBottom : 0;
      const wgT = wgLayer && layerZ[wgLayer.id] ? layerZ[wgLayer.id].thickness : (Number.isFinite(wgLayerThickness) ? wgLayerThickness : 0.6);
      // Compute rib bottom and top widths from core_width and the reference face.
      // Etch angle is measured from horizontal. tan(angle) gives rise/run, so going up
      // by ribH the sidewall moves inward by ribH/tan(angle). Slope is "outward going down"
      // since etch_angle < 90 produces a base wider than the top.
      const ribH = Math.max(0, wgT - safeSlabH);
      const tanA = Math.tan(safeAngle * Math.PI / 180);
      const inwardShift = ribH / Math.max(tanA, 1e-9);
      const widthRef = (wgLayer && wgLayer.core_width_ref === 'bottom') ? 'bottom' : 'top';
      let ribBotW, ribTopW;
      if (widthRef === 'top') {
        ribTopW = safeCoreW;
        ribBotW = safeCoreW + 2 * inwardShift;
      } else {
        ribBotW = safeCoreW;
        ribTopW = Math.max(0, safeCoreW - 2 * inwardShift);
      }

      // Parametric rib width expressions, so layer-level sweeps work (core_width,
      // slab_height, etch_angle, layer thickness). HFSS takes math expressions
      // including tan() and pi.
      const coreWExpr  = wgLayer && wgLayer.core_width  ? wgLayer.core_width  : 'w_wg';
      const layerThExpr = wgLayer && wgLayer.thickness  ? wgLayer.thickness  : 'h_wg';
      const etchExpr   = wgLayer && wgLayer.etch_angle  ? wgLayer.etch_angle  : 'etch_angle';
      // Slab height — needed both for rib width and for slab Z-size below.
      const slabHExpr = wgLayer && wgLayer.slab_height ? wgLayer.slab_height : 'h_slab';
      const slabHExprUm = exprWithUm(slabHExpr);
      // ribH * (cot(angle)) = ribH / tan(angle) — keep all in µm.
      // etch_angle is stored as an HFSS variable with "deg" units, so
      // HFSS's tan() resolves it directly (no explicit pi/180 — adding
      // that would double-convert and give a nonsense rib width).
      const inwardShiftExprUm = `((${exprWithUm(layerThExpr)} - ${slabHExprUm}) / tan(${etchExpr}))`;
      const coreWExprUm = exprWithUm(coreWExpr);
      const ribTopWExprUm = (widthRef === 'top')
        ? coreWExprUm
        : `(${coreWExprUm} - 2 * ${inwardShiftExprUm})`;
      const ribBotWExprUm = (widthRef === 'top')
        ? `(${coreWExprUm} + 2 * ${inwardShiftExprUm})`
        : coreWExprUm;

      const id = c.id.replace(/[^A-Za-z0-9_]/g, '_');
      const wgName = `${id}_wg`;
      emittedWgNames.push(`${wgName}_slab`);
      emittedWgNames.push(`${wgName}_rib`);

      // Geometry positions: WG center is (cx, cy), runs along `axis` for `length`
      const startX = (axis === 'x') ? (cx - length / 2) : cx;
      const startY = (axis === 'y') ? (cy - length / 2) : cy;
      // The slab is centered on the WG: along-axis = length, perp = slabW, at Z = wgZ
      const slabXPos = (axis === 'x') ? (cx - length / 2) : (cx - safeSlabW / 2);
      const slabYPos = (axis === 'y') ? (cy - length / 2) : (cy - safeSlabW / 2);
      const slabXSize = (axis === 'x') ? length : safeSlabW;
      const slabYSize = (axis === 'y') ? length : safeSlabW;

      // Parametric slab geometry (HFSS expressions, so parameter sweeps work).
      // The waveguide is a rectangle whose length runs along `axis`. Along the
      // axis we use the full component dimension (wExprUm or hExprUm). Perp to
      // the axis the slab spans the layer's slab_width (slabWExprUm).
      const slabWExpr = wgLayer && wgLayer.slab_width ? wgLayer.slab_width : 'w_slab';
      const slabWExprUm = exprWithUm(slabWExpr);
      const slabXPosExpr = (axis === 'x')
        ? `${cxExprUm} - ${wExprUm}/2`
        : `${cxExprUm} - ${slabWExprUm}/2`;
      const slabYPosExpr = (axis === 'y')
        ? `${cyExprUm} - ${hExprUm}/2`
        : `${cyExprUm} - ${slabWExprUm}/2`;
      const slabXSizeExpr = (axis === 'x') ? wExprUm : slabWExprUm;
      const slabYSizeExpr = (axis === 'y') ? hExprUm : slabWExprUm;

      // Emit slab as a regular box. slabHExprUm was defined above, alongside
      // the rib width expressions.
      code += `# ${c.id}: rib waveguide, axis=${axis}, length=${length.toFixed(3)}um\n`;
      code += `safe_create_box(
    ["NAME:BoxParameters",
     "XPosition:=", "${slabXPosExpr}", "YPosition:=", "${slabYPosExpr}", "ZPosition:=", "${wgZ.toFixed(4)}um",
     "XSize:=", "${slabXSizeExpr}", "YSize:=", "${slabYSizeExpr}", "ZSize:=", "${slabHExprUm}"],
    ["NAME:Attributes",
     "Name:=", "${wgName}_slab", "Flags:=", "", "Color:=", "(143 175 143)",
     "Transparency:=", 0.0, "PartCoordinateSystem:=", "Global",
     "MaterialValue:=", "\\"${ascii(wgMaterial)}\\"", "SolveInside:=", True],
    "${wgName}_slab")
`;

      // Emit rib as a swept polyline. Cross-section is a trapezoid in the plane
      // perpendicular to the axis. We place the cross-section at the START of the WG
      // and sweep along the axis by `length`.
      // Cross-section vertices (in the plane perpendicular to `axis`):
      //   bottom corners at z=wgZ+slabH, ±coreW/2 in the perpendicular direction
      //   top corners    at z=wgZ+wgT,   ±ribTopW/2 in the perpendicular direction
      const z_rib_bot = wgZ + safeSlabH;
      const z_rib_top = wgZ + wgT;
      // Z values are stack-derived and stay numeric. X/Y vertices are full
      // parametric expressions so component position and rib width parameters
      // both flow through to HFSS sweeps.
      const z_rib_bot_um = `${z_rib_bot.toFixed(4)}um`;
      const z_rib_top_um = `${z_rib_top.toFixed(4)}um`;
      // Start coordinate along the axis (one face of the swept solid)
      const startXExprUm = `${cxExprUm} - ${wExprUm}/2`;
      const startYExprUm = `${cyExprUm} - ${hExprUm}/2`;
      // Build per-vertex expression strings. We render each PLPoint with
      // string X/Y coordinates so HFSS resolves them as expressions at sim
      // time, not numeric values baked in at export.
      let ptExprs;
      if (axis === 'x') {
        // Cross-section at X = startX. Y varies with rib width; Z varies with slab/rib top.
        ptExprs = [
          { x: startXExprUm, y: `${cyExprUm} - ${ribBotWExprUm}/2`, z: z_rib_bot_um },
          { x: startXExprUm, y: `${cyExprUm} + ${ribBotWExprUm}/2`, z: z_rib_bot_um },
          { x: startXExprUm, y: `${cyExprUm} + ${ribTopWExprUm}/2`, z: z_rib_top_um },
          { x: startXExprUm, y: `${cyExprUm} - ${ribTopWExprUm}/2`, z: z_rib_top_um },
        ];
      } else {
        ptExprs = [
          { x: `${cxExprUm} - ${ribBotWExprUm}/2`, y: startYExprUm, z: z_rib_bot_um },
          { x: `${cxExprUm} + ${ribBotWExprUm}/2`, y: startYExprUm, z: z_rib_bot_um },
          { x: `${cxExprUm} + ${ribTopWExprUm}/2`, y: startYExprUm, z: z_rib_top_um },
          { x: `${cxExprUm} - ${ribTopWExprUm}/2`, y: startYExprUm, z: z_rib_top_um },
        ];
      }
      // Sweep vector — length along the axis is the component's full dimension.
      const sweepVxExpr = (axis === 'x') ? wExprUm : `(0)um`;
      const sweepVyExpr = (axis === 'y') ? hExprUm : `(0)um`;
      const sweepVzExpr = `(0)um`;

      const ptList = ptExprs.map(p =>
        `["NAME:PLPoint", "X:=", "${p.x}", "Y:=", "${p.y}", "Z:=", "${p.z}"]`
      ).join(',\n          ');

      // Polyline segments: 4 segments (4 points + closure). HFSS expects N+1 PLPoints
      // for a closed N-segment polyline (the last point repeats the first).
      const closingPt = `["NAME:PLPoint", "X:=", "${ptExprs[0].x}", "Y:=", "${ptExprs[0].y}", "Z:=", "${ptExprs[0].z}"]`;

      code += `try:
    _delete_geom_if_exists("${wgName}_rib_xsec")
    _delete_geom_if_exists("${wgName}_rib")
    oEditor.CreatePolyline(
        ["NAME:PolylineParameters",
         "IsPolylineCovered:=", True,
         "IsPolylineClosed:=", True,
         ["NAME:PolylinePoints",
          ${ptList},
          ${closingPt}],
         ["NAME:PolylineSegments",
          ["NAME:PLSegment", "SegmentType:=", "Line", "StartIndex:=", 0, "NoOfPoints:=", 2],
          ["NAME:PLSegment", "SegmentType:=", "Line", "StartIndex:=", 1, "NoOfPoints:=", 2],
          ["NAME:PLSegment", "SegmentType:=", "Line", "StartIndex:=", 2, "NoOfPoints:=", 2],
          ["NAME:PLSegment", "SegmentType:=", "Line", "StartIndex:=", 3, "NoOfPoints:=", 2]],
         ["NAME:PolylineXSection",
          "XSectionType:=", "None",
          "XSectionOrient:=", "Auto",
          "XSectionWidth:=", "0um",
          "XSectionTopWidth:=", "0um",
          "XSectionHeight:=", "0um",
          "XSectionNumSegments:=", "0",
          "XSectionBendType:=", "Corner"]],
        ["NAME:Attributes",
         "Name:=", "${wgName}_rib_xsec",
         "Flags:=", "",
         "Color:=", "(143 175 143)",
         "Transparency:=", 0.0,
         "PartCoordinateSystem:=", "Global",
         "MaterialValue:=", "\\"${ascii(wgMaterial)}\\"",
         "SolveInside:=", True])
    oEditor.SweepAlongVector(
        ["NAME:Selections", "Selections:=", "${wgName}_rib_xsec", "NewPartsModelFlag:=", "Model"],
        ["NAME:VectorSweepParameters",
         "DraftAngle:=", "0deg",
         "DraftType:=", "Round",
         "CheckFaceFaceIntersection:=", False,
         "SweepVectorX:=", "${sweepVxExpr}",
         "SweepVectorY:=", "${sweepVyExpr}",
         "SweepVectorZ:=", "${sweepVzExpr}"])
    # Rename the swept solid to the standardized rib name
    try:
        oEditor.ChangeProperty(
            ["NAME:AllTabs",
             ["NAME:Geometry3DAttributeTab",
              ["NAME:PropServers", "${wgName}_rib_xsec"],
              ["NAME:ChangedProps",
               ["NAME:Name", "Value:=", "${wgName}_rib"]]]])
    except:
        pass
except Exception as e:
    try:
        oDesktop.AddMessage("", "", 1, "Failed to build rib WG ${wgName}: " + str(e))
    except:
        pass
`;
    } else if (c.layer === 'port') {
      // Port-layer rects are emitted as 2-D sheet rectangles (axis-aligned
      // to the Z plane). HFSS uses 2-D sheets as the geometry for lumped
      // ports and wave ports — a box would not be assignable as an
      // excitation. The sheet sits at the top of the waveguide layer by
      // default; the user can move it in Z via a displace transform if
      // they want it on a different face.
      //
      // Width and Height are emitted parametrically (e.g. "(port1_w)")
      // so that a parameter sweep in HFSS resizes the port. XStart /
      // YStart use a NUMERIC center plus the same parametric half-
      // width, so the port stays centered on the original anchor when
      // the user sweeps port1_w / feed_w. ZStart is parametric in h_wg.
      //
      // Critical: the downstream lumped-port IntLine still uses pure
      // numeric coordinates (HFSS's IntLine parser silently zeroes
      // any expression with arithmetic, producing a "length zero"
      // error). Because BOTH the port's XStart "cx − port1_w/2" and
      // the IntLine's "cx_num − pw_num/2" evaluate from the same JS
      // float computation, HFSS's evaluator gives bit-identical
      // results — so "endpoints lie on the port" still passes.
      emittedPortNames.push(id);
      // Port sheet emission strategy (fully parametric):
      //   - Pre-emit two HFSS variables for the port's center. Their
      //     VALUES are the FULL parametric snap-chain expressions for
      //     the port's cx / cy, so any HFSS-side change to a snap-
      //     chain variable (e.g. feed_L, cap_s) moves the port the
      //     same way it moves on the canvas.
      //   - XStart / YStart reference those variables minus the
      //     parametric half-width: "<port_cx_var> - (port1_w)/2".
      //   - Width / Height are parametric so port1_w / feed_w sweeps
      //     resize the port symmetrically around the center.
      //   - The lumped-port IntLine is still bare numeric — HFSS's
      //     IntLine parser rejects any arithmetic. A 1-nm inward
      //     inset on each endpoint absorbs any sub-µm evaluation
      //     drift between HFSS (evaluating the parametric expression)
      //     and JS (which precomputed the numeric).
      const isMirrorTgt = mirrorTargetIds.has(c.id);
      const pp = parametricPos[c.id];
      // HFSS's expression parser can mis-parse identifiers separated
      // by a bare hyphen — e.g. "cap_s-feed_w" gets read as a single
      // (unknown) identifier rather than the subtraction "cap_s - feed_w".
      // Insert spaces around hyphens that sit between identifier
      // characters so the parser sees the binary operator.
      const spaceHyphens = (s) => String(s).replace(/(\w)-(\w)/g, '$1 - $2');
      const cxExprForVar = spaceHyphens((!isMirrorTgt && pp)
        ? exprWithUm(pp.cxExpr)
        : `${String(c.cx)}um`);
      const cyExprForVar = spaceHyphens((!isMirrorTgt && pp)
        ? exprWithUm(pp.cyExpr)
        : `${String(c.cy)}um`);
      const portZNum = String(evalExpr('h_wg', paramValues) || 0.6);
      const portWExpr = exprWithUm(c.w);  // e.g. "(port1_w)"
      const portHExpr = exprWithUm(c.h);
      const cxVar = `${id}_cx`;
      const cyVar = `${id}_cy`;
      code += `# Port anchor (parametric in the snap chain — follows feed_w / feed_L / etc.).
set_var("${cxVar}", "${cxExprForVar}")
set_var("${cyVar}", "${cyExprForVar}")
try:
    safe_create_rectangle(
        ["NAME:RectangleParameters",
         "IsCovered:=", True,
         "XStart:=", "(${cxVar}) - ${portWExpr}/2", "YStart:=", "(${cyVar}) - ${portHExpr}/2", "ZStart:=", "${portZNum}um",
         "Width:=", "${portWExpr}", "Height:=", "${portHExpr}",
         "WhichAxis:=", "Z"],
        ["NAME:Attributes",
         "Name:=", "${id}", "Flags:=", "", "Color:=", "(255 100 100)",
         "Transparency:=", 0.5, "PartCoordinateSystem:=", "Global",
         "MaterialValue:=", "\\"vacuum\\"", "SolveInside:=", True],
        "${id}")
except Exception as e:
    try:
        oDesktop.AddMessage("", "", 1, "Failed to build port sheet ${id}: " + str(e))
    except:
        pass
`;
    } else {
      emittedElecNames.push(id);
      // Pick the conductor layer this component is bound to (or fall back to default)
      const boundLayer = c.conductorLayerId
        ? (stack || []).find(l => l.id === c.conductorLayerId && l.role === 'conductor')
        : null;
      const elecLayer = boundLayer || condLayer;
      const elecZ = elecLayer && layerZ[elecLayer.id] ? layerZ[elecLayer.id].zBottom : 0;
      const elecThickness = elecLayer && layerZ[elecLayer.id] ? layerZ[elecLayer.id].thickness : cond_z;
      const elecMaterial = elecLayer ? elecLayer.material : condMaterial;
      const elecZ_um = `${elecZ.toFixed(4)}um`;
      const elecT_um = `${elecThickness.toFixed(4)}um`;
      code += `safe_create_box(
    ["NAME:BoxParameters",
     "XPosition:=", "${xLoExprUm}", "YPosition:=", "${yLoExprUm}", "ZPosition:=", "${elecZ_um}",
     "XSize:=", "${wExprUm}", "YSize:=", "${hExprUm}", "ZSize:=", "${elecT_um}"],
    ["NAME:Attributes",
     "Name:=", "${id}", "Flags:=", "", "Color:=", "(218 165 32)",
     "Transparency:=", 0.0, "PartCoordinateSystem:=", "Global",
     "MaterialValue:=", "\\"${ascii(elecMaterial)}\\"", "SolveInside:=", False],
    "${id}")
`;
    }
  }

  // ===== Apply user transforms as HFSS history operations =====
  // For each component, walk c.transforms in order and emit ONE COM call
  // per transform. The resulting HFSS modeler history mirrors the SHAPES
  // tree: CreateBox → Move → Rotate → DuplicateAlongLine etc., each as a
  // separate, editable history step. This is the HFSS-native analog of
  // the pyAEDT emitTransformChainPyAEDT used earlier.
  //
  // Parametric expressions on transform fields (e.g. dx='my_dx_var') are
  // preserved in the COM call when the expression contains identifiers,
  // so HFSS sweeps over those variables actually move the part. Pure
  // numeric expressions get baked with a 'um' / 'deg' suffix.
  //
  // CRITICAL HFSS COMPATIBILITY NOTE: oEditor.Rotate rotates about an
  // axis through the WORLD origin, not the part's center. To rotate
  // about its OWN CENTER we use a translate-rotate-translate sequence:
  // move so the pivot is at world origin, rotate about world Z, then
  // move back. Pivot coordinates are baked numerically since HFSS COM
  // has no API to query a part's current center parametrically.
  //
  // Helper: emit the chain for one component's transform list.
  // Helper: bbox-centroid (in solved-world coords) of the group named
  // `groupName`. Excludes operands consumed by booleans so a punch's tool
  // clones don't drag the centroid sideways. Returns null if the group has
  // no usable members.
  const groupCentroid = (groupName) => {
    if (!groupName) return null;
    const members = solved.filter(cc => cc.group === groupName && !cc.consumedBy);
    if (members.length === 0) return null;
    let gx = 0, gy = 0;
    for (const m of members) { gx += m.cx; gy += m.cy; }
    return { x: gx / members.length, y: gy / members.length };
  };
  const emitTransformChainHfss = (transforms, partIds, startCx, startCy, baseW, baseH, componentGroup) => {
    if (!transforms || transforms.length === 0) return;
    let curCx = startCx, curCy = startCy, curRotation = 0;
    // Active selection list. Starts as the caller's partIds, but grows
    // every time a `repeat` transform fires so that any subsequent
    // displace / rotate operates on the full cluster (original + clones)
    // rather than on just the original. Without this, e.g. a chain of
    // [repeat, rotate] would rotate only the base object and leave the
    // duplicates un-rotated, which is the opposite of what the canvas
    // shows.
    let activePartIds = [...partIds];
    let selStr = activePartIds.join(',');
    for (const t of transforms) {
      if (!t || t.enabled === false) continue;
      if (t.kind === 'displace') {
        const dxNum = evalExpr(t.dx ?? '0', paramValues);
        const dyNum = evalExpr(t.dy ?? '0', paramValues);
        if (!Number.isFinite(dxNum) || !Number.isFinite(dyNum)) continue;
        const dxExpr = (typeof t.dx === 'string' && /[A-Za-z_]/.test(t.dx)) ? ascii(t.dx) : `${dxNum.toFixed(4)}um`;
        const dyExpr = (typeof t.dy === 'string' && /[A-Za-z_]/.test(t.dy)) ? ascii(t.dy) : `${dyNum.toFixed(4)}um`;
        code += `try:
    oEditor.Move(
        ["NAME:Selections", "Selections:=", "${selStr}", "NewPartsModelFlag:=", "Model"],
        ["NAME:TranslateParameters",
         "TranslateVectorX:=", "${dxExpr}",
         "TranslateVectorY:=", "${dyExpr}",
         "TranslateVectorZ:=", "0um"])
except Exception as e:
    oDesktop.AddMessage("", "", 1, "Move failed for ${selStr}: " + str(e))
`;
        curCx += dxNum; curCy += dyNum;
      } else if (t.kind === 'rotate') {
        const angleNum = evalExpr(t.angle ?? '0', paramValues);
        if (!Number.isFinite(angleNum)) continue;
        const pivot = t.pivot || 'C';
        const angleExpr = (typeof t.angle === 'string' && /[A-Za-z_]/.test(t.angle)) ? ascii(t.angle) : `${angleNum.toFixed(4)}deg`;
        if (pivot === 'origin') {
          // World-origin rotation: a single Rotate call. Both position
          // and orientation get rotated.
          code += `try:
    oEditor.Rotate(
        ["NAME:Selections", "Selections:=", "${selStr}", "NewPartsModelFlag:=", "Model"],
        ["NAME:RotateParameters", "RotateAxis:=", "Z", "RotateAngle:=", "${angleExpr}"])
except Exception as e:
    oDesktop.AddMessage("", "", 1, "Rotate(origin) failed for ${selStr}: " + str(e))
`;
          const rad = angleNum * Math.PI / 180;
          const ca = Math.cos(rad), sa = Math.sin(rad);
          const nx = curCx * ca - curCy * sa;
          const ny = curCx * sa + curCy * ca;
          curCx = nx; curCy = ny;
          curRotation += angleNum;
        } else {
          // Pivot = 'C' (current center), 'group' (shared centroid of the
          // component's group), or a named anchor on the part's outline.
          let pivotX = curCx, pivotY = curCy;
          if (pivot === 'group') {
            const gc = groupCentroid(componentGroup);
            if (gc) { pivotX = gc.x; pivotY = gc.y; }
            // No group ⇒ fall back to part center (already initialized).
          } else if (pivot !== 'C') {
            // Resolve local anchor offset on the part's BASE w/h, then
            // rotate by curRotation (the part's accumulated rotation so far).
            const localOff = anchorLocal(pivot, baseW, baseH);
            const rad = curRotation * Math.PI / 180;
            const ca = Math.cos(rad), sa = Math.sin(rad);
            pivotX = curCx + (localOff.x * ca - localOff.y * sa);
            pivotY = curCy + (localOff.x * sa + localOff.y * ca);
          }
          // Translate-rotate-translate.
          code += `try:
    oEditor.Move(
        ["NAME:Selections", "Selections:=", "${selStr}", "NewPartsModelFlag:=", "Model"],
        ["NAME:TranslateParameters",
         "TranslateVectorX:=", "${(-pivotX).toFixed(4)}um",
         "TranslateVectorY:=", "${(-pivotY).toFixed(4)}um",
         "TranslateVectorZ:=", "0um"])
    oEditor.Rotate(
        ["NAME:Selections", "Selections:=", "${selStr}", "NewPartsModelFlag:=", "Model"],
        ["NAME:RotateParameters", "RotateAxis:=", "Z", "RotateAngle:=", "${angleExpr}"])
    oEditor.Move(
        ["NAME:Selections", "Selections:=", "${selStr}", "NewPartsModelFlag:=", "Model"],
        ["NAME:TranslateParameters",
         "TranslateVectorX:=", "${pivotX.toFixed(4)}um",
         "TranslateVectorY:=", "${pivotY.toFixed(4)}um",
         "TranslateVectorZ:=", "0um"])
except Exception as e:
    oDesktop.AddMessage("", "", 1, "Rotate(${pivot}) failed for ${selStr}: " + str(e))
`;
          const rad = angleNum * Math.PI / 180;
          const ca = Math.cos(rad), sa = Math.sin(rad);
          const dxp = curCx - pivotX;
          const dyp = curCy - pivotY;
          curCx = pivotX + dxp * ca - dyp * sa;
          curCy = pivotY + dxp * sa + dyp * ca;
          curRotation += angleNum;
        }
      } else if (t.kind === 'repeat') {
        const nNum = Math.max(0, Math.floor(evalExpr(t.n ?? '0', paramValues) || 0));
        const dxNum = evalExpr(t.dx ?? '0', paramValues);
        const dyNum = evalExpr(t.dy ?? '0', paramValues);
        if (!Number.isFinite(dxNum) || !Number.isFinite(dyNum) || nNum < 1) continue;
        const dxExpr = (typeof t.dx === 'string' && /[A-Za-z_]/.test(t.dx)) ? ascii(t.dx) : `${dxNum.toFixed(4)}um`;
        const dyExpr = (typeof t.dy === 'string' && /[A-Za-z_]/.test(t.dy)) ? ascii(t.dy) : `${dyNum.toFixed(4)}um`;
        // oEditor.DuplicateAlongLine: NumClones = n (creates n copies of
        // the selection, so total parts = n + 1).
        code += `try:
    oEditor.DuplicateAlongLine(
        ["NAME:Selections", "Selections:=", "${selStr}", "NewPartsModelFlag:=", "Model"],
        ["NAME:DuplicateToAlongLineParameters",
         "CreateNewObjects:=", True,
         "XComponent:=", "${dxExpr}",
         "YComponent:=", "${dyExpr}",
         "ZComponent:=", "0um",
         "NumClones:=", "${nNum + 1}"],
        ["NAME:Options", "DuplicateAssignments:=", False],
        ["CreateGroupsForNewObjects:=", False])
except Exception as e:
    oDesktop.AddMessage("", "", 1, "Duplicate failed for ${selStr}: " + str(e))
`;
        if (t.includeOriginal === false) {
          code += `# NOTE: 'includeOriginal=false' on canvas; HFSS keeps the original. Delete ${partIds[0]} manually if needed.\n`;
        }
        // Expand the active selection to include the clones HFSS just
        // created. DuplicateAlongLine names them `{base}_1`, `{base}_2`,
        // …, `{base}_n` for each base name in the prior selection.
        const newNames = [];
        for (const baseName of activePartIds) {
          for (let k = 1; k <= nNum; k++) {
            newNames.push(`${baseName}_${k}`);
          }
        }
        activePartIds = [...activePartIds, ...newNames];
        selStr = activePartIds.join(',');
        // Advance the tracked centroid to the centroid of the whole
        // cluster (original + clones). For a uniform line of n+1 evenly-
        // spaced copies starting at (curCx, curCy) stepping by
        // (dxNum, dyNum), the cluster centroid is offset from the original
        // by (n*dxNum/2, n*dyNum/2). A subsequent rotate-with-pivot='C'
        // therefore rotates about the cluster's centroid rather than the
        // original part's location, matching the canvas semantics.
        curCx += nNum * dxNum / 2;
        curCy += nNum * dyNum / 2;
      } else if (t.kind === 'mirror') {
        // oEditor.Mirror flips the selection across a plane defined by a
        // base point + normal vector. axis='x' ⇒ normal=(1,0,0) (mirror
        // line is vertical, parallel to Y); axis='y' ⇒ normal=(0,1,0).
        const axis = t.axis === 'y' ? 'y' : 'x';
        const pivot = t.pivot === 'origin' ? 'origin' : 'C';
        const baseX = pivot === 'origin' ? 0 : curCx;
        const baseY = pivot === 'origin' ? 0 : curCy;
        const nx = axis === 'x' ? 1 : 0;
        const ny = axis === 'y' ? 1 : 0;
        code += `try:
    oEditor.Mirror(
        ["NAME:Selections", "Selections:=", "${selStr}", "NewPartsModelFlag:=", "Model"],
        ["NAME:MirrorParameters",
         "MirrorBaseX:=", "${baseX.toFixed(4)}um",
         "MirrorBaseY:=", "${baseY.toFixed(4)}um",
         "MirrorBaseZ:=", "0um",
         "MirrorNormalX:=", "${nx}",
         "MirrorNormalY:=", "${ny}",
         "MirrorNormalZ:=", "0"])
except Exception as e:
    oDesktop.AddMessage("", "", 1, "Mirror failed for ${selStr}: " + str(e))
`;
        // Centroid invariance: mirror about own center keeps the centroid;
        // mirror about origin negates the coordinate along the axis.
        if (pivot === 'origin') {
          if (axis === 'x') curCx = -curCx;
          else curCy = -curCy;
        }
        curRotation = -curRotation;
      } else if (t.kind === 'duplicate_mirror') {
        // oEditor.DuplicateMirror emits one mirrored copy. The mirror
        // plane is placed at distance `offset` from the source center
        // along the chosen axis, so the duplicate's center lands at
        // 2·offset from the source — matching the canvas semantics.
        const axis = t.axis === 'y' ? 'y' : 'x';
        const offsetNum = evalExpr(t.offset ?? '0', paramValues);
        if (!Number.isFinite(offsetNum)) continue;
        const offsetExpr = (typeof t.offset === 'string' && /[A-Za-z_]/.test(t.offset))
          ? ascii(t.offset)
          : `${offsetNum.toFixed(4)}um`;
        // Mirror plane base point: current centroid + offset along axis.
        const baseXExpr = axis === 'x'
          ? `${curCx.toFixed(4)}um + (${offsetExpr})`
          : `${curCx.toFixed(4)}um`;
        const baseYExpr = axis === 'y'
          ? `${curCy.toFixed(4)}um + (${offsetExpr})`
          : `${curCy.toFixed(4)}um`;
        const nx = axis === 'x' ? 1 : 0;
        const ny = axis === 'y' ? 1 : 0;
        code += `try:
    oEditor.DuplicateMirror(
        ["NAME:Selections", "Selections:=", "${selStr}", "NewPartsModelFlag:=", "Model"],
        ["NAME:DuplicateToMirrorParameters",
         "DuplicateMirrorBaseX:=", "${baseXExpr}",
         "DuplicateMirrorBaseY:=", "${baseYExpr}",
         "DuplicateMirrorBaseZ:=", "0um",
         "DuplicateMirrorNormalX:=", "${nx}",
         "DuplicateMirrorNormalY:=", "${ny}",
         "DuplicateMirrorNormalZ:=", "0"],
        ["NAME:Options", "DuplicateAssignments:=", False],
        ["CreateGroupsForNewObjects:=", False])
except Exception as e:
    oDesktop.AddMessage("", "", 1, "DuplicateMirror failed for ${selStr}: " + str(e))
`;
        if (t.includeOriginal === false) {
          code += `# NOTE: 'includeOriginal=false' on canvas; HFSS keeps the original. Delete ${partIds[0]} manually if needed.\n`;
        }
        // Extend the active selection with the mirrored copies. HFSS's
        // DuplicateMirror names them `{base}_1` per base, same convention
        // as DuplicateAlongLine.
        const newNames = activePartIds.map(b => `${b}_1`);
        activePartIds = [...activePartIds, ...newNames];
        selStr = activePartIds.join(',');
        // Advance tracked centroid to the cluster centroid (midpoint of
        // source and its mirror). For axis='x' offset, the cluster's new
        // centroid is shifted by `offset` along x.
        if (axis === 'x') curCx += offsetNum;
        else curCy += offsetNum;
      }
    }
  };

  for (const c of solved) {
    if (c.kind === 'boolean') continue; // booleans handled below
    if (!c.transforms || c.transforms.length === 0) continue;
    if (!c.transforms.some(t => t && t.enabled !== false)) continue;
    const id = c.id.replace(/[^A-Za-z0-9_]/g, '_');
    // For rib-waveguide rects, both the slab and the rib are emitted
    // as separate parts (`<id>_wg_slab`, `<id>_wg_rib`). Transforms
    // need to move BOTH parts together — repeating only the rib
    // would leave the slab behind, and naming the rib `<id>_rib`
    // (without the `_wg` infix used at creation) would target a
    // part that doesn't exist.
    const partIds = (c.layer === 'waveguide' && (c.kind || 'rect') === 'rect')
      ? [`${id}_wg_slab`, `${id}_wg_rib`]
      : [id];
    const baseW = typeof c.w === 'number' ? c.w : evalExpr(c.w, paramValues);
    const baseH = typeof c.h === 'number' ? c.h : evalExpr(c.h, paramValues);
    code += `\n# ===== Transforms for ${c.id} =====\n`;
    emitTransformChainHfss(c.transforms, partIds, c.cx, c.cy, baseW || 0, baseH || 0, c.group);
  }

  // ===== Boolean operations =====
  // Boolean components (kind='boolean') in scene.components are HFSS-style
  // derived parts. After Unite/Intersect/Subtract the result keeps the
  // FIRST operand's name; we issue a Rename so the result lives under the
  // boolean component's own ID. Then we apply its OWN transforms (rotate
  // and displace) using the translate-rotate-translate idiom for "rotate
  // about own center" compatibility.
  const booleanCompsHfss = scene.components.filter(c => c.kind === 'boolean');
  if (booleanCompsHfss.length > 0) {
    code += `\n# ===== Boolean operations =====\n`;
    for (const b of booleanCompsHfss) {
      const ids = (b.operandIds || []).filter(id => solved.some(c => c.id === id));
      if (ids.length < 2) {
        code += `# Skipped ${b.id} (${b.op}) — fewer than 2 valid operands\n`;
        continue;
      }
      const safeIds = ids.map(id => id.replace(/[^A-Za-z0-9_]/g, '_'));
      const safeBoolId = b.id.replace(/[^A-Za-z0-9_]/g, '_');
      if (b.op === 'union') {
        code += `try:
    oEditor.Unite(
        ["NAME:Selections", "Selections:=", "${safeIds.join(',')}"],
        ["NAME:UniteParameters", "KeepOriginals:=", False])
except Exception as e:
    oDesktop.AddMessage("", "", 1, "Union failed: " + str(e))
`;
      } else if (b.op === 'intersect') {
        code += `try:
    oEditor.Intersect(
        ["NAME:Selections", "Selections:=", "${safeIds.join(',')}"],
        ["NAME:IntersectParameters", "KeepOriginals:=", False])
except Exception as e:
    oDesktop.AddMessage("", "", 1, "Intersect failed: " + str(e))
`;
      } else if (b.op === 'subtract') {
        code += `try:
    oEditor.Subtract(
        ["NAME:Selections", "Blank Parts:=", "${safeIds[0]}", "Tool Parts:=", "${safeIds.slice(1).join(',')}"],
        ["NAME:SubtractParameters", "KeepOriginals:=", False])
except Exception as e:
    oDesktop.AddMessage("", "", 1, "Subtract failed: " + str(e))
`;
      } else if (b.op === 'punch') {
        // The clones are consumed by the subtract; the original tools
        // live outside the boolean and were emitted as their own
        // primitives earlier — so KeepOriginals=False is correct here.
        code += `try:
    oEditor.Subtract(
        ["NAME:Selections", "Blank Parts:=", "${safeIds[0]}", "Tool Parts:=", "${safeIds.slice(1).join(',')}"],
        ["NAME:SubtractParameters", "KeepOriginals:=", False])
except Exception as e:
    oDesktop.AddMessage("", "", 1, "Punch failed: " + str(e))
`;
      }
      // Rename the surviving part (first operand's name) to the boolean's id
      // so post-boolean transforms target the right name. In append mode
      // any leftover object with the target boolean's name from a previous
      // run must be removed first — otherwise the rename fails because
      // the name is taken (HFSS would auto-suffix to something like
      // 'punch2_1' and break downstream references).
      if (safeIds[0] !== safeBoolId) {
        code += `_delete_geom_if_exists("${safeBoolId}")
try:
    oEditor.ChangeProperty(
        ["NAME:AllTabs",
         ["NAME:Geometry3DAttributeTab",
          ["NAME:PropServers", "${safeIds[0]}"],
          ["NAME:ChangedProps",
           ["NAME:Name", "Value:=", "${safeBoolId}"]]]])
except Exception as e:
    oDesktop.AddMessage("", "", 1, "Rename failed for ${safeIds[0]}: " + str(e))
`;
      }
      // Apply the boolean component's own transforms as a chain of
      // HFSS history operations using the same helper as primitives.
      const solvedB = solved.find(sc => sc.id === b.id) || b;
      const bW = typeof solvedB.w === 'number' ? solvedB.w : evalExpr(solvedB.w, paramValues);
      const bH = typeof solvedB.h === 'number' ? solvedB.h : evalExpr(solvedB.h, paramValues);
      emitTransformChainHfss(b.transforms || [], [safeBoolId], solvedB.cx, solvedB.cy, bW || 0, bH || 0, b.group);
      // ----------------------------------------------------------------
      // After the boolean: operand 0 has been renamed to the boolean's
      // id, and (for everything except 'punch' with KeepOriginals) the
      // other operands have been consumed. Reflect that in the tracked
      // primitive-name lists so downstream operations (cladding
      // subtract, port-sheet excitation) reference parts that actually
      // still exist in HFSS.
      // ----------------------------------------------------------------
      const renameInList = (list, oldName, newName) => {
        const idx = list.indexOf(oldName);
        if (idx >= 0) list[idx] = newName;
      };
      const removeFromList = (list, name) => {
        const idx = list.indexOf(name);
        if (idx >= 0) list.splice(idx, 1);
      };
      renameInList(emittedElecNames, safeIds[0], safeBoolId);
      renameInList(emittedWgNames, safeIds[0], safeBoolId);
      // Non-first operands are consumed by the subtract (and clones in
      // a punch are consumed too — they're the "Tool Parts" of the
      // KeepOriginals=False subtract).
      for (const oldId of safeIds.slice(1)) {
        removeFromList(emittedElecNames, oldId);
        removeFromList(emittedWgNames, oldId);
      }
    }
  }

  // Cladding: created LAST, then subtracts all WGs and electrodes from itself.
  // Subtraction is no-op if there's no overlap, so it's safe to subtract all of them.
  if (claddingLayers.length > 0) {
    code += `
# ===== Cladding =====
# Cladding fills the WG region (Z=0 to Z=h_wg) with the same XY footprint as the chip.
# Waveguides and electrodes are subtracted so the cladding wraps around (not through) them.
`;
    for (const layer of claddingLayers) {
      const id = ascii(layer.id);
      const matName = ascii(layer.material);
      const colorHfss = hexToHfssColor(layer.color);
      // The cladding spans the layer's own Z range from layerZ.
      const z = layerZ[layer.id];
      const cladZ = z ? z.zBottom : 0;
      const cladT = z ? z.thickness : (Number.isFinite(wgLayerThickness) ? wgLayerThickness : 0.6);
      const cladZ_um = `${cladZ.toFixed(4)}um`;
      const cladT_um = `${cladT.toFixed(4)}um`;
      code += `safe_create_box(
    ["NAME:BoxParameters",
     "XPosition:=", "${bbXPos}", "YPosition:=", "${bbYPos}", "ZPosition:=", "${cladZ_um}",
     "XSize:=", "${bbXSize}", "YSize:=", "${bbYSize}", "ZSize:=", "${cladT_um}"],
    ["NAME:Attributes",
     "Name:=", "${id}", "Flags:=", "", "Color:=", "${colorHfss}",
     "Transparency:=", 0.7, "PartCoordinateSystem:=", "Global",
     "MaterialValue:=", "\\"${matName}\\"", "SolveInside:=", True],
    "${id}")
`;
      // Subtract waveguides + electrodes (intersecting parts only) from the cladding.
      const toolNames = [...emittedWgNames, ...emittedElecNames];
      if (toolNames.length > 0) {
        const toolList = toolNames.join(',');
        code += `oEditor.Subtract(
    ["NAME:Selections", "Blank Parts:=", "${id}", "Tool Parts:=", "${toolList}"],
    ["NAME:SubtractParameters", "KeepOriginals:=", True])
`;
      }
    }
  }

  // ===== Field-plot plane =====
  // A non-model sheet at the conductor's mid-Z, spanning the chip
  // footprint. Useful as a reusable surface for plotting E/H fields,
  // currents, or any other near-field quantity at the conductor
  // plane without having to redraw a measurement surface each time.
  // Marked non-model via ChangeProperty so it doesn't perturb the
  // simulation (HFSS skips non-model objects during meshing /
  // solving).
  const condZBottom = condLayer && layerZ[condLayer.id] ? layerZ[condLayer.id].zBottom : 0;
  const condZThick  = condLayer && layerZ[condLayer.id] ? layerZ[condLayer.id].thickness : cond_z;
  const fieldPlotZ_um = `${(condZBottom + condZThick / 2).toFixed(4)}um`;
  code += `
# ===== Field-plot plane (non-model) =====
# Sheet at the conductor's mid-Z spanning the chip footprint, useful
# for plotting E/H fields, currents, etc. at the conductor plane.
# Non-model — does not participate in meshing / solving.
try:
    safe_create_rectangle(
        ["NAME:RectangleParameters",
         "IsCovered:=", True,
         "XStart:=", "${bbXPos}", "YStart:=", "${bbYPos}", "ZStart:=", "${fieldPlotZ_um}",
         "Width:=", "${bbXSize}", "Height:=", "${bbYSize}",
         "WhichAxis:=", "Z"],
        ["NAME:Attributes",
         "Name:=", "field_plot_plane", "Flags:=", "NonModel#",
         "Color:=", "(100 180 220)", "Transparency:=", 0.7,
         "PartCoordinateSystem:=", "Global",
         "MaterialValue:=", "\\"vacuum\\"", "SolveInside:=", True],
        "field_plot_plane")
    # The "NonModel#" flag in Attributes covers it on creation, but
    # belt-and-suspenders: also set Model=False via ChangeProperty so
    # older HFSS releases that ignore the Flags hint still get it.
    try:
        oEditor.ChangeProperty(
            ["NAME:AllTabs",
             ["NAME:Geometry3DAttributeTab",
              ["NAME:PropServers", "field_plot_plane"],
              ["NAME:ChangedProps",
               ["NAME:Model", "Value:=", False]]]])
    except:
        pass
except Exception as e:
    try:
        oDesktop.AddMessage("", "", 1, "Field-plot plane failed: " + str(e))
    except:
        pass
`;

  // ===== Open-region radiation boundary =====
  // Compute the airbox dimensions explicitly and emit a CreateBox +
  // AssignRadiation pair. HFSS's CreateOpenRegion isn't exposed on
  // BoundarySetup in every release, so doing it by hand keeps the
  // script portable. Padding = λ/4 at fnominal, applied to all 6
  // faces. The box wraps the chip-substrate bbox in XY (so the bbox
  // already includes the user's chip-padding) and extends from the
  // bottom of the substrate stack to the top of the highest
  // conductor/cladding layer plus the same λ/4 pad.
  const fnominalRaw = (scene.simSetup && scene.simSetup.fnominal) || '4';
  const fnominalStripped = String(fnominalRaw).trim().replace(/\s*ghz\s*$/i, '');
  const fnominalGHz = parseFloat(fnominalStripped) || 4;
  // λ (µm) = c / f. With c in µm/s (2.998e14) and f in Hz (fnominalGHz*1e9):
  //   λ (µm) = 2.998e14 / (fnominalGHz * 1e9) = 2.998e5 / fnominalGHz.
  const lambdaUm = 2.998e5 / fnominalGHz;
  // Honor the user-supplied override if present and parseable; else
  // fall back to λ/4 at fnominal.
  const airPadOverrideRaw = (scene.simSetup && scene.simSetup.airPad) || '';
  const airPadOverride = parseFloat(String(airPadOverrideRaw).trim());
  const radPadUm = Number.isFinite(airPadOverride) && airPadOverride > 0
    ? airPadOverride
    : lambdaUm / 4;
  // Z extent: from the bottom of the lowest substrate to the top of
  // the highest layer we tracked. Fall back to a generous range so the
  // box still wraps the geometry if layerZ is sparse.
  const allZBottoms = Object.values(layerZ).map(z => z.zBottom);
  const allZTops = Object.values(layerZ).map(z => z.zBottom + z.thickness);
  const sceneZMin = allZBottoms.length ? Math.min(...allZBottoms) : -260;
  const sceneZMax = allZTops.length ? Math.max(...allZTops) : 5;
  // Air-region pad as an HFSS variable too, so sweeping it adjusts
  // the radiation box without re-export. The XY footprint is anchored
  // to the chip-dimension variables (so chip_x_size sweeps grow the
  // air region symmetrically). Z stays numeric — the substrate Z is
  // fixed by the layer stack, not user-tunable on the fly.
  const airMinZ = (sceneZMin - radPadUm).toFixed(2);
  const airSizeZ = ((sceneZMax - sceneZMin) + 2 * radPadUm).toFixed(2);
  code += `set_var("air_pad", "${radPadUm.toFixed(4)}um")\n`;
  const airMinX = `(chip_x_min) - (air_pad)`;
  const airMinY = `(chip_y_min) - (air_pad)`;
  const airSizeX = `(chip_x_size) + 2 * (air_pad)`;
  const airSizeY = `(chip_y_size) + 2 * (air_pad)`;
  code += `
# ===== Open-region radiation boundary =====
# Air box padded by ~λ/4 at fnominal = ${fnominalGHz} GHz on every face
# (${Number.isFinite(airPadOverride) && airPadOverride > 0
  ? `override = ${radPadUm.toFixed(1)} um`
  : `λ/4 ≈ ${radPadUm.toFixed(1)} um`}). Created as an explicit CreateBox +
# AssignRadiation on the box's faces — more robust than calling
# CreateOpenRegion (which isn't exposed on BoundarySetup in every
# HFSS release).
try:
    safe_create_box(
        ["NAME:BoxParameters",
         "XPosition:=", "${airMinX}", "YPosition:=", "${airMinY}", "ZPosition:=", "${airMinZ}um",
         "XSize:=", "${airSizeX}", "YSize:=", "${airSizeY}", "ZSize:=", "${airSizeZ}um"],
        ["NAME:Attributes",
         "Name:=", "air_region", "Flags:=", "", "Color:=", "(180 220 240)",
         "Transparency:=", 0.85, "PartCoordinateSystem:=", "Global",
         "MaterialValue:=", "\\"vacuum\\"", "SolveInside:=", True],
        "air_region")
    try:
        _delete_boundary_if_exists("Rad_open_region")
        oBoundarySetup = oDesign.GetModule("BoundarySetup")
        # Assign the radiation boundary to the entire box object —
        # AssignRadiation supports "Objects:=" directly and HFSS picks
        # the outer faces automatically. GetFaceIDs sometimes returns
        # an unmarshallable wrapper in IronPython that breaks the
        # "Faces:=" form, so this is more portable.
        oBoundarySetup.AssignRadiation(
            ["NAME:Rad_open_region",
             "Objects:=", ["air_region"]])
    except Exception as e:
        try:
            oDesktop.AddMessage("", "", 1, "AssignRadiation failed: " + str(e))
        except:
            pass
except Exception as e:
    try:
        oDesktop.AddMessage("", "", 1, "Open region failed: " + str(e))
    except:
        pass
`;

  // ===== Lumped ports =====
  // For every port-layer component marked as a lumped port AND that
  // the adjacency detector finds flanked by electrodes, emit a
  // BoundarySetup.AssignLumpedPort call. The integration line uses the
  // port's PARAMETRIC position expressions (not numeric coords) so that
  //   (a) the endpoints land EXACTLY on the port's edges — HFSS checks
  //       "endpoints lie on the port" by direct coordinate equality
  //       and rejects the assignment if even a sub-µm numeric mismatch
  //       creeps in from rounding;
  //   (b) if the user later sweeps the port's size / position
  //       parameters in HFSS, the integration line follows.
  const lumpedPortTargets = [];
  for (const c of solved) {
    if (c.layer !== 'port' || c.kind !== 'rect') continue;
    if (!c.lumpedPort || !c.lumpedPort.enabled) continue;
    const det = detectPortIntegrationLine(c, solved, paramValues);
    if (!det.direction) continue;
    lumpedPortTargets.push({ comp: c, det });
  }
  if (lumpedPortTargets.length > 0) {
    code += `
# ===== Lumped ports =====
oBoundarySetup = oDesign.GetModule("BoundarySetup")
`;
    const portZ_um = evalExpr('h_wg', paramValues) || 0.6;
    for (const { comp, det } of lumpedPortTargets) {
      const portId = comp.id.replace(/[^A-Za-z0-9_]/g, '_');
      const portName = `LumpedPort_${portId}`;
      const impedance = (comp.lumpedPort && comp.lumpedPort.impedance) || '50';
      // IntLine endpoints are emitted as BARE numeric literals at the
      // export-time port edges (with a 1 nm inward inset to absorb
      // any sub-µm HFSS↔JS evaluation drift).
      //
      // The IntLine COM field rejects any non-literal here: variable
      // refs evaluate to 0 ("length zero"), arithmetic expressions
      // are silently treated as identifiers, and AutoIdentifyPorts
      // only works on Terminal-network designs.
      //
      // If you want the integration line to track parameter changes
      // in HFSS automatically, re-assign it once through the GUI:
      //   1. Right-click "${portName}" → Edit → Define Integration Line.
      //   2. Click the W (or N) port edge, then the opposite edge.
      // HFSS then anchors the line to those edges internally and it
      // follows the port through any subsequent parameter sweep.
      // Until you do that, re-export to refresh the IntLine after
      // changing snap-chain parameters.
      const INSET = 0.001;
      const pw = evalExpr(comp.w, paramValues);
      const ph = evalExpr(comp.h, paramValues);
      const xMin = String(comp.cx - pw / 2 + INSET);
      const xMax = String(comp.cx + pw / 2 - INSET);
      const yMin = String(comp.cy - ph / 2 + INSET);
      const yMax = String(comp.cy + ph / 2 - INSET);
      const xMid = String(comp.cx);
      const yMid = String(comp.cy);
      const zStr = String(portZ_um);
      let sX, sY, eX, eY;
      if (det.direction === 'EW') {
        sX = `${xMin}um`; sY = `${yMid}um`;
        eX = `${xMax}um`; eY = `${yMid}um`;
      } else {
        sX = `${xMid}um`; sY = `${yMin}um`;
        eX = `${xMid}um`; eY = `${yMax}um`;
      }
      const zRef = `${zStr}um`;
      // AssignLumpedPort arg structure matches HFSS's GUI-recorded
      // macro for an HFSS Modal Network design (user's mymanualtest_v2):
      //
      //   "LumpedPortType:=", "Default"    ← NOT "Modal" — that's only
      //                                       for Driven-Modal designs.
      //                                       For HFSS Modal Network
      //                                       the GUI emits "Default".
      //   "Coordinate System:=", "Global"  ← first key inside IntLine.
      //   "RenormImp:=" inside Mode block, "Impedance:=" at top level.
      //   No FullResistance / FullReactance / ShowReporterFilter /
      //   ReporterFilter — those are not in the GUI macro.
      code += `# ${portName}: integration line ${det.direction} from ${det.from} to ${det.to}.
# Arg structure mirrors HFSS's own GUI-recorded macro for an HFSS Modal
# Network lumped port. If you want the integration line to track
# parameter changes in HFSS, re-assign it once through Edit > Integration
# Line — HFSS remembers the picked edges and auto-follows.
try:
    _delete_boundary_if_exists("${portName}")
    oBoundarySetup.AssignLumpedPort(
        ["NAME:${portName}",
         "Objects:=", ["${portId}"],
         "LumpedPortType:=", "Default",
         "DoDeembed:=", False,
         ["NAME:Modes",
          ["NAME:Mode1",
           "ModeNum:=", 1,
           "UseIntLine:=", True,
           ["NAME:IntLine",
            "Coordinate System:=", "Global",
            "Start:=", ["${sX}", "${sY}", "${zRef}"],
            "End:=", ["${eX}", "${eY}", "${zRef}"]],
           "AlignmentGroup:=", 0,
           "CharImp:=", "Zpi",
           "RenormImp:=", "${impedance}ohm"]],
         "Impedance:=", "${impedance}ohm"])
except Exception as e:
    try:
        oDesktop.AddMessage("", "", 1, "Lumped port ${portName} failed: " + str(e))
    except:
        pass
`;
    }
  }
  if (!appendToActive) {
    // Fresh-project mode: install a default DrivenModal setup so the
    // generated project is immediately solvable. In append-to-active
    // mode the existing design already carries its own setups and
    // sweeps that the user wants preserved — we leave them alone.
    code += `
# ===== Setup =====
oModule = oDesign.GetModule("AnalysisSetup")
oModule.InsertSetup("HfssDriven",
    ["NAME:Setup1",
     "AdaptMultipleFreqs:=", False,
     "Frequency:=", "20GHz",
     "MaxDeltaS:=", 0.02,
     "MaximumPasses:=", 12,
     "MinimumPasses:=", 1,
     "MinimumConvergedPasses:=", 1,
     "PercentRefinement:=", 30,
     "IsEnabled:=", True])

oProject.Save()
oDesktop.AddMessage("", "", 0, "Layout built.")
`;
  } else {
    code += `
oProject.Save()
oDesktop.AddMessage("", "", 0, "Geometry appended to active design.")
`;
  }
  return code;
}
