// Versioned local progress with safe fallback, export and import. No account, nothing leaves the device.
export interface RoundRecord { bestTime: number; bestSwings: number; bites: number; }
export interface SaveData {
  schema: 2;
  settings: { sound: boolean; volume: number; leftHanded: boolean; sensitivity: number; invertY: boolean; headBob: boolean; help: 'uit' | 'licht' | 'veel'; quality: string };
  progress: { completed: string[]; records: Record<string, RoundRecord>; lastRound: number };
}
const KEY = 'muggenjacht-save';

export function defaults(): SaveData {
  return {
    schema: 2,
    settings: { sound: true, volume: 0.9, leftHanded: false, sensitivity: 1, invertY: false, headBob: true, help: 'licht', quality: 'normaal' },
    progress: { completed: [], records: {}, lastRound: 0 },
  };
}

/** Validate/migrate untrusted JSON; returns null when unusable. */
export function parseSave(raw: string | null): SaveData | null {
  if (!raw) return null;
  let d: unknown;
  try { d = JSON.parse(raw); } catch { return null; }
  if (!d || typeof d !== 'object') return null;
  const o = d as Record<string, unknown>;
  const base = defaults();
  if (o.schema !== 1 && o.schema !== 2) return null;
  const s = (o.settings ?? {}) as Record<string, unknown>;
  const p = (o.progress ?? {}) as Record<string, unknown>;
  const num = (v: unknown, lo: number, hi: number, def: number) => (typeof v === 'number' && isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def);
  const bool = (v: unknown, def: boolean) => (typeof v === 'boolean' ? v : def);
  base.settings = {
    sound: bool(s.sound, true), volume: num(s.volume, 0, 1, 0.9), leftHanded: bool(s.leftHanded, false), sensitivity: num(s.sensitivity, 0.4, 2.2, 1),
    invertY: bool(s.invertY, false), headBob: bool(s.headBob, true), help: s.help === 'uit' || s.help === 'veel' ? s.help : 'licht',
    quality: typeof s.quality === 'string' && ['hoog', 'normaal', 'licht'].includes(s.quality) ? s.quality : 'normaal',
  };
  const done = Array.isArray(p.completed) ? p.completed.filter((x) => typeof x === 'string' && /^r(10|[1-9])$/.test(x)) : [];
  base.progress.completed = [...new Set(done as string[])];
  const recs = (p.records ?? {}) as Record<string, unknown>;
  for (const [k, v] of Object.entries(recs)) {
    if (!/^r(10|[1-9])$/.test(k) || !v || typeof v !== 'object') continue;
    const r = v as Record<string, unknown>;
    base.progress.records[k] = { bestTime: num(r.bestTime, 0, 36000, 0), bestSwings: num(r.bestSwings, 0, 9999, 0), bites: num(r.bites, 0, 999, 0) };
  }
  base.progress.lastRound = Math.round(num(p.lastRound, 0, 9, 0));
  return base;
}

export class Save {
  data: SaveData = defaults();
  constructor() {
    try { this.data = parseSave(localStorage.getItem(KEY)) ?? defaults(); } catch { this.data = defaults(); }
  }
  write() { try { localStorage.setItem(KEY, JSON.stringify(this.data)); } catch { /* private mode: keep in memory */ } }
  nextRound(): number {
    for (let i = 0; i < 10; i++) if (!this.data.progress.completed.includes(`r${i + 1}`)) return i;
    return this.data.progress.lastRound;
  }
  complete(id: string, time: number, swings: number, bites: number) {
    if (!this.data.progress.completed.includes(id)) this.data.progress.completed.push(id);
    const r = this.data.progress.records[id];
    if (!r || time < r.bestTime || r.bestTime === 0) this.data.progress.records[id] = { bestTime: time, bestSwings: swings, bites };
    this.write();
  }
  exportFile() {
    const url = URL.createObjectURL(new Blob([JSON.stringify(this.data, null, 1)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = 'nog-een-mug-voortgang.json'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  importText(t: string): boolean { const d = parseSave(t); if (!d) return false; this.data = d; this.write(); return true; }
}
