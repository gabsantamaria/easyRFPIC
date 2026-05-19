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
import { anchorLocal, anchorWorld } from './anchors.js';
import { expandTransforms } from './transforms.js';
import { resolvePolylineVertices, polylineBbox, polyshapeBbox } from '../geometry/polyline.js';

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
  const refreshBooleanBbox = (b) => {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    const visit = (cid) => {
      const c = byId[cid];
      if (!c) return;
      if (c.kind === 'boolean') {
        // Recurse: nested boolean's bbox is built from its own operands.
        for (const opid of (c.operandIds || [])) visit(opid);
        return;
      }
      // Primitive: account for its w/h and position. We DON'T expand
      // transforms here (solveLayout is pre-transform); transform-based
      // expansion would happen in expandTransforms downstream. The bbox
      // here is the BASE rect, which is what snap targets should use.
      const w = evalExpr(c.w, workingPV);
      const h = evalExpr(c.h, workingPV);
      if (!Number.isFinite(w) || !Number.isFinite(h)) return;
      const x0 = c.cx - w / 2, x1 = c.cx + w / 2;
      const y0 = c.cy - h / 2, y1 = c.cy + h / 2;
      if (x0 < minX) minX = x0; if (x1 > maxX) maxX = x1;
      if (y0 < minY) minY = y0; if (y1 > maxY) maxY = y1;
    };
    for (const opid of (b.operandIds || [])) visit(opid);
    if (!Number.isFinite(minX)) return false;
    // For SUBTRACT and INTERSECT, restrict the bbox to operand 0 (the base).
    if (b.op === 'subtract' || b.op === 'intersect' || b.op === 'punch') {
      minX = Infinity; maxX = -Infinity; minY = Infinity; maxY = -Infinity;
      const base = byId[b.operandIds?.[0]];
      if (base) {
        if (base.kind === 'boolean') {
          // Recurse to get the base boolean's bbox.
          if (!refreshBooleanBbox(base)) return false;
          const bw = base.w, bh = base.h;
          minX = base.cx - bw / 2; maxX = base.cx + bw / 2;
          minY = base.cy - bh / 2; maxY = base.cy + bh / 2;
        } else {
          const w = evalExpr(base.w, workingPV);
          const h = evalExpr(base.h, workingPV);
          if (!Number.isFinite(w) || !Number.isFinite(h)) return false;
          minX = base.cx - w / 2; maxX = base.cx + w / 2;
          minY = base.cy - h / 2; maxY = base.cy + h / 2;
        }
      }
      if (!Number.isFinite(minX)) return false;
    }
    b.cx = (minX + maxX) / 2;
    b.cy = (minY + maxY) / 2;
    b.w = maxX - minX;
    b.h = maxY - minY;
    return true;
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
    const verts = resolvePolylineVertices(p, byId, workingPV);
    const bb = polylineBbox(p, verts, workingPV);
    p.w = bb.w; p.h = bb.h;
    p.displayBbox = { cx: bb.cx, cy: bb.cy, w: bb.w, h: bb.h };
    return true;
  };
  // Same bookkeeping for polyshape (closed 2-D polygon) — uses the
  // vertex-only AABB with no width padding, since polyshapes are flat
  // fills, not swept traces.
  const refreshPolyshapeBbox = (p) => {
    const verts = resolvePolylineVertices(p, byId, workingPV);
    const bb = polyshapeBbox(verts);
    p.w = bb.w; p.h = bb.h;
    p.displayBbox = { cx: bb.cx, cy: bb.cy, w: bb.w, h: bb.h };
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
    workingPV[`_comp_${c.id}_cx`] = c.cx;
    workingPV[`_comp_${c.id}_cy`] = c.cy;
    // Resolved width/height too. Span expressions read these so the spanning
    // child stays connected to a parent even when the parent's width/height
    // is itself an expression like "cap_sep/2 - port_L/2" (which would
    // otherwise be embedded as TEXT in the span and not track parent edits).
    workingPV[`_comp_${c.id}_w`] = typeof c.w === 'number' ? c.w : evalExpr(c.w, workingPV);
    workingPV[`_comp_${c.id}_h`] = typeof c.h === 'number' ? c.h : evalExpr(c.h, workingPV);
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
      const toLocal = anchorLocal(s.to.anchor, tw, th);
      const dx = evalExpr(s.dx, workingPV);
      const dy = evalExpr(s.dy, workingPV);
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
          const shiftCluster = (cid, parentBoolId) => {
            const c = byId[cid];
            if (!c) return;
            if (parentBoolId && c.consumedBy !== parentBoolId) return;
            if (c.kind === 'boolean') {
              for (const opid of (c.operandIds || [])) shiftCluster(opid, c.id);
            } else {
              c.cx += dxShift;
              c.cy += dyShift;
              if (placed.has(c.id)) {
                workingPV[`_comp_${c.id}_cx`] = c.cx;
                workingPV[`_comp_${c.id}_cy`] = c.cy;
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
        // Re-record synthetics for this boolean.
        workingPV[`_comp_${c.id}_cx`] = stored.cx;
        workingPV[`_comp_${c.id}_cy`] = stored.cy;
        workingPV[`_comp_${c.id}_w`] = stored.w;
        workingPV[`_comp_${c.id}_h`] = stored.h;
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
      // Compute the AABB.
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const op of ops) {
        const bb = bboxOfComponent(op);
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
      // For SUBTRACT and INTERSECT, the result region is bounded by the
      // BASE operand (operand 0) — using its bbox is a tighter estimate
      // than the full operand-union bbox. INTERSECT is bounded by the
      // intersection of operands, but that requires polygon math; we use
      // the base bbox as a safe over-approximation.
      if (c.op === 'subtract' || c.op === 'intersect' || c.op === 'punch') {
        const bb0 = bboxOfComponent(ops[0]);
        if (bb0) {
          minX = bb0.minX; maxX = bb0.maxX;
          minY = bb0.minY; maxY = bb0.maxY;
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
