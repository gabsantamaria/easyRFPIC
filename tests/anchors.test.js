import { describe, it, expect } from 'vitest';
import {
  ANCHORS,
  parseAnchor,
  anchorLocal,
  anchorWorld,
} from '../src/scene/anchors.js';

describe('ANCHORS', () => {
  it('contains the nine fixed anchor names', () => {
    expect(ANCHORS).toEqual(['NW', 'N', 'NE', 'W', 'C', 'E', 'SW', 'S', 'SE']);
  });
});

describe('parseAnchor', () => {
  it('parses fixed anchor names', () => {
    expect(parseAnchor('C')).toEqual({ kind: 'fixed', name: 'C' });
    expect(parseAnchor('NE')).toEqual({ kind: 'fixed', name: 'NE' });
  });
  it('parses edge anchors with parametric t', () => {
    expect(parseAnchor('T:0.3')).toEqual({ kind: 'edge', side: 'T', t: 0.3 });
    expect(parseAnchor('B:0')).toEqual({ kind: 'edge', side: 'B', t: 0 });
    expect(parseAnchor('R:1')).toEqual({ kind: 'edge', side: 'R', t: 1 });
  });
  it('clamps t > 1 down to 1 (negative t syntax falls through to a fixed anchor)', () => {
    // The edge regex only accepts non-negative numerals; the minus
    // sign makes the whole string fall through to the fixed-anchor
    // path. We only have to clamp the upper end here.
    expect(parseAnchor('T:1.5').t).toBe(1);
    expect(parseAnchor('T:-0.5')).toEqual({ kind: 'fixed', name: 'T:-0.5' });
  });
  it('falls back to center for non-string input', () => {
    expect(parseAnchor(null)).toEqual({ kind: 'fixed', name: 'C' });
    expect(parseAnchor(undefined)).toEqual({ kind: 'fixed', name: 'C' });
  });
});

describe('anchorLocal — fixed anchors', () => {
  // 10×6 rect: corners ±5 / ±3, midpoints accordingly.
  it('center is at (0, 0)', () => {
    expect(anchorLocal('C', 10, 6)).toEqual({ x: 0, y: 0 });
  });
  it('NW = (-w/2, +h/2)', () => {
    expect(anchorLocal('NW', 10, 6)).toEqual({ x: -5, y: 3 });
  });
  it('NE = (+w/2, +h/2)', () => {
    expect(anchorLocal('NE', 10, 6)).toEqual({ x: 5, y: 3 });
  });
  it('SW = (-w/2, -h/2)', () => {
    expect(anchorLocal('SW', 10, 6)).toEqual({ x: -5, y: -3 });
  });
  it('SE = (+w/2, -h/2)', () => {
    expect(anchorLocal('SE', 10, 6)).toEqual({ x: 5, y: -3 });
  });
  it('N = (0, +h/2), S = (0, -h/2)', () => {
    expect(anchorLocal('N', 10, 6)).toEqual({ x: 0, y: 3 });
    expect(anchorLocal('S', 10, 6)).toEqual({ x: 0, y: -3 });
  });
  it('E = (+w/2, 0), W = (-w/2, 0)', () => {
    expect(anchorLocal('E', 10, 6)).toEqual({ x: 5, y: 0 });
    expect(anchorLocal('W', 10, 6)).toEqual({ x: -5, y: 0 });
  });
});

describe('anchorLocal — edge anchors', () => {
  it('T:0 = (-w/2, +h/2) (top-west)', () => {
    expect(anchorLocal('T:0', 10, 6)).toEqual({ x: -5, y: 3 });
  });
  it('T:1 = (+w/2, +h/2) (top-east)', () => {
    expect(anchorLocal('T:1', 10, 6)).toEqual({ x: 5, y: 3 });
  });
  it('T:0.5 = (0, +h/2) (top center)', () => {
    expect(anchorLocal('T:0.5', 10, 6)).toEqual({ x: 0, y: 3 });
  });
  it('L:0 = (-w/2, -h/2) (bottom-west)', () => {
    expect(anchorLocal('L:0', 10, 6)).toEqual({ x: -5, y: -3 });
  });
  it('R:0.5 = (+w/2, 0) (right center)', () => {
    expect(anchorLocal('R:0.5', 10, 6)).toEqual({ x: 5, y: 0 });
  });
});

describe('anchorWorld', () => {
  it('lifts a local anchor to world coordinates', () => {
    const comp = { cx: 100, cy: 50, w: '10', h: '6' };
    expect(anchorWorld(comp, 'C', {})).toEqual({ x: 100, y: 50 });
    expect(anchorWorld(comp, 'NE', {})).toEqual({ x: 105, y: 53 });
    expect(anchorWorld(comp, 'SW', {})).toEqual({ x: 95, y: 47 });
  });
  it('accepts numeric w/h (post-solve booleans)', () => {
    const comp = { cx: 0, cy: 0, w: 10, h: 6 };
    expect(anchorWorld(comp, 'E', {})).toEqual({ x: 5, y: 0 });
  });
  it('resolves expression-string w/h via params', () => {
    const comp = { cx: 0, cy: 0, w: '2 * a', h: 'b' };
    expect(anchorWorld(comp, 'NE', { a: 5, b: 8 })).toEqual({ x: 5, y: 4 });
  });
});
