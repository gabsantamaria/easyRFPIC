// computeNumericLayerZ (src/scene/layer-z.js) — the numeric stack walk
// extracted from generatePyAEDT. Hand-computed expectations mirror the
// semantics documented in CLAUDE.md "Per-layer Z": coplanar-group members
// share zBottom; the cursor advances past a group by its cladding top;
// ungrouped layers stack sequentially; Z=0 pins at the first device-role
// or grouped layer (substrates below go negative).
import { describe, it, expect } from 'vitest';
import { computeNumericLayerZ } from '../src/scene/layer-z.js';
import { makeDefaultScene } from '../src/scene/schema.js';
import { resolveParams } from '../src/scene/params.js';

describe('computeNumericLayerZ', () => {
  it('2-layer sequential stack: substrate below Z=0, device above', () => {
    const stack = [
      { id: 'sub', thickness: 'h_sub', role: 'substrate' },
      { id: 'metal', thickness: 'h_m', role: 'conductor' },
    ];
    const z = computeNumericLayerZ(stack, { h_sub: 2, h_m: 3 });
    expect(z.sub).toEqual({ zBottom: -2, zTop: 0, thickness: 2 });
    expect(z.metal).toEqual({ zBottom: 0, zTop: 3, thickness: 3 });
  });

  it('coplanar group: members share zBottom; group advances by cladding top', () => {
    const stack = [
      { id: 'sub', thickness: '10', role: 'substrate' },
      { id: 'cond', thickness: '0.8', role: 'conductor', coplanarGroup: 'g' },
      { id: 'wg', thickness: '0.6', role: 'waveguide', coplanarGroup: 'g' },
      { id: 'clad', thickness: '0.6', role: 'cladding', coplanarGroup: 'g' },
      { id: 'cond2', thickness: '1', role: 'conductor' },
    ];
    const z = computeNumericLayerZ(stack, {});
    expect(z.sub).toEqual({ zBottom: -10, zTop: 0, thickness: 10 });
    // All group members share zBottom = 0 (even the thicker conductor).
    expect(z.cond).toEqual({ zBottom: 0, zTop: 0.8, thickness: 0.8 });
    expect(z.wg).toEqual({ zBottom: 0, zTop: 0.6, thickness: 0.6 });
    expect(z.clad).toEqual({ zBottom: 0, zTop: 0.6, thickness: 0.6 });
    // The layer ABOVE the group starts at the group's CLADDING top (0.6),
    // not at the thickest member's top (0.8).
    expect(z.cond2).toEqual({ zBottom: 0.6, zTop: 1.6, thickness: 1 });
  });

  it('malformed group with no cladding advances by the thickest member', () => {
    const stack = [
      { id: 'a', thickness: '0.5', role: 'conductor', coplanarGroup: 'g' },
      { id: 'b', thickness: '1.2', role: 'waveguide', coplanarGroup: 'g' },
      { id: 'top', thickness: '2', role: 'conductor' },
    ];
    const z = computeNumericLayerZ(stack, {});
    expect(z.a.zBottom).toBe(0);
    expect(z.b.zBottom).toBe(0);
    expect(z.top.zBottom).toBeCloseTo(1.2, 12);
  });

  it('non-finite thickness falls back to 1 (matches the old pyAEDT walk)', () => {
    // evalExpr on a STRING never returns non-finite (it clamps to 0); the
    // fallback only triggers for a non-finite NUMERIC thickness. Distinct
    // explicit coplanarGroups keep the two layers sequential (a group-less
    // adjacent device run would be auto-grouped by the legacy migration).
    const z = computeNumericLayerZ([
      { id: 'x', thickness: NaN, role: 'conductor', coplanarGroup: 'gx' },
      { id: 'y', thickness: '2', role: 'conductor', coplanarGroup: 'gy' },
    ], {});
    expect(z.x).toEqual({ zBottom: 0, zTop: 1, thickness: 1 });
    expect(z.y.zBottom).toBe(1);
  });

  it('default scene: device group pinned at Z=0, substrates negative', () => {
    const scene = makeDefaultScene();
    const pv = resolveParams(scene.params).values;
    const z = computeNumericLayerZ(scene.stack, pv);
    const wgLayer = scene.stack.find(l => l.role === 'waveguide');
    const condLayer = scene.stack.find(l => l.role === 'conductor');
    expect(z[wgLayer.id].zBottom).toBe(0);
    expect(z[wgLayer.id].zTop).toBeCloseTo(pv.h_wg, 9);
    expect(z[condLayer.id].zBottom).toBe(0);
    expect(z[condLayer.id].zTop).toBeCloseTo(pv.h_cond, 9);
    // Substrates below the device level are negative.
    const sub = scene.stack.find(l => l.role === 'substrate');
    expect(z[sub.id].zTop).toBeLessThanOrEqual(0);
  });
});
