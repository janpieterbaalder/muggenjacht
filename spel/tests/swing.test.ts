import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { boxesToBVH, prismToBVH } from './helpers';
import { SwingSystem, restPose, type CamFrame, type MosquitoTarget, type ContactInfo } from '../src/swatter/swing';
import { parseCollision } from '../src/physics/bvh';
import { ARM_PLAN_MAX, WRIST, armPole, bodyFrame, handOnHandle, lookTiptoe, shoulderAt, solveArm, wristAngles } from '../src/swatter/armgeom';

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

test('resting swatter against a cupboard top and in a corner holds still (no shaking)', () => {
  // standing 0.3 m from a 1.40 m cupboard looking a little down, and 0.25 m from a corner: the push-out used to be let
  // go and applied again every frame and alternated between surfaces - up to 127 mm per frame at the cupboard
  const floor = { min: [-0.1, -0.1, -0.1], max: [6.1, 0, 6.1], kind: 1, cls: 1 } as const;
  const cases: [string, { min: [number, number, number]; max: [number, number, number] }[], number][] = [
    ['cupboard', [{ ...floor, min: [...floor.min], max: [...floor.max] }, { min: [2.3, 0, 1], max: [3.0, 1.4, 3] }], -10],
    ['corner', [{ ...floor, min: [...floor.min], max: [...floor.max] }, { min: [2.25, 0, -1], max: [2.35, 2.4, 5] }, { min: [-1, 0, 2.25], max: [5, 2.4, 2.35] }], 0],
  ];
  for (const [name, boxes, pitchDeg] of cases) {
    const p = pitchDeg * Math.PI / 180;
    const c: CamFrame = { eye: cam.eye, f: { x: Math.cos(p), y: Math.sin(p), z: 0 }, r: cam.r, up: { x: -Math.sin(p), y: Math.cos(p), z: 0 } };
    const bvh = boxesToBVH(boxes);
    const sys = new SwingSystem(bvh, noDoors);
    let prev: { x: number; y: number; z: number } | null = null, maxStep = 0, worst = 0;
    for (let i = 0; i < 300; i++) {
      sys.update(1 / 60, sys.restFor(c, 1, i / 60), [], c, 1);
      const h = sys.pose.h;
      if (prev && i > 30) maxStep = Math.max(maxStep, Math.hypot(h.x - prev.x, h.y - prev.y, h.z - prev.z));
      if (i > 30) { const { fwd, right } = bodyFrame(c.f, c.r); worst = Math.max(worst, new SwingSystem(bvh, noDoors).penetration(sys.pose, shoulderAt(c.eye, fwd, right, 1)).depth); }
      prev = { ...h };
    }
    assert.ok(maxStep < 0.003, `${name}: head moves ${(maxStep * 1000).toFixed(1)} mm in one frame`);
    assert.ok(worst <= 0.004, `${name}: inside the geometry by ${(worst * 1000).toFixed(1)} mm`);
  }
});

/** Camera at (2, 1.62, 2) turned yawDeg from +x (positive toward -z) and pitched up pitchDeg, as Session.camFrame. */
function view(yawDeg: number, pitchDeg: number): CamFrame {
  const yaw = yawDeg * Math.PI / 180, p = pitchDeg * Math.PI / 180;
  const f = { x: Math.cos(yaw) * Math.cos(p), y: Math.sin(p), z: -Math.sin(yaw) * Math.cos(p) }, r = { x: Math.sin(yaw), y: 0, z: Math.cos(yaw) };
  return { eye: { x: 2, y: 1.62, z: 2 }, f, r, up: { x: r.y * f.z - r.z * f.y, y: r.z * f.x - r.x * f.z, z: r.x * f.y - r.y * f.x } };
}
const dist = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

test('turning past a wall cupboard with a bevelled edge, the resting swatter does not jump', () => {
  // the wire grazing the 2 mm bevel on the cupboard's bottom front edge read as 14-38 cm deep, and the swatter jumped
  // that far in one frame (chalet: every breath at one spot, 239 of 780 turns)
  const floor = { min: [-3.1, -0.1, -3.1], max: [9.1, 0, 9.1], kind: 1, cls: 1 } as const;
  for (const [yb, dx, pitch, hand] of [[1.3, 0.35, 20, 1], [1.4, 0.35, 30, 1], [1.3, 0.45, 20, -1], [1.4, 0.25, 20, 1]]) {
    const xf = 2 + dx, xb = xf + 0.33, yt = yb + 0.79;
    const bvh = prismToBVH([[xf + 0.002, yb], [xb, yb], [xb, yt], [xf, yt], [xf, yb + 0.002]], 0.8, 3.2, [{ ...floor, min: [...floor.min], max: [...floor.max] }]);
    const sys = new SwingSystem(bvh, noDoors);
    let prevShown = null as null | { x: number; y: number; z: number }, prevRest = prevShown, worst = 0;
    for (let i = 0; i < 300; i++) {
      const c = view(i < 60 ? -60 : -60 + (i - 60) * 0.5, pitch);   // still, then 30 deg/s across the cupboard's front
      const rest = sys.restFor(c, hand, i / 60);
      sys.update(1 / 60, rest, [], c, hand);
      if (prevShown && prevRest && i > 60) worst = Math.max(worst, dist(sys.pose.h, prevShown) - dist(rest.h, prevRest));
      prevShown = { ...sys.pose.h }; prevRest = { ...rest.h };
    }
    assert.ok(worst < 0.03, `bottom ${yb} m, ${dx} m ahead, pitch ${pitch}, hand ${hand}: the shown head moved ${(worst * 1000).toFixed(0)} mm more than the rest pose in one frame`);
  }
});

test('standing still before a wall cupboard in the chalet, the resting swatter stays put', () => {
  // its wire grazes the cupboard's 2 mm bevel with every breath: 18 cm jumps with the measure of before, and still a 2 cm
  // step each breath with that measure and a limit on the correction (a real spot of the collision mesh)
  const buf = readFileSync(join(process.cwd(), 'public', 'assets', 'chalet_coll.bin'));
  const bvh = parseCollision(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const yaw = 135 * Math.PI / 180, p = 20 * Math.PI / 180;
  const f = { x: Math.cos(yaw) * Math.cos(p), y: Math.sin(p), z: -Math.sin(yaw) * Math.cos(p) }, r = { x: Math.sin(yaw), y: 0, z: Math.cos(yaw) };
  const c: CamFrame = { eye: { x: 5.0112, y: 1.62, z: -2.9809 }, f, r, up: { x: r.y * f.z - r.z * f.y, y: r.z * f.x - r.x * f.z, z: r.x * f.y - r.y * f.x } };
  const sys = new SwingSystem(bvh, noDoors);
  let prev = null as null | { x: number; y: number; z: number }, worst = 0;
  for (let i = 0; i < 600; i++) {
    sys.update(1 / 60, sys.restFor(c, 1, i / 60), [], c, 1);
    if (prev && i > 60) worst = Math.max(worst, dist(sys.pose.h, prev));
    prev = { ...sys.pose.h };
  }
  assert.ok(worst < 0.003, `the head moved ${(worst * 1000).toFixed(1)} mm in one frame`);
});

test('a door leaf swinging into the resting swatter pushes it out at once', () => {
  // (a limit of 2 cm a frame on every new correction at rest let the leaf pass up to 45 cm into the swatter)
  const deg = Math.PI / 180;
  for (const [hx, a1, hand] of [[2.3, 150, 1], [2.42, 150, 1], [2.3, -150, -1]]) {
    const hz = hand > 0 ? 2.9 : 1.1;
    let ang = 0, stopped = false;
    const door = (o: { x: number; y: number; z: number }, d: { x: number; y: number; z: number }, max: number) => {
      const ex = Math.cos(ang) * 0.8, ez = -Math.sin(ang) * 0.8, den = d.x * ez - d.z * ex;
      if (Math.abs(den) < 1e-9) return max;
      const wx = hx - o.x, wz = hz - o.z, t = (wx * ez - wz * ex) / den, s = (wx * d.z - wz * d.x) / den;
      return t < 0 || t > max || s < 0 || s > 1 || o.y + d.y * t > 2.2 ? max : t;
    };
    const c = view(0, 0), sys = new SwingSystem(boxesToBVH([{ min: [-3.1, -0.1, -3.1], max: [9.1, 0, 9.1], kind: 1, cls: 1 }]), door);
    const { fwd, right } = bodyFrame(c.f, c.r), S = shoulderAt(c.eye, fwd, right, hand);
    let worst = 0;
    for (let i = 0; i < 200; i++) {
      if (i >= 30 && !stopped) {
        // Core.updateDoors: eased, at most 2.4 rad/s, stopped by the player
        let next = ang + (a1 * deg - ang) * (1 - Math.exp(-6 / 60));
        next = ang + Math.max(-2.4 / 60, Math.min(2.4 / 60, next - ang));
        const ex = Math.cos(next) * 0.8, ez = -Math.sin(next) * 0.8, t = Math.max(0, Math.min(1, ((2 - hx) * ex + (2 - hz) * ez) / (ex * ex + ez * ez)));
        if (Math.hypot(2 - hx - ex * t, 2 - hz - ez * t) < 0.23) stopped = true; else ang = next;
      }
      sys.update(1 / 60, sys.restFor(c, hand, i / 60), [], c, hand);
      worst = Math.max(worst, sys.penetration(sys.pose, S, undefined, hand).depth);
    }
    assert.ok(worst <= 0.005, `hinge (${hx}, ${hz}) to ${a1} deg: the swatter was ${(worst * 1000).toFixed(0)} mm inside the door leaf`);
  }
});

test('a mosquito on the 2.31 m ceiling is reachable looking up from nearby (on the toes), not from afar', () => {
  // it stayed ~9 cm out of reach even looking straight up: no rise onto the toes in the view, no shoulder lift
  const ceiling = () => boxesToBVH([{ min: [-0.1, -0.1, -0.1], max: [6.1, 0, 6.1], kind: 1, cls: 1 }, { min: [-0.1, 2.31, -0.1], max: [6.1, 2.41, 6.1] }]);
  const swingAt = (pitchDeg: number, hand: number) => {
    const p = pitchDeg * Math.PI / 180, toes = lookTiptoe(p);
    const c: CamFrame = { eye: { x: 3, y: 1.62 + toes, z: 3 }, f: { x: Math.cos(p), y: Math.sin(p), z: 0 }, r: { x: 0, y: 0, z: 1 }, up: { x: -Math.sin(p), y: Math.cos(p), z: 0 }, tiptoe: toes };
    const sys = new SwingSystem(ceiling(), noDoors);
    assert.ok(sys.begin(c, c.f, hand, 0, [], 0.32));
    let got: ContactInfo | null = null;
    for (let i = 0; i < 60; i++) { const g = sys.update(1 / 60, restPose(c, hand, i / 60, { x: 0, y: 0, z: 0 }), []); if (g && !got) got = g; }
    return got;
  };
  for (const hand of [1, -1]) for (const pitch of [55, 65, 75]) {
    const c = swingAt(pitch, hand);
    assert.ok(c && !c.air && Math.abs(c.point.y - 2.31) < 0.02, `hand ${hand}, looking up ${pitch} deg: ${c ? (c.air ? 'air at ' + c.point.y.toFixed(2) : 'hit y ' + c.point.y.toFixed(2)) : 'no swing'}`);
  }
  // 0.8 m away (looking up only 35 deg) the arm is not stretched beyond its length: step closer
  const far = swingAt(35, 1);
  assert.ok(far && far.air, 'far ceiling point: air swing');
});

test('flying mosquitoes stay in reach at 1.0-1.15 m (the wire may bend in a fast air swing)', () => {
  // capping the handle bend for air swings (the wire "has nothing to bend it") cut hits at 1.0 m by half
  const floorOnly = () => boxesToBVH([{ min: [-0.1, -0.1, -0.1], max: [6.1, 0, 6.1], kind: 1, cls: 1 }]);
  const hits = (D: number) => {
    let n = 0;
    for (const hand of [1, -1]) for (const pd of [-30, -15, 0, 15, 30]) for (let a = -2; a <= 2; a++) for (let e = -2; e <= 2; e++) {
      const p = pd * Math.PI / 180, y = a * 12 * Math.PI / 180;
      const f = { x: Math.cos(y) * Math.cos(p), y: Math.sin(p), z: -Math.sin(y) * Math.cos(p) }, r = { x: Math.sin(y), y: 0, z: Math.cos(y) };
      const up = { x: r.y * f.z - r.z * f.y, y: r.z * f.x - r.x * f.z, z: r.x * f.y - r.y * f.x };
      const c: CamFrame = { eye: { x: 3, y: 1.62, z: 3 }, f, r, up };
      const d0 = { x: f.x + up.x * e * 0.1, y: f.y + up.y * e * 0.1, z: f.z + up.z * e * 0.1 }, l = Math.hypot(d0.x, d0.y, d0.z), d = { x: d0.x / l, y: d0.y / l, z: d0.z / l };
      const pos = { x: 3 + d.x * D, y: 1.62 + d.y * D, z: 3 + d.z * D };
      const m: MosquitoTarget[] = [{ idx: 0, pos, prev: pos, alive: true, resting: false, nrm: { x: 0, y: 1, z: 0 } }];
      const sys = new SwingSystem(floorOnly(), noDoors);
      if (!sys.begin(c, d, hand, 0, m, 0.32)) continue;
      for (let i = 0; i < 60; i++) { const g = sys.update(1 / 60, restPose(c, hand, i / 60, { x: 0, y: 0, z: 0 }), m); if (g && g.mosquito === 0) { n++; break; } }
    }
    return n;
  };
  // (250 directions and hands; before this PR 140 and 70 were hit)
  assert.ok(hits(1.0) >= 130, `1.0 m: ${hits(1.0)} of 250`);
  assert.ok(hits(1.15) >= 60, `1.15 m: ${hits(1.15)} of 250`);
});
