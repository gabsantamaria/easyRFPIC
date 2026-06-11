// F1/F3 — canvas performance helpers: uniform-grid spatial index for the
// anchor / ruler / alt-drag snap searches, plus the pure boolean
// per-instance override builder.
//
// The load-bearing property is BEHAVIORAL INVARIANCE: the index-backed
// queries must return exactly what the old exhaustive scans returned —
// same candidate, same nearest-wins selection, same first-wins-on-tie
// ordering, same instanceIdx / edge-anchor metadata, same rotation-aware
// positions. So the oracles below are verbatim copies of the ORIGINAL
// Canvas.jsx scan loops, and the suite compares oracle vs index across
// hand-built scenes AND seeded fuzz.
import { describe, it, expect } from 'vitest';
import {
  buildUniformGrid, gridInsert, gridQuery, pickGridCellSize,
  buildAnchorSnapIndex, queryAnchorSnapIndex,
  buildAltDragTargetIndex, findAltDragSnapCandidate,
  buildBoolOverridesForInstance,
} from '../src/ui/canvas/Canvas.jsx';
import { ANCHORS, anchorLocalRotated, compRotationDeg } from '../src/scene/anchors.js';
import { evalExpr } from '../src/scene/params.js';

// Deterministic PRNG for fuzz cases.
const mulberry32 = (seed) => () => {
  seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// =========================================================================
// ORACLE 1 — verbatim copy of the ORIGINAL findAnchorSnap enumeration
// (pre-index Canvas.jsx). findRulerSnap differed only in its label
// formatting, which the suite reproduces from this oracle's fields.
// =========================================================================
function oracleFindAnchorSnap(transformInstances, solved, wp, worldThresh, excludeCompId = null) {
  let best = null;
  const consider = (x, y, compId, anchor, instanceIdx = 0) => {
    const dx = wp.x - x, dy = wp.y - y;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d <= worldThresh && (!best || d < best.d)) {
      best = { x, y, compId, anchor, instanceIdx, d };
    }
  };
  for (const inst of transformInstances) {
    if (excludeCompId && inst.compId === excludeCompId) continue;
    const w = inst.w, h = inst.h;
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) continue;
    const cx = inst.cx, cy = inst.cy;
    const rot = inst.rotation || 0;
    const rad = rot * Math.PI / 180;
    const ca = Math.cos(rad), sa = Math.sin(rad);
    const toWorld = (lx, ly) => ({ x: cx + lx * ca - ly * sa, y: cy + lx * sa + ly * ca });
    for (const a of ANCHORS) {
      const lp = anchorLocalRotated(a, w, h, rot);
      consider(cx + lp.x, cy + lp.y, inst.compId, a, inst.idx);
    }
    const lwx = (wp.x - cx) * ca + (wp.y - cy) * sa;
    const lwy = -(wp.x - cx) * sa + (wp.y - cy) * ca;
    const x0 = -w / 2, x1 = w / 2;
    const y0 = -h / 2, y1 = h / 2;
    if (lwx >= x0 - worldThresh && lwx <= x1 + worldThresh) {
      const projX = Math.max(x0, Math.min(x1, lwx));
      const tX = (projX - x0) / (x1 - x0);
      const pT = toWorld(projX, y1);
      const pB = toWorld(projX, y0);
      consider(pT.x, pT.y, inst.compId, `T:${tX.toFixed(4)}`, inst.idx);
      consider(pB.x, pB.y, inst.compId, `B:${tX.toFixed(4)}`, inst.idx);
    }
    if (lwy >= y0 - worldThresh && lwy <= y1 + worldThresh) {
      const projY = Math.max(y0, Math.min(y1, lwy));
      const tY = (projY - y0) / (y1 - y0);
      const pL = toWorld(x0, projY);
      const pR = toWorld(x1, projY);
      consider(pL.x, pL.y, inst.compId, `L:${tY.toFixed(4)}`, inst.idx);
      consider(pR.x, pR.y, inst.compId, `R:${tY.toFixed(4)}`, inst.idx);
    }
  }
  for (const inst of transformInstances) {
    if (inst.kind !== 'boolean' || inst.idx === 0) continue;
    if (excludeCompId && inst.compId === excludeCompId) continue;
    const b = solved.find(c => c.id === inst.compId);
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
      const op = solved.find(c => c.id === cid);
      if (!op) return;
      if (op.kind === 'boolean') {
        for (const childId of (op.operandIds || [])) visitOp(childId);
        return;
      }
      const baseInst = transformInstances.find(ii => ii.compId === op.id && ii.idx === 0);
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
      const opVisRot = rot + (baseInst.rotation || 0);
      for (const a of ANCHORS) {
        const lp = anchorLocalRotated(a, opW, opH, opVisRot);
        consider(newCx + lp.x, newCy + lp.y, op.id, a, inst.idx);
      }
      const ox0 = newCx - opW / 2, ox1 = newCx + opW / 2;
      const oy0 = newCy - opH / 2, oy1 = newCy + opH / 2;
      if (wp.x >= ox0 - worldThresh && wp.x <= ox1 + worldThresh) {
        const xProj = Math.max(ox0, Math.min(ox1, wp.x));
        const tX = (xProj - ox0) / (ox1 - ox0);
        consider(xProj, oy1, op.id, `T:${tX.toFixed(4)}`, inst.idx);
        consider(xProj, oy0, op.id, `B:${tX.toFixed(4)}`, inst.idx);
      }
      if (wp.y >= oy0 - worldThresh && wp.y <= oy1 + worldThresh) {
        const yProj = Math.max(oy0, Math.min(oy1, wp.y));
        const tY = (yProj - oy0) / (oy1 - oy0);
        consider(ox0, yProj, op.id, `L:${tY.toFixed(4)}`, inst.idx);
        consider(ox1, yProj, op.id, `R:${tY.toFixed(4)}`, inst.idx);
      }
    };
    for (const opid of (b.operandIds || [])) visitOp(opid);
  }
  return best;
}

// The new findAnchorSnap shape, built from a query hit (mirrors Canvas.jsx).
function indexFindAnchorSnap(index, wp, worldThresh, excludeCompId = null) {
  const hit = queryAnchorSnapIndex(index, wp, worldThresh, excludeCompId);
  if (!hit) return null;
  return {
    x: hit.x, y: hit.y, compId: hit.compId,
    anchor: hit.kind === 'anchor' ? hit.anchor : `${hit.side}:${hit.t.toFixed(4)}`,
    instanceIdx: hit.instanceIdx, d: hit.d,
  };
}

const expectSameSnap = (got, want) => {
  if (want === null) { expect(got).toBeNull(); return; }
  expect(got).not.toBeNull();
  expect(got.compId).toBe(want.compId);
  expect(got.anchor).toBe(want.anchor);
  expect(got.instanceIdx).toBe(want.instanceIdx);
  expect(got.x).toBeCloseTo(want.x, 9);
  expect(got.y).toBeCloseTo(want.y, 9);
  expect(got.d).toBeCloseTo(want.d, 9);
};

// =========================================================================
// ORACLE 2 — verbatim copy of the ORIGINAL alt-drag candidate-pair scan
// (anchor pairs + edge pairs + currentBest tracking).
// =========================================================================
function oracleAltDrag(solved, paramValues, {
  proposedCx, proposedCy, dw, dh, dragRotationDeg = 0,
  clusterSet = null, worldThresh, moveSnapHover = null,
}) {
  let best = null;
  let currentBest = null;
  const dxMin = proposedCx - dw / 2, dxMax = proposedCx + dw / 2;
  const dyMin = proposedCy - dh / 2, dyMax = proposedCy + dh / 2;
  for (const oc of solved) {
    if (clusterSet && clusterSet.has(oc.id)) continue;
    if (oc.consumedBy) continue;
    const ow = typeof oc.w === 'string' ? evalExpr(oc.w, paramValues) : oc.w;
    const oh = typeof oc.h === 'string' ? evalExpr(oc.h, paramValues) : oc.h;
    if (!Number.isFinite(ow) || !Number.isFinite(oh) || ow <= 0 || oh <= 0) continue;
    const ocRot = compRotationDeg(oc, paramValues);
    const dRot = dragRotationDeg || 0;
    for (const ta of ANCHORS) {
      const tlp = anchorLocalRotated(ta, ow, oh, ocRot);
      const tx = oc.cx + tlp.x;
      const ty = oc.cy + tlp.y;
      for (const da of ANCHORS) {
        const dlp = anchorLocalRotated(da, dw, dh, dRot);
        const dax = proposedCx + dlp.x;
        const day = proposedCy + dlp.y;
        const dist = Math.hypot(tx - dax, ty - day);
        if (dist <= worldThresh) {
          const cand = {
            kind: 'anchor', dist, dAnchor: da,
            target: { x: tx, y: ty, compId: oc.id, anchor: ta },
          };
          if (!best || dist < best.dist) best = cand;
          if (moveSnapHover && moveSnapHover.kind === 'anchor' &&
              moveSnapHover.compId === oc.id &&
              moveSnapHover.anchor === ta &&
              moveSnapHover.dAnchor === da) {
            currentBest = cand;
          }
        }
      }
    }
    const oxMin = oc.cx - ow / 2, oxMax = oc.cx + ow / 2;
    const oyMin = oc.cy - oh / 2, oyMax = oc.cy + oh / 2;
    const xOverlap = Math.min(oxMax, dxMax) - Math.max(oxMin, dxMin);
    const yOverlap = Math.min(oyMax, dyMax) - Math.max(oyMin, dyMin);
    const EDGE_RANK_PENALTY = worldThresh * 0.4;
    const tryEdge = (axis, dSide, dEdgeVal, tSide, tEdgeVal, midX, midY) => {
      const rawDist = Math.abs(dEdgeVal - tEdgeVal);
      if (rawDist > worldThresh) return;
      const cand = {
        kind: 'edge', dist: rawDist + EDGE_RANK_PENALTY, rawDist, axis,
        targetCompId: oc.id, targetSide: tSide, dSide,
        edgeVal: tEdgeVal, x: midX, y: midY,
      };
      if (!best || cand.dist < best.dist) best = cand;
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
      for (const [dSide, dY] of dSidesY) {
        for (const [tSide, tY] of tSidesY) {
          tryEdge('h', dSide, dY, tSide, tY, midX, tY);
        }
      }
    }
    if (yOverlap > 0) {
      const midY = (Math.max(oyMin, dyMin) + Math.min(oyMax, dyMax)) / 2;
      const dSidesX = [['right', dxMax], ['left', dxMin], ['centerX', proposedCx]];
      const tSidesX = [['right', oxMax], ['left', oxMin], ['centerX', oc.cx]];
      for (const [dSide, dX] of dSidesX) {
        for (const [tSide, tX] of tSidesX) {
          tryEdge('v', dSide, dX, tSide, tX, tX, midY);
        }
      }
    }
  }
  return { best, currentBest };
}

const expectSameCand = (got, want) => {
  if (!want) { expect(got).toBeFalsy(); return; }
  expect(got).toBeTruthy();
  expect(got.kind).toBe(want.kind);
  expect(got.dist).toBeCloseTo(want.dist, 9);
  if (want.kind === 'anchor') {
    expect(got.dAnchor).toBe(want.dAnchor);
    expect(got.target.compId).toBe(want.target.compId);
    expect(got.target.anchor).toBe(want.target.anchor);
    expect(got.target.x).toBeCloseTo(want.target.x, 9);
    expect(got.target.y).toBeCloseTo(want.target.y, 9);
  } else {
    expect(got.axis).toBe(want.axis);
    expect(got.targetCompId).toBe(want.targetCompId);
    expect(got.targetSide).toBe(want.targetSide);
    expect(got.dSide).toBe(want.dSide);
    expect(got.edgeVal).toBeCloseTo(want.edgeVal, 9);
    expect(got.rawDist).toBeCloseTo(want.rawDist, 9);
    expect(got.x).toBeCloseTo(want.x, 9);
    expect(got.y).toBeCloseTo(want.y, 9);
  }
};

// =========================================================================
// Grid primitives
// =========================================================================
describe('uniform grid primitives', () => {
  it('inserts and queries points by cell range', () => {
    const g = buildUniformGrid(10);
    // Enough occupied cells that a small query takes the precise cell-range
    // path (not the full-scan fallback, which may return a superset).
    gridInsert(g, 5, 5, 5, 5, 'a');
    gridInsert(g, 95, 95, 95, 95, 'b');
    gridInsert(g, 205, 5, 205, 5, 'c');
    gridInsert(g, 305, 105, 305, 105, 'd');
    gridInsert(g, -105, -105, -105, -105, 'e');
    const got = [];
    gridQuery(g, 2, 2, 8, 8, (it) => got.push(it));
    expect(got).toEqual(['a']);
  });

  it('visits a multi-cell item exactly once', () => {
    const g = buildUniformGrid(10);
    gridInsert(g, -5, -5, 25, 25, 'wide'); // spans many cells
    const got = [];
    gridQuery(g, -10, -10, 30, 30, (it) => got.push(it));
    expect(got).toEqual(['wide']);
  });

  it('falls back to a full occupied-cell scan for huge query ranges', () => {
    const g = buildUniformGrid(1);
    gridInsert(g, 0, 0, 0, 0, 'x');
    gridInsert(g, 1000, -1000, 1000, -1000, 'y');
    const got = new Set();
    gridQuery(g, -1e9, -1e9, 1e9, 1e9, (it) => got.add(it));
    expect(got).toEqual(new Set(['x', 'y']));
  });

  it('drops NaN-bounded insertions (matches old NaN-poisoned rejects)', () => {
    const g = buildUniformGrid(10);
    gridInsert(g, NaN, 0, NaN, 0, 'bad');
    const got = [];
    gridQuery(g, -1e9, -1e9, 1e9, 1e9, (it) => got.push(it));
    expect(got).toEqual([]);
  });

  it('pickGridCellSize: 2x median, clamped, with fallback', () => {
    expect(pickGridCellSize([])).toBe(10);
    expect(pickGridCellSize([4])).toBe(8);
    expect(pickGridCellSize([1, 2, 100])).toBe(4);          // median 2
    expect(pickGridCellSize([NaN, -5, 0, 6])).toBe(12);     // junk filtered
    expect(pickGridCellSize([1e-9, 1e-9, 1e-9])).toBe(1e-3); // floor
  });
});

// =========================================================================
// Anchor snap index ≡ original findAnchorSnap / findRulerSnap scan
// =========================================================================
const rectInst = (compId, idx, cx, cy, w, h, rotation = 0, extra = {}) =>
  ({ compId, idx, cx, cy, w, h, rotation, kind: 'rect', ...extra });

describe('buildAnchorSnapIndex / queryAnchorSnapIndex — equivalence with the old scan', () => {
  const instances = [
    rectInst('a', 0, 0, 0, 20, 10),
    rectInst('a', 1, 30, 0, 20, 10),          // repeat clone
    rectInst('b', 0, 10, 25, 12, 8, 30),      // rotated 30 deg
  ];
  const solved = [
    { id: 'a', kind: 'rect', cx: 0, cy: 0 },
    { id: 'b', kind: 'rect', cx: 10, cy: 25 },
  ];
  const index = buildAnchorSnapIndex(instances, solved);

  it('matches the oracle on a probe sweep (anchors, edges, repeats, rotation)', () => {
    for (let px = -15; px <= 45; px += 2.5) {
      for (let py = -10; py <= 35; py += 2.5) {
        for (const thresh of [0.8, 2.5, 8]) {
          const wp = { x: px, y: py };
          expectSameSnap(
            indexFindAnchorSnap(index, wp, thresh),
            oracleFindAnchorSnap(instances, solved, wp, thresh)
          );
        }
      }
    }
  });

  it('returns null beyond threshold', () => {
    expect(indexFindAnchorSnap(index, { x: 500, y: 500 }, 5)).toBeNull();
  });

  it('reports instanceIdx for non-base clones', () => {
    const hit = indexFindAnchorSnap(index, { x: 40.2, y: 5.1 }, 1);
    expect(hit).not.toBeNull();
    expect(hit.compId).toBe('a');
    expect(hit.anchor).toBe('NE'); // clone at cx=30: NE corner = (40, 5)
    expect(hit.instanceIdx).toBe(1);
  });

  it('prefers a fixed anchor over a same-distance edge projection (tie order)', () => {
    // Probe diagonally outside a's NE corner (10, 5): the T-edge projection
    // clamps to the corner — identical point, identical distance. The old
    // scan considered fixed anchors first; the index must agree.
    const hit = indexFindAnchorSnap(index, { x: 10.5, y: 5.5 }, 2);
    expect(hit.compId).toBe('a');
    expect(hit.anchor).toBe('NE');
  });

  it('first-in-enumeration wins exact cross-component ties', () => {
    // c1.E midpoint coincides with c2.W midpoint (touching rects).
    const insts2 = [
      rectInst('c1', 0, 0, 0, 10, 10),
      rectInst('c2', 0, 10, 0, 10, 10),
    ];
    const solved2 = [{ id: 'c1', kind: 'rect', cx: 0, cy: 0 }, { id: 'c2', kind: 'rect', cx: 10, cy: 0 }];
    const idx2 = buildAnchorSnapIndex(insts2, solved2);
    const got = indexFindAnchorSnap(idx2, { x: 5, y: 0 }, 0.5);
    const want = oracleFindAnchorSnap(insts2, solved2, { x: 5, y: 0 }, 0.5);
    expectSameSnap(got, want);
    expect(got.compId).toBe('c1'); // c1 enumerated first
    expect(got.anchor).toBe('E');
  });
});

describe('anchor snap index — boolean operand cells (idx > 0)', () => {
  const instances = [
    rectInst('r1', 0, 0, 0, 10, 10),
    rectInst('r2', 0, 10, 0, 10, 6),
    rectInst('b1', 0, 5, 0, 20, 10, 0, { kind: 'boolean' }),
    // Transformed copy: translated, rotated 90, mirrored in X.
    rectInst('b1', 1, 45, 20, 20, 10, 90, { kind: 'boolean', scaleX: -1 }),
  ];
  const solved = [
    { id: 'r1', kind: 'rect', cx: 0, cy: 0 },
    { id: 'r2', kind: 'rect', cx: 10, cy: 0 },
    { id: 'b1', kind: 'boolean', operandIds: ['r1', 'r2'], cx: 5, cy: 0 },
  ];
  const index = buildAnchorSnapIndex(instances, solved);

  it('matches the oracle across the transformed cell region', () => {
    for (let px = 30; px <= 60; px += 1.5) {
      for (let py = 5; py <= 35; py += 1.5) {
        for (const thresh of [1, 4]) {
          const wp = { x: px, y: py };
          expectSameSnap(
            indexFindAnchorSnap(index, wp, thresh),
            oracleFindAnchorSnap(instances, solved, wp, thresh)
          );
        }
      }
    }
  });

  it('excludeCompId: excluding the BOOLEAN removes its operand cells, excluding an operand does not', () => {
    const probes = [];
    for (let px = 30; px <= 60; px += 3) for (let py = 5; py <= 35; py += 3) probes.push({ x: px, y: py });
    for (const wp of probes) {
      for (const ex of ['b1', 'r1', 'r2']) {
        expectSameSnap(
          indexFindAnchorSnap(index, wp, 4, ex),
          oracleFindAnchorSnap(instances, solved, wp, 4, ex)
        );
      }
    }
    // Sanity on the semantics themselves: a hit attributed to r1's cell
    // under b1#1 survives excludeCompId='r1' (the old scan keyed the
    // exclusion on the boolean), but dies under excludeCompId='b1'.
    const anyCellHit = probes
      .map(wp => oracleFindAnchorSnap(instances, solved, wp, 4))
      .find(h => h && h.instanceIdx === 1 && (h.compId === 'r1' || h.compId === 'r2'));
    expect(anyCellHit).toBeTruthy();
  });
});

describe('anchor snap index — seeded fuzz vs oracle', () => {
  it('agrees with the oracle on 1500 random probes', () => {
    const rnd = mulberry32(0xC0FFEE);
    const instances = [];
    const solved = [];
    for (let i = 0; i < 22; i++) {
      const id = `f${i}`;
      const cx = (rnd() - 0.5) * 200;
      const cy = (rnd() - 0.5) * 200;
      const w = 1 + rnd() * 39;
      const h = 1 + rnd() * 39;
      const rot = rnd() < 0.4 ? rnd() * 360 - 180 : 0;
      solved.push({ id, kind: 'rect', cx, cy });
      instances.push(rectInst(id, 0, cx, cy, w, h, rot));
      if (rnd() < 0.3) {
        instances.push(rectInst(id, 1, cx + 10 + rnd() * 50, cy + (rnd() - 0.5) * 40, w, h, rot));
      }
    }
    const index = buildAnchorSnapIndex(instances, solved);
    for (let k = 0; k < 1500; k++) {
      const wp = { x: (rnd() - 0.5) * 260, y: (rnd() - 0.5) * 260 };
      const thresh = [0.7, 3, 12][k % 3];
      expectSameSnap(
        indexFindAnchorSnap(index, wp, thresh),
        oracleFindAnchorSnap(instances, solved, wp, thresh)
      );
    }
  });
});

// =========================================================================
// Alt-drag target index ≡ original solved × 81-pair scan
// =========================================================================
describe('buildAltDragTargetIndex / findAltDragSnapCandidate — equivalence', () => {
  const paramValues = {};
  const solved = [
    { id: 't1', kind: 'rect', cx: 0, cy: 0, w: '20', h: '10' },
    { id: 't2', kind: 'rect', cx: 40, cy: 5, w: '14', h: '14', rotation: '30' },
    { id: 't3', kind: 'rect', cx: -30, cy: -10, w: '8', h: '24' },
    { id: 'consumed', kind: 'rect', cx: 5, cy: 5, w: '6', h: '6', consumedBy: 'b1' },
    { id: 'dragged', kind: 'rect', cx: 100, cy: 100, w: '10', h: '10' },
  ];
  const dims = Object.fromEntries(solved.map(c => [c.id, { w: evalExpr(c.w, paramValues), h: evalExpr(c.h, paramValues) }]));
  const index = buildAltDragTargetIndex(solved, paramValues, dims);
  const clusterSet = new Set(['dragged']);

  const runBoth = (opts) => {
    const got = findAltDragSnapCandidate(index, opts);
    const want = oracleAltDrag(solved, paramValues, opts);
    expectSameCand(got.best, want.best);
    expectSameCand(got.currentBest, want.currentBest);
    return got;
  };

  it('anchor pair wins when aiming at a corner', () => {
    const got = runBoth({
      proposedCx: 14.6, proposedCy: 9.7, dw: 10, dh: 10,
      dragRotationDeg: 0, clusterSet, worldThresh: 2,
    });
    expect(got.best?.kind).toBe('anchor');
    expect(got.best?.target.compId).toBe('t1');
  });

  it('edge candidate (with rank penalty) wins when only an edge aligns', () => {
    // Dragged box overlapping t1 in x, bottom edge near t1's top edge but
    // x-positioned away from any anchor.
    const got = runBoth({
      proposedCx: 2, proposedCy: 11.2, dw: 6, dh: 12,
      dragRotationDeg: 0, clusterSet, worldThresh: 1.5,
    });
    expect(got.best?.kind).toBe('edge');
    expect(got.best?.targetCompId).toBe('t1');
    expect(got.best?.targetSide).toBe('top');
  });

  it('consumed operands and cluster members are excluded', () => {
    const got = runBoth({
      proposedCx: 5, proposedCy: 5, dw: 6, dh: 6,
      dragRotationDeg: 0, clusterSet: new Set(['dragged', 't1']), worldThresh: 3,
    });
    if (got.best && got.best.kind === 'anchor') {
      expect(['t2', 't3']).toContain(got.best.target.compId);
    }
    if (got.best && got.best.kind === 'edge') {
      expect(['t2', 't3']).toContain(got.best.targetCompId);
    }
  });

  it('tracks currentBest matching the prior moveSnapHover (anchor + edge kinds)', () => {
    const base = {
      proposedCx: 14.2, proposedCy: 9.4, dw: 10, dh: 10,
      dragRotationDeg: 0, clusterSet, worldThresh: 3,
    };
    const first = runBoth(base);
    expect(first.best?.kind).toBe('anchor');
    const hoverAnchor = {
      kind: 'anchor',
      compId: first.best.target.compId,
      anchor: first.best.target.anchor,
      dAnchor: first.best.dAnchor,
    };
    const second = runBoth({ ...base, proposedCx: 14.9, moveSnapHover: hoverAnchor });
    expect(second.currentBest).toBeTruthy();

    const edgeOpts = {
      proposedCx: 2, proposedCy: 11.2, dw: 6, dh: 12,
      dragRotationDeg: 0, clusterSet, worldThresh: 1.5,
    };
    const e1 = runBoth(edgeOpts);
    expect(e1.best?.kind).toBe('edge');
    const hoverEdge = {
      kind: 'edge', axis: e1.best.axis,
      targetCompId: e1.best.targetCompId,
      targetSide: e1.best.targetSide, dSide: e1.best.dSide,
    };
    const e2 = runBoth({ ...edgeOpts, proposedCy: 11.4, moveSnapHover: hoverEdge });
    expect(e2.currentBest).toBeTruthy();
  });

  it('rotation-aware on both sides (rotated target + rotated dragged comp)', () => {
    for (let px = 28; px <= 52; px += 1.7) {
      for (let py = -7; py <= 17; py += 1.7) {
        runBoth({
          proposedCx: px, proposedCy: py, dw: 9, dh: 5,
          dragRotationDeg: 45, clusterSet, worldThresh: 2.2,
        });
      }
    }
  });

  it('seeded fuzz: 800 random drag positions match the oracle', () => {
    const rnd = mulberry32(0xBEEF);
    const fuzzSolved = [];
    for (let i = 0; i < 18; i++) {
      fuzzSolved.push({
        id: `z${i}`, kind: 'rect',
        cx: (rnd() - 0.5) * 160, cy: (rnd() - 0.5) * 160,
        w: String((1 + rnd() * 30).toFixed(3)), h: String((1 + rnd() * 30).toFixed(3)),
        ...(rnd() < 0.35 ? { rotation: String(Math.round(rnd() * 180 - 90)) } : {}),
        ...(rnd() < 0.15 ? { consumedBy: 'someBool' } : {}),
      });
    }
    const fuzzDims = Object.fromEntries(fuzzSolved.map(c => [c.id, { w: evalExpr(c.w, paramValues), h: evalExpr(c.h, paramValues) }]));
    const fuzzIndex = buildAltDragTargetIndex(fuzzSolved, paramValues, fuzzDims);
    let lastHover = null;
    for (let k = 0; k < 800; k++) {
      const opts = {
        proposedCx: (rnd() - 0.5) * 200, proposedCy: (rnd() - 0.5) * 200,
        dw: 2 + rnd() * 20, dh: 2 + rnd() * 20,
        dragRotationDeg: k % 5 === 0 ? rnd() * 90 : 0,
        clusterSet: k % 7 === 0 ? new Set(['z0', 'z1']) : null,
        worldThresh: [0.8, 2.5, 6][k % 3],
        moveSnapHover: lastHover,
      };
      const got = findAltDragSnapCandidate(fuzzIndex, opts);
      const want = oracleAltDrag(fuzzSolved, paramValues, opts);
      expectSameCand(got.best, want.best);
      expectSameCand(got.currentBest, want.currentBest);
      // Occasionally feed the result back as the next hover, mirroring the
      // real drag loop's hysteresis input.
      if (got.best && got.best.kind === 'anchor' && k % 4 === 0) {
        lastHover = {
          kind: 'anchor',
          compId: got.best.target.compId,
          anchor: got.best.target.anchor,
          dAnchor: got.best.dAnchor,
        };
      } else if (got.best && got.best.kind === 'edge' && k % 4 === 0) {
        lastHover = {
          kind: 'edge', axis: got.best.axis,
          targetCompId: got.best.targetCompId,
          targetSide: got.best.targetSide, dSide: got.best.dSide,
        };
      } else if (k % 9 === 0) {
        lastHover = null;
      }
    }
  });
});

// =========================================================================
// buildBoolOverridesForInstance (F3 pure helper)
// =========================================================================
describe('buildBoolOverridesForInstance', () => {
  const compById = {
    b1: { id: 'b1', kind: 'boolean', operandIds: ['r1', 'r2'] },
    r1: { id: 'r1', kind: 'rect', cx: 0, cy: 0, w: '10', h: '10' },
    r2: { id: 'r2', kind: 'rect', cx: 10, cy: 0, w: '10', h: '6' },
  };
  const baseInsts = {
    r1: { compId: 'r1', idx: 0, cx: 0, cy: 0, w: 10, h: 10, rotation: 0 },
    r2: { compId: 'r2', idx: 0, cx: 10, cy: 0, w: 10, h: 6, rotation: 0 },
  };
  const baseInstOf = (c) => baseInsts[c.id];

  it('returns null for the identity transform', () => {
    const bInst = { cx: 5, cy: 0, rotation: 0 };
    expect(buildBoolOverridesForInstance(compById.b1, bInst, 5, 0, compById, baseInstOf)).toBeNull();
  });

  it('translates every primitive operand', () => {
    const bInst = { cx: 12, cy: 3, rotation: 0 };
    const ov = buildBoolOverridesForInstance(compById.b1, bInst, 5, 0, compById, baseInstOf);
    expect(ov.r1.cx).toBeCloseTo(7, 12);  // 0 + (12-5)
    expect(ov.r1.cy).toBeCloseTo(3, 12);
    expect(ov.r2.cx).toBeCloseTo(17, 12);
    expect(ov.r2.cy).toBeCloseTo(3, 12);
    expect(ov.r1.rotation).toBe(0);
  });

  it('rotates about the instance centroid and accumulates operand rotation', () => {
    const bInst = { cx: 5, cy: 0, rotation: 90 };
    const ov = buildBoolOverridesForInstance(compById.b1, bInst, 5, 0, compById, baseInstOf);
    // r1 at (0,0): offset (-5, 0) from centroid → rotated 90 CCW → (0, -5)
    expect(ov.r1.cx).toBeCloseTo(5, 12);
    expect(ov.r1.cy).toBeCloseTo(-5, 12);
    // r2 at (10,0): offset (5, 0) → (0, 5)
    expect(ov.r2.cx).toBeCloseTo(5, 12);
    expect(ov.r2.cy).toBeCloseTo(5, 12);
    expect(ov.r1.rotation).toBe(90);
  });

  it('mirrors positions and flips operand scale flags', () => {
    const bInst = { cx: 5, cy: 0, rotation: 0, scaleX: -1 };
    const ov = buildBoolOverridesForInstance(compById.b1, bInst, 5, 0, compById, baseInstOf);
    expect(ov.r1.cx).toBeCloseTo(10, 12); // 2*5 - 0
    expect(ov.r2.cx).toBeCloseTo(0, 12);  // 2*5 - 10
    expect(ov.r1.scaleX).toBe(-1);
    expect(ov.r1.scaleY).toBe(1);
  });

  it('recurses through nested booleans, transforming only primitives', () => {
    const nested = {
      top: { id: 'top', kind: 'boolean', operandIds: ['b1', 'r3'] },
      b1: compById.b1, r1: compById.r1, r2: compById.r2,
      r3: { id: 'r3', kind: 'rect', cx: -8, cy: 4, w: '4', h: '4' },
    };
    const nestedBase = { ...baseInsts, r3: { compId: 'r3', idx: 0, cx: -8, cy: 4, w: 4, h: 4, rotation: 0 } };
    const bInst = { cx: 1, cy: 2, rotation: 0 };
    const ov = buildBoolOverridesForInstance(nested.top, bInst, 0, 0, nested, (c) => nestedBase[c.id]);
    expect(Object.keys(ov).sort()).toEqual(['r1', 'r2', 'r3']);
    expect(ov.b1).toBeUndefined();
    expect(ov.r3.cx).toBeCloseTo(-7, 12);
    expect(ov.r3.cy).toBeCloseTo(6, 12);
  });
});
