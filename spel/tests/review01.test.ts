// Regression tests for the REVIEW-01 fixes (G-02, G-03, G-09, G-10, G-14).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { room } from './helpers';
import { MosquitoBrain, ESCAPE_PER_SWING } from '../src/mosquito/brain';
import { PlayerBody } from '../src/physics/player';
import { ImageProcessingConfiguration } from '@babylonjs/core/Materials/imageProcessingConfiguration';
import { setImageProcessingQuiet } from '../src/engine/imageprocessing';
import { mosquitoRoom } from '../src/game/session';
import { clearArmPole, solveArm, ARM_CLEAR } from '../src/swatter/armgeom';

const noDoor = (_ox: number, _oy: number, _oz: number, _dx: number, _dy: number, _dz: number, max: number) => max;

test('G-02: a resting mosquito decides once per swing whether it escapes (not every frame)', () => {
  const trials = 600, alert = 1.0;
  let escaped = 0;
  for (let k = 0; k < trials; k++) {
    const b = new MosquitoBrain(room(), { alert, hostDrive: 0, restMin: 99, restMax: 99, speed: 0.5 }, k, noDoor);
    b.placeResting(0.0, 1.5, 2, 1, 0, 0, 0, 0);                  // on the west wall, facing +x
    // the swatter head lingers 0.3 m in front of it for 0.2 s (slow end of the approach), then strikes
    for (let i = 0; i < 30 && b.state === 'rest'; i++) {
      const strike = i >= 12;
      const x = strike ? 0.3 - (i - 12) * 0.018 : 0.3, vx = strike ? -1.1 : -0.35;
      b.update(1 / 60, { x: 1.5, y: 1.6, z: 2 }, { x, y: 1.5, z: 2, vx, vy: 0, vz: 0, active: true, swing: 1 }, [0, 0, 4, 4], 0);
    }
    if (b.state === 'evade') escaped++;
  }
  const rate = escaped / trials, want = ESCAPE_PER_SWING * alert;
  assert.ok(Math.abs(rate - want) < 0.07, `escape rate ${rate.toFixed(2)} ~ ${want}`);
});

test('G-03: exposure and white balance per frame without notifying materials', () => {
  const ip = new ImageProcessingConfiguration();
  setImageProcessingQuiet(ip, 1.8, 5000, 3);                      // first call: defines on (notifies)
  let n = 0;
  ip.onUpdateParameters.add(() => { n++; });
  for (let i = 0; i < 100; i++) setImageProcessingQuiet(ip, 1.8 + i * 0.01, 5000 + i, 3 + i * 0.1);
  assert.equal(n, 0, 'no notifications');
  assert.ok(Math.abs(ip.exposure - 2.79) < 1e-9 && ip.temperature === 5099 && Math.abs(ip.tint - 12.9) < 1e-9, 'values are what the shaders bind');
  setImageProcessingQuiet(ip, 1.0);                               // exposure 1 switches the EXPOSURE define off: notify
  assert.equal(n, 1);
});

test('G-09: a mosquito on the inside of a window pane counts for the room, not for outside', () => {
  // window glass of the living room's south wall lies at z ~ -0.03, outside the room box (z1 = -0.08)
  const onPane = { state: 'rest', x: 4.2, z: -0.03, nx: 0, nz: -1 };
  assert.equal(mosquitoRoom(onPane), 'woon');
  assert.equal(mosquitoRoom({ state: 'fly', x: 4.2, z: 0.6, nx: 0, nz: 0 }), 'buiten');
});

test('G-10: with a wall at the right the elbow swings inward, arm clear of the wall', () => {
  // wall plane x = 0.30 (right of a shoulder at x 0.19); depth = how far a capsule reaches beyond it
  const wall = 0.30;
  const depth = (a: { x: number }, b: { x: number }, r: number) => Math.max(0, Math.max(a.x, b.x) + r - wall);
  const socket = { x: 0.19, y: 1.41, z: 0 }, wrist = { x: 0.15, y: 1.25, z: -0.42 }, fdir = { x: 0.2, y: -0.2, z: 0.96 };
  const pole = { x: 0.6, y: -1, z: 0 };                           // preferred: down and out to the right
  const j0 = solveArm(wrist, fdir, socket, pole);
  assert.ok(depth(j0.shoulder, j0.elbow, ARM_CLEAR.upper) > 0.01, 'test setup: the preferred elbow is in the wall');
  const p = clearArmPole(wrist, fdir, socket, pole, depth);
  const j = solveArm(wrist, fdir, socket, p);
  assert.ok(depth(j.shoulder, j.elbow, ARM_CLEAR.upper) + depth(j.elbow, j.cuff, ARM_CLEAR.fore) <= ARM_CLEAR.tolerance + 1e-9, `elbow ${j.elbow.x.toFixed(3)}`);
});

test('G-14: walking on into a bed climbs it, into a sofa seat or a chair does not', () => {
  const cases: [number, number, boolean][] = [[0.55, 3, true], [0.40, 3, false], [0.45, 0, false], [0.55, 0, false]];
  for (const [top, kind, climbs] of cases) {
    const p = new PlayerBody(room([{ min: [2.5, 0, 0], max: [4, top, 4], kind }]), () => []);
    p.x = 1.8; p.z = 2;
    for (let i = 0; i < 150; i++) { p.updateClimb(1 / 60, 1.2, 0, false); p.step(1 / 60, 1.2, 0); }
    assert.equal(p.y > 0.3, climbs, `top ${top} kind ${kind}: y=${p.y.toFixed(2)}`);
  }
});
