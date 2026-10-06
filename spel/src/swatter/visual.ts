// First-person arm: MakeHuman-based hand (arm.glb 'hand'), one continuous knitted sleeve from the cuff over the bent
// elbow into a torso (armgeom.ts, two-bone IK from a body-fixed shoulder socket to the wrist, rebuilt per frame),
// swatter head + shaft following the physical swing pose.
import { Scene } from '@babylonjs/core/scene';
import { Vector3, Matrix, Quaternion } from '@babylonjs/core/Maths/math.vector';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import type { BaseTexture } from '@babylonjs/core/Materials/Textures/baseTexture';
import { ImportMeshAsync } from '@babylonjs/core/Loading/sceneLoader';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import { VertexBuffer } from '@babylonjs/core/Buffers/buffer';
import { RawTexture } from '@babylonjs/core/Materials/Textures/rawTexture';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import { ARM_CLEAR, HAND, allocSleeve, armPole, bodyFrame, buildSleeve, buildTorso, clearArmPole, handOnHandle, knitTextures, shoulderAt, shoulderLift, solveArm, type TubeBuffers, type ArmJoints, type P3 } from './armgeom';
import { WIRE, wirePoint, type Pose, type CamFrame } from './swing';
import { ProbeDiffusePlugin } from '../engine/lightmap';

/** rings along the wire handle and sides per ring */
const WIRE_RINGS = 26, WIRE_SIDES = 8;

/** knitted jumper: heather blue-grey (a plausible choice, not from a photo) */
const JUMPER = new Color3(0.20, 0.215, 0.235);

function basisToQuat(x: Vector3, y: Vector3, z: Vector3): Quaternion {
  const m = Matrix.FromValues(x.x, x.y, x.z, 0, y.x, y.y, y.z, 0, z.x, z.y, z.z, 0, 0, 0, 0, 1);
  return Quaternion.FromRotationMatrix(m);
}
const V = (a: { x: number; y: number; z: number }) => new Vector3(a.x, a.y, a.z);

export class ArmVisual {
  head!: TransformNode; stick!: TransformNode; hand!: TransformNode;
  sleeve!: Mesh; torso!: Mesh;
  /** last solved arm joints (diagnostics) */
  joints: ArmJoints | null = null;
  private sleeveBuf: TubeBuffers = allocSleeve();
  meshes: AbstractMesh[] = [];
  private diffuse: { material: PBRMaterial; plugin: ProbeDiffusePlugin }[] = [];
  ready = false;
  /** capsule penetration test against the world (set by the session): the elbow swings away from walls */
  armDepth: ((a: P3, b: P3, r: number) => number) | null = null;
  /** smoothed elbow direction (a new clear pose is eased in, no pop) */
  private pole: Vector3 | null = null;
  /** the wire handle, rebuilt every frame so it can bend (swing.wirePoint) */
  private wire!: Mesh;
  private wireBuf!: { positions: Float32Array; normals: Float32Array };
  /** the torso as built (standing) and how far its belly is shortened now (1 = standing) */
  private torsoRest!: Float32Array; private torsoK = 1;

  async load(scene: Scene) {
    const res = await ImportMeshAsync(import.meta.env.BASE_URL + 'assets/arm.glb', scene);
    // multi-primitive glTF meshes arrive as a node with primitive children: search transform nodes as well
    const byName = (n: string) => (res.meshes.find((m) => m.name === n) ?? res.transformNodes.find((t) => t.name === n)) as TransformNode | undefined;
    const mk = (n: string) => {
      const t = new TransformNode(n + '_pivot', scene);
      const m = byName(n);
      if (!m) throw new Error('arm.glb mist ' + n);
      m.parent = t; m.position.setAll(0); m.rotationQuaternion = Quaternion.Identity(); m.scaling.setAll(1);
      return t;
    };
    this.head = mk('mepper_kop'); this.stick = mk('mepper_steel'); this.hand = mk('hand');
    // the stick's plastic rib is moulded into the head: it goes with the head and never bends (bent along with the
    // wire it stood out of the head's plane - the head looked crooked on the handle). Slimmer than modelled (21 mm).
    // The straight wire is replaced by one that bends (built below).
    const stickParts = [byName('mepper_steel') as AbstractMesh, ...((byName('mepper_steel') as AbstractMesh).getChildMeshes?.() ?? [])].filter((m) => m?.material);
    const rib = stickParts.find((m) => m.material!.name === 'mepper_kunststof');
    const wireSrc = stickParts.find((m) => m.material!.name === 'mepper_draad');
    if (!rib || !wireSrc) throw new Error('arm.glb mist mepper_steel-onderdelen');
    const ribPivot = new TransformNode('mepper_rib_pivot', scene);
    ribPivot.parent = this.head; ribPivot.position.set(0, 0, -HAND.neck); ribPivot.scaling.set(0.62, 0.62, 1);
    rib.parent = ribPivot; rib.position.setAll(0); rib.rotationQuaternion = Quaternion.Identity(); rib.scaling.setAll(1);
    wireSrc.setEnabled(false);
    this.buildWire(scene, wireSrc.material as PBRMaterial);
    // the rigid forearm sleeve of arm.glb is replaced by the continuous sleeve below
    const oldSleeve = byName('onderarm') as AbstractMesh | undefined;
    if (oldSleeve) { oldSleeve.setEnabled(false); for (const c of oldSleeve.getChildMeshes()) c.setEnabled(false); }
    this.buildCloth(scene);
    const ex = ((byName('hand') as AbstractMesh | undefined)?.metadata?.gltf?.extras ?? {}) as Record<string, unknown>;
    try {
      const lm = JSON.parse(String(ex.landmarks ?? '{}')) as { wrist?: number[]; forearm_dir?: number[] };
      if (lm.wrist) HAND.wrist = { x: lm.wrist[0], y: lm.wrist[1], z: lm.wrist[2] };
      if (lm.forearm_dir) HAND.forearm = { x: lm.forearm_dir[0], y: lm.forearm_dir[1], z: lm.forearm_dir[2] };
    } catch { /* keep default */ }
    for (const m of res.meshes) {
      m.isPickable = false; m.renderingGroupId = 1;       // drawn after world: never hidden behind near geometry
      if (m.getTotalVertices() > 0 && m.isEnabled(false) && m !== wireSrc && (!oldSleeve || (m !== oldSleeve && m.parent !== oldSleeve))) this.meshes.push(m);
      const mat = m.material as PBRMaterial | null;
      if (mat instanceof PBRMaterial) {
        mat.environmentIntensity = 1;
        if (!this.diffuse.some((d) => d.material === mat)) this.diffuse.push({ material: mat, plugin: new ProbeDiffusePlugin(mat) });
        if (m.name === 'hand') { mat.roughness = 0.5; mat.metallic = 0; mat.sheen.isEnabled = true; mat.sheen.intensity = 0.25; mat.sheen.color = new Color3(1, 0.85, 0.8); }
        if (mat.name.includes('gaas')) { mat.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHATEST; mat.alphaCutOff = 0.5; mat.backFaceCulling = false; if (mat.albedoTexture) mat.albedoTexture.hasAlpha = true; }
      }
    }
    for (const m of this.meshes) m.renderingGroupId = 1;
    scene.setRenderingAutoClearDepthStencil(1, false, false, false);
    this.ready = true;
  }

  /** probe diffuse scale of the room the camera is in (World.diffuseGainAt) */
  setDiffuseGain(g: number) { for (const d of this.diffuse) d.plugin.gain = g; }

  setReflection(tex: BaseTexture | undefined) {
    if (!tex) return;
    for (const m of this.meshes) { const mat = m.material as PBRMaterial | null; if (mat instanceof PBRMaterial) mat.reflectionTexture = tex; }
  }

  /** Place swatter/hand from the physical pose; forearm/upper arm by two-bone IK from the shoulder. bodyHeight: the eye
   * above the feet (m): bent down low, the torso is shorter (its belly would reach through the floor). */
  sync(p: Pose, c: CamFrame, hand: number, bodyHeight = 1.62) {
    if (!this.ready) return;
    this.fitTorso(bodyHeight);
    const r = V(p.r), n = V(p.n), u = V(p.u);
    // model frame (glTF Y-up of Blender swatter frame): X -> r, Y (Blender Z, face normal) -> n, Z (-Blender Y) -> -u
    const q = basisToQuat(r, n, u.scale(-1));
    this.head.position.copyFrom(V(p.h)); this.head.rotationQuaternion = q;
    // the wire bends from the head's rib to the hand; grip and hand follow the handle frame at the hand
    const hu = V(p.hu), hn = V(p.hn);
    this.updateWire(p);
    // hand (hammer grip, armgeom.handAxes): model X -> face normal, model Y (palm) -> -r, model Z -> -handle;
    // the left-handed option mirrors the palm axis
    const grip = V(p.grip);
    this.hand.position.copyFrom(grip); this.hand.rotationQuaternion = basisToQuat(hn, r.scale(-1), hu.scale(-1));
    this.hand.scaling.set(1, hand, 1);
    const hw = handOnHandle(p.grip, p.r, p.hu, p.hn, hand);
    const wrist = V(hw.wrist), fdir = V(hw.fdir);
    // body frame: follows the view yaw (and the lean/crouch through the eye), not the head pitch
    const bf = bodyFrame(c.f, c.r);
    const fwdFlat = V(bf.fwd), rightFlat = V(bf.right);
    const eye = V(c.eye);
    // standing with the shoulder against a wall (the body keeps 0.20 m, the shoulder sits 0.19 m out): the shoulder is
    // pressed in rather than drawn inside the wall
    const s0 = shoulderAt(c.eye, bf.fwd, bf.right, hand);
    const inDepth = this.armDepth ? this.armDepth(s0, s0, ARM_CLEAR.shoulder) : 0;
    const pressed = inDepth > 0 ? { x: s0.x - bf.right.x * hand * inDepth, y: s0.y, z: s0.z - bf.right.z * hand * inDepth } : s0;
    // reaching up lifts the shoulder with the shoulder blade (as the strike planner assumes)
    const sock = { x: pressed.x, y: pressed.y + shoulderLift(pressed, hw.wrist), z: pressed.z };
    const socket = V(sock);
    const pref = armPole(bf.right, hand);
    const want = V(this.armDepth ? clearArmPole(hw.wrist, hw.fdir, sock, pref, this.armDepth) : pref).normalize();
    this.pole = this.pole ? Vector3.Lerp(this.pole, want, 0.35).normalize() : want;
    const pole = this.pole;
    const j = solveArm(wrist, fdir, socket, pole);
    this.joints = j;
    buildSleeve(this.sleeveBuf, j, fdir, n);
    this.sleeve.updateVerticesData(VertexBuffer.PositionKind, this.sleeveBuf.positions);
    this.sleeve.updateVerticesData(VertexBuffer.NormalKind, this.sleeveBuf.normals);
    this.sleeve.updateVerticesData(VertexBuffer.UVKind, this.sleeveBuf.uvs);
    // the bounds follow the rebuilt sleeve: the mirror selects what it draws by bounds, and a box stuck at the origin
    // left the sleeve out of the reflection (REVIEW-01 G-01)
    this.sleeve.refreshBoundingInfo();
    this.torso.position.copyFrom(eye);
    this.torso.rotationQuaternion = basisToQuat(rightFlat, new Vector3(0, 1, 0), fwdFlat.scale(-1));
  }

  /** Continuous sleeve (updated per frame) and torso in one knitted jumper material. */
  private buildCloth(scene: Scene) {
    const tx = knitTextures(128);
    const mk = (data: Uint8Array, gamma: boolean) => {
      const t = RawTexture.CreateRGBATexture(data, 128, 128, scene, true, false, Texture.TRILINEAR_SAMPLINGMODE);
      t.wrapU = t.wrapV = Texture.WRAP_ADDRESSMODE; t.gammaSpace = gamma; t.anisotropicFilteringLevel = 4;
      return t;
    };
    const m = new PBRMaterial('trui_breisel', scene);
    m.albedoColor = JUMPER; m.albedoTexture = mk(tx.albedo, true);
    m.bumpTexture = mk(tx.normal, false); m.bumpTexture.level = 0.55;
    m.metallic = 0; m.roughness = 0.92;
    m.sheen.isEnabled = true; m.sheen.intensity = 0.35; m.sheen.color = new Color3(0.75, 0.78, 0.82); m.sheen.roughness = 0.6;
    m.backFaceCulling = false; m.twoSidedLighting = true;
    this.diffuse.push({ material: m, plugin: new ProbeDiffusePlugin(m) });
    const sl = new Mesh('mouw', scene);
    const vd = new VertexData();
    vd.positions = this.sleeveBuf.positions; vd.normals = this.sleeveBuf.normals; vd.uvs = this.sleeveBuf.uvs; vd.indices = this.sleeveBuf.indices;
    vd.applyToMesh(sl, true);
    sl.material = m; sl.alwaysSelectAsActiveMesh = true; sl.isPickable = false;
    const tb = buildTorso();
    const to = new Mesh('romp', scene);
    const vt = new VertexData();
    vt.positions = tb.positions; vt.normals = tb.normals; vt.uvs = tb.uvs; vt.indices = tb.indices;
    vt.applyToMesh(to, true);
    this.torsoRest = Float32Array.from(tb.positions);
    to.material = m; to.alwaysSelectAsActiveMesh = true; to.isPickable = false;
    this.sleeve = sl; this.torso = to;
    this.meshes.push(sl, to);
  }

  /** Squatting or on hands and knees the body below the chest folds up: the torso's belly (below CHEST m under the eye)
   * is shortened so that it ends 8 cm above the floor; the chest and shoulders keep their shape (the arm hangs there). */
  private fitTorso(bodyHeight: number) {
    const CHEST = 0.32, FULL = 1.0;
    const k = Math.min(1, Math.max(0.15, (bodyHeight - 0.08 - CHEST) / (FULL - CHEST)));
    if (Math.abs(k - this.torsoK) < 0.01 && (k < 1 || this.torsoK === 1)) return;
    this.torsoK = k;
    const P = Float32Array.from(this.torsoRest);
    for (let i = 1; i < P.length; i += 3) if (P[i] < -CHEST) P[i] = -CHEST + (P[i] + CHEST) * k;
    this.torso.updateVerticesData(VertexBuffer.PositionKind, P);
  }

  /** Wire handle: a thin tube along swing.wirePoint (rib end -> grip), then straight on into the fist. */
  private buildWire(scene: Scene, mat: PBRMaterial) {
    const N = WIRE_RINGS, S = WIRE_SIDES;
    const idx: number[] = [];
    for (let j = 0; j < N - 1; j++) for (let i = 0; i < S; i++) {
      const a = j * S + i, b = j * S + (i + 1) % S, c = a + S, d = b + S;
      idx.push(a, c, b, b, c, d);
    }
    this.wireBuf = { positions: new Float32Array(N * S * 3), normals: new Float32Array(N * S * 3) };
    const m = new Mesh('mepper_draad_buig', scene);
    const vd = new VertexData();
    vd.positions = this.wireBuf.positions; vd.normals = this.wireBuf.normals; vd.indices = idx;
    vd.applyToMesh(m, true);
    m.material = mat; m.isPickable = false; m.alwaysSelectAsActiveMesh = true; m.renderingGroupId = 1;
    this.wire = m; this.meshes.push(m);
  }

  private updateWire(p: Pose) {
    const N = WIRE_RINGS, S = WIRE_SIDES, P = this.wireBuf.positions, Nm = this.wireBuf.normals;
    // centre line: N-2 samples on the bend, then the grip and a point inside the fist
    const c: P3[] = [];
    for (let k = 0; k < N - 1; k++) c.push(wirePoint(p, k / (N - 2)));
    c[N - 2] = p.grip;
    c.push({ x: p.grip.x + p.hu.x * WIRE.pastGrip, y: p.grip.y + p.hu.y * WIRE.pastGrip, z: p.grip.z + p.hu.z * WIRE.pastGrip });
    // ring frame: parallel transport from the head's r axis
    let nx = p.r.x, ny = p.r.y, nz = p.r.z;
    for (let k = 0; k < N; k++) {
      const a = c[Math.max(0, k - 1)], b = c[Math.min(N - 1, k + 1)];
      let tx = b.x - a.x, ty = b.y - a.y, tz = b.z - a.z;
      const tl = Math.hypot(tx, ty, tz) || 1; tx /= tl; ty /= tl; tz /= tl;
      const dn = nx * tx + ny * ty + nz * tz;
      nx -= tx * dn; ny -= ty * dn; nz -= tz * dn;
      const nl = Math.hypot(nx, ny, nz) || 1; nx /= nl; ny /= nl; nz /= nl;
      const bx = ty * nz - tz * ny, by = tz * nx - tx * nz, bz = tx * ny - ty * nx;
      for (let i = 0; i < S; i++) {
        const th = i / S * Math.PI * 2, cs = Math.cos(th), sn = Math.sin(th);
        const ox = nx * cs + bx * sn, oy = ny * cs + by * sn, oz = nz * cs + bz * sn, o = (k * S + i) * 3;
        P[o] = c[k].x + ox * WIRE.radius; P[o + 1] = c[k].y + oy * WIRE.radius; P[o + 2] = c[k].z + oz * WIRE.radius;
        Nm[o] = ox; Nm[o + 1] = oy; Nm[o + 2] = oz;
      }
    }
    this.wire.updateVerticesData(VertexBuffer.PositionKind, P);
    this.wire.updateVerticesData(VertexBuffer.NormalKind, Nm);
    this.wire.refreshBoundingInfo();
  }

  setVisible(v: boolean) { for (const m of this.meshes) m.setEnabled(v); }
}
