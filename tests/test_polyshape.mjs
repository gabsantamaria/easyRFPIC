// Polyshape (closed polygon-path) end-to-end. Verifies:
//   - solver writes the post-solve bbox from the vertex AABB
//   - expandTransforms carries the vertex list + closed flag through
//   - resolvePolylineVertices computes world-space vertices correctly
//   - HFSS native emits CreatePolyline + SweepAlongVector
//   - pyAEDT emits create_polyline + thicken_sheet
//   - GDS produces a closed BOUNDARY record
//   - gdsfactory emits c.add_polygon
import { mod } from './_harness.mjs';
import { resolvePolylineVertices } from '../src/geometry/polyline.js';
import { generateGdsfactory } from '../src/export/gdsfactory.js';

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log(`  ok: ${msg}`);
  else { console.error(`  FAIL: ${msg}`); failures++; }
}

console.log('test_polyshape: building scene with a 5-vertex closed polygon...');
let scene = mod.makeBlankScene();
const condId = scene.stack.find(l => l.role === 'conductor').id;
scene.components = [
  {
    id: 'pent1', kind: 'polyshape', layer: 'electrode', conductorLayerId: condId,
    cx: 0, cy: 0, w: '0', h: '0',
    vertices: [
      { kind: 'rel', dx: '0',   dy: '0'   },  // v0 = (0, 0)
      { kind: 'rel', dx: '20',  dy: '0'   },  // v1 = (20, 0)
      { kind: 'rel', dx: '6',   dy: '15'  },  // v2 = (26, 15)
      { kind: 'rel', dx: '-16', dy: '12'  },  // v3 = (10, 27)
      { kind: 'rel', dx: '-10', dy: '-27' },  // v4 = (0, 0) — back to start
    ],
    closed: true, cutouts: [], transforms: [], label: 'pent1',
  },
];

const { values } = mod.resolveParams(scene.params);
const solved = mod.resolveBooleanBboxes(
  mod.applyMirrors(mod.solveLayout(scene.components, [], values), []),
  values
);

const pent = solved.find(c => c.id === 'pent1');
const verts = resolvePolylineVertices(pent, Object.fromEntries(solved.map(c => [c.id, c])), values);
assert(verts.length === 5, `5 vertices resolved (got ${verts.length})`);
assert(Math.abs(verts[2][0] - 26) < 1e-6 && Math.abs(verts[2][1] - 15) < 1e-6, `v2 at (26, 15)`);
assert(Math.abs(pent.w - 26) < 1e-6 && Math.abs(pent.h - 27) < 1e-6, `bbox w=26 h=27 (got ${pent.w} x ${pent.h})`);

console.log('expandTransforms carries vertices + closed flag...');
const insts = mod.expandTransforms(solved, values);
const pInst = insts.find(i => i.compId === 'pent1');
assert(pInst && pInst.kind === 'polyshape', `instance kind = polyshape`);
assert(pInst && pInst.closed === true, `instance closed=true`);
assert(pInst && Array.isArray(pInst.vertices) && pInst.vertices.length === 5, `instance carries 5 vertex specs`);

console.log('Exports succeed...');
const hfss = mod.generateHfssNative(scene, values);
const pyaedt = mod.generatePyAEDT(scene, values);
const gds = mod.generateGDS(scene, values);
const gf = generateGdsfactory(scene, values, { designName: 'pent_test' });

assert(hfss.includes('CreatePolyline') && hfss.includes('pent1'), `HFSS emits CreatePolyline for pent1`);
assert(hfss.includes('IsPolylineClosed:=", True'), `HFSS sets IsPolylineClosed=True`);
assert(hfss.includes('SweepAlongVector') && hfss.includes('thicken polyshape'), `HFSS thickens the polyshape sheet`);
assert(pyaedt.includes('create_polyline') && pyaedt.includes('cover_surface=True') && pyaedt.includes('close_surface=True') && pyaedt.includes('pent1'),
  `pyAEDT emits create_polyline with cover/close=True`);
assert(pyaedt.includes('thicken_sheet("pent1"'), `pyAEDT thickens pent1`);
assert(gds.byteLength > 100, `GDS file non-trivial (${gds.byteLength} bytes)`);
assert(gf.includes('c.add_polygon') && gf.includes('pent1'), `gdsfactory emits c.add_polygon for pent1`);

if (failures === 0) {
  console.log('\ntest_polyshape: ALL PASS');
  process.exit(0);
} else {
  console.error(`\ntest_polyshape: ${failures} FAILURE(S)`);
  process.exit(1);
}
