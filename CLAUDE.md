# PhotonicLayout — Architecture & Conventions

This file is the single source of truth for the architecture of this project. Read it before making changes. Update it when you change the architecture.

## What this is

A React-based parametric layout tool for RF/photonic IC structures (TFLN/TFLT modulators, ring resonators, racetrack resonators, filters). The user designs layouts in a canvas; the app exports to:

1. **HFSS pyAEDT** (Python script using `ansys.aedt.core`)
2. **HFSS native COM** (Python 2.7-compatible script invoking `oEditor` directly via `ScriptEnv`)
3. **GDS-II** (binary, custom REAL8 encoder)

The user is an RF engineer working on photonic IC RF structures. Engineering correctness and HFSS compatibility outweigh code elegance.

## Core mental model

Everything is an **object**: primitive (rect, circle, ellipse, polygon, racetrack), boolean (union/intersect/subtract of operands), or group. All objects expose the same uniform interface for snap, drag, anchor, and rendering. There are no special cases in the canvas for "this is a boolean" vs "this is a rect" — the geometry pipeline treats them uniformly through `shapeInstanceToRing` and AABB w/h.

Booleans are HFSS-style: a boolean *consumes* its operands (marks them `consumedBy`) and produces a named derived component. The SHAPES panel renders this as a feature tree, and the HFSS export produces a modeler tree mirroring the SHAPES tree.

## Scene model

```js
scene = {
  params,       // { name: { expr, unit, desc } } — parametric expressions
  components,   // unified list, see below
  snaps,        // { from: {compId, anchor}, to: {compId, anchor}, dx, dy }
  mirrors,      // mirror operations: axis, source compIds, target compIds
  groups,       // { id, memberIds, aliases, name }
  stack,        // layer stack: substrate, waveguide, conductor(s), cladding
  booleans      // LEGACY empty array; booleans now live in `components`
}
```

### Components

```js
// Primitive shapes:
{ id, kind, layer, cx, cy, w, h, cutouts[], transforms[], consumedBy? }
// where kind is one of:
//   'rect':       w, h
//   'circle':     r            (w='2*r', h='2*r' derived)
//   'ellipse':    rx, ry       (w='2*rx', h='2*ry')
//   'polygon':    r, n         (w=h='2*r')
//   'racetrack':  R, L_straight, p, wgWidth
//                              (w, h are linear-in-p approximations)

// Booleans (derived from operands):
{ id, kind:'boolean', op, operandIds[], layer,
  cx, cy, w:'0', h:'0',   // refreshed numerically post-solve
  cutouts, transforms, label }
```

The AABB `w`/`h` being stored as expressions (`'2*r'` etc.) keeps every snap, anchor, dimension, and boolean-bbox code path working uniformly. Booleans have `w='0'`, `h='0'` literally; their actual bbox is refreshed numerically by `resolveBooleanBboxes` after the solver runs.

### Parameters

Two-pass `resolveParams`:
1. First pass: evaluate each param's expression, collect into `values`.
2. Second pass: re-evaluate using `values` so params can reference each other.

Synthetic params auto-generated per component: `_comp_<id>_cx`, `_comp_<id>_cy`, `_comp_<id>_w`, `_comp_<id>_h`. These let dimension expressions reference other components' positions.

`RESERVED_IDENTS` are math functions (`sin`, `cos`, `pi`, etc.) that pass through `evalExpr` unchanged.

### Transforms

Each component has a `transforms` array — an ordered list of operations applied AFTER snap solving:

```js
{ id, kind: 'displace', enabled, dx, dy }
{ id, kind: 'rotate', enabled, angle, pivot }   // pivot: 'C'|'origin'|anchor name
{ id, kind: 'repeat', enabled, n, dx, dy, includeOriginal }
```

`expandTransforms` walks the chain in order:
- `displace` shifts each instance
- `rotate` rotates instances about the chosen pivot (with cx/cy update for non-'C' pivots)
- `repeat` MULTIPLIES the instance list by N+1 (or N if !includeOriginal)

For non-rect shapes, `expandTransforms` propagates shape-specific fields (r, rx, ry, n, R, L_straight, p, wgWidth) onto each instance so downstream consumers (rings, exporters) have everything they need.

## Snap / drag / cluster mechanics

**Snap definition**: `{ from: {compId, anchor}, to: {compId, anchor}, dx, dy }`. Anchor is one of the 9 nine-point grid positions (`C`, `N`, `NE`, `E`, `SE`, `S`, `SW`, `W`, `NW`). dx/dy are parametric expressions.

**Solver** (`solveLayout`): iteratively propagates snap constraints. Uses a fixed-point iteration with shift-clustering on each snap. After primitive snap propagation, `refreshBooleanBbox` recomputes boolean AABBs inline. A final fixed-point pass picks up any chained position dependencies.

**Cluster drag**: dragging a primitive that's a member of a boolean drags the WHOLE cluster (operands + the boolean) in tandem. Implementation: walk `consumedBy` to find the root boolean, then walk `operandIds` recursively (with a `visitedBooleans` guard to prevent infinite loops in nested boolean structures). All cluster members move with the same delta.

**Alt-drag snap creation**: alt-modifier drag creates a new snap between the dragged component and a target. The candidate target list is computed at drag-init time:
- EXCLUDES cluster siblings (`clusterSet`) so a child can't snap to a sibling within the same boolean cluster
- INCLUDES booleans (a primitive can snap to a boolean's outer perimeter anchor)
- EXCLUDES the dragged component itself

**Snap-anchor reading on booleans** (CRITICAL): the scene model has booleans with literal `w='0'`, `h='0'`. To read a boolean's bbox for snap anchor math, ALWAYS look up the SOLVED instance (from the `solved` array produced by `solveLayout` + `resolveBooleanBboxes`), not the scene component directly. Using `scene.b.w` will give you '0' and snap math will collapse the boolean to a point.

**Hysteresis** on alt-drag: when multiple snap anchor pairs are equidistant from the cursor, the solver could oscillate between them frame-to-frame, creating visual jitter and unstable snap selection. We apply hysteresis: once a snap anchor pair is "stuck", switching requires the cursor to move closer than `stickThresh = worldThresh * 0.5` to another pair. Prevents the bug class where moving the mouse 1px flips the snap selection.

## Rendering

Canvas uses SVG with `y-up world → y-down screen` transform.

**Per-component standard renderer** dispatches on shape kind:
- `rect`: `<rect>` with rotation wrapper
- `circle`: `<circle>`
- `ellipse`: `<ellipse>`
- `polygon`: `<polygon>` from tessellated ring (rotation baked into ring, no wrapper rotation)
- `racetrack`: `<path>` of the centerline, stroked with `stroke-width=wgWidth`, `fill=none` (browser draws the band)

**Boolean cluster rendering** uses SVG `<mask>` / `<clipPath>` to composite multiple shape rings recursively. Each boolean's rendering function (`renderInterior`, `renderOutline`) walks operands and applies the boolean op via SVG mask composition. Selection halo is uniform cyan `#0ea5e9` across all object kinds.

## Exports

### pyAEDT (`generatePyAEDT`)

For each component, emits ONE shape-creation call at the BASE position (no transforms applied), then emits each transform in `c.transforms` as a SEPARATE pyAEDT call. The HFSS modeler history ends up mirroring the SHAPES panel tree.

Transform-to-pyAEDT mapping:
- `displace(dx, dy)` → `hfss.modeler.move([id], [dx, dy, 0])`. Parametric expressions preserved when the expression contains identifiers.
- `rotate(angle, pivot='origin')` → `hfss.modeler.rotate([id], "Z", angle)`. Both position and orientation rotate.
- `rotate(angle, pivot='C')` → `move(-cx, -cy)` → `rotate("Z", angle)` → `move(cx, cy)`. Pivot is the part's CURRENT center (numeric).
- `rotate(angle, pivot=anchor)` → pivot computed using base w/h + current rotation, then translate-rotate-translate.
- `repeat(n, dx, dy)` → `hfss.modeler.duplicate_along_line(id, [dx, dy, 0], clones=n+1)`.

For waveguides built via `build_wg`, transforms target `<id>_rib` (the rib part name). Non-rect waveguides target the bare id.

### HFSS native COM (`generateHfssNative`)

Parallel structure to pyAEDT but emits raw `oEditor.*` COM calls wrapped in try/except. Uses `set_var` to declare every scene parameter as an HFSS variable up front, so primitives can be created with parametric XYZ + size expressions.

Non-rect shapes are emitted as a polygonal sheet via `CreatePolyline` + `SweepAlongVector` to thicken. Racetracks emit outer perimeter + inner perimeter + Subtract to leave a hollow band.

Transform chain emission uses the same logic as pyAEDT (separate helper `emitTransformChainHfss`).

### GDS-II (`generateGDS`)

Custom REAL8 binary encoder. Each component emits BOUNDARY records using `shapeInstanceToRing` for the perimeter. Racetracks emit outer perimeter as DATATYPE=0 and inner perimeter as DATATYPE=1 (cutout convention). Booleans skip GDS emission (they're CAD-only constructs; GDS is the final flattened layout).

## Common bug patterns to avoid

- **`str_replace` edits that orphan function bodies.** Always parse-check after structural edits: `node -e "require('@babel/parser').parse(require('fs').readFileSync('src/PhotonicLayout.jsx', 'utf8'), { sourceType: 'module', plugins: ['jsx'] })"`.
- **TDZ errors from `useEffect` dep arrays referencing later-declared `const` functions.** Use refs (`useRef`) to break the cycle: declare the ref first, set its current in an effect, reference the ref in the dep array.
- **Booleans with literal `w='0'`, `h='0'` for anchor math.** Always look up the SOLVED instance, never the scene component, when reading boolean bboxes.
- **Operands of consumed booleans rendering standalone.** Filter via `consumedBy` set in the renderer.
- **Infinite recursion in boolean tree walks.** Use a `visited` Set, passed through the recursion.
- **HFSS `Rotate` rotates about world Z, not part center.** Always use translate-rotate-translate for "rotate about own center" semantics.
- **Cluster siblings as alt-drag snap targets.** Exclude via `drag.clusterSet` at drag-init time.
- **Anchor-pair switching during alt-drag.** Apply hysteresis via `stickThresh = worldThresh * 0.5`.
- **Drag preview doesn't match drop position.** The drag preview and the commit logic must use the same shape-aware coordinate computation.

## Verification commands

After any structural change, run:

```bash
# Parse-check the source
node -e "require('@babel/parser').parse(require('fs').readFileSync('src/PhotonicLayout.jsx', 'utf8'), { sourceType: 'module', plugins: ['jsx'] })" && echo OK

# Regenerate default-scene exports and verify they parse as Python
node tests/regen.mjs && python3 -c "import ast; ast.parse(open('tests/out/layout_hfss.py').read()); print('HFSS OK')" && python3 -c "import ast; ast.parse(open('tests/out/layout_pyaedt.py').read()); print('pyAEDT OK')"

# Run drag regression tests
node tests/test_drag_thorough.mjs

# Run shape & racetrack tests
node tests/test_shapes.mjs
node tests/test_racetrack.mjs
node tests/test_racetrack_export.mjs
```

All four drag scenarios should produce position outputs matching the expected positions encoded in each test.

## Rejected directions (do not re-propose without strong evidence)

- Vision LLM sketch parsing
- Per-axis snaps (separate X and Y constraint dimensions)
- Soft constraints / least-squares solver
- Martinez-Rueda polygon clipper inline (boolean ops via SVG mask is sufficient)
- snap-offset drag (dragging child updates dx/dy of the snap, rather than moving the child)
- Dedicated BOOL tab in the inspector

## User style

Concise direct messages. Engineer-minded. Wants things to actually work. Based in Denver, working on TFLN/TFLT photonic IC RF structures. Doesn't want overly verbose answers — get to the point, ship the change, then summarize what was done.
