// D6 (first-class rotation) + D5 (per-component zOffset) coverage.
//
// Rotation: rect/circle/ellipse/polygon may carry an optional `rotation`
// expression (degrees, CCW). It must flow through the WHOLE pipeline:
// expandTransforms seeds the instance rotation → rings rotate → anchors
// (anchorWorld / solver toLocal) rotate → the HFSS export emits the
// rotation EXPRESSION as "(<expr>)*1deg" and wraps snap-chain anchor
// offsets in the HFSS-trig rotation matrix.
//
// zOffset: optional µm expression shifting a part's Z relative to its
// layer. Every component Z-placement site in the native HFSS export must
// gain "+ (<expr>)um".
import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import { writeFileSync, mkdirSync } from 'fs';
import { expandTransforms } from '../src/scene/transforms.js';
import { shapeInstanceToRing } from '../src/geometry/rings.js';
import { anchorWorld, anchorLocalRotated, compRotationDeg } from '../src/scene/anchors.js';
import { solveLayout } from '../src/scene/solver.js';
import { renameIdentInScene } from '../src/scene/rename-ident.js';
import { tokenizeComponentExprs } from '../src/scene/params.js';
import { normalizeScene, makeDefaultScene, paramsForStack } from '../src/scene/schema.js';
import { resolveParams } from '../src/scene/params.js';
import { generateHfssNative, hfssAngleDegExpr, componentRotationExpr } from '../src/export/hfss-native.js';
import { generatePyAEDT } from '../src/export/pyaedt.js';

const defaultScene = makeDefaultScene();

// Minimal scene factory: electrode rects on the default stack. Stack
// thickness params (h_cond, h_wg, …) get their nominal defaults so layer
// Z math behaves like a real design (explicit `params` win).
const mkScene = (components, snaps = [], params = {}) => ({
  params: { ...paramsForStack(defaultScene.stack), ...params },
  components,
  snaps,
  mirrors: [], groups: [], booleans: [],
  stack: defaultScene.stack,
  stackName: defaultScene.stackName,
  simSetup: defaultScene.simSetup,
});

describe('D6: first-class rotation — transforms / rings / anchors / solver', () => {
  it('seeds the base instance rotation from c.rotation and composes with chain rotates', () => {
    const c = {
      id: 'r1', kind: 'rect', layer: 'electrode', cx: 10, cy: 5,
      w: '20', h: '10', cutouts: [], rotation: 'tilt',
      transforms: [{ id: 't1', kind: 'rotate', enabled: true, angle: '15', pivot: 'C' }],
    };
    const insts = expandTransforms([c], { tilt: 30 });
    expect(insts).toHaveLength(1);
    // Base rotation 30 + chain rotate 15 = 45 (rotates ADD).
    expect(insts[0].rotation).toBeCloseTo(45, 9);
    // Position unchanged (both rotations are about the shape's center).
    expect(insts[0].cx).toBeCloseTo(10, 9);
    expect(insts[0].cy).toBeCloseTo(5, 9);
  });

  it('rotated rect ring has rotated corners (numeric)', () => {
    const c = {
      id: 'r1', kind: 'rect', layer: 'electrode', cx: 0, cy: 0,
      w: '20', h: '10', cutouts: [], rotation: '90', transforms: [],
    };
    const [inst] = expandTransforms([c], {});
    const ring = shapeInstanceToRing(inst);
    expect(ring).toHaveLength(4);
    // 90° CCW: local corner (-10, -5) → (5, -10)
    expect(ring[0][0]).toBeCloseTo(5, 6);
    expect(ring[0][1]).toBeCloseTo(-10, 6);
    // local corner (10, -5) → (5, 10)
    expect(ring[1][0]).toBeCloseTo(5, 6);
    expect(ring[1][1]).toBeCloseTo(10, 6);
    // AABB of the rotated rect is 10 wide × 20 tall.
    const xs = ring.map(p => p[0]);
    const ys = ring.map(p => p[1]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(10, 6);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(20, 6);
  });

  it('anchorWorld rotates the local anchor offset', () => {
    const comp = { id: 'a', kind: 'rect', cx: 0, cy: 0, w: '20', h: '10', rotation: '90' };
    // Unrotated NE = (10, 5); rotated 90° CCW → (-5, 10).
    const ne = anchorWorld(comp, 'NE', {});
    expect(ne.x).toBeCloseTo(-5, 9);
    expect(ne.y).toBeCloseTo(10, 9);
    // Parametric rotation expression evaluates through paramValues.
    const comp2 = { ...comp, rotation: 'tilt' };
    const e = anchorWorld(comp2, 'E', { tilt: 90 });
    expect(e.x).toBeCloseTo(0, 9);
    expect(e.y).toBeCloseTo(10, 9);
  });

  it('compRotationDeg: booleans and blank/zero rotations return 0', () => {
    expect(compRotationDeg({ kind: 'boolean', rotation: '45' }, {})).toBe(0);
    expect(compRotationDeg({ kind: 'rect' }, {})).toBe(0);
    expect(compRotationDeg({ kind: 'rect', rotation: '0' }, {})).toBe(0);
    expect(compRotationDeg({ kind: 'rect', rotation: '  ' }, {})).toBe(0);
    expect(compRotationDeg({ kind: 'rect', rotation: '45' }, {})).toBe(45);
  });

  it('anchorLocalRotated rotates edge anchors too', () => {
    // T:0 on a 20×10 rect = (-10, 5); rotated 90° → (-5, -10).
    const p = anchorLocalRotated('T:0', 20, 10, 90);
    expect(p.x).toBeCloseTo(-5, 9);
    expect(p.y).toBeCloseTo(-10, 9);
  });

  it('solver places a child snapped to a rotated parent at the ROTATED anchor', () => {
    const parent = {
      id: 'p', kind: 'rect', layer: 'electrode', cx: 0, cy: 0,
      w: '20', h: '10', cutouts: [], rotation: '90', transforms: [],
    };
    const child = {
      id: 'c', kind: 'rect', layer: 'electrode', cx: 100, cy: 100,
      w: '4', h: '4', cutouts: [], transforms: [],
    };
    const snaps = [{ id: 's1', from: { compId: 'p', anchor: 'E' }, to: { compId: 'c', anchor: 'C' }, dx: '0', dy: '0' }];
    const solved = solveLayout([parent, child], snaps, {});
    const sc = solved.find(x => x.id === 'c');
    // Parent's E anchor unrotated = (10, 0); rotated 90° CCW → (0, 10).
    expect(sc.cx).toBeCloseTo(0, 9);
    expect(sc.cy).toBeCloseTo(10, 9);
  });

  it("solver rotates the CHILD's own anchor offset too", () => {
    const parent = {
      id: 'p', kind: 'rect', layer: 'electrode', cx: 0, cy: 0,
      w: '20', h: '10', cutouts: [], transforms: [],
    };
    const child = {
      id: 'c', kind: 'rect', layer: 'electrode', cx: 100, cy: 100,
      w: '8', h: '2', cutouts: [], rotation: '90', transforms: [],
    };
    // Child's W anchor lands on parent's E anchor. Child W unrotated
    // local = (-4, 0); rotated 90° → (0, -4). Parent E = (10, 0).
    // child.center = parentAnchor - rotatedToLocal = (10, 0) - (0, -4) = (10, 4).
    const snaps = [{ id: 's1', from: { compId: 'p', anchor: 'E' }, to: { compId: 'c', anchor: 'W' }, dx: '0', dy: '0' }];
    const solved = solveLayout([parent, child], snaps, {});
    const sc = solved.find(x => x.id === 'c');
    expect(sc.cx).toBeCloseTo(10, 9);
    expect(sc.cy).toBeCloseTo(4, 9);
  });
});

describe('D6: rotation in the native HFSS export', () => {
  it('hfssAngleDegExpr: numeric → "<n>deg", expression → "(<expr>)*1deg"', () => {
    expect(hfssAngleDegExpr('30')).toBe('30deg');
    expect(hfssAngleDegExpr('-12.5')).toBe('-12.5deg');
    expect(hfssAngleDegExpr('tilt')).toBe('(tilt)*1deg');
    expect(hfssAngleDegExpr('tilt + 5')).toBe('(tilt + 5)*1deg');
  });

  it('componentRotationExpr: trivial/boolean → null', () => {
    expect(componentRotationExpr({ kind: 'rect', rotation: 'tilt' })).toBe('tilt');
    expect(componentRotationExpr({ kind: 'rect', rotation: '0' })).toBeNull();
    expect(componentRotationExpr({ kind: 'rect' })).toBeNull();
    expect(componentRotationExpr({ kind: 'boolean', rotation: '45' })).toBeNull();
  });

  it('emits a parametric translate-rotate-translate with "(<expr>)*1deg" for the base rotation', () => {
    const s = mkScene(
      [{
        id: 'rot_box', kind: 'rect', layer: 'electrode', cx: 12, cy: 3,
        w: '20', h: '10', cutouts: [], rotation: 'tilt', transforms: [],
      }],
      [],
      { tilt: { expr: '30', unit: '' } },
    );
    const { values: pv } = resolveParams(s.params);
    const out = generateHfssNative(s, pv);
    expect(out).toContain('Base rotation for rot_box');
    expect(out).toContain('"RotateAngle:=", "(tilt)*1deg"');
    // translate-rotate-translate sandwich (HFSS Rotate spins about world Z).
    const idx = out.indexOf('Base rotation for rot_box');
    const block = out.slice(idx, idx + 1500);
    expect(block).toContain('oEditor.Move(');
    expect(block).toContain('oEditor.Rotate(');
    expect((block.match(/oEditor\.Move\(/g) || []).length).toBeGreaterThanOrEqual(2);
  });

  it('snapped child of a rotated parent: XStart contains cos( and the rotation param', () => {
    const s = mkScene(
      [
        {
          id: 'parent', kind: 'rect', layer: 'electrode', cx: 0, cy: 0,
          w: 'cap_W', h: '10', cutouts: [], rotation: 'tilt', transforms: [],
        },
        {
          id: 'child', kind: 'rect', layer: 'electrode', cx: 30, cy: 0,
          w: '4', h: '4', cutouts: [], transforms: [],
        },
      ],
      [{ id: 's1', from: { compId: 'parent', anchor: 'E' }, to: { compId: 'child', anchor: 'W' }, dx: '0', dy: '0' }],
      { tilt: { expr: '30', unit: '' }, cap_W: { expr: '20', unit: 'µm' } },
    );
    const { values: pv } = resolveParams(s.params);
    const out = generateHfssNative(s, pv);
    const nameIdx = out.indexOf('"Name:=", "child"');
    expect(nameIdx).toBeGreaterThan(0);
    const blockStart = out.lastIndexOf('safe_create_', nameIdx);
    const block = out.slice(blockStart, nameIdx);
    // XStart for 0-thickness sheets, XPosition for 3-D boxes — either
    // way it's the child's parametric X placement expression.
    const xStart = block.match(/X(?:Start|Position):=", "([^"]+)"/)[1];
    // Parent's anchor offset must be wrapped in the rotation matrix:
    // cos/sin of the rotation param, degree-typed.
    expect(xStart).toContain('cos(');
    expect(xStart).toContain('tilt');
    expect(xStart).toContain('*1deg');
    // And still parametric in the parent's width.
    expect(xStart).toContain('cap_W');
    // Y side carries the sin term of the same matrix.
    const yStart = block.match(/Y(?:Start|Position):=", "([^"]+)"/)[1];
    expect(yStart).toContain('sin(');
    expect(yStart).toContain('tilt');
  });

  it('pyAEDT emits a numeric rotate with an explanatory comment (basic path)', () => {
    const s = mkScene(
      [{
        id: 'rot_box', kind: 'rect', layer: 'electrode', cx: 5, cy: 0,
        w: '20', h: '10', cutouts: [], rotation: 'tilt', transforms: [],
      }],
      [],
      { tilt: { expr: '30', unit: '' } },
    );
    const { values: pv } = resolveParams(s.params);
    const out = generatePyAEDT(s, pv);
    expect(out).toContain('rotation = tilt');
    expect(out).toContain('hfss.modeler.rotate(["rot_box"], "Z", "30.0000deg")');
  });
});

describe('D5: zOffset in the native HFSS export', () => {
  it("electrode box ZPosition gains the zOffset expression (h_wg beyond the layer's own expr)", () => {
    const s = mkScene([{
      id: 'elec', kind: 'rect', layer: 'electrode', cx: 0, cy: 0,
      w: '20', h: '10', cutouts: [], zOffset: 'h_wg/2', transforms: [],
    }], [], { h_wg: { expr: '0.6', unit: 'µm' } });
    const { values: pv } = resolveParams(s.params);
    const out = generateHfssNative(s, pv);
    const nameIdx = out.indexOf('"Name:=", "elec"');
    expect(nameIdx).toBeGreaterThan(0);
    const blockStart = out.lastIndexOf('safe_create_', nameIdx);
    const block = out.slice(blockStart, nameIdx);
    const zPos = block.match(/ZPosition:=", "([^"]+)"/)[1];
    // The default conductor layer sits at zBottom '0um' — h_wg in the Z
    // expression can ONLY come from the component's zOffset.
    expect(zPos).toContain('h_wg');
    expect(zPos).toContain('/2');
  });

  it('port sheet ZStart and circle ZCenter gain the zOffset expression', () => {
    const s = mkScene([
      {
        id: 'port1', kind: 'rect', layer: 'port', cx: 0, cy: 0,
        w: '10', h: '10', cutouts: [], zOffset: 'z_lift', transforms: [],
      },
      {
        id: 'disc', kind: 'circle', layer: 'electrode', cx: 50, cy: 0,
        r: '5', w: '2*5', h: '2*5', cutouts: [], zOffset: 'z_lift', transforms: [],
      },
    ], [], { z_lift: { expr: '1.5', unit: 'µm' } });
    const { values: pv } = resolveParams(s.params);
    const out = generateHfssNative(s, pv);
    // Port sheet: ZStart contains z_lift.
    const portIdx = out.indexOf('"Name:=", "port1"');
    expect(portIdx).toBeGreaterThan(0);
    const portBlock = out.slice(out.lastIndexOf('safe_create_rectangle', portIdx), portIdx);
    expect(portBlock.match(/ZStart:=", "([^"]+)"/)[1]).toContain('z_lift');
    // Circle: ZCenter contains z_lift.
    const circIdx = out.indexOf('oEditor.CreateCircle');
    expect(circIdx).toBeGreaterThan(0);
    const circBlock = out.slice(circIdx, circIdx + 800);
    expect(circBlock.match(/ZCenter:=", "([^"]+)"/)[1]).toContain('z_lift');
  });

  it('waveguide rect slab/rib Z chain gains the zOffset expression', () => {
    const s = mkScene([{
      id: 'wg1', kind: 'rect', layer: 'waveguide', cx: 0, cy: 0,
      w: '100', h: '5', cutouts: [], zOffset: 'z_lift', transforms: [],
    }], [], { z_lift: { expr: '0.3', unit: 'µm' } });
    const { values: pv } = resolveParams(s.params);
    const out = generateHfssNative(s, pv);
    const slabIdx = out.indexOf('"Name:=", "wg1_wg_slab"');
    expect(slabIdx).toBeGreaterThan(0);
    const slabBlock = out.slice(out.lastIndexOf('safe_create_box', slabIdx), slabIdx);
    expect(slabBlock.match(/ZPosition:=", "([^"]+)"/)[1]).toContain('z_lift');
  });

  it('polyline pathZ and polyshape zBottom gain the zOffset expression', () => {
    const s = mkScene([
      {
        id: 'trace', kind: 'polyline', layer: 'electrode', cx: 0, cy: 0,
        w: '0', h: '0', width: '2', closed: false, cutouts: [], zOffset: 'z_lift',
        vertices: [
          { kind: 'rel', dx: '0', dy: '0' },
          { kind: 'rel', dx: '10', dy: '0' },
        ],
        transforms: [],
      },
      {
        id: 'patch', kind: 'polyshape', layer: 'electrode', cx: 40, cy: 0,
        w: '0', h: '0', closed: true, cutouts: [], zOffset: 'z_lift',
        vertices: [
          { kind: 'rel', dx: '0', dy: '0' },
          { kind: 'rel', dx: '10', dy: '0' },
          { kind: 'rel', dx: '0', dy: '10' },
        ],
        transforms: [],
      },
    ], [], { z_lift: { expr: '2', unit: 'µm' } });
    const { values: pv } = resolveParams(s.params);
    const out = generateHfssNative(s, pv);
    for (const id of ['trace', 'patch']) {
      const idx = out.indexOf(`"Name:=", "${id}"`);
      expect(idx).toBeGreaterThan(0);
      const block = out.slice(out.lastIndexOf('oEditor.CreatePolyline', idx), idx);
      const zMatch = block.match(/"Z:=", "([^"]+)"/);
      expect(zMatch).toBeTruthy();
      expect(zMatch[1]).toContain('z_lift');
    }
  });

  it('pyAEDT bakes zOffset as a numeric Z move with a comment', () => {
    const s = mkScene([{
      id: 'elec', kind: 'rect', layer: 'electrode', cx: 0, cy: 0,
      w: '20', h: '10', cutouts: [], zOffset: 'h_wg/2', transforms: [],
    }], [], { h_wg: { expr: '0.6', unit: 'µm' } });
    const { values: pv } = resolveParams(s.params);
    const out = generatePyAEDT(s, pv);
    expect(out).toContain('zOffset = h_wg/2');
    expect(out).toContain('hfss.modeler.move(["elec"], ["0um", "0um", "0.3000um"])');
  });
});

describe('rename walker + tokenizer + schema coverage', () => {
  it('renameIdentInScene rewrites rotation and zOffset expressions', () => {
    const scene = {
      params: { tilt: { expr: '30', unit: '' } },
      components: [{
        id: 'a', kind: 'rect', layer: 'electrode', cx: 0, cy: 0,
        w: '10', h: '10', rotation: 'tilt + 5', zOffset: 'tilt/10',
        cutouts: [], transforms: [],
      }],
      snaps: [], mirrors: [], groups: [], booleans: [], stack: [],
    };
    const out = renameIdentInScene(scene, 'tilt', 'rot_angle');
    expect(out.components[0].rotation).toBe('rot_angle + 5');
    expect(out.components[0].zOffset).toBe('rot_angle/10');
  });

  it('tokenizeComponentExprs sees rotation and zOffset identifiers', () => {
    const idents = tokenizeComponentExprs({
      w: '10', h: '10', rotation: 'tilt', zOffset: 'h_wg/2',
    });
    expect(idents).toContain('tilt');
    expect(idents).toContain('h_wg');
  });

  it('normalizeScene preserves rotation/zOffset and coerces numerics to strings', () => {
    const raw = {
      params: {},
      components: [{
        id: 'a', kind: 'rect', layer: 'electrode', cx: 0, cy: 0,
        w: '10', h: '10', rotation: 45, zOffset: 1.5, cutouts: [], transforms: [],
      }],
      snaps: [], stack: defaultScene.stack,
    };
    const out = normalizeScene(raw);
    const c = out.components.find(x => x.id === 'a');
    expect(c.rotation).toBe('45');
    expect(c.zOffset).toBe('1.5');
  });
});

describe('rotation + zOffset export still parses as Python', () => {
  it('native HFSS script with both features is valid Python', () => {
    const s = mkScene(
      [
        {
          id: 'parent', kind: 'rect', layer: 'electrode', cx: 0, cy: 0,
          w: '20', h: '10', cutouts: [], rotation: 'tilt', zOffset: 'h_wg/2', transforms: [],
        },
        {
          id: 'child', kind: 'polygon', layer: 'electrode', cx: 30, cy: 0,
          r: '5', n: '6', w: '2*5', h: '2*5', cutouts: [], rotation: '15', transforms: [],
        },
      ],
      [{ id: 's1', from: { compId: 'parent', anchor: 'E' }, to: { compId: 'child', anchor: 'W' }, dx: '1', dy: '0' }],
      { tilt: { expr: '30', unit: '' }, h_wg: { expr: '0.6', unit: 'µm' } },
    );
    const { values: pv } = resolveParams(s.params);
    const out = generateHfssNative(s, pv);
    mkdirSync('tests/out', { recursive: true });
    writeFileSync('tests/out/vitest_hfss_rot_zoff.py', out);
    expect(() => execSync(
      `python3 -c "import ast; ast.parse(open('tests/out/vitest_hfss_rot_zoff.py').read())"`,
      { stdio: 'pipe' }
    )).not.toThrow();
    const pyOut = generatePyAEDT(s, pv);
    writeFileSync('tests/out/vitest_pyaedt_rot_zoff.py', pyOut);
    expect(() => execSync(
      `python3 -c "import ast; ast.parse(open('tests/out/vitest_pyaedt_rot_zoff.py').read())"`,
      { stdio: 'pipe' }
    )).not.toThrow();
  });
});
