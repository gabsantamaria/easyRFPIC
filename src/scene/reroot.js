// Re-root a snap chain: orient every snap in the connected component
// reachable from `rootId` to point AWAY from it, so `rootId` becomes the
// free parent everything else follows. Pure — returns { params, snaps,
// components } for the next scene (PhotonicLayout's reRootSnapChain
// delegates here).
//
// TWO geometry-preservation rules (both were real shipped bugs — the
// user's "everything falls apart" on re-root):
//
// 1. GEOMETRY-PRESERVING FLIPS. Swap-endpoints + negate-offsets is
//    exact only when each anchor resolves to the SAME point in both
//    snap roles — true for rect-frame kinds, FALSE for path kinds
//    (polyline/polyshape): as a CHILD their anchors collapse to the
//    vertex-0 root, as a PARENT they sit on the displayBbox frame.
//    Flipping a snap through a polyshape with plain negation shifted
//    the whole upstream chain by the frame-to-v0 offset. For flips
//    involving a path-kind endpoint (or a replica from.instanceIdx,
//    which cannot survive on the child side and is dropped), the
//    offset is RECOMPUTED from the solved layout:
//      dNew = childPoint(newChild = old parent)
//           − parentAnchor(newParent = old child)
//    keeping every component byte-exactly where it is. The old
//    expression stays symbolically live when plain negation already
//    lands right; otherwise the exact numeric correction is appended
//    (frozen at current values — the same accepted contract as other
//    frame-offset freezes).
//
// 2. ROOT POSITION BAKE. A snap child's raw cx/cy drifts stale — the
//    solver overwrites its position every solve, so nothing keeps the
//    stored numbers current. Promoting a stale child to root made the
//    ENTIRE assembly rigidly jump to wherever the raw cx/cy happened
//    to be. The new root's cx/cy is therefore baked to its SOLVED
//    (pre-mirror — the frame snaps act in) position, and any inert
//    cxExpr/cyExpr on it are stripped (they were ignored while it was
//    snap-bound; letting them go live on re-root would jump the chain
//    to wherever the expr points).
//
// Offset rewriting is TWO-PASS: BFS first decides which snaps flip,
// THEN offsets are rewritten with the full flip set known. A lone-param
// offset (`dx: "gap_x3"`) is negated IN PLACE on the param (staying
// symbolically live) only when EVERY reference to that param sits in a
// flipped offset — so all of them keep the bare name and stay
// consistent. Any outside reference (a kept snap, a component w/h, a
// cutout, another param's expr) forces the safe per-offset -(...) wrap
// instead. (The old single-pass version had two latent sign bugs: a
// param shared by two flipped offsets got wrapped on the second —
// double-negating it back to the original sign — and a param shared
// with a NON-flipped snap could be negated in place, silently flipping
// the kept snap.)
import { resolveParams, evalExpr, tokenizeIdents } from './params.js';
import { solveLayout } from './solver.js';
import { anchorLocalRotated, anchorLocalInstance, anchorWorld, compRotationDeg, PATH_KINDS } from './anchors.js';
import { expandTransforms } from './transforms.js';
import { instanceFrameCenter } from './instance-positions.js';

const BARE_PARAM_RE = /^[A-Za-z_][\w]*$/;

export function reRootSnaps(scene, rootId) {
  const pv = resolveParams(scene.params || {}).values;
  // Pre-mirror solve: snap constraints act BEFORE applyMirrors, so both
  // the offset capture and the root bake must use this frame.
  const solved = solveLayout(scene.components || [], scene.snaps || [], pv);
  const solvedById = Object.fromEntries(solved.map(c => [c.id, c]));
  // Where the SOLVER pins a snap's CHILD: path kinds by their vertex-0
  // root (cx, cy); everything else by the (rotation-aware) anchor on the
  // solved bbox — mirrors solveLayout's toLocal exactly.
  // Moved-base probe (solver twin, POSITION-only): a chain that moves
  // instance 0 (rotate pivot:'group'/non-'C', displace, duplicate_mirror)
  // makes the solver pin the RENDERED anchor for this comp as a snap
  // CHILD — the re-rooted offset must be captured against that point or
  // the assembly teleports on make-root (adversarial-review find).
  const chainMoved = (comp) => {
    if (!comp || !(comp.transforms || []).some(t => t && t.enabled !== false)) return false;
    const w = typeof comp.w === 'number' ? comp.w : evalExpr(comp.w, pv);
    const h = typeof comp.h === 'number' ? comp.h : evalExpr(comp.h, pv);
    const insts = expandTransforms([{
      ...comp,
      w: Number.isFinite(w) ? w : 0,
      h: Number.isFinite(h) ? h : 0,
    }], pv, solved);
    const i0 = insts.find(i => i.idx === 0);
    if (!i0 || !Number.isFinite(i0.cx) || !Number.isFinite(i0.cy)) return false;
    return Math.abs(i0.cx - comp.cx) > 1e-9 || Math.abs(i0.cy - comp.cy) > 1e-9;
  };
  const childPoint = (comp, anchor, parentComp = null) => {
    if (!comp) return null;
    // Rendered instance-0 point for moved-base children — EXCEPT when the
    // new snap is intra-group (legacy base placement in the solver) or
    // the child is a boolean (cluster-shift branch, base semantics).
    const parentInGroup = !!comp.group && parentComp && parentComp.group === comp.group;
    if (comp.kind !== 'boolean' && !parentInGroup && chainMoved(comp)) {
      const w = typeof comp.w === 'number' ? comp.w : evalExpr(comp.w, pv);
      const h = typeof comp.h === 'number' ? comp.h : evalExpr(comp.h, pv);
      const insts = expandTransforms([{
        ...comp,
        w: Number.isFinite(w) ? w : 0,
        h: Number.isFinite(h) ? h : 0,
      }], pv, solved);
      const i0 = insts.find(i => i.idx === 0);
      if (i0 && Number.isFinite(i0.cx) && Number.isFinite(i0.cy)) {
        if (PATH_KINDS.has(comp.kind)) return { x: i0.cx, y: i0.cy };
        const lp = anchorLocalInstance(anchor, i0.w, i0.h, i0.rotation || 0, i0.scaleX ?? 1, i0.scaleY ?? 1);
        const fc = instanceFrameCenter(comp, i0);
        return { x: fc.cx + lp.x, y: fc.cy + lp.y };
      }
    }
    if (PATH_KINDS.has(comp.kind)) return { x: comp.cx, y: comp.cy };
    const w = typeof comp.w === 'number' ? comp.w : evalExpr(comp.w, pv);
    const h = typeof comp.h === 'number' ? comp.h : evalExpr(comp.h, pv);
    if (!Number.isFinite(w) || !Number.isFinite(h)) return null;
    const l = anchorLocalRotated(anchor, w, h, compRotationDeg(comp, pv));
    return { x: comp.cx + l.x, y: comp.cy + l.y };
  };

  // ---- PASS 1: BFS from rootId over the undirected snap graph. Decide
  // orientation only — no offset rewriting yet.
  const visited = new Set([rootId]);
  const queue = [rootId];
  const handledSnapIds = new Set();
  const ordered = []; // { snap, flip } in BFS order
  while (queue.length > 0) {
    const here = queue.shift();
    for (const s of scene.snaps || []) {
      if (handledSnapIds.has(s.id)) continue;
      if (s.from.compId === here && !visited.has(s.to.compId)) {
        // Already pointing away — keep as-is.
        ordered.push({ snap: s, flip: false });
        handledSnapIds.add(s.id);
        visited.add(s.to.compId);
        queue.push(s.to.compId);
      } else if (s.to.compId === here && !visited.has(s.from.compId)) {
        ordered.push({ snap: s, flip: true });
        handledSnapIds.add(s.id);
        visited.add(s.from.compId);
        queue.push(s.from.compId);
      }
      // Both endpoints already visited: a cycle edge — keep as-is (a
      // cycle can't be sensibly re-rooted).
    }
  }

  // ---- PASS 1.5: decide each flipped offset's rewrite MODE before any
  // param is touched. 'sym' = plain symbolic negation suffices; 'corr' =
  // solved-position capture disagrees with plain negation, append the
  // numeric correction; 'num' = old expr unevaluable, bake the capture.
  // Modes must be known up front: in-place param negation is only safe
  // when EVERY reference to the param is a 'sym' lone-param offset — a
  // 'corr' offset wraps -(param), so a param shared between a 'sym' and
  // a 'corr' offset must NOT be negated in place (the wrap would
  // double-negate).
  const axisPlan = new Map(); // snapId -> { dx: {mode, corr?, cap?}, dy: {...} }
  for (const { snap: s, flip } of ordered) {
    if (!flip) continue;
    const oldParent = solvedById[s.from.compId];
    const oldChild = solvedById[s.to.compId];
    const hadIdx = Number.isInteger(s.from.instanceIdx);
    const involvesPath = (oldParent && PATH_KINDS.has(oldParent.kind))
      || (oldChild && PATH_KINDS.has(oldChild.kind));
    let plan = { dx: { mode: 'sym' }, dy: { mode: 'sym' } };
    const movedEnds = chainMoved(oldParent) || chainMoved(oldChild);
    if ((involvesPath || hadIdx || movedEnds) && oldParent && oldChild) {
      const pA = anchorWorld(oldChild, s.to.anchor, pv); // new parent anchor (frame-aware)
      const cP = childPoint(oldParent, s.from.anchor, oldChild); // new child pin point
      if (pA && cP && [pA.x, pA.y, cP.x, cP.y].every(Number.isFinite)) {
        const axis = (cap, oldVal) => {
          const corr = Number.isFinite(oldVal) ? cap + oldVal : null;
          if (corr == null) return { mode: 'num', cap };
          return Math.abs(corr) < 1e-6 ? { mode: 'sym' } : { mode: 'corr', corr };
        };
        plan = {
          dx: axis(cP.x - pA.x, evalExpr(s.dx, pv)),
          dy: axis(cP.y - pA.y, evalExpr(s.dy, pv)),
        };
      }
    }
    axisPlan.set(s.id, plan);
  }

  // ---- Param in-place-negation eligibility: every reference to the
  // param (across snaps, component dims, cutouts, other param exprs)
  // must be a lone-param dx/dy of a flipped offset in 'sym' mode.
  const totalRefCount = (paramName) => {
    let n = 0;
    for (const sn of scene.snaps || []) {
      if (typeof sn.dx === 'string' && tokenizeIdents(sn.dx).includes(paramName)) n++;
      if (typeof sn.dy === 'string' && tokenizeIdents(sn.dy).includes(paramName)) n++;
    }
    for (const c of scene.components || []) {
      for (const f of ['w', 'h', 'r', 'rx', 'ry', 'rotation', 'zOffset', 'cxExpr', 'cyExpr']) {
        if (typeof c[f] === 'string' && tokenizeIdents(c[f]).includes(paramName)) n++;
      }
      for (const cu of (c.cutouts || [])) {
        for (const f of ['dx', 'dy', 'w', 'h']) {
          if (typeof cu[f] === 'string' && tokenizeIdents(cu[f]).includes(paramName)) n++;
        }
      }
      for (const v of (c.vertices || [])) {
        for (const f of ['dx', 'dy', 'cdx', 'cdy', 'angle', 'width']) {
          if (typeof v[f] === 'string' && tokenizeIdents(v[f]).includes(paramName)) n++;
        }
      }
      for (const t of (c.transforms || [])) {
        for (const f of ['dx', 'dy', 'angle', 'px', 'py', 'n']) {
          if (typeof t[f] === 'string' && tokenizeIdents(t[f]).includes(paramName)) n++;
        }
      }
    }
    for (const [, p] of Object.entries(scene.params || {})) {
      if (typeof p.expr === 'string' && tokenizeIdents(p.expr).includes(paramName)) n++;
    }
    return n;
  };
  const flippedSymLoneRefCount = (paramName) => {
    let n = 0;
    for (const e of ordered) {
      if (!e.flip) continue;
      const plan = axisPlan.get(e.snap.id);
      if (plan?.dx.mode === 'sym' && typeof e.snap.dx === 'string' && e.snap.dx.trim() === paramName) n++;
      if (plan?.dy.mode === 'sym' && typeof e.snap.dy === 'string' && e.snap.dy.trim() === paramName) n++;
    }
    return n;
  };

  const newParams = { ...(scene.params || {}) };
  const negatedInPlace = new Set();
  const negateOffset = (offsetExpr) => {
    if (typeof offsetExpr !== 'string') return offsetExpr;
    const stripped = offsetExpr.trim();
    if (BARE_PARAM_RE.test(stripped) && newParams[stripped]) {
      // Already negated in place by an earlier flip in THIS run: the bare
      // name now evaluates to the negated value — keep it verbatim.
      if (negatedInPlace.has(stripped)) return stripped;
      if (flippedSymLoneRefCount(stripped) === totalRefCount(stripped)) {
        const old = newParams[stripped].expr;
        newParams[stripped] = { ...newParams[stripped], expr: `-(${old})` };
        negatedInPlace.add(stripped);
        return stripped;
      }
    }
    return `-(${offsetExpr})`;
  };
  // Numeric-correction form: -(old) ± |corr| (sign-aware for readability).
  const negatedWithCorr = (offsetExpr, corr) => {
    const n = Number(corr.toFixed(4));
    return n >= 0 ? `-(${offsetExpr}) + ${n}` : `-(${offsetExpr}) - ${Math.abs(n)}`;
  };

  // ---- PASS 2: rewrite in BFS order, consuming the axis plan.
  const applyAxis = (expr, ax) => {
    if (!ax || ax.mode === 'sym') return negateOffset(expr);
    if (ax.mode === 'corr') return negatedWithCorr(expr, ax.corr);
    return `${Number(ax.cap.toFixed(4))}`; // 'num'
  };
  const newSnaps = [];
  for (const { snap: s, flip } of ordered) {
    if (!flip) { newSnaps.push(s); continue; }
    // Flip (see header for the frame math). The replica instanceIdx is
    // dropped: it lives only on the `from` side, and the old parent is
    // now the child.
    const plan = axisPlan.get(s.id);
    newSnaps.push({
      ...s,
      from: { compId: s.to.compId, anchor: s.to.anchor },
      to:   { compId: s.from.compId, anchor: s.from.anchor },
      dx: applyAxis(s.dx, plan?.dx),
      dy: applyAxis(s.dy, plan?.dy),
    });
  }
  // Snaps outside the reachable component (disconnected sub-graphs) keep
  // their orientation.
  for (const s of scene.snaps || []) {
    if (!handledSnapIds.has(s.id)) newSnaps.push(s);
  }

  // Bake the new root's solved position (rule 2 in the header). For path
  // kinds the solved cx/cy IS the vertex-0 root — exactly what the raw
  // field stores. Vertex data is untouched.
  const rootSolved = solvedById[rootId];
  const newComponents = (scene.components || []).map(c => {
    if (c.id !== rootId || !rootSolved) return c;
    if (!Number.isFinite(rootSolved.cx) || !Number.isFinite(rootSolved.cy)) return c;
    const baked = { ...c, cx: rootSolved.cx, cy: rootSolved.cy };
    delete baked.cxExpr;
    delete baked.cyExpr;
    return baked;
  });
  return { params: newParams, snaps: newSnaps, components: newComponents };
}
