import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { room } from './helpers';
import { MosquitoBrain } from '../src/mosquito/brain';
import { parseSave, defaults } from '../src/game/save';
import { illuminantToTemperatureTint, adaptTemperatureTint } from '../src/engine/whitebalance';
import { GetWhiteBalanceMatrix } from '@babylonjs/core/Maths/colorTemperature.functions';
import { IRRADIANCE_LINE } from '../src/engine/lightmap';

const params = { alert: 1, hostDrive: 0.3, restMin: 1, restMax: 2, speed: 0.5, roomBias: null };
const noDoor = (_ox: number, _oy: number, _oz: number, _dx: number, _dy: number, _dz: number, max: number) => max;

test('mosquito never leaves a closed room (continuous collision), lands on real surfaces', () => {
  const bvh = room();
  const b = new MosquitoBrain(bvh, params, 1, noDoor);
  b.x = 2; b.y = 1.4; b.z = 2; b.setState('fly', 2);
  const host = { x: 1, y: 1.6, z: 1 };
  const idle = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, active: false };
  let landed = 0;
  for (let i = 0; i < 60 * 120; i++) {
    b.update(1 / 60, host, idle, [0, 0, 4, 4], 0);
    assert.ok(b.x > -0.001 && b.x < 4.001 && b.z > -0.001 && b.z < 4.001 && b.y > -0.001 && b.y < 2.401, `escaped at ${b.x},${b.y},${b.z}`);
    for (const e of b.events.splice(0)) if (e === 'landed') {
      landed++;
      // resting position is within a few mm of a wall, floor or ceiling
      const d = Math.min(b.x, 4 - b.x, b.z, 4 - b.z, b.y, 2.4 - b.y);
      assert.ok(d < 0.01, `landed ${d} m away from any surface`);
    }
  }
  assert.ok(landed > 0, 'it lands at least once in two minutes');
});

test('mosquito killed in flight falls to the floor', () => {
  const b = new MosquitoBrain(room(), params, 2, noDoor);
  b.x = 2; b.y = 1.5; b.z = 2; b.setState('fly', 5);
  b.kill(false);
  const idle = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, active: false };
  for (let i = 0; i < 60 * 10 && b.state !== 'dead'; i++) b.update(1 / 60, { x: 0, y: 1.6, z: 0 }, idle, [0, 0, 4, 4], 0);
  assert.equal(b.state, 'dead');
  assert.ok(b.y < 0.01 && b.y > -0.001, `on the floor: ${b.y}`);
  assert.equal(b.alive, false);
});

test('save: rejects garbage, clamps values, migrates schema 1', () => {
  assert.equal(parseSave('nonsense'), null);
  assert.equal(parseSave(JSON.stringify({ schema: 9 })), null);
  const s = parseSave(JSON.stringify({ schema: 1, settings: { volume: 7, sensitivity: -3, help: 'x' }, progress: { completed: ['r1', 'r99', 5, 'r10'], lastRound: 40 } }))!;
  assert.equal(s.schema, 2);
  assert.equal(s.settings.volume, 1);
  assert.equal(s.settings.sensitivity, 0.4);
  assert.equal(s.settings.help, 'licht');
  assert.deepEqual(s.progress.completed, ['r1', 'r10']);
  assert.equal(s.progress.lastRound, 9);
  assert.deepEqual(defaults().progress.completed, []);
});

test("white balance: illuminant -> temperature/tint neutralises it with Babylon's own matrix", () => {
  const n = illuminantToTemperatureTint([0.5, 0.5, 0.5]);
  assert.ok(Math.abs(n.temperature - 6500) < 60 && Math.abs(n.tint) < 2, `neutral: ${JSON.stringify(n)}`);
  for (const il of [[1, 0.78, 0.55], [0.69, 1, 0.3], [0.87, 1, 1.2]] as [number, number, number][]) {
    const wb = illuminantToTemperatureTint(il);
    const M = GetWhiteBalanceMatrix(wb.temperature, wb.tint);                 // column-major 3x3
    const o = [0, 1, 2].map((r) => M[r] * il[0] + M[3 + r] * il[1] + M[6 + r] * il[2]);
    const spread = (Math.max(...o) - Math.min(...o)) / Math.max(...o);
    assert.ok(spread < 0.06, `${il} -> ${JSON.stringify(wb)} -> ${o.map((v) => v.toFixed(3))}`);
  }
  const warm = illuminantToTemperatureTint([1, 0.78, 0.55]);
  assert.ok(warm.temperature < 5200, `warm light is low CCT: ${warm.temperature}`);
  const tung = illuminantToTemperatureTint([1, 0.6, 0.3]);
  assert.ok(tung.temperature > 3200 && tung.temperature < 3900, `tungsten-like light: ${JSON.stringify(tung)}`);
  const half = adaptTemperatureTint(warm, 0.5);
  assert.ok(half.temperature > warm.temperature && half.temperature < 6500);
});

test('shader anchor of the lightmap plugin and the built-in white balance exist in this Babylon version', () => {
  const inc = join(process.cwd(), 'node_modules', '@babylonjs', 'core', 'Shaders', 'ShadersInclude');
  assert.ok(readFileSync(join(inc, 'pbrBlockFinalLitComponents.js'), 'utf8').includes(IRRADIANCE_LINE));
  assert.ok(readFileSync(join(inc, 'imageProcessingFunctions.js'), 'utf8').includes('result.rgb=whiteBalanceMatrix*result.rgb'), 'built-in white balance before exposure');
});

test('lightmap: a face whose island the export collapsed to a line takes the mapping of the proper face it lies on', async () => {
  // the end of the wall beside the niche before the bathroom door lies twice in the export, once with its lightmap island
  // collapsed to a line of unbaked texels: where only that one covered it, a black patch under the ceiling (28-09-2026)
  const { collapsedLightmapFixes } = await import('../src/engine/world');
  const P: number[] = [], UV: number[] = [], I: number[] = [];
  const quad = (pts: number[][], uv: (p: number[]) => number[]) => {
    const b = P.length / 3;
    for (const p of pts) { P.push(...p); UV.push(...uv(p)); }
    I.push(b, b + 1, b + 2, b, b + 2, b + 3);
  };
  const proper = (p: number[]) => [0.1 + 0.05 * p[2], 0.2 + 0.05 * p[1]], line = (p: number[]) => [0.5 + 0.01 * p[2], 0.5];
  quad([[0, 0, 0], [0, 0, 2], [0, 2, 2], [0, 2, 0]], proper);                      // 0, 1: wall x = 0 with a proper island
  quad([[0, 1, 0], [0, 1, 0.5], [0, 2, 0.5], [0, 2, 0]], line);                    // 2, 3: collapsed, on that wall
  quad([[0.01, 1, 0], [0.01, 1, 0.5], [0.01, 2, 0.5], [0.01, 2, 0]], line);        // 4, 5: collapsed, 1 cm in front of it
  quad([[0, 1, 3], [0, 1, 3.5], [0, 2, 3.5], [0, 2, 3]], line);                    // 6, 7: collapsed, in its plane beside it
  quad([[0, 1, 1], [0, 1, 1.02], [0, 1.02, 1.02], [0, 1.02, 1]], line);            // 8, 9: collapsed, too small to show
  const fixes = collapsedLightmapFixes(P, UV, I, 2048);
  assert.deepEqual([...fixes.keys()].sort((a, b) => a - b), [2, 3], 'only the collapsed faces on the proper one');
  assert.equal(collapsedLightmapFixes(P, UV, I, 2048, { x0: -1, z0: 1, x1: 1, z1: 4 }).size, 0, 'only faces with their middle in the box');
  for (const t of [2, 3]) for (let k = 0; k < 3; k++) {
    const v = I[3 * t + k], want = proper(P.slice(3 * v, 3 * v + 3)), got = fixes.get(t)!.slice(2 * k, 2 * k + 2);
    assert.ok(Math.abs(got[0] - want[0]) < 1e-6 && Math.abs(got[1] - want[1]) < 1e-6, `tri ${t} corner ${k}: ${got} vs ${want}`);
  }
});
