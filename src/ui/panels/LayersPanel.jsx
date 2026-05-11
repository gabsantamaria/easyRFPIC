// LAYERS panel components.
//
// LayerCard renders one process-stack layer: name, role, thickness,
// material, color, plus rib cross-section fields when the role is
// `waveguide`. Expression inputs use commitExpr so typing a free
// identifier auto-creates the matching parameter.
//
// LevelGroup wraps one "device level" (coplanar layers at the same Z).
// When the level holds a single layer, it renders the LayerCard
// directly. When multi-layer, it draws a violet container with up/down
// arrows that move all member layers as a contiguous block.
//
// Extracted from PhotonicLayout.jsx as Stage 4.9 of the planned refactor.
import React from 'react';
import { Trash2 } from 'lucide-react';
import { evalExpr } from '../../scene/params.js';

export function LayerCard({ layer, idx, scene, paramValues, updateScene, commitExpr, compact }) {
  const updateLayer = (patch) => updateScene(prev => ({
    ...prev,
    stack: prev.stack.map((l, i) => i === idx ? { ...l, ...patch } : l),
  }));
  const deleteLayer = () => updateScene(prev => ({ ...prev, stack: prev.stack.filter((_, i) => i !== idx) }));
  const moveUp = () => updateScene(prev => {
    if (idx >= prev.stack.length - 1) return prev;
    const s = [...prev.stack];
    [s[idx], s[idx + 1]] = [s[idx + 1], s[idx]];
    return { ...prev, stack: s };
  });
  const moveDown = () => updateScene(prev => {
    if (idx <= 0) return prev;
    const s = [...prev.stack];
    [s[idx], s[idx - 1]] = [s[idx - 1], s[idx]];
    return { ...prev, stack: s };
  });

  const thicknessVal = evalExpr(layer.thickness, paramValues);
  const roleColor = {
    substrate: 'text-slate-300',
    waveguide: 'text-emerald-300',
    cladding: 'text-cyan-200',
    conductor: 'text-amber-300',
  }[layer.role] || 'text-slate-300';

  return (
    <div className="rounded border border-slate-700" style={{ background: '#1e293b' }}>
      <div className="flex items-center gap-1 px-2 py-1 border-b border-slate-800">
        <div className="w-3 h-3 rounded-sm flex-shrink-0" style={{ background: layer.color }} />
        <input
          value={layer.name}
          onChange={(e) => updateLayer({ name: e.target.value })}
          className={`bg-transparent font-bold text-[11px] outline-none flex-1 min-w-0 ${roleColor}`}
          spellCheck={false}
        />
        <button onClick={moveUp} disabled={idx === scene.stack.length - 1} className="text-slate-500 hover:text-slate-200 disabled:opacity-20 text-[10px] px-1" title="Move up">▲</button>
        <button onClick={moveDown} disabled={idx === 0} className="text-slate-500 hover:text-slate-200 disabled:opacity-20 text-[10px] px-1" title="Move down">▼</button>
        <button onClick={deleteLayer} className="text-slate-500 hover:text-red-400" title="Delete layer"><Trash2 size={10} /></button>
      </div>
      <div className="px-2 py-1 space-y-1">
        <div className="flex items-center gap-1">
          <label className="text-[9px] text-slate-500 w-16">role</label>
          <select
            value={layer.role}
            onChange={(e) => updateLayer({ role: e.target.value })}
            className="flex-1 bg-slate-900 border border-slate-700 rounded px-1 py-0.5 text-[10px] outline-none focus:border-cyan-400"
          >
            <option value="substrate">substrate</option>
            <option value="waveguide">waveguide</option>
            <option value="cladding">cladding</option>
            <option value="conductor">conductor</option>
          </select>
        </div>
        <div className="flex items-center gap-1">
          <label className="text-[9px] text-slate-500 w-16">thickness</label>
          <input
            value={layer.thickness}
            onChange={(e) => updateLayer({ thickness: e.target.value })}
            onBlur={(e) => commitExpr(e.target.value, '1', 'µm', `Auto-created (layer ${layer.name} thickness)`)}
            onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); }}
            placeholder="expr (e.g. 4.7 or h_sio2)"
            className="flex-1 min-w-0 bg-slate-900 border border-slate-700 rounded px-1 py-0.5 text-[10px] font-mono text-cyan-300 outline-none focus:border-cyan-400"
            spellCheck={false}
          />
          <span className="text-[9px] text-slate-500 font-mono w-12 text-right">
            {Number.isFinite(thicknessVal) ? `${thicknessVal.toFixed(2)}um` : '?'}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <label className="text-[9px] text-slate-500 w-16">material</label>
          <input
            value={layer.material}
            onChange={(e) => updateLayer({ material: e.target.value })}
            placeholder="HFSS material name"
            className="flex-1 bg-slate-900 border border-slate-700 rounded px-1 py-0.5 text-[10px] font-mono text-slate-200 outline-none focus:border-cyan-400"
            spellCheck={false}
          />
        </div>
        <div className="flex items-center gap-1">
          <label className="text-[9px] text-slate-500 w-16">color</label>
          <input
            type="color"
            value={layer.color}
            onChange={(e) => updateLayer({ color: e.target.value })}
            className="w-12 h-5 bg-transparent border border-slate-700 rounded cursor-pointer"
          />
        </div>
        {layer.role === 'waveguide' && (() => {
          const cwVal = evalExpr(layer.core_width, paramValues);
          const shVal = evalExpr(layer.slab_height, paramValues);
          const swVal = evalExpr(layer.slab_width, paramValues);
          const eaVal = evalExpr(layer.etch_angle, paramValues);
          const ref = layer.core_width_ref === 'bottom' ? 'bottom' : 'top';
          return (
            <div className="mt-1 pt-1 border-t border-slate-700 space-y-1">
              <div className="text-[9px] uppercase tracking-wider text-emerald-400/70 font-semibold px-0.5">Rib cross-section</div>
              <div className="flex items-center gap-1">
                <label className="text-[9px] text-slate-500 w-16" title={`Width measured at the ${ref} of the rib`}>
                  core w
                  <button
                    type="button"
                    onClick={() => updateLayer({ core_width_ref: ref === 'top' ? 'bottom' : 'top' })}
                    className="ml-1 text-emerald-400 hover:text-emerald-200 font-bold"
                    title="Toggle whether core_width is measured at the top or bottom of the rib"
                  >
                    {ref === 'top' ? '↑top' : '↓bot'}
                  </button>
                </label>
                <input
                  value={layer.core_width || ''}
                  onChange={(e) => updateLayer({ core_width: e.target.value })}
                  onBlur={(e) => commitExpr(e.target.value, '1', 'µm', `Auto-created (layer ${layer.name} core_width)`)}
                  onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); }}
                  placeholder={`rib ${ref} width`}
                  className="flex-1 min-w-0 bg-slate-900 border border-slate-700 rounded px-1 py-0.5 text-[10px] font-mono text-cyan-300 outline-none focus:border-cyan-400"
                  spellCheck={false}
                />
                <span className="text-[9px] text-slate-500 font-mono w-12 text-right">
                  {Number.isFinite(cwVal) ? `${cwVal.toFixed(2)}um` : '?'}
                </span>
              </div>
              <div className="flex items-center gap-1">
                <label className="text-[9px] text-slate-500 w-16">slab h</label>
                <input
                  value={layer.slab_height || ''}
                  onChange={(e) => updateLayer({ slab_height: e.target.value })}
                  onBlur={(e) => commitExpr(e.target.value, '0.1', 'µm', `Auto-created (layer ${layer.name} slab_height)`)}
                  onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); }}
                  placeholder="unetched slab height"
                  className="flex-1 min-w-0 bg-slate-900 border border-slate-700 rounded px-1 py-0.5 text-[10px] font-mono text-cyan-300 outline-none focus:border-cyan-400"
                  spellCheck={false}
                />
                <span className="text-[9px] text-slate-500 font-mono w-12 text-right">
                  {Number.isFinite(shVal) ? `${shVal.toFixed(2)}um` : '?'}
                </span>
              </div>
              <div className="flex items-center gap-1">
                <label className="text-[9px] text-slate-500 w-16">slab w</label>
                <input
                  value={layer.slab_width || ''}
                  onChange={(e) => updateLayer({ slab_width: e.target.value })}
                  onBlur={(e) => commitExpr(e.target.value, '5', 'µm', `Auto-created (layer ${layer.name} slab_width)`)}
                  onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); }}
                  placeholder="slab width around rib"
                  className="flex-1 min-w-0 bg-slate-900 border border-slate-700 rounded px-1 py-0.5 text-[10px] font-mono text-cyan-300 outline-none focus:border-cyan-400"
                  spellCheck={false}
                />
                <span className="text-[9px] text-slate-500 font-mono w-12 text-right">
                  {Number.isFinite(swVal) ? `${swVal.toFixed(2)}um` : '?'}
                </span>
              </div>
              <div className="flex items-center gap-1">
                <label className="text-[9px] text-slate-500 w-16">etch ang</label>
                <input
                  value={layer.etch_angle || ''}
                  onChange={(e) => updateLayer({ etch_angle: e.target.value })}
                  onBlur={(e) => commitExpr(e.target.value, '70', 'deg', `Auto-created (layer ${layer.name} etch_angle)`)}
                  onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); }}
                  placeholder="degrees from horizontal"
                  className="flex-1 min-w-0 bg-slate-900 border border-slate-700 rounded px-1 py-0.5 text-[10px] font-mono text-cyan-300 outline-none focus:border-cyan-400"
                  spellCheck={false}
                />
                <span className="text-[9px] text-slate-500 font-mono w-12 text-right">
                  {Number.isFinite(eaVal) ? `${eaVal.toFixed(1)}°` : '?'}
                </span>
              </div>
            </div>
          );
        })()}
      </div>
    </div>
  );
}

export function LevelGroup({ level, scene, paramValues, updateScene, commitExpr }) {
  // Move all layers in this level together within the underlying stack array.
  // direction: +1 to move up (later in array = higher Z), -1 to move down.
  const moveLevel = (direction) => {
    updateScene(prev => {
      const indices = level.layers.map(l => l.idx).sort((a, b) => a - b);
      const blockSize = indices.length;
      const blockStart = indices[0];
      const blockEnd = indices[indices.length - 1];
      const stackLen = prev.stack.length;
      // Verify the block is contiguous in the array (should be, since we group adjacent only)
      for (let i = 0; i < blockSize; i++) {
        if (indices[i] !== blockStart + i) return prev;
      }
      if (direction > 0) {
        // Move up: swap with the layer at blockEnd+1, if any
        if (blockEnd + 1 >= stackLen) return prev;
        const newStack = [...prev.stack];
        const above = newStack.splice(blockEnd + 1, 1)[0];
        newStack.splice(blockStart, 0, above);
        return { ...prev, stack: newStack };
      } else {
        // Move down: swap with the layer at blockStart-1, if any
        if (blockStart - 1 < 0) return prev;
        const newStack = [...prev.stack];
        const below = newStack.splice(blockStart - 1, 1)[0];
        newStack.splice(blockEnd, 0, below);
        return { ...prev, stack: newStack };
      }
    });
  };

  if (level.isDevice && level.layers.length > 1) {
    const blockStart = level.layers[0].idx;
    const blockEnd = level.layers[level.layers.length - 1].idx;
    const canMoveUp = blockEnd < scene.stack.length - 1;
    const canMoveDown = blockStart > 0;
    return (
      <div className="rounded border-2 border-violet-700/40 p-1.5" style={{ background: 'rgba(124,58,237,0.05)' }}>
        <div className="flex items-center justify-between gap-2 mb-1.5 px-1">
          <span className="text-[9px] uppercase tracking-wider text-violet-300 font-semibold">Device level — coplanar</span>
          <span className="text-[9px] text-slate-500 font-mono flex-1">{level.zLabel}</span>
          <button
            onClick={() => moveLevel(1)}
            disabled={!canMoveUp}
            className="text-violet-400 hover:text-violet-200 disabled:opacity-20 text-[10px] px-1"
            title="Move whole device level up"
          >▲</button>
          <button
            onClick={() => moveLevel(-1)}
            disabled={!canMoveDown}
            className="text-violet-400 hover:text-violet-200 disabled:opacity-20 text-[10px] px-1"
            title="Move whole device level down"
          >▼</button>
        </div>
        <div className="grid grid-cols-1 gap-1.5">
          {level.layers.map(({ layer, idx }) => (
            <LayerCard
              key={layer.id}
              layer={layer}
              idx={idx}
              scene={scene}
              paramValues={paramValues}
              updateScene={updateScene}
              commitExpr={commitExpr}
            />
          ))}
        </div>
      </div>
    );
  }
  // Single-layer level — just render the card directly with no extra wrapping
  const { layer, idx } = level.layers[0];
  return (
    <LayerCard
      key={layer.id}
      layer={layer}
      idx={idx}
      scene={scene}
      paramValues={paramValues}
      updateScene={updateScene}
      commitExpr={commitExpr}
    />
  );
}
