import * as THREE from "three";
import { ENV } from "./worldShared";

export interface IslandLayer {
  color: THREE.DataTexture;
  /** R/G = tangent-space normal XY, B = roughness. All channels are linear. */
  detail: THREE.DataTexture;
}
export interface IslandMaterials {
  green: IslandLayer;
  sand: IslandLayer;
  rock: IslandLayer;
  dispose(): void;
}

/** Decode only local, reviewed images; never run any asset-generation scripts. */
export function readIslandImage(url: string): Promise<ImageData> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.decoding = "async";
    const extract = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = image.naturalWidth || image.width || 1;
        canvas.height = image.naturalHeight || image.height || 1;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) {
          reject(new Error("Island textures require a 2D canvas context"));
          return;
        }
        context.drawImage(image, 0, 0);
        resolve(context.getImageData(0, 0, canvas.width, canvas.height));
      } catch (err) {
        reject(err);
      }
    };
    image.onload = () => extract();
    image.onerror = (e) => reject(new Error(`Failed to load island texture: ${url}`));
    image.src = url;
    if (image.complete && image.naturalWidth > 0) {
      extract();
    } else if (typeof image.decode === "function") {
      image.decode().then(extract).catch(() => {});
    }
  });
}

function layer(image: ImageData, low: THREE.Color, high: THREE.Color, relief: number): IslandLayer {
  const { width, height, data } = image;
  const luminance = new Float32Array(width * height);
  // A small box filter removes photographic grain while retaining the uploaded motifs.
  for (let z = 0; z < height; z++) for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const i = (((z + dz + height) % height) * width + (x + dx + width) % width) * 4;
      sum += (data[i] * 0.2126 + data[i + 1] * 0.7152 + data[i + 2] * 0.0722) / 255;
    }
    luminance[z * width + x] = sum / 9;
  }
  let mean = 0;
  for (const value of luminance) mean += value / luminance.length;
  const colors = new Uint8Array(width * height * 4);
  const details = new Uint8Array(colors.length);
  const sample = (x: number, z: number) => luminance[((z + height) % height) * width + (x + width) % width];
  const color = new THREE.Color();
  for (let z = 0; z < height; z++) for (let x = 0; x < width; x++) {
    const index = z * width + x, i = index * 4;
    const tone = THREE.MathUtils.clamp(0.5 + (luminance[index] - mean) * 1.8, 0, 1);
    color.copy(low).lerp(high, tone).convertLinearToSRGB();
    colors[i] = Math.round(color.r * 255);
    colors[i + 1] = Math.round(color.g * 255);
    colors[i + 2] = Math.round(color.b * 255);
    colors[i + 3] = 255;
    const nx = (sample(x - 1, z) - sample(x + 1, z)) * relief;
    const nz = (sample(x, z - 1) - sample(x, z + 1)) * relief;
    const length = Math.hypot(nx, nz, 1);
    details[i] = Math.round((nx / length * 0.5 + 0.5) * 255);
    details[i + 1] = Math.round((nz / length * 0.5 + 0.5) * 255);
    details[i + 2] = Math.round((0.8 + 0.15 * (1 - tone)) * 255);
    details[i + 3] = 255;
  }
  const colorTexture = new THREE.DataTexture(colors, width, height);
  const detailTexture = new THREE.DataTexture(details, width, height);
  colorTexture.colorSpace = THREE.SRGBColorSpace;
  for (const texture of [colorTexture, detailTexture]) {
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.generateMipmaps = true;
    texture.anisotropy = 8;
    texture.needsUpdate = true;
  }
  return { color: colorTexture, detail: detailTexture };
}

/** Hand-painted palette remap + gentle derived relief, instead of photo-textured turf. */
export async function loadIslandMaterials(): Promise<IslandMaterials> {
  const [green, sand, rock] = await Promise.all(["green", "sand", "rock"].map(name =>
    readIslandImage(`${ENV}/island/land_${name}.png`)));
  const layers = {
    green: layer(green, new THREE.Color("#476e42"), new THREE.Color("#88a65d"), 2.5),
    sand: layer(sand, new THREE.Color("#b49d74"), new THREE.Color("#e2d3a7"), 2),
    rock: layer(rock, new THREE.Color("#777f78"), new THREE.Color("#bec3ad"), 4),
  };
  return { ...layers, dispose() {
    for (const value of Object.values(layers)) { value.color.dispose(); value.detail.dispose(); }
  } };
}
