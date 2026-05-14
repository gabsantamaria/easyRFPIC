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
import React, { useState, useEffect, useRef } from 'react';

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
  const taRef = useRef(null);
  const [focused, setFocused] = useState(false);

  // Auto-grow: while focused, expand the textarea's height to fit content
  // (capped at 240px so very long expressions don't push the panel off
  // screen). Reset to a single-line height when unfocused.
  useEffect(() => {
    if (!autoGrow) return;
    const el = taRef.current;
    if (!el) return;
    if (focused) {
      el.style.height = 'auto';
      el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
    } else {
      el.style.height = '';
    }
  }, [autoGrow, focused, draft]);

  return (
    <Element
      {...rest}
      ref={autoGrow ? taRef : rest.ref}
      // For autoGrow, rows=1 so the textarea LOOKS like a single-line input
      // until focused. The effect above bumps height while focused.
      {...(autoGrow ? { rows: 1, style: { resize: 'none', ...(rest.style || {}) } } : {})}
      value={draft}
      onChange={(e) => {
        setDraft(e.target.value);
        onChangeProp?.(e);
      }}
      onFocus={(e) => {
        focusedRef.current = true;
        if (autoGrow) setFocused(true);
        onFocusProp?.(e);
      }}
      onBlur={(e) => {
        focusedRef.current = false;
        if (autoGrow) setFocused(false);
        commit(e);
        onBlurProp?.(e);
      }}
      onKeyDown={(e) => {
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
  );
}
