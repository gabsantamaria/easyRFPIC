// Text input with draft-then-commit semantics.
//
// Keystrokes update a local draft buffer; the parent's `onCommit(value)`
// only fires when the user presses Enter or moves focus away (programmatic
// blur included). Escape reverts the draft to the current prop value.
//
// Used for fields that drive geometry / scene-solve work — parameter
// expressions, component dimensions, snap offsets, layer thicknesses,
// transform offsets — so the canvas doesn't re-solve on every keystroke
// while the user is mid-edit.
//
// Pass-through of common props is identical to a native <input> /
// <textarea>. Caller-supplied onChange / onBlur / onKeyDown / onFocus
// are chained AFTER the built-in handlers (commit-on-blur, Enter-blurs,
// Escape-reverts). `as` selects the rendered element: 'input' (default)
// or 'textarea'.
//
// Optional `suggestions` enables identifier-prefix autocomplete: as the
// user types, the popover shows entries from `suggestions` whose prefix
// matches the alphanumeric token immediately before the cursor.
// ↑ / ↓ navigate, Tab / Enter inserts (replacing just that prefix),
// Escape closes the popover (without reverting the whole draft).
import React, { useState, useEffect, useRef, useMemo } from 'react';

// Regex matching a trailing identifier (letter / underscore start, then
// alphanumerics / underscores). HFSS-compatible identifier shape — same
// as src/scene/params.js tokenizer.
const IDENT_RE = /[A-Za-z_][A-Za-z0-9_]*$/;

export function DeferredTextInput({
  as = 'input',
  value,
  onCommit,
  onChange: onChangeProp,
  onFocus: onFocusProp,
  onBlur: onBlurProp,
  onKeyDown: onKeyDownProp,
  // Treat the prop value as a number rather than a string: parseFloat the
  // draft on commit (falling back to 0 for empty / NaN). Used for the
  // cx/cy numeric inputs.
  numeric = false,
  // Auto-grow: on focus, expand the box to fit content (single-line when
  // unfocused, multi-line wrap when active). Forces `as='textarea'` so the
  // element type doesn't swap mid-edit (which would remount and reset the
  // caret). Same UX as the expression field in the PARAMS panel.
  autoGrow = false,
  // Identifier-prefix autocomplete. Pass the workspace's parameter names
  // (or any string array) here and the input will surface a popover with
  // matches as the user types. Empty / unset disables the feature.
  suggestions = null,
  ...rest
}) {
  // The draft is the string the user is currently editing. We always hold
  // it as a string internally so partial edits like "1." don't immediately
  // round to "1".
  const initial = numeric ? String(value ?? '') : (value ?? '');
  const [draft, setDraft] = useState(initial);
  const focusedRef = useRef(false);

  // Sync the draft from props when the input isn't focused (so changes
  // from elsewhere — undo/redo, drag, sibling field commits — propagate).
  useEffect(() => {
    if (!focusedRef.current) {
      setDraft(numeric ? String(value ?? '') : (value ?? ''));
    }
  }, [value, numeric]);

  const propString = numeric ? String(value ?? '') : (value ?? '');
  const commit = (e) => {
    if (draft === propString) return;
    if (numeric) {
      const n = parseFloat(draft);
      onCommit(Number.isFinite(n) ? n : 0, e);
    } else {
      onCommit(draft, e);
    }
  };

  // autoGrow implies textarea so the element doesn't swap tag types on
  // focus (which would remount, dropping the caret position).
  const effectiveAs = autoGrow ? 'textarea' : as;
  const Element = effectiveAs === 'textarea' ? 'textarea' : 'input';
  const elRef = useRef(null);
  const [focused, setFocused] = useState(false);

  // Auto-grow: while focused, expand the textarea's height to fit content
  // (capped at 240px so very long expressions don't push the panel off
  // screen). Reset to a single-line height when unfocused.
  useEffect(() => {
    if (!autoGrow) return;
    const el = elRef.current;
    if (!el) return;
    if (focused) {
      el.style.height = 'auto';
      el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
    } else {
      el.style.height = '';
    }
  }, [autoGrow, focused, draft]);

  // ───── Autocomplete machinery ──────────────────────────────────────
  // `selStart` mirrors the input's caret. Updated on input + select
  // events; the popover is positioned + filtered using its value.
  const [selStart, setSelStart] = useState(null);
  // Open state separate from focus so Escape can close the popover
  // without blurring the input.
  const [acOpen, setAcOpen] = useState(false);
  // Highlighted index within the filtered suggestions list.
  const [acIdx, setAcIdx] = useState(0);
  const acEnabled = Array.isArray(suggestions) && suggestions.length > 0;

  // Identifier immediately before the caret (if any). Returns
  //   { prefix, start } where `start` is the index in `draft` where the
  //   identifier begins. Returns null if no identifier under caret.
  const activeIdent = useMemo(() => {
    if (!acEnabled || selStart == null) return null;
    const before = draft.slice(0, selStart);
    const m = before.match(IDENT_RE);
    if (!m) return null;
    return { prefix: m[0], start: selStart - m[0].length };
  }, [acEnabled, draft, selStart]);

  // Filtered + ranked candidates. Case-insensitive prefix match,
  // alphabetically sorted, capped at 10 entries to keep the popover
  // from running off-screen.
  const filtered = useMemo(() => {
    if (!acEnabled || !activeIdent) return [];
    const q = activeIdent.prefix.toLowerCase();
    const exact = [];
    const prefix = [];
    const contains = [];
    for (const name of suggestions) {
      if (typeof name !== 'string') continue;
      const lc = name.toLowerCase();
      if (lc === q) exact.push(name);
      else if (lc.startsWith(q)) prefix.push(name);
      else if (lc.includes(q)) contains.push(name);
    }
    return [...exact, ...prefix.sort(), ...contains.sort()].slice(0, 10);
  }, [acEnabled, suggestions, activeIdent]);

  // Open the popover whenever there's a real prefix to filter on AND at
  // least one match. Close otherwise. Reset the highlight on every
  // re-filter so the topmost candidate is always selected by default.
  useEffect(() => {
    if (focused && activeIdent && activeIdent.prefix.length > 0 && filtered.length > 0) {
      setAcOpen(true);
      setAcIdx(0);
    } else {
      setAcOpen(false);
    }
  }, [focused, activeIdent, filtered]);

  // Insert a chosen suggestion: replace the active identifier prefix with
  // the full name, then position the caret immediately after the inserted
  // text so the user can keep typing the rest of an expression.
  const insertSuggestion = (name) => {
    if (!activeIdent) return;
    const before = draft.slice(0, activeIdent.start);
    const after = draft.slice(selStart);
    const next = before + name + after;
    setDraft(next);
    setAcOpen(false);
    // Defer the selection update until after React re-renders the
    // input with the new value — otherwise setSelectionRange runs on
    // the old text and clobbers itself.
    const nextPos = activeIdent.start + name.length;
    requestAnimationFrame(() => {
      const el = elRef.current;
      if (!el) return;
      try {
        el.setSelectionRange(nextPos, nextPos);
        setSelStart(nextPos);
      } catch { /* not an input/textarea — ignore */ }
    });
  };

  // Track caret position so the active-identifier calculation stays in
  // sync. We update on input changes AND select events (covers arrow-key
  // navigation, click-to-position-caret, etc.).
  const syncCaret = (e) => {
    try { setSelStart(e.target.selectionStart); } catch { setSelStart(null); }
  };

  return (
    <span style={{ position: 'relative', display: 'inline-block', width: '100%' }}>
      <Element
        {...rest}
        ref={elRef}
        // For autoGrow, rows=1 so the textarea LOOKS like a single-line input
        // until focused. The effect above bumps height while focused.
        {...(autoGrow ? { rows: 1, style: { resize: 'none', ...(rest.style || {}) } } : {})}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          syncCaret(e);
          onChangeProp?.(e);
        }}
        onSelect={(e) => syncCaret(e)}
        onClick={(e) => syncCaret(e)}
        onFocus={(e) => {
          focusedRef.current = true;
          setFocused(true);
          syncCaret(e);
          onFocusProp?.(e);
        }}
        onBlur={(e) => {
          focusedRef.current = false;
          // Delay close so a click on a suggestion row registers before
          // the blur tears down the popover. The 120 ms is comfortable
          // for human click latency while still feeling snappy.
          setTimeout(() => setAcOpen(false), 120);
          if (autoGrow) setFocused(false);
          commit(e);
          onBlurProp?.(e);
        }}
        onKeyDown={(e) => {
          // Autocomplete keyboard handling takes priority when the
          // popover is open — Tab / Enter / Arrow / Escape go to the
          // popover. Otherwise fall through to commit/revert handling.
          if (acOpen && filtered.length > 0) {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setAcIdx((i) => (i + 1) % filtered.length);
              return;
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault();
              setAcIdx((i) => (i - 1 + filtered.length) % filtered.length);
              return;
            }
            if (e.key === 'Tab' || (e.key === 'Enter' && filtered[acIdx])) {
              e.preventDefault();
              insertSuggestion(filtered[acIdx]);
              return;
            }
            if (e.key === 'Escape') {
              // Close the popover without reverting the draft (matches
              // typical IDE behavior — Escape dismisses suggestions
              // first; a second Escape would then revert).
              e.preventDefault();
              setAcOpen(false);
              return;
            }
          }
          // For <textarea>, plain Enter inserts a newline; only commit on
          // Enter when Shift isn't held. For <input>, Enter always commits.
          const isTextarea = effectiveAs === 'textarea';
          if (e.key === 'Enter' && (!isTextarea || !e.shiftKey)) {
            e.preventDefault();
            e.target.blur();
          } else if (e.key === 'Escape') {
            setDraft(propString);
            e.target.blur();
          }
          onKeyDownProp?.(e);
        }}
      />
      {acOpen && filtered.length > 0 && (
        <ul
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            zIndex: 60,
            margin: 0,
            padding: 0,
            listStyle: 'none',
            minWidth: 140,
            maxWidth: 280,
            maxHeight: 200,
            overflowY: 'auto',
            background: '#0f172a',
            border: '1px solid #475569',
            borderRadius: 4,
            boxShadow: '0 6px 16px rgba(0,0,0,0.4)',
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            fontSize: 11,
          }}
          // mousedown (not click) so the suggestion lands BEFORE blur
          // closes the popover. Without this, the row's click event
          // would fire after the input had already blurred.
          onMouseDown={(e) => e.preventDefault()}
        >
          {filtered.map((name, i) => (
            <li
              key={name}
              onMouseDown={(e) => { e.preventDefault(); insertSuggestion(name); }}
              onMouseEnter={() => setAcIdx(i)}
              style={{
                padding: '3px 8px',
                cursor: 'pointer',
                background: i === acIdx ? '#155e75' : 'transparent',
                color: i === acIdx ? '#fff' : '#cbd5e1',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {name}
            </li>
          ))}
        </ul>
      )}
    </span>
  );
}
