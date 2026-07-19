// Lumped-port adjacency detection.
//
// A port-layer rectangle that has two opposite sides touching electrode
// shapes (one electrode on each side) can be auto-assigned a lumped
// port in HFSS. The integration line runs perpendicular to the touched
// edges and is centered on the port — from the midpoint of one touched
// edge to the midpoint of the other.
//
// Two adjacency patterns are recognized:
//   - EW: electrodes on the West and East sides → integration line on Y=cy
//         from (xMin, cy) to (xMax, cy).
//   - NS: electrodes on the North and South sides → integration line on X=cx
//         from (cx, yMin) to (cx, yMax).
//
// The returned `from` / `to` give the orientation of the line (signal
// to ground convention is up to the user / the IntLine direction).

import { evalExpr } from './params.js';
import { expandTransforms } from './transforms.js';
import { instanceFrameCenter } from './instance-positions.js';

// Coincidence tolerance for "edges touch" (µm). Layouts in this app are
// in µm and snap to grid, so 0.05 is plenty.
const TOL = 0.05;

// Returns the resolved (w, h, cx, cy) of a primitive or boolean instance.
function instExtent(inst, paramValues) {
  // Immutable imported GDS layouts are ONE component whose bbox spans the
  // whole imported layer — treating that bbox as metal produced FALSE
  // port-flanker matches at bbox edges where the layer is empty (and a
  // port INSIDE the bbox can never match an edge anyway). The packed
  // rings aren't edge-testable here, so imported groups don't participate
  // in port adjacency: draw editable feed rects on top for port regions
  // (documented in CLAUDE.md's GDS-import section).
  if (inst.kind === 'gdsgroup') return null;
  const w = Number.isFinite(inst.w) ? inst.w : evalExpr(inst.w, paramValues);
  const h = Number.isFinite(inst.h) ? inst.h : evalExpr(inst.h, paramValues);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  // ROTATION-AWARE extent: a transform-chain instance carries a NUMERIC
  // rotation (a −90° group rotate swaps a rect's axis-aligned span). Raw
  // scene components carry a STRING first-class rotation — those keep the
  // legacy unrotated extent (only numeric instance rotations apply).
  const rotN = typeof inst.rotation === 'number' && Number.isFinite(inst.rotation) ? inst.rotation : 0;
  const rad = rotN * Math.PI / 180;
  const ca = Math.abs(Math.cos(rad));
  const sa = Math.abs(Math.sin(rad));
  const wEff = ca * w + sa * h;
  const hEff = sa * w + ca * h;
  return {
    id: inst.id,
    cx: inst.cx, cy: inst.cy, w: wEff, h: hEff,
    xMin: inst.cx - wEff / 2, xMax: inst.cx + wEff / 2,
    yMin: inst.cy - hEff / 2, yMax: inst.cy + hEff / 2,
  };
}

// Inspect a port-layer rect on the SOLVED scene and figure out whether
// its left/right or top/bottom edges are flanked by electrode shapes.
//
// Returns one of:
//   { direction: null }                 — not adjacent to two conductors.
//   { direction: 'EW', from, to, line } — line goes WEST → EAST (from west
//                                          electrode side to east side).
//   { direction: 'NS', from, to, line } — line goes SOUTH → NORTH.
//
// `line` carries the world-coord endpoints in XY (Z is supplied by the
// caller from the port-layer's z-position, which is layer-stack dependent).
export function detectPortIntegrationLine(port, solved, paramValues) {
  if (!port || port.layer !== 'port' || port.kind !== 'rect') {
    return { direction: null };
  }
  // Expand transforms so a `repeat`/`displace` on a conductor produces
  // copies that participate in adjacency checks. Expanded instances carry
  // `compId` only (no layer / id) — map each back to its source component
  // to recover those, keeping the instance's transformed cx/cy/w/h for
  // the extent math.
  const byId = new Map((solved || []).map(c => [c.id, c]));
  const allInsts = expandTransforms(solved, paramValues);
  // The PORT is tested at its RENDERED instance-0 pose, in the SAME frame
  // as the electrode instances below. Testing the port at its raw BASE
  // pose while electrodes sat at rendered poses made a group-rotated
  // port (the −90° balun) find no flankers at all — and the emitted
  // IntLine must lie on the FINAL (chain-transformed) sheet anyway.
  const p0 = allInsts.find(i => i.compId === port.id && i.idx === 0);
  const p = instExtent(p0 ? { ...p0, id: port.id, kind: port.kind } : port, paramValues);
  if (!p) return { direction: null };
  const electrodes = allInsts
    .map(inst => {
      const src = byId.get(inst.compId);
      if (!src || src.layer !== 'electrode' || src.id === port.id) return null;
      // Path-kind electrodes (polyline/polyshape traces): the instance's
      // cx/cy is vertex 0, not the bbox center — flanker edges computed
      // from it sat off the visible band by (bboxCenter − v0), silently
      // failing the TOL=0.05 edge-coincidence test (port not detected).
      // Use the instance FRAME center (transformed displayBbox center).
      const fc = instanceFrameCenter(src, inst);
      return instExtent({ ...inst, cx: fc.cx, cy: fc.cy, id: src.id }, paramValues);
    })
    .filter(Boolean);

  // For a given port edge (at coord `c` on axis a; the other axis spans
  // [rangeMin, rangeMax]), return the FIRST electrode whose matching
  // edge sits at the same coord with a y/x overlap covering the port's
  // centerline.
  const findFlanker = (axis, coord, rangeMin, rangeMax, isPortMinSide) => {
    for (const e of electrodes) {
      // Pick the electrode edge that COULD touch this port edge:
      //   port's W edge (xMin)  → electrode's E edge (xMax)
      //   port's E edge (xMax)  → electrode's W edge (xMin)
      //   port's S edge (yMin)  → electrode's N edge (yMax)
      //   port's N edge (yMax)  → electrode's S edge (yMin)
      const elecCoord = axis === 'x'
        ? (isPortMinSide ? e.xMax : e.xMin)
        : (isPortMinSide ? e.yMax : e.yMin);
      if (Math.abs(elecCoord - coord) > TOL) continue;
      const eOtherMin = axis === 'x' ? e.yMin : e.xMin;
      const eOtherMax = axis === 'x' ? e.yMax : e.xMax;
      // Overlap on the orthogonal axis must cover the port's full extent
      // (otherwise the electrode only kisses one corner and isn't a real
      // flanker for a lumped-port integration line).
      if (eOtherMin > rangeMin + TOL || eOtherMax < rangeMax - TOL) continue;
      return e;
    }
    return null;
  };

  // EW check: west side at xMin needs a conductor's E edge there;
  // east side at xMax needs a conductor's W edge.
  const westElec = findFlanker('x', p.xMin, p.yMin, p.yMax, true);
  const eastElec = findFlanker('x', p.xMax, p.yMin, p.yMax, false);
  if (westElec && eastElec) {
    return {
      direction: 'EW',
      from: westElec.id,
      to: eastElec.id,
      line: { startX: p.xMin, endX: p.xMax, midY: p.cy },
    };
  }

  // NS check.
  const southElec = findFlanker('y', p.yMin, p.xMin, p.xMax, true);
  const northElec = findFlanker('y', p.yMax, p.xMin, p.xMax, false);
  if (southElec && northElec) {
    return {
      direction: 'NS',
      from: southElec.id,
      to: northElec.id,
      line: { startY: p.yMin, endY: p.yMax, midX: p.cx },
    };
  }

  // Punch-hole case: the port sits in a hole that a 'punch' boolean
  // cut out of an electrode. After the punch the electrode is split
  // into two halves on whichever axis the hole spans fully. The port
  // is the gap → an integration line across it connects the halves.
  const punches = (solved || []).filter(c => c.kind === 'boolean' && c.op === 'punch');
  for (const b of punches) {
    const operandIds = b.operandIds || [];
    if (operandIds.length < 2) continue;
    const base = solved.find(c => c.id === operandIds[0]);
    if (!base || base.layer !== 'electrode') continue;
    const baseExt = instExtent(base, paramValues);
    if (!baseExt) continue;
    // Find a tool clone of this punch that occupies the port's
    // bbox — either because the port itself was the tool (rare in
    // current model) or, more commonly, because the clone of the
    // original port sits at the same location as the port.
    for (const cloneId of operandIds.slice(1)) {
      const clone = solved.find(c => c.id === cloneId);
      if (!clone) continue;
      const cloneExt = instExtent(clone, paramValues);
      if (!cloneExt) continue;
      // Either the port IS the clone OR the clone's bbox matches.
      const sameBbox =
        Math.abs(cloneExt.xMin - p.xMin) < TOL &&
        Math.abs(cloneExt.xMax - p.xMax) < TOL &&
        Math.abs(cloneExt.yMin - p.yMin) < TOL &&
        Math.abs(cloneExt.yMax - p.yMax) < TOL;
      // OR the clone was cloneOf the port (the standard relation when
      // the user created the punch with the port as the tool).
      const isCloneOfPort = clone.cloneOf === port.id;
      if (!sameBbox && !isCloneOfPort) continue;
      // The hole (= clone bbox) must lie inside the base bbox AND
      // span across one axis of the base for the base to be split.
      const fullyInsideBase =
        cloneExt.xMin >= baseExt.xMin - TOL && cloneExt.xMax <= baseExt.xMax + TOL &&
        cloneExt.yMin >= baseExt.yMin - TOL && cloneExt.yMax <= baseExt.yMax + TOL;
      if (!fullyInsideBase) continue;
      // Does the hole span the FULL Y of the base? → base is split in X → EW.
      const spansY =
        cloneExt.yMin <= baseExt.yMin + TOL && cloneExt.yMax >= baseExt.yMax - TOL;
      const spansX =
        cloneExt.xMin <= baseExt.xMin + TOL && cloneExt.xMax >= baseExt.xMax - TOL;
      if (spansY) {
        return {
          direction: 'EW',
          from: `${base.id} (W half)`,
          to: `${base.id} (E half)`,
          line: { startX: p.xMin, endX: p.xMax, midY: p.cy },
        };
      }
      if (spansX) {
        return {
          direction: 'NS',
          from: `${base.id} (S half)`,
          to: `${base.id} (N half)`,
          line: { startY: p.yMin, endY: p.yMax, midX: p.cx },
        };
      }
      // Clone sits inside the base but doesn't fully split it — no
      // unambiguous integration direction.
      break;
    }
  }

  return { direction: null };
}
