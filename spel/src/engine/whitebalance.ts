// Camera-like white balance using Babylon's built-in image-processing white balance (Bradford chromatic
// adaptation from a correlated colour temperature + green/magenta tint, applied before exposure and tone
// mapping for every material). The illuminant is measured from the bake (illum.json: irradiance on floor and
// ceiling per room); this module converts its colour to temperature/tint with partial adaptation - the
// reference photos R01-R11 are white-balanced by the phone camera.
import { TemperatureTintToXyz } from '@babylonjs/core/Maths/colorTemperature.functions';

/** Linear sRGB (D65) -> CIE XYZ. */
function rgbToXyz(r: number, g: number, b: number): [number, number, number] {
  return [0.4124 * r + 0.3576 * g + 0.1805 * b, 0.2126 * r + 0.7152 * g + 0.0722 * b, 0.0193 * r + 0.1192 * g + 0.9505 * b];
}
const xy = (X: number, Y: number, Z: number): [number, number] => { const s = X + Y + Z || 1; return [X / s, Y / s]; };
function locusXy(T: number, tint: number): [number, number] { const v = TemperatureTintToXyz(T, tint); return xy(v.x, v.y, v.z); }

// The white of the working space (1,1,1) and Babylon's own 6500 K point differ slightly (D65 vs Planckian
// locus); targets are expressed relative to that offset so a neutral illuminant gives exactly 6500 K / 0.
const W_RGB = xy(...rgbToXyz(1, 1, 1));
const W_LOCUS = locusXy(6500, 0);

/** Correlated temperature (K) and tint of an illuminant given in linear RGB (any scale). */
export function illuminantToTemperatureTint(rgb: [number, number, number]): { temperature: number; tint: number } {
  const [x0, y0] = xy(...rgbToXyz(rgb[0], rgb[1], rgb[2]));
  const tx = x0 - W_RGB[0] + W_LOCUS[0], ty = y0 - W_RGB[1] + W_LOCUS[1];
  let best = { temperature: 6500, tint: 0 }, bd = Infinity;
  const test = (m: number, t: number) => {
    const T = 1e6 / m;
    const [x, y] = locusXy(T, t);
    const d = (x - tx) ** 2 + (y - ty) ** 2;
    if (d < bd) { bd = d; best = { temperature: T, tint: t }; }
  };
  for (let m = 60; m <= 580; m += 10) for (let t = -150; t <= 150; t += 10) test(m, t);   // coarse, in mired
  for (let step = 4; step >= 0.25; step /= 2) {
    const m0 = 1e6 / best.temperature, t0 = best.tint;
    for (let dm = -2; dm <= 2; dm++) for (let dt = -2; dt <= 2; dt++) test(Math.max(60, Math.min(580, m0 + dm * step)), Math.max(-150, Math.min(150, t0 + dt * step)));
  }
  return best;
}

/** Partial chromatic adaptation: move from neutral (6500 K, 0) toward the illuminant, in mired / tint units. The
 * green-magenta axis may be corrected less than warm-cool (tintAdaptation), as cameras do: a room lit partly by light
 * bounced off the lawn outside turned magenta when its green was fully removed (REVIEW-01 G-05, R07). */
export function adaptTemperatureTint(full: { temperature: number; tint: number }, adaptation: number, tintAdaptation = adaptation) {
  const m = 1e6 / 6500 + (1e6 / full.temperature - 1e6 / 6500) * adaptation;
  return { temperature: 1e6 / m, tint: full.tint * tintAdaptation };
}
