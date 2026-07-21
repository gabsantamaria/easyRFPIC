// Scene schema and factories.
//
// `defaultStack` returns the bottom-up list of process-stack layers
// (substrate / waveguide / conductor / cladding) for a brand-new design.
// `normalizeScene` reads a possibly-old scene-blob from storage and
// upgrades it to the current shape (legacy fields, missing keys, etc).
// `makeDefaultScene` and `makeBlankScene` produce the two canned
// starting points used by the New / Open flows.
//
// `makeDefaultScene` loads a frozen JSON asset (default-scene.json) so
// the canonical "first-run" demo can be refreshed by re-exporting it
// from the app and dropping the new file in place — no code edits.
//
// Pure JS — no external deps. Extracted from PhotonicLayout.jsx as
// Stage 3.1 of the planned refactor.
import defaultSceneJson from './default-scene.json' with { type: 'json' };

// ----------------------------------------------------------------------
// NON-MODEL COMPONENTS
// ----------------------------------------------------------------------
// Two layers qualify, for different reasons:
//   'section'  — an ANNOTATION, not geometry: exists only on the canvas
//                (the cross-section slicing line feeding the Q2D / Tidy3D
//                wizards).
//   'gdsundef' — an imported GDS shape whose layer mapping was left
//                `<undefined>` at import: REAL geometry-in-waiting, but
//                with no stack layer it has no Z/thickness/material, so
//                no physical export can represent it. It renders on the
//                canvas (dim/dashed), solves, and snaps — assigning it a
//                canvas layer later (Inspector) makes it a normal
//                component.
// EVERY physical consumer — HFSS native, pyAEDT, GDS, gdsfactory, the
// 3-D viewer, the two-line scene builder, cross-section slicing — must
// skip components for which this returns true. Central predicate so a
// new exporter can't forget the rule by re-deriving it from layer
// strings. (Both stay solver-visible: children snapped to them must land
// where the canvas puts them, and hfss-native computes parametric
// positions on the FULL solved list.)
export function isNonModelComponent(c) {
  // Three ways a component is CANVAS-ONLY (never emitted by any physical
  // exporter — HFSS native, pyAEDT, GDS, gdsfactory, 3-D preview,
  // two-line, Q2D/Q3D — while still solving, snapping, and rendering):
  //   - 'section'  : cross-section cut annotation
  //   - 'gdsundef' : unassigned GDS import (geometry-in-waiting)
  //   - exportExclude: USER-flagged exclusion (Inspector checkbox /
  //     context menu) — reference outlines, construction geometry,
  //     alternates kept on canvas. The TOP-LEVEL consuming boolean's
  //     flag governs a whole cluster: normalizeScene SYNCS the flag
  //     down onto every consumed operand (set AND clear), so excluding
  //     a boolean removes its operand parts from the exports too, and
  //     an individually-flagged operand self-heals to its root's state
  //     (a half-excluded cluster would silently corrupt the exported
  //     boolean — same hazard class as 'gdsundef' operands).
  return !!c && (c.layer === 'section' || c.layer === 'gdsundef' || !!c.exportExclude);
}

// ----------------------------------------------------------------------
// DEFAULT SCENE
// ----------------------------------------------------------------------

// Nominal values for every identifier the default stack references
// across its thickness / core_width / slab_height / slab_width /
// etch_angle fields. Shared between `paramsForStack` (used by
// makeBlankScene and by normalizeScene's upgrade-old-scene path) so
// blank scenes start with the same stack tuning a freshly-loaded
// design would have.
const STACK_PARAM_DEFAULTS = {
  h_si:       { expr: '250', unit: 'µm',  desc: 'Silicon handle thickness' },
  h_sio2:     { expr: '4.7', unit: 'µm',  desc: 'Buried oxide thickness' },
  h_wg:       { expr: '0.6', unit: 'µm',  desc: 'WG total height (LiTaO3 layer)' },
  h_clad:     { expr: '2',   unit: 'µm',  desc: 'Cladding thickness' },
  h_cond:     { expr: '0.8', unit: 'µm',  desc: 'Conductor (electrode) thickness' },
  w_wg:       { expr: '1.2', unit: 'µm',  desc: 'WG core width (rib bottom)' },
  h_slab:     { expr: '0.1', unit: 'µm',  desc: 'Slab height (unetched LiTaO3 below rib)' },
  w_slab:     { expr: '5',   unit: 'µm',  desc: 'Slab width (around rib)' },
  etch_angle: { expr: '70',  unit: 'deg', desc: 'Etch sidewall angle from horizontal' },
};

// Collect every identifier referenced from the given stack's expression
// fields and return a params dict with nominal defaults for each.
// Identifiers not in STACK_PARAM_DEFAULTS get a generic 1 µm fallback.
export function paramsForStack(stack) {
  const out = {};
  for (const layer of stack || []) {
    const fields = ['thickness', 'core_width', 'slab_height', 'slab_width', 'etch_angle'];
    for (const f of fields) {
      const v = layer[f];
      if (typeof v !== 'string') continue;
      const idents = v.match(/[A-Za-z_][A-Za-z0-9_]*/g) || [];
      for (const id of idents) {
        if (out[id]) continue;
        out[id] = STACK_PARAM_DEFAULTS[id] || { expr: '1', unit: 'µm', desc: `Layer ${f} (${layer.name || id})` };
      }
    }
  }
  return out;
}

// Migrate a stack to the explicit coplanar-group model. Stacks that
// already declare any `coplanarGroup` on at least one layer are
// passed through unchanged. Stacks with no explicit groupings are
// scanned for adjacent waveguide / conductor / cladding role layers
// (the pre-migration "device level" pattern); each contiguous run is
// stamped with a shared coplanarGroup id. Single-member runs are
// degenerate and left as solo layers.
//
// Called from normalizeScene on load and from switchStack when a
// library stack is brought in, so legacy entries — including the
// originally-auto-seeded LTOI600_NbN_EPFL — get coplanar grouping
// back at the moment they enter the scene.
export function migrateStackCoplanarGroups(stack) {
  const arr = stack || [];
  const isLegacyDeviceRole = (r) => r === 'waveguide' || r === 'conductor' || r === 'cladding';
  const anyExplicitGroup = arr.some((l) => l.coplanarGroup);
  if (anyExplicitGroup) return arr;
  let nonce = 0;
  let curGroupId = null;
  let next = arr.map((layer) => {
    if (!isLegacyDeviceRole(layer.role)) {
      curGroupId = null;
      return layer;
    }
    if (!curGroupId) curGroupId = `device_${nonce++}`;
    return { ...layer, coplanarGroup: curGroupId };
  });
  // Drop degenerate single-member groups so those layers stay sequential.
  const counts = {};
  for (const l of next) if (l.coplanarGroup) counts[l.coplanarGroup] = (counts[l.coplanarGroup] || 0) + 1;
  next = next.map((l) => (l.coplanarGroup && counts[l.coplanarGroup] < 2) ? { ...l, coplanarGroup: undefined } : l);
  return next;
}

export function defaultStack() {
  // Bottom-up order. Z=0 is the top of the buried oxide (where the WG sits).
  // Substrates have negative Z, the WG layer is at Z=0..h_wg, conductor sits above.
  // Cladding fills the WG layer's XY footprint at Z=0..h_wg around any waveguides/electrodes.
  // Waveguide-role layers carry rib cross-section fields (core_width, slab_height, slab_width, etch_angle).
  // The default-stack device level (waveguide + cladding + conductor)
  // declares an explicit coplanarGroup id so it survives — and reads
  // identically against — the new opt-in coplanar model. Layers
  // without a coplanarGroup are sequential (each on top of the prev).
  return [
    { id: 'l_si',    name: 'Silicon handle',  thickness: 'h_si',    material: 'silicon',           color: '#5a6878', role: 'substrate' },
    { id: 'l_sio2',  name: 'Buried oxide',    thickness: 'h_sio2',  material: 'silicon_dioxide',   color: '#8da0c0', role: 'substrate' },
    { id: 'l_lt',    name: 'Lithium tantalate WG', thickness: 'h_wg', material: 'lithium_tantalate', color: '#86efac', role: 'waveguide', coplanarGroup: 'device_0',
      core_width: 'w_wg', core_width_ref: 'top', slab_height: 'h_slab', slab_width: 'w_slab', etch_angle: 'etch_angle' },
    { id: 'l_clad',  name: 'Cladding (SiO2)', thickness: 'h_wg',    material: 'silicon_dioxide',   color: '#cbd5e1', role: 'cladding', coplanarGroup: 'device_0' },
    { id: 'l_cond',  name: 'Conductor',       thickness: 'h_cond',  material: 'gold',              color: '#daa520', role: 'conductor', coplanarGroup: 'device_0' },
  ];
}

export function normalizeScene(s) {
  if (!s || typeof s !== 'object') return makeDefaultScene();
  const params = { ...(s.params || {}) };
  let stack = s.stack || defaultStack();
  // If the stack is missing a conductor layer, inject one (older scenes pre-date conductor support)
  if (!stack.some(l => l.role === 'conductor')) {
    stack = [
      ...stack,
      { id: 'l_cond', name: 'Conductor', thickness: 'h_cond', material: 'gold', color: '#daa520', role: 'conductor' },
    ];
  }
  // Add WG cross-section fields to any waveguide-role layer that lacks them.
  stack = stack.map(layer => {
    if (layer.role !== 'waveguide') return layer;
    return {
      core_width: 'w_wg',
      core_width_ref: 'top',
      slab_height: 'h_slab',
      slab_width: 'w_slab',
      etch_angle: 'etch_angle',
      ...layer,
    };
  });
  // Migrate legacy stacks to the explicit coplanar-group model.
  stack = migrateStackCoplanarGroups(stack);
  // Ensure every parameter referenced in stack fields exists with a
  // sensible default. Existing params win; only missing names get
  // populated from paramsForStack.
  const stackDefaults = paramsForStack(stack);
  for (const [name, p] of Object.entries(stackDefaults)) {
    if (!params[name]) params[name] = p;
  }
  // Migrate legacy `scene.booleans` (a side list) into the new model where
  // booleans are full components with kind='boolean' and operands tagged
  // with consumedBy. Old scenes saved before this refactor will be brought
  // forward automatically; new scenes never write to scene.booleans.
  let migratedComponents = (s.components || []).map(c => ({
    transforms: c.transforms || [],
    ...c,
    // Optional expression fields added later in the schema's life:
    //   rotation     — first-class rotation (degrees, CCW) on rect /
    //                  circle / ellipse / polygon. Absent or '0' = none.
    //   zOffset      — Z shift (µm) relative to the component's layer.
    //   cornerRadius — rect corner fillet radius (µm, D3). Absent or
    //                  '0' = sharp corners.
    //   cxExpr/cyExpr — parametric position (µm, C8) applied by the
    //                  solver on UNSNAPPED roots; snap-bound components
    //                  ignore them.
    // All are expression STRINGS; coerce stray numerics from hand-
    // edited JSON so every downstream consumer can assume strings.
    ...(c.rotation != null && typeof c.rotation !== 'string' ? { rotation: String(c.rotation) } : {}),
    ...(c.zOffset != null && typeof c.zOffset !== 'string' ? { zOffset: String(c.zOffset) } : {}),
    ...(c.cornerRadius != null && typeof c.cornerRadius !== 'string' ? { cornerRadius: String(c.cornerRadius) } : {}),
    ...(c.cxExpr != null && typeof c.cxExpr !== 'string' ? { cxExpr: String(c.cxExpr) } : {}),
    ...(c.cyExpr != null && typeof c.cyExpr !== 'string' ? { cyExpr: String(c.cyExpr) } : {}),
  }));
  // Rotate-transform custom pivots (C9): pivot === 'custom' carries an
  // explicit world-coordinate pivot as px / py expression strings (µm).
  // Default missing fields to '0' and coerce stray numerics so the
  // expanders / exporters / rename walker can assume strings.
  migratedComponents = migratedComponents.map(c => {
    if (!Array.isArray(c.transforms) || c.transforms.length === 0) return c;
    let changed = false;
    const transforms = c.transforms.map(t => {
      if (!t || t.kind !== 'rotate') return t;
      const next = { ...t };
      let tChanged = false;
      for (const f of ['px', 'py']) {
        if (next[f] != null && typeof next[f] !== 'string') { next[f] = String(next[f]); tChanged = true; }
        if (next.pivot === 'custom' && next[f] == null) { next[f] = '0'; tChanged = true; }
      }
      if (tChanged) changed = true;
      return tChanged ? next : t;
    });
    return changed ? { ...c, transforms } : c;
  });
  // Via components (D4): plan-view circles spanning two stack layers in
  // Z. Normalize defaults so downstream consumers can assume:
  //   r          — expression string (default '2')
  //   layer      — 'via' (drives canvas styling + exporter dispatch)
  //   layerFrom / layerTo — stack-layer ids; default waveguide-or-first-
  //                conductor → top conductor when missing/stale.
  //   w / h      — '2*(<r>)' derived AABB so snaps / anchors / solver
  //                see a consistent bbox (the circle convention).
  {
    const nonSubstrate = stack.filter(l => l.role !== 'substrate');
    const condsInStack = stack.filter(l => l.role === 'conductor');
    const defaultFrom = stack.find(l => l.role === 'waveguide') || condsInStack[0] || nonSubstrate[0] || null;
    const defaultTo = [...condsInStack].reverse().find(l => !defaultFrom || l.id !== defaultFrom.id)
      || [...nonSubstrate].reverse().find(l => !defaultFrom || l.id !== defaultFrom.id)
      || null;
    migratedComponents = migratedComponents.map(c => {
      if (c.kind !== 'via') return c;
      const next = { ...c };
      let changed = false;
      if (next.r == null) { next.r = '2'; changed = true; }
      else if (typeof next.r !== 'string') { next.r = String(next.r); changed = true; }
      if (next.layer !== 'via') { next.layer = 'via'; changed = true; }
      const layerIds = new Set(stack.map(l => l.id));
      if (!next.layerFrom || !layerIds.has(next.layerFrom)) {
        next.layerFrom = defaultFrom ? defaultFrom.id : (stack[0]?.id ?? '');
        changed = true;
      }
      if (!next.layerTo || !layerIds.has(next.layerTo) || next.layerTo === next.layerFrom) {
        const fallbackTo = defaultTo && defaultTo.id !== next.layerFrom
          ? defaultTo.id
          : (stack.map(l => l.id).reverse().find(id => id !== next.layerFrom) ?? '');
        if (next.layerTo !== fallbackTo) { next.layerTo = fallbackTo; changed = true; }
      }
      const derived = `2*(${next.r})`;
      if (typeof next.w !== 'string' || next.w.trim() === '' || next.w.trim() === '0') { next.w = derived; changed = true; }
      if (typeof next.h !== 'string' || next.h.trim() === '' || next.h.trim() === '0') { next.h = derived; changed = true; }
      if (!Array.isArray(next.cutouts)) { next.cutouts = []; changed = true; }
      // Strip fields that don't apply to a cylinder plug. A via's Z span
      // is fully determined by layerFrom/layerTo (zOffset would break the
      // span semantics), rotation is a geometric no-op on a circle, and
      // cornerRadius is rect-only. The Inspector never offers these on
      // vias; this guards hand-edited JSON and stale saves.
      for (const f of ['zOffset', 'rotation', 'cornerRadius']) {
        if (next[f] != null) { delete next[f]; changed = true; }
      }
      return changed ? next : c;
    });
  }
  // Bridge components (D7 — RF airbridge): a conductor strap that leaves
  // the conductor plane, arcs UP by `height` above the conductor top and
  // lands back down. Plan-view footprint = length × width rect. Normalize
  // defaults so downstream consumers can assume:
  //   length / width / height — expression strings ('30' / '10' / '3')
  //   padLength  — expression string ('0' = none): flat LANDING PADS at
  //                each end of the span — strap metal extending padLength
  //                beyond each landing, sitting on the conductor top.
  //                Pads are EXTRA geometry beyond the AABB (w/h stay
  //                length × width so existing snaps don't shift); the
  //                canvas glyph, 3-D viewer, HFSS/pyAEDT profiles, and
  //                the GDS layer-150 footprint all include them.
  //   thickness  — expression string; '' means "use the conductor layer's
  //                thickness" (resolved at export time)
  //   layer      — 'bridge' (drives canvas styling + exporter dispatch)
  //   conductorLayerId — OPTIONAL binding to a stack conductor id; a
  //                stale binding falls back to the first conductor.
  //   w / h      — derived AABB '(length)' × '(width)' so snaps / anchors
  //                / solver see a consistent bbox (the via convention).
  //   rotation   — KEPT (orientation matters, unlike vias); zOffset /
  //                cornerRadius are stripped (the Z placement is bound to
  //                the conductor top, and fillets are rect-only).
  {
    const condsInStack = stack.filter(l => l.role === 'conductor');
    migratedComponents = migratedComponents.map(c => {
      if (c.kind !== 'bridge') return c;
      const next = { ...c };
      let changed = false;
      const coerce = (f, dflt) => {
        if (next[f] == null) { next[f] = dflt; changed = true; }
        else if (typeof next[f] !== 'string') { next[f] = String(next[f]); changed = true; }
      };
      coerce('length', '30');
      coerce('width', '10');
      coerce('height', '3');
      coerce('padLength', '0'); // '0' = no landing pads
      coerce('thickness', ''); // '' = use the conductor layer's thickness
      if (next.layer !== 'bridge') { next.layer = 'bridge'; changed = true; }
      if (next.conductorLayerId && !condsInStack.some(l => l.id === next.conductorLayerId)) {
        // Stale binding — fall back to the first conductor (or drop it).
        if (condsInStack[0]) next.conductorLayerId = condsInStack[0].id;
        else delete next.conductorLayerId;
        changed = true;
      }
      const derivedW = `(${next.length})`;
      const derivedH = `(${next.width})`;
      if (typeof next.w !== 'string' || next.w.trim() === '' || next.w.trim() === '0') { next.w = derivedW; changed = true; }
      if (typeof next.h !== 'string' || next.h.trim() === '' || next.h.trim() === '0') { next.h = derivedH; changed = true; }
      if (!Array.isArray(next.cutouts)) { next.cutouts = []; changed = true; }
      // KEEP rotation (a bridge's orientation matters — it's coerced to a
      // string by the general migration above). Strip zOffset (the strap's
      // Z is bound to the conductor top) and cornerRadius (rect-only).
      for (const f of ['zOffset', 'cornerRadius']) {
        if (next[f] != null) { delete next[f]; changed = true; }
      }
      return changed ? next : c;
    });
  }
  // Polyline / polyshape vertex expression fields: coerce stray numerics
  // (hand-edited JSON, older saves) to strings so every downstream
  // consumer — solver, exporters, rename walker — can assume expression
  // STRINGS. Covers rel (dx/dy), arc (cdx/cdy/angle), and the optional
  // per-vertex taper width. `spline` is normalized to a real boolean.
  migratedComponents = migratedComponents.map(c => {
    if (c.kind !== 'polyline' && c.kind !== 'polyshape') return c;
    let changed = false;
    const vertices = (c.vertices || []).map(v => {
      if (!v || typeof v !== 'object') return v;
      const next = { ...v };
      let vChanged = false;
      for (const f of ['dx', 'dy', 'cdx', 'cdy', 'angle', 'width']) {
        if (next[f] != null && typeof next[f] !== 'string') { next[f] = String(next[f]); vChanged = true; }
      }
      if ('spline' in next && typeof next.spline !== 'boolean') { next.spline = !!next.spline; vChanged = true; }
      // Arc vertices must always carry all three fields so editors and
      // exporters can read them without null guards.
      if (next.kind === 'arc') {
        if (next.cdx == null) { next.cdx = '0'; vChanged = true; }
        if (next.cdy == null) { next.cdy = '0'; vChanged = true; }
        if (next.angle == null) { next.angle = '90'; vChanged = true; }
      }
      if (vChanged) changed = true;
      return vChanged ? next : v;
    });
    return changed ? { ...c, vertices } : c;
  });
  // Duplicate component ids: keep the first occurrence, rename each
  // subsequent one to <id>_dup1/_dup2/…. References (snaps, operandIds,
  // consumedBy, snap vertices) are NOT rewritten — they're ambiguous
  // (they could mean either duplicate) — so we just warn. Duplicates
  // would otherwise collapse in the solver's byId map and corrupt the
  // synthetic _comp_<id>_* params.
  {
    const seen = new Set();
    const renamed = [];
    migratedComponents = migratedComponents.map(c => {
      if (!seen.has(c.id)) { seen.add(c.id); return c; }
      let n = 1;
      let newId = `${c.id}_dup${n}`;
      while (seen.has(newId)) newId = `${c.id}_dup${++n}`;
      seen.add(newId);
      renamed.push(`${c.id} → ${newId}`);
      return { ...c, id: newId };
    });
    if (renamed.length > 0) {
      console.warn(`normalizeScene: duplicate component ids renamed: ${renamed.join(', ')} (references left pointing at the first occurrence)`);
    }
  }
  const legacyBooleans = s.booleans || [];
  if (legacyBooleans.length > 0) {
    const consumedSet = new Set();
    const newDerived = [];
    for (const b of legacyBooleans) {
      // Skip disabled legacy booleans (kept as a hint but not made active).
      if (b.enabled === false) continue;
      const ids = (b.operandIds || []).filter(id => migratedComponents.some(c => c.id === id));
      if (ids.length < 2) continue;
      // Centroid of operand bbox (approximate — we don't have a solver result here)
      let cxSum = 0, cySum = 0, count = 0;
      for (const id of ids) {
        const c = migratedComponents.find(cc => cc.id === id);
        if (c && Number.isFinite(c.cx) && Number.isFinite(c.cy)) {
          cxSum += c.cx; cySum += c.cy; count++;
        }
      }
      const cx = count > 0 ? cxSum / count : 0;
      const cy = count > 0 ? cySum / count : 0;
      const baseOp = migratedComponents.find(c => c.id === ids[0]);
      const layer = baseOp?.layer || 'waveguide';
      newDerived.push({
        // DETERMINISTIC fallback id (operand[0]-keyed, not random):
        // normalizeScene must be a pure function of its input — a random id
        // made every normalize of the same legacy scene produce a DIFFERENT
        // result, so a loaded snapshot never deep-equaled its frozen source
        // and the version-restore flow flagged phantom "unsnapshotted edits".
        id: b.id || `migrated_${b.op}_${ids[0] || 'x'}`,
        kind: 'boolean',
        op: b.op,
        operandIds: ids,
        layer,
        cx, cy,
        w: '0', h: '0',
        cutouts: [],
        transforms: [],
        label: b.label || '',
        ...(baseOp?.conductorLayerId ? { conductorLayerId: baseOp.conductorLayerId } : {}),
      });
      for (const id of ids) consumedSet.add(id);
    }
    migratedComponents = migratedComponents.map(c => consumedSet.has(c.id) ? { ...c, consumedBy: newDerived.find(d => (d.operandIds || []).includes(c.id))?.id } : c);
    migratedComponents = [...migratedComponents, ...newDerived];
  }

  // Migrate punch clones: in early versions of the 'punch' op the clone
  // inherited the TOOL's layer, which caused the HFSS exporter to emit a
  // sheet when the base was a box (subtract then failed on
  // dimensionality). The clone's layer must match the BASE's layer so
  // the subtract works. Detect any clone (cloneOf set) whose layer
  // differs from its boolean-base and fix it.
  {
    const byId = Object.fromEntries(migratedComponents.map(c => [c.id, c]));
    migratedComponents = migratedComponents.map(c => {
      if (!c.cloneOf || !c.consumedBy) return c;
      const parent = byId[c.consumedBy];
      if (!parent || parent.kind !== 'boolean') return c;
      const baseId = (parent.operandIds || [])[0];
      const base = baseId ? byId[baseId] : null;
      if (!base) return c;
      if (c.layer === base.layer && c.conductorLayerId === base.conductorLayerId) return c;
      return {
        ...c,
        layer: base.layer,
        conductorLayerId: base.conductorLayerId,
      };
    });
  }

  // Migrate punch-clone position tracking. Pre-fix punches gave each
  // clone a NUMERIC cx/cy snapshot of the tool's position at creation
  // time, so any later parameter change that moved the tool stranded
  // the hole at the old coordinates. Add a tool.C → clone.C snap
  // wherever it's missing so the solver keeps the clone glued to its
  // tool from then on. We also rewrite the clone's stored cx/cy to
  // the tool's current values so the first solve round trivially
  // converges; subsequent solves derive clone.cx/cy from the tool via
  // the snap.
  let migratedSnaps = s.snaps || [];
  {
    const existingClonePins = new Set(
      migratedSnaps
        .filter(sp => sp && sp.from && sp.to && sp.from.anchor === 'C' && sp.to.anchor === 'C')
        .map(sp => sp.to.compId),
    );
    const compById2 = Object.fromEntries(migratedComponents.map(c => [c.id, c]));
    const addedPinSnaps = [];
    const pinnedCloneIds = new Set();
    for (const c of migratedComponents) {
      if (!c.cloneOf) continue;
      if (existingClonePins.has(c.id)) continue;
      if (!compById2[c.cloneOf]) continue;
      addedPinSnaps.push({
        // DETERMINISTIC id (clone-keyed, no Date.now()): one pin per clone,
        // so the clone id alone is unique. The old timestamped id made
        // normalizeScene non-idempotent for pre-migration scenes — loading
        // an OLD snapshot added a pin snap whose id differed on every
        // normalize, so the live scene never deep-equaled the frozen
        // snapshot and version hopping nagged with phantom "unsnapshotted
        // edits" (+ a pointless rescue snapshot) on every click.
        id: `snap_clonepin_${c.id}`,
        from: { compId: c.cloneOf, anchor: 'C' },
        to: { compId: c.id, anchor: 'C' },
        dx: '0', dy: '0',
      });
      pinnedCloneIds.add(c.id);
    }
    if (addedPinSnaps.length > 0) {
      migratedSnaps = [...migratedSnaps, ...addedPinSnaps];
      // Reset the stored cx/cy of newly-pinned clones to their tool's
      // current cx/cy. The solver overrides them anyway, but starting
      // closer to truth avoids one wasted iteration and a visible jump.
      migratedComponents = migratedComponents.map(c => {
        if (!pinnedCloneIds.has(c.id)) return c;
        const tool = compById2[c.cloneOf];
        if (!tool) return c;
        return {
          ...c,
          cx: Number.isFinite(tool.cx) ? tool.cx : c.cx,
          cy: Number.isFinite(tool.cy) ? tool.cy : c.cy,
        };
      });
    }
  }

  // Dangling-reference repair. Runs AFTER all component migrations so it
  // sees the final id set.
  {
    const idSet = new Set(migratedComponents.map(c => c.id));
    // Boolean operandIds pointing at nonexistent components → drop them.
    // A missing operand would make refreshBooleanBbox silently skip it,
    // and the SHAPES feature tree would render a ghost child.
    migratedComponents = migratedComponents.map(c => {
      if (c.kind !== 'boolean') return c;
      const ops = c.operandIds || [];
      const kept = ops.filter(id => idSet.has(id));
      if (kept.length === ops.length) return c;
      console.warn(`normalizeScene: boolean ${c.id} referenced missing operand(s): ${ops.filter(id => !idSet.has(id)).join(', ')} — dropped`);
      return { ...c, operandIds: kept };
    });
    // Polyline/polyshape snap vertices pinned to a nonexistent component
    // → convert to a zero-length rel step so the vertex resolves to the
    // previous vertex's position instead of NaN.
    migratedComponents = migratedComponents.map(c => {
      if (c.kind !== 'polyline' && c.kind !== 'polyshape') return c;
      let changed = false;
      const vertices = (c.vertices || []).map(v => {
        if (v && v.kind === 'snap' && v.compId && !idSet.has(v.compId)) {
          console.warn(`normalizeScene: ${c.kind} ${c.id} vertex snapped to missing component ${v.compId} — converted to rel (0, 0)`);
          changed = true;
          return { kind: 'rel', dx: '0', dy: '0' };
        }
        return v;
      });
      return changed ? { ...c, vertices } : c;
    });
  }

  // Simulation setup: HFSS-side knobs that aren't part of the layout
  // geometry but need to ride along with the design (so an export from
  // any machine produces a consistent script). Currently:
  //   - fnominal: the nominal frequency (GHz) used to size the
  //     automatic open-region radiation box. HFSS pads each face by
  //     ~λ/4 at this frequency. Stored as a string so it can be a
  //     parametric expression in the future.
  //   - padXNeg / padXPos / padYNeg / padYPos: per-face padding (µm)
  //     between the device-area bounding box and the chip-substrate
  //     edges. The substrate (and any cladding sized to it) extends
  //     from (deviceMinX − padXNeg, deviceMinY − padYNeg) to
  //     (deviceMaxX + padXPos, deviceMaxY + padYPos). Symmetric pads
  //     keep the design centered on the chip; asymmetric pads shift
  //     it. Strings so they can be parametric later. Default 50 µm.
  //   - solveFreq: adaptive-solve frequency (GHz). Empty string →
  //     fall back to fnominal at export time.
  //   - maxPasses / maxDeltaS: adaptive-pass convergence knobs for
  //     the generated Setup1.
  //   - sweepEnabled / sweepStart / sweepStop / sweepPoints /
  //     sweepType: frequency-sweep block emitted under Setup1 in the
  //     HFSS export. All values stored as strings except
  //     sweepEnabled (boolean). The spread below lets saved values
  //     win — including an explicit sweepEnabled:false.
  const simSetup = {
    fnominal: '4',
    solveFreq: '',
    maxPasses: '12',
    maxDeltaS: '0.02',
    sweepEnabled: true,
    sweepStart: '0.1',
    sweepStop: '50',
    sweepPoints: '500',
    sweepType: 'Interpolating',
    padXNeg: '50',
    padXPos: '50',
    padYNeg: '50',
    padYPos: '50',
    // Air-box padding (µm) added on every face of the chip bbox to
    // form the radiation region. Empty string → auto = λ/4 at
    // fnominal; explicit number → that override in µm. Stored as a
    // string so the user can paste expressions later if desired.
    airPad: '',
    ...(s.simSetup || {}),
  };
  // HFSS/Q2D export target ('new' | 'project' | 'design') — the DEFAULT is
  // 'project' (append the generated design to the ACTIVE AEDT project).
  // Migration order matters: an explicit saved appendMode wins; else the
  // LEGACY boolean appendToActive:true maps to 'design' (must be checked
  // BEFORE defaulting, or an unconditional 'project' seed would shadow it);
  // else 'project'. Deterministic — safe for the scenesEqual contract.
  if (simSetup.appendMode !== 'new' && simSetup.appendMode !== 'project' && simSetup.appendMode !== 'design') {
    simSetup.appendMode = simSetup.appendToActive ? 'design' : 'project';
  }

  // exportExclude CLUSTER SYNC: every consumed operand mirrors its
  // TOP-LEVEL consuming boolean's flag (set AND clear, nested booleans
  // included, cycle-guarded). Excluding a boolean therefore removes its
  // operand parts from every export, and a stray flag on an operand
  // self-heals to the root's state — a half-excluded cluster would
  // silently corrupt the exported boolean.
  {
    const byIdX = new Map(migratedComponents.map(c => [c.id, c]));
    const rootFlag = (c) => {
      let cur = c;
      const seen = new Set();
      while (cur && cur.consumedBy && !seen.has(cur.id)) {
        seen.add(cur.id);
        const parent = byIdX.get(cur.consumedBy);
        if (!parent) break;
        cur = parent;
      }
      return !!(cur && cur.exportExclude);
    };
    migratedComponents = migratedComponents.map(c => {
      if (!c.consumedBy) return c;
      const want = rootFlag(c);
      if (!!c.exportExclude === want) return c;
      const next = { ...c };
      if (want) next.exportExclude = true; else delete next.exportExclude;
      return next;
    });
  }
  return {
    params,
    components: migratedComponents,
    snaps: migratedSnaps,
    mirrors: s.mirrors || [],
    groups: s.groups || [],
    // booleans field kept empty for legacy compatibility — the source of
    // truth is now scene.components entries with kind='boolean'.
    booleans: [],
    stack,
    // The current stack's display name — purely a label so the user
    // can recognize which stack a design is wearing. Loading a stack
    // from the library overwrites both this field and `stack`.
    stackName: s.stackName || 'LTOI600_NbN_EPFL',
    simSetup,
    // Parametric cell definitions embedded in the design (name → def,
    // see src/scene/cells.js) so a design that uses cells stays
    // self-contained when exported / shared. Pure passthrough.
    cells: (s.cells && typeof s.cells === 'object' && !Array.isArray(s.cells)) ? s.cells : {},
  };
}

// Canonical scene equality: compare through normalizeScene on BOTH sides so
// schema migrations (defaults/snaps injected since one side was frozen —
// e.g. the punch-clone pin snap on an old snapshot) and top-level key-order
// differences never read as "edits". normalizeScene must stay DETERMINISTIC
// and IDEMPOTENT for this to hold (no Date.now()/Math.random() ids in any
// migration path) — a scene loaded FROM a snapshot via
// setScene(normalizeScene(v.scene)) then compares equal to that snapshot
// until a real edit lands. Used by the version-restore flow to decide
// whether discarding "current" would actually lose information.
export function scenesEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  try {
    return JSON.stringify(normalizeScene(a)) === JSON.stringify(normalizeScene(b));
  } catch {
    return false; // un-normalizable ⇒ treat as different (conservative: keeps the prompt)
  }
}

// First-run demo scene. Returns a DEEP CLONE of the frozen JSON asset
// (default-scene.json) so subsequent edits in the app don't mutate the
// shared import. The asset is a workspace-exported "Untitled" design —
// to refresh it, edit a new starting design in the app, export the
// workspace JSON, copy `designs.Untitled.scene` into default-scene.json.
export function makeDefaultScene() {
  // structuredClone keeps the snapshot decoupled from the import.
  return typeof structuredClone === 'function'
    ? structuredClone(defaultSceneJson)
    : JSON.parse(JSON.stringify(defaultSceneJson));
}

// Empty starting scene: same default layer stack so add-tools work right
// away (you need a conductor layer to drag electrodes). Pre-populates
// `params` with nominal values for every identifier the stack
// references (h_wg, h_si, w_wg, etc.) — without these the PARAMS panel
// would come up empty and the stack's thicknesses would all resolve to
// NaN until the user manually added them. Used by the "new blank"
// command for starting a fresh design from scratch.
export function makeBlankScene() {
  const stack = defaultStack();
  return {
    params: paramsForStack(stack),
    components: [],
    snaps: [],
    mirrors: [],
    groups: [],
    booleans: [],
    stack,
    stackName: 'LTOI600_NbN_EPFL',
  };
}
