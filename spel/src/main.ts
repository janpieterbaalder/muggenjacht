import './style.css';
import { BUILD, COMFORT } from './game/build';
import type { Core } from './game/core';
import type { Session } from './game/session';
import { ROUNDS } from './game/rounds';
import { Save } from './game/save';
import { AudioEngine } from './audio/audio';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('world');
const hud = $('hud');
$('buildid').textContent = BUILD;

if (!canvas.getContext('webgl2')) {
  $('error').textContent = 'Deze browser ondersteunt geen WebGL 2. Open de link in een actuele Safari of Chrome.';
}

const save = new Save();
const audio = new AudioEngine();
let core: Core | null = null;
let session: Session | null = null;
let loading: Promise<void> | null = null;

function show(id: string | null) {
  for (const s of ['menu', 'roundsel', 'settingsdlg', 'howtodlg', 'pausedlg', 'resultdlg']) $(s).hidden = s !== id;
}
function isPortrait() { return matchMedia('(pointer: coarse)').matches && innerHeight > innerWidth; }
function updateRotate() {
  const p = isPortrait();
  $('rotate').hidden = !p;
  if (p && session?.active) pause();
}
addEventListener('resize', updateRotate); updateRotate();

function applySettings() {
  const s = save.data.settings;
  ($('opt-sound') as HTMLInputElement).checked = s.sound;
  ($('opt-volume') as HTMLInputElement).value = String(s.volume);
  ($('opt-left') as HTMLInputElement).checked = s.leftHanded;
  ($('opt-sens') as HTMLInputElement).value = String(s.sensitivity);
  ($('opt-invert') as HTMLInputElement).checked = s.invertY;
  ($('opt-bob') as HTMLInputElement).checked = s.headBob;
  ($('opt-help') as HTMLSelectElement).value = s.help;
  ($('opt-quality') as HTMLSelectElement).value = s.quality;
  hud.classList.toggle('left', s.leftHanded);
  COMFORT.headBob = s.headBob;
  audio.setEnabled(s.sound); audio.setVolume(s.volume);
  if (core) {
    core.input.opts.leftHanded = s.leftHanded; core.input.opts.lookSensitivity = s.sensitivity; core.input.opts.invertY = s.invertY;
    core.setQuality(s.quality);
  }
  session?.setHelp(s.help);
}
function readSettings() {
  const s = save.data.settings;
  s.sound = ($('opt-sound') as HTMLInputElement).checked;
  s.volume = Number(($('opt-volume') as HTMLInputElement).value);
  s.leftHanded = ($('opt-left') as HTMLInputElement).checked;
  s.sensitivity = Number(($('opt-sens') as HTMLInputElement).value);
  s.invertY = ($('opt-invert') as HTMLInputElement).checked;
  s.headBob = ($('opt-bob') as HTMLInputElement).checked;
  s.help = ($('opt-help') as HTMLSelectElement).value as typeof s.help;
  s.quality = ($('opt-quality') as HTMLSelectElement).value;
  save.write(); applySettings();
}
for (const id of ['opt-sound', 'opt-volume', 'opt-left', 'opt-sens', 'opt-invert', 'opt-bob', 'opt-help', 'opt-quality']) $(id).addEventListener('change', readSettings);
applySettings();

async function ensureLoaded() {
  if (core) return;
  if (!loading) {
    loading = (async () => {
      $('loadbar').hidden = false; $('loadlabel').textContent = 'Spel laden';
      // the engine is fetched only now: the start screen itself stays light (G-17)
      const [{ Core }, { Session }] = await Promise.all([import('./game/core'), import('./game/session')]);
      const c = new Core(canvas, hud, $('swat'), $('door'));
      c.engine.onContextLostObservable.add(() => contextLost());
      await c.load((f, label) => { $('loadfill').style.right = `${(1 - f) * 100}%`; $('loadlabel').textContent = label; });
      core = c;
      session = new Session(core, audio, save, {
        onRoundEnd: (res) => showResult(res), onToast: toast, onObjective: (a, b) => { $('roundlabel').textContent = a; $('objective').textContent = b; },
        onHint: (h) => { $('hint').textContent = h; }, onBites: (n) => { $('bites').textContent = n ? '●'.repeat(Math.min(n, 8)) + ' beten' : ''; },
        onDoorCtx: (label) => { const b = $('door'); b.hidden = !label; if (label) b.textContent = label; $('crosshair').classList.toggle('target', !!label); },
      });
      c.input.onStick = (on, ox, oy, dx, dy) => {
        const st = $('stick'); st.classList.toggle('on', on);
        if (on) { st.style.left = `${ox}px`; st.style.top = `${oy}px`; $('stickknob').style.transform = `translate(${dx}px, ${dy}px)`; }
      };
      applySettings();
      $('loadbar').hidden = true;
      (window as unknown as { muggenjacht: unknown }).muggenjacht = diagnostics();
    })();
  }
  await loading;
}

/** WebGL context lost (iOS: app switch, locking, memory pressure). Pause and restart the page cleanly once the browser
 * gives the context back - Babylon's own restore left a blank view (REVIEW-01 G-04). The interrupted round is offered
 * again after the reload (progress of finished rounds is saved already). */
const RESUME_KEY = 'muggenjacht-hervat';
let lost = false;
function contextLost() {
  if (lost) return;
  lost = true;
  try { if (session?.active) sessionStorage.setItem(RESUME_KEY, JSON.stringify({ round: session.roundIndex, practice: session.practice })); } catch { /* private mode */ }
  session?.pause(); core?.engine.stopRenderLoop();
  hud.hidden = true; show(null); $('lost').hidden = false;
}
canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); contextLost(); });
canvas.addEventListener('webglcontextrestored', () => location.reload());
$('lostreload').onclick = () => location.reload();
function offerResume() {
  let r: { round: number; practice: boolean } | null = null;
  try { r = JSON.parse(sessionStorage.getItem(RESUME_KEY) ?? 'null'); } catch { r = null; }
  if (!r || !ROUNDS[r.round]) return;
  const b = $('play');
  b.textContent = r.practice ? 'Verder oefenen' : `Verder met ronde ${r.round + 1}`;
  b.onclick = () => { try { sessionStorage.removeItem(RESUME_KEY); } catch { /* ignore */ } startRound(r!.round, r!.practice); };
}

async function startRound(index: number, practice = false) {
  try {
    $('error').textContent = '';
    await audio.unlock();              // must run inside the user gesture
    await ensureLoaded();
    show(null); hud.hidden = false;
    session!.start(index, practice);
  } catch (e) {
    console.error(e);
    $('error').textContent = `Het chalet kon niet laden. Probeer opnieuw. ${e instanceof Error ? e.message : ''}`;
    $('loadbar').hidden = true; loading = null;
  }
}

function pause() {
  if (!session?.active) return;
  session.pause(); hud.hidden = true; show('pausedlg');
}
function resume() {
  if (isPortrait()) return;
  show(null); hud.hidden = false; session?.resume();
}
let toastTimer = 0;
function toast(msg: string, ms = 1800) {
  const t = $('toast'); t.textContent = msg; t.classList.add('on');
  clearTimeout(toastTimer); toastTimer = window.setTimeout(() => t.classList.remove('on'), ms);
}
function showResult(res: { title: string; text: string; next: number | null; eyebrow: string }) {
  hud.hidden = true;
  $('res-title').textContent = res.title; $('res-text').textContent = res.text; $('res-eyebrow').textContent = res.eyebrow;
  const nb = $('res-next'); nb.hidden = res.next === null;
  nb.onclick = () => res.next !== null && startRound(res.next);
  $('res-again').onclick = () => startRound(session!.roundIndex, session!.practice);
  show('resultdlg');
}

function renderRoundList() {
  const list = $('roundlist'); list.innerHTML = '';
  ROUNDS.forEach((r, i) => {
    const b = document.createElement('button');
    const done = save.data.progress.completed.includes(r.id);
    b.disabled = i > 0 && !save.data.progress.completed.includes(ROUNDS[i - 1].id) && !done;
    b.innerHTML = `<b>${i + 1}. ${r.title}</b>${r.place}${done ? ' · ✓' : ''}`;
    b.onclick = () => startRound(i);
    list.appendChild(b);
  });
}

$('play').onclick = () => startRound(save.nextRound());
offerResume();
$('practice').onclick = () => startRound(0, true);
$('rounds').onclick = () => { renderRoundList(); show('roundsel'); };
$('settings').onclick = () => show('settingsdlg');
$('howto').onclick = () => show('howtodlg');
$('pause').onclick = pause;
$('resume').onclick = resume;
$('restart').onclick = () => startRound(session!.roundIndex, session!.practice);
$('tomenu').onclick = () => { session?.stop(); show('menu'); };
$('pause-settings').onclick = () => show('settingsdlg');
$('res-menu').onclick = () => show('menu');
for (const b of document.querySelectorAll<HTMLButtonElement>('.back')) b.onclick = () => show(session?.paused ? 'pausedlg' : 'menu');
$('exportsave').onclick = () => save.exportFile();
$('importsave').onclick = () => $('importfile').click();
$('importfile').addEventListener('change', async (e) => {
  const f = (e.target as HTMLInputElement).files?.[0]; if (!f) return;
  const ok = save.importText(await f.text()); toast(ok ? 'Voortgang geïmporteerd.' : 'Dit bestand is geen geldige voortgang.'); applySettings();
});
$('diag').onclick = () => core?.metrics.export({ build: BUILD, world: core.world.info, session: session?.diag() });

document.addEventListener('visibilitychange', () => { if (document.hidden) { pause(); audio.suspend(); } });
addEventListener('pagehide', () => { pause(); audio.suspend(); });
addEventListener('blur', () => { if (session?.active) pause(); });

// Development-only handle for automated visual checks (stripped from production builds).
if (import.meta.env.DEV) {
  (window as unknown as { mjDev: unknown }).mjDev = {
    get core() { return core; }, get session() { return session; },
    view(x: number, z: number, yaw: number, pitch = 0) { core?.placePlayer(x, z, yaw, pitch); return core ? [core.player.x, core.player.y, core.player.z] : null; },
    /** Put mosquito i on the nearest surface to (x,y,z) and look at it from `dist` metres (visual checks). */
    lookAtMosquito(i: number, x: number, y: number, z: number, dist = 0.4) {
      if (!core || !session) return null;
      const m = session.mosq[i]; if (!m) return null;
      const bvh = core.world.bvh, hit = { t: 0, tri: 0, nx: 0, ny: 0, nz: 0 };
      let best = Infinity, sp: number[] = [], nrm: number[] = [], tri = 0;
      for (const [dx, dy, dz] of [[0, 0, 1], [0, 0, -1], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0]]) {
        if (bvh.raycast(x, y, z, dx, dy, dz, 0.6, hit, 15) && hit.t < best) { best = hit.t; sp = [x + dx * hit.t, y + dy * hit.t, z + dz * hit.t]; nrm = [hit.nx, hit.ny, hit.nz]; tri = hit.tri; }
      }
      if (!sp.length) return null;
      m.brain.placeResting(sp[0], sp[1], sp[2], nrm[0], nrm[1], nrm[2], tri, bvh.cls[tri]); m.brain.timer = 999;
      core.placePlayer(sp[0] + nrm[0] * (dist + 0.1), sp[2] + nrm[2] * (dist + 0.1), 0, 0);
      const e = core.camera.position;
      core.yaw = Math.atan2(-(sp[2] - e.z), sp[0] - e.x); core.pitch = Math.atan2(sp[1] - e.y, Math.hypot(sp[0] - e.x, sp[2] - e.z));
      return { surface: sp, eye: [e.x, e.y, e.z], dist: Math.hypot(sp[0] - e.x, sp[1] - e.y, sp[2] - e.z) };
    },
    /** Orthographic top view (for layout checks): centre x,z, half width in m. */
    async topView(x: number, z: number, half = 2.2, y = 2.25) {
      if (!core || !session) return null;
      session.pause(); session.arm.setVisible(false);
      const { Camera } = await import('@babylonjs/core/Cameras/camera');
      const { Vector3 } = await import('@babylonjs/core/Maths/math.vector');
      const cam = core.camera;
      cam.unfreezeProjectionMatrix();
      cam.mode = Camera.ORTHOGRAPHIC_CAMERA;
      const aspect = core.engine.getRenderWidth() / core.engine.getRenderHeight();
      cam.orthoLeft = -half * aspect; cam.orthoRight = half * aspect; cam.orthoTop = half; cam.orthoBottom = -half;
      cam.position.set(x, y, z); cam.upVector = new Vector3(0, 0, -1); cam.setTarget(new Vector3(x, 0, z));
      cam.minZ = 0.01;
      return true;
    },
    /** Passability of every doorway for the body profile (D48): only that door open at its measured maximum; flood
     * fill over free standing spots (4 cm grid, 2.4 x 2.4 m around the opening) from 0.25 m before the door line in
     * the room on one side to 0.25 m behind it in the room on the other side, both ways. speling = the largest extra
     * clearance around the body (m) with which it still passes: 0 = only just, null = not at all. */
    async doorPassCheck(alsoOpen: Record<string, number> = {}) {
      if (!core) return null;
      const { roomAt } = await import('./engine/world');
      const p = core.player, out: unknown[] = [];
      const saved = core.world.doors.map((d) => [d.angle, d.target] as const);
      const G = 0.04, HALF = 1.2, N = Math.round(2 * HALF / G) + 1, T = 0.25;
      for (const d of core.world.doors) {
        if (d.id === 'douche') continue;                                   // shower: not a passage
        // alsoOpen: other doors open at the same time (id -> angle in rad, or -1 for their maximum), e.g. suite + bathroom
        for (const o of core.world.doors) { o.angle = o === d ? o.maxOpen : o.id in alsoOpen ? (alsoOpen[o.id] < 0 ? o.maxOpen : Math.min(o.maxOpen, alsoOpen[o.id])) : 0; o.target = o.angle; o.node.rotation.y = o.closedYaw + o.angle * o.openSign; }
        const cx = d.hinge.x + d.leafDir.x * d.width / 2, cz = d.hinge.z + d.leafDir.z * d.width / 2;
        const nx = -d.leafDir.z, nz = d.leafDir.x;
        // start in the room on one side, goal in the room on the other (other doors closed): no detour through a room
        // that lies on both sides of the door line (the living room)
        const roomP = roomAt(cx + nx * 0.5, cz + nz * 0.5), roomN = roomAt(cx - nx * 0.5, cz - nz * 0.5);
        const side = new Float32Array(N * N), floor = new Float32Array(N * N), room: string[] = [];
        for (let i = 0; i < N; i++) for (let k = 0; k < N; k++) {
          const x = cx - HALF + i * G, z = cz - HALF + k * G;
          side[i * N + k] = (x - cx) * nx + (z - cz) * nz;
          room[i * N + k] = roomAt(x, z);
          floor[i * N + k] = p.floorAt(x, z, 0.3);                     // floor, threshold or deck; beds etc. hit the shins
        }
        const passes = (margin: number, from: number) => {
          const free = new Int8Array(N * N);
          for (let c = 0; c < N * N; c++) {
            if (floor[c] === -Infinity) continue;
            free[c] = p.isFree(cx - HALF + Math.floor(c / N) * G, floor[c], cz - HALF + (c % N) * G, margin) ? 1 : 0;
          }
          const rFrom = from > 0 ? roomP : roomN, rTo = from > 0 ? roomN : roomP;
          const seen = new Uint8Array(N * N), q: number[] = [];
          for (let c = 0; c < N * N; c++) if (free[c] && side[c] * from > T && room[c] === rFrom) { seen[c] = 1; q.push(c); }
          while (q.length) {
            const c = q.pop()!, i = Math.floor(c / N), k = c % N;
            if (side[c] * from < -T && room[c] === rTo) return true;
            for (const [di, dk] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
              const ii = i + di, kk = k + dk;
              if (ii < 0 || kk < 0 || ii >= N || kk >= N) continue;
              const cc = ii * N + kk;
              if (!free[cc] || seen[cc]) continue;
              seen[cc] = 1; q.push(cc);
            }
          }
          return false;
        };
        const res: Record<string, unknown> = { id: d.id, kamers: `${roomN}|${roomP}`, maxOpenDeg: Math.round(d.maxOpen * 180 / Math.PI), ookOpen: alsoOpen };
        for (const [key, from] of [['heen', 1], ['terug', -1]] as const) {
          let best: number | null = null;
          for (const m of [0.06, 0.04, 0.03, 0.02, 0.01, 0]) if (passes(m, from)) { best = m; break; }
          res[key] = best;
        }
        out.push(res);
      }
      core.world.doors.forEach((d, i) => { d.angle = saved[i][0]; d.target = saved[i][1]; d.node.rotation.y = d.closedYaw + d.angle * d.openSign; });
      return out;
    },
    /** Reachability of every resting start position with the real arm (D48): the nearest free standing spot from which
     * a swat can be planned (arm length, wrist range, lean into the free space in front of the chest). */
    async reachCheck() {
      if (!core) return null;
      const { ROUNDS } = await import('./game/rounds');
      const { roomAt } = await import('./engine/world');
      const { planStrike } = await import('./swatter/swing');
      const bvh = core.world.bvh, hit = { t: 0, tri: 0, nx: 0, ny: 0, nz: 0 };
      const out: unknown[] = [];
      for (const r of ROUNDS) for (const s of r.mosquitoes) {
        if (!s.near || !s.resting) continue;
        const [px, py, pz] = s.near;
        let best = Infinity, sp: number[] = [], nrm: number[] = [];
        for (const [dx, dy, dz] of [[0, 0, 1], [0, 0, -1], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0]]) {
          if (bvh.raycast(px, py, pz, dx, dy, dz, 0.45, hit, 15) && hit.t < best) { best = hit.t; sp = [px + dx * hit.t, py + dy * hit.t, pz + dz * hit.t]; nrm = [hit.nx, hit.ny, hit.nz]; }
        }
        if (!sp.length) { out.push({ round: r.id, near: s.near, surface: null }); continue; }
        const cand: [number, number, number, number][] = [];
        for (let rr = 0.2; rr <= 2.0; rr += 0.05) for (let a = 0; a < 64; a++) {
          const x = sp[0] + Math.cos(a / 64 * Math.PI * 2) * rr, z = sp[2] + Math.sin(a / 64 * Math.PI * 2) * rr;
          if (roomAt(x, z) !== roomAt(px, pz)) continue;                          // same room as the requested spot
          const f = core.player.floorAt(x, z, 2.2, 2);
          if (f === -Infinity || core.player.floorAt(x, z, 2.2) > f + 0.24 || !core.player.isFree(x, f, z)) continue;
          const d = Math.hypot(x - sp[0], f + 1.62 - sp[1], z - sp[2]);
          const ux = (sp[0] - x) / d, uy = (sp[1] - f - 1.62) / d, uz = (sp[2] - z) / d;
          if (bvh.raycast(x, f + 1.62, z, ux, uy, uz, d - 0.02, hit, 15)) continue;       // line of sight
          cand.push([d, x, f, z]);
        }
        cand.sort((p, q) => p[0] - q[0]);
        let found: number[] | null = null, lean = 0;
        for (const [d, x, f, z] of cand) {
          const eye = { x, y: f + 1.62, z };
          const fv = { x: (sp[0] - x) / d, y: (sp[1] - eye.y) / d, z: (sp[2] - z) / d };
          const hl = Math.hypot(fv.x, fv.z) || 1;
          const rv = { x: -fv.z / hl, y: 0, z: fv.x / hl };
          const upv = { x: rv.y * fv.z - rv.z * fv.y, y: rv.z * fv.x - rv.x * fv.z, z: rv.x * fv.y - rv.y * fv.x };
          const leanMax = bvh.raycast(x, eye.y - 0.35, z, fv.x / hl, 0, fv.z / hl, 0.8, hit, 1 | 4 | 8) ? Math.min(0.32, Math.max(0, hit.t - 0.3)) : 0.32;
          const P = { x: sp[0] - nrm[0] * 0.012, y: sp[1] - nrm[1] * 0.012, z: sp[2] - nrm[2] * 0.012 };
          const plan = planStrike({ eye, f: fv, r: rv, up: upv }, P, { x: -nrm[0], y: -nrm[1], z: -nrm[2] }, 1, leanMax);
          if (plan) { found = [x, z, d]; lean = plan.lean; break; }
        }
        out.push({ round: r.id, surface: sp.map((v) => Math.round(v * 100) / 100), stand: found?.slice(0, 2).map((v) => Math.round(v * 100) / 100), eyeDist: found ? Math.round(found[2] * 100) / 100 : null, lean: Math.round(lean * 100) / 100, reachable: !!found });
      }
      return out;
    },
    /** Technical (not a listening) check: render the buzz worklet offline and measure level and harmonic peaks. */
    async audioCheck(freq = 450) {
      const sr = 48000, ctx = new OfflineAudioContext(1, sr, sr);
      await ctx.audioWorklet.addModule(import.meta.env.BASE_URL + 'audio/buzz-worklet.js');
      const n = new AudioWorkletNode(ctx, 'mosquito-buzz', { processorOptions: { seed: 7 }, outputChannelCount: [1] });
      n.parameters.get('freq')!.setValueAtTime(freq, 0); n.parameters.get('amp')!.setValueAtTime(1, 0); n.parameters.get('effort')!.setValueAtTime(0.3, 0);
      n.connect(ctx.destination);
      const buf = await ctx.startRendering();
      const x = buf.getChannelData(0).slice(sr / 2);             // skip the fade-in
      const rms = Math.sqrt(x.reduce((a, v) => a + v * v, 0) / x.length);
      const mag = (f: number) => { let re = 0, im = 0; for (let i = 0; i < x.length; i++) { const w = 2 * Math.PI * f * i / sr; re += x[i] * Math.cos(w); im -= x[i] * Math.sin(w); } return Math.hypot(re, im) / x.length; };
      let best = 0, f0 = 0;
      for (let f = freq * 0.85; f <= freq * 1.2; f += 1) { const m = mag(f); if (m > best) { best = m; f0 = f; } }
      const harmonics = [1, 2, 3, 4, 5].map((k) => Math.round(mag(f0 * k) / best * 100) / 100);
      return { rms: Math.round(rms * 1000) / 1000, fundamentalHz: f0, harmonicsRel: harmonics, note: 'technische meting, geen luistertest' };
    },
    /** Which mesh/material is visible at a CSS pixel (dev picking; makes meshes pickable temporarily). */
    async pickAt(x: number, y: number) {
      if (!core) return null;
      await import('@babylonjs/core/Culling/ray');
      const sc = core.scene;                       // scene.pick takes CSS px (divides by hardware scaling itself)
      const prev = sc.meshes.map((m) => m.isPickable);
      sc.meshes.forEach((m) => { m.isPickable = m.name !== 'sky'; });
      const p = sc.pick(x, y);
      sc.meshes.forEach((m, i) => { m.isPickable = prev[i]; });
      return p?.hit ? { mesh: p.pickedMesh?.name, mat: p.pickedMesh?.material?.name, dist: p.distance, point: p.pickedPoint?.asArray(), n: p.getNormal(true)?.asArray() } : null;
    },
    /** Chrome test ball at a world position (reflection orientation / probe checks). */
    async mirrorBall(x: number, y: number, z: number, rough = 0.02, d = 0.3) {
      if (!core) return;
      const { MeshBuilder } = await import('@babylonjs/core/Meshes/meshBuilder');
      const { PBRMaterial } = await import('@babylonjs/core/Materials/PBR/pbrMaterial');
      const s = MeshBuilder.CreateSphere('dbg_ball', { diameter: d, segments: 48 }, core.scene);
      s.position.set(x, y, z);
      const m = new PBRMaterial('dbg_chrome', core.scene); m.metallic = 1; m.roughness = rough; m.albedoColor.set(0.95, 0.95, 0.95);
      m.reflectionTexture = core.world.probeFor(x, z) ?? null;
      s.material = m;
      return m.reflectionTexture?.name;
    },
    /** Photo-matched camera (fotomatch.py, Blender frame: x east, y north, z up; yaw from +X toward +Y) incl. principal point. */
    async photoCam(c: { x: number; y: number; z: number; yaw_deg: number; pitch_deg: number; roll_deg: number; f_px: number; u0: number; v0: number; size: [number, number] }, exposure?: number) {
      if (!core || !session) return null;
      session.pause(); session.arm.setVisible(false);
      const { Matrix, Vector3 } = await import('@babylonjs/core/Maths/math.vector');
      const cam = core.camera, D = Math.PI / 180;
      const yaw = c.yaw_deg * D, pitch = c.pitch_deg * D, roll = c.roll_deg * D;
      const f = new Vector3(Math.cos(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.sin(yaw) * Math.cos(pitch));
      const r0 = new Vector3(Math.sin(yaw), 0, Math.cos(yaw));
      const u0 = Vector3.Cross(r0, f);
      const up = u0.scale(Math.cos(roll)).subtract(r0.scale(Math.sin(roll)));
      cam.position.set(c.x, c.z, -c.y);
      cam.upVector = up;
      cam.setTarget(cam.position.add(f));
      const [W, H] = c.size;
      const P = Matrix.PerspectiveFovRH(2 * Math.atan(H / 2 / c.f_px), W / H, cam.minZ, cam.maxZ);
      P.setRowFromFloats(2, P.m[8] - (2 * c.u0 / W - 1), P.m[9] - (1 - 2 * c.v0 / H), P.m[10], P.m[11]);
      cam.freezeProjectionMatrix(P);
      // metered over this camera's view, as in play (a straight-ahead frame; the principal point shift is ignored)
      session.adaptNow(cam.position.x, cam.position.z, { eye: { x: c.x, y: c.z, z: -c.y }, f: { x: f.x, y: f.y, z: f.z }, r: { x: r0.x, y: r0.y, z: r0.z }, up: { x: u0.x, y: u0.y, z: u0.z } });
      if (exposure) core.world.setExposure(exposure);
      return { pos: cam.position.asArray(), exposure: core.scene.imageProcessingConfiguration.exposure };
    },
  };
}

function diagnostics() {
  // Read-only diagnostics for automated browser tests; cannot create hits or change results.
  return {
    snapshot: () => ({
      build: BUILD, room: core?.room, player: core ? [core.player.x, core.player.y, core.player.z] : null, yaw: core?.yaw, pitch: core?.pitch,
      session: session?.diag(), frames: core?.metrics.summary(), world: core?.world.info,
    }),
  };
}
