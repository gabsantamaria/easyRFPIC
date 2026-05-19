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
import { evalExpr } from '../scene/params.js';
import { solveLayout, applyMirrors } from '../scene/solver.js';
import { expandTransforms } from '../scene/transforms.js';
import { shapeInstanceToRing } from '../geometry/rings.js';
import { buildRacetrackCenterline, offsetCenterlineToBand } from '../geometry/racetrack.js';
import { computeParametricPositions } from './hfss-native.js';

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
  const solved = applyMirrors(solveLayout(components, snaps, paramValues), mirrors);
  const parametricPos = computeParametricPositions(solved, snaps, paramValues);

  // Layer mapping mirrors generateGDS for cross-export consistency.
  const conductorLayers = (stack || []).filter(l => l.role === 'conductor');
  const layerMap = []; // { key: string, num: number, datatype: number, label: string }
  layerMap.push({ key: 'wg', num: 1, datatype: 0, label: 'waveguide' });
  conductorLayers.forEach((l, i) => {
    layerMap.push({ key: `cond_${pyIdent(l.id)}`, num: 10 + i, datatype: 0, label: `conductor "${l.name || l.id}"` });
  });
  layerMap.push({ key: 'port', num: 100, datatype: 0, label: 'port' });
  const layerKeyForComp = (c) => {
    if (c.layer === 'waveguide') return 'wg';
    if (c.layer === 'port') return 'port';
    if (c.layer === 'electrode') {
      if (c.conductorLayerId && conductorLayers.some(l => l.id === c.conductorLayerId)) {
        return `cond_${pyIdent(c.conductorLayerId)}`;
      }
      return conductorLayers[0] ? `cond_${pyIdent(conductorLayers[0].id)}` : 'wg';
    }
    return 'wg';
  };

  // ── Build the parameter signature ──────────────────────────────────
  // Every scene param becomes a kwarg with default = current value.
  // Params keep their original name when it's already valid Python;
  // otherwise we sanitize and emit a mapping comment.
  const paramEntries = Object.entries(params || {});
  const paramArgList = [];   // ["w_wg: float = 1.0", "h_wg: float = 0.3", ...]
  const paramSanitized = {}; // original name → sanitized name (for body references)
  for (const [name, p] of paramEntries) {
    const v = (paramValues && Object.prototype.hasOwnProperty.call(paramValues, name))
      ? paramValues[name]
      : evalExpr(p.expr ?? p.value ?? '0', paramValues || {});
    const safe = pyIdent(name);
    paramSanitized[name] = safe;
    const desc = p.desc ? `  # ${p.desc}` : '';
    paramArgList.push(`    ${safe}: float = ${pyFloat(v || 0)},${desc}`);
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
      return `${indent}c.add_polygon(_rect_pts(${instCxExpr}, ${instCyExpr}, ${wExpr}, ${hExpr}, ${instThetaExpr}), layer=LAYERS["${layerKey}"])\n`;
    }
    if (kind === 'circle') {
      const rExpr = exprToPython(c.r ?? '0');
      return `${indent}c.add_polygon(_circle_pts(${instCxExpr}, ${instCyExpr}, ${rExpr}), layer=LAYERS["${layerKey}"])\n`;
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
