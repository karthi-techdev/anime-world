import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { ENV, NATURE, fbm, rng, uTime, windify } from "./worldShared";
import type { Part } from "./worldShared";
import { getIslandHeight, grassMask, HALF, sampleIslandWater, sourceToWorld } from "./islandTerrain";
import type { IslandLayout } from "./islandLayout";
import type { WorldCollider } from "./worldTypes";
import { createPeakFlora } from "./peakFlora";
import type { PeakMaterials } from "./peakMaterials";
import { applyPeakSurface } from "./peakMaterials";

export interface AssetLibrary {
  load(url: string): Promise<Part[]>;
  own(root: THREE.Object3D): void;
  dispose(): void;
}

/** Per-world promise cache and resource ownership; late loads cannot survive cancellation. */
export function createAssetLibrary(signal?: AbortSignal): AssetLibrary {
  const loader = new GLTFLoader(), cache = new Map<string, Promise<Part[]>>();
  const geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>(), textures = new Set<THREE.Texture>();
  let disposed = false;
  const ownMaterial = (material: THREE.Material) => {
    materials.add(material);
    for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value);
    if (material instanceof THREE.ShaderMaterial) for (const uniform of Object.values(material.uniforms)) {
      if (uniform.value instanceof THREE.Texture) textures.add(uniform.value);
    }
  };
  const own = (root: THREE.Object3D) => root.traverse(object => {
    if (!(object instanceof THREE.Mesh || object instanceof THREE.Points || object instanceof THREE.Line)) return;
    geometries.add(object.geometry);
    for (const m of Array.isArray(object.material) ? object.material : [object.material]) ownMaterial(m);
  });
  const dispose = () => {
    for (const geo of geometries) geo.dispose();
    for (const mat of materials) mat.dispose();
    for (const tex of textures) tex.dispose();
    geometries.clear(); materials.clear(); textures.clear(); cache.clear();
    disposed = true;
  };
  return {
    own,
    load(url) {
      const cached = cache.get(url);
      if (cached) return cached;
      const promise = loader.loadAsync(url).then(gltf => {
        own(gltf.scene);
        if (disposed || signal?.aborted) {
          dispose();
          throw new DOMException("Island loading cancelled", "AbortError");
        }
        gltf.scene.updateMatrixWorld(true);
        const parts: Part[] = [];
        gltf.scene.traverse(object => {
          if (!(object instanceof THREE.Mesh)) return;
          const geo = object.geometry.clone().applyMatrix4(object.matrixWorld);
          geometries.add(geo);
          const source = Array.isArray(object.material) ? object.material : [object.material];
          if (source.length === 1) {
            const mat = source[0].clone(); ownMaterial(mat); parts.push({ geo, mat });
          } else {
            // Preserve glTF material groups instead of painting the whole model with material zero.
            for (const group of geo.groups) {
              const subset = geo.index ? geo.toNonIndexed() : geo.clone();
              for (const name of Object.keys(subset.attributes)) {
                const attribute = subset.getAttribute(name);
                if (!(attribute instanceof THREE.BufferAttribute)) continue;
                const array = attribute.array.slice(group.start * attribute.itemSize, (group.start + group.count) * attribute.itemSize);
                subset.setAttribute(name, new THREE.BufferAttribute(array, attribute.itemSize, attribute.normalized));
              }
              subset.clearGroups(); geometries.add(subset);
              const mat = source[group.materialIndex ?? 0].clone(); ownMaterial(mat); parts.push({ geo: subset, mat });
            }
          }
        });
        return parts;
      });
      cache.set(url, promise);
      return promise;
    },
    dispose,
  };
}

interface Placement { x: number; y: number; z: number; scale: number; yaw: number; tint?: THREE.Color }
interface Batch { group: THREE.Group; centre: THREE.Vector3; detailed: boolean; far: number; shadow: boolean }
export interface IslandNature {
  group: THREE.Group;
  colliders: WorldCollider[];
  treeCount: number;
  rockCount: number;
  update(camera: THREE.Camera, player: THREE.Vector3): void;
  peakEnabled: boolean;
  addPeakGround?(points: { x: number; y: number; z: number; scale: number; yaw: number }[], kind: "bush" | "flowers"): void;
  dispose(): void;
}
const leaf = (p: Part) => /leaves|leaf|canopy/i.test(p.mat.name) || (p.mat instanceof THREE.MeshStandardMaterial && p.mat.alphaTest > 0);
function prepare(parts: Part[], bend: number, hero = false) {
  for (const p of parts) {
    if (!(p.mat instanceof THREE.MeshStandardMaterial)) continue;
    const m = p.mat;
    m.roughness = leaf(p) ? 1 : 0.85; m.metalness = 0;
    if (hero) { p.geo.deleteAttribute("color"); m.vertexColors = false; m.color.set(0xffffff); m.emissive.set(0); }
    if (leaf(p)) {
      m.transparent = false; m.alphaTest = 0.42; m.alphaToCoverage = true; m.depthWrite = true; m.side = THREE.DoubleSide;
      p.geo.computeBoundingBox();
      windify(m, { bend, flutter: 0.035, puff: p.geo.boundingBox?.getCenter(new THREE.Vector3()) });
    } else windify(m, { bend, flutter: 0 });
  }
}
function bounds(parts: Part[]) {
  const box = new THREE.Box3();
  for (const p of parts) { p.geo.computeBoundingBox(); if (p.geo.boundingBox) box.union(p.geo.boundingBox); }
  return box;
}
const normalY = (x: number, z: number) => {
  const e = 3;
  return 6 / Math.hypot(getIslandHeight(x - e, z) - getIslandHeight(x + e, z), 6, getIslandHeight(x, z - e) - getIslandHeight(x, z + e));
};

export async function buildIslandNature(
  assets: AssetLibrary, layout: IslandLayout, quality: "low" | "medium" | "high", signal?: AbortSignal,
  /** Zones owned by another flora layer (the original meadow flora around the spawn). */
  skip?: (x: number, z: number) => boolean,
  peakMaterials?: PeakMaterials,
): Promise<IslandNature> {
  const root = new THREE.Group(); root.name = "Chunked trees, flowers and stone";
  const batches: Batch[] = [], colliders: WorldCollider[] = [], rand = rng(42);
  const detailDistance = quality === "high" ? 330 : quality === "medium" ? 240 : 160;
  const check = () => { if (signal?.aborted) throw new DOMException("Island loading cancelled", "AbortError"); };
  const peak = quality === "high" ? await createPeakFlora(assets, signal).catch(error => {
    if (signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) throw error;
    // Network/asset failure must not prevent a playable world: use original art.
    console.warn("Peak foliage unavailable; retaining original High nature", error);
    return undefined;
  }) : undefined;
  if (peak) root.add(peak.group);
  const addBatches = (parts: Part[], points: Placement[], detailed: boolean, far: number, cast: boolean, tintLeaves = false) => {
    const chunks = new Map<string, Placement[]>();
    for (const p of points) {
      const key = `${Math.floor(p.x / 128)},${Math.floor(p.z / 128)}`;
      const list = chunks.get(key) ?? []; list.push(p); chunks.set(key, list);
    }
    for (const points of chunks.values()) {
      const chunk = new THREE.Group(), centre = new THREE.Vector3();
      for (const p of points) centre.add(new THREE.Vector3(p.x, p.y, p.z));
      centre.multiplyScalar(1 / points.length);
      for (const part of parts) {
        const mesh = new THREE.InstancedMesh(part.geo, part.mat, points.length);
        const transform = new THREE.Matrix4(), rotation = new THREE.Quaternion();
        points.forEach((p, i) => {
          transform.compose(new THREE.Vector3(p.x, p.y, p.z), rotation.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, p.yaw), new THREE.Vector3(p.scale, p.scale, p.scale));
          mesh.setMatrixAt(i, transform);
          if (p.tint && (!tintLeaves || leaf(part))) mesh.setColorAt(i, p.tint);
        });
        mesh.instanceMatrix.needsUpdate = true;
        mesh.computeBoundingSphere();
        if (mesh.boundingSphere) mesh.boundingSphere.radius += 3;
        mesh.castShadow = cast; mesh.receiveShadow = true; mesh.frustumCulled = true;
        chunk.add(mesh);
      }
      root.add(chunk); batches.push({ group: chunk, centre, detailed, far, shadow: cast });
    }
  };
  const canGrow = (x: number, z: number, margin: number, steep = 0.85) =>
    !skip?.(x, z) && getIslandHeight(x, z) > 1.4 && !sampleIslandWater(x, z) && grassMask(x, z) > 0.55 && !layout.isReserved(x, z, margin) && normalY(x, z) > steep;
  const treeTotal = quality === "high" ? 9500 : quality === "medium" ? 6500 : 1600;
  // Procedural stylized trees (round / umbrella / pine / cypress) with thick trunks, see stylizedTrees.ts.
  const treeParts = await Promise.all([1, 2, 3, 4, 5].flatMap(i => [`BirchTree_${i}`, `MapleTree_${i}`]).map(name => assets.load(`${NATURE}/${name}.gltf`)));
  treeParts.forEach(parts => prepare(parts, 0.004)); // leaf-card birch/maple trees replace the low-poly lollipop kit
  check();
  // (thin stylized_tree.glb removed: sparse thin-trunk look was unwanted)
  // Normalize the roots and preserve the imported bark albedo and normal maps.
  const treeBounds = treeParts.map(parts => {
    const box = bounds(parts), centre = box.getCenter(new THREE.Vector3());
    parts.forEach(p => p.geo.translate(-centre.x, -box.min.y, -centre.z));
    return box.getSize(new THREE.Vector3());
  });
  const treeLists: Placement[][] = treeParts.map(() => []), allTrees: Placement[] = [];
  const spacing = new Set<string>();
  const addTree = (x: number, z: number, heroTree = false) => {
    const cell = `${Math.round(x / 7)},${Math.round(z / 7)}`;
    if (spacing.has(cell) || !canGrow(x, z, 4, 0.82)) return;
    spacing.add(cell);
    const variant = Math.floor(rand() * treeParts.length);
    const height = heroTree ? 15 + rand() * 6 : 9 + rand() * 9;
    const scale = height / Math.max(treeBounds[variant].y, 0.1);
    const p = { x, y: getIslandHeight(x, z) - 0.08, z, scale, yaw: rand() * Math.PI * 2,
      tint: (() => {
        const c = rand();
        return c < 0.12 ? new THREE.Color(2.4, 0.8, 1.5) : c < 0.2 ? new THREE.Color(2.2, 0.38, 0.6) : c < 0.3 ? new THREE.Color(2.3, 1.6, 0.3) : c < 0.38 ? new THREE.Color(2.3, 0.85, 0.2)
          : new THREE.Color(0.9 + rand() * 0.3, 0.95 + rand() * 0.2, 0.85 + rand() * 0.2);
      })() };
    treeLists[variant].push(p); allTrees.push({ ...p, scale: height });
    colliders.push({ id: `tree-${allTrees.length}`, center: new THREE.Vector3(x, p.y + height * 0.3, z), size: new THREE.Vector3(height * 0.052, height * 0.6, height * 0.052), yaw: 0, kind: "tree" });
  };
  // Concentrate coherent forest stands in the eastern massif and southwest groves.
  for (let tries = 0; allTrees.length < treeTotal && tries < treeTotal * 24; tries++) {
    const x = (rand() * 2 - 1) * HALF, z = (rand() * 2 - 1) * HALF;
    const src = sourceToWorld(1, 0).x, sx = x / src, sz = z / src;
    const eastern = sx > 110 && sx < 680 && sz > -620 && sz < 290;
    const western = sx > -340 && sx < -80 && sz > 280 && sz < 680;
    const forest = fbm(x * 0.0015 + 7, z * 0.0015 + 3) > (eastern || western ? -0.5 : -0.3);
    if (!forest || (!eastern && !western && rand() > 0.9)) continue;
    addTree(x, z, tries % 25 === 0);
  }
  // A human-scale tree belt visible immediately on entering the central street.
  for (let z = -145; z <= 145; z += 29) for (const x of [-150, 150]) addTree(x, z, true);
  // Keep the existing colorful tree art at every quality. Peak foliage supplies ground cover only.
  treeLists.forEach((points, i) => addBatches(treeParts[i], points, true, Math.max(detailDistance, 900), quality !== "low", true));
  assets.own(root);

  const bushes = await Promise.all(["Bush", "Bush_Large", "Bush_Small", "Bush_Flowers", "Bush_Large_Flowers"].map(name => assets.load(`${NATURE}/${name}.gltf`)));
  const flowers = await Promise.all([1, 2, 3, 4, 5].map(i => assets.load(`${NATURE}/Flower_${i}_Clump.gltf`)));
  check();
  const scatter = (variants: Part[][], perVariant: number, minHeight: number, maxHeight: number, distance: number, margin: number) => {
    const highPoints: Placement[] = [];
    variants.forEach((parts, index) => {
      prepare(parts, minHeight < 0.5 ? 0.09 : 0.008);
      const box = bounds(parts), centre = box.getCenter(new THREE.Vector3());
      parts.forEach(p => p.geo.translate(-centre.x, -box.min.y, -centre.z));
      const height = Math.max(box.max.y - box.min.y, 0.05), points: Placement[] = [];
      for (let tries = 0; points.length < perVariant && tries < perVariant * 50; tries++) {
        // Half of flowers cluster around inhabitable roads/town, half across the island.
        const near = minHeight < 0.5 && tries % 2 === 0;
        const x = (rand() * 2 - 1) * (near ? 350 : HALF), z = (rand() * 2 - 1) * (near ? 350 : HALF);
        if (!canGrow(x, z, margin) || fbm(x * 0.024 + index * 9, z * 0.024) < 0.03) continue;
        points.push({ x, y: getIslandHeight(x, z) - 0.025, z, scale: (minHeight + rand() * (maxHeight - minHeight)) / height, yaw: rand() * Math.PI * 2 });
      }
      if (peak) highPoints.push(...points.map(p => ({ ...p, scale: p.scale * height })));
      else addBatches(parts, points, true, distance, false);
    });
    if (peak) peak.addGround(highPoints, minHeight < 0.5 ? "flowers" : "bush");
  };
  scatter(bushes, quality === "high" ? 550 : quality === "medium" ? 350 : 80, 0.55, 1.7, detailDistance + 110, 1.5);
  scatter(flowers, quality === "high" ? 1100 : quality === "medium" ? 700 : 140, 0.15, 0.4, quality === "high" ? 120 : 85, 0.3);

  const rockParts = await assets.load(`${ENV}/free_pack_rocks_stylized_gltf/scene.gltf`); check();
  const rockLists: Placement[][] = rockParts.map(() => []);
  const sizes = rockParts.map(p => {
    p.geo.computeBoundingBox();
    const box = p.geo.boundingBox ?? new THREE.Box3(new THREE.Vector3(), new THREE.Vector3(1, 1, 1));
    const centre = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3());
    p.geo.translate(-centre.x, -box.min.y, -centre.z);
    if (p.mat instanceof THREE.MeshStandardMaterial) {
      p.mat.roughness = 0.94; p.mat.metalness = 0;
      if (quality === "high" && peakMaterials) applyPeakSurface(p.mat, peakMaterials.surfaces.rock);
    }
    return Math.max(size.x, size.y, size.z, 0.1);
  });
  let rockCount = 0;
  const totalRocks = quality === "high" ? 1300 : quality === "medium" ? 850 : 220;
  for (let tries = 0; rockCount < totalRocks && tries < totalRocks * 35; tries++) {
    const x = (rand() * 2 - 1) * HALF, z = (rand() * 2 - 1) * HALF, y = getIslandHeight(x, z);
    if (y < -0.3 || sampleIslandWater(x, z) || layout.isReserved(x, z, 3) || skip?.(x, z)) continue;
    const rough = normalY(x, z) < 0.91, target = rough || y > 75 ? 3 + rand() * 12 : 0.5 + rand() * 2;
    if (!rough && y < 60 && rand() > 0.4) continue;
    const i = Math.floor(rand() * rockParts.length), scale = target / sizes[i];
    const p = { x, y: y - target * 0.2, z, scale, yaw: rand() * Math.PI * 2 }; rockLists[i].push(p);
    colliders.push({ id: `rock-${rockCount++}`, center: new THREE.Vector3(x, y + target * 0.23, z), size: new THREE.Vector3(target * 0.66, target * 0.7, target * 0.66), yaw: p.yaw, kind: "rock" });
  }
  rockLists.forEach((points, i) => addBatches([rockParts[i]], points, true, quality === "high" ? 1100 : 750, quality === "high"));
  assets.own(root);
  return {
    group: root, colliders, treeCount: allTrees.length, rockCount,
    peakEnabled: Boolean(peak),
    addPeakGround(points, kind) { peak?.addGround(points, kind); },
    update(camera, player) {
      peak?.update(camera, player);
      for (const batch of batches) {
        const distance = batch.detailed ? batch.centre.distanceTo(camera.position)
          : Math.hypot(batch.centre.x - camera.position.x, batch.centre.z - camera.position.z);
        const viewDistance = batch.centre.distanceTo(camera.position);
        batch.group.visible = distance < batch.far + 100 && (batch.detailed || viewDistance > detailDistance - 80);
        if (batch.detailed && batch.group.visible) for (const child of batch.group.children) {
          if (child instanceof THREE.Mesh) child.castShadow = quality !== "low" && batch.centre.distanceToSquared(player) < 150 * 150 && batch.shadow;
        }
      }
    },
    dispose() { peak?.dispose(); root.removeFromParent(); },
  };
}

/** Shared clock, explicitly exported here for procedurally authored decorative materials. */
export const natureTime = uTime;
