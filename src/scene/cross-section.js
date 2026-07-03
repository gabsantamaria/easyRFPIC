// Cross-section extraction — the geometry heart of the section-line feature.
//
// buildCrossSection(scene, paramValues, sectionCompId, opts) slices the 3-D
// layer stack along a user-drawn "section line" (a 2-vertex polyline on the
// non-model 'section' layer) and returns CROSS-SECTION DATA CONTRACT v1:
// the shared interface consumed by the Q2D (Ansys 2D Extractor) exporter and
// the Tidy3D notebook generator. STRICTLY read-side: it consumes the SAME
// pipeline everything else uses (normalizeScene → solveLayout + applyMirrors
// + resolveBooleanBboxes → expandTransforms → shapeInstanceToRing) and the
// SAME numeric Z walk as pyAEDT / the 3-D viewer (computeNumericLayerZ) —
// nothing here mutates the scene model or any export path.
//
// Coordinates: t = µm ALONG the line from p0 (0 .. lengthUm); z = stack Z µm
// (the hfss-native / layer-z convention — Z=0 pinned at the first device
// level, substrates negative).
//
// Output shape (numeric fields ALWAYS present; *Expr fields OPTIONAL):
//   { ok, sectionId, line, domain, slabs, conductors, waveguides, wgCenter,
//     params, warnings }
// *Expr fields are length-expression strings of the form "(<expr>)um" where
// <expr> is unit-free µm arithmetic over scene param names (e.g. "(h_wg)um",
// "((0) + (h_wg))um") — the same family as hfss-native's layerZ zBottomExpr /
// exprWithUm, normalized to the unit-OUTSIDE-the-paren contract form so
// consumers can strip the trailing "um" and evaluate. They are emitted ONLY
// when:
//   1. the section line is world-axis-aligned ('h' | 'v') — an oblique line
//      omits ALL exprs and pushes one 'oblique-numeric' warning; and
//   2. the geometry is parametrically derivable (unrotated axis-aligned
//      rects / circles placed by translation-only chains); and
//   3. the ROUND-TRIP GUARD passes: evalExpr of the assembled expression
//      must reproduce the numeric value within 1e-6 (HFSS-only forms like
//      cos((a)*1deg) evaluate to silent garbage in evalExpr — same guard
//      contract as flattenReplicas' cxExpr injection in twoLine.js).
// Consumers MUST fall back to the numeric fields.
//
// Skipped components (mirroring the physical-consumer rules):
//   - layer 'section' (isNonModelComponent — annotations, incl. the line)
//   - layer 'port' (2-D excitation sheets, not physical material)
//   - kind 'via'    (vertical cylinder — a 2-D slice can't represent it;
//                    'via-crossed' warning when its footprint crosses)
//   - kind 'bridge' (3-D arch; 'bridge-crossed' warning when crossed)
//   - consumedBy operands (handled via their boolean root)
import { normalizeScene, isNonModelComponent, migrateStackCoplanarGroups } from './schema.js';
import { evalExpr, tokenizeIdents, RESERVED_IDENTS } from './params.js';
import { solveLayout, applyMirrors, resolveBooleanBboxes } from './solver.js';
import { expandTransforms } from './transforms.js';
import { shapeInstanceToRing, remapPointsToInstance } from '../geometry/rings.js';
import { resolvePolylineVertices, tessellatePolylinePath, taperedBandQuads, polylineIsTapered } from '../geometry/polyline.js';
import { buildRacetrackCenterline, offsetCenterlineToBand } from '../geometry/racetrack.js';
import { computeNumericLayerZ } from './layer-z.js';
import { effectiveConductorLayerId } from './conductor-binding.js';
// The snap-DAG → parametric-position walker the HFSS export uses. Same
// call-time import pattern as twoLine.js (hfss-native does not import this
// module, so there is no cycle — and even if one appeared, every use is at
// call time on hoisted declarations).
import { computeParametricPositions } from '../export/hfss-native.js';

// ── Numeric tolerances ────────────────────────────────────────────────────
const EPS_T = 1e-9;        // interval degeneracy / merge epsilon (µm)
const EPS_GUARD = 1e-6;    // round-trip guard tolerance (µm)
const ZERO_THK = 1e-9;     // zero-thickness conductor epsilon (matches the
                           // exporter's |t| < 1e-9 sheet gate)

// Role-fallback colors — the same hexes scene3d / the canvas layerStyle use.
const ELECTRODE_COLOR = '#f4a72e';
const WG_COLOR = '#3ec27a';

// ── Interval-set algebra (exported for tests) ─────────────────────────────
// Intervals are { t0, t1 } with t0 <= t1 after normalization. All three
// helpers return NEW sorted, disjoint, ascending lists; inputs untouched.
const normIntervals = (list) => (list || [])
  .map((iv) => (iv.t0 <= iv.t1 ? { t0: iv.t0, t1: iv.t1 } : { t0: iv.t1, t1: iv.t0 }))
  .filter((iv) => Number.isFinite(iv.t0) && Number.isFinite(iv.t1) && iv.t1 - iv.t0 > EPS_T)
  .sort((a, b) => a.t0 - b.t0 || a.t1 - b.t1);

export function unionIntervals(list) {
  const sorted = normIntervals(list);
  const out = [];
  for (const iv of sorted) {
    const last = out[out.length - 1];
    // Merge overlapping AND touching (within eps) — adjacent repeat cells
    // that abut exactly read as one conductor run.
    if (last && iv.t0 <= last.t1 + EPS_T) {
      if (iv.t1 > last.t1) last.t1 = iv.t1;
    } else {
      out.push({ ...iv });
    }
  }
  return out;
}

export function subtractIntervals(A, B) {
  const a = unionIntervals(A);
  const b = unionIntervals(B);
  const out = [];
  for (const iv of a) {
    let cur = iv.t0;
    for (const cut of b) {
      if (cut.t1 <= cur + EPS_T) continue;      // cut entirely before cursor
      if (cut.t0 >= iv.t1 - EPS_T) break;       // cut entirely after interval
      if (cut.t0 > cur + EPS_T) out.push({ t0: cur, t1: Math.min(cut.t0, iv.t1) });
      cur = Math.max(cur, cut.t1);
      if (cur >= iv.t1 - EPS_T) break;
    }
    if (iv.t1 - cur > EPS_T) out.push({ t0: cur, t1: iv.t1 });
  }
  return normIntervals(out);
}

export function intersectIntervals(A, B) {
  const a = unionIntervals(A);
  const b = unionIntervals(B);
  const out = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const lo = Math.max(a[i].t0, b[j].t0);
    const hi = Math.min(a[i].t1, b[j].t1);
    if (hi - lo > EPS_T) out.push({ t0: lo, t1: hi });
    if (a[i].t1 < b[j].t1) i++; else j++;
  }
  return out;
}

// ── Point-in-polygon (even-odd ray cast; same as scene3d's) ───────────────
function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

// ── Segment ∩ polygon ring → sorted interval list (exported for tests) ────
// p0/p1: {x, y} segment endpoints; ring: [[x, y], …] implicitly-closed
// polygon. Returns [{ t0, t1 }] in µm ALONG the segment from p0 where the
// segment is INSIDE the polygon (even-odd rule).
//
// Robustness strategy: collect every candidate parameter where inside/
// outside can flip — the segment ends (0, L) plus every edge intersection
// (collinear edges contribute both projected endpoints) — then classify the
// MIDPOINT of each consecutive candidate pair with an even-odd point-in-
// polygon test. Midpoints sit strictly between flip candidates, so vertices
// exactly ON the line (tangent or crossing) and endpoints inside the polygon
// fall out correctly without special cases; degenerate (< 1e-9 µm) slivers
// are dropped by the interval normalizer.
export function intersectSegmentRing(p0, p1, ring) {
  if (!ring || ring.length < 3) return [];
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  const L = Math.hypot(dx, dy);
  if (!(L > EPS_T)) return [];
  const ux = dx / L;
  const uy = dy / L;
  const cuts = [0, L];
  const pushT = (t) => {
    if (t > -EPS_T && t < L + EPS_T) cuts.push(Math.min(Math.max(t, 0), L));
  };
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, ay] = ring[j];
    const [bx, by] = ring[i];
    const ex = bx - ax;
    const ey = by - ay;
    const denom = ux * ey - uy * ex; // cross(u, e)
    const wx = ax - p0.x;
    const wy = ay - p0.y;
    if (Math.abs(denom) > 1e-12) {
      // p0 + t·u = a + s·e  ⇒  t = cross(w, e)/cross(u, e), s = cross(w, u)/cross(u, e)
      const t = (wx * ey - wy * ex) / denom;
      const s = (wx * uy - wy * ux) / denom;
      if (s > -1e-9 && s < 1 + 1e-9) pushT(t);
    } else {
      // Parallel edge. If it's COLLINEAR with the line (vertex a lies on
      // the line within eps), both projected endpoints are flip candidates
      // — the midpoint classification decides which side is material.
      const dist = Math.abs(wx * uy - wy * ux); // perpendicular distance of a
      if (dist < 1e-9) {
        pushT(wx * ux + wy * uy);
        pushT((bx - p0.x) * ux + (by - p0.y) * uy);
      }
    }
  }
  cuts.sort((a, b) => a - b);
  const out = [];
  for (let k = 0; k + 1 < cuts.length; k++) {
    const t0 = cuts[k];
    const t1 = cuts[k + 1];
    if (t1 - t0 <= EPS_T) continue;
    const tm = (t0 + t1) / 2;
    if (pointInRing(p0.x + tm * ux, p0.y + tm * uy, ring)) out.push({ t0, t1 });
  }
  return unionIntervals(out);
}

// ── Small expression helpers ──────────────────────────────────────────────
// Strip HFSS "um" unit suffixes that follow a digit or ')' — the exact rule
// evalExpr applies internally — so parametric-position chains from
// computeParametricPositions ("(-20um) + …", "(3um)") become unit-free µm
// arithmetic we can re-wrap in the contract's "(<expr>)um" form.
const stripUm = (s) => String(s ?? '').replace(/(\d|\))\s*um\b/g, '$1');

// Plain decimal literal (no scientific exponent) for numeric fallbacks.
const plainDec = (x) => {
  if (!Number.isFinite(x)) return '0';
  let s = x.toFixed(9);
  if (s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s === '' || s === '-' ? '0' : s;
};

// Sum two unit-free expression terms, skipping trivial zeros.
const joinSum = (a, b) => {
  const A = String(a ?? '0').trim() || '0';
  const B = String(b ?? '0').trim() || '0';
  if (B === '0') return A;
  if (A === '0') return B;
  return `(${A}) + (${B})`;
};

// Mitered constant-width band ring around an OPEN centerline — verbatim
// twin of scene3d's module-local helper (kept in lockstep: same clamp).
function miterBandRing(pts, halfW) {
  const n = pts.length;
  if (n < 2 || !(halfW > 0)) return null;
  const dirs = [];
  for (let i = 0; i + 1 < n; i++) {
    const dx = pts[i + 1][0] - pts[i][0];
    const dy = pts[i + 1][1] - pts[i][1];
    const len = Math.hypot(dx, dy) || 1;
    dirs.push([dx / len, dy / len]);
  }
  const left = [];
  const right = [];
  for (let i = 0; i < n; i++) {
    const dPrev = dirs[Math.max(0, i - 1)];
    const dNext = dirs[Math.min(dirs.length - 1, i)];
    const n1 = [-dPrev[1], dPrev[0]];
    const n2 = [-dNext[1], dNext[0]];
    let mx = n1[0] + n2[0];
    let my = n1[1] + n2[1];
    const mlen = Math.hypot(mx, my);
    if (mlen < 1e-9) { mx = n2[0]; my = n2[1]; }
    else { mx /= mlen; my /= mlen; }
    const dot = Math.max(0.25, mx * n2[0] + my * n2[1]);
    const s = Math.min(halfW / dot, halfW * 4);
    left.push([pts[i][0] + mx * s, pts[i][1] + my * s]);
    right.push([pts[i][0] - mx * s, pts[i][1] - my * s]);
  }
  return [...left, ...right.reverse()];
}

// ── buildCrossSection ─────────────────────────────────────────────────────
// opts is reserved (v1 takes no options); accepted for contract stability.
export function buildCrossSection(rawScene, paramValues, sectionCompId, opts = {}) { // eslint-disable-line no-unused-vars
  const warnings = [];
  const warnedKeys = new Set();
  const warn = (code, msg) => {
    const k = `${code}|${msg}`;
    if (warnedKeys.has(k)) return;
    warnedKeys.add(k);
    warnings.push({ code, msg });
  };

  const scene = normalizeScene(rawScene);
  const pv = paramValues || {};
  const stack = scene.stack || [];
  const layerZ = computeNumericLayerZ(stack, pv);
  const solved = resolveBooleanBboxes(
    applyMirrors(solveLayout(scene.components, scene.snaps, pv), scene.mirrors || []),
    pv,
  );
  const compById = Object.fromEntries(solved.map((c) => [c.id, c]));

  const fail = (error) => ({ ok: false, error, sectionId: sectionCompId ?? null, warnings });

  // ── 1. The section line ──────────────────────────────────────────────
  const sec = compById[sectionCompId];
  if (!sec) return fail(`No component with id "${sectionCompId}" in the scene.`);
  if (sec.kind !== 'polyline' || !isNonModelComponent(sec)) {
    return fail(`Component "${sectionCompId}" is not a section line (need kind 'polyline' on layer 'section').`);
  }
  const secVerts = resolvePolylineVertices(sec, compById, pv);
  if (secVerts.length < 2) return fail('Section line has fewer than 2 vertices.');
  if (secVerts.length > 2) {
    warn('section-extra-vertices', `${sec.id}: section line has ${secVerts.length} vertices — only the first two define the slicing plane.`);
  }
  const [sx0, sy0] = secVerts[0];
  const [sx1, sy1] = secVerts[1];
  if (![sx0, sy0, sx1, sy1].every(Number.isFinite)) {
    return fail('Section line vertices did not resolve to finite positions.');
  }
  const dxL = sx1 - sx0;
  const dyL = sy1 - sy0;
  const lengthUm = Math.hypot(dxL, dyL);
  if (!(lengthUm > 1e-6)) return fail('Section line is degenerate (length < 1e-6 µm).');
  const axis = Math.abs(dyL) < 1e-6 ? 'h' : (Math.abs(dxL) < 1e-6 ? 'v' : null);
  const ux = dxL / lengthUm;
  const uy = dyL / lengthUm;
  const p0 = { x: sx0, y: sy0 };
  const p1 = { x: sx1, y: sy1 };
  const parametricOn = axis != null;
  if (!parametricOn) {
    warn('oblique-numeric', 'Section line is oblique (not world-axis-aligned) — parametric expressions omitted; numeric values only.');
  }

  // ── Stack / layer lookups ────────────────────────────────────────────
  const wgLayer = stack.find((l) => l.role === 'waveguide') || null;
  const conductorLayers = stack.filter((l) => l.role === 'conductor');
  const boundConductorFor = (c) => {
    const eff = effectiveConductorLayerId(c, compById);
    if (eff) {
      const l = conductorLayers.find((x) => x.id === eff);
      if (l) return l;
    }
    return conductorLayers[0] || null;
  };
  // Z placement for electrode-ish components — mirrors scene3d's
  // conductorZFor (incl. the no-conductor-layer fallback onto the WG top).
  const conductorZFor = (c) => {
    const l = boundConductorFor(c);
    if (l && layerZ[l.id]) {
      return { layer: l, zBottom: layerZ[l.id].zBottom, thickness: layerZ[l.id].thickness };
    }
    const zB = wgLayer && layerZ[wgLayer.id] ? layerZ[wgLayer.id].zTop : (evalExpr('h_wg', pv) || 0);
    const t = evalExpr('h_cond', pv);
    return { layer: l, zBottom: zB, thickness: Number.isFinite(t) ? t : 0.5 };
  };
  const ZOFF_KINDS = new Set(['rect', 'circle', 'ellipse', 'polygon', 'polyline', 'polyshape']);
  const zOffNum = (c) => {
    if (!c || !ZOFF_KINDS.has(c.kind || 'rect')) return 0;
    if (c.zOffset == null || String(c.zOffset).trim() === '') return 0;
    const v = evalExpr(c.zOffset, pv);
    return Number.isFinite(v) ? v : 0;
  };
  const zOffInnerOf = (c) => {
    if (!c || !ZOFF_KINDS.has(c.kind || 'rect')) return null;
    if (c.zOffset == null) return null;
    const s = String(c.zOffset).trim();
    if (s === '' || s === '0') return null;
    return stripUm(s);
  };

  // ── Cluster transforms (boolean chains) — pointwise, same as scene3d ──
  const applyXfPoint = (xf, p) => {
    let tx = p[0] + xf.dx;
    let ty = p[1] + xf.dy;
    if (xf.sx === -1) tx = 2 * xf.cx - tx;
    if (xf.sy === -1) ty = 2 * xf.cy - ty;
    if (xf.rot) {
      const rad = (xf.rot * Math.PI) / 180;
      const ca = Math.cos(rad);
      const sa = Math.sin(rad);
      const rx = tx - xf.cx;
      const ry = ty - xf.cy;
      tx = xf.cx + rx * ca - ry * sa;
      ty = xf.cy + rx * sa + ry * ca;
    }
    return [tx, ty];
  };
  const xfRing = (xfs, ring) => (xfs.length === 0 ? ring : ring.map((p) => xfs.reduce((q, xf) => applyXfPoint(xf, q), p)));

  // ── Footprint rings per instance (world coords) — scene3d's dispatch ──
  const footprintRings = (c, inst) => {
    if (c.kind === 'polyline') {
      const w = Number.isFinite(inst.width) ? inst.width : 0;
      if (!(w > 0)) {
        warn('zero-width-polyline', `${c.id}: polyline with zero width — skipped in the cross-section.`);
        return [];
      }
      if (polylineIsTapered(c)) {
        const { quads } = taperedBandQuads(c, compById, pv);
        return quads
          .map((q) => remapPointsToInstance(q, inst, c.cx, c.cy))
          .map((ring) => ({ ring, holes: [] }));
      }
      const base = tessellatePolylinePath(c, compById, pv);
      if (base.length < 2) return [];
      const pts = remapPointsToInstance(base, inst, c.cx, c.cy);
      if (c.closed && pts.length >= 3) {
        const { outer, inner } = offsetCenterlineToBand(pts, w / 2);
        return [{ ring: outer, holes: inner.length >= 3 ? [inner] : [] }];
      }
      const ring = miterBandRing(pts, w / 2);
      return ring ? [{ ring, holes: [] }] : [];
    }
    if (c.kind === 'racetrack') {
      const R = Number.isFinite(inst.R) ? inst.R : 100;
      const Ls = Number.isFinite(inst.L_straight) ? inst.L_straight : 300;
      const pFrac = Number.isFinite(inst.p) ? inst.p : 1;
      const wgW = Number.isFinite(inst.wgWidth) ? inst.wgWidth : 1.2;
      const centerline = buildRacetrackCenterline(R, Ls, pFrac);
      const { outer, inner } = offsetCenterlineToBand(centerline, wgW / 2);
      const rad = ((inst.rotation || 0) * Math.PI) / 180;
      const ca = Math.cos(rad);
      const sa = Math.sin(rad);
      const isx = inst.scaleX ?? 1;
      const isy = inst.scaleY ?? 1;
      const place = ([lx, ly]) => {
        const mx = lx * isx;
        const my = ly * isy;
        return [inst.cx + mx * ca - my * sa, inst.cy + mx * sa + my * ca];
      };
      return [{ ring: outer.map(place), holes: inner.length >= 3 ? [inner.map(place)] : [] }];
    }
    const ring = shapeInstanceToRing(inst);
    if (!ring || ring.length < 3) return [];
    return [{ ring, holes: [] }];
  };

  // Cutout rings in an instance's frame (scene3d's cutoutRings twin).
  const cutoutRings = (c, inst, xfs) => {
    const out = [];
    for (const cut of c.cutouts || []) {
      const cw = evalExpr(cut.w, pv);
      const ch = evalExpr(cut.h, pv);
      const cdx = evalExpr(cut.dx, pv);
      const cdy = evalExpr(cut.dy, pv);
      if (![cw, ch, cdx, cdy].every(Number.isFinite) || !(cw > 0) || !(ch > 0)) continue;
      const local = [
        [cdx - cw / 2, cdy - ch / 2],
        [cdx + cw / 2, cdy - ch / 2],
        [cdx + cw / 2, cdy + ch / 2],
        [cdx - cw / 2, cdy + ch / 2],
      ];
      const rad = ((inst.rotation || 0) * Math.PI) / 180;
      const ca = Math.cos(rad);
      const sa = Math.sin(rad);
      const isx = inst.scaleX ?? 1;
      const isy = inst.scaleY ?? 1;
      const ring = local.map(([lx, ly]) => {
        const mx = lx * isx;
        const my = ly * isy;
        return [inst.cx + mx * ca - my * sa, inst.cy + mx * sa + my * ca];
      });
      out.push(xfRing(xfs, ring));
    }
    return out;
  };

  // ── t-intervals of a component (recursive over booleans) ──────────────
  const instanceIntervals = (c, inst, xfs) => {
    let ivs = [];
    for (const { ring, holes } of footprintRings(c, inst)) {
      let r = intersectSegmentRing(p0, p1, xfRing(xfs, ring));
      for (const hole of holes || []) {
        r = subtractIntervals(r, intersectSegmentRing(p0, p1, xfRing(xfs, hole)));
      }
      ivs = unionIntervals([...ivs, ...r]);
    }
    for (const cut of cutoutRings(c, inst, xfs)) {
      ivs = subtractIntervals(ivs, intersectSegmentRing(p0, p1, cut));
    }
    return ivs;
  };
  const componentIntervals = (c, xfs, depth = 0, visited = new Set()) => {
    if (!c || depth > 16 || visited.has(c.id)) return [];
    visited.add(c.id);
    if (c.kind === 'boolean') {
      const ops = (c.operandIds || []).map((id) => compById[id]).filter(Boolean);
      if (ops.length === 0) return [];
      let total = [];
      // One cluster xform per boolean transform-instance (repeat replicas
      // of a whole meander cluster land at their instance positions —
      // scene3d's emitComponent contract).
      const bInsts = expandTransforms([c], pv);
      for (const bInst of bInsts) {
        const dx = bInst.cx - c.cx;
        const dy = bInst.cy - c.cy;
        const rot = bInst.rotation || 0;
        const isx = bInst.scaleX ?? 1;
        const isy = bInst.scaleY ?? 1;
        const identity = !dx && !dy && !rot && isx === 1 && isy === 1;
        const instXfs = identity ? xfs : [{ dx, dy, cx: bInst.cx, cy: bInst.cy, rot, sx: isx, sy: isy }, ...xfs];
        let res;
        if (c.op === 'subtract' || c.op === 'punch') {
          res = componentIntervals(ops[0], instXfs, depth + 1, new Set(visited));
          for (const op of ops.slice(1)) {
            res = subtractIntervals(res, componentIntervals(op, instXfs, depth + 1, new Set(visited)));
          }
        } else if (c.op === 'intersect') {
          // Exact: (line ∩ (A ∩ B)) = (line ∩ A) ∩ (line ∩ B).
          res = componentIntervals(ops[0], instXfs, depth + 1, new Set(visited));
          for (const op of ops.slice(1)) {
            res = intersectIntervals(res, componentIntervals(op, instXfs, depth + 1, new Set(visited)));
          }
        } else {
          res = [];
          for (const op of ops) {
            res = unionIntervals([...res, ...componentIntervals(op, instXfs, depth + 1, new Set(visited))]);
          }
        }
        total = unionIntervals([...total, ...res]);
      }
      return total;
    }
    let out = [];
    for (const inst of expandTransforms([c], pv)) {
      out = unionIntervals([...out, ...instanceIntervals(c, inst, xfs)]);
    }
    return out;
  };

  // ── Parametric machinery (axis-aligned lines only) ────────────────────
  let pp = null;
  if (parametricOn) {
    try {
      pp = computeParametricPositions(solved, scene.snaps || [], pv);
    } catch {
      pp = null; // t exprs silently unavailable; z exprs still emit
    }
  }
  const coordOf = (pt) => (axis === 'h' ? pt.x : pt.y);
  const sgn = (axis === 'h' ? dxL : dyL) >= 0 ? 1 : -1;
  const p0Coord = coordOf(p0);
  // The line's own p0 coordinate as a unit-free expression: the section
  // component's parametric root/snap-chain position plus vertex 0's rel
  // offset. Snap-/arc-pinned vertex 0 (rare) falls back to the numeric
  // literal — the ROUND-TRIP GUARD is the single gate either way.
  let p0Expr = plainDec(p0Coord);
  if (pp && pp[sec.id]) {
    const base = stripUm(axis === 'h' ? pp[sec.id].cxExpr : pp[sec.id].cyExpr);
    const v0 = (sec.vertices || [])[0];
    if (!v0 || v0.kind === 'rel' || v0.kind == null) {
      const d = String((axis === 'h' ? v0?.dx : v0?.dy) ?? '0').trim() || '0';
      const e = d === '0' ? `(${base})` : `(${base}) + (${d})`;
      const v = evalExpr(e, pv);
      if (Number.isFinite(v) && Math.abs(v - p0Coord) < EPS_GUARD) p0Expr = e;
    }
  }
  // t(coordExpr) as a unit-free expression, honoring the line direction.
  const tInnerOf = (coordExpr) => (sgn > 0
    ? `(${coordExpr}) - (${p0Expr})`
    : `(${p0Expr}) - (${coordExpr})`);

  // Per-instance translation offsets (numeric + symbolic) of a transform
  // chain along the section axis. `pure` is false when the chain contains
  // anything but repeat / displace — rotated / mirrored replicas can't be
  // expressed as base + k·pitch, so those entries stay numeric-only.
  const OFFS_CAP = 256;
  const translationOffsetsExpr = (transforms) => {
    let offs = [{ d: 0, dExpr: '0' }];
    let pure = true;
    for (const t of transforms || []) {
      if (!t || t.enabled === false) continue;
      const key = axis === 'h' ? 'dx' : 'dy';
      if (t.kind === 'displace') {
        const d = evalExpr(t[key], pv) || 0;
        const e = stripUm(String(t[key] ?? '0').trim() || '0');
        offs = offs.map((o) => ({ d: o.d + d, dExpr: joinSum(o.dExpr, e) }));
      } else if (t.kind === 'repeat') {
        const n = Math.max(0, Math.floor(evalExpr(t.n ?? '0', pv) || 0));
        const d = evalExpr(t[key], pv) || 0;
        const e = stripUm(String(t[key] ?? '0').trim() || '0');
        const inc = t.includeOriginal !== false;
        const next = [];
        for (const o of offs) {
          for (let k = inc ? 0 : 1; k <= n; k++) {
            next.push({ d: o.d + k * d, dExpr: joinSum(o.dExpr, k === 0 ? '0' : `${k}*(${e})`) });
          }
        }
        offs = next;
        if (offs.length > OFFS_CAP) { pure = false; break; }
      } else {
        pure = false;
        break;
      }
    }
    return { offs, pure };
  };

  // Candidate edge positions (along the section axis) for a conductor
  // entry: every unrotated axis-aligned RECT (edges cx ± w/2) or CIRCLE
  // (chord through the center: cx ± r) leaf, per translation replica.
  // Each candidate carries the pre-evaluated t value AND the assembled
  // "(…)um" expression; interval endpoints that numerically match a
  // candidate (within 1e-6) get that expression attached — which IS the
  // round-trip guard (a candidate whose expression mis-evaluates simply
  // never matches, so the endpoint stays numeric-only).
  const candidatesFor = (c) => {
    if (!pp) return [];
    const rootOffs = c.kind === 'boolean'
      ? translationOffsetsExpr(c.transforms)
      : { offs: [{ d: 0, dExpr: '0' }], pure: true };
    if (!rootOffs.pure) return [];
    const leaves = [];
    if (c.kind === 'boolean') {
      const walk = (b, depth, visited) => {
        if (!b || depth > 16) return;
        for (const oid of b.operandIds || []) {
          const o = compById[oid];
          if (!o || visited.has(o.id)) continue;
          visited.add(o.id);
          if (o.kind === 'boolean') walk(o, depth + 1, visited);
          else leaves.push(o);
        }
      };
      walk(c, 0, new Set([c.id]));
    } else {
      leaves.push(c);
    }
    const out = [];
    for (const m of leaves) {
      const kind = m.kind || 'rect';
      if (kind !== 'rect' && kind !== 'circle') continue;
      if (kind === 'rect' && m.rotation != null && String(m.rotation).trim() !== ''
          && Math.abs(evalExpr(m.rotation, pv)) > 1e-9) continue;
      const own = translationOffsetsExpr(m.transforms);
      if (!own.pure) continue;
      const base = pp[m.id];
      if (!base) continue;
      const posBase = stripUm(axis === 'h' ? base.cxExpr : base.cyExpr);
      const dimRaw = axis === 'h' ? m.w : m.h;
      const halfExpr = kind === 'circle'
        ? `(${stripUm(String(m.r ?? '0'))})`
        : `(${stripUm(String(dimRaw ?? '0'))})/2`;
      // INGREDIENT round-trip (in addition to the endpoint value-match):
      // evalExpr collapses errors to a finite 0, so an HFSS-only pp expr
      // (cos((ang)*1deg) from a rotated-parent snap chain) evaluates to a
      // silent wrong value — if that collapsed value coincides with a real
      // endpoint (edge at t=0 is common: the line often starts ON a
      // conductor edge), a WRONG expr would be attached. Each ingredient
      // must reproduce its own solved numeric first.
      const solvedCenter = axis === 'h' ? m.cx : m.cy;
      const posVal = evalExpr(posBase, pv);
      if (!Number.isFinite(posVal) || !Number.isFinite(solvedCenter)
          || Math.abs(posVal - solvedCenter) > EPS_GUARD) continue;
      const halfNumeric = kind === 'circle'
        ? evalExpr(String(m.r ?? '0'), pv)
        : evalExpr(String(dimRaw ?? '0'), pv) / 2;
      const halfVal = evalExpr(halfExpr, pv);
      if (!Number.isFinite(halfVal) || !Number.isFinite(halfNumeric)
          || Math.abs(halfVal - halfNumeric) > EPS_GUARD) continue;
      for (const ro of rootOffs.offs) {
        for (const oo of own.offs) {
          if (out.length > 4 * OFFS_CAP) return out; // defensive cap
          const off = joinSum(ro.dExpr, oo.dExpr);
          const pos = off === '0' ? `(${posBase})` : `(${posBase}) + (${off})`;
          for (const edge of [`(${pos}) - ${halfExpr}`, `(${pos}) + ${halfExpr}`]) {
            const inner = tInnerOf(edge);
            const tVal = evalExpr(inner, pv);
            if (Number.isFinite(tVal)) out.push({ tVal, expr: `(${inner})um` });
          }
        }
      }
    }
    return out;
  };
  // Coincident-edge ties: two touching leaves put two DIFFERENT exprs at
  // the same t (e.g. abutting union operands). At the current params both
  // match, but under an AEDT sweep only one tracks the merged interval's
  // OUTER edge — the value alone can't tell which, so a tie between
  // distinct expressions bakes the endpoint (numeric is never wrong).
  const pickCand = (cands, t) => {
    const hits = cands.filter((cd) => Math.abs(cd.tVal - t) < EPS_GUARD);
    if (!hits.length) return null;
    hits.sort((a, b) => Math.abs(a.tVal - t) - Math.abs(b.tVal - t));
    const best = hits[0];
    const rival = hits.find((h) => h.expr !== best.expr
      && Math.abs(Math.abs(h.tVal - t) - Math.abs(best.tVal - t)) < 1e-12);
    return rival ? null : best;
  };
  const attachIntervalExprs = (intervals, cands) => intervals.map((iv) => {
    const out = { t0: iv.t0, t1: iv.t1 };
    const m0 = pickCand(cands, iv.t0);
    const m1 = pickCand(cands, iv.t1);
    if (m0) out.t0Expr = m0.expr;
    if (m1) out.t1Expr = m1.expr;
    return out;
  });

  // ── Parametric layer-Z expressions (unit-free µm inner exprs) ─────────
  // The SAME coplanar-group walk as computeNumericLayerZ / hfss-native's
  // layerZ, but building unit-free expressions from the stack's thickness
  // expressions. Each layer's exprs are attached only after a round-trip
  // guard against the numeric walk — keep all three walks in lockstep.
  const layerZInner = (() => {
    const st = migrateStackCoplanarGroups(stack);
    const map = {};
    const isDev = (r) => r === 'waveguide' || r === 'conductor' || r === 'cladding';
    const tNum = (l) => {
      const v = evalExpr(l.thickness, pv);
      return Number.isFinite(v) ? v : 1;
    };
    const tIn = (l) => `(${stripUm(String(l.thickness ?? '0')).trim() || '0'})`;
    const advanceLayerOf = (members) => {
      const clad = members.filter((m) => m.role === 'cladding');
      const pool = clad.length ? clad : members;
      return pool.reduce((a, b) => (tNum(b) > tNum(a) ? b : a), pool[0]);
    };
    let firstDev = st.findIndex((l) => isDev(l.role) || l.coplanarGroup);
    if (firstDev === -1) firstDev = st.length;
    let cursor = '0';
    for (let i = firstDev - 1; i >= 0; i--) {
      const bot = `(${cursor}) - ${tIn(st[i])}`;
      map[st[i].id] = { botInner: bot, topInner: cursor, tInner: tIn(st[i]) };
      cursor = bot;
    }
    cursor = '0';
    let i = firstDev;
    while (i < st.length) {
      const gid = st[i].coplanarGroup;
      if (gid) {
        let runEnd = i;
        while (runEnd + 1 < st.length && st[runEnd + 1].coplanarGroup === gid) runEnd++;
        const members = [];
        for (let j = i; j <= runEnd; j++) {
          map[st[j].id] = { botInner: cursor, topInner: `(${cursor}) + ${tIn(st[j])}`, tInner: tIn(st[j]) };
          members.push(st[j]);
        }
        cursor = `(${cursor}) + ${tIn(advanceLayerOf(members))}`;
        i = runEnd + 1;
      } else {
        map[st[i].id] = { botInner: cursor, topInner: `(${cursor}) + ${tIn(st[i])}`, tInner: tIn(st[i]) };
        cursor = `(${cursor}) + ${tIn(st[i])}`;
        i++;
      }
    }
    return map;
  })();
  // Attach z0Expr/z1Expr onto `entry` for the given inner exprs iff the
  // round-trip guard passes against entry.z0 / entry.z1.
  const attachZExprs = (entry, z0Inner, z1Inner) => {
    if (!parametricOn || z0Inner == null || z1Inner == null) return;
    const v0 = evalExpr(z0Inner, pv);
    const v1 = evalExpr(z1Inner, pv);
    if (Number.isFinite(v0) && Math.abs(v0 - entry.z0) < EPS_GUARD) entry.z0Expr = `(${z0Inner})um`;
    if (Number.isFinite(v1) && Math.abs(v1 - entry.z1) < EPS_GUARD) entry.z1Expr = `(${z1Inner})um`;
  };

  // ── 2. Conductors / waveguides walk ───────────────────────────────────
  const conductors = [];
  const waveguides = [];
  const crossedAtAll = (c) => componentIntervals(c, []).length > 0;

  const handleConductor = (c) => {
    const intervals = componentIntervals(c, []);
    if (intervals.length === 0) return;
    const z = conductorZFor(c);
    const l = z.layer;
    // Per-operand zOffsets can't be represented on a single-entry Z span;
    // primitives use their own, boolean roots use none (booleans carry no
    // zOffset) — warn if a cluster member would have shifted.
    let zOff = 0;
    if (c.kind === 'boolean') {
      const anyOff = (c.operandIds || []).some((oid) => zOffNum(compById[oid]) !== 0);
      if (anyOff) {
        warn('zoffset-ignored', `${c.id}: operand zOffset ignored in the cross-section (one Z span per conductor entry).`);
      }
    } else {
      zOff = zOffNum(c);
    }
    const thickness = Number.isFinite(z.thickness) ? z.thickness : 0;
    const zeroThickness = Math.abs(thickness) < ZERO_THK;
    const z0 = z.zBottom + zOff;
    const z1 = z0 + (zeroThickness ? 0 : thickness);
    const totalLen = intervals.reduce((a, iv) => a + (iv.t1 - iv.t0), 0);
    const entry = {
      id: c.id,
      label: c.label || c.id,
      layerId: l ? l.id : null,
      material: (l && l.material) || 'gold',
      color: (l && l.color) || ELECTRODE_COLOR,
      zeroThickness,
      areaUm2: totalLen * (z1 - z0),
      z0,
      z1,
      intervals,
    };
    if (parametricOn && l && layerZInner[l.id]) {
      const zi = layerZInner[l.id];
      const zOffE = c.kind === 'boolean' ? null : zOffInnerOf(c);
      const z0Inner = zOffE ? joinSum(zi.botInner, zOffE) : zi.botInner;
      const z1Inner = `(${z0Inner}) + ${zi.tInner}`;
      attachZExprs(entry, z0Inner, z1Inner);
    }
    entry.intervals = attachIntervalExprs(entry.intervals, candidatesFor(c));
    conductors.push(entry);
  };

  const handleWaveguide = (c) => {
    const zL = wgLayer && layerZ[wgLayer.id]
      ? layerZ[wgLayer.id]
      : { zBottom: 0, thickness: evalExpr('h_wg', pv) || 0.6 };
    const thk = Number.isFinite(zL.thickness) ? zL.thickness : 0.6;
    const zOff = zOffNum(c);
    const material = (wgLayer && wgLayer.material) || 'lithium_tantalate';
    const color = (wgLayer && wgLayer.color) || WG_COLOR;
    const layerId = wgLayer ? wgLayer.id : null;
    const isSharpRect = (c.kind || 'rect') === 'rect'
      && !(c.cornerRadius != null && evalExpr(c.cornerRadius, pv) > 0);
    if (!isSharpRect) {
      // Non-rib shapes (rounded rect, circle, polyline, polyshape,
      // racetrack, boolean) — a uniform full-thickness core, exactly the
      // uniform-slab semantics scene3d / the HFSS export give them.
      const ivs = componentIntervals(c, []);
      if (ivs.length === 0) return;
      warn('wg-uniform', `${c.id}: non-rect waveguide shape rendered as a uniform full-thickness core (no rib profile) — same as the 3-D viewer / HFSS export.`);
      waveguides.push({
        id: c.id,
        layerId,
        material,
        color,
        core: {
          zBot: zL.zBottom + zOff,
          zTop: zL.zBottom + zOff + thk,
          segments: ivs.map((iv) => ({ botT0: iv.t0, botT1: iv.t1, topT0: iv.t0, topT1: iv.t1 })),
        },
      });
      return;
    }
    // Rib waveguide: slab band + etch-angle trapezoid core — EXACTLY the
    // slab/rib dimension sources and ribBotW/ribTopW math scene3d lofts
    // (which itself mirrors generateHfssNative's wg emission).
    const coreW = evalExpr((wgLayer && wgLayer.core_width) || 'w_wg', pv);
    const slabH = evalExpr((wgLayer && wgLayer.slab_height) || 'h_slab', pv);
    const slabW = evalExpr((wgLayer && wgLayer.slab_width) || 'w_slab', pv);
    const etchDeg = evalExpr((wgLayer && wgLayer.etch_angle) || 'etch_angle', pv);
    const safeCoreW = Number.isFinite(coreW) && coreW > 0 ? coreW : 1.2;
    const safeSlabH = Number.isFinite(slabH) && slabH > 0 ? slabH : 0.1;
    const safeSlabW = Number.isFinite(slabW) && slabW > 0 ? slabW : 5.0;
    const safeAngle = Number.isFinite(etchDeg) && etchDeg > 0 && etchDeg <= 90 ? etchDeg : 70;
    const slabT = Math.min(safeSlabH, thk);
    const ribH = thk - slabT;
    const inward = ribH / Math.max(Math.tan((safeAngle * Math.PI) / 180), 1e-9);
    const widthRef = wgLayer && wgLayer.core_width_ref === 'bottom' ? 'bottom' : 'top';
    let ribBotW;
    let ribTopW;
    if (widthRef === 'top') {
      ribTopW = safeCoreW;
      ribBotW = safeCoreW + 2 * inward;
    } else {
      ribBotW = safeCoreW;
      ribTopW = safeCoreW - 2 * inward;
    }
    if (!(ribTopW > 0)) {
      warn('rib-pinch', `${c.id}: etch angle fully pinches the rib top (top width ≤ 0) — hairline top used.`);
      ribTopW = 1e-3;
    }
    let slabIvs = [];
    let botIvs = [];
    let topIvs = [];
    for (const inst of expandTransforms([c], pv)) {
      const guideAxis = inst.w >= inst.h ? 'x' : 'y';
      // Rect of the given PERPENDICULAR width along the guide axis, in the
      // instance's frame (rotation / mirror baked by the ring builder).
      const rectRing = (perpW) => shapeInstanceToRing({
        ...inst,
        kind: 'rect',
        cornerRadius: 0,
        w: guideAxis === 'x' ? inst.w : perpW,
        h: guideAxis === 'x' ? perpW : inst.h,
      });
      // WORLD-frame guide axis: the ring bakes the instance's rotation, so
      // the obliquity test must rotate the local axis too — a 90°-rotated
      // guide crossed perpendicularly was flagged 'oblique' (local axis
      // dotted against the world line direction).
      const rotRad = ((inst.rotation || 0) * Math.PI) / 180;
      const gL = guideAxis === 'x' ? [1, 0] : [0, 1];
      const sxI = inst.scaleX ?? 1;
      const syI = inst.scaleY ?? 1;
      const gU = [
        Math.cos(rotRad) * gL[0] * sxI - Math.sin(rotRad) * gL[1] * syI,
        Math.sin(rotRad) * gL[0] * sxI + Math.cos(rotRad) * gL[1] * syI,
      ];
      const b = intersectSegmentRing(p0, p1, rectRing(ribBotW));
      // Oblique crossing (line not perpendicular to the guide axis): the
      // ring intersection already yields the exact widened chords — the
      // manual 1/sin(θ) scale factor is implicit — but flag it so the
      // consumer knows the slice isn't a normal cross-section.
      if (b.length && Math.abs(ux * gU[0] + uy * gU[1]) > 1e-6) {
        warn('oblique-wg', `${c.id}: section line is not perpendicular to the waveguide axis — crossing widths carry the obliquity factor.`);
      }
      slabIvs = unionIntervals([...slabIvs, ...intersectSegmentRing(p0, p1, rectRing(safeSlabW))]);
      botIvs = unionIntervals([...botIvs, ...b]);
      topIvs = unionIntervals([...topIvs, ...intersectSegmentRing(p0, p1, rectRing(ribTopW))]);
    }
    if (slabIvs.length === 0 && botIvs.length === 0) return;
    // Pair each bottom interval with the top interval overlapping its
    // center; a rib whose (narrower) top the line misses degenerates to a
    // zero-width top at the bottom center.
    const segments = botIvs.map((biv) => {
      const mid = (biv.t0 + biv.t1) / 2;
      const top = topIvs.find((tiv) => tiv.t0 <= mid + EPS_T && tiv.t1 >= mid - EPS_T);
      return top
        ? { botT0: biv.t0, botT1: biv.t1, topT0: top.t0, topT1: top.t1 }
        : { botT0: biv.t0, botT1: biv.t1, topT0: mid, topT1: mid };
    });
    const entry = {
      id: c.id,
      layerId,
      material,
      color,
      core: {
        zBot: zL.zBottom + zOff + slabT,
        zTop: zL.zBottom + zOff + thk,
        segments,
      },
    };
    if (slabT > EPS_T && slabIvs.length) {
      entry.slabBand = {
        z0: zL.zBottom + zOff,
        z1: zL.zBottom + zOff + slabT,
        intervals: slabIvs,
      };
    }
    waveguides.push(entry);
  };

  for (const c of solved) {
    if (c.consumedBy) continue;              // operands ride their boolean root
    if (isNonModelComponent(c)) continue;    // section lines (incl. this one)
    if (c.layer === 'port') continue;        // excitation sheets, not material
    if (c.kind === 'via') {
      if (crossedAtAll(c)) warn('via-crossed', `${c.id}: via crossed by the section line — vias are vertical plugs a 2-D slice cannot represent; skipped.`);
      continue;
    }
    if (c.kind === 'bridge') {
      if (crossedAtAll(c)) warn('bridge-crossed', `${c.id}: airbridge footprint crossed by the section line — the 3-D arch is not representable in the slice; skipped.`);
      continue;
    }
    if (c.layer === 'waveguide') { handleWaveguide(c); continue; }
    if (c.layer === 'electrode') { handleConductor(c); continue; }
    warn('unknown-layer', `${c.id}: layer "${c.layer}" has no cross-section mapping — skipped.`);
  }

  // Determinism: conductors sorted by first interval start, ties by id.
  conductors.sort((a, b) => (a.intervals[0].t0 - b.intervals[0].t0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  waveguides.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // ── 3. wgCenter: crossed core nearest the line midpoint ───────────────
  let wgCenter = null;
  {
    const tMid = lengthUm / 2;
    let best = Infinity;
    for (const w of waveguides) {
      for (const seg of w.core.segments) {
        const mid = (seg.botT0 + seg.botT1) / 2;
        const d = Math.abs(mid - tMid);
        if (d < best - EPS_T) {
          best = d;
          wgCenter = { t: mid, z: (w.core.zBot + w.core.zTop) / 2, compId: w.id };
        }
      }
    }
  }

  // ── 4. Background slabs + synthetic air ───────────────────────────────
  // One full-width slab per stack layer, in stack (bottom → top) order.
  // Conductor-role layers get NO slab: their metal is the `conductors`
  // list, and the inter-conductor space at that Z is filled by whichever
  // background slab spans that Z range (the cladding in a coplanar device
  // group — mirroring how hfss-native / scene3d treat cladding fill).
  // Consumers paint slabs in list order, so a coplanar wg-film slab
  // overpainted by its coplanar cladding (then re-detailed by the
  // `waveguides` rib entries) reproduces the etched-film physics.
  const slabs = [];
  for (const l of stack) {
    if (l.role === 'conductor') continue;
    const z = layerZ[l.id];
    if (!z) continue;
    const entry = {
      layerId: l.id,
      name: l.name || l.id,
      material: l.material || '',
      color: l.color || '#94a3b8',
      role: l.role || 'substrate',
      z0: z.zBottom,
      z1: z.zTop,
    };
    if (parametricOn && layerZInner[l.id]) {
      attachZExprs(entry, layerZInner[l.id].botInner, layerZInner[l.id].topInner);
    }
    slabs.push(entry);
  }
  const zMin = slabs.length ? Math.min(...slabs.map((s) => s.z0)) : 0;
  const slabTop = slabs.length ? Math.max(...slabs.map((s) => s.z1)) : 0;
  // Physical top includes conductor layers (they may protrude past the
  // cladding — e.g. the default coplanar stack's 0.8 µm conductor over a
  // 0.6 µm cladding). The AIR slab starts at the top of the emitted
  // background slabs: when no cladding covers the conductor Z range that
  // point IS the exposed conductor-band bottom (the stack walk advances by
  // the cladding top, or — with no cladding at all — by the layer below the
  // conductor), so protruding / uncovered conductors are always embedded in
  // the air slab rather than floating in nothing.
  let condTop = -Infinity;
  for (const l of conductorLayers) {
    const z = layerZ[l.id];
    if (z && Number.isFinite(z.zTop)) condTop = Math.max(condTop, z.zTop);
  }
  const physTop = Math.max(slabTop, Number.isFinite(condTop) ? condTop : slabTop);
  const span = physTop - zMin;
  const zMax = physTop + Math.max(10, 0.3 * (Number.isFinite(span) && span > 0 ? span : 0));
  slabs.push({
    layerId: '__air',
    name: 'air',
    material: 'vacuum',
    color: '#e2e8f0',
    role: 'air',
    z0: slabTop,
    z1: zMax,
  });

  // ── 5. Params referenced by any emitted expression ────────────────────
  const params = {};
  {
    const exprStrings = [];
    for (const s of slabs) { if (s.z0Expr) exprStrings.push(s.z0Expr); if (s.z1Expr) exprStrings.push(s.z1Expr); }
    for (const c of conductors) {
      if (c.z0Expr) exprStrings.push(c.z0Expr);
      if (c.z1Expr) exprStrings.push(c.z1Expr);
      for (const iv of c.intervals) {
        if (iv.t0Expr) exprStrings.push(iv.t0Expr);
        if (iv.t1Expr) exprStrings.push(iv.t1Expr);
      }
    }
    for (const s of exprStrings) {
      for (const id of tokenizeIdents(s)) {
        if (RESERVED_IDENTS.has(id)) continue;
        if (!Object.prototype.hasOwnProperty.call(pv, id)) continue;
        if (!(id in params) && Number.isFinite(pv[id])) params[id] = pv[id];
      }
    }
  }

  return {
    ok: true,
    sectionId: sec.id,
    line: { p0, p1, lengthUm, axis },
    domain: { tMin: 0, tMax: lengthUm, zMin, zMax },
    slabs,
    conductors,
    waveguides,
    wgCenter,
    params,
    warnings,
  };
}
