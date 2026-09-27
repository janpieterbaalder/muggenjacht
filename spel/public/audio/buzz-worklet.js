// Mosquito flight tone: harmonic wingbeat signal with slow drift, per-beat jitter and turbulence.
// Parameters are plausible design values (female house mosquito wingbeat ~350-500 Hz); the result
// must be judged by listening on the target phone, not from this code.
class Buzz extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'freq', defaultValue: 420, minValue: 100, maxValue: 1200, automationRate: 'k-rate' },
      { name: 'amp', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'effort', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }
  constructor(opts) {
    super();
    const seed = (opts && opts.processorOptions && opts.processorOptions.seed) || 1;
    this.rng = seed * 2654435761 % 4294967296;
    this.phase = 0; this.drift = 0; this.driftV = 0; this.jit = 0; this.env = 0; this.noiseLP = 0; this.noiseLP2 = 0;
    // harmonic amplitudes (spectral envelope) with per-insect variation
    this.h = [1, 0.62, 0.48, 0.30, 0.24, 0.16, 0.12, 0.08, 0.06, 0.045, 0.03, 0.02].map((a, i) => a * (1 + (this.rand() - 0.5) * 0.3 * (i > 0 ? 1 : 0)));
    this.hp = this.h.map(() => this.rand() * Math.PI * 2);
  }
  rand() { this.rng = (this.rng * 1664525 + 1013904223) % 4294967296; return this.rng / 4294967296; }
  process(_in, outputs, params) {
    const out = outputs[0][0];
    if (!out) return true;
    const f0 = params.freq[0], target = params.amp[0], effort = params.effort[0];
    const sr = sampleRate;
    const H = this.h, HP = this.hp;
    for (let i = 0; i < out.length; i++) {
      // amplitude smoothing
      this.env += (target - this.env) * 0.002;
      // slow random drift of wingbeat frequency (+-3 %), faster with effort
      if ((i & 31) === 0) {
        this.driftV += (this.rand() - 0.5) * 0.002 - this.drift * 0.0008;
        this.driftV *= 0.995;
        this.drift += this.driftV;
        this.jit += ((this.rand() - 0.5) * 0.02 - this.jit) * 0.08;
      }
      const f = f0 * (1 + this.drift * 0.03 + this.jit * 0.01 + effort * 0.06);
      this.phase += f / sr;
      if (this.phase > 1) this.phase -= 1;
      const p = this.phase * Math.PI * 2;
      let s = 0;
      for (let k = 0; k < H.length; k++) s += H[k] * Math.sin((k + 1) * p + HP[k]);
      // wing-stroke asymmetry: mild amplitude modulation at the beat
      s *= 0.86 + 0.14 * Math.sin(p + 0.7);
      // air turbulence
      const n = this.rand() * 2 - 1;
      this.noiseLP += (n - this.noiseLP) * 0.35; this.noiseLP2 += (this.noiseLP - this.noiseLP2) * 0.35;
      s += (this.noiseLP - this.noiseLP2) * 0.25;
      out[i] = s * this.env * 0.22;
    }
    return true;
  }
}
registerProcessor('mosquito-buzz', Buzz);
