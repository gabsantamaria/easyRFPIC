// Helpers shared by built-in templates.
//
// A "template" is a small JS module that knows how to drop a parametric
// fixture (a racetrack, a ring resonator, …) into the current scene.
// Each template exports a default object of shape
//
//   { id, name, description, insert(prev, ctx) => nextScene }
//
// where `prev` is the current scene, `ctx` provides at least
// `{ viewport: { x, y } }` for placement, and the return value is the
// next scene the App should setState to.
//
// These helpers handle the boring parts: allocating non-colliding ids,
// non-colliding parameter names, and ensuring a baseline `w_wg` exists
// for any waveguide-touching template.

export function freshComponentId(prev, base) {
  let id = base;
  let i = 0;
  while (prev.components.some((c) => c.id === id)) {
    i++;
    id = `${base}_${i}`;
  }
  return id;
}

export function freshParamName(prev, base) {
  let n = base;
  let i = 2;
  while (prev.params[n]) {
    n = `${base}_${i++}`;
  }
  return n;
}

// If `prev` has a waveguide-role stack layer with `core_width`, return that
// param name; otherwise fall back to `w_wg` and add a default `w_wg` to the
// returned `extraParams` if it's missing from `prev.params`.
//
// Lets templates always reference a single waveguide-width identifier
// without each having to think about empty / blank scenes.
export function resolveWaveguideWidthRef(prev) {
  const wgLayer = (prev.stack || []).find((l) => l.role === 'waveguide');
  const ref = wgLayer && wgLayer.core_width ? wgLayer.core_width : 'w_wg';
  const extraParams = {};
  if (!prev.params[ref] && /^[A-Za-z_][A-Za-z0-9_]*$/.test(ref)) {
    extraParams[ref] = { expr: '1.2', unit: 'µm', desc: 'WG core width (rib bottom)' };
  }
  return { ref, extraParams };
}
