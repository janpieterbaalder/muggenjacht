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
import { ARM_CLEAR, HAND, allocSleeve, armPole, bodyFrame, buildSleeve, buildTorso, clearArmPole, handOnHandle, knitTextures, shoulderAt, solveArm, type TubeBuffers, type ArmJoints, type P3 } from './armgeom';
import type { Pose, CamFrame } from './swing';
import { ProbeDiffusePlugin } from '../engine/lightmap';

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
      if (m.getTotalVertices() > 0 && m.isEnabled(false) && (!oldSleeve || (m !== oldSleeve && m.parent !== oldSleeve))) this.meshes.push(m);
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

  /** Place swatter/hand from the physical pose; forearm/upper arm by two-bone IK from the shoulder. */
  sync(p: Pose, c: CamFrame, hand: number) {
    if (!this.ready) return;
    const r = V(p.r), n = V(p.n), u = V(p.u);
    // model frame (glTF Y-up of Blender swatter frame): X -> r, Y (Blender Z, face normal) -> n, Z (-Blender Y) -> -u
    const q = basisToQuat(r, n, u.scale(-1));
    this.head.position.copyFrom(V(p.h)); this.head.rotationQuaternion = q;
    // shaft, grip and hand follow the handle frame (head flexed against the handle about r)
    const hu = V(p.hu), hn = V(p.hn);
    const neck = V(p.h).add(u.scale(HAND.neck));
    this.stick.position.copyFrom(neck); this.stick.rotationQuaternion = basisToQuat(r, hn, hu.scale(-1));
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
    const sock = inDepth > 0 ? { x: s0.x - bf.right.x * hand * inDepth, y: s0.y, z: s0.z - bf.right.z * hand * inDepth } : s0;
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
    vt.applyToMesh(to, false);
    to.material = m; to.alwaysSelectAsActiveMesh = true; to.isPickable = false;
    this.sleeve = sl; this.torso = to;
    this.meshes.push(sl, to);
  }

  setVisible(v: boolean) { for (const m of this.meshes) m.setEnabled(v); }
}
