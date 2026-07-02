// Interactive 3-D viewer — a render-side PREVIEW of what the HFSS export
// builds. Loaded via React.lazy from PhotonicLayout (the "3D" toolbar
// toggle); three.js + three-bvh-csg are dynamically imported HERE (module-
// level promise, same pattern as the AI SDK in src/ai/client.js) so they
// live in their own lazy chunk and the main bundle doesn't grow.
//
// Strictly viewer-only: consumes buildScene3D's plain-data spec
// (src/scene/scene3d.js — pure, no three.js) and never touches the scene
// model, solver, or exports. Z-up convention (camera.up = (0,0,1)):
// X = plan x, Y = plan y, Z = stack height.
//
// CSG: three-bvh-csg SUBTRACTION for solids carrying csg.subtractIds
// (subtract / punch booleans + partially-overlapping cutouts). Tool solids
// (role 'tool') are consumed by the subtraction and never rendered. Tool
// geometry is inflated ±10 nm in Z so exactly-coplanar faces don't leave
// z-fighting slivers. Unions render as overlapping solids (no CSG — reads
// identically and costs nothing).
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { buildScene3D } from '../scene/scene3d.js';

// ── Lazy three.js loading (one promise per page, shared across mounts) ───
let _libsPromise = null;
function loadLibs() {
  if (!_libsPromise) {
    _libsPromise = Promise.all([
      import('three'),
      import('three/examples/jsm/controls/OrbitControls.js'),
      import('three-bvh-csg'),
    ]).then(([three, orbit, csg]) => ({
      THREE: three,
      OrbitControls: orbit.OrbitControls,
      csg,
    }));
  }
  return _libsPromise;
}

// Signed area — used to normalize ring winding for THREE.Shape (outer CCW,
// holes CW).
function signedArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return a / 2;
}

function ringToShape(THREE, ring, holes) {
  const outer = signedArea(ring) < 0 ? [...ring].reverse() : ring;
  const shape = new THREE.Shape(outer.map(([x, y]) => new THREE.Vector2(x, y)));
  for (const h of holes || []) {
    if (!h || h.length < 3) continue;
    const hh = signedArea(h) > 0 ? [...h].reverse() : h;
    shape.holes.push(new THREE.Path(hh.map(([x, y]) => new THREE.Vector2(x, y))));
  }
  return shape;
}

// Loft between two index-corresponded plan rings (same vertex count/order,
// e.g. the rib-waveguide trapezoid): planar side walls + triangulated caps.
// Built as a closed, outward-wound triangle soup so it stays a valid CSG
// brush. Both rings are normalized to CCW with ONE decision (they come from
// the same generator, so their winding always matches).
function buildLoftGeometry(THREE, solid, inflateZ) {
  let bot = solid.ringBottom;
  let top = solid.ringTop;
  if (signedArea(bot) < 0) { bot = [...bot].reverse(); top = [...top].reverse(); }
  const zB = solid.zBottom - inflateZ;
  const zT = solid.zBottom + solid.height + inflateZ;
  const n = bot.length;
  const pos = [];
  const tri = (a, b, c) => pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
  // Side walls: CCW rings ⇒ (b0, b1, t1) / (b0, t1, t0) face outward.
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const b0 = [bot[i][0], bot[i][1], zB];
    const b1 = [bot[j][0], bot[j][1], zB];
    const t0 = [top[i][0], top[i][1], zT];
    const t1 = [top[j][0], top[j][1], zT];
    tri(b0, b1, t1);
    tri(b0, t1, t0);
  }
  // Caps: CCW triangulation faces +Z — up for the top cap, reversed for
  // the bottom cap.
  const topTris = THREE.ShapeUtils.triangulateShape(top.map(([x, y]) => new THREE.Vector2(x, y)), []);
  for (const [a, b, c] of topTris) {
    tri([top[a][0], top[a][1], zT], [top[b][0], top[b][1], zT], [top[c][0], top[c][1], zT]);
  }
  const botTris = THREE.ShapeUtils.triangulateShape(bot.map(([x, y]) => new THREE.Vector2(x, y)), []);
  for (const [a, b, c] of botTris) {
    tri([bot[a][0], bot[a][1], zB], [bot[c][0], bot[c][1], zB], [bot[b][0], bot[b][1], zB]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  // three-bvh-csg's Evaluator requires position+uv+normal on BOTH brushes
  // (a position-only soup throws inside evaluate, which buildSolidGeometry
  // swallows — the subtraction would be SILENTLY skipped). Zero-filled uv
  // is fine (no material here samples uv); normals are per-face from the
  // soup and recomputed after CSG anyway.
  g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array((pos.length / 3) * 2), 2));
  g.computeVertexNormals();
  return g;
}

// Mini isometric-cube icon with ONE face highlighted — the axis-view
// buttons. The standard glyph is drawn as seen from the viewer's DEFAULT
// fit direction (+X, −Y, +Z), so its visible faces are TOP, FRONT
// (lower-left parallelogram) and RIGHT (lower-right). The bottom/back/left
// icons use the SAME glyph rotated 180° (= viewed from the opposite
// corner): top→bottom, front→back, right→left, so every highlighted face
// is geometrically the face you'll be looking at.
const CUBE_FACES = {
  topF: 'M8 1.5 L14 4.5 L8 7.5 L2 4.5 Z',
  frontF: 'M2 4.5 L8 7.5 L8 14.5 L2 11.5 Z',
  rightF: 'M14 4.5 L8 7.5 L8 14.5 L14 11.5 Z',
};
function CubeIcon({ face }) {
  const rotated = face === 'bottom' || face === 'back' || face === 'left';
  const hi = (face === 'top' || face === 'bottom') ? 'topF'
    : (face === 'front' || face === 'back') ? 'frontF'
      : 'rightF';
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
      <g transform={rotated ? 'rotate(180 8 8)' : undefined}>
        {['topF', 'frontF', 'rightF'].map(k => (
          <path
            key={k}
            d={CUBE_FACES[k]}
            fill={k === hi ? '#22d3ee' : '#1e293b'}
            stroke={k === hi ? '#67e8f9' : '#64748b'}
            strokeWidth="0.9"
            strokeLinejoin="round"
          />
        ))}
      </g>
    </svg>
  );
}

// Solid spec → BufferGeometry with ALL placement baked in (identity mesh
// transform — required so CSG brushes compose without matrix bookkeeping).
// `inflateZ` grows the solid symmetrically in Z (used on CSG tools).
function buildRawGeometry(THREE, solid, inflateZ = 0) {
  if (solid.kind === 'loft'
      && Array.isArray(solid.ringBottom) && Array.isArray(solid.ringTop)
      && solid.ringBottom.length >= 3 && solid.ringBottom.length === solid.ringTop.length) {
    return buildLoftGeometry(THREE, solid, inflateZ);
  }
  if (solid.kind === 'loft') {
    // Mismatched/degenerate rings — fall back to a straight prism on the
    // bottom ring rather than failing the solid.
    return buildRawGeometry(THREE, { ...solid, kind: 'extrude', ring: solid.ringBottom, holes: [] }, inflateZ);
  }
  if (solid.kind === 'cylinder') {
    const h = Math.max(solid.height + 2 * inflateZ, 1e-4);
    const g = new THREE.CylinderGeometry(solid.r, solid.r, h, 48);
    g.rotateX(Math.PI / 2); // axis → Z
    g.translate(solid.cx, solid.cy, solid.zBottom - inflateZ + h / 2);
    return g;
  }
  if (solid.kind === 'bridge') {
    // Profile is in the (length-axis, absolute-Z) plane; extrude by width.
    const shape = ringToShape(THREE, solid.profile, []);
    const g = new THREE.ExtrudeGeometry(shape, { depth: solid.width, bevelEnabled: false });
    // Local (x, y, z) → (x, −z, y): profile-Y becomes world Z (absolute),
    // the depth axis becomes −Y; recenter the width span then rotate/place.
    g.rotateX(Math.PI / 2);
    g.translate(0, solid.width / 2, 0);
    if (solid.rotationDeg) g.rotateZ((solid.rotationDeg * Math.PI) / 180);
    g.translate(solid.cx, solid.cy, 0);
    return g;
  }
  // extrude (default)
  const shape = ringToShape(THREE, solid.ring, solid.holes);
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: Math.max(solid.height + 2 * inflateZ, 1e-4),
    bevelEnabled: false,
  });
  g.translate(0, 0, solid.zBottom - inflateZ);
  return g;
}

export default function Viewer3D({
  scene,
  paramValues,
  hiddenLayerKeys,
  canvasTheme,
  gridVisible = true,
  setSelection,
  selectedIds,
  onExit,
}) {
  const containerRef = useRef(null);
  const threeRef = useRef(null); // { THREE, csg, renderer, scene3, camera, controls, solidsGroup, grid, raf }
  const didFitRef = useRef(false);
  const [libsReady, setLibsReady] = useState(false);
  const [libsError, setLibsError] = useState(null);
  const [spec, setSpec] = useState(null);
  const [building, setBuilding] = useState(true);
  const [warningsDismissed, setWarningsDismissed] = useState(false);
  // Viewer-local visibility for the substrate/cladding slabs ('stack:<id>'
  // keys) — cladding + substrates default ON (translucent).
  const [stackHidden, setStackHidden] = useState(() => new Set());

  // ── Debounced spec rebuild (CSG on big scenes costs) ───────────────────
  const firstBuildRef = useRef(true);
  useEffect(() => {
    setBuilding(true);
    const run = () => {
      try {
        setSpec(buildScene3D(scene, paramValues));
      } catch (e) {
        setSpec({ solids: [], warnings: [`3-D build failed: ${e.message}`] });
      }
      setBuilding(false);
    };
    if (firstBuildRef.current) {
      firstBuildRef.current = false;
      run();
      return undefined;
    }
    const t = setTimeout(run, 250);
    return () => clearTimeout(t);
  }, [scene, paramValues]);

  // ── three.js bootstrap (once per mount, after libs load) ───────────────
  useEffect(() => {
    let cancelled = false;
    loadLibs().then((libs) => {
      if (cancelled) return;
      const el = containerRef.current;
      if (!el) return;
      const { THREE, OrbitControls, csg } = libs;
      const renderer = new THREE.WebGLRenderer({ antialias: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setSize(el.clientWidth || 400, el.clientHeight || 300);
      renderer.domElement.style.display = 'block';
      el.appendChild(renderer.domElement);

      const scene3 = new THREE.Scene();
      scene3.background = new THREE.Color((canvasTheme && canvasTheme.canvasBg) || '#f1f5f9');
      const camera = new THREE.PerspectiveCamera(45, (el.clientWidth || 400) / (el.clientHeight || 300), 0.1, 1e6);
      camera.up.set(0, 0, 1); // Z-up
      camera.position.set(300, -300, 250);
      const controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controls.dampingFactor = 0.12;

      scene3.add(new THREE.AmbientLight(0xffffff, 0.75));
      const dir = new THREE.DirectionalLight(0xffffff, 1.4);
      dir.position.set(1, -0.8, 1.6);
      scene3.add(dir);
      const dir2 = new THREE.DirectionalLight(0xffffff, 0.5);
      dir2.position.set(-1, 0.8, -0.4);
      scene3.add(dir2);

      const solidsGroup = new THREE.Group();
      scene3.add(solidsGroup);

      const ctx = { THREE, csg, renderer, scene3, camera, controls, solidsGroup, grid: null, raf: 0 };
      threeRef.current = ctx;

      const loop = () => {
        ctx.raf = requestAnimationFrame(loop);
        controls.update();
        renderer.render(scene3, camera);
      };
      loop();

      // Resize with the panel/window.
      const ro = typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => {
          const w = el.clientWidth || 1;
          const h = el.clientHeight || 1;
          renderer.setSize(w, h);
          camera.aspect = w / h;
          camera.updateProjectionMatrix();
        })
        : null;
      ro?.observe(el);
      ctx.ro = ro;
      setLibsReady(true);
    }).catch((e) => {
      if (!cancelled) setLibsError(e?.message || String(e));
    });
    return () => {
      cancelled = true;
      const ctx = threeRef.current;
      if (ctx) {
        cancelAnimationFrame(ctx.raf);
        ctx.ro?.disconnect();
        disposeChildren(ctx.solidsGroup);
        ctx.grid?.geometry?.dispose();
        ctx.grid?.material?.dispose();
        ctx.controls.dispose();
        ctx.renderer.dispose();
        ctx.renderer.domElement.remove();
        threeRef.current = null;
      }
    };
    // Bootstrap ONCE per mount — theme is applied in its own effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Theme background tracks the app theme live.
  useEffect(() => {
    const ctx = threeRef.current;
    if (!ctx || !libsReady) return;
    ctx.scene3.background = new ctx.THREE.Color((canvasTheme && canvasTheme.canvasBg) || '#f1f5f9');
  }, [canvasTheme, libsReady]);

  const disposeChildren = (group) => {
    if (!group) return;
    for (const child of [...group.children]) {
      child.geometry?.dispose();
      if (Array.isArray(child.material)) child.material.forEach(m => m.dispose());
      else child.material?.dispose();
      group.remove(child);
    }
  };

  // Effective hidden keys = canvas LAYERS eyes + viewer-local stack toggles.
  const hiddenAll = useMemo(() => {
    const s = new Set(stackHidden);
    if (hiddenLayerKeys) for (const k of hiddenLayerKeys) s.add(k);
    return s;
  }, [hiddenLayerKeys, stackHidden]);

  // Grid follows the 2-D canvas grid setting (latest-value ref so the mesh
  // rebuild effect reads it at creation; the effect below toggles live
  // without a rebuild).
  const gridVisibleRef = useRef(gridVisible !== false);
  gridVisibleRef.current = gridVisible !== false;
  useEffect(() => {
    const ctx = threeRef.current;
    if (ctx && ctx.grid) ctx.grid.visible = gridVisible !== false;
  }, [gridVisible, spec, libsReady]);

  // ── Mesh (re)build from the spec ───────────────────────────────────────
  useEffect(() => {
    const ctx = threeRef.current;
    if (!ctx || !libsReady || !spec) return;
    const { THREE, csg, solidsGroup } = ctx;
    disposeChildren(solidsGroup);

    const solidById = new Map(spec.solids.map(s => [s.id, s]));
    const evaluator = new csg.Evaluator();
    evaluator.useGroups = false;

    // Recursive CSG resolution: a solid's tools may themselves carry csg.
    const buildSolidGeometry = (solid, inflateZ, depth = 0) => {
      let g = buildRawGeometry(THREE, solid, inflateZ);
      const subtractIds = solid.csg && solid.csg.subtractIds;
      if (subtractIds && subtractIds.length && depth < 8) {
        let brush = new csg.Brush(g);
        brush.updateMatrixWorld();
        for (const tid of subtractIds) {
          const tool = solidById.get(tid);
          if (!tool) continue;
          let tg;
          try {
            tg = buildSolidGeometry(tool, 0.01, depth + 1);
          } catch { continue; }
          const tb = new csg.Brush(tg);
          tb.updateMatrixWorld();
          let next;
          try {
            next = evaluator.evaluate(brush, tb, csg.SUBTRACTION);
          } catch {
            tg.dispose();
            continue; // keep un-subtracted rather than fail the whole solid
          }
          brush.geometry.dispose();
          tg.dispose();
          brush = next;
        }
        g = brush.geometry;
      }
      return g;
    };

    let count = 0;
    for (const solid of spec.solids) {
      if (solid.role === 'tool') continue; // consumed by CSG, never rendered
      if (solid.layerKey && hiddenAll.has(solid.layerKey)) continue;
      let geom;
      try {
        geom = buildSolidGeometry(solid, 0);
      } catch (e) {
        // A degenerate ring shouldn't take the whole viewer down.
        // eslint-disable-next-line no-console
        console.warn('Viewer3D: failed to build solid', solid.id, e);
        continue;
      }
      geom.computeVertexNormals();
      const translucent = solid.opacity < 1;
      const mat = new THREE.MeshStandardMaterial({
        color: new THREE.Color(solid.color || '#94a3b8'),
        roughness: 0.55,
        metalness: 0.25,
        flatShading: true,
        transparent: translucent,
        opacity: solid.opacity ?? 1,
        depthWrite: !translucent,
        side: translucent ? THREE.DoubleSide : THREE.FrontSide,
      });
      const mesh = new THREE.Mesh(geom, mat);
      mesh.userData = {
        compId: solid.compId,
        selectId: solid.selectId ?? solid.compId,
        layerKey: solid.layerKey,
        stackSlab: solid.role === 'stack',
        label: solid.label,
      };
      if (solid.role === 'stack') mesh.renderOrder = 2; // draw translucents late
      solidsGroup.add(mesh);
      count++;
    }
    containerRef.current?.setAttribute('data-solid-count', String(count));

    // Grid at z=0 sized to the geometry (subtle, theme-tinted).
    if (ctx.grid) {
      ctx.scene3.remove(ctx.grid);
      ctx.grid.geometry?.dispose();
      ctx.grid.material?.dispose();
      ctx.grid = null;
    }
    const bb = new THREE.Box3().setFromObject(solidsGroup);
    if (!bb.isEmpty()) {
      const span = Math.max(bb.max.x - bb.min.x, bb.max.y - bb.min.y) * 1.4 || 100;
      const grid = new THREE.GridHelper(span, 20,
        new THREE.Color((canvasTheme && canvasTheme.gridMajor) || '#94a3b8'),
        new THREE.Color((canvasTheme && canvasTheme.gridFine) || '#cbd5e1'));
      grid.rotation.x = Math.PI / 2; // XZ → XY plane (z-up)
      grid.position.set((bb.min.x + bb.max.x) / 2, (bb.min.y + bb.max.y) / 2, 0);
      grid.material.transparent = true;
      grid.material.opacity = 0.35;
      grid.visible = gridVisibleRef.current;
      ctx.scene3.add(grid);
      ctx.grid = grid;
    }

    if (!didFitRef.current && count > 0) {
      didFitRef.current = true;
      fitToSolids();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec, libsReady, hiddenAll]);

  // ── Selection highlight ────────────────────────────────────────────────
  useEffect(() => {
    const ctx = threeRef.current;
    if (!ctx || !libsReady) return;
    for (const mesh of ctx.solidsGroup.children) {
      const sel = selectedIds && (selectedIds.has(mesh.userData.selectId) || selectedIds.has(mesh.userData.compId));
      if (mesh.material && mesh.material.emissive) {
        mesh.material.emissive.set(sel ? 0x22d3ee : 0x000000);
        mesh.material.emissiveIntensity = sel ? 0.45 : 0;
      }
    }
  }, [selectedIds, libsReady, spec, hiddenAll]);

  // ── Fit camera ─────────────────────────────────────────────────────────
  // Fits to the DEVICE solids when any exist (the translucent substrate
  // slab can be hundreds of µm thick — fitting to it would shrink the
  // actual geometry to a sliver); falls back to everything.
  const fitInfo = useCallback(() => {
    const ctx = threeRef.current;
    if (!ctx) return null;
    const { THREE, camera, solidsGroup } = ctx;
    const device = solidsGroup.children.filter(m => !m.userData.stackSlab);
    const bb = new THREE.Box3();
    for (const m of (device.length ? device : solidsGroup.children)) bb.expandByObject(m);
    if (bb.isEmpty()) return null;
    const center = bb.getCenter(new THREE.Vector3());
    const size = bb.getSize(new THREE.Vector3());
    const radius = Math.max(size.x, size.y, size.z, 1) * 0.6;
    const dist = radius / Math.tan((camera.fov * Math.PI) / 360) * 1.25;
    return { center, dist };
  }, []);

  const placeCamera = useCallback((dirVec) => {
    const ctx = threeRef.current;
    const fit = fitInfo();
    if (!ctx || !fit) return;
    const { camera, controls } = ctx;
    const dir = new ctx.THREE.Vector3(...dirVec).normalize();
    camera.position.copy(fit.center.clone().add(dir.multiplyScalar(fit.dist)));
    camera.near = Math.max(fit.dist / 1000, 0.01);
    camera.far = fit.dist * 1000;
    camera.updateProjectionMatrix();
    controls.target.copy(fit.center);
    controls.update();
  }, [fitInfo]);

  const fitToSolids = useCallback(() => {
    placeCamera([0.65, -0.75, 0.55]);
  }, [placeCamera]);

  // Six axis-aligned views (Z-up: front = looking from −Y, right = from
  // +X, top = from +Z). Top/bottom keep a hair of −Y tilt so the view
  // direction is never exactly parallel to camera.up (OrbitControls'
  // singular pole). Rendered as cube icons with the target face
  // highlighted (CubeIcon).
  const AXIS_VIEWS = [
    { key: 'top', title: 'Top view (looking down −Z)', dir: [0, -1e-3, 1] },
    { key: 'bottom', title: 'Bottom view (looking up +Z)', dir: [0, -1e-3, -1] },
    { key: 'front', title: 'Front view (looking along +Y)', dir: [0, -1, 0] },
    { key: 'back', title: 'Back view (looking along −Y)', dir: [0, 1, 0] },
    { key: 'left', title: 'Left view (looking along +X)', dir: [-1, 0, 0] },
    { key: 'right', title: 'Right view (looking along −X)', dir: [1, 0, 0] },
  ];

  // ── Click → selection sync (raycast; small-move threshold vs orbit) ────
  const downRef = useRef(null);
  const onPointerDown = useCallback((e) => {
    downRef.current = { x: e.clientX, y: e.clientY };
  }, []);
  const onPointerUp = useCallback((e) => {
    const d = downRef.current;
    downRef.current = null;
    if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5) return; // it was an orbit drag
    const ctx = threeRef.current;
    if (!ctx || !setSelection) return;
    const rect = ctx.renderer.domElement.getBoundingClientRect();
    const ndc = new ctx.THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    const ray = new ctx.THREE.Raycaster();
    ray.setFromCamera(ndc, ctx.camera);
    const pickable = ctx.solidsGroup.children.filter(m => !m.userData.stackSlab);
    const hits = ray.intersectObjects(pickable, false);
    if (hits.length > 0) {
      const id = hits[0].object.userData.selectId || hits[0].object.userData.compId;
      if (id) setSelection({ ids: new Set([id]), primary: id });
    } else {
      setSelection({ ids: new Set(), primary: null });
    }
  }, [setSelection]);

  // Esc returns to 2-D.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onExit?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onExit]);

  // Stack-slab toggle entries from the spec.
  const stackEntries = useMemo(() => {
    if (!spec) return [];
    const seen = new Map();
    for (const s of spec.solids) {
      if (s.layerKey && s.layerKey.startsWith('stack:') && !seen.has(s.layerKey)) {
        seen.set(s.layerKey, { key: s.layerKey, label: s.label, color: s.color });
      }
    }
    return [...seen.values()];
  }, [spec]);

  const warnings = (spec && spec.warnings) || [];

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 overflow-hidden"
      data-testid="viewer3d"
      data-solid-count="0"
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      style={{ background: (canvasTheme && canvasTheme.canvasBg) || '#f1f5f9' }}
    >
      {!libsReady && !libsError && (
        <div className="absolute inset-0 flex items-center justify-center text-xs" style={{ color: 'var(--app-slate-400)' }}>
          loading 3-D engine…
        </div>
      )}
      {libsError && (
        <div className="absolute inset-0 flex items-center justify-center text-xs text-red-400 px-8 text-center">
          Failed to load the 3-D engine: {libsError}
        </div>
      )}

      {/* Top-left: mode banner + fit + rebuild hint */}
      <div className="absolute top-2 left-2 flex items-center gap-2 pointer-events-none">
        <div className="px-2 py-1 rounded text-[10px] font-medium pointer-events-auto" style={{ background: 'rgba(15,23,42,0.85)', color: '#67e8f9' }}>
          3-D preview — approximation of the HFSS build · Esc = back to 2-D
        </div>
        <button
          onClick={fitToSolids}
          className="px-2 py-1 rounded text-[10px] border pointer-events-auto"
          style={{ background: 'rgba(15,23,42,0.85)', color: '#e2e8f0', borderColor: '#475569' }}
          title="Fit the camera to the geometry"
        >
          fit
        </button>
        <div className="flex rounded border overflow-hidden pointer-events-auto" style={{ borderColor: '#475569' }}>
          {AXIS_VIEWS.map((v, i) => (
            <button
              key={v.key}
              onClick={() => placeCamera(v.dir)}
              className="px-1 py-0.5 flex items-center"
              style={{
                background: 'rgba(15,23,42,0.85)',
                borderLeft: i > 0 ? '1px solid #475569' : 'none',
              }}
              title={v.title}
              aria-label={v.title}
              data-view={v.key}
            >
              <CubeIcon face={v.key} />
            </button>
          ))}
        </div>
        {building && (
          <div className="px-2 py-1 rounded text-[10px] pointer-events-auto" style={{ background: 'rgba(120,53,15,0.8)', color: '#fcd34d' }}>
            rebuilding…
          </div>
        )}
      </div>

      {/* Top-right: stack-slab visibility toggles */}
      {stackEntries.length > 0 && (
        <div className="absolute top-2 right-2 rounded px-2 py-1.5 space-y-0.5" style={{ background: 'rgba(15,23,42,0.85)' }}>
          <div className="text-[9px] uppercase tracking-wider" style={{ color: 'var(--app-slate-500, #64748b)' }}>Stack slabs</div>
          {stackEntries.map(en => (
            <label key={en.key} className="flex items-center gap-1.5 text-[10px] cursor-pointer select-none" style={{ color: '#cbd5e1' }}>
              <input
                type="checkbox"
                checked={!stackHidden.has(en.key)}
                onChange={() => setStackHidden(prev => {
                  const next = new Set(prev);
                  if (next.has(en.key)) next.delete(en.key);
                  else next.add(en.key);
                  return next;
                })}
              />
              <span className="inline-block w-2 h-2 rounded-sm" style={{ background: en.color }} />
              {en.label}
            </label>
          ))}
        </div>
      )}

      {/* Bottom-left: viewer approximation warnings (dismissible) */}
      {warnings.length > 0 && !warningsDismissed && (
        <div className="absolute bottom-2 left-2 max-w-md rounded px-2.5 py-2" style={{ background: 'rgba(15,23,42,0.9)' }}>
          <div className="flex items-center justify-between gap-3 mb-1">
            <span className="text-[10px] font-medium" style={{ color: '#fcd34d' }}>viewer approximations</span>
            <button onClick={() => setWarningsDismissed(true)} className="text-[10px]" style={{ color: '#94a3b8' }}>✕ dismiss</button>
          </div>
          <ul className="space-y-0.5 max-h-32 overflow-y-auto">
            {warnings.map((w, i) => (
              <li key={i} className="text-[10px] leading-snug" style={{ color: '#cbd5e1' }}>· {w}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
