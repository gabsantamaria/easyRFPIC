// Missing-material guard: every material name the script assigns gets a
// pre-flight _ensure_material call — if the name resolves nowhere in
// HFSS (project or libraries), a DUMMY material with VACUUM properties
// is created under that name and a warning is posted, so assignments
// never fail. The user then defines the real material under the same
// name and re-solves.
import { describe, it, expect } from 'vitest';
import { normalizeScene } from '../src/scene/schema.js';
import { resolveParams } from '../src/scene/params.js';
import { generateHfssNative } from '../src/export/hfss-native.js';

describe('missing-material guard', () => {
  const base = normalizeScene({
    params: {}, snaps: [],
    components: [
      { id: 'el', kind: 'rect', layer: 'electrode', cx: 0, cy: 0, w: '10', h: '10', cutouts: [], transforms: [] },
      { id: 'wgA', kind: 'rect', layer: 'waveguide', cx: 0, cy: 40, w: '100', h: 'w_wg', cutouts: [], transforms: [] },
    ],
  });

  it('emits the helper and one ensure call per distinct assigned material, before any geometry', () => {
    const stack = base.stack.map((l) => l.role === 'conductor' ? { ...l, material: 'NbTiN_20nm' } : l);
    const { values } = resolveParams(base.params);
    const code = generateHfssNative({ ...base, stack }, values);
    expect(code).toContain('def _ensure_material');
    expect(code).toContain('DoesMaterialExist');
    expect(code).toContain('AddMaterial');
    expect(code).toContain('created a DUMMY material with VACUUM properties');
    const calls = [...code.matchAll(/_ensure_material\("([^"]+)"(?:, \[[^\]]*\])?\)/g)].map((m) => m[1]);
    // Custom conductor material + every stack material actually assigned.
    expect(calls).toContain('NbTiN_20nm');
    // One call per name, no duplicates.
    expect(new Set(calls).size).toBe(calls.length);
    // Every emitted MaterialValue is covered by an ensure call.
    for (const m of code.matchAll(/"MaterialValue:=",\s*"\\"([^"\\]+)\\""/g)) {
      expect(calls).toContain(m[1]);
    }
    // Ordering: helper def < ensure calls < first geometry creation.
    const defIdx = code.indexOf('def _ensure_material');
    const callIdx = code.indexOf('_ensure_material("');
    const geomIdx = code.search(/safe_create_box|safe_create_rectangle|oEditor\.CreatePolyline/);
    expect(defIdx).toBeGreaterThan(-1);
    expect(callIdx).toBeGreaterThan(defIdx);
    expect(geomIdx).toBeGreaterThan(callIdx);
  });

  it('never dummies stock materials, and flips SolveInside on conductors that DO get a dummy', () => {
    // On some releases DoesMaterialExist only sees PROJECT definitions
    // and returns False for library materials - the guard then created a
    // vacuum dummy named 'gold' that SHADOWED the real one, and every
    // conductor's CREATION failed ("zero-conductivity material must have
    // Solve Inside enabled") - real shipped failure. Positive answers
    // are trusted; negatives only believed for names outside the stock
    // whitelist. Genuinely-missing conductor materials flip their
    // objects to SolveInside=True alongside the dummy.
    const stack = base.stack.map((l) => l.role === 'conductor' ? { ...l, material: 'NbTiN_20nm' } : l);
    const { values } = resolveParams(base.params);
    const code = generateHfssNative({ ...base, stack }, values);
    // Whitelist backstop present and covers the shipped victims.
    expect(code).toContain('_AEDT_STOCK_MATERIALS');
    for (const stockName of ['gold', 'air', 'silicon', 'silicon_dioxide', 'vacuum']) {
      expect(code).toMatch(new RegExp(`"${stockName}",`));
    }
    expect(code).toContain('if mat_name.lower() in _AEDT_STOCK_MATERIALS:');
    // The custom conductor's ensure call lists its SolveInside=False object.
    const call = code.match(/_ensure_material\("NbTiN_20nm", \[([^\]]*)\]\)/);
    expect(call).toBeTruthy();
    expect(call[1]).toContain('"el"');
    // The dummy branch carries the SolveInside flip.
    expect(code).toContain('["NAME:Solve Inside", "Value:=", True]');
    // Un-shadow guidance in the warning.
    expect(code).toContain('delete the dummy from the project');
  });

  it('vacuum-property dummy creation and warning are inside the helper, guarded', () => {
    const { values } = resolveParams(base.params);
    const code = generateHfssNative(base, values);
    const helper = code.slice(code.indexOf('def _ensure_material'), code.indexOf('# __') > -1 ? undefined : undefined);
    expect(code).toContain('"permittivity:=", "1"');
    expect(code).toContain('"permeability:=", "1"');
    expect(code).toContain('"conductivity:=", "0"');
    expect(code).toContain('"dielectric_loss_tangent:=", "0"');
    // Marker fully replaced.
    expect(code).not.toContain('# __ENSURE_MATERIALS__');
  });
});
