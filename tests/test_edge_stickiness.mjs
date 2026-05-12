// Verify anchor-on-edge stickiness override logic.
//
// Simulates the alt-drag scenario where the cluster is sliding along
// a target's top edge. As the cursor passes near the target's NW / N /
// NE anchors, the override should promote the edge candidate to an
// anchor snap.

import { anchorLocal, ANCHORS } from '../src/scene/anchors.js';

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log(`  ok: ${msg}`);
  else { console.error(`  FAIL: ${msg}`); failures++; }
}

// Mirror the override math from Canvas.jsx without React.
function computeBest({ targetCx, targetCy, ow, oh, proposedCx, proposedCy, dw, dh, worldThresh }) {
  // Cluster bbox at proposed position.
  const dxMin = proposedCx - dw / 2, dxMax = proposedCx + dw / 2;
  const dyMin = proposedCy - dh / 2, dyMax = proposedCy + dh / 2;
  const oxMin = targetCx - ow / 2, oxMax = targetCx + ow / 2;
  const oyMin = targetCy - oh / 2, oyMax = targetCy + oh / 2;
  const xOverlap = Math.min(oxMax, dxMax) - Math.max(oxMin, dxMin);
  const yOverlap = Math.min(oyMax, dyMax) - Math.max(oyMin, dyMin);

  // Main anchor pass.
  let best = null;
  for (const ta of ANCHORS) {
    const tlp = anchorLocal(ta, ow, oh);
    const tx = targetCx + tlp.x;
    const ty = targetCy + tlp.y;
    for (const da of ANCHORS) {
      const dlp = anchorLocal(da, dw, dh);
      const dax = proposedCx + dlp.x;
      const day = proposedCy + dlp.y;
      const dist = Math.hypot(tx - dax, ty - day);
      if (dist <= worldThresh) {
        const cand = { kind: 'anchor', dist, dAnchor: da, target: { x: tx, y: ty, anchor: ta } };
        if (!best || dist < best.dist) best = cand;
      }
    }
  }

  // Edge pass.
  const EDGE_RANK_PENALTY = worldThresh * 0.4;
  const tryEdge = (axis, dSide, dEdgeVal, tSide, tEdgeVal) => {
    const rawDist = Math.abs(dEdgeVal - tEdgeVal);
    if (rawDist > worldThresh) return;
    const cand = {
      kind: 'edge', dist: rawDist + EDGE_RANK_PENALTY, rawDist, axis,
      targetSide: tSide, dSide, edgeVal: tEdgeVal,
    };
    if (!best || cand.dist < best.dist) best = cand;
  };
  if (xOverlap > 0) {
    const dSidesY = [['top', dyMax], ['bottom', dyMin], ['centerY', proposedCy]];
    const tSidesY = [['top', oyMax], ['bottom', oyMin], ['centerY', targetCy]];
    for (const [dSide, dY] of dSidesY) {
      for (const [tSide, tY] of tSidesY) {
        tryEdge('h', dSide, dY, tSide, tY);
      }
    }
  }
  if (yOverlap > 0) {
    const dSidesX = [['right', dxMax], ['left', dxMin], ['centerX', proposedCx]];
    const tSidesX = [['right', oxMax], ['left', oxMin], ['centerX', targetCx]];
    for (const [dSide, dX] of dSidesX) {
      for (const [tSide, tX] of tSidesX) {
        tryEdge('v', dSide, dX, tSide, tX);
      }
    }
  }

  // Stickiness override (index-paired natural alignments only).
  if (best && best.kind === 'edge') {
    const freeAxisLen = best.axis === 'h' ? ow : oh;
    const STICKY = Math.max(worldThresh * 2, freeAxisLen * 0.2);
    const edgeAnchorMap = {
      h: { top: ['NW','N','NE'], bottom: ['SW','S','SE'], centerY: ['W','C','E'] },
      v: { left: ['NW','W','SW'], right: ['NE','E','SE'], centerX: ['N','C','S'] },
    };
    const tAnchorList = edgeAnchorMap[best.axis]?.[best.targetSide] || [];
    const dAnchorList = edgeAnchorMap[best.axis]?.[best.dSide] || [];
    if (tAnchorList.length && dAnchorList.length) {
      let stickBest = null;
      const pairCount = Math.min(tAnchorList.length, dAnchorList.length);
      for (let i = 0; i < pairCount; i++) {
        const ta = tAnchorList[i];
        const da = dAnchorList[i];
        const tlp = anchorLocal(ta, ow, oh);
        const tx = targetCx + tlp.x;
        const ty = targetCy + tlp.y;
        const dlp = anchorLocal(da, dw, dh);
        const dax = proposedCx + dlp.x;
        const day = proposedCy + dlp.y;
        const freeDist = best.axis === 'h' ? Math.abs(tx - dax) : Math.abs(ty - day);
        if (freeDist <= STICKY) {
          const cand = { kind: 'anchor', dist: freeDist, dAnchor: da, target: { x: tx, y: ty, anchor: ta } };
          if (!stickBest || freeDist < stickBest.dist) stickBest = cand;
        }
      }
      if (stickBest) best = stickBest;
    }
  }
  return best;
}

// Scenario: target 100x100 at origin. Cluster 20x20.
// worldThresh = 10. STICKY = max(20, ow*0.2) = max(20, 20) = 20.
const ctx = { targetCx: 0, targetCy: 0, ow: 100, oh: 100, dw: 20, dh: 20, worldThresh: 10 };

console.log('Scenario A: small target, cluster sliding along top.');

// Cluster sitting on top, perfectly aligned at N midpoint.
{
  const b = computeBest({ ...ctx, proposedCx: 0, proposedCy: 60 });
  assert(b && b.kind === 'anchor' && b.target.anchor === 'N', `centered: anchor N (got ${b && b.kind} ${b && b.target && b.target.anchor})`);
}

// Slid 15 right. N-S freeDist=15 (in STICKY=20). NE-SE freeDist=25 (out). N wins.
{
  const b = computeBest({ ...ctx, proposedCx: 15, proposedCy: 60 });
  assert(b && b.kind === 'anchor' && b.target.anchor === 'N', `slid right 15: stick to N (got ${b && b.kind} ${b && b.target && b.target.anchor})`);
}

// Slid 30 right. N-S freeDist=30 (out). NE-SE freeDist=10 (in). NE wins.
{
  const b = computeBest({ ...ctx, proposedCx: 30, proposedCy: 60 });
  assert(b && b.kind === 'anchor' && b.target.anchor === 'NE', `slid right 30: stick to NE (got ${b && b.kind} ${b && b.target && b.target.anchor})`);
}

// Slid 40 right. NE-SE freeDist=0. NE wins.
{
  const b = computeBest({ ...ctx, proposedCx: 40, proposedCy: 60 });
  assert(b && b.kind === 'anchor' && b.target.anchor === 'NE', `slid right 40: stick to NE (got ${b && b.kind} ${b && b.target && b.target.anchor})`);
}

// Slid well past NE: no snap.
{
  const b = computeBest({ ...ctx, proposedCx: 90, proposedCy: 60 });
  assert(!b, `slid well past NE: no snap (got ${b && b.kind})`);
}

// Scenario B: user's reported case — long thin top edge, small cluster sliding.
// Top target: 1000 wide, 30 tall at origin. STICKY = max(20, 200) = 200.
console.log('\nScenario B: long top edge, small cluster sliding (user case).');
const ctxB = { targetCx: 0, targetCy: 0, ow: 1000, oh: 30, dw: 80, dh: 250, worldThresh: 10 };
// Cluster top edge on target bottom edge: cluster.cy = -15 - 125 = -140.

// Slid to proposedCx=300 (cursor far from anywhere). NE freeDist=200 (boundary). N freeDist=300 (out). NE wins.
{
  const b = computeBest({ ...ctxB, proposedCx: 300, proposedCy: -140 });
  assert(b && b.kind === 'anchor' && b.target.anchor === 'SE', `slid right 300: stick to SE corner (got ${b && b.kind} ${b && b.target && b.target.anchor})`);
}

// Slid to proposedCx=200. N freeDist=200 (boundary). SE freeDist=300 (out). N wins (S anchor).
{
  const b = computeBest({ ...ctxB, proposedCx: 200, proposedCy: -140 });
  assert(b && b.kind === 'anchor' && b.target.anchor === 'S', `slid right 200: stick to S midpoint (got ${b && b.kind} ${b && b.target && b.target.anchor})`);
}

// At target midpoint (proposedCx=0): S freeDist=0. Sticks hard.
{
  const b = computeBest({ ...ctxB, proposedCx: 0, proposedCy: -140 });
  assert(b && b.kind === 'anchor' && b.target.anchor === 'S', `at midpoint: stick to S (got ${b && b.kind} ${b && b.target && b.target.anchor})`);
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${failures} failures`);
process.exit(failures > 0 ? 1 : 0);
