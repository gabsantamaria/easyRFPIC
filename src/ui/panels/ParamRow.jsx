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
import { RESERVED_IDENTS } from '../../scene/params.js';
import { HoverTooltip } from '../HoverTooltip.jsx';
import { ParamTuner } from './ParamTuner.jsx'; // EXPERIMENTAL — see ParamTuner.jsx for removal instructions
import { DeferredTextInput } from '../DeferredTextInput.jsx';

export function ParamRow({ name, p, onRename, onUpdateExpr, onCommitExpr, onUpdateUnit, onUpdateDesc, onUpdateSweep, onDelete, value, error, isUnused, isInvolved, autoFocus, onAutoFocusDone, suggestions }) {
  const [editingName, setEditingName] = useState(name);
  const [expanded, setExpanded] = useState(false);
  const inputRef = useRef(null);
  useEffect(() => { setEditingName(name); }, [name]);
  useEffect(() => {
    if (autoFocus && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
      onAutoFocusDone?.();
    }
  }, [autoFocus, onAutoFocusDone]);

  // Commit handler: update the param's stored expression, then run the
  // auto-create-missing-identifiers pass (which decides what default
  // value to use for any new param). Same pattern as before — we just
  // route both calls through DeferredTextInput's onCommit so we get
  // identifier-prefix autocomplete for free.
  const onExprCommit = (v) => {
    if (v !== (p.expr ?? '')) onUpdateExpr(v);
    onCommitExpr?.(v);
  };

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

  // HFSS Optimetrics sweep metadata for this param (optional object:
  // { enabled, start, stop, step } — values in the param's own unit).
  // Edits are committed through onUpdateSweep(sweepObjOrNull); passing
  // null drops the metadata entirely (never-configured sweep).
  const sweep = p.sweep || null;
  const sweepEnabled = !!(sweep && sweep.enabled);
  const patchSweep = (patch) => {
    const base = sweep || { enabled: false, start: '', stop: '', step: '' };
    onUpdateSweep?.({ ...base, ...patch });
  };
  const toggleSweep = (checked) => {
    if (!checked && sweep && !sweep.start && !sweep.stop && !sweep.step) {
      // Unchecking a never-filled sweep — drop the metadata.
      onUpdateSweep?.(null);
      return;
    }
    patchSweep({ enabled: checked });
  };
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
        {/* Hygiene warning: the param name shadows a built-in math
            function / constant / unit suffix (RESERVED_IDENTS). The
            evaluator resolves the built-in first, so expressions that
            call it break in confusing ways. */}
        {RESERVED_IDENTS.has(name) && (
          <span className="text-amber-400 shrink-0 cursor-help" title={`shadows built-in '${name}' — expressions like ${name}(x) will break`}>
            <AlertTriangle size={10} />
          </span>
        )}
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
        {sweepEnabled && (
          <span
            className="shrink-0 px-1 rounded text-[8px] font-mono font-bold bg-cyan-900/60 text-cyan-300 border border-cyan-700/60 cursor-help"
            title={`Sweeps ${sweep.start || '?'}→${sweep.stop || '?'} step ${sweep.step || '?'} ${p.unit || ''} in HFSS Optimetrics`.trim()}
          >
            swp
          </span>
        )}
        {/* Expression field with draft-then-commit semantics + optional
            identifier-prefix autocomplete (when the caller passes
            `suggestions`). DeferredTextInput auto-grows to a textarea on
            focus so long expressions stay fully visible without taking
            up vertical room on every other row. */}
        <div className="flex-1 min-w-0">
          <DeferredTextInput
            autoGrow
            value={p.expr ?? ''}
            onCommit={onExprCommit}
            suggestions={suggestions}
            className={`w-full bg-slate-900 border rounded text-[11px] font-mono outline-none whitespace-pre-wrap break-words leading-tight px-1.5 py-0.5 ${
              error ? 'border-red-500 text-red-300' : 'border-slate-700 text-white hover:border-slate-500 focus:border-cyan-400 focus:py-1'
            }`}
            spellCheck={false}
            title={exprTooltip}
          />
        </div>
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
      {/* EXPERIMENTAL — ± 20 % tuner. Remove this single line plus the
          ParamTuner import to drop the experiment. */}
      <ParamTuner value={value} onUpdateExpr={onUpdateExpr} />
      {expanded && (
        <>
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
          {/* HFSS Optimetrics sweep micro-row: enable + start/stop/step
              (values in this param's own unit). */}
          <div className="flex items-center gap-1 px-1.5 pb-1 pt-0">
            <label className="flex items-center gap-1 text-[10px] text-slate-400 cursor-pointer shrink-0" title="Sweep this parameter in HFSS Optimetrics">
              <input
                type="checkbox"
                checked={sweepEnabled}
                onChange={(e) => toggleSweep(e.target.checked)}
              />
              sweep
            </label>
            <input
              type="text"
              value={sweep?.start ?? ''}
              onChange={(e) => patchSweep({ start: e.target.value })}
              placeholder={`start${p.unit ? ' ' + p.unit : ''}`}
              disabled={!sweepEnabled}
              className="flex-1 min-w-0 bg-slate-900 border border-slate-700 rounded px-1 py-0 text-[10px] font-mono text-slate-300 outline-none focus:border-cyan-400 disabled:opacity-40"
            />
            <input
              type="text"
              value={sweep?.stop ?? ''}
              onChange={(e) => patchSweep({ stop: e.target.value })}
              placeholder={`stop${p.unit ? ' ' + p.unit : ''}`}
              disabled={!sweepEnabled}
              className="flex-1 min-w-0 bg-slate-900 border border-slate-700 rounded px-1 py-0 text-[10px] font-mono text-slate-300 outline-none focus:border-cyan-400 disabled:opacity-40"
            />
            <input
              type="text"
              value={sweep?.step ?? ''}
              onChange={(e) => patchSweep({ step: e.target.value })}
              placeholder={`step${p.unit ? ' ' + p.unit : ''}`}
              disabled={!sweepEnabled}
              className="flex-1 min-w-0 bg-slate-900 border border-slate-700 rounded px-1 py-0 text-[10px] font-mono text-slate-300 outline-none focus:border-cyan-400 disabled:opacity-40"
            />
          </div>
        </>
      )}
    </div>
  );
}
