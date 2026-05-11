// Test harness. Builds the `mod` namespace the node-script tests expect by
// re-exporting from the now-extracted ESM modules. Before Stage 4 the
// harness sliced the pure-JS prefix of src/PhotonicLayout.jsx into a
// Function constructor; that's no longer needed since every scene / geometry
// / exporter symbol lives in its own module.
import * as racetrack from '../src/geometry/racetrack.js';
import * as params from '../src/scene/params.js';
import * as anchors from '../src/scene/anchors.js';
import * as rings from '../src/geometry/rings.js';
import * as transforms from '../src/scene/transforms.js';
import * as solver from '../src/scene/solver.js';
import * as gds from '../src/export/gds.js';
import * as pyaedt from '../src/export/pyaedt.js';
import * as hfssNative from '../src/export/hfss-native.js';
import * as schema from '../src/scene/schema.js';
import * as paths from '../src/geometry/paths.js';

export const mod = {
  // geometry/racetrack
  eulerBend180Centerline: racetrack.eulerBend180Centerline,
  buildRacetrackCenterline: racetrack.buildRacetrackCenterline,
  offsetCenterlineToBand: racetrack.offsetCenterlineToBand,
  // scene/params
  tokenizeIdents: params.tokenizeIdents,
  resolveParams: params.resolveParams,
  evalExpr: params.evalExpr,
  RESERVED_IDENTS: params.RESERVED_IDENTS,
  // scene/anchors
  ANCHORS: anchors.ANCHORS,
  parseAnchor: anchors.parseAnchor,
  anchorLocal: anchors.anchorLocal,
  anchorWorld: anchors.anchorWorld,
  // geometry/rings
  rectInstanceToRing: rings.rectInstanceToRing,
  shapeInstanceToRing: rings.shapeInstanceToRing,
  // scene/transforms
  expandTransforms: transforms.expandTransforms,
  // scene/solver
  solveLayout: solver.solveLayout,
  applyMirrors: solver.applyMirrors,
  resolveBooleanBboxes: solver.resolveBooleanBboxes,
  // export/*
  generateGDS: gds.generateGDS,
  generatePyAEDT: pyaedt.generatePyAEDT,
  generateHfssNative: hfssNative.generateHfssNative,
  // scene/schema
  defaultStack: schema.defaultStack,
  normalizeScene: schema.normalizeScene,
  makeDefaultScene: schema.makeDefaultScene,
  makeBlankScene: schema.makeBlankScene,
  // geometry/paths
  ringToSvgPath: paths.ringToSvgPath,
};
