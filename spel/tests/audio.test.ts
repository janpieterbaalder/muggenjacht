import { test } from 'node:test';
import assert from 'node:assert/strict';
import { synthSlap, synthThump } from '../src/audio/impact';

const SR = 48000;
/** Time (s) after the peak until the 2 ms RMS envelope stays 30 dB below it. */
function decay30(d: Float32Array): number {
  const w = Math.floor(SR * 0.002), rms: number[] = [];
  for (let i = 0; i + w <= d.length; i += w) { let s = 0; for (let k = i; k < i + w; k++) s += d[k] * d[k]; rms.push(Math.sqrt(s / w)); }
  const pk = Math.max(...rms), ip = rms.indexOf(pk);
  let last = ip;
  for (let i = ip; i < rms.length; i++) if (rms[i] > pk * 0.0316) last = i;
  return (last - ip) * 0.002;
}
/** Spectral centroid (Hz) of the first 43 ms. */
function centroid(d: Float32Array): number {
  const N = 2048; let num = 0, den = 0;
  for (let k = 1; k < N / 2; k += 2) {
    let re = 0, im = 0; const w = 2 * Math.PI * k / N;
    for (let i = 0; i < N; i++) { const x = d[i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / N)); re += x * Math.cos(w * i); im -= x * Math.sin(w * i); }
    const m = Math.hypot(re, im); num += m * k * SR / N; den += m;
  }
  return num / den;
}

test('swatter slap is a short bright "pets", not a ringing "plong"', () => {
  // walls, doors, wood, floor: over within 60 ms; glass and metal may ring briefly (a window pane does)
  for (const [m, maxDecay] of [['wall', 0.06], ['panel', 0.06], ['wood', 0.06], ['vinyl', 0.06], ['deck', 0.06], ['glass', 0.12], ['metal', 0.12]] as const) {
    const slap = synthSlap(m, 0, SR), thump = synthThump(m, 0, SR);
    assert.ok(decay30(slap) <= maxDecay, `${m}: slap rings ${decay30(slap).toFixed(3)} s`);
    assert.ok(decay30(slap) < decay30(thump) * 0.5, `${m}: slap ${decay30(slap).toFixed(3)} s vs knock ${decay30(thump).toFixed(3)} s`);
    assert.ok(centroid(slap) >= 1500, `${m}: slap centroid ${centroid(slap).toFixed(0)} Hz`);
  }
  // the knock of a struck object (used for a door falling shut, and until now for the swatter): long and dull
  const thump = synthThump('wall', 0, SR);
  assert.ok(decay30(thump) >= 0.15 && centroid(thump) < 700, `thump ${decay30(thump).toFixed(3)} s ${centroid(thump).toFixed(0)} Hz`);
});

test('slap on fabric is muffled; buffers are reproducible and peak-normalised', () => {
  assert.ok(centroid(synthSlap('fabric', 0, SR)) < centroid(synthSlap('wall', 0, SR)) * 0.6, 'fabric duller than wall');
  const a = synthSlap('wood', 2, SR), b = synthSlap('wood', 2, SR);
  assert.deepEqual(a, b);
  let pk = 0; for (const x of a) pk = Math.max(pk, Math.abs(x));
  assert.ok(Math.abs(pk - 1) < 1e-6 && Math.abs(a[a.length - 1]) < 1e-3, 'normalised, no click at the end');
});
