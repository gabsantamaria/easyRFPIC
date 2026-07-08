// Modal dialog replacement for window.confirm / window.prompt /
// window.alert. The browser modals are blocked inside cross-origin
// sandboxed iframes (artifacts viewers, embedded previews) where most
// of this app gets shown, so we render our own.
//
// `kind` is one of 'confirm' | 'prompt' | 'alert'. Backdrop click and
// Escape cancel; Enter confirms (returns the prompt's input string
// for kind='prompt', otherwise `true`).
//
// Extracted from PhotonicLayout.jsx as Stage 4.3 of the planned refactor.
import React, { useState, useRef, useEffect } from 'react';

export function ModalDialog({
  open, title, message, defaultValue, kind,
  onConfirm, onCancel,
  // Optional cosmetic overrides for the confirm button. `confirmLabel`
  // replaces the default OK / Confirm text; `confirmTone` switches
  // between the standard cyan accent and a destructive red — used for
  // delete-style confirmations where the action can't be undone.
  confirmLabel,
  confirmTone = 'default',
  // Optional cancel-button label — two-option choices (e.g. "Use imported
  // values" vs "Keep current values") read better than OK/Cancel.
  cancelLabel,
}) {
  // kind: 'confirm' | 'prompt' | 'alert'
  const [value, setValue] = useState(defaultValue || '');
  const inputRef = useRef(null);
  useEffect(() => { setValue(defaultValue || ''); }, [defaultValue, open]);
  useEffect(() => {
    if (open && kind === 'prompt' && inputRef.current) {
      setTimeout(() => { inputRef.current?.focus(); inputRef.current?.select(); }, 50);
    }
  }, [open, kind]);
  useEffect(() => {
    if (!open) return;
    // CAPTURE phase + stopPropagation: while the dialog is open, NO keydown
    // may reach the app's global handlers (Delete deleted canvas components
    // behind a confirm, Escape both cancelled the dialog AND cleared the
    // selection, Enter double-fired into the polyline-draft commit, ⌘Z/⌘D/
    // arrows all stayed live). The window-capture listener runs FIRST and
    // stopPropagation halts the event entirely (including React's delegated
    // handlers). Typing in the prompt input still works: character insertion
    // is the keydown's DEFAULT ACTION (surfaced via input/onChange events),
    // which stopPropagation does not cancel — only preventDefault would,
    // and we only preventDefault for Escape/Enter.
    const onKey = (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); onCancel?.(); }
      else if (e.key === 'Enter' && kind !== 'alert') {
        e.preventDefault();
        onConfirm?.(kind === 'prompt' ? value : true);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, kind, value, onConfirm, onCancel]);
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(2,6,23,0.7)' }}
      onClick={onCancel}
    >
      <div
        className="rounded-lg border border-slate-700 shadow-2xl w-96 max-w-[90vw]"
        style={{ background: '#0f172a' }}
        onClick={(e) => e.stopPropagation()}
      >
        {title && (
          <div className="px-4 py-2 border-b border-slate-700">
            <h3 className="text-sm font-medium text-slate-200">{title}</h3>
          </div>
        )}
        <div className="px-4 py-3 text-xs text-slate-300 whitespace-pre-wrap leading-relaxed">{message}</div>
        {kind === 'prompt' && (
          <div className="px-4 pb-2">
            <input
              ref={inputRef}
              type="text"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-sm font-mono text-cyan-300 outline-none focus:border-cyan-400"
            />
          </div>
        )}
        <div className="px-4 py-3 border-t border-slate-700 flex justify-end gap-2">
          {kind !== 'alert' && (
            <button onClick={onCancel} className="px-3 py-1 rounded text-xs border border-slate-600 text-slate-300 hover:bg-slate-800">
              {cancelLabel || 'Cancel'}
            </button>
          )}
          <button
            onClick={() => onConfirm?.(kind === 'prompt' ? value : true)}
            className="px-3 py-1 rounded text-xs font-medium"
            style={{
              background: confirmTone === 'danger' ? '#dc2626' : '#06b6d4',
              color: confirmTone === 'danger' ? '#fff' : '#0f172a',
            }}
          >
            {confirmLabel || (kind === 'alert' ? 'OK' : kind === 'prompt' ? 'OK' : 'Confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}
