// Fly-swatter swing: intention (aim point within reach), full motion (anticipation, acceleration,
// contact, material reaction, recovery) and continuous collision of the moving head (rim + face) and
// shaft against the world, doors and mosquitoes. Visual pose, physics volume, sound and outcome all
// use the same contact time. Babylon frame (x east, y up, z south), metres, seconds.
import type { TriBVH, RayHit } from '../physics/bvh';
import { ARM_PLAN_MAX, BODY, HAND, TIPTOE, WRIST, armPole, bodyFrame, handOnHandle, shoulderAt, shoulderLift, solveArm, wristAngles } from './armgeom';

export type V3 = { x: number; y: number; z: number };
const v = (x = 0, y = 0, z = 0): V3 => ({ x, y, z });
const add = (a: V3, b: V3, s = 1): V3 => v(a.x + b.x * s, a.y + b.y * s, a.z + b.z * s);
const sub = (a: V3, b: V3): V3 => v(a.x - b.x, a.y - b.y, a.z - b.z);
const dot = (a: V3, b: V3) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: V3, b: V3): V3 => v(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
const len = (a: V3) => Math.hypot(a.x, a.y, a.z);
const norm = (a: V3): V3 => { const l = len(a) || 1; return v(a.x / l, a.y / l, a.z / l); };
const lerp3 = (a: V3, b: V3, t: number): V3 => v(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t);

/** Swatter geometry (classic plastic swatter, head 105 x 125 mm, overall 460 mm). */
export const SWATTER = { headW: 0.105, headH: 0.125, headT: 0.004, neck: 0.02, shaft: 0.29, grip: 0.12, gripFromHead: 0.40 };
// from the eye: arm ~0.62 + swatter ~0.4 when upright (0.98); leaning the upper body in (Session.lean) adds ~0.3
export const REACH = { max: 1.28, upright: 0.98, min: 0.18 };
export const MOSQ_R = 0.011;                          // body/leg envelope + small fairness margin

/** Head/handle pose. n = striking face normal (points at target), u = neck->grip direction in the head plane, r = u x n.
 * flex = bend of the head against the handle at the neck, about r (rad; + = handle tilted back toward the player, as
 * the wire handle of a swatter gives). hu/hn = handle direction and palm/handle normal (the hand frame). */
export interface Pose { h: V3; n: V3; u: V3; r: V3; grip: V3; flex: number; hu: V3; hn: V3; }

/** tiptoe: how far (m) the eye is already raised on the toes (looking up); a plan can only rise the rest of TIPTOE. */
export interface CamFrame { eye: V3; f: V3; r: V3; up: V3; tiptoe?: number; }

export function restPose(c: CamFrame, hand: number, t: number, sway: V3): Pose {
  // held low at the right (or left) of view, head up, face forward; gentle idle breathing
  const br = Math.sin(t * 1.3) * 0.004;
  // lower right of the view (left for the left-handed option) so the centre of the view stays free - but left of and
  // above the 'Sla' button in the corner (REVIEW-01 G-19: at 0.24 / -0.13 the button covered most of the head)
  const h = add(add(add(c.eye, c.f, 0.40), c.r, 0.19 * hand + sway.x), c.up, -0.10 + br + sway.y);
  const n = norm(add(add(c.f, c.r, -0.2 * hand), c.up, 0.05));
  const u = norm(add(add(v(-c.up.x, -c.up.y, -c.up.z), c.f, -0.4), c.r, 0.2 * hand));      // handle down/back toward the hand
  // held straight: the head in line with the handle (the wire only bends in a slap). Until now the rest pose kept a
  // 20 deg bend, which tilted the head's plastic rib out of its plane - the head looked crooked on the handle. The
  // swatter is turned as a whole instead, so the hand stays where it was.
  const bent = finishPose(h, n, u, 0.35);
  return finishPose(h, bent.hn, bent.hu, 0);
}

/** The wire handle leaves the head's moulded plastic rib along u (the rib never bends) and runs to the hand, where it
 * lies along hu: a cubic Bezier, straight when the pose has no flex, bending smoothly when the head is flexed against
 * the handle (as the wire gives when the head slaps a surface). t = 0 inside the rib end, 1 at the grip. */
export const WIRE = { start: 0.02, pastGrip: 0.045, radius: 0.0022 };
export function wirePoint(p: Pose, t: number): V3 {
  const a = add(p.h, p.u, HAND.neck + WIRE.start), g = p.grip;
  const k = len(sub(g, a)) / 3, b1 = add(a, p.u, k), b2 = add(g, p.hu, -k), s = 1 - t;
  const w0 = s * s * s, w1 = 3 * s * s * t, w2 = 3 * s * t * t, w3 = t * t * t;
  return v(w0 * a.x + w1 * b1.x + w2 * b2.x + w3 * g.x, w0 * a.y + w1 * b1.y + w2 * b2.y + w3 * g.y, w0 * a.z + w1 * b1.z + w2 * b2.z + w3 * g.z);
}

export function finishPose(h: V3, n: V3, u: V3, flex = 0): Pose {
  // head frame: u orthogonal to n; the handle (and the hand on it) is the head frame turned about r by flex
  const uh = norm(sub(u, v(n.x * dot(u, n), n.y * dot(u, n), n.z * dot(u, n))));
  const r = norm(cross(uh, n));
  const c = Math.cos(flex), sn = Math.sin(flex);
  const hu = v(uh.x * c - n.x * sn, uh.y * c - n.y * sn, uh.z * c - n.z * sn);
  const hn = v(n.x * c + uh.x * sn, n.y * c + uh.y * sn, n.z * c + uh.z * sn);
  const neck = add(h, uh, HAND.neck);
  const grip = add(neck, hu, HAND.gripFromHead - HAND.neck);
  return { h, n, u: uh, r, grip, flex, hu, hn };
}

/** Knee bend (m) for a target at height y from an eye at eyeY (low targets). */
export function crouchFor(eyeY: number, y: number) { return Math.max(0, Math.min(0.55, (eyeY - 0.85 - y) * 0.8)); }

export interface StrikePlan { pose: Pose; lean: number; crouch: number; cost: number; }

/** Choose the swatter orientation for a head at P with face normal n from the ARM: the wrist must stay within reach of
 * the (leaned) shoulder and the hand within the wrist and forearm range. Searches the rotation of the swatter about
 * its face normal, the neck flex, the upper-body lean and (for high targets) rising onto the toes; the most comfortable
 * whole-body pose wins. null = not reachable. */
export function planStrike(c: CamFrame, P: V3, n: V3, hand: number, leanMax: number, coarse = false, air = false): StrikePlan | null {
  const nPh = coarse ? 16 : 32, fdStep = coarse ? 20 : 10, leanStep = coarse ? 0.16 : 0.064;
  const { fwd, right } = bodyFrame(c.f, c.r);
  const base = crouchFor(c.eye.y, P.y);
  // high targets (ceiling): rise onto the toes (negative crouch) before anything else - as far as looking up has not
  // raised the view already
  const toes = Math.max(0, TIPTOE - (c.tiptoe ?? 0));
  const crouches = P.y > c.eye.y + 0.3 && base === 0 && toes > 0.005 ? [0, -toes / 2, -toes] : [base];
  const pole = armPole(right, hand);
  const up = Math.abs(n.y) < 0.9 ? v(0, 1, 0) : v(1, 0, 0);
  const e1 = norm(cross(n, up)), e2 = cross(n, e1);
  const high = P.y > c.eye.y + 0.1;
  // reaching up to the ceiling one stretches the arm fully and turns the forearm to its limit (adult ROM ~85 deg)
  const overhead = P.y > c.eye.y + 0.3;
  const armMax = overhead ? BODY.upper + BODY.fore : ARM_PLAN_MAX, rollMax = overhead ? 85 : WRIST.roll;
  let best: StrikePlan | null = null;
  for (let lean = 0; lean <= leanMax + 1e-6; lean += leanStep) for (const crouch of crouches) {
    const eye = v(c.eye.x + fwd.x * lean, c.eye.y - 0.35 * lean - crouch, c.eye.z + fwd.z * lean);
    const S0 = shoulderAt(eye, fwd, right, hand);
    const dHead = len(sub(P, S0));
    // moving the body costs a little: lean or rise only when it makes the arm clearly more comfortable
    const bodyCost = 0.8 * (lean / 0.32) ** 2 + (crouch < 0 ? 0.6 * (-crouch / TIPTOE) ** 2 : 0);
    if (best && bodyCost >= best.cost) continue;
    for (let i = 0; i < nPh; i++) {
      const ph = i / nPh * Math.PI * 2;
      const u = add(v(e1.x * Math.cos(ph), e1.y * Math.cos(ph), e1.z * Math.cos(ph)), e2, Math.sin(ph));
      // the wire handle bends when the head slaps flat on a surface, further against the ceiling above you; in the air
      // there is nothing to bend it
      for (let fd = -10; fd <= (air ? 10 : high ? 60 : 40); fd += fdStep) {
        const pose = finishPose(P, n, u, fd * Math.PI / 180);
        const { wrist, fdir, palm } = handOnHandle(pose.grip, pose.r, pose.hu, pose.hn, hand);
        // reaching up lifts the shoulder with the shoulder blade
        const S = v(S0.x, S0.y + shoulderLift(S0, wrist), S0.z);
        const L = len(sub(wrist, S));
        if (L > armMax) continue;
        const j = solveArm(wrist, fdir, S, pole);
        const w = wristAngles(fdir, palm, wrist, j.elbow, j.shoulder, hand);
        if (Math.abs(w.ext) > WRIST.ext || Math.abs(w.dev) > WRIST.dev || Math.abs(w.roll) > rollMax) continue;
        // prefer a relaxed wrist, little neck flex, the handle reaching back toward the body (grip nearer the
        // shoulder than the head), the elbow not behind the shoulder, a bent elbow (not a locked, straight arm),
        // the elbow below the shoulder (no 'chicken wing', except reaching up) and the hand in front of the body
        // rather than far out to the side
        let cost = bodyCost + (w.ext / WRIST.ext) ** 2 + (w.dev / WRIST.dev) ** 2 + 0.5 * (w.roll / WRIST.roll) ** 2 + 0.4 * (fd / 45) ** 2;
        cost += 4 * Math.max(0, len(sub(pose.grip, S)) - dHead + 0.15);
        cost += 12 * Math.max(0, -dot(sub(j.elbow, S), fwd) - 0.02);
        cost += 6 * Math.max(0, 0.12 - dot(sub(wrist, S), fwd));
        cost += 1.5 * (Math.max(0, L - 0.42) / 0.13) ** 2;
        if (!high) cost += 8 * Math.max(0, j.elbow.y - (S.y - 0.08));
        cost += 4 * Math.max(0, dot(sub(wrist, S), right) * hand - 0.18);
        if (!best || cost < best.cost) best = { pose, lean, crouch, cost };
      }
    }
  }
  return best;
}

export type SwingPhase = 'idle' | 'windup' | 'strike' | 'rebound' | 'follow' | 'return';

export interface ContactInfo { t: number; point: V3; normal: V3; cls: number; kind: number; speed: number; mosquito: number; air: boolean; door: boolean; }

export interface MosquitoTarget { idx: number; pos: V3; prev: V3; alive: boolean; resting: boolean; nrm: V3; }

export interface Swing {
  phase: SwingPhase; t: number; tContact: number; tEnd: number;
  start: Pose; pre: Pose; target: Pose; after: Pose; surface: boolean; aimDist: number;
  /** approach (bring the swatter ~40 cm in front of the target while leaning in) and strike durations (s) */
  tApproach: number;
  /** body movement the swing needs: upper-body lean toward the target (m) and knee bend (m) */
  lean: number; crouch: number;
  contact: ContactInfo | null; plannedNormal: V3; hitMosquito: number;
}

const hit: RayHit = { t: 0, tri: 0, nx: 0, ny: 0, nz: 0 };

export class SwingSystem {
  swing: Swing | null = null;
  pose!: Pose;
  prevPose!: Pose;
  velocity = v();
  cooldown = 0;
  lastContact: ContactInfo | null = null;
  swings = 0;
  constructor(public bvh: TriBVH, public doorRay: (o: V3, d: V3, max: number) => number) {}

  idle(c: CamFrame, hand: number, t: number, sway: V3) {
    const p = restPose(c, hand, t, sway);
    if (!this.pose) { this.pose = p; this.prevPose = p; }
    return p;
  }

  /** Plan a swing toward the aim direction d (unit, world) from the eye. leanMax = how far (m) the upper body can lean
   * toward the target (free space in front of the chest). The swing first brings the swatter to about 40 cm in front
   * of the target while the body leans in / bends the knees (approach), then strikes (D48). A target the arm cannot
   * reach even when leaning ends as an air swing where the arm runs out: step closer. */
  begin(c: CamFrame, d: V3, hand: number, t: number, mosq: MosquitoTarget[], leanMax = 0): boolean {
    if (this.swing && this.swing.phase !== 'return' && this.swing.phase !== 'follow') return false;
    if (this.cooldown > 0) return false;
    const start = this.pose ?? restPose(c, hand, t, v());
    // world target along the aim ray
    let dist = REACH.max, surface = false, nrm = norm(v(-d.x, -d.y, -d.z));
    if (this.bvh.raycast(c.eye.x, c.eye.y, c.eye.z, d.x, d.y, d.z, REACH.max + 0.08, hit, 15)) {
      dist = hit.t; surface = hit.t <= REACH.max + 0.02; nrm = v(hit.nx, hit.ny, hit.nz);
    }
    const dd = this.doorRay(c.eye, d, dist);
    if (dd < dist) { dist = dd; surface = true; nrm = norm(v(-d.x, -d.y, -d.z)); }
    // flying mosquito close to the aim ray inside reach becomes the intended air target
    let aimM = -1;
    for (const m of mosq) {
      if (!m.alive || m.resting) continue;
      const w = sub(m.pos, c.eye); const along = dot(w, d);
      if (along < REACH.min || along > Math.min(dist, REACH.max)) continue;
      const off = len(sub(w, v(d.x * along, d.y * along, d.z * along)));
      if (off < 0.05) { dist = along; surface = false; aimM = m.idx; }
    }
    dist = Math.max(REACH.min, Math.min(dist, REACH.max));
    // aim 12 mm beyond a surface: the continuous sweep then always registers the contact AT the surface
    // (planning to stop just short of it made contact depend on a floating-point tie)
    let P = add(c.eye, d, surface ? dist + 0.012 : dist);
    // contact orientation: face flush with surface, or face-on to the swing direction in air
    let n = surface ? norm(v(-nrm.x, -nrm.y, -nrm.z)) : d;
    let plan = planStrike(c, P, n, hand, leanMax, false, !surface);
    // out of reach: the swing ends in the air where the arm (with the lean) runs out - binary search on the distance
    // with a coarse plan, then one full plan there
    if (!plan) {
      surface = false; aimM = -1; n = d;
      let lo = REACH.min, hi = dist;
      if (planStrike(c, add(c.eye, d, lo), n, hand, leanMax, true, true)) {
        for (let k = 0; k < 6; k++) { const mid = (lo + hi) / 2; if (planStrike(c, add(c.eye, d, mid), n, hand, leanMax, true, true)) lo = mid; else hi = mid; }
        for (let back = 0; !plan && lo - back >= REACH.min; back += 0.03) {
          P = add(c.eye, d, lo - back);
          plan = planStrike(c, P, n, hand, leanMax, false, true);
          if (plan) dist = lo - back;
        }
      }
    }
    if (!plan) return false;
    const target = plan.pose;
    // approach: the swatter comes to ~40 cm in front of the target (outside a resting mosquito's alarm distance),
    // head tilted back a little (cocked wrist); less room for near targets
    const eyeL = len(sub(P, c.eye)) - plan.lean;
    const D = Math.max(0.12, Math.min(0.40, eyeL - 0.38));
    const preN = norm(add(n, v(0, 1, 0), 0.25));
    // straight in the approach; the wire bends into the planned flex only in the strike itself
    const pre = finishPose(add(P, n, -D), preN, target.u, 0);
    // recovery target after contact
    const after = surface ? finishPose(add(P, n, -0.05), n, target.u, target.flex) : finishPose(add(P, d, 0.12), norm(add(d, c.up, -0.4)), target.u, target.flex);
    const ta = Math.max(0.10, Math.min(0.30, 0.08 + 0.45 * len(sub(pre.h, start.h)) + 0.25 * plan.lean));
    const ts = 0.05 + 0.08 * D / 0.40;                    // ~0.13 s over 40 cm: ~3 m/s mean, ~6 m/s at contact
    this.swing = { phase: 'windup', t: 0, tApproach: ta, tContact: ta + ts, tEnd: ta + ts + (surface ? 0.36 : 0.40), start, pre, target, after, surface,
      aimDist: dist, lean: plan.lean, crouch: plan.crouch, contact: null, plannedNormal: nrm, hitMosquito: aimM };
    this.swings++;
    return true;
  }

  /** Pose along the planned motion at time t (no collision). */
  private planned(s: Swing, t: number): Pose {
    const ta = s.tApproach, tc = s.tContact;
    if (t <= ta) {
      // approach: eased, the head lifted slightly on the way
      const k = smooth(t / ta);
      const p = blend(s.start, s.pre, k);
      return finishPose(add(p.h, v(0, 1, 0), Math.sin(Math.PI * k) * 0.03), p.n, p.u, p.flex);
    }
    if (t <= tc) {
      const k = (t - ta) / (tc - ta);
      const e = Math.pow(k, 1.9);                      // accelerate into contact
      const p = blend(s.pre, s.target, e);
      const bow = Math.sin(Math.PI * e) * 0.025;       // short, slightly curved strike
      return finishPose(add(p.h, v(0, 1, 0), bow), p.n, p.u, p.flex);
    }
    const hold = s.surface ? 0.07 : 0.0;
    const tr = t - tc;
    const from = s.target;
    if (tr < hold) return from;
    const k2 = Math.min(1, (tr - hold) / 0.09);
    const mid = blend(from, s.after, smooth(k2));
    if (k2 < 1) return mid;
    return mid;
  }

  /**
   * Advance the swing. rest = current rest pose (camera follows player). mosq = targets (updated positions).
   * Returns contact info when contact happens this frame.
   */
  update(dt: number, rest: Pose, mosq: MosquitoTarget[], cam?: CamFrame, hand = 1): ContactInfo | null {
    this.cooldown = Math.max(0, this.cooldown - dt);
    this.prevPose = this.pose ?? rest;
    const s = this.swing;
    let result: ContactInfo | null = null;
    if (!s) { this.pose = cam ? this.resolve(rest, cam, hand, dt, true) : rest; this.velocity = v(); return null; }
    const subs = 6;
    for (let i = 0; i < subs; i++) {
      const t0 = s.t, t1 = s.t + dt / subs;
      if (!s.contact && t1 >= 0) {
        const p0 = this.poseAt(s, t0, rest), p1 = this.poseAt(s, Math.min(t1, s.tContact + 0.02), rest);
        const c = this.sweep(p0, p1, mosq, t0, Math.min(t1, s.tContact + 0.02));
        if (c) {
          s.contact = c; result = c; this.lastContact = c;
          // re-time: contact now; freeze target at contact pose (stop/deflect on obstacle)
          const pc = blend(p0, p1, (c.t - t0) / Math.max(1e-6, (Math.min(t1, s.tContact + 0.02) - t0)));
          s.target = pc;
          s.after = c.air ? finishPose(add(pc.h, pc.n, 0.1), pc.n, pc.u, pc.flex) : finishPose(add(pc.h, pc.n, -0.045), pc.n, pc.u, pc.flex);
          s.tContact = c.t; s.surface = !c.air; s.tEnd = c.t + (c.air ? 0.38 : 0.34);
          this.cooldown = 0.12;
        } else if (t1 >= s.tContact + 0.02 && !s.contact) {
          // reached planned end without touching anything: air swing
          s.contact = { t: s.tContact, point: p1.h, normal: p1.n, cls: -1, kind: -1, speed: len(this.velocity), mosquito: -1, air: true, door: false };
          result = s.contact; this.lastContact = s.contact; this.cooldown = 0.1;
        }
      }
      s.t = t1;
    }
    const p = cam ? this.resolve(this.poseAt(s, s.t, rest), cam, hand, dt) : this.poseAt(s, s.t, rest);
    this.velocity = v((p.h.x - this.prevPose.h.x) / dt, (p.h.y - this.prevPose.h.y) / dt, (p.h.z - this.prevPose.h.z) / dt);
    this.pose = p;
    s.phase = s.t < s.tApproach ? 'windup' : s.t < s.tContact ? 'strike' : !s.contact ? 'strike' : s.contact.air ? (s.t < s.tContact + 0.1 ? 'follow' : 'return') : (s.t < s.tContact + 0.16 ? 'rebound' : 'return');
    if (s.t >= s.tEnd) this.swing = null;
    return result;
  }

  /** Rest pose that makes room near walls and furniture: with little free space in front of the eye the swatter is
   * held closer to the body, lower and more upright (as one does standing against a wall or leaning over a table). */
  restFor(c: CamFrame, hand: number, t: number): Pose {
    const p = restPose(c, hand, t, v());
    // free space toward the swatter: the nearest of three rays (the head and 3 cm to either side), aimed at the pose
    // without its breathing - one ray grazing an edge flipped between hit and miss as the head rose and fell
    const p0 = restPose(c, hand, 0, v());
    let free = 0.8;
    for (const s of [0, 0.03, -0.03]) {
      const d = norm(sub(add(p0.h, c.r, s), c.eye));
      free = Math.min(free, this.bvh.raycast(c.eye.x, c.eye.y, c.eye.z, d.x, d.y, d.z, 0.8, hit, 15) ? hit.t : 0.8, this.doorRay(c.eye, d, 0.8));
    }
    const want = Math.max(0, Math.min(1, (0.62 - free) / 0.32));
    // eased: the probe ray can slip past an edge and back, which made the resting swatter jump 8 cm to and fro
    const dt = Math.min(0.1, t - this.restT);
    this.restK = this.restK < 0 || dt < 0 ? want : this.restK + (want - this.restK) * (1 - Math.exp(-dt / 0.12));
    this.restT = t;
    const k = this.restK;
    if (k <= 1e-4) return p;
    const h = add(add(p.h, c.f, -0.15 * k), c.up, -0.09 * k);
    return finishPose(h, norm(add(p.n, c.up, 0.6 * k)), p.u, p.flex);
  }

  /** The swatter as a chain of points hanging from the shoulder (always free space): shoulder -> grip -> hand sides,
   * grip -> wrist -> forearm (REVIEW-01 G-10: resting next to a wall the wrist sat 3.5 cm inside it), grip -> shaft ->
   * neck -> head centre -> rim. parent[i] = the point the segment to i starts from. */
  private chain(p: Pose, S: V3, hand = 1): { pts: V3[]; parent: number[] } {
    const W = SWATTER.headW / 2 * 0.95, Hh = SWATTER.headH / 2 * 0.95;
    const neck = add(p.h, p.u, HAND.neck);
    const hw = handOnHandle(p.grip, p.r, p.hu, p.hn, hand);
    const pts: V3[] = [S, p.grip, add(p.grip, p.hn, 0.035), add(p.grip, p.hn, -0.035), add(p.grip, p.hu, 0.05), hw.wrist, add(hw.wrist, hw.fdir, 0.08)];
    const parent = [-1, 0, 1, 1, 1, 1, 5];
    let prev = 1;
    for (const t of [0.75, 0.45, 0.15]) { pts.push(wirePoint(p, t)); parent.push(prev); prev = pts.length - 1; }
    pts.push(neck); parent.push(prev);
    pts.push(p.h); parent.push(pts.length - 2);
    const hi = pts.length - 1;
    for (const [a, b] of [[W, 0], [-W, 0], [0, Hh], [0, -Hh], [W * 0.8, Hh * 0.8], [-W * 0.8, Hh * 0.8], [W * 0.8, -Hh * 0.8], [-W * 0.8, -Hh * 0.8]]) {
      pts.push(add(add(p.h, p.r, a), p.u, -b)); parent.push(hi);
    }
    return { pts, parent };
  }

  /** Deepest penetration of the swatter chain into the world: a segment of the chain that crosses a surface puts the
   * points beyond it inside or behind that object. Returns the depth (m) of the deepest such point behind the crossed
   * surface and that surface's normal (facing the free side). Segments leaving an object (exit faces) give no depth. */
  penetration(p: Pose, S: V3, off: V3 = v(), hand = 1): { depth: number; n: V3 } {
    const { pts: raw, parent } = this.chain(p, S, hand);
    const pts = raw.map((q, i) => (i === 0 ? q : add(q, off)));
    let depth = 0, nrm = v();
    const below = (i: number, j: number) => { for (let k = j; k >= 0; k = parent[k]) if (k === i) return true; return false; };
    for (let i = 1; i < pts.length; i++) {
      const a = pts[parent[i]], d = sub(pts[i], a), L = len(d);
      if (L < 1e-6) continue;
      const dn = v(d.x / L, d.y / L, d.z / L);
      let t = L, n = v();
      if (this.bvh.raycast(a.x, a.y, a.z, dn.x, dn.y, dn.z, L, hit, 15)) { t = hit.t; n = v(hit.nx, hit.ny, hit.nz); }
      const td = this.doorRay(a, dn, t);
      if (td < t) { t = td; n = v(-dn.x, -dn.y, -dn.z); }
      if (t >= L) continue;
      const hp = add(a, dn, t);
      for (let j = i; j < pts.length; j++) {
        if (!below(i, j)) continue;
        const dd = dot(sub(hp, pts[j]), n);
        if (dd > depth) { depth = dd; nrm = n; }
      }
    }
    return { depth, n: nrm };
  }

  /** Keep the shown swatter out of the world (D48 follow-up: it partly vanished into furniture and walls). The chain
   * shoulder-hand-shaft-head is tested for crossings; the whole swatter is pushed out along the crossed surface's
   * normal (a few iterations, deepest point first). Touching (<= 0.5 mm, e.g. the face flat on a wall at contact) is
   * allowed, and merely being hidden behind something (a chair back) is not a fault. The correction is applied at once
   * and released smoothly - but only as far as the swatter stays clear: a correction that is still needed is kept.
   * Letting it go every frame and pushing out again made the swatter shake against furniture and in corners (up to
   * 13 cm per frame at a cupboard top, where the push-out alternated between the top and the front face). */
  private corr = v();
  private lastIn: V3 | null = null;
  private restK = -1; private restT = 0;
  resolve(p: Pose, c: CamFrame, hand: number, dt: number, resting = false): Pose {
    const { fwd, right } = bodyFrame(c.f, c.r);
    const S = shoulderAt(c.eye, fwd, right, hand);
    // release at most 18 cm/s, and only the part of it that leaves the swatter clear; push out just to the surface, so
    // a slowly moving pose (breathing) is followed smoothly instead of in steps of tolerance + margin
    const tol = 0.0005;
    const cl = len(this.corr), rel = cl < 1e-6 ? 0 : Math.min(1 - Math.exp(-dt / 0.08), 0.18 * dt / cl);
    // (with 1 cm to spare in that direction: letting go right up to the object made the swatter creep along its edge,
    // where the crossing test flips, and it was pushed back in small jolts)
    let off = this.corr;
    for (const k of [1, 0.5, 0.25]) {
      const cand = lerp3(this.corr, v(), rel * k), spare = lerp3(this.corr, v(), Math.min(1, rel * k + 0.01 / Math.max(cl, 1e-6)));
      if (this.penetration(p, S, cand, hand).depth <= tol && this.penetration(p, S, spare, hand).depth <= tol) { off = cand; break; }
    }
    for (let it = 0; it < 6; it++) {
      const { depth, n } = this.penetration(p, S, off, hand);
      if (depth <= tol) break;
      off = add(off, n, depth + tol);
    }
    // the resting swatter takes a new correction in at most 2 cm per frame plus twice its own motion: at an edge the
    // crossing test can flip, and a sudden 15 cm jump of a swatter held still reads as a glitch (in a swing the
    // correction applies at once: the head must never be seen inside a table it sweeps past)
    const moved = this.lastIn ? len(sub(p.h, this.lastIn)) : 1;
    this.lastIn = p.h;
    const dOff = sub(off, this.corr), dl = len(dOff), lim = 0.02 + 2 * moved;
    if (resting && dl > lim) off = add(this.corr, dOff, lim / dl);
    this.corr = len(off) < 1e-5 ? v() : off;
    if (len(this.corr) < 1e-5) return p;
    return finishPose(add(p.h, this.corr), p.n, p.u, p.flex);
  }

  private poseAt(s: Swing, t: number, rest: Pose): Pose {
    if (t <= s.tContact || !s.contact) return this.planned(s, Math.min(t, s.tContact));
    const ta = t - s.tContact;
    if (!s.contact.air) {
      // material reaction: tiny rebound bounce then recover
      if (ta < 0.05) return blend(s.target, s.after, Math.sin(ta / 0.05 * Math.PI / 2) * 0.8);
      if (ta < 0.13) return blend(s.after, s.target, (ta - 0.05) / 0.08 * 0.35);
    } else if (ta < 0.1) {
      return blend(s.target, s.after, smooth(ta / 0.1));
    }
    const k = smooth(Math.min(1, (ta - (s.contact.air ? 0.1 : 0.13)) / (s.tEnd - s.tContact - (s.contact.air ? 0.1 : 0.13))));
    return blend(s.contact.air ? s.after : blend(s.after, s.target, 0.35), rest, k);
  }

  /** Continuous collision of head rim/face and shaft between two poses. Earliest contact wins. */
  private sweep(p0: Pose, p1: Pose, mosq: MosquitoTarget[], t0: number, t1: number): ContactInfo | null {
    let best = 1.01; let bestInfo: ContactInfo | null = null;
    const W = SWATTER.headW / 2, Hh = SWATTER.headH / 2;
    // sample rim + face points (local u along r, w along head up axis (-u))
    const samples: [number, number][] = [[0, 0], [W, 0], [-W, 0], [0, Hh], [0, -Hh], [W * 0.8, Hh * 0.8], [-W * 0.8, Hh * 0.8], [W * 0.8, -Hh * 0.8], [-W * 0.8, -Hh * 0.8], [W * 0.5, 0], [-W * 0.5, 0]];
    const dtS = t1 - t0;
    const speed = len(sub(p1.h, p0.h)) / Math.max(1e-6, dtS);
    for (const [a, b] of samples) {
      const q0 = add(add(p0.h, p0.r, a), p0.u, -b), q1 = add(add(p1.h, p1.r, a), p1.u, -b);
      const d = sub(q1, q0), l = len(d);
      if (l < 1e-7) continue;
      const dn = v(d.x / l, d.y / l, d.z / l);
      // start slightly behind the face to avoid missing grazing contacts
      if (this.bvh.raycast(q0.x, q0.y, q0.z, dn.x, dn.y, dn.z, l + SWATTER.headT, hit, 1 | 2 | 4 | 8)) {
        const f = Math.max(0, (hit.t - SWATTER.headT) / l);
        if (f < best) {
          best = f;
          bestInfo = { t: t0 + dtS * f, point: add(q0, dn, hit.t), normal: v(hit.nx, hit.ny, hit.nz), cls: this.bvh.cls[hit.tri], kind: this.bvh.kind[hit.tri], speed, mosquito: -1, air: false, door: false };
        }
      }
      const dd = this.doorRay(q0, dn, l + SWATTER.headT);
      if (dd < l + SWATTER.headT) {
        const f = Math.max(0, (dd - SWATTER.headT) / l);
        if (f < best) { best = f; bestInfo = { t: t0 + dtS * f, point: add(q0, dn, dd), normal: v(-dn.x, -dn.y, -dn.z), cls: 1, kind: 0, speed, mosquito: -1, air: false, door: true }; }
      }
    }
    // shaft points (neck and mid-shaft) may catch edges first
    for (const t of [0.2, 0.55]) {
      const q0 = wirePoint(p0, t), q1 = wirePoint(p1, t);
      const d = sub(q1, q0), l = len(d);
      if (l < 1e-7) continue;
      const dn = v(d.x / l, d.y / l, d.z / l);
      if (this.bvh.raycast(q0.x, q0.y, q0.z, dn.x, dn.y, dn.z, l, hit, 1 | 4 | 8)) {
        const f = hit.t / l;
        if (f < best) { best = f; bestInfo = { t: t0 + dtS * f, point: add(q0, dn, hit.t), normal: v(hit.nx, hit.ny, hit.nz), cls: this.bvh.cls[hit.tri], kind: this.bvh.kind[hit.tri], speed: speed * 0.7, mosquito: -1, air: false, door: false }; }
      }
    }
    // mosquitoes: swept face plane crossing within rectangle (+ MOSQ_R), before world contact
    for (const m of mosq) {
      if (!m.alive) continue;
      // signed distance in front of the striking face at both ends of the substep
      const s0 = dot(sub(m.prev, p0.h), p0.n), s1 = dot(sub(m.pos, p1.h), p1.n);
      if (s0 < -MOSQ_R || s1 > MOSQ_R) continue;          // already behind at start, or not reached yet
      const alpha = Math.abs(s0 - s1) < 1e-9 ? 0 : Math.min(1, Math.max(0, (s0 - MOSQ_R) / (s0 - s1)));
      if (alpha > best + 1e-4) continue; // wall/obstacle reached first
      const pc = blend(p0, p1, alpha);
      const mp = lerp3(m.prev, m.pos, alpha);
      const rel = sub(mp, pc.h);
      const a = dot(rel, pc.r), b = -dot(rel, pc.u);
      const inside = Math.abs(a) <= W + MOSQ_R && Math.abs(b) <= Hh + MOSQ_R && Math.abs(dot(rel, pc.n)) <= MOSQ_R * 2.2;
      if (inside) {
        best = Math.min(best, alpha);
        bestInfo = { t: t0 + dtS * alpha, point: mp, normal: m.resting ? m.nrm : v(-pc.n.x, -pc.n.y, -pc.n.z), cls: -1, kind: -1, speed, mosquito: m.idx, air: !m.resting, door: false };
      }
    }
    if (bestInfo && bestInfo.mosquito < 0 && !bestInfo.air) {
      // world contact: squash resting mosquitoes under the head footprint at contact
      const pc = blend(p0, p1, best);
      for (const m of mosq) {
        if (!m.alive || !m.resting) continue;
        const rel = sub(m.pos, pc.h);
        if (Math.abs(dot(rel, pc.n)) > 0.03) continue;
        const a = dot(rel, pc.r), b = -dot(rel, pc.u);
        if (Math.abs(a) <= W + MOSQ_R * 0.5 && Math.abs(b) <= Hh + MOSQ_R * 0.5) { bestInfo.mosquito = m.idx; break; }
      }
    }
    return bestInfo;
  }
}

function smooth(t: number) { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t); }

export function blend(a: Pose, b: Pose, t: number): Pose {
  const h = lerp3(a.h, b.h, t), n = norm(lerp3(a.n, b.n, t)), u = norm(lerp3(a.u, b.u, t));
  return finishPose(h, n, u, a.flex + (b.flex - a.flex) * t);
}
