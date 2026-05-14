// Built-in template: periodic meandered conductor electrode (kinetic-
// inductance / slow-wave style). One UNIT cell consists of 9 united
// rectangles on the conductor (electrode) layer:
//
//   2 rail pieces  (continuous strip with a periodic gap_s slot)
//   4 frame pieces (left vertical bar with center gap_s,
//                   right vertical bar (solid),
//                   top + bottom horizontal bars closing the frame)
//   2 connectors   (two horizontal traces tying the rail to the
//                   outer (left) vertical bar, flanking gap_s)
//   1 inner bar    (the inner / right vertical of the frame; sits
//                   farthest from the rail)
//
// All nine rects are unioned into a single boolean component; the
// boolean carries a pre-installed `repeat` transform with
// dy = (cell_w + cell_s) so the user just edits the `N` parameter to
// stretch the meander to any length. The HFSS / pyAEDT exports walk
// this directly: the geometry is created once, then duplicated along
// the line, identical to the recorded macros that the geometry was
// originally derived from.
//
// Parametric positioning: the codebase's convention is cx/cy = numeric,
// w/h = expressions, and parametric position dependence is enforced via
// SNAPS. We anchor one primitive (the rail lower piece) at the drop
// point and snap the other 8 primitives' SW corners to its SW corner
// with parametric (dx, dy) offsets. Edit cell_w / cell_s / cell_h /
// cell_d / trace_w / gap_s and the entire cell rebuilds correctly.
//
// Parameters added per insertion (all id-prefixed so multiple meanders
// coexist):
//   cell_w   period (y-length of one cell)
//   cell_s   gap between adjacent cells (along y)
//   cell_h   inner height of the frame (x-distance between OuterBar
//            inner edge and InnerBar inner edge)
//   cell_d   gap from the outer-bar to the rail (along x)
//   trace_w  conductor trace width (every leg of the meander)
//   gap_s    centered gap in the outer bar (and the matching rail slot)
//   N        number of cells (controls the repeat's `n` as N-1)
//
// All dimensions in µm.
import { freshComponentId, freshParamName } from './_helpers.js';

export default {
  id: 'builtin_meander_electrode',
  name: 'Meander electrode',
  description: 'Periodic meandered conductor line (rail + N closed-frame cells) with a built-in repeat transform.',
  insert(prev, { viewport }) {
    // Reserve a base id; every primitive id derives from it so the
    // SHAPES tree groups them visibly under the union component.
    const baseId = freshComponentId(prev, 'meander');
    // We need fresh ids for 9 primitives. Build them sequentially,
    // threading a faux scene so each `freshComponentId` sees the
    // previously-reserved ones.
    const reserve = (sceneSnap, idBase) => {
      const id = freshComponentId(sceneSnap, idBase);
      return [id, { ...sceneSnap, components: [...sceneSnap.components, { id }] }];
    };
    let snap1 = { ...prev, components: [...prev.components, { id: baseId }] };
    let railL, railU, conL, conR, outL, outR, frmL, frmR, inBar;
    [railL, snap1] = reserve(snap1, `${baseId}_rail_L`);
    [railU, snap1] = reserve(snap1, `${baseId}_rail_U`);
    [conL,  snap1] = reserve(snap1, `${baseId}_conL`);
    [conR,  snap1] = reserve(snap1, `${baseId}_conR`);
    [outL,  snap1] = reserve(snap1, `${baseId}_outBarL`);
    [outR,  snap1] = reserve(snap1, `${baseId}_outBarR`);
    [frmL,  snap1] = reserve(snap1, `${baseId}_frmL`);
    [frmR,  snap1] = reserve(snap1, `${baseId}_frmR`);
    [inBar, snap1] = reserve(snap1, `${baseId}_inBar`);
    const unionId = baseId;

    // Allocate id-prefixed parameter names so multiple meanders coexist.
    const pCellW  = freshParamName(prev, `${baseId}_cell_w`);
    const pCellS  = freshParamName(prev, `${baseId}_cell_s`);
    const pCellH  = freshParamName(prev, `${baseId}_cell_h`);
    const pCellD  = freshParamName(prev, `${baseId}_cell_d`);
    const pTraceW = freshParamName(prev, `${baseId}_trace_w`);
    const pGapS   = freshParamName(prev, `${baseId}_gap_s`);
    const pN      = freshParamName(prev, `${baseId}_N`);

    // Defaults: SI-ish values typical for KI/slow-wave studies (µm).
    const newParams = {
      ...prev.params,
      [pCellW]:  { expr: '25',   unit: 'µm', desc: `${baseId} cell period along meander axis` },
      [pCellS]:  { expr: '2',    unit: 'µm', desc: `${baseId} gap between adjacent cells` },
      [pCellH]:  { expr: '9',    unit: 'µm', desc: `${baseId} frame inner height (outer-bar to inner-bar gap)` },
      [pCellD]:  { expr: '4',    unit: 'µm', desc: `${baseId} rail-to-outer-bar gap` },
      [pTraceW]: { expr: '0.5',  unit: 'µm', desc: `${baseId} trace width` },
      [pGapS]:   { expr: '0.5',  unit: 'µm', desc: `${baseId} centered gap in outer bar / rail` },
      [pN]:      { expr: '3',    unit: '',   desc: `${baseId} number of cells (drives repeat transform)` },
    };

    // Bracketed param refs so each occurrence parses as a single
    // identifier and renames flow correctly through the PARAMS panel.
    const W = `(${pTraceW})`;
    const H = `(${pCellH})`;
    const D = `(${pCellD})`;
    const L = `(${pCellW})`;
    const S = `(${pCellS})`;
    const G = `(${pGapS})`;

    const layer = 'electrode';

    // Helper to build a primitive rect that is consumed by the union.
    // cx/cy are NUMERIC placeholders — the snap solver will overwrite
    // them on first solve. w/h are parametric expressions.
    const baseRect = (id, label, w, h) => ({
      id, kind: 'rect', layer,
      cx: viewport.x, cy: viewport.y,
      w, h,
      cutouts: [], transforms: [],
      label,
      consumedBy: unionId,
    });

    // ── Primitive rectangles (sizes are parametric, positions via snaps) ──
    const halfRailH = `(${S} + ${L} - ${G}) / 2`;   // height of each rail half
    const halfBar   = `(${L} - ${G}) / 2`;          // height of an outer-bar half

    const railLRect = baseRect(railL, 'Rail lower segment', W, halfRailH);
    const railURect = baseRect(railU, 'Rail upper segment', W, halfRailH);
    const conLRect  = baseRect(conL,  'Connector (lower, flanking gap_s)', `${W} + ${D}`, W);
    const conRRect  = baseRect(conR,  'Connector (upper, flanking gap_s)', `${W} + ${D}`, W);
    const outLRect  = baseRect(outL,  'Outer bar (lower half)', W, halfBar);
    const outRRect  = baseRect(outR,  'Outer bar (upper half)', W, halfBar);
    const frmLRect  = baseRect(frmL,  'Frame bottom horizontal', `2 * ${W} + ${H}`, W);
    const frmRRect  = baseRect(frmR,  'Frame top horizontal',    `2 * ${W} + ${H}`, W);
    const inBarRect = baseRect(inBar, 'Inner bar (far vertical)', W, L);

    const primitives = [
      railLRect, railURect,
      conLRect, conRRect,
      outLRect, outRRect,
      frmLRect, frmRRect,
      inBarRect,
    ];

    // ── Snaps: railL is the anchor; everything else snaps SW→SW to it ────
    // SW corner of each rect (relative to railL's SW = drop point):
    //   railL  : (0, 0)                                        — anchor
    //   railU  : (0, (S+L+G)/2)
    //   conL   : (0, (S+L-G-2W)/2)
    //   conR   : (0, (S+L+G)/2)
    //   outL   : (W+D, S/2)
    //   outR   : (W+D, (S+L+G)/2)
    //   frmL   : (W+D, S/2)
    //   frmR   : (W+D, (S+2L-2W)/2)
    //   inBar  : (2W+D+H, S/2)
    //
    // Snap dx/dy in the scene model are the offsets from the FROM anchor
    // to the TO anchor (the TO component is repositioned so that
    // to.anchor lands at from.anchor + (dx, dy)).
    const mk = (toId, dx, dy) => ({
      id: `snap_${baseId}_${toId}_${Math.random().toString(36).slice(2, 6)}`,
      from: { compId: railL, anchor: 'SW' },
      to:   { compId: toId,  anchor: 'SW' },
      dx, dy,
    });
    const newSnaps = [
      mk(railU, '0',                       `(${S} + ${L} + ${G}) / 2`),
      mk(conL,  '0',                       `(${S} + ${L} - ${G} - 2 * ${W}) / 2`),
      mk(conR,  '0',                       `(${S} + ${L} + ${G}) / 2`),
      mk(outL,  `${W} + ${D}`,             `${S} / 2`),
      mk(outR,  `${W} + ${D}`,             `(${S} + ${L} + ${G}) / 2`),
      mk(frmL,  `${W} + ${D}`,             `${S} / 2`),
      mk(frmR,  `${W} + ${D}`,             `(${S} + 2 * ${L} - 2 * ${W}) / 2`),
      mk(inBar, `2 * ${W} + ${D} + ${H}`,  `${S} / 2`),
    ];

    // ── Union boolean: the meander cell as one HFSS-side object ──────────
    // cx/cy are placeholders too; resolveBooleanBboxes overwrites them
    // with the centroid of the operand AABB after solving. The
    // pre-installed `repeat` transform stretches the unit along +Y by
    // editing N. n = N-1 so N=1 produces exactly one cell (no copies).
    const union = {
      id: unionId,
      kind: 'boolean',
      op: 'union',
      operandIds: primitives.map(p => p.id),
      layer,
      cx: viewport.x, cy: viewport.y,
      w: '0', h: '0',
      cutouts: [],
      transforms: [
        {
          id: `tr_${baseId}_repeat_${Math.random().toString(36).slice(2, 6)}`,
          kind: 'repeat',
          enabled: true,
          n: `${pN} - 1`,
          dx: '0',
          dy: `${L} + ${S}`,
          includeOriginal: true,
        },
      ],
      label: 'Meander electrode',
    };

    return {
      ...prev,
      params: newParams,
      components: [
        ...prev.components,
        ...primitives,
        union,
      ],
      snaps: [...prev.snaps, ...newSnaps],
    };
  },
};
