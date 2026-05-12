// HFSS pyAEDT export.
//
// Emits a Python script that drives the Ansys pyAEDT API
// (`ansys.aedt.core`) to build the scene's geometry inside HFSS.
// Each component creates one base shape at its solved (cx, cy) with no
// rotation, then per-component transforms (displace / rotate / repeat)
// are emitted as separate pyAEDT modeler calls so the HFSS modeler's
// feature history mirrors the SHAPES tree.
//
// Extracted from PhotonicLayout.jsx as Stage 2.2 of the planned refactor.
import { evalExpr } from '../scene/params.js';
import { anchorLocal } from '../scene/anchors.js';
import { solveLayout, applyMirrors } from '../scene/solver.js';
import { shapeInstanceToRing } from '../geometry/rings.js';
import { buildRacetrackCenterline } from '../geometry/racetrack.js';

// ----------------------------------------------------------------------
// PYAEDT EXPORT
// ----------------------------------------------------------------------
export function generatePyAEDT(scene, paramValues) {
  const { params, components, snaps, mirrors } = scene;
  const solved = applyMirrors(solveLayout(components, snaps, paramValues), mirrors);

  // Sanitize a string to ASCII for safe Python source: replace common Unicode chars,
  // then drop anything still non-ASCII.
  const ascii = (s) => {
    if (typeof s !== 'string') return s;
    return s
      .replace(/µ/g, 'u')
      .replace(/[—–]/g, '-')
      .replace(/[“”]/g, '"')
      .replace(/[‘’]/g, "'")
      .replace(/×/g, 'x')
      .replace(/°/g, 'deg')
      .replace(/[^\x00-\x7F]/g, '?'); // anything else: replace with ?
  };
  // Convert a unit label to an HFSS-safe one (no Unicode)
  const unitFor = (u) => {
    if (!u) return '';
    if (u === 'µm') return 'um';
    if (u === 'deg') return 'deg';
    return ascii(u);
  };

  let code = `# -*- coding: utf-8 -*-
"""
Auto-generated pyAEDT script
Photonic IC RF layout - parametric, with WG cross-section
"""

from ansys.aedt.core import Hfss

hfss = Hfss(
    project="PhotonicIC",
    design="Layout",
    solution_type="Modal",
    new_desktop=True,
    version="2024.2",
)

# ===== Parameters =====
`;
  for (const [name, p] of Object.entries(params)) {
    const unit = unitFor(p.unit);
    const expr = ascii(String(p.expr ?? ''));
    const desc = ascii(String(p.desc ?? ''));
    // Only append the unit suffix when the expression looks like a bare number
    const isBareNumber = /^[\d\s+\-*/.()]+$/.test(expr);
    code += `hfss["${ascii(name)}"] = "${expr}${unit && isBareNumber ? unit : ''}"  # ${desc}\n`;
  }

  code += `
# ===== Substrate =====
hfss.modeler.create_box(
    origin=["-1000um", "-1000um", "-10um"],
    sizes=["2000um", "2000um", "10um"],
    name="Substrate", material="silicon_dioxide",
)

# ===== Helper: build trapezoidal rib waveguide =====
def build_wg(name, cx, cy, w, h):
    if w >= h:
        hfss.modeler.create_box(
            origin=["{0}um - {1}/2".format(cx, w), "{0}um - w_wg/2".format(cy), "0"],
            sizes=[w, "w_wg", "h_wg"], name=name + "_rib", material="lithium_niobate")
    else:
        hfss.modeler.create_box(
            origin=["{0}um - w_wg/2".format(cx), "{0}um - {1}/2".format(cy, h), "0"],
            sizes=["w_wg", h, "h_wg"], name=name + "_rib", material="lithium_niobate")

# ===== Components =====
`;
  for (const c of solved) {
    // Skip boolean components — they're handled in the booleans block below.
    if (c.kind === 'boolean') continue;
    // Skip operands that have been consumed by a boolean: they ARE emitted
    // here as primitives (so HFSS has them to combine), but we don't want
    // to double-emit if the user toggles things. consumedBy is metadata
    // only — operands always emit as boxes; the boolean op then combines them.
    const shapeKind = c.kind || 'rect';
    const baseW = evalExpr(c.w, paramValues);
    const baseH = evalExpr(c.h, paramValues);
    // Helper: emit material + thickness based on layer. Used by each
    // shape-specific creator below.
    const layerMat = c.layer === 'waveguide' ? 'lithium_niobate' : 'gold';
    const layerThk = c.layer === 'waveguide' ? 'h_wg' : 'electrode_h';

    // Emit the BASE shape at the component's solved (cx, cy) with no
    // rotation. User-applied transforms (in c.transforms) are emitted
    // AFTER as a chain of HFSS history operations — one HFSS call per
    // transform — so the modeler's feature tree mirrors the SHAPES tree.
    const id = ascii(c.id);
    const cx = c.cx.toFixed(3);
    const cy = c.cy.toFixed(3);
    if (shapeKind === 'circle') {
      const rNum = (evalExpr(c.r ?? '0', paramValues) || 0).toFixed(3);
      const zOrigin = c.layer === 'waveguide' ? '0' : 'h_wg';
      code += `hfss.modeler.create_cylinder(cs_axis="Z", origin=["${cx}um", "${cy}um", "${zOrigin}"], radius="${rNum}um", height="${layerThk}", name="${id}", material="${layerMat}")\n`;
    } else if (shapeKind === 'ellipse') {
      const rxNum = (evalExpr(c.rx ?? '0', paramValues) || 0).toFixed(3);
      const ryNum = (evalExpr(c.ry ?? '0', paramValues) || 0).toFixed(3);
      const ratio = (rxNum > 0 ? evalExpr(c.ry ?? '0', paramValues) / evalExpr(c.rx ?? '1', paramValues) : 1).toFixed(6);
      const zOrigin = c.layer === 'waveguide' ? '0' : 'h_wg';
      code += `_${id}_sheet = hfss.modeler.create_ellipse(cs_plane="XY", origin=["${cx}um", "${cy}um", "${zOrigin}"], major_radius="${rxNum}um", ratio=${ratio}, name="${id}", material="${layerMat}")\n`;
      code += `hfss.modeler.thicken_sheet("${id}", thickness="${layerThk}")\n`;
    } else if (shapeKind === 'polygon') {
      // Build the polygon vertex list from the BASE shape (no rotation).
      // We construct an "instance" with rotation=0 for shapeInstanceToRing.
      const rNum = evalExpr(c.r ?? '0', paramValues) || 0;
      const nVal = Math.max(3, Math.round(evalExpr(c.n ?? '6', paramValues) || 6));
      const baseInst = { kind: 'polygon', cx: c.cx, cy: c.cy, r: rNum, n: nVal, rotation: 0 };
      const ring = shapeInstanceToRing(baseInst);
      const zOrigin = c.layer === 'waveguide' ? '0' : 'h_wg';
      const ptsStr = ring.map(([x, y]) => `["${x.toFixed(3)}um", "${y.toFixed(3)}um", "${zOrigin}"]`).join(', ');
      code += `_${id}_sheet = hfss.modeler.create_polyline(points=[${ptsStr}], cover_surface=True, close_surface=True, name="${id}", material="${layerMat}")\n`;
      code += `hfss.modeler.thicken_sheet("${id}", thickness="${layerThk}")\n`;
    } else if (shapeKind === 'racetrack') {
      const R = evalExpr(c.R ?? '100', paramValues) || 100;
      const Ls = evalExpr(c.L_straight ?? '300', paramValues) || 300;
      const pE = Math.max(0, Math.min(1, evalExpr(c.p ?? '1', paramValues) || 1));
      const wgW = evalExpr(c.wgWidth ?? 'w_wg', paramValues) || 1.2;
      const centerline = buildRacetrackCenterline(R, Ls, pE);
      const pts = centerline.map(([lx, ly]) => [c.cx + lx, c.cy + ly]);
      const zOrigin = c.layer === 'waveguide' ? '0' : 'h_wg';
      const ptsStr = pts.map(([x, y]) => `["${x.toFixed(3)}um", "${y.toFixed(3)}um", "${zOrigin}"]`).join(', ');
      code += `# ${c.id}: racetrack (R=${R.toFixed(2)}um, L=${Ls.toFixed(2)}um, p=${pE.toFixed(3)})\n`;
      code += `_${id}_centerline = hfss.modeler.create_polyline(points=[${ptsStr}], close_surface=True, xsection_type="Rectangle", xsection_width="${wgW.toFixed(4)}um", xsection_height="${layerThk}", name="${id}", material="${layerMat}")\n`;
    } else {
      // Rectangle (default). Keep the original w/h expressions so HFSS
      // variable sweeps still drive the rect parametrically.
      const wRaw = (typeof c.w === 'string') ? ascii(c.w) : `${baseW.toFixed(3)}um`;
      const hRaw = (typeof c.h === 'string') ? ascii(c.h) : `${baseH.toFixed(3)}um`;
      if (c.layer === 'waveguide') {
        code += `build_wg("${id}", ${cx}, ${cy}, "${wRaw}", "${hRaw}")\n`;
      } else {
        code += `hfss.modeler.create_box(origin=["${cx}um - (${wRaw})/2", "${cy}um - (${hRaw})/2", "h_wg"], sizes=["${wRaw}", "${hRaw}", "electrode_h"], name="${id}", material="gold")\n`;
      }
    }

    // ===== Apply user transforms as HFSS history operations =====
    // Each enabled transform in c.transforms maps to ONE pyAEDT modeler
    // call, in chain order. The HFSS modeler tree ends up with a feature
    // history that mirrors the SHAPES tree: Box(...) → Move(...) →
    // Rotate(...) → Duplicate(...) etc. The user can scrub the history,
    // re-run individual ops, or wire transform parameters to HFSS
    // variables for sweeps.
    //
    // For waveguides (which are built as `<id>_rib` by build_wg), we
    // also need to transform the rib part. Other layers create a single
    // named part matching the id.
    const partTargets = c.layer === 'waveguide' && shapeKind === 'rect'
      ? [`${id}_rib`]
      : [id];
    // Track the part's CURRENT cx, cy in numeric form so rotation pivots
    // about its current center can be computed. We start at the solved
    // (c.cx, c.cy) and update with each displace.
    let curCx = c.cx, curCy = c.cy;
    let curRotation = 0;
    for (const t of (c.transforms || [])) {
      if (!t || t.enabled === false) continue;
      const partsStr = partTargets.map(p => `"${p}"`).join(', ');
      if (t.kind === 'displace') {
        const dxNum = evalExpr(t.dx ?? '0', paramValues);
        const dyNum = evalExpr(t.dy ?? '0', paramValues);
        if (!Number.isFinite(dxNum) || !Number.isFinite(dyNum)) continue;
        // Preserve the user's expression text when it's a simple parameter
        // reference, so HFSS sweeps over the parameter actually move the
        // part. Pure numeric expressions get a "um" suffix.
        const dxExpr = (typeof t.dx === 'string' && /[A-Za-z_]/.test(t.dx)) ? ascii(t.dx) : `${dxNum.toFixed(4)}um`;
        const dyExpr = (typeof t.dy === 'string' && /[A-Za-z_]/.test(t.dy)) ? ascii(t.dy) : `${dyNum.toFixed(4)}um`;
        code += `hfss.modeler.move([${partsStr}], ["${dxExpr}", "${dyExpr}", "0um"])\n`;
        curCx += dxNum;
        curCy += dyNum;
      } else if (t.kind === 'rotate') {
        const angleNum = evalExpr(t.angle ?? '0', paramValues);
        if (!Number.isFinite(angleNum)) continue;
        const pivot = t.pivot || 'C';
        const angleExpr = (typeof t.angle === 'string' && /[A-Za-z_]/.test(t.angle)) ? ascii(t.angle) : `${angleNum.toFixed(4)}deg`;
        if (pivot === 'origin') {
          // World-origin rotation: a single pyAEDT rotate call. Both the
          // part's position AND its orientation get rotated.
          code += `hfss.modeler.rotate([${partsStr}], "Z", "${angleExpr}")\n`;
          const rad = angleNum * Math.PI / 180;
          const ca = Math.cos(rad), sa = Math.sin(rad);
          const nx = curCx * ca - curCy * sa;
          const ny = curCx * sa + curCy * ca;
          curCx = nx; curCy = ny;
          curRotation += angleNum;
        } else {
          // Pivot is a named anchor on the part. Compute the pivot's
          // world position using the part's CURRENT center + the local
          // anchor offset (rotated by curRotation). Then emit
          // translate-rotate-translate so HFSS rotates about that pivot.
          // The intermediate numeric values bake the pivot location into
          // the export; full parametric rotation about own center isn't
          // expressible in HFSS without per-pivot bookkeeping.
          let pivotX = curCx, pivotY = curCy;
          if (pivot !== 'C') {
            // Resolve local anchor offset on the part's BASE w/h. Then
            // rotate by curRotation since the part has been rotated.
            const localOff = anchorLocal(pivot, baseW, baseH);
            const rad = curRotation * Math.PI / 180;
            const ca = Math.cos(rad), sa = Math.sin(rad);
            pivotX = curCx + (localOff.x * ca - localOff.y * sa);
            pivotY = curCy + (localOff.x * sa + localOff.y * ca);
          }
          // Translate-rotate-translate sequence.
          code += `hfss.modeler.move([${partsStr}], ["${(-pivotX).toFixed(4)}um", "${(-pivotY).toFixed(4)}um", "0um"])\n`;
          code += `hfss.modeler.rotate([${partsStr}], "Z", "${angleExpr}")\n`;
          code += `hfss.modeler.move([${partsStr}], ["${pivotX.toFixed(4)}um", "${pivotY.toFixed(4)}um", "0um"])\n`;
          // Update the running center: rotate (curCx, curCy) about (pivotX, pivotY) by angleNum.
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
        const includeOriginal = t.includeOriginal !== false;
        const dxExpr = (typeof t.dx === 'string' && /[A-Za-z_]/.test(t.dx)) ? ascii(t.dx) : `${dxNum.toFixed(4)}um`;
        const dyExpr = (typeof t.dy === 'string' && /[A-Za-z_]/.test(t.dy)) ? ascii(t.dy) : `${dyNum.toFixed(4)}um`;
        // pyAEDT's duplicate_along_line: clones = total count including
        // original. So for n duplicates plus original, clones = n + 1.
        // If includeOriginal is false, we still produce clones = n + 1
        // here and the user can manually delete the original later — full
        // "shift the original away" semantics is non-trivial in HFSS.
        code += `hfss.modeler.duplicate_along_line(${partsStr.replace(/^\[?|\]?$/g, '')}, ["${dxExpr}", "${dyExpr}", "0um"], clones=${nNum + 1})\n`;
        if (!includeOriginal) {
          code += `# NOTE: 'includeOriginal=false' on canvas duplicates the original; HFSS keeps it. Delete '${partTargets[0]}' manually if needed.\n`;
        }
      }
      // Unknown kinds silently ignored.
    }
  }

  // Helper: emit a chain of pyAEDT history operations corresponding to the
  // transform list on a component. Used for both primitive components and
  // for boolean-result components after their unite/subtract/intersect.
  // `startCx`, `startCy` describe where the part is currently sitting in
  // world coords (numeric); these are mutated as transforms accumulate so
  // rotation-about-current-center math stays correct.
  const emitTransformChainPyAEDT = (transforms, partIds, startCx, startCy, baseW, baseH) => {
    if (!transforms || transforms.length === 0) return;
    let curCx = startCx, curCy = startCy, curRotation = 0;
    const partsStr = partIds.map(p => `"${p}"`).join(', ');
    for (const t of transforms) {
      if (!t || t.enabled === false) continue;
      if (t.kind === 'displace') {
        const dxNum = evalExpr(t.dx ?? '0', paramValues);
        const dyNum = evalExpr(t.dy ?? '0', paramValues);
        if (!Number.isFinite(dxNum) || !Number.isFinite(dyNum)) continue;
        const dxExpr = (typeof t.dx === 'string' && /[A-Za-z_]/.test(t.dx)) ? ascii(t.dx) : `${dxNum.toFixed(4)}um`;
        const dyExpr = (typeof t.dy === 'string' && /[A-Za-z_]/.test(t.dy)) ? ascii(t.dy) : `${dyNum.toFixed(4)}um`;
        code += `hfss.modeler.move([${partsStr}], ["${dxExpr}", "${dyExpr}", "0um"])\n`;
        curCx += dxNum; curCy += dyNum;
      } else if (t.kind === 'rotate') {
        const angleNum = evalExpr(t.angle ?? '0', paramValues);
        if (!Number.isFinite(angleNum)) continue;
        const pivot = t.pivot || 'C';
        const angleExpr = (typeof t.angle === 'string' && /[A-Za-z_]/.test(t.angle)) ? ascii(t.angle) : `${angleNum.toFixed(4)}deg`;
        if (pivot === 'origin') {
          code += `hfss.modeler.rotate([${partsStr}], "Z", "${angleExpr}")\n`;
          const rad = angleNum * Math.PI / 180;
          const ca = Math.cos(rad), sa = Math.sin(rad);
          const nx = curCx * ca - curCy * sa;
          const ny = curCx * sa + curCy * ca;
          curCx = nx; curCy = ny;
          curRotation += angleNum;
        } else {
          let pivotX = curCx, pivotY = curCy;
          if (pivot !== 'C') {
            const localOff = anchorLocal(pivot, baseW, baseH);
            const rad = curRotation * Math.PI / 180;
            const ca = Math.cos(rad), sa = Math.sin(rad);
            pivotX = curCx + (localOff.x * ca - localOff.y * sa);
            pivotY = curCy + (localOff.x * sa + localOff.y * ca);
          }
          code += `hfss.modeler.move([${partsStr}], ["${(-pivotX).toFixed(4)}um", "${(-pivotY).toFixed(4)}um", "0um"])\n`;
          code += `hfss.modeler.rotate([${partsStr}], "Z", "${angleExpr}")\n`;
          code += `hfss.modeler.move([${partsStr}], ["${pivotX.toFixed(4)}um", "${pivotY.toFixed(4)}um", "0um"])\n`;
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
        code += `hfss.modeler.duplicate_along_line(${partsStr}, ["${dxExpr}", "${dyExpr}", "0um"], clones=${nNum + 1})\n`;
        if (t.includeOriginal === false) {
          code += `# NOTE: 'includeOriginal=false' on canvas; HFSS keeps the original. Delete ${partIds[0]} manually if needed.\n`;
        }
      }
    }
  };

  // Boolean operations applied AFTER all primitive components are created.
  // For each enabled boolean, call the matching pyAEDT modeler op. When
  // operand components have transform chains, only the BASE instance ID
  // (no _t suffix) participates — booleans on multi-instance comps would
  // need a separate strategy and aren't well-defined here.
  // Boolean components (kind='boolean') in scene.components are HFSS-style
  // derived parts. We DON'T emit them as primitives in the loop above —
  // instead, after primitives are built, we run the matching modeler op.
  // After Unite/Intersect/Subtract, the operand parts are consumed in HFSS;
  // the result keeps the FIRST operand's name (HFSS convention). To make
  // export naming consistent with the canvas, we issue a Rename so the
  // result lives under the boolean component's own ID.
  const booleanComps = scene.components.filter(c => c.kind === 'boolean');
  if (booleanComps.length > 0) {
    code += `\n# ===== Boolean operations =====\n`;
    for (const b of booleanComps) {
      const ids = (b.operandIds || []).filter(id => solved.some(c => c.id === id));
      if (ids.length < 2) continue;
      const idsStr = ids.map(id => `"${ascii(id)}"`).join(', ');
      if (b.op === 'union') code += `hfss.modeler.unite([${idsStr}])\n`;
      else if (b.op === 'intersect') code += `hfss.modeler.intersect([${idsStr}], keep_originals=False)\n`;
      else if (b.op === 'subtract') code += `hfss.modeler.subtract(blank_list=["${ascii(ids[0])}"], tool_list=[${ids.slice(1).map(id => `"${ascii(id)}"`).join(', ')}], keep_originals=False)\n`;
      else if (b.op === 'punch') code += `hfss.modeler.subtract(blank_list=["${ascii(ids[0])}"], tool_list=[${ids.slice(1).map(id => `"${ascii(id)}"`).join(', ')}], keep_originals=True)\n`;
      // Rename the surviving part (the first operand) to the boolean's id
      // so subsequent transforms target the correct name.
      if (ids[0] !== b.id) {
        code += `try:\n    hfss.modeler[${JSON.stringify(ascii(ids[0]))}].name = ${JSON.stringify(ascii(b.id))}\nexcept Exception:\n    pass\n`;
      }
      // Apply the boolean component's OWN transforms as chain history.
      // The boolean's stored cx/cy is the bbox center post-solve; we use
      // it as the starting position for the chain.
      const solvedB = solved.find(c => c.id === b.id) || b;
      const bW = typeof solvedB.w === 'number' ? solvedB.w : evalExpr(solvedB.w, paramValues);
      const bH = typeof solvedB.h === 'number' ? solvedB.h : evalExpr(solvedB.h, paramValues);
      emitTransformChainPyAEDT(b.transforms || [], [ascii(b.id)], solvedB.cx, solvedB.cy, bW || 0, bH || 0);
    }
  }

  code += `
setup = hfss.create_setup(name="Setup1")
setup.props["Frequency"] = "20GHz"
setup.props["MaximumPasses"] = 12
hfss.save_project()
print("Layout built.")
`;
  return code;
}
