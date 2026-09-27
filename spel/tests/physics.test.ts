import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boxesToBVH, room } from './helpers';
import { PlayerBody, PLAYER } from '../src/physics/player';

const hit = { t: 0, tri: 0, nx: 0, ny: 0, nz: 0 };

test('BVH raycast: distance, facing normal, kind mask', () => {
  const bvh = boxesToBVH([{ min: [2, 0, -1], max: [2.1, 2, 1], kind: 0 }, { min: [3, 0, -1], max: [3.1, 2, 1], kind: 2 }]);
  assert.ok(bvh.raycast(0, 1, 0, 1, 0, 0, 10, hit, 15));
  assert.ok(Math.abs(hit.t - 2) < 1e-5);
  assert.ok(hit.nx < -0.99, 'normal faces the ray');
  // mask without solid (bit 1) passes the first wall and hits the glass one (kind 2 -> bit 4)
  assert.ok(bvh.raycast(0, 1, 0, 1, 0, 0, 10, hit, 4));
  assert.ok(Math.abs(hit.t - 3) < 1e-5);
  assert.equal(bvh.raycast(0, 1, 0, -1, 0, 0, 10, hit, 15), false);
  assert.equal(bvh.raycast(0, 1, 0, 1, 0, 0, 1.9, hit, 15), false, 'tmax respected');
});

test('BVH closest point and sphere query', () => {
  const bvh = boxesToBVH([{ min: [0, 0, 0], max: [1, 1, 1] }]);
  const out = new Float32Array(3);
  let found = 0, best = Infinity;
  bvh.querySphere(1.2, 0.5, 0.5, 0.3, (t) => {
    found++;
    bvh.closestOnTri(t, 1.2, 0.5, 0.5, out);
    best = Math.min(best, Math.hypot(out[0] - 1.2, out[1] - 0.5, out[2] - 0.5));
  });
  assert.ok(found > 0);
  assert.ok(Math.abs(best - 0.2) < 1e-5);
});

test('player: walls stop the capsule at its radius, no tunnelling at speed', () => {
  const p = new PlayerBody(room(), () => []);
  p.x = 2; p.z = 2; p.y = 0;
  for (let i = 0; i < 400; i++) p.step(1 / 60, 30, 0);          // absurd speed straight into the east wall
  assert.ok(p.x <= 4 - PLAYER.radius + 0.02, `x=${p.x}`);
  assert.ok(p.x > 3.5);
  assert.ok(Math.abs(p.y) < 1e-4, 'stays on the floor');
});

test('player: climbs a veranda tread, not a chair seat', () => {
  const tread = room([{ min: [2.5, 0, 0], max: [4, 0.18, 4], kind: 1 }]);
  const p = new PlayerBody(tread, () => []);
  p.x = 1.5; p.z = 2;
  for (let i = 0; i < 180; i++) p.step(1 / 60, 1.2, 0);
  assert.ok(p.x > 2.6 && Math.abs(p.y - 0.18) < 0.01, `on tread: x=${p.x} y=${p.y}`);
  const seat = room([{ min: [2.5, 0, 0], max: [4, 0.45, 4] }]);
  const q = new PlayerBody(seat, () => []);
  q.x = 1.5; q.z = 2;
  for (let i = 0; i < 180; i++) q.step(1 / 60, 1.2, 0);
  assert.ok(q.x < 2.5 - 0.11 + 0.05 && q.y < 0.01, `blocked by the shins: x=${q.x} y=${q.y}`);
});

test('player: walking on into a bed steps onto it (also a folded duvet at 0.65 m); a table stays out of bounds (D51)', () => {
  for (const top of [0.55, 0.65]) {
    const bed = room([{ min: [2.5, 0, 0], max: [4, top, 4], kind: 3 }]);
    const p = new PlayerBody(bed, () => []);
    p.x = 1.8; p.z = 2;
    for (let i = 0; i < 150; i++) { p.updateClimb(1 / 60, 1.2, 0, false); p.step(1 / 60, 1.2, 0); }
    assert.ok(p.x > 2.6 && Math.abs(p.y - top) < 0.01, `on the bed (${top}): x=${p.x} y=${p.y}`);
  }
  const table = room([{ min: [2.5, 0, 0], max: [4, 0.75, 4] }]);
  const q = new PlayerBody(table, () => []);
  q.x = 1.8; q.z = 2;
  for (let i = 0; i < 150; i++) { q.updateClimb(1 / 60, 1.2, 0, true); q.step(1 / 60, 1.2, 0); }
  assert.ok(q.x < 2.5 - 0.11 + 0.05 && q.y < 0.01, `not onto the table: x=${q.x} y=${q.y}`);
  // brushing along a bed (walking parallel to it) does not climb it
  const side = room([{ min: [2.5, 0, 0], max: [4, 0.55, 4] }]);
  const r = new PlayerBody(side, () => []);
  r.x = 2.25; r.z = 0.3;
  for (let i = 0; i < 150; i++) { r.updateClimb(1 / 60, 0.05, 1.2, false); r.step(1 / 60, 0.05, 1.2); }
  assert.ok(r.y < 0.01 && r.z > 2.5, `walked along the bed on the floor: y=${r.y} z=${r.z}`);
});

test('player: squeezes past low furniture with the legs, shoulders stop at a cupboard', () => {
  // 0.30 m gap between a 0.45 m pouf and a 0.4 m sofa seat: legs pass (radius 0.11-0.14 below the hips)
  const low = room([{ min: [1.6, 0, 0], max: [2.0, 0.45, 4] }, { min: [2.3, 0, 0], max: [2.7, 0.4, 4] }]);
  const p = new PlayerBody(low, () => []);
  p.x = 2.15; p.z = 0.5;
  for (let i = 0; i < 180; i++) p.step(1 / 60, 0, 1.2);
  assert.ok(p.z > 2.5 && Math.abs(p.x - 2.15) < 0.05, `walked through the gap: ${p.x}, ${p.z}`);
  // a 0.30 m gap between two tall cupboards is too narrow for the shoulders
  const tall = room([{ min: [1.6, 0, 1.5], max: [2.0, 2.0, 4] }, { min: [2.3, 0, 1.5], max: [2.7, 2.0, 4] }]);
  const q = new PlayerBody(tall, () => []);
  q.x = 2.15; q.z = 0.5;
  for (let i = 0; i < 180; i++) q.step(1 / 60, 0, 1.2);
  assert.ok(q.z < 1.5 - 0.1, `stopped in front of the cupboards (shoulder radius 0.20 against the corners): ${q.z}`);
});

test('player: door leaf is an obstacle; spawn search avoids furniture', () => {
  const door = [{ ax: 3, az: 0, bx: 3, bz: 4, half: 0.022, y0: 0, y1: 2.2 }];
  const p = new PlayerBody(room(), () => door);
  p.x = 2; p.z = 2;
  for (let i = 0; i < 200; i++) p.step(1 / 60, 2, 0);
  assert.ok(p.x < 3 - PLAYER.radius - 0.02 + 0.03, `x=${p.x}`);
  const bvh = room([{ min: [1.6, 0, 1.6], max: [2.4, 0.75, 2.4] }]);   // a table
  const q = new PlayerBody(bvh, () => []);
  const s = q.findFreeSpot(2, 2)!;
  assert.ok(s, 'found a spot');
  assert.ok(Math.abs(s[1]) < 1e-4, 'on the real floor, not on the table');
  assert.ok(Math.max(Math.abs(s[0] - 2), Math.abs(s[2] - 2)) >= 0.4 + 0.14 - 0.03, `outside the table (thigh sphere): ${s}`);
});

test('collision file: MJC2 (16-bit indices) parses to the same BVH as MJC1', async () => {
  const { parseCollision } = await import('../src/physics/bvh');
  // two triangles forming a wall at x = 2 (Blender z-up), classes/kinds per triangle
  const verts = [2, -1, 0, 2, 1, 0, 2, 1, 2, 2, -1, 2], tris = [0, 1, 2, 0, 2, 3];
  const make = (magic: string, ib: 2 | 4) => {
    const buf = new ArrayBuffer(12 + verts.length * 4 + tris.length * ib + 2 * 2);
    const dv = new DataView(buf);
    for (let i = 0; i < 4; i++) dv.setUint8(i, magic.charCodeAt(i));
    dv.setUint32(4, verts.length / 3, true); dv.setUint32(8, tris.length / 3, true);
    let o = 12;
    for (const v of verts) { dv.setFloat32(o, v, true); o += 4; }
    for (const t of tris) { if (ib === 2) dv.setUint16(o, t, true); else dv.setUint32(o, t, true); o += ib; }
    dv.setUint8(o++, 3); dv.setUint8(o++, 4); dv.setUint8(o++, 0); dv.setUint8(o++, 2);
    return buf;
  };
  const a = parseCollision(make('MJC1', 4)), b = parseCollision(make('MJC2', 2));
  const h1 = { t: 0, tri: 0, nx: 0, ny: 0, nz: 0 }, h2 = { ...h1 };
  assert.ok(a.raycast(0, 1, -0.5, 1, 0, 0, 10, h1, 15) && b.raycast(0, 1, -0.5, 1, 0, 0, 10, h2, 15));
  assert.equal(h1.tri, h2.tri); assert.ok(Math.abs(h1.t - 2) < 1e-6 && Math.abs(h2.t - 2) < 1e-6);
  assert.deepEqual([...b.cls], [3, 4]); assert.deepEqual([...b.kind], [0, 2]);
  assert.throws(() => parseCollision(make('MJC9', 4)));
});
