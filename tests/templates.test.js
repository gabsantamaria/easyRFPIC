import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import { writeFileSync, mkdirSync } from 'fs';
import racetrack from '../src/templates/racetrack.js';
import racetrackDiameter from '../src/templates/racetrack-diameter.js';
import ringResonator from '../src/templates/ring-resonator.js';
import meanderElectrode from '../src/templates/meander-electrode.js';
import cpwGsg from '../src/templates/cpw-gsg.js';
import gsgProbePads from '../src/templates/gsg-probe-pads.js';
import idcComb from '../src/templates/idc-comb.js';
import { generateHfssNative } from '../src/export/hfss-native.js';
import { BUILTIN_TEMPLATES } from '../src/templates/index.js';
import { insertLibraryPayload } from '../src/templates/_library-insert.js';
import { generateTemplateModuleSource } from '../src/templates/_codify.js';
import { makeBlankScene } from '../src/scene/schema.js';
import { resolveParams, evalExpr } from '../src/scene/params.js';
import { solveLayout, resolveBooleanBboxes } from '../src/scene/solver.js';
import { expandTransforms } from '../src/scene/transforms.js';
import { buildRacetrackCenterline } from '../src/geometry/racetrack.js';

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

describe('racetrack-by-diameter template', () => {
  it('is registered and drops a racetrack with a diameter param (no bare R param)', () => {
    expect(BUILTIN_TEMPLATES.map((t) => t.id)).toContain('builtin_racetrack_diameter');
    const prev = makeBlankScene();
    const next = racetrackDiameter.insert(prev, ctx);
    const added = next.components[next.components.length - 1];
    expect(added.kind).toBe('racetrack');
    expect(added.layer).toBe('waveguide');
    const newParamNames = Object.keys(next.params).filter((k) => !prev.params[k]);
    const baseId = added.id;
    // Diameter is the knob; R is a DERIVED expression, not a standalone param.
    expect(newParamNames).toEqual(expect.arrayContaining([
      `${baseId}_D`, `${baseId}_L_straight`, `${baseId}_p`,
    ]));
    expect(newParamNames).not.toContain(`${baseId}_R`);
    expect(added.R).toContain(`${baseId}_D`); // R derived from D
  });

  it('derives R = D/2 at the default (pure-arc) so the arm separation equals D', () => {
    const prev = makeBlankScene();
    const next = racetrackDiameter.insert(prev, ctx);
    const c = next.components[next.components.length - 1];
    const { values } = resolveParams(next.params);
    const [inst] = expandTransforms([c], values);
    // Default D=200, p=0 → R=100.
    expect(inst.p).toBe(0);
    expect(inst.R).toBeCloseTo(100, 9);
    // The rendered centerline arm separation equals D at p=0 (D=2R is
    // analytically exact; the ~nm residual is the bend's quadrature error).
    const cl = buildRacetrackCenterline(inst.R, inst.L_straight, inst.p);
    const ys = cl.map(([, y]) => y);
    const sep = Math.max(...ys) - Math.min(...ys);
    expect(Math.abs(sep - 200)).toBeLessThan(0.05);
  });

  it('keeps the rendered separation within ~1% of D for Euler bends (p=1)', () => {
    const prev = makeBlankScene();
    let next = racetrackDiameter.insert(prev, ctx);
    const c = next.components[next.components.length - 1];
    const baseId = c.id;
    next = { ...next, params: { ...next.params, [`${baseId}_p`]: { expr: '1', unit: '', desc: '' } } };
    const { values } = resolveParams(next.params);
    const [inst] = expandTransforms([c], values);
    const cl = buildRacetrackCenterline(inst.R, inst.L_straight, inst.p);
    const ys = cl.map(([, y]) => y);
    const sep = Math.max(...ys) - Math.min(...ys);
    expect(Math.abs(sep - 200) / 200).toBeLessThan(0.02);
  });

  it('HFSS export keeps D / L_straight / p as set_var knobs and parses', () => {
    const prev = makeBlankScene();
    const next = racetrackDiameter.insert(prev, ctx);
    const baseId = next.components[next.components.length - 1].id;
    const { values } = resolveParams(next.params);
    const code = generateHfssNative(next, values);
    for (const p of [`${baseId}_D`, `${baseId}_L_straight`, `${baseId}_p`]) {
      expect(code).toContain(`set_var("${p}"`);
    }
    mkdirSync('tests/out', { recursive: true });
    writeFileSync('tests/out/_racetrack_diameter.py', code);
    expect(() => execSync('python3 -c "import ast; ast.parse(open(\'tests/out/_racetrack_diameter.py\').read())"')).not.toThrow();
  });

  it('avoids id collisions on repeated insert', () => {
    let scene = makeBlankScene();
    scene = racetrackDiameter.insert(scene, ctx);
    scene = racetrackDiameter.insert(scene, ctx);
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

describe('meander-electrode template', () => {
  it('inserts 9 united conductor primitives + 8 snaps + 1 union boolean', () => {
    const prev = makeBlankScene();
    const next = meanderElectrode.insert(prev, ctx);
    // 9 primitives + 1 boolean = 10 added components
    expect(next.components.length).toBe(prev.components.length + 10);
    // 8 snaps anchoring the other 8 primitives to the rail anchor
    expect(next.snaps.length).toBe(prev.snaps.length + 8);
    const boolean = next.components.find(c => c.kind === 'boolean');
    expect(boolean).toBeDefined();
    expect(boolean.op).toBe('union');
    expect(boolean.operandIds.length).toBe(9);
    // All operands tagged consumedBy the boolean
    for (const id of boolean.operandIds) {
      const op = next.components.find(c => c.id === id);
      expect(op.consumedBy).toBe(boolean.id);
      expect(op.layer).toBe('electrode');
    }
  });

  it('pre-installs a repeat transform driven by the N parameter', () => {
    const prev = makeBlankScene();
    const next = meanderElectrode.insert(prev, ctx);
    const boolean = next.components.find(c => c.kind === 'boolean');
    expect(boolean.transforms.length).toBe(1);
    const t = boolean.transforms[0];
    expect(t.kind).toBe('repeat');
    expect(t.enabled).toBe(true);
    expect(t.includeOriginal).toBe(true);
    // n is the param-driven count (N - 1) so total instances = N
    expect(t.n).toMatch(/_N\s*-\s*1/);
    // Step in y is one cell period (cell_w + cell_s)
    expect(t.dy).toMatch(/cell_w/);
    expect(t.dy).toMatch(/cell_s/);
    expect(t.dx).toBe('0');
  });

  it('adds the full set of meander parameters', () => {
    const prev = makeBlankScene();
    const next = meanderElectrode.insert(prev, ctx);
    const newNames = Object.keys(next.params).filter(k => !prev.params[k]);
    expect(newNames.some(n => n.endsWith('_cell_w'))).toBe(true);
    expect(newNames.some(n => n.endsWith('_cell_s'))).toBe(true);
    expect(newNames.some(n => n.endsWith('_cell_h'))).toBe(true);
    expect(newNames.some(n => n.endsWith('_cell_d'))).toBe(true);
    expect(newNames.some(n => n.endsWith('_trace_w'))).toBe(true);
    expect(newNames.some(n => n.endsWith('_gap_s'))).toBe(true);
    expect(newNames.some(n => n.endsWith('_N'))).toBe(true);
  });

  it('produces a unit cell whose AABB equals (3W+D+H) x (L+S)', () => {
    // With defaults: trace_w=0.5, cell_d=4, cell_h=9, cell_w=25, cell_s=2.
    // Expected: width = 3*0.5 + 4 + 9 = 14.5; height = 25 + 2 = 27.
    const prev = makeBlankScene();
    const next = meanderElectrode.insert(prev, ctx);
    const { values: pv } = resolveParams(next.params);
    let solved = solveLayout(next.components, next.snaps, pv);
    solved = resolveBooleanBboxes(solved, pv);
    const boolean = solved.find(c => c.kind === 'boolean');
    expect(boolean.w).toBeCloseTo(14.5, 6);
    expect(boolean.h).toBeCloseTo(27, 6);
  });

  it('N controls the number of cells via the repeat transform', () => {
    const prev = makeBlankScene();
    const next = meanderElectrode.insert(prev, ctx);
    const { values: pv } = resolveParams(next.params);
    let solved = solveLayout(next.components, next.snaps, pv);
    solved = resolveBooleanBboxes(solved, pv);
    const boolean = solved.find(c => c.kind === 'boolean');
    const insts = expandTransforms([boolean], pv);
    expect(insts.length).toBe(3); // default N=3
  });

  it('avoids id collisions on repeated insert', () => {
    let scene = makeBlankScene();
    scene = meanderElectrode.insert(scene, ctx);
    scene = meanderElectrode.insert(scene, ctx);
    const ids = scene.components.map(c => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    const paramKeys = Object.keys(scene.params);
    expect(new Set(paramKeys).size).toBe(paramKeys.length);
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

// ── RF building-block templates: cpw_gsg / gsg_probe_pads / idc_comb ────
// Each sanity-runs through solveLayout AND generateHfssNative (ast.parse
// green + at least one load-bearing parametric string proving the canvas
// parametrization survives into the HFSS script).

const solveScene = (scene) => {
  const { values: pv } = resolveParams(scene.params);
  let solved = solveLayout(scene.components, scene.snaps, pv);
  solved = resolveBooleanBboxes(solved, pv);
  return { solved, pv };
};
const hfssParses = (code, name) => {
  mkdirSync('tests/out', { recursive: true });
  writeFileSync(`tests/out/${name}.py`, code);
  expect(() => execSync(
    `python3 -c "import ast; ast.parse(open('tests/out/${name}.py').read())"`,
    { stdio: 'pipe' }
  )).not.toThrow();
};
// Locate the safe_create_* block that names a given component, so
// assertions read THAT component's position exprs, not an earlier one's.
const blockFor = (out, compId) => {
  const nameIdx = out.indexOf(`"Name:=", "${compId}"`);
  expect(nameIdx).toBeGreaterThan(0);
  const blockStart = out.lastIndexOf('safe_create_', nameIdx);
  expect(blockStart).toBeGreaterThan(0);
  return out.slice(blockStart, nameIdx);
};

describe('cpw_gsg template', () => {
  it('is registered in BUILTIN_TEMPLATES', () => {
    expect(BUILTIN_TEMPLATES.map((t) => t.id)).toContain('builtin_cpw_gsg');
  });

  it('adds signal + two grounds with gap-parametric snaps', () => {
    const prev = makeBlankScene();
    const next = cpwGsg.insert(prev, ctx);
    expect(next.components.length).toBe(prev.components.length + 3);
    expect(next.snaps.length).toBe(prev.snaps.length + 2);
    const sig = next.components.find((c) => c.id.endsWith('_sig'));
    const gndT = next.components.find((c) => c.id.endsWith('_gnd_top'));
    const gndB = next.components.find((c) => c.id.endsWith('_gnd_bot'));
    expect(sig).toBeDefined();
    expect(gndT).toBeDefined();
    expect(gndB).toBeDefined();
    for (const c of [sig, gndT, gndB]) expect(c.layer).toBe('electrode');
    const newNames = Object.keys(next.params).filter((k) => !prev.params[k]);
    for (const suffix of ['_w_sig', '_gap', '_w_gnd', '_L']) {
      expect(newNames.some((n) => n.endsWith(suffix))).toBe(true);
    }
    // Both ground snaps hang off the signal and carry the gap param.
    const added = next.snaps.slice(prev.snaps.length);
    for (const s of added) {
      expect(s.from.compId).toBe(sig.id);
      expect(s.dy).toMatch(/_gap/);
    }
  });

  it('solves grounds symmetric about the signal, edge gap = <p>_gap', () => {
    // Defaults: w_sig=10, gap=6, w_gnd=60 → ground centers at ±(5+6+30)=±41.
    const next = cpwGsg.insert(makeBlankScene(), ctx);
    const { solved } = solveScene(next);
    const gndT = solved.find((c) => c.id.endsWith('_gnd_top'));
    const gndB = solved.find((c) => c.id.endsWith('_gnd_bot'));
    expect(gndT.cy).toBeCloseTo(41, 6);
    expect(gndB.cy).toBeCloseTo(-41, 6);
  });

  it('sweeping <p>_gap moves both grounds', () => {
    const next = cpwGsg.insert(makeBlankScene(), ctx);
    const gapName = Object.keys(next.params).find((k) => k.endsWith('_gap'));
    next.params[gapName] = { ...next.params[gapName], expr: '20' };
    const { solved } = solveScene(next);
    const gndT = solved.find((c) => c.id.endsWith('_gnd_top'));
    expect(gndT.cy).toBeCloseTo(5 + 20 + 30, 6);
  });

  it('HFSS export keeps the gap param in the grounds\' placement + parses', () => {
    const next = cpwGsg.insert(makeBlankScene(), ctx);
    const { pv } = solveScene(next);
    const out = generateHfssNative(next, pv);
    const gapName = Object.keys(next.params).find((k) => k.endsWith('_gap'));
    const gndT = next.components.find((c) => c.id.endsWith('_gnd_top'));
    const gndB = next.components.find((c) => c.id.endsWith('_gnd_bot'));
    expect(blockFor(out, gndT.id)).toContain(gapName);
    expect(blockFor(out, gndB.id)).toContain(gapName);
    hfssParses(out, 'vitest_tpl_cpw_gsg');
  });
});

describe('gsg_probe_pads template', () => {
  it('is registered in BUILTIN_TEMPLATES', () => {
    expect(BUILTIN_TEMPLATES.map((t) => t.id)).toContain('builtin_gsg_probe_pads');
  });

  it('adds 3 pads + 3 stubs + 3 tapered polylines, 8 snaps, fillet param on pads', () => {
    const prev = makeBlankScene();
    const next = gsgProbePads.insert(prev, ctx);
    expect(next.components.length).toBe(prev.components.length + 9);
    expect(next.snaps.length).toBe(prev.snaps.length + 8);
    const pads = next.components.filter((c) => c.id.includes('_pad_'));
    const stubs = next.components.filter((c) => c.id.includes('_stub_'));
    const tapers = next.components.filter((c) => c.kind === 'polyline');
    expect(pads.length).toBe(3);
    expect(stubs.length).toBe(3);
    expect(tapers.length).toBe(3);
    // Pads carry the optional cornerRadius param (default expr '0').
    const padRName = Object.keys(next.params).find((k) => k.endsWith('_pad_r'));
    expect(padRName).toBeDefined();
    expect(next.params[padRName].expr).toBe('0');
    for (const p of pads) expect(p.cornerRadius).toBe(padRName);
    // Each taper: base width = pad height param; vertex 0 is a zero-
    // offset rel (rides cx/cy = the pad's E anchor via component snap);
    // vertex 1 is snap-bound to the stub and carries the end (trace)
    // width → tapered polyline.
    const padHName = Object.keys(next.params).find((k) => k.endsWith('_pad_h'));
    for (const t of tapers) {
      expect(t.width).toBe(padHName);
      expect(t.vertices.length).toBe(2);
      expect(t.vertices[0].kind).toBe('rel');
      expect(t.vertices[1].kind).toBe('snap');
      expect(t.vertices[1].anchor).toBe('W');
      expect(t.vertices[1].width).toMatch(/_w_(sig|gnd)$/);
    }
  });

  it('solves a coherent launch: pitch pads in, CPW-gap stubs out', () => {
    // Defaults: pad_w=80, pad_h=80, pitch=150, taper_L=200, stub_L=50,
    // w_sig=10, gap=6, w_gnd=60.
    const next = gsgProbePads.insert(makeBlankScene(), ctx);
    const { solved } = solveScene(next);
    const padGT = solved.find((c) => c.id.endsWith('_pad_gnd_top'));
    const padGB = solved.find((c) => c.id.endsWith('_pad_gnd_bot'));
    const stubS = solved.find((c) => c.id.endsWith('_stub_sig'));
    const stubGT = solved.find((c) => c.id.endsWith('_stub_gnd_top'));
    const tapS = solved.find((c) => c.id.endsWith('_taper_sig'));
    expect(padGT.cy).toBeCloseTo(150, 6);
    expect(padGB.cy).toBeCloseTo(-150, 6);
    // stub_sig.W = pad_sig.E + taper_L → cx = 40 + 200 + 25 = 265.
    expect(stubS.cx).toBeCloseTo(265, 6);
    expect(stubS.cy).toBeCloseTo(0, 6);
    // ground stub rides the SIGNAL stub at the CPW gap: 5 + 6 + 30 = 41.
    expect(stubGT.cy).toBeCloseTo(41, 6);
    // taper vertex 0 pinned to pad_sig.E = (40, 0).
    expect(tapS.cx).toBeCloseTo(40, 6);
    expect(tapS.cy).toBeCloseTo(0, 6);
  });

  it('pitch sweep moves ground pads AND their taper roots in lockstep', () => {
    const next = gsgProbePads.insert(makeBlankScene(), ctx);
    const pitchName = Object.keys(next.params).find((k) => k.endsWith('_pitch'));
    next.params[pitchName] = { ...next.params[pitchName], expr: '200' };
    const { solved } = solveScene(next);
    const padGT = solved.find((c) => c.id.endsWith('_pad_gnd_top'));
    const tapGT = solved.find((c) => c.id.endsWith('_taper_gnd_top'));
    expect(padGT.cy).toBeCloseTo(200, 6);
    expect(tapGT.cy).toBeCloseTo(200, 6); // taper root pinned to pad.E
  });

  it('HFSS export emits parametric tapered transitions (sqrt corners) + parses', () => {
    const next = gsgProbePads.insert(makeBlankScene(), ctx);
    const { pv } = solveScene(next);
    const out = generateHfssNative(next, pv);
    expect(out).toContain('TAPERED polyline trace');
    // Parametric unit-normal corner expressions.
    expect(out).toContain('sqrt(');
    // Corner exprs ride the pad width (vertex-0 chain = pad.E anchor
    // offset) AND the live trace-width params — not baked numerics.
    const padWName = Object.keys(next.params).find((k) => k.endsWith('_pad_w'));
    const wSigName = Object.keys(next.params).find((k) => k.endsWith('_w_sig'));
    expect(out).toMatch(new RegExp(`"[XY]:=", "[^"]*${padWName}[^"]*"`));
    expect(out).toMatch(new RegExp(`"[XY]:=", "[^"]*${wSigName}[^"]*"`));
    // Safety report lists the taper widths as parametric.
    expect(out).toContain('per-vertex taper widths');
    hfssParses(out, 'vitest_tpl_gsg_probe_pads');
  });
});

describe('idc_comb template', () => {
  it('is registered in BUILTIN_TEMPLATES', () => {
    expect(BUILTIN_TEMPLATES.map((t) => t.id)).toContain('builtin_idc_comb');
  });

  it('adds 2 buses + 2 fingers consumed into one union per side, 3 snaps', () => {
    const prev = makeBlankScene();
    const next = idcComb.insert(prev, ctx);
    expect(next.components.length).toBe(prev.components.length + 6);
    expect(next.snaps.length).toBe(prev.snaps.length + 3);
    const unions = next.components.filter((c) => c.kind === 'boolean');
    expect(unions.length).toBe(2);
    for (const u of unions) {
      expect(u.op).toBe('union');
      expect(u.operandIds.length).toBe(2);
      for (const id of u.operandIds) {
        const op = next.components.find((c) => c.id === id);
        expect(op.consumedBy).toBe(u.id);
        expect(op.layer).toBe('electrode');
      }
      // Bus first so Unite's surviving part renames cleanly.
      expect(u.operandIds[0]).toMatch(/_bus_/);
    }
  });

  it('fingers carry an N-driven repeat transform (one same-side pitch in y)', () => {
    const prev = makeBlankScene();
    const next = idcComb.insert(prev, ctx);
    const fingers = next.components.filter((c) => c.id.includes('_finger_'));
    expect(fingers.length).toBe(2);
    for (const f of fingers) {
      expect(f.transforms.length).toBe(1);
      const t = f.transforms[0];
      expect(t.kind).toBe('repeat');
      expect(t.enabled).toBe(true);
      expect(t.includeOriginal).toBe(true);
      expect(t.n).toMatch(/_N\)?\s*-\s*1/);   // repeat count tracks <p>_N
      expect(t.dx).toBe('0');
      expect(t.dy).toMatch(/_finger_w/);
      expect(t.dy).toMatch(/_gap/);
    }
    // Default N=5 → 5 instances per side, spaced 2*(4+3)=14 in y.
    const { solved, pv } = solveScene(next);
    const fL = solved.find((c) => c.id.endsWith('_finger_left'));
    const insts = expandTransforms([fL], pv);
    expect(insts.length).toBe(5);
    expect(insts[1].cy - insts[0].cy).toBeCloseTo(14, 6);
  });

  it('N sweep changes the expanded finger count', () => {
    const next = idcComb.insert(makeBlankScene(), ctx);
    const nName = Object.keys(next.params).find((k) => k.endsWith('_N'));
    next.params[nName] = { ...next.params[nName], expr: '8' };
    const { solved, pv } = solveScene(next);
    const fR = solved.find((c) => c.id.endsWith('_finger_right'));
    expect(expandTransforms([fR], pv).length).toBe(8);
  });

  it('solves interdigitated geometry: overlap + opposing-finger gap honored', () => {
    // Defaults: finger_w=4, finger_L=60, gap=3, overlap=50, bus_w=10.
    const next = idcComb.insert(makeBlankScene(), ctx);
    const { solved, pv } = solveScene(next);
    const busL = solved.find((c) => c.id.endsWith('_bus_left'));
    const busR = solved.find((c) => c.id.endsWith('_bus_right'));
    const fL = solved.find((c) => c.id.endsWith('_finger_left'));
    const fR = solved.find((c) => c.id.endsWith('_finger_right'));
    // Bus height covers both combs: (2*5-1)*(4+3)+4 = 39+28 = 67... = 67? (9*7+4)=67.
    expect(evalOrNum(busL.h, pv)).toBeCloseTo(67, 6);
    // Inner faces D = 2*60-50 = 70 apart → busR.cx = busL.cx + bus_w + D.
    expect(busR.cx - busL.cx).toBeCloseTo(10 + 70, 6);
    // x-overlap of opposing fingers = overlap param (50).
    const fLRight = fL.cx + 30, fRLeft = fR.cx - 30;
    expect(fLRight - fRLeft).toBeCloseTo(50, 6);
    // y gap between adjacent opposing fingers = gap param (3).
    expect((fR.cy - 2) - (fL.cy + 2)).toBeCloseTo(3, 6);
  });

  it('HFSS export: parametric duplicate step, N-count clones, per-side Unite + parses', () => {
    const next = idcComb.insert(makeBlankScene(), ctx);
    const { pv } = solveScene(next);
    const out = generateHfssNative(next, pv);
    expect(out).toContain('DuplicateAlongLine');
    // Duplicate step stays a LIVE expression of finger_w + gap.
    const fwName = Object.keys(next.params).find((k) => k.endsWith('_finger_w'));
    const gapName = Object.keys(next.params).find((k) => k.endsWith('_gap'));
    expect(out).toMatch(new RegExp(`"YComponent:=", "[^"]*${fwName}[^"]*${gapName}[^"]*"`));
    // Default N=5 → repeat n=4 → NumClones emitted as n+1 = 5.
    expect(out).toContain('"NumClones:=", "5"');
    // Per-side Unite selections start with the bus and include the finger.
    const busLId = next.components.find((c) => c.id.endsWith('_bus_left')).id;
    const fLId = next.components.find((c) => c.id.endsWith('_finger_left')).id;
    expect(out).toMatch(new RegExp(`"Selections:=", "${busLId},${fLId}`));
    hfssParses(out, 'vitest_tpl_idc_comb');
  });

  it('avoids id/param collisions on repeated insert', () => {
    let scene = makeBlankScene();
    scene = idcComb.insert(scene, ctx);
    scene = idcComb.insert(scene, ctx);
    scene = cpwGsg.insert(scene, ctx);
    scene = gsgProbePads.insert(scene, ctx);
    const ids = scene.components.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    const paramKeys = Object.keys(scene.params);
    expect(new Set(paramKeys).size).toBe(paramKeys.length);
    // The whole multi-template scene still solves and exports.
    const { solved, pv } = solveScene(scene);
    expect(solved.every((c) => Number.isFinite(c.cx) && Number.isFinite(c.cy))).toBe(true);
    const out = generateHfssNative(scene, pv);
    hfssParses(out, 'vitest_tpl_rf_combo');
  });
});

// Tiny helper: components solved by solveLayout keep w/h as expressions.
function evalOrNum(v, pv) {
  return typeof v === 'number' ? v : evalExpr(v, pv);
}
