// Door leaves in plan (Babylon frame: x east, z south): the leaf as a segment from the hinge to the free edge, the gap
// between two leaves, and how an open leaf gives way to another. Pure logic, no scene (tests/doors.test.ts).

export interface Leaf {
  id: string; hinge: { x: number; z: number }; width: number; closedYaw: number; leafDir: { x: number; z: number };
  openSign: number; angle: number; target: number; maxOpen: number; moving: boolean;
}
/** hinge x, z -> free edge x, z */
export type Seg = [number, number, number, number];

/** Two leaves (44 mm thick, doorObstacles) touch when their mid-planes come closer than this. */
export const LEAF_GAP = 0.045;
/** Below this angle a leaf is shut and latched: it only opens by its handle, it is not pushed (Core.pushDoors). */
export const LATCHED = 0.05;
/** Largest turn of a leaf per collision check: the free edge of a 0.6 m leaf moves 1.2 cm, well under LEAF_GAP. */
const SUBSTEP = 0.02;
/** How far an open leaf turns aside in one step at most before it counts as held. */
const GIVE_MAX = 0.35;

export function leafSegment(d: Leaf, angle: number): Seg {
  const yaw = d.closedYaw + angle * d.openSign;
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const lx = d.leafDir.x * c + d.leafDir.z * s, lz = -d.leafDir.x * s + d.leafDir.z * c;
  return [d.hinge.x, d.hinge.z, d.hinge.x + lx * d.width, d.hinge.z + lz * d.width];
}

export function segSegDist(a: Seg, b: Seg): number {
  const pd = (px: number, pz: number, s: Seg) => {
    const ex = s[2] - s[0], ez = s[3] - s[1], L2 = ex * ex + ez * ez || 1e-9;
    const t = Math.max(0, Math.min(1, ((px - s[0]) * ex + (pz - s[1]) * ez) / L2));
    return Math.hypot(px - s[0] - ex * t, pz - s[1] - ez * t);
  };
  const cross = (ax: number, az: number, bx: number, bz: number) => ax * bz - az * bx;
  const d1x = a[2] - a[0], d1z = a[3] - a[1], d2x = b[2] - b[0], d2z = b[3] - b[1];
  const den = cross(d1x, d1z, d2x, d2z);
  if (Math.abs(den) > 1e-9) {
    const t = cross(b[0] - a[0], b[1] - a[1], d2x, d2z) / den, u = cross(b[0] - a[0], b[1] - a[1], d1x, d1z) / den;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) return 0;
  }
  return Math.min(pd(a[0], a[1], b), pd(a[2], a[3], b), pd(b[0], b[1], a), pd(b[2], b[3], a));
}

/** Leaves whose swings can meet: e.g. the wc and kids-room-1 doors, hinged 7 cm apart in one corner. Not two doors in one
 * straight wall: their free edges swing apart as either opens and only come within LEAF_GAP when both are (almost) shut,
 * where the post between the doorways parts them - the kids-room doors, latch side to latch side 3 cm apart, used to hold
 * each other ajar at 3 deg. */
function canMeet(a: Leaf, b: Leaf): boolean {
  const hx = b.hinge.x - a.hinge.x, hz = b.hinge.z - a.hinge.z;
  if (Math.hypot(hx, hz) > a.width + b.width + 0.1) return false;
  const parallel = Math.abs(a.leafDir.x * b.leafDir.z - a.leafDir.z * b.leafDir.x) < 0.01;
  return !(parallel && Math.abs(hx * a.leafDir.z - hz * a.leafDir.x) < 0.02);
}

/** Gap between two leaves at their current angles. */
export function leafGap(a: Leaf, b: Leaf): number {
  return segSegDist(leafSegment(a, a.angle), leafSegment(b, b.angle));
}

/** The angle at which open leaf o is just clear of segment seg, turned aside the way the gap opens up (pushed toward
 * shut or further open, never through it); null when it cannot get clear: at its stop, or turned too far. */
function giveWay(o: Leaf, seg: Seg): number | null {
  const gap = (a: number) => segSegDist(seg, leafSegment(o, a));
  const step = 0.004, g0 = gap(o.angle);
  const dir = gap(Math.min(o.maxOpen, o.angle + step)) >= gap(Math.max(0, o.angle - step)) ? 1 : -1;
  for (let k = 1; k * step <= GIVE_MAX + 1e-9; k++) {
    const a = o.angle + dir * k * step;
    if (a > o.maxOpen + 1e-9) return null;
    const g = gap(Math.max(0, a));
    if (g >= LEAF_GAP) return a < LATCHED && gap(0) >= LEAF_GAP ? 0 : a;  // pushed (almost) shut: the latch clicks in
    if (a <= 0 || g < g0 - 1e-4) return null;              // shut against the frame, or not getting clear
  }
  return null;
}

/** For leaf d to take segment seg: the other leaves in the way, each turned just clear of it (leaf -> angle), or null when
 * one cannot give way - shut and latched, swinging under its own motion, at its stop, or held by the player or a third
 * leaf. playerClear(seg): the player's body is clear of a leaf there. A leaf that d already touches does not hold it: a
 * state with leaves against or through each other (a round start that got it wrong) never locks both doors. */
export function makeRoom<T extends Leaf>(doors: T[], d: T, seg: Seg, playerClear: (s: Seg) => boolean): Map<T, number> | null {
  const moves = new Map<T, number>();
  const cur = leafSegment(d, d.angle);
  for (const o of doors) {
    if (o === d || !canMeet(o, d)) continue;
    const os = leafSegment(o, o.angle);
    if (segSegDist(seg, os) >= LEAF_GAP || segSegDist(cur, os) < LEAF_GAP) continue;
    if (o.moving || o.angle < LATCHED) return null;
    const a = giveWay(o, seg);
    if (a === null) return null;
    const ns = leafSegment(o, a);
    if (!playerClear(ns)) return null;
    for (const q of doors) {
      if (q === o || q === d || !canMeet(q, o)) continue;
      const qs = leafSegment(q, q.angle);
      if (segSegDist(ns, qs) < LEAF_GAP && segSegDist(os, qs) >= LEAF_GAP) return null;
    }
    moves.set(o, a);
  }
  return moves;
}

/** Turn leaf d toward angle `to` in steps of at most SUBSTEP; open leaves in the way give way (makeRoom). Stops at the last
 * step that is free. checkPlayer: the player's body stops d itself too (off while the player is the one pushing it).
 * Every leaf that turned is added to `moved`. Returns true when d reached `to`. */
export function swingTo<T extends Leaf>(doors: T[], d: T, to: number, playerClear: (s: Seg) => boolean, moved: Set<T>, checkPlayer = true): boolean {
  const from = d.angle, n = Math.max(1, Math.ceil(Math.abs(to - from) / SUBSTEP));
  for (let i = 1; i <= n; i++) {
    const a = i === n ? to : from + (to - from) * i / n;
    const seg = leafSegment(d, a);
    if (checkPlayer && !playerClear(seg)) return false;
    const room = makeRoom(doors, d, seg, playerClear);
    if (!room) return false;
    for (const [o, oa] of room) { o.angle = o.target = oa; moved.add(o); }
    d.angle = a; moved.add(d);
  }
  return true;
}

/** One frame of a leaf swinging toward its target, hand-pushed: eased, at most ~2.4 rad/s. Another open leaf in the way
 * is pushed aside; a latched or moving one, or the player, stops the swing there: the leaf waits (moving off) and carries
 * on once the way is clear, its target is kept. */
export function stepLeaf<T extends Leaf>(doors: T[], d: T, dt: number, playerClear: (s: Seg) => boolean, moved: Set<T>) {
  if (Math.abs(d.target - d.angle) < 1e-3) { d.moving = false; return; }
  let next = d.angle + (d.target - d.angle) * (1 - Math.exp(-6 * dt));
  const maxStep = 2.4 * dt;
  next = d.angle + Math.max(-maxStep, Math.min(maxStep, next - d.angle));
  if (Math.abs(d.target - next) < 1e-3) next = d.target;           // the last millimetre: shut is shut (latched at 0)
  if (!swingTo(doors, d, next, playerClear, moved)) d.moving = false;
}

/** Pairs of leaves that can meet and stand closer than LEAF_GAP (against or through each other); two shut leaves never do. */
export function touchingPairs<T extends Leaf>(doors: T[]): [T, T][] {
  const out: [T, T][] = [];
  doors.forEach((a, i) => doors.slice(i + 1).forEach((b) => {
    if (canMeet(a, b) && Math.max(a.angle, b.angle) > 0 && leafGap(a, b) < LEAF_GAP) out.push([a, b]);
  }));
  return out;
}

/** A start state with leaves against or through each other (two doors in one corner both set wide open) is settled: of
 * two leaves that touch, the one opened further closes in 0.01 rad steps until they are clear. Returns the leaves changed. */
export function settleLeaves<T extends Leaf>(doors: T[]): Set<T> {
  const changed = new Set<T>();
  for (let guard = 0; guard < 4000; guard++) {
    let worst: T | null = null;
    for (const [a, b] of touchingPairs(doors)) {
      const w = a.angle >= b.angle ? a : b;
      if (!worst || w.angle > worst.angle) worst = w;
    }
    if (!worst) break;
    const a = worst.angle - 0.01;
    worst.angle = worst.target = a < 0.03 ? 0 : a;
    changed.add(worst);
  }
  return changed;
}
