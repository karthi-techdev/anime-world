import * as THREE from "three";
import { readIslandImage, type IslandLayer } from "./islandMaterials";
import type { TerrainDetail } from "./islandTerrain";
import { ENV } from "./worldShared";

export type PeakSurfaceName = "grass" | "soil" | "rock" | "bark" | "plaster" | "brick" | "roof";
export interface PeakSurface {
  color: THREE.DataTexture;
  normal: THREE.DataTexture;
  roughness: THREE.DataTexture;
  detail: THREE.DataTexture;
}
export interface PeakMaterials {
  surfaces: Record<PeakSurfaceName, PeakSurface>;
  terrain: TerrainDetail;
  dispose(): void;
}

export function applyPeakSurface(material: THREE.MeshStandardMaterial, surface: PeakSurface): void {
  material.map = surface.color;
  material.normalMap = surface.normal;
  material.roughnessMap = surface.roughness;
  material.normalScale.set(0.38, 0.38);
  material.roughness = 0.94;
  material.needsUpdate = true;
}
const NAMES: PeakSurfaceName[] = ["grass", "soil", "rock", "bark", "plaster", "brick", "roof"];

function texture(data: Uint8Array, width: number, height: number, color = false) {
  const result = new THREE.DataTexture(data, width, height, THREE.RGBAFormat);
  result.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  result.wrapS = result.wrapT = THREE.RepeatWrapping;
  result.minFilter = THREE.LinearMipmapLinearFilter; result.magFilter = THREE.LinearFilter;
  result.generateMipmaps = true; result.anisotropy = 8; result.needsUpdate = true;
  return result;
}

/** Authored normal maps stay linear; only albedo is brought into the island palette. */
export function makePeakSurface(name: PeakSurfaceName, color: ImageData, normal: ImageData, roughness: ImageData): PeakSurface {
  const { width, height } = color;
  if (normal.width !== width || normal.height !== height || roughness.width !== width || roughness.height !== height) {
    throw new Error(`Peak ${name} maps must have matching dimensions`);
  }
  const albedo = new Uint8Array(color.data), relief = new Uint8Array(normal.data);
  const matte = new Uint8Array(albedo.length), detail = new Uint8Array(albedo.length);
  for (let i = 0; i < albedo.length; i += 4) {
    const luminance = (albedo[i] * 0.2126 + albedo[i + 1] * 0.7152 + albedo[i + 2] * 0.0722) / 255;
    if (name === "grass") {
      const shade = THREE.MathUtils.clamp(0.55 + luminance * 0.65, 0.38, 1.05);
      albedo[i] = Math.round((albedo[i] * 0.2 + 105 * shade * 0.8));
      albedo[i + 1] = Math.round((albedo[i + 1] * 0.2 + 151 * shade * 0.8));
      albedo[i + 2] = Math.round((albedo[i + 2] * 0.2 + 66 * shade * 0.8));
    } else if (name === "plaster" || name === "roof" || name === "brick") {
      // House vertex colours own the paint; preserve grain without painting it twice.
      const tone = THREE.MathUtils.clamp(0.76 + luminance * 0.3, 0, 1) * 255;
      for (let c = 0; c < 3; c++) albedo[i + c] = Math.round(tone * 0.86 + albedo[i + c] * 0.14);
    }
    const rough = Math.max(155, roughness.data[i]);
    matte[i] = matte[i + 1] = matte[i + 2] = rough; matte[i + 3] = 255;
    detail[i] = relief[i]; detail[i + 1] = relief[i + 1]; detail[i + 2] = rough; detail[i + 3] = 255;
  }
  return { color: texture(albedo, width, height, true), normal: texture(relief, width, height),
    roughness: texture(matte, width, height), detail: texture(detail, width, height) };
}

/** A world owns this pack. A cancelled load cannot leave late-created GPU textures behind. */
export async function loadPeakMaterials(signal?: AbortSignal): Promise<PeakMaterials> {
  const surfaces = {} as Record<PeakSurfaceName, PeakSurface>;
  let disposed = false;
  const dispose = () => {
    if (disposed) return; disposed = true;
    for (const surface of Object.values(surfaces)) for (const map of Object.values(surface)) map.dispose();
  };
  const check = () => {
    if (signal?.aborted) throw new DOMException("Peak art loading cancelled", "AbortError");
  };
  try {
    check();
    // Sequential surfaces bound decoding memory; maps within each surface load together.
    for (const name of NAMES) {
      const images = await Promise.all(["albedo", "normal", "roughness"].map(map =>
        readIslandImage(`${ENV}/peak/surfaces/${name}/${map}.png`)));
      check(); surfaces[name] = makePeakSurface(name, images[0], images[1], images[2]);
    }
    const layer = (name: PeakSurfaceName): IslandLayer => ({ color: surfaces[name].color, detail: surfaces[name].detail });
    return { surfaces, terrain: { green: layer("grass"), soil: layer("soil"), rock: layer("rock") }, dispose };
  } catch (error) { dispose(); throw error; }
}
