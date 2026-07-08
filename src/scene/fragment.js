// Shape-fragment build/insert — the PURE core behind Copy/Paste,
// "Download selection", and "Upload shapes here…" (PhotonicLayout's
// buildSelectionFragment / applyShapeFragment delegate here).
//
// A fragment is { components, snaps, params }:
//   - components: deep-ish copies of the selected components
//   - snaps: only INTERNAL links (both endpoints inside the selection)
//   - params: the transitive closure of every referenced parameter
//
// Cross-design semantics (the "uploaded shape distorted / missing a
// piece" bug class):
//   - Polyline/polyshape SNAP-kind vertices pinned to a component OUTSIDE
//     the selection are FROZEN into geometry-preserving rel steps at
//     BUILD time (computed from the solved vertex positions) — a symbolic
//     pin can't survive without its target. INTERNAL pins stay symbolic
//     and are remapped to the fresh ids at INSERT time (they used to be
//     left pointing at the ORIGINAL ids: dangling in a cross-design
//     upload, the shape silently collapsed to a point).
//   - Param collisions with DIFFERENT values are surfaced by
//     fragmentParamConflicts; the caller shows a keep-current /
//     use-imported choice (the old dest-wins merge silently reshaped the
//     imported geometry to the destination's values).
import { tokenizeIdents, tokenizeComponentExprs, RESERVED_IDENTS } from './params.js';
import { solveLayout, applyMirrors } from './solver.js';
import { resolvePolylineVertices } from '../geometry/polyline.js';

// Build a fragment from `scene` for the selected `ids` (a Set).
// `paramValues` = resolved values (used to freeze external vertex pins).
export function buildFragmentFromScene(scene, ids, paramValues = {}) {
  if (!ids || ids.size === 0) return null;
  const components = (scene.components || [])
    .filter(c => ids.has(c.id))
    .map(c => ({ ...c, cutouts: (c.cutouts || []).map(cu => ({ ...cu })) }));
  if (components.length === 0) return null;
  // Freeze EXTERNAL vertex pins (see header). Solved positions are only
  // computed when at least one external pin exists.
  const needsVertexFreeze = components.some(c =>
    Array.isArray(c.vertices) && c.vertices.some(v => v && v.kind === 'snap' && !ids.has(v.compId)));
  if (needsVertexFreeze) {
    const solved = applyMirrors(solveLayout(scene.components, scene.snaps, paramValues), scene.mirrors || []);
    const byIdSolved = Object.fromEntries(solved.map(c => [c.id, c]));
    for (const c of components) {
      if (!Array.isArray(c.vertices)) continue;
      if (!c.vertices.some(v => v && v.kind === 'snap' && !ids.has(v.compId))) continue;
      const solvedC = byIdSolved[c.id] || c;
      const pos = resolvePolylineVertices(solvedC, byIdSolved, paramValues);
      c.vertices = c.vertices.map((v, i) => {
        if (!v || v.kind !== 'snap' || ids.has(v.compId)) return v ? { ...v } : v;
        const [px, py] = pos[i] || [NaN, NaN];
        const [qx, qy] = i === 0 ? [solvedC.cx, solvedC.cy] : (pos[i - 1] || [NaN, NaN]);
        const dxN = Number.isFinite(px) && Number.isFinite(qx) ? px - qx : 0;
        const dyN = Number.isFinite(py) && Number.isFinite(qy) ? py - qy : 0;
        return {
          kind: 'rel',
          dx: Number(dxN.toFixed(4)).toString(),
          dy: Number(dyN.toFixed(4)).toString(),
          ...(v.width != null && String(v.width).trim() !== '' ? { width: v.width } : {}),
        };
      });
    }
  }
  const snaps = (scene.snaps || [])
    .filter(s => ids.has(s.from.compId) && ids.has(s.to.compId))
    .map(s => ({ ...s }));
  // Transitive param closure over every expression the fragment carries.
  const params = {};
  const used = new Set();
  const frontier = [];
  for (const c of components) for (const id of tokenizeComponentExprs(c)) frontier.push(id);
  for (const s of snaps) for (const expr of [s.dx, s.dy]) {
    if (typeof expr === 'string') for (const id of tokenizeIdents(expr)) frontier.push(id);
  }
  while (frontier.length) {
    const id = frontier.pop();
    if (RESERVED_IDENTS.has(id) || id.startsWith('_comp_') || used.has(id)) continue;
    const p = (scene.params || {})[id];
    if (!p) continue;
    used.add(id);
    params[id] = { ...p };
    if (typeof p.expr === 'string') for (const childId of tokenizeIdents(p.expr)) {
      if (!used.has(childId)) frontier.push(childId);
    }
  }
  return { components, snaps, params };
}

// Param collisions between the destination scene and the fragment where
// the VALUES differ (equal-value collisions merge silently). Returns
// [{ name, current, imported }].
export function fragmentParamConflicts(sceneParams, cbParams) {
  const out = [];
  for (const [name, p] of Object.entries(cbParams || {})) {
    const mine = (sceneParams || {})[name];
    if (!mine) continue;
    const a = String(mine.expr ?? '').trim();
    const b = String(p.expr ?? '').trim();
    if (a !== b) out.push({ name, current: a, imported: b });
  }
  return out;
}

// Compute the insertion (pure): fresh `<id>_copy` ids, snap endpoints AND
// snap-kind vertices remapped, params merged (destination wins UNLESS
// opts.useImported — then differing collisions take the fragment's expr),
// fragment centroid placed at opts.at (world) or offset by 5 grid steps.
// Returns { components, snaps, params, newIds } — the full next-scene
// pieces — or null for an empty fragment.
export function insertFragmentIntoScene(scene, cb, opts = {}) {
  if (!cb || !Array.isArray(cb.components) || cb.components.length === 0) return null;
  const idMap = {};
  const existingIds = new Set((scene.components || []).map(c => c.id));
  for (const c of cb.components) {
    let candidate = `${c.id}_copy`;
    let i = 2;
    while (existingIds.has(candidate)) candidate = `${c.id}_copy${i++}`;
    existingIds.add(candidate);
    idMap[c.id] = candidate;
  }
  let dx, dy;
  if (opts.at && Number.isFinite(opts.at.x) && Number.isFinite(opts.at.y)) {
    let sx = 0, sy = 0, n = 0;
    for (const c of cb.components) {
      if (Number.isFinite(c.cx) && Number.isFinite(c.cy)) { sx += c.cx; sy += c.cy; n++; }
    }
    dx = opts.at.x - (n ? sx / n : 0);
    dy = opts.at.y - (n ? sy / n : 0);
  } else {
    const offset = (opts.gridSize || 2) * 5;
    dx = offset; dy = -offset;
  }
  const destIds = new Set((scene.components || []).map(c => c.id));
  const components = cb.components.map(c => ({
    ...c,
    id: idMap[c.id],
    cx: (Number.isFinite(c.cx) ? c.cx : 0) + dx,
    cy: (Number.isFinite(c.cy) ? c.cy : 0) + dy,
    // SNAP-kind vertices follow the same remap rules as snap endpoints:
    // internal target → fresh id; destination target (same-design paste)
    // → keep tracking; would-dangle → zero rel step (defensive — build
    // already froze external pins).
    ...(Array.isArray(c.vertices) ? {
      vertices: c.vertices.map(v => {
        if (!v || v.kind !== 'snap') return v ? { ...v } : v;
        if (idMap[v.compId]) return { ...v, compId: idMap[v.compId] };
        if (destIds.has(v.compId)) return { ...v };
        return {
          kind: 'rel', dx: '0', dy: '0',
          ...(v.width != null && String(v.width).trim() !== '' ? { width: v.width } : {}),
        };
      }),
    } : {}),
    // Strip the group tag: fragments don't carry scene.groups; a pasted
    // copy naming a DESTINATION group would half-join it (the membership-
    // desync class).
    group: undefined,
  }));
  const snaps = (cb.snaps || [])
    .filter(s => idMap[s.from?.compId] && idMap[s.to?.compId])
    .map((s, i) => ({
      ...s,
      id: `snap_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 6)}`,
      from: { ...s.from, compId: idMap[s.from.compId] },
      to: { ...s.to, compId: idMap[s.to.compId] },
    }));
  const params = { ...(scene.params || {}) };
  for (const [name, p] of Object.entries(cb.params || {})) {
    if (!(name in params)) params[name] = { ...p };
    else if (opts.useImported && String(params[name].expr ?? '').trim() !== String(p.expr ?? '').trim()) {
      params[name] = { ...params[name], expr: p.expr };
    }
  }
  return { components, snaps, params, newIds: components.map(c => c.id) };
}
