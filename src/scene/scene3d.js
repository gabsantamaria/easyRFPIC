// 3-D viewer spec builder — PURE (no three.js import, fully unit-tested).
//
// buildScene3D(scene, paramValues) → { solids, warnings }
//
// Converts the 2-D parametric scene into a list of plain-data 3-D solids
// that src/ui/Viewer3D.jsx turns into three.js meshes. STRICTLY render-side:
// nothing here mutates the scene model, the solver, or any export path —
// it CONSUMES the same pipeline the canvas/exporters use (normalizeScene →
// solveLayout + applyMirrors + resolveBooleanBboxes → expandTransforms →
// shapeInstanceToRing) and the same numeric Z walk the pyAEDT exporter
// uses (computeNumericLayerZ).
//
// 3-D COORDINATE CONVENTION — Z-UP:
//   X = plan-view x (µm), Y = plan-view y (µm), Z = stack height (µm).
// Engineers think in Z-up layer stacks; the viewer sets camera.up=(0,0,1)
// and extrudes plan-view rings along +Z. (The canvas's y-up world maps
// 1:1 onto the XY plane — no axis flip anywhere.)
//
// SOLID KINDS (all carry { id, compId, selectId, kind, color, opacity,
// layerKey, label, role?, csg? }):
//   'extrude'  — { ring: [[x,y],…], holes: [ring,…], zBottom, height }
//                plan-view polygon extruded in +Z.
//   'cylinder' — { cx, cy, r, zBottom, height } (vias: layerFrom.zBottom →
//                layerTo.zTop, the same numbers generatePyAEDT emits).
//   'bridge'   — { profile: [[x_along, zAbs],…] CLOSED arch cross-section
//                in the (length-axis, Z) plane sampled by the SAME
//                parabolic 9-pt sampler generatePyAEDT uses
//                (src/geometry/bridge.js), width, cx, cy, rotationDeg,
//                zBottom }. The viewer sweeps the profile by `width`.
//                Zero-thickness strap → thin (~0.05 µm) profile + warning.
//   'loft'     — { ringBottom, ringTop, zBottom, height } two index-
//                corresponded plan rings (same vertex count/order) joined
//                by planar side walls: bottom cap at zBottom, top cap at
//                zBottom+height. Used for the rib-waveguide etch-angle
//                trapezoid (sloped sidewalls; the SAME ribBotW/ribTopW
//                math generateHfssNative sweeps).
//
// BOOLEANS (CSG scope — subtract/punch ONLY):
//   union      — each consumed operand emits as its own solid. CSG-union is
//                DELIBERATELY skipped: overlapping same-material solids
//                already read as merged, and a real union costs CSG time
//                for zero visual gain.
//   subtract / punch — the blank operand's solids carry
//                csg: { subtractIds: [tool solid ids] }; tool operands emit
//                with role:'tool' (the viewer CSG-subtracts them and never
//                renders them standalone). Punch tool CLONES (cloneOf set,
//                consumedBy the punch) are consumed exactly like the canvas
//                treats them; the ORIGINAL punch tool component is NOT
//                consumed and still renders standalone.
//   intersect  — rendered as overlapping operand solids + a warning (no
//                CSG intersect in the preview).
//
// layerKey values are EXACTLY the keys src/ui/canvas/layer-visibility.js
// produces ('wg' | 'port' | 'via' | 'cond:<id>' | 'electrode') so the
// LAYERS-tab eyes filter the 3-D view identically to the canvas, PLUS
// 'stack:<id>' for the substrate/cladding slabs (viewer-local toggles).
//
// DOCUMENTED APPROXIMATIONS (each also pushes a warnings[] entry when hit):
//   - zero-thickness conductors render with a nominal 0.02 µm height.
//   - cladding is a translucent box (NO subtraction of embedded parts —
//     translucency shows them better); substrates are translucent slabs.
//   - constant-width polylines use a mitered band; tapered polylines use
//     the same butt-join per-segment quads the HFSS export emits.
//   - port rects render as thin sheets at the bound conductor's mid-Z
//     (where the HFSS port sheet sits).
import { normalizeScene } from './schema.js';
import { evalExpr } from './params.js';
import { solveLayout, applyMirrors, resolveBooleanBboxes } from './solver.js';
import { expandTransforms } from './transforms.js';
import { shapeInstanceToRing, remapPointsToInstance } from '../geometry/rings.js';
import { buildRacetrackCenterline, offsetCenterlineToBand } from '../geometry/racetrack.js';
import { tessellatePolylinePath, taperedBandQuads, polylineIsTapered } from '../geometry/polyline.js';
import { sampleBridgeArch } from '../geometry/bridge.js';
import { computeNumericLayerZ } from './layer-z.js';
import { layerVisKey } from '../ui/canvas/layer-visibility.js';

// Nominal heights for zero-thickness / sheet-like solids (µm).
export const SHEET_EPS = 0.02;      // zero-thickness conductor stand-in
const PORT_SHEET_T = 0.05;          // port sheet visual thickness
const BRIDGE_SHEET_T = 0.05;        // zero-thickness bridge strap stand-in
const DEFAULT_PAD = 50;             // chip-extent pad when simSetup has none

// Role-fallback colors — the same hexes the canvas layerStyle uses.
const ROLE_COLORS = {
  waveguide: '#3ec27a',
  electrode: '#f4a72e',
  port: '#b91c1c',
  via: '#94a3b8',
  bridge: '#f59e0b',
};

// Point-in-polygon (ray cast). Used to decide hole-vs-CSG for cutouts.
function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

// Mitered constant-width band around an OPEN centerline. Returns one ring
// (left side then reversed right side, butt end caps). Miter length is
// clamped to 4× halfW so near-reversals don't explode.
function miterBandRing(pts, halfW) {
  const n = pts.length;
  if (n < 2 || !(halfW > 0)) return null;
  const dirs = [];
  for (let i = 0; i + 1 < n; i++) {
    const dx = pts[i + 1][0] - pts[i][0];
    const dy = pts[i + 1][1] - pts[i][1];
    const len = Math.hypot(dx, dy) || 1;
    dirs.push([dx / len, dy / len]);
  }
  const left = [];
  const right = [];
  for (let i = 0; i < n; i++) {
    const dPrev = dirs[Math.max(0, i - 1)];
    const dNext = dirs[Math.min(dirs.length - 1, i)];
    // Normals point "left" of travel.
    const n1 = [-dPrev[1], dPrev[0]];
    const n2 = [-dNext[1], dNext[0]];
    let mx = n1[0] + n2[0];
    let my = n1[1] + n2[1];
    const mlen = Math.hypot(mx, my);
    if (mlen < 1e-9) { mx = n2[0]; my = n2[1]; }
    else { mx /= mlen; my /= mlen; }
    // Miter scale: 1/cos(θ/2), clamped.
    const dot = Math.max(0.25, mx * n2[0] + my * n2[1]);
    const s = Math.min(halfW / dot, halfW * 4);
    left.push([pts[i][0] + mx * s, pts[i][1] + my * s]);
    right.push([pts[i][0] - mx * s, pts[i][1] - my * s]);
  }
  return [...left, ...right.reverse()];
}

export function buildScene3D(rawScene, paramValues) {
  const warnings = [];
  const warnedKeys = new Set();
  const warn = (key, msg) => {
    if (warnedKeys.has(key)) return;
    warnedKeys.add(key);
    warnings.push(msg);
  };

  const scene = normalizeScene(rawScene);
  const pv = paramValues || {};
  const stack = scene.stack || [];
  const layerZ = computeNumericLayerZ(stack, pv);
  const solved = resolveBooleanBboxes(
    applyMirrors(solveLayout(scene.components, scene.snaps, pv), scene.mirrors || []),
    pv,
  );
  const compById = Object.fromEntries(solved.map(c => [c.id, c]));
  const wgLayer = stack.find(l => l.role === 'waveguide') || null;
  const conductors = stack.filter(l => l.role === 'conductor');

  const solids = [];
  const solidById = new Map();
  let counter = 0;
  const pushSolid = (s) => {
    const solid = { holes: [], role: null, csg: null, ...s, id: s.id ?? `s${counter++}` };
    solids.push(solid);
    solidById.set(solid.id, solid);
    return solid.id;
  };

  // ── Cluster transforms (boolean transform chains) ───────────────────────
  // Each xf reflects one boolean transform-instance: translate by (dx, dy),
  // mirror about (cx, cy) when sx/sy = -1, rotate about (cx, cy) by rot deg.
  // Applied POINT-WISE to leaf rings (exact rigid transform of the composed
  // cluster; matches the canvas overrides for unrotated operands).
  const applyXfPoint = (xf, p) => {
    let tx = p[0] + xf.dx;
    let ty = p[1] + xf.dy;
    if (xf.sx === -1) tx = 2 * xf.cx - tx;
    if (xf.sy === -1) ty = 2 * xf.cy - ty;
    if (xf.rot) {
      const rad = (xf.rot * Math.PI) / 180;
      const ca = Math.cos(rad);
      const sa = Math.sin(rad);
      const rx = tx - xf.cx;
      const ry = ty - xf.cy;
      tx = xf.cx + rx * ca - ry * sa;
      ty = xf.cy + rx * sa + ry * ca;
    }
    return [tx, ty];
  };
  const xfPoint = (xfs, p) => xfs.reduce((q, xf) => applyXfPoint(xf, q), p);
  const xfRing = (xfs, ring) => (xfs.length === 0 ? ring : ring.map(p => xfPoint(xfs, p)));
  const xfsRotation = (xfs) => xfs.reduce((a, xf) => a + (xf.rot || 0), 0);

  // ── Style / layer resolution ────────────────────────────────────────────
  const boundConductorFor = (c) => {
    if (c.conductorLayerId) {
      const l = conductors.find(x => x.id === c.conductorLayerId);
      if (l) return l;
    }
    return conductors[0] || null;
  };
  const colorFor = (c) => {
    if (c.kind === 'via') return ROLE_COLORS.via;
    if (c.kind === 'bridge') return ROLE_COLORS.bridge;
    if (c.layer === 'port') return ROLE_COLORS.port;
    if (c.layer === 'waveguide') return (wgLayer && wgLayer.color) || ROLE_COLORS.waveguide;
    if (c.layer === 'electrode') {
      const l = boundConductorFor(c);
      return (l && l.color) || ROLE_COLORS.electrode;
    }
    return ROLE_COLORS.electrode;
  };

  // Z placement for a component's material (electrode-ish layers).
  const conductorZFor = (c) => {
    const l = boundConductorFor(c);
    if (l && layerZ[l.id]) {
      return { zBottom: layerZ[l.id].zBottom, thickness: layerZ[l.id].thickness };
    }
    // No conductor layer in the stack — sit on top of the WG layer.
    const zB = wgLayer && layerZ[wgLayer.id] ? layerZ[wgLayer.id].zTop : (evalExpr('h_wg', pv) || 0);
    const t = evalExpr('h_cond', pv);
    return { zBottom: zB, thickness: Number.isFinite(t) ? t : 0.5 };
  };

  // ── Footprint rings per instance (world coords, rotation/mirror baked) ──
  // Returns [{ ring, holes }] — most shapes yield one entry; polylines can
  // yield several (tapered per-segment quads).
  const footprintRings = (c, inst) => {
    if (c.kind === 'polyline') {
      const w = Number.isFinite(inst.width) ? inst.width : 0;
      if (!(w > 0)) {
        warn(`plw:${c.id}`, `${c.id}: polyline with zero width — skipped in 3-D`);
        return [];
      }
      if (polylineIsTapered(c)) {
        const { quads } = taperedBandQuads(c, compById, pv);
        warn('taper-quads', 'tapered polylines render as butt-join per-segment quads (same geometry as the HFSS export)');
        return quads
          .map(q => remapPointsToInstance(q, inst, c.cx, c.cy))
          .map(ring => ({ ring, holes: [] }));
      }
      const base = tessellatePolylinePath(c, compById, pv);
      if (base.length < 2) return [];
      const pts = remapPointsToInstance(base, inst, c.cx, c.cy);
      if (c.closed && pts.length >= 3) {
        const { outer, inner } = offsetCenterlineToBand(pts, w / 2);
        return [{ ring: outer, holes: inner.length >= 3 ? [inner] : [] }];
      }
      const ring = miterBandRing(pts, w / 2);
      return ring ? [{ ring, holes: [] }] : [];
    }
    if (c.kind === 'racetrack') {
      // Band ring with an inner hole — same outer/inner offset the
      // exporters use.
      const R = Number.isFinite(inst.R) ? inst.R : 100;
      const L = Number.isFinite(inst.L_straight) ? inst.L_straight : 300;
      const p = Number.isFinite(inst.p) ? inst.p : 1;
      const wgW = Number.isFinite(inst.wgWidth) ? inst.wgWidth : 1.2;
      const centerline = buildRacetrackCenterline(R, L, p);
      const { outer, inner } = offsetCenterlineToBand(centerline, wgW / 2);
      const rad = ((inst.rotation || 0) * Math.PI) / 180;
      const ca = Math.cos(rad);
      const sa = Math.sin(rad);
      const sx = inst.scaleX ?? 1;
      const sy = inst.scaleY ?? 1;
      const place = ([lx, ly]) => {
        const mx = lx * sx;
        const my = ly * sy;
        return [inst.cx + mx * ca - my * sa, inst.cy + mx * sa + my * ca];
      };
      return [{ ring: outer.map(place), holes: inner.length >= 3 ? [inner.map(place)] : [] }];
    }
    const ring = shapeInstanceToRing(inst);
    if (!ring || ring.length < 3) return [];
    return [{ ring, holes: [] }];
  };

  // ── Cutouts: hole when fully inside EVERY footprint ring, else CSG ─────
  const cutoutRings = (c, inst, xfs) => {
    const out = [];
    for (const cut of c.cutouts || []) {
      const cw = evalExpr(cut.w, pv);
      const ch = evalExpr(cut.h, pv);
      const cdx = evalExpr(cut.dx, pv);
      const cdy = evalExpr(cut.dy, pv);
      if (![cw, ch, cdx, cdy].every(Number.isFinite) || !(cw > 0) || !(ch > 0)) continue;
      const local = [
        [cdx - cw / 2, cdy - ch / 2],
        [cdx + cw / 2, cdy - ch / 2],
        [cdx + cw / 2, cdy + ch / 2],
        [cdx - cw / 2, cdy + ch / 2],
      ];
      const rad = ((inst.rotation || 0) * Math.PI) / 180;
      const ca = Math.cos(rad);
      const sa = Math.sin(rad);
      const sx = inst.scaleX ?? 1;
      const sy = inst.scaleY ?? 1;
      const ring = local.map(([lx, ly]) => {
        const mx = lx * sx;
        const my = ly * sy;
        return [inst.cx + mx * ca - my * sa, inst.cy + mx * sa + my * ca];
      });
      out.push(xfRing(xfs, ring));
    }
    return out;
  };

  // ── Primitive emission ──────────────────────────────────────────────────
  const emitPrimitive = (c, xfs, role, selectId) => {
    const out = [];
    const layerKey = layerVisKey(c, compById, stack);
    const color = colorFor(c);
    const zOffKinds = new Set(['rect', 'circle', 'ellipse', 'polygon', 'polyline', 'polyshape']);
    let zOff = 0;
    if (zOffKinds.has(c.kind || 'rect') && c.zOffset != null && String(c.zOffset).trim() !== '') {
      const zv = evalExpr(c.zOffset, pv);
      if (Number.isFinite(zv)) zOff = zv;
    }
    const insts = expandTransforms([c], pv);

    for (const inst of insts) {
      const instSolidIds = [];
      const common = {
        compId: c.id,
        selectId: selectId ?? c.id,
        layerKey,
        color,
        role,
      };

      if (c.kind === 'via') {
        // Cylinder spanning layerFrom.zBottom → layerTo.zTop (the same
        // numbers generatePyAEDT emits). rotation/zOffset never apply.
        const zF = c.layerFrom ? layerZ[c.layerFrom] : null;
        const zT = c.layerTo ? layerZ[c.layerTo] : null;
        if (!zF || !zT || c.layerFrom === c.layerTo) {
          warn(`via:${c.id}`, `${c.id}: via layerFrom/layerTo unresolved or identical — skipped in 3-D`);
          continue;
        }
        const zBot = Math.min(zF.zBottom, zT.zTop);
        const zTop = Math.max(zF.zBottom, zT.zTop);
        const [cx, cy] = xfPoint(xfs, [inst.cx, inst.cy]);
        instSolidIds.push(pushSolid({
          ...common,
          kind: 'cylinder',
          cx, cy,
          r: Number.isFinite(inst.r) ? inst.r : 0,
          zBottom: zBot,
          height: Math.max(zTop - zBot, SHEET_EPS),
          opacity: 0.95,
          label: `${c.id} (via ${c.layerFrom} → ${c.layerTo})`,
        }));
      } else if (c.kind === 'bridge') {
        const L = Number.isFinite(inst.length) ? inst.length : 0;
        const W = Number.isFinite(inst.width) ? inst.width : 0;
        const H = Number.isFinite(inst.height) ? inst.height : 0;
        if (!(L > 0) || !(W > 0) || !(H > 0)) {
          warn(`br:${c.id}`, `${c.id}: bridge length/width/height must all be > 0 — skipped in 3-D`);
          continue;
        }
        const brCondL = (c.conductorLayerId && conductors.find(l => l.id === c.conductorLayerId)) || conductors[0] || null;
        const brZ0 = brCondL && layerZ[brCondL.id] ? layerZ[brCondL.id].zTop : (evalExpr('h_wg', pv) || 0.6);
        let t = Number.isFinite(inst.thickness)
          ? inst.thickness
          : (brCondL && layerZ[brCondL.id] ? layerZ[brCondL.id].thickness : (evalExpr('h_cond', pv) || 0));
        if (!Number.isFinite(t)) t = 0;
        let sheet = false;
        if (Math.abs(t) < 1e-9) {
          t = BRIDGE_SHEET_T;
          sheet = true;
          warn(`brsheet:${c.id}`, `${c.id}: zero-thickness bridge strap rendered as a thin (~${BRIDGE_SHEET_T} µm) sheet for visibility`);
        }
        // Closed profile: lower arch + reversed upper arch (the SAME
        // 9-point parabola generatePyAEDT sweeps).
        const arch = sampleBridgeArch(L, H, 8);
        const lower = arch.map(([xa, zr]) => [xa, brZ0 + zr]);
        const upper = arch.map(([xa, zr]) => [xa, brZ0 + zr + t]).reverse();
        const [cx, cy] = xfPoint(xfs, [inst.cx, inst.cy]);
        const mirrored = (inst.scaleX ?? 1) !== 1 || (inst.scaleY ?? 1) !== 1
          || xfs.some(xf => xf.sx === -1 || xf.sy === -1);
        if (mirrored) {
          warn(`brmir:${c.id}`, `${c.id}: mirrored bridge rendered un-mirrored (arch is length-symmetric; only asymmetric placements differ)`);
        }
        instSolidIds.push(pushSolid({
          ...common,
          kind: 'bridge',
          profile: [...lower, ...upper],
          width: W,
          cx, cy,
          rotationDeg: (inst.rotation || 0) + xfsRotation(xfs),
          zBottom: brZ0,
          opacity: sheet ? 0.7 : 0.9,
          label: `${c.id} (airbridge)`,
        }));
      } else if (c.layer === 'waveguide' && c.kind === 'rect'
                 && !(Number.isFinite(inst.cornerRadius) && inst.cornerRadius > 0)) {
        // Rib waveguide: slab extrude + trapezoidal rib LOFT — the SAME
        // slab/rib dimension sources AND etch-angle trapezoid math as the
        // HFSS-native wg emission (ribH/tan(etch_angle) sidewall inset,
        // core_width_ref 'top'|'bottom' reference face).
        const z = wgLayer && layerZ[wgLayer.id]
          ? layerZ[wgLayer.id]
          : { zBottom: 0, thickness: evalExpr('h_wg', pv) || 0.6 };
        const coreW = evalExpr((wgLayer && wgLayer.core_width) || 'w_wg', pv);
        const slabH = evalExpr((wgLayer && wgLayer.slab_height) || 'h_slab', pv);
        const slabW = evalExpr((wgLayer && wgLayer.slab_width) || 'w_slab', pv);
        const etchDeg = evalExpr((wgLayer && wgLayer.etch_angle) || 'etch_angle', pv);
        const safeCoreW = Number.isFinite(coreW) && coreW > 0 ? coreW : 1.2;
        const safeSlabH = Number.isFinite(slabH) && slabH > 0 ? slabH : 0.1;
        const safeSlabW = Number.isFinite(slabW) && slabW > 0 ? slabW : 5.0;
        const safeAngle = Number.isFinite(etchDeg) && etchDeg > 0 && etchDeg <= 90 ? etchDeg : 70;
        const axis = inst.w >= inst.h ? 'x' : 'y';
        const rectRing = (perpW) => xfRing(xfs, shapeInstanceToRing({
          ...inst,
          kind: 'rect',
          cornerRadius: 0,
          w: axis === 'x' ? inst.w : perpW,
          h: axis === 'x' ? perpW : inst.h,
        }));
        const thk = Number.isFinite(z.thickness) ? z.thickness : 0.6;
        const slabT = Math.min(safeSlabH, thk);
        instSolidIds.push(pushSolid({
          ...common,
          kind: 'extrude',
          ring: rectRing(safeSlabW),
          zBottom: z.zBottom + zOff,
          height: Math.max(slabT, SHEET_EPS),
          opacity: 1,
          label: `${c.id} (wg slab)`,
        }));
        const ribH = thk - slabT;
        if (ribH > 1e-9) {
          // Sidewall inset over the rib height (etch angle from horizontal,
          // < 90° ⇒ base wider than top) — mirrors generateHfssNative.
          const inward = ribH / Math.max(Math.tan((safeAngle * Math.PI) / 180), 1e-9);
          const widthRef = wgLayer && wgLayer.core_width_ref === 'bottom' ? 'bottom' : 'top';
          let ribBotW;
          let ribTopW;
          if (widthRef === 'top') {
            ribTopW = safeCoreW;
            ribBotW = safeCoreW + 2 * inward;
          } else {
            ribBotW = safeCoreW;
            ribTopW = Math.max(0, safeCoreW - 2 * inward);
          }
          if (!(ribTopW > 0)) {
            warn(`ribpinch:${c.id}`, `${c.id}: etch angle fully pinches the rib top (top width ≤ 0) — rendered with a hairline top face`);
          }
          instSolidIds.push(pushSolid({
            ...common,
            kind: 'loft',
            ringBottom: rectRing(ribBotW),
            ringTop: rectRing(Math.max(ribTopW, 1e-3)),
            zBottom: z.zBottom + zOff + slabT,
            height: ribH,
            opacity: 1,
            label: `${c.id} (wg rib)`,
          }));
        }
      } else {
        // Generic extrude: footprint ring(s) at the layer's Z span.
        let zBottom;
        let height;
        let opacity = 1;
        let label = c.id;
        if (c.layer === 'waveguide') {
          const z = wgLayer && layerZ[wgLayer.id]
            ? layerZ[wgLayer.id]
            : { zBottom: 0, thickness: evalExpr('h_wg', pv) || 0.6 };
          zBottom = z.zBottom + zOff;
          height = Number.isFinite(z.thickness) ? z.thickness : 0.6;
          if (c.kind === 'rect') {
            warn('wg-rounded', 'rounded waveguide rects render as a uniform slab (no rib profile) — same as the HFSS export');
          }
        } else if (c.layer === 'port') {
          // Thin sheet at the bound conductor's mid-Z (where the HFSS
          // port sheet sits).
          const z = conductorZFor(c);
          const mid = z.zBottom + (Number.isFinite(z.thickness) ? z.thickness : 0) / 2;
          zBottom = mid - PORT_SHEET_T / 2 + zOff;
          height = PORT_SHEET_T;
          opacity = 0.45;
          label = `${c.id} (port sheet)`;
        } else {
          const z = conductorZFor(c);
          zBottom = z.zBottom + zOff;
          height = Number.isFinite(z.thickness) ? z.thickness : 0;
          if (!(height > 0)) {
            height = SHEET_EPS;
            warn('zero-cond', 'zero-thickness conductor(s) rendered with nominal thickness for visibility (0.02 µm)');
          }
        }
        // Apply the boolean-cluster transform chain (xfs) to the footprint
        // rings — replicas of a boolean's repeat/displace chain land at
        // their instance positions, not piled on the base (the via/bridge/
        // wg branches already xfPoint/xfRing; this branch must too).
        for (const { ring, holes } of footprintRings(c, inst)) {
          instSolidIds.push(pushSolid({
            ...common,
            kind: 'extrude',
            ring: xfRing(xfs, ring),
            holes: (holes || []).map(h => xfRing(xfs, h)),
            zBottom,
            height,
            opacity,
            label,
          }));
        }
      }

      // ── Cutouts on this instance ─────────────────────────────────────
      const cuts = cutoutRings(c, inst, xfs);
      if (cuts.length && instSolidIds.length) {
        const instSolids = instSolidIds.map(id => solidById.get(id));
        const extrudes = instSolids.filter(s => s.kind === 'extrude');
        for (const cut of cuts) {
          const insideAll = extrudes.length === instSolids.length
            && extrudes.every(s => cut.every(([x, y]) => pointInRing(x, y, s.ring)));
          if (insideAll) {
            for (const s of extrudes) s.holes = [...s.holes, cut];
          } else {
            // Partial overlap (or non-extrude solid): CSG-subtract a tool
            // prism spanning the instance's full Z range.
            let zLo = Infinity;
            let zHi = -Infinity;
            for (const s of instSolids) {
              if (Number.isFinite(s.zBottom)) zLo = Math.min(zLo, s.zBottom);
              if (Number.isFinite(s.zBottom) && Number.isFinite(s.height)) zHi = Math.max(zHi, s.zBottom + s.height);
            }
            if (!Number.isFinite(zLo) || !Number.isFinite(zHi)) continue;
            const toolId = pushSolid({
              ...common,
              kind: 'extrude',
              ring: cut,
              zBottom: zLo,
              height: zHi - zLo,
              opacity: 1,
              role: 'tool',
              label: `${c.id} (cutout)`,
            });
            for (const s of instSolids) {
              s.csg = s.csg || { subtractIds: [] };
              s.csg.subtractIds = [...s.csg.subtractIds, toolId];
            }
          }
        }
      }
      out.push(...instSolidIds);
    }
    return out;
  };

  // ── Boolean emission (recursive) ────────────────────────────────────────
  const emitComponent = (c, xfs, role, selectId, depth = 0) => {
    if (!c || depth > 16) return [];
    if (c.kind !== 'boolean') return emitPrimitive(c, xfs, role, selectId);
    const ops = (c.operandIds || []).map(id => compById[id]).filter(Boolean);
    if (ops.length === 0) return [];
    const out = [];
    // Boolean transform chain: one cluster xform per boolean instance
    // (resolveBooleanBboxes wrote numeric w/h + the operand-bbox centroid
    // into the solved record, so expandTransforms works on it directly).
    const bInsts = expandTransforms([c], pv);
    for (const bInst of bInsts) {
      const dx = bInst.cx - c.cx;
      const dy = bInst.cy - c.cy;
      const rot = bInst.rotation || 0;
      const sx = bInst.scaleX ?? 1;
      const sy = bInst.scaleY ?? 1;
      const identity = !dx && !dy && !rot && sx === 1 && sy === 1;
      const instXfs = identity ? xfs : [{ dx, dy, cx: bInst.cx, cy: bInst.cy, rot, sx, sy }, ...xfs];
      if (c.op === 'subtract' || c.op === 'punch') {
        const blankIds = emitComponent(ops[0], instXfs, role, selectId, depth + 1);
        const toolIds = [];
        for (const op of ops.slice(1)) {
          toolIds.push(...emitComponent(op, instXfs, 'tool', selectId, depth + 1));
        }
        if (toolIds.length) {
          for (const bid of blankIds) {
            const s = solidById.get(bid);
            if (!s) continue;
            s.csg = s.csg || { subtractIds: [] };
            s.csg.subtractIds = [...s.csg.subtractIds, ...toolIds];
          }
        }
        out.push(...blankIds);
      } else {
        if (c.op === 'intersect') {
          warn(`isect:${c.id}`, `${c.id}: 'intersect' boolean rendered as overlapping operand solids (no CSG intersect in the 3-D preview)`);
        }
        // union (and unknown ops): visual union — each operand solid
        // stands alone; overlapping same-material solids read as merged.
        for (const op of ops) {
          out.push(...emitComponent(op, instXfs, role, selectId, depth + 1));
        }
      }
    }
    return out;
  };

  // ── Top-level walk: mirror the canvas's standalone-render filter ───────
  for (const c of solved) {
    if (c.consumedBy) continue; // operands render inside their boolean
    emitComponent(c, [], null, c.id, 0);
  }

  // ── Substrate / cladding slabs over the chip extent ────────────────────
  const bbox = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
  const grow = (x, y) => {
    if (x < bbox.minX) bbox.minX = x;
    if (x > bbox.maxX) bbox.maxX = x;
    if (y < bbox.minY) bbox.minY = y;
    if (y > bbox.maxY) bbox.maxY = y;
  };
  for (const s of solids) {
    if (s.kind === 'extrude') for (const [x, y] of s.ring) grow(x, y);
    else if (s.kind === 'loft') {
      for (const [x, y] of s.ringBottom) grow(x, y);
      for (const [x, y] of s.ringTop) grow(x, y);
    }
    else if (s.kind === 'cylinder') { grow(s.cx - s.r, s.cy - s.r); grow(s.cx + s.r, s.cy + s.r); }
    else if (s.kind === 'bridge') {
      const half = Math.max(...s.profile.map(([xa]) => Math.abs(xa)), s.width / 2);
      grow(s.cx - half, s.cy - half);
      grow(s.cx + half, s.cy + half);
    }
  }
  if (!Number.isFinite(bbox.minX)) {
    bbox.minX = -DEFAULT_PAD; bbox.maxX = DEFAULT_PAD;
    bbox.minY = -DEFAULT_PAD; bbox.maxY = DEFAULT_PAD;
  }
  const padOf = (v) => {
    const n = evalExpr(v, pv);
    return Number.isFinite(n) && String(v ?? '').trim() !== '' ? n : DEFAULT_PAD;
  };
  const sim = scene.simSetup || {};
  const x0 = bbox.minX - padOf(sim.padXNeg);
  const x1 = bbox.maxX + padOf(sim.padXPos);
  const y0 = bbox.minY - padOf(sim.padYNeg);
  const y1 = bbox.maxY + padOf(sim.padYPos);
  for (const l of stack) {
    if (l.role !== 'substrate' && l.role !== 'cladding') continue;
    const z = layerZ[l.id];
    if (!z || !(z.thickness > 0)) continue;
    pushSolid({
      compId: null,
      selectId: null,
      kind: 'extrude',
      ring: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]],
      zBottom: z.zBottom,
      height: z.thickness,
      color: l.color || (l.role === 'cladding' ? '#cbd5e1' : '#8da0c0'),
      opacity: l.role === 'cladding' ? 0.12 : 0.25,
      layerKey: `stack:${l.id}`,
      label: `${l.name || l.id} (${l.role})`,
      role: 'stack',
    });
  }

  return { solids, warnings };
}
