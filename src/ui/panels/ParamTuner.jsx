// EXPERIMENTAL ± 20 % parameter tuner.
//
// One slider per parameter row. Live-drives the parameter's expression
// while you drag, in ± 20 % of whatever the resolved numeric value was
// at the start of the drag. Releasing snaps the thumb back to center
// and re-anchors the next ± 20 % range to the (just-tuned) value.
//
// Caveat: tuning replaces the parameter's expression with a numeric
// literal. If the original expression referenced other parameters
// (e.g. `h_wg + 1`), that reference is lost — undo / Cmd+Z brings
// it back. Acceptable for a probe / "feel out the design" feature.
//
// To REMOVE this experiment cleanly:
//   1. Delete this file.
//   2. In src/ui/panels/ParamRow.jsx, remove the `import { ParamTuner }`
//      line and the single `<ParamTuner ... />` JSX render.
import React, { useState, useRef } from 'react';

export function ParamTuner({ value, onUpdateExpr }) {
  // Slider position in percent, range [-20, 20]. Always returns to 0 on
  // release so the next drag is anchored to the current value.
  const [pos, setPos] = useState(0);
  // The value at the START of the current drag — the anchor for ± 20 %.
  // Captured on pointerdown, not on each render, so partial drags compound
  // sensibly (the user sees ± 20 % of the value they're staring at, not of
  // some stale snapshot).
  const nominalRef = useRef(0);

  const onPointerDown = (e) => {
    nominalRef.current = Number.isFinite(value) ? value : 0;
    // Pointer capture: subsequent pointermove/up events are routed to the
    // slider even if the cursor leaves the element. Without this, dragging
    // fast off the slider strands `pos` at a non-zero value.
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
  };

  const onChange = (e) => {
    const next = parseFloat(e.target.value) || 0;
    setPos(next);
    const nominal = nominalRef.current;
    if (!Number.isFinite(nominal)) return;
    const tuned = nominal * (1 + next / 100);
    // Commit as a numeric literal. The deferred-text-input pattern
    // elsewhere is bypassed here because the whole point of a slider is
    // live continuous feedback.
    onUpdateExpr(tuned.toFixed(4));
  };

  const reset = () => { if (pos !== 0) setPos(0); };

  const label = (pos === 0)
    ? '0%'
    : `${pos > 0 ? '+' : ''}${pos.toFixed(1)}%`;
  const tooltip = `Tune ±20% from ${Number.isFinite(value) ? value.toFixed(3) : '?'}. Releasing snaps back to center and re-anchors the range.`;

  return (
    <div className="flex items-center gap-1 px-1.5 pb-1 pt-0">
      <span className="text-[8px] text-slate-600 uppercase tracking-wider w-8" title={tooltip}>tune</span>
      <input
        type="range"
        min={-20}
        max={20}
        step={0.1}
        value={pos}
        onPointerDown={onPointerDown}
        onChange={onChange}
        onPointerUp={reset}
        onPointerCancel={reset}
        className="flex-1 h-1 accent-violet-500 cursor-ew-resize"
        title={tooltip}
        disabled={!Number.isFinite(value) || value === 0}
      />
      <span className="text-[9px] font-mono text-slate-500 w-10 text-right tabular-nums">{label}</span>
    </div>
  );
}
