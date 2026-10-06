// Curtains that give when slapped (user feedback 06-10-2026: the curtains should look more natural and move when you
// hit them; they stopped the swatter like a wall). Each gathered panel hangs from its rod as a sheet: pinned at the top,
// free at the hem. Its motion across the wall (toward it and away) and along it follows the hanging-chain equation -
// the tension at a height is the weight of the fabric below it, so the hem swings most and the panel's own pendulum
// period comes out of its length - plus a little stiffness across the panel, the springiness of the folds and air drag.
// A slap hands part of the swatter's speed to the fabric under its head, the wall behind stops it and the panel dents,
// swings and settles within a few seconds; a body brushing past moves it along. Every vertex of the pleated mesh moves
// with the panel's displacement at its place: swinging out all alike, pressed toward the wall the folds flatten - each
// point by its share of the folds' depth, so nothing goes behind the wall and the fabric's two faces (the mesh is a
// shell ~3 mm thick) never cross or meet (a hard stop at the wall put them in one plane: dark stripes).
// Pure logic (no Babylon): curtains.ts binds the meshes, core.ts advances it every frame, session.ts slaps it. Tuning
// values are game values (estimates, to confirm by eye), not measured cloth properties.

export interface V3 { x: number; y: number; z: number }

export const CLOTH = {
  /** gravity: the tension at a height is g times the fabric's length below it (per unit mass) */
  g: 9.81,
  /** stiffness across the panel (m^2/s^2): neighbouring columns pull each other along */
  across: 0.5,
  /** springiness of the gathered folds toward their hanging shape (1/s^2) */
  spring: 3.0,
  /** air drag (1/s); a hem lying on the floor drags more */
  drag: 2.0, hemDrag: 8,
  /** share of the swatter's speed (toward the wall / along it) the fabric under the head takes up, and the share the
   * panel below the slap takes up as a whole (it swings) */
  take: 0.9, takeAlong: 0.3, sway: 0.12,
  /** radius (m) of the slapped area: about the swatter head */
  sigma: 0.08,
  /** pressed against the wall the fabric springs back with this share of its speed */
  bounce: 0.25,
  /** how far (share of the panel's depth, the front of its folds to the wall) the fabric can be pressed in at most */
  press: 0.7,
  /** grid spacing (m) and simulation sub-step (s) */
  dy: 0.08, dx: 0.05, step: 1 / 240,
  /** a panel whose displacement and speed stay below these everywhere for `settle` s is at rest again */
  still: 0.0004, stillV: 0.004, settle: 0.4,
  /** shading of the moving fabric: light mostly from the room in front and above; the shadowed share; pressed flat
   * against the wall the fabric darkens by up to `pressDark` */
  light: 0.35, ambient: 0.45, pressDark: 0.18,
};

const dot = (a: V3, b: V3) => a.x * b.x + a.y * b.y + a.z * b.z;

/** One gathered panel hanging from its rod. N: the wall's normal toward the room (horizontal); U = up x N runs along
 * the wall. Coordinates on the panel: u = p.U, y = height, n = p.N. */
export class CurtainPanel {
  readonly U: V3;
  /** n of the wall plane behind the panel (the back of its folds) and the depth of the folds (m) */
  readonly back: number; readonly depth: number;
  readonly u0: number; readonly u1: number; readonly top: number; readonly bottom: number;
  readonly cols: number; readonly rows: number;
  /** the hem lies on the floor (floor-length curtain): it drags */
  readonly onFloor: boolean;
  /** per node, row-major from the top row (pinned to the rod): displacement across (n) and along (t) the wall, their
   * speeds, the hem's rise as the fabric swings out, and the slope of n along u and y (for the shading) */
  readonly dn: Float32Array; readonly dt: Float32Array; readonly vn: Float32Array; readonly vt: Float32Array;
  readonly lift: Float32Array; readonly gu: Float32Array; readonly gy: Float32Array;
  moving = false;
  private ddx: number; private ddy: number; private acc = 0; private quiet = 0;
  /** the two directions of motion: displacement with its speed */
  private axes: [Float32Array, Float32Array][];

  constructor(readonly N: V3, box: { u0: number; u1: number; top: number; bottom: number; back: number; depth: number }, floorY = 0) {
    this.U = { x: -N.z, y: 0, z: N.x };                     // up x N
    this.u0 = box.u0; this.u1 = box.u1; this.top = box.top; this.bottom = box.bottom; this.back = box.back; this.depth = box.depth;
    this.cols = Math.max(2, Math.round((box.u1 - box.u0) / CLOTH.dx) + 1);
    this.rows = Math.max(3, Math.round((box.top - box.bottom) / CLOTH.dy) + 1);
    this.ddx = Math.max(1e-3, (box.u1 - box.u0) / (this.cols - 1));
    this.ddy = (box.top - box.bottom) / (this.rows - 1);
    this.onFloor = box.bottom - floorY < 0.05;
    const n = this.cols * this.rows;
    this.dn = new Float32Array(n); this.dt = new Float32Array(n); this.vn = new Float32Array(n); this.vt = new Float32Array(n);
    this.lift = new Float32Array(n); this.gu = new Float32Array(n); this.gy = new Float32Array(n);
    this.axes = [[this.dn, this.vn], [this.dt, this.vt]];
  }

  /** u, y, n of a world point on this panel's frame */
  local(p: V3): { u: number; y: number; n: number } { return { u: dot(p, this.U), y: p.y, n: dot(p, this.N) }; }

  /** The point lies on this panel (within `margin` m of its box). */
  contains(p: V3, margin = 0.03): boolean {
    const { u, y, n } = this.local(p);
    return u > this.u0 - margin && u < this.u1 + margin && y > this.bottom - margin && y < this.top + margin && n > this.back - margin && n < this.back + this.depth + margin;
  }

  /** A slap at p (world) by a swatter moving at v (m/s): the fabric under the head takes up part of its speed. */
  impulse(p: V3, v: V3) {
    const { u, y } = this.local(p);
    let vn = dot(v, this.N), vt = dot(v, this.U);
    const s = Math.hypot(vn, vt);
    if (s > 8) { vn *= 8 / s; vt *= 8 / s; }
    const k = -1 / (2 * CLOTH.sigma * CLOTH.sigma), L = this.top - this.bottom, below = Math.max(0, Math.min(1, (this.top - y) / L));
    for (let j = 1; j < this.rows; j++) for (let i = 0; i < this.cols; i++) {
      const du = this.u0 + i * this.ddx - u, h = this.top - j * this.ddy, dy = h - y;
      const w = Math.exp((du * du + dy * dy) * k);
      // the whole panel below the slap is pushed along a little, most toward the hem (it swings from the rod)
      const sw = CLOTH.sway * below * (this.top - h) / L;
      const q = j * this.cols + i;
      this.vn[q] += (CLOTH.take * w + sw) * vn; this.vt[q] += (CLOTH.takeAlong * w + sw) * vt;
    }
    this.moving = true; this.quiet = 0;
  }

  /** A body (vertical extent y0-y1, centre p, radius r) moving at v brushes the panel: the fabric it touches goes along
   * with it. dt: frame time. */
  brush(p: V3, v: V3, r: number, y0: number, y1: number, dt: number) {
    const { u } = this.local(p);
    const vn = dot(v, this.N), vt = dot(v, this.U), k = Math.min(1, 6 * dt);
    let any = false;
    for (let j = 1; j < this.rows; j++) {
      const y = this.top - j * this.ddy;
      if (y < y0 || y > y1) continue;
      for (let i = 0; i < this.cols; i++) {
        const du = Math.abs(this.u0 + i * this.ddx - u);
        if (du > r) continue;
        const w = 1 - du / r, q = j * this.cols + i;
        this.vn[q] += (vn - this.vn[q]) * k * w; this.vt[q] += (vt - this.vt[q]) * k * w;
        any = true;
      }
    }
    if (any && Math.hypot(vn, vt) > 0.05) { this.moving = true; this.quiet = 0; }
  }

  /** Advance by dt (s), in fixed sub-steps. */
  update(dt: number) {
    if (!this.moving) return;
    this.acc = Math.min(this.acc + dt, 0.1);
    while (this.acc >= CLOTH.step) { this.acc -= CLOTH.step; this.sub(CLOTH.step); }
    this.derive();
    // at rest again: everything back exactly to the hanging shape
    let big = 0, fast = 0;
    for (let q = 0; q < this.dn.length; q++) { big = Math.max(big, Math.abs(this.dn[q]), Math.abs(this.dt[q])); fast = Math.max(fast, Math.abs(this.vn[q]), Math.abs(this.vt[q])); }
    this.quiet = big < CLOTH.still && fast < CLOTH.stillV ? this.quiet + dt : 0;
    if (this.quiet >= CLOTH.settle) {
      for (const a of [this.dn, this.dt, this.vn, this.vt, this.lift, this.gu, this.gy]) a.fill(0);
      this.moving = false;
    }
  }

  private sub(h: number) {
    const C = this.cols, R = this.rows, dy2 = this.ddy * this.ddy, dx2 = this.ddx * this.ddx, L = this.top - this.bottom;
    const lim = -CLOTH.press * this.depth;
    for (const [q, v] of this.axes) {
      for (let j = 1; j < R; j++) {
        // tension above and below this node: the weight of the fabric below the midpoints
        const s = L - j * this.ddy, sUp = s + this.ddy / 2, sDn = Math.max(0, s - this.ddy / 2);
        const drag = CLOTH.drag + (this.onFloor && s < 0.1 ? CLOTH.hemDrag : 0);
        for (let i = 0; i < C; i++) {
          const k = j * C + i, x = q[k];
          const up = q[k - C], dn = j < R - 1 ? q[k + C] : x;
          const left = i > 0 ? q[k - 1] : x, right = i < C - 1 ? q[k + 1] : x;
          const a = CLOTH.g * (sUp * (up - x) - sDn * (x - dn)) / dy2 + CLOTH.across * (left + right - 2 * x) / dx2 - CLOTH.spring * x - drag * v[k];
          v[k] += a * h;
        }
      }
      for (let k = C; k < q.length; k++) q[k] += v[k] * h;
    }
    // the wall behind: pressed in at most so far, and the fabric springs back off it
    for (let k = C; k < this.dn.length; k++) {
      if (this.dn[k] < lim) { this.dn[k] = lim; if (this.vn[k] < 0) this.vn[k] *= -CLOTH.bounce; }
      if (this.dn[k] > 0.3) { this.dn[k] = 0.3; if (this.vn[k] > 0) this.vn[k] = 0; }
      if (Math.abs(this.dt[k]) > 0.2) { this.dt[k] = Math.sign(this.dt[k]) * 0.2; this.vt[k] = 0; }
    }
  }

  /** the hem's rise (the fabric swinging out lifts what hangs below) and the slopes of n */
  private derive() {
    const C = this.cols, R = this.rows;
    for (let i = 0; i < C; i++) {
      let rise = 0;
      for (let j = 1; j < R; j++) {
        const k = j * C + i, a = (this.dn[k] - this.dn[k - C]) / this.ddy, b = (this.dt[k] - this.dt[k - C]) / this.ddy;
        rise += 0.5 * (a * a + b * b) * this.ddy;
        this.lift[k] = Math.min(rise, 0.15);
      }
    }
    for (let j = 0; j < R; j++) for (let i = 0; i < C; i++) {
      const k = j * C + i;
      const l = i > 0 ? k - 1 : k, r = i < C - 1 ? k + 1 : k, u = j > 0 ? k - C : k, d = j < R - 1 ? k + C : k;
      this.gu[k] = (this.dn[r] - this.dn[l]) / (Math.max(1, r - l) * this.ddx);
      // y grows upward, rows downward
      this.gy[k] = (this.dn[u] - this.dn[d]) / (Math.max(1, (d - u) / C) * this.ddy);
    }
  }

  /** Displacement (across, along, rise) and slopes at (u, y), bilinear. */
  sample(u: number, y: number, out: { n: number; t: number; lift: number; gu: number; gy: number }) {
    const fu = Math.min(this.cols - 1, Math.max(0, (u - this.u0) / this.ddx)), fy = Math.min(this.rows - 1, Math.max(0, (this.top - y) / this.ddy));
    const i = Math.min(this.cols - 2, Math.floor(fu)), j = Math.min(this.rows - 2, Math.floor(fy)), a = fu - i, b = fy - j;
    const k = j * this.cols + i, C = this.cols;
    const bl = (f: Float32Array) => (f[k] * (1 - a) + f[k + 1] * a) * (1 - b) + (f[k + C] * (1 - a) + f[k + C + 1] * a) * b;
    out.n = bl(this.dn); out.t = bl(this.dt); out.lift = bl(this.lift); out.gu = bl(this.gu); out.gy = bl(this.gy);
    return out;
  }

  /** How far the fabric gap m in front of the wall moves across it when the panel has moved dn there: out alike,
   * pressed in by its share of the folds' depth (the folds flatten toward the wall). */
  across(dn: number, gap: number): number { return dn >= 0 ? dn : dn * Math.max(0, gap) / Math.max(1e-3, this.depth); }

  /** How far (world) the fabric at p has moved: across the wall (never behind it), along it and up. */
  displacement(p: V3, out: V3 = { x: 0, y: 0, z: 0 }): V3 {
    const { u, y, n } = this.local(p), s = this.sample(u, y, tmp);
    const across = this.across(s.n, n - this.back);
    out.x = this.N.x * across + this.U.x * s.t; out.y = s.lift; out.z = this.N.z * across + this.U.z * s.t;
    return out;
  }
}
const tmp = { n: 0, t: 0, lift: 0, gu: 0, gy: 0 };

/** Which vertices belong together (connected through triangles, or at the same position: split normals and seams), as
 * a component index per vertex; components are numbered from 0. pos: xyz per vertex. */
export function splitPanels(pos: ArrayLike<number>, idx: ArrayLike<number>): { comp: Int32Array; count: number } {
  const n = pos.length / 3, par = new Int32Array(n);
  for (let i = 0; i < n; i++) par[i] = i;
  const find = (a: number): number => { while (par[a] !== a) { par[a] = par[par[a]]; a = par[a]; } return a; };
  const join = (a: number, b: number) => { a = find(a); b = find(b); if (a !== b) par[a] = b; };
  for (let t = 0; t < idx.length; t += 3) { join(idx[t], idx[t + 1]); join(idx[t], idx[t + 2]); }
  const at = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const key = `${Math.round(pos[3 * i] * 2000)},${Math.round(pos[3 * i + 1] * 2000)},${Math.round(pos[3 * i + 2] * 2000)}`;
    const o = at.get(key);
    if (o === undefined) at.set(key, i); else join(i, o);
  }
  const comp = new Int32Array(n), id = new Map<number, number>();
  for (let i = 0; i < n; i++) { const r = find(i); let c = id.get(r); if (c === undefined) { c = id.size; id.set(r, c); } comp[i] = c; }
  return { comp, count: id.size };
}

/** The vertices of one curtain mesh on their panels: each frame the moved positions, normals and a shading factor
 * (vertex colour) are written for the vertices of moving panels. Everything in world space; the caller converts. */
export class CurtainMesh {
  /** per vertex: panel index, u, y and the gap to the wall (m) */
  private pi: Int32Array; private u: Float32Array; private y: Float32Array; private gap: Float32Array;
  private wasMoving = false;
  /** the panels this mesh's vertices hang on */
  private own: CurtainPanel[];
  /** panels: all panels (vertexPanel indexes into it) */
  constructor(readonly panels: CurtainPanel[], vertexPanel: Int32Array, readonly rest: Float32Array, readonly restNrm: Float32Array) {
    const n = rest.length / 3;
    this.pi = vertexPanel; this.u = new Float32Array(n); this.y = new Float32Array(n); this.gap = new Float32Array(n);
    this.own = [...new Set(vertexPanel)].map((k) => panels[k]);
    for (let i = 0; i < n; i++) {
      const pnl = panels[vertexPanel[i]], p = { x: rest[3 * i], y: rest[3 * i + 1], z: rest[3 * i + 2] }, l = pnl.local(p);
      this.u[i] = l.u; this.y[i] = l.y; this.gap[i] = Math.max(0, l.n - pnl.back);
    }
  }

  get moving() { return this.own.some((p) => p.moving); }

  /** Write positions, normals and colours (rgba) of the current state. Returns false when nothing changed since the
   * last call (all panels at rest, and the rest shape already written). */
  write(pos: Float32Array, nrm: Float32Array, col: Float32Array): boolean {
    const moving = this.moving;
    if (!moving && !this.wasMoving) return false;
    this.wasMoving = moving;
    const s = { n: 0, t: 0, lift: 0, gu: 0, gy: 0 };
    for (let i = 0; i < this.pi.length; i++) {
      const pnl = this.panels[this.pi[i]], o = 3 * i;
      const rx = this.rest[o], ry = this.rest[o + 1], rz = this.rest[o + 2];
      const nx = this.restNrm[o], ny = this.restNrm[o + 1], nz = this.restNrm[o + 2];
      if (!pnl.moving) {
        pos[o] = rx; pos[o + 1] = ry; pos[o + 2] = rz; nrm[o] = nx; nrm[o + 1] = ny; nrm[o + 2] = nz;
        col[4 * i] = col[4 * i + 1] = col[4 * i + 2] = col[4 * i + 3] = 1;
        continue;
      }
      pnl.sample(this.u[i], this.y[i], s);
      const N = pnl.N, U = pnl.U, across = pnl.across(s.n, this.gap[i]);
      pos[o] = rx + N.x * across + U.x * s.t; pos[o + 1] = ry + s.lift; pos[o + 2] = rz + N.z * across + U.z * s.t;
      // pressed in, the folds' sides slope less (their slope across the panel scales with the depth that is left); the
      // panel's surface tilts with the slope of its displacement (its normal N becomes N - gu U - gy up)
      const k = s.n < 0 ? 1 + s.n / Math.max(1e-3, pnl.depth) : 1;
      const a = nx * N.x + nz * N.z, b = (nx * U.x + nz * U.z) * k;
      let mx = N.x * a + U.x * (b - s.gu), my = ny - s.gy, mz = N.z * a + U.z * (b - s.gu);
      const ml = Math.hypot(mx, my, mz) || 1; mx /= ml; my /= ml; mz /= ml;
      nrm[o] = mx; nrm[o + 1] = my; nrm[o + 2] = mz;
      // shading: Lambert toward light from the room (front and above) against the hanging shape's, darker pressed flat
      const lx = N.x, ly = CLOTH.light, lz = N.z, ll = Math.hypot(lx, ly, lz);
      const lam = (a: number, b: number, c: number) => CLOTH.ambient + (1 - CLOTH.ambient) * Math.max(0, (a * lx + b * ly + c * lz) / ll);
      const pressed = Math.max(0, -s.n) / Math.max(0.02, pnl.depth * CLOTH.press);
      const shade = Math.min(1.3, Math.max(0.6, lam(mx, my, mz) / lam(nx, ny, nz))) * (1 - CLOTH.pressDark * Math.min(1, pressed));
      col[4 * i] = col[4 * i + 1] = col[4 * i + 2] = shade; col[4 * i + 3] = 1;
    }
    return true;
  }
}
