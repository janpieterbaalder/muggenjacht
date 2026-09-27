import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boxesToBVH } from './helpers';
import { SwingSystem, restPose, type CamFrame, type MosquitoTarget, type ContactInfo } from '../src/swatter/swing';
import { ARM_PLAN_MAX, WRIST, armPole, bodyFrame, handOnHandle, shoulderAt, solveArm, wristAngles } from '../src/swatter/armgeom';

const cam: CamFrame = { eye: { x: 2, y: 1.6, z: 2 }, f: { x: 1, y: 0, z: 0 }, r: { x: 0, y: 0, z: 1 }, up: { x: 0, y: 1, z: 0 } };
const noDoors = (_o: unknown, _d: unknown, max: number) => max;

function run(sys: SwingSystem, mosq: MosquitoTarget[] = [], secs = 1): { c: ContactInfo | null; maxX: number } {
  let c: ContactInfo | null = null, maxX = -Infinity;
  for (let i = 0; i < secs * 60; i++) {
    const got = sys.update(1 / 60, restPose(cam, 1, i / 60, { x: 0, y: 0, z: 0 }), mosq);
    if (got && !c) c = got;
    maxX = Math.max(maxX, sys.pose.h.x);
  }
  return { c, maxX };
}

test('rest pose: head in front, to the right, handle down toward the hand', () => {
  const p = restPose(cam, 1, 0, { x: 0, y: 0, z: 0 });
  assert.ok(p.h.x > cam.eye.x + 0.2, 'in front');
  assert.ok(p.h.z > cam.eye.z, 'right-hand side');
  assert.ok(p.grip.y < p.h.y - 0.2, 'grip below the head');
  const l = restPose(cam, -1, 0, { x: 0, y: 0, z: 0 });
  assert.ok(l.h.z < cam.eye.z, 'left-handed option mirrors');
});

test('swing into a wall: contact on the wall, head never passes it', () => {
  const sys = new SwingSystem(boxesToBVH([{ min: [2.6, 0, 0], max: [2.7, 2.4, 4], cls: 0 }]), noDoors);
  assert.ok(sys.begin(cam, { x: 1, y: 0, z: 0 }, 1, 0, []));
  const { c, maxX } = run(sys);
  assert.ok(c && !c.air, 'surface contact');
  assert.ok(Math.abs(c!.point.x - 2.6) < 0.02, `contact x=${c!.point.x}`);
  assert.ok(maxX < 2.6 + 0.005, `head x max ${maxX}`);
  assert.ok(c!.speed > 1, `impact speed ${c!.speed}`);
});

test('thin panel (4 mm) is not tunnelled through', () => {
  const sys = new SwingSystem(boxesToBVH([{ min: [2.5, 0, 0], max: [2.504, 2.4, 4], cls: 3 }]), noDoors);
  sys.begin(cam, { x: 1, y: 0, z: 0 }, 1, 0, []);
  const { c, maxX } = run(sys);
  assert.ok(c && !c.air && c.cls === 3);
  assert.ok(maxX < 2.505, `head x max ${maxX}`);
});

test('air swing ends as an air contact at reach', () => {
  const sys = new SwingSystem(boxesToBVH([{ min: [9, 0, 0], max: [9.1, 2, 4] }]), noDoors);
  sys.begin(cam, { x: 1, y: 0, z: 0 }, 1, 0, []);
  const { c } = run(sys);
  assert.ok(c && c.air && c.mosquito === -1);
});

test('flying mosquito on the aim line is hit in the air; resting one on the wall is squashed', () => {
  const fly: MosquitoTarget[] = [{ idx: 0, pos: { x: 2.6, y: 1.5, z: 2.05 }, prev: { x: 2.6, y: 1.5, z: 2.05 }, alive: true, resting: false, nrm: { x: 0, y: 1, z: 0 } }];
  const a = new SwingSystem(boxesToBVH([{ min: [9, 0, 0], max: [9.1, 2, 4] }]), noDoors);
  const da = { x: 0.6, y: -0.1, z: 0.05 }, la = Math.hypot(da.x, da.y, da.z);
  a.begin(cam, { x: da.x / la, y: da.y / la, z: da.z / la }, 1, 0, fly);
  const ra = run(a, fly);
  assert.ok(ra.c && ra.c.mosquito === 0 && ra.c.air, 'air hit');
  const rest: MosquitoTarget[] = [{ idx: 0, pos: { x: 2.597, y: 1.6, z: 2.02 }, prev: { x: 2.597, y: 1.6, z: 2.02 }, alive: true, resting: true, nrm: { x: -1, y: 0, z: 0 } }];
  const b = new SwingSystem(boxesToBVH([{ min: [2.6, 0, 0], max: [2.7, 2.4, 4] }]), noDoors);
  b.begin(cam, { x: 1, y: 0, z: 0 }, 1, 0, rest);
  const rb = run(b, rest);
  assert.ok(rb.c && rb.c.mosquito === 0 && !rb.c.air, 'squashed against the wall');
});

test('door leaf blocks the swing like a wall', () => {
  const door = (o: { x: number }, d: { x: number }, max: number) => (d.x > 0.5 && o.x < 2.55 ? Math.min(max, (2.55 - o.x) / d.x) : max);
  const sys = new SwingSystem(boxesToBVH([{ min: [9, 0, 0], max: [9.1, 2, 4] }]), door as never);
  sys.begin(cam, { x: 1, y: 0, z: 0 }, 1, 0, []);
  const { c, maxX } = run(sys);
  assert.ok(c && c.door, 'door contact');
  assert.ok(maxX < 2.56, `head x max ${maxX}`);
});

test('the arm is never stretched: a wall 1.1 m ahead is out of reach standing upright, reachable when leaning in', () => {
  const wall = () => boxesToBVH([{ min: [3.1, 0, 0], max: [3.2, 2.4, 4], cls: 0 }]);
  const up = new SwingSystem(wall(), noDoors);
  up.begin(cam, { x: 1, y: 0, z: 0 }, 1, 0, [], 0);
  const r0 = run(up);
  assert.ok(r0.c && r0.c.air, 'upright: the swing ends in the air short of the wall');
  assert.ok(r0.maxX < 3.1, 'never reaches the wall');
  const near = new SwingSystem(boxesToBVH([{ min: [2.85, 0, 0], max: [2.95, 2.4, 4], cls: 0 }]), noDoors);
  near.begin(cam, { x: 1, y: -0.35, z: 0.1 }, 1, 0, [], 0.32);
  assert.ok(near.swing!.lean > 0.05, `leans in (${near.swing!.lean})`);
  const r1 = run(near);
  assert.ok(r1.c && !r1.c.air, 'leaning in: contact');
});

test('contact pose (right and left hand): wrist within arm length of the leaned shoulder and within the wrist range', () => {
  for (const hand of [1, -1]) for (const [d, wallX] of [[{ x: 1, y: 0, z: 0 }, 2.6], [{ x: 1, y: -0.5, z: 0.3 * hand }, 2.7], [{ x: 1, y: 0.4, z: -0.3 * hand }, 2.55]] as const) {
    const sys = new SwingSystem(boxesToBVH([{ min: [wallX, 0, 0], max: [wallX + 0.1, 2.4, 4], cls: 0 }]), noDoors);
    const l = Math.hypot(d.x, d.y, d.z);
    assert.ok(sys.begin(cam, { x: d.x / l, y: d.y / l, z: d.z / l }, hand, 0, [], 0.32));
    const s = sys.swing!, p = s.target;
    const { fwd, right } = bodyFrame(cam.f, cam.r);
    const eye = { x: cam.eye.x + fwd.x * s.lean, y: cam.eye.y - 0.35 * s.lean - s.crouch, z: cam.eye.z + fwd.z * s.lean };
    const S = shoulderAt(eye, fwd, right, hand);
    const { wrist, fdir, palm } = handOnHandle(p.grip, p.r, p.hu, p.hn, hand);
    assert.ok(Math.hypot(wrist.x - S.x, wrist.y - S.y, wrist.z - S.z) <= ARM_PLAN_MAX + 1e-6, 'within arm length');
    const j = solveArm(wrist, fdir, S, armPole(right, hand));
    const w = wristAngles(fdir, palm, wrist, j.elbow, j.shoulder, hand);
    assert.ok(Math.abs(w.ext) <= WRIST.ext && Math.abs(w.dev) <= WRIST.dev && Math.abs(w.roll) <= WRIST.roll, JSON.stringify(w));
  }
});

// D48 follow-up: the shown swatter must never be inside geometry (it partly vanished into furniture)
function depthIn(bvh: ReturnType<typeof boxesToBVH>, p: Parameters<SwingSystem['penetration']>[0]) {
  const { fwd, right } = bodyFrame(cam.f, cam.r);
  return new SwingSystem(bvh, noDoors).penetration(p, shoulderAt(cam.eye, fwd, right, 1)).depth;
}

test('rest pose next to a wall and above a table: swatter stays out of the geometry', () => {
  for (const box of [{ min: [2.3, 0, 0], max: [2.4, 2.4, 4] }, { min: [2.1, 0, 1.6], max: [3.2, 1.38, 3.0] }] as { min: [number, number, number]; max: [number, number, number] }[]) {
    const bvh = boxesToBVH([box]);
    const sys = new SwingSystem(bvh, noDoors);
    assert.ok(depthIn(bvh, restPose(cam, 1, 0, { x: 0, y: 0, z: 0 })) > 0.01, 'test setup: the plain rest pose is inside the geometry');
    for (let i = 0; i < 30; i++) sys.update(1 / 60, sys.restFor(cam, 1, i / 60), [], cam, 1);
    assert.ok(depthIn(bvh, sys.pose) <= 0.004, `depth ${depthIn(bvh, sys.pose)}`);
  }
});

test('whole swing near a table edge: never inside it, contact still on the wall', () => {
  const bvh = boxesToBVH([{ min: [2.9, 0, 0], max: [3.0, 2.4, 4] }, { min: [2.15, 0, 1.7], max: [2.8, 1.35, 2.9] }]);
  const d = { x: 0.95, y: -0.05, z: 0.3 }, l = Math.hypot(d.x, d.y, d.z), dir = { x: d.x / l, y: d.y / l, z: d.z / l };
  const sys = new SwingSystem(bvh, noDoors);
  for (let i = 0; i < 20; i++) sys.update(1 / 60, sys.restFor(cam, 1, i / 60), [], cam, 1);
  assert.ok(sys.begin(cam, dir, 1, 0, [], 0.2));
  let worst = 0, c: ContactInfo | null = null;
  for (let i = 0; i < 70; i++) {
    const got = sys.update(1 / 60, sys.restFor(cam, 1, i / 60), [], cam, 1);
    if (got && !c) c = got;
    worst = Math.max(worst, depthIn(bvh, sys.pose));
  }
  assert.ok(c && !c.air, 'surface contact');
  assert.ok(worst <= 0.004, `depth during the swing ${worst}`);
  // the same swing without the check does run into the table (the test covers the reported fault)
  const raw = new SwingSystem(bvh, noDoors);
  for (let i = 0; i < 20; i++) raw.update(1 / 60, restPose(cam, 1, i / 60, { x: 0, y: 0, z: 0 }), []);
  raw.begin(cam, dir, 1, 0, [], 0.2);
  let rawWorst = 0;
  for (let i = 0; i < 70; i++) { raw.update(1 / 60, restPose(cam, 1, i / 60, { x: 0, y: 0, z: 0 }), []); rawWorst = Math.max(rawWorst, depthIn(bvh, raw.pose)); }
  assert.ok(rawWorst > 0.01, `setup: unguarded swing depth ${rawWorst}`);
});
