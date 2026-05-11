import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { Plus, Trash2, RotateCcw, RotateCw, Download, Upload, Lock, Unlock, FlipHorizontal, FlipVertical, Layers, Settings2, Box, Square, Link2, Link2Off, Grid3x3, AlertTriangle, Maximize2, Save, FileText, FilePlus, Copy, FolderTree, BookOpen, Package, Boxes, Pencil, Ruler, Eye, EyeOff, ArrowDown, ArrowUp, Move, Repeat, Combine, Minus, X as XIcon, Circle, Hexagon } from 'lucide-react';
import { eulerBend180Centerline, buildRacetrackCenterline, offsetCenterlineToBand } from './geometry/racetrack.js';
import { tokenizeIdents, resolveParams, evalExpr, RESERVED_IDENTS } from './scene/params.js';
import { ANCHORS, parseAnchor, anchorLocal, anchorWorld } from './scene/anchors.js';
import { rectInstanceToRing, shapeInstanceToRing } from './geometry/rings.js';

// =========================================================================
// PHOTONIC IC LAYOUT TOOL — Phase 1.1
// Cursor-zoom, grid snap, vertex resize, parameter expressions
// =========================================================================

// ----------------------------------------------------------------------
// SNAP CONSTRAINT SOLVER
// ----------------------------------------------------------------------
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
function solveLayout(components, snaps, paramValues) {
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
    if (b.op === 'subtract' || b.op === 'intersect') {
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
  const recordPlaced = (c) => {
    // For booleans, refresh bbox-derived cx/cy/w/h from operands BEFORE
    // recording, so the synthetic values reflect the actual geometry that
    // anchorWorld will see for this component.
    if (c.kind === 'boolean') refreshBooleanBbox(c);
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
          const shiftCluster = (cid) => {
            const c = byId[cid];
            if (!c) return;
            if (c.kind === 'boolean') {
              for (const opid of (c.operandIds || [])) shiftCluster(opid);
            } else {
              c.cx += dxShift;
              c.cy += dyShift;
              if (placed.has(c.id)) {
                workingPV[`_comp_${c.id}_cx`] = c.cx;
                workingPV[`_comp_${c.id}_cy`] = c.cy;
              }
            }
          };
          for (const opid of (toComp.operandIds || [])) shiftCluster(opid);
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

function applyMirrors(components, mirrors) {
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

// ----------------------------------------------------------------------
// PER-COMPONENT TRANSFORMS
// ----------------------------------------------------------------------
// A component carries an optional `transforms` array. Each entry is applied
// in order; transforms are additive in the sense that they each transform
// either the position, the orientation, or the multiplicity of the rect.
// The result is a list of "instances" — concrete rectangles to render and
// export.
//
// Supported transforms:
//   { kind: 'displace',  enabled, dx, dy }                         — shifts cx/cy
//   { kind: 'rotate',    enabled, angle, pivot }                   — adds rotation about pivot
//                          pivot can be a fixed-anchor name ('C', 'N', ...) or 'origin'
//   { kind: 'repeat',    enabled, n, dx, dy, includeOriginal }     — emits N additional copies
//                          along the (dx, dy) vector. If includeOriginal is false,
//                          the base instance is dropped (the chain produces only the copies).
//
// Returns { instances: [...] } where each instance has:
//   { compId, idx, cx, cy, w, h, rotation, transformPath }
// `idx` is a 0-based index into the component's instance list (0 = base/first).
// `transformPath` is a string like '#0' or '#3' identifying which copy this is,
// useful for keying SVG elements.
function expandTransforms(components, paramValues) {
  const instances = [];
  for (const c of components) {
    const w = evalExpr(c.w, paramValues);
    const h = evalExpr(c.h, paramValues);
    // Shape-specific numeric parameters. These are kept on each instance so
    // downstream renderers (canvas, GDS, HFSS) can reproduce the actual
    // geometry instead of approximating from the AABB w/h.
    const kind = c.kind === 'boolean' ? 'boolean' : (c.kind || 'rect');
    const shapeFields = {};
    if (kind === 'circle') {
      shapeFields.r = evalExpr(c.r ?? '0', paramValues);
    } else if (kind === 'ellipse') {
      shapeFields.rx = evalExpr(c.rx ?? '0', paramValues);
      shapeFields.ry = evalExpr(c.ry ?? '0', paramValues);
    } else if (kind === 'polygon') {
      shapeFields.r = evalExpr(c.r ?? '0', paramValues);
      // Number of sides: rounded; clamped to >= 3 (a digon doesn't render).
      const nVal = evalExpr(c.n ?? '6', paramValues);
      shapeFields.n = Math.max(3, Math.round(Number.isFinite(nVal) ? nVal : 6));
    } else if (kind === 'racetrack') {
      shapeFields.R = evalExpr(c.R ?? '100', paramValues);
      shapeFields.L_straight = evalExpr(c.L_straight ?? '300', paramValues);
      shapeFields.p = Math.max(0, Math.min(1, evalExpr(c.p ?? '1', paramValues)));
      // Waveguide width: pulled from the waveguide layer's core_width if a
      // waveguide layer exists in the stack. Override per-component via the
      // `wgWidth` expression field. Default to w_wg if neither is set.
      const wExpr = c.wgWidth ?? 'w_wg';
      const wVal = evalExpr(wExpr, paramValues);
      shapeFields.wgWidth = Number.isFinite(wVal) ? wVal : 1.2;
    }
    if (!Number.isFinite(w) || !Number.isFinite(h)) {
      // Skip degenerate components — keeps render path tolerant.
      instances.push({ compId: c.id, idx: 0, kind, cx: c.cx, cy: c.cy, w: 0, h: 0, rotation: 0, transformPath: '#0', ...shapeFields });
      continue;
    }
    // Start with a single-instance list. Each ENABLED transform either
    // mutates each instance in place, or extends the list (repeat).
    let stream = [{ cx: c.cx, cy: c.cy, w, h, rotation: 0, ...shapeFields }];
    for (const t of (c.transforms || [])) {
      if (!t || t.enabled === false) continue;
      if (t.kind === 'displace') {
        const dx = evalExpr(t.dx ?? '0', paramValues);
        const dy = evalExpr(t.dy ?? '0', paramValues);
        if (!Number.isFinite(dx) || !Number.isFinite(dy)) continue;
        stream = stream.map(inst => ({ ...inst, cx: inst.cx + dx, cy: inst.cy + dy }));
      } else if (t.kind === 'rotate') {
        const angle = evalExpr(t.angle ?? '0', paramValues);
        if (!Number.isFinite(angle)) continue;
        // Pivot: fixed-anchor name ('C', 'NW', ...) or 'origin'. When 'origin',
        // we rotate about world (0, 0) which moves cx/cy too. Otherwise we
        // rotate the rect about its own anchor — cx/cy stays put for 'C'.
        const pivot = t.pivot || 'C';
        if (pivot === 'origin') {
          const rad = angle * Math.PI / 180;
          const ca = Math.cos(rad), sa = Math.sin(rad);
          stream = stream.map(inst => ({
            ...inst,
            cx: inst.cx * ca - inst.cy * sa,
            cy: inst.cx * sa + inst.cy * ca,
            rotation: inst.rotation + angle,
          }));
        } else {
          // Local-anchor pivot: just adds to rotation about the rect's own
          // anchor point. For non-center pivots we also need to shift cx/cy
          // so that the chosen anchor stays fixed.
          stream = stream.map(inst => {
            if (pivot === 'C') {
              return { ...inst, rotation: inst.rotation + angle };
            }
            // Compute the world position of the pivot anchor on this instance,
            // then rotate the rect's center about that pivot.
            const lp = anchorLocal(pivot, inst.w, inst.h);
            const px = inst.cx + lp.x;
            const py = inst.cy + lp.y;
            const rad = angle * Math.PI / 180;
            const ca = Math.cos(rad), sa = Math.sin(rad);
            const dxp = inst.cx - px;
            const dyp = inst.cy - py;
            return {
              ...inst,
              cx: px + dxp * ca - dyp * sa,
              cy: py + dxp * sa + dyp * ca,
              rotation: inst.rotation + angle,
            };
          });
        }
      } else if (t.kind === 'repeat') {
        const n = Math.max(0, Math.floor(evalExpr(t.n ?? '0', paramValues)));
        const dx = evalExpr(t.dx ?? '0', paramValues);
        const dy = evalExpr(t.dy ?? '0', paramValues);
        const includeOriginal = t.includeOriginal !== false;
        if (!Number.isFinite(n) || !Number.isFinite(dx) || !Number.isFinite(dy)) continue;
        const next = [];
        for (const inst of stream) {
          if (includeOriginal) next.push(inst);
          for (let k = 1; k <= n; k++) {
            next.push({ ...inst, cx: inst.cx + dx * k, cy: inst.cy + dy * k });
          }
        }
        stream = next;
      }
      // Unknown kinds are silently ignored — defensive against future schema.
    }
    stream.forEach((inst, idx) => {
      const out = {
        compId: c.id, idx,
        kind,
        cx: inst.cx, cy: inst.cy, w: inst.w, h: inst.h,
        rotation: inst.rotation,
        transformPath: `#${idx}`,
      };
      // Carry shape-specific numeric fields through (r, rx, ry, n,
      // R, L_straight, p, wgWidth for racetracks).
      if (inst.r !== undefined) out.r = inst.r;
      if (inst.rx !== undefined) out.rx = inst.rx;
      if (inst.ry !== undefined) out.ry = inst.ry;
      if (inst.n !== undefined) out.n = inst.n;
      if (inst.R !== undefined) out.R = inst.R;
      if (inst.L_straight !== undefined) out.L_straight = inst.L_straight;
      if (inst.p !== undefined) out.p = inst.p;
      if (inst.wgWidth !== undefined) out.wgWidth = inst.wgWidth;
      instances.push(out);
    });
  }
  return instances;
}

// ----------------------------------------------------------------------
// BOOLEAN COMPONENT EFFECTIVE BBOX RESOLUTION
// ----------------------------------------------------------------------
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
function resolveBooleanBboxes(solved, paramValues) {
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
      if (c.op === 'subtract' || c.op === 'intersect') {
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
      resolved.add(c.id);
      progress = true;
    }
    if (!progress) break;
  }
  return solved;
}

// ----------------------------------------------------------------------
// POLYGON HELPERS
// ----------------------------------------------------------------------
// We use these to convert rectangles (possibly rotated) into points for
// SVG rendering. Boolean operations themselves are handled visually via
// SVG's <mask> and <clipPath> primitives — see the canvas rendering
// section for details. This delegates the polygon clipping math to the
// browser's rendering pipeline, which is exact for our rectangle inputs
// and matches HFSS's CSG output to float precision.

function ringToSvgPath(ring) {
  if (!ring || ring.length === 0) return '';
  let d = `M ${ring[0][0]} ${-ring[0][1]}`;
  for (let i = 1; i < ring.length; i++) d += ` L ${ring[i][0]} ${-ring[i][1]}`;
  return d + ' Z';
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

// ----------------------------------------------------------------------
// DEFAULT SCENE
// ----------------------------------------------------------------------
function defaultStack() {
  // Bottom-up order. Z=0 is the top of the buried oxide (where the WG sits).
  // Substrates have negative Z, the WG layer is at Z=0..h_wg, conductor sits above.
  // Cladding fills the WG layer's XY footprint at Z=0..h_wg around any waveguides/electrodes.
  // Waveguide-role layers carry rib cross-section fields (core_width, slab_height, slab_width, etch_angle).
  return [
    { id: 'l_si',    name: 'Silicon handle',  thickness: 'h_si',    material: 'silicon',           color: '#5a6878', role: 'substrate' },
    { id: 'l_sio2',  name: 'Buried oxide',    thickness: 'h_sio2',  material: 'silicon_dioxide',   color: '#8da0c0', role: 'substrate' },
    { id: 'l_lt',    name: 'Lithium tantalate WG', thickness: 'h_wg', material: 'lithium_tantalate', color: '#86efac', role: 'waveguide',
      core_width: 'w_wg', core_width_ref: 'top', slab_height: 'h_slab', slab_width: 'w_slab', etch_angle: 'etch_angle' },
    { id: 'l_clad',  name: 'Cladding (SiO2)', thickness: 'h_wg',    material: 'silicon_dioxide',   color: '#cbd5e1', role: 'cladding' },
    { id: 'l_cond',  name: 'Conductor',       thickness: 'h_cond',  material: 'gold',              color: '#daa520', role: 'conductor' },
  ];
}

function normalizeScene(s) {
  if (!s || typeof s !== 'object') return makeDefaultScene();
  const params = { ...(s.params || {}) };
  let stack = s.stack || defaultStack();
  // If the stack is missing a conductor layer, inject one (older scenes pre-date conductor support)
  if (!stack.some(l => l.role === 'conductor')) {
    stack = [
      ...stack,
      { id: 'l_cond', name: 'Conductor', thickness: 'h_cond', material: 'gold', color: '#daa520', role: 'conductor' },
    ];
  }
  // Add WG cross-section fields to any waveguide-role layer that lacks them.
  stack = stack.map(layer => {
    if (layer.role !== 'waveguide') return layer;
    return {
      core_width: 'w_wg',
      core_width_ref: 'top',
      slab_height: 'h_slab',
      slab_width: 'w_slab',
      etch_angle: 'etch_angle',
      ...layer,
    };
  });
  // Ensure every parameter referenced in stack fields exists with a sensible default.
  const STACK_DEFAULTS = {
    h_si: { expr: '250', unit: 'µm', desc: 'Silicon handle thickness' },
    h_sio2: { expr: '4.7', unit: 'µm', desc: 'Buried oxide thickness' },
    h_wg: { expr: '0.6', unit: 'µm', desc: 'WG total height (LiTaO3 layer)' },
    h_clad: { expr: '2', unit: 'µm', desc: 'Cladding thickness' },
    h_cond: { expr: '0.8', unit: 'µm', desc: 'Conductor (electrode) thickness' },
    w_wg: { expr: '1.2', unit: 'µm', desc: 'WG core width (rib bottom)' },
    h_slab: { expr: '0.1', unit: 'µm', desc: 'Slab height (unetched LiTaO3 below rib)' },
    w_slab: { expr: '5', unit: 'µm', desc: 'Slab width (around rib)' },
    etch_angle: { expr: '70', unit: 'deg', desc: 'Etch sidewall angle from horizontal' },
  };
  for (const layer of stack) {
    const fields = ['thickness', 'core_width', 'slab_height', 'slab_width', 'etch_angle'];
    for (const f of fields) {
      const v = layer[f];
      const idents = (typeof v === 'string')
        ? v.match(/[A-Za-z_][A-Za-z0-9_]*/g) || []
        : [];
      for (const id of idents) {
        if (params[id]) continue;
        params[id] = STACK_DEFAULTS[id] || { expr: '1', unit: 'µm', desc: `Layer ${f} (${layer.name || id})` };
      }
    }
  }
  // Migrate legacy `scene.booleans` (a side list) into the new model where
  // booleans are full components with kind='boolean' and operands tagged
  // with consumedBy. Old scenes saved before this refactor will be brought
  // forward automatically; new scenes never write to scene.booleans.
  let migratedComponents = (s.components || []).map(c => ({
    transforms: c.transforms || [],
    ...c,
  }));
  const legacyBooleans = s.booleans || [];
  if (legacyBooleans.length > 0) {
    const consumedSet = new Set();
    const newDerived = [];
    for (const b of legacyBooleans) {
      // Skip disabled legacy booleans (kept as a hint but not made active).
      if (b.enabled === false) continue;
      const ids = (b.operandIds || []).filter(id => migratedComponents.some(c => c.id === id));
      if (ids.length < 2) continue;
      // Centroid of operand bbox (approximate — we don't have a solver result here)
      let cxSum = 0, cySum = 0, count = 0;
      for (const id of ids) {
        const c = migratedComponents.find(cc => cc.id === id);
        if (c && Number.isFinite(c.cx) && Number.isFinite(c.cy)) {
          cxSum += c.cx; cySum += c.cy; count++;
        }
      }
      const cx = count > 0 ? cxSum / count : 0;
      const cy = count > 0 ? cySum / count : 0;
      const baseOp = migratedComponents.find(c => c.id === ids[0]);
      const layer = baseOp?.layer || 'waveguide';
      newDerived.push({
        id: b.id || `migrated_${b.op}_${Math.random().toString(36).slice(2, 6)}`,
        kind: 'boolean',
        op: b.op,
        operandIds: ids,
        layer,
        cx, cy,
        w: '0', h: '0',
        cutouts: [],
        transforms: [],
        label: b.label || '',
        ...(baseOp?.conductorLayerId ? { conductorLayerId: baseOp.conductorLayerId } : {}),
      });
      for (const id of ids) consumedSet.add(id);
    }
    migratedComponents = migratedComponents.map(c => consumedSet.has(c.id) ? { ...c, consumedBy: newDerived.find(d => (d.operandIds || []).includes(c.id))?.id } : c);
    migratedComponents = [...migratedComponents, ...newDerived];
  }

  return {
    params,
    components: migratedComponents,
    snaps: s.snaps || [],
    mirrors: s.mirrors || [],
    groups: s.groups || [],
    // booleans field kept empty for legacy compatibility — the source of
    // truth is now scene.components entries with kind='boolean'.
    booleans: [],
    stack,
  };
}

function makeDefaultScene() {
  const params = {
    w_wg: { expr: '1.2', unit: 'µm', desc: 'WG core width (rib bottom)' },
    h_wg: { expr: '0.6', unit: 'µm', desc: 'WG total height (LiTaO3 layer)' },
    h_slab: { expr: '0.1', unit: 'µm', desc: 'Slab height (unetched LiTaO3 below rib)' },
    w_slab: { expr: '5', unit: 'µm', desc: 'Slab width (around rib)' },
    etch_angle: { expr: '70', unit: 'deg', desc: 'Etch sidewall angle from horizontal (90 = vertical)' },
    h_si: { expr: '250', unit: 'µm', desc: 'Silicon handle thickness' },
    h_sio2: { expr: '4.7', unit: 'µm', desc: 'Buried oxide thickness' },
    h_clad: { expr: '2', unit: 'µm', desc: 'Cladding (legacy slab) thickness' },
    h_cond: { expr: '0.8', unit: 'µm', desc: 'Conductor (electrode) thickness' },
    sidewall_angle: { expr: '75', unit: 'deg', desc: 'Sidewall angle (legacy, see etch_angle)' },
    n_core: { expr: '2.13', unit: '', desc: 'Core index (LiTaO3, ne ~2.13 @ 1550)' },
    n_clad: { expr: '1.45', unit: '', desc: 'Cladding index (SiO2)' },
    electrode_h: { expr: '0.5', unit: 'µm', desc: 'Electrode thickness' },
    electrode_gap: { expr: '4.0', unit: 'µm', desc: 'Electrode-to-WG gap' },
    ring_R: { expr: '80', unit: 'µm', desc: 'Ring outer half-extent' },
    ring_W: { expr: 'w_wg', unit: 'µm', desc: 'Ring waveguide width (= w_wg)' },
    bus_W: { expr: 'w_wg', unit: 'µm', desc: 'Bus waveguide width (= w_wg)' },
    bus_L: { expr: '2*ring_R + 80', unit: 'µm', desc: 'Bus waveguide length' },
    coupling_gap: { expr: '0.4', unit: 'µm', desc: 'Bus-ring coupling gap' },
    sig_W: { expr: '8', unit: 'µm', desc: 'Signal electrode width' },
    sig_L: { expr: '2*ring_R - 4*ring_W', unit: 'µm', desc: 'Signal electrode length (inside ring)' },
    gnd_W: { expr: '30', unit: 'µm', desc: 'Ground plane width' },
    gnd_L: { expr: '2*ring_R + 40', unit: 'µm', desc: 'Ground plane length' },
    // Snap-axis parameters (one per snap axis, even if 0 for galvanic contact)
    gap_x1: { expr: '0', unit: 'µm', desc: 'bus.S → ring_top.N (dx)' },
    gap_y1: { expr: '-coupling_gap', unit: 'µm', desc: 'bus.S → ring_top.N (dy)' },
    gap_x2: { expr: '0', unit: 'µm', desc: 'ring_top.S → ring_bot.N (dx)' },
    gap_y2: { expr: '-(2*ring_R - 2*ring_W)', unit: 'µm', desc: 'ring_top.S → ring_bot.N (dy)' },
    gap_x3: { expr: '0', unit: 'µm', desc: 'ring_top.SW → ring_left.NW (dx)' },
    gap_y3: { expr: '0', unit: 'µm', desc: 'ring_top.SW → ring_left.NW (dy)' },
    gap_x4: { expr: '0', unit: 'µm', desc: 'ring_top.SE → ring_right.NE (dx)' },
    gap_y4: { expr: '0', unit: 'µm', desc: 'ring_top.SE → ring_right.NE (dy)' },
    gap_x5: { expr: 'ring_W', unit: 'µm', desc: 'ring_left.NE → sig.NW (dx)' },
    gap_y5: { expr: '-(ring_R - ring_W - sig_W/2)', unit: 'µm', desc: 'ring_left.NE → sig.NW (dy)' },
    gap_x6: { expr: '0', unit: 'µm', desc: 'bus.N → gnd_top.S (dx)' },
    gap_y6: { expr: 'electrode_gap', unit: 'µm', desc: 'bus.N → gnd_top.S (dy)' },
    gap_x7: { expr: '0', unit: 'µm', desc: 'ring_bot.S → gnd_bot.N (dx)' },
    gap_y7: { expr: '-electrode_gap', unit: 'µm', desc: 'ring_bot.S → gnd_bot.N (dy)' },
  };

  const components = [
    { id: 'bus', kind: 'rect', layer: 'waveguide', cx: 0, cy: 0, w: 'bus_L', h: 'bus_W', cutouts: [], label: 'Bus WG' },
    { id: 'ring_top', kind: 'rect', layer: 'waveguide', cx: 0, cy: 0, w: '2*ring_R', h: 'ring_W', cutouts: [], label: 'Ring top' },
    { id: 'ring_bot', kind: 'rect', layer: 'waveguide', cx: 0, cy: 0, w: '2*ring_R', h: 'ring_W', cutouts: [], label: 'Ring bottom' },
    { id: 'ring_left', kind: 'rect', layer: 'waveguide', cx: 0, cy: 0, w: 'ring_W', h: '2*ring_R - 2*ring_W', cutouts: [], label: 'Ring left' },
    { id: 'ring_right', kind: 'rect', layer: 'waveguide', cx: 0, cy: 0, w: 'ring_W', h: '2*ring_R - 2*ring_W', cutouts: [], label: 'Ring right' },
    { id: 'sig', kind: 'rect', layer: 'electrode', cx: 0, cy: 0, w: 'sig_L', h: 'sig_W', cutouts: [], label: 'Signal electrode' },
    { id: 'gnd_top', kind: 'rect', layer: 'electrode', cx: 0, cy: 0, w: 'gnd_L', h: 'gnd_W', cutouts: [], label: 'Top ground plane' },
    { id: 'gnd_bot', kind: 'rect', layer: 'electrode', cx: 0, cy: 0, w: 'gnd_L', h: 'gnd_W', cutouts: [], label: 'Bottom ground plane' },
  ];

  const snaps = [
    { id: 's1', from: { compId: 'bus', anchor: 'S' }, to: { compId: 'ring_top', anchor: 'N' }, dx: 'gap_x1', dy: 'gap_y1' },
    { id: 's2', from: { compId: 'ring_top', anchor: 'S' }, to: { compId: 'ring_bot', anchor: 'N' }, dx: 'gap_x2', dy: 'gap_y2' },
    { id: 's3', from: { compId: 'ring_top', anchor: 'SW' }, to: { compId: 'ring_left', anchor: 'NW' }, dx: 'gap_x3', dy: 'gap_y3' },
    { id: 's4', from: { compId: 'ring_top', anchor: 'SE' }, to: { compId: 'ring_right', anchor: 'NE' }, dx: 'gap_x4', dy: 'gap_y4' },
    { id: 's5', from: { compId: 'ring_left', anchor: 'NE' }, to: { compId: 'sig', anchor: 'NW' }, dx: 'gap_x5', dy: 'gap_y5' },
    { id: 's6', from: { compId: 'bus', anchor: 'N' }, to: { compId: 'gnd_top', anchor: 'S' }, dx: 'gap_x6', dy: 'gap_y6' },
    { id: 's7', from: { compId: 'ring_bot', anchor: 'S' }, to: { compId: 'gnd_bot', anchor: 'N' }, dx: 'gap_x7', dy: 'gap_y7' },
  ];

  return { params, components, snaps, mirrors: [], groups: [], booleans: [], stack: defaultStack() };
}

// Empty starting scene: same default layer stack so add-tools work right
// away (you need a conductor layer to drag electrodes), but no components,
// no snaps, no parameters. Used by the "new blank" command for starting a
// fresh design from scratch.
function makeBlankScene() {
  return {
    params: {},
    components: [],
    snaps: [],
    mirrors: [],
    groups: [],
    booleans: [],
    stack: defaultStack(),
  };
}

// ----------------------------------------------------------------------
// PYAEDT EXPORT
// ----------------------------------------------------------------------
function generatePyAEDT(scene, paramValues) {
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

// =========================================================================
// NATIVE HFSS COM SCRIPT (for use inside HFSS via Tools -> Run Script)
// Uses ScriptEnv.Initialize and oEditor.CreateBox with the two-array pattern.
// Python 2.7 compatible (no f-strings, ASCII only).
// =========================================================================
function generateHfssNative(scene, paramValues) {
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
  const exprWithUm = (expr) => {
    const s = ascii(resolveSynthetics(String(expr ?? '0')));
    if (/^[\d\s+\-*/.()]+$/.test(s)) {
      // Pure numeric: parenthesize the whole and append um. HFSS will treat the
      // result as unit-bearing.
      return `(${s})um`;
    }
    return `(${s})`;
  };

  // Format a value for SetVariableValue. For bare numbers attach the unit; otherwise leave as expression.
  const formatVarValue = (p) => {
    const expr = ascii(resolveSynthetics(String(p.expr ?? '')));
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

  // Substrate / cladding bounding extent: default 100x100 um centered on origin,
  // expanding (with a small margin) only if the layout is bigger.
  const MIN_HALF = 50; // 100x100 um substrate
  const MARGIN = 20;   // pad if layout goes near edge
  let minX = -MIN_HALF, minY = -MIN_HALF, maxX = MIN_HALF, maxY = MIN_HALF;
  if (solved.length > 0) {
    let lx = Infinity, ly = Infinity, hx = -Infinity, hy = -Infinity;
    for (const c of solved) {
      const w = evalExpr(c.w, paramValues) || 10;
      const h = evalExpr(c.h, paramValues) || 10;
      lx = Math.min(lx, c.cx - w / 2);
      hx = Math.max(hx, c.cx + w / 2);
      ly = Math.min(ly, c.cy - h / 2);
      hy = Math.max(hy, c.cy + h / 2);
    }
    minX = Math.min(minX, lx - MARGIN);
    maxX = Math.max(maxX, hx + MARGIN);
    minY = Math.min(minY, ly - MARGIN);
    maxY = Math.max(maxY, hy + MARGIN);
  }
  const bbXPos = `${minX.toFixed(2)}um`;
  const bbYPos = `${minY.toFixed(2)}um`;
  const bbXSize = `${(maxX - minX).toFixed(2)}um`;
  const bbYSize = `${(maxY - minY).toFixed(2)}um`;

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
oProject = oDesktop.NewProject()
oProject.InsertDesign("HFSS", "Layout", "DrivenModal", "")
oDesign = oProject.SetActiveDesign("Layout")
oEditor = oDesign.SetActiveEditor("3D Modeler")

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
# Wrap CreateBox so one bad call doesn't abort the whole script.
def safe_create_box(box_params, attributes, name):
    try:
        oEditor.CreateBox(box_params, attributes)
    except Exception as e:
        try:
            oDesktop.AddMessage("", "", 1, "CreateBox failed for '" + name + "': " + str(e))
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
        // Lumped ports sit at the waveguide top by default; thickness is
        // a small slab to make the port a flat sheet at one Z level.
        zBottom = evalExpr('h_wg', paramValues) || 0.6;
        zSize = 0.01;
      }
      const materialName = c.layer === 'waveguide'
        ? (wgLayer ? wgLayer.material : 'lithium_niobate')
        : (c.layer === 'electrode' ? 'gold' : 'pec');
      // Build the points list. CreatePolyline expects a sequence of
      // PolylinePoint records.
      const ptRecords = ring.map(([px, py]) =>
        `["NAME:PLPoint", "X:=", "${px.toFixed(4)}um", "Y:=", "${py.toFixed(4)}um", "Z:=", "${zBottom.toFixed(4)}um"]`
      ).join(', ');
      const segRecords = ring.map((_, i) =>
        `["NAME:PLSegment", "SegmentType:=", "Line", "StartIndex:=", ${i}, "NoOfPoints:=", 2]`
      ).join(', ');
      code += `# ${c.id}: ${shapeKind} as polygonal sheet (tessellation = ${ring.length} verts)\n`;
      code += `try:
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
         "Color:=", "(200 200 200)",
         "Transparency:=", 0.0,
         "PartCoordinateSystem:=", "Global",
         "MaterialValue:=", "\\"${ascii(materialName)}\\"",
         "SolveInside:=", ${c.layer === 'waveguide' ? 'True' : 'False'}])
    oEditor.SweepAlongVector(
        ["NAME:Selections", "Selections:=", "${id}", "NewPartsModelFlag:=", "Model"],
        ["NAME:VectorSweepParameters",
         "DraftAngle:=", "0deg", "DraftType:=", "Round",
         "CheckFaceFaceIntersection:=", False,
         "SweepVectorX:=", "0um",
         "SweepVectorY:=", "0um",
         "SweepVectorZ:=", "${zSize.toFixed(4)}um"])
except Exception as e:
    try:
        oDesktop.AddMessage("", "", 1, "Failed to build ${shapeKind} ${id}: " + str(e))
    except:
        pass
`;
      if (c.layer === 'electrode') emittedElecNames.push(id);
      else if (c.layer === 'waveguide') emittedWgNames.push(id);
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
      const inwardShiftExprUm = `((${exprWithUm(layerThExpr)} - ${slabHExprUm}) / tan((${etchExpr}) * pi/180))`;
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
  const emitTransformChainHfss = (transforms, partIds, startCx, startCy, baseW, baseH) => {
    if (!transforms || transforms.length === 0) return;
    let curCx = startCx, curCy = startCy, curRotation = 0;
    const selStr = partIds.join(',');
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
          // Pivot = 'C' (current center) or named anchor on part outline.
          let pivotX = curCx, pivotY = curCy;
          if (pivot !== 'C') {
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
      }
    }
  };

  for (const c of solved) {
    if (c.kind === 'boolean') continue; // booleans handled below
    if (!c.transforms || c.transforms.length === 0) continue;
    if (!c.transforms.some(t => t && t.enabled !== false)) continue;
    const id = c.id.replace(/[^A-Za-z0-9_]/g, '_');
    // For waveguides built as a rib + slab pair, transforms target the
    // rib part (named `<id>_rib`); for other shapes/layers, the part is
    // named directly with the component id.
    const partIds = (c.layer === 'waveguide' && (c.kind || 'rect') === 'rect')
      ? [`${id}_rib`]
      : [id];
    const baseW = typeof c.w === 'number' ? c.w : evalExpr(c.w, paramValues);
    const baseH = typeof c.h === 'number' ? c.h : evalExpr(c.h, paramValues);
    code += `\n# ===== Transforms for ${c.id} =====\n`;
    emitTransformChainHfss(c.transforms, partIds, c.cx, c.cy, baseW || 0, baseH || 0);
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
      }
      // Rename the surviving part (first operand's name) to the boolean's id
      // so post-boolean transforms target the right name.
      if (safeIds[0] !== safeBoolId) {
        code += `try:
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
      emitTransformChainHfss(b.transforms || [], [safeBoolId], solvedB.cx, solvedB.cy, bW || 0, bH || 0);
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
  return code;
}

// ----------------------------------------------------------------------
// GDS-II EXPORT
// ----------------------------------------------------------------------
// Encode the scene as a binary GDS-II stream. GDS-II is a sequence of
// records; each record is `[length(2)][type(1)][datatype(1)][data...]`,
// big-endian. We emit a minimal but standards-compliant file with one
// library, one structure, and one BOUNDARY record per component.
//
// Layer mapping (kept simple, easy to remap later if needed):
//   waveguide → layer 1
//   electrode (per stack conductor)  → layers 10, 11, 12, … (one per
//     conductor layer in stack order; falls back to 10 if no stack info)
//   port      → layer 100
//
// All coordinates are written as INT32 nanometers (typical GDS practice
// when working in µm: 1 user unit = 1 µm = 1000 database units of 1 nm).
function generateGDS(scene, paramValues) {
  const { components, mirrors, snaps, stack } = scene;
  const solved = applyMirrors(solveLayout(components, snaps, paramValues), mirrors);

  // ---- GDS record helpers ------------------------------------------------
  // GDS data types
  const DT_NODATA = 0x00;
  const DT_BIT_ARRAY = 0x01;
  const DT_INT2 = 0x02;
  const DT_INT4 = 0x03;
  const DT_REAL8 = 0x05;
  const DT_ASCII = 0x06;
  // Record types we use
  const HEADER     = 0x00;
  const BGNLIB     = 0x01;
  const LIBNAME    = 0x02;
  const UNITS      = 0x03;
  const ENDLIB     = 0x04;
  const BGNSTR     = 0x05;
  const STRNAME    = 0x06;
  const ENDSTR     = 0x07;
  const BOUNDARY   = 0x08;
  const LAYER      = 0x0d;
  const DATATYPE   = 0x0e;
  const XY         = 0x10;
  const ENDEL      = 0x11;

  // Output buffer — built up as a flat array of byte chunks (Uint8Arrays),
  // then concatenated at the end. Keeping chunks separate avoids quadratic
  // re-allocations.
  const chunks = [];
  const pushChunk = (u8) => chunks.push(u8);

  // Big-endian writers
  const writeRecordHeader = (recType, dataType, payloadLen) => {
    const total = payloadLen + 4;
    if (total > 0xffff) throw new Error('GDS record too large');
    const b = new Uint8Array(4);
    b[0] = (total >> 8) & 0xff;
    b[1] = total & 0xff;
    b[2] = recType & 0xff;
    b[3] = dataType & 0xff;
    pushChunk(b);
  };
  const writeNoData = (recType) => writeRecordHeader(recType, DT_NODATA, 0);
  const writeInt2 = (recType, values) => {
    const buf = new Uint8Array(values.length * 2);
    for (let i = 0; i < values.length; i++) {
      const v = values[i] & 0xffff;
      buf[i * 2] = (v >> 8) & 0xff;
      buf[i * 2 + 1] = v & 0xff;
    }
    writeRecordHeader(recType, DT_INT2, buf.length);
    pushChunk(buf);
  };
  const writeInt4 = (recType, values) => {
    const buf = new Uint8Array(values.length * 4);
    const dv = new DataView(buf.buffer);
    for (let i = 0; i < values.length; i++) {
      // Clamp to int32 range; values come from positions in nm so even
      // mm-scale chips fit comfortably.
      let v = values[i] | 0;
      dv.setInt32(i * 4, v, false); // big-endian
    }
    writeRecordHeader(recType, DT_INT4, buf.length);
    pushChunk(buf);
  };
  // GDS REAL8 is an 8-byte excess-64 hexadecimal float (NOT IEEE754!).
  // Encode as: sign(1 bit) | exp+64 base-16 (7 bits) | mantissa (56 bits).
  const writeReal8 = (recType, values) => {
    const buf = new Uint8Array(values.length * 8);
    for (let i = 0; i < values.length; i++) {
      let v = values[i];
      const off = i * 8;
      if (v === 0) continue; // all zeros = 0
      let sign = 0;
      if (v < 0) { sign = 1; v = -v; }
      // Find exponent so 1/16 <= mantissa < 1
      let exp = 0;
      while (v >= 1) { v /= 16; exp++; if (exp > 63) break; }
      while (v < 1/16 && exp > -64) { v *= 16; exp--; }
      const expField = (exp + 64) & 0x7f;
      buf[off] = (sign << 7) | expField;
      // Mantissa: 7 bytes, each 8 bits
      let mant = v;
      for (let j = 1; j < 8; j++) {
        mant *= 256;
        const byte = Math.floor(mant) & 0xff;
        buf[off + j] = byte;
        mant -= byte;
      }
    }
    writeRecordHeader(recType, DT_REAL8, buf.length);
    pushChunk(buf);
  };
  const writeAscii = (recType, str) => {
    // Pad to even length per GDS spec
    let s = str;
    if (s.length & 1) s += '\0';
    const buf = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) buf[i] = s.charCodeAt(i) & 0xff;
    writeRecordHeader(recType, DT_ASCII, buf.length);
    pushChunk(buf);
  };

  // ---- Layer mapping -----------------------------------------------------
  // Keep stack-conductor layer indices consistent across exports: assign
  // GDS layer numbers in the stack's array order. A component on the port
  // layer maps to GDS 100 regardless of stack content.
  const conductorLayers = (stack || []).filter(l => l.role === 'conductor');
  const condIdToGdsLayer = {};
  conductorLayers.forEach((l, i) => { condIdToGdsLayer[l.id] = 10 + i; });
  const gdsLayerForComponent = (c) => {
    if (c.layer === 'waveguide') return 1;
    if (c.layer === 'port') return 100;
    if (c.layer === 'electrode') {
      if (c.conductorLayerId && condIdToGdsLayer[c.conductorLayerId] != null) {
        return condIdToGdsLayer[c.conductorLayerId];
      }
      return 10;
    }
    return 0; // fallback
  };

  // ---- Header / library --------------------------------------------------
  const now = new Date();
  const dateInt2 = [
    now.getFullYear(), now.getMonth() + 1, now.getDate(),
    now.getHours(), now.getMinutes(), now.getSeconds(),
    now.getFullYear(), now.getMonth() + 1, now.getDate(),
    now.getHours(), now.getMinutes(), now.getSeconds(),
  ];
  writeInt2(HEADER, [600]); // GDS version 6
  writeInt2(BGNLIB, dateInt2);
  writeAscii(LIBNAME, 'PHOTONIC');
  // UNITS: user_unit_in_db_units (1e-3 = 1µm in 1nm dbunits), db_unit_in_meters (1e-9 = 1nm)
  writeReal8(UNITS, [1e-3, 1e-9]);
  // ---- Structure ---------------------------------------------------------
  writeInt2(BGNSTR, dateInt2);
  writeAscii(STRNAME, 'TOP');

  // Each component → BOUNDARY record (rectangle as 5-vertex polygon, closed).
  // Per-component transforms are expanded so each instance becomes its own
  // boundary record. Rotated rectangles are emitted as a 5-vertex polygon
  // with the corners pre-rotated (since GDS doesn't have a rotation
  // attribute on BOUNDARY records). Note: GDS booleans (union/intersect/
  // subtract) are NOT applied here — the operands are emitted as separate
  // polygons on the same layer. A real polygon-clipping pass would require
  // a clipper library; out of scope for now.
  for (const c of solved) {
    if (c.kind === 'boolean') continue; // booleans don't have GDS geometry of their own
    const insts = expandTransforms([c], paramValues);
    for (const inst of insts) {
      const w = inst.w, h = inst.h;
      if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) continue;
      const layer = gdsLayerForComponent(c);
      const toNm = (v) => Math.round(v * 1000);
      // shapeInstanceToRing returns the perimeter ring already accounting
      // for the instance's rotation and shape (rect/circle/ellipse/polygon).
      // Circles/ellipses are tessellated to CIRCLE_TESSELATION vertices —
      // sufficient for fab-friendly GDS output.
      const worldPts = shapeInstanceToRing(inst);
      writeNoData(BOUNDARY);
      writeInt2(LAYER, [layer]);
      writeInt2(DATATYPE, [0]);
      const xys = [];
      for (const [px, py] of worldPts) { xys.push(toNm(px), toNm(py)); }
      // Close the polygon: first vertex repeated.
      xys.push(toNm(worldPts[0][0]), toNm(worldPts[0][1]));
      writeInt4(XY, xys);
      writeNoData(ENDEL);

      // Racetrack: the outer ring above is just the outer perimeter of
      // the waveguide band. Emit the INNER perimeter on the same layer
      // with DATATYPE = 1 (cutout convention) so a fab tool that supports
      // hollow polygons subtracts the inner from the outer to produce the
      // band. Tools that don't support cutouts will still see a closed
      // racetrack with a hole shape rendered as a separate boundary —
      // which is also a reasonable interpretation.
      if (c.kind === 'racetrack') {
        const R = Number.isFinite(inst.R) ? inst.R : 100;
        const L = Number.isFinite(inst.L_straight) ? inst.L_straight : 300;
        const pE = Number.isFinite(inst.p) ? inst.p : 1;
        const wgW = Number.isFinite(inst.wgWidth) ? inst.wgWidth : 1.2;
        const centerline = buildRacetrackCenterline(R, L, pE);
        const { inner } = offsetCenterlineToBand(centerline, wgW / 2);
        if (inner.length >= 3) {
          // Apply the instance's rotation about (cx, cy).
          const rotRad = (inst.rotation || 0) * Math.PI / 180;
          const ca2 = Math.cos(rotRad), sa2 = Math.sin(rotRad);
          const innerPts = inner.map(([lx, ly]) => [
            inst.cx + lx * ca2 - ly * sa2,
            inst.cy + lx * sa2 + ly * ca2,
          ]);
          writeNoData(BOUNDARY);
          writeInt2(LAYER, [layer]);
          writeInt2(DATATYPE, [1]);
          const ixys = [];
          for (const [px, py] of innerPts) { ixys.push(toNm(px), toNm(py)); }
          ixys.push(toNm(innerPts[0][0]), toNm(innerPts[0][1]));
          writeInt4(XY, ixys);
          writeNoData(ENDEL);
        }
      }
      // Cutouts only emitted for the BASE instance (transform-instance copies
      // don't carry independent cutouts in this export — they share the
      // base's cutouts spatially relative to themselves, which would require
      // also rotating those rectangles. Out of scope for now; we emit cutouts
      // only on the base instance to avoid introducing inconsistency.).
      if (inst.idx !== 0) continue;
      for (const cu of (c.cutouts || [])) {
        const cw = evalExpr(cu.w, paramValues);
        const ch = evalExpr(cu.h, paramValues);
        const cdx = evalExpr(cu.dx, paramValues);
        const cdy = evalExpr(cu.dy, paramValues);
        if (!Number.isFinite(cw) || !Number.isFinite(ch) || cw <= 0 || ch <= 0) continue;
        const cx0 = inst.cx + cdx - cw / 2;
        const cx1 = inst.cx + cdx + cw / 2;
        const cy0 = inst.cy + cdy - ch / 2;
        const cy1 = inst.cy + cdy + ch / 2;
        writeNoData(BOUNDARY);
        writeInt2(LAYER, [layer]);
        writeInt2(DATATYPE, [1]);
        writeInt4(XY, [
          toNm(cx0), toNm(cy0),
          toNm(cx1), toNm(cy0),
          toNm(cx1), toNm(cy1),
          toNm(cx0), toNm(cy1),
          toNm(cx0), toNm(cy0),
        ]);
        writeNoData(ENDEL);
      }
    }
  }

  writeNoData(ENDSTR);
  writeNoData(ENDLIB);

  // Concatenate all chunks into one Uint8Array.
  let total = 0;
  for (const ch of chunks) total += ch.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const ch of chunks) { out.set(ch, off); off += ch.length; }
  return out;
}

// =========================================================================
// CANVAS
// =========================================================================
function Canvas({ scene, updateScene, selectedId, selectedIds, setSelection, viewport, setViewport, snapMode, setSnapMode, gridSize, gridSnapEnabled, paramValues, addParam, updateParamExpr, rulerMode, setRulerMode, rulerMeasurements, setRulerMeasurements, rulerInProgress, setRulerInProgress, rulerSnapPoint, setRulerSnapPoint, alertDialog, setInteractionStatus, showDimensions, addMode, setAddMode, commitDragAdd }) {
  const svgRef = useRef(null);

  const solved = useMemo(() => {
    const s = solveLayout(scene.components, scene.snaps, paramValues);
    const m = applyMirrors(s, scene.mirrors);
    // Resolve boolean components' effective bbox-derived w/h/cx/cy so
    // anchor lookups, snap targeting, and dimension overlays treat them
    // uniformly with primitives.
    return resolveBooleanBboxes(m, paramValues);
  }, [scene.components, scene.snaps, scene.mirrors, paramValues]);

  // Per-component transform instances. For each component, expandTransforms
  // returns one entry per displayed copy (a no-transform comp gives one).
  // We index by compId for fast lookup in the render loop.
  const transformInstances = useMemo(
    () => expandTransforms(solved, paramValues),
    [solved, paramValues]
  );
  const instancesByCompId = useMemo(() => {
    const m = {};
    for (const i of transformInstances) {
      if (!m[i.compId]) m[i.compId] = [];
      m[i.compId].push(i);
    }
    return m;
  }, [transformInstances]);

  // Related components: anything snapped to or from the selected component, plus mirror partners
  const relatedIds = useMemo(() => {
    if (!selectedId) return { parents: new Set(), children: new Set(), mirrors: new Set() };
    const parents = new Set();
    const children = new Set();
    const mirrors = new Set();
    for (const s of scene.snaps) {
      if (s.to.compId === selectedId) parents.add(s.from.compId);
      if (s.from.compId === selectedId) children.add(s.to.compId);
    }
    for (const m of scene.mirrors) {
      for (const mm of m.members) {
        if (mm.srcId === selectedId) mirrors.add(mm.mirrorId);
        if (mm.mirrorId === selectedId) mirrors.add(mm.srcId);
      }
    }
    return { parents, children, mirrors };
  }, [selectedId, scene.snaps, scene.mirrors]);

  // Boolean cluster bookkeeping. Booleans are now full components (kind='boolean')
  // in scene.components; their operands are tagged with consumedBy. We compute:
  //   - booleanComps: list of derived boolean components (active ones only)
  //   - operandIds: set of comp ids consumed by some boolean (hidden from
  //                 standalone rendering and snap targets)
  //   - memberToCluster[compId]: for each operand, the set of sibling
  //                 operands+boolean it should move with (drag-as-one)
  //   - operandToBooleanId[compId]: which boolean a given operand belongs to
  const booleanClusters = useMemo(() => {
    // ALL boolean components. Used for operand bookkeeping (which
    // primitive ids are inside ANY boolean, regardless of nesting depth).
    const allBooleanComps = scene.components.filter(c => c.kind === 'boolean');
    // TOP-LEVEL booleans only — those not consumed by another boolean.
    // The recursive renderer descends into nested operands automatically,
    // so consumed booleans must NOT render standalone (would double-render).
    const booleanComps = allBooleanComps.filter(c => !c.consumedBy);
    const operandIds = new Set();
    const operandToBooleanId = {};
    for (const b of allBooleanComps) {
      for (const id of (b.operandIds || [])) {
        operandIds.add(id);
        operandToBooleanId[id] = b.id;
      }
    }
    // Cluster = top-level boolean's id + ALL transitively reachable operands.
    // We recurse through nested booleans so dragging a top-level subtract
    // moves the union (and its primitives) along with it.
    const memberToCluster = {};
    const compById = Object.fromEntries(scene.components.map(c => [c.id, c]));
    const collectMembers = (id, acc) => {
      if (acc.has(id)) return;
      acc.add(id);
      const c = compById[id];
      if (c && c.kind === 'boolean') {
        for (const opid of (c.operandIds || [])) collectMembers(opid, acc);
      }
    };
    for (const b of booleanComps) {
      const members = new Set();
      collectMembers(b.id, members);
      for (const m of members) {
        if (!memberToCluster[m]) memberToCluster[m] = new Set();
        for (const x of members) memberToCluster[m].add(x);
      }
    }
    return { booleanComps, allBooleanComps, operandIds, memberToCluster, operandToBooleanId };
  }, [scene.components]);


  // Drag state
  const [drag, setDrag] = useState(null); // { kind: 'move'|'resize', ... }
  const [pan, setPan] = useState(null);
  const [marquee, setMarquee] = useState(null); // { startWorld, currentWorld }
  const [snapPick, setSnapPick] = useState(null);
  const [snapHover, setSnapHover] = useState(null); // { compId, side, t, x, y } for edge hover preview
  const [snapCursor, setSnapCursor] = useState(null); // { x, y } in world coords, while picking second anchor
  const [modifier, setModifier] = useState(false); // Cmd / Ctrl held (disables grid snap)
  const [altKey, setAltKey] = useState(false); // Option / Alt held (marquee mode)
  const [shiftKey, setShiftKey] = useState(false); // Shift held (axis-lock during snap)
  // Drag-to-create state. Active when the user enters addMode and starts a drag
  // on the canvas. p1 is the drag start (in world coords); p2 is the current
  // mouse position. snapStart/snapEnd are anchor-snap descriptors when the
  // start/end points landed on an existing component anchor.
  const [addDrag, setAddDrag] = useState(null);
  // ^ shape: { p1, p2, snapStart, snapEnd }
  // Pre-drag hover snap target for addMode (preview before clicking).
  const [addHoverSnap, setAddHoverSnap] = useState(null);
  // ^ shape: { x, y, compId, anchor } | null
  // Snap target during a move-drag with Alt held: the existing-component
  // anchor under (or near) the cursor that the dragged component will snap
  // to on release. Re-evaluated on every mousemove while Alt is held.
  const [moveSnapHover, setMoveSnapHover] = useState(null);
  // ^ shape: { x, y, compId, anchor } | null

  useEffect(() => {
    const down = (e) => {
      if (e.key === 'Meta' || e.key === 'Control') setModifier(true);
      if (e.key === 'Alt') setAltKey(true);
      if (e.key === 'Shift') setShiftKey(true);
    };
    const up = (e) => {
      if (e.key === 'Meta' || e.key === 'Control') setModifier(false);
      if (e.key === 'Alt') setAltKey(false);
      if (e.key === 'Shift') setShiftKey(false);
    };
    const blur = () => { setModifier(false); setAltKey(false); setShiftKey(false); };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, []);

  // Ruler-mode Escape: cancel in-progress measurement, or exit the tool entirely
  useEffect(() => {
    if (!rulerMode) return;
    const handler = (e) => {
      if (e.key === 'Escape') {
        if (rulerInProgress) setRulerInProgress(null);
        else setRulerMode(false);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [rulerMode, rulerInProgress]);

  // Add-mode Escape: cancel an in-progress drag, or exit the add tool entirely.
  useEffect(() => {
    if (!addMode) return;
    const handler = (e) => {
      if (e.key === 'Escape') {
        if (addDrag) setAddDrag(null);
        else setAddMode(null);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [addMode, addDrag]);

  // Push live status string to the bottom status bar (snap/ruler progress).
  // Avoids drawing a label on the canvas where it would obscure anchors and
  // the preview line itself.
  useEffect(() => {
    if (!setInteractionStatus) return;
    let status = null;
    if (snapMode === 'creating') {
      if (!snapPick) {
        status = { kind: 'snap', line: 'Snap: pick first anchor' };
      } else {
        const fromComp = solved.find(c => c.id === snapPick.compId);
        if (fromComp) {
          const fromW = anchorWorld(fromComp, snapPick.anchor, paramValues);
          let toX = null, toY = null, isLocked = false;
          if (snapHover && snapHover.compId !== snapPick.compId) {
            toX = snapHover.x; toY = snapHover.y;
            if (shiftKey) isLocked = true;
          } else if (snapCursor) {
            toX = snapCursor.x; toY = snapCursor.y;
            if (shiftKey) {
              const dx = toX - fromW.x, dy = toY - fromW.y;
              if (Math.abs(dx) < Math.abs(dy)) toX = fromW.x; else toY = fromW.y;
              isLocked = true;
            }
          }
          if (toX !== null) {
            const dx = toX - fromW.x, dy = toY - fromW.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            const lockTag = isLocked ? ' (locked)' : '';
            status = {
              kind: 'snap',
              line: `Snap${lockTag} · Δx=${dx.toFixed(3)} · Δy=${dy.toFixed(3)} · dist=${dist.toFixed(3)} µm`,
            };
          } else {
            status = { kind: 'snap', line: 'Snap: pick second anchor' };
          }
        }
      }
    } else if (rulerMode) {
      if (!rulerInProgress) {
        status = { kind: 'ruler', line: 'Ruler: pick first point' };
      } else if (rulerSnapPoint) {
        const p1 = rulerInProgress.p1;
        let p2x = rulerSnapPoint.x, p2y = rulerSnapPoint.y;
        if (shiftKey) {
          const dxr = p2x - p1.x, dyr = p2y - p1.y;
          if (Math.abs(dxr) > Math.abs(dyr)) p2y = p1.y; else p2x = p1.x;
        }
        const dx = p2x - p1.x, dy = p2y - p1.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const lockTag = shiftKey ? ' (locked)' : '';
        status = {
          kind: 'ruler',
          line: `Ruler${lockTag} · Δx=${dx.toFixed(3)} · Δy=${dy.toFixed(3)} · dist=${dist.toFixed(3)} µm`,
        };
      } else {
        status = { kind: 'ruler', line: 'Ruler: pick second point' };
      }
    } else if (addMode) {
      const layer = addMode.layer || addMode.kind || 'waveguide';
      const kindLabel = layer === 'waveguide' ? 'waveguide'
        : layer === 'port' ? 'port'
        : (addMode.conductorLayerId || 'conductor');
      const shapeLabel = addMode.shape || 'rect';
      if (!addDrag) {
        const hint = addHoverSnap && addHoverSnap.compId
          ? `snap-start: ${addHoverSnap.compId}.${addHoverSnap.anchor}`
          : 'click empty space or an anchor';
        status = { kind: 'add', line: `Add ${shapeLabel} (${kindLabel}) · drag to size · ${hint} · Esc cancels` };
      } else {
        const { p1, p2, snapStart, snapEnd } = addDrag;
        const w = Math.abs(p2.x - p1.x);
        const h = Math.abs(p2.y - p1.y);
        const tags = [];
        if (snapStart) tags.push(`start→${snapStart.compId}.${snapStart.anchor}`);
        if (snapEnd) {
          const sameComp = snapStart && snapEnd.compId === snapStart.compId;
          const tagSuffix = snapStart
            ? (sameComp ? ' (same comp)' : ' (spans → parametric width/height)')
            : '';
          tags.push(`end→${snapEnd.compId}.${snapEnd.anchor}${tagSuffix}`);
        }
        status = {
          kind: 'add',
          line: `Add ${kindLabel} · ${w.toFixed(2)} × ${h.toFixed(2)} µm${tags.length ? ' · ' + tags.join(' · ') : ''}`,
        };
      }
    } else if (drag && drag.kind === 'move' && moveSnapHover) {
      status = {
        kind: 'snap',
        line: `Alt-drag · release to snap to ${moveSnapHover.compId}.${moveSnapHover.anchor}`,
      };
    } else if (drag && drag.kind === 'move' && altKey) {
      status = {
        kind: 'snap',
        line: `Alt-drag · approach another component's anchor to snap`,
      };
    }
    setInteractionStatus(status);
  }, [snapMode, snapPick, snapHover, snapCursor, shiftKey, altKey, rulerMode, rulerInProgress, rulerSnapPoint, addMode, addDrag, addHoverSnap, drag, moveSnapHover, solved, paramValues, setInteractionStatus]);

  const screenToWorld = (sx, sy) => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const pt = svg.createSVGPoint();
    pt.x = sx; pt.y = sy;
    const inv = svg.getScreenCTM().inverse();
    const wp = pt.matrixTransform(inv);
    return { x: wp.x, y: -wp.y };
  };

  const snapToGrid = (v) => {
    if (!gridSnapEnabled || modifier) return v;
    return Math.round(v / gridSize) * gridSize;
  };

  // Find the closest snappable feature within `worldThresh` units of (wp.x, wp.y).
  // Checks 9 fixed anchors per component first, then nearest point on each edge.
  // Returns { x, y, label } or null. `label` is a short description for the UI.
  const findRulerSnap = (wp, worldThresh) => {
    let best = null;
    const consider = (x, y, label) => {
      const dx = wp.x - x, dy = wp.y - y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d <= worldThresh && (!best || d < best.d)) best = { x, y, label, d };
    };
    for (const c of solved) {
      const w = evalExpr(c.w, paramValues);
      const h = evalExpr(c.h, paramValues);
      if (!Number.isFinite(w) || !Number.isFinite(h)) continue;
      // 9 fixed anchors
      for (const a of ANCHORS) {
        const lp = anchorLocal(a, w, h);
        consider(c.cx + lp.x, c.cy + lp.y, `${c.id} ${a}`);
      }
      // Nearest point on each edge (parametric snap)
      const x0 = c.cx - w / 2, x1 = c.cx + w / 2;
      const y0 = c.cy - h / 2, y1 = c.cy + h / 2;
      // Top edge: y = y1, x in [x0, x1]
      if (wp.x >= x0 - worldThresh && wp.x <= x1 + worldThresh) {
        const cx = Math.max(x0, Math.min(x1, wp.x));
        consider(cx, y1, `${c.id} top`);
        consider(cx, y0, `${c.id} bot`);
      }
      // Left/right edges
      if (wp.y >= y0 - worldThresh && wp.y <= y1 + worldThresh) {
        const cy = Math.max(y0, Math.min(y1, wp.y));
        consider(x0, cy, `${c.id} left`);
        consider(x1, cy, `${c.id} right`);
      }
    }
    return best;
  };

  // Like findRulerSnap, but also reports WHICH component and WHICH anchor the
  // snap landed on. Used by drag-to-create so we can install a real snap (not
  // just remember a coordinate) when the user lands on an existing anchor.
  // Returns null if nothing within `worldThresh`. Otherwise returns
  // { x, y, compId, anchor } where anchor is one of the 9 fixed names or a
  // parametric edge anchor like "T:0.42".
  const findAnchorSnap = (wp, worldThresh, excludeCompId = null) => {
    let best = null;
    const consider = (x, y, compId, anchor) => {
      const dx = wp.x - x, dy = wp.y - y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d <= worldThresh && (!best || d < best.d)) {
        best = { x, y, compId, anchor, d };
      }
    };
    for (const c of solved) {
      if (excludeCompId && c.id === excludeCompId) continue;
      const w = evalExpr(c.w, paramValues);
      const h = evalExpr(c.h, paramValues);
      if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) continue;
      // 9 fixed anchors — these win over parametric edge points (they're more
      // semantically meaningful so we slightly prefer them via early order).
      for (const a of ANCHORS) {
        const lp = anchorLocal(a, w, h);
        consider(c.cx + lp.x, c.cy + lp.y, c.id, a);
      }
      // Parametric edge anchors. Project the cursor onto each edge and use a
      // T:t / B:t / L:t / R:t form. This gives a precise t in [0,1].
      const x0 = c.cx - w / 2, x1 = c.cx + w / 2;
      const y0 = c.cy - h / 2, y1 = c.cy + h / 2;
      if (wp.x >= x0 - worldThresh && wp.x <= x1 + worldThresh) {
        const projX = Math.max(x0, Math.min(x1, wp.x));
        const tX = (projX - x0) / (x1 - x0); // 0 at left, 1 at right
        consider(projX, y1, c.id, `T:${tX.toFixed(4)}`);
        consider(projX, y0, c.id, `B:${tX.toFixed(4)}`);
      }
      if (wp.y >= y0 - worldThresh && wp.y <= y1 + worldThresh) {
        const projY = Math.max(y0, Math.min(y1, wp.y));
        const tY = (projY - y0) / (y1 - y0); // 0 at bottom, 1 at top
        consider(x0, projY, c.id, `L:${tY.toFixed(4)}`);
        consider(x1, projY, c.id, `R:${tY.toFixed(4)}`);
      }
    }
    return best;
  };

  const onWheel = (e) => {
    e.preventDefault();
    // Smooth, sensitivity-controlled zoom that works for both mouse wheel and trackpad.
    // Smaller k = less sensitive. 0.0015 feels gentle.
    const k = 0.0015;
    const factor = Math.exp(e.deltaY * k);
    // Get world point under cursor BEFORE zoom — this should stay put after zoom.
    const wp = screenToWorld(e.clientX, e.clientY);
    setViewport(v => {
      const newW = v.w * factor;
      const newH = v.h * factor;
      // The cursor world point relative to current viewport center:
      const dx = wp.x - v.x;
      const dy = wp.y - v.y;
      // After scaling, the same screen position will correspond to a world point
      // that is `factor` times further from the new center. To keep the cursor
      // pinned, the new center should be at: wp - factor * (wp - v) = wp - factor*dx, wp - factor*dy
      const newCx = wp.x - dx * factor;
      const newCy = wp.y - dy * factor;
      return { x: newCx, y: newCy, w: newW, h: newH };
    });
  };

  const onMouseDown = (e) => {
    const target = e.target;

    // Ruler tool: clicks pick measurement endpoints
    if (rulerMode) {
      const wp = screenToWorld(e.clientX, e.clientY);
      // Use snapped position if available
      const worldThresh = viewport.w * 0.012; // ~1.2% of viewport width = a few pixels
      const snap = findRulerSnap(wp, worldThresh);
      let pt = snap ? { x: snap.x, y: snap.y } : { x: wp.x, y: wp.y };
      if (!rulerInProgress) {
        setRulerInProgress({ p1: pt });
      } else {
        // Shift = axis-lock: project p2 so it's purely horizontal or vertical from p1
        if (e.shiftKey) {
          const p1 = rulerInProgress.p1;
          const dx = pt.x - p1.x;
          const dy = pt.y - p1.y;
          if (Math.abs(dx) > Math.abs(dy)) pt = { x: pt.x, y: p1.y };
          else                              pt = { x: p1.x, y: pt.y };
        }
        const newM = { id: `m_${Date.now()}`, p1: rulerInProgress.p1, p2: pt };
        setRulerMeasurements(prev => [...prev, newM]);
        setRulerInProgress(null);
      }
      e.stopPropagation();
      e.preventDefault();
      return;
    }

    // Add tool: drag to size the new component. Anchor snaps are honored so
    // that landing on an existing component's corner/edge installs a position
    // snap rather than a free coordinate.
    if (addMode) {
      const wp = screenToWorld(e.clientX, e.clientY);
      const worldThresh = viewport.w * 0.012;
      const snap = findAnchorSnap(wp, worldThresh);
      const p1 = snap ? { x: snap.x, y: snap.y } : { x: wp.x, y: wp.y };
      setAddDrag({ p1, p2: p1, snapStart: snap || null, snapEnd: null });
      e.stopPropagation();
      e.preventDefault();
      return;
    }

    // Resize handle
    if (target.dataset?.resize) {
      const [compId, anchor] = target.dataset.resize.split('|');
      const comp = solved.find(c => c.id === compId);
      if (comp) {
        const wp = screenToWorld(e.clientX, e.clientY);
        const w = evalExpr(comp.w, paramValues);
        const h = evalExpr(comp.h, paramValues);
        setDrag({
          kind: 'resize',
          compId,
          anchor,
          startMouse: wp,
          startCx: comp.cx,
          startCy: comp.cy,
          startW: w,
          startH: h,
          wExpr: comp.w,
          hExpr: comp.h,
        });
        setSelection({ ids: new Set([compId]), primary: compId });
      }
      return;
    }

    // Component click
    if (target.dataset?.compId) {
      const id = target.dataset.compId;
      const wp = screenToWorld(e.clientX, e.clientY);

      // Cmd/Ctrl-click: toggle in selection (no drag)
      if (e.metaKey || e.ctrlKey) {
        const newIds = new Set(selectedIds);
        if (newIds.has(id)) {
          newIds.delete(id);
          setSelection({ ids: newIds, primary: newIds.size > 0 ? Array.from(newIds).pop() : null });
        } else {
          newIds.add(id);
          setSelection({ ids: newIds, primary: id });
        }
        return;
      }

      // Find root of snap chain for the clicked component.
      const findSnapRoot = (startId) => {
        let rid = startId;
        const seen = new Set();
        while (true) {
          const incoming = scene.snaps.find(s => s.to.compId === rid);
          if (!incoming || seen.has(rid)) break;
          seen.add(rid);
          rid = incoming.from.compId;
        }
        return rid;
      };
      const rootId = findSnapRoot(id);
      const rootComp = solved.find(c => c.id === rootId);
      // Boolean-cluster expansion: if the clicked component participates in
      // an enabled boolean, drag all its cluster mates' snap-roots together
      // so the boolean cluster moves as a single unit. Each co-mover is
      // remembered with its initial cx/cy so on mousemove we apply the
      // SAME (dx, dy) to all of them.
      const cluster = booleanClusters.memberToCluster[id];
      const coMoverIds = new Set([rootId]);
      if (cluster) {
        for (const memberId of cluster) {
          coMoverIds.add(findSnapRoot(memberId));
        }
      }
      // Walk consumedBy upward to the topmost containing boolean (if any).
      // Used to (a) translate the entire cluster when dragging an operand,
      // and (b) collect "do-not-snap-to-self" component ids so the alt-drag
      // snap target search ignores cluster siblings (preventing oscillation
      // from snap-to-self).
      const compById = Object.fromEntries(scene.components.map(c => [c.id, c]));
      const topmostContainingBoolean = (rid) => {
        let cur = compById[rid];
        let topBool = null;
        while (cur && cur.consumedBy) {
          const parent = compById[cur.consumedBy];
          if (!parent) break;
          topBool = parent;
          cur = parent;
        }
        return topBool;
      };
      // Recursive expansion: collect every primitive that needs to translate
      // by the drag delta. For a boolean root, recurse into its operands.
      // For a primitive root that's consumed by a boolean, walk up to the
      // boolean and pull in its sibling operands. The visited-booleans
      // guard prevents infinite recursion (boolean → operand → boolean …).
      const expandBooleanRoot = (rid, acc, visitedBooleans = new Set()) => {
        const c = compById[rid];
        if (!c) { acc.add(rid); return; }
        if (c.kind !== 'boolean') {
          acc.add(rid);
          const containing = topmostContainingBoolean(rid);
          if (containing && !visitedBooleans.has(containing.id)) {
            expandBooleanRoot(containing.id, acc, visitedBooleans);
          }
          return;
        }
        if (visitedBooleans.has(rid)) return;
        visitedBooleans.add(rid);
        for (const opid of (c.operandIds || [])) {
          expandBooleanRoot(findSnapRoot(opid), acc, visitedBooleans);
        }
      };
      const expandedRoots = new Set();
      for (const rid of coMoverIds) {
        expandBooleanRoot(rid, expandedRoots);
      }
      const coMovers = [];
      for (const cid of expandedRoots) {
        const c = solved.find(cc => cc.id === cid);
        if (c) coMovers.push({ id: cid, startCx: c.cx, startCy: c.cy });
      }
      // Build the "do-not-snap-to-self" set: every co-mover plus every
      // boolean (recursively up the consumedBy chain) that contains them.
      // The alt-drag snap target search uses this to skip cluster siblings,
      // which would otherwise cause snap-to-self oscillation (their relative
      // position is fixed during a cluster drag, so the distance never
      // changes and the snap would re-fire every tick).
      const clusterSet = new Set(expandedRoots);
      for (const cid of expandedRoots) {
        let cur = compById[cid];
        while (cur && cur.consumedBy) {
          const parent = compById[cur.consumedBy];
          if (!parent) break;
          clusterSet.add(parent.id);
          cur = parent;
        }
      }
      // Also include any boolean directly in coMoverIds (e.g., when the
      // root walking landed on a boolean), so it won't snap-target itself.
      for (const rid of coMoverIds) {
        const c = compById[rid];
        if (c && c.kind === 'boolean') clusterSet.add(c.id);
      }
      // Compute the AABB of all co-movers at their START positions. This is
      // the "dragged shape" used by alt-drag anchor math. Using a single
      // operand's rect would misrepresent the composite's anchors.
      let cbMinX = Infinity, cbMaxX = -Infinity, cbMinY = Infinity, cbMaxY = -Infinity;
      for (const m of coMovers) {
        const c = solved.find(cc => cc.id === m.id);
        if (!c) continue;
        const cw = typeof c.w === 'number' ? c.w : evalExpr(c.w, paramValues);
        const ch = typeof c.h === 'number' ? c.h : evalExpr(c.h, paramValues);
        if (!Number.isFinite(cw) || !Number.isFinite(ch)) continue;
        const x0 = m.startCx - cw / 2, x1 = m.startCx + cw / 2;
        const y0 = m.startCy - ch / 2, y1 = m.startCy + ch / 2;
        if (x0 < cbMinX) cbMinX = x0; if (x1 > cbMaxX) cbMaxX = x1;
        if (y0 < cbMinY) cbMinY = y0; if (y1 > cbMaxY) cbMaxY = y1;
      }
      const clusterBboxCx = Number.isFinite(cbMinX) ? (cbMinX + cbMaxX) / 2 : (rootComp?.cx ?? 0);
      const clusterBboxCy = Number.isFinite(cbMinY) ? (cbMinY + cbMaxY) / 2 : (rootComp?.cy ?? 0);
      const clusterBboxW = Number.isFinite(cbMinX) ? (cbMaxX - cbMinX) : 0;
      const clusterBboxH = Number.isFinite(cbMinY) ? (cbMaxY - cbMinY) : 0;
      if (rootComp || coMovers.length > 0) {
        // If already in selection, drag it; otherwise replace selection with this one
        if (!selectedIds.has(id)) {
          setSelection({ ids: new Set([id]), primary: id });
        } else {
          setSelection({ ids: selectedIds, primary: id });
        }
        setDrag({
          kind: 'move',
          rootId,                       // semantic root (may be a boolean)
          clickedId: id,                // the component the user actually clicked (used for alt-drag snap install)
          startMouse: wp,               // mouse-down world position
          startCx: clusterBboxCx,       // cluster bbox center, used as reference for grid snap
          startCy: clusterBboxCy,
          clusterBboxW,                 // cluster bbox dimensions for alt-drag anchor math
          clusterBboxH,
          clusterSet,                   // ids to EXCLUDE from alt-drag snap target search
          coMovers,                     // primitives to translate by drag delta
        });
      }
      return;
    }

    // Background: alt-drag = marquee, plain drag = pan
    if (target === svgRef.current || target.dataset?.bg) {
      const wp = screenToWorld(e.clientX, e.clientY);
      if (e.altKey) {
        setMarquee({ startWorld: wp, currentWorld: wp, additive: e.shiftKey });
        if (!e.shiftKey) setSelection({ ids: new Set(), primary: null });
      } else {
        setPan({ startX: e.clientX, startY: e.clientY, startVX: viewport.x, startVY: viewport.y });
        setSelection({ ids: new Set(), primary: null });
      }
    }
  };

  const onMouseMove = (e) => {
    // Ruler: track current snap target for the preview dot/line
    if (rulerMode) {
      const wp = screenToWorld(e.clientX, e.clientY);
      const worldThresh = viewport.w * 0.012;
      const snap = findRulerSnap(wp, worldThresh);
      if (snap) setRulerSnapPoint(snap);
      else setRulerSnapPoint({ x: wp.x, y: wp.y, label: null });
    }
    // Add-drag: update p2 and re-evaluate snapEnd
    if (addMode && addDrag) {
      const wp = screenToWorld(e.clientX, e.clientY);
      const worldThresh = viewport.w * 0.012;
      const snap = findAnchorSnap(wp, worldThresh);
      const p2 = snap ? { x: snap.x, y: snap.y } : { x: wp.x, y: wp.y };
      setAddDrag({ ...addDrag, p2, snapEnd: snap || null });
    } else if (addMode && !addDrag) {
      // Pre-drag hover: show what point we'd snap to if the user clicked now.
      const wp = screenToWorld(e.clientX, e.clientY);
      const worldThresh = viewport.w * 0.012;
      const snap = findAnchorSnap(wp, worldThresh);
      setAddHoverSnap(snap || { x: wp.x, y: wp.y, compId: null, anchor: null });
    } else if (!addMode && addHoverSnap) {
      setAddHoverSnap(null);
    }
    // Track cursor position while picking anchors for the preview line
    if (snapMode === 'creating' && snapPick) {
      const wp = screenToWorld(e.clientX, e.clientY);
      setSnapCursor(wp);
    }
    if (drag) {
      const wp = screenToWorld(e.clientX, e.clientY);
      if (drag.kind === 'move') {
        let dx = wp.x - drag.startMouse.x;
        let dy = wp.y - drag.startMouse.y;
        // Shift = axis-lock: only move along the dominant axis from drag start
        if (shiftKey) {
          if (Math.abs(dx) >= Math.abs(dy)) dy = 0;
          else                              dx = 0;
        }
        // Option/Alt during move-drag: probe for an anchor on a DIFFERENT
        // component near the dragged rect (NOT near the cursor). The user's
        // gesture is "drag the rect close to another rect"; the cursor is
        // generally in the middle of the dragged rect, far from any target
        // anchor. So we instead find the closest pair of anchors between the
        // dragged rect (in its CURRENT proposed position) and any other
        // component, and if that distance is within threshold, snap them
        // exactly together. The visual preview shows the dragged rect
        // already snapped, and onMouseUp installs the real snap relationship.
        if (e.altKey) {
          const screenThresh = 30; // px — generous, since the gesture is approximate
          const worldThresh = screenThresh * (viewport.w / (svgRef.current?.clientWidth || 1));
          // The "dragged shape" is the CLUSTER's bbox (so anchor math reflects
          // the composite the user actually sees), not a single primitive.
          // Its proposed position = cluster's bbox-center at drag start +
          // mouse delta. Anchors are computed from the cluster bbox w/h.
          const proposedCx = drag.startCx + dx;
          const proposedCy = drag.startCy + dy;
          const dw = drag.clusterBboxW || 0;
          const dh = drag.clusterBboxH || 0;
          if (dw > 0 && dh > 0) {
            // Find closest (draggedAnchor, targetAnchor) pair across all
            // components that AREN'T part of this cluster. The clusterSet
            // contains every co-mover and every boolean that contains them,
            // preventing snap-to-self oscillation.
            //
            // HYSTERESIS: When `moveSnapHover` already holds a snap target
            // from a previous tick, we bias the search toward keeping it.
            // The current target gets a "stickiness bonus" — it's preferred
            // unless another candidate is significantly closer (the new
            // candidate must beat the current by a margin of stickThresh).
            // Without this, tiny mouse movements near anchor-pair switching
            // boundaries cause the cluster to flicker between snapped
            // positions ("oscillation") because the discrete winner of the
            // anchor-pair contest flips frequently. Cluster bbox center +
            // many sibling anchors create many near-equidistant candidates,
            // and the user perceives the cluster jumping around.
            const stickThresh = worldThresh * 0.5; // candidate must beat current by this margin
            let best = null;
            let currentBest = null; // the candidate matching the existing moveSnapHover, if any
            for (const oc of solved) {
              if (drag.clusterSet && drag.clusterSet.has(oc.id)) continue;
              if (oc.consumedBy) continue;
              const ow = typeof oc.w === 'string' ? evalExpr(oc.w, paramValues) : oc.w;
              const oh = typeof oc.h === 'string' ? evalExpr(oc.h, paramValues) : oc.h;
              if (!Number.isFinite(ow) || !Number.isFinite(oh) || ow <= 0 || oh <= 0) continue;
              for (const ta of ANCHORS) {
                const tlp = anchorLocal(ta, ow, oh);
                const tx = oc.cx + tlp.x;
                const ty = oc.cy + tlp.y;
                for (const da of ANCHORS) {
                  const dlp = anchorLocal(da, dw, dh);
                  const dax = proposedCx + dlp.x;
                  const day = proposedCy + dlp.y;
                  const dist = Math.hypot(tx - dax, ty - day);
                  if (dist <= worldThresh) {
                    const cand = {
                      dist,
                      dAnchor: da,
                      target: { x: tx, y: ty, compId: oc.id, anchor: ta },
                    };
                    if (!best || dist < best.dist) best = cand;
                    if (moveSnapHover &&
                        moveSnapHover.compId === oc.id &&
                        moveSnapHover.anchor === ta &&
                        moveSnapHover.dAnchor === da) {
                      currentBest = cand;
                    }
                  }
                }
              }
            }
            // If we have a current target and it's still valid (within
            // threshold), only swap to a different one if the new candidate
            // is meaningfully closer. This stops single-pixel mouse jitter
            // from flipping the chosen anchor pair.
            if (currentBest && best && currentBest !== best) {
              if (currentBest.dist - best.dist < stickThresh) {
                best = currentBest;
              }
            }
            if (best) {
              setMoveSnapHover({ ...best.target, dAnchor: best.dAnchor });
              // Place the cluster so its chosen anchor sits on the target.
              const dlp = anchorLocal(best.dAnchor, dw, dh);
              const newCx = best.target.x - dlp.x;
              const newCy = best.target.y - dlp.y;
              // Translation applied to every co-mover.
              const tdx = newCx - drag.startCx;
              const tdy = newCy - drag.startCy;
              const moversById = Object.fromEntries((drag.coMovers || []).map(m => [m.id, m]));
              updateScene(prev => ({
                ...prev,
                components: prev.components.map(c => {
                  const m = moversById[c.id];
                  if (m) return { ...c, cx: m.startCx + tdx, cy: m.startCy + tdy };
                  return c;
                })
              }));
              return;
            } else {
              if (moveSnapHover) setMoveSnapHover(null);
            }
          }
        } else {
          // Clear any leftover snap target when Alt is released mid-drag.
          if (moveSnapHover) setMoveSnapHover(null);
        }
        const newCx = snapToGrid(drag.startCx + dx);
        const newCy = snapToGrid(drag.startCy + dy);
        const tdx = newCx - drag.startCx;
        const tdy = newCy - drag.startCy;
        const moversById = Object.fromEntries((drag.coMovers || []).map(m => [m.id, m]));
        updateScene(prev => ({
          ...prev,
          components: prev.components.map(c => {
            const m = moversById[c.id];
            if (m) return { ...c, cx: m.startCx + tdx, cy: m.startCy + tdy };
            return c;
          })
        }));
      } else if (drag.kind === 'resize') {
        // Compute new width/height based on dragging anchor opposite to fixed corner
        // Anchor names: NW, N, NE, W, E, SW, S, SE
        const dx = wp.x - drag.startMouse.x;
        const dy = wp.y - drag.startMouse.y;
        const a = drag.anchor;
        let newW = drag.startW;
        let newH = drag.startH;
        let newCx = drag.startCx;
        let newCy = drag.startCy;

        // Option/Alt = symmetric resize: the OPPOSITE edge mirrors the
        // dragged edge instead of staying fixed, so the rect grows/shrinks
        // about its center. Width/height delta is doubled (both sides move),
        // and cx/cy stay put.
        const symmetric = e.altKey;

        // Horizontal direction
        if (a.includes('E')) {
          if (symmetric) {
            newW = Math.max(0.1, drag.startW + 2 * dx);
            newCx = drag.startCx;
          } else {
            newW = Math.max(0.1, drag.startW + dx);
            newCx = drag.startCx + dx / 2;
          }
        } else if (a.includes('W')) {
          if (symmetric) {
            newW = Math.max(0.1, drag.startW - 2 * dx);
            newCx = drag.startCx;
          } else {
            newW = Math.max(0.1, drag.startW - dx);
            newCx = drag.startCx + dx / 2;
          }
        }
        // Vertical direction (y-up world)
        if (a.includes('N')) {
          if (symmetric) {
            newH = Math.max(0.1, drag.startH + 2 * dy);
            newCy = drag.startCy;
          } else {
            newH = Math.max(0.1, drag.startH + dy);
            newCy = drag.startCy + dy / 2;
          }
        } else if (a.includes('S')) {
          if (symmetric) {
            newH = Math.max(0.1, drag.startH - 2 * dy);
            newCy = drag.startCy;
          } else {
            newH = Math.max(0.1, drag.startH - dy);
            newCy = drag.startCy + dy / 2;
          }
        }

        // Grid snap on resize: snap the dragged anchor's position to grid
        if (gridSnapEnabled && !modifier) {
          // Snap the anchor's world position to grid, then back-compute w/h, cx/cy
          const anchorLoc = anchorLocal(a, newW, newH);
          const anchorWorldX = newCx + anchorLoc.x;
          const anchorWorldY = newCy + anchorLoc.y;
          const sx = snapToGrid(anchorWorldX);
          const sy = snapToGrid(anchorWorldY);
          const ddx = sx - anchorWorldX;
          const ddy = sy - anchorWorldY;
          // Adjust newW/newH/newCx/newCy by the snap delta
          if (a.includes('E')) { newW = Math.max(0.1, newW + ddx); newCx += ddx / 2; }
          else if (a.includes('W')) { newW = Math.max(0.1, newW - ddx); newCx += ddx / 2; }
          if (a.includes('N')) { newH = Math.max(0.1, newH + ddy); newCy += ddy / 2; }
          else if (a.includes('S')) { newH = Math.max(0.1, newH - ddy); newCy += ddy / 2; }
        }

        // Decide how to update w / h:
        //   - Single identifier (e.g., "aw"): the parameter IS the dimension.
        //     Update the parameter's expr to the new numeric value. Standard.
        //   - Multi-identifier expression (e.g., "cap_sep/2 - port_L/2"): the
        //     dimension is a derived quantity. We CAN'T cleanly turn the
        //     resize delta into changes to the underlying parameters, so we
        //     do nothing to the dimension — only cx/cy update. The user must
        //     edit the parameters directly to change such widths. Crucially,
        //     we also DON'T clobber c.w/c.h to a literal: that would break
        //     the parametric chain that other components (span rects) rely on.
        //   - Literal number (e.g., "30"): replace with the new numeric.
        const isSingleIdent = (s) => typeof s === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(s.trim());
        const isLiteralNum = (s) => typeof s === 'string' && /^[\d\s+\-*/.()]+$/.test(s.trim());
        const wIsParam = isSingleIdent(drag.wExpr);
        const hIsParam = isSingleIdent(drag.hExpr);
        const wIsLiteral = !wIsParam && isLiteralNum(drag.wExpr || '');
        const hIsLiteral = !hIsParam && isLiteralNum(drag.hExpr || '');
        // If w/h is an EXPRESSION (not single ident, not pure literal), we
        // leave it alone. The visual size won't reflect the drag attempt.
        const wIsExpr = !wIsParam && !wIsLiteral;
        const hIsExpr = !hIsParam && !hIsLiteral;

        updateScene(prev => {
          let newParams = prev.params;
          let newComps = prev.components.map(c => {
            if (c.id !== drag.compId) return c;
            const patch = { cx: newCx, cy: newCy };
            // Only overwrite c.w / c.h with a literal when it WAS a literal
            // before the resize. For single-ident params, the param itself
            // gets updated below (c.w stays the same identifier name). For
            // multi-ident expressions, leave c.w untouched (preserves chain).
            if (wIsLiteral) patch.w = newW.toFixed(3);
            if (hIsLiteral) patch.h = newH.toFixed(3);
            // For expression-bound dimensions, also DON'T update cx/cy —
            // since the dimension didn't change, the center shouldn't drift
            // either (otherwise the user sees the rect translate without
            // resizing, which is confusing).
            if (wIsExpr) patch.cx = c.cx;
            if (hIsExpr) patch.cy = c.cy;
            return { ...c, ...patch };
          });
          if (wIsParam) {
            const pName = drag.wExpr.trim();
            newParams = { ...newParams, [pName]: { ...newParams[pName], expr: newW.toFixed(3) } };
          }
          if (hIsParam) {
            const pName = drag.hExpr.trim();
            newParams = { ...newParams, [pName]: { ...newParams[pName], expr: newH.toFixed(3) } };
          }
          return { ...prev, params: newParams, components: newComps };
        });
      }
    } else if (pan) {
      const rect = svgRef.current.getBoundingClientRect();
      const dx = (e.clientX - pan.startX) * (viewport.w / rect.width);
      const dy = (e.clientY - pan.startY) * (viewport.h / rect.height);
      setViewport(v => ({ ...v, x: pan.startVX - dx, y: pan.startVY + dy }));
    } else if (marquee) {
      const wp = screenToWorld(e.clientX, e.clientY);
      setMarquee(m => ({ ...m, currentWorld: wp }));
    }
  };

  const onMouseUp = () => {
    // Commit add-drag: create the new component with sensible parametric bindings
    if (addDrag) {
      const { p1, p2, snapStart, snapEnd } = addDrag;
      const dx = p2.x - p1.x, dy = p2.y - p1.y;
      const dragDist = Math.sqrt(dx * dx + dy * dy);
      // Threshold: any drag bigger than half a grid unit counts as sized.
      // Smaller than that, treat as a click and drop a default 20×20 rect at p1.
      const minDrag = Math.max(0.5, gridSize / 2);
      if (dragDist >= minDrag) {
        commitDragAdd(addMode, p1, p2, snapStart, snapEnd);
      } else if (dragDist < minDrag && addMode) {
        // Click without drag: drop a default-sized rect at p1.
        const defaultHalf = 10;
        const fakeP1 = { x: p1.x - defaultHalf, y: p1.y - defaultHalf };
        const fakeP2 = { x: p1.x + defaultHalf, y: p1.y + defaultHalf };
        // If snapStart was set (you clicked exactly on an anchor) we still
        // want to snap; the new component centers on the click and an SW/NE
        // corner won't quite line up, so use no snap in this branch and let
        // the user reposition manually.
        commitDragAdd(addMode, fakeP1, fakeP2, snapStart, null);
      }
      setAddDrag(null);
      setAddMode(null); // one-shot tool — exit add mode after commit
      return;
    }
    // Commit marquee selection
    if (marquee) {
      const x1 = Math.min(marquee.startWorld.x, marquee.currentWorld.x);
      const x2 = Math.max(marquee.startWorld.x, marquee.currentWorld.x);
      const y1 = Math.min(marquee.startWorld.y, marquee.currentWorld.y);
      const y2 = Math.max(marquee.startWorld.y, marquee.currentWorld.y);
      // Only commit if user dragged at least a tiny amount
      if (x2 - x1 > 0.001 || y2 - y1 > 0.001) {
        const hits = solved.filter(c => {
          const w = evalExpr(c.w, paramValues);
          const h = evalExpr(c.h, paramValues);
          // intersection test (component bbox vs marquee bbox)
          const cx1 = c.cx - w / 2, cx2 = c.cx + w / 2;
          const cy1 = c.cy - h / 2, cy2 = c.cy + h / 2;
          return cx2 >= x1 && cx1 <= x2 && cy2 >= y1 && cy1 <= y2;
        }).map(c => c.id);
        const newIds = marquee.additive ? new Set([...selectedIds, ...hits]) : new Set(hits);
        setSelection({ ids: newIds, primary: hits.length > 0 ? hits[hits.length - 1] : null });
      }
    }
    // Commit alt-drag snap: if the user was move-dragging with Alt and a
    // snap target was hovered at release, install a snap from the target's
    // anchor to the dragged component's nearest anchor (the same anchor
    // that was used for visual previewing during the move). This gives a
    // smooth "drag-toward-something-and-let-go" gesture for connecting
    // components without entering the explicit snap-creation tool.
    if (drag && drag.kind === 'move' && moveSnapHover) {
      const target = moveSnapHover;
      // The "dragged" component for snap purposes is the one the user
      // clicked on — typically the boolean itself when dragging a composite,
      // not the snap-chain root (which could be a different component
      // higher up the chain). The visual preview placed the cluster's
      // bbox-anchor on the target, so the installed snap should attach to
      // the clicked component to match user intent.
      const dragId = drag.clickedId || drag.rootId;
      const draggedComp = solved.find(c => c.id === dragId);
      if (draggedComp && target.compId !== dragId) {
        // Use the dragged-anchor that was used during preview (stored on
        // moveSnapHover) so the installed snap matches what the user saw.
        const bestAnchor = target.dAnchor || 'C';
        // Auto-reverse if the dragged component is already the `to` of an
        // existing snap (only one parent is allowed). If both ends are
        // already constrained, abort with a helpful message and leave the
        // literal cx/cy from the move in place.
        const draggedHasIncoming = scene.snaps.some(s => s.to.compId === dragId);
        const targetHasIncoming = scene.snaps.some(s => s.to.compId === target.compId);
        let fromCompId, fromAnchor, toCompId, toAnchor;
        if (!draggedHasIncoming) {
          // Standard direction: target is the parent of the dragged comp.
          fromCompId = target.compId; fromAnchor = target.anchor;
          toCompId = dragId; toAnchor = bestAnchor;
        } else if (!targetHasIncoming) {
          // Dragged is already constrained — reverse so target becomes child.
          fromCompId = dragId; fromAnchor = bestAnchor;
          toCompId = target.compId; toAnchor = target.anchor;
        } else {
          // Both already constrained — leave the literal move in place and
          // surface the situation in the alert dialog.
          alertDialog(
            `Both ${dragId} and ${target.compId} are already positioned by another snap. Re-root one of them first (use the ⇄ button in the inspector) to free a target.`,
            'Cannot create snap'
          );
          setDrag(null);
          setMoveSnapHover(null);
          return;
        }
        // Pick fresh gap-parameter names. Use 0 dx/dy because the dragged
        // component's anchor is exactly on the target at this point.
        const usedNames = new Set(Object.keys(scene.params));
        const nextName = (prefix) => {
          let i = 1;
          while (usedNames.has(`${prefix}${i}`)) i++;
          usedNames.add(`${prefix}${i}`);
          return `${prefix}${i}`;
        };
        const gapX = nextName('gap_x');
        const gapY = nextName('gap_y');
        updateScene(prev => ({
          ...prev,
          params: {
            ...prev.params,
            [gapX]: { expr: '0', unit: 'µm', desc: `Gap ${fromCompId}.${fromAnchor} → ${toCompId}.${toAnchor} (dx)` },
            [gapY]: { expr: '0', unit: 'µm', desc: `Gap ${fromCompId}.${fromAnchor} → ${toCompId}.${toAnchor} (dy)` },
          },
          snaps: [...prev.snaps, {
            id: `snap_${Date.now()}`,
            from: { compId: fromCompId, anchor: fromAnchor },
            to:   { compId: toCompId,   anchor: toAnchor },
            dx: gapX, dy: gapY,
          }],
        }));
      }
      setDrag(null);
      setMoveSnapHover(null);
      return;
    }
    setDrag(null);
    setPan(null);
    setMarquee(null);
    if (moveSnapHover) setMoveSnapHover(null);
  };

  const onAnchorClick = (compId, anchor, evt) => {
    if (snapMode !== 'creating') return;
    if (!snapPick) {
      setSnapPick({ compId, anchor });
      return;
    }
    if (snapPick.compId === compId) return;
    const fromComp = solved.find(c => c.id === snapPick.compId);
    const toComp = solved.find(c => c.id === compId);
    if (!fromComp || !toComp) return;

    // Determine snap direction. A snap's `to` component is the one whose
    // position the snap dictates. A component can only be the `to` of one
    // snap. If our intended `to` (the second-clicked component) is already
    // constrained by another snap, reverse direction so the other partner is
    // the moved one. If both are already constrained, we can't add a useful
    // constraint — explain to the user why nothing happened.
    const isFirstConstrained  = scene.snaps.some(sn => sn.to.compId === snapPick.compId);
    const isSecondConstrained = scene.snaps.some(sn => sn.to.compId === compId);

    if (isFirstConstrained && isSecondConstrained) {
      const blockerOnFirst  = scene.snaps.find(sn => sn.to.compId === snapPick.compId);
      const blockerOnSecond = scene.snaps.find(sn => sn.to.compId === compId);
      // Cancel the snap-creation interaction and tell the user.
      setSnapPick(null);
      setSnapHover(null);
      setSnapCursor(null);
      setSnapMode('idle');
      if (alertDialog) {
        alertDialog(
          `Cannot create this snap because both components are already positioned by other snaps:\n\n` +
          `  • "${snapPick.compId}" is moved by snap "${blockerOnFirst.id}" (parent: ${blockerOnFirst.from.compId})\n` +
          `  • "${compId}" is moved by snap "${blockerOnSecond.id}" (parent: ${blockerOnSecond.from.compId})\n\n` +
          `A snap moves one component to satisfy a relationship with another. If both components are already pinned by other snaps, there's nothing left for this snap to do — adding it would silently conflict.\n\n` +
          `To proceed, break one of the existing snaps first (click the unlink icon in the snap inspector for the component you want to free) and try again.`,
          'Snap not created'
        );
      }
      return;
    }

    const fromW = anchorWorld(fromComp, snapPick.anchor, paramValues);
    const toW = anchorWorld(toComp, anchor, paramValues);
    let dx = toW.x - fromW.x;
    let dy = toW.y - fromW.y;
    // Shift held = axis-lock the resulting offset to a single axis (zero the smaller delta)
    const shiftHeld = !!(evt && evt.shiftKey);
    if (shiftHeld) {
      if (Math.abs(dx) < Math.abs(dy)) dx = 0; else dy = 0;
    }

    // Decide snap direction (auto-reverse if the user-intended `to` is already constrained)
    let actualFrom, actualFromAnchor, actualTo, actualToAnchor, actualDx, actualDy, didReverse = false;
    if (!isSecondConstrained) {
      actualFrom = snapPick.compId; actualFromAnchor = snapPick.anchor;
      actualTo = compId;             actualToAnchor = anchor;
      actualDx = dx; actualDy = dy;
    } else {
      // isSecondConstrained && !isFirstConstrained (the both-constrained case is already handled above)
      didReverse = true;
      actualFrom = compId;            actualFromAnchor = anchor;
      actualTo = snapPick.compId;     actualToAnchor = snapPick.anchor;
      actualDx = -dx; actualDy = -dy;
    }

    updateScene(prev => {
      // Build helper to find unused gap parameter name
      const usedNames = new Set(Object.keys(prev.params));
      const nextGapName = (prefix) => {
        let i = 1;
        while (usedNames.has(`${prefix}${i}`)) i++;
        usedNames.add(`${prefix}${i}`);
        return `${prefix}${i}`;
      };
      const newParams = { ...prev.params };
      const nameX = nextGapName('gap_x');
      newParams[nameX] = {
        expr: Math.abs(actualDx) < 1e-3 ? '0' : actualDx.toFixed(3),
        unit: 'µm',
        desc: `Gap ${actualFrom}.${actualFromAnchor} → ${actualTo}.${actualToAnchor} (dx)`,
      };
      const nameY = nextGapName('gap_y');
      newParams[nameY] = {
        expr: Math.abs(actualDy) < 1e-3 ? '0' : actualDy.toFixed(3),
        unit: 'µm',
        desc: `Gap ${actualFrom}.${actualFromAnchor} → ${actualTo}.${actualToAnchor} (dy)`,
      };
      const newSnap = {
        id: `snap_${Date.now()}`,
        from: { compId: actualFrom, anchor: actualFromAnchor },
        to:   { compId: actualTo,   anchor: actualToAnchor },
        dx: nameX, dy: nameY,
      };
      return { ...prev, params: newParams, snaps: [...prev.snaps, newSnap] };
    });
    // (didReverse is computed for potential future "snap was reversed" toast; not surfaced today)
    void didReverse;

    setSnapPick(null);
    setSnapHover(null);
    setSnapCursor(null);
    setSnapMode('idle');
  };

  const vbX = viewport.x - viewport.w / 2;
  const vbY = -(viewport.y + viewport.h / 2);
  const layerStyle = {
    waveguide: { fill: '#3ec27a', stroke: '#1a5e36', opacity: 0.8 },
    electrode: { fill: '#f4a72e', stroke: '#7a4d00', opacity: 0.85 },
    // Lumped port: non-physical layer for HFSS port assignment. Rendered as a
    // dark-red translucent rectangle so it stands out against waveguides and
    // electrodes; not part of the layer stack and not exported as a metal sheet.
    port:      { fill: '#b91c1c', stroke: '#7f1d1d', opacity: 0.45 },
  };

  // Sized-relative handle radius and stroke unit. Both scale with the
  // viewport so that overlays (arrows, handles, halos) keep their on-screen
  // proportions constant regardless of zoom level. Without this, the SVG's
  // viewBox shrinks as you zoom in but world-unit stroke widths stay fixed,
  // and overlays appear progressively thicker until they collapse into dots.
  const hr = Math.max(viewport.w, viewport.h) / 250;
  const sw = Math.max(viewport.w, viewport.h) / 1500; // baseline 1px-ish stroke in world units
  const HALO_W = sw * 3.6; // selection halo width — also used for snap-network dashes

  return (
    <svg
      ref={svgRef}
      viewBox={`${vbX} ${vbY} ${viewport.w} ${viewport.h}`}
      preserveAspectRatio="xMidYMid meet"
      className="w-full h-full"
      style={{ background: '#f1f5f9', cursor: addMode ? 'crosshair' : (marquee ? 'crosshair' : (altKey ? 'crosshair' : (pan ? 'grabbing' : (drag?.kind === 'move' ? 'move' : 'default')))) }}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={onMouseUp}
      onWheel={onWheel}
    >
      <defs>
        <pattern id="grid" width={gridSize} height={gridSize} patternUnits="userSpaceOnUse">
          <path d={`M ${gridSize} 0 L 0 0 0 ${gridSize}`} fill="none" stroke="#cbd5e1" strokeWidth="0.3" />
        </pattern>
        <pattern id="gridMajor" width={gridSize * 5} height={gridSize * 5} patternUnits="userSpaceOnUse">
          <path d={`M ${gridSize * 5} 0 L 0 0 0 ${gridSize * 5}`} fill="none" stroke="#94a3b8" strokeWidth="0.4" />
        </pattern>
      </defs>
      <rect data-bg="true" x={vbX} y={vbY} width={viewport.w} height={viewport.h} fill="url(#grid)" />
      <rect data-bg="true" x={vbX} y={vbY} width={viewport.w} height={viewport.h} fill="url(#gridMajor)" />

      <line x1={vbX} y1={0} x2={vbX + viewport.w} y2={0} stroke="#475569" strokeWidth={sw * 0.7} strokeDasharray={`${sw * 3},${sw * 3}`} pointerEvents="none" />
      <line x1={0} y1={vbY} x2={0} y2={vbY + viewport.h} stroke="#475569" strokeWidth={sw * 0.7} strokeDasharray={`${sw * 3},${sw * 3}`} pointerEvents="none" />

      {/* Mirror axes */}
      {scene.mirrors.map(m => (
        m.axis === 'horizontal' ? (
          <line key={m.id} x1={vbX} y1={-m.axisCoord} x2={vbX + viewport.w} y2={-m.axisCoord} stroke="#a855f7" strokeWidth={sw * 0.8} strokeDasharray={`${sw * 4},${sw * 3}`} opacity={0.6} pointerEvents="none" />
        ) : (
          <line key={m.id} x1={m.axisCoord} y1={vbY} x2={m.axisCoord} y2={vbY + viewport.h} stroke="#a855f7" strokeWidth={sw * 0.8} strokeDasharray={`${sw * 4},${sw * 3}`} opacity={0.6} pointerEvents="none" />
        )
      ))}

      {/* ===== Boolean cluster rendering =====
          Each boolean component renders as a unified visual using SVG
          mask/clip primitives. Operands may themselves be derived boolean
          components — in that case we recurse, building nested masks/clips
          that compose correctly. The browser performs polygon clipping at
          rasterization time, exact for our axis-aligned and rotated
          rectangle inputs.

          Each operand contributes one of two SVG "shapes":
            - For a primitive: a single <path d="..."/> for its rect.
            - For a derived boolean: a <g> that collectively fills the
              boolean's interior, using its own mask/clip composition.
          Both can be used inside a parent mask/clipPath as long as fills
          are set correctly (white for "include" in a mask, parent fills
          for clip contents).

          Per-op masking strategy:
            UNION:    each operand outline masked by NOT(other operands)
                      → only edges on the union perimeter survive.
            INTERSECT: each operand outline clipped by intersection of
                      OTHER operands' interiors → only edges that bound the
                      intersection survive.
            SUBTRACT:  base outline masked by NOT(subtractors), plus each
                      subtractor outline clipped by base interior.
       */}
      {(() => {
        // ID generator scoped to a single render pass; ensures defs ids are
        // unique even when the same component appears in multiple booleans.
        let _defIdCounter = 0;
        const nextDefId = (prefix) => `${prefix}-${_defIdCounter++}`;
        // Map id → component for recursive resolution.
        const compById = Object.fromEntries(scene.components.map(c => [c.id, c]));
        // Resolve a component's first rendered instance (post-transform).
        const instOf = (c) => {
          const list = instancesByCompId[c.id] || [];
          return list[0] || {
            compId: c.id, idx: 0, cx: c.cx, cy: c.cy,
            w: evalExpr(c.w, paramValues), h: evalExpr(c.h, paramValues),
            rotation: 0,
          };
        };
        // Path "d" string for an instance, dispatching on the instance's
        // shape kind via shapeInstanceToRing (circles/ellipses/polygons
        // become tessellated rings; rectangles use their 4-corner ring).
        const rectPathD = (inst) => ringToSvgPath(shapeInstanceToRing(inst));

        // Flat-bbox collector used for mask viewport sizing; recurses
        // through derived operands so the bbox covers the entire object.
        const collectBbox = (comp) => {
          const out = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
          const visit = (c) => {
            if (!c) return;
            if (c.kind === 'boolean') {
              for (const id of (c.operandIds || [])) visit(compById[id]);
            } else {
              const ring = shapeInstanceToRing(instOf(c));
              for (const [x, y] of ring) {
                if (x < out.minX) out.minX = x; if (x > out.maxX) out.maxX = x;
                if (y < out.minY) out.minY = y; if (y > out.maxY) out.maxY = y;
              }
            }
          };
          visit(comp);
          return out;
        };

        // Recursively render an object's INTERIOR as SVG. The output is a
        // <g> (or <path>) whose drawn pixels equal the interior region of
        // the object, filled with `fillColor`. This is composable: it can
        // be nested inside <mask>, <clipPath>, or rendered directly.
        // For mask use: pass fillColor = 'white' (and add a black background
        // outside).
        // For direct rendering: pass the object's display fill color.
        // For "subtract" inside a parent mask: pass 'black' (the operand's
        // interior overrides the white base in the mask).
        //
        // `depth` is for unique key generation; bumped per nesting level.
        const renderInterior = (comp, fillColor, keyBase, dataCompId, parentClip) => {
          if (!comp) return null;
          const isPrim = comp.kind !== 'boolean';
          if (isPrim) {
            const inst = instOf(comp);
            return (
              <path
                key={keyBase}
                d={rectPathD(inst)}
                fill={fillColor}
                {...(dataCompId ? { 'data-comp-id': dataCompId } : {})}
                {...(parentClip ? { clipPath: parentClip } : {})}
              />
            );
          }
          // Derived boolean operand. Resolve children components.
          const ops = (comp.operandIds || []).map(id => compById[id]).filter(Boolean);
          if (ops.length < 2) return null;
          if (comp.op === 'union') {
            // Render every operand's interior with the same fillColor; their
            // overlapping fills (in subtractive/additive raster terms) form
            // the union region. For mask use this is correct: white
            // overlapping white = white. For display fill: same color
            // overlapping = same color.
            return (
              <g key={keyBase}>
                {ops.map((opC, i) => renderInterior(opC, fillColor, `${keyBase}-u${i}`, dataCompId, parentClip))}
              </g>
            );
          }
          if (comp.op === 'intersect') {
            // Build a chain of clipPaths so operand[0] is clipped by
            // operand[1] is clipped by operand[2] etc. Each clipPath's
            // content is the operand's interior.
            const chainIds = [];
            const chainDefs = [];
            for (let i = 1; i < ops.length; i++) {
              const id = nextDefId(`${keyBase}-isectclip-${i}`);
              const parentId = i > 1 ? chainIds[i - 2] : (parentClip ? parentClip.replace(/^url\(#|\)$/g, '') : null);
              chainIds.push(id);
              chainDefs.push(
                <clipPath key={id} id={id} clipPathUnits="userSpaceOnUse">
                  {renderInterior(ops[i], 'white', `${id}-c`, undefined, parentId ? `url(#${parentId})` : undefined)}
                </clipPath>
              );
            }
            const finalClip = chainIds.length ? `url(#${chainIds[chainIds.length - 1]})` : parentClip;
            return (
              <g key={keyBase}>
                <defs>{chainDefs}</defs>
                {renderInterior(ops[0], fillColor, `${keyBase}-i0`, dataCompId, finalClip)}
              </g>
            );
          }
          if (comp.op === 'subtract') {
            // base operand drawn in `fillColor`, with a mask that has the
            // base's interior in white minus subtractors' interiors in black.
            const maskId = nextDefId(`${keyBase}-submask`);
            const bbox = collectBbox(comp);
            const pad = Math.max(bbox.maxX - bbox.minX, bbox.maxY - bbox.minY) * 0.1 + 1;
            const mvX = bbox.minX - pad, mvY = bbox.minY - pad;
            const mvW = (bbox.maxX - bbox.minX) + 2 * pad;
            const mvH = (bbox.maxY - bbox.minY) + 2 * pad;
            return (
              <g key={keyBase}>
                <defs>
                  <mask id={maskId} maskUnits="userSpaceOnUse"
                    x={mvX} y={-mvY - mvH} width={mvW} height={mvH}>
                    <rect x={mvX} y={-mvY - mvH} width={mvW} height={mvH} fill="black" />
                    {renderInterior(ops[0], 'white', `${maskId}-base`)}
                    {ops.slice(1).map((opC, i) =>
                      renderInterior(opC, 'black', `${maskId}-sub${i}`)
                    )}
                  </mask>
                </defs>
                <g mask={`url(#${maskId})`}>
                  {renderInterior(ops[0], fillColor, `${keyBase}-baseunder`, dataCompId, parentClip)}
                </g>
              </g>
            );
          }
          return null;
        };

        // Render the OUTLINE of an object. Returns SVG that traces the
        // visible perimeter. For a primitive: just stroke the rect path.
        // For a derived boolean: stroke each operand's perimeter with the
        // appropriate mask/clip so only edges on the result boundary
        // contribute. Recursive — operands can themselves be booleans.
        const renderOutline = (comp, strokeColor, strokeW, keyBase) => {
          if (!comp) return null;
          const isPrim = comp.kind !== 'boolean';
          if (isPrim) {
            const inst = instOf(comp);
            return (
              <path key={keyBase} d={rectPathD(inst)}
                fill="none" stroke={strokeColor} strokeWidth={strokeW}
                pointerEvents="none"
              />
            );
          }
          const ops = (comp.operandIds || []).map(id => compById[id]).filter(Boolean);
          if (ops.length < 2) return null;
          if (comp.op === 'union') {
            // Each operand's outline masked by the union of OTHER operands'
            // interiors (in black) → edges inside other operands hidden.
            // Build one mask per operand.
            return (
              <g key={keyBase}>
                {ops.map((opC, i) => {
                  const maskId = nextDefId(`${keyBase}-uout${i}`);
                  const bbox = collectBbox(comp);
                  const pad = Math.max(bbox.maxX - bbox.minX, bbox.maxY - bbox.minY) * 0.1 + 1;
                  const mvX = bbox.minX - pad, mvY = bbox.minY - pad;
                  const mvW = (bbox.maxX - bbox.minX) + 2 * pad;
                  const mvH = (bbox.maxY - bbox.minY) + 2 * pad;
                  return (
                    <g key={`${keyBase}-uo${i}`}>
                      <defs>
                        <mask id={maskId} maskUnits="userSpaceOnUse"
                          x={mvX} y={-mvY - mvH} width={mvW} height={mvH}>
                          {/* white = visible by default; subtract OTHER operands' interiors. */}
                          <rect x={mvX} y={-mvY - mvH} width={mvW} height={mvH} fill="white" />
                          {ops.map((other, j) => i === j ? null :
                            renderInterior(other, 'black', `${maskId}-other${j}`))}
                        </mask>
                      </defs>
                      <g mask={`url(#${maskId})`}>
                        {renderOutline(opC, strokeColor, strokeW, `${keyBase}-uoinner${i}`)}
                      </g>
                    </g>
                  );
                })}
              </g>
            );
          }
          if (comp.op === 'intersect') {
            // Each operand's outline clipped by the intersection of the
            // OTHER operands' interiors. Build a per-operand clipPath
            // chain over the others.
            return (
              <g key={keyBase}>
                {ops.map((opC, i) => {
                  const others = ops.filter((_, j) => j !== i);
                  // Build clipPath chain from `others`. clip[k] = others[k]
                  // clipped by clip[k-1].
                  const chainIds = [];
                  const chainDefs = [];
                  for (let k = 0; k < others.length; k++) {
                    const id = nextDefId(`${keyBase}-isout${i}-${k}`);
                    const parentId = k > 0 ? chainIds[k - 1] : null;
                    chainIds.push(id);
                    chainDefs.push(
                      <clipPath key={id} id={id} clipPathUnits="userSpaceOnUse">
                        {renderInterior(others[k], 'white', `${id}-c`, undefined, parentId ? `url(#${parentId})` : undefined)}
                      </clipPath>
                    );
                  }
                  const finalClip = chainIds.length ? `url(#${chainIds[chainIds.length - 1]})` : null;
                  return (
                    <g key={`${keyBase}-iso${i}`}>
                      <defs>{chainDefs}</defs>
                      <g clipPath={finalClip}>
                        {renderOutline(opC, strokeColor, strokeW, `${keyBase}-isoinner${i}`)}
                      </g>
                    </g>
                  );
                })}
              </g>
            );
          }
          if (comp.op === 'subtract') {
            // Base operand outline masked by NOT(subtractors), plus each
            // subtractor's outline clipped by base interior.
            const maskId = nextDefId(`${keyBase}-subout`);
            const baseClipId = nextDefId(`${keyBase}-baseclip`);
            const bbox = collectBbox(comp);
            const pad = Math.max(bbox.maxX - bbox.minX, bbox.maxY - bbox.minY) * 0.1 + 1;
            const mvX = bbox.minX - pad, mvY = bbox.minY - pad;
            const mvW = (bbox.maxX - bbox.minX) + 2 * pad;
            const mvH = (bbox.maxY - bbox.minY) + 2 * pad;
            return (
              <g key={keyBase}>
                <defs>
                  <mask id={maskId} maskUnits="userSpaceOnUse"
                    x={mvX} y={-mvY - mvH} width={mvW} height={mvH}>
                    <rect x={mvX} y={-mvY - mvH} width={mvW} height={mvH} fill="black" />
                    {renderInterior(ops[0], 'white', `${maskId}-base`)}
                    {ops.slice(1).map((opC, i) =>
                      renderInterior(opC, 'black', `${maskId}-sub${i}`)
                    )}
                  </mask>
                  <clipPath id={baseClipId} clipPathUnits="userSpaceOnUse">
                    {renderInterior(ops[0], 'white', `${baseClipId}-c`)}
                  </clipPath>
                </defs>
                <g mask={`url(#${maskId})`}>
                  {renderOutline(ops[0], strokeColor, strokeW, `${keyBase}-baseout`)}
                </g>
                <g clipPath={`url(#${baseClipId})`}>
                  {ops.slice(1).map((opC, i) =>
                    renderOutline(opC, strokeColor, strokeW, `${keyBase}-subout${i}`)
                  )}
                </g>
              </g>
            );
          }
          return null;
        };

        // Render a single boolean cluster: fill + outline + selection halo.
        return booleanClusters.booleanComps.map((b) => {
          // Determine the display fill color from the boolean's own layer
          // (which inherits from operand[0] at creation time).
          const layer = b.layer || 'waveguide';
          const style = layerStyle[layer] || layerStyle.waveguide;
          const fill = style.fill;
          const fillOpacity = style.opacity;
          const accent = b.op === 'union' ? '#10b981'
            : b.op === 'intersect' ? '#22d3ee'
            : '#f59e0b';
          const haloColor = '#0ea5e9';
          const outlineW = sw * 0.7;
          const haloW = HALO_W;
          const isSelected = selectedIds.has(b.id);
          const bbox = collectBbox(b);
          // Don't render if the bbox is degenerate (e.g., missing operands).
          if (!Number.isFinite(bbox.minX)) return null;
          return (
            <g key={`bool_${b.id}`} style={{ cursor: 'move' }}>
              {/* (1) Fill — recursive interior with the layer's fill color. */}
              <g opacity={fillOpacity}>
                {renderInterior(b, fill, `bool-fill-${b.id}`, b.id)}
              </g>
              {/* (2) Result outline — recursive perimeter in op accent. */}
              {renderOutline(b, accent, outlineW, `bool-out-${b.id}`)}
              {/* (3) Selection halo — same outline path, thicker, cyan,
                  drawn on top so it dominates visually when selected. */}
              {isSelected && renderOutline(b, haloColor, haloW, `bool-halo-${b.id}`)}
            </g>
          );
        });
      })()}

      {/* Snap-mode anchors for BOOLEAN components. Booleans are rendered
          via mask/clip primitives in the cluster path above, so the
          standard component loop's anchor-dot code doesn't run for them.
          We render them here using the bbox-derived w/h written by
          resolveBooleanBboxes. Anchor handling is identical to primitives:
          click a dot to pick / commit a snap, and the same snap creation
          flow runs. */}
      {snapMode === 'creating' && booleanClusters.booleanComps.map(bScene => {
        // The scene-side boolean has w='0', h='0' stored as placeholders.
        // Look up the SOLVED counterpart for the actual bbox-derived
        // numeric dimensions written by solveLayout/refreshBooleanBbox.
        // Without this, the placeholder strings evaluate to zero and the
        // anchor dots either don't render or all stack at (0, 0).
        const b = solved.find(c => c.id === bScene.id) || bScene;
        const w = typeof b.w === 'string' ? evalExpr(b.w, paramValues) : b.w;
        const h = typeof b.h === 'string' ? evalExpr(b.h, paramValues) : b.h;
        if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
        return (
          <g key={`bool-anchors-${b.id}`}>
            {ANCHORS.map(a => {
              const local = anchorLocal(a, w, h);
              const ax = b.cx + local.x;
              const ay = -(b.cy + local.y);
              const isPicked = snapPick?.compId === b.id && snapPick.anchor === a;
              return (
                <circle key={'sa_' + a}
                  cx={ax} cy={ay} r={hr * 1.2}
                  fill={isPicked ? '#ef4444' : '#f59e0b'}
                  stroke="white" strokeWidth={0.2}
                  style={{ cursor: 'crosshair' }}
                  onMouseEnter={() => setSnapHover(null)}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => { e.stopPropagation(); onAnchorClick(b.id, a, e); }}
                />
              );
            })}
          </g>
        );
      })}

      {(() => {
        // Two-pass component rendering. Pass 1 draws all NON-selected components
        // in their normal layer order (waveguide, then electrode), preserving
        // physical-layer overlap semantics. Pass 2 draws related and selected
        // components on top, regardless of layer, so the selection's halo,
        // snap arrows, and resize handles never disappear behind a neighbor.
        // Within pass 2, ordering is: related (parent/child/mirror), then
        // non-primary multi-selected, then primary selected — primary always
        // ends up rendered last and thus topmost.
        const stackPriority = (c) => {
          if (c.id === selectedId) return 4;
          if (selectedIds.has(c.id)) return 3;
          if (relatedIds.parents.has(c.id) || relatedIds.children.has(c.id) || relatedIds.mirrors.has(c.id)) return 2;
          return 1;
        };
        const isInPass1 = (c) => stackPriority(c) === 1;
        // Components that participate in an ENABLED boolean op are rendered
        // separately as part of the boolean cluster; suppress here to avoid
        // double-rendering. Boolean components themselves (kind='boolean')
        // are derived objects with no primitive geometry — they render via
        // the boolean cluster path above, so they must also be skipped here.
        // Selected operand components still get their halo/handles via pass2
        // since selection styling is what users need most when editing.
        const isBoolOperand = (c) => booleanClusters.operandIds.has(c.id) && !selectedIds.has(c.id);
        const isBoolComp = (c) => c.kind === 'boolean';
        const pass1 = [];
        for (const layer of ['waveguide', 'electrode', 'port']) {
          for (const c of solved) {
            if (c.layer === layer && isInPass1(c) && !isBoolOperand(c) && !isBoolComp(c)) pass1.push(c);
          }
        }
        const pass2 = [...solved]
          .filter(c => !isInPass1(c) && !isBoolOperand(c) && !isBoolComp(c))
          .sort((a, b) => stackPriority(a) - stackPriority(b));
        const ordered = [...pass1, ...pass2];
        return ordered.map(c => {
          const w = evalExpr(c.w, paramValues);
          const h = evalExpr(c.h, paramValues);
          const style = layerStyle[c.layer] || layerStyle.waveguide;
          const isSelected = selectedIds.has(c.id);
          const isPrimary = c.id === selectedId;
          const isParent = relatedIds.parents.has(c.id);
          const isChild = relatedIds.children.has(c.id);
          const isMirror = relatedIds.mirrors.has(c.id);
          // Stroke color and width priority: primary-selected > selected >
          // parent > child > mirror > default. Stroke widths are expressed as
          // multiples of `sw` (the viewport-relative stroke unit), so they
          // stay visually proportional at any zoom level. Related-component
          // dashed strokes match the primary halo thickness so the snap
          // network reads as visually unified at any zoom.
          let strokeColor = style.stroke;
          let strokeWidth = sw * 0.5;
          if (isPrimary) { strokeColor = '#0ea5e9'; strokeWidth = HALO_W; }
          else if (isSelected) { strokeColor = '#38bdf8'; strokeWidth = HALO_W * 0.8; }
          else if (isParent) { strokeColor = '#0ea5e9'; strokeWidth = HALO_W; }
          else if (isChild) { strokeColor = '#22d3ee'; strokeWidth = HALO_W; }
          else if (isMirror) { strokeColor = '#a855f7'; strokeWidth = HALO_W; }
          // Dash pattern is also expressed in stroke-units; on a HALO_W-thick
          // line, dash and gap each scale to that thickness so the rhythm
          // stays readable rather than degrading to dots at tight zoom.
          const dashOn = HALO_W * 1.6;
          const dashOff = HALO_W * 1.1;
          // Per-component instances from the transform chain. Length 1 for a
          // comp with no transforms (renders identical to before). For
          // multi-instance comps, all instances share the same compId so a
          // click anywhere selects the base component.
          const instances = instancesByCompId[c.id] || [{
            compId: c.id, idx: 0,
            cx: c.cx, cy: c.cy, w, h, rotation: 0, transformPath: '#0',
          }];
          return (
            <g key={c.id}>
              {instances.map(inst => {
                const isBase = inst.idx === 0;
                // Non-base instances render slightly muted so the base
                // primitive still reads as the "primary" geometry the user
                // can drag.
                const instOpacity = isBase ? style.opacity : (style.opacity * 0.85);
                const rotAttr = inst.rotation ? `rotate(${-inst.rotation} ${inst.cx} ${-inst.cy})` : undefined;
                // Pick the right SVG primitive for this shape. Rect uses
                // <rect> for crisp axis-aligned edges; everything else uses
                // <path> built from a tessellated ring. The ring already
                // accounts for rotation, so we apply rotAttr only for
                // <rect> to keep the path simple.
                let shapeElement;
                const shapeKind = inst.kind || c.kind || 'rect';
                const dataCompProps = {
                  'data-comp-id': c.id,
                  fill: style.fill,
                  stroke: strokeColor,
                  strokeWidth,
                  strokeDasharray: (!isSelected && (isParent || isChild || isMirror)) ? `${dashOn},${dashOff}` : undefined,
                  opacity: instOpacity,
                  style: { cursor: 'move' },
                };
                if (shapeKind === 'circle') {
                  shapeElement = (
                    <circle
                      cx={inst.cx} cy={-inst.cy}
                      r={Number.isFinite(inst.r) ? inst.r : 0}
                      {...dataCompProps}
                    />
                  );
                } else if (shapeKind === 'ellipse') {
                  // SVG <ellipse> uses (rx, ry) in screen coordinates; with
                  // y-down the rx maps to x-axis and ry to y-axis. Rotation
                  // is applied via the surrounding <g transform=>.
                  shapeElement = (
                    <ellipse
                      cx={inst.cx} cy={-inst.cy}
                      rx={Number.isFinite(inst.rx) ? inst.rx : 0}
                      ry={Number.isFinite(inst.ry) ? inst.ry : 0}
                      {...dataCompProps}
                    />
                  );
                } else if (shapeKind === 'polygon') {
                  // Build a <polygon> from the tessellated ring (which
                  // already accounts for any rotation), so we skip rotAttr.
                  const ring = shapeInstanceToRing(inst);
                  const pts = ring.map(([x, y]) => `${x},${-y}`).join(' ');
                  shapeElement = (
                    <polygon points={pts} {...dataCompProps} />
                  );
                } else if (shapeKind === 'racetrack') {
                  // Racetrack waveguide: render the centerline as a closed
                  // SVG <path> stroked at the waveguide width. The browser
                  // handles drawing the band for us, including round joins
                  // at sharp corners (there shouldn't be any, since the
                  // centerline is C¹-continuous through Euler bends, but
                  // round joins are a safe default).
                  const R = Number.isFinite(inst.R) ? inst.R : 100;
                  const Ls = Number.isFinite(inst.L_straight) ? inst.L_straight : 300;
                  const pE = Number.isFinite(inst.p) ? inst.p : 1;
                  const wgW = Number.isFinite(inst.wgWidth) ? inst.wgWidth : 1.2;
                  const centerline = buildRacetrackCenterline(R, Ls, pE);
                  // Apply the instance's rotation about its center via the
                  // xform helper (matches how other shapes' rings are built).
                  const rotRad = (inst.rotation || 0) * Math.PI / 180;
                  const ca2 = Math.cos(rotRad), sa2 = Math.sin(rotRad);
                  const transformed = centerline.map(([lx, ly]) => [
                    inst.cx + lx * ca2 - ly * sa2,
                    inst.cy + lx * sa2 + ly * ca2,
                  ]);
                  if (transformed.length > 0) {
                    let d = `M ${transformed[0][0]} ${-transformed[0][1]}`;
                    for (let k = 1; k < transformed.length; k++) {
                      d += ` L ${transformed[k][0]} ${-transformed[k][1]}`;
                    }
                    d += ' Z'; // close the loop
                    // Stroke = waveguide width; no fill (the band IS the
                    // stroke). Override the standard fill/stroke choice.
                    const { fill: _f, stroke: _s, strokeWidth: _sw, ...restProps } = dataCompProps;
                    shapeElement = (
                      <path
                        d={d}
                        fill="none"
                        stroke={style.fill}
                        strokeWidth={wgW}
                        strokeLinejoin="round"
                        strokeLinecap="butt"
                        {...restProps}
                      />
                    );
                  } else {
                    shapeElement = null;
                  }
                } else {
                  // Rectangle: use <rect> with rotation applied via the
                  // parent <g> for crisp axis-aligned strokes.
                  const ix = inst.cx - inst.w / 2;
                  const iy = -(inst.cy + inst.h / 2);
                  shapeElement = (
                    <rect
                      x={ix} y={iy} width={inst.w} height={inst.h}
                      {...dataCompProps}
                    />
                  );
                }
                // For polygons and racetracks the ring/path already includes
                // rotation; skip double-rotating via the wrapping group.
                const wrapTransform = (shapeKind === 'polygon' || shapeKind === 'racetrack') ? undefined : rotAttr;
                return (
                  <g key={inst.transformPath} transform={wrapTransform}>
                    {shapeElement}
                    {(c.cutouts || []).map((cut, i) => {
                      const cw = evalExpr(cut.w, paramValues);
                      const ch = evalExpr(cut.h, paramValues);
                      const cdx = evalExpr(cut.dx, paramValues);
                      const cdy = evalExpr(cut.dy, paramValues);
                      return (
                        <rect key={i}
                          x={inst.cx + cdx - cw / 2}
                          y={-(inst.cy + cdy + ch / 2)}
                          width={cw} height={ch}
                          fill="#f1f5f9"
                          stroke="#64748b" strokeWidth={sw * 0.4} strokeDasharray={`${sw * 1.5},${sw * 1.5}`}
                          pointerEvents="none"
                        />
                      );
                    })}
                  </g>
                );
              })}
              {isPrimary && (
                <text x={c.cx} y={-c.cy} fontSize={Math.max(2, Math.min(w, h) / 8)} textAnchor="middle" dominantBaseline="middle" fill="#0c4a6e" pointerEvents="none" fontFamily="monospace">
                  {c.id}
                </text>
              )}
              {/* Snap direction indicators on the primary-selected component.
                  For each snap touching this component, draw a small arrow at
                  the relevant anchor pointing along the snap line. Incoming
                  arrows (this comp is the `to`) point INTO this component
                  from the parent — drawn in sky-blue. Outgoing arrows (this
                  comp is the `from`) point OUTWARD toward the child — drawn
                  in cyan. */}
              {isPrimary && (() => {
                const arrowLen = Math.max(viewport.w, viewport.h) * 0.04;
                const arrowHead = arrowLen * 0.45;
                const elements = [];
                for (const s of scene.snaps) {
                  let myAnchor = null, otherCompId = null, otherAnchor = null, isIncoming = false;
                  if (s.to.compId === c.id) {
                    myAnchor = s.to.anchor; otherCompId = s.from.compId; otherAnchor = s.from.anchor; isIncoming = true;
                  } else if (s.from.compId === c.id) {
                    myAnchor = s.from.anchor; otherCompId = s.to.compId; otherAnchor = s.to.anchor; isIncoming = false;
                  } else continue;
                  const otherComp = solved.find(cc => cc.id === otherCompId);
                  if (!otherComp) continue;
                  const myLocal = anchorLocal(myAnchor, w, h);
                  const myWX = c.cx + myLocal.x;
                  const myWY = c.cy + myLocal.y;
                  const otherW = anchorWorld(otherComp, otherAnchor, paramValues);
                  // Direction from my-anchor toward other-anchor.
                  const ddx = otherW.x - myWX;
                  const ddy = otherW.y - myWY;
                  const len = Math.sqrt(ddx * ddx + ddy * ddy);
                  let ux, uy;
                  // Check whether the two component bounding boxes share a
                  // common edge (horizontal or vertical). If so, the arrow
                  // should be orthogonal to that edge — pointing outward from
                  // this component along the perpendicular axis. This gives
                  // a much more readable indicator than anchor-to-anchor
                  // direction (which can be diagonal when the snap is
                  // corner-to-corner) or the local-anchor outward normal
                  // (which is also diagonal for corner anchors).
                  const ow = evalExpr(otherComp.w, paramValues);
                  const oh = evalExpr(otherComp.h, paramValues);
                  const myL = c.cx - w / 2,    myR = c.cx + w / 2;
                  const myB = c.cy - h / 2,    myT = c.cy + h / 2;
                  const oL = otherComp.cx - ow / 2, oR = otherComp.cx + ow / 2;
                  const oB = otherComp.cy - oh / 2, oT = otherComp.cy + oh / 2;
                  // Edge-coincidence tolerance: a tiny fraction of the smaller
                  // dimension, so floating-point noise doesn't fool the test.
                  const tol = Math.max(0.001, 0.001 * Math.min(w, h, ow, oh));
                  const sharesRight = Math.abs(myR - oL) < tol && oT > myB && oB < myT;
                  const sharesLeft  = Math.abs(myL - oR) < tol && oT > myB && oB < myT;
                  const sharesTop   = Math.abs(myT - oB) < tol && oR > myL && oL < myR;
                  const sharesBot   = Math.abs(myB - oT) < tol && oR > myL && oL < myR;
                  if (sharesRight)      { ux =  1; uy =  0; }
                  else if (sharesLeft)  { ux = -1; uy =  0; }
                  else if (sharesTop)   { ux =  0; uy =  1; }
                  else if (sharesBot)   { ux =  0; uy = -1; }
                  else if (len < 1e-6) {
                    // No shared edge AND anchors coincide (galvanic contact at
                    // a point) — fall back to the local outward normal of this
                    // component's anchor. For corner anchors this is diagonal,
                    // which is fine because there's no shared edge to align to.
                    const a = parseAnchor(myAnchor);
                    let nx = 0, ny = 0;
                    if (a.kind === 'edge') {
                      if (a.side === 'T') ny =  1;
                      else if (a.side === 'B') ny = -1;
                      else if (a.side === 'L') nx = -1;
                      else if (a.side === 'R') nx =  1;
                    } else {
                      const n = a.name;
                      if (n.includes('N')) ny =  1;
                      if (n.includes('S')) ny = -1;
                      if (n.includes('E')) nx =  1;
                      if (n.includes('W')) nx = -1;
                    }
                    if (nx === 0 && ny === 0) { nx = 1; ny = 0; } // 'C' anchor → arbitrary +x
                    const nlen = Math.sqrt(nx * nx + ny * ny);
                    ux = nx / nlen; uy = ny / nlen;
                  } else {
                    ux = ddx / len; uy = ddy / len;
                  }
                  // Both incoming and outgoing arrows are drawn POINTING OUTWARD
                  // from this component, with the tail at the anchor and the
                  // tip away from the component along the snap line. The
                  // arrowhead direction encodes the snap direction:
                  //   - outgoing: arrowhead at the FAR end (pointing toward partner)
                  //   - incoming: arrowhead at the NEAR end (pointing toward this comp's anchor)
                  // Both arrows share the same shaft geometry (anchor → outward).
                  const tailX = myWX, tailY = myWY;
                  const tipX = myWX + ux * arrowLen;
                  const tipY = myWY + uy * arrowLen;
                  const headAtTip = !isIncoming;
                  // Arrowhead at tip: standard wedge.
                  const px = -uy, py = ux;
                  const wingSpread = arrowHead * 0.55;
                  let wingPts;
                  if (headAtTip) {
                    const baseX = tipX - ux * arrowHead;
                    const baseY = tipY - uy * arrowHead;
                    wingPts = `${baseX + px * wingSpread},${-(baseY + py * wingSpread)} ${tipX},${-tipY} ${baseX - px * wingSpread},${-(baseY - py * wingSpread)}`;
                  } else {
                    // Head at the anchor end (tail).
                    const baseX = tailX + ux * arrowHead;
                    const baseY = tailY + uy * arrowHead;
                    wingPts = `${baseX + px * wingSpread},${-(baseY + py * wingSpread)} ${tailX},${-tailY} ${baseX - px * wingSpread},${-(baseY - py * wingSpread)}`;
                  }
                  const color = isIncoming ? '#0ea5e9' : '#22d3ee';
                  const shaftPts = `${tailX},${-tailY} ${tipX},${-tipY}`;
                  elements.push(
                    <g key={`arrow_${s.id}_${c.id}`} pointerEvents="none">
                      {/* White outline behind for visibility against any background */}
                      <line
                        x1={tailX} y1={-tailY} x2={tipX} y2={-tipY}
                        stroke="white" strokeWidth={sw * 2.6} strokeLinecap="round" opacity={0.9}
                      />
                      <polygon points={wingPts} fill="white" stroke="white" strokeWidth={sw * 2.6} strokeLinejoin="round" opacity={0.9} />
                      {/* Colored shaft and filled triangle arrowhead on top */}
                      <line
                        x1={tailX} y1={-tailY} x2={tipX} y2={-tipY}
                        stroke={color} strokeWidth={sw * 1.5} strokeLinecap="round"
                      />
                      <polygon points={wingPts} fill={color} stroke={color} strokeWidth={sw * 1.5} strokeLinejoin="round" />
                    </g>
                  );
                  void shaftPts;
                }
                return elements;
              })()}
              {/* Resize handles (only on primary selected) */}
              {isPrimary && ANCHORS.filter(a => a !== 'C').map(a => {
                const local = anchorLocal(a, w, h);
                const ax = c.cx + local.x;
                const ay = -(c.cy + local.y);
                let cursor = 'move';
                if (a === 'NE' || a === 'SW') cursor = 'nesw-resize';
                else if (a === 'NW' || a === 'SE') cursor = 'nwse-resize';
                else if (a === 'N' || a === 'S') cursor = 'ns-resize';
                else if (a === 'E' || a === 'W') cursor = 'ew-resize';
                return (
                  <rect
                    key={'h_' + a}
                    data-resize={`${c.id}|${a}`}
                    x={ax - hr} y={ay - hr} width={hr * 2} height={hr * 2}
                    fill="white" stroke="#0ea5e9" strokeWidth={sw * 0.5}
                    style={{ cursor }}
                  />
                );
              })}
              {/* Snap-mode edge strips: clickable lines on each edge */}
              {snapMode === 'creating' && (() => {
                const edgeStrokeW = Math.max(hr * 0.8, 1);
                // Bounds of the rect in world coordinates
                const x0 = c.cx - w / 2, x1 = c.cx + w / 2;
                const y0 = c.cy - h / 2, y1 = c.cy + h / 2;
                // Figure t from a screen click: use the SVG's CTM via screenToWorld,
                // then map to t along the edge.
                const handleEdgeClick = (side, e) => {
                  e.stopPropagation();
                  const wp = screenToWorld(e.clientX, e.clientY);
                  let t;
                  if (side === 'T' || side === 'B') t = (wp.x - x0) / Math.max(1e-9, w);
                  else                              t = (wp.y - y0) / Math.max(1e-9, h);
                  t = Math.max(0, Math.min(1, t));
                  // Apply Shift axis-lock against first anchor (if picking the second)
                  if (e.shiftKey && snapPick && snapPick.compId !== c.id) {
                    const fromComp = solved.find(cc => cc.id === snapPick.compId);
                    if (fromComp) {
                      const fromW = anchorWorld(fromComp, snapPick.anchor, paramValues);
                      // Solve for t such that the world position of the edge anchor matches
                      // either fromW.x (for T/B edges) or fromW.y (for L/R edges).
                      if (side === 'T' || side === 'B') {
                        const target = (fromW.x - x0) / Math.max(1e-9, w);
                        t = Math.max(0, Math.min(1, target));
                      } else {
                        const target = (fromW.y - y0) / Math.max(1e-9, h);
                        t = Math.max(0, Math.min(1, target));
                      }
                    }
                  }
                  // Round t for cleaner snap names
                  const tRounded = Math.round(t * 1000) / 1000;
                  onAnchorClick(c.id, `${side}:${tRounded}`, e);
                };
                const handleEdgeMove = (side, e) => {
                  const wp = screenToWorld(e.clientX, e.clientY);
                  let t;
                  if (side === 'T' || side === 'B') t = (wp.x - x0) / Math.max(1e-9, w);
                  else                              t = (wp.y - y0) / Math.max(1e-9, h);
                  t = Math.max(0, Math.min(1, t));
                  if (e.shiftKey && snapPick && snapPick.compId !== c.id) {
                    const fromComp = solved.find(cc => cc.id === snapPick.compId);
                    if (fromComp) {
                      const fromW = anchorWorld(fromComp, snapPick.anchor, paramValues);
                      if (side === 'T' || side === 'B') {
                        const target = (fromW.x - x0) / Math.max(1e-9, w);
                        t = Math.max(0, Math.min(1, target));
                      } else {
                        const target = (fromW.y - y0) / Math.max(1e-9, h);
                        t = Math.max(0, Math.min(1, target));
                      }
                    }
                  }
                  const local = anchorLocal(`${side}:${t}`, w, h);
                  setSnapHover({ compId: c.id, side, t, x: c.cx + local.x, y: c.cy + local.y });
                };
                const edges = [
                  { side: 'T', x1v: x0, y1v: y1, x2v: x1, y2v: y1 },
                  { side: 'B', x1v: x0, y1v: y0, x2v: x1, y2v: y0 },
                  { side: 'L', x1v: x0, y1v: y0, x2v: x0, y2v: y1 },
                  { side: 'R', x1v: x1, y1v: y0, x2v: x1, y2v: y1 },
                ];
                return edges.map(eg => (
                  <line
                    key={'edge_' + eg.side}
                    x1={eg.x1v} y1={-eg.y1v} x2={eg.x2v} y2={-eg.y2v}
                    stroke="rgba(245,158,11,0.35)"
                    strokeWidth={edgeStrokeW}
                    strokeLinecap="butt"
                    style={{ cursor: 'crosshair' }}
                    onMouseMove={(e) => handleEdgeMove(eg.side, e)}
                    onMouseLeave={() => setSnapHover(null)}
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={(e) => handleEdgeClick(eg.side, e)}
                  />
                ));
              })()}
              {/* Snap-mode hover preview dot */}
              {snapMode === 'creating' && snapHover && snapHover.compId === c.id && (
                <circle
                  cx={snapHover.x} cy={-snapHover.y} r={hr * 0.9}
                  fill="rgba(245,158,11,0.85)"
                  stroke="white" strokeWidth={0.2}
                  pointerEvents="none"
                />
              )}
              {/* Snap-mode anchors */}
              {snapMode === 'creating' && ANCHORS.map(a => {
                const local = anchorLocal(a, w, h);
                const ax = c.cx + local.x;
                const ay = -(c.cy + local.y);
                const isPicked = snapPick?.compId === c.id && snapPick.anchor === a;
                return (
                  <circle key={'sa_' + a}
                    cx={ax} cy={ay} r={hr * 1.2}
                    fill={isPicked ? '#ef4444' : '#f59e0b'}
                    stroke="white" strokeWidth={0.2}
                    style={{ cursor: 'crosshair' }}
                    onMouseEnter={() => setSnapHover(null)}
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={(e) => { e.stopPropagation(); onAnchorClick(c.id, a, e); }}
                  />
                );
              })}
            </g>
          );
        });
      })()}

      {/* Dimensions overlay: parametric width/height/snap-offset arrows.
          Toggled from the toolbar. Each dimension shows the variable name
          (or expression) primary, and the numeric value if it fits.
          Style is engineering-drawing-like: extension lines from the
          geometry, an arrow line offset perpendicular, end arrows, and a
          centered label on a dark pill so it reads against any background. */}
      {showDimensions && (() => {
        // Heuristic: an expression is "parameter-bound" iff it contains at
        // least one alphabetic identifier. Pure numerics like "20" are not.
        const hasParam = (expr) => typeof expr === 'string' && /[A-Za-z_]/.test(expr);
        const dims = [];
        // Component widths and heights
        for (const c of solved) {
          const w = evalExpr(c.w, paramValues);
          const h = evalExpr(c.h, paramValues);
          if (!Number.isFinite(w) || !Number.isFinite(h)) continue;
          if (hasParam(c.w)) {
            dims.push({
              kind: 'comp_w', compId: c.id,
              p1: { x: c.cx - w / 2, y: c.cy - h / 2 - 0.001 },
              p2: { x: c.cx + w / 2, y: c.cy - h / 2 - 0.001 },
              outwardN: { x: 0, y: -1 }, // dimension below the component
              labelExpr: String(c.w),
              value: w,
            });
          }
          if (hasParam(c.h)) {
            dims.push({
              kind: 'comp_h', compId: c.id,
              p1: { x: c.cx + w / 2 + 0.001, y: c.cy - h / 2 },
              p2: { x: c.cx + w / 2 + 0.001, y: c.cy + h / 2 },
              outwardN: { x: 1, y: 0 }, // dimension to the right
              labelExpr: String(c.h),
              value: h,
            });
          }
        }
        // Snap offsets (dx and dy) when parameter-bound. Drawn between the
        // two anchor points, projected to a single axis (X for dx, Y for dy).
        for (const s of scene.snaps) {
          const fromComp = solved.find(cc => cc.id === s.from.compId);
          const toComp   = solved.find(cc => cc.id === s.to.compId);
          if (!fromComp || !toComp) continue;
          const fromW = anchorWorld(fromComp, s.from.anchor, paramValues);
          const toW   = anchorWorld(toComp,   s.to.anchor,   paramValues);
          if (hasParam(s.dx)) {
            const valDx = evalExpr(s.dx, paramValues);
            // Skip if dx is essentially zero — a zero-length dim is useless
            if (Math.abs(toW.x - fromW.x) > 1e-6) {
              dims.push({
                kind: 'snap_dx', snapId: s.id,
                p1: { x: fromW.x, y: fromW.y },
                p2: { x: toW.x,   y: fromW.y },
                outwardN: { x: 0, y: toW.y >= fromW.y ? -1 : 1 },
                labelExpr: String(s.dx),
                value: valDx,
              });
            }
          }
          if (hasParam(s.dy)) {
            const valDy = evalExpr(s.dy, paramValues);
            if (Math.abs(toW.y - fromW.y) > 1e-6) {
              dims.push({
                kind: 'snap_dy', snapId: s.id,
                p1: { x: toW.x, y: fromW.y },
                p2: { x: toW.x, y: toW.y },
                outwardN: { x: toW.x >= fromW.x ? 1 : -1, y: 0 },
                labelExpr: String(s.dy),
                value: valDy,
              });
            }
          }
        }
        // Geometry constants (in world units, scaled by viewport so they
        // stay legible at any zoom).
        const vScale = Math.max(viewport.w, viewport.h);
        const offsetDist = vScale * 0.025;   // distance from geometry to dim line
        const extOverhang = vScale * 0.005;  // how far ext line passes beyond dim line
        const arrowLen = vScale * 0.012;
        const arrowSpread = vScale * 0.005;
        const fontSize = Math.max(2, vScale * 0.01);
        const labelPadX = fontSize * 0.5;
        const labelPadY = fontSize * 0.3;
        // Estimate character width for label-fits-on-line check.
        const charW = fontSize * 0.6;

        return (
          <g pointerEvents="none">
            {dims.map((d, i) => {
              // Dimension line is parallel to (p1, p2), offset by offsetDist
              // along outwardN. Extension lines go from each endpoint of the
              // geometry edge to slightly beyond the dim line.
              const ox = d.outwardN.x * offsetDist;
              const oy = d.outwardN.y * offsetDist;
              const dimP1 = { x: d.p1.x + ox, y: d.p1.y + oy };
              const dimP2 = { x: d.p2.x + ox, y: d.p2.y + oy };
              // Direction along dim line (unit)
              const lx = dimP2.x - dimP1.x;
              const ly = dimP2.y - dimP1.y;
              const len = Math.sqrt(lx * lx + ly * ly) || 1;
              const ux = lx / len, uy = ly / len;
              // Extension lines: from geometry endpoint to slightly past dim line
              const extEndScale = (offsetDist + extOverhang);
              const ext1 = { x: d.p1.x + d.outwardN.x * extEndScale, y: d.p1.y + d.outwardN.y * extEndScale };
              const ext2 = { x: d.p2.x + d.outwardN.x * extEndScale, y: d.p2.y + d.outwardN.y * extEndScale };
              // Arrowheads at each end of dim line, pointing outward along the line.
              const arrowAt = (tip, dirSign) => {
                // Wing direction: perpendicular to the line.
                const px = -uy, py = ux;
                const baseX = tip.x - dirSign * ux * arrowLen;
                const baseY = tip.y - dirSign * uy * arrowLen;
                return `${baseX + px * arrowSpread},${-(baseY + py * arrowSpread)} ${tip.x},${-tip.y} ${baseX - px * arrowSpread},${-(baseY - py * arrowSpread)}`;
              };
              // Label: variable name first; append "= value" if room.
              const nameLabel = d.labelExpr;
              const valueText = Number.isFinite(d.value) ? `${d.value.toFixed(2)}` : '';
              // Estimate width needed for name vs name + value, in world units.
              const nameW = nameLabel.length * charW;
              const fullW = (nameLabel.length + 3 + valueText.length) * charW;
              // Available width along dim line, minus arrow margins on both sides.
              const avail = len - 2 * arrowLen - 2 * labelPadX;
              const showValue = avail >= fullW;
              const showName = avail >= nameW * 0.6; // allow squeezing slightly
              if (!showName) return null;
              const text = showValue ? `${nameLabel} = ${valueText}` : nameLabel;
              const textW = text.length * charW;
              // Label centered along dim line.
              const mx = (dimP1.x + dimP2.x) / 2;
              const my = (dimP1.y + dimP2.y) / 2;
              return (
                <g key={`dim_${i}_${d.kind}`}>
                  {/* Extension lines */}
                  <line x1={d.p1.x} y1={-d.p1.y} x2={ext1.x} y2={-ext1.y} stroke="#a78bfa" strokeWidth={0.25} opacity={0.85} />
                  <line x1={d.p2.x} y1={-d.p2.y} x2={ext2.x} y2={-ext2.y} stroke="#a78bfa" strokeWidth={0.25} opacity={0.85} />
                  {/* Dim line */}
                  <line x1={dimP1.x} y1={-dimP1.y} x2={dimP2.x} y2={-dimP2.y} stroke="#a78bfa" strokeWidth={0.4} opacity={0.95} />
                  {/* Arrowheads (point outward from line center) */}
                  <polyline points={arrowAt(dimP1, -1)} fill="none" stroke="#a78bfa" strokeWidth={0.4} strokeLinecap="round" strokeLinejoin="round" />
                  <polyline points={arrowAt(dimP2,  1)} fill="none" stroke="#a78bfa" strokeWidth={0.4} strokeLinecap="round" strokeLinejoin="round" />
                  {/* Label pill */}
                  <rect
                    x={mx - textW / 2 - labelPadX}
                    y={-my - fontSize / 2 - labelPadY}
                    width={textW + 2 * labelPadX}
                    height={fontSize + 2 * labelPadY}
                    fill="rgba(15,23,42,0.92)"
                    stroke="#a78bfa"
                    strokeWidth={0.2}
                    rx={fontSize * 0.2}
                  />
                  <text
                    x={mx} y={-my + fontSize * 0.35}
                    fontSize={fontSize}
                    fontFamily="monospace"
                    fill="#ddd6fe"
                    textAnchor="middle"
                  >
                    {showValue ? (
                      <>
                        <tspan fill="#ddd6fe">{nameLabel}</tspan>
                        <tspan fill="#94a3b8"> = {valueText}</tspan>
                      </>
                    ) : (
                      nameLabel
                    )}
                  </text>
                </g>
              );
            })}
          </g>
        );
      })()}

      {/* Add-mode pre-drag hover indicator: show the snap target before
          the drag starts so the user can see what they'd grab if they click. */}
      {addMode && !addDrag && addHoverSnap && addHoverSnap.compId && (
        <g pointerEvents="none">
          <circle cx={addHoverSnap.x} cy={-addHoverSnap.y} r={hr * 0.6}
            fill="#fbbf24" stroke="#f59e0b" strokeWidth={sw * 0.6} />
          <circle cx={addHoverSnap.x} cy={-addHoverSnap.y} r={hr * 1.2}
            fill="none" stroke="#f59e0b" strokeWidth={sw * 0.5} opacity={0.6} />
        </g>
      )}

      {/* Alt-drag snap-target indicator. While the user drags a component
          with Option/Alt held and the cursor is near a target anchor on a
          different component, surface that anchor so the user can see what
          they're about to snap to. On release, a snap is installed (see
          onMouseUp). */}
      {drag && drag.kind === 'move' && moveSnapHover && (
        <g pointerEvents="none">
          <circle cx={moveSnapHover.x} cy={-moveSnapHover.y} r={hr * 0.7}
            fill="#67e8f9" stroke="#0891b2" strokeWidth={sw * 0.6} />
          <circle cx={moveSnapHover.x} cy={-moveSnapHover.y} r={hr * 1.4}
            fill="none" stroke="#0891b2" strokeWidth={sw * 0.5} opacity={0.6} />
        </g>
      )}

      {/* Add-drag preview: live rectangle while user drags to size a new
          component. Snapped corners get a brighter halo so you can see they
          are anchored to existing geometry. Dimension-match labels appear on
          the appropriate sides when the drag size matches an existing
          component's parameter — same logic as commitDragAdd uses. */}
      {addMode && addDrag && (() => {
        const { p1, p2, snapStart, snapEnd } = addDrag;
        const minX = Math.min(p1.x, p2.x);
        const maxX = Math.max(p1.x, p2.x);
        const minY = Math.min(p1.y, p2.y);
        const maxY = Math.max(p1.y, p2.y);
        const w = maxX - minX;
        const h = maxY - minY;
        // Pick fill colour from the addMode layer to give visual context.
        const layer = addMode.layer || addMode.kind || 'waveguide';
        const previewFill = layer === 'waveguide' ? '#3ec27a'
          : layer === 'port' ? '#b91c1c'
          : '#f4a72e';
        const previewStroke = layer === 'waveguide' ? '#1a5e36'
          : layer === 'port' ? '#7f1d1d'
          : '#7a4d00';
        const shape = addMode.shape || 'rect';
        // Probe for dimension matches (mirrors the heuristic in commitDragAdd
        // so the preview matches what will actually be created).
        const TOL = 0.5;
        let wMatchExpr = null, hMatchExpr = null;
        for (const c of scene.components) {
          const cw = evalExpr(c.w, paramValues);
          const ch = evalExpr(c.h, paramValues);
          if (!wMatchExpr && Number.isFinite(cw) && Math.abs(cw - w) < TOL && /[A-Za-z_]/.test(String(c.w))) wMatchExpr = String(c.w);
          if (!hMatchExpr && Number.isFinite(ch) && Math.abs(ch - h) < TOL && /[A-Za-z_]/.test(String(c.h))) hMatchExpr = String(c.h);
          if (wMatchExpr && hMatchExpr) break;
        }
        // Span case: both endpoints snap to DIFFERENT components — width/height
        // become parametric expressions linking the two parents. Indicate this
        // with a label that overrides the dimension-match suggestion.
        const isSpan = !!(snapStart && snapEnd && snapStart.compId !== snapEnd.compId);
        const fontSize = Math.max(2, Math.max(viewport.w, viewport.h) * 0.011);
        const padX = fontSize * 0.5;
        const padY = fontSize * 0.3;
        const charW = fontSize * 0.6;
        const showLabel = (text, mx, my) => {
          const tw = text.length * charW;
          return (
            <g>
              <rect
                x={mx - tw / 2 - padX}
                y={-my - fontSize / 2 - padY}
                width={tw + 2 * padX}
                height={fontSize + 2 * padY}
                fill="rgba(15,23,42,0.92)"
                stroke="#22c55e"
                strokeWidth={0.2}
                rx={fontSize * 0.2}
              />
              <text
                x={mx} y={-my + fontSize * 0.35}
                fontSize={fontSize}
                fontFamily="monospace"
                fill="#86efac"
                textAnchor="middle"
              >
                = {text}
              </text>
            </g>
          );
        };
        const labelOffsetW = Math.max(viewport.w, viewport.h) * 0.025;
        return (
          <g pointerEvents="none">
            {w > 0.001 && h > 0.001 && (() => {
              // Build a shape-specific preview from the drag bbox.
              const previewProps = {
                fill: previewFill, fillOpacity: 0.35,
                stroke: previewStroke, strokeWidth: sw,
                strokeDasharray: `${sw * 3},${sw * 1.5}`,
              };
              const cxP = (minX + maxX) / 2;
              const cyP = (minY + maxY) / 2;
              if (shape === 'circle') {
                // Inscribed circle: radius = min(w, h) / 2 so the circle
                // fits inside the drag bbox.
                const rp = Math.min(w, h) / 2;
                return <circle cx={cxP} cy={-cyP} r={rp} {...previewProps} />;
              }
              if (shape === 'ellipse') {
                return <ellipse cx={cxP} cy={-cyP} rx={w / 2} ry={h / 2} {...previewProps} />;
              }
              if (shape === 'polygon') {
                const nSides = addMode.n || 6;
                const rp = Math.min(w, h) / 2;
                const offset = Math.PI / 2;
                const pts = [];
                for (let i = 0; i < nSides; i++) {
                  const t = offset + (i / nSides) * Math.PI * 2;
                  pts.push(`${cxP + rp * Math.cos(t)},${-(cyP + rp * Math.sin(t))}`);
                }
                return <polygon points={pts.join(' ')} {...previewProps} />;
              }
              // Default: rectangle
              return <rect x={minX} y={-maxY} width={w} height={h} {...previewProps} />;
            })()}
            {/* Width: span case overrides dimension match. */}
            {w > 0.001 && isSpan && showLabel(`w: span ${snapStart.compId} ↔ ${snapEnd.compId}`, (minX + maxX) / 2, maxY + labelOffsetW)}
            {w > 0.001 && !isSpan && wMatchExpr && showLabel(`w: ${wMatchExpr}`, (minX + maxX) / 2, maxY + labelOffsetW)}
            {/* Height: same logic — span overrides dimension match. */}
            {h > 0.001 && isSpan && (() => {
              const text = `h: span ${snapStart.compId} ↔ ${snapEnd.compId}`;
              const tw = (`= ${text}`).length * charW;
              const lx = maxX + labelOffsetW + tw / 2;
              return showLabel(text, lx, (minY + maxY) / 2);
            })()}
            {h > 0.001 && !isSpan && hMatchExpr && (() => {
              const tw = (`= h: ${hMatchExpr}`).length * charW;
              const lx = maxX + labelOffsetW + tw / 2;
              return showLabel(`h: ${hMatchExpr}`, lx, (minY + maxY) / 2);
            })()}
            {/* Endpoint markers: white dot for free, larger amber halo for snapped */}
            <circle cx={p1.x} cy={-p1.y} r={snapStart ? 1.2 : 0.7}
              fill={snapStart ? '#fbbf24' : 'white'}
              stroke={snapStart ? '#f59e0b' : '#0ea5e9'}
              strokeWidth={0.4} />
            {snapStart && (
              <circle cx={p1.x} cy={-p1.y} r={2.2}
                fill="none" stroke="#f59e0b" strokeWidth={0.3} opacity={0.6} />
            )}
            <circle cx={p2.x} cy={-p2.y} r={snapEnd ? 1.2 : 0.7}
              fill={snapEnd ? '#fbbf24' : 'white'}
              stroke={snapEnd ? '#f59e0b' : '#0ea5e9'}
              strokeWidth={0.4} />
            {snapEnd && (
              <circle cx={p2.x} cy={-p2.y} r={2.2}
                fill="none" stroke="#f59e0b" strokeWidth={0.3} opacity={0.6} />
            )}
          </g>
        );
      })()}

      {/* Snap preview line: from first anchor to current cursor or hover position */}
      {snapMode === 'creating' && snapPick && (() => {
        const fromComp = solved.find(c => c.id === snapPick.compId);
        if (!fromComp) return null;
        const fromW = anchorWorld(fromComp, snapPick.anchor, paramValues);
        // Endpoint: hover position if hovering on a different component's edge, else cursor
        let toX, toY, isLocked = false;
        if (snapHover && snapHover.compId !== snapPick.compId) {
          toX = snapHover.x;
          toY = snapHover.y;
          // The hover dot already had Shift applied; if shiftKey is held, mark as locked
          if (shiftKey) isLocked = true;
        } else if (snapCursor) {
          toX = snapCursor.x;
          toY = snapCursor.y;
          if (shiftKey) {
            // Snap cursor to axis-aligned with first anchor (preview only)
            const dx = toX - fromW.x;
            const dy = toY - fromW.y;
            if (Math.abs(dx) < Math.abs(dy)) toX = fromW.x; else toY = fromW.y;
            isLocked = true;
          }
        } else {
          return null;
        }
        const lineColor = isLocked ? '#22d3ee' : '#f59e0b';
        const dxLine = toX - fromW.x;
        const dyLine = toY - fromW.y;
        // dxLine/dyLine remain for status bar wiring even though they're no
        // longer used in this block now that the label moved to the status bar.
        void dxLine; void dyLine;
        return (
          <g pointerEvents="none">
            {/* Connecting line */}
            <line
              x1={fromW.x} y1={-fromW.y}
              x2={toX} y2={-toY}
              stroke={lineColor}
              strokeWidth={sw}
              strokeDasharray={isLocked ? '0' : `${sw * 3},${sw * 1.5}`}
              opacity={0.9}
            />
            {/* First-anchor marker */}
            <circle
              cx={fromW.x} cy={-fromW.y} r={hr * 0.6}
              fill="#ef4444" stroke="white" strokeWidth={sw * 0.5}
            />
            {/* Cursor-end marker */}
            <circle
              cx={toX} cy={-toY} r={hr * 0.5}
              fill={lineColor} stroke="white" strokeWidth={sw * 0.5}
            />
            {/* Distance label is rendered in the bottom status bar instead of
                on the canvas, so it doesn't obscure the line or anchor points. */}
          </g>
        );
      })()}

      {/* Ruler tool: committed measurements */}
      {rulerMeasurements.map(m => {
        const dx = m.p2.x - m.p1.x;
        const dy = m.p2.y - m.p1.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const mx = (m.p1.x + m.p2.x) / 2;
        const my = (m.p1.y + m.p2.y) / 2;
        return (
          <g key={m.id} pointerEvents="none">
            <line
              x1={m.p1.x} y1={-m.p1.y} x2={m.p2.x} y2={-m.p2.y}
              stroke="#22d3ee" strokeWidth={0.5} opacity={0.95}
            />
            <circle cx={m.p1.x} cy={-m.p1.y} r={0.9} fill="#22d3ee" stroke="white" strokeWidth={0.2} />
            <circle cx={m.p2.x} cy={-m.p2.y} r={0.9} fill="#22d3ee" stroke="white" strokeWidth={0.2} />
            {dist > 0.01 && (
              <g>
                <rect x={mx - 11} y={-my - 4.6} width={22} height={4} fill="rgba(15,23,42,0.9)" rx={0.5} />
                <text x={mx} y={-my - 1.4} fontSize={2.6} fontFamily="monospace" fill="#67e8f9" textAnchor="middle">
                  {`${dist.toFixed(2)}um`}
                </text>
                <rect x={mx - 13} y={-my - 0.4} width={26} height={3.2} fill="rgba(15,23,42,0.85)" rx={0.5} />
                <text x={mx} y={-my + 1.95} fontSize={2.1} fontFamily="monospace" fill="#94a3b8" textAnchor="middle">
                  {`Δx=${dx.toFixed(2)} Δy=${dy.toFixed(2)}`}
                </text>
              </g>
            )}
          </g>
        );
      })}

      {/* Ruler tool: in-progress preview line */}
      {rulerMode && rulerInProgress && rulerSnapPoint && (() => {
        const p1 = rulerInProgress.p1;
        // Shift axis-lock: project p2 onto the dominant axis from p1
        let p2 = { x: rulerSnapPoint.x, y: rulerSnapPoint.y };
        if (shiftKey) {
          const rdx = p2.x - p1.x;
          const rdy = p2.y - p1.y;
          if (Math.abs(rdx) > Math.abs(rdy)) p2 = { x: p2.x, y: p1.y };
          else                                p2 = { x: p1.x, y: p2.y };
        }
        return (
          <g pointerEvents="none">
            <line
              x1={p1.x} y1={-p1.y} x2={p2.x} y2={-p2.y}
              stroke="#22d3ee"
              strokeWidth={sw * 0.85}
              strokeDasharray={shiftKey ? '0' : `${sw * 3},${sw * 1.5}`}
              opacity={0.85}
            />
            <circle cx={p1.x} cy={-p1.y} r={hr * 0.45} fill="#22d3ee" stroke="white" strokeWidth={sw * 0.35} />
            <circle cx={p2.x} cy={-p2.y} r={hr * 0.45} fill="#22d3ee" stroke="white" strokeWidth={sw * 0.35} />
            {/* Δx/Δy/dist are shown in the bottom status bar to keep the canvas clear. */}
          </g>
        );
      })()}

      {/* Ruler tool: hover snap-target indicator */}
      {rulerMode && rulerSnapPoint && rulerSnapPoint.label && (
        <g pointerEvents="none">
          <circle
            cx={rulerSnapPoint.x} cy={-rulerSnapPoint.y} r={hr * 0.7}
            fill="none" stroke="#22d3ee" strokeWidth={sw * 0.85}
            opacity={0.9}
          />
          <circle
            cx={rulerSnapPoint.x} cy={-rulerSnapPoint.y} r={hr * 0.25}
            fill="#22d3ee"
          />
        </g>
      )}

      {/* Marquee selection rectangle */}
      {marquee && (() => {
        const x1 = Math.min(marquee.startWorld.x, marquee.currentWorld.x);
        const x2 = Math.max(marquee.startWorld.x, marquee.currentWorld.x);
        const y1 = Math.min(marquee.startWorld.y, marquee.currentWorld.y);
        const y2 = Math.max(marquee.startWorld.y, marquee.currentWorld.y);
        return (
          <rect
            x={x1} y={-y2} width={x2 - x1} height={y2 - y1}
            fill="rgba(14,165,233,0.12)"
            stroke="#0ea5e9"
            strokeWidth={sw * 0.7}
            strokeDasharray={`${sw * 3},${sw * 1.5}`}
            pointerEvents="none"
          />
        );
      })()}

      {scene.snaps.map(s => {
        const fromComp = solved.find(c => c.id === s.from.compId);
        const toComp = solved.find(c => c.id === s.to.compId);
        if (!fromComp || !toComp) return null;
        const fp = anchorWorld(fromComp, s.from.anchor, paramValues);
        const tp = anchorWorld(toComp, s.to.anchor, paramValues);
        const isHot = selectedId && (s.from.compId === selectedId || s.to.compId === selectedId);
        // Snap connection lines: same thickness as the halo (HALO_W) so the
        // selection's relationship lines read as part of the same visual
        // language. Hot lines (touching the primary selection) get the full
        // halo width; cold lines are slightly thinner and faded.
        const snapStrokeW = isHot ? HALO_W : HALO_W * 0.55;
        const snapDashOn  = HALO_W * (isHot ? 1.6 : 1.1);
        const snapDashOff = HALO_W * (isHot ? 1.1 : 1.1);
        return (
          <g key={s.id} pointerEvents="none">
            <line
              x1={fp.x} y1={-fp.y} x2={tp.x} y2={-tp.y}
              stroke="#0ea5e9"
              strokeWidth={snapStrokeW}
              strokeDasharray={`${snapDashOn},${snapDashOff}`}
              opacity={isHot ? 0.95 : 0.4}
            />
            {/* Endpoints marker on hot snaps */}
            {isHot && <>
              <circle cx={fp.x} cy={-fp.y} r={HALO_W * 1.2} fill="#0ea5e9" />
              <circle cx={tp.x} cy={-tp.y} r={HALO_W * 1.2} fill="#0ea5e9" />
            </>}
          </g>
        );
      })}
    </svg>
  );
}

// =========================================================================
// PARAMETER ROW with expression support
// =========================================================================
// =========================================================================
// MODAL DIALOG (replaces window.confirm/prompt which are blocked in iframes)
// =========================================================================
function ModalDialog({ open, title, message, defaultValue, kind, onConfirm, onCancel }) {
  // kind: 'confirm' | 'prompt' | 'alert'
  const [value, setValue] = useState(defaultValue || '');
  const inputRef = useRef(null);
  useEffect(() => { setValue(defaultValue || ''); }, [defaultValue, open]);
  useEffect(() => {
    if (open && kind === 'prompt' && inputRef.current) {
      setTimeout(() => { inputRef.current?.focus(); inputRef.current?.select(); }, 50);
    }
  }, [open, kind]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); onCancel?.(); }
      else if (e.key === 'Enter' && kind !== 'alert') {
        e.preventDefault();
        onConfirm?.(kind === 'prompt' ? value : true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, kind, value, onConfirm, onCancel]);
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(2,6,23,0.7)' }}
      onClick={onCancel}
    >
      <div
        className="rounded-lg border border-slate-700 shadow-2xl w-96 max-w-[90vw]"
        style={{ background: '#0f172a' }}
        onClick={(e) => e.stopPropagation()}
      >
        {title && (
          <div className="px-4 py-2 border-b border-slate-700">
            <h3 className="text-sm font-medium text-slate-200">{title}</h3>
          </div>
        )}
        <div className="px-4 py-3 text-xs text-slate-300 whitespace-pre-wrap leading-relaxed">{message}</div>
        {kind === 'prompt' && (
          <div className="px-4 pb-2">
            <input
              ref={inputRef}
              type="text"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-sm font-mono text-cyan-300 outline-none focus:border-cyan-400"
            />
          </div>
        )}
        <div className="px-4 py-3 border-t border-slate-700 flex justify-end gap-2">
          {kind !== 'alert' && (
            <button onClick={onCancel} className="px-3 py-1 rounded text-xs border border-slate-600 text-slate-300 hover:bg-slate-800">
              Cancel
            </button>
          )}
          <button
            onClick={() => onConfirm?.(kind === 'prompt' ? value : true)}
            className="px-3 py-1 rounded text-xs font-medium"
            style={{ background: '#06b6d4', color: '#0f172a' }}
          >
            {kind === 'alert' ? 'OK' : kind === 'prompt' ? 'OK' : 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  );
}


// =========================================================================
// SNAP CONNECTION ROW (in the inspector "Connections" section)
// Shows a snap's anchors plus its dx/dy values. If dx/dy is a parameter
// reference, the input edits the parameter (so other snaps sharing it follow).
// =========================================================================
function SnapAxisField({ axis, exprValue, params, paramValues, onUpdateSnap, onUpdateParam, onPromote, commitExpr }) {
  // Detect if exprValue is a single parameter reference
  const isParamRef = typeof exprValue === 'string' && /^[A-Za-z_][\w]*$/.test(exprValue.trim()) && !!params[exprValue.trim()];
  const paramName = isParamRef ? exprValue.trim() : null;

  // Two edit buffers: one for the snap field, one for the bound parameter (when expanded)
  const [snapEdit, setSnapEdit] = useState(null);
  const [paramEditing, setParamEditing] = useState(false);
  const [paramEdit, setParamEdit] = useState(null);

  const snapDisplay = snapEdit !== null ? snapEdit : (exprValue ?? '0');
  const paramDisplay = paramEdit !== null ? paramEdit : (isParamRef ? params[paramName].expr : '');
  const computedValue = evalExpr(exprValue, paramValues);

  const commitSnap = () => {
    if (snapEdit === null) return;
    onUpdateSnap({ [axis]: snapEdit });
    if (commitExpr) commitExpr(snapEdit, '0', 'µm', `Auto-created (snap ${axis})`);
    setSnapEdit(null);
  };

  const commitParam = () => {
    if (paramEdit === null || !isParamRef) return;
    onUpdateParam(paramName, paramEdit);
    if (commitExpr) commitExpr(paramEdit, '0', 'µm', `Auto-created (used by ${paramName})`, paramName);
    setParamEdit(null);
  };

  return (
    <div>
      <div className="flex items-center gap-1">
        <span className="text-[9px] text-slate-500 w-3">{axis}</span>
        <input
          value={snapDisplay}
          onChange={(e) => setSnapEdit(e.target.value)}
          onBlur={commitSnap}
          onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); if (e.key === 'Escape') { setSnapEdit(null); e.target.blur(); } }}
          className={`flex-1 min-w-0 bg-slate-900 border rounded px-1 py-0.5 text-[10px] font-mono outline-none ${isParamRef ? 'border-amber-700/60 text-amber-200 focus:border-amber-400' : 'border-slate-700 text-white focus:border-cyan-400'}`}
          title={isParamRef
            ? `References parameter "${paramName}". Type a literal (e.g. 0.5) or another expression to override.`
            : 'Literal/expression — only this snap is affected. Click ⇪ to promote to a new parameter.'}
          spellCheck={false}
        />
        {isParamRef ? (
          <button
            onClick={() => { setParamEditing(v => !v); setParamEdit(null); }}
            className={`text-[9px] w-3 text-center ${paramEditing ? 'text-amber-300' : 'text-amber-500 hover:text-amber-300'}`}
            title={`Edit parameter "${paramName}" inline`}
          >
            {paramName.startsWith('gap_') ? '◆' : '⚙'}
          </button>
        ) : (
          <button
            onClick={onPromote}
            className="text-[9px] text-slate-500 hover:text-amber-400 w-3 text-center"
            title="Promote to a new parameter"
          >
            ⇪
          </button>
        )}
        <span className="text-[9px] text-slate-500 font-mono w-12 text-right truncate" title="resolved value">
          ={Number.isFinite(computedValue) ? computedValue.toFixed(2) : '?'}
        </span>
      </div>
      {/* Inline parameter editor — only visible when bound and expanded */}
      {isParamRef && paramEditing && (
        <div className="flex items-center gap-1 mt-0.5 ml-4">
          <span className="text-[9px] text-amber-500 font-mono">{paramName} =</span>
          <input
            value={paramDisplay}
            onChange={(e) => setParamEdit(e.target.value)}
            onBlur={commitParam}
            onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); if (e.key === 'Escape') { setParamEdit(null); e.target.blur(); } }}
            className="flex-1 min-w-0 bg-slate-900 border border-amber-700/60 rounded px-1 py-0.5 text-[10px] font-mono text-amber-200 outline-none focus:border-amber-400"
            title="Editing this changes the parameter — affects all snaps and components using it"
            spellCheck={false}
          />
        </div>
      )}
    </div>
  );
}

// =========================================================================
// TRANSFORM CHAIN EDITOR (per-component transformation history)
// =========================================================================
// A single row in the transform chain: shows the kind, a toggle for
// suppressing it, parameter inputs that reflect the transform's state,
// reorder up/down, and delete. Each transform contributes parameters that
// commitExpr will auto-create as needed (so typing `dx_pad` in a displace
// transform's dx field creates `dx_pad` in the params list, exactly like
// the snap fields and component dimensions do).
function TransformRow({
  transform, idx, total,
  onUpdate, onToggle, onMoveUp, onMoveDown, onDelete,
  paramValues, commitExpr,
}) {
  const t = transform;
  const enabled = t.enabled !== false;
  // Field renderer: a single labeled expression input. Mirrors the pattern
  // used elsewhere (component w/h, snap dx/dy) so commitExpr auto-creates
  // any missing identifiers.
  const ExprField = ({ label, value, onChange, fieldKey }) => (
    <div className="flex-1 min-w-0">
      <label className="text-[9px] uppercase tracking-wider text-slate-500">{label}</label>
      <input
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
        onBlur={(e) => commitExpr && commitExpr(e.target.value, '0', 'µm', `Auto-created (transform.${fieldKey})`)}
        onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); }}
        className="w-full bg-slate-900 border border-slate-700 rounded px-1.5 py-0.5 text-[11px] font-mono text-white outline-none focus:border-cyan-400"
        spellCheck={false}
      />
      <p className="text-[9px] text-slate-500 mt-0.5 font-mono">= {(() => {
        const v = evalExpr(value, paramValues);
        return Number.isFinite(v) ? v.toFixed(3) : 'NaN';
      })()}</p>
    </div>
  );
  // Style the row dimmer when disabled so it's visually clear it's not in the chain.
  const dimClass = enabled ? '' : 'opacity-50';
  // Pick a kind-specific accent color
  const kindColor = t.kind === 'displace' ? '#0ea5e9'
    : t.kind === 'rotate' ? '#a855f7'
    : t.kind === 'repeat' ? '#22c55e'
    : '#94a3b8';
  return (
    <div className={`rounded border p-1.5 mb-1 ${dimClass}`} style={{ borderColor: kindColor + '60', background: 'rgba(15,23,42,0.4)' }}>
      <div className="flex items-center gap-1 mb-1">
        <span className="text-[9px] font-bold uppercase tracking-wider" style={{ color: kindColor }}>
          {idx + 1}. {t.kind}
        </span>
        <span className="flex-1" />
        <button
          onClick={() => onToggle()}
          className={`px-1 py-0 rounded ${enabled ? 'text-emerald-400 hover:text-emerald-300' : 'text-slate-500 hover:text-slate-300'}`}
          title={enabled ? 'Suppress this transform (toggle off)' : 'Re-enable this transform'}
        >
          {enabled ? <Eye size={11} /> : <EyeOff size={11} />}
        </button>
        <button onClick={() => onMoveUp()} disabled={idx === 0} className="px-1 py-0 text-slate-500 hover:text-cyan-300 disabled:opacity-20" title="Move up (apply earlier)">
          <ArrowUp size={10} />
        </button>
        <button onClick={() => onMoveDown()} disabled={idx === total - 1} className="px-1 py-0 text-slate-500 hover:text-cyan-300 disabled:opacity-20" title="Move down (apply later)">
          <ArrowDown size={10} />
        </button>
        <button onClick={() => onDelete()} className="px-1 py-0 text-slate-500 hover:text-red-400" title="Remove this transform">
          <Trash2 size={10} />
        </button>
      </div>
      {/* Per-kind fields */}
      {t.kind === 'displace' && (
        <div className="flex gap-1.5">
          <ExprField label="dx" value={t.dx} onChange={(v) => onUpdate({ dx: v })} fieldKey="dx" />
          <ExprField label="dy" value={t.dy} onChange={(v) => onUpdate({ dy: v })} fieldKey="dy" />
        </div>
      )}
      {t.kind === 'rotate' && (
        <div className="flex gap-1.5">
          <ExprField label="angle (deg)" value={t.angle} onChange={(v) => onUpdate({ angle: v })} fieldKey="angle" />
          <div className="flex-1 min-w-0">
            <label className="text-[9px] uppercase tracking-wider text-slate-500">pivot</label>
            <select
              value={t.pivot || 'C'}
              onChange={(e) => onUpdate({ pivot: e.target.value })}
              className="w-full bg-slate-900 border border-slate-700 rounded px-1 py-0.5 text-[11px] font-mono text-white outline-none focus:border-cyan-400"
            >
              <option value="C">C (center)</option>
              <option value="N">N</option>
              <option value="S">S</option>
              <option value="E">E</option>
              <option value="W">W</option>
              <option value="NE">NE</option>
              <option value="NW">NW</option>
              <option value="SE">SE</option>
              <option value="SW">SW</option>
              <option value="origin">world origin</option>
            </select>
            <p className="text-[9px] text-slate-500 mt-0.5">about this point</p>
          </div>
        </div>
      )}
      {t.kind === 'repeat' && (
        <div className="space-y-1">
          <div className="flex gap-1.5">
            <ExprField label="N copies" value={t.n} onChange={(v) => onUpdate({ n: v })} fieldKey="n" />
            <ExprField label="dx" value={t.dx} onChange={(v) => onUpdate({ dx: v })} fieldKey="dx" />
            <ExprField label="dy" value={t.dy} onChange={(v) => onUpdate({ dy: v })} fieldKey="dy" />
          </div>
          <label className="flex items-center gap-1 text-[10px] text-slate-400">
            <input type="checkbox" checked={t.includeOriginal !== false} onChange={(e) => onUpdate({ includeOriginal: e.target.checked })} />
            keep the original (uncheck for "shift only")
          </label>
        </div>
      )}
    </div>
  );
}

function TransformChainEditor({ component, onUpdateComp, paramValues, commitExpr }) {
  const transforms = component.transforms || [];
  const setTransforms = (next) => onUpdateComp({ transforms: next });
  const addTransform = (kind) => {
    const id = `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    let t;
    if (kind === 'displace') t = { id, kind, enabled: true, dx: '0', dy: '0' };
    else if (kind === 'rotate') t = { id, kind, enabled: true, angle: '0', pivot: 'C' };
    else if (kind === 'repeat') t = { id, kind, enabled: true, n: '1', dx: '0', dy: '0', includeOriginal: true };
    setTransforms([...transforms, t]);
  };
  const updateTransform = (idx, patch) => {
    setTransforms(transforms.map((t, i) => i === idx ? { ...t, ...patch } : t));
  };
  const moveTransform = (idx, dir) => {
    const j = idx + dir;
    if (j < 0 || j >= transforms.length) return;
    const next = transforms.slice();
    [next[idx], next[j]] = [next[j], next[idx]];
    setTransforms(next);
  };
  const deleteTransform = (idx) => {
    setTransforms(transforms.filter((_, i) => i !== idx));
  };
  return (
    <div className="border-t border-slate-700 pt-3">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[10px] uppercase tracking-wider text-slate-500">Transforms ({transforms.length})</span>
        <div className="flex items-center gap-1">
          <button
            onClick={() => addTransform('displace')}
            className="flex items-center gap-1 px-1.5 py-0.5 rounded border border-slate-600 hover:border-sky-400 text-[10px] text-slate-300 hover:text-sky-300"
            title="Add a displacement transform: shifts the rectangle by (dx, dy)."
          >
            <Move size={10} /> displace
          </button>
          <button
            onClick={() => addTransform('rotate')}
            className="flex items-center gap-1 px-1.5 py-0.5 rounded border border-slate-600 hover:border-violet-400 text-[10px] text-slate-300 hover:text-violet-300"
            title="Add a rotation transform: rotates the rectangle by `angle` degrees about a chosen pivot."
          >
            <RotateCw size={10} /> rotate
          </button>
          <button
            onClick={() => addTransform('repeat')}
            className="flex items-center gap-1 px-1.5 py-0.5 rounded border border-slate-600 hover:border-emerald-400 text-[10px] text-slate-300 hover:text-emerald-300"
            title="Add a repeat-and-union transform: emits N copies along the (dx, dy) vector. The result is N+1 rectangles when 'keep the original' is on."
          >
            <Repeat size={10} /> repeat
          </button>
        </div>
      </div>
      {transforms.length === 0 ? (
        <p className="text-[10px] text-slate-500 italic">No transforms applied. Add one above to displace, rotate, or repeat this rectangle. Transforms apply in order; toggle the eye icon to suppress one without losing its parameters.</p>
      ) : (
        <div>
          {transforms.map((t, i) => (
            <TransformRow
              key={t.id || i}
              transform={t}
              idx={i}
              total={transforms.length}
              onUpdate={(patch) => updateTransform(i, patch)}
              onToggle={() => updateTransform(i, { enabled: t.enabled === false })}
              onMoveUp={() => moveTransform(i, -1)}
              onMoveDown={() => moveTransform(i, +1)}
              onDelete={() => deleteTransform(i)}
              paramValues={paramValues}
              commitExpr={commitExpr}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function SnapConnectionRow({ snap, direction, params, paramValues, onSelectOther, onUpdateSnap, onUpdateParam, onPromoteAxis, onDeleteSnap, commitExpr }) {
  const otherId = direction === 'incoming' ? snap.from.compId : snap.to.compId;
  const arrow = direction === 'incoming' ? '←' : '→';
  return (
    <div className="border border-slate-800 rounded mt-1 mb-1.5 p-1.5" style={{ background: 'rgba(15,23,42,0.5)' }}>
      <div className="flex items-center gap-1 text-[10px] mb-1">
        <span className="text-cyan-400">{arrow}</span>
        <button onClick={() => onSelectOther(otherId)} className="font-mono text-cyan-300 hover:text-cyan-100 truncate">{otherId}</button>
        <span className="text-slate-500 truncate">.{snap.from.anchor}→{snap.to.anchor}</span>
        <button onClick={onDeleteSnap} className="ml-auto text-slate-600 hover:text-red-400" title="break snap"><Link2Off size={10} /></button>
      </div>
      <div className="space-y-0.5">
        <SnapAxisField axis="dx" exprValue={snap.dx} params={params} paramValues={paramValues} onUpdateSnap={onUpdateSnap} onUpdateParam={onUpdateParam} onPromote={() => onPromoteAxis('dx')} commitExpr={commitExpr} />
        <SnapAxisField axis="dy" exprValue={snap.dy} params={params} paramValues={paramValues} onUpdateSnap={onUpdateSnap} onUpdateParam={onUpdateParam} onPromote={() => onPromoteAxis('dy')} commitExpr={commitExpr} />
      </div>
    </div>
  );
}


// =========================================================================
// GROUP TREE ITEM (in the Shapes panel)
// =========================================================================
// =========================================================================
// DROPDOWN MENU (small reusable button-with-options widget)
// =========================================================================
function DropdownMenu({ label, icon: Icon, items, buttonClassName, buttonStyle, disabled, align = 'right' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        disabled={disabled}
        className={buttonClassName}
        style={buttonStyle}
      >
        {Icon ? <Icon size={11} /> : null} {label} <span className="text-[9px] opacity-60">▾</span>
      </button>
      {open && (
        <div
          className={`absolute z-50 mt-1 rounded border border-slate-700 shadow-xl py-1 min-w-[10rem] ${align === 'left' ? 'left-0' : 'right-0'}`}
          style={{ background: '#0f172a' }}
        >
          {items.map((it, i) => {
            if (it.divider) return <div key={i} className="my-1 border-t border-slate-700" />;
            const ItIcon = it.icon;
            return (
              <button
                key={i}
                onClick={() => { setOpen(false); it.onClick?.(); }}
                disabled={it.disabled}
                className="w-full text-left px-3 py-1.5 text-xs text-slate-200 hover:bg-slate-800 disabled:opacity-30 disabled:cursor-not-allowed flex items-center gap-2"
                title={it.title}
              >
                {ItIcon && <ItIcon size={11} className="flex-shrink-0" />}
                <span className="flex-1">{it.label}</span>
                {it.hint && <span className="text-[9px] text-slate-500">{it.hint}</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// =========================================================================
// LAYER CARD (single layer in the LAYERS panel)
// =========================================================================
// =========================================================================
// LIBRARY ITEM ROW (one entry in the library list)
// =========================================================================
// =========================================================================
// WORKSPACE CREATE/SWITCH ROW (free-typed name, used inside the workspace dialog)
// =========================================================================
function WorkspaceCreateRow({ currentWorkspace, onSwitch }) {
  const [draft, setDraft] = useState('');
  const submit = () => {
    if (draft === currentWorkspace) return;
    onSwitch(draft);
    setDraft('');
  };
  return (
    <div className="flex items-center gap-1">
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
        placeholder="workspace name (empty = default)"
        className="flex-1 bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs font-mono text-cyan-300 outline-none focus:border-cyan-400"
        spellCheck={false}
      />
      <button
        onClick={submit}
        className="px-2 py-1 rounded text-xs font-medium"
        style={{ background: '#22c55e', color: '#0f172a' }}
      >
        switch / create
      </button>
    </div>
  );
}

function LibraryItemRow({ name, onInsert, onArchive, onRename }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  useEffect(() => { if (!editing) setDraft(name); }, [name, editing]);
  const commit = () => {
    const trimmed = draft.trim();
    setEditing(false);
    if (trimmed && trimmed !== name) onRename(trimmed);
    else setDraft(name);
  };
  return (
    <div className="rounded border border-slate-700 px-2 py-1.5 flex items-center gap-2" style={{ background: '#1e293b' }}>
      <Package size={11} className="text-cyan-400 flex-shrink-0" />
      {editing ? (
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.target.blur();
            if (e.key === 'Escape') { setDraft(name); setEditing(false); }
          }}
          className="font-mono text-xs flex-1 min-w-0 bg-slate-900 border border-cyan-600 rounded px-1 py-0.5 text-slate-100 outline-none"
          spellCheck={false}
        />
      ) : (
        <span
          className="font-mono text-xs text-slate-200 flex-1 truncate cursor-text hover:text-cyan-200"
          onDoubleClick={() => setEditing(true)}
          title="Double-click to rename"
        >
          {name}
        </span>
      )}
      <button onClick={() => setEditing(true)} className="text-slate-500 hover:text-cyan-400" title="Rename">
        <Pencil size={10} />
      </button>
      <button onClick={onInsert} className="text-[10px] px-2 py-0.5 rounded bg-cyan-700 hover:bg-cyan-600 text-white" title="Insert into scene">
        insert
      </button>
      <button onClick={onArchive} className="text-slate-500 hover:text-amber-400" title="Archive (can be restored later)">
        <Boxes size={11} />
      </button>
    </div>
  );
}

function LayerCard({ layer, idx, scene, paramValues, updateScene, commitExpr, compact }) {
  const updateLayer = (patch) => updateScene(prev => ({
    ...prev,
    stack: prev.stack.map((l, i) => i === idx ? { ...l, ...patch } : l),
  }));
  const deleteLayer = () => updateScene(prev => ({ ...prev, stack: prev.stack.filter((_, i) => i !== idx) }));
  const moveUp = () => updateScene(prev => {
    if (idx >= prev.stack.length - 1) return prev;
    const s = [...prev.stack];
    [s[idx], s[idx + 1]] = [s[idx + 1], s[idx]];
    return { ...prev, stack: s };
  });
  const moveDown = () => updateScene(prev => {
    if (idx <= 0) return prev;
    const s = [...prev.stack];
    [s[idx], s[idx - 1]] = [s[idx - 1], s[idx]];
    return { ...prev, stack: s };
  });

  const thicknessVal = evalExpr(layer.thickness, paramValues);
  const roleColor = {
    substrate: 'text-slate-300',
    waveguide: 'text-emerald-300',
    cladding: 'text-cyan-200',
    conductor: 'text-amber-300',
  }[layer.role] || 'text-slate-300';

  return (
    <div className="rounded border border-slate-700" style={{ background: '#1e293b' }}>
      <div className="flex items-center gap-1 px-2 py-1 border-b border-slate-800">
        <div className="w-3 h-3 rounded-sm flex-shrink-0" style={{ background: layer.color }} />
        <input
          value={layer.name}
          onChange={(e) => updateLayer({ name: e.target.value })}
          className={`bg-transparent font-bold text-[11px] outline-none flex-1 min-w-0 ${roleColor}`}
          spellCheck={false}
        />
        <button onClick={moveUp} disabled={idx === scene.stack.length - 1} className="text-slate-500 hover:text-slate-200 disabled:opacity-20 text-[10px] px-1" title="Move up">▲</button>
        <button onClick={moveDown} disabled={idx === 0} className="text-slate-500 hover:text-slate-200 disabled:opacity-20 text-[10px] px-1" title="Move down">▼</button>
        <button onClick={deleteLayer} className="text-slate-500 hover:text-red-400" title="Delete layer"><Trash2 size={10} /></button>
      </div>
      <div className="px-2 py-1 space-y-1">
        <div className="flex items-center gap-1">
          <label className="text-[9px] text-slate-500 w-16">role</label>
          <select
            value={layer.role}
            onChange={(e) => updateLayer({ role: e.target.value })}
            className="flex-1 bg-slate-900 border border-slate-700 rounded px-1 py-0.5 text-[10px] outline-none focus:border-cyan-400"
          >
            <option value="substrate">substrate</option>
            <option value="waveguide">waveguide</option>
            <option value="cladding">cladding</option>
            <option value="conductor">conductor</option>
          </select>
        </div>
        <div className="flex items-center gap-1">
          <label className="text-[9px] text-slate-500 w-16">thickness</label>
          <input
            value={layer.thickness}
            onChange={(e) => updateLayer({ thickness: e.target.value })}
            onBlur={(e) => commitExpr(e.target.value, '1', 'µm', `Auto-created (layer ${layer.name} thickness)`)}
            onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); }}
            placeholder="expr (e.g. 4.7 or h_sio2)"
            className="flex-1 min-w-0 bg-slate-900 border border-slate-700 rounded px-1 py-0.5 text-[10px] font-mono text-cyan-300 outline-none focus:border-cyan-400"
            spellCheck={false}
          />
          <span className="text-[9px] text-slate-500 font-mono w-12 text-right">
            {Number.isFinite(thicknessVal) ? `${thicknessVal.toFixed(2)}um` : '?'}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <label className="text-[9px] text-slate-500 w-16">material</label>
          <input
            value={layer.material}
            onChange={(e) => updateLayer({ material: e.target.value })}
            placeholder="HFSS material name"
            className="flex-1 bg-slate-900 border border-slate-700 rounded px-1 py-0.5 text-[10px] font-mono text-slate-200 outline-none focus:border-cyan-400"
            spellCheck={false}
          />
        </div>
        <div className="flex items-center gap-1">
          <label className="text-[9px] text-slate-500 w-16">color</label>
          <input
            type="color"
            value={layer.color}
            onChange={(e) => updateLayer({ color: e.target.value })}
            className="w-12 h-5 bg-transparent border border-slate-700 rounded cursor-pointer"
          />
        </div>
        {layer.role === 'waveguide' && (() => {
          const cwVal = evalExpr(layer.core_width, paramValues);
          const shVal = evalExpr(layer.slab_height, paramValues);
          const swVal = evalExpr(layer.slab_width, paramValues);
          const eaVal = evalExpr(layer.etch_angle, paramValues);
          const ref = layer.core_width_ref === 'bottom' ? 'bottom' : 'top';
          return (
            <div className="mt-1 pt-1 border-t border-slate-700 space-y-1">
              <div className="text-[9px] uppercase tracking-wider text-emerald-400/70 font-semibold px-0.5">Rib cross-section</div>
              <div className="flex items-center gap-1">
                <label className="text-[9px] text-slate-500 w-16" title={`Width measured at the ${ref} of the rib`}>
                  core w
                  <button
                    type="button"
                    onClick={() => updateLayer({ core_width_ref: ref === 'top' ? 'bottom' : 'top' })}
                    className="ml-1 text-emerald-400 hover:text-emerald-200 font-bold"
                    title="Toggle whether core_width is measured at the top or bottom of the rib"
                  >
                    {ref === 'top' ? '↑top' : '↓bot'}
                  </button>
                </label>
                <input
                  value={layer.core_width || ''}
                  onChange={(e) => updateLayer({ core_width: e.target.value })}
                  onBlur={(e) => commitExpr(e.target.value, '1', 'µm', `Auto-created (layer ${layer.name} core_width)`)}
                  onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); }}
                  placeholder={`rib ${ref} width`}
                  className="flex-1 min-w-0 bg-slate-900 border border-slate-700 rounded px-1 py-0.5 text-[10px] font-mono text-cyan-300 outline-none focus:border-cyan-400"
                  spellCheck={false}
                />
                <span className="text-[9px] text-slate-500 font-mono w-12 text-right">
                  {Number.isFinite(cwVal) ? `${cwVal.toFixed(2)}um` : '?'}
                </span>
              </div>
              <div className="flex items-center gap-1">
                <label className="text-[9px] text-slate-500 w-16">slab h</label>
                <input
                  value={layer.slab_height || ''}
                  onChange={(e) => updateLayer({ slab_height: e.target.value })}
                  onBlur={(e) => commitExpr(e.target.value, '0.1', 'µm', `Auto-created (layer ${layer.name} slab_height)`)}
                  onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); }}
                  placeholder="unetched slab height"
                  className="flex-1 min-w-0 bg-slate-900 border border-slate-700 rounded px-1 py-0.5 text-[10px] font-mono text-cyan-300 outline-none focus:border-cyan-400"
                  spellCheck={false}
                />
                <span className="text-[9px] text-slate-500 font-mono w-12 text-right">
                  {Number.isFinite(shVal) ? `${shVal.toFixed(2)}um` : '?'}
                </span>
              </div>
              <div className="flex items-center gap-1">
                <label className="text-[9px] text-slate-500 w-16">slab w</label>
                <input
                  value={layer.slab_width || ''}
                  onChange={(e) => updateLayer({ slab_width: e.target.value })}
                  onBlur={(e) => commitExpr(e.target.value, '5', 'µm', `Auto-created (layer ${layer.name} slab_width)`)}
                  onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); }}
                  placeholder="slab width around rib"
                  className="flex-1 min-w-0 bg-slate-900 border border-slate-700 rounded px-1 py-0.5 text-[10px] font-mono text-cyan-300 outline-none focus:border-cyan-400"
                  spellCheck={false}
                />
                <span className="text-[9px] text-slate-500 font-mono w-12 text-right">
                  {Number.isFinite(swVal) ? `${swVal.toFixed(2)}um` : '?'}
                </span>
              </div>
              <div className="flex items-center gap-1">
                <label className="text-[9px] text-slate-500 w-16">etch ang</label>
                <input
                  value={layer.etch_angle || ''}
                  onChange={(e) => updateLayer({ etch_angle: e.target.value })}
                  onBlur={(e) => commitExpr(e.target.value, '70', 'deg', `Auto-created (layer ${layer.name} etch_angle)`)}
                  onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); }}
                  placeholder="degrees from horizontal"
                  className="flex-1 min-w-0 bg-slate-900 border border-slate-700 rounded px-1 py-0.5 text-[10px] font-mono text-cyan-300 outline-none focus:border-cyan-400"
                  spellCheck={false}
                />
                <span className="text-[9px] text-slate-500 font-mono w-12 text-right">
                  {Number.isFinite(eaVal) ? `${eaVal.toFixed(1)}°` : '?'}
                </span>
              </div>
            </div>
          );
        })()}
      </div>
    </div>
  );
}

// =========================================================================
// LEVEL GROUP (a horizontal band of coplanar layers at the same Z)
// =========================================================================
function LevelGroup({ level, scene, paramValues, updateScene, commitExpr }) {
  // Move all layers in this level together within the underlying stack array.
  // direction: +1 to move up (later in array = higher Z), -1 to move down.
  const moveLevel = (direction) => {
    updateScene(prev => {
      const indices = level.layers.map(l => l.idx).sort((a, b) => a - b);
      const blockSize = indices.length;
      const blockStart = indices[0];
      const blockEnd = indices[indices.length - 1];
      const stackLen = prev.stack.length;
      // Verify the block is contiguous in the array (should be, since we group adjacent only)
      for (let i = 0; i < blockSize; i++) {
        if (indices[i] !== blockStart + i) return prev;
      }
      if (direction > 0) {
        // Move up: swap with the layer at blockEnd+1, if any
        if (blockEnd + 1 >= stackLen) return prev;
        const newStack = [...prev.stack];
        const above = newStack.splice(blockEnd + 1, 1)[0];
        newStack.splice(blockStart, 0, above);
        return { ...prev, stack: newStack };
      } else {
        // Move down: swap with the layer at blockStart-1, if any
        if (blockStart - 1 < 0) return prev;
        const newStack = [...prev.stack];
        const below = newStack.splice(blockStart - 1, 1)[0];
        newStack.splice(blockEnd, 0, below);
        return { ...prev, stack: newStack };
      }
    });
  };

  if (level.isDevice && level.layers.length > 1) {
    const blockStart = level.layers[0].idx;
    const blockEnd = level.layers[level.layers.length - 1].idx;
    const canMoveUp = blockEnd < scene.stack.length - 1;
    const canMoveDown = blockStart > 0;
    return (
      <div className="rounded border-2 border-violet-700/40 p-1.5" style={{ background: 'rgba(124,58,237,0.05)' }}>
        <div className="flex items-center justify-between gap-2 mb-1.5 px-1">
          <span className="text-[9px] uppercase tracking-wider text-violet-300 font-semibold">Device level — coplanar</span>
          <span className="text-[9px] text-slate-500 font-mono flex-1">{level.zLabel}</span>
          <button
            onClick={() => moveLevel(1)}
            disabled={!canMoveUp}
            className="text-violet-400 hover:text-violet-200 disabled:opacity-20 text-[10px] px-1"
            title="Move whole device level up"
          >▲</button>
          <button
            onClick={() => moveLevel(-1)}
            disabled={!canMoveDown}
            className="text-violet-400 hover:text-violet-200 disabled:opacity-20 text-[10px] px-1"
            title="Move whole device level down"
          >▼</button>
        </div>
        <div className="grid grid-cols-1 gap-1.5">
          {level.layers.map(({ layer, idx }) => (
            <LayerCard
              key={layer.id}
              layer={layer}
              idx={idx}
              scene={scene}
              paramValues={paramValues}
              updateScene={updateScene}
              commitExpr={commitExpr}
            />
          ))}
        </div>
      </div>
    );
  }
  // Single-layer level — just render the card directly with no extra wrapping
  const { layer, idx } = level.layers[0];
  return (
    <LayerCard
      key={layer.id}
      layer={layer}
      idx={idx}
      scene={scene}
      paramValues={paramValues}
      updateScene={updateScene}
      commitExpr={commitExpr}
    />
  );
}

function GroupTreeItem({ group, components, params, selectedIds, onSelectGroup, onDissolve, onDelete, onRename, renderCompRow }) {
  const [expanded, setExpanded] = useState(true);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(group.name);
  useEffect(() => { setNameDraft(group.name); }, [group.name]);
  const memberComps = group.memberIds.map(id => components.find(c => c.id === id)).filter(Boolean);
  const aliasEntries = Object.entries(group.aliases || {});
  const allSelected = memberComps.length > 0 && memberComps.every(c => selectedIds.has(c.id));

  const commitName = () => {
    const trimmed = nameDraft.trim();
    setEditingName(false);
    if (trimmed && trimmed !== group.name) onRename?.(trimmed);
    else setNameDraft(group.name);
  };

  return (
    <div className={`rounded border ${allSelected ? 'border-violet-500' : 'border-violet-700/40'}`} style={{ background: 'rgba(124,58,237,0.06)' }}>
      <div className="flex items-center justify-between gap-1 px-2 py-1 border-b border-violet-700/30">
        <button onClick={() => setExpanded(e => !e)} className="text-slate-400 hover:text-slate-200 text-xs flex-shrink-0 w-4">
          {expanded ? '▾' : '▸'}
        </button>
        <FolderTree size={11} className="text-violet-400 flex-shrink-0" />
        {editingName ? (
          <input
            autoFocus
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.target.blur();
              if (e.key === 'Escape') { setNameDraft(group.name); setEditingName(false); }
            }}
            className="font-mono font-bold text-[11px] text-violet-100 bg-slate-900 border border-violet-500 rounded px-1 py-0 flex-1 min-w-0 outline-none"
            spellCheck={false}
          />
        ) : (
          <button
            onClick={onSelectGroup}
            onDoubleClick={() => setEditingName(true)}
            className="font-mono font-bold text-[11px] text-violet-300 hover:text-violet-100 flex-1 text-left truncate"
            title="Click to select all members · double-click to rename"
          >
            {group.name}
          </button>
        )}
        <button onClick={() => setEditingName(true)} className="text-slate-500 hover:text-violet-300 text-[10px] px-1" title="Rename group (also renames its parameters)">
          rename
        </button>
        <span className="text-[9px] text-slate-500">{memberComps.length}</span>
        <button onClick={onDissolve} className="text-slate-500 hover:text-amber-400 text-[10px] px-1" title="Ungroup — keep components and parameters, remove only the group">
          ungroup
        </button>
        <button onClick={onDelete} className="text-slate-500 hover:text-red-400" title="Delete group AND all its components">
          <Trash2 size={10} />
        </button>
      </div>
      {expanded && (
        <div className="p-1 space-y-1">
          {memberComps.map(c => renderCompRow(c))}
          {aliasEntries.length > 0 && (
            <div className="mt-1 pt-1 border-t border-violet-700/20">
              <p className="text-[9px] uppercase tracking-wider text-slate-600 px-1 mb-0.5">aliases</p>
              {aliasEntries.map(([orig, aliased]) => (
                <div key={orig} className="flex items-center gap-1 text-[9px] px-1 py-0.5">
                  <span className="font-mono text-amber-300 truncate flex-1" title={`${aliased} = ${params[aliased]?.expr ?? '?'}`}>{aliased}</span>
                  <span className="text-slate-500">←</span>
                  <span className="font-mono text-slate-400 truncate flex-1">{orig}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}


// Lightweight React-controlled hover tooltip. Native HTML `title` on
// <input> elements is unreliable across browsers — sometimes suppressed when
// the input is focused, sometimes ignored when nested in containers with
// their own title. This wrapper renders a small absolute-positioned label
// when the mouse is over the wrapped element, with a short delay to avoid
// flicker. Use sparingly; native title is fine for buttons.
function HoverTooltip({ text, children, side = 'bottom' }) {
  const [show, setShow] = useState(false);
  const timerRef = useRef(null);
  if (!text) return children;
  const onEnter = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setShow(true), 350);
  };
  const onLeave = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    setShow(false);
  };
  return (
    <span
      className="relative inline-flex items-center"
      style={{ minWidth: 0 }}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      {children}
      {show && (
        <span
          className="absolute z-50 pointer-events-none rounded px-2 py-1 text-[11px] font-mono whitespace-pre-wrap break-words shadow-lg border"
          style={{
            background: '#0f172a',
            color: '#e2e8f0',
            borderColor: '#475569',
            maxWidth: '320px',
            ...(side === 'bottom' ? { top: '100%', left: '0', marginTop: '4px' } : { bottom: '100%', left: '0', marginBottom: '4px' }),
          }}
        >
          {text}
        </span>
      )}
    </span>
  );
}

function ParamRow({ name, p, onRename, onUpdateExpr, onCommitExpr, onUpdateUnit, onUpdateDesc, onDelete, value, error, isUnused, isInvolved, autoFocus, onAutoFocusDone }) {
  const [editingName, setEditingName] = useState(name);
  const [expanded, setExpanded] = useState(false);
  const [exprFocused, setExprFocused] = useState(false);
  const inputRef = useRef(null);
  const exprTextareaRef = useRef(null);
  useEffect(() => { setEditingName(name); }, [name]);
  useEffect(() => {
    if (autoFocus && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
      onAutoFocusDone?.();
    }
  }, [autoFocus, onAutoFocusDone]);
  // Auto-grow the expression textarea while it's focused so the user can see
  // the full expression. Resets to single-line height when unfocused.
  useEffect(() => {
    const el = exprTextareaRef.current;
    if (!el || !exprFocused) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [exprFocused, p.expr]);

  // Visual treatment when this parameter is involved in the selected
  // component's definition: cyan border + faint cyan tint, so the row
  // stands out without competing too hard with hover/focus styles.
  const involvedClass = isInvolved && !isUnused ? 'border-cyan-500/70 ring-1 ring-cyan-500/30' : '';
  const involvedStyle = isInvolved && !isUnused ? { background: 'rgba(14,116,144,0.18)' } : undefined;
  const baseClass = isUnused
    ? 'border-amber-700/50 bg-amber-900/10'
    : (involvedClass || 'border-slate-700');
  const baseStyle = isUnused ? undefined : (involvedStyle || { background: '#1e293b' });

  // Tooltip on the parameter NAME: always show the full name (covers the
  // case where the input is too narrow for long identifiers like
  // "cap_sep_outer_signal_finger") plus any description.
  const nameTooltip = p.desc ? `${name}\n${p.desc}` : name;
  // Tooltip on the value/expr: error if any, otherwise resolved value + unit
  // and the full expression (in case the input truncates it visually).
  const exprTooltip = error
    ? error
    : `${name} = ${value?.toFixed?.(4) ?? value}${p.unit ? ' ' + p.unit : ''}\nexpr: ${p.expr}${p.desc ? '\n' + p.desc : ''}`;

  return (
    <div
      className={`rounded border ${baseClass}`}
      style={baseStyle}
      title={isUnused ? 'Unused — not referenced by any expression' : (isInvolved ? `Used by selected component\n${p.desc || ''}`.trim() : undefined)}
    >
      {/* Compact single row */}
      <div className="flex items-center gap-1 px-1.5 py-1">
        {isUnused && <span className="text-amber-500 text-[10px]" title="Unused">○</span>}
        <HoverTooltip text={nameTooltip}>
          <input
            ref={inputRef}
            value={editingName}
            onChange={(e) => setEditingName(e.target.value)}
            onBlur={() => { if (editingName !== name) onRename(name, editingName); }}
            onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); }}
            className="bg-transparent text-[11px] font-mono font-bold text-cyan-300 w-20 min-w-0 outline-none focus:text-cyan-100"
            spellCheck={false}
          />
        </HoverTooltip>
        {/* Expression field: collapsed = single-line input; focused = grown
            textarea spanning the full width on a row beneath the name/value,
            so long expressions are fully visible and editable. */}
        {exprFocused ? (
          <div className="flex-1 min-w-0 relative">
            <textarea
              ref={exprTextareaRef}
              value={p.expr}
              autoFocus
              onChange={(e) => onUpdateExpr(e.target.value)}
              onBlur={(e) => { onCommitExpr && onCommitExpr(e.target.value); setExprFocused(false); }}
              onKeyDown={(e) => {
                // Enter commits and exits (unless Shift held — newline).
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.target.blur(); }
                if (e.key === 'Escape') { e.target.blur(); }
              }}
              className={`w-full bg-slate-900 border rounded px-1.5 py-1 text-[11px] font-mono outline-none resize-none whitespace-pre-wrap break-words ${error ? 'border-red-500 text-red-300' : 'border-cyan-400 text-white'}`}
              spellCheck={false}
              rows={1}
              title={exprTooltip}
            />
          </div>
        ) : (
          <input
            value={p.expr}
            readOnly
            onFocus={() => setExprFocused(true)}
            onMouseDown={(e) => { e.preventDefault(); setExprFocused(true); }}
            className={`flex-1 min-w-0 bg-slate-900 border rounded px-1.5 py-0.5 text-[11px] font-mono outline-none cursor-text ${error ? 'border-red-500 text-red-300' : 'border-slate-700 text-white hover:border-slate-500'}`}
            spellCheck={false}
            title={exprTooltip}
          />
        )}
        <span className="text-[9px] text-slate-500 font-mono w-14 text-right truncate" title={error || ''}>
          {error ? <AlertTriangle size={10} className="text-red-400 inline" /> : `${value?.toFixed?.(2) ?? value}${p.unit ? p.unit : ''}`}
        </span>
        <button
          onClick={() => setExpanded(e => !e)}
          className={`text-slate-500 hover:text-cyan-400 text-[10px] ${expanded ? 'text-cyan-400' : ''}`}
          title="Show description / unit"
        >
          {expanded ? '−' : '…'}
        </button>
        <button onClick={onDelete} className="text-slate-600 hover:text-red-400"><Trash2 size={10} /></button>
      </div>
      {expanded && (
        <div className="flex items-center gap-1 px-1.5 pb-1 pt-0">
          <input
            value={p.unit || ''}
            onChange={(e) => onUpdateUnit(e.target.value)}
            className="bg-slate-900 border border-slate-700 rounded px-1 py-0 text-[10px] text-slate-400 w-12 text-center outline-none"
            placeholder="unit"
          />
          <input
            type="text" placeholder="description"
            value={p.desc || ''}
            onChange={(e) => onUpdateDesc(e.target.value)}
            className="flex-1 bg-slate-900 border border-slate-700 rounded px-1.5 py-0 text-[10px] text-slate-300 outline-none focus:border-cyan-400"
            title={p.desc || ''}
          />
        </div>
      )}
    </div>
  );
}

// =========================================================================
// MAIN APP
// =========================================================================
// ----------------------------------------------------------------------
// PERSISTENT STORAGE (window.storage)
// ----------------------------------------------------------------------
// All app data lives under three prefixes. A "workspace" is a user-chosen
// folder/namespace appended to the base prefix so the user can keep separate
// sets of designs (e.g. "personal", "client-A", "thesis").
//
// Empty workspace ("") = the default namespace, matching pre-workspace storage
// keys so existing saved data remains accessible.
const BASE_DESIGN_PREFIX  = 'photonic_layout:';
const BASE_LIB_PREFIX     = 'photonic_layout_lib:';
const BASE_ARCHIVE_PREFIX = 'photonic_layout_lib_archive:';
// Where we remember the user's currently selected workspace.
const WORKSPACE_KEY = 'photonic_layout::workspace';

function designPrefix(workspace)  { return workspace ? `${BASE_DESIGN_PREFIX}${workspace}:`  : BASE_DESIGN_PREFIX; }
function libPrefix(workspace)     { return workspace ? `${BASE_LIB_PREFIX}${workspace}:`     : BASE_LIB_PREFIX; }
function archivePrefix(workspace) { return workspace ? `${BASE_ARCHIVE_PREFIX}${workspace}:` : BASE_ARCHIVE_PREFIX; }
function activeDesignKey(workspace) { return designPrefix(workspace) + '_active'; }

async function listSavedDesigns(workspace) {
  try {
    const prefix = designPrefix(workspace);
    const result = await window.storage.list(prefix);
    if (!result || !result.keys) return [];
    // For the empty workspace, the list also returns workspace-scoped keys
    // (since they all share the base prefix). Filter those out.
    return result.keys
      .filter(k => k !== activeDesignKey(workspace) && !k.startsWith(prefix + '_'))
      .filter(k => {
        if (workspace) return true;
        // For the default workspace, exclude keys that look like another workspace,
        // i.e. "photonic_layout:<workspace>:..." with a colon in the suffix.
        const suffix = k.slice(prefix.length);
        return !suffix.includes(':');
      })
      .map(k => k.slice(prefix.length));
  } catch { return []; }
}

async function loadDesign(workspace, name) {
  try {
    const r = await window.storage.get(designPrefix(workspace) + name);
    if (!r) return null;
    return JSON.parse(r.value);
  } catch { return null; }
}

async function saveDesign(workspace, name, payload) {
  try {
    await window.storage.set(designPrefix(workspace) + name, JSON.stringify(payload));
    return true;
  } catch { return false; }
}

async function deleteDesignStored(workspace, name) {
  try { await window.storage.delete(designPrefix(workspace) + name); return true; } catch { return false; }
}

async function setActiveDesignName(workspace, name) {
  try { await window.storage.set(activeDesignKey(workspace), JSON.stringify({ name })); } catch {}
}

async function getActiveDesignName(workspace) {
  try {
    const r = await window.storage.get(activeDesignKey(workspace));
    if (!r) return null;
    return JSON.parse(r.value).name;
  } catch { return null; }
}

// Workspace selection persists across sessions (independent of workspace).
async function getStoredWorkspace() {
  try {
    const r = await window.storage.get(WORKSPACE_KEY);
    if (!r) return '';
    return JSON.parse(r.value).name || '';
  } catch { return ''; }
}
async function setStoredWorkspace(name) {
  try { await window.storage.set(WORKSPACE_KEY, JSON.stringify({ name: name || '' })); return true; } catch { return false; }
}

// ----------------------------------------------------------------------
// WORKSPACE ↔ FILE LINKING
// ----------------------------------------------------------------------
// Each workspace can optionally be bound to a JSON file on disk via the File
// System Access API. The browser returns a FileSystemFileHandle which we
// persist in IndexedDB (NOT in window.storage, which is text-only). On every
// successful design save, if the active workspace has a linked handle, we
// ALSO rewrite the entire workspace bundle to that file. This gives the user
// a single source of truth that auto-mirrors browser-side state to disk.
//
// File System Access API is not available in all browsers (Safari, Firefox)
// AND is blocked in cross-origin sandboxed iframes (artifacts viewers,
// embedded previews, etc.). The presence of `showSaveFilePicker` on
// `window` is necessary but NOT sufficient: a sandboxed iframe still
// throws "Cross origin sub frames aren't allowed to show a file picker"
// at call time. We can't detect that ahead of time, so the actual link
// handler tries and catches it, then sets `fsBlockedAtRuntime` so the UI
// reflects the restriction without further user-visible failures.
const fsAccessAPIPresent = typeof window !== 'undefined' && 'showSaveFilePicker' in window;

const HANDLE_DB_NAME = 'photonic_layout_handles';
const HANDLE_STORE   = 'workspace_handles';

function openHandleDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(HANDLE_DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(HANDLE_STORE)) {
        db.createObjectStore(HANDLE_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getWorkspaceHandle(workspace) {
  try {
    const db = await openHandleDB();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(HANDLE_STORE, 'readonly');
      const store = tx.objectStore(HANDLE_STORE);
      const req = store.get(workspace || '__default__');
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch { return null; }
}

async function setWorkspaceHandle(workspace, handle) {
  try {
    const db = await openHandleDB();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(HANDLE_STORE, 'readwrite');
      const store = tx.objectStore(HANDLE_STORE);
      const req = handle == null
        ? store.delete(workspace || '__default__')
        : store.put(handle, workspace || '__default__');
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    });
  } catch { return false; }
}

// Verify (and re-request, if needed) that we can WRITE to the linked handle.
// Browser may revoke the permission across sessions; this re-asks.
async function ensureWritePermission(handle) {
  if (!handle) return false;
  try {
    const opts = { mode: 'readwrite' };
    if ((await handle.queryPermission(opts)) === 'granted') return true;
    if ((await handle.requestPermission(opts)) === 'granted') return true;
    return false;
  } catch { return false; }
}

// Write a workspace bundle (the entire designs/library/archive tree) to a
// FileSystemFileHandle. Returns true on success.
async function writeBundleToHandle(handle, bundle) {
  try {
    const ok = await ensureWritePermission(handle);
    if (!ok) return false;
    const writable = await handle.createWritable();
    await writable.write(JSON.stringify(bundle, null, 2));
    await writable.close();
    return true;
  } catch (e) {
    console.error('writeBundleToHandle error:', e);
    return false;
  }
}

// Discover every workspace that has any data stored. Returns sorted list including ''
// (the default) if it has any keys.
async function discoverWorkspaces() {
  const ws = new Set();
  let hasDefault = false;
  for (const base of [BASE_DESIGN_PREFIX, BASE_LIB_PREFIX, BASE_ARCHIVE_PREFIX]) {
    try {
      const r = await window.storage.list(base);
      if (!r || !r.keys) continue;
      for (const k of r.keys) {
        const suffix = k.slice(base.length);
        const colon = suffix.indexOf(':');
        if (colon === -1) {
          // Default-workspace key (no nested colon)
          if (!suffix.startsWith('_')) hasDefault = true;
        } else {
          ws.add(suffix.slice(0, colon));
        }
      }
    } catch {}
  }
  const out = [...ws].sort();
  if (hasDefault) out.unshift('');
  return out;
}

// ----- Library storage -----
async function listLibraryItems(workspace) {
  try {
    const prefix = libPrefix(workspace);
    const result = await window.storage.list(prefix);
    if (!result || !result.keys) return [];
    return result.keys
      .filter(k => {
        if (workspace) return true;
        const suffix = k.slice(prefix.length);
        return !suffix.includes(':');
      })
      .map(k => k.slice(prefix.length));
  } catch { return []; }
}
async function listArchivedLibraryItems(workspace) {
  try {
    const prefix = archivePrefix(workspace);
    const result = await window.storage.list(prefix);
    if (!result || !result.keys) return [];
    return result.keys
      .filter(k => {
        if (workspace) return true;
        const suffix = k.slice(prefix.length);
        return !suffix.includes(':');
      })
      .map(k => k.slice(prefix.length));
  } catch { return []; }
}
async function loadLibraryItem(workspace, name) {
  try {
    const r = await window.storage.get(libPrefix(workspace) + name);
    if (!r) return null;
    return JSON.parse(r.value);
  } catch { return null; }
}
async function loadArchivedLibraryItem(workspace, name) {
  try {
    const r = await window.storage.get(archivePrefix(workspace) + name);
    if (!r) return null;
    return JSON.parse(r.value);
  } catch { return null; }
}
async function saveLibraryItem(workspace, name, payload) {
  try {
    await window.storage.set(libPrefix(workspace) + name, JSON.stringify(payload));
    return true;
  } catch { return false; }
}
async function saveArchivedLibraryItem(workspace, name, payload) {
  try {
    await window.storage.set(archivePrefix(workspace) + name, JSON.stringify(payload));
    return true;
  } catch { return false; }
}
async function deleteLibraryItem(workspace, name) {
  try { await window.storage.delete(libPrefix(workspace) + name); return true; } catch { return false; }
}
async function deleteArchivedLibraryItem(workspace, name) {
  try { await window.storage.delete(archivePrefix(workspace) + name); return true; } catch { return false; }
}

// ----- Bulk export / import -----
// Snapshot the entire workspace into a serializable bundle. Round-trips through JSON.
async function exportWorkspace(workspace) {
  const designs = {};
  const designNames = await listSavedDesigns(workspace);
  for (const n of designNames) {
    const d = await loadDesign(workspace, n);
    if (d) designs[n] = d;
  }
  const lib = {};
  for (const n of await listLibraryItems(workspace)) {
    const d = await loadLibraryItem(workspace, n);
    if (d) lib[n] = d;
  }
  const archive = {};
  for (const n of await listArchivedLibraryItems(workspace)) {
    const d = await loadArchivedLibraryItem(workspace, n);
    if (d) archive[n] = d;
  }
  return {
    format: 'photonic_layout_workspace',
    version: 1,
    exportedAt: new Date().toISOString(),
    workspace,
    designs,
    library: lib,
    libraryArchive: archive,
  };
}

// Write a bundle into a workspace. mode = 'merge' (skip existing) | 'overwrite' | 'replace' (wipe first).
// Returns counts and a list of skipped names.
async function importWorkspace(workspace, bundle, mode) {
  if (!bundle || bundle.format !== 'photonic_layout_workspace') {
    throw new Error('Not a workspace bundle (missing or wrong "format" field)');
  }
  const counts = { designs: 0, library: 0, archive: 0, skipped: [] };
  if (mode === 'replace') {
    for (const n of await listSavedDesigns(workspace)) await deleteDesignStored(workspace, n);
    for (const n of await listLibraryItems(workspace)) await deleteLibraryItem(workspace, n);
    for (const n of await listArchivedLibraryItems(workspace)) await deleteArchivedLibraryItem(workspace, n);
  }
  const existingDesigns = new Set(await listSavedDesigns(workspace));
  const existingLib = new Set(await listLibraryItems(workspace));
  const existingArch = new Set(await listArchivedLibraryItems(workspace));
  for (const [n, payload] of Object.entries(bundle.designs || {})) {
    if (mode === 'merge' && existingDesigns.has(n)) { counts.skipped.push(`design:${n}`); continue; }
    if (await saveDesign(workspace, n, payload)) counts.designs++;
  }
  for (const [n, payload] of Object.entries(bundle.library || {})) {
    if (mode === 'merge' && existingLib.has(n)) { counts.skipped.push(`library:${n}`); continue; }
    if (await saveLibraryItem(workspace, n, payload)) counts.library++;
  }
  for (const [n, payload] of Object.entries(bundle.libraryArchive || {})) {
    if (mode === 'merge' && existingArch.has(n)) { counts.skipped.push(`archive:${n}`); continue; }
    if (await saveArchivedLibraryItem(workspace, n, payload)) counts.archive++;
  }
  return counts;
}

export default function App() {
  const [scene, setScene] = useState(makeDefaultScene);
  // On mount, ensure the active scene is normalized — older sessions may have a scene
  // that predates the current normalizeScene rules (e.g., missing conductor layer).
  useEffect(() => {
    setScene(prev => {
      const next = normalizeScene(prev);
      // Cheap structural check: if normalize added/changed anything, return the new one.
      if (next.stack.length !== prev.stack.length) return next;
      return prev;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Selection: ids = Set of selected component ids; primary = the "focus" used by the inspector
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [selectedId, setSelectedId] = useState(null); // primary
  const setSelection = useCallback(({ ids, primary }) => {
    setSelectedIds(ids);
    setSelectedId(primary);
  }, []);

  const [viewport, setViewport] = useState({ x: 0, y: 0, w: 400, h: 280 });
  const [snapMode, setSnapMode] = useState('idle');
  const [rulerMode, setRulerMode] = useState(false);
  // Ruler measurements: [{ id, p1: {x,y}, p2: {x,y} }]; the in-progress measurement uses p2 = null
  const [rulerMeasurements, setRulerMeasurements] = useState([]);
  const [rulerInProgress, setRulerInProgress] = useState(null); // { p1: {x,y} } when first point is picked
  const [rulerSnapPoint, setRulerSnapPoint] = useState(null); // { x, y, label } – current snap target
  // Live readout for the bottom status bar: shows snap/ruler progress (Δx, Δy,
  // distance) without putting a label on the canvas where it would obscure the
  // line and anchors. Canvas writes this; App renders it.
  const [interactionStatus, setInteractionStatus] = useState(null); // { kind, line: string }
  const [activePanel, setActivePanel] = useState('params');
  // Tracks which object rows in the SHAPES tree are currently expanded.
  // Each entry is a component id or group id. Expansion state is purely
  // a UI concern, so we keep it in App state (not in scene). Resets to
  // a sane default when scene loads (top-level objects collapsed).
  const [expandedTreeNodes, setExpandedTreeNodes] = useState(new Set());
  const toggleTreeNode = (id) => {
    setExpandedTreeNodes(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const [history, setHistory] = useState([]); // past scenes
  const [future, setFuture] = useState([]); // redo stack
  const [gridSize, setGridSize] = useState(2);
  const [gridSnapEnabled, setGridSnapEnabled] = useState(true);
  // Dimension overlay: when on, draws engineering-style dimension arrows over
  // every parameter-bound width/height/snap-offset. Variable name is the
  // primary label; numeric value is appended only if there's room.
  const [showDimensions, setShowDimensions] = useState(false);
  // Add-component mode. Set by clicking a shape button in the toolbar.
  // Drives a drag-to-create interaction in Canvas: the next click+drag
  // creates a new shape of the chosen kind on the chosen layer.
  // Shape: null | { layer: 'waveguide'|'electrode'|'port', shape: 'rect'|'circle'|'ellipse'|'polygon', n?: number, conductorLayerId?: string }
  // The legacy `kind` field is kept as a fallback for any code that still
  // reads it.
  const [addMode, setAddMode] = useState(null);
  // Active layer choice for the shape buttons in the toolbar. Persists
  // across button clicks so the user can quickly add several shapes to
  // the same layer.
  const [activeLayer, setActiveLayer] = useState('waveguide');
  // Active conductor layer (used when activeLayer === 'electrode' and the
  // stack defines one or more conductor layers).
  const [activeConductorLayerId, setActiveConductorLayerId] = useState(null);
  // Default polygon side count for the "+ Polygon" button.
  const [polygonSides, setPolygonSides] = useState(6);
  // Whenever the stack changes, make sure activeConductorLayerId points at
  // an existing conductor layer (or the first one if none was set yet).
  useEffect(() => {
    const conductors = (scene.stack || []).filter(l => l.role === 'conductor');
    if (conductors.length === 0) {
      if (activeConductorLayerId !== null) setActiveConductorLayerId(null);
      return;
    }
    if (!conductors.some(l => l.id === activeConductorLayerId)) {
      setActiveConductorLayerId(conductors[0].id);
    }
  }, [scene.stack, activeConductorLayerId]);

  // Saved designs
  const [designName, setDesignName] = useState('Untitled');
  const [savedList, setSavedList] = useState([]);
  const [showDesigns, setShowDesigns] = useState(false);
  const [saveStatus, setSaveStatus] = useState(''); // 'saved', 'saving', 'unsaved'
  const [clipboard, setClipboard] = useState(null); // { components, snaps }
  // Holds a reference to createBoolean (defined later). Keyboard-shortcut
  // effects need the function but are wired up earlier in the component
  // body, so we defer the resolution to call-time via this ref. Updated
  // by an effect below once createBoolean exists.
  const createBooleanRef = useRef(null);
  const [exportPreview, setExportPreview] = useState(null); // { filename, content, downloaded }
  // Workspace = which "folder" of designs+library we're using. Empty string is the default folder.
  const [workspace, setWorkspace] = useState('');
  const [workspaceLoaded, setWorkspaceLoaded] = useState(false);
  const [knownWorkspaces, setKnownWorkspaces] = useState([]);
  const [showWorkspaceDialog, setShowWorkspaceDialog] = useState(false);
  // File-link state: a FileSystemFileHandle persisted for the active workspace.
  // When set, every successful design save also rewrites the workspace bundle
  // to that file. `workspaceFileLabel` is a friendly label shown in the UI
  // (the file's `name` since browsers don't expose absolute paths).
  const [workspaceHandle, setWorkspaceHandle] = useState(null);
  const [workspaceFileLabel, setWorkspaceFileLabel] = useState('');
  // True when the File System Access API is present BUT a runtime call has
  // failed because the page is hosted in a cross-origin sandboxed iframe
  // (e.g., artifact preview). In that case the picker can never open and the
  // UI should reflect this, even though the API exists on `window`.
  const [fsBlockedAtRuntime, setFsBlockedAtRuntime] = useState(false);
  const fsLinkAvailable = fsAccessAPIPresent && !fsBlockedAtRuntime;
  // Reload the linked handle whenever the active workspace changes.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const h = await getWorkspaceHandle(workspace);
      if (cancelled) return;
      setWorkspaceHandle(h || null);
      setWorkspaceFileLabel(h?.name || '');
    })();
    return () => { cancelled = true; };
  }, [workspace]);
  // Library state
  const [libraryItems, setLibraryItems] = useState([]); // names
  const [archivedLibraryItems, setArchivedLibraryItems] = useState([]); // names
  const [showArchive, setShowArchive] = useState(false);
  const refreshLibrary = useCallback(async () => {
    const [active, archived] = await Promise.all([listLibraryItems(workspace), listArchivedLibraryItems(workspace)]);
    setLibraryItems(active.sort());
    setArchivedLibraryItems(archived.sort());
  }, [workspace]);
  useEffect(() => { refreshLibrary(); }, [refreshLibrary]);

  // Load the user's last-used workspace once at mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const ws = await getStoredWorkspace();
      if (!cancelled) {
        setWorkspace(ws);
        setWorkspaceLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Refresh known-workspaces list on every workspace switch.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const list = await discoverWorkspaces();
      if (!cancelled) setKnownWorkspaces(list);
    })();
    return () => { cancelled = true; };
  }, [workspace, savedList, libraryItems]);

  // Dialog state — replaces window.confirm/prompt/alert which are blocked in iframes
  const [dialog, setDialog] = useState(null);
  // Helpers that return a Promise: const ok = await confirmDialog('Sure?')
  const confirmDialog = useCallback((message, title) => new Promise((resolve) => {
    setDialog({
      kind: 'confirm', title: title || 'Confirm', message,
      onConfirm: () => { setDialog(null); resolve(true); },
      onCancel: () => { setDialog(null); resolve(false); },
    });
  }), []);
  const promptDialog = useCallback((message, defaultValue, title) => new Promise((resolve) => {
    setDialog({
      kind: 'prompt', title: title || 'Input', message, defaultValue,
      onConfirm: (val) => { setDialog(null); resolve(val); },
      onCancel: () => { setDialog(null); resolve(null); },
    });
  }), []);
  const alertDialog = useCallback((message, title) => new Promise((resolve) => {
    setDialog({
      kind: 'alert', title: title || 'Notice', message,
      onConfirm: () => { setDialog(null); resolve(); },
      onCancel: () => { setDialog(null); resolve(); },
    });
  }), []);

  const refreshSavedList = useCallback(async () => {
    const list = await listSavedDesigns(workspace);
    setSavedList(list.sort());
  }, [workspace]);

  // On every workspace change (including the initial load): repopulate saved list,
  // load the active design for that workspace.
  useEffect(() => {
    if (!workspaceLoaded) return;
    (async () => {
      await refreshSavedList();
      const activeName = await getActiveDesignName(workspace);
      if (activeName) {
        const d = await loadDesign(workspace, activeName);
        if (d) {
          setScene(normalizeScene(d.scene));
          setHistory(d.history || []);
          setFuture(d.future || []);
          setDesignName(activeName);
          setSaveStatus('saved');
          return;
        }
      }
      // No active design saved in this workspace — start fresh
      setScene(normalizeScene(makeDefaultScene()));
      setHistory([]);
      setFuture([]);
      setDesignName('Untitled');
      setSaveStatus('');
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace, workspaceLoaded]);

  // Two-pass parameter resolution.
  //
  // Pass 1: resolve scene.params naïvely (no synthetics). Span-dimension
  //         params reference `_comp_<id>_cx/cy` which aren't real params, so
  //         they fail to resolve and get value 0 with an error. That's OK —
  //         we won't actually USE these values directly; they get overridden
  //         in pass 2.
  // Pass 2: solve layout using pass-1 paramValues. solveLayout internally
  //         injects `_comp_<id>_cx/cy` into a working paramValues as each
  //         component is placed, so span widths/heights resolve correctly
  //         within the solver. Then we use the solved positions to build
  //         synthetic paramValues, and re-resolve scene.params with these
  //         synthetics available. Now span params get their real values.
  // Pass 3: re-solve with the corrected paramValues to get final positions.
  //
  // The result `paramValues` contains both regular params and the synthetic
  // `_comp_<id>_cx/cy` entries, ready for use everywhere downstream.
  const { values: paramValues, errors: paramErrors } = useMemo(() => {
    const pass1 = resolveParams(scene.params);
    // Compute solved positions using pass-1 values; solver itself uses
    // workingPV-with-synthetics so span widths still work.
    const solvedPass1 = applyMirrors(solveLayout(scene.components, scene.snaps, pass1.values), scene.mirrors);
    const synthetics = {};
    for (const c of solvedPass1) {
      synthetics[`_comp_${c.id}_cx`] = c.cx;
      synthetics[`_comp_${c.id}_cy`] = c.cy;
      // _w / _h synthetics let span expressions read each parent's resolved
      // width/height directly, instead of embedding the parent's width
      // EXPRESSION text. Critical when a parent's width itself is an
      // expression like "cap_sep/2 - port_L/2" — the span needs the
      // current numeric value, not the expression literal.
      synthetics[`_comp_${c.id}_w`] = evalExpr(c.w, { ...pass1.values, ...synthetics });
      synthetics[`_comp_${c.id}_h`] = evalExpr(c.h, { ...pass1.values, ...synthetics });
    }
    // Re-resolve params with synthetics available, so span dimension
    // expressions get correct values now.
    const pass2 = resolveParams(scene.params, synthetics);
    return { values: { ...pass2.values, ...synthetics }, errors: pass2.errors };
  }, [scene.params, scene.components, scene.snaps, scene.mirrors]);

  const selected = scene.components.find(c => c.id === selectedId);
  const selectedHasIncoming = selected ? scene.snaps.some(s => s.to.compId === selected.id) : false;

  // Undo checkpointing: only commit a snapshot to history once per ~2s of continuous edits.
  // pendingCheckpointRef holds the scene as it was at the start of the current edit window.
  // checkpointTimerRef holds the timer that will commit it.
  const pendingCheckpointRef = useRef(null);
  const checkpointTimerRef = useRef(null);
  const CHECKPOINT_DELAY_MS = 2000;

  const updateScene = useCallback((updater) => {
    setScene(prev => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      // If we don't have a pending checkpoint yet, capture `prev` as the rollback point.
      if (pendingCheckpointRef.current === null) {
        pendingCheckpointRef.current = prev;
      }
      // Reset the commit timer
      if (checkpointTimerRef.current) clearTimeout(checkpointTimerRef.current);
      checkpointTimerRef.current = setTimeout(() => {
        // No edits for CHECKPOINT_DELAY_MS — commit the pending pre-edit state as a history entry
        const snapshot = pendingCheckpointRef.current;
        pendingCheckpointRef.current = null;
        checkpointTimerRef.current = null;
        if (snapshot !== null) {
          setHistory(h => [...h.slice(-49), snapshot]);
        }
      }, CHECKPOINT_DELAY_MS);
      return next;
    });
    setFuture([]); // any new edit clears redo
    setSaveStatus('unsaved');
  }, []);

  // Force-flush helper: if you undo or redo while a checkpoint is pending, commit it first
  // so the user can roll back to the pre-edit state correctly.
  const flushCheckpoint = useCallback(() => {
    if (checkpointTimerRef.current) {
      clearTimeout(checkpointTimerRef.current);
      checkpointTimerRef.current = null;
    }
    if (pendingCheckpointRef.current !== null) {
      const snapshot = pendingCheckpointRef.current;
      pendingCheckpointRef.current = null;
      setHistory(h => [...h.slice(-49), snapshot]);
    }
  }, []);

  const undo = () => {
    // First, flush any pending checkpoint so the latest edit window is rollback-able
    flushCheckpoint();
    setHistory(h => {
      if (h.length === 0) return h;
      const prev = h[h.length - 1];
      setFuture(f => [scene, ...f].slice(0, 50));
      setScene(prev);
      setSaveStatus('unsaved');
      return h.slice(0, -1);
    });
  };

  const redo = () => {
    flushCheckpoint();
    setFuture(f => {
      if (f.length === 0) return f;
      const next = f[0];
      setHistory(h => [...h, scene].slice(-50));
      setScene(next);
      setSaveStatus('unsaved');
      return f.slice(1);
    });
  };

  // Mirror the entire workspace to its linked file (if any). Called after
  // every successful save. Runs silently — failures don't block the save UI.
  const mirrorWorkspaceToFileIfLinked = useCallback(async () => {
    if (!workspaceHandle) return;
    try {
      const bundle = await exportWorkspace(workspace);
      const ok = await writeBundleToHandle(workspaceHandle, bundle);
      if (!ok) {
        // The handle exists but write failed — likely permission revoked
        // or the user moved the file. Surface a non-blocking warning.
        console.warn('Linked workspace file is unwritable; the link may need to be re-established.');
      }
    } catch (e) {
      console.warn('Workspace mirror failed:', e);
    }
  }, [workspace, workspaceHandle]);

  // ----- Design management -----
  const handleSave = useCallback(async () => {
    setSaveStatus('saving');
    const ok = await saveDesign(workspace, designName, { scene, history, future, updatedAt: Date.now() });
    if (ok) {
      await setActiveDesignName(workspace, designName);
      await refreshSavedList();
      setSaveStatus('saved');
      mirrorWorkspaceToFileIfLinked();
    } else {
      setSaveStatus('unsaved');
      await alertDialog('Save failed.', 'Error');
    }
  }, [workspace, designName, scene, history, future, refreshSavedList, alertDialog, mirrorWorkspaceToFileIfLinked]);

  const handleSaveAs = useCallback(async () => {
    const name = await promptDialog('Save as new design name:', designName + ' copy', 'Save As');
    if (!name || !name.trim()) return;
    const trimmed = name.trim();
    if (savedList.includes(trimmed)) {
      const ok = await confirmDialog(`"${trimmed}" already exists. Overwrite?`, 'Overwrite design');
      if (!ok) return;
    }
    setSaveStatus('saving');
    const ok = await saveDesign(workspace, trimmed, { scene, history, future, updatedAt: Date.now() });
    if (ok) {
      setDesignName(trimmed);
      await setActiveDesignName(workspace, trimmed);
      await refreshSavedList();
      setSaveStatus('saved');
      mirrorWorkspaceToFileIfLinked();
    } else {
      setSaveStatus('unsaved');
      await alertDialog('Save As failed.', 'Error');
    }
  }, [workspace, designName, scene, history, future, savedList, refreshSavedList, promptDialog, confirmDialog, alertDialog, mirrorWorkspaceToFileIfLinked]);


  const handleNew = useCallback(async () => {
    if (saveStatus === 'unsaved') {
      const ok = await confirmDialog('Discard unsaved changes and start a new design?', 'New design');
      if (!ok) return;
    }
    const name = await promptDialog('New design name:', 'Untitled', 'New design');
    if (!name || !name.trim()) return;
    const fresh = makeDefaultScene();
    setScene(fresh);
    setHistory([]);
    setFuture([]);
    setSelection({ ids: new Set(), primary: null });
    setDesignName(name.trim());
    await setActiveDesignName(workspace, name.trim());
    setSaveStatus('unsaved');
  }, [workspace, saveStatus, setSelection, confirmDialog, promptDialog]);

  // New BLANK design: completely empty scene (no default ring/electrode
  // example), but keep the default layer stack so add-tools work without
  // setup. Offers to save the current design first if it has unsaved
  // changes — saving uses the current name (or prompts for one if it's
  // still "Untitled"). If the user declines to save, we still proceed.
  const handleNewBlank = useCallback(async () => {
    if (saveStatus === 'unsaved') {
      const action = await promptDialog(
        'Save current design first?\n\nType "yes" to save it, "no" to discard, or cancel.',
        'yes',
        'New blank design'
      );
      if (action === null) return; // cancelled
      const ans = (action || '').trim().toLowerCase();
      if (ans === 'yes' || ans === 'y') {
        // Save current design under its current name. If unnamed, prompt.
        let nameToSave = designName;
        if (!nameToSave || !nameToSave.trim() || nameToSave.trim() === 'Untitled') {
          const proposed = await promptDialog('Save current design as:', designName || 'Untitled', 'Save current');
          if (!proposed || !proposed.trim()) return;
          nameToSave = proposed.trim();
        }
        const payload = { scene, history, future, savedAt: Date.now() };
        const ok = await saveDesign(workspace, nameToSave, payload);
        if (!ok) {
          await alertDialog('Failed to save current design. Aborting.', 'Save error');
          return;
        }
      } else if (ans !== 'no' && ans !== 'n') {
        // Anything other than yes/no — treat as cancel for safety.
        return;
      }
    }
    const name = await promptDialog('New blank design name:', 'Untitled', 'New blank design');
    if (!name || !name.trim()) return;
    const fresh = makeBlankScene();
    setScene(fresh);
    setHistory([]);
    setFuture([]);
    setSelection({ ids: new Set(), primary: null });
    setDesignName(name.trim());
    await setActiveDesignName(workspace, name.trim());
    setSaveStatus('unsaved');
  }, [workspace, saveStatus, designName, scene, history, future, setSelection, alertDialog, confirmDialog, promptDialog]);

  const handleLoad = useCallback(async (name) => {
    if (saveStatus === 'unsaved') {
      const ok = await confirmDialog('Discard unsaved changes and load "' + name + '"?', 'Load design');
      if (!ok) return;
    }
    const d = await loadDesign(workspace, name);
    if (!d) { await alertDialog('Failed to load.', 'Error'); return; }
    setScene(normalizeScene(d.scene));
    setHistory(d.history || []);
    setFuture(d.future || []);
    setSelection({ ids: new Set(), primary: null });
    setDesignName(name);
    await setActiveDesignName(workspace, name);
    setSaveStatus('saved');
  }, [workspace, saveStatus, setSelection, confirmDialog, alertDialog]);

  const handleDeleteDesign = useCallback(async (name) => {
    const ok = await confirmDialog(`Delete "${name}"? This cannot be undone.`, 'Delete design');
    if (!ok) return;
    await deleteDesignStored(workspace, name);
    await refreshSavedList();
    if (name === designName) {
      // Stayed on the now-deleted design. Mark as unsaved so user can re-save under a new name.
      setSaveStatus('unsaved');
    }
  }, [workspace, designName, refreshSavedList, confirmDialog]);

  const handleRenameDesign = useCallback(async (oldName, newName) => {
    if (!newName || !newName.trim() || newName === oldName) return;
    const trimmed = newName.trim();
    if (savedList.includes(trimmed)) { await alertDialog('A design with that name already exists.', 'Rename failed'); return; }
    const d = await loadDesign(workspace, oldName);
    if (!d) return;
    await saveDesign(workspace, trimmed, d);
    await deleteDesignStored(workspace, oldName);
    if (designName === oldName) {
      setDesignName(trimmed);
      await setActiveDesignName(workspace, trimmed);
    }
    await refreshSavedList();
  }, [workspace, savedList, designName, refreshSavedList, alertDialog]);

  // ----- Copy / Paste -----
  const handleCopy = useCallback(() => {
    if (selectedIds.size === 0) return;
    const ids = selectedIds;
    const components = scene.components
      .filter(c => ids.has(c.id))
      .map(c => ({ ...c, cutouts: (c.cutouts || []).map(cu => ({ ...cu })) }));
    // Internal snaps: both endpoints in the selection
    const snaps = scene.snaps
      .filter(s => ids.has(s.from.compId) && ids.has(s.to.compId))
      .map(s => ({ ...s }));
    setClipboard({ components, snaps });
    setSaveStatus(s => s); // no-op, just to indicate user feedback could go here
  }, [selectedIds, scene.components, scene.snaps]);

  const handlePaste = useCallback(() => {
    if (!clipboard || clipboard.components.length === 0) return;
    // Generate fresh IDs for pasted components, mapping old → new
    const idMap = {};
    const existingIds = new Set(scene.components.map(c => c.id));
    for (const c of clipboard.components) {
      // Try `<id>_copy`, `<id>_copy2`, …
      let candidate = `${c.id}_copy`;
      let i = 2;
      while (existingIds.has(candidate)) {
        candidate = `${c.id}_copy${i++}`;
      }
      existingIds.add(candidate);
      idMap[c.id] = candidate;
    }
    // Offset the pasted components so they're visible (in grid units)
    const offset = gridSize * 5;
    const newComponents = clipboard.components.map(c => ({
      ...c,
      id: idMap[c.id],
      cx: c.cx + offset,
      cy: c.cy - offset,
      // Width/height KEEP their parameter expressions (the whole point: shared parameters)
    }));
    // Snaps among the copied set: rewire endpoints to the new IDs
    // Note: dx/dy expressions stay the same — they reference the same gap_* parameters,
    // so the pasted pair has the same separation as the original.
    const newSnaps = clipboard.snaps.map(s => ({
      ...s,
      id: `snap_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      from: { ...s.from, compId: idMap[s.from.compId] },
      to: { ...s.to, compId: idMap[s.to.compId] },
    }));
    updateScene(prev => ({
      ...prev,
      components: [...prev.components, ...newComponents],
      snaps: [...prev.snaps, ...newSnaps],
    }));
    // Select the pasted set
    const newIds = new Set(newComponents.map(c => c.id));
    setSelection({ ids: newIds, primary: newComponents[newComponents.length - 1].id });
  }, [clipboard, scene.components, gridSize, updateScene, setSelection]);

  // Cmd+S = save, Cmd+C / Cmd+V = copy/paste, + = union, - = subtract
  useEffect(() => {
    const handler = (e) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        if (e.shiftKey) handleSaveAs();
        else handleSave();
      } else if ((e.metaKey || e.ctrlKey) && (e.key === 'c' || e.key === 'C')) {
        // Don't intercept text-area copy
        const tag = e.target?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        e.preventDefault();
        handleCopy();
      } else if ((e.metaKey || e.ctrlKey) && (e.key === 'v' || e.key === 'V')) {
        const tag = e.target?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        e.preventDefault();
        handlePaste();
      } else if (e.key === '+' || e.key === '-') {
        // Boolean shortcuts: union (+) / subtract (-) act on the current
        // selection. Skip when typing in any input so users can enter
        // expressions like "x + y" or negative numbers without triggering
        // a boolean op.
        const tag = e.target?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target?.isContentEditable) return;
        // No modifier keys (avoid clashing with browser zoom on Cmd/Ctrl +/-).
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        // Read createBoolean through a ref because it's defined later in
        // this function body — putting it in the dep array would trigger
        // a TDZ error at component init. The ref always points to the
        // latest createBoolean closure once App's body has finished.
        const fn = createBooleanRef.current;
        if (!fn) return;
        if (selectedIds.size < 2) return;
        e.preventDefault();
        if (e.key === '+') fn('union');
        else fn('subtract');
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handleSave, handleSaveAs, handleCopy, handlePaste, selectedIds]);

  // ----- Autosave -----
  // Save to storage 2 seconds after the last edit, but only for designs that
  // already exist in storage (i.e., the user has saved at least once).
  // We persist the full undo/redo stacks alongside the scene.
  const [lastAutoSavedAt, setLastAutoSavedAt] = useState(null);
  const autosaveTimerRef = useRef(null);
  useEffect(() => {
    // Only autosave when status is unsaved AND the design name exists in saved list
    if (saveStatus !== 'unsaved') return;
    if (!designName || !savedList.includes(designName)) return;
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    autosaveTimerRef.current = setTimeout(async () => {
      setSaveStatus('saving');
      const ok = await saveDesign(workspace, designName, { scene, history, future, updatedAt: Date.now() });
      if (ok) {
        setSaveStatus('saved');
        setLastAutoSavedAt(Date.now());
      } else {
        setSaveStatus('unsaved');
      }
    }, 2000);
    return () => {
      if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    };
  }, [workspace, scene, history, future, designName, savedList, saveStatus]);

  // Tick to update "saved Xs ago" label every 5s
  const [tickNow, setTickNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setTickNow(Date.now()), 5000);
    return () => clearInterval(id);
  }, []);
  const savedAgoLabel = useMemo(() => {
    if (!lastAutoSavedAt) return '';
    const sec = Math.floor((tickNow - lastAutoSavedAt) / 1000);
    if (sec < 5) return 'just saved';
    if (sec < 60) return `${sec}s ago`;
    if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
    return `${Math.floor(sec / 3600)}h ago`;
  }, [lastAutoSavedAt, tickNow]);

  // Fit-to-view: compute bounding box of all components and adjust viewport
  const fitToView = useCallback(() => {
    const solved = applyMirrors(solveLayout(scene.components, scene.snaps, paramValues), scene.mirrors);
    if (solved.length === 0) {
      setViewport({ x: 0, y: 0, w: 400, h: 280 });
      return;
    }
    const xs = solved.flatMap(c => [c.cx - evalExpr(c.w, paramValues) / 2, c.cx + evalExpr(c.w, paramValues) / 2]);
    const ys = solved.flatMap(c => [c.cy - evalExpr(c.h, paramValues) / 2, c.cy + evalExpr(c.h, paramValues) / 2]);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const bw = Math.max(maxX - minX, 1);
    const bh = Math.max(maxY - minY, 1);
    // 10% padding on each side
    const pad = 1.2;
    setViewport({ x: cx, y: cy, w: bw * pad, h: bh * pad });
  }, [scene, paramValues]);

  // Keyboard shortcuts (F = fit, Delete/Backspace = delete selected, Cmd+Z = undo, Cmd+Shift+Z = redo)
  useEffect(() => {
    const handler = (e) => {
      const tag = e.target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === 'f' || e.key === 'F') {
        e.preventDefault();
        fitToView();
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedIds.size > 0) {
        e.preventDefault();
        deleteCompRef.current?.(selectedIds);
      } else if ((e.metaKey || e.ctrlKey) && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        if (e.shiftKey) {
          redoRef.current?.();
        } else {
          undoRef.current?.();
        }
      } else if ((e.metaKey || e.ctrlKey) && (e.key === 'y' || e.key === 'Y')) {
        e.preventDefault();
        redoRef.current?.();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [fitToView, selectedIds]);

  // Refs so handlers always see the latest functions
  const undoRef = useRef(null);
  const redoRef = useRef(null);
  undoRef.current = undo;
  redoRef.current = redo;


  // ref so the keyboard handler always sees the latest deleteComp without re-binding
  const deleteCompRef = useRef(null);

  // Auto-parametrize a new shape: create <id>_w and <id>_h params
  const addComponent = (layerKind, conductorLayerId = null) => {
    // layerKind: 'waveguide', 'electrode', or 'port' (component-level layer label)
    // conductorLayerId: optional stack-layer id (e.g. 'l_cond') to bind this component to
    // a specific conductor layer in the stack. Only meaningful when layerKind === 'electrode'.
    const conductorLayer = conductorLayerId
      ? (scene.stack || []).find(l => l.id === conductorLayerId)
      : null;
    const idPrefix = layerKind === 'waveguide' ? 'wg'
      : layerKind === 'port' ? 'port'
      : (conductorLayer ? conductorLayer.id.replace(/^l_/, '') : 'el');
    const baseId = `${idPrefix}${scene.components.filter(c => c.layer === layerKind).length + 1}`;
    let id = baseId;
    let suffix = 0;
    while (scene.components.some(c => c.id === id)) { suffix++; id = `${baseId}_${suffix}`; }
    const wParam = `${id}_w`;
    const hParam = `${id}_h`;
    updateScene(prev => ({
      ...prev,
      params: {
        ...prev.params,
        [wParam]: { expr: '20', unit: 'µm', desc: `${id} width` },
        [hParam]: { expr: '20', unit: 'µm', desc: `${id} height` },
      },
      components: [...prev.components, {
        id, kind: 'rect', layer: layerKind,
        cx: viewport.x, cy: viewport.y,
        w: wParam, h: hParam,
        cutouts: [], label: id,
        ...(conductorLayerId ? { conductorLayerId } : {}),
      }],
    }));
    setSelection({ ids: new Set([id]), primary: id });
  };

  // Finalize a drag-to-create operation. Inputs come from Canvas:
  //   spec: { kind, conductorLayerId? }
  //   p1, p2: the two world-space drag corner points (in any orientation)
  //   snapStart: optional { compId, anchor, x, y } if the START of the drag
  //              landed on an existing anchor — we install a snap to that anchor.
  //   snapEnd:   optional similar, for the END.
  //
  // Heuristics (in priority order):
  //   1. If the bounding-box width matches an existing component's resolved
  //      width within a tolerance, REUSE that component's `w` expression so
  //      the new component is parametrically tied to the same dimension.
  //      Same for height. Otherwise create fresh `<id>_w` and `<id>_h` params.
  //   2. If snapStart is set, install a snap from snapStart's anchor to the
  //      nearest corner anchor of the new component (so the drag's start
  //      point becomes a parametric reference instead of a literal position).
  //   3. If only snapEnd is set, treat it as snapStart (the snap is symmetric
  //      since the new rect is being placed; we just pick a near corner).
  const commitDragAdd = (spec, p1, p2, snapStart, snapEnd) => {
    // spec accepts both old and new shapes:
    //   old: { kind: 'waveguide'|'electrode'|'port', conductorLayerId? }
    //   new: { layer: 'waveguide'|'electrode'|'port', shape: 'rect'|'circle'|'ellipse'|'polygon', n?, conductorLayerId? }
    // Where a layer is provided in the new style, we use that; otherwise we
    // fall back to the legacy `kind` field which served as the layer name.
    const layerKind = spec.layer || spec.kind || 'waveguide';
    const shapeKind = spec.shape || 'rect';
    const conductorLayerId = spec.conductorLayerId || null;
    const conductorLayer = conductorLayerId
      ? (scene.stack || []).find(l => l.id === conductorLayerId)
      : null;
    const layerPrefix = layerKind === 'waveguide' ? 'wg'
      : layerKind === 'port' ? 'port'
      : (conductorLayer ? conductorLayer.id.replace(/^l_/, '') : 'el');
    // Shape-flavored id prefix so users can tell circles from rects from
    // polygons at a glance in the SHAPES tree.
    const shapePrefix = shapeKind === 'circle' ? 'circ'
      : shapeKind === 'ellipse' ? 'ell'
      : shapeKind === 'polygon' ? 'poly'
      : layerPrefix;
    const idPrefix = shapeKind === 'rect' ? layerPrefix : shapePrefix;
    const baseId = `${idPrefix}${scene.components.filter(c => c.layer === layerKind).length + 1}`;
    let id = baseId;
    let suffix = 0;
    while (scene.components.some(c => c.id === id)) { suffix++; id = `${baseId}_${suffix}`; }

    const minX = Math.min(p1.x, p2.x);
    const maxX = Math.max(p1.x, p2.x);
    const minY = Math.min(p1.y, p2.y);
    const maxY = Math.max(p1.y, p2.y);
    // If a drag has near-zero extent on an axis (e.g., user dragged purely
    // horizontally between two anchors that share a Y coordinate), the
    // resulting rect would be invisible. Clamp to a minimum visible thickness
    // so the user gets a tangible result they can resize afterwards.
    const MIN_THICK = 5; // µm — typical photonic feature scale
    const rawW = maxX - minX;
    const rawH = maxY - minY;
    const width  = rawW < 1e-3 ? MIN_THICK : Math.max(0.1, rawW);
    const height = rawH < 1e-3 ? MIN_THICK : Math.max(0.1, rawH);
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;

    // Try to bind to an existing component's width/height. Tolerance of 0.5 µm
    // catches "you dragged to roughly the same size as that other thing."
    // This catches the common case of dragging across an entire face of an
    // existing component (corner-to-corner along its top/side).
    const TOL = 0.5;
    let wExpr = null, hExpr = null;
    for (const c of scene.components) {
      const cw = evalExpr(c.w, paramValues);
      const ch = evalExpr(c.h, paramValues);
      if (!wExpr && Number.isFinite(cw) && Math.abs(cw - width) < TOL) wExpr = c.w;
      if (!hExpr && Number.isFinite(ch) && Math.abs(ch - height) < TOL) hExpr = c.h;
      if (wExpr && hExpr) break;
    }

    // Cross-component span case: when both endpoints snap to different
    // components, only one snap can position the new rect (a component can
    // only be the `to` of one snap). To keep the new rect "stretched" between
    // the two — staying connected on both sides if either parent moves OR is
    // resized — we make the unsnapped dimensions parametric expressions that
    // reference each parent's CURRENT solved position via synthetic
    // `_comp_<id>_cx` / `_comp_<id>_cy` paramValues injected by solveLayout.
    // This is critical: capturing parents' positions as literal snapshots at
    // creation time fails when the parent later moves, because the literal
    // never updates. Synthetic `_comp_<id>_cx` paramValues update on every
    // re-solve, so the span expression recomputes against current positions.
    //
    // Helper: build an EXPRESSION string for the world X/Y of an anchor on a
    // given component, using synthetic `_comp_<id>_cx/cy/w/h` so the expression
    // tracks the parent's CURRENT solved position AND size — not snapshots.
    // Critical when the parent's width/height is itself an expression like
    // `cap_sep/2 - port_L/2`: embedding that expression text in the span would
    // bind to whatever value `cap_sep`/`port_L` had at creation, and stop
    // tracking if the parent's `w`/`h` expression is later replaced (e.g. by
    // the resize handler clobbering it to a literal numeric).
    const anchorOffsetExprs = (compId, anchorName) => {
      const wRef = `_comp_${compId}_w`;
      const hRef = `_comp_${compId}_h`;
      const a = parseAnchor(anchorName);
      let xOff = '0', yOff = '0';
      if (a.kind === 'edge') {
        if (a.side === 'T') { xOff = `(${a.t} - 0.5) * (${wRef})`; yOff = `(${hRef})/2`; }
        else if (a.side === 'B') { xOff = `(${a.t} - 0.5) * (${wRef})`; yOff = `-(${hRef})/2`; }
        else if (a.side === 'L') { xOff = `-(${wRef})/2`; yOff = `(${a.t} - 0.5) * (${hRef})`; }
        else if (a.side === 'R') { xOff = `(${wRef})/2`;  yOff = `(${a.t} - 0.5) * (${hRef})`; }
      } else {
        const n = a.name;
        if (n.includes('W')) xOff = `-(${wRef})/2`;
        else if (n.includes('E')) xOff = `(${wRef})/2`;
        if (n.includes('S')) yOff = `-(${hRef})/2`;
        else if (n.includes('N')) yOff = `(${hRef})/2`;
      }
      return { xOff, yOff };
    };
    // Build (xExpr, yExpr) for an anchor's world position on `compId`.
    const anchorWorldExprs = (compId, anchorName) => {
      const c = scene.components.find(cc => cc.id === compId);
      if (!c) return null;
      const off = anchorOffsetExprs(compId, anchorName);
      return {
        x: `(_comp_${compId}_cx) + (${off.xOff})`,
        y: `(_comp_${compId}_cy) + (${off.yOff})`,
      };
    };

    // Decide whether to compute parametric span dimensions. Only do this when
    // both endpoints snap to DIFFERENT components — same-component is already
    // handled by the dimension-match branch above.
    let spanWExpr = null, spanHExpr = null;
    const spanCase = !!(snapStart && snapEnd && snapStart.compId !== snapEnd.compId);
    if (spanCase) {
      const aExpr = anchorWorldExprs(snapStart.compId, snapStart.anchor);
      const bExpr = anchorWorldExprs(snapEnd.compId, snapEnd.anchor);
      if (aExpr && bExpr) {
        // The new rect's snapped corner sits at snapStart; the opposite
        // corner sits at snapEnd. Width/height are signed expressions
        // (B - A) or (A - B) depending on drag direction, so the rect grows
        // in the right direction as parents move. The sign is FIXED at
        // creation; if parents cross over later, the rect goes negative —
        // user error.
        const dragSignX = (snapEnd.x >= snapStart.x) ? 1 : -1;
        const dragSignY = (snapEnd.y >= snapStart.y) ? 1 : -1;
        const candidateW = dragSignX > 0
          ? `((${bExpr.x}) - (${aExpr.x}))`
          : `((${aExpr.x}) - (${bExpr.x}))`;
        const candidateH = dragSignY > 0
          ? `((${bExpr.y}) - (${aExpr.y}))`
          : `((${aExpr.y}) - (${bExpr.y}))`;
        // ALWAYS install span expressions on both axes when both endpoints
        // snap. The expression tracks each parent's CURRENT solved position,
        // so the new rect stays connected to BOTH parents as either is moved
        // or resized.
        //
        // Edge case: when an axis is degenerate at creation (both anchors
        // share that coordinate), the span evaluates to 0. We pad with a
        // visible MIN_THICK constant for that axis so the rect is visible
        // at creation. As parents later diverge, the span term grows and
        // the rect inflates accordingly.
        const solvedNow = solveLayout(scene.components, scene.snaps, paramValues);
        const validationPV = { ...paramValues };
        for (const c of solvedNow) {
          validationPV[`_comp_${c.id}_cx`] = c.cx;
          validationPV[`_comp_${c.id}_cy`] = c.cy;
          validationPV[`_comp_${c.id}_w`] = evalExpr(c.w, validationPV);
          validationPV[`_comp_${c.id}_h`] = evalExpr(c.h, validationPV);
        }
        const wEval = evalExpr(candidateW, validationPV);
        const hEval = evalExpr(candidateH, validationPV);
        const SPAN_MIN_THICK = 5; // µm — visible default for degenerate axes
        if (Number.isFinite(wEval) && Math.abs(wEval) > 0.01) {
          spanWExpr = candidateW;
        } else {
          spanWExpr = `(${candidateW}) + ${SPAN_MIN_THICK}`;
        }
        if (Number.isFinite(hEval) && Math.abs(hEval) > 0.01) {
          spanHExpr = candidateH;
        } else {
          spanHExpr = `(${candidateH}) + ${SPAN_MIN_THICK}`;
        }
      }
    }

    // Pick the new rect's corner anchor closest to the drag-start point.
    // Used for installing a snap from snapStart.compId.snapStart.anchor →
    // newComp.<corner>.
    const cornerAnchor = (px, py) => {
      const isLeft = Math.abs(px - minX) < Math.abs(px - maxX);
      const isBot  = Math.abs(py - minY) < Math.abs(py - maxY);
      if (isLeft && isBot)  return 'SW';
      if (!isLeft && isBot) return 'SE';
      if (isLeft && !isBot) return 'NW';
      return 'NE';
    };

    const usedNames = new Set(Object.keys(scene.params));
    const nextName = (prefix) => {
      let i = 1;
      while (usedNames.has(`${prefix}${i}`)) i++;
      usedNames.add(`${prefix}${i}`);
      return `${prefix}${i}`;
    };

    updateScene(prev => {
      const newParams = { ...prev.params };
      // Width / height. Priority: span-case parametric > dimension-match >
      // fresh literal parameter.
      let finalW, finalH;
      if (spanWExpr) {
        const wParam = `${id}_w`;
        newParams[wParam] = { expr: spanWExpr, unit: 'µm', desc: `${id} width — spans from ${snapStart.compId}.${snapStart.anchor} to ${snapEnd.compId}.${snapEnd.anchor}` };
        finalW = wParam;
      } else if (wExpr) {
        finalW = wExpr;
      } else {
        const wParam = `${id}_w`;
        newParams[wParam] = { expr: width.toFixed(3), unit: 'µm', desc: `${id} width` };
        finalW = wParam;
      }
      if (spanHExpr) {
        const hParam = `${id}_h`;
        newParams[hParam] = { expr: spanHExpr, unit: 'µm', desc: `${id} height — spans from ${snapStart.compId}.${snapStart.anchor} to ${snapEnd.compId}.${snapEnd.anchor}` };
        finalH = hParam;
      } else if (hExpr) {
        finalH = hExpr;
      } else {
        const hParam = `${id}_h`;
        newParams[hParam] = { expr: height.toFixed(3), unit: 'µm', desc: `${id} height` };
        finalH = hParam;
      }
      // Build the new component. For non-rect shapes we ALSO need
      // primary parameters: r for circle, rx/ry for ellipse, r/n for
      // polygon. AABB w/h are derived from those parameters so the rest
      // of the layout system (snaps, anchors, dimensions, exports) sees
      // a consistent bounding box without needing per-shape branches
      // everywhere.
      let newComp;
      if (shapeKind === 'circle') {
        // Radius = half the smaller bbox side (inscribed circle).
        // w/h reference the radius so the bbox tracks if the user edits
        // the radius later.
        const rParam = `${id}_r`;
        const rVal = Math.min(width, height) / 2;
        newParams[rParam] = { expr: rVal.toFixed(3), unit: 'µm', desc: `${id} radius` };
        newComp = {
          id, kind: 'circle', layer: layerKind,
          cx, cy,
          r: rParam,
          // Derived AABB for snap/anchor consistency.
          w: `2*${rParam}`, h: `2*${rParam}`,
          cutouts: [], label: id,
          ...(conductorLayerId ? { conductorLayerId } : {}),
        };
      } else if (shapeKind === 'ellipse') {
        const rxParam = `${id}_rx`;
        const ryParam = `${id}_ry`;
        newParams[rxParam] = { expr: (width / 2).toFixed(3), unit: 'µm', desc: `${id} x-semi-axis` };
        newParams[ryParam] = { expr: (height / 2).toFixed(3), unit: 'µm', desc: `${id} y-semi-axis` };
        newComp = {
          id, kind: 'ellipse', layer: layerKind,
          cx, cy,
          rx: rxParam, ry: ryParam,
          w: `2*${rxParam}`, h: `2*${ryParam}`,
          cutouts: [], label: id,
          ...(conductorLayerId ? { conductorLayerId } : {}),
        };
      } else if (shapeKind === 'polygon') {
        const rParam = `${id}_r`;
        const nParam = `${id}_n`;
        const rVal = Math.min(width, height) / 2;
        const nVal = Math.max(3, Math.round(spec.n || 6));
        newParams[rParam] = { expr: rVal.toFixed(3), unit: 'µm', desc: `${id} circumradius` };
        newParams[nParam] = { expr: String(nVal), unit: '', desc: `${id} number of sides` };
        newComp = {
          id, kind: 'polygon', layer: layerKind,
          cx, cy,
          r: rParam, n: nParam,
          // Polygon AABB is bounded by the circumscribed circle (≤ 2r in
          // each axis). Using 2r over-approximates slightly for polygons
          // whose vertices don't fall on the axes, but keeps snap anchors
          // predictable.
          w: `2*${rParam}`, h: `2*${rParam}`,
          cutouts: [], label: id,
          ...(conductorLayerId ? { conductorLayerId } : {}),
        };
      } else {
        // Rectangle (default).
        newComp = {
          id, kind: 'rect', layer: layerKind,
          cx, cy,
          w: finalW, h: finalH,
          cutouts: [], label: id,
          ...(conductorLayerId ? { conductorLayerId } : {}),
        };
      }
      const newSnaps = [];
      // Choose which drag corner to snap (prefer start, fall back to end).
      const snapAnchor = snapStart || snapEnd;
      if (snapAnchor) {
        const dragPt = snapStart ? p1 : p2;
        const newAnchor = cornerAnchor(dragPt.x, dragPt.y);
        // dx, dy = 0 because the snapped corner is exactly at the anchor's
        // world position. Create gap params anyway so the user can edit them
        // later (consistent with how interactive snap creation works).
        const gapX = nextName('gap_x');
        newParams[gapX] = { expr: '0', unit: 'µm', desc: `Gap ${snapAnchor.compId}.${snapAnchor.anchor} → ${id}.${newAnchor} (dx)` };
        const gapY = nextName('gap_y');
        newParams[gapY] = { expr: '0', unit: 'µm', desc: `Gap ${snapAnchor.compId}.${snapAnchor.anchor} → ${id}.${newAnchor} (dy)` };
        newSnaps.push({
          id: `snap_${Date.now()}`,
          from: { compId: snapAnchor.compId, anchor: snapAnchor.anchor },
          to:   { compId: id,                 anchor: newAnchor },
          dx: gapX, dy: gapY,
        });
      }
      return {
        ...prev,
        params: newParams,
        components: [...prev.components, newComp],
        snaps: [...prev.snaps, ...newSnaps],
      };
    });
    setSelection({ ids: new Set([id]), primary: id });
  };

  const updateComp = (id, patch) => {
    updateScene(prev => ({
      ...prev,
      components: prev.components.map(c => c.id === id ? { ...c, ...patch } : c),
    }));
  };

  const deleteComp = (idOrSet) => {
    const idSet = idOrSet instanceof Set ? idOrSet : new Set([idOrSet]);
    if (idSet.size === 0) return;
    updateScene(prev => {
      // Remove deleted ids from each group's memberIds; drop groups that become empty
      const newGroups = prev.groups
        .map(g => ({ ...g, memberIds: g.memberIds.filter(id => !idSet.has(id)) }))
        .filter(g => g.memberIds.length > 0);
      return {
        ...prev,
        components: prev.components.filter(c => !idSet.has(c.id)),
        snaps: prev.snaps.filter(s => !idSet.has(s.from.compId) && !idSet.has(s.to.compId)),
        mirrors: prev.mirrors
          .map(m => ({ ...m, members: m.members.filter(mm => !idSet.has(mm.srcId) && !idSet.has(mm.mirrorId)) }))
          .filter(m => m.members.length > 0),
        groups: newGroups,
      };
    });
    setSelection({ ids: new Set(), primary: null });
  };
  deleteCompRef.current = deleteComp;

  const deleteSelected = () => {
    if (selectedIds.size > 0) deleteComp(selectedIds);
  };

  const deleteSnap = (snapId) => updateScene(prev => ({ ...prev, snaps: prev.snaps.filter(s => s.id !== snapId) }));
  const updateSnap = (snapId, patch) => updateScene(prev => ({
    ...prev,
    snaps: prev.snaps.map(s => s.id === snapId ? { ...s, ...patch } : s),
  }));

  // Re-root the snap chain so that `rootId` becomes the parent. Walks the
  // connected component of the snap graph reachable from `rootId` (treating
  // snaps as undirected edges), and orients every snap to point AWAY from
  // rootId. Snaps already pointing the right way are kept; snaps pointing
  // toward the new root are reversed (with offsets negated and dx/dy parameter
  // expressions wrapped/flipped accordingly).
  //
  // For each snap that needs flipping, dx/dy expressions are negated. If they
  // are sole references to parameters, those parameters' expressions are
  // negated in place — only when they're not shared by anything else.
  // Otherwise we wrap the expression with -(...) so the snap geometry is
  // preserved.
  const reRootSnapChain = (rootId) => {
    updateScene(prev => {
      // Reference-counter for parameter names across the scene; used to decide
      // whether we can negate a param's expr in place (single use) vs wrap the
      // snap's offset in -(...) (shared).
      const paramRefCount = (paramName, snapsToConsider) => {
        let n = 0;
        for (const sn of snapsToConsider) {
          if (sn.dx === paramName) n++;
          if (sn.dy === paramName) n++;
        }
        for (const c of prev.components) {
          for (const f of ['w', 'h']) if (c[f] === paramName) n++;
          for (const cu of (c.cutouts || [])) {
            for (const f of ['dx', 'dy', 'w', 'h']) if (cu[f] === paramName) n++;
          }
        }
        for (const [, p] of Object.entries(prev.params)) {
          if (typeof p.expr === 'string' && tokenizeIdents(p.expr).includes(paramName)) n++;
        }
        return n;
      };

      const newParams = { ...prev.params };
      const newSnaps = [];
      // Track which params we've already negated in place, so we don't double-flip
      // if the same param is referenced by multiple flipped snaps.
      const alreadyNegated = new Set();

      const negateOffset = (offsetExpr) => {
        if (typeof offsetExpr !== 'string') return offsetExpr;
        const stripped = offsetExpr.trim();
        if (/^[A-Za-z_][\w]*$/.test(stripped) && newParams[stripped]) {
          if (alreadyNegated.has(stripped)) {
            // Already flipped once via in-place edit; flipping again would
            // restore the original sign. Wrap the snap-side instead.
            return `-(${offsetExpr})`;
          }
          const refs = paramRefCount(stripped, prev.snaps);
          if (refs <= 2) {
            // 'refs' counts each occurrence; a sole-snap reference shows up
            // once on dx OR dy of the same snap. We allow up to 2 just in case
            // both dx and dy share the param (rare).
            const old = newParams[stripped].expr;
            newParams[stripped] = { ...newParams[stripped], expr: `-(${old})` };
            alreadyNegated.add(stripped);
            return stripped;
          }
        }
        return `-(${offsetExpr})`;
      };

      // BFS from rootId, treating snaps as undirected. Each snap is visited
      // exactly once (tracked by id) and oriented to point away from root.
      const visited = new Set([rootId]);
      const queue = [rootId];
      const handledSnapIds = new Set();
      while (queue.length > 0) {
        const here = queue.shift();
        for (const s of prev.snaps) {
          if (handledSnapIds.has(s.id)) continue;
          if (s.from.compId === here && !visited.has(s.to.compId)) {
            // Already pointing away — keep as-is
            newSnaps.push(s);
            handledSnapIds.add(s.id);
            visited.add(s.to.compId);
            queue.push(s.to.compId);
          } else if (s.to.compId === here && !visited.has(s.from.compId)) {
            // Pointing toward us — flip
            newSnaps.push({
              ...s,
              from: { compId: s.to.compId, anchor: s.to.anchor },
              to:   { compId: s.from.compId, anchor: s.from.anchor },
              dx: negateOffset(s.dx),
              dy: negateOffset(s.dy),
            });
            handledSnapIds.add(s.id);
            visited.add(s.from.compId);
            queue.push(s.from.compId);
          }
          // Snaps where both endpoints are already visited: it's a cycle edge.
          // Keep its current orientation (we can't sensibly re-root a cycle).
        }
      }
      // Append snaps that weren't part of the connected component reachable
      // from rootId (other disconnected sub-graphs and cycle-edges).
      for (const s of prev.snaps) {
        if (!handledSnapIds.has(s.id)) newSnaps.push(s);
      }

      return { ...prev, params: newParams, snaps: newSnaps };
    });
  };

  // Promote a snap axis from a literal/expression to a fresh parameter binding.
  // The new parameter takes the current expression as its initial value.
  const promoteSnapAxis = (snapId, axis) => {
    updateScene(prev => {
      const snap = prev.snaps.find(s => s.id === snapId);
      if (!snap) return prev;
      const currentExpr = snap[axis] ?? '0';
      // If it's already a parameter ref, do nothing
      const trimmed = String(currentExpr).trim();
      if (/^[A-Za-z_][\w]*$/.test(trimmed) && prev.params[trimmed]) return prev;
      // Find a fresh gap_x* / gap_y* name
      const prefix = axis === 'dx' ? 'gap_x' : 'gap_y';
      let i = 1;
      while (prev.params[`${prefix}${i}`]) i++;
      const name = `${prefix}${i}`;
      const newParams = {
        ...prev.params,
        [name]: {
          expr: String(currentExpr),
          unit: 'µm',
          desc: `Gap ${snap.from.compId}.${snap.from.anchor} → ${snap.to.compId}.${snap.to.anchor} (${axis})`,
        },
      };
      const newSnaps = prev.snaps.map(s => s.id === snapId ? { ...s, [axis]: name } : s);
      return { ...prev, params: newParams, snaps: newSnaps };
    });
  };

  // ----- Groups -----
  // Create a group from selected components. Rename their referenced parameters
  // to <groupName>_<param>, and create alias parameters that initially equal the originals.
  const createGroup = async () => {
    if (selectedIds.size === 0) {
      await alertDialog('Select one or more components first.', 'No selection');
      return;
    }
    // Suggest a unique default name
    let i = 1;
    let suggestion = 'group1';
    while (scene.groups.some(g => g.name === suggestion)) { i++; suggestion = `group${i}`; }
    const groupName = await promptDialog('Name for the new group:', suggestion, 'Create group');
    if (!groupName || !groupName.trim()) return;
    const trimmed = groupName.trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) {
      await alertDialog('Group name must be a valid identifier (letters, digits, underscore; starting with letter/underscore).', 'Invalid name');
      return;
    }
    if (scene.groups.some(g => g.name === trimmed)) {
      await alertDialog(`A group named "${trimmed}" already exists.`, 'Duplicate name');
      return;
    }

    const memberIds = new Set(selectedIds);

    updateScene(prev => {
      // Find parameters referenced by:
      //   (a) any member component's w/h or cutouts
      //   (b) any snap whose BOTH endpoints are members (internal snap)
      const referenced = new Set();
      const collect = (expr) => {
        if (typeof expr !== 'string') return;
        for (const id of tokenizeIdents(expr)) {
          if (prev.params[id]) referenced.add(id);
        }
      };
      for (const c of prev.components) {
        if (!memberIds.has(c.id)) continue;
        collect(c.w); collect(c.h);
        for (const cu of (c.cutouts || [])) { collect(cu.dx); collect(cu.dy); collect(cu.w); collect(cu.h); }
      }
      const internalSnaps = prev.snaps.filter(s => memberIds.has(s.from.compId) && memberIds.has(s.to.compId));
      for (const s of internalSnaps) { collect(s.dx); collect(s.dy); }

      // Build alias map: orig → group-scoped
      const aliasMap = {};
      const newParams = { ...prev.params };
      for (const orig of referenced) {
        let aliasName = `${trimmed}_${orig}`;
        let n = 2;
        while (newParams[aliasName]) { aliasName = `${trimmed}_${orig}_${n++}`; }
        aliasMap[orig] = aliasName;
        newParams[aliasName] = {
          expr: orig,
          unit: prev.params[orig].unit,
          desc: `[${trimmed}] alias of ${orig}`,
        };
      }

      const replaceIn = (expr) => {
        if (typeof expr !== 'string') return expr;
        let out = expr;
        // Replace whole-word occurrences of each aliased param. Sort longer-first to avoid partials.
        const keys = Object.keys(aliasMap).sort((a, b) => b.length - a.length);
        for (const k of keys) {
          out = out.replace(new RegExp(`\\b${k}\\b`, 'g'), aliasMap[k]);
        }
        return out;
      };

      // Rewrite member components
      const newComponents = prev.components.map(c => {
        if (!memberIds.has(c.id)) return c;
        return {
          ...c,
          w: replaceIn(c.w),
          h: replaceIn(c.h),
          cutouts: (c.cutouts || []).map(cu => ({
            ...cu,
            dx: replaceIn(cu.dx), dy: replaceIn(cu.dy),
            w: replaceIn(cu.w), h: replaceIn(cu.h),
          })),
          group: trimmed,
        };
      });

      // Rewrite internal snaps
      const internalSnapIds = new Set(internalSnaps.map(s => s.id));
      const newSnaps = prev.snaps.map(s => {
        if (!internalSnapIds.has(s.id)) return s;
        return { ...s, dx: replaceIn(s.dx), dy: replaceIn(s.dy) };
      });

      const newGroup = {
        id: `group_${Date.now().toString(36)}`,
        name: trimmed,
        memberIds: Array.from(memberIds),
        aliases: aliasMap, // record so we can ungroup later
      };

      return {
        ...prev,
        params: newParams,
        components: newComponents,
        snaps: newSnaps,
        groups: [...prev.groups, newGroup],
      };
    });
  };

  // Delete the entire group, including all its member components
  const deleteGroup = async (groupId) => {
    const g = scene.groups.find(x => x.id === groupId);
    if (!g) return;
    const ok = await confirmDialog(
      `Delete group "${g.name}" and all ${g.memberIds.length} of its component${g.memberIds.length === 1 ? '' : 's'}?\n\nGroup-scoped parameters (${Object.keys(g.aliases || {}).length}) will become unused — you can clean them up later in PARAMS.`,
      'Delete group'
    );
    if (!ok) return;
    deleteComp(new Set(g.memberIds));
  };

  // Remove the group metadata but keep the components and their group-scoped params (= "ungroup")
  const dissolveGroup = async (groupId) => {
    const g = scene.groups.find(x => x.id === groupId);
    if (!g) return;
    const ok = await confirmDialog(
      `Ungroup "${g.name}"? Components and their group-scoped parameters are kept; only the grouping is removed.`,
      'Ungroup'
    );
    if (!ok) return;
    updateScene(prev => ({
      ...prev,
      components: prev.components.map(c => g.memberIds.includes(c.id) ? { ...c, group: undefined } : c),
      groups: prev.groups.filter(x => x.id !== groupId),
    }));
  };

  const renameGroupParameter = async (groupId, oldName, newName) => {
    if (!newName || newName === oldName) return;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(newName)) return;
    if (scene.params[newName]) {
      await alertDialog('A parameter with that name already exists.', 'Rename failed');
      return;
    }
    renameParam(oldName, newName);
    // Update group alias map
    updateScene(prev => ({
      ...prev,
      groups: prev.groups.map(g => g.id === groupId
        ? { ...g, aliases: Object.fromEntries(Object.entries(g.aliases).map(([k, v]) => [k, v === oldName ? newName : v])) }
        : g),
    }));
  };

  const selectGroup = (groupId) => {
    const g = scene.groups.find(x => x.id === groupId);
    if (!g) return;
    const ids = new Set(g.memberIds.filter(id => scene.components.some(c => c.id === id)));
    setSelection({ ids, primary: ids.size > 0 ? Array.from(ids)[0] : null });
  };

  // Rename a group: updates the group's name, components' `group` field, aliased parameters
  // (e.g., capacitor_cap_gap → newname_cap_gap), and all references to those parameters.
  const renameGroup = async (groupId, newName) => {
    const g = scene.groups.find(x => x.id === groupId);
    if (!g) return;
    if (!newName || newName === g.name) return;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(newName)) {
      await alertDialog('Group name must be a valid identifier (letters, digits, underscore; starting with letter/underscore).', 'Invalid name');
      return;
    }
    if (scene.groups.some(x => x.id !== groupId && x.name === newName)) {
      await alertDialog(`Another group is already named "${newName}".`, 'Duplicate name');
      return;
    }

    const oldName = g.name;
    const oldPrefix = `${oldName}_`;
    const newPrefix = `${newName}_`;

    updateScene(prev => {
      // Build paramMap: for every aliased param starting with `<oldName>_`, rename to `<newName>_<rest>`.
      // Skip if a collision would occur.
      const paramMap = {};
      const newParams = {};
      const collisions = [];
      // First pass: figure out new names
      for (const pname of Object.keys(prev.params)) {
        if (pname.startsWith(oldPrefix)) {
          const rest = pname.slice(oldPrefix.length);
          const newPname = newPrefix + rest;
          if (newPname !== pname && prev.params[newPname]) {
            collisions.push(`${pname} → ${newPname}`);
          }
          paramMap[pname] = newPname;
        } else {
          paramMap[pname] = pname;
        }
      }
      if (collisions.length > 0) {
        // Bail out — caller will surface this. We can't await alertDialog inside an updater.
        // Instead, return prev unchanged and we'll alert below.
        return prev;
      }
      // Build the renamed params object preserving insertion order
      for (const pname of Object.keys(prev.params)) {
        const newPname = paramMap[pname];
        newParams[newPname] = prev.params[pname];
      }

      // Replace identifiers in any expression
      const replaceIn = (expr) => {
        if (typeof expr !== 'string') return expr;
        let out = expr;
        const keys = Object.keys(paramMap).filter(k => paramMap[k] !== k).sort((a, b) => b.length - a.length);
        for (const k of keys) {
          out = out.replace(new RegExp(`\\b${k}\\b`, 'g'), paramMap[k]);
        }
        return out;
      };
      // Apply replaceIn to every param's expr (in case one references another renamed param)
      for (const pname of Object.keys(newParams)) {
        newParams[pname] = { ...newParams[pname], expr: replaceIn(newParams[pname].expr) };
      }

      // Update components: w/h/cutouts and the `group` field
      const newComponents = prev.components.map(c => {
        const updated = {
          ...c,
          w: replaceIn(c.w),
          h: replaceIn(c.h),
          cutouts: (c.cutouts || []).map(cu => ({
            ...cu,
            dx: replaceIn(cu.dx), dy: replaceIn(cu.dy),
            w: replaceIn(cu.w), h: replaceIn(cu.h),
          })),
        };
        if (c.group === oldName) updated.group = newName;
        return updated;
      });

      // Update snaps
      const newSnaps = prev.snaps.map(s => ({
        ...s,
        dx: replaceIn(s.dx),
        dy: replaceIn(s.dy),
      }));

      // Update group descriptor (name + alias map values)
      const newGroups = prev.groups.map(grp => {
        if (grp.id !== groupId) return grp;
        const newAliases = {};
        for (const [orig, oldAlias] of Object.entries(grp.aliases || {})) {
          newAliases[orig] = paramMap[oldAlias] || oldAlias;
        }
        return { ...grp, name: newName, aliases: newAliases };
      });

      return {
        ...prev,
        params: newParams,
        components: newComponents,
        snaps: newSnaps,
        groups: newGroups,
      };
    });

    // Detect collisions by checking if scene was actually modified.
    // (Above updater returns prev unchanged on collision.)
    // Simpler check: see if any colliding new name already exists in current state.
    const wouldCollide = Object.keys(scene.params).some(pname => {
      if (!pname.startsWith(oldPrefix)) return false;
      const rest = pname.slice(oldPrefix.length);
      const target = newPrefix + rest;
      return target !== pname && scene.params[target];
    });
    if (wouldCollide) {
      await alertDialog(
        `Cannot rename "${oldName}" to "${newName}": one or more parameters would collide with existing names. Pick a different group name.`,
        'Rename failed'
      );
    }
  };

  // ----- Library -----
  // Save selected components (or a group) to the library.
  const saveSelectionToLibrary = async () => {
    if (selectedIds.size === 0) {
      await alertDialog('Select components first.', 'No selection');
      return;
    }
    const name = await promptDialog('Name for this library item (also becomes the group name on insert):', '', 'Save to library');
    if (!name || !name.trim()) return;
    const trimmed = name.trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) {
      await alertDialog('Name must be a valid identifier (letters, digits, underscore; starting with letter/underscore).', 'Invalid name');
      return;
    }
    if (libraryItems.includes(trimmed)) {
      const ok = await confirmDialog(`"${trimmed}" already exists. Overwrite?`, 'Overwrite');
      if (!ok) return;
    }

    const memberIds = new Set(selectedIds);
    const componentsRaw = scene.components
      .filter(c => memberIds.has(c.id))
      .map(c => ({ ...c, cutouts: (c.cutouts || []).map(cu => ({ ...cu })) }));
    const snapsRaw = scene.snaps
      .filter(s => memberIds.has(s.from.compId) && memberIds.has(s.to.compId))
      .map(s => ({ ...s }));

    // Collect referenced params (transitively)
    const referenced = new Set();
    const queue = [];
    const enqueue = (expr) => {
      if (typeof expr !== 'string') return;
      for (const id of tokenizeIdents(expr)) {
        if (scene.params[id] && !referenced.has(id)) {
          referenced.add(id); queue.push(id);
        }
      }
    };
    for (const c of componentsRaw) {
      enqueue(c.w); enqueue(c.h);
      for (const cu of (c.cutouts || [])) { enqueue(cu.dx); enqueue(cu.dy); enqueue(cu.w); enqueue(cu.h); }
    }
    for (const s of snapsRaw) { enqueue(s.dx); enqueue(s.dy); }
    while (queue.length) {
      const id = queue.shift();
      enqueue(scene.params[id].expr);
    }

    // Determine the params that should be wrapped (directly referenced by members or internal snaps).
    // Transitively-referenced params (e.g., one used only by another param's expression) stay un-aliased.
    const directlyReferenced = new Set();
    const collectDirect = (expr) => {
      if (typeof expr !== 'string') return;
      for (const id of tokenizeIdents(expr)) {
        if (scene.params[id]) directlyReferenced.add(id);
      }
    };
    for (const c of componentsRaw) {
      collectDirect(c.w); collectDirect(c.h);
      for (const cu of (c.cutouts || [])) { collectDirect(cu.dx); collectDirect(cu.dy); collectDirect(cu.w); collectDirect(cu.h); }
    }
    for (const s of snapsRaw) { collectDirect(s.dx); collectDirect(s.dy); }

    // Build a payload that represents the selection as one group called `trimmed`.
    // Decision: every directly-referenced parameter gets aliased as `<trimmed>_<orig>`.
    // The aliased param's expr in the payload is the ORIGINAL name — so when inserted,
    // the alias param resolves to whatever the original is in the destination scene.
    const aliases = {};
    const alreadyAliased = new Set();
    // If a param is already itself prefixed (e.g., from a previous group), don't double-prefix.
    for (const orig of directlyReferenced) {
      // If the parameter already starts with `<trimmed>_`, keep the name; otherwise alias.
      if (orig.startsWith(trimmed + '_')) {
        alreadyAliased.add(orig);
        aliases[orig] = orig; // no rename, but still part of the group
      } else {
        aliases[orig] = `${trimmed}_${orig}`;
      }
    }

    const replaceIn = (expr) => {
      if (typeof expr !== 'string') return expr;
      let out = expr;
      const keys = Object.keys(aliases).sort((a, b) => b.length - a.length);
      for (const k of keys) {
        if (aliases[k] === k) continue; // no-op replacement
        out = out.replace(new RegExp(`\\b${k}\\b`, 'g'), aliases[k]);
      }
      return out;
    };

    // Build params for the payload:
    //   - aliased ones (named <trimmed>_<orig>), expr = orig (so they reference the original on insert)
    //   - the originals themselves (un-renamed), so the alias chain resolves
    //   - transitively-referenced params (un-aliased, just included so the inserted item works standalone)
    const params = {};
    for (const orig of referenced) {
      params[orig] = { ...scene.params[orig] };
    }
    for (const orig of directlyReferenced) {
      const aliasName = aliases[orig];
      if (aliasName === orig) continue; // already grouped-prefix
      params[aliasName] = {
        expr: orig,
        unit: scene.params[orig].unit,
        desc: `[${trimmed}] alias of ${orig}`,
      };
    }

    // Rewrite components and snaps in the payload to use aliased names
    const components = componentsRaw.map(c => ({
      ...c,
      group: trimmed,
      w: replaceIn(c.w),
      h: replaceIn(c.h),
      cutouts: (c.cutouts || []).map(cu => ({
        ...cu,
        dx: replaceIn(cu.dx), dy: replaceIn(cu.dy),
        w: replaceIn(cu.w), h: replaceIn(cu.h),
      })),
    }));
    const snaps = snapsRaw.map(s => ({ ...s, dx: replaceIn(s.dx), dy: replaceIn(s.dy) }));

    // Build the synthesized group descriptor (its alias map maps orig→aliased)
    const groupDescriptor = {
      id: `group_${Date.now().toString(36)}`,
      name: trimmed,
      memberIds: components.map(c => c.id),
      aliases, // { orig: aliasName } — even when alias equals orig (already prefixed)
    };

    const payload = {
      name: trimmed,
      params,
      components,
      snaps,
      groups: [groupDescriptor],
      createdAt: Date.now(),
    };

    const ok = await saveLibraryItem(workspace, trimmed, payload);
    if (!ok) {
      await alertDialog('Save failed.', 'Error');
      return;
    }
    await refreshLibrary();
  };

  // Insert a built-in template: a racetrack optical waveguide loop using
  // partial-Euler bends. Default parameters:
  //   R = 100 µm           (minimum radius of curvature in the bends)
  //   L_straight = 300 µm  (length of each straight section)
  //   p = 1                (full Euler — no constant-radius arc segment)
  //
  // Each parameter is added as a named scene parameter prefixed with the
  // racetrack's id, so the user can edit them through the inspector or the
  // PARAMS panel and the geometry updates live. The component's AABB
  // (w, h) is set to a parametric over-approximation using the empirical
  // linear-in-p fit; the actual waveguide band is computed exactly at
  // render time from R, L_straight, p, and the waveguide width.
  const insertBuiltinRacetrack = () => {
    updateScene(prev => {
      // Pick a fresh component id.
      let idBase = 'racetrack';
      let id = idBase;
      let suffix = 0;
      while (prev.components.some(c => c.id === id)) { suffix++; id = `${idBase}_${suffix}`; }

      // Allocate fresh parameter names. R and L_straight are unique-per-
      // instance so duplicating the racetrack gives each its own knobs.
      const pickName = (base) => {
        let n = base; let i = 2;
        while (prev.params[n]) { n = `${base}_${i++}`; }
        return n;
      };
      const pR = pickName(`${id}_R`);
      const pL = pickName(`${id}_L_straight`);
      const pP = pickName(`${id}_p`);
      const newParams = {
        ...prev.params,
        [pR]: { expr: '100', unit: 'µm', desc: `${id} min radius of curvature` },
        [pL]: { expr: '300', unit: 'µm', desc: `${id} straight section length` },
        [pP]: { expr: '1',   unit: '',    desc: `${id} Euler split (0 = pure arc, 1 = pure Euler)` },
      };
      // Waveguide width: prefer the waveguide layer's core_width if defined,
      // else fall back to the conventional `w_wg` parameter.
      const wgLayer = (prev.stack || []).find(l => l.role === 'waveguide');
      const wgWidthExpr = (wgLayer && wgLayer.core_width) ? wgLayer.core_width : 'w_wg';
      // If the referenced parameter doesn't exist in the scene yet, create
      // a default one. Without this, the racetrack would silently render at
      // zero width on a blank scene (the wgWidth expression evaluates to
      // NaN → 0). Picking 1.2 matches the rest of the default params.
      if (!newParams[wgWidthExpr] && /^[A-Za-z_][A-Za-z0-9_]*$/.test(wgWidthExpr)) {
        newParams[wgWidthExpr] = { expr: '1.2', unit: 'µm', desc: 'WG core width (rib bottom)' };
      }

      // Parametric AABB. Bend extension formulas (empirical linear-in-p
      // fits; exact at p=0 and within ~1% at p=1):
      //   bend_x_extent ≈ R * (1 + 1.45 * p)   — max |x| of the bend curve
      //   bend_y_span   ≈ R * (2 + 0.754 * p)  — vertical distance between
      //                                          the two straight centerlines
      // The full racetrack footprint adds the waveguide width to each axis
      // since the band extends ±width/2 beyond the centerline.
      const wExpr = `(${pL}) + 2 * (${pR}) * (1 + 1.45 * (${pP})) + (${wgWidthExpr})`;
      const hExpr = `(${pR}) * (2 + 0.754 * (${pP})) + (${wgWidthExpr})`;

      const newComp = {
        id,
        kind: 'racetrack',
        layer: 'waveguide',
        // Centroid placed at the viewport center so the user sees it
        // appear where they're looking.
        cx: viewport.x, cy: viewport.y,
        R: pR, L_straight: pL, p: pP,
        wgWidth: wgWidthExpr,
        w: wExpr, h: hExpr,
        cutouts: [], transforms: [],
        label: id,
      };
      return {
        ...prev,
        params: newParams,
        components: [...prev.components, newComp],
      };
    });
  };

  // Drop a library item into the current scene at viewport center
  const insertLibraryItem = async (name) => {
    const item = await loadLibraryItem(workspace, name);
    if (!item) { await alertDialog('Failed to load library item.', 'Error'); return; }

    updateScene(prev => {
      const newParams = { ...prev.params };
      const newComponents = [...prev.components];
      const newSnaps = [...prev.snaps];

      // Identify which params in the payload are "group-aliased" vs "global".
      // Aliased params are the ones that appear as VALUES in some group's aliases map.
      // Global params (e.g., w_wg, cap_gap) are everything else.
      const aliasedParamNames = new Set();
      for (const g of (item.groups || [])) {
        for (const aliasName of Object.values(g.aliases || {})) {
          aliasedParamNames.add(aliasName);
        }
      }

      // Build paramMap with this rule:
      //   - If the name is GLOBAL and already exists in the destination → reuse existing (no rename)
      //   - If the name is GLOBAL and doesn't exist → add it (no rename)
      //   - If the name is ALIASED → always create a fresh, unique alias name
      //     (so each insertion gets its own group_x_<orig>, group_x_2_<orig>, ...)
      const paramMap = {};
      const usedParamNames = new Set(Object.keys(prev.params));
      for (const pname of Object.keys(item.params || {})) {
        if (aliasedParamNames.has(pname)) {
          // Force a unique name for this aliased param
          let newName = pname;
          let i = 2;
          while (usedParamNames.has(newName)) { newName = `${pname}_${i++}`; }
          usedParamNames.add(newName);
          paramMap[pname] = newName;
        } else {
          // Global: reuse if exists, otherwise add as-is
          paramMap[pname] = pname;
          if (!prev.params[pname]) usedParamNames.add(pname);
        }
      }

      const idMap = {};
      const usedCompIds = new Set(prev.components.map(c => c.id));
      for (const c of item.components) {
        let newId = c.id;
        let i = 2;
        while (usedCompIds.has(newId)) { newId = `${c.id}_${i++}`; }
        usedCompIds.add(newId);
        idMap[c.id] = newId;
      }

      const replaceIn = (expr) => {
        if (typeof expr !== 'string') return expr;
        let out = expr;
        // Sort longer-first to avoid partial replacement
        const keys = Object.keys(paramMap).filter(k => paramMap[k] !== k).sort((a, b) => b.length - a.length);
        for (const k of keys) {
          out = out.replace(new RegExp(`\\b${k}\\b`, 'g'), paramMap[k]);
        }
        return out;
      };

      // Add params: only the renamed (aliased) ones, OR globals that don't already exist.
      // Don't overwrite an existing global with the payload's copy.
      for (const [origName, p] of Object.entries(item.params || {})) {
        const newName = paramMap[origName];
        if (aliasedParamNames.has(origName)) {
          // Aliased params: their `expr` typically references a global (e.g., "cap_gap").
          // Apply replaceIn to handle the (rare) case where expr references something renamed.
          newParams[newName] = { ...p, expr: replaceIn(p.expr) };
        } else {
          // Global param: only add if missing
          if (!prev.params[newName]) {
            newParams[newName] = { ...p, expr: replaceIn(p.expr) };
          }
        }
      }


      // Compute insertion offset: place around viewport center, offset from existing items
      const cx0 = viewport.x;
      const cy0 = viewport.y;
      // Original bbox of imported item
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const c of item.components) {
        const w = evalExpr(c.w, paramValues) || 10;
        const h = evalExpr(c.h, paramValues) || 10;
        minX = Math.min(minX, c.cx - w / 2);
        maxX = Math.max(maxX, c.cx + w / 2);
        minY = Math.min(minY, c.cy - h / 2);
        maxY = Math.max(maxY, c.cy + h / 2);
      }
      const itemCx = (minX + maxX) / 2;
      const itemCy = (minY + maxY) / 2;
      const dx = cx0 - itemCx;
      const dy = cy0 - itemCy;

      for (const c of item.components) {
        newComponents.push({
          ...c,
          id: idMap[c.id],
          cx: c.cx + dx,
          cy: c.cy + dy,
          w: replaceIn(c.w),
          h: replaceIn(c.h),
          cutouts: (c.cutouts || []).map(cu => ({
            ...cu,
            dx: replaceIn(cu.dx), dy: replaceIn(cu.dy),
            w: replaceIn(cu.w), h: replaceIn(cu.h),
          })),
          // group is replaced with the freshly-renamed group below
          group: undefined,
        });
      }
      for (const s of (item.snaps || [])) {
        newSnaps.push({
          ...s,
          id: `snap_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          from: { ...s.from, compId: idMap[s.from.compId] },
          to: { ...s.to, compId: idMap[s.to.compId] },
          dx: replaceIn(s.dx),
          dy: replaceIn(s.dy),
        });
      }

      // Rebuild groups with fresh names + remapped member IDs + remapped alias names
      const newGroups = [...prev.groups];
      const usedGroupNames = new Set(prev.groups.map(g => g.name));
      const groupNameMap = {};
      for (const g of (item.groups || [])) {
        let gname = g.name;
        let i = 2;
        while (usedGroupNames.has(gname)) { gname = `${g.name}_${i++}`; }
        usedGroupNames.add(gname);
        groupNameMap[g.name] = gname;

        // Remap aliases. Each alias was a parameter name like `<groupName>_<orig>`.
        // After paramMap remapping, the new alias name = paramMap[oldAliasName] (which may have changed
        // for collision avoidance), and the original it points to = paramMap[orig] (the param it aliased).
        const newAliases = {};
        for (const [orig, oldAlias] of Object.entries(g.aliases || {})) {
          const newOrig = paramMap[orig] || orig;
          const newAlias = paramMap[oldAlias] || oldAlias;
          newAliases[newOrig] = newAlias;
        }
        const newGroup = {
          id: `group_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`,
          name: gname,
          memberIds: g.memberIds.map(id => idMap[id]).filter(Boolean),
          aliases: newAliases,
        };
        newGroups.push(newGroup);
        // Stamp components with new group name
        for (const memberNewId of newGroup.memberIds) {
          const idx = newComponents.findIndex(c => c.id === memberNewId);
          if (idx >= 0) newComponents[idx] = { ...newComponents[idx], group: gname };
        }
      }

      return {
        ...prev,
        params: newParams,
        components: newComponents,
        snaps: newSnaps,
        groups: newGroups,
      };
    });
  };

  // ----- Library export / import -----
  // Snapshot the active workspace's library (active + archived) as a JSON
  // bundle and trigger a download. Format mirrors the workspace bundle but
  // OMITS designs, so the file is small and obviously a "library kit". The
  // `format` field is distinct from workspace bundles so import detection
  // can distinguish them.
  const handleExportLibrary = async () => {
    const lib = {};
    for (const n of await listLibraryItems(workspace)) {
      const d = await loadLibraryItem(workspace, n);
      if (d) lib[n] = d;
    }
    const archive = {};
    for (const n of await listArchivedLibraryItems(workspace)) {
      const d = await loadArchivedLibraryItem(workspace, n);
      if (d) archive[n] = d;
    }
    const libCount = Object.keys(lib).length;
    const archCount = Object.keys(archive).length;
    if (libCount + archCount === 0) {
      const proceed = await confirmDialog('Library is empty. Download an empty bundle anyway?', 'Empty library');
      if (!proceed) return;
    }
    const bundle = {
      format: 'photonic_layout_library',
      version: 1,
      exportedAt: new Date().toISOString(),
      workspace,
      library: lib,
      libraryArchive: archive,
    };
    const wsLabel = workspace || 'default';
    const filename = `photonic_layout_library_${wsLabel}_${new Date().toISOString().slice(0, 10)}.json`;
    downloadFile(filename, JSON.stringify(bundle, null, 2), 'application/json;charset=utf-8');
  };

  // Import a library bundle JSON into the active workspace's library.
  // Accepts both library bundles AND workspace bundles (in which case we
  // pull only the library/archive sections, ignoring designs). Asks the
  // user whether to merge or replace, then commits.
  const handleImportLibrary = async () => {
    const useFileInput = () => new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'application/json,.json';
      input.onchange = (e) => resolve(e.target.files?.[0] || null);
      input.click();
    });
    let file = null;
    try {
      if ('showOpenFilePicker' in window && !fsBlockedAtRuntime) {
        try {
          const [h] = await window.showOpenFilePicker({
            types: [{
              description: 'PhotonicLayout library or workspace',
              accept: { 'application/json': ['.json'] },
            }],
            multiple: false,
          });
          file = await h.getFile();
        } catch (e) {
          if (e?.name === 'AbortError') return;
          const msg = String(e?.message || '');
          const isSandboxed =
            e?.name === 'SecurityError' ||
            /Cross[- ]origin|sub[- ]?frames?|sandboxed?/i.test(msg);
          if (isSandboxed) {
            setFsBlockedAtRuntime(true);
            file = await useFileInput();
          } else {
            throw e;
          }
        }
      } else {
        file = await useFileInput();
      }
    } catch (e) {
      if (e?.name === 'AbortError') return;
      await alertDialog(`Could not open file: ${e.message}`, 'Import error');
      return;
    }
    if (!file) return;
    let bundle;
    try {
      bundle = JSON.parse(await file.text());
    } catch (err) {
      await alertDialog(`Could not parse file: ${err.message}`, 'Import error');
      return;
    }
    const fmt = bundle?.format;
    if (fmt !== 'photonic_layout_library' && fmt !== 'photonic_layout_workspace') {
      await alertDialog(
        'Not a recognized library or workspace file (expected format = "photonic_layout_library" or "photonic_layout_workspace").',
        'Import error'
      );
      return;
    }
    const lib = bundle.library || {};
    const archive = bundle.libraryArchive || {};
    const libCount = Object.keys(lib).length;
    const archCount = Object.keys(archive).length;
    if (libCount + archCount === 0) {
      await alertDialog('File contains no library items.', 'Nothing to import');
      return;
    }
    const wsLabel = workspace || 'default';
    const sourceNote = fmt === 'photonic_layout_workspace'
      ? '\n\n(Pulling library/archive only; the file\'s designs are ignored.)'
      : '';
    const proceed = await confirmDialog(
      `Import:\n  • ${libCount} library item${libCount === 1 ? '' : 's'}\n  • ${archCount} archived item${archCount === 1 ? '' : 's'}\n\ninto workspace "${wsLabel}"?${sourceNote}`,
      'Import library'
    );
    if (!proceed) return;
    const replace = await confirmDialog(
      `Replace mode: WIPE the existing library in "${wsLabel}" first?\n\n• Yes = replace everything (destructive)\n• No = merge (keep existing names; imported duplicates will be skipped)`,
      'Import mode'
    );
    let counts = { library: 0, archive: 0, skipped: [] };
    try {
      if (replace) {
        for (const n of await listLibraryItems(workspace)) await deleteLibraryItem(workspace, n);
        for (const n of await listArchivedLibraryItems(workspace)) await deleteArchivedLibraryItem(workspace, n);
      }
      const existingLib = new Set(await listLibraryItems(workspace));
      const existingArch = new Set(await listArchivedLibraryItems(workspace));
      for (const [n, payload] of Object.entries(lib)) {
        if (!replace && existingLib.has(n)) { counts.skipped.push(`library:${n}`); continue; }
        if (await saveLibraryItem(workspace, n, payload)) counts.library++;
      }
      for (const [n, payload] of Object.entries(archive)) {
        if (!replace && existingArch.has(n)) { counts.skipped.push(`archive:${n}`); continue; }
        if (await saveArchivedLibraryItem(workspace, n, payload)) counts.archive++;
      }
      await refreshLibrary();
      // Mirror to linked workspace file if any (the library is part of the
      // workspace bundle).
      mirrorWorkspaceToFileIfLinked();
    } catch (err) {
      await alertDialog(`Import failed: ${err.message}`, 'Import error');
      return;
    }
    const skipNote = counts.skipped.length > 0
      ? `\n\nSkipped ${counts.skipped.length} item${counts.skipped.length === 1 ? '' : 's'} due to name collision.`
      : '';
    await alertDialog(
      `Imported:\n  • ${counts.library} library item${counts.library === 1 ? '' : 's'}\n  • ${counts.archive} archived item${counts.archive === 1 ? '' : 's'}${skipNote}`,
      'Import complete'
    );
  };

  // Archive a library item: move it from the active prefix to the archive prefix.
  const archiveLibraryEntry = async (name) => {
    const item = await loadLibraryItem(workspace, name);
    if (!item) { await alertDialog('Failed to load library item.', 'Error'); return; }
    // Pick a unique archive name in case of collision
    let archiveName = name;
    let i = 2;
    while (archivedLibraryItems.includes(archiveName)) { archiveName = `${name}_${i++}`; }
    const ok = await saveArchivedLibraryItem(workspace, archiveName, { ...item, archivedAt: Date.now(), originalName: name });
    if (!ok) { await alertDialog('Archive failed.', 'Error'); return; }
    await deleteLibraryItem(workspace, name);
    await refreshLibrary();
  };

  // Rename a library item. Updates the storage key, the payload's name field,
  // the synthetic group's name, alias prefixes, and any references to those aliases
  // in params/components/snaps. Identifier-aware: only renames `oldname_*` tokens.
  const renameLibraryEntry = async (oldName, newName) => {
    const trimmed = (newName || '').trim();
    if (!trimmed || trimmed === oldName) return;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) {
      await alertDialog('Library name must start with a letter or underscore and contain only letters, digits, and underscores.', 'Invalid name');
      return;
    }
    if (libraryItems.includes(trimmed)) {
      await alertDialog(`A library item named "${trimmed}" already exists.`, 'Name in use');
      return;
    }
    const item = await loadLibraryItem(workspace, oldName);
    if (!item) { await alertDialog('Failed to load library item.', 'Error'); return; }

    // Substitute "oldName_" with "newName_" anywhere it appears as a leading identifier.
    const re = new RegExp(`\\b${oldName.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}_`, 'g');
    const subStr = (s) => (typeof s === 'string' ? s.replace(re, `${trimmed}_`) : s);
    const subKey = (k) => subStr(k);

    // Rebuild params with updated keys (and updated descriptions if they reference the old name)
    const newParams = {};
    for (const [k, p] of Object.entries(item.params || {})) {
      newParams[subKey(k)] = {
        expr: subStr(p.expr),
        unit: p.unit,
        desc: typeof p.desc === 'string' ? p.desc.replace(new RegExp(`\\[${oldName}\\]`, 'g'), `[${trimmed}]`).replace(re, `${trimmed}_`) : p.desc,
      };
    }
    // Rebuild components: rewrite expression fields, plus the `group` field
    const newComponents = (item.components || []).map(c => ({
      ...c,
      group: c.group === oldName ? trimmed : c.group,
      w: subStr(c.w),
      h: subStr(c.h),
      cutouts: (c.cutouts || []).map(cu => ({
        ...cu, dx: subStr(cu.dx), dy: subStr(cu.dy), w: subStr(cu.w), h: subStr(cu.h),
      })),
    }));
    // Rebuild snaps
    const newSnaps = (item.snaps || []).map(s => ({ ...s, dx: subStr(s.dx), dy: subStr(s.dy) }));
    // Rebuild groups: rename the synthetic group, update its aliases values
    const newGroups = (item.groups || []).map(g => {
      const newAliases = {};
      for (const [orig, alias] of Object.entries(g.aliases || {})) newAliases[orig] = subStr(alias);
      return {
        ...g,
        name: g.name === oldName ? trimmed : g.name,
        aliases: newAliases,
      };
    });

    const newPayload = {
      ...item,
      name: trimmed,
      params: newParams,
      components: newComponents,
      snaps: newSnaps,
      groups: newGroups,
    };

    const ok = await saveLibraryItem(workspace, trimmed, newPayload);
    if (!ok) { await alertDialog('Rename failed.', 'Error'); return; }
    await deleteLibraryItem(workspace, oldName);
    await refreshLibrary();
  };

  // Restore an archived item back to the active library.
  const restoreLibraryEntry = async (name) => {
    const item = await loadArchivedLibraryItem(workspace, name);
    if (!item) { await alertDialog('Failed to load archived item.', 'Error'); return; }
    // If a name collision exists in the active library, pick a unique one
    let restoreName = item.originalName || name;
    let i = 2;
    while (libraryItems.includes(restoreName)) { restoreName = `${item.originalName || name}_${i++}`; }
    const cleaned = { ...item };
    delete cleaned.archivedAt;
    delete cleaned.originalName;
    const ok = await saveLibraryItem(workspace, restoreName, cleaned);
    if (!ok) { await alertDialog('Restore failed.', 'Error'); return; }
    await deleteArchivedLibraryItem(workspace, name);
    await refreshLibrary();
  };

  // Permanently delete an archived item.
  const deleteArchivedEntry = async (name) => {
    const ok = await confirmDialog(
      `Permanently delete archived item "${name}"?\n\nThis cannot be undone.`,
      'Delete forever'
    );
    if (!ok) return;
    await deleteArchivedLibraryItem(workspace, name);
    await refreshLibrary();
  };

  // ----- Workspace ↔ file linking -----
  // Snapshot the active workspace as a JSON Blob and trigger a browser
  // download. Used as a fallback when File System Access linking isn't
  // available (Safari/Firefox, or when the page is in a sandboxed iframe).
  const handleDownloadWorkspaceSnapshot = async () => {
    let bundle;
    try {
      bundle = await exportWorkspace(workspace);
    } catch (e) {
      await alertDialog(`Snapshot failed: ${e.message}`, 'Error');
      return;
    }
    const designCount = Object.keys(bundle.designs || {}).length;
    const libCount = Object.keys(bundle.library || {}).length;
    const archCount = Object.keys(bundle.libraryArchive || {}).length;
    if (designCount + libCount + archCount === 0) {
      const proceed = await confirmDialog('This workspace is empty. Download an empty bundle anyway?', 'Empty workspace');
      if (!proceed) return;
    }
    const json = JSON.stringify(bundle, null, 2);
    const wsLabel = workspace || 'default';
    const filename = `photonic_layout_${wsLabel}_${new Date().toISOString().slice(0, 10)}.json`;
    downloadFile(filename, json, 'application/json;charset=utf-8');
  };

  // Link the active workspace to a NEW file on disk via showSaveFilePicker
  // (creates or overwrites). After linking, every save mirrors the workspace
  // bundle to that file. We also write the file immediately so the on-disk
  // state matches the in-browser state right away.
  const handleLinkWorkspaceToFile = async () => {
    if (!fsAccessAPIPresent) {
      await alertDialog(
        'Your browser does not support direct file linking (the File System Access API).\n\nUse Chrome or Edge to enable this feature. You can still use "Download workspace" below to snapshot to a JSON file manually, and re-import via "Import workspace from file…".',
        'Not supported'
      );
      return;
    }
    let handle;
    try {
      const wsLabel = workspace || 'default';
      handle = await window.showSaveFilePicker({
        suggestedName: `photonic_layout_${wsLabel}.json`,
        types: [{
          description: 'PhotonicLayout workspace',
          accept: { 'application/json': ['.json'] },
        }],
      });
    } catch (e) {
      // User cancelled — silently abort
      if (e?.name === 'AbortError') return;
      // Cross-origin sandboxed iframe restriction: the picker is permanently
      // unavailable in this hosting context. Mark fsBlockedAtRuntime so the
      // UI hides the "Link to file…" option and surfaces "Download workspace"
      // as the recommended path. Browsers throw a SecurityError or a
      // TypeError with this message — match on the message text since the
      // error class isn't standardized.
      const msg = String(e?.message || '');
      const isSandboxed =
        e?.name === 'SecurityError' ||
        /Cross[- ]origin|sub[- ]?frames?|sandboxed?/i.test(msg);
      if (isSandboxed) {
        setFsBlockedAtRuntime(true);
        const offer = await confirmDialog(
          'Direct file linking is blocked in this browsing context (likely a sandboxed iframe). Use "Download workspace" instead to snapshot to a JSON file you can re-import later.\n\nDownload now?',
          'Linking unavailable here'
        );
        if (offer) await handleDownloadWorkspaceSnapshot();
        return;
      }
      await alertDialog(`Could not open file picker: ${msg}`, 'Error');
      return;
    }
    // Persist + write current bundle.
    await setWorkspaceHandle(workspace, handle);
    setWorkspaceHandle(handle);
    setWorkspaceFileLabel(handle.name || '');
    try {
      const bundle = await exportWorkspace(workspace);
      const ok = await writeBundleToHandle(handle, bundle);
      if (!ok) {
        await alertDialog('Linked the file, but the initial write failed. Permission may have been denied.', 'Warning');
      }
    } catch (e) {
      await alertDialog(`Initial sync failed: ${e.message}`, 'Warning');
    }
  };

  // Unlink the workspace from its current file. The file on disk is left
  // untouched; we just stop mirroring to it.
  const handleUnlinkWorkspaceFile = async () => {
    if (!workspaceHandle) return;
    const ok = await confirmDialog(
      `Unlink workspace "${workspace || 'default'}" from "${workspaceFileLabel || 'file'}"? The file on disk is kept; future saves will no longer mirror to it.`,
      'Unlink workspace file'
    );
    if (!ok) return;
    await setWorkspaceHandle(workspace, null);
    setWorkspaceHandle(null);
    setWorkspaceFileLabel('');
  };

  // Import a workspace from a JSON file. Tries showOpenFilePicker first (so
  // the chosen file becomes a candidate for linking after import), with a
  // hidden <input type="file"> fallback for Safari/Firefox AND for sandboxed
  // iframe contexts where the picker fails at runtime.
  const handleImportWorkspaceFromFile = async () => {
    let file = null;
    let pickedHandle = null;
    const useFileInput = () => new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'application/json,.json';
      input.onchange = (e) => resolve(e.target.files?.[0] || null);
      input.click();
    });
    try {
      if ('showOpenFilePicker' in window && !fsBlockedAtRuntime) {
        try {
          const [h] = await window.showOpenFilePicker({
            types: [{
              description: 'PhotonicLayout workspace',
              accept: { 'application/json': ['.json'] },
            }],
            multiple: false,
          });
          pickedHandle = h;
          file = await h.getFile();
        } catch (e) {
          if (e?.name === 'AbortError') return;
          // Sandbox restriction: same SecurityError pattern as the save
          // picker. Mark blocked and retry with the <input> fallback.
          const msg = String(e?.message || '');
          const isSandboxed =
            e?.name === 'SecurityError' ||
            /Cross[- ]origin|sub[- ]?frames?|sandboxed?/i.test(msg);
          if (isSandboxed) {
            setFsBlockedAtRuntime(true);
            file = await useFileInput();
          } else {
            throw e;
          }
        }
      } else {
        file = await useFileInput();
      }
    } catch (e) {
      if (e?.name === 'AbortError') return;
      await alertDialog(`Could not open file: ${e.message}`, 'Import error');
      return;
    }
    if (!file) return;
    let bundle;
    try {
      const text = await file.text();
      bundle = JSON.parse(text);
    } catch (err) {
      await alertDialog(`Could not parse file: ${err.message}`, 'Import error');
      return;
    }
    if (!bundle || bundle.format !== 'photonic_layout_workspace') {
      await alertDialog('Not a PhotonicLayout workspace file (missing or wrong "format" field).', 'Import error');
      return;
    }
    const designCount = Object.keys(bundle.designs || {}).length;
    const libCount = Object.keys(bundle.library || {}).length;
    const archCount = Object.keys(bundle.libraryArchive || {}).length;
    const wsLabel = workspace || 'default';
    const proceed = await confirmDialog(
      `Import:\n  • ${designCount} design${designCount === 1 ? '' : 's'}\n  • ${libCount} library item${libCount === 1 ? '' : 's'}\n  • ${archCount} archived item${archCount === 1 ? '' : 's'}\n\ninto workspace "${wsLabel}"?`,
      'Import workspace'
    );
    if (!proceed) return;
    const replace = await confirmDialog(
      `Replace mode: WIPE existing data in "${wsLabel}" first?\n\n• Yes = replace everything (destructive)\n• No = merge (keep existing names; imported duplicates will be skipped)`,
      'Import mode'
    );
    try {
      const counts = await importWorkspace(workspace, bundle, replace ? 'replace' : 'merge');
      await refreshSavedList();
      await refreshLibrary();
      // If File System Access gave us a handle, offer to link the workspace
      // to that same file going forward. This makes round-tripping seamless.
      if (pickedHandle && fsLinkAvailable) {
        const linkIt = await confirmDialog(
          `Link workspace "${wsLabel}" to "${file.name}" so future saves auto-mirror to it?`,
          'Link to imported file'
        );
        if (linkIt) {
          await setWorkspaceHandle(workspace, pickedHandle);
          setWorkspaceHandle(pickedHandle);
          setWorkspaceFileLabel(pickedHandle.name || file.name || '');
          // Push current bundle to the file so it reflects the merged state.
          mirrorWorkspaceToFileIfLinked();
        }
      }
      const skipNote = counts.skipped.length > 0 ? `\n\nSkipped ${counts.skipped.length} item${counts.skipped.length === 1 ? '' : 's'} due to name collision.` : '';
      await alertDialog(
        `Imported:\n  • ${counts.designs} design${counts.designs === 1 ? '' : 's'}\n  • ${counts.library} library item${counts.library === 1 ? '' : 's'}\n  • ${counts.archive} archived item${counts.archive === 1 ? '' : 's'}${skipNote}`,
        'Import complete'
      );
    } catch (err) {
      await alertDialog(`Import failed: ${err.message}`, 'Import error');
    }
  };



  // Switch to a different workspace ("folder"). The empty string means the default folder.
  // The workspace useEffect re-triggers loading of the saved-list and active design.
  const handleChangeWorkspace = async (newWs) => {
    const trimmed = (newWs || '').trim();
    // Validation: workspace name must not contain colons (used as the prefix separator)
    if (trimmed.includes(':')) {
      await alertDialog('Workspace name cannot contain ":".', 'Invalid name');
      return;
    }
    if (saveStatus === 'unsaved') {
      const ok = await confirmDialog(`Discard unsaved changes and switch workspace?`, 'Switch workspace');
      if (!ok) return;
    }
    if (trimmed === workspace) return;
    setWorkspace(trimmed);
    await setStoredWorkspace(trimmed);
    setShowWorkspaceDialog(false);
  };

  const [newParamFocus, setNewParamFocus] = useState(null);
  const addParam = () => {
    let i = 1;
    while (scene.params[`p${i}`]) i++;
    const name = `p${i}`;
    // Prepend the new param so it appears at the top of the list (visible immediately)
    updateScene(prev => ({
      ...prev,
      params: { [name]: { expr: '1', unit: 'µm', desc: '' }, ...prev.params }
    }));
    setNewParamFocus(name);
  };

  // Compute which parameters are unused (no expression anywhere references them)
  // Set of parameter names involved in the SELECTED component's definition,
  // computed as the transitive closure of identifiers reachable from its
  // w/h, its cutouts, and the snaps that position it (incoming snaps' dx/dy,
  // plus the chain through the parent — recursing through that parent's w/h
  // and incoming snaps too). Used to highlight parameters in the params list
  // so the user can see at a glance which knobs control the current selection.
  // Returns empty set when nothing is selected.
  const paramsInvolvedInSelection = useMemo(() => {
    const result = new Set();
    if (!selectedId) return result;
    const params = scene.params;
    const compsById = Object.fromEntries(scene.components.map(c => [c.id, c]));
    const incomingSnap = (compId) => scene.snaps.find(s => s.to.compId === compId);
    // Frontier of identifiers we still need to expand. Start with everything
    // referenced by the selected component and the snap chain that places it.
    const frontier = [];
    const seenComps = new Set(); // components whose chain we've already walked
    const walkComp = (compId) => {
      if (seenComps.has(compId)) return;
      seenComps.add(compId);
      const c = compsById[compId];
      if (!c) return;
      // Collect from this component's geometry expressions
      for (const expr of [c.w, c.h]) {
        if (typeof expr !== 'string') continue;
        for (const id of tokenizeIdents(expr)) frontier.push(id);
      }
      for (const cu of (c.cutouts || [])) {
        for (const expr of [cu.dx, cu.dy, cu.w, cu.h]) {
          if (typeof expr !== 'string') continue;
          for (const id of tokenizeIdents(expr)) frontier.push(id);
        }
      }
      // Snap that positions this component (if any) brings in its dx/dy and
      // recursively the parent component's chain.
      const snap = incomingSnap(compId);
      if (snap) {
        for (const expr of [snap.dx, snap.dy]) {
          if (typeof expr !== 'string') continue;
          for (const id of tokenizeIdents(expr)) frontier.push(id);
        }
        walkComp(snap.from.compId);
      }
    };
    walkComp(selectedId);
    // Now expand the frontier: each identifier that names a parameter pulls in
    // that parameter's own expression idents, AND special _comp_<id>_(cx|cy|w|h)
    // synthetics pull in the referenced component's full chain (so span-rect
    // dimensions surface ALL the parents' parameters too).
    while (frontier.length) {
      const id = frontier.pop();
      // Synthetic: pull in the referenced component's chain.
      const syn = id.match(/^_comp_(.+)_(cx|cy|w|h)$/);
      if (syn) { walkComp(syn[1]); continue; }
      if (!(id in params)) continue;
      if (result.has(id)) continue;
      result.add(id);
      // Walk the parameter's own expression for further idents
      const expr = params[id]?.expr;
      if (typeof expr !== 'string') continue;
      for (const childId of tokenizeIdents(expr)) {
        if (childId === id) continue;
        if (!result.has(childId)) frontier.push(childId);
      }
    }
    return result;
  }, [selectedId, scene.params, scene.components, scene.snaps]);

  const unusedParams = useMemo(() => {
    const referenced = new Set();
    const collect = (expr) => {
      if (typeof expr !== 'string') return;
      for (const id of tokenizeIdents(expr)) referenced.add(id);
    };
    // From other parameter expressions
    for (const [name, p] of Object.entries(scene.params)) {
      const idents = tokenizeIdents(p.expr || '');
      for (const id of idents) if (id !== name) referenced.add(id);
    }
    // From components
    for (const c of scene.components) {
      collect(c.w); collect(c.h);
      for (const cu of (c.cutouts || [])) { collect(cu.dx); collect(cu.dy); collect(cu.w); collect(cu.h); }
    }
    // From snaps
    for (const s of scene.snaps) { collect(s.dx); collect(s.dy); }
    // From layer stack: thickness + waveguide-specific cross-section fields
    for (const layer of (scene.stack || [])) {
      collect(layer.thickness);
      collect(layer.core_width);
      collect(layer.slab_height);
      collect(layer.slab_width);
      collect(layer.etch_angle);
    }
    // Unused = defined but not referenced anywhere
    return Object.keys(scene.params).filter(name => !referenced.has(name));
  }, [scene.params, scene.components, scene.snaps, scene.stack]);

  const cleanupUnusedParams = async () => {
    if (unusedParams.length === 0) return;
    const ok = await confirmDialog(
      `Delete ${unusedParams.length} unused parameter${unusedParams.length === 1 ? '' : 's'}?\n\n${unusedParams.join(', ')}`,
      'Cleanup parameters'
    );
    if (!ok) return;
    updateScene(prev => {
      const np = { ...prev.params };
      for (const name of unusedParams) delete np[name];
      return { ...prev, params: np };
    });
  };

  // Inspect the scene for snap-related problems and produce a human-readable report.
  // Categories:
  //   - orphan: snap references a component id that no longer exists
  //   - duplicate_to: more than one snap targets the same `to.compId` — only one wins,
  //     the others silently do nothing (this is the bug behind "snap doesn't lock")
  //   - cycle: snap chain forms a loop, breaking the topological solver
  //   - nan_offset: snap dx or dy evaluates to NaN (broken expression)
  //   - bad_anchor_size: anchor references a component whose w/h evaluates to NaN/0
  const validateScene = (s, paramVals) => {
    const issues = [];
    const compIds = new Set(s.components.map(c => c.id));
    // Orphans
    for (const snap of s.snaps) {
      if (!compIds.has(snap.from.compId)) {
        issues.push({ kind: 'orphan', snapId: snap.id, side: 'from', missing: snap.from.compId, msg: `Snap "${snap.id}" references missing component "${snap.from.compId}" (from)` });
      }
      if (!compIds.has(snap.to.compId)) {
        issues.push({ kind: 'orphan', snapId: snap.id, side: 'to', missing: snap.to.compId, msg: `Snap "${snap.id}" references missing component "${snap.to.compId}" (to)` });
      }
    }
    // Duplicate `to`: more than one snap places the same component. With the
    // current model each component should be the `to` of exactly one snap (new
    // snaps auto-reverse if they would create a duplicate). If we still find
    // duplicates, the scene is from before the auto-reverse fix or was edited
    // manually — flag for cleanup.
    const toCounts = new Map();
    for (const snap of s.snaps) {
      if (!compIds.has(snap.to.compId)) continue;
      if (!toCounts.has(snap.to.compId)) toCounts.set(snap.to.compId, []);
      toCounts.get(snap.to.compId).push(snap);
    }
    for (const [compId, group] of toCounts.entries()) {
      if (group.length > 1) {
        const ids = group.map(sn => sn.id).join(', ');
        issues.push({
          kind: 'duplicate_to',
          compId,
          snapIds: group.map(sn => sn.id),
          msg: `Component "${compId}" is the target of ${group.length} snaps (${ids}). Only one will position it; the others are silent. Reverse the redundant snaps so they push other components instead, or delete them.`,
        });
      }
    }
    // Cycles via topological walk
    const inDeg = new Map();
    const next = new Map();
    for (const c of s.components) { inDeg.set(c.id, 0); next.set(c.id, []); }
    for (const snap of s.snaps) {
      if (!compIds.has(snap.from.compId) || !compIds.has(snap.to.compId)) continue;
      inDeg.set(snap.to.compId, (inDeg.get(snap.to.compId) || 0) + 1);
      next.get(snap.from.compId).push(snap.to.compId);
    }
    const queue = [];
    for (const [id, d] of inDeg.entries()) if (d === 0) queue.push(id);
    let visited = 0;
    while (queue.length > 0) {
      const id = queue.shift();
      visited++;
      for (const tgt of (next.get(id) || [])) {
        const nd = inDeg.get(tgt) - 1;
        inDeg.set(tgt, nd);
        if (nd === 0) queue.push(tgt);
      }
    }
    if (visited < s.components.length) {
      const cyc = [...inDeg.entries()].filter(([, d]) => d > 0).map(([id]) => id);
      issues.push({ kind: 'cycle', compIds: cyc, msg: `Snap chain forms a cycle through: ${cyc.join(', ')}` });
    }
    // NaN offsets
    for (const snap of s.snaps) {
      const dx = evalExpr(snap.dx, paramVals);
      const dy = evalExpr(snap.dy, paramVals);
      if (!Number.isFinite(dx) || !Number.isFinite(dy)) {
        issues.push({ kind: 'nan_offset', snapId: snap.id, msg: `Snap "${snap.id}" has invalid dx="${snap.dx}" or dy="${snap.dy}" (evaluates to NaN)` });
      }
    }
    return issues;
  };

  const diagnoseScene = async () => {
    const issues = validateScene(scene, paramValues);
    if (issues.length === 0) {
      await alertDialog('No issues found. Your scene looks healthy.', 'Diagnose scene');
      return;
    }
    const grouped = {};
    for (const it of issues) { (grouped[it.kind] = grouped[it.kind] || []).push(it); }
    const lines = [];
    if (grouped.duplicate_to) {
      lines.push(`⚠ ${grouped.duplicate_to.length} component(s) targeted by multiple snaps — only one will position each, the others are silent. New snaps now auto-reverse to avoid this; older scenes may need cleanup. Auto-fix can keep the most recent snap and reverse the rest so they push outward through the chain instead:`);
      for (const it of grouped.duplicate_to) lines.push(`    • ${it.msg}`);
      lines.push('');
    }
    if (grouped.orphan) {
      lines.push(`⚠ ${grouped.orphan.length} snap(s) reference deleted components:`);
      for (const it of grouped.orphan) lines.push(`    • ${it.msg}`);
      lines.push('');
    }
    if (grouped.cycle) {
      lines.push(`⚠ Snap chain has cycles:`);
      for (const it of grouped.cycle) lines.push(`    • ${it.msg}`);
      lines.push('');
    }
    if (grouped.nan_offset) {
      lines.push(`⚠ ${grouped.nan_offset.length} snap(s) with broken dx/dy expressions:`);
      for (const it of grouped.nan_offset) lines.push(`    • ${it.msg}`);
      lines.push('');
    }
    const fixable = (grouped.orphan?.length || 0) + (grouped.duplicate_to?.length || 0);
    if (fixable > 0) {
      lines.push('');
      lines.push(`Auto-fix is available: removes orphaned snaps and reverses redundant duplicate-target snaps so they propagate outward through the chain instead of being silent.`);
      const ok = await confirmDialog(lines.join('\n') + '\n\nApply auto-fix now?', 'Diagnose scene');
      if (ok) autoFixSnaps();
    } else {
      await alertDialog(lines.join('\n'), 'Diagnose scene');
    }
  };

  const autoFixSnaps = () => {
    updateScene(prev => {
      const compIds = new Set(prev.components.map(c => c.id));
      // 1) Drop orphans (snaps referencing deleted components).
      let snaps = prev.snaps.filter(s => compIds.has(s.from.compId) && compIds.has(s.to.compId));
      // 2) Resolve duplicate-`to` collisions by reversing later snaps where
      //    possible. Iterate in array order. Each `to.compId` can only be
      //    claimed once. Subsequent snaps targeting a claimed `to`: if their
      //    `from` isn't itself claimed as a `to`, reverse so the `from` becomes
      //    the moved one. Otherwise drop the snap (truly redundant).
      const claimed = new Set();
      const newParams = { ...prev.params };
      const fixed = [];
      const paramRefCount = (paramName) => {
        // count references to a param across components and snaps; >1 means
        // shared, 1 (just this snap) means we can flip its sign in place.
        let n = 0;
        for (const sn of snaps) { if (sn.dx === paramName) n++; if (sn.dy === paramName) n++; }
        for (const c of prev.components) {
          for (const f of ['w', 'h']) if (c[f] === paramName) n++;
          for (const cu of (c.cutouts || [])) {
            for (const f of ['dx', 'dy', 'w', 'h']) if (cu[f] === paramName) n++;
          }
        }
        for (const [, p] of Object.entries(prev.params)) {
          if (typeof p.expr === 'string' && tokenizeIdents(p.expr).includes(paramName)) n++;
        }
        return n;
      };
      for (const s of snaps) {
        if (!claimed.has(s.to.compId)) {
          claimed.add(s.to.compId);
          fixed.push(s);
          continue;
        }
        // `to` already claimed; can we reverse?
        if (!claimed.has(s.from.compId)) {
          // Reverse direction. To negate offsets: if dx/dy are unique parameter
          // names, mutate the param expression in place; otherwise wrap with -().
          const negateOffset = (offsetExpr) => {
            if (typeof offsetExpr !== 'string') return offsetExpr;
            const stripped = offsetExpr.trim();
            // If it's a sole identifier referring to a parameter that exists,
            // and that parameter is referenced ONLY by this snap, flip its expr.
            if (/^[A-Za-z_][\w]*$/.test(stripped) && newParams[stripped]) {
              const refs = paramRefCount(stripped);
              if (refs <= 2) {
                // Edit the param's expr to be its negation.
                const old = newParams[stripped].expr;
                const newExpr = `-(${old})`;
                newParams[stripped] = { ...newParams[stripped], expr: newExpr };
                return stripped; // keep the same name; expr now negated
              }
            }
            // Fallback: wrap inline
            return `-(${offsetExpr})`;
          };
          fixed.push({
            ...s,
            from: { compId: s.to.compId, anchor: s.to.anchor },
            to: { compId: s.from.compId, anchor: s.from.anchor },
            dx: negateOffset(s.dx),
            dy: negateOffset(s.dy),
          });
          claimed.add(s.from.compId);
        } else {
          // Both ends already claimed. Drop the snap.
        }
      }
      return { ...prev, snaps: fixed, params: newParams };
    });
  };

  // Live count of scene issues (orphan/duplicate-to/cycle/NaN snaps); badges the Diagnose button.
  const sceneIssues = useMemo(() => {
    try { return validateScene(scene, paramValues); }
    catch { return []; }
  }, [scene, paramValues]);

  const updateParam = (name, patch) => {
    updateScene(prev => ({
      ...prev,
      params: { ...prev.params, [name]: { ...prev.params[name], ...patch } },
    }));
  };

  // Compute a params patch to auto-create any identifiers in `expr` that aren't
  // already parameters. Returns { ...newParams } that can be merged into params.
  // `defaultValue` is the literal expression to assign (string), `defaultUnit` the unit string.
  const autoCreateMissingParams = (existingParams, expr, defaultValue = '0', defaultUnit = 'µm', descPrefix = 'Auto-created') => {
    if (typeof expr !== 'string') return null;
    const idents = tokenizeIdents(expr);
    const created = {};
    for (const id of idents) {
      if (RESERVED_IDENTS.has(id)) continue;
      if (existingParams[id]) continue;
      if (created[id]) continue;
      // Skip if it looks like a number (shouldn't happen since tokenizer requires letter/_, but be safe)
      if (/^\d/.test(id)) continue;
      created[id] = {
        expr: defaultValue,
        unit: defaultUnit,
        desc: `${descPrefix} (used in expression)`,
      };
    }
    return Object.keys(created).length > 0 ? created : null;
  };

  // commitExpr: invoked when an expression-bearing input is committed (blur or Enter).
  // Walks the expression for identifiers, creates any missing params with sensible
  // defaults, and merges them into scene.params. Pure no-op if expr has no missing idents.
  // Pass `excludeName` to avoid auto-creating the param being edited (used when editing
  // a parameter's own expression — the param itself shouldn't be auto-created).
  const commitExpr = (expr, defaultValue = '0', defaultUnit = 'µm', descPrefix = 'Auto-created', excludeName = null) => {
    if (typeof expr !== 'string' || expr.length === 0) return;
    updateScene(prev => {
      const created = autoCreateMissingParams(prev.params, expr, defaultValue, defaultUnit, descPrefix);
      if (!created) return prev;
      if (excludeName && created[excludeName]) delete created[excludeName];
      if (Object.keys(created).length === 0) return prev;
      return { ...prev, params: { ...prev.params, ...created } };
    });
  };

  const renameParam = (oldName, newName) => {
    if (!newName || oldName === newName || scene.params[newName]) return;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(newName)) return;
    updateScene(prev => {
      const newParams = {};
      for (const [k, v] of Object.entries(prev.params)) newParams[k === oldName ? newName : k] = v;
      const repl = (e) => typeof e === 'string' ? e.replace(new RegExp(`\\b${oldName}\\b`, 'g'), newName) : e;
      // Replace inside other params' expressions too
      for (const k of Object.keys(newParams)) newParams[k] = { ...newParams[k], expr: repl(newParams[k].expr) };
      const newComps = prev.components.map(c => ({ ...c, w: repl(c.w), h: repl(c.h) }));
      const newSnaps = prev.snaps.map(s => ({ ...s, dx: repl(s.dx), dy: repl(s.dy) }));
      return { ...prev, params: newParams, components: newComps, snaps: newSnaps };
    });
  };

  const deleteParam = async (name) => {
    // Don't allow deletion if the parameter is referenced by ANY layer field in the stack
    const STACK_EXPR_FIELDS = ['thickness', 'core_width', 'slab_height', 'slab_width', 'etch_angle'];
    const findUsingLayer = () => {
      for (const l of (scene.stack || [])) {
        for (const f of STACK_EXPR_FIELDS) {
          const v = l[f];
          if (typeof v === 'string' && tokenizeIdents(v).includes(name)) {
            return { layer: l, field: f };
          }
        }
      }
      return null;
    };
    const usage = findUsingLayer();
    if (usage) {
      await alertDialog(
        `Can't delete "${name}" — it's used by the "${usage.layer.name}" layer (${usage.field}) in the stack. Edit or remove that layer first (LAYERS tab).`,
        'Parameter in use'
      );
      return;
    }
    updateScene(prev => {
      const np = { ...prev.params };
      delete np[name];
      return { ...prev, params: np };
    });
  };

  const createMirror = (axis) => {
    if (!selected) return;
    const mirrorId = `${selected.id}_mir`;
    let mid = mirrorId; let sfx = 0;
    while (scene.components.some(c => c.id === mid)) { sfx++; mid = `${mirrorId}_${sfx}`; }
    const mirrorComp = {
      ...selected, id: mid,
      cx: axis === 'vertical' ? -selected.cx : selected.cx,
      cy: axis === 'horizontal' ? -selected.cy : selected.cy,
      label: `${selected.label || selected.id} (mirror)`,
    };
    const mirror = { id: `mir_${Date.now().toString(36).slice(-4)}`, axis, axisCoord: 0, members: [{ srcId: selected.id, mirrorId: mid, locked: true }] };
    updateScene(prev => ({ ...prev, components: [...prev.components, mirrorComp], mirrors: [...prev.mirrors, mirror] }));
  };

  const toggleMirrorLock = (mirrorId, memberIdx) => {
    updateScene(prev => ({
      ...prev,
      mirrors: prev.mirrors.map(m => m.id === mirrorId ? { ...m, members: m.members.map((mm, i) => i === memberIdx ? { ...mm, locked: !mm.locked } : mm) } : m)
    }));
  };

  const deleteMirror = (mirrorId) => updateScene(prev => ({ ...prev, mirrors: prev.mirrors.filter(m => m.id !== mirrorId) }));

  // ----- Boolean operations -----
  // Create a derived (boolean) component from the current selection. The
  // derived component is a new entry in scene.components with kind='boolean',
  // consuming its operands (which get a `consumedBy` tag pointing back at
  // the new component's id). Consumed operands are hidden from the SHAPES
  // list, snap targets, and standalone rendering — they appear only as
  // sub-entries inside the derived component's history. The derived
  // component has its own cx/cy (centroid of operand bbox at creation),
  // its own transforms, and exports as a single HFSS part via the chosen
  // Unite/Intersect/Subtract operation. Just like in HFSS: the boolean
  // result is a new part with a name; the operands are gone from the tree
  // (kept in the data so geometry can be re-resolved if the user toggles
  // the boolean off).
  const createBoolean = (op) => {
    const ids = Array.from(selectedIds);
    if (ids.length < 2) return;
    // Disallow operands that are already consumed (you can build booleans
    // OF booleans — that's fine — but not select an inner operand directly).
    const operandsOk = ids.every(id => {
      const c = scene.components.find(cc => cc.id === id);
      return c && !c.consumedBy;
    });
    if (!operandsOk) {
      alertDialog('One or more selected shapes is already part of another boolean. Use the parent boolean instead.', 'Cannot combine');
      return;
    }
    // Compute the centroid of operand bboxes from the SOLVED scene so the
    // new component starts at the cluster's geometric center. After this
    // the boolean's cx/cy is what gets dragged; operand cx/cy stays at
    // its current absolute position (i.e. operand.cx is independent of
    // the parent's cx). When the user drags the boolean, all operands
    // translate by the same delta — handled by the move-drag's coMovers.
    const solvedNow = applyMirrors(solveLayout(scene.components, scene.snaps, paramValues), scene.mirrors);
    let cxSum = 0, cySum = 0;
    for (const id of ids) {
      const c = solvedNow.find(cc => cc.id === id);
      if (c) { cxSum += c.cx; cySum += c.cy; }
    }
    const cx = cxSum / ids.length;
    const cy = cySum / ids.length;
    // Pick the layer of the FIRST operand for the result (HFSS-style: the
    // result inherits the blank/base operand's properties).
    const baseOp = scene.components.find(c => c.id === ids[0]);
    const layer = baseOp?.layer || 'waveguide';
    const conductorLayerId = baseOp?.conductorLayerId;
    // Choose a fresh ID. Format: `<op><n>` so it reads like a normal comp.
    const prefix = op === 'union' ? 'union' : (op === 'intersect' ? 'isect' : 'diff');
    let n = 1;
    while (scene.components.some(c => c.id === `${prefix}${n}`)) n++;
    const newId = `${prefix}${n}`;
    const derived = {
      id: newId,
      kind: 'boolean',
      op,
      operandIds: ids,
      layer,
      cx, cy,
      // Width/height aren't independent here — they're derived from the
      // result of the boolean op. We still store nominal values for code
      // paths that read c.w/c.h directly; expandTransforms treats this
      // component specially.
      w: '0', h: '0',
      cutouts: [],
      transforms: [],
      label: '',
      ...(conductorLayerId ? { conductorLayerId } : {}),
    };
    updateScene(prev => ({
      ...prev,
      components: [
        // Tag operands with consumedBy so they're hidden from SHAPES,
        // snap targets, and standalone rendering. They still live in
        // scene.components so their cx/cy/w/h/transforms remain editable
        // through the boolean's history sub-section.
        ...prev.components.map(c => ids.includes(c.id) ? { ...c, consumedBy: newId } : c),
        derived,
      ],
    }));
    setSelection({ ids: new Set([newId]), primary: newId });
  };

  // Update a derived boolean component's own fields (label, op, transforms…).
  const updateBoolean = (id, patch) => {
    updateComp(id, patch);
  };

  // Delete a boolean component. Its operands get released (consumedBy
  // cleared) so they return to the standalone SHAPES list. The boolean
  // entry itself is removed.
  const deleteBoolean = (id) => {
    updateScene(prev => ({
      ...prev,
      components: prev.components
        .filter(c => c.id !== id)
        .map(c => c.consumedBy === id ? { ...c, consumedBy: undefined } : c),
    }));
  };
  // Keep the ref pointing at the current createBoolean so the keyboard
  // handler (registered earlier in the body) can call it without creating
  // a temporal-dead-zone reference.
  createBooleanRef.current = createBoolean;

  const code = useMemo(() => {
    try {
      return generatePyAEDT(scene, paramValues);
    } catch (e) {
      console.error('pyAEDT generation error:', e);
      return `# Error generating script: ${e.message}\n# (See browser console for details)\n`;
    }
  }, [scene, paramValues]);

  const downloadFile = (filename, content, mimeType = null) => {
    try {
      // Detect binary (Uint8Array, ArrayBuffer) and pick a sensible mime type.
      const isBinary = content instanceof Uint8Array || content instanceof ArrayBuffer;
      const type = mimeType || (isBinary ? 'application/octet-stream' : 'text/plain;charset=utf-8');
      const blob = new Blob([content], { type });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      // Some sandboxed iframes don't trigger downloads via <a download>.
      // We keep the URL alive a moment in case the browser handles it asynchronously.
      setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, 100);
      return true;
    } catch (e) {
      console.error('Download error:', e);
      return false;
    }
  };

  // Generic export: generate a script with the given function and present it.
  // Tries to trigger a download; always shows a preview modal so the user can copy
  // the script manually if the sandbox blocks downloads.
  const handleExport = async (filename, generator) => {
    let content;
    try {
      content = generator(scene, paramValues);
    } catch (e) {
      console.error('Generator error:', e);
      await alertDialog('Error generating script: ' + e.message, 'Export error');
      return;
    }
    if (!content) {
      await alertDialog('Failed to generate script.', 'Export error');
      return;
    }
    const ok = downloadFile(filename, content);
    setExportPreview({ filename, content, downloaded: ok });
  };

  const handleExportPyAEDT = () => handleExport('layout.py', generatePyAEDT);
  const handleExportHfssNative = () => handleExport('layout_hfss.py', generateHfssNative);
  const handleExportGDS = async () => {
    let bytes;
    try {
      bytes = generateGDS(scene, paramValues);
    } catch (e) {
      console.error('GDS generator error:', e);
      await alertDialog('Error generating GDS: ' + e.message, 'Export error');
      return;
    }
    if (!bytes || !bytes.length) {
      await alertDialog('Failed to generate GDS.', 'Export error');
      return;
    }
    const ok = downloadFile('layout.gds', bytes, 'application/octet-stream');
    if (!ok) {
      await alertDialog('Failed to start GDS download.', 'Export error');
    } else {
      // Show a brief confirmation in the export preview modal — but with a
      // text summary instead of the binary content (which is unprintable).
      const summary = [
        `GDS-II file: layout.gds (${bytes.length} bytes)`,
        '',
        'Layer mapping:',
        '  1   = waveguide',
        ...Array.from((scene.stack || []).filter(l => l.role === 'conductor')).map((l, i) => `  ${10 + i}  = conductor "${l.name}"`),
        '  100 = port',
        '',
        'Coordinate units: 1 µm = 1000 nm (database unit = 1 nm).',
        '',
        'Notes:',
        '- Cutouts are emitted as separate boundaries on datatype 1, on the same',
        '  layer as the parent component. Most viewers render them as overlapping',
        '  shapes since GDS doesn\'t natively encode subtraction.',
        '- Mirrored components are exported with their solved (mirrored) positions.',
      ].join('\n');
      setExportPreview({ filename: 'layout.gds', content: summary, downloaded: ok, binary: true });
    }
  };

  const layerSwatches = {
    waveguide: { bg: '#14532d', fg: '#86efac' },
    electrode: { bg: '#7c2d12', fg: '#fed7aa' },
  };

  return (
    <div className="h-screen w-full flex flex-col relative" style={{ fontFamily: "'IBM Plex Sans', system-ui, sans-serif", background: '#0f172a', color: '#e2e8f0' }}>
      <header className="border-b border-slate-700" style={{ background: '#020617' }}>
        {/* Row 1 — primary tools and identity */}
        <div className="flex items-center justify-between px-4 py-2">
          <div className="flex items-center gap-3">
            <div className="w-7 h-7 rounded flex items-center justify-center" style={{ background: 'linear-gradient(135deg, #3ec27a, #f4a72e)' }}>
              <Box size={15} className="text-white" />
            </div>
            <div>
              <h1 className="font-bold tracking-tight text-sm" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                PHOTONIC<span className="text-emerald-400">·</span>LAYOUT
              </h1>
              <p className="text-[10px] text-slate-400">parametric primitives · pyAEDT export</p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            {/* Layer dropdown + shape buttons. The user picks a layer once
                (waveguide / conductor / port — and which conductor layer
                if multiple are defined), then clicks a shape button to
                begin a drag-to-create gesture. Active shape button gets a
                green ring; clicking again toggles off. */}
            {(() => {
              const conductors = (scene.stack || []).filter(l => l.role === 'conductor');
              // Build layer dropdown options. Each conductor layer becomes
              // its own entry so the user picks WHICH conductor explicitly.
              const layerOptions = [
                { value: 'waveguide', label: 'Waveguide', conductorLayerId: null },
                ...conductors.map(l => ({ value: `electrode:${l.id}`, label: l.name || l.id, conductorLayerId: l.id })),
                { value: 'port', label: 'Port', conductorLayerId: null },
              ];
              // Selected layer dropdown value. We encode the conductor's id
              // in the value string so distinct conductor layers are
              // distinguishable in a flat <select>.
              const dropdownValue = activeLayer === 'electrode' && activeConductorLayerId
                ? `electrode:${activeConductorLayerId}`
                : activeLayer;
              const layerBg = activeLayer === 'waveguide' ? '#3ec27a'
                : activeLayer === 'port' ? '#b91c1c'
                : '#f4a72e';
              const layerFg = activeLayer === 'port' ? '#fee2e2' : '#1f1300';
              const onLayerChange = (e) => {
                const v = e.target.value;
                if (v.startsWith('electrode:')) {
                  setActiveLayer('electrode');
                  setActiveConductorLayerId(v.slice('electrode:'.length));
                } else {
                  setActiveLayer(v);
                  setActiveConductorLayerId(null);
                }
                // Switching layer cancels any in-progress add mode so the
                // user's next shape-button click starts fresh on the new
                // layer rather than carrying over an old shape selection.
                setAddMode(null);
              };
              // Each shape button toggles addMode. Active state = the
              // current addMode targets the same (layer, shape) tuple.
              const isShapeActive = (shape) => addMode
                && (addMode.layer === activeLayer)
                && (addMode.shape === shape)
                && (activeLayer !== 'electrode' || addMode.conductorLayerId === activeConductorLayerId);
              const toggleShape = (shape) => {
                if (isShapeActive(shape)) {
                  setAddMode(null);
                } else {
                  setAddMode({
                    layer: activeLayer,
                    shape,
                    ...(shape === 'polygon' ? { n: polygonSides } : {}),
                    ...(activeLayer === 'electrode' && activeConductorLayerId
                      ? { conductorLayerId: activeConductorLayerId }
                      : {}),
                  });
                  setSnapMode('idle');
                  setRulerMode(false);
                }
              };
              const baseBtn = 'flex items-center justify-center w-7 h-7 rounded';
              const activeRing = ' ring-2 ring-green-400';
              return (
                <>
                  <select
                    value={dropdownValue}
                    onChange={onLayerChange}
                    className="text-[11px] font-medium px-1.5 py-1 rounded border-0"
                    style={{ background: layerBg, color: layerFg, cursor: 'pointer' }}
                    title="Layer for the next shape created"
                  >
                    {layerOptions.map(o => (
                      <option key={o.value} value={o.value} style={{ background: '#1e293b', color: '#e2e8f0' }}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                  <button
                    key="add-rect"
                    onClick={() => toggleShape('rect')}
                    className={baseBtn + (isShapeActive('rect') ? activeRing : '')}
                    style={{ background: '#1e293b', color: '#e2e8f0' }}
                    title="Add rectangle — drag on canvas to size."
                  >
                    <Square size={13} />
                  </button>
                  <button
                    key="add-circle"
                    onClick={() => toggleShape('circle')}
                    className={baseBtn + (isShapeActive('circle') ? activeRing : '')}
                    style={{ background: '#1e293b', color: '#e2e8f0' }}
                    title="Add circle — drag a bbox; an inscribed circle is created."
                  >
                    <Circle size={13} />
                  </button>
                  <button
                    key="add-ellipse"
                    onClick={() => toggleShape('ellipse')}
                    className={baseBtn + (isShapeActive('ellipse') ? activeRing : '')}
                    style={{ background: '#1e293b', color: '#e2e8f0' }}
                    title="Add ellipse — drag a bbox; the inscribed ellipse fills it."
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <ellipse cx="12" cy="12" rx="10" ry="6" />
                    </svg>
                  </button>
                  <div className="flex items-center gap-0.5">
                    <button
                      key="add-poly"
                      onClick={() => toggleShape('polygon')}
                      className={baseBtn + (isShapeActive('polygon') ? activeRing : '')}
                      style={{ background: '#1e293b', color: '#e2e8f0' }}
                      title={`Add regular polygon (${polygonSides} sides) — drag a bbox; the polygon's circumradius fills it.`}
                    >
                      <Hexagon size={13} />
                    </button>
                    {/* Polygon side count selector. Inline so it's discoverable. */}
                    <input
                      type="number"
                      value={polygonSides}
                      onChange={(e) => {
                        const v = Math.max(3, Math.min(64, parseInt(e.target.value) || 6));
                        setPolygonSides(v);
                        // If polygon-add is active, propagate the new count
                        // so the next drag uses the updated side count.
                        if (addMode && addMode.shape === 'polygon') {
                          setAddMode({ ...addMode, n: v });
                        }
                      }}
                      min={3}
                      max={64}
                      className="w-9 text-[10px] px-1 py-0.5 rounded bg-slate-800 text-slate-200 border border-slate-700"
                      title="Number of sides (3–64)"
                    />
                  </div>
                </>
              );
            })()}
            <button
              onClick={() => { setSnapMode(snapMode === 'creating' ? 'idle' : 'creating'); setAddMode(null); setRulerMode(false); }}
              className={`flex items-center gap-1 px-2 py-1 rounded text-xs font-medium ${snapMode === 'creating' ? 'ring-2 ring-amber-400' : ''}`}
              style={{ background: snapMode === 'creating' ? '#f59e0b' : '#334155', color: snapMode === 'creating' ? '#0f172a' : '#e2e8f0' }}
              title="Pick two anchor points to create a snap. Click one of the 9 fixed dots, or anywhere along an orange edge for a parametric anchor. Hold Shift while picking the second anchor to lock the connection axis-aligned."
            >
              <Link2 size={11} /> {snapMode === 'creating' ? 'pick anchor' : 'snap'}
            </button>
            <button
              onClick={() => {
                if (rulerMode) {
                  setRulerMode(false);
                  setRulerInProgress(null);
                  setRulerSnapPoint(null);
                } else {
                  setRulerMode(true);
                  setSnapMode('idle');
                  setAddMode(null);
                }
              }}
              className={`flex items-center gap-1 px-2 py-1 rounded text-xs font-medium ${rulerMode ? 'ring-2 ring-cyan-400' : ''}`}
              style={{ background: rulerMode ? '#06b6d4' : '#334155', color: rulerMode ? '#0f172a' : '#e2e8f0' }}
              title="Ruler: click two points to measure distance. Snaps to nearby corners, edge midpoints, centers, and edges. Hold Shift while picking the second point to lock the line horizontal or vertical. Esc cancels in-progress, or exits the tool."
            >
              <Ruler size={11} /> {rulerMode ? (rulerInProgress ? 'pick end' : 'pick start') : 'ruler'}
            </button>
            <DropdownMenu
              label="export"
              icon={Download}
              buttonClassName="flex items-center gap-1 px-2 py-1 rounded text-xs font-medium"
              buttonStyle={{ background: '#06b6d4', color: '#0f172a' }}
              items={[
                { label: 'pyAEDT', icon: Download, onClick: handleExportPyAEDT, hint: 'layout.py', title: 'External Python with pyaedt installed (run from terminal: python layout.py)' },
                { label: 'HFSS native', icon: Download, onClick: handleExportHfssNative, hint: 'layout_hfss.py', title: 'Native HFSS COM script (run inside HFSS via Tools -> Run Script)' },
                { label: 'GDS-II', icon: Download, onClick: handleExportGDS, hint: 'layout.gds', title: 'Binary GDS-II layout. Layers: waveguide=1, conductors=10+ (one per stack layer), port=100. Coords in µm with 1nm database resolution.' },
              ]}
            />
            <div className="w-px h-5 bg-slate-700 mx-1" />
            {/* Save / design / workspace */}
            <button onClick={handleSave} className="flex items-center gap-1 px-2 py-1 rounded text-xs font-medium" style={{ background: '#22c55e', color: '#0f172a' }} title="Save (Cmd/Ctrl+S)">
              <Save size={11} /> save
            </button>
            <button
              onClick={() => setShowDesigns(s => !s)}
              className={`flex items-center gap-1 px-2 py-1 rounded text-xs ${showDesigns ? 'bg-cyan-700 text-white' : 'border border-slate-600 hover:bg-slate-800'}`}
              title={`Show saved designs${savedAgoLabel ? ` · autosaved ${savedAgoLabel}` : ''}`}
            >
              <FileText size={11} />
              <span className="font-mono max-w-[10rem] truncate">{designName}</span>
              <span className={`text-[9px] ml-1 ${saveStatus === 'saved' ? 'text-emerald-400' : saveStatus === 'saving' ? 'text-amber-400' : 'text-red-400'}`}>
                {saveStatus === 'saved' ? '●' : saveStatus === 'saving' ? '…' : '○'}
              </span>
              {savedAgoLabel && saveStatus === 'saved' && (
                <span className="text-[9px] text-slate-500 ml-1 normal-case font-normal">{savedAgoLabel}</span>
              )}
            </button>
            <button
              onClick={() => setShowWorkspaceDialog(true)}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium border border-cyan-700 hover:bg-cyan-900/40 hover:border-cyan-500"
              style={{ background: '#164e63', color: '#a5f3fc' }}
              title={workspaceHandle
                ? `Workspace "${workspace || 'default'}" — linked to "${workspaceFileLabel}". Saves auto-mirror to this file. Click to manage.`
                : `Click to switch, create, or link a workspace — currently "${workspace || 'default'}". Each workspace has its own designs, library, and archive.`}
            >
              <FolderTree size={12} />
              <span className="font-mono max-w-[8rem] truncate">{workspace || 'default'}</span>
              {workspaceHandle && (
                <span className="text-[9px] text-emerald-300" title={`Linked: ${workspaceFileLabel}`}>●</span>
              )}
              <span className="text-[9px] opacity-70 normal-case font-normal">▾</span>
            </button>
          </div>
        </div>
        {/* Row 2 — secondary tools and view controls */}
        <div className="flex items-center justify-between px-4 py-1.5 border-t border-slate-800" style={{ background: '#0a0f1f' }}>
          <div className="flex items-center gap-1.5">
            <DropdownMenu
              label="mirror"
              icon={FlipHorizontal}
              disabled={!selected}
              buttonClassName="flex items-center gap-1 px-2 py-1 rounded text-xs disabled:opacity-30"
              buttonStyle={{ background: '#7c3aed', color: 'white' }}
              items={[
                { label: 'Horizontal symmetry', icon: FlipVertical, onClick: () => createMirror('horizontal'), title: 'Mirror selection across a horizontal axis (top↔bottom)' },
                { label: 'Vertical symmetry', icon: FlipHorizontal, onClick: () => createMirror('vertical'), title: 'Mirror selection across a vertical axis (left↔right)' },
              ]}
            />
            <DropdownMenu
              label="bool"
              icon={Combine}
              disabled={selectedIds.size < 2}
              buttonClassName="flex items-center gap-1 px-2 py-1 rounded text-xs disabled:opacity-30"
              buttonStyle={{ background: '#0e7490', color: 'white' }}
              items={[
                { label: 'Union', icon: Combine, onClick: () => createBoolean('union'), hint: `${selectedIds.size} selected`, title: 'Combine all selected shapes into one. Native HFSS/pyAEDT exports use Unite. Canvas keeps showing operands separately (no in-browser polygon clipping yet).' },
                { label: 'Intersect', icon: XIcon, onClick: () => createBoolean('intersect'), hint: `${selectedIds.size} selected`, title: 'Keep only the overlap of all selected shapes. Native HFSS/pyAEDT exports use Intersect.' },
                { label: 'Subtract', icon: Minus, onClick: () => createBoolean('subtract'), hint: `${selectedIds.size} selected`, title: 'Subtract later-selected shapes from the FIRST one. The first selected component is the base; the rest are tools. Native HFSS/pyAEDT exports use Subtract.' },
                { divider: true },
                { label: 'Manage in BOOL panel…', icon: Combine, onClick: () => setActivePanel('booleans'), title: 'Open the BOOL panel to view/edit/toggle all boolean operations defined in this scene.' },
              ]}
            />
            <button
              onClick={diagnoseScene}
              className="flex items-center gap-1 px-2 py-1 rounded text-xs font-medium"
              style={{ background: sceneIssues.length > 0 ? '#dc2626' : '#334155', color: '#e2e8f0' }}
              title={sceneIssues.length === 0
                ? 'Validate scene: check for snap conflicts, orphans, cycles, broken expressions'
                : `${sceneIssues.length} issue${sceneIssues.length === 1 ? '' : 's'} detected — click to diagnose`}
            >
              <AlertTriangle size={11} /> diagnose{sceneIssues.length > 0 ? ` (${sceneIssues.length})` : ''}
            </button>
            {rulerMeasurements.length > 0 && (
              <button
                onClick={() => { setRulerMeasurements([]); setRulerInProgress(null); }}
                className="flex items-center gap-1 px-2 py-1 rounded text-xs"
                style={{ background: '#334155', color: '#e2e8f0' }}
                title={`Clear ${rulerMeasurements.length} measurement${rulerMeasurements.length === 1 ? '' : 's'}`}
              >
                <Trash2 size={11} /> clear ({rulerMeasurements.length})
              </button>
            )}
            <div className="w-px h-5 bg-slate-700 mx-1" />
            <button
              onClick={() => setGridSnapEnabled(g => !g)}
              className={`flex items-center gap-1 px-2 py-1 rounded text-xs ${gridSnapEnabled ? 'bg-cyan-700 text-white' : 'bg-slate-700 text-slate-400'}`}
              title="Grid snap (hold Cmd/Ctrl while dragging to disable temporarily)"
            >
              <Grid3x3 size={11} /> {gridSize}
            </button>
            <input
              type="number" step="0.1" min="0.1"
              value={gridSize}
              onChange={(e) => setGridSize(Math.max(0.1, parseFloat(e.target.value) || 1))}
              className="w-12 bg-slate-800 border border-slate-700 rounded px-1 py-0.5 text-xs text-white outline-none"
            />
            <button onClick={fitToView} className="flex items-center gap-1 px-2 py-1 rounded text-xs border border-slate-600 hover:bg-slate-800" title="Fit all to view (F)">
              <Maximize2 size={11} /> fit
            </button>
            <button
              onClick={() => setShowDimensions(d => !d)}
              className={`flex items-center gap-1 px-2 py-1 rounded text-xs ${showDimensions ? 'bg-violet-600 text-white' : 'border border-slate-600 hover:bg-slate-800'}`}
              title="Show dimension arrows for every parameter-bound width, height, and snap offset. Variable names are the primary label; values appear when there is room."
            >
              <Ruler size={11} /> dimensions
            </button>
          </div>
          <div className="flex items-center gap-1.5">
            <button onClick={undo} disabled={history.length === 0} className="flex items-center gap-1 px-2 py-1 rounded text-xs border border-slate-600 hover:bg-slate-800 disabled:opacity-30" title="Undo (Cmd/Ctrl+Z)">
              <RotateCcw size={11} />
            </button>
            <button onClick={redo} disabled={future.length === 0} className="flex items-center gap-1 px-2 py-1 rounded text-xs border border-slate-600 hover:bg-slate-800 disabled:opacity-30" title="Redo (Cmd/Ctrl+Shift+Z)">
              <RotateCw size={11} />
            </button>
            <div className="w-px h-5 bg-slate-700 mx-1" />
            <button onClick={handleSaveAs} className="flex items-center gap-1 px-2 py-1 rounded text-xs border border-slate-600 hover:bg-slate-800" title="Save as new (Cmd/Ctrl+Shift+S)">
              <Copy size={11} /> save as
            </button>
            <button onClick={handleNewBlank} className="flex items-center gap-1 px-2 py-1 rounded text-xs border border-slate-600 hover:bg-slate-800" title="New blank design — starts from a completely empty scene (no components, no parameters; layer stack preserved). Prompts to save the current design first if unsaved.">
              <FilePlus size={11} /> blank
            </button>
          </div>
        </div>
      </header>

      {/* Workspace switcher dialog */}
      {showWorkspaceDialog && (
        <div className="fixed inset-0 z-40 flex items-center justify-center" style={{ background: 'rgba(15,23,42,0.6)' }} onClick={() => setShowWorkspaceDialog(false)}>
          <div className="rounded-lg shadow-2xl border border-slate-700 w-[28rem] max-w-[90vw] overflow-hidden" style={{ background: '#0f172a' }} onClick={(e) => e.stopPropagation()}>
            <div className="px-4 py-3 border-b border-slate-700 flex items-center justify-between">
              <div>
                <span className="text-sm font-medium text-slate-200">Workspaces</span>
                <p className="text-[10px] text-slate-500 mt-0.5">Each workspace has its own designs, library, and archive. Storage prefix: <span className="font-mono">photonic_layout:[name]:…</span></p>
              </div>
              <button onClick={() => setShowWorkspaceDialog(false)} className="text-slate-500 hover:text-slate-200 text-xs">✕</button>
            </div>
            <div className="px-4 py-3 border-b border-slate-700">
              <p className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">Existing workspaces</p>
              <div className="space-y-1 max-h-48 overflow-y-auto">
                {knownWorkspaces.length === 0 && (
                  <p className="text-[11px] text-slate-500 italic">No data yet. Create a workspace below.</p>
                )}
                {knownWorkspaces.map(ws => {
                  const isCurrent = ws === workspace;
                  const label = ws || 'default';
                  return (
                    <div key={ws || '__default__'} className={`flex items-center gap-2 rounded px-2 py-1.5 ${isCurrent ? 'border border-cyan-500 bg-cyan-900/20' : 'border border-slate-700 hover:border-slate-500'}`}>
                      <FolderTree size={11} className={isCurrent ? 'text-cyan-400' : 'text-slate-400'} />
                      <span className="font-mono text-xs flex-1 truncate" style={{ color: isCurrent ? '#67e8f9' : '#cbd5e1' }}>{label}</span>
                      {isCurrent ? (
                        <span className="text-[9px] text-cyan-400 font-medium">CURRENT</span>
                      ) : (
                        <button
                          onClick={() => handleChangeWorkspace(ws)}
                          className="text-[10px] px-2 py-0.5 rounded bg-cyan-700 hover:bg-cyan-600 text-white"
                        >
                          switch
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
            <div className="px-4 py-3 border-b border-slate-700">
              <p className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">Switch to / create</p>
              <WorkspaceCreateRow currentWorkspace={workspace} onSwitch={handleChangeWorkspace} />
              <p className="text-[10px] text-slate-500 mt-2">Tip: leave empty to use the default workspace. Names cannot contain colons.</p>
            </div>

            {/* File-link section: the active workspace can be bound to a JSON
                file on disk; every successful save mirrors the workspace
                bundle to that file. When linking is unavailable (Safari,
                Firefox, or sandboxed iframe), the user gets a manual
                download/import flow instead. */}
            <div className="px-4 py-3 border-b border-slate-700">
              <p className="text-[10px] uppercase tracking-wider text-slate-500 mb-1.5">Linked file (auto-mirrors on save)</p>
              {workspaceHandle ? (
                <div className="rounded border border-emerald-700/60 bg-emerald-900/10 px-2 py-1.5">
                  <div className="flex items-center gap-2">
                    <Save size={11} className="text-emerald-400" />
                    <span className="font-mono text-xs flex-1 truncate text-emerald-300" title={workspaceFileLabel}>
                      {workspaceFileLabel || '(linked file)'}
                    </span>
                    <button
                      onClick={mirrorWorkspaceToFileIfLinked}
                      className="text-[10px] px-2 py-0.5 rounded bg-emerald-700 hover:bg-emerald-600 text-white"
                      title="Force a write of the current workspace state to the linked file"
                    >
                      sync now
                    </button>
                    <button
                      onClick={handleUnlinkWorkspaceFile}
                      className="text-[10px] px-2 py-0.5 rounded border border-slate-600 hover:bg-slate-800 text-slate-300"
                      title="Stop mirroring saves to this file (the file is kept on disk)"
                    >
                      unlink
                    </button>
                  </div>
                  <p className="text-[10px] text-slate-500 mt-1.5 leading-snug">
                    Browsers don't expose absolute paths — only the file name is shown. Every save (auto and manual) rewrites the entire workspace bundle to this file.
                  </p>
                </div>
              ) : (
                <div className="space-y-1.5">
                  <button
                    onClick={handleLinkWorkspaceToFile}
                    disabled={!fsLinkAvailable}
                    className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 rounded text-xs font-medium bg-cyan-700 hover:bg-cyan-600 text-white disabled:opacity-30 disabled:cursor-not-allowed"
                    title={fsLinkAvailable
                      ? 'Pick or create a JSON file on disk; every save will rewrite the entire workspace bundle to it.'
                      : (fsBlockedAtRuntime
                        ? 'Direct file linking is blocked in this browsing context (sandboxed iframe). Use "Download workspace" below instead.'
                        : 'Your browser does not support direct file linking (File System Access API). Use Chrome or Edge for this feature.')}
                  >
                    <Save size={11} /> Link to file…
                  </button>
                  {/* Always-available manual snapshot fallback. Even when
                      linking works, this gives a one-click download for
                      versioned backups. */}
                  <button
                    onClick={handleDownloadWorkspaceSnapshot}
                    className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 rounded text-xs font-medium border border-slate-600 hover:bg-slate-800 text-slate-200"
                    title="Download a JSON snapshot of the entire workspace (designs, library, archive). Re-import via the button below."
                  >
                    <Download size={11} /> Download workspace
                  </button>
                  {!fsLinkAvailable && (
                    <p className="text-[10px] text-amber-400 mt-1 leading-snug">
                      {fsBlockedAtRuntime
                        ? 'Direct file linking is blocked in this browsing context (sandboxed iframe). Use Download / Import instead.'
                        : 'Your browser does not support the File System Access API. Use Chrome or Edge to link a file directly, or use Download / Import below.'}
                    </p>
                  )}
                </div>
              )}
            </div>

            {/* Import section: load a workspace bundle from a JSON file. */}
            <div className="px-4 py-3">
              <p className="text-[10px] uppercase tracking-wider text-slate-500 mb-1.5">Import workspace</p>
              <button
                onClick={handleImportWorkspaceFromFile}
                className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 rounded text-xs font-medium border border-slate-600 hover:bg-slate-800 text-slate-200"
                title="Load designs, library, and archive from a previously saved workspace JSON file. You'll be asked whether to merge or replace, and (in supported browsers) whether to link the imported file for future auto-mirroring."
              >
                <Upload size={11} /> Import workspace from file…
              </button>
              <p className="text-[10px] text-slate-500 mt-1.5 leading-snug">
                Imports into <span className="text-slate-300 font-mono">"{workspace || 'default'}"</span>. You'll be prompted to merge (keep existing) or replace (wipe first){fsLinkAvailable ? '. After import, you\'ll also be offered to link the imported file for future auto-mirroring' : ''}.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Designs dropdown overlay */}
      {showDesigns && (
        <div className="absolute z-30 right-4 top-12 w-80 rounded-lg shadow-2xl border border-slate-700 overflow-hidden" style={{ background: '#0f172a' }}>
          <div className="px-3 py-2 border-b border-slate-700 flex items-center justify-between">
            <span className="text-xs font-medium uppercase tracking-wider text-slate-400">Saved Designs ({savedList.length})</span>
            <button onClick={() => setShowDesigns(false)} className="text-slate-500 hover:text-slate-200 text-xs">✕</button>
          </div>
          <div className="px-3 py-2 border-b border-slate-700 flex items-center gap-2">
            <input
              type="text"
              value={designName}
              onChange={(e) => { setDesignName(e.target.value); setSaveStatus('unsaved'); }}
              onBlur={() => { /* user can hit Save afterwards */ }}
              className="flex-1 bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs font-mono text-cyan-300 outline-none focus:border-cyan-400"
              placeholder="design name"
            />
            <button onClick={handleSave} className="px-2 py-1 rounded text-xs font-medium" style={{ background: '#22c55e', color: '#0f172a' }}>save</button>
          </div>
          <div className="max-h-80 overflow-y-auto">
            {savedList.length === 0 && <p className="text-xs text-slate-500 italic px-3 py-3">No saved designs yet.</p>}
            {savedList.map(name => {
              const isCurrent = name === designName;
              return (
                <div key={name} className={`flex items-center gap-1 px-3 py-1.5 border-b border-slate-800 hover:bg-slate-800/60 ${isCurrent ? 'bg-slate-800/40' : ''}`}>
                  <button onClick={() => { handleLoad(name); setShowDesigns(false); }} className="flex-1 text-left text-xs font-mono text-slate-200 hover:text-cyan-300 truncate">
                    {isCurrent && <span className="text-emerald-400 mr-1">●</span>}
                    {name}
                  </button>
                  <button
                    onClick={async () => {
                      const newName = await promptDialog('Rename design:', name, 'Rename');
                      if (newName) handleRenameDesign(name, newName);
                    }}
                    className="text-slate-500 hover:text-cyan-400 text-[10px] px-1"
                    title="Rename"
                  >
                    rename
                  </button>
                  <button onClick={() => handleDeleteDesign(name)} className="text-slate-500 hover:text-red-400" title="Delete">
                    <Trash2 size={11} />
                  </button>
                </div>
              );
            })}
          </div>
          <div className="px-3 py-2 border-t border-slate-700 flex items-center gap-2 text-[10px] text-slate-500">
            <span>Cmd+S = save · Cmd+Shift+S = save as · Cmd+Z / ⇧Z = undo / redo</span>
          </div>
        </div>
      )}

      <div className="flex-1 flex overflow-hidden">
        {/* LEFT */}
        <div className="w-72 border-r border-slate-700 flex flex-col" style={{ background: '#0f172a' }}>
          <div className="flex flex-wrap border-b border-slate-700 text-[10px]">
            {[
              { id: 'params', label: 'PARAMS', icon: Settings2 },
              { id: 'layers', label: 'LAYERS', icon: Layers },
              { id: 'shapes', label: 'SHAPES', icon: Square },
              { id: 'snaps', label: 'SNAPS', icon: Link2 },
              { id: 'mirrors', label: 'MIRRORS', icon: FlipHorizontal },
              { id: 'library', label: 'LIBRARY', icon: BookOpen },
              { id: 'code', label: 'CODE', icon: Box },
            ].map(t => {
              const Icon = t.icon;
              return (
                <button key={t.id} onClick={() => setActivePanel(t.id)} className={`flex-1 min-w-[3.5rem] px-1 py-2 font-medium tracking-wider transition-colors flex flex-col items-center gap-0.5 ${activePanel === t.id ? 'text-cyan-400 border-b-2 border-cyan-400' : 'text-slate-400 hover:text-slate-200'}`}>
                  <Icon size={11} />
                  {t.label}
                </button>
              );
            })}
          </div>

          <div className="flex-1 overflow-y-auto p-3">
            {activePanel === 'params' && (
              <div className="space-y-0.5">
                <div className="flex gap-1 mb-1">
                  <button onClick={addParam} className="flex-1 flex items-center justify-center gap-1 px-2 py-1 rounded text-xs border border-dashed border-slate-600 hover:border-slate-400 text-slate-300">
                    <Plus size={11} /> add
                  </button>
                  <button
                    onClick={cleanupUnusedParams}
                    disabled={unusedParams.length === 0}
                    className="flex items-center justify-center gap-1 px-2 py-1 rounded text-xs border border-slate-600 disabled:opacity-30 disabled:cursor-not-allowed enabled:hover:bg-amber-900/30 enabled:hover:border-amber-600 enabled:text-amber-300 text-slate-400"
                    title={unusedParams.length === 0 ? 'No unused parameters' : `Remove ${unusedParams.length} unused: ${unusedParams.slice(0, 5).join(', ')}${unusedParams.length > 5 ? '...' : ''}`}
                  >
                    <Trash2 size={11} /> cleanup{unusedParams.length > 0 ? ` (${unusedParams.length})` : ''}
                  </button>
                </div>
                {Object.entries(scene.params).map(([name, p]) => (
                  <ParamRow
                    key={name}
                    name={name}
                    p={p}
                    value={paramValues[name]}
                    error={paramErrors[name]}
                    isUnused={unusedParams.includes(name)}
                    isInvolved={paramsInvolvedInSelection.has(name)}
                    autoFocus={newParamFocus === name}
                    onAutoFocusDone={() => setNewParamFocus(null)}
                    onRename={(o, n) => renameParam(o, n)}
                    onUpdateExpr={(v) => updateParam(name, { expr: v })}
                    onCommitExpr={(v) => commitExpr(v, '0', scene.params[name]?.unit || 'µm', `Auto-created (used by ${name})`, name)}
                    onUpdateUnit={(v) => updateParam(name, { unit: v })}
                    onUpdateDesc={(v) => updateParam(name, { desc: v })}
                    onDelete={() => deleteParam(name)}
                  />
                ))}
              </div>
            )}

            {activePanel === 'layers' && (
              <div className="space-y-2 text-xs">
                <p className="text-[10px] text-slate-500 italic px-1 leading-snug">
                  Layer stack from bottom to top. Substrate layers are placed below Z=0; the waveguide layer is patterned wherever a waveguide component is defined; the cladding layer fills above. Thickness values are parameters — edit them in PARAMS or here.
                </p>
                <button
                  onClick={() => updateScene(prev => ({
                    ...prev,
                    stack: [
                      ...prev.stack,
                      { id: `l_${Math.random().toString(36).slice(2, 7)}`, name: 'New layer', thickness: '1', material: 'silicon_dioxide', color: '#94a3b8', role: 'substrate' },
                    ],
                  }))}
                  className="w-full flex items-center justify-center gap-1 px-2 py-1 rounded text-xs border border-dashed border-slate-600 hover:border-cyan-400 text-slate-300"
                >
                  <Plus size={11} /> add layer
                </button>
                {(() => {
                  // Group layers into vertically-stacked "levels". Layers with roles
                  // 'waveguide', 'conductor', or 'cladding' are coplanar (Z=0..h_wg) and
                  // form one level. Substrates each stand alone (each at its own Z slab).
                  // Anything else is its own level.
                  const isDeviceRole = (r) => r === 'waveguide' || r === 'conductor' || r === 'cladding';
                  const levels = []; // [{ key, layers: [{layer, idx}], zLabel, isDevice }]
                  let curDeviceLvl = null;
                  for (let i = 0; i < scene.stack.length; i++) {
                    const layer = scene.stack[i];
                    if (isDeviceRole(layer.role)) {
                      // Add to the most recent adjacent device level, or start a new one
                      if (curDeviceLvl) {
                        curDeviceLvl.layers.push({ layer, idx: i });
                      } else {
                        curDeviceLvl = {
                          key: `device_${i}`,
                          isDevice: true,
                          layers: [{ layer, idx: i }],
                          zLabel: 'coplanar',
                        };
                        levels.push(curDeviceLvl);
                      }
                    } else {
                      curDeviceLvl = null; // break the device run
                      levels.push({ key: layer.id, isDevice: false, layers: [{ layer, idx: i }], zLabel: null });
                    }
                  }
                  // Render top-down: reverse the levels array.
                  return [...levels].reverse().map((level, levelIdxFromTop) => (
                    <LevelGroup
                      key={level.key}
                      level={level}
                      scene={scene}
                      paramValues={paramValues}
                      updateScene={updateScene}
                      commitExpr={commitExpr}
                    />
                  ));
                })()}


                {scene.stack.length === 0 && (
                  <p className="text-xs text-slate-500 italic px-1">No layers in stack.</p>
                )}
              </div>
            )}

            {activePanel === 'shapes' && (() => {
              // ============================================================
              // OBJECT TREE
              // ============================================================
              // Every entry in the SHAPES panel is an "object" — primitive
              // rectangle, boolean result, or group of objects. Each row
              // shows the object's identity and (when expanded) its
              // creation history as an HFSS-style indented chain. This
              // matches the way HFSS displays parts in its model tree:
              // a part's history is the recipe for building it.
              //
              // We classify components into top-level "objects":
              //   - boolean components (kind='boolean'): own row, with
              //     operands shown as nested children when expanded
              //   - group entries (scene.groups): own row, members nested
              //   - free primitive components (no consumedBy, no group):
              //     own row, with their CreateBox + transforms history
              //   - consumed operands (consumedBy != null) only appear
              //     inside their owning boolean's nested view
              //   - grouped components only appear inside their group
              //
              // The tree handles arbitrary nesting of booleans-of-booleans
              // since operands are referenced by id and rendered through
              // the same node renderer recursively.

              // Map id → component for fast lookup during recursion.
              const byId = Object.fromEntries(scene.components.map(c => [c.id, c]));
              const groupNames = new Set(scene.groups.map(g => g.name));
              const groupedIds = new Set();
              for (const g of scene.groups) for (const id of g.memberIds) groupedIds.add(id);
              for (const c of scene.components) {
                if (c.group && groupNames.has(c.group)) groupedIds.add(c.id);
              }
              const groupMembers = (g) => {
                const ids = new Set(g.memberIds);
                for (const c of scene.components) {
                  if (c.group === g.name) ids.add(c.id);
                }
                return Array.from(ids);
              };
              const consumedIds = new Set();
              for (const c of scene.components) if (c.consumedBy) consumedIds.add(c.id);

              const handleClickComp = (c, e) => {
                if (e.metaKey || e.ctrlKey) {
                  const newIds = new Set(selectedIds);
                  if (newIds.has(c.id)) { newIds.delete(c.id); setSelection({ ids: newIds, primary: newIds.size > 0 ? Array.from(newIds).pop() : null }); }
                  else { newIds.add(c.id); setSelection({ ids: newIds, primary: c.id }); }
                } else if (e.shiftKey && selectedId) {
                  const order = scene.components.map(x => x.id);
                  const a = order.indexOf(selectedId), b = order.indexOf(c.id);
                  if (a >= 0 && b >= 0) {
                    const range = order.slice(Math.min(a, b), Math.max(a, b) + 1);
                    setSelection({ ids: new Set([...selectedIds, ...range]), primary: c.id });
                  }
                } else {
                  setSelection({ ids: new Set([c.id]), primary: c.id });
                }
              };

              // Format a single transform entry as a compact HFSS-style
              // operation string. Used in the per-object history view.
              const formatTransform = (t) => {
                const dis = t.enabled === false ? ' [off]' : '';
                if (t.kind === 'displace') return `Move(dx=${t.dx ?? '0'}, dy=${t.dy ?? '0'})${dis}`;
                if (t.kind === 'rotate') return `Rotate(${t.angle ?? '0'}°, ${t.pivot || 'C'})${dis}`;
                if (t.kind === 'repeat') return `Duplicate(N=${t.n ?? '0'}, dx=${t.dx ?? '0'}, dy=${t.dy ?? '0'})${dis}`;
                return `${t.kind}${dis}`;
              };

              // Color accent for the operation kind. Booleans inherit their
              // op color; primitives use a neutral cyan; groups use slate.
              const accentFor = (c) => {
                if (c?.kind === 'boolean') {
                  return c.op === 'union' ? '#10b981'
                    : c.op === 'intersect' ? '#22d3ee'
                    : '#f59e0b';
                }
                return '#0ea5e9';
              };

              // The recursive object node renderer. Renders a row for the
              // object plus (when expanded) its history sub-tree.
              const renderObject = (c, depth) => {
                const isBoolean = c.kind === 'boolean';
                const isExpanded = expandedTreeNodes.has(c.id);
                const isSelected = selectedIds.has(c.id);
                const accent = accentFor(c);
                const indent = depth * 12;
                // Quick textual summary of the creation method (the LAST
                // step in HFSS terms — the "leaf" of the history). Shown
                // collapsed so the user can read the kind at a glance.
                const headerSummary = isBoolean
                  ? `${c.op === 'union' ? 'Unite' : c.op === 'intersect' ? 'Intersect' : 'Subtract'}(${(c.operandIds || []).join(', ')})`
                  : `Box(w=${c.w}, h=${c.h})`;
                return (
                  <div key={c.id}>
                    <div
                      onClick={(e) => handleClickComp(c, e)}
                      className={`flex items-center gap-1 py-0.5 cursor-pointer rounded text-xs ${isSelected ? 'bg-cyan-900/30 ring-1 ring-cyan-400' : 'hover:bg-slate-800'}`}
                      style={{ paddingLeft: 4 + indent }}
                    >
                      <button
                        onClick={(e) => { e.stopPropagation(); toggleTreeNode(c.id); }}
                        className="w-3 h-3 flex items-center justify-center text-slate-500 hover:text-slate-200 flex-shrink-0"
                        title={isExpanded ? 'Collapse history' : 'Expand history'}
                      >
                        {isExpanded ? '▾' : '▸'}
                      </button>
                      <span className="font-mono font-bold text-[11px] truncate flex-shrink-0" style={{ color: accent }}>
                        {c.id}
                      </span>
                      {isBoolean && (
                        <span className="text-[9px] uppercase font-bold tracking-wider flex-shrink-0" style={{ color: accent + 'cc' }}>
                          {c.op}
                        </span>
                      )}
                      <span className="px-1 py-0 rounded text-[9px] font-mono flex-shrink-0" style={{ background: layerSwatches[c.layer]?.bg, color: layerSwatches[c.layer]?.fg }}>
                        {c.layer}
                      </span>
                      <span className="flex-1" />
                      {isBoolean ? (
                        <button onClick={(e) => { e.stopPropagation(); deleteBoolean(c.id); }} className="text-slate-500 hover:text-red-400 flex-shrink-0" title="Delete this derived component (operands are released)">
                          <Trash2 size={10} />
                        </button>
                      ) : (
                        <button onClick={(e) => { e.stopPropagation(); deleteComp(c.id); }} className="text-slate-500 hover:text-red-400 flex-shrink-0" title="Delete this component">
                          <Trash2 size={10} />
                        </button>
                      )}
                    </div>
                    {isExpanded && (
                      <div className="text-[9px] font-mono leading-tight" style={{ paddingLeft: 4 + indent + 12 }}>
                        {/* For booleans: nested operand sub-trees come FIRST
                            (they're prerequisites in HFSS history order). */}
                        {isBoolean && (c.operandIds || []).map(opid => {
                          const opC = byId[opid];
                          if (!opC) return (
                            <div key={opid} className="text-slate-600 italic">missing operand: {opid}</div>
                          );
                          return renderObject(opC, depth + 1);
                        })}
                        {/* The creation step itself: CreateBox or Unite/etc. */}
                        <div className="text-slate-400 py-0.5" style={{ paddingLeft: isBoolean ? 0 : 0 }}>
                          <span className="text-slate-600">└─</span> {headerSummary}
                        </div>
                        {/* Object-level transforms applied AFTER creation,
                            in chain order. These map 1:1 to HFSS Move /
                            Rotate / Duplicate calls in the export. */}
                        {(c.transforms || []).map((t, i) => (
                          <div key={t.id || i} className="text-slate-400 py-0.5">
                            <span className="text-slate-600">└─</span> {formatTransform(t)}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              };

              // Top-level objects = groups + boolean components + free
              // primitives (those without consumedBy and without group).
              const topPrimitives = scene.components.filter(c =>
                c.kind !== 'boolean' &&
                !groupedIds.has(c.id) &&
                !consumedIds.has(c.id)
              );
              const topBooleans = scene.components.filter(c =>
                c.kind === 'boolean' &&
                !groupedIds.has(c.id) &&
                !consumedIds.has(c.id)
              );

              return (
                <div className="space-y-1">
                  <div className="flex items-center gap-1.5 mb-2">
                    <button
                      onClick={createGroup}
                      disabled={selectedIds.size === 0}
                      className="flex-1 flex items-center justify-center gap-1 px-2 py-1 rounded text-[10px] border border-dashed border-slate-600 hover:border-cyan-400 disabled:opacity-30 disabled:cursor-not-allowed text-slate-300"
                      title={selectedIds.size === 0 ? 'Select shapes first' : `Group ${selectedIds.size}`}
                    >
                      <FolderTree size={10} /> group
                    </button>
                    <button
                      onClick={() => createBoolean('union')}
                      disabled={selectedIds.size < 2}
                      className="flex items-center gap-1 px-2 py-1 rounded text-[10px] border border-emerald-700 hover:border-emerald-500 disabled:opacity-30 text-emerald-300"
                      title={selectedIds.size < 2 ? 'Select 2+' : 'Union (+)'}
                    >
                      <Combine size={10} /> ∪
                    </button>
                    <button
                      onClick={() => createBoolean('intersect')}
                      disabled={selectedIds.size < 2}
                      className="flex items-center gap-1 px-2 py-1 rounded text-[10px] border border-cyan-700 hover:border-cyan-500 disabled:opacity-30 text-cyan-300"
                      title={selectedIds.size < 2 ? 'Select 2+' : 'Intersect'}
                    >
                      <XIcon size={10} /> ∩
                    </button>
                    <button
                      onClick={() => createBoolean('subtract')}
                      disabled={selectedIds.size < 2}
                      className="flex items-center gap-1 px-2 py-1 rounded text-[10px] border border-amber-700 hover:border-amber-500 disabled:opacity-30 text-amber-300"
                      title={selectedIds.size < 2 ? 'Select 2+' : 'Subtract first − rest (−)'}
                    >
                      <Minus size={10} /> −
                    </button>
                  </div>

                  {/* Groups — keep using the existing GroupTreeItem since
                      groups are a separate side-list with their own UI. */}
                  {scene.groups.map(g => (
                    <GroupTreeItem
                      key={g.id}
                      group={{ ...g, memberIds: groupMembers(g) }}
                      components={scene.components}
                      params={scene.params}
                      selectedIds={selectedIds}
                      onSelectGroup={() => selectGroup(g.id)}
                      onDissolve={() => dissolveGroup(g.id)}
                      onDelete={() => deleteGroup(g.id)}
                      onRename={(newName) => renameGroup(g.id, newName)}
                      renderCompRow={(c) => renderObject(c, 1)}
                    />
                  ))}

                  {/* Boolean (derived) objects */}
                  {topBooleans.map(c => renderObject(c, 0))}

                  {/* Free primitive objects */}
                  {topPrimitives.map(c => renderObject(c, 0))}

                  {scene.components.length === 0 && (
                    <p className="text-xs text-slate-500 italic px-1 mt-2">
                      No shapes yet. Use the toolbar's <span className="text-cyan-300">+ WG</span> / <span className="text-cyan-300">+ EL</span> buttons to add primitives. Select 2+ shapes and use the boolean buttons above to create derived objects.
                    </p>
                  )}
                </div>
              );
            })()}

            {activePanel === 'snaps' && (
              <div className="space-y-1">
                <p className="text-[10px] text-slate-500 italic px-1">Snaps form a graph; the root component is freely positioned, the rest follow.</p>
                {scene.snaps.map(s => (
                  <div key={s.id} className="p-2 rounded text-xs border border-slate-700" style={{ background: '#1e293b' }}>
                    <div className="flex items-center justify-between mb-1">
                      <span className="font-mono text-[10px] text-cyan-300 truncate">{s.from.compId}.{s.from.anchor} → {s.to.compId}.{s.to.anchor}</span>
                      <button onClick={() => deleteSnap(s.id)} className="text-slate-500 hover:text-red-400"><Link2Off size={11} /></button>
                    </div>
                    <div className="grid grid-cols-2 gap-1 mt-1">
                      <div>
                        <label className="text-[9px] text-slate-500">dx</label>
                        <input value={s.dx} onChange={(e) => updateSnap(s.id, { dx: e.target.value })} className="w-full bg-slate-900 border border-slate-700 rounded px-1 py-0.5 text-[10px] font-mono text-white outline-none focus:border-cyan-400" />
                      </div>
                      <div>
                        <label className="text-[9px] text-slate-500">dy</label>
                        <input value={s.dy} onChange={(e) => updateSnap(s.id, { dy: e.target.value })} className="w-full bg-slate-900 border border-slate-700 rounded px-1 py-0.5 text-[10px] font-mono text-white outline-none focus:border-cyan-400" />
                      </div>
                    </div>
                  </div>
                ))}
                {scene.snaps.length === 0 && <p className="text-xs text-slate-500 italic">No snaps.</p>}
              </div>
            )}

            {activePanel === 'mirrors' && (
              <div className="space-y-1">
                <p className="text-[10px] text-slate-500 italic px-1 mb-2">Select a shape, then Mirror H / V. Toggle the lock to break symmetry.</p>
                {scene.mirrors.map(m => (
                  <div key={m.id} className="p-2 rounded text-xs border border-slate-700" style={{ background: '#1e293b' }}>
                    <div className="flex items-center justify-between mb-1">
                      <span className="font-mono text-[10px] text-violet-300">{m.axis} @ {m.axisCoord}</span>
                      <button onClick={() => deleteMirror(m.id)} className="text-slate-500 hover:text-red-400"><Trash2 size={11} /></button>
                    </div>
                    {m.members.map((mm, i) => (
                      <div key={i} className="flex items-center justify-between gap-1 text-[10px] py-0.5">
                        <span className="font-mono text-slate-300 truncate">{mm.srcId} ↔ {mm.mirrorId}</span>
                        <button onClick={() => toggleMirrorLock(m.id, i)} className={mm.locked ? 'text-emerald-400' : 'text-amber-400'}>
                          {mm.locked ? <Lock size={10} /> : <Unlock size={10} />}
                        </button>
                      </div>
                    ))}
                  </div>
                ))}
                {scene.mirrors.length === 0 && <p className="text-xs text-slate-500 italic">No mirrors yet.</p>}
              </div>
            )}


            {activePanel === 'library' && (
              <div className="space-y-2">
                <button
                  onClick={saveSelectionToLibrary}
                  disabled={selectedIds.size === 0}
                  className="w-full flex items-center justify-center gap-1 px-2 py-1 rounded text-xs border border-dashed border-slate-600 hover:border-cyan-400 disabled:opacity-30 disabled:cursor-not-allowed text-slate-300"
                  title={selectedIds.size === 0 ? 'Select components first' : `Save ${selectedIds.size} component${selectedIds.size === 1 ? '' : 's'} to library`}
                >
                  <Save size={11} /> save selection ({selectedIds.size})
                </button>
                {/* Library file I/O — separate from workspace export so users
                    can share library kits without dragging entire designs. */}
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={handleExportLibrary}
                    className="flex-1 flex items-center justify-center gap-1 px-2 py-1 rounded text-[10px] border border-slate-700 hover:border-slate-500 text-slate-300"
                    title="Download a JSON snapshot of this workspace's library (active + archive). Designs are NOT included."
                  >
                    <Download size={11} /> export library
                  </button>
                  <button
                    onClick={handleImportLibrary}
                    className="flex-1 flex items-center justify-center gap-1 px-2 py-1 rounded text-[10px] border border-slate-700 hover:border-slate-500 text-slate-300"
                    title="Load library items from a JSON file. Accepts both library exports and full workspace exports (designs are ignored)."
                  >
                    <Upload size={11} /> import library
                  </button>
                </div>
                <p className="text-[10px] text-slate-500 italic px-1 leading-snug">
                  Library items can be dropped into any design. Click <span className="text-cyan-300">insert</span> to drop at the viewport center.
                </p>

                {/* Built-in templates: a small set of parameterized
                    components shipped with the app. They're inserted into
                    the scene with sensible default parameters and can then
                    be edited normally. */}
                <div className="border-t border-slate-800 pt-2 mt-2">
                  <p className="text-[10px] uppercase tracking-wider text-slate-500 px-1 mb-1">Built-in templates</p>
                  <div className="rounded border border-slate-800 px-2 py-1.5 flex items-center gap-2" style={{ background: 'rgba(30,41,59,0.5)' }}>
                    <Package size={11} className="text-cyan-400 flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="font-mono text-xs text-cyan-300 truncate">Euler racetrack</p>
                      <p className="text-[9px] text-slate-500 truncate">R=100µm · L=300µm · p=1 (pure Euler)</p>
                    </div>
                    <button
                      onClick={insertBuiltinRacetrack}
                      className="text-[10px] px-2 py-0.5 rounded border border-cyan-700 text-cyan-300 hover:bg-cyan-900/40"
                      title="Insert a racetrack optical waveguide with partial-Euler bends. Parameters: R (min curvature radius), L_straight (straight section length), p (Euler split parameter ∈ [0,1])."
                    >
                      insert
                    </button>
                  </div>
                </div>

                {!showArchive && (
                  <>
                    {libraryItems.length === 0 && <p className="text-xs text-slate-500 italic px-1">Library is empty.</p>}
                    {libraryItems.map(name => (
                      <LibraryItemRow
                        key={name}
                        name={name}
                        onInsert={() => insertLibraryItem(name)}
                        onArchive={() => archiveLibraryEntry(name)}
                        onRename={(newName) => renameLibraryEntry(name, newName)}
                      />
                    ))}
                  </>
                )}

                {/* Archive toggle */}
                <button
                  onClick={() => setShowArchive(s => !s)}
                  className="w-full flex items-center justify-center gap-1 px-2 py-1.5 mt-2 rounded text-[10px] border border-slate-700 hover:border-slate-500 text-slate-400"
                  title="Show archived items"
                >
                  <Boxes size={11} />
                  {showArchive ? 'hide' : 'show'} archive ({archivedLibraryItems.length})
                </button>

                {showArchive && (
                  <div className="space-y-1">
                    {archivedLibraryItems.length === 0 && <p className="text-xs text-slate-500 italic px-1">Archive is empty.</p>}
                    {archivedLibraryItems.map(name => (
                      <div key={name} className="rounded border border-slate-800 px-2 py-1.5 flex items-center gap-2" style={{ background: 'rgba(30,41,59,0.5)' }}>
                        <Package size={11} className="text-slate-500 flex-shrink-0" />
                        <span className="font-mono text-xs text-slate-400 flex-1 truncate">{name}</span>
                        <button onClick={() => restoreLibraryEntry(name)} className="text-[10px] px-2 py-0.5 rounded border border-slate-600 text-slate-300 hover:bg-slate-800" title="Restore to active library">
                          restore
                        </button>
                        <button onClick={() => deleteArchivedEntry(name)} className="text-slate-500 hover:text-red-400" title="Delete forever">
                          <Trash2 size={10} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {activePanel === 'code' && (
              <pre className="text-[9px] font-mono leading-relaxed text-slate-300 whitespace-pre-wrap break-all">{code}</pre>
            )}
          </div>
        </div>

        {/* CENTER */}
        <div className="flex-1 relative">
          <Canvas
            scene={scene}
            updateScene={updateScene}
            selectedId={selectedId}
            selectedIds={selectedIds}
            setSelection={setSelection}
            viewport={viewport}
            setViewport={setViewport}
            snapMode={snapMode}
            setSnapMode={setSnapMode}
            gridSize={gridSize}
            gridSnapEnabled={gridSnapEnabled}
            paramValues={paramValues}
            addParam={addParam}
            updateParamExpr={(name, expr) => updateParam(name, { expr })}
            rulerMode={rulerMode}
            setRulerMode={setRulerMode}
            rulerMeasurements={rulerMeasurements}
            setRulerMeasurements={setRulerMeasurements}
            rulerInProgress={rulerInProgress}
            setRulerInProgress={setRulerInProgress}
            rulerSnapPoint={rulerSnapPoint}
            setRulerSnapPoint={setRulerSnapPoint}
            alertDialog={alertDialog}
            setInteractionStatus={setInteractionStatus}
            showDimensions={showDimensions}
            addMode={addMode}
            setAddMode={setAddMode}
            commitDragAdd={commitDragAdd}
          />
          <div className="absolute top-2 left-2 px-2 py-1 rounded text-[10px] font-mono pointer-events-none" style={{ background: 'rgba(15,23,42,0.85)', color: '#e2e8f0' }}>
            wheel = zoom · drag = pan/move · ⌥/Alt+drag = marquee · ⌘+click = toggle · ⌘+drag = no grid · F = fit · ⌘Z/⇧Z = undo/redo · ⌘C/V = copy/paste · ⌘S = save
          </div>
          <div className="absolute bottom-2 left-2 flex flex-wrap gap-x-3 gap-y-1 text-[10px] font-mono max-w-[60%]" style={{ color: '#475569' }}>
            <div className="flex items-center gap-1.5"><div className="w-3 h-3 rounded-sm" style={{ background: '#3ec27a' }} />wg</div>
            <div className="flex items-center gap-1.5"><div className="w-3 h-3 rounded-sm" style={{ background: '#f4a72e' }} />electrode</div>
            <div className="flex items-center gap-1.5"><div className="w-3 h-3 border-2 border-sky-400" />selected</div>
            <div className="flex items-center gap-1.5"><div className="w-3 h-3 border border-sky-400 border-dashed" />snap-related</div>
            <div className="flex items-center gap-1.5"><div className="w-3 h-3 border border-violet-400 border-dashed" />mirror-related</div>
          </div>
          {/* Live snap/ruler/add status — kept off-canvas so the preview line and
              anchor points stay visible. Color-coded: amber=snap, cyan=ruler, green=add. */}
          {interactionStatus && (() => {
            const palette = {
              ruler: { fg: '#67e8f9', bd: '#22d3ee' },
              add:   { fg: '#86efac', bd: '#22c55e' },
              snap:  { fg: '#fbbf24', bd: '#f59e0b' },
            };
            const p = palette[interactionStatus.kind] || palette.snap;
            return (
              <div
                className="absolute bottom-2 right-2 px-2 py-1 rounded text-[11px] font-mono pointer-events-none"
                style={{
                  background: 'rgba(15,23,42,0.92)',
                  color: p.fg,
                  border: `1px solid ${p.bd}`,
                }}
              >
                {interactionStatus.line}
              </div>
            );
          })()}
        </div>

        {/* RIGHT — Inspector */}
        <div className="w-72 border-l border-slate-700 flex flex-col" style={{ background: '#0f172a' }}>
          <div className="px-3 py-2 border-b border-slate-700 text-xs font-medium uppercase tracking-wider text-slate-400 flex items-center justify-between">
            <span>Inspector{selectedIds.size > 1 ? ` · ${selectedIds.size} selected` : ''}</span>
            {selectedIds.size > 0 && (
              <button
                onClick={deleteSelected}
                className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium normal-case bg-red-900/40 hover:bg-red-700 text-red-200 hover:text-white transition-colors"
                title="Delete (Del / Backspace)"
              >
                <Trash2 size={10} /> delete{selectedIds.size > 1 ? ` (${selectedIds.size})` : ''}
              </button>
            )}
          </div>
          <div className="flex-1 overflow-y-auto p-3">
            {selectedIds.size === 0 && <p className="text-xs text-slate-500 italic">Click a component to inspect, or ⌥/Alt+drag to marquee-select multiple.</p>}
            {selectedIds.size > 1 && (
              <div className="mb-3 p-2 rounded border border-cyan-700 bg-cyan-900/20 text-xs">
                <p className="text-cyan-300 font-medium mb-1">{selectedIds.size} components selected</p>
                <p className="text-[10px] text-slate-400 leading-snug">Showing details for primary: <span className="font-mono text-cyan-300">{selectedId}</span></p>
                <div className="mt-2 max-h-24 overflow-y-auto text-[10px] space-y-0.5">
                  {Array.from(selectedIds).map(id => (
                    <button
                      key={id}
                      onClick={() => setSelection({ ids: selectedIds, primary: id })}
                      className={`block w-full text-left font-mono px-1 py-0.5 rounded hover:bg-slate-800 ${id === selectedId ? 'text-cyan-300' : 'text-slate-400'}`}
                    >
                      {id === selectedId ? '● ' : '  '}{id}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {selected && (
              <div className="space-y-3">
                <div>
                  <label className="text-[10px] uppercase tracking-wider text-slate-500">ID</label>
                  <input value={selected.id} onChange={(e) => {
                    const newId = e.target.value;
                    if (!newId || scene.components.some(c => c.id === newId && c.id !== selected.id)) return;
                    updateScene(prev => ({
                      ...prev,
                      components: prev.components.map(c => c.id === selected.id ? { ...c, id: newId } : c),
                      snaps: prev.snaps.map(s => ({
                        ...s,
                        from: s.from.compId === selected.id ? { ...s.from, compId: newId } : s.from,
                        to: s.to.compId === selected.id ? { ...s.to, compId: newId } : s.to,
                      })),
                    }));
                    const newSet = new Set(selectedIds);
                    newSet.delete(selected.id);
                    newSet.add(newId);
                    setSelection({ ids: newSet, primary: newId });
                  }} className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs font-mono text-cyan-300 outline-none focus:border-cyan-400" />
                </div>
                <div>
                  <label className="text-[10px] uppercase tracking-wider text-slate-500">Layer</label>
                  <select value={selected.layer} onChange={(e) => updateComp(selected.id, { layer: e.target.value })} className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs text-white outline-none">
                    <option value="waveguide">waveguide</option>
                    <option value="electrode">electrode</option>
                    <option value="port">port</option>
                  </select>
                </div>
                {selected.kind === 'boolean' ? (
                  // Derived boolean component: no editable w/h (geometry is
                  // determined by operands + boolean op). Show op + operands
                  // as a derivation summary; cx/cy is the result's anchor.
                  <div className="border border-slate-700 rounded p-2" style={{ background: 'rgba(15,23,42,0.5)' }}>
                    <div className="flex items-center gap-1 mb-1">
                      <span className="text-[10px] font-bold uppercase tracking-wider" style={{
                        color: selected.op === 'union' ? '#10b981' : (selected.op === 'intersect' ? '#22d3ee' : '#f59e0b'),
                      }}>derived · {selected.op}</span>
                    </div>
                    <p className="text-[10px] text-slate-400 font-mono leading-snug">
                      {selected.op === 'subtract'
                        ? <>{(selected.operandIds || [])[0]}{(selected.operandIds || []).slice(1).map((id, i) => <span key={i}> − {id}</span>)}</>
                        : (selected.operandIds || []).join(selected.op === 'union' ? ' + ' : ' ∩ ')}
                    </p>
                    <p className="text-[9px] text-slate-500 mt-1 italic">
                      Operands were consumed when this component was created (HFSS-style). They no longer appear in SHAPES. Delete this component to release them.
                    </p>
                  </div>
                ) : (
                  // Shape-specific primary parameter editors. For rectangles
                  // we expose w and h. For circles, only the radius r (w and
                  // h are derived as 2*r). For ellipses, rx and ry. For
                  // regular polygons, the circumradius r and side count n.
                  // The AABB w/h fields are intentionally hidden for non-rect
                  // shapes — they're derived from the primary parameters and
                  // editing them directly would break the parametric link.
                  (() => {
                    const shapeKind = selected.kind || 'rect';
                    const fieldRow = (key, label, value, onChange, parse = null) => (
                      <div>
                        <label className="text-[10px] uppercase tracking-wider text-slate-500">{label}</label>
                        <input
                          value={value}
                          onChange={(e) => onChange(e.target.value)}
                          onBlur={(e) => commitExpr(e.target.value, '1', 'µm', `Auto-created (${selected.id}.${key})`)}
                          onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); }}
                          className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs font-mono text-white outline-none focus:border-cyan-400"
                        />
                        <p className="text-[9px] text-slate-500 mt-0.5 font-mono">= {(() => {
                          const v = evalExpr(value, paramValues);
                          return Number.isFinite(v) ? (parse ? parse(v) : v.toFixed(2)) : '—';
                        })()}</p>
                      </div>
                    );
                    if (shapeKind === 'circle') {
                      return (
                        <div className="grid grid-cols-2 gap-2">
                          {fieldRow('r', 'r (radius)', selected.r ?? '0', (v) => updateComp(selected.id, { r: v }))}
                        </div>
                      );
                    }
                    if (shapeKind === 'ellipse') {
                      return (
                        <div className="grid grid-cols-2 gap-2">
                          {fieldRow('rx', 'rx', selected.rx ?? '0', (v) => updateComp(selected.id, { rx: v }))}
                          {fieldRow('ry', 'ry', selected.ry ?? '0', (v) => updateComp(selected.id, { ry: v }))}
                        </div>
                      );
                    }
                    if (shapeKind === 'polygon') {
                      return (
                        <div className="grid grid-cols-2 gap-2">
                          {fieldRow('r', 'r (circumradius)', selected.r ?? '0', (v) => updateComp(selected.id, { r: v }))}
                          {fieldRow('n', 'n (sides)', selected.n ?? '6', (v) => updateComp(selected.id, { n: v }), (v) => Math.max(3, Math.round(v)).toString())}
                        </div>
                      );
                    }
                    if (shapeKind === 'racetrack') {
                      // Racetrack: show the three geometry parameters
                      // (min curvature radius R, straight length, Euler
                      // split p) plus the waveguide cross-section width.
                      // The AABB w/h are derived (over-approximation via
                      // linear-in-p fit) and not user-editable here.
                      return (
                        <div className="grid grid-cols-2 gap-2">
                          {fieldRow('R', 'R (min radius)', selected.R ?? '100', (v) => updateComp(selected.id, { R: v }))}
                          {fieldRow('L_straight', 'L_straight', selected.L_straight ?? '300', (v) => updateComp(selected.id, { L_straight: v }))}
                          {fieldRow('p', 'p (Euler 0–1)', selected.p ?? '1', (v) => updateComp(selected.id, { p: v }), (v) => Math.max(0, Math.min(1, v)).toFixed(3))}
                          {fieldRow('wgWidth', 'wg width', selected.wgWidth ?? 'w_wg', (v) => updateComp(selected.id, { wgWidth: v }))}
                        </div>
                      );
                    }
                    // Default: rectangle.
                    return (
                      <div className="grid grid-cols-2 gap-2">
                        {fieldRow('w', 'w', selected.w, (v) => updateComp(selected.id, { w: v }))}
                        {fieldRow('h', 'h', selected.h, (v) => updateComp(selected.id, { h: v }))}
                      </div>
                    );
                  })()
                )}
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-[10px] uppercase tracking-wider text-slate-500">cx ({selectedHasIncoming ? 'solved' : 'free'})</label>
                    <input type="number" step="0.5" value={selected.cx?.toFixed?.(2) ?? selected.cx} disabled={selectedHasIncoming} onChange={(e) => updateComp(selected.id, { cx: parseFloat(e.target.value) || 0 })} className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs font-mono text-white outline-none focus:border-cyan-400 disabled:opacity-50" />
                  </div>
                  <div>
                    <label className="text-[10px] uppercase tracking-wider text-slate-500">cy ({selectedHasIncoming ? 'solved' : 'free'})</label>
                    <input type="number" step="0.5" value={selected.cy?.toFixed?.(2) ?? selected.cy} disabled={selectedHasIncoming} onChange={(e) => updateComp(selected.id, { cy: parseFloat(e.target.value) || 0 })} className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs font-mono text-white outline-none focus:border-cyan-400 disabled:opacity-50" />
                  </div>
                </div>

                <TransformChainEditor
                  component={selected}
                  onUpdateComp={(patch) => updateComp(selected.id, patch)}
                  paramValues={paramValues}
                  commitExpr={commitExpr}
                />

                {/* Connections — show all snaps and mirrors involving this component */}
                {(() => {
                  const incoming = scene.snaps.filter(s => s.to.compId === selected.id);
                  const outgoing = scene.snaps.filter(s => s.from.compId === selected.id);
                  const mirrorMems = scene.mirrors.flatMap(m =>
                    m.members
                      .filter(mm => mm.srcId === selected.id || mm.mirrorId === selected.id)
                      .map(mm => ({ mirror: m, member: mm, role: mm.srcId === selected.id ? 'source' : 'mirror' }))
                  );
                  if (!incoming.length && !outgoing.length && !mirrorMems.length) {
                    return (
                      <div className="border-t border-slate-700 pt-3">
                        <span className="text-[10px] uppercase tracking-wider text-slate-500">Connections</span>
                        <p className="text-[10px] text-slate-500 italic mt-1">None — this component is freestanding.</p>
                      </div>
                    );
                  }
                  return (
                    <div className="border-t border-slate-700 pt-3 space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[10px] uppercase tracking-wider text-slate-500">Connections</span>
                        {(incoming.length > 0 || outgoing.length > 0) && (
                          <button
                            onClick={() => reRootSnapChain(selected.id)}
                            className="text-[9px] px-1.5 py-0.5 rounded border border-slate-600 hover:border-cyan-500 hover:text-cyan-300 text-slate-400"
                            title={`Re-root the snap chain at "${selected.id}". All snaps connected to this component (and onward through the chain) are flipped so this component becomes the parent. Useful when you want to drag this piece and have everything else follow.`}
                          >
                            ⇄ make root
                          </button>
                        )}
                      </div>
                      {incoming.length > 0 && (
                        <div>
                          <p className="text-[9px] uppercase tracking-wider text-slate-600 mb-0.5">snapped to (parent)</p>
                          {incoming.map(s => (
                            <SnapConnectionRow
                              key={s.id}
                              snap={s}
                              direction="incoming"
                              params={scene.params}
                              paramValues={paramValues}
                              onSelectOther={(id) => setSelection({ ids: new Set([id]), primary: id })}
                              onUpdateSnap={(patch) => updateSnap(s.id, patch)}
                              onUpdateParam={(name, expr) => updateParam(name, { expr })}
                              onPromoteAxis={(axis) => promoteSnapAxis(s.id, axis)}
                              onDeleteSnap={() => deleteSnap(s.id)}
                              commitExpr={commitExpr}
                            />
                          ))}
                        </div>
                      )}
                      {outgoing.length > 0 && (
                        <div>
                          <p className="text-[9px] uppercase tracking-wider text-slate-600 mb-0.5">parent of (children)</p>
                          {outgoing.map(s => (
                            <SnapConnectionRow
                              key={s.id}
                              snap={s}
                              direction="outgoing"
                              params={scene.params}
                              paramValues={paramValues}
                              onSelectOther={(id) => setSelection({ ids: new Set([id]), primary: id })}
                              onUpdateSnap={(patch) => updateSnap(s.id, patch)}
                              onUpdateParam={(name, expr) => updateParam(name, { expr })}
                              onPromoteAxis={(axis) => promoteSnapAxis(s.id, axis)}
                              onDeleteSnap={() => deleteSnap(s.id)}
                              commitExpr={commitExpr}
                            />
                          ))}
                        </div>
                      )}
                      {mirrorMems.length > 0 && (
                        <div>
                          <p className="text-[9px] uppercase tracking-wider text-slate-600 mb-0.5">mirror group</p>
                          {mirrorMems.map((mm, i) => {
                            const otherId = mm.role === 'source' ? mm.member.mirrorId : mm.member.srcId;
                            return (
                              <div key={i} className="flex items-center gap-1 text-[10px] py-0.5">
                                <FlipHorizontal size={10} className="text-violet-400" />
                                <button onClick={() => setSelection({ ids: new Set([otherId]), primary: otherId })} className="font-mono text-violet-300 hover:text-violet-100 truncate">{otherId}</button>
                                <span className="text-slate-500">({mm.mirror.axis}, {mm.role})</span>
                                <button onClick={() => toggleMirrorLock(mm.mirror.id, mm.mirror.members.indexOf(mm.member))} className={`ml-auto ${mm.member.locked ? 'text-emerald-400' : 'text-amber-400'}`} title={mm.member.locked ? 'locked (click to unlock)' : 'unlocked (click to lock)'}>
                                  {mm.member.locked ? <Lock size={10} /> : <Unlock size={10} />}
                                </button>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })()}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Modal dialog (confirm/prompt/alert) */}
      <ModalDialog
        open={!!dialog}
        title={dialog?.title}
        message={dialog?.message}
        defaultValue={dialog?.defaultValue}
        kind={dialog?.kind}
        onConfirm={dialog?.onConfirm}
        onCancel={dialog?.onCancel}
      />

      {/* Export preview modal — shows the generated pyAEDT script with copy/download */}
      {exportPreview && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          style={{ background: 'rgba(2,6,23,0.7)' }}
          onClick={() => setExportPreview(null)}
        >
          <div
            className="rounded-lg border border-slate-700 shadow-2xl flex flex-col"
            style={{ background: '#0f172a', width: 'min(900px, 92vw)', height: 'min(80vh, 700px)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-4 py-2 border-b border-slate-700 flex items-center justify-between">
              <div>
                <h3 className="text-sm font-medium text-slate-200">Export — {exportPreview.filename}</h3>
                <p className="text-[10px] text-slate-500 mt-0.5">
                  {exportPreview.downloaded
                    ? 'Download triggered. If your browser blocked it, copy the script below.'
                    : 'Download blocked by sandbox. Copy the script below and paste into your editor.'}
                </p>
              </div>
              <button onClick={() => setExportPreview(null)} className="text-slate-500 hover:text-slate-200 text-xs">✕</button>
            </div>
            <div className="flex-1 overflow-auto p-3">
              <pre className="text-[11px] font-mono leading-relaxed text-slate-200 whitespace-pre-wrap break-all">{exportPreview.content}</pre>
            </div>
            <div className="px-4 py-3 border-t border-slate-700 flex justify-end gap-2">
              <button
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(exportPreview.content);
                    setExportPreview(p => p ? { ...p, justCopied: true } : p);
                    setTimeout(() => setExportPreview(p => p ? { ...p, justCopied: false } : p), 1500);
                  } catch (e) {
                    // Fallback: select all in the pre and let user Cmd+C
                    const pre = document.querySelector('.export-preview-pre');
                    if (pre) {
                      const range = document.createRange();
                      range.selectNodeContents(pre);
                      const sel = window.getSelection();
                      sel.removeAllRanges();
                      sel.addRange(range);
                    }
                  }
                }}
                className="px-3 py-1 rounded text-xs font-medium"
                style={{ background: '#06b6d4', color: '#0f172a' }}
              >
                {exportPreview.justCopied ? '✓ Copied' : 'Copy to clipboard'}
              </button>
              <button
                onClick={() => downloadFile(exportPreview.filename, exportPreview.content)}
                className="px-3 py-1 rounded text-xs border border-slate-600 text-slate-300 hover:bg-slate-800"
              >
                Try download again
              </button>
              <button
                onClick={() => setExportPreview(null)}
                className="px-3 py-1 rounded text-xs border border-slate-600 text-slate-300 hover:bg-slate-800"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
