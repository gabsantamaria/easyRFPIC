// GDS-II export.
//
// Encode the scene as a binary GDS-II stream. GDS-II is a sequence of
// records; each record is `[length(2)][type(1)][datatype(1)][data...]`,
// big-endian. We emit a minimal but standards-compliant file with one
// library, one structure, and one BOUNDARY record per component.
//
// Layer mapping (kept simple, easy to remap later if needed):
//   waveguide → layer 1
//   electrode (per stack conductor)  → layers 10, 11, 12, … (one per
//     conductor layer in stack order; falls back to 10 if no stack info)
//   port      → layer 100
//   bridge    → layer 150 (airbridge footprint)
//
// All coordinates are written as INT32 nanometers (typical GDS practice
// when working in µm: 1 user unit = 1 µm = 1000 database units of 1 nm).
//
// Extracted from PhotonicLayout.jsx as Stage 2.1 of the planned refactor.
import { evalExpr } from '../scene/params.js';
import { isNonModelComponent } from '../scene/schema.js';
import { solveLayout, applyMirrors, resolveBooleanBboxes } from '../scene/solver.js';
import { expandTransforms } from '../scene/transforms.js';
import { tessellatePolylinePath, taperedBandQuads, polylineIsTapered, bandPieces } from '../geometry/polyline.js';
import { rectilinearUnion, isRectilinearRing } from './rect-union.js';
import { shapeInstanceToRing, remapPointsToInstance } from '../geometry/rings.js';
import { effectiveConductorLayerId } from '../scene/conductor-binding.js';
import { buildRacetrackCenterline, offsetCenterlineToBand } from '../geometry/racetrack.js';

// Via GDS layer mapping (D4): vias land on layers 200+. Each DISTINCT
// (layerFrom → layerTo) pair — a "via type" in fab terms — gets its own
// GDS layer, assigned in component order: the first via type seen maps
// to 200, the next new pair to 201, and so on. Exported so the export
// summary dialog (handleExportGDS) and the gdsfactory exporter print /
// reuse the SAME mapping as the binary stream.
export function viaGdsLayerMap(components) {
  const out = [];
  const seen = new Map(); // 'from->to' -> entry
  for (const c of components || []) {
    if (c.kind !== 'via') continue;
    const key = `${c.layerFrom || '?'}->${c.layerTo || '?'}`;
    if (seen.has(key)) continue;
    const entry = { key, layer: 200 + seen.size, layerFrom: c.layerFrom || '?', layerTo: c.layerTo || '?' };
    seen.set(key, entry);
    out.push(entry);
  }
  return out;
}

export function generateGDS(scene, paramValues) {
  const { components, mirrors, snaps, stack } = scene;
  // resolveBooleanBboxes gives every boolean a NUMERIC cx/cy/w/h — the
  // cluster walk below expands the BOOLEAN's transform chain, and
  // expandTransforms needs the solved bbox to place instances (scene3d
  // does exactly the same; without it a boolean's raw w='0' collapses
  // its chain to the base pose).
  const solvedAll = resolveBooleanBboxes(
    applyMirrors(solveLayout(components, snaps, paramValues), mirrors),
    paramValues,
  );
  // Non-model components (section lines) are solver-visible — a child
  // snapped to one must land where the canvas puts it — but never emit
  // geometry. Parametric positions are computed on the FULL solved list
  // (pure param expressions, no object references), then everything
  // downstream sees only physical components.
  const solved = solvedAll.filter(c => !isNonModelComponent(c));

  // ---- GDS record helpers ------------------------------------------------
  // GDS data types
  const DT_NODATA = 0x00;
  const DT_BIT_ARRAY = 0x01;
  const DT_INT2 = 0x02;
  const DT_INT4 = 0x03;
  const DT_REAL8 = 0x05;
  const DT_ASCII = 0x06;
  // Record types we use
  const HEADER     = 0x00;
  const BGNLIB     = 0x01;
  const LIBNAME    = 0x02;
  const UNITS      = 0x03;
  const ENDLIB     = 0x04;
  const BGNSTR     = 0x05;
  const STRNAME    = 0x06;
  const ENDSTR     = 0x07;
  const BOUNDARY   = 0x08;
  const LAYER      = 0x0d;
  const DATATYPE   = 0x0e;
  const XY         = 0x10;
  const ENDEL      = 0x11;

  // Output buffer — built up as a flat array of byte chunks (Uint8Arrays),
  // then concatenated at the end. Keeping chunks separate avoids quadratic
  // re-allocations.
  const chunks = [];
  const pushChunk = (u8) => chunks.push(u8);

  // Big-endian writers
  const writeRecordHeader = (recType, dataType, payloadLen) => {
    const total = payloadLen + 4;
    if (total > 0xffff) throw new Error('GDS record too large');
    const b = new Uint8Array(4);
    b[0] = (total >> 8) & 0xff;
    b[1] = total & 0xff;
    b[2] = recType & 0xff;
    b[3] = dataType & 0xff;
    pushChunk(b);
  };
  const writeNoData = (recType) => writeRecordHeader(recType, DT_NODATA, 0);
  const writeInt2 = (recType, values) => {
    const buf = new Uint8Array(values.length * 2);
    for (let i = 0; i < values.length; i++) {
      const v = values[i] & 0xffff;
      buf[i * 2] = (v >> 8) & 0xff;
      buf[i * 2 + 1] = v & 0xff;
    }
    writeRecordHeader(recType, DT_INT2, buf.length);
    pushChunk(buf);
  };
  const writeInt4 = (recType, values) => {
    const buf = new Uint8Array(values.length * 4);
    const dv = new DataView(buf.buffer);
    for (let i = 0; i < values.length; i++) {
      // Clamp to int32 range; values come from positions in nm so even
      // mm-scale chips fit comfortably.
      let v = values[i] | 0;
      dv.setInt32(i * 4, v, false); // big-endian
    }
    writeRecordHeader(recType, DT_INT4, buf.length);
    pushChunk(buf);
  };
  // GDS REAL8 is an 8-byte excess-64 hexadecimal float (NOT IEEE754!).
  // Encode as: sign(1 bit) | exp+64 base-16 (7 bits) | mantissa (56 bits).
  const writeReal8 = (recType, values) => {
    const buf = new Uint8Array(values.length * 8);
    for (let i = 0; i < values.length; i++) {
      let v = values[i];
      const off = i * 8;
      if (v === 0) continue; // all zeros = 0
      let sign = 0;
      if (v < 0) { sign = 1; v = -v; }
      // Find exponent so 1/16 <= mantissa < 1
      let exp = 0;
      while (v >= 1) { v /= 16; exp++; if (exp > 63) break; }
      while (v < 1/16 && exp > -64) { v *= 16; exp--; }
      const expField = (exp + 64) & 0x7f;
      buf[off] = (sign << 7) | expField;
      // Mantissa: 7 bytes, each 8 bits
      let mant = v;
      for (let j = 1; j < 8; j++) {
        mant *= 256;
        const byte = Math.floor(mant) & 0xff;
        buf[off + j] = byte;
        mant -= byte;
      }
    }
    writeRecordHeader(recType, DT_REAL8, buf.length);
    pushChunk(buf);
  };
  const writeAscii = (recType, str) => {
    // Pad to even length per GDS spec
    let s = str;
    if (s.length & 1) s += '\0';
    const buf = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) buf[i] = s.charCodeAt(i) & 0xff;
    writeRecordHeader(recType, DT_ASCII, buf.length);
    pushChunk(buf);
  };

  // ---- Layer mapping -----------------------------------------------------
  // Keep stack-conductor layer indices consistent across exports: assign
  // GDS layer numbers in the stack's array order. A component on the port
  // layer maps to GDS 100 regardless of stack content.
  const conductorLayers = (stack || []).filter(l => l.role === 'conductor');
  const condIdToGdsLayer = {};
  conductorLayers.forEach((l, i) => { condIdToGdsLayer[l.id] = 10 + i; });
  // Vias: one GDS layer per distinct (layerFrom → layerTo) pair, 200+.
  const viaLayers = viaGdsLayerMap(components);
  const viaKeyToGdsLayer = Object.fromEntries(viaLayers.map(v => [v.key, v.layer]));
  const gdsCompById = Object.fromEntries((components || []).map(cc => [cc.id, cc]));
  const gdsLayerForComponent = (c) => {
    if (c.kind === 'via') {
      return viaKeyToGdsLayer[`${c.layerFrom || '?'}->${c.layerTo || '?'}`] ?? 200;
    }
    // Airbridge (D7): footprint BOUNDARY on its own layer (the ring
    // fallback emits the length × width rect automatically).
    if (c.kind === 'bridge') return 150;
    if (c.layer === 'waveguide') return 1;
    if (c.layer === 'port') return 100;
    if (c.layer === 'electrode') {
      // Own binding, else inherited from the consuming boolean
      // (effectiveConductorLayerId) — template-built operands carry no
      // binding of their own; without inheritance a bound meander's bars
      // landed on the default layer 10 regardless of the user's choice.
      const eff = effectiveConductorLayerId(c, gdsCompById);
      if (eff && condIdToGdsLayer[eff] != null) {
        return condIdToGdsLayer[eff];
      }
      return 10;
    }
    return 0; // fallback
  };

  // ---- Header / library --------------------------------------------------
  const now = new Date();
  const dateInt2 = [
    now.getFullYear(), now.getMonth() + 1, now.getDate(),
    now.getHours(), now.getMinutes(), now.getSeconds(),
    now.getFullYear(), now.getMonth() + 1, now.getDate(),
    now.getHours(), now.getMinutes(), now.getSeconds(),
  ];
  writeInt2(HEADER, [600]); // GDS version 6
  writeInt2(BGNLIB, dateInt2);
  writeAscii(LIBNAME, 'PHOTONIC');
  // UNITS: user_unit_in_db_units (1e-3 = 1µm in 1nm dbunits), db_unit_in_meters (1e-9 = 1nm)
  writeReal8(UNITS, [1e-3, 1e-9]);
  // ---- Structure ---------------------------------------------------------
  writeInt2(BGNSTR, dateInt2);
  writeAscii(STRNAME, 'TOP');

  // Each leaf component → BOUNDARY record(s). Per-component transforms are
  // expanded so each instance becomes its own boundary record; rotated
  // rectangles are emitted as pre-rotated polygons (GDS BOUNDARY has no
  // rotation attribute).
  //
  // BOOLEAN CLUSTERS (scene3d parity — the "meander missing its replicas"
  // fix): a boolean's OWN transform chain (repeat / rotate / mirror /
  // duplicate_mirror on the union) multiplies the WHOLE operand cluster.
  // The walk below expands the boolean's chain into per-instance cluster
  // transforms (exactly scene3d's emitComponent xfs) and emits every
  // operand's rings through them — previously the boolean was skipped
  // outright, so only the base-pose operands landed in the GDS.
  // Boolean OPS are still not polygon-clipped: 'union'/'intersect'
  // operands emit as overlapping DATATYPE-0 polygons (fab tools merge
  // same-layer overlap), while 'subtract'/'punch' TOOL operands emit as
  // DATATYPE-1 polygons — the same cutout convention the racetrack inner
  // ring and component cutouts already use.
  // Keyed-lookup map for polyline SNAP-VERTEX resolution — built from the
  // FULL solved list: a physical trace's vertex may be pinned to a section
  // line's anchor (draw-mode magnetism offers them), and resolving against
  // the geometry-filtered list returned [NaN,NaN] — silent origin-spikes /
  // dropped segments in the output while the canvas looked right.
  const byIdSolved = Object.fromEntries(solvedAll.map(c => [c.id, c]));
  // Cluster transforms — one entry per boolean instance: translate by
  // (dx, dy), mirror about (cx, cy) when sx/sy = -1, rotate about (cx, cy)
  // by rot degrees. Applied POINT-WISE to emitted world coordinates
  // (exact rigid transform of the composed cluster; scene3d's math).
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
  const toNm = (v) => Math.round(v * 1000);
  // One closed BOUNDARY from world points, mapped through the cluster xfs.
  const emitBoundary = (layer, datatype, pts, xfs) => {
    if (!pts || pts.length < 3) return;
    writeNoData(BOUNDARY);
    writeInt2(LAYER, [layer]);
    writeInt2(DATATYPE, [datatype]);
    const xys = [];
    for (const p of pts) {
      const [px, py] = xfs.length ? xfPoint(xfs, p) : p;
      xys.push(toNm(px), toNm(py));
    }
    xys.push(xys[0], xys[1]); // close
    writeInt4(XY, xys);
    writeNoData(ENDEL);
  };
  const emitShapeInstances = (c, xfs, role, layerOverride = null) => {
    const dtMain = role === 'tool' ? 1 : 0;
    const insts = expandTransforms([c], paramValues, solvedAll);
    for (const inst of insts) {
      const w = inst.w, h = inst.h;
      const isPathBand = c.kind === 'polyline' && !polylineIsTapered(c);
      if (!isPathBand && (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0)) continue;
      // TOOL holes land on the BLANK's layer (layerOverride) — a
      // subtract tool drawn on another layer (a port-layer punch) must
      // cut the metal it punches, not decorate its own layer.
      const layer = layerOverride ?? gdsLayerForComponent(c);
      // Constant-width polyline: emit the metal BAND as PAINT-UNION
      // pieces (bandPieces: per-segment quads + miter joint patches —
      // exactly the region the canvas's miter-joined SVG stroke
      // paints). A single band OUTLINE (miterBandRing) folds over
      // itself when the trace width is comparable to a bend's opening —
      // the choke-trace artifact: KLayout rendered wedge/chamfer
      // garbage where the canvas showed a clean U (real user bug); a
      // trailing zero-length vertex additionally corrupted the outline
      // normals. Overlapping same-layer DATATYPE-0 polygons are valid
      // GDS (fab tools merge); when the path is RECTILINEAR the pieces
      // are exactly merged into clean outlines via rectilinearUnion
      // (self-guarded — any doubt falls back to the raw pieces).
      // The old fallback emitted the zero-area CENTERLINE as the
      // boundary: a 4 µm trace exported as no metal at all.
      if (isPathBand) {
        const widthN = Number.isFinite(inst.width) ? inst.width : evalExpr(c.width ?? '0', paramValues);
        if (!Number.isFinite(widthN) || widthN <= 0) continue; // nothing physical to fabricate
        const base = tessellatePolylinePath(c, byIdSolved, paramValues);
        if (base.length < 2) continue;
        const pts = remapPointsToInstance(base, inst, c.cx, c.cy);
        const { pieces } = bandPieces(pts, widthN / 2, !!c.closed);
        if (pieces.length === 0) continue;
        const rectilinear = pieces.every((ring) => isRectilinearRing(ring));
        if (rectilinear) {
          const u = rectilinearUnion(pieces);
          if (u.ok) {
            for (const ring of u.rings) emitBoundary(layer, dtMain, ring, xfs);
            continue;
          }
        }
        for (const ring of pieces) emitBoundary(layer, dtMain, ring, xfs);
        continue;
      }
      // shapeInstanceToRing returns the perimeter ring already accounting
      // for the instance's rotation and shape (rect/circle/ellipse/polygon).
      // Circles/ellipses are tessellated to CIRCLE_TESSELATION vertices —
      // sufficient for fab-friendly GDS output.
      // For polyshape we resolve the vertex list inline (the ring builder
      // expects `_resolvedVerts` on the instance, which expandTransforms
      // doesn't populate). Apply the instance's rotation about its center
      // so repeat / mirror / rotate clones land correctly.
      // Tapered polyline: emit the BAND geometry as one BOUNDARY per
      // segment quad (same layer, DATATYPE 0). The quads come from
      // taperedBandQuads — the same per-segment butt-join geometry the
      // canvas renders and the HFSS export unites — so GDS, canvas and
      // HFSS all describe the SAME band. Quads are computed at the base
      // pose and remapped into each instance's frame (translate / scale /
      // rotate), mirroring the polyshape path below.
      if (c.kind === 'gdsgroup') {
        // Immutable imported layout: packed numeric rings LOCAL to the
        // component center — one BOUNDARY per ring, translated to the
        // instance position (+ instance rotation about the center).
        const radG = (inst.rotation || 0) * Math.PI / 180;
        const caG = Math.cos(radG), saG = Math.sin(radG);
        const gsx = inst.scaleX ?? 1, gsy = inst.scaleY ?? 1; // mirror chains
        for (const ring of (c.rings || [])) {
          if (!Array.isArray(ring) || ring.length < 6) continue;
          const pts = [];
          for (let i = 0; i < ring.length; i += 2) {
            const lx = ring[i] * gsx, ly = ring[i + 1] * gsy; // scale FIRST (rings.js order)
            pts.push([inst.cx + lx * caG - ly * saG, inst.cy + lx * saG + ly * caG]);
          }
          emitBoundary(layer, dtMain, pts, xfs);
        }
        continue;
      }
      if (c.kind === 'polyline' && polylineIsTapered(c)) {
        const { quads } = taperedBandQuads(c, byIdSolved, paramValues);
        const rad0 = (inst.rotation || 0) * Math.PI / 180;
        const ca0 = Math.cos(rad0), sa0 = Math.sin(rad0);
        const sx0 = inst.scaleX ?? 1, sy0 = inst.scaleY ?? 1;
        for (const q of quads) {
          const pts = q.map(([vx, vy]) => {
            const lx = (vx - c.cx) * sx0;
            const ly = (vy - c.cy) * sy0;
            return [inst.cx + lx * ca0 - ly * sa0, inst.cy + lx * sa0 + ly * ca0];
          });
          emitBoundary(layer, dtMain, pts, xfs);
        }
        continue;
      }
      if (c.kind === 'polyshape') {
        // Tessellated perimeter (arcs expanded, spline runs interpolated)
        // so curved edges land in the GDS exactly as drawn.
        const verts = tessellatePolylinePath(c, byIdSolved, paramValues);
        if (verts.length >= 3) {
          // Translate to instance frame, then apply rotation if any.
          const dx = inst.cx - c.cx, dy = inst.cy - c.cy;
          const rad = (inst.rotation || 0) * Math.PI / 180;
          const ca = Math.cos(rad), sa = Math.sin(rad);
          const sx = inst.scaleX ?? 1, sy = inst.scaleY ?? 1;
          const pts = verts.map(([vx, vy]) => {
            const lx = (vx - c.cx) * sx;
            const ly = (vy - c.cy) * sy;
            return [inst.cx + lx * ca - ly * sa, inst.cy + lx * sa + ly * ca];
          });
          emitBoundary(layer, dtMain, pts, xfs);
        }
        continue;
      }
      // Airbridge landing pads: the fabricated strap footprint on layer
      // 150 is (length + 2·padLength) × width — the pads are real metal
      // beyond the span, even though the scene AABB stays length × width.
      const gdsInst = (c.kind === 'bridge' && Number.isFinite(inst.padLength) && inst.padLength > 0)
        ? { ...inst, w: inst.w + 2 * inst.padLength }
        : inst;
      const worldPts = shapeInstanceToRing(gdsInst);
      emitBoundary(layer, dtMain, worldPts, xfs);

      // Racetrack: the outer ring above is just the outer perimeter of
      // the waveguide band. Emit the INNER perimeter on the same layer
      // with DATATYPE = 1 (cutout convention) so a fab tool that supports
      // hollow polygons subtracts the inner from the outer to produce the
      // band. Tools that don't support cutouts will still see a closed
      // racetrack with a hole shape rendered as a separate boundary —
      // which is also a reasonable interpretation.
      if (c.kind === 'racetrack') {
        const R = Number.isFinite(inst.R) ? inst.R : 100;
        const L = Number.isFinite(inst.L_straight) ? inst.L_straight : 300;
        const pE = Number.isFinite(inst.p) ? inst.p : 1;
        const wgW = Number.isFinite(inst.wgWidth) ? inst.wgWidth : 1.2;
        const centerline = buildRacetrackCenterline(R, L, pE);
        const { inner } = offsetCenterlineToBand(centerline, wgW / 2);
        if (inner.length >= 3) {
          // Apply the instance's rotation about (cx, cy).
          const rotRad = (inst.rotation || 0) * Math.PI / 180;
          const ca2 = Math.cos(rotRad), sa2 = Math.sin(rotRad);
          const innerPts = inner.map(([lx, ly]) => [
            inst.cx + lx * ca2 - ly * sa2,
            inst.cy + lx * sa2 + ly * ca2,
          ]);
          emitBoundary(layer, 1, innerPts, xfs);
        }
      }
      // Cutouts only emitted for the BASE instance (transform-instance copies
      // don't carry independent cutouts in this export — they share the
      // base's cutouts spatially relative to themselves, which would require
      // also rotating those rectangles. Out of scope for now; we emit cutouts
      // only on the base instance to avoid introducing inconsistency.).
      if (inst.idx !== 0) continue;
      for (const cu of (c.cutouts || [])) {
        const cw = evalExpr(cu.w, paramValues);
        const ch = evalExpr(cu.h, paramValues);
        const cdx = evalExpr(cu.dx, paramValues);
        const cdy = evalExpr(cu.dy, paramValues);
        if (!Number.isFinite(cw) || !Number.isFinite(ch) || cw <= 0 || ch <= 0) continue;
        const cx0 = inst.cx + cdx - cw / 2;
        const cx1 = inst.cx + cdx + cw / 2;
        const cy0 = inst.cy + cdy - ch / 2;
        const cy1 = inst.cy + cdy + ch / 2;
        emitBoundary(layer, 1, [[cx0, cy0], [cx1, cy0], [cx1, cy1], [cx0, cy1]], xfs);
      }
    }
  };

  // Boolean-cluster walk (scene3d's emitComponent, GDS flavor): expand
  // the boolean's OWN transform chain into per-instance cluster
  // transforms, recurse into operands. subtract/punch TOOLS emit as
  // DATATYPE-1 cutouts; union/intersect operands emit as overlapping
  // solids on the operand's own layer.
  // Layer of the first LEAF under a boolean chain — where a subtract's
  // holes must land (the blank's mask layer).
  const leafLayerOf = (comp, depth = 0) => {
    if (!comp) return null;
    if (comp.kind === 'boolean' && depth < 16) {
      return leafLayerOf(byIdSolved[(comp.operandIds || [])[0]], depth + 1);
    }
    return gdsLayerForComponent(comp);
  };
  const emitComponentGds = (c, xfs, role, depth = 0, layerOverride = null) => {
    if (!c || depth > 16) return;
    if (c.kind !== 'boolean') { emitShapeInstances(c, xfs, role, layerOverride); return; }
    const ops = (c.operandIds || []).map(id => byIdSolved[id]).filter(Boolean);
    if (ops.length === 0) return;
    const bInsts = expandTransforms([c], paramValues, solvedAll);
    for (const bInst of bInsts) {
      const dx = bInst.cx - c.cx;
      const dy = bInst.cy - c.cy;
      const rot = bInst.rotation || 0;
      const sx = bInst.scaleX ?? 1;
      const sy = bInst.scaleY ?? 1;
      const identity = !dx && !dy && !rot && sx === 1 && sy === 1;
      const instXfs = identity ? xfs : [{ dx, dy, cx: bInst.cx, cy: bInst.cy, rot, sx, sy }, ...xfs];
      if (c.op === 'subtract' || c.op === 'punch') {
        emitComponentGds(ops[0], instXfs, role, depth + 1, layerOverride);
        // Tool holes land on the BLANK's layer. NESTED subtract used as
        // a tool: the inner blank removes material (dt 1) but the inner
        // tool's region is KEPT — flat dt algebra can only re-add it
        // (dt 0), which is exact whenever the kept island lies inside
        // outer blank metal (the punch/port idiom).
        const toolRole = role === 'tool' ? 'solid' : 'tool';
        const toolLayer = layerOverride ?? leafLayerOf(ops[0]);
        for (const op of ops.slice(1)) emitComponentGds(op, instXfs, toolRole, depth + 1, toolLayer);
      } else {
        for (const op of ops) emitComponentGds(op, instXfs, role, depth + 1, layerOverride);
      }
    }
  };
  for (const c of solved) {
    // Consumed operands emit through their boolean's cluster walk (which
    // applies the boolean's transform chain). The skip requires the
    // BACK-POINTER to round-trip — same rule as the canvas renderer: a
    // consumedBy pointing at a deleted comp, a non-boolean, or a boolean
    // that doesn't list this comp falls back to standalone emission
    // (review find: existence-only checking silently dropped
    // canvas-visible geometry on inconsistent scenes).
    const consumer = c.consumedBy ? byIdSolved[c.consumedBy] : null;
    const consumed = !!(consumer && consumer.kind === 'boolean' &&
      Array.isArray(consumer.operandIds) && consumer.operandIds.includes(c.id));
    if (consumed) continue;
    emitComponentGds(c, [], 'solid');
  }

  writeNoData(ENDSTR);
  writeNoData(ENDLIB);

  // Concatenate all chunks into one Uint8Array.
  let total = 0;
  for (const ch of chunks) total += ch.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const ch of chunks) { out.set(ch, off); off += ch.length; }
  return out;
}
