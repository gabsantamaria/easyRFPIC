// Main canvas / SVG viewport.
//
// Canvas is the SVG renderer for the layout: draws layers in screen
// space, components (rect / circle / ellipse / polygon / racetrack / boolean
// cluster), anchors, snap connections, ruler measurements, parametric
// dimension arrows, and selection halos. It also owns the drag state
// machine (cluster drag, alt-drag snap creation, resize handles) and
// the ruler tool.
//
// Behavior is unchanged from the in-PhotonicLayout original; this is a
// straight cut-and-import (Stage 4.10 of the planned refactor). All
// callbacks and view state are passed in as explicit props by App.
import React, { useState, useRef, useEffect, useMemo } from 'react';
import { ANCHORS, parseAnchor, anchorLocal, anchorWorld } from '../../scene/anchors.js';
import { evalExpr } from '../../scene/params.js';
import { solveLayout, applyMirrors, resolveBooleanBboxes } from '../../scene/solver.js';
import { expandTransforms } from '../../scene/transforms.js';
import { detectPortIntegrationLine } from '../../scene/lumpedPort.js';
import { shapeInstanceToRing } from '../../geometry/rings.js';
import { buildRacetrackCenterline } from '../../geometry/racetrack.js';
import { ringToSvgPath } from '../../geometry/paths.js';

// =========================================================================
// CANVAS
// =========================================================================
export function Canvas({ scene, updateScene, selectedId, selectedIds, setSelection, viewport, setViewport, snapMode, setSnapMode, gridSize, gridSnapEnabled, paramValues, addParam, updateParamExpr, rulerMode, setRulerMode, rulerMeasurements, setRulerMeasurements, rulerInProgress, setRulerInProgress, rulerSnapPoint, setRulerSnapPoint, alertDialog, setInteractionStatus, showDimensions, addMode, setAddMode, commitDragAdd, onComponentContextMenu }) {
  // Drop a single committed ruler measurement by id.
  const deleteRuler = (id) => setRulerMeasurements((prev) => prev.filter((m) => m.id !== id));
  const svgRef = useRef(null);

  const solved = useMemo(() => {
    const s = solveLayout(scene.components, scene.snaps, paramValues);
    const m = applyMirrors(s, scene.mirrors);
    // Resolve boolean components' effective bbox-derived w/h/cx/cy so
    // anchor lookups, snap targeting, and dimension overlays treat them
    // uniformly with primitives.
    return resolveBooleanBboxes(m, paramValues);
  }, [scene.components, scene.snaps, scene.mirrors, paramValues]);

  // Per-component transform instances. For each component, expandTransforms
  // returns one entry per displayed copy (a no-transform comp gives one).
  // We index by compId for fast lookup in the render loop.
  const transformInstances = useMemo(
    () => expandTransforms(solved, paramValues),
    [solved, paramValues]
  );
  const instancesByCompId = useMemo(() => {
    const m = {};
    for (const i of transformInstances) {
      if (!m[i.compId]) m[i.compId] = [];
      m[i.compId].push(i);
    }
    return m;
  }, [transformInstances]);

  // Related components: anything snapped to or from the selected component, plus mirror partners
  const relatedIds = useMemo(() => {
    if (!selectedId) return { parents: new Set(), children: new Set(), mirrors: new Set() };
    const parents = new Set();
    const children = new Set();
    const mirrors = new Set();
    for (const s of scene.snaps) {
      if (s.to.compId === selectedId) parents.add(s.from.compId);
      if (s.from.compId === selectedId) children.add(s.to.compId);
    }
    for (const m of scene.mirrors) {
      for (const mm of m.members) {
        if (mm.srcId === selectedId) mirrors.add(mm.mirrorId);
        if (mm.mirrorId === selectedId) mirrors.add(mm.srcId);
      }
    }
    return { parents, children, mirrors };
  }, [selectedId, scene.snaps, scene.mirrors]);

  // Boolean cluster bookkeeping. Booleans are now full components (kind='boolean')
  // in scene.components; their operands are tagged with consumedBy. We compute:
  //   - booleanComps: list of derived boolean components (active ones only)
  //   - operandIds: set of comp ids consumed by some boolean (hidden from
  //                 standalone rendering and snap targets)
  //   - memberToCluster[compId]: for each operand, the set of sibling
  //                 operands+boolean it should move with (drag-as-one)
  //   - operandToBooleanId[compId]: which boolean a given operand belongs to
  const booleanClusters = useMemo(() => {
    // ALL boolean components. Used for operand bookkeeping (which
    // primitive ids are inside ANY boolean, regardless of nesting depth).
    const allBooleanComps = scene.components.filter(c => c.kind === 'boolean');
    // TOP-LEVEL booleans only — those not consumed by another boolean.
    // The recursive renderer descends into nested operands automatically,
    // so consumed booleans must NOT render standalone (would double-render).
    const booleanComps = allBooleanComps.filter(c => !c.consumedBy);
    const operandIds = new Set();
    const operandToBooleanId = {};
    const compById0 = Object.fromEntries(scene.components.map(c => [c.id, c]));
    for (const b of allBooleanComps) {
      for (const id of (b.operandIds || [])) {
        // Only treat an operand as "consumed by a boolean" if it actually
        // is — i.e., its consumedBy points back at THIS boolean. Punch's
        // tool operands are intentionally left non-consumed so they keep
        // rendering as standalone primitives even though they participate
        // in the boolean's geometry.
        const opComp = compById0[id];
        if (!opComp || opComp.consumedBy !== b.id) continue;
        operandIds.add(id);
        operandToBooleanId[id] = b.id;
      }
    }
    // Cluster = top-level boolean's id + ALL transitively reachable
    // CONSUMED operands. Non-consumed operands (punch tools) stay
    // outside the cluster — they're true standalone shapes that just
    // happen to participate in this boolean's geometry. In HFSS terms,
    // this matches Subtract with "clone tool object before operation":
    // the tool keeps its identity and isn't dragged with the result.
    const memberToCluster = {};
    const compById = Object.fromEntries(scene.components.map(c => [c.id, c]));
    const collectMembers = (id, acc) => {
      if (acc.has(id)) return;
      acc.add(id);
      const c = compById[id];
      if (c && c.kind === 'boolean') {
        for (const opid of (c.operandIds || [])) {
          const opC = compById[opid];
          if (!opC || opC.consumedBy !== c.id) continue;
          collectMembers(opid, acc);
        }
      }
    };
    for (const b of booleanComps) {
      const members = new Set();
      collectMembers(b.id, members);
      for (const m of members) {
        if (!memberToCluster[m]) memberToCluster[m] = new Set();
        for (const x of members) memberToCluster[m].add(x);
      }
    }
    return { booleanComps, allBooleanComps, operandIds, memberToCluster, operandToBooleanId };
  }, [scene.components]);


  // Drag state
  const [drag, setDrag] = useState(null); // { kind: 'move'|'resize', ... }
  const [pan, setPan] = useState(null);
  const [marquee, setMarquee] = useState(null); // { startWorld, currentWorld }
  const [snapPick, setSnapPick] = useState(null);
  const [snapHover, setSnapHover] = useState(null); // { compId, side, t, x, y } for edge hover preview
  const [snapCursor, setSnapCursor] = useState(null); // { x, y } in world coords, while picking second anchor
  const [modifier, setModifier] = useState(false); // Cmd / Ctrl held (disables grid snap)
  const [altKey, setAltKey] = useState(false); // Option / Alt held (marquee mode)
  const [shiftKey, setShiftKey] = useState(false); // Shift held (axis-lock during snap)
  // Drag-to-create state. Active when the user enters addMode and starts a drag
  // on the canvas. p1 is the drag start (in world coords); p2 is the current
  // mouse position. snapStart/snapEnd are anchor-snap descriptors when the
  // start/end points landed on an existing component anchor.
  const [addDrag, setAddDrag] = useState(null);
  // ^ shape: { p1, p2, snapStart, snapEnd }
  // Pre-drag hover snap target for addMode (preview before clicking).
  const [addHoverSnap, setAddHoverSnap] = useState(null);
  // ^ shape: { x, y, compId, anchor } | null
  // Snap target during a move-drag with Alt held: the existing-component
  // anchor under (or near) the cursor that the dragged component will snap
  // to on release. Re-evaluated on every mousemove while Alt is held.
  const [moveSnapHover, setMoveSnapHover] = useState(null);
  // ^ shape: { x, y, compId, anchor } | null

  useEffect(() => {
    const down = (e) => {
      if (e.key === 'Meta' || e.key === 'Control') setModifier(true);
      if (e.key === 'Alt') setAltKey(true);
      if (e.key === 'Shift') setShiftKey(true);
    };
    const up = (e) => {
      if (e.key === 'Meta' || e.key === 'Control') setModifier(false);
      if (e.key === 'Alt') setAltKey(false);
      if (e.key === 'Shift') setShiftKey(false);
    };
    const blur = () => { setModifier(false); setAltKey(false); setShiftKey(false); };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, []);

  // Ruler-mode Escape: cancel in-progress measurement, or exit the tool entirely
  useEffect(() => {
    if (!rulerMode) return;
    const handler = (e) => {
      if (e.key === 'Escape') {
        if (rulerInProgress) setRulerInProgress(null);
        else setRulerMode(false);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [rulerMode, rulerInProgress]);

  // Add-mode Escape: cancel an in-progress drag, or exit the add tool entirely.
  useEffect(() => {
    if (!addMode) return;
    const handler = (e) => {
      if (e.key === 'Escape') {
        if (addDrag) setAddDrag(null);
        else setAddMode(null);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [addMode, addDrag]);

  // Push live status string to the bottom status bar (snap/ruler progress).
  // Avoids drawing a label on the canvas where it would obscure anchors and
  // the preview line itself.
  useEffect(() => {
    if (!setInteractionStatus) return;
    let status = null;
    if (snapMode === 'creating') {
      if (!snapPick) {
        status = { kind: 'snap', line: 'Snap: pick first anchor' };
      } else {
        const fromComp = solved.find(c => c.id === snapPick.compId);
        if (fromComp) {
          const fromW = anchorWorld(fromComp, snapPick.anchor, paramValues);
          let toX = null, toY = null, isLocked = false;
          if (snapHover && snapHover.compId !== snapPick.compId) {
            toX = snapHover.x; toY = snapHover.y;
            if (shiftKey) isLocked = true;
          } else if (snapCursor) {
            toX = snapCursor.x; toY = snapCursor.y;
            if (shiftKey) {
              const dx = toX - fromW.x, dy = toY - fromW.y;
              if (Math.abs(dx) < Math.abs(dy)) toX = fromW.x; else toY = fromW.y;
              isLocked = true;
            }
          }
          if (toX !== null) {
            const dx = toX - fromW.x, dy = toY - fromW.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            const lockTag = isLocked ? ' (locked)' : '';
            status = {
              kind: 'snap',
              line: `Snap${lockTag} · Δx=${dx.toFixed(3)} · Δy=${dy.toFixed(3)} · dist=${dist.toFixed(3)} µm`,
            };
          } else {
            status = { kind: 'snap', line: 'Snap: pick second anchor' };
          }
        }
      }
    } else if (rulerMode) {
      if (!rulerInProgress) {
        status = { kind: 'ruler', line: 'Ruler: pick first point' };
      } else if (rulerSnapPoint) {
        const p1 = rulerInProgress.p1;
        let p2x = rulerSnapPoint.x, p2y = rulerSnapPoint.y;
        if (shiftKey) {
          const dxr = p2x - p1.x, dyr = p2y - p1.y;
          if (Math.abs(dxr) > Math.abs(dyr)) p2y = p1.y; else p2x = p1.x;
        }
        const dx = p2x - p1.x, dy = p2y - p1.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const lockTag = shiftKey ? ' (locked)' : '';
        status = {
          kind: 'ruler',
          line: `Ruler${lockTag} · Δx=${dx.toFixed(3)} · Δy=${dy.toFixed(3)} · dist=${dist.toFixed(3)} µm`,
        };
      } else {
        status = { kind: 'ruler', line: 'Ruler: pick second point' };
      }
    } else if (addMode) {
      const layer = addMode.layer || addMode.kind || 'waveguide';
      const kindLabel = layer === 'waveguide' ? 'waveguide'
        : layer === 'port' ? 'port'
        : (addMode.conductorLayerId || 'conductor');
      const shapeLabel = addMode.shape || 'rect';
      if (!addDrag) {
        const hint = addHoverSnap && addHoverSnap.compId
          ? `snap-start: ${addHoverSnap.compId}.${addHoverSnap.anchor}`
          : 'click empty space or an anchor';
        status = { kind: 'add', line: `Add ${shapeLabel} (${kindLabel}) · drag to size · ${hint} · Esc cancels` };
      } else {
        const { p1, p2, snapStart, snapEnd } = addDrag;
        const w = Math.abs(p2.x - p1.x);
        const h = Math.abs(p2.y - p1.y);
        const tags = [];
        if (snapStart) tags.push(`start→${snapStart.compId}.${snapStart.anchor}`);
        if (snapEnd) {
          const sameComp = snapStart && snapEnd.compId === snapStart.compId;
          const tagSuffix = snapStart
            ? (sameComp ? ' (same comp)' : ' (spans → parametric width/height)')
            : '';
          tags.push(`end→${snapEnd.compId}.${snapEnd.anchor}${tagSuffix}`);
        }
        status = {
          kind: 'add',
          line: `Add ${kindLabel} · ${w.toFixed(2)} × ${h.toFixed(2)} µm${tags.length ? ' · ' + tags.join(' · ') : ''}`,
        };
      }
    } else if (drag && drag.kind === 'move' && moveSnapHover) {
      const line = moveSnapHover.kind === 'edge'
        ? `Alt-drag · release to snap ${moveSnapHover.dSide} edge to ${moveSnapHover.targetSide} edge of ${moveSnapHover.targetCompId}`
        : `Alt-drag · release to snap to ${moveSnapHover.compId}.${moveSnapHover.anchor}`;
      status = { kind: 'snap', line };
    } else if (drag && drag.kind === 'move' && altKey) {
      status = {
        kind: 'snap',
        line: `Alt-drag · approach another component's anchor to snap`,
      };
    }
    setInteractionStatus(status);
  }, [snapMode, snapPick, snapHover, snapCursor, shiftKey, altKey, rulerMode, rulerInProgress, rulerSnapPoint, addMode, addDrag, addHoverSnap, drag, moveSnapHover, solved, paramValues, setInteractionStatus]);

  const screenToWorld = (sx, sy) => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const pt = svg.createSVGPoint();
    pt.x = sx; pt.y = sy;
    const inv = svg.getScreenCTM().inverse();
    const wp = pt.matrixTransform(inv);
    return { x: wp.x, y: -wp.y };
  };

  const snapToGrid = (v) => {
    if (!gridSnapEnabled || modifier) return v;
    return Math.round(v / gridSize) * gridSize;
  };

  // Find the closest snappable feature within `worldThresh` units of (wp.x, wp.y).
  // Checks 9 fixed anchors per component first, then nearest point on each edge.
  // Returns { x, y, label } or null. `label` is a short description for the UI.
  const findRulerSnap = (wp, worldThresh) => {
    let best = null;
    const consider = (x, y, label) => {
      const dx = wp.x - x, dy = wp.y - y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d <= worldThresh && (!best || d < best.d)) best = { x, y, label, d };
    };
    for (const c of solved) {
      const w = evalExpr(c.w, paramValues);
      const h = evalExpr(c.h, paramValues);
      if (!Number.isFinite(w) || !Number.isFinite(h)) continue;
      // 9 fixed anchors
      for (const a of ANCHORS) {
        const lp = anchorLocal(a, w, h);
        consider(c.cx + lp.x, c.cy + lp.y, `${c.id} ${a}`);
      }
      // Nearest point on each edge (parametric snap)
      const x0 = c.cx - w / 2, x1 = c.cx + w / 2;
      const y0 = c.cy - h / 2, y1 = c.cy + h / 2;
      // Top edge: y = y1, x in [x0, x1]
      if (wp.x >= x0 - worldThresh && wp.x <= x1 + worldThresh) {
        const cx = Math.max(x0, Math.min(x1, wp.x));
        consider(cx, y1, `${c.id} top`);
        consider(cx, y0, `${c.id} bot`);
      }
      // Left/right edges
      if (wp.y >= y0 - worldThresh && wp.y <= y1 + worldThresh) {
        const cy = Math.max(y0, Math.min(y1, wp.y));
        consider(x0, cy, `${c.id} left`);
        consider(x1, cy, `${c.id} right`);
      }
    }
    return best;
  };

  // Like findRulerSnap, but also reports WHICH component and WHICH anchor the
  // snap landed on. Used by drag-to-create so we can install a real snap (not
  // just remember a coordinate) when the user lands on an existing anchor.
  // Returns null if nothing within `worldThresh`. Otherwise returns
  // { x, y, compId, anchor } where anchor is one of the 9 fixed names or a
  // parametric edge anchor like "T:0.42".
  const findAnchorSnap = (wp, worldThresh, excludeCompId = null) => {
    let best = null;
    const consider = (x, y, compId, anchor) => {
      const dx = wp.x - x, dy = wp.y - y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d <= worldThresh && (!best || d < best.d)) {
        best = { x, y, compId, anchor, d };
      }
    };
    for (const c of solved) {
      if (excludeCompId && c.id === excludeCompId) continue;
      const w = evalExpr(c.w, paramValues);
      const h = evalExpr(c.h, paramValues);
      if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) continue;
      // 9 fixed anchors — these win over parametric edge points (they're more
      // semantically meaningful so we slightly prefer them via early order).
      for (const a of ANCHORS) {
        const lp = anchorLocal(a, w, h);
        consider(c.cx + lp.x, c.cy + lp.y, c.id, a);
      }
      // Parametric edge anchors. Project the cursor onto each edge and use a
      // T:t / B:t / L:t / R:t form. This gives a precise t in [0,1].
      const x0 = c.cx - w / 2, x1 = c.cx + w / 2;
      const y0 = c.cy - h / 2, y1 = c.cy + h / 2;
      if (wp.x >= x0 - worldThresh && wp.x <= x1 + worldThresh) {
        const projX = Math.max(x0, Math.min(x1, wp.x));
        const tX = (projX - x0) / (x1 - x0); // 0 at left, 1 at right
        consider(projX, y1, c.id, `T:${tX.toFixed(4)}`);
        consider(projX, y0, c.id, `B:${tX.toFixed(4)}`);
      }
      if (wp.y >= y0 - worldThresh && wp.y <= y1 + worldThresh) {
        const projY = Math.max(y0, Math.min(y1, wp.y));
        const tY = (projY - y0) / (y1 - y0); // 0 at bottom, 1 at top
        consider(x0, projY, c.id, `L:${tY.toFixed(4)}`);
        consider(x1, projY, c.id, `R:${tY.toFixed(4)}`);
      }
    }
    return best;
  };

  const onWheel = (e) => {
    e.preventDefault();
    // Smooth, sensitivity-controlled zoom that works for both mouse wheel and trackpad.
    // Smaller k = less sensitive. 0.0015 feels gentle.
    const k = 0.0015;
    const factor = Math.exp(e.deltaY * k);
    // Get world point under cursor BEFORE zoom — this should stay put after zoom.
    const wp = screenToWorld(e.clientX, e.clientY);
    setViewport(v => {
      const newW = v.w * factor;
      const newH = v.h * factor;
      // The cursor world point relative to current viewport center:
      const dx = wp.x - v.x;
      const dy = wp.y - v.y;
      // After scaling, the same screen position will correspond to a world point
      // that is `factor` times further from the new center. To keep the cursor
      // pinned, the new center should be at: wp - factor * (wp - v) = wp - factor*dx, wp - factor*dy
      const newCx = wp.x - dx * factor;
      const newCy = wp.y - dy * factor;
      return { x: newCx, y: newCy, w: newW, h: newH };
    });
  };

  const onMouseDown = (e) => {
    // Only left-button starts drags / selection. Right-click is reserved
    // for the context menu (handled in onContextMenu below); middle-click
    // is currently a no-op.
    if (e.button !== 0) return;
    const target = e.target;

    // Ruler tool: clicks pick measurement endpoints
    if (rulerMode) {
      const wp = screenToWorld(e.clientX, e.clientY);
      // Use snapped position if available
      const worldThresh = viewport.w * 0.012; // ~1.2% of viewport width = a few pixels
      const snap = findRulerSnap(wp, worldThresh);
      let pt = snap ? { x: snap.x, y: snap.y } : { x: wp.x, y: wp.y };
      if (!rulerInProgress) {
        setRulerInProgress({ p1: pt });
      } else {
        // Shift = axis-lock: project p2 so it's purely horizontal or vertical from p1
        if (e.shiftKey) {
          const p1 = rulerInProgress.p1;
          const dx = pt.x - p1.x;
          const dy = pt.y - p1.y;
          if (Math.abs(dx) > Math.abs(dy)) pt = { x: pt.x, y: p1.y };
          else                              pt = { x: p1.x, y: pt.y };
        }
        const newM = { id: `m_${Date.now()}`, p1: rulerInProgress.p1, p2: pt };
        setRulerMeasurements(prev => [...prev, newM]);
        setRulerInProgress(null);
      }
      e.stopPropagation();
      e.preventDefault();
      return;
    }

    // Add tool: drag to size the new component. Anchor snaps are honored so
    // that landing on an existing component's corner/edge installs a position
    // snap rather than a free coordinate.
    if (addMode) {
      const wp = screenToWorld(e.clientX, e.clientY);
      const worldThresh = viewport.w * 0.012;
      const snap = findAnchorSnap(wp, worldThresh);
      const p1 = snap ? { x: snap.x, y: snap.y } : { x: wp.x, y: wp.y };
      setAddDrag({ p1, p2: p1, snapStart: snap || null, snapEnd: null });
      e.stopPropagation();
      e.preventDefault();
      return;
    }

    // Resize handle
    if (target.dataset?.resize) {
      const [compId, anchor] = target.dataset.resize.split('|');
      const comp = solved.find(c => c.id === compId);
      if (comp) {
        const wp = screenToWorld(e.clientX, e.clientY);
        const w = evalExpr(comp.w, paramValues);
        const h = evalExpr(comp.h, paramValues);
        setDrag({
          kind: 'resize',
          compId,
          anchor,
          startMouse: wp,
          startCx: comp.cx,
          startCy: comp.cy,
          startW: w,
          startH: h,
          wExpr: comp.w,
          hExpr: comp.h,
        });
        setSelection({ ids: new Set([compId]), primary: compId });
      }
      return;
    }

    // Component click
    if (target.dataset?.compId) {
      let id = target.dataset.compId;

      // Click-through for stacked overlap. The two-pass renderer
      // promotes the currently-selected component to the top so its
      // halo / handles stay visible — but that also makes it intercept
      // clicks that would otherwise hit a smaller, unselected component
      // sitting underneath. When the topmost SVG hit is already in our
      // selection, walk the document's element stack at the cursor and
      // prefer the first element under it that points at a different,
      // unselected component. That lets you build a multi-selection in
      // the natural visual order (e.g. large, then small for a subtract)
      // even when the small one is fully covered by the large one's bbox.
      if (selectedIds.has(id) && typeof document !== 'undefined' && typeof document.elementsFromPoint === 'function') {
        const stack = document.elementsFromPoint(e.clientX, e.clientY);
        for (const el of stack) {
          const cid = el?.dataset?.compId;
          if (cid && cid !== id && !selectedIds.has(cid)) {
            id = cid;
            break;
          }
        }
      }

      const wp = screenToWorld(e.clientX, e.clientY);

      // Cmd/Ctrl-click: toggle in selection (no drag)
      if (e.metaKey || e.ctrlKey) {
        const newIds = new Set(selectedIds);
        if (newIds.has(id)) {
          newIds.delete(id);
          setSelection({ ids: newIds, primary: newIds.size > 0 ? Array.from(newIds).pop() : null });
        } else {
          newIds.add(id);
          setSelection({ ids: newIds, primary: id });
        }
        return;
      }

      // Find root of snap chain for the clicked component.
      const findSnapRoot = (startId) => {
        let rid = startId;
        const seen = new Set();
        while (true) {
          const incoming = scene.snaps.find(s => s.to.compId === rid);
          if (!incoming || seen.has(rid)) break;
          seen.add(rid);
          rid = incoming.from.compId;
        }
        return rid;
      };
      const rootId = findSnapRoot(id);
      const rootComp = solved.find(c => c.id === rootId);
      // Boolean-cluster expansion: if the clicked component participates in
      // an enabled boolean, drag all its cluster mates' snap-roots together
      // so the boolean cluster moves as a single unit. Each co-mover is
      // remembered with its initial cx/cy so on mousemove we apply the
      // SAME (dx, dy) to all of them.
      const cluster = booleanClusters.memberToCluster[id];
      const coMoverIds = new Set([rootId]);
      if (cluster) {
        for (const memberId of cluster) {
          coMoverIds.add(findSnapRoot(memberId));
        }
      }
      // Walk consumedBy upward to the topmost containing boolean (if any).
      // Used to (a) translate the entire cluster when dragging an operand,
      // and (b) collect "do-not-snap-to-self" component ids so the alt-drag
      // snap target search ignores cluster siblings (preventing oscillation
      // from snap-to-self).
      const compById = Object.fromEntries(scene.components.map(c => [c.id, c]));
      const topmostContainingBoolean = (rid) => {
        let cur = compById[rid];
        let topBool = null;
        while (cur && cur.consumedBy) {
          const parent = compById[cur.consumedBy];
          if (!parent) break;
          topBool = parent;
          cur = parent;
        }
        return topBool;
      };
      // Recursive expansion: collect every primitive that needs to translate
      // by the drag delta. For a boolean root, recurse into its operands.
      // For a primitive root that's consumed by a boolean, walk up to the
      // boolean and pull in its sibling operands. The visited-booleans
      // guard prevents infinite recursion (boolean → operand → boolean …).
      const expandBooleanRoot = (rid, acc, visitedBooleans = new Set()) => {
        const c = compById[rid];
        if (!c) { acc.add(rid); return; }
        if (c.kind !== 'boolean') {
          acc.add(rid);
          const containing = topmostContainingBoolean(rid);
          if (containing && !visitedBooleans.has(containing.id)) {
            expandBooleanRoot(containing.id, acc, visitedBooleans);
          }
          return;
        }
        if (visitedBooleans.has(rid)) return;
        visitedBooleans.add(rid);
        for (const opid of (c.operandIds || [])) {
          // Skip operands that aren't actually consumed by this boolean.
          // Punch keeps its tools independent — they shouldn't be dragged
          // along when the boolean moves (HFSS "clone tool" semantics).
          const opC = compById[opid];
          if (!opC || opC.consumedBy !== c.id) continue;
          expandBooleanRoot(findSnapRoot(opid), acc, visitedBooleans);
        }
      };
      const expandedRoots = new Set();
      for (const rid of coMoverIds) {
        expandBooleanRoot(rid, expandedRoots);
      }
      const coMovers = [];
      for (const cid of expandedRoots) {
        const c = solved.find(cc => cc.id === cid);
        if (c) coMovers.push({ id: cid, startCx: c.cx, startCy: c.cy });
      }
      // Build the "do-not-snap-to-self" set: every co-mover plus every
      // boolean (recursively up the consumedBy chain) that contains them.
      // The alt-drag snap target search uses this to skip cluster siblings,
      // which would otherwise cause snap-to-self oscillation (their relative
      // position is fixed during a cluster drag, so the distance never
      // changes and the snap would re-fire every tick).
      const clusterSet = new Set(expandedRoots);
      for (const cid of expandedRoots) {
        let cur = compById[cid];
        while (cur && cur.consumedBy) {
          const parent = compById[cur.consumedBy];
          if (!parent) break;
          clusterSet.add(parent.id);
          cur = parent;
        }
      }
      // Also include any boolean directly in coMoverIds (e.g., when the
      // root walking landed on a boolean), so it won't snap-target itself.
      for (const rid of coMoverIds) {
        const c = compById[rid];
        if (c && c.kind === 'boolean') clusterSet.add(c.id);
      }
      // Compute the AABB of all co-movers at their START positions. This is
      // the "dragged shape" used by alt-drag anchor math. Using a single
      // operand's rect would misrepresent the composite's anchors.
      let cbMinX = Infinity, cbMaxX = -Infinity, cbMinY = Infinity, cbMaxY = -Infinity;
      for (const m of coMovers) {
        const c = solved.find(cc => cc.id === m.id);
        if (!c) continue;
        const cw = typeof c.w === 'number' ? c.w : evalExpr(c.w, paramValues);
        const ch = typeof c.h === 'number' ? c.h : evalExpr(c.h, paramValues);
        if (!Number.isFinite(cw) || !Number.isFinite(ch)) continue;
        const x0 = m.startCx - cw / 2, x1 = m.startCx + cw / 2;
        const y0 = m.startCy - ch / 2, y1 = m.startCy + ch / 2;
        if (x0 < cbMinX) cbMinX = x0; if (x1 > cbMaxX) cbMaxX = x1;
        if (y0 < cbMinY) cbMinY = y0; if (y1 > cbMaxY) cbMaxY = y1;
      }
      const clusterBboxCx = Number.isFinite(cbMinX) ? (cbMinX + cbMaxX) / 2 : (rootComp?.cx ?? 0);
      const clusterBboxCy = Number.isFinite(cbMinY) ? (cbMinY + cbMaxY) / 2 : (rootComp?.cy ?? 0);
      const clusterBboxW = Number.isFinite(cbMinX) ? (cbMaxX - cbMinX) : 0;
      const clusterBboxH = Number.isFinite(cbMinY) ? (cbMaxY - cbMinY) : 0;
      if (rootComp || coMovers.length > 0) {
        // If already in selection, drag it; otherwise replace selection with this one
        if (!selectedIds.has(id)) {
          setSelection({ ids: new Set([id]), primary: id });
        } else {
          setSelection({ ids: selectedIds, primary: id });
        }
        setDrag({
          kind: 'move',
          rootId,                       // semantic root (may be a boolean)
          clickedId: id,                // the component the user actually clicked (used for alt-drag snap install)
          startMouse: wp,               // mouse-down world position
          startCx: clusterBboxCx,       // cluster bbox center, used as reference for grid snap
          startCy: clusterBboxCy,
          clusterBboxW,                 // cluster bbox dimensions for alt-drag anchor math
          clusterBboxH,
          clusterSet,                   // ids to EXCLUDE from alt-drag snap target search
          coMovers,                     // primitives to translate by drag delta
        });
      }
      return;
    }

    // Background: alt-drag = marquee, plain drag = pan
    if (target === svgRef.current || target.dataset?.bg) {
      const wp = screenToWorld(e.clientX, e.clientY);
      if (e.altKey) {
        setMarquee({ startWorld: wp, currentWorld: wp, additive: e.shiftKey });
        if (!e.shiftKey) setSelection({ ids: new Set(), primary: null });
      } else {
        setPan({ startX: e.clientX, startY: e.clientY, startVX: viewport.x, startVY: viewport.y });
        setSelection({ ids: new Set(), primary: null });
      }
    }
  };

  const onMouseMove = (e) => {
    // Ruler: track current snap target for the preview dot/line
    if (rulerMode) {
      const wp = screenToWorld(e.clientX, e.clientY);
      const worldThresh = viewport.w * 0.012;
      const snap = findRulerSnap(wp, worldThresh);
      if (snap) setRulerSnapPoint(snap);
      else setRulerSnapPoint({ x: wp.x, y: wp.y, label: null });
    }
    // Add-drag: update p2 and re-evaluate snapEnd
    if (addMode && addDrag) {
      const wp = screenToWorld(e.clientX, e.clientY);
      const worldThresh = viewport.w * 0.012;
      const snap = findAnchorSnap(wp, worldThresh);
      const p2 = snap ? { x: snap.x, y: snap.y } : { x: wp.x, y: wp.y };
      setAddDrag({ ...addDrag, p2, snapEnd: snap || null });
    } else if (addMode && !addDrag) {
      // Pre-drag hover: show what point we'd snap to if the user clicked now.
      const wp = screenToWorld(e.clientX, e.clientY);
      const worldThresh = viewport.w * 0.012;
      const snap = findAnchorSnap(wp, worldThresh);
      setAddHoverSnap(snap || { x: wp.x, y: wp.y, compId: null, anchor: null });
    } else if (!addMode && addHoverSnap) {
      setAddHoverSnap(null);
    }
    // Track cursor position while picking anchors for the preview line
    if (snapMode === 'creating' && snapPick) {
      const wp = screenToWorld(e.clientX, e.clientY);
      setSnapCursor(wp);
    }
    if (drag) {
      const wp = screenToWorld(e.clientX, e.clientY);
      if (drag.kind === 'move') {
        let dx = wp.x - drag.startMouse.x;
        let dy = wp.y - drag.startMouse.y;
        // Shift = axis-lock: only move along the dominant axis from drag start
        if (shiftKey) {
          if (Math.abs(dx) >= Math.abs(dy)) dy = 0;
          else                              dx = 0;
        }
        // Option/Alt during move-drag: probe for an anchor on a DIFFERENT
        // component near the dragged rect (NOT near the cursor). The user's
        // gesture is "drag the rect close to another rect"; the cursor is
        // generally in the middle of the dragged rect, far from any target
        // anchor. So we instead find the closest pair of anchors between the
        // dragged rect (in its CURRENT proposed position) and any other
        // component, and if that distance is within threshold, snap them
        // exactly together. The visual preview shows the dragged rect
        // already snapped, and onMouseUp installs the real snap relationship.
        if (e.altKey) {
          const screenThresh = 30; // px — generous, since the gesture is approximate
          const worldThresh = screenThresh * (viewport.w / (svgRef.current?.clientWidth || 1));
          // The "dragged shape" is the CLUSTER's bbox (so anchor math reflects
          // the composite the user actually sees), not a single primitive.
          // Its proposed position = cluster's bbox-center at drag start +
          // mouse delta. Anchors are computed from the cluster bbox w/h.
          const proposedCx = drag.startCx + dx;
          const proposedCy = drag.startCy + dy;
          const dw = drag.clusterBboxW || 0;
          const dh = drag.clusterBboxH || 0;
          if (dw > 0 && dh > 0) {
            // Find closest (draggedAnchor, targetAnchor) pair across all
            // components that AREN'T part of this cluster. The clusterSet
            // contains every co-mover and every boolean that contains them,
            // preventing snap-to-self oscillation.
            //
            // HYSTERESIS: When `moveSnapHover` already holds a snap target
            // from a previous tick, we bias the search toward keeping it.
            // The current target gets a "stickiness bonus" — it's preferred
            // unless another candidate is significantly closer (the new
            // candidate must beat the current by a margin of stickThresh).
            // Without this, tiny mouse movements near anchor-pair switching
            // boundaries cause the cluster to flicker between snapped
            // positions ("oscillation") because the discrete winner of the
            // anchor-pair contest flips frequently. Cluster bbox center +
            // many sibling anchors create many near-equidistant candidates,
            // and the user perceives the cluster jumping around.
            const stickThresh = worldThresh * 0.5; // candidate must beat current by this margin
            let best = null;
            let currentBest = null; // the candidate matching the existing moveSnapHover, if any
            // Cluster bbox bounds at the proposed position (used by the
            // edge-pair pass below).
            const dxMin = proposedCx - dw / 2, dxMax = proposedCx + dw / 2;
            const dyMin = proposedCy - dh / 2, dyMax = proposedCy + dh / 2;
            for (const oc of solved) {
              if (drag.clusterSet && drag.clusterSet.has(oc.id)) continue;
              if (oc.consumedBy) continue;
              const ow = typeof oc.w === 'string' ? evalExpr(oc.w, paramValues) : oc.w;
              const oh = typeof oc.h === 'string' ? evalExpr(oc.h, paramValues) : oc.h;
              if (!Number.isFinite(ow) || !Number.isFinite(oh) || ow <= 0 || oh <= 0) continue;
              // -----------------------------------------------------------
              // (1) Anchor-pair candidates: every (dragged anchor, target
              //     anchor) pair across the 9-point grids. Distance is the
              //     2D distance between the two anchors at the dragged
              //     cluster's current proposed position; snap commits both
              //     axes when this kind wins.
              // -----------------------------------------------------------
              for (const ta of ANCHORS) {
                const tlp = anchorLocal(ta, ow, oh);
                const tx = oc.cx + tlp.x;
                const ty = oc.cy + tlp.y;
                for (const da of ANCHORS) {
                  const dlp = anchorLocal(da, dw, dh);
                  const dax = proposedCx + dlp.x;
                  const day = proposedCy + dlp.y;
                  const dist = Math.hypot(tx - dax, ty - day);
                  if (dist <= worldThresh) {
                    const cand = {
                      kind: 'anchor',
                      dist,
                      dAnchor: da,
                      target: { x: tx, y: ty, compId: oc.id, anchor: ta },
                    };
                    if (!best || dist < best.dist) best = cand;
                    if (moveSnapHover && moveSnapHover.kind === 'anchor' &&
                        moveSnapHover.compId === oc.id &&
                        moveSnapHover.anchor === ta &&
                        moveSnapHover.dAnchor === da) {
                      currentBest = cand;
                    }
                  }
                }
              }
              // -----------------------------------------------------------
              // (2) Edge-pair candidates: align a horizontal (or vertical)
              //     edge of the dragged cluster with a horizontal (or
              //     vertical) edge of the target, when the two bboxes
              //     overlap on the ORTHOGONAL axis. Distance is the 1-D
              //     offset between the two edges; only the snapped axis
              //     is constrained on placement — the other axis tracks
              //     the cursor — and no scene-level snap is created on
              //     release. Useful for "align bottoms" / "align tops"
              //     gestures where you want edge co-linearity but don't
              //     care about exact x positioning.
              // -----------------------------------------------------------
              const oxMin = oc.cx - ow / 2, oxMax = oc.cx + ow / 2;
              const oyMin = oc.cy - oh / 2, oyMax = oc.cy + oh / 2;
              const xOverlap = Math.min(oxMax, dxMax) - Math.max(oxMin, dxMin);
              const yOverlap = Math.min(oyMax, dyMax) - Math.max(oyMin, dyMin);
              // Edge candidates get a constant ranking penalty on top
              // of their raw 1-D distance. Without this, an edge pair
              // would always beat an anchor pair whenever they exist
              // together (the 2-D anchor distance is, by construction,
              // at least the 1-D edge distance). The penalty makes the
              // closest anchor pair win when it's within roughly half
              // a snap-threshold of the target — i.e. when the user
              // is clearly aiming at a corner / midpoint — and lets
              // edge alignment take over only when the cursor's
              // orthogonal offset is too big for any anchor to win.
              // Doesn't affect the threshold gate: an edge candidate
              // still has to be within worldThresh of the target
              // before being considered at all.
              const EDGE_RANK_PENALTY = worldThresh * 0.4;
              const tryEdge = (axis, dSide, dEdgeVal, tSide, tEdgeVal, midX, midY) => {
                const rawDist = Math.abs(dEdgeVal - tEdgeVal);
                if (rawDist > worldThresh) return;
                const cand = {
                  kind: 'edge',
                  dist: rawDist + EDGE_RANK_PENALTY,
                  rawDist,
                  axis,                  // 'h' = horizontal edges, snap Y
                  targetCompId: oc.id,
                  targetSide: tSide,     // 'top'/'bottom'/'centerY' or 'left'/'right'/'centerX'
                  dSide,                 // dragged-side equivalent
                  edgeVal: tEdgeVal,     // axis-aligned coord to snap to
                  x: midX, y: midY,      // representative point for the hover marker
                };
                if (!best || cand.dist < best.dist) best = cand;
                if (moveSnapHover && moveSnapHover.kind === 'edge' &&
                    moveSnapHover.axis === axis &&
                    moveSnapHover.targetCompId === oc.id &&
                    moveSnapHover.targetSide === tSide &&
                    moveSnapHover.dSide === dSide) {
                  currentBest = cand;
                }
              };
              if (xOverlap > 0) {
                const midX = (Math.max(oxMin, dxMin) + Math.min(oxMax, dxMax)) / 2;
                // Each axis exposes both edge candidates and a CENTER
                // candidate (the mid-line through the bbox center). The
                // center maps to the C anchor on commit, so snaps like
                // target.C → dragged.C with dx=offset, dy=0 give an
                // axis-locked center-line constraint that survives a
                // parametric sweep on either component's size.
                const dSidesY = [['top', dyMax], ['bottom', dyMin], ['centerY', proposedCy]];
                const tSidesY = [['top', oyMax], ['bottom', oyMin], ['centerY', oc.cy]];
                for (const [dSide, dY] of dSidesY) {
                  for (const [tSide, tY] of tSidesY) {
                    tryEdge('h', dSide, dY, tSide, tY, midX, tY);
                  }
                }
              }
              if (yOverlap > 0) {
                const midY = (Math.max(oyMin, dyMin) + Math.min(oyMax, dyMax)) / 2;
                const dSidesX = [['right', dxMax], ['left', dxMin], ['centerX', proposedCx]];
                const tSidesX = [['right', oxMax], ['left', oxMin], ['centerX', oc.cx]];
                for (const [dSide, dX] of dSidesX) {
                  for (const [tSide, tX] of tSidesX) {
                    tryEdge('v', dSide, dX, tSide, tX, tX, midY);
                  }
                }
              }
            }
            // If we have a current target and it's still valid (within
            // threshold), only swap to a different one if the new candidate
            // is meaningfully closer. This stops single-pixel mouse jitter
            // from flipping the chosen anchor pair.
            if (currentBest && best && currentBest !== best) {
              if (currentBest.dist - best.dist < stickThresh) {
                best = currentBest;
              }
            }
            // -----------------------------------------------------------
            // (3) Anchor-on-edge stickiness: edge snaps lock one axis and
            //     let the cluster track the cursor along the other. To
            //     make corners and midpoints feel "sticky" as the user
            //     slides along the locked edge, we run a focused scan
            //     over the 3 anchors lying on the chosen target side
            //     (and the matching dragged-side anchors) with an
            //     extended free-axis reach. The main anchor pass only
            //     accepts pairs whose full 2-D distance is within
            //     worldThresh; this sub-pass instead accepts pairs whose
            //     FREE-axis offset is within STICKY (deliberately larger
            //     than worldThresh), because the locked axis is about to
            //     be forced to coincide by the edge snap anyway. When a
            //     stickier match exists, promote it from edge to anchor
            //     so the commit locks both axes.
            //
            //     STICKY is set to 2.5x worldThresh so the user gets a
            //     pronounced detent at each anchor while sliding the
            //     cluster laterally along a long edge — corners and
            //     midpoint capture from a noticeable distance and the
            //     cluster jumps back to free tracking once the cursor
            //     crosses the boundary.
            // -----------------------------------------------------------
            // The override runs whenever the cluster is engaged in an
            // edge-style alt-drag (best === edge) — and ALSO when the
            // previous frame's moveSnapHover was an anchor we promoted
            // here, so the cluster doesn't release the anchor when the
            // cursor wanders just outside the main anchor pass's reach.
            const isStickyHoverContext = (
              (best && best.kind === 'edge') ||
              (moveSnapHover && moveSnapHover.kind === 'anchor' && moveSnapHover.viaEdge)
            );
            if (isStickyHoverContext) {
              const edgeAnchorMap = {
                h: { top: ['NW','N','NE'], bottom: ['SW','S','SE'], centerY: ['W','C','E'] },
                v: { left: ['NW','W','SW'], right: ['NE','E','SE'], centerX: ['N','C','S'] },
              };
              // Pick the axis/sides to scan: from the edge candidate when
              // best is edge, or from the prior frame's moveSnapHover edge
              // descriptor when we're holding an override-promoted anchor.
              const ctxAxis = best && best.kind === 'edge' ? best.axis
                : (moveSnapHover?.edgeAxis || null);
              const ctxTargetSide = best && best.kind === 'edge' ? best.targetSide
                : (moveSnapHover?.edgeTargetSide || null);
              const ctxDSide = best && best.kind === 'edge' ? best.dSide
                : (moveSnapHover?.edgeDSide || null);
              const ctxTargetCompId = best && best.kind === 'edge' ? best.targetCompId
                : (moveSnapHover?.compId || null);
              const tAnchorList = (ctxAxis && edgeAnchorMap[ctxAxis]?.[ctxTargetSide]) || [];
              const dAnchorList = (ctxAxis && edgeAnchorMap[ctxAxis]?.[ctxDSide]) || [];
              if (tAnchorList.length && dAnchorList.length && ctxTargetCompId) {
                const oc = solved.find(c => c.id === ctxTargetCompId);
                if (oc) {
                  const ow = typeof oc.w === 'string' ? evalExpr(oc.w, paramValues) : oc.w;
                  const oh = typeof oc.h === 'string' ? evalExpr(oc.h, paramValues) : oc.h;
                  if (Number.isFinite(ow) && Number.isFinite(oh) && ow > 0 && oh > 0) {
                    // STICKY is scaled to the target's free-axis edge
                    // length so the sticky zone is a visible fraction of
                    // the edge regardless of zoom or target size. A long
                    // 1000-unit top edge gives anchors at -500/0/+500 with
                    // a 200-unit sticky radius — the cluster catches the
                    // midpoint and each corner with a wide noticeable
                    // detent. A short edge falls back to worldThresh*2
                    // so we still get a screen-pixel detent.
                    const freeAxisLen = ctxAxis === 'h' ? ow : oh;
                    const STICKY = Math.max(worldThresh, freeAxisLen * 0.03);
                    let stickBest = null;
                    // Index-pair the anchor lists so we only consider
                    // NATURAL alignments along the edge:
                    //   leftmost ↔ leftmost (NW ↔ SW)
                    //   midpoint ↔ midpoint (N  ↔ S)
                    //   rightmost ↔ rightmost (NE ↔ SE)
                    // (Both edgeAnchorMap lists are ordered consistently:
                    // left→mid→right on h, top→mid→bottom on v.)
                    // Iterating 3×3 instead would let us snap the
                    // cluster's NW corner to the target's S midpoint —
                    // which lands the cluster's left edge at the target
                    // center, not the cluster's center. That's the wrong
                    // detent for an edge-slide gesture.
                    const pairCount = Math.min(tAnchorList.length, dAnchorList.length);
                    for (let i = 0; i < pairCount; i++) {
                      const ta = tAnchorList[i];
                      const da = dAnchorList[i];
                      const tlp = anchorLocal(ta, ow, oh);
                      const tx = oc.cx + tlp.x;
                      const ty = oc.cy + tlp.y;
                      const dlp = anchorLocal(da, dw, dh);
                      const dax = proposedCx + dlp.x;
                      const day = proposedCy + dlp.y;
                      // Only the FREE-axis distance matters here: the
                      // locked axis is forced to coincide by the edge
                      // snap itself.
                      const freeDist = ctxAxis === 'h'
                        ? Math.abs(tx - dax)
                        : Math.abs(ty - day);
                      if (freeDist <= STICKY) {
                        const cand = {
                          kind: 'anchor',
                          dist: freeDist,
                          dAnchor: da,
                          target: { x: tx, y: ty, compId: oc.id, anchor: ta },
                          // Mark this candidate as edge-stickiness-promoted
                          // so the next frame can keep it sticky even when
                          // the main edge candidate drops out.
                          viaEdge: true,
                          edgeAxis: ctxAxis,
                          edgeTargetSide: ctxTargetSide,
                          edgeDSide: ctxDSide,
                        };
                        if (!stickBest || freeDist < stickBest.dist) stickBest = cand;
                      }
                    }
                    if (stickBest) best = stickBest;
                  }
                }
              }
            }
            if (best) {
              let newCx = proposedCx, newCy = proposedCy;
              if (best.kind === 'anchor') {
                setMoveSnapHover({
                  kind: 'anchor', ...best.target, dAnchor: best.dAnchor,
                  // Pass through the edge-stickiness origin so the next
                  // frame can keep the anchor sticky beyond the main
                  // anchor pass's worldThresh reach.
                  viaEdge: !!best.viaEdge,
                  edgeAxis: best.edgeAxis,
                  edgeTargetSide: best.edgeTargetSide,
                  edgeDSide: best.edgeDSide,
                });
                // Place the cluster so its chosen anchor sits on the target.
                const dlp = anchorLocal(best.dAnchor, dw, dh);
                newCx = best.target.x - dlp.x;
                newCy = best.target.y - dlp.y;
              } else {
                // Edge snap: lock only one axis; the other tracks the cursor.
                setMoveSnapHover({
                  kind: 'edge', axis: best.axis,
                  targetCompId: best.targetCompId,
                  targetSide: best.targetSide,
                  dSide: best.dSide,
                  edgeVal: best.edgeVal,
                  x: best.x, y: best.y,
                });
                // Side → signed half-extent on the locked axis. 'top' /
                // 'right' add +half, 'bottom' / 'left' add −half, and the
                // 'center*' aliases sit on the bbox midpoint with no
                // offset.
                const dShiftY = (s) => s === 'top' ? dh / 2 : (s === 'bottom' ? -dh / 2 : 0);
                const dShiftX = (s) => s === 'right' ? dw / 2 : (s === 'left' ? -dw / 2 : 0);
                if (best.axis === 'h') {
                  newCy = best.edgeVal - dShiftY(best.dSide);
                } else {
                  newCx = best.edgeVal - dShiftX(best.dSide);
                }
              }
              // Translation applied to every co-mover.
              const tdx = newCx - drag.startCx;
              const tdy = newCy - drag.startCy;
              const moversById = Object.fromEntries((drag.coMovers || []).map(m => [m.id, m]));
              updateScene(prev => ({
                ...prev,
                components: prev.components.map(c => {
                  const m = moversById[c.id];
                  if (m) return { ...c, cx: m.startCx + tdx, cy: m.startCy + tdy };
                  return c;
                })
              }));
              return;
            } else {
              if (moveSnapHover) setMoveSnapHover(null);
            }
          }
        } else {
          // Clear any leftover snap target when Alt is released mid-drag.
          if (moveSnapHover) setMoveSnapHover(null);
        }
        const newCx = snapToGrid(drag.startCx + dx);
        const newCy = snapToGrid(drag.startCy + dy);
        const tdx = newCx - drag.startCx;
        const tdy = newCy - drag.startCy;
        const moversById = Object.fromEntries((drag.coMovers || []).map(m => [m.id, m]));
        updateScene(prev => ({
          ...prev,
          components: prev.components.map(c => {
            const m = moversById[c.id];
            if (m) return { ...c, cx: m.startCx + tdx, cy: m.startCy + tdy };
            return c;
          })
        }));
      } else if (drag.kind === 'resize') {
        // Compute new width/height based on dragging anchor opposite to fixed corner
        // Anchor names: NW, N, NE, W, E, SW, S, SE
        const dx = wp.x - drag.startMouse.x;
        const dy = wp.y - drag.startMouse.y;
        const a = drag.anchor;
        let newW = drag.startW;
        let newH = drag.startH;
        let newCx = drag.startCx;
        let newCy = drag.startCy;

        // Option/Alt = symmetric resize: the OPPOSITE edge mirrors the
        // dragged edge instead of staying fixed, so the rect grows/shrinks
        // about its center. Width/height delta is doubled (both sides move),
        // and cx/cy stay put.
        const symmetric = e.altKey;

        // Horizontal direction
        if (a.includes('E')) {
          if (symmetric) {
            newW = Math.max(0.1, drag.startW + 2 * dx);
            newCx = drag.startCx;
          } else {
            newW = Math.max(0.1, drag.startW + dx);
            newCx = drag.startCx + dx / 2;
          }
        } else if (a.includes('W')) {
          if (symmetric) {
            newW = Math.max(0.1, drag.startW - 2 * dx);
            newCx = drag.startCx;
          } else {
            newW = Math.max(0.1, drag.startW - dx);
            newCx = drag.startCx + dx / 2;
          }
        }
        // Vertical direction (y-up world)
        if (a.includes('N')) {
          if (symmetric) {
            newH = Math.max(0.1, drag.startH + 2 * dy);
            newCy = drag.startCy;
          } else {
            newH = Math.max(0.1, drag.startH + dy);
            newCy = drag.startCy + dy / 2;
          }
        } else if (a.includes('S')) {
          if (symmetric) {
            newH = Math.max(0.1, drag.startH - 2 * dy);
            newCy = drag.startCy;
          } else {
            newH = Math.max(0.1, drag.startH - dy);
            newCy = drag.startCy + dy / 2;
          }
        }

        // Grid snap on resize: snap the dragged anchor's position to grid
        if (gridSnapEnabled && !modifier) {
          // Snap the anchor's world position to grid, then back-compute w/h, cx/cy
          const anchorLoc = anchorLocal(a, newW, newH);
          const anchorWorldX = newCx + anchorLoc.x;
          const anchorWorldY = newCy + anchorLoc.y;
          const sx = snapToGrid(anchorWorldX);
          const sy = snapToGrid(anchorWorldY);
          const ddx = sx - anchorWorldX;
          const ddy = sy - anchorWorldY;
          // Adjust newW/newH/newCx/newCy by the snap delta
          if (a.includes('E')) { newW = Math.max(0.1, newW + ddx); newCx += ddx / 2; }
          else if (a.includes('W')) { newW = Math.max(0.1, newW - ddx); newCx += ddx / 2; }
          if (a.includes('N')) { newH = Math.max(0.1, newH + ddy); newCy += ddy / 2; }
          else if (a.includes('S')) { newH = Math.max(0.1, newH - ddy); newCy += ddy / 2; }
        }

        // Decide how to update w / h:
        //   - Single identifier (e.g., "aw"): the parameter IS the dimension.
        //     Update the parameter's expr to the new numeric value. Standard.
        //   - Multi-identifier expression (e.g., "cap_sep/2 - port_L/2"): the
        //     dimension is a derived quantity. We CAN'T cleanly turn the
        //     resize delta into changes to the underlying parameters, so we
        //     do nothing to the dimension — only cx/cy update. The user must
        //     edit the parameters directly to change such widths. Crucially,
        //     we also DON'T clobber c.w/c.h to a literal: that would break
        //     the parametric chain that other components (span rects) rely on.
        //   - Literal number (e.g., "30"): replace with the new numeric.
        const isSingleIdent = (s) => typeof s === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(s.trim());
        const isLiteralNum = (s) => typeof s === 'string' && /^[\d\s+\-*/.()]+$/.test(s.trim());
        const wIsParam = isSingleIdent(drag.wExpr);
        const hIsParam = isSingleIdent(drag.hExpr);
        const wIsLiteral = !wIsParam && isLiteralNum(drag.wExpr || '');
        const hIsLiteral = !hIsParam && isLiteralNum(drag.hExpr || '');
        // If w/h is an EXPRESSION (not single ident, not pure literal), we
        // leave it alone. The visual size won't reflect the drag attempt.
        const wIsExpr = !wIsParam && !wIsLiteral;
        const hIsExpr = !hIsParam && !hIsLiteral;

        updateScene(prev => {
          let newParams = prev.params;
          let newComps = prev.components.map(c => {
            if (c.id !== drag.compId) return c;
            const patch = { cx: newCx, cy: newCy };
            // Only overwrite c.w / c.h with a literal when it WAS a literal
            // before the resize. For single-ident params, the param itself
            // gets updated below (c.w stays the same identifier name). For
            // multi-ident expressions, leave c.w untouched (preserves chain).
            if (wIsLiteral) patch.w = newW.toFixed(3);
            if (hIsLiteral) patch.h = newH.toFixed(3);
            // For expression-bound dimensions, also DON'T update cx/cy —
            // since the dimension didn't change, the center shouldn't drift
            // either (otherwise the user sees the rect translate without
            // resizing, which is confusing).
            if (wIsExpr) patch.cx = c.cx;
            if (hIsExpr) patch.cy = c.cy;
            return { ...c, ...patch };
          });
          if (wIsParam) {
            const pName = drag.wExpr.trim();
            newParams = { ...newParams, [pName]: { ...newParams[pName], expr: newW.toFixed(3) } };
          }
          if (hIsParam) {
            const pName = drag.hExpr.trim();
            newParams = { ...newParams, [pName]: { ...newParams[pName], expr: newH.toFixed(3) } };
          }
          return { ...prev, params: newParams, components: newComps };
        });
      }
    } else if (pan) {
      const rect = svgRef.current.getBoundingClientRect();
      const dx = (e.clientX - pan.startX) * (viewport.w / rect.width);
      const dy = (e.clientY - pan.startY) * (viewport.h / rect.height);
      setViewport(v => ({ ...v, x: pan.startVX - dx, y: pan.startVY + dy }));
    } else if (marquee) {
      const wp = screenToWorld(e.clientX, e.clientY);
      setMarquee(m => ({ ...m, currentWorld: wp }));
    }
  };

  const onMouseUp = () => {
    // Commit add-drag: create the new component with sensible parametric bindings
    if (addDrag) {
      const { p1, p2, snapStart, snapEnd } = addDrag;
      const dx = p2.x - p1.x, dy = p2.y - p1.y;
      const dragDist = Math.sqrt(dx * dx + dy * dy);
      // Threshold: any drag bigger than half a grid unit counts as sized.
      // Smaller than that, treat as a click and drop a default 20×20 rect at p1.
      const minDrag = Math.max(0.5, gridSize / 2);
      if (dragDist >= minDrag) {
        commitDragAdd(addMode, p1, p2, snapStart, snapEnd);
      } else if (dragDist < minDrag && addMode) {
        // Click without drag: drop a default-sized rect at p1.
        const defaultHalf = 10;
        const fakeP1 = { x: p1.x - defaultHalf, y: p1.y - defaultHalf };
        const fakeP2 = { x: p1.x + defaultHalf, y: p1.y + defaultHalf };
        // If snapStart was set (you clicked exactly on an anchor) we still
        // want to snap; the new component centers on the click and an SW/NE
        // corner won't quite line up, so use no snap in this branch and let
        // the user reposition manually.
        commitDragAdd(addMode, fakeP1, fakeP2, snapStart, null);
      }
      setAddDrag(null);
      setAddMode(null); // one-shot tool — exit add mode after commit
      return;
    }
    // Commit marquee selection
    if (marquee) {
      const x1 = Math.min(marquee.startWorld.x, marquee.currentWorld.x);
      const x2 = Math.max(marquee.startWorld.x, marquee.currentWorld.x);
      const y1 = Math.min(marquee.startWorld.y, marquee.currentWorld.y);
      const y2 = Math.max(marquee.startWorld.y, marquee.currentWorld.y);
      // Only commit if user dragged at least a tiny amount
      if (x2 - x1 > 0.001 || y2 - y1 > 0.001) {
        const hits = solved.filter(c => {
          const w = evalExpr(c.w, paramValues);
          const h = evalExpr(c.h, paramValues);
          // intersection test (component bbox vs marquee bbox)
          const cx1 = c.cx - w / 2, cx2 = c.cx + w / 2;
          const cy1 = c.cy - h / 2, cy2 = c.cy + h / 2;
          return cx2 >= x1 && cx1 <= x2 && cy2 >= y1 && cy1 <= y2;
        }).map(c => c.id);
        const newIds = marquee.additive ? new Set([...selectedIds, ...hits]) : new Set(hits);
        setSelection({ ids: newIds, primary: hits.length > 0 ? hits[hits.length - 1] : null });
      }
    }
    // Commit alt-drag snap: if the user was move-dragging with Alt and a
    // snap target was hovered at release, install a snap from the target's
    // anchor to the dragged component's nearest anchor (the same anchor
    // that was used for visual previewing during the move). This gives a
    // smooth "drag-toward-something-and-let-go" gesture for connecting
    // components without entering the explicit snap-creation tool.
    if (drag && drag.kind === 'move' && moveSnapHover) {
      // Both anchor and edge alt-drag releases install a persistent
      // scene-level snap. For edge alignments the snap is anchor-based
      // too (we pick the canonical N/S or E/W anchors), and the free
      // axis is captured as the current literal offset so the user's
      // mid-drag X (or Y) position is preserved — they can still tune
      // it via the auto-created gap_* parameter later.
      const target = moveSnapHover;
      // The "dragged" component for snap purposes is the one the user
      // clicked on — typically the boolean itself when dragging a composite,
      // not the snap-chain root (which could be a different component
      // higher up the chain). The visual preview placed the cluster's
      // bbox-anchor on the target, so the installed snap should attach to
      // the clicked component to match user intent.
      const dragId = drag.clickedId || drag.rootId;
      const draggedComp = solved.find(c => c.id === dragId);

      // Resolve target compId + the (target anchor, dragged anchor, dx, dy)
      // tuple based on which kind of preview was active.
      let targetCompId = null;
      let targetAnchor = null;       // anchor on the target
      let draggedAnchor = null;      // anchor on the dragged comp
      // The dx/dy we want to commit. For anchor snaps the values are
      // zero (the two anchors coincide); for edge snaps the free axis
      // captures the current literal offset between the two anchors.
      let initDx = 0, initDy = 0;

      if (target.kind === 'anchor') {
        targetCompId  = target.compId;
        targetAnchor  = target.anchor;
        draggedAnchor = target.dAnchor || 'C';
      } else {
        // Edge alignment: choose the canonical anchor on the aligned
        // line. Edges map to N / S / E / W; center-lines map to C
        // (the 2-D bbox center, which lies on both the horizontal and
        // vertical center lines). With dx (or dy) = the free-axis
        // offset and the other axis = 0, a C → C snap locks one axis
        // and frees the other — exactly the center-line behavior we
        // want.
        const edgeAnchor = (axis, side) => {
          if (side === 'centerY' || side === 'centerX') return 'C';
          if (axis === 'h') return side === 'top' ? 'N' : 'S';
          return side === 'right' ? 'E' : 'W';
        };
        targetCompId  = target.targetCompId;
        targetAnchor  = edgeAnchor(target.axis, target.targetSide);
        draggedAnchor = edgeAnchor(target.axis, target.dSide);
        // Capture the free-axis offset. Anchors land at the midpoint of
        // their respective edges (N/S sit on cx; E/W sit on cy), so the
        // relative offset between the two anchors on the FREE axis is
        // exactly draggedComp.center − targetComp.center on that axis.
        const targetComp = solved.find((c) => c.id === targetCompId);
        if (draggedComp && targetComp) {
          if (target.axis === 'h') {
            initDx = draggedComp.cx - targetComp.cx;
          } else {
            initDy = draggedComp.cy - targetComp.cy;
          }
        }
      }

      if (draggedComp && targetCompId && targetCompId !== dragId) {
        // Auto-reverse if the dragged component is already the `to` of
        // an existing snap (only one parent is allowed). If both ends
        // are already constrained, abort with a helpful message and
        // leave the literal cx/cy from the move in place.
        const draggedHasIncoming = scene.snaps.some(s => s.to.compId === dragId);
        const targetHasIncoming  = scene.snaps.some(s => s.to.compId === targetCompId);
        let fromCompId, fromAnchor, toCompId, toAnchor, finalDx, finalDy;
        if (!draggedHasIncoming) {
          // Standard direction: target is the parent of the dragged comp.
          fromCompId = targetCompId;  fromAnchor = targetAnchor;
          toCompId   = dragId;         toAnchor   = draggedAnchor;
          finalDx = initDx; finalDy = initDy;
        } else if (!targetHasIncoming) {
          // Reverse so target becomes child. Flipping direction also
          // flips the sign of the offset we computed.
          fromCompId = dragId;          fromAnchor = draggedAnchor;
          toCompId   = targetCompId;    toAnchor   = targetAnchor;
          finalDx = -initDx; finalDy = -initDy;
        } else {
          alertDialog(
            `Both ${dragId} and ${targetCompId} are already positioned by another snap. Re-root one of them first (use the ⇄ button in the inspector) to free a target.`,
            'Cannot create snap'
          );
          setDrag(null);
          setMoveSnapHover(null);
          return;
        }
        // Pick fresh gap-parameter names. The captured offset is the
        // expression value; the user can tune it later in the inspector.
        const usedNames = new Set(Object.keys(scene.params));
        const nextName = (prefix) => {
          let i = 1;
          while (usedNames.has(`${prefix}${i}`)) i++;
          usedNames.add(`${prefix}${i}`);
          return `${prefix}${i}`;
        };
        const gapX = nextName('gap_x');
        const gapY = nextName('gap_y');
        // Round captured offsets to 4 decimals — the user is dragging by
        // mouse, so sub-µm precision past that is noise.
        const fmt = (v) => Number(v.toFixed(4)).toString();
        const dxExpr = fmt(finalDx);
        const dyExpr = fmt(finalDy);
        updateScene(prev => ({
          ...prev,
          params: {
            ...prev.params,
            [gapX]: { expr: dxExpr, unit: 'µm', desc: `Gap ${fromCompId}.${fromAnchor} → ${toCompId}.${toAnchor} (dx)` },
            [gapY]: { expr: dyExpr, unit: 'µm', desc: `Gap ${fromCompId}.${fromAnchor} → ${toCompId}.${toAnchor} (dy)` },
          },
          snaps: [...prev.snaps, {
            id: `snap_${Date.now()}`,
            from: { compId: fromCompId, anchor: fromAnchor },
            to:   { compId: toCompId,   anchor: toAnchor },
            dx: gapX, dy: gapY,
          }],
        }));
      }
      setDrag(null);
      setMoveSnapHover(null);
      return;
    }
    setDrag(null);
    setPan(null);
    setMarquee(null);
    if (moveSnapHover) setMoveSnapHover(null);
  };

  const onAnchorClick = (compId, anchor, evt) => {
    if (snapMode !== 'creating') return;
    if (!snapPick) {
      setSnapPick({ compId, anchor });
      return;
    }
    if (snapPick.compId === compId) return;
    const fromComp = solved.find(c => c.id === snapPick.compId);
    const toComp = solved.find(c => c.id === compId);
    if (!fromComp || !toComp) return;

    // Determine snap direction. A snap's `to` component is the one whose
    // position the snap dictates. A component can only be the `to` of one
    // snap. If our intended `to` (the second-clicked component) is already
    // constrained by another snap, reverse direction so the other partner is
    // the moved one. If both are already constrained, we can't add a useful
    // constraint — explain to the user why nothing happened.
    const isFirstConstrained  = scene.snaps.some(sn => sn.to.compId === snapPick.compId);
    const isSecondConstrained = scene.snaps.some(sn => sn.to.compId === compId);

    if (isFirstConstrained && isSecondConstrained) {
      const blockerOnFirst  = scene.snaps.find(sn => sn.to.compId === snapPick.compId);
      const blockerOnSecond = scene.snaps.find(sn => sn.to.compId === compId);
      // Cancel the snap-creation interaction and tell the user.
      setSnapPick(null);
      setSnapHover(null);
      setSnapCursor(null);
      setSnapMode('idle');
      if (alertDialog) {
        alertDialog(
          `Cannot create this snap because both components are already positioned by other snaps:\n\n` +
          `  • "${snapPick.compId}" is moved by snap "${blockerOnFirst.id}" (parent: ${blockerOnFirst.from.compId})\n` +
          `  • "${compId}" is moved by snap "${blockerOnSecond.id}" (parent: ${blockerOnSecond.from.compId})\n\n` +
          `A snap moves one component to satisfy a relationship with another. If both components are already pinned by other snaps, there's nothing left for this snap to do — adding it would silently conflict.\n\n` +
          `To proceed, break one of the existing snaps first (click the unlink icon in the snap inspector for the component you want to free) and try again.`,
          'Snap not created'
        );
      }
      return;
    }

    const fromW = anchorWorld(fromComp, snapPick.anchor, paramValues);
    const toW = anchorWorld(toComp, anchor, paramValues);
    let dx = toW.x - fromW.x;
    let dy = toW.y - fromW.y;
    // Shift held = axis-lock the resulting offset to a single axis (zero the smaller delta)
    const shiftHeld = !!(evt && evt.shiftKey);
    if (shiftHeld) {
      if (Math.abs(dx) < Math.abs(dy)) dx = 0; else dy = 0;
    }

    // Decide snap direction (auto-reverse if the user-intended `to` is already constrained)
    let actualFrom, actualFromAnchor, actualTo, actualToAnchor, actualDx, actualDy, didReverse = false;
    if (!isSecondConstrained) {
      actualFrom = snapPick.compId; actualFromAnchor = snapPick.anchor;
      actualTo = compId;             actualToAnchor = anchor;
      actualDx = dx; actualDy = dy;
    } else {
      // isSecondConstrained && !isFirstConstrained (the both-constrained case is already handled above)
      didReverse = true;
      actualFrom = compId;            actualFromAnchor = anchor;
      actualTo = snapPick.compId;     actualToAnchor = snapPick.anchor;
      actualDx = -dx; actualDy = -dy;
    }

    updateScene(prev => {
      // Build helper to find unused gap parameter name
      const usedNames = new Set(Object.keys(prev.params));
      const nextGapName = (prefix) => {
        let i = 1;
        while (usedNames.has(`${prefix}${i}`)) i++;
        usedNames.add(`${prefix}${i}`);
        return `${prefix}${i}`;
      };
      const newParams = { ...prev.params };
      const nameX = nextGapName('gap_x');
      newParams[nameX] = {
        expr: Math.abs(actualDx) < 1e-3 ? '0' : actualDx.toFixed(3),
        unit: 'µm',
        desc: `Gap ${actualFrom}.${actualFromAnchor} → ${actualTo}.${actualToAnchor} (dx)`,
      };
      const nameY = nextGapName('gap_y');
      newParams[nameY] = {
        expr: Math.abs(actualDy) < 1e-3 ? '0' : actualDy.toFixed(3),
        unit: 'µm',
        desc: `Gap ${actualFrom}.${actualFromAnchor} → ${actualTo}.${actualToAnchor} (dy)`,
      };
      const newSnap = {
        id: `snap_${Date.now()}`,
        from: { compId: actualFrom, anchor: actualFromAnchor },
        to:   { compId: actualTo,   anchor: actualToAnchor },
        dx: nameX, dy: nameY,
      };
      return { ...prev, params: newParams, snaps: [...prev.snaps, newSnap] };
    });
    // (didReverse is computed for potential future "snap was reversed" toast; not surfaced today)
    void didReverse;

    setSnapPick(null);
    setSnapHover(null);
    setSnapCursor(null);
    setSnapMode('idle');
  };

  const vbX = viewport.x - viewport.w / 2;
  const vbY = -(viewport.y + viewport.h / 2);
  const layerStyle = {
    waveguide: { fill: '#3ec27a', stroke: '#1a5e36', opacity: 0.8 },
    electrode: { fill: '#f4a72e', stroke: '#7a4d00', opacity: 0.85 },
    // Lumped port: non-physical layer for HFSS port assignment. Rendered as a
    // dark-red translucent rectangle so it stands out against waveguides and
    // electrodes; not part of the layer stack and not exported as a metal sheet.
    port:      { fill: '#b91c1c', stroke: '#7f1d1d', opacity: 0.45 },
  };

  // Sized-relative handle radius and stroke unit. Both scale with the
  // viewport so that overlays (arrows, handles, halos) keep their on-screen
  // proportions constant regardless of zoom level. Without this, the SVG's
  // viewBox shrinks as you zoom in but world-unit stroke widths stay fixed,
  // and overlays appear progressively thicker until they collapse into dots.
  const hr = Math.max(viewport.w, viewport.h) / 250;
  const sw = Math.max(viewport.w, viewport.h) / 1500; // baseline 1px-ish stroke in world units
  const HALO_W = sw * 3.6; // selection halo width — also used for snap-network dashes
  // Minimum hit-target footprint in world units, derived from the current
  // viewport / SVG ratio. Below this threshold each component gets an
  // invisible "hit pad" rect that extends its clickable area so the user
  // can grab very thin shapes (sub-pixel-tall waveguides, thin cutouts,
  // etc.) without accidentally missing onto the background — which
  // otherwise turns an intended alt-drag into a marquee selection.
  const MIN_HIT_PX = 8;
  const pxPerWorld = (svgRef.current?.clientWidth || 1) / viewport.w;
  const minHitWorld = pxPerWorld > 0 ? MIN_HIT_PX / pxPerWorld : 0;

  return (
    <svg
      ref={svgRef}
      viewBox={`${vbX} ${vbY} ${viewport.w} ${viewport.h}`}
      preserveAspectRatio="xMidYMid meet"
      className="w-full h-full"
      style={{ background: '#f1f5f9', cursor: addMode ? 'crosshair' : (marquee ? 'crosshair' : (altKey ? 'crosshair' : (pan ? 'grabbing' : (drag?.kind === 'move' ? 'move' : 'default')))) }}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={onMouseUp}
      onWheel={onWheel}
      onContextMenu={(e) => {
        // Right-click on a component opens the App-level context menu.
        // Right-click on the bare canvas falls through to the browser's
        // own menu (no preventDefault) so DevTools / "save image" stay
        // accessible during dev.
        const cid = e.target?.dataset?.compId;
        if (!cid || !onComponentContextMenu) return;
        e.preventDefault();
        // Replace the selection with this component if it isn't already
        // included, so the menu operations have a clear target.
        if (!selectedIds.has(cid)) {
          setSelection({ ids: new Set([cid]), primary: cid });
        }
        onComponentContextMenu({ compId: cid, x: e.clientX, y: e.clientY });
      }}
    >
      <defs>
        <pattern id="grid" width={gridSize} height={gridSize} patternUnits="userSpaceOnUse">
          <path d={`M ${gridSize} 0 L 0 0 0 ${gridSize}`} fill="none" stroke="#cbd5e1" strokeWidth="0.3" />
        </pattern>
        <pattern id="gridMajor" width={gridSize * 5} height={gridSize * 5} patternUnits="userSpaceOnUse">
          <path d={`M ${gridSize * 5} 0 L 0 0 0 ${gridSize * 5}`} fill="none" stroke="#94a3b8" strokeWidth="0.4" />
        </pattern>
        {/* Arrowhead for lumped-port integration line. markerUnits=
            strokeWidth scales the arrowhead with the line's strokeWidth
            so it stays proportional at any zoom. orient=auto-start-reverse
            isn't widely supported in older browsers; the line itself is
            drawn so the arrow always points from start to end of the
            integration vector. */}
        <marker id="lp-arrow" viewBox="0 0 10 10" refX="9" refY="5"
          markerUnits="strokeWidth" markerWidth="5" markerHeight="5" orient="auto">
          <path d="M0,0 L10,5 L0,10 z" fill="#ef4444" opacity="0.85" />
        </marker>
      </defs>
      <rect data-bg="true" x={vbX} y={vbY} width={viewport.w} height={viewport.h} fill="url(#grid)" />
      <rect data-bg="true" x={vbX} y={vbY} width={viewport.w} height={viewport.h} fill="url(#gridMajor)" />

      <line x1={vbX} y1={0} x2={vbX + viewport.w} y2={0} stroke="#475569" strokeWidth={sw * 0.7} strokeDasharray={`${sw * 3},${sw * 3}`} pointerEvents="none" />
      <line x1={0} y1={vbY} x2={0} y2={vbY + viewport.h} stroke="#475569" strokeWidth={sw * 0.7} strokeDasharray={`${sw * 3},${sw * 3}`} pointerEvents="none" />

      {/* Mirror axes */}
      {scene.mirrors.map(m => (
        m.axis === 'horizontal' ? (
          <line key={m.id} x1={vbX} y1={-m.axisCoord} x2={vbX + viewport.w} y2={-m.axisCoord} stroke="#a855f7" strokeWidth={sw * 0.8} strokeDasharray={`${sw * 4},${sw * 3}`} opacity={0.6} pointerEvents="none" />
        ) : (
          <line key={m.id} x1={m.axisCoord} y1={vbY} x2={m.axisCoord} y2={vbY + viewport.h} stroke="#a855f7" strokeWidth={sw * 0.8} strokeDasharray={`${sw * 4},${sw * 3}`} opacity={0.6} pointerEvents="none" />
        )
      ))}

      {/* ===== Boolean cluster rendering =====
          Each boolean component renders as a unified visual using SVG
          mask/clip primitives. Operands may themselves be derived boolean
          components — in that case we recurse, building nested masks/clips
          that compose correctly. The browser performs polygon clipping at
          rasterization time, exact for our axis-aligned and rotated
          rectangle inputs.

          Each operand contributes one of two SVG "shapes":
            - For a primitive: a single <path d="..."/> for its rect.
            - For a derived boolean: a <g> that collectively fills the
              boolean's interior, using its own mask/clip composition.
          Both can be used inside a parent mask/clipPath as long as fills
          are set correctly (white for "include" in a mask, parent fills
          for clip contents).

          Per-op masking strategy:
            UNION:    each operand outline masked by NOT(other operands)
                      → only edges on the union perimeter survive.
            INTERSECT: each operand outline clipped by intersection of
                      OTHER operands' interiors → only edges that bound the
                      intersection survive.
            SUBTRACT:  base outline masked by NOT(subtractors), plus each
                      subtractor outline clipped by base interior.
       */}
      {(() => {
        // ID generator scoped to a single render pass; ensures defs ids are
        // unique even when the same component appears in multiple booleans.
        let _defIdCounter = 0;
        const nextDefId = (prefix) => `${prefix}-${_defIdCounter++}`;
        // Map id → component for recursive resolution.
        const compById = Object.fromEntries(scene.components.map(c => [c.id, c]));
        // Resolve a component's first rendered instance (post-transform).
        // The optional `overrides` map lets callers force a specific
        // instance for one or more compIds — used by the boolean renderer
        // when expanding a transform chain: each rendered copy of a
        // boolean rebuilds its operands at the rotated/translated position
        // for that particular copy, and the override map plumbs those
        // synthetic instances through the recursive renderInterior /
        // renderOutline / collectBbox chain without needing an outer SVG
        // <g transform> (whose interaction with mask coordinates is
        // surprising and was preventing rotated booleans from appearing).
        const instOf = (c, overrides) => {
          if (overrides && overrides[c.id]) return overrides[c.id];
          const list = instancesByCompId[c.id] || [];
          return list[0] || {
            compId: c.id, idx: 0, cx: c.cx, cy: c.cy,
            w: evalExpr(c.w, paramValues), h: evalExpr(c.h, paramValues),
            rotation: 0,
          };
        };
        // Path "d" string for an instance, dispatching on the instance's
        // shape kind via shapeInstanceToRing (circles/ellipses/polygons
        // become tessellated rings; rectangles use their 4-corner ring).
        const rectPathD = (inst) => ringToSvgPath(shapeInstanceToRing(inst));

        // Flat-bbox collector used for mask viewport sizing; recurses
        // through derived operands so the bbox covers the entire object.
        const collectBbox = (comp, overrides) => {
          const out = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
          const visit = (c) => {
            if (!c) return;
            if (c.kind === 'boolean') {
              for (const id of (c.operandIds || [])) visit(compById[id]);
            } else {
              const ring = shapeInstanceToRing(instOf(c, overrides));
              for (const [x, y] of ring) {
                if (x < out.minX) out.minX = x; if (x > out.maxX) out.maxX = x;
                if (y < out.minY) out.minY = y; if (y > out.maxY) out.maxY = y;
              }
            }
          };
          visit(comp);
          return out;
        };

        // Compose a boolean's per-instance transform (translation + rotation
        // about the instance centroid) onto each operand's base instance so
        // the operands render at the rotated/translated position directly.
        // Returns a map compId -> synthetic instance for every operand
        // (recursively, through nested booleans), or null if the boolean has
        // no transforms.
        const buildBoolInstanceOverrides = (b, bInst, bBaseCx, bBaseCy) => {
          const dx = bInst.cx - bBaseCx;
          const dy = bInst.cy - bBaseCy;
          const rot = bInst.rotation || 0;
          const bSx = bInst.scaleX ?? 1;
          const bSy = bInst.scaleY ?? 1;
          if (!dx && !dy && !rot && bSx === 1 && bSy === 1) return null;
          const rad = rot * Math.PI / 180;
          const ca = Math.cos(rad), sa = Math.sin(rad);
          const overrides = {};
          // Walk the boolean's operand tree, transforming each PRIMITIVE
          // operand it finds. Nested booleans' operands also get
          // transformed; the parent boolean's transform applies uniformly
          // to every descendant.
          const visit = (c) => {
            if (!c) return;
            if (c.kind === 'boolean') {
              for (const id of (c.operandIds || [])) visit(compById[id]);
              return;
            }
            // Take the operand's base (un-transformed-by-the-boolean)
            // instance. Note this is the operand's OWN first instance
            // (which already accounts for the operand's own transforms,
            // if any — though operands consumed by a boolean typically
            // have no transforms of their own).
            const base = instOf(c);
            // Translate by (dx, dy), then rotate by `rot` about the
            // instance centroid (which equals bInst.cx, bInst.cy after
            // translation). This matches expandTransforms' semantics: for
            // pivot='C' on a cluster, each instance's cx,cy already lives
            // in world-space at the rotated location, so rotating the
            // operand cluster about that same point reproduces the rotated
            // cluster.
            // Step 1: translate the operand by (dx, dy) so its position is
            // expressed in the post-translation frame around bInst.
            const tx = base.cx + dx;
            const ty = base.cy + dy;
            // Step 2: if the boolean carries a mirror, reflect the operand
            // about the boolean's instance center along the appropriate
            // axis. This flips the operand's position AND toggles its own
            // scale flags so the operand's shape (rect corners, polygon
            // vertices, …) renders mirrored, not just repositioned.
            let mx = tx, my = ty;
            let opSx = base.scaleX ?? 1, opSy = base.scaleY ?? 1;
            if (bSx === -1) { mx = 2 * bInst.cx - tx; opSx = -opSx; }
            if (bSy === -1) { my = 2 * bInst.cy - ty; opSy = -opSy; }
            // Step 3: rotate the (translated-then-mirrored) point about
            // the boolean's instance center. expandTransforms already
            // negated rotation when a mirror fired, so the recorded `rot`
            // is correct for the final orientation.
            const rx = mx - bInst.cx;
            const ry = my - bInst.cy;
            const newCx = rot ? bInst.cx + rx * ca - ry * sa : mx;
            const newCy = rot ? bInst.cy + rx * sa + ry * ca : my;
            overrides[c.id] = {
              ...base,
              cx: newCx,
              cy: newCy,
              rotation: (base.rotation || 0) + rot,
              scaleX: opSx,
              scaleY: opSy,
            };
          };
          visit(b);
          return overrides;
        };

        // Recursively render an object's INTERIOR as SVG. The output is a
        // <g> (or <path>) whose drawn pixels equal the interior region of
        // the object, filled with `fillColor`. This is composable: it can
        // be nested inside <mask>, <clipPath>, or rendered directly.
        // For mask use: pass fillColor = 'white' (and add a black background
        // outside).
        // For direct rendering: pass the object's display fill color.
        // For "subtract" inside a parent mask: pass 'black' (the operand's
        // interior overrides the white base in the mask).
        //
        // `depth` is for unique key generation; bumped per nesting level.
        const renderInterior = (comp, fillColor, keyBase, dataCompId, parentClip, overrides) => {
          if (!comp) return null;
          const isPrim = comp.kind !== 'boolean';
          if (isPrim) {
            const inst = instOf(comp, overrides);
            return (
              <path
                key={keyBase}
                d={rectPathD(inst)}
                fill={fillColor}
                {...(dataCompId ? { 'data-comp-id': dataCompId } : {})}
                {...(parentClip ? { clipPath: parentClip } : {})}
              />
            );
          }
          // Derived boolean operand. Resolve children components.
          const ops = (comp.operandIds || []).map(id => compById[id]).filter(Boolean);
          if (ops.length < 2) return null;
          if (comp.op === 'union') {
            // Render every operand's interior with the same fillColor; their
            // overlapping fills (in subtractive/additive raster terms) form
            // the union region. For mask use this is correct: white
            // overlapping white = white. For display fill: same color
            // overlapping = same color.
            return (
              <g key={keyBase}>
                {ops.map((opC, i) => renderInterior(opC, fillColor, `${keyBase}-u${i}`, dataCompId, parentClip, overrides))}
              </g>
            );
          }
          if (comp.op === 'intersect') {
            // Build a chain of clipPaths so operand[0] is clipped by
            // operand[1] is clipped by operand[2] etc. Each clipPath's
            // content is the operand's interior.
            const chainIds = [];
            const chainDefs = [];
            for (let i = 1; i < ops.length; i++) {
              const id = nextDefId(`${keyBase}-isectclip-${i}`);
              const parentId = i > 1 ? chainIds[i - 2] : (parentClip ? parentClip.replace(/^url\(#|\)$/g, '') : null);
              chainIds.push(id);
              chainDefs.push(
                <clipPath key={id} id={id} clipPathUnits="userSpaceOnUse">
                  {renderInterior(ops[i], 'white', `${id}-c`, undefined, parentId ? `url(#${parentId})` : undefined, overrides)}
                </clipPath>
              );
            }
            const finalClip = chainIds.length ? `url(#${chainIds[chainIds.length - 1]})` : parentClip;
            return (
              <g key={keyBase}>
                <defs>{chainDefs}</defs>
                {renderInterior(ops[0], fillColor, `${keyBase}-i0`, dataCompId, finalClip, overrides)}
              </g>
            );
          }
          if (comp.op === 'subtract' || comp.op === 'punch') {
            // base operand drawn in `fillColor`, with a mask that has the
            // base's interior in white minus subtractors' interiors in black.
            // 'punch' is rendered identically to 'subtract' here — the
            // distinction only matters for consumedBy tagging and the
            // keep_originals export flag.
            const maskId = nextDefId(`${keyBase}-submask`);
            const bbox = collectBbox(comp, overrides);
            const pad = Math.max(bbox.maxX - bbox.minX, bbox.maxY - bbox.minY) * 0.1 + 1;
            const mvX = bbox.minX - pad, mvY = bbox.minY - pad;
            const mvW = (bbox.maxX - bbox.minX) + 2 * pad;
            const mvH = (bbox.maxY - bbox.minY) + 2 * pad;
            return (
              <g key={keyBase}>
                <defs>
                  <mask id={maskId} maskUnits="userSpaceOnUse"
                    x={mvX} y={-mvY - mvH} width={mvW} height={mvH}>
                    <rect x={mvX} y={-mvY - mvH} width={mvW} height={mvH} fill="black" />
                    {renderInterior(ops[0], 'white', `${maskId}-base`, undefined, undefined, overrides)}
                    {ops.slice(1).map((opC, i) =>
                      renderInterior(opC, 'black', `${maskId}-sub${i}`, undefined, undefined, overrides)
                    )}
                  </mask>
                </defs>
                <g mask={`url(#${maskId})`}>
                  {renderInterior(ops[0], fillColor, `${keyBase}-baseunder`, dataCompId, parentClip, overrides)}
                </g>
              </g>
            );
          }
          return null;
        };

        // Render the OUTLINE of an object. Returns SVG that traces the
        // visible perimeter. For a primitive: just stroke the rect path.
        // For a derived boolean: stroke each operand's perimeter with the
        // appropriate mask/clip so only edges on the result boundary
        // contribute. Recursive — operands can themselves be booleans.
        const renderOutline = (comp, strokeColor, strokeW, keyBase, overrides) => {
          if (!comp) return null;
          const isPrim = comp.kind !== 'boolean';
          if (isPrim) {
            const inst = instOf(comp, overrides);
            return (
              <path key={keyBase} d={rectPathD(inst)}
                fill="none" stroke={strokeColor} strokeWidth={strokeW}
                pointerEvents="none"
              />
            );
          }
          const ops = (comp.operandIds || []).map(id => compById[id]).filter(Boolean);
          if (ops.length < 2) return null;
          if (comp.op === 'union') {
            // Each operand's outline masked by the union of OTHER operands'
            // interiors (in black) → edges inside other operands hidden.
            // Build one mask per operand.
            return (
              <g key={keyBase}>
                {ops.map((opC, i) => {
                  const maskId = nextDefId(`${keyBase}-uout${i}`);
                  const bbox = collectBbox(comp, overrides);
                  const pad = Math.max(bbox.maxX - bbox.minX, bbox.maxY - bbox.minY) * 0.1 + 1;
                  const mvX = bbox.minX - pad, mvY = bbox.minY - pad;
                  const mvW = (bbox.maxX - bbox.minX) + 2 * pad;
                  const mvH = (bbox.maxY - bbox.minY) + 2 * pad;
                  return (
                    <g key={`${keyBase}-uo${i}`}>
                      <defs>
                        <mask id={maskId} maskUnits="userSpaceOnUse"
                          x={mvX} y={-mvY - mvH} width={mvW} height={mvH}>
                          {/* white = visible by default; subtract OTHER operands' interiors. */}
                          <rect x={mvX} y={-mvY - mvH} width={mvW} height={mvH} fill="white" />
                          {ops.map((other, j) => i === j ? null :
                            renderInterior(other, 'black', `${maskId}-other${j}`, undefined, undefined, overrides))}
                        </mask>
                      </defs>
                      <g mask={`url(#${maskId})`}>
                        {renderOutline(opC, strokeColor, strokeW, `${keyBase}-uoinner${i}`, overrides)}
                      </g>
                    </g>
                  );
                })}
              </g>
            );
          }
          if (comp.op === 'intersect') {
            // Each operand's outline clipped by the intersection of the
            // OTHER operands' interiors. Build a per-operand clipPath
            // chain over the others.
            return (
              <g key={keyBase}>
                {ops.map((opC, i) => {
                  const others = ops.filter((_, j) => j !== i);
                  // Build clipPath chain from `others`. clip[k] = others[k]
                  // clipped by clip[k-1].
                  const chainIds = [];
                  const chainDefs = [];
                  for (let k = 0; k < others.length; k++) {
                    const id = nextDefId(`${keyBase}-isout${i}-${k}`);
                    const parentId = k > 0 ? chainIds[k - 1] : null;
                    chainIds.push(id);
                    chainDefs.push(
                      <clipPath key={id} id={id} clipPathUnits="userSpaceOnUse">
                        {renderInterior(others[k], 'white', `${id}-c`, undefined, parentId ? `url(#${parentId})` : undefined, overrides)}
                      </clipPath>
                    );
                  }
                  const finalClip = chainIds.length ? `url(#${chainIds[chainIds.length - 1]})` : null;
                  return (
                    <g key={`${keyBase}-iso${i}`}>
                      <defs>{chainDefs}</defs>
                      <g clipPath={finalClip}>
                        {renderOutline(opC, strokeColor, strokeW, `${keyBase}-isoinner${i}`, overrides)}
                      </g>
                    </g>
                  );
                })}
              </g>
            );
          }
          if (comp.op === 'subtract' || comp.op === 'punch') {
            // Base operand outline masked by NOT(subtractors), plus each
            // subtractor's outline clipped by base interior. 'punch' is
            // rendered identically to 'subtract' here.
            const maskId = nextDefId(`${keyBase}-subout`);
            const baseClipId = nextDefId(`${keyBase}-baseclip`);
            const bbox = collectBbox(comp, overrides);
            const pad = Math.max(bbox.maxX - bbox.minX, bbox.maxY - bbox.minY) * 0.1 + 1;
            const mvX = bbox.minX - pad, mvY = bbox.minY - pad;
            const mvW = (bbox.maxX - bbox.minX) + 2 * pad;
            const mvH = (bbox.maxY - bbox.minY) + 2 * pad;
            return (
              <g key={keyBase}>
                <defs>
                  <mask id={maskId} maskUnits="userSpaceOnUse"
                    x={mvX} y={-mvY - mvH} width={mvW} height={mvH}>
                    <rect x={mvX} y={-mvY - mvH} width={mvW} height={mvH} fill="black" />
                    {renderInterior(ops[0], 'white', `${maskId}-base`, undefined, undefined, overrides)}
                    {ops.slice(1).map((opC, i) =>
                      renderInterior(opC, 'black', `${maskId}-sub${i}`, undefined, undefined, overrides)
                    )}
                  </mask>
                  <clipPath id={baseClipId} clipPathUnits="userSpaceOnUse">
                    {renderInterior(ops[0], 'white', `${baseClipId}-c`, undefined, undefined, overrides)}
                  </clipPath>
                </defs>
                <g mask={`url(#${maskId})`}>
                  {renderOutline(ops[0], strokeColor, strokeW, `${keyBase}-baseout`, overrides)}
                </g>
                <g clipPath={`url(#${baseClipId})`}>
                  {ops.slice(1).map((opC, i) =>
                    renderOutline(opC, strokeColor, strokeW, `${keyBase}-subout${i}`, overrides)
                  )}
                </g>
              </g>
            );
          }
          return null;
        };

        // Render a single boolean cluster: fill + outline + selection halo.
        // If the boolean carries a transform chain (e.g. a `repeat` or a
        // `rotate`), we emit one rendered copy per instance returned by
        // expandTransforms. Each copy is rendered by passing an OPERAND
        // INSTANCE OVERRIDE MAP down through the recursive renderer; the
        // override map gives every operand a synthetic instance at the
        // copy's rotated/translated position. We do NOT use an outer
        // <g transform> because SVG masks under outer transforms are
        // fragile — the override approach computes the right positions
        // directly so paths and masks stay in their natural user-space
        // coordinate system. The HFSS / pyAEDT exports produce the
        // matching geometry (single Unite, then DuplicateAlongLine, then
        // Rotate on the whole cluster).
        return booleanClusters.booleanComps.flatMap((b) => {
          // Determine the display fill color from the boolean's own layer
          // (which inherits from operand[0] at creation time).
          const layer = b.layer || 'waveguide';
          const style = layerStyle[layer] || layerStyle.waveguide;
          const fill = style.fill;
          const fillOpacity = style.opacity;
          const accent = b.op === 'union' ? '#10b981'
            : b.op === 'intersect' ? '#22d3ee'
            : '#f59e0b';
          const haloColor = '#0ea5e9';
          const outlineW = sw * 0.7;
          const haloW = HALO_W;
          const isSelected = selectedIds.has(b.id);
          const bbox = collectBbox(b);
          // Don't render if the bbox is degenerate (e.g., missing operands).
          if (!Number.isFinite(bbox.minX)) return null;
          // Solved counterpart carries the numeric centroid (b.cx, b.cy) the
          // boolean's transform chain expanded from. The scene-side `b` has
          // string placeholders for w/h but cx/cy is numeric on both sides.
          const solvedB = solved.find(c => c.id === b.id) || b;
          const baseCx = solvedB.cx;
          const baseCy = solvedB.cy;
          // Per-instance offsets. expandTransforms returns [{cx, cy, ...}]
          // for each rendered copy; the first entry is the un-shifted base.
          // No transforms ⇒ single entry equal to the base.
          const insts = instancesByCompId[b.id] || [{ cx: baseCx, cy: baseCy, idx: 0, rotation: 0 }];
          const elements = insts.map((inst, i) => {
            const overrides = buildBoolInstanceOverrides(b, inst, baseCx, baseCy);
            const isBase = i === 0;
            return (
              <g
                key={`bool_${b.id}_${i}`}
                style={{ cursor: 'move' }}
                opacity={isBase ? 1 : 0.85}
              >
                {/* (1) Fill — recursive interior with the layer's fill color. */}
                <g opacity={fillOpacity}>
                  {renderInterior(b, fill, `bool-fill-${b.id}-${i}`, b.id, undefined, overrides)}
                </g>
                {/* (2) Result outline — recursive perimeter in op accent. */}
                {renderOutline(b, accent, outlineW, `bool-out-${b.id}-${i}`, overrides)}
              </g>
            );
          });
          // Selection halo: a single AXIS-ALIGNED bbox around the whole
          // cluster (post-transform footprint when displayBbox is set, the
          // pre-transform operand AABB otherwise). One rectangle reads as
          // "this boolean is selected" without making every duplicate
          // flash cyan — which was confusing when the chain repeated.
          if (isSelected) {
            const halo = solvedB.displayBbox || { cx: solvedB.cx, cy: solvedB.cy, w: solvedB.w, h: solvedB.h };
            if (Number.isFinite(halo.w) && Number.isFinite(halo.h) && halo.w > 0 && halo.h > 0) {
              elements.push(
                <rect
                  key={`bool-halo-${b.id}`}
                  x={halo.cx - halo.w / 2}
                  y={-(halo.cy + halo.h / 2)}
                  width={halo.w}
                  height={halo.h}
                  fill="none"
                  stroke={haloColor}
                  strokeWidth={haloW}
                  strokeDasharray={`${HALO_W * 1.6},${HALO_W * 1.1}`}
                  pointerEvents="none"
                />
              );
            }
          }
          return elements;
        });
      })()}

      {/* Snap-mode anchors for BOOLEAN components. Booleans are rendered
          via mask/clip primitives in the cluster path above, so the
          standard component loop's anchor-dot code doesn't run for them.
          We render them here using the bbox-derived w/h written by
          resolveBooleanBboxes. Anchor handling is identical to primitives:
          click a dot to pick / commit a snap, and the same snap creation
          flow runs. */}
      {snapMode === 'creating' && booleanClusters.booleanComps.map(bScene => {
        // The scene-side boolean has w='0', h='0' stored as placeholders.
        // Look up the SOLVED counterpart for the actual bbox-derived
        // numeric dimensions written by solveLayout/refreshBooleanBbox.
        // Without this, the placeholder strings evaluate to zero and the
        // anchor dots either don't render or all stack at (0, 0).
        const bSolved = solved.find(c => c.id === bScene.id) || bScene;
        // If the boolean carries transforms, `displayBbox` holds the
        // post-transform AABB — the visible footprint of the rotated /
        // repeated cluster. Anchor dots should sit on THAT bbox so the
        // user can snap something else to (e.g.) the rotated meander's
        // top-right corner. Fall back to the raw cx/cy/w/h for plain
        // booleans without transforms.
        const b = bSolved.displayBbox
          ? { id: bScene.id, cx: bSolved.displayBbox.cx, cy: bSolved.displayBbox.cy, w: bSolved.displayBbox.w, h: bSolved.displayBbox.h }
          : bSolved;
        const w = typeof b.w === 'string' ? evalExpr(b.w, paramValues) : b.w;
        const h = typeof b.h === 'string' ? evalExpr(b.h, paramValues) : b.h;
        if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
        return (
          <g key={`bool-anchors-${b.id}`}>
            {ANCHORS.map(a => {
              const local = anchorLocal(a, w, h);
              const ax = b.cx + local.x;
              const ay = -(b.cy + local.y);
              const isPicked = snapPick?.compId === b.id && snapPick.anchor === a;
              return (
                <circle key={'sa_' + a}
                  cx={ax} cy={ay} r={hr * 1.2}
                  fill={isPicked ? '#ef4444' : '#f59e0b'}
                  stroke="white" strokeWidth={0.2}
                  style={{ cursor: 'crosshair' }}
                  onMouseEnter={() => setSnapHover(null)}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => { e.stopPropagation(); onAnchorClick(b.id, a, e); }}
                />
              );
            })}
          </g>
        );
      })}

      {(() => {
        // Two-pass component rendering. Pass 1 draws all NON-selected components
        // in their normal layer order (waveguide, then electrode), preserving
        // physical-layer overlap semantics. Pass 2 draws related and selected
        // components on top, regardless of layer, so the selection's halo,
        // snap arrows, and resize handles never disappear behind a neighbor.
        // Within pass 2, ordering is: related (parent/child/mirror), then
        // non-primary multi-selected, then primary selected — primary always
        // ends up rendered last and thus topmost.
        const stackPriority = (c) => {
          if (c.id === selectedId) return 4;
          if (selectedIds.has(c.id)) return 3;
          if (relatedIds.parents.has(c.id) || relatedIds.children.has(c.id) || relatedIds.mirrors.has(c.id)) return 2;
          return 1;
        };
        const isInPass1 = (c) => stackPriority(c) === 1;
        // Components that participate in an ENABLED boolean op are rendered
        // separately as part of the boolean cluster; suppress here to avoid
        // double-rendering. Boolean components themselves (kind='boolean')
        // are derived objects with no primitive geometry — they render via
        // the boolean cluster path above, so they must also be skipped here.
        // Selected operand components still get their halo/handles via pass2
        // since selection styling is what users need most when editing.
        const isBoolOperand = (c) => booleanClusters.operandIds.has(c.id) && !selectedIds.has(c.id);
        const isBoolComp = (c) => c.kind === 'boolean';
        const pass1 = [];
        for (const layer of ['waveguide', 'electrode', 'port']) {
          for (const c of solved) {
            if (c.layer === layer && isInPass1(c) && !isBoolOperand(c) && !isBoolComp(c)) pass1.push(c);
          }
        }
        const pass2 = [...solved]
          .filter(c => !isInPass1(c) && !isBoolOperand(c) && !isBoolComp(c))
          .sort((a, b) => stackPriority(a) - stackPriority(b));
        const ordered = [...pass1, ...pass2];
        return ordered.map(c => {
          const w = evalExpr(c.w, paramValues);
          const h = evalExpr(c.h, paramValues);
          const style = layerStyle[c.layer] || layerStyle.waveguide;
          const isSelected = selectedIds.has(c.id);
          const isPrimary = c.id === selectedId;
          const isParent = relatedIds.parents.has(c.id);
          const isChild = relatedIds.children.has(c.id);
          const isMirror = relatedIds.mirrors.has(c.id);
          // Stroke color and width priority: primary-selected > selected >
          // parent > child > mirror > default. Stroke widths are expressed as
          // multiples of `sw` (the viewport-relative stroke unit), so they
          // stay visually proportional at any zoom level. Related-component
          // dashed strokes match the primary halo thickness so the snap
          // network reads as visually unified at any zoom.
          let strokeColor = style.stroke;
          let strokeWidth = sw * 0.5;
          if (isPrimary) { strokeColor = '#0ea5e9'; strokeWidth = HALO_W; }
          else if (isSelected) { strokeColor = '#38bdf8'; strokeWidth = HALO_W * 0.8; }
          else if (isParent) { strokeColor = '#0ea5e9'; strokeWidth = HALO_W; }
          else if (isChild) { strokeColor = '#22d3ee'; strokeWidth = HALO_W; }
          else if (isMirror) { strokeColor = '#a855f7'; strokeWidth = HALO_W; }
          // Dash pattern is also expressed in stroke-units; on a HALO_W-thick
          // line, dash and gap each scale to that thickness so the rhythm
          // stays readable rather than degrading to dots at tight zoom.
          const dashOn = HALO_W * 1.6;
          const dashOff = HALO_W * 1.1;
          // Per-component instances from the transform chain. Length 1 for a
          // comp with no transforms (renders identical to before). For
          // multi-instance comps, all instances share the same compId so a
          // click anywhere selects the base component.
          const instances = instancesByCompId[c.id] || [{
            compId: c.id, idx: 0,
            cx: c.cx, cy: c.cy, w, h, rotation: 0, transformPath: '#0',
          }];
          return (
            <g key={c.id}>
              {instances.map(inst => {
                const isBase = inst.idx === 0;
                // Non-base instances render slightly muted so the base
                // primitive still reads as the "primary" geometry the user
                // can drag.
                const instOpacity = isBase ? style.opacity : (style.opacity * 0.85);
                const rotAttr = inst.rotation ? `rotate(${-inst.rotation} ${inst.cx} ${-inst.cy})` : undefined;
                // Pick the right SVG primitive for this shape. Rect uses
                // <rect> for crisp axis-aligned edges; everything else uses
                // <path> built from a tessellated ring. The ring already
                // accounts for rotation, so we apply rotAttr only for
                // <rect> to keep the path simple.
                let shapeElement;
                const shapeKind = inst.kind || c.kind || 'rect';
                const dataCompProps = {
                  'data-comp-id': c.id,
                  fill: style.fill,
                  stroke: strokeColor,
                  strokeWidth,
                  strokeDasharray: (!isSelected && (isParent || isChild || isMirror)) ? `${dashOn},${dashOff}` : undefined,
                  opacity: instOpacity,
                  style: { cursor: 'move' },
                };
                if (shapeKind === 'circle') {
                  shapeElement = (
                    <circle
                      cx={inst.cx} cy={-inst.cy}
                      r={Number.isFinite(inst.r) ? inst.r : 0}
                      {...dataCompProps}
                    />
                  );
                } else if (shapeKind === 'ellipse') {
                  // SVG <ellipse> uses (rx, ry) in screen coordinates; with
                  // y-down the rx maps to x-axis and ry to y-axis. Rotation
                  // is applied via the surrounding <g transform=>.
                  shapeElement = (
                    <ellipse
                      cx={inst.cx} cy={-inst.cy}
                      rx={Number.isFinite(inst.rx) ? inst.rx : 0}
                      ry={Number.isFinite(inst.ry) ? inst.ry : 0}
                      {...dataCompProps}
                    />
                  );
                } else if (shapeKind === 'polygon') {
                  // Build a <polygon> from the tessellated ring (which
                  // already accounts for any rotation), so we skip rotAttr.
                  const ring = shapeInstanceToRing(inst);
                  const pts = ring.map(([x, y]) => `${x},${-y}`).join(' ');
                  shapeElement = (
                    <polygon points={pts} {...dataCompProps} />
                  );
                } else if (shapeKind === 'racetrack') {
                  // Racetrack waveguide: render the centerline as a closed
                  // SVG <path> stroked at the waveguide width. The browser
                  // handles drawing the band for us, including round joins
                  // at sharp corners (there shouldn't be any, since the
                  // centerline is C¹-continuous through Euler bends, but
                  // round joins are a safe default).
                  const R = Number.isFinite(inst.R) ? inst.R : 100;
                  const Ls = Number.isFinite(inst.L_straight) ? inst.L_straight : 300;
                  const pE = Number.isFinite(inst.p) ? inst.p : 1;
                  const wgW = Number.isFinite(inst.wgWidth) ? inst.wgWidth : 1.2;
                  const centerline = buildRacetrackCenterline(R, Ls, pE);
                  // Apply the instance's rotation about its center via the
                  // xform helper (matches how other shapes' rings are built).
                  const rotRad = (inst.rotation || 0) * Math.PI / 180;
                  const ca2 = Math.cos(rotRad), sa2 = Math.sin(rotRad);
                  const transformed = centerline.map(([lx, ly]) => [
                    inst.cx + lx * ca2 - ly * sa2,
                    inst.cy + lx * sa2 + ly * ca2,
                  ]);
                  if (transformed.length > 0) {
                    let d = `M ${transformed[0][0]} ${-transformed[0][1]}`;
                    for (let k = 1; k < transformed.length; k++) {
                      d += ` L ${transformed[k][0]} ${-transformed[k][1]}`;
                    }
                    d += ' Z'; // close the loop
                    // Stroke = waveguide width; no fill (the band IS the
                    // stroke). Override the standard fill/stroke choice.
                    const { fill: _f, stroke: _s, strokeWidth: _sw, ...restProps } = dataCompProps;
                    shapeElement = (
                      <path
                        d={d}
                        fill="none"
                        stroke={style.fill}
                        strokeWidth={wgW}
                        strokeLinejoin="round"
                        strokeLinecap="butt"
                        {...restProps}
                      />
                    );
                  } else {
                    shapeElement = null;
                  }
                } else {
                  // Rectangle: use <rect> with rotation applied via the
                  // parent <g> for crisp axis-aligned strokes.
                  const ix = inst.cx - inst.w / 2;
                  const iy = -(inst.cy + inst.h / 2);
                  shapeElement = (
                    <rect
                      x={ix} y={iy} width={inst.w} height={inst.h}
                      {...dataCompProps}
                    />
                  );
                }
                // For polygons and racetracks the ring/path already includes
                // rotation; skip double-rotating via the wrapping group.
                const wrapTransform = (shapeKind === 'polygon' || shapeKind === 'racetrack') ? undefined : rotAttr;
                // Hit-pad: a transparent rect sized to at least
                // MIN_HIT_PX on each axis, rendered BELOW the visible
                // shape with the same data-comp-id. Only emitted when
                // the instance is actually narrower than the minimum on
                // one or both axes, so it's a no-op on normally-sized
                // shapes. Catches near-misses on sub-pixel-thin
                // waveguides and the like — without it, those near-
                // misses would land on the background and turn an
                // intended alt-drag into a marquee.
                const hitW = Math.max(inst.w, minHitWorld);
                const hitH = Math.max(inst.h, minHitWorld);
                const needsHitPad = hitW > inst.w + 1e-9 || hitH > inst.h + 1e-9;
                const hitPad = needsHitPad ? (
                  <rect
                    x={inst.cx - hitW / 2}
                    y={-(inst.cy + hitH / 2)}
                    width={hitW}
                    height={hitH}
                    fill="transparent"
                    pointerEvents="all"
                    data-comp-id={c.id}
                    style={{ cursor: 'move' }}
                  />
                ) : null;
                return (
                  <g key={inst.transformPath} transform={wrapTransform}>
                    {hitPad}
                    {shapeElement}
                    {(c.cutouts || []).map((cut, i) => {
                      const cw = evalExpr(cut.w, paramValues);
                      const ch = evalExpr(cut.h, paramValues);
                      const cdx = evalExpr(cut.dx, paramValues);
                      const cdy = evalExpr(cut.dy, paramValues);
                      return (
                        <rect key={i}
                          x={inst.cx + cdx - cw / 2}
                          y={-(inst.cy + cdy + ch / 2)}
                          width={cw} height={ch}
                          fill="#f1f5f9"
                          stroke="#64748b" strokeWidth={sw * 0.4} strokeDasharray={`${sw * 1.5},${sw * 1.5}`}
                          pointerEvents="none"
                        />
                      );
                    })}
                  </g>
                );
              })}
              {isPrimary && (
                <text x={c.cx} y={-c.cy} fontSize={Math.max(2, Math.min(w, h) / 8)} textAnchor="middle" dominantBaseline="middle" fill="#0c4a6e" pointerEvents="none" fontFamily="monospace">
                  {c.id}
                </text>
              )}
              {/* Snap direction indicators on the primary-selected component.
                  For each snap touching this component, draw a small arrow at
                  the relevant anchor pointing along the snap line. Incoming
                  arrows (this comp is the `to`) point INTO this component
                  from the parent — drawn in sky-blue. Outgoing arrows (this
                  comp is the `from`) point OUTWARD toward the child — drawn
                  in cyan. */}
              {isPrimary && (() => {
                const arrowLen = Math.max(viewport.w, viewport.h) * 0.04;
                const arrowHead = arrowLen * 0.45;
                const elements = [];
                for (const s of scene.snaps) {
                  let myAnchor = null, otherCompId = null, otherAnchor = null, isIncoming = false;
                  if (s.to.compId === c.id) {
                    myAnchor = s.to.anchor; otherCompId = s.from.compId; otherAnchor = s.from.anchor; isIncoming = true;
                  } else if (s.from.compId === c.id) {
                    myAnchor = s.from.anchor; otherCompId = s.to.compId; otherAnchor = s.to.anchor; isIncoming = false;
                  } else continue;
                  const otherComp = solved.find(cc => cc.id === otherCompId);
                  if (!otherComp) continue;
                  const myLocal = anchorLocal(myAnchor, w, h);
                  const myWX = c.cx + myLocal.x;
                  const myWY = c.cy + myLocal.y;
                  const otherW = anchorWorld(otherComp, otherAnchor, paramValues);
                  // Direction from my-anchor toward other-anchor.
                  const ddx = otherW.x - myWX;
                  const ddy = otherW.y - myWY;
                  const len = Math.sqrt(ddx * ddx + ddy * ddy);
                  let ux, uy;
                  // Check whether the two component bounding boxes share a
                  // common edge (horizontal or vertical). If so, the arrow
                  // should be orthogonal to that edge — pointing outward from
                  // this component along the perpendicular axis. This gives
                  // a much more readable indicator than anchor-to-anchor
                  // direction (which can be diagonal when the snap is
                  // corner-to-corner) or the local-anchor outward normal
                  // (which is also diagonal for corner anchors).
                  const ow = evalExpr(otherComp.w, paramValues);
                  const oh = evalExpr(otherComp.h, paramValues);
                  const myL = c.cx - w / 2,    myR = c.cx + w / 2;
                  const myB = c.cy - h / 2,    myT = c.cy + h / 2;
                  const oL = otherComp.cx - ow / 2, oR = otherComp.cx + ow / 2;
                  const oB = otherComp.cy - oh / 2, oT = otherComp.cy + oh / 2;
                  // Edge-coincidence tolerance: a tiny fraction of the smaller
                  // dimension, so floating-point noise doesn't fool the test.
                  const tol = Math.max(0.001, 0.001 * Math.min(w, h, ow, oh));
                  const sharesRight = Math.abs(myR - oL) < tol && oT > myB && oB < myT;
                  const sharesLeft  = Math.abs(myL - oR) < tol && oT > myB && oB < myT;
                  const sharesTop   = Math.abs(myT - oB) < tol && oR > myL && oL < myR;
                  const sharesBot   = Math.abs(myB - oT) < tol && oR > myL && oL < myR;
                  if (sharesRight)      { ux =  1; uy =  0; }
                  else if (sharesLeft)  { ux = -1; uy =  0; }
                  else if (sharesTop)   { ux =  0; uy =  1; }
                  else if (sharesBot)   { ux =  0; uy = -1; }
                  else if (len < 1e-6) {
                    // No shared edge AND anchors coincide (galvanic contact at
                    // a point) — fall back to the local outward normal of this
                    // component's anchor. For corner anchors this is diagonal,
                    // which is fine because there's no shared edge to align to.
                    const a = parseAnchor(myAnchor);
                    let nx = 0, ny = 0;
                    if (a.kind === 'edge') {
                      if (a.side === 'T') ny =  1;
                      else if (a.side === 'B') ny = -1;
                      else if (a.side === 'L') nx = -1;
                      else if (a.side === 'R') nx =  1;
                    } else {
                      const n = a.name;
                      if (n.includes('N')) ny =  1;
                      if (n.includes('S')) ny = -1;
                      if (n.includes('E')) nx =  1;
                      if (n.includes('W')) nx = -1;
                    }
                    if (nx === 0 && ny === 0) { nx = 1; ny = 0; } // 'C' anchor → arbitrary +x
                    const nlen = Math.sqrt(nx * nx + ny * ny);
                    ux = nx / nlen; uy = ny / nlen;
                  } else {
                    ux = ddx / len; uy = ddy / len;
                  }
                  // Both incoming and outgoing arrows are drawn POINTING OUTWARD
                  // from this component, with the tail at the anchor and the
                  // tip away from the component along the snap line. The
                  // arrowhead direction encodes the snap direction:
                  //   - outgoing: arrowhead at the FAR end (pointing toward partner)
                  //   - incoming: arrowhead at the NEAR end (pointing toward this comp's anchor)
                  // Both arrows share the same shaft geometry (anchor → outward).
                  const tailX = myWX, tailY = myWY;
                  const tipX = myWX + ux * arrowLen;
                  const tipY = myWY + uy * arrowLen;
                  const headAtTip = !isIncoming;
                  // Arrowhead at tip: standard wedge.
                  const px = -uy, py = ux;
                  const wingSpread = arrowHead * 0.55;
                  let wingPts;
                  if (headAtTip) {
                    const baseX = tipX - ux * arrowHead;
                    const baseY = tipY - uy * arrowHead;
                    wingPts = `${baseX + px * wingSpread},${-(baseY + py * wingSpread)} ${tipX},${-tipY} ${baseX - px * wingSpread},${-(baseY - py * wingSpread)}`;
                  } else {
                    // Head at the anchor end (tail).
                    const baseX = tailX + ux * arrowHead;
                    const baseY = tailY + uy * arrowHead;
                    wingPts = `${baseX + px * wingSpread},${-(baseY + py * wingSpread)} ${tailX},${-tailY} ${baseX - px * wingSpread},${-(baseY - py * wingSpread)}`;
                  }
                  const color = isIncoming ? '#0ea5e9' : '#22d3ee';
                  const shaftPts = `${tailX},${-tailY} ${tipX},${-tipY}`;
                  elements.push(
                    <g key={`arrow_${s.id}_${c.id}`} pointerEvents="none">
                      {/* White outline behind for visibility against any background */}
                      <line
                        x1={tailX} y1={-tailY} x2={tipX} y2={-tipY}
                        stroke="white" strokeWidth={sw * 2.6} strokeLinecap="round" opacity={0.9}
                      />
                      <polygon points={wingPts} fill="white" stroke="white" strokeWidth={sw * 2.6} strokeLinejoin="round" opacity={0.9} />
                      {/* Colored shaft and filled triangle arrowhead on top */}
                      <line
                        x1={tailX} y1={-tailY} x2={tipX} y2={-tipY}
                        stroke={color} strokeWidth={sw * 1.5} strokeLinecap="round"
                      />
                      <polygon points={wingPts} fill={color} stroke={color} strokeWidth={sw * 1.5} strokeLinejoin="round" />
                    </g>
                  );
                  void shaftPts;
                }
                return elements;
              })()}
              {/* Resize handles (only on primary selected) */}
              {isPrimary && ANCHORS.filter(a => a !== 'C').map(a => {
                const local = anchorLocal(a, w, h);
                const ax = c.cx + local.x;
                const ay = -(c.cy + local.y);
                let cursor = 'move';
                if (a === 'NE' || a === 'SW') cursor = 'nesw-resize';
                else if (a === 'NW' || a === 'SE') cursor = 'nwse-resize';
                else if (a === 'N' || a === 'S') cursor = 'ns-resize';
                else if (a === 'E' || a === 'W') cursor = 'ew-resize';
                return (
                  <rect
                    key={'h_' + a}
                    data-resize={`${c.id}|${a}`}
                    x={ax - hr} y={ay - hr} width={hr * 2} height={hr * 2}
                    fill="white" stroke="#0ea5e9" strokeWidth={sw * 0.5}
                    style={{ cursor }}
                  />
                );
              })}
              {/* Snap-mode edge strips: clickable lines on each edge */}
              {snapMode === 'creating' && (() => {
                const edgeStrokeW = Math.max(hr * 0.8, 1);
                // Bounds of the rect in world coordinates
                const x0 = c.cx - w / 2, x1 = c.cx + w / 2;
                const y0 = c.cy - h / 2, y1 = c.cy + h / 2;
                // Figure t from a screen click: use the SVG's CTM via screenToWorld,
                // then map to t along the edge.
                const handleEdgeClick = (side, e) => {
                  e.stopPropagation();
                  const wp = screenToWorld(e.clientX, e.clientY);
                  let t;
                  if (side === 'T' || side === 'B') t = (wp.x - x0) / Math.max(1e-9, w);
                  else                              t = (wp.y - y0) / Math.max(1e-9, h);
                  t = Math.max(0, Math.min(1, t));
                  // Apply Shift axis-lock against first anchor (if picking the second)
                  if (e.shiftKey && snapPick && snapPick.compId !== c.id) {
                    const fromComp = solved.find(cc => cc.id === snapPick.compId);
                    if (fromComp) {
                      const fromW = anchorWorld(fromComp, snapPick.anchor, paramValues);
                      // Solve for t such that the world position of the edge anchor matches
                      // either fromW.x (for T/B edges) or fromW.y (for L/R edges).
                      if (side === 'T' || side === 'B') {
                        const target = (fromW.x - x0) / Math.max(1e-9, w);
                        t = Math.max(0, Math.min(1, target));
                      } else {
                        const target = (fromW.y - y0) / Math.max(1e-9, h);
                        t = Math.max(0, Math.min(1, target));
                      }
                    }
                  }
                  // Round t for cleaner snap names
                  const tRounded = Math.round(t * 1000) / 1000;
                  onAnchorClick(c.id, `${side}:${tRounded}`, e);
                };
                const handleEdgeMove = (side, e) => {
                  const wp = screenToWorld(e.clientX, e.clientY);
                  let t;
                  if (side === 'T' || side === 'B') t = (wp.x - x0) / Math.max(1e-9, w);
                  else                              t = (wp.y - y0) / Math.max(1e-9, h);
                  t = Math.max(0, Math.min(1, t));
                  if (e.shiftKey && snapPick && snapPick.compId !== c.id) {
                    const fromComp = solved.find(cc => cc.id === snapPick.compId);
                    if (fromComp) {
                      const fromW = anchorWorld(fromComp, snapPick.anchor, paramValues);
                      if (side === 'T' || side === 'B') {
                        const target = (fromW.x - x0) / Math.max(1e-9, w);
                        t = Math.max(0, Math.min(1, target));
                      } else {
                        const target = (fromW.y - y0) / Math.max(1e-9, h);
                        t = Math.max(0, Math.min(1, target));
                      }
                    }
                  }
                  const local = anchorLocal(`${side}:${t}`, w, h);
                  setSnapHover({ compId: c.id, side, t, x: c.cx + local.x, y: c.cy + local.y });
                };
                const edges = [
                  { side: 'T', x1v: x0, y1v: y1, x2v: x1, y2v: y1 },
                  { side: 'B', x1v: x0, y1v: y0, x2v: x1, y2v: y0 },
                  { side: 'L', x1v: x0, y1v: y0, x2v: x0, y2v: y1 },
                  { side: 'R', x1v: x1, y1v: y0, x2v: x1, y2v: y1 },
                ];
                return edges.map(eg => (
                  <line
                    key={'edge_' + eg.side}
                    x1={eg.x1v} y1={-eg.y1v} x2={eg.x2v} y2={-eg.y2v}
                    stroke="rgba(245,158,11,0.35)"
                    strokeWidth={edgeStrokeW}
                    strokeLinecap="butt"
                    style={{ cursor: 'crosshair' }}
                    onMouseMove={(e) => handleEdgeMove(eg.side, e)}
                    onMouseLeave={() => setSnapHover(null)}
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={(e) => handleEdgeClick(eg.side, e)}
                  />
                ));
              })()}
              {/* Snap-mode hover preview dot */}
              {snapMode === 'creating' && snapHover && snapHover.compId === c.id && (
                <circle
                  cx={snapHover.x} cy={-snapHover.y} r={hr * 0.9}
                  fill="rgba(245,158,11,0.85)"
                  stroke="white" strokeWidth={0.2}
                  pointerEvents="none"
                />
              )}
              {/* Snap-mode anchors */}
              {snapMode === 'creating' && ANCHORS.map(a => {
                const local = anchorLocal(a, w, h);
                const ax = c.cx + local.x;
                const ay = -(c.cy + local.y);
                const isPicked = snapPick?.compId === c.id && snapPick.anchor === a;
                return (
                  <circle key={'sa_' + a}
                    cx={ax} cy={ay} r={hr * 1.2}
                    fill={isPicked ? '#ef4444' : '#f59e0b'}
                    stroke="white" strokeWidth={0.2}
                    style={{ cursor: 'crosshair' }}
                    onMouseEnter={() => setSnapHover(null)}
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={(e) => { e.stopPropagation(); onAnchorClick(c.id, a, e); }}
                  />
                );
              })}
            </g>
          );
        });
      })()}

      {/* Dimensions overlay: parametric width/height/snap-offset arrows.
          Toggled from the toolbar. Each dimension shows the variable name
          (or expression) primary, and the numeric value if it fits.
          Style is engineering-drawing-like: extension lines from the
          geometry, an arrow line offset perpendicular, end arrows, and a
          centered label on a dark pill so it reads against any background. */}
      {showDimensions && (() => {
        // Heuristic: an expression is "parameter-bound" iff it contains at
        // least one alphabetic identifier. Pure numerics like "20" are not.
        const hasParam = (expr) => typeof expr === 'string' && /[A-Za-z_]/.test(expr);
        const dims = [];
        // Component widths and heights
        for (const c of solved) {
          const w = evalExpr(c.w, paramValues);
          const h = evalExpr(c.h, paramValues);
          if (!Number.isFinite(w) || !Number.isFinite(h)) continue;
          if (hasParam(c.w)) {
            dims.push({
              kind: 'comp_w', compId: c.id,
              p1: { x: c.cx - w / 2, y: c.cy - h / 2 - 0.001 },
              p2: { x: c.cx + w / 2, y: c.cy - h / 2 - 0.001 },
              outwardN: { x: 0, y: -1 }, // dimension below the component
              labelExpr: String(c.w),
              value: w,
            });
          }
          if (hasParam(c.h)) {
            dims.push({
              kind: 'comp_h', compId: c.id,
              p1: { x: c.cx + w / 2 + 0.001, y: c.cy - h / 2 },
              p2: { x: c.cx + w / 2 + 0.001, y: c.cy + h / 2 },
              outwardN: { x: 1, y: 0 }, // dimension to the right
              labelExpr: String(c.h),
              value: h,
            });
          }
        }
        // Snap offsets (dx and dy) when parameter-bound. Drawn between the
        // two anchor points, projected to a single axis (X for dx, Y for dy).
        for (const s of scene.snaps) {
          const fromComp = solved.find(cc => cc.id === s.from.compId);
          const toComp   = solved.find(cc => cc.id === s.to.compId);
          if (!fromComp || !toComp) continue;
          const fromW = anchorWorld(fromComp, s.from.anchor, paramValues);
          const toW   = anchorWorld(toComp,   s.to.anchor,   paramValues);
          if (hasParam(s.dx)) {
            const valDx = evalExpr(s.dx, paramValues);
            // Skip if dx is essentially zero — a zero-length dim is useless
            if (Math.abs(toW.x - fromW.x) > 1e-6) {
              dims.push({
                kind: 'snap_dx', snapId: s.id,
                p1: { x: fromW.x, y: fromW.y },
                p2: { x: toW.x,   y: fromW.y },
                outwardN: { x: 0, y: toW.y >= fromW.y ? -1 : 1 },
                labelExpr: String(s.dx),
                value: valDx,
              });
            }
          }
          if (hasParam(s.dy)) {
            const valDy = evalExpr(s.dy, paramValues);
            if (Math.abs(toW.y - fromW.y) > 1e-6) {
              dims.push({
                kind: 'snap_dy', snapId: s.id,
                p1: { x: toW.x, y: fromW.y },
                p2: { x: toW.x, y: toW.y },
                outwardN: { x: toW.x >= fromW.x ? 1 : -1, y: 0 },
                labelExpr: String(s.dy),
                value: valDy,
              });
            }
          }
        }
        // Geometry constants (in world units, scaled by viewport so they
        // stay legible at any zoom).
        const vScale = Math.max(viewport.w, viewport.h);
        const offsetDist = vScale * 0.025;   // distance from geometry to dim line
        const extOverhang = vScale * 0.005;  // how far ext line passes beyond dim line
        const arrowLen = vScale * 0.012;
        const arrowSpread = vScale * 0.005;
        const fontSize = Math.max(2, vScale * 0.01);
        const labelPadX = fontSize * 0.5;
        const labelPadY = fontSize * 0.3;
        // Estimate character width for label-fits-on-line check.
        const charW = fontSize * 0.6;

        return (
          <g pointerEvents="none">
            {dims.map((d, i) => {
              // Dimension line is parallel to (p1, p2), offset by offsetDist
              // along outwardN. Extension lines go from each endpoint of the
              // geometry edge to slightly beyond the dim line.
              const ox = d.outwardN.x * offsetDist;
              const oy = d.outwardN.y * offsetDist;
              const dimP1 = { x: d.p1.x + ox, y: d.p1.y + oy };
              const dimP2 = { x: d.p2.x + ox, y: d.p2.y + oy };
              // Direction along dim line (unit)
              const lx = dimP2.x - dimP1.x;
              const ly = dimP2.y - dimP1.y;
              const len = Math.sqrt(lx * lx + ly * ly) || 1;
              const ux = lx / len, uy = ly / len;
              // Extension lines: from geometry endpoint to slightly past dim line
              const extEndScale = (offsetDist + extOverhang);
              const ext1 = { x: d.p1.x + d.outwardN.x * extEndScale, y: d.p1.y + d.outwardN.y * extEndScale };
              const ext2 = { x: d.p2.x + d.outwardN.x * extEndScale, y: d.p2.y + d.outwardN.y * extEndScale };
              // Arrowheads at each end of dim line, pointing outward along the line.
              const arrowAt = (tip, dirSign) => {
                // Wing direction: perpendicular to the line.
                const px = -uy, py = ux;
                const baseX = tip.x - dirSign * ux * arrowLen;
                const baseY = tip.y - dirSign * uy * arrowLen;
                return `${baseX + px * arrowSpread},${-(baseY + py * arrowSpread)} ${tip.x},${-tip.y} ${baseX - px * arrowSpread},${-(baseY - py * arrowSpread)}`;
              };
              // Label: variable name first; append "= value" if room.
              const nameLabel = d.labelExpr;
              const valueText = Number.isFinite(d.value) ? `${d.value.toFixed(2)}` : '';
              // Estimate width needed for name vs name + value, in world units.
              const nameW = nameLabel.length * charW;
              const fullW = (nameLabel.length + 3 + valueText.length) * charW;
              // Available width along dim line, minus arrow margins on both sides.
              const avail = len - 2 * arrowLen - 2 * labelPadX;
              const showValue = avail >= fullW;
              const showName = avail >= nameW * 0.6; // allow squeezing slightly
              if (!showName) return null;
              const text = showValue ? `${nameLabel} = ${valueText}` : nameLabel;
              const textW = text.length * charW;
              // Label centered along dim line.
              const mx = (dimP1.x + dimP2.x) / 2;
              const my = (dimP1.y + dimP2.y) / 2;
              return (
                <g key={`dim_${i}_${d.kind}`}>
                  {/* Extension lines */}
                  <line x1={d.p1.x} y1={-d.p1.y} x2={ext1.x} y2={-ext1.y} stroke="#a78bfa" strokeWidth={0.25} opacity={0.85} />
                  <line x1={d.p2.x} y1={-d.p2.y} x2={ext2.x} y2={-ext2.y} stroke="#a78bfa" strokeWidth={0.25} opacity={0.85} />
                  {/* Dim line */}
                  <line x1={dimP1.x} y1={-dimP1.y} x2={dimP2.x} y2={-dimP2.y} stroke="#a78bfa" strokeWidth={0.4} opacity={0.95} />
                  {/* Arrowheads (point outward from line center) */}
                  <polyline points={arrowAt(dimP1, -1)} fill="none" stroke="#a78bfa" strokeWidth={0.4} strokeLinecap="round" strokeLinejoin="round" />
                  <polyline points={arrowAt(dimP2,  1)} fill="none" stroke="#a78bfa" strokeWidth={0.4} strokeLinecap="round" strokeLinejoin="round" />
                  {/* Label pill */}
                  <rect
                    x={mx - textW / 2 - labelPadX}
                    y={-my - fontSize / 2 - labelPadY}
                    width={textW + 2 * labelPadX}
                    height={fontSize + 2 * labelPadY}
                    fill="rgba(15,23,42,0.92)"
                    stroke="#a78bfa"
                    strokeWidth={0.2}
                    rx={fontSize * 0.2}
                  />
                  <text
                    x={mx} y={-my + fontSize * 0.35}
                    fontSize={fontSize}
                    fontFamily="monospace"
                    fill="#ddd6fe"
                    textAnchor="middle"
                  >
                    {showValue ? (
                      <>
                        <tspan fill="#ddd6fe">{nameLabel}</tspan>
                        <tspan fill="#94a3b8"> = {valueText}</tspan>
                      </>
                    ) : (
                      nameLabel
                    )}
                  </text>
                </g>
              );
            })}
          </g>
        );
      })()}

      {/* Lumped-port integration lines. Persistent (drawn regardless
          of selection) — one red arrow per port-layer component that
          has `lumpedPort.enabled` AND a valid auto-detected adjacency
          (two-conductor flanking, either by direct edge contact or by
          a punch hole that splits a single conductor in half). The
          arrow runs across the port through its center, oriented along
          the detected integration direction. Markers use red with
          transparency so the user can still see the port underneath. */}
      {(() => {
        const arrows = [];
        for (const c of solved) {
          if (c.layer !== 'port' || c.kind !== 'rect') continue;
          if (!c.lumpedPort || !c.lumpedPort.enabled) continue;
          const det = detectPortIntegrationLine(c, solved, paramValues);
          if (!det.direction) continue;
          let x1, y1, x2, y2;
          if (det.direction === 'EW') {
            x1 = det.line.startX; y1 = det.line.midY;
            x2 = det.line.endX;   y2 = det.line.midY;
          } else {
            x1 = det.line.midX;   y1 = det.line.startY;
            x2 = det.line.midX;   y2 = det.line.endY;
          }
          // No inset — endpoints sit exactly on the adjacent port edges
          // (the midpoints of the two sides facing the flanker
          // conductors), matching the HFSS IntLine that the export
          // will install on this port.
          arrows.push({ id: c.id, x1, y1, x2, y2 });
        }
        if (arrows.length === 0) return null;
        return (
          <g pointerEvents="none">
            {arrows.map(a => (
              <line key={a.id}
                x1={a.x1} y1={-a.y1} x2={a.x2} y2={-a.y2}
                stroke="#ef4444" strokeWidth={sw * 3} opacity={0.85}
                markerEnd="url(#lp-arrow)"
              />
            ))}
          </g>
        );
      })()}

      {/* Add-mode pre-drag hover indicator: show the snap target before
          the drag starts so the user can see what they'd grab if they click. */}
      {addMode && !addDrag && addHoverSnap && addHoverSnap.compId && (
        <g pointerEvents="none">
          <circle cx={addHoverSnap.x} cy={-addHoverSnap.y} r={hr * 0.6}
            fill="#fbbf24" stroke="#f59e0b" strokeWidth={sw * 0.6} />
          <circle cx={addHoverSnap.x} cy={-addHoverSnap.y} r={hr * 1.2}
            fill="none" stroke="#f59e0b" strokeWidth={sw * 0.5} opacity={0.6} />
        </g>
      )}

      {/* Alt-drag snap-target look-ahead. While the user is dragging
          with Option/Alt held, surface every NEARBY shape's snap
          candidates (top / bottom / mid-y / left / right / mid-x) as
          faint dashed guidelines so you can see what you'd snap to
          before committing to a position. Center lines use a finer dot
          pattern to distinguish them from the edge lines. Suppressed
          for shapes far from the dragged cluster (more than a handful
          of snap thresholds away) so the canvas doesn't fill with
          irrelevant ghost-lines on a busy scene. */}
      {drag && drag.kind === 'move' && altKey && (() => {
        const screenThresh = 30;
        const worldThresh = screenThresh * (viewport.w / (svgRef.current?.clientWidth || 1));
        const proximity = worldThresh * 6;
        const dragId = drag.clickedId || drag.rootId;
        const dragged = solved.find((c) => c.id === dragId);
        if (!dragged) return null;
        const dw = (drag.clusterBboxW && drag.clusterBboxW > 0) ? drag.clusterBboxW
          : (typeof dragged.w === 'string' ? evalExpr(dragged.w, paramValues) : dragged.w);
        const dh = (drag.clusterBboxH && drag.clusterBboxH > 0) ? drag.clusterBboxH
          : (typeof dragged.h === 'string' ? evalExpr(dragged.h, paramValues) : dragged.h);
        if (!Number.isFinite(dw) || !Number.isFinite(dh)) return null;
        const dxMin = dragged.cx - dw / 2, dxMax = dragged.cx + dw / 2;
        const dyMin = dragged.cy - dh / 2, dyMax = dragged.cy + dh / 2;
        const guides = [];
        for (const oc of solved) {
          if (oc.id === dragId) continue;
          if (drag.clusterSet && drag.clusterSet.has(oc.id)) continue;
          if (oc.consumedBy) continue;
          const ow = typeof oc.w === 'string' ? evalExpr(oc.w, paramValues) : oc.w;
          const oh = typeof oc.h === 'string' ? evalExpr(oc.h, paramValues) : oc.h;
          if (!Number.isFinite(ow) || !Number.isFinite(oh) || ow <= 0 || oh <= 0) continue;
          const oxMin = oc.cx - ow / 2, oxMax = oc.cx + ow / 2;
          const oyMin = oc.cy - oh / 2, oyMax = oc.cy + oh / 2;
          // Min bbox-to-bbox distance.
          const xGap = Math.max(0, Math.max(dxMin - oxMax, oxMin - dxMax));
          const yGap = Math.max(0, Math.max(dyMin - oyMax, oyMin - dyMax));
          if (Math.hypot(xGap, yGap) > proximity) continue;
          // Extension so the lines visibly run past the shape's bbox.
          const ext = Math.max(ow, oh) * 0.2;
          const xL = oxMin - ext, xR = oxMax + ext;
          const wYmin = oyMin - ext, wYmax = oyMax + ext;
          // Edge lines: medium dashes. Center lines: fine dots so they
          // read as a different kind of constraint at a glance.
          const edgeDash  = `${sw * 1.4},${sw * 1.0}`;
          const ctrDash   = `${sw * 0.35},${sw * 1.1}`;
          const stroke    = '#67e8f9';
          const strokeW   = sw * 0.4;
          const baseOp    = 0.32;
          // Horizontal candidates: top, bottom, center-y.
          for (const [y, isCenter] of [[oyMax, false], [oyMin, false], [oc.cy, true]]) {
            guides.push(
              <line
                key={`${oc.id}-h-${y}-${isCenter}`}
                x1={xL} y1={-y} x2={xR} y2={-y}
                stroke={stroke} strokeWidth={strokeW}
                strokeDasharray={isCenter ? ctrDash : edgeDash}
                opacity={baseOp}
              />
            );
          }
          // Vertical candidates: left, right, center-x.
          for (const [x, isCenter] of [[oxMax, false], [oxMin, false], [oc.cx, true]]) {
            guides.push(
              <line
                key={`${oc.id}-v-${x}-${isCenter}`}
                x1={x} y1={-wYmax} x2={x} y2={-wYmin}
                stroke={stroke} strokeWidth={strokeW}
                strokeDasharray={isCenter ? ctrDash : edgeDash}
                opacity={baseOp}
              />
            );
          }
        }
        return <g pointerEvents="none">{guides}</g>;
      })()}

      {/* Alt-drag snap-target indicator. While the user drags a component
          with Option/Alt held and the cursor is near a target anchor on a
          different component, surface that anchor so the user can see what
          they're about to snap to. On release, a snap is installed (see
          onMouseUp). */}
      {drag && drag.kind === 'move' && moveSnapHover && (
        <g pointerEvents="none">
          {/* Anchor snap: a small target reticle on the chosen anchor. */}
          {moveSnapHover.kind === 'anchor' && (
            <>
              <circle cx={moveSnapHover.x} cy={-moveSnapHover.y} r={hr * 0.7}
                fill="#67e8f9" stroke="#0891b2" strokeWidth={sw * 0.6} />
              <circle cx={moveSnapHover.x} cy={-moveSnapHover.y} r={hr * 1.4}
                fill="none" stroke="#0891b2" strokeWidth={sw * 0.5} opacity={0.6} />
            </>
          )}
          {/* Edge snap: extend a guide line along the aligned edge across
              the union of the two bboxes, plus a thinner indicator at the
              midpoint of the overlap so the user can see which two edges
              are being matched. */}
          {moveSnapHover.kind === 'edge' && (() => {
            const tc = solved.find(c => c.id === moveSnapHover.targetCompId);
            if (!tc) return null;
            const tw = typeof tc.w === 'string' ? evalExpr(tc.w, paramValues) : tc.w;
            const th = typeof tc.h === 'string' ? evalExpr(tc.h, paramValues) : tc.h;
            if (!Number.isFinite(tw) || !Number.isFinite(th)) return null;
            const tx0 = tc.cx - tw / 2, tx1 = tc.cx + tw / 2;
            const ty0 = tc.cy - th / 2, ty1 = tc.cy + th / 2;
            // Recompute the dragged cluster bbox at its CURRENT (post-snap) position by
            // using drag.startCx/Cy + the current effective offset. Easier: the
            // moveSnapHover.x/y is already the overlap midpoint, but we need
            // the union of x-ranges (or y-ranges) for the guide. The drag's
            // co-mover startCx/Cy plus the latest translation gives us that;
            // approximate via the SOLVED bbox of the cluster's clickedId.
            const dragId = drag.clickedId || drag.rootId;
            const dc = solved.find(c => c.id === dragId);
            if (!dc) return null;
            const dw2 = typeof dc.w === 'string' ? evalExpr(dc.w, paramValues) : dc.w;
            const dh2 = typeof dc.h === 'string' ? evalExpr(dc.h, paramValues) : dc.h;
            const dx0 = dc.cx - dw2 / 2, dx1 = dc.cx + dw2 / 2;
            const dy0 = dc.cy - dh2 / 2, dy1 = dc.cy + dh2 / 2;
            const stroke = '#67e8f9';
            if (moveSnapHover.axis === 'h') {
              const x1 = Math.min(tx0, dx0), x2 = Math.max(tx1, dx1);
              const y = moveSnapHover.edgeVal;
              return (
                <>
                  <line x1={x1} y1={-y} x2={x2} y2={-y}
                    stroke={stroke} strokeWidth={sw * 0.7} strokeDasharray={`${sw * 2},${sw * 1.4}`} opacity={0.85} />
                  <circle cx={moveSnapHover.x} cy={-moveSnapHover.y} r={hr * 0.5}
                    fill={stroke} stroke="#0891b2" strokeWidth={sw * 0.5} />
                </>
              );
            }
            const y1 = Math.min(ty0, dy0), y2 = Math.max(ty1, dy1);
            const x = moveSnapHover.edgeVal;
            return (
              <>
                <line x1={x} y1={-y1} x2={x} y2={-y2}
                  stroke={stroke} strokeWidth={sw * 0.7} strokeDasharray={`${sw * 2},${sw * 1.4}`} opacity={0.85} />
                <circle cx={moveSnapHover.x} cy={-moveSnapHover.y} r={hr * 0.5}
                  fill={stroke} stroke="#0891b2" strokeWidth={sw * 0.5} />
              </>
            );
          })()}
        </g>
      )}

      {/* Add-drag preview: live rectangle while user drags to size a new
          component. Snapped corners get a brighter halo so you can see they
          are anchored to existing geometry. Dimension-match labels appear on
          the appropriate sides when the drag size matches an existing
          component's parameter — same logic as commitDragAdd uses. */}
      {addMode && addDrag && (() => {
        const { p1, p2, snapStart, snapEnd } = addDrag;
        const minX = Math.min(p1.x, p2.x);
        const maxX = Math.max(p1.x, p2.x);
        const minY = Math.min(p1.y, p2.y);
        const maxY = Math.max(p1.y, p2.y);
        const w = maxX - minX;
        const h = maxY - minY;
        // Pick fill colour from the addMode layer to give visual context.
        const layer = addMode.layer || addMode.kind || 'waveguide';
        const previewFill = layer === 'waveguide' ? '#3ec27a'
          : layer === 'port' ? '#b91c1c'
          : '#f4a72e';
        const previewStroke = layer === 'waveguide' ? '#1a5e36'
          : layer === 'port' ? '#7f1d1d'
          : '#7a4d00';
        const shape = addMode.shape || 'rect';
        // Probe for dimension matches (mirrors the heuristic in commitDragAdd
        // so the preview matches what will actually be created).
        const TOL = 0.5;
        let wMatchExpr = null, hMatchExpr = null;
        for (const c of scene.components) {
          const cw = evalExpr(c.w, paramValues);
          const ch = evalExpr(c.h, paramValues);
          if (!wMatchExpr && Number.isFinite(cw) && Math.abs(cw - w) < TOL && /[A-Za-z_]/.test(String(c.w))) wMatchExpr = String(c.w);
          if (!hMatchExpr && Number.isFinite(ch) && Math.abs(ch - h) < TOL && /[A-Za-z_]/.test(String(c.h))) hMatchExpr = String(c.h);
          if (wMatchExpr && hMatchExpr) break;
        }
        // Span case: both endpoints snap to DIFFERENT components — width/height
        // become parametric expressions linking the two parents. Indicate this
        // with a label that overrides the dimension-match suggestion.
        const isSpan = !!(snapStart && snapEnd && snapStart.compId !== snapEnd.compId);
        const fontSize = Math.max(2, Math.max(viewport.w, viewport.h) * 0.011);
        const padX = fontSize * 0.5;
        const padY = fontSize * 0.3;
        const charW = fontSize * 0.6;
        const showLabel = (text, mx, my) => {
          const tw = text.length * charW;
          return (
            <g>
              <rect
                x={mx - tw / 2 - padX}
                y={-my - fontSize / 2 - padY}
                width={tw + 2 * padX}
                height={fontSize + 2 * padY}
                fill="rgba(15,23,42,0.92)"
                stroke="#22c55e"
                strokeWidth={0.2}
                rx={fontSize * 0.2}
              />
              <text
                x={mx} y={-my + fontSize * 0.35}
                fontSize={fontSize}
                fontFamily="monospace"
                fill="#86efac"
                textAnchor="middle"
              >
                = {text}
              </text>
            </g>
          );
        };
        const labelOffsetW = Math.max(viewport.w, viewport.h) * 0.025;
        return (
          <g pointerEvents="none">
            {w > 0.001 && h > 0.001 && (() => {
              // Build a shape-specific preview from the drag bbox.
              const previewProps = {
                fill: previewFill, fillOpacity: 0.35,
                stroke: previewStroke, strokeWidth: sw,
                strokeDasharray: `${sw * 3},${sw * 1.5}`,
              };
              const cxP = (minX + maxX) / 2;
              const cyP = (minY + maxY) / 2;
              if (shape === 'circle') {
                // Inscribed circle: radius = min(w, h) / 2 so the circle
                // fits inside the drag bbox.
                const rp = Math.min(w, h) / 2;
                return <circle cx={cxP} cy={-cyP} r={rp} {...previewProps} />;
              }
              if (shape === 'ellipse') {
                return <ellipse cx={cxP} cy={-cyP} rx={w / 2} ry={h / 2} {...previewProps} />;
              }
              if (shape === 'polygon') {
                const nSides = addMode.n || 6;
                const rp = Math.min(w, h) / 2;
                const offset = Math.PI / 2;
                const pts = [];
                for (let i = 0; i < nSides; i++) {
                  const t = offset + (i / nSides) * Math.PI * 2;
                  pts.push(`${cxP + rp * Math.cos(t)},${-(cyP + rp * Math.sin(t))}`);
                }
                return <polygon points={pts.join(' ')} {...previewProps} />;
              }
              // Default: rectangle
              return <rect x={minX} y={-maxY} width={w} height={h} {...previewProps} />;
            })()}
            {/* Width: span case overrides dimension match. */}
            {w > 0.001 && isSpan && showLabel(`w: span ${snapStart.compId} ↔ ${snapEnd.compId}`, (minX + maxX) / 2, maxY + labelOffsetW)}
            {w > 0.001 && !isSpan && wMatchExpr && showLabel(`w: ${wMatchExpr}`, (minX + maxX) / 2, maxY + labelOffsetW)}
            {/* Height: same logic — span overrides dimension match. */}
            {h > 0.001 && isSpan && (() => {
              const text = `h: span ${snapStart.compId} ↔ ${snapEnd.compId}`;
              const tw = (`= ${text}`).length * charW;
              const lx = maxX + labelOffsetW + tw / 2;
              return showLabel(text, lx, (minY + maxY) / 2);
            })()}
            {h > 0.001 && !isSpan && hMatchExpr && (() => {
              const tw = (`= h: ${hMatchExpr}`).length * charW;
              const lx = maxX + labelOffsetW + tw / 2;
              return showLabel(`h: ${hMatchExpr}`, lx, (minY + maxY) / 2);
            })()}
            {/* Endpoint markers: white dot for free, larger amber halo for snapped */}
            <circle cx={p1.x} cy={-p1.y} r={snapStart ? 1.2 : 0.7}
              fill={snapStart ? '#fbbf24' : 'white'}
              stroke={snapStart ? '#f59e0b' : '#0ea5e9'}
              strokeWidth={0.4} />
            {snapStart && (
              <circle cx={p1.x} cy={-p1.y} r={2.2}
                fill="none" stroke="#f59e0b" strokeWidth={0.3} opacity={0.6} />
            )}
            <circle cx={p2.x} cy={-p2.y} r={snapEnd ? 1.2 : 0.7}
              fill={snapEnd ? '#fbbf24' : 'white'}
              stroke={snapEnd ? '#f59e0b' : '#0ea5e9'}
              strokeWidth={0.4} />
            {snapEnd && (
              <circle cx={p2.x} cy={-p2.y} r={2.2}
                fill="none" stroke="#f59e0b" strokeWidth={0.3} opacity={0.6} />
            )}
          </g>
        );
      })()}

      {/* Snap preview line: from first anchor to current cursor or hover position */}
      {snapMode === 'creating' && snapPick && (() => {
        const fromComp = solved.find(c => c.id === snapPick.compId);
        if (!fromComp) return null;
        const fromW = anchorWorld(fromComp, snapPick.anchor, paramValues);
        // Endpoint: hover position if hovering on a different component's edge, else cursor
        let toX, toY, isLocked = false;
        if (snapHover && snapHover.compId !== snapPick.compId) {
          toX = snapHover.x;
          toY = snapHover.y;
          // The hover dot already had Shift applied; if shiftKey is held, mark as locked
          if (shiftKey) isLocked = true;
        } else if (snapCursor) {
          toX = snapCursor.x;
          toY = snapCursor.y;
          if (shiftKey) {
            // Snap cursor to axis-aligned with first anchor (preview only)
            const dx = toX - fromW.x;
            const dy = toY - fromW.y;
            if (Math.abs(dx) < Math.abs(dy)) toX = fromW.x; else toY = fromW.y;
            isLocked = true;
          }
        } else {
          return null;
        }
        const lineColor = isLocked ? '#22d3ee' : '#f59e0b';
        const dxLine = toX - fromW.x;
        const dyLine = toY - fromW.y;
        // dxLine/dyLine remain for status bar wiring even though they're no
        // longer used in this block now that the label moved to the status bar.
        void dxLine; void dyLine;
        return (
          <g pointerEvents="none">
            {/* Connecting line */}
            <line
              x1={fromW.x} y1={-fromW.y}
              x2={toX} y2={-toY}
              stroke={lineColor}
              strokeWidth={sw}
              strokeDasharray={isLocked ? '0' : `${sw * 3},${sw * 1.5}`}
              opacity={0.9}
            />
            {/* First-anchor marker */}
            <circle
              cx={fromW.x} cy={-fromW.y} r={hr * 0.6}
              fill="#ef4444" stroke="white" strokeWidth={sw * 0.5}
            />
            {/* Cursor-end marker */}
            <circle
              cx={toX} cy={-toY} r={hr * 0.5}
              fill={lineColor} stroke="white" strokeWidth={sw * 0.5}
            />
            {/* Distance label is rendered in the bottom status bar instead of
                on the canvas, so it doesn't obscure the line or anchor points. */}
          </g>
        );
      })()}

      {/* Ruler tool: committed measurements. The line + endpoints are
          visual only (pointer-events="none" so they don't interfere
          with selecting components underneath). A small × button on
          the right side of the readout deletes that one measurement;
          the toolbar's "clear (N)" button still clears them all in
          bulk. */}
      {rulerMeasurements.map(m => {
        const dx = m.p2.x - m.p1.x;
        const dy = m.p2.y - m.p1.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const mx = (m.p1.x + m.p2.x) / 2;
        const my = (m.p1.y + m.p2.y) / 2;
        const xBtnX = mx + 13;
        const xBtnY = -my - 2.6;
        return (
          <g key={m.id}>
            <g pointerEvents="none">
              <line
                x1={m.p1.x} y1={-m.p1.y} x2={m.p2.x} y2={-m.p2.y}
                stroke="#22d3ee" strokeWidth={0.5} opacity={0.95}
              />
              <circle cx={m.p1.x} cy={-m.p1.y} r={0.9} fill="#22d3ee" stroke="white" strokeWidth={0.2} />
              <circle cx={m.p2.x} cy={-m.p2.y} r={0.9} fill="#22d3ee" stroke="white" strokeWidth={0.2} />
              {dist > 0.01 && (
                <g>
                  <rect x={mx - 11} y={-my - 4.6} width={22} height={4} fill="rgba(15,23,42,0.9)" rx={0.5} />
                  <text x={mx} y={-my - 1.4} fontSize={2.6} fontFamily="monospace" fill="#67e8f9" textAnchor="middle">
                    {`${dist.toFixed(2)}um`}
                  </text>
                  <rect x={mx - 13} y={-my - 0.4} width={26} height={3.2} fill="rgba(15,23,42,0.85)" rx={0.5} />
                  <text x={mx} y={-my + 1.95} fontSize={2.1} fontFamily="monospace" fill="#94a3b8" textAnchor="middle">
                    {`Δx=${dx.toFixed(2)} Δy=${dy.toFixed(2)}`}
                  </text>
                </g>
              )}
            </g>
            {/* Delete affordance — its own clickable group sitting on top of
                the readout's right edge. cursor:pointer to telegraph it. */}
            {dist > 0.01 && (
              <g
                onMouseDown={(e) => { e.stopPropagation(); }}
                onClick={(e) => { e.stopPropagation(); deleteRuler(m.id); }}
                style={{ cursor: 'pointer' }}
              >
                <circle cx={xBtnX} cy={xBtnY} r={1.6} fill="#0f172a" stroke="#475569" strokeWidth={0.18} />
                <text
                  x={xBtnX} y={xBtnY + 0.85}
                  fontSize={2.1} fontFamily="monospace" fill="#cbd5e1"
                  textAnchor="middle" pointerEvents="none"
                >×</text>
                <title>Remove this measurement</title>
              </g>
            )}
          </g>
        );
      })}

      {/* Ruler tool: in-progress preview line */}
      {rulerMode && rulerInProgress && rulerSnapPoint && (() => {
        const p1 = rulerInProgress.p1;
        // Shift axis-lock: project p2 onto the dominant axis from p1
        let p2 = { x: rulerSnapPoint.x, y: rulerSnapPoint.y };
        if (shiftKey) {
          const rdx = p2.x - p1.x;
          const rdy = p2.y - p1.y;
          if (Math.abs(rdx) > Math.abs(rdy)) p2 = { x: p2.x, y: p1.y };
          else                                p2 = { x: p1.x, y: p2.y };
        }
        return (
          <g pointerEvents="none">
            <line
              x1={p1.x} y1={-p1.y} x2={p2.x} y2={-p2.y}
              stroke="#22d3ee"
              strokeWidth={sw * 0.85}
              strokeDasharray={shiftKey ? '0' : `${sw * 3},${sw * 1.5}`}
              opacity={0.85}
            />
            <circle cx={p1.x} cy={-p1.y} r={hr * 0.45} fill="#22d3ee" stroke="white" strokeWidth={sw * 0.35} />
            <circle cx={p2.x} cy={-p2.y} r={hr * 0.45} fill="#22d3ee" stroke="white" strokeWidth={sw * 0.35} />
            {/* Δx/Δy/dist are shown in the bottom status bar to keep the canvas clear. */}
          </g>
        );
      })()}

      {/* Ruler tool: hover snap-target indicator */}
      {rulerMode && rulerSnapPoint && rulerSnapPoint.label && (
        <g pointerEvents="none">
          <circle
            cx={rulerSnapPoint.x} cy={-rulerSnapPoint.y} r={hr * 0.7}
            fill="none" stroke="#22d3ee" strokeWidth={sw * 0.85}
            opacity={0.9}
          />
          <circle
            cx={rulerSnapPoint.x} cy={-rulerSnapPoint.y} r={hr * 0.25}
            fill="#22d3ee"
          />
        </g>
      )}

      {/* Marquee selection rectangle */}
      {marquee && (() => {
        const x1 = Math.min(marquee.startWorld.x, marquee.currentWorld.x);
        const x2 = Math.max(marquee.startWorld.x, marquee.currentWorld.x);
        const y1 = Math.min(marquee.startWorld.y, marquee.currentWorld.y);
        const y2 = Math.max(marquee.startWorld.y, marquee.currentWorld.y);
        return (
          <rect
            x={x1} y={-y2} width={x2 - x1} height={y2 - y1}
            fill="rgba(14,165,233,0.12)"
            stroke="#0ea5e9"
            strokeWidth={sw * 0.7}
            strokeDasharray={`${sw * 3},${sw * 1.5}`}
            pointerEvents="none"
          />
        );
      })()}

      {scene.snaps.map(s => {
        const fromComp = solved.find(c => c.id === s.from.compId);
        const toComp = solved.find(c => c.id === s.to.compId);
        if (!fromComp || !toComp) return null;
        const fp = anchorWorld(fromComp, s.from.anchor, paramValues);
        const tp = anchorWorld(toComp, s.to.anchor, paramValues);
        const isHot = selectedId && (s.from.compId === selectedId || s.to.compId === selectedId);
        // Snap connection lines: same thickness as the halo (HALO_W) so the
        // selection's relationship lines read as part of the same visual
        // language. Hot lines (touching the primary selection) get the full
        // halo width; cold lines are slightly thinner and faded.
        const snapStrokeW = isHot ? HALO_W : HALO_W * 0.55;
        const snapDashOn  = HALO_W * (isHot ? 1.6 : 1.1);
        const snapDashOff = HALO_W * (isHot ? 1.1 : 1.1);
        return (
          <g key={s.id} pointerEvents="none">
            <line
              x1={fp.x} y1={-fp.y} x2={tp.x} y2={-tp.y}
              stroke="#0ea5e9"
              strokeWidth={snapStrokeW}
              strokeDasharray={`${snapDashOn},${snapDashOff}`}
              opacity={isHot ? 0.95 : 0.4}
            />
            {/* Endpoints marker on hot snaps */}
            {isHot && <>
              <circle cx={fp.x} cy={-fp.y} r={HALO_W * 1.2} fill="#0ea5e9" />
              <circle cx={tp.x} cy={-tp.y} r={HALO_W * 1.2} fill="#0ea5e9" />
            </>}
          </g>
        );
      })}
    </svg>
  );
}
