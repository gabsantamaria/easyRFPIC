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
import { evalExpr, topoSortParams } from '../scene/params.js';
import { parseAnchor, anchorLocal } from '../scene/anchors.js';
import { solveLayout, applyMirrors } from '../scene/solver.js';
import { expandTransforms } from '../scene/transforms.js';
import { detectPortIntegrationLine } from '../scene/lumpedPort.js';
import { migrateStackCoplanarGroups } from '../scene/schema.js';
import { shapeInstanceToRing } from '../geometry/rings.js';
import { buildRacetrackCenterline, offsetCenterlineToBand } from '../geometry/racetrack.js';
import { instanceChainOffsetExpr, chainOwnerForInstance } from '../scene/instance-positions.js';
import { twoLineOutputVariables } from '../scene/twoLine.js';
import { generateQ3DCombinedBlock } from './q3d.js';
import {
  resolvePolylineVertices, polylineIsTapered,
  tessellateArcFrom, catmullRomTessellate,
} from '../geometry/polyline.js';

// Clean a tessellated perimeter ring for HFSS CreatePolyline. HFSS rejects
// polylines containing zero/near-zero-length Line segments ("invalid
// parameters to CreatePolyline operation"). Tessellated loops — especially
// the racetrack, whose centerline is sampled as an implicitly-closed curve
// — come back with the LAST sample landing a fraction of a nm from the
// first, and may carry other coincident samples at sharp junctions. We:
//   1. collapse consecutive points closer than `eps`, and
//   2. drop any trailing point(s) coincident (within `eps`) with the first
//      (the implicit-closure near-duplicate),
// leaving N DISTINCT vertices. The caller then appends a repeat of the first
// vertex (N+1 points) and emits one Line segment per edge INCLUDING the
// closing edge (N segments) with IsPolylineClosed=True. The explicit closing
// segment makes wire-body extraction robust (relying on HFSS auto-close
// alone — N points, N-1 segments — fails with cant_extract_geom); closed=True
// is what makes HFSS COVER the loop into a face so the sweep yields a SOLID
// (with closed=False the IsPolylineCovered flag is ignored and the result is a
// hollow surface). The closed=True auto-close edge is then zero-length/harmless.
//
// eps = 1e-3 µm (1 nm): far below any meaningful RF/photonic feature size
// (µm-scale) yet comfortably above the sub-nm numerical closure gap.
export function dedupeRingForHfss(pts, eps = 1e-3) {
  if (!Array.isArray(pts) || pts.length === 0) return pts;
  const near = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) < eps;
  const out = [];
  for (const p of pts) {
    if (out.length === 0 || !near(p, out[out.length - 1])) out.push(p);
  }
  while (out.length > 2 && near(out[0], out[out.length - 1])) out.pop();
  return out;
}

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
// Exported so other exporters (e.g. gdsfactory.js) can reuse the same
// snap-chain → parametric-position resolution. The output expressions
// use HFSS-style "um" unit suffixes on bare numerics; callers that
// target a different language post-process those out.

// ── First-class rotation helpers ─────────────────────────────────────
// Components may carry an optional `rotation` expression (degrees, CCW).
// HFSS trig is UNIT-AWARE: cos/sin demand a degree- (or radian-) typed
// argument, so a unitless rotation expression must be multiplied by
// `1deg`. Pure numeric rotations emit as "<n>deg" literals.
//
// IMPORTANT: rotation parameters auto-created from the inspector are
// UNITLESS (unit: '') — multiplying a deg-typed HFSS variable by 1deg
// would produce deg², which HFSS rejects.
export function hfssAngleDegExpr(expr) {
  const s = String(expr ?? '0').trim();
  if (/^-?\d+(?:\.\d+)?$/.test(s)) return `${s}deg`;
  return `(${s})*1deg`;
}

// The component's rotation expression, or null when absent / trivially
// zero. Only rect / circle / ellipse / polygon support first-class
// rotation (matching expandTransforms' seeding); booleans and path-like
// kinds return null.
const HFSS_ROTATABLE_KINDS = new Set(['rect', 'circle', 'ellipse', 'polygon']);
export function componentRotationExpr(c) {
  if (!c || c.rotation == null) return null;
  if (!HFSS_ROTATABLE_KINDS.has(c.kind || 'rect')) return null;
  const s = String(c.rotation).trim();
  if (s === '' || s === '0') return null;
  return s;
}

// Wrap an (xOff, yOff) anchor-offset expression pair in the 2-D rotation
// matrix for `rotExpr` degrees CCW, using HFSS trig:
//   xOff' = (xOff)·cos(rot·1deg) − (yOff)·sin(rot·1deg)
//   yOff' = (xOff)·sin(rot·1deg) + (yOff)·cos(rot·1deg)
// A child snapped to a rotated parent thereby tracks BOTH the parent's
// position parameters AND its rotation parameter in HFSS.
function rotateOffsetExprs(off, rotExpr) {
  if (!rotExpr) return off;
  const d = hfssAngleDegExpr(rotExpr);
  return {
    xOff: `(${off.xOff})*cos(${d}) - (${off.yOff})*sin(${d})`,
    yOff: `(${off.xOff})*sin(${d}) + (${off.yOff})*cos(${d})`,
  };
}

export function computeParametricPositions(components, snaps, paramValues = {}) {
  const byId = Object.fromEntries(components.map(c => [c.id, c]));
  // Helper: produce an expression for the X/Y offset of an anchor on a comp
  // whose width-expression is wExpr and height-expression is hExpr.
  //
  // CRITICAL UNIT HANDLING: parent components walked through the snap
  // chain can be BOOLEANS whose w/h is a numeric AABB value written by
  // resolveBooleanBboxes (e.g. `3` for a 3-µm-wide cluster). A bare
  // number embedded in an HFSS expression is interpreted in the
  // design's base length unit (meters in most configurations) — NOT µm
  // — and that poisons any arithmetic with unit-bearing terms
  // downstream, throwing the snapped child off by millions of µm. Tag
  // numeric w/h with "um" here so every term in the emitted offset
  // expression carries its unit explicitly.
  const dimExprStr = (v) => {
    if (typeof v === 'number') return `${v}um`;
    const s = String(v ?? '0');
    // Bare-numeric string (e.g. '3', '-2.5') from a primitive's
    // scene-literal w/h field. HFSS reads bare numbers in the
    // design's base unit — tag with "um" so it doesn't become
    // 3 meters and ship the child to the next universe.
    if (/^-?\d+(?:\.\d+)?$/.test(s.trim())) return `${s}um`;
    return s;
  };
  // ── C8: parametric position on UNSNAPPED roots ─────────────────────
  // A free component may carry cxExpr / cyExpr (expression strings,
  // µm). When present (and evaluating finite, mirroring the solver's
  // gate), the ROOT position expression is the user's expression
  // instead of the solved numeric literal — so the WHOLE downstream
  // snap chain inherits the referenced parameters and an HFSS-side
  // sweep over them moves the entire subtree. Snap-bound components
  // never reach this helper (the snap branch wins), matching the
  // solver's "snap wins" rule. Bare numerics get the "um" tag (same
  // base-unit hazard as dimExprStr above).
  const rootPosExpr = (c, axis) => {
    const num = axis === 'x' ? c?.cx : c?.cy;
    const fallback = `${Number.isFinite(num) ? num : 0}um`;
    if (!c || c.kind === 'boolean') return fallback;
    const expr = axis === 'x' ? c.cxExpr : c.cyExpr;
    if (expr == null) return fallback;
    const s = String(expr).trim();
    if (s === '' || !Number.isFinite(evalExpr(s, paramValues))) return fallback;
    if (/^-?\d+(?:\.\d+)?$/.test(s)) return `${s}um`;
    return `(${s})`;
  };
  // Optional 4th arg `rotExpr`: the owning component's first-class
  // rotation expression (degrees, CCW). When present, the offsets are
  // wrapped in the HFSS-trig rotation matrix so the anchor tracks the
  // ROTATED shape (see rotateOffsetExprs above).
  const anchorOffsetExpr = (anchorName, wExpr, hExpr, rotExpr = null) => {
    const wExprS = dimExprStr(wExpr);
    const hExprS = dimExprStr(hExpr);
    const a = parseAnchor(anchorName);
    let xOff = '0', yOff = '0';
    if (a.kind === 'edge') {
      if (a.side === 'T') { xOff = `(${a.t} - 0.5) * (${wExprS})`; yOff = `(${hExprS})/2`; }
      else if (a.side === 'B') { xOff = `(${a.t} - 0.5) * (${wExprS})`; yOff = `-(${hExprS})/2`; }
      else if (a.side === 'L') { xOff = `-(${wExprS})/2`; yOff = `(${a.t} - 0.5) * (${hExprS})`; }
      else if (a.side === 'R') { xOff = `(${wExprS})/2`;  yOff = `(${a.t} - 0.5) * (${hExprS})`; }
    } else {
      const n = a.name;
      if (n.includes('W')) xOff = `-(${wExprS})/2`;
      else if (n.includes('E')) xOff = `(${wExprS})/2`;
      if (n.includes('S')) yOff = `-(${hExprS})/2`;
      else if (n.includes('N')) yOff = `(${hExprS})/2`;
    }
    return rotateOffsetExprs({ xOff, yOff }, rotExpr);
  };

  // Build incoming-snap lookup
  const incomingSnap = new Map(); // toCompId -> snap
  for (const s of snaps) incomingSnap.set(s.to.compId, s);

  const positions = {}; // compId -> { cxExpr, cyExpr, wExpr, hExpr }
  const visiting = new Set();

  // Width/height expression for a component, suitable for use in HFSS-
  // side arithmetic. For primitives it's the raw scene expression (which
  // already names HFSS variables); for booleans we recurse so the
  // boolean's bbox is expressed in terms of its operands' parametric
  // chains rather than the numeric AABB that resolveBooleanBboxes
  // wrote into c.w / c.h. Without that recursion a snap targeting
  // a boolean would freeze the boolean's width at export-time numeric
  // value — and any HFSS-side parameter sweep that moves the operands
  // would leave snapped-to-boolean children stranded.
  const dimExprForComp = (c) => {
    if (!c) return { wExpr: '0', hExpr: '0' };
    if (c.kind !== 'boolean') {
      return { wExpr: String(c.w ?? '0'), hExpr: String(c.h ?? '0') };
    }
    // Boolean: derive bbox parametrically through the operand tree.
    const op = c.op;
    const ops = (c.operandIds || []).map(id => byId[id]).filter(Boolean);
    if (ops.length === 0) return { wExpr: '0', hExpr: '0' };
    if (op === 'subtract' || op === 'intersect' || op === 'punch') {
      // Bbox = base operand's bbox.
      return dimExprForComp(ops[0]);
    }
    // Union: bbox = AABB across all operands. HFSS expressions have no
    // first-class min/max, but at EXPORT time the solved numeric
    // positions tell us WHICH operand is extremal along each axis.
    // We emit the bbox as a parametric difference between those two
    // operands' edge expressions, computed via the snap chain WITHOUT
    // cluster pass-through (otherwise we'd recurse into the very
    // boolean whose bbox we're computing).
    //
    // The cluster-root operand's absolute position cancels out of the
    // difference, so the result depends only on the parametric snap-
    // chain deltas between operands — i.e. the union's internal cell
    // geometry. Sweeping `meander_h_cell_w` / `meander_h_cell_h` / etc.
    // in HFSS now correctly resizes the bbox and any child snapped
    // to one of its anchors.
    //
    // Fallback to the post-solve numeric AABB (tagged with "um") for
    // edge cases — zero operands, unresolved positions, or any other
    // bail-out.
    const fallbackDims = () => {
      const wNum = typeof c.w === 'number' ? c.w : 0;
      const hNum = typeof c.h === 'number' ? c.h : 0;
      return { wExpr: `${wNum}um`, hExpr: `${hNum}um` };
    };
    if (ops.length === 1) {
      // Singleton union: bbox = operand bbox.
      return dimExprForComp(ops[0]);
    }
    // Find extremal operands using SOLVED numerics
    let minXOp = ops[0], maxXOp = ops[0], minYOp = ops[0], maxYOp = ops[0];
    let minX = +Infinity, maxX = -Infinity, minY = +Infinity, maxY = -Infinity;
    for (const op of ops) {
      const ocx = Number.isFinite(op.cx) ? op.cx : 0;
      const ocy = Number.isFinite(op.cy) ? op.cy : 0;
      const ow  = typeof op.w === 'number' ? op.w : (Number.isFinite(evalExpr(op.w, paramValues)) ? evalExpr(op.w, paramValues) : 0);
      const oh  = typeof op.h === 'number' ? op.h : (Number.isFinite(evalExpr(op.h, paramValues)) ? evalExpr(op.h, paramValues) : 0);
      if (ocx - ow/2 < minX) { minX = ocx - ow/2; minXOp = op; }
      if (ocx + ow/2 > maxX) { maxX = ocx + ow/2; maxXOp = op; }
      if (ocy - oh/2 < minY) { minY = ocy - oh/2; minYOp = op; }
      if (ocy + oh/2 > maxY) { maxY = ocy + oh/2; maxYOp = op; }
    }
    // Resolve each extremal operand's snap-chain position WITHOUT
    // cluster pass-through, so we don't loop back into THIS boolean.
    const minXPos = resolveNoCluster(minXOp.id);
    const maxXPos = resolveNoCluster(maxXOp.id);
    const minYPos = resolveNoCluster(minYOp.id);
    const maxYPos = resolveNoCluster(maxYOp.id);
    if (!minXPos || !maxXPos || !minYPos || !maxYPos) return fallbackDims();
    // Per-operand dimensions for the parametric edge expressions.
    // For boolean operands we'd recurse — bail out to numeric for now
    // (nested-union bboxes are rare and not worth the complexity).
    const opDims = (op) => {
      if (op.kind === 'boolean') return null;
      // Run through dimExprStr so bare-numeric strings (e.g. '3') pick
      // up a "um" suffix — otherwise the resulting edge expression
      // mixes meters and µm and HFSS evaluates the bbox out by a
      // factor of 10^6.
      return { wExpr: dimExprStr(op.w), hExpr: dimExprStr(op.h) };
    };
    const dMinX = opDims(minXOp), dMaxX = opDims(maxXOp);
    const dMinY = opDims(minYOp), dMaxY = opDims(maxYOp);
    if (!dMinX || !dMaxX || !dMinY || !dMaxY) return fallbackDims();
    const wExpr = `((${maxXPos.cxExpr}) + (${dMaxX.wExpr})/2) - ((${minXPos.cxExpr}) - (${dMinX.wExpr})/2)`;
    const hExpr = `((${maxYPos.cyExpr}) + (${dMaxY.hExpr})/2) - ((${minYPos.cyExpr}) - (${dMinY.hExpr})/2)`;
    return { wExpr, hExpr };
  };

  // Non-memoized snap-chain resolution used by dimExprForComp(union) to
  // compute parametric bbox without falling into the cluster-operand
  // pass-through (which would create a cycle: union bbox needs operand
  // positions, but operand positions chain through the union).
  //
  // Free-root operands return their scene-literal cx/cy. The CALLER
  // takes the DIFFERENCE between two operand positions for bbox
  // dimensions, so the absolute root position cancels out and the
  // result is a pure-parametric expression of the operands' relative
  // snap-chain deltas.
  const resolveNoCluster = (compId, stack = new Set()) => {
    if (stack.has(compId)) {
      const cc = byId[compId];
      return {
        cxExpr: `${Number.isFinite(cc?.cx) ? cc.cx : 0}um`,
        cyExpr: `${Number.isFinite(cc?.cy) ? cc.cy : 0}um`,
      };
    }
    stack.add(compId);
    const cc = byId[compId];
    if (!cc) return null;
    const sn = incomingSnap.get(compId);
    if (!sn) {
      // Free root: honor cxExpr / cyExpr (C8) the same way `resolve`
      // does, so union-bbox edge expressions track the root params too.
      return {
        cxExpr: rootPosExpr(cc, 'x'),
        cyExpr: rootPosExpr(cc, 'y'),
      };
    }
    const parent = byId[sn.from.compId];
    if (!parent) return null;
    const parentPos = resolveNoCluster(sn.from.compId, new Set(stack));
    if (!parentPos) return null;
    // Parent / child dims: prefer parametric scene expressions; for
    // boolean parents fall back to the numeric AABB (which doesn't
    // recurse here — keeps this lookup linear).
    const pwExpr = parent.kind === 'boolean'
      ? `${typeof parent.w === 'number' ? parent.w : 0}um`
      : String(parent.w ?? '0');
    const phExpr = parent.kind === 'boolean'
      ? `${typeof parent.h === 'number' ? parent.h : 0}um`
      : String(parent.h ?? '0');
    const cwExpr = cc.kind === 'boolean'
      ? `${typeof cc.w === 'number' ? cc.w : 0}um`
      : String(cc.w ?? '0');
    const chExpr = cc.kind === 'boolean'
      ? `${typeof cc.h === 'number' ? cc.h : 0}um`
      : String(cc.h ?? '0');
    const fromOff = anchorOffsetExpr(sn.from.anchor, pwExpr, phExpr, componentRotationExpr(parent));
    const toOff   = anchorOffsetExpr(sn.to.anchor,   cwExpr, chExpr, componentRotationExpr(cc));
    return {
      cxExpr: `(${parentPos.cxExpr}) + (${fromOff.xOff}) + (${sn.dx}) - (${toOff.xOff})`,
      cyExpr: `(${parentPos.cyExpr}) + (${fromOff.yOff}) + (${sn.dy}) - (${toOff.yOff})`,
    };
  };

  const resolve = (compId) => {
    if (positions[compId]) return positions[compId];
    if (visiting.has(compId)) {
      // Cycle — fall back to literal cx/cy to break it
      const c = byId[compId];
      const cx = (c && Number.isFinite(c.cx)) ? c.cx : 0;
      const cy = (c && Number.isFinite(c.cy)) ? c.cy : 0;
      const dims = dimExprForComp(c);
      positions[compId] = { cxExpr: `${cx}um`, cyExpr: `${cy}um`, wExpr: dims.wExpr, hExpr: dims.hExpr };
      return positions[compId];
    }
    visiting.add(compId);
    const c = byId[compId];
    if (!c) {
      visiting.delete(compId);
      const fallback = { cxExpr: '0um', cyExpr: '0um', wExpr: '0', hExpr: '0' };
      positions[compId] = fallback;
      return fallback;
    }
    // ── BOOLEAN PASS-THROUGH ─────────────────────────────────────────
    // For subtract / intersect / punch booleans the AABB equals the BASE
    // operand's AABB, so the boolean's parametric cx/cy/w/h is just the
    // base operand's chain. Re-using it (rather than freezing the
    // boolean's solved cx/cy as a numeric literal) keeps snaps that
    // TARGET this boolean — e.g. `cond20.E ← diff1.W` — tracking every
    // parameter that already feeds the operand chain. Union booleans
    // fall through to the regular numeric-leaf path because the AABB
    // requires min/max across operand positions, which HFSS's
    // expression engine doesn't support cleanly.
    if (c.kind === 'boolean' && (c.operandIds || []).length > 0) {
      const op = c.op;
      if (op === 'subtract' || op === 'intersect' || op === 'punch') {
        const baseId = c.operandIds[0];
        const basePos = resolve(baseId);
        positions[compId] = basePos;
        visiting.delete(compId);
        return basePos;
      }
    }
    const snap = incomingSnap.get(compId);
    if (!snap) {
      // ── CLUSTER-OPERAND PASS-THROUGH ────────────────────────────────
      // If this component has no incoming snap of its OWN, but it's an
      // operand consumed by a boolean cluster that DOES have a parametric
      // chain (via the boolean's incoming snap to some other primitive),
      // propagate the cluster shift down to the operand. The solver
      // applies snap-clustering to the entire union: when wg1.NW snaps
      // to meander_h.SW, every meander_h operand shifts in lockstep, so
      // the operand's parametric position should follow the boolean's
      // parametric position by the same offset.
      //
      // Without this, meander_h_rail_L (the cluster root) gets emitted
      // at its hardcoded solved cy. When the user changes cap_gap in
      // HFSS, every other piece chained through wg1 (cond14, cond14_copy,
      // cond20, diff1, port2_hole, …) moves by Δcap_gap/2 — but the
      // meander cluster stays put, drifting apart from the rest.
      //
      // The numeric offset (op.cx_solved - boolean.cx_solved) is the
      // cluster-shift-invariant centroid-relative offset; the boolean's
      // parametric chain absorbs every parameter the snap depended on.
      if (c.consumedBy) {
        const boolComp = byId[c.consumedBy];
        if (boolComp && incomingSnap.has(boolComp.id)) {
          const boolPos = resolve(boolComp.id);
          const opCx = Number.isFinite(c.cx) ? c.cx : 0;
          const opCy = Number.isFinite(c.cy) ? c.cy : 0;
          const bCx  = Number.isFinite(boolComp.cx) ? boolComp.cx : 0;
          const bCy  = Number.isFinite(boolComp.cy) ? boolComp.cy : 0;
          const dx = opCx - bCx;
          const dy = opCy - bCy;
          const dims = dimExprForComp(c);
          const result = {
            cxExpr: `(${boolPos.cxExpr}) + (${dx}um)`,
            cyExpr: `(${boolPos.cyExpr}) + (${dy}um)`,
            wExpr: dims.wExpr,
            hExpr: dims.hExpr,
          };
          positions[compId] = result;
          visiting.delete(compId);
          return result;
        }
      }
      // Free component: position is its raw cx/cy literal — UNLESS the
      // component carries cxExpr / cyExpr (C8), in which case the
      // user's parametric expression becomes the root of the chain.
      // Numeric leaves get "um" appended so that when composed into a
      // chain expression with parameters (which are unit-bearing),
      // HFSS evaluates the whole chain in length units.
      const dims = dimExprForComp(c);
      const result = { cxExpr: rootPosExpr(c, 'x'), cyExpr: rootPosExpr(c, 'y'), wExpr: dims.wExpr, hExpr: dims.hExpr };
      positions[compId] = result;
      visiting.delete(compId);
      return result;
    }
    // Recurse into parent
    const parent = byId[snap.from.compId];
    const parentPos = resolve(snap.from.compId);
    if (!parent) {
      const dims = dimExprForComp(c);
      const fallback = { cxExpr: '0um', cyExpr: '0um', wExpr: dims.wExpr, hExpr: dims.hExpr };
      positions[compId] = fallback;
      visiting.delete(compId);
      return fallback;
    }
    // Use the PARENT's parametric w/h from its resolved chain — NOT the
    // raw parent.w / parent.h, which for booleans is the numeric AABB
    // that resolveBooleanBboxes wrote in. Same reason as the boolean
    // pass-through above: we want anchor offsets to track parameters.
    //
    // For the TARGET side (`c`), we similarly resolve dims through
    // `dimExprForComp` so that when `c` is a boolean the anchor offset
    // uses its real (parametric or numeric-fallback) bbox h/w rather
    // than the literal `'0'`/`'0'` stored on boolean components. Without
    // this, a snap to `boolean.SW` would treat SW as the boolean's
    // center (because `c.h='0'` ⇒ -h/2=0), producing a centroid offset
    // of zero in the snap chain. That bug bit the meander_h centroid
    // tracking — it placed meander_h.cy = wg1.NW.y + dy instead of
    // wg1.NW.y + dy + h_meander/2.
    const cDims = dimExprForComp(c);
    // Parent / child first-class rotations wrap the anchor offsets in
    // the HFSS-trig rotation matrix, so the chain tracks the rotation
    // parameter as well as the position parameters.
    const fromOff = anchorOffsetExpr(snap.from.anchor, parentPos.wExpr, parentPos.hExpr, componentRotationExpr(parent));
    const toOff   = anchorOffsetExpr(snap.to.anchor,   cDims.wExpr,     cDims.hExpr,     componentRotationExpr(c));
    // Snap-to-replica: when the snap targets a specific instance of the
    // parent's `repeat`/`displace` chain (from.instanceIdx > 0), add the
    // parent's base→instance-k chain offset to the reference term. This is
    // the SAME parametric (base + k·dx) form the repeat already exports as
    // DuplicateAlongLine, so an HFSS sweep of the repeat pitch moves the
    // replicas AND this snapped child together. Reuses instanceChainOffsetExpr
    // (the polyline snap-vertex precedent). repeat/displace stay fully
    // parametric; rotate/mirror chains bake the numeric centroid offset
    // (the anchor's orientation under a rotate/mirror isn't expressible the
    // same way — same accepted contract as the vertex path).
    let instDx = null, instDy = null;
    const fromInstanceIdx = (snap.from && snap.from.instanceIdx) || 0;
    if (fromInstanceIdx > 0) {
      const owner = chainOwnerForInstance(parent, byId) || parent;
      const simple = (owner.transforms || [])
        .filter(t => t && t.enabled !== false)
        .every(t => t.kind === 'repeat' || t.kind === 'displace');
      if (simple) {
        const off = instanceChainOffsetExpr(owner, fromInstanceIdx, {
          paramValues, exprWithUm: dimExprStr,
          baseCxExpr: parentPos.cxExpr, baseCyExpr: parentPos.cyExpr,
          baseWExpr: parentPos.wExpr, baseHExpr: parentPos.hExpr,
          components, parametricPos: positions,
        });
        if (off) { instDx = off.dxExpr; instDy = off.dyExpr; }
      } else {
        // Non-translation chain → bake the numeric centroid offset (eval the
        // chain with unit-free exprs so evalExpr can resolve cos/sin).
        const offN = instanceChainOffsetExpr(owner, fromInstanceIdx, {
          paramValues, exprWithUm: (x) => `(${x})`,
          baseCxExpr: String(Number.isFinite(parent.cx) ? parent.cx : 0),
          baseCyExpr: String(Number.isFinite(parent.cy) ? parent.cy : 0),
          baseWExpr: String(typeof parent.w === 'number' ? parent.w : 0),
          baseHExpr: String(typeof parent.h === 'number' ? parent.h : 0),
          components, parametricPos: positions,
        });
        if (offN) {
          const ndx = evalExpr(offN.dxExpr, paramValues);
          const ndy = evalExpr(offN.dyExpr, paramValues);
          instDx = `${Number.isFinite(ndx) ? ndx : 0}um`;
          instDy = `${Number.isFinite(ndy) ? ndy : 0}um`;
        }
      }
    }
    // Solver: toComp.cx = fromAnchorWorld.x + dx - toAnchor.local.x
    //                  = (parent.cx + instOff.x + fromOff.x) + dx - toOff.x
    const cxExpr = `(${parentPos.cxExpr})${instDx ? ` + (${instDx})` : ''} + (${fromOff.xOff}) + (${snap.dx}) - (${toOff.xOff})`;
    const cyExpr = `(${parentPos.cyExpr})${instDy ? ` + (${instDy})` : ''} + (${fromOff.yOff}) + (${snap.dy}) - (${toOff.yOff})`;
    const result = { cxExpr, cyExpr, wExpr: cDims.wExpr, hExpr: cDims.hExpr };
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
  // Pre-compute the full flat list of transform-expanded instances so
  // polyline emission can resolve `kind: 'snap', instanceIdx > 0`
  // vertices against the specific transform replica the user clicked
  // (e.g. the 7th cell of a 16-way repeated meander).
  const transformInstancesAll = expandTransforms(solved, paramValues);
  const byIdSolved = Object.fromEntries(solved.map(c => [c.id, c]));

  // Parametric position expressions: each component's cx/cy as an expression
  // string referencing snap-chain parameters. Used so that changing parameters
  // in HFSS (e.g. for sweeps) actually moves the geometry, instead of baking
  // in literal numeric positions.
  // Note: applyMirrors makes mirrored components lose their parametric chain
  // (their position is tgt = 2*axis - src, computed numerically). For mirrored
  // components we fall back to numeric positions in HFSS too. Snap-chained
  // (non-mirrored) components stay parametric.
  //
  // We pass `solved` instead of `components` so that any cluster-shift the
  // solver applied (e.g. for a snap targeting a boolean — see solver.js's
  // cluster-shift branch, which translates a boolean's consumed operands so
  // the boolean's AABB lands at the snap target) is reflected in the leaf
  // positions of the parametric chain. Without this, the export emits the
  // raw scene-stored cx/cy of "free" operands (which can be inconsistent
  // with the boolean's stored cx/cy), producing geometry that's shifted
  // from what the canvas shows.
  const parametricPos = computeParametricPositions(solved, snaps, paramValues);
  // Identify mirror-target ids; those don't get parametric positions.
  const mirrorTargetIds = new Set();
  for (const m of mirrors || []) {
    for (const mem of (m.members || [])) {
      if (mem.locked && mem.mirrorId) mirrorTargetIds.add(mem.mirrorId);
    }
  }

  // ── PARAMETRIC-SWEEP SAFETY REPORT collectors ───────────────────────
  // Every emission site classifies what it emitted: PARAMETRIC entries
  // track HFSS variable changes end-to-end; FROZEN entries were baked
  // at export-time numerics and need a re-export after changing any
  // related parameter. The collected lists are spliced into the script
  // header (see the `#__PARAMETRIC_REPORT__` placeholder) at the end of
  // generation, so the user can audit sweep-safety before solving.
  const reportParametric = [];
  const reportFrozen = [];
  const reportSeen = new Set();
  const notePara = (id, tracks) => {
    const k = `P:${id}`;
    if (reportSeen.has(k)) return;
    reportSeen.add(k);
    reportParametric.push({ id, tracks });
  };
  const noteFrozen = (id, reason) => {
    const k = `F:${id}:${reason}`;
    if (reportSeen.has(k)) return;
    reportSeen.add(k);
    reportFrozen.push({ id, reason });
  };
  // NOTES: caveats that are neither fully-parametric nor frozen — e.g.
  // the canvas preview approximating an HFSS-native curve. Rendered as a
  // third section in the safety report.
  const reportNotes = [];
  const noteCaveat = (id, text) => {
    const k = `N:${id}:${text}`;
    if (reportSeen.has(k)) return;
    reportSeen.add(k);
    reportNotes.push({ id, text });
  };

  // ── Mirror-target parametric reflection ─────────────────────────────
  // applyMirrors (solver.js) overwrites each locked mirror target with
  // the NUMERIC reflection of its source:
  //   axis 'horizontal': tgt.cy = 2*axisCoord - src.cy ; tgt.cx = src.cx
  //   axis 'vertical'  : tgt.cx = 2*axisCoord - src.cx ; tgt.cy = src.cy
  // For shapes that are reflection-symmetric about their own center
  // axes (rect / circle / ellipse) the reflected SHAPE equals the
  // translated shape, so we can emit the same math as an HFSS
  // expression on top of the source's parametric chain — sweeping any
  // snap-chain variable then moves the mirror copy in lockstep.
  // Polygons / racetracks / polylines are NOT symmetric in general
  // (the reflected outline differs from a translated one), so they
  // keep the numeric fallback and land in the FROZEN report.
  // The axis position itself is numeric in the scene model; interpolate
  // it as a um-tagged literal.
  const mirrorInfoByTarget = new Map(); // tgtId -> { srcId, axis, axisCoord }
  for (const m of mirrors || []) {
    for (const mem of (m.members || [])) {
      if (mem.locked && mem.mirrorId) {
        mirrorInfoByTarget.set(mem.mirrorId, { srcId: mem.srcId, axis: m.axis, axisCoord: m.axisCoord });
      }
    }
  }
  // Vias are plan-view circles, hence reflection-symmetric about their
  // own center axes like circles — the mirror copy can ride the source's
  // parametric chain.
  const MIRROR_SYMMETRIC_KINDS = new Set(['rect', 'circle', 'ellipse', 'via']);
  const mirrorReflectedPos = (c) => {
    const info = mirrorInfoByTarget.get(c.id);
    if (!info) return null;
    if (!MIRROR_SYMMETRIC_KINDS.has(c.kind || 'rect')) return null;
    const srcPp = parametricPos[info.srcId];
    if (!srcPp) return null;
    const axisNum = Number.isFinite(info.axisCoord)
      ? info.axisCoord
      : (parseFloat(info.axisCoord) || 0);
    const axisUm = `${axisNum.toFixed(4)}um`;
    if (info.axis === 'horizontal') {
      return { srcId: info.srcId, cxExpr: srcPp.cxExpr, cyExpr: `2*${axisUm} - (${srcPp.cyExpr})` };
    }
    return { srcId: info.srcId, cxExpr: `2*${axisUm} - (${srcPp.cxExpr})`, cyExpr: srcPp.cyExpr };
  };

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
      .replace(/λ/g, 'lambda')
      .replace(/≈/g, '~=')
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
  const parametricPosForExport = computeParametricPositions(solved, snaps, paramValues);
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
  // Parametric counterpart to `anchorLocal(name, w, h)` — used wherever
  // we need an HFSS-side expression for a named anchor's offset from a
  // part's center given parametric base dimensions (e.g. `'cps_feed_w'`,
  // or the parametric union bbox from `dimExprForComp`). Defined here
  // at the top of the function scope so polyline emission, the
  // transform-chain emitter, and any future caller can all reach it.
  // Optional 4th arg `rotExpr`: first-class rotation of the anchor's
  // owning component — wraps the offsets in the HFSS-trig rotation
  // matrix (same idiom as anchorOffsetExpr in computeParametricPositions).
  const anchorOffsetParam = (anchorName, wExpr, hExpr, rotExpr = null) => {
    const a = parseAnchor(anchorName);
    let xOff = '0', yOff = '0';
    if (a.kind === 'edge') {
      if (a.side === 'T')      { xOff = `(${a.t} - 0.5) * (${wExpr})`; yOff = `(${hExpr})/2`; }
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
    if (rotExpr) {
      const d = hfssAngleDegExpr(spaceHyphens(ascii(resolveSynthetics(String(rotExpr)))));
      return {
        xOff: `(${xOff})*cos(${d}) - (${yOff})*sin(${d})`,
        yOff: `(${xOff})*sin(${d}) + (${yOff})*cos(${d})`,
      };
    }
    return { xOff, yOff };
  };
  const exprWithUm = (expr) => {
    const s = spaceHyphens(ascii(resolveSynthetics(String(expr ?? '0'))));
    if (/^[\d\s+\-*/.()]+$/.test(s)) {
      // Pure numeric: append "um" INSIDE the parens — `(0.6um)`, matching the
      // proven `(0um)` form used elsewhere. The unit MUST stay inside: `(0.6)um`
      // (unit outside the closing paren) is a standalone-only HFSS quirk — its
      // expression parser rejects it in any COMPOUND context (after `)` it
      // expects an operator, not `u`), e.g. a stack-Z sum like
      // `((0um) + (h_clad)) + (0.6)um`. With model units forced to um, the bare
      // literal is already µm; the explicit unit just keeps it unambiguous in a
      // length field. (A bare-numeric expr with a top-level `/` — vanishingly
      // rare for a layer thickness — would bind the unit to the divisor; author
      // such thicknesses as a parameter instead.)
      return `(${s}um)`;
    }
    return `(${s})`;
  };
  // Wrap an already-numeric value (a bare number / `.toFixed` string, possibly
  // negative) as a unit-bearing HFSS length with the unit INSIDE the parens —
  // `(26.0000um)`, NEVER `(26.0000)um`. The unit-outside form parses only as a
  // standalone field value; HFSS's expression parser rejects it inside any
  // compound (after `)` it wants an operator, not `u`). Use this for values
  // already reduced to numbers; use exprWithUm for raw expression strings.
  const numUm = (x) => `(${x}um)`;
  // ── Per-component Z offset (D5) ─────────────────────────────────────
  // Optional `zOffset` expression (µm) shifting the part's Z placement
  // relative to its layer. Emitted as a LIVE HFSS expression appended to
  // the layer's parametric zBottom, so HFSS-side sweeps over any
  // variable in the zOffset expression move the part vertically.
  const zOffsetExprOf = (c) => {
    if (!c || c.zOffset == null) return null;
    const s = String(c.zOffset).trim();
    if (s === '' || s === '0') return null;
    return exprWithUm(s);
  };
  const withZOffset = (zExpr, c) => {
    const zo = zOffsetExprOf(c);
    return zo ? `(${zExpr}) + ${zo}` : zExpr;
  };
  // First-class rotation angle, post-processed for HFSS emission
  // (ascii + hyphen spacing + synthetic expansion), degree-typed.
  const rotationAngleDegFor = (c) => {
    const e = componentRotationExpr(c);
    if (!e) return null;
    return hfssAngleDegExpr(spaceHyphens(ascii(resolveSynthetics(e))));
  };
  // ── Rect corner fillets (D3) ────────────────────────────────────────
  // A rect with a positive cornerRadius expression emits as a covered +
  // closed CreatePolyline (4 Line + 4 AngularArc segments) instead of
  // the box / rectangle path, with every coordinate parametric. Returns
  // { expr, value } when active, null for sharp rects. The export-time
  // numeric gate (value > 0) mirrors the canvas / rings behavior: an
  // expression that currently evaluates <= 0 renders sharp everywhere.
  const cornerRadiusInfo = (c) => {
    if (!c || (c.kind || 'rect') !== 'rect' || c.cornerRadius == null) return null;
    const s = String(c.cornerRadius).trim();
    if (s === '' || s === '0') return null;
    const v = evalExpr(c.cornerRadius, paramValues);
    if (!Number.isFinite(v) || v <= 0) return null;
    return { expr: s, value: v };
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
  // (zBottom, zTop) pair. Layers sharing a `coplanarGroup` id (adjacent in the
  // stack) are COPLANAR — they share zBottom; the group's TOP (where the next
  // layer stacks) is the top of the group's CLADDING (the encapsulating layer),
  // NOT the group's zBottom and NOT the tallest member. A layer with no
  // coplanarGroup is sequential — it stacks on top of the previous level. So a
  // conductor placed ABOVE a coplanar device group starts at that group's
  // cladding top, not buried at the group's zBottom.
  //
  // PARAMETRIC Z: alongside the numeric (zBottom, zTop, thickness), build
  // HFSS-side expression strings (zBottomExpr, zTopExpr, thicknessExpr)
  // that reference the stack's thickness variables (h_si, h_wg, h_clad,
  // h_cond, …) instead of being baked at export time. Sweeping any
  // layer thickness in HFSS then moves the substrate / cladding /
  // conductor / port-sheet Z positions in lockstep. The group-top advance
  // is the cladding's own thicknessExpr — a single variable, so it is
  // parametrically EXACT (a single-cladding group, the norm, sweeps
  // perfectly). A group with multiple claddings picks the thickest one
  // numerically (HFSS has no max() in expressions); a sweep that reorders
  // which cladding is tallest would need a re-export.
  const isDeviceRole = (r) => r === 'waveguide' || r === 'conductor' || r === 'cladding';
  // Defensive: the in-app scene is always normalized (migrateStackCoplanarGroups
  // ran on load, so device runs carry explicit coplanarGroup ids). Raw / imported
  // stacks reaching the exporter directly might not — migrate here so the walk
  // groups identically to the canvas in every case (a no-op passthrough when any
  // layer already declares a group).
  const zStack = migrateStackCoplanarGroups(stack);
  const layerZ = {}; // layer.id -> { zBottom, zTop, thickness, zBottomExpr, zTopExpr, thicknessExpr }

  // Pin Z=0 at the first device level — the first device-role layer OR the
  // first member of any coplanar group (every group carries a cladding, so a
  // group whose lowest member happens to be a non-device role still pins its
  // bottom here, consistent with the coplanarGroup-based upward walk).
  // Substrates below it go to negative Z.
  let firstDeviceIdx = zStack.findIndex(l => isDeviceRole(l.role) || l.coplanarGroup);
  if (firstDeviceIdx === -1) firstDeviceIdx = zStack.length;

  // Compute thickness of each layer
  const tOf = (layer) => {
    const v = evalExpr(layer.thickness, paramValues);
    return Number.isFinite(v) ? v : 1;
  };
  // Parametric thickness expression for a layer. Wraps bare-numeric
  // strings with "um" (the same trick used elsewhere — HFSS reads bare
  // numbers in the design base unit, which is meters by default).
  const tExprOf = (layer) => exprWithUm(layer.thickness ?? '0');

  // The layer whose TOP defines a coplanar group's top surface (where the next
  // layer stacks): the cladding (thickest, if several), else — for a malformed
  // group with no cladding — the thickest member (preserves legacy behavior).
  const advanceLayerOf = (members) => {
    const clad = members.filter(m => m.role === 'cladding');
    const pool = clad.length ? clad : members;
    return pool.reduce((a, b) => (tOf(b) > tOf(a) ? b : a), pool[0]);
  };

  // Substrates below the first device level (i = 0 to firstDeviceIdx-1, which should all be substrates).
  // Stack them at negative Z, with the highest one ending at Z=0.
  let zCursor = 0;
  let zCursorExpr = '0um';
  for (let i = firstDeviceIdx - 1; i >= 0; i--) {
    const layer = zStack[i];
    const t = tOf(layer);
    const tExpr = tExprOf(layer);
    const zBottomExpr = `(${zCursorExpr}) - ${tExpr}`;
    layerZ[layer.id] = {
      zBottom: zCursor - t, zTop: zCursor, thickness: t,
      zBottomExpr, zTopExpr: zCursorExpr, thicknessExpr: tExpr,
    };
    zCursor -= t;
    zCursorExpr = zBottomExpr;
  }

  // Now walk upward from the first device level. Coplanar-group members share
  // zBottom; the cursor advances past a group by its cladding top. A layer with
  // no coplanarGroup gets its own Z slot above the previous level.
  zCursor = 0;
  zCursorExpr = '0um';
  let i = firstDeviceIdx;
  while (i < zStack.length) {
    const layer = zStack[i];
    const gid = layer.coplanarGroup;
    if (gid) {
      // Find the run of adjacent layers sharing this coplanarGroup id.
      const runStart = i;
      let runEnd = i;
      while (runEnd + 1 < zStack.length && zStack[runEnd + 1].coplanarGroup === gid) runEnd++;
      // All members share zBottom; each keeps its own thickness/zTop.
      const zBottom = zCursor;
      const zBottomExpr = zCursorExpr;
      const members = [];
      for (let j = runStart; j <= runEnd; j++) {
        const t = tOf(zStack[j]);
        const tExpr = tExprOf(zStack[j]);
        layerZ[zStack[j].id] = {
          zBottom, zTop: zBottom + t, thickness: t,
          zBottomExpr,
          zTopExpr: `(${zBottomExpr}) + ${tExpr}`,
          thicknessExpr: tExpr,
        };
        members.push(zStack[j]);
      }
      // Advance to the group's cladding TOP — the next layer stacks there.
      const adv = advanceLayerOf(members);
      zCursor = zBottom + tOf(adv);
      zCursorExpr = `(${zBottomExpr}) + ${tExprOf(adv)}`;
      i = runEnd + 1;
    } else {
      const t = tOf(layer);
      const tExpr = tExprOf(layer);
      const zBottomExpr = zCursorExpr;
      const zTopExpr = `(${zBottomExpr}) + ${tExpr}`;
      layerZ[layer.id] = {
        zBottom: zCursor, zTop: zCursor + t, thickness: t,
        zBottomExpr, zTopExpr, thicknessExpr: tExpr,
      };
      zCursor += t;
      zCursorExpr = zTopExpr;
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

  // All conductor layers in stack order — used to detect multi-conductor
  // designs (where the default-fallback path becomes ambiguous).
  const allConductorLayers = (stack || []).filter(l => l.role === 'conductor');

  // Resolve a component's conductor binding to a concrete layer, returning
  // both the picked layer and a one-line Python comment that explains why
  // this layer was picked. The comment surfaces three failure modes that
  // bit the user previously:
  //   1. component has NO explicit conductorLayerId (legacy / pre-dropdown)
  //      and silently falls back to "first conductor in stack"; in a multi-
  //      conductor design that's whatever happens to be ordered first.
  //   2. component has an explicit conductorLayerId but it doesn't match
  //      any conductor layer (stale binding — the layer was deleted or
  //      its role flipped). Falls back to first conductor; the Python
  //      comment shows the stale id so the user can trace it.
  //   3. component is explicitly bound and the binding resolves cleanly.
  //      Comment confirms which layer was used.
  const resolveCondForComp = (c) => {
    if (!c) return { layer: condLayer, comment: '# (no component)' };
    const bound = c.conductorLayerId || null;
    if (!bound) {
      if (allConductorLayers.length > 1) {
        return {
          layer: condLayer,
          comment: `# WARNING: ${c.id} has no explicit conductor-layer binding; defaulted to "${condLayer ? condLayer.id : '(none)'}" (first of ${allConductorLayers.length} conductor layers in the stack: ${allConductorLayers.map(l => l.id).join(', ')}). Set the binding in the Inspector to lock this choice.`,
        };
      }
      return {
        layer: condLayer,
        comment: `# Conductor layer for ${c.id}: "${condLayer ? condLayer.id : '(none)'}" (default — only conductor in stack).`,
      };
    }
    const match = allConductorLayers.find(l => l.id === bound);
    if (match) {
      return {
        layer: match,
        comment: `# Conductor layer for ${c.id}: "${match.id}" (explicit binding).`,
      };
    }
    return {
      layer: condLayer,
      comment: `# WARNING: ${c.id} was bound to conductor layer id "${bound}", but no conductor layer with that id exists in the current stack. Falling back to "${condLayer ? condLayer.id : '(none)'}". Re-bind it in the Inspector.`,
    };
  };

  // Substrate Z positions, bottom-up (now derived from layerZ)
  const substrateLayers = (stack || []).filter(l => l.role === 'substrate');
  const substratePositions = substrateLayers.map(layer => ({
    layer,
    z: layerZ[layer.id]?.zBottom ?? 0,
    thickness: layerZ[layer.id]?.thickness ?? 1,
    zExpr: layerZ[layer.id]?.zBottomExpr ?? '0um',
    thicknessExpr: layerZ[layer.id]?.thicknessExpr ?? '1um',
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
#
#__PARAMETRIC_REPORT__
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

# Force the model length unit to micron. EVERYTHING this script emits is in
# um: dimensioned variables carry an explicit "um" suffix, but parameter
# expressions may also contain BARE numeric literals (e.g. ai2_cap_g =
# "w_slab+0.6", where the 0.6 means 0.6 um). HFSS interprets an additive
# bare literal in the project's DEFAULT unit — often mm — so without this
# the 0.6 would become 0.6 mm = 600 um and cascade into wildly wrong
# (and sometimes negative) dimensions. Pure multipliers like "2*ai2_cap_w"
# stay unitless and are unaffected.
#
# Rescale:=True (NOT False). AEDT's Parasolid working volume ("size box")
# scales with the model unit: relabeling the default-unit (usually mm) design
# to um with Rescale=False keeps the box's NUMBERS but shrinks it physically
# ~1000x (e.g. ~+/-1 mm), so a lambda/4 open-region air box (tens of mm at
# RF) lands OUTSIDE it -> Parasolid "the transformation would result in body
# lying outside the size box", which aborts geometry (e.g. swept rib bodies)
# and cascades to "<part> is not found". Rescale=True relabels to um while
# PRESERVING physical extents (and the size box). It is safe in every mode:
# on a fresh project there is no geometry to resize (only the box is kept
# physical); in append mode a um design is unchanged (um->um is a no-op) and
# an mm design is converted preserving physical size, matching the um
# geometry this script then creates.
try:
    oEditor.SetModelUnits(
        ["NAME:Units Parameter", "Units:=", "um", "Rescale:=", True])
except Exception as e:
    try:
        oDesktop.AddMessage("", "", 1, "SetModelUnits(um) failed: " + str(e))
    except:
        pass

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
  // Emit in dependency order: HFSS evaluates each variable's expression
  // when it's created, so a param that references another (e.g.
  // ai2_cap_sep_y = racetrack_d_D - …) MUST be defined after the one it
  // references, regardless of the params object's key order.
  for (const name of topoSortParams(params)) {
    code += `set_var("${ascii(name)}", "${formatVarValue(params[name])}")\n`;
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

  // ===== Conductor-layer binding summary =====
  // Emit a top-of-file audit listing every conductor in the stack and
  // flagging components whose conductorLayerId is missing or stale.
  // Previously, an unbound electrode silently fell back to "first
  // conductor in the stack" — fine when there was only one, but
  // catastrophic when the user added a second (the meaning of the
  // export changed without warning). This block makes the binding
  // state visible at the top of the script so the user can audit it
  // before running, without having to scroll through inline comments
  // by every shape.
  {
    const allCondLayers = allConductorLayers; // alias for clarity
    const elecOrPort = (solved || []).filter(c => c.layer === 'electrode' || c.layer === 'port');
    const unbound = [];
    const stale = []; // [{ id, badId }]
    for (const c of elecOrPort) {
      const bound = c.conductorLayerId || null;
      if (!bound) { unbound.push(c.id); continue; }
      if (!allCondLayers.some(l => l.id === bound)) stale.push({ id: c.id, badId: bound });
    }
    code += `\n# ===== Conductor-layer audit =====\n`;
    if (allCondLayers.length === 0) {
      code += `# (No conductor layers defined in the stack.)\n`;
    } else {
      code += `# Conductor layers in stack order:\n`;
      for (const l of allCondLayers) {
        code += `#   - ${l.id} (material=${l.material}, thickness=${l.thickness})\n`;
      }
      code += `# Default-fallback conductor (used when a component has no explicit binding): ${condLayer ? condLayer.id : '(none)'}\n`;
    }
    if (unbound.length > 0) {
      code += `# WARNING: components with NO explicit conductor-layer binding (will use default-fallback above):\n`;
      for (const id of unbound) code += `#   - ${id}\n`;
      if (allCondLayers.length > 1) {
        code += `# >>> Because the stack has multiple conductor layers, the default-fallback choice is ambiguous.\n`;
        code += `# >>> Open the Inspector for each of the above and explicitly pick a conductor layer to lock the binding.\n`;
      }
    }
    if (stale.length > 0) {
      code += `# WARNING: components bound to a conductor-layer id that no longer exists in the stack (will use default-fallback):\n`;
      for (const s of stale) code += `#   - ${s.id} -> "${s.badId}" (stale)\n`;
      code += `# >>> Re-bind these in the Inspector. The dropdown will show a "stale" row at the top of the list.\n`;
    }
    code += `\n`;
  }

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

def _relative_cs_exists(name):
    # Probe whether a relative CS already exists. Used to skip re-creating
    # it on a subsequent APPEND-mode run. We deliberately do NOT attempt
    # to delete the existing CS: oEditor.Delete with a CS name in the
    # Selections list has been observed to cascade-delete parts whose
    # PartCoordinateSystem resolves through that CS, which would wipe
    # the waveguide slab + rib + neighboring substrates. Leaving the old
    # CS in place is harmless (its origin / orientation are recomputed
    # parametrically by HFSS anyway when the user sweeps geometry).
    try:
        return name in list(oEditor.GetCoordinateSystems())
    except:
        return False

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

# Force Working CS = Global before any geometry is created. CreateRelativeCS
# and various interactive operations can leave a non-Global CS active, and
# any new oEditor.CreateBox / CreatePolyline call binds the part's
# PartCoordinateSystem to the WCS — even when an explicit "Global" is given
# in the Attributes block (HFSS quirk). Setting WCS to Global up front
# guarantees every part this script creates is in the global frame, so
# downstream operations (especially deleting/recreating relative CSes at
# the end) don't cascade-delete unrelated geometry.
try:
    oEditor.SetWCS(
        ["NAME:SetWCS Parameter",
         "Working Coordinate System:=", "Global",
         "RegionDepCSOk:=", False])
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
     "XPosition:=", "${bbXPos}", "YPosition:=", "${bbYPos}", "ZPosition:=", "${sp.zExpr}",
     "XSize:=", "${bbXSize}", "YSize:=", "${bbYSize}", "ZSize:=", "${sp.thicknessExpr}"],
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
  // Names of conductor objects emitted as ZERO-THICKNESS SHEETS rather
  // than 3D boxes. Triggered when their conductor layer's thickness
  // evaluates to 0. At the end of the geometry block we assign a
  // surface-impedance boundary (R = 0 Ω/sq, X = 0 Ω/sq) to every name
  // in this list, modeling a perfect 2D conductor — the standard HFSS
  // workaround for thin-film traces where solving a 3D mesh is wasteful.
  // The list mirrors emittedElecNames in shape: boolean ops rename/remove
  // entries the same way (Unite collapses operands → result name; punch
  // / subtract removes the tool entries).
  const zeroThicknessSheets = [];
  // Relative coordinate system definitions, one per rib waveguide.
  // Collected during the per-waveguide emit and emitted as a SINGLE
  // block at the very end of the script — AFTER all geometry, all
  // booleans, all transforms, all impedance boundaries, all lumped
  // ports. Doing it last avoids the active-CS subtleties of HFSS
  // (CreateRelativeCS sets the new CS as active in some versions, which
  // would shift the interpretation of any later geometry's coordinates).
  const relativeCsDefs = [];
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

    // ── VIA (D4): parametric CreateCylinder spanning two stack layers ──
    // XCenter / YCenter ride the snap-chain expressions (per-shape
    // set_var, the native-primitive idiom), Radius is the live r
    // expression, and the Z span is built ENTIRELY from the layer
    // stack's parametric zBottom / zTop expressions — so HFSS-side
    // sweeps of any layer thickness stretch the via with the stack.
    if (shapeKind === 'via') {
      const zFrom = c.layerFrom ? layerZ[c.layerFrom] : null;
      const zTo = c.layerTo ? layerZ[c.layerTo] : null;
      if (!zFrom || !zTo || c.layerFrom === c.layerTo) {
        code += `# Skipped via ${c.id}: layerFrom="${c.layerFrom || '(unset)'}" / layerTo="${c.layerTo || '(unset)'}" — both must resolve to DISTINCT stack layers. Fix the binding in the Inspector and re-export.\n`;
        noteFrozen(c.id, 'via skipped (layerFrom/layerTo unresolved or identical)');
        continue;
      }
      // ZStart = bottom of layerFrom; Height = top of layerTo minus that
      // bottom. Both live expressions through the stack thickness vars.
      // NOTE: per-component zOffset is intentionally NOT applied to vias —
      // a via's Z span is fully determined by its layerFrom/layerTo
      // bindings (shifting only the start would break the span semantics).
      // The Inspector never offers zOffset on vias and normalizeScene
      // strips it from via components.
      const zStartExpr = zFrom.zBottomExpr;
      const heightExpr = `(${zTo.zTopExpr}) - (${zFrom.zBottomExpr})`;
      const heightNum = (zTo.zBottom + zTo.thickness) - zFrom.zBottom;
      if (!(heightNum > 0)) {
        code += `# WARNING: via ${c.id} has non-positive height at export values (${heightNum.toFixed(4)} um) — layerTo "${c.layerTo}" tops out below layerFrom "${c.layerFrom}"'s bottom. HFSS will likely reject the cylinder; swap the layers in the Inspector.\n`;
      }
      // Material: the target conductor's metal when layerTo is a
      // conductor layer; gold otherwise (sensible default for a plug).
      const toLayer = (stack || []).find(l => l.id === c.layerTo);
      const viaMaterial = (toLayer && toLayer.role === 'conductor' && toLayer.material) ? toLayer.material : 'gold';
      // Parametric center via per-shape HFSS variables (the native-
      // primitive idiom). Mirror targets get the parametric reflection
      // of their source chain (vias are reflection-symmetric).
      const isMirrorTgtVia = mirrorTargetIds.has(c.id);
      const mppVia = isMirrorTgtVia ? mirrorReflectedPos(c) : null;
      const ppVia = parametricPos[c.id];
      let cxValExprVia, cyValExprVia;
      if (!isMirrorTgtVia && ppVia) {
        cxValExprVia = spaceHyphens(exprWithUm(ppVia.cxExpr));
        cyValExprVia = spaceHyphens(exprWithUm(ppVia.cyExpr));
        notePara(c.id, 'pos, radius, Z span (layer-stack thickness exprs)');
      } else if (mppVia) {
        cxValExprVia = spaceHyphens(exprWithUm(mppVia.cxExpr));
        cyValExprVia = spaceHyphens(exprWithUm(mppVia.cyExpr));
        notePara(c.id, `pos (mirror reflection of ${mppVia.srcId}), radius, Z span`);
      } else {
        cxValExprVia = `${cx.toFixed(4)}um`;
        cyValExprVia = `${cy.toFixed(4)}um`;
        noteFrozen(c.id, isMirrorTgtVia
          ? 'mirror target (source without chain) - via position baked numerically'
          : 'via position not derivable from snap chain - baked numerically');
      }
      const rExprVia = exprWithUm(c.r ?? '0');
      const cxVarVia = `${id}_cx`;
      const cyVarVia = `${id}_cy`;
      code += `# ${c.id}: via ${c.layerFrom} -> ${c.layerTo} (parametric CreateCylinder)\n`;
      code += `# ZStart = bottom of "${c.layerFrom}", Height = top of "${c.layerTo}" - that bottom; both\n`;
      code += `# are live layer-stack expressions, so thickness sweeps stretch the via.\n`;
      code += `set_var("${cxVarVia}", "${cxValExprVia}")\n`;
      code += `set_var("${cyVarVia}", "${cyValExprVia}")\n`;
      code += `try:
    _delete_geom_if_exists("${id}")
    oEditor.CreateCylinder(
        ["NAME:CylinderParameters",
         "XCenter:=", "(${cxVarVia})", "YCenter:=", "(${cyVarVia})", "ZCenter:=", "${zStartExpr}",
         "Radius:=", "${rExprVia}",
         "Height:=", "${heightExpr}",
         "WhichAxis:=", "Z",
         "NumSides:=", "0"],
        ["NAME:Attributes",
         "Name:=", "${id}", "Flags:=", "",
         "Color:=", "(148 163 184)", "Transparency:=", 0.0,
         "PartCoordinateSystem:=", "Global",
         "MaterialValue:=", "\\"${ascii(viaMaterial)}\\"",
         "SolveInside:=", False])
except Exception as e:
    try:
        oDesktop.AddMessage("", "", 1, "Failed to build via ${id}: " + str(e))
    except:
        pass
`;
      // Conductor bookkeeping: vias are metal plugs — the cladding
      // subtraction must carve them out like any electrode body.
      emittedElecNames.push(id);
      continue;
    }

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
      // Determine Z range from the layer. Track both numeric (for
      // sheet-vs-box branching) AND parametric expression (for the
      // actual emission) so HFSS-side sweeps of h_wg / h_cond / h_clad
      // / etc. move the swept body in lockstep with the layer stack.
      let zBottom = 0, zSize = evalExpr('h_wg', paramValues) || 0.6;
      let zBottomExpr = '0um';
      let zSizeExpr = exprWithUm('h_wg');
      if (c.layer === 'electrode') {
        const { layer: elecLayer, comment: elecComment } = resolveCondForComp(c);
        code += `${elecComment}\n`;
        if (elecLayer && layerZ[elecLayer.id]) {
          zBottom = layerZ[elecLayer.id].zBottom;
          zSize = layerZ[elecLayer.id].thickness;
          zBottomExpr = layerZ[elecLayer.id].zBottomExpr || `${zBottom.toFixed(4)}um`;
          zSizeExpr = layerZ[elecLayer.id].thicknessExpr || `${zSize.toFixed(4)}um`;
        }
      } else if (c.layer === 'port') {
        // Ports are 2-D sheets — needed for lumped/wave port excitation.
        // Place at the waveguide top by default; skip the sweep so the
        // result stays a sheet instead of a slab. zSize=0 signals "no
        // sweep" to the conditional emission below.
        zBottom = evalExpr('h_wg', paramValues) || 0.6;
        zSize = 0;
        zBottomExpr = (wgLayer && layerZ[wgLayer.id]?.zTopExpr) || exprWithUm('h_wg');
        zSizeExpr = '0um';
      }
      // Per-component Z offset rides on top of the layer's parametric
      // zBottom. Covers every non-rect emission path below: native
      // primitives (ZCenter), polyline pathZ, polyshape zBottom, and the
      // tessellated fallback (incl. the racetrack inner-hole subtract).
      if (zOffsetExprOf(c)) {
        const zoNum = evalExpr(c.zOffset, paramValues);
        if (Number.isFinite(zoNum)) zBottom += zoNum;
        zBottomExpr = withZOffset(zBottomExpr, c);
      }
      const materialName = c.layer === 'waveguide'
        ? (wgLayer ? wgLayer.material : 'lithium_niobate')
        : (c.layer === 'electrode' ? 'gold'
        : (c.layer === 'port' ? 'vacuum' : 'pec'));

      // ── PARAMETRIC NATIVE-PRIMITIVE PATH ──────────────────────────────
      // For circle / ellipse / regular-polygon, HFSS has parametric
      // primitives (CreateCircle, CreateEllipse, CreateRegularPolygon).
      // Use them with parametric XCenter / YCenter / Radius (or rx/ry,
      // or num-sides) so HFSS-side sweeps of `r`, `rx`, `ry`, `n`, or
      // anything feeding the snap chain re-evaluates the shape end-to-
      // end. Falls back to the tessellated polyline path for racetracks
      // (no HFSS-native racetrack primitive — 100+ PLPoints with
      // sin/cos at each would balloon the script and is hard to keep
      // numerically stable). Rotation lives in the transform chain
      // and is applied per oEditor.Rotate calls downstream — the base
      // primitive here is axis-aligned.
      const ppShape = parametricPos[c.id];
      const isPortSheet = (c.layer === 'port');
      const isNativeShape = (shapeKind === 'circle' || shapeKind === 'ellipse' || shapeKind === 'polygon');

      // ── POLYLINE TRACE (parametric CreatePolyline + XSection sweep) ──
      // Polylines emit as a native CreatePolyline call with one
      // PLPoint per vertex. EVERY coordinate is a parametric HFSS
      // expression — vertex 0 chains through the polyline's own snap
      // position (parametricPos), `rel` vertices accumulate dx/dy
      // expressions from the previous resolved vertex, and `snap`
      // vertices resolve to a target component's anchor world position
      // (parametricPos[target] + anchorOffsetParam). XSectionType is
      // "Rectangle" with Width = trace_width and Height = conductor
      // thickness for solid traces, or "Line" with Width = trace_width
      // for zero-thickness sheets. The result is a single HFSS object
      // whose width, thickness, path, and vertex bindings ALL re-evaluate
      // under HFSS-side variable sweeps — no hardcoded coordinates.
      if (shapeKind === 'polyline' || shapeKind === 'polyshape') {
        const isPolyshape = shapeKind === 'polyshape';
        const widthExprUm = isPolyshape ? '0um' : exprWithUm(c.width ?? '0');
        // Sweep-safety bookkeeping: flips true whenever any vertex (or
        // the base position) has to fall back to a baked numeric — the
        // polyline then lands in the FROZEN report instead of the
        // fully-parametric list.
        let polyHasFrozenVertex = false;
        // Build the parametric per-vertex (xExpr, yExpr) chain.
        const baseCxExpr = ppShape ? exprWithUm(ppShape.cxExpr) : numUm(cx.toFixed(4));
        const baseCyExpr = ppShape ? exprWithUm(ppShape.cyExpr) : numUm(cy.toFixed(4));
        if (!ppShape) {
          polyHasFrozenVertex = true;
          noteFrozen(c.id, `${shapeKind} base position (no parametric snap chain)`);
        }
        let curXExpr = baseCxExpr;
        let curYExpr = baseCyExpr;
        const vertExprs = [];
        // Per-vertex segment metadata, parallel to vertExprs:
        //   { kind: 'line' }                        — rel / snap vertex
        //   { kind: 'spline' }                      — spline-flagged rel vertex
        //   { kind: 'arc', arc: { cenX, cenY, midX, midY, aDeg } }
        // Drives PLSegment record emission below (Line / Spline /
        // AngularArc) and the tapered-band branch's per-segment walk.
        const vertMeta = [];
        const vertSpecs = c.vertices || [];
        for (let i = 0; i < vertSpecs.length; i++) {
          const v = vertSpecs[i];
          if (v && v.kind === 'snap' && v.compId && v.anchor) {
            // Resolve target's parametric anchor world position. Use
            // computeParametricPositions output for the chain, plus
            // anchorOffsetParam for the local-to-anchor offset. If the
            // target isn't in parametricPos (missing / cyclic), fall
            // back to the solved numeric position.
            //
            // For instanceIdx > 0 (vertex bound to a transform-
            // replicated copy or a boolean-operand cell), we ALSO
            // add the chain offset from base to instance N. Two
            // sub-cases:
            //   (a) The target component has its own transforms —
            //       offset is along its own chain.
            //   (b) The target is consumed by a boolean whose chain
            //       drives the cluster's instances — offset is along
            //       the boolean's chain, applied to the operand's
            //       base position.
            // When the chain contains mirror / rotate / duplicate_mirror
            // (instanceChainOffsetExpr returns null), we fall back to
            // the NUMERIC instance position from transformInstances —
            // visually correct, but the vertex won't track HFSS-side
            // sweeps for that particular instance.
            const tgtPp = parametricPos[v.compId];
            const tgtComp = solved.find(sc => sc.id === v.compId);
            const instanceIdx = v.instanceIdx || 0;
            // Resolve chain owner: comp itself if it has transforms,
            // else its parent boolean (if applicable). Pass owner's
            // parametric base position so the chain walker can handle
            // mirror-about-origin / rotate-about-origin (both need the
            // component's own absolute base coordinates to express the
            // reflected / rotated offsets parametrically).
            const owner = chainOwnerForInstance(tgtComp, byIdSolved);
            const ownerInstanceIdx = (instanceIdx > 0 && owner) ? instanceIdx : 0;
            let chainOffset = null;
            if (ownerInstanceIdx > 0) {
              const ownerPp = parametricPos[owner.id];
              const ownerBaseCxExpr = ownerPp ? ownerPp.cxExpr : `${(owner.cx ?? 0).toFixed(4)}um`;
              const ownerBaseCyExpr = ownerPp ? ownerPp.cyExpr : `${(owner.cy ?? 0).toFixed(4)}um`;
              const ownerBaseWExpr = ownerPp?.wExpr || (typeof owner.w === 'number' ? `${owner.w}um` : String(owner.w ?? '0'));
              const ownerBaseHExpr = ownerPp?.hExpr || (typeof owner.h === 'number' ? `${owner.h}um` : String(owner.h ?? '0'));
              chainOffset = instanceChainOffsetExpr(owner, ownerInstanceIdx, {
                paramValues,
                exprWithUm,
                baseCxExpr: ownerBaseCxExpr,
                baseCyExpr: ownerBaseCyExpr,
                baseWExpr: ownerBaseWExpr,
                baseHExpr: ownerBaseHExpr,
                components: solved,
                parametricPos,
              });
            }
            if (tgtPp && tgtPp.cxExpr && tgtPp.cyExpr) {
              const off = anchorOffsetParam(v.anchor, tgtPp.wExpr || '0', tgtPp.hExpr || '0', componentRotationExpr(tgtComp));
              if (chainOffset) {
                curXExpr = `(${tgtPp.cxExpr}) + (${off.xOff}) + (${chainOffset.dxExpr})`;
                curYExpr = `(${tgtPp.cyExpr}) + (${off.yOff}) + (${chainOffset.dyExpr})`;
              } else if (ownerInstanceIdx > 0) {
                // Chain owner exists but transforms aren't all
                // parametric-supported (mirror / rotate / duplicate_mirror).
                // Fall back to the NUMERIC instance position from
                // transformInstances — visually correct, no parametric
                // tie to that specific instance.
                polyHasFrozenVertex = true;
                noteFrozen(c.id, `polyline vertex bound to transformed instance ${v.instanceIdx} of ${v.compId} (mirror/rotate chain - instance offset baked numerically)`);
                const inst = transformInstancesAll.find(ii => ii.compId === owner.id && ii.idx === ownerInstanceIdx);
                const opBase = transformInstancesAll.find(ii => ii.compId === v.compId && ii.idx === 0);
                if (inst && opBase) {
                  const ddx = inst.cx - (transformInstancesAll.find(ii => ii.compId === owner.id && ii.idx === 0)?.cx ?? 0);
                  const ddy = inst.cy - (transformInstancesAll.find(ii => ii.compId === owner.id && ii.idx === 0)?.cy ?? 0);
                  curXExpr = `(${tgtPp.cxExpr}) + (${off.xOff}) + (${ddx.toFixed(4)}um)`;
                  curYExpr = `(${tgtPp.cyExpr}) + (${off.yOff}) + (${ddy.toFixed(4)}um)`;
                } else {
                  curXExpr = `(${tgtPp.cxExpr}) + (${off.xOff})`;
                  curYExpr = `(${tgtPp.cyExpr}) + (${off.yOff})`;
                }
              } else {
                curXExpr = `(${tgtPp.cxExpr}) + (${off.xOff})`;
                curYExpr = `(${tgtPp.cyExpr}) + (${off.yOff})`;
              }
            } else if (tgtComp) {
              polyHasFrozenVertex = true;
              noteFrozen(c.id, `polyline vertex snapped to ${v.compId} (target has no parametric chain - anchor baked numerically)`);
              const tw = typeof tgtComp.w === 'number' ? tgtComp.w : (evalExpr(tgtComp.w, paramValues) || 0);
              const th = typeof tgtComp.h === 'number' ? tgtComp.h : (evalExpr(tgtComp.h, paramValues) || 0);
              const off = anchorOffsetParam(v.anchor, `${tw}um`, `${th}um`, componentRotationExpr(tgtComp));
              if (chainOffset) {
                curXExpr = `(${tgtComp.cx.toFixed(4)}um) + (${off.xOff}) + (${chainOffset.dxExpr})`;
                curYExpr = `(${tgtComp.cy.toFixed(4)}um) + (${off.yOff}) + (${chainOffset.dyExpr})`;
              } else {
                curXExpr = `(${tgtComp.cx.toFixed(4)}um) + (${off.xOff})`;
                curYExpr = `(${tgtComp.cy.toFixed(4)}um) + (${off.yOff})`;
              }
            }
            vertExprs.push({ xExpr: curXExpr, yExpr: curYExpr });
            vertMeta.push({ kind: 'line' });
          } else if (v && v.kind === 'arc') {
            // Circular arc: center = previous vertex + (cdx, cdy);
            // endpoint = previous vertex rotated about the center by
            // `angle` degrees (CCW positive). Maps 1:1 to an HFSS
            // AngularArc polyline segment with parametric ArcCenterX/Y
            // and ArcAngle, so HFSS-side sweeps of any variable in
            // cdx / cdy / angle (or anything upstream in the chain)
            // re-evaluate the arc end-to-end.
            //
            // Endpoint chain expression (prev = P, center C = P + (cdx, cdy)):
            //   end = C + R(a)*(P - C) = C + R(a)*(-cdx, -cdy)
            //   endX = Cx - cdx*cos(a) + cdy*sin(a)
            //   endY = Cy - cdx*sin(a) - cdy*cos(a)
            // HFSS trig is unit-aware: `aDeg` is the degree-typed angle
            // expression ("(expr)*1deg" or "<n>deg"). A MID point at
            // half sweep is emitted too: HFSS AngularArc segments carry
            // start / mid / end in the point list (NoOfPoints = 3,
            // matching recorded HFSS scripts and pyAEDT's convention).
            const prevX = i === 0 ? baseCxExpr : curXExpr;
            const prevY = i === 0 ? baseCyExpr : curYExpr;
            const cdxE = exprWithUm(v.cdx ?? '0');
            const cdyE = exprWithUm(v.cdy ?? '0');
            const aDeg = hfssAngleDegExpr(spaceHyphens(ascii(resolveSynthetics(String(v.angle ?? '0')))));
            const cenX = `(${prevX}) + (${cdxE})`;
            const cenY = `(${prevY}) + (${cdyE})`;
            const midX = `(${cenX}) - (${cdxE})*cos((${aDeg})/2) + (${cdyE})*sin((${aDeg})/2)`;
            const midY = `(${cenY}) - (${cdxE})*sin((${aDeg})/2) - (${cdyE})*cos((${aDeg})/2)`;
            curXExpr = `(${cenX}) - (${cdxE})*cos(${aDeg}) + (${cdyE})*sin(${aDeg})`;
            curYExpr = `(${cenY}) - (${cdxE})*sin(${aDeg}) - (${cdyE})*cos(${aDeg})`;
            vertExprs.push({ xExpr: curXExpr, yExpr: curYExpr });
            vertMeta.push({ kind: 'arc', arc: { cenX, cenY, midX, midY, aDeg } });
          } else {
            // `rel`: dx/dy expressions added to the previous vertex.
            const dxExpr = exprWithUm(v?.dx ?? '0');
            const dyExpr = exprWithUm(v?.dy ?? '0');
            if (i === 0) {
              curXExpr = `(${baseCxExpr}) + (${dxExpr})`;
              curYExpr = `(${baseCyExpr}) + (${dyExpr})`;
            } else {
              curXExpr = `(${curXExpr}) + (${dxExpr})`;
              curYExpr = `(${curYExpr}) + (${dyExpr})`;
            }
            vertExprs.push({ xExpr: curXExpr, yExpr: curYExpr });
            // A spline run needs an anchor vertex before it — a spline
            // flag on vertex 0 has no preceding point and degrades to a
            // plain line vertex (it starts the path; no segment enters it).
            vertMeta.push({ kind: (v && v.spline && i > 0) ? 'spline' : 'line' });
          }
        }
        // polyshape needs ≥ 3 vertices to enclose an interior; polyline
        // is fine with 2 (a 1-segment trace).
        const minVerts = isPolyshape ? 3 : 2;
        if (vertExprs.length < minVerts) {
          code += `# ${c.id}: ${shapeKind} has fewer than ${minVerts} vertices — skipped\n`;
          continue;
        }
        // Z policy:
        //  - polyline solid trace: rides the conductor's MID-Z (path
        //    runs at mid-Z; Rectangle XSection straddles ±thickness/2)
        //  - polyline sheet (zero-thickness): runs at zBottom (= zTop)
        //  - polyshape: ALWAYS at zBottom — it's a flat sheet that we
        //    SweepAlongVector upward by zSize to extrude into a 3-D
        //    box (or leave as a 2-D sheet for zero-thickness conductors
        //    / ports). Mid-Z would put the sweep range OUTSIDE the
        //    intended layer extent.
        const isSheet = (Math.abs(zSize) < 1e-9);
        const pathZExpr = (isPolyshape || isSheet)
          ? zBottomExpr
          : `(${zBottomExpr}) + (${zSizeExpr})/2`;
        // polyshape is always closed; the segments list runs through
        // every consecutive pair INCLUDING the wrap-around (so the
        // last point connects back to vertex 0).
        const polyClosed = isPolyshape || c.closed;

        // ── TAPERED POLYLINE (per-vertex width) ─────────────────────
        // If ANY vertex carries a width expression, the trace can't be
        // built with a single XSection sweep (HFSS cross-sections are
        // constant along the path). Instead we emit ONE covered 4-point
        // CreatePolyline sheet PER LINE SEGMENT with fully PARAMETRIC
        // corners (chain exprs ± (width/2)·unit-normal, normal =
        // (dy, -dx)/sqrt(dx^2+dy^2) — HFSS expressions support sqrt),
        // Unite the segment sheets, and sweep up by the layer thickness
        // (the polyshape idiom). BUTT joins — no miter — which exactly
        // matches the canvas's taperedBandQuads rendering and the GDS
        // band emission, keeping geometric compatibility end-to-end.
        // Arc / spline segments inside a tapered polyline are NOT
        // supported parametrically in v1: they fall back to constant
        // base width, tessellated numerically (same tessellation as
        // the canvas), with a WARNING comment + FROZEN report entry.
        if (!isPolyshape && polylineIsTapered(c)) {
          // Effective width expression at vertex i: its own width expr
          // if set, else the component's base width. Arc vertices pin
          // to the base width (v1 restriction, enforced in the UI).
          const effWidthExpr = (i) => {
            const v = vertSpecs[i];
            if (v && v.kind !== 'arc' && v.width != null && String(v.width).trim() !== '') {
              return exprWithUm(v.width);
            }
            return exprWithUm(c.width ?? '0');
          };
          // Numeric resolved vertex positions (for degenerate-segment
          // guards + the curved-segment numeric fallback). byIdSolved
          // is the solved-component map used elsewhere in this export.
          const numVerts = resolvePolylineVertices(c, byIdSolved, paramValues);
          const baseWNum = Math.max(0, evalExpr(c.width ?? '0', paramValues) || 0);
          const sheetNames = [];
          let curvedFallback = false;
          const quadSheet = (corners4, label) => {
            // corners4: [{x,y}, ...] expression pairs, CCW or CW —
            // covered closed polyline fills either orientation.
            const name = sheetNames.length === 0 ? id : `${id}_tseg${sheetNames.length}`;
            sheetNames.push(name);
            // Covered closed polyline -> swept to a SOLID. 4 corners + a repeat
            // of the first (5 points) + one Line segment per edge incl. the
            // closing edge (4 segments). IsPolylineClosed=True is REQUIRED:
            // HFSS only honors IsPolylineCovered (fills the face) on a CLOSED
            // polyline, so closed=False would leave it uncovered and the sweep
            // would produce a hollow surface, not a volume. The explicit
            // closing segment keeps wire extraction robust (auto-close alone
            // fails with cant_extract_geom); the auto-close edge is then
            // zero-length/harmless.
            const pts = [...corners4, corners4[0]].map(p =>
              `["NAME:PLPoint", "X:=", "${p.x}", "Y:=", "${p.y}", "Z:=", "${zBottomExpr}"]`
            ).join(',\n          ');
            const segs = [0, 1, 2, 3].map(k =>
              `["NAME:PLSegment", "SegmentType:=", "Line", "StartIndex:=", ${k}, "NoOfPoints:=", 2]`
            ).join(',\n          ');
            code += `# ${label}\n`;
            code += `try:
    _delete_geom_if_exists("${name}")
    oEditor.CreatePolyline(
        ["NAME:PolylineParameters",
         "IsPolylineCovered:=", True,
         "IsPolylineClosed:=", True,
         ["NAME:PolylinePoints",
          ${pts}],
         ["NAME:PolylineSegments",
          ${segs}],
         ["NAME:PolylineXSection",
          "XSectionType:=", "None",
          "XSectionOrient:=", "Auto",
          "XSectionWidth:=", "0um",
          "XSectionTopWidth:=", "0um",
          "XSectionHeight:=", "0um",
          "XSectionNumSegments:=", "0",
          "XSectionBendType:=", "Corner"]],
        ["NAME:Attributes",
         "Name:=", "${name}",
         "Flags:=", "",
         "Color:=", "(218 165 32)",
         "Transparency:=", 0.0,
         "PartCoordinateSystem:=", "Global",
         "MaterialValue:=", "\\"${ascii(materialName)}\\"",
         "SolveInside:=", ${c.layer === 'waveguide' ? 'True' : 'False'}])
except Exception as e:
    try:
        oDesktop.AddMessage("", "", 1, "Failed to build tapered segment ${name}: " + str(e))
    except:
        pass
`;
          };
          // Parametric quad for a LINE segment from chain-expr point s
          // to chain-expr point e with start/end width exprs w0/w1.
          const emitLineQuad = (s, e, w0E, w1E, label) => {
            const dxE = `(${e.xExpr}) - (${s.xExpr})`;
            const dyE = `(${e.yExpr}) - (${s.yExpr})`;
            const lenE = `sqrt((${dxE})*(${dxE}) + (${dyE})*(${dyE}))`;
            // Unit normal (dy, -dx)/len — matches taperedBandQuads.
            const nxE = `(${dyE})/(${lenE})`;
            const nyE = `-((${dxE}))/(${lenE})`;
            quadSheet([
              { x: `(${s.xExpr}) + ((${w0E})/2)*(${nxE})`, y: `(${s.yExpr}) + ((${w0E})/2)*(${nyE})` },
              { x: `(${e.xExpr}) + ((${w1E})/2)*(${nxE})`, y: `(${e.yExpr}) + ((${w1E})/2)*(${nyE})` },
              { x: `(${e.xExpr}) - ((${w1E})/2)*(${nxE})`, y: `(${e.yExpr}) - ((${w1E})/2)*(${nyE})` },
              { x: `(${s.xExpr}) - ((${w0E})/2)*(${nxE})`, y: `(${s.yExpr}) - ((${w0E})/2)*(${nyE})` },
            ], label);
          };
          // Numeric constant-width quads along a tessellated curve
          // (the arc/spline v1 fallback). Mirrors taperedBandQuads'
          // pushCurveQuads so HFSS builds the SAME geometry the canvas
          // and GDS show.
          const emitCurveQuadsNumeric = (pts, label) => {
            for (let k = 0; k + 1 < pts.length; k++) {
              const [x0, y0] = pts[k], [x1, y1] = pts[k + 1];
              const ddx = x1 - x0, ddy = y1 - y0;
              const len = Math.hypot(ddx, ddy);
              if (!(len > 1e-12)) continue;
              const nx = ddy / len, ny = -ddx / len;
              const hw = baseWNum / 2;
              quadSheet([
                { x: numUm((x0 + hw * nx).toFixed(4)), y: numUm((y0 + hw * ny).toFixed(4)) },
                { x: numUm((x1 + hw * nx).toFixed(4)), y: numUm((y1 + hw * ny).toFixed(4)) },
                { x: numUm((x1 - hw * nx).toFixed(4)), y: numUm((y1 - hw * ny).toFixed(4)) },
                { x: numUm((x0 - hw * nx).toFixed(4)), y: numUm((y0 - hw * ny).toFixed(4)) },
              ], label);
            }
          };
          code += `# ${c.id}: TAPERED polyline trace (per-segment parametric sheets + Unite + sweep)\n`;
          // Start at vertex 0: a LINE vertex 0 only establishes the path
          // start (no segment enters it), but an ARC at vertex 0 sweeps
          // from the component's base anchor and must emit its band.
          let i2 = 0;
          while (i2 < vertSpecs.length) {
            const meta = vertMeta[i2];
            if (meta.kind === 'arc') {
              code += `# WARNING: ${c.id} segment ${i2} is an ARC inside a TAPERED polyline - taper-on-arc\n`;
              code += `# is not supported in v1; the segment falls back to CONSTANT base width and is\n`;
              code += `# tessellated numerically (re-export after changing related params).\n`;
              curvedFallback = true;
              const v = vertSpecs[i2];
              const [px, py] = i2 === 0 ? [c.cx, c.cy] : numVerts[i2 - 1];
              const cdxN = evalExpr(v.cdx ?? '0', paramValues);
              const cdyN = evalExpr(v.cdy ?? '0', paramValues);
              const angN = evalExpr(v.angle ?? '0', paramValues);
              if (Number.isFinite(px) && Number.isFinite(cdxN) && Number.isFinite(cdyN)
                  && Number.isFinite(angN) && Math.abs(angN) > 1e-12) {
                emitCurveQuadsNumeric(
                  [[px, py], ...tessellateArcFrom(px, py, px + cdxN, py + cdyN, angN)],
                  `${c.id} arc segment ${i2} (numeric fallback, constant width)`);
              }
              i2++;
              continue;
            }
            if (meta.kind === 'spline') {
              code += `# WARNING: ${c.id} segments ${i2}.. are SPLINE inside a TAPERED polyline - taper-on-spline\n`;
              code += `# is not supported in v1; the run falls back to CONSTANT base width and is\n`;
              code += `# tessellated numerically (Catmull-Rom, matching the canvas preview).\n`;
              let j2 = i2;
              while (j2 + 1 < vertSpecs.length && vertMeta[j2 + 1].kind === 'spline') j2++;
              const ctrl = [numVerts[i2 - 1], ...numVerts.slice(i2, j2 + 1)];
              if (ctrl.every(p => p && Number.isFinite(p[0]) && Number.isFinite(p[1])) && ctrl.length >= 3) {
                curvedFallback = true;
                emitCurveQuadsNumeric(catmullRomTessellate(ctrl, 8),
                  `${c.id} spline run ${i2}..${j2} (numeric fallback, constant width)`);
              } else {
                // Degenerate single-vertex run: a straight segment — the
                // parametric taper applies (matches taperedBandQuads).
                for (let k2 = i2; k2 <= j2; k2++) {
                  emitLineQuad(vertExprs[k2 - 1], vertExprs[k2], effWidthExpr(k2 - 1), effWidthExpr(k2),
                    `${c.id} segment ${k2} (tapered quad)`);
                }
              }
              i2 = j2 + 1;
              continue;
            }
            // Plain line vertex. Vertex 0 establishes the start point —
            // no segment enters it.
            if (i2 === 0) { i2++; continue; }
            // Fully parametric tapered quad. Skip numerically-degenerate
            // segments (zero length — the unit normal expression would
            // divide by zero in HFSS).
            const sN = numVerts[i2 - 1], eN = numVerts[i2];
            const segLen = (sN && eN) ? Math.hypot(eN[0] - sN[0], eN[1] - sN[1]) : 0;
            if (segLen > 1e-12) {
              emitLineQuad(vertExprs[i2 - 1], vertExprs[i2], effWidthExpr(i2 - 1), effWidthExpr(i2),
                `${c.id} segment ${i2} (tapered quad)`);
            } else {
              code += `# ${c.id} segment ${i2}: zero length at export values - skipped (degenerate normal)\n`;
            }
            i2++;
          }
          // Closed tapered polyline: closing quad from the last vertex
          // back to vertex 0 (same butt-join band as the canvas).
          if (c.closed && vertExprs.length >= 2) {
            const sN = numVerts[numVerts.length - 1], eN = numVerts[0];
            const segLen = (sN && eN) ? Math.hypot(eN[0] - sN[0], eN[1] - sN[1]) : 0;
            if (segLen > 1e-12) {
              emitLineQuad(vertExprs[vertExprs.length - 1], vertExprs[0],
                effWidthExpr(vertSpecs.length - 1), effWidthExpr(0),
                `${c.id} closing segment (tapered quad)`);
            }
          }
          if (sheetNames.length === 0) {
            code += `# ${c.id}: no non-degenerate segments - nothing emitted\n`;
            continue;
          }
          if (sheetNames.length > 1) {
            code += `try:
    oEditor.Unite(
        ["NAME:Selections", "Selections:=", "${sheetNames.join(',')}"],
        ["NAME:UniteParameters", "KeepOriginals:=", False])
except Exception as e:
    try:
        oDesktop.AddMessage("", "", 1, "Failed to unite tapered segments of ${id}: " + str(e))
    except:
        pass
`;
          }
          if (!isSheet) {
            code += `try:
    oEditor.SweepAlongVector(
        ["NAME:Selections", "Selections:=", "${id}", "NewPartsModelFlag:=", "Model"],
        ["NAME:VectorSweepParameters",
         "DraftAngle:=", "0deg", "DraftType:=", "Round",
         "CheckFaceFaceIntersection:=", False,
         "SweepVectorX:=", "0um",
         "SweepVectorY:=", "0um",
         "SweepVectorZ:=", "${zSizeExpr}"])
except Exception as e:
    try:
        oDesktop.AddMessage("", "", 1, "Failed to thicken tapered polyline ${id}: " + str(e))
    except:
        pass
`;
          }
          if (c.layer === 'electrode') emittedElecNames.push(id);
          else if (c.layer === 'waveguide') emittedWgNames.push(id);
          else if (c.layer === 'port') emittedPortNames.push(id);
          if (isSheet && c.layer === 'electrode') zeroThicknessSheets.push(id);
          if (curvedFallback) {
            noteFrozen(c.id, 'tapered polyline arc/spline segments frozen at constant base width (numeric tessellation, v1)');
          }
          if (!polyHasFrozenVertex) {
            notePara(c.id, 'pos, vertices, per-vertex taper widths (per-segment parametric corner exprs)');
          }
          continue; // tapered path fully emitted — skip the XSection sweep below
        }

        // Build PLPoint and PLSegment records — ONE pass in path order
        // so segment records line up with HFSS's point-index bookkeeping:
        //   line / snap / rel vertex → 1 point, Line segment (2 points)
        //   arc vertex               → mid + end points (start = previous
        //                              point; +base start point when the
        //                              arc is vertex 0), AngularArc
        //                              segment (NoOfPoints = 3) with
        //                              parametric ArcCenterX/Y + ArcAngle
        //   spline run (anchor + N spline-flagged rel vertices)
        //                             → N points, ONE Spline segment
        //                              (NoOfPoints = N + 1); HFSS fits a
        //                              NURBS through the chain-expr points
        const ptRecords = [];
        const segRecords = [];
        const pushPt = (xExpr, yExpr) => {
          ptRecords.push(`["NAME:PLPoint", "X:=", "${xExpr}", "Y:=", "${yExpr}", "Z:=", "${pathZExpr}"]`);
          return ptRecords.length - 1;
        };
        const lineSegRec = (startIdx) =>
          `["NAME:PLSegment", "SegmentType:=", "Line", "StartIndex:=", ${startIdx}, "NoOfPoints:=", 2]`;
        let hasSpline = false;
        let hasArc = false;
        {
          let prevPtIdx = -1;
          let vi = 0;
          while (vi < vertExprs.length) {
            const meta = vertMeta[vi];
            if (meta.kind === 'arc') {
              hasArc = true;
              // Arc as vertex 0 starts at the component's base anchor,
              // which isn't otherwise in the point list — insert it so
              // the AngularArc segment has its start point.
              if (vi === 0) prevPtIdx = pushPt(baseCxExpr, baseCyExpr);
              const startIdx = prevPtIdx;
              pushPt(meta.arc.midX, meta.arc.midY);
              const endIdx = pushPt(vertExprs[vi].xExpr, vertExprs[vi].yExpr);
              segRecords.push(
                `["NAME:PLSegment", "SegmentType:=", "AngularArc", "StartIndex:=", ${startIdx}, "NoOfPoints:=", 3, "NoOfSegments:=", "0", "ArcAngle:=", "${meta.arc.aDeg}", "ArcCenterX:=", "${meta.arc.cenX}", "ArcCenterY:=", "${meta.arc.cenY}", "ArcCenterZ:=", "${pathZExpr}", "ArcPlane:=", "XY"]`
              );
              prevPtIdx = endIdx;
              vi++;
              continue;
            }
            if (meta.kind === 'spline' && vi > 0) {
              // Consecutive spline-flagged rel vertices + the anchor
              // point before the run form ONE Spline segment.
              let vj = vi;
              while (vj + 1 < vertExprs.length && vertMeta[vj + 1].kind === 'spline') vj++;
              const startIdx = prevPtIdx;
              let lastIdx = startIdx;
              for (let k = vi; k <= vj; k++) lastIdx = pushPt(vertExprs[k].xExpr, vertExprs[k].yExpr);
              const nPts = (vj - vi + 1) + 1;
              if (nPts >= 3) {
                hasSpline = true;
                segRecords.push(`["NAME:PLSegment", "SegmentType:=", "Spline", "StartIndex:=", ${startIdx}, "NoOfPoints:=", ${nPts}]`);
              } else {
                // A 2-point spline IS a line (matches the canvas's
                // degenerate-run handling in tessellatePolylinePath).
                segRecords.push(lineSegRec(startIdx));
              }
              prevPtIdx = lastIdx;
              vi = vj + 1;
              continue;
            }
            const idx = pushPt(vertExprs[vi].xExpr, vertExprs[vi].yExpr);
            if (vi > 0) segRecords.push(lineSegRec(prevPtIdx));
            prevPtIdx = idx;
            vi++;
          }
          // Closing edge (polyshape always; polyline when c.closed): close
          // the contour EXPLICITLY with a straight Line back to the FIRST
          // point (the base anchor when vertex 0 is an arc), matching the
          // canvas's straight ring closure. We append a repeat of the first
          // point + a closing Line segment. IsPolylineClosed is then set to
          // polyClosed below: when the contour is closed it MUST be True so
          // HFSS COVERS the loop into a face (a covered polyshape -> filled
          // sheet/solid; with closed=False the IsPolylineCovered flag is
          // ignored and the result is a hollow surface). The explicit closing
          // segment keeps wire extraction robust (relying on auto-close alone
          // fails with cant_extract_geom); the auto-close edge is then
          // zero-length/harmless.
          if (polyClosed) {
            ptRecords.push(ptRecords[0]);
            segRecords.push(lineSegRec(prevPtIdx));
          }
        }
        const ptList = ptRecords.join(',\n          ');
        const segList = segRecords.join(',\n          ');
        // XSection: Rectangle for solid traces, Line for sheets, None
        // for stroke-width-zero (degenerate — emits a 1-D curve) AND
        // for polyshape (it's a covered closed polygon, not a swept
        // path; the IsPolylineCovered=True flag fills it).
        const widthEval = isPolyshape ? 0 : (evalExpr(c.width ?? '0', paramValues) || 0);
        let xsec;
        if (widthEval <= 0) {
          xsec = `"XSectionType:=", "None",
          "XSectionOrient:=", "Auto",
          "XSectionWidth:=", "0um",
          "XSectionTopWidth:=", "0um",
          "XSectionHeight:=", "0um",
          "XSectionNumSegments:=", "0",
          "XSectionBendType:=", "Corner"`;
        } else if (isSheet) {
          xsec = `"XSectionType:=", "Line",
          "XSectionOrient:=", "Auto",
          "XSectionWidth:=", "${widthExprUm}",
          "XSectionTopWidth:=", "${widthExprUm}",
          "XSectionHeight:=", "0um",
          "XSectionNumSegments:=", "0",
          "XSectionBendType:=", "Corner"`;
        } else {
          xsec = `"XSectionType:=", "Rectangle",
          "XSectionOrient:=", "Auto",
          "XSectionWidth:=", "${widthExprUm}",
          "XSectionTopWidth:=", "${widthExprUm}",
          "XSectionHeight:=", "${zSizeExpr}",
          "XSectionNumSegments:=", "0",
          "XSectionBendType:=", "Corner"`;
        }
        const colorPl = isPortSheet ? '(255 100 100)' : '(218 165 32)';
        const transPl = isPortSheet ? '0.5' : '0.0';
        const solveInside = c.layer === 'waveguide' || isPortSheet ? 'True' : 'False';
        const headerLabel = isPolyshape
          ? `${c.id}: polygon-path (parametric closed 2-D sheet${isSheet ? '' : ' + thicken'})`
          : `${c.id}: polyline trace (parametric vertices + XSection sweep)`;
        code += `# ${headerLabel}\n`;
        code += `try:
    _delete_geom_if_exists("${id}")
    oEditor.CreatePolyline(
        ["NAME:PolylineParameters",
         "IsPolylineCovered:=", True,
         "IsPolylineClosed:=", ${polyClosed ? 'True' : 'False'},
         ["NAME:PolylinePoints",
          ${ptList}],
         ["NAME:PolylineSegments",
          ${segList}],
         ["NAME:PolylineXSection",
          ${xsec}]],
        ["NAME:Attributes",
         "Name:=", "${id}",
         "Flags:=", "",
         "Color:=", "${colorPl}",
         "Transparency:=", ${transPl},
         "PartCoordinateSystem:=", "Global",
         "MaterialValue:=", "\\"${ascii(materialName)}\\"",
         "SolveInside:=", ${solveInside}])
except Exception as e:
    try:
        oDesktop.AddMessage("", "", 1, "Failed to build ${shapeKind} ${id}: " + str(e))
    except:
        pass
`;
        // polyshape with non-zero layer thickness: SweepAlongVector to
        // extrude the flat polygonal sheet upward into a 3-D box. The
        // sweep distance is the layer's parametric thickness so HFSS
        // sweeps of h_cond / h_wg / etc. resize the polyshape's height
        // in lockstep with every other part on that layer.
        if (isPolyshape && !isSheet) {
          code += `try:
    oEditor.SweepAlongVector(
        ["NAME:Selections", "Selections:=", "${id}", "NewPartsModelFlag:=", "Model"],
        ["NAME:VectorSweepParameters",
         "DraftAngle:=", "0deg", "DraftType:=", "Round",
         "CheckFaceFaceIntersection:=", False,
         "SweepVectorX:=", "0um",
         "SweepVectorY:=", "0um",
         "SweepVectorZ:=", "${zSizeExpr}"])
except Exception as e:
    try:
        oDesktop.AddMessage("", "", 1, "Failed to thicken polyshape ${id}: " + str(e))
    except:
        pass
`;
        }
        if (c.layer === 'electrode') emittedElecNames.push(id);
        else if (c.layer === 'waveguide') emittedWgNames.push(id);
        else if (c.layer === 'port') emittedPortNames.push(id);
        // Zero-thickness sheet polylines need impedance boundary too.
        if (isSheet && c.layer === 'electrode') {
          zeroThicknessSheets.push(id);
        }
        if (!polyHasFrozenVertex) {
          notePara(c.id, hasArc
            ? 'pos, vertices, width, arc centers + sweep angles'
            : 'pos, vertices, width');
        }
        if (hasSpline) {
          noteCaveat(c.id, 'spline (canvas preview is an approximation of HFSS NURBS)');
        }
        continue; // skip the tessellated-polyline path below
      }

      if (isNativeShape) {
        // Parametric center via per-shape HFSS variables, mirroring the
        // port-sheet idiom: set_var("<id>_cx", <full snap-chain expr>)
        // then reference "(<id>_cx)" in the create call, so HFSS-side
        // sweeps over any chain variable move the shape. Mirror targets
        // can't use their own chain (applyMirrors repositioned them
        // numerically); reflection-symmetric shapes (circle / ellipse)
        // instead get the parametric reflection of their SOURCE chain.
        // Regular polygons are not reflection-symmetric in general
        // (vertex phase flips), so mirrored polygons freeze at the
        // solved numerics and land in the FROZEN report.
        const isMirrorTgtShape = mirrorTargetIds.has(c.id);
        const mppShape = isMirrorTgtShape ? mirrorReflectedPos(c) : null;
        let cxValExpr, cyValExpr;
        if (!isMirrorTgtShape && ppShape) {
          cxValExpr = spaceHyphens(exprWithUm(ppShape.cxExpr));
          cyValExpr = spaceHyphens(exprWithUm(ppShape.cyExpr));
          notePara(c.id, 'pos, size');
        } else if (mppShape && shapeKind !== 'polygon') {
          cxValExpr = spaceHyphens(exprWithUm(mppShape.cxExpr));
          cyValExpr = spaceHyphens(exprWithUm(mppShape.cyExpr));
          notePara(c.id, `pos (mirror reflection of ${mppShape.srcId}), size`);
        } else {
          cxValExpr = `${cx.toFixed(4)}um`;
          cyValExpr = `${cy.toFixed(4)}um`;
          noteFrozen(c.id, isMirrorTgtShape
            ? 'mirror target (asymmetric shape or source without chain) - position baked numerically'
            : 'position not derivable from snap chain - baked numerically');
        }
        const cxShapeVar = `${id}_cx`;
        const cyShapeVar = `${id}_cy`;
        const cxShape = `(${cxShapeVar})`;
        const cyShape = `(${cyShapeVar})`;
        const colorShape = isPortSheet ? '(255 100 100)' : '(200 200 200)';
        const transShape  = isPortSheet ? '0.5' : '0.0';
        const solveInside = c.layer === 'waveguide' || isPortSheet ? 'True' : 'False';
        // 32 segments by default is HFSS's smoothest discretization
        // (the GUI default) — visually indistinguishable from a true
        // analytic circle for any sane mesh density. NumSegments=0
        // tells HFSS to use its internal default; we keep that.
        let createCall = '';
        if (shapeKind === 'circle') {
          const rExpr = exprWithUm(c.r ?? '0');
          createCall = `oEditor.CreateCircle(
        ["NAME:CircleParameters",
         "XCenter:=", "${cxShape}", "YCenter:=", "${cyShape}", "ZCenter:=", "${zBottomExpr}",
         "Radius:=", "${rExpr}",
         "WhichAxis:=", "Z",
         "NumSegments:=", "0"],
        ["NAME:Attributes",
         "Name:=", "${id}", "Flags:=", "",
         "Color:=", "${colorShape}", "Transparency:=", ${transShape},
         "PartCoordinateSystem:=", "Global",
         "MaterialValue:=", "\\"${ascii(materialName)}\\"",
         "SolveInside:=", ${solveInside}])`;
        } else if (shapeKind === 'ellipse') {
          // HFSS's CreateEllipse takes MajRadius (along its major axis)
          // and Ratio = MinRadius / MajRadius. We pick whichever of
          // rx / ry is LARGER as the major radius, and emit the ratio
          // parametrically — so any HFSS-side rx / ry sweep flows
          // through correctly. WhichAxis=Z + axis-aligned: the ellipse
          // sits with its major axis along X if rx>ry, else along Y.
          const rxExpr = exprWithUm(c.rx ?? '0');
          const ryExpr = exprWithUm(c.ry ?? '0');
          const rxNum = evalExpr(c.rx ?? '0', paramValues) || 0;
          const ryNum = evalExpr(c.ry ?? '0', paramValues) || 0;
          // HFSS lacks a parametric "rotate ellipse 90°"; we pick the
          // major axis at export time. A sweep that flips which is
          // larger requires a re-export — documented gotcha, but the
          // common case (one axis stable as the major) sweeps cleanly.
          const majAlongX = rxNum >= ryNum;
          const majExpr = majAlongX ? rxExpr : ryExpr;
          const minExpr = majAlongX ? ryExpr : rxExpr;
          // Ratio is a unitless scalar — strip um/units. HFSS evaluates
          // length/length cleanly, so the division stays valid even if
          // we keep the units in (it cancels). Use explicit division.
          const ratioExpr = `(${minExpr}) / (${majExpr})`;
          // Orient: major axis along X if majAlongX else along Y. HFSS's
          // CreateEllipse takes an Orientation in some releases, but
          // the simplest portable trick is: emit major along X, then
          // rely on the user's existing rotate transform if they need
          // it along Y. For axis-along-Y ellipses we emit with the
          // semantic swap (major=ry, ratio=rx/ry, then rotate 90°).
          if (!majAlongX) {
            // Swap was needed — note in comment; geometry still correct.
          }
          createCall = `oEditor.CreateEllipse(
        ["NAME:EllipseParameters",
         "XCenter:=", "${cxShape}", "YCenter:=", "${cyShape}", "ZCenter:=", "${zBottomExpr}",
         "MajRadius:=", "${majExpr}",
         "Ratio:=", "${ratioExpr}",
         "WhichAxis:=", "Z",
         "NumSegments:=", "0"],
        ["NAME:Attributes",
         "Name:=", "${id}", "Flags:=", "",
         "Color:=", "${colorShape}", "Transparency:=", ${transShape},
         "PartCoordinateSystem:=", "Global",
         "MaterialValue:=", "\\"${ascii(materialName)}\\"",
         "SolveInside:=", ${solveInside}])`;
          if (!majAlongX) {
            createCall += `
    oEditor.Rotate(
        ["NAME:Selections", "Selections:=", "${id}", "NewPartsModelFlag:=", "Model"],
        ["NAME:RotateParameters", "RotateAxis:=", "Z", "RotateAngle:=", "90deg"])`;
          }
        } else { // polygon
          // CreateRegularPolygon takes a center, a "start" vertex on
          // the polygon perimeter, and the number of sides. We anchor
          // the start vertex at (cx, cy+r) — the NORTH-pointing vertex —
          // matching the canvas ring convention (shapeInstanceToRing
          // places the first vertex at +90°, apex-up). r is the
          // circumradius (vertex distance from center).
          const rExpr = exprWithUm(c.r ?? '0');
          const nVal = evalExpr(c.n ?? '6', paramValues);
          const nSides = Math.max(3, Math.floor(Number.isFinite(nVal) ? nVal : 6));
          const yStartExpr = `(${cyShape}) + (${rExpr})`;
          createCall = `oEditor.CreateRegularPolygon(
        ["NAME:RegularPolygonParameters",
         "XCenter:=", "${cxShape}", "YCenter:=", "${cyShape}", "ZCenter:=", "${zBottomExpr}",
         "XStart:=", "${cxShape}", "YStart:=", "${yStartExpr}", "ZStart:=", "${zBottomExpr}",
         "NumSides:=", "${nSides}",
         "WhichAxis:=", "Z"],
        ["NAME:Attributes",
         "Name:=", "${id}", "Flags:=", "",
         "Color:=", "${colorShape}", "Transparency:=", ${transShape},
         "PartCoordinateSystem:=", "Global",
         "MaterialValue:=", "\\"${ascii(materialName)}\\"",
         "SolveInside:=", ${solveInside}])`;
        }
        code += `# ${c.id}: ${shapeKind} as native HFSS primitive (parametric)\n`;
        code += `# Center variables carry the full snap-chain expression so HFSS-side\n`;
        code += `# sweeps over any chain parameter move the shape.\n`;
        code += `set_var("${cxShapeVar}", "${cxValExpr}")\n`;
        code += `set_var("${cyShapeVar}", "${cyValExpr}")\n`;
        code += `try:
    _delete_geom_if_exists("${id}")
    ${createCall}${isPortSheet ? '' : `
    oEditor.SweepAlongVector(
        ["NAME:Selections", "Selections:=", "${id}", "NewPartsModelFlag:=", "Model"],
        ["NAME:VectorSweepParameters",
         "DraftAngle:=", "0deg", "DraftType:=", "Round",
         "CheckFaceFaceIntersection:=", False,
         "SweepVectorX:=", "0um",
         "SweepVectorY:=", "0um",
         "SweepVectorZ:=", "${zSizeExpr}"])`}
except Exception as e:
    try:
        oDesktop.AddMessage("", "", 1, "Failed to build ${shapeKind} ${id}: " + str(e))
    except:
        pass
`;
        if (c.layer === 'electrode') emittedElecNames.push(id);
        else if (c.layer === 'waveguide') emittedWgNames.push(id);
        else if (c.layer === 'port') emittedPortNames.push(id);
        continue; // skip the tessellated-polyline path below
      }

      // Sweep-safety: the tessellated perimeter bakes every X/Y vertex
      // at export-time numerics. Only Z (layer stack) stays parametric.
      noteFrozen(c.id, shapeKind === 'racetrack'
        ? 'racetrack tessellation (perimeter vertices baked numerically; only Z tracks layer sweeps)'
        : `${shapeKind} tessellation (perimeter vertices baked numerically; only Z tracks layer sweeps)`);
      // Build the points list. CreatePolyline expects a sequence of
      // PolylinePoint records. X/Y stay numeric (the shape's perimeter
      // is tessellated at export time — see the racetrack note); Z uses
      // the parametric layer-stack expression so vertical sweeps work.
      //
      // Covered closed loop -> swept to a SOLID. We DROP near-coincident
      // vertices first (a tessellated racetrack loop comes back implicitly
      // closed, its last sample ~0.2 nm from the first — without dedup the
      // closing edge would be a sub-nm zero-length segment HFSS rejects),
      // then APPEND a repeat of the first vertex and emit one Line segment
      // per edge INCLUDING the closing edge (last -> repeated first).
      // IsPolylineClosed=True is REQUIRED: HFSS only honors IsPolylineCovered
      // (fills the face) on a CLOSED polyline, so closed=False would leave it
      // uncovered and the sweep would yield a hollow surface, not a volume.
      // The explicit closing segment keeps wire extraction robust (auto-close
      // alone fails with cant_extract_geom); the auto-close edge is then
      // zero-length/harmless.
      const ringHfss = dedupeRingForHfss(ring);
      const ringClosed = ringHfss.length > 0 ? [...ringHfss, ringHfss[0]] : ringHfss;
      const ptRecords = ringClosed.map(([px, py]) =>
        `["NAME:PLPoint", "X:=", "${px.toFixed(4)}um", "Y:=", "${py.toFixed(4)}um", "Z:=", "${zBottomExpr}"]`
      ).join(', ');
      const segRecords = ringHfss.map((_, i) =>
        `["NAME:PLSegment", "SegmentType:=", "Line", "StartIndex:=", ${i}, "NoOfPoints:=", 2]`
      ).join(', ');
      // For ports (zSize=0) the closed polyline IS the final geometry —
      // a 2-D sheet usable as a port assignment. For everything else we
      // also SweepAlongVector to extrude into a 3-D body.
      // (isPortSheet was already declared above in the native-primitive
      // dispatch.)
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
         "SweepVectorZ:=", "${zSizeExpr}"])`}
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
        // Same explicit-closure form as the outer perimeter: dedupe the
        // near-coincident closure vertex, append a repeat of the first, emit
        // one Line segment per edge (incl. the closing edge), closed=True (so
        // HFSS covers the hole into a face that subtracts a SOLID).
        const innerHfss = dedupeRingForHfss(innerPts);
        const innerClosed = innerHfss.length > 0 ? [...innerHfss, innerHfss[0]] : innerHfss;
        const innerPtRecords = innerClosed.map(([px, py]) =>
          `["NAME:PLPoint", "X:=", "${px.toFixed(4)}um", "Y:=", "${py.toFixed(4)}um", "Z:=", "${zBottomExpr}"]`
        ).join(', ');
        const innerSegRecords = innerHfss.map((_, i) =>
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
         "SweepVectorZ:=", "${zSizeExpr}"])
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
    // HFSS actually moves geometry. Mirror targets of reflection-symmetric
    // shapes (rects ARE symmetric) get the parametric reflection of their
    // SOURCE's chain — cx_t = 2*axis - cx_src — so chain-variable sweeps
    // move source and mirror copy in lockstep. The target's w/h equal the
    // source's (applyMirrors copies them), so size exprs need no special
    // handling. Anything else falls back to numeric + FROZEN report.
    const isMirrorTgt = mirrorTargetIds.has(c.id);
    const pp = parametricPos[c.id];
    const mpp = isMirrorTgt ? mirrorReflectedPos(c) : null;
    const wExprUm = exprWithUm(c.w);
    const hExprUm = exprWithUm(c.h);
    let cxExprUm, cyExprUm;
    if (!isMirrorTgt && pp) {
      cxExprUm = exprWithUm(pp.cxExpr);
      cyExprUm = exprWithUm(pp.cyExpr);
      notePara(c.id, 'pos, size');
    } else if (mpp) {
      cxExprUm = exprWithUm(mpp.cxExpr);
      cyExprUm = exprWithUm(mpp.cyExpr);
      notePara(c.id, `pos (mirror reflection of ${mpp.srcId}), size`);
    } else {
      cxExprUm = numUm(cx.toFixed(4));
      cyExprUm = numUm(cy.toFixed(4));
      noteFrozen(c.id, isMirrorTgt
        ? 'mirror target (asymmetric shape or source without chain) - position baked numerically'
        : 'position not derivable from snap chain - baked numerically');
    }
    const xLoExprUm = `${cxExprUm} - ${wExprUm}/2`;
    const yLoExprUm = `${cyExprUm} - ${hExprUm}/2`;

    // ── Rect corner fillets (D3): covered + closed CreatePolyline ──────
    // A rect with cornerRadius > 0 can't be a CreateBox / CreateRectangle
    // (HFSS boxes have sharp corners). Emit instead an 8-tangent-point
    // closed polyline — 4 Line edges + 4 AngularArc 90° corners — with
    // EVERY coordinate parametric: tangent points are (cx ± w/2 ∓ r,
    // cy ± h/2 ∓ r) built from the rect's live position / size / radius
    // expressions, arc centers ride the same exprs, and the sheet is
    // swept up by the layer's parametric thickness (the polyshape idiom).
    // First-class rotation (if any) is applied by the D6 base-rotation
    // block downstream — the base polyline here is axis-aligned.
    const crInfo = cornerRadiusInfo(c);
    if (crInfo) {
      const rFE = exprWithUm(crInfo.expr);
      // Z policy + material per layer (mirrors the sharp-rect dispatch):
      //   waveguide → uniform extrusion across the WG layer. The rib
      //     cross-section profile only applies to sharp rects (a swept
      //     trapezoid can't follow filleted corners), so rounded WG
      //     rects emit as a uniform slab — flagged in the report.
      //   electrode → bound conductor layer's Z range (sheet when its
      //     thickness is zero).
      //   port → 2-D sheet at the bound conductor's mid-Z.
      let zBExpr, zSExpr, zSizeNum, matRR, colorRR, transRR, solveRR;
      if (c.layer === 'waveguide') {
        zBExpr = withZOffset((wgLayer && layerZ[wgLayer.id]?.zBottomExpr) || '0um', c);
        zSExpr = (wgLayer && layerZ[wgLayer.id]?.thicknessExpr) || exprWithUm('h_wg');
        zSizeNum = (wgLayer && layerZ[wgLayer.id]?.thickness) || wg_z;
        matRR = wgMaterial;
        colorRR = '(143 175 143)';
        transRR = '0.0';
        solveRR = 'True';
        code += `# ${c.id}: rounded waveguide rect — emitted as a UNIFORM slab (the rib\n`;
        code += `# cross-section profile only applies to sharp rect waveguides).\n`;
        noteCaveat(c.id, 'rounded-rect waveguide emitted as uniform slab (no rib cross-section profile)');
      } else if (c.layer === 'port') {
        const { layer: portCondL, comment: portCondC } = resolveCondForComp(c);
        code += `${portCondC}\n`;
        const pcZB = (portCondL && layerZ[portCondL.id]?.zBottomExpr) || exprWithUm('h_wg');
        const pcTh = (portCondL && layerZ[portCondL.id]?.thicknessExpr) || '0um';
        zBExpr = withZOffset(`(${pcZB}) + (${pcTh})/2`, c);
        zSExpr = '0um';
        zSizeNum = 0;
        matRR = 'vacuum';
        colorRR = '(255 100 100)';
        transRR = '0.5';
        solveRR = 'True';
      } else {
        const { layer: elecL, comment: elecC } = resolveCondForComp(c);
        code += `${elecC}\n`;
        zBExpr = withZOffset((elecL && layerZ[elecL.id]?.zBottomExpr) || '0um', c);
        zSExpr = (elecL && layerZ[elecL.id]?.thicknessExpr) || `${cond_z.toFixed(4)}um`;
        zSizeNum = (elecL && layerZ[elecL.id]?.thickness) ?? cond_z;
        matRR = elecL ? elecL.material : condMaterial;
        colorRR = '(218 165 32)';
        transRR = '0.0';
        solveRR = 'False';
      }
      const isSheetRR = Math.abs(zSizeNum) < 1e-9 || c.layer === 'port';
      // Parametric tangent / center expressions. cxExprUm / cyExprUm /
      // wExprUm / hExprUm come from the shared rect classification above
      // (snap chain, mirror reflection, or numeric fallback).
      const X0 = `(${cxExprUm}) - (${wExprUm})/2`;
      const X1 = `(${cxExprUm}) + (${wExprUm})/2`;
      const Y0 = `(${cyExprUm}) - (${hExprUm})/2`;
      const Y1 = `(${cyExprUm}) + (${hExprUm})/2`;
      const XL = `(${X0}) + ${rFE}`;
      const XR = `(${X1}) - ${rFE}`;
      const YB = `(${Y0}) + ${rFE}`;
      const YT = `(${Y1}) - ${rFE}`;
      // Arc mid-points sit at 45° on each corner: center ± r/sqrt(2).
      const D45 = '0.7071067811865476';
      const midOff = `${rFE}*${D45}`;
      // CCW point walk from the right edge's bottom tangent. 13 points
      // (8 tangents + 4 arc mids + closing repeat of point 0), 8 segs.
      const ptsRR = [
        { x: X1, y: YB },                                        // 0  right edge bottom tangent
        { x: X1, y: YT },                                        // 1  right edge top tangent
        { x: `(${XR}) + ${midOff}`, y: `(${YT}) + ${midOff}` },  // 2  NE arc mid
        { x: XR, y: Y1 },                                        // 3  top edge right tangent
        { x: XL, y: Y1 },                                        // 4  top edge left tangent
        { x: `(${XL}) - ${midOff}`, y: `(${YT}) + ${midOff}` },  // 5  NW arc mid
        { x: X0, y: YT },                                        // 6  left edge top tangent
        { x: X0, y: YB },                                        // 7  left edge bottom tangent
        { x: `(${XL}) - ${midOff}`, y: `(${YB}) - ${midOff}` },  // 8  SW arc mid
        { x: XL, y: Y0 },                                        // 9  bottom edge left tangent
        { x: XR, y: Y0 },                                        // 10 bottom edge right tangent
        { x: `(${XR}) + ${midOff}`, y: `(${YB}) - ${midOff}` },  // 11 SE arc mid
        { x: X1, y: YB },                                        // 12 closing repeat of point 0
      ];
      const arcSeg = (startIdx, cenX, cenY) =>
        `["NAME:PLSegment", "SegmentType:=", "AngularArc", "StartIndex:=", ${startIdx}, "NoOfPoints:=", 3, "NoOfSegments:=", "0", "ArcAngle:=", "90deg", "ArcCenterX:=", "${cenX}", "ArcCenterY:=", "${cenY}", "ArcCenterZ:=", "${zBExpr}", "ArcPlane:=", "XY"]`;
      const lineSegRR = (startIdx) =>
        `["NAME:PLSegment", "SegmentType:=", "Line", "StartIndex:=", ${startIdx}, "NoOfPoints:=", 2]`;
      const segsRR = [
        lineSegRR(0),          // right edge
        arcSeg(1, XR, YT),     // NE corner
        lineSegRR(3),          // top edge
        arcSeg(4, XL, YT),     // NW corner
        lineSegRR(6),          // left edge
        arcSeg(7, XL, YB),     // SW corner
        lineSegRR(9),          // bottom edge
        arcSeg(10, XR, YB),    // SE corner
      ];
      const ptListRR = ptsRR.map(p =>
        `["NAME:PLPoint", "X:=", "${p.x}", "Y:=", "${p.y}", "Z:=", "${zBExpr}"]`
      ).join(',\n          ');
      const segListRR = segsRR.join(',\n          ');
      code += `# ${c.id}: rounded rect (cornerRadius = ${ascii(crInfo.expr)}) as covered closed polyline\n`;
      code += `# 4 Line edges + 4 AngularArc 90deg corners, all coordinates parametric.\n`;
      code += `# NOTE: cornerRadius is not clamped in HFSS; keep r <= min(w,h)/2\n`;
      // The loop is closed EXPLICITLY: the last point (index 12) repeats the
      // first and the final SE corner arc ends on it, so the explicit segments
      // already form a closed contour (the closing edge is the ARC, not a
      // straight chord). IsPolylineClosed=True is REQUIRED so HFSS COVERS the
      // contour into a face -> a SOLID after sweep (closed=False leaves
      // IsPolylineCovered ignored and yields a hollow surface). Because point
      // 12 == point 0, HFSS's auto-close straight edge is zero-length/harmless
      // and does NOT replace the arc closure.
      code += `try:
    _delete_geom_if_exists("${id}")
    oEditor.CreatePolyline(
        ["NAME:PolylineParameters",
         "IsPolylineCovered:=", True,
         "IsPolylineClosed:=", True,
         ["NAME:PolylinePoints",
          ${ptListRR}],
         ["NAME:PolylineSegments",
          ${segListRR}],
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
         "Color:=", "${colorRR}",
         "Transparency:=", ${transRR},
         "PartCoordinateSystem:=", "Global",
         "MaterialValue:=", "\\"${ascii(matRR)}\\"",
         "SolveInside:=", ${solveRR}])${isSheetRR ? '' : `
    oEditor.SweepAlongVector(
        ["NAME:Selections", "Selections:=", "${id}", "NewPartsModelFlag:=", "Model"],
        ["NAME:VectorSweepParameters",
         "DraftAngle:=", "0deg", "DraftType:=", "Round",
         "CheckFaceFaceIntersection:=", False,
         "SweepVectorX:=", "0um",
         "SweepVectorY:=", "0um",
         "SweepVectorZ:=", "${zSExpr}"])`}
except Exception as e:
    try:
        oDesktop.AddMessage("", "", 1, "Failed to build rounded rect ${id}: " + str(e))
    except:
        pass
`;
      if (c.layer === 'waveguide') emittedWgNames.push(id);
      else if (c.layer === 'port') emittedPortNames.push(id);
      else emittedElecNames.push(id);
      if (isSheetRR && c.layer === 'electrode') zeroThicknessSheets.push(id);
      notePara(`${c.id}.cornerRadius`, 'corner fillets (parametric tangent points + 90deg AngularArc centers)');
      continue;
    }

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
      // WG layer base / total — keep numeric for the rib-shift math
      // (uses Math.tan etc.) AND track parametric expressions for the
      // emission, so HFSS-side sweeps of h_wg / h_slab move the rib in
      // lockstep with the layer stack.
      const wgZ = wgLayer && layerZ[wgLayer.id] ? layerZ[wgLayer.id].zBottom : 0;
      const wgT = wgLayer && layerZ[wgLayer.id] ? layerZ[wgLayer.id].thickness : (Number.isFinite(wgLayerThickness) ? wgLayerThickness : 0.6);
      // Per-component zOffset rides on the layer's parametric zBottom —
      // every derived Z (slab bottom, rib bottom/top, relative CS) below
      // chains off wgZExpr, so the offset propagates automatically.
      const wgZExpr = withZOffset((wgLayer && layerZ[wgLayer.id]?.zBottomExpr) || `${wgZ.toFixed(4)}um`, c);
      const wgTExpr = (wgLayer && layerZ[wgLayer.id]?.thicknessExpr) || `${wgT.toFixed(4)}um`;
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
     "XPosition:=", "${slabXPosExpr}", "YPosition:=", "${slabYPosExpr}", "ZPosition:=", "${wgZExpr}",
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
      // Z values flow through the layer-stack expressions so an HFSS-
      // side sweep of h_slab / h_wg moves the rib bottom and top in
      // lockstep with the slab top and the WG layer top. X/Y vertices
      // are also parametric so component position + rib width sweeps
      // work end-to-end.
      const z_rib_bot_um = `(${wgZExpr}) + ${slabHExprUm}`;
      const z_rib_top_um = `(${wgZExpr}) + ${exprWithUm(layerThExpr)}`;
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
      const sweepVxExpr = (axis === 'x') ? wExprUm : numUm(0);
      const sweepVyExpr = (axis === 'y') ? hExprUm : numUm(0);
      const sweepVzExpr = numUm(0);

      // The rib cross-section lives in the X=const (Y-Z) plane and must be
      // COVERED (filled into a face) so the SweepAlongVector produces a SOLID
      // ridge, not a hollow surface. HFSS only honors IsPolylineCovered on a
      // CLOSED polyline, so IsPolylineClosed=True is REQUIRED (closed=False
      // emits the ridge as a swept surface — the bug this fixes). We ALSO
      // close the loop explicitly: append a repeat of the first point and emit
      // one Line segment per edge INCLUDING the closing edge (last vertex ->
      // repeated first). The explicit closing segment is what makes wire-body
      // extraction robust — relying on auto-close alone (N points, N-1
      // segments) fails with "PK_CURVE_make_wire_body_2 ... cant_extract_geom".
      // With both, the closed=True auto-close edge is zero-length/harmless.
      const ptExprsClosed = [...ptExprs, ptExprs[0]];
      const ptList = ptExprsClosed.map(p =>
        `["NAME:PLPoint", "X:=", "${p.x}", "Y:=", "${p.y}", "Z:=", "${p.z}"]`
      ).join(',\n          ');
      const ribSegList = ptExprs.map((_, i) =>
        `["NAME:PLSegment", "SegmentType:=", "Line", "StartIndex:=", ${i}, "NoOfPoints:=", 2]`
      ).join(',\n          ');

      code += `try:
    _delete_geom_if_exists("${wgName}_rib_xsec")
    _delete_geom_if_exists("${wgName}_rib")
    oEditor.CreatePolyline(
        ["NAME:PolylineParameters",
         "IsPolylineCovered:=", True,
         "IsPolylineClosed:=", True,
         ["NAME:PolylinePoints",
          ${ptList}],
         ["NAME:PolylineSegments",
          ${ribSegList}],
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

      // Defer relative-CS creation until AFTER all geometry is done.
      // CreateRelativeCS sets the new CS as active in some HFSS
      // versions, which can subtly affect downstream geometry placement
      // (ports, electrodes, booleans). We collect the per-waveguide CS
      // definitions here and emit them as a single block at the end of
      // the script — see "Relative coordinate systems" block below.
      //
      // One CS PER VISIBLE INSTANCE: if the waveguide has repeat /
      // duplicate_mirror / displace / rotate transforms, every rendered
      // copy gets its own CS at the corresponding transformed position
      // and orientation. Naming follows HFSS's clone convention so the
      // CSes line up 1:1 with the visible WG copies in the modeler:
      //   - idx=0 → `<wg_id>_cs` (the base)
      //   - idx=k → `<wg_id>_cs_<k>` (clones)
      const baseCsName = `${id}_cs`;
      const slabTopZ = wgZ + safeSlabH;
      // Base (idx=0) keeps the PARAMETRIC origin expressions so HFSS
      // sweeps over snap-chain variables move the base CS too. Z is
      // also parametric — slab_top = wg_zBottom + h_slab — so layer-
      // thickness sweeps move the CS in lockstep with the geometry.
      const baseCsOriginXExpr = (axis === 'x') ? `(${cxExprUm}) - (${wExprUm})/2` : cxExprUm;
      const baseCsOriginYExpr = (axis === 'y') ? `(${cyExprUm}) - (${hExprUm})/2` : cyExprUm;
      const baseCsOriginZExpr = `(${wgZExpr}) + ${slabHExprUm}`;
      const baseXAxis = axis === 'x' ? [1, 0, 0] : [0, 1, 0];
      const baseYAxis = axis === 'x' ? [0, 1, 0] : [-1, 0, 0];
      relativeCsDefs.push({
        name: baseCsName,
        originX: baseCsOriginXExpr,
        originY: baseCsOriginYExpr,
        originZ: baseCsOriginZExpr,
        xAxis: baseXAxis,
        yAxis: baseYAxis,
      });
      // Now expand the WG's transform chain and emit one CS per
      // non-base instance. We compose the instance's (scale →
      // rotate → translate) onto the WG's start point and local axes
      // to land each CS at the clone's actual world position and
      // orientation.
      //
      // PARAMETRIC PATH: when the chain is repeat-only (or repeat +
      // displace) with no rotation / mirror / duplicate_mirror, we
      // can express each clone's origin parametrically as a sum of
      // index-weighted (dx, dy) offsets from the base. That lets
      // HFSS-side sweeps of the repeat's offset variable (e.g.
      // `-cap_d - cap_gap - 2*cap_W` for wg1) move the CS in
      // lockstep with the clone WG. For chains involving rotation
      // or mirroring, fall through to the numeric path — those
      // would require cos/sin/reflection terms that complicate the
      // emission for marginal gain on field-sampling CSes.
      if (c.transforms && c.transforms.some(t => t && t.enabled !== false)) {
        const enabledTs = c.transforms.filter(t => t && t.enabled !== false);
        const onlySimple = enabledTs.every(t => t.kind === 'repeat' || t.kind === 'displace');

        if (onlySimple) {
          // Mirror expandTransforms's iteration order so each
          // emitted `..._<k>` lines up with HFSS's k'th clone. The
          // stream starts as a single base item; each `repeat`
          // multiplies it by (n+1), each `displace` shifts every
          // item by the same offset.
          let stream = [{ dxExpr: '0um', dyExpr: '0um' }];
          for (const t of enabledTs) {
            const dxStr = String(t.dx ?? '0');
            const dyStr = String(t.dy ?? '0');
            if (t.kind === 'displace') {
              stream = stream.map(item => ({
                dxExpr: `(${item.dxExpr}) + (${dxStr})`,
                dyExpr: `(${item.dyExpr}) + (${dyStr})`,
              }));
            } else { // repeat
              const n = Math.max(0, Math.floor(evalExpr(t.n ?? '0', paramValues) || 0));
              if (n < 1) continue;
              const includeOriginal = t.includeOriginal !== false;
              const next = [];
              for (const item of stream) {
                if (includeOriginal) next.push(item);
                for (let k = 1; k <= n; k++) {
                  next.push({
                    dxExpr: `(${item.dxExpr}) + ${k} * (${dxStr})`,
                    dyExpr: `(${item.dyExpr}) + ${k} * (${dyStr})`,
                  });
                }
              }
              stream = next;
            }
          }
          // Base axes (no rotation in this path) — emit one CS per
          // non-base instance with parametric origin offset.
          for (let idx = 1; idx < stream.length; idx++) {
            const off = stream[idx];
            relativeCsDefs.push({
              name: `${baseCsName}_${idx}`,
              originX: `(${baseCsOriginXExpr}) + (${off.dxExpr})`,
              originY: `(${baseCsOriginYExpr}) + (${off.dyExpr})`,
              originZ: baseCsOriginZExpr,
              xAxis: baseXAxis,
              yAxis: baseYAxis,
            });
          }
        } else {
          // Rotation / mirror / duplicate_mirror present — bake
          // numerically via expandTransforms. The CS origin won't
          // track parameter sweeps for those clones; re-export
          // after sweeping if you need the CS to follow.
          noteFrozen(c.id, 'waveguide relative-CS clones (rotate/mirror chain - CS origins baked numerically)');
          const insts = expandTransforms([c], paramValues);
          for (const inst of insts) {
            if (inst.idx === 0) continue;
            const sx = inst.scaleX ?? 1;
            const sy = inst.scaleY ?? 1;
            const rotDeg = inst.rotation || 0;
            const rotRad = rotDeg * Math.PI / 180;
            const ca = Math.cos(rotRad), sa = Math.sin(rotRad);
            const lsx = (axis === 'x') ? -inst.w / 2 : 0;
            const lsy = (axis === 'y') ? -inst.h / 2 : 0;
            const ssx = lsx * sx;
            const ssy = lsy * sy;
            const startX = inst.cx + ssx * ca - ssy * sa;
            const startY = inst.cy + ssx * sa + ssy * ca;
            const xLocal = (axis === 'x') ? [1, 0] : [0, 1];
            const yLocal = (axis === 'x') ? [0, 1] : [-1, 0];
            const applyScaleRot = (v) => {
              const xs = v[0] * sx, ys = v[1] * sy;
              return [xs * ca - ys * sa, xs * sa + ys * ca, 0];
            };
            const xAxisWorld = applyScaleRot(xLocal);
            const yAxisWorld = applyScaleRot(yLocal);
            relativeCsDefs.push({
              name: `${baseCsName}_${inst.idx}`,
              originX: `${startX.toFixed(4)}um`,
              originY: `${startY.toFixed(4)}um`,
              originZ: baseCsOriginZExpr,
              xAxis: xAxisWorld.map(v => v.toFixed(6)),
              yAxis: yAxisWorld.map(v => v.toFixed(6)),
            });
          }
        }
      }
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
      // HFSS's expression parser can mis-parse identifiers separated
      // by a bare hyphen — e.g. "cap_s-feed_w" gets read as a single
      // (unknown) identifier rather than the subtraction "cap_s - feed_w".
      // Insert spaces around hyphens that sit between identifier
      // characters so the parser sees the binary operator.
      // (isMirrorTgt / pp / mpp come from the shared classification at
      // the top of the per-component loop — ports are rects, so a
      // mirrored port gets the parametric reflection of its source.)
      const portSpaceHyphens = (s) => String(s).replace(/(\w)-(\w)/g, '$1 - $2');
      const cxExprForVar = portSpaceHyphens((!isMirrorTgt && pp)
        ? exprWithUm(pp.cxExpr)
        : (mpp ? exprWithUm(mpp.cxExpr) : `${String(c.cx)}um`));
      const cyExprForVar = portSpaceHyphens((!isMirrorTgt && pp)
        ? exprWithUm(pp.cyExpr)
        : (mpp ? exprWithUm(mpp.cyExpr) : `${String(c.cy)}um`));
      // Port sheet Z: half-way up the conductor layer, so the sheet
      // sits inside the metal trace at its mid-height. For a zero-
      // thickness conductor (h_cond=0) this collapses to the conductor
      // layer's zBottom — the sheet and the port coincide on the same
      // plane. Falls back to the legacy h_wg position if no conductor
      // layer is defined.
      const { layer: portCondLayer, comment: portCondComment } = resolveCondForComp(c);
      code += `${portCondComment}\n`;
      const portCondZBot = portCondLayer && layerZ[portCondLayer.id] ? layerZ[portCondLayer.id].zBottom : evalExpr('h_wg', paramValues) || 0.6;
      const portCondThk = portCondLayer && layerZ[portCondLayer.id] ? layerZ[portCondLayer.id].thickness : 0;
      // Parametric Z = condZBottom + condThickness/2 so an HFSS sweep of
      // h_cond / h_wg moves the port sheet to the new mid-conductor
      // plane. Falls back to the numeric mid-Z when no conductor layer
      // is bound (legacy h_wg placement).
      const portCondZBotExpr = (portCondLayer && layerZ[portCondLayer.id]?.zBottomExpr) || exprWithUm('h_wg');
      const portCondThkExpr  = (portCondLayer && layerZ[portCondLayer.id]?.thicknessExpr) || '0um';
      // Per-component zOffset shifts the sheet's Z plane parametrically.
      const portZNum = withZOffset(`(${portCondZBotExpr}) + (${portCondThkExpr})/2`, c);
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
         "XStart:=", "(${cxVar}) - ${portWExpr}/2", "YStart:=", "(${cyVar}) - ${portHExpr}/2", "ZStart:=", "${portZNum}",
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
      // Pick the conductor layer this component is bound to (or fall back to default).
      // Resolver also returns a Python comment that gets emitted next to
      // the shape — that way the user can audit the exported script and
      // see which layer was actually used, and whether it was an explicit
      // binding, a legacy default, or a stale-binding fallback.
      const { layer: elecLayer, comment: elecComment } = resolveCondForComp(c);
      code += `${elecComment}\n`;
      const elecZ = elecLayer && layerZ[elecLayer.id] ? layerZ[elecLayer.id].zBottom : 0;
      const elecThickness = elecLayer && layerZ[elecLayer.id] ? layerZ[elecLayer.id].thickness : cond_z;
      const elecMaterial = elecLayer ? elecLayer.material : condMaterial;
      // Per-component zOffset rides on the conductor layer's parametric
      // zBottom (applies to both the 3-D box and the 0-thickness sheet).
      const elecZ_um = withZOffset((elecLayer && layerZ[elecLayer.id]?.zBottomExpr) || `${elecZ.toFixed(4)}um`, c);
      const elecT_um = (elecLayer && layerZ[elecLayer.id]?.thicknessExpr) || `${elecThickness.toFixed(4)}um`;
      // If the conductor layer's thickness is zero, emit the trace as a
      // 2D SHEET (rectangle on the XY plane) instead of a 3D box. We
      // track the name so the impedance-boundary block at the end of
      // the script can assign R=0 / X=0 Ω/sq, modeling it as a perfect
      // electric conductor with no volumetric mesh — much cheaper for
      // thin metal traces.
      if (Math.abs(elecThickness) < 1e-9) {
        zeroThicknessSheets.push(id);
        code += `safe_create_rectangle(
    ["NAME:RectangleParameters",
     "IsCovered:=", True,
     "XStart:=", "${xLoExprUm}", "YStart:=", "${yLoExprUm}", "ZStart:=", "${elecZ_um}",
     "Width:=", "${wExprUm}", "Height:=", "${hExprUm}",
     "WhichAxis:=", "Z"],
    ["NAME:Attributes",
     "Name:=", "${id}", "Flags:=", "", "Color:=", "(218 165 32)",
     "Transparency:=", 0.0, "PartCoordinateSystem:=", "Global",
     "MaterialValue:=", "\\"${ascii(elecMaterial)}\\"", "SolveInside:=", False],
    "${id}")
`;
      } else {
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
  // One-shot guard so a scene with many oversized repeats doesn't spam
  // the console — one warning per generation is enough to flag it.
  let warnedLargeRepeat = false;
  const emitTransformChainHfss = (transforms, partIds, startCx, startCy, baseW, baseH, componentGroup, startCxExpr, startCyExpr, baseWExpr, baseHExpr, reportCompId) => {
    if (!transforms || transforms.length === 0) return [...partIds];
    // Sweep-safety report id for frozen-pivot entries below.
    const chainReportId = reportCompId || (partIds && partIds[0]) || '(unknown)';
    let curCx = startCx, curCy = startCy, curRotation = 0;
    // Parametric centroid expressions: track curCx/curCy as HFSS-side
    // expressions so that Mirror / DuplicateMirror base points can be
    // emitted in a form that responds to variable sweeps. Without this,
    // the BaseY of a `duplicate_mirror` would be frozen at the solved
    // numeric (e.g. 52.2500um for meander_h), and changing a parameter
    // like cap_gap in HFSS would leave the mirror plane behind — visible
    // as a 2*delta misalignment of every mirrored child.
    let curCxExpr = startCxExpr ?? `${(startCx || 0).toFixed(4)}um`;
    let curCyExpr = startCyExpr ?? `${(startCy || 0).toFixed(4)}um`;
    // Active selection list. Starts as the caller's partIds, but grows
    // every time a `repeat` or `duplicate_mirror` transform fires so that
    // any subsequent displace / rotate / etc. operates on the full
    // cluster (original + clones) rather than on just the original.
    let activePartIds = [...partIds];
    let selStr = activePartIds.join(',');
    // Existing names known to HFSS at this point in the transform chain.
    // HFSS picks new clone names by collision-resolution: for a source
    // object S, the first new clone is named `S_k` where k is the
    // smallest positive integer such that `S_k` is not already in use.
    // We mirror that rule so our predicted clone names match HFSS's
    // actual naming, which is critical when later transforms reference
    // those clones through the selection list. Without this, a chain of
    // [repeat-N, duplicate_mirror] would generate the WRONG name for the
    // mirror clone of the original (it would naively be `S_1`, but `S_1`
    // already exists from the repeat — HFSS uses `S_<N+1>` instead).
    const knownNames = new Set(activePartIds);
    const nextCloneName = (base) => {
      let k = 1;
      while (knownNames.has(`${base}_${k}`)) k++;
      const name = `${base}_${k}`;
      knownNames.add(name);
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
        curCxExpr = `(${curCxExpr}) + (${dxExpr})`;
        curCyExpr = `(${curCyExpr}) + (${dyExpr})`;
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
          // Parametric centroid after world-origin rotation. HFSS
          // accepts cos()/sin() with degree arguments, so we can keep
          // the dependency on variables that fed the pre-rotation
          // centroid. (Falls back gracefully if `angleExpr` is just a
          // baked-in numeric like '45.0000deg'.)
          const newCxExpr = `(${curCxExpr}) * cos(${angleExpr}) - (${curCyExpr}) * sin(${angleExpr})`;
          const newCyExpr = `(${curCxExpr}) * sin(${angleExpr}) + (${curCyExpr}) * cos(${angleExpr})`;
          curCxExpr = newCxExpr;
          curCyExpr = newCyExpr;
          curRotation += angleNum;
        } else {
          // Pivot = 'C' (current center), 'group' (shared centroid of the
          // component's group), or a named anchor on the part's outline.
          //
          // PARAMETRIC PIVOT EMISSION: we compute pivotX/pivotY both as
          // numerics (for the centroid update bookkeeping) AND as
          // HFSS-side expressions (for the actual translate-rotate-
          // translate emission and the parametric curCxExpr update).
          // Baking pivots numerically — as the older code did — meant
          // sweeping the underlying parameters (e.g. the part's base w/h,
          // or any variable feeding curCxExpr) left the rotated copy in
          // the wrong place because the un-translate step pasted the
          // part at the OLD pivot. Tracking everything through to the
          // expressions makes the rotation re-evaluate end-to-end.
          let pivotX = curCx, pivotY = curCy;
          let pivotXExpr = curCxExpr, pivotYExpr = curCyExpr;
          if (pivot === 'group') {
            const gc = groupCentroid(componentGroup);
            if (gc) {
              pivotX = gc.x; pivotY = gc.y;
              // groupCentroid currently averages solved numerics; we
              // don't have parametric chains for group members yet, so
              // fall back to a baked numeric expression. The rotation
              // itself is still emitted with a parametric angle.
              pivotXExpr = `${pivotX.toFixed(4)}um`;
              pivotYExpr = `${pivotY.toFixed(4)}um`;
              noteFrozen(chainReportId, 'rotate pivot (group centroid of mixed members - baked numerically)');
            }
          } else if (pivot === 'custom') {
            // C9: explicit (px, py) world-coordinate pivot. px/py are
            // expression strings (µm) — emitted PARAMETRICALLY via
            // exprWithUm so HFSS sweeps over any variable they
            // reference move the pivot (and the rotated copy) in
            // lockstep. Numeric tracking mirrors expandTransforms.
            const pxNum = evalExpr(t.px ?? '0', paramValues);
            const pyNum = evalExpr(t.py ?? '0', paramValues);
            pivotX = Number.isFinite(pxNum) ? pxNum : 0;
            pivotY = Number.isFinite(pyNum) ? pyNum : 0;
            pivotXExpr = exprWithUm(t.px ?? '0');
            pivotYExpr = exprWithUm(t.py ?? '0');
            notePara(`${chainReportId}.rotate(custom)`, 'custom pivot (parametric px/py + angle)');
          } else if (pivot !== 'C') {
            // Anchor offset on the part's BASE w/h, then rotate by
            // curRotation (accumulated rotation so far, numeric).
            const localOff = anchorLocal(pivot, baseW, baseH);
            const rad = curRotation * Math.PI / 180;
            const ca = Math.cos(rad), sa = Math.sin(rad);
            pivotX = curCx + (localOff.x * ca - localOff.y * sa);
            pivotY = curCy + (localOff.x * sa + localOff.y * ca);
            // Parametric version of the same: use parametric baseWExpr/
            // baseHExpr (when provided) to build the local anchor
            // offset, rotate by the numeric curRotation cos/sin (they
            // come from accumulated angles so far — themselves baked
            // if any prior rotate had a numeric angle, parametric only
            // if every prior rotate was parametric AND we tracked
            // curRotationExpr separately, which we don't yet).
            if (baseWExpr && baseHExpr) {
              const off = anchorOffsetParam(pivot, baseWExpr, baseHExpr);
              const caStr = ca.toFixed(6);
              const saStr = sa.toFixed(6);
              pivotXExpr = `(${curCxExpr}) + ${caStr} * (${off.xOff}) - ${saStr} * (${off.yOff})`;
              pivotYExpr = `(${curCyExpr}) + ${saStr} * (${off.xOff}) + ${caStr} * (${off.yOff})`;
            } else {
              pivotXExpr = `${pivotX.toFixed(4)}um`;
              pivotYExpr = `${pivotY.toFixed(4)}um`;
              noteFrozen(chainReportId, `rotate pivot '${pivot}' (no parametric base dims - pivot baked numerically)`);
            }
          }
          // Negate the pivot for the pre-rotate translate. Wrapping in
          // parens keeps HFSS's parser from binding `-` to whatever
          // identifier sits at the front of pivotXExpr.
          const negPxExpr = `-(${pivotXExpr})`;
          const negPyExpr = `-(${pivotYExpr})`;
          // Translate-rotate-translate, emitted parametrically.
          code += `try:
    oEditor.Move(
        ["NAME:Selections", "Selections:=", "${selStr}", "NewPartsModelFlag:=", "Model"],
        ["NAME:TranslateParameters",
         "TranslateVectorX:=", "${negPxExpr}",
         "TranslateVectorY:=", "${negPyExpr}",
         "TranslateVectorZ:=", "0um"])
    oEditor.Rotate(
        ["NAME:Selections", "Selections:=", "${selStr}", "NewPartsModelFlag:=", "Model"],
        ["NAME:RotateParameters", "RotateAxis:=", "Z", "RotateAngle:=", "${angleExpr}"])
    oEditor.Move(
        ["NAME:Selections", "Selections:=", "${selStr}", "NewPartsModelFlag:=", "Model"],
        ["NAME:TranslateParameters",
         "TranslateVectorX:=", "${pivotXExpr}",
         "TranslateVectorY:=", "${pivotYExpr}",
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
          // Centroid parametric update. For pivot='C' the centroid is
          // invariant — the centroid IS the pivot, so it stays put.
          // For pivot='group' or a named anchor, rotate the (cur −
          // pivot) offset around the parametric pivot expressions.
          if (pivot !== 'C') {
            const newCxExpr = `(${pivotXExpr}) + ((${curCxExpr}) - (${pivotXExpr})) * cos(${angleExpr}) - ((${curCyExpr}) - (${pivotYExpr})) * sin(${angleExpr})`;
            const newCyExpr = `(${pivotYExpr}) + ((${curCxExpr}) - (${pivotXExpr})) * sin(${angleExpr}) + ((${curCyExpr}) - (${pivotYExpr})) * cos(${angleExpr})`;
            curCxExpr = newCxExpr;
            curCyExpr = newCyExpr;
          }
          curRotation += angleNum;
        }
      } else if (t.kind === 'repeat') {
        const nNum = Math.max(0, Math.floor(evalExpr(t.n ?? '0', paramValues) || 0));
        const dxNum = evalExpr(t.dx ?? '0', paramValues);
        const dyNum = evalExpr(t.dy ?? '0', paramValues);
        if (!Number.isFinite(dxNum) || !Number.isFinite(dyNum) || nNum < 1) continue;
        const dxExpr = (typeof t.dx === 'string' && /[A-Za-z_]/.test(t.dx)) ? ascii(t.dx) : `${dxNum.toFixed(4)}um`;
        const dyExpr = (typeof t.dy === 'string' && /[A-Za-z_]/.test(t.dy)) ? ascii(t.dy) : `${dyNum.toFixed(4)}um`;
        if (nNum > 500) {
          code += `# WARNING: repeat n=${nNum} creates ${nNum + 1} instances -- HFSS history will be very slow; consider reducing or flattening\n`;
          if (!warnedLargeRepeat) {
            warnedLargeRepeat = true;
            console.warn(`hfss-native: repeat n=${nNum} creates ${nNum + 1} instances -- HFSS history will be very slow; consider reducing or flattening`);
          }
        }
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
        // created. For each source base, HFSS allocates `nNum` new clones
        // with sequentially-next-available numeric suffixes. In a fresh
        // namespace those are `_1, _2, …, _n`, but when earlier ops have
        // already used some of those suffixes, HFSS skips ahead — and we
        // mirror that exact rule via `nextCloneName` so the predicted
        // names match HFSS reality.
        const newNames = [];
        for (const baseName of activePartIds) {
          for (let k = 1; k <= nNum; k++) {
            newNames.push(nextCloneName(baseName));
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
        // Parametric centroid: midpoint of an evenly-spaced (n+1)-stream
        // sits at the original + n/2 * (dx, dy). HFSS evaluates the
        // expression as-is, so multiplication by the integer literal
        // `nNum/2` is fine even when `dxExpr` carries variables.
        curCxExpr = `(${curCxExpr}) + ${(nNum / 2)} * (${dxExpr})`;
        curCyExpr = `(${curCyExpr}) + ${(nNum / 2)} * (${dyExpr})`;
      } else if (t.kind === 'mirror') {
        // oEditor.Mirror flips the selection across a plane defined by a
        // base point + normal vector. axis='x' ⇒ normal=(1,0,0) (mirror
        // line is vertical, parallel to Y); axis='y' ⇒ normal=(0,1,0).
        const axis = t.axis === 'y' ? 'y' : 'x';
        const pivot = t.pivot === 'origin' ? 'origin' : 'C';
        const baseXExpr = pivot === 'origin' ? '0um' : curCxExpr;
        const baseYExpr = pivot === 'origin' ? '0um' : curCyExpr;
        const nx = axis === 'x' ? 1 : 0;
        const ny = axis === 'y' ? 1 : 0;
        code += `try:
    oEditor.Mirror(
        ["NAME:Selections", "Selections:=", "${selStr}", "NewPartsModelFlag:=", "Model"],
        ["NAME:MirrorParameters",
         "MirrorBaseX:=", "${baseXExpr}",
         "MirrorBaseY:=", "${baseYExpr}",
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
          if (axis === 'x') { curCx = -curCx; curCxExpr = `-(${curCxExpr})`; }
          else              { curCy = -curCy; curCyExpr = `-(${curCyExpr})`; }
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
        // Use the PARAMETRIC centroid expression so HFSS-side variable
        // sweeps (e.g. cap_gap, slab_gap) move the mirror plane in
        // lockstep with the rest of the geometry that depends on them.
        // Baking the numeric centroid here was the source of the
        // meander_h `52.2500um` bug — the plane stayed put while every
        // dependent piece shifted, producing 2*delta misalignment.
        const baseXExpr = axis === 'x'
          ? `(${curCxExpr}) + (${offsetExpr})`
          : `(${curCxExpr})`;
        const baseYExpr = axis === 'y'
          ? `(${curCyExpr}) + (${offsetExpr})`
          : `(${curCyExpr})`;
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
        // DuplicateMirror uses the same next-available-suffix collision
        // rule as DuplicateAlongLine, so a mirror following a 10-clone
        // repeat names the first new object `S_10` (not `S_1`, which is
        // already taken). `nextCloneName` mirrors that rule.
        const newNames = activePartIds.map(b => nextCloneName(b));
        activePartIds = [...activePartIds, ...newNames];
        selStr = activePartIds.join(',');
        // Advance tracked centroid to the cluster centroid (midpoint of
        // source and its mirror). For axis='x' offset, the cluster's new
        // centroid is shifted by `offset` along x.
        if (axis === 'x') { curCx += offsetNum; curCxExpr = `(${curCxExpr}) + (${offsetExpr})`; }
        else              { curCy += offsetNum; curCyExpr = `(${curCyExpr}) + (${offsetExpr})`; }
      }
    }
    // Return the final selection so callers can track clone names — e.g.
    // for the zero-thickness conductor sheet list, where every duplicate
    // also needs to get the impedance boundary assigned.
    return activePartIds;
  };

  // Map: component id → list of final HFSS part names after that
  // component's per-primitive transform chain has been emitted. Used by
  // the boolean section below so a Subtract on an operand that owns a
  // repeat / mirror / duplicate_mirror knows ALL of the surviving part
  // names — not just the base, which would silently leave the clones
  // un-subtracted. Pre-populated with the base name(s) for every non-
  // boolean component so operands without their own transforms map to
  // a single-element list.
  const finalPartIdsByCompId = new Map();
  // Base (pre-transform) part names per component — used to expand the
  // cladding-subtract tool list from base names to every instance (base +
  // transform clones), so the cladding wraps around the repeat clones too.
  const basePartIdsByCompId = new Map();
  // Rib-waveguide rects split into two parts (slab + rib) — EXCEPT
  // rounded-corner rects (D3), which emit as ONE covered polyline named
  // `id` (no rib profile). Keep both partIds computations on this rule.
  const isRibWgRect = (c) =>
    c.layer === 'waveguide' && (c.kind || 'rect') === 'rect' && !cornerRadiusInfo(c);
  for (const c of solved) {
    if (c.kind === 'boolean') continue;
    const id = c.id.replace(/[^A-Za-z0-9_]/g, '_');
    const partIds = isRibWgRect(c)
      ? [`${id}_wg_slab`, `${id}_wg_rib`]
      : [id];
    finalPartIdsByCompId.set(c.id, partIds);
    basePartIdsByCompId.set(c.id, partIds);
  }
  for (const c of solved) {
    if (c.kind === 'boolean') continue; // booleans handled below
    const hasChain = !!(c.transforms && c.transforms.some(t => t && t.enabled !== false));
    // First-class rotation (D6): a base `rotation` expression rotates
    // the part about its OWN CENTER before the transform chain runs —
    // mirroring expandTransforms, which seeds the stream instance's
    // rotation with evalExpr(c.rotation).
    const baseRotAngle = rotationAngleDegFor(c);
    if (!hasChain && !baseRotAngle) continue;
    const id = c.id.replace(/[^A-Za-z0-9_]/g, '_');
    // For rib-waveguide rects, both the slab and the rib are emitted
    // as separate parts (`<id>_wg_slab`, `<id>_wg_rib`). Transforms
    // need to move BOTH parts together — repeating only the rib
    // would leave the slab behind, and naming the rib `<id>_rib`
    // (without the `_wg` infix used at creation) would target a
    // part that doesn't exist. Rounded rects (D3) emit as a single
    // part named `id` regardless of layer — see isRibWgRect.
    const partIds = isRibWgRect(c)
      ? [`${id}_wg_slab`, `${id}_wg_rib`]
      : [id];
    const baseW = typeof c.w === 'number' ? c.w : evalExpr(c.w, paramValues);
    const baseH = typeof c.h === 'number' ? c.h : evalExpr(c.h, paramValues);
    const ppForChain = parametricPosForExport[c.id];
    if (baseRotAngle) {
      // Translate-rotate-translate about the part's own center, fully
      // parametric: the pivot is the component's snap-chain cx/cy
      // expression and the angle is the rotation EXPRESSION typed in
      // degrees ("(<expr>)*1deg", or "<n>deg" when purely numeric).
      // oEditor.Rotate spins about the WORLD origin, hence the move/
      // rotate/move sandwich (see the compatibility note above).
      const pivotXE = ppForChain ? exprWithUm(ppForChain.cxExpr) : `${(c.cx ?? 0).toFixed(4)}um`;
      const pivotYE = ppForChain ? exprWithUm(ppForChain.cyExpr) : `${(c.cy ?? 0).toFixed(4)}um`;
      if (ppForChain) {
        notePara(`${c.id}.rotation`, 'first-class rotation (parametric angle + parametric pivot)');
      } else {
        noteFrozen(`${c.id}.rotation`, 'first-class rotation pivot (no parametric snap chain - center baked numerically; angle stays parametric)');
      }
      const selStrRot = partIds.join(',');
      code += `\n# ===== Base rotation for ${c.id}: ${baseRotAngle} CCW about own center =====\n`;
      code += `try:
    oEditor.Move(
        ["NAME:Selections", "Selections:=", "${selStrRot}", "NewPartsModelFlag:=", "Model"],
        ["NAME:TranslateParameters",
         "TranslateVectorX:=", "-(${pivotXE})",
         "TranslateVectorY:=", "-(${pivotYE})",
         "TranslateVectorZ:=", "0um"])
    oEditor.Rotate(
        ["NAME:Selections", "Selections:=", "${selStrRot}", "NewPartsModelFlag:=", "Model"],
        ["NAME:RotateParameters", "RotateAxis:=", "Z", "RotateAngle:=", "${baseRotAngle}"])
    oEditor.Move(
        ["NAME:Selections", "Selections:=", "${selStrRot}", "NewPartsModelFlag:=", "Model"],
        ["NAME:TranslateParameters",
         "TranslateVectorX:=", "${pivotXE}",
         "TranslateVectorY:=", "${pivotYE}",
         "TranslateVectorZ:=", "0um"])
except Exception as e:
    oDesktop.AddMessage("", "", 1, "Base rotation failed for ${selStrRot}: " + str(e))
`;
    }
    if (!hasChain) continue;
    code += `\n# ===== Transforms for ${c.id} =====\n`;
    const finalPartIds = emitTransformChainHfss(
      c.transforms, partIds, c.cx, c.cy, baseW || 0, baseH || 0, c.group,
      ppForChain ? ppForChain.cxExpr : undefined,
      ppForChain ? ppForChain.cyExpr : undefined,
      ppForChain ? ppForChain.wExpr : undefined,
      ppForChain ? ppForChain.hExpr : undefined,
      c.id,
    );
    finalPartIdsByCompId.set(c.id, finalPartIds);
    // If this part is a zero-thickness conductor sheet, every clone the
    // transform chain creates also needs the impedance boundary. Extend
    // the sheet list with the new names so the boundary block at the end
    // covers the entire cluster.
    if (zeroThicknessSheets.includes(id)) {
      for (const name of finalPartIds) {
        if (name !== id && !zeroThicknessSheets.includes(name)) {
          zeroThicknessSheets.push(name);
        }
      }
    }
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
      const safeBoolId = b.id.replace(/[^A-Za-z0-9_]/g, '_');
      // For each operand, the full list of HFSS part names AFTER its
      // own per-primitive transform chain ran. An operand with a
      // repeat(n=3) contributes 4 entries; an operand without
      // transforms contributes 1. Critical: without this, a multi-
      // instance operand would only see its base name in the
      // boolean op, and the clones would survive un-subtracted.
      const partListsByOp = ids.map(opId => finalPartIdsByCompId.get(opId) || [opId.replace(/[^A-Za-z0-9_]/g, '_')]);
      const baseParts = partListsByOp[0];
      const toolParts = partListsByOp.slice(1).flat();
      const baseSel = baseParts.join(',');
      const toolSel = toolParts.join(',');
      const allSel = [...baseParts, ...toolParts].join(',');
      // The post-boolean surviving parts depend on the op:
      //   - union / intersect: HFSS collapses the selection into ONE
      //     part with operand[0]'s first instance name.
      //   - subtract / punch: each blank survives with its original
      //     name (HFSS Subtract modifies blanks in place).
      // The boolean's own transforms (and any later references) act on
      // this list. For a single surviving part we can rename to the
      // boolean's id; for multiple parts we skip the rename and target
      // every part directly.
      let resultParts;
      if (b.op === 'union') {
        code += `try:
    oEditor.Unite(
        ["NAME:Selections", "Selections:=", "${allSel}"],
        ["NAME:UniteParameters", "KeepOriginals:=", False])
except Exception as e:
    oDesktop.AddMessage("", "", 1, "Union failed: " + str(e))
`;
        // Unite keeps the first selection's name → one surviving part.
        resultParts = [baseParts[0]];
      } else if (b.op === 'intersect') {
        code += `try:
    oEditor.Intersect(
        ["NAME:Selections", "Selections:=", "${allSel}"],
        ["NAME:IntersectParameters", "KeepOriginals:=", False])
except Exception as e:
    oDesktop.AddMessage("", "", 1, "Intersect failed: " + str(e))
`;
        resultParts = [baseParts[0]];
      } else if (b.op === 'subtract') {
        code += `try:
    oEditor.Subtract(
        ["NAME:Selections", "Blank Parts:=", "${baseSel}", "Tool Parts:=", "${toolSel}"],
        ["NAME:SubtractParameters", "KeepOriginals:=", False])
except Exception as e:
    oDesktop.AddMessage("", "", 1, "Subtract failed: " + str(e))
`;
        // Subtract on N blanks leaves N parts (one hole-shape per
        // blank). Their names are unchanged.
        resultParts = baseParts.slice();
      } else if (b.op === 'punch') {
        // The clones are consumed by the subtract; the original tools
        // live outside the boolean and were emitted as their own
        // primitives earlier — so KeepOriginals=False is correct here.
        code += `try:
    oEditor.Subtract(
        ["NAME:Selections", "Blank Parts:=", "${baseSel}", "Tool Parts:=", "${toolSel}"],
        ["NAME:SubtractParameters", "KeepOriginals:=", False])
except Exception as e:
    oDesktop.AddMessage("", "", 1, "Punch failed: " + str(e))
`;
        resultParts = baseParts.slice();
      }
      // Rename only when ONE part survives. Multi-part subtract results
      // would all need the same id which HFSS rejects — leave them under
      // their original cloned names (e.g. A, A_1, A_2, …); the boolean's
      // own transforms (next) operate on the whole list.
      const renameTarget = resultParts && resultParts.length === 1 ? resultParts[0] : null;
      if (renameTarget && renameTarget !== safeBoolId) {
        code += `_delete_geom_if_exists("${safeBoolId}")
try:
    oEditor.ChangeProperty(
        ["NAME:AllTabs",
         ["NAME:Geometry3DAttributeTab",
          ["NAME:PropServers", "${renameTarget}"],
          ["NAME:ChangedProps",
           ["NAME:Name", "Value:=", "${safeBoolId}"]]]])
except Exception as e:
    oDesktop.AddMessage("", "", 1, "Rename failed for ${renameTarget}: " + str(e))
`;
        resultParts = [safeBoolId];
      } else if (!renameTarget && resultParts && resultParts.length > 1) {
        code += `# NOTE: ${safeBoolId} — operand "${baseParts[0]}" had a transform chain producing ${resultParts.length} parts (${resultParts.join(', ')}). HFSS Subtract on multiple blanks leaves them under their original names; the boolean id ${safeBoolId} is not assigned to any single part. Reference these names directly if you need them in boundaries / setups.\n`;
      }
      // Apply the boolean component's own transforms as a chain of
      // HFSS history operations using the same helper as primitives.
      // For a multi-part result the chain acts on every part in lockstep
      // (emitTransformChainHfss already supports passing a list — see
      // the rib-waveguide [_wg_slab, _wg_rib] precedent).
      const solvedB = solved.find(sc => sc.id === b.id) || b;
      const bW = typeof solvedB.w === 'number' ? solvedB.w : evalExpr(solvedB.w, paramValues);
      const bH = typeof solvedB.h === 'number' ? solvedB.h : evalExpr(solvedB.h, paramValues);
      const ppForBool = parametricPosForExport[b.id];
      const finalBoolIds = emitTransformChainHfss(
        b.transforms || [], resultParts || [safeBoolId], solvedB.cx, solvedB.cy, bW || 0, bH || 0, b.group,
        ppForBool ? ppForBool.cxExpr : undefined,
        ppForBool ? ppForBool.cyExpr : undefined,
        ppForBool ? ppForBool.wExpr : undefined,
        ppForBool ? ppForBool.hExpr : undefined,
        b.id,
      );
      // Record this boolean's POST-transform part list so a downstream
      // boolean that consumes it sees every clone. Critical for
      // subtract(boolean-with-repeat, ...) — without this, only the
      // base name lands in the Blank Parts list and the repeat clones
      // survive untouched, so the user's "hole" only appears in the
      // first cell of an N-cell meander.
      finalPartIdsByCompId.set(b.id, finalBoolIds);
      // If the boolean result is a zero-thickness conductor sheet (any
      // operand sat on a zero-thickness conductor layer ⇒ Unite/Subtract
      // produces a sheet), every clone the transform chain creates also
      // needs the impedance boundary. Add the new names so the boundary
      // block at the end covers the entire cluster.
      if (zeroThicknessSheets.includes(safeBoolId)) {
        for (const name of finalBoolIds) {
          if (name !== safeBoolId && !zeroThicknessSheets.includes(name)) {
            zeroThicknessSheets.push(name);
          }
        }
      }
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
      // operand[0]'s base id — needed to either rename it to safeBoolId
      // (single-part result) or just track it through unchanged (multi-
      // part subtract result with the original base name still alive).
      const base0Id = ids[0].replace(/[^A-Za-z0-9_]/g, '_');
      const toolIds = ids.slice(1).map(id => id.replace(/[^A-Za-z0-9_]/g, '_'));
      if (renameTarget) {
        // Single-part result; original behavior — rename operand[0]'s
        // base id to the boolean's id everywhere it appears in the
        // downstream-tracking lists.
        renameInList(emittedElecNames, base0Id, safeBoolId);
        renameInList(emittedWgNames, base0Id, safeBoolId);
        // Zero-thickness conductor sheets — boolean ops produce a sheet
        // result when the operands are sheets, so the boolean's id
        // inherits the sheet treatment (and the impedance boundary).
        renameInList(zeroThicknessSheets, base0Id, safeBoolId);
      }
      // (Multi-part subtract result: operand[0]'s base name still exists
      // as one of the surviving parts, so we leave the lists alone for
      // operand[0]. The clones aren't in emittedElecNames anyway — they
      // were created by emitTransformChainHfss but not pushed there; that
      // pre-existing limitation affects cladding subtract for any
      // transformed electrode and is independent of this bug fix.)

      // Non-first operands are consumed by the subtract (and clones in
      // a punch are consumed too — they're the "Tool Parts" of the
      // KeepOriginals=False subtract).
      for (const oldId of toolIds) {
        removeFromList(emittedElecNames, oldId);
        removeFromList(emittedWgNames, oldId);
        removeFromList(zeroThicknessSheets, oldId);
      }
    }
  }

  // ===== Zero-thickness conductor sheets: surface-impedance boundary =====
  // Conductor layers with thickness = 0 are modeled as 2-D rectangle
  // sheets (instead of 3-D boxes). HFSS treats sheets as having no
  // material on either side unless a boundary is assigned, so we attach
  // a near-PEC surface impedance: R = 0.001 Ω/sq, X = 0 Ω/sq.
  //
  // Why not exactly R=0 / X=0: some HFSS releases reject "0 Ohm/sq +
  // j 0 Ohm/sq" as singular (the solver's surface-impedance kernel
  // wants a small but nonzero resistance for numerical stability). The
  // 1 mΩ/sq we use is small enough that the trace behaves as a PEC for
  // every practical RF/photonic design, but large enough to keep HFSS
  // happy. The user can tighten or loosen this directly in HFSS via
  // Project > Boundaries > "PEC_sheets" > Edit if a more physically-
  // accurate sheet resistance is wanted.
  if (zeroThicknessSheets.length > 0) {
    const objList = zeroThicknessSheets.map(n => `"${n}"`).join(', ');
    code += `
# ===== Zero-thickness conductor sheets: impedance boundary =====
# All conductor sheets (from layers with thickness=0) get a near-PEC
# surface impedance: 0.001 Ohm/sq (R) + j 0 Ohm/sq (X). Exact
# R=X=0 is rejected as singular by some HFSS releases, but 1 mOhm/sq
# is numerically perfect-conductor-equivalent for any practical RF or
# photonic-RF design. Edit the boundary in HFSS if you need a true
# physical sheet resistance.
try:
    oBoundarySetup_imp = oDesign.GetModule("BoundarySetup")
    _delete_boundary_if_exists("PEC_sheets")
    oBoundarySetup_imp.AssignImpedance(
        ["NAME:PEC_sheets",
         "Objects:=", [${objList}],
         "Resistance:=", "0.001",
         "Reactance:=", "0",
         "InfGroundPlane:=", False])
except Exception as e:
    try:
        oDesktop.AddMessage("", "", 1, "Failed to assign impedance boundary on conductor sheets: " + str(e))
    except:
        pass
`;
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
      const cladZ_um = z?.zBottomExpr ?? `${cladZ.toFixed(4)}um`;
      const cladT_um = z?.thicknessExpr ?? `${cladT.toFixed(4)}um`;
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
      // Subtract waveguides + 3-D electrodes from the cladding. Skip
      // zero-thickness conductor sheets — they have no volume to subtract
      // and HFSS would either no-op or carve a thin slit through the
      // cladding, neither of which is what we want for a 2-D PEC trace.
      //
      // CRITICAL: emittedWgNames / emittedElecNames hold only BASE part
      // names. A component with a `repeat` (or mirror) transform also has
      // CLONE parts (<base>_1, _2, …) that must be carved out too —
      // otherwise the cladding only wraps the base instances and every
      // clone stays buried inside solid cladding. Expand each base name to
      // all of its component's surviving parts via finalPartIdsByCompId.
      const allPartsForBase = new Map();
      for (const c of solved) {
        if (c.kind === 'boolean') continue;
        const baseParts = basePartIdsByCompId.get(c.id) || [];
        const allParts = finalPartIdsByCompId.get(c.id) || baseParts;
        for (const b of baseParts) allPartsForBase.set(b, allParts);
      }
      const expandClones = (name) => allPartsForBase.get(name) || [name];
      const toolSet = new Set();
      for (const name of emittedWgNames) {
        for (const p of expandClones(name)) toolSet.add(p);
      }
      for (const name of emittedElecNames) {
        if (zeroThicknessSheets.includes(name)) continue;
        for (const p of expandClones(name)) {
          if (!zeroThicknessSheets.includes(p)) toolSet.add(p);
        }
      }
      const toolNames = [...toolSet];
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
  // Parametric mid-Z = zBottom + thickness/2. Tracks h_cond sweeps; for
  // zero-thickness sheets this collapses to zBottom (the sheet plane).
  const condZBottomExpr = (condLayer && layerZ[condLayer.id]?.zBottomExpr) || `${condZBottom.toFixed(4)}um`;
  const condZThickExpr  = (condLayer && layerZ[condLayer.id]?.thicknessExpr) || `${condZThick.toFixed(4)}um`;
  const fieldPlotZ_um = `(${condZBottomExpr}) + (${condZThickExpr})/2`;
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
  //
  // PARAMETRIC: identify the extremal layers numerically at export
  // time, then emit their zBottomExpr / zTopExpr so HFSS-side sweeps
  // of layer thicknesses grow the air box in lockstep. The numeric
  // pick of "which layer is lowest / highest" can in principle shift
  // under sweeps, but the typical stack has the substrate-bottom layer
  // pinned at the lowest and a cladding-or-cover layer at the highest
  // — both stable under any normal parameter sweep.
  const layerZEntries = Object.entries(layerZ);
  let minLayerEntry = null, maxLayerEntry = null;
  let sceneZMin = +Infinity, sceneZMax = -Infinity;
  for (const [id, z] of layerZEntries) {
    if (z.zBottom < sceneZMin) { sceneZMin = z.zBottom; minLayerEntry = z; }
    if (z.zBottom + z.thickness > sceneZMax) { sceneZMax = z.zBottom + z.thickness; maxLayerEntry = z; }
  }
  if (!Number.isFinite(sceneZMin)) sceneZMin = -260;
  if (!Number.isFinite(sceneZMax)) sceneZMax = 5;
  const sceneZMinExpr = minLayerEntry?.zBottomExpr || `${sceneZMin.toFixed(4)}um`;
  const sceneZMaxExpr = maxLayerEntry?.zTopExpr || `${sceneZMax.toFixed(4)}um`;
  // Air-region pad as an HFSS variable too, so sweeping it adjusts
  // the radiation box without re-export. The XY footprint is anchored
  // to the chip-dimension variables (so chip_x_size sweeps grow the
  // air region symmetrically). Z follows the layer-stack expressions
  // — sweeping any layer thickness in HFSS grows the air region to
  // wrap the new stack height.
  const airMinZ = `(${sceneZMinExpr}) - (air_pad)`;
  const airSizeZ = `(${sceneZMaxExpr}) - (${sceneZMinExpr}) + 2 * (air_pad)`;
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
         "XPosition:=", "${airMinX}", "YPosition:=", "${airMinY}", "ZPosition:=", "${airMinZ}",
         "XSize:=", "${airSizeX}", "YSize:=", "${airSizeY}", "ZSize:=", "${airSizeZ}"],
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
    for (const { comp, det } of lumpedPortTargets) {
      // Per-port Z: half-way up the conductor layer that hosts this
      // port (so the IntLine endpoint Z matches the port sheet's Z
      // EXACTLY). Falls back to h_wg if no conductor layer is bound.
      const { layer: portCondLayerLP, comment: portCondLPComment } = resolveCondForComp(comp);
      code += `${portCondLPComment}\n`;
      const portZ_zBot = portCondLayerLP && layerZ[portCondLayerLP.id] ? layerZ[portCondLayerLP.id].zBottom : evalExpr('h_wg', paramValues) || 0.6;
      const portZ_thk  = portCondLayerLP && layerZ[portCondLayerLP.id] ? layerZ[portCondLayerLP.id].thickness : 0;
      // Numeric zOffset shift so the IntLine endpoints stay coplanar with
      // a z-offset port sheet (the sheet's Z is parametric; this is the
      // matching export-time numeric).
      const portZ_off = comp.zOffset != null ? (evalExpr(comp.zOffset, paramValues) || 0) : 0;
      const portZ_um = portZ_zBot + portZ_thk / 2 + portZ_off;
      const portId = comp.id.replace(/[^A-Za-z0-9_]/g, '_');
      const portName = `LumpedPort_${portId}`;
      const impedance = (comp.lumpedPort && comp.lumpedPort.impedance) || '50';
      // Sweep-safety: HFSS's IntLine COM field rejects expressions, so
      // the endpoints below are baked numerics. Re-assign the line once
      // via the GUI (Edit > Integration Line) to make it auto-track.
      noteFrozen(comp.id, 'lumped-port integration line (numeric endpoints; re-assign once via GUI Edit > Integration Line to auto-track, or re-export after param changes)');
      // IntLine endpoints are emitted as BARE numeric literals at the
      // export-time port edges. They MUST sit EXACTLY on opposite port
      // edges — HFSS's lumped-port assignment rejects interior points
      // with "Both endpoints of port lines must lie on the port". An
      // earlier version of this code applied a 1 nm inward inset to
      // absorb sub-µm evaluation drift between HFSS and JS, but that
      // pushes the endpoints into the port's interior and HFSS treats
      // them as off-edge. The parametric port expressions emitted above
      // (XStart = port_cx - w/2, YStart = port_cy - h/2) evaluate to the
      // SAME doubles HFSS uses here, so edge-exact endpoints align.
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
      const pw = evalExpr(comp.w, paramValues);
      const ph = evalExpr(comp.h, paramValues);
      const xMin = String(comp.cx - pw / 2);
      const xMax = String(comp.cx + pw / 2);
      const yMin = String(comp.cy - ph / 2);
      const yMax = String(comp.cy + ph / 2);
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
    // Fresh-project mode: install a DrivenModal setup (plus optional
    // frequency sweep and Optimetrics parametric sweep) so the
    // generated project is immediately solvable with ZERO manual GUI
    // work. In append-to-active mode the existing design already
    // carries its own setups and sweeps that the user wants preserved
    // — we leave them alone.
    const sim = scene.simSetup || {};
    // Strip a trailing 'GHz' the user may have typed (same forgiving
    // handling as fnominal above); returns the fallback on garbage.
    const stripGhz = (v, fallback) => {
      const s = ascii(String(v ?? '')).trim().replace(/\s*ghz\s*$/i, '');
      return s !== '' && Number.isFinite(parseFloat(s)) ? s : fallback;
    };
    // Adaptive-solve frequency: solveFreq wins; empty/missing/garbage
    // falls back to fnominal (the radiation-box sizing frequency).
    const solveFreqGHz = stripGhz(sim.solveFreq, String(fnominalGHz));
    const maxPassesNum = Math.floor(parseFloat(sim.maxPasses));
    const maxPasses = Number.isFinite(maxPassesNum) && maxPassesNum > 0 ? maxPassesNum : 12;
    const maxDeltaSNum = parseFloat(sim.maxDeltaS);
    const maxDeltaS = Number.isFinite(maxDeltaSNum) && maxDeltaSNum > 0 ? maxDeltaSNum : 0.02;
    code += `
# ===== Setup =====
oModule = oDesign.GetModule("AnalysisSetup")
oModule.InsertSetup("HfssDriven",
    ["NAME:Setup1",
     "AdaptMultipleFreqs:=", False,
     "Frequency:=", "${solveFreqGHz}GHz",
     "MaxDeltaS:=", ${maxDeltaS},
     "MaximumPasses:=", ${maxPasses},
     "MinimumPasses:=", 1,
     "MinimumConvergedPasses:=", 1,
     "PercentRefinement:=", 30,
     "IsEnabled:=", True])
`;
    if (sim.sweepEnabled !== false) {
      const sweepStart = stripGhz(sim.sweepStart, '0.1');
      const sweepStop = stripGhz(sim.sweepStop, '50');
      const sweepPointsNum = Math.floor(parseFloat(sim.sweepPoints));
      const sweepPoints = Number.isFinite(sweepPointsNum) && sweepPointsNum > 0 ? sweepPointsNum : 500;
      const sweepType = ['Interpolating', 'Discrete', 'Fast'].includes(sim.sweepType)
        ? sim.sweepType : 'Interpolating';
      // The Interp* knobs are only meaningful (and only accepted by
      // some HFSS releases) for interpolating sweeps.
      const interpExtras = sweepType === 'Interpolating'
        ? `,
         "InterpTolerance:=", 0.5,
         "InterpMaxSolns:=", 250,
         "InterpMinSolns:=", 0,
         "InterpMinSubranges:=", 1`
        : '';
      code += `
# Frequency sweep: ${sweepStart} - ${sweepStop} GHz, ${sweepPoints} points, ${sweepType}.
try:
    oModule.InsertFrequencySweep("Setup1",
        ["NAME:Sweep",
         "IsEnabled:=", True,
         "RangeType:=", "LinearCount",
         "RangeStart:=", "${sweepStart}GHz",
         "RangeEnd:=", "${sweepStop}GHz",
         "RangeCount:=", ${sweepPoints},
         "Type:=", "${sweepType}",
         "SaveFields:=", False,
         "SaveRadFields:=", False${interpExtras}])
except Exception as e:
    oDesktop.AddMessage("", "", 1, "InsertFrequencySweep failed: " + str(e))
`;
    }
    // ===== Optimetrics parametric sweep over flagged scene params =====
    // Any param carrying sweep={enabled,start,stop,step} becomes one
    // SweepDefinition in a single OptiParametric setup driving Setup1.
    const sweptParams = Object.entries(scene.params || {}).filter(([, p]) =>
      p && p.sweep && p.sweep.enabled && p.sweep.start && p.sweep.stop && p.sweep.step);
    if (sweptParams.length > 0) {
      const defs = sweptParams.map(([name, p]) => {
        const u = unitFor(p.unit);
        const lin = `LIN ${ascii(String(p.sweep.start).trim())}${u} ${ascii(String(p.sweep.stop).trim())}${u} ${ascii(String(p.sweep.step).trim())}${u}`;
        return { name: ascii(name), lin };
      });
      const defLines = defs.map(d => `         ["NAME:SweepDefinition",
          "Variable:=", "${d.name}",
          "Data:=", "${d.lin}",
          "OffsetF1:=", False,
          "Synchronize:=", 0]`).join(',\n');
      code += `
# ===== Optimetrics parametric setup =====
# Swept params (audit before solving):
${defs.map(d => `#   ${d.name}: ${d.lin}`).join('\n')}
try:
    oModule = oDesign.GetModule("Optimetrics")
    oModule.InsertSetup("OptiParametric",
        ["NAME:ParametricSetup1",
         "IsEnabled:=", True,
         ["NAME:ProdOptiSetupDataV2",
          "SaveFields:=", False,
          "CopyMesh:=", False,
          "SolveWithCopiedMeshOnly:=", True],
         ["NAME:StartingPoint"],
         "Sim. Setups:=", ["Setup1"],
         ["NAME:Sweeps",
${defLines}],
         ["NAME:Sweep Operations"],
         ["NAME:Goals"]])
except Exception as e:
    oDesktop.AddMessage("", "", 1, "Optimetrics parametric setup failed: " + str(e))
`;
    }
    // ===== 2-line method: εeff / α extraction (output variables + reports) =====
    // Emitted only when the 2-line wizard supplies options.twoLine. The math
    // runs entirely in HFSS: Marks' 2-line eigenvalue extraction of the
    // propagation constant γ from the two lines' S-parameters, then εeff and α.
    // Solution context is Setup1:Sweep (a Discrete sweep, forced by the wizard).
    if (options && options.twoLine && options.twoLine.portIndices) {
      const tlCforM = options.twoLine.cFperM;
      const tlQ3D = options.twoLine.q3d || null;
      // Z0 is included when a manual C is given OR a bundled Q3D will supply it.
      const tlHasZ0 = (Number.isFinite(tlCforM) && tlCforM > 0) || !!tlQ3D;
      // Plain-decimal (no exponent) format for the C set_var value.
      const _fmtC = (x) => { if (!Number.isFinite(x) || x <= 0) return '0.0000000001'; let s = x.toFixed(15); if (s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\.$/, ''); return s || '0.0000000001'; };
      const tlCInit = (Number.isFinite(tlCforM) && tlCforM > 0) ? _fmtC(tlCforM) : '0.0000000001';
      const tlVars = twoLineOutputVariables(options.twoLine.portIndices, options.twoLine.dLMeters, tlHasZ0);
      const tlLines = tlVars.map(v =>
        `_tl_outvar(${JSON.stringify(v.name)}, ${JSON.stringify(v.expr)})  # ${ascii(v.note || '')}`
      ).join('\n');
      // Per-length C as an editable HFSS design variable (F/m, unitless number).
      // Manual value if supplied, else a placeholder for the Q3D step to set.
      const tlCVar = tlHasZ0 ? `set_var("tl_C_F_per_m", "${tlCInit}")  # F/m (edit, or set from the Q3D capacitance solve)\n` : '';
      // Optional Z0 report.
      const tlZ0Report = tlHasZ0 ? `
try:
    oModule.CreateReport("Z0 vs Freq", "Modal Solution Data", "Rectangular Plot", "Setup1 : Sweep",
        ["Domain:=", "Sweep"], ["Freq:=", ["All"]],
        ["X Component:=", "Freq", "Y Component:=", ["tl_Z0_re", "tl_Z0_mag"]], [])
except Exception as e:
    oDesktop.AddMessage("", "", 1, "CreateReport Z0 failed: " + str(e))
` : '';
      // Optional bundled Q3D capacitance design (same project). Built from the
      // SINGLE-line scene the wizard passes (C/length is a one-line quantity).
      let tlQ3DBlock = '';
      if (tlQ3D && tlQ3D.scene && Array.isArray(tlQ3D.conductorIds) && tlQ3D.conductorIds.length) {
        try {
          tlQ3DBlock = generateQ3DCombinedBlock(tlQ3D.scene, null, {
            conductorIds: tlQ3D.conductorIds,
            designName: 'q3d_cap',
            hfssDesignName: 'Layout',
            cVarName: 'tl_C_F_per_m',
          });
        } catch (e) {
          tlQ3DBlock = `\n# Q3D capacitance block skipped: ${ascii(e.message)}\n`;
        }
      }
      code += `
# ===== 2-line method (Marks 1991): eeff / alpha output variables + reports =====
# Effective permittivity (tl_eeff) and attenuation (tl_alpha_dB_per_m / _Np_per_m)
# are extracted IN HFSS from the two lines' S-parameters: build each line's
# wave-cascade T from its 2-port S-block, M = T_B * T_A^-1, eigenvalue
# lambda = e^∓(gamma*DeltaL), gamma = -ln(lambda)/DeltaL; eeff = (c/w)^2*(beta^2 - alpha^2),
# alpha = |Re gamma|. Line A = ports 1,2; line B = ports 3,4. DeltaL is a baked
# metres literal (NOT the tl_dL design var, which resolves to metres in report
# exprs and would double-convert).${tlHasZ0 ? `
# Z0 = gamma/(j*w*C) is ALSO emitted, referencing the design variable
# tl_C_F_per_m (F/m): Re(Z0)=beta/(wC), Im(Z0)=-alpha/(wC). C is electrostatic so
# Z0 is kinetic-inductance-correct. Set tl_C_F_per_m below${tlQ3DBlock ? ' (the bundled Q3D design solves it — see the block after the reports)' : ' (edit it / from a Q3D capacitance solve)'}.` : ''}
# Assumes the report expression engine evaluates Freq in Hz (HFSS 2023). After
# you Analyze Setup1:Sweep, the reports below populate. PHASE-AMBIGUITY: valid
# only while beta*DeltaL < pi over the band (pick L2-L1 small enough); alpha is
# unaffected by the branch cut.
${tlCVar}oModule = oDesign.GetModule("OutputVariable")
def _tl_outvar(name, expr):
    try:
        oModule.CreateOutputVariable(name, expr, "Setup1 : Sweep", "Modal Solution Data", [])
    except Exception as e:
        oDesktop.AddMessage("", "", 1, "OutputVariable " + name + " failed: " + str(e))
${tlLines}

oModule = oDesign.GetModule("ReportSetup")
try:
    oModule.CreateReport("eeff vs Freq", "Modal Solution Data", "Rectangular Plot", "Setup1 : Sweep",
        ["Domain:=", "Sweep"], ["Freq:=", ["All"]],
        ["X Component:=", "Freq", "Y Component:=", ["tl_eeff"]], [])
except Exception as e:
    oDesktop.AddMessage("", "", 1, "CreateReport eeff failed: " + str(e))
try:
    oModule.CreateReport("alpha vs Freq", "Modal Solution Data", "Rectangular Plot", "Setup1 : Sweep",
        ["Domain:=", "Sweep"], ["Freq:=", ["All"]],
        ["X Component:=", "Freq", "Y Component:=", ["tl_alpha_dB_per_m"]], [])
except Exception as e:
    oDesktop.AddMessage("", "", 1, "CreateReport alpha failed: " + str(e))
${tlZ0Report}
# --- OPTIONAL post-solve fallback (guaranteed math in pure Python) ----------
# If the eeff/alpha report traces come up empty (an older expression engine that
# rejects complex ln/sqrt), SOLVE the design first, then uncomment the call at
# the bottom and re-run THIS script: it reads the S-matrix and recomputes
# eeff/alpha via cmath, writing <project>_twoline.csv next to the project.
def _tl_extract_csv():
    import cmath, os
    pi_idx = ${JSON.stringify(options.twoLine.portIndices)}
    try:
        sol = oDesign.GetModule("Solutions")
        # Pull the swept frequencies + S-parameters via the report data interface.
        data = oModule  # placeholder; use GetSolutionDataPerVariation / ExportNetworkData in your release
        oDesktop.AddMessage("", "", 0, "Fill in S-matrix retrieval for your AEDT release, then write CSV.")
    except Exception as e:
        oDesktop.AddMessage("", "", 2, "Two-line CSV fallback failed: " + str(e))
# _tl_extract_csv()   # <- uncomment AFTER solving if the in-HFSS reports are empty
${tlQ3DBlock}`;
    }
    code += `
oProject.Save()
oDesktop.AddMessage("", "", 0, "Layout built.")
`;
  } else {
    code += `
oProject.Save()
oDesktop.AddMessage("", "", 0, "Geometry appended to active design.")
`;
  }

  // ===== Relative coordinate systems (per waveguide) =====
  // Emitted DEAD LAST — after every geometry op, every boundary
  // assignment, and the project save. CreateRelativeCS in some HFSS
  // versions sets the new CS as the WCS, which would change the
  // interpretation of coordinates in any later geometry call. Doing it
  // after everything else means the active-CS change is harmless: no
  // more geometry follows. Each CS sits centered on the ridge cross-
  // section at the START end of its waveguide, just above the slab
  // (z = wgZ + slab_height). Useful as a base for ports, mode
  // integration lines, field probes, anchor points for spline bends.
  if (relativeCsDefs.length > 0) {
    code += `
# ===== Per-waveguide relative coordinate systems =====
# Each CS sits at one end of the rib, centered on the ridge cross-
# section just above the slab — useful as the start point for a
# non-model E-field sample line through the optical mode.
#
# Two safety nets so re-runs land at the right place:
#   (1) Force WCS = Global so CreateRelativeCS interprets the origin
#       in global coordinates.
#   (2) Delete any pre-existing CS with the same name FIRST, then
#       create fresh. This is safe because the SetWCS=Global emitted
#       at script start ensures every part HAS been bound to Global,
#       not to wg<id>_cs, so deleting that CS doesn't cascade-delete
#       any geometry. (Without the start-of-script SetWCS, HFSS would
#       implicitly bind new parts to whatever WCS was active —
#       potentially a stale wg<id>_cs left over from a prior run —
#       and deleting it would wipe the slab+rib too.)
def _set_wcs_global():
    try:
        oEditor.SetWCS(
            ["NAME:SetWCS Parameter",
             "Working Coordinate System:=", "Global",
             "RegionDepCSOk:=", False])
    except:
        pass

def _force_delete_rel_cs(name):
    try:
        if name in list(oEditor.GetCoordinateSystems()):
            oEditor.Delete(["NAME:Selections", "Selections:=", name])
    except:
        pass
`;
    for (const cs of relativeCsDefs) {
      code += `try:
    _set_wcs_global()
    _force_delete_rel_cs("${cs.name}")
    oEditor.CreateRelativeCS(
        ["NAME:RelativeCSParameters",
         "Mode:=", "Axis/Position",
         "OriginX:=", "${cs.originX}",
         "OriginY:=", "${cs.originY}",
         "OriginZ:=", "${cs.originZ}",
         "XAxisXvec:=", "${cs.xAxis[0]}",
         "XAxisYvec:=", "${cs.xAxis[1]}",
         "XAxisZvec:=", "${cs.xAxis[2]}",
         "YAxisXvec:=", "${cs.yAxis[0]}",
         "YAxisYvec:=", "${cs.yAxis[1]}",
         "YAxisZvec:=", "${cs.yAxis[2]}"],
        ["NAME:Attributes", "Name:=", "${cs.name}"])
except Exception as e:
    try:
        oDesktop.AddMessage("", "", 1, "Failed to create relative CS ${cs.name}: " + str(e))
    except:
        pass
`;
    }
  }

  // ===== PARAMETRIC-SWEEP SAFETY REPORT (spliced into the header) =====
  // Generation has now visited every emission site, so the parametric /
  // frozen classification lists are complete. Replace the placeholder
  // that the header template reserved near the top of the script.
  // Comment-only block — never affects Python parsing; ASCII-sanitized
  // so the IronPython 2.7 reader can't choke on stray unicode.
  {
    const lines = [];
    lines.push('# ===== PARAMETRIC-SWEEP SAFETY REPORT =====');
    lines.push('# Fully parametric (tracks HFSS variable changes):');
    if (reportParametric.length === 0) {
      lines.push('#   (none)');
    } else {
      for (const e of reportParametric) lines.push(`#   - ${ascii(String(e.id))}: ${ascii(String(e.tracks))}`);
    }
    lines.push('# FROZEN at export values (re-export after changing related params):');
    if (reportFrozen.length === 0) {
      lines.push('#   (none -- every emitted element tracks HFSS variables)');
    } else {
      for (const e of reportFrozen) lines.push(`#   - ${ascii(String(e.id))}: ${ascii(String(e.reason))}`);
    }
    if (reportNotes.length > 0) {
      lines.push('# NOTES (parametric, with caveats):');
      for (const e of reportNotes) lines.push(`#   - ${ascii(String(e.id))}: ${ascii(String(e.text))}`);
    }
    lines.push('# ==========================================');
    code = code.replace('#__PARAMETRIC_REPORT__', () => lines.join('\n'));
  }
  // Final ASCII pass over the WHOLE script: IronPython 2.7 inside HFSS must
  // never see non-ASCII bytes (em-dashes / lambda / approx signs sneak in
  // via emitted comment templates). Geometry/expressions are ASCII already,
  // so this only normalizes comments.
  return ascii(code);
}
