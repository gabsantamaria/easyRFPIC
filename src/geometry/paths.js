// SVG path-string helpers.
//
// The canvas uses SVG with a y-up world / y-down screen transform; the
// ringToSvgPath helper flips y as part of converting a world-space ring
// (array of [x, y]) into an SVG path "M x y L x y ... Z" string.
//
// Extracted from PhotonicLayout.jsx alongside Stage 4.10 — formerly an
// inline helper used only by the Canvas component.
export function ringToSvgPath(ring) {
  if (!ring || ring.length === 0) return '';
  let d = `M ${ring[0][0]} ${-ring[0][1]}`;
  for (let i = 1; i < ring.length; i++) d += ` L ${ring[i][0]} ${-ring[i][1]}`;
  return d + ' Z';
}
