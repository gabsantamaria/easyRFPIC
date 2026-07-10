// GDS-II IMPORT — binary parser + hierarchy flattener + component builder.
//
// Pure module (no DOM): the upload dialog and tests both drive it.
//
//   parseGDS(bufferOrU8)          → { libName, umPerDbu, cells, warnings }
//   topCellsOf(parsed)            → cell names not referenced by any other
//   flattenGDSCell(parsed, name)  → { shapes, warnings }   (absolute µm)
//   gdsLayerStats(shapes)         → per (layer, datatype) counts
//   gdsShapesToComponents(...)    → scene components (polyshape / polyline)
//   suggestGdsPrefix(components)  → next free `gds<N>` id/param prefix
//
// Shape model out of the flattener: every BOUNDARY becomes a closed
// polygon, every PATH a centerline + width — both as absolute-µm point
// lists with (layer, datatype) provenance. SREF/AREF hierarchy is
// FLATTENED here (translate ∘ rotate ∘ magnify ∘ x-axis-reflection per
// the GDS STRANS convention, arrays expanded element-by-element), so the
// canvas only ever sees independent flat shapes.
//
// Component mapping contract (the import dialog's table):
//   mapping['<layer>/<datatype>'] = { include: bool, target }
//     target 'undef'      → layer 'gdsundef' (canvas-only until assigned;
//                           isNonModelComponent → every physical exporter
//                           skips it, HFSS included)
//     target 'wg'         → layer 'waveguide'
//     target 'cond:<id>'  → layer 'electrode' + conductorLayerId <id>
// Unchecked (include:false) layers are simply not imported.
//
// Every imported shape becomes ONE INDEPENDENT component (no grouping):
// a polyshape (BOUNDARY) or polyline (PATH) whose cx/cy is vertex 0 and
// whose remaining vertices are NUMERIC rel steps — exactly the path-kind
// frame contract, so the shape gets the standard 9 frame anchors, snap
// participation, the dashed displayBbox selection frame, and (because a
// pure-rel numeric chain passes pathFrameExprs' round-trip guard) fully
// PARAMETRIC snap chains in the HFSS export. Provenance rides along as
// `gdsSrc: { file, cell, layer, datatype }` (normalizeScene passthrough)
// so `<undefined>` shapes can be re-assigned per GDS layer later.

// ---------------------------------------------------------------------
// Record types (subset we understand; everything else is skipped).
const R = {
  HEADER: 0x00, BGNLIB: 0x01, LIBNAME: 0x02, UNITS: 0x03, ENDLIB: 0x04,
  BGNSTR: 0x05, STRNAME: 0x06, ENDSTR: 0x07,
  BOUNDARY: 0x08, PATH: 0x09, SREF: 0x0a, AREF: 0x0b, TEXT: 0x0c,
  LAYER: 0x0d, DATATYPE: 0x0e, WIDTH: 0x0f, XY: 0x10, ENDEL: 0x11,
  SNAME: 0x12, COLROW: 0x13, NODE: 0x15, TEXTTYPE: 0x16, PRESENTATION: 0x17,
  STRING: 0x19, STRANS: 0x1a, MAG: 0x1b, ANGLE: 0x1c, PATHTYPE: 0x21,
  NODETYPE: 0x2a, BOX: 0x2d, BOXTYPE: 0x2e, BGNEXTN: 0x30, ENDEXTN: 0x31,
};

// GDS REAL8: sign(1) | excess-64 base-16 exponent(7) | 56-bit mantissa,
// value = ±mantissa · 16^(exp−64) with 1/16 ≤ mantissa < 1. The exact
// inverse of the writer in src/export/gds.js.
export function decodeReal8(bytes, off = 0) {
  const b0 = bytes[off];
  const sign = (b0 & 0x80) ? -1 : 1;
  const exp = (b0 & 0x7f) - 64;
  let mant = 0;
  for (let j = 1; j < 8; j++) mant = mant + bytes[off + j] / Math.pow(256, j);
  if (mant === 0) return 0;
  return sign * mant * Math.pow(16, exp);
}

const ascii = (bytes, start, len) => {
  let s = '';
  for (let i = 0; i < len; i++) {
    const c = bytes[start + i];
    if (c === 0) break; // strip pad NUL
    s += String.fromCharCode(c);
  }
  return s;
};

// ---------------------------------------------------------------------
// parseGDS: one pass over the record stream. Returns cells keyed by name:
//   { shapes: [{ kind, layer, datatype, ptsDbu, widthDbu?, pathtype? }],
//     refs:   [{ cell, xDbu, yDbu, angleDeg, mirrorX, mag,
//                isArray, cols, rows, p0, pCol, pRow }] }
export function parseGDS(bufferOrU8) {
  const u8 = bufferOrU8 instanceof Uint8Array ? bufferOrU8 : new Uint8Array(bufferOrU8);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const warnings = [];
  let libName = '';
  let umPerDbu = 1e-3; // sane default: 1 dbu = 1 nm
  const cells = {};
  let curCell = null;
  let el = null; // element being accumulated
  const skipped = new Map(); // record name -> count (unknown/ignored)

  let off = 0;
  while (off + 4 <= u8.length) {
    const len = (u8[off] << 8) | u8[off + 1];
    if (len < 4) {
      // Padding at the end of tape-format files is all-zero; stop quietly.
      break;
    }
    const recType = u8[off + 2];
    const dataStart = off + 4;
    const dataLen = len - 4;
    if (dataStart + dataLen > u8.length) {
      warnings.push({ code: 'truncated', msg: 'File ends mid-record — imported what was readable.' });
      break;
    }
    switch (recType) {
      case R.HEADER: case R.BGNLIB: case R.BGNSTR: case R.ENDLIB:
        break; // dates/version — not needed
      case R.LIBNAME:
        libName = ascii(u8, dataStart, dataLen);
        break;
      case R.UNITS: {
        // Two REAL8: [dbu in user units, dbu in METERS]. µm/dbu = m·1e6.
        if (dataLen >= 16) {
          const meters = decodeReal8(u8, dataStart + 8);
          if (Number.isFinite(meters) && meters > 0) umPerDbu = meters * 1e6;
        }
        break;
      }
      case R.STRNAME: {
        const name = ascii(u8, dataStart, dataLen);
        curCell = cells[name] || (cells[name] = { shapes: [], refs: [] });
        break;
      }
      case R.ENDSTR:
        curCell = null;
        break;
      case R.BOUNDARY: case R.PATH: case R.BOX:
        el = { kind: recType === R.PATH ? 'path' : 'boundary', layer: 0, datatype: 0, ptsDbu: [], widthDbu: 0, pathtype: 0, isBox: recType === R.BOX };
        break;
      case R.SREF:
        el = { kind: 'sref', cell: '', xDbu: 0, yDbu: 0, angleDeg: 0, mirrorX: false, mag: 1 };
        break;
      case R.AREF:
        el = { kind: 'aref', cell: '', angleDeg: 0, mirrorX: false, mag: 1, cols: 1, rows: 1, pts: [] };
        break;
      case R.TEXT: case R.NODE:
        el = { kind: 'ignored', what: recType === R.TEXT ? 'TEXT' : 'NODE' };
        break;
      case R.LAYER:
        if (el) el.layer = dv.getInt16(dataStart, false);
        break;
      case R.DATATYPE: case R.BOXTYPE: case R.TEXTTYPE: case R.NODETYPE:
        if (el) el.datatype = dv.getInt16(dataStart, false);
        break;
      case R.WIDTH:
        if (el) el.widthDbu = dv.getInt32(dataStart, false);
        break;
      case R.PATHTYPE:
        if (el) el.pathtype = dv.getInt16(dataStart, false);
        break;
      case R.STRANS: {
        if (el) {
          const bits = dv.getUint16(dataStart, false);
          el.mirrorX = (bits & 0x8000) !== 0;
          // Absolute-magnification (0x0004) / absolute-angle (0x0002) bits:
          // "do not compose with parent transforms". We compose anyway
          // (KLayout-style) — flag it so a mis-placed reference is LOUD.
          if (bits & 0x0006) el.absTransform = true;
        }
        break;
      }
      case R.MAG:
        if (el) el.mag = decodeReal8(u8, dataStart);
        break;
      case R.ANGLE:
        if (el) el.angleDeg = decodeReal8(u8, dataStart);
        break;
      case R.SNAME:
        if (el) el.cell = ascii(u8, dataStart, dataLen);
        break;
      case R.COLROW:
        if (el) { el.cols = dv.getInt16(dataStart, false); el.rows = dv.getInt16(dataStart + 2, false); }
        break;
      case R.XY: {
        if (!el) break;
        const n = Math.floor(dataLen / 8);
        if (el.kind === 'boundary' || el.kind === 'path') {
          for (let i = 0; i < n; i++) {
            el.ptsDbu.push([dv.getInt32(dataStart + i * 8, false), dv.getInt32(dataStart + i * 8 + 4, false)]);
          }
        } else if (el.kind === 'sref') {
          if (n >= 1) { el.xDbu = dv.getInt32(dataStart, false); el.yDbu = dv.getInt32(dataStart + 4, false); }
        } else if (el.kind === 'aref') {
          for (let i = 0; i < Math.min(n, 3); i++) {
            el.pts.push([dv.getInt32(dataStart + i * 8, false), dv.getInt32(dataStart + i * 8 + 4, false)]);
          }
        }
        break;
      }
      case R.ENDEL: {
        if (el && curCell) {
          if (el.kind === 'boundary' || el.kind === 'path') {
            if (el.isBox) {
              // BOX elements are semantically rectangles — import as boundary.
              el.kind = 'boundary';
            }
            if (el.ptsDbu.length >= 2) curCell.shapes.push(el);
          } else if (el.kind === 'sref' || el.kind === 'aref') {
            if (el.cell) curCell.refs.push(el);
          } else if (el.kind === 'ignored') {
            skipped.set(el.what, (skipped.get(el.what) || 0) + 1);
          }
        }
        el = null;
        break;
      }
      default:
        skipped.set(`0x${recType.toString(16)}`, (skipped.get(`0x${recType.toString(16)}`) || 0) + 1);
        break;
    }
    off = dataStart + dataLen;
  }
  for (const [what, n] of skipped) {
    warnings.push({ code: 'skipped-records', msg: `${n} ${what} record(s) ignored (not geometry we import).` });
  }
  if (Object.keys(cells).length === 0) {
    warnings.push({ code: 'no-cells', msg: 'No structures (cells) found — is this a GDS-II file?' });
  }
  return { libName, umPerDbu, cells, warnings };
}

// METADATA cells — never design geometry. KLayout embeds a
// `$$$CONTEXT_INFO$$$` cell that references EVERY PCell/library cell
// once AT THE ORIGIN (identity placement) purely to record PCell
// provenance. Treating it as a top cell (it is referenced by nothing)
// flattened a phantom copy of every library bend/coupler stacked on one
// point — the "starburst" artifact on a real KLayout/gdsfactory die.
export const isGdsMetaCell = (name) => /^\$\$\$.*\$\$\$$/.test(name || '');

// Top-cell candidates: cells not referenced by any other cell —
// EXCLUDING metadata cells entirely (they are never candidates, and
// their refs don't count as "referencing", so the REAL design top
// surfaces from behind $$$CONTEXT_INFO$$$). Sorted by SUBTREE SHAPE
// COUNT (descending): unused library variants referenced only by the
// metadata cell also become unreferenced here, and the actual design
// dwarfs them.
export function topCellsOf(parsed) {
  const referenced = new Set();
  for (const [name, cell] of Object.entries(parsed.cells)) {
    if (isGdsMetaCell(name)) continue; // metadata refs are provenance, not placement
    for (const r of cell.refs) referenced.add(r.cell);
  }
  const tops = Object.keys(parsed.cells).filter(n => !referenced.has(n) && !isGdsMetaCell(n));
  // Memoized subtree shape count (ref-multiplied, capped so a huge AREF
  // can't overflow — ranking only needs relative order).
  const memo = new Map();
  const countOf = (name, stack) => {
    if (memo.has(name)) return memo.get(name);
    const cell = parsed.cells[name];
    if (!cell || stack.includes(name)) return 0;
    let n = cell.shapes.length;
    const nextStack = [...stack, name];
    for (const r of cell.refs) {
      const mult = r.kind === 'aref' ? Math.min((r.cols || 1) * (r.rows || 1), 10000) : 1;
      n += mult * countOf(r.cell, nextStack);
      if (n > 1e9) { n = 1e9; break; }
    }
    memo.set(name, n);
    return n;
  };
  return tops.sort((a, b) => countOf(b, []) - countOf(a, []));
}

// ---------------------------------------------------------------------
// flattenGDSCell: resolve the SREF/AREF hierarchy into absolute-µm shapes.
//
// GDS transform order (per the spec / KLayout behavior): a referenced
// cell's points are reflected about the X axis first (STRANS bit 0),
// then magnified, then rotated CCW by ANGLE, then translated to the
// reference point. Array lattice vectors are given in PARENT coordinates
// (the three AREF XY points), so array elements differ only by a parent-
// frame translation.
export function flattenGDSCell(parsed, cellName, { maxShapes = 100000, maxWalks = 2000000 } = {}) {
  const warnings = [];
  const out = [];
  const missing = new Set();
  let truncated = false;
  // TIME budget, separate from the SHAPE cap: an AREF whose referenced
  // cell yields no importable shapes (empty / annotation-only / missing)
  // still costs a matrix compose per lattice element — a spec-legal
  // 32767×32767 array of an empty cell would freeze the UI for ~40 s
  // with `out` never growing (adversarial-review find). Every walk()
  // entry counts against this budget, so flatten time is bounded even
  // when no shape is ever pushed.
  let walkBudget = maxWalks;
  let absTransformRefs = 0;

  const IDENT = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 }; // row-major 2x3
  const compose = (P, C) => ({
    a: P.a * C.a + P.b * C.c,
    b: P.a * C.b + P.b * C.d,
    c: P.c * C.a + P.d * C.c,
    d: P.c * C.b + P.d * C.d,
    tx: P.a * C.tx + P.b * C.ty + P.tx,
    ty: P.c * C.tx + P.d * C.ty + P.ty,
  });
  const refXform = (xDbu, yDbu, angleDeg, mirrorX, mag) => {
    const rad = (angleDeg || 0) * Math.PI / 180;
    const cos = Math.cos(rad), sin = Math.sin(rad);
    const m = mirrorX ? -1 : 1; // reflect about X axis: y -> -y (FIRST)
    const s = Number.isFinite(mag) && mag > 0 ? mag : 1;
    // T · R(angle) · S(mag) · MirrorY
    return {
      a: cos * s, b: -sin * s * m,
      c: sin * s, d: cos * s * m,
      tx: xDbu, ty: yDbu,
    };
  };
  const apply = (M, [x, y]) => [M.a * x + M.b * y + M.tx, M.c * x + M.d * y + M.ty];

  const walk = (name, M, stack) => {
    if (truncated || --walkBudget < 0) { truncated = true; return; }
    const cell = parsed.cells[name];
    if (!cell) { missing.add(name); return; }
    if (stack.includes(name)) {
      warnings.push({ code: 'cycle', msg: `Reference cycle through cell "${name}" — inner reference skipped.` });
      return;
    }
    // Uniform scale of the accumulated transform (mirror/rotation leave
    // |det| = mag², so this is exactly the composed magnification) —
    // PATH widths scale with it, same as the centerline points do.
    // NEGATIVE GDS widths are ABSOLUTE (spec: not affected by
    // magnification) — take |width| and skip the scale.
    const magScale = Math.sqrt(Math.abs(M.a * M.d - M.b * M.c)) || 1;
    for (const sh of cell.shapes) {
      if (out.length >= maxShapes) { truncated = true; return; }
      const rawWidthUm = (sh.widthDbu || 0) * parsed.umPerDbu;
      const widthUm = rawWidthUm < 0 ? -rawWidthUm : rawWidthUm * magScale;
      // RAW centerline only — PATH end styles (pathtype) are applied by
      // the outline builder in gdsShapesToComponents, never by mutating
      // the centerline (a shipped end-stretch hack here pushed a
      // CLOSED-LOOP path's first/last points apart — a visible notch).
      out.push({
        kind: sh.kind,
        layer: sh.layer, datatype: sh.datatype,
        cell: name,
        pathtype: sh.pathtype || 0,
        widthUm,
        pts: sh.ptsDbu.map(p => {
          const q = apply(M, p);
          return [q[0] * parsed.umPerDbu, q[1] * parsed.umPerDbu];
        }),
      });
    }
    const nextStack = [...stack, name];
    for (const r of cell.refs) {
      if (truncated) return;
      if (r.absTransform) absTransformRefs++;
      if (r.kind === 'sref') {
        walk(r.cell, compose(M, refXform(r.xDbu, r.yDbu, r.angleDeg, r.mirrorX, r.mag)), nextStack);
      } else {
        const [p0, pCol, pRow] = [r.pts[0], r.pts[1], r.pts[2]];
        if (!p0 || !pCol || !pRow || !(r.cols > 0) || !(r.rows > 0)) continue;
        // A missing referenced cell costs the same either way — skip the
        // whole lattice with ONE probe instead of cols×rows failed walks.
        if (!parsed.cells[r.cell]) { missing.add(r.cell); continue; }
        const colStep = [(pCol[0] - p0[0]) / r.cols, (pCol[1] - p0[1]) / r.cols];
        const rowStep = [(pRow[0] - p0[0]) / r.rows, (pRow[1] - p0[1]) / r.rows];
        for (let j = 0; j < r.rows; j++) {
          for (let i = 0; i < r.cols; i++) {
            if (truncated) return;
            const x = p0[0] + i * colStep[0] + j * rowStep[0];
            const y = p0[1] + i * colStep[1] + j * rowStep[1];
            walk(r.cell, compose(M, refXform(x, y, r.angleDeg, r.mirrorX, r.mag)), nextStack);
          }
        }
      }
    }
  };
  walk(cellName, IDENT, []);

  if (missing.size > 0) {
    warnings.push({ code: 'missing-cells', msg: `Referenced cell(s) not in the file: ${[...missing].join(', ')} — skipped.` });
  }
  if (truncated) {
    warnings.push({ code: 'truncated-shapes', msg: `Import capped (${maxShapes} shapes / ${maxWalks} placements) — uncheck layers or import a smaller cell.` });
  }
  if (absTransformRefs > 0) {
    warnings.push({ code: 'abs-strans', msg: `${absTransformRefs} reference(s) use ABSOLUTE magnification/angle (STRANS) — composed like relative transforms (KLayout behavior); verify placement.` });
  }
  return { shapes: out, warnings };
}

// ---------------------------------------------------------------------
// pathToOutline: flatten a GDS PATH's width into its OUTLINE polygon
// (KLayout-equivalent), so imports carry no stroked-rendering artifacts
// (miter spikes, cap seams). `pts` is the OPEN centerline (µm), `width`
// the full trace width, `pathtype` the GDS end style:
//   0 = butt (flush), 1 = round (polygonal arc, ARC_SEGS facets),
//   2 = square (extended by width/2). Unknown types render butt.
// Joins are NATURAL (offset-line intersections = miter) with a bevel
// fallback when the miter would spike past MITER_LIMIT × halfwidth
// (reflex/hairpin turns). Returns the closed outline as a point list
// (first point NOT repeated at the end), or null for degenerate input.
export function pathToOutline(pts, width, pathtype = 0) {
  const h = width / 2;
  if (!(h > 0) || !Array.isArray(pts) || pts.length < 2) return null;
  // Drop zero-length steps — they'd produce NaN directions.
  const P = [];
  for (const p of pts) {
    const prev = P[P.length - 1];
    if (prev && Math.hypot(p[0] - prev[0], p[1] - prev[1]) < 1e-9) continue;
    P.push(p);
  }
  if (P.length < 2) return null;
  const n = P.length;
  const dirs = []; // unit direction of segment i (P[i] -> P[i+1])
  for (let i = 0; i < n - 1; i++) {
    const dx = P[i + 1][0] - P[i][0], dy = P[i + 1][1] - P[i][1];
    const len = Math.hypot(dx, dy);
    dirs.push([dx / len, dy / len]);
  }
  const normal = ([ux, uy]) => [-uy, ux];
  const MITER_LIMIT = 4;
  const ARC_SEGS = 8;

  // One side of the band: offset points at sign s (+1 left of travel,
  // -1 right), walking start -> end with natural joins.
  const side = (s) => {
    const outPts = [];
    const n0 = normal(dirs[0]);
    outPts.push([P[0][0] + s * h * n0[0], P[0][1] + s * h * n0[1]]);
    for (let i = 1; i < n - 1; i++) {
      const u1 = dirs[i - 1], u2 = dirs[i];
      const n1 = normal(u1), n2 = normal(u2);
      const A = [P[i][0] + s * h * n1[0], P[i][1] + s * h * n1[1]];
      const B = [P[i][0] + s * h * n2[0], P[i][1] + s * h * n2[1]];
      const cross = u1[0] * u2[1] - u1[1] * u2[0];
      if (Math.abs(cross) < 1e-12) { // straight (or exact hairpin): keep A
        outPts.push(A);
        if (u1[0] * u2[0] + u1[1] * u2[1] < 0) outPts.push(B); // hairpin: both edges
        continue;
      }
      // Intersection of A + t·u1 and B + r·u2 (natural/miter join).
      const t = ((B[0] - A[0]) * u2[1] - (B[1] - A[1]) * u2[0]) / cross;
      const M = [A[0] + t * u1[0], A[1] + t * u1[1]];
      const miterLen = Math.hypot(M[0] - P[i][0], M[1] - P[i][1]);
      if (miterLen <= MITER_LIMIT * h) {
        outPts.push(M);
      } else { // sharp turn — bevel with the two offset endpoints
        outPts.push(A, B);
      }
    }
    const nL = normal(dirs[n - 2]);
    outPts.push([P[n - 1][0] + s * h * nL[0], P[n - 1][1] + s * h * nL[1]]);
    return outPts;
  };

  // End cap around center C, bulging along outward unit direction `u`;
  // sweeps from the +normal(u) offset to the −normal(u) offset.
  const cap = (C, u) => {
    const nn = normal(u);
    const pushArc = (arr) => {
      for (let k = 1; k < ARC_SEGS; k++) {
        const th = (Math.PI * k) / ARC_SEGS;
        // rotate the left-normal by -th about C (passes through +u at th=π/2)
        const dx = nn[0] * Math.cos(th) + nn[1] * Math.sin(th);
        const dy = -nn[0] * Math.sin(th) + nn[1] * Math.cos(th);
        arr.push([C[0] + h * dx, C[1] + h * dy]);
      }
    };
    if (pathtype === 1) { const a = []; pushArc(a); return a; }
    if (pathtype === 2) {
      const E = [C[0] + h * u[0], C[1] + h * u[1]]; // extended tip center
      return [
        [E[0] + h * nn[0], E[1] + h * nn[1]],
        [E[0] - h * nn[0], E[1] - h * nn[1]],
      ];
    }
    return []; // butt: straight connection
  };

  const left = side(+1);
  const right = side(-1);
  // Assemble: left start→end, END cap (left→right around the tip), right
  // end→start, START cap. The start cap built along the OUTWARD direction
  // −u₀ already sweeps right→left (its normal is the mirrored one), so it
  // drops in without reversal.
  const uEnd = dirs[n - 2];
  const uStart = [-dirs[0][0], -dirs[0][1]];
  return [...left, ...cap(P[n - 1], uEnd), ...right.reverse(), ...cap(P[0], uStart)];
}

// Per-(layer, datatype) stats for the mapping dialog table.
export function gdsLayerStats(shapes) {
  const byKey = new Map();
  for (const s of shapes) {
    const key = `${s.layer}/${s.datatype}`;
    let e = byKey.get(key);
    if (!e) { e = { key, layer: s.layer, datatype: s.datatype, shapes: 0, vertices: 0, paths: 0 }; byKey.set(key, e); }
    e.shapes++;
    e.vertices += s.pts.length;
    if (s.kind === 'path') e.paths++;
  }
  return [...byKey.values()].sort((a, b) => (a.layer - b.layer) || (a.datatype - b.datatype));
}

// Next free `gds<N>` prefix — imported ids/params are `gds<N>_<k>` so
// repeat imports never collide (same convention as the AI assistant's
// `ai<N>` prefixes).
export function suggestGdsPrefix(components) {
  let maxN = 0;
  for (const c of components || []) {
    const m = /^gds(\d+)_/.exec(c.id || '');
    if (m) maxN = Math.max(maxN, parseInt(m[1], 10));
  }
  return `gds${maxN + 1}`;
}

// µm number → expression-string literal. Rounded to 1e-6 µm (1 pm) so
// float noise doesn't bloat vertex strings; the rounding floor keeps
// String() out of exponent notation (evalExpr-safe).
const fmtUm = (v) => {
  const r = Math.round(v * 1e6) / 1e6;
  return Object.is(r, -0) ? '0' : String(r);
};

// Dialog mapping target → component layer fields (shared by both import
// modes).
const targetFields = (target) => {
  if (typeof target === 'string' && target.startsWith('cond:')) {
    return { layer: 'electrode', conductorLayerId: target.slice(5) };
  }
  if (target === 'wg') return { layer: 'waveguide' };
  return { layer: 'gdsundef' }; // 'undef' and anything unknown
};

// Consecutive-duplicate removal (zero-length rel steps break nothing
// but bloat the chain) + COLLINEAR pruning: a mid-point within 1 nm of
// the straight line between its neighbors (and travelling FORWARD —
// spikes reverse direction and are kept) is redundant tessellation
// noise; dropping it shrinks huge imported chains without moving any
// edge by more than fab resolution. Vertex 0 (the component root) is
// never pruned.
const sanitize = (pts, closed) => {
  const dedup = [];
  for (const p of pts) {
    const prev = dedup[dedup.length - 1];
    if (prev && Math.abs(prev[0] - p[0]) < 1e-9 && Math.abs(prev[1] - p[1]) < 1e-9) continue;
    dedup.push(p);
  }
  if (closed && dedup.length >= 2) {
    const [fx, fy] = dedup[0];
    const [lx, ly] = dedup[dedup.length - 1];
    if (Math.abs(fx - lx) < 1e-9 && Math.abs(fy - ly) < 1e-9) dedup.pop();
  }
  if (dedup.length < 3) return dedup;
  const COLLIN_TOL = 1e-3; // µm — 1 nm perpendicular deviation
  const keep = [dedup[0]];
  const last = () => keep[keep.length - 1];
  for (let i = 1; i < dedup.length; i++) {
    const isLast = i === dedup.length - 1;
    // Next point after i (wraps to v0 for closed outlines so the
    // closing edge prunes too; the open-chain end point always stays).
    const nxt = isLast ? (closed ? dedup[0] : null) : dedup[i + 1];
    if (nxt) {
      const a = last(), b = dedup[i];
      const abx = nxt[0] - a[0], aby = nxt[1] - a[1];
      const len = Math.hypot(abx, aby);
      if (len > 1e-9) {
        const perp = Math.abs((b[0] - a[0]) * aby - (b[1] - a[1]) * abx) / len;
        const forward = (b[0] - a[0]) * abx + (b[1] - a[1]) * aby;
        if (perp < COLLIN_TOL && forward > 0 && forward < len * len) continue; // prune b
      }
    }
    keep.push(dedup[i]);
  }
  return keep;
};

// ---------------------------------------------------------------------
// gdsShapesToComponents: apply the dialog mapping and build components.
//
// opts:
//   prefix       — id prefix (suggestGdsPrefix)
//   file         — source filename (provenance)
//   at           — {x, y} world µm: center the imported bbox there.
//                  Omit/null → keep original GDS coordinates.
//   forcedOffset — {dx, dy} world µm: EXACT translation to apply to every
//                  shape (wins over `at`). Used to REGISTER a re-import of
//                  the same file with shapes already in the scene: every
//                  component records its ORIGINAL GDS root in gdsSrc
//                  (v0x/v0y), so `existing.cx − existing.gdsSrc.v0x` is
//                  the live offset of the earlier import — applying it
//                  here keeps ALL original inter-shape distances exact
//                  across imports (per-import recentering used to stack
//                  different layer subsets of one file on top of each
//                  other — a real shipped bug).
export function gdsShapesToComponents(shapes, mapping, opts = {}) {
  const { prefix = 'gds1', file = '', at = null, forcedOffset = null } = opts;
  const warnings = [];
  const included = shapes.filter(s => {
    const m = mapping[`${s.layer}/${s.datatype}`];
    return m && m.include !== false;
  });

  // One translation for EVERY shape (relative geometry always exact):
  // forced registration offset first, else recentering on `at`.
  let dx = 0, dy = 0;
  if (forcedOffset && Number.isFinite(forcedOffset.dx) && Number.isFinite(forcedOffset.dy)) {
    dx = forcedOffset.dx;
    dy = forcedOffset.dy;
  } else if (at && included.length > 0) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const s of included) {
      for (const [x, y] of s.pts) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
    dx = at.x - (minX + maxX) / 2;
    dy = at.y - (minY + maxY) / 2;
  }

  const components = [];
  let k = 0, degenerate = 0;
  for (const s of included) {
    const m = mapping[`${s.layer}/${s.datatype}`];
    const raw = s.pts.map(([x, y]) => [x + dx, y + dy]);
    const isPath = s.kind === 'path';
    // PATH flattening: closed-loop centerlines (first == last point —
    // rings drawn as paths) stay CLOSED constant-width polylines (no end
    // caps exist, so no cap artifacts); open widthful paths are flattened
    // to their OUTLINE polygon (pathToOutline — exact caps per pathtype,
    // natural joins), which is what KLayout renders and what kills the
    // stroked-rendering artifact family. Width-less paths (w <= 0,
    // marker/annotation traces) stay thin open polylines.
    let pts = raw;
    let emitKind = isPath ? 'polyline' : 'polyshape';
    let emitClosed = !isPath;
    let emitWidth = null;
    if (isPath) {
      const loop = raw.length >= 3
        && Math.abs(raw[0][0] - raw[raw.length - 1][0]) < 1e-9
        && Math.abs(raw[0][1] - raw[raw.length - 1][1]) < 1e-9;
      if (loop) {
        emitClosed = true;
        emitWidth = fmtUm(s.widthUm > 0 ? s.widthUm : 1);
        pts = raw.slice(0, -1); // closed polyline: implicit closing edge
      } else if (s.widthUm > 0) {
        const outline = pathToOutline(raw, s.widthUm, s.pathtype);
        if (outline) {
          pts = outline;
          emitKind = 'polyshape';
          emitClosed = true;
        } else {
          emitWidth = '1';
        }
      } else {
        emitWidth = '1';
      }
    }
    const dedup = sanitize(pts, emitClosed);
    const minVerts = emitKind === 'polyshape' || emitClosed ? 3 : 2;
    if (dedup.length < minVerts) { degenerate++; continue; }

    const vertices = dedup.map(([x, y], i) => (i === 0
      ? { kind: 'rel', dx: '0', dy: '0' }
      : { kind: 'rel', dx: fmtUm(x - dedup[i - 1][0]), dy: fmtUm(y - dedup[i - 1][1]) }));

    const base = {
      id: `${prefix}_${++k}`,
      cx: dedup[0][0], cy: dedup[0][1],  // path-kind contract: cx/cy = vertex 0
      w: '0', h: '0',
      cutouts: [], transforms: [],
      vertices,
      label: `${prefix} L${s.layer}/${s.datatype}`,
      // v0x/v0y = this shape's root in ORIGINAL GDS coordinates (before
      // dx/dy). `cx − v0x` therefore always yields the live offset of an
      // import — a later re-import of the same file uses it as
      // forcedOffset to land in exact registration (and it keeps
      // tracking even after the user drags the earlier import around).
      // The outline builder + sanitizer are deterministic, so v0 is the
      // SAME derived point on every import of the same file.
      gdsSrc: {
        file, cell: s.cell || '', layer: s.layer, datatype: s.datatype,
        v0x: dedup[0][0] - dx, v0y: dedup[0][1] - dy,
      },
      ...targetFields(m.target),
    };
    if (emitKind === 'polyline') {
      components.push({ ...base, kind: 'polyline', width: emitWidth || '1', closed: emitClosed });
    } else {
      components.push({ ...base, kind: 'polyshape', closed: true });
    }
  }
  if (degenerate > 0) {
    warnings.push({ code: 'degenerate', msg: `${degenerate} shape(s) skipped (too few distinct vertices).` });
  }
  return { components, warnings };
}

// ---------------------------------------------------------------------
// IMMUTABLE IMPORT MODE — gdsShapesToGroups.
//
// One `gdsgroup` component PER MAPPED GDS LAYER, holding the layer's
// ENTIRE flattened geometry as PACKED numeric rings — the way an HFSS
// "Import GDS" behaves: static geometry you position, snap to, and
// export, but never vertex-edit. This is the scalable path for real
// dies (the per-shape editable mode turned a 1.4 MB GDS into a 76 MB
// design file; packed rings are ~10-20× smaller and render as ONE
// <path> per layer).
//
// Component shape (rect-frame semantics — everything existing Just
// Works):
//   { id, kind: 'gdsgroup',
//     layer / conductorLayerId (from the mapping target),
//     cx, cy,          // numeric BBOX CENTER (the drag handle)
//     w, h,            // NUMERIC literal strings (immutable dims) —
//                      // anchors/snaps/selection frame flow through the
//                      // standard rect-frame code paths untouched
//     rings: [[x0,y0,x1,y1,...], ...],  // flat, LOCAL to (cx,cy),
//                      // rounded to 1e-4 µm, CCW-normalized (nonzero
//                      // fill = union overdraw, per GDS layer semantics)
//     gdsSrc: { file, cell, layer, datatype, v0x, v0y } }
//                      // v0x/v0y = ORIGINAL GDS coords of the center —
//                      // same registration contract as editable mode
//
// PATH shapes flatten exactly like editable mode: open → pathToOutline
// ring; closed-loop → band = OUTER + INNER offset rings (miter joins);
// width-less paths are skipped with a warning (no 1-D geometry in a
// packed group).
const roundRing = (pts, cx, cy) => {
  const flat = new Array(pts.length * 2);
  for (let i = 0; i < pts.length; i++) {
    flat[i * 2] = Math.round((pts[i][0] - cx) * 1e4) / 1e4;
    flat[i * 2 + 1] = Math.round((pts[i][1] - cy) * 1e4) / 1e4;
  }
  return flat;
};
const ringSignedArea = (pts) => {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
};

export function gdsShapesToGroups(shapes, mapping, opts = {}) {
  const { prefix = 'gds1', file = '', at = null, forcedOffset = null } = opts;
  const warnings = [];
  const included = shapes.filter(s => {
    const m = mapping[`${s.layer}/${s.datatype}`];
    return m && m.include !== false;
  });

  // Same one-translation-for-everything contract as editable mode.
  let dx = 0, dy = 0;
  if (forcedOffset && Number.isFinite(forcedOffset.dx) && Number.isFinite(forcedOffset.dy)) {
    dx = forcedOffset.dx;
    dy = forcedOffset.dy;
  } else if (at && included.length > 0) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const s of included) {
      for (const [x, y] of s.pts) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
    dx = at.x - (minX + maxX) / 2;
    dy = at.y - (minY + maxY) / 2;
  }

  // Group shapes by (layer, datatype) and build each group's rings.
  const byKey = new Map();
  for (const s of included) {
    const key = `${s.layer}/${s.datatype}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(s);
  }

  const components = [];
  let degenerate = 0, widthless = 0, loopK = 0;
  for (const [key, group] of byKey) {
    const m = mapping[key];
    const [gLayer, gDt] = key.split('/').map(Number);
    const rings = []; // world-µm point lists (converted to local at the end)
    for (const s of group) {
      const raw = s.pts.map(([x, y]) => [x + dx, y + dy]);
      if (s.kind === 'path') {
        const loop = raw.length >= 3
          && Math.abs(raw[0][0] - raw[raw.length - 1][0]) < 1e-9
          && Math.abs(raw[0][1] - raw[raw.length - 1][1]) < 1e-9;
        if (!(s.widthUm > 0)) { widthless++; continue; }
        if (loop) {
          // A closed-loop path is an ANNULAR BAND — its inner offset ring
          // is a HOLE, and the packed-rings model has no hole semantics
          // (two independent fill rings imported the band as a SOLID DISK
          // in EVERY consumer — a probe-confirmed adversarial-review
          // find: a ring electrode became a dead short in HFSS/Q2D).
          // Emit it as a separate CLOSED constant-width POLYLINE instead
          // — exactly what editable mode does; every consumer renders /
          // exports the band correctly today.
          const pts = sanitize(raw.slice(0, -1), true);
          if (pts.length >= 3) {
            components.push({
              id: `${prefix}_loop${++loopK}`,
              kind: 'polyline',
              cx: pts[0][0], cy: pts[0][1],
              w: '0', h: '0',
              width: fmtUm(s.widthUm), closed: true,
              cutouts: [], transforms: [],
              vertices: pts.map(([x, y], i) => (i === 0
                ? { kind: 'rel', dx: '0', dy: '0' }
                : { kind: 'rel', dx: fmtUm(x - pts[i - 1][0]), dy: fmtUm(y - pts[i - 1][1]) })),
              label: `${prefix} loop L${key}`,
              gdsSrc: { file, cell: s.cell || '', layer: gLayer, datatype: gDt, v0x: pts[0][0] - dx, v0y: pts[0][1] - dy },
              ...targetFields(m.target),
            });
          } else degenerate++;
        } else {
          const outline = pathToOutline(raw, s.widthUm, s.pathtype);
          if (outline) rings.push(outline); else degenerate++;
        }
      } else {
        const ring = sanitize(raw, true);
        if (ring.length >= 3) rings.push(ring); else degenerate++;
      }
    }
    if (rings.length === 0) continue;
    // Group bbox → center + numeric dims.
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const ring of rings) {
      for (const [x, y] of ring) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
    const cx = Math.round(((minX + maxX) / 2) * 1e4) / 1e4;
    const cy = Math.round(((minY + maxY) / 2) * 1e4) / 1e4;
    // CCW-normalize (nonzero fill = union overdraw), pack local+rounded.
    const packed = rings.map(ring => roundRing(ringSignedArea(ring) < 0 ? [...ring].reverse() : ring, cx, cy));
    const nVerts = packed.reduce((a, r) => a + r.length / 2, 0);
    components.push({
      id: `${prefix}_L${gLayer}_${gDt}`,
      kind: 'gdsgroup',
      cx, cy,
      w: fmtUm(Math.max(maxX - minX, 1e-4)),
      h: fmtUm(Math.max(maxY - minY, 1e-4)),
      rings: packed,
      cutouts: [], transforms: [],
      label: `${file || 'gds'} L${key} (${rings.length} shapes, ${nVerts} pts)`,
      gdsSrc: { file, cell: group[0].cell || '', layer: gLayer, datatype: gDt, v0x: cx - dx, v0y: cy - dy },
      ...targetFields(m.target),
    });
  }
  if (degenerate > 0) warnings.push({ code: 'degenerate', msg: `${degenerate} shape(s) skipped (too few distinct vertices).` });
  if (widthless > 0) warnings.push({ code: 'widthless-paths', msg: `${widthless} width-less path(s) skipped in immutable mode (no 1-D geometry in a packed layer group).` });
  return { components, warnings };
}
