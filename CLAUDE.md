# PhotonicLayout — Architecture & Conventions

This file is the single source of truth for the architecture of this project. Read it before making changes. Update it when you change the architecture.

## What this is

A React-based parametric layout tool for RF/photonic IC structures (TFLN/TFLT modulators, ring resonators, racetrack resonators, filters). The user designs layouts in a canvas; the app exports to:

1. **HFSS pyAEDT** (Python script using `ansys.aedt.core`)
2. **HFSS native COM** (Python 2.7-compatible script invoking `oEditor` directly via `ScriptEnv`)
3. **GDS-II** (binary, custom REAL8 encoder)
4. **gdsfactory** (Python script; numeric tessellation)

The user is an RF engineer working on photonic IC RF structures. Engineering correctness and HFSS compatibility outweigh code elegance.

## Core mental model

Everything is an **object**: primitive (rect, circle, ellipse, polygon, racetrack, via, polyline, polyshape), boolean (union/intersect/subtract of operands), or group. All objects expose the same uniform interface for snap, drag, anchor, and rendering. There are no special cases in the canvas for "this is a boolean" vs "this is a rect" — the geometry pipeline treats them uniformly through `shapeInstanceToRing` and AABB w/h.

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
  cells,        // { name: def } — parametric cell masters embedded in the
                // design (see "Parametric cells"); normalizeScene passthrough
  booleans      // LEGACY empty array; booleans now live in `components`
}
```

### Components

```js
// Primitive shapes:
{ id, kind, layer, cx, cy, w, h, cutouts[], transforms[], consumedBy?,
  rotation?,   // OPTIONAL expression (degrees, CCW) on rect/circle/ellipse/polygon.
               // Absent or '0' = none. Seeds the base instance's rotation in
               // expandTransforms; chain rotates ADD to it. Anchors/snap dots
               // rotate with the shape (anchorWorld / anchorLocalRotated).
  zOffset?,    // OPTIONAL expression (µm) on rect/circle/ellipse/polygon/
               // polyline/polyshape: shifts the part's Z placement relative
               // to its layer (HFSS-parametric; no canvas visual in top view).
  cxExpr?, cyExpr? }
               // OPTIONAL parametric root position (µm expression strings).
               // Applied by the solver on UNSNAPPED roots only — the exprs
               // overwrite cx/cy on EVERY solve (a numeric drag is overwritten
               // on the next solve, same UX as snap-bound parts). Snap-bound
               // components ignore them (the snap wins); booleans never apply
               // them. Non-finite evaluation keeps the numeric cx/cy and
               // surfaces a 'nan-pos-expr' solve diagnostic. HFSS native COM
               // export keeps them LIVE (rootPosExpr — the whole downstream
               // snap chain inherits the referenced params); pyAEDT bakes them
               // numerically with a pointer comment to the native export.
// where kind is one of:
//   'rect':       w, h, cornerRadius? (optional fillet expr; ring/GDS/HFSS
//                              emit 4 straight edges + 4 90-deg corner arcs;
//                              clamped to min(w,h)/2 in-app, NOT in HFSS)
//   'circle':     r            (w='2*r', h='2*r' derived)
//   'ellipse':    rx, ry       (w='2*rx', h='2*ry')
//   'polygon':    r, n         (w=h='2*r')
//   'racetrack':  R, L_straight, p, wgWidth
//                              (w, h are linear-in-p approximations)
//   'via':        r, layerFrom, layerTo (stack-layer ids; layer='via';
//                              w/h derived like circles; HFSS emits a
//                              parametric CreateCylinder from layerFrom's
//                              zBottom to layerTo's zTop; GDS layers 200+,
//                              one per distinct from->to pair. rotation /
//                              zOffset / cornerRadius do NOT apply — a via's
//                              Z span is layer-bound; normalizeScene strips
//                              them and exporters never emit them)
//   'polyline':   width, vertices[], closed?   (w='0', h='0'; bbox refreshed
//                              post-solve by refreshPolylineBbox, padded by the
//                              WIDEST effective width)
//   'polyshape':  vertices[], closed:true      (filled 2-D polygon path;
//                              bbox = vertex AABB, no width padding)

// Polyline/polyshape VERTEX MODEL (all expression-valued fields are strings):
//   { kind: 'rel',  dx, dy, spline?, width? }   // step from previous vertex
//   { kind: 'snap', compId, anchor, instanceIdx?, width? } // pinned to anchor
//   { kind: 'arc',  cdx, cdy, angle }           // circular arc: center =
//        prev + (cdx, cdy); sweeps `angle` DEGREES (CCW positive); the
//        vertex's resolved position is the arc ENDPOINT. 1:1 with an HFSS
//        AngularArc segment (parametric ArcCenterX/Y + "(<expr>)*1deg").
//   spline: consecutive spline-flagged rel vertices (plus the anchor vertex
//        before the run) form ONE HFSS Spline segment (NURBS through the
//        chain-expr points). Canvas/GDS tessellate the run with Catmull-Rom
//        (>=8 segs/span) — an APPROXIMATION of HFSS's NURBS, flagged in the
//        export's safety-report NOTES.
//   width (polyline only): per-vertex taper width. If ANY vertex carries one,
//        the trace is TAPERED: rendered + exported as per-segment quads
//        (endpoint ± (w/2)·normal, BUTT joins). HFSS emits per-segment
//        4-point covered sheets with PARAMETRIC corners (normal via sqrt) +
//        Unite + sweep. Arc/spline segments in a tapered polyline are a v1
//        restriction: constant base width, tessellated numerically (WARNING
//        comment + FROZEN report entry; width field disabled on arc rows).
//   resolvePolylineVertices = ONE point per vertex spec (stable indexing for
//   inspector rows/handles); tessellatePolylinePath = full drawn path (arcs
//   expanded at ceil(|angle|/360*64) >= 8 segs, spline runs interpolated) —
//   feeds canvas paths, rings (solver stashes it as `_resolvedVerts`),
//   AABBs, and the numeric exporters.
//   Draw UX: pressing 'a' while drawing toggles ARC mode — the next click
//   places a 90° arc endpoint (synthArc90 picks the bulge side from the
//   previous move direction). Inspector has line↔arc converters, a spline
//   checkbox per rel vertex, and per-vertex 'w' taper fields.

// Booleans (derived from operands):
{ id, kind:'boolean', op, operandIds[], layer,
  cx, cy, w:'0', h:'0',   // refreshed numerically post-solve
  cutouts, transforms, label }
```

The AABB `w`/`h` being stored as expressions (`'2*r'` etc.) keeps every snap, anchor, dimension, and boolean-bbox code path working uniformly. Booleans have `w='0'`, `h='0'` literally; their actual bbox is refreshed numerically by `resolveBooleanBboxes` after the solver runs.

**Rotation in HFSS export**: the angle is degree-typed — `"(<expr>)*1deg"` (or `"<n>deg"` for pure numerics). Rotation params auto-created from the inspector are therefore UNITLESS (a deg-typed variable times 1deg would be deg²). Snap chains through a rotated parent wrap the anchor offsets in the HFSS-trig rotation matrix (`cos((rot)*1deg)` etc.) inside `computeParametricPositions`, so a child tracks both the parent's position params AND its rotation param. The part itself is created axis-aligned, then a parametric translate-rotate-translate about its own center is emitted before its transform chain. `zOffset` appends `+ (<expr>)um` to every component Z-placement expression (electrode box/sheet, wg slab+rib, port sheet + IntLine numeric Z, polyline pathZ, polyshape/native-shape zBottom).

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
{ id, kind: 'rotate', enabled, angle, pivot, px?, py? }
    // pivot: 'C'|'origin'|anchor name|'group'|'custom'
    // 'custom' = explicit world-point pivot; px/py are µm EXPRESSION strings
    // (normalizeScene coerces stray numerics). expandTransforms rotates every
    // instance rigidly about the one (px, py) point; non-finite px/py skips
    // the transform. HFSS native keeps px/py PARAMETRIC (exprWithUm pivot in
    // the translate-rotate-translate); pyAEDT bakes them numerically with a
    // pointer comment to the native export.
{ id, kind: 'repeat', enabled, n, dx, dy, includeOriginal }
```

`expandTransforms` walks the chain in order:
- `displace` shifts each instance
- `rotate` rotates instances about the chosen pivot (with cx/cy update for non-'C' pivots)
- `repeat` MULTIPLIES the instance list by N+1 (or N if !includeOriginal)

For non-rect shapes, `expandTransforms` propagates shape-specific fields (r, rx, ry, n, R, L_straight, p, wgWidth) onto each instance so downstream consumers (rings, exporters) have everything they need.

## Snap / drag / cluster mechanics

**Snap definition**: `{ from: {compId, anchor, instanceIdx?}, to: {compId, anchor}, dx, dy }`. `from` is the parent/reference (solver places `to` relative to it); `to` is the child. Anchor is one of the 9 nine-point grid positions (`C`, `N`, `NE`, `E`, `SE`, `S`, `SW`, `W`, `NW`). dx/dy are parametric expressions.

**Snap to a repeat replica** (`from.instanceIdx`): an OPTIONAL integer (`>0`) on the `from` endpoint targets a specific instance produced by the parent's `repeat`/`displace` chain — not just the base. It reuses the SAME machinery polyline snap-vertices use (`src/scene/instance-positions.js`: `instanceChainOffsetExpr` / `chainOwnerForInstance`). Three layers learn it: the solver shifts the reference anchor by the numeric base→instance-k chain offset (`solver.js`, evaluated from `instanceChainOffsetExpr`); the native HFSS export adds that offset PARAMETRICALLY at the snap consumer (`computeParametricPositions` — `base + k·(repeat dx)`, the same form `repeat` emits as DuplicateAlongLine, so a pitch sweep moves replicas AND the snapped child together); Alt-drag offers replica anchors (`buildAltDragTargetIndex` takes an optional `instances` arg and appends replica anchor candidates carrying `instanceIdx`; `instances=null` ⇒ byte-identical base-only index, keeping the perf-equivalence oracle green). `instanceIdx` lives ONLY on `from` (the target): the child is still one component placed by one snap, so the one-snap-per-child / duplicate-to invariants are untouched (dedupe keys on `to.compId`). pyAEDT/GDS bake from the solver-corrected numeric cx/cy (no parametric work). Scope: `repeat`/`displace` are fully parametric; a replica behind a `rotate`/`mirror` bakes the numeric centroid offset (anchor orientation not tracked — the same accepted "frozen" contract as the vertex path). Out-of-range idx → base anchor + a `dangling-instance` solve diagnostic. The reverse alt-drag direction (replica would become the child) drops the idx. No schema migration — snaps pass through `normalizeScene` verbatim.

**Solver** (`solveLayout`): iteratively propagates snap constraints. Uses a fixed-point iteration with shift-clustering on each snap. After primitive snap propagation, `refreshBooleanBbox` recomputes boolean AABBs inline. A final fixed-point pass picks up any chained position dependencies.

**Cluster drag**: dragging a primitive that's a member of a boolean drags the WHOLE cluster (operands + the boolean) in tandem. Implementation: walk `consumedBy` to find the root boolean, then walk `operandIds` recursively (with a `visitedBooleans` guard to prevent infinite loops in nested boolean structures). All cluster members move with the same delta.

**Alt-drag snap creation**: alt-modifier drag creates a new snap between the dragged component and a target. The candidate target list is computed at drag-init time:
- EXCLUDES cluster siblings (`clusterSet`) so a child can't snap to a sibling within the same boolean cluster
- INCLUDES booleans (a primitive can snap to a boolean's outer perimeter anchor)
- EXCLUDES the dragged component itself

**Snap-anchor reading on booleans** (CRITICAL): the scene model has booleans with literal `w='0'`, `h='0'`. To read a boolean's bbox for snap anchor math, ALWAYS look up the SOLVED instance (from the `solved` array produced by `solveLayout` + `resolveBooleanBboxes`), not the scene component directly. Using `scene.b.w` will give you '0' and snap math will collapse the boolean to a point.

**Hysteresis** on alt-drag: when multiple snap anchor pairs are equidistant from the cursor, the solver could oscillate between them frame-to-frame, creating visual jitter and unstable snap selection. We apply hysteresis: once a snap anchor pair is "stuck", switching requires the cursor to move closer than `stickThresh = worldThresh * 0.5` to another pair. Prevents the bug class where moving the mouse 1px flips the snap selection.

**Snap-graph validation** (`validateSnapGraph`): live check surfaced in the UI; flags `duplicate-to` (two+ snaps target the same component) and dangling compId references. Run it after any programmatic snap surgery.

**Snap discoverability aids** (Canvas render):
- **Alt-held anchor guides**: while Option/Alt is held (and not in add/ruler/snap-mode), faint amber dots show the 9 snap anchors of every instance INCLUDING repeat replicas (sourced from `transformInstances`, viewport-culled, `pointerEvents:none`), so the user can see where an Alt-drag will land. They vanish on Alt release; the dragged cluster's own anchors are skipped.
- **Snap-mode anchor hover-highlight**: in `snapMode==='creating'`, hovering a fixed anchor enlarges it + draws a cyan ring (`#06b6d4`) and sets `snapHover={kind:'anchor', …}` so the preview line locks onto it. `snapHover` now carries a `kind` (`'anchor'`|`'edge'`); the edge hover-dot is gated to `kind==='edge'`.
- **Snap-offset dims on selection**: the violet dimension overlay (the `showDimensions` block) ALSO fires when `editDims && selectedId` — drawing the dx/dy of snaps that involve the selected component (the W/H stay on the cyan EditableDimsOverlay). Reuses the same renderer via a `selOnly` flag (which also skips the comp-W/H loop and filters snaps to the selection). For a replica snap (`from.instanceIdx>0`) the `fromW` anchor is shifted to the replica via `resolveInstanceAnchorNumeric`. NOTE: the shared renderer SKIPS a dim whose label can't fit along its length — small offsets only appear once zoomed in (pre-existing behavior).

## Canvas editing UX (Phase 4)

**On-canvas vertex editing** (Canvas.jsx, helpers exported for tests): the PRIMARY-selected polyline/polyshape shows index-stable vertex handles (from `resolvePolylineVertices`).
- Drag a handle: only rel-numeric vertices are draggable (`isRelNumericVertex` — kind 'rel'/absent with literal dx/dy). `dragVertexPatch` rewrites the dragged vertex's dx/dy AND the follower's, so everything downstream stays fixed (standard CAD semantics). Snap-bound / arc / expression-driven vertices REFUSE with a status-bar reason (`vertexDragBlock`) — edit those in the Inspector.
- Double-click a segment: inserts a rel-numeric vertex splitting that segment, geometry-preserving (`insertVertexInSegment`; refused on spline runs / non-rel followers).
- Alt+click a handle: deletes the vertex, keeping all DOWNSTREAM resolved positions (`deleteVertexFixDownstream`); enforces min vertex count (2 polyline / 3 polyshape).
- Live preview goes through local state; the commit is ONE `updateScene` call.

**Smart alignment guides** (`alignAxis`, exported): PLAIN move-drags only (never Alt-drag — that's parametric snap creation). Per axis, the dragged bbox's L/C/R (or B/C/T) values are tested against every other visible instance's edges/center within a threshold; the smallest delta wins, the position snaps to it (overriding grid snap on that axis), and full-viewport magenta guide lines are drawn for EVERY coordinate that aligns after the shift. This is a numeric literal alignment — the status bar reminds the user it creates no constraint.

**Keyboard shortcuts** (window-level handler; suppressed when focus is in an input/textarea/select):
- `F` fit-all, `⇧F` zoom to selection
- Arrow keys: nudge selection by one grid step (`⇧` = 10×); boolean clusters co-move (`collectNudgeCluster`); snap/cxExpr-bound parts re-solve back onto their constraint (matches drag semantics); world is y-up (ArrowUp = +cy)
- `⌘D` duplicate selection, `⌘A` select all, `Esc` clear selection
- `Delete`/`Backspace` delete, `⌘Z`/`⌘⇧Z` undo/redo (pre-existing)
- `a` while drawing a polyline: toggle arc mode (pre-existing)

**Duplication** (`duplicateIds` + module-scope `cloneSnapsForDuplicate`, exported): copies get `<id>_copy` (then `_copy2`…) ids and a grid-based offset. Snap cloning rules: INTERNAL snaps (both endpoints in the selection) clone fully remapped; EXTERNAL INCOMING snaps (parent outside → child inside) clone with only the `to` side remapped, so the copy hangs off the same external parent; EXTERNAL OUTGOING snaps are DROPPED (cloning would create a duplicate-to violation). Result always passes `validateSnapGraph`.

**PARAMS panel search + grouping**: a search box filters the param list (Esc clears); `groupParamPrefixes` (exported) collapses params sharing a `<prefix>_` (≥4 by default) into sections — keeps template-generated param families (e.g. `cpw_*`, `gsg_*`) manageable.

**Anchor flash** (C10): clicking a from/to anchor label in the SNAPS panel (or inspector snap rows) flashes that anchor dot on the canvas — `flashAnchor = { compId, anchor, nonce }` state; Canvas keys its timeout on the nonce so re-clicks re-flash.

**ExprField** (`src/ui/panels/ExprField.jsx`): THE unified parametric-expression input. Wraps `DeferredTextInput` (draft → commit on Enter/blur, Esc reverts, identifier-prefix autocomplete) with the canonical styling convention: white = literal/multi-term expression, amber = lone param reference ("edits-by-reference"), red border/text = non-evaluating expression (failing expr in the tooltip); optional mini-label above and `= value` readout below; size presets `xs` (snap rows) / `sm` (transform rows) / `md` (Inspector dimension fields). Presentation only — commit semantics and auto-create-param (`commitExpr`) stay caller-owned. Used by the Inspector's `fieldRow`, `SnapConnectionRow`, and `TransformChainEditor`. (`ParamTuner`, the ±multiplicative param slider in ParamRow, is now a permanent feature, no longer EXPERIMENTAL.)

## Canvas spatial indexes (perf)

Hover snap-point lookup and alt-drag candidate search used to be full scans over every instance × anchor per mousemove; they now go through uniform-grid spatial indexes (pure helpers exported from `Canvas.jsx` for tests):

- `buildUniformGrid` / `gridInsert` / `gridQuery` — uniform grid over WORLD coordinates. Cell size from `pickGridCellSize` (≈2× median indexed shape size, clamped) is viewport-independent, so zoom never forces a rebuild. Items insert into every cell their AABB overlaps; queries dedupe by identity and may return a SUPERSET of true matches — callers re-gate with their own exact distance/overlap checks, which is the equivalence contract with the old scans. NaN-bounded items are dropped (matches the old NaN-poisoned comparisons). Huge query boxes (zoomed way out) fall back to scanning occupied cells, bounding the worst case at O(N).
- `buildAnchorSnapIndex` / `queryAnchorSnapIndex` — anchor dots + edge projections (repeats, rotation, boolean operand cells with `instanceIdx`); preserves the old tie order (fixed anchor beats same-distance edge; first-in-enumeration wins).
- `buildAltDragTargetIndex` / `findAltDragSnapCandidate` — alt-drag snap-candidate search with the same rank penalties, cluster/consumed exclusions, and `currentBest` hysteresis input.

Equivalence with the old full scans is enforced by `tests/canvas-perf-helpers.test.js` (probe sweeps + seeded fuzz vs scan oracles). If you touch candidate enumeration, update the oracle in that test too.

## Templates

`src/templates/index.js` exports `BUILTIN_TEMPLATES` — modules of shape `{ id, name, description, insert(prev, { viewport }) => nextScene }`. Insertion adds id-prefixed params + components + snaps to the scene (positions via SNAPS, not literals, so HFSS sweeps stay parametric). The library panel's "Save as built-in template" generates the module source (`_codify.js`); user payload insertion goes through `_library-insert.js`. Current built-ins:
- `builtin_racetrack` — Racetrack resonator
- `builtin_ring_resonator` — Ring resonator
- `builtin_meander_electrode` / `builtin_meander_electrode_horizontal` — meander electrodes
- `builtin_cpw_gsg` — **CPW (G-S-G)**: signal + 2 grounds; `<id>_gap` sweeps both grounds symmetrically via snap dy
- `builtin_gsg_probe_pads` — **GSG probe pads + tapers**: 3 pads + 3 TAPERED polyline tapers (per-segment parametric corner exprs in HFSS) + stubs
- `builtin_idc_comb` — **Interdigitated capacitor**: 2 bus bars + finger combs via parametric `repeat` (HFSS DuplicateAlongLine)

## Parametric cells

Define once, instantiate many, update all (`src/scene/cells.js`):

- **Definition** (`makeCellFromSelection(scene, selectedIds, name)`): a self-contained scene fragment — selected components + INTERNAL snaps (both endpoints inside) + the transitive param closure of every referenced expression. The params ARE the cell's interface (exprs = defaults; closure-only params listed in `internalParamNames`). Positions are normalized so the def is centered on (0, 0). Anything crossing the selection boundary (snaps, `consumedBy`, boolean operands, snap-pinned vertices) is stripped and reported in `warnings`.
- **Instantiation** (`instantiateCell(def, prefix, overrides, atX, atY)`): every def-local identifier — param names AND component ids, including the synthetic `_comp_<id>_*` params — is renamed to `<prefix>_<name>` via `renameIdentInScene` (expression strings) plus a structural id remap (ids, `consumedBy`, `operandIds`, snap endpoints, snap-pinned vertices). Instance knobs become ORDINARY scene params (`<prefix>_*`), which is why HFSS parametricity is free: exporters see plain parametric components and emit one `set_var` per instance param. Override exprs are applied AFTER the prefix walk, verbatim (destination-namespace). Components carry a provenance tag `cellInstance: { cell, inst }`.
- **Update** (`updateInstancesFromCell(scene, def)`): for each tagged instance prefix — capture current `<prefix>_*` exprs (the user's overrides) + bbox center, remove the instance (components, internal snaps, ALL prefixed params), re-instantiate the new def in place re-applying captured exprs where the param survives. Orphaned params and dangling external snaps are dropped; everything is reported in the returned `summary` (drives the confirm dialog). Also writes the def into `scene.cells`.
- **Storage**: defs persist per-workspace under `cellPrefix` (`src/storage/workspace.js`: `listCellDefs`/`loadCellDef`/`saveCellDef`/`deleteCellDef`, bundled into workspace export/import via `library-items.js`) AND embed into `scene.cells` (normalizeScene passthrough) so a shared design brings its cells along. The app overlays `scene.cells` over workspace defs for display.
- **UI**: CELLS section in the library panel — save selection as cell (warnings surfaced), insert instance (prompted prefix, auto-suggested `u<n>`, post-insert hint pointing at the `<prefix>_*` params), update instances (per-instance change summary confirm).

## AI geometry assistant

Natural-language / sketch-image → parametric scene fragment, via the user's own Anthropic API key (✨ header button → `src/ui/AiAssistantDialog.jsx`).

- **`src/ai/assistant.js`** (pure, fully tested — `tests/ai-assistant.test.js`):
  - `buildSystemPrompt(scene, prefix, paramValues)` — teaches Claude THIS app: component schema per kind (numeric cx/cy, expression-string dimensions), vertex model, snap mechanics (9 anchors, parent→child, one-snap-per-child, chains), transforms (repeat/displace/rotate), the parametrize-everything mission, plus a live summary of the CURRENT scene (params, components, stack/conductor ids) so generated geometry can snap onto existing components. Update this whenever the scene schema grows a feature, or Claude won't know about it.
  - `GEOMETRY_TOOL` — Anthropic tool def; the tool input IS the fragment `{ params[], components[], snaps[], notes }`. `tool_choice` stays auto so Claude can answer with a clarifying question (plain text) instead of guessing.
  - `normalizeFragment` → `validateFragment(fragment, scene)` — string-coerce + derive AABBs, then gate: known kinds/layers, required fields per kind, identifier-resolution check on every expression (`tokenizeIdents`, because `evalExpr` falls back to 0 on unknowns), vertex/transform shape checks, snap endpoints + anchors + duplicate-to (against existing scene snaps too; new snaps may not re-position EXISTING components), then a trial `validateSnapGraph` + `solveLayout` on the merged scene. Errors block insert; warnings don't.
  - `applyFragment(prev, fragment, {viewport, paramValues})` — template-insert semantics (id collision-rename incl. snap + snap-vertex remap, params merge with scene-wins, bbox centered on viewport) finished by `normalizeScene`. One `updateScene` call = one undo step.
  - `suggestPrefix(scene)` — next free `ai<N>`; ALL new ids/params must carry it (HFSS parametricity is then free, and the PARAMS panel groups `ai<N>_*` automatically).
- **`src/ai/client.js`** — browser-direct Anthropic call (`dangerouslyAllowBrowser`, SDK lazy-imported into its own chunk); models claude-opus-4-8 (default) / sonnet-4-6 / haiku-4-5; adaptive thinking except haiku; typed-error → friendly message mapping; `fileToImagePayload` downscales sketches to ≤1568 px and flattens transparency onto white.
- **`src/ai/settings.js`** — API key + model in `localStorage` ONLY (key `photonic_layout_ai_settings`, outside every workspace prefix), so the key can never ride along in design/workspace exports or generated scripts. Never log it, never embed it in exports.

## Settings & appearance themes

User preferences + appearance themes, via the ⚙ header button (between Workspace and the AI ✨ button → `src/ui/SettingsPanel.jsx`).

- **`src/ui/settings.js`** (pure except localStorage I/O, fully tested — `tests/settings.test.js`): `DEFAULT_SETTINGS` = `{ theme, showDimensionsOnSelect (default ON — the renamed `editDims`), showDimensionsOverlay, gridVisible, gridSnap, gridSize }`. Persisted under its OWN key `photonic_layout_settings` (outside workspace prefixes, so it never rides along in design/workspace exports — same isolation rationale as the AI key, which is deliberately NOT folded in). `loadSettings` merges over defaults and, on first run (no settings key yet), migrates the legacy `photonic_layout_edit_dims` toggle into `showDimensionsOnSelect`. `parseSettingsImport` is a PARTIAL import: only keys that are present AND pass per-key validation are applied (merged over the CURRENT settings, not defaults), so a JSON missing a setting leaves that setting untouched. `buildSettingsExport` emits `{ format:'photonic-layout-settings', version, exportedAt, settings }` (whitelisted keys only).
- **`src/ui/theme.js`** — `THEMES` (`default`/`midnight`/`blueprint`/`paper`), `THEME_ORDER`, `resolveCanvasTheme(id)`, `applyThemeAttr(id, doc)`. Two surfaces are themed:
  1. **Chrome** (panels/header/dialogs) — Tailwind `*-slate-*` utilities + a handful of var-ified inline styles. `src/index.css` has a `@theme inline` block remapping `--color-slate-*` → `--app-slate-*`, plus `:root` (default ramp) and `[data-theme="…"]` override blocks. So selecting a theme only sets the `data-theme` attribute on `<html>` (via `applyThemeAttr`) and CSS does the recolor with ZERO class rewrites. Inline chrome hexes were converted to `var(--app-slate-…)` — but ONLY single-quoted style-object values; double-quoted SVG attributes (the logo, geometry/layer colors) are intentionally left literal, as are dark-text-on-accent values and the over-canvas status pill. `paper` is the only LIGHT chrome — its `[data-theme="paper"]` block inverts the slate ramp by role and darkens a few accent tokens for legibility on white.
  2. **Canvas** (the SVG background/grid/axes) — painted as string-literal hex on SVG attributes, so it can't ride the CSS remap. The active theme's `canvas` object is threaded into `<Canvas>` as the `canvasTheme` prop (`DEFAULT_CANVAS_THEME` fallback keeps default render/tests byte-identical). `midnight`/`blueprint` are the dark-canvas themes. Cutout rects also read `canvasTheme.canvasBg` (they paint the bg to read as removed material). Interaction accents (snap amber, halo cyan, dimension violet) stay constant — tuned for contrast on any background.
- `index.html` sets `data-theme` from the saved settings before React mounts (no chrome flash). The figure exporters (`handleExportSVG`/`handleExportPDF`) thread `canvasTheme.canvasBg` through `options.background` so exported figures match the on-screen canvas.
- **CAUTION for future edits:** do NOT mutate `src/PhotonicLayout.jsx` via a Bash script and then use the Edit tool — the Edit tool's in-memory snapshot will clobber the Bash writes. Re-Read the file first, or do all mutations through one mechanism.

## Rendering

Canvas uses SVG with `y-up world → y-down screen` transform.

**Per-component standard renderer** dispatches on shape kind:
- `rect`: `<rect>` with rotation wrapper; positive `cornerRadius` renders via the SVG `rx` attribute, clamped by the SAME `clampCornerRadius` rings.js uses (exact match to the HFSS arc geometry)
- `circle`: `<circle>`
- `ellipse`: `<ellipse>`
- `polygon`: `<polygon>` from tessellated ring (rotation baked into ring, no wrapper rotation)
- `racetrack`: `<path>` of the centerline, stroked with `stroke-width=wgWidth`, `fill=none` (browser draws the band)
- `polyline`: `<path>` of the TESSELLATED centerline (`tessellatePolylinePath` — arcs/splines expanded), stroked at the trace width; TAPERED polylines instead render filled per-segment quads from `taperedBandQuads` (SVG strokes can't vary width — the quads exactly match the HFSS per-segment sheets)
- `polyshape`: filled `<path>` of the tessellated perimeter + `Z`
- `via`: plan-view `<circle>` in the via layer style + a small center dot (reads as "vertical connection"); tooltip names the spanned stack layers; renders ABOVE electrodes

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

**Per-layer Z (`layerZ` walk, mirrored numerically in pyAEDT's `numericLayerZ`)**: the stack is grouped by `coplanarGroup` id (NOT device role). Adjacent layers sharing a group id are coplanar — they share `zBottom`; the cursor advances past a group by its **cladding top** (`advanceLayerOf` = thickest cladding member, else thickest member for a malformed group with no cladding), so a layer ABOVE a coplanar group (e.g. a conductor in a different/no group) starts at the group's cladding top, not its `zBottom`. Layers with no `coplanarGroup` stack sequentially. Both walks `migrateStackCoplanarGroups` the stack first (defensive — matches in-app normalization), and pin Z=0 at the first device-role or grouped layer (substrates below go negative). The advance is the cladding's own `thicknessExpr`, so single-cladding groups (the norm) are parametrically exact under sweeps.

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
node tests/test_polyshape.mjs
node tests/test_racetrack.mjs
node tests/test_racetrack_export.mjs
node tests/test_edge_stickiness.mjs

# Full vitest suite (covers everything below; run targeted files while iterating)
npx vitest run
#   tests/curved-paths.test.js        — arc/spline/taper vertex model (geometry + solver + walkers)
#   tests/fillet-via.test.js          — rect cornerRadius + via component (rings, schema, walkers)
#   tests/rotation_zoffset.test.js    — first-class rotation + per-component zOffset
#   tests/sweep-ui.test.js            — analysis setup / frequency sweep / Optimetrics emission
#   tests/solver_guards.test.js       — NaN guards, snap-graph validation
#   tests/rename-ident.test.js        — rename walker over every expression field
#   tests/exports.test.js             — export emission + Python AST checks (incl. cross-feature
#                                       interactions: rotated rounded rect, via vs zOffset,
#                                       tapered polyline with snap-bound vertex)
#   tests/boolean_render.test.js      — boolean mask composition (incl. polyshape arc operand)
#   tests/templates.test.js           — built-in template registry + insert/solve/export for every
#                                       template (incl. CPW gap parametricity, taper corner exprs,
#                                       IDC repeat emission); _codify/_library-insert round-trips
#   tests/canvas-vertex-edit.test.js  — vertex drag/insert/delete helpers, drag-block reasons,
#                                       alignAxis smart-guide math
#   tests/keyboard-dup-params.test.js — nudge cluster expansion, cloneSnapsForDuplicate rules,
#                                       groupParamPrefixes param-section grouping
#   tests/posexpr-pivot.test.js       — cxExpr/cyExpr solver + export behavior, custom rotate pivots
#   tests/cells.test.js               — parametric cells: selection→def (warnings, param closure),
#                                       prefix instantiation, two-instance coexistence + HFSS set_var
#                                       parametricity, update-from-master, workspace storage round-trip
#   tests/canvas-perf-helpers.test.js — uniform-grid spatial index + anchor-snap / alt-drag index
#                                       EQUIVALENCE vs the old full-scan oracles (probe sweeps +
#                                       seeded fuzz), boolean-operand cells, tie-order preservation
#   tests/ai-assistant.test.js        — AI geometry assistant deterministic half: prefix alloc,
#                                       system-prompt scene context, fragment normalize/validate
#                                       (every error category), applyFragment → solve + snap-graph
#                                       + HFSS set_var parametricity, collision rename incl. snap
#                                       vertices (network call NOT covered — browser-only)
# (plus per-module unit files: anchors, geometry, params, schema, solver, transforms, versions)

# Production build
npm run build
```

All four drag scenarios should produce position outputs matching the expected positions encoded in each test.

## Rejected directions (do not re-propose without strong evidence)

- ~~Vision LLM sketch parsing~~ — SUPERSEDED: the user explicitly requested it; shipped as the AI geometry assistant (see that section). The rejection was about auto-parsing sketches into exact geometry; the shipped form generates a *parametric fragment* that is validated and user-confirmed before insert.
- Per-axis snaps (separate X and Y constraint dimensions)
- Soft constraints / least-squares solver
- Martinez-Rueda polygon clipper inline (boolean ops via SVG mask is sufficient)
- snap-offset drag (dragging child updates dx/dy of the snap, rather than moving the child)
- Dedicated BOOL tab in the inspector

## User style

Concise direct messages. Engineer-minded. Wants things to actually work. Based in Denver, working on TFLN/TFLT photonic IC RF structures. Doesn't want overly verbose answers — get to the point, ship the change, then summarize what was done.
