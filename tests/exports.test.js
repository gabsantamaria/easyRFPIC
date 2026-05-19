// Smoke tests for the three exporters. Each runs the default scene
// through the exporter and checks for a few load-bearing strings /
// counts, then validates the Python outputs parse.
import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import { writeFileSync, mkdirSync } from 'fs';
import { generateGDS } from '../src/export/gds.js';
import { generatePyAEDT } from '../src/export/pyaedt.js';
import { generateHfssNative } from '../src/export/hfss-native.js';
import { makeDefaultScene } from '../src/scene/schema.js';
import { resolveParams } from '../src/scene/params.js';

const scene = makeDefaultScene();
const { values } = resolveParams(scene.params);

describe('generateGDS', () => {
  it('returns a non-empty binary buffer with the GDS HEADER record', () => {
    const out = generateGDS(scene, values);
    expect(out).toBeInstanceOf(Uint8Array);
    expect(out.byteLength).toBeGreaterThan(100);
    // First record: HEADER (type 0x00, dataType 0x02 INT2). Bytes 2..3.
    expect(out[2]).toBe(0x00);
    expect(out[3]).toBe(0x02);
  });
});

describe('generatePyAEDT', () => {
  const code = generatePyAEDT(scene, values);
  it('is a non-trivial Python source', () => {
    expect(code.length).toBeGreaterThan(500);
    expect(code).toContain('from ansys.aedt.core import Hfss');
    expect(code).toContain('hfss = Hfss');
  });
  it('parses as valid Python', () => {
    mkdirSync('tests/out', { recursive: true });
    writeFileSync('tests/out/vitest_pyaedt.py', code);
    expect(() => execSync(
      `python3 -c "import ast; ast.parse(open('tests/out/vitest_pyaedt.py').read())"`,
      { stdio: 'pipe' }
    )).not.toThrow();
  });
});

describe('generateHfssNative', () => {
  const code = generateHfssNative(scene, values);
  it('is a non-trivial Python source using ScriptEnv', () => {
    expect(code.length).toBeGreaterThan(500);
    expect(code).toContain('import ScriptEnv');
    expect(code).toContain('oEditor');
  });
  it('parses as valid Python', () => {
    mkdirSync('tests/out', { recursive: true });
    writeFileSync('tests/out/vitest_hfss.py', code);
    expect(() => execSync(
      `python3 -c "import ast; ast.parse(open('tests/out/vitest_hfss.py').read())"`,
      { stdio: 'pipe' }
    )).not.toThrow();
  });

  it('boolean parent passes parametric chain through to its base operand', () => {
    // A child snapped to a boolean's anchor must inherit the boolean's
    // parametric chain — NOT a frozen numeric snapshot. For subtract /
    // intersect / punch booleans the bbox is the base operand's bbox,
    // so the child's chain expression should reach back through the
    // base operand's own parametric chain (and thus track every
    // parameter that feeds it). The earlier regression: changing a
    // slab-related variable in HFSS shifted the boolean's operands but
    // left the child stranded because the child's chain had numeric
    // literals for the boolean's cx / w.
    const s = {
      params: {
        gap_p: { expr: '7' },
        feed_w: { expr: '3' },
        child_w: { expr: '15' },
      },
      components: [
        // A primitive whose POSITION depends on a parameter (gap_p).
        { id: 'leaf', kind: 'rect', layer: 'electrode', cx: 100, cy: 0, w: 'feed_w', h: '4', cutouts: [] },
        // A primitive snapped to `leaf` with a gap_p offset, then
        // consumed by a punch boolean.
        { id: 'op', kind: 'rect', layer: 'electrode', cx: 90, cy: 0, w: 'feed_w', h: '4', cutouts: [], consumedBy: 'pb' },
        { id: 'tool', kind: 'rect', layer: 'electrode', cx: 90, cy: 0, w: '1', h: '1', cutouts: [], consumedBy: 'pb' },
        {
          id: 'pb', kind: 'boolean', op: 'punch', operandIds: ['op', 'tool'],
          layer: 'electrode', cx: 90, cy: 0, w: '0', h: '0', cutouts: [],
        },
        // The child rect — snapped to the boolean's W anchor. Its
        // chain must reach all the way back through op → leaf so
        // gap_p still controls its position.
        { id: 'child', kind: 'rect', layer: 'electrode', cx: 70, cy: 0, w: 'child_w', h: '2', cutouts: [] },
      ],
      snaps: [
        // op's NW pins to leaf.SW with a gap_p offset — gap_p in chain.
        { id: 's_op', from: { compId: 'leaf', anchor: 'W' }, to: { compId: 'op', anchor: 'E' }, dx: '-gap_p', dy: '0' },
        // child snapped to the boolean's W.
        { id: 's_child', from: { compId: 'pb', anchor: 'W' }, to: { compId: 'child', anchor: 'E' }, dx: '0', dy: '0' },
      ],
      mirrors: [], groups: [], booleans: [],
      stack: scene.stack, stackName: scene.stackName, simSetup: scene.simSetup,
    };
    const { values: pv } = resolveParams(s.params);
    const out = generateHfssNative(s, pv);
    const nameIdx = out.indexOf('"Name:=", "child"');
    expect(nameIdx).toBeGreaterThan(0);
    const blockStart = out.lastIndexOf('safe_create_', nameIdx);
    const block = out.slice(blockStart, nameIdx);
    const xStart = block.match(/XStart:=", "([^"]+)"/)[1];
    // The child's XStart must reference `gap_p` (proving the chain
    // walked through the boolean's base operand). The earlier bug
    // would leave a numeric `(<solved-cx>um)` instead.
    expect(xStart).toContain('gap_p');
    // And must reference the LEAF's w/h variables (feed_w from `op`),
    // confirming we're passing parametric w/h up through the boolean,
    // not the boolean's solved numeric AABB.
    expect(xStart).toContain('feed_w');
  });

  it('tags boolean-parent numeric w/h with "um" in snap-chain offsets', () => {
    // When a primitive is snapped to a BOOLEAN parent, the parent's w/h
    // is a number written by resolveBooleanBboxes (e.g. 8). Embedding
    // that bare number in the offset expression as just `(8)` causes
    // HFSS to interpret it in the design's base unit (meters) rather
    // than µm, throwing the child off by millions of µm. The boolean's
    // numeric w/h MUST be emitted as `(8um)` inside the snap-chain
    // offset.
    const s = {
      params: { feed_w: { expr: '15' } },
      components: [
        // Two rects unioned into a boolean — its solved w ends up
        // numeric (= operand AABB width), which is the failure mode
        // this test guards.
        { id: 'a', kind: 'rect', layer: 'electrode', cx: 0, cy: 0, w: '3', h: '3', cutouts: [], consumedBy: 'b' },
        { id: 'c', kind: 'rect', layer: 'electrode', cx: 5, cy: 0, w: '3', h: '3', cutouts: [], consumedBy: 'b' },
        {
          id: 'b', kind: 'boolean', op: 'union', operandIds: ['a', 'c'],
          layer: 'electrode', cx: 2.5, cy: 0, w: '0', h: '0', cutouts: [],
        },
        // Child rect snapped to b.W → its parametric chain references b.w/2.
        { id: 'child', kind: 'rect', layer: 'electrode', cx: -10, cy: 0, w: 'feed_w', h: '1', cutouts: [] },
      ],
      snaps: [
        { id: 's1', from: { compId: 'b', anchor: 'W' }, to: { compId: 'child', anchor: 'E' }, dx: '0', dy: '0' },
      ],
      mirrors: [], groups: [], booleans: [],
      stack: scene.stack, stackName: scene.stackName, simSetup: scene.simSetup,
    };
    const { values: pv } = resolveParams(s.params);
    const out = generateHfssNative(s, pv);
    // Locate the safe_create_rectangle / box block whose Attributes
    // name the child component. Scan backward from that name to the
    // preceding safe_create_… opener so we don't accidentally pull
    // some earlier component's XStart.
    const nameIdx = out.indexOf('"Name:=", "child"');
    expect(nameIdx).toBeGreaterThan(0);
    const blockStart = out.lastIndexOf('safe_create_', nameIdx);
    expect(blockStart).toBeGreaterThan(0);
    const block = out.slice(blockStart, nameIdx);
    const xStartMatch = block.match(/XStart:=", "([^"]+)"/);
    expect(xStartMatch).toBeTruthy();
    const xStart = xStartMatch[1];
    // The chain must compose b's bbox from its operand widths, with
    // every bare-numeric term tagged with "um". The exporter now
    // expresses the bbox parametrically as a difference of operand
    // edge expressions (e.g. `((5um) + (3um)/2) - ((0um) - (3um)/2)`),
    // which is even tighter than the previous `(8um)/2` because it
    // also tracks individual operand parameter sweeps. Either form
    // (parametric expansion OR literal `(8um)`) is acceptable —
    // what matters is that EVERY numeric width division has a unit.
    // A bare `(8)/2` or `(3)/2` would be dimensionless (= the bug).
    expect(xStart).not.toMatch(/\((?:[0-9]+(?:\.[0-9]+)?)\)\s*\/\s*2/);
    // And the operand widths (3 each) should show up with units in
    // the bbox expression — confirming we're using the parametric
    // form, not freezing at the numeric AABB.
    expect(xStart).toMatch(/3um|8um/);
  });

  it('emits conductor sheets + near-PEC AssignImpedance when conductor thickness is 0', () => {
    // When h_cond = 0, every electrode should be a 2-D rectangle sheet
    // rather than a 3-D box, and a single AssignImpedance boundary
    // (R=0.001, X=0 Ω/sq) should cover all of them. R=0 exactly is
    // rejected as singular by some HFSS releases — 1 mΩ/sq is a
    // numerically-stable near-PEC surrogate.
    const zeroScene = {
      ...scene,
      params: { ...scene.params, h_cond: { ...(scene.params.h_cond || {}), expr: '0' } },
    };
    const { values: pv } = resolveParams(zeroScene.params);
    const out = generateHfssNative(zeroScene, pv);
    // Electrode sheets are CreateRectangle, not CreateBox.
    const rectCount = (out.match(/safe_create_rectangle/g) || []).length;
    expect(rectCount).toBeGreaterThan(0);
    // Impedance boundary block with R=0.001 (near-PEC), X=0.
    expect(out).toContain('AssignImpedance');
    expect(out).toMatch(/"Resistance:=", "0\.001"/);
    expect(out).toMatch(/"Reactance:=", "0"/);
    // Boundary's object list mentions each default-scene electrode
    // by name. We pick the names dynamically from the loaded scene
    // so the test stays correct when the canonical default scene is
    // refreshed (it's a JSON asset, not source code).
    const electrodes = scene.components.filter(c => c.layer === 'electrode').map(c => c.id);
    expect(electrodes.length).toBeGreaterThan(0);
    for (const id of electrodes) {
      expect(out).toMatch(new RegExp(`"${id}"`));
    }
  });

  it('Subtract on an operand with repeat lists ALL clones as Blank Parts', () => {
    // Regression: a primitive with a repeat transform that becomes the
    // base operand of a Subtract used to lose its clones — only the
    // base instance got the tool subtracted; A_1, A_2, A_3 survived
    // un-cut. Fix: the Subtract's "Blank Parts" enumerates every name
    // the per-primitive transform chain produced, so HFSS's multi-
    // blank Subtract applies the tool to each clone independently.
    const condLayerId = scene.stack.find(l => l.role === 'conductor')?.id;
    const minimal = {
      params: { h_cond: { expr: '0.5' }, h_wg: { expr: '0.3' } },
      components: [
        { id: 'A', kind: 'rect', layer: 'electrode', conductorLayerId: condLayerId,
          cx: 0, cy: 0, w: 20, h: 20, cutouts: [],
          transforms: [{ id: 't1', kind: 'repeat', enabled: true, n: 3, dx: 30, dy: 0, includeOriginal: true }],
          consumedBy: 'BOOL' },
        { id: 'B', kind: 'rect', layer: 'electrode', conductorLayerId: condLayerId,
          cx: 30, cy: 0, w: 10, h: 10, cutouts: [], transforms: [], consumedBy: 'BOOL' },
        { id: 'BOOL', kind: 'boolean', op: 'subtract', operandIds: ['A', 'B'],
          layer: 'electrode', conductorLayerId: condLayerId,
          cx: 0, cy: 0, w: '0', h: '0', cutouts: [], transforms: [] },
      ],
      snaps: [], mirrors: [], groups: [], booleans: [],
      stack: scene.stack, stackName: scene.stackName, simSetup: scene.simSetup,
    };
    const { values: pv } = resolveParams(minimal.params);
    const out = generateHfssNative(minimal, pv);
    // Find the Subtract call and inspect its Blank Parts list.
    const subMatch = out.match(/oEditor\.Subtract\(\s*\["NAME:Selections",\s*"Blank Parts:=",\s*"([^"]+)",\s*"Tool Parts:=",\s*"([^"]+)"/);
    expect(subMatch).not.toBeNull();
    const blanks = subMatch[1].split(',');
    const tools = subMatch[2].split(',');
    // Operand A has repeat n=3 + includeOriginal → 4 instances total.
    expect(blanks).toEqual(['A', 'A_1', 'A_2', 'A_3']);
    expect(tools).toEqual(['B']);
  });

  it('predicts HFSS collision-resolved clone names for repeat→mirror→repeat', () => {
    // After DuplicateAlongLine creates `m_1..m_9`, DuplicateMirror must
    // NOT name the new clone of `m` as `m_1` (collision). HFSS picks the
    // next available suffix per base — so the mirror clone of `m` is
    // `m_10`. The third op's selection must reference `m_10`, not a
    // duplicated `m_1`. Without this, downstream transforms operate on
    // the wrong set of objects and the final geometry is missing clones.
    const minimal = {
      params: { N: { expr: '10' }, off: { expr: '20' }, dy3: { expr: '-30' } },
      components: [
        { id: 'a', kind: 'rect', layer: 'electrode', cx: 0, cy: 0, w: '5', h: '5', cutouts: [], consumedBy: 'm' },
        { id: 'b', kind: 'rect', layer: 'electrode', cx: 8, cy: 0, w: '5', h: '5', cutouts: [], consumedBy: 'm' },
        {
          id: 'm', kind: 'boolean', op: 'union', operandIds: ['a', 'b'],
          layer: 'electrode', cx: 4, cy: 0, w: '0', h: '0', cutouts: [],
          transforms: [
            { id: 't1', kind: 'repeat', enabled: true, n: 'N - 1', dx: '10', dy: '0', includeOriginal: true },
            { id: 't2', kind: 'duplicate_mirror', enabled: true, axis: 'y', offset: 'off', includeOriginal: true },
            { id: 't3', kind: 'repeat', enabled: true, n: '1', dx: '0', dy: 'dy3', includeOriginal: true },
          ],
        },
      ],
      snaps: [], mirrors: [], groups: [], booleans: [],
      stack: scene.stack, stackName: scene.stackName, simSetup: scene.simSetup,
    };
    const { values: pv } = resolveParams(minimal.params);
    const out = generateHfssNative(minimal, pv);
    // Find the DuplicateAlongLine that comes AFTER DuplicateMirror.
    const mirrorIdx = out.indexOf('DuplicateMirror');
    expect(mirrorIdx).toBeGreaterThan(0);
    const dupCalls = [...out.matchAll(/DuplicateAlongLine\([\s\S]*?\)\n/g)].map(m => m[0]);
    const afterMirror = dupCalls.find(c => out.indexOf(c) > mirrorIdx);
    expect(afterMirror).toBeDefined();
    // Must include `m_10` — the actual HFSS-allocated name for the
    // mirror clone of `m` when `m_1..m_9` already exist.
    expect(afterMirror).toContain('m_10');
    // Must NOT have any duplicate names in the selection list.
    const sel = afterMirror.match(/Selections:=", "([^"]+)"/)[1];
    const names = sel.split(',');
    expect(new Set(names).size).toBe(names.length);
  });
});
