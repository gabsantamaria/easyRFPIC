import { describe, it, expect } from 'vitest';
import { solveLayout, applyMirrors, resolveBooleanBboxes } from '../src/scene/solver.js';

const rect = (id, cx, cy, w, h, extra = {}) => ({
  id, kind: 'rect', layer: 'electrode',
  cx, cy, w: String(w), h: String(h),
  cutouts: [], transforms: [], label: id,
  ...extra,
});

describe('solveLayout', () => {
  it('leaves a free root at its raw cx/cy', () => {
    const out = solveLayout([rect('a', 5, 7, 10, 10)], [], {});
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: 'a', cx: 5, cy: 7 });
  });

  it('places a child via a single snap (E → W)', () => {
    const comps = [rect('a', 0, 0, 10, 10), rect('b', 999, 999, 20, 10)];
    const snaps = [{ from: { compId: 'a', anchor: 'E' }, to: { compId: 'b', anchor: 'W' }, dx: '0', dy: '0' }];
    const out = solveLayout(comps, snaps, {});
    const b = out.find(c => c.id === 'b');
    // a.E = (5, 0); b.W local = (-10, 0); b.cx = 5 - (-10) = 15.
    expect(b.cx).toBe(15);
    expect(b.cy).toBe(0);
  });

  it('propagates a chain a → b → c', () => {
    const comps = [rect('a', 0, 0, 10, 10), rect('b', 0, 0, 20, 10), rect('c', 0, 0, 15, 10)];
    const snaps = [
      { from: { compId: 'a', anchor: 'E' }, to: { compId: 'b', anchor: 'W' }, dx: '0', dy: '0' },
      { from: { compId: 'b', anchor: 'E' }, to: { compId: 'c', anchor: 'W' }, dx: '0', dy: '0' },
    ];
    const out = solveLayout(comps, snaps, {});
    const c = out.find(x => x.id === 'c');
    // a.E = 5, b.W local = -10 → b.cx = 15. b.E = 15 + 10 = 25, c.W local = -7.5 → c.cx = 32.5
    expect(c.cx).toBe(32.5);
  });

  it('honors dx/dy offsets', () => {
    const comps = [rect('a', 0, 0, 10, 10), rect('b', 0, 0, 10, 10)];
    const snaps = [{ from: { compId: 'a', anchor: 'E' }, to: { compId: 'b', anchor: 'W' }, dx: '3', dy: '-2' }];
    const out = solveLayout(comps, snaps, {});
    const b = out.find(c => c.id === 'b');
    // b.cx = 5 + 3 - (-5) = 13;  b.cy = 0 + (-2) - 0 = -2
    expect(b.cx).toBe(13);
    expect(b.cy).toBe(-2);
  });

  it('resolves a parameter-driven offset', () => {
    const comps = [rect('a', 0, 0, 10, 10), rect('b', 0, 0, 10, 10)];
    const snaps = [{ from: { compId: 'a', anchor: 'E' }, to: { compId: 'b', anchor: 'W' }, dx: 'g', dy: '0' }];
    const out = solveLayout(comps, snaps, { g: 7 });
    const b = out.find(c => c.id === 'b');
    expect(b.cx).toBe(17);
  });

  it('lays out a boolean cluster: bbox = union of operands', () => {
    const comps = [
      rect('a', 0, 0, 10, 10),
      rect('b', 15, 0, 20, 10),
      {
        id: 'u', kind: 'boolean', op: 'union', operandIds: ['a', 'b'],
        layer: 'electrode', cx: 0, cy: 0, w: '0', h: '0',
        cutouts: [], transforms: [],
      },
    ];
    const out = solveLayout(comps, [], {});
    const u = out.find(c => c.id === 'u');
    // a spans [-5, 5], b spans [5, 25]; union bbox: minX=-5, maxX=25 → cx=10, w=30
    expect(u.cx).toBe(10);
    expect(u.w).toBe(30);
    expect(u.h).toBe(10);
  });

  it('subtract restricts bbox to operand 0', () => {
    const comps = [
      rect('a', 0, 0, 10, 10),
      rect('b', 5, 0, 4, 4),
      {
        id: 'd', kind: 'boolean', op: 'subtract', operandIds: ['a', 'b'],
        layer: 'electrode', cx: 0, cy: 0, w: '0', h: '0',
        cutouts: [], transforms: [],
      },
    ];
    const out = solveLayout(comps, [], {});
    const d = out.find(c => c.id === 'd');
    expect(d.cx).toBe(0);
    expect(d.w).toBe(10); // same as operand 0
    expect(d.h).toBe(10);
  });
});

describe('applyMirrors', () => {
  it('reflects locked members across a horizontal axis', () => {
    const comps = [rect('src', 5, 10, 4, 4), rect('mir', 999, 999, 4, 4)];
    const mirrors = [{
      axis: 'horizontal',
      axisCoord: 0,
      members: [{ srcId: 'src', mirrorId: 'mir', locked: true }],
    }];
    const out = applyMirrors(comps, mirrors);
    const mir = out.find(c => c.id === 'mir');
    expect(mir.cx).toBe(5);
    expect(mir.cy).toBe(-10);
  });

  it('reflects locked members across a vertical axis', () => {
    const comps = [rect('src', 5, 10, 4, 4), rect('mir', 999, 999, 4, 4)];
    const mirrors = [{
      axis: 'vertical',
      axisCoord: 0,
      members: [{ srcId: 'src', mirrorId: 'mir', locked: true }],
    }];
    const out = applyMirrors(comps, mirrors);
    const mir = out.find(c => c.id === 'mir');
    expect(mir.cx).toBe(-5);
    expect(mir.cy).toBe(10);
  });

  it('leaves unlocked members untouched', () => {
    const comps = [rect('src', 5, 10, 4, 4), rect('mir', 7, 9, 4, 4)];
    const mirrors = [{
      axis: 'horizontal',
      axisCoord: 0,
      members: [{ srcId: 'src', mirrorId: 'mir', locked: false }],
    }];
    const out = applyMirrors(comps, mirrors);
    const mir = out.find(c => c.id === 'mir');
    expect(mir.cx).toBe(7);
    expect(mir.cy).toBe(9);
  });
});

describe('resolveBooleanBboxes', () => {
  it('refines a boolean bbox after solveLayout', () => {
    const solved = [
      rect('a', 0, 0, 10, 10),
      rect('b', 15, 0, 20, 10),
      {
        id: 'u', kind: 'boolean', op: 'union', operandIds: ['a', 'b'],
        layer: 'electrode', cx: 0, cy: 0, w: '0', h: '0',
        cutouts: [], transforms: [],
      },
    ];
    const out = resolveBooleanBboxes(solved, {});
    const u = out.find(c => c.id === 'u');
    expect(u.w).toBeGreaterThan(0);
    expect(u.h).toBeGreaterThan(0);
  });
});
