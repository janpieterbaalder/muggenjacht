// Static triangle BVH (Babylon world frame: x east, y up, z south). Allocation-free queries.
export interface RayHit { t: number; tri: number; nx: number; ny: number; nz: number; }

export class TriBVH {
  readonly pos: Float32Array;      // xyz per vertex
  readonly idx: Uint32Array;       // 3 per triangle
  readonly cls: Uint8Array;        // surface class per triangle
  readonly kind: Uint8Array;       // collision kind per triangle (0 solid,1 floor,2 glass,3 soft)
  readonly triCount: number;
  // node arrays
  private bmin!: Float32Array; private bmax!: Float32Array;
  private left!: Int32Array; private right!: Int32Array; private start!: Int32Array; private count!: Int32Array;
  private order!: Uint32Array; private nodes = 0;
  // per-triangle precomputed
  private tv!: Float32Array; // v0, e1, e2, n (12 floats)
  private stack = new Int32Array(128);

  constructor(pos: Float32Array, idx: Uint32Array, cls: Uint8Array, kind: Uint8Array) {
    this.pos = pos; this.idx = idx; this.cls = cls; this.kind = kind;
    this.triCount = idx.length / 3;
    this.build();
  }

  private build() {
    const n = this.triCount, P = this.pos, I = this.idx;
    const cen = new Float32Array(n * 3), tmin = new Float32Array(n * 3), tmax = new Float32Array(n * 3);
    this.tv = new Float32Array(n * 12);
    for (let t = 0; t < n; t++) {
      const a = I[3 * t] * 3, b = I[3 * t + 1] * 3, c = I[3 * t + 2] * 3;
      for (let k = 0; k < 3; k++) {
        const va = P[a + k], vb = P[b + k], vc = P[c + k];
        tmin[3 * t + k] = Math.min(va, vb, vc); tmax[3 * t + k] = Math.max(va, vb, vc);
        cen[3 * t + k] = (va + vb + vc) / 3;
      }
      const e1x = P[b] - P[a], e1y = P[b + 1] - P[a + 1], e1z = P[b + 2] - P[a + 2];
      const e2x = P[c] - P[a], e2y = P[c + 1] - P[a + 1], e2z = P[c + 2] - P[a + 2];
      let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
      const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
      const o = t * 12;
      this.tv[o] = P[a]; this.tv[o + 1] = P[a + 1]; this.tv[o + 2] = P[a + 2];
      this.tv[o + 3] = e1x; this.tv[o + 4] = e1y; this.tv[o + 5] = e1z;
      this.tv[o + 6] = e2x; this.tv[o + 7] = e2y; this.tv[o + 8] = e2z;
      this.tv[o + 9] = nx; this.tv[o + 10] = ny; this.tv[o + 11] = nz;
    }
    const maxNodes = Math.max(1, 2 * n);
    this.bmin = new Float32Array(maxNodes * 3); this.bmax = new Float32Array(maxNodes * 3);
    this.left = new Int32Array(maxNodes).fill(-1); this.right = new Int32Array(maxNodes).fill(-1);
    this.start = new Int32Array(maxNodes); this.count = new Int32Array(maxNodes);
    this.order = new Uint32Array(n); for (let i = 0; i < n; i++) this.order[i] = i;
    const stack: [number, number, number][] = [];
    const root = this.nodes++;
    stack.push([root, 0, n]);
    while (stack.length) {
      const [node, s, e] = stack.pop()!;
      let mnx = Infinity, mny = Infinity, mnz = Infinity, mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
      let cmnx = Infinity, cmny = Infinity, cmnz = Infinity, cmxx = -Infinity, cmxy = -Infinity, cmxz = -Infinity;
      for (let i = s; i < e; i++) {
        const t = this.order[i];
        mnx = Math.min(mnx, tmin[3 * t]); mny = Math.min(mny, tmin[3 * t + 1]); mnz = Math.min(mnz, tmin[3 * t + 2]);
        mxx = Math.max(mxx, tmax[3 * t]); mxy = Math.max(mxy, tmax[3 * t + 1]); mxz = Math.max(mxz, tmax[3 * t + 2]);
        cmnx = Math.min(cmnx, cen[3 * t]); cmny = Math.min(cmny, cen[3 * t + 1]); cmnz = Math.min(cmnz, cen[3 * t + 2]);
        cmxx = Math.max(cmxx, cen[3 * t]); cmxy = Math.max(cmxy, cen[3 * t + 1]); cmxz = Math.max(cmxz, cen[3 * t + 2]);
      }
      this.bmin[3 * node] = mnx; this.bmin[3 * node + 1] = mny; this.bmin[3 * node + 2] = mnz;
      this.bmax[3 * node] = mxx; this.bmax[3 * node + 1] = mxy; this.bmax[3 * node + 2] = mxz;
      const cnt = e - s;
      if (cnt <= 6) { this.start[node] = s; this.count[node] = cnt; continue; }
      const ex = cmxx - cmnx, ey = cmxy - cmny, ez = cmxz - cmnz;
      const axis = ex > ey && ex > ez ? 0 : ey > ez ? 1 : 2;
      const mid = axis === 0 ? (cmxx + cmnx) / 2 : axis === 1 ? (cmxy + cmny) / 2 : (cmxz + cmnz) / 2;
      let i = s, j = e - 1;
      while (i <= j) {
        if (cen[3 * this.order[i] + axis] < mid) i++;
        else { const tmp = this.order[i]; this.order[i] = this.order[j]; this.order[j] = tmp; j--; }
      }
      let m = i;
      if (m === s || m === e) m = (s + e) >> 1;
      const l = this.nodes++, r = this.nodes++;
      this.left[node] = l; this.right[node] = r; this.count[node] = 0;
      stack.push([l, s, m], [r, m, e]);
    }
  }

  /** Closest ray hit within [0, tmax]. mask: bit per kind (1 solid, 2 floor, 4 glass, 8 soft). */
  raycast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, tmax: number, out: RayHit, mask = 15, twoSided = true): boolean {
    const idx = 1 / (dx || 1e-12), idy = 1 / (dy || 1e-12), idz = 1 / (dz || 1e-12);
    let best = tmax, bestTri = -1;
    const st = this.stack; let sp = 0; st[sp++] = 0;
    const tv = this.tv;
    while (sp) {
      const node = st[--sp];
      // slab test
      let t0 = (this.bmin[3 * node] - ox) * idx, t1 = (this.bmax[3 * node] - ox) * idx;
      let tn = Math.min(t0, t1), tf = Math.max(t0, t1);
      t0 = (this.bmin[3 * node + 1] - oy) * idy; t1 = (this.bmax[3 * node + 1] - oy) * idy;
      tn = Math.max(tn, Math.min(t0, t1)); tf = Math.min(tf, Math.max(t0, t1));
      t0 = (this.bmin[3 * node + 2] - oz) * idz; t1 = (this.bmax[3 * node + 2] - oz) * idz;
      tn = Math.max(tn, Math.min(t0, t1)); tf = Math.min(tf, Math.max(t0, t1));
      if (tf < Math.max(tn, 0) || tn > best) continue;
      const c = this.count[node];
      if (c > 0) {
        const s = this.start[node];
        for (let i = s; i < s + c; i++) {
          const t = this.order[i];
          if (!((1 << this.kind[t]) & mask)) continue;
          const o = t * 12;
          const e1x = tv[o + 3], e1y = tv[o + 4], e1z = tv[o + 5], e2x = tv[o + 6], e2y = tv[o + 7], e2z = tv[o + 8];
          const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
          const det = e1x * px + e1y * py + e1z * pz;
          if (!twoSided && det < 1e-12) continue;
          if (Math.abs(det) < 1e-12) continue;
          const inv = 1 / det;
          const sx = ox - tv[o], sy = oy - tv[o + 1], sz = oz - tv[o + 2];
          const u = (sx * px + sy * py + sz * pz) * inv;
          if (u < 0 || u > 1) continue;
          const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
          const v = (dx * qx + dy * qy + dz * qz) * inv;
          if (v < 0 || u + v > 1) continue;
          const tt = (e2x * qx + e2y * qy + e2z * qz) * inv;
          if (tt >= 0 && tt < best) { best = tt; bestTri = t; }
        }
      } else {
        st[sp++] = this.left[node]; st[sp++] = this.right[node];
      }
    }
    if (bestTri < 0) return false;
    out.t = best; out.tri = bestTri;
    const o = bestTri * 12;
    let nx = tv[o + 9], ny = tv[o + 10], nz = tv[o + 11];
    if (nx * dx + ny * dy + nz * dz > 0) { nx = -nx; ny = -ny; nz = -nz; }   // face the ray
    out.nx = nx; out.ny = ny; out.nz = nz;
    return true;
  }

  /** Visit triangles whose AABB overlaps the sphere; callback gets triangle index. */
  querySphere(cx: number, cy: number, cz: number, r: number, cb: (tri: number) => void, mask = 15) {
    const st = this.stack; let sp = 0; st[sp++] = 0;
    while (sp) {
      const node = st[--sp];
      if (cx + r < this.bmin[3 * node] || cx - r > this.bmax[3 * node] || cy + r < this.bmin[3 * node + 1] || cy - r > this.bmax[3 * node + 1] ||
        cz + r < this.bmin[3 * node + 2] || cz - r > this.bmax[3 * node + 2]) continue;
      const c = this.count[node];
      if (c > 0) {
        const s = this.start[node];
        for (let i = s; i < s + c; i++) { const t = this.order[i]; if ((1 << this.kind[t]) & mask) cb(t); }
      } else { st[sp++] = this.left[node]; st[sp++] = this.right[node]; }
    }
  }

  /** Closest point on triangle t to p (Ericson). Writes into out[0..2]. */
  closestOnTri(t: number, px: number, py: number, pz: number, out: Float32Array | number[]) {
    const tv = this.tv, o = t * 12;
    const ax = tv[o], ay = tv[o + 1], az = tv[o + 2];
    const abx = tv[o + 3], aby = tv[o + 4], abz = tv[o + 5], acx = tv[o + 6], acy = tv[o + 7], acz = tv[o + 8];
    const apx = px - ax, apy = py - ay, apz = pz - az;
    const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
    if (d1 <= 0 && d2 <= 0) { out[0] = ax; out[1] = ay; out[2] = az; return; }
    const bpx = px - (ax + abx), bpy = py - (ay + aby), bpz = pz - (az + abz);
    const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
    if (d3 >= 0 && d4 <= d3) { out[0] = ax + abx; out[1] = ay + aby; out[2] = az + abz; return; }
    const vc = d1 * d4 - d3 * d2;
    if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); out[0] = ax + v * abx; out[1] = ay + v * aby; out[2] = az + v * abz; return; }
    const cpx = px - (ax + acx), cpy = py - (ay + acy), cpz = pz - (az + acz);
    const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
    if (d6 >= 0 && d5 <= d6) { out[0] = ax + acx; out[1] = ay + acy; out[2] = az + acz; return; }
    const vb = d5 * d2 - d1 * d6;
    if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); out[0] = ax + w * acx; out[1] = ay + w * acy; out[2] = az + w * acz; return; }
    const va = d3 * d6 - d5 * d4;
    if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
      const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
      out[0] = ax + abx + w * (acx - abx); out[1] = ay + aby + w * (acy - aby); out[2] = az + abz + w * (acz - abz); return;
    }
    const denom = 1 / (va + vb + vc), v = vb * denom, w = vc * denom;
    out[0] = ax + abx * v + acx * w; out[1] = ay + aby * v + acy * w; out[2] = az + abz * v + acz * w;
  }

  normal(t: number, out: Float32Array | number[]) { const o = t * 12; out[0] = this.tv[o + 9]; out[1] = this.tv[o + 10]; out[2] = this.tv[o + 11]; }
}

/** Triangles of the collision mesh (Babylon frame), before they go into a BVH. */
export interface CollisionData { pos: Float32Array; idx: Uint32Array; cls: Uint8Array; kind: Uint8Array; }

/** Parse chalet_coll.bin (Blender z-up) into a BVH in Babylon frame (x, z, -y). */
export function parseCollision(buf: ArrayBuffer): TriBVH {
  const d = readCollision(buf);
  return new TriBVH(d.pos, d.idx, d.cls, d.kind);
}

/** Read chalet_coll.bin (Blender z-up) into triangles in Babylon frame (x, z, -y). */
export function readCollision(buf: ArrayBuffer): CollisionData {
  const dv = new DataView(buf);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== 'MJC1' && magic !== 'MJC2') throw new Error('Onbekend botsingsbestand');
  const nv = dv.getUint32(4, true), nt = dv.getUint32(8, true);
  const ib = magic === 'MJC2' ? 2 : 4;                 // MJC2: 16-bit triangle indices (bake_export.py / coll_compact.py)
  let off = 12;
  const raw = new Float32Array(buf.slice(off, off + nv * 12)); off += nv * 12;
  const idx = ib === 2 ? Uint32Array.from(new Uint16Array(buf.slice(off, off + nt * 6))) : new Uint32Array(buf.slice(off, off + nt * 12)); off += nt * 3 * ib;
  const cls = new Uint8Array(buf.slice(off, off + nt)); off += nt;
  const kind = new Uint8Array(buf.slice(off, off + nt));
  const pos = new Float32Array(nv * 3);
  for (let i = 0; i < nv; i++) { pos[3 * i] = raw[3 * i]; pos[3 * i + 1] = raw[3 * i + 2]; pos[3 * i + 2] = -raw[3 * i + 1]; }
  return { pos, idx, cls, kind };
}
