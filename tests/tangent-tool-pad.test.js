// Tangent subtract-tool pads (Parasolid boolean guard).
//
// A subtract/punch TOOL rect whose edge sits EXACTLY on the blank's true
// bbox extreme makes the tool face exactly TANGENT to the blank's curved
// face — Parasolid rejects the boolean (PK_ERROR_missing_geom / "invalid
// parameters to Subtract operation"), a real shipped failure: a split-ring
// tuner cut a circle (r=tuner_R) with a rect of height 2*tuner_R (top/
// bottom tangent) and a slit rect of width tuner_R ending exactly at the
// circle's apex. generateHfssNative inflates each tangent tool edge
// OUTWARD by 10 nm — beyond the tangent point there is no blank material,
// so the subtract result is geometrically identical, and because the tie
// is parametric the constant pad stays valid under HFSS-side sweeps.
//
// Detection must use kind-aware TRUE dims (circle → 2*r), because the
// stored w/h AABB can be stale (the shipped design had r='tuner_R' but
// w='2*circ66_r' still referencing the orphaned auto-param), and must
// recurse chained subtract blanks to the base primitive.
import { describe, it, expect } from 'vitest';
import { normalizeScene } from '../src/scene/schema.js';
import { resolveParams } from '../src/scene/params.js';
import { generateHfssNative } from '../src/export/hfss-native.js';

const rect = (id, cx, cy, w, h, extra = {}) => ({
  transforms: [], id, kind: 'rect', layer: 'electrode', cx, cy, w, h, cutouts: [], ...extra,
});
const circle = (id, cx, cy, r, extra = {}) => ({
  transforms: [], id, kind: 'circle', layer: 'electrode', cx, cy, r, w: `2*(${r})`, h: `2*(${r})`, cutouts: [], ...extra,
});
const boolOp = (id, op, operandIds, extra = {}) => ({
  id, kind: 'boolean', op, operandIds, layer: 'electrode', cx: 0, cy: 0, w: '0', h: '0', cutouts: [], transforms: [], ...extra,
});

// Extract the emitted creation record (rect sheet or box) for a part.
const recordFor = (script, id) => {
  const at = script.indexOf(`"Name:=", "${id}"`);
  expect(at).toBeGreaterThan(-1);
  const seg = script.slice(Math.max(0, at - 1400), at);
  // LAST match in the window — the window can contain the tail of the
  // previous component's record.
  const ms = [...seg.matchAll(/"(?:XStart|XPosition):=", "([^"]+)", "(?:YStart|YPosition):=", "([^"]+)", "(?:ZStart|ZPosition):=", "[^"]*",\s*"(?:Width|XSize):=", "([^"]+)", "(?:Height|YSize):=", "([^"]+)"/g)];
  expect(ms.length).toBeGreaterThan(0);
  const m = ms[ms.length - 1];
  return { x: m[1], y: m[2], w: m[3], h: m[4] };
};

const gen = (components, params = {}) => {
  const scene = normalizeScene({ params, components, snaps: [] });
  const { values } = resolveParams(scene.params);
  return generateHfssNative(scene, values);
};

describe('tangent subtract-tool pads', () => {
  it('pads N+S edges of a tool rect exactly tangent to the blank circle (shipped split-ring case)', () => {
    // Circle r=R0 at origin; tool rect of height 2*R0 centered on cy —
    // top/bottom edges exactly tangent — covering the left part (real cut
    // on its E edge, which must stay UNPADDED).
    const script = gen([
      circle('blank', 0, 0, 'R0', { consumedBy: 'd1' }),
      rect('tool', -10, 0, '2*R0', '2*R0', { consumedBy: 'd1' }),
      boolOp('d1', 'subtract', ['blank', 'tool']),
    ], { R0: { expr: '25', unit: 'µm' } });
    const r = recordFor(script, 'tool');
    expect(r.h).toContain('+ 0.02um');       // both Y edges padded
    expect(r.y).toContain('- 0.01um');       // min side shifted down
    expect(r.w).not.toContain('0.01um');     // E edge is a REAL cut — untouched
    expect(r.x).not.toContain('0.01um');
    expect(script).toContain('tool: subtract-tool edge(s) S,N inflated 0.01um');
  });

  it('pads only the apex edge of a slit tool ending exactly at the circle apex, and survives a STALE w/h AABB', () => {
    // The shipped design's exact shape: blank circle's stored w/h still
    // reference an orphaned auto-param (stale 31.048) while r is bound to
    // R0=25 — detection must follow r, not w/h. Slit rect from center to
    // apex: E edge exactly at cx + R0.
    const script = gen([
      circle('blank', 100, 0, 'R0', { w: '2*stale_r', h: '2*stale_r', consumedBy: 'd1' }),
      rect('slit', 112.5, 0, 'R0', 'G0', { consumedBy: 'd1' }), // E edge = 100 + 12.5 + 12.5 = 125 = cx + R0
      boolOp('d1', 'subtract', ['blank', 'slit']),
    ], { R0: { expr: '25', unit: 'µm' }, stale_r: { expr: '31.048', unit: 'µm' }, G0: { expr: '4', unit: 'µm' } });
    const r = recordFor(script, 'slit');
    expect(r.w).toContain('+ 0.01um');       // apex edge only
    expect(r.x).not.toContain('0.01um');     // W edge inside the blank — untouched
    expect(r.h).not.toContain('0.01um');
    expect(script).toContain('slit: subtract-tool edge(s) E inflated 0.01um');
  });

  it('recurses chained subtract blanks to the base primitive', () => {
    // d2's blank is d1 (a boolean) — the tangency is against the BASE
    // circle's boundary, which the recursion must reach.
    const script = gen([
      circle('base', 0, 0, 'R0', { consumedBy: 'd1' }),
      rect('cut1', -10, 0, '2*R0', '2*R0', { consumedBy: 'd1' }),
      boolOp('d1', 'subtract', ['base', 'cut1'], { consumedBy: 'd2' }),
      rect('cut2', 12.5, 0, 'R0', 'G0', { consumedBy: 'd2' }), // E edge = 25 = apex
      boolOp('d2', 'subtract', ['d1', 'cut2']),
    ], { R0: { expr: '25', unit: 'µm' }, G0: { expr: '4', unit: 'µm' } });
    const r = recordFor(script, 'cut2');
    expect(r.w).toContain('+ 0.01um');
    expect(script).toContain('cut2: subtract-tool edge(s) E inflated 0.01um');
  });

  it('leaves non-tangent tools and non-subtract booleans byte-identical', () => {
    // Tool strictly inside the blank (all edges are real cuts) → no pad;
    // union operands → never padded.
    const script = gen([
      circle('blank', 0, 0, 'R0', { consumedBy: 'd1' }),
      rect('inner', 0, 0, '10', '10', { consumedBy: 'd1' }),
      boolOp('d1', 'subtract', ['blank', 'inner']),
      rect('ua', 200, 0, '20', '10', { consumedBy: 'u1' }),
      rect('ub', 210, 0, '20', '10', { consumedBy: 'u1' }),
      boolOp('u1', 'union', ['ua', 'ub']),
    ], { R0: { expr: '25', unit: 'µm' } });
    expect(script).not.toContain('subtract-tool edge');
    const r = recordFor(script, 'inner');
    expect(r.w).toBe('(10um)');
    expect(r.h).toBe('(10um)');
  });

  it('skips a BOOLEAN blank carrying its own enabled transform chain', () => {
    // The blank boolean's chain (Move/DuplicateAlongLine) is emitted
    // BEFORE the outer Subtract, so the outer subtract operates on the
    // TRANSFORMED blank — a base-frame tangency test would false-pad an
    // edge that is a genuine interior cut of the moved blank (removing
    // real metal) and miss the true tangent edge at the transformed
    // pose. Adversarial-review find: the gate must null transformed
    // boolean blanks, not just transformed primitives.
    const mk = (transforms) => gen([
      circle('base', 0, 0, 'R0', { consumedBy: 'd1' }),
      rect('cut1', 0, 20, '4', '4', { consumedBy: 'd1' }),
      boolOp('d1', 'subtract', ['base', 'cut1'], { consumedBy: 'd2', transforms }),
      rect('tool', 12.5, 0, 'R0', '4', { consumedBy: 'd2' }), // E edge = 25 = base-frame apex
      boolOp('d2', 'subtract', ['d1', 'tool']),
    ], { R0: { expr: '25', unit: 'µm' } });
    // Displaced blank: the base-frame apex is interior to the moved
    // blank — NO pad allowed.
    const moved = mk([{ id: 't1', kind: 'displace', enabled: true, dx: '10', dy: '0' }]);
    expect(moved).not.toContain('subtract-tool edge');
    // Same chain DISABLED: genuine tangency again — pad required.
    const still = mk([{ id: 't1', kind: 'displace', enabled: false, dx: '10', dy: '0' }]);
    expect(still).toContain('tool: subtract-tool edge(s) E inflated 0.01um');
  });

  it('skips rotated and transform-carrying tools (conservative gate)', () => {
    const script = gen([
      circle('blank', 0, 0, 'R0', { consumedBy: 'd1' }),
      rect('rotTool', -10, 0, '2*R0', '2*R0', { rotation: '30', consumedBy: 'd1' }),
      boolOp('d1', 'subtract', ['blank', 'rotTool']),
      circle('blank2', 300, 0, 'R0', { consumedBy: 'd2' }),
      rect('chainTool', 290, 0, '2*R0', '2*R0', {
        consumedBy: 'd2',
        transforms: [{ id: 't1', kind: 'displace', enabled: true, dx: '5', dy: '0' }],
      }),
      boolOp('d2', 'subtract', ['blank2', 'chainTool']),
    ], { R0: { expr: '25', unit: 'µm' } });
    expect(script).not.toContain('subtract-tool edge');
  });
});
