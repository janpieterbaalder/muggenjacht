// Per-frame exposure and white balance without re-checking every material (REVIEW-01 G-03).
// Eye adaptation changes exposure, temperature and tint every frame. Babylon's setters notify all materials
// ("image processing dirty"): ~280 materials then re-evaluate their defines, ~16 ms CPU per frame on a desktop.
// The shaders only read these values at bind time (ImageProcessingConfiguration.bind: exposureLinear and the
// white-balance matrix, rebound on every draw of a non-frozen material), so once the defines are on (EXPOSURE:
// exposure != 1, WHITEBALANCE: enabled) the values can be written without a notification.
import type { ImageProcessingConfiguration } from '@babylonjs/core/Materials/imageProcessingConfiguration';

type Fields = { _exposure: number; _temperature: number; _tint: number };

/** Babylon's clamps (colorTemperature.functions: MinTemperatureKelvin ~1667 K, MaxTintMagnitude 150). */
const MIN_K = 1667, MAX_TINT = 150;

/** Set exposure (and optionally white balance) of a configuration, notifying materials only when a define changes. */
export function setImageProcessingQuiet(ip: ImageProcessingConfiguration, exposure: number, temperature?: number, tint?: number) {
  const p = ip as unknown as Fields;
  // EXPOSURE is compiled in only for exposure != 1: crossing 1.0 exactly must go through the setter (once)
  if (p._exposure === 1 || exposure === 1 || !Number.isFinite(p._exposure)) ip.exposure = exposure;
  else p._exposure = exposure;
  if (temperature === undefined && tint === undefined) return;
  if (!ip.whiteBalanceEnabled) {
    ip.whiteBalanceEnabled = true;
    if (temperature !== undefined) ip.temperature = temperature;
    if (tint !== undefined) ip.tint = tint;
    return;
  }
  if (temperature !== undefined) p._temperature = Number.isNaN(temperature) ? MIN_K : Math.max(MIN_K, temperature);
  if (tint !== undefined) p._tint = Math.max(-MAX_TINT, Math.min(MAX_TINT, tint));
}
