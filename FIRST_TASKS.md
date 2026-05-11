# First tasks for Claude Code

After running `claude` in your project directory, paste these prompts in order. Each is designed to be a focused unit of work that ends with a passing test suite and a commit.

Before each new task, verify the previous one's commit is clean: `git status` should show nothing.

---

## Task 0 — Orient Claude Code

Paste this first. It bootstraps Claude with the architecture context.

```
Please read CLAUDE.md, README.md, and PROPOSED_STRUCTURE.md before doing anything else. Then read src/PhotonicLayout.jsx to get a sense of the codebase.

After reading, summarize back to me:
1. What this project is
2. The three export targets
3. The proposed refactor order

Don't make any code changes yet. Just confirm you've absorbed the context.
```

---

## Task 1 — Get the tests running

```
Run the test suite in tests/ and confirm everything passes:
- node tests/test_drag_thorough.mjs
- node tests/test_shapes.mjs
- node tests/test_racetrack.mjs
- node tests/test_racetrack_export.mjs
- node tests/regen.mjs

The tests use the source at src/PhotonicLayout.jsx. They may need their paths adjusted from /mnt/user-data/outputs/ to src/. Update them in-place if needed.

After all tests pass, commit with the message "tests: adapt to local src/ paths".
```

---

## Task 2 — Extract racetrack geometry (Stage 1.1)

```
Following PROPOSED_STRUCTURE.md, extract these three functions from src/PhotonicLayout.jsx into a new file src/geometry/racetrack.js:

- eulerBend180Centerline
- buildRacetrackCenterline
- offsetCenterlineToBand

These functions have no dependencies on other module-level definitions in PhotonicLayout.jsx (verify this before moving), so the extraction is purely "cut from one file, paste into another, add export keywords, add an import in the original".

After the move:
1. PhotonicLayout.jsx should import these from './geometry/racetrack.js' rather than defining them
2. Re-run the full test suite — everything must still pass
3. Commit with message "refactor: extract geometry/racetrack.js"

If any test fails, revert the change and report what went wrong before trying again.
```

---

## Task 3 — Extract scene/params.js (Stage 1.2)

```
Extract these from src/PhotonicLayout.jsx into src/scene/params.js:

- evalExpr
- RESERVED_IDENTS
- resolveParams
- Any synthetic-param helpers (search for "_comp_" prefix or "synthetic")

Same protocol as before:
1. Cut from original, paste into new file with exports
2. Add import in PhotonicLayout.jsx
3. Run all tests
4. If passing, commit with message "refactor: extract scene/params.js"
5. If failing, revert and report

Note: these functions are called from many places in the codebase. The import statement in PhotonicLayout.jsx will need to expose all the names that are currently used.
```

---

## Task 4 — Extract scene/anchors.js (Stage 1.3)

```
Same protocol for ANCHORS, anchorLocal, anchorWorld → src/scene/anchors.js.

Commit message: "refactor: extract scene/anchors.js"
```

---

## Task 5 — Extract geometry/rings.js (Stage 1.4)

```
Same protocol for shapeInstanceToRing → src/geometry/rings.js.

This one depends on scene/anchors.js and geometry/racetrack.js, so make sure the imports are correct in the new file.

Commit message: "refactor: extract geometry/rings.js"
```

---

## Task 6 — Extract scene/transforms.js (Stage 1.5)

```
Same protocol for expandTransforms → src/scene/transforms.js.

Depends on scene/params.js and scene/anchors.js.

Commit message: "refactor: extract scene/transforms.js"
```

---

## Task 7 — Extract scene/solver.js (Stage 1.6)

```
Same protocol for solveLayout, applyMirrors, refreshBooleanBbox, resolveBooleanBboxes → src/scene/solver.js.

This is a larger extraction. The solver is the heart of the snap system, so be especially careful. Run tests after extracting each function if you want to bisect any failure.

Commit message: "refactor: extract scene/solver.js"
```

---

## Task 8 — Stage 1 review

```
Stage 1 of the refactor (pure functions, no React) should now be complete. Run:

git log --oneline | head -10

And confirm we have 6-7 commits since the initial commit. Then:

1. Re-read CLAUDE.md and PROPOSED_STRUCTURE.md
2. Look at src/PhotonicLayout.jsx — note how many lines remain
3. Identify any pure functions that should have been extracted in Stage 1 but weren't
4. Report what's left and propose Stage 2 next steps

Don't make any code changes in this turn. Just review and report.
```

---

## Then proceed through Stages 2-4

Stage 2 (exporters) and Stage 3 (scene factories and storage) follow the same pattern. Use the same prompt template:

```
Extract <function names> from src/PhotonicLayout.jsx into <new file path>.

Follow the protocol:
1. Cut from original, add exports
2. Add imports in PhotonicLayout.jsx
3. Run all tests in tests/
4. If passing, commit with message "refactor: extract <module name>"
5. If failing, revert and report

Don't change behavior. This is structural only.
```

Stage 4 (React components) is more delicate. For each component extraction, use:

```
Extract the <ComponentName> component from src/PhotonicLayout.jsx into src/ui/<path>/<ComponentName>.jsx.

The component currently closes over many state values and callbacks. List them, then convert each to a prop. Add the prop-passing in the parent.

Run the dev server (npm run dev) and manually verify the component still works in the browser before committing. Don't just rely on tests — they only cover canvas/export behavior, not UI.

After confirming, commit with message "refactor: extract <ComponentName>".
```

---

## After all refactoring lands

Once `PhotonicLayout.jsx` is a thin assembly file (probably < 200 lines), you're ready to add features without dread. Some good first feature tasks once the refactor is done:

- Add a "Save as built-in template" command that lets the user codify a library item into `src/templates/`.
- Add ring-resonator (single-bus + coupler) built-in template.
- Add an export preview (read-only modal showing the pyAEDT script) before download.
- Add unit tests with vitest alongside the existing node-script tests.
