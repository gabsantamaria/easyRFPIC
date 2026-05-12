// Built-in template: single-bus ring resonator with coupling region.
//
// Topology: one straight bus waveguide; one ring (racetrack with
// L_straight=0, full-Euler bends) positioned directly above it with
// the coupling gap separating the two waveguide outer edges. The
// gap is parametric, so the user can sweep it to tune the coupling
// without re-placing anything.
//
// Geometry note on the gap: the racetrack's AABB h is exactly the
// outer envelope of the waveguide band (bbox-bottom = actual WG outer
// bottom edge), so snapping bus.N → ring.S with dy=gap places the
// physical gap = `gap` parameter, no fudge factor.
import { freshComponentId, freshParamName, resolveWaveguideWidthRef } from './_helpers.js';

export default {
  id: 'builtin_ring_resonator',
  name: 'Ring resonator (single bus)',
  description: 'Straight bus + ring with a parametric coupling gap.',
  insert(prev, { viewport }) {
    const ringId = freshComponentId(prev, 'ring');
    const busId  = freshComponentId({ ...prev, components: [...prev.components, { id: ringId }] }, `${ringId}_bus`);

    const pR    = freshParamName(prev, `${ringId}_R`);
    const pBusL = freshParamName(prev, `${ringId}_bus_L`);
    const pGap  = freshParamName(prev, `${ringId}_gap`);
    const { ref: wgWidthExpr, extraParams } = resolveWaveguideWidthRef(prev);

    const newParams = {
      ...prev.params,
      ...extraParams,
      [pR]:    { expr: '50',  unit: 'µm', desc: `${ringId} bend radius` },
      [pBusL]: { expr: '300', unit: 'µm', desc: `${ringId} bus length` },
      [pGap]:  { expr: '0.3', unit: 'µm', desc: `${ringId} coupling gap` },
    };

    // Bus: a long, thin rectangle on the waveguide layer. Length is
    // an expression so a parameter sweep on bus_L stretches it; height
    // is the waveguide width so cross-section matches the rib.
    const busComp = {
      id: busId,
      kind: 'rect',
      layer: 'waveguide',
      cx: viewport.x, cy: viewport.y,
      w: pBusL, h: wgWidthExpr,
      cutouts: [], transforms: [],
      label: busId,
    };

    // Ring: racetrack with zero straight, p=1 (full Euler). cx/cy here
    // are placeholders — the snap below will derive the real position.
    const ringComp = {
      id: ringId,
      kind: 'racetrack',
      layer: 'waveguide',
      cx: viewport.x, cy: viewport.y,
      R: pR, L_straight: '0', p: '1',
      wgWidth: wgWidthExpr,
      w: `2 * (${pR}) * (1 + 1.45 * 1) + (${wgWidthExpr})`,
      h: `(${pR}) * (2 + 0.754 * 1) + (${wgWidthExpr})`,
      cutouts: [], transforms: [],
      label: ringId,
    };

    // Snap: ring.S sits dy=gap above bus.N. Because the racetrack's
    // AABB equals its outer perimeter envelope (see h formula above),
    // dy is the literal physical gap between the two waveguide outer
    // edges.
    const snap = {
      id: `snap_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      from: { compId: busId, anchor: 'N' },
      to:   { compId: ringId, anchor: 'S' },
      dx: '0',
      dy: pGap,
    };

    return {
      ...prev,
      params: newParams,
      components: [...prev.components, busComp, ringComp],
      snaps: [...prev.snaps, snap],
    };
  },
};
