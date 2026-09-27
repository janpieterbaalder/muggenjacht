// Procedural house-mosquito model (~5.5 mm body, Culex-like proportions) with jointed legs, veined
// translucent wings, wing-beat blur, resting pose on surfaces, squash and fall states.
import { Scene } from '@babylonjs/core/scene';
import { Vector3, Quaternion, Matrix } from '@babylonjs/core/Maths/math.vector';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture';
import type { MosquitoBrain } from './brain';
import { ProbeDiffusePlugin } from '../engine/lightmap';

const MM = 0.001;
/** lowest point of the resting legs below the body centre (mid legs' tarsi incl. tube radius), scale 1 */
const FOOT = 0.00226;
/** highest point of the back (thorax) above the body centre, turned over for a dead mosquito lying on its back */
const DORSAL = 0.0009;
/** gaps the brain keeps: a resting mosquito 3 mm off its surface (placeResting), a fallen one 2 mm (fall) */
const REST_GAP = 0.003, FALL_GAP = 0.002;
let shared: { body: PBRMaterial; leg: PBRMaterial; wing: PBRMaterial; blur: StandardMaterial; smear: StandardMaterial; shade: StandardMaterial; diffuse: ProbeDiffusePlugin[] } | null = null;

/** Readability scale (D51). A phone in landscape squeezes an 80 deg view into a few cm of screen: a true-size mosquito
 * (5.5 mm) was a 2-4 px speck from 1 m on (user: "erg slecht zichtbaar"). The visual model is drawn 1.5x (8 mm, the size
 * of the common banded house mosquito Culiseta annulata) and grows with distance so it stays a visible speck. Capped at
 * 2.5x from ~2.3 m (REVIEW-01 G-07: up to 3.8x read as a ~3 cm insect next to a light switch; the plan asks for a
 * credible scale - user decision pending). Flight, landing, hearing and the swat hit test keep the true position (the
 * swatter head is ~13 cm wide), so aiming stays as fair as before. */
export const READABILITY = { base: 1.5, from: 1.0, power: 0.6, max: 2.5 };
export function readabilityScale(dist: number): number {
  const r = READABILITY;
  return Math.min(r.max, r.base * Math.pow(Math.max(dist, r.from) / r.from, r.power));
}

function materials(scene: Scene) {
  if (shared) return shared;
  const body = new PBRMaterial('mug_chitine', scene);
  body.albedoColor = Color3.FromHexString('#3a2d1f'); body.roughness = 0.38; body.metallic = 0; body.environmentIntensity = 1;
  body.albedoTexture = bandTexture(scene);
  const leg = new PBRMaterial('mug_poten', scene);
  leg.albedoColor = Color3.FromHexString('#261d15'); leg.roughness = 0.5; leg.metallic = 0;
  const wing = new PBRMaterial('mug_vleugel', scene);
  wing.albedoTexture = wingTexture(scene); wing.albedoTexture.hasAlpha = true; wing.useAlphaFromAlbedoTexture = true;
  wing.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHABLEND; wing.backFaceCulling = false; wing.roughness = 0.2; wing.metallic = 0;
  wing.albedoColor = new Color3(0.85, 0.85, 0.8);
  const blur = new StandardMaterial('mug_vleugelwaas', scene);
  blur.diffuseColor = new Color3(0.2, 0.18, 0.15); blur.alpha = 0.16; blur.disableLighting = true; blur.emissiveColor = new Color3(0.25, 0.23, 0.2); blur.backFaceCulling = false;
  const smear = new StandardMaterial('mug_vlek', scene);
  smear.diffuseTexture = smearTexture(scene); smear.diffuseTexture.hasAlpha = true; smear.useAlphaFromDiffuseTexture = true;
  smear.specularColor = new Color3(0.05, 0.05, 0.05); smear.zOffset = -2; smear.backFaceCulling = false;
  // soft contact shadow under a resting mosquito (diffuse room light: the body and legs darken the wall right under them)
  const shade = new StandardMaterial('mug_schaduw', scene);
  shade.diffuseTexture = shadowTexture(scene); shade.diffuseTexture.hasAlpha = true; shade.useAlphaFromDiffuseTexture = true;
  shade.disableLighting = true; shade.emissiveColor = new Color3(0, 0, 0); shade.specularColor = new Color3(0, 0, 0); shade.zOffset = -1; shade.backFaceCulling = false;
  shared = { body, leg, wing, blur, smear, shade, diffuse: [body, leg, wing].map((mm) => new ProbeDiffusePlugin(mm)) };
  return shared;
}

function bandTexture(scene: Scene) {
  const t = new DynamicTexture('mug_banden', { width: 64, height: 256 }, scene, true);
  const c = t.getContext() as CanvasRenderingContext2D;
  c.fillStyle = '#6a553c'; c.fillRect(0, 0, 64, 256);
  for (let i = 0; i < 8; i++) { c.fillStyle = 'rgba(210,190,150,0.55)'; c.fillRect(0, 60 + i * 24, 64, 5); }
  c.fillStyle = '#3d2f20'; c.fillRect(0, 0, 64, 58);
  t.update(); return t;
}
function wingTexture(scene: Scene) {
  const t = new DynamicTexture('mug_vleugeltex', { width: 256, height: 64 }, scene, true);
  const c = t.getContext() as CanvasRenderingContext2D;
  c.clearRect(0, 0, 256, 64);
  c.fillStyle = 'rgba(200,200,190,0.22)';
  c.beginPath(); c.ellipse(128, 32, 124, 26, 0, 0, Math.PI * 2); c.fill();
  c.strokeStyle = 'rgba(70,60,45,0.75)'; c.lineWidth = 1.6;
  for (let i = 0; i < 6; i++) { c.beginPath(); c.moveTo(6, 32 + (i - 2.5) * 3); c.bezierCurveTo(80, 22 + i * 4, 170, 18 + i * 5, 250, 30 + (i - 2.5) * 5); c.stroke(); }
  c.strokeStyle = 'rgba(90,80,60,0.5)'; c.lineWidth = 3; c.beginPath(); c.ellipse(128, 32, 123, 25, 0, 0, Math.PI * 2); c.stroke();   // scaled fringe
  t.update(); return t;
}
function shadowTexture(scene: Scene) {
  const t = new DynamicTexture('mug_schaduwtex', { width: 64, height: 64 }, scene, true);
  const c = t.getContext() as CanvasRenderingContext2D;
  c.clearRect(0, 0, 64, 64);
  const g = c.createRadialGradient(32, 32, 1, 32, 32, 31); g.addColorStop(0, 'rgba(0,0,0,0.42)'); g.addColorStop(0.45, 'rgba(0,0,0,0.2)'); g.addColorStop(1, 'rgba(0,0,0,0)');
  c.fillStyle = g; c.fillRect(0, 0, 64, 64);
  t.update(); return t;
}
function smearTexture(scene: Scene) {
  const t = new DynamicTexture('mug_vlektex', { width: 64, height: 64 }, scene, true);
  const c = t.getContext() as CanvasRenderingContext2D;
  c.clearRect(0, 0, 64, 64);
  const g = c.createRadialGradient(32, 32, 2, 32, 32, 22); g.addColorStop(0, 'rgba(40,24,14,0.9)'); g.addColorStop(0.5, 'rgba(60,30,18,0.5)'); g.addColorStop(1, 'rgba(60,30,18,0)');
  c.fillStyle = g; c.beginPath(); c.ellipse(32, 32, 22, 14, 0.4, 0, Math.PI * 2); c.fill();
  c.strokeStyle = 'rgba(30,20,12,0.8)'; c.lineWidth = 1;
  for (let i = 0; i < 6; i++) { const a = i * 1.05; c.beginPath(); c.moveTo(32, 32); c.lineTo(32 + Math.cos(a) * 20, 32 + Math.sin(a) * 18); c.stroke(); }
  t.update(); return t;
}

export class MosquitoVisual {
  root: TransformNode; body: Mesh; legs: Mesh; wingL: Mesh; wingR: Mesh; blur: Mesh; shadow: Mesh; smear: Mesh | null = null;
  /** current readability scale (for tests/diagnostics) */
  scale = 1;
  private tmpQ = new Quaternion();
  constructor(scene: Scene, id: number) {
    const m = materials(scene);
    this.root = new TransformNode('mug_' + id, scene);
    // body: head, thorax (humped), abdomen (8 segments tapering), proboscis, palps, antennae
    const parts: Mesh[] = [];
    const sph = (d: [number, number, number], p: [number, number, number]) => {
      const s = MeshBuilder.CreateSphere('p', { segments: 10, diameterX: d[0] * MM, diameterY: d[1] * MM, diameterZ: d[2] * MM }, scene);
      s.position.set(p[0] * MM, p[1] * MM, p[2] * MM); parts.push(s); return s;
    };
    // local frame: +z forward (head), +y up (dorsal), +x right
    sph([0.75, 0.7, 0.75], [0, 0.25, 1.55]);              // head
    sph([1.25, 1.25, 1.7], [0, 0.35, 0.55]);              // thorax
    // abdomen: 8 overlapping tapered segments -> one slender body with faint rings (7 spaced spheres read as beads)
    for (let i = 0; i < 8; i++) sph([0.74 - i * 0.052, 0.62 - i * 0.042, 0.74], [0, 0.05 - i * 0.025, -0.42 - i * 0.40]);
    const tube = (pts: [number, number, number][], r: number) => {
      const t = MeshBuilder.CreateTube('t', { path: pts.map((q) => new Vector3(q[0] * MM, q[1] * MM, q[2] * MM)), radius: r * MM, tessellation: 5, cap: Mesh.CAP_ALL }, scene);
      return t;
    };
    parts.push(tube([[0, 0.1, 1.85], [0, -0.35, 3.9]], 0.06));                         // proboscis
    for (const sx of [-1, 1]) {
      parts.push(tube([[sx * 0.12, 0.35, 1.85], [sx * 0.5, 0.9, 2.9]], 0.035));          // antennae
      parts.push(tube([[sx * 0.1, 0.15, 1.85], [sx * 0.15, -0.1, 2.3]], 0.04));          // palps
    }
    this.body = Mesh.MergeMeshes(parts, true, true)!; this.body.material = m.body; this.body.parent = this.root; this.body.name = 'mug_lijf_' + id;
    // legs: 3 pairs, femur/tibia/tarsus; resting stance with hind legs raised (Culex)
    const legs: Mesh[] = [];
    const legDefs: [number, number, number][] = [[0.9, 30, -12], [0.45, 0, -18], [0.1, -25, 40]];   // attach z, yaw deg, tip elevation deg
    for (const [az, yaw, elev] of legDefs) {
      for (const sx of [-1, 1]) {
        const a = (yaw * Math.PI) / 180 * sx, e = (elev * Math.PI) / 180;
        const base: [number, number, number] = [sx * 0.35, 0.0, az];
        const knee: [number, number, number] = [sx * (0.35 + 2.4 * Math.cos(a) * 0.9), 0.9, az + 2.4 * Math.sin(a) * 0.9 * (az > 0.5 ? 1 : az > 0.2 ? 0.3 : -1)];
        const ankle: [number, number, number] = [knee[0] + sx * 2.2 * Math.cos(a), knee[1] + 3.0 * Math.sin(e) - 1.3, knee[2] + (az > 0.5 ? 1.8 : az > 0.2 ? 0.2 : -2.2)];
        const foot: [number, number, number] = [ankle[0] + sx * 1.6, ankle[1] + (elev > 0 ? 2.2 : -0.9), ankle[2] + (az > 0.5 ? 1.8 : az > 0.2 ? 0.1 : -2.6)];
        legs.push(tube([base, knee], 0.06), tube([knee, ankle], 0.05), tube([ankle, foot], 0.035));
      }
    }
    this.legs = Mesh.MergeMeshes(legs, true, true)!; this.legs.material = m.leg; this.legs.parent = this.root;
    const wing = (sx: number) => {
      const w = MeshBuilder.CreatePlane('vleugel', { width: 3.1 * MM, height: 0.85 * MM, sideOrientation: Mesh.DOUBLESIDE }, scene);
      w.material = m.wing; w.parent = this.root;
      w.setPivotPoint(new Vector3(-sx * 1.55 * MM, 0, 0));
      w.position.set(sx * 1.55 * MM, 0.65 * MM, 0.5 * MM);
      w.rotation.x = Math.PI / 2;
      return w;
    };
    this.wingL = wing(-1); this.wingR = wing(1);
    this.blur = MeshBuilder.CreateDisc('waas', { radius: 3.4 * MM, tessellation: 20, sideOrientation: Mesh.DOUBLESIDE }, scene);
    this.blur.material = m.blur; this.blur.parent = this.root; this.blur.position.set(0, 0.7 * MM, 0.3 * MM); this.blur.rotation.x = Math.PI / 2; this.blur.scaling.set(1.5, 0.75, 1);
    // contact shadow: an ellipse in the surface plane under body and legs (local xz plane = surface; offset along +y)
    this.shadow = MeshBuilder.CreateGround('mug_schaduw', { width: 7.5 * MM, height: 9 * MM }, scene);
    this.shadow.material = m.shade; this.shadow.parent = this.root; this.shadow.position.set(0, -(FOOT / MM - 0.05) * MM, -0.6 * MM);   // at the feet
    for (const x of [this.body, this.legs, this.wingL, this.wingR, this.blur, this.shadow]) { x.isPickable = false; x.alwaysSelectAsActiveMesh = false; }
    this.root.scaling.setAll(1.0);
  }

  setDiffuseGain(g: number) { for (const p of materials(this.body.getScene()).diffuse) p.gain = g; }

  setReflection(tex: import('@babylonjs/core/Materials/Textures/baseTexture').BaseTexture | undefined) {
    const m = materials(this.body.getScene());
    if (tex) { m.body.reflectionTexture = tex; m.leg.reflectionTexture = tex; m.wing.reflectionTexture = tex; }
  }

  /** Babylon frame pose from the brain. eye: camera position (readability scale by distance). */
  sync(b: MosquitoBrain, t: number, eye?: { x: number; y: number; z: number }) {
    const r = this.root;
    const flying = b.audible || b.state === 'onhost' && false;
    this.blur.setEnabled(flying);
    this.wingL.setEnabled(!flying); this.wingR.setEnabled(!flying);
    const k = this.scale = eye ? readabilityScale(Math.hypot(b.x - eye.x, b.y - eye.y, b.z - eye.z)) : READABILITY.base;
    this.shadow.setEnabled(b.state === 'rest');
    if (b.state === 'rest' || b.state === 'squashed' || b.state === 'dead') {
      // body parallel to surface, legs toward it; surface normal n, heading headAngle within tangent plane
      const n = new Vector3(b.nx, b.ny, b.nz);
      let tx = new Vector3(0, 1, 0);
      if (Math.abs(n.y) > 0.9) tx = new Vector3(1, 0, 0);
      const t1 = Vector3.Cross(n, tx).normalize(), t2 = Vector3.Cross(t1, n).normalize();
      const fwd = t1.scale(Math.cos(b.headAngle)).add(t2.scale(Math.sin(b.headAngle))).normalize();
      const up = n;
      const right = Vector3.Cross(up, fwd).normalize();
      const M = Matrix.FromValues(right.x, right.y, right.z, 0, up.x, up.y, up.z, 0, fwd.x, fwd.y, fwd.z, 0, 0, 0, 0, 1);
      Quaternion.FromRotationMatrixToRef(M, this.tmpQ);
      r.rotationQuaternion = this.tmpQ.clone();
      // the brain keeps a resting mosquito REST_GAP off its surface (flight clearance); the model stands ON the surface:
      // the lowest feet are FOOT below the body centre at scale 1 (REVIEW-01 G-11: legs floated 1.7-2.5 mm, the contact
      // shadow 4-5.6 mm). Squashed: flattened body on the surface; dead (on its back): dorsal side on the floor.
      const lift = (b.state === 'squashed' ? 0.0007 : b.state === 'dead' ? DORSAL : FOOT) * k - (b.state === 'dead' ? FALL_GAP : REST_GAP);
      r.position.set(b.x + n.x * lift, b.y + n.y * lift, b.z + n.z * lift);
      if (b.state === 'squashed') {
        r.scaling.set(1.25 * k, 0.25 * k, 1.1 * k);
        if (!this.smear) {
          this.smear = MeshBuilder.CreatePlane('vlek', { size: 0.009 * k }, r.getScene());
          this.smear.material = materials(r.getScene()).smear; this.smear.isPickable = false;
          const o = 0.0003 - REST_GAP;                   // on the surface (depth bias via zOffset)
          this.smear.position.set(b.x + n.x * o, b.y + n.y * o, b.z + n.z * o);
          this.smear.lookAt(this.smear.position.subtract(n));
        }
      } else if (b.state === 'dead') {
        r.scaling.setAll(k); r.rotationQuaternion = Quaternion.RotationYawPitchRoll(b.headAngle, 0, Math.PI * 0.85);
      } else r.scaling.setAll(k);
      // resting wings folded flat over the abdomen, tips slightly apart (Culex); they used to stay spread sideways
      this.wingL.rotation.set(Math.PI / 2, -(Math.PI / 2 - 0.13), -0.1); this.wingR.rotation.set(Math.PI / 2, Math.PI / 2 - 0.13, 0.1);
      return;
    }
    r.scaling.setAll(k);
    const v = new Vector3(b.vx, b.vy * 0.5, b.vz);
    const sp = v.length();
    const fwd = sp > 0.02 ? v.scale(1 / sp) : new Vector3(Math.cos(t), 0, Math.sin(t));
    const yaw = Math.atan2(fwd.x, fwd.z), pitch = -Math.asin(Math.max(-0.6, Math.min(0.6, fwd.y))) - 0.25;
    r.rotationQuaternion = Quaternion.RotationYawPitchRoll(yaw, pitch, Math.sin(t * 9 + b.id) * 0.15);
    const bob = Math.sin(t * 31 + b.id) * 0.0006;
    r.position.set(b.x, b.y + bob, b.z);
    const beat = Math.sin(b.wingPhase);
    this.blur.scaling.set(1.5, 0.75 + beat * 0.05, 1);
  }

  dispose() { this.root.dispose(false, false); this.smear?.dispose(); }
}
