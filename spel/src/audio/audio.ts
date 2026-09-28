// Web Audio engine: spatial mosquito buzz (worklet + HRTF panner + occlusion low-pass), small-room
// reverb, material-dependent swatter slaps and knocks (impact.ts), whoosh, footsteps, doors, ambience.
// All sounds are synthesised (no recordings). Hearing quality is NOT verified by code: listening
// test on the target phone is required (CONTROLEPROTOCOL: audio must be heard).

import { MODES, synthSlap, synthThump } from './impact';

export type Surface = 'wall' | 'floor' | 'wood' | 'panel' | 'metal' | 'glass' | 'fabric' | 'plastic' | 'ceramic' | 'vinyl' | 'deck' | 'grass' | 'pvc' | 'acrylic' | 'leaves' | 'plant' | '';
export const SURFACE_CLASSES: Surface[] = ['wall', 'floor', 'wood', 'panel', 'metal', 'glass', 'fabric', 'plastic', 'ceramic', 'vinyl', 'deck', 'grass', 'pvc', 'acrylic', 'leaves', 'plant', ''];

interface Voice { src: AudioWorkletNode | OscillatorNode; pan: PannerNode; occl: BiquadFilterNode; gain: GainNode; send: GainNode; worklet: boolean; }

const ALIAS: Record<string, string> = { floor: 'vinyl', pvc: 'plastic', grass: 'fabric', leaves: 'fabric', plant: 'fabric', '': 'panel' };

export class AudioEngine {
  ctx: AudioContext | null = null;
  master!: GainNode; sfx!: GainNode; amb!: GainNode; reverbIn!: GainNode; reverb!: ConvolverNode;
  enabled = true; volume = 0.9;
  private workletReady = false;
  private voices = new Map<number, Voice>();
  /** the swatter's slap and a struck object's knock, per material, a few variants each */
  private slaps = new Map<string, AudioBuffer[]>();
  private thumps = new Map<string, AudioBuffer[]>();
  private noise!: AudioBuffer;
  private ambNodes: AudioNode[] = [];
  private fridge: { osc: OscillatorNode[]; pan: PannerNode; g: GainNode } | null = null;

  async unlock() {
    if (this.ctx) { if (this.ctx.state !== 'running') await this.ctx.resume().catch(() => {}); return; }
    const Ctx = (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext);
    this.ctx = new Ctx({ latencyHint: 'interactive' });
    // resume synchronously in the gesture on iOS
    void this.ctx.resume().catch(() => {});
    const c = this.ctx;
    this.master = c.createGain(); this.master.gain.value = this.enabled ? this.volume : 0; this.master.connect(c.destination);
    this.sfx = c.createGain(); this.sfx.gain.value = 1; this.sfx.connect(this.master);
    this.amb = c.createGain(); this.amb.gain.value = 0.5; this.amb.connect(this.master);
    this.reverb = c.createConvolver(); this.reverb.buffer = this.roomIR(0.38, 0.9);
    this.reverbIn = c.createGain(); this.reverbIn.gain.value = 0.16; this.reverbIn.connect(this.reverb); this.reverb.connect(this.master);
    this.noise = this.makeNoise(2.0);
    this.thumpsFor('panel');                                                  // the door; others on first use
    // the slaps: one material per task after the tap (all of them in the tap made a cold start ~20 ms slower than
    // before); a slap needed sooner is built on the spot
    const todo = ['wall', 'wood', 'panel', ...Object.keys(MODES)];
    const fill = () => { let m = todo.shift(); while (m && this.slaps.has(m)) m = todo.shift(); if (m) { this.slapsFor(m); setTimeout(fill, 20); } };
    setTimeout(fill, 20);
    try {
      await c.audioWorklet.addModule(import.meta.env.BASE_URL + 'audio/buzz-worklet.js');
      this.workletReady = true;
    } catch { this.workletReady = false; }
  }

  setEnabled(v: boolean) { this.enabled = v; if (this.master) this.master.gain.setTargetAtTime(v ? this.volume : 0, this.ctx!.currentTime, 0.05); }
  setVolume(v: number) { this.volume = v; if (this.master && this.enabled) this.master.gain.setTargetAtTime(v, this.ctx!.currentTime, 0.05); }
  suspend() { void this.ctx?.suspend().catch(() => {}); }
  resume() { void this.ctx?.resume().catch(() => {}); }
  get ready() { return !!this.ctx && this.ctx.state === 'running'; }

  /** Listener pose (Babylon frame; Web Audio is right-handed with -z forward by default: matches). */
  listener(x: number, y: number, z: number, fx: number, fy: number, fz: number) {
    const c = this.ctx; if (!c) return;
    const L = c.listener, t = c.currentTime;
    if (L.positionX) {
      L.positionX.setTargetAtTime(x, t, 0.015); L.positionY.setTargetAtTime(y, t, 0.015); L.positionZ.setTargetAtTime(z, t, 0.015);
      L.forwardX.setTargetAtTime(fx, t, 0.015); L.forwardY.setTargetAtTime(fy, t, 0.015); L.forwardZ.setTargetAtTime(fz, t, 0.015);
      L.upX.setValueAtTime(0, t); L.upY.setValueAtTime(1, t); L.upZ.setValueAtTime(0, t);
    } else {
      (L as unknown as { setPosition(x: number, y: number, z: number): void }).setPosition(x, y, z);
      (L as unknown as { setOrientation(a: number, b: number, c: number, d: number, e: number, f: number): void }).setOrientation(fx, fy, fz, 0, 1, 0);
    }
  }

  private panner(): PannerNode {
    const p = this.ctx!.createPanner();
    p.panningModel = 'HRTF'; p.distanceModel = 'inverse'; p.refDistance = 0.3; p.rolloffFactor = 1.0; p.maxDistance = 12;
    return p;
  }

  /** Create/refresh a mosquito voice. occlusion 0 (clear) .. 1 (behind closed door/walls). */
  mosquito(id: number, on: boolean, x: number, y: number, z: number, freq: number, effort: number, occlusion: number) {
    const c = this.ctx; if (!c) return;
    let v = this.voices.get(id);
    if (!v) {
      const pan = this.panner();
      const occl = c.createBiquadFilter(); occl.type = 'lowpass'; occl.frequency.value = 12000; occl.Q.value = 0.5;
      const gain = c.createGain(); gain.gain.value = 0;
      const send = c.createGain(); send.gain.value = 0.35;
      let src: AudioWorkletNode | OscillatorNode;
      let worklet = false;
      if (this.workletReady) {
        src = new AudioWorkletNode(c, 'mosquito-buzz', { processorOptions: { seed: id * 7919 + 13 }, outputChannelCount: [1] });
        worklet = true;
      } else {
        const o = c.createOscillator(); o.type = 'sawtooth'; o.frequency.value = freq; o.start(); src = o;
      }
      src.connect(occl).connect(gain).connect(pan).connect(this.sfx);
      gain.connect(send).connect(this.reverbIn);
      v = { src, pan, occl, gain, send, worklet };
      this.voices.set(id, v);
    }
    const t = c.currentTime;
    if (v.pan.positionX) { v.pan.positionX.setTargetAtTime(x, t, 0.02); v.pan.positionY.setTargetAtTime(y, t, 0.02); v.pan.positionZ.setTargetAtTime(z, t, 0.02); }
    else (v.pan as unknown as { setPosition(a: number, b: number, c: number): void }).setPosition(x, y, z);
    const amp = on ? 1 : 0;
    if (v.worklet) {
      const w = v.src as AudioWorkletNode;
      w.parameters.get('freq')!.setValueAtTime(freq, t);
      w.parameters.get('amp')!.setValueAtTime(amp, t);
      w.parameters.get('effort')!.setValueAtTime(effort, t);
      v.gain.gain.setTargetAtTime(1 - occlusion * 0.75, t, 0.05);
    } else {
      (v.src as OscillatorNode).frequency.setTargetAtTime(freq, t, 0.05);
      v.gain.gain.setTargetAtTime(on ? 0.05 * (1 - occlusion * 0.75) : 0, t, 0.03);
    }
    v.occl.frequency.setTargetAtTime(12000 * Math.pow(0.08, occlusion), t, 0.05);
  }

  stopMosquito(id: number) {
    const v = this.voices.get(id); if (!v) return;
    try { v.gain.gain.setTargetAtTime(0, this.ctx!.currentTime, 0.01); } catch { /* ignore */ }
    setTimeout(() => { try { v.src.disconnect(); v.pan.disconnect(); v.gain.disconnect(); } catch { /* */ } }, 200);
    this.voices.delete(id);
  }
  stopAllMosquitoes() { for (const id of [...this.voices.keys()]) this.stopMosquito(id); }

  /** Swatter slap at world position; speed m/s; surface class. killed adds a tiny squash. */
  swat(surface: Surface, speed: number, x: number, y: number, z: number, killed = false) {
    const m = MODES[surface] ? surface : (ALIAS[surface] ?? 'panel');
    this.slapsFor(m);
    this.play(this.slaps, m, Math.min(1.3, 0.25 + speed / 9) * (m === 'fabric' ? 0.6 : 1), x, y, z);
    if (killed && this.ctx && this.enabled) this.noiseBurst(x, y, z, 5200, 3, 0.006, 0.05);
  }

  /** Knock of a struck object (a door falling shut). */
  private thump(surface: string, speed: number, x: number, y: number, z: number) {
    const m = MODES[surface] ? surface : 'panel';
    this.thumpsFor(m);
    this.play(this.thumps, m, Math.min(1.3, 0.25 + speed / 9), x, y, z);
  }

  private slapsFor(m: string) {
    if (this.ctx && !this.slaps.has(m)) this.slaps.set(m, [0, 1, 2].map((k) => this.buffer(synthSlap(m, k, this.ctx!.sampleRate))));
  }

  private thumpsFor(m: string) {
    if (this.ctx && !this.thumps.has(m)) this.thumps.set(m, [0, 1, 2].map((k) => this.buffer(synthThump(m, k, this.ctx!.sampleRate))));
  }

  private buffer(d: Float32Array): AudioBuffer {
    const b = this.ctx!.createBuffer(1, d.length, this.ctx!.sampleRate); b.getChannelData(0).set(d); return b;
  }

  private play(set: Map<string, AudioBuffer[]>, m: string, gain: number, x: number, y: number, z: number) {
    const c = this.ctx; if (!c || !this.enabled) return;
    const bufs = set.get(m) ?? set.get('panel')!;
    const src = c.createBufferSource(); src.buffer = bufs[Math.floor(Math.random() * bufs.length)];
    src.playbackRate.value = 0.94 + Math.random() * 0.12;
    const g = c.createGain(); g.gain.value = gain;
    const p = this.panner(); p.refDistance = 0.5;
    this.setPos(p, x, y, z);
    src.connect(g).connect(p).connect(this.sfx); g.connect(this.reverbIn);
    src.start();
  }

  whoosh(speed: number, x: number, y: number, z: number) {
    const c = this.ctx; if (!c || !this.enabled) return;
    const src = c.createBufferSource(); src.buffer = this.noise;
    const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 0.9;
    const t = c.currentTime;
    bp.frequency.setValueAtTime(500, t); bp.frequency.exponentialRampToValueAtTime(1800 + speed * 120, t + 0.09); bp.frequency.exponentialRampToValueAtTime(700, t + 0.22);
    const g = c.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(Math.min(0.25, 0.04 + speed * 0.02), t + 0.08); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.26);
    const p = this.panner(); this.setPos(p, x, y, z);
    src.connect(bp).connect(g).connect(p).connect(this.sfx);
    src.start(t, Math.random() * 1.5); src.stop(t + 0.3);
  }

  footstep(surface: 'vinyl' | 'deck' | 'grass', x: number, y: number, z: number) {
    const c = this.ctx; if (!c || !this.enabled) return;
    const t = c.currentTime;
    const o = c.createOscillator(); o.type = 'sine';
    const base = surface === 'deck' ? 150 : surface === 'grass' ? 90 : 70;
    o.frequency.setValueAtTime(base * 1.6, t); o.frequency.exponentialRampToValueAtTime(base, t + 0.06);
    const g = c.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(surface === 'deck' ? 0.10 : 0.045, t + 0.008); g.gain.exponentialRampToValueAtTime(0.0001, t + (surface === 'deck' ? 0.12 : 0.08));
    const p = this.panner(); p.refDistance = 1; this.setPos(p, x, y, z);
    o.connect(g).connect(p).connect(this.sfx); o.start(t); o.stop(t + 0.15);
    if (surface !== 'vinyl' || Math.random() < 0.18) this.noiseBurst(x, y, z, surface === 'grass' ? 3500 : 900, 0.7, 0.03, surface === 'grass' ? 0.03 : 0.02);
  }

  door(open: boolean, x: number, y: number, z: number) {
    const c = this.ctx; if (!c || !this.enabled) return;
    this.noiseBurst(x, y, z, 2200, 4, 0.02, 0.08);                       // latch click
    const t = c.currentTime;
    if (!open) setTimeout(() => this.thump('panel', 2.2, x, y, z), 240);  // closing thump
    const o = c.createOscillator(); o.type = 'triangle';
    o.frequency.setValueAtTime(open ? 380 : 300, t + 0.05); o.frequency.linearRampToValueAtTime(open ? 520 : 260, t + 0.35);
    const g = c.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.012, t + 0.1); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
    const p = this.panner(); this.setPos(p, x, y, z);
    o.connect(g).connect(p).connect(this.sfx); o.start(t); o.stop(t + 0.45);
  }

  bite() { this.noiseBurst(0, 0, 0, 3000, 2, 0.01, 0.03, true); }

  /** Outdoor ambience (wind/leaves) + distant birds; indoor level via 'inside' (0..1). Fridge hum in kitchen. */
  startAmbience(state: string) {
    const c = this.ctx; if (!c) return;
    this.stopAmbience();
    const src = c.createBufferSource(); src.buffer = this.noise; src.loop = true;
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = state === 'nacht' ? 700 : 1400;
    const hp = c.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 120;
    const g = c.createGain(); g.gain.value = state === 'nacht' ? 0.02 : 0.035;
    const lfo = c.createOscillator(); lfo.frequency.value = 0.08; const lg = c.createGain(); lg.gain.value = 0.015; lfo.connect(lg).connect(g.gain); lfo.start();
    src.connect(hp).connect(lp).connect(g).connect(this.amb); src.start();
    this.ambNodes.push(src, lfo);
    // fridge hum (kitchen, Babylon coords)
    const fp = this.panner(); fp.refDistance = 0.6; this.setPos(fp, 6.1, 0.8, -0.35);
    const fg = c.createGain(); fg.gain.value = 0.012;
    const osc = [50, 100, 150, 300].map((f, i) => { const o = c.createOscillator(); o.frequency.value = f * (1 + (Math.random() - 0.5) * 0.002); const og = c.createGain(); og.gain.value = [1, 0.5, 0.3, 0.12][i]; o.connect(og).connect(fg); o.start(); return o; });
    fg.connect(fp).connect(this.sfx);
    this.fridge = { osc, pan: fp, g: fg };
    this.scheduleBird(state);
  }
  private birdTimer = 0;
  private scheduleBird(state: string) {
    clearTimeout(this.birdTimer);
    if (state === 'nacht') return;
    this.birdTimer = window.setTimeout(() => { this.bird(); this.scheduleBird(state); }, 4000 + Math.random() * 9000);
  }
  private bird() {
    const c = this.ctx; if (!c || !this.enabled) return;
    const t = c.currentTime;
    const p = this.panner(); p.refDistance = 4; const ang = Math.random() * Math.PI * 2;
    this.setPos(p, 4 + Math.cos(ang) * 9, 3, -2 + Math.sin(ang) * 9);
    const n = 2 + Math.floor(Math.random() * 4);
    for (let i = 0; i < n; i++) {
      const o = c.createOscillator(); o.type = 'sine';
      const f0 = 2600 + Math.random() * 1800, st = t + i * (0.11 + Math.random() * 0.08);
      o.frequency.setValueAtTime(f0, st); o.frequency.exponentialRampToValueAtTime(f0 * (0.7 + Math.random() * 0.6), st + 0.07);
      const g = c.createGain(); g.gain.setValueAtTime(0.0001, st); g.gain.exponentialRampToValueAtTime(0.01, st + 0.012); g.gain.exponentialRampToValueAtTime(0.0001, st + 0.08);
      o.connect(g).connect(p).connect(this.amb); o.start(st); o.stop(st + 0.1);
    }
  }
  stopAmbience() {
    for (const n of this.ambNodes) { try { (n as AudioScheduledSourceNode).stop(); } catch { /* */ } }
    this.ambNodes = [];
    if (this.fridge) { for (const o of this.fridge.osc) { try { o.stop(); } catch { /* */ } } this.fridge = null; }
    clearTimeout(this.birdTimer);
  }
  /** Walls/doors between listener and outdoor ambience or fridge. */
  setInside(inside: number, kitchenOcclusion: number) {
    if (!this.ctx) return;
    this.amb.gain.setTargetAtTime(0.5 * (1 - inside * 0.7), this.ctx.currentTime, 0.2);
    if (this.fridge) this.fridge.g.gain.setTargetAtTime(0.012 * (1 - kitchenOcclusion * 0.8), this.ctx.currentTime, 0.2);
  }
  setRoomAcoustics(room: string) {
    if (!this.ctx) return;
    const wet = room === 'bad' ? 0.3 : room === 'wc' ? 0.26 : room === 'buiten' ? 0.04 : room.startsWith('kind') || room === 'ouder' ? 0.1 : 0.15;
    this.reverbIn.gain.setTargetAtTime(wet, this.ctx.currentTime, 0.3);
  }

  // ------------------------------------------------------------------ synthesis helpers
  private setPos(p: PannerNode, x: number, y: number, z: number) {
    if (p.positionX) { p.positionX.value = x; p.positionY.value = y; p.positionZ.value = z; }
    else (p as unknown as { setPosition(a: number, b: number, c: number): void }).setPosition(x, y, z);
  }
  private makeNoise(sec: number): AudioBuffer {
    const c = this.ctx!, n = Math.floor(c.sampleRate * sec), b = c.createBuffer(1, n, c.sampleRate), d = b.getChannelData(0);
    let pink = 0;
    for (let i = 0; i < n; i++) { const w = Math.random() * 2 - 1; pink = 0.97 * pink + 0.03 * w; d[i] = w * 0.5 + pink * 3; }
    return b;
  }
  private noiseBurst(x: number, y: number, z: number, freq: number, q: number, dur: number, amp: number, head = false) {
    const c = this.ctx!, t = c.currentTime;
    const src = c.createBufferSource(); src.buffer = this.noise;
    const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = freq; bp.Q.value = q;
    const g = c.createGain(); g.gain.setValueAtTime(amp, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur * 4);
    src.connect(bp).connect(g);
    if (head) g.connect(this.sfx);
    else { const p = this.panner(); this.setPos(p, x, y, z); g.connect(p).connect(this.sfx); }
    src.start(t, Math.random()); src.stop(t + dur * 4 + 0.02);
  }
  private roomIR(rt: number, bright: number): AudioBuffer {
    const c = this.ctx!, sr = c.sampleRate, n = Math.floor(sr * rt * 1.2), b = c.createBuffer(2, n, sr);
    for (let ch = 0; ch < 2; ch++) {
      const d = b.getChannelData(ch); let lp = 0;
      for (let i = 0; i < n; i++) {
        const t = i / sr; const w = Math.random() * 2 - 1; lp += (w - lp) * (0.2 + 0.6 * bright * Math.exp(-t * 6));
        d[i] = lp * Math.exp(-6.9 * t / rt) * (i < sr * 0.004 ? 0 : 1);
      }
    }
    return b;
  }
}
