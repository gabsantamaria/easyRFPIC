// Boolean-operand conductor-binding INHERITANCE (the "meander looks 2 µm
// thick on a zero-thickness conductor" bug): template-built operands carry
// no conductorLayerId; the user binds the BOOLEAN. Every consumer must
// resolve an unbound operand through its consuming boolean before falling
// back to the first conductor-role stack layer.
import { describe, it, expect } from 'vitest';
import { effectiveConductorLayerId } from '../src/scene/conductor-binding.js';
import { buildScene3D, SHEET_EPS } from '../src/scene/scene3d.js';
import { normalizeScene, makeBlankScene } from '../src/scene/schema.js';
import { resolveParams } from '../src/scene/params.js';
import { generateHfssNative } from '../src/export/hfss-native.js';
import { layerVisKey } from '../src/ui/canvas/layer-visibility.js';

// Multi-conductor stack shaped like the user's: FIRST conductor is a thick
// "via" layer; the zero-thickness "Conductor" comes later.
function multiCondScene() {
  const s = makeBlankScene();
  s.params.h_cond = { expr: '0', unit: 'µm', desc: '' };
  s.stack = [
    ...s.stack.filter(l => l.role === 'substrate'),
    { id: 'l_via', name: 'via', thickness: '2', material: 'gold', color: '#4b1701', role: 'conductor' },
    ...s.stack.filter(l => l.role !== 'substrate'),
  ];
  s.components.push(
    { id: 'bar1', kind: 'rect', layer: 'electrode', cx: 0, cy: 5, w: '20', h: '2', consumedBy: 'u1' },
    { id: 'bar2', kind: 'rect', layer: 'electrode', cx: 0, cy: -5, w: '20', h: '2', consumedBy: 'u1' },
    {
      id: 'u1', kind: 'boolean', op: 'union', operandIds: ['bar1', 'bar2'],
      layer: 'electrode', cx: 0, cy: 0, w: '0', h: '0', conductorLayerId: 'l_cond',
    },
    { id: 'solo', kind: 'rect', layer: 'electrode', cx: 50, cy: 0, w: '10', h: '10' },
  );
  return normalizeScene(s);
}

describe('effectiveConductorLayerId', () => {
  const scene = multiCondScene();
  const byId = Object.fromEntries(scene.components.map(c => [c.id, c]));
  it('operand inherits the consuming boolean binding; own binding wins; unbound chain → null', () => {
    expect(effectiveConductorLayerId(byId.bar1, byId)).toBe('l_cond');
    expect(effectiveConductorLayerId({ ...byId.bar1, conductorLayerId: 'l_via' }, byId)).toBe('l_via');
    expect(effectiveConductorLayerId(byId.solo, byId)).toBe(null);
    expect(effectiveConductorLayerId(byId.u1, byId)).toBe('l_cond');
  });
  it('is cycle-safe', () => {
    const a = { id: 'a', consumedBy: 'b' };
    const b = { id: 'b', consumedBy: 'a' };
    expect(effectiveConductorLayerId(a, { a, b })).toBe(null);
  });
});

describe('consumers resolve inherited bindings', () => {
  const scene = multiCondScene();
  const pv = resolveParams(scene.params).values;
  const byId = Object.fromEntries(scene.components.map(c => [c.id, c]));

  it('3-D viewer: bound-union operands are THIN on l_cond; unbound solo falls to the first (thick) conductor', () => {
    const { solids } = buildScene3D(scene, pv);
    const bar = solids.find(s => s.compId === 'bar1');
    expect(bar.height).toBeCloseTo(SHEET_EPS, 9); // h_cond = 0 → nominal sheet
    expect(bar.layerKey).toBe('cond:l_cond');
    const solo = solids.find(s => s.compId === 'solo');
    expect(solo.height).toBeCloseTo(2, 9);        // first conductor = 2 µm "via"
    expect(solo.layerKey).toBe('cond:l_via');
  });

  it('HFSS native: operand emitted on the inherited layer with an explanatory comment', () => {
    const code = generateHfssNative(scene, pv);
    expect(code).toContain('Conductor layer for bar1: "l_cond" (inherited from the consuming boolean\'s binding)');
    // Unbound solo still gets the multi-conductor fallback WARNING.
    expect(code).toMatch(/WARNING: solo has no explicit conductor-layer binding/);
  });

  it('layerVisKey: operand groups under the inherited conductor eye', () => {
    expect(layerVisKey(byId.bar1, byId, scene.stack)).toBe('cond:l_cond');
    expect(layerVisKey(byId.solo, byId, scene.stack)).toBe('cond:l_via'); // first-conductor fallback
  });
});

describe('resolution-order consistency (review findings)', () => {
  it('own-bound operand under a differently-bound boolean: OPERAND wins in every consumer', () => {
    const s = makeBlankScene();
    s.params.h_cond = { expr: '0', unit: 'µm', desc: '' };
    s.stack = [
      ...s.stack.filter(l => l.role === 'substrate'),
      { id: 'l_via', name: 'via', thickness: '2', material: 'gold', color: '#4b1701', role: 'conductor' },
      ...s.stack.filter(l => l.role !== 'substrate'),
    ];
    s.components.push(
      { id: 'own1', kind: 'rect', layer: 'electrode', cx: 0, cy: 5, w: '20', h: '2', consumedBy: 'u1', conductorLayerId: 'l_via' },
      { id: 'free1', kind: 'rect', layer: 'electrode', cx: 0, cy: -5, w: '20', h: '2', consumedBy: 'u1' },
      {
        id: 'u1', kind: 'boolean', op: 'union', operandIds: ['own1', 'free1'],
        layer: 'electrode', cx: 0, cy: 0, w: '0', h: '0', conductorLayerId: 'l_cond',
      },
    );
    const scene = normalizeScene(s);
    const byId = Object.fromEntries(scene.components.map(c => [c.id, c]));
    // Helper: operand's own binding beats the boolean's.
    expect(effectiveConductorLayerId(byId.own1, byId)).toBe('l_via');
    expect(effectiveConductorLayerId(byId.free1, byId)).toBe('l_cond');
    const pv = resolveParams(scene.params).values;
    // 3-D + eyes agree per-operand.
    const { solids } = buildScene3D(scene, pv);
    expect(solids.find(x => x.compId === 'own1').layerKey).toBe('cond:l_via');
    expect(solids.find(x => x.compId === 'free1').layerKey).toBe('cond:l_cond');
    expect(layerVisKey(byId.own1, byId, scene.stack)).toBe('cond:l_via');
    // HFSS: per-operand comments match.
    const code = generateHfssNative(scene, pv);
    expect(code).toContain('Conductor layer for own1: "l_via" (explicit binding)');
    expect(code).toContain('Conductor layer for free1: "l_cond" (inherited from the consuming boolean\'s binding)');
    // Audit: free1 listed as INHERITED (not ambiguous), own1 not flagged.
    expect(code).toMatch(/bound via their consuming boolean[\s\S]{0,120}free1 -> "l_cond"/);
    expect(code).not.toMatch(/NO explicit conductor-layer binding[\s\S]{0,200}own1/);
  });
});
