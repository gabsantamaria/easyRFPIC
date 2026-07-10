// GDS-II IMPORT (src/gds/gds-import.js) — binary parser, hierarchy
// flattener, and component builder; plus the 'gdsundef' non-model
// contract and HFSS parametric-snap integration.
import { describe, it, expect } from 'vitest';
import {
  decodeReal8, parseGDS, topCellsOf, flattenGDSCell, gdsLayerStats,
  gdsShapesToComponents, suggestGdsPrefix,
} from '../src/gds/gds-import.js';
import { generateGDS } from '../src/export/gds.js';
import { generateHfssNative } from '../src/export/hfss-native.js';
import { normalizeScene, makeDefaultScene, isNonModelComponent } from '../src/scene/schema.js';
import { resolveParams } from '../src/scene/params.js';
import { solveLayout, validateSnapGraph } from '../src/scene/solver.js';
import { anchorWorld } from '../src/scene/anchors.js';

// ---------------------------------------------------------------------
// Synthetic GDS byte-stream builders (mirror the writer's record format).
const rec = (type, dataType, payload = new Uint8Array(0)) => {
  const b = new Uint8Array(4 + payload.length);
  const total = payload.length + 4;
  b[0] = (total >> 8) & 0xff; b[1] = total & 0xff;
  b[2] = type; b[3] = dataType;
  b.set(payload, 4);
  return b;
};
const int2 = (...vals) => {
  const b = new Uint8Array(vals.length * 2);
  const dv = new DataView(b.buffer);
  vals.forEach((v, i) => dv.setInt16(i * 2, v, false));
  return b;
};
const int4 = (...vals) => {
  const b = new Uint8Array(vals.length * 4);
  const dv = new DataView(b.buffer);
  vals.forEach((v, i) => dv.setInt32(i * 4, v, false));
  return b;
};
// GDS REAL8 encoder — same algorithm as src/export/gds.js writeReal8.
const real8 = (...vals) => {
  const buf = new Uint8Array(vals.length * 8);
  vals.forEach((v0, i) => {
    let v = v0;
    const off = i * 8;
    if (v === 0) return;
    let sign = 0;
    if (v < 0) { sign = 1; v = -v; }
    let exp = 0;
    while (v >= 1) { v /= 16; exp++; if (exp > 63) break; }
    while (v < 1 / 16 && exp > -64) { v *= 16; exp--; }
    buf[off] = (sign << 7) | ((exp + 64) & 0x7f);
    let mant = v;
    for (let j = 1; j < 8; j++) {
      mant *= 256;
      const byte = Math.floor(mant) & 0xff;
      buf[off + j] = byte;
      mant -= byte;
    }
  });
  return buf;
};
const asciiRec = (type, s) => {
  let t = s;
  if (t.length & 1) t += '\0';
  return rec(type, 0x06, new Uint8Array([...t].map(c => c.charCodeAt(0))));
};
const cat = (...chunks) => {
  const total = chunks.reduce((a, c) => a + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
};
const R = {
  HEADER: 0x00, BGNLIB: 0x01, LIBNAME: 0x02, UNITS: 0x03, ENDLIB: 0x04,
  BGNSTR: 0x05, STRNAME: 0x06, ENDSTR: 0x07, BOUNDARY: 0x08, PATH: 0x09,
  SREF: 0x0a, AREF: 0x0b, LAYER: 0x0d, DATATYPE: 0x0e, WIDTH: 0x0f,
  XY: 0x10, ENDEL: 0x11, SNAME: 0x12, COLROW: 0x13, STRANS: 0x1a,
  ANGLE: 0x1c,
};
const dates = int2(2026, 1, 1, 0, 0, 0, 2026, 1, 1, 0, 0, 0);
const libHeader = () => cat(
  rec(R.HEADER, 0x02, int2(600)),
  rec(R.BGNLIB, 0x02, dates),
  asciiRec(R.LIBNAME, 'TESTLIB'),
  rec(R.UNITS, 0x05, real8(1e-3, 1e-9)), // 1 dbu = 1 nm
);
const bgnstr = (name) => cat(rec(R.BGNSTR, 0x02, dates), asciiRec(R.STRNAME, name));
// A closed unit-square boundary (nm coords), first point repeated last.
const boundary = (layer, dt, ptsNm) => cat(
  rec(R.BOUNDARY, 0x00),
  rec(R.LAYER, 0x02, int2(layer)),
  rec(R.DATATYPE, 0x02, int2(dt)),
  rec(R.XY, 0x03, int4(...ptsNm.flat())),
  rec(R.ENDEL, 0x00),
);

// ---------------------------------------------------------------------

describe('REAL8 decode', () => {
  it('inverts the writer encoding across magnitudes and signs', () => {
    for (const v of [0, 1, -1, 1e-3, 1e-9, 2.5e-6, 123456.789, -0.001953125, 16, 1 / 16]) {
      const enc = real8(v);
      expect(Math.abs(decodeReal8(enc, 0) - v)).toBeLessThan(Math.abs(v) * 1e-12 + 1e-18);
    }
  });
});

describe('parseGDS — writer round-trip', () => {
  const scene = normalizeScene(makeDefaultScene());
  const pv = resolveParams(scene.params).values;
  const bytes = generateGDS(scene, pv);
  const parsed = parseGDS(bytes);

  it('reads the library, units, and one structure', () => {
    expect(parsed.libName.length).toBeGreaterThan(0);
    expect(Math.abs(parsed.umPerDbu - 1e-3)).toBeLessThan(1e-12); // 1 dbu = 1 nm
    expect(Object.keys(parsed.cells).length).toBe(1);
  });

  it('recovers shapes on the writer layer mapping (wg=1, conductors=10+)', () => {
    const [cellName] = Object.keys(parsed.cells);
    const { shapes } = flattenGDSCell(parsed, cellName);
    expect(shapes.length).toBeGreaterThan(0);
    const layers = new Set(shapes.map(s => s.layer));
    expect(layers.has(1)).toBe(true);   // waveguide
    expect([...layers].some(l => l >= 10 && l < 100)).toBe(true); // conductor
    // Coordinates come back in µm at sane magnitudes.
    for (const s of shapes) {
      for (const [x, y] of s.pts) {
        expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true);
        expect(Math.abs(x)).toBeLessThan(1e5);
        expect(Math.abs(y)).toBeLessThan(1e5);
      }
    }
  });
});

describe('parseGDS — hierarchy flattening', () => {
  // CHILD holds a 1×2 µm rect at origin; TOP places it via SREF at
  // (10, 0) rotated 90° CCW, an X-mirrored SREF at (0, -10), and a 2×3
  // AREF with 5 µm / 7 µm pitches.
  const childRect = [[0, 0], [1000, 0], [1000, 2000], [0, 2000], [0, 0]];
  const buf = cat(
    libHeader(),
    bgnstr('CHILD'),
    boundary(5, 0, childRect),
    rec(R.ENDSTR, 0x00),
    bgnstr('TOP'),
    // plain translate
    cat(rec(R.SREF, 0x00), asciiRec(R.SNAME, 'CHILD'),
      rec(R.XY, 0x03, int4(20000, 0)), rec(R.ENDEL, 0x00)),
    // rotate 90 CCW at (10000, 0) nm
    cat(rec(R.SREF, 0x00), asciiRec(R.SNAME, 'CHILD'),
      rec(R.ANGLE, 0x05, real8(90)),
      rec(R.XY, 0x03, int4(10000, 0)), rec(R.ENDEL, 0x00)),
    // X-axis mirror at (0, -10000) nm
    cat(rec(R.SREF, 0x00), asciiRec(R.SNAME, 'CHILD'),
      rec(R.STRANS, 0x01, int2(-32768)), // 0x8000
      rec(R.XY, 0x03, int4(0, -10000)), rec(R.ENDEL, 0x00)),
    // AREF 2 cols x 3 rows, col pitch 5 µm (x), row pitch 7 µm (y)
    cat(rec(R.AREF, 0x00), asciiRec(R.SNAME, 'CHILD'),
      rec(R.COLROW, 0x02, int2(2, 3)),
      rec(R.XY, 0x03, int4(100000, 0, 100000 + 2 * 5000, 0, 100000, 3 * 7000)),
      rec(R.ENDEL, 0x00)),
    rec(R.ENDSTR, 0x00),
    rec(R.ENDLIB, 0x00),
  );
  const parsed = parseGDS(buf);

  it('finds TOP as the only top cell', () => {
    expect(topCellsOf(parsed)).toEqual(['TOP']);
  });

  it('flattens SREF translate / rotate / mirror and AREF arrays to absolute µm', () => {
    const { shapes } = flattenGDSCell(parsed, 'TOP');
    // 3 SREFs + 2×3 AREF = 9 placements of the child rect
    expect(shapes.length).toBe(9);
    const bboxOf = (s) => {
      const xs = s.pts.map(p => p[0]), ys = s.pts.map(p => p[1]);
      return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    };
    const expectBbox = (got, want) => {
      for (let i = 0; i < 4; i++) expect(got[i]).toBeCloseTo(want[i], 9);
    };
    // translate: rect [20,0]..[21,2]
    expectBbox(bboxOf(shapes[0]), [20, 0, 21, 2]);
    // rotate 90 CCW about its origin at (10,0): (x,y) -> (-y, x) + t
    // rect [0..1]x[0..2] -> x in [10-2, 10], y in [0, 1]
    expectBbox(bboxOf(shapes[1]), [8, 0, 10, 1]);
    // mirror about X axis (y -> -y) at (0,-10): y in [-12, -10]
    expectBbox(bboxOf(shapes[2]), [0, -12, 1, -10]);
    // AREF elements: origins (100,0)+(i*5, j*7)
    const arefBoxes = shapes.slice(3).map(bboxOf).sort((a, b) => (a[1] - b[1]) || (a[0] - b[0]));
    expectBbox(arefBoxes[0], [100, 0, 101, 2]);
    expectBbox(arefBoxes[1], [105, 0, 106, 2]);
    expectBbox(arefBoxes[5], [105, 14, 106, 16]);
  });

  it('gdsLayerStats aggregates by (layer, datatype)', () => {
    const { shapes } = flattenGDSCell(parsed, 'TOP');
    const stats = gdsLayerStats(shapes);
    expect(stats.length).toBe(1);
    expect(stats[0]).toMatchObject({ layer: 5, datatype: 0, shapes: 9 });
  });
});

describe('parseGDS — PATH elements', () => {
  const buf = cat(
    libHeader(),
    bgnstr('T'),
    cat(rec(R.PATH, 0x00),
      rec(R.LAYER, 0x02, int2(3)),
      rec(R.DATATYPE, 0x02, int2(0)),
      rec(R.WIDTH, 0x03, int4(2000)), // 2 µm wide
      rec(R.XY, 0x03, int4(0, 0, 10000, 0, 10000, 5000)),
      rec(R.ENDEL, 0x00)),
    rec(R.ENDSTR, 0x00),
    rec(R.ENDLIB, 0x00),
  );
  it('flattens an open PATH to its OUTLINE polygon (miter joins, exact bbox)', () => {
    const parsed = parseGDS(buf);
    const { shapes } = flattenGDSCell(parsed, 'T');
    expect(shapes[0].kind).toBe('path');
    expect(shapes[0].widthUm).toBeCloseTo(2, 9);
    const { components } = gdsShapesToComponents(shapes, { '3/0': { include: true, target: 'undef' } }, { prefix: 'gds1' });
    expect(components.length).toBe(1);
    const c = components[0];
    expect(c.kind).toBe('polyshape'); // width flattened into geometry
    expect(c.closed).toBe(true);
    // L-path (0,0)->(10,0)->(10,5), w=2, butt: 6-point miter outline
    // [(0,1),(9,1),(9,5),(11,5),(11,-1),(0,-1)].
    expect(c.vertices.length).toBe(6);
    const abs = [];
    let x = c.cx, y = c.cy;
    abs.push([x, y]);
    for (let i = 1; i < c.vertices.length; i++) {
      x += Number(c.vertices[i].dx); y += Number(c.vertices[i].dy);
      abs.push([x, y]);
    }
    const xs = abs.map(p => p[0]), ys = abs.map(p => p[1]);
    expect(Math.min(...xs)).toBeCloseTo(0, 6);
    expect(Math.max(...xs)).toBeCloseTo(11, 6);
    expect(Math.min(...ys)).toBeCloseTo(-1, 6);
    expect(Math.max(...ys)).toBeCloseTo(5, 6);
    // inner miter corner present
    expect(abs.some(([px, py]) => Math.abs(px - 9) < 1e-6 && Math.abs(py - 1) < 1e-6)).toBe(true);
  });
});

describe('PATH flattening — end styles, loops, sanitization', async () => {
  const { pathToOutline } = await import('../src/gds/gds-import.js');

  it('pathtype 0/2 caps: flush vs extended by w/2', () => {
    const straight = [[0, 0], [10, 0]];
    const butt = pathToOutline(straight, 4, 0);
    const xsB = butt.map(p => p[0]);
    expect(Math.min(...xsB)).toBeCloseTo(0, 9);
    expect(Math.max(...xsB)).toBeCloseTo(10, 9);
    const sq = pathToOutline(straight, 4, 2);
    const xsS = sq.map(p => p[0]);
    expect(Math.min(...xsS)).toBeCloseTo(-2, 9); // extended w/2 per end
    expect(Math.max(...xsS)).toBeCloseTo(12, 9);
  });

  it('pathtype 1 ROUND caps: polygonal arcs reach the tip, stay in the disc', () => {
    const round = pathToOutline([[0, 0], [10, 0]], 4, 1);
    const xs = round.map(p => p[0]);
    expect(Math.min(...xs)).toBeCloseTo(-2, 6); // arc apex at w/2
    expect(Math.max(...xs)).toBeCloseTo(12, 6);
    expect(round.length).toBe(4 + 2 * 7); // 4 side pts + 7 arc pts per cap
    // every cap point lies on the radius-2 circle around its endpoint
    for (const [px, py] of round) {
      const dEnd = Math.min(Math.hypot(px - 0, py - 0), Math.hypot(px - 10, py - 0));
      expect(dEnd).toBeLessThanOrEqual(2 + 1e-9);
    }
  });

  it('CLOSED-LOOP paths (rings) import as closed polylines — no end-stretch notch', () => {
    // A square loop drawn as a PATH whose last point repeats the first —
    // the old end-stretch pushed first/last apart (visible notch).
    const shapes = [{
      kind: 'path', layer: 4, datatype: 0, cell: 'T', widthUm: 2, pathtype: 1,
      pts: [[0, 0], [20, 0], [20, 20], [0, 20], [0, 0]],
    }];
    const { components } = gdsShapesToComponents(shapes, { '4/0': { include: true, target: 'undef' } }, { prefix: 'g' });
    expect(components.length).toBe(1);
    const c = components[0];
    expect(c.kind).toBe('polyline');
    expect(c.closed).toBe(true);
    expect(c.width).toBe('2');
    expect(c.vertices.length).toBe(4); // closing point dropped, no stretch
  });

  it('collinear tessellation noise is pruned (v0 kept, spikes kept)', () => {
    const shapes = [{
      kind: 'boundary', layer: 1, datatype: 0, cell: 'T', widthUm: 0,
      pts: [
        [0, 0], [2, 0], [5, 0], [7, 0], [10, 0], // collinear run on the bottom edge
        [10, 5], [5, 5], [5, 8], [5, 5.000000], // spike up at x=5 (direction reverses)
        [0, 5],
      ],
    }];
    const { components } = gdsShapesToComponents(shapes, { '1/0': { include: true, target: 'undef' } }, { prefix: 'g' });
    const c = components[0];
    // Bottom-edge midpoints pruned: (2,0),(5,0),(7,0) gone; spike kept.
    const abs = [];
    let x = c.cx, y = c.cy;
    abs.push([x, y]);
    for (let i = 1; i < c.vertices.length; i++) {
      x += Number(c.vertices[i].dx); y += Number(c.vertices[i].dy);
      abs.push([x, y]);
    }
    expect(abs.some(([px]) => Math.abs(px - 2) < 1e-6)).toBe(false);
    expect(abs.some(([px, py]) => Math.abs(px - 5) < 1e-6 && Math.abs(py - 8) < 1e-6)).toBe(true); // spike apex
    expect(abs[0][0]).toBeCloseTo(0, 9); // v0 never pruned
    expect(abs[0][1]).toBeCloseTo(0, 9);
  });
});

describe('parser hardening (adversarial-review finds)', () => {
  it('PATH width scales with SREF magnification; NEGATIVE width is absolute', () => {
    const MAG = 0x1b;
    const buf = cat(
      libHeader(),
      bgnstr('CHILD'),
      cat(rec(R.PATH, 0x00), rec(R.LAYER, 0x02, int2(1)), rec(R.DATATYPE, 0x02, int2(0)),
        rec(R.WIDTH, 0x03, int4(2000)),
        rec(R.XY, 0x03, int4(0, 0, 10000, 0)), rec(R.ENDEL, 0x00)),
      cat(rec(R.PATH, 0x00), rec(R.LAYER, 0x02, int2(2)), rec(R.DATATYPE, 0x02, int2(0)),
        rec(R.WIDTH, 0x03, int4(-2000)), // GDS absolute width: |2 µm|, mag-exempt
        rec(R.XY, 0x03, int4(0, 0, 10000, 0)), rec(R.ENDEL, 0x00)),
      rec(R.ENDSTR, 0x00),
      bgnstr('TOP'),
      cat(rec(R.SREF, 0x00), asciiRec(R.SNAME, 'CHILD'),
        rec(MAG, 0x05, real8(3)),
        rec(R.XY, 0x03, int4(0, 0)), rec(R.ENDEL, 0x00)),
      rec(R.ENDSTR, 0x00), rec(R.ENDLIB, 0x00),
    );
    const { shapes } = flattenGDSCell(parseGDS(buf), 'TOP');
    const magged = shapes.find(s => s.layer === 1);
    const absolute = shapes.find(s => s.layer === 2);
    expect(magged.widthUm).toBeCloseTo(6, 9);      // 2 µm × mag 3
    expect(magged.pts[1][0]).toBeCloseTo(30, 9);   // centerline magnified too
    expect(absolute.widthUm).toBeCloseTo(2, 9);    // |−2|, NOT mag-scaled
    const { components } = gdsShapesToComponents(shapes, {
      '1/0': { include: true, target: 'undef' }, '2/0': { include: true, target: 'undef' },
    }, { prefix: 'g' });
    // Widths are flattened into outline polygons — check the band heights.
    const bandH = (c) => {
      let y = c.cy;
      const ys = [y];
      for (let i = 1; i < c.vertices.length; i++) { y += Number(c.vertices[i].dy); ys.push(y); }
      return Math.max(...ys) - Math.min(...ys);
    };
    expect(bandH(components.find(c => c.gdsSrc.layer === 1))).toBeCloseTo(6, 6);
    expect(bandH(components.find(c => c.gdsSrc.layer === 2))).toBeCloseTo(2, 6);
  });

  it('PATHTYPE 2 square-extended ends keep the physical length (w/2 per end)', () => {
    const PATHTYPE = 0x21;
    const buf = cat(
      libHeader(),
      bgnstr('T'),
      cat(rec(R.PATH, 0x00), rec(R.LAYER, 0x02, int2(1)), rec(R.DATATYPE, 0x02, int2(0)),
        rec(PATHTYPE, 0x02, int2(2)),
        rec(R.WIDTH, 0x03, int4(4000)), // 4 µm
        rec(R.XY, 0x03, int4(0, 0, 10000, 0)), rec(R.ENDEL, 0x00)),
      rec(R.ENDSTR, 0x00), rec(R.ENDLIB, 0x00),
    );
    const { shapes } = flattenGDSCell(parseGDS(buf), 'T');
    // Flatten keeps the RAW centerline (0..10); the extension lives in the
    // outline the converter builds.
    expect(shapes[0].pts[0][0]).toBeCloseTo(0, 9);
    expect(shapes[0].pts[1][0]).toBeCloseTo(10, 9);
    const { components } = gdsShapesToComponents(shapes, { '1/0': { include: true, target: 'undef' } }, { prefix: 'g' });
    let x = components[0].cx;
    const xs = [x];
    for (let i = 1; i < components[0].vertices.length; i++) { x += Number(components[0].vertices[i].dx); xs.push(x); }
    expect(Math.min(...xs)).toBeCloseTo(-2, 6); // extended by w/2
    expect(Math.max(...xs)).toBeCloseTo(12, 6);
  });

  it('a huge AREF of a shape-less cell hits the WALK budget instead of freezing', () => {
    const buf = cat(
      libHeader(),
      bgnstr('EMPTY'), rec(R.ENDSTR, 0x00),
      bgnstr('TOP'),
      cat(rec(R.AREF, 0x00), asciiRec(R.SNAME, 'EMPTY'),
        rec(R.COLROW, 0x02, int2(30000, 30000)), // 9e8 lattice elements
        rec(R.XY, 0x03, int4(0, 0, 30000000, 0, 0, 30000000)),
        rec(R.ENDEL, 0x00)),
      rec(R.ENDSTR, 0x00), rec(R.ENDLIB, 0x00),
    );
    const t0 = Date.now();
    const { shapes, warnings } = flattenGDSCell(parseGDS(buf), 'TOP', { maxWalks: 50000 });
    expect(Date.now() - t0).toBeLessThan(2000); // bounded, not ~40 s
    expect(shapes.length).toBe(0);
    expect(warnings.some(w => w.code === 'truncated-shapes')).toBe(true);
  });

  it('a missing referenced cell skips the whole AREF lattice with one warning', () => {
    const buf = cat(
      libHeader(),
      bgnstr('TOP'),
      cat(rec(R.AREF, 0x00), asciiRec(R.SNAME, 'NOWHERE'),
        rec(R.COLROW, 0x02, int2(30000, 30000)),
        rec(R.XY, 0x03, int4(0, 0, 30000000, 0, 0, 30000000)),
        rec(R.ENDEL, 0x00)),
      rec(R.ENDSTR, 0x00), rec(R.ENDLIB, 0x00),
    );
    const t0 = Date.now();
    const { warnings } = flattenGDSCell(parseGDS(buf), 'TOP');
    expect(Date.now() - t0).toBeLessThan(500); // one probe, not cols×rows walks
    expect(warnings.some(w => w.code === 'missing-cells')).toBe(true);
  });
});

describe('gdsShapesToComponents', () => {
  const shapes = [
    { kind: 'boundary', layer: 1, datatype: 0, cell: 'T', widthUm: 0, pts: [[0, 0], [4, 0], [4, 2], [0, 2]] },
    { kind: 'boundary', layer: 2, datatype: 0, cell: 'T', widthUm: 0, pts: [[10, 0], [16, 0], [16, 3], [10, 3]] },
    { kind: 'boundary', layer: 3, datatype: 1, cell: 'T', widthUm: 0, pts: [[0, 10], [1, 10], [1, 11], [0, 11]] },
  ];
  const mapping = {
    '1/0': { include: true, target: 'cond:l_cond' },
    '2/0': { include: true, target: 'undef' },
    '3/1': { include: false, target: 'wg' },
  };

  it('applies include / target mapping and builds path-kind components', () => {
    const { components } = gdsShapesToComponents(shapes, mapping, { prefix: 'gds1', file: 'a.gds' });
    expect(components.length).toBe(2); // 3/1 unchecked
    const [c1, c2] = components;
    expect(c1.kind).toBe('polyshape');
    expect(c1.layer).toBe('electrode');
    expect(c1.conductorLayerId).toBe('l_cond');
    expect(c2.layer).toBe('gdsundef');
    expect(c2.conductorLayerId).toBeUndefined();
    // Path-kind contract: cx/cy = vertex 0; rel numeric chain; w/h '0'.
    expect(c1.cx).toBe(0); expect(c1.cy).toBe(0);
    expect(c1.w).toBe('0'); expect(c1.h).toBe('0');
    expect(c1.vertices[0]).toEqual({ kind: 'rel', dx: '0', dy: '0' });
    expect(c1.vertices[1]).toEqual({ kind: 'rel', dx: '4', dy: '0' });
    expect(c1.closed).toBe(true);
    expect(c1.gdsSrc).toMatchObject({ file: 'a.gds', layer: 1, datatype: 0 });
    // isNonModelComponent: undefined YES, assigned NO.
    expect(isNonModelComponent(c2)).toBe(true);
    expect(isNonModelComponent(c1)).toBe(false);
  });

  it('recenters the included bbox on `at`', () => {
    const { components } = gdsShapesToComponents(shapes, mapping, { prefix: 'gds1', at: { x: 100, y: 50 } });
    // Included bbox: x [0,16], y [0,3] -> center (8, 1.5) -> shift (+92, +48.5)
    expect(components[0].cx).toBeCloseTo(0 + 92, 9);
    expect(components[0].cy).toBeCloseTo(0 + 48.5, 9);
    expect(components[1].cx).toBeCloseTo(10 + 92, 9);
  });

  it('survives normalizeScene and solves with a stable displayBbox frame', () => {
    const { components } = gdsShapesToComponents(shapes, mapping, { prefix: 'gds1' });
    const sc = normalizeScene({
      params: {}, components, snaps: [], mirrors: [], groups: [], booleans: [],
    });
    expect(sc.components.length).toBe(2);
    expect(sc.components[1].layer).toBe('gdsundef'); // passthrough
    expect(sc.components[1].gdsSrc.layer).toBe(2);   // provenance passthrough
    const pv = resolveParams(sc.params).values;
    const solved = solveLayout(sc.components, sc.snaps, pv);
    const s1 = solved.find(c => c.id === 'gds1_1');
    expect(s1.displayBbox).toBeTruthy();
    expect(s1.displayBbox.cx).toBeCloseTo(2, 6);   // 4x2 rect from (0,0)
    expect(s1.displayBbox.cy).toBeCloseTo(1, 6);
    // Frame anchors resolve on the shape (snap-parent side).
    const ne = anchorWorld(s1, 'NE', pv);
    expect(ne.x).toBeCloseTo(4, 6);
    expect(ne.y).toBeCloseTo(2, 6);
  });

  it('suggestGdsPrefix skips prefixes already in the scene', () => {
    expect(suggestGdsPrefix([])).toBe('gds1');
    expect(suggestGdsPrefix([{ id: 'gds3_12' }, { id: 'gds1_1' }])).toBe('gds4');
  });
});

describe('cross-import registration (overlap fix)', () => {
  // The shipped bug: importing layer subset A (recentered at the click
  // point) and later subset B of the SAME file (recentered again) stacked
  // the two groups on top of each other — each import centered its OWN
  // bbox. Fix: gdsSrc stores the ORIGINAL GDS root (v0x/v0y), and a
  // re-import applies forcedOffset = existing.cx − existing.gdsSrc.v0x.
  const shapes = [
    { kind: 'boundary', layer: 1, datatype: 0, cell: 'T', widthUm: 0, pts: [[0, 0], [10, 0], [10, 5], [0, 5]] },
    { kind: 'boundary', layer: 2, datatype: 0, cell: 'T', widthUm: 0, pts: [[100, 40], [110, 40], [110, 45], [100, 45]] },
  ];

  it('stores the original GDS root in gdsSrc (v0x/v0y) net of any recentering', () => {
    const { components } = gdsShapesToComponents(shapes, {
      '1/0': { include: true, target: 'undef' }, '2/0': { include: true, target: 'undef' },
    }, { prefix: 'g', at: { x: -500, y: 300 } });
    for (const c of components) {
      // cx − v0x must equal the ONE shared translation for every shape.
      expect(c.cx - c.gdsSrc.v0x).toBeCloseTo(components[0].cx - components[0].gdsSrc.v0x, 9);
      expect(c.cy - c.gdsSrc.v0y).toBeCloseTo(components[0].cy - components[0].gdsSrc.v0y, 9);
    }
    expect(components[0].gdsSrc.v0x).toBeCloseTo(0, 9);   // original coords
    expect(components[1].gdsSrc.v0x).toBeCloseTo(100, 9);
  });

  it('forcedOffset beats `at` and re-imports land in EXACT registration', () => {
    // First import: only layer 1, recentered at (0, 0).
    const A = gdsShapesToComponents(shapes, {
      '1/0': { include: true, target: 'undef' }, '2/0': { include: false, target: 'undef' },
    }, { prefix: 'a', at: { x: 0, y: 0 } }).components;
    // Second import: only layer 2, DIFFERENT click point — but aligned via
    // the registration offset recovered from the existing components.
    const reg = { dx: A[0].cx - A[0].gdsSrc.v0x, dy: A[0].cy - A[0].gdsSrc.v0y };
    const B = gdsShapesToComponents(shapes, {
      '1/0': { include: false, target: 'undef' }, '2/0': { include: true, target: 'undef' },
    }, { prefix: 'b', at: { x: 999, y: -999 }, forcedOffset: reg }).components;
    // Original delta between the two shapes' roots: (100, 40).
    expect(B[0].cx - A[0].cx).toBeCloseTo(100, 9);
    expect(B[0].cy - A[0].cy).toBeCloseTo(40, 9);
  });

  it('registration keeps tracking after the earlier import is DRAGGED', () => {
    const A = gdsShapesToComponents(shapes, {
      '1/0': { include: true, target: 'undef' }, '2/0': { include: false, target: 'undef' },
    }, { prefix: 'a', at: { x: 0, y: 0 } }).components;
    const dragged = { ...A[0], cx: A[0].cx + 77, cy: A[0].cy - 33 }; // user moved it
    const reg = { dx: dragged.cx - dragged.gdsSrc.v0x, dy: dragged.cy - dragged.gdsSrc.v0y };
    const B = gdsShapesToComponents(shapes, {
      '1/0': { include: false, target: 'undef' }, '2/0': { include: true, target: 'undef' },
    }, { prefix: 'b', forcedOffset: reg }).components;
    expect(B[0].cx - dragged.cx).toBeCloseTo(100, 9);
    expect(B[0].cy - dragged.cy).toBeCloseTo(40, 9);
  });
});

describe('GDS dims budget (gdsVisibleDimSegments)', async () => {
  const { gdsVisibleDimSegments, GDS_DIMS_MAX_VISIBLE } = await import('../src/ui/canvas/Canvas.jsx');
  const rect = { left: 0, top: 0, right: 800, bottom: 600 };
  const toPx = (wx, wy) => ({ x: wx, y: -wy }); // identity-ish for the test

  const mkSpecs = (n) => Array.from({ length: n }, () => ({ kind: 'rel', dx: '1', dy: '0' }));

  it('returns the visible-index set when at most N segments are in view', () => {
    // 5 segments inside the rect, 20 far outside.
    const verts = [];
    for (let i = 0; i <= 5; i++) verts.push([i * 50, -50]);          // inside
    for (let i = 0; i < 20; i++) verts.push([50000 + i * 50, -50]);  // way outside
    const specs = mkSpecs(verts.length);
    const vis = gdsVisibleDimSegments(specs, verts, toPx, rect);
    expect(vis).not.toBeNull();
    expect(vis.size).toBeLessThanOrEqual(GDS_DIMS_MAX_VISIBLE);
    expect(vis.has(1)).toBe(true);   // early in-view segments
    expect(vis.has(10)).toBe(false); // off-screen segment culled
  });

  it('returns null (render nothing) when MORE than N segments are visible', () => {
    const verts = [];
    for (let i = 0; i <= 30; i++) verts.push([i * 20, -50]); // 30 in-view segments
    const specs = mkSpecs(verts.length);
    expect(gdsVisibleDimSegments(specs, verts, toPx, rect)).toBeNull();
    expect(GDS_DIMS_MAX_VISIBLE).toBe(10);
  });

  it('non-rel vertices never count against the budget', () => {
    const verts = [];
    for (let i = 0; i <= 30; i++) verts.push([i * 20, -50]);
    const specs = mkSpecs(verts.length).map((s, i) => (i % 2 ? { kind: 'snap', compId: 'x', anchor: 'C' } : s));
    // Half the segments are snap-kind (no dx/dy dims) — the rel ones in
    // view are ~15, still over budget → null.
    expect(gdsVisibleDimSegments(specs, verts, toPx, rect)).toBeNull();
    // With a higher budget they fit.
    expect(gdsVisibleDimSegments(specs, verts, toPx, rect, 20)).not.toBeNull();
  });
});

describe('HFSS export integration', () => {
  // Imported L-shape assigned to the conductor + a rect snapped to its NE
  // frame anchor with a parametric gap; plus one UNASSIGNED shape.
  const shapes = [
    { kind: 'boundary', layer: 1, datatype: 0, cell: 'T', widthUm: 0, pts: [[0, 0], [20, 0], [20, 6], [12, 6], [12, 14], [0, 14]] },
    { kind: 'boundary', layer: 9, datatype: 0, cell: 'T', widthUm: 0, pts: [[40, 40], [44, 40], [44, 44], [40, 44]] },
  ];
  const { components } = gdsShapesToComponents(shapes, {
    '1/0': { include: true, target: 'cond:l_cond' },
    '9/0': { include: true, target: 'undef' },
  }, { prefix: 'gds1', file: 'chip.gds' });
  const base = normalizeScene(makeDefaultScene());
  const scene = normalizeScene({
    ...base,
    params: {
      ...base.params,
      gdsgap: { expr: '3.5', unit: 'µm', desc: 'gap off imported shape' },
    },
    components: [
      ...base.components,
      ...components,
      { id: 'probe', kind: 'rect', layer: 'electrode', conductorLayerId: 'l_cond', cx: 0, cy: 0, w: '5', h: '5', cutouts: [], transforms: [] },
    ],
    snaps: [
      ...base.snaps,
      { id: 's_gds', from: { compId: 'gds1_1', anchor: 'NE' }, to: { compId: 'probe', anchor: 'SW' }, dx: 'gdsgap', dy: '0' },
    ],
  });
  const pv = resolveParams(scene.params).values;

  it('snap graph is valid and the probe lands off the imported frame anchor', () => {
    expect(validateSnapGraph(scene.components, scene.snaps).length).toBe(0);
    const solved = solveLayout(scene.components, scene.snaps, pv);
    const probe = solved.find(c => c.id === 'probe');
    // gds1_1 frame: x [0,20], y [0,14] -> NE (20,14); probe SW lands +gap
    expect(probe.cx).toBeCloseTo(20 + 3.5 + 2.5, 4);
    expect(probe.cy).toBeCloseTo(14 + 2.5, 4);
  });

  it('emits the assigned shape, keeps the snap PARAMETRIC, and drops the <undefined> shape', () => {
    const script = generateHfssNative(scene, pv, {});
    expect(script).toContain('gds1_1');                    // assigned shape emitted
    expect(script).not.toContain('gds1_2');                // <undefined> shape absent
    expect(script).toContain('set_var("gdsgap"');          // snap offset is a live variable
    // The probe's position expression references the gap param (parametric
    // chain through the imported shape's frame), not a baked number only.
    const probeIdx = script.indexOf('def build_probe');
    const probeBlock = probeIdx >= 0 ? script.slice(probeIdx, probeIdx + 4000) : script;
    expect(probeBlock).toContain('gdsgap');
  });

  it('sweep parity: re-solving at a different gap matches the HFSS-side parametric form', () => {
    // The canvas is the reference: change the param, re-solve, and the probe
    // must track the imported shape's frame anchor exactly.
    const params2 = { ...scene.params, gdsgap: { ...scene.params.gdsgap, expr: '9' } };
    const pv2 = resolveParams(params2).values;
    const solved2 = solveLayout(scene.components, scene.snaps, pv2);
    const probe2 = solved2.find(c => c.id === 'probe');
    expect(probe2.cx).toBeCloseTo(20 + 9 + 2.5, 4);
  });

  it('3-D viewer skips <undefined> shapes (isNonModelComponent, not a section literal)', async () => {
    const { buildScene3D } = await import('../src/scene/scene3d.js');
    const { solids } = buildScene3D(scene, pv);
    expect(solids.some(s => s.compId === 'gds1_2' || s.selectId === 'gds1_2')).toBe(false);
    expect(solids.some(s => s.compId === 'gds1_1' || s.selectId === 'gds1_1')).toBe(true);
  });
});

describe('KLayout $$$CONTEXT_INFO$$$ metadata cells (phantom-starburst fix)', async () => {
  const { isGdsMetaCell } = await import('../src/gds/gds-import.js');

  it('meta cells are never top candidates and their refs do not count', () => {
    expect(isGdsMetaCell('$$$CONTEXT_INFO$$$')).toBe(true);
    expect(isGdsMetaCell('TOP')).toBe(false);
    // CTX references BOTH the real top and a library cell at origin —
    // the real top must still surface as THE top candidate.
    const buf = cat(
      libHeader(),
      bgnstr('LIB_BEND'), boundary(2, 0, [[0, 0], [1000, 0], [1000, 1000], [0, 0]]), rec(R.ENDSTR, 0x00),
      bgnstr('REALTOP'),
      boundary(2, 0, [[50000, 0], [60000, 0], [60000, 5000], [50000, 0]]),
      cat(rec(R.SREF, 0x00), asciiRec(R.SNAME, 'LIB_BEND'), rec(R.XY, 0x03, int4(70000, 0)), rec(R.ENDEL, 0x00)),
      rec(R.ENDSTR, 0x00),
      bgnstr('$$$CONTEXT_INFO$$$'),
      cat(rec(R.SREF, 0x00), asciiRec(R.SNAME, 'REALTOP'), rec(R.XY, 0x03, int4(0, 0)), rec(R.ENDEL, 0x00)),
      cat(rec(R.SREF, 0x00), asciiRec(R.SNAME, 'LIB_BEND'), rec(R.XY, 0x03, int4(0, 0)), rec(R.ENDEL, 0x00)),
      rec(R.ENDSTR, 0x00),
      rec(R.ENDLIB, 0x00),
    );
    const parsed = parseGDS(buf);
    const tops = topCellsOf(parsed);
    expect(tops[0]).toBe('REALTOP');            // ranked first, meta excluded
    expect(tops).not.toContain('$$$CONTEXT_INFO$$$');
    const { shapes } = flattenGDSCell(parsed, tops[0]);
    // REALTOP = its own shape + ONE placed LIB_BEND — NOT the phantom
    // origin copy the context refs would have added.
    expect(shapes.length).toBe(2);
    expect(shapes.every(s => s.pts.every(([x]) => x >= 45))).toBe(true); // nothing at the origin
  });
});

describe('immutable import mode (gdsShapesToGroups)', async () => {
  const { gdsShapesToGroups } = await import('../src/gds/gds-import.js');
  const shapes = [
    { kind: 'boundary', layer: 1, datatype: 0, cell: 'T', widthUm: 0, pts: [[0, 0], [10, 0], [10, 5], [0, 5]] },
    { kind: 'boundary', layer: 1, datatype: 0, cell: 'T', widthUm: 0, pts: [[20, 0], [30, 0], [30, 5], [20, 5]] },
    { kind: 'boundary', layer: 2, datatype: 0, cell: 'T', widthUm: 0, pts: [[0, 50], [4, 50], [4, 54], [0, 54]] },
  ];
  const mapping = {
    '1/0': { include: true, target: 'cond:l_cond' },
    '2/0': { include: true, target: 'undef' },
  };

  it('packs ONE component per GDS layer with local CCW rings and numeric dims', () => {
    const { components } = gdsShapesToGroups(shapes, mapping, { prefix: 'g', file: 'a.gds' });
    expect(components.length).toBe(2);
    const g1 = components.find(c => c.gdsSrc.layer === 1);
    expect(g1.kind).toBe('gdsgroup');
    expect(g1.layer).toBe('electrode');
    expect(g1.conductorLayerId).toBe('l_cond');
    expect(g1.rings.length).toBe(2);
    // bbox center of L1: x [0,30] y [0,5] -> (15, 2.5); dims numeric strings
    expect(g1.cx).toBeCloseTo(15, 9);
    expect(g1.cy).toBeCloseTo(2.5, 9);
    expect(g1.w).toBe('30');
    expect(g1.h).toBe('5');
    // rings LOCAL to center: first rect spans x [-15, -5]
    const xs = g1.rings[0].filter((_, i) => i % 2 === 0);
    expect(Math.min(...xs)).toBeCloseTo(-15, 9);
    expect(Math.max(...xs)).toBeCloseTo(-5, 9);
    // CCW normalization: shoelace of ring 0 is positive
    let area = 0;
    const r0 = g1.rings[0];
    for (let i = 0; i < r0.length; i += 2) {
      const x1 = r0[i], y1 = r0[i + 1];
      const x2 = r0[(i + 2) % r0.length], y2 = r0[(i + 3) % r0.length];
      area += x1 * y2 - x2 * y1;
    }
    expect(area).toBeGreaterThan(0);
    const g2 = components.find(c => c.gdsSrc.layer === 2);
    expect(g2.layer).toBe('gdsundef');
    expect(isNonModelComponent(g2)).toBe(true);
  });

  it('registration contract holds: cx − v0x = the shared import translation', () => {
    const { components } = gdsShapesToGroups(shapes, mapping, { prefix: 'g', at: { x: 100, y: -50 } });
    for (const c of components) {
      expect(c.cx - c.gdsSrc.v0x).toBeCloseTo(components[0].cx - components[0].gdsSrc.v0x, 9);
    }
    // forcedOffset wins (same math as editable mode)
    const B = gdsShapesToGroups(shapes, mapping, { prefix: 'h', forcedOffset: { dx: 7, dy: 9 } }).components;
    expect(B[0].cx - B[0].gdsSrc.v0x).toBeCloseTo(7, 9);
    expect(B[0].cy - B[0].gdsSrc.v0y).toBeCloseTo(9, 9);
  });

  it('solves with rect-frame semantics (anchors on the numeric bbox)', () => {
    const { components } = gdsShapesToGroups(shapes, mapping, { prefix: 'g' });
    const sc = normalizeScene({ params: {}, components, snaps: [], mirrors: [], groups: [], booleans: [] });
    expect(sc.components.find(c => c.kind === 'gdsgroup').rings).toBeTruthy(); // normalize passthrough
    const solved = solveLayout(sc.components, sc.snaps, {});
    const g1 = solved.find(c => c.id === 'g_L1_0');
    const ne = anchorWorld(g1, 'NE', {});
    expect(ne.x).toBeCloseTo(30, 6);
    expect(ne.y).toBeCloseTo(5, 6);
  });

  it('a rect snapped to a gdsgroup anchor stays parametric through HFSS', () => {
    const { components } = gdsShapesToGroups(shapes, mapping, { prefix: 'g' });
    const base = normalizeScene(makeDefaultScene());
    const sc = normalizeScene({
      ...base,
      params: { ...base.params, ggap: { expr: '2.5', unit: 'µm', desc: 'gap' } },
      components: [...base.components, ...components,
        { id: 'probe2', kind: 'rect', layer: 'electrode', conductorLayerId: 'l_cond', cx: 0, cy: 0, w: '5', h: '5', cutouts: [], transforms: [] }],
      snaps: [...base.snaps,
        { id: 's_g', from: { compId: 'g_L1_0', anchor: 'E' }, to: { compId: 'probe2', anchor: 'W' }, dx: 'ggap', dy: '0' }],
    });
    const pv = resolveParams(sc.params).values;
    const solved = solveLayout(sc.components, sc.snaps, pv);
    const probe = solved.find(c => c.id === 'probe2');
    expect(probe.cx).toBeCloseTo(30 + 2.5 + 2.5, 4);
    const script = generateHfssNative(sc, pv, {});
    expect(script).toContain('g_L1_0');           // group emitted
    expect(script).toContain('set_var("ggap"');   // snap param live
    expect(script).toContain('TranslateParameters'); // parametric Move idiom
    // Sweep parity on the canvas side
    const pv2 = resolveParams({ ...sc.params, ggap: { ...sc.params.ggap, expr: '8' } }).values;
    const probe2 = solveLayout(sc.components, sc.snaps, pv2).find(c => c.id === 'probe2');
    expect(probe2.cx).toBeCloseTo(30 + 8 + 2.5, 4);
  });

  it('closed-loop paths become SEPARATE closed polylines — the band keeps its hole', () => {
    // A ring electrode drawn as a closed-loop PATH: packing its band as
    // two fill rings imported it as a SOLID DISK in every consumer
    // (probe-confirmed adversarial-review find). In immutable mode it now
    // emits as a closed constant-width polyline alongside the group —
    // exactly editable mode's (correct) treatment.
    const withLoop = [
      ...shapes,
      { kind: 'path', layer: 1, datatype: 0, cell: 'T', widthUm: 2, pathtype: 1,
        pts: [[50, 0], [70, 0], [70, 20], [50, 20], [50, 0]] },
    ];
    const { components } = gdsShapesToGroups(withLoop, mapping, { prefix: 'g' });
    const loop = components.find(c => c.kind === 'polyline');
    expect(loop).toBeTruthy();
    expect(loop.closed).toBe(true);
    expect(loop.width).toBe('2');
    expect(loop.vertices.length).toBe(4);
    expect(loop.layer).toBe('electrode'); // mapping target applied
    // The layer group still packs the two rects only.
    const g1 = components.find(c => c.kind === 'gdsgroup' && c.gdsSrc.layer === 1);
    expect(g1.rings.length).toBe(2);
  });

  it('mirror instances reflect the packed rings in scene3d/GDS (canvas-HFSS parity)', async () => {
    const { buildScene3D } = await import('../src/scene/scene3d.js');
    // Asymmetric group + duplicate_mirror: the replica's rings must be
    // REFLECTED (HFSS emits a real DuplicateMirror for the united part —
    // the numeric consumers must agree).
    const { components } = gdsShapesToGroups(
      [{ kind: 'boundary', layer: 1, datatype: 0, cell: 'T', widthUm: 0, pts: [[0, 0], [10, 0], [10, 2], [0, 2]] }],
      { '1/0': { include: true, target: 'cond:l_cond' } }, { prefix: 'gm' });
    const gm = {
      ...components[0],
      transforms: [{ id: 't1', kind: 'duplicate_mirror', enabled: true, axis: 'x', dx: '20', dy: '0' }],
    };
    const base = normalizeScene(makeDefaultScene());
    const sc = normalizeScene({ ...base, components: [...base.components, gm] });
    const pv = resolveParams(sc.params).values;
    const { solids } = buildScene3D(sc, pv);
    const gs = solids.filter(s => s.compId === 'gm_L1_0');
    expect(gs.length).toBe(2); // base + mirrored replica
    // Base ring x-span [0,10]; whatever the mirror line, the REPLICA must
    // be a reflection: its ring's x-extent equals the base's extent and
    // its orientation flips (signed area negates without scale fix; with
    // the fix both are valid polygons but the x-order of the first two
    // points reverses). Robust check: replica ring != base ring translated.
    const spanOf = (ring) => {
      const xs = ring.map(p => p[0]);
      return [Math.min(...xs), Math.max(...xs)];
    };
    const [b0, b1] = spanOf(gs[0].ring);
    const [r0, r1] = spanOf(gs[1].ring);
    expect(+(b1 - b0).toFixed(6)).toBeCloseTo(+(r1 - r0).toFixed(6), 6);
    // The base shape's LEFT edge is at local -5 (asymmetric would be
    // needed for a stronger check) — assert the replica x-span mirrors
    // about the duplicate_mirror line rather than being a pure translate:
    // for axis mirrors expandTransforms sets scaleX=-1, so the local +x
    // side lands on the replica's -x side. Compare point 0's x offset.
    const baseP0 = gs[0].ring[0][0] - (b0 + b1) / 2;
    const replP0 = gs[1].ring[0][0] - (r0 + r1) / 2;
    expect(replP0).toBeCloseTo(-baseP0, 6);
  });

  it('3-D viewer emits one solid per packed ring', async () => {
    const { buildScene3D } = await import('../src/scene/scene3d.js');
    const { components } = gdsShapesToGroups(shapes, mapping, { prefix: 'g' });
    const base = normalizeScene(makeDefaultScene());
    const sc = normalizeScene({ ...base, components: [...base.components, ...components] });
    const pv = resolveParams(sc.params).values;
    const { solids } = buildScene3D(sc, pv);
    const gSolids = solids.filter(s => s.compId === 'g_L1_0');
    expect(gSolids.length).toBe(2); // one per ring
    expect(gSolids[0].kind).toBe('extrude');
    // undef group skipped
    expect(solids.some(s => s.compId === 'g_L2_0')).toBe(false);
  });

  it('cross-section slices the REAL rings, not the bbox', async () => {
    const { buildCrossSection } = await import('../src/scene/cross-section.js');
    const { components } = gdsShapesToGroups(shapes, mapping, { prefix: 'g' });
    const base = normalizeScene(makeDefaultScene());
    const sc = normalizeScene({
      ...base,
      components: [
        ...base.components.filter(c => c.layer !== 'electrode' && c.layer !== 'port' && c.layer !== 'waveguide'),
        ...components,
        { id: 'secA', kind: 'polyline', layer: 'section', cx: -5, cy: 2.5, w: '0', h: '0', width: '0',
          vertices: [{ kind: 'rel', dx: '0', dy: '0' }, { kind: 'rel', dx: '45', dy: '0' }], cutouts: [], transforms: [] },
      ],
    });
    const pv = resolveParams(sc.params).values;
    const cross = buildCrossSection(sc, pv, 'secA');
    expect(cross.ok).toBe(true);
    const cond = cross.conductors.find(c => c.id.startsWith('g_L1_0'));
    expect(cond).toBeTruthy();
    // The group has TWO rects with a 10 µm gap — the slice must show TWO
    // intervals (a bbox fallback would show one 30 µm slab).
    expect(cond.intervals.length).toBe(2);
    const spans = cond.intervals.map(iv => +(iv.t1 - iv.t0).toFixed(3)).sort();
    expect(spans).toEqual([10, 10]);
  });
});
