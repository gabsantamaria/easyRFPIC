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
import React, { useEffect, useState } from 'react';
import { Move, RotateCw, Repeat, Trash2, Eye, EyeOff, ArrowUp, ArrowDown, FlipHorizontal, FlipVertical, Copy, GripVertical } from 'lucide-react';
import { evalExpr } from '../../scene/params.js';
import { ExprField as ExprFieldBase } from './ExprField.jsx';

// One labeled expression input — the shared ExprField (canonical mono /
// amber-param-ref / red-error styling) plus this editor's commit hook:
// newly-auto-created identifiers default to the field's current
// evaluated value, so renaming a literal `5` to a new var `my_pitch`
// produces `my_pitch = 5` and the visible geometry doesn't jump.
// Hoisted to a module-level component so React keeps the same input
// identity across TransformRow re-renders — defining it inside
// TransformRow's body created a fresh function each render, which
// caused remounts that could wipe the deferred-commit draft mid-type.
function ExprField({ label, value, onChange, fieldKey, paramValues, commitExpr, suggestions }) {
  return (
    <ExprFieldBase
      label={label}
      value={value ?? ''}
      size="sm"
      containerClassName="flex-1"
      paramValues={paramValues}
      suggestions={suggestions}
      fmt={(v) => v.toFixed(3)}
      onCommit={(v) => {
        const prevEval = evalExpr(value, paramValues);
        const prevDefault = Number.isFinite(prevEval) ? String(prevEval) : '0';
        onChange(v);
        commitExpr && commitExpr(v, prevDefault, 'µm', `Auto-created (transform.${fieldKey})`);
      }}
    />
  );
}

function TransformRow({
  transform, idx, total,
  onUpdate, onToggle, onMoveUp, onMoveDown, onDelete,
  paramValues, commitExpr, isGrouped, suggestions,
  onGripDown, onGripUp,
}) {
  const t = transform;
  const enabled = t.enabled !== false;
  // Style the row dimmer when disabled so it's visually clear it's not in the chain.
  const dimClass = enabled ? '' : 'opacity-50';
  // Pick a kind-specific accent color
  const kindColor = t.kind === 'displace' ? '#0ea5e9'
    : t.kind === 'rotate' ? '#a855f7'
    : t.kind === 'repeat' ? '#22c55e'
    : t.kind === 'mirror' ? '#f97316'
    : t.kind === 'duplicate_mirror' ? '#fb923c'
    : '#94a3b8';
  return (
    <div className={`rounded border p-1.5 mb-1 ${dimClass}`} style={{ borderColor: kindColor + '60', background: 'rgba(15,23,42,0.4)' }}>
      <div className="flex items-center gap-1 mb-1">
        {/* Drag handle: arms the wrapper div's HTML5 `draggable` while the
            mouse is down on it, so dragging text inside the row's inputs
            never starts a row drag. */}
        <span
          className="cursor-grab text-slate-600 hover:text-slate-300 flex-shrink-0 select-none"
          title="Drag to reorder (or use the ↑/↓ arrows)"
          onMouseDown={onGripDown}
          onMouseUp={onGripUp}
        >
          <GripVertical size={10} />
        </span>
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
          <ExprField label="dx" value={t.dx} onChange={(v) => onUpdate({ dx: v })} fieldKey="dx" paramValues={paramValues} commitExpr={commitExpr} suggestions={suggestions} />
          <ExprField label="dy" value={t.dy} onChange={(v) => onUpdate({ dy: v })} fieldKey="dy" paramValues={paramValues} commitExpr={commitExpr} suggestions={suggestions} />
        </div>
      )}
      {t.kind === 'rotate' && (
        <div className="space-y-1">
          <div className="flex gap-1.5">
            <ExprField label="angle (deg)" value={t.angle} onChange={(v) => onUpdate({ angle: v })} fieldKey="angle" paramValues={paramValues} commitExpr={commitExpr} suggestions={suggestions} />
            <div className="flex-1 min-w-0">
              <label className="text-[9px] uppercase tracking-wider text-slate-500">pivot</label>
              <select
                value={t.pivot || 'C'}
                onChange={(e) => {
                  const pivot = e.target.value;
                  // C9: picking 'custom' seeds px/py to '0' (matching the
                  // normalizeScene default) so the ExprFields below have a
                  // defined expression to edit.
                  onUpdate({
                    pivot,
                    ...(pivot === 'custom' && t.px == null ? { px: '0' } : {}),
                    ...(pivot === 'custom' && t.py == null ? { py: '0' } : {}),
                  });
                }}
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
                <option value="custom">custom (x, y)</option>
                {isGrouped && <option value="group">group centroid</option>}
              </select>
              <p className="text-[9px] text-slate-500 mt-0.5">
                {t.pivot === 'group' ? 'about the group\'s shared centroid'
                  : t.pivot === 'custom' ? 'about the explicit world point below'
                  : 'about this point'}
              </p>
            </div>
          </div>
          {/* C9: custom-pivot world coordinates — parametric expressions,
              same ExprField pattern (auto-create params, suggestions) as
              the dx/dy fields. */}
          {t.pivot === 'custom' && (
            <div className="flex gap-1.5">
              <ExprField label="px (pivot x)" value={t.px ?? '0'} onChange={(v) => onUpdate({ px: v })} fieldKey="px" paramValues={paramValues} commitExpr={commitExpr} suggestions={suggestions} />
              <ExprField label="py (pivot y)" value={t.py ?? '0'} onChange={(v) => onUpdate({ py: v })} fieldKey="py" paramValues={paramValues} commitExpr={commitExpr} suggestions={suggestions} />
            </div>
          )}
        </div>
      )}
      {t.kind === 'repeat' && (
        <div className="space-y-1">
          <div className="flex gap-1.5">
            <ExprField label="N copies" value={t.n} onChange={(v) => onUpdate({ n: v })} fieldKey="n" paramValues={paramValues} commitExpr={commitExpr} suggestions={suggestions} />
            <ExprField label="dx" value={t.dx} onChange={(v) => onUpdate({ dx: v })} fieldKey="dx" paramValues={paramValues} commitExpr={commitExpr} suggestions={suggestions} />
            <ExprField label="dy" value={t.dy} onChange={(v) => onUpdate({ dy: v })} fieldKey="dy" paramValues={paramValues} commitExpr={commitExpr} suggestions={suggestions} />
          </div>
          <label className="flex items-center gap-1 text-[10px] text-slate-400">
            <input type="checkbox" checked={t.includeOriginal !== false} onChange={(e) => onUpdate({ includeOriginal: e.target.checked })} />
            keep the original (uncheck for "shift only")
          </label>
        </div>
      )}
      {t.kind === 'mirror' && (
        <div className="flex gap-1.5">
          <div className="flex-1 min-w-0">
            <label className="text-[9px] uppercase tracking-wider text-slate-500">axis</label>
            <select
              value={t.axis || 'x'}
              onChange={(e) => onUpdate({ axis: e.target.value })}
              className="w-full bg-slate-900 border border-slate-700 rounded px-1 py-0.5 text-[11px] font-mono text-white outline-none focus:border-orange-400"
            >
              <option value="x">x (flip x — vertical mirror line)</option>
              <option value="y">y (flip y — horizontal mirror line)</option>
            </select>
          </div>
          <div className="flex-1 min-w-0">
            <label className="text-[9px] uppercase tracking-wider text-slate-500">pivot</label>
            <select
              value={t.pivot || 'C'}
              onChange={(e) => onUpdate({ pivot: e.target.value })}
              className="w-full bg-slate-900 border border-slate-700 rounded px-1 py-0.5 text-[11px] font-mono text-white outline-none focus:border-orange-400"
            >
              <option value="C">C (own center)</option>
              <option value="origin">world origin</option>
            </select>
            <p className="text-[9px] text-slate-500 mt-0.5">mirror line position</p>
          </div>
        </div>
      )}
      {t.kind === 'duplicate_mirror' && (
        <div className="space-y-1">
          <div className="flex gap-1.5">
            <div className="flex-1 min-w-0">
              <label className="text-[9px] uppercase tracking-wider text-slate-500">axis</label>
              <select
                value={t.axis || 'x'}
                onChange={(e) => onUpdate({ axis: e.target.value })}
                className="w-full bg-slate-900 border border-slate-700 rounded px-1 py-0.5 text-[11px] font-mono text-white outline-none focus:border-orange-400"
              >
                <option value="x">x (mirror along ±x)</option>
                <option value="y">y (mirror along ±y)</option>
              </select>
            </div>
            <ExprField label="offset (to mirror line)" value={t.offset} onChange={(v) => onUpdate({ offset: v })} fieldKey="offset" paramValues={paramValues} commitExpr={commitExpr} suggestions={suggestions} />
          </div>
          <p className="text-[9px] text-slate-500 leading-snug">
            Mirror line sits at <span className="font-mono">offset</span> from source center; duplicate lands at <span className="font-mono">+2·offset</span>.
          </p>
          <label className="flex items-center gap-1 text-[10px] text-slate-400">
            <input type="checkbox" checked={t.includeOriginal !== false} onChange={(e) => onUpdate({ includeOriginal: e.target.checked })} />
            keep the original
          </label>
        </div>
      )}
    </div>
  );
}

export function TransformChainEditor({ component, onUpdateComp, paramValues, commitExpr, suggestions }) {
  const transforms = component.transforms || [];
  const isGrouped = !!component.group;
  const setTransforms = (next) => onUpdateComp({ transforms: next });
  const addTransform = (kind) => {
    const id = `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    let t;
    if (kind === 'displace') t = { id, kind, enabled: true, dx: '0', dy: '0' };
    // For grouped components, rotate defaults to pivoting about the
    // GROUP centroid so the whole group rotates as one rigid body. For
    // an ungrouped component this falls back to pivot='C' (own center).
    else if (kind === 'rotate') t = { id, kind, enabled: true, angle: '0', pivot: isGrouped ? 'group' : 'C' };
    else if (kind === 'repeat') t = { id, kind, enabled: true, n: '1', dx: '0', dy: '0', includeOriginal: true };
    else if (kind === 'mirror') t = { id, kind, enabled: true, axis: 'x', pivot: 'C' };
    else if (kind === 'duplicate_mirror') t = { id, kind, enabled: true, axis: 'x', offset: '0', includeOriginal: true };
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
  // ── Drag-to-reorder (G3) ──────────────────────────────────────────
  // `grabIdx` is armed by mousedown on a row's grip handle: only then is
  // that row's wrapper `draggable`, so text-selection drags inside the
  // expression inputs never start a row drag. `dragIdx` is the row being
  // dragged; `overIdx` highlights the current drop target. The up/down
  // arrow buttons remain as the keyboard/precision alternative.
  const [grabIdx, setGrabIdx] = useState(null);
  const [dragIdx, setDragIdx] = useState(null);
  const [overIdx, setOverIdx] = useState(null);
  // Disarm the grip if the user mouses up without dragging (the grip's
  // own onMouseUp misses releases outside the handle).
  useEffect(() => {
    if (grabIdx == null) return;
    const clear = () => setGrabIdx(null);
    window.addEventListener('mouseup', clear);
    return () => window.removeEventListener('mouseup', clear);
  }, [grabIdx]);
  const clearDrag = () => { setGrabIdx(null); setDragIdx(null); setOverIdx(null); };
  const reorderTransform = (from, to) => {
    if (from == null || to == null || from === to ||
        from < 0 || to < 0 || from >= transforms.length || to >= transforms.length) return;
    const next = transforms.slice();
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setTransforms(next);
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
          <button
            onClick={() => addTransform('mirror')}
            className="flex items-center gap-1 px-1.5 py-0.5 rounded border border-slate-600 hover:border-orange-400 text-[10px] text-slate-300 hover:text-orange-300"
            title="Add a mirror transform: reflects the shape across a vertical (axis=x) or horizontal (axis=y) mirror line through its own center."
          >
            <FlipHorizontal size={10} /> mirror
          </button>
          <button
            onClick={() => addTransform('duplicate_mirror')}
            className="flex items-center gap-1 px-1.5 py-0.5 rounded border border-slate-600 hover:border-orange-400 text-[10px] text-slate-300 hover:text-orange-300"
            title="Add a duplicate-and-mirror transform: emits one mirrored copy offset by 2·offset from the source along the chosen axis. Useful for top/bottom or left/right symmetric pairs."
          >
            <Copy size={10} /> dup-mirror
          </button>
        </div>
      </div>
      {transforms.length === 0 ? (
        <p className="text-[10px] text-slate-500 italic">No transforms applied. Add one above to displace, rotate, repeat, or mirror this shape. Transforms apply in order; toggle the eye icon to suppress one without losing its parameters.</p>
      ) : (
        <div>
          {transforms.map((t, i) => (
            <div
              key={t.id || i}
              draggable={grabIdx === i}
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = 'move';
                try { e.dataTransfer.setData('text/plain', String(i)); } catch { /* IE/edge cases */ }
                setDragIdx(i);
              }}
              onDragOver={(e) => {
                if (dragIdx == null) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                if (overIdx !== i) setOverIdx(i);
              }}
              onDragLeave={() => { if (overIdx === i) setOverIdx(null); }}
              onDrop={(e) => {
                if (dragIdx == null) return;
                e.preventDefault();
                reorderTransform(dragIdx, i);
                clearDrag();
              }}
              onDragEnd={clearDrag}
              style={{
                opacity: dragIdx === i ? 0.4 : undefined,
                // Cyan insertion cue on the current drop target.
                boxShadow: overIdx === i && dragIdx != null && dragIdx !== i
                  ? '0 -2px 0 0 #22d3ee' : undefined,
              }}
            >
              <TransformRow
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
                isGrouped={isGrouped}
                suggestions={suggestions}
                onGripDown={() => setGrabIdx(i)}
                onGripUp={() => setGrabIdx(null)}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
