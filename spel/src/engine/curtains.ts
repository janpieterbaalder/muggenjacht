// The chalet's curtains on the cloth model (cloth.ts): finds the curtain meshes (S_<atlas>_curtain), splits them into
// their gathered panels, finds the wall behind each panel and writes the moved vertices while a panel moves. The
// collision mesh stays as it is (the hanging shape): the fabric gives way only in the picture.
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh';
import { VertexBuffer } from '@babylonjs/core/Buffers/buffer';
import type { TriBVH, RayHit } from '../physics/bvh';
import { CurtainMesh, CurtainPanel, splitPanels, type V3 } from './cloth';

interface Bound { mesh: Mesh; cloth: CurtainMesh; local: Float32Array; pos: Float32Array; nrm: Float32Array; col: Float32Array; outPos: Float32Array; outNrm: Float32Array;
  /** the vertex data written to the mesh (local) */
  lp: Float32Array; ln: Float32Array;
  /** 3x3 (column-major) of the inverse world matrix (world -> local displacements, local -> world normals as its
   * transpose) and of the world matrix transposed (world -> local normals) */
  inv: number[]; tr: number[]; }

const hit: RayHit = { t: 0, tri: 0, nx: 0, ny: 0, nz: 0 };

export class Curtains {
  panels: CurtainPanel[] = [];
  private bound: Bound[] = [];

  /** Bind the curtain meshes among `meshes` (static, world matrix frozen). */
  constructor(meshes: AbstractMesh[], bvh: TriBVH) {
    for (const m of meshes) {
      if (!/_curtain$/.test(m.name) || !(m as Mesh).getIndices) continue;
      const mesh = m as Mesh;
      const local = mesh.getVerticesData(VertexBuffer.PositionKind), ln = mesh.getVerticesData(VertexBuffer.NormalKind), idx = mesh.getIndices();
      if (!local || !ln || !idx) continue;
      const W = mesh.computeWorldMatrix(true).m;
      const n = local.length / 3, pos = new Float32Array(n * 3), nrm = new Float32Array(n * 3);
      // world normals: inverse transpose of the world matrix's 3x3 (uniformly scaled here: the 3x3 itself, renormalised)
      const inv = inverse3(W), tr = [W[0], W[4], W[8], W[1], W[5], W[9], W[2], W[6], W[10]];
      for (let i = 0; i < n; i++) {
        const x = local[3 * i], y = local[3 * i + 1], z = local[3 * i + 2];
        pos[3 * i] = W[0] * x + W[4] * y + W[8] * z + W[12]; pos[3 * i + 1] = W[1] * x + W[5] * y + W[9] * z + W[13]; pos[3 * i + 2] = W[2] * x + W[6] * y + W[10] * z + W[14];
        const a = ln[3 * i], b = ln[3 * i + 1], c = ln[3 * i + 2];
        let wx = inv[0] * a + inv[1] * b + inv[2] * c, wy = inv[3] * a + inv[4] * b + inv[5] * c, wz = inv[6] * a + inv[7] * b + inv[8] * c;
        const l = Math.hypot(wx, wy, wz) || 1; wx /= l; wy /= l; wz /= l;
        nrm[3 * i] = wx; nrm[3 * i + 1] = wy; nrm[3 * i + 2] = wz;
      }
      const { comp, count } = splitPanels(pos, idx);
      const panelOf = new Int32Array(n), base = this.panels.length;
      for (let c = 0; c < count; c++) {
        const p = makePanel(pos, comp, c, bvh);
        this.panels.push(p);
      }
      for (let i = 0; i < n; i++) panelOf[i] = base + comp[i];
      const cloth = new CurtainMesh(this.panels, panelOf, pos, nrm);
      // updatable buffers (positions and normals as plain floats) and a colour per vertex for the shading of the folds;
      // the colour attribute is there from the start, so the material does not recompile at the first slap
      mesh.setVerticesData(VertexBuffer.PositionKind, Float32Array.from(local), true);
      mesh.setVerticesData(VertexBuffer.NormalKind, Float32Array.from(ln), true);
      const col = new Float32Array(n * 4).fill(1);
      mesh.setVerticesData(VertexBuffer.ColorKind, col, true);
      // the moved fabric reaches past the hanging shape's bounds
      mesh.alwaysSelectAsActiveMesh = true;
      this.bound.push({ mesh, cloth, local: Float32Array.from(local), pos, nrm, col, outPos: new Float32Array(n * 3), outNrm: new Float32Array(n * 3), lp: new Float32Array(n * 3), ln: new Float32Array(n * 3), inv, tr });
    }
  }

  /** The panel the world point p lies on (within margin m of its box), or null. */
  panelAt(p: V3, margin = 0.03): CurtainPanel | null {
    for (const pn of this.panels) if (pn.contains(p, margin)) return pn;
    return null;
  }

  /** A slap at p by a swatter moving at v: the panel there gives way. Returns whether it hit a curtain. */
  hit(p: V3, v: V3): boolean {
    const pn = this.panelAt(p, 0.04);
    if (!pn) return false;
    pn.impulse(p, v);
    return true;
  }

  /** The player's body (feet at p, moving at v) brushing past a panel moves it along. */
  brush(p: V3, v: V3, radius: number, dt: number) {
    for (const pn of this.panels) {
      const { u, n } = pn.local(p);
      // touching: the body's front within 3 cm of the front of the folds, beside the panel by less than its radius
      if (n - radius > pn.back + pn.depth + 0.03 || u < pn.u0 - radius || u > pn.u1 + radius) continue;
      pn.brush({ x: p.x, y: p.y, z: p.z }, v, radius + 0.05, p.y + 0.25, p.y + 1.55, dt);
    }
  }

  /** How far the fabric under p has moved (world), or null when p is on no curtain. */
  displacementAt(p: V3, out: V3 = { x: 0, y: 0, z: 0 }): V3 | null {
    const pn = this.panelAt(p, 0.02);
    if (!pn) return null;
    if (!pn.moving) { out.x = out.y = out.z = 0; return out; }
    return pn.displacement(p, out);
  }

  get moving() { return this.panels.some((p) => p.moving); }

  update(dt: number) {
    for (const p of this.panels) p.update(dt);
    for (const b of this.bound) {
      if (!b.cloth.write(b.outPos, b.outNrm, b.col)) continue;
      // world -> local
      const L = b.local, P = b.outPos, N = b.outNrm, out = b.lp, on = b.ln, inv = b.inv, tr = b.tr;
      for (let i = 0; i < L.length; i += 3) {
        const dx = P[i] - b.pos[i], dy = P[i + 1] - b.pos[i + 1], dz = P[i + 2] - b.pos[i + 2];
        out[i] = L[i] + inv[0] * dx + inv[3] * dy + inv[6] * dz; out[i + 1] = L[i + 1] + inv[1] * dx + inv[4] * dy + inv[7] * dz; out[i + 2] = L[i + 2] + inv[2] * dx + inv[5] * dy + inv[8] * dz;
        let x = tr[0] * N[i] + tr[3] * N[i + 1] + tr[6] * N[i + 2], y = tr[1] * N[i] + tr[4] * N[i + 1] + tr[7] * N[i + 2], z = tr[2] * N[i] + tr[5] * N[i + 1] + tr[8] * N[i + 2];
        const l = Math.hypot(x, y, z) || 1; x /= l; y /= l; z /= l;
        on[i] = x; on[i + 1] = y; on[i + 2] = z;
      }
      b.mesh.updateVerticesData(VertexBuffer.PositionKind, out);
      b.mesh.updateVerticesData(VertexBuffer.NormalKind, on);
      b.mesh.updateVerticesData(VertexBuffer.ColorKind, b.col);
    }
  }
}

/** A panel of the mesh (the vertices of component c): its box on the wall it hangs against. The wall is the solid
 * surface the panel's thin horizontal side touches (a ray from the panel's middle each way, curtains and floors not
 * counted); N points away from it, into the room. */
export function makePanel(pos: ArrayLike<number>, comp: ArrayLike<number>, c: number, bvh: TriBVH): CurtainPanel {
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < comp.length; i++) {
    if (comp[i] !== c) continue;
    for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], pos[3 * i + k]); mx[k] = Math.max(mx[k], pos[3 * i + k]); }
  }
  const cx = (mn[0] + mx[0]) / 2, cy = (mn[1] + mx[1]) / 2, cz = (mn[2] + mx[2]) / 2;
  const axis = mx[0] - mn[0] < mx[2] - mn[2] ? 0 : 2;
  const dist = (s: number) => {
    const dx = axis === 0 ? s : 0, dz = axis === 2 ? s : 0;
    return bvh.raycast(cx, cy, cz, dx, 0, dz, 0.6, hit, 1 | 4) ? hit.t : Infinity;
  };
  const wallSide = dist(1) <= dist(-1) ? 1 : -1;
  const N = { x: axis === 0 ? -wallSide : 0, y: 0, z: axis === 2 ? -wallSide : 0 };
  const U = { x: -N.z, y: 0, z: N.x };
  let u0 = Infinity, u1 = -Infinity, n0 = Infinity, n1 = -Infinity;
  for (let i = 0; i < comp.length; i++) {
    if (comp[i] !== c) continue;
    const x = pos[3 * i], z = pos[3 * i + 2], u = x * U.x + z * U.z, n = x * N.x + z * N.z;
    u0 = Math.min(u0, u); u1 = Math.max(u1, u); n0 = Math.min(n0, n); n1 = Math.max(n1, n);
  }
  // floor under the panel (a floor-length curtain's hem lies on it)
  const floor = bvh.raycast(cx, mn[1] + 0.3, cz, 0, -1, 0, 1.5, hit, 2) ? mn[1] + 0.3 - hit.t : -Infinity;
  return new CurtainPanel(N, { u0, u1, top: mx[1], bottom: mn[1], back: n0, depth: n1 - n0 }, floor);
}

function inverse3(m: ArrayLike<number>): number[] {
  // column-major 4x4 -> inverse of its 3x3 (column-major)
  const a = m[0], b = m[4], c = m[8], d = m[1], e = m[5], f = m[9], g = m[2], h = m[6], i = m[10];
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g, det = a * A + b * B + c * C || 1;
  return [A / det, B / det, C / det, -(b * i - c * h) / det, (a * i - c * g) / det, -(a * h - b * g) / det, (b * f - c * e) / det, -(a * f - c * d) / det, (a * e - b * d) / det];
}
