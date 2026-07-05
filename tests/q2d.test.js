// Q2D (Ansys 2D Extractor) cross-section exporter tests.
// Uses a local copy of the canonical CROSS-SECTION DATA CONTRACT fixture (a
// CPW-on-thin-film-LN slice) — deliberately NOT shared with other modules so
// contract drift is caught loudly here.
import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import { writeFileSync, mkdirSync } from 'fs';
import { generateQ2DExtractor, validateQ2DRoles } from '../src/export/q2d.js';

const FIXTURE_CROSS = {
  ok: true, sectionId: 'sec1',
  line: { p0: { x: -60, y: 0 }, p1: { x: 60, y: 0 }, lengthUm: 120, axis: 'h' },
  domain: { tMin: 0, tMax: 120, zMin: -54.7, zMax: 21.4 },
  slabs: [
    { layerId: 'l_si',   name: 'Si',       material: 'silicon', color: '#64748b', role: 'substrate', z0: -54.7, z1: -4.7 },
    { layerId: 'l_sio2', name: 'SiO2',     material: 'SiO2',    color: '#94a3b8', role: 'substrate', z0: -4.7,  z1: 0 },
    { layerId: 'l_wg',   name: 'LN film',  material: 'LiNbO3',  color: '#7dd3fc', role: 'waveguide', z0: 0, z1: 0.6, z0Expr: '(0)um', z1Expr: '(h_wg)um' },
    { layerId: 'l_clad', name: 'cladding', material: 'SiO2',    color: '#cbd5e1', role: 'cladding',  z0: 0.6, z1: 5.3 },
    { layerId: '__air',  name: 'air',      material: 'vacuum',  color: '#e2e8f0', role: 'air',       z0: 5.3, z1: 21.4 },
  ],
  conductors: [
    { id: 'gnd_top', label: 'gnd_top', layerId: 'l_cond', material: 'gold', color: '#fbbf24', zeroThickness: false, areaUm2: 32,
      z0: 0.6, z1: 1.4, z0Expr: '(h_wg)um', z1Expr: '(h_wg + h_cond)um',
      intervals: [ { t0: 0, t1: 40, t0Expr: '(0)um', t1Expr: '(40)um' } ] },
    { id: 'sig', label: 'sig', layerId: 'l_cond', material: 'gold', color: '#fbbf24', zeroThickness: false, areaUm2: 8,
      z0: 0.6, z1: 1.4, intervals: [ { t0: 45, t1: 55 } ] },
    { id: 'gnd_bot', label: 'gnd_bot', layerId: 'l_cond', material: 'gold', color: '#fbbf24', zeroThickness: false, areaUm2: 32,
      z0: 0.6, z1: 1.4, intervals: [ { t0: 60, t1: 100 } ] },
  ],
  waveguides: [
    { id: 'wg1', layerId: 'l_wg', material: 'LiNbO3', color: '#7dd3fc',
      slabBand: { z0: 0, z1: 0.3, intervals: [ { t0: 0, t1: 120 } ] },
      core: { zBot: 0.3, zTop: 0.6, segments: [ { botT0: 48.9, botT1: 51.1, topT0: 49.25, topT1: 50.75 } ] } },
  ],
  wgCenter: { t: 50, z: 0.45, compId: 'wg1' },
  params: { h_wg: 0.6, h_cond: 0.8 },
  warnings: [],
};

const ROLES = { gnd_top: 'ground', sig: 'signal', gnd_bot: 'ground' };
const clone = (o) => JSON.parse(JSON.stringify(o));

describe('generateQ2DExtractor', () => {
  const out = generateQ2DExtractor(FIXTURE_CROSS, { roles: ROLES });

  it('parses as valid Python', () => {
    mkdirSync('tests/out', { recursive: true });
    writeFileSync('tests/out/vitest_q2d.py', out);
    expect(() => execSync(
      `python3 -c "import ast; ast.parse(open('tests/out/vitest_q2d.py').read())"`,
      { stdio: 'pipe' }
    )).not.toThrow();
  });

  it('boilerplate: 2D Extractor design, 3D Modeler editor, Open solution, um units', () => {
    expect(out).toContain('oProject.InsertDesign("2D Extractor", "q2d_section", "", "")');
    expect(out).toContain('oEditor = oDesign.SetActiveEditor("3D Modeler")');
    expect(out).toContain('oDesign.SetSolutionType("Open")');
    expect(out).toContain('"Units:=", "um"');
    // Ends with a completion message, NOT an auto-save.
    expect(out).toMatch(/q2d_msg\(0, "Q2D cross-section (solved|built)/);
    expect(out).not.toContain('oProject.Save()');
  });

  it('declares cross.params as DIMENSIONLESS design variables', () => {
    // "(h_wg)um" exprs require bare-number variables (length-typed ones would
    // double-convert — the q3d.js "(h_si)um" bug class).
    expect(out).toContain('set_var("h_wg", "0.6")');
    expect(out).toContain('set_var("h_cond", "0.8")');
    expect(out).not.toContain('set_var("h_wg", "0.6um")');
  });

  it('emits every slab rect and every conductor interval rect by name', () => {
    for (const n of ['slab_l_si', 'slab_l_sio2', 'slab_l_clad', 'slab___air']) {
      expect(out).toContain(`"Name:=", "${n}"`);
    }
    for (const n of ['gnd_top_i0', 'sig_i0', 'gnd_bot_i0']) {
      expect(out).toContain(`"Name:=", "${n}"`);
    }
    // WAVEGUIDE-role slabs are NOT drawn (coplanar-stack overlap fix):
    // the film exists only as the wg slabBand + core entries.
    expect(out).not.toContain('"Name:=", "slab_l_wg"');
  });

  it('uses contract exprs VERBATIM for positions and unit-stripped diffs for sizes', () => {
    // gnd_top YStart is the parametric conductor bottom, verbatim.
    expect(out).toContain('"YStart:=", "(h_wg)um"');
    // Interval XStart verbatim.
    expect(out).toContain('"XStart:=", "(0)um"');
    // Sizes are (end - start) compounds: the "(X)um" quirk form is standalone-
    // only in AEDT, so the unit is stripped and re-typed with *1um.
    expect(out).toContain('"Height:=", "((h_wg + h_cond) - (h_wg))*1um"');
    expect(out).toContain('"Width:=", "((40) - (0))*1um"');
    // Non-parametric sig conductor bakes numerics.
    expect(out).toContain('"XStart:=", "45um"');
  });

  it('assigns ONE boundary per conductor with the pyAEDT prop list', () => {
    // Exact COM prop shape from pyaedt q3d.py assign_single_conductor +
    // boundary/common.py dispatch.
    expect(out).toContain('oBnd.AssignSingleSignalLine(["NAME:" + name, "Objects:=", objs,');
    expect(out).toContain('oBnd.AssignSingleReferenceGround(["NAME:" + name, "Objects:=", objs,');
    expect(out).toContain('"SolveOption:=", "SolveInside"');
    expect(out).toContain('q2d_signal("sig", ["sig_i0"], "0.8um")');
    expect(out).toContain('q2d_ground("gnd_top", ["gnd_top_i0"], "0.8um")');
    expect(out).toContain('q2d_ground("gnd_bot", ["gnd_bot_i0"], "0.8um")');
    // exactly one signal assignment, two grounds
    expect(out.match(/^q2d_signal\(/gm)).toHaveLength(1);
    expect(out.match(/^q2d_ground\(/gm)).toHaveLength(2);
  });

  it('setup: 2DMatrix with CG/RL PerError 0.1 and pass limits 1..16', () => {
    expect(out).toContain('oAna.InsertSetup("2DMatrix"');
    const cg = out.slice(out.indexOf('"NAME:CGDataBlock"'), out.indexOf('"NAME:RLDataBlock"'));
    expect(cg).toContain('"PerError:=", 0.1');
    expect(cg).toContain('"MinPass:=", 1');
    expect(cg).toContain('"MaxPass:=", 16');
    const rl = out.slice(out.indexOf('"NAME:RLDataBlock"'), out.indexOf('CacheSaveKind'));
    expect(rl).toContain('"PerError:=", 0.1');
    // adaptive frequency defaults to the geometric mean of 1..50 GHz
    expect(out).toContain('"AdaptiveFreq:=", "7.071068GHz"');
  });

  it('sweep: LinearCount 1..50 GHz, 200 points, Interpolating, SaveFields FALSE', () => {
    expect(out).toContain('oAna.InsertSweep("Setup1"');
    expect(out).toContain('"RangeStart:=", "1GHz"');
    expect(out).toContain('"RangeEnd:=", "50GHz"');
    expect(out).toContain('"RangeCount:=", 200');
    // AEDT forbids saving fields on an interpolating sweep — must be False,
    // else InsertSweep fails and every report cascades to "No Solution found".
    expect(out).toContain('"Type:=", "Interpolating", "SaveFields:=", False');
    expect(out).not.toContain('"Type:=", "Interpolating", "SaveFields:=", True');
  });

  it('SOLVES Setup1 before the reports (reports/fields need a solution)', () => {
    // The Z0/eps_eff reports read the sweep and the E-field named expressions
    // read LastAdaptive fields — both need a solved Setup1, so autoSolve
    // (default) analyzes before creating them.
    expect(out).toContain('oDesign.Analyze("Setup1")');
    const solveAt = out.indexOf('oDesign.Analyze("Setup1")');
    const z0At = out.indexOf('CreateReport("Z0 vs Freq"');
    expect(solveAt).toBeGreaterThan(0);
    expect(z0At).toBeGreaterThan(solveAt); // solve precedes the reports
  });

  it('autoSolve:false builds only (no Analyze call)', () => {
    const buildOnly = generateQ2DExtractor(FIXTURE_CROSS, { roles: ROLES, autoSolve: false });
    expect(buildOnly).not.toContain('oDesign.Analyze("Setup1")');
    expect(buildOnly).toContain('Build-only');
    // sweep is still valid (SaveFields False) even in build-only mode
    expect(buildOnly).toContain('"Type:=", "Interpolating", "SaveFields:=", False');
  });

  it('Z0 and Gamma-based sqrt(eps_eff) report expressions are exact', () => {
    expect(out).toContain('"Y Component:=", ["re(Z0(sig,sig))", "im(Z0(sig,sig))"]');
    // im(Gamma) is beta in rad/m (SI), Freq in Hz -> dimensionless sqrt(eps_eff)
    expect(out).toContain('"Y Component:=", ["im(Gamma(sig,sig))*299792458/(2*pi*Freq)"]');
  });

  it('waveguide: slab band rect + core trapezoid polyline with the 4 corners', () => {
    expect(out).toContain('"Name:=", "wg_wg1_slab0"');
    const poly = out.slice(out.indexOf('q2d_poly('), out.indexOf('"Name:=", "wg_wg1_core"') + 40);
    // (botT0,zBot)-(botT1,zBot)-(topT1,zTop)-(topT0,zTop), explicit closure
    expect(poly).toContain('"X:=", "48.9um", "Y:=", "0.3um"');
    expect(poly).toContain('"X:=", "51.1um", "Y:=", "0.3um"');
    expect(poly).toContain('"X:=", "50.75um", "Y:=", "0.6um"');
    expect(poly).toContain('"X:=", "49.25um", "Y:=", "0.6um"');
    expect(poly.match(/"X:=", "48\.9um", "Y:=", "0\.3um"/g)).toHaveLength(2); // first == last
    expect(poly).toContain('"IsPolylineCovered:=", True, "IsPolylineClosed:=", True');
  });

  it('subtracts overlapping objects from each slab (and only those)', () => {
    // conductors (z 0.6..1.4) overlap the cladding slab (0.6..5.3)
    const clad = /q2d_subtract\("slab_l_clad", \[([^\]]*)\]\)/.exec(out);
    expect(clad).toBeTruthy();
    expect(clad[1]).toContain('"gnd_top_i0"');
    expect(clad[1]).toContain('"sig_i0"');
    expect(clad[1]).toContain('"gnd_bot_i0"');
    // The wg-role film slab is not drawn at all (overlap fix), so no
    // subtract may target it; the fixture's wg entries (slabBand 0..0.3,
    // core 0.3..0.6) only TOUCH the cladding at z=0.6 — zero-area, no carve.
    expect(out).not.toContain('q2d_subtract("slab_l_wg"');
    const clad2 = /q2d_subtract\("slab_l_clad", \[([^\]]*)\]\)/.exec(out);
    expect(clad2[1]).not.toContain('wg_wg1_slab0');
    expect(clad2[1]).not.toContain('wg_wg1_core');
    // nothing reaches the Si substrate or the air slab
    expect(out).not.toContain('q2d_subtract("slab_l_si"');
    expect(out).not.toContain('q2d_subtract("slab___air"');
    // KeepOriginals TRUE — the tools are real objects that must survive
    expect(out).toContain('"KeepOriginals:=", True');
  });

  it('field probe: point at wgCenter + both named E components', () => {
    expect(out).toContain('"PointX:=", "50um", "PointY:=", "0.45um"');
    expect(out).toContain('"Name:=", "wg_center"');
    expect(out).toContain('oFld.CalcOp("ScalarX")');
    expect(out).toContain('oFld.CalcOp("ScalarY")');
    expect(out).toContain('oFld.AddNamedExpression("E_along_section", "CG Fields")');
    expect(out).toContain('oFld.AddNamedExpression("E_vertical", "CG Fields")');
    expect(out).toContain('"Y Component:=", ["mag(E_along_section)", "mag(E_vertical)"]');
  });

  it('header carries the section id, line geometry, and role table', () => {
    expect(out).toContain('section "sec1"');
    expect(out).toContain('(-60, 0) -> (60, 0) um, length 120 um, axis: h');
    expect(out).toMatch(/#\s+sig\s+signal/);
    expect(out).toMatch(/#\s+gnd_top\s+ground/);
  });
});

describe('generateQ2DExtractor — variants', () => {
  it('zeroThickness conductor draws a thin rect centered on z0', () => {
    const cx = clone(FIXTURE_CROSS);
    const sig = cx.conductors.find((c) => c.id === 'sig');
    sig.zeroThickness = true;
    sig.z1 = sig.z0; // 0.6..0.6
    const out = generateQ2DExtractor(cx, { roles: ROLES }); // condThicknessUm default 0.5
    // centered on z0=0.6: YStart 0.35, height 0.5
    expect(out).toContain('"YStart:=", "0.35um"');
    expect(out).toContain('"Height:=", "0.5um"');
    // the film slab is not drawn (overlap fix) — the thin rect z 0.35..0.6
    // touches the cladding (0.6..5.3) with zero area, so no carve targets it
    expect(out).not.toContain('q2d_subtract("slab_l_wg"');
    // kinetic-inductance caveat surfaced
    expect(out).toContain('ZERO-THICKNESS conductor');
    expect(out.toLowerCase()).toContain('kinetic-inductance');
    // python still parses
    mkdirSync('tests/out', { recursive: true });
    writeFileSync('tests/out/vitest_q2d_sheet.py', out);
    expect(() => execSync(
      `python3 -c "import ast; ast.parse(open('tests/out/vitest_q2d_sheet.py').read())"`,
      { stdio: 'pipe' }
    )).not.toThrow();
  });

  it('zeroThickness + parametric z0Expr keeps the half-shift parametric', () => {
    const cx = clone(FIXTURE_CROSS);
    const g = cx.conductors.find((c) => c.id === 'gnd_top');
    g.zeroThickness = true;
    g.z1 = g.z0;
    const out = generateQ2DExtractor(cx, { roles: ROLES, condThicknessUm: 0.4 });
    expect(out).toContain('"YStart:=", "((h_wg) - 0.2)*1um"');
    expect(out).toContain('"Height:=", "0.4um"');
  });

  it('honors opts: designName, band, points, per-errors, passes, no field point', () => {
    const out = generateQ2DExtractor(FIXTURE_CROSS, {
      roles: ROLES, designName: 'my sec!', freqStartGHz: 2, freqStopGHz: 32,
      freqPoints: 61, adaptFreqGHz: 10, cgPerError: 0.05, rlPerError: 0.2,
      minPasses: 3, maxPasses: 22, includeFieldPoint: false,
    });
    expect(out).toContain('oProject.InsertDesign("2D Extractor", "my_sec_", "", "")');
    expect(out).toContain('"RangeStart:=", "2GHz"');
    expect(out).toContain('"RangeEnd:=", "32GHz"');
    expect(out).toContain('"RangeCount:=", 61');
    expect(out).toContain('"AdaptiveFreq:=", "10GHz"');
    const cg = out.slice(out.indexOf('"NAME:CGDataBlock"'), out.indexOf('"NAME:RLDataBlock"'));
    expect(cg).toContain('"PerError:=", 0.05');
    expect(cg).toContain('"MinPass:=", 3');
    expect(cg).toContain('"MaxPass:=", 22');
    const rl = out.slice(out.indexOf('"NAME:RLDataBlock"'), out.indexOf('CacheSaveKind'));
    expect(rl).toContain('"PerError:=", 0.2');
    expect(out).not.toContain('CreatePoint');
    expect(out).not.toContain('AddNamedExpression');
  });

  it('surfaces cross.warnings in the header', () => {
    const cx = clone(FIXTURE_CROSS);
    cx.warnings = [{ code: 'oblique', msg: 'section line is not axis-aligned' }];
    const out = generateQ2DExtractor(cx, { roles: ROLES });
    expect(out).toContain('# WARNING [oblique]: section line is not axis-aligned');
  });

  it('throws on unusable cross input', () => {
    expect(() => generateQ2DExtractor({ ok: false, error: 'no section line' }, { roles: ROLES }))
      .toThrow(/no section line/);
    expect(() => generateQ2DExtractor(null, { roles: ROLES })).toThrow(/unusable/);
  });
});

describe('validateQ2DRoles', () => {
  it('accepts a complete signal+ground assignment', () => {
    expect(validateQ2DRoles(FIXTURE_CROSS, ROLES)).toEqual({ ok: true });
  });
  it('rejects a missing role, naming the conductor', () => {
    const r = validateQ2DRoles(FIXTURE_CROSS, { sig: 'signal', gnd_top: 'ground' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('gnd_bot');
  });
  it('rejects zero grounds and zero signals', () => {
    expect(validateQ2DRoles(FIXTURE_CROSS, { gnd_top: 'signal', sig: 'signal', gnd_bot: 'signal' }).ok).toBe(false);
    expect(validateQ2DRoles(FIXTURE_CROSS, { gnd_top: 'ground', sig: 'ground', gnd_bot: 'ground' }).ok).toBe(false);
  });
  it('rejects a cross-section with no conductors', () => {
    const cx = clone(FIXTURE_CROSS);
    cx.conductors = [];
    expect(validateQ2DRoles(cx, {}).ok).toBe(false);
  });
  it('generateQ2DExtractor throws with the validation message', () => {
    expect(() => generateQ2DExtractor(FIXTURE_CROSS, { roles: { sig: 'signal' } }))
      .toThrow(/gnd_top|gnd_bot/);
  });
});
