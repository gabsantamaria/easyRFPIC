// Main canvas / SVG viewport.
//
// Canvas is the SVG renderer for the layout: draws layers in screen
// space, components (rect / circle / ellipse / polygon / racetrack / boolean
// cluster), anchors, snap connections, ruler measurements, parametric
// dimension arrows, and selection halos. It also owns the drag state
// machine (cluster drag, alt-drag snap creation, resize handles) and
// the ruler tool.
//
// Behavior is unchanged from the in-PhotonicLayout original; this is a
// straight cut-and-import (Stage 4.10 of the planned refactor). All
// callbacks and view state are passed in as explicit props by App.
import React, { useState, useRef, useEffect, useMemo } from 'react';
import { ANCHORS, parseAnchor, anchorLocal, anchorLocalRotated, anchorWorld, compRotationDeg, rotateLocal } from '../../scene/anchors.js';
import { evalExpr } from '../../scene/params.js';
import { solveLayout, applyMirrors, resolveBooleanBboxes } from '../../scene/solver.js';
import { expandTransforms } from '../../scene/transforms.js';
import { detectPortIntegrationLine } from '../../scene/lumpedPort.js';
import { shapeInstanceToRing, clampCornerRadius, remapPointsToInstance } from '../../geometry/rings.js';
import { buildRacetrackCenterline } from '../../geometry/racetrack.js';
import { ringToSvgPath } from '../../geometry/paths.js';
import {
  tessellatePolylinePath, taperedBandQuads, polylineIsTapered,
  tessellateArcFrom, synthArc90, resolvePolylineVertices,
} from '../../geometry/polyline.js';

// Dimension-expression classification, shared by the resize-drag commit,
// the resize-handle cursors, and the status bar. Three classes:
//   - single identifier ("aw"): the parameter IS the dimension — a resize
//     drag updates the parameter's expr.
//   - pure numeric literal ("30", "2*(3+4)"): a resize rewrites the literal.
//   - anything else ("cap_sep/2 - port_L/2"): a DERIVED expression — the
//     resize drag can't cleanly invert it into parameter changes, so
//     resizing that axis is a no-op and the UI must say so.
const isSingleIdentExpr = (s) => typeof s === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(s.trim());
const isLiteralNumExpr = (s) => typeof s === 'string' && /^[\d\s+\-*/.()]+$/.test(s.trim());
const isExprBoundDim = (s) => !isSingleIdentExpr(s) && !isLiteralNumExpr(s);

// =========================================================================
// C3 — on-canvas vertex editing: pure helpers (exported for tests)
// =========================================================================
// Format a numeric drag result as a clean literal expression. 4 decimals —
// the user is dragging by mouse, sub-0.1nm precision past that is noise.
// String(-0) === '0' in JS, so negative-zero never leaks into the scene.
export const fmtVertexLit = (v) => String(Number((Number.isFinite(v) ? v : 0).toFixed(4)));

// A vertex that on-canvas editing may rewrite: kind 'rel' (or absent — the
// default) with BOTH dx and dy pure numeric literals. Snap / arc vertices
// and expression-driven rel vertices are parametric definitions that must
// be edited in the Inspector. Spline-flagged rel vertices still qualify
// (their dx/dy are ordinary literals; the spline only affects tessellation).
export const isRelNumericVertex = (v) =>
  !!v && (v.kind === 'rel' || v.kind == null)
  && isLiteralNumExpr(String(v.dx ?? ''))
  && isLiteralNumExpr(String(v.dy ?? ''));

// Why a vertex handle can't be dragged (null = draggable). Mirrors the
// A9/A10 resize-status convention: tell the user WHAT owns the vertex and
// WHERE to edit it instead.
export function vertexDragBlock(v) {
  if (!v) return 'vertex spec missing — edit in Inspector';
  if (v.kind === 'snap') return `vertex is snap-bound to ${v.compId}.${v.anchor} — edit in Inspector`;
  if (v.kind === 'arc') return 'vertex is an arc endpoint — edit cdx/cdy/angle in Inspector';
  const dxLit = isLiteralNumExpr(String(v.dx ?? ''));
  const dyLit = isLiteralNumExpr(String(v.dy ?? ''));
  if (!dxLit || !dyLit) return `vertex is driven by '${!dxLit ? v.dx : v.dy}' — edit in Inspector`;
  return null;
}

// Rewrite the vertices array for a handle drag: vertex `idx` (rel-numeric —
// caller has already checked vertexDragBlock) moves to world point `p`, so
// its dx/dy become the offset from the PREVIOUS resolved vertex (or the
// component's own cx/cy for vertex 0). The FOLLOWING vertex, when it is
// rel-numeric, gets the inverse adjustment so its resolved position — and
// everything downstream — stays fixed (standard CAD vertex-drag semantics).
// A snap follower is absolute (unaffected); an arc / expression follower is
// left untouched, so the downstream chain shifts rigidly with the drag —
// acceptable in the rel model.
// `verts` is resolvePolylineVertices output captured at DRAG START (stable
// reference frame for the whole gesture). Returns the patched vertices array.
export function dragVertexPatch(comp, verts, idx, p) {
  const specs = comp.vertices || [];
  if (idx < 0 || idx >= specs.length) return specs;
  const prev = idx === 0
    ? [Number.isFinite(comp.cx) ? comp.cx : 0, Number.isFinite(comp.cy) ? comp.cy : 0]
    : verts[idx - 1];
  if (!prev || !Number.isFinite(prev[0]) || !Number.isFinite(prev[1])) return specs;
  const out = specs.slice();
  out[idx] = { ...specs[idx], dx: fmtVertexLit(p.x - prev[0]), dy: fmtVertexLit(p.y - prev[1]) };
  const next = specs[idx + 1];
  if (next && isRelNumericVertex(next)) {
    const nextPos = verts[idx + 1];
    if (nextPos && Number.isFinite(nextPos[0]) && Number.isFinite(nextPos[1])) {
      out[idx + 1] = { ...next, dx: fmtVertexLit(nextPos[0] - p.x), dy: fmtVertexLit(nextPos[1] - p.y) };
    }
  }
  return out;
}

// Nearest straight segment of a resolved vertex chain to point p. Segments
// run verts[i-1] → verts[i] for i in 1..n-1, plus the implicit closing edge
// (verts[n-1] → verts[0]) when `closed` — reported as endIdx === n. Returns
// { endIdx, dist, point, t } where `point` is p projected onto the segment
// (clamped), or null for degenerate input. Curved (arc / spline) spans are
// represented by their CHORD here — close enough for hit-testing, and the
// insert path refuses curved neighbors anyway.
export function nearestPolySegment(verts, p, closed = false) {
  if (!verts || verts.length < 2) return null;
  let best = null;
  const trySeg = (a, b, endIdx) => {
    if (!a || !b || !Number.isFinite(a[0]) || !Number.isFinite(a[1])
        || !Number.isFinite(b[0]) || !Number.isFinite(b[1])) return;
    const abx = b[0] - a[0], aby = b[1] - a[1];
    const len2 = abx * abx + aby * aby;
    let t = len2 > 1e-18 ? ((p.x - a[0]) * abx + (p.y - a[1]) * aby) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const qx = a[0] + t * abx, qy = a[1] + t * aby;
    const d = Math.hypot(p.x - qx, p.y - qy);
    if (!best || d < best.dist) best = { endIdx, dist: d, point: { x: qx, y: qy }, t };
  };
  for (let i = 1; i < verts.length; i++) trySeg(verts[i - 1], verts[i], i);
  if (closed) trySeg(verts[verts.length - 1], verts[0], verts.length);
  return best;
}

// Insert a rel-numeric vertex at point `p`, splitting the segment that ENDS
// at spec index `endIdx` (endIdx === specs.length = the implicit closing
// edge of a closed shape). Geometry is preserved exactly: the new vertex's
// dx/dy is the offset from the previous resolved vertex, and the follower's
// dx/dy is recomputed so its position doesn't move. Both segment endpoints
// must be rel-numeric (and the segment must not be part of a spline run /
// arc) — refusals return { error } so the caller can surface WHY instead of
// silently mangling a parametric or curved definition.
// Returns { vertices } | { error }.
export function insertVertexInSegment(comp, verts, endIdx, p) {
  const specs = comp.vertices || [];
  const closing = endIdx === specs.length;
  if (endIdx < 1 || endIdx > specs.length) return { error: 'segment index out of range' };
  const why = (v) => v?.kind === 'snap' ? 'snap-bound'
    : v?.kind === 'arc' ? 'an arc'
    : v?.spline ? 'a spline point'
    : `driven by '${v?.dx} / ${v?.dy}'`;
  const prevSpec = specs[endIdx - 1];
  if (!isRelNumericVertex(prevSpec)) {
    return { error: `segment start is ${why(prevSpec)} — edit in Inspector` };
  }
  const prevPos = verts[endIdx - 1];
  if (!prevPos || !Number.isFinite(prevPos[0]) || !Number.isFinite(prevPos[1])) {
    return { error: 'segment endpoints are unresolved' };
  }
  const newSpec = { kind: 'rel', dx: fmtVertexLit(p.x - prevPos[0]), dy: fmtVertexLit(p.y - prevPos[1]) };
  if (closing) {
    // Closing edge: appending never touches vertex 0 (it's relative to the
    // component's cx/cy, not the previous vertex), so downstream geometry
    // is fixed by construction.
    return { vertices: [...specs, newSpec] };
  }
  const nextSpec = specs[endIdx];
  if (!isRelNumericVertex(nextSpec) || nextSpec.spline) {
    return { error: `segment end is ${why(nextSpec)} — edit in Inspector` };
  }
  const nextPos = verts[endIdx];
  if (!nextPos || !Number.isFinite(nextPos[0]) || !Number.isFinite(nextPos[1])) {
    return { error: 'segment endpoints are unresolved' };
  }
  const newNext = { ...nextSpec, dx: fmtVertexLit(nextPos[0] - p.x), dy: fmtVertexLit(nextPos[1] - p.y) };
  return { vertices: [...specs.slice(0, endIdx), newSpec, newNext, ...specs.slice(endIdx + 1)] };
}

// Delete vertex `idx`, keeping every DOWNSTREAM vertex's resolved position
// fixed when possible. The follower's dx/dy (when rel-numeric) is rewritten
// to the absolute offset from the deleted vertex's predecessor — for plain
// rel-numeric chains this equals the classic "merge the two dx/dy pairs".
// A snap follower is absolute and needs no rewrite. An arc follower (its
// center hangs off the previous vertex) or an expression-driven follower
// refuses — deleting would silently bend the curve / break the parametric
// chain. Enforces the shape's minimum vertex count: 2 polyline / 3 polyshape.
// Returns { vertices } | { error }.
export function deleteVertexFixDownstream(comp, verts, idx) {
  const specs = comp.vertices || [];
  const minVerts = comp.kind === 'polyshape' ? 3 : 2;
  if (idx < 0 || idx >= specs.length) return { error: 'vertex index out of range' };
  if (specs.length <= minVerts) {
    return { error: `${comp.kind === 'polyshape' ? 'polyshape' : 'polyline'} needs at least ${minVerts} vertices` };
  }
  const next = specs[idx + 1];
  const out = specs.slice();
  if (next) {
    if (next.kind === 'snap') {
      // Absolute position — nothing to rewrite.
    } else if (isRelNumericVertex(next)) {
      const base = idx === 0
        ? [Number.isFinite(comp.cx) ? comp.cx : 0, Number.isFinite(comp.cy) ? comp.cy : 0]
        : verts[idx - 1];
      const pos = verts[idx + 1];
      if (!base || !pos || !Number.isFinite(base[0]) || !Number.isFinite(pos[0])) {
        return { error: 'vertex positions are unresolved' };
      }
      out[idx + 1] = { ...next, dx: fmtVertexLit(pos[0] - base[0]), dy: fmtVertexLit(pos[1] - base[1]) };
    } else if (next.kind === 'arc') {
      return { error: 'following vertex is an arc — delete it first or edit in Inspector' };
    } else {
      return { error: `following vertex is driven by '${next.dx} / ${next.dy}' — edit in Inspector` };
    }
  }
  out.splice(idx, 1);
  return { vertices: out };
}

// =========================================================================
// C5 — smart alignment guides: pure helper (exported for tests)
// =========================================================================
// One-axis alignment search. `dragVals` = the dragged bbox's candidate
// coordinates on this axis ([L, C, R] for x; [B, C, T] for y); `targets` =
// candidate coordinates from all other visible instances, each
// { val, compId }. Picks the smallest |delta| within `thresh`, then reports
// EVERY distinct target coordinate that some dragged edge lands exactly on
// after applying that delta — so the caller can draw one guide line per
// aligned coordinate (a single shift often satisfies L-against-one-comp AND
// R-against-another simultaneously). Returns { delta, guides } | null.
export function alignAxis(dragVals, targets, thresh) {
  if (!dragVals || !targets || !(thresh > 0)) return null;
  let best = null;
  for (const dv of dragVals) {
    if (!Number.isFinite(dv)) continue;
    for (const t of targets) {
      if (!t || !Number.isFinite(t.val)) continue;
      const delta = t.val - dv;
      const ad = Math.abs(delta);
      if (ad <= thresh && (!best || ad < Math.abs(best.delta))) best = { delta };
    }
  }
  if (!best) return null;
  const guides = [];
  const seen = new Set();
  for (const t of targets) {
    if (!t || !Number.isFinite(t.val)) continue;
    for (const dv of dragVals) {
      if (Number.isFinite(dv) && Math.abs(dv + best.delta - t.val) < 1e-6) {
        const key = t.val.toFixed(9);
        if (!seen.has(key)) { seen.add(key); guides.push({ val: t.val, compId: t.compId }); }
        break;
      }
    }
  }
  return { delta: best.delta, guides };
}

// =========================================================================
// F1 — uniform-grid spatial index: pure helpers (exported for tests)
// =========================================================================
// A uniform grid over WORLD coordinates. Cell size derives from the indexed
// geometry (viewport-independent), so zoom changes never force a rebuild.
// Items are inserted into every cell their AABB overlaps; queries visit each
// item at most once (identity dedupe) and may return a SUPERSET of true
// matches — callers re-gate with their own exact distance / overlap checks,
// which is what preserves behavioral equivalence with the old full scans.
export function buildUniformGrid(cellSize) {
  return { cellSize: Number.isFinite(cellSize) && cellSize > 0 ? cellSize : 1, cells: new Map() };
}

export function gridInsert(grid, minX, minY, maxX, maxY, item) {
  const cs = grid.cellSize;
  const ix0 = Math.floor(minX / cs), ix1 = Math.floor(maxX / cs);
  const iy0 = Math.floor(minY / cs), iy1 = Math.floor(maxY / cs);
  // NaN bounds: the old scans rejected such candidates via NaN-poisoned
  // distance comparisons; dropping them from the index is equivalent.
  if (!Number.isFinite(ix0) || !Number.isFinite(ix1) || !Number.isFinite(iy0) || !Number.isFinite(iy1)) return;
  for (let ix = ix0; ix <= ix1; ix++) {
    for (let iy = iy0; iy <= iy1; iy++) {
      const k = `${ix},${iy}`;
      let arr = grid.cells.get(k);
      if (!arr) { arr = []; grid.cells.set(k, arr); }
      arr.push(item);
    }
  }
}

// Visit every item whose insertion AABB overlaps the query box. When the
// box covers more cells than are occupied (zoomed way out → huge world
// threshold), scan the occupied cells directly instead — bounds the worst
// case at O(N) rather than O(cells in range).
export function gridQuery(grid, minX, minY, maxX, maxY, visit) {
  const cs = grid.cellSize;
  const ix0 = Math.floor(minX / cs), ix1 = Math.floor(maxX / cs);
  const iy0 = Math.floor(minY / cs), iy1 = Math.floor(maxY / cs);
  if (!Number.isFinite(ix0) || !Number.isFinite(ix1) || !Number.isFinite(iy0) || !Number.isFinite(iy1)) return;
  const seen = new Set();
  const scan = (arr) => {
    for (const item of arr) {
      if (!seen.has(item)) { seen.add(item); visit(item); }
    }
  };
  const nCells = (ix1 - ix0 + 1) * (iy1 - iy0 + 1);
  if (!Number.isFinite(nCells) || nCells >= grid.cells.size) {
    for (const arr of grid.cells.values()) scan(arr);
    return;
  }
  for (let ix = ix0; ix <= ix1; ix++) {
    for (let iy = iy0; iy <= iy1; iy++) {
      const arr = grid.cells.get(`${ix},${iy}`);
      if (arr) scan(arr);
    }
  }
}

// Cell size heuristic: a couple × the median indexed shape size ("a few ×
// typical anchor spacing" — anchors sit half a shape apart). Derived purely
// from world-space geometry so the index is viewport-independent.
export function pickGridCellSize(sizes, fallback = 10) {
  const vals = [];
  for (const v of sizes || []) if (Number.isFinite(v) && v > 0) vals.push(v);
  if (vals.length === 0) return fallback;
  vals.sort((a, b) => a - b);
  return Math.max(1e-3, vals[Math.floor(vals.length / 2)] * 2);
}

// -------------------------------------------------------------------------
// Anchor / ruler snap index. One index serves findRulerSnap AND
// findAnchorSnap: it carries every candidate the old exhaustive scans
// enumerated, in two families:
//   - anchor grid:  the 9 ROTATED fixed-anchor world points per "source"
//   - rect grid:    one record per source for the parametric edge-projection
//                   pass (a projection is a function of the cursor, so it
//                   can't be a point lookup — nearby sources are found via
//                   their world AABB, then the EXACT original projection
//                   math runs on each)
// Sources are (in this order, which fixes tie-breaking):
//   1. every transform instance with finite positive w/h (base + repeat /
//      mirror copies, including boolean outer AABBs) — anchors and edge
//      projections both live in the instance's rotated local frame;
//   2. per-operand cells of TRANSFORMED boolean instances (idx > 0):
//      anchors rotate by chain + base rotation, edge projections stay
//      axis-aligned — exactly the approximation the old code used.
// Each source owns a block of 13 sequence slots (9 anchors, then T, B, L, R
// projections) matching the old consider() call order; queries pick the
// lexicographic (distance, seq) minimum, which reproduces the old scans'
// nearest-wins / first-wins-on-tie selection EXACTLY.
export function buildAnchorSnapIndex(transformInstances, solved) {
  const sources = [];
  // (1) transform-expanded instances.
  for (const inst of transformInstances) {
    const w = inst.w, h = inst.h;
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) continue;
    const rot = inst.rotation || 0;
    sources.push({
      cx: inst.cx, cy: inst.cy, w, h,
      anchorRot: rot, projRot: rot,
      compId: inst.compId, instanceIdx: inst.idx,
      // excludeKey: the id findAnchorSnap's excludeCompId filter tests.
      excludeKey: inst.compId,
    });
  }
  // (2) boolean operand cells at idx > 0 — same translate → mirror → rotate
  // composition the boolean cluster renderer uses (see
  // buildBoolOverridesForInstance).
  const solvedById = new Map(solved.map(c => [c.id, c]));
  const baseInstByCompId = new Map();
  for (const ii of transformInstances) {
    if (ii.idx === 0 && !baseInstByCompId.has(ii.compId)) baseInstByCompId.set(ii.compId, ii);
  }
  for (const inst of transformInstances) {
    if (inst.kind !== 'boolean' || inst.idx === 0) continue;
    const b = solvedById.get(inst.compId);
    if (!b) continue;
    const dx = inst.cx - b.cx;
    const dy = inst.cy - b.cy;
    const rot = inst.rotation || 0;
    const bSx = inst.scaleX ?? 1;
    const bSy = inst.scaleY ?? 1;
    if (!dx && !dy && !rot && bSx === 1 && bSy === 1) continue;
    const rad = rot * Math.PI / 180;
    const ca = Math.cos(rad), sa = Math.sin(rad);
    const visitOp = (cid) => {
      const op = solvedById.get(cid);
      if (!op) return;
      if (op.kind === 'boolean') {
        for (const childId of (op.operandIds || [])) visitOp(childId);
        return;
      }
      const baseInst = baseInstByCompId.get(op.id);
      if (!baseInst) return;
      const opW = baseInst.w, opH = baseInst.h;
      if (!Number.isFinite(opW) || !Number.isFinite(opH) || opW <= 0 || opH <= 0) return;
      let tx = baseInst.cx + dx;
      let ty = baseInst.cy + dy;
      if (bSx === -1) tx = 2 * inst.cx - tx;
      if (bSy === -1) ty = 2 * inst.cy - ty;
      const rxC = tx - inst.cx;
      const ryC = ty - inst.cy;
      const newCx = rot ? inst.cx + rxC * ca - ryC * sa : tx;
      const newCy = rot ? inst.cy + rxC * sa + ryC * ca : ty;
      sources.push({
        cx: newCx, cy: newCy, w: opW, h: opH,
        anchorRot: rot + (baseInst.rotation || 0),
        projRot: 0, // operand-cell edge projections stay axis-aligned
        compId: op.id, instanceIdx: inst.idx,
        // The old scan excluded operand-cell candidates when the BOOLEAN
        // was the excluded component (not the operand).
        excludeKey: inst.compId,
      });
    };
    for (const opid of (b.operandIds || [])) visitOp(opid);
  }
  const cellSize = pickGridCellSize(sources.map(s => Math.max(s.w, s.h)));
  const anchorGrid = buildUniformGrid(cellSize);
  const rectGrid = buildUniformGrid(cellSize);
  let seqBase = 0;
  for (const s of sources) {
    for (let ai = 0; ai < ANCHORS.length; ai++) {
      const lp = anchorLocalRotated(ANCHORS[ai], s.w, s.h, s.anchorRot);
      const x = s.cx + lp.x, y = s.cy + lp.y;
      gridInsert(anchorGrid, x, y, x, y, {
        x, y, compId: s.compId, anchor: ANCHORS[ai],
        instanceIdx: s.instanceIdx, excludeKey: s.excludeKey,
        seq: seqBase + ai,
      });
    }
    // World AABB of the (projRot-rotated) rect — every edge-projection
    // point lies inside it, so a disc-bbox query can never miss a source
    // that the old scan would have produced a candidate from.
    const rad = s.projRot * Math.PI / 180;
    const ca = Math.abs(Math.cos(rad)), sa = Math.abs(Math.sin(rad));
    const hw = (s.w / 2) * ca + (s.h / 2) * sa;
    const hh = (s.w / 2) * sa + (s.h / 2) * ca;
    gridInsert(rectGrid, s.cx - hw, s.cy - hh, s.cx + hw, s.cy + hh, { ...s, seqBase });
    seqBase += 13;
  }
  return { anchorGrid, rectGrid, cellSize };
}

// Query the anchor snap index for the best candidate within `worldThresh`
// of wp. Returns null or
//   { kind: 'anchor', x, y, compId, anchor, instanceIdx, d, seq }
//   { kind: 'edge',   x, y, compId, side: 'T'|'B'|'L'|'R', t, instanceIdx, d, seq }
// Selection = lexicographic (d, seq) minimum — identical to the old scans'
// encounter-order strict-< tie-breaking.
export function queryAnchorSnapIndex(index, wp, worldThresh, excludeCompId = null) {
  if (!index) return null;
  let best = null;
  const better = (d, seq) => !best || d < best.d || (d === best.d && seq < best.seq);
  const minX = wp.x - worldThresh, maxX = wp.x + worldThresh;
  const minY = wp.y - worldThresh, maxY = wp.y + worldThresh;
  // Fixed anchors.
  gridQuery(index.anchorGrid, minX, minY, maxX, maxY, (pt) => {
    if (excludeCompId && pt.excludeKey === excludeCompId) return;
    const d = Math.sqrt((wp.x - pt.x) * (wp.x - pt.x) + (wp.y - pt.y) * (wp.y - pt.y));
    if (d <= worldThresh && better(d, pt.seq)) {
      best = {
        kind: 'anchor', x: pt.x, y: pt.y, compId: pt.compId,
        anchor: pt.anchor, instanceIdx: pt.instanceIdx, d, seq: pt.seq,
      };
    }
  });
  // Parametric edge projections on nearby sources — the EXACT local-frame
  // math the old scans ran on every instance, here only on sources whose
  // world AABB intersects the query disc's bbox.
  gridQuery(index.rectGrid, minX, minY, maxX, maxY, (r) => {
    if (excludeCompId && r.excludeKey === excludeCompId) return;
    const rad = r.projRot * Math.PI / 180;
    const ca = Math.cos(rad), sa = Math.sin(rad);
    const lwx = (wp.x - r.cx) * ca + (wp.y - r.cy) * sa;
    const lwy = -(wp.x - r.cx) * sa + (wp.y - r.cy) * ca;
    const x0 = -r.w / 2, x1 = r.w / 2;
    const y0 = -r.h / 2, y1 = r.h / 2;
    const toWorld = (lx, ly) => ({ x: r.cx + lx * ca - ly * sa, y: r.cy + lx * sa + ly * ca });
    const tryProj = (p, side, t, slot) => {
      const d = Math.sqrt((wp.x - p.x) * (wp.x - p.x) + (wp.y - p.y) * (wp.y - p.y));
      const seq = r.seqBase + slot;
      if (d <= worldThresh && better(d, seq)) {
        best = {
          kind: 'edge', x: p.x, y: p.y, compId: r.compId,
          side, t, instanceIdx: r.instanceIdx, d, seq,
        };
      }
    };
    if (lwx >= x0 - worldThresh && lwx <= x1 + worldThresh) {
      const projX = Math.max(x0, Math.min(x1, lwx));
      const tX = (projX - x0) / (x1 - x0);
      tryProj(toWorld(projX, y1), 'T', tX, 9);
      tryProj(toWorld(projX, y0), 'B', tX, 10);
    }
    if (lwy >= y0 - worldThresh && lwy <= y1 + worldThresh) {
      const projY = Math.max(y0, Math.min(y1, lwy));
      const tY = (projY - y0) / (y1 - y0);
      tryProj(toWorld(x0, projY), 'L', tY, 11);
      tryProj(toWorld(x1, projY), 'R', tY, 12);
    }
  });
  return best;
}

// Ruler labels for edge-projection hits (matches the old findRulerSnap
// label strings exactly).
const RULER_EDGE_LABEL = { T: 'top', B: 'bot', L: 'left', R: 'right' };

// -------------------------------------------------------------------------
// Alt-drag target index: 9 rotated anchors + the axis-aligned bbox per
// SOLVED component (skipping consumed operands — same gate the old per-tick
// scan applied). clusterSet exclusion is drag-specific and happens at query
// time. Each component owns a 99-slot sequence block (81 anchor pairs +
// 9 h-edge + 9 v-edge candidates) reproducing the old enumeration order.
export function buildAltDragTargetIndex(solved, paramValues, dimsByCompId) {
  const recs = [];
  for (let k = 0; k < solved.length; k++) {
    const oc = solved[k];
    if (oc.consumedBy) continue;
    const dims = (dimsByCompId && dimsByCompId[oc.id]) || {
      w: evalExpr(oc.w, paramValues), h: evalExpr(oc.h, paramValues),
    };
    const ow = dims.w, oh = dims.h;
    if (!Number.isFinite(ow) || !Number.isFinite(oh) || ow <= 0 || oh <= 0) continue;
    recs.push({ oc, ocIdx: k, ow, oh, rot: compRotationDeg(oc, paramValues) });
  }
  const cellSize = pickGridCellSize(recs.map(r => Math.max(r.ow, r.oh)));
  const anchorGrid = buildUniformGrid(cellSize);
  const rectGrid = buildUniformGrid(cellSize);
  for (const r of recs) {
    for (let ai = 0; ai < ANCHORS.length; ai++) {
      const lp = anchorLocalRotated(ANCHORS[ai], r.ow, r.oh, r.rot);
      const x = r.oc.cx + lp.x, y = r.oc.cy + lp.y;
      gridInsert(anchorGrid, x, y, x, y, {
        x, y, compId: r.oc.id, anchor: ANCHORS[ai], anchorIdx: ai, ocIdx: r.ocIdx,
      });
    }
    gridInsert(
      rectGrid,
      r.oc.cx - r.ow / 2, r.oc.cy - r.oh / 2,
      r.oc.cx + r.ow / 2, r.oc.cy + r.oh / 2,
      r
    );
  }
  return { anchorGrid, rectGrid, cellSize };
}

// The alt-drag candidate-pair search, index-backed. Returns
// { best, currentBest } with candidate objects shaped EXACTLY like the old
// inline scan produced:
//   anchor: { kind:'anchor', dist, dAnchor, target: { x, y, compId, anchor } }
//   edge:   { kind:'edge', dist, rawDist, axis, targetCompId, targetSide,
//             dSide, edgeVal, x, y }
// `currentBest` is the candidate matching the prior tick's moveSnapHover
// (for the caller's hysteresis), tracked only when within threshold — same
// as before. Tie-breaking uses per-component sequence blocks so the winner
// matches the old solved-order scan exactly.
export function findAltDragSnapCandidate(index, {
  proposedCx, proposedCy, dw, dh, dragRotationDeg = 0,
  clusterSet = null, worldThresh, moveSnapHover = null,
}) {
  let best = null;
  let bestSeq = Infinity;
  let currentBest = null;
  const better = (dist, seq) => !best || dist < best.dist || (dist === best.dist && seq < bestSeq);
  const SEQ_BLOCK = 99;
  const dxMin = proposedCx - dw / 2, dxMax = proposedCx + dw / 2;
  const dyMin = proposedCy - dh / 2, dyMax = proposedCy + dh / 2;
  // -----------------------------------------------------------
  // (1) Anchor-pair candidates: for each of the dragged cluster's
  //     9 (rotation-aware) anchors, pull target anchors within
  //     threshold from the index instead of scanning every
  //     component × 81 pairs.
  // -----------------------------------------------------------
  for (let dj = 0; dj < ANCHORS.length; dj++) {
    const da = ANCHORS[dj];
    const dlp = anchorLocalRotated(da, dw, dh, dragRotationDeg);
    const dax = proposedCx + dlp.x;
    const day = proposedCy + dlp.y;
    gridQuery(
      index.anchorGrid,
      dax - worldThresh, day - worldThresh, dax + worldThresh, day + worldThresh,
      (pt) => {
        if (clusterSet && clusterSet.has(pt.compId)) return;
        const dist = Math.hypot(pt.x - dax, pt.y - day);
        if (dist <= worldThresh) {
          const cand = {
            kind: 'anchor',
            dist,
            dAnchor: da,
            target: { x: pt.x, y: pt.y, compId: pt.compId, anchor: pt.anchor },
          };
          const seq = pt.ocIdx * SEQ_BLOCK + pt.anchorIdx * 9 + dj;
          if (better(dist, seq)) { best = cand; bestSeq = seq; }
          if (moveSnapHover && moveSnapHover.kind === 'anchor' &&
              moveSnapHover.compId === pt.compId &&
              moveSnapHover.anchor === pt.anchor &&
              moveSnapHover.dAnchor === da) {
            currentBest = cand;
          }
        }
      }
    );
  }
  // -----------------------------------------------------------
  // (2) Edge-pair candidates on components whose bbox is within
  //     threshold of the dragged cluster bbox (a bbox query can't
  //     miss any: an edge candidate needs strict overlap on one
  //     axis and a ≤ threshold edge offset on the other). The
  //     per-component logic below is byte-for-byte the old pass.
  // -----------------------------------------------------------
  gridQuery(
    index.rectGrid,
    dxMin - worldThresh, dyMin - worldThresh, dxMax + worldThresh, dyMax + worldThresh,
    (r) => {
      const oc = r.oc;
      if (clusterSet && clusterSet.has(oc.id)) return;
      const ow = r.ow, oh = r.oh;
      const oxMin = oc.cx - ow / 2, oxMax = oc.cx + ow / 2;
      const oyMin = oc.cy - oh / 2, oyMax = oc.cy + oh / 2;
      const xOverlap = Math.min(oxMax, dxMax) - Math.max(oxMin, dxMin);
      const yOverlap = Math.min(oyMax, dyMax) - Math.max(oyMin, dyMin);
      // Edge candidates get a constant ranking penalty on top of their raw
      // 1-D distance so the closest anchor pair wins when the user is
      // clearly aiming at a corner / midpoint (see the original rationale
      // in the alt-drag handler). Threshold gating is unchanged.
      const EDGE_RANK_PENALTY = worldThresh * 0.4;
      const tryEdge = (axis, dSide, dEdgeVal, tSide, tEdgeVal, midX, midY, slot) => {
        const rawDist = Math.abs(dEdgeVal - tEdgeVal);
        if (rawDist > worldThresh) return;
        const cand = {
          kind: 'edge',
          dist: rawDist + EDGE_RANK_PENALTY,
          rawDist,
          axis,
          targetCompId: oc.id,
          targetSide: tSide,
          dSide,
          edgeVal: tEdgeVal,
          x: midX, y: midY,
        };
        const seq = r.ocIdx * SEQ_BLOCK + 81 + slot;
        if (better(cand.dist, seq)) { best = cand; bestSeq = seq; }
        if (moveSnapHover && moveSnapHover.kind === 'edge' &&
            moveSnapHover.axis === axis &&
            moveSnapHover.targetCompId === oc.id &&
            moveSnapHover.targetSide === tSide &&
            moveSnapHover.dSide === dSide) {
          currentBest = cand;
        }
      };
      if (xOverlap > 0) {
        const midX = (Math.max(oxMin, dxMin) + Math.min(oxMax, dxMax)) / 2;
        const dSidesY = [['top', dyMax], ['bottom', dyMin], ['centerY', proposedCy]];
        const tSidesY = [['top', oyMax], ['bottom', oyMin], ['centerY', oc.cy]];
        for (let di = 0; di < dSidesY.length; di++) {
          for (let ti = 0; ti < tSidesY.length; ti++) {
            tryEdge('h', dSidesY[di][0], dSidesY[di][1], tSidesY[ti][0], tSidesY[ti][1], midX, tSidesY[ti][1], di * 3 + ti);
          }
        }
      }
      if (yOverlap > 0) {
        const midY = (Math.max(oyMin, dyMin) + Math.min(oyMax, dyMax)) / 2;
        const dSidesX = [['right', dxMax], ['left', dxMin], ['centerX', proposedCx]];
        const tSidesX = [['right', oxMax], ['left', oxMin], ['centerX', oc.cx]];
        for (let di = 0; di < dSidesX.length; di++) {
          for (let ti = 0; ti < tSidesX.length; ti++) {
            tryEdge('v', dSidesX[di][0], dSidesX[di][1], tSidesX[ti][0], tSidesX[ti][1], tSidesX[ti][1], midY, 9 + di * 3 + ti);
          }
        }
      }
    }
  );
  return { best, currentBest };
}

// =========================================================================
// F3 — boolean per-instance operand overrides: pure builder (exported for
// tests). Composes a boolean instance's transform (translate → mirror →
// rotate about the instance centroid) onto each PRIMITIVE operand's base
// instance, recursively through nested booleans. Returns a map
// compId → synthetic instance, or null when the instance carries no
// transform. `compById` maps SCENE components; `baseInstOf(c)` returns the
// operand's own base (idx 0) transform instance.
// =========================================================================
export function buildBoolOverridesForInstance(b, bInst, bBaseCx, bBaseCy, compById, baseInstOf) {
  const dx = bInst.cx - bBaseCx;
  const dy = bInst.cy - bBaseCy;
  const rot = bInst.rotation || 0;
  const bSx = bInst.scaleX ?? 1;
  const bSy = bInst.scaleY ?? 1;
  if (!dx && !dy && !rot && bSx === 1 && bSy === 1) return null;
  const rad = rot * Math.PI / 180;
  const ca = Math.cos(rad), sa = Math.sin(rad);
  const overrides = {};
  // Walk the boolean's operand tree, transforming each PRIMITIVE operand it
  // finds. Nested booleans' operands also get transformed; the parent
  // boolean's transform applies uniformly to every descendant.
  const visit = (c) => {
    if (!c) return;
    if (c.kind === 'boolean') {
      for (const id of (c.operandIds || [])) visit(compById[id]);
      return;
    }
    // Take the operand's base (un-transformed-by-the-boolean) instance.
    const base = baseInstOf(c);
    // Step 1: translate the operand by (dx, dy) so its position is
    // expressed in the post-translation frame around bInst.
    const tx = base.cx + dx;
    const ty = base.cy + dy;
    // Step 2: if the boolean carries a mirror, reflect the operand about
    // the boolean's instance center along the appropriate axis. This flips
    // the operand's position AND toggles its own scale flags so the
    // operand's shape renders mirrored, not just repositioned.
    let mx = tx, my = ty;
    let opSx = base.scaleX ?? 1, opSy = base.scaleY ?? 1;
    if (bSx === -1) { mx = 2 * bInst.cx - tx; opSx = -opSx; }
    if (bSy === -1) { my = 2 * bInst.cy - ty; opSy = -opSy; }
    // Step 3: rotate the (translated-then-mirrored) point about the
    // boolean's instance center. expandTransforms already negated rotation
    // when a mirror fired, so the recorded `rot` is correct for the final
    // orientation.
    const rx = mx - bInst.cx;
    const ry = my - bInst.cy;
    const newCx = rot ? bInst.cx + rx * ca - ry * sa : mx;
    const newCy = rot ? bInst.cy + rx * sa + ry * ca : my;
    overrides[c.id] = {
      ...base,
      cx: newCx,
      cy: newCy,
      rotation: (base.rotation || 0) + rot,
      scaleX: opSx,
      scaleY: opSy,
    };
  };
  visit(b);
  return overrides;
}

// Constant-size inline input used inside the editable-dimensions overlay.
// Rendered in an SVG <foreignObject>, so all CSS lengths are passed in
// SCREEN PIXELS (via the canvas `screen()` helper) to stay a fixed visible
// size at every zoom. Uncontrolled (remounts via `key` when `initial`
// changes) so a re-solve after commit refreshes it without fighting focus.
function CanvasDimInput({ initial, fontPx, widthPx, color, title, onCommit }) {
  return (
    <input
      defaultValue={initial}
      title={title}
      spellCheck={false}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') e.currentTarget.blur();
        else if (e.key === 'Escape') { e.currentTarget.value = initial; e.currentTarget.blur(); }
      }}
      onBlur={(e) => { const v = e.currentTarget.value.trim(); if (v && v !== initial) onCommit(v); }}
      style={{
        width: `${widthPx}px`,
        fontSize: `${fontPx}px`,
        lineHeight: 1.1,
        fontFamily: 'monospace',
        padding: `${fontPx * 0.18}px ${fontPx * 0.35}px`,
        background: 'rgba(15,23,42,0.96)',
        color,
        border: `1px solid ${color}`,
        borderRadius: `${fontPx * 0.28}px`,
        outline: 'none',
        boxSizing: 'border-box',
        pointerEvents: 'auto',
        textAlign: 'center',
      }}
    />
  );
}

// =========================================================================
// CANVAS
// =========================================================================
export function Canvas({ scene, updateScene, selectedId, selectedIds, setSelection, viewport, setViewport, snapMode, setSnapMode, gridSize, gridSnapEnabled, showGrid = true, paramValues, addParam, updateParamExpr, rulerMode, setRulerMode, rulerMeasurements, setRulerMeasurements, rulerInProgress, setRulerInProgress, rulerSnapPoint, setRulerSnapPoint, alertDialog, setInteractionStatus, showDimensions, editDims = false, commitExpr = null, renameParam = null, addMode, setAddMode, commitDragAdd, onComponentContextMenu, onSvgElement, flashAnchor = null }) {
  // Drop a single committed ruler measurement by id.
  const deleteRuler = (id) => setRulerMeasurements((prev) => prev.filter((m) => m.id !== id));
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

  // [F2] Evaluated dims per SOLVED component. evalExpr passes numbers
  // through unchanged, so this matches both the bare evalExpr(c.w) sites
  // and the `typeof c.w === 'string' ? evalExpr(...) : c.w` sites it
  // replaces (solved primitives carry expression strings; solved booleans
  // carry numerics written by resolveBooleanBboxes).
  const dimsByCompId = useMemo(() => {
    const m = {};
    for (const c of solved) {
      m[c.id] = { w: evalExpr(c.w, paramValues), h: evalExpr(c.h, paramValues) };
    }
    return m;
  }, [solved, paramValues]);

  // [F1] Spatial index over every anchor candidate findRulerSnap /
  // findAnchorSnap used to enumerate per call (9 rotated anchors per
  // transform instance + boolean operand cells + edge-projection rects).
  // Stable across mousemoves — the heavy consumers (ruler hover, polyline
  // draft, add-drag) don't mutate the scene while probing.
  const anchorSnapIndex = useMemo(
    () => buildAnchorSnapIndex(transformInstances, solved),
    [transformInstances, solved]
  );

  // [F1] Alt-drag target index (9 rotated anchors + bbox per solved,
  // non-consumed component). Rebuilds when the solve changes — during an
  // alt-drag that's once per committed move, still far cheaper than the
  // old per-tick solved × 81 anchor-pair scan.
  const altDragTargetIndex = useMemo(
    () => buildAltDragTargetIndex(solved, paramValues, dimsByCompId),
    [solved, paramValues, dimsByCompId]
  );

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
    const compById0 = Object.fromEntries(scene.components.map(c => [c.id, c]));
    for (const b of allBooleanComps) {
      for (const id of (b.operandIds || [])) {
        // Only treat an operand as "consumed by a boolean" if it actually
        // is — i.e., its consumedBy points back at THIS boolean. Punch's
        // tool operands are intentionally left non-consumed so they keep
        // rendering as standalone primitives even though they participate
        // in the boolean's geometry.
        const opComp = compById0[id];
        if (!opComp || opComp.consumedBy !== b.id) continue;
        operandIds.add(id);
        operandToBooleanId[id] = b.id;
      }
    }
    // Cluster = top-level boolean's id + ALL transitively reachable
    // CONSUMED operands. Non-consumed operands (punch tools) stay
    // outside the cluster — they're true standalone shapes that just
    // happen to participate in this boolean's geometry. In HFSS terms,
    // this matches Subtract with "clone tool object before operation":
    // the tool keeps its identity and isn't dragged with the result.
    const memberToCluster = {};
    const compById = Object.fromEntries(scene.components.map(c => [c.id, c]));
    const collectMembers = (id, acc) => {
      if (acc.has(id)) return;
      acc.add(id);
      const c = compById[id];
      if (c && c.kind === 'boolean') {
        for (const opid of (c.operandIds || [])) {
          const opC = compById[opid];
          if (!opC || opC.consumedBy !== c.id) continue;
          collectMembers(opid, acc);
        }
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
  // Polyline-add draft state. Active when the user enters polyline addMode
  // (shape='polyline') and starts clicking. Each click appends a vertex,
  // each mousemove updates `cursorPos` for the preview segment.
  // Shape:
  //   {
  //     vertices: [{ x, y, snap: { compId, anchor } | null,
  //                  arc?: { cdx, cdy, angle } }],
  //     cursorPos: { x, y } | null,
  //     cursorSnap: { compId, anchor } | null,
  //     axisGuide:  { axis: 'h'|'v', ref: vertexIdx } | null,
  //     arcNext: boolean,   // 'a' toggles — next click places a 90° arc
  //   }
  // An `arc` vertex's (x, y) is the arc ENDPOINT; cdx/cdy are NUMERIC
  // offsets from the PREVIOUS vertex to the arc center and angle is
  // ±90 (the draw UX synthesizes quarter-circle arcs; the inspector
  // can re-shape them afterwards via the cdx/cdy/angle expressions).
  const [polylineDraft, setPolylineDraft] = useState(null);
  // Pre-drag hover snap target for addMode (preview before clicking).
  const [addHoverSnap, setAddHoverSnap] = useState(null);
  // ^ shape: { x, y, compId, anchor } | null
  // Snap target during a move-drag with Alt held: the existing-component
  // anchor under (or near) the cursor that the dragged component will snap
  // to on release. Re-evaluated on every mousemove while Alt is held.
  const [moveSnapHover, setMoveSnapHover] = useState(null);
  // ^ shape: { x, y, compId, anchor } | null
  // C3: in-flight vertex-handle drag on a primary-selected polyline /
  // polyshape. `origVerts` / `comp` are the drag-start snapshots (stable
  // reference frame); `preview` is the live-patched vertices array — the
  // render path substitutes it so the user sees the result WITHOUT touching
  // the scene; the single updateScene commit happens on mouseup (one undo
  // step).
  const [vertexDrag, setVertexDrag] = useState(null);
  // ^ shape: { compId, idx, comp, origVerts, preview } | null
  // C3: transient status-bar message for refused vertex edits ("vertex is
  // snap-bound — edit in Inspector" etc.). Auto-clears after a few seconds.
  const [vertexEditStatus, setVertexEditStatus] = useState(null);
  // ^ shape: { line } | null
  // C5: smart-alignment guides active during a PLAIN move-drag. Each entry
  // is an aligned coordinate (world units) + the component that produced
  // it; rendered as full-viewport magenta lines. Numeric-only convenience —
  // no scene snaps are ever created from these.
  const [alignGuides, setAlignGuides] = useState(null);
  // ^ shape: { x: [{ val, compId }], y: [{ val, compId }] } | null
  // C10: whether the flash-anchor halo is currently visible (set on nonce
  // bump, cleared by timeout ~1.5 s later).
  const [flashVisible, setFlashVisible] = useState(false);

  // C3: auto-clear the vertex-edit refusal status so it doesn't linger in
  // the status bar after the user has read it.
  useEffect(() => {
    if (!vertexEditStatus) return;
    const t = setTimeout(() => setVertexEditStatus(null), 3000);
    return () => clearTimeout(t);
  }, [vertexEditStatus]);

  // C10: flash-anchor lifecycle. A nonce bump (re)triggers the 3-pulse halo;
  // the <g key={nonce}> in the render path remounts the SMIL animation so
  // repeat flashes on the same anchor restart cleanly.
  useEffect(() => {
    if (!flashAnchor || !flashAnchor.compId) { setFlashVisible(false); return; }
    setFlashVisible(true);
    const t = setTimeout(() => setFlashVisible(false), 1500);
    return () => clearTimeout(t);
  }, [flashAnchor?.nonce, flashAnchor?.compId, flashAnchor?.anchor]);

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
        if (polylineDraft) setPolylineDraft(null);
        else if (addDrag) setAddDrag(null);
        else setAddMode(null);
      } else if ((addMode?.shape === 'polyline' || addMode?.shape === 'polyshape') && polylineDraft) {
        // Enter / Return: commit polyline / polyshape as-is.
        //  - polyline needs ≥ 2 vertices (a 1-segment trace is valid)
        //  - polyshape needs ≥ 3 vertices (a 2-vertex "polygon" has zero
        //    interior area; we'd silently emit nothing)
        if (e.key === 'Enter' || e.key === 'Return') {
          const minVerts = addMode.shape === 'polyshape' ? 3 : 2;
          if (polylineDraft.vertices.length >= minVerts) {
            commitPolylineDraft(polylineDraft.vertices);
          }
          setPolylineDraft(null);
        } else if ((e.key === 'a' || e.key === 'A') && !e.metaKey && !e.ctrlKey && !e.altKey) {
          // Toggle ARC mode for the NEXT segment: the next click places
          // the arc ENDPOINT and the draft synthesizes a 90° circular
          // arc through it (center on the perpendicular bisector of the
          // chord — see synthArc90). Needs at least one placed vertex
          // (an arc sweeps FROM the previous vertex). Ignore key events
          // targeted at text inputs so typing in the inspector can't
          // flip the mode.
          const t = e.target;
          const tag = t && t.tagName;
          if (tag === 'INPUT' || tag === 'TEXTAREA' || (t && t.isContentEditable)) return;
          if (polylineDraft.vertices.length > 0) {
            setPolylineDraft({ ...polylineDraft, arcNext: !polylineDraft.arcNext });
            e.preventDefault();
          }
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [addMode, addDrag, polylineDraft]);

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
      if ((addMode.shape === 'polyline' || addMode.shape === 'polyshape') && polylineDraft) {
        // Polyline / polyshape draw-in-progress: vertex count + the arc-
        // mode hint ('a' toggles a 90° arc for the NEXT segment).
        const n = polylineDraft.vertices.length;
        const arcTag = polylineDraft.arcNext
          ? `ARC mode — next click places a 90° arc endpoint ('a' to exit)`
          : `'a' = arc segment`;
        const finishTag = addMode.shape === 'polyshape'
          ? 'dbl-click / Enter / click v0 to close'
          : 'dbl-click / Enter to finish';
        status = {
          kind: 'add',
          line: `Add ${shapeLabel} (${kindLabel}) · ${n} vertex${n === 1 ? '' : 'es'} · ${arcTag} · ${finishTag} · Esc cancels`,
        };
      } else if (!addDrag) {
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
      const line = moveSnapHover.kind === 'edge'
        ? `Alt-drag · release to snap ${moveSnapHover.dSide} edge to ${moveSnapHover.targetSide} edge of ${moveSnapHover.targetCompId}`
        : `Alt-drag · release to snap to ${moveSnapHover.compId}.${moveSnapHover.anchor}`;
      status = { kind: 'snap', line };
    } else if (drag && drag.kind === 'move' && altKey) {
      status = {
        kind: 'snap',
        line: `Alt-drag · approach another component's anchor to snap`,
      };
    } else if (drag && drag.kind === 'move' && alignGuides) {
      // C5: numeric alignment engaged. Remind the user this is a literal
      // position only — a parametric relationship needs an Alt-drag snap.
      const ids = [...new Set(
        [...(alignGuides.x || []), ...(alignGuides.y || [])].map(g => g.compId).filter(Boolean)
      )];
      status = {
        kind: 'align',
        line: `aligned with ${ids.join(', ')} — use Alt-drag for a parametric snap`,
      };
    } else if (drag && drag.kind === 'move' && drag.snapBound) {
      // Plain move-drag on a solver-positioned component: warn that the
      // solver will reassert the snap on release. Lives for the whole
      // drag; clears with the rest of the statuses when drag → null.
      const { compId, fromCompId, fromAnchor } = drag.snapBound;
      status = {
        kind: 'snap',
        line: `⚠ ${compId} is positioned by snap from ${fromCompId}.${fromAnchor} — it will snap back on release. Alt-drag to re-snap, or edit dx/dy in SNAPS.`,
      };
    } else if (drag && drag.kind === 'resize') {
      // Resize on an expression-bound axis is a no-op (the dimension is a
      // derived quantity — see the resize commit logic). Tell the user why
      // nothing is happening and where to actually change the size. Corner
      // handles engage both axes, so both can report at once.
      const a = drag.anchor || '';
      const parts = [];
      if ((a.includes('E') || a.includes('W')) && isExprBoundDim(drag.wExpr)) {
        parts.push(`w is driven by '${drag.wExpr}'`);
      }
      if ((a.includes('N') || a.includes('S')) && isExprBoundDim(drag.hExpr)) {
        parts.push(`h is driven by '${drag.hExpr}'`);
      }
      if (parts.length) {
        status = {
          kind: 'resize',
          line: `${parts.join(' · ')} — edit the parameter(s) in PARAMS/Inspector to resize`,
        };
      }
    } else if (vertexDrag) {
      // C3: live vertex-drag feedback.
      status = {
        kind: 'vertex',
        line: `Vertex ${vertexDrag.idx} of ${vertexDrag.compId} · release to commit (grid snap applies; hold ⌘ to disable)`,
      };
    } else if (vertexEditStatus) {
      // C3: refused vertex edit (snap-bound / arc / expression-driven /
      // minimum vertex count) — explain why and where to edit instead.
      status = { kind: 'vertex', line: vertexEditStatus.line };
    }
    setInteractionStatus(status);
  }, [snapMode, snapPick, snapHover, snapCursor, shiftKey, altKey, rulerMode, rulerInProgress, rulerSnapPoint, addMode, addDrag, addHoverSnap, polylineDraft, drag, moveSnapHover, alignGuides, vertexDrag, vertexEditStatus, solved, paramValues, setInteractionStatus]);

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
  //
  // [F1] Index-backed: the memoized anchorSnapIndex carries every candidate
  // the old exhaustive scan enumerated — 9 rotated anchors per transform
  // instance (base + repeat / mirror copies, booleans' outer AABBs), the
  // edge-projection rects, AND the per-operand cells of transformed boolean
  // instances — with sequence numbers reproducing the old enumeration
  // order, so nearest-wins + first-wins-on-tie selection is unchanged.
  const findRulerSnap = (wp, worldThresh) => {
    const hit = queryAnchorSnapIndex(anchorSnapIndex, wp, worldThresh);
    if (!hit) return null;
    const tag = hit.instanceIdx > 0 ? `${hit.compId}#${hit.instanceIdx}` : hit.compId;
    const label = hit.kind === 'anchor'
      ? `${tag} ${hit.anchor}`
      : `${tag} ${RULER_EDGE_LABEL[hit.side]}`;
    return { x: hit.x, y: hit.y, label, d: hit.d };
  };

  // Like findRulerSnap, but also reports WHICH component and WHICH anchor the
  // snap landed on. Used by drag-to-create so we can install a real snap (not
  // just remember a coordinate) when the user lands on an existing anchor.
  // Returns null if nothing within `worldThresh`. Otherwise returns
  // { x, y, compId, anchor } where anchor is one of the 9 fixed names or a
  // parametric edge anchor like "T:0.42".
  // For polyline drawing: if the cursor's X or Y aligns with any of the
  // already-placed vertices within `thresh`, snap to that axis. Returns
  // the snapped point + which vertex it aligns with, or null. Used to
  // help the user draw orthogonal traces (e.g. RF feedlines) without
  // squinting at coordinates.
  const pickAxisGuide = (wp, vertices, thresh) => {
    let bestH = null, bestV = null;
    for (const v of vertices) {
      if (Math.abs(v.x - wp.x) < thresh && (!bestV || Math.abs(v.x - wp.x) < Math.abs(bestV.refX - wp.x))) {
        bestV = { x: v.x, y: wp.y, refX: v.x, refY: v.y, axis: 'v' };
      }
      if (Math.abs(v.y - wp.y) < thresh && (!bestH || Math.abs(v.y - wp.y) < Math.abs(bestH.refY - wp.y))) {
        bestH = { x: wp.x, y: v.y, refX: v.x, refY: v.y, axis: 'h' };
      }
    }
    // If both H and V align, snap to whichever is CLOSER to the cursor;
    // gives the user a clear single-axis result instead of clobbering both.
    if (bestH && bestV) {
      const dH = Math.abs(bestH.y - wp.y);
      const dV = Math.abs(bestV.x - wp.x);
      return dH < dV ? bestH : bestV;
    }
    return bestH || bestV;
  };

  // Tessellated point list for the DRAFT path (committed vertices only):
  // line vertices pass through, arc vertices expand along their circular
  // arc — mirrors tessellatePolylinePath so the preview shows exactly
  // what will be committed.
  const draftPathPoints = (verts) => {
    const pts = [];
    for (let i = 0; i < verts.length; i++) {
      const v = verts[i];
      if (v.arc && i > 0) {
        const prev = verts[i - 1];
        pts.push(...tessellateArcFrom(prev.x, prev.y, prev.x + v.arc.cdx, prev.y + v.arc.cdy, v.arc.angle));
      } else {
        pts.push([v.x, v.y]);
      }
    }
    return pts;
  };

  // Commit the current polyline draft to the scene via the parent's
  // commitDragAdd-like callback. We pass a vertices array of
  //   { x, y, snap?: { compId, anchor }, arc?: { cdx, cdy, angle } }
  // ; the parent resolves the first vertex into the component anchor and
  // the rest into `rel` (with dx/dy expressions for the deltas), `snap`
  // (component-anchor binding), or `arc` (center offset + 90° sweep).
  const commitPolylineDraft = (vertices) => {
    if (!addMode) return;
    // polyshape needs ≥ 3 vertices (a polygon with < 3 has no interior);
    // polyline only needs 2 to form a valid 1-segment trace.
    const minVerts = addMode.shape === 'polyshape' ? 3 : 2;
    if (vertices.length < minVerts) return;
    if (typeof commitDragAdd !== 'function') return;
    // Preserve the user's chosen shape kind in the spec so the parent's
    // commit pipeline routes to the right component-creation branch.
    commitDragAdd(
      { ...addMode, shape: addMode.shape, vertices },
      vertices[0],
      vertices[vertices.length - 1],
      vertices[0].snap || null,
      vertices[vertices.length - 1].snap || null,
    );
  };

  // [F1] Index-backed (see findRulerSnap). The result records the candidate
  // AND the instance index it came from. `instanceIdx === 0` = base
  // component (parametric snap bindings are safe to install);
  // `instanceIdx > 0` = a child copy produced by a transform (visual snap
  // only — the scene model can't currently express "bind to instance N"
  // parametrically, so the caller should treat it as a free position).
  // Edge hits become parametric edge anchors tagged T:t / B:t / L:t / R:t,
  // t ∈ [0, 1] — same strings the old inline scan produced.
  const findAnchorSnap = (wp, worldThresh, excludeCompId = null) => {
    const hit = queryAnchorSnapIndex(anchorSnapIndex, wp, worldThresh, excludeCompId);
    if (!hit) return null;
    return {
      x: hit.x,
      y: hit.y,
      compId: hit.compId,
      anchor: hit.kind === 'anchor' ? hit.anchor : `${hit.side}:${hit.t.toFixed(4)}`,
      instanceIdx: hit.instanceIdx,
      d: hit.d,
    };
  };

  // Scene-component map for polyline vertex resolution (snap-vertex targets
  // are looked up by id). Matches what the polyline/polyshape render
  // branches build inline, so the C3 handles sit exactly on the drawn path.
  const sceneCompById = useMemo(
    () => Object.fromEntries(scene.components.map(c => [c.id, c])),
    [scene.components]
  );

  // [F3] Memoized boolean per-instance operand overrides:
  // boolId → Map<instanceObject, overridesOrNull>. Keyed by the INSTANCE
  // OBJECT (instances come from the instancesByCompId memo, so identity is
  // stable across the render) — every canonical call site (cluster path,
  // renderInterior / renderOutline multi-instance branches, collectBbox's
  // boolean visit) passes one of those objects, so lookups hit. Synthetic
  // fallback instances (defensive paths only) miss and recompute via the
  // same pure helper, preserving behavior exactly. Only canonical
  // (boolean, own-instance, solved-base) computations are cached — the
  // nested-boolean recursion always reaches this cache through canonical
  // keys because buildBoolOverridesForInstance reads operand BASE
  // instances regardless of the override context in effect.
  const boolInstanceOverridesCache = useMemo(() => {
    const cache = new Map();
    const baseInstOf = (c) => {
      const list = instancesByCompId[c.id] || [];
      return list[0] || {
        compId: c.id, idx: 0, cx: c.cx, cy: c.cy,
        w: evalExpr(c.w, paramValues), h: evalExpr(c.h, paramValues),
        rotation: 0,
      };
    };
    const solvedById = new Map(solved.map(c => [c.id, c]));
    for (const b of booleanClusters.allBooleanComps) {
      const insts = instancesByCompId[b.id];
      if (!insts || insts.length === 0) continue;
      const s = solvedById.get(b.id);
      const baseCx = s ? s.cx : b.cx;
      const baseCy = s ? s.cy : b.cy;
      const perInst = new Map();
      for (const inst of insts) {
        perInst.set(inst, buildBoolOverridesForInstance(b, inst, baseCx, baseCy, sceneCompById, baseInstOf));
      }
      cache.set(b.id, perInst);
    }
    return cache;
  }, [booleanClusters, instancesByCompId, solved, sceneCompById, paramValues]);

  // C3: resolved vertex positions (one per vertex spec — index-stable) for a
  // polyline / polyshape, from the SOLVED component so solver-positioned
  // paths put handles where the geometry actually renders.
  const resolveVertsFor = (comp) =>
    resolvePolylineVertices(comp, sceneCompById, paramValues, transformInstances);

  // C3: mousedown on a vertex handle. Alt+click deletes the vertex (merging
  // its offset into a rel-numeric follower so downstream geometry stays
  // fixed); plain click starts a handle drag when the vertex is rel-numeric,
  // otherwise surfaces WHY it can't be dragged in the status bar.
  const onVertexHandleMouseDown = (e, compId, idx) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const comp = solved.find(cc => cc.id === compId);
    if (!comp) return;
    const specs = comp.vertices || [];
    const verts = resolveVertsFor(comp);
    if (e.altKey) {
      const res = deleteVertexFixDownstream(comp, verts, idx);
      if (res.error) {
        setVertexEditStatus({ line: `Delete refused: ${res.error}` });
      } else {
        updateScene(prev => ({
          ...prev,
          components: prev.components.map(cc => cc.id === compId ? { ...cc, vertices: res.vertices } : cc),
        }));
      }
      return;
    }
    const block = vertexDragBlock(specs[idx]);
    if (block) {
      setVertexEditStatus({ line: block });
      return;
    }
    setVertexDrag({ compId, idx, comp, origVerts: verts, preview: null });
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
    // Only left-button starts drags / selection. Right-click is reserved
    // for the context menu (handled in onContextMenu below); middle-click
    // is currently a no-op.
    if (e.button !== 0) return;
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

    // Polyline tool: append a vertex on each click. Double-click commits
    // the polyline as-is (caught via dblclick handler below). Anchor snaps
    // are honored — a vertex landing on an existing anchor stores the
    // snap binding so the vertex parametrically tracks the target.
    //
    // Hover-snap works for EVERY rendered instance (base + repeats /
    // duplicate_mirror copies / boolean operand cells). Clicking on a
    // base-instance anchor installs a parametric `kind: 'snap'`
    // vertex; clicking on a NON-BASE instance snaps visually only —
    // the vertex becomes a `rel` step at the snapped position. (The
    // scene model can't currently encode "bind to instance N"; that's
    // a future enhancement.)
    if (addMode && (addMode.shape === 'polyline' || addMode.shape === 'polyshape')) {
      const wp = screenToWorld(e.clientX, e.clientY);
      const worldThresh = viewport.w * 0.012;
      const snap = findAnchorSnap(wp, worldThresh);
      const isBaseInst = !snap || (snap.instanceIdx ?? 0) === 0;
      // Axis-aligned guideline: if the cursor isn't snapped to an anchor
      // AND we have previous vertices, check if x or y aligns with any of
      // them within tolerance; snap the cursor to that axis.
      let vx = snap ? snap.x : wp.x;
      let vy = snap ? snap.y : wp.y;
      if (!snap && polylineDraft && polylineDraft.vertices.length > 0) {
        const guide = pickAxisGuide(wp, polylineDraft.vertices, worldThresh * 0.6);
        if (guide) { vx = guide.x; vy = guide.y; }
      }
      // Shift modifier: lock new vertex to horizontal / vertical relative
      // to the LAST committed vertex (whichever axis dominates).
      if (e.shiftKey && polylineDraft && polylineDraft.vertices.length > 0) {
        const last = polylineDraft.vertices[polylineDraft.vertices.length - 1];
        const ddx = vx - last.x;
        const ddy = vy - last.y;
        if (Math.abs(ddx) > Math.abs(ddy)) vy = last.y;
        else                                vx = last.x;
      }
      // Polyshape close-by-click magnetism: mirror the mousemove handler's
      // first-vertex snap so a click the preview shows as "closing" lands
      // EXACTLY on vertex 0 — the 1e-6 closeOnFirst equality check below
      // then triggers. Without this the click coordinates are recomputed
      // fresh from the event and the click adds a stray vertex instead of
      // closing the polygon.
      if (addMode.shape === 'polyshape' && polylineDraft && polylineDraft.vertices.length >= 3) {
        const first = polylineDraft.vertices[0];
        if (Math.hypot(vx - first.x, vy - first.y) < worldThresh) {
          vx = first.x; vy = first.y;
        }
      }
      // ARC mode: the click places the arc ENDPOINT; synthesize the 90°
      // arc from the last committed vertex through it. The previous move
      // direction (segment into the last vertex) picks which side of the
      // chord the arc bulges toward — see synthArc90. Snap bindings are
      // NOT installed on arc endpoints (an arc vertex's position is
      // derived from center + sweep, not an anchor binding); the click's
      // snapped coordinates still land the endpoint exactly on the
      // anchor at draw time.
      let arcSpec = null;
      if (polylineDraft && polylineDraft.arcNext && polylineDraft.vertices.length > 0) {
        const lastV = polylineDraft.vertices[polylineDraft.vertices.length - 1];
        const beforeV = polylineDraft.vertices.length >= 2
          ? polylineDraft.vertices[polylineDraft.vertices.length - 2]
          : null;
        const prevDir = beforeV ? { x: lastV.x - beforeV.x, y: lastV.y - beforeV.y } : null;
        arcSpec = synthArc90(lastV, { x: vx, y: vy }, prevDir);
      }
      const newVertex = {
        x: vx, y: vy,
        // Snap binding records the target compId + anchor AND the
        // instanceIdx when > 0. instanceIdx=0 binds to the base
        // component; instanceIdx>0 binds to a transform-replicated
        // instance (or, for boolean operand cells, to the operand
        // viewed under its parent boolean's chain at instance N).
        // The HFSS export emits matching parametric expressions for
        // both cases — see instanceChainOffsetExpr.
        snap: (snap && !arcSpec) ? {
          compId: snap.compId,
          anchor: snap.anchor,
          ...(snap.instanceIdx > 0 ? { instanceIdx: snap.instanceIdx } : {}),
        } : null,
        ...(arcSpec ? { arc: arcSpec } : {}),
      };
      if (!polylineDraft) {
        setPolylineDraft({ vertices: [newVertex], cursorPos: { x: vx, y: vy }, cursorSnap: snap || null });
      } else {
        // De-duplicate identical-position consecutive clicks (e.g. accidental
        // double-click registers as both this single + dblclick handler).
        const last = polylineDraft.vertices[polylineDraft.vertices.length - 1];
        const first = polylineDraft.vertices[0];
        // Polyshape close-by-click: a click on (or very near) the FIRST
        // vertex finishes the polygon. Standard CAD shortcut.
        const isPolyshape = addMode.shape === 'polyshape';
        const minVerts = isPolyshape ? 3 : 2;
        const closeOnFirst = isPolyshape
          && polylineDraft.vertices.length >= minVerts
          && Math.abs(first.x - vx) < 1e-6 && Math.abs(first.y - vy) < 1e-6;
        if (Math.abs(last.x - vx) < 1e-6 && Math.abs(last.y - vy) < 1e-6) {
          // Same as last vertex — treat as commit signal.
          if (polylineDraft.vertices.length >= minVerts) commitPolylineDraft(polylineDraft.vertices);
          setPolylineDraft(null);
        } else if (closeOnFirst) {
          // Click landed on vertex 0 — finish the polygon (the polyshape
          // is implicitly closed; we don't push the duplicate vertex).
          commitPolylineDraft(polylineDraft.vertices);
          setPolylineDraft(null);
        } else {
          setPolylineDraft({
            ...polylineDraft,
            vertices: [...polylineDraft.vertices, newVertex],
          });
        }
      }
      e.stopPropagation();
      e.preventDefault();
      return;
    }

    // Add tool: drag to size the new component. Anchor snaps are honored so
    // that landing on an existing component's corner/edge installs a position
    // snap rather than a free coordinate. Snapping to a NON-BASE instance
    // (repeats / mirrors) snaps the cursor visually but does NOT install a
    // parametric binding — pretending to bind to instance N would actually
    // bind to the BASE component and place the new shape at the wrong
    // position.
    if (addMode) {
      const wp = screenToWorld(e.clientX, e.clientY);
      const worldThresh = viewport.w * 0.012;
      const snap = findAnchorSnap(wp, worldThresh);
      const isBaseInst = !snap || (snap.instanceIdx ?? 0) === 0;
      const p1 = snap ? { x: snap.x, y: snap.y } : { x: wp.x, y: wp.y };
      setAddDrag({ p1, p2: p1, snapStart: (snap && isBaseInst) ? snap : null, snapEnd: null });
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
        const { w, h } = dimsByCompId[comp.id]; // [F2]
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
      let id = target.dataset.compId;

      // Click-through for stacked overlap. The two-pass renderer
      // promotes the currently-selected component to the top so its
      // halo / handles stay visible — but that also makes it intercept
      // clicks that would otherwise hit a smaller, unselected component
      // sitting underneath. When the topmost SVG hit is already in our
      // selection, walk the document's element stack at the cursor and
      // prefer the first element under it that points at a different,
      // unselected component. That lets you build a multi-selection in
      // the natural visual order (e.g. large, then small for a subtract)
      // even when the small one is fully covered by the large one's bbox.
      if (selectedIds.has(id) && typeof document !== 'undefined' && typeof document.elementsFromPoint === 'function') {
        const stack = document.elementsFromPoint(e.clientX, e.clientY);
        for (const el of stack) {
          const cid = el?.dataset?.compId;
          if (cid && cid !== id && !selectedIds.has(cid)) {
            id = cid;
            break;
          }
        }
      }

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
      // Snap-bound detection: if the clicked component (or the cluster
      // root) is the TO-side of any snap, its position is owned by the
      // solver — a plain move-drag will be overwritten on the next solve
      // and the part "snaps back" on release. We don't change the drag
      // mechanics (that snap-back IS the intended constraint behavior);
      // we surface a status-bar warning for the duration of the drag so
      // the user knows why, and what to do instead.
      const boundSnap = scene.snaps.find(s => s.to.compId === id || s.to.compId === rootId);
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
          // Skip operands that aren't actually consumed by this boolean.
          // Punch keeps its tools independent — they shouldn't be dragged
          // along when the boolean moves (HFSS "clone tool" semantics).
          const opC = compById[opid];
          if (!opC || opC.consumedBy !== c.id) continue;
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
        const { w: cw, h: ch } = dimsByCompId[c.id]; // [F2]
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
      // First-class rotation of the dragged shape, used by the alt-drag
      // anchor preview so the dragged anchor sits on the ROTATED corner
      // (matching what the solver will do on snap commit). Only
      // meaningful for a single-component drag — for clusters the
      // "dragged shape" is the composite AABB, which stays axis-aligned.
      const dragRotationDeg = (coMovers.length === 1 && coMovers[0].id === id)
        ? compRotationDeg(solved.find(cc => cc.id === id), paramValues)
        : 0;
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
          dragRotationDeg,              // first-class rotation of a single-comp drag (deg, CCW)
          clusterSet,                   // ids to EXCLUDE from alt-drag snap target search
          coMovers,                     // primitives to translate by drag delta
          // Snap-bound warning payload (null when free): which component is
          // solver-positioned and which snap from-side owns it.
          snapBound: boundSnap ? {
            compId: boundSnap.to.compId,
            fromCompId: boundSnap.from.compId,
            fromAnchor: boundSnap.from.anchor,
          } : null,
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
    // C3: vertex-handle drag — live preview through local state only; the
    // scene commit happens once on mouseup (single undo step). Grid snap
    // applies to the dragged vertex's world position (Cmd disables, same
    // convention as component drags).
    if (vertexDrag) {
      const wp = screenToWorld(e.clientX, e.clientY);
      const p = { x: snapToGrid(wp.x), y: snapToGrid(wp.y) };
      setVertexDrag(vd => vd
        ? { ...vd, preview: dragVertexPatch(vd.comp, vd.origVerts, vd.idx, p) }
        : vd);
      return;
    }
    // Ruler: track current snap target for the preview dot/line
    if (rulerMode) {
      const wp = screenToWorld(e.clientX, e.clientY);
      const worldThresh = viewport.w * 0.012;
      const snap = findRulerSnap(wp, worldThresh);
      if (snap) setRulerSnapPoint(snap);
      else setRulerSnapPoint({ x: wp.x, y: wp.y, label: null });
    }
    // Polyline draft: track cursor for the preview segment + axis-guide
    // detection. The cursor visually snaps to anchors on EVERY rendered
    // instance (base + repeats / duplicate_mirror copies / boolean-cluster
    // operand cells). The halo follows the hover the way ruler mode does;
    // the cursorSnap state is used by the canvas overlay to decide whether
    // to draw the halo (we keep it for any instance), but a parametric
    // binding only gets installed at click time for base-instance snaps.
    if (addMode && (addMode.shape === 'polyline' || addMode.shape === 'polyshape') && polylineDraft) {
      const wp = screenToWorld(e.clientX, e.clientY);
      const worldThresh = viewport.w * 0.012;
      const snap = findAnchorSnap(wp, worldThresh);
      let cx_ = snap ? snap.x : wp.x, cy_ = snap ? snap.y : wp.y;
      let axisGuide = null;
      if (!snap) {
        const guide = pickAxisGuide(wp, polylineDraft.vertices, worldThresh * 0.6);
        if (guide) { cx_ = guide.x; cy_ = guide.y; axisGuide = guide; }
      }
      // Shift modifier: project cursor along H or V from the LAST vertex.
      if (e.shiftKey && polylineDraft.vertices.length > 0) {
        const last = polylineDraft.vertices[polylineDraft.vertices.length - 1];
        const ddx = cx_ - last.x;
        const ddy = cy_ - last.y;
        if (Math.abs(ddx) > Math.abs(ddy)) cy_ = last.y;
        else                                cx_ = last.x;
      }
      // Polyshape: when the cursor is near the FIRST vertex AND we have
      // enough vertices for a polygon (≥ 3), visually snap to the first
      // vertex so a "close the polygon" click lands exactly on it.
      if (addMode.shape === 'polyshape' && polylineDraft.vertices.length >= 3) {
        const first = polylineDraft.vertices[0];
        const dx = cx_ - first.x, dy = cy_ - first.y;
        if (Math.sqrt(dx*dx + dy*dy) < worldThresh) {
          cx_ = first.x; cy_ = first.y;
        }
      }
      setPolylineDraft({
        ...polylineDraft,
        cursorPos: { x: cx_, y: cy_ },
        cursorSnap: snap || null,
        axisGuide,
      });
      return;
    }
    // Polyline / polyshape pre-draw hover: show snap halo before the first
    // click, for any instance (base or transform copy).
    if (addMode && (addMode.shape === 'polyline' || addMode.shape === 'polyshape') && !polylineDraft) {
      const wp = screenToWorld(e.clientX, e.clientY);
      const worldThresh = viewport.w * 0.012;
      const snap = findAnchorSnap(wp, worldThresh);
      setAddHoverSnap(snap || { x: wp.x, y: wp.y, compId: null, anchor: null });
    }
    // Add-drag: update p2 and re-evaluate snapEnd. Filter to base
    // instances for the parametric snap-binding side, but use ANY
    // instance's anchor position for the visual p2 (so the rect's
    // corner visually lands on the instance the user is hovering).
    if (addMode && addDrag) {
      const wp = screenToWorld(e.clientX, e.clientY);
      const worldThresh = viewport.w * 0.012;
      const snap = findAnchorSnap(wp, worldThresh);
      const isBaseInst = !snap || (snap.instanceIdx ?? 0) === 0;
      const p2 = snap ? { x: snap.x, y: snap.y } : { x: wp.x, y: wp.y };
      setAddDrag({ ...addDrag, p2, snapEnd: (snap && isBaseInst) ? snap : null });
    } else if (addMode && !addDrag) {
      // Pre-drag hover: show what point we'd snap to if the user clicked
      // now. Visual halo shows for any instance, parametric-binding hint
      // (compId/anchor in the hover record) only for base instances.
      const wp = screenToWorld(e.clientX, e.clientY);
      const worldThresh = viewport.w * 0.012;
      const snap = findAnchorSnap(wp, worldThresh);
      const isBaseInst = !snap || (snap.instanceIdx ?? 0) === 0;
      if (snap) {
        setAddHoverSnap({
          x: snap.x, y: snap.y,
          compId: isBaseInst ? snap.compId : null,
          anchor: isBaseInst ? snap.anchor : null,
          instanceIdx: snap.instanceIdx ?? 0,
        });
      } else {
        setAddHoverSnap({ x: wp.x, y: wp.y, compId: null, anchor: null });
      }
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
          // C5 alignment is PLAIN-drag only — Alt-drag (parametric snap
          // mode) must be completely unaffected, so drop any leftover guides.
          if (alignGuides) setAlignGuides(null);
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
            // [F1] The exhaustive solved × 81 anchor-pair scan (plus the
            // per-target edge-pair pass) is replaced by queries against
            // the memoized altDragTargetIndex. findAltDragSnapCandidate
            // preserves the original selection semantics exactly: same
            // candidate set, same threshold gates, same first-wins
            // tie-break order (per-component sequence blocks), same
            // rotation-aware anchor math on both sides, and the same
            // currentBest tracking that feeds the hysteresis below.
            const search = findAltDragSnapCandidate(altDragTargetIndex, {
              proposedCx, proposedCy, dw, dh,
              dragRotationDeg: drag.dragRotationDeg || 0,
              clusterSet: drag.clusterSet,
              worldThresh,
              moveSnapHover,
            });
            let best = search.best;
            const currentBest = search.currentBest; // candidate matching the existing moveSnapHover, if any
            // If we have a current target and it's still valid (within
            // threshold), only swap to a different one if the new candidate
            // is meaningfully closer. This stops single-pixel mouse jitter
            // from flipping the chosen anchor pair.
            if (currentBest && best && currentBest !== best) {
              if (currentBest.dist - best.dist < stickThresh) {
                best = currentBest;
              }
            }
            // -----------------------------------------------------------
            // (3) Anchor-on-edge stickiness: edge snaps lock one axis and
            //     let the cluster track the cursor along the other. To
            //     make corners and midpoints feel "sticky" as the user
            //     slides along the locked edge, we run a focused scan
            //     over the 3 anchors lying on the chosen target side
            //     (and the matching dragged-side anchors) with an
            //     extended free-axis reach. The main anchor pass only
            //     accepts pairs whose full 2-D distance is within
            //     worldThresh; this sub-pass instead accepts pairs whose
            //     FREE-axis offset is within STICKY (deliberately larger
            //     than worldThresh), because the locked axis is about to
            //     be forced to coincide by the edge snap anyway. When a
            //     stickier match exists, promote it from edge to anchor
            //     so the commit locks both axes.
            //
            //     STICKY is set to 2.5x worldThresh so the user gets a
            //     pronounced detent at each anchor while sliding the
            //     cluster laterally along a long edge — corners and
            //     midpoint capture from a noticeable distance and the
            //     cluster jumps back to free tracking once the cursor
            //     crosses the boundary.
            // -----------------------------------------------------------
            // The override runs whenever the cluster is engaged in an
            // edge-style alt-drag (best === edge) — and ALSO when the
            // previous frame's moveSnapHover was an anchor we promoted
            // here, so the cluster doesn't release the anchor when the
            // cursor wanders just outside the main anchor pass's reach.
            const isStickyHoverContext = (
              (best && best.kind === 'edge') ||
              (moveSnapHover && moveSnapHover.kind === 'anchor' && moveSnapHover.viaEdge)
            );
            if (isStickyHoverContext) {
              const edgeAnchorMap = {
                h: { top: ['NW','N','NE'], bottom: ['SW','S','SE'], centerY: ['W','C','E'] },
                v: { left: ['NW','W','SW'], right: ['NE','E','SE'], centerX: ['N','C','S'] },
              };
              // Pick the axis/sides to scan: from the edge candidate when
              // best is edge, or from the prior frame's moveSnapHover edge
              // descriptor when we're holding an override-promoted anchor.
              const ctxAxis = best && best.kind === 'edge' ? best.axis
                : (moveSnapHover?.edgeAxis || null);
              const ctxTargetSide = best && best.kind === 'edge' ? best.targetSide
                : (moveSnapHover?.edgeTargetSide || null);
              const ctxDSide = best && best.kind === 'edge' ? best.dSide
                : (moveSnapHover?.edgeDSide || null);
              const ctxTargetCompId = best && best.kind === 'edge' ? best.targetCompId
                : (moveSnapHover?.compId || null);
              const tAnchorList = (ctxAxis && edgeAnchorMap[ctxAxis]?.[ctxTargetSide]) || [];
              const dAnchorList = (ctxAxis && edgeAnchorMap[ctxAxis]?.[ctxDSide]) || [];
              if (tAnchorList.length && dAnchorList.length && ctxTargetCompId) {
                const oc = solved.find(c => c.id === ctxTargetCompId);
                if (oc) {
                  const { w: ow, h: oh } = dimsByCompId[oc.id]; // [F2]
                  if (Number.isFinite(ow) && Number.isFinite(oh) && ow > 0 && oh > 0) {
                    // STICKY is scaled to the target's free-axis edge
                    // length so the sticky zone is a visible fraction of
                    // the edge regardless of zoom or target size. A long
                    // 1000-unit top edge gives anchors at -500/0/+500 with
                    // a 200-unit sticky radius — the cluster catches the
                    // midpoint and each corner with a wide noticeable
                    // detent. A short edge falls back to worldThresh*2
                    // so we still get a screen-pixel detent.
                    const freeAxisLen = ctxAxis === 'h' ? ow : oh;
                    const STICKY = Math.max(worldThresh, freeAxisLen * 0.03);
                    let stickBest = null;
                    // Index-pair the anchor lists so we only consider
                    // NATURAL alignments along the edge:
                    //   leftmost ↔ leftmost (NW ↔ SW)
                    //   midpoint ↔ midpoint (N  ↔ S)
                    //   rightmost ↔ rightmost (NE ↔ SE)
                    // (Both edgeAnchorMap lists are ordered consistently:
                    // left→mid→right on h, top→mid→bottom on v.)
                    // Iterating 3×3 instead would let us snap the
                    // cluster's NW corner to the target's S midpoint —
                    // which lands the cluster's left edge at the target
                    // center, not the cluster's center. That's the wrong
                    // detent for an edge-slide gesture.
                    const pairCount = Math.min(tAnchorList.length, dAnchorList.length);
                    const stickOcRot = compRotationDeg(oc, paramValues);
                    const stickDRot = drag.dragRotationDeg || 0;
                    for (let i = 0; i < pairCount; i++) {
                      const ta = tAnchorList[i];
                      const da = dAnchorList[i];
                      const tlp = anchorLocalRotated(ta, ow, oh, stickOcRot);
                      const tx = oc.cx + tlp.x;
                      const ty = oc.cy + tlp.y;
                      const dlp = anchorLocalRotated(da, dw, dh, stickDRot);
                      const dax = proposedCx + dlp.x;
                      const day = proposedCy + dlp.y;
                      // Only the FREE-axis distance matters here: the
                      // locked axis is forced to coincide by the edge
                      // snap itself.
                      const freeDist = ctxAxis === 'h'
                        ? Math.abs(tx - dax)
                        : Math.abs(ty - day);
                      if (freeDist <= STICKY) {
                        const cand = {
                          kind: 'anchor',
                          dist: freeDist,
                          dAnchor: da,
                          target: { x: tx, y: ty, compId: oc.id, anchor: ta },
                          // Mark this candidate as edge-stickiness-promoted
                          // so the next frame can keep it sticky even when
                          // the main edge candidate drops out.
                          viaEdge: true,
                          edgeAxis: ctxAxis,
                          edgeTargetSide: ctxTargetSide,
                          edgeDSide: ctxDSide,
                        };
                        if (!stickBest || freeDist < stickBest.dist) stickBest = cand;
                      }
                    }
                    if (stickBest) best = stickBest;
                  }
                }
              }
            }
            if (best) {
              let newCx = proposedCx, newCy = proposedCy;
              if (best.kind === 'anchor') {
                setMoveSnapHover({
                  kind: 'anchor', ...best.target, dAnchor: best.dAnchor,
                  // Pass through the edge-stickiness origin so the next
                  // frame can keep the anchor sticky beyond the main
                  // anchor pass's worldThresh reach.
                  viaEdge: !!best.viaEdge,
                  edgeAxis: best.edgeAxis,
                  edgeTargetSide: best.edgeTargetSide,
                  edgeDSide: best.edgeDSide,
                });
                // Place the cluster so its chosen anchor sits on the target.
                // Rotation-aware: the dragged anchor offset rotates with a
                // single rotated comp, so the preview placement matches the
                // solver's commit position exactly.
                const dlp = anchorLocalRotated(best.dAnchor, dw, dh, drag.dragRotationDeg || 0);
                newCx = best.target.x - dlp.x;
                newCy = best.target.y - dlp.y;
              } else {
                // Edge snap: lock only one axis; the other tracks the cursor.
                setMoveSnapHover({
                  kind: 'edge', axis: best.axis,
                  targetCompId: best.targetCompId,
                  targetSide: best.targetSide,
                  dSide: best.dSide,
                  edgeVal: best.edgeVal,
                  x: best.x, y: best.y,
                });
                // Side → signed half-extent on the locked axis. 'top' /
                // 'right' add +half, 'bottom' / 'left' add −half, and the
                // 'center*' aliases sit on the bbox midpoint with no
                // offset.
                const dShiftY = (s) => s === 'top' ? dh / 2 : (s === 'bottom' ? -dh / 2 : 0);
                const dShiftX = (s) => s === 'right' ? dw / 2 : (s === 'left' ? -dw / 2 : 0);
                if (best.axis === 'h') {
                  newCy = best.edgeVal - dShiftY(best.dSide);
                } else {
                  newCx = best.edgeVal - dShiftX(best.dSide);
                }
              }
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
        // C5: smart alignment guides — PLAIN move-drags only (no Alt; Cmd/
        // Ctrl disables, same convention as grid snap). Compare the dragged
        // cluster bbox's edges + center (x: L/C/R, y: B/C/T) at the proposed
        // position against every other visible transform-expanded instance's
        // edges/centers. Within ~6 screen px, magnetically snap the drag
        // position to the alignment and surface full-viewport magenta guide
        // lines (Figma-style). Numeric-only convenience — NO scene snaps are
        // created here; the status bar points at Alt-drag for a parametric
        // relationship.
        let propCx = drag.startCx + dx;
        let propCy = drag.startCy + dy;
        let guidesX = null, guidesY = null;
        if (!e.altKey && !modifier) {
          const alignThresh = 6 * (viewport.w / (svgRef.current?.clientWidth || 1));
          const targetsX = [];
          const targetsY = [];
          for (const inst of transformInstances) {
            // Skip the dragged cluster itself and operands consumed by a
            // boolean (they don't render standalone — the boolean instance
            // already contributes the composite bbox).
            if (drag.clusterSet && drag.clusterSet.has(inst.compId)) continue;
            if (booleanClusters.operandIds.has(inst.compId)) continue;
            const iw = inst.w, ih = inst.h;
            if (!Number.isFinite(inst.cx) || !Number.isFinite(inst.cy)) continue;
            if (!Number.isFinite(iw) || !Number.isFinite(ih) || iw <= 0 || ih <= 0) continue;
            targetsX.push(
              { val: inst.cx - iw / 2, compId: inst.compId },
              { val: inst.cx, compId: inst.compId },
              { val: inst.cx + iw / 2, compId: inst.compId },
            );
            targetsY.push(
              { val: inst.cy - ih / 2, compId: inst.compId },
              { val: inst.cy, compId: inst.compId },
              { val: inst.cy + ih / 2, compId: inst.compId },
            );
          }
          const dwA = drag.clusterBboxW || 0;
          const dhA = drag.clusterBboxH || 0;
          const dragValsX = dwA > 0 ? [propCx - dwA / 2, propCx, propCx + dwA / 2] : [propCx];
          const dragValsY = dhA > 0 ? [propCy - dhA / 2, propCy, propCy + dhA / 2] : [propCy];
          const ax = alignAxis(dragValsX, targetsX, alignThresh);
          const ay = alignAxis(dragValsY, targetsY, alignThresh);
          if (ax) { propCx += ax.delta; guidesX = ax.guides; }
          if (ay) { propCy += ay.delta; guidesY = ay.guides; }
        }
        setAlignGuides((guidesX || guidesY) ? { x: guidesX || [], y: guidesY || [] } : null);
        // An aligned axis pins to the aligned coordinate exactly; unaligned
        // axes keep the normal grid-snap behavior.
        const newCx = guidesX ? propCx : snapToGrid(propCx);
        const newCy = guidesY ? propCy : snapToGrid(propCy);
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
        const wIsParam = isSingleIdentExpr(drag.wExpr);
        const hIsParam = isSingleIdentExpr(drag.hExpr);
        const wIsLiteral = !wIsParam && isLiteralNumExpr(drag.wExpr || '');
        const hIsLiteral = !hIsParam && isLiteralNumExpr(drag.hExpr || '');
        // If w/h is an EXPRESSION (not single ident, not pure literal), we
        // leave it alone. The visual size won't reflect the drag attempt.
        // (Same classification feeds the resize-handle cursors and the
        // status-bar warning — see isExprBoundDim at module scope.)
        const wIsExpr = isExprBoundDim(drag.wExpr);
        const hIsExpr = isExprBoundDim(drag.hExpr);

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
    // C3: commit an in-flight vertex-handle drag — ONE updateScene call so
    // the whole gesture is a single undo step. A click with no movement
    // (preview === null) commits nothing.
    if (vertexDrag) {
      const { compId, preview } = vertexDrag;
      if (preview) {
        updateScene(prev => ({
          ...prev,
          components: prev.components.map(cc => cc.id === compId ? { ...cc, vertices: preview } : cc),
        }));
      }
      setVertexDrag(null);
      return;
    }
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
          const { w, h } = dimsByCompId[c.id]; // [F2]
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
      // Both anchor and edge alt-drag releases install a persistent
      // scene-level snap. For edge alignments the snap is anchor-based
      // too (we pick the canonical N/S or E/W anchors), and the free
      // axis is captured as the current literal offset so the user's
      // mid-drag X (or Y) position is preserved — they can still tune
      // it via the auto-created gap_* parameter later.
      const target = moveSnapHover;
      // The "dragged" component for snap purposes is the one the user
      // clicked on — typically the boolean itself when dragging a composite,
      // not the snap-chain root (which could be a different component
      // higher up the chain). The visual preview placed the cluster's
      // bbox-anchor on the target, so the installed snap should attach to
      // the clicked component to match user intent.
      const dragId = drag.clickedId || drag.rootId;
      const draggedComp = solved.find(c => c.id === dragId);

      // Resolve target compId + the (target anchor, dragged anchor, dx, dy)
      // tuple based on which kind of preview was active.
      let targetCompId = null;
      let targetAnchor = null;       // anchor on the target
      let draggedAnchor = null;      // anchor on the dragged comp
      // The dx/dy we want to commit. For anchor snaps the values are
      // zero (the two anchors coincide); for edge snaps the free axis
      // captures the current literal offset between the two anchors.
      let initDx = 0, initDy = 0;

      if (target.kind === 'anchor') {
        targetCompId  = target.compId;
        targetAnchor  = target.anchor;
        draggedAnchor = target.dAnchor || 'C';
      } else {
        // Edge alignment: choose the canonical anchor on the aligned
        // line. Edges map to N / S / E / W; center-lines map to C
        // (the 2-D bbox center, which lies on both the horizontal and
        // vertical center lines). With dx (or dy) = the free-axis
        // offset and the other axis = 0, a C → C snap locks one axis
        // and frees the other — exactly the center-line behavior we
        // want.
        const edgeAnchor = (axis, side) => {
          if (side === 'centerY' || side === 'centerX') return 'C';
          if (axis === 'h') return side === 'top' ? 'N' : 'S';
          return side === 'right' ? 'E' : 'W';
        };
        targetCompId  = target.targetCompId;
        targetAnchor  = edgeAnchor(target.axis, target.targetSide);
        draggedAnchor = edgeAnchor(target.axis, target.dSide);
        // Capture the free-axis offset. Anchors land at the midpoint of
        // their respective edges (N/S sit on cx; E/W sit on cy), so the
        // relative offset between the two anchors on the FREE axis is
        // exactly draggedComp.center − targetComp.center on that axis.
        const targetComp = solved.find((c) => c.id === targetCompId);
        if (draggedComp && targetComp) {
          if (target.axis === 'h') {
            initDx = draggedComp.cx - targetComp.cx;
          } else {
            initDy = draggedComp.cy - targetComp.cy;
          }
        }
      }

      if (draggedComp && targetCompId && targetCompId !== dragId) {
        // Auto-reverse if the dragged component is already the `to` of
        // an existing snap (only one parent is allowed). If both ends
        // are already constrained, abort with a helpful message and
        // leave the literal cx/cy from the move in place.
        const draggedHasIncoming = scene.snaps.some(s => s.to.compId === dragId);
        const targetHasIncoming  = scene.snaps.some(s => s.to.compId === targetCompId);
        let fromCompId, fromAnchor, toCompId, toAnchor, finalDx, finalDy;
        if (!draggedHasIncoming) {
          // Standard direction: target is the parent of the dragged comp.
          fromCompId = targetCompId;  fromAnchor = targetAnchor;
          toCompId   = dragId;         toAnchor   = draggedAnchor;
          finalDx = initDx; finalDy = initDy;
        } else if (!targetHasIncoming) {
          // Reverse so target becomes child. Flipping direction also
          // flips the sign of the offset we computed.
          fromCompId = dragId;          fromAnchor = draggedAnchor;
          toCompId   = targetCompId;    toAnchor   = targetAnchor;
          finalDx = -initDx; finalDy = -initDy;
        } else {
          alertDialog(
            `Both ${dragId} and ${targetCompId} are already positioned by another snap. Re-root one of them first (use the ⇄ button in the inspector) to free a target.`,
            'Cannot create snap'
          );
          setDrag(null);
          setMoveSnapHover(null);
          return;
        }
        // Pick fresh gap-parameter names. The captured offset is the
        // expression value; the user can tune it later in the inspector.
        const usedNames = new Set(Object.keys(scene.params));
        const nextName = (prefix) => {
          let i = 1;
          while (usedNames.has(`${prefix}${i}`)) i++;
          usedNames.add(`${prefix}${i}`);
          return `${prefix}${i}`;
        };
        const gapX = nextName('gap_x');
        const gapY = nextName('gap_y');
        // Round captured offsets to 4 decimals — the user is dragging by
        // mouse, so sub-µm precision past that is noise.
        const fmt = (v) => Number(v.toFixed(4)).toString();
        const dxExpr = fmt(finalDx);
        const dyExpr = fmt(finalDy);
        updateScene(prev => ({
          ...prev,
          params: {
            ...prev.params,
            [gapX]: { expr: dxExpr, unit: 'µm', desc: `Gap ${fromCompId}.${fromAnchor} → ${toCompId}.${toAnchor} (dx)` },
            [gapY]: { expr: dyExpr, unit: 'µm', desc: `Gap ${fromCompId}.${fromAnchor} → ${toCompId}.${toAnchor} (dy)` },
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
    if (alignGuides) setAlignGuides(null);
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
    // Via (D4): vertical interconnect between two stack layers. Slate
    // body with an amber center dot (drawn in the via render branch) so
    // it reads as "plug through the stack" rather than a plain circle.
    via:       { fill: '#94a3b8', stroke: '#334155', opacity: 0.9 },
  };

  // Stack-layer lookup so per-component fills can read the BOUND layer's
  // color instead of the static role-based fallback above. Multiple
  // conductor layers in the same coplanar group (e.g. two metal layers
  // routed at different process steps) each define their own color in
  // the layer-stack editor — and we want the canvas to honor that, not
  // collapse every conductor to the default gold.
  const layerById = useMemo(() => {
    const map = {};
    for (const l of (scene.stack || [])) map[l.id] = l;
    return map;
  }, [scene.stack]);
  // Compute a darker companion of a hex color for the stroke. Falls
  // back to the role's default stroke when the input isn't a clean
  // 6-digit hex.
  const darkenHex = (hex) => {
    if (typeof hex !== 'string') return null;
    const m = hex.match(/^#?([0-9a-fA-F]{6})$/);
    if (!m) return null;
    const n = parseInt(m[1], 16);
    const r = Math.floor(((n >> 16) & 0xff) * 0.45);
    const g = Math.floor(((n >> 8) & 0xff) * 0.45);
    const b = Math.floor((n & 0xff) * 0.45);
    return `#${[r,g,b].map(v => v.toString(16).padStart(2, '0')).join('')}`;
  };
  // Resolve a component's display style: prefer the bound layer's
  // explicit color, then fall back to the role-based default. Booleans
  // recurse to the first non-boolean operand so a union/punch inherits
  // its operand's layer color (the boolean's `layer` field is already
  // set to operand[0]'s, but `conductorLayerId` isn't always copied).
  const compById_style = useMemo(() => Object.fromEntries(scene.components.map(c => [c.id, c])), [scene.components]);
  const resolveBoundLayer = (c, visited = new Set()) => {
    if (!c || visited.has(c.id)) return null;
    visited.add(c.id);
    if (c.kind === 'boolean') {
      for (const opid of (c.operandIds || [])) {
        const r = resolveBoundLayer(compById_style[opid], visited);
        if (r) return r;
      }
      return null;
    }
    if (c.layer === 'electrode' && c.conductorLayerId && layerById[c.conductorLayerId]) {
      return layerById[c.conductorLayerId];
    }
    if (c.layer === 'waveguide') {
      return (scene.stack || []).find(l => l.role === 'waveguide') || null;
    }
    return null;
  };
  const styleForComponent = (c) => {
    const base = layerStyle[c?.layer] || layerStyle.waveguide;
    const bound = resolveBoundLayer(c);
    if (bound && bound.color) {
      return { ...base, fill: bound.color, stroke: darkenHex(bound.color) || base.stroke };
    }
    return base;
  };

  // Sized-relative handle radius and stroke unit. Both scale with the
  // viewport so that overlays (arrows, handles, halos) keep their on-screen
  // proportions constant regardless of zoom level. Without this, the SVG's
  // viewBox shrinks as you zoom in but world-unit stroke widths stay fixed,
  // and overlays appear progressively thicker until they collapse into dots.
  const hr = Math.max(viewport.w, viewport.h) / 250;
  const sw = Math.max(viewport.w, viewport.h) / 1500; // baseline 1px-ish stroke in world units
  const HALO_W = sw * 3.6; // selection halo width — also used for snap-network dashes
  // Minimum hit-target footprint in world units, derived from the current
  // viewport / SVG ratio. Below this threshold each component gets an
  // invisible "hit pad" rect that extends its clickable area so the user
  // can grab very thin shapes (sub-pixel-tall waveguides, thin cutouts,
  // etc.) without accidentally missing onto the background — which
  // otherwise turns an intended alt-drag into a marquee selection.
  const MIN_HIT_PX = 8;
  const pxPerWorld = (svgRef.current?.clientWidth || 1) / viewport.w;
  const minHitWorld = pxPerWorld > 0 ? MIN_HIT_PX / pxPerWorld : 0;
  // Convert a desired SCREEN-PIXEL dimension into the world-unit value
  // that produces it at the current zoom. Used for ruler/dimension
  // labels and stroke widths so they stay readable across the full zoom
  // range instead of inflating at high zoom (the prior heuristic of
  // "world size = small % of viewport.w" let zoom-in blow labels up by
  // the same factor as the geometry — exactly what the user doesn't
  // want). A `min` floor keeps SVG numbers sane on first render before
  // svgRef has measured the DOM.
  const screen = (px) => (pxPerWorld > 0 ? px / pxPerWorld : px * 0.05);

  return (
    <svg
      ref={(el) => { svgRef.current = el; if (onSvgElement) onSvgElement(el); }}
      viewBox={`${vbX} ${vbY} ${viewport.w} ${viewport.h}`}
      preserveAspectRatio="xMidYMid meet"
      className="w-full h-full"
      style={{ background: '#f1f5f9', cursor: addMode ? 'crosshair' : (marquee ? 'crosshair' : (altKey ? 'crosshair' : (pan ? 'grabbing' : (drag?.kind === 'move' ? 'move' : 'default')))) }}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={onMouseUp}
      onWheel={onWheel}
      onDoubleClick={(e) => {
        // Double-click while drawing a polyline commits it (using the
        // vertices placed up to the previous single click — the double
        // click's first event already appended a vertex, so we just
        // commit what's there).
        if (addMode && (addMode.shape === 'polyline' || addMode.shape === 'polyshape') && polylineDraft) {
          const minVerts = addMode.shape === 'polyshape' ? 3 : 2;
          if (polylineDraft.vertices.length >= minVerts) {
            commitPolylineDraft(polylineDraft.vertices);
          }
          setPolylineDraft(null);
          e.stopPropagation();
          e.preventDefault();
          return;
        }
        // C3: double-click on a SEGMENT of the primary-selected polyline /
        // polyshape inserts a rel-numeric vertex at the click point
        // (projected onto the segment so the path's geometry is unchanged
        // until the new vertex is dragged). Only straight, literal-driven
        // segments split cleanly — snap / arc / spline / expression-bound
        // neighbors refuse with a status-bar explanation.
        if (!addMode && !rulerMode && snapMode !== 'creating') {
          const cSel = solved.find(cc => cc.id === selectedId);
          if (!cSel || (cSel.kind !== 'polyline' && cSel.kind !== 'polyshape')) return;
          const wp = screenToWorld(e.clientX, e.clientY);
          const verts = resolveVertsFor(cSel);
          const pxw = viewport.w / (svgRef.current?.clientWidth || 1); // world units per px
          // Ignore double-clicks on (or hugging) an existing handle — that's
          // a vertex, not a segment.
          if (verts.some(([vx, vy]) => Number.isFinite(vx) && Math.hypot(vx - wp.x, vy - wp.y) <= 8 * pxw)) return;
          const widthVal = cSel.kind === 'polyline'
            ? (evalExpr(cSel.width, paramValues) || 0) / 2 : 0;
          const thresh = Math.max(6 * pxw, widthVal);
          const isClosed = cSel.kind === 'polyshape' || !!cSel.closed;
          const seg = nearestPolySegment(verts, wp, isClosed);
          if (!seg || seg.dist > thresh) return;
          const res = insertVertexInSegment(cSel, verts, seg.endIdx, seg.point);
          if (res.error) {
            setVertexEditStatus({ line: `Insert refused: ${res.error}` });
          } else {
            updateScene(prev => ({
              ...prev,
              components: prev.components.map(cc => cc.id === cSel.id ? { ...cc, vertices: res.vertices } : cc),
            }));
          }
          e.stopPropagation();
          e.preventDefault();
        }
      }}
      onContextMenu={(e) => {
        // Right-click on a component opens the App-level context menu.
        // Right-click on the bare canvas falls through to the browser's
        // own menu (no preventDefault) so DevTools / "save image" stay
        // accessible during dev.
        const cid = e.target?.dataset?.compId;
        if (!cid || !onComponentContextMenu) return;
        e.preventDefault();
        // Replace the selection with this component if it isn't already
        // included, so the menu operations have a clear target.
        if (!selectedIds.has(cid)) {
          setSelection({ ids: new Set([cid]), primary: cid });
        }
        onComponentContextMenu({ compId: cid, x: e.clientX, y: e.clientY });
      }}
    >
      <defs>
        <pattern id="grid" width={gridSize} height={gridSize} patternUnits="userSpaceOnUse">
          <path d={`M ${gridSize} 0 L 0 0 0 ${gridSize}`} fill="none" stroke="#cbd5e1" strokeWidth="0.3" />
        </pattern>
        <pattern id="gridMajor" width={gridSize * 5} height={gridSize * 5} patternUnits="userSpaceOnUse">
          <path d={`M ${gridSize * 5} 0 L 0 0 0 ${gridSize * 5}`} fill="none" stroke="#94a3b8" strokeWidth="0.4" />
        </pattern>
        {/* Arrowhead for lumped-port integration line. markerUnits=
            strokeWidth scales the arrowhead with the line's strokeWidth
            so it stays proportional at any zoom. orient=auto-start-reverse
            isn't widely supported in older browsers; the line itself is
            drawn so the arrow always points from start to end of the
            integration vector. */}
        <marker id="lp-arrow" viewBox="0 0 10 10" refX="9" refY="5"
          markerUnits="strokeWidth" markerWidth="5" markerHeight="5" orient="auto">
          <path d="M0,0 L10,5 L0,10 z" fill="#ef4444" opacity="0.85" />
        </marker>
      </defs>
      {showGrid && (
        <>
          <rect data-bg="true" x={vbX} y={vbY} width={viewport.w} height={viewport.h} fill="url(#grid)" />
          <rect data-bg="true" x={vbX} y={vbY} width={viewport.w} height={viewport.h} fill="url(#gridMajor)" />
        </>
      )}
      {/* When grid is hidden, we still want pointer hits on the background
          (drag-pan, marquee-deselect, polyline draft starts, etc.) so we
          drop in a transparent overlay rect — same data-bg="true" tag so
          all the existing onMouseDown logic still routes correctly. */}
      {!showGrid && (
        <rect data-bg="true" x={vbX} y={vbY} width={viewport.w} height={viewport.h} fill="transparent" />
      )}

      {/* Origin X / Y axes — dashed reference lines through (0, 0). Tied
          to the grid visibility toggle: when the user hides the grid for
          a clean screenshot / vector export, these axes go too. */}
      {showGrid && (
        <>
          <line x1={vbX} y1={0} x2={vbX + viewport.w} y2={0} stroke="#475569" strokeWidth={sw * 0.7} strokeDasharray={`${sw * 3},${sw * 3}`} pointerEvents="none" />
          <line x1={0} y1={vbY} x2={0} y2={vbY + viewport.h} stroke="#475569" strokeWidth={sw * 0.7} strokeDasharray={`${sw * 3},${sw * 3}`} pointerEvents="none" />
        </>
      )}

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
        // Same map but keyed onto the SOLVED components, which carry the
        // post-snap cx/cy AND the post-resolveBooleanBboxes bbox-center
        // for booleans (whose stored scene cx/cy is just a placeholder).
        // Critical for buildBoolInstanceOverrides: the boolean's base
        // position must come from the solved record, not the scene one,
        // or the per-instance shift collapses to (solved - scene) instead
        // of zero for the base copy.
        const solvedById = Object.fromEntries(solved.map(c => [c.id, c]));
        // Helper: the right base cx/cy to pass to buildBoolInstanceOverrides
        // for a given component. Falls back to scene cx/cy if the solved
        // record is missing (defensive — shouldn't happen in practice).
        const solvedBase = (c) => {
          const s = solvedById[c.id];
          return { cx: s ? s.cx : c.cx, cy: s ? s.cy : c.cy };
        };
        // Resolve a component's first rendered instance (post-transform).
        // The optional `overrides` map lets callers force a specific
        // instance for one or more compIds — used by the boolean renderer
        // when expanding a transform chain: each rendered copy of a
        // boolean rebuilds its operands at the rotated/translated position
        // for that particular copy, and the override map plumbs those
        // synthetic instances through the recursive renderInterior /
        // renderOutline / collectBbox chain without needing an outer SVG
        // <g transform> (whose interaction with mask coordinates is
        // surprising and was preventing rotated booleans from appearing).
        const instOf = (c, overrides) => {
          if (overrides && overrides[c.id]) return overrides[c.id];
          const list = instancesByCompId[c.id] || [];
          return list[0] || {
            compId: c.id, idx: 0, cx: c.cx, cy: c.cy,
            w: evalExpr(c.w, paramValues), h: evalExpr(c.h, paramValues),
            rotation: 0,
          };
        };
        // Same as instOf but returns ALL instances of the primitive. Used
        // by the boolean rendering paths (renderInterior / renderOutline /
        // collectBbox) so a primitive operand with its own repeat / mirror
        // / duplicate_mirror chain contributes every clone to the boolean
        // — not just the base. Without this, subtract(A, B) where A has
        // repeat=3 only subtracts B from A's first instance; the other
        // three clones silently disappear from the boolean's mask.
        //
        // When an override is present (boolean has its OWN transforms),
        // it currently provides a single synthetic instance per operand
        // — the operand's own multi-instance chain inside that transformed
        // boolean copy is not yet expanded. Returning a 1-element array
        // here keeps that path's behavior unchanged. The combined case
        // (boolean has transforms AND operand has transforms) would need
        // a Cartesian-product expansion which is intentionally deferred.
        const instancesOf = (c, overrides) => {
          if (overrides && overrides[c.id]) return [overrides[c.id]];
          const list = instancesByCompId[c.id];
          if (list && list.length > 0) return list;
          return [{
            compId: c.id, idx: 0, cx: c.cx, cy: c.cy,
            w: evalExpr(c.w, paramValues), h: evalExpr(c.h, paramValues),
            rotation: 0,
          }];
        };
        // Path "d" string for an instance, dispatching on the instance's
        // shape kind via shapeInstanceToRing (circles/ellipses/polygons
        // become tessellated rings; rectangles use their 4-corner ring).
        const rectPathD = (inst) => ringToSvgPath(shapeInstanceToRing(inst));

        // Flat-bbox collector used for mask viewport sizing; recurses
        // through derived operands so the bbox covers the entire object.
        const collectBbox = (comp, overrides) => {
          const out = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
          // Visit a component, expanding both PRIMITIVE transform clones
          // (handled at the leaf) and BOOLEAN transform clones (handled
          // by iterating the boolean's own instances and recursing with
          // per-instance override maps). Without the boolean iteration,
          // a nested boolean operand carrying a repeat transform (e.g. a
          // union-of-rects with a repeat=3 transform, then subtracted by
          // another shape) would contribute only its base instance to
          // the mask viewport — the repeated clones would fall outside
          // the mask and visually disappear from the parent boolean's
          // compositing.
          const visit = (c, currentOverrides) => {
            if (!c) return;
            if (c.kind === 'boolean') {
              const bInsts = instancesOf(c, currentOverrides);
              const base = solvedBase(c);
              for (const bInst of bInsts) {
                const perInst = buildBoolInstanceOverrides(c, bInst, base.cx, base.cy);
                const merged = { ...(currentOverrides || {}), ...(perInst || {}), [c.id]: bInst };
                for (const id of (c.operandIds || [])) visit(compById[id], merged);
              }
            } else {
              for (const inst of instancesOf(c, currentOverrides)) {
                const ring = shapeInstanceToRing(inst);
                for (const [x, y] of ring) {
                  if (x < out.minX) out.minX = x; if (x > out.maxX) out.maxX = x;
                  if (y < out.minY) out.minY = y; if (y > out.maxY) out.maxY = y;
                }
              }
            }
          };
          visit(comp, overrides);
          return out;
        };

        // Compose a boolean's per-instance transform (translation + rotation
        // about the instance centroid) onto each operand's base instance so
        // the operands render at the rotated/translated position directly.
        // Returns a map compId -> synthetic instance for every operand
        // (recursively, through nested booleans), or null if the boolean has
        // no transforms.
        //
        // [F3] The actual math lives in the module-level pure helper
        // buildBoolOverridesForInstance; results for canonical instances
        // are precomputed in boolInstanceOverridesCache (memoized) and
        // looked up by instance-object identity. Non-canonical / synthetic
        // instances (defensive fallbacks) compute fresh — same output.
        const buildBoolInstanceOverrides = (b, bInst, bBaseCx, bBaseCy) => {
          const perInst = boolInstanceOverridesCache.get(b.id);
          if (perInst && perInst.has(bInst)) return perInst.get(bInst);
          return buildBoolOverridesForInstance(b, bInst, bBaseCx, bBaseCy, compById, (cc) => instOf(cc));
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
        const renderInterior = (comp, fillColor, keyBase, dataCompId, parentClip, overrides) => {
          if (!comp) return null;
          // Multi-instance boolean operand (e.g. a union with a repeat
          // transform that's now the base of a subtract): iterate the
          // boolean's own transform instances and recurse per-instance
          // with overrides that shift each descendant into position.
          // The recursive call sees overrides[comp.id] set, so its
          // instancesOf returns a single-element array → falls through
          // to the op dispatch below without re-iterating. The cluster
          // path also sets overrides[b.id], so top-level booleans
          // don't double-iterate (the cluster handles per-instance
          // styling like the 85% opacity for non-base copies).
          if (comp.kind === 'boolean') {
            const bInsts = instancesOf(comp, overrides);
            if (bInsts.length > 1) {
              const base = solvedBase(comp);
              return (
                <React.Fragment key={keyBase}>
                  {bInsts.map((bInst, ii) => {
                    const perInst = buildBoolInstanceOverrides(comp, bInst, base.cx, base.cy);
                    const merged = { ...(overrides || {}), ...(perInst || {}), [comp.id]: bInst };
                    return renderInterior(comp, fillColor, `${keyBase}-bi${ii}`, dataCompId, parentClip, merged);
                  })}
                </React.Fragment>
              );
            }
          }
          const isPrim = comp.kind !== 'boolean';
          if (isPrim) {
            // Emit one <path> per transform-instance of this primitive.
            // For a comp without transforms this is a single path (no
            // change from the previous behavior). For a comp with
            // repeat / mirror / duplicate_mirror this paints every
            // clone — critical when the primitive is an operand of a
            // boolean: without iterating, only the base instance ends
            // up in the mask, and all clones silently disappear from
            // the boolean's rendered footprint.
            //
            // Return a React fragment (no <g> wrapper) — Safari's older
            // CSS-mask implementations occasionally drop pixels of paths
            // wrapped in a <g> inside <mask> / <clipPath> children, while
            // bare paths composite reliably. Fragments are also cheaper.
            const insts = instancesOf(comp, overrides);
            const pathProps = {
              fill: fillColor,
              ...(dataCompId ? { 'data-comp-id': dataCompId } : {}),
              ...(parentClip ? { clipPath: parentClip } : {}),
            };
            if (insts.length === 1) {
              return (
                <path key={keyBase} d={rectPathD(insts[0])} {...pathProps} />
              );
            }
            return (
              <React.Fragment key={keyBase}>
                {insts.map((inst, i) => (
                  <path
                    key={`${keyBase}-i${i}`}
                    d={rectPathD(inst)}
                    {...pathProps}
                  />
                ))}
              </React.Fragment>
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
                {ops.map((opC, i) => renderInterior(opC, fillColor, `${keyBase}-u${i}`, dataCompId, parentClip, overrides))}
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
                  {renderInterior(ops[i], 'white', `${id}-c`, undefined, parentId ? `url(#${parentId})` : undefined, overrides)}
                </clipPath>
              );
            }
            const finalClip = chainIds.length ? `url(#${chainIds[chainIds.length - 1]})` : parentClip;
            return (
              <g key={keyBase}>
                <defs>{chainDefs}</defs>
                {renderInterior(ops[0], fillColor, `${keyBase}-i0`, dataCompId, finalClip, overrides)}
              </g>
            );
          }
          if (comp.op === 'subtract' || comp.op === 'punch') {
            // base operand drawn in `fillColor`, with a mask that has the
            // base's interior in white minus subtractors' interiors in black.
            // 'punch' is rendered identically to 'subtract' here — the
            // distinction only matters for consumedBy tagging and the
            // keep_originals export flag.
            const maskId = nextDefId(`${keyBase}-submask`);
            const bbox = collectBbox(comp, overrides);
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
                    {renderInterior(ops[0], 'white', `${maskId}-base`, undefined, undefined, overrides)}
                    {ops.slice(1).map((opC, i) =>
                      renderInterior(opC, 'black', `${maskId}-sub${i}`, undefined, undefined, overrides)
                    )}
                  </mask>
                </defs>
                <g mask={`url(#${maskId})`}>
                  {renderInterior(ops[0], fillColor, `${keyBase}-baseunder`, dataCompId, parentClip, overrides)}
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
        const renderOutline = (comp, strokeColor, strokeW, keyBase, overrides) => {
          if (!comp) return null;
          // Mirror the renderInterior logic: iterate a multi-instance
          // boolean's own transform copies so each copy's outline is
          // emitted (with descendants shifted by the per-instance
          // override map). See renderInterior for the full rationale.
          if (comp.kind === 'boolean') {
            const bInsts = instancesOf(comp, overrides);
            if (bInsts.length > 1) {
              const base = solvedBase(comp);
              return (
                <React.Fragment key={keyBase}>
                  {bInsts.map((bInst, ii) => {
                    const perInst = buildBoolInstanceOverrides(comp, bInst, base.cx, base.cy);
                    const merged = { ...(overrides || {}), ...(perInst || {}), [comp.id]: bInst };
                    return renderOutline(comp, strokeColor, strokeW, `${keyBase}-bi${ii}`, merged);
                  })}
                </React.Fragment>
              );
            }
          }
          const isPrim = comp.kind !== 'boolean';
          if (isPrim) {
            // Stroke every instance of this primitive — matches the
            // multi-instance rendering done by renderInterior so the
            // visible outline traces every clone, not just the base.
            // Same Fragment-vs-<g> rationale as the renderInterior path.
            const insts = instancesOf(comp, overrides);
            const pathProps = {
              fill: 'none', stroke: strokeColor, strokeWidth: strokeW,
              pointerEvents: 'none',
            };
            if (insts.length === 1) {
              return <path key={keyBase} d={rectPathD(insts[0])} {...pathProps} />;
            }
            return (
              <React.Fragment key={keyBase}>
                {insts.map((inst, i) => (
                  <path
                    key={`${keyBase}-i${i}`}
                    d={rectPathD(inst)}
                    {...pathProps}
                  />
                ))}
              </React.Fragment>
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
                  const bbox = collectBbox(comp, overrides);
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
                            renderInterior(other, 'black', `${maskId}-other${j}`, undefined, undefined, overrides))}
                        </mask>
                      </defs>
                      <g mask={`url(#${maskId})`}>
                        {renderOutline(opC, strokeColor, strokeW, `${keyBase}-uoinner${i}`, overrides)}
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
                        {renderInterior(others[k], 'white', `${id}-c`, undefined, parentId ? `url(#${parentId})` : undefined, overrides)}
                      </clipPath>
                    );
                  }
                  const finalClip = chainIds.length ? `url(#${chainIds[chainIds.length - 1]})` : null;
                  return (
                    <g key={`${keyBase}-iso${i}`}>
                      <defs>{chainDefs}</defs>
                      <g clipPath={finalClip}>
                        {renderOutline(opC, strokeColor, strokeW, `${keyBase}-isoinner${i}`, overrides)}
                      </g>
                    </g>
                  );
                })}
              </g>
            );
          }
          if (comp.op === 'subtract' || comp.op === 'punch') {
            // Base operand outline masked by NOT(subtractors), plus each
            // subtractor's outline clipped by base interior. 'punch' is
            // rendered identically to 'subtract' here.
            const maskId = nextDefId(`${keyBase}-subout`);
            const baseClipId = nextDefId(`${keyBase}-baseclip`);
            const bbox = collectBbox(comp, overrides);
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
                    {renderInterior(ops[0], 'white', `${maskId}-base`, undefined, undefined, overrides)}
                    {ops.slice(1).map((opC, i) =>
                      renderInterior(opC, 'black', `${maskId}-sub${i}`, undefined, undefined, overrides)
                    )}
                  </mask>
                  <clipPath id={baseClipId} clipPathUnits="userSpaceOnUse">
                    {renderInterior(ops[0], 'white', `${baseClipId}-c`, undefined, undefined, overrides)}
                  </clipPath>
                </defs>
                <g mask={`url(#${maskId})`}>
                  {renderOutline(ops[0], strokeColor, strokeW, `${keyBase}-baseout`, overrides)}
                </g>
                <g clipPath={`url(#${baseClipId})`}>
                  {ops.slice(1).map((opC, i) =>
                    renderOutline(opC, strokeColor, strokeW, `${keyBase}-subout${i}`, overrides)
                  )}
                </g>
              </g>
            );
          }
          return null;
        };

        // Render a single boolean cluster: fill + outline + selection halo.
        // If the boolean carries a transform chain (e.g. a `repeat` or a
        // `rotate`), we emit one rendered copy per instance returned by
        // expandTransforms. Each copy is rendered by passing an OPERAND
        // INSTANCE OVERRIDE MAP down through the recursive renderer; the
        // override map gives every operand a synthetic instance at the
        // copy's rotated/translated position. We do NOT use an outer
        // <g transform> because SVG masks under outer transforms are
        // fragile — the override approach computes the right positions
        // directly so paths and masks stay in their natural user-space
        // coordinate system. The HFSS / pyAEDT exports produce the
        // matching geometry (single Unite, then DuplicateAlongLine, then
        // Rotate on the whole cluster).
        return booleanClusters.booleanComps.flatMap((b) => {
          // Determine the display fill color. Try the bound conductor
          // layer's color first (resolved recursively from operand[0]
          // so a union of layer-X rects renders in layer-X's color);
          // fall back to the role-based default when no specific layer
          // is bound.
          const style = styleForComponent(b);
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
          // Solved counterpart carries the numeric centroid (b.cx, b.cy) the
          // boolean's transform chain expanded from. The scene-side `b` has
          // string placeholders for w/h but cx/cy is numeric on both sides.
          const solvedB = solved.find(c => c.id === b.id) || b;
          const baseCx = solvedB.cx;
          const baseCy = solvedB.cy;
          // Per-instance offsets. expandTransforms returns [{cx, cy, ...}]
          // for each rendered copy; the first entry is the un-shifted base.
          // No transforms ⇒ single entry equal to the base.
          const insts = instancesByCompId[b.id] || [{ cx: baseCx, cy: baseCy, idx: 0, rotation: 0 }];
          const elements = insts.map((inst, i) => {
            const baseOv = buildBoolInstanceOverrides(b, inst, baseCx, baseCy);
            // Always include [b.id]: inst so the recursive renderInterior /
            // renderOutline see this boolean as "single instance" and skip
            // their own iteration — otherwise the cluster's per-instance
            // loop and renderInterior's boolean-iteration loop would
            // multiply, producing N × N copies.
            const overrides = { ...(baseOv || {}), [b.id]: inst };
            const isBase = i === 0;
            return (
              <g
                key={`bool_${b.id}_${i}`}
                style={{ cursor: 'move' }}
                opacity={isBase ? 1 : 0.85}
              >
                {/* (1) Fill — recursive interior with the layer's fill color. */}
                <g opacity={fillOpacity}>
                  {renderInterior(b, fill, `bool-fill-${b.id}-${i}`, b.id, undefined, overrides)}
                </g>
                {/* (2) Result outline — recursive perimeter in op accent. */}
                {renderOutline(b, accent, outlineW, `bool-out-${b.id}-${i}`, overrides)}
              </g>
            );
          });
          // Selection halo: a single AXIS-ALIGNED bbox around the whole
          // cluster (post-transform footprint when displayBbox is set, the
          // pre-transform operand AABB otherwise). One rectangle reads as
          // "this boolean is selected" without making every duplicate
          // flash cyan — which was confusing when the chain repeated.
          if (isSelected) {
            const halo = solvedB.displayBbox || { cx: solvedB.cx, cy: solvedB.cy, w: solvedB.w, h: solvedB.h };
            if (Number.isFinite(halo.w) && Number.isFinite(halo.h) && halo.w > 0 && halo.h > 0) {
              elements.push(
                <rect
                  key={`bool-halo-${b.id}`}
                  x={halo.cx - halo.w / 2}
                  y={-(halo.cy + halo.h / 2)}
                  width={halo.w}
                  height={halo.h}
                  fill="none"
                  stroke={haloColor}
                  strokeWidth={haloW}
                  strokeDasharray={`${HALO_W * 1.6},${HALO_W * 1.1}`}
                  pointerEvents="none"
                />
              );
            }
          }
          return elements;
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
        const bSolved = solved.find(c => c.id === bScene.id) || bScene;
        // If the boolean carries transforms, `displayBbox` holds the
        // post-transform AABB — the visible footprint of the rotated /
        // repeated cluster. Anchor dots should sit on THAT bbox so the
        // user can snap something else to (e.g.) the rotated meander's
        // top-right corner. Fall back to the raw cx/cy/w/h for plain
        // booleans without transforms.
        const b = bSolved.displayBbox
          ? { id: bScene.id, cx: bSolved.displayBbox.cx, cy: bSolved.displayBbox.cy, w: bSolved.displayBbox.w, h: bSolved.displayBbox.h }
          : bSolved;
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
        // 'via' renders above electrodes (it's a plug THROUGH the metal)
        // but below ports (translucent overlays stay on top).
        for (const layer of ['waveguide', 'electrode', 'via', 'port']) {
          for (const c of solved) {
            if (c.layer === layer && isInPass1(c) && !isBoolOperand(c) && !isBoolComp(c)) pass1.push(c);
          }
        }
        const pass2 = [...solved]
          .filter(c => !isInPass1(c) && !isBoolOperand(c) && !isBoolComp(c))
          .sort((a, b) => stackPriority(a) - stackPriority(b));
        const ordered = [...pass1, ...pass2];
        return ordered.map(c => {
          const { w, h } = dimsByCompId[c.id]; // [F2]
          const style = styleForComponent(c);
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
          // Parent/child/mirror highlight is part of the snap-network
          // overlay — gated on showGrid alongside the grid pattern,
          // origin axes, and snap arrows.
          else if (showGrid && isParent) { strokeColor = '#0ea5e9'; strokeWidth = HALO_W; }
          else if (showGrid && isChild) { strokeColor = '#22d3ee'; strokeWidth = HALO_W; }
          else if (showGrid && isMirror) { strokeColor = '#a855f7'; strokeWidth = HALO_W; }
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
                  // Related-component dashed outlines are tied to the
                  // grid visibility toggle — they live alongside the
                  // grid + axes as visual scaffolding, not part of the
                  // figure itself. Hide them all together for a clean
                  // canvas (and figure export).
                  strokeDasharray: (showGrid && !isSelected && (isParent || isChild || isMirror)) ? `${dashOn},${dashOff}` : undefined,
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
                } else if (shapeKind === 'polyline') {
                  // Polyline trace. The path is the TESSELLATED centerline
                  // (arcs expanded, spline runs Catmull-Rom-interpolated) so
                  // the canvas draws the same geometry HFSS builds from
                  // AngularArc / Spline segments. Vertices are resolved from
                  // the COMPONENT (not the instance) each render so vertex
                  // snap-target moves are picked up live; the instance's
                  // cx/cy is the post-transform bbox center, which we don't
                  // use for the path here.
                  const compById_pl = Object.fromEntries(scene.components.map(cc => [cc.id, cc]));
                  const wgW = Number.isFinite(inst.width) ? inst.width : evalExpr(c.width, paramValues) || 0;
                  // C3 live preview: while a vertex-handle drag is in
                  // flight, render from the locally patched vertices (the
                  // scene commit happens once on mouseup).
                  const cPl = (vertexDrag && vertexDrag.compId === c.id && vertexDrag.preview)
                    ? { ...c, vertices: vertexDrag.preview } : c;
                  if (polylineIsTapered(cPl)) {
                    // TAPERED trace: SVG strokes can't vary width along a
                    // path, so render the band as filled per-segment quads
                    // (endpoint ± (w/2)·normal, BUTT joins) — EXACTLY the
                    // per-segment sheets the HFSS export unites, keeping
                    // canvas/HFSS geometric compatibility.
                    // Quads are computed at the component's BASE pose;
                    // remap into this instance's frame so repeat / mirror
                    // / rotate clones land where expandTransforms put
                    // them (same math as rings.js → GDS / boolean masks).
                    const { quads } = taperedBandQuads(cPl, compById_pl, paramValues, transformInstances);
                    if (quads.length > 0) {
                      let d = '';
                      for (const q of quads) {
                        const qi = remapPointsToInstance(q, inst, c.cx, c.cy);
                        d += `M ${qi[0][0]} ${-qi[0][1]} L ${qi[1][0]} ${-qi[1][1]} L ${qi[2][0]} ${-qi[2][1]} L ${qi[3][0]} ${-qi[3][1]} Z `;
                      }
                      shapeElement = (
                        <path d={d} {...dataCompProps} />
                      );
                    } else {
                      shapeElement = null;
                    }
                  } else {
                    // Tessellated at the BASE pose, remapped per instance —
                    // without the remap every repeat clone drew the same
                    // path stacked on the original (the repeat appeared to
                    // do nothing for polylines/polyshapes).
                    const baseVerts = tessellatePolylinePath(cPl, compById_pl, paramValues, transformInstances);
                    const verts = remapPointsToInstance(baseVerts, inst, c.cx, c.cy);
                    if (verts.length >= 2 && wgW > 0) {
                      let d = `M ${verts[0][0]} ${-verts[0][1]}`;
                      for (let k = 1; k < verts.length; k++) {
                        d += ` L ${verts[k][0]} ${-verts[k][1]}`;
                      }
                      if (cPl.closed) d += ' Z';
                      const { fill: _f, stroke: _s, strokeWidth: _sw, ...restProps } = dataCompProps;
                      shapeElement = (
                        <path
                          d={d}
                          fill="none"
                          stroke={style.fill}
                          strokeWidth={wgW}
                          strokeLinejoin="miter"
                          strokeLinecap="butt"
                          {...restProps}
                        />
                      );
                    } else if (verts.length >= 2) {
                      // Width = 0 (or unresolved): show the centerline as
                      // a thin guide so the polyline is still visible.
                      let d = `M ${verts[0][0]} ${-verts[0][1]}`;
                      for (let k = 1; k < verts.length; k++) {
                        d += ` L ${verts[k][0]} ${-verts[k][1]}`;
                      }
                      const { fill: _f, ...restProps } = dataCompProps;
                      shapeElement = (
                        <path
                          d={d}
                          fill="none"
                          stroke={style.stroke}
                          strokeWidth={sw}
                          strokeDasharray={`${sw * 3},${sw * 3}`}
                          {...restProps}
                        />
                      );
                    } else {
                      shapeElement = null;
                    }
                  }
                } else if (shapeKind === 'polyshape') {
                  // Closed polygon path. The TESSELLATED vertices (arcs
                  // expanded, spline runs interpolated) form the perimeter;
                  // we emit a <path> with `Z` so the browser fills the
                  // interior. Width is irrelevant — the layer fill color
                  // paints the whole region.
                  const compById_ps = Object.fromEntries(scene.components.map(cc => [cc.id, cc]));
                  // C3 live preview (see the polyline branch above).
                  const cPs = (vertexDrag && vertexDrag.compId === c.id && vertexDrag.preview)
                    ? { ...c, vertices: vertexDrag.preview } : c;
                  // BASE-pose tessellation remapped into this instance's
                  // frame (translate + mirror scale + rotation about the
                  // instance anchor) — the same xform rings.js applies for
                  // GDS / boolean masks. Without it, repeat clones all drew
                  // at the base position (repeat looked like a no-op).
                  const baseVerts = tessellatePolylinePath(cPs, compById_ps, paramValues, transformInstances);
                  const verts = remapPointsToInstance(baseVerts, inst, c.cx, c.cy);
                  if (verts.length >= 3) {
                    let d = `M ${verts[0][0]} ${-verts[0][1]}`;
                    for (let k = 1; k < verts.length; k++) {
                      d += ` L ${verts[k][0]} ${-verts[k][1]}`;
                    }
                    d += ' Z';
                    shapeElement = (
                      <path d={d} {...dataCompProps} />
                    );
                  } else {
                    shapeElement = null;
                  }
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
                } else if (shapeKind === 'via') {
                  // Via (D4): plan-view annulus — outer circle in the via
                  // style plus a small center dot so it reads as "vertical
                  // connection" against ordinary circles. Tooltip names the
                  // spanned stack layers.
                  const rVia = Number.isFinite(inst.r) ? inst.r : 0;
                  const lFrom = (scene.stack || []).find(l => l.id === c.layerFrom);
                  const lTo = (scene.stack || []).find(l => l.id === c.layerTo);
                  const viaTip = `via: ${lFrom?.name || c.layerFrom || '?'} → ${lTo?.name || c.layerTo || '?'}`;
                  shapeElement = (
                    <g>
                      <circle
                        cx={inst.cx} cy={-inst.cy}
                        r={rVia}
                        {...dataCompProps}
                      >
                        <title>{viaTip}</title>
                      </circle>
                      <circle
                        cx={inst.cx} cy={-inst.cy}
                        r={rVia * 0.35}
                        fill="#f59e0b"
                        stroke="#78350f"
                        strokeWidth={sw * 0.4}
                        opacity={instOpacity}
                        pointerEvents="none"
                      />
                    </g>
                  );
                } else {
                  // Rectangle: use <rect> with rotation applied via the
                  // parent <g> for crisp axis-aligned strokes. A positive
                  // cornerRadius (D3 fillet, clamped to min(w,h)/2 — the
                  // SAME clamp rings.js applies) renders via the SVG rx
                  // attribute: visually EXACT for a uniform radius, and
                  // matching the arc geometry HFSS builds natively.
                  const ix = inst.cx - inst.w / 2;
                  const iy = -(inst.cy + inst.h / 2);
                  const rxFillet = clampCornerRadius(inst.cornerRadius, inst.w, inst.h);
                  shapeElement = (
                    <rect
                      x={ix} y={iy} width={inst.w} height={inst.h}
                      {...(rxFillet > 0 ? { rx: rxFillet } : {})}
                      {...dataCompProps}
                    />
                  );
                }
                // For polygons, racetracks, and polylines the ring/path
                // already includes the per-vertex rotation; skip double-
                // rotating via the wrapping group.
                // Shapes whose path math already bakes the instance's
                // rotation into the points (rings / remapPointsToInstance)
                // must NOT also get the SVG rotate wrapper — that would
                // double-rotate. polyshape joined this set when its render
                // switched to remapPointsToInstance.
                const wrapTransform = (shapeKind === 'polygon' || shapeKind === 'racetrack' || shapeKind === 'polyline' || shapeKind === 'polyshape') ? undefined : rotAttr;
                // Hit-pad: a transparent rect sized to at least
                // MIN_HIT_PX on each axis, rendered BELOW the visible
                // shape with the same data-comp-id. Only emitted when
                // the instance is actually narrower than the minimum on
                // one or both axes, so it's a no-op on normally-sized
                // shapes. Catches near-misses on sub-pixel-thin
                // waveguides and the like — without it, those near-
                // misses would land on the background and turn an
                // intended alt-drag into a marquee.
                const hitW = Math.max(inst.w, minHitWorld);
                const hitH = Math.max(inst.h, minHitWorld);
                const needsHitPad = hitW > inst.w + 1e-9 || hitH > inst.h + 1e-9;
                const hitPad = needsHitPad ? (
                  <rect
                    x={inst.cx - hitW / 2}
                    y={-(inst.cy + hitH / 2)}
                    width={hitW}
                    height={hitH}
                    fill="transparent"
                    pointerEvents="all"
                    data-comp-id={c.id}
                    style={{ cursor: 'move' }}
                  />
                ) : null;
                return (
                  <g key={inst.transformPath} transform={wrapTransform}>
                    {hitPad}
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
              {/* zOffset badge: 2-D top view can't show Z, so surface the
                  per-component Z offset in the selection info instead. */}
              {isPrimary && c.zOffset != null && String(c.zOffset).trim() !== '' && String(c.zOffset).trim() !== '0' && (() => {
                const zv = evalExpr(c.zOffset, paramValues);
                const fs = Math.max(1.5, Math.min(w, h) / 11);
                return (
                  <text x={c.cx} y={-c.cy + fs * 1.4} fontSize={fs} textAnchor="middle" dominantBaseline="middle" fill="#7c2d92" pointerEvents="none" fontFamily="monospace">
                    {`z${zv >= 0 ? '+' : ''}${Number.isFinite(zv) ? zv.toFixed(2) : '?'}µm (${String(c.zOffset)})`}
                  </text>
                );
              })()}
              {/* Snap direction indicators on the primary-selected component.
                  For each snap touching this component, draw a small arrow at
                  the relevant anchor pointing along the snap line. Incoming
                  arrows (this comp is the `to`) point INTO this component
                  from the parent — drawn in sky-blue. Outgoing arrows (this
                  comp is the `from`) point OUTWARD toward the child — drawn
                  in cyan.
                  Gated on showGrid alongside the rest of the snap-network
                  overlay so the user can hide everything at once for a
                  clean canvas / figure. */}
              {isPrimary && showGrid && (() => {
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
                  const myLocal = anchorLocalRotated(myAnchor, w, h, compRotationDeg(c, paramValues));
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
                  const { w: ow, h: oh } = dimsByCompId[otherComp.id]; // [F2]
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
                // Expression-bound axes can't be resized by dragging (the
                // commit logic skips them — the dimension is derived from
                // parameters). Show 'not-allowed' on the handles that would
                // engage a bound axis: E/W → w, N/S → h, corners → either.
                const wBound = isExprBoundDim(c.w);
                const hBound = isExprBoundDim(c.h);
                let cursor = 'move';
                if (a === 'NE' || a === 'SW') cursor = (wBound || hBound) ? 'not-allowed' : 'nesw-resize';
                else if (a === 'NW' || a === 'SE') cursor = (wBound || hBound) ? 'not-allowed' : 'nwse-resize';
                else if (a === 'N' || a === 'S') cursor = hBound ? 'not-allowed' : 'ns-resize';
                else if (a === 'E' || a === 'W') cursor = wBound ? 'not-allowed' : 'ew-resize';
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
              {/* Snap-mode edge strips: clickable lines on each edge.
                  Rotation-aware: strips, t-projection, and the hover dot
                  all live in the shape's LOCAL frame so they trace the
                  rotated shape's actual edges. */}
              {snapMode === 'creating' && (() => {
                const edgeStrokeW = Math.max(hr * 0.8, 1);
                const rotE = compRotationDeg(c, paramValues);
                const radE = rotE * Math.PI / 180;
                const caE = Math.cos(radE), saE = Math.sin(radE);
                const toWorldE = (lx, ly) => ({ x: c.cx + lx * caE - ly * saE, y: c.cy + lx * saE + ly * caE });
                const toLocalE = (x, y) => ({ x: (x - c.cx) * caE + (y - c.cy) * saE, y: -(x - c.cx) * saE + (y - c.cy) * caE });
                // Local bounds of the rect (centered frame)
                const lx0 = -w / 2, lx1 = w / 2;
                const ly0 = -h / 2, ly1 = h / 2;
                // Figure t from a screen click: use the SVG's CTM via
                // screenToWorld, map into the LOCAL frame, then to t along
                // the edge.
                const tFromWorld = (side, x, y) => {
                  const l = toLocalE(x, y);
                  let t;
                  if (side === 'T' || side === 'B') t = (l.x - lx0) / Math.max(1e-9, w);
                  else                              t = (l.y - ly0) / Math.max(1e-9, h);
                  return Math.max(0, Math.min(1, t));
                };
                const handleEdgeClick = (side, e) => {
                  e.stopPropagation();
                  const wp = screenToWorld(e.clientX, e.clientY);
                  let t = tFromWorld(side, wp.x, wp.y);
                  // Apply Shift axis-lock against first anchor (if picking the second)
                  if (e.shiftKey && snapPick && snapPick.compId !== c.id) {
                    const fromComp = solved.find(cc => cc.id === snapPick.compId);
                    if (fromComp) {
                      const fromW = anchorWorld(fromComp, snapPick.anchor, paramValues);
                      // Solve for t such that the edge anchor lines up with
                      // the first anchor (projected into the local frame).
                      t = tFromWorld(side, fromW.x, fromW.y);
                    }
                  }
                  // Round t for cleaner snap names
                  const tRounded = Math.round(t * 1000) / 1000;
                  onAnchorClick(c.id, `${side}:${tRounded}`, e);
                };
                const handleEdgeMove = (side, e) => {
                  const wp = screenToWorld(e.clientX, e.clientY);
                  let t = tFromWorld(side, wp.x, wp.y);
                  if (e.shiftKey && snapPick && snapPick.compId !== c.id) {
                    const fromComp = solved.find(cc => cc.id === snapPick.compId);
                    if (fromComp) {
                      const fromW = anchorWorld(fromComp, snapPick.anchor, paramValues);
                      t = tFromWorld(side, fromW.x, fromW.y);
                    }
                  }
                  const local = anchorLocalRotated(`${side}:${t}`, w, h, rotE);
                  setSnapHover({ compId: c.id, side, t, x: c.cx + local.x, y: c.cy + local.y });
                };
                const mkEdge = (side, ax, ay, bx, by) => {
                  const p1 = toWorldE(ax, ay);
                  const p2 = toWorldE(bx, by);
                  return { side, x1v: p1.x, y1v: p1.y, x2v: p2.x, y2v: p2.y };
                };
                const edges = [
                  mkEdge('T', lx0, ly1, lx1, ly1),
                  mkEdge('B', lx0, ly0, lx1, ly0),
                  mkEdge('L', lx0, ly0, lx0, ly1),
                  mkEdge('R', lx1, ly0, lx1, ly1),
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
              {/* Snap-mode anchors. Rotation-aware: dots sit on the
                  ROTATED shape's actual corners/edges so what you click
                  is what the solver snaps to. */}
              {snapMode === 'creating' && ANCHORS.map(a => {
                const local = anchorLocalRotated(a, w, h, compRotationDeg(c, paramValues));
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
          const { w, h } = dimsByCompId[c.id]; // [F2]
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
        // Geometry constants. Sized in SCREEN PIXELS via the `screen()`
        // helper so the overlay stays the same visible size at every
        // zoom level. (The previous approach used a small fraction of
        // viewport.w in world units; zoom-in shrunk viewport.w but the
        // overlay's *screen* size grew at the same rate as the
        // geometry — labels ballooned to dozens of pixels tall.)
        const offsetDist = screen(28);      // dim line ~28 px off the geometry
        const extOverhang = screen(6);
        const arrowLen = screen(14);
        const arrowSpread = screen(5);
        const fontSize = screen(11);        // ~11 px font on screen
        const labelPadX = screen(5);
        const labelPadY = screen(3);
        const dimStroke = screen(0.9);
        const extStroke = screen(0.5);
        const labelStroke = screen(0.4);
        // Estimate character width for label-fits-on-line check.
        const charW = fontSize * 0.6;

        // Collision-avoidance for label pills. Many dimensioned features
        // share the same outward direction (e.g. a column of width dims
        // along the bottom of a meander), and their default-centered
        // labels would stack on top of each other. We track each placed
        // label's AABB and, for every new dim, scan a few candidate
        // positions along the dim line — and a couple of extra rows of
        // perpendicular offset — looking for the first slot that doesn't
        // overlap any prior label. When the label sits off-center, we
        // draw a tiny leader line from the dim-line center to the label
        // so the visual association is preserved.
        const placedLabels = [];
        const aabbOverlap = (a, b) =>
          !(a.maxX < b.minX || b.maxX < a.minX || a.maxY < b.minY || b.maxY < a.minY);
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
              // Label pill size
              const labelW = textW + 2 * labelPadX;
              const labelH = fontSize + 2 * labelPadY;
              // Center of the dim line — natural starting position.
              const midX = (dimP1.x + dimP2.x) / 2;
              const midY = (dimP1.y + dimP2.y) / 2;
              // Candidate positions, in order of preference:
              //   row 0 = on the dim line itself; row N = pushed N*step
              //   farther out along the outward normal (away from geometry).
              //   t = position along the dim line, 0=p1 endpoint, 1=p2 endpoint.
              // We try the center first, then offsets toward each end, then
              // step out and repeat. A small padding gap is added between
              // labels so they don't visually kiss.
              const outwardStep = labelH * 1.5;
              const gap = labelH * 0.15;
              const tValues = [0.5, 0.35, 0.65, 0.25, 0.75, 0.15, 0.85];
              const outRows = [0, 1, 2, 3];
              let chosenMx = midX, chosenMy = midY, chosenOut = 0, foundSlot = false;
              for (const outRow of outRows) {
                for (const t of tValues) {
                  const baseX = dimP1.x + (dimP2.x - dimP1.x) * t;
                  const baseY = dimP1.y + (dimP2.y - dimP1.y) * t;
                  const candCx = baseX + d.outwardN.x * outwardStep * outRow;
                  const candCy = baseY + d.outwardN.y * outwardStep * outRow;
                  const rect = {
                    minX: candCx - labelW / 2 - gap,
                    minY: candCy - labelH / 2 - gap,
                    maxX: candCx + labelW / 2 + gap,
                    maxY: candCy + labelH / 2 + gap,
                  };
                  if (!placedLabels.some(p => aabbOverlap(rect, p))) {
                    chosenMx = candCx;
                    chosenMy = candCy;
                    chosenOut = outRow;
                    placedLabels.push(rect);
                    foundSlot = true;
                    break;
                  }
                }
                if (foundSlot) break;
              }
              if (!foundSlot) {
                // No clean slot — accept the centered position regardless
                // (better than dropping the dimension entirely). Still
                // record its AABB so subsequent labels know about it.
                placedLabels.push({
                  minX: midX - labelW / 2,
                  minY: midY - labelH / 2,
                  maxX: midX + labelW / 2,
                  maxY: midY + labelH / 2,
                });
              }
              const mx = chosenMx;
              const my = chosenMy;
              // If we pushed the label off-axis, draw a thin leader line
              // from the dim-line center to the label's edge so the user
              // can still tell which dim the label belongs to.
              const needsLeader = chosenOut > 0;
              return (
                <g key={`dim_${i}_${d.kind}`}>
                  {/* Extension lines */}
                  <line x1={d.p1.x} y1={-d.p1.y} x2={ext1.x} y2={-ext1.y} stroke="#a78bfa" strokeWidth={extStroke} opacity={0.85} />
                  <line x1={d.p2.x} y1={-d.p2.y} x2={ext2.x} y2={-ext2.y} stroke="#a78bfa" strokeWidth={extStroke} opacity={0.85} />
                  {/* Dim line */}
                  <line x1={dimP1.x} y1={-dimP1.y} x2={dimP2.x} y2={-dimP2.y} stroke="#a78bfa" strokeWidth={dimStroke} opacity={0.95} />
                  {/* Arrowheads (point outward from line center) */}
                  <polyline points={arrowAt(dimP1, -1)} fill="none" stroke="#a78bfa" strokeWidth={dimStroke} strokeLinecap="round" strokeLinejoin="round" />
                  <polyline points={arrowAt(dimP2,  1)} fill="none" stroke="#a78bfa" strokeWidth={dimStroke} strokeLinecap="round" strokeLinejoin="round" />
                  {/* Leader line from dim center to displaced label */}
                  {needsLeader && (
                    <line
                      x1={midX} y1={-midY}
                      x2={mx} y2={-my}
                      stroke="#a78bfa" strokeWidth={extStroke}
                      opacity={0.55} strokeDasharray={`${screen(2.5)},${screen(1.8)}`}
                    />
                  )}
                  {/* Label pill */}
                  <rect
                    x={mx - textW / 2 - labelPadX}
                    y={-my - fontSize / 2 - labelPadY}
                    width={textW + 2 * labelPadX}
                    height={fontSize + 2 * labelPadY}
                    fill="rgba(15,23,42,0.92)"
                    stroke="#a78bfa"
                    strokeWidth={labelStroke}
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

      {/* ── Editable dimensions for the primary-selected rectangle ──
          Optional (toggled by the "edit dims" button; also shows right
          after creating a rect, which is auto-selected). Draws the rect's
          width (below) and height (right) as cyan dimension arrows, each
          with INLINE EDITABLE fields rendered as constant-size HTML inputs
          inside a <foreignObject>:
            • a lone parameter-bound dim (e.g. w = "wg_L") shows two fields —
              the NAME (renames the param scene-wide) and its VALUE (edits the
              param's expression);
            • a literal or multi-term dim (e.g. "300" or "2*wg_L") shows one
              field that edits the component's w/h directly, auto-creating any
              new params referenced.
          Distinct cyan accent vs the violet read-only `showDimensions`. */}
      {editDims && !rulerMode && (() => {
        const cSel = solved.find(cc => cc.id === selectedId);
        if (!cSel || cSel.kind !== 'rect') return null;
        const dd = dimsByCompId[cSel.id];
        if (!dd || !Number.isFinite(dd.w) || !Number.isFinite(dd.h) || dd.w <= 0 || dd.h <= 0) return null;
        const params = scene.params || {};
        const LONE = /^[A-Za-z_][A-Za-z0-9_]*$/;

        // Constant on-screen sizing (screen() => world units that render to ~px).
        const offsetDist = screen(34);
        const extOverhang = screen(6);
        const arrowLen = screen(13);
        const arrowSpread = screen(4.5);
        const dimStroke = screen(1.0);
        const extStroke = screen(0.6);
        const fontPx = screen(11);
        const fieldH = screen(20);
        const nameW = screen(60);
        const valueW = screen(54);
        const exprW = screen(98);
        const gapW = screen(4);
        const ACCENT = '#22d3ee'; // cyan — interactive
        const AMBER = '#fbbf24';  // param reference (edits by reference)

        const setCompDim = (key, expr) => {
          const prevVal = key === 'w' ? dd.w : dd.h;
          updateScene(prev => ({
            ...prev,
            components: prev.components.map(c => c.id === cSel.id ? { ...c, [key]: expr } : c),
          }));
          if (commitExpr) commitExpr(expr, Number.isFinite(prevVal) ? String(prevVal) : '1', 'µm', `Auto-created (${cSel.id}.${key})`);
        };

        const renderDim = (key, p1, p2, outwardN, value) => {
          const ox = outwardN.x * offsetDist, oy = outwardN.y * offsetDist;
          const dimP1 = { x: p1.x + ox, y: p1.y + oy };
          const dimP2 = { x: p2.x + ox, y: p2.y + oy };
          const lx = dimP2.x - dimP1.x, ly = dimP2.y - dimP1.y;
          const len = Math.hypot(lx, ly) || 1;
          const ux = lx / len, uy = ly / len;
          const extScale = offsetDist + extOverhang;
          const ext1 = { x: p1.x + outwardN.x * extScale, y: p1.y + outwardN.y * extScale };
          const ext2 = { x: p2.x + outwardN.x * extScale, y: p2.y + outwardN.y * extScale };
          const arrowAt = (tip, dirSign) => {
            const px = -uy, py = ux;
            const bx = tip.x - dirSign * ux * arrowLen, by = tip.y - dirSign * uy * arrowLen;
            return `${bx + px * arrowSpread},${-(by + py * arrowSpread)} ${tip.x},${-tip.y} ${bx - px * arrowSpread},${-(by - py * arrowSpread)}`;
          };
          const midX = (dimP1.x + dimP2.x) / 2, midY = (dimP1.y + dimP2.y) / 2;
          const expr = String(key === 'w' ? cSel.w : cSel.h);
          const trimmed = expr.trim();
          const isRef = LONE.test(trimmed) && !!params[trimmed];

          let fw, fields;
          if (isRef) {
            const pExpr = String(params[trimmed].expr ?? '');
            fw = nameW + valueW + gapW;
            fields = (
              <>
                <CanvasDimInput
                  key={`n-${trimmed}`} initial={trimmed} fontPx={fontPx} widthPx={nameW} color={AMBER}
                  title="Variable name — rename scene-wide" onCommit={(v) => renameParam && renameParam(trimmed, v)} />
                <CanvasDimInput
                  key={`v-${trimmed}-${pExpr}`} initial={pExpr} fontPx={fontPx} widthPx={valueW} color={ACCENT}
                  title={`Value of ${trimmed} (= ${Number.isFinite(value) ? value.toFixed(3) : '?'} µm)`}
                  onCommit={(v) => { if (updateParamExpr) updateParamExpr(trimmed, v); if (commitExpr) commitExpr(v, '1', 'µm', `Auto-created (${trimmed})`, trimmed); }} />
              </>
            );
          } else {
            fw = exprW;
            fields = (
              <CanvasDimInput
                key={`e-${expr}`} initial={expr} fontPx={fontPx} widthPx={exprW} color={ACCENT}
                title={`${key} = ${Number.isFinite(value) ? value.toFixed(3) : '?'} µm — edit expression`}
                onCommit={(v) => setCompDim(key, v)} />
            );
          }
          return (
            <g key={`editdim-${key}`}>
              <line x1={p1.x} y1={-p1.y} x2={ext1.x} y2={-ext1.y} stroke={ACCENT} strokeWidth={extStroke} opacity={0.8} />
              <line x1={p2.x} y1={-p2.y} x2={ext2.x} y2={-ext2.y} stroke={ACCENT} strokeWidth={extStroke} opacity={0.8} />
              <line x1={dimP1.x} y1={-dimP1.y} x2={dimP2.x} y2={-dimP2.y} stroke={ACCENT} strokeWidth={dimStroke} opacity={0.95} />
              <polyline points={arrowAt(dimP1, -1)} fill="none" stroke={ACCENT} strokeWidth={dimStroke} strokeLinecap="round" strokeLinejoin="round" />
              <polyline points={arrowAt(dimP2, 1)} fill="none" stroke={ACCENT} strokeWidth={dimStroke} strokeLinecap="round" strokeLinejoin="round" />
              <foreignObject x={midX - fw / 2} y={-midY - fieldH / 2} width={fw} height={fieldH} style={{ overflow: 'visible' }}>
                <div xmlns="http://www.w3.org/1999/xhtml" style={{ display: 'flex', gap: `${gapW}px`, alignItems: 'center', justifyContent: 'center', width: '100%', height: '100%', pointerEvents: 'none' }}>
                  {fields}
                </div>
              </foreignObject>
            </g>
          );
        };

        const hw = dd.w / 2, hh = dd.h / 2;
        return (
          <g>
            {renderDim('w', { x: cSel.cx - hw, y: cSel.cy - hh }, { x: cSel.cx + hw, y: cSel.cy - hh }, { x: 0, y: -1 }, dd.w)}
            {renderDim('h', { x: cSel.cx + hw, y: cSel.cy - hh }, { x: cSel.cx + hw, y: cSel.cy + hh }, { x: 1, y: 0 }, dd.h)}
          </g>
        );
      })()}

      {/* Lumped-port integration lines. Persistent (drawn regardless
          of selection) — one red arrow per port-layer component that
          has `lumpedPort.enabled` AND a valid auto-detected adjacency
          (two-conductor flanking, either by direct edge contact or by
          a punch hole that splits a single conductor in half). The
          arrow runs across the port through its center, oriented along
          the detected integration direction. Markers use red with
          transparency so the user can still see the port underneath. */}
      {(() => {
        const arrows = [];
        for (const c of solved) {
          if (c.layer !== 'port' || c.kind !== 'rect') continue;
          if (!c.lumpedPort || !c.lumpedPort.enabled) continue;
          const det = detectPortIntegrationLine(c, solved, paramValues);
          if (!det.direction) continue;
          let x1, y1, x2, y2;
          if (det.direction === 'EW') {
            x1 = det.line.startX; y1 = det.line.midY;
            x2 = det.line.endX;   y2 = det.line.midY;
          } else {
            x1 = det.line.midX;   y1 = det.line.startY;
            x2 = det.line.midX;   y2 = det.line.endY;
          }
          // No inset — endpoints sit exactly on the adjacent port edges
          // (the midpoints of the two sides facing the flanker
          // conductors), matching the HFSS IntLine that the export
          // will install on this port.
          arrows.push({ id: c.id, x1, y1, x2, y2 });
        }
        if (arrows.length === 0) return null;
        return (
          <g pointerEvents="none">
            {arrows.map(a => (
              <line key={a.id}
                x1={a.x1} y1={-a.y1} x2={a.x2} y2={-a.y2}
                stroke="#ef4444" strokeWidth={sw * 3} opacity={0.85}
                markerEnd="url(#lp-arrow)"
              />
            ))}
          </g>
        );
      })()}

      {/* Add-mode pre-drag hover indicator: show the snap target before
          the drag starts so the user can see what they'd grab if they
          click. Base-instance snaps (would install a parametric binding)
          render amber; non-base instances (repeats / mirrors / boolean
          cluster cells) render cyan with a dashed outer ring — same
          color convention as the in-draw polyline halo. */}
      {addMode && !addDrag && addHoverSnap && (addHoverSnap.compId || addHoverSnap.instanceIdx > 0) && (() => {
        const isBase = !!addHoverSnap.compId;
        const innerFill = isBase ? '#fbbf24' : '#67e8f9';
        const stroke = isBase ? '#f59e0b' : '#06b6d4';
        const innerStroke = isBase ? '#f59e0b' : '#0891b2';
        return (
          <g pointerEvents="none">
            <circle cx={addHoverSnap.x} cy={-addHoverSnap.y} r={hr * 0.6}
              fill={innerFill} stroke={innerStroke} strokeWidth={sw * 0.6} />
            <circle cx={addHoverSnap.x} cy={-addHoverSnap.y} r={hr * 1.2}
              fill="none" stroke={stroke} strokeWidth={sw * 0.5} opacity={0.6}
              strokeDasharray={isBase ? undefined : `${sw * 1.5},${sw * 1.5}`} />
          </g>
        );
      })()}

      {/* Polyline drawing overlay: placed vertices as dots, the live
          preview segment from last vertex → cursor, plus axis-aligned
          guidelines through any prior vertex the cursor lines up with.
          Snap halos on the cursor mirror ruler-mode styling so the
          gesture feels consistent. */}
      {addMode && (addMode.shape === 'polyline' || addMode.shape === 'polyshape') && polylineDraft && (() => {
        const verts = polylineDraft.vertices;
        const cur = polylineDraft.cursorPos;
        const isPolyshape = addMode.shape === 'polyshape';
        const widthExpr = addMode.width || `trace_w`;
        const widthVal = isPolyshape ? 0 : (evalExpr(widthExpr, paramValues) || screen(2));
        // Build the committed path: tessellated through any arc vertices
        // (so committed 90° arcs preview as true curves); then a preview
        // dashed segment from the last vertex to the cursor.
        const committedPts = draftPathPoints(verts);
        let pathD = '';
        for (let i = 0; i < committedPts.length; i++) {
          pathD += i === 0
            ? `M ${committedPts[i][0]} ${-committedPts[i][1]}`
            : ` L ${committedPts[i][0]} ${-committedPts[i][1]}`;
        }
        // Cursor preview geometry: in ARC mode, tessellate the would-be
        // 90° arc from the last vertex to the cursor (same synthArc90
        // the click handler will run) so the user sees the exact curve
        // before committing. Otherwise a straight segment. `cursorPts`
        // EXCLUDES the last committed vertex (it's the segment's start).
        let cursorPts = [];
        if (verts.length > 0 && cur) {
          const lastV = verts[verts.length - 1];
          let arcPrev = null;
          if (polylineDraft.arcNext) {
            const beforeV = verts.length >= 2 ? verts[verts.length - 2] : null;
            const prevDir = beforeV ? { x: lastV.x - beforeV.x, y: lastV.y - beforeV.y } : null;
            arcPrev = synthArc90(lastV, cur, prevDir);
          }
          cursorPts = arcPrev
            ? tessellateArcFrom(lastV.x, lastV.y, lastV.x + arcPrev.cdx, lastV.y + arcPrev.cdy, arcPrev.angle)
            : [[cur.x, cur.y]];
        }
        const cursorPreviewD = (verts.length > 0 && cursorPts.length > 0)
          ? `M ${verts[verts.length - 1].x} ${-verts[verts.length - 1].y}`
            + cursorPts.map(([px, py]) => ` L ${px} ${-py}`).join('')
          : '';
        // For polyshape: build the closed preview path including the
        // cursor as a "phantom last vertex" so the user sees the polygon
        // it would become if they finished now.
        let previewClosedD = '';
        if (isPolyshape && committedPts.length >= 1) {
          previewClosedD = pathD;
          for (const [px, py] of cursorPts) previewClosedD += ` L ${px} ${-py}`;
          if (verts.length >= 2) previewClosedD += ' Z';
        }
        return (
          <g pointerEvents="none">
            {/* For polyshape: fill the preview polygon with a translucent
                emerald wash so the user reads it as a closed 2-D region,
                not a trace. The fill includes the cursor as a phantom
                vertex so they can preview the polygon's full shape. */}
            {isPolyshape && previewClosedD && (
              <path d={previewClosedD} fill="#10b981" fillOpacity={0.18}
                stroke="#10b981" strokeWidth={screen(1)} strokeOpacity={0.7}
                strokeLinejoin="miter" strokeDasharray={`${screen(4)},${screen(2)}`} />
            )}
            {/* Committed segments — for polyline, stroked at the trace
                width with emerald color so the user can see the actual
                trace they're building. For polyshape we already filled
                above, so skip the wide stroke and just draw a thin
                solid outline along the committed segments. */}
            {pathD && !isPolyshape && (
              <path d={pathD} fill="none" stroke="#10b981" strokeWidth={widthVal}
                strokeOpacity={0.55} strokeLinejoin="miter" strokeLinecap="butt" />
            )}
            {isPolyshape && pathD && (
              <path d={pathD} fill="none" stroke="#10b981" strokeWidth={screen(1.2)}
                strokeOpacity={0.95} strokeLinejoin="miter" />
            )}
            {/* Vertex dots */}
            {verts.map((v, i) => (
              <g key={i}>
                <circle cx={v.x} cy={-v.y} r={screen(5)} fill="white" stroke="#059669" strokeWidth={screen(1.2)} />
                {v.snap && (
                  <circle cx={v.x} cy={-v.y} r={screen(9)} fill="none" stroke="#f59e0b" strokeWidth={screen(0.8)} opacity={0.7} />
                )}
              </g>
            ))}
            {/* Preview segment from last vertex to cursor — a straight
                line normally, or the tessellated 90° arc in ARC mode.
                For polyshape the closed-polygon fill above already shows
                the edges, so we skip this extra trace-style stroke. */}
            {!isPolyshape && cursorPreviewD && (
              <path
                d={cursorPreviewD}
                fill="none"
                stroke={polylineDraft.arcNext ? '#22d3ee' : '#10b981'}
                strokeWidth={widthVal} strokeOpacity={0.3}
                strokeLinecap="butt"
                strokeDasharray={`${screen(6)},${screen(4)}`}
              />
            )}
            {/* ARC-mode badge near the cursor so the modal state is
                visible right where the user is working. */}
            {polylineDraft.arcNext && cur && (
              <text
                x={cur.x + screen(12)} y={-cur.y - screen(12)}
                fontSize={screen(10)} fill="#22d3ee" fontFamily="monospace"
              >arc 90°</text>
            )}
            {/* Axis-aligned guideline through the cursor */}
            {polylineDraft.axisGuide && cur && (() => {
              const g = polylineDraft.axisGuide;
              if (g.axis === 'v') {
                // Vertical line through ref vertex.
                return (
                  <line
                    x1={g.refX} y1={-(g.refY - viewport.h * 2)}
                    x2={g.refX} y2={-(g.refY + viewport.h * 2)}
                    stroke="#a855f7" strokeWidth={screen(0.6)} opacity={0.6}
                    strokeDasharray={`${screen(4)},${screen(4)}`}
                  />
                );
              }
              return (
                <line
                  x1={g.refX - viewport.w * 2} y1={-g.refY}
                  x2={g.refX + viewport.w * 2} y2={-g.refY}
                  stroke="#a855f7" strokeWidth={screen(0.6)} opacity={0.6}
                  strokeDasharray={`${screen(4)},${screen(4)}`}
                />
              );
            })()}
            {/* Snap halo on cursor (anchor-style) when hovering a target.
                Base-instance snaps install a parametric binding on click
                → amber halo. NON-base-instance snaps (repeats / mirrors /
                boolean operand cells) snap the cursor visually only —
                cyan halo with a dashed outer ring signals "no parametric
                tie to that specific instance, just a free position." */}
            {polylineDraft.cursorSnap && cur && (() => {
              const isBase = (polylineDraft.cursorSnap.instanceIdx ?? 0) === 0;
              if (isBase) {
                return (
                  <g>
                    <circle cx={cur.x} cy={-cur.y} r={screen(14)} fill="none" stroke="#f59e0b" strokeWidth={screen(0.5)} opacity={0.3} />
                    <circle cx={cur.x} cy={-cur.y} r={screen(9)} fill="none" stroke="#f59e0b" strokeWidth={screen(0.9)} opacity={0.7} />
                    <circle cx={cur.x} cy={-cur.y} r={screen(3.5)} fill="#fbbf24" stroke="#f59e0b" strokeWidth={screen(0.6)} />
                  </g>
                );
              }
              return (
                <g>
                  <circle cx={cur.x} cy={-cur.y} r={screen(14)} fill="none" stroke="#06b6d4" strokeWidth={screen(0.5)} opacity={0.3} />
                  <circle cx={cur.x} cy={-cur.y} r={screen(9)} fill="none" stroke="#06b6d4" strokeWidth={screen(0.9)} opacity={0.7}
                    strokeDasharray={`${screen(2)},${screen(2)}`} />
                  <circle cx={cur.x} cy={-cur.y} r={screen(3.5)} fill="#67e8f9" stroke="#0891b2" strokeWidth={screen(0.6)} />
                </g>
              );
            })()}
          </g>
        );
      })()}

      {/* Alt-drag snap-target look-ahead. While the user is dragging
          with Option/Alt held, surface every NEARBY shape's snap
          candidates (top / bottom / mid-y / left / right / mid-x) as
          faint dashed guidelines so you can see what you'd snap to
          before committing to a position. Center lines use a finer dot
          pattern to distinguish them from the edge lines. Suppressed
          for shapes far from the dragged cluster (more than a handful
          of snap thresholds away) so the canvas doesn't fill with
          irrelevant ghost-lines on a busy scene. */}
      {drag && drag.kind === 'move' && altKey && (() => {
        const screenThresh = 30;
        const worldThresh = screenThresh * (viewport.w / (svgRef.current?.clientWidth || 1));
        const proximity = worldThresh * 6;
        const dragId = drag.clickedId || drag.rootId;
        const dragged = solved.find((c) => c.id === dragId);
        if (!dragged) return null;
        const dw = (drag.clusterBboxW && drag.clusterBboxW > 0) ? drag.clusterBboxW
          : dimsByCompId[dragged.id].w; // [F2]
        const dh = (drag.clusterBboxH && drag.clusterBboxH > 0) ? drag.clusterBboxH
          : dimsByCompId[dragged.id].h; // [F2]
        if (!Number.isFinite(dw) || !Number.isFinite(dh)) return null;
        const dxMin = dragged.cx - dw / 2, dxMax = dragged.cx + dw / 2;
        const dyMin = dragged.cy - dh / 2, dyMax = dragged.cy + dh / 2;
        const guides = [];
        for (const oc of solved) {
          if (oc.id === dragId) continue;
          if (drag.clusterSet && drag.clusterSet.has(oc.id)) continue;
          if (oc.consumedBy) continue;
          const { w: ow, h: oh } = dimsByCompId[oc.id]; // [F2]
          if (!Number.isFinite(ow) || !Number.isFinite(oh) || ow <= 0 || oh <= 0) continue;
          const oxMin = oc.cx - ow / 2, oxMax = oc.cx + ow / 2;
          const oyMin = oc.cy - oh / 2, oyMax = oc.cy + oh / 2;
          // Min bbox-to-bbox distance.
          const xGap = Math.max(0, Math.max(dxMin - oxMax, oxMin - dxMax));
          const yGap = Math.max(0, Math.max(dyMin - oyMax, oyMin - dyMax));
          if (Math.hypot(xGap, yGap) > proximity) continue;
          // Extension so the lines visibly run past the shape's bbox.
          const ext = Math.max(ow, oh) * 0.2;
          const xL = oxMin - ext, xR = oxMax + ext;
          const wYmin = oyMin - ext, wYmax = oyMax + ext;
          // Edge lines: medium dashes. Center lines: fine dots so they
          // read as a different kind of constraint at a glance.
          const edgeDash  = `${sw * 1.4},${sw * 1.0}`;
          const ctrDash   = `${sw * 0.35},${sw * 1.1}`;
          const stroke    = '#67e8f9';
          const strokeW   = sw * 0.4;
          const baseOp    = 0.32;
          // Horizontal candidates: top, bottom, center-y.
          for (const [y, isCenter] of [[oyMax, false], [oyMin, false], [oc.cy, true]]) {
            guides.push(
              <line
                key={`${oc.id}-h-${y}-${isCenter}`}
                x1={xL} y1={-y} x2={xR} y2={-y}
                stroke={stroke} strokeWidth={strokeW}
                strokeDasharray={isCenter ? ctrDash : edgeDash}
                opacity={baseOp}
              />
            );
          }
          // Vertical candidates: left, right, center-x.
          for (const [x, isCenter] of [[oxMax, false], [oxMin, false], [oc.cx, true]]) {
            guides.push(
              <line
                key={`${oc.id}-v-${x}-${isCenter}`}
                x1={x} y1={-wYmax} x2={x} y2={-wYmin}
                stroke={stroke} strokeWidth={strokeW}
                strokeDasharray={isCenter ? ctrDash : edgeDash}
                opacity={baseOp}
              />
            );
          }
        }
        return <g pointerEvents="none">{guides}</g>;
      })()}

      {/* Alt-drag snap-target indicator. While the user drags a component
          with Option/Alt held and the cursor is near a target anchor on a
          different component, surface that anchor so the user can see what
          they're about to snap to. On release, a snap is installed (see
          onMouseUp). */}
      {drag && drag.kind === 'move' && moveSnapHover && (
        <g pointerEvents="none">
          {/* Anchor snap: a small target reticle on the chosen anchor. */}
          {moveSnapHover.kind === 'anchor' && (
            <>
              <circle cx={moveSnapHover.x} cy={-moveSnapHover.y} r={hr * 0.7}
                fill="#67e8f9" stroke="#0891b2" strokeWidth={sw * 0.6} />
              <circle cx={moveSnapHover.x} cy={-moveSnapHover.y} r={hr * 1.4}
                fill="none" stroke="#0891b2" strokeWidth={sw * 0.5} opacity={0.6} />
            </>
          )}
          {/* Edge snap: extend a guide line along the aligned edge across
              the union of the two bboxes, plus a thinner indicator at the
              midpoint of the overlap so the user can see which two edges
              are being matched. */}
          {moveSnapHover.kind === 'edge' && (() => {
            const tc = solved.find(c => c.id === moveSnapHover.targetCompId);
            if (!tc) return null;
            const { w: tw, h: th } = dimsByCompId[tc.id]; // [F2]
            if (!Number.isFinite(tw) || !Number.isFinite(th)) return null;
            const tx0 = tc.cx - tw / 2, tx1 = tc.cx + tw / 2;
            const ty0 = tc.cy - th / 2, ty1 = tc.cy + th / 2;
            // Recompute the dragged cluster bbox at its CURRENT (post-snap) position by
            // using drag.startCx/Cy + the current effective offset. Easier: the
            // moveSnapHover.x/y is already the overlap midpoint, but we need
            // the union of x-ranges (or y-ranges) for the guide. The drag's
            // co-mover startCx/Cy plus the latest translation gives us that;
            // approximate via the SOLVED bbox of the cluster's clickedId.
            const dragId = drag.clickedId || drag.rootId;
            const dc = solved.find(c => c.id === dragId);
            if (!dc) return null;
            const { w: dw2, h: dh2 } = dimsByCompId[dc.id]; // [F2]
            const dx0 = dc.cx - dw2 / 2, dx1 = dc.cx + dw2 / 2;
            const dy0 = dc.cy - dh2 / 2, dy1 = dc.cy + dh2 / 2;
            const stroke = '#67e8f9';
            if (moveSnapHover.axis === 'h') {
              const x1 = Math.min(tx0, dx0), x2 = Math.max(tx1, dx1);
              const y = moveSnapHover.edgeVal;
              return (
                <>
                  <line x1={x1} y1={-y} x2={x2} y2={-y}
                    stroke={stroke} strokeWidth={sw * 0.7} strokeDasharray={`${sw * 2},${sw * 1.4}`} opacity={0.85} />
                  <circle cx={moveSnapHover.x} cy={-moveSnapHover.y} r={hr * 0.5}
                    fill={stroke} stroke="#0891b2" strokeWidth={sw * 0.5} />
                </>
              );
            }
            const y1 = Math.min(ty0, dy0), y2 = Math.max(ty1, dy1);
            const x = moveSnapHover.edgeVal;
            return (
              <>
                <line x1={x} y1={-y1} x2={x} y2={-y2}
                  stroke={stroke} strokeWidth={sw * 0.7} strokeDasharray={`${sw * 2},${sw * 1.4}`} opacity={0.85} />
                <circle cx={moveSnapHover.x} cy={-moveSnapHover.y} r={hr * 0.5}
                  fill={stroke} stroke="#0891b2" strokeWidth={sw * 0.5} />
              </>
            );
          })()}
        </g>
      )}

      {/* C5: smart alignment guides during a PLAIN move-drag. Full-viewport
          1px magenta lines through every aligned coordinate (Figma-style).
          The drag position is already magnetically snapped to these in
          onMouseMove; the lines just SHOW the alignment. No scene snaps are
          created — the status bar points at Alt-drag for that. */}
      {drag && drag.kind === 'move' && alignGuides && (
        <g pointerEvents="none">
          {(alignGuides.x || []).map((g, i) => (
            <line
              key={`agx-${i}`}
              x1={g.val} y1={vbY} x2={g.val} y2={vbY + viewport.h}
              stroke="#ff00ff" strokeWidth={screen(1)} opacity={0.85}
            />
          ))}
          {(alignGuides.y || []).map((g, i) => (
            <line
              key={`agy-${i}`}
              x1={vbX} y1={-g.val} x2={vbX + viewport.w} y2={-g.val}
              stroke="#ff00ff" strokeWidth={screen(1)} opacity={0.85}
            />
          ))}
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
        // Pick fill colour from the addMode bound layer first (so a
        // conductor with a custom color in the stack editor previews
        // in that color, not the default gold), then fall back to the
        // role-based default.
        const layer = addMode.layer || addMode.kind || 'waveguide';
        const previewBound = layer === 'electrode' && addMode.conductorLayerId
          ? layerById[addMode.conductorLayerId]
          : (layer === 'waveguide'
              ? (scene.stack || []).find(l => l.role === 'waveguide')
              : null);
        const defaultFill = layer === 'waveguide' ? '#3ec27a'
          : layer === 'port' ? '#b91c1c'
          : '#f4a72e';
        const defaultStroke = layer === 'waveguide' ? '#1a5e36'
          : layer === 'port' ? '#7f1d1d'
          : '#7a4d00';
        const previewFill = (previewBound?.color) || defaultFill;
        const previewStroke = (previewBound?.color && darkenHex(previewBound.color)) || defaultStroke;
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
              if (shape === 'via') {
                // Via is click-to-place with a fixed default radius — the
                // preview shows the default-size annulus at the cursor.
                const rp = 2;
                return (
                  <g>
                    <circle cx={cxP} cy={-cyP} r={rp} {...previewProps} />
                    <circle cx={cxP} cy={-cyP} r={rp * 0.35} fill={previewStroke} fillOpacity={0.6} />
                  </g>
                );
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

      {/* Ruler tool: committed measurements. The line + endpoints are
          visual only (pointer-events="none" so they don't interfere
          with selecting components underneath). A small × button on
          the right side of the readout deletes that one measurement;
          the toolbar's "clear (N)" button still clears them all in
          bulk. */}
      {/* Ruler measurements + dimensions use screen-pixel sizing for
          line widths, dot radii, font, and the padding around the
          readout box so the on-canvas overlay stays roughly the same
          size in actual pixels regardless of zoom. World-unit sizing
          would let labels balloon at high zoom and disappear at low. */}
      {rulerMeasurements.map(m => {
        const dx = m.p2.x - m.p1.x;
        const dy = m.p2.y - m.p1.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const mx = (m.p1.x + m.p2.x) / 2;
        const my = (m.p1.y + m.p2.y) / 2;
        // Screen-stable sizing
        const lineW = screen(1.4);              // ~1.4 px line
        const dotR = screen(2.5);               // ~2.5 px endpoint dot
        const dotStrokeW = screen(0.5);
        const fontDist = screen(11);            // distance label (px)
        const fontDelta = screen(9);            // delta-x / delta-y label (px)
        // The label backgrounds were previously fixed-width pills that
        // truncated the text at higher numeric values (e.g. "1234.56um"
        // or "Δx=123.4 Δy=567.8") because they hardcoded screen(46) /
        // screen(60). Compute the width from the actual text length so
        // both rects always wrap the label. The 0.62 multiplier is a
        // safe approximation of monospace char width as a fraction of
        // font size; we add screen(10) of horizontal padding (~5 px
        // each side). Δ measures ≈ ASCII width in most monospace fonts
        // we render against (JetBrains Mono / Menlo / etc.), so 0.62
        // works for both rows.
        const distText = `${dist.toFixed(2)}um`;
        const deltaText = `Δx=${dx.toFixed(2)} Δy=${dy.toFixed(2)}`;
        const padX1 = distText.length * fontDist * 0.62 + screen(10);
        const padX2 = deltaText.length * fontDelta * 0.62 + screen(10);
        const padY1 = screen(14);
        const padY2 = screen(13);
        // The X (delete) button now sits just outside the wider of the
        // two label rects so it never overlaps the readout.
        const halfBoxW = Math.max(padX1, padX2) / 2;
        const xBtnX = mx + halfBoxW + screen(6);
        const xBtnY = -my - screen(11);
        return (
          <g key={m.id}>
            <g pointerEvents="none">
              <line
                x1={m.p1.x} y1={-m.p1.y} x2={m.p2.x} y2={-m.p2.y}
                stroke="#22d3ee" strokeWidth={lineW} opacity={0.95}
              />
              <circle cx={m.p1.x} cy={-m.p1.y} r={dotR} fill="#22d3ee" stroke="white" strokeWidth={dotStrokeW} />
              <circle cx={m.p2.x} cy={-m.p2.y} r={dotR} fill="#22d3ee" stroke="white" strokeWidth={dotStrokeW} />
              {dist > 0.01 && (
                <g>
                  <rect x={mx - padX1 / 2} y={-my - padY1 - screen(2)} width={padX1} height={padY1} fill="rgba(15,23,42,0.9)" rx={screen(2)} />
                  <text x={mx} y={-my - screen(5)} fontSize={fontDist} fontFamily="monospace" fill="#67e8f9" textAnchor="middle">
                    {`${dist.toFixed(2)}um`}
                  </text>
                  <rect x={mx - padX2 / 2} y={-my - screen(2)} width={padX2} height={padY2} fill="rgba(15,23,42,0.85)" rx={screen(2)} />
                  <text x={mx} y={-my + screen(7)} fontSize={fontDelta} fontFamily="monospace" fill="#94a3b8" textAnchor="middle">
                    {`Δx=${dx.toFixed(2)} Δy=${dy.toFixed(2)}`}
                  </text>
                </g>
              )}
            </g>
            {/* Delete affordance — its own clickable group sitting on top of
                the readout's right edge. cursor:pointer to telegraph it. */}
            {dist > 0.01 && (
              <g
                onMouseDown={(e) => { e.stopPropagation(); }}
                onClick={(e) => { e.stopPropagation(); deleteRuler(m.id); }}
                style={{ cursor: 'pointer' }}
              >
                <circle cx={xBtnX} cy={xBtnY} r={screen(6)} fill="#0f172a" stroke="#475569" strokeWidth={screen(0.6)} />
                <text
                  x={xBtnX} y={xBtnY + screen(3)}
                  fontSize={screen(9)} fontFamily="monospace" fill="#cbd5e1"
                  textAnchor="middle" pointerEvents="none"
                >×</text>
                <title>Remove this measurement</title>
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
        const previewLineW = screen(1.4);
        const previewDotR = screen(2.5);
        return (
          <g pointerEvents="none">
            <line
              x1={p1.x} y1={-p1.y} x2={p2.x} y2={-p2.y}
              stroke="#22d3ee"
              strokeWidth={previewLineW}
              strokeDasharray={shiftKey ? '0' : `${screen(5)},${screen(3)}`}
              opacity={0.85}
            />
            <circle cx={p1.x} cy={-p1.y} r={previewDotR} fill="#22d3ee" stroke="white" strokeWidth={screen(0.5)} />
            <circle cx={p2.x} cy={-p2.y} r={previewDotR} fill="#22d3ee" stroke="white" strokeWidth={screen(0.5)} />
            {/* Δx/Δy/dist are shown in the bottom status bar to keep the canvas clear. */}
          </g>
        );
      })()}

      {/* Ruler tool: hover snap-target indicator. Sized in SCREEN pixels
          so the hover dot stays prominently visible at every zoom level
          (it's the user's primary cue that "you're about to snap to
          THIS point" — too small was hard to find at high zoom). */}
      {rulerMode && rulerSnapPoint && rulerSnapPoint.label && (
        <g pointerEvents="none">
          {/* Soft outer halo: large, low-opacity, for "look here" pop. */}
          <circle
            cx={rulerSnapPoint.x} cy={-rulerSnapPoint.y} r={screen(14)}
            fill="#22d3ee" opacity={0.18}
          />
          {/* Ring */}
          <circle
            cx={rulerSnapPoint.x} cy={-rulerSnapPoint.y} r={screen(9)}
            fill="none" stroke="#22d3ee" strokeWidth={screen(1.6)}
            opacity={0.95}
          />
          {/* Solid inner dot. */}
          <circle
            cx={rulerSnapPoint.x} cy={-rulerSnapPoint.y} r={screen(3.5)}
            fill="#22d3ee" stroke="white" strokeWidth={screen(0.6)}
          />
        </g>
      )}

      {/* C3: on-canvas vertex-edit handles for the PRIMARY-selected
          polyline / polyshape (hidden while any draw / ruler / snap tool is
          active). One square handle per vertex spec (resolvePolylineVertices
          — index-stable): white squares with an emerald border, visually
          distinct from the sky-blue resize handles. Snap-bound vertices get
          an amber ring, arc vertices a cyan ring — both are NOT draggable
          (not-allowed cursor; a drag attempt explains why in the status
          bar), same for expression-driven rel vertices. Handles render on
          top of the shapes and stop mousedown propagation so they never
          fight the component-drag hit area. Alt+click deletes a vertex;
          double-click on a segment (handled on the SVG) inserts one. */}
      {!addMode && !rulerMode && snapMode !== 'creating' && (() => {
        const cSel = solved.find(cc => cc.id === selectedId);
        if (!cSel || (cSel.kind !== 'polyline' && cSel.kind !== 'polyshape')) return null;
        const cEff = (vertexDrag && vertexDrag.compId === cSel.id && vertexDrag.preview)
          ? { ...cSel, vertices: vertexDrag.preview } : cSel;
        const verts = resolvePolylineVertices(cEff, sceneCompById, paramValues, transformInstances);
        const specs = cEff.vertices || [];
        const hs = screen(4); // half-size of the square handle (~8 px)
        return (
          <g key={`vtx-handles-${cSel.id}`}>
            {verts.map(([vx, vy], i) => {
              if (!Number.isFinite(vx) || !Number.isFinite(vy)) return null;
              const spec = specs[i];
              const block = vertexDragBlock(spec);
              const isDragging = vertexDrag && vertexDrag.compId === cSel.id && vertexDrag.idx === i;
              const ringColor = spec?.kind === 'snap' ? '#f59e0b'
                : spec?.kind === 'arc' ? '#22d3ee'
                : null;
              return (
                <g key={`vh-${i}`}>
                  {ringColor && (
                    <circle
                      cx={vx} cy={-vy} r={hs * 2}
                      fill="none" stroke={ringColor} strokeWidth={screen(1.2)}
                      opacity={0.85} pointerEvents="none"
                    />
                  )}
                  <rect
                    x={vx - hs} y={-vy - hs} width={hs * 2} height={hs * 2}
                    fill={isDragging ? '#d1fae5' : 'white'}
                    stroke="#059669" strokeWidth={screen(1.2)}
                    style={{ cursor: block ? 'not-allowed' : 'move' }}
                    onMouseDown={(e) => onVertexHandleMouseDown(e, cSel.id, i)}
                  >
                    <title>
                      {block
                        ? block
                        : `vertex ${i} — drag to move · Alt+click to delete`}
                    </title>
                  </rect>
                </g>
              );
            })}
          </g>
        );
      })()}

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

      {/* Persistent snap-link dashed lines connecting every snapped pair.
          Part of the snap-network overlay — gated on showGrid alongside
          the grid pattern, origin axes, parent/child/mirror outline
          highlights, and snap direction arrows. */}
      {showGrid && scene.snaps.map(s => {
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

      {/* C10: flash-anchor halo. When the parent bumps flashAnchor.nonce,
          a 3-pulse animated ring draws attention to that component's anchor
          for ~1.5 s. Rotation-aware via anchorWorld (first-class rotation
          rotates the anchor offset with the shape); boolean targets resolve
          through the SOLVED instance, whose bbox resolveBooleanBboxes /
          displayBbox already refreshed. keyed on the nonce so the SMIL
          animation restarts on every bump. */}
      {flashVisible && flashAnchor && flashAnchor.compId && (() => {
        const comp = solved.find(cc => cc.id === flashAnchor.compId);
        if (!comp) return null;
        const p = anchorWorld(comp, flashAnchor.anchor || 'C', paramValues);
        if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
        return (
          <g key={`flash-${flashAnchor.nonce ?? 0}`} pointerEvents="none">
            <circle cx={p.x} cy={-p.y} r={hr * 0.8} fill="#f59e0b" stroke="white" strokeWidth={sw * 0.6}>
              <animate attributeName="opacity" values="1;1;0.25" dur="0.5s" repeatCount="3" />
            </circle>
            <circle cx={p.x} cy={-p.y} r={hr} fill="none" stroke="#f59e0b" strokeWidth={sw * 1.4}>
              <animate attributeName="r" values={`${hr};${hr * 4}`} dur="0.5s" repeatCount="3" />
              <animate attributeName="opacity" values="0.9;0" dur="0.5s" repeatCount="3" />
            </circle>
            <circle cx={p.x} cy={-p.y} r={hr} fill="none" stroke="#fbbf24" strokeWidth={sw * 0.8}>
              <animate attributeName="r" values={`${hr * 1.6};${hr * 5.5}`} dur="0.5s" repeatCount="3" />
              <animate attributeName="opacity" values="0.6;0" dur="0.5s" repeatCount="3" />
            </circle>
          </g>
        );
      })()}
    </svg>
  );
}
