// Test harness. Loads the pure-JS prefix of src/PhotonicLayout.jsx (the
// parameter solver, geometry, exporters, and scene factories) into a Node-
// loadable module so the node-script tests can exercise it without a
// browser, bundler, or React runtime.
//
// As Stage-1 modules get extracted into their own files, the harness imports
// them as real ESM and injects them into the scope of the evaluated slice,
// so code still inside PhotonicLayout.jsx can call into them as before.
// Once everything is extracted the slice-and-eval can go away.
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import * as racetrack from '../src/geometry/racetrack.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const srcPath = join(__dirname, '..', 'src', 'PhotonicLayout.jsx');
const src = readFileSync(srcPath, 'utf8');

const lines = src.split('\n');
const endIdx = lines.findIndex((l) => /^function Canvas\(/.test(l));
if (endIdx < 0) {
  throw new Error('harness: could not locate "function Canvas(" boundary in PhotonicLayout.jsx');
}
// Find the first line after the top-of-file `import` block. We can't
// evaluate import statements inside the Function constructor, so we drop
// every leading `import` line (including the multi-line continuation
// case if it ever appears).
let startIdx = 0;
while (startIdx < endIdx && /^\s*import\b/.test(lines[startIdx])) startIdx++;
const pureJS = lines.slice(startIdx, endIdx).join('\n');

// Symbols that have been extracted into sub-modules and should be exposed
// in the evaluated slice's scope (so any remaining inlined code can still
// call them). Each entry is [name, value].
const injected = {
  eulerBend180Centerline: racetrack.eulerBend180Centerline,
  buildRacetrackCenterline: racetrack.buildRacetrackCenterline,
  offsetCenterlineToBand: racetrack.offsetCenterlineToBand,
};

// Names still defined inside the slice. Anything extracted out moves to
// `injected` above and is dropped from this list.
const sliceSymbols = [
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
  'ringToSvgPath',
  // scene factories
  'defaultStack', 'normalizeScene', 'makeDefaultScene', 'makeBlankScene',
  // exporters
  'generatePyAEDT', 'generateHfssNative', 'generateGDS',
];

const injectedNames = Object.keys(injected);
const body = `${pureJS}\nreturn { ${[...sliceSymbols, ...injectedNames].join(', ')} };`;
// eslint-disable-next-line no-new-func
const fn = new Function(...injectedNames, body);
export const mod = fn(...injectedNames.map((n) => injected[n]));
