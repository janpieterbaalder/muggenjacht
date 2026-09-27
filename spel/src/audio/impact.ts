// Offline synthesis of impact sounds (no Web Audio dependency, unit-tested): the swatter's slap and the knock of a
// struck object (door, surface). Mono Float32 buffers normalised to a peak of 1; the engine plays them positioned.

/** Modal parameters of struck surfaces: [freqHz, decaySec, amp]. */
export const MODES: Record<string, [number, number, number][]> = {
  wall: [[118, 0.10, 1], [176, 0.08, 0.7], [262, 0.06, 0.5], [410, 0.04, 0.3], [1250, 0.012, 0.25]],
  panel: [[210, 0.07, 1], [330, 0.05, 0.6], [520, 0.04, 0.4], [1600, 0.01, 0.25]],
  wood: [[320, 0.06, 1], [540, 0.045, 0.7], [890, 0.03, 0.4], [1900, 0.012, 0.3]],
  glass: [[1450, 0.13, 0.6], [2380, 0.11, 0.8], [3700, 0.08, 0.5], [5200, 0.05, 0.3], [260, 0.04, 0.35]],
  metal: [[680, 0.28, 0.6], [1180, 0.24, 0.8], [1960, 0.2, 0.6], [3150, 0.14, 0.4]],
  plastic: [[820, 0.035, 0.8], [1450, 0.03, 0.6], [2600, 0.015, 0.4]],
  ceramic: [[1100, 0.09, 0.7], [1870, 0.07, 0.6], [3100, 0.05, 0.4]],
  acrylic: [[560, 0.05, 0.8], [980, 0.04, 0.6], [1700, 0.02, 0.4]],
  fabric: [[140, 0.03, 0.6], [260, 0.025, 0.4]],
  vinyl: [[160, 0.05, 0.8], [300, 0.04, 0.5], [900, 0.012, 0.3]],
  deck: [[190, 0.07, 1], [360, 0.05, 0.6], [700, 0.03, 0.4]],
};

/** Seeded noise (reproducible buffers). */
function prng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
function hash(str: string): number { let h = 2166136261; for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619); return h >>> 0; }

function normalise(d: Float32Array, peak = 1): Float32Array {
  let mx = 0; for (let i = 0; i < d.length; i++) mx = Math.max(mx, Math.abs(d[i]));
  const k = mx > 0 ? peak / mx : 0; for (let i = 0; i < d.length; i++) d[i] *= k;
  return d;
}

/** RBJ biquad, in place: 'hp' / 'lp' (q) or 'peak' (q, gain dB). */
function biquad(d: Float32Array, type: 'hp' | 'lp' | 'peak', f: number, q: number, sr: number, gainDb = 0): Float32Array {
  const w = 2 * Math.PI * Math.min(f, sr * 0.45) / sr, cw = Math.cos(w), al = Math.sin(w) / (2 * q), A = Math.pow(10, gainDb / 40);
  let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number;
  if (type === 'lp') { b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = b0; a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al; }
  else if (type === 'hp') { b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = b0; a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al; }
  else { b0 = 1 + al * A; b1 = -2 * cw; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * cw; a2 = 1 - al / A; }
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < d.length; i++) {
    const x = d[i], y = (b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1; x1 = x; y2 = y1; y1 = y; d[i] = y;
  }
  return d;
}

/** Knock of a struck object: its modes ringing out (door closing, a thump). */
export function synthThump(material: string, variant: number, sr: number): Float32Array {
  const n = Math.floor(sr * 0.45), d = new Float32Array(n), rnd = prng(hash(material) ^ Math.imul(variant + 1, 2654435761));
  for (const [f, dec, a] of MODES[material] ?? MODES.panel) {
    const ff = f * (1 + (rnd() - 0.5) * 0.08), ph = rnd() * 6.28;
    for (let i = 0; i < n; i++) { const t = i / sr; d[i] += a * Math.exp(-t / dec) * Math.sin(2 * Math.PI * ff * t + ph); }
  }
  // contact transient
  const nt = Math.floor(sr * 0.004);
  for (let i = 0; i < nt; i++) d[i] += (rnd() * 2 - 1) * (1 - i / nt) * 0.8;
  return normalise(d);
}

interface SlapShape { hp: number; peak: number; lp: number; hiss: number; body: number; bodyDecay: number; }
const SLAP: SlapShape = { hp: 300, peak: 2400, lp: 5500, hiss: 0.12, body: 0.25, bodyDecay: 0.2 };
/** Per surface: hard, ringing materials keep a little more of their own sound; soft ones muffle the slap. */
const SLAP_BY: Record<string, Partial<SlapShape>> = {
  glass: { body: 0.4, bodyDecay: 0.3 }, ceramic: { body: 0.35, bodyDecay: 0.3 }, metal: { body: 0.3, bodyDecay: 0.15 },
  acrylic: { body: 0.35, bodyDecay: 0.4 }, plastic: { body: 0.3, bodyDecay: 0.4 },
  fabric: { hp: 150, peak: 900, lp: 1600, hiss: 0.05, body: 0.35, bodyDecay: 0.6 },
};

/** The swatter's slap: a "pets", not a tone. The flat perforated plastic face meets the surface in a broadband crack
 * of a few milliseconds (the plate and the air pressed out through its holes), the flexing head slaps a second time
 * a few ms later, a short hiss of air follows; the struck surface adds only a brief, damped knock - the face lying on
 * it damps its ringing. (Before, the struck surface's ringing modes dominated: a hollow 'plong'.) */
export function synthSlap(material: string, variant: number, sr: number): Float32Array {
  const sh = { ...SLAP, ...SLAP_BY[material] };
  const n = Math.floor(sr * 0.22), rnd = prng(hash('slap' + material) ^ Math.imul(variant + 1, 2654435761));
  const noise = () => rnd() * 2 - 1;
  // crack + second slap of the flexing head
  const t2 = 0.004 + 0.003 * rnd(), a2 = 0.35 + 0.2 * rnd();
  const env = (t: number) => (t < 0 ? 0 : (1 - Math.exp(-t / 0.0003)) * (Math.exp(-t / 0.0025) + 0.22 * Math.exp(-t / 0.016)));
  const crack = new Float32Array(n);
  for (let i = 0; i < n; i++) { const t = i / sr; crack[i] = noise() * (env(t) + a2 * env(t - t2)); }
  biquad(crack, 'hp', sh.hp, 0.7, sr); biquad(crack, 'peak', sh.peak, 1.0, sr, 8); biquad(crack, 'lp', sh.lp, 0.7, sr); biquad(crack, 'lp', sh.lp, 0.7, sr);
  normalise(crack);
  // "ts": air hissing out of the mesh
  const hiss = new Float32Array(n);
  for (let i = 0; i < n; i++) { const t = i / sr; hiss[i] = noise() * (1 - Math.exp(-t / 0.001)) * Math.exp(-t / 0.018); }
  biquad(hiss, 'hp', material === 'fabric' ? 1500 : 3000, 0.7, sr); biquad(hiss, 'lp', 9000, 0.7, sr);
  normalise(hiss, sh.hiss);
  // the struck surface: its own modes, heavily damped
  const body = new Float32Array(n);
  for (const [f, dec, a] of MODES[material] ?? MODES.panel) {
    const ff = f * (1 + (rnd() - 0.5) * 0.06), ph = rnd() * 6.28, dd = dec * sh.bodyDecay;
    for (let i = 0; i < n; i++) { const t = i / sr; body[i] += a * (1 - Math.exp(-t / 0.0015)) * Math.exp(-t / dd) * Math.sin(2 * Math.PI * ff * t + ph); }
  }
  normalise(body, sh.body);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = crack[i] + hiss[i] + body[i];
  // fade out the last 10 ms (no click at the end of the buffer)
  const nf = Math.floor(sr * 0.01);
  for (let i = 0; i < nf; i++) out[n - 1 - i] *= i / nf;
  return normalise(out);
}
