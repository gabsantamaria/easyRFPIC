// gdsfactory export.
//
// Emit a parametric `@gf.cell` Python function. Every scene parameter
// becomes a keyword argument (defaulted to its current canvas value);
// shape dimensions reference the args directly so calling the function
// with overrides actually changes the geometry.
//
// Trade-offs (documented at the top of the generated file too):
//   - Rectangles: fully parametric — position, size, rotation all
//     reference the function's kwargs. Sweep any param in Python and
//     the rect resizes / repositions.
//   - Circles / ellipses / regular polygons: parametric position
//     and size (r, rx, ry, n); tessellation is done at runtime in
//     Python using math.cos / math.sin.
//   - Racetracks: tessellated NUMERICALLY at export time (Euler-bend
//     centerline math is too heavy to inline). Re-export if the
//     racetrack params change.
//   - Booleans: each operand is emitted as a polygon on its layer,
//     plus a comment block pointing the user at `gdstk.boolean` /
//     `gf.geometry.boolean` for downstream merging. No automatic
//     boolean expansion (kept simple; user can call gdstk themselves).
//   - Transform-chain clones (repeat / mirror / duplicate_mirror):
//     positions baked numerically per instance — a `for k in range(N)`
//     loop would let the user sweep N, but mirror / pivot math makes
//     a fully parametric loop unreadable. Sweep dimensions; re-export
//     for layout-topology changes.
//
// Layer mapping mirrors the GDS-II exporter (waveguide=1, conductors
// 10+, port=100) so the generated script's output GDS is layer-
// compatible with the binary GDS export.
import { evalExpr, tokenizeIdents, RESERVED_IDENTS } from '../scene/params.js';
import { isNonModelComponent } from '../scene/schema.js';
import { solveLayout, applyMirrors } from '../scene/solver.js';
import { expandTransforms } from '../scene/transforms.js';
import { shapeInstanceToRing } from '../geometry/rings.js';
import { buildRacetrackCenterline, offsetCenterlineToBand } from '../geometry/racetrack.js';
import { tessellatePolylinePath, taperedBandQuads } from '../geometry/polyline.js';
import { computeParametricPositions } from './hfss-native.js';
import { viaGdsLayerMap } from './gds.js';
import { effectiveConductorLayerId } from '../scene/conductor-binding.js';

// ── Expression translation: HFSS-style → Python-style ────────────────
// computeParametricPositions emits expressions for HFSS, which means:
//   - Bare numerics carry a "um" suffix ("20um", "(50um)")
//   - Math functions are bare ("sin(x)", "cos(x)")
//   - Identifiers (param names) are bare
// Python wants:
//   - No "um" suffix (we're in µm by convention)
//   - Math functions as "math.sin", "math.cos", "math.sqrt", …
//   - Param names referenced directly as function args
// Translate by stripping "um" tags and prefixing known math fns with
// "math.". The output is safe to embed in a Python expression.
const MATH_FNS = new Set([
  'sin','cos','tan','asin','acos','atan','atan2','sqrt','exp',
  'log','log10','abs','floor','ceil','round','pow','min','max',
]);
function exprToPython(expr) {
  if (typeof expr === 'number') return String(expr);
  if (expr == null) return '0';
  let s = String(expr);
  // Strip HFSS "um" unit tags. The pattern matches "<digit-or-)>um" so
  // bare identifiers like "_um_something" aren't touched.
  s = s.replace(/(\d|\))\s*um\b/g, '$1');
  // HFSS degree-typed angle terms (first-class rotation emits
  // "(<expr>)*1deg" / "<n>deg"): convert the deg tag to a radian factor
  // so Python's math.cos/math.sin get radians.
  //   "30deg"        → "(30*math.pi/180)"
  //   "(tilt)*1deg"  → "(tilt)*(1*math.pi/180)"
  // NOTE: emit the numeric radian factor (NOT "math.pi") — the bare-pi
  // pass below would re-match the "pi" inside a freshly-inserted
  // "math.pi" and garble it into "math.math.pi" (runtime AttributeError).
  s = s.replace(/(\d+(?:\.\d+)?)\s*deg\b/g, '($1*3.141592653589793/180)');
  // Prefix known math fns with "math." (only when followed by "(")
  // so a param literally named "sin" — unlikely but possible — wouldn't
  // get rewritten.
  s = s.replace(/\b([A-Za-z_]+)\s*\(/g, (m, fn) => {
    if (MATH_FNS.has(fn)) return `math.${fn}(`;
    return m;
  });
  // pi / PI: math.pi.
  s = s.replace(/\b(?:pi|PI)\b/g, 'math.pi');
  // Trim doubled spaces from any "x - y" expansions HFSS added.
  s = s.replace(/\s{2,}/g, ' ').trim();
  return s;
}

// Sanitize an identifier for use as a Python kwarg / variable name.
// Replaces non-word chars with underscore; prefixes a leading digit
// with underscore. Keeps the original name when it's already valid.
function pyIdent(name) {
  const s = String(name || '').trim();
  if (!s) return '_anon';
  let out = s.replace(/[^A-Za-z0-9_]/g, '_');
  if (/^[0-9]/.test(out)) out = '_' + out;
  return out;
}

// gdsfactory cell names: lower-case ASCII + underscores; no dashes,
// no leading digits. We also strip trailing underscores so generated
// names stay readable.
function pyCellName(name) {
  let s = String(name || 'layout').trim().toLowerCase();
  s = s.replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  if (!s) s = 'layout';
  if (/^[0-9]/.test(s)) s = 'cell_' + s;
  return s;
}

// Format a Python float literal with enough precision to round-trip
// through f32, but trimmed of trailing zeros for readability.
function pyFloat(v) {
  if (!Number.isFinite(v)) return '0.0';
  const s = v.toFixed(6);
  // Trim trailing zeros, keeping at least one digit after the decimal.
  return s.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '.0');
}

// ── Main entry point ─────────────────────────────────────────────────
export function generateGdsfactory(scene, paramValues, options = {}) {
  const { components, mirrors, snaps, stack, params } = scene;
  const solvedAll = applyMirrors(solveLayout(components, snaps, paramValues), mirrors);
  // Non-model components (section lines) are solver-visible — a child
  // snapped to one must land where the canvas puts it — but never emit
  // geometry. Parametric positions are computed on the FULL solved list
  // (pure param expressions, no object references), then everything
  // downstream sees only physical components.
  const solved = solvedAll.filter(c => !isNonModelComponent(c));
  // pp on the FULL solved list: a component snapped to a (filtered-out)
  // section line must still resolve its chain — same rule as hfss-native.
  const parametricPos = computeParametricPositions(solvedAll, snaps, paramValues);

  // Layer mapping mirrors generateGDS for cross-export consistency.
  const conductorLayers = (stack || []).filter(l => l.role === 'conductor');
  const layerMap = []; // { key: string, num: number, datatype: number, label: string }
  layerMap.push({ key: 'wg', num: 1, datatype: 0, label: 'waveguide' });
  conductorLayers.forEach((l, i) => {
    layerMap.push({ key: `cond_${pyIdent(l.id)}`, num: 10 + i, datatype: 0, label: `conductor "${l.name || l.id}"` });
  });
  layerMap.push({ key: 'port', num: 100, datatype: 0, label: 'port' });
  // Vias: one layer per distinct (layerFrom → layerTo) pair, 200+ —
  // same assignment rule as the binary GDS export (viaGdsLayerMap).
  const viaLayerEntries = viaGdsLayerMap(components);
  for (const v of viaLayerEntries) {
    layerMap.push({ key: `via_${pyIdent(v.key)}`, num: v.layer, datatype: 0, label: `via "${v.layerFrom} -> ${v.layerTo}"` });
  }
  const viaKeyByPair = Object.fromEntries(viaLayerEntries.map(v => [v.key, `via_${pyIdent(v.key)}`]));
  const gfCompById = Object.fromEntries((scene.components || []).map(cc => [cc.id, cc]));
  const layerKeyForComp = (c) => {
    if (c.kind === 'via') {
      return viaKeyByPair[`${c.layerFrom || '?'}->${c.layerTo || '?'}`]
        || (viaLayerEntries[0] ? `via_${pyIdent(viaLayerEntries[0].key)}` : 'wg');
    }
    if (c.layer === 'waveguide') return 'wg';
    if (c.layer === 'port') return 'port';
    if (c.layer === 'electrode') {
      // Own binding, else inherited from the consuming boolean — the
      // SAME resolution as the binary GDS / HFSS / 3-D consumers.
      const eff = effectiveConductorLayerId(c, gfCompById);
      if (eff && conductorLayers.some(l => l.id === eff)) {
        return `cond_${pyIdent(eff)}`;
      }
      return conductorLayers[0] ? `cond_${pyIdent(conductorLayers[0].id)}` : 'wg';
    }
    return 'wg';
  };

  // ── Build the parameter signature ──────────────────────────────────
  // Every scene param becomes a kwarg, but params split into two groups:
  //
  //   LEAVES — expression is a bare number (no references to other
  //            params). Default = current numeric value. Overriding
  //            in Python plugs in the new number directly.
  //
  //   DERIVED — expression references one or more other params (e.g.
  //             cap_d = 2*R + 5). Default = None; a recompute block
  //             at the top of the function body re-evaluates the
  //             expression from whatever the caller supplied. So:
  //               derived(R=200)        → cap_d auto-recomputes to 405
  //               derived(R=200, cap_d=400) → cap_d stays at 400
  //
  // Derived params are emitted in topological order (dependencies
  // first) so each `if x is None: x = ...` line can reference the
  // already-resolved values. A cycle in the param graph (rare; the
  // scene-side resolver flags these as errors) falls back to the
  // numeric value with an inline comment.
  const paramEntries = Object.entries(params || {});
  const paramSanitized = {}; // original name → sanitized name (for body references)
  const paramExpr = {};      // original name → expression string
  const paramValue = {};     // original name → resolved numeric value
  const paramDeps = {};      // original name → array of OTHER-param names it references
  const paramDesc = {};      // original name → desc string (may be empty)

  for (const [name, p] of paramEntries) {
    const safe = pyIdent(name);
    paramSanitized[name] = safe;
    paramDesc[name] = p.desc || '';
    const exprStr = String(p.expr ?? p.value ?? '0');
    paramExpr[name] = exprStr;
    const v = (paramValues && Object.prototype.hasOwnProperty.call(paramValues, name))
      ? paramValues[name]
      : evalExpr(exprStr, paramValues || {});
    paramValue[name] = Number.isFinite(v) ? v : 0;
    // Dependencies: identifiers in expr that are OTHER params (i.e.
    // exist in scene.params and aren't this param itself, math
    // functions, or unit suffixes).
    const idents = tokenizeIdents(exprStr);
    const deps = [];
    for (const id of idents) {
      if (id === name) continue;
      if (RESERVED_IDENTS.has(id)) continue;
      if (Object.prototype.hasOwnProperty.call(params, id)) deps.push(id);
    }
    paramDeps[name] = Array.from(new Set(deps));
  }

  // Topological sort over derived params (Kahn's algorithm). Leaves
  // stay in declaration order; derived ones get sorted so deps come
  // before dependents. Cycles fall back to declaration order with
  // the cycled params emitted as leaves (with a "# circular" note).
  const topoOrder = []; // names in dependency-respecting order
  const inCycle = new Set();
  {
    const remaining = new Set(paramEntries.map(([n]) => n));
    const inDeg = {};
    for (const n of remaining) {
      inDeg[n] = (paramDeps[n] || []).filter(d => remaining.has(d)).length;
    }
    // Process zero-indegree params first, in declaration order for stability.
    while (remaining.size > 0) {
      const next = paramEntries.map(([n]) => n).find(n => remaining.has(n) && inDeg[n] === 0);
      if (!next) {
        // Cycle: drain the rest in declaration order and flag them.
        for (const [n] of paramEntries) {
          if (remaining.has(n)) { inCycle.add(n); topoOrder.push(n); remaining.delete(n); }
        }
        break;
      }
      topoOrder.push(next);
      remaining.delete(next);
      for (const n of remaining) {
        if ((paramDeps[n] || []).includes(next)) inDeg[n] = Math.max(0, (inDeg[n] || 0) - 1);
      }
    }
  }

  // Now emit the kwarg list and the recompute block.
  const paramArgList = [];     // ["    R: float = 100.0,  # bend radius", …]
  const recomputeLines = [];   // body lines, e.g. "    if cap_d is None: cap_d = 2*R + 5"
  for (const name of topoOrder) {
    const safe = paramSanitized[name];
    const deps = paramDeps[name] || [];
    const isLeaf = deps.length === 0 || inCycle.has(name);
    const descSuffix = paramDesc[name] ? `  # ${paramDesc[name]}` : '';
    if (isLeaf) {
      const cycleNote = inCycle.has(name) ? '  # NOTE: param graph cycle — emitted as numeric leaf' : '';
      paramArgList.push(`    ${safe}: float = ${pyFloat(paramValue[name])},${descSuffix}${cycleNote}`);
    } else {
      // Derived: default None, recompute from expression at runtime.
      const depList = deps.map(d => paramSanitized[d]).join(', ');
      const sig = `    ${safe}: float = None,${descSuffix || `  # derived from: ${depList}`}`;
      paramArgList.push(sig);
      const pyExprStr = exprToPython(paramExpr[name]);
      recomputeLines.push(`    if ${safe} is None: ${safe} = ${pyExprStr}`);
    }
  }

  // ── Header ──────────────────────────────────────────────────────────
  const designName = options.designName || 'layout';
  const cellName = pyCellName(designName);
  let code = '';
  code += `"""\n`;
  code += `Auto-generated gdsfactory cell — exported from easyRFPIC.\n`;
  code += `\n`;
  code += `Each scene parameter is a function kwarg with its current canvas\n`;
  code += `value as the default. Override any kwarg to sweep that parameter:\n`;
  code += `\n`;
  code += `    import ${cellName}\n`;
  code += `    c = ${cellName}.${cellName}()                # current layout\n`;
  code += `    c = ${cellName}.${cellName}(w_wg=0.5)        # override one\n`;
  code += `    c.write_gds("out.gds")\n`;
  code += `    c.show()                                     # opens KLayout\n`;
  code += `\n`;
  code += `Parametric coverage:\n`;
  code += `  * Rectangles  — position, size, rotation all parametric\n`;
  code += `  * Circles / ellipses / regular polygons — center & size\n`;
  code += `    parametric; tessellated at runtime via math.cos/math.sin\n`;
  code += `  * Racetracks  — tessellated NUMERICALLY at export time\n`;
  code += `                  (Euler-bend math is too heavy to inline)\n`;
  code += `  * Transform-chain clones (repeat / mirror / duplicate_mirror)\n`;
  code += `                — instance positions baked numerically. Sweep\n`;
  code += `                  dimensions freely; re-export if topology changes.\n`;
  code += `  * Booleans    — operands emitted as separate polygons on the\n`;
  code += `                  same layer. For an actual merged shape, post-\n`;
  code += `                  process with gf.geometry.boolean or gdstk.\n`;
  code += `"""\n`;
  code += `import math\n`;
  code += `import gdsfactory as gf\n`;
  code += `\n`;
  code += `# ── Layer map (matches the binary GDS-II export) ─────────────\n`;
  code += `LAYERS = {\n`;
  for (const l of layerMap) {
    code += `    "${l.key}": (${l.num}, ${l.datatype}),  # ${l.label}\n`;
  }
  code += `}\n\n`;

  // ── Helpers ─────────────────────────────────────────────────────────
  code += `# ── Geometry helpers ─────────────────────────────────────────\n`;
  code += `def _rect_pts(cx, cy, w, h, theta_deg=0.0):\n`;
  code += `    """4 corners of a rect rotated about its own center."""\n`;
  code += `    ca = math.cos(math.radians(theta_deg))\n`;
  code += `    sa = math.sin(math.radians(theta_deg))\n`;
  code += `    hw, hh = w / 2.0, h / 2.0\n`;
  code += `    corners = [(-hw, -hh), (hw, -hh), (hw, hh), (-hw, hh)]\n`;
  code += `    return [(cx + x*ca - y*sa, cy + x*sa + y*ca) for x, y in corners]\n\n`;

  code += `def _circle_pts(cx, cy, r, n=64):\n`;
  code += `    """Tessellated circle, n vertices CCW."""\n`;
  code += `    return [(cx + r*math.cos(2*math.pi*i/n),\n`;
  code += `             cy + r*math.sin(2*math.pi*i/n)) for i in range(n)]\n\n`;

  code += `def _ellipse_pts(cx, cy, rx, ry, theta_deg=0.0, n=64):\n`;
  code += `    """Tessellated ellipse with optional rotation."""\n`;
  code += `    ca = math.cos(math.radians(theta_deg))\n`;
  code += `    sa = math.sin(math.radians(theta_deg))\n`;
  code += `    out = []\n`;
  code += `    for i in range(n):\n`;
  code += `        a = 2 * math.pi * i / n\n`;
  code += `        x, y = rx * math.cos(a), ry * math.sin(a)\n`;
  code += `        out.append((cx + x*ca - y*sa, cy + x*sa + y*ca))\n`;
  code += `    return out\n\n`;

  code += `def _regpoly_pts(cx, cy, r, n_sides, theta_deg=0.0):\n`;
  code += `    """Regular n-gon with circumradius r."""\n`;
  code += `    ca = math.cos(math.radians(theta_deg))\n`;
  code += `    sa = math.sin(math.radians(theta_deg))\n`;
  code += `    out = []\n`;
  code += `    for i in range(n_sides):\n`;
  code += `        a = 2 * math.pi * i / n_sides\n`;
  code += `        x, y = r * math.cos(a), r * math.sin(a)\n`;
  code += `        out.append((cx + x*ca - y*sa, cy + x*sa + y*ca))\n`;
  code += `    return out\n\n`;

  // ── The @gf.cell function ──────────────────────────────────────────
  code += `# ── Main cell ────────────────────────────────────────────────\n`;
  code += `@gf.cell\n`;
  if (paramArgList.length === 0) {
    code += `def ${cellName}() -> gf.Component:\n`;
  } else {
    code += `def ${cellName}(\n${paramArgList.join('\n')}\n) -> gf.Component:\n`;
  }
  // Docstring listing param descriptions (any with a `desc` field).
  const describedParams = paramEntries.filter(([, p]) => p.desc).map(([n, p]) => `        ${paramSanitized[n]} — ${p.desc}`);
  code += `    """Parametric layout for "${designName}".\n`;
  if (describedParams.length > 0) {
    code += `\n    Parameters:\n${describedParams.join('\n')}\n`;
  }
  code += `    """\n`;
  // Recompute block: derived params with default=None re-evaluate
  // their expressions from whatever the caller supplied. Topologically
  // ordered so dependencies are resolved first.
  if (recomputeLines.length > 0) {
    code += `    # ── Derived parameters (auto-recompute when not overridden) ──\n`;
    code += recomputeLines.join('\n') + '\n\n';
  }
  code += `    c = gf.Component()\n\n`;

  // Helper for the body: emit one polygon for one instance of a
  // component, picking the right shape helper + arguments.
  // The (cx, cy) here can be either a parametric Python expression
  // string (for the base instance) or a numeric value (for transform
  // clones). Same with theta.
  const emitPolygon = (c, instCxExpr, instCyExpr, instThetaExpr, layerKey, indent = '    ') => {
    const kind = c.kind || 'rect';
    const wExpr = exprToPython(c.w ?? '0');
    const hExpr = exprToPython(c.h ?? '0');
    if (kind === 'rect') {
      // Rounded rect (D3): the corner-filleted perimeter is tessellated
      // NUMERICALLY at export (same ring the canvas / GDS build) and
      // emitted as instance-frame offsets — re-export after changing
      // w / h / cornerRadius. Sharp rects stay fully parametric below.
      const crNum = c.cornerRadius != null ? evalExpr(c.cornerRadius, paramValues) : 0;
      if (Number.isFinite(crNum) && crNum > 0) {
        const wNum = evalExpr(c.w ?? '0', paramValues) || 0;
        const hNum = evalExpr(c.h ?? '0', paramValues) || 0;
        const thetaNum = c.rotation != null ? (evalExpr(c.rotation, paramValues) || 0) : 0;
        const ringRR = shapeInstanceToRing({
          kind: 'rect', cx: 0, cy: 0, w: wNum, h: hNum,
          cornerRadius: crNum, rotation: thetaNum,
        });
        const ptsToPyRR = '[' + ringRR.map(([x, y]) => `(${pyFloat(x)} + (${instCxExpr}), ${pyFloat(y)} + (${instCyExpr}))`).join(', ') + ']';
        let outRR = `${indent}# ${c.id}: rounded rect (cornerRadius=${pyFloat(crNum)}) — perimeter baked numerically; re-export after dim changes\n`;
        outRR += `${indent}c.add_polygon(${ptsToPyRR}, layer=LAYERS["${layerKey}"])\n`;
        return outRR;
      }
      return `${indent}c.add_polygon(_rect_pts(${instCxExpr}, ${instCyExpr}, ${wExpr}, ${hExpr}, ${instThetaExpr}), layer=LAYERS["${layerKey}"])\n`;
    }
    if (kind === 'circle') {
      const rExpr = exprToPython(c.r ?? '0');
      return `${indent}c.add_polygon(_circle_pts(${instCxExpr}, ${instCyExpr}, ${rExpr}), layer=LAYERS["${layerKey}"])\n`;
    }
    if (kind === 'via') {
      // Via (D4): plan-view circle on its via-pair layer. Parametric
      // center + radius like circles; the Z span (layerFrom / layerTo)
      // has no GDS meaning beyond the layer-number encoding.
      const rExpr = exprToPython(c.r ?? '0');
      return `${indent}c.add_polygon(_circle_pts(${instCxExpr}, ${instCyExpr}, ${rExpr}), layer=LAYERS["${layerKey}"])  # via ${c.layerFrom} -> ${c.layerTo}\n`;
    }
    if (kind === 'ellipse') {
      const rxExpr = exprToPython(c.rx ?? '0');
      const ryExpr = exprToPython(c.ry ?? '0');
      return `${indent}c.add_polygon(_ellipse_pts(${instCxExpr}, ${instCyExpr}, ${rxExpr}, ${ryExpr}, ${instThetaExpr}), layer=LAYERS["${layerKey}"])\n`;
    }
    if (kind === 'polygon') {
      const rExpr = exprToPython(c.r ?? '0');
      const nSides = parseInt(c.n, 10) || 6;
      return `${indent}c.add_polygon(_regpoly_pts(${instCxExpr}, ${instCyExpr}, ${rExpr}, ${nSides}, ${instThetaExpr}), layer=LAYERS["${layerKey}"])\n`;
    }
    // Closed polygon-path: resolved vertex list IS the polygon perimeter.
    // The resolver runs at export time; per-edge dx/dy params land in
    // the function signature so the polygon's shape sweeps under
    // Python-side parameter overrides. Snap-bound vertices follow the
    // target component's solved position (numerically captured here).
    // Polyline trace: emit the BAND as numeric per-segment quads (the
    // same butt-join geometry the canvas and HFSS build). Covers both
    // constant-width and tapered traces — taperedBandQuads interpolates
    // per-vertex widths and falls back to the base width along arc /
    // spline segments (tessellated numerically, matching the canvas).
    if (kind === 'polyline') {
      const compById_pl = Object.fromEntries(solvedAll.map(cc => [cc.id, cc])) /* FULL list: snap-vertices may target section lines */;
      const { quads } = taperedBandQuads(c, compById_pl, paramValues);
      if (quads.length === 0) {
        return `${indent}# ${c.id}: polyline with no drawable segments — skipping\n`;
      }
      const ptsToPy = (pts) => '[' + pts.map(([x, y]) => `(${pyFloat(x - c.cx)} + (${instCxExpr}), ${pyFloat(y - c.cy)} + (${instCyExpr}))`).join(', ') + ']';
      let out = `${indent}# ${c.id}: polyline trace — band emitted as ${quads.length} per-segment quad(s), baked numerically\n`;
      out += `${indent}# (butt joins; arcs/splines tessellated — matches the canvas + HFSS band geometry)\n`;
      for (const q of quads) {
        out += `${indent}c.add_polygon(${ptsToPy(q)}, layer=LAYERS["${layerKey}"])\n`;
      }
      return out;
    }
    if (kind === 'polyshape') {
      const compById_ps = Object.fromEntries(solvedAll.map(cc => [cc.id, cc])) /* FULL list: snap-vertices may target section lines */;
      // Tessellated perimeter: arc vertices expand along their circular
      // arcs, spline runs interpolate with Catmull-Rom — a numeric
      // capture of the same geometry the canvas draws and HFSS builds
      // natively (AngularArc / Spline segments).
      const verts = tessellatePolylinePath(c, compById_ps, paramValues);
      if (verts.length < 3) {
        return `${indent}# ${c.id}: polyshape with <3 vertices — skipping\n`;
      }
      // Translate each vertex into the instance frame and add the
      // parametric (cx, cy). For the BASE instance the translation
      // delta is zero, so this just gives the world-space vertex list.
      // Per-edge dx_<i> / dy_<i> params would let us emit a fully
      // parametric polygon — but those params are stored on the
      // component as expressions, not directly on the vertices array.
      // Capturing them parametrically would require traversing the
      // vertex chain and emitting Python recurrences; a future
      // enhancement.
      const ptsToPy = (pts) => '[' + pts.map(([x, y]) => `(${pyFloat(x - c.cx)} + (${instCxExpr}), ${pyFloat(y - c.cy)} + (${instCyExpr}))`).join(', ') + ']';
      let out = `${indent}# ${c.id}: polyshape (closed polygon-path) — ${verts.length} vertices baked numerically\n`;
      out += `${indent}c.add_polygon(${ptsToPy(verts)}, layer=LAYERS["${layerKey}"])\n`;
      return out;
    }
    // Racetrack: tessellate at export time, emit as numeric polygon.
    if (kind === 'racetrack') {
      const insts = expandTransforms([c], paramValues);
      const base = insts[0];
      if (!base) return `${indent}# ${c.id}: empty racetrack instance\n`;
      const R = Number.isFinite(base.R) ? base.R : 100;
      const L = Number.isFinite(base.L_straight) ? base.L_straight : 300;
      const pE = Number.isFinite(base.p) ? base.p : 1;
      const wgW = Number.isFinite(base.wgWidth) ? base.wgWidth : 1.2;
      const centerline = buildRacetrackCenterline(R, L, pE);
      const { outer, inner } = offsetCenterlineToBand(centerline, wgW / 2);
      // Apply the instance's rotation about (cx_local, cy_local) — but
      // here we want to draw at (instCxExpr, instCyExpr) which is a
      // Python expression. So we emit the polygon points as offsets
      // and let Python add them to (cx, cy) at runtime.
      const ptsToPy = (pts) => '[' + pts.map(([x, y]) => `(${pyFloat(x)} + (${instCxExpr}), ${pyFloat(y)} + (${instCyExpr}))`).join(', ') + ']';
      let out = `${indent}# ${c.id}: racetrack — band tessellated numerically at export\n`;
      out += `${indent}c.add_polygon(${ptsToPy(outer)}, layer=LAYERS["${layerKey}"])\n`;
      if (inner.length >= 3) {
        out += `${indent}# inner perimeter (hole) on datatype 1\n`;
        // Workaround: gdsfactory layer is (num, datatype); we want datatype=1 here.
        // Emit a direct tuple.
        const layerEntry = layerMap.find(l => l.key === layerKey);
        const layerNum = layerEntry ? layerEntry.num : 1;
        out += `${indent}c.add_polygon(${ptsToPy(inner)}, layer=(${layerNum}, 1))\n`;
      }
      return out;
    }
    return `${indent}# ${c.id}: unsupported shape "${kind}" — skipping\n`;
  };

  // Walk each component. Skip booleans (handled separately at the end).
  const elecComponents = solved.filter(c => c.kind !== 'boolean' && !c.consumedBy);
  if (elecComponents.length === 0) {
    code += `    # No exportable components.\n`;
  }
  for (const c of elecComponents) {
    const layerKey = layerKeyForComp(c);
    // Base position: prefer the parametric snap-chain expression so
    // the user can sweep snap dx/dy and watch positions move. Falls
    // back to numeric solved position for un-snapped components.
    const pp = parametricPos[c.id];
    const cxBaseExpr = pp ? exprToPython(pp.cxExpr) : pyFloat(c.cx);
    const cyBaseExpr = pp ? exprToPython(pp.cyExpr) : pyFloat(c.cy);

    code += `    # ── ${c.id} (${c.kind || 'rect'} on ${c.layer}) ──\n`;

    // No transforms → one polygon at the base position.
    const transforms = (c.transforms || []).filter(t => t && t.enabled !== false);
    if (transforms.length === 0) {
      code += emitPolygon(c, cxBaseExpr, cyBaseExpr, '0.0', layerKey);
      continue;
    }
    // With transforms: expandTransforms gives us each instance's
    // numeric (cx, cy, rotation). We emit one add_polygon per
    // instance. The base instance (idx=0) uses the parametric base
    // position; clones (idx>0) use numeric (since their compound
    // transform math doesn't survive parameter sweeps cleanly).
    const insts = expandTransforms([c], paramValues);
    let firstParametricEmitted = false;
    for (const inst of insts) {
      if (!firstParametricEmitted && inst.idx === 0) {
        const thetaExpr = inst.rotation ? pyFloat(inst.rotation) : '0.0';
        code += emitPolygon(c, cxBaseExpr, cyBaseExpr, thetaExpr, layerKey);
        firstParametricEmitted = true;
      } else {
        const cxN = pyFloat(inst.cx);
        const cyN = pyFloat(inst.cy);
        const thetaN = pyFloat(inst.rotation || 0);
        code += emitPolygon({ ...c, w: inst.w ?? c.w, h: inst.h ?? c.h }, cxN, cyN, thetaN, layerKey, '    ');
      }
    }
    // Cutouts (rect-only convention): emit as datatype-1 boundaries
    // on the same layer, base instance only — matches the GDS export.
    if (c.cutouts && c.cutouts.length > 0) {
      const layerEntry = layerMap.find(l => l.key === layerKey);
      const layerNum = layerEntry ? layerEntry.num : 1;
      for (const cu of c.cutouts) {
        const cxOff = exprToPython(cu.dx ?? '0');
        const cyOff = exprToPython(cu.dy ?? '0');
        const cwExpr = exprToPython(cu.w ?? '0');
        const chExpr = exprToPython(cu.h ?? '0');
        code += `    c.add_polygon(_rect_pts(${cxBaseExpr} + (${cxOff}), ${cyBaseExpr} + (${cyOff}), ${cwExpr}, ${chExpr}, 0.0), layer=(${layerNum}, 1))  # ${c.id} cutout\n`;
      }
    }
    code += '\n';
  }

  // Booleans — emit each operand again on the result's layer with
  // a comment explaining the merge isn't done automatically.
  const booleans = solved.filter(c => c.kind === 'boolean');
  if (booleans.length > 0) {
    code += `    # ── Booleans (operands emitted as separate polygons) ─────\n`;
    code += `    # The canvas treats these as merged shapes (HFSS-style); to\n`;
    code += `    # produce a single merged polygon in the output GDS, run\n`;
    code += `    # gf.geometry.boolean / gdstk.boolean over the operands below.\n`;
    for (const b of booleans) {
      const layerKey = layerKeyForComp(b);
      code += `    # ${b.id} = ${b.op}(${(b.operandIds || []).join(', ')})\n`;
      for (const opId of (b.operandIds || [])) {
        const op = solved.find(o => o.id === opId);
        if (!op) continue;
        const pp = parametricPos[op.id];
        const cxBaseExpr = pp ? exprToPython(pp.cxExpr) : pyFloat(op.cx);
        const cyBaseExpr = pp ? exprToPython(pp.cyExpr) : pyFloat(op.cy);
        // Emit on the BOOLEAN's resolved layer so the merged shape's
        // material is correct. expandTransforms covers any repeat
        // on the operand itself.
        const insts = expandTransforms([op], paramValues);
        let firstDone = false;
        for (const inst of insts) {
          if (!firstDone && inst.idx === 0) {
            const thetaExpr = inst.rotation ? pyFloat(inst.rotation) : '0.0';
            code += emitPolygon(op, cxBaseExpr, cyBaseExpr, thetaExpr, layerKey);
            firstDone = true;
          } else {
            code += emitPolygon({ ...op, w: inst.w ?? op.w, h: inst.h ?? op.h }, pyFloat(inst.cx), pyFloat(inst.cy), pyFloat(inst.rotation || 0), layerKey);
          }
        }
      }
      code += '\n';
    }
  }

  code += `    return c\n\n`;

  // ── Main block ─────────────────────────────────────────────────────
  code += `if __name__ == "__main__":\n`;
  code += `    c = ${cellName}()\n`;
  code += `    c.write_gds("${cellName}.gds")\n`;
  code += `    try:\n`;
  code += `        c.show()\n`;
  code += `    except Exception as e:\n`;
  code += `        print("c.show() failed (KLayout not running?):", e)\n`;

  return code;
}
