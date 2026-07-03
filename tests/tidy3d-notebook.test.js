// Tidy3D notebook exporter (src/export/tidy3d-notebook.js). Fixture-driven:
// consumes a canonical CROSS-SECTION DATA CONTRACT v1 object (CPW on thin-film
// LN) and checks the emitted nbformat-4 JSON — shape, every code cell parsing
// as python (ast.parse via system python3, mirroring exports.test.js), the
// user-editable params surface, the anisotropic EO mapping, the VpiL physics
// strings, and the degraded no-waveguide / warnings paths.
import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import { writeFileSync, mkdirSync } from 'fs';
import { generateTidy3DNotebook } from '../src/export/tidy3d-notebook.js';

// Canonical fixture: CPW (G-S-G) on thin-film LN over SiO2/Si, rib waveguide
// under the signal-ground gap region. Embedded copy — deliberately NOT shared
// with other modules' test files.
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
      intervals: [{ t0: 0, t1: 40, t0Expr: '(0)um', t1Expr: '(40)um' }] },
    { id: 'sig', label: 'sig', layerId: 'l_cond', material: 'gold', color: '#fbbf24', zeroThickness: false, areaUm2: 8,
      z0: 0.6, z1: 1.4, intervals: [{ t0: 45, t1: 55 }] },
    { id: 'gnd_bot', label: 'gnd_bot', layerId: 'l_cond', material: 'gold', color: '#fbbf24', zeroThickness: false, areaUm2: 32,
      z0: 0.6, z1: 1.4, intervals: [{ t0: 60, t1: 100 }] },
  ],
  waveguides: [
    { id: 'wg1', layerId: 'l_wg', material: 'LiNbO3', color: '#7dd3fc',
      slabBand: { z0: 0, z1: 0.3, intervals: [{ t0: 0, t1: 120 }] },
      core: { zBot: 0.3, zTop: 0.6, segments: [{ botT0: 48.9, botT1: 51.1, topT0: 49.25, topT1: 50.75 }] } },
  ],
  wgCenter: { t: 50, z: 0.45, compId: 'wg1' },
  params: { h_wg: 0.6, h_cond: 0.8 },
  warnings: [],
};

const clone = (o) => JSON.parse(JSON.stringify(o));

// Write the notebook and ast.parse EVERY code cell with the system python3 —
// same mechanism exports.test.js uses for the generated .py scripts.
function pyCheckAllCells(ipynb, name) {
  mkdirSync('tests/out', { recursive: true });
  writeFileSync(`tests/out/${name}.ipynb`, ipynb);
  expect(() => execSync(
    `python3 -c "import json, ast; nb = json.load(open('tests/out/${name}.ipynb')); [ast.parse(''.join(c['source'])) for c in nb['cells'] if c['cell_type'] == 'code']"`,
    { stdio: 'pipe' }
  )).not.toThrow();
}

const cellText = (c) => c.source.join('');
const codeText = (nb) => nb.cells.filter((c) => c.cell_type === 'code').map(cellText).join('\n');
const mdTextAll = (nb) => nb.cells.filter((c) => c.cell_type === 'markdown').map(cellText).join('\n');
const findCell = (nb, needle) => nb.cells.find((c) => cellText(c).includes(needle));

describe('generateTidy3DNotebook — fixture notebook', () => {
  const { ipynb, warnings } = generateTidy3DNotebook(FIXTURE_CROSS, { designName: 'cpw_tfln' });
  const nb = JSON.parse(ipynb);

  it('is nbformat-4 JSON with the expected shape', () => {
    expect(nb.nbformat).toBe(4);
    expect(nb.nbformat_minor).toBe(5);
    expect(nb.metadata.kernelspec.language).toBe('python');
    expect(Array.isArray(nb.cells)).toBe(true);
    expect(nb.cells.length).toBeGreaterThanOrEqual(8);
    for (const c of nb.cells) {
      expect(['code', 'markdown']).toContain(c.cell_type);
      expect(typeof c.id).toBe('string');
      expect(Array.isArray(c.source)).toBe(true);
      if (c.cell_type === 'code') {
        expect(c.outputs).toEqual([]);
        expect(c.execution_count).toBe(null);
      }
    }
    // code cell source lines end with \n (nbformat convention, except last)
    const code = nb.cells.find((c) => c.cell_type === 'code');
    for (let i = 0; i < code.source.length - 1; i++) expect(code.source[i].endsWith('\n')).toBe(true);
  });

  it('every code cell parses as valid python', () => {
    pyCheckAllCells(ipynb, 'vitest_tidy3d_fixture');
  });

  it('params cell carries slab/conductor variables, the role table, and scene params', () => {
    const p = findCell(nb, 'USER-EDITABLE PARAMETERS');
    expect(p).toBeTruthy();
    const t = cellText(p);
    expect(t).toContain('SLABS = [');
    expect(t).toContain('CONDUCTORS = [');
    expect(t).toContain('WAVEGUIDES = [');
    expect(t).toContain('ROLES = {');
    // inferred roles: sig (nearest the waveguide center) drives, grounds flank
    expect(t).toContain('"sig": "signal"');
    expect(t).toContain('"gnd_top": "ground"');
    expect(t).toContain('"gnd_bot": "ground"');
    // scene params emitted as python variables...
    expect(t).toContain('h_wg = 0.6');
    expect(t).toContain('h_cond = 0.8');
    // ...and the parametric z-exprs translated to reference them (um stripped)
    expect(t).toContain('z0=(h_wg), z1=(h_wg + h_cond)');
    // numeric-only conductor stays baked
    expect(t).toContain('dict(t0=45');
    expect(t).toContain('t1=55');
    // domain
    expect(t).toContain('T_MIN, T_MAX = 0.0, 120.0');
    expect(t).toContain('Z_MIN, Z_MAX = -54.7, 21.4');
  });

  it('EO constants and freq sweep are present with the requested values', () => {
    const t = codeText(nb);
    expect(t).toContain('LAMBDA_UM = 1.55');
    expect(t).toContain('NE = 2.138');
    expect(t).toContain('NO = 2.211');
    expect(t).toContain('R33_PM_PER_V = 30.8');
    expect(t).toContain('R13_PM_PER_V = 8.6');
    expect(t).toContain('np.linspace(1.0, 50.0, 25) * 1e9');
  });

  it('RF cell: local ModeSolver + microwave-plugin V/I integrals + ImpedanceCalculator', () => {
    const t = codeText(nb);
    expect(t).toContain('from tidy3d.plugins.mode import ModeSolver');
    expect(t).toContain('import tidy3d.plugins.microwave as mw');
    expect(t).toContain('td.ModeSpec(num_modes=1, target_neff=NEFF_GUESS_RF)');
    expect(t).toContain('rf_data = solver_rf.solve()');
    expect(t).toContain('mw.VoltageIntegralAxisAligned(');
    expect(t).toContain('mw.CurrentIntegralAxisAligned(');
    expect(t).toContain('mw.ImpedanceCalculator(voltage_integral=voltage_integral');
    expect(t).toContain('compute_impedance(rf_data)');
    // quasi-TEM identity stated where sqrt_eps_eff is defined
    expect(t).toContain('n_eff IS sqrt(eps_eff)');
  });

  it('trapezoid core: vertices from core.segments, PolySlab axis=2 in the (x, y) plane', () => {
    const t = codeText(nb);
    expect(t).toContain('bot_t0=48.9, bot_t1=51.1, top_t0=49.25, top_t1=50.75');
    expect(t).toContain('core_z_bot=0.3, core_z_top=0.6');
    expect(t).toContain('td.PolySlab(vertices=verts, axis=2');
  });

  it('VpiL cell: 1 V normalization and the lambda/(2*dn_eff) formula in V*cm', () => {
    const t = codeText(nb);
    expect(t).toContain('voltage_integral.compute_voltage(rf_data)');
    expect(t).toContain('e1v = e_rf_c / v_rf');
    expect(t).toContain('LAMBDA_UM / (2.0 * abs(dn_eff))');
    expect(t).toContain('* 1e-4'); // V*um -> V*cm
    // both EO coefficients drive from the SAME field component along c
    expect(t).toContain('R33_PM_PER_V * 1e-6');
    expect(t).toContain('R13_PM_PER_V * 1e-6');
    // physics markdown cites the canonical references
    const md = mdTextAll(nb);
    expect(md).toContain('Wooten');
    expect(md).toContain('Nature');
  });

  it('default extraordinaryAxis=vertical maps yy=ne^2 (both mapping branches emitted)', () => {
    const t = codeText(nb);
    expect(t).toContain('EO_AXIS = "vertical"');
    expect(t).toContain('EO_COMP = "Ey"');
    expect(t).toContain('td.AnisotropicMedium(xx=o, yy=e, zz=o)'); // vertical: c -> tidy3d y
    expect(t).toContain('td.AnisotropicMedium(xx=e, yy=o, zz=o)'); // horizontal branch present too
  });

  it('reports the inferred-roles warning', () => {
    expect(warnings.some((w) => w.includes('RF roles inferred'))).toBe(true);
  });
});

describe('generateTidy3DNotebook — options & variants', () => {
  it('extraordinaryAxis=horizontal switches the mapping and the RF field component', () => {
    const { ipynb } = generateTidy3DNotebook(FIXTURE_CROSS, { extraordinaryAxis: 'horizontal' });
    const nb = JSON.parse(ipynb);
    const t = codeText(nb);
    expect(t).toContain('EO_AXIS = "horizontal"');
    expect(t).toContain('EO_COMP = "Ex"');
    pyCheckAllCells(ipynb, 'vitest_tidy3d_horizontal');
  });

  it('explicit opts.roles override the inference', () => {
    const { ipynb, warnings } = generateTidy3DNotebook(FIXTURE_CROSS, {
      roles: { gnd_top: 'signal', sig: 'ground', gnd_bot: 'ground' },
    });
    const nb = JSON.parse(ipynb);
    const t = codeText(nb);
    expect(t).toContain('"gnd_top": "signal"');
    expect(t).toContain('"sig": "ground"');
    expect(warnings.some((w) => w.includes('RF roles inferred'))).toBe(false);
  });

  it('materialIndices overrides land in the MATERIAL_INDEX table', () => {
    const { ipynb } = generateTidy3DNotebook(FIXTURE_CROSS, { materialIndices: { SiO2: 1.45 } });
    expect(codeText(JSON.parse(ipynb))).toContain('"SiO2": 1.45,');
  });

  it('custom ne/no/r33/r13/lambda/freq opts propagate', () => {
    const { ipynb } = generateTidy3DNotebook(FIXTURE_CROSS, {
      ne: 2.2, no: 2.25, r33: 31.4, r13: 9.1, lambdaUm: 1.31,
      freqStartGHz: 0.5, freqStopGHz: 67, freqPoints: 41,
    });
    const t = codeText(JSON.parse(ipynb));
    expect(t).toContain('NE = 2.2');
    expect(t).toContain('NO = 2.25');
    expect(t).toContain('R33_PM_PER_V = 31.4');
    expect(t).toContain('R13_PM_PER_V = 9.1');
    expect(t).toContain('LAMBDA_UM = 1.31');
    expect(t).toContain('np.linspace(0.5, 67.0, 41) * 1e9');
  });

  it('cross.warnings propagate to the returned warnings AND the final markdown, verbatim', () => {
    const fx = clone(FIXTURE_CROSS);
    fx.line.axis = null;
    fx.warnings = [{ code: 'oblique-section', msg: 'section line is oblique; t-intervals measured along the line, parametric exprs dropped' }];
    const { ipynb, warnings } = generateTidy3DNotebook(fx);
    expect(warnings.some((w) => w.includes('oblique-section') && w.includes('parametric exprs dropped'))).toBe(true);
    const nb = JSON.parse(ipynb);
    const md = mdTextAll(nb);
    expect(md).toContain('section line is oblique; t-intervals measured along the line, parametric exprs dropped');
    pyCheckAllCells(ipynb, 'vitest_tidy3d_oblique');
  });

  it('no-waveguide cross: VpiL replaced by a requires-a-waveguide markdown, RF still generated', () => {
    const fx = clone(FIXTURE_CROSS);
    fx.waveguides = [];
    fx.wgCenter = null;
    const { ipynb, warnings } = generateTidy3DNotebook(fx);
    const nb = JSON.parse(ipynb);
    const t = codeText(nb);
    // RF path intact
    expect(t).toContain('mw.ImpedanceCalculator(');
    expect(t).toContain('rf_data = solver_rf.solve()');
    // no optical/VpiL code
    expect(t).not.toContain('opt_data');
    expect(t).not.toContain('vpil_v_cm');
    // replacement markdown explains the requirement
    const md = mdTextAll(nb);
    expect(md.toLowerCase()).toContain('requires a waveguide');
    expect(warnings.some((w) => w.includes('optical / VpiL skipped'))).toBe(true);
    pyCheckAllCells(ipynb, 'vitest_tidy3d_no_wg');
  });

  it('no-conductor cross: RF and VpiL degrade to markdown, optical still generated', () => {
    const fx = clone(FIXTURE_CROSS);
    fx.conductors = [];
    const { ipynb, warnings } = generateTidy3DNotebook(fx);
    const nb = JSON.parse(ipynb);
    const t = codeText(nb);
    expect(t).not.toContain('solver_rf');
    expect(t).not.toContain('vpil_v_cm');
    expect(t).toContain('opt_data = solver_opt.solve()');
    expect(warnings.some((w) => w.includes('no conductors'))).toBe(true);
    pyCheckAllCells(ipynb, 'vitest_tidy3d_no_cond');
  });

  it('unknown material gets a FIXME table entry and a warning', () => {
    const fx = clone(FIXTURE_CROSS);
    fx.slabs[0] = { ...fx.slabs[0], material: 'unobtainium' };
    const { ipynb, warnings } = generateTidy3DNotebook(fx);
    expect(codeText(JSON.parse(ipynb))).toContain('"unobtainium": 1.5,  # FIXME');
    expect(warnings.some((w) => w.includes("unknown material 'unobtainium'"))).toBe(true);
  });

  it('param colliding with a python keyword is dropped; exprs referencing it bake numeric', () => {
    const fx = clone(FIXTURE_CROSS);
    fx.params = { ...fx.params, lambda: 3.0 };
    fx.slabs[3] = { ...fx.slabs[3], z1Expr: '(0.6 + lambda)um' };
    const { ipynb, warnings } = generateTidy3DNotebook(fx);
    const t = codeText(JSON.parse(ipynb));
    expect(t).not.toContain('lambda = 3');
    expect(t).toContain('z0=0.6, z1=5.3'); // cladding slab baked, not the bad expr
    expect(warnings.some((w) => w.includes("param 'lambda'"))).toBe(true);
    pyCheckAllCells(ipynb, 'vitest_tidy3d_keyword');
  });

  it('throws a user-facing error on an unusable cross-section', () => {
    expect(() => generateTidy3DNotebook({ ok: false, error: 'section line does not intersect the stack' }))
      .toThrow(/section line does not intersect/);
    expect(() => generateTidy3DNotebook(null)).toThrow(/unusable/);
  });

  it('version pin + local-solve statement present', () => {
    const { ipynb } = generateTidy3DNotebook(FIXTURE_CROSS);
    const nb = JSON.parse(ipynb);
    expect(codeText(nb)).toContain('tidy3d[extras]>=2.7,<3');
    expect(mdTextAll(nb)).toContain('no Tidy3D cloud account');
  });
});
