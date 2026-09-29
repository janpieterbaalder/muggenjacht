// The veranda table (29-09-2026): rectangular, 1.6 x 0.9 m, six chairs around it, each with its seat toward the table and
// its backrest away from it (the four old chairs faced away, backrests in the table); from the veranda steps to the
// terrace door stays walkable. Checked on the collision the game loads (chalet_coll.bin).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readCollision, TriBVH } from '../src/physics/bvh';
import { fillCeilings } from '../src/engine/world';
import { PlayerBody } from '../src/physics/player';

const buf = readFileSync(join(process.cwd(), 'public', 'assets', 'chalet_coll.bin'));
const data = fillCeilings(readCollision(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer)).data;
const bvh = new TriBVH(data.pos, data.idx, data.cls, data.kind);
const hit = { t: 0, tri: 0, nx: 0, ny: 0, nz: 0 };
/** height of the highest surface under (x, z) below 1.2 m (deck -0.06, seat 0.395, table top 0.67, backrest up to 0.82) */
const topAt = (x: number, z: number) => (bvh.raycast(x, 1.2, z, 0, -1, 0, 2, hit, 15) ? 1.2 - hit.t : -Infinity);
const TABLE = { x0: 0.5, x1: 2.1, z0: 0.8, z1: 1.7, top: 0.67 };
const DECK = -0.06;

test('veranda: the table top is 1.6 x 0.9 m', () => {
  const along = (z: number) => { const xs: number[] = []; for (let x = 0.2; x <= 2.4; x += 0.01) if (Math.abs(topAt(x, z) - TABLE.top) < 0.01) xs.push(x); return xs; };
  const across = (x: number) => { const zs: number[] = []; for (let z = 0.3; z <= 2.3; z += 0.01) if (Math.abs(topAt(x, z) - TABLE.top) < 0.01) zs.push(z); return zs; };
  const a = along(0.9), b = across(1.3);                                     // between the chairs: only the top is that high
  assert.ok(Math.abs(a[0] - TABLE.x0) < 0.02 && Math.abs(a[a.length - 1] - TABLE.x1) < 0.02, `length ${a[0]}..${a[a.length - 1]}`);
  assert.ok(Math.abs(b[0] - TABLE.z0) < 0.02 && Math.abs(b[b.length - 1] - TABLE.z1) < 0.02, `width ${b[0]}..${b[b.length - 1]}`);
  assert.equal(a.length, Math.round((a[a.length - 1] - a[0]) / 0.01) + 1, 'one piece');
});

test('veranda: six chairs, each seat toward the table and its backrest away from it', () => {
  // seat centre and the way away from the table (the side of the table it stands at)
  const chairs: [number, number, number, number][] = [
    [0.9, 0.6, 0, -1], [1.7, 0.6, 0, -1],            // north side
    [0.9, 1.9, 0, 1], [1.7, 1.9, 0, 1],              // south side
    [0.3, 1.25, -1, 0], [2.3, 1.25, 1, 0],           // heads
  ];
  for (const [x, z, ux, uz] of chairs) {
    const seat = topAt(x, z);
    assert.ok(Math.abs(seat - 0.395) < 0.02, `seat at ${x},${z}: ${seat.toFixed(3)}`);
    const scan = (sign: number, d0: number, d1: number) => { let m = -Infinity; for (let d = d0; d <= d1; d += 0.005) m = Math.max(m, topAt(x + sign * ux * d, z + sign * uz * d)); return m; };
    const back = scan(1, 0.1, 0.35), front = scan(-1, 0.1, 0.3);
    assert.ok(back > 0.7, `backrest behind the seat at ${x},${z} (away from the table): ${back.toFixed(3)}`);
    assert.ok(front < TABLE.top + 0.01, `nothing high between the seat at ${x},${z} and the table: ${front.toFixed(3)}`);
  }
  // two chairs on each long side, apart (the old ones stood in the middle)
  assert.ok(topAt(1.3, 0.6) < 0.1 && topAt(1.3, 1.9) < 0.1, 'a gap between the two chairs of a long side');
});

test('veranda: from the steps to the terrace door is walkable past the table', () => {
  const p = new PlayerBody(bvh, () => []);
  const G = 0.05, x0 = -0.05, z0 = 0.05, NX = Math.round((6.1 - x0) / G) + 1, NZ = Math.round((2.45 - z0) / G) + 1;
  const free = new Uint8Array(NX * NZ);
  for (let i = 0; i < NX; i++) for (let k = 0; k < NZ; k++) {
    const x = x0 + i * G, z = z0 + k * G, f = p.floorAt(x, z, 0.5, 2);
    if (Math.abs(f - DECK) < 0.03 && p.isFree(x, f, z)) free[i * NZ + k] = 1;
  }
  const cell = (x: number, z: number) => Math.round((x - x0) / G) * NZ + Math.round((z - z0) / G);
  const start = cell(1.95, 2.35), goal = cell(5.1, 0.4);
  assert.ok(free[start] && free[goal], 'test setup: start at the top of the steps and the spot before the terrace door are free');
  const seen = new Uint8Array(NX * NZ), q = [start];
  seen[start] = 1;
  while (q.length) {
    const c = q.pop()!, i = Math.floor(c / NZ), k = c % NZ;
    for (const [di, dk] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ii = i + di, kk = k + dk, cc = ii * NZ + kk;
      if (ii < 0 || kk < 0 || ii >= NX || kk >= NZ || !free[cc] || seen[cc]) continue;
      seen[cc] = 1; q.push(cc);
    }
  }
  assert.ok(seen[goal], 'steps -> terrace door');
});
