// Generic dropdown menu used by the toolbar (workspace, file, export
// buttons, etc.). The trigger button takes an icon + label; each item is
// either a divider, or { label, icon, onClick, hint, title, disabled }.
//
// Closes on outside-mousedown via a doc-level listener installed only
// while the menu is open.
//
// Extracted from PhotonicLayout.jsx as Stage 4.2 of the planned refactor.
import React, { useState, useRef, useEffect } from 'react';

export function DropdownMenu({ label, icon: Icon, items, buttonClassName, buttonStyle, disabled, align = 'right' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        disabled={disabled}
        className={buttonClassName}
        style={buttonStyle}
      >
        {Icon ? <Icon size={11} /> : null} {label} <span className="text-[9px] opacity-60">▾</span>
      </button>
      {open && (
        <div
          className={`absolute z-50 mt-1 rounded border border-slate-700 shadow-xl py-1 min-w-[10rem] ${align === 'left' ? 'left-0' : 'right-0'}`}
          style={{ background: '#0f172a' }}
        >
          {items.map((it, i) => {
            if (it.divider) return <div key={i} className="my-1 border-t border-slate-700" />;
            const ItIcon = it.icon;
            return (
              <button
                key={i}
                onClick={() => { setOpen(false); it.onClick?.(); }}
                disabled={it.disabled}
                className="w-full text-left px-3 py-1.5 text-xs text-slate-200 hover:bg-slate-800 disabled:opacity-30 disabled:cursor-not-allowed flex items-center gap-2"
                title={it.title}
              >
                {ItIcon && <ItIcon size={11} className="flex-shrink-0" />}
                <span className="flex-1">{it.label}</span>
                {it.hint && <span className="text-[9px] text-slate-500">{it.hint}</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
