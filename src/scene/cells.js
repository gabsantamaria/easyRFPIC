// Parametric cell system: define once, instantiate many, update all.
//
// A CELL DEFINITION is a self-contained scene fragment — components +
// internal snaps + every parameter their expressions reference
// (transitive closure) — whose params form the cell's INTERFACE (the
// param exprs are the defaults). Instantiating a cell stamps a fully
// prefixed copy into the scene: every def-local identifier (param
// names AND component ids) becomes `<prefix>_<name>`, so two instances
// coexist without collisions and each instance's knobs are ordinary
// scene params (`<prefix>_*`) — which is exactly why HFSS parametricity
// is free: the exporters see plain parametric components.
//
// The rename machinery reuses `renameIdentInScene` (field coverage =
// every expression-bearing field in the scene model) by building the
// fragment as a mini-scene and walking it once per def-local name.
// Structural references (component `id`, `consumedBy`, `operandIds`,
// snap `from`/`to`, snap-pinned vertices) are remapped separately —
// renameIdentInScene rewrites expression STRINGS only, by contract.
//
// Components stamped by `instantiateCell` carry a provenance tag:
//   cellInstance: { cell: <def name>, inst: <prefix> }
// `updateInstancesFromCell` uses the tags to find every instance of a
// cell, capture the user's per-instance param overrides + the
// instance's current center, and rebuild it from the (new) master
// definition in place.
import { tokenizeIdents, tokenizeComponentExprs, resolveParams, evalExpr } from './params.js';
import { renameIdentInScene } from './rename-ident.js';

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Deep clone for JSON-safe scene fragments (components / snaps / params
// are plain data; no functions, Dates, or cycles).
function deep(x) {
  return x == null ? x : JSON.parse(JSON.stringify(x));
}

// Numeric AABB center of a component list. w/h are expression strings
// evaluated against `paramValues`; components whose w/h don't resolve
// contribute a zero-size box at (cx, cy), so the center stays finite
// for any non-empty list. Exported for tests.
export function cellComponentsBbox(components, paramValues) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const c of components || []) {
    const cx = Number.isFinite(c.cx) ? c.cx : 0;
    const cy = Number.isFinite(c.cy) ? c.cy : 0;
    const w = Math.abs(evalExpr(c.w, paramValues)) || 0;
    const h = Math.abs(evalExpr(c.h, paramValues)) || 0;
    minX = Math.min(minX, cx - w / 2);
    maxX = Math.max(maxX, cx + w / 2);
    minY = Math.min(minY, cy - h / 2);
    maxY = Math.max(maxY, cy + h / 2);
  }
  if (!Number.isFinite(minX)) return { cx: 0, cy: 0 };
  return { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
}

// ─────────────────────────────────────────────────────────────────────
// makeCellFromSelection(scene, selectedIds, cellName)
//
// Collect the selected components + internal snaps (both endpoints
// inside the selection) + every param referenced by their expressions
// (transitive closure via tokenizeIdents — field coverage comes from
// tokenizeComponentExprs, the same walk the rename machinery mirrors).
// Positions are normalized relative to the selection bbox center, so a
// definition is centered on (0, 0). consumedBy / operandIds / snap-
// pinned vertices that point OUTSIDE the selection are stripped (the
// fragment must be self-contained); external snaps are dropped. All
// removals are reported in the returned `warnings` list.
//
// Returns { def, warnings }. `def` is null when the selection is empty.
export function makeCellFromSelection(scene, selectedIds, cellName) {
  const warnings = [];
  const idSet = selectedIds instanceof Set ? selectedIds : new Set(selectedIds || []);
  const picked = (scene?.components || []).filter((c) => idSet.has(c.id));
  if (picked.length === 0) {
    return { def: null, warnings: ['empty selection — nothing to save'] };
  }

  // Internal snaps: BOTH endpoints inside the selection. Snaps that
  // cross the boundary are external dependencies a self-contained
  // fragment can't keep — drop with a warning.
  const snaps = [];
  for (const s of scene.snaps || []) {
    const fromIn = idSet.has(s?.from?.compId);
    const toIn = idSet.has(s?.to?.compId);
    if (fromIn && toIn) {
      snaps.push(deep(s));
    } else if (fromIn || toIn) {
      warnings.push(
        `snap ${s?.from?.compId ?? '?'} → ${s?.to?.compId ?? '?'} crosses the selection boundary — dropped`
      );
    }
  }

  // Param closure. DIRECT params are referenced straight from a
  // component / snap expression; the rest of the closure (params
  // referenced only by other params' exprs) is recorded in
  // internalParamNames — still part of the def (it must be
  // self-contained) but not a primary interface knob.
  const sceneParams = scene.params || {};
  const direct = new Set();
  for (const c of picked) {
    for (const ident of tokenizeComponentExprs(c)) {
      if (sceneParams[ident]) direct.add(ident);
    }
  }
  for (const s of snaps) {
    for (const ident of [...tokenizeIdents(s.dx), ...tokenizeIdents(s.dy)]) {
      if (sceneParams[ident]) direct.add(ident);
    }
  }
  const referenced = new Set(direct);
  const queue = [...direct];
  while (queue.length > 0) {
    const pname = queue.shift();
    for (const ident of tokenizeIdents(sceneParams[pname]?.expr ?? '')) {
      if (sceneParams[ident] && !referenced.has(ident)) {
        referenced.add(ident);
        queue.push(ident);
      }
    }
  }
  const params = {};
  for (const pname of referenced) params[pname] = deep(sceneParams[pname]);

  // Component copies, scrubbed of references that point outside the
  // selection. A stale provenance tag from a previous instantiation
  // must not ride into a fresh definition.
  const components = picked.map((orig) => {
    const c = deep(orig);
    delete c.cellInstance;
    if (c.consumedBy && !idSet.has(c.consumedBy)) {
      warnings.push(`${c.id}: consumedBy "${c.consumedBy}" is outside the selection — cleared`);
      delete c.consumedBy;
    }
    if (Array.isArray(c.operandIds)) {
      const kept = c.operandIds.filter((id) => idSet.has(id));
      if (kept.length !== c.operandIds.length) {
        warnings.push(`${c.id}: boolean operand(s) outside the selection — dropped`);
        c.operandIds = kept;
      }
    }
    if (Array.isArray(c.vertices)) {
      c.vertices = c.vertices.map((v) => {
        if (v && v.kind === 'snap' && v.compId && !idSet.has(v.compId)) {
          warnings.push(`${c.id}: vertex snapped to external component "${v.compId}" — converted to rel (0, 0)`);
          return { kind: 'rel', dx: '0', dy: '0', ...(v.width != null ? { width: v.width } : {}) };
        }
        return v;
      });
    }
    return c;
  });

  // Normalize positions so the fragment is centered on (0, 0). Uses
  // the scene's resolved param values for the bbox math (w/h are
  // expression strings).
  const { values } = resolveParams(sceneParams);
  const center = cellComponentsBbox(components, values);
  for (const c of components) {
    c.cx = (Number.isFinite(c.cx) ? c.cx : 0) - center.cx;
    c.cy = (Number.isFinite(c.cy) ? c.cy : 0) - center.cy;
  }

  const def = {
    name: cellName,
    description: '',
    params,
    components,
    snaps,
    // Params in the closure that no component / snap references
    // directly — needed for self-containment, but secondary knobs.
    internalParamNames: [...referenced].filter((n) => !direct.has(n)).sort(),
    createdAt: Date.now(),
  };
  return { def, warnings };
}

// ─────────────────────────────────────────────────────────────────────
// instantiateCell(def, prefix, overrides, atX, atY)
//
// Stamp one instance of `def` with every def-local identifier (param
// names and component ids) prefixed `<prefix>_`. Param exprs =
// overrides[pname] ?? the (rename-walked) default. Components are
// offset so the fragment's bbox center lands at (atX, atY), and each
// carries cellInstance: { cell: def.name, inst: prefix }.
//
// Override exprs are applied AFTER the prefix walk, verbatim — they
// live in the DESTINATION scene's namespace (this is what lets
// updateInstancesFromCell re-apply captured `<prefix>_*` exprs without
// double-prefixing them).
//
// Returns { params, components, snaps } ready to merge into a scene.
export function instantiateCell(def, prefix, overrides = {}, atX = 0, atY = 0) {
  if (!def || !IDENT_RE.test(prefix || '')) {
    return { params: {}, components: [], snaps: [] };
  }
  // Build the fragment as a mini-scene so renameIdentInScene's full
  // field coverage (component knobs, cutouts, transforms, vertices,
  // snap dx/dy) applies to it directly.
  let mini = {
    params: deep(def.params || {}),
    components: deep(def.components || []),
    snaps: deep(def.snaps || []),
    mirrors: [],
    groups: [],
    booleans: [],
    stack: [],
  };
  const paramNames = Object.keys(mini.params).filter((n) => IDENT_RE.test(n));
  const compIds = mini.components.map((c) => c.id).filter((id) => IDENT_RE.test(id || ''));

  // 1) Expression rewrite for every def-local name. Component ids also
  //    appear in expressions via the synthetic `_comp_<id>_<axis>`
  //    params — `\b<id>\b` can't match inside those (underscores are
  //    word chars), so the synthetics get their own rename walk.
  for (const pn of paramNames) {
    mini = renameIdentInScene(mini, pn, `${prefix}_${pn}`);
  }
  for (const cid of compIds) {
    mini = renameIdentInScene(mini, cid, `${prefix}_${cid}`);
    for (const ax of ['cx', 'cy', 'w', 'h']) {
      mini = renameIdentInScene(mini, `_comp_${cid}_${ax}`, `_comp_${prefix}_${cid}_${ax}`);
    }
  }

  // 2) Structural remap: ids + every id-bearing reference field.
  const idMap = Object.fromEntries(compIds.map((id) => [id, `${prefix}_${id}`]));
  const components = mini.components.map((c) => {
    const next = { ...c, id: idMap[c.id] || c.id };
    if (next.consumedBy && idMap[next.consumedBy]) next.consumedBy = idMap[next.consumedBy];
    if (next.cloneOf && idMap[next.cloneOf]) next.cloneOf = idMap[next.cloneOf];
    if (Array.isArray(next.operandIds)) {
      next.operandIds = next.operandIds.map((id) => idMap[id] || id);
    }
    if (Array.isArray(next.vertices)) {
      next.vertices = next.vertices.map((v) =>
        v && v.kind === 'snap' && idMap[v.compId] ? { ...v, compId: idMap[v.compId] } : v
      );
    }
    // Remap the GROUP TAG per instance: c.group drives the rotate/mirror
    // pivot 'group' centroid (siblings found by tag). Left verbatim, two
    // instances of the same cell — including the 2-line wizard's
    // lineA_/lineB_ stamps — would share ONE tag and every consumer
    // (canvas, solver, exporters) would compute a MERGED centroid across
    // both instances, bending each instance's group-rotated members away
    // from the drawn design (adversarial-review find).
    if (next.group) next.group = `${prefix}_${next.group}`;
    next.cellInstance = { cell: def.name, inst: prefix };
    return next;
  });
  const snaps = mini.snaps.map((s, i) => ({
    ...s,
    id: `snap_cell_${prefix}_${i}_${Math.random().toString(36).slice(2, 6)}`,
    from: { ...s.from, compId: idMap[s.from?.compId] || s.from?.compId },
    to: { ...s.to, compId: idMap[s.to?.compId] || s.to?.compId },
  }));

  // 3) Re-key the param dict to the prefixed names (renameIdentInScene
  //    rewrites exprs only, not keys), then lay overrides on top.
  const params = {};
  for (const pn of paramNames) {
    params[`${prefix}_${pn}`] = { ...mini.params[pn] };
  }
  for (const [pname, expr] of Object.entries(overrides || {})) {
    const key = `${prefix}_${pname}`;
    if (params[key] && typeof expr === 'string' && expr.trim() !== '') {
      params[key] = { ...params[key], expr };
    }
  }

  // 4) Offset the fragment so its bbox center (under the instance's
  //    own resolved params, overrides included) lands at (atX, atY).
  //    Defs from makeCellFromSelection are already centered on (0, 0),
  //    but recomputing keeps hand-written defs honest.
  const { values } = resolveParams(params);
  const center = cellComponentsBbox(components, values);
  const dx = atX - center.cx;
  const dy = atY - center.cy;
  for (const c of components) {
    c.cx = (Number.isFinite(c.cx) ? c.cx : 0) + dx;
    c.cy = (Number.isFinite(c.cy) ? c.cy : 0) + dy;
  }

  return { params, components, snaps };
}

// ─────────────────────────────────────────────────────────────────────
// updateInstancesFromCell(scene, def)
//
// For every distinct instance prefix tagged with this cell's name:
//   - capture the current `<prefix>_*` param exprs (the user's
//     overrides) and the instance's current bbox center,
//   - remove the instance's components, its internal snaps, and ALL of
//     its prefixed params,
//   - re-instantiate the (new) def at the same center, re-applying the
//     captured exprs where the param still exists in the new interface
//     (new params get defaults; orphaned user params are dropped),
//   - drop external snaps whose instance-side endpoint no longer
//     exists in the rebuilt instance (unchanged component ids keep
//     their external snaps — same prefix + same def id ⇒ same scene id).
//
// Returns { scene, summary } — scene is a NEW object (input untouched);
// summary.instances lists per-instance change details for a confirm
// dialog. The def is also written into scene.cells so the design stays
// self-contained.
export function updateInstancesFromCell(scene, def) {
  const cellName = def?.name;
  const summary = { cell: cellName, instances: [] };
  if (!scene || !cellName) return { scene, summary };

  // Distinct prefixes tagged with this cell, in first-seen order.
  const instances = new Map(); // prefix → [components]
  for (const c of scene.components || []) {
    const tag = c.cellInstance;
    if (tag && tag.cell === cellName && tag.inst) {
      if (!instances.has(tag.inst)) instances.set(tag.inst, []);
      instances.get(tag.inst).push(c);
    }
  }
  if (instances.size === 0) {
    return { scene: { ...scene, cells: { ...(scene.cells || {}), [cellName]: def } }, summary };
  }

  // Bbox centers are evaluated against the PRE-update param values, so
  // a user override that changes a size still reads the live geometry.
  const { values: sceneValues } = resolveParams(scene.params || {});

  let params = { ...(scene.params || {}) };
  let components = [...(scene.components || [])];
  let snaps = [...(scene.snaps || [])];

  for (const [prefix, comps] of instances) {
    const oldIds = new Set(comps.map((c) => c.id));
    const center = cellComponentsBbox(comps, sceneValues);

    // Capture overrides + drop every `<prefix>_*` param. Params whose
    // unprefixed name survives in the new interface come back via the
    // overrides; the rest are orphans of the old interface.
    const pp = `${prefix}_`;
    const overrides = {};
    const keptOverrides = [];
    const removedParams = [];
    for (const [k, v] of Object.entries(params)) {
      if (!k.startsWith(pp)) continue;
      const base = k.slice(pp.length);
      if (def.params && def.params[base]) {
        overrides[base] = v.expr;
        keptOverrides.push(k);
      } else {
        removedParams.push(k);
      }
      delete params[k];
    }

    // Remove the instance's components and internal snaps.
    components = components.filter((c) => !oldIds.has(c.id));
    snaps = snaps.filter((s) => !(oldIds.has(s?.from?.compId) && oldIds.has(s?.to?.compId)));

    // Rebuild at the captured center with captured exprs re-applied.
    const inst = instantiateCell(def, prefix, overrides, center.cx, center.cy);
    params = { ...params, ...inst.params };
    components = [...components, ...inst.components];
    snaps = [...snaps, ...inst.snaps];

    // External snaps that referenced an old instance component which no
    // longer exists (renamed / removed in the new def) would dangle —
    // drop them and report.
    const liveIds = new Set(components.map((c) => c.id));
    let droppedExternalSnaps = 0;
    snaps = snaps.filter((s) => {
      const fromGone = oldIds.has(s?.from?.compId) && !liveIds.has(s?.from?.compId);
      const toGone = oldIds.has(s?.to?.compId) && !liveIds.has(s?.to?.compId);
      if (fromGone || toGone) { droppedExternalSnaps++; return false; }
      return true;
    });

    summary.instances.push({
      inst: prefix,
      center: { x: center.cx, y: center.cy },
      components: inst.components.length,
      keptOverrides: keptOverrides.sort(),
      addedParams: Object.keys(inst.params).filter((k) => !keptOverrides.includes(k)).sort(),
      removedParams: removedParams.sort(),
      droppedExternalSnaps,
    });
  }

  const nextScene = {
    ...scene,
    params,
    components,
    snaps,
    cells: { ...(scene.cells || {}), [cellName]: def },
  };
  return { scene: nextScene, summary };
}
