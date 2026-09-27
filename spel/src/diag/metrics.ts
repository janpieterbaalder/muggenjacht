// Frame-time and event diagnostics. Labels are honest: automatic browser diagnostics, no device certification.
export class Metrics {
  frames: number[] = [];
  events: { t: number; name: string; data?: unknown }[] = [];
  private maxFrames = 120000;
  frame(ms: number) { if (this.frames.length < this.maxFrames) this.frames.push(Math.round(ms * 100) / 100); }
  event(name: string, data?: unknown) { if (this.events.length < 20000) this.events.push({ t: Math.round(performance.now()), name, data }); }
  percentile(p: number, skip = 120): number | null {
    const a = this.frames.slice(skip).sort((x, y) => x - y);
    if (!a.length) return null;
    return a[Math.min(a.length - 1, Math.ceil(a.length * p) - 1)];
  }
  summary() {
    return { n: this.frames.length, p50: this.percentile(0.5), p95: this.percentile(0.95), p99: this.percentile(0.99) };
  }
  export(extra: Record<string, unknown>) {
    const log = {
      created: new Date().toISOString(), userAgent: navigator.userAgent, viewport: [innerWidth, innerHeight], dpr: devicePixelRatio,
      physicalDeviceVerified: false, note: 'Automatische browserdiagnostiek; geen fysieke toestel-, thermiek- of invoerlatentiecertificering.',
      summary: this.summary(), frames: this.frames, events: this.events, ...extra,
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(log)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = `muggenjacht-diagnose-${Date.now()}.json`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
}
