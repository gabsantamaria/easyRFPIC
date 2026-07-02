import { describe, it, expect } from 'vitest';
import {
  defaultStack,
  normalizeScene,
  makeDefaultScene,
  makeBlankScene,
  scenesEqual,
} from '../src/scene/schema.js';

describe('defaultStack', () => {
  it('returns a non-empty stack with stable roles', () => {
    const s = defaultStack();
    expect(Array.isArray(s)).toBe(true);
    expect(s.length).toBeGreaterThan(0);
    const roles = s.map((l) => l.role);
    for (const r of ['substrate', 'waveguide', 'cladding', 'conductor']) {
      expect(roles).toContain(r);
    }
  });
});

describe('makeBlankScene / makeDefaultScene', () => {
  it('makeBlankScene has the canonical shape and empty arrays', () => {
    const s = makeBlankScene();
    expect(s.params).toBeTypeOf('object');
    expect(s.components).toEqual([]);
    expect(s.snaps).toEqual([]);
    expect(s.groups).toEqual([]);
    expect(s.mirrors).toEqual([]);
    expect(Array.isArray(s.stack)).toBe(true);
  });
  it('makeBlankScene pre-populates params for every identifier the default stack references', () => {
    const s = makeBlankScene();
    // Every name appearing in a stack field must have a corresponding
    // entry in params with a finite expr.
    for (const layer of s.stack) {
      for (const f of ['thickness', 'core_width', 'slab_height', 'slab_width', 'etch_angle']) {
        const v = layer[f];
        if (typeof v !== 'string') continue;
        const idents = v.match(/[A-Za-z_][A-Za-z0-9_]*/g) || [];
        for (const id of idents) {
          expect(s.params[id], `missing param "${id}" referenced by ${layer.id}.${f}`).toBeDefined();
          expect(s.params[id].expr).toBeTypeOf('string');
        }
      }
    }
  });
  it('makeDefaultScene has non-empty content', () => {
    const s = makeDefaultScene();
    expect(Object.keys(s.params).length).toBeGreaterThan(0);
    expect(s.components.length).toBeGreaterThan(0);
  });
});

describe('normalizeScene', () => {
  it('returns the default scene for non-object input', () => {
    expect(normalizeScene(null).components.length).toBeGreaterThan(0);
    expect(normalizeScene(undefined).components.length).toBeGreaterThan(0);
  });
  it('preserves params / components on an already-shaped input', () => {
    const blank = makeBlankScene();
    const out = normalizeScene(blank);
    expect(out.components).toEqual(blank.components);
    expect(out.snaps).toEqual(blank.snaps);
  });
  it('fills in missing top-level arrays', () => {
    const partial = { params: {}, components: [{ id: 'x', cx: 0, cy: 0, w: '1', h: '1' }] };
    const out = normalizeScene(partial);
    expect(Array.isArray(out.snaps)).toBe(true);
    expect(Array.isArray(out.groups)).toBe(true);
    expect(Array.isArray(out.mirrors)).toBe(true);
    expect(Array.isArray(out.stack)).toBe(true);
  });
});

describe('normalizeScene determinism + scenesEqual (version-restore false-positive fix)', () => {
  // A PRE-MIGRATION scene: a punch clone WITHOUT its C→C pin snap.
  // normalizeScene ADDS the pin snap on load — its id used to embed
  // Date.now(), making normalization non-idempotent: a scene loaded from
  // an old snapshot never deep-equaled the frozen snapshot, so hopping
  // between versions nagged with phantom "unsnapshotted edits" + a
  // pointless rescue snapshot on every click.
  const preMigrationScene = () => ({
    params: { feed_w: { expr: '10', unit: 'µm', desc: '' } },
    components: [
      { id: 'bar', kind: 'rect', layer: 'electrode', cx: 0, cy: 0, w: 'feed_w', h: '40', cutouts: [], transforms: [], consumedBy: 'pn' },
      { id: 'tool_clone', kind: 'rect', layer: 'electrode', cx: 0, cy: 0, w: '8', h: '8', cutouts: [], transforms: [], consumedBy: 'pn', cloneOf: 'prt' },
      { id: 'prt', kind: 'rect', layer: 'port', cx: 0, cy: 0, w: '8', h: '8', cutouts: [], transforms: [] },
      { id: 'pn', kind: 'boolean', op: 'punch', operandIds: ['bar', 'tool_clone'], layer: 'electrode', cx: 0, cy: 0, w: '0', h: '0', cutouts: [], transforms: [], label: '' },
    ],
    snaps: [], mirrors: [], groups: [], booleans: [],
    stack: defaultStack(), stackName: 'test', simSetup: {},
  });

  it('the clone-pin migration is DETERMINISTIC and idempotent', () => {
    const frozen = preMigrationScene();
    const a = normalizeScene(JSON.parse(JSON.stringify(frozen)));
    const b = normalizeScene(JSON.parse(JSON.stringify(frozen)));
    // Same input → byte-identical output (no Date.now()/random ids).
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    // The added pin snap has the clone-keyed deterministic id.
    const pin = a.snaps.find(s => s.to.compId === 'tool_clone' && s.from.anchor === 'C' && s.to.anchor === 'C');
    expect(pin).toBeTruthy();
    expect(pin.id).toBe('snap_clonepin_tool_clone');
    // Idempotent: normalizing the normalized scene changes nothing.
    expect(JSON.stringify(normalizeScene(JSON.parse(JSON.stringify(a))))).toBe(JSON.stringify(a));
  });

  it('scenesEqual: a scene LOADED from an old snapshot equals that snapshot (zero-loss hop)', () => {
    const frozen = preMigrationScene();               // what the snapshot holds
    const live = normalizeScene(JSON.parse(JSON.stringify(frozen))); // what setScene loads
    // Raw stringify DIFFERS (the migration added a snap) — the old check
    // false-positived here…
    expect(JSON.stringify(live)).not.toBe(JSON.stringify(frozen));
    // …but canonically they are the SAME information.
    expect(scenesEqual(live, frozen)).toBe(true);
  });

  it('scenesEqual: a REAL edit still reads as modified', () => {
    const frozen = preMigrationScene();
    const live = normalizeScene(JSON.parse(JSON.stringify(frozen)));
    const edited = { ...live, components: live.components.map(c => c.id === 'prt' ? { ...c, cx: c.cx + 5 } : c) };
    expect(scenesEqual(edited, frozen)).toBe(false);
    // Trivia guards
    expect(scenesEqual(null, frozen)).toBe(false);
    expect(scenesEqual(frozen, frozen)).toBe(true);
  });
});
