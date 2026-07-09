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
      case R.STRANS:
        if (el) el.mirrorX = (dv.getUint16(dataStart, false) & 0x8000) !== 0;
        break;
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

// Cells not referenced by any other cell — the import candidates.
export function topCellsOf(parsed) {
  const referenced = new Set();
  for (const cell of Object.values(parsed.cells)) {
    for (const r of cell.refs) referenced.add(r.cell);
  }
  return Object.keys(parsed.cells).filter(n => !referenced.has(n));
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
  let roundEndPaths = 0;

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
      let pts = sh.ptsDbu.map(p => {
        const q = apply(M, p);
        return [q[0] * parsed.umPerDbu, q[1] * parsed.umPerDbu];
      });
      // PATHTYPE 1 (round) / 2 (square-extended) ends both extend the
      // metal by width/2 beyond each endpoint — extend the flattened
      // centerline so the imported polyline keeps the physical length
      // (butt-join rendering approximates round ends as square; warned).
      if (sh.kind === 'path' && (sh.pathtype === 1 || sh.pathtype === 2) && widthUm > 0 && pts.length >= 2) {
        const ext = widthUm / 2;
        const stretch = (a, b) => { // move a AWAY from b by ext
          const dx = a[0] - b[0], dy = a[1] - b[1];
          const len = Math.hypot(dx, dy);
          return len > 1e-12 ? [a[0] + (dx / len) * ext, a[1] + (dy / len) * ext] : a;
        };
        pts = [...pts];
        pts[0] = stretch(pts[0], pts[1]);
        pts[pts.length - 1] = stretch(pts[pts.length - 1], pts[pts.length - 2]);
        if (sh.pathtype === 1) roundEndPaths++;
      }
      out.push({
        kind: sh.kind,
        layer: sh.layer, datatype: sh.datatype,
        cell: name,
        pathtype: sh.pathtype || 0,
        widthUm,
        pts,
      });
    }
    const nextStack = [...stack, name];
    for (const r of cell.refs) {
      if (truncated) return;
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
  if (roundEndPaths > 0) {
    warnings.push({ code: 'round-ends', msg: `${roundEndPaths} path(s) had ROUND ends (pathtype 1) — imported at full physical length with square ends.` });
  }
  return { shapes: out, warnings };
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

// ---------------------------------------------------------------------
// gdsShapesToComponents: apply the dialog mapping and build components.
//
// opts:
//   prefix     — id prefix (suggestGdsPrefix)
//   file       — source filename (provenance)
//   at         — {x, y} world µm: center the imported bbox there.
//                Omit/null → keep original GDS coordinates.
export function gdsShapesToComponents(shapes, mapping, opts = {}) {
  const { prefix = 'gds1', file = '', at = null } = opts;
  const warnings = [];
  const included = shapes.filter(s => {
    const m = mapping[`${s.layer}/${s.datatype}`];
    return m && m.include !== false;
  });

  // Optional recentering: overall bbox center → `at`.
  let dx = 0, dy = 0;
  if (at && included.length > 0) {
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

  const targetFields = (target) => {
    if (typeof target === 'string' && target.startsWith('cond:')) {
      return { layer: 'electrode', conductorLayerId: target.slice(5) };
    }
    if (target === 'wg') return { layer: 'waveguide' };
    return { layer: 'gdsundef' }; // 'undef' and anything unknown
  };

  const components = [];
  let k = 0, degenerate = 0;
  for (const s of included) {
    const m = mapping[`${s.layer}/${s.datatype}`];
    let pts = s.pts.map(([x, y]) => [x + dx, y + dy]);
    if (s.kind === 'boundary') {
      // GDS BOUNDARY repeats the first point as the last — drop it, plus
      // any other consecutive duplicates (they'd make zero-length rel steps).
      if (pts.length >= 2) {
        const [fx, fy] = pts[0];
        const [lx, ly] = pts[pts.length - 1];
        if (Math.abs(fx - lx) < 1e-9 && Math.abs(fy - ly) < 1e-9) pts = pts.slice(0, -1);
      }
    }
    const dedup = [];
    for (const p of pts) {
      const prev = dedup[dedup.length - 1];
      if (prev && Math.abs(prev[0] - p[0]) < 1e-9 && Math.abs(prev[1] - p[1]) < 1e-9) continue;
      dedup.push(p);
    }
    const isPath = s.kind === 'path';
    const minVerts = isPath ? 2 : 3;
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
      gdsSrc: { file, cell: s.cell || '', layer: s.layer, datatype: s.datatype },
      ...targetFields(m.target),
    };
    if (isPath) {
      components.push({ ...base, kind: 'polyline', width: fmtUm(s.widthUm > 0 ? s.widthUm : 1), closed: false });
    } else {
      components.push({ ...base, kind: 'polyshape', closed: true });
    }
  }
  if (degenerate > 0) {
    warnings.push({ code: 'degenerate', msg: `${degenerate} shape(s) skipped (fewer than 3 distinct vertices).` });
  }
  return { components, warnings };
}
