// THE unified parametric-expression input field.
//
// Wraps DeferredTextInput (draft-then-commit: keystrokes edit a local
// draft; `onCommit` fires on Enter / blur; Escape reverts; optional
// identifier-prefix autocomplete via `suggestions`) with the canonical
// styling shared by every expression editor in the app.
//
// CANONICAL EXPRESSION-FIELD CONVENTION
// (dominant pattern surveyed from SnapConnectionRow.SnapAxisField,
// TransformChainEditor's field helper, and the Inspector's fieldRow,
// which this component unifies):
//
//   - mono font (`font-mono`) on a dark well (`bg-slate-900`), rounded
//     1px border, no outline.
//   - LITERAL / multi-term expression: white text, slate border, cyan
//     focus border (`border-slate-700 text-white focus:border-cyan-400`).
//   - SINGLE PARAM REFERENCE (the whole expression is one identifier
//     that resolves to a scene parameter): amber text + amber border
//     (`border-amber-700/60 text-amber-200 focus:border-amber-400`) —
//     the SnapAxisField convention. Amber signals "edits-by-reference":
//     changing the referenced parameter affects every expression that
//     uses it.
//   - ERROR (non-empty expression that doesn't evaluate to a finite
//     number): red border + red text (`border-red-500 text-red-300`)
//     with the failing expression named in the title tooltip — the
//     ParamRow convention.
//   - Optional tiny label above (uppercase tracked slate), and optional
//     resolved-value readout below in tiny slate mono ("= 12.00", em
//     dash when unresolvable).
//
// NO behavior beyond presentation lives here: commit semantics come
// from DeferredTextInput unchanged, and the caller's `onCommit` keeps
// full responsibility for scene updates and the auto-create-param
// (commitExpr) hooks.
import React from 'react';
import { evalExpr } from '../../scene/params.js';
import { DeferredTextInput } from '../DeferredTextInput.jsx';

// Size presets matching the three pre-unification call sites:
//   xs — snap dx/dy rows (SNAPS section of the Inspector)
//   sm — transform-chain rows
//   md — Inspector dimension fields (w/h/r/…)
const SIZES = {
  xs: { input: 'px-1 py-0.5 text-[10px]', label: 'text-[9px]' },
  sm: { input: 'px-1.5 py-0.5 text-[11px]', label: 'text-[9px]' },
  md: { input: 'px-2 py-1 text-xs', label: 'text-[10px]' },
};

// A "lone identifier" expression — letter/underscore start, then word
// chars. Same identifier shape as the params.js tokenizer.
const LONE_IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function ExprField({
  // Optional mini-label rendered above the input.
  label = null,
  // Current expression (string). Numbers are stringified.
  value,
  // (draft) => void — fired by DeferredTextInput on Enter/blur when the
  // draft differs from `value`. Caller owns updateComp/commitExpr.
  onCommit,
  // Resolved parameter values — used for the readout and error detection.
  paramValues = {},
  // Optional scene.params map. When given, single-identifier expressions
  // are flagged as param references against it; otherwise paramValues
  // keys are used as the fallback reference set.
  params = null,
  // Identifier-prefix autocomplete entries (DeferredTextInput popover).
  suggestions = null,
  size = 'md',
  // Formatter for the resolved readout value. Default: toFixed(2).
  fmt = null,
  // Hide the "= value" readout (e.g. snap rows render their own).
  showReadout = true,
  // Caller tooltip; an error message is prepended when the expression
  // doesn't evaluate.
  title = undefined,
  // Extra classes for the outer container / the input element.
  containerClassName = '',
  className = '',
  autoGrow = true,
  ...rest
}) {
  const str = String(value ?? '');
  const trimmed = str.trim();
  const isEmpty = trimmed === '';
  const loneIdent = LONE_IDENT_RE.test(trimmed) ? trimmed : null;
  const isParamRef = !!loneIdent && (
    params
      ? !!params[loneIdent]
      : Object.prototype.hasOwnProperty.call(paramValues || {}, loneIdent)
  );
  const resolved = isEmpty ? null : evalExpr(trimmed, paramValues || {});
  const isError = !isEmpty && !Number.isFinite(resolved);

  const colorCls = isError
    ? 'border-red-500 text-red-300 focus:border-red-400'
    : isParamRef
      ? 'border-amber-700/60 text-amber-200 focus:border-amber-400'
      : 'border-slate-700 text-slate-100 focus:border-cyan-400';

  const sz = SIZES[size] || SIZES.md;
  const effectiveTitle = isError
    ? `Expression does not evaluate to a number: "${trimmed}"${title ? '\n' + title : ''}`
    : (title !== undefined
      ? title
      : (isParamRef
        ? `References parameter "${loneIdent}" — editing that parameter affects every expression using it.`
        : undefined));

  return (
    <div className={`min-w-0 ${containerClassName}`}>
      {label != null && (
        <label className={`${sz.label} uppercase tracking-wider text-slate-500`}>{label}</label>
      )}
      <DeferredTextInput
        autoGrow={autoGrow}
        value={str}
        suggestions={suggestions}
        onCommit={onCommit}
        spellCheck={false}
        title={effectiveTitle}
        className={`w-full bg-slate-900 border rounded font-mono outline-none disabled:opacity-50 ${
          autoGrow ? 'whitespace-pre-wrap break-words leading-tight ' : ''
        }${sz.input} ${colorCls} ${className}`}
        {...rest}
      />
      {showReadout && (
        <p className="text-[9px] text-slate-500 mt-0.5 font-mono">
          = {Number.isFinite(resolved) ? (fmt ? fmt(resolved) : resolved.toFixed(2)) : '—'}
        </p>
      )}
    </div>
  );
}
