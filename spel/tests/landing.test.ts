// Landing and resting (user feedback 06-10-2026): a mosquito that stops flying must not suddenly sit somewhere else
// than where it was flying, and it may rest a few seconds longer on a spot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { room } from './helpers';
import { MosquitoBrain, LANDING, TAKEOFF } from '../src/mosquito/brain';
import { ROUNDS } from '../src/game/rounds';

const noDoor = (_ox: number, _oy: number, _oz: number, _dx: number, _dy: number, _dz: number, max: number) => max;
const idle = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, active: false };
const host = { x: 1, y: 1.6, z: 1 };

test('landing: the mosquito flies all the way to its spot and settles there - it never jumps', () => {
  // the 2.5 s landing timer used to put it on its spot (up to 1.6 m away) when the approach took longer
  const bvh = room();
  let landings = 0;
  for (let k = 0; k < 8; k++) {
    // (no host drive: it never sits on the player, whose pull moves it fast)
    const b = new MosquitoBrain(bvh, { alert: 1, hostDrive: 0, restMin: 0.5, restMax: 1, speed: 0.5 }, k, noDoor);
    b.x = 2; b.y = 1.4; b.z = 2; b.setState('fly', 1);
    let px = b.x, py = b.y, pz = b.z, worst = 0;
    for (let i = 0; i < 60 * 60; i++) {
      b.update(1 / 60, host, idle, [0, 0, 4, 4], 0);
      worst = Math.max(worst, Math.hypot(b.x - px, b.y - py, b.z - pz));
      px = b.x; py = b.y; pz = b.z;
      for (const e of b.events.splice(0)) if (e === 'landed') {
        landings++;
        const d = Math.min(b.x, 4 - b.x, b.z, 4 - b.z, b.y, 2.4 - b.y);
        assert.ok(d < 0.01, `rests ${d.toFixed(3)} m from the nearest surface`);
      }
    }
    // fastest it flies without a swatter about: 1.5x its cruising speed
    assert.ok(worst <= 0.5 * 1.5 / 60 + 0.002, `mosquito ${k}: moved ${(worst * 100).toFixed(1)} cm in one frame`);
  }
  assert.ok(landings >= 16, `lands again and again (${landings} landings)`);
});

test('a landing that cannot get to its spot (a door leaf swung in between) is given up without a jump', () => {
  let blocked = false;
  // a door leaf across the room at z = 3.3 once blocked (vertical plane, the whole height)
  const door = (_ox: number, _oy: number, oz: number, _dx: number, _dy: number, dz: number, max: number) => {
    if (!blocked || Math.abs(dz) < 1e-6) return max;
    const t = (3.3 - oz) / dz;
    return t >= 0 && t < max ? t : max;
  };
  const b = new MosquitoBrain(room(), { alert: 1, hostDrive: 0, restMin: 5, restMax: 5, speed: 0.5 }, 1, door);
  // a landing on the south wall, 1.1 m away (it prefers surfaces away from the host: one far to the north)
  let tries = 0;
  do { b.x = 2; b.y = 1.4; b.z = 2.9; b.setState('fly', 1); b.beginLanding({ x: 2, y: 1.4, z: -99 }); } while ((b.state !== 'land' || b.tz < 3.5) && ++tries < 500);
  assert.ok(b.state === 'land' && b.tz > 3.5, 'test setup: a landing on the south wall');
  const spot = { x: b.tx, y: b.ty, z: b.tz };
  blocked = true;
  let px = b.x, py = b.y, pz = b.z, worst = 0, gaveUp = false;
  for (let i = 0; i < 60 * 30 && !gaveUp; i++) {
    b.update(1 / 60, host, idle, [0, 0, 4, 4], 0);
    worst = Math.max(worst, Math.hypot(b.x - px, b.y - py, b.z - pz));
    px = b.x; py = b.y; pz = b.z;
    assert.ok(b.z < 3.3, 'never past the leaf');
    if (b.state === 'fly') gaveUp = true;
  }
  assert.ok(gaveUp, 'gives the landing up and flies on');
  assert.ok(Math.hypot(b.x - spot.x, b.y - spot.y, b.z - spot.z) > 0.5, 'not on the spot behind the leaf');
  assert.ok(worst <= 0.5 * 1.5 / 60 + 0.002, `moved ${(worst * 100).toFixed(1)} cm in one frame`);
});

test('touching down the body turns into its resting pose, and out of it again when it takes off', () => {
  const b = new MosquitoBrain(room(), { alert: 1, hostDrive: 0, restMin: 0.5, restMax: 0.5, speed: 0.5 }, 3, noDoor);
  b.x = 2; b.y = 1.4; b.z = 2; b.setState('fly', 0.5);
  let prev = 0, rising = true, touchdown = 0, landed = false, took = -1, out = -1;
  for (let i = 0; i < 60 * 40 && out < 0; i++) {
    b.update(1 / 60, host, idle, [0, 0, 4, 4], 0);
    if (b.state === 'land' && b.settle > 0) { touchdown += 1 / 60; if (b.settle < prev - 1e-9) rising = false; }
    for (const e of b.events.splice(0)) if (e === 'landed') { landed = true; assert.equal(b.settle, 1, 'resting pose when it rests'); }
    if (landed && took < 0 && b.state === 'takeoff') took = i;
    if (took >= 0 && b.settle === 0) out = (i - took + 1) / 60;
    prev = b.settle;
  }
  assert.ok(landed, 'it landed');
  assert.ok(rising, 'turns steadily into the resting pose');
  assert.ok(touchdown > 0.6 * LANDING.touchdown && touchdown < LANDING.touchdown + 0.05, `touchdown over ${touchdown.toFixed(2)} s`);
  assert.ok(out > 0 && out <= TAKEOFF + 0.04, `out of the resting pose ${out.toFixed(2)} s after taking off`);
});

test('mosquitoes rest a few seconds longer on a spot: at least 6 s in every round', () => {
  for (const r of ROUNDS) assert.ok(r.rest[0] >= 6 && r.rest[1] >= r.rest[0] + 4, `${r.id}: ${r.rest}`);
});
