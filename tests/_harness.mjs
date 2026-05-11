// Test harness. Loads the pure-JS prefix of src/PhotonicLayout.jsx (the
// parameter solver, geometry, exporters, and scene factories) into a Node-
// loadable module so the node-script tests can exercise it without a
// browser, bundler, or React runtime.
//
// As Stage-1 modules get extracted into their own files, the harness will
// be updated to import them directly. While code is still inlined in
// PhotonicLayout.jsx, we slice the file from just after its top-level
// React/lucide imports up to the line where the first JSX component
// (`function Canvas(...)`) begins, then evaluate that slice via the
// Function constructor and re-export the named symbols.
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const srcPath = join(__dirname, '..', 'src', 'PhotonicLayout.jsx');
const src = readFileSync(srcPath, 'utf8');

const lines = src.split('\n');
const endIdx = lines.findIndex((l) => /^function Canvas\(/.test(l));
if (endIdx < 0) {
  throw new Error('harness: could not locate "function Canvas(" boundary in PhotonicLayout.jsx');
}
// Drop the React / lucide-react imports (always the first two lines of
// the file). Everything from line index 2 up to `function Canvas` is
// pure JS.
const pureJS = lines.slice(2, endIdx).join('\n');

const symbols = [
  // params + expr
  'tokenizeIdents', 'resolveParams', 'evalExpr',
  // anchors
  'parseAnchor', 'anchorLocal', 'anchorWorld',
  // solver
  'solveLayout', 'applyMirrors',
  // transforms + booleans
  'expandTransforms', 'resolveBooleanBboxes',
  // geometry
  'rectInstanceToRing', 'shapeInstanceToRing',
  'eulerBend180Centerline', 'buildRacetrackCenterline', 'offsetCenterlineToBand',
  'ringToSvgPath',
  // scene factories
  'defaultStack', 'normalizeScene', 'makeDefaultScene', 'makeBlankScene',
  // exporters
  'generatePyAEDT', 'generateHfssNative', 'generateGDS',
];

const body = `${pureJS}\nreturn { ${symbols.join(', ')} };`;
// eslint-disable-next-line no-new-func
export const mod = new Function(body)();
