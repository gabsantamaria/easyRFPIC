// Snap-to-replica: a component snap may target a SPECIFIC instance produced
// by the parent's `repeat`/`displace` chain via from.instanceIdx. The solver
// shifts the reference anchor by the base→instance-k chain offset, the HFSS
// export emits that offset PARAMETRICALLY (base + k·pitch — the same form the
// repeat exports as DuplicateAlongLine), and the Alt-drag candidate index
// offers replica anchors. Reuses the polyline snap-vertex instance machinery.
import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import { writeFileSync, mkdirSync } from 'fs';
import { solveLayout, getLastSolveDiagnostics } from '../src/scene/solver.js';
import { expandTransforms } from '../src/scene/transforms.js';
import { computeParametricPositions, generateHfssNative } from '../src/export/hfss-native.js';
import { normalizeScene, makeDefaultScene, paramsForStack } from '../src/scene/schema.js';
import { buildAltDragTargetIndex, findAltDragSnapCandidate } from '../src/ui/canvas/Canvas.jsx';

const defaultScene = makeDefaultScene();
const mkScene = (components, snaps = [], params = {}) => normalizeScene({
  params: { ...paramsForStack(defaultScene.stack), ...params },
  components, snaps, mirrors: [], groups: [], booleans: [],
  stack: defaultScene.stack, stackName: defaultScene.stackName, simSetup: defaultScene.simSetup,
});
const mkRect = (id, extra = {}) => ({
  id, kind: 'rect', layer: 'electrode', cx: 0, cy: 0, w: '20', h: '10', cutouts: [], transforms: [], ...extra,
});
// A repeated parent: base + 3 copies at +50µm along x ⇒ instances at x = 0,50,100,150.
const repeatX = (n = '3', dx = '50') => [{ id: 'r1', kind: 'repeat', enabled: true, n, dx, dy: '0', includeOriginal: true }];

describe('solver: snap to a repeat replica', () => {
  const parent = () => mkRect('p', { cx: 0, cy: 0, w: '20', h: '10', transforms: repeatX() });
  const child = () => mkRect('c', { cx: 0, cy: 0, w: '4', h: '4' });
  const snapTo = (idx) => [{ id: 's1', from: { compId: 'p', anchor: 'E', ...(idx != null ? { instanceIdx: idx } : {}) }, to: { compId: 'c', anchor: 'W' }, dx: '0', dy: '0' }];

  it('base anchor (no instanceIdx) is unchanged — parent.E=10 → child.cx=12', () => {
    const solved = solveLayout([parent(), child()], snapTo(null), {});
    const sc = solved.find(x => x.id === 'c');
    expect(sc.cx).toBeCloseTo(12, 9);
    expect(sc.cy).toBeCloseTo(0, 9);
  });

  it('instanceIdx 1 lands on the first replica — (0+50).E=60 → child.cx=62', () => {
    const solved = solveLayout([parent(), child()], snapTo(1), {});
    expect(solved.find(x => x.id === 'c').cx).toBeCloseTo(62, 9);
  });

  it('instanceIdx 2 lands on the second replica — (0+100).E=110 → child.cx=112', () => {
    const solved = solveLayout([parent(), child()], snapTo(2), {});
    expect(solved.find(x => x.id === 'c').cx).toBeCloseTo(112, 9);
  });

  it('the replica offset tracks a parametric pitch param', () => {
    const solved = solveLayout(
      [mkRect('p', { w: '20', h: '10', transforms: repeatX('3', 'pitch') }), child()],
      snapTo(2), { pitch: 80 },
    );
    // replica-2 at x = 2*80 = 160; E = 170; child.cx = 172.
    expect(solved.find(x => x.id === 'c').cx).toBeCloseTo(172, 9);
  });

  it('out-of-range instanceIdx falls back to the base anchor + emits a diagnostic', () => {
    const solved = solveLayout([parent(), child()], snapTo(99), {});
    expect(solved.find(x => x.id === 'c').cx).toBeCloseTo(12, 9); // base, not replica
    const diag = getLastSolveDiagnostics();
    expect(diag.issues.some(i => i.kind === 'dangling-instance')).toBe(true);
  });
});

describe('HFSS export: replica snap stays parametric', () => {
  it('child cxExpr adds the parametric k·pitch instance offset (not a baked number)', () => {
    const scene = mkScene(
      [mkRect('p', { cx: 0, cy: 0, w: '20', h: '10', transforms: repeatX('3', 'pitch') }),
       mkRect('c', { cx: 112, cy: 0, w: '4', h: '4' })],
      [{ id: 's1', from: { compId: 'p', anchor: 'E', instanceIdx: 2 }, to: { compId: 'c', anchor: 'W' }, dx: '0', dy: '0' }],
      { pitch: { expr: '50', unit: 'µm' } },
    );
    const solved = solveLayout(scene.components, scene.snaps, { pitch: 50 });
    const pp = computeParametricPositions(solved, scene.snaps, { pitch: 50 });
    const cx = pp['c'].cxExpr;
    expect(cx).toContain('pitch');     // the repeat pitch param flows in
    expect(cx).toContain('2 * ');      // factor-2 offset for instance 2
  });

  it('base snap (no instanceIdx) emits NO instance offset term', () => {
    const scene = mkScene(
      [mkRect('p', { cx: 0, cy: 0, w: '20', h: '10', transforms: repeatX('3', 'pitch') }),
       mkRect('c', { cx: 12, cy: 0, w: '4', h: '4' })],
      [{ id: 's1', from: { compId: 'p', anchor: 'E' }, to: { compId: 'c', anchor: 'W' }, dx: '0', dy: '0' }],
      { pitch: { expr: '50', unit: 'µm' } },
    );
    const solved = solveLayout(scene.components, scene.snaps, { pitch: 50 });
    const pp = computeParametricPositions(solved, scene.snaps, { pitch: 50 });
    expect(pp['c'].cxExpr).not.toContain('2 * (pitch)');
  });

  it('the full native HFSS script with a replica snap parses as Python', () => {
    const scene = mkScene(
      [mkRect('p', { cx: 0, cy: 0, w: '20', h: '10', transforms: repeatX('4', 'pitch') }),
       mkRect('c', { cx: 162, cy: 0, w: '4', h: '4' })],
      [{ id: 's1', from: { compId: 'p', anchor: 'E', instanceIdx: 3 }, to: { compId: 'c', anchor: 'W' }, dx: '0', dy: '0' }],
      { pitch: { expr: '50', unit: 'µm' } },
    );
    const py = generateHfssNative(scene);
    mkdirSync('tests/out', { recursive: true });
    writeFileSync('tests/out/replica_snap_hfss.py', py);
    execSync('python3 -c "import ast; ast.parse(open(\'tests/out/replica_snap_hfss.py\').read())"');
    expect(py).toContain('pitch');
  });
});

describe('Alt-drag candidate index offers replica anchors', () => {
  const parent = mkRect('p', { cx: 0, cy: 0, w: '20', h: '10', transforms: repeatX('3', '50') });
  const solved = solveLayout([parent], [], {});
  const instances = expandTransforms(solved, {});

  it('with instances, a drag near replica-2.E finds a candidate carrying instanceIdx 2', () => {
    const index = buildAltDragTargetIndex(solved, {}, null, instances);
    // A 4×4 box whose W anchor sits at replica-2's E anchor (110, 0) ⇒ center 112.
    const search = findAltDragSnapCandidate(index, { proposedCx: 112, proposedCy: 0, dw: 4, dh: 4, worldThresh: 5 });
    expect(search.best).toBeTruthy();
    expect(search.best.kind).toBe('anchor');
    expect(search.best.target.compId).toBe('p');
    expect(search.best.target.instanceIdx).toBe(2);
  });

  it('without instances (base-only), no replica candidate is offered there', () => {
    const index = buildAltDragTargetIndex(solved, {}, null, null);
    const search = findAltDragSnapCandidate(index, { proposedCx: 112, proposedCy: 0, dw: 4, dh: 4, worldThresh: 5 });
    // The base parent.E is at (10,0), far from (110,0) → nothing within threshold.
    expect(search.best).toBeFalsy();
  });

  it('base anchors carry NO instanceIdx (explicit 0 now means "the rendered instance 0")', () => {
    // Contract change with the moved-instance-0 feature: a base-record
    // candidate commits a LEGACY snap (no instanceIdx — displayBbox/base
    // semantics); only instance records carry an integer idx, and an
    // unmoved instance 0 emits no record at all (byte-compat).
    const index = buildAltDragTargetIndex(solved, {}, null, instances);
    // Drag near the BASE parent.E (10,0) ⇒ center 12.
    const search = findAltDragSnapCandidate(index, { proposedCx: 12, proposedCy: 0, dw: 4, dh: 4, worldThresh: 5 });
    expect(search.best.target.compId).toBe('p');
    expect(search.best.target.instanceIdx).toBeUndefined();
  });
});
