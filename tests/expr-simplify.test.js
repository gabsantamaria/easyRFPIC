// Symbolic simplifier (src/scene/expr-simplify.js) tests.
//
// The simplifier turns the enormous composed position/size exprs the
// cross-section derivation hands to the Q2D exporter into compact, AEDT-valid
// strings WITHOUT changing the value. Every simplification is verified for
// numeric identity against the original via evalExpr (the simplifier's own
// self-guard + these tests as an independent check).
import { describe, it, expect } from 'vitest';
import { simplifyExpr } from '../src/scene/expr-simplify.js';
import { evalExpr } from '../src/scene/params.js';

// Random-probe numeric-identity helper: assert simplifyExpr(e) evaluates to the
// SAME value as e over several assignments of its free variables. Independent
// of the module's internal self-guard (different seed / different eval path).
const IDENT_RE = /[A-Za-z_][A-Za-z0-9_]*/g;
const RESERVED = new Set(['sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2', 'sqrt', 'exp', 'log', 'log10', 'abs', 'min', 'max', 'floor', 'ceil', 'round', 'pow', 'pi', 'e', 'PI', 'E', 'um', 'mm', 'cm', 'm', 'nm', 'deg', 'rad']);
function freeVars(...exprs) {
  const out = new Set();
  for (const e of exprs) for (const id of (String(e).match(IDENT_RE) || [])) if (!RESERVED.has(id)) out.add(id);
  return [...out];
}
function assertIdentical(orig, { trials = 12, vals } = {}) {
  const simp = simplifyExpr(orig);
  const vars = freeVars(orig, simp);
  for (let t = 0; t < trials; t++) {
    const pv = {};
    // Distinct per-trial pseudo-random values in [0.5, 9.5], avoiding 0.
    for (let i = 0; i < vars.length; i++) {
      pv[vars[i]] = vals ? vals[vars[i]] : 0.5 + ((t * 31 + i * 17 + 3) % 90) / 10;
    }
    const a = evalExpr(orig, pv);
    const b = evalExpr(simp, pv);
    const scale = Math.max(1, Math.abs(a), Math.abs(b));
    expect(Math.abs(a - b)).toBeLessThan(1e-7 * scale);
  }
  return simp;
}

describe('simplifyExpr — core identities', () => {
  it('collapses (A+c) - (A-c) -> 2c (the real conductor-width case)', () => {
    const s = assertIdentical('(BIG + w/2) - (BIG - w/2)');
    expect(s).toBe('w');
  });

  it('drops + (0) additive identity', () => {
    expect(simplifyExpr('(0) + X')).toBe('X');
    expect(simplifyExpr('X + (0)')).toBe('X');
    expect(simplifyExpr('(0) + X + (0)')).toBe('X');
  });

  it('drops * (1) multiplicative identity', () => {
    expect(simplifyExpr('X * (1)')).toBe('X');
    expect(simplifyExpr('(1) * X')).toBe('X');
  });

  it('collapses * (0) to 0', () => {
    expect(simplifyExpr('X * (0)')).toBe('0');
    expect(simplifyExpr('(0) * X * Y')).toBe('0');
  });

  it('drops / (1) identity', () => {
    expect(simplifyExpr('X / (1)')).toBe('X');
  });

  it('folds a constant trig subtree: cos(180deg) -> -1', () => {
    expect(simplifyExpr('cos(((180))*(pi/180))')).toBe('-1');
    expect(simplifyExpr('sin(((180))*(pi/180))')).toBe('0');
    // and folded INTO a linear term
    expect(assertIdentical('X + cos(((180))*(pi/180))')).toBe('X - 1');
  });

  it('folds a -1.0000000000 * (1) * X noise term to -X', () => {
    expect(simplifyExpr('(-1.000000000000) * (1) * X')).toBe('-X');
  });

  it('cleans float noise on a bare number', () => {
    expect(simplifyExpr('106.30499999999998')).toBe('106.305');
    expect(simplifyExpr('8.246150000000029')).toBe('8.24615');
  });

  it('removes nested redundant parentheses', () => {
    expect(simplifyExpr('((((a))))')).toBe('a');
    expect(simplifyExpr('(((a + b)))')).toBe('a + b');
  });
});

describe('simplifyExpr — opaque-atom preservation', () => {
  it('keeps var*var/var products opaque (exactly)', () => {
    const s = assertIdentical('a*b/c');
    // still contains the product structure — not linearized
    expect(s).toContain('a');
    expect(s).toContain('b');
    expect(s).toContain('c');
    expect(s).toContain('*');
    expect(s).toContain('/');
  });

  it('keeps division by a non-constant opaque', () => {
    // The compact original is already minimal, so the length guard keeps it
    // verbatim — but it stays a genuine (numerically identical) division, never
    // linearized. The point is: no cross-multiplication / no value change.
    const s = assertIdentical('a/(x+y)');
    expect(s).toContain('a');
    expect(s).toContain('/');
    expect(s).toContain('x');
    expect(s).toContain('y');
    // a more redundant division DOES get tidied while staying opaque:
    assertIdentical('(a) / ((x) + (y))');
  });

  it('keeps a function of a non-constant arg opaque', () => {
    const s = assertIdentical('cos(x)');
    expect(s).toBe('cos(x)');
    assertIdentical('sqrt(a + b)');
  });

  it('collects like opaque atoms so they cancel', () => {
    // (a*b) - (a*b) -> 0 (same canonical opaque key)
    expect(simplifyExpr('(a*b) - (a*b)')).toBe('0');
    // 2*(a/b) + (a/b) -> 3*(a/b)
    const s = assertIdentical('2*(a/b) + (a/b)');
    expect(s).toMatch(/3\s*\*\s*\(?a\s*\/\s*b\)?/);
  });

  it('a constant coefficient multiplies through to an opaque atom', () => {
    assertIdentical('2 * (a*b)');
  });
});

describe('simplifyExpr — pi / constant folding', () => {
  it('folds pi only inside otherwise-constant subtrees', () => {
    // pi*2 with no free vars folds to a number
    const s = simplifyExpr('sqrt(pi*pi)');
    expect(Number(s)).toBeCloseTo(Math.PI, 9);
    // pi surviving next to a variable keeps a valid (identical) expr
    assertIdentical('2*pi*Freq');
    assertIdentical('X + pi');
  });
});

describe('simplifyExpr — self-guard (return original unchanged)', () => {
  it('returns non-string / empty input unchanged', () => {
    expect(simplifyExpr(42)).toBe(42);
    expect(simplifyExpr('')).toBe('');
    expect(simplifyExpr('   ')).toBe('   ');
  });

  it('returns the original on an unparseable / unknown-token input', () => {
    expect(simplifyExpr('a $ b')).toBe('a $ b');
    expect(simplifyExpr('a +')).toBe('a +');
    expect(simplifyExpr('(a')).toBe('(a');
    expect(simplifyExpr('a[0]')).toBe('a[0]');
  });

  it('leaves an already-minimal lone variable or number effectively unchanged', () => {
    expect(simplifyExpr('foo')).toBe('foo');
    expect(simplifyExpr('3.5')).toBe('3.5');
  });

  it('a genuine /0 subexpr is preserved (never claimed simplified wrongly)', () => {
    // 1/(x-x) is Infinity — the self-guard bails to unchanged.
    const s = simplifyExpr('1/(x - x)');
    // Either unchanged, or a safe form — but must NOT collapse to a finite
    // constant (that would be a value change). evalExpr returns 0 on a thrown
    // eval, so we assert the string still divides by a zero-valued denom.
    expect(s).toBe('1/(x - x)'); // self-guard bails -> original unchanged
  });
});

describe('simplifyExpr — numeric identity over random exprs (evalExpr parity)', () => {
  const RANDOM_EXPRS = [
    '(a + b) - (a - b)',
    '2*a + 3*a - a',
    'a/2 + a/2',
    '(a + b + c) - (b + c)',
    'a*(2) + b*(0) + c*(1)',
    '(0) + (0) + a + (0)',
    'a - (a - b) - (b - c)',
    '((a) + ((a) + 1 * (b)) + ((a) + 2 * (b)))/3',
    'cos(((180))*(pi/180)) * a + sin(((0))*(pi/180)) * b',
    '(-(w)/2) + (w/2)',
    '106.30499999999998 + a - 106.305',
    'a*b - b*a',
  ];
  for (const e of RANDOM_EXPRS) {
    it(`preserves value: ${e}`, () => { assertIdentical(e); });
  }

  it('preserves value on a real KI-design cond22 position fragment', () => {
    // A representative (trimmed) slice of the actual composed XStart expr the
    // cross-section derivation emits: transform-matrix mess with cos(180deg),
    // * (0), and centroid boolean-bbox arithmetic that cancels.
    const real = '(((0) + ((0) - ((0))) * cos(((180))*(pi/180)) - ((0) - ((0))) * sin(((180))*(pi/180))) + ((-1.000000000000) * (1) * (-(w)) - (0.000000000000) * (1) * (-(h)))) + (gap) - (feezZ0_W)/2 + (feezZ0_W)/2';
    const s = assertIdentical(real);
    // the +/- (feezZ0_W)/2 pair must have cancelled
    expect(s).not.toContain('feezZ0_W');
  });
});
