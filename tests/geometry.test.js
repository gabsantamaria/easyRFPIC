import { describe, it, expect } from 'vitest';
import {
  eulerBend180Centerline,
  buildRacetrackCenterline,
  offsetCenterlineToBand,
} from '../src/geometry/racetrack.js';
import { rectInstanceToRing, shapeInstanceToRing } from '../src/geometry/rings.js';
import { ringToSvgPath } from '../src/geometry/paths.js';

describe('eulerBend180Centerline', () => {
  it('returns nPts+1 points', () => {
    expect(eulerBend180Centerline(100, 1, 128)).toHaveLength(129);
  });
  it('starts at the origin', () => {
    const pts = eulerBend180Centerline(100, 1, 64);
    expect(pts[0]).toEqual([0, 0]);
  });
  it('p=0 is a pure half-circle: exit at (0, -2R)', () => {
    const pts = eulerBend180Centerline(100, 0, 256);
    const exit = pts[pts.length - 1];
    expect(exit[0]).toBeCloseTo(0, 1);
    expect(exit[1]).toBeCloseTo(-200, 0);
  });
  it('p=1 (full Euler) extends further: exit y ≈ -2.754R', () => {
    const pts = eulerBend180Centerline(100, 1, 256);
    const exit = pts[pts.length - 1];
    expect(exit[0]).toBeCloseTo(0, 1);
    expect(exit[1]).toBeCloseTo(-275.378, 0);
  });
  it('handles the degenerate L_total=0 case', () => {
    const pts = eulerBend180Centerline(0, 0, 8);
    expect(pts).toEqual([[0, 0]]);
  });
});

describe('buildRacetrackCenterline', () => {
  it('produces a closed loop that returns near the starting point', () => {
    const pts = buildRacetrackCenterline(100, 300, 1, 64);
    const first = pts[0];
    const last  = pts[pts.length - 1];
    // We don't repeat the closing vertex; ring callers treat it as
    // implicitly closed. Last should be near (firstX - L, firstY) — i.e.
    // the end of the left bend back up at the top straight's start side.
    expect(pts.length).toBeGreaterThan(20);
    expect(Math.abs(last[0] - first[0])).toBeLessThan(50);
  });
  it('total y-span equals the bend H for L=0, p=1', () => {
    const pts = buildRacetrackCenterline(100, 0, 1, 128);
    let minY = Infinity, maxY = -Infinity;
    for (const [, y] of pts) { if (y < minY) minY = y; if (y > maxY) maxY = y; }
    // For p=1: H_bend ≈ 2.754 * R, ±H/2 around y=0.
    expect(maxY - minY).toBeCloseTo(275.378, 0);
  });
});

describe('offsetCenterlineToBand', () => {
  const square = [
    [-10, -10], [10, -10], [10, 10], [-10, 10],
  ];
  it('returns equal-length inner and outer rings', () => {
    const { outer, inner } = offsetCenterlineToBand(square, 1);
    expect(outer).toHaveLength(square.length);
    expect(inner).toHaveLength(square.length);
  });
  it('halfW=0 leaves the centerline unchanged', () => {
    const { outer, inner } = offsetCenterlineToBand(square, 0);
    expect(outer).toEqual(square);
    expect(inner).toEqual([]);
  });
  it('outer and inner are mirror images of the centerline', () => {
    const { outer, inner } = offsetCenterlineToBand(square, 2);
    // Vertex 0 of the square has neighbors at v1 (next) and v3 (prev).
    // Tangent at v0 = next - prev = (10 - -10, -10 - 10) = (20, -20).
    // Normal = (-ty, tx) / |t| = (20, 20) / |t|, length |t| = sqrt(800).
    // halfW = 2, so outer = (centerline + n*2) etc. We just check
    // |outer - inner| at each vertex equals 2 * halfW * |normal|.
    for (let i = 0; i < square.length; i++) {
      const dx = outer[i][0] - inner[i][0];
      const dy = outer[i][1] - inner[i][1];
      const d  = Math.hypot(dx, dy);
      expect(d).toBeCloseTo(4); // 2 * halfW
    }
  });
});

describe('rectInstanceToRing', () => {
  it('returns 4 corners CCW from SW for an axis-aligned rect', () => {
    const ring = rectInstanceToRing({ cx: 0, cy: 0, w: 10, h: 6, rotation: 0 });
    expect(ring).toEqual([
      [-5, -3], [5, -3], [5, 3], [-5, 3],
    ]);
  });
  it('translates by cx/cy', () => {
    const ring = rectInstanceToRing({ cx: 100, cy: 50, w: 4, h: 2, rotation: 0 });
    expect(ring).toEqual([
      [98, 49], [102, 49], [102, 51], [98, 51],
    ]);
  });
  it('rotates the corners about cx/cy', () => {
    const ring = rectInstanceToRing({ cx: 0, cy: 0, w: 10, h: 0, rotation: 90 });
    // A flat horizontal segment rotated 90° → vertical segment of length 10
    expect(ring[0][0]).toBeCloseTo(0);
    expect(ring[0][1]).toBeCloseTo(-5);
    expect(ring[1][0]).toBeCloseTo(0);
    expect(ring[1][1]).toBeCloseTo(5);
  });
});

describe('shapeInstanceToRing', () => {
  it('produces 64 vertices for a circle', () => {
    const ring = shapeInstanceToRing({ kind: 'circle', cx: 0, cy: 0, r: 10, rotation: 0 });
    expect(ring).toHaveLength(64);
    // Every vertex lies on the radius-10 circle around (0,0).
    for (const [x, y] of ring) {
      expect(Math.hypot(x, y)).toBeCloseTo(10, 6);
    }
  });
  it('produces an exact hexagon for kind=polygon n=6', () => {
    const ring = shapeInstanceToRing({ kind: 'polygon', cx: 0, cy: 0, r: 10, n: 6, rotation: 0 });
    expect(ring).toHaveLength(6);
    for (const [x, y] of ring) {
      expect(Math.hypot(x, y)).toBeCloseTo(10, 6);
    }
  });
  it('produces 64 vertices for an ellipse with the right axes', () => {
    const ring = shapeInstanceToRing({ kind: 'ellipse', cx: 0, cy: 0, rx: 20, ry: 5, rotation: 0 });
    expect(ring).toHaveLength(64);
    // First vertex sits at (rx, 0); a quarter-turn later we should be at (0, ry).
    expect(ring[0][0]).toBeCloseTo(20, 6);
    expect(ring[0][1]).toBeCloseTo(0,  6);
    expect(ring[16][0]).toBeCloseTo(0, 6);
    expect(ring[16][1]).toBeCloseTo(5, 6);
  });
  it('defaults to rect for unknown / missing kind', () => {
    const ring = shapeInstanceToRing({ cx: 0, cy: 0, w: 4, h: 2, rotation: 0 });
    expect(ring).toHaveLength(4);
  });
});

describe('ringToSvgPath', () => {
  it('returns empty string for empty input', () => {
    expect(ringToSvgPath([])).toBe('');
    expect(ringToSvgPath(null)).toBe('');
  });
  it('produces an M-L-Z path with y flipped', () => {
    const d = ringToSvgPath([[0, 0], [10, 0], [10, 5]]);
    // y-up world → y-down screen, so y values negate.
    expect(d).toBe('M 0 0 L 10 0 L 10 -5 Z');
  });
});
