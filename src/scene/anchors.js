// Anchor math. Each component exposes nine fixed reference points
// (NW/N/NE/W/C/E/SW/S/SE) plus parametric edge anchors of the form
// `T:t`, `B:t`, `L:t`, `R:t` with t ∈ [0, 1] running along the edge.
//
// `anchorLocal` returns the anchor offset relative to the component
// center; `anchorWorld` lifts that to world-space coords, accepting
// either expression-string w/h (primitives) or already-resolved numeric
// w/h (booleans post-solve).
//
// Extracted from PhotonicLayout.jsx as Stage 1.3 of the planned refactor.
import { evalExpr } from './params.js';

// Two anchor formats are supported:
//   - 9 fixed corners/midpoints/center: 'NW','N','NE','W','C','E','SW','S','SE'
//   - Parametric edge: 'T:t' / 'B:t' / 'L:t' / 'R:t' where t in [0,1]
//     T (top, +Y edge) and B (bottom, -Y edge): t=0 is left (W), t=1 is right (E)
//     L (left, -X edge) and R (right, +X edge): t=0 is bottom (S), t=1 is top (N)
export const ANCHORS = ['NW', 'N', 'NE', 'W', 'C', 'E', 'SW', 'S', 'SE'];

export function parseAnchor(anchorName) {
  // Returns { kind: 'fixed', name } or { kind: 'edge', side: 'T'|'B'|'L'|'R', t: number }
  if (typeof anchorName !== 'string') return { kind: 'fixed', name: 'C' };
  const m = anchorName.match(/^([TBLR]):([\d.]+)$/);
  if (m) {
    const t = Math.max(0, Math.min(1, parseFloat(m[2]) || 0));
    return { kind: 'edge', side: m[1], t };
  }
  return { kind: 'fixed', name: anchorName };
}

export function anchorLocal(anchorName, w, h) {
  const a = parseAnchor(anchorName);
  if (a.kind === 'edge') {
    // Map t∈[0,1] across the edge
    if (a.side === 'T') return { x: -w / 2 + a.t * w, y:  h / 2 };
    if (a.side === 'B') return { x: -w / 2 + a.t * w, y: -h / 2 };
    if (a.side === 'L') return { x: -w / 2,           y: -h / 2 + a.t * h };
    if (a.side === 'R') return { x:  w / 2,           y: -h / 2 + a.t * h };
  }
  // Fixed 9-anchor names
  const name = a.name;
  const dx = name.includes('W') ? -w / 2 : name.includes('E') ? w / 2 : 0;
  const dy = name.includes('S') ? -h / 2 : name.includes('N') ? h / 2 : 0;
  return { x: dx, y: dy };
}

// Rotate a local anchor offset by `rotDeg` degrees CCW. Used for
// components carrying a first-class `rotation` expression so their
// anchors sit on the ROTATED shape's actual corners/edges, not on the
// pre-rotation axis-aligned bbox.
export function rotateLocal(local, rotDeg) {
  if (!rotDeg || Math.abs(rotDeg) < 1e-12) return local;
  const rad = rotDeg * Math.PI / 180;
  const ca = Math.cos(rad), sa = Math.sin(rad);
  return { x: local.x * ca - local.y * sa, y: local.x * sa + local.y * ca };
}

// `anchorLocal` with an optional rotation applied.
export function anchorLocalRotated(anchorName, w, h, rotDeg = 0) {
  return rotateLocal(anchorLocal(anchorName, w, h), rotDeg);
}

// Anchor offset in the frame of a TRANSFORM INSTANCE: mirror scale
// (±1 flips) applied FIRST, then rotation — the same composition
// expandTransforms / rings.js use, so the returned offset lands on the
// RENDERED instance's actual corner/edge. This is THE anchor math for
// anything addressing a specific instance (snap-to-replica dots, the
// alt-drag index, the solver's from.instanceIdx branch): keep every
// consumer on it or dots and solve positions drift apart.
export function anchorLocalInstance(anchorName, w, h, rotDeg = 0, sx = 1, sy = 1) {
  const l = anchorLocal(anchorName, w, h);
  return rotateLocal({ x: l.x * (sx || 1), y: l.y * (sy || 1) }, rotDeg);
}

// Numeric value of a component's first-class `rotation` field (degrees,
// CCW). Only rect / circle / ellipse / polygon / bridge support it
// (matching the seeding in expandTransforms); booleans and path-like
// kinds return 0. Absent / blank / '0' → 0.
// KEEP THIS SET IDENTICAL to HFSS_ROTATABLE_KINDS in hfss-native.js —
// computeParametricPositions wraps snap-chain offsets in the rotation
// matrix for exactly those kinds, so a kind rotatable in HFSS but not
// here makes the canvas/solver place a snapped child at the UNROTATED
// anchor while HFSS builds it at the ROTATED one (a real bridge bug we
// shipped and fixed: solver said (15, 0), HFSS built (0, 15)).
const ROTATABLE_KINDS = new Set(['rect', 'circle', 'ellipse', 'polygon', 'bridge']);
export function compRotationDeg(comp, paramValues) {
  if (!comp) return 0;
  if (!ROTATABLE_KINDS.has(comp.kind || 'rect')) return 0;
  const r = comp.rotation;
  if (r == null) return 0;
  if (typeof r === 'number') return Number.isFinite(r) ? r : 0;
  if (typeof r !== 'string' || r.trim() === '' || r.trim() === '0') return 0;
  const v = evalExpr(r, paramValues || {});
  return Number.isFinite(v) ? v : 0;
}

export function anchorWorld(comp, anchorName, paramValues) {
  // For booleans with a transform chain, `displayBbox` carries the post-
  // transform AABB (the visible footprint of the rotated/replicated
  // cluster). Snaps targeting such a boolean should land on its visible
  // perimeter, not the pre-transform operand AABB — otherwise dragging an
  // object onto a rotated meander's "top-right corner" would snap to a
  // point that's nowhere near the visible cluster.
  if (comp.displayBbox) {
    const { cx, cy, w, h } = comp.displayBbox;
    const local = anchorLocal(anchorName, w, h);
    return { x: cx + local.x, y: cy + local.y };
  }
  // Accept already-resolved numeric w/h (booleans pre-computed by
  // solveLayout) as well as expression-string w/h (primitives).
  const w = typeof comp.w === 'number' ? comp.w : evalExpr(comp.w, paramValues);
  const h = typeof comp.h === 'number' ? comp.h : evalExpr(comp.h, paramValues);
  // First-class rotation: the anchor offset rotates with the shape so
  // snap targets / dots track the rotated geometry. (Booleans return 0.)
  const rot = compRotationDeg(comp, paramValues);
  const local = rotateLocal(anchorLocal(anchorName, w, h), rot);
  return { x: comp.cx + local.x, y: comp.cy + local.y };
}
