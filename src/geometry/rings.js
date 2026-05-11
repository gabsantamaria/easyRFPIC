// Perimeter rings for primitive shape instances.
//
// Every primitive — rect, circle, ellipse, regular polygon, racetrack —
// flattens to a closed polyline in world coordinates. Booleans, mask
// paths, GDS BOUNDARY records, and HFSS polyline fallbacks all consume
// these rings.
//
// Extracted from PhotonicLayout.jsx as Stage 1.4 of the planned refactor.
import { buildRacetrackCenterline, offsetCenterlineToBand } from './racetrack.js';

// Number of vertices used when tessellating a circle/ellipse into a polygon.
// Used for outline rendering, mask paths in booleans, GDS export, and HFSS
// polyline fallbacks. 64 gives a smooth visual circle while keeping output
// files reasonable in size.
const CIRCLE_TESSELATION = 64;

// Convert an axis-aligned-or-rotated rectangle (cx, cy, w, h, rotation)
// to a 4-point polygon ring in world coordinates.
export function rectInstanceToRing(inst) {
  const halfW = inst.w / 2;
  const halfH = inst.h / 2;
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
  return corners.map(([lx, ly]) => [inst.cx + lx, inst.cy + ly]);
}

// Convert any primitive component instance (rect, circle, ellipse, polygon,
// racetrack) into a ring of [x, y] world-space points that traces its
// perimeter. This uniformly handles rotation via the `rotation` field
// (degrees, CCW).
//
// For circles and ellipses, the ring is a polygon approximation with
// CIRCLE_TESSELATION vertices — sufficient for SVG rendering, mask paths,
// and GDS export. For regular polygons, the ring is the exact polygon
// with n vertices.
//
// The instance carries shape-specific numeric fields populated by
// expandTransforms: r (circle), rx/ry (ellipse), r/n (polygon).
export function shapeInstanceToRing(inst) {
  const kind = inst.kind || 'rect';
  const rot = inst.rotation || 0;
  const rad = rot * Math.PI / 180;
  const ca = Math.cos(rad), sa = Math.sin(rad);
  const xform = (lx, ly) => [
    inst.cx + lx * ca - ly * sa,
    inst.cy + lx * sa + ly * ca,
  ];
  if (kind === 'circle') {
    const r = Number.isFinite(inst.r) ? inst.r : 0;
    const out = [];
    for (let i = 0; i < CIRCLE_TESSELATION; i++) {
      const t = (i / CIRCLE_TESSELATION) * Math.PI * 2;
      out.push(xform(r * Math.cos(t), r * Math.sin(t)));
    }
    return out;
  }
  if (kind === 'ellipse') {
    const rx = Number.isFinite(inst.rx) ? inst.rx : 0;
    const ry = Number.isFinite(inst.ry) ? inst.ry : 0;
    const out = [];
    for (let i = 0; i < CIRCLE_TESSELATION; i++) {
      const t = (i / CIRCLE_TESSELATION) * Math.PI * 2;
      out.push(xform(rx * Math.cos(t), ry * Math.sin(t)));
    }
    return out;
  }
  if (kind === 'polygon') {
    const r = Number.isFinite(inst.r) ? inst.r : 0;
    const n = Math.max(3, Math.round(Number.isFinite(inst.n) ? inst.n : 6));
    const out = [];
    // First vertex points "up" by convention so the polygon's apex aligns
    // with the y axis when rotation=0. This matches how engineering tools
    // typically draw regular polygons (hexagon point-up, etc).
    const offset = Math.PI / 2;
    for (let i = 0; i < n; i++) {
      const t = offset + (i / n) * Math.PI * 2;
      out.push(xform(r * Math.cos(t), r * Math.sin(t)));
    }
    return out;
  }
  if (kind === 'racetrack') {
    // The racetrack's "ring" for AABB/snap purposes is the OUTER edge of
    // the waveguide band — i.e., the centerline offset outward by half
    // the waveguide width. This gives a tight enclosing perimeter that
    // matches the visible footprint of the racetrack.
    const R = Number.isFinite(inst.R) ? inst.R : 100;
    const L = Number.isFinite(inst.L_straight) ? inst.L_straight : 300;
    const p = Number.isFinite(inst.p) ? inst.p : 1;
    const wgWidth = Number.isFinite(inst.wgWidth) ? inst.wgWidth : 1.2;
    const centerline = buildRacetrackCenterline(R, L, p);
    const { outer } = offsetCenterlineToBand(centerline, wgWidth / 2);
    return outer.map(([lx, ly]) => xform(lx, ly));
  }
  // Default: rectangle. Use the existing rect ring builder.
  return rectInstanceToRing(inst);
}
