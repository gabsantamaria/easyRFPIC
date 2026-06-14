// Parameter / expression evaluation.
//
// The scene model stores dimensions, positions, and offsets as expression
// strings (e.g. `"2*rt_R + w_wg"`). `resolveParams` settles the parameter
// dictionary itself (params may reference other params), and `evalExpr`
// evaluates an arbitrary expression against the resolved value map.
//
// Extracted from PhotonicLayout.jsx as Stage 1.2 of the planned refactor.

// Identifier names that are never treated as parameters when scanning
// expressions for missing params. Includes math functions / constants and
// HFSS-style unit suffixes.
export const RESERVED_IDENTS = new Set([
  'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2',
  'sqrt', 'exp', 'log', 'log10',
  'abs', 'min', 'max', 'floor', 'ceil', 'round', 'pow',
  'pi', 'e', 'PI', 'E',
  // Unit suffixes that may appear in HFSS-style expressions (e.g., "20um").
  // These are not parameters and must not be auto-created.
  'um', 'mm', 'cm', 'm', 'nm', 'deg', 'rad',
]);

// Math functions translated to their `Math.<fn>` equivalents during
// expression evaluation. Kept module-local: callers should not need it.
const MATH_FNS = [
  'abs', 'sqrt', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2',
  'exp', 'log', 'log10', 'floor', 'ceil', 'round', 'pow', 'min', 'max',
];

export function tokenizeIdents(expr) {
  if (typeof expr !== 'string') return [];
  const matches = expr.match(/[A-Za-z_][A-Za-z0-9_]*/g) || [];
  return matches;
}

// Order parameter NAMES so each appears AFTER every other parameter its
// expression references (dependencies first). resolveParams tolerates any
// stored order via fixpoint iteration, but exporters that DEFINE variables
// sequentially (HFSS `set_var`, pyAEDT `hfss[...] = ...`) evaluate each
// expression at creation time — a forward reference (defining `a = b + 1`
// before `b`) fails with "b is not a defined variable". Those exporters
// must emit in this order.
//
// Kahn's algorithm: zero-indegree params first, ties broken by declaration
// order for stable output. A dependency CYCLE can't be ordered; the cyclic
// members are appended in declaration order (HFSS still rejects a true
// cycle, which the in-app solver also flags — but that's a genuine user
// error, not an ordering bug). Same logic gdsfactory uses for its derived
// params; centralized here so all three exporters agree.
export function topoSortParams(params) {
  const names = Object.keys(params || {});
  const nameSet = new Set(names);
  const deps = {};
  for (const name of names) {
    const exprStr = String(params[name]?.expr ?? params[name]?.value ?? '0');
    const d = new Set();
    for (const id of tokenizeIdents(exprStr)) {
      if (id === name || RESERVED_IDENTS.has(id)) continue;
      if (nameSet.has(id)) d.add(id);
    }
    deps[name] = Array.from(d);
  }
  const order = [];
  const remaining = new Set(names);
  const inDeg = {};
  for (const n of names) inDeg[n] = deps[n].filter((x) => remaining.has(x)).length;
  while (remaining.size > 0) {
    const next = names.find((n) => remaining.has(n) && inDeg[n] === 0);
    if (!next) {
      for (const n of names) if (remaining.has(n)) { order.push(n); remaining.delete(n); }
      break;
    }
    order.push(next);
    remaining.delete(next);
    for (const n of remaining) if (deps[n].includes(next)) inDeg[n] = Math.max(0, inDeg[n] - 1);
  }
  return order;
}

// Every parameter-referencing expression on a component, flattened to a
// list of identifiers. Centralizes the "what fields can hold an
// expression" question so the param-highlight walker, the unused-param
// scanner, and any future code that needs the same answer don't drift
// out of sync.
//
// Covered fields:
//   - Geometry / shape-specific knobs: w, h, r, rx, ry, R, L_straight,
//     p, wgWidth, n. Some are redundantly captured via w/h (which
//     reference the kind-specific fields) but we collect them directly
//     too, so a user who has rewritten w/h still has their per-kind
//     knobs counted.
//   - Cutouts: each cutout's dx / dy / w / h.
//   - Transform chain: each transform's dx / dy / angle / n.
//   - Polyline trace width (`width`) and per-vertex expressions on
//     polyline / polyshape vertices: dx / dy (rel), cdx / cdy / angle
//     (arc), width (per-vertex taper). Mirrors VERTEX_EXPR_FIELDS in
//     rename-ident.js — keep both in sync.
//
// Boolean operands and snap-chain expressions are NOT included — those
// live OFF the component (operandIds → other components; snap.dx/dy
// → the snap record). Callers that need the full closure walk the
// graph themselves.
export function tokenizeComponentExprs(c) {
  if (!c) return [];
  const out = [];
  const push = (expr) => {
    if (typeof expr !== 'string') return;
    for (const id of tokenizeIdents(expr)) out.push(id);
  };
  push(c.w); push(c.h);
  push(c.r); push(c.rx); push(c.ry);
  push(c.R); push(c.L_straight); push(c.p); push(c.wgWidth);
  push(c.n);
  // First-class rotation (deg, CCW) + per-component Z offset (µm) +
  // rect corner fillet radius (µm, D3). Via components (D4) reuse the
  // `r` field above, so they're already covered.
  push(c.rotation); push(c.zOffset); push(c.cornerRadius);
  // Parametric root position (µm, C8) — applied by the solver on
  // unsnapped roots; expressions can reference any param.
  push(c.cxExpr); push(c.cyExpr);
  // Polyline trace width + per-vertex expression fields (rel dx/dy,
  // arc cdx/cdy/angle, taper width). Non-string fields are skipped by
  // push(), so snap vertices pass through harmlessly.
  push(c.width);
  for (const v of (c.vertices || [])) {
    if (!v) continue;
    push(v.dx); push(v.dy);
    push(v.cdx); push(v.cdy); push(v.angle);
    push(v.width);
  }
  for (const cu of (c.cutouts || [])) {
    push(cu.dx); push(cu.dy); push(cu.w); push(cu.h);
  }
  for (const t of (c.transforms || [])) {
    if (!t) continue;
    push(t.dx); push(t.dy); push(t.angle); push(t.n);
    // `offset` is the parametric shift used by duplicate_mirror —
    // it's an expression like '-cap_d/2' and can reference any param.
    push(t.offset);
    // px / py: custom rotate-pivot world coordinates (µm, C9). Mirrors
    // TRANSFORM_EXPR_FIELDS in rename-ident.js — keep both in sync.
    push(t.px); push(t.py);
  }
  return out;
}

// Resolve all parameter values, given that params can depend on other params.
// Returns { values: { name: number }, errors: { name: string } }
export function resolveParams(params, extraValues = null) {
  const values = extraValues ? { ...extraValues } : {};
  const errors = {};
  const remaining = new Set(Object.keys(params));
  let progress = true;
  let iters = 0;
  while (remaining.size > 0 && progress && iters < 100) {
    progress = false;
    iters++;
    for (const name of Array.from(remaining)) {
      const p = params[name];
      const expr = p.expr ?? String(p.value ?? 0);
      const idents = tokenizeIdents(expr).filter(i => i !== name);
      const allResolved = idents.every(i => i in values || !(i in params));
      if (!allResolved) continue;
      try {
        let s = expr;
        // Strip "um" unit suffixes that appear in HFSS-style expressions
        // (e.g., "0um", "(50um)"). In-app evaluation is in µm, so the suffix
        // is informational only and must be removed before arithmetic.
        s = s.replace(/(\d|\))\s*um\b/g, '$1');
        const keys = Object.keys(values).sort((a, b) => b.length - a.length);
        for (const k of keys) {
          const re = new RegExp(`\\b${k}\\b`, 'g');
          s = s.replace(re, `(${values[k]})`);
        }
        // Translate common math functions to their JS Math equivalents.
        for (const fn of MATH_FNS) {
          s = s.replace(new RegExp(`\\b${fn}\\s*\\(`, 'g'), `Math.${fn}(`);
        }
        // Single-pass replacement: chaining two .replace() calls would
        // let the second match the `PI` inside the `Math.PI` produced by
        // the first, turning `pi` into `Math.Math.PI` (which evaluates
        // to undefined). One regex with alternation is collision-proof.
        s = s.replace(/\b(?:pi|PI)\b/g, 'Math.PI');
        if (!/^[\d\s+\-*/.()A-Za-z,]+$/.test(s) && s.trim() !== '') {
          errors[name] = `Unresolved or invalid: ${s}`;
          remaining.delete(name);
          continue;
        }
        if (s.trim() === '') { values[name] = 0; remaining.delete(name); progress = true; continue; }
        // eslint-disable-next-line no-new-func
        const v = Function(`"use strict"; return (${s})`)();
        if (Number.isFinite(v)) {
          values[name] = v;
          remaining.delete(name);
          progress = true;
        } else {
          errors[name] = 'NaN/Infinity';
          remaining.delete(name);
        }
      } catch (e) {
        errors[name] = e.message;
        remaining.delete(name);
      }
    }
  }
  // Anything still remaining = circular or unresolvable
  for (const name of remaining) {
    errors[name] = 'circular or unresolvable';
    values[name] = 0;
  }
  return { values, errors };
}

// Evaluate an arbitrary expression (for shape dims, snap offsets) given
// resolved param values.
export function evalExpr(expr, paramValues) {
  if (typeof expr === 'number') return expr;
  if (typeof expr !== 'string' || !expr.trim()) return 0;
  const num = Number(expr);
  if (!Number.isNaN(num)) return num;
  try {
    let s = expr;
    // Strip "um" unit suffixes that may appear when expressions are shared
    // with the HFSS export path (where literals carry "um" for clarity at
    // sim time). In-app evaluation is always in µm, so the suffix is a
    // no-op. Match \d.um or )um — only directly after a number or ).
    s = s.replace(/(\d|\))\s*um\b/g, '$1');
    const keys = Object.keys(paramValues).sort((a, b) => b.length - a.length);
    for (const k of keys) {
      const re = new RegExp(`\\b${k}\\b`, 'g');
      s = s.replace(re, `(${paramValues[k]})`);
    }
    // Translate common math functions to their JS Math equivalents BEFORE the
    // safety check, so expressions like "abs(x)" or "tan(x)" resolve correctly.
    // Each known fn is rewritten to "Math.<fn>(...)". The safety regex then
    // permits ".", letters, and parentheses.
    for (const fn of MATH_FNS) {
      s = s.replace(new RegExp(`\\b${fn}\\s*\\(`, 'g'), `Math.${fn}(`);
    }
    // See note above the same line in resolveParams: chained .replace()
    // would let the second match the `PI` inside the `Math.PI` produced
    // by the first, garbling `pi` to `Math.Math.PI`.
    s = s.replace(/\b(?:pi|PI)\b/g, 'Math.PI');
    if (!/^[\d\s+\-*/.()A-Za-z,]+$/.test(s)) return 0;
    // eslint-disable-next-line no-new-func
    const v = Function(`"use strict"; return (${s})`)();
    return Number.isFinite(v) ? v : 0;
  } catch { return 0; }
}
