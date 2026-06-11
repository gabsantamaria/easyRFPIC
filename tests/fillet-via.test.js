// D3 (rect corner fillets) + D4 (via component) coverage.
//
// Geometry layer: rounded-rect ring corner counts / bbox / clamping,
// via → circle ring mapping, transforms carrying cornerRadius / via r.
// Schema: via field normalization + cornerRadius string coercion.
// Walkers: rename-ident + tokenizeComponentExprs cover cornerRadius and
// the via's r expression.
// Export-level assertions (HFSS AngularArc emission, via cylinder Z
// expressions, AST checks) live in exports.test.js.
import { describe, it, expect } from 'vitest';
import { rectInstanceToRing, shapeInstanceToRing, clampCornerRadius } from '../src/geometry/rings.js';
import { expandTransforms } from '../src/scene/transforms.js';
import { normalizeScene } from '../src/scene/schema.js';
import { renameIdentInScene } from '../src/scene/rename-ident.js';
import { tokenizeComponentExprs } from '../src/scene/params.js';
import { solveLayout } from '../src/scene/solver.js';

// ── clampCornerRadius ───────────────────────────────────────────────────

describe('clampCornerRadius', () => {
  it('passes a small radius through', () => {
    expect(clampCornerRadius(2, 20, 10)).toBe(2);
  });
  it('clamps to min(w,h)/2', () => {
    expect(clampCornerRadius(50, 20, 10)).toBe(5);
    expect(clampCornerRadius(50, 10, 20)).toBe(5);
  });
  it('returns 0 for non-positive / non-finite input', () => {
    expect(clampCornerRadius(0, 20, 10)).toBe(0);
    expect(clampCornerRadius(-3, 20, 10)).toBe(0);
    expect(clampCornerRadius(NaN, 20, 10)).toBe(0);
    expect(clampCornerRadius(undefined, 20, 10)).toBe(0);
  });
});

// ── Rounded-rect ring ───────────────────────────────────────────────────

describe('rectInstanceToRing with cornerRadius', () => {
  it('sharp rect still returns 4 corners', () => {
    const ring = rectInstanceToRing({ cx: 0, cy: 0, w: 20, h: 10 });
    expect(ring).toHaveLength(4);
  });
  it('rounded rect returns 4 corner arcs x 9 points = 36 vertices', () => {
    const ring = rectInstanceToRing({ cx: 0, cy: 0, w: 20, h: 10, cornerRadius: 2 });
    // 4 arcs, each FILLET_SEGS(8) segments → 9 points per corner.
    expect(ring).toHaveLength(36);
  });
  it('rounded ring bbox equals the rect bbox (fillets stay inside)', () => {
    const ring = rectInstanceToRing({ cx: 5, cy: -3, w: 20, h: 10, cornerRadius: 3 });
    const xs = ring.map(p => p[0]);
    const ys = ring.map(p => p[1]);
    expect(Math.min(...xs)).toBeCloseTo(5 - 10, 9);
    expect(Math.max(...xs)).toBeCloseTo(5 + 10, 9);
    expect(Math.min(...ys)).toBeCloseTo(-3 - 5, 9);
    expect(Math.max(...ys)).toBeCloseTo(-3 + 5, 9);
  });
  it('no ring point sticks out past the sharp corner (rounding is a subset)', () => {
    const ring = rectInstanceToRing({ cx: 0, cy: 0, w: 20, h: 10, cornerRadius: 3 });
    for (const [x, y] of ring) {
      expect(Math.abs(x)).toBeLessThanOrEqual(10 + 1e-9);
      expect(Math.abs(y)).toBeLessThanOrEqual(5 + 1e-9);
      // Inside the NE corner square, the point must lie on/inside the
      // fillet circle of radius 3 centered at (7, 2).
      if (x > 7 && y > 2) {
        expect(Math.hypot(x - 7, y - 2)).toBeLessThanOrEqual(3 + 1e-9);
      }
    }
  });
  it('radius is clamped to min(w,h)/2 (oversized r → stadium shape, bbox intact)', () => {
    const ring = rectInstanceToRing({ cx: 0, cy: 0, w: 20, h: 10, cornerRadius: 99 });
    expect(ring).toHaveLength(36);
    const xs = ring.map(p => p[0]);
    const ys = ring.map(p => p[1]);
    expect(Math.max(...xs)).toBeCloseTo(10, 9);
    expect(Math.max(...ys)).toBeCloseTo(5, 9);
  });
  it('rotation applies to the rounded ring', () => {
    const ring = rectInstanceToRing({ cx: 0, cy: 0, w: 20, h: 10, cornerRadius: 2, rotation: 90 });
    const xs = ring.map(p => p[0]);
    const ys = ring.map(p => p[1]);
    // After 90° rotation the bbox swaps: |x| ≤ 5, |y| ≤ 10.
    expect(Math.max(...xs)).toBeCloseTo(5, 6);
    expect(Math.max(...ys)).toBeCloseTo(10, 6);
  });
  it('shapeInstanceToRing routes rect instances through the rounded ring', () => {
    const ring = shapeInstanceToRing({ kind: 'rect', cx: 0, cy: 0, w: 20, h: 10, cornerRadius: 2 });
    expect(ring).toHaveLength(36);
  });
});

// ── expandTransforms carries the fillet + via fields ────────────────────

describe('expandTransforms shape fields', () => {
  it('evaluates cornerRadius onto rect instances', () => {
    const comps = [{
      id: 'r1', kind: 'rect', layer: 'electrode', cx: 0, cy: 0,
      w: '20', h: '10', cornerRadius: 'fil_r', cutouts: [], transforms: [],
    }];
    const [inst] = expandTransforms(comps, { fil_r: 2.5 });
    expect(inst.cornerRadius).toBeCloseTo(2.5, 9);
  });
  it('omits cornerRadius when absent or zero', () => {
    const comps = [{
      id: 'r1', kind: 'rect', layer: 'electrode', cx: 0, cy: 0,
      w: '20', h: '10', cutouts: [], transforms: [],
    }];
    const [inst] = expandTransforms(comps, {});
    expect(inst.cornerRadius).toBeUndefined();
  });
  it('propagates cornerRadius onto repeat clones', () => {
    const comps = [{
      id: 'r1', kind: 'rect', layer: 'electrode', cx: 0, cy: 0,
      w: '20', h: '10', cornerRadius: '2', cutouts: [],
      transforms: [{ id: 't1', kind: 'repeat', enabled: true, n: '2', dx: '30', dy: '0' }],
    }];
    const insts = expandTransforms(comps, {});
    expect(insts).toHaveLength(3);
    for (const inst of insts) expect(inst.cornerRadius).toBeCloseTo(2, 9);
  });
  it('evaluates via radius like a circle', () => {
    const comps = [{
      id: 'v1', kind: 'via', layer: 'via', cx: 3, cy: 4,
      r: 'via_r', w: '2*via_r', h: '2*via_r',
      layerFrom: 'l_lt', layerTo: 'l_cond', cutouts: [], transforms: [],
    }];
    const [inst] = expandTransforms(comps, { via_r: 2 });
    expect(inst.kind).toBe('via');
    expect(inst.r).toBeCloseTo(2, 9);
    expect(inst.w).toBeCloseTo(4, 9);
  });
});

// ── Via ring = circle tessellation ──────────────────────────────────────

describe('via ring', () => {
  it('via maps to the 64-vertex circle ring', () => {
    const ring = shapeInstanceToRing({ kind: 'via', cx: 10, cy: -5, r: 2 });
    expect(ring).toHaveLength(64);
    for (const [x, y] of ring) {
      expect(Math.hypot(x - 10, y + 5)).toBeCloseTo(2, 9);
    }
  });
});

// ── Via in the solver (uniform AABB convention) ─────────────────────────

describe('via in solveLayout', () => {
  it('snap onto a via anchor resolves through the 2*r bbox', () => {
    const comps = [
      { id: 'v1', kind: 'via', layer: 'via', cx: 0, cy: 0, r: 'via_r', w: '2*via_r', h: '2*via_r', cutouts: [], transforms: [] },
      { id: 'r1', kind: 'rect', layer: 'electrode', cx: 50, cy: 50, w: '10', h: '10', cutouts: [], transforms: [] },
    ];
    const snaps = [{
      id: 's1',
      from: { compId: 'v1', anchor: 'E' },
      to: { compId: 'r1', anchor: 'W' },
      dx: '0', dy: '0',
    }];
    const solved = solveLayout(comps, snaps, { via_r: 3 });
    const r1 = solved.find(c => c.id === 'r1');
    // via E anchor at x = +3; rect W edge lands there → cx = 3 + 5.
    expect(r1.cx).toBeCloseTo(8, 6);
    expect(r1.cy).toBeCloseTo(0, 6);
  });
});

// ── Schema normalization ────────────────────────────────────────────────

describe('normalizeScene D3/D4 fields', () => {
  it('coerces numeric cornerRadius to a string', () => {
    const s = normalizeScene({
      params: {},
      components: [{ id: 'r1', kind: 'rect', layer: 'electrode', cx: 0, cy: 0, w: '10', h: '10', cornerRadius: 2 }],
      snaps: [],
    });
    const r1 = s.components.find(c => c.id === 'r1');
    expect(r1.cornerRadius).toBe('2');
  });
  it('fills via defaults: r, layer, layerFrom/layerTo, derived w/h', () => {
    const s = normalizeScene({
      params: {},
      components: [{ id: 'v1', kind: 'via', cx: 0, cy: 0 }],
      snaps: [],
    });
    const v1 = s.components.find(c => c.id === 'v1');
    expect(v1.r).toBe('2');
    expect(v1.layer).toBe('via');
    // Default stack: waveguide l_lt → top conductor l_cond.
    expect(v1.layerFrom).toBe('l_lt');
    expect(v1.layerTo).toBe('l_cond');
    expect(v1.layerFrom).not.toBe(v1.layerTo);
    expect(v1.w).toBe('2*(2)');
    expect(v1.h).toBe('2*(2)');
  });
  it('repairs a via whose layerTo equals layerFrom', () => {
    const s = normalizeScene({
      params: {},
      components: [{ id: 'v1', kind: 'via', cx: 0, cy: 0, r: '2', layerFrom: 'l_cond', layerTo: 'l_cond' }],
      snaps: [],
    });
    const v1 = s.components.find(c => c.id === 'v1');
    expect(v1.layerTo).not.toBe(v1.layerFrom);
  });
  it('strips zOffset / rotation / cornerRadius from vias', () => {
    // A via's Z span is fully determined by layerFrom/layerTo (a zOffset
    // would break the span semantics), rotation is a geometric no-op on
    // a circle, and cornerRadius is rect-only. The Inspector never
    // offers these on vias; normalizeScene guards hand-edited JSON.
    const s = normalizeScene({
      params: {},
      components: [{ id: 'v1', kind: 'via', cx: 0, cy: 0, r: '2', zOffset: '3', rotation: '45', cornerRadius: '1' }],
      snaps: [],
    });
    const v1 = s.components.find(c => c.id === 'v1');
    expect(v1.zOffset).toBeUndefined();
    expect(v1.rotation).toBeUndefined();
    expect(v1.cornerRadius).toBeUndefined();
  });
});

// ── Rename + tokenize walkers ───────────────────────────────────────────

describe('rename / tokenize coverage', () => {
  it('renameIdentInScene rewrites cornerRadius expressions', () => {
    const scene = {
      params: { fil_r: { expr: '2', unit: 'µm' } },
      components: [{ id: 'r1', kind: 'rect', layer: 'electrode', cx: 0, cy: 0, w: '10', h: '10', cornerRadius: 'fil_r + 0.5', cutouts: [], transforms: [] }],
      snaps: [], stack: [],
    };
    const out = renameIdentInScene(scene, 'fil_r', 'fillet');
    expect(out.components[0].cornerRadius).toBe('fillet + 0.5');
  });
  it('renameIdentInScene rewrites a via\'s r expression', () => {
    const scene = {
      params: { via_r: { expr: '2', unit: 'µm' } },
      components: [{ id: 'v1', kind: 'via', layer: 'via', cx: 0, cy: 0, r: 'via_r', w: '2*via_r', h: '2*via_r', layerFrom: 'a', layerTo: 'b', cutouts: [], transforms: [] }],
      snaps: [], stack: [],
    };
    const out = renameIdentInScene(scene, 'via_r', 'plug_r');
    expect(out.components[0].r).toBe('plug_r');
    expect(out.components[0].w).toBe('2*plug_r');
  });
  it('tokenizeComponentExprs sees cornerRadius identifiers', () => {
    const idents = tokenizeComponentExprs({
      id: 'r1', kind: 'rect', w: '10', h: '10', cornerRadius: 'fil_r',
    });
    expect(idents).toContain('fil_r');
  });
  it('tokenizeComponentExprs sees a via\'s r identifier', () => {
    const idents = tokenizeComponentExprs({
      id: 'v1', kind: 'via', w: '2*via_r', h: '2*via_r', r: 'via_r',
    });
    expect(idents).toContain('via_r');
  });
});
