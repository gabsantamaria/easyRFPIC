// Per-component transform chain editor used inside the Inspector.
//
// `TransformRow` is a single row in the chain: displays the transform's
// kind-specific fields (displace dx/dy, rotate angle/pivot, repeat
// N/dx/dy/includeOriginal), a suppress toggle, reorder controls, and
// delete. Expression fields use commitExpr so typing a free identifier
// auto-creates the matching parameter — same pattern as snap dx/dy and
// component w/h.
//
// `TransformChainEditor` is the panel-level container with add buttons
// for each kind plus the list of rows.
//
// Extracted from PhotonicLayout.jsx as Stage 4.7 of the planned refactor.
import React from 'react';
import { Move, RotateCw, Repeat, Trash2, Eye, EyeOff, ArrowUp, ArrowDown } from 'lucide-react';
import { evalExpr } from '../../scene/params.js';
import { DeferredTextInput } from '../DeferredTextInput.jsx';

function TransformRow({
  transform, idx, total,
  onUpdate, onToggle, onMoveUp, onMoveDown, onDelete,
  paramValues, commitExpr,
}) {
  const t = transform;
  const enabled = t.enabled !== false;
  // Field renderer: a single labeled expression input. Mirrors the pattern
  // used elsewhere (component w/h, snap dx/dy) so commitExpr auto-creates
  // any missing identifiers.
  const ExprField = ({ label, value, onChange, fieldKey }) => (
    <div className="flex-1 min-w-0">
      <label className="text-[9px] uppercase tracking-wider text-slate-500">{label}</label>
      <DeferredTextInput
        value={value ?? ''}
        onCommit={(v) => {
          onChange(v);
          commitExpr && commitExpr(v, '0', 'µm', `Auto-created (transform.${fieldKey})`);
        }}
        className="w-full bg-slate-900 border border-slate-700 rounded px-1.5 py-0.5 text-[11px] font-mono text-white outline-none focus:border-cyan-400"
        spellCheck={false}
      />
      <p className="text-[9px] text-slate-500 mt-0.5 font-mono">= {(() => {
        const v = evalExpr(value, paramValues);
        return Number.isFinite(v) ? v.toFixed(3) : 'NaN';
      })()}</p>
    </div>
  );
  // Style the row dimmer when disabled so it's visually clear it's not in the chain.
  const dimClass = enabled ? '' : 'opacity-50';
  // Pick a kind-specific accent color
  const kindColor = t.kind === 'displace' ? '#0ea5e9'
    : t.kind === 'rotate' ? '#a855f7'
    : t.kind === 'repeat' ? '#22c55e'
    : '#94a3b8';
  return (
    <div className={`rounded border p-1.5 mb-1 ${dimClass}`} style={{ borderColor: kindColor + '60', background: 'rgba(15,23,42,0.4)' }}>
      <div className="flex items-center gap-1 mb-1">
        <span className="text-[9px] font-bold uppercase tracking-wider" style={{ color: kindColor }}>
          {idx + 1}. {t.kind}
        </span>
        <span className="flex-1" />
        <button
          onClick={() => onToggle()}
          className={`px-1 py-0 rounded ${enabled ? 'text-emerald-400 hover:text-emerald-300' : 'text-slate-500 hover:text-slate-300'}`}
          title={enabled ? 'Suppress this transform (toggle off)' : 'Re-enable this transform'}
        >
          {enabled ? <Eye size={11} /> : <EyeOff size={11} />}
        </button>
        <button onClick={() => onMoveUp()} disabled={idx === 0} className="px-1 py-0 text-slate-500 hover:text-cyan-300 disabled:opacity-20" title="Move up (apply earlier)">
          <ArrowUp size={10} />
        </button>
        <button onClick={() => onMoveDown()} disabled={idx === total - 1} className="px-1 py-0 text-slate-500 hover:text-cyan-300 disabled:opacity-20" title="Move down (apply later)">
          <ArrowDown size={10} />
        </button>
        <button onClick={() => onDelete()} className="px-1 py-0 text-slate-500 hover:text-red-400" title="Remove this transform">
          <Trash2 size={10} />
        </button>
      </div>
      {/* Per-kind fields */}
      {t.kind === 'displace' && (
        <div className="flex gap-1.5">
          <ExprField label="dx" value={t.dx} onChange={(v) => onUpdate({ dx: v })} fieldKey="dx" />
          <ExprField label="dy" value={t.dy} onChange={(v) => onUpdate({ dy: v })} fieldKey="dy" />
        </div>
      )}
      {t.kind === 'rotate' && (
        <div className="flex gap-1.5">
          <ExprField label="angle (deg)" value={t.angle} onChange={(v) => onUpdate({ angle: v })} fieldKey="angle" />
          <div className="flex-1 min-w-0">
            <label className="text-[9px] uppercase tracking-wider text-slate-500">pivot</label>
            <select
              value={t.pivot || 'C'}
              onChange={(e) => onUpdate({ pivot: e.target.value })}
              className="w-full bg-slate-900 border border-slate-700 rounded px-1 py-0.5 text-[11px] font-mono text-white outline-none focus:border-cyan-400"
            >
              <option value="C">C (center)</option>
              <option value="N">N</option>
              <option value="S">S</option>
              <option value="E">E</option>
              <option value="W">W</option>
              <option value="NE">NE</option>
              <option value="NW">NW</option>
              <option value="SE">SE</option>
              <option value="SW">SW</option>
              <option value="origin">world origin</option>
            </select>
            <p className="text-[9px] text-slate-500 mt-0.5">about this point</p>
          </div>
        </div>
      )}
      {t.kind === 'repeat' && (
        <div className="space-y-1">
          <div className="flex gap-1.5">
            <ExprField label="N copies" value={t.n} onChange={(v) => onUpdate({ n: v })} fieldKey="n" />
            <ExprField label="dx" value={t.dx} onChange={(v) => onUpdate({ dx: v })} fieldKey="dx" />
            <ExprField label="dy" value={t.dy} onChange={(v) => onUpdate({ dy: v })} fieldKey="dy" />
          </div>
          <label className="flex items-center gap-1 text-[10px] text-slate-400">
            <input type="checkbox" checked={t.includeOriginal !== false} onChange={(e) => onUpdate({ includeOriginal: e.target.checked })} />
            keep the original (uncheck for "shift only")
          </label>
        </div>
      )}
    </div>
  );
}

export function TransformChainEditor({ component, onUpdateComp, paramValues, commitExpr }) {
  const transforms = component.transforms || [];
  const setTransforms = (next) => onUpdateComp({ transforms: next });
  const addTransform = (kind) => {
    const id = `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    let t;
    if (kind === 'displace') t = { id, kind, enabled: true, dx: '0', dy: '0' };
    else if (kind === 'rotate') t = { id, kind, enabled: true, angle: '0', pivot: 'C' };
    else if (kind === 'repeat') t = { id, kind, enabled: true, n: '1', dx: '0', dy: '0', includeOriginal: true };
    setTransforms([...transforms, t]);
  };
  const updateTransform = (idx, patch) => {
    setTransforms(transforms.map((t, i) => i === idx ? { ...t, ...patch } : t));
  };
  const moveTransform = (idx, dir) => {
    const j = idx + dir;
    if (j < 0 || j >= transforms.length) return;
    const next = transforms.slice();
    [next[idx], next[j]] = [next[j], next[idx]];
    setTransforms(next);
  };
  const deleteTransform = (idx) => {
    setTransforms(transforms.filter((_, i) => i !== idx));
  };
  return (
    <div className="border-t border-slate-700 pt-3">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[10px] uppercase tracking-wider text-slate-500">Transforms ({transforms.length})</span>
        <div className="flex items-center gap-1">
          <button
            onClick={() => addTransform('displace')}
            className="flex items-center gap-1 px-1.5 py-0.5 rounded border border-slate-600 hover:border-sky-400 text-[10px] text-slate-300 hover:text-sky-300"
            title="Add a displacement transform: shifts the rectangle by (dx, dy)."
          >
            <Move size={10} /> displace
          </button>
          <button
            onClick={() => addTransform('rotate')}
            className="flex items-center gap-1 px-1.5 py-0.5 rounded border border-slate-600 hover:border-violet-400 text-[10px] text-slate-300 hover:text-violet-300"
            title="Add a rotation transform: rotates the rectangle by `angle` degrees about a chosen pivot."
          >
            <RotateCw size={10} /> rotate
          </button>
          <button
            onClick={() => addTransform('repeat')}
            className="flex items-center gap-1 px-1.5 py-0.5 rounded border border-slate-600 hover:border-emerald-400 text-[10px] text-slate-300 hover:text-emerald-300"
            title="Add a repeat-and-union transform: emits N copies along the (dx, dy) vector. The result is N+1 rectangles when 'keep the original' is on."
          >
            <Repeat size={10} /> repeat
          </button>
        </div>
      </div>
      {transforms.length === 0 ? (
        <p className="text-[10px] text-slate-500 italic">No transforms applied. Add one above to displace, rotate, or repeat this rectangle. Transforms apply in order; toggle the eye icon to suppress one without losing its parameters.</p>
      ) : (
        <div>
          {transforms.map((t, i) => (
            <TransformRow
              key={t.id || i}
              transform={t}
              idx={i}
              total={transforms.length}
              onUpdate={(patch) => updateTransform(i, patch)}
              onToggle={() => updateTransform(i, { enabled: t.enabled === false })}
              onMoveUp={() => moveTransform(i, -1)}
              onMoveDown={() => moveTransform(i, +1)}
              onDelete={() => deleteTransform(i)}
              paramValues={paramValues}
              commitExpr={commitExpr}
            />
          ))}
        </div>
      )}
    </div>
  );
}
