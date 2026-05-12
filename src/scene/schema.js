// Scene schema and factories.
//
// `defaultStack` returns the bottom-up list of process-stack layers
// (substrate / waveguide / conductor / cladding) for a brand-new design.
// `normalizeScene` reads a possibly-old scene-blob from storage and
// upgrades it to the current shape (legacy fields, missing keys, etc).
// `makeDefaultScene` and `makeBlankScene` produce the two canned
// starting points used by the New / Open flows.
//
// Pure JS — no external deps. Extracted from PhotonicLayout.jsx as
// Stage 3.1 of the planned refactor.

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
  // Migrate legacy stacks to the explicit coplanar-group model. Older
  // stacks auto-grouped adjacent waveguide / conductor / cladding
  // role layers into one "device level" via role inspection in the
  // LayersPanel. The new model makes coplanar grouping explicit via a
  // `coplanarGroup` string id on each layer — sequential by default,
  // coplanar only when the user opts in. To preserve existing scenes'
  // visual + export behavior, here we detect runs of contiguous
  // role∈{waveguide,conductor,cladding} layers in stacks that have
  // NO coplanarGroup assignments anywhere, and assign them a shared
  // id. Stacks that already declare coplanar groups (newly-created
  // ones) are passed through untouched.
  const isLegacyDeviceRole = (r) => r === 'waveguide' || r === 'conductor' || r === 'cladding';
  const anyExplicitGroup = stack.some((l) => l.coplanarGroup);
  if (!anyExplicitGroup) {
    let groupNonce = 0;
    let curGroupId = null;
    stack = stack.map((layer) => {
      if (!isLegacyDeviceRole(layer.role)) {
        curGroupId = null;
        return layer;
      }
      if (!curGroupId) curGroupId = `device_${groupNonce++}`;
      return { ...layer, coplanarGroup: curGroupId };
    });
    // Single-member "groups" of one are degenerate — drop the id so
    // those layers stay sequential.
    const counts = {};
    for (const l of stack) if (l.coplanarGroup) counts[l.coplanarGroup] = (counts[l.coplanarGroup] || 0) + 1;
    stack = stack.map((l) => (l.coplanarGroup && counts[l.coplanarGroup] < 2) ? { ...l, coplanarGroup: undefined } : l);
  }
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
  }));
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

  return {
    params,
    components: migratedComponents,
    snaps: s.snaps || [],
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
  };
}

export function makeDefaultScene() {
  const params = {
    w_wg: { expr: '1.2', unit: 'µm', desc: 'WG core width (rib bottom)' },
    h_wg: { expr: '0.6', unit: 'µm', desc: 'WG total height (LiTaO3 layer)' },
    h_slab: { expr: '0.1', unit: 'µm', desc: 'Slab height (unetched LiTaO3 below rib)' },
    w_slab: { expr: '5', unit: 'µm', desc: 'Slab width (around rib)' },
    etch_angle: { expr: '70', unit: 'deg', desc: 'Etch sidewall angle from horizontal (90 = vertical)' },
    h_si: { expr: '250', unit: 'µm', desc: 'Silicon handle thickness' },
    h_sio2: { expr: '4.7', unit: 'µm', desc: 'Buried oxide thickness' },
    h_clad: { expr: '2', unit: 'µm', desc: 'Cladding (legacy slab) thickness' },
    h_cond: { expr: '0.8', unit: 'µm', desc: 'Conductor (electrode) thickness' },
    sidewall_angle: { expr: '75', unit: 'deg', desc: 'Sidewall angle (legacy, see etch_angle)' },
    n_core: { expr: '2.13', unit: '', desc: 'Core index (LiTaO3, ne ~2.13 @ 1550)' },
    n_clad: { expr: '1.45', unit: '', desc: 'Cladding index (SiO2)' },
    electrode_h: { expr: '0.5', unit: 'µm', desc: 'Electrode thickness' },
    electrode_gap: { expr: '4.0', unit: 'µm', desc: 'Electrode-to-WG gap' },
    ring_R: { expr: '80', unit: 'µm', desc: 'Ring outer half-extent' },
    ring_W: { expr: 'w_wg', unit: 'µm', desc: 'Ring waveguide width (= w_wg)' },
    bus_W: { expr: 'w_wg', unit: 'µm', desc: 'Bus waveguide width (= w_wg)' },
    bus_L: { expr: '2*ring_R + 80', unit: 'µm', desc: 'Bus waveguide length' },
    coupling_gap: { expr: '0.4', unit: 'µm', desc: 'Bus-ring coupling gap' },
    sig_W: { expr: '8', unit: 'µm', desc: 'Signal electrode width' },
    sig_L: { expr: '2*ring_R - 4*ring_W', unit: 'µm', desc: 'Signal electrode length (inside ring)' },
    gnd_W: { expr: '30', unit: 'µm', desc: 'Ground plane width' },
    gnd_L: { expr: '2*ring_R + 40', unit: 'µm', desc: 'Ground plane length' },
    // Snap-axis parameters (one per snap axis, even if 0 for galvanic contact)
    gap_x1: { expr: '0', unit: 'µm', desc: 'bus.S → ring_top.N (dx)' },
    gap_y1: { expr: '-coupling_gap', unit: 'µm', desc: 'bus.S → ring_top.N (dy)' },
    gap_x2: { expr: '0', unit: 'µm', desc: 'ring_top.S → ring_bot.N (dx)' },
    gap_y2: { expr: '-(2*ring_R - 2*ring_W)', unit: 'µm', desc: 'ring_top.S → ring_bot.N (dy)' },
    gap_x3: { expr: '0', unit: 'µm', desc: 'ring_top.SW → ring_left.NW (dx)' },
    gap_y3: { expr: '0', unit: 'µm', desc: 'ring_top.SW → ring_left.NW (dy)' },
    gap_x4: { expr: '0', unit: 'µm', desc: 'ring_top.SE → ring_right.NE (dx)' },
    gap_y4: { expr: '0', unit: 'µm', desc: 'ring_top.SE → ring_right.NE (dy)' },
    gap_x5: { expr: 'ring_W', unit: 'µm', desc: 'ring_left.NE → sig.NW (dx)' },
    gap_y5: { expr: '-(ring_R - ring_W - sig_W/2)', unit: 'µm', desc: 'ring_left.NE → sig.NW (dy)' },
    gap_x6: { expr: '0', unit: 'µm', desc: 'bus.N → gnd_top.S (dx)' },
    gap_y6: { expr: 'electrode_gap', unit: 'µm', desc: 'bus.N → gnd_top.S (dy)' },
    gap_x7: { expr: '0', unit: 'µm', desc: 'ring_bot.S → gnd_bot.N (dx)' },
    gap_y7: { expr: '-electrode_gap', unit: 'µm', desc: 'ring_bot.S → gnd_bot.N (dy)' },
  };

  const components = [
    { id: 'bus', kind: 'rect', layer: 'waveguide', cx: 0, cy: 0, w: 'bus_L', h: 'bus_W', cutouts: [], label: 'Bus WG' },
    { id: 'ring_top', kind: 'rect', layer: 'waveguide', cx: 0, cy: 0, w: '2*ring_R', h: 'ring_W', cutouts: [], label: 'Ring top' },
    { id: 'ring_bot', kind: 'rect', layer: 'waveguide', cx: 0, cy: 0, w: '2*ring_R', h: 'ring_W', cutouts: [], label: 'Ring bottom' },
    { id: 'ring_left', kind: 'rect', layer: 'waveguide', cx: 0, cy: 0, w: 'ring_W', h: '2*ring_R - 2*ring_W', cutouts: [], label: 'Ring left' },
    { id: 'ring_right', kind: 'rect', layer: 'waveguide', cx: 0, cy: 0, w: 'ring_W', h: '2*ring_R - 2*ring_W', cutouts: [], label: 'Ring right' },
    { id: 'sig', kind: 'rect', layer: 'electrode', cx: 0, cy: 0, w: 'sig_L', h: 'sig_W', cutouts: [], label: 'Signal electrode' },
    { id: 'gnd_top', kind: 'rect', layer: 'electrode', cx: 0, cy: 0, w: 'gnd_L', h: 'gnd_W', cutouts: [], label: 'Top ground plane' },
    { id: 'gnd_bot', kind: 'rect', layer: 'electrode', cx: 0, cy: 0, w: 'gnd_L', h: 'gnd_W', cutouts: [], label: 'Bottom ground plane' },
  ];

  const snaps = [
    { id: 's1', from: { compId: 'bus', anchor: 'S' }, to: { compId: 'ring_top', anchor: 'N' }, dx: 'gap_x1', dy: 'gap_y1' },
    { id: 's2', from: { compId: 'ring_top', anchor: 'S' }, to: { compId: 'ring_bot', anchor: 'N' }, dx: 'gap_x2', dy: 'gap_y2' },
    { id: 's3', from: { compId: 'ring_top', anchor: 'SW' }, to: { compId: 'ring_left', anchor: 'NW' }, dx: 'gap_x3', dy: 'gap_y3' },
    { id: 's4', from: { compId: 'ring_top', anchor: 'SE' }, to: { compId: 'ring_right', anchor: 'NE' }, dx: 'gap_x4', dy: 'gap_y4' },
    { id: 's5', from: { compId: 'ring_left', anchor: 'NE' }, to: { compId: 'sig', anchor: 'NW' }, dx: 'gap_x5', dy: 'gap_y5' },
    { id: 's6', from: { compId: 'bus', anchor: 'N' }, to: { compId: 'gnd_top', anchor: 'S' }, dx: 'gap_x6', dy: 'gap_y6' },
    { id: 's7', from: { compId: 'ring_bot', anchor: 'S' }, to: { compId: 'gnd_bot', anchor: 'N' }, dx: 'gap_x7', dy: 'gap_y7' },
  ];

  return { params, components, snaps, mirrors: [], groups: [], booleans: [], stack: defaultStack(), stackName: 'LTOI600_NbN_EPFL' };
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
