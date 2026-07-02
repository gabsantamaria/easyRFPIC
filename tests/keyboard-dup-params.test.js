// C4 / C6 / C7 — pure helpers behind the keyboard speed pack, duplicate-
// with-external-snaps, and the PARAMS-panel prefix grouping. These live at
// module scope in PhotonicLayout.jsx (exported) so they can be verified
// without a DOM:
//   - collectNudgeCluster:     arrow-nudge boolean-cluster expansion (C4)
//   - cloneSnapsForDuplicate:  snap cloning rules for duplicateIds (C6)
//   - groupParamPrefixes:      PARAMS-panel prefix grouping (C7)
import { describe, it, expect } from 'vitest';
import {
  collectNudgeCluster, cloneSnapsForDuplicate, groupParamPrefixes,
  deleteComponentsFromScene,
} from '../src/PhotonicLayout.jsx';

// ── C4: collectNudgeCluster ──────────────────────────────────────────────

const rect = (id, extra = {}) => ({ id, kind: 'rect', cx: 0, cy: 0, w: '10', h: '10', ...extra });

describe('collectNudgeCluster (C4 arrow nudge)', () => {
  it('a free primitive moves alone', () => {
    const comps = [rect('a'), rect('b')];
    expect([...collectNudgeCluster(comps, new Set(['a']))].sort()).toEqual(['a']);
  });

  it('an operand of a boolean drags the WHOLE cluster (drag parity)', () => {
    const comps = [
      rect('a', { consumedBy: 'b1' }),
      rect('b', { consumedBy: 'b1' }),
      { id: 'b1', kind: 'boolean', op: 'union', operandIds: ['a', 'b'], cx: 0, cy: 0, w: '0', h: '0' },
    ];
    const got = [...collectNudgeCluster(comps, new Set(['a']))].sort();
    expect(got).toEqual(['a', 'b', 'b1']);
  });

  it('selecting the boolean itself moves its consumed operands', () => {
    const comps = [
      rect('a', { consumedBy: 'b1' }),
      rect('b', { consumedBy: 'b1' }),
      { id: 'b1', kind: 'boolean', op: 'union', operandIds: ['a', 'b'], cx: 0, cy: 0, w: '0', h: '0' },
    ];
    const got = [...collectNudgeCluster(comps, new Set(['b1']))].sort();
    expect(got).toEqual(['a', 'b', 'b1']);
  });

  it('punch tools (NOT consumed by the boolean) stay independent', () => {
    const comps = [
      rect('base', { consumedBy: 'p1' }),
      rect('tool'), // punch keeps the tool standalone — no consumedBy
      { id: 'p1', kind: 'boolean', op: 'punch', operandIds: ['base', 'tool'], cx: 0, cy: 0, w: '0', h: '0' },
    ];
    const got = [...collectNudgeCluster(comps, new Set(['base']))].sort();
    expect(got).toEqual(['base', 'p1']);
    // …and nudging the tool moves only the tool.
    expect([...collectNudgeCluster(comps, new Set(['tool']))]).toEqual(['tool']);
  });

  it('nested booleans expand recursively without infinite loops', () => {
    const comps = [
      rect('a', { consumedBy: 'inner' }),
      rect('b', { consumedBy: 'inner' }),
      { id: 'inner', kind: 'boolean', op: 'union', operandIds: ['a', 'b'], consumedBy: 'outer', cx: 0, cy: 0, w: '0', h: '0' },
      rect('c', { consumedBy: 'outer' }),
      { id: 'outer', kind: 'boolean', op: 'subtract', operandIds: ['inner', 'c'], cx: 0, cy: 0, w: '0', h: '0' },
    ];
    const got = [...collectNudgeCluster(comps, new Set(['a']))].sort();
    expect(got).toEqual(['a', 'b', 'c', 'inner', 'outer']);
  });

  it('unknown ids are ignored', () => {
    expect(collectNudgeCluster([rect('a')], new Set(['ghost'])).size).toBe(0);
  });
});

// ── C6: cloneSnapsForDuplicate ───────────────────────────────────────────

const snap = (id, fromId, toId, extra = {}) => ({
  id,
  from: { compId: fromId, anchor: 'E' },
  to: { compId: toId, anchor: 'W' },
  dx: 'gap', dy: '0',
  ...extra,
});

describe('cloneSnapsForDuplicate (C6)', () => {
  let n = 0;
  const makeId = () => `snap_new_${n++}`;
  const ids = new Set(['a', 'b']);
  const idMap = { a: 'a_copy', b: 'b_copy' };

  it('clones INTERNAL snaps with both endpoints remapped', () => {
    const out = cloneSnapsForDuplicate([snap('s1', 'a', 'b')], ids, idMap, makeId);
    expect(out).toHaveLength(1);
    expect(out[0].from.compId).toBe('a_copy');
    expect(out[0].to.compId).toBe('b_copy');
    expect(out[0].id).not.toBe('s1');
    expect(out[0].dx).toBe('gap'); // offsets preserved
  });

  it('clones EXTERNAL INCOMING snaps — outside parent stays, inside child remaps', () => {
    const out = cloneSnapsForDuplicate([snap('s2', 'ext', 'a')], ids, idMap, makeId);
    expect(out).toHaveLength(1);
    expect(out[0].from.compId).toBe('ext');     // same external parent
    expect(out[0].to.compId).toBe('a_copy');    // copy hangs off it
  });

  it('DROPS external OUTGOING snaps (cloning would duplicate-target the external to)', () => {
    const out = cloneSnapsForDuplicate([snap('s3', 'a', 'ext')], ids, idMap, makeId);
    expect(out).toHaveLength(0);
  });

  it('ignores snaps fully outside the selection', () => {
    const out = cloneSnapsForDuplicate([snap('s4', 'x', 'y')], ids, idMap, makeId);
    expect(out).toHaveLength(0);
  });

  it('does not mutate the input snaps', () => {
    const s = snap('s5', 'ext', 'b');
    cloneSnapsForDuplicate([s], ids, idMap, makeId);
    expect(s.to.compId).toBe('b');
    expect(s.id).toBe('s5');
  });
});

// ── C7: groupParamPrefixes ───────────────────────────────────────────────

describe('groupParamPrefixes (C7 PARAMS grouping)', () => {
  it('groups >= 4 members sharing the prefix before the LAST underscore token', () => {
    const names = ['meander_h_1', 'meander_h_2', 'meander_h_3', 'meander_h_4', 'gap', 'w_wg'];
    const { sections, flat } = groupParamPrefixes(names, 4);
    expect(sections).toHaveLength(1);
    expect(sections[0].prefix).toBe('meander_h');
    expect(sections[0].names).toEqual(['meander_h_1', 'meander_h_2', 'meander_h_3', 'meander_h_4']);
    expect(flat).toEqual(['gap', 'w_wg']);
  });

  it('groups below the threshold stay flat (original order preserved)', () => {
    const names = ['cap_w', 'cap_h', 'cap_d', 'gap'];
    const { sections, flat } = groupParamPrefixes(names, 4);
    expect(sections).toHaveLength(0);
    expect(flat).toEqual(names);
  });

  it('underscore-free and leading-underscore names never group', () => {
    const names = ['alpha', '_x_1', '_x_2', '_x_3', '_x_4'];
    // '_x_N' → lastIndexOf('_') = 2 > 0 → prefix '_x' CAN group; 'alpha' cannot.
    const { sections, flat } = groupParamPrefixes(names, 4);
    expect(sections.map(s => s.prefix)).toEqual(['_x']);
    expect(flat).toEqual(['alpha']);
    // but a bare leading underscore like '_a' (lastIndexOf === 0) stays flat
    const r2 = groupParamPrefixes(['_a', '_b', '_c', '_d'], 4);
    expect(r2.sections).toHaveLength(0);
    expect(r2.flat).toEqual(['_a', '_b', '_c', '_d']);
  });

  it('sections appear in order of first appearance; flat after', () => {
    const names = [
      'b_1', 'a_1', 'b_2', 'a_2', 'b_3', 'a_3', 'b_4', 'a_4', 'solo',
    ];
    const { sections, flat } = groupParamPrefixes(names, 4);
    expect(sections.map(s => s.prefix)).toEqual(['b', 'a']);
    expect(flat).toEqual(['solo']);
  });

  it('a name belongs to exactly one prefix (the last-token split)', () => {
    const names = ['m_h_1', 'm_h_2', 'm_h_3', 'm_h_4', 'm_w'];
    const { sections, flat } = groupParamPrefixes(names, 4);
    expect(sections[0].prefix).toBe('m_h');
    expect(flat).toEqual(['m_w']); // prefix 'm' has only 1 member
  });
});

// ── deleteComponentsFromScene (zombie-operand fix) ───────────────────────

describe('deleteComponentsFromScene', () => {
  const mkScene = () => ({
    components: [
      rect('a', { consumedBy: 'u' }),
      rect('b', { consumedBy: 'u' }),
      { id: 'u', kind: 'boolean', op: 'union', operandIds: ['a', 'b'], cx: 0, cy: 0, w: '0', h: '0' },
      rect('tool', { consumedBy: 'p', cloneOf: 'port1' }),
      rect('blank', { consumedBy: 'p' }),
      { id: 'p', kind: 'boolean', op: 'punch', operandIds: ['blank', 'tool'], cx: 0, cy: 0, w: '0', h: '0' },
      rect('free'),
    ],
    snaps: [
      { id: 's1', from: { compId: 'free', anchor: 'C' }, to: { compId: 'a', anchor: 'C' }, dx: '0', dy: '0' },
      { id: 's2', from: { compId: 'free', anchor: 'C' }, to: { compId: 'tool', anchor: 'C' }, dx: '0', dy: '0' },
    ],
    mirrors: [{ id: 'm1', axis: 'x', axisCoord: 0, members: [{ srcId: 'a', mirrorId: 'free', locked: true }] }],
    groups: [{ id: 'g1', name: 'g', memberIds: ['u', 'free'] }],
  });

  it('deleting a BOOLEAN releases its operands (no invisible zombies) and keeps consistency', () => {
    const next = deleteComponentsFromScene(mkScene(), new Set(['u']));
    const a = next.components.find(c => c.id === 'a');
    const b = next.components.find(c => c.id === 'b');
    // Operands SURVIVE with consumedBy cleared — they render standalone again.
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(a.consumedBy).toBeUndefined();
    expect(b.consumedBy).toBeUndefined();
    // NO component keeps a dangling consumedBy → no zombie invisible to
    // the renderer/SHAPES list but still flowing into exports.
    const ids = new Set(next.components.map(c => c.id));
    for (const c of next.components) {
      if (c.consumedBy) expect(ids.has(c.consumedBy)).toBe(true);
    }
    // Group membership pruned; the group survives via 'free'.
    expect(next.groups[0].memberIds).toEqual(['free']);
  });

  it('deleting a PUNCH boolean drops its clone tool but keeps the blank', () => {
    const next = deleteComponentsFromScene(mkScene(), new Set(['p']));
    expect(next.components.find(c => c.id === 'tool')).toBeUndefined(); // cloneOf helper dies with the boolean
    const blank = next.components.find(c => c.id === 'blank');
    expect(blank).toBeTruthy();
    expect(blank.consumedBy).toBeUndefined();
    // The snap that targeted the dropped clone dies with it.
    expect(next.snaps.map(s => s.id)).toEqual(['s1']);
  });

  it('deleting a primitive leaves booleans and other members intact', () => {
    const next = deleteComponentsFromScene(mkScene(), new Set(['free']));
    expect(next.components.find(c => c.id === 'u')).toBeTruthy();
    expect(next.snaps).toHaveLength(0);        // both snaps hung off 'free'
    expect(next.mirrors).toHaveLength(0);      // mirror member referenced 'free'
    expect(next.groups[0].memberIds).toEqual(['u']);
  });
});
