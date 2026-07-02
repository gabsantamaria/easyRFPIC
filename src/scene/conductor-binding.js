// Effective conductor-layer binding with BOOLEAN INHERITANCE.
//
// A boolean's operands are pieces of ONE physical body — when the user sets
// the conductor binding on the boolean (the SHAPES-tree component they see),
// operands without their OWN binding must inherit it. Template-built
// clusters (meanders) create operands with no conductorLayerId, so without
// inheritance every consumer fell back to the FIRST conductor-role stack
// layer — in a multi-conductor stack that silently placed the whole cluster
// on the wrong layer (wrong Z + thickness in the 3-D viewer AND the HFSS
// export, wrong GDS layer, wrong LAYERS-eye family; the real "meander looks
// 2 µm thick on a zero-thickness conductor" bug).
//
// Resolution order: the component's own conductorLayerId, else the NEAREST
// `consumedBy` ancestor's (an operand's own explicit binding still wins over
// its boolean's). Returns null when the whole chain is unbound — callers
// keep their existing first-conductor fallback (and warning surfaces).
//
// Used by: scene3d.js (3-D Z/thickness/color), hfss-native.js
// (resolveCondForComp), gds.js (per-conductor GDS layer), Canvas.jsx
// (styleForComponent), layer-visibility.js (LAYERS-eye family), and the
// sceneIssues unbound/stale-conductor checks in PhotonicLayout.jsx.
// Keep them ALL on this helper — a consumer resolving bindings on its own
// will disagree with the others for consumed operands.
export function effectiveConductorLayerId(comp, compById, maxDepth = 16) {
  let c = comp;
  const seen = new Set();
  while (c && maxDepth-- > 0 && !seen.has(c.id)) {
    if (c.conductorLayerId) return c.conductorLayerId;
    seen.add(c.id);
    c = (c.consumedBy && compById) ? compById[c.consumedBy] : null;
  }
  return null;
}
