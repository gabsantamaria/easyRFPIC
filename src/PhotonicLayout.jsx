import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { Plus, Trash2, RotateCcw, RotateCw, Download, Upload, Lock, Unlock, FlipHorizontal, FlipVertical, Layers, Settings2, Box, Square, Link2, Link2Off, Grid3x3, AlertTriangle, Maximize2, Save, FileText, FilePlus, Copy, FolderTree, BookOpen, Package, Boxes, Pencil, Ruler, Eye, EyeOff, ArrowDown, ArrowUp, Move, Repeat, Combine, Minus, X as XIcon, Circle, Hexagon } from 'lucide-react';
import { eulerBend180Centerline, buildRacetrackCenterline, offsetCenterlineToBand } from './geometry/racetrack.js';
import { tokenizeIdents, tokenizeComponentExprs, resolveParams, evalExpr, RESERVED_IDENTS } from './scene/params.js';
import { ANCHORS, parseAnchor, anchorLocal, anchorWorld } from './scene/anchors.js';
import { rectInstanceToRing, shapeInstanceToRing } from './geometry/rings.js';
import { expandTransforms } from './scene/transforms.js';
import { solveLayout, applyMirrors, resolveBooleanBboxes } from './scene/solver.js';
import { generateGDS } from './export/gds.js';
import { generatePyAEDT } from './export/pyaedt.js';
import { generateHfssNative } from './export/hfss-native.js';
import { defaultStack, normalizeScene, makeDefaultScene, makeBlankScene, paramsForStack } from './scene/schema.js';
import {
  BASE_DESIGN_PREFIX, BASE_LIB_PREFIX, BASE_ARCHIVE_PREFIX, WORKSPACE_KEY,
  designPrefix, libPrefix, archivePrefix, activeDesignKey,
  listSavedDesigns, loadDesign, saveDesign, deleteDesignStored,
  setActiveDesignName, getActiveDesignName,
  getStoredWorkspace, setStoredWorkspace, discoverWorkspaces,
} from './storage/workspace.js';
import {
  listLibraryItems, listArchivedLibraryItems,
  loadLibraryItem, loadArchivedLibraryItem,
  saveLibraryItem, saveArchivedLibraryItem,
  deleteLibraryItem, deleteArchivedLibraryItem,
  exportWorkspace, importWorkspace,
} from './storage/library-items.js';
import {
  fsAccessAPIPresent, openHandleDB,
  getWorkspaceHandle, setWorkspaceHandle as persistWorkspaceHandle,
  ensureWritePermission, writeBundleToHandle,
} from './storage/file-handle.js';
import {
  listStacks, loadStack, saveStack, deleteStack,
} from './storage/stacks.js';
import { HoverTooltip } from './ui/HoverTooltip.jsx';
import { DropdownMenu } from './ui/DropdownMenu.jsx';
import { ModalDialog } from './ui/ModalDialog.jsx';
import { WorkspaceCreateRow, LibraryItemRow } from './ui/panels/LibraryPanelRows.jsx';
import { ParamRow } from './ui/panels/ParamRow.jsx';
import { SnapAxisField, SnapConnectionRow } from './ui/panels/SnapConnectionRow.jsx';
import { TransformChainEditor } from './ui/panels/TransformChainEditor.jsx';
import { GroupTreeItem } from './ui/panels/GroupTreeItem.jsx';
import { LayerCard, LevelGroup } from './ui/panels/LayersPanel.jsx';
import { Canvas } from './ui/canvas/Canvas.jsx';
import { DeferredTextInput } from './ui/DeferredTextInput.jsx';
import { ContextMenu } from './ui/ContextMenu.jsx';
import { BUILTIN_TEMPLATES } from './templates/index.js';
import { insertLibraryPayload } from './templates/_library-insert.js';
import { generateTemplateModuleSource } from './templates/_codify.js';

// =========================================================================
// PHOTONIC IC LAYOUT TOOL — Phase 1.1
// Cursor-zoom, grid snap, vertex resize, parameter expressions
// =========================================================================

// =========================================================================
// MAIN APP
// =========================================================================
export default function App() {
  const [scene, setScene] = useState(makeDefaultScene);
  // On mount, ensure the active scene is normalized — older sessions may have a scene
  // that predates the current normalizeScene rules (e.g., missing conductor layer).
  useEffect(() => {
    setScene(prev => {
      const next = normalizeScene(prev);
      // Cheap structural check: if normalize added/changed anything, return the new one.
      if (next.stack.length !== prev.stack.length) return next;
      return prev;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Selection: ids = Set of selected component ids; primary = the "focus" used by the inspector
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [selectedId, setSelectedId] = useState(null); // primary
  const setSelection = useCallback(({ ids, primary }) => {
    setSelectedIds(ids);
    setSelectedId(primary);
  }, []);

  const [viewport, setViewport] = useState({ x: 0, y: 0, w: 400, h: 280 });
  const [snapMode, setSnapMode] = useState('idle');
  const [rulerMode, setRulerMode] = useState(false);
  // Ruler measurements: [{ id, p1: {x,y}, p2: {x,y} }]; the in-progress measurement uses p2 = null
  const [rulerMeasurements, setRulerMeasurements] = useState([]);
  const [rulerInProgress, setRulerInProgress] = useState(null); // { p1: {x,y} } when first point is picked
  const [rulerSnapPoint, setRulerSnapPoint] = useState(null); // { x, y, label } – current snap target
  // Live readout for the bottom status bar: shows snap/ruler progress (Δx, Δy,
  // distance) without putting a label on the canvas where it would obscure the
  // line and anchors. Canvas writes this; App renders it.
  const [interactionStatus, setInteractionStatus] = useState(null); // { kind, line: string }
  const [activePanel, setActivePanel] = useState('params');
  // Tracks which object rows in the SHAPES tree are currently expanded.
  // Each entry is a component id or group id. Expansion state is purely
  // a UI concern, so we keep it in App state (not in scene). Resets to
  // a sane default when scene loads (top-level objects collapsed).
  const [expandedTreeNodes, setExpandedTreeNodes] = useState(new Set());
  const toggleTreeNode = (id) => {
    setExpandedTreeNodes(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const [history, setHistory] = useState([]); // past scenes
  const [future, setFuture] = useState([]); // redo stack
  const [gridSize, setGridSize] = useState(2);
  const [gridSnapEnabled, setGridSnapEnabled] = useState(true);
  // Dimension overlay: when on, draws engineering-style dimension arrows over
  // every parameter-bound width/height/snap-offset. Variable name is the
  // primary label; numeric value is appended only if there's room.
  const [showDimensions, setShowDimensions] = useState(false);
  // Add-component mode. Set by clicking a shape button in the toolbar.
  // Drives a drag-to-create interaction in Canvas: the next click+drag
  // creates a new shape of the chosen kind on the chosen layer.
  // Shape: null | { layer: 'waveguide'|'electrode'|'port', shape: 'rect'|'circle'|'ellipse'|'polygon', n?: number, conductorLayerId?: string }
  // The legacy `kind` field is kept as a fallback for any code that still
  // reads it.
  const [addMode, setAddMode] = useState(null);
  // Active layer choice for the shape buttons in the toolbar. Persists
  // across button clicks so the user can quickly add several shapes to
  // the same layer. Defaults to 'electrode' (the conductor) since most
  // edit sessions on this codebase start by laying out signal /
  // ground / electrode features rather than waveguides.
  const [activeLayer, setActiveLayer] = useState('electrode');
  // Active conductor layer (used when activeLayer === 'electrode' and the
  // stack defines one or more conductor layers).
  const [activeConductorLayerId, setActiveConductorLayerId] = useState(null);
  // Default polygon side count for the "+ Polygon" button.
  const [polygonSides, setPolygonSides] = useState(6);
  // Whenever the stack changes, make sure activeConductorLayerId points at
  // an existing conductor layer (or the first one if none was set yet).
  useEffect(() => {
    const conductors = (scene.stack || []).filter(l => l.role === 'conductor');
    if (conductors.length === 0) {
      if (activeConductorLayerId !== null) setActiveConductorLayerId(null);
      return;
    }
    if (!conductors.some(l => l.id === activeConductorLayerId)) {
      setActiveConductorLayerId(conductors[0].id);
    }
  }, [scene.stack, activeConductorLayerId]);

  // Saved designs
  const [designName, setDesignName] = useState('Untitled');
  const [savedList, setSavedList] = useState([]);
  const [showDesigns, setShowDesigns] = useState(false);
  const [saveStatus, setSaveStatus] = useState(''); // 'saved', 'saving', 'unsaved'
  const [clipboard, setClipboard] = useState(null); // { components, snaps }
  // Holds a reference to createBoolean (defined later). Keyboard-shortcut
  // effects need the function but are wired up earlier in the component
  // body, so we defer the resolution to call-time via this ref. Updated
  // by an effect below once createBoolean exists.
  const createBooleanRef = useRef(null);
  // Same pattern for createGroup / dissolveGroup (Cmd+G / Cmd+Shift+G).
  const createGroupRef = useRef(null);
  const dissolveGroupRef = useRef(null);
  // Resolves "which group should Cmd+Shift+G dissolve right now?" based
  // on the current selection. Held via ref because the keyboard handler
  // captures it before the function's declaration.
  const currentGroupIdRef = useRef(null);
  const [exportPreview, setExportPreview] = useState(null); // { filename, content, downloaded }
  // Workspace = which "folder" of designs+library we're using. Empty string is the default folder.
  const [workspace, setWorkspace] = useState('');
  const [workspaceLoaded, setWorkspaceLoaded] = useState(false);
  const [knownWorkspaces, setKnownWorkspaces] = useState([]);
  const [showWorkspaceDialog, setShowWorkspaceDialog] = useState(false);
  // File-link state: a FileSystemFileHandle persisted for the active workspace.
  // When set, every successful design save also rewrites the workspace bundle
  // to that file. `workspaceFileLabel` is a friendly label shown in the UI
  // (the file's `name` since browsers don't expose absolute paths).
  const [workspaceHandle, setWorkspaceHandle] = useState(null);
  const [workspaceFileLabel, setWorkspaceFileLabel] = useState('');
  // True when the File System Access API is present BUT a runtime call has
  // failed because the page is hosted in a cross-origin sandboxed iframe
  // (e.g., artifact preview). In that case the picker can never open and the
  // UI should reflect this, even though the API exists on `window`.
  const [fsBlockedAtRuntime, setFsBlockedAtRuntime] = useState(false);
  const fsLinkAvailable = fsAccessAPIPresent && !fsBlockedAtRuntime;
  // Reload the linked handle whenever the active workspace changes.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const h = await getWorkspaceHandle(workspace);
      if (cancelled) return;
      setWorkspaceHandle(h || null);
      setWorkspaceFileLabel(h?.name || '');
    })();
    return () => { cancelled = true; };
  }, [workspace]);
  // Stack library state: names of stacks saved in this workspace.
  const [stackList, setStackList] = useState([]);
  const refreshStackList = useCallback(async () => {
    const names = await listStacks(workspace);
    setStackList(names.sort());
  }, [workspace]);
  useEffect(() => { refreshStackList(); }, [refreshStackList]);
  // Auto-seed the default stack 'LTOI600_NbN_EPFL' on first run so the
  // user has a baseline to switch back to even before saving anything.
  // Runs once per workspace once the list has loaded.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const names = await listStacks(workspace);
      if (cancelled) return;
      const seedName = 'LTOI600_NbN_EPFL';
      if (names.length === 0) {
        await saveStack(workspace, seedName, { name: seedName, stack: defaultStack() });
        if (!cancelled) refreshStackList();
      }
    })();
    return () => { cancelled = true; };
  }, [workspace, refreshStackList]);

  // Library state
  const [libraryItems, setLibraryItems] = useState([]); // names
  const [archivedLibraryItems, setArchivedLibraryItems] = useState([]); // names
  const [showArchive, setShowArchive] = useState(false);
  const refreshLibrary = useCallback(async () => {
    const [active, archived] = await Promise.all([listLibraryItems(workspace), listArchivedLibraryItems(workspace)]);
    setLibraryItems(active.sort());
    setArchivedLibraryItems(archived.sort());
  }, [workspace]);
  useEffect(() => { refreshLibrary(); }, [refreshLibrary]);

  // Load the user's last-used workspace once at mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const ws = await getStoredWorkspace();
      if (!cancelled) {
        setWorkspace(ws);
        setWorkspaceLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Refresh known-workspaces list on every workspace switch.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const list = await discoverWorkspaces();
      if (!cancelled) setKnownWorkspaces(list);
    })();
    return () => { cancelled = true; };
  }, [workspace, savedList, libraryItems]);

  // Dialog state — replaces window.confirm/prompt/alert which are blocked in iframes
  const [dialog, setDialog] = useState(null);
  // Helpers that return a Promise: const ok = await confirmDialog('Sure?')
  const confirmDialog = useCallback((message, title) => new Promise((resolve) => {
    setDialog({
      kind: 'confirm', title: title || 'Confirm', message,
      onConfirm: () => { setDialog(null); resolve(true); },
      onCancel: () => { setDialog(null); resolve(false); },
    });
  }), []);
  const promptDialog = useCallback((message, defaultValue, title) => new Promise((resolve) => {
    setDialog({
      kind: 'prompt', title: title || 'Input', message, defaultValue,
      onConfirm: (val) => { setDialog(null); resolve(val); },
      onCancel: () => { setDialog(null); resolve(null); },
    });
  }), []);
  const alertDialog = useCallback((message, title) => new Promise((resolve) => {
    setDialog({
      kind: 'alert', title: title || 'Notice', message,
      onConfirm: () => { setDialog(null); resolve(); },
      onCancel: () => { setDialog(null); resolve(); },
    });
  }), []);

  const refreshSavedList = useCallback(async () => {
    const list = await listSavedDesigns(workspace);
    setSavedList(list.sort());
  }, [workspace]);

  // On every workspace change (including the initial load): repopulate saved list,
  // load the active design for that workspace.
  useEffect(() => {
    if (!workspaceLoaded) return;
    (async () => {
      await refreshSavedList();
      const activeName = await getActiveDesignName(workspace);
      if (activeName) {
        const d = await loadDesign(workspace, activeName);
        if (d) {
          setScene(normalizeScene(d.scene));
          setHistory(d.history || []);
          setFuture(d.future || []);
          setDesignName(activeName);
          setSaveStatus('saved');
          return;
        }
      }
      // No active design saved in this workspace — start fresh
      setScene(normalizeScene(makeDefaultScene()));
      setHistory([]);
      setFuture([]);
      setDesignName('Untitled');
      setSaveStatus('');
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace, workspaceLoaded]);

  // Two-pass parameter resolution.
  //
  // Pass 1: resolve scene.params naïvely (no synthetics). Span-dimension
  //         params reference `_comp_<id>_cx/cy` which aren't real params, so
  //         they fail to resolve and get value 0 with an error. That's OK —
  //         we won't actually USE these values directly; they get overridden
  //         in pass 2.
  // Pass 2: solve layout using pass-1 paramValues. solveLayout internally
  //         injects `_comp_<id>_cx/cy` into a working paramValues as each
  //         component is placed, so span widths/heights resolve correctly
  //         within the solver. Then we use the solved positions to build
  //         synthetic paramValues, and re-resolve scene.params with these
  //         synthetics available. Now span params get their real values.
  // Pass 3: re-solve with the corrected paramValues to get final positions.
  //
  // The result `paramValues` contains both regular params and the synthetic
  // `_comp_<id>_cx/cy` entries, ready for use everywhere downstream.
  const { values: paramValues, errors: paramErrors } = useMemo(() => {
    const pass1 = resolveParams(scene.params);
    // Compute solved positions using pass-1 values; solver itself uses
    // workingPV-with-synthetics so span widths still work.
    const solvedPass1 = applyMirrors(solveLayout(scene.components, scene.snaps, pass1.values), scene.mirrors);
    const synthetics = {};
    for (const c of solvedPass1) {
      synthetics[`_comp_${c.id}_cx`] = c.cx;
      synthetics[`_comp_${c.id}_cy`] = c.cy;
      // _w / _h synthetics let span expressions read each parent's resolved
      // width/height directly, instead of embedding the parent's width
      // EXPRESSION text. Critical when a parent's width itself is an
      // expression like "cap_sep/2 - port_L/2" — the span needs the
      // current numeric value, not the expression literal.
      synthetics[`_comp_${c.id}_w`] = evalExpr(c.w, { ...pass1.values, ...synthetics });
      synthetics[`_comp_${c.id}_h`] = evalExpr(c.h, { ...pass1.values, ...synthetics });
    }
    // Re-resolve params with synthetics available, so span dimension
    // expressions get correct values now.
    const pass2 = resolveParams(scene.params, synthetics);
    return { values: { ...pass2.values, ...synthetics }, errors: pass2.errors };
  }, [scene.params, scene.components, scene.snaps, scene.mirrors]);

  const selected = scene.components.find(c => c.id === selectedId);
  const selectedHasIncoming = selected ? scene.snaps.some(s => s.to.compId === selected.id) : false;

  // Undo checkpointing: only commit a snapshot to history once per ~2s of continuous edits.
  // pendingCheckpointRef holds the scene as it was at the start of the current edit window.
  // checkpointTimerRef holds the timer that will commit it.
  const pendingCheckpointRef = useRef(null);
  const checkpointTimerRef = useRef(null);
  // Quiet window before a pre-edit snapshot lands on the undo stack.
  // Smaller = finer-grained undo (each typed-and-pause counts as one
  // step) but more history entries; bigger = coarser undo. 700 ms is
  // about a half-second of inactivity, which empirically separates
  // distinct edits without trying to record every single keystroke.
  const CHECKPOINT_DELAY_MS = 700;

  const updateScene = useCallback((updater) => {
    setScene(prev => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      // If we don't have a pending checkpoint yet, capture `prev` as the rollback point.
      if (pendingCheckpointRef.current === null) {
        pendingCheckpointRef.current = prev;
      }
      // Reset the commit timer
      if (checkpointTimerRef.current) clearTimeout(checkpointTimerRef.current);
      checkpointTimerRef.current = setTimeout(() => {
        // No edits for CHECKPOINT_DELAY_MS — commit the pending pre-edit state as a history entry
        const snapshot = pendingCheckpointRef.current;
        pendingCheckpointRef.current = null;
        checkpointTimerRef.current = null;
        if (snapshot !== null) {
          setHistory(h => [...h.slice(-49), snapshot]);
        }
      }, CHECKPOINT_DELAY_MS);
      return next;
    });
    setFuture([]); // any new edit clears redo
    setSaveStatus('unsaved');
  }, []);

  // Force-flush helper: if you undo or redo while a checkpoint is pending, commit it first
  // so the user can roll back to the pre-edit state correctly.
  const flushCheckpoint = useCallback(() => {
    if (checkpointTimerRef.current) {
      clearTimeout(checkpointTimerRef.current);
      checkpointTimerRef.current = null;
    }
    if (pendingCheckpointRef.current !== null) {
      const snapshot = pendingCheckpointRef.current;
      pendingCheckpointRef.current = null;
      setHistory(h => [...h.slice(-49), snapshot]);
    }
  }, []);

  const undo = () => {
    // First, flush any pending checkpoint so the latest edit window is rollback-able
    flushCheckpoint();
    setHistory(h => {
      if (h.length === 0) return h;
      const prev = h[h.length - 1];
      setFuture(f => [scene, ...f].slice(0, 50));
      setScene(prev);
      setSaveStatus('unsaved');
      return h.slice(0, -1);
    });
  };

  const redo = () => {
    flushCheckpoint();
    setFuture(f => {
      if (f.length === 0) return f;
      const next = f[0];
      setHistory(h => [...h, scene].slice(-50));
      setScene(next);
      setSaveStatus('unsaved');
      return f.slice(1);
    });
  };

  // Mirror the entire workspace to its linked file (if any). Called after
  // every successful save. Runs silently — failures don't block the save UI.
  const mirrorWorkspaceToFileIfLinked = useCallback(async () => {
    if (!workspaceHandle) return;
    try {
      const bundle = await exportWorkspace(workspace);
      const ok = await writeBundleToHandle(workspaceHandle, bundle);
      if (!ok) {
        // The handle exists but write failed — likely permission revoked
        // or the user moved the file. Surface a non-blocking warning.
        console.warn('Linked workspace file is unwritable; the link may need to be re-established.');
      }
    } catch (e) {
      console.warn('Workspace mirror failed:', e);
    }
  }, [workspace, workspaceHandle]);

  // ----- Design management -----
  const handleSave = useCallback(async () => {
    setSaveStatus('saving');
    const ok = await saveDesign(workspace, designName, { scene, history, future, updatedAt: Date.now() });
    if (ok) {
      await setActiveDesignName(workspace, designName);
      await refreshSavedList();
      setSaveStatus('saved');
      mirrorWorkspaceToFileIfLinked();
    } else {
      setSaveStatus('unsaved');
      await alertDialog('Save failed.', 'Error');
    }
  }, [workspace, designName, scene, history, future, refreshSavedList, alertDialog, mirrorWorkspaceToFileIfLinked]);

  const handleSaveAs = useCallback(async () => {
    const name = await promptDialog('Save as new design name:', designName + ' copy', 'Save As');
    if (!name || !name.trim()) return;
    const trimmed = name.trim();
    if (savedList.includes(trimmed)) {
      const ok = await confirmDialog(`"${trimmed}" already exists. Overwrite?`, 'Overwrite design');
      if (!ok) return;
    }
    setSaveStatus('saving');
    const ok = await saveDesign(workspace, trimmed, { scene, history, future, updatedAt: Date.now() });
    if (ok) {
      setDesignName(trimmed);
      await setActiveDesignName(workspace, trimmed);
      await refreshSavedList();
      setSaveStatus('saved');
      mirrorWorkspaceToFileIfLinked();
    } else {
      setSaveStatus('unsaved');
      await alertDialog('Save As failed.', 'Error');
    }
  }, [workspace, designName, scene, history, future, savedList, refreshSavedList, promptDialog, confirmDialog, alertDialog, mirrorWorkspaceToFileIfLinked]);


  const handleNew = useCallback(async () => {
    if (saveStatus === 'unsaved') {
      const ok = await confirmDialog('Discard unsaved changes and start a new design?', 'New design');
      if (!ok) return;
    }
    const name = await promptDialog('New design name:', 'Untitled', 'New design');
    if (!name || !name.trim()) return;
    const fresh = makeDefaultScene();
    setScene(fresh);
    setHistory([]);
    setFuture([]);
    setSelection({ ids: new Set(), primary: null });
    setDesignName(name.trim());
    await setActiveDesignName(workspace, name.trim());
    setSaveStatus('unsaved');
  }, [workspace, saveStatus, setSelection, confirmDialog, promptDialog]);

  // New BLANK design: completely empty scene (no default ring/electrode
  // example), but keep the default layer stack so add-tools work without
  // setup. Offers to save the current design first if it has unsaved
  // changes — saving uses the current name (or prompts for one if it's
  // still "Untitled"). If the user declines to save, we still proceed.
  const handleNewBlank = useCallback(async () => {
    if (saveStatus === 'unsaved') {
      const action = await promptDialog(
        'Save current design first?\n\nType "yes" to save it, "no" to discard, or cancel.',
        'yes',
        'New blank design'
      );
      if (action === null) return; // cancelled
      const ans = (action || '').trim().toLowerCase();
      if (ans === 'yes' || ans === 'y') {
        // Save current design under its current name. If unnamed, prompt.
        let nameToSave = designName;
        if (!nameToSave || !nameToSave.trim() || nameToSave.trim() === 'Untitled') {
          const proposed = await promptDialog('Save current design as:', designName || 'Untitled', 'Save current');
          if (!proposed || !proposed.trim()) return;
          nameToSave = proposed.trim();
        }
        const payload = { scene, history, future, savedAt: Date.now() };
        const ok = await saveDesign(workspace, nameToSave, payload);
        if (!ok) {
          await alertDialog('Failed to save current design. Aborting.', 'Save error');
          return;
        }
      } else if (ans !== 'no' && ans !== 'n') {
        // Anything other than yes/no — treat as cancel for safety.
        return;
      }
    }
    const name = await promptDialog('New blank design name:', 'Untitled', 'New blank design');
    if (!name || !name.trim()) return;
    const fresh = makeBlankScene();
    setScene(fresh);
    setHistory([]);
    setFuture([]);
    setSelection({ ids: new Set(), primary: null });
    setDesignName(name.trim());
    await setActiveDesignName(workspace, name.trim());
    setSaveStatus('unsaved');
  }, [workspace, saveStatus, designName, scene, history, future, setSelection, alertDialog, confirmDialog, promptDialog]);

  const handleLoad = useCallback(async (name) => {
    if (saveStatus === 'unsaved') {
      const ok = await confirmDialog('Discard unsaved changes and load "' + name + '"?', 'Load design');
      if (!ok) return;
    }
    const d = await loadDesign(workspace, name);
    if (!d) { await alertDialog('Failed to load.', 'Error'); return; }
    setScene(normalizeScene(d.scene));
    setHistory(d.history || []);
    setFuture(d.future || []);
    setSelection({ ids: new Set(), primary: null });
    setDesignName(name);
    await setActiveDesignName(workspace, name);
    setSaveStatus('saved');
  }, [workspace, saveStatus, setSelection, confirmDialog, alertDialog]);

  const handleDeleteDesign = useCallback(async (name) => {
    const ok = await confirmDialog(`Delete "${name}"? This cannot be undone.`, 'Delete design');
    if (!ok) return;
    await deleteDesignStored(workspace, name);
    await refreshSavedList();
    if (name === designName) {
      // Stayed on the now-deleted design. Mark as unsaved so user can re-save under a new name.
      setSaveStatus('unsaved');
    }
  }, [workspace, designName, refreshSavedList, confirmDialog]);

  const handleRenameDesign = useCallback(async (oldName, newName) => {
    if (!newName || !newName.trim() || newName === oldName) return;
    const trimmed = newName.trim();
    if (savedList.includes(trimmed)) { await alertDialog('A design with that name already exists.', 'Rename failed'); return; }
    const d = await loadDesign(workspace, oldName);
    if (!d) return;
    await saveDesign(workspace, trimmed, d);
    await deleteDesignStored(workspace, oldName);
    if (designName === oldName) {
      setDesignName(trimmed);
      await setActiveDesignName(workspace, trimmed);
    }
    await refreshSavedList();
  }, [workspace, savedList, designName, refreshSavedList, alertDialog]);

  // ----- Copy / Paste -----
  const handleCopy = useCallback(() => {
    if (selectedIds.size === 0) return;
    const ids = selectedIds;
    const components = scene.components
      .filter(c => ids.has(c.id))
      .map(c => ({ ...c, cutouts: (c.cutouts || []).map(cu => ({ ...cu })) }));
    // Internal snaps: both endpoints in the selection
    const snaps = scene.snaps
      .filter(s => ids.has(s.from.compId) && ids.has(s.to.compId))
      .map(s => ({ ...s }));
    setClipboard({ components, snaps });
    setSaveStatus(s => s); // no-op, just to indicate user feedback could go here
  }, [selectedIds, scene.components, scene.snaps]);

  const handlePaste = useCallback(() => {
    if (!clipboard || clipboard.components.length === 0) return;
    // Generate fresh IDs for pasted components, mapping old → new
    const idMap = {};
    const existingIds = new Set(scene.components.map(c => c.id));
    for (const c of clipboard.components) {
      // Try `<id>_copy`, `<id>_copy2`, …
      let candidate = `${c.id}_copy`;
      let i = 2;
      while (existingIds.has(candidate)) {
        candidate = `${c.id}_copy${i++}`;
      }
      existingIds.add(candidate);
      idMap[c.id] = candidate;
    }
    // Offset the pasted components so they're visible (in grid units)
    const offset = gridSize * 5;
    const newComponents = clipboard.components.map(c => ({
      ...c,
      id: idMap[c.id],
      cx: c.cx + offset,
      cy: c.cy - offset,
      // Width/height KEEP their parameter expressions (the whole point: shared parameters)
    }));
    // Snaps among the copied set: rewire endpoints to the new IDs
    // Note: dx/dy expressions stay the same — they reference the same gap_* parameters,
    // so the pasted pair has the same separation as the original.
    const newSnaps = clipboard.snaps.map(s => ({
      ...s,
      id: `snap_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      from: { ...s.from, compId: idMap[s.from.compId] },
      to: { ...s.to, compId: idMap[s.to.compId] },
    }));
    updateScene(prev => ({
      ...prev,
      components: [...prev.components, ...newComponents],
      snaps: [...prev.snaps, ...newSnaps],
    }));
    // Select the pasted set
    const newIds = new Set(newComponents.map(c => c.id));
    setSelection({ ids: newIds, primary: newComponents[newComponents.length - 1].id });
  }, [clipboard, scene.components, gridSize, updateScene, setSelection]);

  // Cmd+S = save, Cmd+C / Cmd+V = copy/paste, + = union, - = subtract
  useEffect(() => {
    const handler = (e) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        if (e.shiftKey) handleSaveAs();
        else handleSave();
      } else if ((e.metaKey || e.ctrlKey) && (e.key === 'c' || e.key === 'C')) {
        // Don't intercept text-area copy
        const tag = e.target?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        e.preventDefault();
        handleCopy();
      } else if ((e.metaKey || e.ctrlKey) && (e.key === 'v' || e.key === 'V')) {
        const tag = e.target?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        e.preventDefault();
        handlePaste();
      } else if ((e.metaKey || e.ctrlKey) && (e.key === 'g' || e.key === 'G')) {
        // Cmd+G  → group selected components.
        // Cmd+⇧G → ungroup whatever group the selection belongs to.
        // Skip if the user is in a text field so they can type "g" freely.
        const tag = e.target?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target?.isContentEditable) return;
        e.preventDefault();
        if (e.shiftKey) {
          const gid = currentGroupIdRef.current && currentGroupIdRef.current();
          if (gid) dissolveGroupRef.current && dissolveGroupRef.current(gid);
        } else {
          createGroupRef.current && createGroupRef.current();
        }
      } else if (e.key === '+' || e.key === '-') {
        // Boolean shortcuts: union (+) / subtract (-) act on the current
        // selection. Skip when typing in any input so users can enter
        // expressions like "x + y" or negative numbers without triggering
        // a boolean op.
        const tag = e.target?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target?.isContentEditable) return;
        // No modifier keys (avoid clashing with browser zoom on Cmd/Ctrl +/-).
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        // Read createBoolean through a ref because it's defined later in
        // this function body — putting it in the dep array would trigger
        // a TDZ error at component init. The ref always points to the
        // latest createBoolean closure once App's body has finished.
        const fn = createBooleanRef.current;
        if (!fn) return;
        if (selectedIds.size < 2) return;
        e.preventDefault();
        if (e.key === '+') fn('union');
        else fn('subtract');
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handleSave, handleSaveAs, handleCopy, handlePaste, selectedIds]);

  // ----- Autosave -----
  // Save to storage 2 seconds after the last edit, but only for designs that
  // already exist in storage (i.e., the user has saved at least once).
  // We persist the full undo/redo stacks alongside the scene.
  const [lastAutoSavedAt, setLastAutoSavedAt] = useState(null);
  const autosaveTimerRef = useRef(null);
  useEffect(() => {
    // Only autosave when status is unsaved AND the design name exists in saved list
    if (saveStatus !== 'unsaved') return;
    if (!designName || !savedList.includes(designName)) return;
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    autosaveTimerRef.current = setTimeout(async () => {
      setSaveStatus('saving');
      const ok = await saveDesign(workspace, designName, { scene, history, future, updatedAt: Date.now() });
      if (ok) {
        setSaveStatus('saved');
        setLastAutoSavedAt(Date.now());
        // Mirror the workspace bundle to the linked file (if any) — autosave
        // takes the same path as a manual save here.
        mirrorWorkspaceToFileIfLinked();
      } else {
        setSaveStatus('unsaved');
      }
    }, 2000);
    return () => {
      if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    };
  }, [workspace, scene, history, future, designName, savedList, saveStatus, mirrorWorkspaceToFileIfLinked]);

  // Tick to update "saved Xs ago" label every 5s
  const [tickNow, setTickNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setTickNow(Date.now()), 5000);
    return () => clearInterval(id);
  }, []);
  const savedAgoLabel = useMemo(() => {
    if (!lastAutoSavedAt) return '';
    const sec = Math.floor((tickNow - lastAutoSavedAt) / 1000);
    if (sec < 5) return 'just saved';
    if (sec < 60) return `${sec}s ago`;
    if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
    return `${Math.floor(sec / 3600)}h ago`;
  }, [lastAutoSavedAt, tickNow]);

  // Fit-to-view: compute bounding box of all components and adjust viewport
  const fitToView = useCallback(() => {
    const solved = applyMirrors(solveLayout(scene.components, scene.snaps, paramValues), scene.mirrors);
    if (solved.length === 0) {
      setViewport({ x: 0, y: 0, w: 400, h: 280 });
      return;
    }
    const xs = solved.flatMap(c => [c.cx - evalExpr(c.w, paramValues) / 2, c.cx + evalExpr(c.w, paramValues) / 2]);
    const ys = solved.flatMap(c => [c.cy - evalExpr(c.h, paramValues) / 2, c.cy + evalExpr(c.h, paramValues) / 2]);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const bw = Math.max(maxX - minX, 1);
    const bh = Math.max(maxY - minY, 1);
    // 10% padding on each side
    const pad = 1.2;
    setViewport({ x: cx, y: cy, w: bw * pad, h: bh * pad });
  }, [scene, paramValues]);

  // Keyboard shortcuts (F = fit, Delete/Backspace = delete selected, Cmd+Z = undo, Cmd+Shift+Z = redo)
  useEffect(() => {
    const handler = (e) => {
      const tag = e.target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === 'f' || e.key === 'F') {
        e.preventDefault();
        fitToView();
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedIds.size > 0) {
        e.preventDefault();
        deleteCompRef.current?.(selectedIds);
      } else if ((e.metaKey || e.ctrlKey) && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        if (e.shiftKey) {
          redoRef.current?.();
        } else {
          undoRef.current?.();
        }
      } else if ((e.metaKey || e.ctrlKey) && (e.key === 'y' || e.key === 'Y')) {
        e.preventDefault();
        redoRef.current?.();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [fitToView, selectedIds]);

  // Refs so handlers always see the latest functions
  const undoRef = useRef(null);
  const redoRef = useRef(null);
  undoRef.current = undo;
  redoRef.current = redo;


  // ref so the keyboard handler always sees the latest deleteComp without re-binding
  const deleteCompRef = useRef(null);

  // Auto-parametrize a new shape: create <id>_w and <id>_h params
  const addComponent = (layerKind, conductorLayerId = null) => {
    // layerKind: 'waveguide', 'electrode', or 'port' (component-level layer label)
    // conductorLayerId: optional stack-layer id (e.g. 'l_cond') to bind this component to
    // a specific conductor layer in the stack. Only meaningful when layerKind === 'electrode'.
    const conductorLayer = conductorLayerId
      ? (scene.stack || []).find(l => l.id === conductorLayerId)
      : null;
    const idPrefix = layerKind === 'waveguide' ? 'wg'
      : layerKind === 'port' ? 'port'
      : (conductorLayer ? conductorLayer.id.replace(/^l_/, '') : 'el');
    const baseId = `${idPrefix}${scene.components.filter(c => c.layer === layerKind).length + 1}`;
    let id = baseId;
    let suffix = 0;
    while (scene.components.some(c => c.id === id)) { suffix++; id = `${baseId}_${suffix}`; }
    const wParam = `${id}_w`;
    const hParam = `${id}_h`;
    updateScene(prev => ({
      ...prev,
      params: {
        ...prev.params,
        [wParam]: { expr: '20', unit: 'µm', desc: `${id} width` },
        [hParam]: { expr: '20', unit: 'µm', desc: `${id} height` },
      },
      components: [...prev.components, {
        id, kind: 'rect', layer: layerKind,
        cx: viewport.x, cy: viewport.y,
        w: wParam, h: hParam,
        cutouts: [], label: id,
        ...(conductorLayerId ? { conductorLayerId } : {}),
      }],
    }));
    setSelection({ ids: new Set([id]), primary: id });
  };

  // Finalize a drag-to-create operation. Inputs come from Canvas:
  //   spec: { kind, conductorLayerId? }
  //   p1, p2: the two world-space drag corner points (in any orientation)
  //   snapStart: optional { compId, anchor, x, y } if the START of the drag
  //              landed on an existing anchor — we install a snap to that anchor.
  //   snapEnd:   optional similar, for the END.
  //
  // Heuristics (in priority order):
  //   1. If the bounding-box width matches an existing component's resolved
  //      width within a tolerance, REUSE that component's `w` expression so
  //      the new component is parametrically tied to the same dimension.
  //      Same for height. Otherwise create fresh `<id>_w` and `<id>_h` params.
  //   2. If snapStart is set, install a snap from snapStart's anchor to the
  //      nearest corner anchor of the new component (so the drag's start
  //      point becomes a parametric reference instead of a literal position).
  //   3. If only snapEnd is set, treat it as snapStart (the snap is symmetric
  //      since the new rect is being placed; we just pick a near corner).
  const commitDragAdd = (spec, p1, p2, snapStart, snapEnd) => {
    // spec accepts both old and new shapes:
    //   old: { kind: 'waveguide'|'electrode'|'port', conductorLayerId? }
    //   new: { layer: 'waveguide'|'electrode'|'port', shape: 'rect'|'circle'|'ellipse'|'polygon', n?, conductorLayerId? }
    // Where a layer is provided in the new style, we use that; otherwise we
    // fall back to the legacy `kind` field which served as the layer name.
    const layerKind = spec.layer || spec.kind || 'waveguide';
    const shapeKind = spec.shape || 'rect';
    const conductorLayerId = spec.conductorLayerId || null;
    const conductorLayer = conductorLayerId
      ? (scene.stack || []).find(l => l.id === conductorLayerId)
      : null;
    const layerPrefix = layerKind === 'waveguide' ? 'wg'
      : layerKind === 'port' ? 'port'
      : (conductorLayer ? conductorLayer.id.replace(/^l_/, '') : 'el');
    // Shape-flavored id prefix so users can tell circles from rects from
    // polygons at a glance in the SHAPES tree.
    const shapePrefix = shapeKind === 'circle' ? 'circ'
      : shapeKind === 'ellipse' ? 'ell'
      : shapeKind === 'polygon' ? 'poly'
      : layerPrefix;
    const idPrefix = shapeKind === 'rect' ? layerPrefix : shapePrefix;
    const baseId = `${idPrefix}${scene.components.filter(c => c.layer === layerKind).length + 1}`;
    let id = baseId;
    let suffix = 0;
    while (scene.components.some(c => c.id === id)) { suffix++; id = `${baseId}_${suffix}`; }

    const minX = Math.min(p1.x, p2.x);
    const maxX = Math.max(p1.x, p2.x);
    const minY = Math.min(p1.y, p2.y);
    const maxY = Math.max(p1.y, p2.y);
    // If a drag has near-zero extent on an axis (e.g., user dragged purely
    // horizontally between two anchors that share a Y coordinate), the
    // resulting rect would be invisible. Clamp to a minimum visible thickness
    // so the user gets a tangible result they can resize afterwards.
    const MIN_THICK = 5; // µm — typical photonic feature scale
    const rawW = maxX - minX;
    const rawH = maxY - minY;
    const width  = rawW < 1e-3 ? MIN_THICK : Math.max(0.1, rawW);
    const height = rawH < 1e-3 ? MIN_THICK : Math.max(0.1, rawH);
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;

    // Try to bind to an existing component's width/height. Tolerance of 0.5 µm
    // catches "you dragged to roughly the same size as that other thing."
    // This catches the common case of dragging across an entire face of an
    // existing component (corner-to-corner along its top/side).
    const TOL = 0.5;
    let wExpr = null, hExpr = null;
    for (const c of scene.components) {
      const cw = evalExpr(c.w, paramValues);
      const ch = evalExpr(c.h, paramValues);
      if (!wExpr && Number.isFinite(cw) && Math.abs(cw - width) < TOL) wExpr = c.w;
      if (!hExpr && Number.isFinite(ch) && Math.abs(ch - height) < TOL) hExpr = c.h;
      if (wExpr && hExpr) break;
    }

    // Cross-component span case: when both endpoints snap to different
    // components, only one snap can position the new rect (a component can
    // only be the `to` of one snap). To keep the new rect "stretched" between
    // the two — staying connected on both sides if either parent moves OR is
    // resized — we make the unsnapped dimensions parametric expressions that
    // reference each parent's CURRENT solved position via synthetic
    // `_comp_<id>_cx` / `_comp_<id>_cy` paramValues injected by solveLayout.
    // This is critical: capturing parents' positions as literal snapshots at
    // creation time fails when the parent later moves, because the literal
    // never updates. Synthetic `_comp_<id>_cx` paramValues update on every
    // re-solve, so the span expression recomputes against current positions.
    //
    // Helper: build an EXPRESSION string for the world X/Y of an anchor on a
    // given component, using synthetic `_comp_<id>_cx/cy/w/h` so the expression
    // tracks the parent's CURRENT solved position AND size — not snapshots.
    // Critical when the parent's width/height is itself an expression like
    // `cap_sep/2 - port_L/2`: embedding that expression text in the span would
    // bind to whatever value `cap_sep`/`port_L` had at creation, and stop
    // tracking if the parent's `w`/`h` expression is later replaced (e.g. by
    // the resize handler clobbering it to a literal numeric).
    const anchorOffsetExprs = (compId, anchorName) => {
      const wRef = `_comp_${compId}_w`;
      const hRef = `_comp_${compId}_h`;
      const a = parseAnchor(anchorName);
      let xOff = '0', yOff = '0';
      if (a.kind === 'edge') {
        if (a.side === 'T') { xOff = `(${a.t} - 0.5) * (${wRef})`; yOff = `(${hRef})/2`; }
        else if (a.side === 'B') { xOff = `(${a.t} - 0.5) * (${wRef})`; yOff = `-(${hRef})/2`; }
        else if (a.side === 'L') { xOff = `-(${wRef})/2`; yOff = `(${a.t} - 0.5) * (${hRef})`; }
        else if (a.side === 'R') { xOff = `(${wRef})/2`;  yOff = `(${a.t} - 0.5) * (${hRef})`; }
      } else {
        const n = a.name;
        if (n.includes('W')) xOff = `-(${wRef})/2`;
        else if (n.includes('E')) xOff = `(${wRef})/2`;
        if (n.includes('S')) yOff = `-(${hRef})/2`;
        else if (n.includes('N')) yOff = `(${hRef})/2`;
      }
      return { xOff, yOff };
    };
    // Build (xExpr, yExpr) for an anchor's world position on `compId`.
    const anchorWorldExprs = (compId, anchorName) => {
      const c = scene.components.find(cc => cc.id === compId);
      if (!c) return null;
      const off = anchorOffsetExprs(compId, anchorName);
      return {
        x: `(_comp_${compId}_cx) + (${off.xOff})`,
        y: `(_comp_${compId}_cy) + (${off.yOff})`,
      };
    };

    // Decide whether to compute parametric span dimensions. Only do this when
    // both endpoints snap to DIFFERENT components — same-component is already
    // handled by the dimension-match branch above.
    let spanWExpr = null, spanHExpr = null;
    const spanCase = !!(snapStart && snapEnd && snapStart.compId !== snapEnd.compId);
    if (spanCase) {
      const aExpr = anchorWorldExprs(snapStart.compId, snapStart.anchor);
      const bExpr = anchorWorldExprs(snapEnd.compId, snapEnd.anchor);
      if (aExpr && bExpr) {
        // The new rect's snapped corner sits at snapStart; the opposite
        // corner sits at snapEnd. Width/height are signed expressions
        // (B - A) or (A - B) depending on drag direction, so the rect grows
        // in the right direction as parents move. The sign is FIXED at
        // creation; if parents cross over later, the rect goes negative —
        // user error.
        const dragSignX = (snapEnd.x >= snapStart.x) ? 1 : -1;
        const dragSignY = (snapEnd.y >= snapStart.y) ? 1 : -1;
        const candidateW = dragSignX > 0
          ? `((${bExpr.x}) - (${aExpr.x}))`
          : `((${aExpr.x}) - (${bExpr.x}))`;
        const candidateH = dragSignY > 0
          ? `((${bExpr.y}) - (${aExpr.y}))`
          : `((${aExpr.y}) - (${bExpr.y}))`;
        // ALWAYS install span expressions on both axes when both endpoints
        // snap. The expression tracks each parent's CURRENT solved position,
        // so the new rect stays connected to BOTH parents as either is moved
        // or resized.
        //
        // Edge case: when an axis is degenerate at creation (both anchors
        // share that coordinate), the span evaluates to 0. We pad with a
        // visible MIN_THICK constant for that axis so the rect is visible
        // at creation. As parents later diverge, the span term grows and
        // the rect inflates accordingly.
        const solvedNow = solveLayout(scene.components, scene.snaps, paramValues);
        const validationPV = { ...paramValues };
        for (const c of solvedNow) {
          validationPV[`_comp_${c.id}_cx`] = c.cx;
          validationPV[`_comp_${c.id}_cy`] = c.cy;
          validationPV[`_comp_${c.id}_w`] = evalExpr(c.w, validationPV);
          validationPV[`_comp_${c.id}_h`] = evalExpr(c.h, validationPV);
        }
        const wEval = evalExpr(candidateW, validationPV);
        const hEval = evalExpr(candidateH, validationPV);
        const SPAN_MIN_THICK = 5; // µm — visible default for degenerate axes
        if (Number.isFinite(wEval) && Math.abs(wEval) > 0.01) {
          spanWExpr = candidateW;
        } else {
          spanWExpr = `(${candidateW}) + ${SPAN_MIN_THICK}`;
        }
        if (Number.isFinite(hEval) && Math.abs(hEval) > 0.01) {
          spanHExpr = candidateH;
        } else {
          spanHExpr = `(${candidateH}) + ${SPAN_MIN_THICK}`;
        }
      }
    }

    // Pick the new rect's corner anchor closest to the drag-start point.
    // Used for installing a snap from snapStart.compId.snapStart.anchor →
    // newComp.<corner>.
    const cornerAnchor = (px, py) => {
      const isLeft = Math.abs(px - minX) < Math.abs(px - maxX);
      const isBot  = Math.abs(py - minY) < Math.abs(py - maxY);
      if (isLeft && isBot)  return 'SW';
      if (!isLeft && isBot) return 'SE';
      if (isLeft && !isBot) return 'NW';
      return 'NE';
    };

    const usedNames = new Set(Object.keys(scene.params));
    const nextName = (prefix) => {
      let i = 1;
      while (usedNames.has(`${prefix}${i}`)) i++;
      usedNames.add(`${prefix}${i}`);
      return `${prefix}${i}`;
    };

    updateScene(prev => {
      const newParams = { ...prev.params };
      // Width / height. Priority: span-case parametric > dimension-match >
      // fresh literal parameter.
      let finalW, finalH;
      if (spanWExpr) {
        const wParam = `${id}_w`;
        newParams[wParam] = { expr: spanWExpr, unit: 'µm', desc: `${id} width — spans from ${snapStart.compId}.${snapStart.anchor} to ${snapEnd.compId}.${snapEnd.anchor}` };
        finalW = wParam;
      } else if (wExpr) {
        finalW = wExpr;
      } else {
        const wParam = `${id}_w`;
        newParams[wParam] = { expr: width.toFixed(3), unit: 'µm', desc: `${id} width` };
        finalW = wParam;
      }
      if (spanHExpr) {
        const hParam = `${id}_h`;
        newParams[hParam] = { expr: spanHExpr, unit: 'µm', desc: `${id} height — spans from ${snapStart.compId}.${snapStart.anchor} to ${snapEnd.compId}.${snapEnd.anchor}` };
        finalH = hParam;
      } else if (hExpr) {
        finalH = hExpr;
      } else {
        const hParam = `${id}_h`;
        newParams[hParam] = { expr: height.toFixed(3), unit: 'µm', desc: `${id} height` };
        finalH = hParam;
      }
      // Build the new component. For non-rect shapes we ALSO need
      // primary parameters: r for circle, rx/ry for ellipse, r/n for
      // polygon. AABB w/h are derived from those parameters so the rest
      // of the layout system (snaps, anchors, dimensions, exports) sees
      // a consistent bounding box without needing per-shape branches
      // everywhere.
      let newComp;
      if (shapeKind === 'circle') {
        // Radius = half the smaller bbox side (inscribed circle).
        // w/h reference the radius so the bbox tracks if the user edits
        // the radius later.
        const rParam = `${id}_r`;
        const rVal = Math.min(width, height) / 2;
        newParams[rParam] = { expr: rVal.toFixed(3), unit: 'µm', desc: `${id} radius` };
        newComp = {
          id, kind: 'circle', layer: layerKind,
          cx, cy,
          r: rParam,
          // Derived AABB for snap/anchor consistency.
          w: `2*${rParam}`, h: `2*${rParam}`,
          cutouts: [], label: id,
          ...(conductorLayerId ? { conductorLayerId } : {}),
        };
      } else if (shapeKind === 'ellipse') {
        const rxParam = `${id}_rx`;
        const ryParam = `${id}_ry`;
        newParams[rxParam] = { expr: (width / 2).toFixed(3), unit: 'µm', desc: `${id} x-semi-axis` };
        newParams[ryParam] = { expr: (height / 2).toFixed(3), unit: 'µm', desc: `${id} y-semi-axis` };
        newComp = {
          id, kind: 'ellipse', layer: layerKind,
          cx, cy,
          rx: rxParam, ry: ryParam,
          w: `2*${rxParam}`, h: `2*${ryParam}`,
          cutouts: [], label: id,
          ...(conductorLayerId ? { conductorLayerId } : {}),
        };
      } else if (shapeKind === 'polygon') {
        const rParam = `${id}_r`;
        const nParam = `${id}_n`;
        const rVal = Math.min(width, height) / 2;
        const nVal = Math.max(3, Math.round(spec.n || 6));
        newParams[rParam] = { expr: rVal.toFixed(3), unit: 'µm', desc: `${id} circumradius` };
        newParams[nParam] = { expr: String(nVal), unit: '', desc: `${id} number of sides` };
        newComp = {
          id, kind: 'polygon', layer: layerKind,
          cx, cy,
          r: rParam, n: nParam,
          // Polygon AABB is bounded by the circumscribed circle (≤ 2r in
          // each axis). Using 2r over-approximates slightly for polygons
          // whose vertices don't fall on the axes, but keeps snap anchors
          // predictable.
          w: `2*${rParam}`, h: `2*${rParam}`,
          cutouts: [], label: id,
          ...(conductorLayerId ? { conductorLayerId } : {}),
        };
      } else {
        // Rectangle (default).
        newComp = {
          id, kind: 'rect', layer: layerKind,
          cx, cy,
          w: finalW, h: finalH,
          cutouts: [], label: id,
          ...(conductorLayerId ? { conductorLayerId } : {}),
        };
      }
      const newSnaps = [];
      // Choose which drag corner to snap (prefer start, fall back to end).
      const snapAnchor = snapStart || snapEnd;
      if (snapAnchor) {
        const dragPt = snapStart ? p1 : p2;
        const newAnchor = cornerAnchor(dragPt.x, dragPt.y);
        // dx, dy = 0 because the snapped corner is exactly at the anchor's
        // world position. Create gap params anyway so the user can edit them
        // later (consistent with how interactive snap creation works).
        const gapX = nextName('gap_x');
        newParams[gapX] = { expr: '0', unit: 'µm', desc: `Gap ${snapAnchor.compId}.${snapAnchor.anchor} → ${id}.${newAnchor} (dx)` };
        const gapY = nextName('gap_y');
        newParams[gapY] = { expr: '0', unit: 'µm', desc: `Gap ${snapAnchor.compId}.${snapAnchor.anchor} → ${id}.${newAnchor} (dy)` };
        newSnaps.push({
          id: `snap_${Date.now()}`,
          from: { compId: snapAnchor.compId, anchor: snapAnchor.anchor },
          to:   { compId: id,                 anchor: newAnchor },
          dx: gapX, dy: gapY,
        });
      }
      return {
        ...prev,
        params: newParams,
        components: [...prev.components, newComp],
        snaps: [...prev.snaps, ...newSnaps],
      };
    });
    setSelection({ ids: new Set([id]), primary: id });
  };

  const updateComp = (id, patch) => {
    updateScene(prev => {
      const target = prev.components.find(c => c.id === id);
      if (!target) return prev;
      // Group transform propagation: groups act like a composite object,
      // so a transform-chain edit on any one member should apply to
      // every member. Otherwise a Repeat / Rotate / Displace on a
      // grouped primitive would visibly affect only that primitive and
      // tear the group apart (each member at a different repeat phase).
      // Other patch fields stay per-component — only `transforms`
      // propagates, so layer / w / h / cx / cy / label / etc. on a
      // grouped member still edit that single member.
      const groupName = target.group;
      const propagateTransforms = groupName && Object.prototype.hasOwnProperty.call(patch, 'transforms');
      // Deep-clone the transforms list per recipient so each member has
      // its own array identity (the solver mutates per-instance state
      // off the transform records via expandTransforms, and aliasing
      // could in theory bite us on a future change).
      const cloneTransforms = (ts) => (ts || []).map((t) => ({ ...t }));
      return {
        ...prev,
        components: prev.components.map(c => {
          if (c.id === id) return { ...c, ...patch };
          // Propagate to group members EXCEPT operands of a boolean
          // (consumedBy != null). A consumed operand inherits its
          // transform stream from its parent boolean's cluster, so
          // copying transforms onto it directly would double-apply.
          if (propagateTransforms && c.group === groupName && !c.consumedBy) {
            return { ...c, transforms: cloneTransforms(patch.transforms) };
          }
          return c;
        }),
      };
    });
  };

  const deleteComp = (idOrSet) => {
    const idSet = idOrSet instanceof Set ? idOrSet : new Set([idOrSet]);
    if (idSet.size === 0) return;
    updateScene(prev => {
      // Remove deleted ids from each group's memberIds; drop groups that become empty
      const newGroups = prev.groups
        .map(g => ({ ...g, memberIds: g.memberIds.filter(id => !idSet.has(id)) }))
        .filter(g => g.memberIds.length > 0);
      return {
        ...prev,
        components: prev.components.filter(c => !idSet.has(c.id)),
        snaps: prev.snaps.filter(s => !idSet.has(s.from.compId) && !idSet.has(s.to.compId)),
        mirrors: prev.mirrors
          .map(m => ({ ...m, members: m.members.filter(mm => !idSet.has(mm.srcId) && !idSet.has(mm.mirrorId)) }))
          .filter(m => m.members.length > 0),
        groups: newGroups,
      };
    });
    setSelection({ ids: new Set(), primary: null });
  };
  deleteCompRef.current = deleteComp;

  const deleteSelected = () => {
    if (selectedIds.size > 0) deleteComp(selectedIds);
  };

  // Z-order ops. The render order is the array order in scene.components
  // (later entries paint on top), so all four are list-reorder operations
  // on a single component. Multi-select isn't reordered — apply one at a
  // time if you need that.
  const bringToFront = (id) => updateScene(prev => {
    const target = prev.components.find(c => c.id === id);
    if (!target) return prev;
    const others = prev.components.filter(c => c.id !== id);
    return { ...prev, components: [...others, target] };
  });
  const sendToBack = (id) => updateScene(prev => {
    const target = prev.components.find(c => c.id === id);
    if (!target) return prev;
    const others = prev.components.filter(c => c.id !== id);
    return { ...prev, components: [target, ...others] };
  });
  const bringForward = (id) => updateScene(prev => {
    const idx = prev.components.findIndex(c => c.id === id);
    if (idx < 0 || idx >= prev.components.length - 1) return prev;
    const next = [...prev.components];
    [next[idx], next[idx + 1]] = [next[idx + 1], next[idx]];
    return { ...prev, components: next };
  });
  const sendBackward = (id) => updateScene(prev => {
    const idx = prev.components.findIndex(c => c.id === id);
    if (idx <= 0) return prev;
    const next = [...prev.components];
    [next[idx], next[idx - 1]] = [next[idx - 1], next[idx]];
    return { ...prev, components: next };
  });

  // Duplicate a set of ids in place — inline so it doesn't have to round-trip
  // through clipboard state (handleCopy + handlePaste would work but their
  // closures only see the post-setClipboard value on the next render).
  // Mirrors handleCopy + handlePaste's id-renaming and offset behavior.
  const duplicateIds = (idSet) => {
    const ids = idSet instanceof Set ? idSet : new Set([idSet]);
    if (ids.size === 0) return;
    const comps = scene.components.filter(c => ids.has(c.id))
      .map(c => ({ ...c, cutouts: (c.cutouts || []).map(cu => ({ ...cu })) }));
    const internalSnaps = scene.snaps
      .filter(s => ids.has(s.from.compId) && ids.has(s.to.compId))
      .map(s => ({ ...s }));
    const idMap = {};
    const existingIds = new Set(scene.components.map(c => c.id));
    for (const c of comps) {
      let candidate = `${c.id}_copy`;
      let i = 2;
      while (existingIds.has(candidate)) candidate = `${c.id}_copy${i++}`;
      existingIds.add(candidate);
      idMap[c.id] = candidate;
    }
    const offset = gridSize * 5;
    const newComps = comps.map(c => ({
      ...c,
      id: idMap[c.id],
      cx: c.cx + offset,
      cy: c.cy - offset,
    }));
    const newSnaps = internalSnaps.map(s => ({
      ...s,
      id: `snap_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      from: { ...s.from, compId: idMap[s.from.compId] },
      to: { ...s.to, compId: idMap[s.to.compId] },
    }));
    updateScene(prev => ({
      ...prev,
      components: [...prev.components, ...newComps],
      snaps: [...prev.snaps, ...newSnaps],
    }));
    const newSel = new Set(newComps.map(c => c.id));
    setSelection({ ids: newSel, primary: newComps[newComps.length - 1].id });
  };

  // Right-click context menu state (right-clicking a component opens it).
  // null when closed; otherwise { x, y, items }.
  const [contextMenu, setContextMenu] = useState(null);
  const openComponentContextMenu = ({ compId, x, y }) => {
    const comp = scene.components.find(c => c.id === compId);
    if (!comp) return;
    const idx = scene.components.findIndex(c => c.id === compId);
    const isFront = idx === scene.components.length - 1;
    const isBack = idx === 0;
    const multi = selectedIds.has(compId) && selectedIds.size > 1;
    // Group context: dissolve is enabled when ANY selected component
    // (or the right-clicked one) belongs to a group; create is enabled
    // when there are ≥ 2 selected.
    const ungroupId = (() => {
      const byId = Object.fromEntries(scene.components.map(c => [c.id, c]));
      const ids = selectedIds.has(compId) ? selectedIds : new Set([compId]);
      for (const id of ids) {
        const c = byId[id];
        if (c && c.group) {
          const g = scene.groups.find(g => g.name === c.group);
          if (g) return g.id;
        }
      }
      return null;
    })();
    const items = [
      { label: 'Bring to front', icon: ArrowUp, onClick: () => bringToFront(compId), disabled: isFront },
      { label: 'Bring forward', onClick: () => bringForward(compId), disabled: isFront, hint: '↑' },
      { label: 'Send backward', onClick: () => sendBackward(compId), disabled: isBack, hint: '↓' },
      { label: 'Send to back', icon: ArrowDown, onClick: () => sendToBack(compId), disabled: isBack },
      { divider: true },
      // Grouping: the ref pattern lets us call createGroup/dissolveGroup
      // even though they're declared later in App's body.
      { label: 'Group', icon: FolderTree, hint: '⌘G',
        onClick: () => createGroupRef.current && createGroupRef.current(),
        disabled: selectedIds.size < 2,
      },
      { label: 'Ungroup', hint: '⌘⇧G',
        onClick: () => ungroupId && dissolveGroupRef.current && dissolveGroupRef.current(ungroupId),
        disabled: !ungroupId,
      },
      { divider: true },
      { label: multi ? `Duplicate (${selectedIds.size})` : 'Duplicate', icon: Copy,
        onClick: () => duplicateIds(multi ? selectedIds : new Set([compId])) },
      { divider: true },
      { label: multi ? `Delete (${selectedIds.size})` : 'Delete', icon: Trash2,
        onClick: () => deleteComp(multi ? selectedIds : new Set([compId])), hint: 'Del' },
    ];
    setContextMenu({ x, y, items });
  };

  const deleteSnap = (snapId) => updateScene(prev => ({ ...prev, snaps: prev.snaps.filter(s => s.id !== snapId) }));
  const updateSnap = (snapId, patch) => updateScene(prev => ({
    ...prev,
    snaps: prev.snaps.map(s => s.id === snapId ? { ...s, ...patch } : s),
  }));

  // Re-root the snap chain so that `rootId` becomes the parent. Walks the
  // connected component of the snap graph reachable from `rootId` (treating
  // snaps as undirected edges), and orients every snap to point AWAY from
  // rootId. Snaps already pointing the right way are kept; snaps pointing
  // toward the new root are reversed (with offsets negated and dx/dy parameter
  // expressions wrapped/flipped accordingly).
  //
  // For each snap that needs flipping, dx/dy expressions are negated. If they
  // are sole references to parameters, those parameters' expressions are
  // negated in place — only when they're not shared by anything else.
  // Otherwise we wrap the expression with -(...) so the snap geometry is
  // preserved.
  const reRootSnapChain = (rootId) => {
    updateScene(prev => {
      // Reference-counter for parameter names across the scene; used to decide
      // whether we can negate a param's expr in place (single use) vs wrap the
      // snap's offset in -(...) (shared).
      const paramRefCount = (paramName, snapsToConsider) => {
        let n = 0;
        for (const sn of snapsToConsider) {
          if (sn.dx === paramName) n++;
          if (sn.dy === paramName) n++;
        }
        for (const c of prev.components) {
          for (const f of ['w', 'h']) if (c[f] === paramName) n++;
          for (const cu of (c.cutouts || [])) {
            for (const f of ['dx', 'dy', 'w', 'h']) if (cu[f] === paramName) n++;
          }
        }
        for (const [, p] of Object.entries(prev.params)) {
          if (typeof p.expr === 'string' && tokenizeIdents(p.expr).includes(paramName)) n++;
        }
        return n;
      };

      const newParams = { ...prev.params };
      const newSnaps = [];
      // Track which params we've already negated in place, so we don't double-flip
      // if the same param is referenced by multiple flipped snaps.
      const alreadyNegated = new Set();

      const negateOffset = (offsetExpr) => {
        if (typeof offsetExpr !== 'string') return offsetExpr;
        const stripped = offsetExpr.trim();
        if (/^[A-Za-z_][\w]*$/.test(stripped) && newParams[stripped]) {
          if (alreadyNegated.has(stripped)) {
            // Already flipped once via in-place edit; flipping again would
            // restore the original sign. Wrap the snap-side instead.
            return `-(${offsetExpr})`;
          }
          const refs = paramRefCount(stripped, prev.snaps);
          if (refs <= 2) {
            // 'refs' counts each occurrence; a sole-snap reference shows up
            // once on dx OR dy of the same snap. We allow up to 2 just in case
            // both dx and dy share the param (rare).
            const old = newParams[stripped].expr;
            newParams[stripped] = { ...newParams[stripped], expr: `-(${old})` };
            alreadyNegated.add(stripped);
            return stripped;
          }
        }
        return `-(${offsetExpr})`;
      };

      // BFS from rootId, treating snaps as undirected. Each snap is visited
      // exactly once (tracked by id) and oriented to point away from root.
      const visited = new Set([rootId]);
      const queue = [rootId];
      const handledSnapIds = new Set();
      while (queue.length > 0) {
        const here = queue.shift();
        for (const s of prev.snaps) {
          if (handledSnapIds.has(s.id)) continue;
          if (s.from.compId === here && !visited.has(s.to.compId)) {
            // Already pointing away — keep as-is
            newSnaps.push(s);
            handledSnapIds.add(s.id);
            visited.add(s.to.compId);
            queue.push(s.to.compId);
          } else if (s.to.compId === here && !visited.has(s.from.compId)) {
            // Pointing toward us — flip
            newSnaps.push({
              ...s,
              from: { compId: s.to.compId, anchor: s.to.anchor },
              to:   { compId: s.from.compId, anchor: s.from.anchor },
              dx: negateOffset(s.dx),
              dy: negateOffset(s.dy),
            });
            handledSnapIds.add(s.id);
            visited.add(s.from.compId);
            queue.push(s.from.compId);
          }
          // Snaps where both endpoints are already visited: it's a cycle edge.
          // Keep its current orientation (we can't sensibly re-root a cycle).
        }
      }
      // Append snaps that weren't part of the connected component reachable
      // from rootId (other disconnected sub-graphs and cycle-edges).
      for (const s of prev.snaps) {
        if (!handledSnapIds.has(s.id)) newSnaps.push(s);
      }

      return { ...prev, params: newParams, snaps: newSnaps };
    });
  };

  // Promote a snap axis from a literal/expression to a fresh parameter binding.
  // The new parameter takes the current expression as its initial value.
  const promoteSnapAxis = (snapId, axis) => {
    updateScene(prev => {
      const snap = prev.snaps.find(s => s.id === snapId);
      if (!snap) return prev;
      const currentExpr = snap[axis] ?? '0';
      // If it's already a parameter ref, do nothing
      const trimmed = String(currentExpr).trim();
      if (/^[A-Za-z_][\w]*$/.test(trimmed) && prev.params[trimmed]) return prev;
      // Find a fresh gap_x* / gap_y* name
      const prefix = axis === 'dx' ? 'gap_x' : 'gap_y';
      let i = 1;
      while (prev.params[`${prefix}${i}`]) i++;
      const name = `${prefix}${i}`;
      const newParams = {
        ...prev.params,
        [name]: {
          expr: String(currentExpr),
          unit: 'µm',
          desc: `Gap ${snap.from.compId}.${snap.from.anchor} → ${snap.to.compId}.${snap.to.anchor} (${axis})`,
        },
      };
      const newSnaps = prev.snaps.map(s => s.id === snapId ? { ...s, [axis]: name } : s);
      return { ...prev, params: newParams, snaps: newSnaps };
    });
  };

  // ----- Groups -----
  // Create a group from selected components. Rename their referenced parameters
  // to <groupName>_<param>, and create alias parameters that initially equal the originals.
  const createGroup = async () => {
    if (selectedIds.size === 0) {
      await alertDialog('Select one or more components first.', 'No selection');
      return;
    }
    // Suggest a unique default name
    let i = 1;
    let suggestion = 'group1';
    while (scene.groups.some(g => g.name === suggestion)) { i++; suggestion = `group${i}`; }
    const groupName = await promptDialog('Name for the new group:', suggestion, 'Create group');
    if (!groupName || !groupName.trim()) return;
    const trimmed = groupName.trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) {
      await alertDialog('Group name must be a valid identifier (letters, digits, underscore; starting with letter/underscore).', 'Invalid name');
      return;
    }
    if (scene.groups.some(g => g.name === trimmed)) {
      await alertDialog(`A group named "${trimmed}" already exists.`, 'Duplicate name');
      return;
    }

    const memberIds = new Set(selectedIds);

    updateScene(prev => {
      // Find parameters referenced by:
      //   (a) any member component's w/h or cutouts
      //   (b) any snap whose BOTH endpoints are members (internal snap)
      const referenced = new Set();
      const collect = (expr) => {
        if (typeof expr !== 'string') return;
        for (const id of tokenizeIdents(expr)) {
          if (prev.params[id]) referenced.add(id);
        }
      };
      for (const c of prev.components) {
        if (!memberIds.has(c.id)) continue;
        collect(c.w); collect(c.h);
        for (const cu of (c.cutouts || [])) { collect(cu.dx); collect(cu.dy); collect(cu.w); collect(cu.h); }
      }
      const internalSnaps = prev.snaps.filter(s => memberIds.has(s.from.compId) && memberIds.has(s.to.compId));
      for (const s of internalSnaps) { collect(s.dx); collect(s.dy); }

      // Build alias map: orig → group-scoped
      const aliasMap = {};
      const newParams = { ...prev.params };
      for (const orig of referenced) {
        let aliasName = `${trimmed}_${orig}`;
        let n = 2;
        while (newParams[aliasName]) { aliasName = `${trimmed}_${orig}_${n++}`; }
        aliasMap[orig] = aliasName;
        newParams[aliasName] = {
          expr: orig,
          unit: prev.params[orig].unit,
          desc: `[${trimmed}] alias of ${orig}`,
        };
      }

      const replaceIn = (expr) => {
        if (typeof expr !== 'string') return expr;
        let out = expr;
        // Replace whole-word occurrences of each aliased param. Sort longer-first to avoid partials.
        const keys = Object.keys(aliasMap).sort((a, b) => b.length - a.length);
        for (const k of keys) {
          out = out.replace(new RegExp(`\\b${k}\\b`, 'g'), aliasMap[k]);
        }
        return out;
      };

      // Rewrite member components
      const newComponents = prev.components.map(c => {
        if (!memberIds.has(c.id)) return c;
        return {
          ...c,
          w: replaceIn(c.w),
          h: replaceIn(c.h),
          cutouts: (c.cutouts || []).map(cu => ({
            ...cu,
            dx: replaceIn(cu.dx), dy: replaceIn(cu.dy),
            w: replaceIn(cu.w), h: replaceIn(cu.h),
          })),
          group: trimmed,
        };
      });

      // Rewrite internal snaps
      const internalSnapIds = new Set(internalSnaps.map(s => s.id));
      const newSnaps = prev.snaps.map(s => {
        if (!internalSnapIds.has(s.id)) return s;
        return { ...s, dx: replaceIn(s.dx), dy: replaceIn(s.dy) };
      });

      const newGroup = {
        id: `group_${Date.now().toString(36)}`,
        name: trimmed,
        memberIds: Array.from(memberIds),
        aliases: aliasMap, // record so we can ungroup later
      };

      return {
        ...prev,
        params: newParams,
        components: newComponents,
        snaps: newSnaps,
        groups: [...prev.groups, newGroup],
      };
    });
  };

  // Delete the entire group, including all its member components
  const deleteGroup = async (groupId) => {
    const g = scene.groups.find(x => x.id === groupId);
    if (!g) return;
    const ok = await confirmDialog(
      `Delete group "${g.name}" and all ${g.memberIds.length} of its component${g.memberIds.length === 1 ? '' : 's'}?\n\nGroup-scoped parameters (${Object.keys(g.aliases || {}).length}) will become unused — you can clean them up later in PARAMS.`,
      'Delete group'
    );
    if (!ok) return;
    deleteComp(new Set(g.memberIds));
  };

  // Remove the group metadata but keep the components and their group-scoped params (= "ungroup")
  const dissolveGroup = async (groupId) => {
    const g = scene.groups.find(x => x.id === groupId);
    if (!g) return;
    const ok = await confirmDialog(
      `Ungroup "${g.name}"? Components and their group-scoped parameters are kept; only the grouping is removed.`,
      'Ungroup'
    );
    if (!ok) return;
    updateScene(prev => ({
      ...prev,
      components: prev.components.map(c => g.memberIds.includes(c.id) ? { ...c, group: undefined } : c),
      groups: prev.groups.filter(x => x.id !== groupId),
    }));
  };

  // Resolve "the current group context" for the ungroup shortcut: walk
  // selectedIds, find the first group any selected component belongs
  // to, and return its id. Returns null if nothing selected is grouped.
  const currentGroupId = () => {
    if (selectedIds.size === 0) return null;
    const byId = Object.fromEntries(scene.components.map(c => [c.id, c]));
    for (const cid of selectedIds) {
      const c = byId[cid];
      if (c && c.group) {
        const g = scene.groups.find(g => g.name === c.group);
        if (g) return g.id;
      }
    }
    return null;
  };

  // Late-binding refs for the Cmd+G / Cmd+Shift+G keyboard handler
  // declared above this point in the function body.
  createGroupRef.current = createGroup;
  dissolveGroupRef.current = dissolveGroup;
  currentGroupIdRef.current = currentGroupId;

  const renameGroupParameter = async (groupId, oldName, newName) => {
    if (!newName || newName === oldName) return;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(newName)) return;
    if (scene.params[newName]) {
      await alertDialog('A parameter with that name already exists.', 'Rename failed');
      return;
    }
    renameParam(oldName, newName);
    // Update group alias map
    updateScene(prev => ({
      ...prev,
      groups: prev.groups.map(g => g.id === groupId
        ? { ...g, aliases: Object.fromEntries(Object.entries(g.aliases).map(([k, v]) => [k, v === oldName ? newName : v])) }
        : g),
    }));
  };

  const selectGroup = (groupId) => {
    const g = scene.groups.find(x => x.id === groupId);
    if (!g) return;
    const ids = new Set(g.memberIds.filter(id => scene.components.some(c => c.id === id)));
    setSelection({ ids, primary: ids.size > 0 ? Array.from(ids)[0] : null });
  };

  // Rename a group: updates the group's name, components' `group` field, aliased parameters
  // (e.g., capacitor_cap_gap → newname_cap_gap), and all references to those parameters.
  const renameGroup = async (groupId, newName) => {
    const g = scene.groups.find(x => x.id === groupId);
    if (!g) return;
    if (!newName || newName === g.name) return;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(newName)) {
      await alertDialog('Group name must be a valid identifier (letters, digits, underscore; starting with letter/underscore).', 'Invalid name');
      return;
    }
    if (scene.groups.some(x => x.id !== groupId && x.name === newName)) {
      await alertDialog(`Another group is already named "${newName}".`, 'Duplicate name');
      return;
    }

    const oldName = g.name;
    const oldPrefix = `${oldName}_`;
    const newPrefix = `${newName}_`;

    updateScene(prev => {
      // Build paramMap: for every aliased param starting with `<oldName>_`, rename to `<newName>_<rest>`.
      // Skip if a collision would occur.
      const paramMap = {};
      const newParams = {};
      const collisions = [];
      // First pass: figure out new names
      for (const pname of Object.keys(prev.params)) {
        if (pname.startsWith(oldPrefix)) {
          const rest = pname.slice(oldPrefix.length);
          const newPname = newPrefix + rest;
          if (newPname !== pname && prev.params[newPname]) {
            collisions.push(`${pname} → ${newPname}`);
          }
          paramMap[pname] = newPname;
        } else {
          paramMap[pname] = pname;
        }
      }
      if (collisions.length > 0) {
        // Bail out — caller will surface this. We can't await alertDialog inside an updater.
        // Instead, return prev unchanged and we'll alert below.
        return prev;
      }
      // Build the renamed params object preserving insertion order
      for (const pname of Object.keys(prev.params)) {
        const newPname = paramMap[pname];
        newParams[newPname] = prev.params[pname];
      }

      // Replace identifiers in any expression
      const replaceIn = (expr) => {
        if (typeof expr !== 'string') return expr;
        let out = expr;
        const keys = Object.keys(paramMap).filter(k => paramMap[k] !== k).sort((a, b) => b.length - a.length);
        for (const k of keys) {
          out = out.replace(new RegExp(`\\b${k}\\b`, 'g'), paramMap[k]);
        }
        return out;
      };
      // Apply replaceIn to every param's expr (in case one references another renamed param)
      for (const pname of Object.keys(newParams)) {
        newParams[pname] = { ...newParams[pname], expr: replaceIn(newParams[pname].expr) };
      }

      // Update components: w/h/cutouts and the `group` field
      const newComponents = prev.components.map(c => {
        const updated = {
          ...c,
          w: replaceIn(c.w),
          h: replaceIn(c.h),
          cutouts: (c.cutouts || []).map(cu => ({
            ...cu,
            dx: replaceIn(cu.dx), dy: replaceIn(cu.dy),
            w: replaceIn(cu.w), h: replaceIn(cu.h),
          })),
        };
        if (c.group === oldName) updated.group = newName;
        return updated;
      });

      // Update snaps
      const newSnaps = prev.snaps.map(s => ({
        ...s,
        dx: replaceIn(s.dx),
        dy: replaceIn(s.dy),
      }));

      // Update group descriptor (name + alias map values)
      const newGroups = prev.groups.map(grp => {
        if (grp.id !== groupId) return grp;
        const newAliases = {};
        for (const [orig, oldAlias] of Object.entries(grp.aliases || {})) {
          newAliases[orig] = paramMap[oldAlias] || oldAlias;
        }
        return { ...grp, name: newName, aliases: newAliases };
      });

      return {
        ...prev,
        params: newParams,
        components: newComponents,
        snaps: newSnaps,
        groups: newGroups,
      };
    });

    // Detect collisions by checking if scene was actually modified.
    // (Above updater returns prev unchanged on collision.)
    // Simpler check: see if any colliding new name already exists in current state.
    const wouldCollide = Object.keys(scene.params).some(pname => {
      if (!pname.startsWith(oldPrefix)) return false;
      const rest = pname.slice(oldPrefix.length);
      const target = newPrefix + rest;
      return target !== pname && scene.params[target];
    });
    if (wouldCollide) {
      await alertDialog(
        `Cannot rename "${oldName}" to "${newName}": one or more parameters would collide with existing names. Pick a different group name.`,
        'Rename failed'
      );
    }
  };

  // ----- Library -----
  // Save selected components (or a group) to the library.
  const saveSelectionToLibrary = async () => {
    if (selectedIds.size === 0) {
      await alertDialog('Select components first.', 'No selection');
      return;
    }
    const name = await promptDialog('Name for this library item (also becomes the group name on insert):', '', 'Save to library');
    if (!name || !name.trim()) return;
    const trimmed = name.trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) {
      await alertDialog('Name must be a valid identifier (letters, digits, underscore; starting with letter/underscore).', 'Invalid name');
      return;
    }
    if (libraryItems.includes(trimmed)) {
      const ok = await confirmDialog(`"${trimmed}" already exists. Overwrite?`, 'Overwrite');
      if (!ok) return;
    }

    const memberIds = new Set(selectedIds);
    const componentsRaw = scene.components
      .filter(c => memberIds.has(c.id))
      .map(c => ({ ...c, cutouts: (c.cutouts || []).map(cu => ({ ...cu })) }));
    const snapsRaw = scene.snaps
      .filter(s => memberIds.has(s.from.compId) && memberIds.has(s.to.compId))
      .map(s => ({ ...s }));

    // Collect referenced params (transitively)
    const referenced = new Set();
    const queue = [];
    const enqueue = (expr) => {
      if (typeof expr !== 'string') return;
      for (const id of tokenizeIdents(expr)) {
        if (scene.params[id] && !referenced.has(id)) {
          referenced.add(id); queue.push(id);
        }
      }
    };
    for (const c of componentsRaw) {
      enqueue(c.w); enqueue(c.h);
      for (const cu of (c.cutouts || [])) { enqueue(cu.dx); enqueue(cu.dy); enqueue(cu.w); enqueue(cu.h); }
    }
    for (const s of snapsRaw) { enqueue(s.dx); enqueue(s.dy); }
    while (queue.length) {
      const id = queue.shift();
      enqueue(scene.params[id].expr);
    }

    // Determine the params that should be wrapped (directly referenced by members or internal snaps).
    // Transitively-referenced params (e.g., one used only by another param's expression) stay un-aliased.
    const directlyReferenced = new Set();
    const collectDirect = (expr) => {
      if (typeof expr !== 'string') return;
      for (const id of tokenizeIdents(expr)) {
        if (scene.params[id]) directlyReferenced.add(id);
      }
    };
    for (const c of componentsRaw) {
      collectDirect(c.w); collectDirect(c.h);
      for (const cu of (c.cutouts || [])) { collectDirect(cu.dx); collectDirect(cu.dy); collectDirect(cu.w); collectDirect(cu.h); }
    }
    for (const s of snapsRaw) { collectDirect(s.dx); collectDirect(s.dy); }

    // Build a payload that represents the selection as one group called `trimmed`.
    // Decision: every directly-referenced parameter gets aliased as `<trimmed>_<orig>`.
    // The aliased param's expr in the payload is the ORIGINAL name — so when inserted,
    // the alias param resolves to whatever the original is in the destination scene.
    const aliases = {};
    const alreadyAliased = new Set();
    // If a param is already itself prefixed (e.g., from a previous group), don't double-prefix.
    for (const orig of directlyReferenced) {
      // If the parameter already starts with `<trimmed>_`, keep the name; otherwise alias.
      if (orig.startsWith(trimmed + '_')) {
        alreadyAliased.add(orig);
        aliases[orig] = orig; // no rename, but still part of the group
      } else {
        aliases[orig] = `${trimmed}_${orig}`;
      }
    }

    const replaceIn = (expr) => {
      if (typeof expr !== 'string') return expr;
      let out = expr;
      const keys = Object.keys(aliases).sort((a, b) => b.length - a.length);
      for (const k of keys) {
        if (aliases[k] === k) continue; // no-op replacement
        out = out.replace(new RegExp(`\\b${k}\\b`, 'g'), aliases[k]);
      }
      return out;
    };

    // Build params for the payload:
    //   - aliased ones (named <trimmed>_<orig>), expr = orig (so they reference the original on insert)
    //   - the originals themselves (un-renamed), so the alias chain resolves
    //   - transitively-referenced params (un-aliased, just included so the inserted item works standalone)
    const params = {};
    for (const orig of referenced) {
      params[orig] = { ...scene.params[orig] };
    }
    for (const orig of directlyReferenced) {
      const aliasName = aliases[orig];
      if (aliasName === orig) continue; // already grouped-prefix
      params[aliasName] = {
        expr: orig,
        unit: scene.params[orig].unit,
        desc: `[${trimmed}] alias of ${orig}`,
      };
    }

    // Rewrite components and snaps in the payload to use aliased names
    const components = componentsRaw.map(c => ({
      ...c,
      group: trimmed,
      w: replaceIn(c.w),
      h: replaceIn(c.h),
      cutouts: (c.cutouts || []).map(cu => ({
        ...cu,
        dx: replaceIn(cu.dx), dy: replaceIn(cu.dy),
        w: replaceIn(cu.w), h: replaceIn(cu.h),
      })),
    }));
    const snaps = snapsRaw.map(s => ({ ...s, dx: replaceIn(s.dx), dy: replaceIn(s.dy) }));

    // Build the synthesized group descriptor (its alias map maps orig→aliased)
    const groupDescriptor = {
      id: `group_${Date.now().toString(36)}`,
      name: trimmed,
      memberIds: components.map(c => c.id),
      aliases, // { orig: aliasName } — even when alias equals orig (already prefixed)
    };

    const payload = {
      name: trimmed,
      params,
      components,
      snaps,
      groups: [groupDescriptor],
      createdAt: Date.now(),
    };

    const ok = await saveLibraryItem(workspace, trimmed, payload);
    if (!ok) {
      await alertDialog('Save failed.', 'Error');
      return;
    }
    await refreshLibrary();
  };

  // Insert a built-in template by id. Each template knows how to assemble
  // its own params/components/snaps; we just hand it the current scene and
  // viewport and merge the result.
  const insertBuiltinTemplate = (template) => {
    if (!template || typeof template.insert !== 'function') return;
    updateScene((prev) => template.insert(prev, { viewport }));
  };

  // Drop a library item into the current scene at viewport center
  const insertLibraryItem = async (name) => {
    const item = await loadLibraryItem(workspace, name);
    if (!item) { await alertDialog('Failed to load library item.', 'Error'); return; }

    updateScene((prev) => insertLibraryPayload(prev, { viewport, paramValues }, item));
  };

  // "Save as built-in template": generate a JS module from the library
  // item and trigger a download. The user drops the file under
  // src/templates/ and adds it to BUILTIN_TEMPLATES (the generated file
  // includes step-by-step instructions in its header comment).
  const codifyLibraryItem = async (name) => {
    const item = await loadLibraryItem(workspace, name);
    if (!item) { await alertDialog('Failed to load library item.', 'Error'); return; }
    const { filename, source } = generateTemplateModuleSource({
      payload: item,
      name,
    });
    downloadFile(filename, source, 'application/javascript;charset=utf-8');
    await alertDialog(
      `Downloaded ${filename}.\n\n` +
      `To finish making "${name}" a built-in template:\n` +
      `  1. Move the file into src/templates/.\n` +
      `  2. Edit src/templates/index.js — add\n` +
      `       import myTpl from './${filename}';\n` +
      `     and append \`myTpl\` to BUILTIN_TEMPLATES.\n\n` +
      `It'll appear in the Library panel's "Built-in templates" section after the next reload.`,
      'Codified as template'
    );
  };

  // ----- Library export / import -----
  // Snapshot the active workspace's library (active + archived) as a JSON
  // bundle and trigger a download. Format mirrors the workspace bundle but
  // OMITS designs, so the file is small and obviously a "library kit". The
  // `format` field is distinct from workspace bundles so import detection
  // can distinguish them.
  const handleExportLibrary = async () => {
    const lib = {};
    for (const n of await listLibraryItems(workspace)) {
      const d = await loadLibraryItem(workspace, n);
      if (d) lib[n] = d;
    }
    const archive = {};
    for (const n of await listArchivedLibraryItems(workspace)) {
      const d = await loadArchivedLibraryItem(workspace, n);
      if (d) archive[n] = d;
    }
    const libCount = Object.keys(lib).length;
    const archCount = Object.keys(archive).length;
    if (libCount + archCount === 0) {
      const proceed = await confirmDialog('Library is empty. Download an empty bundle anyway?', 'Empty library');
      if (!proceed) return;
    }
    const bundle = {
      format: 'photonic_layout_library',
      version: 1,
      exportedAt: new Date().toISOString(),
      workspace,
      library: lib,
      libraryArchive: archive,
    };
    const wsLabel = workspace || 'default';
    const filename = `photonic_layout_library_${wsLabel}_${new Date().toISOString().slice(0, 10)}.json`;
    downloadFile(filename, JSON.stringify(bundle, null, 2), 'application/json;charset=utf-8');
  };

  // Import a library bundle JSON into the active workspace's library.
  // Accepts both library bundles AND workspace bundles (in which case we
  // pull only the library/archive sections, ignoring designs). Asks the
  // user whether to merge or replace, then commits.
  const handleImportLibrary = async () => {
    const useFileInput = () => new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'application/json,.json';
      input.onchange = (e) => resolve(e.target.files?.[0] || null);
      input.click();
    });
    let file = null;
    try {
      if ('showOpenFilePicker' in window && !fsBlockedAtRuntime) {
        try {
          const [h] = await window.showOpenFilePicker({
            types: [{
              description: 'PhotonicLayout library or workspace',
              accept: { 'application/json': ['.json'] },
            }],
            multiple: false,
          });
          file = await h.getFile();
        } catch (e) {
          if (e?.name === 'AbortError') return;
          const msg = String(e?.message || '');
          const isSandboxed =
            e?.name === 'SecurityError' ||
            /Cross[- ]origin|sub[- ]?frames?|sandboxed?/i.test(msg);
          if (isSandboxed) {
            setFsBlockedAtRuntime(true);
            file = await useFileInput();
          } else {
            throw e;
          }
        }
      } else {
        file = await useFileInput();
      }
    } catch (e) {
      if (e?.name === 'AbortError') return;
      await alertDialog(`Could not open file: ${e.message}`, 'Import error');
      return;
    }
    if (!file) return;
    let bundle;
    try {
      bundle = JSON.parse(await file.text());
    } catch (err) {
      await alertDialog(`Could not parse file: ${err.message}`, 'Import error');
      return;
    }
    const fmt = bundle?.format;
    if (fmt !== 'photonic_layout_library' && fmt !== 'photonic_layout_workspace') {
      await alertDialog(
        'Not a recognized library or workspace file (expected format = "photonic_layout_library" or "photonic_layout_workspace").',
        'Import error'
      );
      return;
    }
    const lib = bundle.library || {};
    const archive = bundle.libraryArchive || {};
    const libCount = Object.keys(lib).length;
    const archCount = Object.keys(archive).length;
    if (libCount + archCount === 0) {
      await alertDialog('File contains no library items.', 'Nothing to import');
      return;
    }
    const wsLabel = workspace || 'default';
    const sourceNote = fmt === 'photonic_layout_workspace'
      ? '\n\n(Pulling library/archive only; the file\'s designs are ignored.)'
      : '';
    const proceed = await confirmDialog(
      `Import:\n  • ${libCount} library item${libCount === 1 ? '' : 's'}\n  • ${archCount} archived item${archCount === 1 ? '' : 's'}\n\ninto workspace "${wsLabel}"?${sourceNote}`,
      'Import library'
    );
    if (!proceed) return;
    const replace = await confirmDialog(
      `Replace mode: WIPE the existing library in "${wsLabel}" first?\n\n• Yes = replace everything (destructive)\n• No = merge (keep existing names; imported duplicates will be skipped)`,
      'Import mode'
    );
    let counts = { library: 0, archive: 0, skipped: [] };
    try {
      if (replace) {
        for (const n of await listLibraryItems(workspace)) await deleteLibraryItem(workspace, n);
        for (const n of await listArchivedLibraryItems(workspace)) await deleteArchivedLibraryItem(workspace, n);
      }
      const existingLib = new Set(await listLibraryItems(workspace));
      const existingArch = new Set(await listArchivedLibraryItems(workspace));
      for (const [n, payload] of Object.entries(lib)) {
        if (!replace && existingLib.has(n)) { counts.skipped.push(`library:${n}`); continue; }
        if (await saveLibraryItem(workspace, n, payload)) counts.library++;
      }
      for (const [n, payload] of Object.entries(archive)) {
        if (!replace && existingArch.has(n)) { counts.skipped.push(`archive:${n}`); continue; }
        if (await saveArchivedLibraryItem(workspace, n, payload)) counts.archive++;
      }
      await refreshLibrary();
      // Mirror to linked workspace file if any (the library is part of the
      // workspace bundle).
      mirrorWorkspaceToFileIfLinked();
    } catch (err) {
      await alertDialog(`Import failed: ${err.message}`, 'Import error');
      return;
    }
    const skipNote = counts.skipped.length > 0
      ? `\n\nSkipped ${counts.skipped.length} item${counts.skipped.length === 1 ? '' : 's'} due to name collision.`
      : '';
    await alertDialog(
      `Imported:\n  • ${counts.library} library item${counts.library === 1 ? '' : 's'}\n  • ${counts.archive} archived item${counts.archive === 1 ? '' : 's'}${skipNote}`,
      'Import complete'
    );
  };

  // ----- Stack library -----
  // Switch the current scene to a stack loaded from the library. Keeps
  // existing params (the user's tuning isn't reset) but injects any
  // identifiers the new stack references that aren't already defined,
  // matching the makeBlankScene-style behavior. The scene's stackName
  // updates too so the toolbar label reflects the change.
  const switchStack = async (name) => {
    const payload = await loadStack(workspace, name);
    if (!payload || !Array.isArray(payload.stack)) {
      await alertDialog(`Stack "${name}" failed to load.`, 'Error');
      return;
    }
    updateScene((prev) => {
      const seeded = paramsForStack(payload.stack);
      const params = { ...prev.params };
      for (const [pn, pv] of Object.entries(seeded)) if (!params[pn]) params[pn] = pv;
      return { ...prev, stack: payload.stack, stackName: name, params };
    });
  };

  // Rename the currently-loaded stack. Two paths:
  //   - If the current name IS a library entry, atomically write the
  //     contents under the new name then drop the old key — so the
  //     library never sees an in-flight collision and the user's
  //     stack doesn't briefly disappear.
  //   - If the current name ISN'T a library entry (an unsaved draft,
  //     e.g. after editing without yet saving), it's a pure label
  //     change on scene.stackName. Nothing in storage moves.
  // Either way, scene.stackName updates so the dropdown reflects the
  // new label.
  const renameCurrentStack = async () => {
    const oldName = scene.stackName || '';
    const next = await promptDialog('Rename stack to:', oldName, 'Rename stack');
    if (next == null) return;
    const trimmed = String(next).trim();
    if (!trimmed || trimmed === oldName) return;
    if (stackList.includes(trimmed)) {
      const ok = await confirmDialog(
        `A stack named "${trimmed}" already exists in the library. Overwrite it with the current stack?`,
        'Overwrite stack'
      );
      if (!ok) return;
    }
    // Persist under the new name (always — captures the working
    // scene.stack even if the rename comes from a draft).
    const ok = await saveStack(workspace, trimmed, { name: trimmed, stack: scene.stack });
    if (!ok) { await alertDialog('Failed to rename stack.', 'Error'); return; }
    // If the old name was a library entry distinct from the new one,
    // drop it. Skip when oldName === trimmed (handled above) or when
    // oldName wasn't in the library to begin with.
    if (oldName && oldName !== trimmed && stackList.includes(oldName)) {
      await deleteStack(workspace, oldName);
    }
    updateScene((prev) => ({ ...prev, stackName: trimmed }));
    await refreshStackList();
  };

  // Delete a named stack from the library. The currently-loaded
  // scene.stack is unaffected — only the library entry vanishes — so
  // the user doesn't lose their working stack if they delete the wrong
  // entry by mistake.
  const deleteStackEntry = async (name) => {
    const ok = await confirmDialog(`Delete saved stack "${name}" from the library?`, 'Delete stack');
    if (!ok) return;
    await deleteStack(workspace, name);
    await refreshStackList();
  };

  // Create a fresh stack from scratch — pick a name, seed with one
  // conductor layer, save into the library, and switch the scene to
  // it. Cheaper than "save as" + manually deleting all existing layers
  // when the user wants a clean slate.
  const newStack = async () => {
    const name = await promptDialog('Name for the new stack:', 'new_stack', 'New stack');
    if (!name || !name.trim()) return;
    const trimmed = name.trim();
    if (stackList.includes(trimmed)) {
      const ok = await confirmDialog(`"${trimmed}" already exists in the library. Overwrite?`, 'Overwrite stack');
      if (!ok) return;
    }
    const seedStack = [
      { id: `l_cond_${Math.random().toString(36).slice(2, 6)}`, name: 'Conductor', thickness: 'h_cond', material: 'gold', color: '#daa520', role: 'conductor' },
    ];
    const ok = await saveStack(workspace, trimmed, { name: trimmed, stack: seedStack });
    if (!ok) { await alertDialog('Failed to create stack.', 'Error'); return; }
    await refreshStackList();
    await switchStack(trimmed);
  };

  // Download the currently-loaded stack as a JSON file the user can
  // re-import on another machine / share with collaborators. Format
  // mirrors the in-storage shape so the importer is a straight passthrough.
  const exportStackToFile = () => {
    const payload = {
      format: 'photonic_layout_stack',
      version: 1,
      exportedAt: new Date().toISOString(),
      name: scene.stackName || 'stack',
      stack: scene.stack,
    };
    const safe = (scene.stackName || 'stack').replace(/[^A-Za-z0-9_\-]+/g, '_') || 'stack';
    downloadFile(`${safe}.json`, JSON.stringify(payload, null, 2), 'application/json;charset=utf-8');
  };

  // Import a stack from a JSON file picked by the user. Accepts the
  // exported shape above OR a bare stack array (older or hand-rolled
  // files). Save into the library, then switch the scene to it.
  const importStackFromFile = async () => {
    const pickFile = () => new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'application/json,.json';
      input.onchange = (e) => resolve(e.target.files?.[0] || null);
      input.click();
    });
    let file = null;
    try {
      if ('showOpenFilePicker' in window && !fsBlockedAtRuntime) {
        try {
          const [h] = await window.showOpenFilePicker({
            types: [{ description: 'PhotonicLayout stack', accept: { 'application/json': ['.json'] } }],
            multiple: false,
          });
          file = await h.getFile();
        } catch (e) {
          if (e?.name === 'AbortError') return;
          // Cross-origin / sandboxed iframe: fall back to file input.
          file = await pickFile();
        }
      } else {
        file = await pickFile();
      }
      if (!file) return;
      const text = await file.text();
      let parsed;
      try { parsed = JSON.parse(text); }
      catch (e) { await alertDialog(`File is not valid JSON: ${e.message}`, 'Import failed'); return; }
      // Normalize: { format, name, stack } or bare [layers].
      const rawStack = Array.isArray(parsed) ? parsed : parsed?.stack;
      const rawName = Array.isArray(parsed) ? (file.name.replace(/\.json$/i, '') || 'imported_stack') : (parsed?.name || file.name.replace(/\.json$/i, '') || 'imported_stack');
      if (!Array.isArray(rawStack) || rawStack.length === 0) {
        await alertDialog('No stack layers found in the file.', 'Import failed');
        return;
      }
      // Disambiguate name if it already exists in the library.
      let finalName = rawName;
      if (stackList.includes(finalName)) {
        const ok = await confirmDialog(
          `A stack named "${finalName}" already exists. Overwrite, or cancel to skip?`,
          'Overwrite stack'
        );
        if (!ok) {
          // Auto-disambiguate with a numeric suffix
          let i = 2;
          while (stackList.includes(`${rawName}_${i}`)) i++;
          finalName = `${rawName}_${i}`;
        }
      }
      const ok = await saveStack(workspace, finalName, { name: finalName, stack: rawStack });
      if (!ok) { await alertDialog('Failed to save imported stack.', 'Error'); return; }
      await refreshStackList();
      await switchStack(finalName);
    } catch (e) {
      await alertDialog(`Import failed: ${e.message}`, 'Error');
    }
  };

  // Archive a library item: move it from the active prefix to the archive prefix.
  const archiveLibraryEntry = async (name) => {
    const item = await loadLibraryItem(workspace, name);
    if (!item) { await alertDialog('Failed to load library item.', 'Error'); return; }
    // Pick a unique archive name in case of collision
    let archiveName = name;
    let i = 2;
    while (archivedLibraryItems.includes(archiveName)) { archiveName = `${name}_${i++}`; }
    const ok = await saveArchivedLibraryItem(workspace, archiveName, { ...item, archivedAt: Date.now(), originalName: name });
    if (!ok) { await alertDialog('Archive failed.', 'Error'); return; }
    await deleteLibraryItem(workspace, name);
    await refreshLibrary();
  };

  // Rename a library item. Updates the storage key, the payload's name field,
  // the synthetic group's name, alias prefixes, and any references to those aliases
  // in params/components/snaps. Identifier-aware: only renames `oldname_*` tokens.
  const renameLibraryEntry = async (oldName, newName) => {
    const trimmed = (newName || '').trim();
    if (!trimmed || trimmed === oldName) return;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) {
      await alertDialog('Library name must start with a letter or underscore and contain only letters, digits, and underscores.', 'Invalid name');
      return;
    }
    if (libraryItems.includes(trimmed)) {
      await alertDialog(`A library item named "${trimmed}" already exists.`, 'Name in use');
      return;
    }
    const item = await loadLibraryItem(workspace, oldName);
    if (!item) { await alertDialog('Failed to load library item.', 'Error'); return; }

    // Substitute "oldName_" with "newName_" anywhere it appears as a leading identifier.
    const re = new RegExp(`\\b${oldName.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}_`, 'g');
    const subStr = (s) => (typeof s === 'string' ? s.replace(re, `${trimmed}_`) : s);
    const subKey = (k) => subStr(k);

    // Rebuild params with updated keys (and updated descriptions if they reference the old name)
    const newParams = {};
    for (const [k, p] of Object.entries(item.params || {})) {
      newParams[subKey(k)] = {
        expr: subStr(p.expr),
        unit: p.unit,
        desc: typeof p.desc === 'string' ? p.desc.replace(new RegExp(`\\[${oldName}\\]`, 'g'), `[${trimmed}]`).replace(re, `${trimmed}_`) : p.desc,
      };
    }
    // Rebuild components: rewrite expression fields, plus the `group` field
    const newComponents = (item.components || []).map(c => ({
      ...c,
      group: c.group === oldName ? trimmed : c.group,
      w: subStr(c.w),
      h: subStr(c.h),
      cutouts: (c.cutouts || []).map(cu => ({
        ...cu, dx: subStr(cu.dx), dy: subStr(cu.dy), w: subStr(cu.w), h: subStr(cu.h),
      })),
    }));
    // Rebuild snaps
    const newSnaps = (item.snaps || []).map(s => ({ ...s, dx: subStr(s.dx), dy: subStr(s.dy) }));
    // Rebuild groups: rename the synthetic group, update its aliases values
    const newGroups = (item.groups || []).map(g => {
      const newAliases = {};
      for (const [orig, alias] of Object.entries(g.aliases || {})) newAliases[orig] = subStr(alias);
      return {
        ...g,
        name: g.name === oldName ? trimmed : g.name,
        aliases: newAliases,
      };
    });

    const newPayload = {
      ...item,
      name: trimmed,
      params: newParams,
      components: newComponents,
      snaps: newSnaps,
      groups: newGroups,
    };

    const ok = await saveLibraryItem(workspace, trimmed, newPayload);
    if (!ok) { await alertDialog('Rename failed.', 'Error'); return; }
    await deleteLibraryItem(workspace, oldName);
    await refreshLibrary();
  };

  // Restore an archived item back to the active library.
  const restoreLibraryEntry = async (name) => {
    const item = await loadArchivedLibraryItem(workspace, name);
    if (!item) { await alertDialog('Failed to load archived item.', 'Error'); return; }
    // If a name collision exists in the active library, pick a unique one
    let restoreName = item.originalName || name;
    let i = 2;
    while (libraryItems.includes(restoreName)) { restoreName = `${item.originalName || name}_${i++}`; }
    const cleaned = { ...item };
    delete cleaned.archivedAt;
    delete cleaned.originalName;
    const ok = await saveLibraryItem(workspace, restoreName, cleaned);
    if (!ok) { await alertDialog('Restore failed.', 'Error'); return; }
    await deleteArchivedLibraryItem(workspace, name);
    await refreshLibrary();
  };

  // Permanently delete an archived item.
  const deleteArchivedEntry = async (name) => {
    const ok = await confirmDialog(
      `Permanently delete archived item "${name}"?\n\nThis cannot be undone.`,
      'Delete forever'
    );
    if (!ok) return;
    await deleteArchivedLibraryItem(workspace, name);
    await refreshLibrary();
  };

  // ----- Workspace ↔ file linking -----
  // Snapshot the active workspace as a JSON Blob and trigger a browser
  // download. Used as a fallback when File System Access linking isn't
  // available (Safari/Firefox, or when the page is in a sandboxed iframe).
  const handleDownloadWorkspaceSnapshot = async () => {
    let bundle;
    try {
      bundle = await exportWorkspace(workspace);
    } catch (e) {
      await alertDialog(`Snapshot failed: ${e.message}`, 'Error');
      return;
    }
    const designCount = Object.keys(bundle.designs || {}).length;
    const libCount = Object.keys(bundle.library || {}).length;
    const archCount = Object.keys(bundle.libraryArchive || {}).length;
    if (designCount + libCount + archCount === 0) {
      const proceed = await confirmDialog('This workspace is empty. Download an empty bundle anyway?', 'Empty workspace');
      if (!proceed) return;
    }
    const json = JSON.stringify(bundle, null, 2);
    const wsLabel = workspace || 'default';
    const filename = `photonic_layout_${wsLabel}_${new Date().toISOString().slice(0, 10)}.json`;
    downloadFile(filename, json, 'application/json;charset=utf-8');
  };

  // Link the active workspace to a NEW file on disk via showSaveFilePicker
  // (creates or overwrites). After linking, every save mirrors the workspace
  // bundle to that file. We also write the file immediately so the on-disk
  // state matches the in-browser state right away.
  const handleLinkWorkspaceToFile = async () => {
    if (!fsAccessAPIPresent) {
      await alertDialog(
        'Your browser does not support direct file linking (the File System Access API).\n\nUse Chrome or Edge to enable this feature. You can still use "Download workspace" below to snapshot to a JSON file manually, and re-import via "Import workspace from file…".',
        'Not supported'
      );
      return;
    }
    let handle;
    try {
      const wsLabel = workspace || 'default';
      handle = await window.showSaveFilePicker({
        suggestedName: `photonic_layout_${wsLabel}.json`,
        types: [{
          description: 'PhotonicLayout workspace',
          accept: { 'application/json': ['.json'] },
        }],
      });
    } catch (e) {
      // User cancelled — silently abort
      if (e?.name === 'AbortError') return;
      // Cross-origin sandboxed iframe restriction: the picker is permanently
      // unavailable in this hosting context. Mark fsBlockedAtRuntime so the
      // UI hides the "Link to file…" option and surfaces "Download workspace"
      // as the recommended path. Browsers throw a SecurityError or a
      // TypeError with this message — match on the message text since the
      // error class isn't standardized.
      const msg = String(e?.message || '');
      const isSandboxed =
        e?.name === 'SecurityError' ||
        /Cross[- ]origin|sub[- ]?frames?|sandboxed?/i.test(msg);
      if (isSandboxed) {
        setFsBlockedAtRuntime(true);
        const offer = await confirmDialog(
          'Direct file linking is blocked in this browsing context (likely a sandboxed iframe). Use "Download workspace" instead to snapshot to a JSON file you can re-import later.\n\nDownload now?',
          'Linking unavailable here'
        );
        if (offer) await handleDownloadWorkspaceSnapshot();
        return;
      }
      await alertDialog(`Could not open file picker: ${msg}`, 'Error');
      return;
    }
    // Persist the handle in IndexedDB (so it survives reloads) and update
    // the React state for the current session.
    await persistWorkspaceHandle(workspace, handle);
    setWorkspaceHandle(handle);
    setWorkspaceFileLabel(handle.name || '');
    try {
      const bundle = await exportWorkspace(workspace);
      const ok = await writeBundleToHandle(handle, bundle);
      if (!ok) {
        await alertDialog('Linked the file, but the initial write failed. Permission may have been denied.', 'Warning');
      }
    } catch (e) {
      await alertDialog(`Initial sync failed: ${e.message}`, 'Warning');
    }
  };

  // Unlink the workspace from its current file. The file on disk is left
  // untouched; we just stop mirroring to it.
  const handleUnlinkWorkspaceFile = async () => {
    if (!workspaceHandle) return;
    const ok = await confirmDialog(
      `Unlink workspace "${workspace || 'default'}" from "${workspaceFileLabel || 'file'}"? The file on disk is kept; future saves will no longer mirror to it.`,
      'Unlink workspace file'
    );
    if (!ok) return;
    await persistWorkspaceHandle(workspace, null);
    setWorkspaceHandle(null);
    setWorkspaceFileLabel('');
  };

  // Import a workspace from a JSON file. Tries showOpenFilePicker first (so
  // the chosen file becomes a candidate for linking after import), with a
  // hidden <input type="file"> fallback for Safari/Firefox AND for sandboxed
  // iframe contexts where the picker fails at runtime.
  const handleImportWorkspaceFromFile = async () => {
    let file = null;
    let pickedHandle = null;
    const useFileInput = () => new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'application/json,.json';
      input.onchange = (e) => resolve(e.target.files?.[0] || null);
      input.click();
    });
    try {
      if ('showOpenFilePicker' in window && !fsBlockedAtRuntime) {
        try {
          const [h] = await window.showOpenFilePicker({
            types: [{
              description: 'PhotonicLayout workspace',
              accept: { 'application/json': ['.json'] },
            }],
            multiple: false,
          });
          pickedHandle = h;
          file = await h.getFile();
        } catch (e) {
          if (e?.name === 'AbortError') return;
          // Sandbox restriction: same SecurityError pattern as the save
          // picker. Mark blocked and retry with the <input> fallback.
          const msg = String(e?.message || '');
          const isSandboxed =
            e?.name === 'SecurityError' ||
            /Cross[- ]origin|sub[- ]?frames?|sandboxed?/i.test(msg);
          if (isSandboxed) {
            setFsBlockedAtRuntime(true);
            file = await useFileInput();
          } else {
            throw e;
          }
        }
      } else {
        file = await useFileInput();
      }
    } catch (e) {
      if (e?.name === 'AbortError') return;
      await alertDialog(`Could not open file: ${e.message}`, 'Import error');
      return;
    }
    if (!file) return;
    let bundle;
    try {
      const text = await file.text();
      bundle = JSON.parse(text);
    } catch (err) {
      await alertDialog(`Could not parse file: ${err.message}`, 'Import error');
      return;
    }
    if (!bundle || bundle.format !== 'photonic_layout_workspace') {
      await alertDialog('Not a PhotonicLayout workspace file (missing or wrong "format" field).', 'Import error');
      return;
    }
    const designCount = Object.keys(bundle.designs || {}).length;
    const libCount = Object.keys(bundle.library || {}).length;
    const archCount = Object.keys(bundle.libraryArchive || {}).length;
    const wsLabel = workspace || 'default';
    const proceed = await confirmDialog(
      `Import:\n  • ${designCount} design${designCount === 1 ? '' : 's'}\n  • ${libCount} library item${libCount === 1 ? '' : 's'}\n  • ${archCount} archived item${archCount === 1 ? '' : 's'}\n\ninto workspace "${wsLabel}"?`,
      'Import workspace'
    );
    if (!proceed) return;
    const replace = await confirmDialog(
      `Replace mode: WIPE existing data in "${wsLabel}" first?\n\n• Yes = replace everything (destructive)\n• No = merge (keep existing names; imported duplicates will be skipped)`,
      'Import mode'
    );
    try {
      const counts = await importWorkspace(workspace, bundle, replace ? 'replace' : 'merge');
      await refreshSavedList();
      await refreshLibrary();
      // If File System Access gave us a handle, offer to link the workspace
      // to that same file going forward. This makes round-tripping seamless.
      if (pickedHandle && fsLinkAvailable) {
        const linkIt = await confirmDialog(
          `Link workspace "${wsLabel}" to "${file.name}" so future saves auto-mirror to it?`,
          'Link to imported file'
        );
        if (linkIt) {
          await persistWorkspaceHandle(workspace, pickedHandle);
          setWorkspaceHandle(pickedHandle);
          setWorkspaceFileLabel(pickedHandle.name || file.name || '');
          // Push current bundle to the file so it reflects the merged state.
          mirrorWorkspaceToFileIfLinked();
        }
      }
      const skipNote = counts.skipped.length > 0 ? `\n\nSkipped ${counts.skipped.length} item${counts.skipped.length === 1 ? '' : 's'} due to name collision.` : '';
      await alertDialog(
        `Imported:\n  • ${counts.designs} design${counts.designs === 1 ? '' : 's'}\n  • ${counts.library} library item${counts.library === 1 ? '' : 's'}\n  • ${counts.archive} archived item${counts.archive === 1 ? '' : 's'}${skipNote}`,
        'Import complete'
      );
    } catch (err) {
      await alertDialog(`Import failed: ${err.message}`, 'Import error');
    }
  };



  // Switch to a different workspace ("folder"). The empty string means the default folder.
  // The workspace useEffect re-triggers loading of the saved-list and active design.
  const handleChangeWorkspace = async (newWs) => {
    const trimmed = (newWs || '').trim();
    // Validation: workspace name must not contain colons (used as the prefix separator)
    if (trimmed.includes(':')) {
      await alertDialog('Workspace name cannot contain ":".', 'Invalid name');
      return;
    }
    if (saveStatus === 'unsaved') {
      const ok = await confirmDialog(`Discard unsaved changes and switch workspace?`, 'Switch workspace');
      if (!ok) return;
    }
    if (trimmed === workspace) return;
    setWorkspace(trimmed);
    await setStoredWorkspace(trimmed);
    setShowWorkspaceDialog(false);
  };

  const [newParamFocus, setNewParamFocus] = useState(null);
  const addParam = () => {
    let i = 1;
    while (scene.params[`p${i}`]) i++;
    const name = `p${i}`;
    // Prepend the new param so it appears at the top of the list (visible immediately)
    updateScene(prev => ({
      ...prev,
      params: { [name]: { expr: '1', unit: 'µm', desc: '' }, ...prev.params }
    }));
    setNewParamFocus(name);
  };

  // Compute which parameters are unused (no expression anywhere references them)
  // Set of parameter names involved in the SELECTED component's definition,
  // computed as the transitive closure of identifiers reachable from its
  // w/h, its cutouts, and the snaps that position it (incoming snaps' dx/dy,
  // plus the chain through the parent — recursing through that parent's w/h
  // and incoming snaps too). Used to highlight parameters in the params list
  // so the user can see at a glance which knobs control the current selection.
  // Returns empty set when nothing is selected.
  const paramsInvolvedInSelection = useMemo(() => {
    const result = new Set();
    if (!selectedId) return result;
    const params = scene.params;
    const compsById = Object.fromEntries(scene.components.map(c => [c.id, c]));
    const incomingSnap = (compId) => scene.snaps.find(s => s.to.compId === compId);
    // Frontier of identifiers we still need to expand. Start with everything
    // referenced by the selected component and the snap chain that places it.
    const frontier = [];
    const seenComps = new Set(); // components whose chain we've already walked
    const walkComp = (compId) => {
      if (seenComps.has(compId)) return;
      seenComps.add(compId);
      const c = compsById[compId];
      if (!c) return;
      if (c.kind === 'boolean') {
        // Booleans are derived: their stored w/h are literal '0' (the
        // real geometry comes from the operands). Recurse into each
        // operand so its geometry expressions — and the parents along
        // its own snap chain — surface in the highlight when the
        // boolean is selected.
        for (const opId of (c.operandIds || [])) walkComp(opId);
      }
      // Geometry + cutout + transform-chain idents. Centralized so the
      // unused-param scanner and the highlight walker stay in sync.
      // For booleans, this picks up their own transforms (dx/dy on a
      // grouped repeat, etc.); the boolean's w/h are literal '0' so
      // they contribute nothing.
      for (const id of tokenizeComponentExprs(c)) frontier.push(id);
      // Snap that positions this component (if any) brings in its dx/dy
      // and recursively the parent component's chain. Applies to both
      // primitives and booleans — a boolean can be snapped to another
      // component just like a primitive can.
      const snap = incomingSnap(compId);
      if (snap) {
        for (const expr of [snap.dx, snap.dy]) {
          if (typeof expr !== 'string') continue;
          for (const id of tokenizeIdents(expr)) frontier.push(id);
        }
        walkComp(snap.from.compId);
      }
    };
    walkComp(selectedId);
    // Now expand the frontier: each identifier that names a parameter pulls in
    // that parameter's own expression idents, AND special _comp_<id>_(cx|cy|w|h)
    // synthetics pull in the referenced component's full chain (so span-rect
    // dimensions surface ALL the parents' parameters too).
    while (frontier.length) {
      const id = frontier.pop();
      // Synthetic: pull in the referenced component's chain.
      const syn = id.match(/^_comp_(.+)_(cx|cy|w|h)$/);
      if (syn) { walkComp(syn[1]); continue; }
      if (!(id in params)) continue;
      if (result.has(id)) continue;
      result.add(id);
      // Walk the parameter's own expression for further idents
      const expr = params[id]?.expr;
      if (typeof expr !== 'string') continue;
      for (const childId of tokenizeIdents(expr)) {
        if (childId === id) continue;
        if (!result.has(childId)) frontier.push(childId);
      }
    }
    return result;
  }, [selectedId, scene.params, scene.components, scene.snaps]);

  const unusedParams = useMemo(() => {
    const referenced = new Set();
    const collect = (expr) => {
      if (typeof expr !== 'string') return;
      for (const id of tokenizeIdents(expr)) referenced.add(id);
    };
    // From other parameter expressions
    for (const [name, p] of Object.entries(scene.params)) {
      const idents = tokenizeIdents(p.expr || '');
      for (const id of idents) if (id !== name) referenced.add(id);
    }
    // From components — geometry + cutouts + transforms + per-kind
    // fields, via the shared tokenizeComponentExprs helper.
    for (const c of scene.components) {
      for (const id of tokenizeComponentExprs(c)) referenced.add(id);
    }
    // From snaps
    for (const s of scene.snaps) { collect(s.dx); collect(s.dy); }
    // From layer stack: thickness + waveguide-specific cross-section fields
    for (const layer of (scene.stack || [])) {
      collect(layer.thickness);
      collect(layer.core_width);
      collect(layer.slab_height);
      collect(layer.slab_width);
      collect(layer.etch_angle);
    }
    // Unused = defined but not referenced anywhere
    return Object.keys(scene.params).filter(name => !referenced.has(name));
  }, [scene.params, scene.components, scene.snaps, scene.stack]);

  const cleanupUnusedParams = async () => {
    if (unusedParams.length === 0) return;
    const ok = await confirmDialog(
      `Delete ${unusedParams.length} unused parameter${unusedParams.length === 1 ? '' : 's'}?\n\n${unusedParams.join(', ')}`,
      'Cleanup parameters'
    );
    if (!ok) return;
    updateScene(prev => {
      const np = { ...prev.params };
      for (const name of unusedParams) delete np[name];
      return { ...prev, params: np };
    });
  };

  // Inspect the scene for snap-related problems and produce a human-readable report.
  // Categories:
  //   - orphan: snap references a component id that no longer exists
  //   - duplicate_to: more than one snap targets the same `to.compId` — only one wins,
  //     the others silently do nothing (this is the bug behind "snap doesn't lock")
  //   - cycle: snap chain forms a loop, breaking the topological solver
  //   - nan_offset: snap dx or dy evaluates to NaN (broken expression)
  //   - bad_anchor_size: anchor references a component whose w/h evaluates to NaN/0
  const validateScene = (s, paramVals) => {
    const issues = [];
    const compIds = new Set(s.components.map(c => c.id));
    // Orphans
    for (const snap of s.snaps) {
      if (!compIds.has(snap.from.compId)) {
        issues.push({ kind: 'orphan', snapId: snap.id, side: 'from', missing: snap.from.compId, msg: `Snap "${snap.id}" references missing component "${snap.from.compId}" (from)` });
      }
      if (!compIds.has(snap.to.compId)) {
        issues.push({ kind: 'orphan', snapId: snap.id, side: 'to', missing: snap.to.compId, msg: `Snap "${snap.id}" references missing component "${snap.to.compId}" (to)` });
      }
    }
    // Duplicate `to`: more than one snap places the same component. With the
    // current model each component should be the `to` of exactly one snap (new
    // snaps auto-reverse if they would create a duplicate). If we still find
    // duplicates, the scene is from before the auto-reverse fix or was edited
    // manually — flag for cleanup.
    const toCounts = new Map();
    for (const snap of s.snaps) {
      if (!compIds.has(snap.to.compId)) continue;
      if (!toCounts.has(snap.to.compId)) toCounts.set(snap.to.compId, []);
      toCounts.get(snap.to.compId).push(snap);
    }
    for (const [compId, group] of toCounts.entries()) {
      if (group.length > 1) {
        const ids = group.map(sn => sn.id).join(', ');
        issues.push({
          kind: 'duplicate_to',
          compId,
          snapIds: group.map(sn => sn.id),
          msg: `Component "${compId}" is the target of ${group.length} snaps (${ids}). Only one will position it; the others are silent. Reverse the redundant snaps so they push other components instead, or delete them.`,
        });
      }
    }
    // Cycles via topological walk
    const inDeg = new Map();
    const next = new Map();
    for (const c of s.components) { inDeg.set(c.id, 0); next.set(c.id, []); }
    for (const snap of s.snaps) {
      if (!compIds.has(snap.from.compId) || !compIds.has(snap.to.compId)) continue;
      inDeg.set(snap.to.compId, (inDeg.get(snap.to.compId) || 0) + 1);
      next.get(snap.from.compId).push(snap.to.compId);
    }
    const queue = [];
    for (const [id, d] of inDeg.entries()) if (d === 0) queue.push(id);
    let visited = 0;
    while (queue.length > 0) {
      const id = queue.shift();
      visited++;
      for (const tgt of (next.get(id) || [])) {
        const nd = inDeg.get(tgt) - 1;
        inDeg.set(tgt, nd);
        if (nd === 0) queue.push(tgt);
      }
    }
    if (visited < s.components.length) {
      const cyc = [...inDeg.entries()].filter(([, d]) => d > 0).map(([id]) => id);
      issues.push({ kind: 'cycle', compIds: cyc, msg: `Snap chain forms a cycle through: ${cyc.join(', ')}` });
    }
    // NaN offsets
    for (const snap of s.snaps) {
      const dx = evalExpr(snap.dx, paramVals);
      const dy = evalExpr(snap.dy, paramVals);
      if (!Number.isFinite(dx) || !Number.isFinite(dy)) {
        issues.push({ kind: 'nan_offset', snapId: snap.id, msg: `Snap "${snap.id}" has invalid dx="${snap.dx}" or dy="${snap.dy}" (evaluates to NaN)` });
      }
    }
    return issues;
  };

  const diagnoseScene = async () => {
    const issues = validateScene(scene, paramValues);
    if (issues.length === 0) {
      await alertDialog('No issues found. Your scene looks healthy.', 'Diagnose scene');
      return;
    }
    const grouped = {};
    for (const it of issues) { (grouped[it.kind] = grouped[it.kind] || []).push(it); }
    const lines = [];
    if (grouped.duplicate_to) {
      lines.push(`⚠ ${grouped.duplicate_to.length} component(s) targeted by multiple snaps — only one will position each, the others are silent. New snaps now auto-reverse to avoid this; older scenes may need cleanup. Auto-fix can keep the most recent snap and reverse the rest so they push outward through the chain instead:`);
      for (const it of grouped.duplicate_to) lines.push(`    • ${it.msg}`);
      lines.push('');
    }
    if (grouped.orphan) {
      lines.push(`⚠ ${grouped.orphan.length} snap(s) reference deleted components:`);
      for (const it of grouped.orphan) lines.push(`    • ${it.msg}`);
      lines.push('');
    }
    if (grouped.cycle) {
      lines.push(`⚠ Snap chain has cycles:`);
      for (const it of grouped.cycle) lines.push(`    • ${it.msg}`);
      lines.push('');
    }
    if (grouped.nan_offset) {
      lines.push(`⚠ ${grouped.nan_offset.length} snap(s) with broken dx/dy expressions:`);
      for (const it of grouped.nan_offset) lines.push(`    • ${it.msg}`);
      lines.push('');
    }
    const fixable = (grouped.orphan?.length || 0) + (grouped.duplicate_to?.length || 0);
    if (fixable > 0) {
      lines.push('');
      lines.push(`Auto-fix is available: removes orphaned snaps and reverses redundant duplicate-target snaps so they propagate outward through the chain instead of being silent.`);
      const ok = await confirmDialog(lines.join('\n') + '\n\nApply auto-fix now?', 'Diagnose scene');
      if (ok) autoFixSnaps();
    } else {
      await alertDialog(lines.join('\n'), 'Diagnose scene');
    }
  };

  const autoFixSnaps = () => {
    updateScene(prev => {
      const compIds = new Set(prev.components.map(c => c.id));
      // 1) Drop orphans (snaps referencing deleted components).
      let snaps = prev.snaps.filter(s => compIds.has(s.from.compId) && compIds.has(s.to.compId));
      // 2) Resolve duplicate-`to` collisions by reversing later snaps where
      //    possible. Iterate in array order. Each `to.compId` can only be
      //    claimed once. Subsequent snaps targeting a claimed `to`: if their
      //    `from` isn't itself claimed as a `to`, reverse so the `from` becomes
      //    the moved one. Otherwise drop the snap (truly redundant).
      const claimed = new Set();
      const newParams = { ...prev.params };
      const fixed = [];
      const paramRefCount = (paramName) => {
        // count references to a param across components and snaps; >1 means
        // shared, 1 (just this snap) means we can flip its sign in place.
        let n = 0;
        for (const sn of snaps) { if (sn.dx === paramName) n++; if (sn.dy === paramName) n++; }
        for (const c of prev.components) {
          for (const f of ['w', 'h']) if (c[f] === paramName) n++;
          for (const cu of (c.cutouts || [])) {
            for (const f of ['dx', 'dy', 'w', 'h']) if (cu[f] === paramName) n++;
          }
        }
        for (const [, p] of Object.entries(prev.params)) {
          if (typeof p.expr === 'string' && tokenizeIdents(p.expr).includes(paramName)) n++;
        }
        return n;
      };
      for (const s of snaps) {
        if (!claimed.has(s.to.compId)) {
          claimed.add(s.to.compId);
          fixed.push(s);
          continue;
        }
        // `to` already claimed; can we reverse?
        if (!claimed.has(s.from.compId)) {
          // Reverse direction. To negate offsets: if dx/dy are unique parameter
          // names, mutate the param expression in place; otherwise wrap with -().
          const negateOffset = (offsetExpr) => {
            if (typeof offsetExpr !== 'string') return offsetExpr;
            const stripped = offsetExpr.trim();
            // If it's a sole identifier referring to a parameter that exists,
            // and that parameter is referenced ONLY by this snap, flip its expr.
            if (/^[A-Za-z_][\w]*$/.test(stripped) && newParams[stripped]) {
              const refs = paramRefCount(stripped);
              if (refs <= 2) {
                // Edit the param's expr to be its negation.
                const old = newParams[stripped].expr;
                const newExpr = `-(${old})`;
                newParams[stripped] = { ...newParams[stripped], expr: newExpr };
                return stripped; // keep the same name; expr now negated
              }
            }
            // Fallback: wrap inline
            return `-(${offsetExpr})`;
          };
          fixed.push({
            ...s,
            from: { compId: s.to.compId, anchor: s.to.anchor },
            to: { compId: s.from.compId, anchor: s.from.anchor },
            dx: negateOffset(s.dx),
            dy: negateOffset(s.dy),
          });
          claimed.add(s.from.compId);
        } else {
          // Both ends already claimed. Drop the snap.
        }
      }
      return { ...prev, snaps: fixed, params: newParams };
    });
  };

  // Live count of scene issues (orphan/duplicate-to/cycle/NaN snaps); badges the Diagnose button.
  const sceneIssues = useMemo(() => {
    try { return validateScene(scene, paramValues); }
    catch { return []; }
  }, [scene, paramValues]);

  const updateParam = (name, patch) => {
    updateScene(prev => ({
      ...prev,
      params: { ...prev.params, [name]: { ...prev.params[name], ...patch } },
    }));
  };

  // Compute a params patch to auto-create any identifiers in `expr` that aren't
  // already parameters. Returns { ...newParams } that can be merged into params.
  // `defaultValue` is the literal expression to assign (string), `defaultUnit` the unit string.
  const autoCreateMissingParams = (existingParams, expr, defaultValue = '0', defaultUnit = 'µm', descPrefix = 'Auto-created') => {
    if (typeof expr !== 'string') return null;
    const idents = tokenizeIdents(expr);
    const created = {};
    for (const id of idents) {
      if (RESERVED_IDENTS.has(id)) continue;
      if (existingParams[id]) continue;
      if (created[id]) continue;
      // Skip if it looks like a number (shouldn't happen since tokenizer requires letter/_, but be safe)
      if (/^\d/.test(id)) continue;
      created[id] = {
        expr: defaultValue,
        unit: defaultUnit,
        desc: `${descPrefix} (used in expression)`,
      };
    }
    return Object.keys(created).length > 0 ? created : null;
  };

  // commitExpr: invoked when an expression-bearing input is committed (blur or Enter).
  // Walks the expression for identifiers, creates any missing params with sensible
  // defaults, and merges them into scene.params. Pure no-op if expr has no missing idents.
  // Pass `excludeName` to avoid auto-creating the param being edited (used when editing
  // a parameter's own expression — the param itself shouldn't be auto-created).
  const commitExpr = (expr, defaultValue = '0', defaultUnit = 'µm', descPrefix = 'Auto-created', excludeName = null) => {
    if (typeof expr !== 'string' || expr.length === 0) return;
    updateScene(prev => {
      const created = autoCreateMissingParams(prev.params, expr, defaultValue, defaultUnit, descPrefix);
      if (!created) return prev;
      if (excludeName && created[excludeName]) delete created[excludeName];
      if (Object.keys(created).length === 0) return prev;
      return { ...prev, params: { ...prev.params, ...created } };
    });
  };

  const renameParam = (oldName, newName) => {
    if (!newName || oldName === newName || scene.params[newName]) return;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(newName)) return;
    updateScene(prev => {
      const newParams = {};
      for (const [k, v] of Object.entries(prev.params)) newParams[k === oldName ? newName : k] = v;
      const repl = (e) => typeof e === 'string' ? e.replace(new RegExp(`\\b${oldName}\\b`, 'g'), newName) : e;
      // Replace inside other params' expressions too
      for (const k of Object.keys(newParams)) newParams[k] = { ...newParams[k], expr: repl(newParams[k].expr) };
      const newComps = prev.components.map(c => ({ ...c, w: repl(c.w), h: repl(c.h) }));
      const newSnaps = prev.snaps.map(s => ({ ...s, dx: repl(s.dx), dy: repl(s.dy) }));
      return { ...prev, params: newParams, components: newComps, snaps: newSnaps };
    });
  };

  const deleteParam = async (name) => {
    // Don't allow deletion if the parameter is referenced by ANY layer field in the stack
    const STACK_EXPR_FIELDS = ['thickness', 'core_width', 'slab_height', 'slab_width', 'etch_angle'];
    const findUsingLayer = () => {
      for (const l of (scene.stack || [])) {
        for (const f of STACK_EXPR_FIELDS) {
          const v = l[f];
          if (typeof v === 'string' && tokenizeIdents(v).includes(name)) {
            return { layer: l, field: f };
          }
        }
      }
      return null;
    };
    const usage = findUsingLayer();
    if (usage) {
      await alertDialog(
        `Can't delete "${name}" — it's used by the "${usage.layer.name}" layer (${usage.field}) in the stack. Edit or remove that layer first (LAYERS tab).`,
        'Parameter in use'
      );
      return;
    }
    updateScene(prev => {
      const np = { ...prev.params };
      delete np[name];
      return { ...prev, params: np };
    });
  };

  const createMirror = (axis) => {
    if (!selected) return;
    const mirrorId = `${selected.id}_mir`;
    let mid = mirrorId; let sfx = 0;
    while (scene.components.some(c => c.id === mid)) { sfx++; mid = `${mirrorId}_${sfx}`; }
    const mirrorComp = {
      ...selected, id: mid,
      cx: axis === 'vertical' ? -selected.cx : selected.cx,
      cy: axis === 'horizontal' ? -selected.cy : selected.cy,
      label: `${selected.label || selected.id} (mirror)`,
    };
    const mirror = { id: `mir_${Date.now().toString(36).slice(-4)}`, axis, axisCoord: 0, members: [{ srcId: selected.id, mirrorId: mid, locked: true }] };
    updateScene(prev => ({ ...prev, components: [...prev.components, mirrorComp], mirrors: [...prev.mirrors, mirror] }));
  };

  const toggleMirrorLock = (mirrorId, memberIdx) => {
    updateScene(prev => ({
      ...prev,
      mirrors: prev.mirrors.map(m => m.id === mirrorId ? { ...m, members: m.members.map((mm, i) => i === memberIdx ? { ...mm, locked: !mm.locked } : mm) } : m)
    }));
  };

  const deleteMirror = (mirrorId) => updateScene(prev => ({ ...prev, mirrors: prev.mirrors.filter(m => m.id !== mirrorId) }));

  // ----- Boolean operations -----
  // Create a derived (boolean) component from the current selection. The
  // derived component is a new entry in scene.components with kind='boolean',
  // consuming its operands (which get a `consumedBy` tag pointing back at
  // the new component's id). Consumed operands are hidden from the SHAPES
  // list, snap targets, and standalone rendering — they appear only as
  // sub-entries inside the derived component's history. The derived
  // component has its own cx/cy (centroid of operand bbox at creation),
  // its own transforms, and exports as a single HFSS part via the chosen
  // Unite/Intersect/Subtract operation. Just like in HFSS: the boolean
  // result is a new part with a name; the operands are gone from the tree
  // (kept in the data so geometry can be re-resolved if the user toggles
  // the boolean off).
  const createBoolean = (op) => {
    const ids = Array.from(selectedIds);
    if (ids.length < 2) return;
    // Disallow operands that are already consumed (you can build booleans
    // OF booleans — that's fine — but not select an inner operand directly).
    const operandsOk = ids.every(id => {
      const c = scene.components.find(cc => cc.id === id);
      return c && !c.consumedBy;
    });
    if (!operandsOk) {
      alertDialog('One or more selected shapes is already part of another boolean. Use the parent boolean instead.', 'Cannot combine');
      return;
    }
    // Compute the centroid of operand bboxes from the SOLVED scene so the
    // new component starts at the cluster's geometric center. After this
    // the boolean's cx/cy is what gets dragged; operand cx/cy stays at
    // its current absolute position (i.e. operand.cx is independent of
    // the parent's cx). When the user drags the boolean, all operands
    // translate by the same delta — handled by the move-drag's coMovers.
    const solvedNow = applyMirrors(solveLayout(scene.components, scene.snaps, paramValues), scene.mirrors);
    let cxSum = 0, cySum = 0;
    for (const id of ids) {
      const c = solvedNow.find(cc => cc.id === id);
      if (c) { cxSum += c.cx; cySum += c.cy; }
    }
    const cx = cxSum / ids.length;
    const cy = cySum / ids.length;
    // Pick the layer of the FIRST operand for the result (HFSS-style: the
    // result inherits the blank/base operand's properties).
    const baseOp = scene.components.find(c => c.id === ids[0]);
    const layer = baseOp?.layer || 'waveguide';
    const conductorLayerId = baseOp?.conductorLayerId;
    // Choose a fresh ID. Format: `<op><n>` so it reads like a normal comp.
    const prefix = op === 'union' ? 'union' : (op === 'intersect' ? 'isect' : 'diff');
    let n = 1;
    while (scene.components.some(c => c.id === `${prefix}${n}`)) n++;
    const newId = `${prefix}${n}`;
    const derived = {
      id: newId,
      kind: 'boolean',
      op,
      operandIds: ids,
      layer,
      cx, cy,
      // Width/height aren't independent here — they're derived from the
      // result of the boolean op. We still store nominal values for code
      // paths that read c.w/c.h directly; expandTransforms treats this
      // component specially.
      w: '0', h: '0',
      cutouts: [],
      transforms: [],
      label: '',
      ...(conductorLayerId ? { conductorLayerId } : {}),
    };
    updateScene(prev => ({
      ...prev,
      components: [
        // Tag operands with consumedBy so they're hidden from SHAPES,
        // snap targets, and standalone rendering. They still live in
        // scene.components so their cx/cy/w/h/transforms remain editable
        // through the boolean's history sub-section.
        ...prev.components.map(c => ids.includes(c.id) ? { ...c, consumedBy: newId } : c),
        derived,
      ],
    }));
    setSelection({ ids: new Set([newId]), primary: newId });
  };

  // Update a derived boolean component's own fields (label, op, transforms…).
  const updateBoolean = (id, patch) => {
    updateComp(id, patch);
  };

  // Delete a boolean component. Its operands get released (consumedBy
  // cleared) so they return to the standalone SHAPES list. The boolean
  // entry itself is removed.
  const deleteBoolean = (id) => {
    updateScene(prev => ({
      ...prev,
      components: prev.components
        .filter(c => c.id !== id)
        .map(c => c.consumedBy === id ? { ...c, consumedBy: undefined } : c),
    }));
  };
  // Keep the ref pointing at the current createBoolean so the keyboard
  // handler (registered earlier in the body) can call it without creating
  // a temporal-dead-zone reference.
  createBooleanRef.current = createBoolean;

  const code = useMemo(() => {
    try {
      return generatePyAEDT(scene, paramValues);
    } catch (e) {
      console.error('pyAEDT generation error:', e);
      return `# Error generating script: ${e.message}\n# (See browser console for details)\n`;
    }
  }, [scene, paramValues]);

  const downloadFile = (filename, content, mimeType = null) => {
    try {
      // Detect binary (Uint8Array, ArrayBuffer) and pick a sensible mime type.
      const isBinary = content instanceof Uint8Array || content instanceof ArrayBuffer;
      const type = mimeType || (isBinary ? 'application/octet-stream' : 'text/plain;charset=utf-8');
      const blob = new Blob([content], { type });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      // Some sandboxed iframes don't trigger downloads via <a download>.
      // We keep the URL alive a moment in case the browser handles it asynchronously.
      setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, 100);
      return true;
    } catch (e) {
      console.error('Download error:', e);
      return false;
    }
  };

  // Generic export: generate a script with the given function and present it.
  // Tries to trigger a download; always shows a preview modal so the user can copy
  // the script manually if the sandbox blocks downloads.
  const handleExport = async (filename, generator) => {
    let content;
    try {
      content = generator(scene, paramValues);
    } catch (e) {
      console.error('Generator error:', e);
      await alertDialog('Error generating script: ' + e.message, 'Export error');
      return;
    }
    if (!content) {
      await alertDialog('Failed to generate script.', 'Export error');
      return;
    }
    const ok = downloadFile(filename, content);
    setExportPreview({ filename, content, downloaded: ok });
  };

  const handleExportPyAEDT = () => handleExport('layout.py', generatePyAEDT);
  const handleExportHfssNative = () => handleExport('layout_hfss.py', generateHfssNative);
  const handleExportGDS = async () => {
    let bytes;
    try {
      bytes = generateGDS(scene, paramValues);
    } catch (e) {
      console.error('GDS generator error:', e);
      await alertDialog('Error generating GDS: ' + e.message, 'Export error');
      return;
    }
    if (!bytes || !bytes.length) {
      await alertDialog('Failed to generate GDS.', 'Export error');
      return;
    }
    const ok = downloadFile('layout.gds', bytes, 'application/octet-stream');
    if (!ok) {
      await alertDialog('Failed to start GDS download.', 'Export error');
    } else {
      // Show a brief confirmation in the export preview modal — but with a
      // text summary instead of the binary content (which is unprintable).
      const summary = [
        `GDS-II file: layout.gds (${bytes.length} bytes)`,
        '',
        'Layer mapping:',
        '  1   = waveguide',
        ...Array.from((scene.stack || []).filter(l => l.role === 'conductor')).map((l, i) => `  ${10 + i}  = conductor "${l.name}"`),
        '  100 = port',
        '',
        'Coordinate units: 1 µm = 1000 nm (database unit = 1 nm).',
        '',
        'Notes:',
        '- Cutouts are emitted as separate boundaries on datatype 1, on the same',
        '  layer as the parent component. Most viewers render them as overlapping',
        '  shapes since GDS doesn\'t natively encode subtraction.',
        '- Mirrored components are exported with their solved (mirrored) positions.',
      ].join('\n');
      setExportPreview({ filename: 'layout.gds', content: summary, downloaded: ok, binary: true });
    }
  };

  const layerSwatches = {
    waveguide: { bg: '#14532d', fg: '#86efac' },
    electrode: { bg: '#7c2d12', fg: '#fed7aa' },
  };

  return (
    <div className="h-screen w-full flex flex-col relative" style={{ fontFamily: "'IBM Plex Sans', system-ui, sans-serif", background: '#0f172a', color: '#e2e8f0' }}>
      <header className="border-b border-slate-700" style={{ background: '#020617' }}>
        {/* Row 1 — primary tools and identity */}
        <div className="flex items-center justify-between px-4 py-2">
          <div className="flex items-center gap-3">
            <div className="w-7 h-7 rounded flex items-center justify-center" style={{ background: 'linear-gradient(135deg, #3ec27a, #f4a72e)' }}>
              <Box size={15} className="text-white" />
            </div>
            <div>
              <h1 className="font-bold tracking-tight text-sm" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                PHOTONIC<span className="text-emerald-400">·</span>LAYOUT
              </h1>
              <p className="text-[10px] text-slate-400">parametric primitives · pyAEDT export</p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            {/* Layer dropdown + shape buttons. The user picks a layer once
                (waveguide / conductor / port — and which conductor layer
                if multiple are defined), then clicks a shape button to
                begin a drag-to-create gesture. Active shape button gets a
                green ring; clicking again toggles off. */}
            {(() => {
              const conductors = (scene.stack || []).filter(l => l.role === 'conductor');
              // Build layer dropdown options. Each conductor layer becomes
              // its own entry so the user picks WHICH conductor explicitly.
              const layerOptions = [
                { value: 'waveguide', label: 'Waveguide', conductorLayerId: null },
                ...conductors.map(l => ({ value: `electrode:${l.id}`, label: l.name || l.id, conductorLayerId: l.id })),
                { value: 'port', label: 'Port', conductorLayerId: null },
              ];
              // Selected layer dropdown value. We encode the conductor's id
              // in the value string so distinct conductor layers are
              // distinguishable in a flat <select>.
              const dropdownValue = activeLayer === 'electrode' && activeConductorLayerId
                ? `electrode:${activeConductorLayerId}`
                : activeLayer;
              const layerBg = activeLayer === 'waveguide' ? '#3ec27a'
                : activeLayer === 'port' ? '#b91c1c'
                : '#f4a72e';
              const layerFg = activeLayer === 'port' ? '#fee2e2' : '#1f1300';
              const onLayerChange = (e) => {
                const v = e.target.value;
                if (v.startsWith('electrode:')) {
                  setActiveLayer('electrode');
                  setActiveConductorLayerId(v.slice('electrode:'.length));
                } else {
                  setActiveLayer(v);
                  setActiveConductorLayerId(null);
                }
                // Switching layer cancels any in-progress add mode so the
                // user's next shape-button click starts fresh on the new
                // layer rather than carrying over an old shape selection.
                setAddMode(null);
              };
              // Each shape button toggles addMode. Active state = the
              // current addMode targets the same (layer, shape) tuple.
              const isShapeActive = (shape) => addMode
                && (addMode.layer === activeLayer)
                && (addMode.shape === shape)
                && (activeLayer !== 'electrode' || addMode.conductorLayerId === activeConductorLayerId);
              const toggleShape = (shape) => {
                if (isShapeActive(shape)) {
                  setAddMode(null);
                } else {
                  setAddMode({
                    layer: activeLayer,
                    shape,
                    ...(shape === 'polygon' ? { n: polygonSides } : {}),
                    ...(activeLayer === 'electrode' && activeConductorLayerId
                      ? { conductorLayerId: activeConductorLayerId }
                      : {}),
                  });
                  setSnapMode('idle');
                  setRulerMode(false);
                }
              };
              const baseBtn = 'flex items-center justify-center w-7 h-7 rounded';
              const activeRing = ' ring-2 ring-green-400';
              return (
                <>
                  <select
                    value={dropdownValue}
                    onChange={onLayerChange}
                    className="text-[11px] font-medium px-1.5 py-1 rounded border-0"
                    style={{ background: layerBg, color: layerFg, cursor: 'pointer' }}
                    title="Layer for the next shape created"
                  >
                    {layerOptions.map(o => (
                      <option key={o.value} value={o.value} style={{ background: '#1e293b', color: '#e2e8f0' }}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                  <button
                    key="add-rect"
                    onClick={() => toggleShape('rect')}
                    className={baseBtn + (isShapeActive('rect') ? activeRing : '')}
                    style={{ background: '#1e293b', color: '#e2e8f0' }}
                    title="Add rectangle — drag on canvas to size."
                  >
                    <Square size={13} />
                  </button>
                  <button
                    key="add-circle"
                    onClick={() => toggleShape('circle')}
                    className={baseBtn + (isShapeActive('circle') ? activeRing : '')}
                    style={{ background: '#1e293b', color: '#e2e8f0' }}
                    title="Add circle — drag a bbox; an inscribed circle is created."
                  >
                    <Circle size={13} />
                  </button>
                  <button
                    key="add-ellipse"
                    onClick={() => toggleShape('ellipse')}
                    className={baseBtn + (isShapeActive('ellipse') ? activeRing : '')}
                    style={{ background: '#1e293b', color: '#e2e8f0' }}
                    title="Add ellipse — drag a bbox; the inscribed ellipse fills it."
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <ellipse cx="12" cy="12" rx="10" ry="6" />
                    </svg>
                  </button>
                  <div className="flex items-center gap-0.5">
                    <button
                      key="add-poly"
                      onClick={() => toggleShape('polygon')}
                      className={baseBtn + (isShapeActive('polygon') ? activeRing : '')}
                      style={{ background: '#1e293b', color: '#e2e8f0' }}
                      title={`Add regular polygon (${polygonSides} sides) — drag a bbox; the polygon's circumradius fills it.`}
                    >
                      <Hexagon size={13} />
                    </button>
                    {/* Polygon side count selector. Inline so it's discoverable. */}
                    <input
                      type="number"
                      value={polygonSides}
                      onChange={(e) => {
                        const v = Math.max(3, Math.min(64, parseInt(e.target.value) || 6));
                        setPolygonSides(v);
                        // If polygon-add is active, propagate the new count
                        // so the next drag uses the updated side count.
                        if (addMode && addMode.shape === 'polygon') {
                          setAddMode({ ...addMode, n: v });
                        }
                      }}
                      min={3}
                      max={64}
                      className="w-9 text-[10px] px-1 py-0.5 rounded bg-slate-800 text-slate-200 border border-slate-700"
                      title="Number of sides (3–64)"
                    />
                  </div>
                </>
              );
            })()}
            <button
              onClick={() => { setSnapMode(snapMode === 'creating' ? 'idle' : 'creating'); setAddMode(null); setRulerMode(false); }}
              className={`flex items-center gap-1 px-2 py-1 rounded text-xs font-medium ${snapMode === 'creating' ? 'ring-2 ring-amber-400' : ''}`}
              style={{ background: snapMode === 'creating' ? '#f59e0b' : '#334155', color: snapMode === 'creating' ? '#0f172a' : '#e2e8f0' }}
              title="Pick two anchor points to create a snap. Click one of the 9 fixed dots, or anywhere along an orange edge for a parametric anchor. Hold Shift while picking the second anchor to lock the connection axis-aligned."
            >
              <Link2 size={11} /> {snapMode === 'creating' ? 'pick anchor' : 'snap'}
            </button>
            <button
              onClick={() => {
                if (rulerMode) {
                  setRulerMode(false);
                  setRulerInProgress(null);
                  setRulerSnapPoint(null);
                } else {
                  setRulerMode(true);
                  setSnapMode('idle');
                  setAddMode(null);
                }
              }}
              className={`flex items-center gap-1 px-2 py-1 rounded text-xs font-medium ${rulerMode ? 'ring-2 ring-cyan-400' : ''}`}
              style={{ background: rulerMode ? '#06b6d4' : '#334155', color: rulerMode ? '#0f172a' : '#e2e8f0' }}
              title="Ruler: click two points to measure distance. Snaps to nearby corners, edge midpoints, centers, and edges. Hold Shift while picking the second point to lock the line horizontal or vertical. Esc cancels in-progress, or exits the tool."
            >
              <Ruler size={11} /> {rulerMode ? (rulerInProgress ? 'pick end' : 'pick start') : 'ruler'}
            </button>
            <DropdownMenu
              label="export"
              icon={Download}
              buttonClassName="flex items-center gap-1 px-2 py-1 rounded text-xs font-medium"
              buttonStyle={{ background: '#06b6d4', color: '#0f172a' }}
              items={[
                { label: 'pyAEDT', icon: Download, onClick: handleExportPyAEDT, hint: 'layout.py', title: 'External Python with pyaedt installed (run from terminal: python layout.py)' },
                { label: 'HFSS native', icon: Download, onClick: handleExportHfssNative, hint: 'layout_hfss.py', title: 'Native HFSS COM script (run inside HFSS via Tools -> Run Script)' },
                { label: 'GDS-II', icon: Download, onClick: handleExportGDS, hint: 'layout.gds', title: 'Binary GDS-II layout. Layers: waveguide=1, conductors=10+ (one per stack layer), port=100. Coords in µm with 1nm database resolution.' },
              ]}
            />
            <div className="w-px h-5 bg-slate-700 mx-1" />
            {/* Save / design / workspace */}
            <button onClick={handleSave} className="flex items-center gap-1 px-2 py-1 rounded text-xs font-medium" style={{ background: '#22c55e', color: '#0f172a' }} title="Save (Cmd/Ctrl+S)">
              <Save size={11} /> save
            </button>
            <button
              onClick={() => setShowDesigns(s => !s)}
              className={`flex items-center gap-1 px-2 py-1 rounded text-xs ${showDesigns ? 'bg-cyan-700 text-white' : 'border border-slate-600 hover:bg-slate-800'}`}
              title={`Show saved designs${savedAgoLabel ? ` · autosaved ${savedAgoLabel}` : ''}`}
            >
              <FileText size={11} />
              <span className="font-mono max-w-[10rem] truncate">{designName}</span>
              <span className={`text-[9px] ml-1 ${saveStatus === 'saved' ? 'text-emerald-400' : saveStatus === 'saving' ? 'text-amber-400' : 'text-red-400'}`}>
                {saveStatus === 'saved' ? '●' : saveStatus === 'saving' ? '…' : '○'}
              </span>
              {savedAgoLabel && saveStatus === 'saved' && (
                <span className="text-[9px] text-slate-500 ml-1 normal-case font-normal">{savedAgoLabel}</span>
              )}
            </button>
            <button
              onClick={() => setShowWorkspaceDialog(true)}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium border border-cyan-700 hover:bg-cyan-900/40 hover:border-cyan-500"
              style={{ background: '#164e63', color: '#a5f3fc' }}
              title={workspaceHandle
                ? `Workspace "${workspace || 'default'}" — linked to "${workspaceFileLabel}". Saves auto-mirror to this file. Click to manage.`
                : `Click to switch, create, or link a workspace — currently "${workspace || 'default'}". Each workspace has its own designs, library, and archive.`}
            >
              <FolderTree size={12} />
              <span className="font-mono max-w-[8rem] truncate">{workspace || 'default'}</span>
              {workspaceHandle && (
                <span className="text-[9px] text-emerald-300" title={`Linked: ${workspaceFileLabel}`}>●</span>
              )}
              <span className="text-[9px] opacity-70 normal-case font-normal">▾</span>
            </button>
          </div>
        </div>
        {/* Row 2 — secondary tools and view controls */}
        <div className="flex items-center justify-between px-4 py-1.5 border-t border-slate-800" style={{ background: '#0a0f1f' }}>
          <div className="flex items-center gap-1.5">
            <DropdownMenu
              label="mirror"
              icon={FlipHorizontal}
              disabled={!selected}
              buttonClassName="flex items-center gap-1 px-2 py-1 rounded text-xs disabled:opacity-30"
              buttonStyle={{ background: '#7c3aed', color: 'white' }}
              items={[
                { label: 'Horizontal symmetry', icon: FlipVertical, onClick: () => createMirror('horizontal'), title: 'Mirror selection across a horizontal axis (top↔bottom)' },
                { label: 'Vertical symmetry', icon: FlipHorizontal, onClick: () => createMirror('vertical'), title: 'Mirror selection across a vertical axis (left↔right)' },
              ]}
            />
            <DropdownMenu
              label="bool"
              icon={Combine}
              disabled={selectedIds.size < 2}
              buttonClassName="flex items-center gap-1 px-2 py-1 rounded text-xs disabled:opacity-30"
              buttonStyle={{ background: '#0e7490', color: 'white' }}
              items={[
                { label: 'Union', icon: Combine, onClick: () => createBoolean('union'), hint: `${selectedIds.size} selected`, title: 'Combine all selected shapes into one. Native HFSS/pyAEDT exports use Unite. Canvas keeps showing operands separately (no in-browser polygon clipping yet).' },
                { label: 'Intersect', icon: XIcon, onClick: () => createBoolean('intersect'), hint: `${selectedIds.size} selected`, title: 'Keep only the overlap of all selected shapes. Native HFSS/pyAEDT exports use Intersect.' },
                { label: 'Subtract', icon: Minus, onClick: () => createBoolean('subtract'), hint: `${selectedIds.size} selected`, title: 'Subtract later-selected shapes from the FIRST one. The first selected component is the base; the rest are tools. Native HFSS/pyAEDT exports use Subtract.' },
                { divider: true },
                { label: 'Manage in BOOL panel…', icon: Combine, onClick: () => setActivePanel('booleans'), title: 'Open the BOOL panel to view/edit/toggle all boolean operations defined in this scene.' },
              ]}
            />
            <button
              onClick={diagnoseScene}
              className="flex items-center gap-1 px-2 py-1 rounded text-xs font-medium"
              style={{ background: sceneIssues.length > 0 ? '#dc2626' : '#334155', color: '#e2e8f0' }}
              title={sceneIssues.length === 0
                ? 'Validate scene: check for snap conflicts, orphans, cycles, broken expressions'
                : `${sceneIssues.length} issue${sceneIssues.length === 1 ? '' : 's'} detected — click to diagnose`}
            >
              <AlertTriangle size={11} /> diagnose{sceneIssues.length > 0 ? ` (${sceneIssues.length})` : ''}
            </button>
            {rulerMeasurements.length > 0 && (
              <button
                onClick={() => { setRulerMeasurements([]); setRulerInProgress(null); }}
                className="flex items-center gap-1 px-2 py-1 rounded text-xs"
                style={{ background: '#334155', color: '#e2e8f0' }}
                title={`Clear ${rulerMeasurements.length} measurement${rulerMeasurements.length === 1 ? '' : 's'}`}
              >
                <Trash2 size={11} /> clear ({rulerMeasurements.length})
              </button>
            )}
            <div className="w-px h-5 bg-slate-700 mx-1" />
            <button
              onClick={() => setGridSnapEnabled(g => !g)}
              className={`flex items-center gap-1 px-2 py-1 rounded text-xs ${gridSnapEnabled ? 'bg-cyan-700 text-white' : 'bg-slate-700 text-slate-400'}`}
              title="Grid snap (hold Cmd/Ctrl while dragging to disable temporarily)"
            >
              <Grid3x3 size={11} /> {gridSize}
            </button>
            <input
              type="number" step="0.1" min="0.1"
              value={gridSize}
              onChange={(e) => setGridSize(Math.max(0.1, parseFloat(e.target.value) || 1))}
              className="w-12 bg-slate-800 border border-slate-700 rounded px-1 py-0.5 text-xs text-white outline-none"
            />
            <button onClick={fitToView} className="flex items-center gap-1 px-2 py-1 rounded text-xs border border-slate-600 hover:bg-slate-800" title="Fit all to view (F)">
              <Maximize2 size={11} /> fit
            </button>
            <button
              onClick={() => setShowDimensions(d => !d)}
              className={`flex items-center gap-1 px-2 py-1 rounded text-xs ${showDimensions ? 'bg-violet-600 text-white' : 'border border-slate-600 hover:bg-slate-800'}`}
              title="Show dimension arrows for every parameter-bound width, height, and snap offset. Variable names are the primary label; values appear when there is room."
            >
              <Ruler size={11} /> dimensions
            </button>
          </div>
          <div className="flex items-center gap-1.5">
            <button onClick={undo} disabled={history.length === 0} className="flex items-center gap-1 px-2 py-1 rounded text-xs border border-slate-600 hover:bg-slate-800 disabled:opacity-30" title="Undo (Cmd/Ctrl+Z)">
              <RotateCcw size={11} />
            </button>
            <button onClick={redo} disabled={future.length === 0} className="flex items-center gap-1 px-2 py-1 rounded text-xs border border-slate-600 hover:bg-slate-800 disabled:opacity-30" title="Redo (Cmd/Ctrl+Shift+Z)">
              <RotateCw size={11} />
            </button>
            <div className="w-px h-5 bg-slate-700 mx-1" />
            <button onClick={handleSaveAs} className="flex items-center gap-1 px-2 py-1 rounded text-xs border border-slate-600 hover:bg-slate-800" title="Save as new (Cmd/Ctrl+Shift+S)">
              <Copy size={11} /> save as
            </button>
            <button onClick={handleNewBlank} className="flex items-center gap-1 px-2 py-1 rounded text-xs border border-slate-600 hover:bg-slate-800" title="New blank design — starts from a completely empty scene (no components, no parameters; layer stack preserved). Prompts to save the current design first if unsaved.">
              <FilePlus size={11} /> blank
            </button>
          </div>
        </div>
      </header>

      {/* Workspace switcher dialog */}
      {showWorkspaceDialog && (
        <div className="fixed inset-0 z-40 flex items-center justify-center" style={{ background: 'rgba(15,23,42,0.6)' }} onClick={() => setShowWorkspaceDialog(false)}>
          <div className="rounded-lg shadow-2xl border border-slate-700 w-[28rem] max-w-[90vw] overflow-hidden" style={{ background: '#0f172a' }} onClick={(e) => e.stopPropagation()}>
            <div className="px-4 py-3 border-b border-slate-700 flex items-center justify-between">
              <div>
                <span className="text-sm font-medium text-slate-200">Workspaces</span>
                <p className="text-[10px] text-slate-500 mt-0.5">Each workspace has its own designs, library, and archive. Storage prefix: <span className="font-mono">photonic_layout:[name]:…</span></p>
              </div>
              <button onClick={() => setShowWorkspaceDialog(false)} className="text-slate-500 hover:text-slate-200 text-xs">✕</button>
            </div>
            <div className="px-4 py-3 border-b border-slate-700">
              <p className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">Existing workspaces</p>
              <div className="space-y-1 max-h-48 overflow-y-auto">
                {knownWorkspaces.length === 0 && (
                  <p className="text-[11px] text-slate-500 italic">No data yet. Create a workspace below.</p>
                )}
                {knownWorkspaces.map(ws => {
                  const isCurrent = ws === workspace;
                  const label = ws || 'default';
                  return (
                    <div key={ws || '__default__'} className={`flex items-center gap-2 rounded px-2 py-1.5 ${isCurrent ? 'border border-cyan-500 bg-cyan-900/20' : 'border border-slate-700 hover:border-slate-500'}`}>
                      <FolderTree size={11} className={isCurrent ? 'text-cyan-400' : 'text-slate-400'} />
                      <span className="font-mono text-xs flex-1 truncate" style={{ color: isCurrent ? '#67e8f9' : '#cbd5e1' }}>{label}</span>
                      {isCurrent ? (
                        <span className="text-[9px] text-cyan-400 font-medium">CURRENT</span>
                      ) : (
                        <button
                          onClick={() => handleChangeWorkspace(ws)}
                          className="text-[10px] px-2 py-0.5 rounded bg-cyan-700 hover:bg-cyan-600 text-white"
                        >
                          switch
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
            <div className="px-4 py-3 border-b border-slate-700">
              <p className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">Switch to / create</p>
              <WorkspaceCreateRow currentWorkspace={workspace} onSwitch={handleChangeWorkspace} />
              <p className="text-[10px] text-slate-500 mt-2">Tip: leave empty to use the default workspace. Names cannot contain colons.</p>
            </div>

            {/* File-link section: the active workspace can be bound to a JSON
                file on disk; every successful save mirrors the workspace
                bundle to that file. When linking is unavailable (Safari,
                Firefox, or sandboxed iframe), the user gets a manual
                download/import flow instead. */}
            <div className="px-4 py-3 border-b border-slate-700">
              <p className="text-[10px] uppercase tracking-wider text-slate-500 mb-1.5">Linked file (auto-mirrors on save)</p>
              {workspaceHandle ? (
                <div className="rounded border border-emerald-700/60 bg-emerald-900/10 px-2 py-1.5">
                  <div className="flex items-center gap-2">
                    <Save size={11} className="text-emerald-400" />
                    <span className="font-mono text-xs flex-1 truncate text-emerald-300" title={workspaceFileLabel}>
                      {workspaceFileLabel || '(linked file)'}
                    </span>
                    <button
                      onClick={mirrorWorkspaceToFileIfLinked}
                      className="text-[10px] px-2 py-0.5 rounded bg-emerald-700 hover:bg-emerald-600 text-white"
                      title="Force a write of the current workspace state to the linked file"
                    >
                      sync now
                    </button>
                    <button
                      onClick={handleUnlinkWorkspaceFile}
                      className="text-[10px] px-2 py-0.5 rounded border border-slate-600 hover:bg-slate-800 text-slate-300"
                      title="Stop mirroring saves to this file (the file is kept on disk)"
                    >
                      unlink
                    </button>
                  </div>
                  <p className="text-[10px] text-slate-500 mt-1.5 leading-snug">
                    Browsers don't expose absolute paths — only the file name is shown. Every save (auto and manual) rewrites the entire workspace bundle to this file.
                  </p>
                </div>
              ) : (
                <div className="space-y-1.5">
                  <button
                    onClick={handleLinkWorkspaceToFile}
                    disabled={!fsLinkAvailable}
                    className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 rounded text-xs font-medium bg-cyan-700 hover:bg-cyan-600 text-white disabled:opacity-30 disabled:cursor-not-allowed"
                    title={fsLinkAvailable
                      ? 'Pick or create a JSON file on disk; every save will rewrite the entire workspace bundle to it.'
                      : (fsBlockedAtRuntime
                        ? 'Direct file linking is blocked in this browsing context (sandboxed iframe). Use "Download workspace" below instead.'
                        : 'Your browser does not support direct file linking (File System Access API). Use Chrome or Edge for this feature.')}
                  >
                    <Save size={11} /> Link to file…
                  </button>
                  {/* Always-available manual snapshot fallback. Even when
                      linking works, this gives a one-click download for
                      versioned backups. */}
                  <button
                    onClick={handleDownloadWorkspaceSnapshot}
                    className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 rounded text-xs font-medium border border-slate-600 hover:bg-slate-800 text-slate-200"
                    title="Download a JSON snapshot of the entire workspace (designs, library, archive). Re-import via the button below."
                  >
                    <Download size={11} /> Download workspace
                  </button>
                  {!fsLinkAvailable && (
                    <p className="text-[10px] text-amber-400 mt-1 leading-snug">
                      {fsBlockedAtRuntime
                        ? 'Direct file linking is blocked in this browsing context (sandboxed iframe). Use Download / Import instead.'
                        : 'Your browser does not support the File System Access API. Use Chrome or Edge to link a file directly, or use Download / Import below.'}
                    </p>
                  )}
                </div>
              )}
            </div>

            {/* Import section: load a workspace bundle from a JSON file. */}
            <div className="px-4 py-3">
              <p className="text-[10px] uppercase tracking-wider text-slate-500 mb-1.5">Import workspace</p>
              <button
                onClick={handleImportWorkspaceFromFile}
                className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 rounded text-xs font-medium border border-slate-600 hover:bg-slate-800 text-slate-200"
                title="Load designs, library, and archive from a previously saved workspace JSON file. You'll be asked whether to merge or replace, and (in supported browsers) whether to link the imported file for future auto-mirroring."
              >
                <Upload size={11} /> Import workspace from file…
              </button>
              <p className="text-[10px] text-slate-500 mt-1.5 leading-snug">
                Imports into <span className="text-slate-300 font-mono">"{workspace || 'default'}"</span>. You'll be prompted to merge (keep existing) or replace (wipe first){fsLinkAvailable ? '. After import, you\'ll also be offered to link the imported file for future auto-mirroring' : ''}.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Designs dropdown overlay */}
      {showDesigns && (
        <div className="absolute z-30 right-4 top-12 w-80 rounded-lg shadow-2xl border border-slate-700 overflow-hidden" style={{ background: '#0f172a' }}>
          <div className="px-3 py-2 border-b border-slate-700 flex items-center justify-between">
            <span className="text-xs font-medium uppercase tracking-wider text-slate-400">Saved Designs ({savedList.length})</span>
            <button onClick={() => setShowDesigns(false)} className="text-slate-500 hover:text-slate-200 text-xs">✕</button>
          </div>
          <div className="px-3 py-2 border-b border-slate-700 flex items-center gap-2">
            <input
              type="text"
              value={designName}
              onChange={(e) => { setDesignName(e.target.value); setSaveStatus('unsaved'); }}
              onBlur={() => { /* user can hit Save afterwards */ }}
              className="flex-1 bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs font-mono text-cyan-300 outline-none focus:border-cyan-400"
              placeholder="design name"
            />
            <button onClick={handleSave} className="px-2 py-1 rounded text-xs font-medium" style={{ background: '#22c55e', color: '#0f172a' }}>save</button>
          </div>
          <div className="max-h-80 overflow-y-auto">
            {savedList.length === 0 && <p className="text-xs text-slate-500 italic px-3 py-3">No saved designs yet.</p>}
            {savedList.map(name => {
              const isCurrent = name === designName;
              return (
                <div key={name} className={`flex items-center gap-1 px-3 py-1.5 border-b border-slate-800 hover:bg-slate-800/60 ${isCurrent ? 'bg-slate-800/40' : ''}`}>
                  <button onClick={() => { handleLoad(name); setShowDesigns(false); }} className="flex-1 text-left text-xs font-mono text-slate-200 hover:text-cyan-300 truncate">
                    {isCurrent && <span className="text-emerald-400 mr-1">●</span>}
                    {name}
                  </button>
                  <button
                    onClick={async () => {
                      const newName = await promptDialog('Rename design:', name, 'Rename');
                      if (newName) handleRenameDesign(name, newName);
                    }}
                    className="text-slate-500 hover:text-cyan-400 text-[10px] px-1"
                    title="Rename"
                  >
                    rename
                  </button>
                  <button onClick={() => handleDeleteDesign(name)} className="text-slate-500 hover:text-red-400" title="Delete">
                    <Trash2 size={11} />
                  </button>
                </div>
              );
            })}
          </div>
          <div className="px-3 py-2 border-t border-slate-700 flex items-center gap-2 text-[10px] text-slate-500">
            <span>Cmd+S = save · Cmd+Shift+S = save as · Cmd+Z / ⇧Z = undo / redo</span>
          </div>
        </div>
      )}

      <div className="flex-1 flex overflow-hidden">
        {/* LEFT */}
        <div className="w-72 border-r border-slate-700 flex flex-col" style={{ background: '#0f172a' }}>
          <div className="flex flex-wrap border-b border-slate-700 text-[10px]">
            {[
              { id: 'params', label: 'PARAMS', icon: Settings2 },
              { id: 'layers', label: 'LAYERS', icon: Layers },
              { id: 'shapes', label: 'SHAPES', icon: Square },
              { id: 'snaps', label: 'SNAPS', icon: Link2 },
              { id: 'mirrors', label: 'MIRRORS', icon: FlipHorizontal },
              { id: 'library', label: 'LIBRARY', icon: BookOpen },
              { id: 'code', label: 'CODE', icon: Box },
            ].map(t => {
              const Icon = t.icon;
              return (
                <button key={t.id} onClick={() => setActivePanel(t.id)} className={`flex-1 min-w-[3.5rem] px-1 py-2 font-medium tracking-wider transition-colors flex flex-col items-center gap-0.5 ${activePanel === t.id ? 'text-cyan-400 border-b-2 border-cyan-400' : 'text-slate-400 hover:text-slate-200'}`}>
                  <Icon size={11} />
                  {t.label}
                </button>
              );
            })}
          </div>

          <div className="flex-1 overflow-y-auto p-3">
            {activePanel === 'params' && (
              <div className="space-y-0.5">
                <div className="flex gap-1 mb-1">
                  <button onClick={addParam} className="flex-1 flex items-center justify-center gap-1 px-2 py-1 rounded text-xs border border-dashed border-slate-600 hover:border-slate-400 text-slate-300">
                    <Plus size={11} /> add
                  </button>
                  <button
                    onClick={cleanupUnusedParams}
                    disabled={unusedParams.length === 0}
                    className="flex items-center justify-center gap-1 px-2 py-1 rounded text-xs border border-slate-600 disabled:opacity-30 disabled:cursor-not-allowed enabled:hover:bg-amber-900/30 enabled:hover:border-amber-600 enabled:text-amber-300 text-slate-400"
                    title={unusedParams.length === 0 ? 'No unused parameters' : `Remove ${unusedParams.length} unused: ${unusedParams.slice(0, 5).join(', ')}${unusedParams.length > 5 ? '...' : ''}`}
                  >
                    <Trash2 size={11} /> cleanup{unusedParams.length > 0 ? ` (${unusedParams.length})` : ''}
                  </button>
                </div>
                {Object.entries(scene.params).map(([name, p]) => (
                  <ParamRow
                    key={name}
                    name={name}
                    p={p}
                    value={paramValues[name]}
                    error={paramErrors[name]}
                    isUnused={unusedParams.includes(name)}
                    isInvolved={paramsInvolvedInSelection.has(name)}
                    autoFocus={newParamFocus === name}
                    onAutoFocusDone={() => setNewParamFocus(null)}
                    onRename={(o, n) => renameParam(o, n)}
                    onUpdateExpr={(v) => updateParam(name, { expr: v })}
                    onCommitExpr={(v) => commitExpr(v, '0', scene.params[name]?.unit || 'µm', `Auto-created (used by ${name})`, name)}
                    onUpdateUnit={(v) => updateParam(name, { unit: v })}
                    onUpdateDesc={(v) => updateParam(name, { desc: v })}
                    onDelete={() => deleteParam(name)}
                  />
                ))}
              </div>
            )}

            {activePanel === 'layers' && (
              <div className="space-y-2 text-xs">
                {/* Stack library: pick a saved stack to swap in, or save
                    the current one as a new entry. The dropdown reads
                    out the scene's stackName so the user can see which
                    stack they're wearing right now. */}
                <div className="rounded border border-slate-700 px-2 py-1.5" style={{ background: '#1e293b' }}>
                  <div className="flex items-center gap-1 mb-1">
                    <Layers size={11} className="text-cyan-400 flex-shrink-0" />
                    <span className="text-[9px] uppercase tracking-wider text-slate-400">Stack</span>
                    <select
                      value={stackList.includes(scene.stackName) ? scene.stackName : '__current__'}
                      onChange={(e) => {
                        const v = e.target.value;
                        if (v === '__current__') return;
                        switchStack(v);
                      }}
                      className="flex-1 min-w-0 bg-slate-900 border border-slate-700 rounded px-1 py-0.5 text-[10px] font-mono text-cyan-300 outline-none focus:border-cyan-400"
                      title="Switch to a saved stack from the library"
                    >
                      {!stackList.includes(scene.stackName) && (
                        <option value="__current__">
                          {scene.stackName || '(unnamed)'} · unsaved
                        </option>
                      )}
                      {stackList.map((n) => (
                        <option key={n} value={n}>{n}</option>
                      ))}
                    </select>
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={newStack}
                      className="flex-1 text-[10px] px-2 py-0.5 rounded bg-emerald-700 hover:bg-emerald-600 text-white"
                      title="Create a fresh stack from scratch (seeded with one conductor layer) and add it to the workspace library."
                    >
                      new…
                    </button>
                    <button
                      onClick={renameCurrentStack}
                      className="text-[10px] px-2 py-0.5 rounded border border-slate-600 hover:border-cyan-400 hover:text-cyan-300 text-slate-300"
                      title="Rename the currently-loaded stack. If it's in the workspace library, the library entry is moved under the new name; if not, only the display label updates."
                    >
                      rename…
                    </button>
                    <button
                      onClick={importStackFromFile}
                      className="text-[10px] px-2 py-0.5 rounded border border-slate-600 hover:border-cyan-400 hover:text-cyan-300 text-slate-300"
                      title="Import a stack from a JSON file (will be added to this workspace's library and switched to)."
                    >
                      import…
                    </button>
                    <button
                      onClick={exportStackToFile}
                      className="text-[10px] px-2 py-0.5 rounded border border-slate-600 hover:border-cyan-400 hover:text-cyan-300 text-slate-300"
                      title="Download the current stack as a JSON file."
                    >
                      export
                    </button>
                    <button
                      onClick={() => deleteStackEntry(scene.stackName)}
                      disabled={!stackList.includes(scene.stackName)}
                      className="text-[10px] px-2 py-0.5 rounded border border-slate-600 hover:border-red-400 hover:text-red-300 text-slate-300 disabled:opacity-30 disabled:cursor-not-allowed"
                      title="Remove the currently-loaded stack from the workspace library. The working stack in the scene is kept."
                    >
                      delete
                    </button>
                  </div>
                </div>
                <p className="text-[10px] text-slate-500 italic px-1 leading-snug">
                  Layers stack sequentially from bottom to top — each layer's z-start is the previous layer's z-end. Use the "merge above" toggle on a layer card to make it COPLANAR with the layer above (same z-start, possibly different thicknesses); a coplanar group must contain a cladding so it can fill around its structures.
                </p>
                <button
                  onClick={() => updateScene(prev => ({
                    ...prev,
                    stack: [
                      ...prev.stack,
                      // No coplanarGroup → the new layer sits sequentially
                      // on top of whatever is currently at the top of the
                      // stack. The user can opt it into the level below
                      // via the "merge above" button on the card.
                      { id: `l_${Math.random().toString(36).slice(2, 7)}`, name: 'New layer', thickness: '1', material: 'silicon_dioxide', color: '#94a3b8', role: 'substrate' },
                    ],
                  }))}
                  className="w-full flex items-center justify-center gap-1 px-2 py-1 rounded text-xs border border-dashed border-slate-600 hover:border-cyan-400 text-slate-300"
                >
                  <Plus size={11} /> add layer
                </button>
                {(() => {
                  // Group layers into vertically-stacked "levels" using
                  // the EXPLICIT coplanarGroup id. Contiguous layers
                  // sharing the same non-empty id form one level; layers
                  // with no id stand alone. The order in scene.stack is
                  // preserved within and across levels — sequential is
                  // the default, coplanar is opt-in.
                  const levels = [];
                  let curLevel = null;
                  for (let i = 0; i < scene.stack.length; i++) {
                    const layer = scene.stack[i];
                    const gid = layer.coplanarGroup;
                    if (gid && curLevel && curLevel.groupId === gid) {
                      curLevel.layers.push({ layer, idx: i });
                    } else if (gid) {
                      curLevel = {
                        key: gid,
                        isDevice: true,
                        groupId: gid,
                        layers: [{ layer, idx: i }],
                        zLabel: 'coplanar',
                      };
                      levels.push(curLevel);
                    } else {
                      curLevel = null;
                      levels.push({ key: layer.id, isDevice: false, layers: [{ layer, idx: i }], zLabel: null });
                    }
                  }
                  // Coplanar-cladding validation: every multi-member
                  // coplanar group MUST contain at least one cladding-
                  // role layer so it can fill around the structures on
                  // that level (HFSS would otherwise get a void with
                  // exposed surfaces). Stamp a warning flag on the
                  // level so LevelGroup can render the hint.
                  for (const lvl of levels) {
                    if (lvl.isDevice && lvl.layers.length >= 2) {
                      const hasCladding = lvl.layers.some(({ layer }) => layer.role === 'cladding');
                      lvl.needsCladding = !hasCladding;
                    }
                  }
                  // Render top-down: reverse the levels array.
                  return [...levels].reverse().map((level, levelIdxFromTop) => (
                    <LevelGroup
                      key={level.key}
                      level={level}
                      scene={scene}
                      paramValues={paramValues}
                      updateScene={updateScene}
                      commitExpr={commitExpr}
                    />
                  ));
                })()}


                {scene.stack.length === 0 && (
                  <p className="text-xs text-slate-500 italic px-1">No layers in stack.</p>
                )}
              </div>
            )}

            {activePanel === 'shapes' && (() => {
              // ============================================================
              // OBJECT TREE
              // ============================================================
              // Every entry in the SHAPES panel is an "object" — primitive
              // rectangle, boolean result, or group of objects. Each row
              // shows the object's identity and (when expanded) its
              // creation history as an HFSS-style indented chain. This
              // matches the way HFSS displays parts in its model tree:
              // a part's history is the recipe for building it.
              //
              // We classify components into top-level "objects":
              //   - boolean components (kind='boolean'): own row, with
              //     operands shown as nested children when expanded
              //   - group entries (scene.groups): own row, members nested
              //   - free primitive components (no consumedBy, no group):
              //     own row, with their CreateBox + transforms history
              //   - consumed operands (consumedBy != null) only appear
              //     inside their owning boolean's nested view
              //   - grouped components only appear inside their group
              //
              // The tree handles arbitrary nesting of booleans-of-booleans
              // since operands are referenced by id and rendered through
              // the same node renderer recursively.

              // Map id → component for fast lookup during recursion.
              const byId = Object.fromEntries(scene.components.map(c => [c.id, c]));
              const groupNames = new Set(scene.groups.map(g => g.name));
              const groupedIds = new Set();
              for (const g of scene.groups) for (const id of g.memberIds) groupedIds.add(id);
              for (const c of scene.components) {
                if (c.group && groupNames.has(c.group)) groupedIds.add(c.id);
              }
              const groupMembers = (g) => {
                const ids = new Set(g.memberIds);
                for (const c of scene.components) {
                  if (c.group === g.name) ids.add(c.id);
                }
                return Array.from(ids);
              };
              const consumedIds = new Set();
              for (const c of scene.components) if (c.consumedBy) consumedIds.add(c.id);

              const handleClickComp = (c, e) => {
                if (e.metaKey || e.ctrlKey) {
                  const newIds = new Set(selectedIds);
                  if (newIds.has(c.id)) { newIds.delete(c.id); setSelection({ ids: newIds, primary: newIds.size > 0 ? Array.from(newIds).pop() : null }); }
                  else { newIds.add(c.id); setSelection({ ids: newIds, primary: c.id }); }
                } else if (e.shiftKey && selectedId) {
                  const order = scene.components.map(x => x.id);
                  const a = order.indexOf(selectedId), b = order.indexOf(c.id);
                  if (a >= 0 && b >= 0) {
                    const range = order.slice(Math.min(a, b), Math.max(a, b) + 1);
                    setSelection({ ids: new Set([...selectedIds, ...range]), primary: c.id });
                  }
                } else {
                  setSelection({ ids: new Set([c.id]), primary: c.id });
                }
              };

              // Format a single transform entry as a compact HFSS-style
              // operation string. Used in the per-object history view.
              const formatTransform = (t) => {
                const dis = t.enabled === false ? ' [off]' : '';
                if (t.kind === 'displace') return `Move(dx=${t.dx ?? '0'}, dy=${t.dy ?? '0'})${dis}`;
                if (t.kind === 'rotate') return `Rotate(${t.angle ?? '0'}°, ${t.pivot || 'C'})${dis}`;
                if (t.kind === 'repeat') return `Duplicate(N=${t.n ?? '0'}, dx=${t.dx ?? '0'}, dy=${t.dy ?? '0'})${dis}`;
                return `${t.kind}${dis}`;
              };

              // Color accent for the operation kind. Booleans inherit their
              // op color; primitives use a neutral cyan; groups use slate.
              const accentFor = (c) => {
                if (c?.kind === 'boolean') {
                  return c.op === 'union' ? '#10b981'
                    : c.op === 'intersect' ? '#22d3ee'
                    : '#f59e0b';
                }
                return '#0ea5e9';
              };

              // The recursive object node renderer. Renders a row for the
              // object plus (when expanded) its history sub-tree.
              const renderObject = (c, depth) => {
                const isBoolean = c.kind === 'boolean';
                const isExpanded = expandedTreeNodes.has(c.id);
                const isSelected = selectedIds.has(c.id);
                const accent = accentFor(c);
                const indent = depth * 12;
                // Quick textual summary of the creation method (the LAST
                // step in HFSS terms — the "leaf" of the history). Shown
                // collapsed so the user can read the kind at a glance.
                const headerSummary = isBoolean
                  ? `${c.op === 'union' ? 'Unite' : c.op === 'intersect' ? 'Intersect' : 'Subtract'}(${(c.operandIds || []).join(', ')})`
                  : `Box(w=${c.w}, h=${c.h})`;
                return (
                  <div key={c.id}>
                    <div
                      onClick={(e) => handleClickComp(c, e)}
                      className={`flex items-center gap-1 py-0.5 cursor-pointer rounded text-xs ${isSelected ? 'bg-cyan-900/30 ring-1 ring-cyan-400' : 'hover:bg-slate-800'}`}
                      style={{ paddingLeft: 4 + indent }}
                    >
                      <button
                        onClick={(e) => { e.stopPropagation(); toggleTreeNode(c.id); }}
                        className="w-3 h-3 flex items-center justify-center text-slate-500 hover:text-slate-200 flex-shrink-0"
                        title={isExpanded ? 'Collapse history' : 'Expand history'}
                      >
                        {isExpanded ? '▾' : '▸'}
                      </button>
                      <span className="font-mono font-bold text-[11px] truncate flex-shrink-0" style={{ color: accent }}>
                        {c.id}
                      </span>
                      {isBoolean && (
                        <span className="text-[9px] uppercase font-bold tracking-wider flex-shrink-0" style={{ color: accent + 'cc' }}>
                          {c.op}
                        </span>
                      )}
                      <span className="px-1 py-0 rounded text-[9px] font-mono flex-shrink-0" style={{ background: layerSwatches[c.layer]?.bg, color: layerSwatches[c.layer]?.fg }}>
                        {c.layer}
                      </span>
                      <span className="flex-1" />
                      {isBoolean ? (
                        <button onClick={(e) => { e.stopPropagation(); deleteBoolean(c.id); }} className="text-slate-500 hover:text-red-400 flex-shrink-0" title="Delete this derived component (operands are released)">
                          <Trash2 size={10} />
                        </button>
                      ) : (
                        <button onClick={(e) => { e.stopPropagation(); deleteComp(c.id); }} className="text-slate-500 hover:text-red-400 flex-shrink-0" title="Delete this component">
                          <Trash2 size={10} />
                        </button>
                      )}
                    </div>
                    {isExpanded && (
                      <div className="text-[9px] font-mono leading-tight" style={{ paddingLeft: 4 + indent + 12 }}>
                        {/* For booleans: nested operand sub-trees come FIRST
                            (they're prerequisites in HFSS history order). */}
                        {isBoolean && (c.operandIds || []).map(opid => {
                          const opC = byId[opid];
                          if (!opC) return (
                            <div key={opid} className="text-slate-600 italic">missing operand: {opid}</div>
                          );
                          return renderObject(opC, depth + 1);
                        })}
                        {/* The creation step itself: CreateBox or Unite/etc. */}
                        <div className="text-slate-400 py-0.5" style={{ paddingLeft: isBoolean ? 0 : 0 }}>
                          <span className="text-slate-600">└─</span> {headerSummary}
                        </div>
                        {/* Object-level transforms applied AFTER creation,
                            in chain order. These map 1:1 to HFSS Move /
                            Rotate / Duplicate calls in the export. */}
                        {(c.transforms || []).map((t, i) => (
                          <div key={t.id || i} className="text-slate-400 py-0.5">
                            <span className="text-slate-600">└─</span> {formatTransform(t)}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              };

              // Top-level objects = groups + boolean components + free
              // primitives (those without consumedBy and without group).
              const topPrimitives = scene.components.filter(c =>
                c.kind !== 'boolean' &&
                !groupedIds.has(c.id) &&
                !consumedIds.has(c.id)
              );
              const topBooleans = scene.components.filter(c =>
                c.kind === 'boolean' &&
                !groupedIds.has(c.id) &&
                !consumedIds.has(c.id)
              );

              return (
                <div className="space-y-1">
                  <div className="flex items-center gap-1.5 mb-2">
                    <button
                      onClick={createGroup}
                      disabled={selectedIds.size === 0}
                      className="flex-1 flex items-center justify-center gap-1 px-2 py-1 rounded text-[10px] border border-dashed border-slate-600 hover:border-cyan-400 disabled:opacity-30 disabled:cursor-not-allowed text-slate-300"
                      title={selectedIds.size === 0 ? 'Select shapes first' : `Group ${selectedIds.size}`}
                    >
                      <FolderTree size={10} /> group
                    </button>
                    <button
                      onClick={() => createBoolean('union')}
                      disabled={selectedIds.size < 2}
                      className="flex items-center gap-1 px-2 py-1 rounded text-[10px] border border-emerald-700 hover:border-emerald-500 disabled:opacity-30 text-emerald-300"
                      title={selectedIds.size < 2 ? 'Select 2+' : 'Union (+)'}
                    >
                      <Combine size={10} /> ∪
                    </button>
                    <button
                      onClick={() => createBoolean('intersect')}
                      disabled={selectedIds.size < 2}
                      className="flex items-center gap-1 px-2 py-1 rounded text-[10px] border border-cyan-700 hover:border-cyan-500 disabled:opacity-30 text-cyan-300"
                      title={selectedIds.size < 2 ? 'Select 2+' : 'Intersect'}
                    >
                      <XIcon size={10} /> ∩
                    </button>
                    <button
                      onClick={() => createBoolean('subtract')}
                      disabled={selectedIds.size < 2}
                      className="flex items-center gap-1 px-2 py-1 rounded text-[10px] border border-amber-700 hover:border-amber-500 disabled:opacity-30 text-amber-300"
                      title={selectedIds.size < 2 ? 'Select 2+' : 'Subtract first − rest (−)'}
                    >
                      <Minus size={10} /> −
                    </button>
                  </div>

                  {/* Groups — keep using the existing GroupTreeItem since
                      groups are a separate side-list with their own UI. */}
                  {scene.groups.map(g => (
                    <GroupTreeItem
                      key={g.id}
                      group={{ ...g, memberIds: groupMembers(g) }}
                      components={scene.components}
                      params={scene.params}
                      selectedIds={selectedIds}
                      onSelectGroup={() => selectGroup(g.id)}
                      onDissolve={() => dissolveGroup(g.id)}
                      onDelete={() => deleteGroup(g.id)}
                      onRename={(newName) => renameGroup(g.id, newName)}
                      renderCompRow={(c) => renderObject(c, 1)}
                    />
                  ))}

                  {/* Boolean (derived) objects */}
                  {topBooleans.map(c => renderObject(c, 0))}

                  {/* Free primitive objects */}
                  {topPrimitives.map(c => renderObject(c, 0))}

                  {scene.components.length === 0 && (
                    <p className="text-xs text-slate-500 italic px-1 mt-2">
                      No shapes yet. Use the toolbar's <span className="text-cyan-300">+ WG</span> / <span className="text-cyan-300">+ EL</span> buttons to add primitives. Select 2+ shapes and use the boolean buttons above to create derived objects.
                    </p>
                  )}
                </div>
              );
            })()}

            {activePanel === 'snaps' && (
              <div className="space-y-1">
                <p className="text-[10px] text-slate-500 italic px-1">Snaps form a graph; the root component is freely positioned, the rest follow.</p>
                {scene.snaps.map(s => (
                  <div key={s.id} className="p-2 rounded text-xs border border-slate-700" style={{ background: '#1e293b' }}>
                    <div className="flex items-center justify-between mb-1">
                      <span className="font-mono text-[10px] text-cyan-300 truncate">{s.from.compId}.{s.from.anchor} → {s.to.compId}.{s.to.anchor}</span>
                      <button onClick={() => deleteSnap(s.id)} className="text-slate-500 hover:text-red-400"><Link2Off size={11} /></button>
                    </div>
                    <div className="grid grid-cols-2 gap-1 mt-1">
                      <div>
                        <label className="text-[9px] text-slate-500">dx</label>
                        <DeferredTextInput value={s.dx} onCommit={(v) => updateSnap(s.id, { dx: v })} className="w-full bg-slate-900 border border-slate-700 rounded px-1 py-0.5 text-[10px] font-mono text-white outline-none focus:border-cyan-400" />
                      </div>
                      <div>
                        <label className="text-[9px] text-slate-500">dy</label>
                        <DeferredTextInput value={s.dy} onCommit={(v) => updateSnap(s.id, { dy: v })} className="w-full bg-slate-900 border border-slate-700 rounded px-1 py-0.5 text-[10px] font-mono text-white outline-none focus:border-cyan-400" />
                      </div>
                    </div>
                  </div>
                ))}
                {scene.snaps.length === 0 && <p className="text-xs text-slate-500 italic">No snaps.</p>}
              </div>
            )}

            {activePanel === 'mirrors' && (
              <div className="space-y-1">
                <p className="text-[10px] text-slate-500 italic px-1 mb-2">Select a shape, then Mirror H / V. Toggle the lock to break symmetry.</p>
                {scene.mirrors.map(m => (
                  <div key={m.id} className="p-2 rounded text-xs border border-slate-700" style={{ background: '#1e293b' }}>
                    <div className="flex items-center justify-between mb-1">
                      <span className="font-mono text-[10px] text-violet-300">{m.axis} @ {m.axisCoord}</span>
                      <button onClick={() => deleteMirror(m.id)} className="text-slate-500 hover:text-red-400"><Trash2 size={11} /></button>
                    </div>
                    {m.members.map((mm, i) => (
                      <div key={i} className="flex items-center justify-between gap-1 text-[10px] py-0.5">
                        <span className="font-mono text-slate-300 truncate">{mm.srcId} ↔ {mm.mirrorId}</span>
                        <button onClick={() => toggleMirrorLock(m.id, i)} className={mm.locked ? 'text-emerald-400' : 'text-amber-400'}>
                          {mm.locked ? <Lock size={10} /> : <Unlock size={10} />}
                        </button>
                      </div>
                    ))}
                  </div>
                ))}
                {scene.mirrors.length === 0 && <p className="text-xs text-slate-500 italic">No mirrors yet.</p>}
              </div>
            )}


            {activePanel === 'library' && (
              <div className="space-y-2">
                <button
                  onClick={saveSelectionToLibrary}
                  disabled={selectedIds.size === 0}
                  className="w-full flex items-center justify-center gap-1 px-2 py-1 rounded text-xs border border-dashed border-slate-600 hover:border-cyan-400 disabled:opacity-30 disabled:cursor-not-allowed text-slate-300"
                  title={selectedIds.size === 0 ? 'Select components first' : `Save ${selectedIds.size} component${selectedIds.size === 1 ? '' : 's'} to library`}
                >
                  <Save size={11} /> save selection ({selectedIds.size})
                </button>
                {/* Library file I/O — separate from workspace export so users
                    can share library kits without dragging entire designs. */}
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={handleExportLibrary}
                    className="flex-1 flex items-center justify-center gap-1 px-2 py-1 rounded text-[10px] border border-slate-700 hover:border-slate-500 text-slate-300"
                    title="Download a JSON snapshot of this workspace's library (active + archive). Designs are NOT included."
                  >
                    <Download size={11} /> export library
                  </button>
                  <button
                    onClick={handleImportLibrary}
                    className="flex-1 flex items-center justify-center gap-1 px-2 py-1 rounded text-[10px] border border-slate-700 hover:border-slate-500 text-slate-300"
                    title="Load library items from a JSON file. Accepts both library exports and full workspace exports (designs are ignored)."
                  >
                    <Upload size={11} /> import library
                  </button>
                </div>
                <p className="text-[10px] text-slate-500 italic px-1 leading-snug">
                  Library items can be dropped into any design. Click <span className="text-cyan-300">insert</span> to drop at the viewport center.
                </p>

                {/* Built-in templates: a small set of parameterized
                    components shipped with the app, registered in
                    src/templates/index.js. Each entry knows how to drop
                    its own params + components into the current scene. */}
                <div className="border-t border-slate-800 pt-2 mt-2">
                  <p className="text-[10px] uppercase tracking-wider text-slate-500 px-1 mb-1">Built-in templates</p>
                  <div className="space-y-1">
                    {BUILTIN_TEMPLATES.map((t) => (
                      <div
                        key={t.id}
                        className="rounded border border-slate-800 px-2 py-1.5 flex items-center gap-2"
                        style={{ background: 'rgba(30,41,59,0.5)' }}
                      >
                        <Package size={11} className="text-cyan-400 flex-shrink-0" />
                        <div className="flex-1 min-w-0">
                          <p className="font-mono text-xs text-cyan-300 truncate">{t.name}</p>
                          <p className="text-[9px] text-slate-500 truncate">{t.description}</p>
                        </div>
                        <button
                          onClick={() => insertBuiltinTemplate(t)}
                          className="text-[10px] px-2 py-0.5 rounded border border-cyan-700 text-cyan-300 hover:bg-cyan-900/40"
                          title={t.description}
                        >
                          insert
                        </button>
                      </div>
                    ))}
                  </div>
                </div>

                {!showArchive && (
                  <>
                    {libraryItems.length === 0 && <p className="text-xs text-slate-500 italic px-1">Library is empty.</p>}
                    {libraryItems.map(name => (
                      <LibraryItemRow
                        key={name}
                        name={name}
                        onInsert={() => insertLibraryItem(name)}
                        onArchive={() => archiveLibraryEntry(name)}
                        onRename={(newName) => renameLibraryEntry(name, newName)}
                        onCodify={() => codifyLibraryItem(name)}
                      />
                    ))}
                  </>
                )}

                {/* Archive toggle */}
                <button
                  onClick={() => setShowArchive(s => !s)}
                  className="w-full flex items-center justify-center gap-1 px-2 py-1.5 mt-2 rounded text-[10px] border border-slate-700 hover:border-slate-500 text-slate-400"
                  title="Show archived items"
                >
                  <Boxes size={11} />
                  {showArchive ? 'hide' : 'show'} archive ({archivedLibraryItems.length})
                </button>

                {showArchive && (
                  <div className="space-y-1">
                    {archivedLibraryItems.length === 0 && <p className="text-xs text-slate-500 italic px-1">Archive is empty.</p>}
                    {archivedLibraryItems.map(name => (
                      <div key={name} className="rounded border border-slate-800 px-2 py-1.5 flex items-center gap-2" style={{ background: 'rgba(30,41,59,0.5)' }}>
                        <Package size={11} className="text-slate-500 flex-shrink-0" />
                        <span className="font-mono text-xs text-slate-400 flex-1 truncate">{name}</span>
                        <button onClick={() => restoreLibraryEntry(name)} className="text-[10px] px-2 py-0.5 rounded border border-slate-600 text-slate-300 hover:bg-slate-800" title="Restore to active library">
                          restore
                        </button>
                        <button onClick={() => deleteArchivedEntry(name)} className="text-slate-500 hover:text-red-400" title="Delete forever">
                          <Trash2 size={10} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {activePanel === 'code' && (
              <pre className="text-[9px] font-mono leading-relaxed text-slate-300 whitespace-pre-wrap break-all">{code}</pre>
            )}
          </div>
        </div>

        {/* CENTER */}
        <div className="flex-1 relative">
          <Canvas
            scene={scene}
            updateScene={updateScene}
            selectedId={selectedId}
            selectedIds={selectedIds}
            setSelection={setSelection}
            viewport={viewport}
            setViewport={setViewport}
            snapMode={snapMode}
            setSnapMode={setSnapMode}
            gridSize={gridSize}
            gridSnapEnabled={gridSnapEnabled}
            paramValues={paramValues}
            addParam={addParam}
            updateParamExpr={(name, expr) => updateParam(name, { expr })}
            rulerMode={rulerMode}
            setRulerMode={setRulerMode}
            rulerMeasurements={rulerMeasurements}
            setRulerMeasurements={setRulerMeasurements}
            rulerInProgress={rulerInProgress}
            setRulerInProgress={setRulerInProgress}
            rulerSnapPoint={rulerSnapPoint}
            setRulerSnapPoint={setRulerSnapPoint}
            alertDialog={alertDialog}
            setInteractionStatus={setInteractionStatus}
            showDimensions={showDimensions}
            addMode={addMode}
            setAddMode={setAddMode}
            commitDragAdd={commitDragAdd}
            onComponentContextMenu={openComponentContextMenu}
          />
          <div className="absolute top-2 left-2 px-2 py-1 rounded text-[10px] font-mono pointer-events-none" style={{ background: 'rgba(15,23,42,0.85)', color: '#e2e8f0' }}>
            wheel = zoom · drag = pan/move · ⌥/Alt+drag = marquee · ⌘+click = toggle · ⌘+drag = no grid · F = fit · ⌘Z/⇧Z = undo/redo · ⌘C/V = copy/paste · ⌘S = save
          </div>
          <div className="absolute bottom-2 left-2 flex flex-wrap gap-x-3 gap-y-1 text-[10px] font-mono max-w-[60%]" style={{ color: '#475569' }}>
            <div className="flex items-center gap-1.5"><div className="w-3 h-3 rounded-sm" style={{ background: '#3ec27a' }} />wg</div>
            <div className="flex items-center gap-1.5"><div className="w-3 h-3 rounded-sm" style={{ background: '#f4a72e' }} />electrode</div>
            <div className="flex items-center gap-1.5"><div className="w-3 h-3 border-2 border-sky-400" />selected</div>
            <div className="flex items-center gap-1.5"><div className="w-3 h-3 border border-sky-400 border-dashed" />snap-related</div>
            <div className="flex items-center gap-1.5"><div className="w-3 h-3 border border-violet-400 border-dashed" />mirror-related</div>
          </div>
          {/* Live snap/ruler/add status — kept off-canvas so the preview line and
              anchor points stay visible. Color-coded: amber=snap, cyan=ruler, green=add. */}
          {interactionStatus && (() => {
            const palette = {
              ruler: { fg: '#67e8f9', bd: '#22d3ee' },
              add:   { fg: '#86efac', bd: '#22c55e' },
              snap:  { fg: '#fbbf24', bd: '#f59e0b' },
            };
            const p = palette[interactionStatus.kind] || palette.snap;
            return (
              <div
                className="absolute bottom-2 right-2 px-2 py-1 rounded text-[11px] font-mono pointer-events-none"
                style={{
                  background: 'rgba(15,23,42,0.92)',
                  color: p.fg,
                  border: `1px solid ${p.bd}`,
                }}
              >
                {interactionStatus.line}
              </div>
            );
          })()}
        </div>

        {/* RIGHT — Inspector */}
        <div className="w-72 border-l border-slate-700 flex flex-col" style={{ background: '#0f172a' }}>
          <div className="px-3 py-2 border-b border-slate-700 text-xs font-medium uppercase tracking-wider text-slate-400 flex items-center justify-between">
            <span>Inspector{selectedIds.size > 1 ? ` · ${selectedIds.size} selected` : ''}</span>
            {selectedIds.size > 0 && (
              <button
                onClick={deleteSelected}
                className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium normal-case bg-red-900/40 hover:bg-red-700 text-red-200 hover:text-white transition-colors"
                title="Delete (Del / Backspace)"
              >
                <Trash2 size={10} /> delete{selectedIds.size > 1 ? ` (${selectedIds.size})` : ''}
              </button>
            )}
          </div>
          <div className="flex-1 overflow-y-auto p-3">
            {selectedIds.size === 0 && <p className="text-xs text-slate-500 italic">Click a component to inspect, or ⌥/Alt+drag to marquee-select multiple.</p>}
            {selectedIds.size > 1 && (
              <div className="mb-3 p-2 rounded border border-cyan-700 bg-cyan-900/20 text-xs">
                <p className="text-cyan-300 font-medium mb-1">{selectedIds.size} components selected</p>
                <p className="text-[10px] text-slate-400 leading-snug">Showing details for primary: <span className="font-mono text-cyan-300">{selectedId}</span></p>
                <div className="mt-2 max-h-24 overflow-y-auto text-[10px] space-y-0.5">
                  {Array.from(selectedIds).map(id => (
                    <button
                      key={id}
                      onClick={() => setSelection({ ids: selectedIds, primary: id })}
                      className={`block w-full text-left font-mono px-1 py-0.5 rounded hover:bg-slate-800 ${id === selectedId ? 'text-cyan-300' : 'text-slate-400'}`}
                    >
                      {id === selectedId ? '● ' : '  '}{id}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {selected && (
              <div className="space-y-3">
                <div>
                  <label className="text-[10px] uppercase tracking-wider text-slate-500">ID</label>
                  <DeferredTextInput value={selected.id} onCommit={(newId) => {
                    if (!newId || scene.components.some(c => c.id === newId && c.id !== selected.id)) return;
                    updateScene(prev => ({
                      ...prev,
                      components: prev.components.map(c => c.id === selected.id ? { ...c, id: newId } : c),
                      snaps: prev.snaps.map(s => ({
                        ...s,
                        from: s.from.compId === selected.id ? { ...s.from, compId: newId } : s.from,
                        to: s.to.compId === selected.id ? { ...s.to, compId: newId } : s.to,
                      })),
                    }));
                    const newSet = new Set(selectedIds);
                    newSet.delete(selected.id);
                    newSet.add(newId);
                    setSelection({ ids: newSet, primary: newId });
                  }} className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs font-mono text-cyan-300 outline-none focus:border-cyan-400" />
                </div>
                <div>
                  <label className="text-[10px] uppercase tracking-wider text-slate-500">Layer</label>
                  <select value={selected.layer} onChange={(e) => updateComp(selected.id, { layer: e.target.value })} className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs text-white outline-none">
                    <option value="waveguide">waveguide</option>
                    <option value="electrode">electrode</option>
                    <option value="port">port</option>
                  </select>
                </div>
                {selected.kind === 'boolean' ? (
                  // Derived boolean component: no editable w/h (geometry is
                  // determined by operands + boolean op). Show op + operands
                  // as a derivation summary; cx/cy is the result's anchor.
                  <div className="border border-slate-700 rounded p-2" style={{ background: 'rgba(15,23,42,0.5)' }}>
                    <div className="flex items-center gap-1 mb-1">
                      <span className="text-[10px] font-bold uppercase tracking-wider" style={{
                        color: selected.op === 'union' ? '#10b981' : (selected.op === 'intersect' ? '#22d3ee' : '#f59e0b'),
                      }}>derived · {selected.op}</span>
                    </div>
                    <p className="text-[10px] text-slate-400 font-mono leading-snug">
                      {selected.op === 'subtract'
                        ? <>{(selected.operandIds || [])[0]}{(selected.operandIds || []).slice(1).map((id, i) => <span key={i}> − {id}</span>)}</>
                        : (selected.operandIds || []).join(selected.op === 'union' ? ' + ' : ' ∩ ')}
                    </p>
                    <p className="text-[9px] text-slate-500 mt-1 italic">
                      Operands were consumed when this component was created (HFSS-style). They no longer appear in SHAPES. Delete this component to release them.
                    </p>
                  </div>
                ) : (
                  // Shape-specific primary parameter editors. For rectangles
                  // we expose w and h. For circles, only the radius r (w and
                  // h are derived as 2*r). For ellipses, rx and ry. For
                  // regular polygons, the circumradius r and side count n.
                  // The AABB w/h fields are intentionally hidden for non-rect
                  // shapes — they're derived from the primary parameters and
                  // editing them directly would break the parametric link.
                  (() => {
                    const shapeKind = selected.kind || 'rect';
                    const fieldRow = (key, label, value, onChange, parse = null) => (
                      <div>
                        <label className="text-[10px] uppercase tracking-wider text-slate-500">{label}</label>
                        <DeferredTextInput
                          value={value}
                          onCommit={(v) => {
                            onChange(v);
                            commitExpr(v, '1', 'µm', `Auto-created (${selected.id}.${key})`);
                          }}
                          className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs font-mono text-white outline-none focus:border-cyan-400"
                        />
                        <p className="text-[9px] text-slate-500 mt-0.5 font-mono">= {(() => {
                          const v = evalExpr(value, paramValues);
                          return Number.isFinite(v) ? (parse ? parse(v) : v.toFixed(2)) : '—';
                        })()}</p>
                      </div>
                    );
                    if (shapeKind === 'circle') {
                      return (
                        <div className="grid grid-cols-2 gap-2">
                          {fieldRow('r', 'r (radius)', selected.r ?? '0', (v) => updateComp(selected.id, { r: v }))}
                        </div>
                      );
                    }
                    if (shapeKind === 'ellipse') {
                      return (
                        <div className="grid grid-cols-2 gap-2">
                          {fieldRow('rx', 'rx', selected.rx ?? '0', (v) => updateComp(selected.id, { rx: v }))}
                          {fieldRow('ry', 'ry', selected.ry ?? '0', (v) => updateComp(selected.id, { ry: v }))}
                        </div>
                      );
                    }
                    if (shapeKind === 'polygon') {
                      return (
                        <div className="grid grid-cols-2 gap-2">
                          {fieldRow('r', 'r (circumradius)', selected.r ?? '0', (v) => updateComp(selected.id, { r: v }))}
                          {fieldRow('n', 'n (sides)', selected.n ?? '6', (v) => updateComp(selected.id, { n: v }), (v) => Math.max(3, Math.round(v)).toString())}
                        </div>
                      );
                    }
                    if (shapeKind === 'racetrack') {
                      // Racetrack: show the three geometry parameters
                      // (min curvature radius R, straight length, Euler
                      // split p) plus the waveguide cross-section width.
                      // The AABB w/h are derived (over-approximation via
                      // linear-in-p fit) and not user-editable here.
                      return (
                        <div className="grid grid-cols-2 gap-2">
                          {fieldRow('R', 'R (min radius)', selected.R ?? '100', (v) => updateComp(selected.id, { R: v }))}
                          {fieldRow('L_straight', 'L_straight', selected.L_straight ?? '300', (v) => updateComp(selected.id, { L_straight: v }))}
                          {fieldRow('p', 'p (Euler 0–1)', selected.p ?? '1', (v) => updateComp(selected.id, { p: v }), (v) => Math.max(0, Math.min(1, v)).toFixed(3))}
                          {fieldRow('wgWidth', 'wg width', selected.wgWidth ?? 'w_wg', (v) => updateComp(selected.id, { wgWidth: v }))}
                        </div>
                      );
                    }
                    // Default: rectangle.
                    return (
                      <div className="grid grid-cols-2 gap-2">
                        {fieldRow('w', 'w', selected.w, (v) => updateComp(selected.id, { w: v }))}
                        {fieldRow('h', 'h', selected.h, (v) => updateComp(selected.id, { h: v }))}
                      </div>
                    );
                  })()
                )}
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-[10px] uppercase tracking-wider text-slate-500">cx ({selectedHasIncoming ? 'solved' : 'free'})</label>
                    <DeferredTextInput type="number" step="0.5" numeric value={selected.cx?.toFixed?.(2) ?? selected.cx} disabled={selectedHasIncoming} onCommit={(v) => updateComp(selected.id, { cx: v })} className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs font-mono text-white outline-none focus:border-cyan-400 disabled:opacity-50" />
                  </div>
                  <div>
                    <label className="text-[10px] uppercase tracking-wider text-slate-500">cy ({selectedHasIncoming ? 'solved' : 'free'})</label>
                    <DeferredTextInput type="number" step="0.5" numeric value={selected.cy?.toFixed?.(2) ?? selected.cy} disabled={selectedHasIncoming} onCommit={(v) => updateComp(selected.id, { cy: v })} className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs font-mono text-white outline-none focus:border-cyan-400 disabled:opacity-50" />
                  </div>
                </div>

                <TransformChainEditor
                  component={selected}
                  onUpdateComp={(patch) => updateComp(selected.id, patch)}
                  paramValues={paramValues}
                  commitExpr={commitExpr}
                />

                {/* Connections — show all snaps and mirrors involving this component */}
                {(() => {
                  const incoming = scene.snaps.filter(s => s.to.compId === selected.id);
                  const outgoing = scene.snaps.filter(s => s.from.compId === selected.id);
                  const mirrorMems = scene.mirrors.flatMap(m =>
                    m.members
                      .filter(mm => mm.srcId === selected.id || mm.mirrorId === selected.id)
                      .map(mm => ({ mirror: m, member: mm, role: mm.srcId === selected.id ? 'source' : 'mirror' }))
                  );
                  if (!incoming.length && !outgoing.length && !mirrorMems.length) {
                    return (
                      <div className="border-t border-slate-700 pt-3">
                        <span className="text-[10px] uppercase tracking-wider text-slate-500">Connections</span>
                        <p className="text-[10px] text-slate-500 italic mt-1">None — this component is freestanding.</p>
                      </div>
                    );
                  }
                  return (
                    <div className="border-t border-slate-700 pt-3 space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[10px] uppercase tracking-wider text-slate-500">Connections</span>
                        {(incoming.length > 0 || outgoing.length > 0) && (
                          <button
                            onClick={() => reRootSnapChain(selected.id)}
                            className="text-[9px] px-1.5 py-0.5 rounded border border-slate-600 hover:border-cyan-500 hover:text-cyan-300 text-slate-400"
                            title={`Re-root the snap chain at "${selected.id}". All snaps connected to this component (and onward through the chain) are flipped so this component becomes the parent. Useful when you want to drag this piece and have everything else follow.`}
                          >
                            ⇄ make root
                          </button>
                        )}
                      </div>
                      {incoming.length > 0 && (
                        <div>
                          <p className="text-[9px] uppercase tracking-wider text-slate-600 mb-0.5">snapped to (parent)</p>
                          {incoming.map(s => (
                            <SnapConnectionRow
                              key={s.id}
                              snap={s}
                              direction="incoming"
                              params={scene.params}
                              paramValues={paramValues}
                              onSelectOther={(id) => setSelection({ ids: new Set([id]), primary: id })}
                              onUpdateSnap={(patch) => updateSnap(s.id, patch)}
                              onUpdateParam={(name, expr) => updateParam(name, { expr })}
                              onPromoteAxis={(axis) => promoteSnapAxis(s.id, axis)}
                              onDeleteSnap={() => deleteSnap(s.id)}
                              commitExpr={commitExpr}
                            />
                          ))}
                        </div>
                      )}
                      {outgoing.length > 0 && (
                        <div>
                          <p className="text-[9px] uppercase tracking-wider text-slate-600 mb-0.5">parent of (children)</p>
                          {outgoing.map(s => (
                            <SnapConnectionRow
                              key={s.id}
                              snap={s}
                              direction="outgoing"
                              params={scene.params}
                              paramValues={paramValues}
                              onSelectOther={(id) => setSelection({ ids: new Set([id]), primary: id })}
                              onUpdateSnap={(patch) => updateSnap(s.id, patch)}
                              onUpdateParam={(name, expr) => updateParam(name, { expr })}
                              onPromoteAxis={(axis) => promoteSnapAxis(s.id, axis)}
                              onDeleteSnap={() => deleteSnap(s.id)}
                              commitExpr={commitExpr}
                            />
                          ))}
                        </div>
                      )}
                      {mirrorMems.length > 0 && (
                        <div>
                          <p className="text-[9px] uppercase tracking-wider text-slate-600 mb-0.5">mirror group</p>
                          {mirrorMems.map((mm, i) => {
                            const otherId = mm.role === 'source' ? mm.member.mirrorId : mm.member.srcId;
                            return (
                              <div key={i} className="flex items-center gap-1 text-[10px] py-0.5">
                                <FlipHorizontal size={10} className="text-violet-400" />
                                <button onClick={() => setSelection({ ids: new Set([otherId]), primary: otherId })} className="font-mono text-violet-300 hover:text-violet-100 truncate">{otherId}</button>
                                <span className="text-slate-500">({mm.mirror.axis}, {mm.role})</span>
                                <button onClick={() => toggleMirrorLock(mm.mirror.id, mm.mirror.members.indexOf(mm.member))} className={`ml-auto ${mm.member.locked ? 'text-emerald-400' : 'text-amber-400'}`} title={mm.member.locked ? 'locked (click to unlock)' : 'unlocked (click to lock)'}>
                                  {mm.member.locked ? <Lock size={10} /> : <Unlock size={10} />}
                                </button>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })()}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Right-click context menu (rendered as a fixed-positioned overlay) */}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenu.items}
          onClose={() => setContextMenu(null)}
        />
      )}

      {/* Modal dialog (confirm/prompt/alert) */}
      <ModalDialog
        open={!!dialog}
        title={dialog?.title}
        message={dialog?.message}
        defaultValue={dialog?.defaultValue}
        kind={dialog?.kind}
        onConfirm={dialog?.onConfirm}
        onCancel={dialog?.onCancel}
      />

      {/* Export preview modal — shows the generated pyAEDT script with copy/download */}
      {exportPreview && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          style={{ background: 'rgba(2,6,23,0.7)' }}
          onClick={() => setExportPreview(null)}
        >
          <div
            className="rounded-lg border border-slate-700 shadow-2xl flex flex-col"
            style={{ background: '#0f172a', width: 'min(900px, 92vw)', height: 'min(80vh, 700px)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-4 py-2 border-b border-slate-700 flex items-center justify-between">
              <div>
                <h3 className="text-sm font-medium text-slate-200">Export — {exportPreview.filename}</h3>
                <p className="text-[10px] text-slate-500 mt-0.5">
                  {exportPreview.downloaded
                    ? 'Download triggered. If your browser blocked it, copy the script below.'
                    : 'Download blocked by sandbox. Copy the script below and paste into your editor.'}
                </p>
              </div>
              <button onClick={() => setExportPreview(null)} className="text-slate-500 hover:text-slate-200 text-xs">✕</button>
            </div>
            <div className="flex-1 overflow-auto p-3">
              <pre className="text-[11px] font-mono leading-relaxed text-slate-200 whitespace-pre-wrap break-all">{exportPreview.content}</pre>
            </div>
            <div className="px-4 py-3 border-t border-slate-700 flex justify-end gap-2">
              <button
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(exportPreview.content);
                    setExportPreview(p => p ? { ...p, justCopied: true } : p);
                    setTimeout(() => setExportPreview(p => p ? { ...p, justCopied: false } : p), 1500);
                  } catch (e) {
                    // Fallback: select all in the pre and let user Cmd+C
                    const pre = document.querySelector('.export-preview-pre');
                    if (pre) {
                      const range = document.createRange();
                      range.selectNodeContents(pre);
                      const sel = window.getSelection();
                      sel.removeAllRanges();
                      sel.addRange(range);
                    }
                  }
                }}
                className="px-3 py-1 rounded text-xs font-medium"
                style={{ background: '#06b6d4', color: '#0f172a' }}
              >
                {exportPreview.justCopied ? '✓ Copied' : 'Copy to clipboard'}
              </button>
              <button
                onClick={() => downloadFile(exportPreview.filename, exportPreview.content)}
                className="px-3 py-1 rounded text-xs border border-slate-600 text-slate-300 hover:bg-slate-800"
              >
                Try download again
              </button>
              <button
                onClick={() => setExportPreview(null)}
                className="px-3 py-1 rounded text-xs border border-slate-600 text-slate-300 hover:bg-slate-800"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
