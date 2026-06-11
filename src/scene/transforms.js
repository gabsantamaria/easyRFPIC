// Per-component transform chain expansion.
//
// A component carries an optional `transforms` array. Each entry is applied
// in order; transforms are additive in the sense that they each transform
// either the position, the orientation, or the multiplicity of the rect.
// The result is a list of "instances" — concrete rectangles to render and
// export.
//
// Supported transforms:
//   { kind: 'displace',  enabled, dx, dy }                         — shifts cx/cy
//   { kind: 'rotate',    enabled, angle, pivot }                   — adds rotation about pivot
//                          pivot can be a fixed-anchor name ('C', 'N', ...) or 'origin'
//   { kind: 'repeat',    enabled, n, dx, dy, includeOriginal }     — emits N additional copies
//                          along the (dx, dy) vector. If includeOriginal is false,
//                          the base instance is dropped (the chain produces only the copies).
//   { kind: 'mirror',    enabled, axis, pivot }                    — reflects each instance
//                          across a line through `pivot` perpendicular to `axis`. axis is
//                          'x' (vertical mirror line, flips x) or 'y' (horizontal, flips y).
//                          pivot is 'C' (instance's own center, default) or 'origin'.
//                          Toggles instance.scaleX/scaleY and negates rotation.
//   { kind: 'duplicate_mirror', enabled, axis, offset, includeOriginal }
//                          emits one mirrored copy. The mirror line sits at `offset` from
//                          the source instance's center along `axis` (so the duplicate's
//                          center lands at +2*offset from the source). Useful for symmetric
//                          structures like top/bottom electrode pairs.
//
// Returns { instances: [...] } where each instance has:
//   { compId, idx, cx, cy, w, h, rotation, scaleX, scaleY, transformPath }
// scaleX / scaleY are ±1 (default 1); -1 means the shape is mirror-flipped along that axis.
// `idx` is a 0-based index into the component's instance list (0 = base/first).
// `transformPath` is a string like '#0' or '#3' identifying which copy this is,
// useful for keying SVG elements.
//
// Extracted from PhotonicLayout.jsx as Stage 1.5 of the planned refactor.
import { evalExpr } from './params.js';
import { anchorLocal } from './anchors.js';

export function expandTransforms(components, paramValues) {
  const instances = [];
  for (const c of components) {
    const w = evalExpr(c.w, paramValues);
    const h = evalExpr(c.h, paramValues);
    // Shape-specific numeric parameters. These are kept on each instance so
    // downstream renderers (canvas, GDS, HFSS) can reproduce the actual
    // geometry instead of approximating from the AABB w/h.
    const kind = c.kind === 'boolean' ? 'boolean' : (c.kind || 'rect');
    const shapeFields = {};
    if (kind === 'circle') {
      shapeFields.r = evalExpr(c.r ?? '0', paramValues);
    } else if (kind === 'ellipse') {
      shapeFields.rx = evalExpr(c.rx ?? '0', paramValues);
      shapeFields.ry = evalExpr(c.ry ?? '0', paramValues);
    } else if (kind === 'polygon') {
      shapeFields.r = evalExpr(c.r ?? '0', paramValues);
      // Number of sides: rounded; clamped to >= 3 (a digon doesn't render).
      const nVal = evalExpr(c.n ?? '6', paramValues);
      shapeFields.n = Math.max(3, Math.round(Number.isFinite(nVal) ? nVal : 6));
    } else if (kind === 'racetrack') {
      shapeFields.R = evalExpr(c.R ?? '100', paramValues);
      shapeFields.L_straight = evalExpr(c.L_straight ?? '300', paramValues);
      shapeFields.p = Math.max(0, Math.min(1, evalExpr(c.p ?? '1', paramValues)));
      // Waveguide width: pulled from the waveguide layer's core_width if a
      // waveguide layer exists in the stack. Override per-component via the
      // `wgWidth` expression field. Default to w_wg if neither is set.
      const wExpr = c.wgWidth ?? 'w_wg';
      const wVal = evalExpr(wExpr, paramValues);
      shapeFields.wgWidth = Number.isFinite(wVal) ? wVal : 1.2;
    } else if (kind === 'polyline') {
      // Polylines carry their vertex list + width to each instance so the
      // canvas / GDS / HFSS renderers can reconstruct the actual swept
      // shape per copy under repeat / mirror / rotate transforms. The
      // canonical vertex list lives on c.vertices (unchanged across
      // instances); each instance also gets a numeric `width` scalar.
      shapeFields.vertices = c.vertices || [];
      shapeFields.closed = !!c.closed;
      const wVal = evalExpr(c.width ?? '0', paramValues);
      shapeFields.width = Number.isFinite(wVal) ? wVal : 0;
      // Solver-stashed tessellated path (world coords at the BASE pose)
      // + the base anchor it was resolved against. Ring consumers remap
      // these into each clone's frame (translate by inst.cx − _baseCx,
      // then the clone's scale / rotation) — see rings.js.
      if (Array.isArray(c._resolvedVerts)) {
        shapeFields._resolvedVerts = c._resolvedVerts;
        shapeFields._baseCx = c.cx;
        shapeFields._baseCy = c.cy;
      }
    } else if (kind === 'polyshape') {
      // Polygon-path components (closed 2-D shapes). Same vertex schema
      // as polyline, but always closed and rendered/exported as a FILLED
      // polygon — no stroke width. Carry the vertex list through to each
      // instance so downstream renderers can rebuild the polygon under
      // repeat / mirror / rotate.
      shapeFields.vertices = c.vertices || [];
      shapeFields.closed = true; // ALWAYS closed by definition
      if (Array.isArray(c._resolvedVerts)) {
        shapeFields._resolvedVerts = c._resolvedVerts;
        shapeFields._baseCx = c.cx;
        shapeFields._baseCy = c.cy;
      }
    }
    if (!Number.isFinite(w) || !Number.isFinite(h)) {
      // Skip degenerate components — keeps render path tolerant.
      instances.push({ compId: c.id, idx: 0, kind, cx: c.cx, cy: c.cy, w: 0, h: 0, rotation: 0, scaleX: 1, scaleY: 1, transformPath: '#0', ...shapeFields });
      continue;
    }
    // Start with a single-instance list. Each ENABLED transform either
    // mutates each instance in place, or extends the list (repeat).
    // scaleX / scaleY default to 1; mirror transforms flip them to -1.
    //
    // FIRST-CLASS ROTATION: rect / circle / ellipse / polygon components
    // may carry an optional `rotation` expression (degrees, CCW). It
    // seeds the initial stream instance's rotation, so rendering, rings,
    // GDS, and boolean masks pick it up with zero special-casing.
    // Transform-chain rotates then ADD to it (rotation composes).
    let baseRotation = 0;
    if ((kind === 'rect' || kind === 'circle' || kind === 'ellipse' || kind === 'polygon') && c.rotation != null) {
      const rv = evalExpr(c.rotation, paramValues);
      if (Number.isFinite(rv)) baseRotation = rv;
    }
    let stream = [{ cx: c.cx, cy: c.cy, w, h, rotation: baseRotation, scaleX: 1, scaleY: 1, ...shapeFields }];
    for (const t of (c.transforms || [])) {
      if (!t || t.enabled === false) continue;
      if (t.kind === 'displace') {
        const dx = evalExpr(t.dx ?? '0', paramValues);
        const dy = evalExpr(t.dy ?? '0', paramValues);
        if (!Number.isFinite(dx) || !Number.isFinite(dy)) continue;
        stream = stream.map(inst => ({ ...inst, cx: inst.cx + dx, cy: inst.cy + dy }));
      } else if (t.kind === 'rotate') {
        const angle = evalExpr(t.angle ?? '0', paramValues);
        if (!Number.isFinite(angle)) continue;
        // Pivot: fixed-anchor name ('C', 'NW', ...), 'origin' (world 0,0),
        // or 'group' (centroid of this component's group members, useful
        // for rotating a group as a rigid body). 'group' is resolved by
        // looking up sibling components with the same `group` field.
        const pivot = t.pivot || 'C';
        if (pivot === 'group' && c.group) {
          // Compute the group centroid in world coordinates, then rotate
          // every stream instance about that shared pivot. All members of
          // the group see the same gx/gy, so when their transform chains
          // are propagated the cluster moves as one rigid body. We skip
          // consumed operands (they live inside booleans and shouldn't
          // pull the centroid sideways).
          const members = components.filter(cc => cc.group === c.group && !cc.consumedBy);
          if (members.length >= 1) {
            let gx = 0, gy = 0;
            for (const m of members) { gx += m.cx; gy += m.cy; }
            gx /= members.length;
            gy /= members.length;
            const rad = angle * Math.PI / 180;
            const ca = Math.cos(rad), sa = Math.sin(rad);
            stream = stream.map(inst => {
              const dxp = inst.cx - gx;
              const dyp = inst.cy - gy;
              return {
                ...inst,
                cx: gx + dxp * ca - dyp * sa,
                cy: gy + dxp * sa + dyp * ca,
                rotation: inst.rotation + angle,
              };
            });
            continue;
          }
          // Fall through to plain pivot='C' behavior if the group lookup
          // failed (e.g., component lost its group field).
        }
        if (pivot === 'origin') {
          const rad = angle * Math.PI / 180;
          const ca = Math.cos(rad), sa = Math.sin(rad);
          stream = stream.map(inst => ({
            ...inst,
            cx: inst.cx * ca - inst.cy * sa,
            cy: inst.cx * sa + inst.cy * ca,
            rotation: inst.rotation + angle,
          }));
        } else {
          // Local-anchor pivot: just adds to rotation about the rect's own
          // anchor point. For non-center pivots we also need to shift cx/cy
          // so that the chosen anchor stays fixed.
          if (pivot === 'C') {
            // pivot='C' semantics:
            //   - Single-instance stream: rotate about the shape's own
            //     center. cx/cy is unchanged (rotating about your own
            //     center is a no-op for position), so we just bump the
            //     rotation field.
            //   - Multi-instance stream (after a `repeat`): rotate the
            //     whole CLUSTER about its shared centroid. Each instance's
            //     cx/cy moves to its rotated position about the centroid,
            //     and the rotation field is bumped. This is what "rotate
            //     the meander as one piece" means — without this, each
            //     repeated cell spins in place and the cluster doesn't
            //     visibly rotate at all.
            if (stream.length <= 1) {
              stream = stream.map(inst => ({ ...inst, rotation: inst.rotation + angle }));
            } else {
              let cx0 = 0, cy0 = 0;
              for (const inst of stream) { cx0 += inst.cx; cy0 += inst.cy; }
              cx0 /= stream.length;
              cy0 /= stream.length;
              const rad = angle * Math.PI / 180;
              const ca = Math.cos(rad), sa = Math.sin(rad);
              stream = stream.map(inst => {
                const dxp = inst.cx - cx0;
                const dyp = inst.cy - cy0;
                return {
                  ...inst,
                  cx: cx0 + dxp * ca - dyp * sa,
                  cy: cy0 + dxp * sa + dyp * ca,
                  rotation: inst.rotation + angle,
                };
              });
            }
          } else {
            // Named-anchor pivot. Compute world position of the pivot
            // anchor on each instance and rotate that instance's center
            // about it. This stays per-instance (no cluster semantics)
            // because anchor pivots are inherently shape-local.
            stream = stream.map(inst => {
              const lp = anchorLocal(pivot, inst.w, inst.h);
              const px = inst.cx + lp.x;
              const py = inst.cy + lp.y;
              const rad = angle * Math.PI / 180;
              const ca = Math.cos(rad), sa = Math.sin(rad);
              const dxp = inst.cx - px;
              const dyp = inst.cy - py;
              return {
                ...inst,
                cx: px + dxp * ca - dyp * sa,
                cy: py + dxp * sa + dyp * ca,
                rotation: inst.rotation + angle,
              };
            });
          }
        }
      } else if (t.kind === 'repeat') {
        const n = Math.max(0, Math.floor(evalExpr(t.n ?? '0', paramValues)));
        const dx = evalExpr(t.dx ?? '0', paramValues);
        const dy = evalExpr(t.dy ?? '0', paramValues);
        const includeOriginal = t.includeOriginal !== false;
        if (!Number.isFinite(n) || !Number.isFinite(dx) || !Number.isFinite(dy)) continue;
        const next = [];
        for (const inst of stream) {
          if (includeOriginal) next.push(inst);
          for (let k = 1; k <= n; k++) {
            next.push({ ...inst, cx: inst.cx + dx * k, cy: inst.cy + dy * k });
          }
        }
        stream = next;
      } else if (t.kind === 'mirror') {
        // Reflect each instance across a line through `pivot`, perpendicular
        // to `axis`. axis='x' flips x (vertical mirror line); axis='y' flips y.
        // Rendering pipeline applies scale before rotation, so mirroring the
        // visible (already-rotated) shape needs to ALSO negate the rotation
        // field — derived from composing the mirror matrix with the existing
        // rotation matrix (worked out in the matching comment in rings.js).
        const axis = t.axis === 'y' ? 'y' : 'x';
        const pivot = t.pivot === 'origin' ? 'origin' : 'C';
        stream = stream.map(inst => {
          const sx = inst.scaleX ?? 1;
          const sy = inst.scaleY ?? 1;
          const newSx = axis === 'x' ? -sx : sx;
          const newSy = axis === 'y' ? -sy : sy;
          let newCx = inst.cx, newCy = inst.cy;
          if (pivot === 'origin') {
            if (axis === 'x') newCx = -inst.cx;
            else newCy = -inst.cy;
          }
          // pivot='C': mirror about the instance's own center → cx/cy unchanged.
          return {
            ...inst,
            cx: newCx, cy: newCy,
            rotation: -(inst.rotation || 0),
            scaleX: newSx, scaleY: newSy,
          };
        });
      } else if (t.kind === 'duplicate_mirror') {
        // Emit one mirrored copy per existing instance. The mirror line sits
        // at `offset` from the source instance's center along `axis`; the
        // duplicate's center lands at +2*offset from the source. Useful for
        // top/bottom or left/right symmetric pairs — e.g. a meander and its
        // mirror image across a feed-trace axis.
        const axis = t.axis === 'y' ? 'y' : 'x';
        const offsetNum = evalExpr(t.offset ?? '0', paramValues);
        if (!Number.isFinite(offsetNum)) continue;
        const includeOriginal = t.includeOriginal !== false;
        const next = [];
        for (const inst of stream) {
          if (includeOriginal) next.push(inst);
          const sx = inst.scaleX ?? 1;
          const sy = inst.scaleY ?? 1;
          next.push({
            ...inst,
            cx: axis === 'x' ? inst.cx + 2 * offsetNum : inst.cx,
            cy: axis === 'y' ? inst.cy + 2 * offsetNum : inst.cy,
            rotation: -(inst.rotation || 0),
            scaleX: axis === 'x' ? -sx : sx,
            scaleY: axis === 'y' ? -sy : sy,
          });
        }
        stream = next;
      }
      // Unknown kinds are silently ignored — defensive against future schema.
    }
    stream.forEach((inst, idx) => {
      const out = {
        compId: c.id, idx,
        kind,
        cx: inst.cx, cy: inst.cy, w: inst.w, h: inst.h,
        rotation: inst.rotation,
        scaleX: inst.scaleX ?? 1,
        scaleY: inst.scaleY ?? 1,
        transformPath: `#${idx}`,
      };
      // Carry shape-specific numeric fields through (r, rx, ry, n,
      // R, L_straight, p, wgWidth for racetracks).
      if (inst.r !== undefined) out.r = inst.r;
      if (inst.rx !== undefined) out.rx = inst.rx;
      if (inst.ry !== undefined) out.ry = inst.ry;
      if (inst.n !== undefined) out.n = inst.n;
      if (inst.R !== undefined) out.R = inst.R;
      if (inst.L_straight !== undefined) out.L_straight = inst.L_straight;
      if (inst.p !== undefined) out.p = inst.p;
      if (inst.wgWidth !== undefined) out.wgWidth = inst.wgWidth;
      // polyline + polyshape share the vertices field; only polyline
      // actually uses the width scalar.
      if (inst.vertices !== undefined) out.vertices = inst.vertices;
      if (inst.closed !== undefined) out.closed = inst.closed;
      if (inst.width !== undefined) out.width = inst.width;
      if (inst._resolvedVerts !== undefined) out._resolvedVerts = inst._resolvedVerts;
      if (inst._baseCx !== undefined) out._baseCx = inst._baseCx;
      if (inst._baseCy !== undefined) out._baseCy = inst._baseCy;
      instances.push(out);
    });
  }
  return instances;
}
