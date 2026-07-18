// Self-intersecting closed outlines: AEDT/Parasolid hard-rejects them on
// CreatePolyline (PK_ERROR_crossing_edge) and the part vanishes from the
// model. Real shipped failure: the V2 balun node hexagon's CPS-facing
// side length (1.5*node_size - CPW_W/2) went NEGATIVE at node_size=10 /
// CPW_W=32 — an invisible ~1 um bowtie on canvas, fatal in HFSS. The app
// now detects the crossing (ringSelfIntersects) and warns in the export.
import { describe, it, expect } from 'vitest';
import { ringSelfIntersects } from '../src/geometry/polyline.js';
import { normalizeScene } from '../src/scene/schema.js';
import { resolveParams } from '../src/scene/params.js';
import { generateHfssNative } from '../src/export/hfss-native.js';

describe('ringSelfIntersects', () => {
  it('clean polygons pass', () => {
    expect(ringSelfIntersects([[0, 0], [10, 0], [10, 10], [0, 10]])).toBe(false);
    expect(ringSelfIntersects([[0, 0], [10, 0], [5, 8]])).toBe(false);
    // hexagon
    const hex = [...Array(6)].map((_, k) => [Math.cos(k * Math.PI / 3), Math.sin(k * Math.PI / 3)]);
    expect(ringSelfIntersects(hex)).toBe(false);
  });
  it('bowtie crossings are caught', () => {
    expect(ringSelfIntersects([[0, 0], [10, 10], [10, 0], [0, 10]])).toBe(true);
  });
});

// The exact V2 node vertex chain, parametric — the geometry that failed.
const nodeComp = () => ({
  transforms: [], id: 'node', kind: 'polyshape', layer: 'electrode',
  cx: 0, cy: 0, w: '0', h: '0', closed: true, cutouts: [],
  cxExpr: 'jx + (nd*cos(pi/6))*cos(60*pi/180) + (cw/2)*sin(60*pi/180)',
  cyExpr: 'jy + (nd*cos(pi/6))*sin(60*pi/180) - (cw/2)*cos(60*pi/180)',
  vertices: (() => {
    const px = (t, s) => `(nd*cos(pi/6))*cos(${t}*pi/180) ${s > 0 ? '-' : '+'} (cw/2)*sin(${t}*pi/180)`;
    const py = (t, s) => `(nd*cos(pi/6))*sin(${t}*pi/180) ${s > 0 ? '+' : '-'} (cw/2)*cos(${t}*pi/180)`;
    const ORDER = [[60, -1], [60, 1], [180, -1], [180, 1], [300, -1], [300, 1]];
    const vs = [{ kind: 'rel', dx: '0', dy: '0' }];
    for (let i = 1; i < 6; i++) {
      const [t1, s1] = ORDER[i], [t0, s0] = ORDER[i - 1];
      vs.push({ kind: 'rel', dx: `(${px(t1, s1)}) - (${px(t0, s0)})`, dy: `(${py(t1, s1)}) - (${py(t0, s0)})` });
    }
    return vs;
  })(),
});

const mkScene = (nd) => normalizeScene({
  params: {
    jx: { expr: '0', unit: 'µm' }, jy: { expr: '0', unit: 'µm' },
    cw: { expr: '32', unit: 'µm' }, nd: { expr: String(nd), unit: 'µm' },
  },
  components: [nodeComp()],
  snaps: [],
});

describe('HFSS export warns on a degenerate balun node', () => {
  it('node_size < CPW_W/3 → self-intersects → WARNING + caveat in the script', () => {
    const scene = mkScene(10); // 1.5*10 - 16 = -1 → crossing
    const pv = resolveParams(scene.params).values;
    const script = generateHfssNative(scene, pv, {});
    expect(script).toContain('SELF-INTERSECTS');
    expect(script).toContain('PK_ERROR_crossing_edge');
  });
  it('node_size >= CPW_W/3 → clean, no warning', () => {
    const scene = mkScene(12); // 1.5*12 - 16 = +2 → valid
    const pv = resolveParams(scene.params).values;
    const script = generateHfssNative(scene, pv, {});
    expect(script).not.toContain('SELF-INTERSECTS');
  });
});
