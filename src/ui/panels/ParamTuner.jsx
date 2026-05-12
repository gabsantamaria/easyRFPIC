// EXPERIMENTAL multiplicative parameter tuner.
//
// One slider per parameter row. Live-drives the parameter's expression
// while you drag, in [1/RANGE_FACTOR, RANGE_FACTOR] times whatever the
// resolved numeric value was at the start of the drag. The slider is
// log-spaced so the center is exactly ×1, both ends are equidistant in
// log space, and the slope is continuous through the middle.
//
// Releasing snaps the thumb back to center and re-anchors the range
// to the (just-tuned) value. Escape during a drag rolls the value back
// to the pre-drag nominal.
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

// Multiplier at the slider's right end. Left end is 1/RANGE_FACTOR.
// 1.5 → [0.667×, 1.5×]; 2 → [0.5×, 2×]; etc.
const RANGE_FACTOR = 1.5;

export function ParamTuner({ value, onUpdateExpr }) {
  // Slider position in [-1, +1]; multiplier = RANGE_FACTOR ** pos.
  // Returns to 0 on release so the next drag is anchored to the new value.
  const [pos, setPos] = useState(0);
  // The value at the START of the current drag — the anchor for the ±
  // range. Captured on pointerdown so partial drags compound sensibly
  // (the user sees ± of the value they're staring at, not of some stale
  // snapshot). Also the rollback target if the user presses Escape.
  const nominalRef = useRef(0);
  // Drag bookkeeping. `isDragging` lets the Escape handler know whether
  // it should treat the keypress as a cancel. `isCancelled` short-circuits
  // any further onChange events fired after Escape (the browser keeps
  // firing them as long as the user holds the mouse and moves it).
  // `pointerId` is held so we can releasePointerCapture on cancel.
  const isDraggingRef = useRef(false);
  const isCancelledRef = useRef(false);
  const pointerIdRef = useRef(null);
  const inputRef = useRef(null);

  const onPointerDown = (e) => {
    nominalRef.current = Number.isFinite(value) ? value : 0;
    isDraggingRef.current = true;
    isCancelledRef.current = false;
    pointerIdRef.current = e.pointerId;
    // Pointer capture: subsequent pointermove/up events are routed here
    // even if the cursor leaves the element. Without this, fast drags
    // can strand `pos` at a non-zero value when the cursor exits.
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
  };

  const onChange = (e) => {
    if (isCancelledRef.current) return;
    const next = parseFloat(e.target.value) || 0;
    setPos(next);
    const nominal = nominalRef.current;
    if (!Number.isFinite(nominal)) return;
    const tuned = nominal * Math.pow(RANGE_FACTOR, next);
    // Commit as a numeric literal. The deferred-text-input pattern
    // elsewhere is bypassed here because the whole point of a slider is
    // live continuous feedback.
    onUpdateExpr(tuned.toFixed(4));
  };

  const reset = () => {
    isDraggingRef.current = false;
    isCancelledRef.current = false;
    pointerIdRef.current = null;
    if (pos !== 0) setPos(0);
  };

  // Escape during a drag: roll the value back to the pre-drag nominal and
  // end the drag, ignoring any further onChange events until the user
  // releases the pointer. Only fires when the slider has focus, which it
  // does for the duration of a click-and-drag.
  const onKeyDown = (e) => {
    if (e.key !== 'Escape' || !isDraggingRef.current) return;
    e.preventDefault();
    isCancelledRef.current = true;
    const nominal = nominalRef.current;
    if (Number.isFinite(nominal)) onUpdateExpr(nominal.toFixed(4));
    setPos(0);
    // Release pointer capture so the slider stops grabbing pointer events
    // — the user is still holding the mouse, but we no longer want to
    // track it.
    if (inputRef.current && pointerIdRef.current != null) {
      try { inputRef.current.releasePointerCapture(pointerIdRef.current); } catch {}
    }
    // Blur so a subsequent Escape doesn't keep firing on stale focus.
    e.currentTarget.blur();
  };

  const multiplier = Math.pow(RANGE_FACTOR, pos);
  const tooltip = `Tune ×${(1 / RANGE_FACTOR).toFixed(2)} to ×${RANGE_FACTOR.toFixed(2)} from ${Number.isFinite(value) ? value.toFixed(3) : '?'}. Releasing re-anchors the range to the new value; Escape cancels and reverts.`;

  return (
    <div className="flex items-center px-1.5 pb-0.5">
      <input
        ref={inputRef}
        type="range"
        min={-1}
        max={1}
        step={0.005}
        value={pos}
        onPointerDown={onPointerDown}
        onChange={onChange}
        onPointerUp={reset}
        onPointerCancel={reset}
        onKeyDown={onKeyDown}
        className="flex-1 h-0.5 accent-slate-500 cursor-ew-resize opacity-50 hover:opacity-100"
        title={tooltip}
        disabled={!Number.isFinite(value) || value === 0}
      />
      {/* Readout only while tuning, so the row stays calm at rest. */}
      {pos !== 0 && (
        <span className="ml-1 text-[8px] font-mono text-slate-400 w-10 text-right tabular-nums">
          ×{multiplier.toFixed(2)}
        </span>
      )}
    </div>
  );
}
