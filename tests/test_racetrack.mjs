// Test that the racetrack centerline and ring geometry match the expected
// partial-Euler bend properties.
import { mod } from './_harness.mjs';

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log(`  ok: ${msg}`);
  else { console.error(`  FAIL: ${msg}`); failures++; }
}

console.log('test_racetrack: bend geometry...');
// For R=100, p=1, the bend exit should be at y ≈ -275.4 (numerically
// computed from the clothoid integral). For p=0 it should be exactly -200.
const bendP0 = mod.eulerBend180Centerline(100, 0, 256);
const exitP0 = bendP0[bendP0.length - 1];
assert(Math.abs(exitP0[1] + 200) < 0.1, `p=0 bend exit y = -200 (got ${exitP0[1].toFixed(3)})`);

const bendP1 = mod.eulerBend180Centerline(100, 1, 256);
const exitP1 = bendP1[bendP1.length - 1];
assert(Math.abs(exitP1[1] + 275.378) < 0.1, `p=1 bend exit y ≈ -275.378 (got ${exitP1[1].toFixed(3)})`);
assert(Math.abs(exitP1[0]) < 0.01, `p=1 bend exit x ≈ 0 by symmetry (got ${exitP1[0].toFixed(3)})`);

console.log('test_racetrack: full racetrack AABB...');
const scene = mod.makeBlankScene();
scene.params.w_wg = { expr: '1.2', unit: 'µm' };
scene.params.rt_R = { expr: '100', unit: 'µm' };
scene.params.rt_L = { expr: '300', unit: 'µm' };
scene.params.rt_p = { expr: '1',   unit: '' };
scene.components = [{
  id: 'rt1', kind: 'racetrack', layer: 'waveguide',
  cx: 0, cy: 0,
  R: 'rt_R', L_straight: 'rt_L', p: 'rt_p', wgWidth: 'w_wg',
  w: '(rt_L) + 2 * (rt_R) * (1 + 1.45 * (rt_p)) + (w_wg)',
  h: '(rt_R) * (2 + 0.754 * (rt_p)) + (w_wg)',
  cutouts: [], transforms: [], label: 'rt1',
}];
const { values } = mod.resolveParams(scene.params);
const insts = mod.expandTransforms(scene.components, values);
const rtInst = insts[0];
const ring = mod.shapeInstanceToRing(rtInst);
let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
for (const [x, y] of ring) {
  if (x < minX) minX = x; if (x > maxX) maxX = x;
  if (y < minY) minY = y; if (y > maxY) maxY = y;
}
const ringW = maxX - minX, ringH = maxY - minY;
const formulaW = values.rt_L + 2 * values.rt_R * (1 + 1.45 * values.rt_p) + values.w_wg;
const formulaH = values.rt_R * (2 + 0.754 * values.rt_p) + values.w_wg;
assert(Math.abs(ringW - formulaW) < 0.5, `actual ring W (${ringW.toFixed(2)}) matches formula (${formulaW.toFixed(2)})`);
assert(Math.abs(ringH - formulaH) < 0.5, `actual ring H (${ringH.toFixed(2)}) matches formula (${formulaH.toFixed(2)})`);

if (failures === 0) {
  console.log('\ntest_racetrack: ALL PASS');
  process.exit(0);
} else {
  console.error(`\ntest_racetrack: ${failures} FAILURE(S)`);
  process.exit(1);
}
