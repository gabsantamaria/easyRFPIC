// Polyline component geometry: vertex resolution + bbox computation.
//
// Polyline scene shape:
//   {
//     id, kind: 'polyline', layer,
//     cx, cy,                 // position of vertex 0 (the polyline's anchor)
//     width: 'trace_w',       // parametric trace width (perpendicular to path)
//     conductorLayerId,       // conductor whose mid-Z the trace sits at
//     vertices: [             // vertex 1 .. vertex N; vertex 0 is implicit (cx, cy)
//       { kind: 'rel', dx, dy },              // relative to previous vertex
//       { kind: 'rel', dx, dy, spline: true },// spline-flagged rel vertex (see below)
//       { kind: 'rel', dx, dy, width: 'w1' }, // per-vertex taper width (polyline only)
//       { kind: 'snap', compId, anchor },     // pinned to another component's anchor
//       { kind: 'arc', cdx, cdy, angle },     // circular arc (see below)
//       ...
//     ],
//     closed: false,          // optional ring closure (last vertex connects to first)
//   }
//
// Vertex kinds:
//   - 'rel': parametric dx, dy from the PREVIOUS resolved vertex. This is the
//            default mode — every step the user clicks gets stored as a dx/dy
//            from the previous click.
//   - 'snap': hard-bound to another component's anchor. The vertex's world
//             position parametrically tracks that anchor — sweeping anything in
//             the target component's chain moves this vertex with it.
//   - 'arc': circular arc starting at the PREVIOUS resolved vertex. cdx/cdy
//            are parametric offsets from that previous vertex to the arc
//            CENTER; `angle` is the sweep in DEGREES (CCW positive, CW
//            negative). The vertex's resolved position is the arc ENDPOINT
//            (previous vertex rotated about the center by `angle`). Maps
//            1:1 to an HFSS CreatePolyline AngularArc segment, which takes
//            ArcCenterX/Y/Z expressions and an ArcAngle expression — fully
//            parametric on both sides.
//   - spline flag: a `rel` vertex with `spline: true`. Consecutive
//            spline-flagged rel vertices (plus the anchor vertex right
//            before the run) form ONE HFSS Spline segment. The canvas /
//            GDS tessellation interpolates the run with a Catmull-Rom
//            curve through the resolved points — an APPROXIMATION of the
//            NURBS spline HFSS fits through the same points (HFSS is the
//            geometric source of truth; the canvas preview can deviate
//            slightly between control points).
//   - width (taper, polyline only): any vertex may carry a `width`
//            expression. If ANY vertex does, the polyline is TAPERED: the
//            effective width at vertex i is its own width expr if set,
//            else the component's base `width`, and the band width varies
//            linearly along each LINE segment. Tapered bands render and
//            export as per-segment quads with BUTT joins (matching the
//            per-segment parametric sheets the HFSS export builds). Arc /
//            spline segments inside a tapered polyline fall back to the
//            constant base width (v1 restriction, enforced in the UI).
//
// All representations preserve parametric dependencies end-to-end: HFSS-side
// sweeps of any variable involved in dx/dy/cdx/cdy/angle/width expressions OR
// the target component's chain move the polyline's vertices in lockstep.

import { evalExpr } from '../scene/params.js';
import { anchorLocalRotated, parseAnchor, compRotationDeg } from '../scene/anchors.js';
import { resolveInstanceAnchorNumeric } from '../scene/instance-positions.js';

// Compute the world (x, y) position of a target component's anchor — used to
// resolve `snap` vertices. Works for primitive shapes (uses bbox w/h). For
// boolean targets the caller should pass the SOLVED component (with its
// refreshed AABB) so c.w/c.h are numeric. Targets carrying a first-class
// `rotation` get the anchor offset rotated to track the visible shape.
export function anchorWorldNumeric(targetComp, anchorName, paramValues) {
  if (!targetComp) return null;
  // PATH-KIND frame: a polyline/polyshape target's cx/cy is its vertex-
  // chain root (vertex 0), not the bbox center — anchor on the solver-
  // refreshed displayBbox so a vertex pinned to a trace's anchor lands
  // where the snap dots / anchorWorld put it. GATED to path kinds:
  // transformed BOOLEANS also carry a displayBbox (post-transform
  // footprint, written only by resolveBooleanBboxes callers), and letting
  // it win here made vertex resolution depend on WHICH pipeline built the
  // component map (scene3d/cross-section vs GDS/HFSS/pyAEDT) — booleans
  // keep the historical pre-transform cx ± w/2 frame.
  if ((targetComp.kind === 'polyline' || targetComp.kind === 'polyshape') && targetComp.displayBbox) {
    const bb = targetComp.displayBbox;
    const local = anchorLocalRotated(anchorName, bb.w, bb.h, 0);
    return { x: bb.cx + local.x, y: bb.cy + local.y };
  }
  const w = typeof targetComp.w === 'number' ? targetComp.w : evalExpr(targetComp.w, paramValues);
  const h = typeof targetComp.h === 'number' ? targetComp.h : evalExpr(targetComp.h, paramValues);
  if (!Number.isFinite(w) || !Number.isFinite(h)) return null;
  const local = anchorLocalRotated(anchorName, w, h, compRotationDeg(targetComp, paramValues));
  return { x: targetComp.cx + local.x, y: targetComp.cy + local.y };
}

// ── Arc helpers ────────────────────────────────────────────────────────
// Number of tessellation segments for an arc of |angle| degrees. Scales
// with sweep so a full circle gets 64 segments (matching the circle/
// ellipse CIRCLE_TESSELATION in rings.js) with a floor of 8 so short
// arcs stay visually round.
export function arcSegCount(angleDeg) {
  const a = Math.abs(Number.isFinite(angleDeg) ? angleDeg : 0);
  return Math.max(8, Math.ceil((a / 360) * 64));
}

// Rotate point p about center c by `angleDeg` degrees CCW.
function rotateAbout(px, py, cx, cy, angleDeg) {
  const rad = angleDeg * Math.PI / 180;
  const ca = Math.cos(rad), sa = Math.sin(rad);
  const dx = px - cx, dy = py - cy;
  return [cx + dx * ca - dy * sa, cy + dx * sa + dy * ca];
}

// Resolve an arc vertex's endpoint from the previous resolved point.
// center = prev + (cdx, cdy); endpoint = prev rotated about center by
// `angle` degrees (CCW positive).
export function arcEndpoint(prevX, prevY, cdx, cdy, angleDeg) {
  const cx = prevX + cdx, cy = prevY + cdy;
  return rotateAbout(prevX, prevY, cx, cy, angleDeg);
}

// Synthesize a 90° circular arc from S to E ({x, y} points) for the
// draw-UX arc mode and the inspector's line→arc converter. The center
// sits on the perpendicular bisector of chord SE at distance |SE|/2
// from the midpoint — the unique geometry where the sweep between S
// and E is exactly 90°. Two candidates exist (one per side of the
// chord), pairing with a +90° (CCW) or −90° (CW) sweep respectively.
// We pick the side whose INITIAL TANGENT at S best aligns with
// `prevDir` (the direction of the segment INTO S), so the arc
// continues the path's current heading instead of doubling back. With
// no usable prevDir the +90° CCW side wins (arbitrary but stable).
// Returns { cdx, cdy, angle } — numeric center offset from S plus the
// signed sweep — or null for a degenerate (zero-length) chord.
export function synthArc90(S, E, prevDir = null) {
  const dx = E.x - S.x, dy = E.y - S.y;
  const len = Math.hypot(dx, dy);
  if (!(len > 1e-9)) return null;
  const ux = dx / len, uy = dy / len;
  const nx = -uy, ny = ux; // CCW perpendicular of the chord direction
  const mx = (S.x + E.x) / 2, my = (S.y + E.y) / 2;
  const d = len / 2;
  const cand = [
    { cx: mx + d * nx, cy: my + d * ny, angle: 90 },
    { cx: mx - d * nx, cy: my - d * ny, angle: -90 },
  ];
  let pick = cand[0];
  if (prevDir && (Math.abs(prevDir.x) > 1e-12 || Math.abs(prevDir.y) > 1e-12)) {
    let best = -Infinity;
    for (const cd of cand) {
      // Velocity at S for a sweep of sign(angle) about C is
      // sign(angle) × rot90CCW(S − C).
      const rx = S.x - cd.cx, ry = S.y - cd.cy;
      const sgn = cd.angle > 0 ? 1 : -1;
      const tx = sgn * -ry, ty = sgn * rx;
      const dot = tx * prevDir.x + ty * prevDir.y;
      if (dot > best) { best = dot; pick = cd; }
    }
  }
  return { cdx: pick.cx - S.x, cdy: pick.cy - S.y, angle: pick.angle };
}

// Resolve all vertex world positions for a polyline. Returns
// [[x0, y0], [x1, y1], ...] with length = vertices.length.
//
// `c.vertices` includes EVERY vertex (including vertex 0). For a fresh
// polyline the first entry is conventionally `{ kind: 'rel', dx: '0',
// dy: '0' }`, which puts vertex 0 at (c.cx, c.cy) — the polyline's
// drag-handle origin. If the user later pins vertex 0 to another
// component, the first entry becomes `{ kind: 'snap', compId, anchor }`
// and c.cx/c.cy is ignored for vertex 0.
//
// For a `rel` vertex, the "previous" reference is:
//   - For vertex 0: the component's own (cx, cy)
//   - For vertex i ≥ 1: vertex (i-1)'s resolved world position
export function resolvePolylineVertices(c, byId, paramValues, transformInstances = null) {
  const verts = [];
  const baseCx = Number.isFinite(c.cx) ? c.cx : 0;
  const baseCy = Number.isFinite(c.cy) ? c.cy : 0;
  const vertSpecs = c.vertices || [];
  for (let i = 0; i < vertSpecs.length; i++) {
    const v = vertSpecs[i];
    if (v && v.kind === 'snap' && v.compId && v.anchor) {
      // Two flavors of snap target:
      //   - instanceIdx absent (or 0): bind to the base component's
      //     anchor (the standard case before transform-replica snap
      //     was added).
      //   - instanceIdx > 0: bind to the Nth instance of either the
      //     component's own transform chain OR (if the component is
      //     a boolean operand) its parent boolean's chain. Resolved
      //     numerically here via `transformInstances`; the HFSS
      //     export emits the matching parametric expression so the
      //     vertex follows under HFSS-side sweeps.
      const idx = v.instanceIdx || 0;
      let wp = null;
      if (idx > 0 && transformInstances) {
        wp = resolveInstanceAnchorNumeric(v.compId, v.anchor, idx, byId, transformInstances, paramValues);
      }
      if (!wp) {
        const target = byId[v.compId];
        wp = anchorWorldNumeric(target, v.anchor, paramValues);
      }
      if (wp) verts.push([wp.x, wp.y]);
      else verts.push([NaN, NaN]);
    } else if (v && v.kind === 'arc') {
      // Arc vertex: resolved position is the arc ENDPOINT — the previous
      // vertex rotated about (prev + cdx, prev + cdy) by `angle` degrees
      // CCW. Returning ONE point per vertex spec keeps vertex indexing
      // (inspector rows, handle math) stable; consumers that want the
      // drawn curve use tessellatePolylinePath below.
      const [px, py] = i === 0 ? [baseCx, baseCy] : verts[i - 1];
      const cdx = evalExpr(v.cdx ?? '0', paramValues);
      const cdy = evalExpr(v.cdy ?? '0', paramValues);
      const ang = evalExpr(v.angle ?? '0', paramValues);
      if (Number.isFinite(px) && Number.isFinite(py)
          && Number.isFinite(cdx) && Number.isFinite(cdy) && Number.isFinite(ang)) {
        verts.push(arcEndpoint(px, py, cdx, cdy, ang));
      } else {
        verts.push([NaN, NaN]);
      }
    } else {
      const dx = evalExpr(v?.dx ?? '0', paramValues);
      const dy = evalExpr(v?.dy ?? '0', paramValues);
      if (i === 0) {
        // Vertex 0 in rel mode: offset from the component's own (cx, cy).
        verts.push([
          baseCx + (Number.isFinite(dx) ? dx : 0),
          baseCy + (Number.isFinite(dy) ? dy : 0),
        ]);
      } else {
        const [px, py] = verts[i - 1];
        verts.push([
          px + (Number.isFinite(dx) ? dx : 0),
          py + (Number.isFinite(dy) ? dy : 0),
        ]);
      }
    }
  }
  // Empty vertex list still yields a sane "single point" so downstream
  // code doesn't crash; we just place a vertex at the component anchor.
  if (verts.length === 0) verts.push([baseCx, baseCy]);
  return verts;
}

// ── Catmull-Rom spline tessellation ────────────────────────────────────
// Interpolate a Catmull-Rom curve through `pts` (>= 2 control points),
// `segsPerSpan` sub-segments per control-point span. End tangents use
// duplicated end points (the standard "clamped" Catmull-Rom). Returns
// the tessellated point list INCLUDING the first and last control point.
//
// NOTE (geometric compatibility): HFSS's Spline polyline segment fits a
// NURBS through the same control points — Catmull-Rom is a close visual
// approximation but NOT bit-identical between control points. HFSS is
// the source of truth; the deviation is bounded by the span sag and
// shrinks as control points densify. Flagged in the HFSS export's
// PARAMETRIC-SWEEP SAFETY REPORT notes.
export function catmullRomTessellate(pts, segsPerSpan = 8) {
  if (!pts || pts.length < 2) return (pts || []).slice();
  const out = [pts[0].slice()];
  const get = (i) => pts[Math.max(0, Math.min(pts.length - 1, i))];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = get(i - 1), p1 = get(i), p2 = get(i + 1), p3 = get(i + 2);
    for (let k = 1; k <= segsPerSpan; k++) {
      const t = k / segsPerSpan;
      const t2 = t * t, t3 = t2 * t;
      const x = 0.5 * ((2 * p1[0]) + (-p0[0] + p2[0]) * t
        + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2
        + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3);
      const y = 0.5 * ((2 * p1[1]) + (-p0[1] + p2[1]) * t
        + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2
        + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3);
      out.push([x, y]);
    }
  }
  return out;
}

// Tessellate an arc from (px, py) about center (cx, cy) sweeping
// `angleDeg` CCW. Returns intermediate + END points (start EXCLUDED so
// runs can be concatenated). Exported for the canvas draw-UX arc
// preview and the exporters' tapered-curve fallback.
export function tessellateArcFrom(px, py, cx, cy, angleDeg) {
  const n = arcSegCount(angleDeg);
  const out = [];
  for (let k = 1; k <= n; k++) {
    out.push(rotateAbout(px, py, cx, cy, (angleDeg * k) / n));
  }
  return out;
}

// Full tessellated point list for a polyline / polyshape: line vertices
// pass through 1:1; arc vertices expand to arcSegCount(|angle|) points
// along the circular arc; consecutive spline-flagged rel vertices (plus
// the anchor vertex before the run) expand to a Catmull-Rom curve with
// >= 8 sub-segments per span. This is what the canvas path, perimeter
// rings, AABBs, and the numeric exporters (GDS / gdsfactory / pyAEDT)
// consume. resolvePolylineVertices (one point per vertex spec) remains
// the source for vertex indexing / inspector handles.
//
// The closing edge of a closed path is NOT tessellated here — it's a
// straight line that callers add via 'Z' / ring closure.
export function tessellatePolylinePath(c, byId, paramValues, transformInstances = null) {
  const specs = c.vertices || [];
  const verts = resolvePolylineVertices(c, byId, paramValues, transformInstances);
  const baseCx = Number.isFinite(c.cx) ? c.cx : 0;
  const baseCy = Number.isFinite(c.cy) ? c.cy : 0;
  const out = [];
  let i = 0;
  while (i < specs.length) {
    const v = specs[i];
    const prev = i === 0 ? [baseCx, baseCy] : verts[i - 1];
    if (v && v.kind === 'arc') {
      // Arc at index 0 starts from the implicit component anchor (cx, cy)
      // — include that start point so the drawn path begins at the arc's
      // true start instead of jumping to the endpoint.
      if (i === 0) out.push([baseCx, baseCy]);
      const cdx = evalExpr(v.cdx ?? '0', paramValues);
      const cdy = evalExpr(v.cdy ?? '0', paramValues);
      const ang = evalExpr(v.angle ?? '0', paramValues);
      const [px, py] = prev;
      if (Number.isFinite(px) && Number.isFinite(py)
          && Number.isFinite(cdx) && Number.isFinite(cdy) && Number.isFinite(ang) && Math.abs(ang) > 1e-12) {
        out.push(...tessellateArcFrom(px, py, px + cdx, py + cdy, ang));
      } else {
        out.push(verts[i]);
      }
      i++;
      continue;
    }
    if (v && v.kind === 'rel' && v.spline && i > 0) {
      // Collect the full consecutive spline run [i .. j].
      let j = i;
      while (j + 1 < specs.length && specs[j + 1] && specs[j + 1].kind === 'rel' && specs[j + 1].spline) j++;
      // Control points: anchor (previous resolved point) + the run.
      const ctrl = [prev, ...verts.slice(i, j + 1)];
      if (ctrl.every(p => Number.isFinite(p[0]) && Number.isFinite(p[1])) && ctrl.length >= 3) {
        const tess = catmullRomTessellate(ctrl, 8);
        out.push(...tess.slice(1)); // anchor already emitted
      } else {
        // Degenerate run (single spline vertex = straight line, or NaNs):
        // pass the resolved points through as plain line vertices.
        out.push(...verts.slice(i, j + 1));
      }
      i = j + 1;
      continue;
    }
    out.push(verts[i]);
    i++;
  }
  if (out.length === 0) out.push([baseCx, baseCy]);
  return out;
}

// ── Tapered polyline band ──────────────────────────────────────────────
// True when any vertex carries a non-empty width expression (the taper
// trigger described in the header comment).
export function polylineIsTapered(c) {
  if (!c || c.kind !== 'polyline') return false;
  return (c.vertices || []).some(v => v && v.width != null && String(v.width).trim() !== '');
}

// Effective numeric width at vertex i: the vertex's own width expression
// if set, else the component's base width. Arc vertices always use the
// base width (taper-on-arc is a v1 restriction; the inspector disables
// the field).
export function effectiveVertexWidth(c, v, paramValues) {
  const baseW = Math.max(0, evalExpr(c.width ?? '0', paramValues) || 0);
  if (!v || v.kind === 'arc') return baseW;
  if (v.width != null && String(v.width).trim() !== '') {
    const w = evalExpr(v.width, paramValues);
    if (Number.isFinite(w) && w >= 0) return w;
  }
  return baseW;
}

// Build the tapered band as a list of filled quads over the centerline.
// For each LINE segment the quad corners are endpoint ± (w/2)·n̂ where n̂
// is the segment's unit normal (BUTT joins — no miter), with the width
// interpolating linearly from the start vertex's effective width to the
// end vertex's. Arc / spline segments fall back to CONSTANT base width:
// they tessellate to sub-segments and each sub-segment becomes a quad at
// the base width (v1 restriction — mirrors the HFSS export's fallback so
// canvas, GDS and HFSS build the SAME geometry).
//
// Returns { quads, curvedFallback } where quads is a list of
// [[x,y],[x,y],[x,y],[x,y]] rings (counter-ordered corners: start+n,
// end+n, end−n, start−n) and curvedFallback is true when any arc/spline
// segment was demoted to constant width.
export function taperedBandQuads(c, byId, paramValues, transformInstances = null) {
  const specs = c.vertices || [];
  const verts = resolvePolylineVertices(c, byId, paramValues, transformInstances);
  const baseCx = Number.isFinite(c.cx) ? c.cx : 0;
  const baseCy = Number.isFinite(c.cy) ? c.cy : 0;
  const baseW = Math.max(0, evalExpr(c.width ?? '0', paramValues) || 0);
  const quads = [];
  let curvedFallback = false;
  const quadFor = (p0, p1, w0, w1) => {
    const dx = p1[0] - p0[0], dy = p1[1] - p0[1];
    const len = Math.hypot(dx, dy);
    if (!(len > 1e-12)) return null;
    // Unit normal (dy, -dx)/len — matches the HFSS corner expressions.
    const nx = dy / len, ny = -dx / len;
    return [
      [p0[0] + (w0 / 2) * nx, p0[1] + (w0 / 2) * ny],
      [p1[0] + (w1 / 2) * nx, p1[1] + (w1 / 2) * ny],
      [p1[0] - (w1 / 2) * nx, p1[1] - (w1 / 2) * ny],
      [p0[0] - (w0 / 2) * nx, p0[1] - (w0 / 2) * ny],
    ];
  };
  // Constant-width quads along a tessellated curve (arc/spline fallback).
  const pushCurveQuads = (pts) => {
    for (let k = 0; k + 1 < pts.length; k++) {
      const q = quadFor(pts[k], pts[k + 1], baseW, baseW);
      if (q) quads.push(q);
    }
  };
  let i = 0;
  let prevPt = null;       // previous resolved point ([x,y])
  let prevW = baseW;       // effective width at the previous vertex
  while (i < specs.length) {
    const v = specs[i];
    const cur = verts[i];
    const start = i === 0 ? [baseCx, baseCy] : prevPt;
    if (v && v.kind === 'arc') {
      const cdx = evalExpr(v.cdx ?? '0', paramValues);
      const cdy = evalExpr(v.cdy ?? '0', paramValues);
      const ang = evalExpr(v.angle ?? '0', paramValues);
      if (start && Number.isFinite(start[0]) && Number.isFinite(cdx) && Number.isFinite(cdy)
          && Number.isFinite(ang) && Math.abs(ang) > 1e-12) {
        curvedFallback = true;
        pushCurveQuads([start, ...tessellateArcFrom(start[0], start[1], start[0] + cdx, start[1] + cdy, ang)]);
      }
      prevPt = cur; prevW = baseW;
      i++;
      continue;
    }
    if (v && v.kind === 'rel' && v.spline && i > 0 && prevPt) {
      let j = i;
      while (j + 1 < specs.length && specs[j + 1] && specs[j + 1].kind === 'rel' && specs[j + 1].spline) j++;
      const ctrl = [prevPt, ...verts.slice(i, j + 1)];
      if (ctrl.every(p => p && Number.isFinite(p[0]) && Number.isFinite(p[1])) && ctrl.length >= 3) {
        curvedFallback = true;
        pushCurveQuads(catmullRomTessellate(ctrl, 8));
      } else {
        // Degenerate single-vertex run: a straight segment — taper applies.
        for (let k = i; k <= j; k++) {
          const w1 = effectiveVertexWidth(c, specs[k], paramValues);
          const q = quadFor(k === i ? prevPt : verts[k - 1], verts[k], k === i ? prevW : effectiveVertexWidth(c, specs[k - 1], paramValues), w1);
          if (q) quads.push(q);
        }
      }
      prevPt = verts[j]; prevW = effectiveVertexWidth(c, specs[j], paramValues);
      i = j + 1;
      continue;
    }
    // Plain line vertex (rel or snap). Vertex 0 establishes the start
    // point; no segment is drawn into it unless the path later closes.
    if (i > 0 && start && cur && Number.isFinite(cur[0])) {
      const w1 = effectiveVertexWidth(c, v, paramValues);
      const q = quadFor(start, cur, prevW, w1);
      if (q) quads.push(q);
      prevW = w1;
    } else {
      prevW = effectiveVertexWidth(c, v, paramValues);
    }
    prevPt = cur;
    i++;
  }
  // Closed polyline: closing quad from the last vertex back to vertex 0.
  if (c.closed && verts.length >= 2) {
    const last = verts[verts.length - 1];
    const first = verts[0];
    const w0 = prevW;
    const w1 = effectiveVertexWidth(c, specs[0], paramValues);
    const q = quadFor(last, first, w0, w1);
    if (q) quads.push(q);
  }
  return { quads, curvedFallback };
}

// Compute AABB (cx, cy, w, h) from the resolved vertex positions of a
// closed polygon-path component (`kind: 'polyshape'`). UNLIKE polyline
// this does NOT add half-width padding — a polyshape is a flat filled
// region whose visible footprint is exactly the convex hull of its
// vertices (well, the polygon itself; the AABB is the same either way).
export function polyshapeBbox(verts) {
  if (!verts || verts.length === 0) return { cx: 0, cy: 0, w: 0, h: 0 };
  let minX = +Infinity, maxX = -Infinity, minY = +Infinity, maxY = -Infinity;
  for (const [x, y] of verts) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (!Number.isFinite(minX)) return { cx: 0, cy: 0, w: 0, h: 0 };
  return {
    cx: (minX + maxX) / 2,
    cy: (minY + maxY) / 2,
    w:  (maxX - minX),
    h:  (maxY - minY),
  };
}

// Compute AABB (cx, cy, w, h) from a polyline's resolved vertex positions.
// Adds half-width padding on every face so snap anchors land on the OUTER
// edge of the swept trace, not the bare centerline.
export function polylineBbox(c, verts, paramValues) {
  if (!verts || verts.length === 0) return { cx: c.cx ?? 0, cy: c.cy ?? 0, w: 0, h: 0 };
  let minX = +Infinity, maxX = -Infinity, minY = +Infinity, maxY = -Infinity;
  for (const [x, y] of verts) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (!Number.isFinite(minX)) return { cx: c.cx ?? 0, cy: c.cy ?? 0, w: 0, h: 0 };
  const widthVal = evalExpr(c.width ?? '0', paramValues);
  // Clamp to non-negative: a negative width expression would SHRINK the
  // bbox below the vertex extent (or go negative outright).
  let maxWidth = Math.max(0, Number.isFinite(widthVal) ? widthVal : 0);
  // Tapered polylines: any per-vertex width can exceed the base width;
  // pad the AABB by the WIDEST effective width so snap anchors stay on
  // (or outside) the visible band everywhere along the trace.
  for (const v of (c.vertices || [])) {
    if (!v || v.kind === 'arc' || v.width == null || String(v.width).trim() === '') continue;
    const wv = evalExpr(v.width, paramValues);
    if (Number.isFinite(wv) && wv > maxWidth) maxWidth = wv;
  }
  const halfW = maxWidth / 2;
  return {
    cx: (minX + maxX) / 2,
    cy: (minY + maxY) / 2,
    w: (maxX - minX) + 2 * halfW,
    h: (maxY - minY) + 2 * halfW,
  };
}

// Build SVG path data for the polyline centerline. Returns a string like
// "M x0 -y0 L x1 -y1 L x2 -y2" (y inverted for SVG's y-down screen frame).
// Closed paths get a trailing "Z".
export function polylineToPathD(verts, closed = false) {
  if (!verts || verts.length === 0) return '';
  let d = '';
  let started = false;
  for (const [x, y] of verts) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    d += started ? ` L ${x} ${-y}` : `M ${x} ${-y}`;
    started = true;
  }
  if (closed && started) d += ' Z';
  return d;
}

// Validate that a vertex spec is well-formed. Used by the inspector and the
// draw-UX commit path.
export function isValidVertex(v) {
  if (!v || typeof v !== 'object') return false;
  if (v.kind === 'snap') {
    return typeof v.compId === 'string' && v.compId.length > 0
        && typeof v.anchor === 'string' && v.anchor.length > 0;
  }
  if (v.kind === 'arc') {
    // cdx/cdy/angle can be strings or numbers; all default sanely.
    return true;
  }
  // Default kind is 'rel' (dx/dy can be strings or numbers).
  return true;
}

// ── Closed-ring self-intersection test ──────────────────────────────────
// TRUE when any two NON-adjacent edges of the closed ring properly cross.
// This is the exact geometry AEDT's Parasolid kernel rejects on
// CreatePolyline with PK_ERROR_crossing_edge — a real shipped failure: a
// parametric hexagon node whose side length went NEGATIVE under a param
// retune (node_size < CPW_W/3) drew an invisible ~1 um bowtie on canvas
// and killed the HFSS import. Surfaced via sceneIssues + an export
// warning so the constraint violation is visible BEFORE AEDT sees it.
// O(n^2) over ring edges — rings here are small (hand-drawn polyshapes).
export function ringSelfIntersects(pts) {
  const n = (pts || []).length;
  if (n < 4) return false; // a triangle cannot self-intersect
  const cross = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const properX = (a, b, c, d) => {
    const d1 = cross(c, d, a), d2 = cross(c, d, b), d3 = cross(a, b, c), d4 = cross(a, b, d);
    return ((d1 > 1e-9 && d2 < -1e-9) || (d1 < -1e-9 && d2 > 1e-9))
      && ((d3 > 1e-9 && d4 < -1e-9) || (d3 < -1e-9 && d4 > 1e-9));
  };
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    for (let j = i + 1; j < n; j++) {
      // Skip adjacent edges (they share a vertex; only PROPER crossings count).
      if (j === i || (j + 1) % n === i || (i + 1) % n === j) continue;
      if (properX(a, b, pts[j], pts[(j + 1) % n])) return true;
    }
  }
  return false;
}

// ── Mitered constant-width band around an OPEN centerline ────────────────
// Returns one ring (left side then reversed right side, butt end caps).
// Miter length is clamped to 4× halfW so near-reversals don't explode.
// Canonical home — scene3d, cross-section, and the GDS export all share
// this exact band so a constant-width trace means the same metal
// everywhere (the GDS previously emitted the zero-area CENTERLINE as the
// boundary: a 4 µm trace exported as no metal at all).
export function miterBandRing(pts, halfW) {
  const n = pts.length;
  if (n < 2 || !(halfW > 0)) return null;
  const dirs = [];
  for (let i = 0; i + 1 < n; i++) {
    const dx = pts[i + 1][0] - pts[i][0];
    const dy = pts[i + 1][1] - pts[i][1];
    const len = Math.hypot(dx, dy) || 1;
    dirs.push([dx / len, dy / len]);
  }
  const left = [];
  const right = [];
  for (let i = 0; i < n; i++) {
    const dPrev = dirs[Math.max(0, i - 1)];
    const dNext = dirs[Math.min(dirs.length - 1, i)];
    // Normals point "left" of travel.
    const n1 = [-dPrev[1], dPrev[0]];
    const n2 = [-dNext[1], dNext[0]];
    let mx = n1[0] + n2[0];
    let my = n1[1] + n2[1];
    const mlen = Math.hypot(mx, my);
    if (mlen < 1e-9) { mx = n2[0]; my = n2[1]; }
    else { mx /= mlen; my /= mlen; }
    // Miter scale: 1/cos(θ/2), clamped.
    const dot = Math.max(0.25, mx * n2[0] + my * n2[1]);
    const s = Math.min(halfW / dot, halfW * 4);
    left.push([pts[i][0] + mx * s, pts[i][1] + my * s]);
    right.push([pts[i][0] - mx * s, pts[i][1] - my * s]);
  }
  return [...left, ...right.reverse()];
}

// ── Band PIECES for a constant-width trace (paint-union semantics) ───────
// Returns { pieces } — per-segment quads plus per-joint miter patches.
// Their UNION is exactly the region an SVG miter-joined stroke paints
// (miter limit 4, bevel beyond — the canvas rendering), and every piece
// is individually convex/simple, so emitting them as overlapping
// same-layer polygons is valid GDS for ANY bend tightness. A single
// band OUTLINE (miterBandRing) folds over itself when the width is
// comparable to a bend's opening — the choke-trace artifact: KLayout
// rendered wedge/chamfer garbage where the canvas showed a clean U.
// Consecutive duplicate points are dropped (a trailing zero-length
// vertex corrupted the outline's normals). `closed` adds the wrap
// segment and a joint at every vertex.
export function bandPieces(ptsIn, halfW, closed = false) {
  const pieces = [];
  if (!(halfW > 0) || !Array.isArray(ptsIn)) return { pieces };
  const pts = [];
  for (const p of ptsIn) {
    const prev = pts[pts.length - 1];
    if (!prev || Math.hypot(p[0] - prev[0], p[1] - prev[1]) > 1e-9) pts.push(p);
  }
  if (closed && pts.length > 1) {
    const a = pts[0], b = pts[pts.length - 1];
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) <= 1e-9) pts.pop();
  }
  const n = pts.length;
  if (n < 2) return { pieces };
  const segCount = closed ? n : n - 1;
  const dirs = [];
  for (let i = 0; i < segCount; i++) {
    const p = pts[i], q = pts[(i + 1) % n];
    const dx = q[0] - p[0], dy = q[1] - p[1];
    const len = Math.hypot(dx, dy) || 1;
    dirs.push([dx / len, dy / len]);
    const nx = -dy / len, ny = dx / len;
    pieces.push([
      [p[0] + nx * halfW, p[1] + ny * halfW],
      [q[0] + nx * halfW, q[1] + ny * halfW],
      [q[0] - nx * halfW, q[1] - ny * halfW],
      [p[0] - nx * halfW, p[1] - ny * halfW],
    ]);
  }
  // Joint patches: cover the OUTER wedge between consecutive segments
  // (the inner side is covered by the quads' own overlap).
  const joints = [];
  if (closed) { for (let i = 0; i < n; i++) joints.push(i); }
  else { for (let i = 1; i < n - 1; i++) joints.push(i); }
  for (const i of joints) {
    const d1 = dirs[(i - 1 + segCount) % segCount];
    const d2 = dirs[i % segCount];
    const cross = d1[0] * d2[1] - d1[1] * d2[0];
    if (Math.abs(cross) < 1e-12) continue; // collinear — no wedge
    const P = pts[i];
    // Outer normals: right side for a left turn, left side for a right turn.
    const s1 = cross > 0 ? -1 : 1;
    const no1 = [-d1[1] * s1, d1[0] * s1];
    const no2 = [-d2[1] * s1, d2[0] * s1];
    const A = [P[0] + no1[0] * halfW, P[1] + no1[1] * halfW];
    const B = [P[0] + no2[0] * halfW, P[1] + no2[1] * halfW];
    let mx = no1[0] + no2[0], my = no1[1] + no2[1];
    const mlen = Math.hypot(mx, my);
    if (mlen < 1e-9) { pieces.push([P, A, B]); continue; } // 180° reversal — bevel
    mx /= mlen; my /= mlen;
    const cosHalf = Math.max(mx * no1[0] + my * no1[1], 1e-6);
    const s = halfW / cosHalf;
    if (s > halfW * 4) {
      pieces.push([P, A, B]); // SVG miterlimit-4 bevel fallback
    } else {
      pieces.push([P, A, [P[0] + mx * s, P[1] + my * s], B]);
    }
  }
  return { pieces };
}
