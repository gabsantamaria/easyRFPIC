// Built-in template: horizontal version of the periodic meandered
// conductor electrode. This is the same closed-rectangular-frame +
// rail unit cell as `meander-electrode.js`, but ROTATED 90° at
// construction time so the cell extends in +Y (rail → outer bar →
// inner bar) and copies repeat along +X. Use this when your meander
// axis runs horizontal (e.g. flanking an east-west signal trace).
//
// Why a separate template rather than rotating the vertical meander
// after the fact: rotating a boolean with a repeat transform places
// the operand cluster correctly but leaves the snap targets and AABB
// projections in awkward states (the visible footprint is a tilted
// rectangle, but anchor math defaults to its axis-aligned union AABB).
// Building the cell rotated from the start keeps every cell, snap
// target, and AABB axis-aligned — drag, snap, and HFSS export all
// "just work" without any rotation transform in the chain.
//
// Geometry (relative to the rail's lower-left corner = drop point):
//   x ∈ [0, cell_w + cell_s]   (the period along the meander axis)
//   y ∈ [0, 3·trace_w + cell_d + cell_h]  (rail → outer bar → frame → inner bar)
// Cells repeat by dx = cell_w + cell_s, dy = 0.
//
// Parameters added per insertion (id-prefixed): same set as the
// vertical template — cell_w, cell_s, cell_h, cell_d, trace_w, gap_s, N.
//
// All dimensions in µm.
import { freshComponentId, freshParamName } from './_helpers.js';

export default {
  id: 'builtin_meander_electrode_horizontal',
  name: 'Meander electrode (horizontal)',
  description: 'Periodic meandered conductor line, cells repeated along +X. Same geometry as the vertical template, rotated 90° at construction.',
  insert(prev, { viewport }) {
    // Reserve a base id; every primitive id derives from it so the
    // SHAPES tree groups them visibly under the union component.
    const baseId = freshComponentId(prev, 'meander_h');
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

    const pCellW  = freshParamName(prev, `${baseId}_cell_w`);
    const pCellS  = freshParamName(prev, `${baseId}_cell_s`);
    const pCellH  = freshParamName(prev, `${baseId}_cell_h`);
    const pCellD  = freshParamName(prev, `${baseId}_cell_d`);
    const pTraceW = freshParamName(prev, `${baseId}_trace_w`);
    const pGapS   = freshParamName(prev, `${baseId}_gap_s`);
    const pN      = freshParamName(prev, `${baseId}_N`);

    const newParams = {
      ...prev.params,
      [pCellW]:  { expr: '25',   unit: 'µm', desc: `${baseId} cell period along meander axis (X)` },
      [pCellS]:  { expr: '2',    unit: 'µm', desc: `${baseId} gap between adjacent cells` },
      [pCellH]:  { expr: '9',    unit: 'µm', desc: `${baseId} frame inner height (outer-bar to inner-bar gap)` },
      [pCellD]:  { expr: '4',    unit: 'µm', desc: `${baseId} rail-to-outer-bar gap` },
      [pTraceW]: { expr: '0.5',  unit: 'µm', desc: `${baseId} trace width` },
      [pGapS]:   { expr: '0.5',  unit: 'µm', desc: `${baseId} centered gap in outer bar / rail` },
      [pN]:      { expr: '20',   unit: '',   desc: `${baseId} number of cells (drives repeat transform)` },
    };

    const W = `(${pTraceW})`;
    const H = `(${pCellH})`;
    const D = `(${pCellD})`;
    const L = `(${pCellW})`;
    const S = `(${pCellS})`;
    const G = `(${pGapS})`;

    const layer = 'electrode';

    const baseRect = (id, label, w, h) => ({
      id, kind: 'rect', layer,
      cx: viewport.x, cy: viewport.y,
      w, h,
      cutouts: [], transforms: [],
      label,
      consumedBy: unionId,
    });

    // ── Primitives — all dimensions are the vertical-template ones with
    //    w and h swapped, so the cell runs HORIZONTALLY (period along X,
    //    rail-to-inner-bar stack along Y).
    const halfRailL = `(${S} + ${L} - ${G}) / 2`;   // length of each rail half (along X)
    const halfBar   = `(${L} - ${G}) / 2`;          // length of an outer-bar half (along X)

    const railLRect = baseRect(railL, 'Rail left segment',  halfRailL, W);
    const railURect = baseRect(railU, 'Rail right segment', halfRailL, W);
    const conLRect  = baseRect(conL,  'Connector (left, flanking gap_s)',  W, `${W} + ${D}`);
    const conRRect  = baseRect(conR,  'Connector (right, flanking gap_s)', W, `${W} + ${D}`);
    const outLRect  = baseRect(outL,  'Outer bar (left half)',  halfBar, W);
    const outRRect  = baseRect(outR,  'Outer bar (right half)', halfBar, W);
    const frmLRect  = baseRect(frmL,  'Frame left vertical',  W, `2 * ${W} + ${H}`);
    const frmRRect  = baseRect(frmR,  'Frame right vertical', W, `2 * ${W} + ${H}`);
    const inBarRect = baseRect(inBar, 'Inner bar (far horizontal)', L, W);

    const primitives = [
      railLRect, railURect,
      conLRect, conRRect,
      outLRect, outRRect,
      frmLRect, frmRRect,
      inBarRect,
    ];

    // ── Snaps: railL is the anchor; everything else snaps SW→SW to it ──
    // SW corner of each rect (relative to railL's SW = drop point), with
    // x and y swapped versus the vertical template:
    //   railL  : (0, 0)                                          — anchor
    //   railU  : ((S+L+G)/2, 0)
    //   conL   : ((S+L-G-2W)/2, 0)
    //   conR   : ((S+L+G)/2, 0)
    //   outL   : (S/2, W+D)
    //   outR   : ((S+L+G)/2, W+D)
    //   frmL   : (S/2, W+D)
    //   frmR   : ((S+2L-2W)/2, W+D)
    //   inBar  : (S/2, 2W+D+H)
    const mk = (toId, dx, dy) => ({
      id: `snap_${baseId}_${toId}_${Math.random().toString(36).slice(2, 6)}`,
      from: { compId: railL, anchor: 'SW' },
      to:   { compId: toId,  anchor: 'SW' },
      dx, dy,
    });
    const newSnaps = [
      mk(railU, `(${S} + ${L} + ${G}) / 2`,         '0'),
      mk(conL,  `(${S} + ${L} - ${G} - 2 * ${W}) / 2`, '0'),
      mk(conR,  `(${S} + ${L} + ${G}) / 2`,         '0'),
      mk(outL,  `${S} / 2`,                          `${W} + ${D}`),
      mk(outR,  `(${S} + ${L} + ${G}) / 2`,          `${W} + ${D}`),
      mk(frmL,  `${S} / 2`,                          `${W} + ${D}`),
      mk(frmR,  `(${S} + 2 * ${L} - 2 * ${W}) / 2`,  `${W} + ${D}`),
      mk(inBar, `${S} / 2`,                          `2 * ${W} + ${D} + ${H}`),
    ];

    // ── Union boolean with horizontal repeat (dx = cell_w + cell_s) ────
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
          dx: `${L} + ${S}`,
          dy: '0',
          includeOriginal: true,
        },
      ],
      label: 'Meander electrode (horizontal)',
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
