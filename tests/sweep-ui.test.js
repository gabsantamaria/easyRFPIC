// Model-level tests for the analysis/sweep simSetup contract and the
// per-param sweep metadata:
//   - normalizeScene fills the new simSetup defaults (solveFreq,
//     maxPasses, maxDeltaS, sweepEnabled, sweepStart/Stop/Points/Type)
//   - saved values win over defaults — INCLUDING an explicit
//     sweepEnabled:false (the falsy-boolean trap)
//   - param.sweep metadata round-trips through normalizeScene
//   - renameIdentInScene preserves param.sweep while rewriting exprs
import { describe, it, expect } from 'vitest';
import { normalizeScene, makeBlankScene } from '../src/scene/schema.js';
import { renameIdentInScene } from '../src/scene/rename-ident.js';

describe('normalizeScene simSetup analysis/sweep defaults', () => {
  it('fills contract defaults on a scene with no simSetup', () => {
    const s = normalizeScene(makeBlankScene());
    expect(s.simSetup.fnominal).toBe('4');
    expect(s.simSetup.solveFreq).toBe('');
    expect(s.simSetup.maxPasses).toBe('12');
    expect(s.simSetup.maxDeltaS).toBe('0.02');
    expect(s.simSetup.sweepEnabled).toBe(true);
    expect(s.simSetup.sweepStart).toBe('0.1');
    expect(s.simSetup.sweepStop).toBe('50');
    expect(s.simSetup.sweepPoints).toBe('500');
    expect(s.simSetup.sweepType).toBe('Interpolating');
  });

  it('fills missing sweep fields on a scene with a partial simSetup', () => {
    const base = { ...makeBlankScene(), simSetup: { fnominal: '8', airPad: '120' } };
    const s = normalizeScene(base);
    // saved values win…
    expect(s.simSetup.fnominal).toBe('8');
    expect(s.simSetup.airPad).toBe('120');
    // …missing contract fields get defaults
    expect(s.simSetup.solveFreq).toBe('');
    expect(s.simSetup.maxPasses).toBe('12');
    expect(s.simSetup.sweepEnabled).toBe(true);
    expect(s.simSetup.sweepType).toBe('Interpolating');
  });

  it('explicit sweepEnabled:false survives normalize', () => {
    const base = { ...makeBlankScene(), simSetup: { sweepEnabled: false } };
    const s = normalizeScene(base);
    expect(s.simSetup.sweepEnabled).toBe(false);
  });

  it('explicit sweep values survive normalize', () => {
    const base = {
      ...makeBlankScene(),
      simSetup: {
        solveFreq: '20', maxPasses: '25', maxDeltaS: '0.005',
        sweepEnabled: true, sweepStart: '1', sweepStop: '110',
        sweepPoints: '1000', sweepType: 'Discrete',
      },
    };
    const s = normalizeScene(base);
    expect(s.simSetup.solveFreq).toBe('20');
    expect(s.simSetup.maxPasses).toBe('25');
    expect(s.simSetup.maxDeltaS).toBe('0.005');
    expect(s.simSetup.sweepStart).toBe('1');
    expect(s.simSetup.sweepStop).toBe('110');
    expect(s.simSetup.sweepPoints).toBe('1000');
    expect(s.simSetup.sweepType).toBe('Discrete');
  });
});

describe('param.sweep metadata', () => {
  const SWEEP = { enabled: true, start: '10', stop: '100', step: '5' };

  it('round-trips through normalizeScene', () => {
    const base = makeBlankScene();
    base.params.gap = { expr: '20', unit: 'µm', desc: 'electrode gap', sweep: { ...SWEEP } };
    const s = normalizeScene(base);
    expect(s.params.gap.sweep).toEqual(SWEEP);
    // and through a JSON save/load cycle (the persistence path)
    const s2 = normalizeScene(JSON.parse(JSON.stringify(s)));
    expect(s2.params.gap.sweep).toEqual(SWEEP);
  });

  it('disabled sweep metadata also survives normalize', () => {
    const base = makeBlankScene();
    base.params.gap = { expr: '20', unit: 'µm', sweep: { enabled: false, start: '1', stop: '2', step: '0.5' } };
    const s = normalizeScene(base);
    expect(s.params.gap.sweep.enabled).toBe(false);
    expect(s.params.gap.sweep.step).toBe('0.5');
  });

  it('renameIdentInScene preserves param.sweep while rewriting exprs', () => {
    const scene = {
      params: {
        gap:  { expr: '20', unit: 'µm', sweep: { ...SWEEP } },
        wtot: { expr: '2*gap + 10', unit: 'µm' },
      },
      components: [
        { id: 'r1', kind: 'rect', layer: 'electrode', cx: 0, cy: 0, w: 'gap', h: '5', cutouts: [], transforms: [] },
      ],
      snaps: [],
      stack: [],
    };
    // Caller (renameParam) renames the KEY first, then hands the scene
    // to renameIdentInScene for the reference rewrite — mirror that.
    const renamedKey = { ...scene, params: { gap_sig: scene.params.gap, wtot: scene.params.wtot } };
    const out = renameIdentInScene(renamedKey, 'gap', 'gap_sig');
    // references rewritten…
    expect(out.params.wtot.expr).toBe('2*gap_sig + 10');
    expect(out.components[0].w).toBe('gap_sig');
    // …sweep metadata intact on the renamed param
    expect(out.params.gap_sig.sweep).toEqual(SWEEP);
  });
});

describe('PEC sheets + wg guide lines (D8)', () => {
  it('literal Rs=0 Xs=0 zero-thickness layer emits AssignPerfectE (not impedance)', async () => {
    const { makeDefaultScene, normalizeScene } = await import('../src/scene/schema.js');
    const { resolveParams } = await import('../src/scene/params.js');
    const { generateHfssNative } = await import('../src/export/hfss-native.js');
    const sc = normalizeScene(makeDefaultScene());
    const cond = sc.stack.find(l => l.role === 'conductor');
    cond.thickness = '0';
    cond.sheetRs = '0';
    cond.sheetXs = '0';
    const script = generateHfssNative(sc, resolveParams(sc.params).values, {});
    expect(script).toContain('AssignPerfectE');
    expect(script).not.toMatch(/AssignImpedance\(\s*\["NAME:PEC_sheets/);
    // an EXPRESSION Xs (kinetic inductance) must never be misread as zero
    const sc2 = normalizeScene(makeDefaultScene());
    const c2 = sc2.stack.find(l => l.role === 'conductor');
    c2.thickness = '0'; c2.sheetRs = '0'; c2.sheetXs = '2*pi*Freq*10e-12';
    const s2 = generateHfssNative(sc2, resolveParams(sc2.params).values, {});
    expect(s2).toContain('AssignImpedance');
    expect(s2).not.toContain('AssignPerfectE');
    // untyped default stays the near-PEC impedance sheet
    const sc3 = normalizeScene(makeDefaultScene());
    sc3.stack.find(l => l.role === 'conductor').thickness = '0';
    const s3 = generateHfssNative(sc3, resolveParams(sc3.params).values, {});
    expect(s3).toContain('AssignImpedance');
    expect(s3).not.toContain('AssignPerfectE');
  });

  it('every waveguide CS gets a NonModel guide line spanning the wg length', async () => {
    const { makeDefaultScene } = await import('../src/scene/schema.js');
    const { resolveParams } = await import('../src/scene/params.js');
    const { generateHfssNative } = await import('../src/export/hfss-native.js');
    const scene = makeDefaultScene();
    const script = generateHfssNative(scene, resolveParams(scene.params).values, {});
    expect(script).toContain('Name:=", "wg1_cs_line"');
    expect(script).toContain('Flags:=", "NonModel#"');
    expect(script).toContain('Working Coordinate System:=", "wg1_cs"');
    expect(script).toContain('PartCoordinateSystem:=", "wg1_cs"');
    expect(script).toContain('_delete_geom_if_exists("wg1_cs_line")');
    // starts at the CS origin
    expect(script).toMatch(/PLPoint", "X:=", "0um", "Y:=", "0um", "Z:=", "0um"/);
  });
});
