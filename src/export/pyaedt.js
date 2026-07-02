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
import { evalExpr, topoSortParams } from '../scene/params.js';
import { anchorLocal } from '../scene/anchors.js';
import { solveLayout, applyMirrors } from '../scene/solver.js';
import { shapeInstanceToRing } from '../geometry/rings.js';
import { buildRacetrackCenterline } from '../geometry/racetrack.js';
import { tessellatePolylinePath, taperedBandQuads, polylineIsTapered } from '../geometry/polyline.js';
import { detectPortIntegrationLine } from '../scene/lumpedPort.js';
import { migrateStackCoplanarGroups } from '../scene/schema.js';

// ----------------------------------------------------------------------
// PYAEDT EXPORT
// ----------------------------------------------------------------------
export function generatePyAEDT(scene, paramValues) {
  const { params, components, snaps, mirrors } = scene;
  const solved = applyMirrors(solveLayout(components, snaps, paramValues), mirrors);

  // Numeric per-layer Z map (zBottom / zTop per stack layer) for via
  // emission. Same walk as the native exporter's layerZ, NUMERIC ONLY —
  // pyAEDT is the basic/convenience exporter; the native COM export
  // carries the fully parametric Z expressions. Grouping is by
  // `coplanarGroup` (members share zBottom; the group advances by its
  // cladding TOP) so it MUST stay in lockstep with hfss-native's layerZ —
  // same migrate, same group predicate, same cladding-pick — or via Z
  // spans would disagree between the two exporters.
  const numericLayerZ = (() => {
    const stack = migrateStackCoplanarGroups(scene.stack || []);
    const map = {};
    const isDev = (r) => r === 'waveguide' || r === 'conductor' || r === 'cladding';
    const tOf = (l) => {
      const v = evalExpr(l.thickness, paramValues);
      return Number.isFinite(v) ? v : 1;
    };
    // Layer whose TOP defines a coplanar group's top: the cladding (thickest if
    // several), else — malformed group with no cladding — the thickest member.
    const advanceLayerOf = (members) => {
      const clad = members.filter(m => m.role === 'cladding');
      const pool = clad.length ? clad : members;
      return pool.reduce((a, b) => (tOf(b) > tOf(a) ? b : a), pool[0]);
    };
    // Pin Z=0 at the first device-role layer OR first coplanar-group member
    // (matches hfss-native; every group carries a cladding/device member).
    let firstDev = stack.findIndex(l => isDev(l.role) || l.coplanarGroup);
    if (firstDev === -1) firstDev = stack.length;
    let z = 0;
    for (let i = firstDev - 1; i >= 0; i--) {
      const t = tOf(stack[i]);
      map[stack[i].id] = { zBottom: z - t, zTop: z };
      z -= t;
    }
    z = 0;
    let i = firstDev;
    while (i < stack.length) {
      const gid = stack[i].coplanarGroup;
      if (gid) {
        let runEnd = i;
        while (runEnd + 1 < stack.length && stack[runEnd + 1].coplanarGroup === gid) runEnd++;
        const members = [];
        for (let j = i; j <= runEnd; j++) {
          const t = tOf(stack[j]);
          map[stack[j].id] = { zBottom: z, zTop: z + t };
          members.push(stack[j]);
        }
        z += tOf(advanceLayerOf(members));
        i = runEnd + 1;
      } else {
        const t = tOf(stack[i]);
        map[stack[i].id] = { zBottom: z, zTop: z + t };
        z += t;
        i++;
      }
    }
    return map;
  })();

  // Bbox-centroid (in solved-world coords) of the group named `groupName`.
  // Used for pivot='group' rotates so every grouped member rotates about
  // the same shared centroid (matching the canvas semantics). Excludes
  // boolean-consumed operands so a punch's tool clones don't drag the
  // centroid sideways.
  const groupCentroid = (groupName) => {
    if (!groupName) return null;
    const members = solved.filter(cc => cc.group === groupName && !cc.consumedBy);
    if (members.length === 0) return null;
    let gx = 0, gy = 0;
    for (const m of members) { gx += m.cx; gy += m.cy; }
    return { x: gx / members.length, y: gy / members.length };
  };

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

# Everything below is in microns. Dimensioned variables carry an explicit
# "um", but parameter expressions may contain bare numeric literals (e.g.
# "w_slab+0.6", where 0.6 means 0.6 um). HFSS reads an additive bare literal
# in the model unit (default mm) unless we set it to um first — otherwise
# 0.6 becomes 0.6 mm and cascades into wildly wrong dimensions.
#
# Use Rescale=True, NOT the modeler.model_units property setter (which forces
# Rescale=False). AEDT's Parasolid working volume ("size box") scales with
# the model unit: relabeling a default-mm design to um WITHOUT rescaling keeps
# the box numbers but shrinks it ~1000x physically, so a lambda/4 open-region
# air box (tens of mm at RF) lands outside it -> "body lying outside the size
# box" and geometry aborts. Rescale=True relabels to um while preserving
# physical extents (and the box); it is a no-op on an already-um design.
hfss.modeler.oeditor.SetModelUnits(
    ["NAME:Units Parameter", "Units:=", "um", "Rescale:=", True])

# ===== Parameters =====
`;
  // Dependency order: pyAEDT validates each variable expression on
  // assignment, so a param referencing another must be assigned after it
  // (same constraint as HFSS-native set_var). See topoSortParams.
  for (const name of topoSortParams(params)) {
    const p = params[name];
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
  // Per-component final HFSS part-name list AFTER the inline transform
  // chain ran. Populated at the end of each iteration (operands without
  // transforms map to [baseId]). Read by the boolean section below so a
  // Subtract / Unite / Intersect lists every clone, not just the base.
  const partIdsByCompId = new Map();
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
    // Parametric root position (C8) — BASIC numeric emission: the solver
    // already applied cxExpr/cyExpr to the solved cx/cy, so the geometry
    // matches the canvas; the expressions themselves are kept live only
    // in the native COM export.
    if ((c.cxExpr != null && String(c.cxExpr).trim() !== '') || (c.cyExpr != null && String(c.cyExpr).trim() !== '')) {
      code += `# ${c.id}: position expression (cxExpr=${ascii(String(c.cxExpr ?? ''))}, cyExpr=${ascii(String(c.cyExpr ?? ''))}) baked numerically; use the native COM export for a parametric position\n`;
    }
    if (shapeKind === 'circle') {
      const rNum = (evalExpr(c.r ?? '0', paramValues) || 0).toFixed(3);
      const zOrigin = c.layer === 'waveguide' ? '0' : 'h_wg';
      code += `hfss.modeler.create_cylinder(cs_axis="Z", origin=["${cx}um", "${cy}um", "${zOrigin}"], radius="${rNum}um", height="${layerThk}", name="${id}", material="${layerMat}")\n`;
    } else if (shapeKind === 'via') {
      // Via (D4) — BASIC numeric emission: cylinder from layerFrom's
      // bottom to layerTo's top, Z values baked at export time. The
      // native COM export keeps the full Z span parametric through the
      // stack thickness expressions.
      const rNum = (evalExpr(c.r ?? '0', paramValues) || 0).toFixed(3);
      const zF = c.layerFrom ? numericLayerZ[c.layerFrom] : null;
      const zT = c.layerTo ? numericLayerZ[c.layerTo] : null;
      if (!zF || !zT || c.layerFrom === c.layerTo) {
        code += `# Skipped via ${id}: layerFrom/layerTo unresolved or identical (fix in the Inspector)\n`;
      } else {
        const zStart = zF.zBottom;
        const heightNum = zT.zTop - zF.zBottom;
        const toLayer = (scene.stack || []).find(l => l.id === c.layerTo);
        const viaMat = (toLayer && toLayer.role === 'conductor' && toLayer.material) ? ascii(toLayer.material) : 'gold';
        code += `# ${c.id}: via ${ascii(String(c.layerFrom))} -> ${ascii(String(c.layerTo))} (numeric Z span; use the native COM export for parametric stack tracking)\n`;
        code += `hfss.modeler.create_cylinder(cs_axis="Z", origin=["${cx}um", "${cy}um", "${zStart.toFixed(4)}um"], radius="${rNum}um", height="${heightNum.toFixed(4)}um", name="${id}", material="${viaMat}")\n`;
      }
    } else if (shapeKind === 'bridge') {
      // Airbridge (D7) — BASIC numeric emission: the vertical arch
      // profile (a parabola through take-off / apex / landing — the
      // numeric stand-in for the native export's 3-point NURBS spline)
      // as a covered closed polyline in the XZ plane at y = cy - W/2,
      // swept along +Y by the width. All values baked at export time;
      // use the native COM export for parametric tracking.
      const brL = evalExpr(c.length ?? '30', paramValues) || 0;
      const brW = evalExpr(c.width ?? '10', paramValues) || 0;
      const brH = evalExpr(c.height ?? '3', paramValues) || 0;
      const conductorsPy = (scene.stack || []).filter(l => l.role === 'conductor');
      const brCondL = (c.conductorLayerId && conductorsPy.find(l => l.id === c.conductorLayerId)) || conductorsPy[0] || null;
      const brZ0 = brCondL && numericLayerZ[brCondL.id] ? numericLayerZ[brCondL.id].zTop : (evalExpr('h_wg', paramValues) || 0.6);
      const tRawBr = (c.thickness != null && String(c.thickness).trim() !== '') ? c.thickness : null;
      const brTRaw = tRawBr
        ? evalExpr(tRawBr, paramValues)
        : (brCondL && numericLayerZ[brCondL.id]
            ? numericLayerZ[brCondL.id].zTop - numericLayerZ[brCondL.id].zBottom
            : evalExpr('h_cond', paramValues));
      const brT = Number.isFinite(brTRaw) ? brTRaw : 0;
      const brMatPy = brCondL ? ascii(brCondL.material) : 'gold';
      if (!(brL > 0) || !(brW > 0) || !(brH > 0)) {
        code += `# Skipped bridge ${id}: length/width/height must all evaluate > 0\n`;
      } else {
        const yPl = c.cy - brW / 2;
        const NARC = 8; // segments per arc — numeric stand-in for the NURBS
        const arcPts = (zBase) => {
          const pts = [];
          for (let k = 0; k <= NARC; k++) {
            const u = -1 + (2 * k) / NARC;
            pts.push([c.cx + (u * brL) / 2, yPl, zBase + brH * (1 - u * u)]);
          }
          return pts;
        };
        const fmtPts = (pts) => pts.map(([x, y, z]) => `["${x.toFixed(3)}um", "${y.toFixed(3)}um", "${z.toFixed(3)}um"]`).join(', ');
        code += `# ${c.id}: airbridge over "${brCondL ? ascii(brCondL.id) : '(none)'}" (numeric arch profile; use the native COM export for parametric tracking)\n`;
        code += `# Strap thickness is measured VERTICALLY (exact at landings, ~cos(slope) thinner on the flanks).\n`;
        if (Math.abs(brT) < 1e-9) {
          // Zero-thickness conductor: open centerline profile swept by
          // the width -> a curved sheet (no cover/close).
          code += `hfss.modeler.create_polyline(points=[${fmtPts(arcPts(brZ0))}], name="${id}", material="${brMatPy}")\n`;
        } else {
          const lower = arcPts(brZ0);
          const upper = arcPts(brZ0 + brT).reverse();
          code += `hfss.modeler.create_polyline(points=[${fmtPts([...lower, ...upper])}], cover_surface=True, close_surface=True, name="${id}", material="${brMatPy}")\n`;
        }
        code += `hfss.modeler.sweep_along_vector("${id}", ["0um", "${brW.toFixed(3)}um", "0um"])\n`;
      }
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
    } else if (shapeKind === 'polyshape') {
      // Closed polygon-path: emit as a covered, closed CreatePolyline →
      // a 2-D filled sheet, then thicken to the layer's thickness for
      // a 3-D body. Vertices are resolved numerically (snap-bound
      // vertices follow the target's solved position; rel vertices
      // chain from the previous one; arc vertices expand along their
      // circular arcs and spline runs interpolate with Catmull-Rom —
      // the same tessellation the canvas and GDS use). For parametric
      // vertex / arc / spline tracking through HFSS sweeps, see the
      // native-COM export.
      const compById_ps = Object.fromEntries(solved.map(cc => [cc.id, cc]));
      const verts = tessellatePolylinePath(c, compById_ps, paramValues);
      const zOrigin = c.layer === 'waveguide' ? '0' : 'h_wg';
      const ptsStr = verts.map(([x, y]) => `["${x.toFixed(3)}um", "${y.toFixed(3)}um", "${zOrigin}"]`).join(', ');
      code += `# ${c.id}: polygon-path (closed 2-D polygon → thicken_sheet; curves tessellated numerically)\n`;
      code += `_${id}_sheet = hfss.modeler.create_polyline(points=[${ptsStr}], cover_surface=True, close_surface=True, name="${id}", material="${layerMat}")\n`;
      code += `hfss.modeler.thicken_sheet("${id}", thickness="${layerThk}")\n`;
    } else if (shapeKind === 'polyline') {
      // Polyline trace — NUMERIC tessellation in the pyAEDT export
      // (arcs, splines, and per-vertex tapers are captured at export
      // values; the native-COM export is the fully parametric path
      // with AngularArc / Spline segments and parametric taper quads).
      const compById_pl = Object.fromEntries(solved.map(cc => [cc.id, cc]));
      const zOrigin = c.layer === 'waveguide' ? '0' : 'h_wg';
      if (polylineIsTapered(c)) {
        // Tapered: per-segment quads (butt joins — same band geometry
        // as the canvas / GDS / native HFSS export) emitted as covered
        // sheets, united, then thickened to the layer thickness.
        const { quads } = taperedBandQuads(c, compById_pl, paramValues);
        if (quads.length === 0) {
          code += `# ${c.id}: tapered polyline with no drawable segments — skipped\n`;
        } else {
          code += `# ${c.id}: TAPERED polyline — ${quads.length} per-segment quad sheet(s), numeric (see native export for parametric)\n`;
          const names = [];
          quads.forEach((q, k) => {
            const name = k === 0 ? id : `${id}_tseg${k}`;
            names.push(name);
            const ptsStr = [...q, q[0]].map(([x, y]) => `["${x.toFixed(3)}um", "${y.toFixed(3)}um", "${zOrigin}"]`).join(', ');
            code += `hfss.modeler.create_polyline(points=[${ptsStr}], cover_surface=True, close_surface=True, name="${name}", material="${layerMat}")\n`;
          });
          if (names.length > 1) {
            code += `hfss.modeler.unite([${names.map(n => `"${n}"`).join(', ')}])\n`;
          }
          code += `hfss.modeler.thicken_sheet("${id}", thickness="${layerThk}")\n`;
        }
      } else {
        // Constant width: tessellated centerline + rectangular
        // cross-section sweep (the racetrack idiom).
        const verts = tessellatePolylinePath(c, compById_pl, paramValues);
        const wNum = evalExpr(c.width ?? '0', paramValues) || 0;
        if (verts.length < 2 || !(wNum > 0)) {
          code += `# ${c.id}: polyline with <2 vertices or zero width — skipped\n`;
        } else {
          const ptsStr = verts.map(([x, y]) => `["${x.toFixed(3)}um", "${y.toFixed(3)}um", "${zOrigin}"]`).join(', ');
          code += `# ${c.id}: polyline trace (centerline tessellated numerically; arcs/splines expanded)\n`;
          code += `hfss.modeler.create_polyline(points=[${ptsStr}]${c.closed ? ', close_surface=True' : ''}, xsection_type="Rectangle", xsection_width="${wNum.toFixed(4)}um", xsection_height="${layerThk}", name="${id}", material="${layerMat}")\n`;
        }
      }
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
    } else if (shapeKind === 'rect' && (() => {
      const crv = c.cornerRadius != null ? evalExpr(c.cornerRadius, paramValues) : 0;
      return Number.isFinite(crv) && crv > 0;
    })()) {
      // Rounded rect (D3 corner fillet) — BASIC numeric emission: the
      // rounded perimeter ring (same tessellation as the canvas / GDS)
      // as a covered polyline, thickened to the layer. The native COM
      // export emits the fully parametric 4-Line + 4-AngularArc version.
      const crNum = evalExpr(c.cornerRadius, paramValues);
      const baseInstRR = {
        kind: 'rect', cx: c.cx, cy: c.cy, w: baseW, h: baseH,
        cornerRadius: crNum, rotation: 0,
      };
      const ringRR = shapeInstanceToRing(baseInstRR);
      const zOriginRR = c.layer === 'waveguide' ? '0' : 'h_wg';
      const ptsStrRR = ringRR.map(([x, y]) => `["${x.toFixed(3)}um", "${y.toFixed(3)}um", "${zOriginRR}"]`).join(', ');
      code += `# ${c.id}: rounded rect (cornerRadius = ${ascii(String(c.cornerRadius))}) — perimeter tessellated numerically\n`;
      code += `# (use the native COM export for parametric tangent points + AngularArc corners)\n`;
      code += `_${id}_sheet = hfss.modeler.create_polyline(points=[${ptsStrRR}], cover_surface=True, close_surface=True, name="${id}", material="${layerMat}")\n`;
      code += `hfss.modeler.thicken_sheet("${id}", thickness="${layerThk}")\n`;
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
    // Active selection list. Grows every time a `repeat` or
    // `duplicate_mirror` fires so subsequent displace / rotate operations
    // affect the whole cluster. We track the set of EXISTING names so
    // clone-name prediction matches HFSS's collision-resolution rule:
    // for source S, the new clone is `S_k` where k is the smallest
    // positive integer such that `S_k` doesn't yet exist. Critical when
    // a `duplicate_mirror` follows a `repeat` — without it the mirror
    // clone of the original gets the same name as a repeat clone,
    // corrupting the subsequent selection list.
    // Rounded rects (D3) emit as a single covered-polyline part named
    // `id` even on the waveguide layer (no `<id>_rib`), so transform
    // targets must follow suit.
    const isRoundedRectPart = shapeKind === 'rect' && (() => {
      const crv = c.cornerRadius != null ? evalExpr(c.cornerRadius, paramValues) : 0;
      return Number.isFinite(crv) && crv > 0;
    })();
    let partTargets = c.layer === 'waveguide' && shapeKind === 'rect' && !isRoundedRectPart
      ? [`${id}_rib`]
      : [id];
    const knownNamesPrim = new Set(partTargets);
    const nextCloneNamePrim = (base) => {
      let k = 1;
      while (knownNamesPrim.has(`${base}_${k}`)) k++;
      const name = `${base}_${k}`;
      knownNamesPrim.add(name);
      return name;
    };
    // Track the part's CURRENT cx, cy in numeric form so rotation pivots
    // about its current center can be computed. We start at the solved
    // (c.cx, c.cy) and update with each displace.
    let curCx = c.cx, curCy = c.cy;
    let curRotation = 0;
    // ── Per-component zOffset (D5) — BASIC numeric emission ──────────
    // pyAEDT is the convenience exporter; the native COM export keeps
    // zOffset fully parametric. Here we bake the evaluated offset as a
    // single Z move so the geometry matches the canvas/native export.
    // Vias are excluded: their Z span is fully determined by the
    // layerFrom/layerTo bindings (zOffset is never offered on vias).
    if (shapeKind !== 'via' && c.zOffset != null && String(c.zOffset).trim() !== '') {
      const zOffNum = evalExpr(c.zOffset, paramValues);
      if (Number.isFinite(zOffNum) && Math.abs(zOffNum) > 1e-12) {
        const partsStr0 = partTargets.map(p => `"${p}"`).join(', ');
        code += `# ${c.id}: zOffset = ${ascii(String(c.zOffset))} (baked numerically; use the native COM export for a parametric Z offset)\n`;
        code += `hfss.modeler.move([${partsStr0}], ["0um", "0um", "${zOffNum.toFixed(4)}um"])\n`;
      }
    }
    // ── First-class rotation (D6) — BASIC numeric emission ───────────
    // Rotate about the part's own center via translate-rotate-translate
    // (HFSS rotates about the world origin). Numeric here; the native
    // COM export emits the rotation EXPRESSION parametrically.
    if ((shapeKind === 'rect' || shapeKind === 'circle' || shapeKind === 'ellipse' || shapeKind === 'polygon' || shapeKind === 'bridge')
        && c.rotation != null && String(c.rotation).trim() !== '' && String(c.rotation).trim() !== '0') {
      const rotNum = evalExpr(c.rotation, paramValues);
      if (Number.isFinite(rotNum) && Math.abs(rotNum) > 1e-12) {
        const partsStr0 = partTargets.map(p => `"${p}"`).join(', ');
        code += `# ${c.id}: rotation = ${ascii(String(c.rotation))} deg CCW about own center (baked numerically; use the native COM export for a parametric rotation)\n`;
        code += `hfss.modeler.move([${partsStr0}], ["${(-curCx).toFixed(4)}um", "${(-curCy).toFixed(4)}um", "0um"])\n`;
        code += `hfss.modeler.rotate([${partsStr0}], "Z", "${rotNum.toFixed(4)}deg")\n`;
        code += `hfss.modeler.move([${partsStr0}], ["${curCx.toFixed(4)}um", "${curCy.toFixed(4)}um", "0um"])\n`;
      }
    }
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
          // Pivot = 'C' (current center), 'group' (group bbox centroid),
          // or a named anchor on the part. Compute the pivot's world
          // position using the part's CURRENT center + the local anchor
          // offset (rotated by curRotation). Then emit translate-rotate-
          // translate so HFSS rotates about that pivot. Intermediate
          // numeric values bake the pivot location into the export.
          let pivotX = curCx, pivotY = curCy;
          if (pivot === 'group') {
            const gc = groupCentroid(c.group);
            if (gc) { pivotX = gc.x; pivotY = gc.y; }
          } else if (pivot === 'custom') {
            // C9: explicit (px, py) world-coordinate pivot — BASIC
            // numeric emission (the native COM export keeps px/py
            // parametric).
            const pxNum = evalExpr(t.px ?? '0', paramValues);
            const pyNum = evalExpr(t.py ?? '0', paramValues);
            if (Number.isFinite(pxNum)) pivotX = pxNum;
            if (Number.isFinite(pyNum)) pivotY = pyNum;
            code += `# ${c.id}: rotate about custom pivot (px=${ascii(String(t.px ?? '0'))}, py=${ascii(String(t.py ?? '0'))}) baked numerically; use the native COM export for a parametric pivot\n`;
          } else if (pivot !== 'C') {
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
        // Expand the active selection to include the clones, using
        // HFSS's next-available-suffix naming rule (see nextCloneNamePrim).
        const newNames = [];
        for (const baseName of partTargets) {
          for (let k = 1; k <= nNum; k++) {
            newNames.push(nextCloneNamePrim(baseName));
          }
        }
        partTargets = [...partTargets, ...newNames];
        // Advance the tracked centroid to the cluster centroid so a
        // subsequent rotate-pivot='C' rotates about the full cluster's
        // center rather than the original part. See the matching note in
        // the HFSS-native exporter.
        curCx += nNum * dxNum / 2;
        curCy += nNum * dyNum / 2;
      } else if (t.kind === 'mirror') {
        // pyAEDT mirror: reflects the selection across a plane defined by
        // a base point and normal vector. axis='x' ⇒ normal=(1,0,0).
        const axis = t.axis === 'y' ? 'y' : 'x';
        const pivot = t.pivot === 'origin' ? 'origin' : 'C';
        const baseX = pivot === 'origin' ? 0 : curCx;
        const baseY = pivot === 'origin' ? 0 : curCy;
        const nx = axis === 'x' ? 1 : 0;
        const ny = axis === 'y' ? 1 : 0;
        code += `hfss.modeler.mirror([${partsStr}], [["${baseX.toFixed(4)}um", "${baseY.toFixed(4)}um", "0um"], [${nx}, ${ny}, 0]])\n`;
        if (pivot === 'origin') {
          if (axis === 'x') curCx = -curCx;
          else curCy = -curCy;
        }
        curRotation = -curRotation;
      } else if (t.kind === 'duplicate_mirror') {
        // pyAEDT duplicate_and_mirror creates one mirrored copy. We pass
        // the mirror plane as base point + normal vector. Plane base sits
        // at distance `offset` from current centroid along the chosen axis.
        const axis = t.axis === 'y' ? 'y' : 'x';
        const offsetNum = evalExpr(t.offset ?? '0', paramValues);
        if (!Number.isFinite(offsetNum)) continue;
        const offsetExpr = (typeof t.offset === 'string' && /[A-Za-z_]/.test(t.offset))
          ? ascii(t.offset)
          : `${offsetNum.toFixed(4)}um`;
        const baseXExpr = axis === 'x'
          ? `"${curCx.toFixed(4)}um + (${offsetExpr})"`
          : `"${curCx.toFixed(4)}um"`;
        const baseYExpr = axis === 'y'
          ? `"${curCy.toFixed(4)}um + (${offsetExpr})"`
          : `"${curCy.toFixed(4)}um"`;
        const nx = axis === 'x' ? 1 : 0;
        const ny = axis === 'y' ? 1 : 0;
        code += `hfss.modeler.duplicate_and_mirror([${partsStr}], [${baseXExpr}, ${baseYExpr}, "0um"], [${nx}, ${ny}, 0])\n`;
        // Extend selection with the mirrored copies, using HFSS's
        // collision-resolved naming (see nextCloneNamePrim).
        const newNames = partTargets.map(b => nextCloneNamePrim(b));
        partTargets = [...partTargets, ...newNames];
        if (axis === 'x') curCx += offsetNum;
        else curCy += offsetNum;
      }
      // Unknown kinds silently ignored.
    }
    // Record this primitive's final HFSS part-name list so the boolean
    // section below can list every clone as a Blank Part (Subtract) or
    // a Tool Part. Without this, an operand with a repeat on it would
    // only contribute its base name to the boolean op and the clones
    // would survive un-subtracted / un-united.
    partIdsByCompId.set(c.id, partTargets.slice());
  }

  // Helper: emit a chain of pyAEDT history operations corresponding to the
  // transform list on a component. Used for both primitive components and
  // for boolean-result components after their unite/subtract/intersect.
  // `startCx`, `startCy` describe where the part is currently sitting in
  // world coords (numeric); these are mutated as transforms accumulate so
  // rotation-about-current-center math stays correct.
  const emitTransformChainPyAEDT = (transforms, partIds, startCx, startCy, baseW, baseH, componentGroup) => {
    if (!transforms || transforms.length === 0) return partIds.slice();
    let curCx = startCx, curCy = startCy, curRotation = 0;
    // Active selection list. Grows after each `repeat` or
    // `duplicate_mirror` so any subsequent op affects the whole cluster.
    // Clone naming follows HFSS's collision rule (next-available suffix
    // per base) so predictions match HFSS reality — critical when a
    // mirror follows a repeat, since the naive `_1` would collide.
    let activePartIds = [...partIds];
    let partsStr = activePartIds.map(p => `"${p}"`).join(', ');
    const knownNamesBool = new Set(activePartIds);
    const nextCloneNameBool = (base) => {
      let k = 1;
      while (knownNamesBool.has(`${base}_${k}`)) k++;
      const name = `${base}_${k}`;
      knownNamesBool.add(name);
      return name;
    };
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
          if (pivot === 'group') {
            const gc = groupCentroid(componentGroup);
            if (gc) { pivotX = gc.x; pivotY = gc.y; }
          } else if (pivot === 'custom') {
            // C9: explicit (px, py) world-coordinate pivot — numeric
            // here (parametric in the native COM export).
            const pxNum = evalExpr(t.px ?? '0', paramValues);
            const pyNum = evalExpr(t.py ?? '0', paramValues);
            if (Number.isFinite(pxNum)) pivotX = pxNum;
            if (Number.isFinite(pyNum)) pivotY = pyNum;
            code += `# rotate about custom pivot (px=${ascii(String(t.px ?? '0'))}, py=${ascii(String(t.py ?? '0'))}) baked numerically; use the native COM export for a parametric pivot\n`;
          } else if (pivot !== 'C') {
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
        // Extend the active selection to include the clones the call just
        // created, using HFSS's collision-resolved naming.
        const newNames = [];
        for (const baseName of activePartIds) {
          for (let k = 1; k <= nNum; k++) {
            newNames.push(nextCloneNameBool(baseName));
          }
        }
        activePartIds = [...activePartIds, ...newNames];
        partsStr = activePartIds.map(p => `"${p}"`).join(', ');
        // Advance the tracked centroid so a subsequent rotate-pivot='C'
        // pivots about the cluster centroid, matching canvas semantics.
        curCx += nNum * dxNum / 2;
        curCy += nNum * dyNum / 2;
      } else if (t.kind === 'mirror') {
        const axis = t.axis === 'y' ? 'y' : 'x';
        const pivot = t.pivot === 'origin' ? 'origin' : 'C';
        const baseX = pivot === 'origin' ? 0 : curCx;
        const baseY = pivot === 'origin' ? 0 : curCy;
        const nx = axis === 'x' ? 1 : 0;
        const ny = axis === 'y' ? 1 : 0;
        code += `hfss.modeler.mirror([${partsStr}], [["${baseX.toFixed(4)}um", "${baseY.toFixed(4)}um", "0um"], [${nx}, ${ny}, 0]])\n`;
        if (pivot === 'origin') {
          if (axis === 'x') curCx = -curCx;
          else curCy = -curCy;
        }
        curRotation = -curRotation;
      } else if (t.kind === 'duplicate_mirror') {
        const axis = t.axis === 'y' ? 'y' : 'x';
        const offsetNum = evalExpr(t.offset ?? '0', paramValues);
        if (!Number.isFinite(offsetNum)) continue;
        const offsetExpr = (typeof t.offset === 'string' && /[A-Za-z_]/.test(t.offset))
          ? ascii(t.offset)
          : `${offsetNum.toFixed(4)}um`;
        const baseXExpr = axis === 'x'
          ? `"${curCx.toFixed(4)}um + (${offsetExpr})"`
          : `"${curCx.toFixed(4)}um"`;
        const baseYExpr = axis === 'y'
          ? `"${curCy.toFixed(4)}um + (${offsetExpr})"`
          : `"${curCy.toFixed(4)}um"`;
        const nx = axis === 'x' ? 1 : 0;
        const ny = axis === 'y' ? 1 : 0;
        code += `hfss.modeler.duplicate_and_mirror([${partsStr}], [${baseXExpr}, ${baseYExpr}, "0um"], [${nx}, ${ny}, 0])\n`;
        const newNames = activePartIds.map(b => nextCloneNameBool(b));
        activePartIds = [...activePartIds, ...newNames];
        partsStr = activePartIds.map(p => `"${p}"`).join(', ');
        if (axis === 'x') curCx += offsetNum;
        else curCy += offsetNum;
      }
    }
    // Return the final selection list so callers can record the post-
    // transform part names (e.g. so a downstream boolean that consumes
    // this object knows about all the clones, not just the base).
    return activePartIds;
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
      // For each operand, the full list of HFSS part names after its
      // inline transform chain ran (operand with repeat n=3 → 4 names).
      // Falls back to the bare id when partIdsByCompId has no entry
      // (operand was skipped during the primitive loop — degenerate).
      const partListsByOp = ids.map(opId =>
        partIdsByCompId.get(opId) || [ascii(opId)]
      );
      const baseParts = partListsByOp[0];
      const toolParts = partListsByOp.slice(1).flat();
      const allPartsStr = [...baseParts, ...toolParts].map(p => `"${p}"`).join(', ');
      const baseStr = baseParts.map(p => `"${p}"`).join(', ');
      const toolStr = toolParts.map(p => `"${p}"`).join(', ');
      let resultParts;
      if (b.op === 'union') {
        code += `hfss.modeler.unite([${allPartsStr}])\n`;
        // Unite collapses N selections into one with the first's name.
        resultParts = [baseParts[0]];
      } else if (b.op === 'intersect') {
        code += `hfss.modeler.intersect([${allPartsStr}], keep_originals=False)\n`;
        resultParts = [baseParts[0]];
      } else if (b.op === 'subtract') {
        code += `hfss.modeler.subtract(blank_list=[${baseStr}], tool_list=[${toolStr}], keep_originals=False)\n`;
        // Subtract on N blanks → N parts (each blank gets the tools
        // subtracted; original names preserved).
        resultParts = baseParts.slice();
      } else if (b.op === 'punch') {
        // Punch: the tool clones are themselves consumed by the subtract.
        // The original tools live outside the boolean as fully independent
        // primitives — they're emitted on their own. So we want
        // keep_originals=False here (the clones are gone after the op).
        code += `hfss.modeler.subtract(blank_list=[${baseStr}], tool_list=[${toolStr}], keep_originals=False)\n`;
        resultParts = baseParts.slice();
      }
      // Rename only when ONE part survives. Multi-blank subtract leaves
      // every blank under its original cloned name; renaming them all to
      // one boolean id would collide.
      const renameTarget = resultParts && resultParts.length === 1 ? resultParts[0] : null;
      if (renameTarget && renameTarget !== ascii(b.id)) {
        code += `try:\n    hfss.modeler[${JSON.stringify(renameTarget)}].name = ${JSON.stringify(ascii(b.id))}\nexcept Exception:\n    pass\n`;
        resultParts = [ascii(b.id)];
      } else if (!renameTarget && resultParts && resultParts.length > 1) {
        code += `# NOTE: ${ascii(b.id)} (${b.op}) — operand "${ids[0]}" had a transform chain producing ${resultParts.length} parts (${resultParts.join(', ')}). pyAEDT Subtract on multiple blanks leaves them under their cloned names; boolean id ${ascii(b.id)} is not assigned to a single part.\n`;
      }
      // Apply the boolean component's OWN transforms as chain history.
      // Targets the full result-parts list so a transform applied to the
      // boolean as a whole moves every surviving piece together.
      const solvedB = solved.find(c => c.id === b.id) || b;
      const bW = typeof solvedB.w === 'number' ? solvedB.w : evalExpr(solvedB.w, paramValues);
      const bH = typeof solvedB.h === 'number' ? solvedB.h : evalExpr(solvedB.h, paramValues);
      const finalBoolPartIds = emitTransformChainPyAEDT(b.transforms || [], resultParts || [ascii(b.id)], solvedB.cx, solvedB.cy, bW || 0, bH || 0, b.group);
      // Record this boolean's POST-transform part list so a downstream
      // boolean that consumes it picks up every clone. Without this, a
      // subtract(boolean-with-repeat, …) would only list the base name
      // in blank_list and the repeat clones would survive un-cut.
      partIdsByCompId.set(b.id, finalBoolPartIds || resultParts || [ascii(b.id)]);
    }
  }

  // Open-region radiation boundary, sized automatically by pyAEDT
  // based on the nominal frequency from scene.simSetup. Padding is
  // ~λ/4 at this frequency.
  const fnominalRaw = (scene.simSetup && scene.simSetup.fnominal) || '4';
  const fnominalStripped = String(fnominalRaw).trim().replace(/\s*ghz\s*$/i, '');
  const fnominalExpr = `${fnominalStripped}GHz`;
  code += `
# ===== Open-region radiation boundary =====
try:
    hfss[\"f_open_region\"] = \"${fnominalExpr}\"
except Exception:
    pass
try:
    hfss.create_open_region(frequency=\"f_open_region\", boundary=\"Radiation\")
except Exception as e:
    print(\"Open region failed:\", e)
`;

  // ===== Lumped ports =====
  const portZ_um = evalExpr('h_wg', paramValues) || 0.6;
  for (const c of solved) {
    if (c.layer !== 'port' || c.kind !== 'rect') continue;
    if (!c.lumpedPort || !c.lumpedPort.enabled) continue;
    const det = detectPortIntegrationLine(c, solved, paramValues);
    if (!det.direction) continue;
    const portId = c.id;
    const impedance = (c.lumpedPort && c.lumpedPort.impedance) || '50';
    let s, e;
    if (det.direction === 'EW') {
      s = [det.line.startX, det.line.midY, portZ_um];
      e = [det.line.endX, det.line.midY, portZ_um];
    } else {
      s = [det.line.midX, det.line.startY, portZ_um];
      e = [det.line.midX, det.line.endY, portZ_um];
    }
    code += `try:
    hfss.lumped_port(assignment=\"${portId}\", reference=None, name=\"LumpedPort_${portId}\",
                     integration_line=[[${s[0].toFixed(4)}, ${s[1].toFixed(4)}, ${s[2].toFixed(4)}],
                                        [${e[0].toFixed(4)}, ${e[1].toFixed(4)}, ${e[2].toFixed(4)}]],
                     impedance=${impedance})
except Exception as e:
    print(\"Lumped port ${portId} failed:\", e)
`;
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
