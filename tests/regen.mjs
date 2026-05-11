// Regenerate the canonical default-scene exports under tests/out/. CLAUDE.md
// suggests piping the outputs through `python3 -c "import ast; ast.parse(...)"`
// to catch malformed Python emitted by the HFSS / pyAEDT exporters after a
// structural edit.
import { mod } from './_harness.mjs';
import { writeFileSync, mkdirSync } from 'fs';

const scene = mod.makeDefaultScene();
const { values, errors } = mod.resolveParams(scene.params);
const errKeys = Object.keys(errors || {});
if (errKeys.length) {
  console.error('regen: parameter resolution errors:', errors);
  process.exit(1);
}

const py   = mod.generatePyAEDT(scene, values);
const hfss = mod.generateHfssNative(scene, values);
const gds  = mod.generateGDS(scene, values);

mkdirSync('tests/out', { recursive: true });
writeFileSync('tests/out/layout_pyaedt.py', py);
writeFileSync('tests/out/layout_hfss.py',   hfss);
writeFileSync('tests/out/layout.gds',       Buffer.from(gds));

console.log(`regen: wrote tests/out/layout_pyaedt.py  (${py.length} chars)`);
console.log(`regen: wrote tests/out/layout_hfss.py    (${hfss.length} chars)`);
console.log(`regen: wrote tests/out/layout.gds        (${gds.byteLength} bytes)`);
