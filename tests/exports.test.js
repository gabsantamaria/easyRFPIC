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
