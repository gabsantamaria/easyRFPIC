# PhotonicLayout

Parametric layout tool for RF / photonic IC structures (TFLN/TFLT modulators, ring resonators, racetrack resonators, filters). Exports to HFSS pyAEDT, HFSS native COM scripts, and GDS-II.

## Quick start

```bash
npm install
npm run dev
```

Then open the URL Vite prints (usually `http://localhost:5173`).

## Features

- Parametric component model with expression-based dimensions and positions
- Snap-based positioning with cluster-aware drag and alt-drag snap creation
- Shapes: rect, circle, ellipse, regular polygon, racetrack (with partial-Euler bends)
- Boolean ops (union / intersect / subtract) as derived components with feature-tree history
- Per-component transform chain (displace / rotate / repeat) preserved in HFSS export history
- Three export targets:
  - **HFSS pyAEDT** — Python script using `ansys.aedt.core`
  - **HFSS native** — Python script using `ScriptEnv` + `oEditor` COM
  - **GDS-II** — binary, with cutout-by-datatype convention for racetracks

## Project layout

See `PROPOSED_STRUCTURE.md` for the target module layout. The codebase started as a single ~11k-line `.jsx` file and is being progressively refactored into modules.

See `CLAUDE.md` for architecture details, conventions, and known bug patterns.

## Tests

```bash
node tests/test_drag_thorough.mjs
node tests/test_shapes.mjs
node tests/test_racetrack.mjs
node tests/test_racetrack_export.mjs
node tests/regen.mjs && python3 -c "import ast; ast.parse(open('tests/out/layout_hfss.py').read())"
```
