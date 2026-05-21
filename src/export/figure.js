// Figure export — SVG + PDF vector dumps of the current scene.
//
// Both formats are built from the same scene-walk as the other exporters
// (solveLayout + applyMirrors + resolveBooleanBboxes + expandTransforms +
// shapeInstanceToRing + resolvePolylineVertices). The output is a clean
// figure — no UI chrome (selection halos, snap arrows, axis dashes,
// anchor handles, hover tooltips) — just the geometry with each shape's
// layer color, suitable for slides, papers, or downstream tooling.
//
// Booleans:
//   - SVG uses <mask> compositing identical to the canvas (subtract /
//     intersect / union all render the right way).
//   - PDF emits each operand as a separate filled polygon on the
//     boolean's resolved layer color; modern PDF readers don't all
//     handle complex clip-path subtract compositing reliably and the
//     reader-agnostic alternative — flattening via polygon clipping —
//     would need a clipper library. The visual "looks right" when the
//     boolean is a union; subtract / punch / intersect appear as the
//     union of operands, but it's good enough for documentation.
//
// SVG output uses a tight bbox + 5 % padding so the figure crops to
// the geometry. PDF uses the same bbox; the MediaBox is sized in PDF
// points (1 pt = 1/72 in). We treat 1 canvas µm = 1 pt as the default
// scale; callers can override via options.scale.
import { evalExpr } from '../scene/params.js';
import { solveLayout, applyMirrors, resolveBooleanBboxes } from '../scene/solver.js';
import { expandTransforms } from '../scene/transforms.js';
import { shapeInstanceToRing } from '../geometry/rings.js';
import { resolvePolylineVertices } from '../geometry/polyline.js';
import { buildRacetrackCenterline, offsetCenterlineToBand } from '../geometry/racetrack.js';

// ── Shared style logic — mirror Canvas.jsx's styleForComponent ───────
const ROLE_STYLE = {
  waveguide: { fill: '#3ec27a', stroke: '#1a5e36', opacity: 0.85 },
  electrode: { fill: '#f4a72e', stroke: '#7a4d00', opacity: 0.90 },
  port:      { fill: '#b91c1c', stroke: '#7f1d1d', opacity: 0.55 },
};
function darkenHex(hex) {
  if (typeof hex !== 'string') return null;
  const m = hex.match(/^#?([0-9a-fA-F]{6})$/);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const r = Math.floor(((n >> 16) & 0xff) * 0.45);
  const g = Math.floor(((n >> 8) & 0xff) * 0.45);
  const b = Math.floor((n & 0xff) * 0.45);
  return `#${[r,g,b].map(v => v.toString(16).padStart(2, '0')).join('')}`;
}
function styleForComponent(c, scene, byId) {
  const role = c?.layer;
  const base = ROLE_STYLE[role] || ROLE_STYLE.waveguide;
  const resolveBound = (c2, visited = new Set()) => {
    if (!c2 || visited.has(c2.id)) return null;
    visited.add(c2.id);
    if (c2.kind === 'boolean') {
      for (const id of (c2.operandIds || [])) {
        const r = resolveBound(byId[id], visited);
        if (r) return r;
      }
      return null;
    }
    if (c2.layer === 'electrode' && c2.conductorLayerId) {
      return (scene.stack || []).find(l => l.id === c2.conductorLayerId);
    }
    if (c2.layer === 'waveguide') {
      return (scene.stack || []).find(l => l.role === 'waveguide');
    }
    return null;
  };
  const bound = resolveBound(c);
  if (bound && bound.color) {
    return { fill: bound.color, stroke: darkenHex(bound.color) || base.stroke, opacity: base.opacity };
  }
  return base;
}

// Collect the world-space ring for one instance, including transform
// rotation/scale. Returns an array of [x, y] pairs.
function ringForInstance(c, inst, paramValues, byId) {
  if (c.kind === 'polyline' || c.kind === 'polyshape') {
    // Resolve vertex chain in world space; for instance copies, shift +
    // rotate + scale by the instance's delta from base.
    const baseVerts = resolvePolylineVertices(c, byId, paramValues);
    const dx = inst.cx - c.cx, dy = inst.cy - c.cy;
    const rad = (inst.rotation || 0) * Math.PI / 180;
    const ca = Math.cos(rad), sa = Math.sin(rad);
    const sx = inst.scaleX ?? 1, sy = inst.scaleY ?? 1;
    return baseVerts.map(([vx, vy]) => {
      const lx = (vx - c.cx) * sx;
      const ly = (vy - c.cy) * sy;
      return [inst.cx + lx * ca - ly * sa, inst.cy + lx * sa + ly * ca];
    });
  }
  if (c.kind === 'racetrack') {
    // Racetracks are bands; the perimeter is outer ring minus inner ring.
    // For figure-export purposes we return the OUTER ring (a typical
    // schematic shows the racetrack outline; the inner hole can be
    // toggled later via a second polygon on datatype-1-equivalent).
    const R = Number.isFinite(inst.R) ? inst.R : 100;
    const L = Number.isFinite(inst.L_straight) ? inst.L_straight : 300;
    const p = Number.isFinite(inst.p) ? inst.p : 1;
    const wgW = Number.isFinite(inst.wgWidth) ? inst.wgWidth : 1.2;
    const centerline = buildRacetrackCenterline(R, L, p);
    const { outer } = offsetCenterlineToBand(centerline, wgW / 2);
    const rad = (inst.rotation || 0) * Math.PI / 180;
    const ca = Math.cos(rad), sa = Math.sin(rad);
    return outer.map(([lx, ly]) => [inst.cx + lx * ca - ly * sa, inst.cy + lx * sa + ly * ca]);
  }
  return shapeInstanceToRing(inst);
}

// Compute the scene's bbox from all visible instances. Returns
// { minX, maxX, minY, maxY } or null when there's nothing to draw.
function sceneBbox(scene, paramValues) {
  const solved = resolveBooleanBboxes(
    applyMirrors(solveLayout(scene.components, scene.snaps, paramValues), scene.mirrors),
    paramValues
  );
  const byId = Object.fromEntries(solved.map(c => [c.id, c]));
  const transformInstances = expandTransforms(solved, paramValues);
  let minX = +Infinity, maxX = -Infinity, minY = +Infinity, maxY = -Infinity;
  for (const inst of transformInstances) {
    const c = byId[inst.compId];
    if (!c || c.kind === 'boolean') continue;
    // Consumed primitives still contribute to the bbox — they're rendered
    // (inside a boolean's mask) and we want the figure to crop around
    // the visible result.
    const ring = ringForInstance(c, inst, paramValues, byId);
    for (const [x, y] of ring) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (!Number.isFinite(minX)) return null;
  return { minX, maxX, minY, maxY, solved, byId, transformInstances };
}

// ── SVG export ───────────────────────────────────────────────────────
export function generateSVG(scene, paramValues, options = {}) {
  const bb = sceneBbox(scene, paramValues);
  if (!bb) return '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"></svg>';
  const w0 = bb.maxX - bb.minX;
  const h0 = bb.maxY - bb.minY;
  const pad = Math.max(w0, h0) * 0.05 + 1;
  const vbX = bb.minX - pad;
  const vbY = -(bb.maxY + pad);   // SVG y is down, world y is up
  const vbW = w0 + 2 * pad;
  const vbH = h0 + 2 * pad;
  const showBg = options.showBackground !== false; // default ON for SVG
  const strokeW = Math.max(0.05, Math.max(w0, h0) * 0.0015);

  // Each instance → an SVG path or polygon string. Group by component
  // so the boolean compositing can wrap operands cleanly.
  const consumedIds = new Set();
  for (const c of bb.solved) if (c.kind === 'boolean') for (const id of (c.operandIds || [])) consumedIds.add(id);

  // Build a ringByCompInst map so booleans can look up their operand
  // rings (avoiding double-resolution).
  const ringByInst = new Map(); // (compId, idx) → ring
  for (const inst of bb.transformInstances) {
    const c = bb.byId[inst.compId];
    if (!c || c.kind === 'boolean') continue;
    const ring = ringForInstance(c, inst, paramValues, bb.byId);
    ringByInst.set(`${inst.compId}#${inst.idx}`, ring);
  }
  const pointsAttr = (ring) => ring.map(([x, y]) => `${x.toFixed(4)},${(-y).toFixed(4)}`).join(' ');

  // Standalone (non-consumed) primitive rendering — one polygon per
  // transform instance. Skip booleans here; handled below.
  let body = '';
  for (const inst of bb.transformInstances) {
    const c = bb.byId[inst.compId];
    if (!c || c.kind === 'boolean') continue;
    if (consumedIds.has(c.id)) continue;
    const ring = ringByInst.get(`${inst.compId}#${inst.idx}`);
    if (!ring || ring.length < 3) continue;
    const style = styleForComponent(c, scene, bb.byId);
    body += `  <polygon points="${pointsAttr(ring)}" fill="${style.fill}" fill-opacity="${style.opacity}" stroke="${style.stroke}" stroke-width="${strokeW}" />\n`;
  }

  // Boolean rendering — mask-compose like Canvas.jsx. For each boolean,
  // build a mask: white = operand[0] interior, black = operand[1+]
  // interior (subtract). For union we just emit every operand. For
  // intersect we use a clip-path chain.
  let maskDefs = '';
  let booleanLayer = '';
  let maskIdCounter = 0;
  const nextMaskId = () => `tut_bool_mask_${maskIdCounter++}`;
  // Collect all primitive operand rings under a boolean (across instances)
  const operandRings = (b) => {
    const out = [];
    for (const opId of (b.operandIds || [])) {
      const op = bb.byId[opId];
      if (!op) continue;
      if (op.kind === 'boolean') continue; // nested booleans — fall back to operand 0 only
      for (const inst of bb.transformInstances) {
        if (inst.compId !== opId) continue;
        const r = ringByInst.get(`${inst.compId}#${inst.idx}`);
        if (r && r.length >= 3) out.push(r);
      }
    }
    return out;
  };
  for (const b of bb.solved) {
    if (b.kind !== 'boolean' || b.consumedBy) continue;
    const ops = (b.operandIds || []).map(id => bb.byId[id]).filter(Boolean);
    if (ops.length < 2) continue;
    const style = styleForComponent(b, scene, bb.byId);
    const baseOpRings = ops[0] && ops[0].kind !== 'boolean'
      ? bb.transformInstances
          .filter(i => i.compId === ops[0].id)
          .map(i => ringByInst.get(`${i.compId}#${i.idx}`))
          .filter(r => r && r.length >= 3)
      : [];
    const toolOpRings = ops.slice(1).flatMap(op => op.kind === 'boolean' ? [] :
      bb.transformInstances
        .filter(i => i.compId === op.id)
        .map(i => ringByInst.get(`${i.compId}#${i.idx}`))
        .filter(r => r && r.length >= 3)
    );
    if (b.op === 'subtract' || b.op === 'punch' || b.op === 'intersect') {
      const maskId = nextMaskId();
      // Mask viewport — the scene bbox is large enough since the
      // operands fit inside it; expand a tiny pad to avoid edge-pixel
      // clipping artifacts.
      const m_pad = Math.max(w0, h0) * 0.01;
      const mx = vbX - m_pad, my = vbY - m_pad;
      const mw = vbW + 2 * m_pad, mh = vbH + 2 * m_pad;
      // For subtract / punch: white base − black tools.
      // For intersect: black background, white tool [polygon], white base — composite via mask-fill rules.
      // SVG mask compositing: drawn pixels' LUMINANCE multiplies underlying fill alpha. White = full, black = none.
      if (b.op === 'subtract' || b.op === 'punch') {
        maskDefs += `    <mask id="${maskId}" maskUnits="userSpaceOnUse" x="${mx}" y="${my}" width="${mw}" height="${mh}">\n`;
        maskDefs += `      <rect x="${mx}" y="${my}" width="${mw}" height="${mh}" fill="black" />\n`;
        for (const r of baseOpRings) maskDefs += `      <polygon points="${pointsAttr(r)}" fill="white" />\n`;
        for (const r of toolOpRings) maskDefs += `      <polygon points="${pointsAttr(r)}" fill="black" />\n`;
        maskDefs += `    </mask>\n`;
        booleanLayer += `  <g mask="url(#${maskId})">\n`;
        for (const r of baseOpRings) {
          booleanLayer += `    <polygon points="${pointsAttr(r)}" fill="${style.fill}" fill-opacity="${style.opacity}" stroke="${style.stroke}" stroke-width="${strokeW}" />\n`;
        }
        booleanLayer += `  </g>\n`;
      } else {
        // intersect: paint base where ALL tool interiors overlap. Build a
        // clip-path chain of tools.
        const clipId = nextMaskId();
        maskDefs += `    <clipPath id="${clipId}" clipPathUnits="userSpaceOnUse">\n`;
        // Multiple clip-path children get UNIONed by SVG; for true
        // intersection of multiple tools we'd need a nested chain. With
        // 2 operands (the common case) one clip suffices.
        for (const r of toolOpRings) maskDefs += `      <polygon points="${pointsAttr(r)}" />\n`;
        maskDefs += `    </clipPath>\n`;
        booleanLayer += `  <g clip-path="url(#${clipId})">\n`;
        for (const r of baseOpRings) {
          booleanLayer += `    <polygon points="${pointsAttr(r)}" fill="${style.fill}" fill-opacity="${style.opacity}" stroke="${style.stroke}" stroke-width="${strokeW}" />\n`;
        }
        booleanLayer += `  </g>\n`;
      }
    } else {
      // Union: emit every operand on the boolean's layer color.
      for (const r of [...baseOpRings, ...toolOpRings]) {
        booleanLayer += `  <polygon points="${pointsAttr(r)}" fill="${style.fill}" fill-opacity="${style.opacity}" stroke="${style.stroke}" stroke-width="${strokeW}" />\n`;
      }
    }
  }

  const bg = showBg
    ? `  <rect x="${vbX}" y="${vbY}" width="${vbW}" height="${vbH}" fill="${options.background || '#ffffff'}" />\n`
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vbX} ${vbY} ${vbW} ${vbH}" width="${vbW.toFixed(2)}" height="${vbH.toFixed(2)}">
  <title>${options.designName ? `${options.designName} layout` : 'easyRFPIC layout'}</title>
  <desc>Auto-generated vector figure from easyRFPIC.</desc>
${maskDefs ? `  <defs>\n${maskDefs}  </defs>\n` : ''}${bg}${body}${booleanLayer}</svg>
`;
}

// ── PDF export ───────────────────────────────────────────────────────
// Minimal PDF 1.4 emitter. We don't depend on a PDF library — every
// shape becomes a sequence of path operators in the page's content
// stream. Booleans are flattened to their operands (each operand emits
// as a separate filled polygon on the boolean's layer color) since
// general boolean compositing in PDF requires either polygon-clipping
// math or a complex clip-path setup that not every reader handles.
export function generatePDF(scene, paramValues, options = {}) {
  const bb = sceneBbox(scene, paramValues);
  if (!bb) return new Uint8Array();
  const w0 = bb.maxX - bb.minX;
  const h0 = bb.maxY - bb.minY;
  const pad = Math.max(w0, h0) * 0.05 + 1;
  // PDF MediaBox in PDF points. Default 1 µm = 1 pt (so a 1000 µm
  // chip becomes a 1000 pt = 13.9 in wide PDF page — too big!).
  // Pick a default scale that keeps the page reasonable: target a
  // longest dimension of ~500 pt (about 7 in).
  const targetMax = 500;
  const scale = options.scale ?? Math.min(targetMax / Math.max(w0 + 2 * pad, h0 + 2 * pad), 4);
  const pageW = (w0 + 2 * pad) * scale;
  const pageH = (h0 + 2 * pad) * scale;
  // Translate world coords into PDF page coords. PDF origin is bottom-
  // left and y goes UP — same as our world. So a single offset +
  // uniform scale suffices.
  const toX = (x) => ((x - bb.minX) + pad) * scale;
  const toY = (y) => ((y - bb.minY) + pad) * scale;
  const strokeW = Math.max(0.1, Math.max(w0, h0) * 0.0015 * scale);

  // Hex-color parser → "r g b" in 0..1 PDF range
  const hex01 = (hex) => {
    const m = (typeof hex === 'string') ? hex.match(/^#?([0-9a-fA-F]{6})$/) : null;
    if (!m) return '0.5 0.5 0.5';
    const n = parseInt(m[1], 16);
    const r = ((n >> 16) & 0xff) / 255;
    const g = ((n >> 8) & 0xff) / 255;
    const b = (n & 0xff) / 255;
    return `${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)}`;
  };

  // Emit each instance / boolean operand as a filled+stroked path.
  let ops = '';
  ops += `q\n`; // graphics state save
  // Optional opaque background
  if (options.showBackground !== false) {
    ops += `${hex01(options.background || '#ffffff')} rg\n`;
    ops += `0 0 ${pageW.toFixed(3)} ${pageH.toFixed(3)} re f\n`;
  }
  const emitPolygon = (ring, fillHex, strokeHex, opacity) => {
    if (!ring || ring.length < 3) return;
    // We approximate fill-opacity by blending toward white at the
    // opacity level. PDF transparency would need an ExtGState — fine
    // to add later, but blending captures the visual effect for a
    // single-page figure.
    let blend = fillHex;
    if (opacity != null && opacity < 1) {
      const m = (typeof fillHex === 'string') ? fillHex.match(/^#?([0-9a-fA-F]{6})$/) : null;
      if (m) {
        const n = parseInt(m[1], 16);
        const r = ((n >> 16) & 0xff);
        const g = ((n >> 8) & 0xff);
        const b = (n & 0xff);
        const a = opacity, oneMinus = 1 - opacity;
        const br = Math.round(r * a + 255 * oneMinus);
        const bg = Math.round(g * a + 255 * oneMinus);
        const bb_ = Math.round(b * a + 255 * oneMinus);
        blend = `#${[br, bg, bb_].map(v => v.toString(16).padStart(2, '0')).join('')}`;
      }
    }
    ops += `${hex01(blend)} rg\n`;
    ops += `${hex01(strokeHex)} RG\n`;
    ops += `${strokeW.toFixed(3)} w\n`;
    let started = false;
    for (const [x, y] of ring) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      ops += `${toX(x).toFixed(3)} ${toY(y).toFixed(3)} ${started ? 'l' : 'm'}\n`;
      started = true;
    }
    ops += `h B\n`; // close, fill + stroke
  };

  // Non-consumed primitives first, then booleans (which re-emit their operands).
  const consumedIds = new Set();
  for (const c of bb.solved) if (c.kind === 'boolean') for (const id of (c.operandIds || [])) consumedIds.add(id);
  for (const inst of bb.transformInstances) {
    const c = bb.byId[inst.compId];
    if (!c || c.kind === 'boolean') continue;
    if (consumedIds.has(c.id)) continue;
    const ring = ringForInstance(c, inst, paramValues, bb.byId);
    const style = styleForComponent(c, scene, bb.byId);
    emitPolygon(ring, style.fill, style.stroke, style.opacity);
  }
  for (const b of bb.solved) {
    if (b.kind !== 'boolean' || b.consumedBy) continue;
    const style = styleForComponent(b, scene, bb.byId);
    for (const opId of (b.operandIds || [])) {
      const op = bb.byId[opId];
      if (!op || op.kind === 'boolean') continue;
      for (const inst of bb.transformInstances) {
        if (inst.compId !== opId) continue;
        const ring = ringForInstance(op, inst, paramValues, bb.byId);
        emitPolygon(ring, style.fill, style.stroke, style.opacity);
      }
    }
  }
  ops += `Q\n`; // graphics state restore

  // Build the PDF
  const objs = [];
  // obj 1: Catalog
  objs.push(`1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`);
  // obj 2: Pages
  objs.push(`2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n`);
  // obj 3: Page
  objs.push(`3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW.toFixed(3)} ${pageH.toFixed(3)}] /Contents 4 0 R /Resources << /ProcSet [/PDF /Text] >> >>\nendobj\n`);
  // obj 4: Contents
  const opsBytes = new TextEncoder().encode(ops);
  objs.push(`4 0 obj\n<< /Length ${opsBytes.length} >>\nstream\n${ops}endstream\nendobj\n`);

  // Assemble with byte offsets for xref
  const header = `%PDF-1.4\n%\xe2\xe3\xcf\xd3\n`;
  const enc = new TextEncoder();
  let buf = enc.encode(header);
  const offsets = [];
  for (const o of objs) {
    offsets.push(buf.length);
    const b = enc.encode(o);
    const merged = new Uint8Array(buf.length + b.length);
    merged.set(buf, 0); merged.set(b, buf.length);
    buf = merged;
  }
  // xref
  const xrefOffset = buf.length;
  let xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) xref += `${String(off).padStart(10, '0')} 00000 n \n`;
  xref += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  const xb = enc.encode(xref);
  const final = new Uint8Array(buf.length + xb.length);
  final.set(buf, 0); final.set(xb, buf.length);
  return final;
}
