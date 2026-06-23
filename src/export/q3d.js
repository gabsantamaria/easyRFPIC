// Q3D Extractor capacitance for the meander Z0 route.
//
// For a MEANDERED (non-uniform) line there's no uniform cross-section, so the
// per-length capacitance C can't come from Q2D. But the FULL 3-D folded
// geometry solves in Q3D Extractor: read C between the two line conductors,
// divide by the line's PHYSICAL length → C (F/m), then Z0 = γ/(jωC) (γ from the
// 2-line method). C is electrostatic ⇒ kinetic-inductance-correct.
//
// PARAMETRIC: the scene parameters are declared as Q3D design variables, and the
// conductor rectangles + dielectric stack are emitted as EXPRESSIONS referencing
// them (size from the component w/h, inter-strip gap from the repeat offset,
// stack Z from the layer thickness vars), plus q3d_cond_thk (conductor
// thickness) and q3d_line_len_um (length for C/length). So you can sweep
// width / gap / thickness / dielectric directly in Q3D and watch C change.
// Non-rectangular or rotated conductors fall back to baked numeric geometry.
//
// Modeling: conductors are THIN CONDUCTORS (a covered sheet swept up by the
// thickness); each conductor COMPONENT gets one SIGNAL NET (all its repeat/meander
// sheets joined, so the matrix is conductor-to-conductor — NOT one net per sheet);
// a capacitance setup + frequency sweep; the design is SOLVED, then (a) the C
// matrix is EXPORTED to a CSV via oDesign.ExportMatrixData and (b) a "C per
// length (F/m)" PLOT is created via oReportSetup.CreateReport. The post-
// processing REPORT engine DOES accept C(net,net) arithmetic (and resolves it in
// SI Farads); it's only the DESIGN output-variable parser that rejects C(...) as
// "'C' is not a function name" — don't confuse the two. The line capacitance is
// the DIFFERENTIAL capacitance ((C11+C22)/2 − C12)/2 — the port drives the
// strips differentially — NOT |C12|.
//
// Two emitters: generateQ3DCapacitance (standalone, own project) and
// generateQ3DCombinedBlock (appended to the 2-line HFSS script, same project).
// Only the SELECTED line conductor(s) are emitted; feeds excluded (they'd short
// the nets electrostatically). The Q3D-specific COM (nets/setup/sweep/reports)
// is NOT validated in this repo — wrapped in try/except; expect release tweaks.
import { normalizeScene, migrateStackCoplanarGroups } from '../scene/schema.js';
import { resolveParams, evalExpr } from '../scene/params.js';
import { solveLayout } from '../scene/solver.js';
import { expandTransforms } from '../scene/transforms.js';
import { shapeInstanceToRing } from '../geometry/rings.js';
import { flattenReplicas } from '../scene/twoLine.js';

const ascii = (s) => String(s ?? '').replace(/[^\x00-\x7F]/g, '?');
const num = (v) => (Number.isFinite(v) ? (Math.round(v * 1e6) / 1e6) : 0);
// Plain decimal (no exponent, no float noise) for literals/values the Q3D expr
// engine reads. Rounds to 1e-9 (sub-femtometre) and trims trailing zeros.
const dec = (x) => { if (!Number.isFinite(x)) return '0'; let s = (Math.round(x * 1e9) / 1e9).toFixed(9); if (s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\.$/, ''); return s || '0'; };
const unitFor = (u) => (u === 'µm' ? 'um' : (u === 'deg' ? 'deg' : ''));
// Z/thickness expression with correct units. Mirrors hfss-native's exprWithUm:
// a BARE NUMERIC gets the unit INSIDE the parens ("(0.6um)"); an expression with
// identifiers is left alone ("(h_si)") because its variables already carry their
// unit (set_var declares them "<n>um"). NEVER append "um" OUTSIDE the parens —
// "(h_si)um" double-converts (h_si is already µm) → picometre-thin layers.
const exprUm = (e) => {
  const s = String(e ?? '').trim();
  if (s === '' || s === '0') return '0um';
  if (/^-?\d+(?:\.\d+)?$/.test(s)) return `(${s}um)`;
  return `(${s})`;
};

// Group-aware Z walk: numeric (zBottom/zTop) AND parametric (zBottomExpr/
// zTopExpr, in terms of the layer thickness vars h_si/h_wg/…). Mirrors
// hfss-native's layerZ.
function computeLayerZ(stack, pv) {
  const layers = migrateStackCoplanarGroups(stack || []);
  const thkNum = (l) => { const v = evalExpr(l.thickness, pv); return Number.isFinite(v) ? Math.abs(v) : 0; };
  const thkExpr = (l) => exprUm(l.thickness);
  const zBottom = {}, zTop = {}, zBottomExpr = {}, zTopExpr = {};
  let datum = layers.findIndex((l) => l.role !== 'substrate' || l.coplanarGroup);
  if (datum < 0) datum = layers.length;
  // Substrates below the datum, stacked downward (negative Z).
  let zc = 0, zcE = '0um';
  for (let i = datum - 1; i >= 0; i--) {
    const l = layers[i], t = thkNum(l);
    zTop[l.id] = zc; zTopExpr[l.id] = zcE;
    zBottom[l.id] = zc - t; zBottomExpr[l.id] = `${zcE} - ${thkExpr(l)}`;
    zc -= t; zcE = zBottomExpr[l.id];
  }
  // From the datum up; coplanar groups share zBottom; advance past a group by
  // its cladding top (thickest cladding, else thickest member).
  zc = 0; zcE = '0um';
  let i = datum;
  while (i < layers.length) {
    const l = layers[i];
    if (l.coplanarGroup) {
      const gid = l.coplanarGroup, members = [];
      while (i < layers.length && layers[i].coplanarGroup === gid) { members.push(layers[i]); i++; }
      for (const m of members) { zBottom[m.id] = zc; zBottomExpr[m.id] = zcE; zTop[m.id] = zc + thkNum(m); zTopExpr[m.id] = `${zcE} + ${thkExpr(m)}`; }
      const clad = members.filter((m) => m.role === 'cladding');
      const advMembers = clad.length ? clad : members;
      const adv = advMembers.reduce((mx, m) => Math.max(mx, thkNum(m)), 0);
      const advL = advMembers.slice().sort((p, q) => thkNum(q) - thkNum(p))[0];
      zc += adv; zcE = `${zcE} + ${thkExpr(advL)}`;
    } else {
      zBottom[l.id] = zc; zBottomExpr[l.id] = zcE; zTop[l.id] = zc + thkNum(l); zTopExpr[l.id] = `${zcE} + ${thkExpr(l)}`;
      zc += thkNum(l); zcE = zTopExpr[l.id]; i++;
    }
  }
  return { zBottom, zTop, zBottomExpr, zTopExpr };
}

// Per-instance PARAMETRIC translation offsets {dx,dy} (expression strings or
// null) for a repeat/displace chain — so the inter-strip gap stays parametric.
function parametricOffsets(transforms, pv) {
  const mul = (k, e) => { e = String(e ?? '').trim(); if (!e || e === '0' || k === 0) return null; return k === 1 ? `(${e})` : `${k}*(${e})`; };
  const add = (a, b) => (!a ? b : (!b ? a : `${a} + ${b}`));
  let offs = [{ dx: null, dy: null }];
  let hasRot = false;
  for (const t of (transforms || [])) {
    if (t.enabled === false) continue;
    if (t.kind === 'displace') {
      const dx = mul(1, t.dx), dy = mul(1, t.dy);
      offs = offs.map((o) => ({ dx: add(o.dx, dx), dy: add(o.dy, dy) }));
    } else if (t.kind === 'repeat') {
      const n = Math.max(0, Math.round(evalExpr(t.n, pv) || 0));
      const inc = t.includeOriginal !== false;
      const out = [];
      for (const o of offs) for (let k = (inc ? 0 : 1); k <= n; k++) out.push({ dx: add(o.dx, mul(k, t.dx)), dy: add(o.dy, mul(k, t.dy)) });
      offs = out;
    } else if (t.kind === 'rotate') {
      hasRot = true;
    }
  }
  return { offs, hasRot };
}

// Shared geometry/material body. boxFn/polyFn/sweepFn are Python helper names.
// opts: { conductorIds, thicknessUm, lengthUm }.
function buildQ3DBody(scene, paramValues, opts, boxFn, polyFn, sweepFn) {
  const src = normalizeScene(scene);
  const pv = paramValues || resolveParams(src.params || {}).values;
  const solved = solveLayout(src.components, src.snaps, pv);
  const stack = src.stack || [];
  const { zBottom, zTop, zBottomExpr } = computeLayerZ(stack, pv);

  const wantIds = new Set(opts.conductorIds || []);
  // A selected conductor may be a BOOLEAN (e.g. a meander electrode = union of
  // many rects, often with a repeat). Booleans are kept here and expanded below
  // into their operand sheets under ONE net (one physical conductor). Operands
  // that are themselves directly selected are skipped (their boolean carries them).
  const condComps = solved.filter((c) => wantIds.has(c.id) && !(c.consumedBy && wantIds.has(c.consumedBy)));
  if (condComps.length === 0) throw new Error('Select at least one line conductor for the Q3D capacitance run.');
  // For boolean conductors we need each one's operand geometry with its repeat/
  // displace replicas materialized. flattenReplicas (the 2-line helper) does
  // exactly that for the whole solved scene; we then pick out each boolean's
  // operands by their (replica-remapped) consumedBy chain. Mirror/rotate on a
  // boolean are NOT materialized (flattenReplicas drops them) — flagged below.
  const hasBoolean = condComps.some((c) => c.kind === 'boolean');
  const flat = hasBoolean ? flattenReplicas(solved, pv).components : [];
  const flatById = Object.fromEntries(flat.map((p) => [p.id, p]));
  const baseId = (id) => String(id).replace(/__r\d+$/, '');
  const rootCompId = (p) => { let cur = p, g = 0; while (cur && g++ < 64) { if (!cur.consumedBy) return baseId(cur.id); cur = flatById[cur.consumedBy]; } return null; };
  const condWarnings = [];

  const condLayer = stack.find((l) => l.role === 'conductor');
  const condMat = (condLayer && condLayer.material) || 'gold';
  const hCond = condLayer ? (evalExpr(condLayer.thickness, pv) || 0) : 0;
  let effThk = Number.isFinite(opts.thicknessUm) && opts.thicknessUm > 0 ? opts.thicknessUm : (hCond > 0 ? hCond : 0.1);
  effThk = num(effThk);
  const condZBotExpr = condLayer ? `(${zBottomExpr[condLayer.id]})` : '0um';

  // ---- Design variables: scene params + thickness + line length + bases ----
  const varDecls = [];
  for (const name of Object.keys(src.params || {})) {
    if (!/^[A-Za-z_]\w*$/.test(name)) continue;
    const v = pv[name];
    if (!Number.isFinite(v)) continue;
    varDecls.push(`set_var("${name}", "${dec(v)}${unitFor(src.params[name].unit)}")`);
  }
  varDecls.push(`set_var("q3d_cond_thk", "${effThk}um")  # thin-conductor thickness`);

  // ---- Conductors (parametric rects; numeric fallback otherwise) ----
  const condObjs = [];
  const condNets = []; // {net, objects[]} grouped by COMPONENT — one physical
                       // conductor each (a repeat/meander → many sheets, ONE net)
  const condBlocks = [];
  let bb = { xMin: Infinity, xMax: -Infinity, yMin: Infinity, yMax: -Infinity };
  let lineLengthUm = 0;

  const polySheet = (name, pts) => {
    const ptStr = [...pts, pts[0]].map(([x, y]) =>
      `["NAME:PLPoint", "X:=", "${x}", "Y:=", "${y}", "Z:=", "${condZBotExpr}"]`
    ).join(',\n          ');
    const segs = pts.map((_, j) => `["NAME:PLSegment", "SegmentType:=", "Line", "StartIndex:=", ${j}, "NoOfPoints:=", 2]`).join(',\n          ');
    return `${polyFn}(
    ["NAME:PolylineParameters",
     "IsPolylineCovered:=", True, "IsPolylineClosed:=", True,
     ["NAME:PolylinePoints",
      ${ptStr}],
     ["NAME:PolylineSegments",
      ${segs}],
     ["NAME:PolylineXSection", "XSectionType:=", "None", "XSectionOrient:=", "Auto",
      "XSectionWidth:=", "0um", "XSectionTopWidth:=", "0um", "XSectionHeight:=", "0um",
      "XSectionNumSegments:=", "0", "XSectionBendType:=", "Corner"]],
    ["NAME:Attributes",
     "Name:=", "${name}", "Flags:=", "", "Color:=", "(218 165 32)",
     "Transparency:=", 0.0, "PartCoordinateSystem:=", "Global",
     "MaterialValue:=", "\\"${ascii(condMat)}\\"", "SolveInside:=", False],
    "${name}")
${sweepFn}("${name}", "q3d_cond_thk")  # thin conductor: sweep up by thickness`;
  };

  for (const c of condComps) {
    const cid = c.id.replace(/[^A-Za-z0-9_]/g, '_');
    const compObjs = []; // every sheet/instance of THIS component → one signal net
    if (c.kind === 'boolean') {
      // Expand the boolean (e.g. a meander union) into ALL its operand rects —
      // every repeat/displace replica materialized — and emit each as a numeric
      // thin-conductor sheet, all under ONE net (the boolean is one physical
      // conductor). Geometry is BAKED numeric (parametric emission isn't feasible
      // for a multi-operand boolean).
      if ((c.transforms || []).some((t) => t.enabled !== false && (t.kind === 'mirror' || t.kind === 'rotate'))) {
        condWarnings.push(`${c.id}: a mirror/rotate transform on the boolean was NOT applied to the Q3D geometry (repeat/displace ARE) — verify the conductor footprint before trusting C.`);
      }
      const mine = flat.filter((p) => p.kind !== 'boolean' && rootCompId(p) === c.id);
      mine.forEach((p, k) => {
        const inst = expandTransforms([p], pv)[0];
        if (!inst || !Number.isFinite(inst.w) || inst.w <= 0) return;
        const ring = shapeInstanceToRing(inst);
        if (!ring || ring.length < 3) return;
        for (const [x, y] of ring) { bb.xMin = Math.min(bb.xMin, x); bb.xMax = Math.max(bb.xMax, x); bb.yMin = Math.min(bb.yMin, y); bb.yMax = Math.max(bb.yMax, y); }
        const w = Math.abs(inst.w), h = Math.abs(inst.h);
        if (Number.isFinite(w) && w > 0) lineLengthUm = Math.max(lineLengthUm, w, h);
        const name = `${cid}_b${k}`;
        condObjs.push(name);
        compObjs.push(name);
        condBlocks.push(polySheet(name, ring.map(([x, y]) => [`${num(x)}um`, `${num(y)}um`])));
      });
      if (compObjs.length === 0) condWarnings.push(`${c.id}: no operand geometry resolved for the Q3D conductor.`);
      if (compObjs.length) condNets.push({ net: `net_${cid}`, objects: compObjs });
      continue;
    }
    const insts = expandTransforms([c], pv);
    for (const inst of insts) {
      const w = Math.abs(inst.w), h = Math.abs(inst.h);
      if (Number.isFinite(w) && w > 0) lineLengthUm = Math.max(lineLengthUm, w, h);
    }
    const ring0 = shapeInstanceToRing(insts[0]);
    if (ring0) for (const [x, y] of ring0) { bb.xMin = Math.min(bb.xMin, x); bb.xMax = Math.max(bb.xMax, x); bb.yMin = Math.min(bb.yMin, y); bb.yMax = Math.max(bb.yMax, y); }
    const { offs, hasRot } = parametricOffsets(c.transforms, pv);
    const rot = evalExpr(c.rotation ?? '0', pv) || 0;
    const paramRect = c.kind === 'rect' && !hasRot && Math.abs(rot) < 1e-9
      && Number.isFinite(evalExpr(c.w, pv)) && Number.isFinite(evalExpr(c.h, pv));

    if (paramRect) {
      // base center vars + parametric corners from component w/h and per-
      // instance offset (so width AND inter-strip gap stay parametric).
      varDecls.push(`set_var("${cid}_q3cx", "${dec(c.cx)}um")`, `set_var("${cid}_q3cy", "${dec(c.cy)}um")`);
      const wE = `(${c.w})`, hE = `(${c.h})`;
      offs.forEach((o, k) => {
        const cx = o.dx ? `${cid}_q3cx + ${o.dx}` : `${cid}_q3cx`;
        const cy = o.dy ? `${cid}_q3cy + ${o.dy}` : `${cid}_q3cy`;
        const xm = `(${cx}) - ${wE}/2`, xp = `(${cx}) + ${wE}/2`;
        const ym = `(${cy}) - ${hE}/2`, yp = `(${cy}) + ${hE}/2`;
        const name = `${cid}_i${k}`;
        condObjs.push(name);
        compObjs.push(name);
        condBlocks.push(polySheet(name, [[xm, ym], [xp, ym], [xp, yp], [xm, yp]]));
        // numeric bbox for the dielectric footprint
        const ni = insts[k] || insts[0];
        if (ni) { const r = shapeInstanceToRing(ni); if (r) for (const [x, y] of r) { bb.xMin = Math.min(bb.xMin, x); bb.xMax = Math.max(bb.xMax, x); bb.yMin = Math.min(bb.yMin, y); bb.yMax = Math.max(bb.yMax, y); } }
      });
    } else {
      // numeric fallback (rotated / non-rect): bake the ring per instance.
      insts.forEach((inst, k) => {
        if (!Number.isFinite(inst.w) || inst.w <= 0) return;
        const ring = shapeInstanceToRing(inst);
        if (!ring || ring.length < 3) return;
        for (const [x, y] of ring) { bb.xMin = Math.min(bb.xMin, x); bb.xMax = Math.max(bb.xMax, x); bb.yMin = Math.min(bb.yMin, y); bb.yMax = Math.max(bb.yMax, y); }
        const name = `${cid}_i${k}`;
        condObjs.push(name);
        compObjs.push(name);
        condBlocks.push(polySheet(name, ring.map(([x, y]) => [`${num(x)}um`, `${num(y)}um`])));
      });
    }
    if (compObjs.length) condNets.push({ net: `net_${cid}`, objects: compObjs });
  }
  if (!Number.isFinite(bb.xMin)) throw new Error('Selected conductors have no resolvable geometry.');

  // Numeric length (dielectric footprint + the one-shot auto-transfer).
  const lengthExpr = String(opts.lengthExpr ?? '').trim();
  let lengthUm = (Number.isFinite(opts.lengthUm) && opts.lengthUm > 0) ? opts.lengthUm
    : (lengthExpr ? evalExpr(lengthExpr, pv) : 0);
  if (!(Number.isFinite(lengthUm) && lengthUm > 0)) lengthUm = num(lineLengthUm);
  // q3d_line_len_um is a Q3D VARIABLE = the ACTUAL line length, declared as the
  // user's EXPRESSION so it TRACKS sweeps (e.g. a unit-cell count N → the report
  // re-divides as N changes). A length-typed value (refs µm params, or a bare
  // number → "<n>um") resolves to SI metres in a report expression, so the
  // C/length report divides by it directly. A blank expr bakes the numeric guess.
  const lenVar = lengthExpr
    ? (/^-?\d+(?:\.\d+)?$/.test(lengthExpr) ? `${lengthExpr}um` : lengthExpr)
    : `${dec(lengthUm)}um`;
  varDecls.push(`set_var("q3d_line_len_um", "${ascii(lenVar)}")  # ACTUAL line length (tracks sweeps); C/length = C / q3d_line_len_um`);

  // ---- Dielectric stack: parametric Z, numeric footprint (generous pad) ----
  const spanX = bb.xMax - bb.xMin, spanY = bb.yMax - bb.yMin;
  const pad = Math.max(50, spanX, spanY);
  const xPos = num(bb.xMin - pad), yPos = num(bb.yMin - pad);
  const xSize = num(spanX + 2 * pad), ySize = num(spanY + 2 * pad);
  const dielBlocks = [];
  for (const l of stack) {
    if (l.role === 'conductor') continue;
    if (zBottom[l.id] == null) continue;
    if (num(zTop[l.id] - zBottom[l.id]) <= 0) continue;
    const nm = `diel_${l.id}`.replace(/[^A-Za-z0-9_]/g, '_');
    dielBlocks.push(`${boxFn}(
    ["NAME:BoxParameters",
     "XPosition:=", "${xPos}um", "YPosition:=", "${yPos}um", "ZPosition:=", "(${zBottomExpr[l.id]})",
     "XSize:=", "${xSize}um", "YSize:=", "${ySize}um", "ZSize:=", "${exprUm(l.thickness || '0')}"],
    ["NAME:Attributes",
     "Name:=", "${nm}", "Flags:=", "", "Color:=", "(160 160 200)",
     "Transparency:=", 0.7, "PartCoordinateSystem:=", "Global",
     "MaterialValue:=", "\\"${ascii(l.material || 'vacuum')}\\"", "SolveInside:=", True],
    "${nm}")`);
  }

  const STD = new Set(['vacuum', 'air', 'copper', 'gold', 'aluminum', 'silicon', 'silicon_dioxide', 'silicon_nitride', 'FR4_epoxy', 'polyimide', 'Pec', 'Teflon_based']);
  const CUSTOM = { lithium_tantalate: [41.4, 1, 0, 0.001], lithium_niobate: [28.0, 1, 0, 0.001] };
  const usedMats = new Set([condMat, ...stack.filter((l) => l.role !== 'conductor').map((l) => l.material)]);
  const matDefs = [...usedMats].filter((m) => m && !STD.has(m)).map((m) => {
    const p = CUSTOM[m] || [4.0, 1, 0, 0.001];
    return `define_material("${ascii(m)}", ${p[0]}, ${p[1]}, ${p[2]}, ${p[3]})`;
  }).join('\n');

  const fAdaptGHz = (() => { const f = evalExpr(src.simSetup?.fnominal ?? '4', pv); return Number.isFinite(f) && f > 0 ? f : 4; })();
  const condComment = condWarnings.length
    ? condWarnings.map((w) => `# WARNING: ${ascii(w)}`).join('\n') + '\n'
    : '';
  return { varDecls, matDefs, dielBlocks, condBlocks, condObjs, condNets, condComment, fAdaptGHz, effThk, lengthUm: num(lengthUm) };
}

const CAP_SETUP = (fGHz, cg) => `["NAME:Setup1",
         "AdaptiveFreq:=", "${fGHz}GHz", "SaveFields:=", False, "Enabled:=", True,
         ["NAME:Cap", "MaxPass:=", ${cg.maxPass}, "MinPass:=", ${cg.minPass}, "MinConvPass:=", 1,
          "PerError:=", ${cg.perError}, "PerRefine:=", 30, "AutoIncreaseSolutionOrder:=", True,
          "SolutionOrder:=", "High", "Solver Type:=", "Iterative"]]`;

// Nets + setup + frequency sweep + SOLVE (shared, top-level). After the solve the
// C matrix is EXPORTED to a CSV via oDesign.ExportMatrixData (the only scriptable
// route — Q3D's expression parser rejects the matrix quantity C(netA,netB) as a
// function, "'C' is not a function name", in ANY report/output-variable
// expression, even post-solve). The same matrix is also visible under Results ->
// Solution Data -> Matrix. One signal net per conductor COMPONENT (all its
// sheets joined) so the matrix is conductor-to-conductor — the differential
// per-length formula assumes exactly 2 nets. Every COM call routes failures
// through q3d_msg (a guarded logger) so one bad call can never abort the script.
function q3dNetsSetupReports({ condNets, design, fAdaptGHz, lengthUm, sweep, cg }) {
  const groups = condNets || [];
  const nets = groups.map((n) =>
    `q3d_signal_net("${n.net}", [${n.objects.map((o) => `"${o}"`).join(', ')}])`).join('\n');
  const s = sweep || {};
  const startG = Number.isFinite(s.startGHz) ? s.startGHz : 1;
  const stopG = Number.isFinite(s.stopGHz) ? s.stopGHz : 40;
  const pts = (Number.isFinite(s.points) && s.points >= 1) ? Math.round(s.points) : 201;
  const cgv = {
    perError: (Number.isFinite(cg?.perError) && cg.perError > 0) ? cg.perError : 0.01,
    minPass: (Number.isFinite(cg?.minPass) && cg.minPass >= 1) ? Math.round(cg.minPass) : 15,
    maxPass: (Number.isFinite(cg?.maxPass) && cg.maxPass >= 1) ? Math.round(cg.maxPass) : 20,
  };
  const a = groups.length >= 2 ? groups[0].net : null;
  const b = groups.length >= 2 ? groups[1].net : null;
  const fHz = num((Number.isFinite(fAdaptGHz) ? fAdaptGHz : 4) * 1e9);
  const dname = (design || 'q3d_cap');
  // Per-length differential C as a REPORT expression. C(net,net) resolves in SI
  // Farads in a Q3D report; we divide by the Q3D VARIABLE q3d_line_len_um (the
  // ACTUAL line length) rather than a baked literal, so the plot TRACKS geometry
  // sweeps. A length-typed variable resolves to SI metres in a report expression
  // ⇒ C[F]/len[m] = F/m. (If the trace is off by ~1e6, q3d_line_len_um resolved
  // in µm not metres — make it a length-typed expression, not a bare count.)
  const diffC = (a && b) ? `((C(${a},${a})+C(${b},${b}))/2-C(${a},${b}))/2` : '';
  const perLen = `(${diffC})/q3d_line_len_um`;

  const extract = (a && b)
    ? `# Create the C-per-length PLOT BEFORE solving — with "Real time" update it then
# populates live as the adaptive passes + sweep run. Defining the trace needs NO
# solved data: the C(net,net) quantities exist as soon as the nets are assigned,
# and "Setup1 : Sweep1" is defined by InsertSweep above. The post-processing
# REPORT engine (unlike the design output-variable parser) accepts C(net,net)
# arithmetic and resolves it in SI Farads; it's divided by the q3d_line_len_um
# VARIABLE (actual length, metres in SI) so the trace is F/m AND tracks sweeps.
try:
    oRpt = oDesign.GetModule("ReportSetup")
    oRpt.CreateReport("C_per_length_F_per_m", "Matrix", "Rectangular Plot",
        "Setup1 : Sweep1", ["Context:=", "Original"], ["Freq:=", ["All"]],
        ["X Component:=", "Freq", "Y Component:=", ["${perLen}"]])
    q3d_msg(0, "Report 'C_per_length_F_per_m' created (F/m; tracks q3d_line_len_um). If off by ~1e15, C resolved in fF (use the CSV); if off by ~1e6, q3d_line_len_um resolved in um not metres -- make it a length-typed expression, not a bare count.")
except Exception as e:
    q3d_msg(1, "CreateReport failed (read the C matrix / CSV after solving): " + str(e))
# Solve the (fast) electrostatic capacitance. Comment out to mesh/solve manually.
try:
    oDesign.Analyze("Setup1")
except Exception as e:
    q3d_msg(2, "Q3D Analyze failed: " + str(e))
# Direct C-matrix dump to a CSV next to the project (post-solve). Maxwell C in fF.
try:
    _cdir = oProject.GetPath()
    _cfile = _cdir + "/${dname}_Cmatrix.csv"
    oDesign.ExportMatrixData(_cfile, "C", "", "Setup1 : LastAdaptive", "Original",
        "ohm", "nH", "fF", "mSie", ${fHz}, "Maxwell, Spice, Couple", 0, False)
    q3d_msg(0, "C matrix (fF) exported -> " + _cfile)
except Exception as e:
    q3d_msg(1, "ExportMatrixData failed; read Results -> Solution Data -> Matrix instead: " + str(e))
q3d_msg(0, "C-matrix nets: 1=${a}, 2=${b}. Maxwell off-diagonal C12 is NEGATIVE (|.| = mutual).")
q3d_msg(0, "Per-length line C (differential) = ((C11+C22)/2 - C12)/2 / q3d_line_len_um (q3d_line_len_um is the actual length variable; edit it / sweep it). Paste C into the 2-line wizard 'C per length'.")`
    : '# (need >=2 conductor nets for a conductor-to-conductor capacitance — select >=2 line conductors in the wizard)';

  return `# ===== Nets (one signal net per conductor COMPONENT; all its sheets joined) =====
oBnd = oDesign.GetModule("BoundarySetup")
def q3d_signal_net(net, objs):
    try:
        oBnd.AssignSignalNet(["NAME:" + net, "Objects:=", objs])
    except Exception as e:
        q3d_msg(1, "AssignSignalNet " + net + " failed: " + str(e))
${nets}

# ===== Capacitance setup + frequency sweep (same band as the 2-line wizard) =====
# Cap convergence: PerError = ${cgv.perError}% (CG/% delta-C), MinPass = ${cgv.minPass}, MaxPass = ${cgv.maxPass}.
oAna = oDesign.GetModule("AnalysisSetup")
try:
    oAna.InsertSetup("Matrix", ${CAP_SETUP(fAdaptGHz, cgv)})
except Exception as e:
    q3d_msg(2, "InsertSetup(Matrix) failed: " + str(e))
try:
    oAna.InsertSweep("Setup1",
        ["NAME:Sweep1", "IsEnabled:=", True, "RangeType:=", "LinearCount",
         "RangeStart:=", "${startG}GHz", "RangeEnd:=", "${stopG}GHz", "RangeCount:=", ${pts},
         "Type:=", "Interpolating", "SaveFields:=", False])
except Exception as e:
    q3d_msg(1, "InsertSweep failed (add a sweep from the GUI): " + str(e))

# ===== Solve + export the capacitance matrix =====
${extract}`;
}

// Guarded logger. oDesktop.AddMessage can ITSELF throw (stale/closed handle) and,
// if that throw escapes an except block, escalate a caught error into an
// "abnormal script termination". Never let it. Emitted before set_var so every
// helper can use it.
const Q3D_MSG_DEF = `def q3d_msg(sev, text):
    try:
        oDesktop.AddMessage("", "", sev, str(text))
    except:
        pass`;

const Q3D_HELPERS = (boxFn, polyFn, sweepFn, delFn) => `def _existing_objs():
    objs = set()
    for grp in ("Solids", "Sheets", "Unclassified"):
        try:
            for o in oEditor.GetObjectsInGroup(grp):
                objs.add(o)
        except:
            pass
    return objs
def ${delFn}(name):
    # Delete only if the object ALREADY exists. Deleting a non-existent object
    # raises a MODAL error that IronPython try/except CANNOT catch -> the script
    # host logs "abnormal script termination". On a freshly-inserted Q3D design
    # nothing exists yet, so an unguarded delete fired one abort per object.
    try:
        if name in _existing_objs():
            oEditor.Delete(["NAME:Selections", "Selections:=", name])
    except:
        pass
def ${boxFn}(bp, attr, name):
    ${delFn}(name)
    try:
        oEditor.CreateBox(bp, attr)
    except Exception as e:
        q3d_msg(1, "CreateBox " + name + " failed: " + str(e))
def ${polyFn}(pp, attr, name):
    ${delFn}(name)
    try:
        oEditor.CreatePolyline(pp, attr)
    except Exception as e:
        q3d_msg(1, "CreatePolyline " + name + " failed: " + str(e))
def ${sweepFn}(name, dz):
    try:
        oEditor.SweepAlongVector(
            ["NAME:Selections", "Selections:=", name, "NewPartsModelFlag:=", "Model"],
            ["NAME:VectorSweepParameters", "DraftAngle:=", "0deg", "DraftType:=", "Round",
             "CheckFaceFaceIntersection:=", False,
             "SweepVectorX:=", "0um", "SweepVectorY:=", "0um", "SweepVectorZ:=", dz])
    except Exception as e:
        q3d_msg(1, "Sweep " + name + " failed: " + str(e))`;

// Standalone Q3D capacitance script (own project + design).
export function generateQ3DCapacitance(scene, paramValues, opts = {}) {
  const body = buildQ3DBody(scene, paramValues, opts, 'safe_create_box', 'safe_create_polyline', 'safe_sweep_z');
  const design = (opts.designName || 'q3d_cap').replace(/[^A-Za-z0-9_]/g, '_');
  const sweep = { startGHz: opts.freqStartGHz, stopGHz: opts.freqStopGHz, points: opts.freqPoints };
  const code = `# -*- coding: utf-8 -*-
# Auto-generated PARAMETRIC Q3D Extractor capacitance script (AEDT: Tools -> Run Script).
# Per-length capacitance C of a MEANDERED line for Z0 = gamma/(j*w*C). Selected
# line conductor(s) as THIN CONDUCTORS (thickness var q3d_cond_thk = ${body.effThk}um):
# ${body.condObjs.length} object(s). Feeds excluded. Geometry references design variables
# (sweep width/gap/thickness/dielectric in Q3D and re-Analyze).
# CAVEAT: Q3D net/setup/sweep/report COM is not validated here — fix in the GUI
# if a call errors (the geometry is correct).
import ScriptEnv
ScriptEnv.Initialize("Ansoft.ElectronicsDesktop")
oDesktop.RestoreWindow()
oProject = oDesktop.NewProject()
oProject.InsertDesign("Q3D Extractor", "${design}", "", "")
oDesign = oProject.SetActiveDesign("${design}")
oEditor = oDesign.SetActiveEditor("3D Modeler")
${Q3D_MSG_DEF}
try:
    oEditor.SetModelUnits(["NAME:Units Parameter", "Units:=", "um", "Rescale:=", True])
except Exception as e:
    q3d_msg(1, "SetModelUnits failed: " + str(e))

def set_var(name, value):
    try:
        oDesign.SetVariableValue(name, value)
    except:
        try:
            oDesign.ChangeProperty(
                ["NAME:AllTabs", ["NAME:LocalVariableTab",
                 ["NAME:PropServers", "LocalVariables"],
                 ["NAME:NewProps", ["NAME:" + name, "PropType:=", "VariableProp",
                  "UserDef:=", True, "Value:=", value]]]])
        except Exception as e:
            q3d_msg(1, "set_var " + name + " failed: " + str(e))
${Q3D_HELPERS('safe_create_box', 'safe_create_polyline', 'safe_sweep_z', '_del')}
def define_material(name, eps_r, mu_r, sigma, tand):
    try:
        oProject.GetDefinitionManager().AddMaterial(
            ["NAME:" + name, "CoordinateSystemType:=", "Cartesian", ["NAME:AttachedData"],
             "permittivity:=", str(eps_r), "permeability:=", str(mu_r),
             "conductivity:=", str(sigma), "dielectric_loss_tangent:=", str(tand)])
    except Exception as e:
        q3d_msg(1, "AddMaterial " + name + " failed: " + str(e))

# ===== Design variables (edit + re-Analyze to sweep) =====
${body.varDecls.join('\n')}

# ===== Materials =====
${body.matDefs || '# (all materials are AEDT built-ins)'}

# ===== Dielectric stack (parametric Z) =====
${body.dielBlocks.join('\n') || '# (no dielectric layers)'}

# ===== Line conductor(s) — thin conductors (parametric) =====
${body.condComment}${body.condBlocks.join('\n')}

${q3dNetsSetupReports({ condNets: body.condNets, design, fAdaptGHz: body.fAdaptGHz, lengthUm: body.lengthUm, sweep, cg: { perError: opts.perError, minPass: opts.minPass, maxPass: opts.maxPass } })}

oProject.Save()
q3d_msg(0, "Parametric Q3D capacitance built + solved. C matrix exported to <project>/${design}_Cmatrix.csv (also Results -> Solution Data -> Matrix). Compute the per-length C and paste into the 2-line wizard.")
`;
  return ascii(code);
}

// A Python block adding a parametric Q3D design to the EXISTING 2-line project.
export function generateQ3DCombinedBlock(scene, paramValues, opts = {}) {
  const body = buildQ3DBody(scene, paramValues, opts, 'q3d_box', 'q3d_poly', 'q3d_sweep');
  const design = (opts.designName || 'q3d_cap').replace(/[^A-Za-z0-9_]/g, '_');
  const hfss = (opts.hfssDesignName || 'Layout').replace(/[^A-Za-z0-9_]/g, '_');
  const cVar = (opts.cVarName || 'tl_C_F_per_m');
  const sweep = { startGHz: opts.freqStartGHz, stopGHz: opts.freqStopGHz, points: opts.freqPoints };
  // Auto-transfer block: after the Q3D solves, read its C matrix, set <cVar> as a
  // post-processing var on the HFSS design (no re-solve), and plot Re/Im Z0. Uses
  // _tl_pp_var (defined in the HFSS part above) + q3d_msg (this block). The read
  // is echoed with sanity bounds so a mis-read is loud.
  const groups = body.condNets || [];
  const a = groups.length >= 2 ? groups[0].net : null;
  const b = groups.length >= 2 ? groups[1].net : null;
  const lengthM = dec((Number.isFinite(body.lengthUm) && body.lengthUm > 0 ? body.lengthUm : 1) * 1e-6);
  const fHz = num((Number.isFinite(body.fAdaptGHz) ? body.fAdaptGHz : 4) * 1e9);
  const transfer = (a && b) ? `# ===== Auto-transfer: Q3D C -> ${cVar} (post-processing) on '${hfss}' + Re/Im Z0 =====
# The Q3D design solved above. Read its C matrix, set ${cVar} on '${hfss}'
# (post-processing -> NO HFSS re-solve), and create the Re/Im Z0 report. After you
# Analyze '${hfss}', the Z0 reports use THIS C. The read is echoed with sanity
# bounds so a mis-read is loud.
_z0_C = None
try:
    oDesign = oProject.SetActiveDesign("${design}")
    _csv = oProject.GetPath() + "/${design}_Cmatrix_z0.csv"
    oDesign.ExportMatrixData(_csv, "C", "", "Setup1 : LastAdaptive", "Original",
        "ohm", "nH", "fF", "mSie", ${fHz}, "Maxwell, Spice, Couple", 0, False)
    _f = open(_csv); _txt = _f.read(); _f.close()
    # Whitespace-delimited, net-name-labeled square block between the markers.
    _cap = _txt.split("Capacitance Matrix")[1].split("Conductance Matrix")[0]
    _rows = [ln for ln in _cap.splitlines() if ln.strip()]
    _cols = _rows[0].split()
    _d = {}
    for _ln in _rows[1:]:
        _t = _ln.split()
        for _j in range(len(_cols)):
            _d[(_t[0], _cols[_j])] = float(_t[_j + 1])
    _C11 = _d[("${a}", "${a}")]; _C22 = _d[("${b}", "${b}")]; _C12 = _d[("${a}", "${b}")]
    _z0_C = (((_C11 + _C22) / 2.0 - _C12) / 2.0) * 1e-15 / ${lengthM}   # F/m (length baked)
    q3d_msg(0, "Q3D C [fF]: C11=%g C22=%g C12=%g -> C/length=%g F/m" % (_C11, _C22, _C12, _z0_C))
    if not (1e-12 < _z0_C < 1e-8):
        q3d_msg(2, "C/length=%g F/m is OUTSIDE ~1e-12..1e-8 -- CHECK nets (${a},${b}) / length / read before trusting Z0." % _z0_C)
except Exception as e:
    q3d_msg(1, "Auto C-transfer failed (set ${cVar} by hand from Results -> Matrix): " + str(e))
oDesign = oProject.SetActiveDesign("${hfss}")
if _z0_C is not None:
    try:
        _tl_pp_var("${cVar}", ("%.10g" % _z0_C))
        q3d_msg(0, "Set ${cVar} = " + ("%.10g" % _z0_C) + " F/m (post-processing) on '${hfss}'. Analyze it; the Z0 reports use this C.")
        oRpt = oDesign.GetModule("ReportSetup")
        try:
            oRpt.DeleteReports(["Z0 re+im (from Q3D C)"])
        except:
            pass
        oRpt.CreateReport("Z0 re+im (from Q3D C)", "Modal Solution Data", "Rectangular Plot",
            "Setup1 : Sweep", ["Domain:=", "Sweep"], ["Freq:=", ["All"]],
            ["X Component:=", "Freq", "Y Component:=", ["tl_Z0_re", "tl_Z0_im"]], [])
    except Exception as e:
        q3d_msg(1, "Set ${cVar} / Z0 report failed: " + str(e))`
    : `# (need >=2 conductor nets to auto-transfer C -> Z0; set ${cVar} by hand)
oDesign = oProject.SetActiveDesign("${hfss}")`;
  const code = `
# ===== Q3D capacitance design (same project, PARAMETRIC) — for Z0 = gamma/(j*w*C) =====
# Adds a Q3D Extractor design solving per-length C of the SINGLE line (only the
# selected conductor(s) as thin conductors; feeds excluded). After it solves,
# read 'C per length' and set the HFSS variable "${cVar}" on design "${hfss}".
# Reuses set_var + materials from the HFSS script above.
${Q3D_MSG_DEF}
try:
    oProject.InsertDesign("Q3D Extractor", "${design}", "", "")
    oDesign = oProject.SetActiveDesign("${design}")
    oEditor = oDesign.SetActiveEditor("3D Modeler")
    oEditor.SetModelUnits(["NAME:Units Parameter", "Units:=", "um", "Rescale:=", True])
except Exception as e:
    q3d_msg(2, "Q3D design create failed: " + str(e))

${Q3D_HELPERS('q3d_box', 'q3d_poly', 'q3d_sweep', '_q3d_del')}

# ===== Design variables (on the Q3D design) =====
${body.varDecls.join('\n')}

# ===== Dielectric stack (parametric Z) =====
${body.dielBlocks.join('\n')}
# ===== Line conductor(s) — thin conductors (parametric) =====
${body.condComment}${body.condBlocks.join('\n')}

${q3dNetsSetupReports({ condNets: body.condNets, design, fAdaptGHz: body.fAdaptGHz, lengthUm: body.lengthUm, sweep, cg: { perError: opts.perError, minPass: opts.minPass, maxPass: opts.maxPass } })}

oProject.Save()
q3d_msg(0, "Q3D design '${design}' built + solved (C matrix also at <project>/${design}_Cmatrix.csv).")

${transfer}
oProject.Save()
`;
  return ascii(code);
}
