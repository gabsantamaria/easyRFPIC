// Regenerate the default-scene HFSS native and pyAEDT export scripts and
// write them to tests/out/. Used to (a) smoke-test the exporters and
// (b) provide artifacts for python AST validation.
//
// Usage: node tests/regen.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';

const SOURCE = 'src/PhotonicLayout.jsx';

// Trick: import the source as an ES module by slicing off everything from
// the canvas component onward (which contains JSX that Node can't parse)
// and exporting the helpers we want to test.
const src = readFileSync(SOURCE, 'utf8');
const cutoff = src.indexOf('// =========================================================================\n// CANVAS');
if (cutoff < 0) {
  console.error(`Couldn't find the CANVAS section marker in ${SOURCE}.`);
  console.error('This test harness assumes the file is still a monolith with that marker.');
  console.error('Once the file is split into modules, rewrite this script to import directly.');
  process.exit(1);
}
let preamble = src.slice(0, cutoff);
// Strip the first few `import …from …` lines — they reference React/lucide
// which aren't available in plain Node. The geometry/export functions don't
// need them.
preamble = preamble.split('\n').map((line, i) =>
  i < 10 && /^import .+from /.test(line) ? '' : line
).join('\n');
const exports = `
export {
  generateHfssNative,
  generatePyAEDT,
  makeDefaultScene,
  resolveParams,
};
`;
mkdirSync('tests/out', { recursive: true });
writeFileSync('tests/out/_gen.mjs', preamble + exports);
const mod = await import('../tests/out/_gen.mjs?v=' + Date.now());

const scene = mod.makeDefaultScene();
const { values } = mod.resolveParams(scene.params);

writeFileSync('tests/out/layout_hfss.py',   mod.generateHfssNative(scene, values));
writeFileSync('tests/out/layout_pyaedt.py', mod.generatePyAEDT(scene, values));

console.log('Wrote tests/out/layout_hfss.py and tests/out/layout_pyaedt.py.');
console.log('Validate with:');
console.log('  python3 -c "import ast; ast.parse(open(\'tests/out/layout_hfss.py\').read()); print(\'HFSS OK\')"');
console.log('  python3 -c "import ast; ast.parse(open(\'tests/out/layout_pyaedt.py\').read()); print(\'pyAEDT OK\')"');
