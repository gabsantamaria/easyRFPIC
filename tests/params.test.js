import { describe, it, expect } from 'vitest';
import {
  tokenizeIdents,
  tokenizeComponentExprs,
  resolveParams,
  evalExpr,
  RESERVED_IDENTS,
} from '../src/scene/params.js';

describe('tokenizeIdents', () => {
  it('returns identifiers in source order', () => {
    expect(tokenizeIdents('a + b * c')).toEqual(['a', 'b', 'c']);
  });
  it('skips numeric literals', () => {
    expect(tokenizeIdents('2 * pi + 3')).toEqual(['pi']);
  });
  it('keeps underscore identifiers', () => {
    expect(tokenizeIdents('h_wg + cap_gap')).toEqual(['h_wg', 'cap_gap']);
  });
  it('handles non-string inputs by returning []', () => {
    expect(tokenizeIdents(42)).toEqual([]);
    expect(tokenizeIdents(null)).toEqual([]);
    expect(tokenizeIdents(undefined)).toEqual([]);
  });
});

describe('evalExpr', () => {
  it('passes through numeric literals', () => {
    expect(evalExpr(42, {})).toBe(42);
  });
  it('returns 0 for empty / non-string inputs', () => {
    expect(evalExpr('', {})).toBe(0);
    expect(evalExpr('   ', {})).toBe(0);
    expect(evalExpr(null, {})).toBe(0);
  });
  it('parses bare numbers', () => {
    expect(evalExpr('3.14', {})).toBeCloseTo(3.14);
    expect(evalExpr('-2.5', {})).toBeCloseTo(-2.5);
  });
  it('substitutes named params', () => {
    expect(evalExpr('a + b', { a: 2, b: 3 })).toBe(5);
  });
  it('handles math functions', () => {
    expect(evalExpr('sin(0)', {})).toBe(0);
    expect(evalExpr('cos(0)', {})).toBe(1);
    expect(evalExpr('sqrt(9)', {})).toBe(3);
    expect(evalExpr('abs(-7)', {})).toBe(7);
  });
  it('handles pi / PI constants', () => {
    expect(evalExpr('pi', {})).toBeCloseTo(Math.PI);
    expect(evalExpr('PI', {})).toBeCloseTo(Math.PI);
    expect(evalExpr('cos(pi)', {})).toBeCloseTo(-1);
  });
  it('strips HFSS-style "um" unit suffixes after numbers or close-paren', () => {
    expect(evalExpr('5um + 3um', {})).toBe(8);
    expect(evalExpr('(2 + 3)um', {})).toBe(5);
  });
  it('sorts longer param names first to avoid partial matching', () => {
    // If `a` was substituted before `abc`, we'd corrupt `abc` → `(1)bc`.
    expect(evalExpr('abc + a', { a: 1, abc: 10 })).toBe(11);
  });
  it('returns 0 on syntax error inside the Function call', () => {
    expect(evalExpr('(((', {})).toBe(0);
  });
  it('returns 0 for NaN / Infinity', () => {
    expect(evalExpr('1/0', {})).toBe(0);   // Infinity
    expect(evalExpr('0/0', {})).toBe(0);   // NaN
  });
});

describe('resolveParams', () => {
  it('resolves a flat set of params', () => {
    const { values, errors } = resolveParams({
      a: { expr: '2' },
      b: { expr: '3' },
    });
    expect(values).toEqual({ a: 2, b: 3 });
    expect(errors).toEqual({});
  });
  it('resolves dependent params in any order', () => {
    const { values } = resolveParams({
      total: { expr: 'half * 2' },
      half:  { expr: '5' },
    });
    expect(values.half).toBe(5);
    expect(values.total).toBe(10);
  });
  it('reports circular references', () => {
    const { values, errors } = resolveParams({
      a: { expr: 'b' },
      b: { expr: 'a' },
    });
    expect(errors.a).toMatch(/circular/);
    expect(errors.b).toMatch(/circular/);
    expect(values.a).toBe(0);
    expect(values.b).toBe(0);
  });
  it('accepts extraValues as a starting point', () => {
    const { values } = resolveParams(
      { width: { expr: 'cap_w * 2' } },
      { cap_w: 7 },
    );
    expect(values.width).toBe(14);
    expect(values.cap_w).toBe(7);
  });
  it('reports invalid expressions without crashing', () => {
    const { errors } = resolveParams({
      bad: { expr: 'not_a_thing + ;' },
    });
    expect(errors.bad).toBeDefined();
  });
});

describe('tokenizeComponentExprs', () => {
  it('returns geometry idents from a rect', () => {
    const ids = tokenizeComponentExprs({ kind: 'rect', w: 'cap_w', h: 'cap_h' });
    expect(ids).toEqual(expect.arrayContaining(['cap_w', 'cap_h']));
  });
  it('returns shape-specific idents from a polygon (covers c.n which w/h does not)', () => {
    const ids = tokenizeComponentExprs({ kind: 'polygon', r: 'r_poly', n: 'n_poly', w: '2*r_poly', h: '2*r_poly' });
    expect(ids).toEqual(expect.arrayContaining(['r_poly', 'n_poly']));
  });
  it('returns racetrack-specific idents', () => {
    const ids = tokenizeComponentExprs({
      kind: 'racetrack',
      R: 'rt_R', L_straight: 'rt_L', p: 'rt_p', wgWidth: 'w_wg',
      w: '0', h: '0',
    });
    expect(ids).toEqual(expect.arrayContaining(['rt_R', 'rt_L', 'rt_p', 'w_wg']));
  });
  it('returns cutout-expression idents', () => {
    const ids = tokenizeComponentExprs({
      kind: 'rect', w: '0', h: '0',
      cutouts: [{ dx: 'pad_x', dy: 'pad_y', w: 'pad_w', h: 'pad_h' }],
    });
    expect(ids).toEqual(expect.arrayContaining(['pad_x', 'pad_y', 'pad_w', 'pad_h']));
  });
  it('returns transform-chain idents — the bug the user hit', () => {
    const ids = tokenizeComponentExprs({
      kind: 'rect', w: '0', h: '0',
      transforms: [
        { kind: 'repeat', enabled: true, n: 'n_copies', dx: 'pitch_x', dy: '0', includeOriginal: true },
        { kind: 'rotate', enabled: true, angle: 'theta', pivot: 'C' },
        { kind: 'displace', enabled: true, dx: 'shift_x', dy: 'shift_y' },
      ],
    });
    expect(ids).toEqual(expect.arrayContaining([
      'n_copies', 'pitch_x', 'theta', 'shift_x', 'shift_y',
    ]));
  });
  it('handles missing / undefined / null components without throwing', () => {
    expect(tokenizeComponentExprs(null)).toEqual([]);
    expect(tokenizeComponentExprs(undefined)).toEqual([]);
    expect(tokenizeComponentExprs({})).toEqual([]);
  });
});

describe('evalExpr scales with EXPRESSION size, not paramValues size', () => {
  it('ignores thousands of unrelated params (correctness + no O(#params) blowup)', () => {
    // Simulate solveLayout's workingPV on a large/flattened scene: thousands of
    // synthetic _comp_* entries the expression never references. Old evalExpr
    // scanned + regex-replaced EVERY key per call → quadratic freeze (the 2-line
    // wizard hang). It must substitute only the idents actually in the expression.
    const pv = { a: 3, b: 4 };
    for (let i = 0; i < 6000; i++) pv[`_comp_x${i}_cx`] = i;
    expect(evalExpr('a*a + b*b', pv)).toBe(25); // correct despite 6000 extra keys
    const t0 = Date.now();
    for (let i = 0; i < 5000; i++) evalExpr('a*a + b*b', pv);
    const ms = Date.now() - t0;
    // 5000 calls × ~2 idents ≈ tens of ms now; the old O(#params) form was
    // 5000 × 6000 regex ops ≈ many seconds. Generous bound to avoid CI flake.
    expect(ms).toBeLessThan(1500);
  });

  it('still substitutes overlapping identifier names correctly', () => {
    // Word boundaries keep `m` distinct from `m_n` regardless of order; the
    // longest-first sort is belt-and-suspenders.
    expect(evalExpr('m_n + m', { m: 2, m_n: 10 })).toBe(12);
    expect(evalExpr('m + m_n', { m: 2, m_n: 10 })).toBe(12);
  });
});

describe('RESERVED_IDENTS', () => {
  it('contains the common math functions / constants', () => {
    for (const name of ['sin', 'cos', 'tan', 'sqrt', 'abs', 'pi', 'PI']) {
      expect(RESERVED_IDENTS.has(name)).toBe(true);
    }
  });
  it('contains HFSS-style unit suffixes', () => {
    for (const u of ['um', 'mm', 'nm', 'deg', 'rad']) {
      expect(RESERVED_IDENTS.has(u)).toBe(true);
    }
  });
});
