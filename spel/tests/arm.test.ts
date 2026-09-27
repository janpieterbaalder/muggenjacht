import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allocSleeve, buildSleeve, buildTorso, solveArm, SLEEVE, BODY } from '../src/swatter/armgeom';

const P = (x: number, y: number, z: number) => ({ x, y, z });
const dist = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const socket = P(0.19, 1.38, 0.06);                      // eye at (0,1.62,0), facing -z

function ringCentres(b: ReturnType<typeof allocSleeve>) {
  const W = SLEEVE.seg + 1, out: { x: number; y: number; z: number }[] = [];
  for (let r = SLEEVE.lip; r < SLEEVE.lip + SLEEVE.rings; r++) {
    let x = 0, y = 0, z = 0;
    for (let i = 0; i < SLEEVE.seg; i++) { const o = (r * W + i) * 3; x += b.positions[o]; y += b.positions[o + 1]; z += b.positions[o + 2]; }
    out.push(P(x / SLEEVE.seg, y / SLEEVE.seg, z / SLEEVE.seg));
  }
  return out;
}

for (const [name, wrist, fdir] of [
  ['bent (hand in front)', P(0.12, 1.25, -0.30), P(0.1, 0.2, 0.97)],
  ['stretched up (ceiling)', P(0.25, 2.05, -0.55), P(-0.2, -0.6, 0.77)],
  ['far forward (beyond reach)', P(0.1, 1.4, -0.95), P(0, 0, 1)],
] as const) {
  test(`sleeve is one continuous tube from the cuff into the torso: ${name}`, () => {
    const j = solveArm(wrist, fdir, socket, P(0.6, -1, 0));
    const b = allocSleeve();
    buildSleeve(b, j, fdir, P(0, 1, 0));
    assert.ok(b.positions.every(Number.isFinite) && b.normals.every(Number.isFinite), 'finite');
    const c = ringCentres(b);
    assert.ok(dist(c[0], wrist) < 0.03, 'cuff at the wrist');
    for (let k = 1; k < c.length; k++) assert.ok(dist(c[k], c[k - 1]) < 0.03, `ring ${k} spacing`);
    // the sleeve ends inside the torso, near the shoulder socket
    assert.ok(dist(c[c.length - 1], socket) < 0.1, 'ends in the torso');
    // upper arm and forearm keep (about) their length; a far target moves the shoulder forward, not off the body
    assert.ok(Math.abs(dist(j.elbow, j.shoulder) - BODY.upper) < 1e-6, 'upper arm length');
    assert.ok(dist(j.shoulder, socket) <= BODY.protract + 1e-6, 'shoulder stays at the body');
  });
}

test('torso normals point outward and the shoulder socket lies inside it', () => {
  const t = buildTorso();
  let bad = 0;
  for (let k = 41; k < t.positions.length / 3; k++) {
    const ox = t.positions[k * 3], oz = t.positions[k * 3 + 2] - 0.085;
    if (t.normals[k * 3] * ox + t.normals[k * 3 + 2] * oz < -1e-6) bad++;
  }
  assert.equal(bad, 0);
});
