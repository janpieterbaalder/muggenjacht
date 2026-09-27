// Baked global illumination for static chalet meshes: replaces the environment irradiance of the
// PBR shader with Cycles-baked irradiance (UV2, log2-encoded), so albedo, AO, specular energy conservation and the
// probe-based specular reflections stay intact. Two lightmaps (state A/B, each with its own encode
// range from lm.json) can be cross-faded for time-of-day transitions.
// Injection: regex replacement of the line in pbrBlockFinalLitComponents that reads the environment
// irradiance (runs after include expansion, i.e. after reflectionOut exists).
import { MaterialPluginBase } from '@babylonjs/core/Materials/materialPluginBase';
import { MaterialDefines } from '@babylonjs/core/Materials/materialDefines';
import type { Material } from '@babylonjs/core/Materials/material';
import type { BaseTexture } from '@babylonjs/core/Materials/Textures/baseTexture';
import type { UniformBuffer } from '@babylonjs/core/Materials/uniformBuffer';
import type { Scene } from '@babylonjs/core/scene';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh';
import { RegisterClass } from '@babylonjs/core/Misc/typeStore';

class BakedLMDefines extends MaterialDefines { BAKEDLM = false; }

/** Lightmap encoding (encode_lightmaps.py): E = max * 2^((v - 1) * LM_STOPS) per channel. */
export const LM_STOPS = 14;

/** Pattern of the irradiance read in Babylon's PBR shader (checked by tests/game.test.ts). */
export const IRRADIANCE_LINE = 'vec3 finalIrradiance=reflectionOut.environmentIrradiance;';

export class BakedLightmapPlugin extends MaterialPluginBase {
  texA: BaseTexture | null = null;
  texB: BaseTexture | null = null;
  rangeA = 1; rangeB = 1; gain = 1; mix = 0;
  /** 0 = baked irradiance, 1 = the probe's irradiance. Door leaves are baked closed: once a door opens its faces turn
   * into the room it opens into and the closed-state lightmap no longer applies (core.ts ramps this with the angle). */
  ibl = 0;
  /** scale of the probe irradiance used in that blend (World.diffuseGain: probe level -> lightmap level) */
  iblGain = 1;
  atlas = '';
  private _on = false;

  constructor(material: Material) {
    super(material, 'BakedLightmap', 210, new BakedLMDefines(), true);
  }

  get isEnabled() { return this._on; }
  set isEnabled(v: boolean) { if (v === this._on) return; this._on = v; this.markAllDefinesAsDirty(); this._enable(v); }

  setTextures(a: BaseTexture, rangeA: number, b?: BaseTexture | null, rangeB?: number) {
    this.texA = a; this.rangeA = rangeA; this.texB = b ?? a; this.rangeB = rangeB ?? rangeA; this.isEnabled = true;
  }

  isReadyForSubMesh(): boolean {
    if (!this._on) return true;
    return (!this.texA || this.texA.isReady()) && (!this.texB || this.texB.isReady());
  }

  // UV2 must be requested before Babylon decides which vertex attributes to bind.
  prepareDefinesBeforeAttributes(defines: BakedLMDefines, _scene: Scene, _mesh: AbstractMesh) {
    defines.BAKEDLM = this._on;
    if (this._on) {
      (defines as unknown as Record<string, boolean>)._needUVs = true;
      (defines as unknown as Record<string, boolean>).MAINUV2 = true;
    }
  }

  getClassName() { return 'BakedLightmapPlugin'; }
  getSamplers(samplers: string[]) { samplers.push('bakedLmA', 'bakedLmB'); }
  getUniforms() {
    return { ubo: [{ name: 'bakedLmInfo', size: 4, type: 'vec4' }, { name: 'bakedLmIbl', size: 2, type: 'vec2' }],
      fragment: '#ifdef BAKEDLM\nuniform vec4 bakedLmInfo;\nuniform vec2 bakedLmIbl;\n#endif\n' };
  }

  bindForSubMesh(ubo: UniformBuffer) {
    if (!this._on) return;
    ubo.updateFloat4('bakedLmInfo', this.rangeA, this.gain, this.mix, this.rangeB);
    ubo.updateFloat2('bakedLmIbl', this.ibl, this.iblGain);
    if (this.texA) ubo.setTexture('bakedLmA', this.texA);
    if (this.texB) ubo.setTexture('bakedLmB', this.texB);
  }

  getCustomCode(shaderType: string) {
    if (shaderType !== 'fragment') return null;
    return {
      CUSTOM_FRAGMENT_DEFINITIONS: '#ifdef BAKEDLM\nuniform sampler2D bakedLmA;\nuniform sampler2D bakedLmB;\n#endif\n',
      ['!' + IRRADIANCE_LINE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')]: `
#if defined(BAKEDLM) && defined(MAINUV2)
vec3 bkLmA=exp2((texture2D(bakedLmA,vMainUV2).rgb-1.0)*${LM_STOPS.toFixed(1)})*bakedLmInfo.x;
vec3 bkLmB=exp2((texture2D(bakedLmB,vMainUV2).rgb-1.0)*${LM_STOPS.toFixed(1)})*bakedLmInfo.w;
vec3 finalIrradiance=mix(mix(bkLmA,bkLmB,bakedLmInfo.z)*bakedLmInfo.y,reflectionOut.environmentIrradiance*bakedLmIbl.y,bakedLmIbl.x);
#else
${IRRADIANCE_LINE}
#endif
`,
    };
  }
}

RegisterClass('BABYLON.BakedLightmapPlugin', BakedLightmapPlugin);

class ProbeDiffuseDefines extends MaterialDefines { PROBEDIFF = false; }

/** Diffuse probe light for objects without a lightmap (hand, swatter, mosquito): the probe's irradiance scaled to the
 * level of the baked surfaces around it (World.diffuseGain). The probes are captured mid-room, near lamps and windows;
 * unscaled they lit these objects ~3x brighter than the baked walls beside them (D47). Specular reflections unchanged. */
export class ProbeDiffusePlugin extends MaterialPluginBase {
  gain = 1;

  constructor(material: Material) {
    super(material, 'ProbeDiffuse', 211, new ProbeDiffuseDefines(), true);
    this._enable(true);
  }

  prepareDefines(defines: ProbeDiffuseDefines) { defines.PROBEDIFF = true; }
  getClassName() { return 'ProbeDiffusePlugin'; }
  getUniforms() {
    return { ubo: [{ name: 'probeDiffuseGain', size: 1, type: 'float' }], fragment: '#ifdef PROBEDIFF\nuniform float probeDiffuseGain;\n#endif\n' };
  }
  bindForSubMesh(ubo: UniformBuffer) { ubo.updateFloat('probeDiffuseGain', this.gain); }

  getCustomCode(shaderType: string) {
    if (shaderType !== 'fragment') return null;
    return {
      ['!' + IRRADIANCE_LINE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')]: `
#ifdef PROBEDIFF
vec3 finalIrradiance=reflectionOut.environmentIrradiance*probeDiffuseGain;
#else
${IRRADIANCE_LINE}
#endif
`,
    };
  }
}

RegisterClass('BABYLON.ProbeDiffusePlugin', ProbeDiffusePlugin);
