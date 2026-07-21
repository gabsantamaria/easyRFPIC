// Cladding subtract: clone + unite + subtract (abutting-tools guard).
//
// HFSS executes a multi-tool Subtract sequentially. A fractured GDS layer
// contains EXACTLY ABUTTING solids: after an earlier tool's cavity is cut
// out of the cladding, a later abutting tool's face lies exactly ON the
// cavity wall — a partial coincident-face boolean that Parasolid rejects
// (PK_ERROR_missing_geom) and that NULLS the blank, leaving the design
// with no cladding at all (real shipped failure on the KI-lumped design:
// gds1_12's bottom edge exactly abutting gds1_7/gds1_8's top edges).
//
// The exporter therefore clones every cladding tool at RUNTIME
// (Copy+Paste, names discovered via a before/after object-list diff —
// Paste naming is release-dependent), unites the clones into ONE body
// (dissolving the shared faces), and subtracts that single body with
// KeepOriginals=False. The device parts themselves are never consumed.
// A failure of any step falls back to the legacy direct multi-tool
// subtract.
import { describe, it, expect } from 'vitest';
import { normalizeScene } from '../src/scene/schema.js';
import { resolveParams } from '../src/scene/params.js';
import { generateHfssNative } from '../src/export/hfss-native.js';

describe('cladding clone-unite subtract', () => {
  const scene = normalizeScene({
    params: {},
    snaps: [],
    components: [
      // Two exactly-abutting electrode solids (the fractured-GDS shape of
      // the shipped failure) + a waveguide.
      { id: 'elA', kind: 'rect', layer: 'electrode', cx: 0, cy: 0, w: '10', h: '5', cutouts: [], transforms: [] },
      { id: 'elB', kind: 'rect', layer: 'electrode', cx: 0, cy: 5, w: '10', h: '5', cutouts: [], transforms: [] },
      { id: 'wgr', kind: 'rect', layer: 'waveguide', cx: 0, cy: 30, w: '100', h: 'w_wg', cutouts: [], transforms: [] },
    ],
  });
  const { values } = resolveParams(scene.params);
  const code = generateHfssNative(scene, values);

  it('clones the tools via Copy+Paste with runtime name discovery', () => {
    const copy = code.match(/oEditor\.Copy\(\["NAME:Selections", "Selections:=", "([^"]+)"\]\)/);
    expect(copy).toBeTruthy();
    const tools = copy[1].split(',');
    expect(tools).toContain('elA');
    expect(tools).toContain('elB');
    expect(tools).toContain('wgr_wg_slab');
    expect(tools).toContain('wgr_wg_rib');
    expect(code).toContain('oEditor.Paste()');
    expect(code).toContain('_clad_before');
    expect(code).toMatch(/_clad_new = \[\]/);
  });

  it('unites the clones and subtracts the single united body, consumed', () => {
    expect(code).toMatch(/oEditor\.Unite\(\s*\["NAME:Selections", "Selections:=", ",".join\(_clad_new\)/);
    expect(code).toMatch(/"Blank Parts:=", "l_clad", "Tool Parts:=", _clad_new\[0\]\],\s*\["NAME:SubtractParameters", "KeepOriginals:=", False\]/);
  });

  it('keeps the legacy direct multi-tool subtract as the fallback branch', () => {
    const m = code.match(/Blank Parts:=", "l_clad", "Tool Parts:=", "([^"]+)"\],\s*\["NAME:SubtractParameters", "KeepOriginals:=", True\]/);
    expect(m).toBeTruthy();
    const tools = m[1].split(',');
    expect(tools).toContain('elA');
    expect(tools).toContain('elB');
    expect(code).toContain('falling back to direct subtract');
  });

  it('never consumes the original device parts in the primary path', () => {
    // The primary subtract's tool is the runtime clone survivor, not a
    // device part name; only the FALLBACK references device names, with
    // KeepOriginals True.
    const primary = code.match(/Tool Parts:=", _clad_new\[0\]/);
    expect(primary).toBeTruthy();
  });
});
