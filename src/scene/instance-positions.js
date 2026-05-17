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
// transform chain contains operations we genuinely can't express
// parametrically (currently: rotate with pivot='group' or a named-
// anchor pivot, since both depend on group-centroid math or
// post-rotation pivot positions).
//
// The instanceIdx is the FLAT index used by expandTransforms (it
// decomposes into a tuple under nested repeats). We re-walk the chain
// keeping per-instance parametric (dx, dy) expressions and look up the
// target idx in the resulting stream.
//
// `exprWithUm` is passed in by the caller (HFSS export's helper).
// `baseCxExpr` / `baseCyExpr` are required for transforms that
// reference the component's own absolute position (mirror about
// origin, rotate about origin). For the simple case (repeat /
// displace / duplicate_mirror only), they're unused.
export function instanceChainOffsetExpr(comp, instanceIdx, paramValues, exprWithUm, baseCxExpr = '0um', baseCyExpr = '0um') {
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
    } else if (t.kind === 'duplicate_mirror') {
      // Adds one mirrored copy per existing instance at +2*offset along
      // the axis. Offsets of existing instances unchanged; new ones
      // pick up ±2*offsetExpr along the mirror axis.
      const axis = t.axis === 'y' ? 'y' : 'x';
      const offsetExpr = exprWithUm(t.offset ?? '0');
      const includeOriginal = t.includeOriginal !== false;
      const next = [];
      for (const item of stream) {
        if (includeOriginal) next.push(item);
        next.push({
          dxExpr: axis === 'x' ? `(${item.dxExpr}) + 2 * (${offsetExpr})` : item.dxExpr,
          dyExpr: axis === 'y' ? `(${item.dyExpr}) + 2 * (${offsetExpr})` : item.dyExpr,
        });
      }
      stream = next;
    } else if (t.kind === 'mirror') {
      // Mirror EACH instance about the chosen pivot.
      //   - pivot='C': mirrored about the instance's OWN center. From
      //     the offset-from-base viewpoint, the position is unchanged
      //     (the center doesn't move). Orientation flips, but we
      //     don't track that for position-only chain offsets.
      //   - pivot='origin': mirrored about the world axis. New
      //     absolute pos = -(base + old_offset) for axis='x'. New
      //     offset = (new_abs - base) = -2*base - old_offset.
      const axis = t.axis === 'y' ? 'y' : 'x';
      const pivot = t.pivot === 'origin' ? 'origin' : 'C';
      if (pivot === 'origin') {
        stream = stream.map(item => ({
          dxExpr: axis === 'x' ? `-2 * (${baseCxExpr}) - (${item.dxExpr})` : item.dxExpr,
          dyExpr: axis === 'y' ? `-2 * (${baseCyExpr}) - (${item.dyExpr})` : item.dyExpr,
        }));
      }
      // pivot='C': no change to offsets.
    } else if (t.kind === 'rotate') {
      // Rotate each instance about the chosen pivot.
      //   - pivot='C': instance center is invariant; offsets unchanged
      //     in our chain. (Orientation changes, but we don't track it
      //     for chain offsets.)
      //   - pivot='origin': rotates the ABSOLUTE position around
      //     (0, 0). New offset = R*(base + old_offset) - base.
      //   - pivot='group' or named-anchor: bail out (return null);
      //     would require group-centroid or post-rotation pivot math
      //     that depends on solved positions of other components.
      const pivot = t.pivot || 'C';
      if (pivot === 'C') continue;
      if (pivot === 'origin') {
        const angleExpr = (typeof t.angle === 'string' && /[A-Za-z_]/.test(t.angle))
          ? t.angle
          : `${(t.angle ?? 0)}deg`;
        stream = stream.map(item => ({
          // R*(base + old) - base, expanded so HFSS evaluates with
          // cos/sin in degrees (HFSS expression syntax supports both).
          dxExpr: `((${baseCxExpr}) + (${item.dxExpr})) * cos(${angleExpr}) - ((${baseCyExpr}) + (${item.dyExpr})) * sin(${angleExpr}) - (${baseCxExpr})`,
          dyExpr: `((${baseCxExpr}) + (${item.dxExpr})) * sin(${angleExpr}) + ((${baseCyExpr}) + (${item.dyExpr})) * cos(${angleExpr}) - (${baseCyExpr})`,
        }));
      } else {
        // 'group' or a named-anchor pivot: not currently expressible
        // parametrically without much more machinery. Caller falls
        // back to numeric instance position.
        return null;
      }
    }
    // Unknown kinds: silently ignore (matches expandTransforms's
    // defensive behavior).
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
