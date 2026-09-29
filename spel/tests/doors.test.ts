// Door leaves against each other (doors.ts) with the chalet's real hinges (chalet.glb) and openings (measured against
// chalet_coll.bin as at load): every round starts with valid leaves, and the wc and kids-room-1 doors - hinged 7 cm
// apart in one corner - open and close in rounds 9 and 10 (both started wide open through each other: locked, 29-09-2026).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readCollision, TriBVH } from '../src/physics/bvh';
import { fillCeilings, measureMaxOpen, DOOR_SPEC } from '../src/engine/world';
import { ROUNDS } from '../src/game/rounds';
import { stepLeaf, settleLeaves, touchingPairs, leafGap, LATCHED, LEAF_GAP, type Leaf } from '../src/game/doors';

const assets = join(process.cwd(), 'public', 'assets');

/** The doors as loaded: hinge = node D_<id> of chalet.glb (its JSON chunk), leaf from DOOR_SPEC, opening measured. */
const DOORS: Leaf[] = (() => {
  const b = readFileSync(join(assets, 'chalet.glb'));
  const gltf = JSON.parse(b.subarray(20, 20 + b.readUInt32LE(12)).toString('utf8')) as { nodes: { name: string; translation?: number[]; rotation?: number[] }[] };
  const buf = readFileSync(join(assets, 'chalet_coll.bin'));
  const coll = fillCeilings(readCollision(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer)).data;
  const bvh = new TriBVH(coll.pos, coll.idx, coll.cls, coll.kind);
  const out: Leaf[] = [];
  for (const n of gltf.nodes) {
    const id = n.name.slice(2), sp = DOOR_SPEC[id];
    if (!n.name.startsWith('D_') || !sp) continue;
    assert.ok(!n.rotation || Math.abs(n.rotation[3]) > 0.99999, `${n.name}: turned hinge node`);
    const t = n.translation ?? [0, 0, 0];
    const d: Leaf = { id, hinge: { x: t[0], z: t[2] }, width: sp.width, closedYaw: 0, leafDir: { x: sp.dir[0], z: sp.dir[1] }, openSign: sp.sign,
      angle: 0, target: 0, maxOpen: 0, moving: false };
    d.maxOpen = measureMaxOpen(bvh, d);
    out.push(d);
  }
  return out;
})();

const byId = (doors: Leaf[], id: string) => doors.find((d) => d.id === id)!;
function startState(angles: Record<string, number> = {}): Leaf[] {
  return DOORS.map((d) => ({ ...d, angle: angles[d.id] ?? 0, target: angles[d.id] ?? 0 }));
}
/** Core.toggleDoor */
const toggle = (d: Leaf) => { d.target = d.target > LATCHED ? 0 : d.maxOpen; d.moving = true; };
/** Core.updateDoors at 60 fps, player out of the way; returns the frames with leaves against or through each other */
function run(doors: Leaf[], seconds: number): number {
  let bad = 0;
  for (let f = 0; f < seconds * 60; f++) {
    for (const d of doors) stepLeaf(doors, d, 1 / 60, () => true, new Set());
    if (touchingPairs(doors).length) bad++;
  }
  return bad;
}

test('doors: hinges and openings as loaded (kids room 2 stops at the corner sofa)', () => {
  assert.equal(DOORS.length, 8);
  assert.ok(Math.abs(byId(DOORS, 'kind1').hinge.x - 2.4305) < 1e-3 && Math.abs(byId(DOORS, 'wc').hinge.z + 1.2305) < 1e-3);
  assert.ok(byId(DOORS, 'kind2').maxOpen < 1.0 && byId(DOORS, 'kind1').maxOpen > 1.5, `${byId(DOORS, 'kind2').maxOpen} ${byId(DOORS, 'kind1').maxOpen}`);
});

test('every round starts with each door within its opening and no two leaves against each other', () => {
  // (the terrace door's measured stop is its own frame beside the hinge - the plan model has no hinge offset -, not
  // furniture: round 4 starts it at 83 deg)
  for (const [name, angles] of ROUNDS.map((r) => [r.id, r.doors ?? {}] as const)) {
    for (const [id, a] of Object.entries(angles)) {
      const d = DOORS.find((q) => q.id === id);
      assert.ok(d, `${name}: unknown door ${id}`);
      assert.ok(a >= 0 && (id === 'terras' || a <= d.maxOpen + 1e-9), `${name}: ${id} at ${a} beyond its opening ${d.maxOpen.toFixed(3)}`);
    }
    const t = touchingPairs(startState(angles));
    assert.deepEqual(t.map(([a, b]) => `${a.id}/${b.id} ${leafGap(a, b).toFixed(3)}`), [], `${name}: leaves against each other`);
  }
});

for (const r of ['r9', 'r10']) {
  test(`${r}: the wc and kids-room-1 doors open and close; the open leaf in the way is pushed aside`, () => {
    const doors = startState(ROUNDS.find((q) => q.id === r)!.doors);
    const wc = byId(doors, 'wc'), k1 = byId(doors, 'kind1');
    let bad = 0;
    toggle(wc); bad += run(doors, 3);                                         // ajar -> shut
    assert.equal(wc.angle, 0, 'wc shuts');
    toggle(wc); bad += run(doors, 4);                                         // open: pushes kids room 1 toward shut
    assert.ok(wc.angle > 1.1, `wc opens: ${wc.angle.toFixed(3)}`);
    assert.ok(k1.angle < 1.0, `kids room 1 pushed aside: ${k1.angle.toFixed(3)}`);
    toggle(k1); bad += run(doors, 4);                                         // (pushed open, so the handle shuts it)
    assert.equal(k1.angle, 0, 'kids room 1 shuts');
    toggle(k1); bad += run(doors, 4);                                         // wide open: pushes the wc door back
    assert.ok(k1.angle > 1.5, `kids room 1 opens: ${k1.angle.toFixed(3)}`);
    assert.ok(wc.angle < 0.1, `wc pushed aside: ${wc.angle.toFixed(3)}`);
    toggle(k1); bad += run(doors, 4);
    assert.equal(k1.angle, 0, 'kids room 1 shuts');
    toggle(wc); toggle(k1); bad += run(doors, 5);                             // both at once
    assert.ok(wc.angle > 0.05 && k1.angle > 0.05, `both open: ${wc.angle.toFixed(3)} ${k1.angle.toFixed(3)}`);
    assert.equal(bad, 0, 'leaves never against or through each other');
  });
}

test('leaves started through each other (the old round 9) lock neither door; settling clears them', () => {
  const doors = startState({ kind1: 1.4, wc: 1.4 });
  const wc = byId(doors, 'wc'), k1 = byId(doors, 'kind1');
  assert.equal(leafGap(wc, k1), 0, 'test setup: through each other');
  toggle(wc); run(doors, 4);
  assert.equal(wc.angle, 0, 'wc shuts');
  toggle(k1); run(doors, 4);
  assert.equal(k1.angle, 0, 'kids room 1 shuts');
  const again = startState({ kind1: 1.4, wc: 1.4 });
  settleLeaves(again);
  assert.deepEqual(touchingPairs(again), []);
});

test('a shut, latched leaf is not pushed: the wc door opens until just clear of the shut door of kids room 1', () => {
  const doors = startState({});
  const wc = byId(doors, 'wc'), k1 = byId(doors, 'kind1');
  toggle(wc); const bad = run(doors, 4);
  assert.equal(k1.angle, 0);
  assert.ok(wc.angle > 1.1 && wc.angle < wc.maxOpen, `wc ${wc.angle.toFixed(3)}`);
  assert.ok(leafGap(wc, k1) >= LEAF_GAP && bad === 0);
});

test('two doors in one wall, latch side to latch side, do not hold each other ajar (kids rooms 1 and 2)', () => {
  for (const [id, other] of [['kind1', 'kind2'], ['kind2', 'kind1']]) {
    const doors = startState({ [id]: 0.9 });
    const d = byId(doors, id);
    toggle(d); run(doors, 4);
    assert.equal(d.angle, 0, `${id} shuts beside the shut ${other}`);
    toggle(d); run(doors, 4);
    assert.ok(d.angle > 0.9, `${id} opens again`);
  }
});
