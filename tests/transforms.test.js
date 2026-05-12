import { describe, it, expect } from 'vitest';
import { expandTransforms } from '../src/scene/transforms.js';

const baseRect = (overrides = {}) => ({
  id: 'r', kind: 'rect', layer: 'electrode',
  cx: 0, cy: 0, w: '10', h: '6',
  cutouts: [], transforms: [],
  ...overrides,
});

describe('expandTransforms', () => {
  it('no transforms → one instance', () => {
    const insts = expandTransforms([baseRect()], {});
    expect(insts).toHaveLength(1);
    expect(insts[0]).toMatchObject({ compId: 'r', idx: 0, cx: 0, cy: 0, w: 10, h: 6, rotation: 0 });
  });

  it('displace shifts cx/cy', () => {
    const insts = expandTransforms([
      baseRect({ transforms: [{ kind: 'displace', enabled: true, dx: '5', dy: '-3' }] }),
    ], {});
    expect(insts).toHaveLength(1);
    expect(insts[0]).toMatchObject({ cx: 5, cy: -3 });
  });

  it('rotate with pivot=C only updates rotation', () => {
    const insts = expandTransforms([
      baseRect({ transforms: [{ kind: 'rotate', enabled: true, angle: '45', pivot: 'C' }] }),
    ], {});
    expect(insts[0].rotation).toBe(45);
    expect(insts[0].cx).toBe(0);
    expect(insts[0].cy).toBe(0);
  });

  it('rotate with pivot=origin moves cx/cy too', () => {
    const insts = expandTransforms([
      baseRect({ cx: 10, cy: 0, transforms: [{ kind: 'rotate', enabled: true, angle: '90', pivot: 'origin' }] }),
    ], {});
    expect(insts[0].cx).toBeCloseTo(0, 6);
    expect(insts[0].cy).toBeCloseTo(10, 6);
    expect(insts[0].rotation).toBe(90);
  });

  it('repeat n=3 includeOriginal yields 4 instances along the offset vector', () => {
    const insts = expandTransforms([
      baseRect({ transforms: [{ kind: 'repeat', enabled: true, n: '3', dx: '20', dy: '0', includeOriginal: true }] }),
    ], {});
    expect(insts).toHaveLength(4);
    expect(insts.map(i => i.cx)).toEqual([0, 20, 40, 60]);
  });

  it('repeat n=2 includeOriginal=false yields just the 2 copies, no base', () => {
    const insts = expandTransforms([
      baseRect({ transforms: [{ kind: 'repeat', enabled: true, n: '2', dx: '10', dy: '0', includeOriginal: false }] }),
    ], {});
    expect(insts).toHaveLength(2);
    // The two copies are at offsets dx, 2*dx — base (cx=0) is dropped.
    expect(insts.map((i) => i.cx).sort((a, b) => a - b)).toEqual([10, 20]);
  });

  it('disabled transform is a no-op', () => {
    const insts = expandTransforms([
      baseRect({ transforms: [{ kind: 'displace', enabled: false, dx: '99', dy: '99' }] }),
    ], {});
    expect(insts[0].cx).toBe(0);
    expect(insts[0].cy).toBe(0);
  });

  it('chains: displace → rotate(C) → repeat', () => {
    const insts = expandTransforms([
      baseRect({ transforms: [
        { kind: 'displace', enabled: true, dx: '10', dy: '0' },
        { kind: 'rotate',   enabled: true, angle: '90', pivot: 'C' },
        { kind: 'repeat',   enabled: true, n: '1', dx: '0', dy: '20', includeOriginal: true },
      ] }),
    ], {});
    expect(insts).toHaveLength(2);
    for (const i of insts) {
      expect(i.cx).toBe(10);
      expect(i.rotation).toBe(90);
    }
    expect(insts.map(i => i.cy)).toEqual([0, 20]);
  });

  it('propagates shape-specific fields onto each instance', () => {
    const circle = {
      id: 'c', kind: 'circle', layer: 'electrode',
      cx: 0, cy: 0, r: '7', w: '2*r', h: '2*r',
      cutouts: [], transforms: [{ kind: 'displace', enabled: true, dx: '5', dy: '0' }],
    };
    const insts = expandTransforms([circle], { r: 7 });
    expect(insts[0].r).toBe(7);
    expect(insts[0].cx).toBe(5);
  });

  it('skips degenerate components (non-finite w/h) gracefully', () => {
    const broken = baseRect({ w: 'no_such_param', h: '5' });
    const insts = expandTransforms([broken], {});
    expect(insts).toHaveLength(1);
    expect(insts[0].w).toBe(0); // tagged as degenerate
  });
});
