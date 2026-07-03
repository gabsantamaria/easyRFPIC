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
  rotation?,   // OPTIONAL expression (degrees, CCW) on rect/circle/ellipse/
               // polygon/bridge. Absent or '0' = none. Seeds the base
               // instance's rotation in expandTransforms; chain rotates ADD
               // to it. Anchors/snap dots rotate with the shape (anchorWorld
               // / anchorLocalRotated). CRITICAL: anchors.js ROTATABLE_KINDS
               // must stay IDENTICAL to hfss-native's HFSS_ROTATABLE_KINDS —
               // a kind in only one set makes the solver and the HFSS
               // parametric snap chain disagree about where a snapped child
               // sits (bridge was missing app-side: canvas placed the child
               // at the unrotated anchor while HFSS built it rotated).
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
//   'bridge':     length, width, height, thickness?, padLength?,
//                              conductorLayerId?
//                              (RF AIRBRIDGE: conductor strap taking off at
//                              the bound conductor layer's TOP, arcing up by
//                              `height` and landing `length` away; layer=
//                              'bridge'; w/h derived '(length)'×'(width)' so
//                              the plan-view footprint feeds snaps/rings/GDS
//                              via the rect fallback. thickness '' = the
//                              conductor layer's thickness. padLength
//                              (default '0') adds flat LANDING PADS — strap
//                              metal extending padLength beyond EACH end of
//                              the span on the conductor top; pads are EXTRA
//                              geometry outside the AABB (snaps keep the
//                              span bbox): canvas draws dimmer pad rects,
//                              HFSS gains parametric flat Line profile
//                              segments (solid AND sheet modes; emission
//                              gated on the CURRENT numeric > 0), pyAEDT/3-D
//                              extend the numeric profile, GDS layer 150
//                              emits (length+2·padLength)×width. New inserts
//                              seed `<id>_P` = 5 µm; the Inspector "pad
//                              (landing)" field edits it. HFSS native: ONE
//                              covered+closed CreatePolyline in the vertical
//                              plane at Y=(cy)-(W)/2 — lower/upper 3-point
//                              Spline arches + Line risers, ALL coordinates
//                              parametric (snap-chain center set_vars,
//                              conductor-top zTopExpr) — swept along +Y by
//                              the parametric width; h_cond=0 ⇒ open-spline
//                              SHEET joining the PEC_sheets impedance
//                              boundary. Strap thickness is measured
//                              VERTICALLY (exact at landings, ~cos(slope)
//                              thinner on the flanks). rotation KEPT (D6
//                              sandwich in HFSS); zOffset/cornerRadius
//                              stripped. GDS = footprint on layer 150;
//                              pyAEDT = numeric parabola profile + sweep;
//                              gdsfactory skips it. SCOPE: NOT a valid
//                              boolean operand (createBoolean blocks it);
//                              excluded from the 2-line/Q3D conductor picker
//                              by the layer==='electrode' filter)
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

**Snap to a transform instance** (`from.instanceIdx`): an OPTIONAL integer (`>= 0`) on the `from` endpoint targets a specific RENDERED instance produced by the parent's transform chain — including instance 0. idx-0 matters because chains that MOVE the base instance (rotate-about-centroid, `duplicate_mirror`, `displace`) put instance 0 away from the raw cx/cy — a meander's "last cell" is such an instance-0. The one source of truth is `anchorLocalInstance(anchor, w, h, rotDeg, sx, sy)` (`anchors.js`): mirror scale FIRST, then rotation — matching `expandTransforms` / rings exactly, so the anchor NAME lands on the rendered corner even when a 180° rotate / mirror flips which corner that is. EVERY consumer resolves the instance anchor the SAME way — the canvas Alt-guides, the alt-drag target index, the snap-mode instance dots (NEW: snap mode used to show only base/displayBbox anchors, so a repeated/rotated cluster's cells had NO clickable anchors — now it enumerates the same instances the Alt guides do), `resolveInstanceAnchorNumeric`, the solver's `from.instanceIdx` branch (expands the owner chain, anchors in the instance frame), and the HFSS export. A LEGACY snap WITHOUT `instanceIdx` keeps base/displayBbox-perimeter semantics (unchanged). The alt-drag index and snap dots offer instance-0 candidates ONLY when the chain moved it (unmoved bases stay byte-identical — the perf oracle + `snap-to-replica` contract test enforce that base records carry NO idx). HFSS parametricity: translation-only chains stay fully parametric via `instanceChainOffsetExpr` (base + k·pitch = the DuplicateAlongLine form); rotate/mirror chains FREEZE the exact rendered from-anchor as a numeric term (the anchor's orientation flip isn't a clean base-anchor + translation). `instanceChainOffsetExpr` gained `angleMode`: 'hfss' emits `((angle))*1deg` (a HFSS quantity — bare `cos(param)` would be RADIANS), 'numeric' emits `((angle)*pi/180)` so `evalExpr` can resolve it — the old `cos(180deg)` form was UNEVALUABLE by evalExpr, silently zeroing every numeric rotate-chain offset (the root cause: replica snaps on rotated meanders collapsed to the base anchor). It reuses the SAME machinery polyline snap-vertices use (`src/scene/instance-positions.js`: `instanceChainOffsetExpr` / `chainOwnerForInstance`). Three layers learn it: the solver shifts the reference anchor by the numeric base→instance-k chain offset (`solver.js`, evaluated from `instanceChainOffsetExpr`); the native HFSS export adds that offset PARAMETRICALLY at the snap consumer (`computeParametricPositions` — `base + k·(repeat dx)`, the same form `repeat` emits as DuplicateAlongLine, so a pitch sweep moves replicas AND the snapped child together); Alt-drag offers replica anchors (`buildAltDragTargetIndex` takes an optional `instances` arg and appends replica anchor candidates carrying `instanceIdx`; `instances=null` ⇒ byte-identical base-only index, keeping the perf-equivalence oracle green). `instanceIdx` lives ONLY on `from` (the target): the child is still one component placed by one snap, so the one-snap-per-child / duplicate-to invariants are untouched (dedupe keys on `to.compId`). pyAEDT/GDS bake from the solver-corrected numeric cx/cy (no parametric work). Scope: `repeat`/`displace` are fully parametric; a replica behind a `rotate`/`mirror` bakes the numeric centroid offset (anchor orientation not tracked — the same accepted "frozen" contract as the vertex path). Out-of-range idx → base anchor + a `dangling-instance` solve diagnostic. The reverse alt-drag direction (replica would become the child) drops the idx. No schema migration — snaps pass through `normalizeScene` verbatim.

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
- **Editable snap-offset dims on selection** (`EditableSnapDims`): when `editDims && selectedId` (and the global `showDimensions` overlay is off), the dx/dy of the snap that POSITIONS the selected component (the selected comp is the snap's `to`) render as EDITABLE violet fields — the gap reads/edits on the part the snap places, not the reference it attaches to, so it isn't duplicated — a screen-space portal overlay parallel to `EditableDimsOverlay` (the cyan W/H editor), reusing `DimEditField` + the same param-vs-expression logic: a lone-param offset shows NAME + VALUE fields (rename / edit the param scene-wide), a literal/expression offset shows one field that commits to the snap's `dx`/`dy` (auto-creating referenced params via `commitExpr`). Real DOM inputs at constant screen size, so — unlike the read-only world-space `showDimensions` overlay (which SKIPS dims whose label can't fit, hiding small offsets until zoomed in) — they're always visible/editable. Replica snaps (`from.instanceIdx>0`) measure from the replica anchor via `resolveInstanceAnchorNumeric`. The global `showDimensions` block stays read-only (and keeps the replica-anchor `fromW` shift for its own snap dims).

## Canvas editing UX (Phase 4)

**On-canvas vertex editing** (Canvas.jsx, helpers exported for tests): the PRIMARY-selected polyline/polyshape shows index-stable vertex handles (from `resolvePolylineVertices`).
- Drag a handle: only rel-numeric vertices are draggable (`isRelNumericVertex` — kind 'rel'/absent with literal dx/dy). `dragVertexPatch` rewrites the dragged vertex's dx/dy AND the follower's, so everything downstream stays fixed (standard CAD semantics). Snap-bound / arc / expression-driven vertices REFUSE with a status-bar reason (`vertexDragBlock`) — edit those in the Inspector.
- Double-click a segment: inserts a rel-numeric vertex splitting that segment, geometry-preserving (`insertVertexInSegment`; refused on spline runs / non-rel followers).
- Alt+click a handle: deletes the vertex, keeping all DOWNSTREAM resolved positions (`deleteVertexFixDownstream`); enforces min vertex count (2 polyline / 3 polyshape).
- Live preview goes through local state; the commit is ONE `updateScene` call.

**Rotation-aware selection + resize**: the primary selection's resize
handles sit on the ROTATED shape's corners/edges (`anchorLocalRotated` +
`compRotationDeg` — same math as the snap dots), and the resize drag
projects the pointer delta into the shape's LOCAL frame (`drag.rot`
captured at init; center shift accumulated locally, rotated back to
world; reduces EXACTLY to the old world-axis math at rot 0). The
grid-snap-the-dragged-anchor refinement and the expr-bound cx/cy commit
restores are rot-0-only (neither is axis-separable once rotated; the
local shift is zeroed for bound axes at any angle instead).

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

## 2-line method wizard (εeff / α extraction)

Marks' 2-line/TRL eigenvalue method (IEEE-MTT 1991) automated end-to-end: the
user draws a SINGLE transmission line, the wizard stamps it at two lengths, and
the generated native HFSS script extracts the effective permittivity εeff and
attenuation α **entirely in HFSS** (no MATLAB/external step). Export menu →
"2-line method (εeff & α)".

- **`src/scene/twoLine.js`** (pure, fully tested — `tests/two-line.test.js`):
  - `buildTwoLineScene(scene, cfg)` — reuses the parametric-cell machinery
    (`makeCellFromSelection` over ALL components → `instantiateCell` twice) to
    stamp the line as `lineA` (length override `tl_L1`) and `lineB` (`tl_L2`),
    offset by `cfg.separation` (auto ≈ 3× bbox span if blank). `lineA`'s
    components are merged BEFORE `lineB`'s — because HFSS numbers lumped ports in
    creation (= component) order, this fixes the S-indices to 1,2 (line A) and
    3,4 (line B). Injects top-level params `tl_L1`/`tl_L2`/`tl_dL` (`tl_dL =
    tl_L2 − tl_L1`, kept LIVE so the lengths stay HFSS-sweepable) and sets an
    **Interpolating** sweep (the εeff/α/Z0 extraction runs on the interpolated
    S(i,j) — faster than per-point Discrete, fine for a smooth TL). Also bakes the
    wizard's **min/max adaptive passes** into `simSetup.minPasses`/`maxPasses`
    (clamped min≤max) so the HFSS solve uses the SAME pass budget as the bundled
    Q3D CG solve (`generateHfssNative` emits `MinimumPasses`/`MaximumPasses` from
    those; default MinimumPasses=1 for non-2-line exports). VERIFIES the contract
    before returning: exactly 4 ports,
    grouped (A,A,B,B) in solved order, all equal reference impedance — else
    throws a user-facing Error. Returns `{ scene, portIndices:{a1,a2,b1,b2},
    portNames, warnings }`.
    - **Preserves the design's params** (`...src.params` FIRST in the combined
      params): the cell closure only captures params referenced by component
      EXPRESSIONS, so stack thickness params (h_cond, h_wg, …) that nothing
      references aren't in instA/instB.params. Dropping them let normalizeScene
      re-inject STACK DEFAULTS — silently turning a design's `h_cond=0` into
      `0.8`, which both showed the wrong thickness AND skipped the
      zero-thickness conductor → 2-D impedance-sheet path (the `PEC_sheets`
      near-PEC boundary, R=0.001). Always merge `src.params` under the tl_/cell
      params.
    - **Replica flattening + port auto-enable (wizard-only)**: real single-line
      designs place their two ports by REPEATING one port component (and the
      boolean feed that flanks it), and often leave the lumped-port flag off.
      The exporter emits one port per port COMPONENT at its base, and the
      adjacency detector can't see a flanker that exists only as a repeated
      boolean — so a repeat-built "line with two ports" would yield ONE
      detectable port. So buildTwoLineScene SOLVES the combined scene, then
      `flattenReplicas` materializes every translation replica (repeat/displace)
      — including a boolean's whole operand cluster — into distinct STATIC
      components, remapping cross-cluster refs (a punch clone's `cloneOf`
      pointing at the port) to the SAME replica index via a global registry;
      then `autoEnableFlankedPorts` enables a lumped port on every port-layer
      rect the detector flanks. **Flattened operand POSITIONS stay PARAMETRIC**:
      `buildTwoLineScene` computes `pp = computeParametricPositions(solved, snaps,
      pv)` (the SAME snap-DAG walker the HFSS export uses, imported from
      `hfss-native.js` — a call-time-only import cycle) and passes it to
      `flattenReplicas`, which sets `cxExpr`/`cyExpr` ONLY on operands consumed by
      a multi-operand UNION boolean (the meander CELLS — the geometry that
      deforms) = the operand's parametric snap-chain position + the SYMBOLIC
      replica offset (`k·pitch`, from `translationOffsets`' new `dxExpr`/`dyExpr`).
      The export reads these (the operand has no snap and its boolean has no
      incoming snap → "free root" → `rootPosExpr` honors `cxExpr`/`cyExpr`), so the
      meander cell geometry is FULLY parametric in HFSS — changing a cell dimension
      repositions the bars (and the inter-cell pitch tracks cell_w+cell_s) instead
      of just resizing them about baked centers (the "cells deform in HFSS" bug).
      The numeric `cx`/`cy` stay baked (solver/port-detection fallback; the expr
      evaluates to EXACTLY the baked value at the current params, so geometry is
      unchanged there). The line LENGTH (cell COUNT) is still fixed (the method
      uses two FIXED lengths). **SCOPE is union-cells ONLY — standalone components,
      lumped PORTS, and punch/subtract operands (feeds, port holes) stay BAKED.**
      A lumped port's sheet is created at the component position but its
      integration line is emitted as BAKED numeric endpoints (it does NOT track
      params), so parametrizing a port sheet DESYNCED them → HFSS rejected every
      replica port ("Both endpoints of port lines must lie on the port") and
      cascaded into every `S(i,j)` output variable failing (`'S' is not a function
      name` — only 2 of 4 ports survived). Keeping the port + feed baked keeps the
      sheet and integration line byte-consistent. Booleans get no `cxExpr` (their
      AABB derives from operands); the Q3D baker calls `flattenReplicas` WITHOUT
      `pp` (numeric, as before). CAVEAT: a mirrored boolean's mirror PLANE is the union-boolean
      centroid, which can't be expressed parametrically (needs min/max over
      operands) → it's baked at the current centroid. Operands still reposition
      parametrically (cells don't deform); only a param that shifts the cell's
      cross-section centroid would shift the mirrored line under sweep (for a
      symmetric meander, cell_h leaves the centroid invariant, so it's exact).
      Rotate transforms are left intact + warned (rare on the port path). In-place `mirror` /
      `duplicate_mirror` transforms are PRESERVED on each materialized replica's
      root (only repeat/displace are baked into positions via `keepForExport`),
      so the exporter emits its (origin-sandwich) Mirror PER replica — reflecting
      the actual united geometry, correct for any operand shape. Dropping them was
      a real bug: a meander line whose copy is mirror-flipped exported UN-mirrored
      in HFSS (no Mirror command at all in the modeler tree). The shared
      exporter/detector are UNTOUCHED. `buildTwoLineScene` returns `dLMeters`
      (Δl in metres) alongside `portIndices` for the exporter.
    - **Δl is the ACTUAL physical length difference**, NOT `L2 − L1` of the raw
      param values. When the length param is a unit-cell COUNT N (not a µm
      length), `L2 − L1` is a count difference, so Δl would be wrong (εeff off by
      that ratio², α by the ratio). `cfg.lengthExpr` (default = the length param;
      from the wizard's "Actual line length" field) gives the µm length as a
      function of the param; buildTwoLineScene evaluates it with the param = l1
      and = l2 (re-resolving the param closure so DERIVED params like `TL_L =
      N·pitch` update) and differences. This SAME `lengthExpr` is COMMON to εeff/α
      (Δl), Z₀ (via the per-length C), and Q3D (`q3d_line_len_um`).
  - `twoLineOutputVariables(pi, dLMeters)` — the ORDERED list of HFSS Output
    Variables (dependency order; each `{name, expr, note}`) implementing the
    extraction: per-line wave-cascade T from its 2-port S-block (T11=−detS/S21,
    …), `M = T_B·T_A⁻¹`, eigenvalue `λ = (trM+√(trM²−4detM))/2 = e^∓γΔl`,
    `γ = −ln(λ)/Δl`. KEY simplification (no sign/branch `if()` needed in HFSS):
    εeff is EVEN in γ ⇒ `tl_eeff = (c/ω)²(im(γ)²−re(γ)²)`, and α is `abs(re(γ))`.
    Uses HFSS report syntax (`S(i,j)`, `re/im/abs/ln/sqrt`, `pi`, reserved `Freq`
    in Hz). **UNITS (critical):** `tl_DeltaL_m` is a baked numeric LITERAL in
    METRES — it does NOT reference the `tl_dL` design variable. A length design
    variable resolves to its SI value (metres) inside a report/output
    expression, so `tl_dL*1e-6` double-converts and inflated εeff by ~1e12 and α
    by ~1e6 (a real bug we shipped and fixed). `Freq` resolving in Hz is
    likewise assumed; if a future AEDT changes either, εeff/α scale by a clean
    power of ten — check this row first. **Update this if the S-index convention
    or HFSS expr engine changes.**
  - `twoLineExtractNumeric(SA, SB, dLmeters, fHz)` — full complex-arithmetic
    reference impl mirroring the exprs EXACTLY (for unit tests); verified to
    recover γ/α/εeff from synthetic ideal-line S-parameters.
  - `findLumpedPortOrder(solved, pv)` — replicates the exporter's port filter
    (`hfss-native.js`) over the solved list to discover the port order.
- **Z₀ (optional, `includeZ0`)**: `twoLineOutputVariables(pi, dLMeters, includeZ0)`
  appends `tl_Z0_re/_im/_mag` referencing `tl_C_F_per_m`, which the exporter emits
  as a **POST-PROCESSING variable** (`_tl_pp_var` helper → `ChangeProperty` on
  `LocalVariableTab` with `PropType:="PostProcessingVariableProp"`; updates use
  `ChangedProps`, no PropType). Because C only scales the report-only Z₀ output
  vars, editing it AFTER a solve re-scales the reports with **no re-solve / no
  lost solution** — a normal design variable would dirty the field solution
  (`_tl_pp_var` falls back to `set_var` if a release rejects the PP PropType):
  `Z0 = γ/(jωC)` ⇒ Re=β/(ωC), Im=−α/(ωC). **Sign-free (critical):** the
  eigenvalue method resolves γ only up to a GLOBAL SIGN (the two eigenvalues are
  e^±γΔl), so `tl_Z0_re`/`tl_Z0_im` MUST take magnitudes —
  `Re=abs(im γ)/(ωC)`, `Im=−abs(re γ)/(ωC)` — else Re Z₀ comes out NEGATIVE on the
  off branch (a real bug we shipped + fixed; εeff is even in γ and α already uses
  abs, but Z₀ needs the same). Physical: α=re γ≥0, β=im γ≥0 ⇒ Re Z₀>0, Im Z₀≤0.
  (The 2π β-wrap caveat is separate.) C is
  electrostatic ⇒ kinetic-inductance-correct. The 2-line method gives γ ONLY
  (εeff fixes √(LC); Z₀ needs L/C) — so Z₀ requires an independent C. For a
  MEANDER there's no cross-section, so C comes from a full-3-D Q3D solve (below).
- **Exporter hook**: `generateHfssNative(scene, pv, { twoLine: { portIndices,
  dLMeters, cFperM, q3d } })` emits, before `oProject.Save()` (non-append
  branch), an `OutputVariable` block + `ReportSetup` `CreateReport`s ("eeff vs
  Freq", "alpha vs Freq", and "Z0 vs Freq" when Z₀ is on), plus a COMMENTED
  IronPython CSV fallback. Z₀ is on when `cFperM>0` OR `q3d` is present; it emits
  `set_var("tl_C_F_per_m", <manual C | placeholder>)`. `q3d = { scene,
  conductorIds }` appends a Q3D capacitance design IN THE SAME PROJECT (via
  `generateQ3DCombinedBlock`) built from the SINGLE-line scene — so one script
  builds both designs. No `twoLine` option → byte-identical.
- **Q3D capacitance (`src/export/q3d.js`)**: `generateQ3DCapacitance(scene, pv,
  {conductorIds, thicknessUm, lengthUm, freqStartGHz, freqStopGHz, freqPoints,
  designName})` = a SEPARATE Q3D script (own project);
  `generateQ3DCombinedBlock(...)` = a Python block adding a Q3D design to the
  EXISTING 2-line project (own `q3d_*` helpers; reuses the project's materials),
  with a COMMENTED auto-transfer that sets `tl_C_F_per_m` on the HFSS design
  (off by default so a mis-parsed matrix can't silently corrupt Z₀). Both share
  `buildQ3DBody`. Conductors are **THIN CONDUCTORS** — a covered sheet swept up
  (`SweepAlongVector`) by `q3d_cond_thk` (= `h_cond`, or a wizard value when
  `h_cond=0`). **PARAMETRIC**: scene params are declared as Q3D design variables
  and the rects + dielectric Z are emitted as expressions referencing them —
  rect size from the component w/h, inter-strip gap from the `repeat` offset
  (`parametricOffsets`), stack Z from `computeLayerZ`'s `zBottomExpr`, plus
  `q3d_cond_thk` and `q3d_line_len_um` — so width/gap/thickness/dielectric sweep
  in Q3D and re-Analyze. Non-rect / rotated conductors fall back to baked numeric
  geometry. **Each physical conductor's operand sheets are UNITED into ONE solid**
  (`<uniteFn>` helper → guarded `oEditor.Unite`, existence-filtered to dodge the
  uncatchable modal-error trap, `KeepOriginals:=False` so the FIRST sheet's name
  survives). Touching/overlapping operand sheets (a meander's rails+frames+bars, or
  adjacent repeat cells) otherwise leave internal intersection faces that Q3D won't
  mesh until the user Unites them by hand — so the script does it automatically. A
  one-sheet conductor skips the Unite. **Nets are grouped by CONDUCTOR COMPONENT**,
  NOT per sheet: each selected component gets ONE `AssignSignalNet` referencing the
  single united survivor (`["NAME:net_<cid>", "Objects:=", ["<cid>_b0"]]` — the
  Unite ran first, so the other sheet names are consumed; the per-conductor
  `finalizeConductor` emits the Unite then points the net at `<cid>_b0`). A meander
  that expands via `repeat` into many sheets is therefore ONE solid + ONE net, so
  the C matrix is conductor-to-conductor and the differential formula (which assumes
  exactly 2 nets) holds. (One-net-PER-SHEET was a real bug — it made the matrix N×N
  and broke the formula.) Emits a
  capacitance setup (with wizard CG convergence controls — `PerError` %,
  `MinPass`, `MaxPass`, defaults 0.01/15/20) + a **frequency sweep**
  (`InsertSweep`, same band as the 2-line wizard). The C result comes out TWO
  ways: (1) a **"C per length (F/m)" PLOT auto-created BEFORE the `Analyze`** (so
  with "Real time" update it populates live during the solve — defining the trace
  needs no solved data, only the nets + the `Setup1 : Sweep1` solution name) via
  `oReportSetup.CreateReport(name, "Matrix", "Rectangular Plot", "Setup1 :
  Sweep1", ["Context:=","Original"], ["Freq:=",["All"]], ["X Component:=","Freq","Y
  Component:=",[<expr>]])` whose Y is `((C(a,a)+C(b,b))/2 − C(a,b))/2 /
  q3d_line_len_um`; then SOLVES (`Analyze`); and (2) **EXPORTS the C matrix to
  `<project>/<design>_Cmatrix.csv`** (post-solve) via `oDesign.ExportMatrixData(
  file, "C", "", "Setup1 : LastAdaptive", "Original", "ohm","nH","fF","mSie",
  <fHz>, "Maxwell, Spice, Couple", 0, False)` (the 13-arg AEDT-2023 form;
  `problem_type="C"` for 3-D Q3D, NOT `"CG"`; freq is numeric Hz). **CRITICAL distinction:** the post-processing REPORT
  engine (`ReportSetup`) DOES accept `C(net,net)` arithmetic and resolves it in SI
  **Farads**. The report divides by the Q3D VARIABLE `q3d_line_len_um` (the ACTUAL
  line length), NOT a baked literal, so the plot **TRACKS geometry sweeps**.
  `q3d_line_len_um` is declared from the wizard's "Actual line length" field — an
  EXPRESSION (default = the Length parameter; for a swept unit-cell COUNT the user
  enters the length formula, e.g. `N*(cell_w+cell_s)`). It's emitted LENGTH-TYPED
  (a bare number → `"<n>um"`, an expression as-is) so it resolves to SI metres in
  the report ⇒ `C[F]/len[m] = F/m`. Off by ~1e15 ⇒ C resolved in fF (use the CSV);
  off by ~1e6 ⇒ `q3d_line_len_um` resolved in µm not metres (it's not length-typed
  — don't pass a bare count). The one-shot auto-transfer still bakes the numeric
  length (`evalExpr(lengthExpr)`) since it's a single scalar set on the HFSS var. It is only the DESIGN
  output-variable parser that rejects `C(...)` as "'C' is not a function name"
  ("C Matrix" report category ⇒ report type string `"Matrix"`, NOT "C Matrix").
  The matrix is also visible under Results → Solution Data → Matrix. The line C is
  the **DIFFERENTIAL** capacitance `((C11+C22)/2 − C12)/2` (the port drives the
  strips differentially), NOT `|C12|`; `÷ length(m)` — VERIFY the length for
  meanders. Builds ONLY the SELECTED line conductor(s) (each transform
  instance → its own covered sheet via `shapeInstanceToRing`, at the conductor
  mid-Z) + the dielectric stack boxes over the footprint. **A selected conductor
  may be a BOOLEAN** (a meander electrode is a union of many rects, often with a
  `repeat`): `buildQ3DBody` expands it via `flattenReplicas` (the 2-line helper,
  now exported) — materializing the boolean's whole operand cluster + repeat/
  displace replicas — and emits EVERY operand rect as a numeric-baked sheet, ALL
  under ONE `net_<boolean_id>` (one physical conductor). Operands are grouped to
  their boolean by the replica-remapped `consumedBy` chain (`__r<k>` suffix
  stripped). Boolean geometry is numeric (parametric emission isn't feasible for a
  multi-operand union). An in-place `mirror` on the boolean IS now applied to the
  baked footprint: each operand ring is reflected about its REPLICA's own bbox
  centroid (pivot C) — or the origin (pivot origin) — matching the per-replica
  Mirror the HFSS exporter emits; reflecting ring POINTS is exact for any operand
  shape. (`rotate`/`duplicate_mirror` are still NOT materialized → a `# WARNING`.)
  The wizard's
  conductor picker therefore lists TOP-LEVEL electrode objects (`layer ===
  'electrode' && !consumedBy` — booleans INCLUDED, consumed operands hidden) so
  the user can pick the whole meander. Feeds/launches are EXCLUDED on purpose
  (they bridge the conductors across the port gap → would short the nets
  electrostatically). The user solves, reads the
  conductor-to-conductor C (from the CSV or the matrix), ÷ physical length →
  pastes C (F/m) back into the wizard. **Resilience (the "abnormal script
  termination" fix):** in AEDT IronPython a MODAL COM error (e.g. deleting a
  non-existent object) is UNCATCHABLE by `try/except` — it aborts the script
  macro. So the pre-create `_del` helper is gated by an existence check
  (`GetObjectsInGroup` over Solids/Sheets/Unclassified) — on a freshly-inserted
  design nothing exists, so it no longer fires one abort per object. ALL Q3D-block
  logging goes through a guarded `q3d_msg()` (AddMessage can itself throw on a
  stale handle and escalate a caught error into an abort). COM signatures
  (AssignSignalNet / InsertSetup "Matrix" / InsertSweep / ExportMatrixData) are
  pyAEDT-validated (AEDT 2023 R-series) but still wrapped defensively. Stack-Z via
  a local group-aware `computeLayerZ` mirroring `layerZ`.
- **Auto-transfer (bundled, `generateQ3DCombinedBlock` tail)**: when the Q3D
  design is BUNDLED into the main 2-line script (`bundleQ3D` + ≥2 conductors), the
  combined block — AFTER the Q3D solve — automatically (1) reads the `q3d_cap` C
  matrix by RE-EXPORTING via `ExportMatrixData` to a CSV and PARSING it
  (whitespace-delimited, net-name-labeled SQUARE block between the literal markers
  `Capacitance Matrix` / `Conductance Matrix`, fF, Maxwell signs — verified
  against qiskit-metal's `readin_q3d_matrix`), computes the differential per-length
  C = `((C11+C22)/2 − C12)/2 · 1e-15 / <length_m>` (F/m, length baked), (2) sets
  `tl_C_F_per_m` as a POST-PROCESSING var on `Layout` via the `_tl_pp_var` helper
  (defined in the HFSS part above — NO re-solve), and (3) `CreateReport`s "Z0
  re+im (from Q3D C)" plotting `tl_Z0_re`/`tl_Z0_im` vs `Setup1 : Sweep`. After
  the user Analyzes the HFSS design the Z₀ reports use this C. The computed C is
  ECHOED with a sane-range bound (1e-12–1e-8 F/m) so a mis-read is LOUD, not
  silent. There is NO separate transfer script/button — it's part of the one
  bundled script (the `q3d_cap`/`Layout` design names are assumed).
- **`src/ui/TwoLineWizard.jsx`** — dialog (mount-on-open wrapper like
  `AiAssistantDialog`): length-param dropdown (user params, live values, sorted,
  `_comp_*` hidden), L1/L2 (re-seeded from the param's current value on
  change), separation (blank = auto), freq band (seeded from `simSetup`). LIVE
  runs `buildTwoLineScene` in a memo — surfaces the port-contract error or a
  green "4 ports verified" + warnings, computes the βΔl phase-ambiguity guidance
  (`εeff_max = (c/(2·f_max·Δl))²`; amber if < 5), and gates Generate. Also a
  "Characteristic impedance Z₀ (optional)" block: a C-per-length (F/m) field
  (→ `cFperM`, enables the Z₀ output vars) + a conductor checkbox picker, a
  "Bundle Q3D into the main script" checkbox, and a "Separate Q3D script" button
  (`onGenerateQ3D(conductorIds)` → `handleExportQ3DCap` → `generateQ3DCapacitance`
  → `<base>_q3d_cap.py`). A **"Sheet impedance (conductor thickness = 0)"** block
  appears ONLY when the stack's conductor layer resolves to zero thickness
  (`condIsSheet = !(condThkResolved > 0)`): two fields `Rs` (`sheetRs`) + `Xs`
  (`sheetXs`) for the zero-thickness sheet surface impedance (Ω/sq). They're passed
  VERBATIM into `generateHfssNative`'s `options.sheetImpedance` →
  `AssignImpedance` Resistance/Reactance on the `PEC_sheets` boundary, so they may
  be HFSS expressions using the intrinsic `Freq` (Hz) + `pi` — e.g. a kinetic
  inductance `Lk = 10 pH/sq` is `Xs = 2*pi*Freq*10e-12`. Blank → the near-PEC
  default (R=0.001, X=0). Wired in `PhotonicLayout.jsx`:
  `handleExportTwoLine(builtScene, portIndices, dLMeters, cFperM, bundle, sheetImpedance)`
  — when bundle is on it passes `q3d: { scene: normalizeScene(scene),
  conductorIds }` (the CANVAS single-line scene) so one script holds both
  designs, and threads `sheetImpedance` into the top-level export options. Generates from the BUILT scene (not the canvas scene) →
  preview/download as `<base>_2line_hfss.py`. **All last-used field values
  persist** (lengthParam, L1/L2, separation, freq band, C, Q3D thickness/length,
  the conductor selection, the bundle toggle, the CG convergence controls, and the
  zero-thickness sheet impedance `sheetRs`/`sheetXs`) —
  saved on every field CHANGE via a useEffect (NOT only on Generate), so values
  survive closing without generating or while the build is invalid (Generate
  disabled). Persistence is LAYERED (`src/ui/twoLineSettings.js`, key
  `photonic_layout_two_line` — outside workspace prefixes, same isolation as the
  AI key/settings): (1) an in-memory module cache is authoritative for the
  session and makes close→reopen survive EVEN WHEN the browser silently drops
  `localStorage` writes (private mode / blocked storage / quota) — this was the
  actual "wizard keeps forgetting" bug; (2) `window.storage` (IndexedDB — the
  same durable backend designs use) is written fire-and-forget and hydrated once
  at boot (`hydrateTwoLinePrefs()` in `main.jsx`) so a reload restores even
  without `localStorage`; (3) `localStorage` is best-effort, for a fast
  synchronous restore before the async hydrate lands. Do NOT revert this to a
  bare `localStorage.getItem/setItem` — that reintroduces the bug for any user
  whose `localStorage` is non-functional. A saved lengthParam absent from the
  current design falls back to the first param; the L1/L2 re-seed-on-param-change
  is gated by a prev-value ref (NOT a mount-count flag) so it survives
  StrictMode's double-invoked mount effect and doesn't clobber restored values.
- **Phase-ambiguity caveat (v1)**: β is unwrapped only while βΔl < π over the
  band — pick L2−L1 small enough. α and εeff-from-α are unaffected by the branch.

## Section lines & cross-section wizards (Q2D / Tidy3D)

A **section line** is a NON-MODEL annotation: a 2-point polyline with
`layer: 'section'`, `width: '0'` (toolbar tool next to the airbridge;
EXACTLY two clicks — the second commits). It inherits the full polyline
machinery (snap vertices, expression dx/dy, vertex editing); axis-aligned
lines get a single `<id>_L` length param (signed via `-(<id>_L)`).
Canvas renders it as a dashed rose cut line with per-line letters (A—A′,
B—B′ by order among section comps), end ticks, and — when selected — an
ARROWED length dimension (param name shown when vertex 1 is a lone-param
ref). The render group carries `data-nonmodel="1"`.

**Non-model contract** (`isNonModelComponent(c)` in schema.js — layer ===
'section'): every exporter filters it AFTER solving (`solvedAll` →
`solved`; hfss-native computes `computeParametricPositions` on
`solvedAll` so a child snapped to a section still resolves), scene3d
skips it, figure SVG/PDF export strips `[data-nonmodel]` from the cloned
DOM, `buildTwoLineScene` drops it before the cell build, `createBoolean`
rejects it as an operand, `layerVisKey` gives it its own 'section' eye
(LAYERS panel canvas overlays). Guard: tests/section-line.test.js.

**Cross-section extraction** (`src/scene/cross-section.js`, pure —
tests/cross-section.test.js): `buildCrossSection(scene, pv, sectionCompId)`
→ `{ ok, line{p0,p1,lengthUm,axis:'h'|'v'|null}, domain, slabs[],
conductors[], waveguides[], wgCenter, params, warnings }` — t = µm along
the line, z = stack µm. Segment∩ring even-odd intervals + boolean
interval algebra (union/subtract/intersect, cutouts; boolean roots = one
entry each, replicas via expandTransforms); Z from computeNumericLayerZ +
effectiveConductorLayerId (+zOffset; zeroThickness at the exporter's
abs(t)<1e-9 gate); wg rects get the exact scene3d slab+rib etch-angle
trapezoid. `*Expr` fields (HFSS `"(<unit-free µm>)um"` strings) are
emitted ONLY for axis-aligned lines × unrotated axis-aligned rect/circle
leaves on translation-only chains, each validated by the evalExpr
ROUND-TRIP GUARD (else numeric + warning). Air slab tops the stack;
warnings are `{code,msg}` (oblique-numeric, via/bridge-crossed,
wg-uniform, …).

**Adversarial-review hardening** (all probe-confirmed, fixed pre-commit):
Q2D SKIPS waveguide-role slabs (a coplanar film+cladding stack — the
default LTOI — drew two full-width rects claiming the same area; the film
exists only as the wg slabBand+core entries, matching the 3-D build);
the Q2D E-probe uses report/fields type **"CG Fields"** (plain "Fields"
is HFSS-only — it threw and killed the whole guarded block) over
`Setup1 : LastAdaptive` (Interpolating sweeps save no fields); the tidy3d
RF grid includes SHEET_THICK_UM in its dl heuristic (0.05 µm inflated
NbN sheets fell between 0.4 µm grid rows — invisible to the eigensolve);
the VπL eo_mask follows the etched film (slab intervals + core bbox), not
the full z-band; EO RF permittivities key off the material (LT 43/41 vs
LN 28/43); `defaultRoles` sizes zero-thickness sheets by crossed WIDTH
(area is 0 by construction — the ground pour flipped to signal);
the cross-section expr guard validates INGREDIENTS (evalExpr collapses
errors to 0 — a collapsed candidate could cross-attach at t=0) and bakes
COINCIDENT-EDGE ties; every numeric exporter resolves polyline
snap-vertices against the FULL solved map (a vertex pinned to a section
line resolved to NaN → GDS origin-spikes); buildTwoLineScene bakes SOLVED
positions before dropping section lines (raw cx/cy is stale for
snap-bound parts).

**Q2D exporter** (`src/export/q2d.js`, tests/q2d.test.js):
`generateQ2DExtractor(cross, opts)` → IronPython for AEDT "2D Extractor"
(THROWS on ok:false/bad roles; `validateQ2DRoles` is the UI gate). opts:
`roles {id:'signal'|'ground'}`, freq band/points, `adaptFreqGHz`,
`cgPerError`/`rlPerError` (default 0.1), `minPasses`/`maxPasses`,
`condThicknessUm` (zero-thickness conductors draw as thin rects — Q2D
has NO surface-impedance sheet, kinetic inductance NOT modeled).
KEY DECISIONS: cross.params are declared DIMENSIONLESS (`set_var("h_wg",
"0.6")`) because the contract's `(X)um` form carries the unit outside —
a length-typed var would double-convert (the documented 1e12 bug class);
sizes strip `um` off both operands and re-type `(A - B)*1um`; setup type
string is `"2DMatrix"` (pyAEDT SetupKeys[30], Open template) with CG/RL
data blocks; slabs are Subtract-carved (KeepOriginals=True) around
conductors/wg; reports: Z0 re/im ("Matrix", first SIGNAL's boundary),
sqrt(eps_eff) = `im(Gamma(s,s))*299792458/(2*pi*Freq)`, and E at the
wg-center CreatePoint via FieldsReporter named exprs — BOTH
`E_along_section` (ScalarX) and `E_vertical` (ScalarY) since the crystal
cut decides which drives r33.

**Tidy3D notebook** (`src/export/tidy3d-notebook.js`,
tests/tidy3d-notebook.test.js): `generateTidy3DNotebook(cross, opts)` →
`{ ipynb, warnings }` (THROWS on unusable cross — wizard catches).
nbformat-4; every code cell ast.parse-checked in tests. Coordinates:
tidy3d x = t, y = stack z, z = propagation; local ModeSolver only (no
cloud). RF: quasi-TEM mode → n_eff = √εeff, Z0 via microwave plugin
V-path/I-loop integrals (classic class names = 2.11 aliases; pinned
`tidy3d>=2.7,<3`); SEPARATE `MATERIAL_EPS_RF` table (RF εr ≠ optical n²
— LN εr≈28/43 vs n≈2.2). Optical: AnisotropicMedium with ne on
`extraordinaryAxis` ('vertical' = z-cut → yy, 'horizontal' = x-cut → xx).
VπL: E_RF normalized to 1 V by the mode's own voltage integral, Δn = ½n³r·E
overlap-averaged over the EO layer with the optical intensity weight
(Wooten 2000 / Wang 2018 cited), VπL = λ/(2Δn_eff(1V)). Degradation: no
wg → optical/VπL cells become explanatory markdown (RF kept); <2
conductors → RF/VπL dropped (optical kept). Zero-thickness conductors
inflate to 0.05 µm in-notebook.

**Wizards** (`src/ui/Q2DWizard.jsx`, `src/ui/Tidy3DWizard.jsx`,
`src/ui/CrossSectionPreview.jsx` — mount-on-open like TwoLineWizard;
opened from the section line's Inspector block or right-click menu; state
`sectionWizard {kind, sectionCompId}` in PhotonicLayout). Both show the
shared SVG cross-section preview (piecewise-linear z compression keeps
the device band ~70% of pixels; S1/S2…/G badges) + a ConductorRoleTable
(rows keyed/displayed by unique component ID — labels can collide, e.g.
cond1/cond1_copy both labeled 'cond1'). Default roles
(`defaultRoles(cross)` in sectionWizardSettings.js): area ≥ 0.8·max →
ground, rest signal; no-signal-left → smallest flips; single conductor →
signal + validation error. Prefs persist LAYERED (key
`photonic_layout_section_wizards`, hydrated in main.jsx — same
localStorage-hostile rationale as the 2-line wizard). Downloads go
through `downloadFile` as `<exportFileBase()>_q2d.py` /
`..._eo_section.ipynb`.

## Storage durability, multi-tab safety & disk mirrors

- **Layered persistence rule**: any NEW UI preference persists via the layered
  pattern (in-memory session cache → `window.storage`/IndexedDB write-through +
  memoized async hydrate → best-effort `localStorage`) — this user's browser
  silently drops `localStorage` writes. Stores: `src/ui/twoLineSettings.js`
  (wizard), `src/ui/settings.js` (app settings; explicit-`storage` param
  bypasses the layers for tests), `src/ui/ui-prefs.js` (misc layout prefs:
  `paramNameWidth`, panel widths/collapse). React wiring: persist effects gate
  on hydration completing (or diff a prev-value ref) so StrictMode's
  double-invoked mount effect can't clobber the durable store with defaults.
- **Multi-tab**: one WRITER per workspace via a session-long Web Lock
  (`photonic_layout_ws_lock:<ws>`); losing tabs go read-only (banner, saves/
  autosave/flushes disabled) and auto-take-over when the writer closes.
  Belt-and-braces: `saveDesign` read-merges `versions[]` by id before every
  write (payload wins on collision) so a stale tab can never erase snapshots —
  pass `{ mergeVersions: false }` ONLY when deliberately deleting a version.
  BroadcastChannel `photonic_layout` pings other tabs after every persist
  (choke point: `mirrorWorkspaceToFileIfLinked`).
- **Save-integrity contracts**: `saveDesign` returns a STRUCTURED `{ok,...}`
  result — always check `.ok`, never truthiness. `importWorkspace('replace')`
  writes first and prunes only after every write succeeded.
  `validateDesignName` (reject leading `_` and `:`) guards Save/Save As/New/
  Rename; `sanitizeDesignName` maps imported names. Version restore takes an
  automatic RESCUE snapshot (`auto: before loading vN`) instead of discarding.
  beforeunload prompts while `saveStatus` is unsaved/saving (NOT `isDirty` —
  drifted-but-autosaved is already persisted); pagehide/visibility-hidden do a
  fire-and-forget flush guarded by an `editSeqRef` counter (the same counter
  keeps an in-flight autosave from marking a newer edit 'saved').
- **Disk mirrors** (both Chromium FSA, handles persisted in the
  `photonic_layout_handles` IDB store): the single-FILE bundle mirror
  (`file-handle.js`) and the **git-ready FOLDER mirror**
  (`src/storage/dir-mirror.js`): `designs/<safeName>/current.json` (working
  scene, no undo history) + `versions/vNNN_<id>.json` (one immutable file PER
  SNAPSHOT, written at most once — append-only, diffs cleanly) +
  `.photonic/commit_msg` (latest snapshot description) + generated
  `sync_git.sh` (add/commit -F/push; the browser cannot run git —
  isomorphic-git was REJECTED: push needs a PAT in browser storage, violating
  the credential-isolation rule). Mirroring runs GRANTED-only (a reload
  downgrades handle permissions to 'prompt' and non-gesture requestPermission
  is auto-denied) — a downgraded permission raises the one-click
  "re-authorize" banner instead of dying silently.
- **Layer visibility** (`src/ui/canvas/layer-visibility.js`): LAYERS-panel
  eyes hide render families ('wg' | 'port' | 'via' | 'cond:<stackLayerId>')
  on the CANVAS ONLY — ephemeral React state, never scene/settings; solver +
  every export always see the full scene. Hidden parts can't be selected
  (⌘A/marquee filtered, selection pruned); a "N layers hidden — show all"
  pill keeps a blank canvas self-explaining.

## Settings & appearance themes

User preferences + appearance themes, via the ⚙ header button (between Workspace and the AI ✨ button → `src/ui/SettingsPanel.jsx`).

- **`src/ui/settings.js`** (pure except localStorage I/O, fully tested — `tests/settings.test.js`): `DEFAULT_SETTINGS` = `{ theme, showDimensionsOnSelect (default ON — the renamed `editDims`), showDimensionsOverlay, gridVisible, gridSnap, gridSize }`. Persisted under its OWN key `photonic_layout_settings` (outside workspace prefixes, so it never rides along in design/workspace exports — same isolation rationale as the AI key, which is deliberately NOT folded in). `loadSettings` merges over defaults and, on first run (no settings key yet), migrates the legacy `photonic_layout_edit_dims` toggle into `showDimensionsOnSelect`. `parseSettingsImport` is a PARTIAL import: only keys that are present AND pass per-key validation are applied (merged over the CURRENT settings, not defaults), so a JSON missing a setting leaves that setting untouched. `buildSettingsExport` emits `{ format:'photonic-layout-settings', version, exportedAt, settings }` (whitelisted keys only).
- **`src/ui/theme.js`** — `THEMES` (`default`/`midnight`/`blueprint`/`paper`), `THEME_ORDER`, `resolveCanvasTheme(id)`, `applyThemeAttr(id, doc)`. Two surfaces are themed:
  1. **Chrome** (panels/header/dialogs) — Tailwind `*-slate-*` utilities + a handful of var-ified inline styles. `src/index.css` has a `@theme inline` block remapping `--color-slate-*` → `--app-slate-*`, plus `:root` (default ramp) and `[data-theme="…"]` override blocks. So selecting a theme only sets the `data-theme` attribute on `<html>` (via `applyThemeAttr`) and CSS does the recolor with ZERO class rewrites. Inline chrome hexes were converted to `var(--app-slate-…)` — but ONLY single-quoted style-object values; double-quoted SVG attributes (the logo, geometry/layer colors) are intentionally left literal, as are dark-text-on-accent values and the over-canvas status pill. `paper` is the only LIGHT chrome — its `[data-theme="paper"]` block inverts the slate ramp by role and darkens a few accent tokens for legibility on white.
  2. **Canvas** (the SVG background/grid/axes) — painted as string-literal hex on SVG attributes, so it can't ride the CSS remap. The active theme's `canvas` object is threaded into `<Canvas>` as the `canvasTheme` prop (`DEFAULT_CANVAS_THEME` fallback keeps default render/tests byte-identical). `midnight`/`blueprint` are the dark-canvas themes. Cutout rects also read `canvasTheme.canvasBg` (they paint the bg to read as removed material). Interaction accents (snap amber, halo cyan, dimension violet) stay constant — tuned for contrast on any background.
- `index.html` sets `data-theme` from the saved settings before React mounts (no chrome flash). The figure exporters (`handleExportSVG`/`handleExportPDF`) thread `canvasTheme.canvasBg` through `options.background` so exported figures match the on-screen canvas.
- **CAUTION for future edits:** do NOT mutate `src/PhotonicLayout.jsx` via a Bash script and then use the Edit tool — the Edit tool's in-memory snapshot will clobber the Bash writes. Re-Read the file first, or do all mutations through one mechanism.

## 3D viewer

An interactive 3-D PREVIEW of what the HFSS export builds ("3D" toolbar button
next to "fit"; Esc or re-click returns to 2-D). STRICTLY render-side — it only
READS the scene through the same pipeline everything else uses; scene model,
solver, and every export path are untouched (viewer-only guarantee, enforced by
a no-mutation test).

- **`src/scene/scene3d.js`** — `buildScene3D(scene, paramValues) → { solids,
  warnings }`. PURE spec builder (NO three.js import; fully unit-tested in
  `tests/scene3d.test.js`). Pipeline: normalizeScene → solveLayout +
  applyMirrors + resolveBooleanBboxes → expandTransforms →
  `shapeInstanceToRing` footprints + `computeNumericLayerZ` for Z. Solid kinds:
  `extrude` (plan ring + holes, zBottom, height), `cylinder` (vias:
  layerFrom.zBottom → layerTo.zTop — the same numbers pyAEDT emits), `bridge`
  (closed arch profile from the SHARED parabolic 9-pt sampler
  `src/geometry/bridge.js`, swept by width), `loft` (two index-corresponded
  plan rings joined by planar side walls — the rib-waveguide ETCH-ANGLE
  TRAPEZOID, exact same ribBotW/ribTopW math as hfss-native: inward =
  ribH/tan(etch_angle), `core_width_ref` 'top'|'bottom'; fully-pinched top
  clamps to a 1 nm hairline + warning). **Convention: Z-UP** — X = plan x,
  Y = plan y, Z = stack height (camera.up = (0,0,1)).
  - **CSG scope: subtract/punch ONLY.** Blank solids carry
    `csg: { subtractIds }`; tools emit `role:'tool'` and are never rendered
    (punch clones consumed exactly like the canvas; the ORIGINAL punch tool
    renders standalone). `union` = visual union (operands emitted separately —
    overlapping same-material solids read as merged; CSG-union deliberately
    skipped). `intersect` = overlap + warning.
  - **Boolean-cluster replicas**: `emitComponent` expands the boolean's OWN
    transform chain into per-instance cluster xforms (`xfs`) and EVERY
    emission branch must apply them (`xfPoint`/`xfRing`). The generic-extrude
    branch once skipped this — a punch/union boolean with `repeat` piled all
    replica operand rings on the base position while the canvas/HFSS placed
    them correctly (the punch1/meander-cells bug; regression-tested).
  - **layerKey** = EXACTLY `layerVisKey(...)` from
    `src/ui/canvas/layer-visibility.js` ('wg'|'port'|'via'|'cond:<id>'|
    'electrode') so `hiddenLayerKeys` filters 3-D identically to the canvas;
    PLUS `stack:<id>` for substrate/cladding slabs (viewer-local checkboxes).
    `selectId` = the top-level boolean for cluster members (click-select
    parity with the canvas); `compId` = the leaf component.
  - **Documented approximations** (each pushes a `warnings[]` entry):
    zero-thickness conductors get a nominal 0.02 µm height;
    cladding/substrates are translucent boxes over the chip extent
    (simSetup pads, else 50 µm) with NO subtraction (translucency shows
    embedded parts better); constant-width polylines use a mitered band,
    tapered ones the HFSS butt-join quads; port rects are thin sheets at the
    bound conductor's mid-Z; cutouts become Shape holes when fully inside the
    footprint, else CSG tools (a rib waveguide's loft rib forces the CSG
    path — the hole shortcut requires all-extrude instance solids).
- **`src/scene/layer-z.js`** — `computeNumericLayerZ(stack, paramValues)`:
  the numeric per-layer Z walk EXTRACTED from generatePyAEDT (which now
  consumes it; byte-identical output verified). Same coplanar-group semantics
  as hfss-native's parametric `layerZ` — keep all three in lockstep. Tested in
  `tests/layer-z.test.js`.
- **`src/ui/Viewer3D.jsx`** — React.lazy'd from PhotonicLayout; three.js +
  OrbitControls + three-bvh-csg are dynamically imported INSIDE it
  (module-level promise, same pattern as the AI SDK in `src/ai/client.js`), so
  they live in their own chunks (~750 kB three stays out of the main bundle —
  main-chunk delta of the whole feature ≈ +0.7 kB). Spec → meshes:
  ExtrudeGeometry (+holes), CylinderGeometry, profile-extrude for bridges,
  manual BufferGeometry loft (side quads + triangulated caps) for the rib
  trapezoid — the loft MUST carry position+uv+normal attributes: three-bvh-csg's
  Evaluator hard-requires all three on both brushes, and a position-only soup
  throws INSIDE the swallowed evaluate try/catch = silently-skipped subtraction
  (a real bug we caught pre-commit). All
  placement is baked into geometry (identity mesh transforms) so three-bvh-csg
  Brushes compose without matrix bookkeeping; CSG tools are inflated ±10 nm in
  Z to dodge coplanar-face artifacts; recursive tool resolution (a tool may
  itself carry csg). Debounced (250 ms) rebuild on scene/paramValues with a
  "rebuilding…" hint; geometries/materials disposed on every rebuild. Raycast
  click → `setSelection` (stack slabs unpickable); selected meshes get a cyan
  emissive tint; `data-solid-count` attribute on the container for testability.
  Esc exits via `onExit`. Fit prefers device solids over the (possibly 250 µm
  thick) substrate slabs; `fitInfo`/`placeCamera` also drive SIX axis-view
  buttons (top/bottom/front/back/left/right; top/bottom keep a hair of −Y
  tilt to dodge the OrbitControls pole), rendered as `CubeIcon` mini
  isometric cubes with the target face highlighted — the standard glyph is
  the cube seen from the DEFAULT fit direction (visible faces top/front/
  right); bottom/back/left rotate it 180° so the highlighted face is always
  the one you'll face. The z=0 GridHelper tracks the 2-D canvas grid setting
  (`gridVisible` prop = `settings.gridVisible`, toggled live without a mesh
  rebuild).

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

### Design / shape JSON download & upload (UI)

- **Per-version download** (`handleDownloadVersion(name, versionId)`): a Download icon on EVERY row of the SAVED DESIGNS version list — each snapshot AND the synthetic "current" row (`versionId === null` ⇒ live working scene) — writes that one scene as a standalone design JSON via `buildDesignExport`. Works for any design in the list (the active one reads live/in-memory state; another design is loaded from storage on demand). This REPLACED the old toolbar "export" button. Whole-design-with-history export still lives on each design row (`handleExportDesign` → `exportDesign` bundle).
- **Design import** lives only in the SAVED DESIGNS panel footer (`handleImportDesignFromFile` → adds the file as a NEW design in the workspace). The old toolbar "import" (which REPLACED the canvas, `handleImportDesignFile`) was removed as redundant.
- **Selected-shapes download / upload** (context menus): right-clicking selected shapes → "Download selection" writes an `{ format:'easyrfpic_shapes', components, snaps, params }` file (`handleDownloadSelection`); right-clicking the canvas BACKGROUND → "Upload shapes here…" (`handleUploadShapes`) inserts those shapes at the click point (`onBackgroundContextMenu` in Canvas.jsx supplies the world point). Upload also accepts a design export ({ scene:{components} }) or a bare scene.
- **Shared fragment helpers**: `buildSelectionFragment(ids)` (components + INTERNAL snaps — both endpoints in the selection — + transitive param closure) backs both Copy and Download-selection; `applyShapeFragment(cb, { at? })` (id-collision `<id>_copy` rename, snap remap, dest-wins param backfill, select) backs both Paste and Upload-shapes. `applyShapeFragment` ALSO re-filters snaps to those whose BOTH endpoints are inside the inserted set (drops any link to a shape outside the fragment + can't emit a broken `undefined`-compId snap) — so only links among the copied components survive, for every fragment source. `opts.at` (world point) centers the fragment's centroid (mean of component centers) there; otherwise the 5-grid-step offset. **Paste lands at the cursor**: the Canvas reports the hover world position via `onHoverWorld` into `cursorWorldRef`; `handlePaste(at?)` uses an explicit `at` (right-click Paste passes the click point) else `cursorWorldRef.current`, else the offset. (⌘D duplicate is a separate path — `cloneSnapsForDuplicate` — and DELIBERATELY keeps external-incoming snaps so a duplicated child stays attached to its external parent.)

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

`options.twoLine = { portIndices }` appends the 2-line-method εeff/α
output-variable + report block before `oProject.Save()` (see "2-line method
wizard"). Absent the option, output is byte-identical to before.

**Parametric union-boolean chains** (`computeParametricPositions`): the
snap DAG walker keeps EVERYTHING around a union cluster live in HFSS:
`boolBBoxParametric(c)` (memoized) derives the union's bbox DIMS **and
natural CENTER** from the extremal operands' `resolveNoCluster` chains;
the cluster-operand pass-through emits `operand = boolPos + (opNatural −
centerNatural)` (was a frozen numeric offset — the "meander grows in an
HFSS sweep but its snapped children stay put and intersect" bug); free
unions resolve to the parametric natural center; and an explicit
`from.instanceIdx` on a rotate/mirror chain emits `parentCenter +
instanceChainOffsetExpr(angleMode 'hfss') + numeric-trig instance-frame
anchor on parametric dims` (frozen-numeric fallback kept). Gold test:
`tests/instance-anchors.test.js` sweep-parity — exprs computed at one
param value re-evaluated at another must match a FRESH canvas solve.
CAVEATS (surfaced as safety-report NOTES via the `outMeta` 4th arg →
`noteCaveat`): instance ORIENTATION trig is baked (rotate-ANGLE sweeps
need re-export); the extremal-operand identity is frozen at export
(huge sweeps that change which operand is outermost need re-export);
`boolBBoxParametric` BAILS to the exact frozen fallback when any operand
carries first-class rotation (the solver grows rotated AABBs by
|cos|+|sin|; rotation-blind edges would be silently wrong AT EXPORT
VALUES). `flattenReplicas`'s cxExpr injection has a ROUND-TRIP GUARD
(evalExpr must reproduce the solved position, else stay baked) because
HFSS-only forms like `cos(((a))*1deg)` evaluate to a SILENT finite 0 in
evalExpr. gdsfactory's `exprToPython` converts `deg` with a NUMERIC
radian factor (inserting `math.pi` before the bare-pi pass garbled it
into `math.math.pi`).

**Zero-thickness sheet impedance** is resolved PER FIELD (Rs and Xs
independently) in priority: (1) `options.sheetImpedance` (2-line wizard)
— but only for the field(s) actually typed; a BLANK wizard field falls
through (an object-takes-both rule silently zeroed a layer's kinetic Xs
when the wizard typed only Rs — real bug, fixed); (2) the sheet's
conductor LAYER's own `sheetRs`/`sheetXs` fields (LAYERS panel, shown
only when the layer thickness matches the exporter's sheet gate
`abs(t) < 1e-9` — keep the panel/TwoLineWizard gates aligned with that
epsilon; verbatim HFSS exprs, `Freq`/`pi`/design vars allowed); (3)
near-PEC default (0.001 + j0). `sheetRs`/`sheetXs` are registered in
`rename-ident.js` STACK_EXPR_FIELDS and the deleteParam guard
(PhotonicLayout.jsx) so param rename/delete can't silently orphan them —
but deliberately NOT in `paramsForStack` (schema.js), which would
auto-create `Freq`/`pi` as bogus µm params. Sheets are GROUPED BY LAYER
— one `AssignImpedance` per distinct zero-thickness conductor layer
(single group keeps the historical name `PEC_sheets`; multiple →
`PEC_sheets_<layerId>`). `registerSheet(name, comp)` is THE way a sheet
joins the boundary (records the resolved layer in `sheetLayerByName`);
transform-chain clones and boolean renames inherit the entry. TWO
list-hygiene bugs fixed here, same failure mode (AssignImpedance
referencing a nonexistent name → AEDT rejects the WHOLE boundary → every
sheet in the group exports boundary-less / electromagnetically absent):
(a) the boolean clone-extend check must match operand[0]'s ORIGINAL name
too (`base0Id`) — the united survivor's rename into the boolean's id
happens AFTER the chain emission, so checking only the boolean id
dropped every repeated/mirrored meander replica from the boundary; (b)
every part CONSUMED by a boolean must be REMOVED from the tracked lists
— union/intersect consume everything except operand[0]'s first part,
subtract/punch consume all tool parts, INCLUDING operand-owned
transform-chain clones (`barA_1`, …) that joined `zeroThicknessSheets`
at the primitive stage (removing only tool BASE names left stale names
in the Objects list).

`options.sheetImpedance = { resistance, reactance }` overrides the zero-thickness
conductor sheet boundary (`PEC_sheets` `AssignImpedance`): the two strings are
emitted VERBATIM into the Resistance/Reactance fields (Ω/sq), so they may be HFSS
expressions using the intrinsic `Freq` (Hz) + `pi` + any design variable — e.g.
a kinetic inductance `Lk` pH/sq is `Xs = 2*pi*Freq*Lk*1e-12`. Empty/absent →
near-PEC default (`R=0.001, X=0`). Double-quotes in the expr are sanitized to `'`
so they can't break the emitted Python literal.

**Per-layer Z (`layerZ` walk, mirrored numerically in pyAEDT's `numericLayerZ`)**: the stack is grouped by `coplanarGroup` id (NOT device role). Adjacent layers sharing a group id are coplanar — they share `zBottom`; the cursor advances past a group by its **cladding top** (`advanceLayerOf` = thickest cladding member, else thickest member for a malformed group with no cladding), so a layer ABOVE a coplanar group (e.g. a conductor in a different/no group) starts at the group's cladding top, not its `zBottom`. Layers with no `coplanarGroup` stack sequentially. Both walks `migrateStackCoplanarGroups` the stack first (defensive — matches in-app normalization), and pin Z=0 at the first device-role or grouped layer (substrates below go negative). The advance is the cladding's own `thicknessExpr`, so single-cladding groups (the norm) are parametrically exact under sweeps.

### GDS-II (`generateGDS`)

Custom REAL8 binary encoder. Each component emits BOUNDARY records using `shapeInstanceToRing` for the perimeter. Racetracks emit outer perimeter as DATATYPE=0 and inner perimeter as DATATYPE=1 (cutout convention). Booleans skip GDS emission (they're CAD-only constructs; GDS is the final flattened layout).

## Common bug patterns to avoid

- **`evalExpr` must scale with the EXPRESSION, not `paramValues`.** It substitutes only the identifiers that appear in the expression (via `tokenizeIdents`), NOT every key of `paramValues`. `solveLayout` grows a `workingPV` with 4 synthetic `_comp_<id>_*` params PER component, so on a large/flattened scene `paramValues` holds thousands of keys; a full-key scan made `evalExpr` O(#params) per call and quadratic in scene size (the 2-line wizard froze ~24 s on a 1216-component meander flatten — fixed to ~0.14 s). Never reintroduce an all-keys loop in `evalExpr`; guard: `tests/params.test.js` "scales with EXPRESSION size".
- **`str_replace` edits that orphan function bodies.** Always parse-check after structural edits: `node -e "require('@babel/parser').parse(require('fs').readFileSync('src/PhotonicLayout.jsx', 'utf8'), { sourceType: 'module', plugins: ['jsx'] })"`.
- **TDZ errors from `useEffect` dep arrays referencing later-declared `const` functions.** Use refs (`useRef`) to break the cycle: declare the ref first, set its current in an effect, reference the ref in the dep array.
- **Booleans with literal `w='0'`, `h='0'` for anchor math.** Always look up the SOLVED instance, never the scene component, when reading boolean bboxes.
- **Operands of consumed booleans rendering standalone.** Filter via `consumedBy` set in the renderer.
- **Infinite recursion in boolean tree walks.** Use a `visited` Set, passed through the recursion.
- **HFSS `Rotate` rotates about world Z, not part center.** Always use translate-rotate-translate for "rotate about own center" semantics.
- **HFSS `Mirror`/`DuplicateMirror` base-point fields don't evaluate parametric VARIABLE expressions** (unlike `CreateBox` positions / `Move` vectors, which do — the whole export depends on that, and the very parts being mirrored are CREATED with deep parametric position exprs HFSS evaluates fine). Feeding the parametric cluster-centroid expr into `MirrorBaseX/Y` made HFSS silently skip the reflection (swallowed by the try/except) → a mirrored line rendered UN-mirrored while the canvas looked right. Fix (`emitTransformChainHfss`, both `mirror` and `duplicate_mirror`): keep the parametric plane ONLY in `oEditor.Move` calls and mirror about the ORIGIN (trivial `0um` base). `mirror`(pivot C) = translate(−c) → `Mirror`(origin) → translate(+c); `duplicate_mirror` = translate(−plane) → `DuplicateMirror`(origin) → translate(+plane) over both originals AND the new copies (names predicted via `nextCloneName` up front). Stays sweep-parametric; the Mirror command only ever sees `0um`. pyAEDT bakes the mirror base NUMERICALLY (so it works there, just not sweepable).
- **Conductor-binding resolution bypassing `effectiveConductorLayerId`.** An
  operand consumed by a boolean usually carries NO `conductorLayerId` of its
  own (templates don't set it) — the user binds the BOOLEAN. Every consumer
  (hfss-native `resolveCondForComp` + its top-of-script audit block, scene3d
  `boundConductorFor`, gds + gdsfactory layer maps, Canvas
  `resolveBoundLayer`, layer-visibility `layerVisKey`, q3d's selected-
  conductor layer, TwoLineWizard's `condThkResolved` sheet gate, the
  Inspector picker's inherited state, the sceneIssues unbound/stale checks)
  must resolve own-binding → consuming-boolean's binding
  (`src/scene/conductor-binding.js`) → first-conductor fallback. The
  resolution ORDER is operand-own-first everywhere — a consumer that lets
  the boolean's binding beat an operand's own (or vice versa) disagrees
  with the rest (adversarial review caught Canvas doing exactly that).
  STALE warnings fire only on the component that OWNS the stale binding
  (once on the boolean, not per inheriting operand). A consumer using `c.conductorLayerId || first` puts bound
  clusters on whatever layer is ordered first in a multi-conductor stack
  (the "meander renders 2 µm thick on a zero-thickness conductor" bug —
  wrong Z/thickness in 3-D AND HFSS). Guard: tests/conductor-binding.test.js.
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
#   tests/bridge.test.js              — airbridge component (schema defaults, ring fallback, solver
#                                       snap, transforms, HFSS spline-profile emission + sheet mode
#                                       + PEC_sheets, GDS layer 150, pyAEDT AST, walkers, AI kind)
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
#   tests/two-line.test.js            — 2-line method (Marks 1991): twoLineExtractNumeric recovers
#                                       γ/α/εeff from synthetic lines; buildTwoLineScene 4-port (A,A,B,B)
#                                       ordering + parametric L1/L2 + error gates; replica flattening +
#                                       port auto-enable (repeat-replica + punch-cluster cross-cloneOf);
#                                       stack-param preservation (h_cond=0 stays a sheet); Δl/C baked
#                                       literals; Z0 = γ/(jωC) output vars gated on cFperM;
#                                       generateQ3DCapacitance meander-C script; options.twoLine parses
#   tests/canvas-perf-helpers.test.js — uniform-grid spatial index + anchor-snap / alt-drag index
#                                       EQUIVALENCE vs the old full-scan oracles (probe sweeps +
#                                       seeded fuzz), boolean-operand cells, tie-order preservation
#   tests/ai-assistant.test.js        — AI geometry assistant deterministic half: prefix alloc,
#                                       system-prompt scene context, fragment normalize/validate
#                                       (every error category), applyFragment → solve + snap-graph
#                                       + HFSS set_var parametricity, collision rename incl. snap
#                                       vertices (network call NOT covered — browser-only)
#   tests/layer-z.test.js             — computeNumericLayerZ vs hand-computed sequential +
#                                       coplanar-group stacks (cladding-top advance, Z=0 pinning)
#   tests/scene3d.test.js             — 3-D viewer spec builder (no three.js): wg slab+rib Z,
#                                       electrode/via/bridge/racetrack solids, punch→csg.subtractIds
#                                       + tool roles, union-as-overlap, zero-thickness epsilon +
#                                       warning, layerKey ↔ layer-visibility parity, cladding box,
#                                       cutout hole-vs-CSG, repeat expansion, scene no-mutation
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
