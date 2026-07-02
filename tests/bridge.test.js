// D7 (airbridge component) coverage.
//
// Schema: normalizeScene defaults / coercion / derived AABB / stripped
// fields / stale conductor binding. Geometry: ring fallback (footprint
// rect). Transforms: field propagation + rotation seed + repeat clones.
// Solver: snap onto bridge anchors through the (length)×(width) AABB.
// Exports: HFSS native (parametric spline profile + sweep + set_var +
// rotation sandwich + sheet-mode PEC boundary), GDS layer 150, pyAEDT
// AST. Walkers: rename-ident + tokenizeComponentExprs. AI assistant:
// kind registration + fragment normalization / validation.
import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import { writeFileSync, mkdirSync } from 'fs';
import { shapeInstanceToRing } from '../src/geometry/rings.js';
import { expandTransforms } from '../src/scene/transforms.js';
import { normalizeScene, makeBlankScene } from '../src/scene/schema.js';
import { renameIdentInScene } from '../src/scene/rename-ident.js';
import { tokenizeComponentExprs, resolveParams } from '../src/scene/params.js';
import { solveLayout } from '../src/scene/solver.js';
import { generateHfssNative } from '../src/export/hfss-native.js';
import { generatePyAEDT } from '../src/export/pyaedt.js';
import { generateGDS } from '../src/export/gds.js';
import {
  FRAGMENT_KINDS, normalizeFragment, validateFragment, buildSystemPrompt,
} from '../src/ai/assistant.js';

// Shared fixture: blank scene + one electrode + one bridge snapped to it,
// with a parametric rotation. Mirrors the export-smoke used during
// development so every assertion runs on the same solved geometry.
function bridgeScene({ hCond = null, rotation = '30', withSnap = true, pad = null } = {}) {
  const s = makeBlankScene();
  if (hCond != null) s.params.h_cond = { expr: String(hCond), unit: 'µm', desc: '' };
  s.params.br_L = { expr: '30', unit: 'µm', desc: '' };
  s.params.br_W = { expr: '10', unit: 'µm', desc: '' };
  s.params.br_H = { expr: '3', unit: 'µm', desc: '' };
  if (pad != null) s.params.br_P = { expr: String(pad), unit: 'µm', desc: '' };
  s.components.push({ id: 'el1', kind: 'rect', layer: 'electrode', cx: 0, cy: 0, w: '40', h: '20', cutouts: [], transforms: [] });
  s.components.push({
    id: 'br1', kind: 'bridge', cx: 100, cy: 50,
    length: 'br_L', width: 'br_W', height: 'br_H',
    ...(pad != null ? { padLength: 'br_P' } : {}),
    ...(rotation != null ? { rotation } : {}),
  });
  const scene = normalizeScene(s);
  if (withSnap) {
    scene.snaps.push({ id: 'sn1', from: { compId: 'el1', anchor: 'E' }, to: { compId: 'br1', anchor: 'W' }, dx: '5', dy: '0' });
  }
  return scene;
}

// ── Schema normalization ────────────────────────────────────────────────

describe('normalizeScene bridge fields (D7)', () => {
  it('fills defaults: length/width/height/thickness, layer, derived AABB, cutouts', () => {
    const s = normalizeScene({
      params: {},
      components: [{ id: 'b1', kind: 'bridge', cx: 0, cy: 0 }],
      snaps: [],
    });
    const b1 = s.components.find(c => c.id === 'b1');
    expect(b1.length).toBe('30');
    expect(b1.width).toBe('10');
    expect(b1.height).toBe('3');
    expect(b1.thickness).toBe(''); // '' = use the conductor layer's thickness
    expect(b1.layer).toBe('bridge');
    expect(b1.w).toBe('(30)');
    expect(b1.h).toBe('(10)');
    expect(Array.isArray(b1.cutouts)).toBe(true);
  });
  it('coerces numeric fields to strings and derives AABB only when missing/zero', () => {
    const s = normalizeScene({
      params: {},
      components: [{
        id: 'b1', kind: 'bridge', cx: 0, cy: 0,
        length: 25, width: 8, height: 2.5, thickness: 0.4,
        w: 'my_w', h: '0',
      }],
      snaps: [],
    });
    const b1 = s.components.find(c => c.id === 'b1');
    expect(b1.length).toBe('25');
    expect(b1.width).toBe('8');
    expect(b1.height).toBe('2.5');
    expect(b1.thickness).toBe('0.4');
    expect(b1.w).toBe('my_w');        // explicit w kept
    expect(b1.h).toBe('(8)');         // '0' h re-derived from width
  });
  it('KEEPS rotation but strips zOffset / cornerRadius', () => {
    const s = normalizeScene({
      params: {},
      components: [{ id: 'b1', kind: 'bridge', cx: 0, cy: 0, rotation: 45, zOffset: '2', cornerRadius: '1' }],
      snaps: [],
    });
    const b1 = s.components.find(c => c.id === 'b1');
    expect(b1.rotation).toBe('45');   // kept (coerced to string)
    expect(b1.zOffset).toBeUndefined();
    expect(b1.cornerRadius).toBeUndefined();
  });
  it('repairs a stale conductorLayerId to the first conductor', () => {
    const s = normalizeScene({
      params: {},
      components: [{ id: 'b1', kind: 'bridge', cx: 0, cy: 0, conductorLayerId: 'l_gone' }],
      snaps: [],
    });
    const b1 = s.components.find(c => c.id === 'b1');
    expect(b1.conductorLayerId).toBe('l_cond'); // default stack's conductor
  });
  it('leaves a valid conductorLayerId untouched and preserves absent binding', () => {
    const s = normalizeScene({
      params: {},
      components: [
        { id: 'b1', kind: 'bridge', cx: 0, cy: 0, conductorLayerId: 'l_cond' },
        { id: 'b2', kind: 'bridge', cx: 10, cy: 0 },
      ],
      snaps: [],
    });
    expect(s.components.find(c => c.id === 'b1').conductorLayerId).toBe('l_cond');
    expect(s.components.find(c => c.id === 'b2').conductorLayerId).toBeUndefined();
  });
});

// ── Ring fallback (plan step 3: rect fallback catches 'bridge') ─────────

describe('bridge ring falls back to the footprint rect', () => {
  it('returns the 4-corner length × width rect', () => {
    const ring = shapeInstanceToRing({ kind: 'bridge', cx: 5, cy: -2, w: 30, h: 10 });
    expect(ring).toHaveLength(4);
    const xs = ring.map(p => p[0]);
    const ys = ring.map(p => p[1]);
    expect(Math.min(...xs)).toBeCloseTo(5 - 15, 9);
    expect(Math.max(...xs)).toBeCloseTo(5 + 15, 9);
    expect(Math.min(...ys)).toBeCloseTo(-2 - 5, 9);
    expect(Math.max(...ys)).toBeCloseTo(-2 + 5, 9);
  });
  it('rotation is baked into the fallback ring', () => {
    const ring = shapeInstanceToRing({ kind: 'bridge', cx: 0, cy: 0, w: 30, h: 10, rotation: 90 });
    const xs = ring.map(p => p[0]);
    const ys = ring.map(p => p[1]);
    expect(Math.max(...xs)).toBeCloseTo(5, 6);
    expect(Math.max(...ys)).toBeCloseTo(15, 6);
  });
});

// ── expandTransforms field propagation + rotation seed ──────────────────

describe('expandTransforms bridge fields', () => {
  const comp = {
    id: 'b1', kind: 'bridge', layer: 'bridge', cx: 0, cy: 0,
    length: 'br_L', width: 'br_W', height: 'br_H', thickness: 'br_T',
    w: '(br_L)', h: '(br_W)', cutouts: [], transforms: [],
  };
  const pv = { br_L: 30, br_W: 10, br_H: 3, br_T: 0.5 };
  it('propagates numeric length/width/height/thickness onto instances', () => {
    const [inst] = expandTransforms([comp], pv);
    expect(inst.kind).toBe('bridge');
    expect(inst.length).toBeCloseTo(30, 9);
    expect(inst.width).toBeCloseTo(10, 9);
    expect(inst.height).toBeCloseTo(3, 9);
    expect(inst.thickness).toBeCloseTo(0.5, 9);
    expect(inst.w).toBeCloseTo(30, 9);
    expect(inst.h).toBeCloseTo(10, 9);
  });
  it('empty thickness leaves the instance field unset (conductor-layer fallback)', () => {
    const [inst] = expandTransforms([{ ...comp, thickness: '' }], pv);
    expect(inst.thickness).toBeUndefined();
  });
  it('base rotation expression seeds the instance rotation', () => {
    const [inst] = expandTransforms([{ ...comp, rotation: 'br_rot' }], { ...pv, br_rot: 30 });
    expect(inst.rotation).toBeCloseTo(30, 9);
  });
  it('repeat clones carry the bridge fields', () => {
    const insts = expandTransforms([{
      ...comp,
      transforms: [{ id: 't1', kind: 'repeat', enabled: true, n: '2', dx: '50', dy: '0' }],
    }], pv);
    expect(insts).toHaveLength(3);
    for (const inst of insts) {
      expect(inst.length).toBeCloseTo(30, 9);
      expect(inst.height).toBeCloseTo(3, 9);
    }
    expect(insts[2].cx).toBeCloseTo(100, 9);
  });
});

// ── Solver: snap onto bridge anchors via the derived AABB ──────────────

describe('bridge in solveLayout', () => {
  it('snap onto a bridge anchor resolves through the (length)×(width) bbox', () => {
    const comps = [
      { id: 'b1', kind: 'bridge', layer: 'bridge', cx: 0, cy: 0, length: 'br_L', width: 'br_W', height: '3', w: '(br_L)', h: '(br_W)', cutouts: [], transforms: [] },
      { id: 'r1', kind: 'rect', layer: 'electrode', cx: 50, cy: 50, w: '10', h: '10', cutouts: [], transforms: [] },
    ];
    const snaps = [{
      id: 's1',
      from: { compId: 'b1', anchor: 'E' },
      to: { compId: 'r1', anchor: 'W' },
      dx: '0', dy: '0',
    }];
    const solved = solveLayout(comps, snaps, { br_L: 30, br_W: 10 });
    const r1 = solved.find(c => c.id === 'r1');
    // bridge E anchor at x = +15; rect W edge lands there → cx = 15 + 5.
    expect(r1.cx).toBeCloseTo(20, 6);
    expect(r1.cy).toBeCloseTo(0, 6);
  });
});

// ── HFSS native export ──────────────────────────────────────────────────

describe('generateHfssNative bridge emission', () => {
  const scene = bridgeScene();
  const pv = resolveParams(scene.params).values;
  const code = generateHfssNative(scene, pv);
  const brBlock = code.slice(code.indexOf('AIRBRIDGE'), code.indexOf('Non-rect') > 0 ? undefined : code.length);

  it('emits per-shape center set_vars carrying the snap chain', () => {
    expect(code).toMatch(/set_var\("br1_cx", "\(\(0um\) \+ \(\(40um\)\/2\) \+ \(5\)/);
    expect(code).toMatch(/set_var\("br1_cy", /);
  });
  it('emits TWO 3-point Spline profile segments + the up/closing Lines', () => {
    const splines = code.match(/"SegmentType:=", "Spline", "StartIndex:=", 0, "NoOfPoints:=", 3/g) || [];
    expect(splines.length).toBeGreaterThanOrEqual(1);
    expect(code).toMatch(/"SegmentType:=", "Spline", "StartIndex:=", 3, "NoOfPoints:=", 3/);
    expect(code).toMatch(/"SegmentType:=", "Line", "StartIndex:=", 2, "NoOfPoints:=", 2/);
    expect(code).toMatch(/"SegmentType:=", "Line", "StartIndex:=", 5, "NoOfPoints:=", 2/);
  });
  it('profile PLPoints carry the conductor-top Z expression + parametric apex', () => {
    // Take-off Z references the stack's conductor thickness variable…
    expect(code).toMatch(/\["NAME:PLPoint", "X:=", "\(\(br1_cx\)\) - \(\(br_L\)\)\/2", "Y:=", "\(\(br1_cy\)\) - \(\(br_W\)\)\/2", "Z:=", "[^"]*h_cond[^"]*"\]/);
    // …and the apex adds the height expression on top of it.
    expect(code).toMatch(/"Z:=", "[^"]*h_cond[^"]*\(br_H\)[^"]*"\]/);
  });
  it('sweeps along +Y by the PARAMETRIC width expression', () => {
    expect(code).toMatch(/"SweepVectorY:=", "\(br_W\)"/);
  });
  it('is covered + closed (solid strap) with the conductor material', () => {
    expect(brBlock).toMatch(/"IsPolylineCovered:=", True/);
    expect(brBlock).toMatch(/"IsPolylineClosed:=", True/);
    expect(brBlock).toMatch(/MaterialValue[\s\S]{0,40}gold/);
  });
  it('emits the D6 base-rotation sandwich about the parametric center', () => {
    expect(code).toContain('# ===== Base rotation for br1');
    expect(code).toMatch(/"RotateAngle:=", "30deg"/);
  });
  it('documents the vertical-thickness convention', () => {
    expect(code).toContain('measured VERTICALLY');
  });
  it('joins the cladding-subtract tool list (metal bookkeeping)', () => {
    // The strap is carved out of the cladding like any electrode body.
    expect(code).toMatch(/"Tool Parts:=", "[^"]*br1[^"]*"/);
  });
  it('parses as valid Python', () => {
    mkdirSync('tests/out', { recursive: true });
    writeFileSync('tests/out/vitest_bridge_hfss.py', code);
    expect(() => execSync(
      `python3 -c "import ast; ast.parse(open('tests/out/vitest_bridge_hfss.py').read())"`,
      { stdio: 'pipe' }
    )).not.toThrow();
  });
});

describe('generateHfssNative bridge sheet mode (h_cond = 0)', () => {
  const scene = bridgeScene({ hCond: 0, rotation: null, withSnap: false });
  const pv = resolveParams(scene.params).values;
  const code = generateHfssNative(scene, pv);

  it('emits the OPEN 3-point spline centerline (no closed ring)', () => {
    const i = code.indexOf('AIRBRIDGE');
    const block = code.slice(i, i + 3000);
    expect(block).toMatch(/"IsPolylineClosed:=", False/);
    expect(block).toMatch(/"SegmentType:=", "Spline", "StartIndex:=", 0, "NoOfPoints:=", 3/);
  });
  it('adds the bridge to the PEC_sheets impedance boundary objects', () => {
    const m = code.match(/AssignImpedance\(\s*\["NAME:PEC_sheets",\s*"Objects:=", \[([^\]]*)\]/);
    expect(m).toBeTruthy();
    expect(m[1]).toContain('"br1"');
  });
  it('still sweeps by the parametric width', () => {
    expect(code).toMatch(/"SweepVectorY:=", "\(br_W\)"/);
  });
  it('parses as valid Python', () => {
    mkdirSync('tests/out', { recursive: true });
    writeFileSync('tests/out/vitest_bridge_hfss_sheet.py', code);
    expect(() => execSync(
      `python3 -c "import ast; ast.parse(open('tests/out/vitest_bridge_hfss_sheet.py').read())"`,
      { stdio: 'pipe' }
    )).not.toThrow();
  });
});

// ── GDS: footprint BOUNDARY on layer 150 ────────────────────────────────

describe('generateGDS bridge layer', () => {
  it('emits the footprint on GDS layer 150', () => {
    const scene = bridgeScene({ rotation: null, withSnap: false });
    const pv = resolveParams(scene.params).values;
    const out = generateGDS(scene, pv);
    // LAYER record: [len=6][type=0x0d][dt=0x02][value int16]. 150 = 0x0096.
    let found150 = false;
    for (let i = 0; i + 5 < out.length; i++) {
      if (out[i] === 0x00 && out[i + 1] === 0x06 && out[i + 2] === 0x0d && out[i + 3] === 0x02
          && out[i + 4] === 0x00 && out[i + 5] === 0x96) { found150 = true; break; }
    }
    expect(found150).toBe(true);
  });
});

// ── pyAEDT: numeric profile + sweep, parses ─────────────────────────────

describe('generatePyAEDT bridge emission', () => {
  const scene = bridgeScene();
  const pv = resolveParams(scene.params).values;
  const code = generatePyAEDT(scene, pv);
  it('emits the covered profile polyline + sweep_along_vector with the width', () => {
    expect(code).toMatch(/airbridge over/);
    expect(code).toMatch(/create_polyline\(points=\[[^\n]*cover_surface=True, close_surface=True, name="br1"/);
    expect(code).toMatch(/sweep_along_vector\("br1", \["0um", "10\.000um", "0um"\]\)/);
    expect(code).toContain('use the native COM export for parametric tracking');
  });
  it('parses as valid Python', () => {
    mkdirSync('tests/out', { recursive: true });
    writeFileSync('tests/out/vitest_bridge_pyaedt.py', code);
    expect(() => execSync(
      `python3 -c "import ast; ast.parse(open('tests/out/vitest_bridge_pyaedt.py').read())"`,
      { stdio: 'pipe' }
    )).not.toThrow();
  });
});

// ── Rename + tokenize walkers ───────────────────────────────────────────

describe('rename / tokenize coverage (bridge)', () => {
  it('renameIdentInScene rewrites bridge length/width/height/thickness', () => {
    const scene = {
      params: { br_L: { expr: '30', unit: 'µm' } },
      components: [{
        id: 'b1', kind: 'bridge', layer: 'bridge', cx: 0, cy: 0,
        length: 'br_L', width: 'br_L/3', height: 'br_L/10', thickness: 'br_L/60',
        w: '(br_L)', h: '(br_L/3)', cutouts: [], transforms: [],
      }],
      snaps: [], stack: [],
    };
    const out = renameIdentInScene(scene, 'br_L', 'span');
    const b1 = out.components[0];
    expect(b1.length).toBe('span');
    expect(b1.width).toBe('span/3');
    expect(b1.height).toBe('span/10');
    expect(b1.thickness).toBe('span/60');
    expect(b1.w).toBe('(span)');
  });
  it('tokenizeComponentExprs sees bridge identifiers', () => {
    const idents = tokenizeComponentExprs({
      id: 'b1', kind: 'bridge', w: '(br_L)', h: '(br_W)',
      length: 'br_L', width: 'br_W', height: 'br_H', thickness: 'br_T',
    });
    expect(idents).toContain('br_L');
    expect(idents).toContain('br_W');
    expect(idents).toContain('br_H');
    expect(idents).toContain('br_T');
  });
  it('padLength is covered by BOTH walkers (rename rewrites; tokenizer sees the pad param)', () => {
    // The insert path seeds `<id>_P` referenced ONLY by padLength — if the
    // walkers miss it, param rename orphans the field and "clean up unused
    // params" deletes the param (pads silently vanish everywhere).
    const scene = {
      params: { br_P: { expr: '5', unit: 'µm' } },
      components: [{
        id: 'b1', kind: 'bridge', layer: 'bridge', cx: 0, cy: 0,
        length: '30', width: '10', height: '3', padLength: 'br_P',
        w: '(30)', h: '(10)', cutouts: [], transforms: [],
      }],
      snaps: [], stack: [],
    };
    const out = renameIdentInScene(scene, 'br_P', 'pad_len');
    expect(out.components[0].padLength).toBe('pad_len');
    const idents = tokenizeComponentExprs(scene.components[0]);
    expect(idents).toContain('br_P');
  });
});

// ── AI assistant registration ───────────────────────────────────────────

describe('AI assistant knows the bridge kind', () => {
  it('FRAGMENT_KINDS includes bridge and the system prompt documents it', () => {
    expect(FRAGMENT_KINDS).toContain('bridge');
    const sys = buildSystemPrompt(makeBlankScene(), 'ai1', {});
    expect(sys).toContain('"bridge"');
    expect(sys).toContain('AIRBRIDGE');
  });
  it('normalizeFragment derives the bridge AABB and forces the layer', () => {
    const f = normalizeFragment({
      components: [{ id: 'a_b', kind: 'bridge', layer: 'electrode', cx: 0, cy: 0, length: 30, width: 10, height: 3 }],
    });
    const c = f.components[0];
    expect(c.layer).toBe('bridge');
    expect(c.length).toBe('30');
    expect(c.w).toBe('(30)');
    expect(c.h).toBe('(10)');
  });
  it('validateFragment accepts a well-formed bridge', () => {
    const scene = makeBlankScene();
    const f = normalizeFragment({
      params: [{ name: 'ai1_L', expr: '30', unit: 'um', desc: '' }],
      components: [{ id: 'ai1_br', kind: 'bridge', layer: 'bridge', cx: 0, cy: 0, length: 'ai1_L', width: '10', height: '3' }],
      snaps: [],
    });
    const { errors } = validateFragment(f, scene);
    expect(errors).toEqual([]);
  });
  it('validateFragment rejects a bridge missing height', () => {
    const scene = makeBlankScene();
    const f = normalizeFragment({
      components: [{ id: 'ai1_br', kind: 'bridge', layer: 'bridge', cx: 0, cy: 0, length: '30', width: '10' }],
    });
    const { errors } = validateFragment(f, scene);
    expect(errors.some(e => e.includes('missing required field "height"'))).toBe(true);
  });
  it('validateFragment expression-checks padLength (unknown ident blocks, valid passes)', () => {
    const scene = makeBlankScene();
    const bad = normalizeFragment({
      components: [{ id: 'ai1_br', kind: 'bridge', layer: 'bridge', cx: 0, cy: 0, length: '30', width: '10', height: '3', padLength: 'ai1_missing_pad' }],
    });
    const { errors } = validateFragment(bad, scene);
    expect(errors.some(e => e.includes('padLength') || e.includes('ai1_missing_pad'))).toBe(true);
    const ok = normalizeFragment({
      params: [{ name: 'ai1_pad', expr: '5', unit: 'um', desc: '' }],
      components: [{ id: 'ai1_br', kind: 'bridge', layer: 'bridge', cx: 0, cy: 0, length: '30', width: '10', height: '3', padLength: 'ai1_pad' }],
      snaps: [],
    });
    expect(validateFragment(ok, scene).errors).toEqual([]);
    // Numeric padLength from the model is string-coerced by normalizeFragment.
    const num = normalizeFragment({
      components: [{ id: 'ai1_br', kind: 'bridge', layer: 'bridge', cx: 0, cy: 0, length: '30', width: '10', height: '3', padLength: 5 }],
    });
    expect(num.components[0].padLength).toBe('5');
  });
});

// ── Landing pads (padLength) ────────────────────────────────────────────

describe('bridge landing pads (padLength)', () => {
  it('normalizeScene defaults padLength to "0" and coerces numerics', () => {
    const s = normalizeScene({
      params: {},
      components: [
        { id: 'b1', kind: 'bridge', cx: 0, cy: 0 },
        { id: 'b2', kind: 'bridge', cx: 0, cy: 0, padLength: 5 },
      ],
      snaps: [],
    });
    expect(s.components.find(c => c.id === 'b1').padLength).toBe('0');
    expect(s.components.find(c => c.id === 'b2').padLength).toBe('5');
  });

  it('expandTransforms propagates a numeric padLength per instance (0 when blank/invalid)', () => {
    const scene = bridgeScene({ pad: 5, rotation: null, withSnap: false });
    const pv = resolveParams(scene.params).values;
    const [inst] = expandTransforms(scene.components.filter(c => c.id === 'br1'), pv);
    expect(inst.padLength).toBe(5);
    const scene0 = bridgeScene({ rotation: null, withSnap: false });
    const [inst0] = expandTransforms(scene0.components.filter(c => c.id === 'br1'), resolveParams(scene0.params).values);
    expect(inst0.padLength).toBe(0);
  });

  it('HFSS solid profile grows pad points + Line segments, all PARAMETRIC in br_P', () => {
    const scene = bridgeScene({ pad: 5 });
    const pv = resolveParams(scene.params).values;
    const code = generateHfssNative(scene, pv);
    // Pad tips extend the span by the parametric pad expression…
    expect(code).toMatch(/"X:=", "\(\(br1_cx\)\) - \(\(br_L\)\)\/2 - \(\(br_P\)\)"/);
    expect(code).toMatch(/"X:=", "\(\(br1_cx\)\) \+ \(\(br_L\)\)\/2 \+ \(\(br_P\)\)"/);
    // …with the 11-point / 8-segment profile (2 splines + 6 lines).
    const i = code.indexOf('AIRBRIDGE');
    const block = code.slice(i, i + 5000);
    const splines = block.match(/"SegmentType:=", "Spline"/g) || [];
    const lines = block.match(/"SegmentType:=", "Line"/g) || [];
    expect(splines.length).toBe(2);
    expect(lines.length).toBe(6);
    expect(block).toContain('Landing pads');
    // Still parses as Python.
    mkdirSync('tests/out', { recursive: true });
    writeFileSync('tests/out/vitest_bridge_pads_hfss.py', code);
    expect(() => execSync(
      `python3 -c "import ast; ast.parse(open('tests/out/vitest_bridge_pads_hfss.py').read())"`,
      { stdio: 'pipe' }
    )).not.toThrow();
  });

  it('padLength "0" / absent emits the EXACT pre-pad profile (no pad points, 7-point ring)', () => {
    const scene = bridgeScene();
    const pv = resolveParams(scene.params).values;
    const code = generateHfssNative(scene, pv);
    expect(code).not.toContain('Landing pads');
    const i = code.indexOf('AIRBRIDGE');
    const block = code.slice(i, i + 5000);
    expect((block.match(/"SegmentType:=", "Line"/g) || []).length).toBe(2);
  });

  it('HFSS sheet mode (h_cond = 0) gains flat pad Line segments around the open spline', () => {
    const scene = bridgeScene({ hCond: 0, rotation: null, withSnap: false, pad: 4 });
    const pv = resolveParams(scene.params).values;
    const code = generateHfssNative(scene, pv);
    const i = code.indexOf('AIRBRIDGE');
    const block = code.slice(i, i + 4000);
    expect(block).toMatch(/"IsPolylineClosed:=", False/);
    expect(block).toMatch(/"SegmentType:=", "Line", "StartIndex:=", 0, "NoOfPoints:=", 2/);
    expect(block).toMatch(/"SegmentType:=", "Spline", "StartIndex:=", 1, "NoOfPoints:=", 3/);
    expect(block).toMatch(/"SegmentType:=", "Line", "StartIndex:=", 3, "NoOfPoints:=", 2/);
    // Still joins the PEC_sheets boundary.
    const m = code.match(/AssignImpedance\(\s*\["NAME:PEC_sheets",\s*"Objects:=", \[([^\]]*)\]/);
    expect(m).toBeTruthy();
    expect(m[1]).toContain('"br1"');
  });

  it('pyAEDT profile prepends/appends flat pad points at the conductor top', () => {
    const scene = bridgeScene({ pad: 5, rotation: null, withSnap: false });
    const pv = resolveParams(scene.params).values;
    const code = generatePyAEDT(scene, pv);
    expect(code).toContain('Landing pads: flat 5.000 um strap extensions');
    // br1 at cx=100, L=30, P=5 → pad tips at x = 80 and 120.
    expect(code).toMatch(/create_polyline\(points=\[\["80\.000um"/);
    expect(code).toContain('["120.000um"');
    mkdirSync('tests/out', { recursive: true });
    writeFileSync('tests/out/vitest_bridge_pads_pyaedt.py', code);
    expect(() => execSync(
      `python3 -c "import ast; ast.parse(open('tests/out/vitest_bridge_pads_pyaedt.py').read())"`,
      { stdio: 'pipe' }
    )).not.toThrow();
  });

  it('GDS layer-150 footprint spans length + 2*padLength', () => {
    const scene = bridgeScene({ pad: 5, rotation: null, withSnap: false });
    const pv = resolveParams(scene.params).values;
    const out = generateGDS(scene, pv);
    // Find the layer-150 BOUNDARY, then read its XY record (int32 nm).
    let idx = -1;
    for (let i = 0; i + 5 < out.length; i++) {
      if (out[i] === 0x00 && out[i + 1] === 0x06 && out[i + 2] === 0x0d && out[i + 3] === 0x02
          && out[i + 4] === 0x00 && out[i + 5] === 0x96) { idx = i; break; }
    }
    expect(idx).toBeGreaterThan(-1);
    // Records: LAYER(6) DATATYPE(6) then XY: [len][0x10][0x03][pairs…].
    const xyStart = idx + 12;
    expect(out[xyStart + 2]).toBe(0x10);
    const xyLen = (out[xyStart] << 8) | out[xyStart + 1];
    const dv = new DataView(out.buffer, out.byteOffset + xyStart + 4, xyLen - 4);
    const xs = [];
    for (let o = 0; o < dv.byteLength; o += 8) xs.push(dv.getInt32(o) / 1000);
    const spanX = Math.max(...xs) - Math.min(...xs);
    expect(spanX).toBeCloseTo(30 + 2 * 5, 3); // L + 2P
  });
});
