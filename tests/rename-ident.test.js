import { describe, it, expect } from 'vitest';
import { renameIdentInScene } from '../src/scene/rename-ident.js';

// Synthetic scene that embeds the param `foo` in EVERY expression-field
// class renameIdentInScene must cover, plus the word-boundary traps
// `food` and `my_foo` which must survive a foo→bar rename untouched.
function makeScene() {
  return {
    params: {
      foo:  { expr: '10', unit: 'µm', desc: 'the param under rename' },
      food: { expr: 'foo + food', unit: 'µm', desc: 'word-boundary trap' },
      dep:  { expr: '2*foo - food', unit: 'µm', desc: 'references both' },
    },
    components: [
      {
        id: 'r1', kind: 'rect', layer: 'electrode',
        cx: 0, cy: 0, w: 'foo + 1', h: '2*foo',
        cutouts: [{ dx: 'foo/2', dy: '-foo', w: 'foo', h: 'foo + food' }],
        transforms: [
          { id: 't1', kind: 'displace', enabled: true, dx: 'foo', dy: 'foo*2' },
          { id: 't2', kind: 'rotate', enabled: true, angle: 'foo + 45', pivot: 'C' },
          { id: 't3', kind: 'repeat', enabled: true, n: 'foo', dx: '3*foo', dy: '0', includeOriginal: true },
          { id: 't4', kind: 'duplicate_mirror', enabled: true, offset: '-foo/2' },
        ],
      },
      {
        id: 'c1', kind: 'circle', layer: 'waveguide',
        cx: 5, cy: 5, r: 'foo', w: '2*foo', h: '2*foo',
        cutouts: [], transforms: [],
      },
      {
        id: 'e1', kind: 'ellipse', layer: 'waveguide',
        cx: 0, cy: 0, rx: 'foo', ry: 'foo/2', w: '2*foo', h: 'foo',
        cutouts: [], transforms: [],
      },
      {
        id: 'p1', kind: 'polygon', layer: 'electrode',
        cx: 0, cy: 0, r: 'foo+1', n: 'foo', w: '2*(foo+1)', h: '2*(foo+1)',
        cutouts: [], transforms: [],
      },
      {
        id: 'rt1', kind: 'racetrack', layer: 'waveguide',
        cx: 0, cy: 0, R: 'foo', L_straight: '4*foo', p: 'foo/10', wgWidth: 'foo/5',
        w: '4*foo + 2*foo', h: '2*foo', cutouts: [], transforms: [],
      },
      {
        id: 'pl1', kind: 'polyline', layer: 'electrode',
        cx: 0, cy: 0, width: 'foo/3', w: '0', h: '0',
        vertices: [
          { kind: 'rel', dx: '0', dy: '0' },
          { kind: 'rel', dx: 'foo', dy: '-foo' },
          { kind: 'snap', compId: 'r1', anchor: 'NE' }, // no exprs — must pass through
        ],
        closed: false, cutouts: [], transforms: [],
      },
      {
        id: 'ps1', kind: 'polyshape', layer: 'electrode',
        cx: 0, cy: 0, w: '0', h: '0',
        vertices: [
          { kind: 'rel', dx: '0', dy: '0' },
          { kind: 'rel', dx: 'foo*2', dy: 'food' }, // trap inside a vertex
        ],
        closed: true, cutouts: [], transforms: [],
      },
    ],
    snaps: [
      {
        from: { compId: 'r1', anchor: 'E' },
        to: { compId: 'c1', anchor: 'W' },
        dx: 'foo + 2', dy: '-foo',
      },
    ],
    mirrors: [],
    groups: [],
    stack: [
      { id: 'l1', name: 'Substrate', thickness: 'foo*10', material: 'sapphire', color: '#888', role: 'substrate' },
      {
        id: 'l2', name: 'WG', thickness: 'foo', material: 'lithium_niobate', color: '#0f0', role: 'waveguide',
        core_width: 'foo/2', slab_height: 'foo/10', slab_width: '5*foo', etch_angle: 'foo + 60',
      },
    ],
    simSetup: {
      fnominal: 'foo', padXNeg: 'foo+50', padXPos: '50*foo',
      padYNeg: 'foo', padYPos: 'foo/2', airPad: '2*foo',
      appendToActive: false,
    },
    booleans: [],
  };
}

describe('renameIdentInScene', () => {
  const scene = makeScene();
  const out = renameIdentInScene(scene, 'foo', 'bar');

  it('does not mutate the input scene', () => {
    expect(scene.params.foo.expr).toBe('10');
    expect(scene.components[0].w).toBe('foo + 1');
    expect(scene.snaps[0].dx).toBe('foo + 2');
    expect(scene.stack[0].thickness).toBe('foo*10');
    expect(scene.simSetup.fnominal).toBe('foo');
  });

  it('rewrites param expressions', () => {
    expect(out.params.dep.expr).toBe('2*bar - food');
  });

  it('leaves the word-boundary trap param "food" untouched', () => {
    // The KEY is not renamed (caller's job), and `food` inside the
    // expression must not become `bard` / `bar d`.
    expect(out.params.food).toBeDefined();
    expect(out.params.food.expr).toBe('bar + food');
  });

  it('rewrites rect w/h', () => {
    const r1 = out.components.find(c => c.id === 'r1');
    expect(r1.w).toBe('bar + 1');
    expect(r1.h).toBe('2*bar');
  });

  it('rewrites cutout dx/dy/w/h', () => {
    const cu = out.components.find(c => c.id === 'r1').cutouts[0];
    expect(cu.dx).toBe('bar/2');
    expect(cu.dy).toBe('-bar');
    expect(cu.w).toBe('bar');
    expect(cu.h).toBe('bar + food');
  });

  it('rewrites transform dx/dy/angle/n/offset', () => {
    const ts = out.components.find(c => c.id === 'r1').transforms;
    expect(ts[0].dx).toBe('bar');
    expect(ts[0].dy).toBe('bar*2');
    expect(ts[1].angle).toBe('bar + 45');
    expect(ts[2].n).toBe('bar');
    expect(ts[2].dx).toBe('3*bar');
    expect(ts[3].offset).toBe('-bar/2');
  });

  it('rewrites circle r', () => {
    expect(out.components.find(c => c.id === 'c1').r).toBe('bar');
  });

  it('rewrites ellipse rx/ry', () => {
    const e1 = out.components.find(c => c.id === 'e1');
    expect(e1.rx).toBe('bar');
    expect(e1.ry).toBe('bar/2');
  });

  it('rewrites polygon r/n', () => {
    const p1 = out.components.find(c => c.id === 'p1');
    expect(p1.r).toBe('bar+1');
    expect(p1.n).toBe('bar');
  });

  it('rewrites racetrack R/L_straight/p/wgWidth', () => {
    const rt = out.components.find(c => c.id === 'rt1');
    expect(rt.R).toBe('bar');
    expect(rt.L_straight).toBe('4*bar');
    expect(rt.p).toBe('bar/10');
    expect(rt.wgWidth).toBe('bar/5');
  });

  it('rewrites polyline trace width', () => {
    expect(out.components.find(c => c.id === 'pl1').width).toBe('bar/3');
  });

  it('rewrites rel-vertex dx/dy on polyline and polyshape', () => {
    const pl = out.components.find(c => c.id === 'pl1');
    expect(pl.vertices[1].dx).toBe('bar');
    expect(pl.vertices[1].dy).toBe('-bar');
    const ps = out.components.find(c => c.id === 'ps1');
    expect(ps.vertices[1].dx).toBe('bar*2');
    expect(ps.vertices[1].dy).toBe('food'); // trap untouched in a vertex too
  });

  it('passes snap-kind vertices through unchanged', () => {
    const pl = out.components.find(c => c.id === 'pl1');
    expect(pl.vertices[2]).toEqual({ kind: 'snap', compId: 'r1', anchor: 'NE' });
  });

  it('rewrites snap dx/dy', () => {
    expect(out.snaps[0].dx).toBe('bar + 2');
    expect(out.snaps[0].dy).toBe('-bar');
    // compId/anchor untouched — this is an ident rename, not a comp rename
    expect(out.snaps[0].from).toEqual({ compId: 'r1', anchor: 'E' });
  });

  it('rewrites stack thickness + rib cross-section fields', () => {
    expect(out.stack[0].thickness).toBe('bar*10');
    const wg = out.stack[1];
    expect(wg.thickness).toBe('bar');
    expect(wg.core_width).toBe('bar/2');
    expect(wg.slab_height).toBe('bar/10');
    expect(wg.slab_width).toBe('5*bar');
    expect(wg.etch_angle).toBe('bar + 60');
  });

  it('rewrites every simSetup expression field', () => {
    expect(out.simSetup.fnominal).toBe('bar');
    expect(out.simSetup.padXNeg).toBe('bar+50');
    expect(out.simSetup.padXPos).toBe('50*bar');
    expect(out.simSetup.padYNeg).toBe('bar');
    expect(out.simSetup.padYPos).toBe('bar/2');
    expect(out.simSetup.airPad).toBe('2*bar');
    expect(out.simSetup.appendToActive).toBe(false);
  });

  it('leaves non-expression fields alone', () => {
    const r1 = out.components.find(c => c.id === 'r1');
    expect(r1.cx).toBe(0);
    expect(r1.layer).toBe('electrode');
    expect(out.stack[1].material).toBe('lithium_niobate');
  });

  it('handles a scene without simSetup without adding a phantom key', () => {
    const bare = makeScene();
    delete bare.simSetup;
    const res = renameIdentInScene(bare, 'foo', 'bar');
    expect('simSetup' in res).toBe(false);
    expect(res.components.find(c => c.id === 'c1').r).toBe('bar');
  });

  it('returns the scene unchanged for invalid identifiers', () => {
    const s = makeScene();
    expect(renameIdentInScene(s, 'a+b', 'bar')).toBe(s);
    expect(renameIdentInScene(s, 'foo', '2bad')).toBe(s);
    expect(renameIdentInScene(s, '', 'bar')).toBe(s);
    expect(renameIdentInScene(s, 'foo', 'foo')).toBe(s);
  });
});
