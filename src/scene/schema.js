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
    //   rotation — first-class rotation (degrees, CCW) on rect / circle /
    //              ellipse / polygon. Absent or '0' = none.
    //   zOffset  — Z shift (µm) relative to the component's layer.
    // Both are expression STRINGS; coerce stray numerics from hand-
    // edited JSON so every downstream consumer can assume strings.
    ...(c.rotation != null && typeof c.rotation !== 'string' ? { rotation: String(c.rotation) } : {}),
    ...(c.zOffset != null && typeof c.zOffset !== 'string' ? { zOffset: String(c.zOffset) } : {}),
  }));
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
        id: b.id || `migrated_${b.op}_${Math.random().toString(36).slice(2, 6)}`,
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
        id: `snap_${Date.now()}_clonepin_${c.id}`,
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
  };
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
