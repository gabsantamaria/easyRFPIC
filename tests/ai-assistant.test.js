// AI geometry assistant — the deterministic half (no network).
//
// Pins: prefix allocation, the system-prompt scene context (Claude must
// be able to see existing params/components/stack to snap onto them),
// fragment normalization (string coercion + derived AABBs), validation
// (errors block insert; the categories here are the contract with the
// dialog UI), and applyFragment (template-insert semantics + the result
// must solve, pass snap-graph validation, and export HFSS-parametric).
import { describe, it, expect } from 'vitest';
import { makeBlankScene } from '../src/scene/schema.js';
import { resolveParams } from '../src/scene/params.js';
import { solveLayout, validateSnapGraph } from '../src/scene/solver.js';
import {
  buildSystemPrompt, GEOMETRY_TOOL, normalizeFragment, validateFragment,
  applyFragment, suggestPrefix, FRAGMENT_KINDS,
} from '../src/ai/assistant.js';
import { generateHfssNative } from '../src/export/hfss-native.js';

// A representative Claude output: CPW (signal + 2 grounds) with the gap
// and widths as params, grounds positioned by snaps off the signal.
const cpwFragment = () => ({
  params: [
    { name: 'ai1_w_sig', expr: '80', unit: 'um', desc: 'CPW signal width' },
    { name: 'ai1_gap', expr: '12', unit: 'um', desc: 'CPW gap' },
    { name: 'ai1_w_gnd', expr: '300', unit: 'um', desc: 'CPW ground width' },
    { name: 'ai1_len', expr: '2000', unit: 'um', desc: 'CPW length' },
  ],
  components: [
    { id: 'ai1_sig', kind: 'rect', layer: 'electrode', cx: 0, cy: 0, w: 'ai1_len', h: 'ai1_w_sig' },
    { id: 'ai1_gnd_top', kind: 'rect', layer: 'electrode', cx: 0, cy: 100, w: 'ai1_len', h: 'ai1_w_gnd' },
    { id: 'ai1_gnd_bot', kind: 'rect', layer: 'electrode', cx: 0, cy: -100, w: 'ai1_len', h: 'ai1_w_gnd' },
  ],
  snaps: [
    { from: { compId: 'ai1_sig', anchor: 'N' }, to: { compId: 'ai1_gnd_top', anchor: 'S' }, dx: '0', dy: 'ai1_gap' },
    { from: { compId: 'ai1_sig', anchor: 'S' }, to: { compId: 'ai1_gnd_bot', anchor: 'N' }, dx: '0', dy: '-ai1_gap' },
  ],
  notes: 'CPW G-S-G',
});

describe('suggestPrefix', () => {
  it('starts at ai1 on a fresh scene and skips taken namespaces', () => {
    const scene = makeBlankScene();
    expect(suggestPrefix(scene)).toBe('ai1');
    scene.components.push({ id: 'ai1_sig', kind: 'rect', layer: 'electrode', cx: 0, cy: 0, w: '10', h: '10', cutouts: [], transforms: [] });
    expect(suggestPrefix(scene)).toBe('ai2');
    scene.params.ai2_gap = { expr: '5', unit: 'um', desc: '' };
    expect(suggestPrefix(scene)).toBe('ai3');
  });
});

describe('buildSystemPrompt', () => {
  it('embeds the prefix rule, schema, and current scene context', () => {
    const scene = makeBlankScene();
    scene.params.my_gap = { expr: '7', unit: 'um', desc: 'existing gap' };
    scene.components.push({ id: 'meander_h', kind: 'rect', layer: 'electrode', cx: 10, cy: 20, w: '100', h: '40', cutouts: [], transforms: [] });
    const { values } = resolveParams(scene.params);
    const sys = buildSystemPrompt(scene, 'ai7', values);
    // Prefix rule
    expect(sys).toContain('"ai7_"');
    // All shape kinds documented
    for (const k of FRAGMENT_KINDS) expect(sys).toContain(`"${k}"`);
    // Existing scene context: params, components, conductor stack ids
    expect(sys).toContain('my_gap = 7');
    expect(sys).toContain('"meander_h"');
    expect(sys).toContain('l_cond');
    // The parametricity mission and snap mechanics
    expect(sys).toMatch(/snap/i);
    expect(sys).toMatch(/parametric/i);
  });
});

describe('GEOMETRY_TOOL', () => {
  it('is a well-formed Anthropic tool with the fragment schema', () => {
    expect(GEOMETRY_TOOL.name).toBe('emit_geometry');
    expect(GEOMETRY_TOOL.input_schema.type).toBe('object');
    expect(GEOMETRY_TOOL.input_schema.required).toEqual(['components']);
    const comp = GEOMETRY_TOOL.input_schema.properties.components.items;
    expect(comp.properties.kind.enum).toEqual(FRAGMENT_KINDS);
    expect(comp.required).toContain('id');
  });
});

describe('normalizeFragment', () => {
  it('string-coerces numeric expressions and derives circle/ellipse AABBs', () => {
    const f = normalizeFragment({
      components: [
        { id: 'a_c', kind: 'circle', layer: 'electrode', cx: 0, cy: 0, r: 25 },
        { id: 'a_e', kind: 'ellipse', layer: 'waveguide', cx: 0, cy: 0, rx: 10, ry: 4 },
        { id: 'a_p', kind: 'polyline', layer: 'electrode', cx: 0, cy: 0, width: 5, vertices: [
          { dx: 0, dy: 0 }, { kind: 'rel', dx: 100, dy: 0 },
        ] },
      ],
    });
    const [c, e, p] = f.components;
    expect(c.r).toBe('25');
    expect(c.w).toBe('2*(25)');
    expect(e.w).toBe('2*(10)');
    expect(e.h).toBe('2*(4)');
    expect(p.width).toBe('5');
    expect(p.w).toBe('0');
    expect(p.vertices[0].kind).toBe('rel');
    expect(p.vertices[0].dx).toBe('0');
    expect(p.vertices[1].dx).toBe('100');
  });

  it('forces polyshape closed and via layer/AABB', () => {
    const f = normalizeFragment({
      components: [
        { id: 'a_s', kind: 'polyshape', layer: 'electrode', cx: 0, cy: 0, vertices: [
          { kind: 'rel', dx: '0', dy: '0' }, { kind: 'rel', dx: '10', dy: '0' }, { kind: 'rel', dx: '-5', dy: '8' },
        ] },
        { id: 'a_v', kind: 'via', layer: 'electrode', cx: 0, cy: 0, r: '3' },
      ],
    });
    expect(f.components[0].closed).toBe(true);
    expect(f.components[1].layer).toBe('via');
    expect(f.components[1].w).toBe('2*(3)');
  });
});

describe('validateFragment', () => {
  const scene = makeBlankScene();

  it('accepts a well-formed CPW fragment', () => {
    const { errors, warnings } = validateFragment(normalizeFragment(cpwFragment()), scene);
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('rejects unknown kinds, bad layers, and missing required fields', () => {
    const { errors } = validateFragment(normalizeFragment({
      components: [
        { id: 'a_x', kind: 'blob', layer: 'electrode', cx: 0, cy: 0 },
        { id: 'a_y', kind: 'rect', layer: 'metal3', cx: 0, cy: 0, w: '10', h: '10' },
        { id: 'a_z', kind: 'circle', layer: 'electrode', cx: 0, cy: 0 }, // missing r
      ],
    }), scene);
    expect(errors.some(e => e.includes('unknown kind "blob"'))).toBe(true);
    expect(errors.some(e => e.includes('invalid layer "metal3"'))).toBe(true);
    expect(errors.some(e => e.includes('missing required field "r"'))).toBe(true);
  });

  it('rejects non-evaluating expressions', () => {
    const { errors } = validateFragment(normalizeFragment({
      components: [{ id: 'a_r', kind: 'rect', layer: 'electrode', cx: 0, cy: 0, w: 'undefined_param', h: '10' }],
    }), scene);
    expect(errors.some(e => e.includes('does not evaluate'))).toBe(true);
  });

  it('rejects dangling snap endpoints, bad anchors, and duplicate-to', () => {
    const f = cpwFragment();
    f.snaps.push({ from: { compId: 'ghost', anchor: 'C' }, to: { compId: 'ai1_gnd_top', anchor: 'Q' }, dx: '0', dy: '0' });
    const { errors } = validateFragment(normalizeFragment(f), scene);
    expect(errors.some(e => e.includes('unknown component "ghost"'))).toBe(true);
    expect(errors.some(e => e.includes('anchor "Q"'))).toBe(true);
    expect(errors.some(e => e.includes('more than one snap'))).toBe(true);
  });

  it('rejects snaps that re-position existing scene components', () => {
    const s = makeBlankScene();
    s.components.push({ id: 'user_rect', kind: 'rect', layer: 'electrode', cx: 0, cy: 0, w: '10', h: '10', cutouts: [], transforms: [] });
    const f = normalizeFragment({
      components: [{ id: 'ai1_new', kind: 'rect', layer: 'electrode', cx: 0, cy: 0, w: '10', h: '10' }],
      snaps: [{ from: { compId: 'ai1_new', anchor: 'E' }, to: { compId: 'user_rect', anchor: 'W' }, dx: '0', dy: '0' }],
    });
    const { errors } = validateFragment(f, s);
    expect(errors.some(e => e.includes('may only position NEW components'))).toBe(true);
  });

  it('rejects under-vertexed polyshapes and unknown vertex kinds', () => {
    const { errors } = validateFragment(normalizeFragment({
      components: [
        { id: 'a_s', kind: 'polyshape', layer: 'electrode', cx: 0, cy: 0, vertices: [
          { kind: 'rel', dx: '0', dy: '0' }, { kind: 'rel', dx: '10', dy: '0' },
        ] },
        { id: 'a_p', kind: 'polyline', layer: 'electrode', cx: 0, cy: 0, width: '5', vertices: [
          { kind: 'rel', dx: '0', dy: '0' }, { kind: 'bezier', dx: '1', dy: '1' },
        ] },
      ],
    }), scene);
    expect(errors.some(e => e.includes('at least 3 vertices'))).toBe(true);
    expect(errors.some(e => e.includes('unknown vertex kind "bezier"'))).toBe(true);
  });

  it('validates repeat transforms and rejects unknown transform kinds', () => {
    const good = normalizeFragment({
      components: [{
        id: 'a_f', kind: 'rect', layer: 'electrode', cx: 0, cy: 0, w: '5', h: '50',
        transforms: [{ kind: 'repeat', n: '4', dx: '15', dy: '0' }],
      }],
    });
    expect(validateFragment(good, scene).errors).toEqual([]);
    // includeOriginal defaulted by normalizeFragment
    expect(good.components[0].transforms[0].includeOriginal).toBe(true);

    const bad = normalizeFragment({
      components: [{
        id: 'a_g', kind: 'rect', layer: 'electrode', cx: 0, cy: 0, w: '5', h: '50',
        transforms: [{ kind: 'shear', x: '1' }],
      }],
    });
    expect(validateFragment(bad, scene).errors.some(e => e.includes('unknown transform kind "shear"'))).toBe(true);
  });

  it('warns (not errors) on id collisions with the scene', () => {
    const s = makeBlankScene();
    s.components.push({ id: 'ai1_sig', kind: 'rect', layer: 'electrode', cx: 0, cy: 0, w: '10', h: '10', cutouts: [], transforms: [] });
    const f = cpwFragment();
    f.snaps = []; // keep it to the id collision
    const { errors, warnings } = validateFragment(normalizeFragment(f), s);
    expect(errors).toEqual([]);
    expect(warnings.some(w => w.includes('"ai1_sig" already exists'))).toBe(true);
  });
});

describe('applyFragment', () => {
  it('inserts at the viewport center, solves, and stays a clean snap graph', () => {
    const scene = makeBlankScene();
    const next = applyFragment(scene, cpwFragment(), { viewport: { x: 500, y: 200 }, paramValues: {} });

    // Params merged
    expect(next.params.ai1_gap.expr).toBe('12');
    expect(next.params.ai1_w_sig.desc).toContain('signal');
    // Components inserted, root centered on the viewport
    const sig = next.components.find(c => c.id === 'ai1_sig');
    expect(sig).toBeTruthy();
    expect(sig.cx).toBeCloseTo(500, 6);
    expect(sig.cy).toBeCloseTo(200, 6);
    // Snap graph clean and solvable
    expect(validateSnapGraph(next.components, next.snaps)).toEqual([]);
    const { values } = resolveParams(next.params);
    const solved = solveLayout(next.components, next.snaps, values);
    const top = solved.find(c => c.id === 'ai1_gnd_top');
    const bot = solved.find(c => c.id === 'ai1_gnd_bot');
    // gnd centers sit at ±(w_sig/2 + gap + w_gnd/2) = ±202 from the signal
    expect(top.cy - 200).toBeCloseTo(40 + 12 + 150, 6);
    expect(bot.cy - 200).toBeCloseTo(-(40 + 12 + 150), 6);
  });

  it('keeps the HFSS export parametric in the fragment params', () => {
    const scene = makeBlankScene();
    const next = applyFragment(scene, cpwFragment(), { viewport: { x: 0, y: 0 }, paramValues: {} });
    const { values } = resolveParams(next.params);
    const code = generateHfssNative(next, values);
    for (const p of ['ai1_w_sig', 'ai1_gap', 'ai1_w_gnd', 'ai1_len']) {
      expect(code).toContain(`set_var("${p}"`);
    }
    // The snap chain keeps the grounds positioned BY EXPRESSION (the gap
    // param appears in position math, not just the variable table).
    expect(code.split('ai1_gap').length).toBeGreaterThan(2);
  });

  it('renames on id collision and remaps snaps + snap vertices consistently', () => {
    const scene = makeBlankScene();
    const once = applyFragment(scene, cpwFragment(), { viewport: { x: 0, y: 0 }, paramValues: {} });
    // Insert the SAME fragment again (the dialog would use ai2_, but the
    // apply path must survive verbatim collisions too).
    const twice = applyFragment(once, cpwFragment(), { viewport: { x: 100, y: 0 }, paramValues: {} });
    const ids = twice.components.map(c => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('ai1_sig_2');
    expect(validateSnapGraph(twice.components, twice.snaps)).toEqual([]);
    const { values } = resolveParams(twice.params);
    expect(() => solveLayout(twice.components, twice.snaps, values)).not.toThrow();
  });

  it('routes a polyline snap vertex onto a renamed component', () => {
    const scene = makeBlankScene();
    scene.components.push({ id: 'pad', kind: 'rect', layer: 'electrode', cx: 0, cy: 0, w: '50', h: '50', cutouts: [], transforms: [] });
    const fragment = {
      components: [
        { id: 'pad', kind: 'rect', layer: 'electrode', cx: 200, cy: 0, w: '50', h: '50' }, // collides → pad_2
        { id: 'trace', kind: 'polyline', layer: 'electrode', cx: 0, cy: 0, width: '10', vertices: [
          { kind: 'snap', compId: 'pad', anchor: 'E' },
          { kind: 'rel', dx: '100', dy: '0' },
        ] },
      ],
    };
    const next = applyFragment(scene, fragment, { viewport: { x: 0, y: 0 }, paramValues: {} });
    const trace = next.components.find(c => c.id === 'trace');
    // The snap vertex must follow the RENAMED fragment pad, not the
    // pre-existing scene pad.
    expect(trace.vertices[0].compId).toBe('pad_2');
  });
});
