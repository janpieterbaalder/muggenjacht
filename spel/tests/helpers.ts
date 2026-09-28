// Test geometry: axis-aligned boxes as triangle soup for TriBVH (Babylon frame, metres).
import { TriBVH } from '../src/physics/bvh';

export interface BoxSpec { min: [number, number, number]; max: [number, number, number]; cls?: number; kind?: number }

export function boxesToBVH(boxes: BoxSpec[]): TriBVH {
  const pos: number[] = [], idx: number[] = [], cls: number[] = [], kind: number[] = [];
  for (const b of boxes) {
    const [x0, y0, z0] = b.min, [x1, y1, z1] = b.max;
    const base = pos.length / 3;
    const v = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
    for (const p of v) pos.push(...p);
    const faces = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [3, 7, 6, 2], [0, 4, 7, 3], [1, 2, 6, 5]];
    for (const f of faces) {
      idx.push(base + f[0], base + f[1], base + f[2], base + f[0], base + f[2], base + f[3]);
      cls.push(b.cls ?? 0, b.cls ?? 0); kind.push(b.kind ?? 0, b.kind ?? 0);
    }
  }
  return new TriBVH(new Float32Array(pos), new Uint32Array(idx), new Uint8Array(cls), new Uint8Array(kind));
}

/** A convex prism (polygon in x-y, extruded along z from z0 to z1) plus boxes, every face wound outward like the chalet
 * mesh: e.g. a wall cupboard with a 2 mm bevel on its bottom front edge. */
export function prismToBVH(poly: [number, number][], z0: number, z1: number, boxes: BoxSpec[] = []): TriBVH {
  const pos: number[] = [], idx: number[] = [], cls: number[] = [], kind: number[] = [];
  const tri = (a: number[], b: number[], c: number[], ctr: number[], k: number) => {
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const out = (a[0] - ctr[0]) * n[0] + (a[1] - ctr[1]) * n[1] + (a[2] - ctr[2]) * n[2] > 0;
    const base = pos.length / 3;
    pos.push(...a, ...(out ? b : c), ...(out ? c : b)); idx.push(base, base + 1, base + 2); cls.push(0); kind.push(k);
  };
  const ctr = [poly.reduce((s, p) => s + p[0], 0) / poly.length, poly.reduce((s, p) => s + p[1], 0) / poly.length, (z0 + z1) / 2];
  poly.forEach((p, i) => {
    const q = poly[(i + 1) % poly.length], o = poly[0];
    tri([p[0], p[1], z0], [q[0], q[1], z0], [q[0], q[1], z1], ctr, 0); tri([p[0], p[1], z0], [q[0], q[1], z1], [p[0], p[1], z1], ctr, 0);
    if (i > 0 && i < poly.length - 1) { tri([o[0], o[1], z0], [p[0], p[1], z0], [q[0], q[1], z0], ctr, 0); tri([o[0], o[1], z1], [p[0], p[1], z1], [q[0], q[1], z1], ctr, 0); }
  });
  for (const b of boxes) {
    const [x0, y0, bz0] = b.min, [x1, y1, bz1] = b.max, c = [(x0 + x1) / 2, (y0 + y1) / 2, (bz0 + bz1) / 2];
    const v = [[x0, y0, bz0], [x1, y0, bz0], [x1, y1, bz0], [x0, y1, bz0], [x0, y0, bz1], [x1, y0, bz1], [x1, y1, bz1], [x0, y1, bz1]];
    for (const f of [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [3, 7, 6, 2], [0, 4, 7, 3], [1, 2, 6, 5]]) { tri(v[f[0]], v[f[1]], v[f[2]], c, b.kind ?? 0); tri(v[f[0]], v[f[2]], v[f[3]], c, b.kind ?? 0); }
  }
  return new TriBVH(new Float32Array(pos), new Uint32Array(idx), new Uint8Array(cls), new Uint8Array(kind));
}

/** A 4 x 2.4 x 4 m room: floor (kind 1) at y=0, walls/ceiling (kind 0), 0.1 m thick. Interior x,z in [0,4]. */
export function room(extra: BoxSpec[] = []): TriBVH {
  return boxesToBVH([
    { min: [-0.1, -0.1, -0.1], max: [4.1, 0, 4.1], kind: 1, cls: 1 },
    { min: [-0.1, 2.4, -0.1], max: [4.1, 2.5, 4.1] },
    { min: [-0.1, 0, -0.1], max: [0, 2.4, 4.1] }, { min: [4, 0, -0.1], max: [4.1, 2.4, 4.1] },
    { min: [0, 0, -0.1], max: [4, 2.4, 0] }, { min: [0, 0, 4], max: [4, 2.4, 4.1] },
    ...extra,
  ]);
}
