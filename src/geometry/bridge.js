// Airbridge arch profile sampler — shared between generatePyAEDT's bridge
// branch and the 3-D viewer spec builder (scene3d.js) so both build the
// SAME parabolic arch (the numeric stand-in for the native COM export's
// 3-point NURBS spline).
//
// The arch is a parabola through take-off / apex / landing:
//   z(u) = H * (1 - u^2),  u in [-1, +1],  x_along(u) = u * L / 2
// sampled at `segs`+1 equally-spaced u values (default 8 segments = the
// 9-point profile the pyAEDT export has always emitted).
//
// Returns [[x_along, zRel], ...] — x_along in µm centered on the bridge
// midpoint (-L/2 .. +L/2), zRel the height ABOVE the arch base (0 at the
// landings, H at the apex). Callers add their own zBase.
export function sampleBridgeArch(length, height, segs = 8) {
  const pts = [];
  for (let k = 0; k <= segs; k++) {
    const u = -1 + (2 * k) / segs;
    pts.push([(u * length) / 2, height * (1 - u * u)]);
  }
  return pts;
}
