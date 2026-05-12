// Built-in template: single racetrack loop with partial-Euler bends.
//
// Adds three id-prefixed parameters (R, L_straight, p) so each
// inserted instance gets its own knobs. The component's AABB w/h is
// the parametric over-approximation used elsewhere — the actual
// waveguide band is computed exactly at render time from R, L_straight,
// p, and the waveguide width.
import { freshComponentId, freshParamName, resolveWaveguideWidthRef } from './_helpers.js';

export default {
  id: 'builtin_racetrack',
  name: 'Racetrack',
  description: 'Single racetrack waveguide loop with partial-Euler bends.',
  insert(prev, { viewport }) {
    const id = freshComponentId(prev, 'racetrack');
    const pR = freshParamName(prev, `${id}_R`);
    const pL = freshParamName(prev, `${id}_L_straight`);
    const pP = freshParamName(prev, `${id}_p`);
    const { ref: wgWidthExpr, extraParams } = resolveWaveguideWidthRef(prev);

    const newParams = {
      ...prev.params,
      ...extraParams,
      [pR]: { expr: '100', unit: 'µm', desc: `${id} min radius of curvature` },
      [pL]: { expr: '300', unit: 'µm', desc: `${id} straight section length` },
      [pP]: { expr: '1',   unit: '',   desc: `${id} Euler split (0 = pure arc, 1 = pure Euler)` },
    };

    // Parametric AABB. Bend extension formulas (empirical linear-in-p
    // fits; exact at p=0 and within ~1% at p=1):
    //   bend_x_extent ≈ R * (1 + 1.45 * p)
    //   bend_y_span   ≈ R * (2 + 0.754 * p)
    const wExpr = `(${pL}) + 2 * (${pR}) * (1 + 1.45 * (${pP})) + (${wgWidthExpr})`;
    const hExpr = `(${pR}) * (2 + 0.754 * (${pP})) + (${wgWidthExpr})`;

    const newComp = {
      id,
      kind: 'racetrack',
      layer: 'waveguide',
      cx: viewport.x,
      cy: viewport.y,
      R: pR, L_straight: pL, p: pP,
      wgWidth: wgWidthExpr,
      w: wExpr, h: hExpr,
      cutouts: [], transforms: [],
      label: id,
    };

    return {
      ...prev,
      params: newParams,
      components: [...prev.components, newComp],
    };
  },
};
