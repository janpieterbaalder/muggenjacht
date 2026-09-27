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
