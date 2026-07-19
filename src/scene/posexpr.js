// Parametric root positions (cxExpr / cyExpr) vs direct manipulation.
//
// The solver re-applies a root's cxExpr/cyExpr on EVERY solve, so a plain
// numeric drag used to be overwritten on the next solve — an expression-
// positioned assembly (e.g. the double-Y balun, whose 30 pieces are all
// trig functions of dyb2_jx/jy) was completely immovable by mouse. The
// fix: a drag/nudge on an ACTIVE posExpr root FOLDS the translation into
// the expression itself — "jx + (L)*cos(60*pi/180)" dragged 25 µm right
// becomes "jx + (L)*cos(60*pi/180) + 25" — so the part lands where it
// was dropped AND stays fully parametric (param edits still move it, and
// the HFSS export keeps the whole expression live; the exporter um-types
// the folded bare constant via umTagBareTerms).
//
// Consecutive drags stay tidy: a depth-0 TRAILING numeric constant is
// MERGED (25 then -25 returns to the pristine expression, constant term
// dropped entirely), so drag residue never accumulates.

import { evalExpr } from './params.js';
import { expandTransforms } from './transforms.js';

// Is the component's posExpr pair actually APPLIED by the solver?
// Mirrors solveLayout's gate exactly: non-boolean, at least one non-empty
// expr, and NOT the `to` of any snap (the snap wins; exprs are ignored)
// — EXCEPT the GROUP-RIGID child: a snapped group member whose transform
// chain MOVES its instance-0 base (and whose snap parent is OUTSIDE the
// group) has its posExpr applied by the solver as its intra-group
// NATURAL pose. A group drag must therefore fold the child's exprs like
// every other member's — skipping it folded 29 naturals but not the
// child's, permanently deforming the assembly (real user bug). The rigid
// probe needs the component pool + params; callers that can't supply
// them keep the legacy inert answer.
export function isPosExprActive(comp, snaps, components = null, paramValues = null) {
  if (!comp || comp.kind === 'boolean') return false;
  const has = (f) => typeof comp[f] === 'string' && comp[f].trim() !== '';
  if (!has('cxExpr') && !has('cyExpr')) return false;
  const snap = (snaps || []).find(s => s && s.to && s.to.compId === comp.id);
  if (!snap) return true;
  // Snapped: active only for the group-rigid child (solver twin gate).
  if (!comp.group || !components || !paramValues) return false;
  const parent = components.find(c => c && c.id === snap.from.compId);
  if (parent && parent.group === comp.group) return false;
  if (!(comp.transforms || []).some(t => t && t.enabled !== false)) return false;
  const w = typeof comp.w === 'number' ? comp.w : evalExpr(comp.w, paramValues);
  const h = typeof comp.h === 'number' ? comp.h : evalExpr(comp.h, paramValues);
  const insts = expandTransforms([{
    ...comp,
    w: Number.isFinite(w) ? w : 0,
    h: Number.isFinite(h) ? h : 0,
  }], paramValues, components);
  const i0 = insts.find(i => i.idx === 0);
  if (!i0 || !Number.isFinite(i0.cx) || !Number.isFinite(i0.cy)) return false;
  return Math.abs(i0.cx - comp.cx) > 1e-9 || Math.abs(i0.cy - comp.cy) > 1e-9;
}

// Fold a numeric translation into a position expression. Merges into an
// existing depth-0 trailing plain-decimal constant when present (keeping
// one tidy term instead of accumulating "+ 5 + 3 - 2"), else appends.
// The sci-notation exponent sign and anything inside parens/function args
// are never treated as term boundaries. Deltas are rounded to 4 decimals
// (mouse/grid precision); a merge that cancels to zero drops the term.
export function foldPosExprDelta(expr, delta) {
  const s = String(expr ?? '').trim();
  if (!s || !Number.isFinite(delta)) return expr;
  const d4 = Number(delta.toFixed(4));
  if (d4 === 0) return expr;
  // Locate the LAST depth-0 binary +/- (operand before it, not an
  // exponent sign) — its tail is the merge candidate.
  let depth = 0, lastOp = -1;
  for (let i = 1; i < s.length; i++) {
    const ch = s[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if ((ch === '+' || ch === '-') && depth === 0) {
      const prev = s.slice(0, i).trimEnd();
      const last = prev[prev.length - 1];
      if (last && /[\w)]/.test(last) && !/\d[eE]$/.test(prev)) lastOp = i;
    }
  }
  if (lastOp > 0) {
    const tail = s.slice(lastOp + 1).trim();
    if (/^\d+(?:\.\d+)?$/.test(tail)) {
      const sign = s[lastOp] === '-' ? -1 : 1;
      const merged = Number((sign * parseFloat(tail) + d4).toFixed(4));
      const head = s.slice(0, lastOp).trimEnd();
      if (merged === 0) return head;
      return `${head} ${merged < 0 ? '-' : '+'} ${Math.abs(merged)}`;
    }
  }
  return `${s} ${d4 < 0 ? '-' : '+'} ${Math.abs(d4)}`;
}

// Translate one component by (dx, dy) the posExpr-aware way: numeric
// cx/cy always move (drag preview + non-expr comps); an ACTIVE expr on an
// axis is folded so the solver lands the part exactly where it was
// dropped. `base` supplies the pre-gesture values (drag-start snapshot —
// re-folding from the ORIGINAL expr each frame keeps live dragging
// idempotent); pass the component itself for one-shot moves (nudge).
export function translateWithPosExprs(comp, base, dx, dy, active) {
  const out = { ...comp, cx: base.cx + dx, cy: base.cy + dy };
  if (active) {
    if (typeof base.cxExpr === 'string' && base.cxExpr.trim() !== '') {
      out.cxExpr = foldPosExprDelta(base.cxExpr, dx);
    }
    if (typeof base.cyExpr === 'string' && base.cyExpr.trim() !== '') {
      out.cyExpr = foldPosExprDelta(base.cyExpr, dy);
    }
  }
  return out;
}
