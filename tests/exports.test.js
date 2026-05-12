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
});
