// Layer visibility classification — pure helpers behind the canvas
// show/hide eyes. Visibility is CANVAS-ONLY: these helpers classify, the
// Canvas filters rendering/interaction; scene, solver, exports never see it.
import { describe, it, expect } from 'vitest';
import { layerVisKey, computeHiddenCompIds, EMPTY_HIDDEN_SET } from '../src/ui/canvas/layer-visibility.js';

const stack = [
  { id: 'l_si', role: 'substrate' },
  { id: 'l_wg', role: 'waveguide' },
  { id: 'l_cond', role: 'conductor' },
  { id: 'l_cond2', role: 'conductor' },
];
const rect = (id, extra = {}) => ({ id, kind: 'rect', layer: 'electrode', cx: 0, cy: 0, w: '1', h: '1', ...extra });
const byId = (comps) => Object.fromEntries(comps.map(c => [c.id, c]));

describe('layerVisKey', () => {
  it('classifies the four canvas layers', () => {
    const comps = [
      rect('w', { layer: 'waveguide' }),
      rect('p', { layer: 'port' }),
      { id: 'v', kind: 'via', layer: 'via', layerFrom: 'l_wg', layerTo: 'l_cond' },
      rect('e1', { conductorLayerId: 'l_cond2' }),
      rect('e0'), // unbound electrode → implicit FIRST conductor
    ];
    const m = byId(comps);
    expect(layerVisKey(m.w, m, stack)).toBe('wg');
    expect(layerVisKey(m.p, m, stack)).toBe('port');
    expect(layerVisKey(m.v, m, stack)).toBe('via');
    expect(layerVisKey(m.e1, m, stack)).toBe('cond:l_cond2');
    expect(layerVisKey(m.e0, m, stack)).toBe('cond:l_cond');
  });

  it('a STALE conductor binding falls back to the first conductor (like exports)', () => {
    const comps = [rect('e', { conductorLayerId: 'deleted_layer' })];
    const m = byId(comps);
    expect(layerVisKey(m.e, m, stack)).toBe('cond:l_cond');
  });

  it('electrodes in a conductor-less stack key as "electrode"', () => {
    const m = byId([rect('e')]);
    expect(layerVisKey(m.e, m, [{ id: 'l_wg', role: 'waveguide' }])).toBe('electrode');
  });

  it('booleans recurse to their first non-boolean operand (nested + cycle-safe)', () => {
    const comps = [
      rect('a', { consumedBy: 'inner', conductorLayerId: 'l_cond2' }),
      { id: 'inner', kind: 'boolean', op: 'union', operandIds: ['a'], layer: 'electrode', consumedBy: 'outer' },
      { id: 'outer', kind: 'boolean', op: 'union', operandIds: ['inner'], layer: 'electrode' },
      // pathological self-cycle must not hang
      { id: 'cyc', kind: 'boolean', op: 'union', operandIds: ['cyc'], layer: 'electrode' },
    ];
    const m = byId(comps);
    expect(layerVisKey(m.outer, m, stack)).toBe('cond:l_cond2');
    expect(layerVisKey(m.cyc, m, stack)).toBe(null);
  });
});

describe('computeHiddenCompIds', () => {
  const comps = [
    rect('w', { layer: 'waveguide' }),
    rect('p', { layer: 'port' }),
    rect('e1', { conductorLayerId: 'l_cond2' }),
    rect('e0'),
    rect('op', { consumedBy: 'b' }),
    { id: 'b', kind: 'boolean', op: 'union', operandIds: ['op'], layer: 'electrode' },
  ];

  it('returns the SHARED empty set when nothing is hidden (fast path)', () => {
    expect(computeHiddenCompIds(comps, new Set(), stack)).toBe(EMPTY_HIDDEN_SET);
    expect(computeHiddenCompIds(comps, null, stack)).toBe(EMPTY_HIDDEN_SET);
  });

  it('hides exactly the keyed family — boolean + its operands follow the conductor', () => {
    const hidden = computeHiddenCompIds(comps, new Set(['cond:l_cond']), stack);
    // e0 (implicit first conductor), op and b (boolean recursion → l_cond)
    expect([...hidden].sort()).toEqual(['b', 'e0', 'op']);
    const hidden2 = computeHiddenCompIds(comps, new Set(['wg', 'port']), stack);
    expect([...hidden2].sort()).toEqual(['p', 'w']);
  });
});
