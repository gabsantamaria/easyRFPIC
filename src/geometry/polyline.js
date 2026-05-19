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
//       { kind: 'snap', compId, anchor },     // pinned to another component's anchor
//       ...
//     ],
//     closed: false,          // optional ring closure (last vertex connects to first)
//   }
//
// Two vertex kinds:
//   - 'rel': parametric dx, dy from the PREVIOUS resolved vertex. This is the
//            default mode — every step the user clicks gets stored as a dx/dy
//            from the previous click.
//   - 'snap': hard-bound to another component's anchor. The vertex's world
//             position parametrically tracks that anchor — sweeping anything in
//             the target component's chain moves this vertex with it.
//
// Both representations preserve parametric dependencies end-to-end: HFSS-side
// sweeps of any variable involved in dx/dy expressions OR the target component's
// chain move the polyline's vertices in lockstep.

import { evalExpr } from '../scene/params.js';
import { anchorLocal, parseAnchor } from '../scene/anchors.js';
import { resolveInstanceAnchorNumeric } from '../scene/instance-positions.js';

// Compute the world (x, y) position of a target component's anchor — used to
// resolve `snap` vertices. Works for primitive shapes (uses bbox w/h). For
// boolean targets the caller should pass the SOLVED component (with its
// refreshed AABB) so c.w/c.h are numeric.
export function anchorWorldNumeric(targetComp, anchorName, paramValues) {
  if (!targetComp) return null;
  const w = typeof targetComp.w === 'number' ? targetComp.w : evalExpr(targetComp.w, paramValues);
  const h = typeof targetComp.h === 'number' ? targetComp.h : evalExpr(targetComp.h, paramValues);
  if (!Number.isFinite(w) || !Number.isFinite(h)) return null;
  const local = anchorLocal(anchorName, w, h);
  return { x: targetComp.cx + local.x, y: targetComp.cy + local.y };
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
  const halfW = (Number.isFinite(widthVal) ? widthVal : 0) / 2;
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
  // Default kind is 'rel' (dx/dy can be strings or numbers).
  return true;
}
