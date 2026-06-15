// Smoke tests for the three exporters. Each runs the default scene
// through the exporter and checks for a few load-bearing strings /
// counts, then validates the Python outputs parse.
import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import { writeFileSync, mkdirSync } from 'fs';
import { generateGDS } from '../src/export/gds.js';
import { generatePyAEDT } from '../src/export/pyaedt.js';
import { generateHfssNative } from '../src/export/hfss-native.js';
import { makeDefaultScene, makeBlankScene } from '../src/scene/schema.js';
import { resolveParams, topoSortParams } from '../src/scene/params.js';

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

describe('model units forced to um (bare-literal expression regression)', () => {
  // A param like ai2_cap_g = "w_slab+0.6" has a bare literal (0.6 = 0.6 um in
  // app convention). HFSS/pyAEDT read additive bare literals in the model
  // unit (default mm) — so the exporters must set the model unit to um up
  // front, or 0.6 becomes 0.6 mm and dimensions blow up (negative/huge).
  function bareLiteralScene() {
    const s = makeBlankScene();
    s.params = {
      ...s.params,
      gap: { expr: 'w_slab+0.6', unit: 'um', desc: '' }, // bare additive 0.6
      sep_y: { expr: '60 - 2*w_wg - gap', unit: 'um', desc: '' },
    };
    s.components.push({
      id: 'bar', kind: 'rect', layer: 'electrode', cx: 0, cy: 0,
      w: '40', h: 'sep_y', cutouts: [], transforms: [],
    });
    return s;
  }

  it('HFSS-native sets model units to um BEFORE any variable/geometry', () => {
    const code = generateHfssNative(bareLiteralScene(), resolveParams(bareLiteralScene().params).values);
    expect(code).toMatch(/SetModelUnits\([\s\S]*?"Units:=",\s*"um"/);
    expect(code.indexOf('SetModelUnits')).toBeGreaterThan(-1);
    expect(code.indexOf('SetModelUnits')).toBeLessThan(code.indexOf('set_var("'));
    // the bare-literal expr is still emitted verbatim (now interpreted as um)
    expect(code).toContain('w_slab+0.6');
  });

  // Regression: SetModelUnits MUST use Rescale=True. Rescale=False relabels the
  // (default mm) design to um without rescaling the Parasolid size box, which
  // shrinks the working volume ~1000x; a lambda/4 open-region air box (tens of
  // mm at RF) then lands "outside the size box" and geometry (e.g. swept rib
  // bodies) aborts, cascading to "<part> is not found". See the wg2_wg_rib bug.
  it('HFSS-native SetModelUnits uses Rescale=True (preserve the size box)', () => {
    const code = generateHfssNative(bareLiteralScene(), resolveParams(bareLiteralScene().params).values);
    expect(code).toMatch(/SetModelUnits\([\s\S]*?"Units:=",\s*"um",\s*"Rescale:=",\s*True/);
    expect(code).not.toMatch(/SetModelUnits\([\s\S]*?"Rescale:=",\s*False/);
  });

  it('pyAEDT sets model units to um (Rescale=True) before parameter assignment', () => {
    const code = generatePyAEDT(bareLiteralScene(), resolveParams(bareLiteralScene().params).values);
    // Direct COM call with Rescale=True, NOT the model_units setter (which
    // forces Rescale=False and would shrink the size box — see regression above).
    expect(code).toMatch(/SetModelUnits\([\s\S]*?"Units:=",\s*"um",\s*"Rescale:=",\s*True/);
    expect(code).not.toContain('hfss.modeler.model_units = "um"');
    expect(code.indexOf('SetModelUnits')).toBeLessThan(code.indexOf('hfss["'));
  });
});

describe('topoSortParams — dependency ordering', () => {
  it('orders a referenced param before the param that references it', () => {
    const params = {
      a: { expr: 'b + 1' },   // forward reference: a needs b
      b: { expr: '5' },
    };
    const order = topoSortParams(params);
    expect(order.indexOf('b')).toBeLessThan(order.indexOf('a'));
  });

  it('handles a chain and keeps independents in declaration order', () => {
    const params = {
      x: { expr: '1' },
      sep: { expr: 'd - 2*w' }, // needs d and w
      w: { expr: '1' },
      d: { expr: '60' },
      y: { expr: '2' },
    };
    const order = topoSortParams(params);
    expect(order.indexOf('d')).toBeLessThan(order.indexOf('sep'));
    expect(order.indexOf('w')).toBeLessThan(order.indexOf('sep'));
    // every name present exactly once
    expect(new Set(order).size).toBe(5);
  });

  it('does not loop on a cycle (emits remaining in declaration order)', () => {
    const order = topoSortParams({ a: { expr: 'b' }, b: { expr: 'a' } });
    expect(order.sort()).toEqual(['a', 'b']);
  });

  it('ignores math builtins and unknown identifiers as dependencies', () => {
    const order = topoSortParams({ r: { expr: 'sin(theta) + 1' } });
    expect(order).toEqual(['r']); // theta not a param, sin is reserved → no deps
  });
});

describe('forward-referencing params emit in dependency order (KI_lumped regression)', () => {
  // Repro of the user's bug: a param defined EARLY in the object that
  // references a param defined LATER. HFSS set_var / pyAEDT assignment
  // evaluate each expression at creation time, so the early one must be
  // emitted AFTER the one it references — otherwise HFSS reports
  // "<name> is not a defined variable name in this context".
  function forwardRefScene() {
    const s = makeBlankScene();
    // Insertion order mirrors the bug: cap_sep_y (references loop_D) BEFORE loop_D.
    s.params = {
      ...s.params,
      cap_sep_y: { expr: 'loop_D - 2*cap_w - cap_g', unit: 'um', desc: '' },
      cap_w: { expr: '1', unit: 'um', desc: '' },
      cap_g: { expr: 'w_slab + 0.6', unit: 'um', desc: '' },
      loop_D: { expr: '59.6', unit: 'um', desc: '' },
    };
    s.components.push({
      id: 'cap', kind: 'rect', layer: 'electrode', cx: 0, cy: 0,
      w: 'cap_w', h: 'cap_sep_y', cutouts: [], transforms: [],
    });
    return s;
  }
  const indexOfDef = (code, re, name) => {
    const lines = code.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(re);
      if (m && m[1] === name) return i;
    }
    return -1;
  };

  it('HFSS set_var defines loop_D before cap_sep_y', () => {
    const s = forwardRefScene();
    const { values: v } = resolveParams(s.params);
    const code = generateHfssNative(s, v);
    const re = /set_var\("([A-Za-z_][A-Za-z0-9_]*)"/;
    const dep = indexOfDef(code, re, 'loop_D');
    const user = indexOfDef(code, re, 'cap_sep_y');
    expect(dep).toBeGreaterThan(-1);
    expect(user).toBeGreaterThan(-1);
    expect(dep).toBeLessThan(user);
    // w_slab (referenced by cap_g) before cap_g too
    expect(indexOfDef(code, re, 'w_slab')).toBeLessThan(indexOfDef(code, re, 'cap_g'));
  });

  it('pyAEDT assigns loop_D before cap_sep_y', () => {
    const s = forwardRefScene();
    const { values: v } = resolveParams(s.params);
    const code = generatePyAEDT(s, v);
    const re = /hfss\["([A-Za-z_][A-Za-z0-9_]*)"\]\s*=/;
    expect(indexOfDef(code, re, 'loop_D')).toBeLessThan(indexOfDef(code, re, 'cap_sep_y'));
  });
});

describe('CreatePolyline segment indices stay in range (racetrack HFSS-reject regression)', () => {
  // HFSS rejects a CreatePolyline two ways: (1) a PLSegment that references a
  // nonexistent point index, and (2) any zero/near-zero-length Line segment.
  // The tessellated racetrack hit BOTH — its centerline is sampled as an
  // implicitly-closed loop (last sample ~0.2 nm from the first), so a naive
  // close produced a sub-nm segment. The export now dedupes near-coincident
  // vertices and emits N distinct points + (N-1) segments + IsPolylineClosed.
  function maxSegRefViolations(code) {
    const calls = code.split('oEditor.CreatePolyline(').slice(1);
    const bad = [];
    calls.forEach((call, i) => {
      const block = call.slice(0, call.indexOf('["NAME:Attributes"'));
      const numPts = (block.match(/"NAME:PLPoint"/g) || []).length;
      let maxRef = -1;
      for (const m of block.matchAll(/"NAME:PLSegment"[^\]]*?"StartIndex:=",\s*(\d+),\s*"NoOfPoints:=",\s*(\d+)/g)) {
        maxRef = Math.max(maxRef, Number(m[1]) + Number(m[2]) - 1);
      }
      if (maxRef >= numPts) bad.push({ call: i, numPts, maxRef });
    });
    return bad;
  }

  // Smallest edge length (consecutive points, plus the implicit closing edge
  // for closed polylines) across every CreatePolyline. Must stay well above
  // zero or HFSS rejects with "invalid parameters to CreatePolyline".
  function minSegmentLength(code) {
    const calls = code.split('oEditor.CreatePolyline(').slice(1);
    let dmin = Infinity;
    for (const call of calls) {
      const block = call.slice(0, call.indexOf('["NAME:Attributes"'));
      const closed = /"IsPolylineClosed:=",\s*True/.test(block);
      const pts = [...block.matchAll(/"X:=",\s*"([-\d.]+)um",\s*"Y:=",\s*"([-\d.]+)um"/g)].map((m) => [Number(m[1]), Number(m[2])]);
      if (pts.length < 2) continue;
      for (let k = 1; k < pts.length; k++) dmin = Math.min(dmin, Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]));
      if (closed) dmin = Math.min(dmin, Math.hypot(pts[pts.length - 1][0] - pts[0][0], pts[pts.length - 1][1] - pts[0][1]));
    }
    return dmin;
  }

  function racetrackScene() {
    const s = makeBlankScene();
    s.params = {
      ...s.params,
      rt_R: { expr: '21.65', unit: 'um', desc: '' },
      rt_L: { expr: '216.9', unit: 'um', desc: '' },
    };
    s.components.push({
      id: 'rt', kind: 'racetrack', layer: 'waveguide', cx: 0, cy: 0,
      R: 'rt_R', L_straight: 'rt_L', p: '1', wgWidth: 'w_wg',
      // Non-zero AABB so the exporter's zero-dimension guard doesn't skip it
      // (the real template derives these; the shape itself uses R/L/p/wgWidth).
      w: 'rt_L + 2*rt_R + w_wg', h: '2*rt_R + w_wg', cutouts: [], transforms: [],
    });
    return s;
  }

  it('racetrack outer + inner polylines reference only existing points, no near-zero segments', () => {
    const s = racetrackScene();
    const { values: v } = resolveParams(s.params);
    const code = generateHfssNative(s, v);
    expect(maxSegRefViolations(code)).toEqual([]);
    // The actual HFSS-reject cause: a sub-nm closing edge. Every edge
    // (including the implicit close) must be a real, non-degenerate length.
    expect(minSegmentLength(code)).toBeGreaterThan(1e-3);
    // Canonical closed form: N distinct points, N-1 Line segments.
    const rtBlock = code.slice(code.indexOf('racetrack as polygonal sheet'));
    const call = rtBlock.slice(rtBlock.indexOf('oEditor.CreatePolyline('));
    const params = call.slice(0, call.indexOf('["NAME:Attributes"'));
    const pts = (params.match(/"NAME:PLPoint"/g) || []).length;
    const segs = (params.match(/"NAME:PLSegment"/g) || []).length;
    expect(pts).toBeGreaterThan(3);
    expect(segs).toBe(pts - 1);
  });

  it('the default scene has no out-of-range polyline segments either', () => {
    expect(maxSegRefViolations(generateHfssNative(scene, values))).toEqual([]);
  });
});

describe('closed polylines use explicit closure, not IsPolylineClosed=True (Parasolid regression)', () => {
  // HFSS's auto-close (IsPolylineClosed=True) is unreliable for covered /
  // swept polylines — it fails with "PK_CURVE_make_wire_body_2 ...
  // cant_extract_geom" / "invalid parameters to CreatePolyline" (this killed
  // the straight-waveguide rib wg2_wg_rib). Every covered closed polyline
  // must instead close EXPLICITLY: append a repeat of the first point, emit
  // a Line segment per edge incl. the closing one, and set
  // IsPolylineClosed=False. Invariants checked: (a) no polyline sets
  // IsPolylineClosed=True while its first PLPoint equals its last (the
  // redundant zero-length close); (b) no polyline relies on auto-close —
  // i.e. none uses IsPolylineClosed=True at all in the geometry paths.
  function badClosedPolylines(code) {
    const calls = code.split('oEditor.CreatePolyline(').slice(1);
    const bad = [];
    calls.forEach((call) => {
      const block = call.slice(0, call.indexOf('["NAME:Attributes"'));
      if (!block.includes('PLPoint')) return;
      if (/"IsPolylineClosed:=",\s*True/.test(block)) {
        bad.push((call.match(/Name:=",\s*"([^"]+)"/) || [])[1] || '?');
      }
    });
    return bad;
  }

  function straightWgScene() {
    const s = makeBlankScene();
    s.components.push({
      id: 'wg', kind: 'rect', layer: 'waveguide', cx: 0, cy: 0,
      w: '300', h: 'w_wg', cutouts: [], transforms: [],
    });
    return s;
  }

  it('straight-waveguide rib closes explicitly (5 points, 4 segments, closed=False)', () => {
    const s = straightWgScene();
    const code = generateHfssNative(s, resolveParams(s.params).values);
    expect(badClosedPolylines(code)).toEqual([]);
    const block = code.slice(code.indexOf('wg_rib_xsec'));
    const call = block.slice(0, block.indexOf('["NAME:Attributes"'));
    // 4 distinct corners + a closing repeat of the first = 5 points, 4 segs.
    expect((call.match(/"NAME:PLPoint"/g) || []).length).toBe(5);
    expect((call.match(/"NAME:PLSegment"/g) || []).length).toBe(4);
    expect(call).toMatch(/"IsPolylineClosed:=",\s*False/);
    // First and last points coincide (explicit closure).
    const pts = [...call.matchAll(/"X:=",\s*"([^"]+)",\s*"Y:=",\s*"([^"]+)",\s*"Z:=",\s*"([^"]+)"/g)].map((m) => m.slice(1).join('|'));
    expect(pts[0]).toBe(pts[pts.length - 1]);
  });

  it('tapered polyline, rounded rect, and polyshape close explicitly (no auto-close)', () => {
    // tapered polyline (per-segment quad sheets)
    const taper = makeBlankScene();
    taper.components.push({
      id: 'tp', kind: 'polyline', layer: 'electrode', cx: 0, cy: 0, w: '0', h: '0', closed: false,
      vertices: [{ kind: 'rel', dx: '0', dy: '0', width: '4' }, { kind: 'rel', dx: '60', dy: '0', width: '12' }],
      cutouts: [], transforms: [],
    });
    expect(badClosedPolylines(generateHfssNative(taper, resolveParams(taper.params).values))).toEqual([]);

    // rounded rect (arc-closed contour)
    const rr = makeBlankScene();
    rr.components.push({ id: 'rr', kind: 'rect', layer: 'electrode', cx: 0, cy: 0, w: '40', h: '30', cornerRadius: '5', cutouts: [], transforms: [] });
    expect(badClosedPolylines(generateHfssNative(rr, resolveParams(rr.params).values))).toEqual([]);

    // polyshape (covered closed polygon)
    const ps = makeBlankScene();
    ps.components.push({
      id: 'ps', kind: 'polyshape', layer: 'electrode', cx: 0, cy: 0, w: '0', h: '0', closed: true,
      vertices: [{ kind: 'rel', dx: '0', dy: '0' }, { kind: 'rel', dx: '20', dy: '0' }, { kind: 'rel', dx: '0', dy: '15' }, { kind: 'rel', dx: '-20', dy: '0' }],
      cutouts: [], transforms: [],
    });
    expect(badClosedPolylines(generateHfssNative(ps, resolveParams(ps.params).values))).toEqual([]);
  });
});

describe('cladding subtract wraps repeat clones, not just base parts (KI_lumped wg2 regression)', () => {
  // The cladding Subtract tool list was built from base part names only, so
  // repeat-/mirror-cloned electrodes and waveguides stayed buried inside
  // solid cladding (the right-half / extra rows looked "missing" in HFSS).
  // The tool list must include each component's transform clones too.
  it('includes <id>_1 electrode clones and <id>_wg_{slab,rib}_1 waveguide clones', () => {
    const s = makeBlankScene();
    s.components.push(
      {
        id: 'el', kind: 'rect', layer: 'electrode', cx: 0, cy: 0, w: '20', h: '5', cutouts: [],
        transforms: [{ kind: 'repeat', enabled: true, n: '1', dx: '50', dy: '0', includeOriginal: true }],
      },
      {
        id: 'wgr', kind: 'rect', layer: 'waveguide', cx: 0, cy: 30, w: '100', h: 'w_wg', cutouts: [],
        transforms: [{ kind: 'repeat', enabled: true, n: '1', dx: '50', dy: '0', includeOriginal: true }],
      },
    );
    const { values: v } = resolveParams(s.params);
    const code = generateHfssNative(s, v);
    const m = code.match(/Blank Parts:=", "l_clad", "Tool Parts:=", "([^"]+)"/);
    expect(m).toBeTruthy();
    const tools = m[1].split(',');
    // electrode: base + its repeat clone
    expect(tools).toContain('el');
    expect(tools).toContain('el_1');
    // waveguide rib: base slab+rib AND their clones
    expect(tools).toContain('wgr_wg_slab');
    expect(tools).toContain('wgr_wg_rib');
    expect(tools).toContain('wgr_wg_slab_1');
    expect(tools).toContain('wgr_wg_rib_1');
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

  it('boolean parent passes parametric chain through to its base operand', () => {
    // A child snapped to a boolean's anchor must inherit the boolean's
    // parametric chain — NOT a frozen numeric snapshot. For subtract /
    // intersect / punch booleans the bbox is the base operand's bbox,
    // so the child's chain expression should reach back through the
    // base operand's own parametric chain (and thus track every
    // parameter that feeds it). The earlier regression: changing a
    // slab-related variable in HFSS shifted the boolean's operands but
    // left the child stranded because the child's chain had numeric
    // literals for the boolean's cx / w.
    const s = {
      params: {
        gap_p: { expr: '7' },
        feed_w: { expr: '3' },
        child_w: { expr: '15' },
      },
      components: [
        // A primitive whose POSITION depends on a parameter (gap_p).
        { id: 'leaf', kind: 'rect', layer: 'electrode', cx: 100, cy: 0, w: 'feed_w', h: '4', cutouts: [] },
        // A primitive snapped to `leaf` with a gap_p offset, then
        // consumed by a punch boolean.
        { id: 'op', kind: 'rect', layer: 'electrode', cx: 90, cy: 0, w: 'feed_w', h: '4', cutouts: [], consumedBy: 'pb' },
        { id: 'tool', kind: 'rect', layer: 'electrode', cx: 90, cy: 0, w: '1', h: '1', cutouts: [], consumedBy: 'pb' },
        {
          id: 'pb', kind: 'boolean', op: 'punch', operandIds: ['op', 'tool'],
          layer: 'electrode', cx: 90, cy: 0, w: '0', h: '0', cutouts: [],
        },
        // The child rect — snapped to the boolean's W anchor. Its
        // chain must reach all the way back through op → leaf so
        // gap_p still controls its position.
        { id: 'child', kind: 'rect', layer: 'electrode', cx: 70, cy: 0, w: 'child_w', h: '2', cutouts: [] },
      ],
      snaps: [
        // op's NW pins to leaf.SW with a gap_p offset — gap_p in chain.
        { id: 's_op', from: { compId: 'leaf', anchor: 'W' }, to: { compId: 'op', anchor: 'E' }, dx: '-gap_p', dy: '0' },
        // child snapped to the boolean's W.
        { id: 's_child', from: { compId: 'pb', anchor: 'W' }, to: { compId: 'child', anchor: 'E' }, dx: '0', dy: '0' },
      ],
      mirrors: [], groups: [], booleans: [],
      stack: scene.stack, stackName: scene.stackName, simSetup: scene.simSetup,
    };
    const { values: pv } = resolveParams(s.params);
    const out = generateHfssNative(s, pv);
    const nameIdx = out.indexOf('"Name:=", "child"');
    expect(nameIdx).toBeGreaterThan(0);
    const blockStart = out.lastIndexOf('safe_create_', nameIdx);
    const block = out.slice(blockStart, nameIdx);
    const xStart = block.match(/XStart:=", "([^"]+)"/)[1];
    // The child's XStart must reference `gap_p` (proving the chain
    // walked through the boolean's base operand). The earlier bug
    // would leave a numeric `(<solved-cx>um)` instead.
    expect(xStart).toContain('gap_p');
    // And must reference the LEAF's w/h variables (feed_w from `op`),
    // confirming we're passing parametric w/h up through the boolean,
    // not the boolean's solved numeric AABB.
    expect(xStart).toContain('feed_w');
  });

  it('tags boolean-parent numeric w/h with "um" in snap-chain offsets', () => {
    // When a primitive is snapped to a BOOLEAN parent, the parent's w/h
    // is a number written by resolveBooleanBboxes (e.g. 8). Embedding
    // that bare number in the offset expression as just `(8)` causes
    // HFSS to interpret it in the design's base unit (meters) rather
    // than µm, throwing the child off by millions of µm. The boolean's
    // numeric w/h MUST be emitted as `(8um)` inside the snap-chain
    // offset.
    const s = {
      params: { feed_w: { expr: '15' } },
      components: [
        // Two rects unioned into a boolean — its solved w ends up
        // numeric (= operand AABB width), which is the failure mode
        // this test guards.
        { id: 'a', kind: 'rect', layer: 'electrode', cx: 0, cy: 0, w: '3', h: '3', cutouts: [], consumedBy: 'b' },
        { id: 'c', kind: 'rect', layer: 'electrode', cx: 5, cy: 0, w: '3', h: '3', cutouts: [], consumedBy: 'b' },
        {
          id: 'b', kind: 'boolean', op: 'union', operandIds: ['a', 'c'],
          layer: 'electrode', cx: 2.5, cy: 0, w: '0', h: '0', cutouts: [],
        },
        // Child rect snapped to b.W → its parametric chain references b.w/2.
        { id: 'child', kind: 'rect', layer: 'electrode', cx: -10, cy: 0, w: 'feed_w', h: '1', cutouts: [] },
      ],
      snaps: [
        { id: 's1', from: { compId: 'b', anchor: 'W' }, to: { compId: 'child', anchor: 'E' }, dx: '0', dy: '0' },
      ],
      mirrors: [], groups: [], booleans: [],
      stack: scene.stack, stackName: scene.stackName, simSetup: scene.simSetup,
    };
    const { values: pv } = resolveParams(s.params);
    const out = generateHfssNative(s, pv);
    // Locate the safe_create_rectangle / box block whose Attributes
    // name the child component. Scan backward from that name to the
    // preceding safe_create_… opener so we don't accidentally pull
    // some earlier component's XStart.
    const nameIdx = out.indexOf('"Name:=", "child"');
    expect(nameIdx).toBeGreaterThan(0);
    const blockStart = out.lastIndexOf('safe_create_', nameIdx);
    expect(blockStart).toBeGreaterThan(0);
    const block = out.slice(blockStart, nameIdx);
    const xStartMatch = block.match(/XStart:=", "([^"]+)"/);
    expect(xStartMatch).toBeTruthy();
    const xStart = xStartMatch[1];
    // The chain must compose b's bbox from its operand widths, with
    // every bare-numeric term tagged with "um". The exporter now
    // expresses the bbox parametrically as a difference of operand
    // edge expressions (e.g. `((5um) + (3um)/2) - ((0um) - (3um)/2)`),
    // which is even tighter than the previous `(8um)/2` because it
    // also tracks individual operand parameter sweeps. Either form
    // (parametric expansion OR literal `(8um)`) is acceptable —
    // what matters is that EVERY numeric width division has a unit.
    // A bare `(8)/2` or `(3)/2` would be dimensionless (= the bug).
    expect(xStart).not.toMatch(/\((?:[0-9]+(?:\.[0-9]+)?)\)\s*\/\s*2/);
    // And the operand widths (3 each) should show up with units in
    // the bbox expression — confirming we're using the parametric
    // form, not freezing at the numeric AABB.
    expect(xStart).toMatch(/3um|8um/);
  });

  it('emits conductor sheets + near-PEC AssignImpedance when conductor thickness is 0', () => {
    // When h_cond = 0, every electrode should be a 2-D rectangle sheet
    // rather than a 3-D box, and a single AssignImpedance boundary
    // (R=0.001, X=0 Ω/sq) should cover all of them. R=0 exactly is
    // rejected as singular by some HFSS releases — 1 mΩ/sq is a
    // numerically-stable near-PEC surrogate.
    const zeroScene = {
      ...scene,
      params: { ...scene.params, h_cond: { ...(scene.params.h_cond || {}), expr: '0' } },
    };
    const { values: pv } = resolveParams(zeroScene.params);
    const out = generateHfssNative(zeroScene, pv);
    // Electrode sheets are CreateRectangle, not CreateBox.
    const rectCount = (out.match(/safe_create_rectangle/g) || []).length;
    expect(rectCount).toBeGreaterThan(0);
    // Impedance boundary block with R=0.001 (near-PEC), X=0.
    expect(out).toContain('AssignImpedance');
    expect(out).toMatch(/"Resistance:=", "0\.001"/);
    expect(out).toMatch(/"Reactance:=", "0"/);
    // Boundary's object list mentions each default-scene electrode
    // by name. We pick the names dynamically from the loaded scene
    // so the test stays correct when the canonical default scene is
    // refreshed (it's a JSON asset, not source code).
    const electrodes = scene.components.filter(c => c.layer === 'electrode').map(c => c.id);
    expect(electrodes.length).toBeGreaterThan(0);
    for (const id of electrodes) {
      expect(out).toMatch(new RegExp(`"${id}"`));
    }
  });

  it('Subtract on a NESTED boolean (union with repeat) lists every clone as Blank Parts', () => {
    // Nested case: U = union(A, B) carries its own repeat n=2 transform
    // (so U expands to 3 HFSS parts: U, U_1, U_2 after DuplicateAlongLine).
    // D = subtract(U, C). Before the fix, the Subtract only listed "U" in
    // Blank Parts → U_1 and U_2 survived un-cut. Fix: emitTransformChainHfss
    // returns its final part-id list, which gets recorded in
    // finalPartIdsByCompId[U]; the downstream D boolean reads from there
    // and emits all 3 names.
    const condLayerId = scene.stack.find(l => l.role === 'conductor')?.id;
    const minimal = {
      params: { h_cond: { expr: '0.5' }, h_wg: { expr: '0.3' } },
      components: [
        { id: 'A', kind: 'rect', layer: 'electrode', conductorLayerId: condLayerId,
          cx: 0, cy: 0, w: 8, h: 8, cutouts: [], transforms: [], consumedBy: 'U' },
        { id: 'B', kind: 'rect', layer: 'electrode', conductorLayerId: condLayerId,
          cx: 12, cy: 0, w: 8, h: 8, cutouts: [], transforms: [], consumedBy: 'U' },
        { id: 'U', kind: 'boolean', op: 'union', operandIds: ['A', 'B'],
          layer: 'electrode', conductorLayerId: condLayerId,
          cx: 6, cy: 0, w: '0', h: '0', cutouts: [],
          transforms: [{ id: 't1', kind: 'repeat', enabled: true, n: 2, dx: 30, dy: 0, includeOriginal: true }],
          consumedBy: 'D' },
        { id: 'C', kind: 'rect', layer: 'electrode', conductorLayerId: condLayerId,
          cx: 36, cy: 0, w: 4, h: 4, cutouts: [], transforms: [], consumedBy: 'D' },
        { id: 'D', kind: 'boolean', op: 'subtract', operandIds: ['U', 'C'],
          layer: 'electrode', conductorLayerId: condLayerId,
          cx: 0, cy: 0, w: '0', h: '0', cutouts: [], transforms: [] },
      ],
      snaps: [], mirrors: [], groups: [], booleans: [],
      stack: scene.stack, stackName: scene.stackName, simSetup: scene.simSetup,
    };
    const { values: pv } = resolveParams(minimal.params);
    const out = generateHfssNative(minimal, pv);
    // Find the Subtract emitted for D. There are two booleans (U then
    // D); D's Subtract is the only one (U's is a Unite).
    const subMatch = out.match(/oEditor\.Subtract\(\s*\["NAME:Selections",\s*"Blank Parts:=",\s*"([^"]+)",\s*"Tool Parts:=",\s*"([^"]+)"/);
    expect(subMatch).not.toBeNull();
    const blanks = subMatch[1].split(',');
    const tools = subMatch[2].split(',');
    // U has repeat n=2 includeOriginal=true → DuplicateAlongLine NumClones=3
    // → U, U_1, U_2.
    expect(blanks).toEqual(['U', 'U_1', 'U_2']);
    expect(tools).toEqual(['C']);
  });

  it('Subtract on an operand with repeat lists ALL clones as Blank Parts', () => {
    // Regression: a primitive with a repeat transform that becomes the
    // base operand of a Subtract used to lose its clones — only the
    // base instance got the tool subtracted; A_1, A_2, A_3 survived
    // un-cut. Fix: the Subtract's "Blank Parts" enumerates every name
    // the per-primitive transform chain produced, so HFSS's multi-
    // blank Subtract applies the tool to each clone independently.
    const condLayerId = scene.stack.find(l => l.role === 'conductor')?.id;
    const minimal = {
      params: { h_cond: { expr: '0.5' }, h_wg: { expr: '0.3' } },
      components: [
        { id: 'A', kind: 'rect', layer: 'electrode', conductorLayerId: condLayerId,
          cx: 0, cy: 0, w: 20, h: 20, cutouts: [],
          transforms: [{ id: 't1', kind: 'repeat', enabled: true, n: 3, dx: 30, dy: 0, includeOriginal: true }],
          consumedBy: 'BOOL' },
        { id: 'B', kind: 'rect', layer: 'electrode', conductorLayerId: condLayerId,
          cx: 30, cy: 0, w: 10, h: 10, cutouts: [], transforms: [], consumedBy: 'BOOL' },
        { id: 'BOOL', kind: 'boolean', op: 'subtract', operandIds: ['A', 'B'],
          layer: 'electrode', conductorLayerId: condLayerId,
          cx: 0, cy: 0, w: '0', h: '0', cutouts: [], transforms: [] },
      ],
      snaps: [], mirrors: [], groups: [], booleans: [],
      stack: scene.stack, stackName: scene.stackName, simSetup: scene.simSetup,
    };
    const { values: pv } = resolveParams(minimal.params);
    const out = generateHfssNative(minimal, pv);
    // Find the Subtract call and inspect its Blank Parts list.
    const subMatch = out.match(/oEditor\.Subtract\(\s*\["NAME:Selections",\s*"Blank Parts:=",\s*"([^"]+)",\s*"Tool Parts:=",\s*"([^"]+)"/);
    expect(subMatch).not.toBeNull();
    const blanks = subMatch[1].split(',');
    const tools = subMatch[2].split(',');
    // Operand A has repeat n=3 + includeOriginal → 4 instances total.
    expect(blanks).toEqual(['A', 'A_1', 'A_2', 'A_3']);
    expect(tools).toEqual(['B']);
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

describe('generateHfssNative — analysis setup, frequency sweep, Optimetrics', () => {
  // Helper: clone the default scene with a simSetup / params override.
  const sceneWith = (overrides) => ({ ...scene, ...overrides });
  const pyParses = (code, name) => {
    mkdirSync('tests/out', { recursive: true });
    writeFileSync(`tests/out/${name}.py`, code);
    expect(() => execSync(
      `python3 -c "import ast; ast.parse(open('tests/out/${name}.py').read())"`,
      { stdio: 'pipe' }
    )).not.toThrow();
  };

  it('honors simSetup solve frequency, passes, deltaS and emits the frequency sweep', () => {
    const s = sceneWith({
      simSetup: {
        ...scene.simSetup,
        solveFreq: '12', maxPasses: '20', maxDeltaS: '0.01',
        sweepEnabled: true, sweepStart: '1', sweepStop: '40',
        sweepPoints: '391', sweepType: 'Interpolating',
      },
    });
    const out = generateHfssNative(s, values);
    expect(out).toContain('Frequency:=", "12GHz"');
    expect(out).toContain('MaximumPasses:=", 20');
    expect(out).toContain('MaxDeltaS:=", 0.01');
    expect(out).toContain('InsertFrequencySweep');
    expect(out).toContain('RangeStart:=", "1GHz"');
    expect(out).toContain('RangeEnd:=", "40GHz"');
    expect(out).toContain('RangeCount:=", 391');
    expect(out).toContain('Type:=", "Interpolating"');
    // Interpolating extras present for Interpolating sweeps.
    expect(out).toContain('InterpTolerance:=');
    // Still valid Python (IronPython 2.7-safe subset of py3 grammar).
    pyParses(out, 'vitest_hfss_setup');
  });

  it('falls back to fnominal when solveFreq is empty', () => {
    const s = sceneWith({
      simSetup: { ...scene.simSetup, fnominal: '7', solveFreq: '' },
    });
    const out = generateHfssNative(s, values);
    expect(out).toContain('Frequency:=", "7GHz"');
  });

  it('omits InsertFrequencySweep when sweepEnabled is false', () => {
    const s = sceneWith({
      simSetup: { ...scene.simSetup, sweepEnabled: false },
    });
    const out = generateHfssNative(s, values);
    expect(out).not.toContain('InsertFrequencySweep');
    // The adaptive setup itself must still be there.
    expect(out).toContain('InsertSetup("HfssDriven"');
  });

  it('emits an Optimetrics parametric setup for sweep-flagged params (and only then)', () => {
    // No params flagged → no Optimetrics block.
    const baseline = generateHfssNative(scene, values);
    expect(baseline).not.toContain('InsertSetup("OptiParametric"');

    // Flag one µm param → one SweepDefinition with um-tagged LIN range.
    const params = {
      ...scene.params,
      sweep_gap: {
        expr: '3', unit: 'µm', desc: 'sweep test param',
        sweep: { enabled: true, start: '1', stop: '5', step: '0.5' },
      },
    };
    const s = sceneWith({ params });
    const { values: pv } = resolveParams(params);
    const out = generateHfssNative(s, pv);
    expect(out).toContain('InsertSetup("OptiParametric"');
    expect(out).toContain('"Variable:=", "sweep_gap"');
    expect(out).toContain('LIN 1um 5um 0.5um');
    // Audit comment listing the swept param.
    expect(out).toMatch(/#\s+sweep_gap: LIN 1um 5um 0\.5um/);
    pyParses(out, 'vitest_hfss_optimetrics');
  });

  it('emits set_var("<id>_cx") with the snap-chain param for a circle snapped to a rect', () => {
    // [B3a] Non-rect native primitives (circle / ellipse / polygon) must
    // get the same parametric-center treatment as rects: a per-shape
    // HFSS variable carrying the FULL snap-chain expression, referenced
    // by the create call. Sweeping the snap gap in HFSS then moves the
    // circle without a re-export.
    const s = {
      params: {
        gap_x: { expr: '5', unit: 'µm', desc: 'snap gap' },
        circ1_r: { expr: '3', unit: 'µm', desc: 'circle radius' },
      },
      components: [
        { id: 'base', kind: 'rect', layer: 'electrode', cx: 0, cy: 0, w: '10', h: '10', cutouts: [], transforms: [] },
        { id: 'circ1', kind: 'circle', layer: 'electrode', cx: 13, cy: 0,
          r: 'circ1_r', w: '2*circ1_r', h: '2*circ1_r', cutouts: [], transforms: [] },
      ],
      snaps: [
        { id: 's1', from: { compId: 'base', anchor: 'E' }, to: { compId: 'circ1', anchor: 'W' }, dx: 'gap_x', dy: '0' },
      ],
      mirrors: [], groups: [], booleans: [],
      stack: scene.stack, stackName: scene.stackName, simSetup: scene.simSetup,
    };
    const { values: pv } = resolveParams(s.params);
    const out = generateHfssNative(s, pv);
    // The center variable's VALUE carries the snap-chain param.
    const setVarCx = out.match(/set_var\("circ1_cx", "([^"]+)"\)/);
    expect(setVarCx).not.toBeNull();
    expect(setVarCx[1]).toContain('gap_x');
    expect(out).toMatch(/set_var\("circ1_cy", "[^"]+"\)/);
    // The CreateCircle call references the variables, not numerics.
    const circleIdx = out.indexOf('oEditor.CreateCircle');
    expect(circleIdx).toBeGreaterThan(0);
    const circleCall = out.slice(circleIdx, circleIdx + 600);
    expect(circleCall).toContain('"XCenter:=", "(circ1_cx)"');
    expect(circleCall).toContain('"YCenter:=", "(circ1_cy)"');
    // Radius stays parametric too.
    expect(circleCall).toContain('circ1_r');
    pyParses(out, 'vitest_hfss_circle_param');
  });

  it('emits a rect mirror target parametrically as 2*axis - (source chain)', () => {
    // [B3b] A locked mirror target whose source has a parametric chain
    // and whose shape is reflection-symmetric (rect) must be emitted as
    // the parametric reflection 2*axisCoord - cx_src, so chain-variable
    // sweeps in HFSS move source and mirror copy in lockstep.
    const s = {
      params: { off_x: { expr: '12', unit: 'µm', desc: 'snap offset' } },
      components: [
        { id: 'anchor0', kind: 'rect', layer: 'electrode', cx: 0, cy: 0, w: '10', h: '10', cutouts: [], transforms: [] },
        { id: 'src', kind: 'rect', layer: 'electrode', cx: 19, cy: 0, w: '4', h: '4', cutouts: [], transforms: [] },
        { id: 'src_mir', kind: 'rect', layer: 'electrode', cx: -19, cy: 0, w: '4', h: '4', cutouts: [], transforms: [] },
      ],
      snaps: [
        { id: 's1', from: { compId: 'anchor0', anchor: 'E' }, to: { compId: 'src', anchor: 'W' }, dx: 'off_x', dy: '0' },
      ],
      mirrors: [
        { id: 'mir1', axis: 'vertical', axisCoord: 0,
          members: [{ srcId: 'src', mirrorId: 'src_mir', locked: true }] },
      ],
      groups: [], booleans: [],
      stack: scene.stack, stackName: scene.stackName, simSetup: scene.simSetup,
    };
    const { values: pv } = resolveParams(s.params);
    const out = generateHfssNative(s, pv);
    // Locate the create call for the mirror target and grab its X
    // position expression (XStart for sheets, XPosition for boxes).
    const nameIdx = out.indexOf('"Name:=", "src_mir"');
    expect(nameIdx).toBeGreaterThan(0);
    const blockStart = out.lastIndexOf('safe_create_', nameIdx);
    expect(blockStart).toBeGreaterThan(0);
    const block = out.slice(blockStart, nameIdx);
    const xMatch = block.match(/"X(?:Start|Position):=", "([^"]+)"/);
    expect(xMatch).not.toBeNull();
    // The reflection form: 2*<axis literal> - (<source chain with off_x>).
    expect(xMatch[1]).toContain('2*');
    expect(xMatch[1]).toContain('off_x');
    // And the safety report classifies the target as parametric-by-
    // reflection, not frozen.
    expect(out).toMatch(/#\s+- src_mir: pos \(mirror reflection of src\)/);
    pyParses(out, 'vitest_hfss_mirror_param');
  });

  it('includes the PARAMETRIC-SWEEP SAFETY REPORT near the top of the script', () => {
    // [B6] The boxed report block must sit in the header (before any
    // executable code) and list both classifications.
    const out = generateHfssNative(scene, values);
    const reportIdx = out.indexOf('PARAMETRIC-SWEEP SAFETY REPORT');
    expect(reportIdx).toBeGreaterThan(0);
    expect(reportIdx).toBeLessThan(out.indexOf('import ScriptEnv'));
    expect(out).toContain('# Fully parametric (tracks HFSS variable changes):');
    expect(out).toContain('# FROZEN at export values (re-export after changing related params):');
    // The placeholder must be fully consumed.
    expect(out).not.toContain('__PARAMETRIC_REPORT__');
    pyParses(out, 'vitest_hfss_report');
  });

  it('warns in the script when a repeat exceeds 500 instances', () => {
    const condLayerId = scene.stack.find(l => l.role === 'conductor')?.id;
    const params = { h_cond: { expr: '0.5' }, h_wg: { expr: '0.3' } };
    const s = {
      params,
      components: [
        { id: 'A', kind: 'rect', layer: 'electrode', conductorLayerId: condLayerId,
          cx: 0, cy: 0, w: 5, h: 5, cutouts: [],
          transforms: [{ id: 't1', kind: 'repeat', enabled: true, n: 600, dx: 10, dy: 0, includeOriginal: true }] },
      ],
      snaps: [], mirrors: [], groups: [], booleans: [],
      stack: scene.stack, stackName: scene.stackName, simSetup: scene.simSetup,
    };
    const { values: pv } = resolveParams(params);
    const out = generateHfssNative(s, pv);
    expect(out).toContain('# WARNING: repeat n=600 creates 601 instances');
    // The DuplicateAlongLine call is still emitted.
    expect(out).toContain('DuplicateAlongLine');
  });
});

// ── Curved paths + tapers: export emission ──────────────────────────────
// Arc vertices → HFSS AngularArc segments (parametric center + angle);
// spline runs → ONE Spline segment; per-vertex widths → per-segment
// parametric quad sheets + Unite + sweep. GDS / gdsfactory / pyAEDT
// capture the same geometry numerically (tessellated).
import { generateGdsfactory } from '../src/export/gdsfactory.js';

describe('curved paths + tapers — exporters', () => {
  const condLayerId = scene.stack.find(l => l.role === 'conductor')?.id;
  const basePolyline = (vertices, extraComp = {}, params = {}) => {
    const allParams = {
      h_cond: { expr: '0.5' }, h_wg: { expr: '0.3' },
      trace_w: { expr: '2' },
      ...params,
    };
    const s = {
      params: allParams,
      components: [{
        id: 'pl', kind: 'polyline', layer: 'electrode', conductorLayerId: condLayerId,
        cx: 0, cy: 0, width: 'trace_w', w: '0', h: '0',
        cutouts: [], transforms: [], vertices, ...extraComp,
      }],
      snaps: [], mirrors: [], groups: [], booleans: [],
      stack: scene.stack, stackName: scene.stackName, simSetup: scene.simSetup,
    };
    const { values: pv } = resolveParams(allParams);
    return { s, pv };
  };
  const pyParses2 = (code, name) => {
    mkdirSync('tests/out', { recursive: true });
    writeFileSync(`tests/out/${name}.py`, code);
    expect(() => execSync(
      `python3 -c "import ast; ast.parse(open('tests/out/${name}.py').read())"`,
      { stdio: 'pipe' }
    )).not.toThrow();
  };

  it('parametric arc emits an AngularArc segment with the angle param in ArcAngle', () => {
    const { s, pv } = basePolyline([
      { kind: 'rel', dx: '0', dy: '0' },
      { kind: 'arc', cdx: 'arc_r', cdy: '0', angle: 'arc_a' },
    ], {}, { arc_r: { expr: '5' }, arc_a: { expr: '180' } });
    const out = generateHfssNative(s, pv);
    expect(out).toContain('"SegmentType:=", "AngularArc"');
    // HFSS trig is unit-aware: ArcAngle carries the *1deg tag around
    // the LIVE expression (not a baked numeric).
    expect(out).toContain('"ArcAngle:=", "(arc_a)*1deg"');
    // Arc center chain expr references the cdx param.
    const centerMatch = out.match(/"ArcCenterX:=", "([^"]+)"/);
    expect(centerMatch).toBeTruthy();
    expect(centerMatch[1]).toContain('arc_r');
    // AngularArc carries start/mid/end → NoOfPoints 3 (HFSS convention).
    expect(out).toContain('"NoOfPoints:=", 3');
    // Fully parametric → lands in the PARAMETRIC report, not FROZEN.
    expect(out).toContain('arc centers + sweep angles');
    pyParses2(out, 'vitest_hfss_arc');
  });

  it('spline run emits ONE Spline segment with NoOfPoints = run + anchor', () => {
    const { s, pv } = basePolyline([
      { kind: 'rel', dx: '0', dy: '0' },
      { kind: 'rel', dx: '10', dy: '0', spline: true },
      { kind: 'rel', dx: '10', dy: '8', spline: true },
      { kind: 'rel', dx: '10', dy: '-8', spline: true },
    ]);
    const out = generateHfssNative(s, pv);
    // 3 spline vertices + the anchor before the run = 4 points.
    expect(out).toContain('"SegmentType:=", "Spline", "StartIndex:=", 0, "NoOfPoints:=", 4');
    // Safety report carries the canvas-approximation caveat.
    expect(out).toContain('spline (canvas preview is an approximation of HFSS NURBS)');
    pyParses2(out, 'vitest_hfss_spline');
  });

  it('tapered single-segment polyline emits sqrt() corner exprs + sweep', () => {
    const { s, pv } = basePolyline([
      { kind: 'rel', dx: '0', dy: '0' },
      { kind: 'rel', dx: 'seg_L', dy: '0', width: 'tip_w' },
    ], {}, { seg_L: { expr: '20' }, tip_w: { expr: '6' } });
    const out = generateHfssNative(s, pv);
    expect(out).toContain('TAPERED polyline trace');
    // Parametric unit normal: sqrt((dx)*(dx) + (dy)*(dy)) in the corners.
    expect(out).toContain('sqrt(');
    // Corner expressions carry the LIVE width + segment-length params.
    const ptMatch = out.match(/"X:=", "([^"]*tip_w[^"]*)"/);
    expect(ptMatch).toBeTruthy();
    expect(out).toContain('seg_L');
    // Single quad → no Unite needed, but the sheet sweeps up by the
    // conductor thickness.
    expect(out).toContain('SweepAlongVector');
    expect(out).toContain('per-vertex taper widths');
    pyParses2(out, 'vitest_hfss_taper1');
  });

  it('tapered multi-segment polyline unites the per-segment sheets', () => {
    const { s, pv } = basePolyline([
      { kind: 'rel', dx: '0', dy: '0' },
      { kind: 'rel', dx: '10', dy: '0', width: 'mid_w' },
      { kind: 'rel', dx: '10', dy: '5', width: 'tip_w' },
    ], {}, { mid_w: { expr: '4' }, tip_w: { expr: '1' } });
    const out = generateHfssNative(s, pv);
    expect(out).toContain('oEditor.Unite');
    expect(out).toContain('"Selections:=", "pl,pl_tseg1"');
    pyParses2(out, 'vitest_hfss_taper2');
  });

  it('tapered polyline with a snap-bound vertex keeps parametric corners', () => {
    // Cross-feature interaction (Phase 3 gate): a per-vertex taper width
    // on a vertex that is snap-bound to another component must emit
    // corner expressions referencing BOTH the snap target's live chain
    // (anchor offset rides the target's w param) AND the taper width
    // param — not baked numerics.
    const { s, pv } = basePolyline([
      { kind: 'rel', dx: '0', dy: '0' },
      { kind: 'snap', compId: 'tgt', anchor: 'E', width: 'tip_w' },
    ], {}, { tip_w: { expr: '6' }, tgt_w: { expr: '30' } });
    s.components.push({
      id: 'tgt', kind: 'rect', layer: 'electrode', conductorLayerId: condLayerId,
      cx: 40, cy: 0, w: 'tgt_w', h: '10', cutouts: [], transforms: [],
    });
    const out = generateHfssNative(s, pv);
    expect(out).toContain('TAPERED polyline trace');
    // Snap-bound endpoint corner X rides the target's width param
    // (anchor E offset = +(tgt_w)/2 inside the chain expression).
    expect(out).toMatch(/"X:=", "[^"]*tgt_w[^"]*"/);
    // Taper width param stays live in the corner expressions.
    expect(out).toMatch(/"[XY]:=", "[^"]*tip_w[^"]*"/);
    // sqrt() unit-normal idiom present → corners are parametric, and the
    // snap vertex must NOT freeze the polyline.
    expect(out).toContain('sqrt(');
    expect(out).not.toContain('polyline vertex snapped to tgt (target has no parametric chain');
    pyParses2(out, 'vitest_hfss_taper_snap');
  });

  it('tapered polyline with an arc segment warns + freezes that segment', () => {
    const { s, pv } = basePolyline([
      { kind: 'rel', dx: '0', dy: '0', width: '4' },
      { kind: 'arc', cdx: '0', cdy: '10', angle: '90' },
      { kind: 'rel', dx: '10', dy: '0' },
    ]);
    const out = generateHfssNative(s, pv);
    expect(out).toContain('# WARNING:');
    expect(out).toContain('taper-on-arc');
    expect(out).toContain('tapered polyline arc/spline segments frozen at constant base width');
    pyParses2(out, 'vitest_hfss_taper_arc');
  });

  it('polyshape with an arc edge emits AngularArc on the closed covered polyline', () => {
    const s = {
      params: { h_cond: { expr: '0.5' }, h_wg: { expr: '0.3' } },
      components: [{
        id: 'ps', kind: 'polyshape', layer: 'electrode', conductorLayerId: condLayerId,
        cx: 0, cy: 0, w: '0', h: '0', closed: true,
        cutouts: [], transforms: [],
        vertices: [
          { kind: 'rel', dx: '0', dy: '0' },
          { kind: 'arc', cdx: '5', cdy: '0', angle: '180' },
          { kind: 'rel', dx: '0', dy: '10' },
        ],
      }],
      snaps: [], mirrors: [], groups: [], booleans: [],
      stack: scene.stack, stackName: scene.stackName, simSetup: scene.simSetup,
    };
    const { values: pv } = resolveParams(s.params);
    const out = generateHfssNative(s, pv);
    expect(out).toContain('"SegmentType:=", "AngularArc"');
    // Closed contour is built with EXPLICIT closure (closing-repeat point +
    // full segment list), NOT HFSS auto-close — IsPolylineClosed=False. HFSS's
    // auto-close is unreliable for covered/swept polylines (cant_extract_geom).
    expect(out).toContain('"IsPolylineClosed:=", False');
    pyParses2(out, 'vitest_hfss_polyshape_arc');
  });

  it('pyAEDT polyline emits tessellated numeric points (+ taper quads) and parses', () => {
    const { s, pv } = basePolyline([
      { kind: 'rel', dx: '0', dy: '0' },
      { kind: 'arc', cdx: '0', cdy: '10', angle: '90' },
      { kind: 'rel', dx: '10', dy: '0', width: '6' },
    ]);
    const out = generatePyAEDT(s, pv);
    expect(out).toContain('TAPERED polyline');
    expect(out).toContain('create_polyline');
    pyParses2(out, 'vitest_pyaedt_curved');
    // Non-tapered variant: centerline polyline with rectangle XSection.
    const { s: s2, pv: pv2 } = basePolyline([
      { kind: 'rel', dx: '0', dy: '0' },
      { kind: 'arc', cdx: '0', cdy: '10', angle: '90' },
    ]);
    const out2 = generatePyAEDT(s2, pv2);
    expect(out2).toContain('xsection_type="Rectangle"');
    expect(out2).toContain('centerline tessellated numerically');
    pyParses2(out2, 'vitest_pyaedt_curved2');
  });

  it('GDS export handles arcs, splines, and tapered bands without throwing', () => {
    const { s } = basePolyline([
      { kind: 'rel', dx: '0', dy: '0' },
      { kind: 'arc', cdx: '0', cdy: '10', angle: '90' },
      { kind: 'rel', dx: '10', dy: '0', spline: true, width: '6' },
      { kind: 'rel', dx: '10', dy: '-5', spline: true },
    ]);
    const { values: pv } = resolveParams(s.params);
    const gds = generateGDS(s, pv);
    expect(gds).toBeInstanceOf(Uint8Array);
    expect(gds.byteLength).toBeGreaterThan(100);
  });

  it('gdsfactory emits the polyline band as per-segment quads and parses', () => {
    const { s, pv } = basePolyline([
      { kind: 'rel', dx: '0', dy: '0' },
      { kind: 'rel', dx: '20', dy: '0', width: '5' },
      { kind: 'arc', cdx: '0', cdy: '10', angle: '90' },
    ]);
    const out = generateGdsfactory(s, pv);
    expect(out).toContain('per-segment quad');
    expect(out).toContain('add_polygon');
    pyParses2(out, 'vitest_gdsfactory_curved');
  });
});

// ── D3 (rect corner fillets) + D4 (vias): export-level assertions ───────

describe('D3/D4 exports: rounded rects + vias', () => {
  const condLayerId = scene.stack.find(l => l.role === 'conductor')?.id;
  const pyParses3 = (code, name) => {
    mkdirSync('tests/out', { recursive: true });
    writeFileSync(`tests/out/${name}.py`, code);
    expect(() => execSync(
      `python3 -c "import ast; ast.parse(open('tests/out/${name}.py').read())"`,
      { stdio: 'pipe' }
    )).not.toThrow();
  };
  // Minimal GDS BOUNDARY scanner: returns [{ layer, nPts }] per boundary.
  const scanGdsBoundaries = (bytes) => {
    const out = [];
    let i = 0;
    let curLayer = null;
    while (i + 4 <= bytes.length) {
      const len = (bytes[i] << 8) | bytes[i + 1];
      if (len < 4) break;
      const recType = bytes[i + 2];
      if (recType === 0x0d) { // LAYER
        curLayer = (bytes[i + 4] << 8) | bytes[i + 5];
      } else if (recType === 0x10) { // XY
        const nPts = (len - 4) / 8;
        out.push({ layer: curLayer, nPts });
      }
      i += len;
    }
    return out;
  };

  // Custom stack with a dielectric spacer between the WG and the top
  // metal, so the via's Z span genuinely crosses MULTIPLE thickness
  // params (the default stack's coplanar device run shares zBottom).
  const viaScene = () => {
    const params = {
      h_si: { expr: '250', unit: 'µm' },
      h_wg: { expr: '0.6', unit: 'µm' },
      h_d1: { expr: '1.5', unit: 'µm' },
      h_cond: { expr: '0.8', unit: 'µm' },
      via_r: { expr: '2', unit: 'µm' },
    };
    const s = {
      params,
      components: [
        { id: 'v1', kind: 'via', layer: 'via', cx: 10, cy: 5, r: 'via_r',
          w: '2*via_r', h: '2*via_r', layerFrom: 'l_wg', layerTo: 'l_m2',
          cutouts: [], transforms: [] },
        { id: 'v2', kind: 'via', layer: 'via', cx: -10, cy: 5, r: 'via_r',
          w: '2*via_r', h: '2*via_r', layerFrom: 'l_d1', layerTo: 'l_m2',
          cutouts: [], transforms: [] },
      ],
      snaps: [], mirrors: [], groups: [], booleans: [],
      stack: [
        { id: 'l_sub', name: 'Si', thickness: 'h_si', material: 'silicon', color: '#5a6878', role: 'substrate' },
        { id: 'l_wg', name: 'WG', thickness: 'h_wg', material: 'lithium_tantalate', color: '#86efac', role: 'waveguide',
          core_width: 'w_wg', slab_height: 'h_slab', slab_width: 'w_slab', etch_angle: 'etch_angle' },
        { id: 'l_d1', name: 'Spacer', thickness: 'h_d1', material: 'silicon_dioxide', color: '#cbd5e1', role: 'dielectric' },
        { id: 'l_m2', name: 'TopMetal', thickness: 'h_cond', material: 'gold', color: '#daa520', role: 'conductor' },
      ],
      stackName: 'via_test_stack',
      simSetup: scene.simSetup,
    };
    const { values: pv } = resolveParams({
      ...params,
      w_wg: { expr: '1.2' }, h_slab: { expr: '0.1' },
      w_slab: { expr: '5' }, etch_angle: { expr: '70' },
    });
    return { s, pv };
  };

  it('HFSS via emits a parametric CreateCylinder: ZStart = layerFrom bottom, Height spans both layers', () => {
    const { s, pv } = viaScene();
    const out = generateHfssNative(s, pv);
    expect(out).toContain('oEditor.CreateCylinder');
    // Per-via blocks (each starts with its header comment).
    const b1 = out.slice(out.indexOf('# v1: via'), out.indexOf('# v2: via'));
    const b2 = out.slice(out.indexOf('# v2: via'));
    // v1: layerFrom = l_wg → ZStart is the device level's parametric
    // bottom ('0um' in this stack).
    expect(b1).toContain('"ZCenter:=", "0um"');
    // Height = (top of l_m2) - (bottom of l_wg) — must reference EVERY
    // thickness param along the span: h_wg (WG), h_d1 (spacer), h_cond
    // (target metal).
    const height1 = /"Height:=", "([^"]+)"/.exec(b1)?.[1] || '';
    expect(height1).toContain('h_wg');
    expect(height1).toContain('h_d1');
    expect(height1).toContain('h_cond');
    // v2: layerFrom = l_d1 → ZStart is the spacer's parametric bottom,
    // which rides h_wg.
    const zc2 = /"ZCenter:=", "([^"]+)"/.exec(b2)?.[1] || '';
    expect(zc2).toContain('h_wg');
    // Radius stays the live expression.
    expect(b1).toContain('"Radius:=", "(via_r)"');
    // Cladding subtraction bookkeeping: via is metal (gold from l_m2).
    expect(b1).toContain('gold');
    pyParses3(out, 'vitest_hfss_via');
  });

  it('HFSS via with unresolved or identical layers is skipped with a comment', () => {
    const { s, pv } = viaScene();
    s.components = [{
      id: 'vbad', kind: 'via', layer: 'via', cx: 0, cy: 0, r: 'via_r',
      w: '2*via_r', h: '2*via_r', layerFrom: 'l_m2', layerTo: 'l_m2',
      cutouts: [], transforms: [],
    }];
    const out = generateHfssNative(s, pv);
    expect(out).toContain('Skipped via vbad');
    expect(out).not.toContain('oEditor.CreateCylinder');
    pyParses3(out, 'vitest_hfss_via_bad');
  });

  it('via Z span ignores a stray zOffset — vias are layer-bound in Z', () => {
    // Cross-feature interaction (Phase 3 gate): zOffset is never offered
    // on vias (their Z span is fully determined by layerFrom/layerTo) and
    // normalizeScene strips it. Belt-and-suspenders: even a hand-injected
    // zOffset on an un-normalized component list must NOT leak into the
    // cylinder's ZCenter (HFSS) or emit a Z move (pyAEDT).
    const { s, pv } = viaScene();
    s.components = [{ ...s.components[0], zOffset: '7' }];
    const out = generateHfssNative(s, pv);
    const b1 = out.slice(out.indexOf('# v1: via'));
    expect(/"ZCenter:=", "([^"]+)"/.exec(b1)?.[1]).toBe('0um');
    pyParses3(out, 'vitest_hfss_via_zoffset');
    const outPy = generatePyAEDT(s, pv);
    expect(outPy).not.toContain('zOffset');
    pyParses3(outPy, 'vitest_pyaedt_via_zoffset');
  });

  it('pyAEDT via emits a numeric cylinder spanning the stack and parses', () => {
    const { s, pv } = viaScene();
    const out = generatePyAEDT(s, pv);
    expect(out).toContain('create_cylinder');
    // v1 spans l_wg bottom (0) to l_m2 top (0.6 + 1.5 + 0.8 = 2.9).
    expect(out).toContain('height="2.9000um"');
    expect(out).toContain('numeric Z span');
    pyParses3(out, 'vitest_pyaedt_via');
  });

  it('GDS vias land on 200+ with one layer per (from → to) pair', () => {
    const { s, pv } = viaScene();
    const gds = generateGDS(s, pv);
    const boundaries = scanGdsBoundaries(gds);
    const viaB = boundaries.filter(b => b.layer >= 200);
    expect(viaB).toHaveLength(2);
    // Distinct pairs → distinct layers, assigned in component order.
    expect(viaB.map(b => b.layer).sort()).toEqual([200, 201]);
    // Circle tessellation: 64 vertices + closing repeat.
    for (const b of viaB) expect(b.nPts).toBe(65);
  });

  it('gdsfactory vias emit parametric circles on their via layers and parse', () => {
    const { s, pv } = viaScene();
    const out = generateGdsfactory(s, pv);
    expect(out).toContain('"via_l_wg__l_m2": (200, 0)');
    expect(out).toContain('"via_l_d1__l_m2": (201, 0)');
    expect(out).toContain('_circle_pts');
    pyParses3(out, 'vitest_gdsfactory_via');
  });

  // ── Rounded rects ─────────────────────────────────────────────────────

  const roundedScene = (extraComp = {}) => {
    const params = {
      ...scene.params,
      rw: { expr: '20', unit: 'µm' },
      rh: { expr: '10', unit: 'µm' },
      fil_r: { expr: '2', unit: 'µm' },
    };
    const s = {
      params,
      components: [{
        id: 'rr', kind: 'rect', layer: 'electrode', conductorLayerId: condLayerId,
        cx: 0, cy: 0, w: 'rw', h: 'rh', cornerRadius: 'fil_r',
        cutouts: [], transforms: [], ...extraComp,
      }],
      snaps: [], mirrors: [], groups: [], booleans: [],
      stack: scene.stack, stackName: scene.stackName, simSetup: scene.simSetup,
    };
    const { values: pv } = resolveParams(params);
    return { s, pv };
  };

  it('HFSS rounded rect emits 4 AngularArc 90deg corners with parametric w/h/r', () => {
    const { s, pv } = roundedScene();
    const out = generateHfssNative(s, pv);
    // Covered closed polyline instead of the box path (the sharp
    // electrode path would emit a CreateBox with XSize "(rw)"; the
    // substrate / cladding boxes still legitimately use
    // safe_create_box, so test for the rect-specific signature).
    expect(out).toContain('rounded rect (cornerRadius = fil_r)');
    expect(out).not.toContain('"XSize:=", "(rw)"');
    const arcCount = (out.match(/"SegmentType:=", "AngularArc"/g) || []).length;
    expect(arcCount).toBe(4);
    const angle90Count = (out.match(/"ArcAngle:=", "90deg"/g) || []).length;
    expect(angle90Count).toBe(4);
    // Tangent points are parametric in the rect's w/h/r names.
    expect(out).toMatch(/"X:=", "[^"]*\(rw\)[^"]*"/);
    expect(out).toMatch(/"Y:=", "[^"]*\(rh\)[^"]*"/);
    expect(out).toMatch(/"ArcCenterX:=", "[^"]*\(fil_r\)[^"]*"/);
    // Unclamped-r warning comment.
    expect(out).toContain('cornerRadius is not clamped in HFSS; keep r <= min(w,h)/2');
    // Thickened by the conductor layer's parametric thickness.
    expect(out).toContain('SweepAlongVector');
    pyParses3(out, 'vitest_hfss_rounded_rect');
  });

  it('HFSS rounded rect with rotation reuses the D6 base-rotation idiom', () => {
    const { s, pv } = roundedScene({ rotation: 'rr_rot' });
    s.params.rr_rot = { expr: '30', unit: '' };
    const out = generateHfssNative(s, pv);
    expect(out).toContain('Base rotation for rr');
    expect(out).toContain('"RotateAngle:=", "(rr_rot)*1deg"');
    pyParses3(out, 'vitest_hfss_rounded_rect_rot');
  });

  it('HFSS rect with cornerRadius evaluating to 0 falls back to the sharp box path', () => {
    const { s, pv } = roundedScene();
    s.params.fil_r = { expr: '0', unit: 'µm' };
    const { values: pv0 } = resolveParams(s.params);
    const out = generateHfssNative(s, pv0);
    expect(out).toContain('safe_create_box');
    expect(out).not.toContain('"SegmentType:=", "AngularArc"');
    pyParses3(out, 'vitest_hfss_rounded_rect_zero');
  });

  it('GDS rounded rect boundary carries the 36-vertex filleted ring', () => {
    const { s, pv } = roundedScene();
    const gds = generateGDS(s, pv);
    const boundaries = scanGdsBoundaries(gds);
    // Electrode bound to the first conductor → layer 10; 36 ring
    // vertices + closing repeat.
    const rr = boundaries.find(b => b.layer === 10);
    expect(rr).toBeTruthy();
    expect(rr.nPts).toBe(37);
  });

  it('pyAEDT rounded rect emits the numeric filleted polyline and parses', () => {
    const { s, pv } = roundedScene();
    const out = generatePyAEDT(s, pv);
    expect(out).toContain('rounded rect (cornerRadius = fil_r)');
    expect(out).toContain('create_polyline');
    expect(out).toContain('thicken_sheet');
    pyParses3(out, 'vitest_pyaedt_rounded_rect');
  });

  it('gdsfactory rounded rect bakes the filleted perimeter numerically and parses', () => {
    const { s, pv } = roundedScene();
    const out = generateGdsfactory(s, pv);
    expect(out).toContain('rounded rect (cornerRadius=2');
    expect(out).toContain('add_polygon');
    pyParses3(out, 'vitest_gdsfactory_rounded_rect');
  });

  it('pyAEDT rounded rect with rotation emits the numeric rotate sandwich and parses', () => {
    // Cross-feature interaction (Phase 3 gate): cornerRadius (D3) +
    // first-class rotation (D6) compose — the filleted polyline part is
    // created axis-aligned, then rotated about its own center via the
    // translate-rotate-translate sandwich. Single part name `rr` (no
    // `_rib`), so the rotate targets must hit the right part.
    const { s, pv } = roundedScene({ rotation: '30' });
    const out = generatePyAEDT(s, pv);
    expect(out).toContain('rounded rect (cornerRadius = fil_r)');
    expect(out).toContain('rotation = 30 deg CCW about own center');
    expect(out).toContain('hfss.modeler.rotate(["rr"], "Z", "30.0000deg")');
    pyParses3(out, 'vitest_pyaedt_rounded_rect_rot');
  });
});
