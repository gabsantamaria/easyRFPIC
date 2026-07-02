// Numeric per-layer Z map — shared stack walk.
//
// Extracted verbatim from generatePyAEDT's local `numericLayerZ` IIFE
// (src/export/pyaedt.js) so the 3-D viewer's spec builder (scene3d.js) and
// the pyAEDT exporter compute the SAME Z spans from the SAME code. This is
// the NUMERIC mirror of hfss-native's parametric `layerZ` walk — grouping
// is by `coplanarGroup` (members share zBottom; the group advances past by
// its cladding TOP), Z=0 is pinned at the first device-role layer or first
// coplanar-group member, and substrates below stack downward into negative
// Z. It MUST stay in lockstep with hfss-native's layerZ (same migrate, same
// group predicate, same cladding pick) or via Z spans would disagree
// between exporters and the viewer.
import { evalExpr } from './params.js';
import { migrateStackCoplanarGroups } from './schema.js';

// stack: scene.stack (raw — migrated defensively here, matching in-app
// normalization). paramValues: resolved parameter values.
// Returns { [layerId]: { zBottom, zTop, thickness } } (µm, numeric).
export function computeNumericLayerZ(stackRaw, paramValues) {
  const stack = migrateStackCoplanarGroups(stackRaw || []);
  const map = {};
  const isDev = (r) => r === 'waveguide' || r === 'conductor' || r === 'cladding';
  const tOf = (l) => {
    const v = evalExpr(l.thickness, paramValues);
    return Number.isFinite(v) ? v : 1;
  };
  // Layer whose TOP defines a coplanar group's top: the cladding (thickest if
  // several), else — malformed group with no cladding — the thickest member.
  const advanceLayerOf = (members) => {
    const clad = members.filter(m => m.role === 'cladding');
    const pool = clad.length ? clad : members;
    return pool.reduce((a, b) => (tOf(b) > tOf(a) ? b : a), pool[0]);
  };
  // Pin Z=0 at the first device-role layer OR first coplanar-group member
  // (matches hfss-native; every group carries a cladding/device member).
  let firstDev = stack.findIndex(l => isDev(l.role) || l.coplanarGroup);
  if (firstDev === -1) firstDev = stack.length;
  let z = 0;
  for (let i = firstDev - 1; i >= 0; i--) {
    const t = tOf(stack[i]);
    map[stack[i].id] = { zBottom: z - t, zTop: z, thickness: t };
    z -= t;
  }
  z = 0;
  let i = firstDev;
  while (i < stack.length) {
    const gid = stack[i].coplanarGroup;
    if (gid) {
      let runEnd = i;
      while (runEnd + 1 < stack.length && stack[runEnd + 1].coplanarGroup === gid) runEnd++;
      const members = [];
      for (let j = i; j <= runEnd; j++) {
        const t = tOf(stack[j]);
        map[stack[j].id] = { zBottom: z, zTop: z + t, thickness: t };
        members.push(stack[j]);
      }
      z += tOf(advanceLayerOf(members));
      i = runEnd + 1;
    } else {
      const t = tOf(stack[i]);
      map[stack[i].id] = { zBottom: z, zTop: z + t, thickness: t };
      z += t;
      i++;
    }
  }
  return map;
}
