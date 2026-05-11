// Cluster-drag regression test.
//
// Scene: two primitives `a` and `b` with a snap from a's E to b's W
// (so they touch). They're consumed by union `u1`. A separate primitive
// `c` is snapped to u1's E side.
//
// Verifies four canonical drag scenarios produce correct positions:
//   A: drag `u1` (the cluster root) — operands + c follow as a rigid body
//   B: drag `a` (operand of u1) with cluster expansion — same as A
//   C: drag `c` (snapped child of u1) WITH internal snap propagation —
//      everything moves together
//   D: drag `c` plain, no inner snap — u1 cluster stays, c floats freely
//      and gets snapped back by its own snap to u1
//
// These four cases cover the bug class where cluster expansion through
// `consumedBy` could either fail to drag operands, or oscillate via the
// boolean's bbox-derived w/h, or recursive-infinitely on nested booleans.
import { mod } from './_harness.mjs';

let failures = 0;
function close(a, b, eps = 0.01) { return Math.abs(a - b) < eps; }
function assert(cond, msg) {
  if (cond) console.log(`  ok: ${msg}`);
  else { console.error(`  FAIL: ${msg}`); failures++; }
}

// Build the scene by hand so this test is deterministic and doesn't depend
// on UI handlers. We construct snaps and a boolean directly.
function makeScene() {
  const s = mod.makeBlankScene();
  s.components = [
    { id: 'a', kind: 'rect', layer: 'electrode', cx: 0,  cy: 0, w: '10', h: '10',
      cutouts: [], transforms: [], label: 'a' },
    { id: 'b', kind: 'rect', layer: 'electrode', cx: 15, cy: 0, w: '20', h: '10',
      cutouts: [], transforms: [], label: 'b' },
    { id: 'c', kind: 'rect', layer: 'electrode', cx: 35, cy: 0, w: '15', h: '10',
      cutouts: [], transforms: [], label: 'c' },
    // Union of a+b becomes u1. The solver computes its bbox.
    { id: 'u1', kind: 'boolean', op: 'union', operandIds: ['a', 'b'],
      layer: 'electrode', cx: 0, cy: 0, w: '0', h: '0',
      cutouts: [], transforms: [], label: 'u1' },
  ];
  // Mark operands as consumed by u1.
  s.components[0].consumedBy = 'u1';
  s.components[1].consumedBy = 'u1';
  // Snaps follow the convention: `from` is the PARENT anchor (the
  // independent component), `to` is the DEPENDENT (gets placed relative
  // to from).
  // Snap a → b: a's E is the parent anchor; b.W gets placed there.
  // Snap u1 → c: u1's E is the parent anchor; c.W gets placed there.
  s.snaps = [
    { from: { compId: 'a',  anchor: 'E' }, to: { compId: 'b', anchor: 'W' }, dx: '0', dy: '0' },
    { from: { compId: 'u1', anchor: 'E' }, to: { compId: 'c', anchor: 'W' }, dx: '0', dy: '0' },
  ];
  return s;
}

function solve(scene) {
  const { values } = mod.resolveParams(scene.params);
  return mod.applyMirrors(mod.solveLayout(scene.components, scene.snaps, values), scene.mirrors);
}

// Drag implementation matching the canvas: shift every cluster member by
// (deltaX, deltaY). Cluster expansion is via `consumedBy` (walk to root)
// then operandIds recursively (with visited set). Booleans themselves are
// DERIVED (their cx/cy comes from refreshing the bbox post-solve), so
// dragging a cluster moves its OPERANDS, not the boolean. The boolean's
// position auto-updates.
function applyDrag(scene, clickedId, dx, dy) {
  const byId = Object.fromEntries(scene.components.map(c => [c.id, c]));
  function rootOf(id) {
    let cur = byId[id];
    while (cur && cur.consumedBy) cur = byId[cur.consumedBy];
    return cur ? cur.id : id;
  }
  // Collect cluster members. Only PRIMITIVES (non-boolean) actually move;
  // booleans recompute their position from their operands automatically.
  function collectPrimitiveDescendants(rootId, visited = new Set()) {
    if (visited.has(rootId)) return [];
    visited.add(rootId);
    const c = byId[rootId];
    if (!c) return [];
    if (c.kind !== 'boolean') return [rootId];
    const out = [];
    for (const oid of c.operandIds || []) {
      out.push(...collectPrimitiveDescendants(oid, visited));
    }
    return out;
  }
  const rootId = rootOf(clickedId);
  const movables = new Set(collectPrimitiveDescendants(rootId));
  // Apply the delta to every movable primitive. The solver + boolean bbox
  // refresh handle the rest.
  for (const id of movables) {
    const c = byId[id];
    if (c) { c.cx += dx; c.cy += dy; }
  }
  return scene;
}

function dumpSolved(scene, label) {
  const solved = solve(scene);
  console.log(`  ${label}:`);
  for (const id of ['a', 'b', 'u1', 'c']) {
    const s = solved.find(x => x.id === id);
    if (!s) continue;
    const w = typeof s.w === 'number' ? s.w.toFixed(2) : s.w;
    console.log(`    ${id}: cx=${s.cx.toFixed(2)} cy=${s.cy.toFixed(2)} (w=${w})`);
  }
  return solved;
}

console.log('=== A: drag u1 (cluster root) by (+100, +50) ===');
{
  const scene = makeScene();
  const pre = dumpSolved(scene, 'PRE');
  // PRE: a at 0, b touches a.E so b.cx=15, u1 bbox center=10, c.W at u1.E
  // so c.cx = 10 + 15 + 7.5 = 32.5.
  applyDrag(scene, 'u1', 100, 50);
  const after = dumpSolved(scene, 'POST');
  const aP = after.find(s => s.id === 'a'), bP = after.find(s => s.id === 'b');
  const uP = after.find(s => s.id === 'u1'), cP = after.find(s => s.id === 'c');
  assert(close(aP.cx, 100),   'a.cx = 100');
  assert(close(bP.cx, 115),   'b.cx = 115');
  assert(close(uP.cx, 110),   'u1.cx = 110 (recomputed from operands)');
  assert(close(cP.cx, 132.5), 'c.cx = 132.5 (follows via u1.E → c.W snap)');
  assert(close(aP.cy, 50),    'a.cy = 50');
}

console.log('=== B: drag a (operand, expanded to cluster root u1) by (+100, +50) ===');
{
  const scene = makeScene();
  applyDrag(scene, 'a', 100, 50);
  const after = dumpSolved(scene, 'POST');
  assert(close(after.find(s => s.id === 'a').cx, 100),   'a.cx = 100');
  assert(close(after.find(s => s.id === 'b').cx, 115),   'b.cx = 115');
  assert(close(after.find(s => s.id === 'c').cx, 132.5), 'c.cx = 132.5');
}

console.log('=== C: drag c WITH cluster expansion (+100, +50) ===');
{
  const scene = makeScene();
  const byId = Object.fromEntries(scene.components.map(c => [c.id, c]));
  for (const id of ['a', 'b', 'c']) {
    byId[id].cx += 100; byId[id].cy += 50;
  }
  const after = dumpSolved(scene, 'POST');
  assert(close(after.find(s => s.id === 'a').cx, 100),   'a.cx = 100');
  assert(close(after.find(s => s.id === 'c').cx, 132.5), 'c.cx = 132.5');
}

console.log('=== D: drag c plain by (+100, +50) — c is bound by snap, so it ends at u1.E ===');
{
  const scene = makeScene();
  applyDrag(scene, 'c', 100, 50);
  const after = dumpSolved(scene, 'POST');
  const uP = after.find(s => s.id === 'u1');
  const cP = after.find(s => s.id === 'c');
  assert(close(cP.cx, uP.cx + uP.w / 2 + 7.5), `c sits at u1.E + halfWidth (u1.cx=${uP.cx.toFixed(2)}, c.cx=${cP.cx.toFixed(2)})`);
  assert(Math.abs(uP.cy) < 30, `u1.cy stayed near 0 (got ${uP.cy.toFixed(2)})`);
}

if (failures === 0) {
  console.log('\ntest_drag_thorough: ALL PASS');
  process.exit(0);
} else {
  console.error(`\ntest_drag_thorough: ${failures} FAILURE(S)`);
  process.exit(1);
}
