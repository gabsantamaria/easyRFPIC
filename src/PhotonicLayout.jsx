import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { Plus, Trash2, RotateCcw, RotateCw, Download, Upload, Lock, Unlock, FlipHorizontal, FlipVertical, Layers, Settings2, Settings, Box, Square, Link2, Link2Off, Grid3x3, AlertTriangle, Maximize2, Save, FileText, FilePlus, Copy, FolderTree, BookOpen, Package, Boxes, Pencil, Ruler, Eye, EyeOff, ArrowDown, ArrowUp, Move, Repeat, Combine, Minus, X as XIcon, Circle, Hexagon, Radio, HelpCircle, Search, ChevronDown, ChevronRight, Sparkles } from 'lucide-react';
import { eulerBend180Centerline, buildRacetrackCenterline, offsetCenterlineToBand } from './geometry/racetrack.js';
import { tokenizeIdents, tokenizeComponentExprs, resolveParams, evalExpr, RESERVED_IDENTS } from './scene/params.js';
import { renameIdentInScene } from './scene/rename-ident.js';
import { ANCHORS, parseAnchor, anchorLocal, anchorWorld } from './scene/anchors.js';
import { rectInstanceToRing, shapeInstanceToRing } from './geometry/rings.js';
import { resolvePolylineVertices, polylineIsTapered, synthArc90 } from './geometry/polyline.js';
import { expandTransforms } from './scene/transforms.js';
import { detectPortIntegrationLine } from './scene/lumpedPort.js';
import { solveLayout, applyMirrors, resolveBooleanBboxes, validateSnapGraph } from './scene/solver.js';
import { generateGDS, viaGdsLayerMap } from './export/gds.js';
import { generatePyAEDT } from './export/pyaedt.js';
import { generateHfssNative } from './export/hfss-native.js';
import { generateQ3DCapacitance } from './export/q3d.js';
import { generateGdsfactory } from './export/gdsfactory.js';
import { generateSvgFromElement, generatePdfFromElement } from './export/figure.js';
import { defaultStack, normalizeScene, makeDefaultScene, makeBlankScene, paramsForStack, migrateStackCoplanarGroups } from './scene/schema.js';
import { buildDesignExport, designExportFilename } from './scene/design-file.js';
import {
  BASE_DESIGN_PREFIX, BASE_LIB_PREFIX, BASE_ARCHIVE_PREFIX, WORKSPACE_KEY,
  designPrefix, libPrefix, archivePrefix, activeDesignKey,
  listSavedDesigns, loadDesign, saveDesign, deleteDesignStored, describeSaveFailure,
  setActiveDesignName, getActiveDesignName,
  getStoredWorkspace, setStoredWorkspace, discoverWorkspaces,
  validateDesignName,
} from './storage/workspace.js';
import { makeVersion, sortedVersions, findVersionById } from './storage/versions.js';

// When a loaded payload's currentVersionId is missing / unknown (legacy
// payloads pre-versions, or designs where the pointer was cleared by a
// delete-version), fall back to the LATEST snapshot as the implicit
// default. New/empty designs (no versions yet) get null.
// Shared localStorage key used by the cross-tab copy/paste mechanism.
// All keys living under `photonic_layout:_*` are reserved internals
// (not designs, libraries, or workspaces) — see storage/workspace.js
// listing filter, which excludes them from SAVED DESIGNS.
const CLIPBOARD_STORAGE_KEY = 'photonic_layout:_clipboard';
// Magic marker embedded in clipboard payloads so a paste handler can
// distinguish "our JSON" from random stuff a user copied into the OS
// clipboard (e.g. plain text). Without this we'd risk parsing whatever
// happens to be in `navigator.clipboard.readText()` as a scene fragment.
const CLIPBOARD_KIND = 'easyRFPIC_clipboard_v1';

const resolveCurrentVersionId = (savedCurId, versions) => {
  const list = Array.isArray(versions) ? versions : [];
  // If we have an explicit pointer AND it still resolves to a real
  // version in this design, trust it.
  if (typeof savedCurId === 'string' && list.some(v => v && v.id === savedCurId)) {
    return savedCurId;
  }
  // Otherwise pick the most-recently-saved snapshot if any.
  const sorted = sortedVersions(list);
  return sorted.length > 0 ? sorted[0].id : null;
};
import {
  listLibraryItems, listArchivedLibraryItems,
  loadLibraryItem, loadArchivedLibraryItem,
  saveLibraryItem, saveArchivedLibraryItem,
  deleteLibraryItem, deleteArchivedLibraryItem,
  listCellDefs, loadCellDef, saveCellDef, deleteCellDef,
  exportWorkspace, importWorkspace,
  exportDesign, importDesign,
} from './storage/library-items.js';
import { makeCellFromSelection, instantiateCell, updateInstancesFromCell } from './scene/cells.js';
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
import { HelpTutorial } from './ui/HelpTutorial.jsx';
import { AiAssistantDialog } from './ui/AiAssistantDialog.jsx';
import { TwoLineWizard } from './ui/TwoLineWizard.jsx';
import { SettingsPanel } from './ui/SettingsPanel.jsx';
import { DEFAULT_SETTINGS, loadSettings, saveSettings, buildSettingsExport, parseSettingsImport } from './ui/settings.js';
import { resolveCanvasTheme, applyThemeAttr } from './ui/theme.js';
import { applyFragment as applyAiGeometryFragment } from './ai/assistant.js';
import { WorkspaceCreateRow, LibraryItemRow } from './ui/panels/LibraryPanelRows.jsx';
import { ParamRow } from './ui/panels/ParamRow.jsx';
import { SnapAxisField, SnapConnectionRow } from './ui/panels/SnapConnectionRow.jsx';
import { ExprField } from './ui/panels/ExprField.jsx';
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

// ── Pure helpers (module scope, exported for tests) ─────────────────────

// Cross-tab save notifications. One channel per page; posting never delivers
// to the posting tab itself. Guarded — BroadcastChannel is missing in some
// test/SSR environments.
const saveBroadcastChannel = (typeof BroadcastChannel !== 'undefined')
  ? new BroadcastChannel('photonic_layout')
  : null;

// C4: expand a selection to the full boolean-cluster move set, matching
// drag semantics (CLAUDE.md "Cluster drag"): a selected primitive that's
// consumed by a boolean moves its WHOLE cluster (walk consumedBy up to
// the topmost boolean, then recursively pull in every consumed operand).
// Punch tools (consumedBy !== boolean.id) stay independent, exactly like
// the canvas drag path. Returns a Set of component ids to translate.
export function collectNudgeCluster(components, ids) {
  const byId = Object.fromEntries(components.map(c => [c.id, c]));
  const moveSet = new Set();
  const visitedBooleans = new Set();
  const addCluster = (id) => {
    const c = byId[id];
    if (!c) return;
    if (c.kind === 'boolean') {
      if (visitedBooleans.has(id)) return;
      visitedBooleans.add(id);
      moveSet.add(id);
      for (const opid of (c.operandIds || [])) {
        const op = byId[opid];
        // Skip operands not actually consumed by this boolean (punch
        // keeps its tools independent — they shouldn't co-move).
        if (op && op.consumedBy === id) addCluster(opid);
      }
    } else {
      moveSet.add(id);
      // Walk consumedBy up to the topmost containing boolean and bring
      // the whole cluster along (drag parity).
      let cur = c, top = null;
      while (cur && cur.consumedBy) {
        const parent = byId[cur.consumedBy];
        if (!parent) break;
        top = parent;
        cur = parent;
      }
      if (top) addCluster(top.id);
    }
  };
  for (const id of ids) addCluster(id);
  return moveSet;
}

// C6: snaps to clone when duplicating the id-set `ids` (old → new ids in
// `idMap`). Three cases:
//   - INTERNAL (both endpoints inside): clone with both endpoints remapped.
//   - EXTERNAL INCOMING (from outside → to inside): clone with only the
//     'to' side remapped — the copy hangs off the SAME external parent,
//     which is safe (each copy is a distinct 'to' target).
//   - EXTERNAL OUTGOING (from inside → to outside): SKIP. Cloning would
//     create a second snap targeting the same external 'to' component —
//     a duplicate-to violation — so these are correctly dropped.
export function cloneSnapsForDuplicate(snaps, ids, idMap, makeSnapId) {
  const out = [];
  for (const s of snaps) {
    const fromIn = ids.has(s.from.compId);
    const toIn = ids.has(s.to.compId);
    if (!toIn) continue; // outside-only or external-outgoing → drop
    out.push({
      ...s,
      id: makeSnapId(),
      from: fromIn ? { ...s.from, compId: idMap[s.from.compId] } : { ...s.from },
      to: { ...s.to, compId: idMap[s.to.compId] },
    });
  }
  return out;
}

// C7: PARAMS-panel prefix grouping. Params sharing the prefix before the
// LAST underscore-delimited token (e.g. meander_h_1 → "meander_h") form a
// collapsible section when the group has >= minGroup members. Returns
// { sections: [{ prefix, names }], flat: [names] } — sections in order of
// first appearance, flat (ungrouped) names in original order.
export function groupParamPrefixes(names, minGroup = 4) {
  const byPrefix = new Map();
  for (const name of names) {
    const i = name.lastIndexOf('_');
    if (i <= 0) continue; // no underscore (or leading) → ungroupable
    const prefix = name.slice(0, i);
    if (!byPrefix.has(prefix)) byPrefix.set(prefix, []);
    byPrefix.get(prefix).push(name);
  }
  const grouped = new Set();
  const sections = [];
  for (const [prefix, members] of byPrefix) {
    if (members.length >= minGroup) {
      sections.push({ prefix, names: members });
      for (const n of members) grouped.add(n);
    }
  }
  const flat = names.filter(n => !grouped.has(n));
  return { sections, flat };
}

// =========================================================================
// MAIN APP
// =========================================================================
export default function App() {
  const [scene, setScene] = useState(makeDefaultScene);
  // On mount, ensure the active scene is normalized — older sessions may
  // have a scene that predates current normalizeScene rules. Use a
  // hash-based diff so we catch component-level migrations (e.g. punch
  // clones whose layer needs to be re-pointed at the base operand's
  // layer), not just stack changes.
  useEffect(() => {
    setScene(prev => {
      const next = normalizeScene(prev);
      // Deep-stringify is acceptable here — runs once on mount.
      if (JSON.stringify(next) !== JSON.stringify(prev)) return next;
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
  // C10: anchor flash — clicking a from/to anchor label in the SNAPS panel
  // or the inspector's Connections rows briefly highlights that anchor on
  // the canvas. The nonce bump retriggers the halo even for the same
  // compId/anchor pair (Canvas keys its timeout on flashAnchor.nonce).
  const [flashAnchor, setFlashAnchor] = useState(null); // { compId, anchor, nonce }
  const flashAnchorOnCanvas = useCallback((compId, anchor) => {
    setFlashAnchor(prev => ({ compId, anchor, nonce: (prev?.nonce || 0) + 1 }));
  }, []);
  const [activePanel, setActivePanel] = useState('params');
  // C7: PARAMS panel search + collapsible prefix groups (UI-only state).
  const [paramSearch, setParamSearch] = useState('');
  // Resizable PARAMS name column. Shared by every ParamRow and persisted
  // in localStorage (a tiny UI pref — kept out of design/workspace data).
  // Clamped to [48, 400] px; defaults to the old fixed width (80px).
  const PARAM_NAME_WIDTH_KEY = 'photonic_layout_param_name_width';
  const [paramNameWidth, setParamNameWidth] = useState(() => {
    try {
      const v = Number(window.localStorage?.getItem(PARAM_NAME_WIDTH_KEY));
      if (Number.isFinite(v) && v >= 48 && v <= 400) return v;
    } catch { /* ignore */ }
    return 80;
  });
  useEffect(() => {
    try { window.localStorage?.setItem(PARAM_NAME_WIDTH_KEY, String(paramNameWidth)); } catch { /* ignore */ }
  }, [paramNameWidth]);
  // Pointer-drag the name-column splitter. Any row's handle drives the
  // shared width, so the whole column resizes together.
  const startParamNameResize = useCallback((e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = paramNameWidth;
    const onMove = (ev) => {
      const w = Math.min(400, Math.max(48, startW + (ev.clientX - startX)));
      setParamNameWidth(w);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [paramNameWidth]);
  const [collapsedParamGroups, setCollapsedParamGroups] = useState(() => new Set());
  const toggleParamGroup = (prefix) => {
    setCollapsedParamGroups(prev => {
      const next = new Set(prev);
      if (next.has(prefix)) next.delete(prefix); else next.add(prefix);
      return next;
    });
  };
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
  // ── User settings (persisted; see src/ui/settings.js) ──────────────────
  // One serializable object holds the appearance theme + canvas view prefs.
  // These were previously separate, un-persisted useStates; folding them into
  // a single settings object adds persistence + JSON export/import via the
  // Settings panel. Derived consts + thin proxy setters below keep every
  // existing call site (setShowGrid, toggleEditDims, etc.) working unchanged.
  const [settings, setSettings] = useState(() => loadSettings());
  // Persist on every change. Runs on mount too, which establishes the storage
  // key and makes the legacy edit-dims migration (in loadSettings) stick.
  useEffect(() => { saveSettings(settings); }, [settings]);
  const updateSetting = useCallback((key, value) => {
    setSettings(prev => ({ ...prev, [key]: typeof value === 'function' ? value(prev[key]) : value }));
  }, []);
  const [showSettings, setShowSettings] = useState(false);
  // Apply the chrome theme — CSS does the recolor via the [data-theme] attr.
  useEffect(() => { applyThemeAttr(settings.theme); }, [settings.theme]);
  // Canvas surface palette (background/grid/axes) for the active theme.
  const canvasTheme = useMemo(() => resolveCanvasTheme(settings.theme), [settings.theme]);

  // Derived view-state. The canonical source of truth is `settings`.
  const gridSize = settings.gridSize;
  const gridSnapEnabled = settings.gridSnap;
  const showGrid = settings.gridVisible;            // grid visibility (independent of snap)
  const showDimensions = settings.showDimensionsOverlay;   // read-only dimension overlay (all parts)
  const editDims = settings.showDimensionsOnSelect;        // editable dims on the selected shape
  const setGridSize = (u) => updateSetting('gridSize', u);
  const setGridSnapEnabled = (u) => updateSetting('gridSnap', u);
  const setShowGrid = (u) => updateSetting('gridVisible', u);
  const setShowDimensions = (u) => updateSetting('showDimensionsOverlay', u);
  const toggleEditDims = () => updateSetting('showDimensionsOnSelect', v => !v);
  // Help / tutorial overlay. Opened from the "?" button in the header.
  const [showHelp, setShowHelp] = useState(false);
  // AI geometry assistant dialog (✨ header button): natural-language /
  // sketch input → Claude → validated parametric fragment insert.
  const [showAiAssistant, setShowAiAssistant] = useState(false);
  // 2-line method wizard (Marks 1991): stamp the line at two lengths and
  // emit a native HFSS script that extracts εeff/α in HFSS.
  const [showTwoLineWizard, setShowTwoLineWizard] = useState(false);
  // Reference to the canvas <svg> element. Used by the figure exporter
  // to clone the live DOM (so SVG/PDF figures include rulers, dimension
  // overlays, mirror axes, replications — everything the user sees on
  // the canvas at export time, not a reconstructed scene walk).
  const canvasSvgRef = useRef(null);
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
  // Current design's frozen version history. Lives in React state so
  // Save / Snapshot can mutate it without re-reading from storage,
  // and so the SAVED DESIGNS list can render version rows for the
  // active design directly. Other designs' versions are loaded on
  // demand when the user expands their row in the list (see
  // `versionsByDesign` cache below).
  const [versions, setVersions] = useState([]);
  // The version id the user is currently "based on": the latest
  // snapshot they loaded into the working state OR took. Persists
  // with the design so a re-open lands on the same version, not on
  // an ambiguous "tip of versions" guess. Null = the user hasn't
  // tied the working state to any specific snapshot yet (fresh
  // design, or pre-versions legacy load).
  const [currentVersionId, setCurrentVersionId] = useState(null);
  // Cache of versions + current-version-id for OTHER (non-active)
  // designs in the workspace. Populated lazily when the user expands
  // a design row. Keyed by design name; values: { versions, currentVersionId }.
  const [versionsByDesign, setVersionsByDesign] = useState({});
  // Which design rows in the SAVED DESIGNS list are currently expanded
  // to show their per-version sub-list. Pure UI state.
  const [expandedDesigns, setExpandedDesigns] = useState(new Set());
  // App-level clipboard: rich scene fragments (components + snaps + transforms
  // + cutouts + …). The in-memory React state is just a per-tab cache; the
  // canonical store is a localStorage entry (CLIPBOARD_STORAGE_KEY) so Copy
  // in one browser tab is visible to Paste in another. We also try to
  // mirror the JSON to the OS clipboard via navigator.clipboard.writeText,
  // which makes the rich payload paste-able into TextEdit / Slack / etc.
  // for backup — that call is best-effort (permission may be denied or
  // unavailable; we silently fall back to localStorage-only).
  const [clipboard, setClipboard] = useState(null); // { components, snaps }
  // Last cursor position over the canvas, in WORLD coords (updated on hover via
  // the Canvas onHoverWorld callback). Used so ⌘V pastes at the cursor. A ref
  // (not state) so the per-mousemove update never re-renders.
  const cursorWorldRef = useRef(null);
  // Listen for cross-tab Copy events. The browser fires `storage` on
  // EVERY other tab on the same origin when one tab writes to
  // localStorage. We watch the clipboard key and hydrate the in-memory
  // cache so paste is instantaneous (no async lookup needed). The
  // localStorage fallback in handlePaste handles the cold-start case
  // for tabs that were opened AFTER the most recent Copy.
  useEffect(() => {
    const onStorage = (e) => {
      if (e.key !== CLIPBOARD_STORAGE_KEY) return;
      if (!e.newValue) { setClipboard(null); return; }
      try {
        const parsed = JSON.parse(e.newValue);
        if (parsed && parsed._kind === CLIPBOARD_KIND && Array.isArray(parsed.components)) {
          setClipboard({ components: parsed.components, snaps: parsed.snaps || [], params: parsed.params || {} });
        }
      } catch { /* corrupt — leave existing cache alone */ }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);
  // Initial hydration on mount: if a previous tab's Copy is sitting in
  // localStorage already, prime the in-memory cache so the first
  // Paste in this tab is instant.
  useEffect(() => {
    // Prefer the synchronous localStorage entry (the cross-tab channel) so the
    // newest cross-tab Copy is primed immediately; fall back to the async IDB
    // mirror only when localStorage is disabled / empty.
    try {
      const t = window.localStorage.getItem(CLIPBOARD_STORAGE_KEY);
      if (t) {
        const parsed = JSON.parse(t);
        if (parsed && parsed._kind === CLIPBOARD_KIND && Array.isArray(parsed.components)) {
          setClipboard({ components: parsed.components, snaps: parsed.snaps || [], params: parsed.params || {} });
          return undefined;
        }
      }
    } catch { /* fall through to IDB */ }
    let cancelled = false;
    (async () => {
      try {
        const r = await window.storage.get(CLIPBOARD_STORAGE_KEY);
        if (cancelled || !r || typeof r.value !== 'string') return;
        const parsed = JSON.parse(r.value);
        if (parsed && parsed._kind === CLIPBOARD_KIND && Array.isArray(parsed.components)) {
          setClipboard({ components: parsed.components, snaps: parsed.snaps || [], params: parsed.params || {} });
        }
      } catch { /* nothing there or unreadable — fine */ }
    })();
    return () => { cancelled = true; };
  }, []);
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

  // ----- Multi-tab writer election (Web Locks) -----
  // Design payloads are whole-blob writes: two tabs on the same workspace
  // were last-writer-wins — a stale tab's 2s autosave silently erased the
  // other tab's snapshots. One tab per workspace now holds a session-long
  // Web Lock and is the WRITER; any other tab goes read-only (banner shown,
  // autosave / manual saves / flushes disabled) and automatically takes over
  // the moment the writer tab closes. Browsers without navigator.locks keep
  // the old behavior — the versions[] read-merge in saveDesign is the
  // belt-and-braces there.
  const [tabRole, setTabRole] = useState('writer');
  const tabRoleRef = useRef('writer');
  tabRoleRef.current = tabRole;
  useEffect(() => {
    if (typeof navigator === 'undefined' || !navigator.locks || !navigator.locks.request) {
      setTabRole('writer');
      return;
    }
    const controller = new AbortController();
    let releaseHeld = null;
    const lockName = `photonic_layout_ws_lock:${workspace || ''}`;
    const holdForSession = () => new Promise((resolve) => { releaseHeld = resolve; });
    navigator.locks.request(lockName, { ifAvailable: true, signal: controller.signal }, (lock) => {
      if (!lock) {
        // Another tab is the writer. Go read-only and QUEUE for the lock —
        // when that tab closes (or switches workspace) we take over live.
        setTabRole('readonly');
        navigator.locks.request(lockName, { signal: controller.signal }, () => {
          setTabRole('writer');
          return holdForSession();
        }).catch(() => { /* aborted on cleanup */ });
        return; // resolves the ifAvailable request without holding
      }
      setTabRole('writer');
      return holdForSession();
    }).catch(() => { /* aborted on cleanup */ });
    return () => {
      controller.abort();
      if (releaseHeld) releaseHeld();
      setTabRole('writer'); // optimistic until the next election settles
    };
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

  // Auto-save the working stack to the library entry whose name
  // matches scene.stackName. Triggers whenever scene.stack changes
  // (layer added/removed, role/material/color edits, coplanar group
  // toggled, layers reordered) so the library entry stays the
  // source of truth — switching away and back returns the SAME
  // grouped / edited state.
  //
  // No-op when scene.stackName isn't a known library entry (e.g.,
  // brand-new "unsaved" stack name). The user can name it via
  // rename… to start auto-saving.
  useEffect(() => {
    if (!scene.stackName) return;
    if (!stackList.includes(scene.stackName)) return;
    let cancelled = false;
    (async () => {
      await saveStack(workspace, scene.stackName, { name: scene.stackName, stack: scene.stack });
      if (cancelled) return;
    })();
    return () => { cancelled = true; };
  }, [workspace, scene.stack, scene.stackName, stackList]);

  // Library state
  const [libraryItems, setLibraryItems] = useState([]); // names
  const [archivedLibraryItems, setArchivedLibraryItems] = useState([]); // names
  const [showArchive, setShowArchive] = useState(false);
  // Parametric cell definitions stored in the workspace (name → def).
  // Scene-embedded defs (scene.cells) overlay these for display, so a
  // shared design brings its cells along even in a fresh workspace.
  const [workspaceCells, setWorkspaceCells] = useState({});
  const refreshLibrary = useCallback(async () => {
    const [active, archived, cellNames] = await Promise.all([
      listLibraryItems(workspace),
      listArchivedLibraryItems(workspace),
      listCellDefs(workspace),
    ]);
    setLibraryItems(active.sort());
    setArchivedLibraryItems(archived.sort());
    const defs = {};
    for (const n of cellNames) {
      const d = await loadCellDef(workspace, n);
      if (d) defs[n] = d;
    }
    setWorkspaceCells(defs);
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
  //
  // The 3rd opts argument lets callers customize the confirm button —
  // useful for destructive actions (delete, overwrite, etc.) where a
  // red button + "Delete"-style label communicates the impact clearly.
  const confirmDialog = useCallback((message, title, opts = {}) => new Promise((resolve) => {
    setDialog({
      kind: 'confirm', title: title || 'Confirm', message,
      onConfirm: () => { setDialog(null); resolve(true); },
      onCancel: () => { setDialog(null); resolve(false); },
      confirmLabel: opts.confirmLabel,
      confirmTone: opts.confirmTone,
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

  // Cross-tab refresh: when ANOTHER tab persists something in this workspace
  // (BroadcastChannel ping from its post-persist choke point), drop the cached
  // lists so this tab doesn't render stale designs/snapshots. (Declared here,
  // AFTER refreshSavedList — a const in this dep array above it would TDZ.)
  useEffect(() => {
    if (!saveBroadcastChannel) return;
    const onMsg = (e) => {
      const d = e && e.data;
      if (!d || d.type !== 'saved' || (d.workspace || '') !== (workspace || '')) return;
      refreshSavedList();
      setVersionsByDesign({});
    };
    saveBroadcastChannel.addEventListener('message', onMsg);
    return () => saveBroadcastChannel.removeEventListener('message', onMsg);
  }, [workspace, refreshSavedList]);

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
          setVersions(Array.isArray(d.versions) ? d.versions : []);
          setCurrentVersionId(resolveCurrentVersionId(d.currentVersionId, d.versions));
          setDesignName(activeName);
          setSaveStatus('saved');
          return;
        }
      }
      setVersions([]);
      setCurrentVersionId(null);
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

  // Workspace parameter names — fed into expression-bearing inputs as
  // autocomplete suggestions. Excludes synthetic `_comp_<id>_*` keys
  // (those are solver internals; the user shouldn't type them) and the
  // RESERVED_IDENTS (math functions / constants — typing `sin(`
  // already works without the field suggesting it).
  const paramNames = useMemo(() => {
    const names = Object.keys(scene.params || {}).filter(n => !n.startsWith('_comp_'));
    return names.sort();
  }, [scene.params]);

  // True when the working scene has drifted away from the snapshot the
  // current-version pointer (currentVersionId) points to. Drives the
  // synthetic "current" virtual row in the SAVED DESIGNS version list
  // — the user's mental model is "after I snapshot v4 and start
  // editing, my live work should show as a separate row above v4 so
  // I don't accidentally throw it away by clicking v4 again".
  //
  // Deep-equality via JSON.stringify is fine for typical scenes
  // (sub-millisecond at a few hundred components); memoized so it
  // only recomputes when the scene / versions / pointer change.
  const currentIsModified = useMemo(() => {
    if (!currentVersionId) return false;
    const v = versions.find(vv => vv && vv.id === currentVersionId);
    if (!v || !v.scene) return false;
    try {
      return JSON.stringify(scene) !== JSON.stringify(v.scene);
    } catch {
      return false;
    }
  }, [scene, versions, currentVersionId]);

  // Single "needs persisting" signal. `saveStatus` only tracks the last write
  // OUTCOME ('saved'/'saving'/'unsaved'); it does NOT mean "the working scene
  // is safely in storage and matches its snapshot". `currentIsModified` covers
  // "scene drifted from the snapshot" (true even after an autosave, which
  // persists the working state but does NOT snapshot); `saveStatus==='unsaved'`
  // covers a brand-new / never-snapshotted design (currentVersionId null →
  // currentIsModified false). Use isDirty — not saveStatus — to decide whether
  // the working state must be flushed before we drop it on a design switch.
  const isDirty = saveStatus === 'unsaved' || currentIsModified;

  // Latest-value refs so the save-before-switch flush always persists the
  // EXACT current working state and gates on real dirtiness, regardless of a
  // stale callback closure or React batching between the last edit and the
  // click. Mirrored every render (same pattern as undoRef/redoRef below).
  const sceneRef = useRef(scene);
  const historyRef = useRef(history);
  const futureRef = useRef(future);
  const versionsRef = useRef(versions);
  const currentVersionIdRef = useRef(currentVersionId);
  const designNameRef = useRef(designName);
  const isDirtyRef = useRef(isDirty);
  // Pending autosave timer (declared here so the save-before-switch flush can
  // cancel it; the autosave effect below sets it).
  const autosaveTimerRef = useRef(null);
  // Monotonic edit counter — bumped by every updateScene. The autosave
  // captures it BEFORE its write and only flips saveStatus to 'saved' when
  // it is UNCHANGED at completion. Without this, an edit landing during an
  // in-flight autosave was marked 'saved' (the completion setSaveStatus ran
  // last), its re-armed 2s timer was killed by the effect cleanup, and — for
  // a never-snapshotted design where isDirty degenerates to saveStatus —
  // the newest edit was silently lost on switch / tab close.
  const editSeqRef = useRef(0);
  sceneRef.current = scene;
  historyRef.current = history;
  futureRef.current = future;
  versionsRef.current = versions;
  currentVersionIdRef.current = currentVersionId;
  designNameRef.current = designName;
  isDirtyRef.current = isDirty;

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
    editSeqRef.current++; // marks this edit newer than any in-flight autosave
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
    // This is the post-persist choke point — every successful save/autosave/
    // snapshot/flush call lands here. Ping other tabs on the same workspace
    // so their SAVED DESIGNS list / version caches refresh instead of holding
    // stale state (BroadcastChannel does NOT deliver to the posting tab).
    try { saveBroadcastChannel?.postMessage({ type: 'saved', workspace: workspace || '' }); } catch { /* best-effort */ }
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
  // Save the CURRENT working state (scene/history/future + updatedAt)
  // back to storage under the design's name. Versions are preserved
  // as-is (Save doesn't touch the version history — only Snapshot
  // does). Legacy payloads without a versions field stay that way
  // until the user takes a first snapshot.
  // Shared read-only gate for the manual persist actions.
  const blockIfReadOnly = useCallback(async () => {
    if (tabRoleRef.current !== 'readonly') return false;
    await alertDialog(
      'This tab is read-only: the same workspace is open in another tab, and saving from both would overwrite each other\'s work.\n\nClose the other tab (this one takes over automatically) or save from there.',
      'Read-only tab',
    );
    return true;
  }, [alertDialog]);

  const handleSave = useCallback(async () => {
    if (await blockIfReadOnly()) return;
    // A name that lists nowhere (leading '_' / contains ':') would save fine
    // and then be invisible in SAVED DESIGNS — an invisible-loss trap.
    const nameCheck = validateDesignName(designName);
    if (!nameCheck.ok) { await alertDialog(nameCheck.reason + '\n\nRename the design first.', 'Invalid design name'); return; }
    setSaveStatus('saving');
    const res = await saveDesign(workspace, designName, { scene, history, future, updatedAt: Date.now(), versions, currentVersionId });
    if (res.ok) {
      await setActiveDesignName(workspace, designName);
      await refreshSavedList();
      setSaveStatus('saved');
      mirrorWorkspaceToFileIfLinked();
    } else {
      setSaveStatus('unsaved');
      console.error('Design save failed:', res);
      await alertDialog(describeSaveFailure(res), 'Save failed');
    }
  }, [workspace, designName, scene, history, future, versions, currentVersionId, refreshSavedList, alertDialog, mirrorWorkspaceToFileIfLinked, blockIfReadOnly]);

  // Snapshot the current scene into the design's version history. The
  // user is prompted for a short description (commit message). Each
  // snapshot gets a fresh 8-char hex id (git-style abbreviated SHA),
  // a monotonic version number, and a frozen deep-clone of the
  // current scene. The design's working state and updatedAt are
  // also saved atomically.
  const handleSnapshot = useCallback(async () => {
    if (await blockIfReadOnly()) return;
    const description = await promptDialog(
      'Snapshot description (optional):',
      '',
      'New snapshot',
    );
    // promptDialog returns null on Cancel; an empty string is a
    // legitimate "no description" choice (matches git's `--allow-empty-message`).
    if (description === null) return;
    setSaveStatus('saving');
    const newVersion = makeVersion(scene, description, versions);
    const nextVersions = [newVersion, ...versions];
    // Taking a snapshot ties the working state to the newly-created
    // version — that's the version the user is now "on", and a
    // subsequent re-open should land back on it.
    const res = await saveDesign(workspace, designName, { scene, history, future, updatedAt: Date.now(), versions: nextVersions, currentVersionId: newVersion.id });
    if (res.ok) {
      setVersions(nextVersions);
      setCurrentVersionId(newVersion.id);
      await setActiveDesignName(workspace, designName);
      await refreshSavedList();
      setSaveStatus('saved');
      mirrorWorkspaceToFileIfLinked();
    } else {
      setSaveStatus('unsaved');
      console.error('Snapshot save failed:', res);
      await alertDialog(describeSaveFailure(res), 'Snapshot failed');
    }
  }, [workspace, designName, scene, history, future, versions, promptDialog, refreshSavedList, alertDialog, mirrorWorkspaceToFileIfLinked, blockIfReadOnly]);

  const handleSaveAs = useCallback(async () => {
    if (await blockIfReadOnly()) return;
    const name = await promptDialog('Save as new design name:', designName + ' copy', 'Save As');
    if (!name || !name.trim()) return;
    const nameCheck = validateDesignName(name);
    if (!nameCheck.ok) { await alertDialog(nameCheck.reason, 'Invalid design name'); return; }
    const trimmed = nameCheck.name;
    if (savedList.includes(trimmed)) {
      const ok = await confirmDialog(`"${trimmed}" already exists. Overwrite?`, 'Overwrite design');
      if (!ok) return;
    }
    setSaveStatus('saving');
    // Save As starts a new design name; carry the existing versions
    // forward (and the current-version pointer) so the user doesn't
    // lose context they explicitly kept.
    const res = await saveDesign(workspace, trimmed, { scene, history, future, updatedAt: Date.now(), versions, currentVersionId });
    if (res.ok) {
      setDesignName(trimmed);
      await setActiveDesignName(workspace, trimmed);
      await refreshSavedList();
      setSaveStatus('saved');
      mirrorWorkspaceToFileIfLinked();
    } else {
      setSaveStatus('unsaved');
      console.error('Save As failed:', res);
      await alertDialog(describeSaveFailure(res), 'Save As failed');
    }
  }, [workspace, designName, scene, history, future, versions, currentVersionId, savedList, refreshSavedList, promptDialog, confirmDialog, alertDialog, mirrorWorkspaceToFileIfLinked, blockIfReadOnly]);


  // Latest-value ref for flushCurrentBeforeSwitch — it's declared BELOW these
  // callbacks (const + TDZ: naming it in their dep arrays would throw at
  // definition time; the CLAUDE.md ref pattern breaks the cycle). Assigned
  // right after the flush's definition; the callbacks only dereference it at
  // CLICK time, long after initialization.
  const flushBeforeSwitchRef = useRef(null);

  const handleNew = useCallback(async () => {
    // Same contract as switching designs: a stored design's working state is
    // FLUSHED silently (it's there when you come back); only a never-saved
    // scratch design asks before discarding. The old gate-on-saveStatus
    // discard confirm could silently drop autosave-raced edits.
    if (flushBeforeSwitchRef.current && !(await flushBeforeSwitchRef.current('a new design'))) return;
    const name = await promptDialog('New design name:', 'Untitled', 'New design');
    if (!name || !name.trim()) return;
    const nameCheck = validateDesignName(name);
    if (!nameCheck.ok) { await alertDialog(nameCheck.reason, 'Invalid design name'); return; }
    const fresh = makeDefaultScene();
    setScene(fresh);
    setHistory([]);
    setFuture([]);
    setVersions([]);
    setCurrentVersionId(null);
    setSelection({ ids: new Set(), primary: null });
    setDesignName(nameCheck.name);
    await setActiveDesignName(workspace, nameCheck.name);
    setSaveStatus('unsaved');
  }, [workspace, setSelection, promptDialog, alertDialog]);

  // New BLANK design: completely empty scene (no default ring/electrode
  // example), but keep the default layer stack so add-tools work without
  // setup. The current design is flushed to storage first (same contract
  // as design switches) — this replaced a confusing type-yes/no prompt.
  const handleNewBlank = useCallback(async () => {
    if (flushBeforeSwitchRef.current && !(await flushBeforeSwitchRef.current('a new blank design'))) return;
    const name = await promptDialog('New blank design name:', 'Untitled', 'New blank design');
    if (!name || !name.trim()) return;
    const nameCheck = validateDesignName(name);
    if (!nameCheck.ok) { await alertDialog(nameCheck.reason, 'Invalid design name'); return; }
    const fresh = makeBlankScene();
    setScene(fresh);
    setHistory([]);
    setFuture([]);
    setVersions([]);
    setCurrentVersionId(null);
    setSelection({ ids: new Set(), primary: null });
    setDesignName(nameCheck.name);
    await setActiveDesignName(workspace, nameCheck.name);
    setSaveStatus('unsaved');
  }, [workspace, setSelection, alertDialog, promptDialog]);

  // ----- Single-design export / import (geometry only) -----
  // Export JUST the current canvas (the scene: params, components, snaps,
  // mirrors, groups, stack, cells, sim setup) to a portable JSON file —
  // deliberately WITHOUT undo history, redo, or the snapshot/version
  // chain. This is the "hand someone the design" / "move it between
  // browsers or machines" file, distinct from the full workspace bundle
  // (which carries every design + library + versions).
  // Download ONE version's scene as a standalone design JSON. `versionId === null`
  // means the live working state ("current"). Works for any design in the list:
  // the active design reads its live scene / in-memory versions; another design
  // is loaded from storage on demand to fetch the snapshot scene. Plain function
  // (not useCallback) so it resolves downloadFile — defined later in the body —
  // at call time without a dep-array TDZ.
  const handleDownloadVersion = async (name, versionId) => {
    try {
      let sceneObj = null;
      let label = name;
      if (name === designName) {
        if (versionId == null) { sceneObj = sceneRef.current || scene; label = `${name}_current`; }
        else {
          const v = versions.find(vv => vv && vv.id === versionId);
          if (v) { sceneObj = v.scene; label = `${name}_v${v.versionNumber}`; }
        }
      } else {
        const d = await loadDesign(workspace, name);
        if (d) {
          if (versionId == null) { sceneObj = d.scene; label = `${name}_current`; }
          else {
            const v = (d.versions || []).find(vv => vv && vv.id === versionId);
            if (v) { sceneObj = v.scene; label = `${name}_v${v.versionNumber}`; }
          }
        }
      }
      if (!sceneObj) { await alertDialog('Could not find that version to download.', 'Export error'); return; }
      const now = new Date();
      const payload = buildDesignExport(sceneObj, label, now.toISOString());
      const filename = `${designExportFilename(label, now.toISOString().slice(0, 10))}.json`;
      const ok = downloadFile(filename, JSON.stringify(payload, null, 2), 'application/json;charset=utf-8');
      if (!ok) await alertDialog('Could not download the file (the browser may be blocking downloads here).', 'Export error');
    } catch (e) {
      await alertDialog(`Download failed: ${e.message}`, 'Export error');
    }
  };


  // Before switching AWAY from the current design — to another design, or to
  // another design's SNAPSHOT — make sure its working ("current") state isn't
  // thrown away. Returns true to proceed with the switch, false to abort.
  //   • Not dirty → proceed (nothing to lose).
  //   • Dirty + a stored design with a real name → flush the LATEST working
  //     scene to storage and proceed, so it's there when you return.
  //   • Dirty + never saved (no storage home) → confirm before discarding.
  //   • Flush failed → confirm before discarding.
  //
  // Reads everything via refs so it always persists the newest scene and gates
  // on REAL dirtiness (isDirty), not the saveStatus label: a design that was
  // autosaved but still differs from its snapshot, or hit a save/edit race, is
  // 'saved' yet must still be flushed before its in-memory scene is dropped.
  // We probe storage DIRECTLY (loadDesign) rather than the savedList cache.
  const flushCurrentBeforeSwitch = useCallback(async (targetLabel) => {
    if (!isDirtyRef.current) return true;
    // Read-only tab: writing would stomp the writer tab. Be honest — the
    // only options are keep working here or discard.
    if (tabRoleRef.current === 'readonly') {
      return await confirmDialog(
        `This tab is read-only (the workspace is open in another tab), so your changes here can't be saved.\n\nDiscard them and load ${targetLabel}?`,
        'Read-only tab', { confirmLabel: 'Discard & load', confirmTone: 'danger' },
      );
    }
    const name = (designNameRef.current || '').trim();
    const payload = {
      scene: sceneRef.current, history: historyRef.current, future: futureRef.current,
      updatedAt: Date.now(), versions: versionsRef.current, currentVersionId: currentVersionIdRef.current,
    };
    const curStored = name ? await loadDesign(workspace, name) : null;
    if (!name || !curStored) {
      // Genuinely-new / never-saved scratch design — no storage home. Ask
      // before discarding (don't silently create a key for a throwaway scene).
      return await confirmDialog(`Discard unsaved changes and load ${targetLabel}?`, 'Load design');
    }
    const res = await saveDesign(workspace, name, payload);
    if (res.ok) {
      // Cancel any pending autosave so a late timer can't fire against the new
      // designName with this (now-superseded) scene closure.
      if (autosaveTimerRef.current) { clearTimeout(autosaveTimerRef.current); autosaveTimerRef.current = null; }
      mirrorWorkspaceToFileIfLinked();
      return true;
    }
    console.error('Save-before-switch failed:', describeSaveFailure(res), res);
    return await confirmDialog(
      `Could not save "${name}" before switching (${res.message || 'storage error'}).\n\nLoad ${targetLabel} anyway and lose its unsaved changes?`,
      'Save failed',
    );
  }, [workspace, confirmDialog, mirrorWorkspaceToFileIfLinked]);
  // Keep the earlier-declared ref pointing at the latest flush (handleNew /
  // handleNewBlank / handleChangeWorkspace are declared before this const —
  // see the TDZ note at flushBeforeSwitchRef).
  flushBeforeSwitchRef.current = flushCurrentBeforeSwitch;

  const handleLoad = useCallback(async (name) => {
    if (name === designName) return; // already on this design — nothing to do
    if (!(await flushCurrentBeforeSwitch(`"${name}"`))) return;
    const d = await loadDesign(workspace, name);
    if (!d) { await alertDialog('Failed to load.', 'Error'); return; }
    setScene(normalizeScene(d.scene));
    setHistory(d.history || []);
    setFuture(d.future || []);
    setVersions(Array.isArray(d.versions) ? d.versions : []);
    setCurrentVersionId(resolveCurrentVersionId(d.currentVersionId, d.versions));
    setSelection({ ids: new Set(), primary: null });
    setDesignName(name);
    await setActiveDesignName(workspace, name);
    setSaveStatus('saved');
  }, [workspace, designName, flushCurrentBeforeSwitch, setSelection, alertDialog]);

  // Load a specific VERSION of a design into the working state. The
  // working state becomes the version's frozen scene; the user can
  // then keep editing and Save (overwrites current) or Snapshot
  // (starts a new chain entry). Marks the design as `unsaved` so
  // the user is reminded that they've moved off the latest state.
  const handleLoadVersion = useCallback(async (name, versionId) => {
    const sameDesign = name === designName;
    // Loading a snapshot of a DIFFERENT design is a design SWITCH — the design
    // you're LEAVING must persist, so flush it first (only confirms for a
    // never-saved scratch design). The design you're switching TO is handled by
    // the discard check below, same as a same-design revert.
    if (!sameDesign) {
      if (!(await flushCurrentBeforeSwitch('this version'))) return;
    }
    const d = await loadDesign(workspace, name);
    if (!d) { await alertDialog('Failed to load design.', 'Error'); return; }
    const v = findVersionById(d.versions, versionId);
    if (!v) { await alertDialog('Version not found.', 'Error'); return; }
    // Loading a snapshot REPLACES the TARGET design's working state. If that
    // working state has unsnapshotted edits, warn before discarding them —
    // whether the target is the active design (live drift check) or another
    // design (compare its STORED working scene to the snapshot its pointer is
    // on). This is the prompt the user expects when clicking a design's own
    // version row; clicking ANOTHER design's version never silently drops the
    // edits of the design that owns it.
    const targetModified = sameDesign
      ? (saveStatus === 'unsaved' || currentIsModified)
      : (() => {
          if (!d.currentVersionId) return false;
          const cur = (d.versions || []).find(x => x && x.id === d.currentVersionId);
          if (!cur || !cur.scene) return false;
          try { return JSON.stringify(d.scene) !== JSON.stringify(cur.scene); } catch { return false; }
        })();
    if (targetModified) {
      // RESCUE SNAPSHOT instead of bare discard: the unsnapshotted working
      // state used to have exactly one barrier — a danger confirm — after
      // which the 2s autosave overwrote the ONLY copy in storage. Now the
      // default path saves those edits as an automatic snapshot first, so
      // loading an old version is always reversible (one extra versions[]
      // entry). Bare discard remains only as the fallback if the rescue
      // write itself fails.
      const subject = sameDesign ? 'Your working state' : `Design "${name}"`;
      const ok = await confirmDialog(
        `${subject} has unsnapshotted edits ("current").\n\nThose edits will be saved as an automatic rescue snapshot first, then this version will load. Nothing is lost.`,
        'Load version', { confirmLabel: 'Snapshot & load' },
      );
      if (!ok) return;
      const rescueScene = sameDesign ? sceneRef.current : d.scene;
      const rescue = makeVersion(rescueScene, `auto: before loading v${v.versionNumber}`, d.versions);
      const newVersions = [rescue, ...(Array.isArray(d.versions) ? d.versions : [])];
      const saveRes = await saveDesign(workspace, name, { ...d, versions: newVersions, updatedAt: Date.now() });
      if (saveRes.ok) {
        d.versions = newVersions; // the state setters below pick this up
      } else {
        console.error('Rescue-snapshot save failed:', saveRes);
        const proceed = await confirmDialog(
          `Could not save the rescue snapshot (${saveRes.message || 'storage error'}).\n\nDiscard the edits and load this version anyway?`,
          'Snapshot failed', { confirmLabel: 'Discard & load', confirmTone: 'danger' },
        );
        if (!proceed) return;
      }
    }
    setScene(normalizeScene(v.scene));
    setHistory([]);
    setFuture([]);
    setVersions(Array.isArray(d.versions) ? d.versions : []);
    setCurrentVersionId(v.id);
    setSelection({ ids: new Set(), primary: null });
    setDesignName(name);
    await setActiveDesignName(workspace, name);
    // Mark unsaved so a subsequent Save commits the loaded version
    // back into the working state (vs. silently overwriting after
    // an autosave debounce).
    setSaveStatus('unsaved');
  }, [workspace, designName, saveStatus, currentIsModified, flushCurrentBeforeSwitch, setSelection, confirmDialog, alertDialog]);

  // Delete a single version from a design's history. The confirmation
  // explicitly recommends snapshotting the current state first so a
  // user who's about to lose work has an obvious recovery path. The
  // confirm button is styled as a destructive red action.
  const handleDeleteVersion = useCallback(async (name, versionId) => {
    const d = await loadDesign(workspace, name);
    if (!d) return;
    const version = findVersionById(d.versions, versionId);
    if (!version) return;
    const dt = new Date(version.savedAt || 0);
    const dateLabel = dt.toLocaleString();
    const message =
      `Delete v${version.versionNumber} (${version.id.slice(0, 7)}) from "${name}"?\n\n` +
      (version.description ? `“${version.description}”\n` : '') +
      `Saved: ${dateLabel}\n\n` +
      `This is permanent — the frozen scene for this version will be lost.\n\n` +
      `Tip: if you want to preserve your CURRENT working state first, ` +
      `cancel and click the "snapshot" button to commit it as a new ` +
      `version. You can always delete older snapshots afterwards.`;
    const ok = await confirmDialog(message, 'Delete version', {
      confirmLabel: 'Delete version',
      confirmTone: 'danger',
    });
    if (!ok) return;
    const nextVersions = (d.versions || []).filter(v => v.id !== versionId);
    // If the deleted version was the one we were "based on", fall
    // through to the new latest snapshot (or null if nothing's left)
    // via resolveCurrentVersionId — keeping the default-to-latest
    // behavior consistent with how loads pick the highlight.
    const nextCurrent = d.currentVersionId === versionId
      ? resolveCurrentVersionId(null, nextVersions)
      : d.currentVersionId;
    {
      // mergeVersions:false — the default versions-union in saveDesign would
      // read the stored payload and RESURRECT the version we're deleting.
      const r = await saveDesign(workspace, name, { ...d, versions: nextVersions, currentVersionId: nextCurrent }, { mergeVersions: false });
      if (!r.ok) console.error('Delete-version save failed:', describeSaveFailure(r), r);
    }
    if (name === designName) {
      setVersions(nextVersions);
      if (d.currentVersionId === versionId) setCurrentVersionId(nextCurrent);
    }
    setVersionsByDesign(prev => {
      const next = { ...prev };
      if (next[name]) next[name] = { versions: sortedVersions(nextVersions), currentVersionId: nextCurrent };
      return next;
    });
    mirrorWorkspaceToFileIfLinked();
  }, [workspace, designName, confirmDialog, mirrorWorkspaceToFileIfLinked]);

  // Edit the description of an existing version. Pops up a prompt
  // pre-filled with the current description; cancel leaves it
  // unchanged. Empty result clears the description (matches the
  // "no description" choice from the original snapshot flow).
  const handleEditVersionDescription = useCallback(async (name, versionId) => {
    const d = await loadDesign(workspace, name);
    if (!d) return;
    const version = findVersionById(d.versions, versionId);
    if (!version) return;
    const newDesc = await promptDialog(
      `Edit description for v${version.versionNumber} (${version.id.slice(0, 7)}):`,
      version.description || '',
      'Edit description',
    );
    if (newDesc === null) return; // cancelled — leave as-is
    const trimmed = newDesc.slice(0, 240);
    const nextVersions = (d.versions || []).map(v =>
      v.id === versionId ? { ...v, description: trimmed } : v
    );
    {
      const r = await saveDesign(workspace, name, { ...d, versions: nextVersions });
      if (!r.ok) console.error('Edit-description save failed:', describeSaveFailure(r), r);
    }
    if (name === designName) setVersions(nextVersions);
    setVersionsByDesign(prev => {
      const next = { ...prev };
      if (next[name]) {
        next[name] = { versions: sortedVersions(nextVersions), currentVersionId: next[name].currentVersionId };
      }
      return next;
    });
    mirrorWorkspaceToFileIfLinked();
  }, [workspace, designName, promptDialog, mirrorWorkspaceToFileIfLinked]);

  // Lazily load (and cache) the versions array + current-version
  // pointer for any design in the workspace. Used when the user
  // expands a non-active design's row in the SAVED DESIGNS list —
  // we don't want to eagerly fetch every design's blob on the first
  // list render.
  const loadVersionsForDesign = useCallback(async (name) => {
    if (name === designName) return; // already in `versions` / `currentVersionId`
    if (versionsByDesign[name]) return; // cached
    const d = await loadDesign(workspace, name);
    if (!d) return;
    const curId = resolveCurrentVersionId(d.currentVersionId, d.versions);
    // Does this design have unsnapshotted working edits? Compare its STORED
    // working scene to the snapshot its pointer is on. Cached so the SAVED
    // DESIGNS panel can show its "current" row even while it isn't active.
    const cur = (d.versions || []).find(v => v && v.id === curId);
    let modified = false;
    try { modified = !!(cur && cur.scene) && JSON.stringify(d.scene) !== JSON.stringify(cur.scene); } catch { modified = false; }
    setVersionsByDesign(prev => ({
      ...prev,
      [name]: { versions: sortedVersions(d.versions), currentVersionId: curId, modified },
    }));
  }, [workspace, designName, versionsByDesign]);

  // Toggle a design row's expanded state in the SAVED DESIGNS list,
  // lazy-loading its versions on first open.
  const toggleDesignExpanded = useCallback((name) => {
    setExpandedDesigns(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else { next.add(name); loadVersionsForDesign(name); }
      return next;
    });
  }, [loadVersionsForDesign]);

  // Mirror the ACTIVE design's snapshot chain into `versionsByDesign`.
  // loadVersionsForDesign deliberately skips the current design (the SAVED
  // DESIGNS list reads its versions from the live `versions` state instead),
  // so that design's cache entry would otherwise never be populated. The
  // moment you switch to another design, its row falls back to the empty
  // cache and flashes "no snapshots yet" until you click it again. Keeping
  // the entry in sync here means the design you just left already has its
  // (correct, current) snapshots cached, so the chip / count / version list
  // stay populated without a reload.
  useEffect(() => {
    if (!designName) return;
    setVersionsByDesign(prev => ({
      ...prev,
      [designName]: { versions: sortedVersions(versions), currentVersionId, modified: currentIsModified },
    }));
  }, [designName, versions, currentVersionId, currentIsModified]);

  const handleDeleteDesign = useCallback(async (name) => {
    const ok = await confirmDialog(`Delete "${name}"? This cannot be undone.`, 'Delete design', { confirmLabel: 'Delete', confirmTone: 'danger' });
    if (!ok) return;
    await deleteDesignStored(workspace, name);
    // Drop the cached versions so a deleted design leaves no orphaned chip.
    setVersionsByDesign(prev => { if (!prev[name]) return prev; const next = { ...prev }; delete next[name]; return next; });
    await refreshSavedList();
    if (name === designName) {
      // Stayed on the now-deleted design. Mark as unsaved so user can re-save
      // under a new name — and CLEAR the active pointer, which still named the
      // deleted design: a reload would land on the default scene while the
      // pointer dangled. (The beforeunload guard protects the on-screen copy.)
      setSaveStatus('unsaved');
      try { await setActiveDesignName(workspace, ''); } catch { /* pointer is advisory */ }
    }
  }, [workspace, designName, refreshSavedList, confirmDialog]);

  const handleRenameDesign = useCallback(async (oldName, newName) => {
    if (!newName || !newName.trim() || newName === oldName) return;
    const nameCheck = validateDesignName(newName);
    if (!nameCheck.ok) { await alertDialog(nameCheck.reason, 'Rename failed'); return; }
    const trimmed = nameCheck.name;
    if (savedList.includes(trimmed)) { await alertDialog('A design with that name already exists.', 'Rename failed'); return; }
    // Kill any pending autosave for the OLD name: its existence probe could
    // pass before the delete below, then its write lands after it — recreating
    // the old key with the newest scene while the new key holds the pre-rename
    // payload (two divergent copies).
    if (autosaveTimerRef.current) { clearTimeout(autosaveTimerRef.current); autosaveTimerRef.current = null; }
    const d = await loadDesign(workspace, oldName);
    if (!d) return;
    // Write the new name FIRST, and only delete the old one if that write
    // succeeded — otherwise a failed save (e.g. quota) would delete the
    // original and lose the design.
    const res = await saveDesign(workspace, trimmed, d);
    if (!res.ok) {
      console.error('Rename save failed:', res);
      await alertDialog('Could not rename — saving under the new name failed; the original is untouched.\n\n' + describeSaveFailure(res), 'Rename failed');
      return;
    }
    await deleteDesignStored(workspace, oldName);
    // Re-key the cached versions (old → new) so the renamed design doesn't
    // leave an orphaned entry under the old name.
    setVersionsByDesign(prev => { if (!prev[oldName]) return prev; const next = { ...prev }; next[trimmed] = next[oldName]; delete next[oldName]; return next; });
    if (designName === oldName) {
      setDesignName(trimmed);
      await setActiveDesignName(workspace, trimmed);
    }
    await refreshSavedList();
  }, [workspace, savedList, designName, refreshSavedList, alertDialog]);

  // ----- Copy / Paste -----
  //
  // Build a portable scene fragment from a set of component ids: the selected
  // components (deep-ish copied), their INTERNAL snaps (both endpoints in the
  // set), and the transitive closure of every referenced parameter. Shared by
  // Copy and "Download selection". Returns { components, snaps, params } or null.
  const buildSelectionFragment = useCallback((ids) => {
    if (!ids || ids.size === 0) return null;
    const components = scene.components
      .filter(c => ids.has(c.id))
      .map(c => ({ ...c, cutouts: (c.cutouts || []).map(cu => ({ ...cu })) }));
    if (components.length === 0) return null;
    const snaps = scene.snaps
      .filter(s => ids.has(s.from.compId) && ids.has(s.to.compId))
      .map(s => ({ ...s }));
    const params = {};
    const used = new Set();
    const frontier = [];
    for (const c of components) for (const id of tokenizeComponentExprs(c)) frontier.push(id);
    for (const s of snaps) for (const expr of [s.dx, s.dy]) {
      if (typeof expr === 'string') for (const id of tokenizeIdents(expr)) frontier.push(id);
    }
    while (frontier.length) {
      const id = frontier.pop();
      if (RESERVED_IDENTS.has(id) || id.startsWith('_comp_') || used.has(id)) continue;
      const p = scene.params[id];
      if (!p) continue;
      used.add(id);
      params[id] = { ...p };
      if (typeof p.expr === 'string') for (const childId of tokenizeIdents(p.expr)) {
        if (!used.has(childId)) frontier.push(childId);
      }
    }
    return { components, snaps, params };
  }, [scene.components, scene.snaps, scene.params]);

  // Insert a scene fragment (components + internal snaps + params) into the
  // current scene: fresh `<id>_copy` ids, snap endpoints remapped, params
  // backfilled (destination WINS on a name collision), and the new components
  // selected. Placement: opts.at = { x, y } (world) centers the fragment's
  // centroid there; otherwise it's offset by 5 grid steps (the Paste default).
  // Shared by Paste and "Upload shapes". Returns the number of components added.
  const applyShapeFragment = useCallback((cb, opts = {}) => {
    if (!cb || !Array.isArray(cb.components) || cb.components.length === 0) return 0;
    const idMap = {};
    const existingIds = new Set(scene.components.map(c => c.id));
    for (const c of cb.components) {
      let candidate = `${c.id}_copy`;
      let i = 2;
      while (existingIds.has(candidate)) candidate = `${c.id}_copy${i++}`;
      existingIds.add(candidate);
      idMap[c.id] = candidate;
    }
    let dx, dy;
    if (opts.at && Number.isFinite(opts.at.x) && Number.isFinite(opts.at.y)) {
      let sx = 0, sy = 0, n = 0;
      for (const c of cb.components) {
        if (Number.isFinite(c.cx) && Number.isFinite(c.cy)) { sx += c.cx; sy += c.cy; n++; }
      }
      dx = opts.at.x - (n ? sx / n : 0);
      dy = opts.at.y - (n ? sy / n : 0);
    } else {
      const offset = gridSize * 5;
      dx = offset; dy = -offset;
    }
    const newComponents = cb.components.map(c => ({
      ...c,
      id: idMap[c.id],
      cx: (Number.isFinite(c.cx) ? c.cx : 0) + dx,
      cy: (Number.isFinite(c.cy) ? c.cy : 0) + dy,
    }));
    // Keep ONLY snaps whose BOTH endpoints are inside the inserted set — links
    // to shapes outside the fragment are dropped (and a stray external endpoint
    // can't produce a broken snap with an undefined compId). buildSelectionFragment
    // already filters this way; enforcing it here covers every fragment source
    // (paste, upload, a hand-edited OS-clipboard payload).
    const newSnaps = (cb.snaps || [])
      .filter(s => idMap[s.from?.compId] && idMap[s.to?.compId])
      .map(s => ({
        ...s,
        id: `snap_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        from: { ...s.from, compId: idMap[s.from.compId] },
        to: { ...s.to, compId: idMap[s.to.compId] },
      }));
    updateScene(prev => {
      const mergedParams = { ...prev.params };
      for (const [name, p] of Object.entries(cb.params || {})) {
        if (!(name in mergedParams)) mergedParams[name] = { ...p };
      }
      return {
        ...prev,
        params: mergedParams,
        components: [...prev.components, ...newComponents],
        snaps: [...prev.snaps, ...newSnaps],
      };
    });
    const newIds = new Set(newComponents.map(c => c.id));
    setSelection({ ids: newIds, primary: newComponents[newComponents.length - 1].id });
    return newComponents.length;
  }, [scene.components, gridSize, updateScene, setSelection]);

  // The clipboard payload is a rich scene fragment (components + snaps,
  // with cutouts/transforms preserved). We persist it three ways, each
  // with a different reach:
  //
  //   1. Per-tab React state — instant, hot in this tab.
  //   2. localStorage (CLIPBOARD_STORAGE_KEY) — shared across every tab
  //      on this origin, survives refresh. This is what fixes the
  //      cross-tab paste use case.
  //   3. OS clipboard via navigator.clipboard.writeText — best-effort;
  //      makes the JSON available to pastes into TextEdit / Notion / a
  //      teammate's chat, AND survives even if localStorage is cleared.
  //      Will silently no-op if the API isn't present or the user
  //      hasn't granted clipboard-write permission.
  const handleCopy = useCallback(async () => {
    const payload = buildSelectionFragment(selectedIds);
    if (!payload) return;
    setClipboard(payload);
    const wireFormat = JSON.stringify({ _kind: CLIPBOARD_KIND, ...payload });
    // Cross-tab: write to localStorage SYNCHRONOUSLY. It's shared across every
    // same-origin tab and is committed before this handler returns — unlike the
    // IDB write below, which is async and can still be in flight when the user
    // switches tabs and pastes. localStorage is the reliable cross-tab channel;
    // the clipboard payload is small (a few components), well under the cap.
    try { window.localStorage.setItem(CLIPBOARD_STORAGE_KEY, wireFormat); } catch { /* private mode / quota — IDB + OS clipboard cover it */ }
    // Mirror to the high-capacity IDB store too (covers localStorage-disabled).
    try { await window.storage.set(CLIPBOARD_STORAGE_KEY, wireFormat); } catch {}
    // Cross-app bonus: try the OS clipboard too. The permission prompt
    // is browser-mediated and fires on the FIRST writeText() in a
    // session if the page doesn't already have permission. If declined
    // or unavailable, swallow — localStorage carries the in-app case.
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(JSON.stringify({ _kind: CLIPBOARD_KIND, ...payload }, null, 2));
      }
    } catch { /* permission denied / not allowed — silent fallback */ }
    setSaveStatus(s => s); // no-op, just to indicate user feedback could go here
  }, [selectedIds, buildSelectionFragment]);

  const handlePaste = useCallback(async (at) => {
    // Resolve the clipboard payload with a three-tier fallback so paste
    // works across tabs / after refresh / from the OS clipboard:
    //   1. The in-memory React clipboard (this tab's most recent Copy).
    //   2. localStorage — set by Copy in this tab OR any other tab on
    //      the same origin. Survives refreshes.
    //   3. The OS clipboard, if it contains our magic-marker JSON
    //      (CLIPBOARD_KIND). Lets users paste content that was copied
    //      in an earlier session whose localStorage got cleared.
    let cb = clipboard;
    // 2a. localStorage — synchronous, shared across same-origin tabs. Checked
    // before IDB so a payload a DIFFERENT tab just copied is picked up
    // immediately, with no async-read race.
    if (!cb || cb.components.length === 0) {
      try {
        const t = window.localStorage.getItem(CLIPBOARD_STORAGE_KEY);
        if (t) {
          const parsed = JSON.parse(t);
          if (parsed && parsed._kind === CLIPBOARD_KIND && Array.isArray(parsed.components)) {
            cb = { components: parsed.components, snaps: parsed.snaps || [], params: parsed.params || {} };
          }
        }
      } catch { /* corrupt/missing — fall through to IDB */ }
    }
    // 2b. IDB store (covers the localStorage-disabled / migrated-data case).
    if (!cb || cb.components.length === 0) {
      try {
        const r = await window.storage.get(CLIPBOARD_STORAGE_KEY);
        if (r && typeof r.value === 'string') {
          const parsed = JSON.parse(r.value);
          if (parsed && parsed._kind === CLIPBOARD_KIND && Array.isArray(parsed.components)) {
            cb = { components: parsed.components, snaps: parsed.snaps || [], params: parsed.params || {} };
          }
        }
      } catch { /* corrupt or missing — fall through */ }
    }
    if (!cb || cb.components.length === 0) {
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard?.readText) {
          const text = await navigator.clipboard.readText();
          const parsed = JSON.parse(text);
          if (parsed && parsed._kind === CLIPBOARD_KIND && Array.isArray(parsed.components)) {
            cb = { components: parsed.components, snaps: parsed.snaps || [], params: parsed.params || {} };
          }
        }
      } catch { /* permission denied / not JSON / not our payload — give up */ }
    }
    if (!cb || cb.components.length === 0) return;
    // Paste centered on the cursor: an explicit `at` (right-click Paste) wins,
    // else the last canvas hover position; if the cursor was never over the
    // canvas, applyShapeFragment falls back to its grid offset.
    const placeAt = at || cursorWorldRef.current;
    applyShapeFragment(cb, (placeAt && Number.isFinite(placeAt.x) && Number.isFinite(placeAt.y)) ? { at: placeAt } : {});
    // Keep the in-memory cache hot so the NEXT paste skips the
    // localStorage / OS-clipboard lookup.
    setClipboard(cb);
  }, [clipboard, applyShapeFragment]);

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
      } else if (e.key === '+' || e.key === '-' || e.key === '*') {
        // Boolean shortcuts: union (+), subtract (-), punch (*) act on
        // the current selection. Skip when typing in any input so users
        // can enter expressions like "x + y" or negative numbers without
        // triggering a boolean op.
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
        else if (e.key === '*') fn('punch');
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
  //
  // The "already exists" check is done against LIVE STORAGE when the timer
  // fires — NOT the savedList React cache. savedList lags a just-saved design
  // (its refresh is async), and gating on it would SKIP autosave for a design
  // the user just saved, leaving subsequent edits unpersisted until a manual
  // save / design switch (the "edit then close the tab" loss). Probing storage
  // is authoritative: it autosaves any design with a real storage home, never
  // creates a key for a brand-new/unsaved scratch design (it waits for an
  // explicit Save), and never resurrects a just-deleted one.
  const [lastAutoSavedAt, setLastAutoSavedAt] = useState(null);
  useEffect(() => {
    // Gated on saveStatus, not isDirty: a design that's merely modified-since-
    // snapshot is already persisted as the working state, so re-autosaving it
    // would loop. The save-before-switch flush (gated on isDirty) is the net
    // for any dirty-but-not-persisted window.
    if (saveStatus !== 'unsaved') return;
    if (!designName) return;
    // Read-only tab (workspace open elsewhere): autosaving here would stomp
    // the writer tab's state — the exact multi-tab data loss the election
    // prevents. Edits stay in memory; the banner explains why.
    if (tabRole === 'readonly') return;
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    autosaveTimerRef.current = setTimeout(async () => {
      const name = (designName || '').trim();
      let exists = false;
      try { exists = (await listSavedDesigns(workspace)).includes(name); } catch { exists = false; }
      if (!name || !exists) return; // brand-new/unsaved scratch design, or deleted — skip
      setSaveStatus('saving');
      // Capture the edit counter BEFORE the write: if another edit lands
      // while the save is in flight, we must NOT mark 'saved' at completion
      // (the stored copy is already stale) — leaving 'unsaved' re-arms the
      // debounce so the newer edit gets its own autosave.
      const seqAtStart = editSeqRef.current;
      // Preserve versions[] and currentVersionId through autosave
      // too — otherwise the first autosave after a snapshot would
      // silently drop history / the current-version pointer.
      const res = await saveDesign(workspace, name, { scene, history, future, updatedAt: Date.now(), versions, currentVersionId });
      if (res.ok) {
        setSaveStatus(editSeqRef.current === seqAtStart ? 'saved' : 'unsaved');
        setLastAutoSavedAt(Date.now());
        // Mirror the workspace bundle to the linked file (if any) — autosave
        // takes the same path as a manual save here.
        mirrorWorkspaceToFileIfLinked();
      } else {
        setSaveStatus('unsaved');
        // Autosave runs without a modal (it would spam every 2s); log the
        // full diagnosis so a recurring failure is visible in the console.
        // The red status dot signals it; a manual Cmd+S surfaces the modal.
        console.error('Autosave failed:', describeSaveFailure(res), res);
      }
    }, 2000);
    return () => {
      if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    };
  }, [workspace, scene, history, future, versions, currentVersionId, designName, saveStatus, tabRole, mirrorWorkspaceToFileIfLinked]);

  // ----- Unload guard + emergency flush -----
  // Closing/refreshing the tab within the 2s autosave debounce silently
  // dropped those edits (and ALL work on a never-saved design). Two nets:
  //   • beforeunload: browser "unsaved changes" prompt while edits are not
  //     yet in storage. Keyed on saveStatus ('unsaved'/'saving'), NOT
  //     isDirty — a scene that merely drifted from its snapshot but was
  //     autosaved is already persisted, and prompting there would cry wolf
  //     on every close.
  //   • pagehide / visibilitychange→hidden: fire-and-forget saveDesign from
  //     the latest-value refs (IDB transactions started before unload
  //     usually commit). Existence-gated like the autosave so a scratch
  //     design never silently creates a storage key.
  const saveStatusRef = useRef(saveStatus);
  saveStatusRef.current = saveStatus;
  const savedListRef = useRef(savedList);
  savedListRef.current = savedList;
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;
  useEffect(() => {
    const unsavedNow = () => saveStatusRef.current === 'unsaved' || saveStatusRef.current === 'saving';
    const onBeforeUnload = (e) => {
      if (!unsavedNow()) return;
      e.preventDefault();
      e.returnValue = ''; // required by some Chromium versions to show the prompt
    };
    const flushNow = () => {
      if (!unsavedNow()) return;
      if (tabRoleRef.current === 'readonly') return; // never write from a read-only tab
      const name = (designNameRef.current || '').trim();
      if (!name || !savedListRef.current.includes(name)) return; // never-saved scratch — no storage home
      const seqAtStart = editSeqRef.current;
      saveDesign(workspaceRef.current, name, {
        scene: sceneRef.current, history: historyRef.current, future: futureRef.current,
        updatedAt: Date.now(), versions: versionsRef.current, currentVersionId: currentVersionIdRef.current,
      }).then((res) => {
        // Same in-flight-edit race guard as the autosave: only mark 'saved'
        // if no edit landed while the write was in flight.
        if (res && res.ok && editSeqRef.current === seqAtStart) setSaveStatus('saved');
      }).catch(() => {});
    };
    const onPageHide = () => flushNow();
    const onVisibility = () => { if (document.visibilityState === 'hidden') flushNow(); };
    window.addEventListener('beforeunload', onBeforeUnload);
    window.addEventListener('pagehide', onPageHide);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      window.removeEventListener('pagehide', onPageHide);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

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

  // Shift+F (C4): zoom the viewport to the bbox of the SELECTED solved
  // components, with 20% padding. Falls back to a no-op when nothing is
  // selected (plain F = fit-all still works).
  const zoomToSelection = useCallback(() => {
    if (selectedIds.size === 0) return;
    const solved = applyMirrors(solveLayout(scene.components, scene.snaps, paramValues), scene.mirrors);
    const sel = solved.filter(c => selectedIds.has(c.id));
    if (sel.length === 0) return;
    const xs = sel.flatMap(c => [c.cx - evalExpr(c.w, paramValues) / 2, c.cx + evalExpr(c.w, paramValues) / 2]);
    const ys = sel.flatMap(c => [c.cy - evalExpr(c.h, paramValues) / 2, c.cy + evalExpr(c.h, paramValues) / 2]);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    if (!Number.isFinite(minX) || !Number.isFinite(minY)) return;
    const pad = 1.2; // 20% padding
    setViewport({
      x: (minX + maxX) / 2,
      y: (minY + maxY) / 2,
      w: Math.max(maxX - minX, 1) * pad,
      h: Math.max(maxY - minY, 1) * pad,
    });
  }, [scene, paramValues, selectedIds]);

  // Arrow-key nudge (C4): translate the selection by (dx, dy) — the same
  // numeric cx/cy update a drag-commit applies. Boolean clusters co-move
  // (collectNudgeCluster mirrors the canvas cluster-drag expansion);
  // snap-bound / cxExpr-bound components get re-solved back onto their
  // constraint on the next solve, which matches drag semantics.
  const nudgeSelected = useCallback((dx, dy) => {
    if (selectedIds.size === 0) return;
    updateScene(prev => {
      const moveSet = collectNudgeCluster(prev.components, selectedIds);
      if (moveSet.size === 0) return prev;
      return {
        ...prev,
        components: prev.components.map(c => moveSet.has(c.id)
          ? { ...c, cx: c.cx + dx, cy: c.cy + dy }
          : c),
      };
    });
  }, [selectedIds, updateScene]);

  // Keyboard shortcuts (F = fit, ⇧F = zoom to selection, arrows = nudge,
  // ⌘D = duplicate, ⌘A = select all, Esc = clear selection,
  // Delete/Backspace = delete selected, Cmd+Z = undo, Cmd+Shift+Z = redo)
  useEffect(() => {
    const ARROW_DIRS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] };
    const handler = (e) => {
      const tag = e.target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target?.isContentEditable) return;
      if ((e.key === 'f' || e.key === 'F') && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        if (e.shiftKey) zoomToSelection();
        else fitToView();
      } else if (ARROW_DIRS[e.key] && !e.metaKey && !e.ctrlKey && !e.altKey) {
        // Nudge selection by one grid step (Shift = 10x). World is y-up,
        // so ArrowUp = +cy (Canvas flips to screen y-down at render).
        if (selectedIds.size === 0) return;
        e.preventDefault();
        const step = gridSize * (e.shiftKey ? 10 : 1);
        const [ux, uy] = ARROW_DIRS[e.key];
        nudgeSelected(ux * step, uy * step);
      } else if ((e.metaKey || e.ctrlKey) && (e.key === 'd' || e.key === 'D')) {
        // preventDefault unconditionally — beats the browser bookmark dialog.
        e.preventDefault();
        if (selectedIds.size > 0) duplicateIdsRef.current?.(selectedIds);
      } else if ((e.metaKey || e.ctrlKey) && (e.key === 'a' || e.key === 'A')) {
        // Select all non-consumed components (consumed operands live
        // inside their boolean cluster and aren't standalone objects).
        e.preventDefault();
        const all = scene.components.filter(c => !c.consumedBy).map(c => c.id);
        if (all.length > 0) setSelection({ ids: new Set(all), primary: all[all.length - 1] });
      } else if (e.key === 'Escape') {
        // Clear selection — but only when no canvas tool is active (the
        // ruler / add-shape / snap tools own Esc for cancel semantics;
        // Canvas binds those handlers itself).
        if (!addMode && !rulerMode && (!snapMode || snapMode === 'idle') && selectedIds.size > 0) {
          setSelection({ ids: new Set(), primary: null });
        }
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
  }, [fitToView, zoomToSelection, nudgeSelected, selectedIds, gridSize, scene.components, setSelection, addMode, rulerMode, snapMode]);

  // Refs so handlers always see the latest functions
  const undoRef = useRef(null);
  const redoRef = useRef(null);
  undoRef.current = undo;
  redoRef.current = redo;


  // ref so the keyboard handler always sees the latest deleteComp without re-binding
  const deleteCompRef = useRef(null);
  // same pattern for duplicateIds (declared later in this function body) — ⌘D
  const duplicateIdsRef = useRef(null);

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
    // Guard against layer ids that start with a digit (or are otherwise
    // not valid identifier prefixes): the layer id seeds the component
    // id and the auto-generated `<id>_w` / `<id>_h` params, all of
    // which must be valid identifier strings for the expression parser
    // and HFSS to consume. Strip the `l_` prefix the schema uses by
    // convention, then sanitize any leading non-identifier char to `el`.
    const sanitizeIdPrefix = (p) => {
      const stripped = String(p || '').replace(/^l_/, '');
      return /^[A-Za-z_]/.test(stripped) && /^[A-Za-z_][A-Za-z0-9_]*$/.test(stripped)
        ? stripped
        : 'el';
    };
    const layerPrefix = layerKind === 'waveguide' ? 'wg'
      : layerKind === 'port' ? 'port'
      : (conductorLayer ? sanitizeIdPrefix(conductorLayer.id) : 'el');
    // Shape-flavored id prefix so users can tell circles from rects from
    // polygons / polylines at a glance in the SHAPES tree.
    const shapePrefix = shapeKind === 'circle' ? 'circ'
      : shapeKind === 'ellipse' ? 'ell'
      : shapeKind === 'polygon' ? 'poly'
      : shapeKind === 'polyline' ? 'trace'
      : shapeKind === 'polyshape' ? 'pshape'
      : shapeKind === 'via' ? 'via'
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
      } else if (shapeKind === 'via') {
        // Via (D4): click-to-place vertical interconnect spanning two
        // stack layers. Plan-view circle (r param, default 2 µm) — the
        // Z span comes from layerFrom / layerTo at export time, fully
        // parametric through the stack thickness expressions. AABB w/h
        // derive from the radius exactly like circles, so snaps /
        // anchors / transforms work uniformly.
        const rParam = `${id}_r`;
        newParams[rParam] = { expr: '2', unit: 'µm', desc: `${id} via radius` };
        newComp = {
          id, kind: 'via', layer: 'via',
          cx, cy,
          r: rParam,
          layerFrom: spec.layerFrom || null,
          layerTo: spec.layerTo || null,
          w: `2*${rParam}`, h: `2*${rParam}`,
          cutouts: [], label: id,
        };
      } else if (shapeKind === 'polyline') {
        // Polyline trace. The drawing UX in Canvas hands us a vertex
        // array with world coordinates and optional snap bindings per
        // vertex. We encode the FIRST vertex into the component's
        // (cx, cy) anchor (or, if it's snap-bound, leave cx, cy as the
        // placement hint and store the snap in vertices[0]). Each
        // subsequent vertex becomes either `rel` (parametric dx/dy
        // expressions backed by fresh `<id>_dx_N` / `<id>_dy_N` params
        // so the user can sweep individual segments in HFSS) or `snap`
        // (parametrically pinned to the bound component's anchor —
        // HFSS-side sweeps of THAT component move this vertex too).
        const widthParam = `${id}_w`;
        const wValForParam = (spec && Number.isFinite(spec.defaultWidth))
          ? spec.defaultWidth
          : 3;
        newParams[widthParam] = { expr: String(wValForParam), unit: 'µm', desc: `${id} trace width` };
        const polyVerts = (spec.vertices || []).map((v, i) => {
          if (v.arc && i > 0) {
            // Arc-mode click: the draw UX synthesized a 90° (or −90°)
            // circular arc — center offset (cdx, cdy) from the PREVIOUS
            // vertex plus the signed sweep. Bake cdx/cdy as numeric
            // expressions and keep the sweep as the '90'/'-90' literal;
            // the inspector exposes all three as expression fields for
            // later parametrization. Maps 1:1 to an HFSS AngularArc.
            return {
              kind: 'arc',
              cdx: Number(v.arc.cdx).toFixed(3),
              cdy: Number(v.arc.cdy).toFixed(3),
              angle: String(v.arc.angle),
            };
          }
          if (v.snap) {
            // Preserve instanceIdx when the user clicked on a non-base
            // transform replica or boolean-operand cell. The solver +
            // HFSS export honor instanceIdx > 0 by resolving the
            // vertex against the target's transform chain.
            return {
              kind: 'snap',
              compId: v.snap.compId,
              anchor: v.snap.anchor,
              ...(v.snap.instanceIdx ? { instanceIdx: v.snap.instanceIdx } : {}),
            };
          }
          if (i === 0) {
            // Vertex 0 unsnapped — sits at the component's (cx, cy)
            // with dx=dy=0 (the polyline's anchor IS vertex 0).
            return { kind: 'rel', dx: '0', dy: '0' };
          }
          // Subsequent rel-vertices get their own dx/dy params so the
          // user can later edit a single segment's length / direction
          // and have HFSS pick it up.
          const dxParam = `${id}_dx_${i}`;
          const dyParam = `${id}_dy_${i}`;
          const prev = spec.vertices[i - 1];
          const dx = (v.x - prev.x);
          const dy = (v.y - prev.y);
          newParams[dxParam] = { expr: dx.toFixed(3), unit: 'µm', desc: `${id} segment ${i} dx` };
          newParams[dyParam] = { expr: dy.toFixed(3), unit: 'µm', desc: `${id} segment ${i} dy` };
          return { kind: 'rel', dx: dxParam, dy: dyParam };
        });
        // Vertex 0's world position becomes the polyline's (cx, cy)
        // anchor (used as the drag handle and as the chain root for
        // any rel-vertex). If vertex 0 is snapped, cx/cy is still set
        // to the snap target's world position so the AABB lands sanely
        // on first render — the snap binding overrides it after solve.
        const v0 = spec.vertices[0];
        newComp = {
          id, kind: 'polyline', layer: layerKind,
          cx: v0.x, cy: v0.y,
          width: widthParam,
          // AABB w/h start as '0' literals; refreshPolylineBbox in the
          // solver writes the real numeric bbox post-solve.
          w: '0', h: '0',
          vertices: polyVerts,
          closed: false,
          cutouts: [], label: id,
          ...(conductorLayerId ? { conductorLayerId } : {}),
        };
      } else if (shapeKind === 'polyshape') {
        // Closed polygon-path: like polyline, but no trace width (the
        // shape is a 2-D fill, not a swept band) and always closed.
        // The drawing UX hands us the vertex list ALREADY in commit-
        // ready form — vertex 0's snap becomes vertices[0], every
        // subsequent vertex becomes either { kind: 'snap', ... } or
        // { kind: 'rel', dx: '<param>', dy: '<param>' } with fresh
        // per-segment params so the user can later tune a single edge
        // without breaking the rest of the polygon.
        const polyVerts = (spec.vertices || []).map((v, i) => {
          if (v.arc && i > 0) {
            // Arc-mode edge: same encoding as the polyline branch —
            // numeric center offset + signed 90° sweep, 1:1 with an
            // HFSS AngularArc segment on the closed polygon path.
            return {
              kind: 'arc',
              cdx: Number(v.arc.cdx).toFixed(3),
              cdy: Number(v.arc.cdy).toFixed(3),
              angle: String(v.arc.angle),
            };
          }
          if (v.snap) {
            return {
              kind: 'snap',
              compId: v.snap.compId,
              anchor: v.snap.anchor,
              ...(v.snap.instanceIdx ? { instanceIdx: v.snap.instanceIdx } : {}),
            };
          }
          if (i === 0) {
            return { kind: 'rel', dx: '0', dy: '0' };
          }
          const dxParam = `${id}_dx_${i}`;
          const dyParam = `${id}_dy_${i}`;
          const prev = spec.vertices[i - 1];
          const dx = (v.x - prev.x);
          const dy = (v.y - prev.y);
          newParams[dxParam] = { expr: dx.toFixed(3), unit: 'µm', desc: `${id} edge ${i} dx` };
          newParams[dyParam] = { expr: dy.toFixed(3), unit: 'µm', desc: `${id} edge ${i} dy` };
          return { kind: 'rel', dx: dxParam, dy: dyParam };
        });
        const v0 = spec.vertices[0];
        newComp = {
          id, kind: 'polyshape', layer: layerKind,
          cx: v0.x, cy: v0.y,
          // w/h start at '0'; refreshPolyshapeBbox computes the real AABB
          // post-solve from the resolved vertex positions.
          w: '0', h: '0',
          vertices: polyVerts,
          closed: true, // ALWAYS — that's what makes it a polyshape
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
      // Polylines manage their own snap bindings via per-vertex
      // `kind: 'snap'` specs — we skip the legacy single-corner snap
      // installation below. The vertex's `compId`/`anchor` is enough
      // for the solver + exporters to chase the parametric chain.
      const newSnaps = [];
      if (shapeKind === 'polyline' || shapeKind === 'polyshape') {
        return {
          ...prev,
          params: newParams,
          components: [...prev.components, newComp],
          snaps: [...prev.snaps, ...newSnaps],
        };
      }
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
    // C6: clone INTERNAL snaps (both endpoints inside the selection, both
    // remapped) AND EXTERNAL INCOMING snaps (parent outside → child inside;
    // only the 'to' side remaps, so the copy hangs off the same external
    // parent). External OUTGOING snaps are dropped — cloning them would
    // create a second snap targeting the same external 'to' component
    // (duplicate-to violation). See cloneSnapsForDuplicate (module scope).
    const newSnaps = cloneSnapsForDuplicate(
      scene.snaps, ids, idMap,
      () => `snap_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    );
    updateScene(prev => ({
      ...prev,
      components: [...prev.components, ...newComps],
      snaps: [...prev.snaps, ...newSnaps],
    }));
    const newSel = new Set(newComps.map(c => c.id));
    setSelection({ ids: newSel, primary: newComps[newComps.length - 1].id });
  };
  duplicateIdsRef.current = duplicateIds;

  // Right-click context menu state (right-clicking a component opens it).
  // null when closed; otherwise { x, y, items }.
  const [contextMenu, setContextMenu] = useState(null);
  // Download just the selected shapes (components + internal snaps + the params
  // they reference) as a portable `easyrfpic_shapes` JSON, which "Upload shapes"
  // (canvas right-click) re-inserts into any design.
  const handleDownloadSelection = (ids) => {
    const frag = buildSelectionFragment(ids);
    if (!frag) { alertDialog('Select one or more shapes first.', 'Nothing to download'); return; }
    const payload = { format: 'easyrfpic_shapes', version: 1, exportedAt: new Date().toISOString(), ...frag };
    const ws = (workspace || 'default').replace(/[^A-Za-z0-9._-]+/g, '_') || 'default';
    const ts = new Date().toISOString().slice(0, 10);
    const filename = `${ws}_shapes_${frag.components.length}_${ts}.json`;
    const ok = downloadFile(filename, JSON.stringify(payload, null, 2), 'application/json;charset=utf-8');
    if (!ok) alertDialog('Could not download the shapes file (the browser may be blocking downloads here).', 'Export error');
  };

  // Upload a shapes file (or any design .json) and INSERT its components into
  // the current design (non-destructive append). `at` (world point) centers the
  // inserted group at the right-click location. Accepts a "Download selection"
  // file (top-level components), a design export ({ scene: { components } }), or
  // a bare scene object.
  const handleUploadShapes = async (at) => {
    const file = await new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'application/json,.json';
      input.onchange = (e) => resolve(e.target.files?.[0] || null);
      input.click();
    });
    if (!file) return;
    let parsed;
    try { parsed = JSON.parse(await file.text()); }
    catch (e) { await alertDialog('Could not read that file as JSON.\n\n' + e.message, 'Upload failed'); return; }
    const src = (parsed && Array.isArray(parsed.components)) ? parsed
      : (parsed && parsed.scene && Array.isArray(parsed.scene.components)) ? parsed.scene
      : null;
    if (!src || src.components.length === 0) {
      await alertDialog('That file has no shapes to upload (expected a "Download selection" file or a design file with components).', 'Upload failed');
      return;
    }
    const frag = { components: src.components, snaps: src.snaps || [], params: src.params || {} };
    const n = applyShapeFragment(frag, at ? { at } : {});
    if (!n) await alertDialog('Could not insert the shapes from that file.', 'Upload failed');
  };

  // Canvas-background right-click menu: upload shapes (at the click point) and,
  // when the clipboard holds shapes, a Paste shortcut.
  const openBackgroundContextMenu = ({ x, y, worldX, worldY }) => {
    const items = [
      { label: 'Upload shapes here…', icon: Upload, onClick: () => handleUploadShapes({ x: worldX, y: worldY }) },
    ];
    if (clipboard && Array.isArray(clipboard.components) && clipboard.components.length) {
      items.push({ label: `Paste (${clipboard.components.length})`, icon: Copy, hint: '⌘V', onClick: () => handlePaste({ x: worldX, y: worldY }) });
    }
    setContextMenu({ x, y, items });
  };

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
      { label: multi ? `Download selection (${selectedIds.size})` : 'Download shape', icon: Download,
        onClick: () => handleDownloadSelection(multi ? selectedIds : new Set([compId])) },
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

  // ----- Parametric cells -----
  // Define once, instantiate many, update all (src/scene/cells.js).
  // Defs live in the workspace (cellPrefix storage) AND in scene.cells
  // so the design stays self-contained; scene-local defs win on display.
  const cellDefs = useMemo(
    () => ({ ...workspaceCells, ...(scene.cells || {}) }),
    [workspaceCells, scene.cells]
  );
  const cellNames = useMemo(() => Object.keys(cellDefs).sort(), [cellDefs]);
  // cell name → Set of instance prefixes present in the current design.
  const cellInstanceCounts = useMemo(() => {
    const counts = {};
    for (const c of scene.components) {
      const t = c.cellInstance;
      if (!t || !t.cell || !t.inst) continue;
      (counts[t.cell] ||= new Set()).add(t.inst);
    }
    return counts;
  }, [scene.components]);
  // Post-insert hint shown in the CELLS section ("knobs live in PARAMS").
  const [cellInsertHint, setCellInsertHint] = useState('');

  // Save the current selection as a (new or overwritten) cell master.
  // Overwriting IS the edit-the-master flow: tweak an instance (or any
  // geometry), save under the same name, then "update instances".
  const saveSelectionAsCell = async () => {
    if (selectedIds.size === 0) {
      await alertDialog('Select components first.', 'No selection');
      return;
    }
    const name = await promptDialog(
      'Name for this cell (identifier). Instances are inserted as fully prefixed copies:',
      '', 'Save selection as cell'
    );
    if (!name || !name.trim()) return;
    const trimmed = name.trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) {
      await alertDialog('Name must be a valid identifier (letters, digits, underscore; starting with letter/underscore).', 'Invalid name');
      return;
    }
    if (cellDefs[trimmed]) {
      const ok = await confirmDialog(
        `Cell "${trimmed}" already exists. Overwrite the master definition?\n\nExisting instances keep their current geometry until you run "update instances".`,
        'Overwrite cell'
      );
      if (!ok) return;
    }
    const { def, warnings } = makeCellFromSelection(scene, selectedIds, trimmed);
    if (!def) {
      await alertDialog(warnings.join('\n') || 'Nothing to save.', 'Cell not saved');
      return;
    }
    const ok = await saveCellDef(workspace, trimmed, def);
    if (!ok) { await alertDialog('Save failed.', 'Error'); return; }
    updateScene(prev => ({ ...prev, cells: { ...(prev.cells || {}), [trimmed]: def } }));
    await refreshLibrary();
    if (warnings.length > 0) {
      await alertDialog(
        `Cell "${trimmed}" saved with warnings:\n\n• ${warnings.join('\n• ')}`,
        'Cell saved'
      );
    }
  };

  // Insert one instance of a cell at the viewport center. The prefix
  // becomes the instance id: every def param / component id lands in
  // the scene as `<prefix>_<name>` — overrides are simply those
  // prefixed params in the PARAMS panel.
  const insertCell = async (name) => {
    const def = cellDefs[name] || await loadCellDef(workspace, name);
    if (!def) { await alertDialog(`Cell "${name}" failed to load.`, 'Error'); return; }
    const usedInsts = new Set();
    for (const c of scene.components) {
      if (c.cellInstance?.cell) usedInsts.add(c.cellInstance.inst);
    }
    const prefixTaken = (p) =>
      usedInsts.has(p) ||
      scene.components.some(c => c.id === p || c.id.startsWith(p + '_')) ||
      Object.keys(scene.params).some(k => k.startsWith(p + '_'));
    let n = (cellInstanceCounts[name]?.size || 0) + 1;
    let suggested = `${name}${n}`;
    while (prefixTaken(suggested)) suggested = `${name}${++n}`;
    const raw = await promptDialog(
      'Instance prefix — every cell param and component id becomes "<prefix>_<name>":',
      suggested, `Insert cell "${name}"`
    );
    if (!raw || !raw.trim()) return;
    const prefix = raw.trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(prefix)) {
      await alertDialog('Prefix must be a valid identifier.', 'Invalid prefix');
      return;
    }
    if (prefixTaken(prefix)) {
      await alertDialog(`Prefix "${prefix}" collides with existing components or params. Pick another.`, 'Prefix in use');
      return;
    }
    const inst = instantiateCell(def, prefix, {}, viewport.x, viewport.y);
    // One updateScene call = one undo step.
    updateScene(prev => ({
      ...prev,
      params: { ...prev.params, ...inst.params },
      components: [...prev.components, ...inst.components],
      snaps: [...prev.snaps, ...inst.snaps],
      cells: { ...(prev.cells || {}), [name]: def },
    }));
    setCellInsertHint(`Inserted "${prefix}" — its knobs are the ${prefix}_* parameters in PARAMS (overrides = edit those exprs).`);
  };

  // Re-stamp every instance of a cell from the (new) master definition.
  // Per-instance param overrides and centers are preserved; the change
  // summary is shown in a confirm dialog before anything is applied.
  const updateCellInstances = async (name) => {
    const def = cellDefs[name] || await loadCellDef(workspace, name);
    if (!def) { await alertDialog(`Cell "${name}" failed to load.`, 'Error'); return; }
    const { scene: next, summary } = updateInstancesFromCell(scene, def);
    if (summary.instances.length === 0) {
      await alertDialog(`No instances of "${name}" in this design.`, 'Nothing to update');
      return;
    }
    const lines = summary.instances.map(i =>
      `• ${i.inst}: ${i.components} component(s) rebuilt at (${i.center.x.toFixed(1)}, ${i.center.y.toFixed(1)})` +
      `, ${i.keptOverrides.length} param expr(s) kept` +
      (i.addedParams.length > 0 ? `, new: ${i.addedParams.join(', ')}` : '') +
      (i.removedParams.length > 0 ? `, dropped: ${i.removedParams.join(', ')}` : '') +
      (i.droppedExternalSnaps > 0 ? `, ${i.droppedExternalSnaps} external snap(s) dropped` : '')
    );
    const ok = await confirmDialog(
      `Update ${summary.instances.length} instance(s) of "${name}" from the master definition?\n\n${lines.join('\n')}`,
      'Update instances'
    );
    if (!ok) return;
    updateScene(() => next);
  };

  // Delete a cell definition from workspace + scene. Instances stay in
  // the design as ordinary components (provenance tags are harmless and
  // kept — re-saving a cell under the same name re-links them).
  const deleteCell = async (name) => {
    const instCount = cellInstanceCounts[name]?.size || 0;
    const ok = await confirmDialog(
      `Delete cell "${name}"?` +
      (instCount > 0
        ? `\n\n${instCount} instance(s) remain in this design as plain components.`
        : ''),
      'Delete cell',
      { confirmLabel: 'Delete', confirmTone: 'danger' }
    );
    if (!ok) return;
    await deleteCellDef(workspace, name);
    updateScene(prev => {
      const cells = { ...(prev.cells || {}) };
      delete cells[name];
      return { ...prev, cells };
    });
    await refreshLibrary();
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
    // Run the same coplanar-group migration normalizeScene runs at
    // load time. Library entries written before the explicit-group
    // model came in (or before user-made groupings were saved) get
    // their waveguide/conductor/cladding adjacency restored to a
    // single coplanar group. Stacks that already declare groupings
    // pass through unchanged.
    const migrated = migrateStackCoplanarGroups(payload.stack);
    updateScene((prev) => {
      const seeded = paramsForStack(migrated);
      const params = { ...prev.params };
      for (const [pn, pv] of Object.entries(seeded)) if (!params[pn]) params[pn] = pv;
      return { ...prev, stack: migrated, stackName: name, params };
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

  // Export ONE design as a .json file the user can download. Includes
  // every snapshot in `versions[]`. Saved as `<name>.json` — same
  // download path used by the workspace export.
  const handleExportDesign = async (name) => {
    try {
      const bundle = await exportDesign(workspace, name);
      if (!bundle) {
        await alertDialog(`Design "${name}" not found.`, 'Export error');
        return;
      }
      // Sanitize filename: replace anything that's not a-z/0-9/-/_ with _.
      const safe = name.replace(/[^A-Za-z0-9._-]+/g, '_') || 'design';
      const ts = new Date().toISOString().slice(0, 10);
      downloadFile(`${safe}_${ts}.json`, JSON.stringify(bundle, null, 2), 'application/json;charset=utf-8');
    } catch (err) {
      await alertDialog(`Export failed: ${err.message}`, 'Export error');
    }
  };

  // Import ONE design from a user-picked .json file. Mirrors the
  // workspace-import file-picker flow (FileSystem API first, hidden
  // <input type="file"> fallback for Safari/Firefox + sandboxed
  // iframes). Prompts on name collision: choose between overwriting
  // the existing design, picking a `<name>_imported` suffix, or
  // cancelling.
  const handleImportDesignFromFile = async () => {
    let file = null;
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
            types: [{ description: 'easyRFPIC design', accept: { 'application/json': ['.json'] } }],
            multiple: false,
          });
          file = await h.getFile();
        } catch (e) {
          if (e?.name === 'AbortError') return;
          const msg = String(e?.message || '');
          const isSandboxed = e?.name === 'SecurityError' || /Cross[- ]origin|sub[- ]?frames?|sandboxed?/i.test(msg);
          if (isSandboxed) {
            setFsBlockedAtRuntime(true);
            file = await useFileInput();
          } else throw e;
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
    if (!bundle || bundle.format !== 'easyrfpic_design') {
      await alertDialog(
        'Not an easyRFPIC design file (expected format = "easyrfpic_design"). For a workspace bundle, use "Import workspace from file…" instead.',
        'Import error'
      );
      return;
    }
    const versionCount = Array.isArray(bundle.payload?.versions) ? bundle.payload.versions.length : 0;
    const sourceName = bundle.name || 'Imported design';
    const existing = new Set(await listSavedDesigns(workspace));
    let mode = 'overwrite';
    let finalName = sourceName;
    if (existing.has(sourceName)) {
      // Use a prompt to ask what to do. Three valid answers: overwrite,
      // rename, or cancel (anything else cancels).
      const ans = await promptDialog(
        `A design named "${sourceName}" already exists in workspace "${workspace || 'default'}".\n\nType:\n  • "overwrite"  to REPLACE the existing design (its versions are lost!)\n  • "rename"     to import as "${sourceName}_imported"\n  • anything else to cancel`,
        'rename',
        'Name collision',
      );
      if (ans === null) return;
      const a = (ans || '').trim().toLowerCase();
      if (a === 'overwrite') mode = 'overwrite';
      else if (a === 'rename') mode = 'rename';
      else return;
    } else {
      // No collision — confirm with a summary.
      const proceed = await confirmDialog(
        `Import design "${sourceName}" with ${versionCount} snapshot${versionCount === 1 ? '' : 's'} into workspace "${workspace || 'default'}"?`,
        'Import design',
      );
      if (!proceed) return;
    }
    try {
      const result = await importDesign(workspace, bundle, { mode });
      finalName = result.name;
      await refreshSavedList();
      mirrorWorkspaceToFileIfLinked();
      await alertDialog(
        `Imported "${finalName}"${result.replaced ? ' (replaced existing)' : ''}.${versionCount > 0 ? `\n${versionCount} snapshot${versionCount === 1 ? '' : 's'} restored.` : ''}`,
        'Import complete',
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
    if (trimmed === workspace) { setShowWorkspaceDialog(false); return; }
    // Same contract as every design switch: FLUSH the current design's working
    // state instead of discarding it. The old gate-on-saveStatus discard both
    // threw away flushable work and skipped the prompt entirely when an
    // autosave race had mislabeled the status 'saved'.
    if (!(await flushCurrentBeforeSwitch(`workspace "${trimmed || 'default'}"`))) return;
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

  // Live scene-issue feed — recomputed on every edit. Cheap O(components +
  // snaps) checks ONLY; the deeper fix-it pass (validateScene + auto-fix)
  // stays behind the diagnose button click. Drives the diagnose-button
  // badge and the per-row ⚠ markers in the SNAPS panel. Every issue is
  // normalized to validateSnapGraph's shape: { kind, snapId, compId, message }.
  const sceneIssues = useMemo(() => {
    const out = [];
    // 1) Snap-graph structure: self-snaps, missing refs, duplicate targets,
    //    cycles. Lives in the solver module so the checks can't drift from
    //    what solveLayout actually tolerates.
    try { out.push(...validateSnapGraph(scene.components, scene.snaps)); }
    catch { /* never block render on a validator bug */ }
    // 2) Snap offsets whose dx/dy expressions evaluate non-finite.
    for (const s of scene.snaps || []) {
      const dx = evalExpr(s.dx, paramValues);
      const dy = evalExpr(s.dy, paramValues);
      if (!Number.isFinite(dx) || !Number.isFinite(dy)) {
        out.push({ kind: 'nan-offset', snapId: s.id, compId: s.to?.compId ?? null, message: `Snap "${s.id}" has invalid dx="${s.dx}" or dy="${s.dy}" (evaluates to NaN)` });
      }
    }
    // 3) Parameter evaluation errors (circular / unresolvable expressions),
    //    straight from resolveParams.
    for (const [name, err] of Object.entries(paramErrors || {})) {
      out.push({ kind: 'param-error', snapId: null, compId: null, message: `Param "${name}": ${err}` });
    }
    // 4) Degenerate dimensions: w/h non-finite or ≤ 0 breaks anchor math
    //    and exports. Skip kinds whose w/h are solver-written (booleans
    //    literally store '0'; polyline/polyshape bboxes are refreshed
    //    numerically post-solve).
    for (const c of scene.components || []) {
      if (c.kind === 'boolean' || c.kind === 'polyline' || c.kind === 'polyshape') continue;
      const w = evalExpr(c.w, paramValues);
      const h = evalExpr(c.h, paramValues);
      if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
        out.push({ kind: 'bad-dims', snapId: null, compId: c.id, message: `"${c.id}" has degenerate size (w="${c.w}" → ${w}, h="${c.h}" → ${h}) — anchors and exports will misbehave` });
      }
    }
    // 5) Conductor-layer binding health for electrode/port components.
    //    Mirrors the Inspector's binding-picker states: STALE (bound id
    //    deleted or no longer role='conductor') always flags; UNBOUND
    //    flags only when 2+ conductors exist (with a single conductor the
    //    implicit first-conductor fallback is unambiguous).
    const conductorLayers = (scene.stack || []).filter(l => l.role === 'conductor');
    if (conductorLayers.length > 0) {
      for (const c of scene.components || []) {
        if (c.layer !== 'electrode' && c.layer !== 'port') continue;
        const bound = c.conductorLayerId || null;
        if (bound && !conductorLayers.some(l => l.id === bound)) {
          out.push({ kind: 'stale-conductor', snapId: null, compId: c.id, message: `"${c.id}" is bound to conductor layer "${bound}" which was deleted or is no longer a conductor — rebind in the Inspector` });
        } else if (!bound && conductorLayers.length >= 2) {
          out.push({ kind: 'unbound-conductor', snapId: null, compId: c.id, message: `"${c.id}" has no explicit conductor binding — export falls back to the first conductor ("${conductorLayers[0].name || conductorLayers[0].id}") in a ${conductorLayers.length}-conductor stack` });
        }
      }
    }
    return out;
  }, [scene.components, scene.snaps, scene.stack, paramErrors, paramValues]);

  // snapId → newline-joined issue messages, for the ⚠ markers on SNAPS
  // panel rows.
  const snapIssuesById = useMemo(() => {
    const m = new Map();
    for (const it of sceneIssues) {
      if (it.snapId == null) continue;
      m.set(it.snapId, m.has(it.snapId) ? `${m.get(it.snapId)}\n${it.message}` : it.message);
    }
    return m;
  }, [sceneIssues]);

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
      // Rename the param KEY itself (preserving insertion order)…
      const newParams = {};
      for (const [k, v] of Object.entries(prev.params)) newParams[k === oldName ? newName : k] = v;
      // …then rewrite every expression field in the scene — param
      // exprs, component dims and shape knobs, cutouts, transform
      // chains, polyline/polyshape rel-vertices, snap offsets, stack
      // layers, and the sim setup — via the shared walker. (The old
      // inline version only covered params / w / h / snap dx,dy,
      // leaving stale references everywhere else.)
      return renameIdentInScene({ ...prev, params: newParams }, oldName, newName);
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

  // Gate stack edits that would orphan conductor-bound components.
  // Passed to LevelGroup/LayerCard (LAYERS panel) in place of the raw
  // updateScene. When an edit removes a conductor layer, or flips its
  // role away from 'conductor', while components still bind it via
  // conductorLayerId, we ask for confirmation first. On proceed the
  // components keep the (now stale) binding — the Inspector already
  // warns on stale bindings and offers rebinding there — this gate
  // just makes the unbinding deliberate instead of silent. Every
  // other stack edit (thickness, material, reorder, …) passes
  // straight through synchronously.
  const guardedStackUpdateScene = (updater) => {
    let lost = null;
    try {
      // Dry-run the updater against the current scene snapshot to see
      // what it does to the stack. LayerCard updaters are pure, so
      // running them twice (here + inside updateScene) is safe.
      const next = typeof updater === 'function' ? updater(scene) : updater;
      const nextById = new Map((next.stack || []).map(l => [l.id, l]));
      const lostLayers = (scene.stack || []).filter(l =>
        l.role === 'conductor' &&
        (!nextById.has(l.id) || nextById.get(l.id).role !== 'conductor')
      );
      if (lostLayers.length > 0) {
        const lostIds = new Set(lostLayers.map(l => l.id));
        const affected = scene.components.filter(c => c.conductorLayerId && lostIds.has(c.conductorLayerId));
        if (affected.length > 0) lost = { layers: lostLayers, comps: affected };
      }
    } catch { /* detection failure must never block the edit */ }
    if (!lost) { updateScene(updater); return; }
    const layerNames = lost.layers.map(l => l.name || l.id).join(', ');
    const compIds = lost.comps.map(c => c.id).join(', ');
    confirmDialog(
      `Conductor layer "${layerNames}" is still bound by: ${compIds}. Proceeding leaves those components with a stale conductor binding (the Inspector flags stale bindings — rebind them there). Continue?`,
      'Conductor layer in use',
      { confirmLabel: 'Proceed', confirmTone: 'danger' }
    ).then(ok => { if (ok) updateScene(updater); });
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
    const prefix = op === 'union' ? 'union' : (op === 'intersect' ? 'isect'
      : (op === 'punch' ? 'punch' : 'diff'));
    let n = 1;
    while (scene.components.some(c => c.id === `${prefix}${n}`)) n++;
    const newId = `${prefix}${n}`;
    // For 'punch' we mirror HFSS's "Subtract with clone tool object
    // before operation" workflow: clone each tool to a hidden internal
    // primitive at the tool's current position, then run the subtract
    // on the BASE and the CLONES. The clones get consumedBy=punch so
    // they're hidden from SHAPES + standalone rendering; the original
    // tools stay untouched in scene.components as fully independent
    // shapes (visible, selectable, snap targets, exportable as their
    // own primitives). Effect: a hole is cut into the base in the shape
    // of the tool at creation time. Moving the original tool afterward
    // does NOT move the hole — the hole is baked into the clone,
    // exactly like in HFSS.
    const isPunch = op === 'punch';
    const usedNames = new Set(scene.components.map(c => c.id));
    const freshCloneId = (baseTool) => {
      let i = 1;
      let candidate = `${baseTool.id}_clone${i}`;
      while (usedNames.has(candidate)) {
        i++;
        candidate = `${baseTool.id}_clone${i}`;
      }
      usedNames.add(candidate);
      return candidate;
    };
    let derivedOperandIds = ids;
    const clonesToAdd = [];
    // New snaps to install alongside the punch: one per clone, locking
    // the clone's center to its source tool's center. Without this the
    // clone's cx/cy is frozen to the tool's snapshot at punch-creation
    // time, so any later parameter change that moves the tool (e.g.
    // tuning feed_w / feed_L through the snap chain) shifts the tool
    // but leaves the hole stranded at its old position. With the snap
    // in place, the solver re-aligns clone.C with tool.C every frame.
    const cloneSnapsToAdd = [];
    if (isPunch) {
      // First operand is the base (consumed). Each subsequent operand
      // gets cloned; the clone takes the operand slot, the original
      // stays standalone.
      derivedOperandIds = [ids[0]];
      // The clone inherits the BASE's layer so it has the same Z
      // extent (and exports as the same primitive kind) as the base.
      // Without this a port-layer tool would emit as a sheet, and the
      // HFSS Subtract(box, sheet) call would fail. The clone only
      // matters for the subtract — once the op runs it's consumed.
      const baseLayer = baseOp?.layer || layer;
      const baseConductorLayerId = baseOp?.conductorLayerId;
      for (const toolId of ids.slice(1)) {
        const tool = scene.components.find(c => c.id === toolId);
        if (!tool) continue;
        const cloneId = freshCloneId(tool);
        const cloneCx = solvedNow.find(cc => cc.id === toolId)?.cx ?? tool.cx;
        const cloneCy = solvedNow.find(cc => cc.id === toolId)?.cy ?? tool.cy;
        cloneSnapsToAdd.push({
          id: `snap_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          from: { compId: toolId, anchor: 'C' },
          to: { compId: cloneId, anchor: 'C' },
          dx: '0', dy: '0',
        });
        // Strip snap-chain participation: a clone is a standalone copy.
        // Keep shape-specific fields (r, rx, ry, n, R, L_straight, p,
        // wgWidth) so non-rect tools clone correctly.
        const { id: _omitId, consumedBy: _omitC, ...toolBody } = tool;
        const clone = {
          ...toolBody,
          id: cloneId,
          cx: cloneCx,
          cy: cloneCy,
          // Force the clone onto the BASE's layer (and conductor binding,
          // if any). This guarantees the clone matches the base's
          // Z extent in HFSS so the Subtract operates on objects of the
          // same dimensionality.
          layer: baseLayer,
          ...(baseConductorLayerId
            ? { conductorLayerId: baseConductorLayerId }
            : { conductorLayerId: undefined }),
          // Mark the clone as consumed by the new punch boolean. It
          // becomes part of the boolean's history sub-tree and never
          // renders as a top-level primitive on its own.
          consumedBy: newId,
          // Tag the clone so deleteBoolean can clean it up rather than
          // re-surface it as a top-level orphan.
          cloneOf: toolId,
          // Clones start with no transforms — the user's transforms on
          // the original tool aren't retroactively baked in.
          transforms: [],
        };
        clonesToAdd.push(clone);
        derivedOperandIds.push(cloneId);
      }
    }
    const derived = {
      id: newId,
      kind: 'boolean',
      op,
      operandIds: derivedOperandIds,
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
        // For 'punch' only the BASE (operandIds[0]) is consumed from the
        // existing components; the tools were cloned, not consumed.
        ...prev.components.map(c => {
          if (!ids.includes(c.id)) return c;
          if (isPunch && c.id !== ids[0]) return c;
          return { ...c, consumedBy: newId };
        }),
        ...clonesToAdd,
        derived,
      ],
      snaps: [...prev.snaps, ...cloneSnapsToAdd],
    }));
    setSelection({ ids: new Set([newId]), primary: newId });
  };

  // Update a derived boolean component's own fields (label, op, transforms…).
  const updateBoolean = (id, patch) => {
    updateComp(id, patch);
  };

  // Delete a boolean component. Its operands get released (consumedBy
  // cleared) so they return to the standalone SHAPES list. The boolean
  // entry itself is removed. For 'punch' the internal tool clones (tagged
  // with cloneOf) are DROPPED entirely rather than released — they were
  // synthetic primitives created by the punch and have no meaning outside
  // it; releasing them would surface a duplicate of the original tool.
  const deleteBoolean = (id) => {
    updateScene(prev => ({
      ...prev,
      components: prev.components
        .filter(c => c.id !== id)
        .filter(c => !(c.consumedBy === id && c.cloneOf))
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

  // ── Settings export / import / restore (Settings panel footer) ─────────
  const handleExportSettings = () => {
    const payload = buildSettingsExport(settings);
    const pad2 = (n) => String(n).padStart(2, '0');
    const d = new Date();
    const stamp = `${d.getFullYear()}_${pad2(d.getMonth() + 1)}_${pad2(d.getDate())}`;
    downloadFile(`photonic_layout_settings_${stamp}.json`, JSON.stringify(payload, null, 2), 'application/json');
  };
  // PARTIAL import: only the settings present-and-valid in the file are
  // applied; everything else keeps its current value (merge over current).
  const handleImportSettings = (parsed) => {
    setSettings(prev => parseSettingsImport(parsed, prev).settings);
  };
  const handleRestoreSettings = async () => {
    const ok = await confirmDialog(
      'Reset every setting (including the appearance theme) to its default?',
      'Restore defaults',
      { confirmLabel: 'Restore', confirmTone: 'danger' },
    );
    if (ok) setSettings({ ...DEFAULT_SETTINGS });
  };

  // Generic export: generate a script with the given function and present it.
  // Tries to trigger a download; always shows a preview modal so the user can copy
  // the script manually if the sandbox blocks downloads.
  const handleExport = async (filename, generator, options) => {
    let content;
    try {
      // Run the scene through normalizeScene first so any pending
      // migrations (e.g. punch clones whose layer needs to be aligned
      // with the base operand's layer for HFSS dimensionality) are
      // applied to the export input even if they haven't been
      // persisted back to the in-memory state yet.
      const normalized = normalizeScene(scene);
      content = generator(normalized, paramValues, options);
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

  // Sanitize a string for use in a filename. Keep alphanumerics,
  // underscore, hyphen, and dot; collapse anything else to '_'.
  const fileSan = (s) => String(s ?? '').replace(/[^A-Za-z0-9_.\-]+/g, '_');
  // The DESIGN identifier (project name only). Used as the gdsfactory
  // @gf.cell function name + internal .gds name (a stable Python-ish
  // identifier, so it must NOT carry the version/timestamp). Empty /
  // 'Untitled' falls back to 'layout' so we never emit a name like '_.py'.
  const designFileBase = () => {
    const raw = String(designName || '').trim();
    if (!raw || raw === 'Untitled') return 'layout';
    return fileSan(raw);
  };
  // Current design version tag for export filenames: 'vN' when sitting
  // exactly on snapshot N, 'vNc' when the working state is modified
  // (current) relative to N, and 'v0' when the design was never
  // snapshotted.
  const designVersionTag = () => {
    const v = currentVersionId ? versions.find(vv => vv && vv.id === currentVersionId) : null;
    if (!v) return 'v0';
    return `v${v.versionNumber}${currentIsModified ? 'c' : ''}`;
  };
  // Full export-filename base: workspace_project_version_yyyy_mm_dd_hh_mm
  // (LOCAL time — human-facing). Computed fresh per export so the
  // timestamp is the actual export moment. Each handler appends its own
  // type discriminator (_hfss / _gf) + extension.
  const exportFileBase = () => {
    const pad2 = (n) => String(n).padStart(2, '0');
    const ws = fileSan(workspace || 'default') || 'default';
    const d = new Date();
    const ts = `${d.getFullYear()}_${pad2(d.getMonth() + 1)}_${pad2(d.getDate())}_${pad2(d.getHours())}_${pad2(d.getMinutes())}`;
    return `${ws}_${designFileBase()}_${designVersionTag()}_${ts}`;
  };
  const handleExportPyAEDT = () => handleExport(`${exportFileBase()}.py`, generatePyAEDT);
  const handleExportHfssNative = () => {
    const appendToActive = !!(scene.simSetup && scene.simSetup.appendToActive);
    // Filename is always "_hfss" regardless of append mode (appendToActive
    // still drives the generated script's behavior, just not the name).
    return handleExport(`${exportFileBase()}_hfss.py`, generateHfssNative, { appendToActive });
  };
  // 2-line method: the wizard hands us the BUILT two-line scene (line stamped
  // at L1 and L2, 4 lumped ports) + the verified S-index map. Generate the
  // native HFSS script directly from that scene with the εeff/α output-variable
  // block enabled — NOT from the current canvas scene.
  const handleExportTwoLine = async (builtScene, portIndices, dLMeters, cFperM, bundle, sheetImpedance) => {
    let content;
    try {
      const normalized = normalizeScene(builtScene);
      const pv = resolveParams(normalized.params || {}).values;
      // Bundled Q3D builds the SINGLE-line (canvas) scene, not the 2-line scene.
      const q3d = (bundle && Array.isArray(bundle.conductorIds) && bundle.conductorIds.length)
        ? { scene: normalizeScene(scene), ...bundle }
        : undefined;
      // Zero-thickness conductor sheets get a custom surface impedance (Rs+jXs,
      // HFSS expressions that may use Freq) when the wizard supplies one.
      const si = (sheetImpedance && (String(sheetImpedance.resistance ?? '').trim() || String(sheetImpedance.reactance ?? '').trim()))
        ? sheetImpedance : undefined;
      content = generateHfssNative(normalized, pv, { twoLine: { portIndices, dLMeters, cFperM, q3d }, sheetImpedance: si });
    } catch (e) {
      console.error('Two-line generator error:', e);
      await alertDialog('Error generating 2-line script: ' + e.message, 'Export error');
      return;
    }
    if (!content) { await alertDialog('Failed to generate 2-line script.', 'Export error'); return; }
    const filename = `${exportFileBase()}_2line_hfss.py`;
    const ok = downloadFile(filename, content);
    setExportPreview({ filename, content, downloaded: ok });
  };
  // Q3D capacitance script for the meander Z₀ route: build ONLY the selected
  // line conductor(s) + dielectric stack, solve C; the user divides by physical
  // length and pastes C into the wizard.
  const handleExportQ3DCap = async (conductorIds, q3dOpts = {}) => {
    let content;
    try {
      content = generateQ3DCapacitance(normalizeScene(scene), paramValues, { conductorIds, ...q3dOpts, designName: designFileBase() });
    } catch (e) {
      console.error('Q3D generator error:', e);
      await alertDialog('Error generating Q3D script: ' + e.message, 'Export error');
      return;
    }
    if (!content) { await alertDialog('Failed to generate Q3D script.', 'Export error'); return; }
    const filename = `${exportFileBase()}_q3d_cap.py`;
    const ok = downloadFile(filename, content);
    setExportPreview({ filename, content, downloaded: ok });
  };
  // gdsfactory export: a parametric @gf.cell function. The design name
  // (project only — NOT the versioned filename) is passed through so the
  // function and output .gds use a stable identifier.
  const handleExportGdsfactory = () => {
    return handleExport(`${exportFileBase()}_gf.py`, generateGdsfactory, { designName: designFileBase() });
  };
  // Figure exports — clone the LIVE canvas SVG and serialize it. This
  // captures EXACTLY what the user sees: every transform replication,
  // dimension overlay (when toggled on), ruler measurement, mirror axis
  // line, snap arrow, selection halo — anything currently drawn on the
  // canvas. The viewBox is re-cropped to the rendered content's bbox
  // (+ 5 % pad) so the figure is tight even if the user is zoomed out.
  //
  //   SVG: full vector, opens in any browser / Inkscape / Illustrator.
  //   PDF: the cleaned SVG is rasterized to 300 DPI JPEG and embedded
  //        as a single Image XObject in a minimal PDF 1.4 document.
  //        Matches the canvas EXACTLY (since the browser does the
  //        rendering); raster, not vector — for vector PDF, take the
  //        SVG export through Inkscape's "Save as PDF".
  const handleExportSVG = async () => {
    const svgEl = canvasSvgRef.current;
    if (!svgEl) { await alertDialog('Canvas not ready yet — try again in a moment.', 'Export error'); return; }
    let content;
    try {
      content = generateSvgFromElement(svgEl, { designName, background: canvasTheme.canvasBg });
    } catch (e) {
      console.error('SVG generator error:', e);
      await alertDialog('Error generating SVG: ' + e.message, 'Export error');
      return;
    }
    if (!content) { await alertDialog('Failed to generate SVG.', 'Export error'); return; }
    const filename = `${exportFileBase()}.svg`;
    const ok = downloadFile(filename, content, 'image/svg+xml');
    setExportPreview({ filename, content, downloaded: ok });
  };
  const handleExportPDF = async () => {
    const svgEl = canvasSvgRef.current;
    if (!svgEl) { await alertDialog('Canvas not ready yet — try again in a moment.', 'Export error'); return; }
    let bytes;
    try {
      bytes = await generatePdfFromElement(svgEl, { designName, dpi: 300, background: canvasTheme.canvasBg });
    } catch (e) {
      console.error('PDF generator error:', e);
      await alertDialog('Error generating PDF: ' + e.message, 'Export error');
      return;
    }
    if (!bytes || !bytes.length) { await alertDialog('Failed to generate PDF.', 'Export error'); return; }
    const filename = `${exportFileBase()}.pdf`;
    const ok = downloadFile(filename, bytes, 'application/pdf');
    if (ok) {
      const summary = [
        `PDF figure: ${filename} (${bytes.length.toLocaleString()} bytes)`,
        '',
        'Matches the canvas exactly — every shape replication, dimension',
        'overlay (if enabled), ruler measurement, and mirror axis is in.',
        '',
        'Format: 300 DPI JPEG embedded in a minimal PDF 1.4 document.',
        'Page sized so the longest side is ≤ 540 pt (~7.5 in). For a',
        'vector PDF, export as SVG and convert via Inkscape "Save as PDF".',
      ].join('\n');
      setExportPreview({ filename, content: summary, downloaded: ok, binary: true });
    } else {
      await alertDialog('Failed to start PDF download.', 'Export error');
    }
  };
  const handleExportGDS = async () => {
    let bytes;
    try {
      const normalized = normalizeScene(scene);
      bytes = generateGDS(normalized, paramValues);
    } catch (e) {
      console.error('GDS generator error:', e);
      await alertDialog('Error generating GDS: ' + e.message, 'Export error');
      return;
    }
    if (!bytes || !bytes.length) {
      await alertDialog('Failed to generate GDS.', 'Export error');
      return;
    }
    const gdsName = `${exportFileBase()}.gds`;
    const ok = downloadFile(gdsName, bytes, 'application/octet-stream');
    if (!ok) {
      await alertDialog('Failed to start GDS download.', 'Export error');
    } else {
      // Show a brief confirmation in the export preview modal — but with a
      // text summary instead of the binary content (which is unprintable).
      const viaLayerEntries = viaGdsLayerMap(scene.components || []);
      const summary = [
        `GDS-II file: ${gdsName} (${bytes.length} bytes)`,
        '',
        'Layer mapping:',
        '  1   = waveguide',
        ...Array.from((scene.stack || []).filter(l => l.role === 'conductor')).map((l, i) => `  ${10 + i}  = conductor "${l.name}"`),
        '  100 = port',
        // Vias: one GDS layer per distinct (layerFrom → layerTo) pair,
        // assigned 200, 201, … in the order via types appear in the scene.
        ...viaLayerEntries.map(v => `  ${v.layer} = via "${v.layerFrom} → ${v.layerTo}" (circle boundary)`),
        '',
        'Coordinate units: 1 µm = 1000 nm (database unit = 1 nm).',
        '',
        'Notes:',
        '- Cutouts are emitted as separate boundaries on datatype 1, on the same',
        '  layer as the parent component. Most viewers render them as overlapping',
        '  shapes since GDS doesn\'t natively encode subtraction.',
        '- Mirrored components are exported with their solved (mirrored) positions.',
      ].join('\n');
      setExportPreview({ filename: gdsName, content: summary, downloaded: ok, binary: true });
    }
  };

  const layerSwatches = {
    waveguide: { bg: '#14532d', fg: '#86efac' },
    electrode: { bg: '#7c2d12', fg: '#fed7aa' },
  };

  return (
    <div className="h-screen w-full flex flex-col relative" style={{ fontFamily: "'IBM Plex Sans', system-ui, sans-serif", background: 'var(--app-slate-900)', color: 'var(--app-slate-200)' }}>
      {tabRole === 'readonly' && (
        <div
          className="w-full px-4 py-1.5 text-center text-xs font-medium border-b border-amber-700"
          style={{ background: 'rgba(120, 53, 15, 0.55)', color: '#fcd34d' }}
          title="Two tabs writing the same workspace would overwrite each other's saves and snapshots. This tab becomes writable automatically when the other closes."
        >
          Read-only — this workspace is open in another tab. Edits here won't be saved. Close the other tab to take over.
        </div>
      )}
      <header className="border-b border-slate-700" style={{ background: 'var(--app-slate-950)' }}>
        {/* Row 1 — primary tools and identity */}
        <div className="flex items-center justify-between px-4 py-2">
          <div className="flex items-center gap-3">
            {/* Logo: a stylized photonic-RF IC — green waveguide running
                horizontally through a slate chip outline, with a gold
                meander electrode pair flanking it above and below. The
                same glyph is in /public/favicon.svg at higher detail. */}
            <svg viewBox="0 0 64 64" width="28" height="28" aria-hidden="true">
              <rect x="2" y="2" width="60" height="60" rx="10" ry="10" fill="#0f172a" stroke="#334155" strokeWidth="1.5"/>
              <path d="M 8 22 H 56" stroke="#daa520" strokeWidth="3" fill="none" strokeLinecap="round"/>
              <g stroke="#daa520" strokeWidth="2" fill="none" strokeLinejoin="round">
                <rect x="11" y="10" width="7" height="9"/>
                <rect x="22" y="10" width="7" height="9"/>
                <rect x="33" y="10" width="7" height="9"/>
                <rect x="44" y="10" width="7" height="9"/>
              </g>
              <path d="M 8 42 H 56" stroke="#daa520" strokeWidth="3" fill="none" strokeLinecap="round"/>
              <g stroke="#daa520" strokeWidth="2" fill="none" strokeLinejoin="round">
                <rect x="11" y="45" width="7" height="9"/>
                <rect x="22" y="45" width="7" height="9"/>
                <rect x="33" y="45" width="7" height="9"/>
                <rect x="44" y="45" width="7" height="9"/>
              </g>
              <path d="M 0 32 H 64" stroke="#10b981" strokeWidth="4" fill="none" strokeLinecap="round"/>
              <path d="M 0 32 H 64" stroke="#34d399" strokeWidth="1.5" fill="none" strokeLinecap="round" opacity="0.8"/>
            </svg>
            <div>
              <h1 className="font-bold tracking-tight text-sm" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                <span className="text-slate-100">MPL</span>{' '}
                <span className="text-emerald-400">easy</span><span className="text-amber-500">RF</span><span className="text-cyan-300">PIC</span>
                {/* Build version (git release tag, injected by vite.config). */}
                <span className="text-[9px] font-normal text-slate-500 ml-1.5 align-top" title={`easyRFPIC version ${__APP_VERSION__}`}>v{__APP_VERSION__}</span>
              </h1>
              <p className="text-[10px] text-slate-400">parametric photonic-RF IC layout · pyAEDT &amp; native HFSS export</p>
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
              // Ports also bind to a specific conductor layer — the port
              // sheet is created at that conductor's mid-Z and the lumped
              // port assignment uses that Z too. When multiple conductors
              // exist, we expose one "Port @ <name>" entry per conductor
              // so the user can place ports on different metal levels.
              const portOptions = conductors.length <= 1
                ? [{ value: 'port', label: 'Port', conductorLayerId: conductors[0]?.id || null }]
                : conductors.map(l => ({
                    value: `port:${l.id}`,
                    label: `Port @ ${l.name || l.id}`,
                    conductorLayerId: l.id,
                  }));
              const layerOptions = [
                { value: 'waveguide', label: 'Waveguide', conductorLayerId: null },
                ...conductors.map(l => ({ value: `electrode:${l.id}`, label: l.name || l.id, conductorLayerId: l.id })),
                ...portOptions,
              ];
              // Selected layer dropdown value. We encode the conductor's id
              // in the value string so distinct conductor layers are
              // distinguishable in a flat <select>. Ports use the same
              // `port:<id>` encoding when multiple conductors exist.
              const dropdownValue = activeLayer === 'electrode' && activeConductorLayerId
                ? `electrode:${activeConductorLayerId}`
                : activeLayer === 'port' && activeConductorLayerId && conductors.length > 1
                ? `port:${activeConductorLayerId}`
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
                } else if (v.startsWith('port:')) {
                  setActiveLayer('port');
                  setActiveConductorLayerId(v.slice('port:'.length));
                } else if (v === 'port') {
                  setActiveLayer('port');
                  // Single-conductor or no-conductor case: bind to the
                  // first conductor if one exists, else leave null
                  // (HFSS export falls back to h_wg in that case).
                  setActiveConductorLayerId(conductors[0]?.id || null);
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
              // current addMode targets the same (layer, shape) tuple
              // — and, when the layer binds to a conductor (electrode or
              // port-on-a-specific-metal), the same conductorLayerId.
              const layerBindsConductor = (l) => l === 'electrode' || l === 'port';
              const isShapeActive = (shape) => addMode
                && (addMode.layer === activeLayer)
                && (addMode.shape === shape)
                && (!layerBindsConductor(activeLayer) || addMode.conductorLayerId === activeConductorLayerId);
              const toggleShape = (shape) => {
                if (isShapeActive(shape)) {
                  setAddMode(null);
                } else {
                  setAddMode({
                    layer: activeLayer,
                    shape,
                    ...(shape === 'polygon' ? { n: polygonSides } : {}),
                    ...(layerBindsConductor(activeLayer) && activeConductorLayerId
                      ? { conductorLayerId: activeConductorLayerId }
                      : {}),
                  });
                  setSnapMode('idle');
                  setRulerMode(false);
                }
              };
              const baseBtn = 'flex items-center justify-center w-7 h-7 rounded';
              const activeRing = ' ring-2 ring-green-400';
              // Via tool (D4): click-to-place vertical interconnect. Only
              // meaningful when the stack has at least two non-substrate
              // layers to span. Defaults: layerFrom = waveguide layer (or
              // first conductor), layerTo = top conductor.
              const nonSubstrateLayers = (scene.stack || []).filter(l => l.role !== 'substrate');
              const viaEligible = nonSubstrateLayers.length >= 2;
              const viaDefaults = () => {
                const wgL = (scene.stack || []).find(l => l.role === 'waveguide');
                const from = wgL || conductors[0] || nonSubstrateLayers[0] || null;
                const to = [...conductors].reverse().find(l => !from || l.id !== from.id)
                  || [...nonSubstrateLayers].reverse().find(l => !from || l.id !== from.id)
                  || null;
                return { layerFrom: from?.id || null, layerTo: to?.id || null };
              };
              const isViaActive = !!(addMode && addMode.shape === 'via');
              const toggleVia = () => {
                if (isViaActive) { setAddMode(null); return; }
                setAddMode({ layer: 'via', shape: 'via', ...viaDefaults() });
                setSnapMode('idle');
                setRulerMode(false);
              };
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
                      <option key={o.value} value={o.value} style={{ background: 'var(--app-slate-800)', color: 'var(--app-slate-200)' }}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                  <button
                    key="add-rect"
                    onClick={() => toggleShape('rect')}
                    className={baseBtn + (isShapeActive('rect') ? activeRing : '')}
                    style={{ background: 'var(--app-slate-800)', color: 'var(--app-slate-200)' }}
                    title="Add rectangle — drag on canvas to size."
                  >
                    <Square size={13} />
                  </button>
                  <button
                    key="add-circle"
                    onClick={() => toggleShape('circle')}
                    className={baseBtn + (isShapeActive('circle') ? activeRing : '')}
                    style={{ background: 'var(--app-slate-800)', color: 'var(--app-slate-200)' }}
                    title="Add circle — drag a bbox; an inscribed circle is created."
                  >
                    <Circle size={13} />
                  </button>
                  <button
                    key="add-ellipse"
                    onClick={() => toggleShape('ellipse')}
                    className={baseBtn + (isShapeActive('ellipse') ? activeRing : '')}
                    style={{ background: 'var(--app-slate-800)', color: 'var(--app-slate-200)' }}
                    title="Add ellipse — drag a bbox; the inscribed ellipse fills it."
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <ellipse cx="12" cy="12" rx="10" ry="6" />
                    </svg>
                  </button>
                  <button
                    key="add-polyline"
                    onClick={() => toggleShape('polyline')}
                    className={baseBtn + (isShapeActive('polyline') ? activeRing : '')}
                    style={{ background: 'var(--app-slate-800)', color: 'var(--app-slate-200)' }}
                    title="Polyline trace — click to place each vertex; double-click or Enter to finish, Esc to cancel. Press 'a' while drawing to toggle ARC mode (next click places a 90° arc — HFSS AngularArc, fully parametric). Snap halos appear on other shapes' anchors; cursor aligns with previous vertices on H/V axes (purple guides). The trace's width is a parameter and the Z extrusion is the bound conductor's thickness — HFSS sees it as CreatePolyline + sweep, fully parametric. Per-vertex taper widths, arcs, and spline runs are editable in the inspector."
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="3,18 9,8 14,14 21,4" />
                      <circle cx="3" cy="18" r="1.5" fill="currentColor" />
                      <circle cx="9" cy="8" r="1.5" fill="currentColor" />
                      <circle cx="14" cy="14" r="1.5" fill="currentColor" />
                      <circle cx="21" cy="4" r="1.5" fill="currentColor" />
                    </svg>
                  </button>
                  <button
                    key="add-polyshape"
                    onClick={() => toggleShape('polyshape')}
                    className={baseBtn + (isShapeActive('polyshape') ? activeRing : '')}
                    style={{ background: 'var(--app-slate-800)', color: 'var(--app-slate-200)' }}
                    title="Polygon path (closed 2-D shape) — click each vertex; double-click, Enter, or click vertex 0 to close. Same snap halos, H/V axis guides, and shift-lock as the polyline tool — but the result is a filled polygon (not a swept band), with no trace width. HFSS export emits CreatePolyline + sweep for a polygonal sheet."
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" fillOpacity="0.35" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polygon points="4,7 12,2 20,7 18,18 6,18" />
                      <circle cx="4" cy="7" r="1.5" fill="currentColor" />
                      <circle cx="12" cy="2" r="1.5" fill="currentColor" />
                      <circle cx="20" cy="7" r="1.5" fill="currentColor" />
                      <circle cx="18" cy="18" r="1.5" fill="currentColor" />
                      <circle cx="6" cy="18" r="1.5" fill="currentColor" />
                    </svg>
                  </button>
                  <div className="flex items-center gap-0.5">
                    <button
                      key="add-poly"
                      onClick={() => toggleShape('polygon')}
                      className={baseBtn + (isShapeActive('polygon') ? activeRing : '')}
                      style={{ background: 'var(--app-slate-800)', color: 'var(--app-slate-200)' }}
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
                  <button
                    key="add-via"
                    onClick={toggleVia}
                    disabled={!viaEligible}
                    className={baseBtn + (isViaActive ? activeRing : '') + (viaEligible ? '' : ' opacity-40 cursor-not-allowed')}
                    style={{ background: 'var(--app-slate-800)', color: 'var(--app-slate-200)' }}
                    title={viaEligible
                      ? 'Add via — click on canvas to place a vertical interconnect (default r = 2 µm). Spans layerFrom → layerTo through the stack; both are editable in the inspector. HFSS sees a parametric CreateCylinder whose height is the live stack-thickness expression.'
                      : 'Via tool needs at least two non-substrate layers in the stack (something to connect).'}
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <circle cx="12" cy="12" r="9" />
                      <circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none" />
                    </svg>
                  </button>
                </>
              );
            })()}
            <button
              onClick={() => { setSnapMode(snapMode === 'creating' ? 'idle' : 'creating'); setAddMode(null); setRulerMode(false); }}
              className={`flex items-center gap-1 px-2 py-1 rounded text-xs font-medium ${snapMode === 'creating' ? 'ring-2 ring-amber-400' : ''}`}
              style={{ background: snapMode === 'creating' ? '#f59e0b' : 'var(--app-slate-700)', color: snapMode === 'creating' ? '#0f172a' : 'var(--app-slate-200)' }}
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
              style={{ background: rulerMode ? '#06b6d4' : 'var(--app-slate-700)', color: rulerMode ? '#0f172a' : 'var(--app-slate-200)' }}
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
                { label: 'pyAEDT (basic)', icon: Download, onClick: handleExportPyAEDT, hint: 'layout.py', title: 'External Python with pyaedt installed (run from terminal: python layout.py). Basic export — numeric positions, single-conductor assumptions. For full parametric fidelity use HFSS native.' },
                { label: 'HFSS native', icon: Download, onClick: handleExportHfssNative, hint: 'layout_hfss.py', title: 'Native HFSS COM script (run inside HFSS via Tools -> Run Script)' },
                { label: '2-line method (εeff & α)', icon: Ruler, onClick: () => setShowTwoLineWizard(true), hint: 'wizard', title: "Marks' 2-line method: stamp this line at two lengths and emit a native HFSS script that extracts effective permittivity and attenuation directly in HFSS." },
                { label: 'GDS-II', icon: Download, onClick: handleExportGDS, hint: 'layout.gds', title: 'Binary GDS-II layout. Layers: waveguide=1, conductors=10+ (one per stack layer), port=100. Coords in µm with 1nm database resolution.' },
                { label: 'gdsfactory', icon: Download, onClick: handleExportGdsfactory, hint: 'layout_gf.py', title: 'Parametric @gf.cell Python function. Every scene parameter becomes a kwarg with its current value as default — call the function with overrides to sweep params in Python.' },
                { divider: true },
                { label: 'SVG figure', icon: Download, onClick: handleExportSVG, hint: 'layout.svg', title: 'Clean vector SVG of the current scene (no UI chrome). Tight bbox + 5% padding; boolean compositing preserved via <mask> elements. Opens in any browser, Inkscape, Illustrator.' },
                { label: 'PDF figure', icon: Download, onClick: handleExportPDF, hint: 'layout.pdf', title: 'Vector PDF of the current scene (no UI chrome). Native PDF 1.4 emitter — no library dependency. Page sized so the longest dimension is ≤ 500 pt (~7 in). Booleans flatten to operand polygons; for true polygon-clip output, edit the SVG figure in Inkscape and re-export.' },
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
            {/* Settings & appearance — theme picker + canvas view prefs,
                with JSON export/import and restore-defaults. */}
            <button
              onClick={() => setShowSettings(true)}
              className="flex items-center justify-center w-7 h-7 rounded-full border border-slate-600 hover:bg-slate-800 hover:border-slate-400 text-slate-400 hover:text-slate-100 ml-1"
              title="Settings & appearance"
              aria-label="Settings"
            >
              <Settings size={14} />
            </button>
            {/* AI geometry assistant — describe a structure in plain
                language (or paste a sketch) and Claude generates a
                parametric fragment that inserts like a template. */}
            <button
              onClick={() => setShowAiAssistant(true)}
              className="flex items-center justify-center w-7 h-7 rounded-full border border-slate-600 hover:bg-slate-800 hover:border-violet-500 text-slate-400 hover:text-violet-300 ml-1"
              title="AI geometry assistant — describe or sketch a structure, get parametric geometry"
              aria-label="AI geometry assistant"
            >
              <Sparkles size={14} />
            </button>
            {/* Help / tutorial — opens an animated walkthrough of the
                app's main capabilities (stack, drawing, params, snap,
                ops, save/versions, library, dimensions, export). */}
            <button
              onClick={() => setShowHelp(true)}
              className="flex items-center justify-center w-7 h-7 rounded-full border border-slate-600 hover:bg-slate-800 hover:border-cyan-500 text-slate-400 hover:text-cyan-300 ml-1"
              title="Show me how this works (animated tutorial)"
              aria-label="Help"
            >
              <HelpCircle size={14} />
            </button>
          </div>
        </div>
        {/* Row 2 — secondary tools and view controls */}
        <div className="flex items-center justify-between px-4 py-1.5 border-t border-slate-800" style={{ background: 'var(--app-slate-950)' }}>
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
                { label: 'Punch', icon: Minus, onClick: () => createBoolean('punch'), hint: `${selectedIds.size} selected`, title: 'Same as Subtract, but the tool shapes are kept (the hole is cut into the FIRST shape, the others remain visible and exportable). HFSS export uses Subtract with KeepOriginals=True.' },
                { divider: true },
                { label: 'Manage in BOOL panel…', icon: Combine, onClick: () => setActivePanel('booleans'), title: 'Open the BOOL panel to view/edit/toggle all boolean operations defined in this scene.' },
              ]}
            />
            <button
              onClick={diagnoseScene}
              className="flex items-center gap-1 px-2 py-1 rounded text-xs font-medium"
              style={{ background: sceneIssues.length > 0 ? '#dc2626' : 'var(--app-slate-700)', color: 'var(--app-slate-200)' }}
              title={sceneIssues.length === 0
                ? 'Validate scene: check for snap conflicts, orphans, cycles, broken expressions'
                : `${sceneIssues.length} issue${sceneIssues.length === 1 ? '' : 's'} detected — click to diagnose\n${sceneIssues.slice(0, 8).map(it => `• ${it.message}`).join('\n')}${sceneIssues.length > 8 ? '\n…' : ''}`}
            >
              <AlertTriangle size={11} /> diagnose{sceneIssues.length > 0 ? ` (${sceneIssues.length})` : ''}
            </button>
            {rulerMeasurements.length > 0 && (
              <button
                onClick={() => { setRulerMeasurements([]); setRulerInProgress(null); }}
                className="flex items-center gap-1 px-2 py-1 rounded text-xs"
                style={{ background: 'var(--app-slate-700)', color: 'var(--app-slate-200)' }}
                title={`Clear ${rulerMeasurements.length} measurement${rulerMeasurements.length === 1 ? '' : 's'}`}
              >
                <Trash2 size={11} /> clear ({rulerMeasurements.length})
              </button>
            )}
            <div className="w-px h-5 bg-slate-700 mx-1" />
            {/* Grid VISIBILITY toggle — separate concern from snap. Hide the
                background grid for cleaner screenshots / vector exports
                without losing snap behavior. */}
            <button
              onClick={() => setShowGrid(g => !g)}
              className={`flex items-center justify-center w-7 h-7 rounded text-xs ${showGrid ? 'bg-slate-700 text-slate-200 hover:bg-slate-600' : 'bg-slate-800 text-slate-500 hover:text-slate-300 border border-slate-700'}`}
              title={showGrid ? 'Hide background grid (snap stays unaffected)' : 'Show background grid'}
              aria-label={showGrid ? 'Hide grid' : 'Show grid'}
            >
              {showGrid ? <Eye size={11} /> : <EyeOff size={11} />}
            </button>
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
              className="w-12 bg-slate-800 border border-slate-700 rounded px-1 py-0.5 text-xs text-slate-100 outline-none"
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
            {/* Per-design export moved to a download icon on each version (incl.
                current) in the SAVED DESIGNS list; design import lives in that
                panel's footer. */}
          </div>
        </div>
      </header>

      {/* Workspace switcher dialog */}
      {showWorkspaceDialog && (
        <div className="fixed inset-0 z-40 flex items-center justify-center" style={{ background: 'rgba(15,23,42,0.6)' }} onClick={() => setShowWorkspaceDialog(false)}>
          <div className="rounded-lg shadow-2xl border border-slate-700 w-[28rem] max-w-[90vw] overflow-hidden" style={{ background: 'var(--app-slate-900)' }} onClick={(e) => e.stopPropagation()}>
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
                      <span className="font-mono text-xs flex-1 truncate" style={{ color: isCurrent ? '#67e8f9' : 'var(--app-slate-300)' }}>{label}</span>
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
        <div className="absolute z-30 right-4 top-12 w-80 rounded-lg shadow-2xl border border-slate-700 overflow-hidden" style={{ background: 'var(--app-slate-900)' }}>
          <div className="px-3 py-2 border-b border-slate-700 flex items-center justify-between">
            <span className="text-xs font-medium uppercase tracking-wider text-slate-400">Saved Designs ({savedList.length})</span>
            <button onClick={() => setShowDesigns(false)} className="text-slate-500 hover:text-slate-200 text-xs">✕</button>
          </div>
          <div className="px-3 py-2 border-b border-slate-700 flex items-center gap-2">
            <input
              type="text"
              value={designName}
              onChange={(e) => { setDesignName(e.target.value); setSaveStatus('unsaved'); }}
              // Trim on commit so the name settles to exactly what's stored as
              // the design key (leading/trailing whitespace would otherwise make
              // designName diverge from the storage key — phantom autosaves and
              // a spurious "discard?" prompt on switch). Mid-name spaces are kept.
              onBlur={() => { const t = designName.trim(); if (t && t !== designName) setDesignName(t); }}
              className="flex-1 bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs font-mono text-cyan-300 outline-none focus:border-cyan-400"
              placeholder="design name"
            />
            <button
              onClick={handleSave}
              className="px-2 py-1 rounded text-xs font-medium"
              style={{ background: '#22c55e', color: '#0f172a' }}
              title="Save the current state to the active design (Cmd+S). Updates `updatedAt`; doesn't add a version."
            >save</button>
            <button
              onClick={handleSnapshot}
              className="px-2 py-1 rounded text-xs font-medium"
              style={{ background: '#06b6d4', color: '#0f172a' }}
              title="Commit the current state as a new VERSION (snapshot). Prompts for a short description. Each snapshot gets a unique id and version number, like a git commit."
            >snapshot</button>
          </div>
          <div className="max-h-96 overflow-y-auto">
            {savedList.length === 0 && <p className="text-xs text-slate-500 italic px-3 py-3">No saved designs yet.</p>}
            {savedList.map(name => {
              const isCurrent = name === designName;
              const isExpanded = expandedDesigns.has(name);
              // For the active design pull versions + current-version
              // pointer from React state (kept in sync with edits and
              // snapshots); for others read the lazy-loaded cache.
              const cached = versionsByDesign[name];
              const vlist = isCurrent
                ? sortedVersions(versions)
                : (cached ? cached.versions : []);
              const activeCurId = isCurrent ? currentVersionId : (cached ? cached.currentVersionId : null);
              // Find the "current" version entry so we can render
              // its short id / vN chip in the row header.
              const activeVer = activeCurId
                ? vlist.find(v => v.id === activeCurId)
                : null;
              // Drift indicator: scene-vs-snapshot deep-equal check
              // for the active design (we have the live state to
              // diff against). Other rows just show the snapshot chip
              // without a "modified" tag. Note this is distinct from
              // saveStatus: you can save the working state (saveStatus
              // = 'saved') and still be modified relative to the
              // snapshot — Save just persists, it doesn't snapshot.
              const isModified = isCurrent && currentIsModified && activeCurId;
              // "Has unsnapshotted edits" for ANY design — the ACTIVE one via the
              // live drift check, others via their cached `modified` flag. Drives
              // the "current" working-state row + a chip marker so a design's
              // in-progress state stays VISIBLE after you switch away from it
              // (the active-design cues — green ● + row background — stay
              // exclusive, so it's still clear which design is loaded).
              const rowModified = !!activeCurId && (isCurrent ? currentIsModified : !!(cached && cached.modified));
              return (
                <div key={name} className={`border-b border-slate-800 border-l-2 ${isCurrent ? 'bg-emerald-500/10 border-l-emerald-400' : 'border-l-transparent'}`}>
                  <div className={`flex items-center gap-1 px-3 py-1.5 ${isCurrent ? '' : 'hover:bg-slate-800/60'}`}>
                    <button
                      onClick={() => toggleDesignExpanded(name)}
                      className="text-slate-500 hover:text-slate-200 w-3 flex-shrink-0"
                      title={isExpanded ? 'Collapse versions' : 'Show versions'}
                    >{isExpanded ? '▾' : '▸'}</button>
                    <button onClick={() => { handleLoad(name); setShowDesigns(false); }} className="flex-1 text-left text-xs font-mono text-slate-200 hover:text-cyan-300 truncate flex items-center gap-1 min-w-0">
                      {isCurrent
                        ? <span className="flex-shrink-0 inline-flex items-center gap-1 px-1 py-px rounded text-[8px] font-bold uppercase tracking-wide bg-emerald-500/25 text-emerald-200 border border-emerald-400/60" title="This is the design you're currently working on">● active</span>
                        : null}
                      <span className={`truncate ${isCurrent ? 'text-emerald-100 font-semibold' : ''}`}>{name}</span>
                      {activeVer && (
                        <span
                          className={`flex-shrink-0 inline-flex items-center gap-1 px-1 py-px rounded text-[9px] font-mono ${
                            rowModified
                              // ANY design with unsnapshotted edits → amber "*"
                              // (which design is ACTIVE is shown by the green ● +
                              // row background, so amber here reads as "modified",
                              // not "current/active").
                              ? 'bg-amber-900/40 text-amber-300 border border-amber-700'
                              : isCurrent
                                // Active design sitting exactly on a snapshot.
                                ? 'bg-cyan-900/40 text-cyan-300 border border-cyan-800'
                                // Other design, on a snapshot — neutral.
                                : 'bg-slate-800 text-slate-500 border border-slate-700'
                          }`}
                          title={
                            (isCurrent ? 'On' : 'Last left on') +
                            ` v${activeVer.versionNumber} (${activeVer.id})${
                              activeVer.description ? `: ${activeVer.description}` : ''
                            }${rowModified ? ' · has unsnapshotted edits' : ''}`
                          }
                        >
                          @v{activeVer.versionNumber}
                          {rowModified && <span className="opacity-80">*</span>}
                        </span>
                      )}
                    </button>
                    {vlist.length > 0 && (
                      <span className="text-[9px] text-slate-500 mr-1" title={`${vlist.length} snapshot${vlist.length === 1 ? '' : 's'}`}>
                        ({vlist.length})
                      </span>
                    )}
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
                    <button
                      onClick={() => handleExportDesign(name)}
                      className="text-slate-500 hover:text-cyan-400"
                      title="Export this design (with all snapshots) as a .json file"
                    >
                      <Download size={11} />
                    </button>
                    <button onClick={() => handleDeleteDesign(name)} className="text-slate-500 hover:text-red-400" title="Delete">
                      <Trash2 size={11} />
                    </button>
                  </div>
                  {isExpanded && (
                    <div className="pl-6 pr-2 pb-1.5 border-l-2 border-cyan-900/40 ml-3 mb-1">
                      {/* Synthetic "current" virtual row — shown for ANY design
                          whose working state has drifted from its
                          currentVersionId snapshot, not just the active one, so
                          a design's unsnapshotted "current" state stays listed
                          after you switch away from it. For the ACTIVE design it
                          is the live working state (with a snapshot button); for
                          another design it represents that design's stored
                          working state — clicking it returns to (loads) that
                          design's working state. */}
                      {rowModified && activeVer && (
                        <div
                          className={`flex items-start gap-1 py-1 rounded px-1 border-l-2 -ml-px group ${
                            isCurrent
                              // ACTIVE design's live working state — full-strength amber.
                              ? 'bg-amber-900/20 border-amber-400'
                              // Another design's stored working state — muted, so the
                              // active design's "current" row is the one that stands out.
                              : 'bg-slate-800/30 border-amber-700/40'
                          }`}
                        >
                          <button
                            type="button"
                            onClick={isCurrent ? undefined : () => { handleLoad(name); setShowDesigns(false); }}
                            disabled={isCurrent}
                            className="flex-1 text-left min-w-0 disabled:cursor-default"
                            title={isCurrent
                              ? 'Your in-progress working state (not yet snapshotted)'
                              : `Return to "${name}"'s unsnapshotted working state`}
                          >
                            <div className="flex items-center gap-1.5 text-[10px] font-mono">
                              <span className="text-amber-300 font-bold" title="Working state — not yet snapshotted">●</span>
                              <span className="text-amber-300 font-bold">current</span>
                              <span className="text-slate-500">·</span>
                              <span className="text-slate-500" title={`Based on v${activeVer.versionNumber} (${activeVer.id.slice(0, 7)})`}>
                                modified since v{activeVer.versionNumber}
                              </span>
                            </div>
                            <div className="text-[10px] text-slate-400 italic truncate mt-0.5">
                              {isCurrent
                                ? <>Working state — click <span className="text-cyan-300 font-mono not-italic">snapshot</span> above to save as a new version.</>
                                : <>Unsnapshotted working state — click to return to it.</>}
                            </div>
                          </button>
                          <button
                            onClick={() => handleDownloadVersion(name, null)}
                            className="text-slate-500 hover:text-cyan-400 opacity-0 group-hover:opacity-100 transition-opacity p-0.5 flex-shrink-0"
                            title="Download the current working state as a design .json file"
                          >
                            <Download size={10} />
                          </button>
                          {isCurrent && (
                            <button
                              onClick={handleSnapshot}
                              className="text-[9px] px-1.5 py-0.5 rounded bg-cyan-800/60 hover:bg-cyan-700 text-cyan-100 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
                              title="Commit the current state as a new snapshot"
                            >
                              snapshot
                            </button>
                          )}
                        </div>
                      )}
                      {vlist.length === 0 ? (
                        <p className="text-[10px] text-slate-500 italic py-1">
                          No snapshots yet — click <span className="font-mono text-cyan-400">snapshot</span> to commit a version.
                        </p>
                      ) : (
                        vlist.map(v => {
                          // Compact date label: today → time only, else "MMM d HH:mm".
                          const dt = new Date(v.savedAt || 0);
                          const now = new Date();
                          const sameDay = dt.toDateString() === now.toDateString();
                          const dateLabel = sameDay
                            ? dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                            : dt.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
                          // Highlight the version the working state is
                          // currently on. When `isModified` is true the
                          // synthetic "current" row above represents
                          // the live state instead, and this real row
                          // becomes just the version we're "based on"
                          // — toned-down highlight, no ● bullet (the
                          // bullet lives on the synthetic row).
                          // The "current version" cue (cyan highlight + ● bullet)
                          // is EXCLUSIVE to the ACTIVE design — a non-current
                          // design's cached pointer must not paint a version row
                          // as "current", or several designs look active at once.
                          const isCurVer = isCurrent && v.id === activeCurId;
                          const isBasedOn = isCurVer && isModified; // synthetic current is the bullet holder
                          const isExactlyOn = isCurVer && !isModified;
                          return (
                            <div
                              key={v.id}
                              className={`flex items-start gap-1 py-1 rounded px-1 group ${
                                isExactlyOn
                                  ? 'bg-cyan-900/30 border-l-2 border-cyan-400 -ml-px'
                                  : isBasedOn
                                    ? 'bg-cyan-900/10'
                                    : 'hover:bg-slate-800/50'
                              }`}
                            >
                              <button
                                onClick={() => { handleLoadVersion(name, v.id); setShowDesigns(false); }}
                                className="flex-1 text-left min-w-0"
                                title={`Load version ${v.versionNumber} (${v.id}) into the working state.${isExactlyOn ? ' (Currently on this version.)' : isBasedOn ? ' (Working state is based on this — loading it will discard your unsnapshotted edits.)' : ''}`}
                              >
                                <div className="flex items-center gap-1.5 text-[10px] font-mono">
                                  {isExactlyOn && (
                                    <span className="text-cyan-300 font-bold" title="Currently on this version">●</span>
                                  )}
                                  <span className={isExactlyOn ? 'text-cyan-300 font-bold' : 'text-cyan-400'}>v{v.versionNumber}</span>
                                  <span className="text-slate-500">{v.id.slice(0, 7)}</span>
                                  <span className="text-slate-500">·</span>
                                  <span className="text-slate-500">{dateLabel}</span>
                                  {isBasedOn && (
                                    <span className="text-amber-400 ml-1" title="Working state is based on this snapshot but has unsnapshotted edits — see the 'current' row above">· based on</span>
                                  )}
                                </div>
                                {v.description ? (
                                  <div className="text-[10px] text-slate-300 truncate mt-0.5">{v.description}</div>
                                ) : (
                                  <div className="text-[10px] text-slate-600 italic truncate mt-0.5">(no description)</div>
                                )}
                              </button>
                              <button
                                onClick={() => handleEditVersionDescription(name, v.id)}
                                className="text-slate-600 hover:text-cyan-400 opacity-0 group-hover:opacity-100 transition-opacity p-0.5"
                                title="Edit this version's description"
                              >
                                <Pencil size={10} />
                              </button>
                              <button
                                onClick={() => handleDownloadVersion(name, v.id)}
                                className="text-slate-600 hover:text-cyan-400 opacity-0 group-hover:opacity-100 transition-opacity p-0.5"
                                title={`Download v${v.versionNumber} as a design .json file (this snapshot's scene only)`}
                              >
                                <Download size={10} />
                              </button>
                              <button
                                onClick={() => handleDeleteVersion(name, v.id)}
                                className="text-slate-600 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity p-0.5"
                                title="Delete this version"
                              >
                                <Trash2 size={10} />
                              </button>
                            </div>
                          );
                        })
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <div className="px-3 py-2 border-t border-slate-700 flex items-center justify-between gap-2 text-[10px] text-slate-500">
            <span className="truncate">Cmd+S · snapshot · ⇧Cmd+S = save as</span>
            <button
              onClick={handleImportDesignFromFile}
              className="flex items-center gap-1 px-1.5 py-0.5 rounded border border-slate-600 hover:border-cyan-400 hover:text-cyan-300 text-slate-400 flex-shrink-0"
              title="Import a single design from a .json file (with all its snapshots). Per-row ⬇ on each design exports the same format."
            >
              <Upload size={10} /> Import design…
            </button>
          </div>
        </div>
      )}

      <div className="flex-1 flex overflow-hidden">
        {/* LEFT */}
        <div className="w-72 border-r border-slate-700 flex flex-col" style={{ background: 'var(--app-slate-900)' }}>
          <div className="flex flex-wrap border-b border-slate-700 text-[10px]">
            {[
              { id: 'params', label: 'PARAMS', icon: Settings2 },
              { id: 'layers', label: 'LAYERS', icon: Layers },
              { id: 'shapes', label: 'SHAPES', icon: Square },
              { id: 'snaps', label: 'SNAPS', icon: Link2 },
              { id: 'mirrors', label: 'MIRRORS', icon: FlipHorizontal },
              { id: 'library', label: 'LIBRARY', icon: BookOpen },
              { id: 'setup', label: 'SETUP', icon: Radio },
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
                {/* C7a: search box — substring filter on name + description,
                    case-insensitive. Filtering happens BEFORE grouping, so
                    groups naturally dissolve to a flat list when fewer than
                    4 members match. add/cleanup keep acting on the FULL
                    param list regardless of the filter. */}
                <div className="relative mb-1">
                  <Search size={11} className="absolute left-1.5 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none" />
                  <input
                    value={paramSearch}
                    onChange={(e) => setParamSearch(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Escape') { setParamSearch(''); e.target.blur(); } }}
                    placeholder="filter params (name or description)…"
                    className="w-full bg-slate-900 border border-slate-700 rounded pl-6 pr-5 py-1 text-[11px] font-mono text-slate-100 outline-none focus:border-cyan-400 placeholder:text-slate-600"
                    spellCheck={false}
                  />
                  {paramSearch && (
                    <button
                      onClick={() => setParamSearch('')}
                      className="absolute right-1 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300"
                      title="clear filter"
                    >
                      <XIcon size={11} />
                    </button>
                  )}
                </div>
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
                {(() => {
                  // One renderer shared by grouped and flat rows so the
                  // sweep chips, error icons, and involved-highlight render
                  // identically inside groups.
                  const renderParamRow = (name, p) => (
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
                      onCommitExpr={(v) => {
                        // Default newly-created idents to the CURRENT
                        // evaluated value of THIS parameter, so renaming
                        // `cap_d = 60` to `cap_d = big_cap_d` produces
                        // `big_cap_d = 60` (keeps the layout intact).
                        const prevEval = paramValues[name];
                        const prevDefault = Number.isFinite(prevEval) ? String(prevEval) : '0';
                        commitExpr(v, prevDefault, scene.params[name]?.unit || 'µm', `Auto-created (used by ${name})`, name);
                      }}
                      suggestions={paramNames.filter(n => n !== name)}
                      onUpdateUnit={(v) => updateParam(name, { unit: v })}
                      onUpdateDesc={(v) => updateParam(name, { desc: v })}
                      onUpdateSweep={(sw) => updateParam(name, { sweep: sw })}
                      onDelete={() => deleteParam(name)}
                      nameWidth={paramNameWidth}
                      onStartNameResize={startParamNameResize}
                    />
                  );
                  const q = paramSearch.trim().toLowerCase();
                  const entries = Object.entries(scene.params).filter(([name, p]) =>
                    !q || name.toLowerCase().includes(q) || (p.desc || '').toLowerCase().includes(q));
                  const byName = Object.fromEntries(entries);
                  // C7b: prefix grouping — params sharing the prefix before
                  // the LAST underscore token form a collapsible section
                  // when the group has >= 4 members; everything else lists
                  // flat after the groups.
                  const { sections, flat } = groupParamPrefixes(entries.map(([n]) => n), 4);
                  return (
                    <>
                      {sections.map(({ prefix, names }) => {
                        const collapsed = collapsedParamGroups.has(prefix);
                        return (
                          <div key={`pgrp_${prefix}`} className="rounded border border-slate-700/70" style={{ background: 'rgba(15,23,42,0.45)' }}>
                            <button
                              onClick={() => toggleParamGroup(prefix)}
                              className="w-full flex items-center gap-1 px-1.5 py-1 text-left hover:bg-slate-800/60 rounded"
                              title={collapsed ? `Expand ${prefix}_* (${names.length} params)` : `Collapse ${prefix}_*`}
                            >
                              {collapsed ? <ChevronRight size={11} className="text-slate-500 shrink-0" /> : <ChevronDown size={11} className="text-slate-500 shrink-0" />}
                              <span className="text-[11px] font-mono font-bold text-cyan-300 truncate">{prefix}_*</span>
                              <span className="text-[9px] text-slate-500 shrink-0">({names.length})</span>
                            </button>
                            {!collapsed && (
                              <div className="space-y-0.5 px-1 pb-1">
                                {names.map(n => renderParamRow(n, byName[n]))}
                              </div>
                            )}
                          </div>
                        );
                      })}
                      {flat.map(n => renderParamRow(n, byName[n]))}
                      {entries.length === 0 && (
                        <p className="text-xs text-slate-500 italic px-1 mt-1">
                          {q ? `No params match "${paramSearch.trim()}".` : 'No parameters yet — use add above.'}
                        </p>
                      )}
                    </>
                  );
                })()}
              </div>
            )}

            {activePanel === 'layers' && (
              <div className="space-y-2 text-xs">
                {/* Stack library: pick a saved stack to swap in, or save
                    the current one as a new entry. The dropdown reads
                    out the scene's stackName so the user can see which
                    stack they're wearing right now. */}
                <div className="rounded border border-slate-700 px-2 py-1.5" style={{ background: 'var(--app-slate-800)' }}>
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
                      // Guarded: role changes away from 'conductor' and
                      // conductor-layer deletes prompt when components
                      // still bind the layer via conductorLayerId.
                      updateScene={guardedStackUpdateScene}
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
                if (t.kind === 'mirror') return `Mirror(${t.axis || 'x'}, ${t.pivot || 'C'})${dis}`;
                if (t.kind === 'duplicate_mirror') return `DupMirror(${t.axis || 'x'}, offset=${t.offset ?? '0'})${dis}`;
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
                  ? `${c.op === 'union' ? 'Unite'
                      : c.op === 'intersect' ? 'Intersect'
                      : c.op === 'punch' ? 'Punch'
                      : 'Subtract'}(${(c.operandIds || []).join(', ')})`
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
                        {c.label || c.id}
                      </span>
                      {/* When the display label differs from the component id,
                          show the id in a small muted mono chip — expressions,
                          snaps and exports all reference the id, so it must
                          stay visible even on renamed/labeled rows. */}
                      {c.label && c.label !== c.id && (
                        <span className="text-[9px] font-mono text-slate-500 truncate flex-shrink min-w-0" title={`component id: ${c.id}`}>
                          {c.id}
                        </span>
                      )}
                      {isBoolean && (
                        <span className="text-[9px] uppercase font-bold tracking-wider flex-shrink-0" style={{ color: accent + 'cc' }}>
                          {c.op}
                        </span>
                      )}
                      <span className="px-1 py-0 rounded text-[9px] font-mono flex-shrink-0" style={{ background: layerSwatches[c.layer]?.bg, color: layerSwatches[c.layer]?.fg }}>
                        {c.layer}
                      </span>
                      {c.kind === 'polyline' && polylineIsTapered(c) && (
                        <span
                          className="text-[8px] uppercase font-bold tracking-wider flex-shrink-0 text-amber-400"
                          title="Tapered trace: one or more vertices carry a per-vertex width — rendered/exported as per-segment quads"
                        >taper</span>
                      )}
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
                            (they're prerequisites in HFSS history order).
                            For 'punch' the tool operands aren't consumed —
                            they appear standalone at the top level, so here
                            we only nest operands whose consumedBy points
                            back at THIS boolean. The non-consumed tools are
                            shown as a one-line reference instead so the
                            user still sees what the punch uses. */}
                        {isBoolean && (c.operandIds || []).map(opid => {
                          const opC = byId[opid];
                          if (!opC) return (
                            <div key={opid} className="text-slate-600 italic">missing operand: {opid}</div>
                          );
                          if (opC.consumedBy !== c.id) {
                            return (
                              <div key={opid} className="text-slate-500 py-0.5">
                                <span className="text-slate-600">└─</span>{' '}
                                tool (kept): <span className="font-bold" style={{ color: accentFor(opC) }}>{opid}</span>
                              </div>
                            );
                          }
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
                    <button
                      onClick={() => createBoolean('punch')}
                      disabled={selectedIds.size < 2}
                      className="flex items-center gap-1 px-2 py-1 rounded text-[10px] border border-amber-700 hover:border-amber-500 disabled:opacity-30 text-amber-300"
                      title={selectedIds.size < 2 ? 'Select 2+' : 'Punch a hole in the first shape using the rest (tools kept)'}
                    >
                      <Minus size={10} /> ⌀
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
                  <div key={s.id} className="p-2 rounded text-xs border border-slate-700" style={{ background: 'var(--app-slate-800)' }}>
                    <div className="flex items-center gap-1 mb-1">
                      {/* C10: clicking either endpoint label flashes that
                          anchor on the canvas (cyan halo, ~1s). */}
                      <span className="font-mono text-[10px] text-cyan-300 truncate flex-1 min-w-0">
                        <button
                          onClick={() => flashAnchorOnCanvas(s.from.compId, s.from.anchor)}
                          className="hover:text-cyan-100 hover:underline"
                          title="Flash this anchor on the canvas"
                        >{s.from.compId}.{s.from.anchor}</button>
                        {' → '}
                        <button
                          onClick={() => flashAnchorOnCanvas(s.to.compId, s.to.anchor)}
                          className="hover:text-cyan-100 hover:underline"
                          title="Flash this anchor on the canvas"
                        >{s.to.compId}.{s.to.anchor}</button>
                      </span>
                      {/* Live-validation marker: this snap id appears in the
                          sceneIssues feed (orphan ref, duplicate target,
                          cycle, NaN offset, …). Hover for the message(s). */}
                      {snapIssuesById.has(s.id) && (
                        <span className="text-amber-400 shrink-0 cursor-help" title={snapIssuesById.get(s.id)}>
                          <AlertTriangle size={11} />
                        </span>
                      )}
                      <button onClick={() => deleteSnap(s.id)} className="text-slate-500 hover:text-red-400 shrink-0"><Link2Off size={11} /></button>
                    </div>
                    <div className="grid grid-cols-2 gap-1 mt-1">
                      <div>
                        <label className="text-[9px] text-slate-500">dx</label>
                        <DeferredTextInput
                          autoGrow
                          value={s.dx}
                          suggestions={paramNames}
                          onCommit={(v) => {
                            const prevEval = evalExpr(s.dx, paramValues);
                            const prevDefault = Number.isFinite(prevEval) ? String(prevEval) : '0';
                            updateSnap(s.id, { dx: v });
                            commitExpr(v, prevDefault, 'µm', `Snap ${s.id} dx`);
                          }}
                          className="w-full bg-slate-900 border border-slate-700 rounded px-1 py-0.5 text-[10px] font-mono text-slate-100 outline-none focus:border-cyan-400 whitespace-pre-wrap break-words leading-tight"
                          spellCheck={false}
                        />
                      </div>
                      <div>
                        <label className="text-[9px] text-slate-500">dy</label>
                        <DeferredTextInput
                          autoGrow
                          value={s.dy}
                          suggestions={paramNames}
                          onCommit={(v) => {
                            const prevEval = evalExpr(s.dy, paramValues);
                            const prevDefault = Number.isFinite(prevEval) ? String(prevEval) : '0';
                            updateSnap(s.id, { dy: v });
                            commitExpr(v, prevDefault, 'µm', `Snap ${s.id} dy`);
                          }}
                          className="w-full bg-slate-900 border border-slate-700 rounded px-1 py-0.5 text-[10px] font-mono text-slate-100 outline-none focus:border-cyan-400 whitespace-pre-wrap break-words leading-tight"
                          spellCheck={false}
                        />
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
                  <div key={m.id} className="p-2 rounded text-xs border border-slate-700" style={{ background: 'var(--app-slate-800)' }}>
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

                {/* CELLS — parametric cell definitions: define once,
                    instantiate many, update all. Defs live per-workspace
                    (like library items) AND in scene.cells so shared
                    designs stay self-contained. An instance is a fully
                    prefixed copy: its knobs are the <prefix>_* params. */}
                <div className="border-t border-slate-800 pt-2 mt-2">
                  <p className="text-[10px] uppercase tracking-wider text-slate-500 px-1 mb-1">Cells</p>
                  <button
                    onClick={saveSelectionAsCell}
                    disabled={selectedIds.size === 0}
                    className="w-full flex items-center justify-center gap-1 px-2 py-1 mb-1 rounded text-xs border border-dashed border-slate-600 hover:border-violet-400 disabled:opacity-30 disabled:cursor-not-allowed text-slate-300"
                    title={selectedIds.size === 0
                      ? 'Select components first'
                      : `Save ${selectedIds.size} component${selectedIds.size === 1 ? '' : 's'} as a parametric cell (overwrite an existing name to edit its master)`}
                  >
                    <Save size={11} /> save selection as cell… ({selectedIds.size})
                  </button>
                  {cellNames.length === 0 && (
                    <p className="text-[10px] text-slate-500 italic px-1">No cells yet. Select components and save them as a cell to stamp reusable, parametric instances.</p>
                  )}
                  <div className="space-y-1">
                    {cellNames.map(name => {
                      const def = cellDefs[name];
                      const nParams = Object.keys(def?.params || {}).length;
                      const nInst = cellInstanceCounts[name]?.size || 0;
                      return (
                        <div
                          key={name}
                          className="rounded border border-slate-800 px-2 py-1.5 flex items-center gap-2"
                          style={{ background: 'rgba(30,41,59,0.5)' }}
                        >
                          <Boxes size={11} className="text-violet-400 flex-shrink-0" />
                          <div className="flex-1 min-w-0">
                            <p className="font-mono text-xs text-violet-300 truncate">{name}</p>
                            <p className="text-[9px] text-slate-500 truncate">
                              {nParams} param{nParams === 1 ? '' : 's'} · {nInst} instance{nInst === 1 ? '' : 's'} in design
                            </p>
                          </div>
                          <button
                            onClick={() => insertCell(name)}
                            className="text-[10px] px-2 py-0.5 rounded border border-violet-700 text-violet-300 hover:bg-violet-900/40"
                            title="Insert a new instance at the viewport center (prompts for an instance prefix)"
                          >
                            insert
                          </button>
                          <button
                            onClick={() => updateCellInstances(name)}
                            disabled={nInst === 0}
                            className="text-[10px] px-2 py-0.5 rounded border border-slate-600 text-slate-300 hover:bg-slate-800 disabled:opacity-30 disabled:cursor-not-allowed"
                            title={nInst === 0
                              ? 'No instances of this cell in the current design'
                              : 'Rebuild every instance from the master definition (param overrides + positions preserved; shows a change summary first)'}
                          >
                            update
                          </button>
                          <button
                            onClick={() => deleteCell(name)}
                            className="text-slate-500 hover:text-red-400"
                            title="Delete this cell definition (instances stay as plain components)"
                          >
                            <Trash2 size={10} />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                  {cellInsertHint && (
                    <p className="text-[9px] text-emerald-400 px-1 mt-1 leading-snug">{cellInsertHint}</p>
                  )}
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

            {activePanel === 'setup' && (() => {
              // HFSS / pyAEDT simulation-setup knobs.
              //   - fnominal (GHz): used by the auto-sized open-region
              //     radiation box. We display λ/4 in real units so the
              //     user knows how much radiation clearance is needed.
              //   - padXNeg / padXPos / padYNeg / padYPos (µm): per-
              //     face padding from the device-area bbox to the chip
              //     substrate edge. Symmetric pads → centered design.
              const fStr = (scene.simSetup && scene.simSetup.fnominal) || '4';
              const fNum = parseFloat(String(fStr).replace(/\s*ghz\s*$/i, '')) || 0;
              const c_mm_per_ns = 299.792458;
              const lambdaMm = fNum > 0 ? c_mm_per_ns / fNum : 0;
              const radPadMm = lambdaMm / 4;
              const radPadUm = radPadMm * 1000;
              const padXNegStr = (scene.simSetup && scene.simSetup.padXNeg) ?? '50';
              const padXPosStr = (scene.simSetup && scene.simSetup.padXPos) ?? '50';
              const padYNegStr = (scene.simSetup && scene.simSetup.padYNeg) ?? '50';
              const padYPosStr = (scene.simSetup && scene.simSetup.padYPos) ?? '50';
              const airPadStr = (scene.simSetup && scene.simSetup.airPad) ?? '';
              const airPadNum = parseFloat(airPadStr);
              const airPadEffective = Number.isFinite(airPadNum) && airPadNum > 0
                ? airPadNum : radPadUm;
              const airPadIsOverride = Number.isFinite(airPadNum) && airPadNum > 0;
              const appendActive = !!(scene.simSetup && scene.simSetup.appendToActive);
              // Analysis / sweep knobs (see normalizeScene for the contract
              // defaults — these ?? fallbacks only matter for scenes that
              // bypassed normalize, e.g. mid-session legacy blobs).
              const solveFreqStr = (scene.simSetup && scene.simSetup.solveFreq) ?? '';
              const maxPassesStr = (scene.simSetup && scene.simSetup.maxPasses) ?? '12';
              const maxDeltaSStr = (scene.simSetup && scene.simSetup.maxDeltaS) ?? '0.02';
              const sweepEnabled = (scene.simSetup && scene.simSetup.sweepEnabled) ?? true;
              const sweepStartStr = (scene.simSetup && scene.simSetup.sweepStart) ?? '0.1';
              const sweepStopStr = (scene.simSetup && scene.simSetup.sweepStop) ?? '50';
              const sweepPointsStr = (scene.simSetup && scene.simSetup.sweepPoints) ?? '500';
              const sweepTypeStr = (scene.simSetup && scene.simSetup.sweepType) ?? 'Interpolating';
              const updateSim = (patch) => updateScene(prev => ({
                ...prev,
                simSetup: {
                  fnominal: '4', padXNeg: '50', padXPos: '50', padYNeg: '50', padYPos: '50',
                  solveFreq: '', maxPasses: '12', maxDeltaS: '0.02',
                  sweepEnabled: true, sweepStart: '0.1', sweepStop: '50', sweepPoints: '500', sweepType: 'Interpolating',
                  ...(prev.simSetup || {}), ...patch,
                },
              }));
              const PadField = ({ label, value, field }) => (
                <div className="flex items-center gap-2">
                  <label className="text-[10px] text-slate-400 w-12 text-right">{label}</label>
                  <input
                    type="text"
                    defaultValue={value}
                    key={value}
                    onBlur={(e) => updateSim({ [field]: e.target.value.trim() || '50' })}
                    onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); if (e.key === 'Escape') { e.target.value = value; e.target.blur(); } }}
                    className="w-20 px-1.5 py-1 rounded bg-slate-800 border border-slate-700 text-slate-200 text-xs font-mono"
                  />
                  <span className="text-[10px] text-slate-500">µm</span>
                </div>
              );
              // Same input semantics as PadField (blur/Enter commit, Escape
              // reverts) but with a per-field fallback + placeholder so
              // blank-allowed fields (solveFreq) and non-µm units work.
              const SimField = ({ label, value, field, fallback = '', placeholder = '', unit = '' }) => (
                <div className="flex items-center gap-2">
                  <label className="text-[10px] text-slate-400 w-24 text-right">{label}</label>
                  <input
                    type="text"
                    defaultValue={value}
                    key={value}
                    placeholder={placeholder}
                    onBlur={(e) => updateSim({ [field]: e.target.value.trim() || fallback })}
                    onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); if (e.key === 'Escape') { e.target.value = value; e.target.blur(); } }}
                    className="w-20 px-1.5 py-1 rounded bg-slate-800 border border-slate-700 text-slate-200 text-xs font-mono placeholder:text-slate-600"
                  />
                  {unit && <span className="text-[10px] text-slate-500">{unit}</span>}
                </div>
              );
              return (
                <div className="space-y-3">
                  <div>
                    <div className="text-[10px] uppercase tracking-wider text-slate-400 mb-1 flex items-center gap-1">
                      <Radio size={11} /> Open-region radiation boundary
                    </div>
                    <p className="text-[10px] text-slate-500 leading-snug mb-2">
                      HFSS wraps the geometry with an air box that has
                      Radiation boundaries on its outer faces. The box
                      is auto-sized to roughly λ/4 at the nominal
                      frequency you set below.
                    </p>
                    <label className="block text-[10px] text-slate-400 mb-0.5">f<sub>nominal</sub> (GHz)</label>
                    <input
                      type="text"
                      defaultValue={fStr}
                      key={fStr}
                      onBlur={(e) => updateSim({ fnominal: e.target.value.trim() || '4' })}
                      onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); if (e.key === 'Escape') { e.target.value = fStr; e.target.blur(); } }}
                      className="w-28 px-1.5 py-1 rounded bg-slate-800 border border-slate-700 text-slate-200 text-xs font-mono"
                    />
                  </div>
                  <div className="border-t border-slate-800 pt-2">
                    <div className="text-[10px] uppercase tracking-wider text-slate-400 mb-1">Radiation-box padding</div>
                    <div className="font-mono text-xs text-slate-300 leading-relaxed">
                      λ = {lambdaMm.toFixed(2)} mm<br />
                      λ/4 = <span className={airPadIsOverride ? 'text-slate-400' : 'text-cyan-300 font-bold'}>{radPadMm.toFixed(2)} mm</span> ({radPadUm.toFixed(0)} µm) {airPadIsOverride ? '(suggested)' : ''}
                    </div>
                    <div className="mt-2 flex items-center gap-2">
                      <label className="text-[10px] text-slate-400 w-28 text-right">Override (µm)</label>
                      <input
                        type="text"
                        defaultValue={airPadStr}
                        key={airPadStr}
                        placeholder="auto = λ/4"
                        onBlur={(e) => updateSim({ airPad: e.target.value.trim() })}
                        onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); if (e.key === 'Escape') { e.target.value = airPadStr; e.target.blur(); } }}
                        className="w-24 px-1.5 py-1 rounded bg-slate-800 border border-slate-700 text-slate-200 text-xs font-mono placeholder:text-slate-600"
                      />
                      <span className="text-[10px] text-slate-500">
                        {airPadIsOverride
                          ? <>using <span className="text-cyan-300 font-bold">{airPadEffective.toFixed(0)} µm</span></>
                          : <>blank → λ/4</>}
                      </span>
                    </div>
                    <p className="text-[10px] text-slate-500 mt-2 leading-snug">
                      HFSS adds this much clearance on each face for
                      the radiation box. Default = λ/4; override to use
                      a fixed pad regardless of f<sub>nominal</sub>.
                    </p>
                  </div>
                  <div className="border-t border-slate-800 pt-2">
                    <div className="text-[10px] uppercase tracking-wider text-slate-400 mb-1">Substrate / chip padding</div>
                    <p className="text-[10px] text-slate-500 leading-snug mb-2">
                      Distance from the device-area bounding box to the
                      chip-substrate edge on each face. Equal values on
                      both axes keep the design centered on the chip.
                    </p>
                    <div className="space-y-1.5">
                      <PadField label="+x" value={padXPosStr} field="padXPos" />
                      <PadField label="−x" value={padXNegStr} field="padXNeg" />
                      <PadField label="+y" value={padYPosStr} field="padYPos" />
                      <PadField label="−y" value={padYNegStr} field="padYNeg" />
                    </div>
                  </div>
                  <div className="border-t border-slate-800 pt-2">
                    <div className="text-[10px] uppercase tracking-wider text-slate-400 mb-1">Analysis</div>
                    <p className="text-[10px] text-slate-500 leading-snug mb-2">
                      Adaptive-solve settings for the generated Setup1.
                      Leave solve frequency blank to solve at
                      f<sub>nominal</sub>.
                    </p>
                    <div className="space-y-1.5">
                      <SimField label="Solve freq" value={solveFreqStr} field="solveFreq" fallback="" placeholder="fnominal" unit="GHz" />
                      <SimField label="Max passes" value={maxPassesStr} field="maxPasses" fallback="12" />
                      <SimField label="Max ΔS" value={maxDeltaSStr} field="maxDeltaS" fallback="0.02" />
                    </div>
                  </div>
                  <div className="border-t border-slate-800 pt-2">
                    <div className="text-[10px] uppercase tracking-wider text-slate-400 mb-1">Frequency sweep</div>
                    <label className="flex items-center gap-2 text-[11px] text-slate-200 cursor-pointer mb-1.5">
                      <input
                        type="checkbox"
                        checked={sweepEnabled}
                        onChange={(e) => updateSim({ sweepEnabled: e.target.checked })}
                      />
                      Enable frequency sweep
                    </label>
                    {sweepEnabled && (
                      <div className="space-y-1.5">
                        <SimField label="Start" value={sweepStartStr} field="sweepStart" fallback="0.1" unit="GHz" />
                        <SimField label="Stop" value={sweepStopStr} field="sweepStop" fallback="50" unit="GHz" />
                        <SimField label="Points" value={sweepPointsStr} field="sweepPoints" fallback="500" />
                        <div className="flex items-center gap-2">
                          <label className="text-[10px] text-slate-400 w-24 text-right">Type</label>
                          <select
                            value={sweepTypeStr}
                            onChange={(e) => updateSim({ sweepType: e.target.value })}
                            className="w-32 px-1.5 py-1 rounded bg-slate-800 border border-slate-700 text-slate-200 text-xs font-mono"
                          >
                            <option value="Interpolating">Interpolating</option>
                            <option value="Discrete">Discrete</option>
                            <option value="Fast">Fast</option>
                          </select>
                        </div>
                      </div>
                    )}
                    <p className="text-[10px] text-slate-500 mt-2 leading-snug">
                      Emitted as Setup1 + sweep in the HFSS export.
                    </p>
                  </div>
                  <div className="border-t border-slate-800 pt-2">
                    <div className="text-[10px] uppercase tracking-wider text-slate-400 mb-1">HFSS export mode</div>
                    <label className="flex items-center gap-2 text-[11px] text-slate-200 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={appendActive}
                        onChange={(e) => updateSim({ appendToActive: e.target.checked })}
                      />
                      Append to active HFSS design
                    </label>
                    <p className="text-[10px] text-slate-500 mt-2 leading-snug">
                      When checked, "Export HFSS (native)" emits a
                      script that attaches the geometry to whatever
                      project/design is currently open in HFSS — your
                      existing setups, sweeps, and excitations are kept
                      untouched. Uncheck to create a fresh project with
                      a default Setup1 (the original behavior).
                    </p>
                  </div>
                </div>
              );
            })()}

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
            showGrid={showGrid}
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
            editDims={editDims}
            canvasTheme={canvasTheme}
            commitExpr={commitExpr}
            renameParam={renameParam}
            addMode={addMode}
            setAddMode={setAddMode}
            commitDragAdd={commitDragAdd}
            onComponentContextMenu={openComponentContextMenu}
            onBackgroundContextMenu={openBackgroundContextMenu}
            onHoverWorld={(wp) => { cursorWorldRef.current = wp; }}
            onSvgElement={(el) => { canvasSvgRef.current = el; }}
            flashAnchor={flashAnchor}
          />
          <div className="absolute top-2 left-2 px-2 py-1 rounded text-[10px] font-mono pointer-events-none" style={{ background: 'rgba(15,23,42,0.85)', color: '#e2e8f0' }}>
            wheel = zoom · drag = pan/move · ⌥/Alt+drag = marquee · ⌘+click = toggle · ⌘+drag = no grid · F = fit · ⇧F = zoom sel · arrows = nudge (⇧ = 10×) · ⌘D = dup · ⌘A = all · Esc = deselect · ⌘Z/⇧Z = undo/redo · ⌘C/V = copy/paste · ⌘S = save
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
        <div className="w-72 border-l border-slate-700 flex flex-col" style={{ background: 'var(--app-slate-900)' }}>
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
                    if (!newId || newId === selected.id) return;
                    // Reject IDs that aren't valid identifiers — they
                    // can't appear in expressions, can't be HFSS part
                    // names, and would create dead `<id>_w` / `<id>_h`
                    // params that the unused-param scanner flags as
                    // orphans. Same regex used everywhere else (param
                    // names, HFSS variable validation).
                    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(newId)) return;
                    if (scene.components.some(c => c.id === newId && c.id !== selected.id)) return;
                    const oldId = selected.id;
                    // Geometry-knob param suffixes the drag-add path
                    // creates per-component. Renaming the component
                    // renames any of these that exist so they don't
                    // become orphan parameters (and so editing them
                    // from the inspector still finds them under the
                    // new name).
                    const SUFFIXES = ['_w', '_h', '_r', '_rx', '_ry', '_n'];
                    const renameMap = {}; // oldParam -> newParam
                    for (const s of SUFFIXES) {
                      const oldP = `${oldId}${s}`;
                      const newP = `${newId}${s}`;
                      if (scene.params[oldP] && !scene.params[newP]) {
                        renameMap[oldP] = newP;
                      }
                    }
                    // Word-boundary replacer: rewrites every oldParam
                    // occurrence in an expression string to its new
                    // name. Synthetic `_comp_<id>_<axis>` references
                    // also need updating since walks down them assume
                    // the component-id substring matches.
                    const renameInExpr = (e) => {
                      if (typeof e !== 'string') return e;
                      let out = e;
                      for (const [from, to] of Object.entries(renameMap)) {
                        out = out.replace(new RegExp(`\\b${from}\\b`, 'g'), to);
                      }
                      // Replace _comp_<oldId>_<axis> synthetics. Use
                      // boundary to avoid clobbering substrings of a
                      // different component's id that ends with oldId.
                      out = out.replace(
                        new RegExp(`\\b_comp_${oldId}_(cx|cy|w|h)\\b`, 'g'),
                        `_comp_${newId}_$1`
                      );
                      return out;
                    };
                    updateScene(prev => {
                      // Renamed params
                      const newParams = {};
                      for (const [k, v] of Object.entries(prev.params)) {
                        const newKey = renameMap[k] || k;
                        newParams[newKey] = { ...v, expr: renameInExpr(v.expr) };
                      }
                      // Update components: id + expression-bearing fields
                      const newComps = prev.components.map(c => {
                        const next = { ...c };
                        if (c.id === oldId) next.id = newId;
                        if (c.consumedBy === oldId) next.consumedBy = newId;
                        // Punch-clone provenance tag — points at the
                        // original tool component, so it must follow
                        // a rename of that tool or deleteBoolean's
                        // clone cleanup loses track of it.
                        if (c.cloneOf === oldId) next.cloneOf = newId;
                        if (Array.isArray(c.operandIds)) {
                          next.operandIds = c.operandIds.map(opId => opId === oldId ? newId : opId);
                        }
                        // Polyline/polyshape snap-bound vertices pin to
                        // (compId, anchor) — remap any that reference
                        // the renamed component, or the solver / HFSS
                        // export chase a dangling id post-rename.
                        if (Array.isArray(c.vertices)) {
                          next.vertices = c.vertices.map(v =>
                            v && v.kind === 'snap' && v.compId === oldId
                              ? { ...v, compId: newId }
                              : v
                          );
                        }
                        for (const f of ['w', 'h', 'r', 'rx', 'ry', 'n', 'R', 'L_straight', 'p', 'wgWidth']) {
                          if (typeof c[f] === 'string') next[f] = renameInExpr(c[f]);
                        }
                        if (Array.isArray(c.cutouts)) {
                          next.cutouts = c.cutouts.map(co => ({
                            ...co,
                            dx: renameInExpr(co.dx),
                            dy: renameInExpr(co.dy),
                            w: renameInExpr(co.w),
                            h: renameInExpr(co.h),
                          }));
                        }
                        if (Array.isArray(c.transforms)) {
                          next.transforms = c.transforms.map(t => ({
                            ...t,
                            ...(t.dx != null ? { dx: renameInExpr(t.dx) } : {}),
                            ...(t.dy != null ? { dy: renameInExpr(t.dy) } : {}),
                            ...(t.angle != null ? { angle: renameInExpr(t.angle) } : {}),
                            ...(t.n != null ? { n: renameInExpr(t.n) } : {}),
                            ...(t.offset != null ? { offset: renameInExpr(t.offset) } : {}),
                          }));
                        }
                        return next;
                      });
                      // Update snaps
                      const newSnaps = prev.snaps.map(s => ({
                        ...s,
                        from: s.from.compId === oldId ? { ...s.from, compId: newId } : s.from,
                        to:   s.to.compId   === oldId ? { ...s.to,   compId: newId } : s.to,
                        dx: renameInExpr(s.dx),
                        dy: renameInExpr(s.dy),
                      }));
                      // Update groups (memberIds + aliases that map to oldId)
                      const newGroups = (prev.groups || []).map(g => ({
                        ...g,
                        memberIds: (g.memberIds || []).map(mid => mid === oldId ? newId : mid),
                        aliases: g.aliases ? Object.fromEntries(
                          Object.entries(g.aliases).map(([k, v]) => [k, v === oldId ? newId : v])
                        ) : g.aliases,
                      }));
                      // Update mirrors (members reference compIds)
                      const newMirrors = (prev.mirrors || []).map(m => ({
                        ...m,
                        members: (m.members || []).map(mem => ({
                          ...mem,
                          srcId:    mem.srcId    === oldId ? newId : mem.srcId,
                          mirrorId: mem.mirrorId === oldId ? newId : mem.mirrorId,
                        })),
                      }));
                      return {
                        ...prev,
                        params: newParams,
                        components: newComps,
                        snaps: newSnaps,
                        groups: newGroups,
                        mirrors: newMirrors,
                      };
                    });
                    const newSet = new Set(selectedIds);
                    newSet.delete(oldId);
                    newSet.add(newId);
                    setSelection({ ids: newSet, primary: newId });
                  }} className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs font-mono text-cyan-300 outline-none focus:border-cyan-400" />
                </div>
                {/* Cell-instance provenance chip (read-only). Stamped by
                    instantiateCell; "update instances" in the LIBRARY
                    panel uses it to find and rebuild this instance. */}
                {selected.cellInstance && selected.cellInstance.cell && (
                  <div>
                    <span
                      className="inline-block text-[9px] px-1.5 py-0.5 rounded-full border border-violet-700 bg-violet-900/30 text-violet-300 font-mono"
                      title={`Instance "${selected.cellInstance.inst}" of cell "${selected.cellInstance.cell}". Knobs: the ${selected.cellInstance.inst}_* params in PARAMS. Rebuilt by "update instances" in the LIBRARY panel.`}
                    >
                      cell: {selected.cellInstance.cell} ({selected.cellInstance.inst})
                    </span>
                  </div>
                )}
                <div>
                  <label className="text-[10px] uppercase tracking-wider text-slate-500">Layer</label>
                  <select value={selected.layer} onChange={(e) => updateComp(selected.id, { layer: e.target.value })} className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs text-slate-100 outline-none">
                    <option value="waveguide">waveguide</option>
                    <option value="electrode">electrode</option>
                    <option value="port">port</option>
                  </select>
                </div>
                {/* Conductor-layer binding. Visible for both electrode
                    and port components when the stack defines at least
                    one conductor layer. For electrodes it picks the
                    conductor whose thickness / Z the part lives on; for
                    ports it picks the conductor whose mid-Z the sheet
                    sits at (= where the lumped-port assignment sits
                    too). Without this the user had no way to change a
                    component's metal level after creation — the
                    binding was set in `commitDragAdd` and silently
                    defaulted to the first conductor. */}
                {(selected.layer === 'electrode' || selected.layer === 'port') && (() => {
                  // Conductor-layer binding picker. Three states to handle:
                  //
                  //   1. EXPLICITLY BOUND to an existing role='conductor' layer.
                  //      Show as the selected option; user can pick another to rebind.
                  //
                  //   2. UNBOUND (conductorLayerId is missing). Older components
                  //      created before this picker existed used the implicit
                  //      "first conductor in stack" fallback — that's silently
                  //      wrong when the stack later grows to multiple conductors.
                  //      Surface an "(unbound — falls back to first conductor)"
                  //      sentinel option marked with ⚠ so the user knows they
                  //      need to make the choice explicit. Picking ANY real
                  //      conductor below persists the binding.
                  //
                  //   3. STALE BOUND (conductorLayerId points to a layer that
                  //      doesn't exist anymore OR has had its role changed
                  //      away from conductor). Show the stale id pinned to the
                  //      top of the list (red ⚠) so the user sees the binding
                  //      is broken and can correct it.
                  //
                  // The dropdown ALWAYS lists every layer in the stack with
                  // role='conductor' — same filter as the export uses. If the
                  // user reports "the new layer doesn't show up", the layer
                  // either isn't in the stack or its role hasn't been set to
                  // conductor. Check the LAYERS panel.
                  const conductorLayers = (scene.stack || []).filter(l => l.role === 'conductor');
                  if (conductorLayers.length === 0) return null;
                  const explicitBoundId = selected.conductorLayerId || null;
                  const boundExists = explicitBoundId
                    ? conductorLayers.some(l => l.id === explicitBoundId)
                    : false;
                  const isUnbound = !explicitBoundId;
                  const isStale = !!explicitBoundId && !boundExists;
                  // What to display in the <select>. For unbound we use a
                  // sentinel value '__unbound__' so the select doesn't visually
                  // suggest a layer is bound when none is. For stale, show the
                  // stale id so the user sees what's recorded.
                  const displayValue = isUnbound
                    ? '__unbound__'
                    : (boundExists ? explicitBoundId : explicitBoundId);
                  const labelText = selected.layer === 'port'
                    ? 'Conductor layer (port Z)'
                    : 'Conductor layer';
                  const helpText = selected.layer === 'port'
                    ? 'Port sheet lives at this conductor\'s mid-thickness (Z = z_bottom + thickness / 2). Pick a different layer to move the port to that metal level.'
                    : 'The component is built on this conductor\'s Z (zBottom → zBottom + thickness). Pick a different metal to move the part between levels of a multi-metal stack.';
                  return (
                    <div>
                      <label className="text-[10px] uppercase tracking-wider text-slate-500">{labelText}</label>
                      <select
                        value={displayValue}
                        onChange={(e) => {
                          // Sentinel values from the unbound/stale options
                          // are no-ops on commit. Only real ids persist.
                          if (e.target.value === '__unbound__') return;
                          updateComp(selected.id, { conductorLayerId: e.target.value });
                        }}
                        className={`w-full bg-slate-900 border rounded px-2 py-1 text-xs font-mono outline-none ${
                          isUnbound || isStale
                            ? 'border-amber-500 text-amber-300 focus:border-amber-400'
                            : 'border-slate-700 text-slate-100 focus:border-cyan-400'
                        }`}
                        title={helpText}
                      >
                        {isUnbound && (
                          <option value="__unbound__">
                            ⚠ unbound — falls back to "{conductorLayers[0]?.name || conductorLayers[0]?.id}"
                          </option>
                        )}
                        {isStale && (
                          <option value={explicitBoundId}>
                            ⚠ {explicitBoundId} (deleted or no longer a conductor)
                          </option>
                        )}
                        {conductorLayers.map(l => (
                          <option key={l.id} value={l.id}>{l.name || l.id}</option>
                        ))}
                      </select>
                      {isUnbound && (
                        <p className="text-[9px] text-amber-400 mt-1 leading-snug">
                          No explicit binding — the export will silently fall back to the
                          first conductor in the stack. Pick a layer above to make the
                          binding explicit and immune to stack reordering.
                        </p>
                      )}
                      {isStale && (
                        <p className="text-[9px] text-red-400 mt-1 leading-snug">
                          Bound to "{explicitBoundId}" which is no longer a conductor layer
                          (it was deleted or its role was changed). Pick a real conductor
                          above; until you do, the export silently falls back to the first
                          conductor — which may not be what you want.
                        </p>
                      )}
                      {!isUnbound && !isStale && (
                        <p className="text-[9px] text-slate-500 mt-1 leading-snug">{helpText}</p>
                      )}
                    </div>
                  );
                })()}
                {selected.kind === 'boolean' ? (
                  // Derived boolean component: no editable w/h (geometry is
                  // determined by operands + boolean op). Show op + operands
                  // as a derivation summary; cx/cy is the result's anchor.
                  <div className="border border-slate-700 rounded p-2" style={{ background: 'rgba(15,23,42,0.5)' }}>
                    <div className="flex items-center gap-1 mb-1">
                      <span className="text-[10px] font-bold uppercase tracking-wider" style={{
                        color: selected.op === 'union' ? '#10b981'
                          : (selected.op === 'intersect' ? '#22d3ee' : '#f59e0b'),
                      }}>derived · {selected.op}</span>
                    </div>
                    <p className="text-[10px] text-slate-400 font-mono leading-snug">
                      {/* Derivation formula with op-colored operator glyphs:
                          union → emerald +, intersect → cyan ∩,
                          subtract/punch → amber −. */}
                      {(() => {
                        const ids = selected.operandIds || [];
                        const isSub = selected.op === 'subtract' || selected.op === 'punch';
                        const sym = isSub ? '−' : (selected.op === 'union' ? '+' : '∩');
                        const symColor = isSub ? '#f59e0b' : (selected.op === 'union' ? '#10b981' : '#22d3ee');
                        return ids.map((id, i) => (
                          <React.Fragment key={`${id}_${i}`}>
                            {i > 0 && <span className="font-bold px-0.5" style={{ color: symColor }}>{sym}</span>}
                            <span>{id}</span>
                          </React.Fragment>
                        ));
                      })()}
                    </p>
                    <p className="text-[9px] text-slate-500 mt-1 italic">
                      {selected.op === 'punch'
                        ? 'Punch: only the base (first operand) was consumed. Tool shapes remain standalone — they render outside the boolean too. HFSS export uses Subtract with KeepOriginals=True.'
                        : 'Operands were consumed when this component was created (HFSS-style). They no longer appear in SHAPES. Delete this component to release them.'}
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
                      <ExprField
                        label={label}
                        value={value}
                        size="md"
                        params={scene.params}
                        paramValues={paramValues}
                        suggestions={paramNames}
                        fmt={(v) => (parse ? parse(v) : v.toFixed(2))}
                        onCommit={(v) => {
                          // Snapshot the field's CURRENT evaluated value
                          // before the commit fires; any new parameter
                          // auto-created from the new expression should
                          // default to that value instead of a generic
                          // '1' — so renaming `5` to `my_w` makes
                          // `my_w = 5` (preserves the visual size).
                          const prevEval = evalExpr(value, paramValues);
                          const prevDefault = Number.isFinite(prevEval) ? String(prevEval) : '1';
                          onChange(v);
                          commitExpr(v, prevDefault, 'µm', `Auto-created (${selected.id}.${key})`);
                        }}
                      />
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
                    if (shapeKind === 'polyline' || shapeKind === 'polyshape') {
                      // Polyline trace (with a width param) OR polyshape
                      // (closed 2-D polygon, no width). Both expose the
                      // per-vertex editor below. Each vertex is either a
                      // `rel` step (parametric dx, dy from the previous
                      // vertex) or a `snap` binding to another component's
                      // anchor. Editing dx/dy expressions surfaces all the
                      // existing expression-parser machinery (param
                      // highlighting, auto-create on commit, etc.).
                      const vertSpecs = selected.vertices || [];
                      const isPolyshape = shapeKind === 'polyshape';
                      const isTapered = !isPolyshape && polylineIsTapered(selected);
                      // Solved vertex positions, computed at CLICK time for
                      // the line↔arc converters (so the synthesized arc /
                      // recovered dx,dy reflect the current solve, including
                      // snap-bound vertices).
                      const resolvedVertsNow = () => {
                        const solvedNow = applyMirrors(solveLayout(scene.components, scene.snaps, paramValues), scene.mirrors);
                        const byIdS = Object.fromEntries(solvedNow.map(cc => [cc.id, cc]));
                        const sel = byIdS[selected.id] || selected;
                        return { verts: resolvePolylineVertices(sel, byIdS, paramValues), sel };
                      };
                      const setVertices = (newVerts) => updateComp(selected.id, { vertices: newVerts });
                      const inputCls = "bg-slate-900 border border-slate-700 rounded px-1 py-0.5 text-[10px] font-mono text-slate-100 outline-none focus:border-cyan-400";
                      // Expression input bound to one field of one vertex.
                      const vertExprInput = (idx, v, field, placeholder, unitForCreate = 'µm') => (
                        <DeferredTextInput
                          autoGrow
                          value={String(v[field] ?? '0')}
                          suggestions={paramNames}
                          onCommit={(val) => {
                            const prevEval = evalExpr(v[field] ?? '0', paramValues);
                            const prevDefault = Number.isFinite(prevEval) ? String(prevEval) : '0';
                            setVertices(vertSpecs.map((vv, i) => i === idx ? { ...vv, [field]: val } : vv));
                            commitExpr(val, prevDefault, unitForCreate, `${selected.id} v${idx}.${field}`);
                          }}
                          className={inputCls}
                          placeholder={placeholder}
                        />
                      );
                      // Per-vertex taper width (polyline only). Empty =
                      // unset (vertex uses the base trace width). Disabled
                      // on arc vertices: taper-on-arc isn't supported in v1
                      // (HFSS falls back to constant base width).
                      const vertWidthInput = (idx, v) => {
                        const isArcRow = v.kind === 'arc';
                        return (
                          <div className="grid grid-cols-[1.4rem_1fr] gap-1 items-center" title={isArcRow
                            ? 'Taper width on ARC segments is not supported in v1 — the arc keeps the base trace width (HFSS export falls back to constant width on curved segments).'
                            : 'Optional taper width at this vertex (µm expression). Empty = base trace width. Setting ANY vertex width makes the whole trace TAPERED: per-segment quads with butt joins, matching the HFSS per-segment sheet export.'}>
                            <span className="text-[9px] font-mono text-slate-500 text-right">w</span>
                            {isArcRow ? (
                              <input
                                disabled
                                value=""
                                placeholder="n/a on arc"
                                className={inputCls + ' opacity-40 cursor-not-allowed'}
                              />
                            ) : (
                              <DeferredTextInput
                                autoGrow
                                value={String(v.width ?? '')}
                                suggestions={paramNames}
                                onCommit={(val) => {
                                  const trimmed = String(val).trim();
                                  setVertices(vertSpecs.map((vv, i) => {
                                    if (i !== idx) return vv;
                                    const next = { ...vv };
                                    if (trimmed === '') delete next.width;
                                    else next.width = trimmed;
                                    return next;
                                  }));
                                  if (trimmed !== '') commitExpr(trimmed, '0', 'µm', `${selected.id} v${idx}.width`);
                                }}
                                className={inputCls}
                                placeholder="taper w (empty = base)"
                              />
                            )}
                          </div>
                        );
                      };
                      const deleteVertBtn = (idx) => (vertSpecs.length > 2 && idx > 0) ? (
                        <button
                          title="Delete this vertex"
                          className="text-[9px] px-1 py-0.5 rounded border border-slate-600 hover:border-red-500 hover:text-red-300 text-slate-400"
                          onClick={() => setVertices(vertSpecs.filter((_, i) => i !== idx))}
                        >×</button>
                      ) : null;
                      return (
                        <div className="space-y-2">
                          {!isPolyshape && (
                            <div className="grid grid-cols-2 gap-2 items-end">
                              {fieldRow('width', 'trace width', selected.width ?? '5', (v) => updateComp(selected.id, { width: v }))}
                              {isTapered && (
                                <span
                                  className="justify-self-start text-[9px] px-1.5 py-0.5 rounded font-mono uppercase tracking-wider bg-amber-900/40 border border-amber-600 text-amber-300"
                                  title="One or more vertices carry a taper width — the trace renders and exports as per-segment quads (butt joins). Clear every per-vertex w to return to a constant-width swept trace."
                                >tapered</span>
                              )}
                            </div>
                          )}
                          {isPolyshape && (
                            <p className="text-[10px] text-slate-400 italic">Closed polygon-path — vertices below trace the perimeter. Always closed; no width (filled 2-D shape).</p>
                          )}
                          <div className="border border-slate-700 rounded p-2" style={{ background: 'rgba(15,23,42,0.5)' }}>
                            <div className="flex items-center justify-between mb-1">
                              <span className="text-[10px] uppercase tracking-wider text-slate-400">Vertices ({vertSpecs.length})</span>
                              <span className="text-[9px] text-slate-500">v0 = (cx, cy) · S = spline · ⌒ = arc</span>
                            </div>
                            <div className="space-y-1 max-h-64 overflow-y-auto">
                              {vertSpecs.map((v, idx) => (
                                <div key={idx} className="space-y-0.5 pb-1 border-b border-slate-800/60 last:border-b-0">
                                  <div className="grid grid-cols-[1.4rem_1fr_1fr_auto] gap-1 items-center text-[10px]">
                                    <span className="font-mono text-slate-400">{v.kind === 'arc' ? `v${idx}⌒` : `v${idx}`}</span>
                                    {v.kind === 'snap' ? (
                                      <>
                                        <span className="col-span-2 px-1 py-0.5 rounded text-[9px] font-mono text-amber-300 bg-slate-800 border border-amber-700">
                                          snap → {v.compId}.{v.anchor}
                                        </span>
                                        <button
                                          title="Replace this snap binding with a free (rel) vertex at the current solved position"
                                          className="text-[9px] px-1 py-0.5 rounded border border-slate-600 hover:border-cyan-500 hover:text-cyan-300 text-slate-400"
                                          onClick={() => {
                                            setVertices(vertSpecs.map((vv, i) => i === idx
                                              ? { kind: 'rel', dx: '0', dy: '0', ...(vv.width != null ? { width: vv.width } : {}) }
                                              : vv));
                                          }}
                                        >×</button>
                                      </>
                                    ) : v.kind === 'arc' ? (
                                      <>
                                        {vertExprInput(idx, v, 'cdx', 'cdx (center)')}
                                        {vertExprInput(idx, v, 'cdy', 'cdy (center)')}
                                        <div className="flex gap-0.5">
                                          <button
                                            title="Convert this arc back to a straight segment — the endpoint is kept as a rel dx/dy step from the previous vertex"
                                            className="text-[9px] px-1 py-0.5 rounded border border-slate-600 hover:border-cyan-500 hover:text-cyan-300 text-slate-400 font-mono"
                                            onClick={() => {
                                              const { verts, sel } = resolvedVertsNow();
                                              const prev = idx === 0 ? [sel.cx, sel.cy] : verts[idx - 1];
                                              const cur = verts[idx];
                                              if (!prev || !cur || !Number.isFinite(cur[0]) || !Number.isFinite(prev[0])) return;
                                              setVertices(vertSpecs.map((vv, i) => i === idx
                                                ? { kind: 'rel', dx: (cur[0] - prev[0]).toFixed(3), dy: (cur[1] - prev[1]).toFixed(3), ...(vv.width != null ? { width: vv.width } : {}) }
                                                : vv));
                                            }}
                                          >—</button>
                                          {deleteVertBtn(idx)}
                                        </div>
                                      </>
                                    ) : (
                                      <>
                                        {vertExprInput(idx, v, 'dx', 'dx')}
                                        {vertExprInput(idx, v, 'dy', 'dy')}
                                        <div className="flex gap-0.5 items-center">
                                          {idx > 0 && (
                                            <label
                                              className="text-[9px] font-mono text-slate-400 inline-flex items-center gap-0.5 cursor-pointer px-0.5"
                                              title="Spline-flag this vertex: consecutive flagged vertices (plus the vertex before the run) become ONE HFSS Spline segment (NURBS through the points). Canvas/GDS preview the run with a Catmull-Rom approximation."
                                            >
                                              <input
                                                type="checkbox"
                                                checked={!!v.spline}
                                                onChange={(e) => setVertices(vertSpecs.map((vv, i) => {
                                                  if (i !== idx) return vv;
                                                  const next = { ...vv };
                                                  if (e.target.checked) next.spline = true;
                                                  else delete next.spline;
                                                  return next;
                                                }))}
                                              />S
                                            </label>
                                          )}
                                          {idx > 0 && (
                                            <button
                                              title="Convert this straight segment to a 90° circular arc through the same endpoint (center synthesized on the perpendicular bisector; edit cdx/cdy/angle afterwards to reshape)"
                                              className="text-[9px] px-1 py-0.5 rounded border border-slate-600 hover:border-cyan-500 hover:text-cyan-300 text-slate-400 font-mono"
                                              onClick={() => {
                                                const { verts } = resolvedVertsNow();
                                                const S = verts[idx - 1], E = verts[idx];
                                                if (!S || !E || !Number.isFinite(S[0]) || !Number.isFinite(E[0])) return;
                                                const prevDir = idx >= 2 && verts[idx - 2]
                                                  ? { x: S[0] - verts[idx - 2][0], y: S[1] - verts[idx - 2][1] }
                                                  : null;
                                                const arc = synthArc90({ x: S[0], y: S[1] }, { x: E[0], y: E[1] }, prevDir);
                                                if (!arc) return;
                                                setVertices(vertSpecs.map((vv, i) => i === idx
                                                  ? { kind: 'arc', cdx: arc.cdx.toFixed(3), cdy: arc.cdy.toFixed(3), angle: String(arc.angle) }
                                                  : vv));
                                              }}
                                            >⌒</button>
                                          )}
                                          {deleteVertBtn(idx)}
                                        </div>
                                      </>
                                    )}
                                  </div>
                                  {v.kind === 'arc' && (
                                    <div className="grid grid-cols-[1.4rem_1fr] gap-1 items-center" title="Sweep angle in degrees, CCW positive — the HFSS export emits '(expr)*1deg' so auto-created angle params are UNITLESS.">
                                      <span className="text-[9px] font-mono text-slate-500 text-right">∠</span>
                                      {vertExprInput(idx, v, 'angle', 'angle (deg CCW)', '')}
                                    </div>
                                  )}
                                  {!isPolyshape && vertWidthInput(idx, v)}
                                </div>
                              ))}
                            </div>
                            <button
                              title="Append a new vertex (relative dx/dy from the last vertex)"
                              className="mt-1 text-[10px] px-2 py-0.5 rounded border border-slate-600 hover:border-emerald-500 hover:text-emerald-300 text-slate-300"
                              onClick={() => {
                                const newVerts = [...vertSpecs, { kind: 'rel', dx: '10', dy: '0' }];
                                updateComp(selected.id, { vertices: newVerts });
                              }}
                            >+ vertex</button>
                            <label className="ml-2 text-[10px] text-slate-400 inline-flex items-center gap-1 cursor-pointer">
                              <input
                                type="checkbox"
                                checked={!!selected.closed}
                                onChange={(e) => updateComp(selected.id, { closed: e.target.checked })}
                              /> closed
                            </label>
                          </div>
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
                    if (shapeKind === 'via') {
                      // Via (D4): radius expression + the two stack layers
                      // the cylinder spans. layerFrom must differ from
                      // layerTo — matching options are disabled in each
                      // select so an equal pair can't be picked.
                      const stackLayers = scene.stack || [];
                      const layerSelect = (key, label, value, otherValue) => (
                        <div>
                          <label className="text-[10px] uppercase tracking-wider text-slate-500">{label}</label>
                          <select
                            value={value || ''}
                            onChange={(e) => updateComp(selected.id, { [key]: e.target.value })}
                            className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs font-mono text-slate-100 outline-none focus:border-cyan-400"
                            title="Stack layer this via terminates on. HFSS uses the layer's parametric Z expressions, so thickness sweeps move the via with the stack."
                          >
                            {!value && <option value="">— pick layer —</option>}
                            {stackLayers.map(l => (
                              <option key={l.id} value={l.id} disabled={l.id === otherValue}>
                                {l.id} ({l.name || l.role})
                              </option>
                            ))}
                          </select>
                        </div>
                      );
                      return (
                        <>
                          <div className="grid grid-cols-2 gap-2">
                            {fieldRow('r', 'r (via radius)', selected.r ?? '2', (v) => updateComp(selected.id, { r: v }))}
                          </div>
                          <div className="grid grid-cols-2 gap-2 mt-2">
                            {layerSelect('layerFrom', 'layer from (bottom)', selected.layerFrom, selected.layerTo)}
                            {layerSelect('layerTo', 'layer to (top)', selected.layerTo, selected.layerFrom)}
                          </div>
                          {selected.layerFrom && selected.layerFrom === selected.layerTo && (
                            <p className="text-[9px] text-red-400 mt-1 leading-snug">
                              layerFrom and layerTo must differ — a via has to span two
                              distinct stack layers. Pick a different layer on one side.
                            </p>
                          )}
                        </>
                      );
                    }
                    // Default: rectangle.
                    return (
                      <div className="grid grid-cols-2 gap-2">
                        {fieldRow('w', 'w', selected.w, (v) => updateComp(selected.id, { w: v }))}
                        {fieldRow('h', 'h', selected.h, (v) => updateComp(selected.id, { h: v }))}
                        {fieldRow('cornerRadius', 'corner radius', selected.cornerRadius ?? '0', (v) => updateComp(selected.id, { cornerRadius: v }))}
                      </div>
                    );
                  })()
                )}
                {/* First-class rotation (rect / circle / ellipse / polygon)
                    + per-component z offset (all flat-shape kinds). Both are
                    parametric expression fields wired through the standard
                    auto-create-param commit pattern. Rotation params are
                    auto-created UNITLESS — the HFSS export multiplies the
                    expression by 1deg ("(<expr>)*1deg"), so a deg-typed
                    variable would come out deg². zOffset params are µm. */}
                {selected.kind !== 'boolean' && (() => {
                  const shapeKind = selected.kind || 'rect';
                  const showRot = ['rect', 'circle', 'ellipse', 'polygon'].includes(shapeKind);
                  const showZ = ['rect', 'circle', 'ellipse', 'polygon', 'polyline', 'polyshape'].includes(shapeKind);
                  if (!showRot && !showZ) return null;
                  const exprField = (key, label, value, unitForCreate, fmt) => (
                    <div>
                      <label className="text-[10px] uppercase tracking-wider text-slate-500">{label}</label>
                      <DeferredTextInput
                        autoGrow
                        value={value}
                        suggestions={paramNames}
                        onCommit={(v) => {
                          const prevEval = evalExpr(value, paramValues);
                          const prevDefault = Number.isFinite(prevEval) ? String(prevEval) : '0';
                          updateComp(selected.id, { [key]: v });
                          commitExpr(v, prevDefault, unitForCreate, `Auto-created (${selected.id}.${key})`);
                        }}
                        className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs font-mono text-slate-100 outline-none focus:border-cyan-400 whitespace-pre-wrap break-words leading-tight"
                        spellCheck={false}
                        placeholder="0"
                      />
                      <p className="text-[9px] text-slate-500 mt-0.5 font-mono">= {(() => {
                        const v = evalExpr(value, paramValues);
                        return Number.isFinite(v) ? fmt(v) : '—';
                      })()}</p>
                    </div>
                  );
                  return (
                    <div className="grid grid-cols-2 gap-2">
                      {showRot && exprField('rotation', 'rotation (deg ccw)', selected.rotation ?? '0', '', (v) => `${v.toFixed(2)}°`)}
                      {showZ && exprField('zOffset', 'z offset (µm)', selected.zOffset ?? '', 'µm', (v) => `${v.toFixed(3)} µm`)}
                    </div>
                  );
                })()}
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-[10px] uppercase tracking-wider text-slate-500">cx ({selectedHasIncoming ? 'solved' : 'free'})</label>
                    <DeferredTextInput type="number" step="0.5" numeric value={selected.cx?.toFixed?.(2) ?? selected.cx} disabled={selectedHasIncoming} onCommit={(v) => updateComp(selected.id, { cx: v })} className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs font-mono text-slate-100 outline-none focus:border-cyan-400 disabled:opacity-50" />
                  </div>
                  <div>
                    <label className="text-[10px] uppercase tracking-wider text-slate-500">cy ({selectedHasIncoming ? 'solved' : 'free'})</label>
                    <DeferredTextInput type="number" step="0.5" numeric value={selected.cy?.toFixed?.(2) ?? selected.cy} disabled={selectedHasIncoming} onCommit={(v) => updateComp(selected.id, { cy: v })} className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs font-mono text-slate-100 outline-none focus:border-cyan-400 disabled:opacity-50" />
                  </div>
                </div>

                {/* C8: parametric root position (cxExpr / cyExpr). Applied
                    by the solver on UNSNAPPED roots only — when an incoming
                    snap exists the snap wins, so the fields render disabled
                    with a note. Auto-created position params default to the
                    component's CURRENT numeric cx/cy so the part doesn't
                    jump when an identifier is first typed. Booleans derive
                    cx/cy from operands and never take position exprs. */}
                {selected.kind !== 'boolean' && (() => {
                  const posField = (key, label, curNumeric) => (
                    <div>
                      <label className="text-[10px] uppercase tracking-wider text-slate-500">{label}</label>
                      <DeferredTextInput
                        autoGrow
                        value={selected[key] ?? ''}
                        suggestions={paramNames}
                        disabled={selectedHasIncoming}
                        onCommit={(v) => {
                          const trimmed = (v || '').trim();
                          // Empty string clears the binding (undefined is
                          // dropped by JSON serialization; the solver skips
                          // null/empty exprs).
                          updateComp(selected.id, { [key]: trimmed === '' ? undefined : v });
                          if (trimmed !== '') {
                            const prevDefault = Number.isFinite(curNumeric) ? String(+curNumeric.toFixed(3)) : '0';
                            commitExpr(v, prevDefault, 'µm', `Auto-created (${selected.id}.${key})`);
                          }
                        }}
                        className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs font-mono text-slate-100 outline-none focus:border-cyan-400 whitespace-pre-wrap break-words leading-tight disabled:opacity-50"
                        spellCheck={false}
                        placeholder="(none)"
                      />
                      <p className="text-[9px] text-slate-500 mt-0.5 font-mono">= {(() => {
                        const expr = selected[key];
                        if (expr == null || String(expr).trim() === '') return '—';
                        const v = evalExpr(expr, paramValues);
                        return Number.isFinite(v) ? v.toFixed(3) : 'NaN';
                      })()}</p>
                    </div>
                  );
                  const hasPosExpr = ['cxExpr', 'cyExpr'].some(k => typeof selected[k] === 'string' && selected[k].trim() !== '');
                  return (
                    <div>
                      <div className="grid grid-cols-2 gap-2">
                        {posField('cxExpr', 'x position (expr)', selected.cx)}
                        {posField('cyExpr', 'y position (expr)', selected.cy)}
                      </div>
                      {selectedHasIncoming ? (
                        <p className="text-[9px] text-slate-500 mt-0.5 italic">position from snap</p>
                      ) : hasPosExpr ? (
                        <p className="text-[9px] text-amber-400 mt-0.5 leading-snug">
                          expr-positioned — canvas drags snap back to the expression on the next solve
                        </p>
                      ) : null}
                    </div>
                  );
                })()}

                <TransformChainEditor
                  component={selected}
                  onUpdateComp={(patch) => updateComp(selected.id, patch)}
                  paramValues={paramValues}
                  commitExpr={commitExpr}
                  suggestions={paramNames}
                />

                {/* Lumped port: only shown for components on the port
                    layer. Detects whether the port sits between two
                    electrodes and offers to auto-generate an integration
                    line + assign a lumped port on export. */}
                {selected.layer === 'port' && selected.kind === 'rect' && (() => {
                  // Solve the current scene for adjacency detection. Cheap
                  // for the inspector path; not memoized because port-layer
                  // selection is rare and the detection is run only when the
                  // user has a port selected.
                  const solvedForPort = applyMirrors(
                    solveLayout(scene.components, scene.snaps, paramValues),
                    scene.mirrors,
                  );
                  const selectedSolved = solvedForPort.find(c => c.id === selected.id) || selected;
                  const det = detectPortIntegrationLine(selectedSolved, solvedForPort, paramValues);
                  const cfg = selected.lumpedPort || { enabled: false, impedance: '50' };
                  const setLumped = (patch) => updateComp(selected.id, {
                    lumpedPort: { enabled: false, impedance: '50', ...cfg, ...patch },
                  });
                  const dirLabel = det.direction === 'EW'
                    ? `West ↔ East  (${det.from} ↔ ${det.to})`
                    : det.direction === 'NS'
                    ? `South ↔ North  (${det.from} ↔ ${det.to})`
                    : null;
                  // (Conductor-layer binding moved up next to the Layer
                  // dropdown so it's discoverable for electrodes and
                  // ports alike; see the per-component section above.)
                  return (
                    <div className="border-t border-slate-700 pt-3 space-y-2">
                      <div className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-slate-400">
                        <Radio size={11} /> Lumped port
                      </div>
                      {dirLabel ? (
                        <div className="text-[10px] font-mono text-cyan-300">
                          ✓ Adjacency detected: {dirLabel}
                        </div>
                      ) : (
                        <p className="text-[10px] text-slate-500 italic leading-snug">
                          Not adjacent to two conductors. To enable an
                          auto integration line, two opposite sides of
                          the port must touch electrode shapes.
                        </p>
                      )}
                      <label className={`flex items-center gap-2 text-[11px] ${dirLabel ? 'text-slate-200 cursor-pointer' : 'text-slate-500 cursor-not-allowed'}`}>
                        <input
                          type="checkbox"
                          checked={!!cfg.enabled}
                          disabled={!dirLabel}
                          onChange={(e) => setLumped({ enabled: e.target.checked })}
                        />
                        Define lumped port on export
                      </label>
                      {cfg.enabled && dirLabel && (
                        <div>
                          <label className="text-[10px] uppercase tracking-wider text-slate-500">Impedance (Ω)</label>
                          <DeferredTextInput
                            value={cfg.impedance ?? '50'}
                            onCommit={(v) => setLumped({ impedance: (v || '').trim() || '50' })}
                            className="w-24 bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs font-mono text-slate-100 outline-none focus:border-cyan-400"
                          />
                          <p className="text-[9px] text-slate-500 mt-1 font-mono leading-snug">
                            HFSS will assign a lumped port with an
                            integration line from {det.from} to {det.to}
                            through the port center.
                          </p>
                        </div>
                      )}
                    </div>
                  );
                })()}

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
                              onFlashAnchor={flashAnchorOnCanvas}
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
                              onFlashAnchor={flashAnchorOnCanvas}
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

      {/* Settings & appearance panel */}
      <SettingsPanel
        open={showSettings}
        settings={settings}
        onChange={updateSetting}
        onClose={() => setShowSettings(false)}
        onExport={handleExportSettings}
        onImport={handleImportSettings}
        onRestore={handleRestoreSettings}
      />

      {/* Animated help tutorial overlay */}
      <HelpTutorial open={showHelp} onClose={() => setShowHelp(false)} />
      <AiAssistantDialog
        open={showAiAssistant}
        onClose={() => setShowAiAssistant(false)}
        scene={scene}
        paramValues={paramValues}
        onApply={(fragment) => updateScene((prev) => applyAiGeometryFragment(prev, fragment, { viewport, paramValues }))}
      />

      <TwoLineWizard
        open={showTwoLineWizard}
        onClose={() => setShowTwoLineWizard(false)}
        scene={scene}
        paramValues={paramValues}
        onGenerate={handleExportTwoLine}
        onGenerateQ3D={handleExportQ3DCap}
      />

      {/* Modal dialog (confirm/prompt/alert) */}
      <ModalDialog
        open={!!dialog}
        title={dialog?.title}
        message={dialog?.message}
        defaultValue={dialog?.defaultValue}
        kind={dialog?.kind}
        onConfirm={dialog?.onConfirm}
        onCancel={dialog?.onCancel}
        confirmLabel={dialog?.confirmLabel}
        confirmTone={dialog?.confirmTone}
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
            style={{ background: 'var(--app-slate-900)', width: 'min(900px, 92vw)', height: 'min(80vh, 700px)' }}
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
