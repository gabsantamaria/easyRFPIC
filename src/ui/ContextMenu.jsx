// Floating right-click context menu.
//
// Position is in client (viewport) pixels. The menu clamps itself to the
// viewport so it doesn't get clipped when triggered near an edge. Closes
// on Escape, on outside mousedown, or after any item is invoked.
//
// `items` is an array of either { divider: true } or
//   { label, icon, onClick, hint, title, disabled }
// — same shape used by the toolbar DropdownMenu.
import React, { useEffect, useRef, useLayoutEffect, useState } from 'react';

export function ContextMenu({ x, y, items, onClose }) {
  const ref = useRef(null);
  // Clamp into viewport. We render first at the requested (x, y), then
  // measure on the layout effect and shift left/up if needed.
  const [pos, setPos] = useState({ left: x, top: y });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const margin = 4;
    let left = x;
    let top = y;
    if (left + rect.width + margin > vw) left = Math.max(margin, vw - rect.width - margin);
    if (top + rect.height + margin > vh) top = Math.max(margin, vh - rect.height - margin);
    setPos({ left, top });
  }, [x, y]);

  useEffect(() => {
    const onDoc = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    };
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    // mousedown rather than click so the menu closes BEFORE the new
    // mousedown's default actions fire (otherwise opening a second
    // context menu on a different element would race with the close).
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="fixed z-50 rounded border border-slate-700 shadow-xl py-1 min-w-[10rem]"
      style={{ left: pos.left, top: pos.top, background: '#0f172a' }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((it, i) => {
        if (it.divider) return <div key={i} className="my-1 border-t border-slate-700" />;
        const Icon = it.icon;
        return (
          <button
            key={i}
            disabled={it.disabled}
            onClick={() => { onClose(); it.onClick?.(); }}
            className="w-full text-left px-3 py-1.5 text-xs text-slate-200 hover:bg-slate-800 disabled:opacity-30 disabled:cursor-not-allowed flex items-center gap-2"
            title={it.title}
          >
            {Icon && <Icon size={11} className="flex-shrink-0" />}
            <span className="flex-1">{it.label}</span>
            {it.hint && <span className="text-[9px] text-slate-500">{it.hint}</span>}
          </button>
        );
      })}
    </div>
  );
}
