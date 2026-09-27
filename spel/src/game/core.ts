// Engine/scene/camera and the per-frame simulation loop.
import { Engine } from '@babylonjs/core/Engines/engine';
import { Scene } from '@babylonjs/core/scene';
import { FreeCamera } from '@babylonjs/core/Cameras/freeCamera';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Color4 } from '@babylonjs/core/Maths/math.color';
import { ImageProcessingConfiguration } from '@babylonjs/core/Materials/imageProcessingConfiguration';
import { loadWorld, roomAt, type World, type Door } from '../engine/world';
import { PlayerBody, PLAYER, CLIMB } from '../physics/player';
import { Input } from '../input/input';
import { Metrics } from '../diag/metrics';

import { BUILD, COMFORT } from './build';
export { BUILD, COMFORT };
/** Horizontal field of view (80 deg): landscape phones are ~2.2:1, so 64 deg left only ~32 deg vertically and the
 * hand/swatter almost never in view; the reference photo cameras have 77-92 deg. */
export const FOV_H = 1.40;

/** Render resolution per quality setting (share of the device pixel ratio). Anti-aliasing is the canvas's own MSAA in
 * every tier (set when the WebGL context is created; the unused per-tier flag was removed, G-18). */
export interface QualityTier { name: string; renderScale: number; }
export const QUALITY: Record<string, QualityTier> = {
  hoog: { name: 'hoog', renderScale: 1.0 },
  normaal: { name: 'normaal', renderScale: 0.8 },
  licht: { name: 'licht', renderScale: 0.62 },
};

export class Core {
  engine: Engine; scene: Scene; camera: FreeCamera; world!: World; player!: PlayerBody; input: Input; metrics = new Metrics();
  yaw = Math.PI * 0.5; pitch = 0; running = false; time = 0;
  bob = 0; room = 'woon';
  private listeners: ((dt: number) => void)[] = [];
  private quality: QualityTier = QUALITY.normaal;

  constructor(public canvas: HTMLCanvasElement, hudRoot: HTMLElement, swatBtn: HTMLElement, doorBtn: HTMLElement) {
    // context loss is handled by the page (main.ts: pause, reload, offer the round again): Babylon's own restore left a
    // blank view (HDR probes, raw textures; REVIEW-01 G-04) and keeps CPU copies of all buffers for it
    this.engine = new Engine(canvas, true, { stencil: false, preserveDrawingBuffer: false, powerPreference: 'high-performance', antialias: true, adaptToDeviceRatio: false, doNotHandleContextLost: true }, false);
    this.scene = new Scene(this.engine);
    this.scene.useRightHandedSystem = true;
    this.scene.clearColor = new Color4(0.8, 0.84, 0.86, 1);
    this.scene.skipPointerMovePicking = true;
    this.scene.autoClear = true;
    const ip = this.scene.imageProcessingConfiguration;
    ip.toneMappingEnabled = true;
    ip.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_KHR_PBR_NEUTRAL;
    ip.exposure = 1.0; ip.contrast = 1.0;
    this.camera = new FreeCamera('eye', new Vector3(4.3, 1.62, -1.5), this.scene);
    this.camera.minZ = 0.03; this.camera.maxZ = 150; this.camera.fov = FOV_H; this.camera.inputs.clear();
    this.camera.fovMode = FreeCamera.FOVMODE_HORIZONTAL_FIXED;
    this.input = new Input(hudRoot, swatBtn, doorBtn);
    window.addEventListener('resize', () => this.engine.resize());
    this.setQuality('normaal');
  }

  setQuality(name: string) {
    this.quality = QUALITY[name] ?? QUALITY.normaal;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    this.engine.setHardwareScalingLevel(1 / Math.max(0.5, dpr * this.quality.renderScale));
    this.engine.resize();
  }

  async load(progress: (f: number, label: string) => void) {
    this.world = await loadWorld(this.scene, progress);
    this.player = new PlayerBody(this.world.bvh, () => this.world.doorObstacles());
    await this.scene.whenReadyAsync();
    await this.world.warmUp();
    this.engine.runRenderLoop(() => this.frame());
  }

  onUpdate(fn: (dt: number) => void) { this.listeners.push(fn); }

  /** Put the player on the nearest free floor spot (never on furniture or inside it). */
  placePlayer(x: number, z: number, yaw: number, pitch = 0) {
    const spot = this.player.findFreeSpot(x, z);
    if (spot) { this.player.x = spot[0]; this.player.y = spot[1]; this.player.z = spot[2]; }
    else { this.player.x = x; this.player.z = z; const f = this.player.floorAt(x, z, 1.0, 2); this.player.y = f > -Infinity ? f : 0; }
    this.player.vx = this.player.vz = this.player.vy = 0;
    this.yaw = yaw; this.pitch = pitch;
    this.updateCamera();
  }

  /** Upper-body lean (m) toward the view direction and down, set by the session during far swings / crouching. */
  lean = { f: 0, d: 0 };
  /** smoothed feet height for the camera: stepping onto a bed or down a tread does not pop the view */
  private feetY = 0;

  private updateCamera(bobY = 0, dt = 0) {
    const fx = Math.cos(this.yaw), fz = -Math.sin(this.yaw);
    this.feetY = dt > 0 ? this.feetY + (this.player.y - this.feetY) * (1 - Math.exp(-dt / 0.12)) : this.player.y;
    // standing on a bed the head would reach the ceiling (2.31 m): stoop so the eye stays CLIMB.headClear below it
    const ceil = this.player.ceilingAbove();
    const x = this.player.x + fx * this.lean.f, z = this.player.z + fz * this.lean.f;
    const y = Math.min(this.feetY + PLAYER.eye + bobY, ceil - CLIMB.headClear) - this.lean.d;
    this.camera.position.set(x, y, z);
    const cp = Math.cos(this.pitch);
    this.camera.setTarget(new Vector3(x + fx * cp, y + Math.sin(this.pitch), z + fz * cp));
  }

  private last = performance.now();
  private frame() {
    const now = performance.now();
    const raw = now - this.last; this.last = now;
    const dt = Math.min(raw / 1000, 1 / 20);
    if (this.running) {
      this.time += dt;
      this.metrics.frame(raw);
      this.simulate(dt);
    }
    this.scene.render();
  }

  private simulate(dt: number) {
    const inp = this.input.state;
    // look (touch: ~0.0042 rad/px at sensitivity 1; mouse similar)
    const s = 0.0042 * this.input.opts.lookSensitivity;
    this.yaw -= inp.lookDX * s;
    this.pitch -= inp.lookDY * s * (this.input.opts.invertY ? -1 : 1);
    this.pitch = Math.max(-1.35, Math.min(1.35, this.pitch));
    inp.lookDX = inp.lookDY = 0;
    // move in view space
    const [kx, ky] = this.input.keyMove();
    let mx = inp.moveX + kx, my = inp.moveY + ky;
    const ml = Math.hypot(mx, my); if (ml > 1) { mx /= ml; my /= ml; }
    const fx = Math.cos(this.yaw), fz = -Math.sin(this.yaw);    // forward on ground (yaw 0 = +x east)
    const rx = Math.sin(this.yaw), rz = Math.cos(this.yaw);     // right
    const wantX = (fx * my + rx * mx) * PLAYER.speed, wantZ = (fz * my + rz * mx) * PLAYER.speed;
    this.player.updateClimb(dt, wantX, wantZ, this.pitch > 0.45);     // bed/chair/sofa: look up, or walk on into it
    this.player.step(dt, wantX, wantZ);
    this.pushDoors(dt, wantX, wantZ);
    this.updateDoors(dt);
    // camera with subtle head bob proportional to speed (comfort option can disable)
    const sp = Math.hypot(this.player.vx, this.player.vz);
    this.bob += dt * sp * 5.6;
    const bobY = COMFORT.headBob ? Math.sin(this.bob * 2) * 0.012 * Math.min(1, sp / PLAYER.speed) : 0;
    this.updateCamera(bobY, dt);
    this.room = roomAt(this.player.x, this.player.z);
    for (const fn of this.listeners) fn(dt);
  }

  /** Door handle (lever centre, mid-plane of the leaf, 1.05 m high) of a door at its current angle. */
  handlePoint(d: Door): [number, number, number] {
    const [ax, az, bx, bz] = this.leafSegment(d, d.angle);
    const k = (d.width - 0.07) / d.width;
    return [ax + (bx - ax) * k, d.hinge.y + 1.05, az + (bz - az) * k];
  }

  /** The door whose handle is under the crosshair: within reach, within ~8 cm of the view ray and not hidden
   * behind a wall. Only then the open/close button shows, so you never open the neighbouring door by accident. */
  doorInFront(maxDist = 1.35): Door | null {
    const cp = Math.cos(this.pitch);
    const fx = Math.cos(this.yaw) * cp, fy = Math.sin(this.pitch), fz = -Math.sin(this.yaw) * cp;
    const e = this.camera.position;
    let best: Door | null = null, bestT = Infinity;
    const hit = { t: 0, tri: 0, nx: 0, ny: 0, nz: 0 };
    for (const d of this.world.doors) {
      const [hx, hy, hz] = this.handlePoint(d);
      const vx = hx - e.x, vy = hy - e.y, vz = hz - e.z;
      const t = vx * fx + vy * fy + vz * fz;
      if (t < 0.15 || t > maxDist) continue;
      const perp = Math.hypot(vx - fx * t, vy - fy * t, vz - fz * t);
      if (perp > 0.08 + 0.02 * t) continue;
      const dist = Math.hypot(vx, vy, vz);
      if (this.world.bvh.raycast(e.x, e.y, e.z, vx / dist, vy / dist, vz / dist, dist - 0.08, hit, 1 | 4 | 8)) continue;
      if (t < bestT) { bestT = t; best = d; }
    }
    return best;
  }

  /** Open a closed (or closing) door fully; close an open or opening one. */
  toggleDoor(d: Door) { d.target = d.target > 0.05 ? 0 : d.maxOpen; d.moving = true; }

  /** Leaf of a door at a given angle as a 2D segment (hinge -> free edge). */
  leafSegment(d: Door, angle: number): [number, number, number, number] {
    const yaw = d.closedYaw + angle * d.openSign;
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const lx = d.leafDir.x * c + d.leafDir.z * s, lz = -d.leafDir.x * s + d.leafDir.z * c;
    return [d.hinge.x, d.hinge.z, d.hinge.x + lx * d.width, d.hinge.z + lz * d.width];
  }

  /** A door that stands open gives way when you walk into its leaf, as a real one does (REVIEW-01 G-08: with the en-suite
   * door open - it swings into the bathroom right behind the bathroom doorway - you could not get from the living room
   * into the bathroom). A closed door is latched: it only opens by its handle. The pushed leaf stays where it is left. */
  private pushDoors(dt: number, wantX: number, wantZ: number) {
    const p = this.player, touch = PLAYER.radius + 0.022 + 0.012;
    for (const d of this.world.doors) {
      if (d.moving || d.angle < 0.05) continue;
      const [ax, az, bx, bz] = this.leafSegment(d, d.angle);
      const ex = bx - ax, ez = bz - az, L = Math.hypot(ex, ez);
      const t = Math.max(0, Math.min(1, ((p.x - ax) * ex + (p.z - az) * ez) / (L * L)));
      const cx = ax + ex * t, cz = az + ez * t, dist = Math.hypot(cx - p.x, cz - p.z);
      if (dist > touch || dist < 1e-6) continue;
      const nx = (cx - p.x) / dist, nz = (cz - p.z) / dist;
      const push = wantX * nx + wantZ * nz;                         // walking speed into the leaf (m/s)
      if (push < 0.1) continue;
      // motion of the touched point per radian of opening: openSign * (lz, -lx) * lever
      const lx = ex / L, lz = ez / L, lever = Math.max(0.12, t * L);
      const way = Math.sign((lz * nx - lx * nz) * d.openSign) || 1;
      let a = d.angle + way * push * dt / lever;
      a = Math.max(0, Math.min(d.maxOpen, a));
      if (a < 0.03) a = 0;                                           // pushed shut: the latch clicks in
      d.angle = d.target = a;
      d.node.rotation.y = d.closedYaw + a * d.openSign;
    }
  }

  private updateDoors(dt: number) {
    for (const d of this.world.doors) {
      // the leaves are baked closed: from ~3 deg on their light blends into the probe of the room they swing into
      const k = Math.min(1, Math.max(0, (d.angle - 0.05) / 0.55)), ibl = k * k * (3 - 2 * k);
      const g = this.world.diffuseGain(d.room);
      for (const pl of d.lm) { pl.ibl = ibl; pl.iblGain = g; }
      if (Math.abs(d.target - d.angle) < 1e-3) { d.moving = false; continue; }
      // hand-pushed swing: eased, at most ~2.4 rad/s
      let next = d.angle + (d.target - d.angle) * (1 - Math.exp(-6 * dt));
      const maxStep = 2.4 * dt;
      next = d.angle + Math.max(-maxStep, Math.min(maxStep, next - d.angle));
      const seg = this.leafSegment(d, next);
      // another door leaf in the way (wc and kids-room doors share a corner): the door waits there
      let blocked = false;
      for (const o of this.world.doors) {
        if (o === d || Math.hypot(o.hinge.x - d.hinge.x, o.hinge.z - d.hinge.z) > d.width + o.width + 0.1) continue;
        if (segSegDist(seg, this.leafSegment(o, o.angle)) < 0.045) { blocked = true; break; }
      }
      // the player: a door pulled toward you makes you step back; if there is no room behind you it stops
      // the player in the swing: the door stays ajar and carries on as soon as you step back (target is kept)
      if (!blocked) {
        const p = this.player;
        const [ax, az, bx, bz] = seg;
        const ex = bx - ax, ez = bz - az, L2 = ex * ex + ez * ez;
        const t = Math.max(0, Math.min(1, ((p.x - ax) * ex + (p.z - az) * ez) / L2));
        if (Math.hypot(p.x - ax - ex * t, p.z - az - ez * t) < PLAYER.radius + 0.03) blocked = true;
      }
      if (blocked) { d.moving = false; continue; }
      d.angle = next;
      d.node.rotation.y = d.closedYaw + d.angle * d.openSign;
    }
  }
}

function segSegDist(a: [number, number, number, number], b: [number, number, number, number]): number {
  const pd = (px: number, pz: number, s: [number, number, number, number]) => {
    const ex = s[2] - s[0], ez = s[3] - s[1], L2 = ex * ex + ez * ez || 1e-9;
    const t = Math.max(0, Math.min(1, ((px - s[0]) * ex + (pz - s[1]) * ez) / L2));
    return Math.hypot(px - s[0] - ex * t, pz - s[1] - ez * t);
  };
  const cross = (ax: number, az: number, bx: number, bz: number) => ax * bz - az * bx;
  const d1x = a[2] - a[0], d1z = a[3] - a[1], d2x = b[2] - b[0], d2z = b[3] - b[1];
  const den = cross(d1x, d1z, d2x, d2z);
  if (Math.abs(den) > 1e-9) {
    const t = cross(b[0] - a[0], b[1] - a[1], d2x, d2z) / den, u = cross(b[0] - a[0], b[1] - a[1], d1x, d1z) / den;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) return 0;
  }
  return Math.min(pd(a[0], a[1], b), pd(a[2], a[3], b), pd(b[0], b[1], a), pd(b[2], b[3], a));
}

