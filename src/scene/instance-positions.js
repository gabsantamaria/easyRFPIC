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
import { anchorLocal, parseAnchor } from './anchors.js';

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

// Anchor offset as parametric (xOff, yOff) expressions given parametric
// w / h. Same logic as the existing anchorOffsetParam in hfss-native;
// duplicated here to avoid a cross-module dependency.
function anchorOffsetParamLocal(anchorName, wExpr, hExpr) {
  const a = parseAnchor(anchorName);
  let xOff = '0', yOff = '0';
  if (a.kind === 'edge') {
    if (a.side === 'T')      { xOff = `(${a.t} - 0.5) * (${wExpr})`; yOff = `(${hExpr})/2`; }
    else if (a.side === 'B') { xOff = `(${a.t} - 0.5) * (${wExpr})`; yOff = `-(${hExpr})/2`; }
    else if (a.side === 'L') { xOff = `-(${wExpr})/2`; yOff = `(${a.t} - 0.5) * (${hExpr})`; }
    else if (a.side === 'R') { xOff = `(${wExpr})/2`;  yOff = `(${a.t} - 0.5) * (${hExpr})`; }
  } else {
    const n = a.name;
    if (n.includes('W')) xOff = `-(${wExpr})/2`;
    else if (n.includes('E')) xOff = `(${wExpr})/2`;
    if (n.includes('S')) yOff = `-(${hExpr})/2`;
    else if (n.includes('N')) yOff = `(${hExpr})/2`;
  }
  return { xOff, yOff };
}

// Build the parametric expression for an instance's centroid OFFSET
// from its base centroid. Returns { dxExpr, dyExpr } or null if the
// transform chain contains an operation we genuinely cannot express
// parametrically (currently: rotate with `pivot='group'` whose group
// lookup fails, or any unsupported transform kind).
//
// The instanceIdx is the FLAT index used by expandTransforms (it
// decomposes into a tuple under nested repeats). We re-walk the chain
// keeping per-instance parametric (dx, dy) expressions and look up the
// target idx in the resulting stream.
//
// `opts` accepts:
//   - paramValues: scene parameter values (for numeric n/angle eval)
//   - exprWithUm:  wrapper that tags bare-numeric strings with "um"
//   - baseCxExpr, baseCyExpr: the owner component's parametric base
//     position. Needed by mirror-origin and rotate-origin (which
//     reflect / rotate about the world origin).
//   - baseWExpr, baseHExpr: owner's parametric w/h. Needed by rotate
//     with a named-anchor pivot (uses anchorLocal on the rect's bbox).
//   - components: full scene component list. Needed for `rotate` with
//     `pivot='group'` to find sibling members of the same group.
//   - parametricPos: per-component parametric position map. Needed for
//     `rotate` with `pivot='group'` to compute the group centroid as
//     a parametric average of member positions.
export function instanceChainOffsetExpr(comp, instanceIdx, arg3, arg4, arg5, arg6) {
  // Back-compat: allow (comp, idx, paramValues, exprWithUm, baseCxExpr,
  // baseCyExpr) positional form OR a single trailing opts object.
  let opts;
  if (arg3 && typeof arg3 === 'object' && typeof arg4 === 'undefined') {
    // Heuristic: opts is an object AND no second positional arg
    // present. (paramValues is also an object, so we additionally
    // check whether it carries any of the opts-only keys.)
    const looksLikeOpts = ('exprWithUm' in arg3) || ('baseCxExpr' in arg3) || ('parametricPos' in arg3);
    if (looksLikeOpts) opts = arg3;
    else opts = { paramValues: arg3 };
  } else {
    opts = {
      paramValues: arg3 || {},
      exprWithUm: arg4 || ((s) => `(${s})`),
      baseCxExpr: arg5 || '0um',
      baseCyExpr: arg6 || '0um',
    };
  }
  const {
    paramValues = {},
    exprWithUm = (s) => `(${s})`,
    baseCxExpr = '0um',
    baseCyExpr = '0um',
    baseWExpr = '0',
    baseHExpr = '0',
    components = [],
    parametricPos = {},
  } = opts;
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
      // Rotate each instance about the chosen pivot. Five sub-cases
      // mirror expandTransforms's logic exactly so the parametric
      // chain stays consistent with the numeric one:
      //   1. pivot='C' single-instance stream: orientation flip only;
      //      offsets unchanged.
      //   2. pivot='C' multi-instance stream: rotate the whole cluster
      //      around its centroid (avg of stream's own offsets, applied
      //      atop the base). Each item's new offset is computed
      //      relative to that centroid.
      //   3. pivot='origin': new_offset = R*(base + old) - base.
      //   4. pivot='group': rotate around the parametric centroid of
      //      the component's group members (avg of their cx/cy expr).
      //   5. pivot=<named anchor>: per-instance pivot at the anchor
      //      location on the BASE w/h, so new_offset = old_offset +
      //      anchorLocal·(1-cos / sin) trig terms.
      const pivot = t.pivot || 'C';
      const angleExpr = (typeof t.angle === 'string' && /[A-Za-z_]/.test(t.angle))
        ? t.angle
        : `${(t.angle ?? 0)}deg`;
      if (pivot === 'C') {
        if (stream.length <= 1) continue; // orientation-only, offset unchanged
        // Multi-instance pivot='C': rotate the cluster about the
        // centroid of its current parametric offsets. The centroid in
        // offset-space is the AVERAGE of every stream item's dxExpr /
        // dyExpr (the corresponding cluster-world centroid is then
        // base + that average).
        const n = stream.length;
        const sumDx = stream.map(s => `(${s.dxExpr})`).join(' + ');
        const sumDy = stream.map(s => `(${s.dyExpr})`).join(' + ');
        const centroidDx = `((${sumDx})/${n})`;
        const centroidDy = `((${sumDy})/${n})`;
        stream = stream.map(item => ({
          // pivot + R*(old - pivot), expressed in offset-space.
          dxExpr: `(${centroidDx}) + ((${item.dxExpr}) - (${centroidDx})) * cos(${angleExpr}) - ((${item.dyExpr}) - (${centroidDy})) * sin(${angleExpr})`,
          dyExpr: `(${centroidDy}) + ((${item.dxExpr}) - (${centroidDx})) * sin(${angleExpr}) + ((${item.dyExpr}) - (${centroidDy})) * cos(${angleExpr})`,
        }));
      } else if (pivot === 'origin') {
        stream = stream.map(item => ({
          // R*(base + old) - base. HFSS evaluates cos/sin in degrees.
          dxExpr: `((${baseCxExpr}) + (${item.dxExpr})) * cos(${angleExpr}) - ((${baseCyExpr}) + (${item.dyExpr})) * sin(${angleExpr}) - (${baseCxExpr})`,
          dyExpr: `((${baseCxExpr}) + (${item.dxExpr})) * sin(${angleExpr}) + ((${baseCyExpr}) + (${item.dyExpr})) * cos(${angleExpr}) - (${baseCyExpr})`,
        }));
      } else if (pivot === 'group' && comp.group) {
        // Group centroid = avg of group members' parametric cx/cy.
        // We need the parametricPos map populated for the members and
        // for them to share the `group` field with `comp`. Skip
        // consumed operands (they live inside booleans and don't
        // drag the centroid sideways — same exclusion as
        // expandTransforms).
        const members = (components || []).filter(cc => cc.group === comp.group && !cc.consumedBy);
        if (members.length === 0) return null;
        const memberCxs = [];
        const memberCys = [];
        for (const m of members) {
          const pp = parametricPos[m.id];
          if (pp && pp.cxExpr && pp.cyExpr) {
            memberCxs.push(`(${pp.cxExpr})`);
            memberCys.push(`(${pp.cyExpr})`);
          } else {
            memberCxs.push(`${(m.cx ?? 0).toFixed(4)}um`);
            memberCys.push(`${(m.cy ?? 0).toFixed(4)}um`);
          }
        }
        const n = members.length;
        const gxExpr = `((${memberCxs.join(' + ')})/${n})`;
        const gyExpr = `((${memberCys.join(' + ')})/${n})`;
        stream = stream.map(item => ({
          // pivot + R*(absolute - pivot), in offset-space.
          // absolute = base + old; new_offset = result - base.
          dxExpr: `(${gxExpr}) + ((${baseCxExpr}) + (${item.dxExpr}) - (${gxExpr})) * cos(${angleExpr}) - ((${baseCyExpr}) + (${item.dyExpr}) - (${gyExpr})) * sin(${angleExpr}) - (${baseCxExpr})`,
          dyExpr: `(${gyExpr}) + ((${baseCxExpr}) + (${item.dxExpr}) - (${gxExpr})) * sin(${angleExpr}) + ((${baseCyExpr}) + (${item.dyExpr}) - (${gyExpr})) * cos(${angleExpr}) - (${baseCyExpr})`,
        }));
      } else if (pivot === 'group') {
        // Marked 'group' but no group on the component — fall back
        // to pivot='C' semantics (per expandTransforms behavior).
        if (stream.length <= 1) continue;
        const n = stream.length;
        const sumDx = stream.map(s => `(${s.dxExpr})`).join(' + ');
        const sumDy = stream.map(s => `(${s.dyExpr})`).join(' + ');
        const centroidDx = `((${sumDx})/${n})`;
        const centroidDy = `((${sumDy})/${n})`;
        stream = stream.map(item => ({
          dxExpr: `(${centroidDx}) + ((${item.dxExpr}) - (${centroidDx})) * cos(${angleExpr}) - ((${item.dyExpr}) - (${centroidDy})) * sin(${angleExpr})`,
          dyExpr: `(${centroidDy}) + ((${item.dxExpr}) - (${centroidDx})) * sin(${angleExpr}) + ((${item.dyExpr}) - (${centroidDy})) * cos(${angleExpr})`,
        }));
      } else {
        // Named-anchor pivot (NW / NE / 'T:0.3' / etc.). Per-instance
        // pivot at the anchor offset on the BASE w/h. Derivation in
        // (offset-from-base) space:
        //   pivot = inst + anchorLocal      (so inst − pivot = −anchorLocal)
        //   new_inst = pivot + R*(inst − pivot)
        //   new_offset = new_inst − base
        //   new_offset.x = old_offset.x + anchorLocal.x·(1 − cos)
        //                                + anchorLocal.y·sin
        //   new_offset.y = old_offset.y − anchorLocal.x·sin
        //                                + anchorLocal.y·(1 − cos)
        // anchorLocal is computed from the OWNER's parametric base w/h
        // (the same w/h that drove the expansion's first instance).
        const aOff = anchorOffsetParamLocal(pivot, baseWExpr, baseHExpr);
        stream = stream.map(item => ({
          dxExpr: `(${item.dxExpr}) + (${aOff.xOff}) * (1 - cos(${angleExpr})) + (${aOff.yOff}) * sin(${angleExpr})`,
          dyExpr: `(${item.dyExpr}) - (${aOff.xOff}) * sin(${angleExpr}) + (${aOff.yOff}) * (1 - cos(${angleExpr}))`,
        }));
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
