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
//
// Returns { instances: [...] } where each instance has:
//   { compId, idx, cx, cy, w, h, rotation, transformPath }
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
    }
    if (!Number.isFinite(w) || !Number.isFinite(h)) {
      // Skip degenerate components — keeps render path tolerant.
      instances.push({ compId: c.id, idx: 0, kind, cx: c.cx, cy: c.cy, w: 0, h: 0, rotation: 0, transformPath: '#0', ...shapeFields });
      continue;
    }
    // Start with a single-instance list. Each ENABLED transform either
    // mutates each instance in place, or extends the list (repeat).
    let stream = [{ cx: c.cx, cy: c.cy, w, h, rotation: 0, ...shapeFields }];
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
        // Pivot: fixed-anchor name ('C', 'NW', ...) or 'origin'. When 'origin',
        // we rotate about world (0, 0) which moves cx/cy too. Otherwise we
        // rotate the rect about its own anchor — cx/cy stays put for 'C'.
        const pivot = t.pivot || 'C';
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
          stream = stream.map(inst => {
            if (pivot === 'C') {
              return { ...inst, rotation: inst.rotation + angle };
            }
            // Compute the world position of the pivot anchor on this instance,
            // then rotate the rect's center about that pivot.
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
      }
      // Unknown kinds are silently ignored — defensive against future schema.
    }
    stream.forEach((inst, idx) => {
      const out = {
        compId: c.id, idx,
        kind,
        cx: inst.cx, cy: inst.cy, w: inst.w, h: inst.h,
        rotation: inst.rotation,
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
      instances.push(out);
    });
  }
  return instances;
}
