// Parametric cell system (src/scene/cells.js): define once, instantiate
// many, update all.
//
//   - makeCellFromSelection: transitive param closure, external-snap
//     drop (with warnings), position normalization to the bbox center.
//   - instantiateCell: every def-local identifier (params AND component
//     ids) prefixed, overrides applied, fragment centered at (atX, atY).
//   - two instances coexist: snap graph stays clean and the HFSS export
//     carries BOTH prefixed param sets (and parses as Python).
//   - updateInstancesFromCell: user-edited override exprs preserved,
//     new params get defaults, orphans dropped, centers kept.
//   - workspace storage round-trip (save/load/list/export/import).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';
import { writeFileSync, mkdirSync } from 'fs';
import {
  makeCellFromSelection,
  instantiateCell,
  updateInstancesFromCell,
  cellComponentsBbox,
} from '../src/scene/cells.js';
import { normalizeScene, makeBlankScene } from '../src/scene/schema.js';
import { resolveParams } from '../src/scene/params.js';
import { validateSnapGraph } from '../src/scene/solver.js';
import { generateHfssNative } from '../src/export/hfss-native.js';
import {
  listCellDefs, loadCellDef, saveCellDef, deleteCellDef,
  exportWorkspace, importWorkspace,
} from '../src/storage/library-items.js';

// Base scene: pad+arm form the cell-able pair (internal snap, param-
// driven width/gap, one transitively-referenced param), ext is an
// outsider with a boundary-crossing snap.
//   base_t = 5;  cap_w = 4*base_t = 20;  cap_gap = cap_w/4 = 5.
function baseScene() {
  const s = normalizeScene(makeBlankScene());
  s.params = {
    ...s.params,
    base_t: { expr: '5', unit: 'µm', desc: 'transitive-only param' },
    cap_w: { expr: '4*base_t', unit: 'µm', desc: 'pad width' },
    cap_gap: { expr: 'cap_w/4', unit: 'µm', desc: 'pad-arm gap' },
  };
  s.components = [
    { id: 'pad', kind: 'rect', layer: 'electrode', cx: 10, cy: 0, w: 'cap_w', h: '10', cutouts: [], transforms: [] },
    { id: 'arm', kind: 'rect', layer: 'electrode', cx: 30, cy: 0, w: '8', h: '4', cutouts: [], transforms: [] },
    { id: 'ext', kind: 'rect', layer: 'electrode', cx: 100, cy: 50, w: '10', h: '10', cutouts: [], transforms: [] },
  ];
  s.snaps = [
    { id: 's_int', from: { compId: 'pad', anchor: 'E' }, to: { compId: 'arm', anchor: 'W' }, dx: 'cap_gap', dy: '0' },
    { id: 's_ext', from: { compId: 'ext', anchor: 'W' }, to: { compId: 'pad', anchor: 'E' }, dx: '0', dy: '0' },
  ];
  return s;
}

describe('makeCellFromSelection', () => {
  const scene = baseScene();
  const { def, warnings } = makeCellFromSelection(scene, new Set(['pad', 'arm']), 'capcell');

  it('collects directly-referenced params AND the transitive closure', () => {
    expect(def).not.toBeNull();
    expect(Object.keys(def.params).sort()).toEqual(['base_t', 'cap_gap', 'cap_w']);
    // base_t is only referenced from cap_w's expr — transitive, so it's
    // flagged internal; the direct interface knobs are cap_w / cap_gap.
    expect(def.internalParamNames).toEqual(['base_t']);
    // Defaults are the scene exprs at capture time.
    expect(def.params.cap_w.expr).toBe('4*base_t');
    expect(def.params.cap_gap.expr).toBe('cap_w/4');
  });

  it('keeps internal snaps and drops boundary-crossing snaps with a warning', () => {
    expect(def.snaps.length).toBe(1);
    expect(def.snaps[0].from.compId).toBe('pad');
    expect(def.snaps[0].to.compId).toBe('arm');
    expect(def.snaps[0].dx).toBe('cap_gap');
    expect(warnings.some(w => /crosses the selection boundary/.test(w))).toBe(true);
    expect(warnings.some(w => /ext/.test(w))).toBe(true);
  });

  it('normalizes positions relative to the selection bbox center', () => {
    // pad: cx 10, w 20 → [0, 20]; arm: cx 30, w 8 → [26, 34].
    // bbox x [0, 34] → center 17; y center 0.
    const pad = def.components.find(c => c.id === 'pad');
    const arm = def.components.find(c => c.id === 'arm');
    expect(pad.cx).toBeCloseTo(-7, 9);
    expect(arm.cx).toBeCloseTo(13, 9);
    expect(pad.cy).toBeCloseTo(0, 9);
    expect(arm.cy).toBeCloseTo(0, 9);
  });

  it('strips consumedBy refs pointing outside the selection (with warning)', () => {
    const s = baseScene();
    s.components = s.components.map(c =>
      c.id === 'arm' ? { ...c, consumedBy: 'ext' } : c
    );
    const { def: d2, warnings: w2 } = makeCellFromSelection(s, new Set(['pad', 'arm']), 'capcell');
    expect(d2.components.find(c => c.id === 'arm').consumedBy).toBeUndefined();
    expect(w2.some(w => /consumedBy/.test(w))).toBe(true);
  });

  it('returns null def for an empty selection', () => {
    const { def: d, warnings: w } = makeCellFromSelection(baseScene(), new Set(), 'nope');
    expect(d).toBeNull();
    expect(w.length).toBeGreaterThan(0);
  });
});

describe('instantiateCell', () => {
  const scene = baseScene();
  const { def } = makeCellFromSelection(scene, new Set(['pad', 'arm']), 'capcell');

  it('prefixes every param and component id, rewrites all references', () => {
    const inst = instantiateCell(def, 'c2', {}, 50, -25);
    expect(Object.keys(inst.params).sort()).toEqual(['c2_base_t', 'c2_cap_gap', 'c2_cap_w']);
    // Default exprs are rename-walked into the instance namespace.
    expect(inst.params.c2_cap_w.expr).toBe('4*c2_base_t');
    expect(inst.params.c2_cap_gap.expr).toBe('c2_cap_w/4');
    expect(inst.components.map(c => c.id).sort()).toEqual(['c2_arm', 'c2_pad']);
    const pad = inst.components.find(c => c.id === 'c2_pad');
    expect(pad.w).toBe('c2_cap_w');
    // Snap endpoints + offset expr remapped.
    expect(inst.snaps.length).toBe(1);
    expect(inst.snaps[0].from.compId).toBe('c2_pad');
    expect(inst.snaps[0].to.compId).toBe('c2_arm');
    expect(inst.snaps[0].dx).toBe('c2_cap_gap');
  });

  it('applies overrides verbatim and tags every component with cellInstance', () => {
    const inst = instantiateCell(def, 'c1', { cap_w: '40' }, 0, 0);
    expect(inst.params.c1_cap_w.expr).toBe('40');
    expect(inst.params.c1_base_t.expr).toBe('5');
    for (const c of inst.components) {
      expect(c.cellInstance).toEqual({ cell: 'capcell', inst: 'c1' });
    }
  });

  it('centers the fragment bbox at (atX, atY), overrides included', () => {
    const inst = instantiateCell(def, 'c3', { cap_w: '40' }, 12, -8);
    const { values } = resolveParams(inst.params);
    const center = cellComponentsBbox(inst.components, values);
    expect(center.cx).toBeCloseTo(12, 9);
    expect(center.cy).toBeCloseTo(-8, 9);
  });
});

describe('two instances coexist', () => {
  const scene = baseScene();
  const { def } = makeCellFromSelection(scene, new Set(['pad', 'arm']), 'capcell');
  const u1 = instantiateCell(def, 'u1', {}, -100, 0);
  const u2 = instantiateCell(def, 'u2', { cap_w: '30' }, 100, 0);
  const merged = normalizeScene({
    ...scene,
    params: { ...scene.params, ...u1.params, ...u2.params },
    components: [...scene.components, ...u1.components, ...u2.components],
    snaps: [...scene.snaps, ...u1.snaps, ...u2.snaps],
    cells: { capcell: def },
  });

  it('keeps the snap graph structurally clean', () => {
    expect(validateSnapGraph(merged.components, merged.snaps)).toEqual([]);
  });

  it('normalizeScene passes scene.cells through (and defaults to {})', () => {
    expect(merged.cells.capcell).toEqual(def);
    expect(normalizeScene(makeBlankScene()).cells).toEqual({});
  });

  it('HFSS export contains BOTH prefixed param sets and parses as Python', () => {
    const { values } = resolveParams(merged.params);
    const code = generateHfssNative(merged, values);
    for (const name of ['u1_cap_w', 'u1_cap_gap', 'u1_base_t', 'u2_cap_w', 'u2_cap_gap', 'u2_base_t']) {
      expect(code).toContain(`set_var("${name}"`);
    }
    expect(code).toContain('u1_pad');
    expect(code).toContain('u2_pad');
    mkdirSync('tests/out', { recursive: true });
    writeFileSync('tests/out/vitest_cells_hfss.py', code);
    expect(() => execSync(
      `python3 -c "import ast; ast.parse(open('tests/out/vitest_cells_hfss.py').read())"`,
      { stdio: 'pipe' }
    )).not.toThrow();
  });
});

describe('updateInstancesFromCell', () => {
  // Build a design with one instance, then hand-edit an override.
  const scene0 = baseScene();
  const { def } = makeCellFromSelection(scene0, new Set(['pad', 'arm']), 'capcell');
  const i1 = instantiateCell(def, 'i1', {}, 200, -40);
  const scene3 = normalizeScene({
    ...scene0,
    params: { ...scene0.params, ...i1.params },
    components: [...scene0.components, ...i1.components],
    snaps: [...scene0.snaps, ...i1.snaps],
    cells: { capcell: def },
  });
  // User override: widen this instance's pad.
  scene3.params.i1_cap_w = { ...scene3.params.i1_cap_w, expr: '99' };

  // New master: cap_gap leaves the interface (snap offset hardcoded),
  // cap_h joins it (drives the arm height).
  const def2 = JSON.parse(JSON.stringify(def));
  def2.params.cap_h = { expr: '12', unit: 'µm', desc: 'arm height' };
  delete def2.params.cap_gap;
  def2.snaps[0].dx = '5';
  def2.components.find(c => c.id === 'arm').h = 'cap_h';

  const { values: pvBefore } = resolveParams(scene3.params);
  const instComps = (s) => s.components.filter(c => c.cellInstance && c.cellInstance.inst === 'i1');
  const before = cellComponentsBbox(instComps(scene3), pvBefore);

  const { scene: next, summary } = updateInstancesFromCell(scene3, def2);

  it('preserves user-edited override exprs and applies new defaults', () => {
    expect(next.params.i1_cap_w.expr).toBe('99');   // user override kept
    expect(next.params.i1_base_t.expr).toBe('5');   // untouched default kept
    expect(next.params.i1_cap_h.expr).toBe('12');   // new param → default
    expect(next.params.i1_cap_gap).toBeUndefined(); // orphaned → dropped
  });

  it('rebuilds the instance geometry from the new master', () => {
    const arm = next.components.find(c => c.id === 'i1_arm');
    expect(arm.h).toBe('i1_cap_h');
    const snap = next.snaps.find(s => s.to && s.to.compId === 'i1_arm');
    expect(snap.dx).toBe('5');
    // Tags survive the rebuild.
    expect(arm.cellInstance).toEqual({ cell: 'capcell', inst: 'i1' });
  });

  it('keeps the instance center (numeric)', () => {
    const { values: pvAfter } = resolveParams(next.params);
    const after = cellComponentsBbox(instComps(next), pvAfter);
    expect(after.cx).toBeCloseTo(before.cx, 6);
    expect(after.cy).toBeCloseTo(before.cy, 6);
  });

  it('reports the change summary and refreshes scene.cells', () => {
    expect(summary.instances.length).toBe(1);
    const s = summary.instances[0];
    expect(s.inst).toBe('i1');
    expect(s.keptOverrides).toEqual(['i1_base_t', 'i1_cap_w']);
    expect(s.addedParams).toContain('i1_cap_h');
    expect(s.removedParams).toEqual(['i1_cap_gap']);
    expect(s.droppedExternalSnaps).toBe(0);
    expect(next.cells.capcell).toEqual(def2);
    // Input scene untouched (pure function).
    expect(scene3.params.i1_cap_gap).toBeDefined();
  });

  it('is a no-op (plus def registration) when no instances exist', () => {
    const plain = baseScene();
    const r = updateInstancesFromCell(plain, def2);
    expect(r.summary.instances).toEqual([]);
    expect(r.scene.components).toEqual(plain.components);
    expect(r.scene.cells.capcell).toEqual(def2);
  });
});

describe('cell workspace storage round-trip', () => {
  let prevWindow;
  beforeAll(() => {
    // In-memory window.storage matching the host KV interface used by
    // src/storage/{workspace,library-items}.js.
    prevWindow = globalThis.window;
    const mem = new Map();
    globalThis.window = {
      storage: {
        async list(prefix) { return { keys: [...mem.keys()].filter(k => k.startsWith(prefix)) }; },
        async get(key) { return mem.has(key) ? { value: mem.get(key) } : null; },
        async set(key, value) { mem.set(key, value); },
        async delete(key) { mem.delete(key); },
      },
    };
  });
  afterAll(() => {
    if (prevWindow === undefined) delete globalThis.window;
    else globalThis.window = prevWindow;
  });

  it('save / list / load / export / import / delete', async () => {
    const scene = baseScene();
    const { def } = makeCellFromSelection(scene, new Set(['pad', 'arm']), 'capcell');

    expect(await saveCellDef('wsA', 'capcell', def)).toBe(true);
    expect(await listCellDefs('wsA')).toContain('capcell');
    expect(await loadCellDef('wsA', 'capcell')).toEqual(def);

    // exportWorkspace bundles cells; importWorkspace restores them.
    const bundle = await exportWorkspace('wsA');
    expect(bundle.cells.capcell).toEqual(def);
    const counts = await importWorkspace('wsB', bundle, 'overwrite');
    expect(counts.cells).toBe(1);
    expect(await loadCellDef('wsB', 'capcell')).toEqual(def);

    // merge mode skips an existing name.
    const counts2 = await importWorkspace('wsB', bundle, 'merge');
    expect(counts2.cells).toBe(0);
    expect(counts2.skipped).toContain('cell:capcell');

    expect(await deleteCellDef('wsA', 'capcell')).toBe(true);
    expect(await listCellDefs('wsA')).not.toContain('capcell');
  });
});
