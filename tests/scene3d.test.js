// 3-D viewer spec builder (src/scene/scene3d.js) — spec-level tests, NO
// three.js. buildScene3D is pure: it consumes the same solver/transform/
// ring pipeline as the canvas and the same numeric Z walk as pyAEDT
// (computeNumericLayerZ), and must have ZERO effect on the scene model or
// any export path (it only reads).
import { describe, it, expect } from 'vitest';
import { buildScene3D } from '../src/scene/scene3d.js';
import { computeNumericLayerZ } from '../src/scene/layer-z.js';
import { normalizeScene, makeDefaultScene, makeBlankScene } from '../src/scene/schema.js';
import { resolveParams } from '../src/scene/params.js';
import { layerVisKey, computeHiddenCompIds } from '../src/ui/canvas/layer-visibility.js';

const pvOf = (scene) => resolveParams(scene.params).values;

// Blank scene + injected components, pre-normalized so param defaults from
// the stack are present for resolveParams.
function sceneWith(components, extra = {}) {
  return normalizeScene({ ...makeBlankScene(), components, ...extra });
}

describe('buildScene3D — default scene', () => {
  const scene = normalizeScene(makeDefaultScene());
  const pv = pvOf(scene);
  const { solids, warnings } = buildScene3D(scene, pv);
  const layerZ = computeNumericLayerZ(scene.stack, pv);
  const wgLayer = scene.stack.find(l => l.role === 'waveguide');
  const condLayer = scene.stack.find(l => l.role === 'conductor');

  it('produces solids', () => {
    expect(solids.length).toBeGreaterThan(0);
  });

  it('waveguide rect → slab + rib at the wg layer Z from computeNumericLayerZ', () => {
    const wgSolids = solids.filter(s => s.compId === 'wg1');
    expect(wgSolids.length).toBe(2); // slab + rib
    const slab = wgSolids.find(s => /slab/.test(s.label));
    const rib = wgSolids.find(s => /rib/.test(s.label));
    expect(slab).toBeTruthy();
    expect(rib).toBeTruthy();
    expect(slab.zBottom).toBeCloseTo(layerZ[wgLayer.id].zBottom, 9);
    expect(slab.height).toBeCloseTo(pv.h_slab, 9);
    expect(rib.zBottom).toBeCloseTo(layerZ[wgLayer.id].zBottom + pv.h_slab, 9);
    // Rib top = wg layer top.
    expect(rib.zBottom + rib.height).toBeCloseTo(layerZ[wgLayer.id].zTop, 9);
    // v1 approximation is flagged.
    expect(warnings.some(w => /rectangular rib/i.test(w))).toBe(true);
  });

  it('electrode at conductor zBottom with h_cond height', () => {
    const e = solids.find(s => s.compId === 'cond1');
    expect(e).toBeTruthy();
    expect(e.kind).toBe('extrude');
    expect(e.zBottom).toBeCloseTo(layerZ[condLayer.id].zBottom, 9);
    expect(e.height).toBeCloseTo(pv.h_cond, 9);
  });

  it('port rects render as thin sheets', () => {
    const p = solids.find(s => s.compId === 'port1');
    expect(p).toBeTruthy();
    expect(p.height).toBeLessThanOrEqual(0.05 + 1e-12);
    expect(p.layerKey).toBe('port');
  });

  it('layerKey matches layer-visibility.js exactly', () => {
    const compById = Object.fromEntries(scene.components.map(c => [c.id, c]));
    for (const s of solids) {
      if (!s.compId) continue; // stack slabs
      const c = compById[s.compId];
      expect(s.layerKey).toBe(layerVisKey(c, compById, scene.stack));
    }
  });

  it("hiding 'cond:<id>' filters exactly the electrode solids (canvas parity)", () => {
    const hidden = new Set([`cond:${condLayer.id}`]);
    const visible = solids.filter(s => !(s.layerKey && hidden.has(s.layerKey)));
    const removed = solids.filter(s => s.layerKey && hidden.has(s.layerKey));
    expect(removed.length).toBeGreaterThan(0);
    expect(removed.every(s => ['cond1', 'cond1_copy'].includes(s.compId))).toBe(true);
    // The same components the canvas would hide.
    const hiddenIds = computeHiddenCompIds(scene.components, hidden, scene.stack);
    expect(new Set(removed.map(s => s.compId))).toEqual(hiddenIds);
    expect(visible.some(s => s.compId === 'wg1')).toBe(true);
  });

  it('cladding: translucent box spanning at least the geometry bbox', () => {
    const cladLayer = scene.stack.find(l => l.role === 'cladding');
    const clad = solids.find(s => s.layerKey === `stack:${cladLayer.id}`);
    expect(clad).toBeTruthy();
    expect(clad.opacity).toBeLessThan(0.2);
    expect(clad.role).toBe('stack');
    // Geometry bbox from component solids.
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const s of solids) {
      if (!s.compId || s.kind !== 'extrude') continue;
      for (const [x, y] of s.ring) {
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      }
    }
    const xs = clad.ring.map(p => p[0]);
    const ys = clad.ring.map(p => p[1]);
    expect(Math.min(...xs)).toBeLessThanOrEqual(minX);
    expect(Math.max(...xs)).toBeGreaterThanOrEqual(maxX);
    expect(Math.min(...ys)).toBeLessThanOrEqual(minY);
    expect(Math.max(...ys)).toBeGreaterThanOrEqual(maxY);
    // Cladding Z span = its stack layer.
    expect(clad.zBottom).toBeCloseTo(layerZ[cladLayer.id].zBottom, 9);
    expect(clad.height).toBeCloseTo(layerZ[cladLayer.id].thickness, 9);
  });

  it('substrate slabs present, translucent, below Z=0', () => {
    const subs = solids.filter(s => s.role === 'stack' && /substrate/.test(s.label));
    expect(subs.length).toBeGreaterThan(0);
    for (const s of subs) {
      expect(s.opacity).toBeLessThanOrEqual(0.25);
      expect(s.zBottom + s.height).toBeLessThanOrEqual(1e-9);
    }
  });

  it('does not mutate the input scene (viewer-only guarantee)', () => {
    const fresh = normalizeScene(makeDefaultScene());
    const snapshot = JSON.stringify(fresh);
    buildScene3D(fresh, pvOf(fresh));
    expect(JSON.stringify(fresh)).toBe(snapshot);
  });
});

describe('buildScene3D — via', () => {
  it('cylinder spans layerFrom.zBottom → layerTo.zTop', () => {
    const scene = sceneWith([
      { id: 'v1', kind: 'via', layer: 'via', cx: 5, cy: -3, r: '2', layerFrom: 'l_sio2', layerTo: 'l_cond' },
    ]);
    const pv = pvOf(scene);
    const layerZ = computeNumericLayerZ(scene.stack, pv);
    const { solids } = buildScene3D(scene, pv);
    const via = solids.find(s => s.compId === 'v1');
    expect(via).toBeTruthy();
    expect(via.kind).toBe('cylinder');
    expect(via.cx).toBeCloseTo(5, 9);
    expect(via.cy).toBeCloseTo(-3, 9);
    expect(via.r).toBeCloseTo(2, 9);
    expect(via.zBottom).toBeCloseTo(layerZ.l_sio2.zBottom, 9);
    expect(via.zBottom + via.height).toBeCloseTo(layerZ.l_cond.zTop, 9);
    expect(via.layerKey).toBe('via');
  });

  it('identical layerFrom/layerTo is repaired by normalizeScene → via still emits', () => {
    // normalizeScene rewrites layerTo to a different stack layer when it
    // matches layerFrom, so buildScene3D (which normalizes internally)
    // still gets a valid span; the internal skip-guard stays defensive.
    const scene = sceneWith([
      { id: 'v2', kind: 'via', layer: 'via', cx: 0, cy: 0, r: '2', layerFrom: 'l_sio2', layerTo: 'l_sio2' },
    ]);
    const { solids } = buildScene3D(scene, pvOf(scene));
    const via = solids.find(s => s.compId === 'v2');
    expect(via).toBeTruthy();
    expect(via.height).toBeGreaterThan(0);
  });
});

describe('buildScene3D — bridge', () => {
  it('profile starts/ends at conductor zTop; apex = zTop + H', () => {
    const scene = sceneWith([
      { id: 'br1', kind: 'bridge', layer: 'bridge', cx: 10, cy: 20, length: '30', width: '10', height: '3' },
    ]);
    const pv = pvOf(scene);
    const layerZ = computeNumericLayerZ(scene.stack, pv);
    const condTop = layerZ.l_cond.zTop;
    const { solids } = buildScene3D(scene, pv);
    const br = solids.find(s => s.compId === 'br1');
    expect(br).toBeTruthy();
    expect(br.kind).toBe('bridge');
    expect(br.width).toBeCloseTo(10, 9);
    expect(br.zBottom).toBeCloseTo(condTop, 9);
    // Closed profile = 9-pt lower arch + reversed upper arch. Lower arch
    // is the first 9 points.
    const lower = br.profile.slice(0, 9);
    expect(lower[0][1]).toBeCloseTo(condTop, 9);              // take-off
    expect(lower[8][1]).toBeCloseTo(condTop, 9);              // landing
    expect(lower[4][1]).toBeCloseTo(condTop + 3, 9);          // apex
    expect(lower[0][0]).toBeCloseTo(-15, 9);
    expect(lower[8][0]).toBeCloseTo(15, 9);
    // Upper arch sits one strap thickness above the lower.
    const upper = br.profile.slice(9);
    const maxUpper = Math.max(...upper.map(p => p[1]));
    expect(maxUpper).toBeCloseTo(condTop + 3 + layerZ.l_cond.thickness, 9);
  });

  it('zero-thickness strap → thin sheet + warning', () => {
    const scene = sceneWith([
      { id: 'br2', kind: 'bridge', layer: 'bridge', cx: 0, cy: 0, length: '30', width: '10', height: '3', thickness: '0' },
    ]);
    const { solids, warnings } = buildScene3D(scene, pvOf(scene));
    const br = solids.find(s => s.compId === 'br2');
    expect(br).toBeTruthy();
    const zs = br.profile.map(p => p[1]);
    // Upper arch only 0.05 above lower.
    expect(Math.max(...zs)).toBeCloseTo(computeNumericLayerZ(scene.stack, pvOf(scene)).l_cond.zTop + 3 + 0.05, 9);
    expect(warnings.some(w => /br2.*sheet/i.test(w))).toBe(true);
  });
});

describe('buildScene3D — punch boolean', () => {
  // Mirrors the app's punch construction: blank electrode consumed by the
  // boolean; tool CLONES (cloneOf, consumedBy) as operands; the ORIGINAL
  // tool stays a standalone component.
  const scene = sceneWith([
    { id: 'e1', kind: 'rect', layer: 'electrode', cx: 0, cy: 0, w: '100', h: '40', conductorLayerId: 'l_cond', consumedBy: 'b1' },
    { id: 'p1', kind: 'rect', layer: 'port', cx: 10, cy: 0, w: '4', h: '6', conductorLayerId: 'l_cond' },
    { id: 'p1c', kind: 'rect', layer: 'electrode', cx: 10, cy: 0, w: '4', h: '6', conductorLayerId: 'l_cond', consumedBy: 'b1', cloneOf: 'p1' },
    { id: 'b1', kind: 'boolean', op: 'punch', operandIds: ['e1', 'p1c'], layer: 'electrode', cx: 0, cy: 0, w: '0', h: '0' },
  ]);
  const { solids } = buildScene3D(scene, pvOf(scene));

  it('blank solid carries csg.subtractIds pointing at the clone-tool solids', () => {
    const blank = solids.find(s => s.compId === 'e1');
    expect(blank).toBeTruthy();
    expect(blank.csg).toBeTruthy();
    expect(blank.csg.subtractIds.length).toBeGreaterThan(0);
    for (const tid of blank.csg.subtractIds) {
      const tool = solids.find(s => s.id === tid);
      expect(tool.compId).toBe('p1c');
      expect(tool.role).toBe('tool');
    }
  });

  it('the clone tool is never a standalone visible solid', () => {
    expect(solids.filter(s => s.compId === 'p1c').every(s => s.role === 'tool')).toBe(true);
  });

  it('the ORIGINAL port tool still renders standalone', () => {
    const orig = solids.find(s => s.compId === 'p1');
    expect(orig).toBeTruthy();
    expect(orig.role).not.toBe('tool');
  });

  it('cluster solids carry the top-level boolean as selectId', () => {
    for (const s of solids.filter(x => x.compId === 'e1' || x.compId === 'p1c')) {
      expect(s.selectId).toBe('b1');
    }
    expect(solids.find(s => s.compId === 'p1').selectId).toBe('p1');
  });
});

describe('buildScene3D — union boolean', () => {
  it('each consumed operand emits as its own solid (visual union, no CSG)', () => {
    const scene = sceneWith([
      { id: 'a', kind: 'rect', layer: 'electrode', cx: 0, cy: 0, w: '20', h: '10', consumedBy: 'u1' },
      { id: 'b', kind: 'rect', layer: 'electrode', cx: 15, cy: 0, w: '20', h: '10', consumedBy: 'u1' },
      { id: 'u1', kind: 'boolean', op: 'union', operandIds: ['a', 'b'], layer: 'electrode', cx: 0, cy: 0, w: '0', h: '0' },
    ]);
    const { solids } = buildScene3D(scene, pvOf(scene));
    const opSolids = solids.filter(s => s.compId === 'a' || s.compId === 'b');
    expect(opSolids.length).toBe(2);
    expect(opSolids.every(s => !s.csg && s.role !== 'tool')).toBe(true);
    // No solid emitted FOR the boolean itself (its operands are its body).
    expect(solids.some(s => s.compId === 'u1')).toBe(false);
  });
});

describe('buildScene3D — zero-thickness conductor', () => {
  it('epsilon height + visibility warning', () => {
    const base = makeDefaultScene();
    const scene = normalizeScene({
      ...base,
      params: { ...base.params, h_cond: { ...base.params.h_cond, expr: '0' } },
    });
    const pv = pvOf(scene);
    const { solids, warnings } = buildScene3D(scene, pv);
    const e = solids.find(s => s.compId === 'cond1');
    expect(e).toBeTruthy();
    expect(e.height).toBeCloseTo(0.02, 9);
    expect(warnings.some(w => /nominal thickness for visibility/.test(w))).toBe(true);
  });
});

describe('buildScene3D — cutouts', () => {
  it('fully-inside cutout becomes a Shape hole', () => {
    const scene = sceneWith([
      { id: 'e1', kind: 'rect', layer: 'electrode', cx: 0, cy: 0, w: '100', h: '40', cutouts: [{ w: '10', h: '10', dx: '0', dy: '0' }] },
    ]);
    const { solids } = buildScene3D(scene, pvOf(scene));
    const e = solids.find(s => s.compId === 'e1' && s.role !== 'tool');
    expect(e.holes.length).toBe(1);
    expect(e.csg).toBeFalsy();
  });

  it('cutout poking outside the footprint falls back to CSG subtract', () => {
    const scene = sceneWith([
      { id: 'e2', kind: 'rect', layer: 'electrode', cx: 0, cy: 0, w: '100', h: '40', cutouts: [{ w: '10', h: '10', dx: '48', dy: '0' }] },
    ]);
    const { solids } = buildScene3D(scene, pvOf(scene));
    const e = solids.find(s => s.compId === 'e2' && s.role !== 'tool');
    expect(e.holes.length).toBe(0);
    expect(e.csg).toBeTruthy();
    expect(e.csg.subtractIds.length).toBe(1);
    const tool = solids.find(s => s.id === e.csg.subtractIds[0]);
    expect(tool.role).toBe('tool');
  });
});

describe('buildScene3D — repeat transforms', () => {
  it('a repeat chain emits one solid per instance', () => {
    const scene = sceneWith([
      {
        id: 'r1', kind: 'rect', layer: 'electrode', cx: 0, cy: 0, w: '10', h: '5',
        transforms: [{ id: 't1', kind: 'repeat', enabled: true, n: '3', dx: '20', dy: '0', includeOriginal: true }],
      },
    ]);
    const { solids } = buildScene3D(scene, pvOf(scene));
    const rs = solids.filter(s => s.compId === 'r1');
    expect(rs.length).toBe(4);
    const cxs = rs.map(s => (Math.min(...s.ring.map(p => p[0])) + Math.max(...s.ring.map(p => p[0]))) / 2).sort((a, b) => a - b);
    expect(cxs.map(v => Math.round(v))).toEqual([0, 20, 40, 60]);
  });
});

describe('buildScene3D — racetrack', () => {
  it('band ring extruded at the wg layer with an inner hole', () => {
    const scene = sceneWith([
      { id: 'rt1', kind: 'racetrack', layer: 'waveguide', cx: 0, cy: 0, R: '50', L_straight: '100', p: '0', wgWidth: '2' },
    ]);
    const pv = pvOf(scene);
    const layerZ = computeNumericLayerZ(scene.stack, pv);
    const { solids } = buildScene3D(scene, pv);
    const rt = solids.find(s => s.compId === 'rt1');
    expect(rt).toBeTruthy();
    expect(rt.kind).toBe('extrude');
    expect(rt.holes.length).toBe(1);
    expect(rt.zBottom).toBeCloseTo(layerZ.l_lt.zBottom, 9);
    expect(rt.height).toBeCloseTo(layerZ.l_lt.thickness, 9);
    expect(rt.layerKey).toBe('wg');
  });
});
