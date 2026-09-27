// Geometry of the first-person arm (no Babylon dependency, unit-tested): one continuous knitted sleeve from the
// cuff at the wrist over the bent elbow to the shoulder socket inside the torso, plus the torso itself. The sleeve
// is rebuilt every frame on a fixed topology (rings x segments) so it bends with the arm instead of being two rigid
// tubes that end in the air (D48).
export type P3 = { x: number; y: number; z: number };
const v = (x = 0, y = 0, z = 0): P3 => ({ x, y, z });
const add = (a: P3, b: P3, s = 1): P3 => v(a.x + b.x * s, a.y + b.y * s, a.z + b.z * s);
const sub = (a: P3, b: P3): P3 => v(a.x - b.x, a.y - b.y, a.z - b.z);
const dot = (a: P3, b: P3) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: P3, b: P3): P3 => v(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
const len = (a: P3) => Math.hypot(a.x, a.y, a.z);
const norm = (a: P3): P3 => { const l = len(a) || 1; return v(a.x / l, a.y / l, a.z / l); };
const smooth = (e0: number, e1: number, x: number) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };

/** Body proportions (m), average adult; relative to the eye in the body frame (right, up, back). */
export const BODY = {
  upper: 0.30, fore: 0.27,
  /** shoulder joint (humeral head) relative to the eye: right, down, back. Eye 1.62 m ~ stature 1.73 m: acromion
   * ~1.43 m, joint centre ~4 cm below it */
  shoulder: { r: 0.19, d: 0.21, b: 0.06 },
  /** the shoulder may come forward this far (protraction) toward a far wrist before the forearm has to stretch */
  protract: 0.09,
};

/** Largest shoulder-wrist distance used when planning a swat: the elbow stays a little bent (~150 deg); the arm is
 * never stretched beyond its length - a target further away needs a lean or a step (D48). */
export const ARM_PLAN_MAX = 0.55;

/** Hand model landmarks in the swatter-handle frame (Blender: x = r, y = handle toward the grip end, z = palm/face
 * normal), from arm.glb (hand.py). ArmVisual overwrites them with the values stored in the file at load. */
export const HAND = {
  wrist: { x: -0.0789, y: 0.0293, z: -0.0225 },
  forearm: { x: -0.9393, y: 0.3281, z: 0.0997 },
  gripFromHead: 0.4005, neck: 0.0805,
};

/** Comfortable wrist range (deg): flexion/extension and radial/ulnar deviation; forearm roll (pronation/supination)
 * from thumb-up neutral. Adult ROM is about 70/70, 20/35 and 85/85; planning keeps inside these. */
export const WRIST = { ext: 65, dev: 30, roll: 80 };

/** Horizontal body frame (follows the view yaw, not the pitch). */
export function bodyFrame(f: P3, r: P3): { fwd: P3; right: P3 } {
  return { fwd: norm(v(f.x, 0, f.z)), right: norm(v(r.x, 0, r.z)) };
}

/** Shoulder joint (world) for an eye position. */
export function shoulderAt(eye: P3, fwd: P3, right: P3, hand: number): P3 {
  const s = BODY.shoulder;
  return v(eye.x + right.x * s.r * hand - fwd.x * s.b, eye.y - s.d, eye.z + right.z * s.r * hand - fwd.z * s.b);
}

/** Preferred elbow direction: down and out to the hand side. */
export function armPole(right: P3, hand: number): P3 { return v(right.x * 0.6 * hand, -1, right.z * 0.6 * hand); }

/** Hand frame on the swatter (D48): the hand model holds the handle in a hammer grip (handle across the fist, ~110 deg
 * to the forearm); the striking face points along the fist's X axis - the direction the forearm points - as with a
 * hammer, so a wall straight ahead is hit with a nearly straight wrist. (Until D48 the face pointed out of the palm,
 * which forced ~90 deg wrist bends.) Hand model axes in world: X = hn (flexed face normal), Y = handle (hu, toward
 * the grip end), palm normal = -r (mirrored for the left hand). */
export function handAxes(r: P3, hn: P3, hand: number): { x: P3; palm: P3 } {
  return { x: hn, palm: v(-r.x * hand, -r.y * hand, -r.z * hand) };
}

/** Wrist position and neutral forearm direction (toward the elbow) of the hand model on a handle frame. */
export function handOnHandle(grip: P3, r: P3, hu: P3, hn: P3, hand: number): { wrist: P3; fdir: P3; palm: P3 } {
  const w = HAND.wrist, F = HAND.forearm;
  const { x: X, palm: Z } = handAxes(r, hn, hand);
  const wrist = v(grip.x + X.x * w.x + hu.x * w.y + Z.x * w.z, grip.y + X.y * w.x + hu.y * w.y + Z.y * w.z, grip.z + X.z * w.x + hu.z * w.y + Z.z * w.z);
  const fdir = norm(v(X.x * F.x + hu.x * F.y + Z.x * F.z, X.y * F.x + hu.y * F.y + Z.y * F.z, X.z * F.x + hu.z * F.y + Z.z * F.z));
  return { wrist, fdir, palm: Z };
}

/** Wrist and forearm angles (deg) of a hand whose neutral forearm direction is fdir and palm normal palm, on an arm
 * with the given joints. ext/dev: bend of the hand against the real forearm axis; roll: palm around the forearm
 * from thumb-up neutral (0 = palm facing the body midline, +-90 = palm up/down). */
export function wristAngles(fdir: P3, palm: P3, wrist: P3, elbow: P3, shoulder: P3, hand: number): { ext: number; dev: number; roll: number } {
  const a = norm(sub(elbow, wrist));
  const z = norm(sub(palm, v(fdir.x * dot(palm, fdir), fdir.y * dot(palm, fdir), fdir.z * dot(palm, fdir))));
  const x = cross(fdir, z);
  const deg = 180 / Math.PI;
  const ext = Math.atan2(dot(a, z), dot(a, fdir)) * deg;
  const dev = Math.atan2(dot(a, x), dot(a, fdir)) * deg;
  // roll: palm normal projected on the plane across the forearm, against the medial normal of the arm plane
  const fore = norm(sub(wrist, elbow)), upper = norm(sub(elbow, shoulder));
  let m = cross(upper, fore);
  const ml = len(m);
  if (ml < 0.05) return { ext, dev, roll: 0 };                  // straight arm: roll not defined, free
  m = v(-m.x / ml * hand, -m.y / ml * hand, -m.z / ml * hand);
  const pp = norm(sub(palm, v(fore.x * dot(palm, fore), fore.y * dot(palm, fore), fore.z * dot(palm, fore))));
  const roll = Math.atan2(dot(cross(m, pp), fore), dot(m, pp)) * deg;
  return { ext, dev, roll };
}

export const SLEEVE = { rings: 64, seg: 24, lip: 3 };

/** Dense centre line through a start point with a fixed start tangent, then corners rounded with quadratic Béziers. */
function roundedPath(pts: P3[], radii: number[]): { p: P3[]; corner: number[] } {
  const out: P3[] = [pts[0]];
  const corner: number[] = [];
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1], b = pts[i], c = pts[i + 1];
    const la = len(sub(b, a)), lc = len(sub(c, b));
    const rr = Math.min(radii[i - 1] ?? 0.05, la * 0.45, lc * 0.45);
    const q0 = add(b, norm(sub(a, b)), rr), q1 = add(b, norm(sub(c, b)), rr);
    // straight part up to q0
    const prev = out[out.length - 1];
    const ns = Math.max(1, Math.ceil(len(sub(q0, prev)) / 0.008));
    for (let k = 1; k <= ns; k++) out.push(add(prev, sub(q0, prev), k / ns));
    const nb = 10;
    for (let k = 1; k <= nb; k++) {
      const t = k / nb, u = 1 - t;
      out.push(v(u * u * q0.x + 2 * u * t * b.x + t * t * q1.x, u * u * q0.y + 2 * u * t * b.y + t * t * q1.y, u * u * q0.z + 2 * u * t * b.z + t * t * q1.z));
      if (k === nb / 2) corner.push(out.length - 1);
    }
  }
  const prev = out[out.length - 1], end = pts[pts.length - 1];
  const ns = Math.max(1, Math.ceil(len(sub(end, prev)) / 0.008));
  for (let k = 1; k <= ns; k++) out.push(add(prev, sub(end, prev), k / ns));
  return { p: out, corner };
}

export interface ArmJoints { cuff: P3; elbow: P3; shoulder: P3; socket: P3; bend: number; }

/** Two-bone arm from the wrist (world) to a body-fixed shoulder socket. fdir = forearm direction of the hand model at
 * the wrist (toward the elbow); pole = preferred elbow direction (down and outward). */
export function solveArm(wrist: P3, fdir: P3, socket: P3, pole: P3): ArmJoints {
  const cuff = add(wrist, fdir, 0.015);
  // shoulder comes forward (protraction) toward a far wrist, up to BODY.protract
  const reach = BODY.upper + BODY.fore;
  let d = sub(wrist, socket);
  const over = Math.max(0, len(d) - reach * 0.97);
  const shoulder = add(socket, norm(d), Math.min(BODY.protract, over));
  d = sub(wrist, shoulder);
  const L = Math.min(len(d), reach - 0.001);
  const dir = norm(d);
  const a = (BODY.upper * BODY.upper - BODY.fore * BODY.fore + L * L) / (2 * L);
  const h = Math.sqrt(Math.max(0, BODY.upper * BODY.upper - a * a));
  let pl = sub(pole, v(dir.x * dot(pole, dir), dir.y * dot(pole, dir), dir.z * dot(pole, dir)));
  pl = len(pl) > 1e-6 ? norm(pl) : norm(cross(dir, v(0, 1, 0)));
  const elbow = add(add(shoulder, dir, a), pl, h);
  const bend = Math.acos(Math.max(-1, Math.min(1, dot(norm(sub(elbow, wrist)), norm(sub(shoulder, elbow))))));
  return { cuff, elbow, shoulder, socket, bend };
}

/** Rotate a vector about a unit axis (Rodrigues). */
function rotateAbout(p: P3, k: P3, a: number): P3 {
  const c = Math.cos(a), s = Math.sin(a), kd = dot(k, p), kx = cross(k, p);
  return v(p.x * c + kx.x * s + k.x * kd * (1 - c), p.y * c + kx.y * s + k.y * kd * (1 - c), p.z * c + kx.z * s + k.z * kd * (1 - c));
}

/** Sleeve radii used for the arm's clearance test (upper arm, forearm, shoulder), m. */
export const ARM_CLEAR = { upper: 0.055, fore: 0.045, shoulder: 0.065, tolerance: 0.004 };

/** Elbow direction that keeps the arm out of walls and furniture (REVIEW-01 G-10: with a wall at the right the elbow
 * went up to 22 cm into it). The preferred pole is swivelled about the shoulder-wrist axis, a little more each try and
 * both ways, until upper arm and forearm are clear; otherwise the least penetrating pose. depth(a, b, r) = how far a
 * capsule from a to b with radius r reaches into the world (0 = clear). */
export function clearArmPole(wrist: P3, fdir: P3, socket: P3, pole: P3, depth: (a: P3, b: P3, r: number) => number): P3 {
  const cost = (p: P3) => { const j = solveArm(wrist, fdir, socket, p); return depth(j.shoulder, j.elbow, ARM_CLEAR.upper) + depth(j.elbow, j.cuff, ARM_CLEAR.fore); };
  let bestD = cost(pole);
  if (bestD <= ARM_CLEAR.tolerance) return pole;
  const axis = norm(sub(wrist, socket));
  let best = pole;
  for (const deg of [25, -25, 50, -50, 75, -75, 100, -100, 130, -130, 160, -160]) {
    const p = rotateAbout(pole, axis, deg * Math.PI / 180);
    const d = cost(p);
    if (d < bestD - 1e-4) { bestD = d; best = p; if (d <= ARM_CLEAR.tolerance) break; }
  }
  return best;
}

/** Radius of the sleeve (m) at arc length s; sE / sS = arc length at elbow / shoulder. */
export function sleeveRadius(s: number, sE: number, sS: number): number {
  // ribbed cuff (0-5 cm) hugging the wrist, the sleeve body blousing a little over it, forearm, elbow, upper arm
  // adult forearm ~27 cm and upper arm ~31 cm circumference, plus the ease of a loose knitted jumper
  const cuff = 0.037, fore = 0.050, elbow = 0.053, upper = 0.059, sh = 0.065;
  let r: number;
  if (s < 0.05) r = cuff + 0.001 * smooth(0, 0.05, s);
  else if (s < sE) r = cuff + 0.004 + (fore - cuff - 0.004) * smooth(0.05, 0.05 + (sE - 0.05) * 0.45, s) + (elbow - fore) * smooth(sE - 0.1, sE, s);
  else if (s < sS) r = elbow + (upper - elbow) * smooth(sE, sE + 0.12, s) + (sh - upper) * smooth(sS - 0.1, sS, s);
  else r = sh;
  // blousing bulge just above the cuff
  r += 0.004 * Math.exp(-(((s - 0.062) / 0.018) ** 2));
  return r;
}

export interface TubeBuffers { positions: Float32Array; normals: Float32Array; uvs: Float32Array; indices: Uint32Array; }

/** Allocate buffers for the fixed sleeve topology (cuff inner lip rings + body rings). */
export function allocSleeve(): TubeBuffers {
  const R = SLEEVE.rings + SLEEVE.lip, S = SLEEVE.seg + 1;       // seam duplicated for the texture
  const idx: number[] = [];
  for (let j = 0; j < R - 1; j++) for (let i = 0; i < SLEEVE.seg; i++) {
    const a = j * S + i, b = a + 1, c = a + S, d = c + 1;
    idx.push(a, c, b, b, c, d);
  }
  return { positions: new Float32Array(R * S * 3), normals: new Float32Array(R * S * 3), uvs: new Float32Array(R * S * 2), indices: new Uint32Array(idx) };
}

/** Knit texture scale: one tile = 8 stitches (4.5 mm) wide, 8 rows (3.6 mm) high. */
const TILE_U = 0.036, TILE_V = 0.029;

/** Fill the sleeve buffers for the given joints. refUp: a direction roughly across the forearm (e.g. the back of the
 * hand) that fixes the twist of the cross-section frame at the cuff. Returns the centre-line length. */
export function buildSleeve(b: TubeBuffers, j: ArmJoints, fdir: P3, refUp: P3): number {
  // centre line: cuff -> straight along the hand's forearm axis (covers the stump of the hand model) -> elbow ->
  // (protracted) shoulder -> socket -> into the torso
  const pre = add(j.cuff, fdir, 0.06);
  const inward = norm(sub(j.socket, j.shoulder));
  const beyond = len(sub(j.socket, j.shoulder)) > 0.005 ? add(j.socket, inward, 0.07) : add(j.socket, norm(sub(j.socket, j.elbow)), 0.07);
  const ctrl = [j.cuff, pre, j.elbow, j.shoulder, beyond];
  if (len(sub(j.socket, j.shoulder)) > 0.005) ctrl.splice(4, 0, j.socket);
  const path = roundedPath(ctrl, [0.05, 0.075, 0.05, 0.05]);
  const dense = path.p;
  const cum = [0];
  for (let i = 1; i < dense.length; i++) cum.push(cum[i - 1] + len(sub(dense[i], dense[i - 1])));
  const total = cum[cum.length - 1];
  const sE = cum[path.corner[1] ?? Math.floor(dense.length / 2)];
  const sS = cum[path.corner[2] ?? dense.length - 1];
  // bend plane: inside of the elbow
  const dA = norm(sub(j.elbow, pre)), dB = norm(sub(j.shoulder, j.elbow));
  const inner = norm(sub(dB, dA));
  const N = SLEEVE.rings, S = SLEEVE.seg, L = SLEEVE.lip, W = S + 1;
  // resample: rings denser near the elbow (folds) - map u in [0,1] -> s with extra density around sE
  const ringS: number[] = [];
  for (let k = 0; k < N; k++) ringS.push(total * (k / (N - 1)));
  // positions along the dense line by arc length
  let di = 0;
  const at = (s: number): [P3, P3] => {
    while (di < dense.length - 2 && cum[di + 1] < s) di++;
    while (di > 0 && cum[di] > s) di--;
    const t = (s - cum[di]) / Math.max(1e-9, cum[di + 1] - cum[di]);
    return [add(dense[di], sub(dense[di + 1], dense[di]), t), norm(sub(dense[Math.min(dense.length - 1, di + 1)], dense[di]))];
  };
  // parallel-transport frame
  let [, t0] = at(0);
  let n0 = sub(refUp, v(t0.x * dot(refUp, t0), t0.y * dot(refUp, t0), t0.z * dot(refUp, t0)));
  n0 = len(n0) > 1e-6 ? norm(n0) : norm(cross(t0, v(0, 1, 0)));
  const P = b.positions, UV = b.uvs;
  const bend = Math.min(1, j.bend / 1.6);
  const ring = (row: number, c: P3, T: P3, Nn: P3, r: number, s: number, lipK: number) => {
    const B = cross(T, Nn);
    for (let i = 0; i <= S; i++) {
      const th = (i % S) / S * Math.PI * 2;
      const ct = Math.cos(th), st = Math.sin(th);
      const dirv = add(v(Nn.x * ct, Nn.y * ct, Nn.z * ct), B, st);
      let rr = r * (1 + 0.06 * ct * ct - 0.03);                    // slightly flattened (forearm is wider than deep)
      if (lipK === 0) {
        // folds: soft diagonal wrinkles everywhere, compression folds on the inside of the bent elbow
        const gen = Math.sin(s * 52 + 1.8 * Math.sin(th * 2 + s * 11)) * (0.5 + 0.5 * Math.sin(th * 3 + s * 17));
        const wEl = Math.exp(-(((s - sE) / 0.075) ** 2)) * Math.max(0, dot(dirv, inner)) ** 1.5 * bend;
        const outer = Math.exp(-(((s - sE) / 0.06) ** 2)) * Math.max(0, -dot(dirv, inner)) * bend;
        const cuffRib = s < 0.05 ? 0.0006 * Math.cos(th * 36) : 0;
        rr += 0.0016 * gen * (1 - outer) + 0.0055 * wEl * Math.sin((s - sE) * 110 + th * 0.8) + cuffRib;
        // gravity: the loose upper sleeve sags a little
        rr += 0.002 * smooth(sE, sS, s) * Math.max(0, -dirv.y);
      }
      const p = add(c, dirv, rr);
      const o = (row * W + i) * 3;
      P[o] = p.x; P[o + 1] = p.y; P[o + 2] = p.z;
      const q = (row * W + i) * 2;
      UV[q] = (i / S) * (2 * Math.PI * 0.045) / TILE_U; UV[q + 1] = s / TILE_V;
    }
  };
  // cuff inner lip: from inside the cuff out to its rolled edge
  const [c0] = at(0);
  for (let l = 0; l < L; l++) {
    const k = l / L;                                              // 0 = deepest inside
    const s = 0.035 * (1 - k);
    const [c] = at(s);
    const r = sleeveRadius(0, sE, sS) - 0.004 - 0.002 * (1 - k);
    ring(l, l === L - 1 ? add(c0, t0, -0.002) : c, t0, n0, r, s, 1);
  }
  let Nn = n0, Tprev = t0;
  for (let k = 0; k < N; k++) {
    const s = ringS[k];
    const [c, T] = at(s);
    // transport the normal: remove its component along the new tangent
    const rot = sub(Nn, v(T.x * dot(Nn, T), T.y * dot(Nn, T), T.z * dot(Nn, T)));
    Nn = len(rot) > 1e-6 ? norm(rot) : Nn;
    Tprev = T;
    ring(L + k, c, T, Nn, sleeveRadius(s, sE, sS), s, 0);
  }
  void Tprev;
  gridNormals(b, L + N, W);
  return total;
}

/** Vertex normals of a (rows x cols) grid, seam columns shared. Inner lip rows face inward automatically. */
function gridNormals(b: TubeBuffers, rows: number, cols: number) {
  const P = b.positions, Nn = b.normals;
  const S = cols - 1;
  const g = (r: number, c: number): P3 => { const o = (r * cols + c) * 3; return v(P[o], P[o + 1], P[o + 2]); };
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const cc = c % S;
    const du = sub(g(r, (cc + 1) % S), g(r, (cc - 1 + S) % S));
    const dv = sub(g(Math.min(rows - 1, r + 1), cc), g(Math.max(0, r - 1), cc));
    const n = norm(cross(du, dv));
    const o = (r * cols + c) * 3;
    Nn[o] = n.x; Nn[o + 1] = n.y; Nn[o + 2] = n.z;
  }
}

/** Torso (knitted jumper) in the body frame: x right, y up, z BACK, origin at the eye. Built once. */
export function buildTorso(): TubeBuffers {
  // horizontal slices: [y below the eye, half width, half depth, centre z (back)]
  const sl: [number, number, number, number][] = [
    [-0.165, 0.05, 0.05, 0.09], [-0.18, 0.12, 0.075, 0.09], [-0.205, 0.185, 0.095, 0.085], [-0.25, 0.215, 0.108, 0.08],
    [-0.32, 0.21, 0.116, 0.078], [-0.42, 0.18, 0.118, 0.078], [-0.55, 0.165, 0.114, 0.08], [-0.75, 0.16, 0.11, 0.085], [-1.0, 0.165, 0.11, 0.09],
  ];
  const S = 40, W = S + 1, R = sl.length * 3;
  const rows: [number, number, number, number][] = [];
  // interpolate 3 rows per slice interval (smooth-step) for a rounder silhouette
  for (let i = 0; i < sl.length - 1; i++) for (let k = 0; k < 3; k++) {
    const t = k / 3, a = sl[i], bb = sl[i + 1];
    const m = (x: number, y: number) => x + (y - x) * t;
    rows.push([m(a[0], bb[0]), m(a[1], bb[1]), m(a[2], bb[2]), m(a[3], bb[3])]);
  }
  rows.push(sl[sl.length - 1]);
  const n = rows.length;
  const pos = new Float32Array((n + 1) * W * 3), nor = new Float32Array((n + 1) * W * 3), uv = new Float32Array((n + 1) * W * 2);
  // top cap row collapses to the neck centre (hidden under the chin)
  for (let i = 0; i <= S; i++) {
    const o = i * 3; pos[o] = 0; pos[o + 1] = -0.16; pos[o + 2] = 0.09;
  }
  for (let r = 0; r < n; r++) {
    const [y, a, d, cz] = rows[r];
    for (let i = 0; i <= S; i++) {
      const th = (i % S) / S * Math.PI * 2;
      const c = Math.cos(th), s = Math.sin(th);
      const e = 2 / 2.6;                                        // superellipse: boxy chest
      const x = Math.sign(c) * Math.abs(c) ** e * a;
      let z = cz - Math.sign(s) * Math.abs(s) ** e * d;           // s > 0: front (negative z = forward)
      // soft horizontal folds of the jumper on the belly
      z += (s > 0 ? 1 : 0) * 0.002 * Math.sin(y * 70 + x * 20);
      const o = ((r + 1) * W + i) * 3;
      pos[o] = x; pos[o + 1] = y; pos[o + 2] = z;
      const q = ((r + 1) * W + i) * 2;
      uv[q] = (i / S) * 1.0 / TILE_U; uv[q + 1] = -y / TILE_V;
    }
  }
  const idx: number[] = [];
  for (let r = 0; r < n; r++) for (let i = 0; i < S; i++) {
    const a0 = r * W + i, b0 = a0 + 1, c0 = a0 + W, d0 = c0 + 1;
    idx.push(a0, b0, c0, b0, d0, c0);
  }
  const buf: TubeBuffers = { positions: pos, normals: nor, uvs: uv, indices: new Uint32Array(idx) };
  gridNormals(buf, n + 1, W);
  for (let i = 0; i <= S; i++) { nor[i * 3] = 0; nor[i * 3 + 1] = 1; nor[i * 3 + 2] = 0; }     // neck cap (under the chin)
  // orientation of the grid normals depends on the winding: make them point away from the torso axis
  for (let k = 0; k < pos.length / 3; k++) {
    const ox = pos[k * 3], oz = pos[k * 3 + 2] - 0.085;
    if (nor[k * 3] * ox + nor[k * 3 + 2] * oz < 0) { nor[k * 3] *= -1; nor[k * 3 + 1] *= -1; nor[k * 3 + 2] *= -1; }
  }
  void R;
  return buf;
}

/** Knit (stockinette) normal map and heather albedo, size x size RGBA, 8 x 8 stitches per tile. */
export function knitTextures(size = 128): { normal: Uint8Array; albedo: Uint8Array } {
  const h = new Float32Array(size * size);
  let seed = 7;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const fib = new Float32Array(size * size).map(() => rnd());
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = (x / size) * 8, w = (y / size) * 8;
    const cu = u - Math.floor(u), cv = w - Math.floor(w);
    // two legs of the V: left leg from (0.05,0)->(0.5,1), right leg (0.95,0)->(0.5,1)
    const legL = Math.abs((cu - 0.05) - 0.45 * cv), legR = Math.abs((0.95 - cu) - 0.45 * cv);
    const leg = Math.min(legL, legR);
    let hh = Math.exp(-((leg / 0.17) ** 2)) * (0.75 + 0.25 * Math.sin(cv * Math.PI));
    hh *= 0.85 + 0.3 * fib[y * size + x] * 0.5;
    h[y * size + x] = hh;
  }
  const normal = new Uint8Array(size * size * 4), albedo = new Uint8Array(size * size * 4);
  const H = (x: number, y: number) => h[((y + size) % size) * size + ((x + size) % size)];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const dx = (H(x + 1, y) - H(x - 1, y)) * 2.2, dy = (H(x, y + 1) - H(x, y - 1)) * 2.2;
    const l = Math.hypot(dx, dy, 1);
    const o = (y * size + x) * 4;
    normal[o] = Math.round((-dx / l * 0.5 + 0.5) * 255); normal[o + 1] = Math.round((-dy / l * 0.5 + 0.5) * 255); normal[o + 2] = Math.round((1 / l * 0.5 + 0.5) * 255); normal[o + 3] = 255;
    // heather: fibres of slightly different tone, grooves darker
    const f = fib[y * size + x];
    const k = 0.8 + 0.2 * H(x, y) + (f - 0.5) * 0.1;
    albedo[o] = Math.round(Math.min(255, 255 * k * (0.98 + (f > 0.8 ? 0.06 : 0)))); albedo[o + 1] = Math.round(Math.min(255, 255 * k)); albedo[o + 2] = Math.round(Math.min(255, 255 * k * 1.01)); albedo[o + 3] = 255;
  }
  return { normal, albedo };
}
