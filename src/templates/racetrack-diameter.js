// Built-in template: racetrack loop parameterized by DIAMETER.
//
// Same geometry as the `builtin_racetrack` template (partial-Euler 180°
// bends), but the user-facing knob is the loop DIAMETER D — the
// centerline-to-centerline separation between the two straight arms —
// instead of the bend's minimum radius of curvature R.
//
// The racetrack component is still driven by R internally (that's the
// geometric source of truth for the bends, and what the canvas / GDS /
// HFSS tessellators consume), so we derive R from D as an expression:
//
//     arm_separation = R * (2 + 0.754 * p)      (the SAME linear-in-p fit
//                                                 the app uses for the AABB
//                                                 vertical span)
//   ⇒ R = D / (2 + 0.754 * p)
//
// At p = 0 (pure circular bends) this is EXACT: the bends are semicircles,
// so D = 2R and arm_separation = D. For p > 0 the Euler clothoid extends
// the bend slightly; the rendered separation then tracks D to within ~1%
// (the same tolerance as that fit elsewhere). p defaults to 0 so the
// default instance has D == separation exactly.
//
// R lands on the component as a derived expression, which expandTransforms
// evaluates (evalExpr) exactly like a bare param — so canvas, GDS, and the
// HFSS export all see the correct radius with zero special-casing. D,
// L_straight, and p are emitted as ordinary scene params (HFSS set_var
// knobs), same as the radius-parameterized template.
import { freshComponentId, freshParamName, resolveWaveguideWidthRef } from './_helpers.js';

export default {
  id: 'builtin_racetrack_diameter',
  name: 'Racetrack (by diameter)',
  description: 'Racetrack loop specified by arm separation (diameter) instead of bend radius.',
  insert(prev, { viewport }) {
    const id = freshComponentId(prev, 'racetrack_d');
    const pD = freshParamName(prev, `${id}_D`);
    const pL = freshParamName(prev, `${id}_L_straight`);
    const pP = freshParamName(prev, `${id}_p`);
    const { ref: wgWidthExpr, extraParams } = resolveWaveguideWidthRef(prev);

    const newParams = {
      ...prev.params,
      ...extraParams,
      [pD]: { expr: '200', unit: 'µm', desc: `${id} loop diameter (centerline separation between the straight arms)` },
      [pL]: { expr: '300', unit: 'µm', desc: `${id} straight section length` },
      [pP]: { expr: '0',   unit: '',   desc: `${id} Euler split (0 = pure arc → D is exact; 1 = pure Euler → D within ~1%)` },
    };

    // Min radius of curvature derived from the diameter: R = D / (2 + 0.754*p).
    // Inverts the app's arm-separation fit so D reads as the true separation.
    const rExpr = `(${pD}) / (2 + 0.754 * (${pP}))`;

    // Parametric AABB. Vertical span is the centerline separation (= D) plus
    // the waveguide width — exact by construction since D IS the separation.
    // Horizontal span mirrors the radius template's bend_x_extent ≈ R*(1+1.45p)
    // with R substituted by rExpr.
    const wExpr = `(${pL}) + 2 * (${pD}) * (1 + 1.45 * (${pP})) / (2 + 0.754 * (${pP})) + (${wgWidthExpr})`;
    const hExpr = `(${pD}) + (${wgWidthExpr})`;

    const newComp = {
      id,
      kind: 'racetrack',
      layer: 'waveguide',
      cx: viewport.x,
      cy: viewport.y,
      R: rExpr, L_straight: pL, p: pP,
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
