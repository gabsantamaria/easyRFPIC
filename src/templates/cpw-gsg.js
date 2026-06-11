// Built-in template: coplanar waveguide (G-S-G) — one signal trace
// flanked by two ground planes on the conductor (electrode) layer.
//
// Parametric positioning follows the codebase convention: cx/cy are
// numeric placeholders, w/h are expressions, and position dependence is
// enforced via SNAPS. The signal trace anchors at the drop point; each
// ground snaps edge-to-edge to the signal with a gap-parametric dy
// offset, so an HFSS-side sweep of <p>_gap slides BOTH grounds
// symmetrically while the signal stays put.
//
// Parameters added per insertion (all id-prefixed so multiple CPWs
// coexist):
//   w_sig   signal trace width (y)
//   gap     signal-edge to ground-edge gap (each side)
//   w_gnd   ground plane width (y)
//   L       CPW length (x, shared by signal + grounds)
//
// All dimensions in µm.
import { freshComponentId, freshParamName } from './_helpers.js';

export default {
  id: 'builtin_cpw_gsg',
  name: 'CPW (G-S-G)',
  description: 'Coplanar waveguide: signal trace + two ground planes with a parametric signal-ground gap.',
  insert(prev, { viewport }) {
    const baseId = freshComponentId(prev, 'cpw');
    const reserve = (sceneSnap, idBase) => {
      const id = freshComponentId(sceneSnap, idBase);
      return [id, { ...sceneSnap, components: [...sceneSnap.components, { id }] }];
    };
    let snap1 = { ...prev, components: [...prev.components, { id: baseId }] };
    let sigId, gndTopId, gndBotId;
    [sigId,    snap1] = reserve(snap1, `${baseId}_sig`);
    [gndTopId, snap1] = reserve(snap1, `${baseId}_gnd_top`);
    [gndBotId, snap1] = reserve(snap1, `${baseId}_gnd_bot`);

    const pWSig = freshParamName(prev, `${baseId}_w_sig`);
    const pGap  = freshParamName(prev, `${baseId}_gap`);
    const pWGnd = freshParamName(prev, `${baseId}_w_gnd`);
    const pL    = freshParamName(prev, `${baseId}_L`);

    // Defaults: a ~50 Ω-ish thin-film CPW starting point (µm).
    const newParams = {
      ...prev.params,
      [pWSig]: { expr: '10',  unit: 'µm', desc: `${baseId} signal trace width` },
      [pGap]:  { expr: '6',   unit: 'µm', desc: `${baseId} signal-to-ground gap (each side)` },
      [pWGnd]: { expr: '60',  unit: 'µm', desc: `${baseId} ground plane width` },
      [pL]:    { expr: '500', unit: 'µm', desc: `${baseId} CPW length` },
    };

    const layer = 'electrode';
    // Bind to the first conductor-role stack layer if one exists so the
    // HFSS export thickens these on the right metal.
    const condLayerId = (prev.stack || []).find((l) => l.role === 'conductor')?.id;
    const condBind = condLayerId ? { conductorLayerId: condLayerId } : {};

    const mkRect = (id, label, w, h) => ({
      id, kind: 'rect', layer, ...condBind,
      cx: viewport.x, cy: viewport.y,
      w, h,
      cutouts: [], transforms: [],
      label,
    });

    const sig    = mkRect(sigId,    'CPW signal trace', pL, pWSig);
    const gndTop = mkRect(gndTopId, 'CPW ground (top)', pL, pWGnd);
    const gndBot = mkRect(gndBotId, 'CPW ground (bottom)', pL, pWGnd);

    // Grounds ride the signal's edges with a gap-parametric offset:
    //   gnd_top.S lands at sig.N + (0, +gap)
    //   gnd_bot.N lands at sig.S + (0, -gap)
    const newSnaps = [
      {
        id: `snap_${baseId}_${gndTopId}_${Math.random().toString(36).slice(2, 6)}`,
        from: { compId: sigId,    anchor: 'N' },
        to:   { compId: gndTopId, anchor: 'S' },
        dx: '0', dy: `(${pGap})`,
      },
      {
        id: `snap_${baseId}_${gndBotId}_${Math.random().toString(36).slice(2, 6)}`,
        from: { compId: sigId,    anchor: 'S' },
        to:   { compId: gndBotId, anchor: 'N' },
        dx: '0', dy: `-(${pGap})`,
      },
    ];

    return {
      ...prev,
      params: newParams,
      components: [...prev.components, sig, gndTop, gndBot],
      snaps: [...prev.snaps, ...newSnaps],
    };
  },
};
