// Curtains that give way (user feedback 06-10-2026: they should look more natural and move when slapped).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CurtainPanel, CurtainMesh, CLOTH, splitPanels } from '../src/engine/cloth';
import { makePanel } from '../src/engine/curtains';
import { readCollision, TriBVH } from '../src/physics/bvh';
import { fillCeilings, roomAt } from '../src/engine/world';

/** the living room's floor-length panel beside the terrace door (chalet.glb S_A_curtain): the wall behind at z -0.08 */
const LIVING = { u0: 3.94, u1: 4.17, top: 2.17, bottom: 0.012, back: 0.079, depth: 0.137 };
const SOUTH = { x: 0, y: 0, z: -1 };            // into the living room
const s = { n: 0, t: 0, lift: 0, gu: 0, gy: 0 };

test('curtain: a slap dents the panel toward the wall, the hem swings, the rod holds it, and it hangs still again', () => {
  const p = new CurtainPanel(SOUTH, LIVING, 0);
  // a swatter at 4 m/s straight at the wall (+z), 1.4 m up in the middle of the panel
  p.impulse({ x: 4.05, y: 1.4, z: -0.2 }, { x: 0, y: 0, z: 4 });
  let dent = 0, hem = 0, rod = 0, deepest = 0, still = -1;
  for (let f = 0; f < 60 * 10 && still < 0; f++) {
    p.update(1 / 60);
    dent = Math.min(dent, p.sample(4.05, 1.4, s).n);
    hem = Math.max(hem, Math.abs(p.sample(4.05, 0.1, s).n));
    rod = Math.max(rod, Math.abs(p.sample(4.05, LIVING.top, s).n), Math.abs(s.t));
    for (const v of p.dn) deepest = Math.min(deepest, v);
    if (!p.moving) still = f / 60;
  }
  assert.ok(dent < -0.04, `pressed in ${(dent * 100).toFixed(1)} cm where it was slapped`);
  assert.ok(deepest >= -CLOTH.press * LIVING.depth - 1e-6, `never further than the folds can be pressed (${(deepest * 100).toFixed(1)} cm)`);
  assert.ok(hem > 0.02, `the hem swings (${(hem * 100).toFixed(1)} cm)`);
  assert.equal(rod, 0, 'the top hangs on the rod');
  assert.ok(still > 1 && still < 8, `still again after ${still.toFixed(1)} s`);
  for (const v of p.dn) assert.equal(v, 0, 'back in its hanging shape');
});

test('curtain: pressed toward the wall the folds flatten; no vertex goes behind the wall, the two faces never cross', () => {
  const p = new CurtainPanel(SOUTH, LIVING, 0);
  // a pleat at 1.4 m: the back of a fold (against the wall), its side, and its front (inner and outer face, 3 mm apart)
  const z = [-0.082, -0.15, -0.212, -0.215], n = z.length;
  const rest = new Float32Array(n * 3), nrm = new Float32Array(n * 3);
  z.forEach((zz, i) => { rest.set([4.05, 1.4, zz], 3 * i); nrm.set([0, 0, -1], 3 * i); });
  const mesh = new CurtainMesh([p], new Int32Array(n), rest, nrm);
  const pos = new Float32Array(n * 3), out = new Float32Array(n * 3), col = new Float32Array(n * 4);
  p.impulse({ x: 4.05, y: 1.4, z: -0.2 }, { x: 0, y: 0, z: 6 });
  let behind = -Infinity, moved = [0, 0, 0, 0], faces = Infinity, darkest = 1;
  for (let f = 0; f < 30; f++) {
    p.update(1 / 60);
    assert.ok(mesh.write(pos, out, col));
    for (let i = 0; i < n; i++) {
      behind = Math.max(behind, pos[3 * i + 2] - (-0.079));             // >= 0: on or behind the wall plane (z -0.079)
      moved[i] = Math.max(moved[i], pos[3 * i + 2] - z[i]);
      darkest = Math.min(darkest, col[4 * i]);
    }
    faces = Math.min(faces, pos[3 * 2 + 2] - pos[3 * 3 + 2]);            // inner face stays behind the outer one
  }
  assert.ok(behind < 0, `${(behind * 1000).toFixed(1)} mm behind the wall`);
  assert.ok(moved[3] > moved[1] && moved[1] > moved[0], `the front of the fold moves back most: ${moved.map((m) => (m * 100).toFixed(1)).join(' / ')} cm`);
  assert.ok(moved[3] > 0.06, `pressed in ${(moved[3] * 100).toFixed(1)} cm`);
  assert.ok(faces > 0.0008, `the fabric's faces stay apart (${(faces * 1000).toFixed(1)} mm)`);
  assert.ok(darkest < 0.97, `pressed flat the fabric is shaded darker (${darkest.toFixed(2)})`);
  // at rest: the hanging shape again, written once
  for (let f = 0; f < 60 * 10 && p.moving; f++) p.update(1 / 60);
  assert.ok(mesh.write(pos, out, col), 'the rest shape is written once');
  for (let i = 0; i < n * 3; i++) assert.equal(pos[i], rest[i]);
  assert.equal(mesh.write(pos, out, col), false, 'then nothing until it moves again');
});

test('curtain: a body brushing past moves the fabric along with it', () => {
  const p = new CurtainPanel(SOUTH, LIVING, 0);
  for (let f = 0; f < 30; f++) { p.brush({ x: 3.9 + f * 0.01, y: 0, z: -0.45 }, { x: 0.6, y: 0, z: 0 }, 0.25, 0.25, 1.55, 1 / 60); p.update(1 / 60); }
  assert.ok(p.sample(4.05, 1.0, s).t > 0.003, `pushed along the wall (${(s.t * 1000).toFixed(1)} mm)`);
});

test('curtain mesh: split into its panels (vertices on a seam count as one)', () => {
  // two quads 1 m apart; the second one's triangles share no index but two positions
  const pos = [0, 0, 0, 0.2, 0, 0, 0.2, 1, 0, 0, 1, 0, 1, 0, 0, 1.2, 0, 0, 1.2, 1, 0, /* again */ 1, 0, 0, 1.2, 1, 0, 1, 1, 0];
  const idx = [0, 1, 2, 0, 2, 3, 4, 5, 6, 7, 8, 9];
  const { comp, count } = splitPanels(pos, idx);
  assert.equal(count, 2);
  assert.deepEqual([...comp], [0, 0, 0, 0, 1, 1, 1, 1, 1, 1]);
});

test('chalet: each curtain panel finds the wall it hangs against and faces its room', () => {
  const buf = readFileSync(join(process.cwd(), 'public', 'assets', 'chalet_coll.bin'));
  const data = fillCeilings(readCollision(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer)).data;
  const bvh = new TriBVH(data.pos, data.idx, data.cls, data.kind);
  // the five panels of chalet.glb (S_A/B/C_curtain), their bounds in the Babylon frame
  const panels: [string, [number, number, number], [number, number, number], [number, number, number]][] = [
    ['woon', [5.426, 0.012, -0.215], [5.782, 2.170, -0.081], [0, 0, -1]],
    ['woon', [3.939, 0.012, -0.216], [4.172, 2.170, -0.079], [0, 0, -1]],
    ['kind1', [0.597, 0.750, -0.219], [0.980, 2.040, -0.084], [0, 0, -1]],
    ['kind2', [0.084, 0.740, -2.167], [0.218, 2.040, -1.951], [1, 0, 0]],
    ['ouder', [8.282, 0.650, -3.202], [8.410, 2.040, -2.895], [-1, 0, 0]],
  ];
  for (const [room, mn, mx, N] of panels) {
    const pos: number[] = [];
    for (const x of [mn[0], mx[0]]) for (const y of [mn[1], mx[1]]) for (const z of [mn[2], mx[2]]) pos.push(x, y, z);
    const p = makePanel(pos, new Int32Array(8), 0, bvh);
    assert.deepEqual([p.N.x, p.N.y, p.N.z].map((v) => v + 0), N, `${room}: faces the room`);
    const c = { x: (mn[0] + mx[0]) / 2, z: (mn[2] + mx[2]) / 2 };
    assert.equal(roomAt(c.x + p.N.x * 0.5, c.z + p.N.z * 0.5), room);
    assert.ok(Math.abs(p.depth - 0.13) < 0.015, `${room}: folds ${(p.depth * 100).toFixed(1)} cm deep`);
    assert.equal(p.onFloor, mn[1] < 0.05, `${room}: hem on the floor`);
  }
});
