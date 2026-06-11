// Built-in template: G-S-G probe pad set with TAPERED transitions to a
// CPW launch. One click drops:
//
//   3 probe pads     vertical G-S-G stack at the probe pitch; optional
//                    parametric corner fillet (cornerRadius, default 0)
//   3 tapered polylines
//                    pad width -> trace width over taper_L. Each taper
//                    is a 2-point TAPERED polyline: vertex 0 (base
//                    width = pad height) is snapped to the pad's E
//                    anchor via a component snap; vertex 1 is a
//                    snap-kind vertex pinned to the landing stub's W
//                    anchor carrying the per-vertex taper width. Both
//                    endpoints therefore track pitch / gap / taper_L
//                    sweeps parametrically, and the HFSS export emits
//                    per-segment parametric quad sheets (sqrt() unit-
//                    normal corner expressions) + sweep.
//   3 landing stubs  short straight CPW sections at the launch plane:
//                    signal stub on axis, ground stubs gap-snapped to
//                    the signal stub exactly like the cpw_gsg template,
//                    ready to butt against a CPW or feed a port.
//
// Geometry (pads at left, launch to the right / +x):
//   pad_sig.C   = drop point
//   pad_g_*.C   = drop point ± (0, pitch)
//   stub_sig.W  = pad_sig.E + (taper_L, 0)
//   stub_g_top.S = stub_sig.N + (0, +gap);  stub_g_bot mirrored
//
// The ground tapers are SLANTED (probe pitch in, CPW gap out) — exactly
// what a probe launch looks like. Sweeping pitch, gap, taper_L, pad_w/h
// or the trace widths in HFSS re-evaluates the whole launch coherently.
//
// Parameters added per insertion (id-prefixed):
//   pad_w, pad_h   probe pad size (x, y)
//   pitch          G-S-G pad center-to-center pitch (e.g. 100/150 µm probes)
//   pad_r          pad corner fillet radius (0 = sharp corners)
//   taper_L        taper length (pad E edge to launch plane)
//   w_sig, gap, w_gnd   CPW cross-section at the launch plane
//   stub_L         landing stub length
//
// All dimensions in µm.
import { freshComponentId, freshParamName } from './_helpers.js';

export default {
  id: 'builtin_gsg_probe_pads',
  name: 'GSG probe pads + tapers',
  description: 'G-S-G probe pad set with tapered transitions to a CPW launch (pitch/gap-parametric).',
  insert(prev, { viewport }) {
    const baseId = freshComponentId(prev, 'gsg');
    const reserve = (sceneSnap, idBase) => {
      const id = freshComponentId(sceneSnap, idBase);
      return [id, { ...sceneSnap, components: [...sceneSnap.components, { id }] }];
    };
    let snap1 = { ...prev, components: [...prev.components, { id: baseId }] };
    let padS, padGT, padGB, stubS, stubGT, stubGB, tapS, tapGT, tapGB;
    [padS,   snap1] = reserve(snap1, `${baseId}_pad_sig`);
    [padGT,  snap1] = reserve(snap1, `${baseId}_pad_gnd_top`);
    [padGB,  snap1] = reserve(snap1, `${baseId}_pad_gnd_bot`);
    [stubS,  snap1] = reserve(snap1, `${baseId}_stub_sig`);
    [stubGT, snap1] = reserve(snap1, `${baseId}_stub_gnd_top`);
    [stubGB, snap1] = reserve(snap1, `${baseId}_stub_gnd_bot`);
    [tapS,   snap1] = reserve(snap1, `${baseId}_taper_sig`);
    [tapGT,  snap1] = reserve(snap1, `${baseId}_taper_gnd_top`);
    [tapGB,  snap1] = reserve(snap1, `${baseId}_taper_gnd_bot`);

    const pPadW   = freshParamName(prev, `${baseId}_pad_w`);
    const pPadH   = freshParamName(prev, `${baseId}_pad_h`);
    const pPitch  = freshParamName(prev, `${baseId}_pitch`);
    const pPadR   = freshParamName(prev, `${baseId}_pad_r`);
    const pTaperL = freshParamName(prev, `${baseId}_taper_L`);
    const pWSig   = freshParamName(prev, `${baseId}_w_sig`);
    const pGap    = freshParamName(prev, `${baseId}_gap`);
    const pWGnd   = freshParamName(prev, `${baseId}_w_gnd`);
    const pStubL  = freshParamName(prev, `${baseId}_stub_L`);

    // Defaults sized for 150 µm-pitch GSG probes (µm).
    const newParams = {
      ...prev.params,
      [pPadW]:   { expr: '80',  unit: 'µm', desc: `${baseId} probe pad width (x)` },
      [pPadH]:   { expr: '80',  unit: 'µm', desc: `${baseId} probe pad height (y)` },
      [pPitch]:  { expr: '150', unit: 'µm', desc: `${baseId} G-S-G pad pitch (center-to-center)` },
      [pPadR]:   { expr: '0',   unit: 'µm', desc: `${baseId} pad corner fillet radius (0 = sharp)` },
      [pTaperL]: { expr: '200', unit: 'µm', desc: `${baseId} taper length (pad to CPW launch plane)` },
      [pWSig]:   { expr: '10',  unit: 'µm', desc: `${baseId} signal trace width at launch` },
      [pGap]:    { expr: '6',   unit: 'µm', desc: `${baseId} CPW signal-to-ground gap at launch` },
      [pWGnd]:   { expr: '60',  unit: 'µm', desc: `${baseId} ground trace width at launch` },
      [pStubL]:  { expr: '50',  unit: 'µm', desc: `${baseId} landing stub length` },
    };

    const layer = 'electrode';
    const condLayerId = (prev.stack || []).find((l) => l.role === 'conductor')?.id;
    const condBind = condLayerId ? { conductorLayerId: condLayerId } : {};

    // ── Probe pads: parametric size + optional corner fillet ──────────
    const mkPad = (id, label) => ({
      id, kind: 'rect', layer, ...condBind,
      cx: viewport.x, cy: viewport.y,
      w: pPadW, h: pPadH,
      cornerRadius: pPadR,
      cutouts: [], transforms: [],
      label,
    });
    const padSig  = mkPad(padS,  'GSG pad (signal)');
    const padGTop = mkPad(padGT, 'GSG pad (ground, top)');
    const padGBot = mkPad(padGB, 'GSG pad (ground, bottom)');

    // ── Landing stubs: straight CPW cross-section at the launch ───────
    const mkStub = (id, label, h) => ({
      id, kind: 'rect', layer, ...condBind,
      cx: viewport.x, cy: viewport.y,
      w: pStubL, h,
      cutouts: [], transforms: [],
      label,
    });
    const stubSig  = mkStub(stubS,  'Launch stub (signal)', pWSig);
    const stubGTop = mkStub(stubGT, 'Launch stub (ground, top)', pWGnd);
    const stubGBot = mkStub(stubGB, 'Launch stub (ground, bottom)', pWGnd);

    // ── Tapered transitions: 2-point tapered polylines ────────────────
    // Vertex 0 (a zero-offset rel vertex riding cx/cy, base width = pad
    // height) is placed on the pad's E anchor by a component snap below;
    // the second vertex is snap-bound to the stub's W anchor and carries
    // the launch trace width, so the band tapers pad_h -> trace width
    // and BOTH ends stay parametric in HFSS.
    const mkTaper = (id, label, stubId, endWidth) => ({
      id, kind: 'polyline', layer, ...condBind,
      cx: viewport.x, cy: viewport.y,
      width: pPadH,
      w: '0', h: '0',
      cutouts: [], transforms: [],
      vertices: [
        { kind: 'rel', dx: '0', dy: '0' },
        { kind: 'snap', compId: stubId, anchor: 'W', width: endWidth },
      ],
      closed: false,
      label,
    });
    const taperSig  = mkTaper(tapS,  'Taper (signal)', stubS,  pWSig);
    const taperGTop = mkTaper(tapGT, 'Taper (ground, top)', stubGT, pWGnd);
    const taperGBot = mkTaper(tapGB, 'Taper (ground, bottom)', stubGB, pWGnd);

    // ── Snaps (each component is the target of exactly ONE snap) ──────
    const mk = (fromId, fromAnchor, toId, toAnchor, dx, dy) => ({
      id: `snap_${baseId}_${toId}_${Math.random().toString(36).slice(2, 6)}`,
      from: { compId: fromId, anchor: fromAnchor },
      to:   { compId: toId,   anchor: toAnchor },
      dx, dy,
    });
    const newSnaps = [
      // Ground pads at ±pitch from the signal pad center.
      mk(padS, 'C', padGT, 'C', '0', `(${pPitch})`),
      mk(padS, 'C', padGB, 'C', '0', `-(${pPitch})`),
      // Signal stub: W edge lands taper_L right of the signal pad's E edge.
      mk(padS, 'E', stubS, 'W', `(${pTaperL})`, '0'),
      // Ground stubs ride the signal stub with the CPW launch gap.
      mk(stubS, 'N', stubGT, 'S', '0', `(${pGap})`),
      mk(stubS, 'S', stubGB, 'N', '0', `-(${pGap})`),
      // Tapers: vertex 0 (= polyline cx/cy; its anchors collapse to that
      // point since w=h='0') pinned to each pad's E anchor.
      mk(padS,  'E', tapS,  'C', '0', '0'),
      mk(padGT, 'E', tapGT, 'C', '0', '0'),
      mk(padGB, 'E', tapGB, 'C', '0', '0'),
    ];

    return {
      ...prev,
      params: newParams,
      components: [
        ...prev.components,
        padSig, padGTop, padGBot,
        stubSig, stubGTop, stubGBot,
        taperSig, taperGTop, taperGBot,
      ],
      snaps: [...prev.snaps, ...newSnaps],
    };
  },
};
