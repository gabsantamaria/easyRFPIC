// Identifier rename across every expression-bearing field in a scene.
//
// `renameParam` in PhotonicLayout.jsx used to rewrite only param exprs,
// component w/h, and snap dx/dy — silently leaving stale references in
// cutouts, transform chains, shape-specific knobs (r, rx, ry, R,
// L_straight, p, wgWidth, n, polyline width), polyline/polyshape
// rel-vertices, stack-layer expressions, and the sim setup. This module
// centralizes the walk so every expression field gets rewritten.
//
// Field coverage is a SUPERSET of `tokenizeComponentExprs` in params.js
// (which covers component-local expressions only). If you add an
// expression-bearing field to the scene model, add it BOTH there (so
// param-usage scans see it) and here (so renames rewrite it).

// Per-object expression-field lists. Kept as flat constants so the
// coverage is auditable at a glance against tokenizeComponentExprs.
const COMPONENT_EXPR_FIELDS = [
  'w', 'h',                                  // uniform AABB
  'r', 'rx', 'ry',                           // circle / ellipse / polygon
  'R', 'L_straight', 'p', 'wgWidth',         // racetrack
  'n',                                       // polygon side count
  'width',                                   // polyline trace width
  'rotation',                                // first-class rotation (deg, CCW)
  'zOffset',                                 // Z shift relative to the layer (µm)
];
const CUTOUT_EXPR_FIELDS    = ['dx', 'dy', 'w', 'h'];
const TRANSFORM_EXPR_FIELDS = ['dx', 'dy', 'angle', 'n', 'offset'];
// Polyline/polyshape vertex expression fields:
//   dx/dy        — rel-kind step from the previous vertex
//   cdx/cdy/angle — arc-kind center offset + sweep (degrees CCW)
//   width        — per-vertex taper width (polyline only; any kind)
// Applied to EVERY vertex regardless of kind — replFields skips fields
// that aren't strings, so snap vertices (compId/anchor only) pass
// through untouched while a snap vertex carrying a taper width still
// gets its width expression rewritten.
const VERTEX_EXPR_FIELDS    = ['dx', 'dy', 'cdx', 'cdy', 'angle', 'width'];
const STACK_EXPR_FIELDS     = ['thickness', 'core_width', 'slab_height', 'slab_width', 'etch_angle'];
const SIM_EXPR_FIELDS       = ['fnominal', 'padXNeg', 'padXPos', 'padYNeg', 'padYPos', 'airPad'];

// Rewrite the listed fields on a shallow copy of `obj`. String fields
// only — numeric / undefined fields pass through untouched.
function replFields(obj, fields, repl) {
  const next = { ...obj };
  for (const f of fields) {
    if (typeof next[f] === 'string') next[f] = repl(next[f]);
  }
  return next;
}

// Rename identifier `oldName` → `newName` in every expression field of
// `scene`. Returns a NEW scene object (input is not mutated). Uses the
// same word-boundary regex as the legacy renameParam repl, so `foo`
// does not clobber `food` or `my_foo`.
//
// NOTE: this rewrites EXPRESSION STRINGS only. It does not rename the
// param dictionary KEY itself — the caller (renameParam) does that
// first, then hands the scene here for the reference rewrite.
export function renameIdentInScene(scene, oldName, newName) {
  // Both names must be valid identifiers — anything else would produce
  // a broken regex or an unparseable expression. Bail out unchanged.
  const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
  if (!IDENT_RE.test(oldName || '') || !IDENT_RE.test(newName || '')) return scene;
  if (oldName === newName) return scene;

  const re = new RegExp(`\\b${oldName}\\b`, 'g');
  const repl = (e) => (typeof e === 'string' ? e.replace(re, newName) : e);

  // --- params: every param's expr ---
  const params = {};
  for (const [k, v] of Object.entries(scene.params || {})) {
    params[k] = { ...v, expr: repl(v.expr) };
  }

  // --- components: dims, shape knobs, cutouts, transforms, vertices ---
  const components = (scene.components || []).map((c) => {
    const next = replFields(c, COMPONENT_EXPR_FIELDS, repl);
    if (Array.isArray(c.cutouts)) {
      next.cutouts = c.cutouts.map((cu) => replFields(cu, CUTOUT_EXPR_FIELDS, repl));
    }
    if (Array.isArray(c.transforms)) {
      next.transforms = c.transforms.map((t) => (t ? replFields(t, TRANSFORM_EXPR_FIELDS, repl) : t));
    }
    if (Array.isArray(c.vertices)) {
      // Every vertex kind can carry expressions now: rel (dx/dy), arc
      // (cdx/cdy/angle), and any kind can carry a taper width. snap
      // vertices' compId/anchor are not expressions and aren't in the
      // field list, so they pass through unchanged.
      next.vertices = c.vertices.map((v) =>
        v ? replFields(v, VERTEX_EXPR_FIELDS, repl) : v
      );
    }
    return next;
  });

  // --- snaps: dx / dy offsets ---
  const snaps = (scene.snaps || []).map((s) => replFields(s, ['dx', 'dy'], repl));

  // --- stack layers: thickness + rib cross-section expressions ---
  const stack = (scene.stack || []).map((l) => replFields(l, STACK_EXPR_FIELDS, repl));

  const out = { ...scene, params, components, snaps, stack };

  // --- simSetup: open-region frequency + padding expressions ---
  // Only touched when present — spreading `simSetup: undefined` onto a
  // scene that never had the key would add a phantom key.
  if (scene.simSetup) out.simSetup = replFields(scene.simSetup, SIM_EXPR_FIELDS, repl);

  return out;
}
