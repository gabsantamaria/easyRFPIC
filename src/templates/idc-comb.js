// Built-in template: interdigitated capacitor (IDC) — two vertical bus
// bars with opposing horizontal finger combs that interleave along y.
//
// Per side: ONE finger rect carrying a `repeat` transform (n = N-1,
// dy = one same-side finger pitch) is united with its bus bar into a
// union boolean — the SHAPES tree shows two derived combs, and the
// HFSS export creates the base finger once, DuplicateAlongLine's it
// N-1 times, then Unites bus + all clones (operand-level transform
// chains feed the boolean's part list, same machinery as the meander
// template's repeat).
//
// Geometry (x = finger direction, y = stacking; drop point = left bus
// bar's SW corner area):
//   same-side finger pitch    p_y = 2*(finger_w + gap)
//   left  finger i spans  y in [i*p_y,                i*p_y + finger_w]
//   right finger i spans  y in [(finger_w+gap)+i*p_y, ... + finger_w]
//     -> adjacent opposing fingers are `gap` apart in y.
//   bus inner-face separation D = 2*finger_L - overlap
//     -> opposing fingers overlap by `overlap` in x, and each finger
//        tip sits (finger_L - overlap) clear of the opposing bus.
//   bus height H = (2*N - 1)*(finger_w + gap) + finger_w  (covers all
//        fingers of both combs).
//
// Everything is enforced via snaps + expressions, so sweeping
// finger_w / finger_L / gap / overlap / N in HFSS rebuilds the whole
// capacitor coherently.
//
// Parameters added per insertion (id-prefixed):
//   finger_w   finger width (y)
//   finger_L   finger length (x)
//   gap        finger-to-finger gap (y, between opposing fingers)
//   overlap    opposing-finger overlap length (x)
//   N          fingers per side (drives each side's repeat transform)
//   bus_w      bus bar width (x)
//
// All dimensions in µm.
import { freshComponentId, freshParamName } from './_helpers.js';

export default {
  id: 'builtin_idc_comb',
  name: 'Interdigitated capacitor',
  description: 'Two bus bars + opposing N-finger combs (repeat-transform fingers united per side).',
  insert(prev, { viewport }) {
    const baseId = freshComponentId(prev, 'idc');
    const reserve = (sceneSnap, idBase) => {
      const id = freshComponentId(sceneSnap, idBase);
      return [id, { ...sceneSnap, components: [...sceneSnap.components, { id }] }];
    };
    let snap1 = { ...prev, components: [...prev.components, { id: baseId }] };
    // Note: component ids use _left/_right suffixes (NOT _L) so the
    // finger component id never collides with the <p>_finger_L PARAM
    // name — same string in two namespaces would make the HFSS script
    // declare a variable and a part with identical names.
    let busL, fingerL, busR, fingerR, combL, combR;
    [busL,    snap1] = reserve(snap1, `${baseId}_bus_left`);
    [fingerL, snap1] = reserve(snap1, `${baseId}_finger_left`);
    [busR,    snap1] = reserve(snap1, `${baseId}_bus_right`);
    [fingerR, snap1] = reserve(snap1, `${baseId}_finger_right`);
    [combL,   snap1] = reserve(snap1, `${baseId}_comb_left`);
    [combR,   snap1] = reserve(snap1, `${baseId}_comb_right`);

    const pFw  = freshParamName(prev, `${baseId}_finger_w`);
    const pFL  = freshParamName(prev, `${baseId}_finger_L`);
    const pGap = freshParamName(prev, `${baseId}_gap`);
    const pOv  = freshParamName(prev, `${baseId}_overlap`);
    const pN   = freshParamName(prev, `${baseId}_N`);
    const pBw  = freshParamName(prev, `${baseId}_bus_w`);

    // Defaults: a mid-pF-range RF IDC starting point (µm).
    const newParams = {
      ...prev.params,
      [pFw]:  { expr: '4',  unit: 'µm', desc: `${baseId} finger width` },
      [pFL]:  { expr: '60', unit: 'µm', desc: `${baseId} finger length` },
      [pGap]: { expr: '3',  unit: 'µm', desc: `${baseId} finger-to-finger gap` },
      [pOv]:  { expr: '50', unit: 'µm', desc: `${baseId} opposing-finger overlap length` },
      [pN]:   { expr: '5',  unit: '',   desc: `${baseId} fingers per side (drives repeat transforms)` },
      [pBw]:  { expr: '10', unit: 'µm', desc: `${baseId} bus bar width` },
    };

    // Bracketed param refs so each occurrence parses as one identifier.
    const FW = `(${pFw})`;
    const FL = `(${pFL})`;
    const G  = `(${pGap})`;
    const OV = `(${pOv})`;
    const N  = `(${pN})`;
    const BW = `(${pBw})`;

    const pitchY = `2 * (${FW} + ${G})`;                  // same-side finger pitch
    const busH   = `(2 * ${N} - 1) * (${FW} + ${G}) + ${FW}`; // covers both combs

    const layer = 'electrode';
    const condLayerId = (prev.stack || []).find((l) => l.role === 'conductor')?.id;
    const condBind = condLayerId ? { conductorLayerId: condLayerId } : {};

    const mkRect = (id, label, w, h, consumedBy, transforms = []) => ({
      id, kind: 'rect', layer, ...condBind,
      cx: viewport.x, cy: viewport.y,
      w, h,
      cutouts: [], transforms,
      label,
      consumedBy,
    });
    const mkRepeat = (toId) => ({
      id: `tr_${baseId}_${toId}_repeat_${Math.random().toString(36).slice(2, 6)}`,
      kind: 'repeat',
      enabled: true,
      n: `${N} - 1`,
      dx: '0',
      dy: pitchY,
      includeOriginal: true,
    });

    const busLRect    = mkRect(busL,    'IDC bus bar (left)',  BW, busH, combL);
    const fingerLRect = mkRect(fingerL, 'IDC finger (left comb)',  FL, FW, combL, [mkRepeat(fingerL)]);
    const busRRect    = mkRect(busR,    'IDC bus bar (right)', BW, busH, combR);
    const fingerRRect = mkRect(fingerR, 'IDC finger (right comb)', FL, FW, combR, [mkRepeat(fingerR)]);

    // ── Snaps ──────────────────────────────────────────────────────────
    // busL anchors the layout; left finger 0 roots at busL's inner-bottom
    // corner; busR sits D = 2*finger_L - overlap right of busL's inner
    // face; right finger 0 roots at busR's inner face, half a pitch
    // (finger_w + gap) up so the combs interleave.
    const mk = (fromId, fromAnchor, toId, toAnchor, dx, dy) => ({
      id: `snap_${baseId}_${toId}_${Math.random().toString(36).slice(2, 6)}`,
      from: { compId: fromId, anchor: fromAnchor },
      to:   { compId: toId,   anchor: toAnchor },
      dx, dy,
    });
    const newSnaps = [
      mk(busL, 'SE', fingerL, 'SW', '0', '0'),
      mk(busL, 'SE', busR,    'SW', `2 * ${FL} - ${OV}`, '0'),
      mk(busR, 'SW', fingerR, 'SE', '0', `${FW} + ${G}`),
    ];

    // ── Union booleans: one derived comb per side ──────────────────────
    // Bus first so Unite's surviving part renames cleanly; the finger
    // operand's repeat chain contributes every clone to the selection.
    const mkUnion = (id, label, operandIds) => ({
      id,
      kind: 'boolean',
      op: 'union',
      operandIds,
      layer,
      cx: viewport.x, cy: viewport.y,
      w: '0', h: '0',
      cutouts: [],
      transforms: [],
      label,
    });
    const combLUnion = mkUnion(combL, 'IDC comb (left)',  [busL, fingerL]);
    const combRUnion = mkUnion(combR, 'IDC comb (right)', [busR, fingerR]);

    return {
      ...prev,
      params: newParams,
      components: [
        ...prev.components,
        busLRect, fingerLRect, busRRect, fingerRRect,
        combLUnion, combRUnion,
      ],
      snaps: [...prev.snaps, ...newSnaps],
    };
  },
};
