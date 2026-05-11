# Target module layout

Goal: split the ~11k-line `src/PhotonicLayout.jsx` into focused modules. The first refactor pass should preserve behavior exactly — no feature changes, just file structure. Each step should leave the test suite passing.

## Target tree

```
src/
  PhotonicLayout.jsx          # The top-level <App> component — assembly only
  index.css                   # Tailwind import

  scene/
    schema.js                 # makeDefaultScene, makeBlankScene, normalizeScene
    params.js                 # resolveParams, evalExpr, RESERVED_IDENTS, synthetic params
    anchors.js                # ANCHORS, anchorLocal, anchorWorld
    solver.js                 # solveLayout, applyMirrors, refreshBooleanBbox
    transforms.js             # expandTransforms
    booleans.js               # resolveBooleanBboxes, boolean cluster walking

  geometry/
    rings.js                  # shapeInstanceToRing for all shape kinds
    racetrack.js              # eulerBend180Centerline, buildRacetrackCenterline, offsetCenterlineToBand
    paths.js                  # ringToSvgPath, rect/circle/ellipse/polygon SVG helpers

  export/
    pyaedt.js                 # generatePyAEDT + emitTransformChainPyAEDT
    hfss-native.js            # generateHfssNative + emitTransformChainHfss + set_var setup
    gds.js                    # generateGDS + REAL8 encoder

  ui/
    canvas/
      Canvas.jsx              # The main SVG canvas component
      drag.js                 # drag state machine: cluster, alt-drag, vertex resize
      snap-search.js          # alt-drag candidate filtering, hysteresis
      render-primitive.jsx    # per-shape SVG renderers
      render-boolean.jsx      # boolean cluster rendering with mask/clip
      dimensions.jsx          # parametric dimension arrows
      ruler.jsx               # on-canvas ruler
      handles.jsx             # selection halos, resize handles
    panels/
      ShapesPanel.jsx         # the SHAPES tree with history view
      LayersPanel.jsx         # stack roles, materials, thicknesses
      ParamsPanel.jsx         # parameter editor
      LibraryPanel.jsx        # user library + built-in templates
      InspectorPanel.jsx      # per-component inspector
      TransformChainEditor.jsx
    Toolbar.jsx               # two-row toolbar with layer dropdown + shape buttons
    dialogs.jsx               # confirm/alert dialogs

  storage/
    workspace.js              # workspace-aware save/load via window.storage
    file-handle.js            # File System Access API + IndexedDB
    library-items.js          # saveLibraryItem, loadLibraryItem, archive ops

  hooks/
    useUndoRedo.js            # 50-deep, 2s-debounced history
    useKeyboard.js            # Cmd+S, Cmd+C/V, +/- shortcuts
    useViewport.js            # pan/zoom state

  templates/
    racetrack.js              # insertBuiltinRacetrack
    (future built-in templates go here)

tests/
  regen.mjs                   # regenerate default-scene HFSS + pyAEDT exports
  test_drag_thorough.mjs      # cluster drag / alt-drag scenarios
  test_shapes.mjs             # circle/ellipse/polygon end-to-end
  test_racetrack.mjs          # racetrack geometry sanity
  test_racetrack_export.mjs   # racetrack pyAEDT/HFSS/GDS export
  out/                        # generated test outputs (gitignored)
```

## Refactor order

Do it one module at a time. Commit after each. If tests fail, revert and re-split smaller.

**Stage 1 — pure functions with no React dependencies.** These have the lowest risk because they have no JSX, no hooks, no state:

1. `geometry/racetrack.js` — `eulerBend180Centerline`, `buildRacetrackCenterline`, `offsetCenterlineToBand`. No dependencies on other modules. Easy first commit.
2. `scene/params.js` — `evalExpr`, `RESERVED_IDENTS`, `resolveParams`, synthetic param helpers.
3. `scene/anchors.js` — `ANCHORS`, `anchorLocal`, `anchorWorld`.
4. `geometry/rings.js` — `shapeInstanceToRing`. Depends on `scene/anchors.js` and `geometry/racetrack.js`.
5. `scene/transforms.js` — `expandTransforms`. Depends on `scene/params.js` and `scene/anchors.js`.
6. `scene/solver.js` — `solveLayout`, `applyMirrors`, `refreshBooleanBbox`. Depends on the above.

**Stage 2 — exporters.** These are pure functions of (scene, paramValues) and only depend on Stage 1:

7. `export/gds.js`
8. `export/pyaedt.js`
9. `export/hfss-native.js`

**Stage 3 — scene factories and storage.** Pure JS, no React:

10. `scene/schema.js` — `makeDefaultScene`, `makeBlankScene`, `normalizeScene`.
11. `storage/workspace.js`, `storage/file-handle.js`, `storage/library-items.js`.

**Stage 4 — React components.** Highest risk because of hook ordering and prop drilling. Tackle these last and one at a time:

12. `ui/panels/TransformChainEditor.jsx`
13. `ui/panels/LayersPanel.jsx`
14. `ui/panels/ParamsPanel.jsx`
15. `ui/panels/LibraryPanel.jsx`
16. `ui/panels/InspectorPanel.jsx`
17. `ui/panels/ShapesPanel.jsx`
18. `ui/canvas/Canvas.jsx` (with sub-modules in `ui/canvas/`)
19. `ui/Toolbar.jsx`
20. `ui/dialogs.jsx`
21. `hooks/useUndoRedo.js`, `hooks/useKeyboard.js`, `hooks/useViewport.js`
22. `templates/racetrack.js`

Finally, `PhotonicLayout.jsx` becomes a thin shell that wires the above together.

## Stop-the-bleeding rules

- **No behavior changes during refactor.** If you're tempted to "fix this while I'm here", stop. Make a note in TODO.md and address it after the structural refactor lands.
- **Run the full test suite before each commit.** Even if a change "obviously" can't affect drag behavior, run `test_drag_thorough.mjs`. The codebase has surprising couplings.
- **One module per commit.** Easier to bisect when something regresses.
- **Imports go through index files where useful.** E.g. `scene/index.js` re-exports `resolveParams`, `solveLayout`, etc. Consumers import `from '../scene'` not `from '../scene/solver.js'`.
