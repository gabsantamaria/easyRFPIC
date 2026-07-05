// Symbolic simplifier for the parametric position/size expressions the
// cross-section derivation (cross-section.js) hands to the Q2D exporter.
//
// WHY THIS EXISTS: those exprs are built by composing snap-chain walks,
// transform matrices, and boolean-bbox min/max fallbacks. The composition is
// numerically correct but textually enormous — a single conductor XStart is
// ~1.4 kB of arithmetic riddled with `+ (0)`, `* (1)`, `* (0)`,
// `cos(((180))*(pi/180))` (= -1), `(-1.000000000000) * (1) * X` (= -X),
// deeply nested redundant parens, and float noise like `106.30499999999998`.
// A REAL width the user pasted is structurally `(BIG + w/2) - (BIG - w/2)` and
// MUST collapse to `w`. This module does that WITHOUT ever changing the value.
//
// KEY OBSERVATION (what makes a linear normalizer sufficient): after folding
// the constant trig (`cos(180deg) = -1`, etc.), every one of these expressions
// is a LINEAR combination of the design variables plus a constant — positions
// are sums of `var*const` terms; the only functions left take CONSTANT args
// (fold to numbers); division is by constants. So we normalize to
// `constant + Σ coeff·atom`, collect like atoms (this is what cancels
// `(A+c) - (A-c) -> 2c`), and re-emit compactly. Anything the linearizer can't
// crack (var*var, division by a non-constant, a function of a non-constant
// arg) is kept as an OPAQUE ATOM — canonicalized by its own recursively
// simplified string and preserved EXACTLY, so we never corrupt geometry.
//
// SAFETY: before returning we re-verify with evalExpr that the simplified expr
// equals the original for >=8 random identifier assignments (seeded, so
// deterministic). Any mismatch / parse failure / unknown token -> return the
// ORIGINAL string unchanged. A bug here can therefore only FAIL to simplify,
// never produce a wrong number.

import { evalExpr, RESERVED_IDENTS } from './params.js';

// ── Numeric formatting ──────────────────────────────────────────────────
// Same rounding/trim contract as q2d.js `dec` so simplified constants read
// identically to the baked numerics elsewhere (round ~1e-9, no float noise,
// no trailing zeros). Handles the leading-minus and integer cases cleanly.
const NUM_EPS = 1e-9;
function fmtNum(x) {
  if (!Number.isFinite(x)) return '0';
  // Snap values that are within rounding noise of an integer (float noise like
  // 106.30499999999998 vs 106.305 is handled by the toFixed(9) below; this
  // extra snap catches e.g. 9.999999999 -> 10).
  const r = Math.round(x * 1e9) / 1e9;
  let s = r.toFixed(9);
  if (s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\.$/, '');
  if (s === '-0') s = '0';
  return s || '0';
}

// ── Tokenizer ───────────────────────────────────────────────────────────
// Robust arithmetic lexer: decimal / scientific numbers, identifiers, the
// operators + - * / and parentheses + comma. `um` and friends never appear
// here — the caller strips the unit before simplifying and re-wraps after —
// but the parser tolerates any RESERVED_IDENT as either a function name (when
// followed by `(`) or a constant identifier (`pi`, `e`).
const TOKEN_RE = /\s*([0-9]*\.?[0-9]+(?:[eE][+-]?[0-9]+)?|[A-Za-z_][A-Za-z0-9_]*|[()+\-*/,])/y;

function tokenize(s) {
  const toks = [];
  TOKEN_RE.lastIndex = 0;
  let last = 0;
  while (TOKEN_RE.lastIndex < s.length) {
    const start = TOKEN_RE.lastIndex;
    const m = TOKEN_RE.exec(s);
    if (!m || m.index == null) break;
    // Reject any gap between tokens that isn't pure whitespace (an unknown
    // char) — the caller's self-guard turns this into "return original".
    const between = s.slice(last, start + m[0].indexOf(m[1]));
    if (between.trim() !== '') return null;
    toks.push(m[1]);
    last = TOKEN_RE.lastIndex;
  }
  if (s.slice(last).trim() !== '') return null; // trailing junk
  return toks;
}

// ── Parser (recursive descent, standard precedence) ─────────────────────
// Grammar:  expr := term (('+' | '-') term)*
//           term := unary (('*' | '/') unary)*
//           unary := ('+' | '-') unary | primary
//           primary := number | ident | ident '(' args ')' | '(' expr ')'
// AST nodes: {t:'num',v}, {t:'var',name}, {t:'neg',a}, {t:'bin',op,a,b},
//            {t:'call',name,args:[]}
function parse(toks) {
  let i = 0;
  const peek = () => toks[i];
  const eat = (x) => { if (toks[i] !== x) throw new Error(`expected ${x}`); i++; };

  function parseExpr() {
    let node = parseTerm();
    while (peek() === '+' || peek() === '-') {
      const op = toks[i++];
      node = { t: 'bin', op, a: node, b: parseTerm() };
    }
    return node;
  }
  function parseTerm() {
    let node = parseUnary();
    while (peek() === '*' || peek() === '/') {
      const op = toks[i++];
      node = { t: 'bin', op, a: node, b: parseUnary() };
    }
    return node;
  }
  function parseUnary() {
    if (peek() === '+') { i++; return parseUnary(); }
    if (peek() === '-') { i++; return { t: 'neg', a: parseUnary() }; }
    return parsePrimary();
  }
  function parsePrimary() {
    const tk = peek();
    if (tk === undefined) throw new Error('unexpected end');
    if (tk === '(') {
      i++;
      const node = parseExpr();
      eat(')');
      return node;
    }
    if (/^[0-9]|^\./.test(tk)) { i++; return { t: 'num', v: Number(tk) }; }
    if (/^[A-Za-z_]/.test(tk)) {
      i++;
      if (peek() === '(') {
        // function call
        i++;
        const args = [];
        if (peek() !== ')') {
          args.push(parseExpr());
          while (peek() === ',') { i++; args.push(parseExpr()); }
        }
        eat(')');
        return { t: 'call', name: tk, args };
      }
      return { t: 'var', name: tk };
    }
    throw new Error(`unexpected token ${tk}`);
  }

  const node = parseExpr();
  if (i !== toks.length) throw new Error('trailing tokens');
  return node;
}

// ── Constant table (identifiers with fixed numeric values) ──────────────
const CONST_IDENTS = { pi: Math.PI, PI: Math.PI, e: Math.E, E: Math.E };

// ── Foldable functions (constant-arg only) ──────────────────────────────
// Mirror the MATH_FNS evalExpr supports; degrees are NOT auto-converted (the
// exprs already carry the *(pi/180) factor themselves, e.g. cos(180*pi/180)).
const FOLD_FNS = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan,
  asin: Math.asin, acos: Math.acos, atan: Math.atan, atan2: Math.atan2,
  sqrt: Math.sqrt, exp: Math.exp, log: Math.log, log10: Math.log10,
  abs: Math.abs, floor: Math.floor, ceil: Math.ceil, round: Math.round,
  pow: Math.pow, min: Math.min, max: Math.max,
};

// ── AST -> linear form ──────────────────────────────────────────────────
// A LinForm is { c: number, terms: Map<atomKey, coeff> }. An atom is either a
// bare design variable (key === its name) or an OPAQUE node whose key is its
// own recursively-simplified canonical string, wrapped so we never re-parse it
// as linear. Opaque atoms are stored alongside their AST so we can re-emit.
//
// linearize(node) returns a LinForm. It NEVER throws for a well-formed AST —
// anything non-linear becomes a single opaque term with coeff 1. The self-
// guard is the backstop for logic errors.

// Registry mapping an opaque atomKey -> its display string (already
// parenthesized as needed by the emitter). Kept per-simplify call.
function makeLinearizer() {
  // Cache of opaque atom display strings, keyed by canonical key.
  const opaqueDisplay = new Map();

  // Try to reduce a node to a pure constant; return {ok, v} .
  function tryConst(node) {
    switch (node.t) {
      case 'num': return { ok: true, v: node.v };
      case 'var': {
        if (Object.prototype.hasOwnProperty.call(CONST_IDENTS, node.name)) {
          return { ok: true, v: CONST_IDENTS[node.name] };
        }
        return { ok: false };
      }
      case 'neg': {
        const a = tryConst(node.a);
        return a.ok ? { ok: true, v: -a.v } : { ok: false };
      }
      case 'bin': {
        const a = tryConst(node.a); const b = tryConst(node.b);
        if (!a.ok || !b.ok) return { ok: false };
        switch (node.op) {
          case '+': return { ok: true, v: a.v + b.v };
          case '-': return { ok: true, v: a.v - b.v };
          case '*': return { ok: true, v: a.v * b.v };
          case '/': return { ok: true, v: a.v / b.v };
          default: return { ok: false };
        }
      }
      case 'call': {
        const fn = FOLD_FNS[node.name];
        if (!fn) return { ok: false };
        const vs = [];
        for (const arg of node.args) {
          const cv = tryConst(arg);
          if (!cv.ok) return { ok: false };
          vs.push(cv.v);
        }
        const v = fn(...vs);
        return Number.isFinite(v) ? { ok: true, v } : { ok: false };
      }
      default: return { ok: false };
    }
  }

  const emptyForm = () => ({ c: 0, terms: new Map() });
  const constForm = (v) => ({ c: v, terms: new Map() });
  // A form that is numerically zero: no surviving atom terms and a ~0 constant.
  const isZeroForm = (f) => {
    if (Math.abs(f.c) > NUM_EPS) return false;
    for (const v of f.terms.values()) if (Math.abs(v) > NUM_EPS) return false;
    return true;
  };

  const addForm = (a, b) => {
    const out = { c: a.c + b.c, terms: new Map(a.terms) };
    for (const [k, v] of b.terms) out.terms.set(k, (out.terms.get(k) || 0) + v);
    return out;
  };
  const scaleForm = (f, s) => {
    if (s === 0) return emptyForm();
    const out = { c: f.c * s, terms: new Map() };
    for (const [k, v] of f.terms) out.terms.set(k, v * s);
    return out;
  };

  // Register a node as an opaque atom and return its LinForm (coeff-1 term).
  // The display string is the node's OWN recursive simplification, so opaque
  // subtrees are still tidied internally (e.g. a*b/c has each factor folded).
  function opaqueForm(node) {
    const disp = emitOpaque(node);
    const key = disp; // canonical: identical opaque subexprs collapse/cancel
    if (!opaqueDisplay.has(key)) opaqueDisplay.set(key, disp);
    return { c: 0, terms: new Map([[key, 1]]) };
  }

  function linearize(node) {
    // Constant subtree -> pure constant (folds pi, trig, nested arithmetic).
    const cv = tryConst(node);
    if (cv.ok) return constForm(cv.v);

    switch (node.t) {
      case 'var':
        // Non-constant identifier => a design variable atom.
        return { c: 0, terms: new Map([[node.name, 1]]) };
      case 'neg':
        return scaleForm(linearize(node.a), -1);
      case 'bin': {
        const { op } = node;
        if (op === '+') return addForm(linearize(node.a), linearize(node.b));
        if (op === '-') return addForm(linearize(node.a), scaleForm(linearize(node.b), -1));
        if (op === '*') {
          // Linear only if ONE side is a pure constant. (var*var is opaque.)
          const ca = tryConst(node.a); const cb = tryConst(node.b);
          if (ca.ok) return scaleForm(linearize(node.b), ca.v);
          if (cb.ok) return scaleForm(linearize(node.a), cb.v);
          // A factor that LINEARIZES to zero (e.g. `(0)*X` nested as the left
          // operand of `(0)*X*Y`) kills the whole product — even though it's
          // not a single constant token. This catches the `* (0)` cruft that
          // survives a level of nesting; without it the product went opaque and
          // printed the literal `0 * X * Y`.
          const la = linearize(node.a);
          if (isZeroForm(la)) return emptyForm();
          const lb = linearize(node.b);
          if (isZeroForm(lb)) return emptyForm();
          // If EITHER operand reduced to a pure constant after linearization
          // (all terms cancelled, leaving only `.c`), it's a legal scale factor.
          if (la.terms.size === 0) return scaleForm(lb, la.c);
          if (lb.terms.size === 0) return scaleForm(la, lb.c);
          return opaqueForm(node);
        }
        if (op === '/') {
          // Linear only if the DENOMINATOR is a pure constant.
          const cb = tryConst(node.b);
          if (cb.ok) {
            if (cb.v === 0) return opaqueForm(node); // preserve exactly (evalExpr yields Inf)
            return scaleForm(linearize(node.a), 1 / cb.v);
          }
          // Denominator that reduced to a pure constant post-cancellation is a
          // legal scale factor too. (A truly zero denom stays opaque -> the
          // self-guard sees non-finite and bails; we never fold it away.)
          const lb = linearize(node.b);
          if (lb.terms.size === 0 && Math.abs(lb.c) > NUM_EPS) {
            return scaleForm(linearize(node.a), 1 / lb.c);
          }
          // Numerator that linearizes to zero over a NON-zero denom is zero.
          const la = linearize(node.a);
          if (isZeroForm(la) && !isZeroForm(lb)) return emptyForm();
          return opaqueForm(node);
        }
        return opaqueForm(node);
      }
      case 'call':
        // A function of a non-constant arg is opaque (constant-arg calls were
        // already folded by tryConst above).
        return opaqueForm(node);
      default:
        return opaqueForm(node);
    }
  }

  return { linearize, opaqueDisplay, tryConst };
}

// ── Emit an OPAQUE node back to a string (recursively simplified inside) ──
// Opaque subtrees still benefit from internal folding — e.g. `a * b / c` keeps
// its var*var/var shape but any constant sub-factor is folded. We do this by
// emitting each child with the SAME public simplifier where the child is
// itself linear, and structurally otherwise. To avoid mutual-recursion tangles
// we implement a light structural printer that folds constants and parenthesi-
// zes by precedence; it does NOT re-run the full linear collect (that's the
// job of the top level), keeping opaque atoms byte-stable as canonical keys.
function emitOpaque(node) {
  return printNode(node, 0);
}

// Precedence: 1 = +/-, 2 = * /, 3 = unary/atom. A child needs parens when its
// precedence is lower than the context's minimum.
function printNode(node, minPrec) {
  // Fold a fully-constant node to a clean number first.
  const cv = foldConst(node);
  if (cv != null) return fmtNum(cv);

  switch (node.t) {
    case 'num': return fmtNum(node.v);
    case 'var': return node.name;
    case 'neg': {
      const inner = printNode(node.a, 3);
      const s = `-${inner}`;
      return minPrec > 1 ? `(${s})` : s;
    }
    case 'bin': {
      const prec = (node.op === '+' || node.op === '-') ? 1 : 2;
      const a = printNode(node.a, prec);
      // Right operand of - and / needs higher binding to preserve grouping.
      const rightMin = (node.op === '-' || node.op === '/') ? prec + 1 : prec;
      const b = printNode(node.b, rightMin);
      const s = `${a} ${node.op} ${b}`;
      return prec < minPrec ? `(${s})` : s;
    }
    case 'call': {
      const args = node.args.map((x) => printNode(x, 0)).join(', ');
      return `${node.name}(${args})`;
    }
    default: return '0';
  }
}

// foldConst: if the node is identifier-free (only numbers, pi/e, foldable
// calls), return its number; else null. Standalone copy so printNode has no
// dependency on the linearizer closure.
function foldConst(node) {
  switch (node.t) {
    case 'num': return node.v;
    case 'var':
      return Object.prototype.hasOwnProperty.call(CONST_IDENTS, node.name)
        ? CONST_IDENTS[node.name] : null;
    case 'neg': {
      const a = foldConst(node.a);
      return a == null ? null : -a;
    }
    case 'bin': {
      const a = foldConst(node.a); const b = foldConst(node.b);
      if (a == null || b == null) return null;
      switch (node.op) {
        case '+': return a + b;
        case '-': return a - b;
        case '*': return a * b;
        case '/': return a / b;
        default: return null;
      }
    }
    case 'call': {
      const fn = FOLD_FNS[node.name];
      if (!fn) return null;
      const vs = [];
      for (const arg of node.args) {
        const cv = foldConst(arg);
        if (cv == null) return null;
        vs.push(cv);
      }
      const v = fn(...vs);
      return Number.isFinite(v) ? v : null;
    }
    default: return null;
  }
}

// ── Emit the collected linear form to a compact string ──────────────────
// Deterministic ordering: bare design variables first (alphabetical), then
// opaque atoms (by their canonical string). Coefficient 1 is omitted, -1 emits
// a leading minus, other coeffs as "<c>*atom". A trailing constant is added.
// Empty result -> "0". Opaque atoms are parenthesized when they'd bind wrong.
function emitLinForm(form) {
  const keys = [...form.terms.keys()].filter((k) => {
    const coeff = form.terms.get(k);
    return Math.abs(coeff) > NUM_EPS; // drop atoms that rounded to zero
  });
  // Split bare-var atoms from opaque ones; opaque keys contain non-ident chars.
  const isBareVar = (k) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k);
  const bare = keys.filter(isBareVar).sort();
  const opaque = keys.filter((k) => !isBareVar(k)).sort();
  const ordered = [...bare, ...opaque];

  const pieces = [];
  for (const k of ordered) {
    const coeff = form.terms.get(k);
    // Parenthesize an opaque atom that is a sum/difference so a coefficient
    // multiply binds correctly. A bare var never needs parens.
    const atomStr = isBareVar(k) ? k : parenIfNeeded(k);
    const c = Math.round(coeff * 1e9) / 1e9;
    if (Math.abs(c - 1) < NUM_EPS) {
      pieces.push({ sign: 1, body: atomStr });
    } else if (Math.abs(c + 1) < NUM_EPS) {
      pieces.push({ sign: -1, body: atomStr });
    } else if (c < 0) {
      pieces.push({ sign: -1, body: `${fmtNum(-c)}*${atomStr}` });
    } else {
      pieces.push({ sign: 1, body: `${fmtNum(c)}*${atomStr}` });
    }
  }

  const cc = Math.round(form.c * 1e9) / 1e9;
  const hasConst = Math.abs(cc) > NUM_EPS;

  if (pieces.length === 0) return hasConst ? fmtNum(cc) : '0';

  let out = '';
  pieces.forEach((p, idx) => {
    if (idx === 0) {
      out += p.sign < 0 ? `-${p.body}` : p.body;
    } else {
      out += p.sign < 0 ? ` - ${p.body}` : ` + ${p.body}`;
    }
  });
  if (hasConst) {
    out += cc < 0 ? ` - ${fmtNum(-cc)}` : ` + ${fmtNum(cc)}`;
  }
  return out;
}

// A parenthesized opaque atom string: if it already reads as a single bound
// unit (starts with '(' balanced to the end, or is a call / bare product),
// leave it; else wrap. Conservative — wrapping a already-safe expr is harmless
// (the self-guard tolerates extra parens), so we wrap anything containing a
// top-level +/- .
function parenIfNeeded(str) {
  // Detect a top-level +/- (not inside parens) -> needs wrapping for a coeff
  // multiply. Leading unary minus doesn't count.
  let depth = 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if ((ch === '+' || ch === '-') && depth === 0 && i > 0) {
      // Ensure it's a binary operator (preceded by a non-operator token).
      const prev = str[i - 1];
      if (prev !== '(' && prev !== '*' && prev !== '/' && prev !== '+' && prev !== '-' && prev !== ' ' || str[i + 1] === ' ') {
        return `(${str})`;
      }
    }
  }
  return str;
}

// ── Self-guard: random-probe numeric equivalence ────────────────────────
// Seeded LCG so results are deterministic across runs/machines. Values in
// ~[0.3, 9.7], deliberately avoiding 0 (a zero denominator or a * (0) would
// mask a mismatch). Every free identifier in EITHER expr is assigned.
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    // Numerical Recipes LCG.
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function freeIdents(str) {
  const ids = str.match(/[A-Za-z_][A-Za-z0-9_]*/g) || [];
  const out = new Set();
  for (const id of ids) {
    if (RESERVED_IDENTS.has(id)) continue;
    if (id === 'pi' || id === 'PI' || id === 'e' || id === 'E') continue;
    out.add(id);
  }
  return [...out];
}

function probesMatch(original, simplified) {
  const ids = [...new Set([...freeIdents(original), ...freeIdents(simplified)])];
  const rng = makeRng(0x9e3779b1); // fixed seed
  const PROBES = 10; // >= 8 required
  for (let p = 0; p < PROBES; p++) {
    const pv = {};
    for (const id of ids) pv[id] = 0.3 + rng() * 9.4; // ~[0.3, 9.7]
    const a = evalExpr(original, pv);
    const b = evalExpr(simplified, pv);
    if (!Number.isFinite(a) || !Number.isFinite(b)) {
      // A non-finite original (e.g. genuine /0) can't be probed reliably —
      // bail to "unchanged" so we never claim a match we can't verify.
      return false;
    }
    const scale = Math.max(1, Math.abs(a), Math.abs(b));
    if (Math.abs(a - b) > 1e-7 * scale) return false;
  }
  return true;
}

// ── Public API ──────────────────────────────────────────────────────────
// simplifyExpr(s) -> simplified unit-free arithmetic string, guaranteed to
// evaluate identically (self-guard). On ANY failure, returns `s` unchanged.
export function simplifyExpr(s) {
  if (typeof s !== 'string') return s;
  const trimmed = s.trim();
  if (trimmed === '') return s;
  // Fast path: a lone identifier or number needs no work (and re-emitting a
  // number would strip nothing useful) — but still normalize float noise on a
  // bare number.
  try {
    const toks = tokenize(trimmed);
    if (!toks || toks.length === 0) return s;
    const ast = parse(toks);
    const { linearize } = makeLinearizer();
    const form = linearize(ast);
    let out = emitLinForm(form);
    if (out === '') out = '0';
    // Never expand: if the "simplified" string is LONGER than the original and
    // structurally identical in value, still prefer it only when it's not
    // longer OR the original had obvious cruft. Simplest rule: keep whichever
    // is valid; the self-guard below is the only correctness gate. But guard
    // against a pathological blow-up by keeping the original when the result is
    // strictly longer (simplification should only ever shrink or match).
    if (out.length > trimmed.length && !hasCruft(trimmed)) return s;
    // Self-guard: numeric equivalence over random probes.
    if (!probesMatch(trimmed, out)) return s;
    return out;
  } catch {
    return s; // parse error / unknown token / any logic error -> unchanged
  }
}

// Heuristic: does the original clearly contain redundant arithmetic worth
// simplifying even if the naive length comparison says otherwise? Used only to
// decide whether to accept a same-or-slightly-longer result; the self-guard is
// the real correctness gate. Matches the noise the derivation emits.
function hasCruft(s) {
  return /\+\s*\(0\)|\*\s*\(1\)|\*\s*\(0\)|\/\s*\(1\)|cos\(|sin\(|tan\(|-1\.0{6,}|\d\.\d*0{6,}\d/.test(s);
}
