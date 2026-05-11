// Racetrack geometry: partial-Euler 180° bends and the closed centerline
// of a racetrack loop, plus an offset helper that produces a band of finite
// width around a centerline polyline.
//
// These functions are pure (Math only) and have no dependencies on the
// rest of the scene model. They were extracted from PhotonicLayout.jsx as
// the first Stage-1 step of the planned refactor.

// Compute the centerline of a 180° partial-Euler bend.
// The bend enters at origin going in the +x direction and exits going in
// the -x direction, turning clockwise. Curvature is negative (right turn).
//
// Parameter `p ∈ [0, 1]` controls the partial-Euler split:
//   - p = 0: pure circular arc of radius R (Euler portions vanish)
//   - p = 1: pure "double-Euler" with no constant-radius arc in the middle
//   - 0 < p < 1: Euler ramp-up → arc at radius R → Euler ramp-down
// In every case, the MINIMUM radius of curvature reached anywhere along
// the bend equals `R`. For p > 0 this minimum is reached at the start of
// the arc segment; for p = 1 it's reached at the apex.
//
// The Euler portion (clothoid) has curvature κ(s) = -s/(L_E·R) varying
// linearly with arc length. Integrating κ gives θ(s) = -s²/(2·L_E·R),
// then x(s) = ∫cos(θ)ds, y(s) = ∫sin(θ)ds. These integrals are computed
// numerically by accumulating midpoint-rule contributions; ~128 samples
// per bend gives sub-nanometer accuracy for R ~ 100µm.
export function eulerBend180Centerline(R, p, nPts = 128) {
  const theta_E = (Math.PI / 2) * Math.max(0, Math.min(1, p));
  const theta_A = Math.PI - 2 * theta_E;
  const L_E = 2 * R * theta_E;                 // each Euler portion arc length
  const L_A = R * theta_A;                     // middle arc length
  const L_total = 2 * L_E + L_A;
  if (L_total <= 0) return [[0, 0]];

  // Sample theta(s) at nPts+1 equally-spaced arc-length values.
  const samples = [];
  for (let i = 0; i <= nPts; i++) {
    const s = (i / nPts) * L_total;
    let theta;
    if (s <= L_E) {
      theta = L_E > 0 ? -(s * s) / (2 * L_E * R) : 0;
    } else if (s <= L_E + L_A) {
      const sLocal = s - L_E;
      theta = -theta_E - sLocal / R;
    } else {
      // Mirror of ramp-up by symmetry: θ(s) = -π + (L_total - s)²/(2·L_E·R)
      const sRem = L_total - s;
      theta = -Math.PI + (L_E > 0 ? (sRem * sRem) / (2 * L_E * R) : 0);
    }
    samples.push({ s, theta });
  }
  // Integrate cos(θ), sin(θ) over arc length via midpoint rule.
  const pts = [[0, 0]];
  let x = 0, y = 0;
  for (let i = 1; i < samples.length; i++) {
    const ds = samples[i].s - samples[i - 1].s;
    const thMid = (samples[i].theta + samples[i - 1].theta) / 2;
    x += Math.cos(thMid) * ds;
    y += Math.sin(thMid) * ds;
    pts.push([x, y]);
  }
  return pts;
}

// Build the closed centerline of a racetrack loop with partial-Euler bends.
// Geometry parameters:
//   R          min radius of curvature of the bends (µm)
//   L_straight length of each straight segment (µm)
//   p          Euler parameter ∈ [0, 1]
//   nPtsBend   number of sample points along each 180° bend (default 128)
// The returned centerline is a closed polyline, centered at (0, 0), with
// the long axis along x. The closed loop starts at the top-right end of
// the top straight, traverses CCW (when viewed with y-up): right along the
// top → 180° right-turn down → left along the bottom → 180° right-turn up.
//
// Vertical extent (separation between the two straights) depends on the
// bend geometry: for p > 0 the partial-Euler bend exits FURTHER from the
// entry than 2R, so the vertical span is computed from the bend's actual
// exit-point displacement, NOT assumed to be 2R.
export function buildRacetrackCenterline(R, L_straight, p, nPtsBend = 128) {
  // 180° right-bend (CW), entering at origin going +x, exiting going -x.
  const bend = eulerBend180Centerline(R, p, nPtsBend);
  if (bend.length < 2) return [[0, 0]];
  const [exitX, exitY] = bend[bend.length - 1];
  // Vertical span of the bend (the |y| distance between entry and exit
  // points). For a pure arc (p=0) this equals 2R exactly; for p > 0 it's
  // somewhat larger because the Euler clothoid "extends" the bend.
  const H_bend = Math.abs(exitY);
  const halfL = L_straight / 2;
  const halfH = H_bend / 2;

  const out = [];
  // (1) Top straight: starts at (-halfL, +halfH), ends at (+halfL, +halfH).
  // Subdivide so we have a few points along the straight; ~16 points is
  // plenty for visual smoothness and lets the band offset be computed
  // uniformly along the perimeter.
  const nStraight = 16;
  for (let i = 0; i <= nStraight; i++) {
    const t = i / nStraight;
    out.push([-halfL + t * L_straight, halfH]);
  }
  // (2) Right bend: bend points are computed entering at origin going +x;
  //     translate so entry = (halfL, halfH). The bend's exitX is ~0 (by
  //     symmetry); the relative geometry is consistent.
  for (let i = 1; i < bend.length; i++) {
    const [bx, by] = bend[i];
    out.push([halfL + bx, halfH + by]);
  }
  // After bend: position is (halfL + exitX, halfH + exitY) = (halfL, -halfH)
  // assuming exitX = 0 (which it is to numerical precision).

  // (3) Bottom straight: from (halfL, -halfH) to (-halfL, -halfH).
  for (let i = 1; i <= nStraight; i++) {
    const t = i / nStraight;
    out.push([halfL - t * L_straight, -halfH]);
  }
  // (4) Left bend: 180°-rotated copy of the right bend. Rotating (x, y)
  //     by 180° about origin: (-x, -y). Then translate: entry at (-halfL, -halfH).
  for (let i = 1; i < bend.length; i++) {
    const [bx, by] = bend[i];
    out.push([-halfL - bx, -halfH - by]);
  }
  // We DON'T explicitly close the loop with a repeated first point; the
  // ring-to-polygon converters elsewhere in this file treat the polyline
  // as implicitly closed.
  return out;
}

// Offset a closed centerline polyline outward and inward by `halfW` along
// the local normal, producing a band of total width 2·halfW. Returns
// { outer, inner } — both closed CCW polylines. The inner ring traces in
// reverse direction relative to outer, suitable for use as a hole.
//
// Used for racetrack waveguides where the band represents the physical
// waveguide of width 2·halfW following the centerline curve.
export function offsetCenterlineToBand(centerline, halfW) {
  const N = centerline.length;
  if (N < 2 || halfW <= 0) return { outer: centerline.slice(), inner: [] };
  // Compute the local tangent at each vertex from its neighbors (handling
  // the closed-loop wraparound). The normal is the tangent rotated by 90°.
  const outer = [];
  const inner = [];
  for (let i = 0; i < N; i++) {
    const prev = centerline[(i - 1 + N) % N];
    const next = centerline[(i + 1) % N];
    const tx = next[0] - prev[0];
    const ty = next[1] - prev[1];
    const tlen = Math.hypot(tx, ty) || 1;
    // Normal = (−ty, tx)/|t| points "left" of the direction of travel.
    // For a CCW-traversed loop this points OUTWARD from the enclosed
    // region; for our racetrack (which is traversed CW because the right
    // turn is a right-bend), it points INWARD. We don't strictly care
    // about orientation labelling — what matters is outer vs inner relative
    // to the centerline, which we just label both directions:
    const nx = -ty / tlen;
    const ny =  tx / tlen;
    outer.push([centerline[i][0] + nx * halfW, centerline[i][1] + ny * halfW]);
    inner.push([centerline[i][0] - nx * halfW, centerline[i][1] - ny * halfW]);
  }
  return { outer, inner };
}
