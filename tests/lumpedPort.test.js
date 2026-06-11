// Lumped-port adjacency detection (detectPortIntegrationLine).
//
// Regression: the EW/NS flanker path filtered expandTransforms output on
// `c.layer` / `c.id`, but expanded instances only carry `compId` — the
// electrode list was always empty, so flanked ports never detected a
// direction and generateHfssNative never emitted AssignLumpedPort for
// them. Instances must be mapped back to their source component (via
// compId) to recover layer/id while keeping the transformed extents.
import { describe, it, expect } from 'vitest';
import { detectPortIntegrationLine } from '../src/scene/lumpedPort.js';
import { solveLayout } from '../src/scene/solver.js';
import { generateHfssNative } from '../src/export/hfss-native.js';
import { makeDefaultScene } from '../src/scene/schema.js';
import { resolveParams } from '../src/scene/params.js';

const defaults = makeDefaultScene();

const ewComponents = () => [
  { id: 'elL', kind: 'rect', layer: 'electrode', cx: -10, cy: 0, w: '10', h: '4', cutouts: [], transforms: [] },
  { id: 'elR', kind: 'rect', layer: 'electrode', cx: 10, cy: 0, w: '10', h: '4', cutouts: [], transforms: [] },
  { id: 'p1', kind: 'rect', layer: 'port', cx: 0, cy: 0, w: '10', h: '4', cutouts: [], transforms: [], lumpedPort: { enabled: true } },
];

describe('detectPortIntegrationLine — flanked-port adjacency', () => {
  it('detects EW for a port flanked by electrodes on its W and E edges', () => {
    const solved = solveLayout(ewComponents(), [], {});
    const det = detectPortIntegrationLine(solved.find(c => c.id === 'p1'), solved, {});
    expect(det.direction).toBe('EW');
    expect(det.from).toBe('elL');
    expect(det.to).toBe('elR');
    expect(det.line).toEqual({ startX: -5, endX: 5, midY: 0 });
  });

  it('detects NS for a port flanked by electrodes on its S and N edges', () => {
    const comps = [
      { id: 'elB', kind: 'rect', layer: 'electrode', cx: 0, cy: -10, w: '4', h: '10', cutouts: [], transforms: [] },
      { id: 'elT', kind: 'rect', layer: 'electrode', cx: 0, cy: 10, w: '4', h: '10', cutouts: [], transforms: [] },
      { id: 'p1', kind: 'rect', layer: 'port', cx: 0, cy: 0, w: '4', h: '10', cutouts: [], transforms: [], lumpedPort: { enabled: true } },
    ];
    const solved = solveLayout(comps, [], {});
    const det = detectPortIntegrationLine(solved.find(c => c.id === 'p1'), solved, {});
    expect(det.direction).toBe('NS');
    expect(det.from).toBe('elB');
    expect(det.to).toBe('elT');
    expect(det.line).toEqual({ startY: -5, endY: 5, midX: 0 });
  });

  it('sees repeat-transform copies as flankers (transformed instances, not base positions)', () => {
    // One electrode at x=-10 with repeat dx=20 → copies at -10 and +10.
    // The east flanker exists ONLY as an expanded instance — this is the
    // path that breaks if the instance→source mapping is lost.
    const comps = [
      { id: 'el', kind: 'rect', layer: 'electrode', cx: -10, cy: 0, w: '10', h: '4', cutouts: [],
        transforms: [{ id: 't1', kind: 'repeat', enabled: true, n: 1, dx: 20, dy: 0, includeOriginal: true }] },
      { id: 'p1', kind: 'rect', layer: 'port', cx: 0, cy: 0, w: '10', h: '4', cutouts: [], transforms: [], lumpedPort: { enabled: true } },
    ];
    const solved = solveLayout(comps, [], {});
    const det = detectPortIntegrationLine(solved.find(c => c.id === 'p1'), solved, {});
    expect(det.direction).toBe('EW');
    expect(det.from).toBe('el');
    expect(det.to).toBe('el');
  });

  it('returns no direction for an unflanked port', () => {
    const comps = [
      { id: 'el', kind: 'rect', layer: 'electrode', cx: -50, cy: 0, w: '10', h: '4', cutouts: [], transforms: [] },
      { id: 'p1', kind: 'rect', layer: 'port', cx: 0, cy: 0, w: '10', h: '4', cutouts: [], transforms: [], lumpedPort: { enabled: true } },
    ];
    const solved = solveLayout(comps, [], {});
    const det = detectPortIntegrationLine(solved.find(c => c.id === 'p1'), solved, {});
    expect(det.direction).toBeNull();
  });
});

describe('generateHfssNative — lumped port on a flanked port', () => {
  it('emits AssignLumpedPort for a port flanked by separate electrodes', () => {
    const s = {
      params: { h_cond: { expr: '0.5' }, h_wg: { expr: '0.3' } },
      components: ewComponents(),
      snaps: [], mirrors: [], groups: [], booleans: [],
      stack: defaults.stack, stackName: defaults.stackName, simSetup: defaults.simSetup,
    };
    const { values: pv } = resolveParams(s.params);
    const out = generateHfssNative(s, pv);
    expect(out).toContain('AssignLumpedPort');
    expect(out).toContain('NAME:LumpedPort_p1');
    // Integration line runs W→E across the port at its mid-Y.
    expect(out).toContain('integration line EW from elL to elR');
  });
});
