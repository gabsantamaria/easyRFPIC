// Inspector "Connections" section — one row per incoming/outgoing snap,
// with inline editors for the dx/dy offsets.
//
// SnapAxisField is the dx- or dy-input. If the field's expression is a
// single parameter reference, the row offers an inline editor for that
// parameter (so changes propagate to all snaps sharing it). Otherwise it
// offers a "promote" button that creates a new parameter holding the
// current literal value.
//
// SnapConnectionRow is the per-snap container that arranges the anchor
// label, both axis fields, and a break-snap button.
//
// Extracted from PhotonicLayout.jsx as Stage 4.6 of the planned refactor.
import React, { useState } from 'react';
import { Link2Off } from 'lucide-react';
import { evalExpr } from '../../scene/params.js';

export function SnapAxisField({ axis, exprValue, params, paramValues, onUpdateSnap, onUpdateParam, onPromote, commitExpr }) {
  // Detect if exprValue is a single parameter reference
  const isParamRef = typeof exprValue === 'string' && /^[A-Za-z_][\w]*$/.test(exprValue.trim()) && !!params[exprValue.trim()];
  const paramName = isParamRef ? exprValue.trim() : null;

  // Two edit buffers: one for the snap field, one for the bound parameter (when expanded)
  const [snapEdit, setSnapEdit] = useState(null);
  const [paramEditing, setParamEditing] = useState(false);
  const [paramEdit, setParamEdit] = useState(null);

  const snapDisplay = snapEdit !== null ? snapEdit : (exprValue ?? '0');
  const paramDisplay = paramEdit !== null ? paramEdit : (isParamRef ? params[paramName].expr : '');
  const computedValue = evalExpr(exprValue, paramValues);

  const commitSnap = () => {
    if (snapEdit === null) return;
    onUpdateSnap({ [axis]: snapEdit });
    if (commitExpr) commitExpr(snapEdit, '0', 'µm', `Auto-created (snap ${axis})`);
    setSnapEdit(null);
  };

  const commitParam = () => {
    if (paramEdit === null || !isParamRef) return;
    onUpdateParam(paramName, paramEdit);
    if (commitExpr) commitExpr(paramEdit, '0', 'µm', `Auto-created (used by ${paramName})`, paramName);
    setParamEdit(null);
  };

  return (
    <div>
      <div className="flex items-center gap-1">
        <span className="text-[9px] text-slate-500 w-3">{axis}</span>
        <input
          value={snapDisplay}
          onChange={(e) => setSnapEdit(e.target.value)}
          onBlur={commitSnap}
          onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); if (e.key === 'Escape') { setSnapEdit(null); e.target.blur(); } }}
          className={`flex-1 min-w-0 bg-slate-900 border rounded px-1 py-0.5 text-[10px] font-mono outline-none ${isParamRef ? 'border-amber-700/60 text-amber-200 focus:border-amber-400' : 'border-slate-700 text-white focus:border-cyan-400'}`}
          title={isParamRef
            ? `References parameter "${paramName}". Type a literal (e.g. 0.5) or another expression to override.`
            : 'Literal/expression — only this snap is affected. Click ⇪ to promote to a new parameter.'}
          spellCheck={false}
        />
        {isParamRef ? (
          <button
            onClick={() => { setParamEditing(v => !v); setParamEdit(null); }}
            className={`text-[9px] w-3 text-center ${paramEditing ? 'text-amber-300' : 'text-amber-500 hover:text-amber-300'}`}
            title={`Edit parameter "${paramName}" inline`}
          >
            {paramName.startsWith('gap_') ? '◆' : '⚙'}
          </button>
        ) : (
          <button
            onClick={onPromote}
            className="text-[9px] text-slate-500 hover:text-amber-400 w-3 text-center"
            title="Promote to a new parameter"
          >
            ⇪
          </button>
        )}
        <span className="text-[9px] text-slate-500 font-mono w-12 text-right truncate" title="resolved value">
          ={Number.isFinite(computedValue) ? computedValue.toFixed(2) : '?'}
        </span>
      </div>
      {/* Inline parameter editor — only visible when bound and expanded */}
      {isParamRef && paramEditing && (
        <div className="flex items-center gap-1 mt-0.5 ml-4">
          <span className="text-[9px] text-amber-500 font-mono">{paramName} =</span>
          <input
            value={paramDisplay}
            onChange={(e) => setParamEdit(e.target.value)}
            onBlur={commitParam}
            onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); if (e.key === 'Escape') { setParamEdit(null); e.target.blur(); } }}
            className="flex-1 min-w-0 bg-slate-900 border border-amber-700/60 rounded px-1 py-0.5 text-[10px] font-mono text-amber-200 outline-none focus:border-amber-400"
            title="Editing this changes the parameter — affects all snaps and components using it"
            spellCheck={false}
          />
        </div>
      )}
    </div>
  );
}

export function SnapConnectionRow({ snap, direction, params, paramValues, onSelectOther, onUpdateSnap, onUpdateParam, onPromoteAxis, onDeleteSnap, commitExpr, onFlashAnchor }) {
  const otherId = direction === 'incoming' ? snap.from.compId : snap.to.compId;
  const arrow = direction === 'incoming' ? '←' : '→';
  // C10: clicking an anchor label flashes that anchor on the canvas.
  // Optional — when the parent doesn't wire onFlashAnchor the labels
  // render as the old plain text.
  const anchorLabel = (compId, anchor) => onFlashAnchor ? (
    <button
      onClick={() => onFlashAnchor(compId, anchor)}
      className="hover:text-cyan-300 hover:underline"
      title="Flash this anchor on the canvas"
    >{anchor}</button>
  ) : anchor;
  return (
    <div className="border border-slate-800 rounded mt-1 mb-1.5 p-1.5" style={{ background: 'rgba(15,23,42,0.5)' }}>
      <div className="flex items-center gap-1 text-[10px] mb-1">
        <span className="text-cyan-400">{arrow}</span>
        <button onClick={() => onSelectOther(otherId)} className="font-mono text-cyan-300 hover:text-cyan-100 truncate">{otherId}</button>
        <span className="text-slate-500 truncate">
          .{anchorLabel(snap.from.compId, snap.from.anchor)}→{anchorLabel(snap.to.compId, snap.to.anchor)}
        </span>
        <button onClick={onDeleteSnap} className="ml-auto text-slate-600 hover:text-red-400" title="break snap"><Link2Off size={10} /></button>
      </div>
      <div className="space-y-0.5">
        <SnapAxisField axis="dx" exprValue={snap.dx} params={params} paramValues={paramValues} onUpdateSnap={onUpdateSnap} onUpdateParam={onUpdateParam} onPromote={() => onPromoteAxis('dx')} commitExpr={commitExpr} />
        <SnapAxisField axis="dy" exprValue={snap.dy} params={params} paramValues={paramValues} onUpdateSnap={onUpdateSnap} onUpdateParam={onUpdateParam} onPromote={() => onPromoteAxis('dy')} commitExpr={commitExpr} />
      </div>
    </div>
  );
}
