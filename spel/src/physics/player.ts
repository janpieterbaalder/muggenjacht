// First-person player body: a stack of spheres shaped like a person (narrow legs, wider shoulders), collide-and-
// slide against the static BVH plus door leaves. Legs pass close to low furniture (sofa side table, bed edge,
// pouf) while the shoulders still meet walls, cupboards and door posts - chalet passages are tight but walkable.
// Babylon frame: x east, y up, z south.
import type { TriBVH } from './bvh';

export interface Obstacle2D { ax: number; az: number; bx: number; bz: number; half: number; y0: number; y1: number; } // thick segment (door leaf)

export const PLAYER = {
  radius: 0.20,        // widest part (shoulders): fits the 0.56-0.60 m interior door openings (R08)
  eye: 1.62,
  speed: 1.25,         // m/s indoor walking
  accel: 9.0,
  stepUp: 0.24,        // veranda treads ~0.18 m
  // shins, thighs, hips, shoulders, head (height of sphere centre above the feet, radius)
  body: [{ h: 0.35, r: 0.11 }, { h: 0.62, r: 0.14 }, { h: 0.95, r: 0.17 }, { h: 1.30, r: 0.20 }, { h: 1.60, r: 0.12 }],
};
/** Spheres reaching below the step height would block treads; those are handled by the floor follow. */
const collidersFor = (stepUp: number) => PLAYER.body.filter((b) => b.h - b.r >= stepUp - 0.005);
const COLLIDERS = collidersFor(PLAYER.stepUp);
/** Climbing onto a bed, chair or sofa seat (looking up at a mosquito on the ceiling, or walking on into it): surfaces
 * up to 0.70 m above the room floor - a bed with a folded duvet (kids room 2) or pillows is ~0.60-0.66 m (was 0.62:
 * those beds could not be climbed, D51); the dining table (0.74), worktops and the vanity stay out of bounds.
 * pushTime: walking on into a climbable surface this long (s) steps onto it; hold: how long the step-up stays allowed. */
export const CLIMB = { maxAboveFloor: 0.70, pushTime: 0.3, hold: 0.8, headClear: 0.13, bedMin: 0.48 };
const CLIMB_COLLIDERS = collidersFor(CLIMB.maxAboveFloor);

const tmp = new Float32Array(3);

export class PlayerBody {
  x = 4.3; y = 0; z = -2.2;          // feet position
  vx = 0; vz = 0; vy = 0;
  onGround = true;
  /** set by Core while the player looks steeply up (or walks on into a bed/chair): allows stepping onto beds, chairs and the sofa */
  climb = false;
  /** share of the wanted displacement actually made in the last step (1 = free walking, ~0 = walking into something) */
  progress = 1;
  private climbPush = 0; private climbHold = 0;
  constructor(public bvh: TriBVH, public obstacles: () => Obstacle2D[]) {}

  /** Floor height below (x,z) starting from yFrom; returns -Infinity when no floor. mask: kinds that carry the player. */
  floorAt(x: number, z: number, yFrom: number, mask = 1 | 2 | 8): number {
    const hit = { t: 0, tri: 0, nx: 0, ny: 0, nz: 0 };
    let best = -Infinity;
    const offs = [[0, 0], [0.08, 0], [-0.08, 0], [0, 0.08], [0, -0.08]];
    for (const [dx, dz] of offs) {
      if (this.bvh.raycast(x + dx, yFrom, z + dz, 0, -1, 0, 3.0, hit, mask)) {
        if (hit.ny > 0.6) best = Math.max(best, yFrom - hit.t);
      }
    }
    return best;
  }

  /** True when the capsule standing at (x, y, z) overlaps no wall, furniture or door leaf. margin: extra clearance
   * (m) around the body, used by passability checks (a gap that fits only to the centimetre is not walkable). */
  isFree(x: number, y: number, z: number, margin = 0): boolean {
    let blocked = false;
    for (const { h, r: r0 } of COLLIDERS) {
      const r = r0 + margin;
      const cy = y + h;
      this.bvh.querySphere(x, cy, z, r, (t) => {
        if (blocked) return;
        this.bvh.closestOnTri(t, x, cy, z, tmp);
        const dx = x - tmp[0], dy = cy - tmp[1], dz = z - tmp[2];
        if (dx * dx + dy * dy + dz * dz < r * r) blocked = true;
      }, 1 | 4 | 8);
      if (blocked) return false;
    }
    for (const o of this.obstacles()) {
      const ex = o.bx - o.ax, ez = o.bz - o.az, L2 = ex * ex + ez * ez || 1e-9;
      const s = Math.max(0, Math.min(1, ((x - o.ax) * ex + (z - o.az) * ez) / L2));
      if (Math.hypot(x - (o.ax + ex * s), z - (o.az + ez * s)) < PLAYER.radius + o.half + margin) return false;
    }
    return true;
  }

  /** Nearest free standing spot on a real floor (not on furniture) around (x, z), searched in rings. */
  findFreeSpot(x: number, z: number, maxR = 1.5): [number, number, number] | null {
    for (let rr = 0; rr <= maxR + 1e-6; rr += 0.05) {
      const n = rr === 0 ? 1 : Math.ceil(2 * Math.PI * rr / 0.05);
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        const px = x + Math.cos(a) * rr, pz = z + Math.sin(a) * rr;
        const floor = this.floorAt(px, pz, 2.2, 2);                 // floor triangles only
        if (floor === -Infinity) continue;
        const top = this.floorAt(px, pz, 2.2);                      // anything walkable above it (chair seat, bed...)
        if (top > floor + PLAYER.stepUp) continue;
        if (this.isFree(px, floor, pz)) return [px, floor, pz];
      }
    }
    return null;
  }

  /** Push the capsule out of geometry horizontally; returns true if any contact. */
  private resolve(): boolean {
    let touched = false;
    for (let iter = 0; iter < 4; iter++) {
      let moved = false;
      for (const { h, r } of (this.climb ? CLIMB_COLLIDERS : COLLIDERS)) {
        const cy = this.y + h;
        this.bvh.querySphere(this.x, cy, this.z, r, (t) => {
          this.bvh.closestOnTri(t, this.x, cy, this.z, tmp);
          let dx = this.x - tmp[0], dy = cy - tmp[1], dz = this.z - tmp[2];
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 >= r * r) return;
          // horizontal push only (walls/furniture); ignore near-horizontal floors/ceilings
          const hl = Math.hypot(dx, dz);
          if (hl < 1e-5) {
            this.bvh.normal(t, tmp);
            const nl = Math.hypot(tmp[0], tmp[2]);
            if (nl < 0.3) return;
            dx = tmp[0] / nl; dz = tmp[2] / nl;
            const pen = r;
            this.x += dx * pen * 0.5; this.z += dz * pen * 0.5; moved = touched = true; return;
          }
          const d = Math.sqrt(d2);
          const pen = r - d;
          // convert 3D penetration into horizontal correction
          const k = pen / hl * (d / hl > 0 ? 1 : 1);
          this.x += dx * Math.min(k, 0.1); this.z += dz * Math.min(k, 0.1);
          moved = touched = true;
        }, 1 | 4 | 8);
      }
      for (const o of this.obstacles()) {
        if (this.y + 1.7 < o.y0 || this.y + 0.2 > o.y1) continue;
        const ex = o.bx - o.ax, ez = o.bz - o.az;
        const L2 = ex * ex + ez * ez || 1e-9;
        let s = ((this.x - o.ax) * ex + (this.z - o.az) * ez) / L2; s = Math.max(0, Math.min(1, s));
        const qx = o.ax + ex * s, qz = o.az + ez * s;
        const dx = this.x - qx, dz = this.z - qz;
        const d = Math.hypot(dx, dz), lim = PLAYER.radius + o.half;
        if (d < lim && d > 1e-6) { const k = (lim - d) / d; this.x += dx * k; this.z += dz * k; moved = touched = true; }
      }
      if (!moved) break;
    }
    return touched;
  }

  /** A surface in front (unit direction dx,dz) that the body could step onto when climbing: higher than a tread, at
   * most CLIMB.maxAboveFloor above the room floor (bed, chair, sofa seat - not a table or worktop). bedOnly: only a
   * soft top at least CLIMB.bedMin above the floor - a mattress or duvet, not a chair or the sofa seat (0.40-0.45). */
  climbableAhead(dx: number, dz: number, bedOnly = false): boolean {
    const room = this.floorAt(this.x, this.z, this.y + 1.0, 2);
    const base = room > -Infinity ? room : this.y;
    const hit = { t: 0, tri: 0, nx: 0, ny: 0, nz: 0 };
    for (const d of [0.16, 0.26, 0.36]) {
      const px = this.x + dx * d, pz = this.z + dz * d;
      const yFrom = this.y + CLIMB.maxAboveFloor + 0.15;
      const f = this.floorAt(px, pz, yFrom);
      if (!(f > this.y + PLAYER.stepUp && f <= base + CLIMB.maxAboveFloor)) continue;
      if (!bedOnly) return true;
      if (f >= base + CLIMB.bedMin && this.bvh.raycast(px, yFrom, pz, 0, -1, 0, yFrom - f + 0.03, hit, 1 | 2 | 8) && this.bvh.kind[hit.tri] === 3) return true;     // kind 3 = soft
    }
    return false;
  }

  /** Decide whether stepping onto a bed/chair/sofa is allowed this frame: while looking up at the ceiling (D40), or after
   * walking on into one for CLIMB.pushTime (D51: with the real arm length a mosquito on the wall above a bed is only
   * reachable from the bed). Call before step(). */
  updateClimb(dt: number, wantX: number, wantZ: number, lookingUp: boolean) {
    const sp = Math.hypot(wantX, wantZ);
    // walking on into it: beds only (REVIEW-01 G-14: 0.3 s against the sofa or a chair put you on it)
    const pushing = sp > 0.3 && this.onGround && this.progress < 0.3 && this.climbableAhead(wantX / sp, wantZ / sp, true);
    this.climbPush = pushing ? this.climbPush + dt : Math.max(0, this.climbPush - 2 * dt);
    if (this.climbPush >= CLIMB.pushTime) { this.climbHold = CLIMB.hold; this.climbPush = 0; }
    this.climbHold = Math.max(0, this.climbHold - dt);
    this.climb = lookingUp || this.climbHold > 0;
  }

  /** Standing on furniture (bed, chair): height of the ceiling or shelf above the head; Infinity on the floor (so walking
   * under the kitchen wall cupboards never dips the view) or in the open. */
  ceilingAbove(): number {
    const room = this.floorAt(this.x, this.z, this.y + 1.0, 2);
    if (room === -Infinity || this.y - room < 0.25) return Infinity;
    const hit = { t: 0, tri: 0, nx: 0, ny: 0, nz: 0 };
    return this.bvh.raycast(this.x, this.y + 1.0, this.z, 0, 1, 0, 2.5, hit, 1) ? this.y + 1.0 + hit.t : Infinity;
  }

  /** Advance with desired horizontal velocity (m/s, world). Substeps prevent tunnelling. */
  step(dt: number, wantX: number, wantZ: number) {
    const x0 = this.x, z0 = this.z;
    const a = 1 - Math.exp(-PLAYER.accel * dt);
    this.vx += (wantX - this.vx) * a; this.vz += (wantZ - this.vz) * a;
    const dist = Math.hypot(this.vx, this.vz) * dt;
    const n = Math.max(1, Math.ceil(dist / (0.11 * 0.35)));        // substeps smaller than the thinnest sphere
    for (let i = 0; i < n; i++) {
      const px = this.x, pz = this.z;
      this.x += this.vx * dt / n; this.z += this.vz * dt / n;
      // floor follow with step-up / step-down (climbing: up to CLIMB.maxAboveFloor above the real floor)
      let up = PLAYER.stepUp;
      if (this.climb) {
        const room = this.floorAt(this.x, this.z, this.y + 1.0, 2);
        if (room > -Infinity) up = Math.max(up, room + CLIMB.maxAboveFloor - this.y);
      }
      // climbing leaves the legs out of the collision, so the floor probe must see anything the hips would pass over:
      // a table top (0.74) blocks, a bed or chair seat is stepped onto
      const f = this.floorAt(this.x, this.z, this.y + (this.climb ? Math.max(up + 0.02, 0.8) : up + 0.02));
      if (f === -Infinity || f - this.y > up) { this.x = px; this.z = pz; continue; }
      if (f > this.y - 0.5) { this.y = f; this.onGround = true; }
      else { this.onGround = false; }
      this.resolve();
    }
    if (!this.onGround) {
      this.vy -= 9.81 * dt; this.y += this.vy * dt;
      const f = this.floorAt(this.x, this.z, this.y + 0.5);
      if (f > -Infinity && this.y <= f) { this.y = f; this.vy = 0; this.onGround = true; }
    }
    const w2 = wantX * wantX + wantZ * wantZ;
    this.progress = w2 > 1e-6 ? ((this.x - x0) * wantX + (this.z - z0) * wantZ) / (w2 * dt) : 1;
    // real velocity after collisions (for footsteps / sway)
  }
}
