// Test that the four non-rect shapes (circle, ellipse, polygon, racetrack)
// produce sane rings, propagate shape fields through expandTransforms, and
// export cleanly to pyAEDT / HFSS native / GDS.
import { mod } from './_harness.mjs';

let failures = 0;
function assert(cond, msg) {
  if (cond) {
    console.log(`  ok: ${msg}`);
  } else {
    console.error(`  FAIL: ${msg}`);
    failures++;
  }
}

console.log('test_shapes: building scene with circle, ellipse, polygon...');
let scene = mod.makeBlankScene();
scene.params.r_circ = { expr: '10', unit: 'µm' };
scene.params.rx_ell = { expr: '15', unit: 'µm' };
scene.params.ry_ell = { expr: '8', unit: 'µm' };
scene.params.r_poly = { expr: '12', unit: 'µm' };
scene.params.n_poly = { expr: '6', unit: '' };
scene.components = [
  { id: 'circ1', kind: 'circle',  layer: 'electrode',
    cx: 0,   cy: 0, r: 'r_circ',  w: '2*r_circ',  h: '2*r_circ',
    cutouts: [], transforms: [], label: 'c1' },
  { id: 'ell1',  kind: 'ellipse', layer: 'electrode',
    cx: 50,  cy: 0, rx: 'rx_ell', ry: 'ry_ell', w: '2*rx_ell', h: '2*ry_ell',
    cutouts: [], transforms: [], label: 'e1' },
  { id: 'hex1',  kind: 'polygon', layer: 'electrode',
    cx: 100, cy: 0, r: 'r_poly',  n: 'n_poly',  w: '2*r_poly',  h: '2*r_poly',
    cutouts: [], transforms: [], label: 'h1' },
];

const { values } = mod.resolveParams(scene.params);

console.log('expandTransforms propagates shape fields...');
const insts = mod.expandTransforms(scene.components, values);
const circInst = insts.find(i => i.compId === 'circ1');
const ellInst  = insts.find(i => i.compId === 'ell1');
const hexInst  = insts.find(i => i.compId === 'hex1');
assert(circInst && circInst.r === 10,                      'circle r propagates (=10)');
assert(ellInst  && ellInst.rx === 15 && ellInst.ry === 8, 'ellipse rx/ry propagate (=15, =8)');
assert(hexInst  && hexInst.r === 12 && hexInst.n === 6,   'hexagon r/n propagate (=12, =6)');

console.log('shapeInstanceToRing produces sensible rings...');
const circRing = mod.shapeInstanceToRing(circInst);
const ellRing  = mod.shapeInstanceToRing(ellInst);
const hexRing  = mod.shapeInstanceToRing(hexInst);
assert(circRing.length === 64, `circle ring has 64 vertices (got ${circRing.length})`);
assert(ellRing.length === 64,  `ellipse ring has 64 vertices (got ${ellRing.length})`);
assert(hexRing.length === 6,   `hexagon ring has 6 vertices (got ${hexRing.length})`);

// Sanity: circle ring should lie on the circle of radius 10 around (0, 0).
const circMaxDev = Math.max(...circRing.map(([x, y]) => Math.abs(Math.hypot(x, y) - 10)));
assert(circMaxDev < 0.01, `circle ring vertices lie on r=10 circle (max dev=${circMaxDev.toFixed(4)}µm)`);

console.log('Exports succeed and produce non-trivial output...');
const py   = mod.generatePyAEDT(scene, values);
const hfss = mod.generateHfssNative(scene, values);
const gds  = mod.generateGDS(scene, values);
assert(py.includes('create_cylinder') && py.includes('circ1'),  'pyAEDT includes create_cylinder for circle');
assert(py.includes('create_ellipse')  && py.includes('ell1'),   'pyAEDT includes create_ellipse for ellipse');
assert(py.includes('create_polyline') && py.includes('hex1'),   'pyAEDT includes create_polyline for hexagon');
assert(hfss.includes('CreatePolyline'),                          'HFSS native uses CreatePolyline for non-rect shapes');
assert(gds.byteLength > 100,                                     `GDS file is non-trivial (${gds.byteLength} bytes)`);

if (failures === 0) {
  console.log('\ntest_shapes: ALL PASS');
  process.exit(0);
} else {
  console.error(`\ntest_shapes: ${failures} FAILURE(S)`);
  process.exit(1);
}
