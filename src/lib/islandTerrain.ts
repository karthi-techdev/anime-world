import type { LawnMask } from "./lawnMask";
import * as THREE from "three";
import { ENV, GLSL_NOISE, rng, sstep, uTime } from "./worldShared";
import { loadIslandMaterials, readIslandImage, type IslandLayer, type IslandMaterials } from "./islandMaterials";
import { sampleRoadPath } from "./worldTypes";
import type { IslandPlot, IslandRoad, WaterSample } from "./worldTypes";

export const SIZE = 5000;
export const HALF = SIZE / 2;
/** Source coast spans z=-912.9..1100.8m. 2.1 fits it, with ocean on every side. */
export const SOURCE_SCALE = 2.1;
export const SOURCE_SIZE = 3000;
export const SEA_LEVEL = 0;
export const uDay = { value: 1 };
const SOURCE_N = 512;
const N = 1025;
const STEP = SIZE / (N - 1);
const mix = THREE.MathUtils.lerp;
const clamp = THREE.MathUtils.clamp;
export const sourceToWorld = (x: number, z: number) => new THREE.Vector2(x * SOURCE_SCALE, z * SOURCE_SCALE);
export const worldToSource = (x: number, z: number) => new THREE.Vector2(x / SOURCE_SCALE, z / SOURCE_SCALE);

/** Compatibility town definitions. Layout/house placement remains world-builder-owned. */
export const TOWNS = [
  { x: 0, z: 0, r: 120 * SOURCE_SCALE, y: 5.5 },
  { x: -210 * SOURCE_SCALE, z: -100 * SOURCE_SCALE, r: 60 * SOURCE_SCALE, y: 5.5 },
  { x: 180 * SOURCE_SCALE, z: 65 * SOURCE_SCALE, r: 65 * SOURCE_SCALE, y: 5.5 },
  { x: 100 * SOURCE_SCALE, z: 470 * SOURCE_SCALE, r: 65 * SOURCE_SCALE, y: 5.5 },
];
export interface IslandLake { id: string; x: number; z: number; r: number; y: number }
export const LAKES: IslandLake[] = [
  { id: "west-highland-lake", x: -340 * SOURCE_SCALE, z: 240 * SOURCE_SCALE, r: 42 * SOURCE_SCALE, y: 28 },
  { id: "forest-lake", x: 240 * SOURCE_SCALE, z: -490 * SOURCE_SCALE, r: 36 * SOURCE_SCALE, y: 5 },
];
const riverCurve = new THREE.SplineCurve([
  [-340, 240], [-390, 300], [-450, 320], [-495, 275], [-550, 210],
  [-580, 130], [-585, 60], [-575, 5], [-565, -50],
].map(([x, z]) => sourceToWorld(x, z)));
/** Sampled centreline; Vector2.y is world Z, matching IslandRoad. */
export const RIVER_POINTS: THREE.Vector2[] = riverCurve.getPoints(56);
export const RIVER_LEVELS: number[] = RIVER_POINTS.map(() => 0);
export const RIVER_WIDTH = 20;
interface RiverSegment { a: THREE.Vector2; b: THREE.Vector2; aY: number; bY: number }
interface RoadSegment { a: THREE.Vector2; b: THREE.Vector2; aY: number; bY: number; width: number }
interface FlatPlot extends IslandPlot { level: number }
interface ClearSpot { x: number; z: number; radius?: number }
let sourceHeight: Float32Array | null = null;
let sourceSplat: ImageData | null = null;
let materials: IslandMaterials | null = null;
let sourceTexture: THREE.DataTexture | null = null;
let loading: Promise<void> | null = null;
let dataGeneration = 0;
let H: Float32Array | null = null;
let M: Float32Array | null = null;
let heightTexture: THREE.DataTexture | null = null;
let flatPlots: FlatPlot[] = [];
let roadSegments: RoadSegment[] = [];
let riverSegments: RiverSegment[] = [];

function bilinear(array: Float32Array, side: number, fx: number, fz: number): number {
  fx = clamp(fx, 0, side - 1); fz = clamp(fz, 0, side - 1);
  const ix = Math.min(Math.floor(fx), side - 2), iz = Math.min(Math.floor(fz), side - 2);
  const tx = fx - ix, tz = fz - iz, i = iz * side + ix;
  return mix(mix(array[i], array[i + 1], tx), mix(array[i + side], array[i + side + 1], tx), tz);
}
function sourceBase(x: number, z: number): number {
  if (!sourceHeight) return Math.hypot(x, z) < 60 * SOURCE_SCALE ? 5.5 : -10;
  const sx = x / SOURCE_SCALE, sz = z / SOURCE_SCALE;
  if (Math.abs(sx) > SOURCE_SIZE / 2 || Math.abs(sz) > SOURCE_SIZE / 2) return -10;
  return bilinear(sourceHeight, SOURCE_N, (sx / SOURCE_SIZE + 0.5) * (SOURCE_N - 1), (sz / SOURCE_SIZE + 0.5) * (SOURCE_N - 1));
}
function splatGreen(x: number, z: number): number {
  if (!sourceSplat) return 0;
  const { width, height, data } = sourceSplat;
  const fx = clamp((x / (SOURCE_SIZE * SOURCE_SCALE) + 0.5) * (width - 1), 0, width - 1);
  const fz = clamp((z / (SOURCE_SIZE * SOURCE_SCALE) + 0.5) * (height - 1), 0, height - 1);
  const ix = Math.min(Math.floor(fx), width - 2), iz = Math.min(Math.floor(fz), height - 2);
  const i = (iz * width + ix) * 4 + 1, tx = fx - ix, tz = fz - iz;
  return mix(mix(data[i], data[i + 4], tx), mix(data[i + width * 4], data[i + width * 4 + 4], tx), tz) / 255;
}
function closest(x: number, z: number, a: THREE.Vector2, b: THREE.Vector2) {
  const dx = b.x - a.x, dz = b.y - a.y;
  const t = clamp(((x - a.x) * dx + (z - a.y) * dz) / Math.max(dx * dx + dz * dz, 0.0001), 0, 1);
  return { t, distance: Math.hypot(x - a.x - dx * t, z - a.y - dz * t) };
}
function lakeDistance(lake: IslandLake, x: number, z: number): number {
  const dx = x - lake.x, dz = z - lake.z, angle = Math.atan2(dz, dx);
  return Math.hypot(dx, dz) / (lake.r * (1 + 0.08 * Math.sin(angle * 3) + 0.035 * Math.cos(angle * 5)));
}
function initializeWater(): void {
  for (const lake of LAKES) {
    let lowRim = Infinity;
    for (let i = 0; i < 24; i++) {
      const angle = i / 24 * Math.PI * 2;
      lowRim = Math.min(lowRim, sourceBase(lake.x + Math.cos(angle) * lake.r * 1.2, lake.z + Math.sin(angle) * lake.r * 1.2));
    }
    lake.y = Math.max(2.3, Math.min(sourceBase(lake.x, lake.z) - 1.2, lowRim - 0.7));
  }
  let level = LAKES[0].y;
  const last = RIVER_POINTS.length - 1;
  for (let i = 0; i <= last; i++) {
    const p = RIVER_POINTS[i], fraction = i / last;
    // Never climb uphill. The final reach merges exactly into the sea.
    const coastFade = 1 - sstep(0.67, 1, fraction);
    level = Math.max(0, Math.min(level, sourceBase(p.x, p.y) - 0.7));
    RIVER_LEVELS[i] = i < 5 ? LAKES[0].y : level * coastFade;
  }
  riverSegments = RIVER_POINTS.slice(0, -1).map((a, i) => ({ a, b: RIVER_POINTS[i + 1], aY: RIVER_LEVELS[i], bY: RIVER_LEVELS[i + 1] }));
}
function abortError(): DOMException { return new DOMException("Island initialization cancelled", "AbortError"); }
/** Shared data load, independently cancellable by each caller; failed loads may be retried. */
export async function loadIslandData(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw abortError();
  if (sourceHeight && sourceSplat && materials && sourceTexture) return;
  if (!loading) {
    const generation = dataGeneration;
    loading = (async () => {
    const [response, splat, layers] = await Promise.all([
      fetch(`${ENV}/island/island_rpg_elev_512.bin`),
      readIslandImage(`${ENV}/island/island_rpg_splatmap.png`),
      loadIslandMaterials(),
    ]);
    if (!response.ok) { layers.dispose(); throw new Error(`Island elevation HTTP ${response.status}`); }
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength !== SOURCE_N * SOURCE_N * 2) { layers.dispose(); throw new Error("Invalid island elevation grid size"); }
    if (generation !== dataGeneration) { layers.dispose(); throw abortError(); }
    const view = new DataView(buffer), heights = new Float32Array(SOURCE_N * SOURCE_N);
    for (let i = 0; i < heights.length; i++) heights[i] = view.getUint16(i * 2, true) / 100 - 10;
    sourceHeight = heights; sourceSplat = splat; materials = layers;
    // Row0=north in both CPU image and GPU data. Do not apply TextureLoader's implicit flip.
    sourceTexture = new THREE.DataTexture(splat.data, splat.width, splat.height);
    sourceTexture.minFilter = sourceTexture.magFilter = THREE.LinearFilter;
    sourceTexture.colorSpace = THREE.NoColorSpace;
    sourceTexture.needsUpdate = true;
    initializeWater();
    })().catch(error => { if (generation === dataGeneration) loading = null; throw error; });
  }
  if (!signal) return loading;
  const promise = loading;
  await new Promise<void>((resolve, reject) => {
    const cancelled = () => { cleanup(); reject(abortError()); };
    const cleanup = () => signal.removeEventListener("abort", cancelled);
    signal.addEventListener("abort", cancelled, { once: true });
    promise.then(() => { cleanup(); resolve(); }, error => { cleanup(); reject(error); });
  });
}

function naturalHeight(x: number, z: number): number {
  let h = sourceBase(x, z);
  for (const lake of LAKES) {
    const distance = lakeDistance(lake, x, z);
    if (distance < 1.55) {
      const bed = lake.y - 4.2 + 4.9 * sstep(0.38, 1.12, distance);
      h = mix(bed, Math.max(h, lake.y + 0.7), sstep(1.06, 1.55, distance));
    }
  }
  for (const segment of riverSegments) {
    if (x < Math.min(segment.a.x, segment.b.x) - RIVER_WIDTH * 2.3 || x > Math.max(segment.a.x, segment.b.x) + RIVER_WIDTH * 2.3 ||
        z < Math.min(segment.a.y, segment.b.y) - RIVER_WIDTH * 2.3 || z > Math.max(segment.a.y, segment.b.y) + RIVER_WIDTH * 2.3) continue;
    const { t, distance } = closest(x, z, segment.a, segment.b);
    const level = mix(segment.aY, segment.bY, t), bed = level - 2.5;
    h = Math.min(h, mix(bed, h, sstep(RIVER_WIDTH * 0.24, RIVER_WIDTH * 2.2, distance)));
  }
  return h;
}
function definedWaterLevel(x: number, z: number): number {
  let level = -Infinity;
  for (const lake of LAKES) if (lakeDistance(lake, x, z) < 1.3) level = Math.max(level, lake.y);
  for (const segment of riverSegments) {
    const margin = RIVER_WIDTH * 2.2;
    if (x < Math.min(segment.a.x, segment.b.x) - margin || x > Math.max(segment.a.x, segment.b.x) + margin ||
        z < Math.min(segment.a.y, segment.b.y) - margin || z > Math.max(segment.a.y, segment.b.y) + margin) continue;
    const { t, distance } = closest(x, z, segment.a, segment.b);
    if (distance < margin) level = Math.max(level, mix(segment.aY, segment.bY, t));
  }
  return level;
}
function layoutHeight(x: number, z: number): number {
  let h = naturalHeight(x, z);
  for (const segment of roadSegments) {
    const margin = segment.width * 0.5 + 12;
    if (x < Math.min(segment.a.x, segment.b.x) - margin || x > Math.max(segment.a.x, segment.b.x) + margin ||
        z < Math.min(segment.a.y, segment.b.y) - margin || z > Math.max(segment.a.y, segment.b.y) + margin) continue;
    const { t, distance } = closest(x, z, segment.a, segment.b);
    if (distance < margin && h >= Math.max(0, definedWaterLevel(x, z)))
      h = mix(mix(segment.aY, segment.bY, t), h, sstep(segment.width * 0.5, margin, distance));
  }
  for (const plot of flatPlots) {
    const distance = Math.hypot(x - plot.x, z - plot.z);
    if (distance < plot.radius + 12 && h >= Math.max(0, definedWaterLevel(x, z)))
      h = mix(plot.level, h, sstep(plot.radius, plot.radius + 12, distance));
  }
  return h;
}
/** Configure world-space plots and roads AFTER loadIslandData, BEFORE house-height queries. */
export function configureIslandLayout(plots: readonly IslandPlot[], roads: readonly IslandRoad[]): void {
  flatPlots = plots.filter(p => p.radius > 0).map(plot => ({ ...plot, level: naturalHeight(plot.x, plot.z) }));
  roadSegments = [];
  for (const road of roads) {
    const samples = sampleRoadPath(road.points, 0.5);
    for (let i = 0; i < samples.length - 1; i++) {
      const a = new THREE.Vector2(samples[i].x, samples[i].z);
      const b = new THREE.Vector2(samples[i + 1].x, samples[i + 1].z);
      // Water crossings stay carved: builder supplies bridge supports, not dirt dams.
      const aY = naturalHeight(a.x, a.y), bY = naturalHeight(b.x, b.y);
      roadSegments.push({ a, b, aY, bY, width: Math.max(1, road.width) });
    }
  }
  H = M = null;
}
export function getIslandHeight(x: number, z: number): number {
  if (!Number.isFinite(x) || !Number.isFinite(z) || Math.abs(x) > HALF || Math.abs(z) > HALF) return -10;
  return H ? bilinear(H, N, (x + HALF) / STEP, (z + HALF) / STEP) : layoutHeight(x, z);
}
function roadClearance(x: number, z: number): number {
  let result = 1;
  for (const segment of roadSegments) {
    const margin = segment.width * 0.5 + 4;
    if (x < Math.min(segment.a.x, segment.b.x) - margin || x > Math.max(segment.a.x, segment.b.x) + margin ||
        z < Math.min(segment.a.y, segment.b.y) - margin || z > Math.max(segment.a.y, segment.b.y) + margin) continue;
    result = Math.min(result, sstep(segment.width * 0.5 + 1.2, margin, closest(x, z, segment.a, segment.b).distance));
  }
  return result;
}
/** Static water surface levels match rendering; waves are cosmetic, not collision displacement. */
export function sampleIslandWater(x: number, z: number): WaterSample | null {
  const height = getIslandHeight(x, z);
  for (const lake of LAKES) if (lakeDistance(lake, x, z) < 1.3 && height < lake.y - 0.025)
    return { id: lake.id, level: lake.y, depth: lake.y - height };
  let nearest = Infinity, riverLevel = 0;
  for (const segment of riverSegments) {
    const { distance, t } = closest(x, z, segment.a, segment.b);
    if (distance < nearest) { nearest = distance; riverLevel = mix(segment.aY, segment.bY, t); }
  }
  if (nearest < RIVER_WIDTH * 2.2 && height < riverLevel - 0.025)
    return { id: "highland-river", level: riverLevel, depth: riverLevel - height };
  return height < SEA_LEVEL - 0.025 ? { id: "ocean", level: SEA_LEVEL, depth: SEA_LEVEL - height } : null;
}
export const sampleWater = sampleIslandWater;
export function grassMask(x: number, z: number): number {
  if (Math.abs(x) > HALF || Math.abs(z) > HALF) return 0;
  if (M) return bilinear(M, N, (x + HALF) / STEP, (z + HALF) / STEP);
  return sampleIslandWater(x, z) ? 0 : splatGreen(x, z) * roadClearance(x, z);
}
/** Bakes one authoritative world-space grid; keeps the GPU texture object stable on rebakes. */
export function bakeIsland(clear: readonly ClearSpot[] = [], roads?: readonly IslandRoad[], plots?: readonly IslandPlot[], lawnOk?: (x: number, z: number) => boolean): THREE.DataTexture {
  if (roads || plots) configureIslandLayout(plots ?? flatPlots, roads ?? []);
  H = new Float32Array(N * N); M = new Float32Array(N * N);
  const heights = H, masks = M;
  const region = (minX: number, maxX: number, minZ: number, maxZ: number, visit: (i: number, x: number, z: number) => void) => {
    const x0 = Math.max(0, Math.floor((minX + HALF) / STEP)), x1 = Math.min(N - 1, Math.ceil((maxX + HALF) / STEP));
    const z0 = Math.max(0, Math.floor((minZ + HALF) / STEP)), z1 = Math.min(N - 1, Math.ceil((maxZ + HALF) / STEP));
    for (let iz = z0; iz <= z1; iz++) for (let ix = x0; ix <= x1; ix++) visit(iz * N + ix, -HALF + ix * STEP, -HALF + iz * STEP);
  };
  for (let iz = 0; iz < N; iz++) for (let ix = 0; ix < N; ix++) heights[iz * N + ix] = sourceBase(-HALF + ix * STEP, -HALF + iz * STEP);
  // Feature rasterization is bounded, rather than testing every lake/road/house at every texel.
  const waterLevels = new Float32Array(N * N).fill(-Infinity);
  for (const lake of LAKES) {
    const margin = lake.r * 1.8;
    region(lake.x - margin, lake.x + margin, lake.z - margin, lake.z + margin, (i, x, z) => {
      const distance = lakeDistance(lake, x, z);
      if (distance >= 1.55) return;
      const bed = lake.y - 4.2 + 4.9 * sstep(0.38, 1.12, distance);
      heights[i] = mix(bed, Math.max(heights[i], lake.y + 0.7), sstep(1.06, 1.55, distance));
      if (distance < 1.3) waterLevels[i] = lake.y;
    });
  }
  for (const segment of riverSegments) {
    const margin = RIVER_WIDTH * 2.3;
    region(Math.min(segment.a.x, segment.b.x) - margin, Math.max(segment.a.x, segment.b.x) + margin,
      Math.min(segment.a.y, segment.b.y) - margin, Math.max(segment.a.y, segment.b.y) + margin, (i, x, z) => {
        const { t, distance } = closest(x, z, segment.a, segment.b);
        const level = mix(segment.aY, segment.bY, t);
        heights[i] = Math.min(heights[i], mix(level - 2.5, heights[i], sstep(RIVER_WIDTH * 0.24, RIVER_WIDTH * 2.2, distance)));
        if (distance < RIVER_WIDTH * 2.2) waterLevels[i] = Math.max(waterLevels[i], level);
      });
  }
  for (const segment of roadSegments) {
    const margin = segment.width * 0.5 + 12;
    region(Math.min(segment.a.x, segment.b.x) - margin, Math.max(segment.a.x, segment.b.x) + margin,
      Math.min(segment.a.y, segment.b.y) - margin, Math.max(segment.a.y, segment.b.y) + margin, (i, x, z) => {
        const { t, distance } = closest(x, z, segment.a, segment.b);
        if (distance < margin && heights[i] >= Math.max(0, waterLevels[i]))
          heights[i] = mix(mix(segment.aY, segment.bY, t), heights[i], sstep(segment.width * 0.5, margin, distance));
      });
  }
  for (const plot of flatPlots) {
    const margin = plot.radius + 12;
    region(plot.x - margin, plot.x + margin, plot.z - margin, plot.z + margin, (i, x, z) => {
      const distance = Math.hypot(x - plot.x, z - plot.z);
      if (distance < margin && heights[i] >= Math.max(0, waterLevels[i])) heights[i] = mix(plot.level, heights[i], sstep(plot.radius, margin, distance));
    });
  }
  for (let iz = 0; iz < N; iz++) for (let ix = 0; ix < N; ix++) {
    const i = iz * N + ix, x = -HALF + ix * STEP, z = -HALF + iz * STEP, height = heights[i];
    if (height < Math.max(0.8, waterLevels[i] + 0.25)) continue;
    const dx = (heights[iz * N + Math.min(ix + 1, N - 1)] - heights[iz * N + Math.max(ix - 1, 0)]) / (2 * STEP);
    const dz = (heights[Math.min(iz + 1, N - 1) * N + ix] - heights[Math.max(iz - 1, 0) * N + ix]) / (2 * STEP);
    if (Math.hypot(dx, dz) <= 0.65) masks[i] = splatGreen(x, z) * (1 - sstep(0.35, 0.65, Math.hypot(dx, dz)));
  }
  for (const segment of roadSegments) {
    const margin = segment.width * 0.5 + 4 + STEP;
    region(Math.min(segment.a.x, segment.b.x) - margin, Math.max(segment.a.x, segment.b.x) + margin,
      Math.min(segment.a.y, segment.b.y) - margin, Math.max(segment.a.y, segment.b.y) + margin, (i, x, z) => {
        masks[i] *= sstep(segment.width * 0.5 + 1.2 + STEP * 0.5, margin, closest(x, z, segment.a, segment.b).distance);
      });
  }
  const preClear = lawnOk ? Float32Array.from(masks) : null; // grass mask before house/town clearing
  for (const plot of flatPlots) {
    const margin = plot.radius + 5.5 + STEP;
    region(plot.x - margin, plot.x + margin, plot.z - margin, plot.z + margin, (i, x, z) => {
      masks[i] *= sstep(plot.radius + 1.5 + STEP * 0.5, margin, Math.hypot(x - plot.x, z - plot.z));
    });
  }
  for (const town of TOWNS) {
    const margin = town.r * 0.27;
    region(town.x - margin, town.x + margin, town.z - margin, town.z + margin, (i, x, z) => {
      masks[i] *= sstep(town.r * 0.23, margin, Math.hypot(x - town.x, z - town.z));
    });
  }
  // Rasterize actual clear footprints plus a half-cell margin, not just four point samples.
  for (const spot of clear) {
    const radius = Math.max(1, spot.radius ?? 9), pad = radius + STEP;
    const minX = Math.max(0, Math.floor((spot.x - pad + HALF) / STEP));
    const maxX = Math.min(N - 1, Math.ceil((spot.x + pad + HALF) / STEP));
    const minZ = Math.max(0, Math.floor((spot.z - pad + HALF) / STEP));
    const maxZ = Math.min(N - 1, Math.ceil((spot.z + pad + HALF) / STEP));
    for (let iz = minZ; iz <= maxZ; iz++) for (let ix = minX; ix <= maxX; ix++) {
      const distance = Math.hypot(-HALF + ix * STEP - spot.x, -HALF + iz * STEP - spot.z);
      M[iz * N + ix] *= sstep(radius, pad, distance);
    }
  }
  // Cleared residential ground that is still green turf keeps a short-lawn value; roads and house plots stay bare.
  if (preClear && lawnOk) for (let iz = 0; iz < N; iz++) for (let ix = 0; ix < N; ix++) {
    const i = iz * N + ix;
    const sx = (H[iz * N + Math.min(ix + 1, N - 1)] - H[iz * N + Math.max(ix - 1, 0)]) / (2 * STEP), sz = (H[Math.min(iz + 1, N - 1) * N + ix] - H[Math.max(iz - 1, 0) * N + ix]) / (2 * STEP);
    if (M[i] < 0.3 && H[i] > 3.2 && Math.hypot(sx, sz) < 0.4 && lawnOk(-HALF + ix * STEP, -HALF + iz * STEP)) M[i] = 0.42;
  }
  const data = new Float32Array(N * N * 2);
  for (let i = 0; i < H.length; i++) { data[i * 2] = H[i]; data[i * 2 + 1] = M[i]; }
  if (!heightTexture) {
    heightTexture = new THREE.DataTexture(data, N, N, THREE.RGFormat, THREE.FloatType);
    // WebGL2 float filtering is optional. Manual bilinear GLSL uses nearest texel fetches.
    heightTexture.minFilter = heightTexture.magFilter = THREE.NearestFilter;
  } else heightTexture.image.data = data;
  heightTexture.needsUpdate = true;
  return heightTexture;
}

/** Same pixel-centre mapping and bilinear interpolation as the CPU sampler. */
const HEIGHT_GLSL = /* glsl */ `
vec2 islandHM(vec2 p) {
  if(any(greaterThan(abs(p),vec2(${HALF}.)))) return vec2(-10.,0.);
  vec2 grid = clamp((p+${HALF}.)/${STEP},vec2(0.),vec2(${N - 1}.));
  vec2 cell = min(floor(grid),vec2(${N - 2}.)), f = grid-cell;
  vec2 uv = (cell+.5)/${N}.; const float e=1./${N}.;
  return mix(mix(texture2D(uH,uv).rg,texture2D(uH,uv+vec2(e,0.)).rg,f.x),
             mix(texture2D(uH,uv+vec2(0.,e)).rg,texture2D(uH,uv+vec2(e)).rg,f.x),f.y);
}`;

export interface TerrainDetail {
  green: IslandLayer;
  rock: IslandLayer;
  soil: IslandLayer;
}
function terrainMaterial(hTex: THREE.Texture, peak?: TerrainDetail): THREE.MeshStandardMaterial {
  if (!materials || !sourceTexture) throw new Error("Await loadIslandData before creating terrain");
  const { sand } = materials;
  const green = peak?.green ?? materials.green, rock = peak?.rock ?? materials.rock;
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.92, metalness: 0 });
  mat.name = peak ? "Island peak ground with authored relief" : "Island hand-painted splat layers";
  mat.customProgramCacheKey = () => peak ? "island-peak-layered-r187-v1" : "island-layered-r187-v4";
  mat.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, {
      uH: { value: hTex }, uSplat: { value: sourceTexture },
      tGreen: { value: green.color }, tSand: { value: sand.color }, tRock: { value: rock.color },
      dGreen: { value: green.detail }, dSand: { value: sand.detail }, dRock: { value: rock.detail },
      ...(peak ? { tSoil: { value: peak.soil.color }, dSoil: { value: peak.soil.detail } } : {}),
    });
    shader.vertexShader = shader.vertexShader.replace("#include <common>", "#include <common>\nvarying vec3 vIslandP; varying vec3 vIslandN;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvIslandP=(modelMatrix*vec4(position,1.)).xyz; vIslandN=normalize(mat3(modelMatrix)*normal);");
    shader.fragmentShader = shader.fragmentShader.replace("#include <common>", /* glsl */ `#include <common>
      varying vec3 vIslandP; varying vec3 vIslandN;
      uniform sampler2D uH,uSplat,tGreen,tSand,tRock,dGreen,dSand,dRock;
      ${GLSL_NOISE} ${HEIGHT_GLSL}
      vec3 layerColor(sampler2D tex,vec2 p,float scale){
        vec3 a=texture2D(tex,p*scale).rgb;
        vec3 b=texture2D(tex,mat2(.8,-.6,.6,.8)*p*scale*.37+vec2(.31,.73)).rgb;
        return mix(a,b,.32);
      }
      vec3 islandWeights(){
        vec2 sourceUv=clamp(vIslandP.xz/${SOURCE_SIZE * SOURCE_SCALE}.+.5,vec2(0.),vec2(1.));
        sourceUv=(sourceUv*vec2(${sourceSplat?.width ? sourceSplat.width - 1 : 1023}.,${sourceSplat?.height ? sourceSplat.height - 1 : 1023}.)+.5)/vec2(${sourceSplat?.width ?? 1024}.,${sourceSplat?.height ?? 1024}.);
        vec3 weights=texture2D(uSplat,sourceUv).rgb;
        float cliff=smoothstep(.12,.4,1.-normalize(vIslandN).y);
        weights.b=max(weights.b,cliff);
        float inland=smoothstep(2.,3.5,vIslandP.y); // above the beach: grass only
        weights.r*=1.-inland; weights.g=max(weights.g,inland*(1.-cliff));
        float shore=1.-smoothstep(.5,2.2,vIslandP.y);
        weights.r=max(weights.r,shore); weights.g*=1.-shore;
        // The green heightmap channel controls blade placement, not ground color:
        // clear house/tree footprints must keep turf rather than becoming sandy holes.
        return weights/max(dot(weights,vec3(1.)),.001);
      }
      vec3 islandDetail(){
        vec3 w=islandWeights(); vec2 p=vIslandP.xz;
        return texture2D(dSand,p*.1).rgb*w.r+texture2D(dGreen,p*.12).rgb*w.g+texture2D(dRock,p*.055).rgb*w.b;
      }`)
      .replace("#include <map_fragment>", /* glsl */ `
        vec3 weights=islandWeights();
        vec3 grass=layerColor(tGreen,vIslandP.xz,.12);
        grass*=mix(vec3(.92,1.,.91),vec3(1.04,1.03,.93),tnoise(vIslandP.xz*.013));
        vec3 sand=layerColor(tSand,vIslandP.xz,.1), rock=layerColor(tRock,vIslandP.xz,.055);
        // X/Z cliff projections avoid stretching ground textures up near-vertical faces.
        vec3 projection=abs(normalize(vIslandN)); projection/=max(dot(projection,vec3(1.)),.001);
        rock=rock*projection.y+layerColor(tRock,vIslandP.zy,.055)*projection.x+layerColor(tRock,vIslandP.xy,.055)*projection.z;
        // Reference look: lush saturated meadow, warm tan dirt on slopes and sandy ground, tan-brown rock.
        float steepSlope=1.-clamp(normalize(vIslandN).y,0.,1.);
        vec3 lush=vec3(.30,.62,.12)*(.78+.5*tfbm(vIslandP.xz*.018));
        vec3 tanDirt=vec3(.80,.64,.40)*(.86+.28*tnoise(vIslandP.xz*.06));
        grass=mix(grass,lush,.7);
        float vAvg=(islandHM(vIslandP.xz+vec2(22.,0.)).r+islandHM(vIslandP.xz-vec2(22.,0.)).r+islandHM(vIslandP.xz+vec2(0.,22.)).r+islandHM(vIslandP.xz-vec2(0.,22.)).r)*.25;
        float valley=smoothstep(2.5,9.,vAvg-vIslandP.y)*(1.-smoothstep(6.,16.,vIslandP.y)); // brown only in low valleys
        grass=mix(grass,tanDirt,valley*.85*(.6+.8*tnoise(vIslandP.xz*.03)));
        sand=mix(sand,tanDirt,.6);
        rock=mix(rock,vec3(.66,.54,.4),.5);
        diffuseColor.rgb*=sand*weights.r+grass*weights.g+rock*weights.b;
        diffuseColor.rgb*=mix(.68,1.,smoothstep(-1.,1.4,vIslandP.y));`)
      .replace("#include <roughnessmap_fragment>", "#include <roughnessmap_fragment>\nroughnessFactor=clamp(islandDetail().b,.72,.98);")
      .replace("#include <normal_fragment_maps>", /* glsl */ `#include <normal_fragment_maps>
        vec2 relief=(islandDetail().rg*2.-1.)*.36;
        vec3 detailWorld=vec3(-relief.x,0.,-relief.y);
        normal=normalize(normal+(viewMatrix*vec4(detailWorld,0.)).xyz);`);
    if (peak) {
      shader.fragmentShader = shader.fragmentShader
        .replace("uniform sampler2D uH,uSplat,tGreen,tSand,tRock,dGreen,dSand,dRock;", /* glsl */ `
          uniform sampler2D uH,uSplat,tGreen,tSand,tRock,dGreen,dSand,dRock,tSoil,dSoil;
          vec2 islandHM(vec2 p);
          float soilMix(){
            float mask=islandHM(vIslandP.xz).g;
            return (1.-smoothstep(.08,.78,mask))*smoothstep(2.,5.,vIslandP.y)*.06;
          }`)
        .replace("vec3 grass=layerColor(tGreen,vIslandP.xz,.12);", /* glsl */ `
          vec3 grass=layerColor(tGreen,vIslandP.xz,.65);
          grass=mix(grass,layerColor(tSoil,vIslandP.xz,.45),soilMix());`)
        .replace("texture2D(dGreen,p*.12).rgb", "mix(texture2D(dGreen,p*.65).rgb,texture2D(dSoil,p*.45).rgb,soilMix())")
        .replaceAll(".055", ".22")
        .replace("vec2 relief=(islandDetail().rg*2.-1.)*.36;", "vec2 relief=(islandDetail().rg*2.-1.)*.52;");
    }
  };
  return mat;
}

const CHUNKS = 16;
const CHUNK_SIZE = SIZE / CHUNKS;
const CELLS = (N - 1) / CHUNKS;
/** Every LOD retains full-resolution boundary vertices, zipper-joined to a coarser interior. */
function chunkGeometry(cx: number, cz: number, stride: number): THREE.BufferGeometry {
  const positions: number[] = [], normals: number[] = [], indices: number[] = [];
  const vertices = new Map<string, number>();
  const x0 = -HALF + cx * CHUNK_SIZE, z0 = -HALF + cz * CHUNK_SIZE;
  const vertex = (ix: number, iz: number) => {
    const key = `${ix},${iz}`, existing = vertices.get(key);
    if (existing !== undefined) return existing;
    const x = x0 + ix * STEP, z = z0 + iz * STEP, index = positions.length / 3;
    const nx = getIslandHeight(x - STEP, z) - getIslandHeight(x + STEP, z);
    const nz = getIslandHeight(x, z - STEP) - getIslandHeight(x, z + STEP);
    const length = Math.hypot(nx, STEP * 2, nz);
    positions.push(x, getIslandHeight(x, z), z);
    normals.push(nx / length, STEP * 2 / length, nz / length);
    vertices.set(key, index); return index;
  };
  const triangle = (a: number, b: number, c: number) => {
    const ax = positions[a * 3], az = positions[a * 3 + 2];
    const cross = (positions[b * 3 + 2] - az) * (positions[c * 3] - ax) - (positions[b * 3] - ax) * (positions[c * 3 + 2] - az);
    if (cross >= 0) indices.push(a, b, c); else indices.push(a, c, b);
  };
  for (let iz = stride; iz < CELLS - stride; iz += stride) for (let ix = stride; ix < CELLS - stride; ix += stride) {
    const a = vertex(ix, iz), b = vertex(ix + stride, iz), c = vertex(ix, iz + stride), d = vertex(ix + stride, iz + stride);
    triangle(a, c, b); triangle(b, c, d);
  }
  for (let side = 0; side < 4; side++) {
    const coord = (value: number, inner: boolean): [number, number] => {
      const edge = inner ? stride : 0;
      if (side === 0) return [value, edge];
      if (side === 1) return [CELLS - edge, value];
      if (side === 2) return [CELLS - value, CELLS - edge];
      return [edge, CELLS - value];
    };
    const outer = Array.from({ length: CELLS + 1 }, (_, i) => vertex(...coord(i, false)));
    const inner = Array.from({ length: CELLS / stride - 1 }, (_, i) => vertex(...coord((i + 1) * stride, true)));
    let oi = 0, ii = 0;
    while (oi < outer.length - 1 || ii < inner.length - 1) {
      if (ii === inner.length - 1 || (oi < outer.length - 1 && (oi + 1) / CELLS <= (ii + 2) * stride / CELLS)) {
        triangle(outer[oi], outer[oi + 1], inner[ii]); oi++;
      } else { triangle(outer[oi], inner[ii + 1], inner[ii]); ii++; }
    }
    // Skirts also hide floating-point pinholes and the outermost ocean-floor rim.
    const skirt = outer.map(top => {
      const index = positions.length / 3;
      positions.push(positions[top * 3], positions[top * 3 + 1] - 14, positions[top * 3 + 2]);
      normals.push(0, 1, 0); return index;
    });
    for (let i = 0; i < CELLS; i++) indices.push(outer[i], skirt[i], outer[i + 1], outer[i + 1], skirt[i], skirt[i + 1]);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geometry.setIndex(indices); geometry.computeBoundingSphere();
  return geometry;
}
export interface IslandTerrain extends THREE.Group {
  update(camera: THREE.Camera | THREE.Vector3): void;
  dispose(): void;
}
/** Call update(camera) each frame. Geometry is allocated lazily as chunks approach the camera. */
export function createIslandTerrain(hTex: THREE.Texture, peak?: TerrainDetail): IslandTerrain {
  if (!H) bakeIsland([]);
  const group = new THREE.Group() as IslandTerrain;
  group.name = "Island joined terrain LOD";
  const material = terrainMaterial(hTex, peak);
  const chunks: { mesh: THREE.Mesh; levels: Map<number, THREE.BufferGeometry>; cx: number; cz: number; stride: number }[] = [];
  for (let cz = 0; cz < CHUNKS; cz++) for (let cx = 0; cx < CHUNKS; cx++) {
    const geometry = chunkGeometry(cx, cz, 4), mesh = new THREE.Mesh(geometry, material);
    mesh.name = `Terrain ${cx},${cz}`; mesh.receiveShadow = true;
    group.add(mesh); chunks.push({ mesh, levels: new Map([[4, geometry]]), cx, cz, stride: 4 });
  }
  const lastCameraPos = new THREE.Vector3(-1e9, -1e9, -1e9);
  group.update = camera => {
    const position = camera instanceof THREE.Vector3 ? camera : camera.position;
    if (position.distanceToSquared(lastCameraPos) < 16) return;
    lastCameraPos.copy(position);
    for (const chunk of chunks) {
      const x = -HALF + (chunk.cx + 0.5) * CHUNK_SIZE, z = -HALF + (chunk.cz + 0.5) * CHUNK_SIZE;
      const distance = Math.hypot(position.x - x, position.y - getIslandHeight(x, z), position.z - z);
      const near = chunk.stride === 1 ? 610 : 520, far = chunk.stride <= 2 ? 1230 : 1120;
      const stride = distance < near ? 1 : distance < far ? 2 : 4;
      if (chunk.stride === stride) continue;
      let geometry = chunk.levels.get(stride);
      if (!geometry) { geometry = chunkGeometry(chunk.cx, chunk.cz, stride); chunk.levels.set(stride, geometry); }
      chunk.mesh.geometry = geometry; chunk.stride = stride;
    }
  };
  let disposed = false;
  group.dispose = () => {
    if (disposed) return; disposed = true;
    for (const chunk of chunks) for (const geometry of chunk.levels.values()) geometry.dispose();
    material.dispose(); group.removeFromParent();
  };
  group.update(new THREE.Vector3());
  return group;
}

const WAVES = /* glsl */ `
void wave(vec2 direction,float k,float speed,float amplitude,vec2 p,inout float h,inout vec2 g){
  float phase=dot(direction,p)*k+uTime*speed; h+=amplitude*sin(phase); g+=direction*k*amplitude*cos(phase);
}
void swell(vec2 p,inout float h,inout vec2 g){
  wave(vec2(.8,.6),.05,.9,.22,p,h,g); wave(vec2(-.5,.86),.035,.7,.27,p,h,g); wave(vec2(.3,-.95),.09,1.3,.1,p,h,g);
}
void chop(vec2 p,inout float h,inout vec2 g){
  wave(vec2(.6,.8),.5,2.2,.026,p,h,g); wave(vec2(-.9,.4),.8,2.9,.016,p,h,g); wave(vec2(.2,-.98),1.6,3.6,.008,p,h,g);
}`;
/** Geometry is horizontal at Y=0, or carries local varying Y for a sloping river. */
export function createWater(geo: THREE.BufferGeometry, level: number, amp: number, hTex: THREE.Texture, sunDir: THREE.Vector3, peak = false): THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial> {
  const material = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: true,
    uniforms: {
      ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog), uTime, uDay,
      uAmp: { value: amp }, uH: { value: hTex }, uSun: { value: sunDir }, uRiver: { value: geo.hasAttribute("aFlow") ? 1 : 0 },
    },
    vertexShader: /* glsl */ `
      uniform float uTime,uAmp,uRiver; uniform sampler2D uH;
      varying vec3 vP; varying float vLevel; varying vec2 vFlow;
      ${geo.hasAttribute("aFlow") ? "attribute vec2 aFlow;" : ""}
      #include <fog_pars_vertex>
      ${HEIGHT_GLSL} ${WAVES}
      void main(){
        vec4 world=modelMatrix*vec4(position,1.); vLevel=world.y;
        float depth=max(world.y-islandHM(world.xz).r,0.);
        float h=0.;vec2 g=vec2(0.);swell(world.xz,h,g);
        world.y+=h*uAmp*smoothstep(.15,2.,depth); vP=world.xyz;
        vFlow=${geo.hasAttribute("aFlow") ? "aFlow" : "vec2(.8,.6)"};
        vec4 mvPosition=viewMatrix*world;gl_Position=projectionMatrix*mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime,uAmp,uDay,uRiver;uniform sampler2D uH;uniform vec3 uSun;
      varying vec3 vP;varying float vLevel;varying vec2 vFlow;
      #include <fog_pars_fragment>
      ${GLSL_NOISE} ${HEIGHT_GLSL} ${WAVES}
      void main(){
        float depth=vLevel-islandHM(vP.xz).r;
        if(depth<=.025)discard;
        float h=0.;vec2 gradient=vec2(0.),fine=vec2(0.);
        vec2 flowing=vP.xz-vFlow*uTime*mix(.2,1.7,uRiver);
        swell(vP.xz,h,gradient);chop(flowing,h,fine);
        gradient=gradient*uAmp+fine;
        vec3 normal=normalize(vec3(-gradient.x,1.,-gradient.y));
        vec3 view=normalize(cameraPosition-vP), reflected=reflect(-view,normal);
        float fresnel=pow(1.-clamp(dot(normal,view),0.,1.),4.);
        vec3 color=mix(vec3(.15,.66,.61),vec3(.025,.25,.39),smoothstep(.2,12.,depth));
        vec3 sky=mix(vec3(.67,.84,.89),vec3(.24,.56,.76),clamp(reflected.y,0.,1.));
        color=mix(color,sky,.07+.58*fresnel);
        color+=vec3(1.,.94,.74)*pow(max(dot(reflected,normalize(uSun)),0.),180.)*.9*uDay;
        // All smoothstep bounds are increasing (reversed bounds are undefined GLSL).
        float foam=(1.-smoothstep(.25,1.6,depth))*(.45+.55*tnoise(flowing*.32));
        float line=1.-smoothstep(.025,.18,abs(fract(depth*.33-uTime*.12)-.5));
        foam=max(foam,line*(1.-smoothstep(.2,3.,depth))*.38);
        float streak=pow(tnoise(vec2(dot(flowing,vFlow)*.07,dot(flowing,vec2(-vFlow.y,vFlow.x))*.42)),6.);
        color=mix(color,vec3(.88,.97,.86),clamp(foam*.86+streak*uRiver*.25,0.,1.));
        gl_FragColor=vec4(color*mix(.09,1.,uDay),smoothstep(.025,.3,depth)*mix(.64,.95,smoothstep(.2,5.,depth)));
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
  });
  if (peak) {
    Object.assign(material.uniforms, {
      uReflection: { value: hTex }, uReflectMatrix: { value: new THREE.Matrix4() }, uReflect: { value: 0 },
    });
    material.fragmentShader = material.fragmentShader
      .replace("varying vec3 vP;varying float vLevel;varying vec2 vFlow;", /* glsl */ `
        varying vec3 vP;varying float vLevel;varying vec2 vFlow;
        uniform sampler2D uReflection;uniform mat4 uReflectMatrix;uniform float uReflect;`)
      .replace("color=mix(color,sky,.07+.58*fresnel);", /* glsl */ `
        vec4 uv=uReflectMatrix*vec4(vP.x,vLevel,vP.z,1.);
        vec2 mirrorUv=uv.xy/max(uv.w,.001)+normal.xz*.009;
        bool inMirror=uv.w>0.&&all(greaterThan(mirrorUv,vec2(0.)))&&all(lessThan(mirrorUv,vec2(1.)));
        vec3 reflection=inMirror&&uReflect>.5?texture2D(uReflection,mirrorUv).rgb:sky;
        color=mix(color,reflection,.12+.67*fresnel);`)
      .replace("gradient=gradient*uAmp+fine;", "gradient=gradient*uAmp+fine;gradient+=vec2(tnoise(flowing*2.4)-.5,tnoise(flowing.yx*2.1+7.)-.5)*.035;");
  }
  const mesh = new THREE.Mesh(geo, material); mesh.position.y = level; mesh.renderOrder = 2;
  return mesh;
}
function lakeGeometry(lake: IslandLake): THREE.BufferGeometry {
  const geometry = new THREE.CircleGeometry(lake.r * 1.4, 96, 0, Math.PI * 2).rotateX(-Math.PI / 2);
  geometry.translate(lake.x, 0, lake.z); return geometry;
}
function riverGeometry(): THREE.BufferGeometry {
  const positions: number[] = [], flow: number[] = [], indices: number[] = [];
  for (let i = 0; i < RIVER_POINTS.length; i++) {
    const point = RIVER_POINTS[i];
    const previous = RIVER_POINTS[Math.max(0, i - 1)], next = RIVER_POINTS[Math.min(RIVER_POINTS.length - 1, i + 1)];
    const tangent = next.clone().sub(previous).normalize(), normal = new THREE.Vector2(-tangent.y, tangent.x);
    for (const side of [-1, 1]) {
      positions.push(point.x + normal.x * RIVER_WIDTH * 2.3 * side, RIVER_LEVELS[i], point.y + normal.y * RIVER_WIDTH * 2.3 * side);
      flow.push(tangent.x, tangent.y);
    }
    if (i < RIVER_POINTS.length - 1) { const j = i * 2; indices.push(j, j + 1, j + 2, j + 1, j + 3, j + 2); }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("aFlow", new THREE.Float32BufferAttribute(flow, 2));
  geometry.setIndex(indices); geometry.computeBoundingSphere(); return geometry;
}
export interface IslandWaters extends THREE.Group { dispose(): void }
/** Matching ocean, irregular lakes and flowing river, all clipped by the shared bed texture. */
export function createIslandWaters(hTex: THREE.Texture, sunDir: THREE.Vector3, peak = false): IslandWaters {
  const group = new THREE.Group() as IslandWaters; group.name = "Island waters";
  const ocean = createWater(new THREE.PlaneGeometry(SIZE * 3.2, SIZE * 3.2, 192, 192).rotateX(-Math.PI / 2), SEA_LEVEL, 1, hTex, sunDir, peak);
  ocean.name = "Ocean"; group.add(ocean);
  for (const lake of LAKES) {
    const mesh = createWater(lakeGeometry(lake), lake.y, 0.045, hTex, sunDir, peak);
    mesh.name = lake.id; mesh.renderOrder = 3; group.add(mesh);
  }
  const river = createWater(riverGeometry(), 0, 0.015, hTex, sunDir, peak); river.name = "highland-river"; river.renderOrder = 3; group.add(river);
  let disposed = false;
  group.dispose = () => {
    if (disposed) return; disposed = true;
    for (const child of group.children) if (child instanceof THREE.Mesh) {
      child.geometry.dispose(); if (child.material instanceof THREE.Material) child.material.dispose();
    }
    group.removeFromParent();
  };
  return group;
}

/** Camera-following instanced ribbon blades. Near=5segments, far=2; no transparent-card overdraw. */
export function createIslandGrass(count: number, hTex: THREE.Texture, peak = false, lawn?: LawnMask) {
  const lawnTex = lawn?.texture ?? (() => { const t = new THREE.DataTexture(new Uint8Array([255]), 1, 1, THREE.RedFormat, THREE.UnsignedByteType); t.needsUpdate = true; return t; })();
  const lawnWin = lawn?.win ?? new THREE.Vector3(1e9, 1e9, 300);
  const centre = new THREE.Vector3();
  const group = new THREE.Group(); group.name = "Island near/far curved grass";
  const geometries: THREE.InstancedBufferGeometry[] = [], mats: THREE.Material[] = [];
  const make = (instances: number, segments: number, radius: number, innerRadius: number, seed: number) => {
    const geometry = new THREE.InstancedBufferGeometry(), positions: number[] = [], indices: number[] = [];
    for (let i = 0; i <= segments; i++) { const t = i / segments; positions.push(-1, t, 0, 1, t, 0); }
    for (let i = 0; i < segments; i++) { const j = i * 2; indices.push(j, j + 1, j + 2, j + 1, j + 3, j + 2); }
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute("normal", new THREE.Float32BufferAttribute(positions.map((_, i) => i % 3 === 2 ? 1 : 0), 3));
    geometry.setIndex(indices);
    const random = rng(seed), offsets = new Float32Array(instances * 4);
    for (let i = 0; i < offsets.length; i++) offsets[i] = random();
    geometry.setAttribute("aBlade", new THREE.InstancedBufferAttribute(offsets, 4)); geometry.instanceCount = instances;
    const uniforms = { uH: { value: hTex }, uC: { value: centre }, uTime, uDay, uLawn: { value: lawnTex }, uWin: { value: lawnWin } };
    let declarations = /* glsl */ `
      attribute vec4 aBlade;uniform sampler2D uH;uniform vec3 uC;uniform float uTime;uniform sampler2D uLawn;uniform vec3 uWin;
      varying float vBladeT,vBladeShade,vBladeAlive;
      ${GLSL_NOISE} ${HEIGHT_GLSL}
      float lawnFine(vec2 p){vec2 q=(p-uWin.xy)/uWin.z+.5;if(q.x<.0||q.y<.0||q.x>1.||q.y>1.)return 1.;return texture2D(uLawn,q).r;}
      float greenGround(vec2 p,float h){
        float inland=smoothstep(2.,3.5,h);
        float avg=(islandHM(p+vec2(22.,0.)).r+islandHM(p-vec2(22.,0.)).r+islandHM(p+vec2(0.,22.)).r+islandHM(p-vec2(0.,22.)).r)*.25;
        float valley=smoothstep(2.5,9.,avg-h)*(1.-smoothstep(6.,16.,h));
        float sl=length(vec2(islandHM(p+vec2(1.5,0.)).r-islandHM(p-vec2(1.5,0.)).r,islandHM(p+vec2(0.,1.5)).r-islandHM(p-vec2(0.,1.5)).r))/3.;
        return inland*(1.-smoothstep(.15,.5,valley))*(1.-smoothstep(.45,.9,sl));
      }
      void blade(out vec3 p,out vec3 n){
        const float radius=${radius}.;
        vec2 tile=mod(aBlade.xy*radius*2.-uC.xz,radius*2.)-radius+uC.xz;
        float distance=length(tile-uC.xz);vec2 hm=islandHM(tile);
        float gg=greenGround(tile,hm.r);float full=smoothstep(.66,.94,hm.g);float density=gg*lawnFine(tile);
        float fade=(1.-smoothstep(radius*.79,radius,distance))*${innerRadius ? `smoothstep(${innerRadius - 8}.,${innerRadius + 12}.,distance)` : "1."};
        float alive=step(aBlade.w*.3,density)*step(.05,density)*step(.015,fade)*step(.6,hm.r);
        float t=position.y,hr=fract(aBlade.x*127.1+aBlade.y*311.7+aBlade.w*74.7),height=(.35+1.6*hr)*(.8+.4*tnoise(tile*.07))*mix(.62,1.,density)*mix(.55,1.,full)*fade*alive;
        float angle=aBlade.z*6.283185;vec2 side=vec2(cos(angle),sin(angle));
        float wind=sin(uTime*1.4+dot(tile,vec2(.035,.028)))+.38*sin(uTime*2.7+tile.x*.12);
        vec2 bend=vec2(.18,.12)*wind+vec2(-side.y,side.x)*(.12+aBlade.w*.12);
        float width=${(radius > 100 ? 3.5 : radius > 40 ? 1.9 : 1).toFixed(2)}*(.0045+aBlade.w*.006)*(1.-pow(t,1.6))*alive;
        p=vec3(tile.x,hm.r-.025+t*height,tile.y);
        p.xz+=side*position.x*width+bend*t*t*height;
        vec3 tangent=normalize(vec3(bend.x*2.*t,1.,bend.y*2.*t));
        vec3 ribbon=normalize(cross(vec3(side.x,0.,side.y),tangent));
        n=normalize(vec3(ribbon.x*.45,.78,ribbon.z*.45));
        vBladeT=t;vBladeShade=tnoise(tile*.045);vBladeAlive=alive;
      }`;
    if (peak) declarations = declarations
      .replace("(.35+1.6*hr)", "(.3+1.45*hr)")
      .replace("sin(uTime*1.4+dot(tile,vec2(.035,.028)))+.38*sin(uTime*2.7+tile.x*.12)", "sin(uTime*1.1+dot(tile,vec2(.045,.032)))*(.45+.55*tnoise(tile*.016-uTime*.025))+.22*sin(uTime*2.7+tile.x*.12)")
      .replace("(.0045+aBlade.w*.006)", "(.004+aBlade.w*.0055)");
    const bendShader = (shader: THREE.WebGLProgramParametersWithUniforms, withNormals: boolean) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader.replace("#include <common>", `#include <common>\n${declarations}`)
        .replace("#include <begin_vertex>", "vec3 transformed=grassP;");
      if (withNormals) shader.vertexShader = shader.vertexShader.replace("#include <beginnormal_vertex>", "vec3 grassP,grassN;blade(grassP,grassN);vec3 objectNormal=grassN;");
      else shader.vertexShader = shader.vertexShader.replace("void main() {", "void main() {\nvec3 grassP,grassN;blade(grassP,grassN);");
    };
    const material = new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, roughness: 0.95, metalness: 0 });
    material.name = `Curved grass ${segments}segments`;
    material.customProgramCacheKey = () => `island-grass-r188-${radius}-${segments}-${peak ? "peak" : "base"}`;
    material.onBeforeCompile = shader => {
      bendShader(shader, true);
      shader.fragmentShader = shader.fragmentShader.replace("#include <common>", "#include <common>\nvarying float vBladeT,vBladeShade,vBladeAlive;uniform float uDay;")
        .replace("#include <map_fragment>", /* glsl */ `
          if(vBladeAlive<.5)discard;
          vec3 tip=mix(vec3(.30,.68,.10),vec3(.58,.88,.20),vBladeShade);
          diffuseColor.rgb*=mix(vec3(.07,.30,.04),tip,smoothstep(0.,1.,vBladeT));`)
        .replace("#include <normal_fragment_begin>", "float faceDirection=gl_FrontFacing?1.:-1.;vec3 normal=normalize(vNormal);vec3 nonPerturbedNormal=normal;");
      if (peak) shader.fragmentShader = shader.fragmentShader
        .replace("vec3(.30,.47,.09),vec3(.48,.59,.16)", "vec3(.22,.46,.065),vec3(.49,.68,.17)")
        .replace("vec3(.12,.24,.045)", "vec3(.065,.22,.035)")
        .replace("#include <emissivemap_fragment>", "#include <emissivemap_fragment>\ntotalEmissiveRadiance+=diffuseColor.rgb*.065*uDay*pow(vBladeT,2.);");
    };
    const mesh = new THREE.Mesh(geometry, material); mesh.frustumCulled = false; mesh.receiveShadow = true;
    // Identical deformation in the shadow pass: shadows move with the curved blades.
    const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, side: THREE.DoubleSide });
    depth.customProgramCacheKey = () => `island-grass-depth-${radius}-${segments}-${peak ? "peak" : "base"}`;
    depth.onBeforeCompile = shader => { bendShader(shader, false); };
    mesh.customDepthMaterial = depth; mesh.castShadow = !low && count > 50000 && innerRadius === 0;
    geometries.push(geometry); mats.push(material, depth); group.add(mesh);
  };
  const factor = count <= 50000 ? 1.5 : 2.6;
  const total = Math.max(0, Math.floor(count * factor)); // dense, thin, tall blades
  const low = count <= 50000;
  make(Math.ceil(total * 0.3), low ? 3 : 4, 26, 0, 741);
  make(Math.floor(total * 0.36), low ? 2 : 3, 64, 20, 577);
  make(Math.floor(total * 0.56), low ? 2 : 3, 150, 56, 913);
  let disposed = false;
  return { mesh: group, group, centre, dispose() {
    if (disposed) return; disposed = true;
    for (const geometry of geometries) geometry.dispose(); for (const mat of mats) mat.dispose(); group.removeFromParent();
  } };
}

/** Release shared data only after all worlds using it have disposed their meshes. */
export function disposeIslandData(): void {
  dataGeneration++;
  materials?.dispose(); sourceTexture?.dispose(); heightTexture?.dispose();
  materials = null; sourceTexture = heightTexture = null; sourceHeight = null; sourceSplat = null;
  H = M = null; loading = null; flatPlots = []; roadSegments = []; riverSegments = [];
}
