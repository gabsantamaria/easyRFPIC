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

  it('rotate-C after a repeat rotates the WHOLE cluster about its centroid', () => {
    // Two-cell line along +y: cells at (0,0) and (0,20). Centroid = (0,10).
    // A pivot='C' rotation of 90° should swap each cell's offset from
    // (0,10) — so cell0 ends at (10,10) and cell1 ends at (-10,10).
    const insts = expandTransforms([
      baseRect({
        cx: 0, cy: 0,
        transforms: [
          { kind: 'repeat', enabled: true, n: '1', dx: '0', dy: '20', includeOriginal: true },
          { kind: 'rotate', enabled: true, angle: '90', pivot: 'C' },
        ],
      }),
    ], {});
    expect(insts).toHaveLength(2);
    expect(insts[0].cx).toBeCloseTo(10, 6);
    expect(insts[0].cy).toBeCloseTo(10, 6);
    expect(insts[1].cx).toBeCloseTo(-10, 6);
    expect(insts[1].cy).toBeCloseTo(10, 6);
    for (const i of insts) expect(i.rotation).toBe(90);
  });

  it('rotate-C with a single-instance stream is unchanged (no cluster math)', () => {
    // Sanity check: the new "cluster" branch must not affect the
    // single-shape case where pivot='C' is just "rotate in place".
    const insts = expandTransforms([
      baseRect({
        cx: 5, cy: 7,
        transforms: [{ kind: 'rotate', enabled: true, angle: '30', pivot: 'C' }],
      }),
    ], {});
    expect(insts).toHaveLength(1);
    expect(insts[0].cx).toBe(5);
    expect(insts[0].cy).toBe(7);
    expect(insts[0].rotation).toBe(30);
  });

  it('rotate with pivot=group rotates each member about the shared group centroid', () => {
    // Three rects in a group at (0,0), (10,0), (20,0). Centroid = (10,0).
    // Each has the SAME rotate transform with pivot='group'. Expected:
    // all three rotate 90° about (10,0): (0,0)→(10,-10), (10,0)→(10,0),
    // (20,0)→(10,10).
    const mk = (id, cx) => ({
      id, kind: 'rect', layer: 'electrode',
      cx, cy: 0, w: '4', h: '4',
      cutouts: [], group: 'gA',
      transforms: [{ kind: 'rotate', enabled: true, angle: '90', pivot: 'group' }],
    });
    const components = [mk('a', 0), mk('b', 10), mk('c', 20)];
    const insts = expandTransforms(components, {});
    expect(insts).toHaveLength(3);
    const byCompId = Object.fromEntries(insts.map(i => [i.compId, i]));
    expect(byCompId.a.cx).toBeCloseTo(10, 6);
    expect(byCompId.a.cy).toBeCloseTo(-10, 6);
    expect(byCompId.b.cx).toBeCloseTo(10, 6);
    expect(byCompId.b.cy).toBeCloseTo(0, 6);
    expect(byCompId.c.cx).toBeCloseTo(10, 6);
    expect(byCompId.c.cy).toBeCloseTo(10, 6);
    for (const i of insts) expect(i.rotation).toBe(90);
  });

  it('mirror about own center keeps cx/cy, flips scaleX/scaleY, negates rotation', () => {
    const insts = expandTransforms([
      baseRect({
        cx: 5, cy: 7,
        transforms: [
          { kind: 'rotate', enabled: true, angle: '30', pivot: 'C' },
          { kind: 'mirror', enabled: true, axis: 'x', pivot: 'C' },
        ],
      }),
    ], {});
    expect(insts).toHaveLength(1);
    expect(insts[0].cx).toBe(5);
    expect(insts[0].cy).toBe(7);
    expect(insts[0].scaleX).toBe(-1);
    expect(insts[0].scaleY).toBe(1);
    expect(insts[0].rotation).toBe(-30);
  });

  it('mirror about origin negates the relevant coordinate', () => {
    const insts = expandTransforms([
      baseRect({
        cx: 5, cy: 7,
        transforms: [{ kind: 'mirror', enabled: true, axis: 'y', pivot: 'origin' }],
      }),
    ], {});
    expect(insts[0].cx).toBe(5);
    expect(insts[0].cy).toBe(-7);
    expect(insts[0].scaleY).toBe(-1);
  });

  it('duplicate_mirror emits one mirrored copy at 2·offset', () => {
    const insts = expandTransforms([
      baseRect({
        cx: 10, cy: 0,
        transforms: [{ kind: 'duplicate_mirror', enabled: true, axis: 'x', offset: '25', includeOriginal: true }],
      }),
    ], {});
    expect(insts).toHaveLength(2);
    expect(insts[0].cx).toBe(10);
    expect(insts[0].scaleX).toBe(1);
    expect(insts[1].cx).toBe(60); // 10 + 2*25
    expect(insts[1].scaleX).toBe(-1);
    expect(insts[1].cy).toBe(0);
  });

  it('duplicate_mirror with includeOriginal=false drops the source', () => {
    const insts = expandTransforms([
      baseRect({
        cx: 0, cy: 0,
        transforms: [{ kind: 'duplicate_mirror', enabled: true, axis: 'y', offset: '15', includeOriginal: false }],
      }),
    ], {});
    expect(insts).toHaveLength(1);
    expect(insts[0].cx).toBe(0);
    expect(insts[0].cy).toBe(30);
    expect(insts[0].scaleY).toBe(-1);
  });

  it('rotate with pivot=group on an ungrouped component falls back to pivot=C', () => {
    // No `group` field set ⇒ the 'group' pivot can't find members and
    // degrades to plain rotate-in-place semantics.
    const insts = expandTransforms([
      baseRect({
        cx: 5, cy: 7,
        transforms: [{ kind: 'rotate', enabled: true, angle: '45', pivot: 'group' }],
      }),
    ], {});
    expect(insts).toHaveLength(1);
    expect(insts[0].cx).toBe(5);
    expect(insts[0].cy).toBe(7);
    expect(insts[0].rotation).toBe(45);
  });
});
