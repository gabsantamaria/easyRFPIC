// Exact rectilinear polygon union (compressed-grid scanline).
//
// WHY THIS EXISTS: HFSS/Parasolid cannot boolean EXACTLY-ABUTTING solids —
// a Subtract OR Unite whose faces partially coincide fails with
// PK_ERROR_missing_geom / PK_boolean_result_failed_c AND nulls a body
// (both observed on a real design: a fractured GDS layer's rects abutting
// on shared edges killed the cladding subtract, and the clone+unite
// workaround died inside the Unite). The only robust fix is to merge the
// abutting footprints BEFORE emission and cut ONE clean prism per merged
// region. Fractured GDS geometry is rectilinear, which admits an EXACT
// union: compress all coordinates onto the grid the inputs define, mark
// covered cells by even-odd point-in-polygon at cell centers (exact for
// rectilinear inputs — every edge lies on a grid line), and trace the
// covered-region boundary.
//
// Deliberately conservative: any input this cannot handle EXACTLY
// (non-rectilinear edges, unions that produce holes, area-sanity
// mismatch) returns { ok: false, reason } and the caller keeps the
// legacy behavior. A bug here can only fail to merge, never corrupt
// geometry — the same self-guard contract as simplifyExpr.

const EPS = 1e-6; // µm — coordinate coincidence tolerance

// Is every edge of the ring axis-parallel?
export function isRectilinearRing(ring) {
  const n = ring.length;
  if (n < 4) return false;
  for (let i = 0; i < n; i++) {
    const [x0, y0] = ring[i];
    const [x1, y1] = ring[(i + 1) % n];
    const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
    if (dx < EPS && dy < EPS) continue; // duplicate point — harmless
    if (dx > EPS && dy > EPS) return false;
  }
  return true;
}

function ringBbox(ring) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of ring) {
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}

// Do two rings' bboxes overlap or touch (within tol)?
export function ringsTouch(a, b, tol = EPS) {
  const A = ringBbox(a), B = ringBbox(b);
  return A[0] <= B[2] + tol && A[2] >= B[0] - tol &&
         A[1] <= B[3] + tol && A[3] >= B[1] - tol;
}

function ringArea(ring) {
  let s = 0;
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const [x0, y0] = ring[i];
    const [x1, y1] = ring[(i + 1) % n];
    s += x0 * y1 - x1 * y0;
  }
  return s / 2;
}

// Even-odd point-in-polygon.
function pointInRing(px, py, ring) {
  let inside = false;
  const n = ring.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > py) !== (yj > py) &&
        px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function compress(vals) {
  const sorted = [...vals].sort((a, b) => a - b);
  const out = [];
  for (const v of sorted) {
    if (out.length === 0 || v - out[out.length - 1] > EPS) out.push(v);
  }
  return out;
}

// Union of rectilinear rings. Returns { ok: true, rings } with each output
// ring CCW, collinear vertices merged — or { ok: false, reason }.
export function rectilinearUnion(rings) {
  if (!Array.isArray(rings) || rings.length === 0) {
    return { ok: false, reason: 'no input rings' };
  }
  for (const r of rings) {
    if (!Array.isArray(r) || r.length < 4) return { ok: false, reason: 'ring with < 4 vertices' };
    if (!r.every((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]))) {
      return { ok: false, reason: 'non-finite vertex' };
    }
    if (!isRectilinearRing(r)) return { ok: false, reason: 'non-rectilinear ring' };
    if (Math.abs(ringArea(r)) < EPS * EPS) return { ok: false, reason: 'zero-area ring' };
  }
  const xs = compress(rings.flatMap((r) => r.map((p) => p[0])));
  const ys = compress(rings.flatMap((r) => r.map((p) => p[1])));
  const nx = xs.length - 1, ny = ys.length - 1;
  if (nx < 1 || ny < 1) return { ok: false, reason: 'degenerate grid' };
  if (nx * ny > 4_000_000) return { ok: false, reason: 'grid too large' };

  // Covered cells: even-odd test at cell centers. Exact for rectilinear
  // inputs — every input edge lies on a grid line, so a cell is either
  // fully inside or fully outside each ring. Per-ring bbox prefilter
  // keeps a large fractured cluster from going O(cells × rings × len)
  // (adversarial-review perf find).
  const rbbs = rings.map(ringBbox);
  const covered = new Uint8Array(nx * ny);
  let coveredArea = 0;
  for (let i = 0; i < nx; i++) {
    const cxm = (xs[i] + xs[i + 1]) / 2;
    for (let j = 0; j < ny; j++) {
      const cym = (ys[j] + ys[j + 1]) / 2;
      for (let k = 0; k < rings.length; k++) {
        const bb = rbbs[k];
        if (cxm < bb[0] || cxm > bb[2] || cym < bb[1] || cym > bb[3]) continue;
        if (pointInRing(cxm, cym, rings[k])) {
          covered[i * ny + j] = 1;
          coveredArea += (xs[i + 1] - xs[i]) * (ys[j + 1] - ys[j]);
          break;
        }
      }
    }
  }
  if (coveredArea < EPS * EPS) return { ok: false, reason: 'empty union' };

  const at = (i, j) => (i >= 0 && i < nx && j >= 0 && j < ny) ? covered[i * ny + j] : 0;

  // Boundary edges, directed so the covered region is on the LEFT
  // (outers come out CCW, holes CW). Key each edge by its start grid
  // node; trace loops by following edges (at a node prefer turning
  // left-most — for rectilinear boundaries each node has at most two
  // outgoing edges and the diagonal-corner case picks consistently).
  // Node id: xi * (ny+1) + yj over grid NODES.
  const nodeId = (xi, yj) => xi * (ny + 1) + yj;
  const edges = new Map(); // startNode -> array of endNode
  const addEdge = (x0, y0, x1, y1) => {
    const k = nodeId(x0, y0);
    if (!edges.has(k)) edges.set(k, []);
    edges.get(k).push(nodeId(x1, y1));
  };
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      if (!at(i, j)) continue;
      // bottom edge (covered above): left -> right
      if (!at(i, j - 1)) addEdge(i, j, i + 1, j);
      // top edge: right -> left
      if (!at(i, j + 1)) addEdge(i + 1, j + 1, i, j + 1);
      // left edge: top -> bottom
      if (!at(i - 1, j)) addEdge(i, j + 1, i, j);
      // right edge: bottom -> top
      if (!at(i + 1, j)) addEdge(i + 1, j, i + 1, j + 1);
    }
  }

  const loops = [];
  const takeEdge = (fromK, preferDir) => {
    const outs = edges.get(fromK);
    if (!outs || outs.length === 0) return null;
    if (outs.length === 1 || preferDir == null) return outs.shift();
    // Two outgoing edges (diagonal corner): pick the LEFT turn relative
    // to the incoming direction so the trace hugs its own region.
    const fy = fromK % (ny + 1), fx = (fromK - fy) / (ny + 1);
    const leftDir = [-preferDir[1], preferDir[0]];
    for (let ii = 0; ii < outs.length; ii++) {
      const ty = outs[ii] % (ny + 1), tx = (outs[ii] - ty) / (ny + 1);
      const d = [Math.sign(tx - fx), Math.sign(ty - fy)];
      if (d[0] === leftDir[0] && d[1] === leftDir[1]) return outs.splice(ii, 1)[0];
    }
    return outs.shift();
  };
  for (const startK of [...edges.keys()]) {
    while (edges.get(startK) && edges.get(startK).length > 0) {
      const loop = [startK];
      let prevK = startK;
      let dir = null;
      let curK = takeEdge(startK, null);
      let guard = 4 * nx * ny + 8;
      while (curK != null && curK !== startK && guard-- > 0) {
        const py2 = prevK % (ny + 1), px2 = (prevK - py2) / (ny + 1);
        const cy2 = curK % (ny + 1), cx2 = (curK - cy2) / (ny + 1);
        dir = [Math.sign(cx2 - px2), Math.sign(cy2 - py2)];
        loop.push(curK);
        prevK = curK;
        curK = takeEdge(curK, dir);
      }
      if (curK !== startK) return { ok: false, reason: 'open boundary trace' };
      // PINCH GUARD (adversarial-review find, probe-confirmed): a cavity
      // connected to the outside through a single grid CORNER makes the
      // trace pass through that node twice and close as ONE self-touching
      // loop — positive area, even-odd-consistent, so BOTH the hole check
      // and the area self-check pass, yet the emitted covered polyline is
      // non-simple and AEDT rejects it (silently dropping the whole
      // cluster's cavity). Any revisited node ⇒ bail to the direct path.
      if (new Set(loop).size !== loop.length) {
        return { ok: false, reason: 'union produces a pinch (self-touching boundary)' };
      }
      // Grid-node loop -> world ring, merging collinear runs.
      const raw = loop.map((k) => {
        const yj = k % (ny + 1), xi = (k - yj) / (ny + 1);
        return [xs[xi], ys[yj]];
      });
      const ring = [];
      for (let ii = 0; ii < raw.length; ii++) {
        const a = raw[(ii - 1 + raw.length) % raw.length];
        const b = raw[ii];
        const c2 = raw[(ii + 1) % raw.length];
        const collinear = (Math.abs(a[0] - b[0]) < EPS && Math.abs(b[0] - c2[0]) < EPS) ||
                          (Math.abs(a[1] - b[1]) < EPS && Math.abs(b[1] - c2[1]) < EPS);
        if (!collinear) ring.push(b);
      }
      if (ring.length >= 4) loops.push(ring);
    }
  }

  // Holes come out CW (region-on-left tracing). Any hole -> bail: the
  // caller would need hole-carving inside the synthetic tool, which is
  // exactly the boolean class we are trying to avoid.
  const outers = [];
  let outArea = 0;
  for (const l of loops) {
    const a = ringArea(l);
    if (a < 0) return { ok: false, reason: 'union produces a hole' };
    outers.push(l);
    outArea += a;
  }
  if (outers.length === 0) return { ok: false, reason: 'no boundary loops' };
  // Area sanity: traced boundary must enclose exactly the covered cells.
  if (Math.abs(outArea - coveredArea) > Math.max(1e-6, coveredArea * 1e-9)) {
    return { ok: false, reason: 'area self-check failed' };
  }
  return { ok: true, rings: outers, area: outArea };
}

// Do two rings share a collinear boundary segment (edge-on-edge overlap
// of positive length)? THIS — not mere bbox contact or transversal
// overlap — is the Parasolid coincident-face hazard: two solids whose
// footprints only cross transversally boolean fine and must NOT be
// merged (merging would needlessly freeze their parametric cavities —
// adversarial-review find). Works for arbitrary segment orientations.
export function ringsShareEdge(a, b, tol = EPS) {
  if (!ringsTouch(a, b, tol)) return false;
  const segs = (r) => r.map((p, i) => [p, r[(i + 1) % r.length]]);
  for (const [p1, p2] of segs(a)) {
    const dx = p2[0] - p1[0], dy = p2[1] - p1[1];
    const len = Math.hypot(dx, dy);
    if (len < tol) continue;
    const ux = dx / len, uy = dy / len;
    for (const [q1, q2] of segs(b)) {
      const ex = q2[0] - q1[0], ey = q2[1] - q1[1];
      const elen = Math.hypot(ex, ey);
      if (elen < tol) continue;
      // Parallel?
      if (Math.abs(ux * ey - uy * ex) > tol * elen) continue;
      // Collinear? (q1 must lie on a's line)
      if (Math.abs((q1[0] - p1[0]) * uy - (q1[1] - p1[1]) * ux) > tol) continue;
      // Overlap of the projections along the shared line, positive length.
      const t1 = 0, t2 = len;
      const s1 = (q1[0] - p1[0]) * ux + (q1[1] - p1[1]) * uy;
      const s2 = (q2[0] - p1[0]) * ux + (q2[1] - p1[1]) * uy;
      const lo = Math.max(Math.min(t1, t2), Math.min(s1, s2));
      const hi = Math.min(Math.max(t1, t2), Math.max(s1, s2));
      if (hi - lo > tol) return true;
    }
  }
  return false;
}

// Cluster rings into connected groups by SHARED collinear boundary
// segments (transitive) — the actual coincident-face hazard predicate.
export function clusterRingsByEdgeShare(rings, tol = EPS) {
  const n = rings.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (ringsShareEdge(rings[i], rings[j], tol)) {
        const a = find(i), b = find(j);
        if (a !== b) parent[a] = b;
      }
    }
  }
  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(i);
  }
  return [...groups.values()];
}

// Cluster rings into connected groups by bbox touch/overlap (transitive).
export function clusterRingsByTouch(rings, tol = EPS) {
  const n = rings.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (ringsTouch(rings[i], rings[j], tol)) {
        const a = find(i), b = find(j);
        if (a !== b) parent[a] = b;
      }
    }
  }
  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(i);
  }
  return [...groups.values()];
}
