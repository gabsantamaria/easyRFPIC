// Snap constraint solver, mirror constraint application, and post-solve
// boolean-bbox resolution.
//
// `solveLayout` is the heart of the scene model. Snaps form a DAG where
// `from` is a placed parent and `to` is the child placed relative to it.
// The solver settles roots (components with no incoming snap) at their
// raw cx/cy, then iteratively places children whose parents are already
// settled. Boolean components join the snap graph as first-class objects:
// their bbox is recomputed from operand positions whenever an operand
// moves, and snaps targeting a boolean translate its operand cluster as
// a rigid body.
//
// `applyMirrors` overwrites each locked mirror target with the reflected
// pose of its source across the mirror axis. Runs after the snap solver.
//
// `resolveBooleanBboxes` is run after `solveLayout` + `expandTransforms`
// to write a tight AABB-derived w/h onto each boolean component for use
// by downstream consumers (anchor lookups, snap targeting, dimensions).
// `solveLayout` already runs a coarser inline refresh — this one accounts
// for the full transform chain.
//
// Extracted from PhotonicLayout.jsx as Stage 1.6 of the planned refactor.
import { evalExpr } from './params.js';
import { anchorLocalRotated, anchorWorld, compRotationDeg } from './anchors.js';
import { expandTransforms } from './transforms.js';
import { tessellatePolylinePath, polylineBbox, polyshapeBbox } from '../geometry/polyline.js';

// ── Solve diagnostics ──────────────────────────────────────────────────
// Module-level record refreshed by every solveLayout call. `converged`
// flips false when the fixed-point iteration cap is hit while progress
// was still being made; `issues` collects non-fatal solve anomalies
// (e.g. snap offsets that evaluated non-finite and were zeroed). The UI
// reads this after a solve to surface "your scene didn't settle" hints.
let lastSolveDiagnostics = { converged: true, iterations: 0, issues: [] };

export function getLastSolveDiagnostics() {
  return lastSolveDiagnostics;
}

// Validate the snap graph for structural problems BEFORE solving. Cheap
// (O(components + snaps)) so the UI can run it on every edit. Returns a
// list of findings; an empty array means the graph is structurally sound.
//
// Checks:
//   - 'duplicate-to':  two+ snaps share the same to.compId (a component's
//                      position must be determined by exactly one snap) —
//                      every snap after the first is flagged.
//   - 'self-snap':     from.compId === to.compId.
//   - 'missing-from':  from.compId references no existing component.
//   - 'missing-to':    to.compId references no existing component.
//   - 'cycle':         following to ← from parent edges loops back on
//                      itself (the solver would never place any member).
export function validateSnapGraph(components, snaps) {
  const out = [];
  const compIds = new Set((components || []).map(c => c.id));
  // child compId → the FIRST snap that places it (duplicates flagged, and
  // excluded from cycle detection so the parent map stays functional).
  const parentSnap = new Map();
  for (const s of snaps || []) {
    if (!s) continue;
    const sid = s.id ?? null;
    const fromId = s.from?.compId ?? null;
    const toId = s.to?.compId ?? null;
    if (fromId && toId && fromId === toId) {
      out.push({ kind: 'self-snap', snapId: sid, compId: fromId, message: `Snap targets its own source component "${fromId}"` });
    }
    if (fromId && !compIds.has(fromId)) {
      out.push({ kind: 'missing-from', snapId: sid, compId: fromId, message: `Snap "from" references missing component "${fromId}"` });
    }
    if (toId && !compIds.has(toId)) {
      out.push({ kind: 'missing-to', snapId: sid, compId: toId, message: `Snap "to" references missing component "${toId}"` });
    }
    if (toId) {
      if (parentSnap.has(toId)) {
        out.push({ kind: 'duplicate-to', snapId: sid, compId: toId, message: `Component "${toId}" is the target of more than one snap` });
      } else {
        parentSnap.set(toId, s);
      }
    }
  }
  // Cycle detection over the functional child → parent graph. Colors:
  // 1 = on the current walk (in-stack), 2 = fully explored. Each node is
  // walked at most once, so the whole pass stays O(n).
  const color = new Map();
  for (const startId of parentSnap.keys()) {
    if (color.has(startId)) continue;
    const stack = [];
    let cur = startId;
    while (cur != null && parentSnap.has(cur) && !color.has(cur)) {
      color.set(cur, 1);
      stack.push(cur);
      cur = parentSnap.get(cur).from?.compId ?? null;
    }
    if (cur != null && color.get(cur) === 1) {
      // `cur` is on the current walk → the tail of `stack` from `cur` on
      // forms the cycle. Report it once, anchored on the closing snap.
      const idx = stack.indexOf(cur);
      const cycleNodes = stack.slice(idx);
      const closing = parentSnap.get(cycleNodes[cycleNodes.length - 1]);
      out.push({
        kind: 'cycle',
        snapId: closing?.id ?? null,
        compId: cur,
        message: `Snap cycle: ${cycleNodes.join(' → ')} → ${cur}`,
      });
    }
    for (const n of stack) color.set(n, 2);
  }
  return out;
}

// Each snap is directional: `from` is the parent (already placed), `to` is the
// child (placed relative to from). Snaps form a DAG. The solver settles
// roots (components with no incoming snap) at their raw cx/cy, then iteratively
// places children whose parents are already settled.
//
// A component can only be the `to` of ONE snap (that snap fully determines its
// position). When the user creates a new snap whose target is already
// constrained, the snap-creation logic auto-reverses the snap so the already-
// constrained component becomes the `from` and the partner becomes the `to`.
// This way a component can be involved in many snaps: one positions it, the
// rest propagate outward through it.
export function solveLayout(components, snaps, paramValues) {
  // Fresh diagnostics record for this solve; finalized before return.
  const diag = { converged: true, iterations: 0, issues: [] };
  lastSolveDiagnostics = diag;
  const byId = Object.fromEntries(components.map(c => [c.id, { ...c }]));
  // Working paramValues that grows with synthetic per-component position
  // entries (`_comp_<id>_cx`, `_comp_<id>_cy`) as components get placed.
  // Span expressions on a child component can reference these to track a
  // parent's CURRENT position, including parents that are free roots whose
  // position changes over time (e.g., when the user drags or resizes them).
  // Without this, span expressions see only literal snapshots taken at
  // creation time.
  const workingPV = { ...paramValues };
  // Compute a boolean component's effective bbox-derived cx/cy/w/h from
  // its operands' CURRENT positions. Used to make booleans participate in
  // the snap graph as first-class objects: their anchors derive from the
  // operand-bbox AABB, and snaps from/to the boolean use those anchors.
  // `inProgress` guards the refreshBooleanBbox → refreshBooleanBbox
  // recursion (subtract/intersect base operands that are themselves
  // booleans): a cyclic operand structure bails out instead of looping
  // forever. The per-operand `visited` set inside operandBbox guards the
  // nested-operand walk the same way.
  const refreshBooleanBbox = (b, inProgress = new Set()) => {
    if (inProgress.has(b.id)) return false; // cyclic operand structure
    inProgress.add(b.id);
    const done = (ok) => { inProgress.delete(b.id); return ok; };
    // AABB of a single operand. Nested booleans contribute the union of
    // their own operands (recursively). We DON'T expand transforms here
    // (solveLayout is pre-transform); transform-based expansion happens
    // in expandTransforms downstream. The bbox here is the BASE rect,
    // which is what snap targets should use.
    const operandBbox = (cid, visited) => {
      if (visited.has(cid)) return null; // cycle — already on this walk
      visited.add(cid);
      const c = byId[cid];
      if (!c) return null;
      if (c.kind === 'boolean') {
        let bb = null;
        for (const opid of (c.operandIds || [])) {
          const obb = operandBbox(opid, visited);
          if (!obb) continue;
          bb = bb
            ? {
                minX: Math.min(bb.minX, obb.minX), maxX: Math.max(bb.maxX, obb.maxX),
                minY: Math.min(bb.minY, obb.minY), maxY: Math.max(bb.maxY, obb.maxY),
              }
            : obb;
        }
        return bb;
      }
      const w = evalExpr(c.w, workingPV);
      const h = evalExpr(c.h, workingPV);
      if (!Number.isFinite(w) || !Number.isFinite(h)) return null;
      // First-class rotation: the operand's AABB grows to enclose the
      // rotated bbox (|w·cos|+|h·sin| half-extents). Keeps snap targets
      // on a boolean containing rotated operands consistent with the
      // post-solve resolveBooleanBboxes refinement.
      const rot = compRotationDeg(c, workingPV);
      let hw = w / 2, hh = h / 2;
      if (rot) {
        const rad = rot * Math.PI / 180;
        const ca = Math.abs(Math.cos(rad)), sa = Math.abs(Math.sin(rad));
        const rw = hw * ca + hh * sa;
        const rh = hw * sa + hh * ca;
        hw = rw; hh = rh;
      }
      return { minX: c.cx - hw, maxX: c.cx + hw, minY: c.cy - hh, maxY: c.cy + hh };
    };
    // Per-operand bboxes, kept separate so INTERSECT can take the AABB
    // intersection instead of the union. Each operand gets a fresh
    // visited set (seeded with b.id so a self-referencing operand bails
    // immediately); sharing one set across operands would wrongly zero
    // out diamond-shared sub-operands in the intersect math.
    const opBbs = (b.operandIds || []).map(opid => operandBbox(opid, new Set([b.id])));
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const bb of opBbs) {
      if (!bb) continue;
      if (bb.minX < minX) minX = bb.minX; if (bb.maxX > maxX) maxX = bb.maxX;
      if (bb.minY < minY) minY = bb.minY; if (bb.maxY > maxY) maxY = bb.maxY;
    }
    if (!Number.isFinite(minX)) return done(false);
    // For SUBTRACT/PUNCH, restrict the bbox to operand 0 (the base). For
    // INTERSECT, take the AABB intersection of all operand bboxes — the
    // result region can't extend past any operand. An empty intersection
    // (disjoint operands) falls back to the base bbox: degenerate but
    // defined, so snaps targeting the boolean don't explode.
    if (b.op === 'subtract' || b.op === 'intersect' || b.op === 'punch') {
      const baseId = b.operandIds?.[0];
      const base = baseId != null ? byId[baseId] : null;
      let baseBb = null;
      if (base) {
        if (base.kind === 'boolean') {
          // Recurse to get the base boolean's bbox with ITS op-specific
          // restriction applied (operandBbox's union would be looser).
          if (refreshBooleanBbox(base, inProgress)) {
            baseBb = {
              minX: base.cx - base.w / 2, maxX: base.cx + base.w / 2,
              minY: base.cy - base.h / 2, maxY: base.cy + base.h / 2,
            };
          }
        } else {
          baseBb = opBbs[0];
        }
      }
      if (!baseBb) return done(false);
      if (b.op === 'intersect') {
        let ix0 = baseBb.minX, ix1 = baseBb.maxX, iy0 = baseBb.minY, iy1 = baseBb.maxY;
        for (let i = 1; i < opBbs.length; i++) {
          const obb = opBbs[i];
          if (!obb) continue;
          ix0 = Math.max(ix0, obb.minX); ix1 = Math.min(ix1, obb.maxX);
          iy0 = Math.max(iy0, obb.minY); iy1 = Math.min(iy1, obb.maxY);
        }
        if (ix0 <= ix1 && iy0 <= iy1) {
          minX = ix0; maxX = ix1; minY = iy0; maxY = iy1;
        } else {
          minX = baseBb.minX; maxX = baseBb.maxX; minY = baseBb.minY; maxY = baseBb.maxY;
        }
      } else {
        minX = baseBb.minX; maxX = baseBb.maxX; minY = baseBb.minY; maxY = baseBb.maxY;
      }
    }
    b.cx = (minX + maxX) / 2;
    b.cy = (minY + maxY) / 2;
    b.w = maxX - minX;
    b.h = maxY - minY;
    return done(true);
  };
  // Recompute a polyline's AABB-derived w/h from its resolved vertex
  // positions. UNLIKE refreshBooleanBbox we do NOT overwrite c.cx /
  // c.cy — those stay as vertex 0's world position (the polyline's
  // drag handle and the chain root for rel-mode vertices). The bbox
  // center is exposed via `displayBbox` for any future anchor-lookup
  // path that wants it; the post-solve c.w / c.h carries the bbox
  // dimensions so the synthetic `_comp_<id>_w` / `_h` params reflect
  // the actual extent.
  const refreshPolylineBbox = (p) => {
    // Tessellated path (arcs expanded, spline runs interpolated) so the
    // AABB includes arc bulges that extend past the vertex endpoints.
    const verts = tessellatePolylinePath(p, byId, workingPV);
    const bb = polylineBbox(p, verts, workingPV);
    p.w = bb.w; p.h = bb.h;
    p.displayBbox = { cx: bb.cx, cy: bb.cy, w: bb.w, h: bb.h };
    // Stash the tessellated world-space path on the SOLVED component so
    // downstream ring consumers (shapeInstanceToRing → GDS boundaries,
    // boolean mask paths) can rebuild the drawn curve without re-walking
    // the vertex chain. expandTransforms carries this through to each
    // instance (alongside _baseCx/_baseCy for the clone-frame remap).
    p._resolvedVerts = verts;
    return true;
  };
  // Same bookkeeping for polyshape (closed 2-D polygon) — uses the
  // vertex-only AABB with no width padding, since polyshapes are flat
  // fills, not swept traces.
  const refreshPolyshapeBbox = (p) => {
    const verts = tessellatePolylinePath(p, byId, workingPV);
    const bb = polyshapeBbox(verts);
    p.w = bb.w; p.h = bb.h;
    p.displayBbox = { cx: bb.cx, cy: bb.cy, w: bb.w, h: bb.h };
    p._resolvedVerts = verts;
    return true;
  };
  const recordPlaced = (c) => {
    // For booleans, refresh bbox-derived cx/cy/w/h from operands BEFORE
    // recording, so the synthetic values reflect the actual geometry that
    // anchorWorld will see for this component.
    if (c.kind === 'boolean') refreshBooleanBbox(c);
    // Polylines: same idea, but bbox comes from vertex positions (plus
    // half-width padding) rather than operand AABBs.
    if (c.kind === 'polyline') refreshPolylineBbox(c);
    if (c.kind === 'polyshape') refreshPolyshapeBbox(c);
    // NaN guards: never write a non-finite synthetic. A NaN here would
    // silently poison every downstream expression that references it
    // (the poisoned expression evaluates to 0 via evalExpr's fallback,
    // collapsing dependent geometry to the origin).
    if (Number.isFinite(c.cx)) workingPV[`_comp_${c.id}_cx`] = c.cx;
    if (Number.isFinite(c.cy)) workingPV[`_comp_${c.id}_cy`] = c.cy;
    // Resolved width/height too. Span expressions read these so the spanning
    // child stays connected to a parent even when the parent's width/height
    // is itself an expression like "cap_sep/2 - port_L/2" (which would
    // otherwise be embedded as TEXT in the span and not track parent edits).
    const wNum = typeof c.w === 'number' ? c.w : evalExpr(c.w, workingPV);
    const hNum = typeof c.h === 'number' ? c.h : evalExpr(c.h, workingPV);
    if (Number.isFinite(wNum)) workingPV[`_comp_${c.id}_w`] = wNum;
    if (Number.isFinite(hNum)) workingPV[`_comp_${c.id}_h`] = hNum;
  };
  const placed = new Set();
  const dependents = new Set(snaps.map(s => s.to.compId));
  // First pass: place components with no incoming snap. Booleans count as
  // placed only AFTER all their operands are placed (because their bbox
  // depends on operand positions). We iterate to fixed-point.
  const isResolvable = (c) => {
    if (c.kind === 'boolean') {
      return (c.operandIds || []).every(id => placed.has(id));
    }
    return true;
  };
  for (const c of components) {
    if (!dependents.has(c.id) && isResolvable(c)) {
      placed.add(c.id);
      recordPlaced(byId[c.id]);
    }
  }
  let progressed = true;
  let iters = 0;
  while (progressed && iters < 100) {
    progressed = false;
    iters++;
    // Try placing snap targets whose parents are already placed.
    for (const s of snaps) {
      if (placed.has(s.to.compId)) continue;
      if (!placed.has(s.from.compId)) continue;
      const fromComp = byId[s.from.compId];
      const toComp = byId[s.to.compId];
      if (!fromComp || !toComp) continue;
      // For boolean toComp, w/h come from refreshBooleanBbox-after-placing.
      // BUT a boolean can't be the `to` of a snap: its position is derived
      // from operand positions, not from a snap. If the user creates such
      // a snap, we silently skip it (the boolean stays at operand-bbox
      // center). For now, allow the snap to push an offset on top of the
      // bbox center: place at fromAnchor + dx - toLocal where toLocal is
      // computed from the boolean's bbox-derived w/h.
      const fromAnchor = anchorWorld(fromComp, s.from.anchor, workingPV);
      // For boolean toComp: refresh bbox FIRST so its w/h reflect current
      // operand positions. Then we compute the snap-driven center based on
      // those dimensions, which will be DIFFERENT from the natural bbox
      // center — and we shift the operands accordingly below.
      if (toComp.kind === 'boolean') refreshBooleanBbox(toComp);
      const tw = typeof toComp.w === 'number' ? toComp.w : evalExpr(toComp.w, workingPV);
      const th = typeof toComp.h === 'number' ? toComp.h : evalExpr(toComp.h, workingPV);
      // The child's own anchor offset rotates with its first-class
      // rotation (matches anchorWorld on the parent side), so a rotated
      // child snaps by its ROTATED corner/edge, not the unrotated bbox.
      const toLocal = anchorLocalRotated(s.to.anchor, tw, th, compRotationDeg(toComp, workingPV));
      // Non-finite snap offsets (e.g. a dx expression that divides by a
      // zero-valued param) are zeroed so the child still lands somewhere
      // sane; the anomaly is surfaced via solve diagnostics.
      let dx = evalExpr(s.dx, workingPV);
      let dy = evalExpr(s.dy, workingPV);
      if (!Number.isFinite(dx)) {
        diag.issues.push({ kind: 'nan-snap-offset', message: `Snap ${s.id ?? `${s.from.compId}→${s.to.compId}`}: dx "${s.dx}" evaluated non-finite — treated as 0` });
        dx = 0;
      }
      if (!Number.isFinite(dy)) {
        diag.issues.push({ kind: 'nan-snap-offset', message: `Snap ${s.id ?? `${s.from.compId}→${s.to.compId}`}: dy "${s.dy}" evaluated non-finite — treated as 0` });
        dy = 0;
      }
      const targetCx = fromAnchor.x + dx - toLocal.x;
      const targetCy = fromAnchor.y + dy - toLocal.y;
      if (toComp.kind === 'boolean') {
        // The snap dictates where the boolean's bbox-center should be.
        // Translate all operand components by the delta so the boolean's
        // refreshed bbox-center lands at the target.
        const dxShift = targetCx - toComp.cx;
        const dyShift = targetCy - toComp.cy;
        if (Math.abs(dxShift) > 1e-9 || Math.abs(dyShift) > 1e-9) {
          // Only shift CONSUMED operands. A punch keeps its tool
          // independent, so a snap on the boolean must not drag the
          // tool along — that would mimic KeepOriginals=False semantics.
          const shiftVisited = new Set([toComp.id]); // cycle guard for nested booleans
          const shiftCluster = (cid, parentBoolId) => {
            if (shiftVisited.has(cid)) return;
            shiftVisited.add(cid);
            const c = byId[cid];
            if (!c) return;
            if (parentBoolId && c.consumedBy !== parentBoolId) return;
            if (c.kind === 'boolean') {
              for (const opid of (c.operandIds || [])) shiftCluster(opid, c.id);
            } else {
              c.cx += dxShift;
              c.cy += dyShift;
              if (placed.has(c.id)) {
                if (Number.isFinite(c.cx)) workingPV[`_comp_${c.id}_cx`] = c.cx;
                if (Number.isFinite(c.cy)) workingPV[`_comp_${c.id}_cy`] = c.cy;
              }
            }
          };
          for (const opid of (toComp.operandIds || [])) shiftCluster(opid, toComp.id);
          refreshBooleanBbox(toComp);
        }
      } else {
        toComp.cx = targetCx;
        toComp.cy = targetCy;
      }
      placed.add(toComp.id);
      recordPlaced(toComp);
      progressed = true;
    }
    // Also try placing booleans whose operands are now all placed (and
    // which have no incoming snap).
    for (const c of components) {
      if (placed.has(c.id)) continue;
      if (dependents.has(c.id)) continue;
      if (c.kind !== 'boolean') continue;
      if (!isResolvable(byId[c.id])) continue;
      placed.add(c.id);
      recordPlaced(byId[c.id]);
      progressed = true;
    }
  }
  diag.iterations = iters;
  if (progressed && iters >= 100) {
    // Loop exited on the iteration cap while still making progress —
    // the snap graph didn't settle (likely a cycle or pathological chain).
    diag.converged = false;
    diag.issues.push({ kind: 'iteration-cap', message: 'Snap solver hit the 100-iteration cap without settling' });
  }
  // Final pass: refresh boolean bboxes for ANY boolean whose operands have
  // moved since the boolean was last refreshed. This catches consumed
  // (nested) booleans that don't get re-placed in the snap loop above.
  // Iterate to fixed-point (max two passes for typical scenes).
  for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    for (const c of components) {
      const stored = byId[c.id];
      if (stored.kind !== 'boolean') continue;
      const beforeCx = stored.cx, beforeCy = stored.cy;
      const beforeW = stored.w, beforeH = stored.h;
      refreshBooleanBbox(stored);
      if (stored.cx !== beforeCx || stored.cy !== beforeCy ||
          stored.w !== beforeW || stored.h !== beforeH) {
        changed = true;
        // Re-record synthetics for this boolean (finite values only —
        // see the NaN-guard note in recordPlaced).
        if (Number.isFinite(stored.cx)) workingPV[`_comp_${c.id}_cx`] = stored.cx;
        if (Number.isFinite(stored.cy)) workingPV[`_comp_${c.id}_cy`] = stored.cy;
        if (Number.isFinite(stored.w)) workingPV[`_comp_${c.id}_w`] = stored.w;
        if (Number.isFinite(stored.h)) workingPV[`_comp_${c.id}_h`] = stored.h;
      }
    }
    if (!changed) break;
  }
  return Object.values(byId);
}

export function applyMirrors(components, mirrors) {
  const byId = Object.fromEntries(components.map(c => [c.id, { ...c }]));
  for (const m of mirrors) {
    for (const mem of m.members) {
      if (!mem.locked) continue;
      const src = byId[mem.srcId];
      const tgt = byId[mem.mirrorId];
      if (!src || !tgt) continue;
      if (m.axis === 'horizontal') {
        tgt.cy = 2 * m.axisCoord - src.cy;
        tgt.cx = src.cx;
      } else {
        tgt.cx = 2 * m.axisCoord - src.cx;
        tgt.cy = src.cy;
      }
      tgt.w = src.w;
      tgt.h = src.h;
      tgt.layer = src.layer;
      tgt.cutouts = src.cutouts;
    }
  }
  return Object.values(byId);
}

// Boolean components (kind='boolean') are derived objects with no
// independent w/h — they're stored as `w: '0', h: '0'` since their
// geometry is determined by their operands. For everything else in the
// layout system to treat them uniformly with primitives (anchor lookups,
// snap targeting, dimensions, drag handles), we compute an effective
// axis-aligned bbox over the operands' transformed instances and write
// numeric w/h plus a centered cx/cy back into the solved record.
//
// The bbox is the AABB of the union of all operands' rendered instances
// (recursively, so booleans-of-booleans work). For SUBTRACT and INTERSECT
// the actual result region may be smaller, but using the AABB of the base
// (= operand 0) is a safe over-approximation: any anchor on a primitive's
// edge maps to a corresponding point on the boolean's bbox, and snap
// targeting is well-defined. For UNION we use the AABB across all operands.
//
// `solved` is mutated in place; an inputs map { compId → component } is
// used so booleans-of-booleans see already-resolved bboxes for nested
// boolean operands. We do a topological pass: resolve booleans whose
// operands are all primitives or already-resolved booleans, repeat until
// no progress.
export function resolveBooleanBboxes(solved, paramValues) {
  const byId = Object.fromEntries(solved.map(c => [c.id, c]));
  // bboxOf returns {minX, maxX, minY, maxY} for any component using its
  // CURRENT (possibly-just-resolved) cx/cy/w/h. For primitives we expand
  // the transform chain to get all rendered instances. For booleans we
  // use whatever w/h has been written so far (post-resolution).
  const bboxOfComponent = (c) => {
    if (!c) return null;
    const out = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
    if (c.kind === 'boolean') {
      // Use the boolean's own resolved cx/cy/w/h if available.
      const w = typeof c.w === 'string' ? evalExpr(c.w, paramValues) : c.w;
      const h = typeof c.h === 'string' ? evalExpr(c.h, paramValues) : c.h;
      if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
      out.minX = c.cx - w / 2;
      out.maxX = c.cx + w / 2;
      out.minY = c.cy - h / 2;
      out.maxY = c.cy + h / 2;
      return out;
    }
    // Primitive: union AABB across all transform instances.
    const insts = expandTransforms([c], paramValues);
    if (insts.length === 0) return null;
    for (const inst of insts) {
      if (!Number.isFinite(inst.w) || !Number.isFinite(inst.h)) continue;
      // Account for rotation by computing the rotated rect's corner ring
      // and taking its AABB.
      const halfW = inst.w / 2, halfH = inst.h / 2;
      let corners = [
        [-halfW, -halfH], [halfW, -halfH],
        [halfW, halfH], [-halfW, halfH],
      ];
      const rot = inst.rotation || 0;
      if (Math.abs(rot) > 1e-9) {
        const rad = rot * Math.PI / 180;
        const ca = Math.cos(rad), sa = Math.sin(rad);
        corners = corners.map(([lx, ly]) => [lx * ca - ly * sa, lx * sa + ly * ca]);
      }
      for (const [lx, ly] of corners) {
        const x = inst.cx + lx, y = inst.cy + ly;
        if (x < out.minX) out.minX = x;
        if (x > out.maxX) out.maxX = x;
        if (y < out.minY) out.minY = y;
        if (y > out.maxY) out.maxY = y;
      }
    }
    if (!Number.isFinite(out.minX)) return null;
    return out;
  };
  // Topological resolution: keep iterating until nothing changes. Bounded
  // by component count to avoid infinite loops on cycles (which shouldn't
  // exist but defensive).
  const resolved = new Set();
  for (const c of solved) if (c.kind !== 'boolean') resolved.add(c.id);
  let pass = 0;
  while (pass++ < solved.length + 1) {
    let progress = false;
    for (const c of solved) {
      if (c.kind !== 'boolean' || resolved.has(c.id)) continue;
      // Every operand must be already resolved.
      const ops = (c.operandIds || []).map(id => byId[id]).filter(Boolean);
      if (ops.length < 2) continue;
      if (!ops.every(o => o.kind !== 'boolean' || resolved.has(o.id))) continue;
      // Compute the AABB. Per-operand bboxes are kept so INTERSECT can
      // take the AABB intersection below.
      const opBbs = ops.map(op => bboxOfComponent(op));
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const bb of opBbs) {
        if (!bb) continue;
        if (bb.minX < minX) minX = bb.minX;
        if (bb.maxX > maxX) maxX = bb.maxX;
        if (bb.minY < minY) minY = bb.minY;
        if (bb.maxY > maxY) maxY = bb.maxY;
      }
      if (!Number.isFinite(minX)) {
        // Degenerate — leave as-is.
        resolved.add(c.id);
        continue;
      }
      // For SUBTRACT and PUNCH, the result region is bounded by the BASE
      // operand (operand 0) — using its bbox is a tighter estimate than
      // the full operand-union bbox. For INTERSECT, the result can't
      // extend past ANY operand, so take the AABB intersection of all
      // operand bboxes (max of mins / min of maxs); if the operands are
      // disjoint (empty intersection), fall back to the base bbox —
      // degenerate but defined, so snaps targeting it don't explode.
      if (c.op === 'subtract' || c.op === 'punch') {
        const bb0 = opBbs[0];
        if (bb0) {
          minX = bb0.minX; maxX = bb0.maxX;
          minY = bb0.minY; maxY = bb0.maxY;
        }
      } else if (c.op === 'intersect') {
        let ix0 = -Infinity, ix1 = Infinity, iy0 = -Infinity, iy1 = Infinity;
        let any = false;
        for (const bb of opBbs) {
          if (!bb) continue; // unknown operand bbox — don't constrain
          any = true;
          ix0 = Math.max(ix0, bb.minX); ix1 = Math.min(ix1, bb.maxX);
          iy0 = Math.max(iy0, bb.minY); iy1 = Math.min(iy1, bb.maxY);
        }
        if (any && ix0 <= ix1 && iy0 <= iy1) {
          minX = ix0; maxX = ix1; minY = iy0; maxY = iy1;
        } else if (opBbs[0]) {
          minX = opBbs[0].minX; maxX = opBbs[0].maxX;
          minY = opBbs[0].minY; maxY = opBbs[0].maxY;
        }
      }
      // Boolean's stored cx/cy is its anchor for drag; we keep that intact
      // unless the boolean has never been positioned (cx/cy of 0 with
      // operand bbox far from origin would look wrong on first render).
      // For now: always rewrite cx/cy to the bbox center so the boolean's
      // anchor position stays consistent with its visible geometry.
      c.cx = (minX + maxX) / 2;
      c.cy = (minY + maxY) / 2;
      c.w = (maxX - minX);
      c.h = (maxY - minY);
      // ── POST-TRANSFORM AABB (display + snap targeting) ─────────────────
      // If the boolean carries a transform chain (e.g. repeat + rotate),
      // its visible footprint after transforms is different from the
      // pre-transform operand AABB just set. We expand the chain and take
      // the union AABB across all rendered instances, accounting for each
      // instance's rotation. The result is stored as `displayBbox` on the
      // solved record — `{cx, cy, w, h}` of the rotated/replicated cluster.
      //
      // Downstream consumers prefer displayBbox over the bare cx/cy/w/h:
      //   - anchor dots (snap-mode) sit on the rotated cluster's AABB edges
      //   - the selection-halo bbox encloses the visible footprint
      //   - new snaps from/to this boolean compute offsets against the
      //     post-transform anchor world positions
      //   - anchorWorld treats displayBbox as the canonical world bbox.
      //
      // We do NOT overwrite cx/cy/w/h directly because the canvas's
      // boolean renderer expects them to be the PRE-transform centroid:
      // operand positions are pre-transform, and the per-instance override
      // math (buildBoolInstanceOverrides) computes operand offsets from
      // the pre-transform centroid. Storing the post-transform bbox in a
      // separate field keeps both consumers correct.
      if (c.transforms && c.transforms.some(t => t && t.enabled !== false)) {
        const insts = expandTransforms([c], paramValues);
        if (insts.length > 0) {
          const baseW = c.w, baseH = c.h;
          let pMinX = Infinity, pMaxX = -Infinity, pMinY = Infinity, pMaxY = -Infinity;
          for (const inst of insts) {
            const halfW = baseW / 2, halfH = baseH / 2;
            let corners = [
              [-halfW, -halfH], [halfW, -halfH],
              [halfW, halfH], [-halfW, halfH],
            ];
            const rot = inst.rotation || 0;
            if (Math.abs(rot) > 1e-9) {
              const rad = rot * Math.PI / 180;
              const ca = Math.cos(rad), sa = Math.sin(rad);
              corners = corners.map(([lx, ly]) => [lx * ca - ly * sa, lx * sa + ly * ca]);
            }
            for (const [lx, ly] of corners) {
              const x = inst.cx + lx, y = inst.cy + ly;
              if (x < pMinX) pMinX = x;
              if (x > pMaxX) pMaxX = x;
              if (y < pMinY) pMinY = y;
              if (y > pMaxY) pMaxY = y;
            }
          }
          if (Number.isFinite(pMinX)) {
            c.displayBbox = {
              cx: (pMinX + pMaxX) / 2,
              cy: (pMinY + pMaxY) / 2,
              w: pMaxX - pMinX,
              h: pMaxY - pMinY,
            };
          }
        }
      }
      resolved.add(c.id);
      progress = true;
    }
    if (!progress) break;
  }
  return solved;
}
