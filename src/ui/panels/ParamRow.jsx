// One row inside the PARAMS panel. Edits a single parameter's name,
// expression, unit, and description; shows the resolved value and any
// evaluation error. The expression field auto-grows to a textarea on
// focus so long expressions stay fully visible.
//
// The row's container takes on visual treatments for two states:
//   - isUnused:    no expression references the parameter
//   - isInvolved:  the currently selected component's definition uses it
//
// Extracted from PhotonicLayout.jsx as Stage 4.5 of the planned refactor.
import React, { useState, useRef, useEffect } from 'react';
import { Trash2, AlertTriangle } from 'lucide-react';
import { HoverTooltip } from '../HoverTooltip.jsx';

export function ParamRow({ name, p, onRename, onUpdateExpr, onCommitExpr, onUpdateUnit, onUpdateDesc, onDelete, value, error, isUnused, isInvolved, autoFocus, onAutoFocusDone }) {
  const [editingName, setEditingName] = useState(name);
  const [expanded, setExpanded] = useState(false);
  const [exprFocused, setExprFocused] = useState(false);
  const inputRef = useRef(null);
  const exprTextareaRef = useRef(null);
  useEffect(() => { setEditingName(name); }, [name]);
  useEffect(() => {
    if (autoFocus && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
      onAutoFocusDone?.();
    }
  }, [autoFocus, onAutoFocusDone]);
  // Auto-grow the expression textarea while it's focused so the user can see
  // the full expression. Resets to single-line height when unfocused.
  useEffect(() => {
    const el = exprTextareaRef.current;
    if (!el || !exprFocused) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [exprFocused, p.expr]);

  // Visual treatment when this parameter is involved in the selected
  // component's definition: cyan border + faint cyan tint, so the row
  // stands out without competing too hard with hover/focus styles.
  const involvedClass = isInvolved && !isUnused ? 'border-cyan-500/70 ring-1 ring-cyan-500/30' : '';
  const involvedStyle = isInvolved && !isUnused ? { background: 'rgba(14,116,144,0.18)' } : undefined;
  const baseClass = isUnused
    ? 'border-amber-700/50 bg-amber-900/10'
    : (involvedClass || 'border-slate-700');
  const baseStyle = isUnused ? undefined : (involvedStyle || { background: '#1e293b' });

  // Tooltip on the parameter NAME: always show the full name (covers the
  // case where the input is too narrow for long identifiers like
  // "cap_sep_outer_signal_finger") plus any description.
  const nameTooltip = p.desc ? `${name}\n${p.desc}` : name;
  // Tooltip on the value/expr: error if any, otherwise resolved value + unit
  // and the full expression (in case the input truncates it visually).
  const exprTooltip = error
    ? error
    : `${name} = ${value?.toFixed?.(4) ?? value}${p.unit ? ' ' + p.unit : ''}\nexpr: ${p.expr}${p.desc ? '\n' + p.desc : ''}`;

  return (
    <div
      className={`rounded border ${baseClass}`}
      style={baseStyle}
      title={isUnused ? 'Unused — not referenced by any expression' : (isInvolved ? `Used by selected component\n${p.desc || ''}`.trim() : undefined)}
    >
      {/* Compact single row */}
      <div className="flex items-center gap-1 px-1.5 py-1">
        {isUnused && <span className="text-amber-500 text-[10px]" title="Unused">○</span>}
        <HoverTooltip text={nameTooltip}>
          <input
            ref={inputRef}
            value={editingName}
            onChange={(e) => setEditingName(e.target.value)}
            onBlur={() => { if (editingName !== name) onRename(name, editingName); }}
            onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); }}
            className="bg-transparent text-[11px] font-mono font-bold text-cyan-300 w-20 min-w-0 outline-none focus:text-cyan-100"
            spellCheck={false}
          />
        </HoverTooltip>
        {/* Expression field: collapsed = single-line input; focused = grown
            textarea spanning the full width on a row beneath the name/value,
            so long expressions are fully visible and editable. */}
        {exprFocused ? (
          <div className="flex-1 min-w-0 relative">
            <textarea
              ref={exprTextareaRef}
              value={p.expr}
              autoFocus
              onChange={(e) => onUpdateExpr(e.target.value)}
              onBlur={(e) => { onCommitExpr && onCommitExpr(e.target.value); setExprFocused(false); }}
              onKeyDown={(e) => {
                // Enter commits and exits (unless Shift held — newline).
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.target.blur(); }
                if (e.key === 'Escape') { e.target.blur(); }
              }}
              className={`w-full bg-slate-900 border rounded px-1.5 py-1 text-[11px] font-mono outline-none resize-none whitespace-pre-wrap break-words ${error ? 'border-red-500 text-red-300' : 'border-cyan-400 text-white'}`}
              spellCheck={false}
              rows={1}
              title={exprTooltip}
            />
          </div>
        ) : (
          <input
            value={p.expr}
            readOnly
            onFocus={() => setExprFocused(true)}
            onMouseDown={(e) => { e.preventDefault(); setExprFocused(true); }}
            className={`flex-1 min-w-0 bg-slate-900 border rounded px-1.5 py-0.5 text-[11px] font-mono outline-none cursor-text ${error ? 'border-red-500 text-red-300' : 'border-slate-700 text-white hover:border-slate-500'}`}
            spellCheck={false}
            title={exprTooltip}
          />
        )}
        <span className="text-[9px] text-slate-500 font-mono w-14 text-right truncate" title={error || ''}>
          {error ? <AlertTriangle size={10} className="text-red-400 inline" /> : `${value?.toFixed?.(2) ?? value}${p.unit ? p.unit : ''}`}
        </span>
        <button
          onClick={() => setExpanded(e => !e)}
          className={`text-slate-500 hover:text-cyan-400 text-[10px] ${expanded ? 'text-cyan-400' : ''}`}
          title="Show description / unit"
        >
          {expanded ? '−' : '…'}
        </button>
        <button onClick={onDelete} className="text-slate-600 hover:text-red-400"><Trash2 size={10} /></button>
      </div>
      {expanded && (
        <div className="flex items-center gap-1 px-1.5 pb-1 pt-0">
          <input
            value={p.unit || ''}
            onChange={(e) => onUpdateUnit(e.target.value)}
            className="bg-slate-900 border border-slate-700 rounded px-1 py-0 text-[10px] text-slate-400 w-12 text-center outline-none"
            placeholder="unit"
          />
          <input
            type="text" placeholder="description"
            value={p.desc || ''}
            onChange={(e) => onUpdateDesc(e.target.value)}
            className="flex-1 bg-slate-900 border border-slate-700 rounded px-1.5 py-0 text-[10px] text-slate-300 outline-none focus:border-cyan-400"
            title={p.desc || ''}
          />
        </div>
      )}
    </div>
  );
}
