// Per-instance anchor resolution for transform-replicated components.
//
// A polyline vertex (or any future feature) can bind to a specific
// instance of a transformed component — e.g. the 7th cell of a 16-way
// repeated meander rail. Two cases need handling:
//
//   (a) The COMPONENT itself has the transforms. instanceIdx indexes
//       into its own expansion stream. Position = base + chain offset
//       at idx.
//
//   (b) The component is an OPERAND of a boolean cluster, and the
//       BOOLEAN has the transforms. instanceIdx indexes into the
//       boolean's expansion stream. The operand's position at instance
//       N = operand_base + (boolean_instance_N − boolean_base) — the
//       boolean's chain offset translated onto the operand's base
//       position.
//
// We support `repeat` and `displace` transforms parametrically. Mirror,
// duplicate_mirror, and rotate are baked numerically (the position is
// known from `transformInstances`, but expressing it as a parametric
// HFSS expression would require sign-flip / sin-cos terms that the
// caller can fall back to numeric when needed). The export pipeline
// uses these helpers and falls back to a numeric position when the
// chain isn't parametric-friendly.
import { evalExpr } from './params.js';
import { anchorLocal } from './anchors.js';

// Look up an instance's NUMERIC center for (compId, idx). Falls back
// through the operand-of-boolean case if compId itself doesn't have
// instance idx (it's not transform-replicated; its parent boolean is).
// Returns { cx, cy, w, h } or null.
export function resolveInstanceCenterNumeric(compId, idx, byId, transformInstances) {
  // Case A: the component has its own instance at idx.
  const ownInst = transformInstances.find(i => i.compId === compId && i.idx === idx);
  if (ownInst && idx > 0) {
    return { cx: ownInst.cx, cy: ownInst.cy, w: ownInst.w, h: ownInst.h, rotation: ownInst.rotation || 0 };
  }
  // Case B: operand of a boolean whose cluster is transform-replicated.
  const comp = byId[compId];
  if (comp && comp.consumedBy) {
    const boolInst = transformInstances.find(i => i.compId === comp.consumedBy && i.idx === idx);
    const boolBase = transformInstances.find(i => i.compId === comp.consumedBy && i.idx === 0);
    if (boolInst && boolBase && idx > 0) {
      const dx = boolInst.cx - boolBase.cx;
      const dy = boolInst.cy - boolBase.cy;
      const opBase = transformInstances.find(i => i.compId === compId && i.idx === 0);
      if (opBase) {
        // For repeat/displace this is exact. For mirror / rotate on the
        // boolean, this is approximate (ignores axis flip / rotation
        // of the operand's local frame); good enough for hover-snap
        // landing, callers needing precision use transformInstances
        // directly via findRulerSnap's existing operand-walking code.
        return { cx: opBase.cx + dx, cy: opBase.cy + dy, w: opBase.w, h: opBase.h, rotation: boolInst.rotation || 0 };
      }
    }
  }
  // Case C: no instance found — fall back to base.
  if (comp && (comp.kind || 'rect') !== 'boolean') {
    const w = typeof comp.w === 'number' ? comp.w : 0;
    const h = typeof comp.h === 'number' ? comp.h : 0;
    return { cx: comp.cx, cy: comp.cy, w, h, rotation: 0 };
  }
  return null;
}

// World position of an anchor on (compId, anchor, instanceIdx). Used
// by polyline vertex resolution when a vertex has kind: 'snap' with
// instanceIdx > 0.
export function resolveInstanceAnchorNumeric(compId, anchor, instanceIdx, byId, transformInstances, paramValues) {
  const inst = resolveInstanceCenterNumeric(compId, instanceIdx, byId, transformInstances);
  if (!inst) return null;
  if (!Number.isFinite(inst.w) || !Number.isFinite(inst.h)) return null;
  const lp = anchorLocal(anchor, inst.w, inst.h);
  // For repeat/displace there's no rotation on the operand; ignore the
  // rotation field (set when the boolean has a rotate transform).
  return { x: inst.cx + lp.x, y: inst.cy + lp.y };
}

// Build the parametric expression for an instance's centroid OFFSET
// from its base centroid. Returns { dxExpr, dyExpr } or null if the
// transform chain contains operations we can't express parametrically
// (mirror, rotate, duplicate_mirror — those keep numeric positions).
//
// The instanceIdx is the FLAT index used by expandTransforms (it
// decomposes into a tuple under nested repeats). We re-walk the chain
// keeping per-instance parametric (dx, dy) expressions and look up the
// target idx in the resulting stream.
//
// `exprWithUm` is passed in by the caller (HFSS export's helper).
export function instanceChainOffsetExpr(comp, instanceIdx, paramValues, exprWithUm) {
  if (!comp || instanceIdx === 0) return { dxExpr: '0um', dyExpr: '0um' };
  const transforms = (comp.transforms || []).filter(t => t && t.enabled !== false);
  // Stream of { dxExpr, dyExpr } — each entry is one instance's offset
  // from the base. Starts with the base (idx 0) at zero offset.
  let stream = [{ dxExpr: '0um', dyExpr: '0um' }];
  for (const t of transforms) {
    if (t.kind === 'displace') {
      const dxExpr = exprWithUm(t.dx ?? '0');
      const dyExpr = exprWithUm(t.dy ?? '0');
      stream = stream.map(item => ({
        dxExpr: `(${item.dxExpr}) + (${dxExpr})`,
        dyExpr: `(${item.dyExpr}) + (${dyExpr})`,
      }));
    } else if (t.kind === 'repeat') {
      const n = Math.max(0, Math.floor(evalExpr(t.n ?? '0', paramValues) || 0));
      if (n < 1) continue;
      const includeOriginal = t.includeOriginal !== false;
      const dxExpr = exprWithUm(t.dx ?? '0');
      const dyExpr = exprWithUm(t.dy ?? '0');
      const next = [];
      for (const item of stream) {
        if (includeOriginal) next.push(item);
        for (let k = 1; k <= n; k++) {
          next.push({
            dxExpr: `(${item.dxExpr}) + ${k} * (${dxExpr})`,
            dyExpr: `(${item.dyExpr}) + ${k} * (${dyExpr})`,
          });
        }
      }
      stream = next;
    } else {
      // mirror / rotate / duplicate_mirror: parametric chain bails out
      // for now. Caller falls back to numeric instance position from
      // transformInstances (handled in the HFSS polyline emission).
      return null;
    }
  }
  if (instanceIdx < 0 || instanceIdx >= stream.length) return null;
  return stream[instanceIdx];
}

// Determine which component "owns" the transform chain for an
// instance-bound snap. For a primitive with its own transforms, that's
// the component itself. For an operand consumed by a boolean cluster,
// it's the boolean (whose transforms drive the cluster's instances).
export function chainOwnerForInstance(comp, byId) {
  if (!comp) return null;
  const hasOwn = (comp.transforms || []).some(t => t && t.enabled !== false);
  if (hasOwn) return comp;
  if (comp.consumedBy) {
    const parent = byId[comp.consumedBy];
    if (parent && (parent.transforms || []).some(t => t && t.enabled !== false)) {
      return parent;
    }
  }
  return null;
}
