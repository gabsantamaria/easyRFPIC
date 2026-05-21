// Figure export (SVG + PDF) sanity tests.
import { mod } from './_harness.mjs';
import { generateSVG, generatePDF } from '../src/export/figure.js';

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log(`  ok: ${msg}`);
  else { console.error(`  FAIL: ${msg}`); failures++; }
}

console.log('test_figure: default scene export...');
const scene = mod.makeDefaultScene();
const { values } = mod.resolveParams(scene.params);

// SVG
const svg = generateSVG(scene, values, { designName: 'default' });
assert(svg.length > 200, `SVG non-trivial (${svg.length} chars)`);
assert(svg.startsWith('<?xml'), 'SVG starts with <?xml?> declaration');
assert(/viewBox="-?\d+(\.\d+)?\s+-?\d+(\.\d+)?\s+\d+(\.\d+)?\s+\d+(\.\d+)?"/.test(svg), 'SVG has a viewBox');
const polyCount = (svg.match(/<polygon\b/g) || []).length;
assert(polyCount >= 3, `SVG has ≥ 3 polygons (got ${polyCount} — expect at least 1 per visible component)`);
// Default scene has 2 conductor rects, 1 wg rect, 2 port rects
assert(/fill="#daa520"/.test(svg) || /fill="#f4a72e"/.test(svg), 'SVG includes the conductor layer color');
assert(svg.includes('xmlns="http://www.w3.org/2000/svg"'), 'SVG has proper xmlns');

// PDF
const pdf = generatePDF(scene, values, { designName: 'default' });
assert(pdf.length > 500, `PDF non-trivial (${pdf.length} bytes)`);
const head = new TextDecoder().decode(pdf.slice(0, 8));
assert(head.startsWith('%PDF-1.'), `PDF header present (got "${head.replace(/\n/g, ' ')}")`);
const tail = new TextDecoder().decode(pdf.slice(-7));
assert(tail.includes('%%EOF'), `PDF EOF marker present (got "${tail.trim()}")`);
const body = new TextDecoder().decode(pdf);
assert(body.includes('/Type /Catalog'), 'PDF has /Catalog');
assert(body.includes('/Type /Pages'), 'PDF has /Pages');
assert(body.includes('/MediaBox'), 'PDF has /MediaBox');
assert(/\d+\.\d+ \d+\.\d+ \d+\.\d+ rg/.test(body), 'PDF has fill-color (rg) ops');
assert(/\d+\.\d+ \d+\.\d+ m/.test(body), 'PDF has moveto (m) ops');
assert(/\d+\.\d+ \d+\.\d+ l/.test(body), 'PDF has lineto (l) ops');
assert(body.includes('h B'), 'PDF has close+fill+stroke (h B) ops');

if (failures === 0) {
  console.log('\ntest_figure: ALL PASS');
  process.exit(0);
} else {
  console.error(`\ntest_figure: ${failures} FAILURE(S)`);
  process.exit(1);
}
