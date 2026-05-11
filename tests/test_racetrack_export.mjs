// Test that a racetrack scene exports cleanly to pyAEDT, HFSS native, and GDS.
import { mod } from './_harness.mjs';
import { writeFileSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log(`  ok: ${msg}`);
  else { console.error(`  FAIL: ${msg}`); failures++; }
}

console.log('test_racetrack_export: setting up scene...');
const scene = mod.makeBlankScene();
scene.params.w_wg        = { expr: '1.2', unit: 'µm' };
scene.params.h_wg        = { expr: '0.6', unit: 'µm' };
scene.params.electrode_h = { expr: '0.5', unit: 'µm' };
scene.params.h_clad      = { expr: '2',   unit: 'µm' };
scene.params.rt_R        = { expr: '100', unit: 'µm' };
scene.params.rt_L        = { expr: '300', unit: 'µm' };
scene.params.rt_p        = { expr: '1',   unit: '' };
scene.components = [{
  id: 'rt1', kind: 'racetrack', layer: 'waveguide',
  cx: 0, cy: 0,
  R: 'rt_R', L_straight: 'rt_L', p: 'rt_p', wgWidth: 'w_wg',
  w: '(rt_L) + 2 * (rt_R) * (1 + 1.45 * (rt_p)) + (w_wg)',
  h: '(rt_R) * (2 + 0.754 * (rt_p)) + (w_wg)',
  cutouts: [], transforms: [], label: 'rt1',
}];
const { values } = mod.resolveParams(scene.params);

const py   = mod.generatePyAEDT(scene, values);
const hfss = mod.generateHfssNative(scene, values);
const gds  = mod.generateGDS(scene, values);

mkdirSync('tests/out', { recursive: true });
writeFileSync('tests/out/rt_pyaedt.py', py);
writeFileSync('tests/out/rt_hfss.py',   hfss);

assert(py.includes('rt1') && py.includes('create_polyline'), 'pyAEDT mentions rt1 and create_polyline');
assert(hfss.includes('rt1') && hfss.includes('rt1_hole'),    'HFSS native creates rt1 and subtracts rt1_hole');
assert(gds.byteLength > 1000,                                 `GDS is non-trivial (${gds.byteLength} bytes)`);

// Validate pyAEDT and HFSS outputs parse as Python.
console.log('test_racetrack_export: validating Python parseability...');
try {
  execSync(`python3 -c "import ast; ast.parse(open('tests/out/rt_pyaedt.py').read())"`);
  console.log('  ok: pyAEDT output parses as valid Python');
} catch (e) {
  console.error('  FAIL: pyAEDT output does NOT parse as Python');
  failures++;
}
try {
  execSync(`python3 -c "import ast; ast.parse(open('tests/out/rt_hfss.py').read())"`);
  console.log('  ok: HFSS native output parses as valid Python');
} catch (e) {
  console.error('  FAIL: HFSS native output does NOT parse as Python');
  failures++;
}

if (failures === 0) {
  console.log('\ntest_racetrack_export: ALL PASS');
  process.exit(0);
} else {
  console.error(`\ntest_racetrack_export: ${failures} FAILURE(S)`);
  process.exit(1);
}
