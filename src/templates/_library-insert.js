// Insert a library-item payload into a scene.
//
// Shared between two call paths:
//   - App's Library panel "insert" button (live items in localStorage).
//   - Generated built-in templates that bake a library payload as a
//     constant and dispatch to this helper from their insert() method.
//
// Behavior matches the original inline insertLibraryItem logic in App:
//   - GROUP-ALIASED params always get a fresh, unique name on insert so
//     each instance has its own knobs.
//   - GLOBAL params are reused if already present in the destination,
//     otherwise added as-is (no rename, no overwrite).
//   - Component ids and group names get collision-avoidance suffixes.
//   - Every expression in components, cutouts, and snaps is rewritten
//     so any renamed param refs keep resolving.
//   - The payload bbox is centered on viewport.{x,y} via a uniform
//     translation, so the inserted geometry lands where the user is
//     currently looking.
import { evalExpr } from '../scene/params.js';

export function insertLibraryPayload(prev, ctx, payload) {
  const viewport = ctx?.viewport || { x: 0, y: 0 };
  const paramValues = ctx?.paramValues || {};
  if (!payload || !Array.isArray(payload.components)) return prev;

  const newParams = { ...prev.params };
  const newComponents = [...prev.components];
  const newSnaps = [...prev.snaps];

  // Identify which params in the payload are "group-aliased" vs "global".
  // Aliased params are the ones that appear as VALUES in some group's
  // aliases map; global params are everything else.
  const aliasedParamNames = new Set();
  for (const g of (payload.groups || [])) {
    for (const aliasName of Object.values(g.aliases || {})) {
      aliasedParamNames.add(aliasName);
    }
  }

  const paramMap = {};
  const usedParamNames = new Set(Object.keys(prev.params));
  for (const pname of Object.keys(payload.params || {})) {
    if (aliasedParamNames.has(pname)) {
      let newName = pname;
      let i = 2;
      while (usedParamNames.has(newName)) { newName = `${pname}_${i++}`; }
      usedParamNames.add(newName);
      paramMap[pname] = newName;
    } else {
      paramMap[pname] = pname;
      if (!prev.params[pname]) usedParamNames.add(pname);
    }
  }

  const idMap = {};
  const usedCompIds = new Set(prev.components.map(c => c.id));
  for (const c of payload.components) {
    let newId = c.id;
    let i = 2;
    while (usedCompIds.has(newId)) { newId = `${c.id}_${i++}`; }
    usedCompIds.add(newId);
    idMap[c.id] = newId;
  }

  // Word-boundary replacement of every renamed param in `expr`. Sorted
  // longer-first so prefixes don't partially match longer names.
  const replaceIn = (expr) => {
    if (typeof expr !== 'string') return expr;
    let out = expr;
    const keys = Object.keys(paramMap)
      .filter(k => paramMap[k] !== k)
      .sort((a, b) => b.length - a.length);
    for (const k of keys) {
      out = out.replace(new RegExp(`\\b${k}\\b`, 'g'), paramMap[k]);
    }
    return out;
  };

  // Add params: aliased ones always; globals only if missing.
  for (const [origName, p] of Object.entries(payload.params || {})) {
    const newName = paramMap[origName];
    if (aliasedParamNames.has(origName)) {
      newParams[newName] = { ...p, expr: replaceIn(p.expr) };
    } else if (!prev.params[newName]) {
      newParams[newName] = { ...p, expr: replaceIn(p.expr) };
    }
  }

  // Offset to viewport center using the payload's own component bbox.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const c of payload.components) {
    const w = evalExpr(c.w, paramValues) || 10;
    const h = evalExpr(c.h, paramValues) || 10;
    minX = Math.min(minX, c.cx - w / 2);
    maxX = Math.max(maxX, c.cx + w / 2);
    minY = Math.min(minY, c.cy - h / 2);
    maxY = Math.max(maxY, c.cy + h / 2);
  }
  const itemCx = Number.isFinite(minX) ? (minX + maxX) / 2 : 0;
  const itemCy = Number.isFinite(minY) ? (minY + maxY) / 2 : 0;
  const dx = viewport.x - itemCx;
  const dy = viewport.y - itemCy;

  for (const c of payload.components) {
    newComponents.push({
      ...c,
      id: idMap[c.id],
      cx: c.cx + dx,
      cy: c.cy + dy,
      w: replaceIn(c.w),
      h: replaceIn(c.h),
      cutouts: (c.cutouts || []).map(cu => ({
        ...cu,
        dx: replaceIn(cu.dx), dy: replaceIn(cu.dy),
        w: replaceIn(cu.w), h: replaceIn(cu.h),
      })),
      group: undefined, // re-stamped below when re-creating groups
    });
  }

  const ts = Date.now();
  for (const s of (payload.snaps || [])) {
    newSnaps.push({
      ...s,
      id: `snap_${ts}_${Math.random().toString(36).slice(2, 6)}`,
      from: { ...s.from, compId: idMap[s.from.compId] },
      to:   { ...s.to,   compId: idMap[s.to.compId] },
      dx: replaceIn(s.dx),
      dy: replaceIn(s.dy),
    });
  }

  // Re-create groups with fresh names + remapped members + remapped aliases.
  const newGroups = [...prev.groups];
  const usedGroupNames = new Set(prev.groups.map(g => g.name));
  for (const g of (payload.groups || [])) {
    let gname = g.name;
    let i = 2;
    while (usedGroupNames.has(gname)) { gname = `${g.name}_${i++}`; }
    usedGroupNames.add(gname);
    const newAliases = {};
    for (const [orig, oldAlias] of Object.entries(g.aliases || {})) {
      const newOrig  = paramMap[orig]     || orig;
      const newAlias = paramMap[oldAlias] || oldAlias;
      newAliases[newOrig] = newAlias;
    }
    const memberIds = g.memberIds.map(id => idMap[id]).filter(Boolean);
    newGroups.push({
      id: `group_${ts.toString(36)}_${Math.random().toString(36).slice(2, 5)}`,
      name: gname,
      memberIds,
      aliases: newAliases,
    });
    for (const memberNewId of memberIds) {
      const idx = newComponents.findIndex(c => c.id === memberNewId);
      if (idx >= 0) newComponents[idx] = { ...newComponents[idx], group: gname };
    }
  }

  return {
    ...prev,
    params: newParams,
    components: newComponents,
    snaps: newSnaps,
    groups: newGroups,
  };
}
