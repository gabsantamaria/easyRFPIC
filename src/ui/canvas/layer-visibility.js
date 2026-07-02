// Layer show/hide — pure classification helpers.
//
// Visibility is a CANVAS-ONLY concept: hidden components skip rendering and
// canvas interaction, but stay fully in the scene, the solver, and every
// export (HFSS parametricity is untouched — hiding is a viewing aid, never a
// geometry edit). The hidden-key set itself lives in ephemeral React state
// (NOT scene — it would ride into design exports and undo history; NOT
// settings — those are global across designs, and a hidden conductor key
// would silently blank every design sharing that stack id).
//
// KEYS — one per toggleable render family:
//   'wg'            every waveguide-layer component
//   'port'          port-layer components (canvas pseudo-layer)
//   'via'           via components (canvas pseudo-layer)
//   'cond:<id>'     electrode components bound to stack conductor <id>
//                   (unbound electrodes fall back to the FIRST conductor —
//                   the same implicit binding the exporters use)
//   'electrode'     electrodes in a stack with NO conductor layer (edge case)
//
// Classification mirrors Canvas's resolveBoundLayer: booleans recurse to
// their first non-boolean operand (visited-set guarded), so a meander union
// hides with the conductor its operands sit on.

// Shared referentially-stable empty set — lets consumers fast-path the
// nothing-hidden case without allocating.
export const EMPTY_HIDDEN_SET = new Set();

// Classify one component into its visibility key. `compById` is a prebuilt
// id → component map (callers loop; don't rebuild per call), `stack` is
// scene.stack.
export function layerVisKey(c, compById, stack, visited = new Set()) {
  if (!c) return null;
  if (c.kind === 'boolean') {
    if (visited.has(c.id)) return null;
    visited.add(c.id);
    for (const oid of (c.operandIds || [])) {
      const op = compById[oid];
      if (!op) continue;
      if (op.kind === 'boolean') {
        const k = layerVisKey(op, compById, stack, visited);
        if (k) return k;
        continue;
      }
      return layerVisKey(op, compById, stack, visited);
    }
    return null;
  }
  const layer = c.layer || 'waveguide';
  if (layer === 'waveguide') return 'wg';
  if (layer === 'port') return 'port';
  if (layer === 'via' || c.kind === 'via') return 'via';
  if (layer === 'electrode') {
    const conductors = (stack || []).filter(l => l.role === 'conductor');
    if (conductors.length === 0) return 'electrode';
    const bound = c.conductorLayerId && conductors.some(l => l.id === c.conductorLayerId)
      ? c.conductorLayerId
      : conductors[0].id; // implicit first-conductor fallback, like the exporters
    return `cond:${bound}`;
  }
  return null;
}

// The set of component ids that are hidden under `hiddenKeys`. Returns the
// SHARED empty set when nothing is hidden, so referential equality lets
// consumers skip work entirely (and keeps the no-hide render byte-identical).
export function computeHiddenCompIds(components, hiddenKeys, stack) {
  if (!hiddenKeys || hiddenKeys.size === 0) return EMPTY_HIDDEN_SET;
  const compById = Object.fromEntries((components || []).map(c => [c.id, c]));
  const out = new Set();
  for (const c of (components || [])) {
    const key = layerVisKey(c, compById, stack);
    if (key && hiddenKeys.has(key)) out.add(c.id);
  }
  return out;
}
