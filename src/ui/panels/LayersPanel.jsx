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
import { Trash2, Eye, EyeOff } from 'lucide-react';
import { evalExpr } from '../../scene/params.js';
import { DeferredTextInput } from '../DeferredTextInput.jsx';

// Split a stack into ordered "levels". Each level is either a solo
// layer (coplanarGroup absent) or a contiguous run of layers sharing
// a coplanarGroup id. Returns [{ groupId, indices: [stackIdx, ...] }].
function computeStackLevels(stack) {
  const levels = [];
  let cur = null;
  for (let i = 0; i < stack.length; i++) {
    const l = stack[i];
    const gid = l.coplanarGroup;
    if (gid && cur && cur.groupId === gid) {
      cur.indices.push(i);
    } else if (gid) {
      cur = { groupId: gid, indices: [i] };
      levels.push(cur);
    } else {
      cur = null;
      levels.push({ groupId: null, indices: [i] });
    }
  }
  return levels;
}

function levelIndexOf(levels, stackIdx) {
  for (let li = 0; li < levels.length; li++) {
    if (levels[li].indices.includes(stackIdx)) return li;
  }
  return -1;
}

// Swap two adjacent levels' index blocks in the stack. dir: +1 to move
// `levelIdx` up (toward the top), −1 to move it down. Group integrity
// is preserved because each level's indices form a contiguous block.
function swapLevels(stack, levelIdx, dir) {
  const levels = computeStackLevels(stack);
  const other = levelIdx + dir;
  if (other < 0 || other >= levels.length) return stack;
  const lvlA = levels[levelIdx];
  const lvlB = levels[other];
  // The two blocks are ordered by stack index; sort so we always
  // splice the lower-index block first.
  const [first, second] = lvlA.indices[0] < lvlB.indices[0] ? [lvlA, lvlB] : [lvlB, lvlA];
  const blockFirst  = first.indices.map((i) => stack[i]);
  const blockSecond = second.indices.map((i) => stack[i]);
  const next = [...stack];
  next.splice(first.indices[0], blockFirst.length + blockSecond.length, ...blockSecond, ...blockFirst);
  return next;
}

// Reorder a layer within its coplanar group (no group crossing).
function swapWithinGroup(stack, idx, dir) {
  const other = idx + dir;
  if (other < 0 || other >= stack.length) return stack;
  if (stack[other].coplanarGroup !== stack[idx].coplanarGroup) return stack;
  const next = [...stack];
  [next[idx], next[other]] = [next[other], next[idx]];
  return next;
}

export function LayerCard({ layer, idx, scene, paramValues, updateScene, commitExpr, compact, hiddenLayerKeys, onToggleLayerVisibility }) {
  const updateLayer = (patch) => updateScene(prev => ({
    ...prev,
    stack: prev.stack.map((l, i) => i === idx ? { ...l, ...patch } : l),
  }));
  const deleteLayer = () => updateScene(prev => {
    const removedGid = prev.stack[idx]?.coplanarGroup;
    let next = prev.stack.filter((_, i) => i !== idx);
    if (removedGid) {
      // Collapse a stranded single-member group so the remaining layer
      // doesn't sit alone inside a coplanar wrapper.
      const remaining = next.filter((l) => l.coplanarGroup === removedGid);
      if (remaining.length < 2) {
        next = next.map((l) => l.coplanarGroup === removedGid ? { ...l, coplanarGroup: undefined } : l);
      }
    }
    return { ...prev, stack: next };
  });
  // Layer move semantics:
  //  - If this layer is one of ≥ 2 members in a coplanar group AND
  //    the neighbor in the direction is the same group, swap the two
  //    within the group (within-group reorder).
  //  - Otherwise the layer's whole LEVEL (a solo layer is a 1-member
  //    level) moves past the next level — coplanar groups stay
  //    intact and the layer hops over a neighboring group rather than
  //    breaking into it.
  const moveLayer = (dir /* +1 up, -1 down */) => updateScene((prev) => {
    const cur = prev.stack[idx];
    const neighborIdx = idx + dir;
    const neighbor = prev.stack[neighborIdx];
    if (cur?.coplanarGroup && neighbor?.coplanarGroup === cur.coplanarGroup) {
      return { ...prev, stack: swapWithinGroup(prev.stack, idx, dir) };
    }
    const levels = computeStackLevels(prev.stack);
    const myLvl = levelIndexOf(levels, idx);
    if (myLvl < 0) return prev;
    return { ...prev, stack: swapLevels(prev.stack, myLvl, dir) };
  });
  const moveUp = () => moveLayer(+1);
  const moveDown = () => moveLayer(-1);

  // Disabled when there's nothing to swap with. Within-group: when this
  // is the top (or bottom) member. At a level boundary: when this is
  // already in the topmost (or bottommost) level.
  const stack = scene.stack;
  const levelsCurrent = computeStackLevels(stack);
  const myLevelIdx = levelIndexOf(levelsCurrent, idx);
  const aboveSameGroup = stack[idx + 1] && stack[idx + 1].coplanarGroup === layer.coplanarGroup && !!layer.coplanarGroup;
  const belowSameGroup = stack[idx - 1] && stack[idx - 1].coplanarGroup === layer.coplanarGroup && !!layer.coplanarGroup;
  const canMoveUp   = aboveSameGroup || (myLevelIdx >= 0 && myLevelIdx < levelsCurrent.length - 1);
  const canMoveDown = belowSameGroup || (myLevelIdx > 0);

  const thicknessVal = evalExpr(layer.thickness, paramValues);
  const roleColor = {
    substrate: 'text-slate-300',
    waveguide: 'text-emerald-300',
    cladding: 'text-cyan-200',
    conductor: 'text-amber-300',
  }[layer.role] || 'text-slate-300';

  // Coplanar-group toggles. Merging "with above" means: take whatever
  // coplanarGroup id the layer immediately above carries (creating a
  // fresh id if it doesn't have one yet) and stamp it on both. The
  // existing group's other members keep their id, so the new layer
  // joins their level.
  const layerAbove = scene.stack[idx + 1]; // physically above = next in array
  const isCoplanarWithAbove = layerAbove && layer.coplanarGroup
    && layer.coplanarGroup === layerAbove.coplanarGroup;
  const mergeAbove = () => {
    if (!layerAbove) return;
    const aboveGid = layerAbove.coplanarGroup;
    const gid = aboveGid || `device_${Math.random().toString(36).slice(2, 7)}`;
    updateScene((prev) => ({
      ...prev,
      stack: prev.stack.map((l, i) => {
        if (i === idx || i === idx + 1) return { ...l, coplanarGroup: gid };
        return l;
      }),
    }));
  };
  const splitFromAbove = () => {
    // Clear THIS layer's coplanarGroup. If that leaves the prior group
    // with only one remaining member, clear that member's id too — a
    // single-layer "group" is degenerate.
    updateScene((prev) => {
      const oldGid = layer.coplanarGroup;
      let next = prev.stack.map((l, i) => i === idx ? { ...l, coplanarGroup: undefined } : l);
      if (oldGid) {
        const remaining = next.filter((l) => l.coplanarGroup === oldGid);
        if (remaining.length < 2) {
          next = next.map((l) => l.coplanarGroup === oldGid ? { ...l, coplanarGroup: undefined } : l);
        }
      }
      return { ...prev, stack: next };
    });
  };

  // Canvas visibility eye — only roles with a canvas footprint get one
  // (conductor => that stack layer's electrodes; waveguide => all wg parts).
  // Substrate/cladding have no plan-view footprint. CANVAS-ONLY: exports
  // always include hidden layers.
  const visKey = layer.role === 'conductor' ? `cond:${layer.id}`
    : layer.role === 'waveguide' ? 'wg'
    : null;
  const isHidden = !!(visKey && hiddenLayerKeys && hiddenLayerKeys.has(visKey));
  return (
    <div className="rounded border border-slate-700" style={{ background: '#1e293b', opacity: isHidden ? 0.55 : 1 }}>
      <div className="flex items-center gap-1 px-2 py-1 border-b border-slate-800">
        <div className="w-3 h-3 rounded-sm flex-shrink-0" style={{ background: layer.color }} />
        {visKey && onToggleLayerVisibility && (
          <button
            onClick={() => onToggleLayerVisibility(visKey)}
            className={isHidden ? 'text-slate-500 hover:text-slate-300' : 'text-cyan-400 hover:text-cyan-200'}
            title={isHidden
              ? 'Hidden on canvas — click to show. (Canvas-only: exports always include this layer.)'
              : 'Visible on canvas — click to hide. (Canvas-only: exports always include this layer.)'}
          >
            {isHidden ? <EyeOff size={11} /> : <Eye size={11} />}
          </button>
        )}
        <input
          value={layer.name}
          onChange={(e) => updateLayer({ name: e.target.value })}
          className={`bg-transparent font-bold text-[11px] outline-none flex-1 min-w-0 ${roleColor}`}
          spellCheck={false}
        />
        {/* Coplanar toggle — merge with the layer immediately above
            into the same level (same z-start), or split this one out
            into its own sequential level. Hidden for the topmost
            layer (no layer above to merge with). */}
        {layerAbove && (
          isCoplanarWithAbove ? (
            <button
              onClick={splitFromAbove}
              className="text-violet-400 hover:text-violet-200 text-[10px] px-1"
              title="Split this layer out of the coplanar group above (becomes its own sequential level)"
            >⊟</button>
          ) : (
            <button
              onClick={mergeAbove}
              className="text-slate-500 hover:text-violet-300 text-[10px] px-1"
              title="Merge with the layer above as coplanar — same z-start, possibly different thicknesses. Every coplanar group must contain a cladding layer."
            >⊞</button>
          )
        )}
        <button onClick={moveUp} disabled={!canMoveUp} className="text-slate-500 hover:text-slate-200 disabled:opacity-20 text-[10px] px-1" title="Move up (within a coplanar group, swap with the next member; otherwise hop past the next level)">▲</button>
        <button onClick={moveDown} disabled={!canMoveDown} className="text-slate-500 hover:text-slate-200 disabled:opacity-20 text-[10px] px-1" title="Move down (within a coplanar group, swap with the previous member; otherwise hop past the previous level)">▼</button>
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
          <DeferredTextInput
            value={layer.thickness}
            onCommit={(v) => {
              updateLayer({ thickness: v });
              commitExpr(v, '1', 'µm', `Auto-created (layer ${layer.name} thickness)`);
            }}
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
                <DeferredTextInput
                  value={layer.core_width || ''}
                  onCommit={(v) => {
                    updateLayer({ core_width: v });
                    commitExpr(v, '1', 'µm', `Auto-created (layer ${layer.name} core_width)`);
                  }}
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
                <DeferredTextInput
                  value={layer.slab_height || ''}
                  onCommit={(v) => {
                    updateLayer({ slab_height: v });
                    commitExpr(v, '0.1', 'µm', `Auto-created (layer ${layer.name} slab_height)`);
                  }}
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
                <DeferredTextInput
                  value={layer.slab_width || ''}
                  onCommit={(v) => {
                    updateLayer({ slab_width: v });
                    commitExpr(v, '5', 'µm', `Auto-created (layer ${layer.name} slab_width)`);
                  }}
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
                <DeferredTextInput
                  value={layer.etch_angle || ''}
                  onCommit={(v) => {
                    updateLayer({ etch_angle: v });
                    commitExpr(v, '70', 'deg', `Auto-created (layer ${layer.name} etch_angle)`);
                  }}
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

export function LevelGroup({ level, scene, paramValues, updateScene, commitExpr, hiddenLayerKeys, onToggleLayerVisibility }) {
  // Move the whole coplanar group up/down by swapping its level
  // with the adjacent level — using computeStackLevels so the
  // neighbor (which may itself be a coplanar group of N layers) is
  // moved as a single block. The old per-index splice approach
  // could pull a single layer out of a neighboring group, breaking
  // the neighbor's coplanarity.
  const moveLevel = (direction /* +1 up, -1 down */) => {
    updateScene((prev) => {
      const levels = computeStackLevels(prev.stack);
      const indices = level.layers.map((l) => l.idx);
      const li = levelIndexOf(levels, indices[0]);
      if (li < 0) return prev;
      return { ...prev, stack: swapLevels(prev.stack, li, direction) };
    });
  };

  if (level.isDevice && level.layers.length > 1) {
    const allLevels = computeStackLevels(scene.stack);
    const myLvlIdx = levelIndexOf(allLevels, level.layers[0].idx);
    const canMoveUp   = myLvlIdx >= 0 && myLvlIdx < allLevels.length - 1;
    const canMoveDown = myLvlIdx > 0;
    const needsCladding = !!level.needsCladding;
    // Coplanar groups missing a cladding get a red border + warning row
    // so the user can see the rule at a glance: every coplanar group
    // must contain a cladding so its volume fills around the structures
    // on that level. The user can either change one of the layer's
    // role to "cladding" (use material="air" for a dry / vacuum cap)
    // or split the offending layer out of the group.
    const borderClass = needsCladding ? 'border-red-500/70' : 'border-violet-700/40';
    const bgStyle     = needsCladding ? { background: 'rgba(220,38,38,0.07)' } : { background: 'rgba(124,58,237,0.05)' };
    return (
      <div className={`rounded border-2 p-1.5 ${borderClass}`} style={bgStyle}>
        <div className="flex items-center justify-between gap-2 mb-1.5 px-1">
          <span className="text-[9px] uppercase tracking-wider text-violet-300 font-semibold">Coplanar group</span>
          <span className="text-[9px] text-slate-500 font-mono flex-1">{level.zLabel}</span>
          <button
            onClick={() => moveLevel(1)}
            disabled={!canMoveUp}
            className="text-violet-400 hover:text-violet-200 disabled:opacity-20 text-[10px] px-1"
            title="Move whole coplanar group up"
          >▲</button>
          <button
            onClick={() => moveLevel(-1)}
            disabled={!canMoveDown}
            className="text-violet-400 hover:text-violet-200 disabled:opacity-20 text-[10px] px-1"
            title="Move whole coplanar group down"
          >▼</button>
        </div>
        {needsCladding && (
          <p className="text-[10px] text-red-300 px-1 mb-1.5 leading-snug">
            Missing cladding: every coplanar group needs a cladding-role layer (use material "air" if you want an open cap) so HFSS has a defined volume around the structures on this level.
          </p>
        )}
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
              hiddenLayerKeys={hiddenLayerKeys}
              onToggleLayerVisibility={onToggleLayerVisibility}
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
      hiddenLayerKeys={hiddenLayerKeys}
      onToggleLayerVisibility={onToggleLayerVisibility}
    />
  );
}
