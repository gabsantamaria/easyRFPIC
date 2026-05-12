import { describe, it, expect } from 'vitest';
import racetrack from '../src/templates/racetrack.js';
import ringResonator from '../src/templates/ring-resonator.js';
import { BUILTIN_TEMPLATES } from '../src/templates/index.js';
import { insertLibraryPayload } from '../src/templates/_library-insert.js';
import { generateTemplateModuleSource } from '../src/templates/_codify.js';
import { makeBlankScene } from '../src/scene/schema.js';

const ctx = { viewport: { x: 0, y: 0 }, paramValues: {} };

describe('BUILTIN_TEMPLATES registry', () => {
  it('has at least racetrack + ring-resonator', () => {
    expect(BUILTIN_TEMPLATES.length).toBeGreaterThanOrEqual(2);
    const ids = BUILTIN_TEMPLATES.map((t) => t.id);
    expect(ids).toContain('builtin_racetrack');
    expect(ids).toContain('builtin_ring_resonator');
  });
  it('each template has the required shape', () => {
    for (const t of BUILTIN_TEMPLATES) {
      expect(t).toMatchObject({ id: expect.any(String), name: expect.any(String) });
      expect(t.insert).toBeTypeOf('function');
    }
  });
});

describe('racetrack template', () => {
  it('drops a racetrack component with three new params', () => {
    const prev = makeBlankScene();
    const next = racetrack.insert(prev, ctx);
    expect(next.components.length).toBe(prev.components.length + 1);
    const added = next.components[next.components.length - 1];
    expect(added.kind).toBe('racetrack');
    expect(added.layer).toBe('waveguide');
    // Three new id-prefixed parameters.
    const newParamNames = Object.keys(next.params).filter((k) => !prev.params[k]);
    expect(newParamNames.length).toBeGreaterThanOrEqual(3);
    const baseId = added.id;
    expect(newParamNames).toEqual(expect.arrayContaining([
      `${baseId}_R`, `${baseId}_L_straight`, `${baseId}_p`,
    ]));
  });
  it('avoids id collisions on repeated insert', () => {
    let scene = makeBlankScene();
    scene = racetrack.insert(scene, ctx);
    scene = racetrack.insert(scene, ctx);
    const ids = scene.components.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('ring-resonator template', () => {
  it('adds a bus rect + a ring racetrack + a coupling snap', () => {
    const prev = makeBlankScene();
    const next = ringResonator.insert(prev, ctx);
    expect(next.components.length).toBe(prev.components.length + 2);
    const ring = next.components.find((c) => c.kind === 'racetrack');
    const bus  = next.components.find((c) => c.kind === 'rect' && c.layer === 'waveguide');
    expect(ring).toBeDefined();
    expect(bus).toBeDefined();
    expect(next.snaps.length).toBe(prev.snaps.length + 1);
    const snap = next.snaps[next.snaps.length - 1];
    expect(snap.from.compId).toBe(bus.id);
    expect(snap.to.compId).toBe(ring.id);
    expect(snap.from.anchor).toBe('N');
    expect(snap.to.anchor).toBe('S');
  });
  it('adds an id-prefixed coupling-gap param', () => {
    const prev = makeBlankScene();
    const next = ringResonator.insert(prev, ctx);
    const newParamNames = Object.keys(next.params).filter((k) => !prev.params[k]);
    expect(newParamNames.some((n) => n.endsWith('_gap'))).toBe(true);
    expect(newParamNames.some((n) => n.endsWith('_R'))).toBe(true);
    expect(newParamNames.some((n) => n.endsWith('_bus_L'))).toBe(true);
  });
});

describe('insertLibraryPayload', () => {
  const samplePayload = {
    name: 'cap_pair',
    params: { cap_w: { expr: '20', unit: 'µm' }, cap_h: { expr: '10', unit: 'µm' } },
    components: [
      { id: 'cap_a', kind: 'rect', layer: 'electrode', cx: 0,  cy: 0, w: 'cap_w', h: 'cap_h', cutouts: [], transforms: [] },
      { id: 'cap_b', kind: 'rect', layer: 'electrode', cx: 50, cy: 0, w: 'cap_w', h: 'cap_h', cutouts: [], transforms: [] },
    ],
    snaps: [],
    groups: [],
  };

  it('drops new components and reuses existing global params', () => {
    const prev = { ...makeBlankScene(), params: { cap_w: { expr: '15' } } };
    const next = insertLibraryPayload(prev, ctx, samplePayload);
    expect(next.components.length).toBe(2);
    // Existing cap_w should NOT have been overwritten.
    expect(next.params.cap_w.expr).toBe('15');
    // cap_h was missing → it gets added with the payload's value.
    expect(next.params.cap_h.expr).toBe('10');
  });

  it('rewires component IDs that collide with existing ones', () => {
    const prev = {
      ...makeBlankScene(),
      components: [{ id: 'cap_a', kind: 'rect', layer: 'electrode', cx: 0, cy: 0, w: '5', h: '5', cutouts: [], transforms: [] }],
    };
    const next = insertLibraryPayload(prev, ctx, samplePayload);
    const ids = next.components.map((c) => c.id);
    // pre-existing cap_a stays; the payload's cap_a gets a fresh suffix.
    expect(ids).toContain('cap_a');
    expect(ids).toContain('cap_a_2');
    expect(ids).toContain('cap_b');
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('translates the payload bbox center onto viewport.{x,y}', () => {
    const prev = makeBlankScene();
    const next = insertLibraryPayload(prev, { viewport: { x: 100, y: 0 }, paramValues: { cap_w: 20, cap_h: 10 } }, samplePayload);
    // Original bbox center: (0+50)/2 = 25. Translate so center → 100. dx = 75.
    // → cap_a.cx 0 + 75 = 75, cap_b.cx 50 + 75 = 125.
    const xs = next.components.map((c) => c.cx).sort((a, b) => a - b);
    expect(xs[0]).toBe(75);
    expect(xs[1]).toBe(125);
  });
});

describe('generateTemplateModuleSource', () => {
  it('emits a parseable ESM module with a default export', () => {
    const { source, filename } = generateTemplateModuleSource({
      payload: { name: 'foo', params: {}, components: [], snaps: [], groups: [] },
      name: 'Sample template (v1)',
    });
    expect(filename).toBe('sample_template_v1.js');
    expect(source).toContain("import { insertLibraryPayload } from './_library-insert.js';");
    expect(source).toContain('export default {');
    expect(source).toContain('id: "builtin_Sample_template_v1"');
    expect(source).toContain('insert: (prev, ctx) => insertLibraryPayload(prev, ctx, PAYLOAD)');
  });
  it('JSON-stringifies the payload inline', () => {
    const { source } = generateTemplateModuleSource({
      payload: { name: 'x', params: { a: { expr: '1' } }, components: [], snaps: [], groups: [] },
      name: 'x',
    });
    expect(source).toContain('"expr": "1"');
  });
  it('survives names with strange characters', () => {
    const { filename } = generateTemplateModuleSource({
      payload: { name: '!!!', params: {}, components: [], snaps: [], groups: [] },
      name: '!!!',
    });
    expect(filename).toMatch(/^[a-z0-9_]+\.js$/);
  });
});
