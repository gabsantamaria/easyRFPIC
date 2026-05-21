// Figure export — SVG + PDF dumps of the LIVE canvas SVG element.
//
// Earlier this module re-walked the scene programmatically to build a
// "clean" figure, but that approach silently dropped overlays the user
// expected to see (dimensions toggle, ruler measurements, mirror axes,
// snap arrows, etc.) and was missing the per-instance polish (selection
// halos, layer-stack color tints) of the live render. The user is the
// arbiter of "what should be in the figure": whatever they see on the
// canvas is what should appear in the export. So we clone the live
// <svg> element, strip a tiny set of transient interactive overlays
// (drag previews, marquee rects, in-progress polyline drafts), crop
// the viewBox tightly to the rendered content via getBBox(), and
// serialize / rasterize from there.
//
//   - generateSvgFromElement(svgEl, options) → string
//   - generatePdfFromElement(svgEl, options) → Promise<Uint8Array>
//
// PDF: we render the cleaned SVG to a high-DPI <canvas> via Image +
// drawImage, then embed the resulting JPEG inside a minimal PDF 1.4
// document as a single full-page /XObject Image. Visually this matches
// the canvas EXACTLY (since the browser does the rendering); the
// trade-off is that the PDF is raster, not vector. For vector PDF the
// user can take the SVG export through Inkscape / Illustrator.

// Elements with `data-no-export="true"` are stripped from the cloned
// SVG before serialization. Use this attribute on transient UI overlays
// (drag previews, marquee rects, etc.) so they don't bleed into figures.
const STRIP_ATTR = 'data-no-export';

// Selectors for elements that should ALSO be stripped even without the
// data-attribute. The user expects the figure to mirror what they see,
// so by default we strip NOTHING — every visible element passes through.
// Add specific selectors here if a transient overlay leaks into figures.
const STRIP_SELECTORS = [];

function cloneSvgForExport(svgEl, options = {}) {
  if (!svgEl || typeof svgEl.cloneNode !== 'function') {
    throw new Error('cloneSvgForExport: missing SVG element');
  }
  const cloned = svgEl.cloneNode(true);
  // Strip explicit no-export-marked elements.
  for (const el of Array.from(cloned.querySelectorAll(`[${STRIP_ATTR}]`))) {
    el.parentNode?.removeChild(el);
  }
  // Plus the defensive selectors above.
  for (const sel of STRIP_SELECTORS) {
    for (const el of Array.from(cloned.querySelectorAll(sel))) {
      el.parentNode?.removeChild(el);
    }
  }
  // Boolean rendering in the canvas creates many <defs><mask>…</mask></defs>
  // wrappers nested INSIDE the rendered <g> trees (one per boolean
  // instance × op). Per spec <defs> children are non-rendering wherever
  // <defs> appears, but at least one renderer downstream (Chromium when
  // an SVG with nested <defs> is loaded as <img src=blob>) leaks
  // <mask>'s background rect through as a regular paint — first as a
  // black phantom (from subtract masks' fill="black" bg), then as a
  // white phantom (from union-outline masks' fill="white" bg) once the
  // black ones were stripped. Both cases share the same root cause:
  // the cloned <mask> isn't being honored as non-rendering content.
  //
  // The fix: hoist EVERY <mask> and <clipPath> in the cloned tree into
  // a single root-level <defs> block. id="…" references work globally
  // across the SVG so this re-parenting doesn't break the
  // mask="url(#m1)" references in the masked <g> elements. Renderers
  // that respect root-<defs> as non-rendering (every one we've tested)
  // now hide all mask content reliably, eliminating both phantoms.
  //
  // Empty nested <defs> wrappers are dropped afterward so the tree
  // doesn't carry dangling orphan elements.
  const ns = 'http://www.w3.org/2000/svg';
  let rootDefs = cloned.querySelector(':scope > defs');
  if (!rootDefs) {
    rootDefs = document.createElementNS(ns, 'defs');
    cloned.insertBefore(rootDefs, cloned.firstChild);
  }
  for (const m of Array.from(cloned.querySelectorAll('mask, clipPath'))) {
    if (m.parentNode === rootDefs) continue;
    m.parentNode?.removeChild(m);
    rootDefs.appendChild(m);
  }
  // Drop now-empty <defs> elements (other than the root one).
  for (const d of Array.from(cloned.querySelectorAll('defs'))) {
    if (d === rootDefs) continue;
    if (d.children.length === 0) d.parentNode?.removeChild(d);
  }
  // Drop any inline width / height + style background so the export
  // sizes itself purely by the computed viewBox below.
  cloned.removeAttribute('width');
  cloned.removeAttribute('height');
  cloned.removeAttribute('style');
  cloned.removeAttribute('class');
  cloned.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  if (!cloned.getAttribute('xmlns:xlink')) {
    cloned.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
  }
  return cloned;
}

// Temporarily attach the cloned SVG to a hidden div so the browser can
// compute element bboxes. We need getBBox() because the viewBox of the
// live canvas reflects the user's zoom level — not necessarily a tight
// crop around the content.
function computeContentBbox(cloned) {
  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;left:-99999px;top:-99999px;visibility:hidden;width:1px;height:1px;overflow:hidden';
  // We need to set a SIZED viewBox so the SVG renders during getBBox.
  // The original viewBox is fine for this — getBBox returns local-coord
  // bounds, not screen-pixel bounds, so it's viewBox-independent.
  document.body.appendChild(host);
  host.appendChild(cloned);
  let bb;
  try {
    bb = cloned.getBBox();
  } finally {
    document.body.removeChild(host);
  }
  return bb;
}

// Wrap the cloned SVG with a tight viewBox + optional white background
// rect. Returns the same cloned element with attributes set.
function fitViewBoxAndBackground(cloned, bb, options) {
  const pad = Math.max(bb.width, bb.height) * 0.05 + 1;
  const vbX = bb.x - pad, vbY = bb.y - pad;
  const vbW = bb.width + 2 * pad;
  const vbH = bb.height + 2 * pad;
  cloned.setAttribute('viewBox', `${vbX} ${vbY} ${vbW} ${vbH}`);
  cloned.setAttribute('width', vbW.toFixed(3));
  cloned.setAttribute('height', vbH.toFixed(3));
  // Opaque background that matches the live canvas (Tailwind slate-100,
  // #f1f5f9). The live <svg> sets this via CSS `style.background` —
  // which doesn't survive cloneNode/serialize, so we inject an explicit
  // background <rect> sized to the new viewBox. Override via
  // options.background; pass null to keep transparent.
  if (options.background !== null) {
    const ns = 'http://www.w3.org/2000/svg';
    const bg = document.createElementNS(ns, 'rect');
    bg.setAttribute('x', vbX);
    bg.setAttribute('y', vbY);
    bg.setAttribute('width', vbW);
    bg.setAttribute('height', vbH);
    bg.setAttribute('fill', options.background || '#f1f5f9');
    cloned.insertBefore(bg, cloned.firstChild);
  }
  return { vbX, vbY, vbW, vbH };
}

// ── SVG export ───────────────────────────────────────────────────────
export function generateSvgFromElement(svgEl, options = {}) {
  const cloned = cloneSvgForExport(svgEl, options);
  const bb = computeContentBbox(cloned);
  if (!isFinite(bb.x) || bb.width <= 0 || bb.height <= 0) {
    // Empty canvas — return a tiny placeholder.
    return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"></svg>\n`;
  }
  fitViewBoxAndBackground(cloned, bb, options);
  // Title / desc metadata — useful when the file is opened in editors.
  const ns = 'http://www.w3.org/2000/svg';
  const title = document.createElementNS(ns, 'title');
  title.textContent = options.designName ? `${options.designName} layout` : 'easyRFPIC layout';
  const desc = document.createElementNS(ns, 'desc');
  desc.textContent = 'Auto-generated vector figure from easyRFPIC.';
  cloned.insertBefore(desc, cloned.firstChild);
  cloned.insertBefore(title, cloned.firstChild);
  const ser = new XMLSerializer().serializeToString(cloned);
  return `<?xml version="1.0" encoding="UTF-8"?>\n${ser}\n`;
}

// ── PDF export ───────────────────────────────────────────────────────
// Renders the cleaned SVG to a high-DPI offscreen canvas, then embeds
// the resulting JPEG bytes as a single Image XObject in a minimal PDF
// 1.4 document. Returns a Promise<Uint8Array> because the Image load
// is async.
export async function generatePdfFromElement(svgEl, options = {}) {
  const cloned = cloneSvgForExport(svgEl, options);
  const bb = computeContentBbox(cloned);
  if (!isFinite(bb.x) || bb.width <= 0 || bb.height <= 0) {
    // Empty page (1×1 pt) so the PDF still opens.
    return buildPdfWithEmptyPage();
  }
  const { vbW, vbH } = fitViewBoxAndBackground(cloned, bb, options);
  const ser = new XMLSerializer().serializeToString(cloned);
  const svgBlob = new Blob(['<?xml version="1.0"?>\n', ser], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(svgBlob);
  let jpegBytes;
  try {
    // Load the SVG as an <img> so the browser renders it. The image's
    // intrinsic size matches the viewBox dimensions we just set.
    const img = await loadImage(url);
    // Rasterize at the requested DPI (default 300 — magazine-quality).
    const dpi = options.dpi || 300;
    const scale = dpi / 72;            // 1 pt = 1/72 in; multiply for px
    const cw = Math.max(1, Math.round(vbW * scale));
    const ch = Math.max(1, Math.round(vbH * scale));
    const canvas = document.createElement('canvas');
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext('2d');
    // Canvas-matching underlay so any transparent SVG region renders
    // as the live canvas tint (Tailwind slate-100 = #f1f5f9).
    ctx.fillStyle = options.background || '#f1f5f9';
    ctx.fillRect(0, 0, cw, ch);
    ctx.drawImage(img, 0, 0, cw, ch);
    // JPEG quality 0.92 — visually indistinguishable from PNG for most
    // figures and ~3-5× smaller. The PDF Image XObject uses /DCTDecode
    // (= JPEG) which is natively supported by every PDF reader.
    const jpegDataUrl = canvas.toDataURL('image/jpeg', options.jpegQuality ?? 0.92);
    jpegBytes = base64ToBytes(jpegDataUrl.split(',', 2)[1]);
    return buildPdfWithJpegImage(jpegBytes, cw, ch, vbW, vbH);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = (e) => reject(new Error('SVG → Image load failed: ' + (e?.message || e)));
    img.src = src;
  });
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ── Minimal PDF emitter (image-only page) ───────────────────────────
// PDF 1.4. The page has one Image XObject (`Im0`) drawn at the page's
// full extent via a `cm` scaling matrix. Image is JPEG (DCTDecode).
function buildPdfWithJpegImage(jpegBytes, imgPxW, imgPxH, pageWpt, pageHpt) {
  // Cap the longest page dimension at 540 pt (~7.5 in) so the PDF
  // doesn't open absurdly large. Maintains aspect ratio.
  const TARGET = 540;
  const longest = Math.max(pageWpt, pageHpt);
  const scale = longest > TARGET ? TARGET / longest : 1;
  const pW = pageWpt * scale;
  const pH = pageHpt * scale;

  const enc = new TextEncoder();
  const parts = [];
  const offsets = [];
  let cursor = 0;
  const push = (data) => {
    const bytes = (data instanceof Uint8Array) ? data : enc.encode(data);
    parts.push(bytes);
    cursor += bytes.length;
  };
  const startObj = (n) => {
    offsets[n] = cursor;
    push(`${n} 0 obj\n`);
  };
  const endObj = () => push(`endobj\n`);

  // Header
  push('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n');

  // 1: Catalog
  startObj(1);
  push('<< /Type /Catalog /Pages 2 0 R >>\n');
  endObj();
  // 2: Pages
  startObj(2);
  push('<< /Type /Pages /Kids [3 0 R] /Count 1 >>\n');
  endObj();
  // 3: Page
  startObj(3);
  push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pW.toFixed(3)} ${pH.toFixed(3)}] /Contents 4 0 R /Resources << /XObject << /Im0 5 0 R >> /ProcSet [/PDF /ImageC] >> >>\n`);
  endObj();
  // 4: Page content stream — draw Im0 at full page size
  const cs = `q\n${pW.toFixed(3)} 0 0 ${pH.toFixed(3)} 0 0 cm\n/Im0 Do\nQ\n`;
  const csBytes = enc.encode(cs);
  startObj(4);
  push(`<< /Length ${csBytes.length} >>\nstream\n`);
  push(csBytes);
  push('\nendstream\n');
  endObj();
  // 5: Image XObject (JPEG)
  startObj(5);
  push(`<< /Type /XObject /Subtype /Image /Width ${imgPxW} /Height ${imgPxH} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpegBytes.length} >>\nstream\n`);
  push(jpegBytes);
  push('\nendstream\n');
  endObj();

  // xref
  const xrefOffset = cursor;
  let xref = `xref\n0 6\n0000000000 65535 f \n`;
  for (let i = 1; i <= 5; i++) {
    xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  xref += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  push(xref);

  // Concatenate
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

function buildPdfWithEmptyPage() {
  // A degenerate-but-valid empty PDF for the no-content case.
  const enc = new TextEncoder();
  const body = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1 1] /Resources << >> >>
endobj
xref
0 4
0000000000 65535 f
0000000009 00000 n
0000000056 00000 n
0000000103 00000 n
trailer
<< /Size 4 /Root 1 0 R >>
startxref
170
%%EOF
`;
  return enc.encode(body);
}
