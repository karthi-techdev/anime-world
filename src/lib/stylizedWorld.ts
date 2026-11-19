import * as THREE from "three";
import { createSky } from "./worldGround";
import { STREET, GLSL_NOISE, rng, uTime } from "./worldShared";
import type { Part } from "./worldShared";
import {
  HALF, bakeIsland, createIslandGrass, createIslandTerrain, createIslandWaters,
  getIslandHeight, loadIslandData, sampleIslandWater, sourceToWorld, uDay,
} from "./islandTerrain";
import { createHouses } from "./islandHouses";
import { WorldSpatial } from "./worldSpatial";
import { createIslandLayout } from "./islandLayout";
import { LawnMask } from "./lawnMask";
import type { IslandField, IslandLayout, WorldRoad } from "./islandLayout";
import { buildIslandNature, createAssetLibrary } from "./islandFlora";
import { buildLegacyFlora, inLegacyZone } from "./legacyFlora";
import type { LegacyFlora } from "./legacyFlora";
import { loadPeakMaterials } from "./peakMaterials";
import { createPeakWater } from "./peakWater";
import type { AssetLibrary } from "./islandFlora";
import { sampleRoadPath } from "./worldTypes";
import type { RoadSample, WorldCollider, WorldContact, WorldLandmark, WorldSupport } from "./worldTypes";
import { getCelestialState } from "./celestial";

export type LightingMood = "cyber" | "tactical" | "studio";

export { getIslandHeight as getWorldHeight } from "./islandTerrain";
export type WorldQuality = "low" | "medium" | "high";
export interface StylizedWorld {
  spatial: WorldContact;
  bounds: { halfExtent: number };
  spawn: THREE.Vector3;
  landmarks: Record<string, WorldLandmark>;
  houses: ReturnType<typeof createHouses>["houses"];
  metrics?: { houses: number; trees: number; rocks: number; colliders: number; supports: number };
  nearestDoor(playerPosition: THREE.Vector3): { houseId: string; distance: number; open: boolean } | null;
  toggleNearestDoor(playerPosition: THREE.Vector3): boolean;
  setMood(mood: LightingMood): void;
  update(dt: number, camera: THREE.Camera, target: THREE.Vector3, playerPosition?: THREE.Vector3): void;
  dispose(): void;
}

const UP = new THREE.Vector3(0, 1, 0);
interface InstanceItem { matrix: THREE.Matrix4; colour?: THREE.Color }
interface WorldBatch { group: THREE.Group; centre: THREE.Vector3; distance: number; shadow: boolean }

/** Small independently culled instance batches, including street and farm details. */
function batchParts(
  root: THREE.Group, parts: Part[], transforms: InstanceItem[], batches: WorldBatch[], distance = 1500, cast = false,
) {
  const chunks = new Map<string, InstanceItem[]>(), position = new THREE.Vector3();
  for (const item of transforms) {
    position.setFromMatrixPosition(item.matrix);
    const key = `${Math.floor(position.x / 96)},${Math.floor(position.z / 96)}`;
    const list = chunks.get(key) ?? []; list.push(item); chunks.set(key, list);
  }
  for (const items of chunks.values()) {
    const group = new THREE.Group(), centre = new THREE.Vector3();
    for (const item of items) centre.add(position.setFromMatrixPosition(item.matrix));
    centre.multiplyScalar(1 / items.length);
    for (const p of parts) {
      const mesh = new THREE.InstancedMesh(p.geo, p.mat, items.length);
      items.forEach((item, i) => { mesh.setMatrixAt(i, item.matrix); if (item.colour) mesh.setColorAt(i, item.colour); });
      mesh.instanceMatrix.needsUpdate = true; mesh.computeBoundingSphere();
      mesh.frustumCulled = true; mesh.castShadow = cast; mesh.receiveShadow = true;
      group.add(mesh);
    }
    root.add(group); batches.push({ group, centre, distance, shadow: cast });
  }
}
function matrix(x: number, y: number, z: number, yaw = 0, sx = 1, sy = sx, sz = sx) {
  return new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromAxisAngle(UP, yaw), new THREE.Vector3(sx, sy, sz));
}
function roadSamples(road: WorldRoad, spacing: number): RoadSample[] {
  return sampleRoadPath(road.points, spacing);
}
function ribbon(samples: { x: number; z: number; dx: number; dz: number }[], halfWidth: number, lateral: number, lift: number) {
  const positions: number[] = [], uv: number[] = [], indices: number[] = [];
  let distance = 0;
  samples.forEach((p, i) => {
    if (i) distance += Math.hypot(p.x - samples[i - 1].x, p.z - samples[i - 1].z);
    for (const side of [-1, 1]) {
      const offset = lateral + side * halfWidth, x = p.x - p.dz * offset, z = p.z + p.dx * offset;
      const water = sampleIslandWater(x, z);
      positions.push(x, Math.max(getIslandHeight(x, z), water ? water.level + 1.4 : -Infinity) + lift, z);
      uv.push(side < 0 ? 0 : 1, distance / 3);
    }
    if (i) { const j = i * 2; indices.push(j - 2, j, j - 1, j - 1, j, j + 1); }
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2)); geometry.setIndex(indices); geometry.computeVertexNormals();
  return geometry;
}
function surfaceMaterial(colour: number, cobbles = false) {
  const material = new THREE.MeshStandardMaterial({ color: colour, roughness: 0.95, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1 });
  material.onBeforeCompile = shader => {
    shader.vertexShader = shader.vertexShader.replace("#include <common>", "#include <common>\nvarying vec3 vRoad;").replace("#include <begin_vertex>", "#include <begin_vertex>\nvRoad = position;");
    shader.fragmentShader = shader.fragmentShader.replace("#include <common>", `#include <common>\nvarying vec3 vRoad;\n${GLSL_NOISE}`).replace("#include <color_fragment>", `#include <color_fragment>
      vec2 p=vRoad.xz*${cobbles ? "2.5" : "1.0"};
      float grain=tnoise(p*8.); float mortar=${cobbles ? "smoothstep(.43,.49,max(abs(fract(p.x+floor(p.y)*.5)-.5),abs(fract(p.y)-.5)))" : "0."};
      diffuseColor.rgb *= (.84+.23*grain)*(1.-mortar*.2);`);
  };
  material.customProgramCacheKey = () => `island-road-${cobbles}`;
  return material;
}

function buildRoads(root: THREE.Group, layout: IslandLayout, batches: WorldBatch[], colliders: WorldCollider[], supports: WorldSupport[]) {
  const stone = surfaceMaterial(0xaaa79b, true), dirt = surfaceMaterial(0xb9a17c), gravel = surfaceMaterial(0x88847e);
  const curb = new THREE.MeshStandardMaterial({ color: 0xc4bba8, roughness: 1, side: THREE.DoubleSide });
  const markings: InstanceItem[] = [], cube = new THREE.BoxGeometry(1, 1, 1);
  for (const road of layout.roads) {
    const samples = roadSamples(road, 1.8);
    const mesh = new THREE.Mesh(ribbon(samples, road.width / 2, 0, 0.035), road.kind === "street" ? stone : road.kind === "trail" ? dirt : gravel);
    mesh.receiveShadow = true; root.add(mesh);
    if (road.kind === "street") for (const side of [-1, 1]) {
      const pavement = new THREE.Mesh(ribbon(samples, 0.7, side * (road.width / 2 + 0.7), 0.09), curb);
      pavement.receiveShadow = true; root.add(pavement);
    }
    // Bridge deck support agrees with the water-aware ribbon, not a disconnected visual plane.
    samples.slice(1).forEach((p, i) => {
      const a = samples[i], cx = (a.x + p.x) / 2, cz = (a.z + p.z) / 2;
      if (!sampleIslandWater(cx, cz)) return;
      const aWater = sampleIslandWater(a.x, a.z), bWater = sampleIslandWater(p.x, p.z);
      const y0 = Math.max(getIslandHeight(a.x, a.z), aWater ? aWater.level + 1.4 : -Infinity) + 0.035;
      const y1 = Math.max(getIslandHeight(p.x, p.z), bWater ? bWater.level + 1.4 : -Infinity) + 0.035;
      const depth = Math.hypot(p.x - a.x, p.z - a.z), yaw = Math.atan2(p.x - a.x, p.z - a.z);
      supports.push({ id: `bridge-${supports.length}`, center: new THREE.Vector3(cx, (y0 + y1) / 2, cz), width: road.width, depth: depth + 0.15, yaw, slopeZ: (y1 - y0) / depth });
    });
    if (road.kind === "street") for (const p of roadSamples(road, 12)) {
      const y = getIslandHeight(p.x, p.z) + 0.06;
      markings.push({ matrix: matrix(p.x, y, p.z, Math.atan2(p.dx, p.dz), 0.09, 0.012, 1.8) });
    }
  }
  batchParts(root, [{ geo: cube, mat: new THREE.MeshStandardMaterial({ color: 0xe2d5ad, roughness: 1 }) }], markings, batches, 350);
  const plazaGeo = new THREE.CircleGeometry(23, 64).rotateX(-Math.PI / 2);
  const pos = plazaGeo.getAttribute("position");
  for (let i = 0; i < pos.count; i++) pos.setY(i, getIslandHeight(pos.getX(i), pos.getZ(i)) + 0.045);
  plazaGeo.computeVertexNormals(); const plaza = new THREE.Mesh(plazaGeo, stone); plaza.receiveShadow = true; root.add(plaza);
  // Central fountain gives the dense settlement a legible landmark at every camera scale.
  const fountain = new THREE.Group(), ground = getIslandHeight(0, 0); fountain.position.y = ground;
  const basin = new THREE.Mesh(new THREE.TorusGeometry(2.7, 0.26, 8, 48).rotateX(-Math.PI / 2), curb); basin.position.y = 0.48;
  const pool = new THREE.Mesh(new THREE.CircleGeometry(2.7, 48).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x58c8d4, roughness: 0.17, metalness: 0.18 })); pool.position.y = 0.43;
  const pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.65, 2.8, 12), curb); pillar.position.y = 1.4;
  const bowl = new THREE.Mesh(new THREE.ConeGeometry(1.6, 0.5, 24).rotateX(Math.PI), curb); bowl.position.y = 2.5;
  fountain.add(basin, pool, pillar, bowl); fountain.traverse(o => { if (o instanceof THREE.Mesh) o.castShadow = true; }); root.add(fountain);
  colliders.push({ id: "town-fountain", center: new THREE.Vector3(0, ground + 1.45, 0), size: new THREE.Vector3(5.8, 2.9, 5.8), yaw: 0, kind: "furniture" });
}

async function buildCivicLots(root: THREE.Group, assets: AssetLibrary, layout: IslandLayout, colliders: WorldCollider[]) {
  const schoolParts = await assets.load("/assets/3d/environment/school_building_new.glb");
  const schoolBounds = new THREE.Box3();
  for (const part of schoolParts) {
    part.geo.computeBoundingBox();
    if (part.geo.boundingBox) schoolBounds.union(part.geo.boundingBox);
  }
  const schoolSize = schoolBounds.getSize(new THREE.Vector3());
  const schoolScale = 43 / Math.max(schoolSize.x, schoolSize.z, 1);
  const schoolCenter = schoolBounds.getCenter(new THREE.Vector3());
  const wall = new THREE.MeshStandardMaterial({ color: 0xd8d0bd, roughness: 0.92 });
  const roof = new THREE.MeshStandardMaterial({ color: 0x4c5e63, roughness: 0.86 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x83b7be, roughness: 0.24, metalness: 0.08 });
  const trim = new THREE.MeshStandardMaterial({ color: 0xb65f42, roughness: 0.76 });
  const signMat = new THREE.MeshStandardMaterial({ color: 0xf1dfa9, roughness: 0.75 });
  const cube = new THREE.BoxGeometry(1, 1, 1);
  for (const lot of layout.civicLots) {
    const site = new THREE.Group();
    site.position.set(lot.x, lot.y, lot.z); site.rotation.y = lot.ry;
    site.name = `civic-${lot.kind}-${lot.seed}`;
    root.add(site);
    if (lot.kind === "school") {
      for (const part of schoolParts) {
        part.geo.scale(schoolScale, schoolScale, schoolScale);
        part.geo.translate(-schoolCenter.x * schoolScale, -schoolBounds.min.y * schoolScale, -schoolCenter.z * schoolScale);
        const mesh = new THREE.Mesh(part.geo, part.mat);
        mesh.castShadow = true; mesh.receiveShadow = true; site.add(mesh);
      }
      makeCivicSign(site, "SCHOOL", 0, 5.2, 22, 13);
      colliders.push({ id: site.name, center: new THREE.Vector3(lot.x, lot.y + 5, lot.z), size: new THREE.Vector3(43, 10, 36), yaw: lot.ry, kind: "wall" });
      continue;
    }
    if (lot.kind === "park") {
      makeCivicSign(site, "CENTRAL PARK", 0, 4.3, 19.5, 12);
      const bench = new THREE.MeshStandardMaterial({ color: 0x80543b, roughness: 0.86 });
      for (const [x, z, yaw] of [[-15, 8, Math.PI / 2], [15, 8, -Math.PI / 2], [-8, -15, 0], [8, -15, Math.PI]] as const) {
        const seat = new THREE.Mesh(new THREE.BoxGeometry(4.2, 0.22, 0.72), bench);
        seat.position.set(x, 0.72, z); seat.rotation.y = yaw; site.add(seat);
        const back = new THREE.Mesh(new THREE.BoxGeometry(4.2, 0.95, 0.2), bench);
        back.position.set(x, 1.18, z - Math.cos(yaw) * 0.5); back.rotation.y = yaw; site.add(back);
      }
      continue;
    }
    const addBox = (material: THREE.Material, x: number, y: number, z: number, w: number, h: number, d: number) => {
      const mesh = new THREE.Mesh(cube, material);
      mesh.position.set(x, y, z); mesh.scale.set(w, h, d); mesh.castShadow = true; mesh.receiveShadow = true; site.add(mesh);
      return mesh;
    };
    if (lot.kind === "supermarket") {
      const w = 27, d = 20, h = 7.8, front = d / 2;
      addBox(wall, 0, h / 2, -d / 2, w, h, 0.35);
      addBox(wall, -w / 2, h / 2, 0, 0.35, h, d);
      addBox(wall, w / 2, h / 2, 0, 0.35, h, d);
      addBox(wall, -8.25, h / 2, front, 10.5, h, 0.35);
      addBox(wall, 8.25, h / 2, front, 10.5, h, 0.35);
      addBox(wall, 0, h - 0.72, front, 6, 1.45, 0.35);
      addBox(roof, 0, h + 0.23, 0, w + 0.8, 0.46, d + 0.8);
      addBox(trim, 0, 5.95, front + 0.24, 10.5, 0.28, 0.16);
      for (const x of [-10.8, -5.6, 5.6, 10.8]) addBox(glass, x, 3.35, front + 0.19, 2.6, 2.8, 0.08);
      addBox(signMat, 0, 6.83, front + 0.2, 6.8, 0.92, 0.18);
      makeCivicSign(site, "SUPERMARKET", 0, 8.9, front + 0.45, 9.8);
      const floor = new THREE.Mesh(new THREE.PlaneGeometry(w - 1, d - 1).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0xbdb39e, roughness: 0.95 }));
      floor.position.y = 0.08; site.add(floor);
      for (const x of [-7, -2.4, 2.4, 7]) {
        addBox(trim, x, 1.1, -1.8, 0.16, 1.7, 0.16);
        addBox(signMat, x, 1.98, -1.8, 1.9, 0.12, 0.9);
      }
      for (const [x, width] of [[-6, 12], [6, 12]] as const) colliders.push({ id: `${site.name}-front-${x}`, center: worldOffset(lot, x, h / 2, front), size: new THREE.Vector3(width, h, 0.45), yaw: lot.ry, kind: "wall" });
      for (const x of [-w / 2, w / 2]) colliders.push({ id: `${site.name}-side-${x}`, center: worldOffset(lot, x, h / 2, 0), size: new THREE.Vector3(d, h, 0.45), yaw: lot.ry + Math.PI / 2, kind: "wall" });
      colliders.push({ id: `${site.name}-back`, center: worldOffset(lot, 0, h / 2, -d / 2), size: new THREE.Vector3(w, h, 0.45), yaw: lot.ry, kind: "wall" });
    } else if (lot.kind === "apartment") {
      makeCivicSign(site, "APARTMENTS", 0, 8.8, 10, 10);
    } else if (lot.kind === "busStop") {
      const pole = new THREE.MeshStandardMaterial({ color: 0x526b63, roughness: 0.72, metalness: 0.35 });
      const seat = new THREE.MeshStandardMaterial({ color: 0x9b6748, roughness: 0.8 });
      addBox(roof, 0, 3.2, 0, 5.8, 0.2, 2.2);
      for (const x of [-2.65, 2.65]) addBox(pole, x, 1.55, -0.82, 0.14, 3.1, 0.14);
      addBox(pole, 0, 1.65, -0.85, 5.3, 2.8, 0.09);
      addBox(seat, 0, 0.66, 0.42, 3.9, 0.18, 0.72);
      addBox(seat, 0, 1.22, 0.78, 3.9, 0.85, 0.16);
      addBox(trim, 2.92, 2.08, 0.4, 0.18, 3.9, 0.18);
      addBox(signMat, 2.92, 3.55, 0.4, 0.13, 0.9, 1.9);
      for (const x of [-2.65, 2.65]) colliders.push({ id: `${site.name}-post-${x}`, center: worldOffset(lot, x, 1.55, -0.82), size: new THREE.Vector3(0.2, 3.1, 0.2), yaw: lot.ry, kind: "furniture" });
    }
  }
}

function worldOffset(lot: { x: number; y: number; z: number; ry: number }, x: number, y: number, z: number) {
  const c = Math.cos(lot.ry), s = Math.sin(lot.ry);
  return new THREE.Vector3(lot.x + c * x + s * z, lot.y + y, lot.z - s * x + c * z);
}

function makeCivicSign(root: THREE.Group, text: string, x: number, y: number, z: number, width: number) {
  const canvas = document.createElement("canvas");
  canvas.width = 512; canvas.height = 128;
  const context = canvas.getContext("2d");
  if (!context) return;
  context.fillStyle = "#173f37"; context.fillRect(0, 0, canvas.width, canvas.height);
  context.strokeStyle = "#ead8a8"; context.lineWidth = 9; context.strokeRect(8, 8, canvas.width - 16, canvas.height - 16);
  context.fillStyle = "#fff2c9"; context.font = "bold 52px sans-serif";
  context.textAlign = "center"; context.textBaseline = "middle"; context.fillText(text, 256, 66, 470);
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
  const board = new THREE.Mesh(new THREE.PlaneGeometry(width, width / 4), new THREE.MeshStandardMaterial({ map: texture, roughness: 0.78 }));
  board.position.set(x, y, z); root.add(board);
  const postMaterial = new THREE.MeshStandardMaterial({ color: 0x634b34, roughness: 0.9 });
  for (const postX of [-width * 0.38, width * 0.38]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.18, 2.7, 0.18), postMaterial);
    post.position.set(x + postX, y - width / 8 - 1.35, z); root.add(post);
  }
}

async function buildStreetDetails(root: THREE.Group, assets: AssetLibrary, layout: IslandLayout, batches: WorldBatch[], colliders: WorldCollider[], quality: WorldQuality) {
  const names = ["SM_Street_Pole_Plain_01", "SM_Street_LanternLight_Brown_01", "SM_Street_Vending_HD_Red_103_01", "SM_Street_PlanterBed_Brick_200_01", "SM_Fixture_Canopy25611_01", "SM_Fixture_AcOutdoor_01", "SM_Street_BeerCrate_Yellow_3_01"];
  const models = await Promise.all(names.map(n => assets.load(`${STREET}/glTF/${n}.gltf`)));
  const lists: InstanceItem[][] = names.map(() => []);
  const normalized = models.map((parts, i) => {
    const box = new THREE.Box3(); parts.forEach(p => { p.geo.computeBoundingBox(); if (p.geo.boundingBox) box.union(p.geo.boundingBox); });
    const size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
    parts.forEach(p => p.geo.translate(-c.x, -box.min.y, -c.z));
    return i === 0 ? 8 / Math.max(size.y, 0.1) : i === 4 ? 3.8 / Math.max(size.x, 0.1) : i === 1 ? 3.5 / Math.max(size.y, 0.1) : 1;
  });
  const polePoints: THREE.Vector3[][] = [];
  for (const road of layout.roads.filter(r => r.kind !== "trail" && r.name !== "Plot access")) {
    const points: THREE.Vector3[] = [];
    for (const p of roadSamples(road, road.kind === "street" ? 44 : 90)) {
      const x = p.x - p.dz * (road.width / 2 + 1.65), z = p.z + p.dx * (road.width / 2 + 1.65), y = getIslandHeight(x, z);
      if (y < 1 || sampleIslandWater(x, z) || layout.spots.some(h => Math.hypot(h.x - x, h.z - z) < 8)) continue;
      lists[0].push({ matrix: matrix(x, y, z, Math.atan2(p.dx, p.dz), normalized[0]) });
      points.push(new THREE.Vector3(x, y + 7.3, z));
      colliders.push({ id: `pole-${colliders.length}`, center: new THREE.Vector3(x, y + 4, z), size: new THREE.Vector3(0.32, 8, 0.32), yaw: 0, kind: "tree" });
      if (road.kind === "street") lists[1].push({ matrix: matrix(x + p.dz * 0.9, y, z - p.dx * 0.9, Math.atan2(p.dx, p.dz), normalized[1]) });
    }
    polePoints.push(points);
  }
  layout.spots.forEach((h, i) => {
    const shop = h.family === "shop" || h.family === "tavern", front = 7.2, c = Math.cos(h.ry), s = Math.sin(h.ry);
    const place = (index: number, x: number, z: number, lift = 0) => {
      const wx = h.x + c * x + s * z, wz = h.z - s * x + c * z;
      lists[index].push({ matrix: matrix(wx, lift ? h.y + lift : getIslandHeight(wx, wz) + 0.04, wz, h.ry, normalized[index]) });
    };
    if (shop || i % 7 === 0) place(4, 0, front, 2.45);
    if (shop) { place(2, 3.3, front + 0.4); place(6, -3.5, front + 0.4); }
    if (i % 3 === 0) place(3, 4.3, front);
    if (quality !== "low" && i % 2 === 0) place(5, -4.5, -6.4, 0.3);
  });
  models.forEach((p, i) => batchParts(root, p, lists[i], batches, i === 0 ? 1400 : 280, i === 0 && quality !== "low"));
  const wirePositions: number[] = [];
  for (const points of polePoints) for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i]; if (a.distanceTo(b) > 140) continue;
    for (let j = 0; j < 12; j++) for (const t of [j / 12, (j + 1) / 12]) {
      const p = a.clone().lerp(b, t); p.y -= Math.sin(t * Math.PI) * 0.65; wirePositions.push(p.x, p.y, p.z);
    }
  }
  const wireGeo = new THREE.BufferGeometry(); wireGeo.setAttribute("position", new THREE.Float32BufferAttribute(wirePositions, 3));
  root.add(new THREE.LineSegments(wireGeo, new THREE.LineBasicMaterial({ color: 0x3b3b37 })));
}

function fieldPoint(field: IslandField, x: number, z: number) {
  const c = Math.cos(field.yaw), s = Math.sin(field.yaw);
  return new THREE.Vector2(field.x + c * x + s * z, field.z - s * x + c * z);
}
function buildFields(root: THREE.Group, layout: IslandLayout, batches: WorldBatch[], quality: WorldQuality) {
  const fences: InstanceItem[] = [], crop: InstanceItem[] = [], cropRand = rng(63), fieldMat = surfaceMaterial(0x9c7d4c);
  for (const [index, f] of layout.fields.entries()) {
    const geometry = new THREE.PlaneGeometry(f.width, f.depth, 28, 22).rotateX(-Math.PI / 2).rotateY(f.yaw).translate(f.x, 0, f.z);
    const positions = geometry.getAttribute("position");
    for (let i = 0; i < positions.count; i++) positions.setY(i, getIslandHeight(positions.getX(i), positions.getZ(i)) + 0.025);
    geometry.computeVertexNormals(); const mesh = new THREE.Mesh(geometry, fieldMat); mesh.receiveShadow = true; root.add(mesh);
    for (const [axis, side] of [[0, -1], [0, 1], [1, -1], [1, 1]]) {
      const length = axis === 0 ? f.width : f.depth, n = Math.ceil(length / 5);
      for (let i = 0; i <= n; i++) {
        const along = -length / 2 + i * length / n;
        const p = fieldPoint(f, axis === 0 ? along : side * f.width / 2, axis === 0 ? side * f.depth / 2 : along);
        if (layout.distanceToRoad(p.x, p.y) < 2 || sampleIslandWater(p.x, p.y)) continue;
        const y = getIslandHeight(p.x, p.y);
        fences.push({ matrix: matrix(p.x, y + 0.6, p.y, f.yaw, 0.16, 1.2, 0.16) });
        if (i < n) {
          const b = fieldPoint(f, axis === 0 ? along + length / n : side * f.width / 2, axis === 0 ? side * f.depth / 2 : along + length / n);
          const by = getIslandHeight(b.x, b.y), yaw = Math.atan2(b.x - p.x, b.y - p.y);
          for (const height of [0.43, 0.92]) fences.push({ matrix: matrix((p.x + b.x) / 2, (y + by) / 2 + height, (p.y + b.y) / 2, yaw, 0.085, 0.11, length / n) });
        }
      }
    }
    const spacing = quality === "high" ? 2.8 : quality === "medium" ? 4 : 6;
    for (let z = -f.depth / 2 + 4; z < f.depth / 2 - 4; z += spacing) for (let x = -f.width / 2 + 4; x < f.width / 2 - 4; x += spacing * 1.4) {
      const p = fieldPoint(f, x + cropRand() * 0.35, z);
      if (getIslandHeight(p.x, p.y) < 1.2 || sampleIslandWater(p.x, p.y) || layout.distanceToRoad(p.x, p.y) < 2) continue;
      crop.push({ matrix: matrix(p.x, getIslandHeight(p.x, p.y) + 0.3, p.y, f.yaw, 0.35, 0.5 + cropRand() * 0.5, 0.35), colour: new THREE.Color(index % 3 === 0 ? 0xc4b24c : index % 3 === 1 ? 0x749742 : 0xabc267) });
    }
  }
  batchParts(root, [{ geo: new THREE.BoxGeometry(1, 1, 1), mat: new THREE.MeshStandardMaterial({ color: 0x776447, roughness: 1 }) }], fences, batches, 1000);
  batchParts(root, [{ geo: new THREE.ConeGeometry(1, 1, 5), mat: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1 }) }], crop, batches, quality === "high" ? 380 : 260);
}

function buildHarbour(root: THREE.Group, layout: IslandLayout, batches: WorldBatch[], colliders: WorldCollider[], supports: WorldSupport[]) {
  const wood = new THREE.MeshStandardMaterial({ color: 0x8d7857, roughness: 0.93 }), stone = new THREE.MeshStandardMaterial({ color: 0xddd4b6, roughness: 0.88 });
  const planks: InstanceItem[] = [], piles: InstanceItem[] = [], boxes: InstanceItem[] = [];
  const harbour = layout.centres.harbour;
  let shoreline = harbour.x;
  for (let x = harbour.x; x > harbour.x - 450; x -= 2) { if (getIslandHeight(x, harbour.y) < 0.7) { shoreline = x + 4; break; } }
  for (const offset of [-30, 0, 30]) {
    const z = harbour.y + offset, deck = Math.max(1.7, getIslandHeight(shoreline, z) + 0.08), length = 48 + (offset === 0 ? 15 : 0);
    // Ramp anchors the pier to the same terrain, while planks and piling feet are measured individually.
    const landY = getIslandHeight(shoreline + 8, z), rampDepth = 10;
    const ramp = new THREE.Mesh(new THREE.BoxGeometry(rampDepth, 0.2, 4.5), wood);
    ramp.position.set(shoreline + 3, (landY + deck) / 2 - 0.1, z); ramp.rotation.z = Math.atan2(landY - deck, rampDepth); ramp.receiveShadow = true; root.add(ramp);
    supports.push({ id: `dock-ramp-${offset}`, center: new THREE.Vector3(shoreline + 3, (landY + deck) / 2, z), width: 4.5, depth: rampDepth, yaw: Math.PI / 2, slopeZ: (landY - deck) / rampDepth });
    supports.push({ id: `dock-${offset}`, center: new THREE.Vector3(shoreline - length / 2, deck, z), width: 4.5, depth: length, yaw: Math.PI / 2 });
    for (let d = 0; d < length; d += 0.45) planks.push({ matrix: matrix(shoreline - d, deck - 0.09, z, 0, 0.42, 0.18, 4.5) });
    for (let d = 4; d < length; d += 9) for (const side of [-1, 1]) {
      const x = shoreline - d, pz = z + side * 2.1, floor = getIslandHeight(x, pz), height = deck + 0.6 - floor;
      piles.push({ matrix: matrix(x, floor + height / 2, pz, 0, 0.3, height, 0.3) });
      colliders.push({ id: `dock-pile-${colliders.length}`, center: new THREE.Vector3(x, deck + 0.25, pz), size: new THREE.Vector3(0.3, 0.5, 0.3), yaw: 0, kind: "furniture" });
    }
    boxes.push({ matrix: matrix(shoreline - 8, deck + 0.6, z + 1.4, 0.2, 1.2, 1.2, 1.2) });
  }
  batchParts(root, [{ geo: new THREE.BoxGeometry(1, 1, 1), mat: wood }], planks, batches, 2400);
  batchParts(root, [{ geo: new THREE.CylinderGeometry(1, 1, 1, 8), mat: wood }], piles, batches, 1600);
  batchParts(root, [{ geo: new THREE.BoxGeometry(1, 1, 1), mat: wood }], boxes, batches, 350, true);
  // Lighthouse is built on solid coastline just north of the landing, never above seabed.
  let lx = shoreline + 18;
  const lz = harbour.y - 90;
  for (let i = 0; getIslandHeight(lx, lz) < 1.5 && i < 100; i++) lx += 2;
  const ly = getIslandHeight(lx, lz), lighthouse = new THREE.Group(); lighthouse.position.set(lx, ly, lz);
  const tower = new THREE.Mesh(new THREE.CylinderGeometry(2, 3.4, 18, 16), stone); tower.position.y = 9;
  const stripe = new THREE.Mesh(new THREE.CylinderGeometry(2.4, 2.7, 3.4, 16), new THREE.MeshStandardMaterial({ color: 0xb84f39, roughness: 0.85 })); stripe.position.y = 11;
  const lantern = new THREE.Mesh(new THREE.CylinderGeometry(1.8, 1.8, 2.5, 12), new THREE.MeshStandardMaterial({ color: 0x77bfcd, roughness: 0.18, metalness: 0.35, emissive: 0xf3ce76, emissiveIntensity: 0.25 })); lantern.position.y = 19;
  const roof = new THREE.Mesh(new THREE.ConeGeometry(2.8, 2, 12), new THREE.MeshStandardMaterial({ color: 0x586473, roughness: 0.7 })); roof.position.y = 21.2;
  lighthouse.add(tower, stripe, lantern, roof); lighthouse.traverse(o => { if (o instanceof THREE.Mesh) o.castShadow = o.receiveShadow = true; }); root.add(lighthouse);
  colliders.push({ id: "lighthouse", center: new THREE.Vector3(lx, ly + 9, lz), size: new THREE.Vector3(6.8, 18, 6.8), yaw: 0, kind: "wall" });
  return new THREE.Vector3(lx, ly + 2, lz);
}

/** The only world entry point; all scene mutation belongs to this disposable world instance. */
export async function createStylizedWorld(
  scene: THREE.Scene, renderer: THREE.WebGLRenderer, quality: WorldQuality,
  onProgress?: (text: string) => void, signal?: AbortSignal,
): Promise<StylizedWorld> {
  const check = () => { if (signal?.aborted) throw new DOMException("Island loading cancelled", "AbortError"); };
  check();
  const assets = createAssetLibrary(signal), world = new THREE.Group(), lights = new THREE.Group();
  world.name = "StylizedWorld 5km reference island"; lights.name = "Island light rig";
  const oldEnvironment = scene.environment, oldIntensity = scene.environmentIntensity, oldFog = scene.fog;
  let envTarget: THREE.WebGLRenderTarget | undefined;
  let terrain: ReturnType<typeof createIslandTerrain> | undefined;
  let grass: ReturnType<typeof createIslandGrass> | undefined;
  let lawnMask: LawnMask | undefined;
  let waters: ReturnType<typeof createIslandWaters> | undefined;
  let peakMaterials: Awaited<ReturnType<typeof loadPeakMaterials>> | undefined;
  let peakWater: ReturnType<typeof createPeakWater> | undefined;
  const details = new THREE.Group();
  details.name = "Island roads, farms and harbour";
  world.add(details);
  let houses: ReturnType<typeof createHouses> | undefined;
  let nature: Awaited<ReturnType<typeof buildIslandNature>> | undefined;
  let legacy: LegacyFlora | undefined;
  let hTex: THREE.Texture | undefined;
  let spatial: WorldSpatial | undefined;
  let disposed = false;
  const initialCelestial = getCelestialState(new Date());
  const sky = createSky(initialCelestial.sun, initialCelestial.moon);
  sky.scale.setScalar(3); const skyUniforms = (sky.material as THREE.ShaderMaterial).uniforms;
  const sunDir = skyUniforms.uSun.value as THREE.Vector3;
  const moonDir = skyUniforms.uMoon.value as THREE.Vector3;
  const dispose = () => {
    if (disposed) return; disposed = true;
    signal?.removeEventListener("abort", dispose);
    world.removeFromParent(); lights.removeFromParent(); sky.removeFromParent();
    peakWater?.dispose();
    houses?.dispose(); terrain?.dispose(); grass?.dispose(); lawnMask?.dispose(); waters?.dispose(); nature?.dispose(); legacy?.dispose(); spatial?.dispose();
    peakMaterials?.dispose();
    // Do not traverse the scene: player/VRM resources and other services are not world-owned.
    world.traverse(o => { if (o instanceof THREE.InstancedMesh) o.dispose(); });
    assets.own(details); assets.own(sky); assets.dispose();
    if (envTarget && scene.environment === envTarget.texture) {
      scene.environment = oldEnvironment; scene.environmentIntensity = oldIntensity;
    }
    envTarget?.dispose();
    if (scene.fog === fog) scene.fog = oldFog;
    lights.traverse(o => { if (o instanceof THREE.DirectionalLight) o.shadow.dispose(); });
  };
  const fog = new THREE.FogExp2(0xb4d4df, quality === "low" ? 0.0002 : 0.00014);
  signal?.addEventListener("abort", dispose, { once: true });
  try {
    onProgress?.("Reading the reference coastline and mountain height field…");
    await loadIslandData(signal); check();
    if (quality === "high") {
      onProgress?.("Loading peak ground, bark and building finishes…");
      try { peakMaterials = await loadPeakMaterials(signal); check(); }
      catch (error) {
        if (signal?.aborted) throw error;
        console.warn("Peak surface art unavailable; keeping original island finishes", error);
      }
    }
    const layout = createIslandLayout();
    const grassClear = [...layout.plots];
    for (const field of layout.fields) {
      for (let x = -field.width / 2; x <= field.width / 2; x += 16) {
        for (let z = -field.depth / 2; z <= field.depth / 2; z += 16) {
          const point = fieldPoint(field, x, z);
          grassClear.push({ x: point.x, z: point.y, radius: 13 });
        }
      }
    }
    const lawnOk = (x: number, z: number) => Math.hypot(x, z) > 25 && layout.distanceToRoad(x, z) > 2.5 && !layout.spots.some(s => Math.hypot(s.x - x, s.z - z) < 8.5) && !layout.fields.some(f => { const dx = x - f.x, dz = z - f.z, c = Math.cos(f.yaw), s = Math.sin(f.yaw); return Math.abs(dx * c - dz * s) < f.width / 2 + 1.5 && Math.abs(dx * s + dz * c) < f.depth / 2 + 1.5; });
    hTex = bakeIsland(grassClear, layout.roads, layout.plots, lawnOk); check();
    layout.spots.forEach(spot => { spot.y = getIslandHeight(spot.x, spot.z); });
    spatial = new WorldSpatial({ terrain: getIslandHeight, water: sampleIslandWater, halfExtent: HALF });
    terrain = createIslandTerrain(hTex, peakMaterials?.terrain); world.add(terrain);
    lawnMask = new LawnMask(layout); lawnMask.update(0, 0);
    grass = createIslandGrass(quality === "high" ? 460000 : quality === "medium" ? 280000 : 48000, hTex, quality === "high", lawnMask); world.add(grass.mesh);
    waters = createIslandWaters(hTex, sunDir, quality === "high"); world.add(waters);
    if (quality === "high") peakWater = createPeakWater(waters, renderer, scene);
    scene.add(world, lights, sky); scene.fog = fog;
    const hemi = new THREE.HemisphereLight(0xd9edff, 0x8ba457, 1.6), sun = new THREE.DirectionalLight(0xffebcb, 3.05);
    const moon = new THREE.DirectionalLight(0x94b6eb, 0);
    moon.castShadow = false;
    sun.castShadow = quality !== "low";
    const shadowSize = quality === "high" ? 4096 : 2048;
    sun.shadow.mapSize.set(shadowSize, shadowSize); sun.shadow.bias = -0.00025; sun.shadow.normalBias = 0.065; sun.shadow.radius = 4;
    sun.shadow.camera.near = 1; sun.shadow.camera.far = 950;
    lights.add(hemi, sun, sun.target, moon, moon.target);
    const pmrem = new THREE.PMREMGenerator(renderer), envScene = new THREE.Scene(); envScene.add(sky.clone());
    try { envTarget = pmrem.fromScene(envScene, 0, 1, 24000); } finally { pmrem.dispose(); }
    scene.environment = envTarget.texture; scene.environmentIntensity = 0.6;

    onProgress?.("Building the dense town, harbour and road-linked homes…");
    houses = createHouses(layout.spots, peakMaterials); world.add(houses.group);
    spatial.addColliders(houses.colliders); spatial.addSupports(houses.supports);
    houses.attachCollision(spatial);
    const batches: WorldBatch[] = [], colliders: WorldCollider[] = [], supports: WorldSupport[] = [];
    buildRoads(details, layout, batches, colliders, supports);
    buildFields(details, layout, batches, quality);
    const lighthouse = buildHarbour(details, layout, batches, colliders, supports);
    await buildCivicLots(details, assets, layout, colliders); check();
    assets.own(details);
    onProgress?.("Fitting textured awnings, power poles and street details…");
    await buildStreetDetails(details, assets, layout, batches, colliders, quality); check(); assets.own(details);
    onProgress?.("Growing textured forest stands, wildflowers and coastal stone…");
    nature = await buildIslandNature(assets, layout, quality, signal, inLegacyZone, peakMaterials); check(); world.add(nature.group);
    onProgress?.("Planting the original animated meadow trees, bushes, flowers and rocks…");
    legacy = await buildLegacyFlora(assets, layout, quality, signal, nature, peakMaterials); check(); world.add(legacy.group);
    spatial.addColliders(colliders); spatial.addColliders(nature.colliders); spatial.addColliders(legacy.colliders); spatial.addSupports(supports);
    assets.own(details);
    const landmarks: Record<string, WorldLandmark> = {};
    for (const [key, p] of Object.entries(layout.centres)) landmarks[key] = { name: key === "town" ? "Town square" : key === "harbour" ? "Northwest harbour" : key === "mountains" ? "Mount Rusticus" : key === "lake" ? "Highland lake" : key === "farms" ? "Southern farms" : "Eastern forest", position: new THREE.Vector3(p.x, getIslandHeight(p.x, p.y) + 1.7, p.y) };
    landmarks.lighthouse = { name: "Harbour lighthouse", position: lighthouse };
    for (const lot of layout.civicLots) {
      if (lot.kind === "busStop") continue;
      const names = { school: "School", park: "Central Park", supermarket: "Supermarket", apartment: "Apartments" } as const;
      landmarks[lot.kind] = { name: names[lot.kind], position: new THREE.Vector3(lot.x, lot.y + 1.7, lot.z) };
    }
    const northRock = sourceToWorld(-340, -860), westRock = sourceToWorld(-680, -140), reef = sourceToWorld(710, 1000);
    for (const [key, p] of [["northIsle", northRock], ["westIsle", westRock], ["reef", reef]] as const) landmarks[key] = { name: key, position: new THREE.Vector3(p.x, getIslandHeight(p.x, p.y), p.y) };
    landmarks.drone = { name: "Island overview", position: new THREE.Vector3(0, 60, 0) };
    const spawn = new THREE.Vector3(10, getIslandHeight(10, 0) + 0.02, 0);
  let shadowHalf = 0, elapsed = 0, mood: LightingMood = "tactical";
  let daylight = initialCelestial.daylight, celestialTime = 0;
  let celestial = initialCelestial;
    const loadedLawn = lawnMask, contact = spatial, loadedTerrain = terrain, loadedGrass = grass, loadedHouses = houses, loadedNature = nature;
    const metrics = { houses: houses.houses.length, trees: nature.treeCount + legacy.treeCount, rocks: nature.rockCount + legacy.rockCount, colliders: spatial.stats.colliders, supports: spatial.stats.supports };
    const result: StylizedWorld = {
      spatial: contact, bounds: { halfExtent: HALF }, spawn, landmarks, houses: houses.houses, metrics,
      nearestDoor: (playerPosition) => loadedHouses.nearestDoor(playerPosition),
      toggleNearestDoor: (playerPosition) => loadedHouses.toggleNearestDoor(playerPosition),
      update(dt, camera, target, playerPosition) {
        if (disposed) return;
        const player = playerPosition ?? target, delta = THREE.MathUtils.clamp(dt, 0, 0.1);
        elapsed += delta; uTime.value = elapsed;
        celestialTime += delta;
        if (celestialTime >= 1) {
          celestialTime %= 1;
          celestial = getCelestialState(new Date());
        }
        sunDir.copy(celestial.sun);
        moonDir.copy(celestial.moon);
        daylight += (celestial.daylight - daylight) * (1 - Math.exp(-delta * 1.1));
        const dayFactor = mood === "tactical" ? daylight : mood === "cyber" ? 0 : 1;
        skyUniforms.uDay.value = THREE.MathUtils.lerp(0.05, 1, dayFactor);
        skyUniforms.uMoonlight.value = mood === "tactical" ? celestial.moonlight : mood === "cyber" ? 0.58 : 0;
        skyUniforms.uMoonVisible.value = mood === "studio" ? 0 : 1;
        uDay.value = mood === "tactical" ? daylight : mood === "cyber" ? 0.16 : 1;
        const moonFactor = mood === "tactical" ? celestial.moonlight : mood === "cyber" ? 0.58 : 0;
        hemi.intensity = THREE.MathUtils.lerp(0.1, 1.65, dayFactor) + moonFactor * 0.18;
        hemi.color.set(mood === "cyber" ? 0x44557a : 0xd9edff);
        hemi.groundColor.set(mood === "cyber" ? 0x111827 : 0x8ba457);
        sun.intensity = 3.05 * dayFactor;
        sun.color.set(daylight < 0.28 ? 0xffa269 : 0xffebcb);
        moon.intensity = 0.52 * moonFactor;
        scene.environmentIntensity = 0.08 + 0.52 * dayFactor + 0.08 * moonFactor;
        fog.color.set(mood === "tactical" ? new THREE.Color(0x15243a).lerp(new THREE.Color(0xb4d4df), daylight) : mood === "cyber" ? 0x0a0f1d : 0x18181b);
        sky.position.copy(camera.position);
        loadedGrass.centre.copy(camera.position.distanceTo(target) < 300 ? camera.position : player);
        loadedLawn?.update(loadedGrass.centre.x, loadedGrass.centre.z);
        loadedTerrain.update(camera.position);
        loadedHouses.update(delta, player, camera.position); loadedNature.update(camera, player);
        peakWater?.update(delta, camera);
        for (const batch of batches) {
          const distance = Math.hypot(batch.centre.x - camera.position.x, batch.centre.z - camera.position.z);
          batch.group.visible = distance < batch.distance;
          for (const child of batch.group.children) if (child instanceof THREE.Mesh) child.castShadow = batch.shadow && batch.centre.distanceToSquared(player) < 160 * 160;
        }
        // Tight player-following sun shadows, rather than a 5km low-resolution shadow map.
        const distance = camera.position.distanceTo(target), half = THREE.MathUtils.clamp(distance * 1.45, 55, 180);
        if (Math.abs(half - shadowHalf) > half * 0.08) {
          shadowHalf = half; const c = sun.shadow.camera; c.left = c.bottom = -half; c.right = c.top = half; c.updateProjectionMatrix();
        }
        sun.castShadow = quality !== "low" && distance < 500 && dayFactor > 0.12;
        const snap = (shadowHalf * 2) / shadowSize * 4;
        sun.target.position.set(Math.round(player.x / snap) * snap, player.y, Math.round(player.z / snap) * snap);
        sun.position.copy(sun.target.position).addScaledVector(sunDir, 430);
        moon.target.position.copy(sun.target.position);
        moon.position.copy(moon.target.position).addScaledVector(celestial.moon, 380);
      },
      setMood(value) {
        if (disposed) return;
        mood = value;
      },
      dispose,
    };
    onProgress?.(`${metrics.houses} walk-in homes · ${metrics.trees.toLocaleString()} trees · reference island ready`);
    return result;
  } catch (error) { dispose(); throw error; }
}
