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
// a capacitance setup + frequency sweep; the design is SOLVED, then the C matrix
// is EXPORTED to a CSV via oDesign.ExportMatrixData (and shown under Results ->
// Solution Data -> Matrix). No C report/output var is scripted — Q3D rejects the
// matrix quantity C(net,net) in any expression ("'C' is not a function name").
// The line capacitance is the DIFFERENTIAL capacitance ((C11+C22)/2 − C12)/2 —
// the port drives the strips differentially — NOT |C12|.
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
  const condComps = solved.filter((c) => wantIds.has(c.id) && c.kind !== 'boolean');
  if (condComps.length === 0) throw new Error('Select at least one line conductor for the Q3D capacitance run.');

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

  const lengthUm = (Number.isFinite(opts.lengthUm) && opts.lengthUm > 0) ? opts.lengthUm : num(lineLengthUm);
  varDecls.push(`set_var("q3d_line_len_um", "${dec(lengthUm)}")  # line PHYSICAL length (um) for C/length -- VERIFY (esp. meander)`);

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
  return { varDecls, matDefs, dielBlocks, condBlocks, condObjs, condNets, fAdaptGHz, effThk, lengthUm: num(lengthUm) };
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
function q3dNetsSetupReports({ condNets, design, fAdaptGHz, sweep, cg }) {
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

  const extract = (a && b)
    ? `# Solve the (fast) electrostatic capacitance, then EXPORT the matrix to CSV.
# Comment out the Analyze to mesh/solve manually first.
try:
    oDesign.Analyze("Setup1")
except Exception as e:
    q3d_msg(2, "Q3D Analyze failed: " + str(e))
# Direct C-matrix dump to a CSV next to the project. ExportMatrixData is the only
# scriptable export — Q3D rejects C(net,net) in a report expression. Maxwell C in fF.
try:
    _cdir = oProject.GetPath()
    _cfile = _cdir + "/${dname}_Cmatrix.csv"
    oDesign.ExportMatrixData(_cfile, "C", "", "Setup1 : LastAdaptive", "Original",
        "ohm", "nH", "fF", "mSie", ${fHz}, "Maxwell, Spice, Couple", 0, False)
    q3d_msg(0, "C matrix (fF) exported -> " + _cfile)
except Exception as e:
    q3d_msg(1, "ExportMatrixData failed; read Results -> Solution Data -> Matrix instead: " + str(e))
q3d_msg(0, "C-matrix nets: 1=${a}, 2=${b}. Maxwell off-diagonal C12 is NEGATIVE (|.| = mutual).")
q3d_msg(0, "Per-length line C (differential) = ((C11+C22)/2 - C12)/2 / (q3d_line_len_um*1e-6). Paste into the 2-line wizard 'C per length'.")`
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
${body.condBlocks.join('\n')}

${q3dNetsSetupReports({ condNets: body.condNets, design, fAdaptGHz: body.fAdaptGHz, sweep, cg: { perError: opts.perError, minPass: opts.minPass, maxPass: opts.maxPass } })}

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
${body.condBlocks.join('\n')}

${q3dNetsSetupReports({ condNets: body.condNets, design, fAdaptGHz: body.fAdaptGHz, sweep, cg: { perError: opts.perError, minPass: opts.minPass, maxPass: opts.maxPass } })}

oProject.Save()
q3d_msg(0, "Q3D design '${design}' built + solved. C matrix exported to <project>/${design}_Cmatrix.csv (also Results -> Solution Data -> Matrix). Compute per-length C, set ${cVar} on design '${hfss}'.")

# --- Optional AUTO-TRANSFER (uncomment after verifying the matrix read in your
#     AEDT release; a wrong read would silently corrupt Z0, so it's off by default) ---
# try:
#     oDesign = oProject.SetActiveDesign("${design}")
#     # ... read C_per_m from the solution, then: ...
#     oDesign = oProject.SetActiveDesign("${hfss}")
#     set_var("${cVar}", str(C_per_m_value))
# except Exception as e:
#     oDesktop.AddMessage("", "", 2, "Auto-transfer failed: " + str(e))
oDesign = oProject.SetActiveDesign("${hfss}")
`;
  return ascii(code);
}
