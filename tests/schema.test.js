import { describe, it, expect } from 'vitest';
import {
  defaultStack,
  normalizeScene,
  makeDefaultScene,
  makeBlankScene,
} from '../src/scene/schema.js';

describe('defaultStack', () => {
  it('returns a non-empty stack with stable roles', () => {
    const s = defaultStack();
    expect(Array.isArray(s)).toBe(true);
    expect(s.length).toBeGreaterThan(0);
    const roles = s.map((l) => l.role);
    for (const r of ['substrate', 'waveguide', 'cladding', 'conductor']) {
      expect(roles).toContain(r);
    }
  });
});

describe('makeBlankScene / makeDefaultScene', () => {
  it('makeBlankScene has the canonical shape and empty arrays', () => {
    const s = makeBlankScene();
    expect(s.params).toBeTypeOf('object');
    expect(s.components).toEqual([]);
    expect(s.snaps).toEqual([]);
    expect(s.groups).toEqual([]);
    expect(s.mirrors).toEqual([]);
    expect(Array.isArray(s.stack)).toBe(true);
  });
  it('makeBlankScene pre-populates params for every identifier the default stack references', () => {
    const s = makeBlankScene();
    // Every name appearing in a stack field must have a corresponding
    // entry in params with a finite expr.
    for (const layer of s.stack) {
      for (const f of ['thickness', 'core_width', 'slab_height', 'slab_width', 'etch_angle']) {
        const v = layer[f];
        if (typeof v !== 'string') continue;
        const idents = v.match(/[A-Za-z_][A-Za-z0-9_]*/g) || [];
        for (const id of idents) {
          expect(s.params[id], `missing param "${id}" referenced by ${layer.id}.${f}`).toBeDefined();
          expect(s.params[id].expr).toBeTypeOf('string');
        }
      }
    }
  });
  it('makeDefaultScene has non-empty content', () => {
    const s = makeDefaultScene();
    expect(Object.keys(s.params).length).toBeGreaterThan(0);
    expect(s.components.length).toBeGreaterThan(0);
  });
});

describe('normalizeScene', () => {
  it('returns the default scene for non-object input', () => {
    expect(normalizeScene(null).components.length).toBeGreaterThan(0);
    expect(normalizeScene(undefined).components.length).toBeGreaterThan(0);
  });
  it('preserves params / components on an already-shaped input', () => {
    const blank = makeBlankScene();
    const out = normalizeScene(blank);
    expect(out.components).toEqual(blank.components);
    expect(out.snaps).toEqual(blank.snaps);
  });
  it('fills in missing top-level arrays', () => {
    const partial = { params: {}, components: [{ id: 'x', cx: 0, cy: 0, w: '1', h: '1' }] };
    const out = normalizeScene(partial);
    expect(Array.isArray(out.snaps)).toBe(true);
    expect(Array.isArray(out.groups)).toBe(true);
    expect(Array.isArray(out.mirrors)).toBe(true);
    expect(Array.isArray(out.stack)).toBe(true);
  });
});
