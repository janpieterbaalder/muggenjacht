// Loads the baked chalet (GLB + lightmaps + probes + collision) and prepares materials.
import { Scene } from '@babylonjs/core/scene';
import { Vector3, Matrix, Quaternion } from '@babylonjs/core/Maths/math.vector';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import { HDRCubeTexture } from '@babylonjs/core/Materials/Textures/hdrCubeTexture';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh';
import { ImportMeshAsync } from '@babylonjs/core/Loading/sceneLoader';
import '@babylonjs/loaders/glTF';
import { MeshoptCompression } from '@babylonjs/core/Meshes/Compression/meshoptCompression';
import { MirrorTexture } from '@babylonjs/core/Materials/Textures/mirrorTexture';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { ImageProcessingConfiguration } from '@babylonjs/core/Materials/imageProcessingConfiguration';
import { Plane } from '@babylonjs/core/Maths/math.plane';
import { BakedLightmapPlugin, LM_STOPS } from './lightmap';
import { illuminantToTemperatureTint } from './whitebalance';
import { setImageProcessingQuiet } from './imageprocessing';
import { parseCollision, type TriBVH } from '../physics/bvh';
import type { Obstacle2D } from '../physics/player';

export type LightState = 'dag' | 'avond' | 'nacht';
export const ROOM_BOXES: Record<string, [number, number, number, number]> = {
  // Babylon frame: x east, z south (= -north). [x0, z0, x1, z1] from R08 room rectangles.
  kind1: [0.08, -1.91, 2.40, -0.08], kind2: [0.08, -3.77, 2.40, -1.94], wc: [2.43, -1.20, 3.15, -0.08],
  woon: [2.43, -3.77, 6.19, -0.08], bad: [6.43, -1.30, 8.42, -0.08], ouder: [6.22, -3.77, 8.42, -1.33],
  buiten: [-3.0, 0.0, 9.0, 3.0],
};
/** probes loaded before a light state is shown: every round starts in the living room / kitchen */
const START_PROBES = ['woon', 'keuken'];
export const PROBE_POS: Record<string, [number, number, number]> = {
  woon: [4.20, 1.45, -1.90], keuken: [5.35, 1.45, -2.85], kind1: [1.25, 1.30, -1.00], kind2: [1.25, 1.30, -2.85],
  ouder: [7.30, 1.30, -2.60], bad: [7.05, 1.45, -0.75], wc: [2.80, 1.40, -0.60], buiten: [2.80, 1.20, 1.30],
};

const ROOM_IDS = ['wc', 'kind1', 'kind2', 'bad', 'ouder', 'woon'];
/** Chalet footprint (all rooms): inside it, a point between two room boxes is in a doorway or a wall. */
const FOOTPRINT = { x0: 0.08, z0: -3.77, x1: 8.42, z1: -0.08 };

export function roomAt(x: number, z: number): string {
  for (const id of ROOM_IDS) {
    const [x0, z0, x1, z1] = ROOM_BOXES[id];
    if (x >= x0 - 0.02 && x <= x1 + 0.02 && z >= z0 - 0.02 && z <= z1 + 0.02) return id;
  }
  // in a doorway between two rooms: the nearest room (walking through a door counted as 'outdoors' for a moment -
  // outdoor exposure target and ambience - found while checking REVIEW-01 G-08)
  if (x > FOOTPRINT.x0 - 0.02 && x < FOOTPRINT.x1 + 0.02 && z > FOOTPRINT.z0 - 0.02 && z < FOOTPRINT.z1 + 0.02) {
    let best = 'woon', bd = Infinity;
    for (const id of ROOM_IDS) {
      const [x0, z0, x1, z1] = ROOM_BOXES[id];
      const d = Math.hypot(Math.max(0, x0 - x, x - x1), Math.max(0, z0 - z, z - z1));
      if (d < bd) { bd = d; best = id; }
    }
    return best;
  }
  return 'buiten';
}

export interface Door {
  id: string; node: TransformNode; hinge: Vector3; angle: number; target: number; openSign: number; width: number;
  closedYaw: number; leafDir: Vector3; axis: 'x' | 'z'; moving: boolean;
  /** widest opening before the leaf meets furniture or a wall (measured against the collision mesh at load) */
  maxOpen: number;
  /** lightmap plugins of this door's own material clones (closed-state bake -> probe light as it opens) */
  lm: BakedLightmapPlugin[];
  /** room the leaf swings into: its probe lights the open leaf */
  room: string;
}

export interface LightMeta {
  lm: Record<string, Record<string, { range: number; p50: number; size: number; enc?: string }>>;
  probes: Record<string, Record<string, { logavg: number; mean: number; logavg_band: number }>>;
  sky: Record<string, { K: number; logavg: number }>;
  /** illuminant (baked irradiance, all texels of the room) per state and room, linear RGB (illuminant_stats.py) */
  illum: Record<string, Record<string, [number, number, number]>>;
  /** the same on the walls only: what the camera-like white balance neutralises (lm/wb.json; REVIEW-01 G-05) */
  wb: Record<string, Record<string, [number, number, number]>>;
  /** box-projection boxes of the probes (bake_export.py); capture point = box centre */
  boxes: Record<string, { center: [number, number, number]; size: [number, number, number]; projected: boolean }>;
}

export interface World {
  bvh: TriBVH; doors: Door[]; statics: AbstractMesh[]; dynamics: AbstractMesh[];
  lightmaps: Record<string, Texture>; probes: Record<string, HDRCubeTexture>; meta: LightMeta;
  /** requested light state and the state actually shown (missing bakes fall back to 'dag', reported in info) */
  state: LightState; shownState: LightState;
  setState(a: LightState, b?: LightState, mix?: number): void; setExposure(e: number): void;
  /** load a state's lightmaps and the start rooms' probes before it is shown (other probes stream in afterwards) */
  prepareState(st: LightState): Promise<void>;
  doorObstacles(): Obstacle2D[]; probeFor(x: number, z: number): HDRCubeTexture | undefined;
  /** reflection probe for a room that is ready to use (the room's own, else the living room's) */
  pickProbe(room: string, state: string): HDRCubeTexture | undefined;
  /** scale for diffuse probe light in a room (shown state): baked floor+ceiling irradiance / probe mean radiance, so
   * objects lit only by the probe sit at the level of the baked surfaces around them (D47) */
  diffuseGain(room: string): number;
  diffuseGainAt(x: number, z: number): number;
  /** log-average scene luminance around a position (Cycles units) from the baked probes / sky, for eye adaptation */
  luminanceAt(x: number, z: number): number;
  /** illuminant colour (linear RGB, any scale) around a position, for white balance */
  illuminantAt(x: number, z: number): [number, number, number];
  /** the same illuminant as correlated colour temperature (K) and tint (Babylon white-balance units) */
  whiteBalanceAt(x: number, z: number): { temperature: number; tint: number };
  info: Record<string, unknown>;
  /** render the mirror once or twice ahead of time so its shader variants compile while loading (G-12: the first look
   * into the bathroom mirror stalled ~0.45 s) */
  warmUp(): Promise<void>;
}

/** Veranda roof footprint (Babylon frame) - under it the veranda probe applies, beyond it the open sky. */
const VERANDA = { x0: -0.10, x1: 6.20, z0: 0.0, z1: 2.50 };

const BASE = import.meta.env.BASE_URL + 'assets/';
// chalet.glb is meshopt-compressed (optimize_glb.mjs, D46); the decoder ships with the game instead of Babylon's CDN
MeshoptCompression.Configuration = { decoder: { url: import.meta.env.BASE_URL + 'lib/meshopt_decoder.js' } };
// dev only: ?glb=<file> loads another chalet GLB from assets/ (A/B checks of optimised exports)
const GLB = (import.meta.env.DEV && new URLSearchParams(location.search).get('glb')) || 'chalet.glb';

export async function loadWorld(scene: Scene, onProgress: (f: number, label: string) => void): Promise<World> {
  onProgress(0.05, 'Chalet laden');
  const res = await ImportMeshAsync(BASE + GLB, scene, {
    onProgress: (e) => { if (e.lengthComputable) onProgress(0.05 + 0.55 * e.loaded / e.total, 'Chalet laden'); },
  });
  onProgress(0.62, 'Botsingen');
  const [collBuf, lmMeta, probeMeta, skyMeta, illumMeta, boxMeta, wbMeta] = await Promise.all([
    fetch(BASE + 'chalet_coll.bin').then((r) => { if (!r.ok) throw new Error('chalet_coll.bin ' + r.status); return r.arrayBuffer(); }),
    fetchJson(BASE + 'lm/lm.json'), fetchJson(BASE + 'probes/probes.json'), fetchJson(BASE + 'sky/sky.json'),
    fetchJson(BASE + 'lm/illum.json').catch(() => ({})), fetchJson(BASE + 'probes/probe_boxes.json').catch(() => ({ boxes: {} })),
    fetchJson(BASE + 'lm/wb.json').catch(() => ({})),
  ]);
  const meta: LightMeta = { lm: lmMeta as LightMeta['lm'], probes: probeMeta as LightMeta['probes'], sky: skyMeta as LightMeta['sky'],
    illum: illumMeta as LightMeta['illum'], wb: wbMeta as LightMeta['illum'], boxes: (boxMeta as { boxes: LightMeta['boxes'] }).boxes ?? {} };
  const bvh = parseCollision(collBuf);
  const baked = (st: string) => !!meta.lm[st] && !!meta.probes[st];
  for (const [st, atl] of Object.entries(meta.lm)) for (const [a, v] of Object.entries(atl)) {
    if ((v as { enc?: string }).enc !== `log2-${LM_STOPS}`) console.warn(`lichtkaart ${a}_${st}: codering ${(v as { enc?: string }).enc} verwacht log2-${LM_STOPS}`);
  }
  onProgress(0.7, 'Licht');
  const lightmaps: Record<string, Texture> = {};
  const lm = (atlas: string, state: string) => {
    const k = `${atlas}_${state}`;
    if (!lightmaps[k]) {
      // trilinear: the atlas background is filled (filter_lightmaps.py), so smaller mip levels no longer pull black
      // into island edges; nearest-mip switching showed as bands on floors and walls seen at a grazing angle
      const t = new Texture(`${BASE}lm/lm_${atlas}_${state}.jpg`, scene, false, false, Texture.TRILINEAR_SAMPLINGMODE);
      t.coordinatesIndex = 1; t.gammaSpace = false; t.wrapU = t.wrapV = Texture.CLAMP_ADDRESSMODE;
      lightmaps[k] = t;
    }
    return lightmaps[k];
  };
  const probes: Record<string, HDRCubeTexture> = {};
  const probeTex = (room: string, state: string) => {
    const k = `${room}_${state}`;
    if (!probes[k]) {
      // not blocking: materials only get a probe once it is ready (pickProbe), so the start does not wait for all 11
      const t = new HDRCubeTexture(`${BASE}probes/probe_${room}_${state}.hdr`, scene, 128, false, true, false, true,
        () => { if (state === currentState) applyProbes(scene, world, state); });
      // box projection needs the capture point at the box centre (bake_export.py PROBE_BOXES / probe_boxes.json)
      const b = meta.boxes[room];
      if (b && b.projected) {
        t.boundingBoxPosition = new Vector3(b.center[0], b.center[1], b.center[2]);
        t.boundingBoxSize = new Vector3(b.size[0], b.size[1], b.size[2]);
      }
      probes[k] = t;
    }
    return probes[k];
  };
  const ready = <T extends { isReady(): boolean }>(t: T | undefined) => (t && t.isReady() ? t : undefined);
  // the room's own probe once loaded, else the living room's (all rounds start there, prepareState loads it first)
  const pickProbe = (room: string, state: string) => ready(probes[`${room}_${state}`]) ?? ready(probes[`woon_${state}`]);
  const whenReady = (t: { isReady(): boolean }) => new Promise<void>((res) => { const chk = () => (t.isReady() ? res() : setTimeout(chk, 40)); chk(); });
  const statics: AbstractMesh[] = [], dynamics: AbstractMesh[] = [];
  const plugins: BakedLightmapPlugin[] = [];
  const doors: Door[] = [];
  const cloneCache = new Map<string, PBRMaterial>();
  const frosted = new Set<PBRMaterial>();
  const mirrors: AbstractMesh[] = [];
  const clonePlugin = new Map<PBRMaterial, BakedLightmapPlugin>();
  const doorPlugins = new Map<string, BakedLightmapPlugin[]>();
  const lmClone = (mat: PBRMaterial, atlas: string, owner = '') => {
    // per-atlas material clone so each atlas binds its own lightmap; doors get their own clones (own light blend)
    const key = mat.name + '|' + atlas + '|' + owner;
    let mm = cloneCache.get(key);
    if (!mm) {
      mm = mat.clone(mat.name + '_' + atlas + (owner ? '_' + owner : '')) as PBRMaterial;
      const pl = new BakedLightmapPlugin(mm);
      pl.atlas = atlas;
      pl.setTextures(lm(atlas, 'dag'), meta.lm.dag?.[atlas]?.range ?? 1);
      plugins.push(pl);
      clonePlugin.set(mm, pl);
      cloneCache.set(key, mm);
    }
    return mm;
  };
  for (const m of res.meshes) {
    const ex = (m.metadata?.gltf?.extras ?? {}) as Record<string, unknown>;
    const pex = (m.parent?.metadata?.gltf?.extras ?? {}) as Record<string, unknown>;   // multi-primitive nodes carry the extras
    const node = m.name;
    if (!m.getTotalVertices()) continue;
    m.isPickable = false;
    m.receiveShadows = false;
    const mat = m.material as PBRMaterial | null;
    // game flags: node extras (merged statics) or material extras (joined door parts, e.g. terrace-door glass)
    const game = { ...safeJson(String((mat?.metadata?.gltf?.extras as Record<string, unknown> | undefined)?.game ?? '{}')), ...safeJson(String(ex.game ?? '{}')) };
    if (mat && mat instanceof PBRMaterial) {
      mat.environmentIntensity = 1;
      // 'silver' = the silvered bathroom mirror (planar reflection); 'mirror' = dark glossy glass (TV, splash panel).
      // Exports before D51 carried 'mirror' for the bathroom mirror too: recognised by its material name.
      if (game.glass === 'silver' || (game.glass === 'mirror' && mat.name.startsWith('mirror_glass'))) mirrors.push(m);
      else if (game.glass) { setupGlass(mat, String(game.glass)); if (game.glass === 'frosted') frosted.add(mat); }
      if (game.emit || game.unlit) { mat.unlit = false; mat.emissiveIntensity = 1.0; }
      if (game.twosided) mat.backFaceCulling = false;           // thin shells seen from both sides (glowing lamp-shade insides)
      if (game.alphatest) { mat.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHATEST; mat.alphaCutOff = 0.45; mat.backFaceCulling = false; if (mat.albedoTexture) mat.albedoTexture.hasAlpha = true; }
    }
    const atlas = String(ex.atlas ?? '');
    // older exports also wrote the door leaves (atlas F) as static meshes: a closed copy stayed in the doorway
    if (node.startsWith('S_F_') || (node.startsWith('S_') && atlas === 'F')) { m.dispose(); continue; }
    if (node.startsWith('S_') && atlas && mat instanceof PBRMaterial) {
      m.material = lmClone(mat, atlas);
      statics.push(m);
      m.freezeWorldMatrix();
    } else if (String(ex.door ?? pex.door ?? '') || node.startsWith('D_')) {
      // door leaves: lightmapped in the closed state (atlas F) when baked and not glass
      const da = String(ex.atlas ?? pex.atlas ?? '');
      const did = String(ex.door ?? pex.door ?? '') || node.slice(2).replace(/_primitive\d+$/, '').replace(/_mesh$/, '');
      if (da && meta.lm.dag?.[da] && mat instanceof PBRMaterial && !game.glass && m.getVerticesData('uv2')) {
        const mm = lmClone(mat, da, did);
        m.material = mm;
        const pl = clonePlugin.get(mm)!, list = doorPlugins.get(did) ?? [];
        if (!list.includes(pl)) list.push(pl);
        doorPlugins.set(did, list);
      }
      m.metadata = { ...(m.metadata ?? {}), mjDoor: did };
      dynamics.push(m);
    } else {
      statics.push(m);
      m.freezeWorldMatrix();
    }
  }
  // doors: glTF nodes named D_<id>; hinge = node position
  for (const tn of scene.transformNodes.concat(res.meshes as unknown as TransformNode[])) {
    if (!tn.name.startsWith('D_') || doors.some((d) => d.node === tn)) continue;
    const ex = (tn.metadata?.gltf?.extras ?? {}) as Record<string, unknown>;
    const hinge = tn.getAbsolutePosition().clone();
    const did = tn.name.slice(2);
    const spec = DOOR_SPEC[did];
    if (!spec) continue;
    tn.rotationQuaternion = null;
    const door: Door = { id: did, node: tn, hinge, angle: 0, target: spec.start, openSign: spec.sign, width: spec.width, closedYaw: tn.rotation.y,
      leafDir: new Vector3(spec.dir[0], 0, spec.dir[1]), axis: spec.axis, moving: false, maxOpen: Math.PI / 2,
      lm: doorPlugins.get(did) ?? [], room: DOOR_ROOM[did] ?? 'woon' };
    door.maxOpen = measureMaxOpen(bvh, door);
    doors.push(door);
    void ex;
  }
  const mirrorTargets = mirrors.map((mm) => setupMirror(scene, mm));
  onProgress(0.85, 'Reflecties');
  const sky = addSky(scene, meta);
  const wbCache = new Map<string, { temperature: number; tint: number }>();
  const world: World = {
    bvh, doors, statics, dynamics, lightmaps, probes, meta, state: 'dag', shownState: 'dag', pickProbe,
    async prepareState(st) {
      const s0: LightState = baked(st) ? st : 'dag';
      await Promise.all([...Object.keys(meta.lm[s0] ?? {}).map((a) => lm(a, s0)), ...START_PROBES.map((r) => probeTex(r, s0))].map(whenReady));
    },
    setState(a, b, mix = 0) {
      const sa: LightState = baked(a) ? a : 'dag';
      const sb: LightState = b && baked(b) ? b : sa;
      world.state = a; world.shownState = sa;
      world.info.lightFallback = sa !== a ? `${a} niet gebakken: ${sa} getoond` : null;
      for (const pl of plugins) {
        pl.setTextures(lm(pl.atlas, sa), meta.lm[sa][pl.atlas]?.range ?? 1, lm(pl.atlas, sb), meta.lm[sb][pl.atlas]?.range ?? 1);
        pl.mix = mix;
      }
      // start-room probes now; the other rooms' probes download once the scene is ready (they would otherwise share
      // the bandwidth with the lightmaps the start needs) and are applied as each arrives (woon probe meanwhile)
      for (const room of START_PROBES) probeTex(room, sa);
      scene.executeWhenReady(() => { for (const room of Object.keys(meta.boxes).length ? Object.keys(meta.boxes) : Object.keys(PROBE_POS)) probeTex(room, sa); });
      applyProbes(scene, world, sa);
      // satin glass (wc, bathroom; R10) scatters the daylight: a bright even panel, no view. Luminance = transmittance
      // (0.60, bake_export GLASS_T) x mean luminance around the veranda probe of this light state
      const lOut = 0.6 * (meta.probes[sa]?.buiten?.mean ?? 0.05);
      for (const fm of frosted) fm.emissiveColor.set(lOut, lOut * 0.99, lOut * 0.965);
      sky.set(sa, meta.sky[sa]?.K ?? 1);
    },
    luminanceAt(x, z) {
      const st = world.shownState;
      const P = meta.probes[st] ?? meta.probes.dag;
      const r = roomAt(x, z);
      if (r !== 'buiten') {
        const key = r === 'woon' && z < -2.3 && x > 4.6 ? 'keuken' : r;
        return P[key]?.logavg ?? P.woon.logavg;
      }
      // outdoors: veranda (under the roof) blends into the open garden (sky log-average)
      const ver = P.buiten?.logavg ?? P.woon.logavg;
      const open = meta.sky[st]?.logavg ?? ver;
      const dz = Math.max(0, z - VERANDA.z1), dx = Math.max(0, VERANDA.x0 - x, x - VERANDA.x1);
      const t = Math.min(1, Math.hypot(dx, dz) / 1.2);
      return Math.exp(Math.log(ver) * (1 - t) + Math.log(open) * t);
    },
    setExposure(e) { setImageProcessingQuiet(scene.imageProcessingConfiguration, e); },
    doorObstacles() {
      const out: Obstacle2D[] = [];
      for (const d of doors) {
        const yaw = d.closedYaw + d.angle * d.openSign;
        const c = Math.cos(yaw), s = Math.sin(yaw);
        // leaf runs from hinge along leafDir rotated by current angle
        const lx = d.leafDir.x * c + d.leafDir.z * s, lz = -d.leafDir.x * s + d.leafDir.z * c;
        out.push({ ax: d.hinge.x, az: d.hinge.z, bx: d.hinge.x + lx * d.width, bz: d.hinge.z + lz * d.width, half: 0.022, y0: 0, y1: 2.2 });
      }
      return out;
    },
    probeFor(x, z) { return pickProbe(probeRoom(x, z), currentState); },
    diffuseGain(room) {
      const st = world.shownState;
      const ill = (meta.illum[st] ?? meta.illum.dag ?? {})[room === 'keuken' ? 'woon' : room];
      const pm = (meta.probes[st] ?? meta.probes.dag)?.[room]?.mean;
      if (!ill || !pm) return 1;                        // outdoors / missing data: probe as captured
      return Math.min(1, Math.max(0.1, (0.2126 * ill[0] + 0.7152 * ill[1] + 0.0722 * ill[2]) / pm));
    },
    diffuseGainAt(x, z) { return world.diffuseGain(probeRoom(x, z)); },
    illuminantAt(x, z) {
      const I = meta.illum[world.shownState] ?? meta.illum.dag ?? {};
      const W = meta.wb?.[world.shownState] ?? {};
      const r = roomAt(x, z);
      return W[r] ?? I[r] ?? I.woon ?? [1, 1, 1];
    },
    whiteBalanceAt(x, z) {
      const k = `${world.shownState}|${roomAt(x, z)}`;
      let v = wbCache.get(k);
      if (!v) { v = illuminantToTemperatureTint(world.illuminantAt(x, z)); wbCache.set(k, v); }
      return v;
    },
    info: { meshes: res.meshes.length, statics: statics.length, dynamics: dynamics.length, doors: doors.length, tris: bvh.triCount, lightFallback: null },
    async warmUp() {
      if (!scene.activeCamera) return;
      for (const rt of mirrorTargets) for (let i = 0; i < 6; i++) { rt.render(); await new Promise((r) => setTimeout(r, 20)); }
    },
  };
  let currentState: LightState = 'dag';
  const origSet = world.setState;
  world.setState = (a, b, mix) => { origSet(a, b, mix); currentState = world.shownState; };
  await world.prepareState('dag');
  world.setState('dag');
  onProgress(1, 'Klaar');
  return world;
}

function applyProbes(scene: Scene, world: World, state: string) {
  for (const m of world.statics) {
    const mat = m.material as PBRMaterial | null;
    if (!mat || !(mat instanceof PBRMaterial)) continue;
    const c = m.getBoundingInfo().boundingBox.centerWorld;
    const probe = world.pickProbe(probeRoom(c.x, c.z), state);
    if (probe) mat.reflectionTexture = probe;
  }
  for (const m of world.dynamics) {
    const mat = m.material as PBRMaterial | null;
    if (mat instanceof PBRMaterial) {
      const c = m.getBoundingInfo().boundingBox.centerWorld;
      const door = (m.metadata as { mjDoor?: string } | null)?.mjDoor;
      const room = door && FITTING_ROOM[door] && FITTING.test(mat.name) ? FITTING_ROOM[door] : door && DOOR_ROOM[door] ? DOOR_ROOM[door] : probeRoom(c.x, c.z);
      const probe = world.pickProbe(room, state);
      if (probe) mat.reflectionTexture = probe;
    }
  }
  void scene;
}

/** Bathroom mirror (R12, D51): a real planar reflection (the scene rendered from the mirrored camera) instead of the
 * 128 px room probe - round 7 is about telling a real mosquito from its reflection. Only the bathroom and what moves
 * in it (arm, mosquitoes, door leaves) are drawn into it, and only while the mirror itself is on screen (Babylon renders
 * a material's reflection target only for visible meshes). The target holds already exposed, tone-mapped colours, so
 * the mirror material has its own neutral image processing (no second tone mapping). */
function setupMirror(scene: Scene, m: AbstractMesh): MirrorTexture {
  m.computeWorldMatrix(true);
  const bb = m.getBoundingInfo().boundingBox;
  const ext = bb.extendSizeWorld, c = bb.centerWorld.clone();
  // thin axis = mirror normal; it faces the room centre
  const axis = ext.x <= ext.y && ext.x <= ext.z ? new Vector3(1, 0, 0) : ext.z <= ext.y ? new Vector3(0, 0, 1) : new Vector3(0, 1, 0);
  const room = ROOM_BOXES[roomAt(c.x, c.z)] ?? ROOM_BOXES.bad;
  const toRoom = new Vector3((room[0] + room[2]) / 2 - c.x, 0, (room[1] + room[3]) / 2 - c.z);
  const n = Vector3.Dot(axis, toRoom) >= 0 ? axis : axis.scale(-1);
  const face = c.add(n.scale(Math.min(ext.x, ext.y, ext.z)));
  const rt = new MirrorTexture('spiegel_rt', { ratio: 0.6 }, scene, true);
  rt.mirrorPlane = Plane.FromPositionAndNormal(face, n.scale(-1));
  rt.level = 0.9;                                    // silvered glass reflects ~90 %
  rt.samples = 4;
  rt.adaptiveBlurKernel = 0;
  const [x0, z0, x1, z1] = room;
  // everything whose bounds overlap the room (+35 cm): the baked statics are merged per atlas and material, so a
  // wall mesh can span several rooms - its centre may lie outside the bathroom (the first version showed only the
  // clear colour where walls should be)
  rt.renderListPredicate = (mesh) => {
    if (mesh === m || mesh.name === 'sky' || !mesh.isEnabled() || !mesh.isVisible) return false;
    const md = mesh.metadata as { mjMirror?: 'only' | 'never' } | null;
    if (md?.mjMirror === 'never') return false;                // first-person-only parts (the torso seen from above)
    const bbm = mesh.getBoundingInfo().boundingBox, lo = bbm.minimumWorld, hi = bbm.maximumWorld;
    return hi.x > x0 - 0.35 && lo.x < x1 + 0.35 && hi.z > z0 - 0.35 && lo.z < z1 + 0.35;
  };
  // In this right-handed scene Babylon's inversion of the cull face for reflections culled the front faces (the mirror
  // showed only the clear colour). Override the cull face at engine level while the mirror renders - a GL state, not a
  // material property: flipping every material's backFaceCulling marked ~280 materials dirty per mirror render (G-12).
  const engine = scene.getEngine();
  rt.onBeforeRenderObservable.add(() => { engine.cullBackFaces = true; });
  rt.onAfterRenderObservable.add(() => { engine.cullBackFaces = null; });
  const mat = new StandardMaterial('spiegel', scene);
  mat.diffuseColor = new Color3(0.02, 0.02, 0.02); mat.specularColor = new Color3(0.05, 0.05, 0.05); mat.emissiveColor = new Color3(0, 0, 0);
  mat.reflectionTexture = rt;
  const ip = new ImageProcessingConfiguration(); ip.isEnabled = false;
  mat.imageProcessingConfiguration = ip;
  m.material = mat;
  return rt;
}

function setupGlass(mat: PBRMaterial, kind: string) {
  mat.metallic = 0; mat.roughness = kind === 'frosted' ? 0.45 : 0.03;
  if (kind === 'frosted') {
    // opaque diffuser (was 55 % see-through: the veranda showed through the wc and bathroom windows)
    mat.subSurface.isRefractionEnabled = false; mat.transparencyMode = PBRMaterial.PBRMATERIAL_OPAQUE; mat.alpha = 1;
    mat.albedoColor = new Color3(0.9, 0.92, 0.92); mat.backFaceCulling = false;
    return;
  }
  mat.subSurface.isRefractionEnabled = false;
  mat.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHABLEND;
  mat.alpha = kind === 'frosted' ? 0.55 : kind === 'mirror' ? 1.0 : 0.12;
  mat.albedoColor = kind === 'frosted' ? new Color3(0.9, 0.92, 0.92) : new Color3(0.02, 0.025, 0.025);
  mat.backFaceCulling = false;
  mat.needDepthPrePass = false;
}

/** Probe that covers a position: rooms, with the kitchen corner as its own box (x > 4.60, z < -2.30). */
export function probeRoom(x: number, z: number): string {
  const r = roomAt(x, z);
  if (r === 'buiten') return z < -3.85 ? 'tuin_noord' : z > 2.6 ? 'tuin' : 'buiten';   // open garden vs under the veranda roof
  return r === 'woon' && x > 4.60 && z < -2.30 ? 'keuken' : r;
}

/** Sky dome: equirect JPEG in bake units (prep_sky.py: linear = pixel^2.2 * K) on an inside-out sphere whose
 * UVs follow Babylon's fixed-equirect convention; unlit PBR so exposure AND white balance apply like the world. */
function addSky(scene: Scene, meta: LightMeta) {
  const R = 85, NU = 96, NV = 48;
  const pos: number[] = [], uv: number[] = [], idx: number[] = [];
  for (let j = 0; j <= NV; j++) {
    const t = j / NV, th = t * Math.PI;
    for (let i = 0; i <= NU; i++) {
      const u = i / NU, lon = (u - 0.5) * 2 * Math.PI;
      pos.push(R * Math.sin(th) * Math.cos(lon), R * Math.cos(th), R * Math.sin(th) * Math.sin(lon));
      uv.push(u, t);
    }
  }
  for (let j = 0; j < NV; j++) for (let i = 0; i < NU; i++) {
    const a = j * (NU + 1) + i, b = a + 1, c = a + NU + 1, d = c + 1;
    idx.push(a, c, b, b, c, d);
  }
  const dome = new Mesh('sky', scene);
  const vd = new VertexData(); vd.positions = pos; vd.uvs = uv; vd.indices = idx; vd.applyToMesh(dome);
  const m = new PBRMaterial('sky', scene);
  m.unlit = true; m.backFaceCulling = false; m.metallic = 0; m.roughness = 1;
  dome.material = m; dome.isPickable = false; dome.infiniteDistance = true;
  dome.position = new Vector3(4.25, 0, -1.9);
  const tex: Record<string, Texture> = {};
  let shown = '';
  void meta;
  return {
    dome, m,
    set(state: string, K: number) {
      if (shown === state) return;
      shown = state;
      let t = tex[state];
      if (!t) {
        t = tex[state] = new Texture(BASE + `sky/sky_${state}.jpg`, scene, false, false, Texture.TRILINEAR_SAMPLINGMODE);
        t.wrapU = Texture.WRAP_ADDRESSMODE; t.wrapV = Texture.CLAMP_ADDRESSMODE;
      }
      m.albedoTexture = t;                    // sRGB texture -> linear in the PBR shader
      m.albedoColor = new Color3(K, K, K);     // bake units
    },
  };
}

async function fetchJson(url: string): Promise<unknown> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(url.split('/').pop() + ' ' + r.status);
  return r.json();
}

/** Sweep the leaf from closed to 95 deg and stop 3 deg before it would touch furniture or a wall. Triangles that
 * already touch the leaf when (almost) closed - frame, stop, threshold - are ignored. E.g. the door of kids room 2
 * meets the corner sofa just before 90 deg (R08 layout). */
function measureMaxOpen(bvh: TriBVH, d: Door): number {
  const out = new Float32Array(3);
  const R = 0.028;                                   // half leaf thickness + clearance
  const touching = (a: number, ignore: Set<number> | null, collect: Set<number> | null) => {
    const yaw = d.closedYaw + a * d.openSign;
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const lx = d.leafDir.x * c + d.leafDir.z * s, lz = -d.leafDir.x * s + d.leafDir.z * c;
    let hitAny = false;
    for (let t = 0.03; t <= d.width - 0.005 && !hitAny; t += 0.03) {
      const px = d.hinge.x + lx * t, pz = d.hinge.z + lz * t;
      for (const py of [0.1, 0.5, 1.0, 1.5, 2.0]) {
        bvh.querySphere(px, py, pz, R + (collect ? 0.02 : 0), (tri) => {
          if (ignore?.has(tri)) return;
          bvh.closestOnTri(tri, px, py, pz, out);
          if (Math.hypot(out[0] - px, out[1] - py, out[2] - pz) < R + (collect ? 0.02 : 0)) { if (collect) collect.add(tri); else hitAny = true; }
        }, 1 | 4 | 8);
        if (hitAny) break;
      }
    }
    return hitAny;
  };
  const frame = new Set<number>();
  for (const a of [0, 0.03, 0.06, 0.1]) touching(a, null, frame);
  const step = Math.PI / 180;
  for (let a = 8 * step; a <= 95 * step; a += step) if (touching(a, frame, null)) return Math.max(Math.PI / 4, a - 3 * step);
  return Math.PI / 2;
}

function safeJson(s: string): Record<string, unknown> { try { return JSON.parse(s) as Record<string, unknown>; } catch { return {}; } }

// Door kinematics (Babylon frame). dir = unit vector hinge->latch when closed (x,z); sign = rotation sign that opens toward
// the swing side recorded in R08 (all interior doors open into the living room; en-suite into bathroom; French door out).
/** Room each leaf swings into (R08: interior doors into the living room, en-suite into the bathroom, French door out). */
export const DOOR_ROOM: Record<string, string> = { kind1: 'woon', kind2: 'woon', wc: 'woon', ouder: 'woon', bad: 'woon', suite: 'bad', terras: 'buiten', douche: 'bad' };
/** Fittings on the other face of a leaf than the room it swings into reflect the room they face: the black hooks on the
 * bathroom side of the bathroom door mirrored the warm living-room probe and read bronze (R13: matt black; REVIEW-01 G-06). */
export const FITTING_ROOM: Record<string, string> = { bad: 'bad' };
const FITTING = /^(hook_black|screw_steel)/;
export const DOOR_SPEC: Record<string, { width: number; dir: [number, number]; sign: number; start: number; axis: 'x' | 'z' }> = {
  kind2: { width: 0.605, dir: [0, 1], sign: 1, start: 0, axis: 'x' },
  kind1: { width: 0.61, dir: [0, -1], sign: -1, start: 0, axis: 'x' },
  wc: { width: 0.62, dir: [1, 0], sign: 1, start: 0, axis: 'z' },
  ouder: { width: 0.595, dir: [0, 1], sign: -1, start: 0, axis: 'x' },
  bad: { width: 0.56, dir: [0, -1], sign: 1, start: 0, axis: 'x' },
  suite: { width: 0.56, dir: [1, 0], sign: -1, start: 0, axis: 'z' },
  terras: { width: 0.64, dir: [-1, 0], sign: 1, start: 0, axis: 'z' },
  douche: { width: 0.77, dir: [0, -1], sign: 1, start: 0, axis: 'x' },      // D51: shower frame 0.08-0.92 (R10/R13)
};
void Matrix; void Quaternion; void PROBE_POS;
