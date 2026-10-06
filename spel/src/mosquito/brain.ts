// Mosquito behaviour: flight dynamics, host seeking, obstacle avoidance, landing on real surfaces,
// escape reactions and death. Pure logic (no rendering); Babylon frame x east, y up, z south.
// Parameters are tuning values for a plausible house mosquito (Culex-like, ~5 mm body): cruise
// 0.3-0.7 m/s, quick darting accelerations, rests on walls/ceiling/curtains. Behaviour is game
// design informed by general observation, not a biological model claim.
import type { TriBVH, RayHit } from '../physics/bvh';

export type MState = 'rest' | 'takeoff' | 'fly' | 'land' | 'evade' | 'onhost' | 'fall' | 'dead' | 'squashed' | 'gone';

/** swatter head (world) with velocity; swing = number of the swing it belongs to (one escape decision per swing) */
export interface Threat { x: number; y: number; z: number; vx: number; vy: number; vz: number; active: boolean; swing?: number; }
export interface Host { x: number; y: number; z: number; }   // player's head
export interface MosquitoParams { alert: number; hostDrive: number; restMin: number; restMax: number; speed: number; roomBias?: [number, number, number, number] | null; }

const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const hit: RayHit = { t: 0, tri: 0, nx: 0, ny: 0, nz: 0 };
/** Chance per swing that a resting mosquito notices it in time and darts off, times the round's alertness
 * (0.45-1.15): a well-aimed swat hits ~82 % in round 1 down to ~54 % in round 9 (game tuning, to confirm in play). */
export const ESCAPE_PER_SWING = 0.4;
/** Landing (user feedback 06-10-2026: "it suddenly sits somewhere else than where it was flying"). The approach flies to
 * `approach` m off the chosen surface, at its cruising speed (at least `speed` m/s) and slowing down over the last 20 cm;
 * within `reached` m of that point it settles onto the surface over `touchdown` s. A landing that does not get there in
 * time (a door leaf in the way, a bounce) is given up and the mosquito flies on - it used to be put on the spot when the
 * 2.5 s timer ran out, at 0.25 m/s up to ~1 m from where it was. */
export const LANDING = { approach: 0.025, reached: 0.03, touchdown: 0.25, speed: 0.25 };
/** Seconds a resting mosquito needs to turn from its flight pose into its resting pose, and back when it takes off. */
export const TAKEOFF = 0.18;

/** Tangent basis of a surface with normal n (the resting mosquito's heading is an angle in it; visual.ts draws with it). */
export function surfaceBasis(nx: number, ny: number, nz: number): { t1: [number, number, number]; t2: [number, number, number] } {
  // t1 = n x ref, t2 = t1 x n (ref = up, or x on floors and ceilings)
  const [rx, ry, rz] = Math.abs(ny) > 0.9 ? [1, 0, 0] : [0, 1, 0];
  let ax = ny * rz - nz * ry, ay = nz * rx - nx * rz, az = nx * ry - ny * rx;
  const al = Math.hypot(ax, ay, az) || 1; ax /= al; ay /= al; az /= al;
  return { t1: [ax, ay, az], t2: [ay * nz - az * ny, az * nx - ax * nz, ax * ny - ay * nx] };
}

export class MosquitoBrain {
  // kinematics
  x = 0; y = 1.5; z = 0; vx = 0; vy = 0; vz = 0;
  // surface contact when resting
  nx = 0; ny = 0; nz = 1; tri = -1; surfaceClass = 0; headAngle = 0;
  state: MState = 'fly';
  timer = 0; stateTime = 0;
  // wander target
  tx = 0; ty = 1.4; tz = 0;
  // jitter process (Ornstein-Uhlenbeck on acceleration)
  jx = 0; jy = 0; jz = 0;
  wingPhase = 0; flying = true;
  lastSeenThreat = 0;
  hostTimer = 0; bitten = false;
  /** how far the body has turned from its flight pose into its resting pose on the surface (0 flying .. 1 resting): it
   * settles while touching down and turns back while taking off, so the visual never jumps between the two */
  settle = 0;
  /** the swing whose approach has been judged (escape or not); -1 = none */
  private judgedSwing = -1;
  /** landing: the chosen surface point and, once the approach point is reached, the touchdown (time and start point) */
  private sx = 0; private sy = 0; private sz = 0;
  private td = -1; private fx = 0; private fy = 0; private fz = 0;
  id: number;
  events: string[] = [];
  constructor(public bvh: TriBVH, public p: MosquitoParams, id: number, public obstacleRay: (ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, max: number) => number) {
    this.id = id;
  }

  get audible() { return this.state === 'fly' || this.state === 'takeoff' || this.state === 'land' || this.state === 'evade'; }
  get alive() { return this.state !== 'dead' && this.state !== 'squashed' && this.state !== 'fall' && this.state !== 'gone'; }

  /** Put the mosquito at rest on a surface point (x, y, z) with normal n. heading: its angle in the surface's tangent
   * basis (surfaceBasis); a random one when not given (start positions). */
  placeResting(x: number, y: number, z: number, nx: number, ny: number, nz: number, tri: number, cls: number, heading?: number) {
    this.x = x + nx * 0.003; this.y = y + ny * 0.003; this.z = z + nz * 0.003;
    this.nx = nx; this.ny = ny; this.nz = nz; this.tri = tri; this.surfaceClass = cls;
    this.vx = this.vy = this.vz = 0;
    this.setState('rest', rnd(this.p.restMin, this.p.restMax));
    this.headAngle = heading ?? rnd(0, Math.PI * 2);
    this.settle = 1; this.td = -1;
  }

  setState(s: MState, timer = 0) { this.state = s; this.timer = timer; this.stateTime = 0; this.events.push(s); }

  private pickWanderTarget(host: Host, bounds: [number, number, number, number]) {
    const [x0, z0, x1, z1] = this.p.roomBias ?? bounds;
    const seek = Math.random() < this.p.hostDrive;
    if (seek) {
      const a = rnd(0, Math.PI * 2), r = rnd(0.15, 0.6);
      this.tx = host.x + Math.cos(a) * r; this.ty = host.y + rnd(-0.35, 0.15); this.tz = host.z + Math.sin(a) * r;
    } else {
      this.tx = rnd(x0 + 0.25, x1 - 0.25); this.ty = rnd(0.7, 2.1); this.tz = rnd(z0 + 0.25, z1 - 0.25);
    }
  }

  /** threat = swatter head (world) with velocity; hostSpeed = player's walking speed. */
  update(dt: number, host: Host, threat: Threat, bounds: [number, number, number, number], hostSpeed: number) {
    this.stateTime += dt; this.timer -= dt;
    this.wingPhase += dt * 2 * Math.PI * (this.audible ? 520 : 0);
    // turning out of the resting pose: over TAKEOFF s from the moment it leaves the surface
    if (this.state !== 'rest' && this.state !== 'land' && this.settle > 0) this.settle = Math.max(0, this.settle - dt / TAKEOFF);
    switch (this.state) {
      case 'rest': this.rest(dt, host, threat, hostSpeed); break;
      case 'takeoff': case 'fly': case 'evade': case 'land': this.fly(dt, host, threat, bounds); break;
      case 'onhost': this.onHost(dt, host, threat); break;
      case 'fall': this.fall(dt); break;
      default: break;
    }
  }

  private rest(dt: number, host: Host, threat: Threat, hostSpeed: number) {
    // detection of an approaching swatter by air movement / looming: ONE decision per approach (REVIEW-01 G-02: drawn
    // every frame, a perfectly aimed swat on a resting mosquito missed 75 % of the time - the approach of near targets
    // ends inside the alarm distance, so it was rolled a dozen times per swing)
    const dx = threat.x - this.x, dy = threat.y - this.y, dz = threat.z - this.z;
    const d = Math.hypot(dx, dy, dz);
    const sw = threat.swing ?? 0;
    if (!threat.active || d > 0.5) { if (threat.swing === undefined) this.judgedSwing = -1; }
    else if (this.judgedSwing !== sw) {
      const closing = -(dx * threat.vx + dy * threat.vy + dz * threat.vz) / (d || 1);
      if (d < 0.35 && closing > 0.3) {
        this.judgedSwing = sw;
        // time-to-contact: the mosquito needs ~ its reaction time; a fast strike from close by beats it
        const ttc = d / closing;
        const reaction = 0.045 / this.p.alert;        // seconds
        if (ttc > reaction && Math.random() < ESCAPE_PER_SWING * this.p.alert) this.escape(threat);
      }
    }
    // a person very close and moving disturbs it
    const dh = Math.hypot(host.x - this.x, host.y - this.y, host.z - this.z);
    if (dh < 0.45 && hostSpeed > 0.6 && Math.random() < dt * 1.5 * this.p.alert) this.takeoff();
    if (this.timer <= 0) this.takeoff();
  }

  takeoff() {
    this.setState('takeoff', 0.18);
    const s = 0.45;
    this.vx = this.nx * s + rnd(-0.1, 0.1); this.vy = this.ny * s + rnd(0.05, 0.2); this.vz = this.nz * s + rnd(-0.1, 0.1);
  }

  escape(threat: Threat) {
    // dart away roughly perpendicular to the incoming swing and away from surface
    let ex = this.nx, ey = this.ny, ez = this.nz;
    const tl = Math.hypot(threat.vx, threat.vy, threat.vz) || 1;
    const px = -threat.vz / tl, pz = threat.vx / tl;
    const side = Math.random() < 0.5 ? -1 : 1;
    ex += px * side * 1.2; ez += pz * side * 1.2; ey += 0.4;
    const l = Math.hypot(ex, ey, ez) || 1;
    const sp = rnd(1.4, 2.2);
    this.vx = ex / l * sp; this.vy = ey / l * sp; this.vz = ez / l * sp;
    this.setState('evade', rnd(0.25, 0.45));
  }

  private fly(dt: number, host: Host, threat: Threat, bounds: [number, number, number, number]) {
    if (this.state === 'land') {
      // a swatter close by during the approach or the touchdown: it darts off, as in flight
      if (threat.active && Math.hypot(threat.x - this.x, threat.y - this.y, threat.z - this.z) < 0.22 && Math.random() < dt * 25 * this.p.alert) { this.escape(threat); return; }
      if (this.td >= 0) { this.touchdown(dt); return; }
      // not there in time (bounced off something, a door leaf in the way): give the landing up and fly on
      if (this.timer <= 0) { this.setState('fly', rnd(1, 3)); this.pickWanderTarget(host, bounds); }
    }
    const st = this.state;
    if (st === 'takeoff' && this.timer <= 0) { this.setState('fly', rnd(4, 11)); this.pickWanderTarget(host, bounds); }
    if (st === 'evade' && this.timer <= 0) { this.setState('fly', rnd(3, 8)); this.pickWanderTarget(host, bounds); }
    if (st === 'fly') {
      // in-flight threat reaction
      if (threat.active) {
        const d = Math.hypot(threat.x - this.x, threat.y - this.y, threat.z - this.z);
        if (d < 0.22 && Math.random() < dt * 25 * this.p.alert) this.escape(threat);
      }
      const dt2 = Math.hypot(this.tx - this.x, this.ty - this.y, this.tz - this.z);
      if (dt2 < 0.12 || Math.random() < dt * 0.35) this.pickWanderTarget(host, bounds);
      if (this.timer <= 0) this.beginLanding(host);
      // host proximity: try landing on the player after circling
      const dh = Math.hypot(host.x - this.x, host.y - this.y, host.z - this.z);
      if (dh < 0.35) { this.hostTimer += dt; if (this.hostTimer > rnd(2.5, 6) && Math.random() < this.p.hostDrive) { this.setState('onhost', rnd(1.6, 2.6)); this.hostTimer = 0; } }
    }
    // steering: desired velocity toward target with OU jitter
    const maxV = st === 'evade' ? 2.2 : st === 'land' ? this.landSpeed : this.p.speed;
    let gx = this.tx - this.x, gy = this.ty - this.y, gz = this.tz - this.z;
    const gl = Math.hypot(gx, gy, gz) || 1;
    gx /= gl; gy /= gl; gz /= gl;
    const arrive = st === 'land' ? Math.min(1, gl / 0.2) : 1;
    const theta = 6.0, sigma = st === 'land' ? 0.6 : 3.2;
    const sq = Math.sqrt(dt);
    this.jx += -theta * this.jx * dt + sigma * sq * gauss(); this.jy += -theta * this.jy * dt + sigma * 0.6 * sq * gauss(); this.jz += -theta * this.jz * dt + sigma * sq * gauss();
    let ax = (gx * maxV * arrive - this.vx) * 3.0 + this.jx * 2.2;
    let ay = (gy * maxV * arrive - this.vy) * 3.0 + this.jy * 1.4;
    let az = (gz * maxV * arrive - this.vz) * 3.0 + this.jz * 2.2;
    // obstacle avoidance: look ahead along velocity (and slightly around) against world + door leaves
    const vl = Math.hypot(this.vx, this.vy, this.vz);
    if (vl > 0.02) {
      const look = Math.min(0.35, 0.08 + vl * 0.35);
      const dx = this.vx / vl, dy = this.vy / vl, dz = this.vz / vl;
      const d = this.castAll(this.x, this.y, this.z, dx, dy, dz, look);
      if (d < look && st !== 'land') {
        // steer along surface: remove normal component and push away
        const k = (1 - d / look) * 9;
        const vn = this.vx * hit.nx + this.vy * hit.ny + this.vz * hit.nz;
        ax += (hit.nx * (Math.abs(vn) + 0.3) - dx * 0.2) * k; ay += (hit.ny * (Math.abs(vn) + 0.3)) * k; az += (hit.nz * (Math.abs(vn) + 0.3) - dz * 0.2) * k;
      }
    }
    // soft floor avoidance (mosquitoes rarely skim the floor)
    if (this.y < 0.35 && st !== 'land') ay += (0.35 - this.y) * 6;
    const al = Math.hypot(ax, ay, az), amax = st === 'evade' ? 16 : 6;
    if (al > amax) { ax *= amax / al; ay *= amax / al; az *= amax / al; }
    this.vx += ax * dt; this.vy += ay * dt; this.vz += az * dt;
    const sp = Math.hypot(this.vx, this.vy, this.vz), vmax = maxV * 1.5;
    if (sp > vmax) { this.vx *= vmax / sp; this.vy *= vmax / sp; this.vz *= vmax / sp; }
    this.integrate(dt);
    // at the approach point: touch down from where it is (the resting pose turns in on the way)
    if (st === 'land' && Math.hypot(this.tx - this.x, this.ty - this.y, this.tz - this.z) < LANDING.reached) {
      this.td = 0; this.fx = this.x; this.fy = this.y; this.fz = this.z;
      this.headAngle = this.landingHeading();
    }
  }

  /** Heading on the surface: the way it was flying along it; flying straight at a wall, mostly head up (a little
   * askew), on a ceiling or floor any way. */
  private landingHeading(): number {
    const { t1, t2 } = surfaceBasis(this.nx, this.ny, this.nz);
    const vn = this.vx * this.nx + this.vy * this.ny + this.vz * this.nz;
    const fx = this.vx - this.nx * vn, fy = this.vy - this.ny * vn, fz = this.vz - this.nz * vn;
    const along = Math.hypot(fx, fy, fz), sp = Math.hypot(this.vx, this.vy, this.vz);
    if (along > 0.02 && along > 0.3 * sp) return Math.atan2(fx * t2[0] + fy * t2[1] + fz * t2[2], fx * t1[0] + fy * t1[1] + fz * t1[2]);
    if (Math.abs(this.ny) < 0.7) return Math.PI / 2 + rnd(-0.9, 0.9);       // t2 points up along a wall
    return rnd(0, Math.PI * 2);
  }

  /** The last few cm onto the surface, eased, over LANDING.touchdown s; then it rests where it touched down. */
  private touchdown(dt: number) {
    this.td += dt;
    const k = Math.min(1, this.td / LANDING.touchdown), e = k * k * (3 - 2 * k);
    const rx = this.sx + this.nx * 0.003, ry = this.sy + this.ny * 0.003, rz = this.sz + this.nz * 0.003;
    this.x = this.fx + (rx - this.fx) * e; this.y = this.fy + (ry - this.fy) * e; this.z = this.fz + (rz - this.fz) * e;
    // the approach speed dies away (the buzz and the flight pose follow it)
    this.vx *= Math.exp(-dt * 12); this.vy *= Math.exp(-dt * 12); this.vz *= Math.exp(-dt * 12);
    this.settle = e;
    if (k >= 1) {
      this.placeResting(this.sx, this.sy, this.sz, this.nx, this.ny, this.nz, this.tri, this.surfaceClass, this.headAngle);
      this.events.push('landed');
    }
  }

  /** Continuous move with collision against static world (never tunnels through thin geometry). */
  private integrate(dt: number) {
    const mx = this.vx * dt, my = this.vy * dt, mz = this.vz * dt;
    const ml = Math.hypot(mx, my, mz);
    if (ml < 1e-7) return;
    const d = this.castAll(this.x, this.y, this.z, mx / ml, my / ml, mz / ml, ml + 0.004);
    if (d < ml + 0.004) {
      const t = Math.max(0, d - 0.004);
      this.x += mx / ml * t; this.y += my / ml * t; this.z += mz / ml * t;
      // bounce: reflect velocity with damping
      const vn = this.vx * hit.nx + this.vy * hit.ny + this.vz * hit.nz;
      this.vx -= 1.6 * vn * hit.nx; this.vy -= 1.6 * vn * hit.ny; this.vz -= 1.6 * vn * hit.nz;
      this.vx *= 0.6; this.vy *= 0.6; this.vz *= 0.6;
    } else { this.x += mx; this.y += my; this.z += mz; }
  }

  castAll(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, max: number): number {
    let best = max;
    if (this.bvh.raycast(ox, oy, oz, dx, dy, dz, max, hit, 15)) best = hit.t;
    const dd = this.obstacleRay(ox, oy, oz, dx, dy, dz, best);
    if (dd < best) { best = dd; hit.nx = -dx; hit.ny = -dy; hit.nz = -dz; }
    return best;
  }

  /** Find a real surface (wall/ceiling/curtain/furniture) nearby and fly to LANDING.approach m off it. */
  beginLanding(host: Host) {
    let found = false, dist = 0;
    for (let i = 0; i < 14 && !found; i++) {
      let dx = gauss(), dy = gauss() * 0.7 + 0.15, dz = gauss();
      // prefer surfaces away from the host's head (unless host-driven)
      if (Math.random() > this.p.hostDrive) { dx -= (host.x - this.x) * 0.3; dz -= (host.z - this.z) * 0.3; }
      const l = Math.hypot(dx, dy, dz) || 1; dx /= l; dy /= l; dz /= l;
      if (this.bvh.raycast(this.x, this.y, this.z, dx, dy, dz, 1.6, hit, 1 | 2 | 4 | 8)) {     // walls, ceiling, curtains, window glass
        const kind = this.bvh.kind[hit.tri];
        if (hit.ny > 0.75 && kind === 1 && Math.random() < 0.85) continue;  // mostly avoid floors
        if (hit.t < 0.08) continue;
        // not on or behind a door leaf: a leaf moves, and one in the way kept the mosquito from getting there
        if (this.obstacleRay(this.x, this.y, this.z, dx, dy, dz, hit.t) < hit.t) continue;
        const px = this.x + dx * hit.t, py = this.y + dy * hit.t, pz = this.z + dz * hit.t;
        if (py < 0.25 || py > 2.35) continue;
        this.nx = hit.nx; this.ny = hit.ny; this.nz = hit.nz; this.tri = hit.tri; this.surfaceClass = this.bvh.cls[hit.tri];
        this.sx = px; this.sy = py; this.sz = pz;
        const a = LANDING.approach;
        this.tx = px + hit.nx * a; this.ty = py + hit.ny * a; this.tz = pz + hit.nz * a;
        dist = hit.t;
        found = true;
      }
    }
    // time for the approach (it slows down over the last 20 cm), with room for a detour
    this.td = -1;
    if (found) this.setState('land', 2 + dist / (0.5 * this.landSpeed)); else this.setState('fly', rnd(1, 3));
  }

  /** approach speed: its cruising speed, at least LANDING.speed */
  private get landSpeed() { return Math.max(LANDING.speed, this.p.speed); }

  private onHost(dt: number, host: Host, threat: Threat) {
    // sits on the player's hand/neck area: follows the host; bites when the timer ends
    this.x += (host.x + 0.12 - this.x) * Math.min(1, dt * 8); this.y += (host.y - 0.28 - this.y) * Math.min(1, dt * 8); this.z += (host.z - this.z) * Math.min(1, dt * 8);
    if (threat.active && Math.hypot(threat.x - this.x, threat.y - this.y, threat.z - this.z) < 0.3 && Math.random() < 0.5) { this.escape(threat); return; }
    if (this.timer <= 0) { this.bitten = true; this.events.push('bite'); this.takeoffFromHost(); }
  }
  private takeoffFromHost() { this.setState('fly', rnd(5, 10)); this.vx = rnd(-0.4, 0.4); this.vy = 0.3; this.vz = rnd(-0.4, 0.4); }

  kill(onSurface: boolean) {
    if (onSurface) { this.setState('squashed'); this.vx = this.vy = this.vz = 0; }
    else { this.setState('fall'); this.vy = Math.min(this.vy, 0) - 0.2; }
    this.events.push('killed');
  }

  private fall(dt: number) {
    this.vy -= 9.81 * dt * 0.35;                      // light body: strong drag
    this.vx *= Math.exp(-dt * 3); this.vz *= Math.exp(-dt * 3); this.vy *= Math.exp(-dt * 1.5);
    const mx = this.vx * dt, my = this.vy * dt, mz = this.vz * dt, ml = Math.hypot(mx, my, mz);
    if (ml > 0 && this.bvh.raycast(this.x, this.y, this.z, mx / ml, my / ml, mz / ml, ml + 0.003, hit, 15)) {
      this.x += mx / ml * Math.max(0, hit.t - 0.002); this.y += my / ml * Math.max(0, hit.t - 0.002); this.z += mz / ml * Math.max(0, hit.t - 0.002);
      this.nx = hit.nx; this.ny = hit.ny; this.nz = hit.nz;
      if (hit.ny > 0.5) { this.setState('dead'); this.events.push('dropped'); }
      else { this.vx *= -0.2; this.vz *= -0.2; }
    } else { this.x += mx; this.y += my; this.z += mz; }
    if (this.y < -3) this.setState('dead');
  }
}

function gauss() { let u = 0, v = 0; while (u === 0) u = Math.random(); while (v === 0) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
