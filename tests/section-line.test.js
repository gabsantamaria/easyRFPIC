// Section line (non-model cross-section cut) — plumbing contract.
//
// A section line is a 2-point polyline on layer 'section'. It must:
//   - solve like any polyline (snap vertices, parametric length)
//   - NEVER emit geometry in any export (HFSS native, pyAEDT, GDS,
//     gdsfactory, 3-D viewer) — the central isNonModelComponent predicate
//   - keep its own LAYERS-panel visibility family ('section')
// The cross-section EXTRACTION itself is covered in cross-section.test.js;
// this file covers the exclusion plumbing.
import { describe, it, expect } from 'vitest';
import { normalizeScene, makeBlankScene, isNonModelComponent } from '../src/scene/schema.js';
import { resolveParams } from '../src/scene/params.js';
import { solveLayout } from '../src/scene/solver.js';
import { resolvePolylineVertices } from '../src/geometry/polyline.js';
import { generateHfssNative } from '../src/export/hfss-native.js';
import { generatePyAEDT } from '../src/export/pyaedt.js';
import { generateGDS } from '../src/export/gds.js';
import { generateGdsfactory } from '../src/export/gdsfactory.js';
import { buildScene3D } from '../src/scene/scene3d.js';
import { layerVisKey } from '../src/ui/canvas/layer-visibility.js';

// One electrode + one section line whose length is the sec1_L param and
// whose START vertex is snap-pinned to the electrode's W anchor — the
// "inherits polyline features" contract in miniature.
const sectionScene = () => {
  const s = makeBlankScene();
  s.params.sec1_L = { expr: '80', unit: 'µm', desc: 'section length' };
  s.components.push(
    { id: 'el1', kind: 'rect', layer: 'electrode', cx: 0, cy: 0, w: '20', h: '10', cutouts: [], transforms: [] },
    {
      id: 'sec1', kind: 'polyline', layer: 'section', cx: -30, cy: 0,
      width: '0', w: '0', h: '0', closed: false, cutouts: [], transforms: [],
      vertices: [
        { kind: 'snap', compId: 'el1', anchor: 'W' },
        { kind: 'rel', dx: 'sec1_L', dy: '0' },
      ],
    },
  );
  return normalizeScene(s);
};

describe('section line: non-model plumbing', () => {
  it('isNonModelComponent keys off layer === section', () => {
    expect(isNonModelComponent({ layer: 'section' })).toBe(true);
    expect(isNonModelComponent({ layer: 'electrode' })).toBe(false);
    expect(isNonModelComponent(null)).toBe(false);
  });

  it('solves like a polyline: snap vertex lands on the anchor, length is the param', () => {
    const scene = sectionScene();
    const pv = resolveParams(scene.params).values;
    const solved = solveLayout(scene.components, scene.snaps, pv);
    const byId = Object.fromEntries(solved.map(c => [c.id, c]));
    const verts = resolvePolylineVertices(byId.sec1, byId, pv);
    // vertex 0 pinned to el1's W anchor = (-10, 0); vertex 1 at +sec1_L
    expect(verts[0][0]).toBeCloseTo(-10, 6);
    expect(verts[0][1]).toBeCloseTo(0, 6);
    expect(verts[1][0]).toBeCloseTo(-10 + 80, 6);
    expect(verts[1][1]).toBeCloseTo(0, 6);
  });

  it('is absent from every exporter output', () => {
    const scene = sectionScene();
    const pv = resolveParams(scene.params).values;
    const hfss = generateHfssNative(scene, pv, {});
    // The electrode is there; the section line is not (neither geometry
    // nor its polyline CreatePolyline emission).
    expect(hfss).toContain('el1');
    expect(hfss).not.toContain('"sec1"');
    expect(hfss).not.toMatch(/Name:=", "sec1/);
    const py = generatePyAEDT(scene, pv);
    expect(py).toContain('el1');
    expect(py).not.toMatch(/["']sec1["']/);
    const gds = generateGDS(scene, pv);
    // GDS is binary; the electrode emits a BOUNDARY. A section line would
    // add records — compare against the same scene WITHOUT the line.
    const noSec = normalizeScene({ ...scene, components: scene.components.filter(c => c.id !== 'sec1') });
    const gdsNoSec = generateGDS(noSec, pv);
    expect(gds.byteLength ?? gds.length).toBe(gdsNoSec.byteLength ?? gdsNoSec.length);
    const gf = generateGdsfactory(scene, pv);
    // The sec1_L PARAM legitimately rides along as a kwarg (params are
    // inert); the sec1 GEOMETRY must not (\bsec1\b won't match sec1_L).
    expect(gf).not.toMatch(/\bsec1\b/);
  });

  it('emits no 3-D solid', () => {
    const scene = sectionScene();
    const pv = resolveParams(scene.params).values;
    const { solids } = buildScene3D(scene, pv);
    expect(solids.some(s => s.compId === 'sec1' || s.selectId === 'sec1')).toBe(false);
    // the electrode still builds
    expect(solids.some(s => s.compId === 'el1')).toBe(true);
  });

  it('has its own layer-visibility family', () => {
    const scene = sectionScene();
    const byId = Object.fromEntries(scene.components.map(c => [c.id, c]));
    expect(layerVisKey(byId.sec1, byId, scene.stack)).toBe('section');
  });

  it('sec1_L sweeps the line length (param → geometry)', () => {
    const scene = sectionScene();
    const pv2 = resolveParams({ ...scene.params, sec1_L: { expr: '140', unit: 'µm', desc: '' } }).values;
    const solved = solveLayout(scene.components, scene.snaps, pv2);
    const byId = Object.fromEntries(solved.map(c => [c.id, c]));
    const verts = resolvePolylineVertices(byId.sec1, byId, pv2);
    expect(verts[1][0] - verts[0][0]).toBeCloseTo(140, 6);
  });
});

describe('components snapped TO a section line still export correctly', () => {
  // A model rect whose position comes from a snap whose FROM is the section
  // line: exporters filter the line from geometry but the position chain
  // must still resolve (pp computed on the FULL solved list).
  const snappedScene = () => {
    const s = makeBlankScene();
    s.params.sec1_L = { expr: '80', unit: 'µm', desc: '' };
    s.components.push(
      {
        id: 'sec1', kind: 'polyline', layer: 'section', cx: -30, cy: 0,
        width: '0', w: '0', h: '0', closed: false, cutouts: [], transforms: [],
        vertices: [
          { kind: 'rel', dx: '0', dy: '0' },
          { kind: 'rel', dx: 'sec1_L', dy: '0' },
        ],
      },
      { id: 'el2', kind: 'rect', layer: 'electrode', cx: 999, cy: 999, w: '20', h: '10', cutouts: [], transforms: [] },
    );
    s.snaps.push({ id: 'sn1', from: { compId: 'sec1', anchor: 'C' }, to: { compId: 'el2', anchor: 'C' }, dx: '0', dy: '15' });
    return normalizeScene(s);
  };

  it('gdsfactory places the snapped child at its solved position, not the origin', () => {
    const scene = snappedScene();
    const pv = resolveParams(scene.params).values;
    const solved = solveLayout(scene.components, scene.snaps, pv);
    const el2 = solved.find(c => c.id === 'el2');
    // solver: sec1 bbox center + (0, 15)
    expect(Number.isFinite(el2.cx)).toBe(true);
    // the snap places el2 at sec1's bbox center + (0, 15) — NOT at its
    // stale scene cx/cy (999, 999)
    expect(el2.cy).toBeCloseTo(15, 6);
    const gf = generateGdsfactory(scene, pv);
    // the emitted geometry must reference the SOLVED center, and the stale
    // pre-solve (999, 999) must not leak in anywhere
    expect(gf).not.toContain('999');
    expect(gf).not.toMatch(/\bsec1\b/);
  });
});
