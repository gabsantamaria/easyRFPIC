// Shared harness for test scripts. Imports the helpers we need from
// src/PhotonicLayout.jsx without trying to evaluate the React/JSX portion.
//
// This is a transitional approach for testing while the file is still a
// monolith. Once it's split into modules, tests should import directly
// from src/scene/, src/geometry/, src/export/, etc.

import { readFileSync, writeFileSync, mkdirSync } from 'fs';

const SOURCE = 'src/PhotonicLayout.jsx';

const src = readFileSync(SOURCE, 'utf8');
const cutoff = src.indexOf('// =========================================================================\n// CANVAS');
if (cutoff < 0) {
  console.error(`Couldn't find the CANVAS marker in ${SOURCE}. Is the file fully refactored?`);
  console.error('If so, update these test scripts to import from the new module locations.');
  process.exit(1);
}

let preamble = src.slice(0, cutoff);
preamble = preamble.split('\n').map((line, i) =>
  i < 10 && /^import .+from /.test(line) ? '' : line
).join('\n');

const exports = `
export {
  evalExpr, resolveParams,
  anchorLocal, anchorWorld, ANCHORS,
  solveLayout, applyMirrors, resolveBooleanBboxes,
  expandTransforms,
  shapeInstanceToRing,
  eulerBend180Centerline, buildRacetrackCenterline, offsetCenterlineToBand,
  generatePyAEDT, generateHfssNative, generateGDS,
  makeDefaultScene, makeBlankScene,
};
`;

mkdirSync('tests/out', { recursive: true });
writeFileSync('tests/out/_gen.mjs', preamble + exports);

export const mod = await import('../tests/out/_gen.mjs?v=' + Date.now());
