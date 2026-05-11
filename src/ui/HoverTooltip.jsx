// Hover tooltip with 350ms delay. Used by inspector and panel labels
// that have explanatory copy too long for an inline label.
//
// Extracted from PhotonicLayout.jsx as Stage 4.1 of the planned refactor.
import React, { useState, useRef } from 'react';

export function HoverTooltip({ text, children, side = 'bottom' }) {
  const [show, setShow] = useState(false);
  const timerRef = useRef(null);
  if (!text) return children;
  const onEnter = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setShow(true), 350);
  };
  const onLeave = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    setShow(false);
  };
  return (
    <span
      className="relative inline-flex items-center"
      style={{ minWidth: 0 }}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      {children}
      {show && (
        <span
          className="absolute z-50 pointer-events-none rounded px-2 py-1 text-[11px] font-mono whitespace-pre-wrap break-words shadow-lg border"
          style={{
            background: '#0f172a',
            color: '#e2e8f0',
            borderColor: '#475569',
            maxWidth: '320px',
            ...(side === 'bottom' ? { top: '100%', left: '0', marginTop: '4px' } : { bottom: '100%', left: '0', marginBottom: '4px' }),
          }}
        >
          {text}
        </span>
      )}
    </span>
  );
}
