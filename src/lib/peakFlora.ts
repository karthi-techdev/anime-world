import * as THREE from "three";
import { uTime } from "./worldShared";
import type { Part } from "./worldShared";
import type { AssetLibrary } from "./islandFlora";

const BASE = "/assets/3d/environment/peak/foliage";
const HERO_LIMIT = 96, MID_LIMIT = 512;

/** Art dimensions only: never pass these back into gameplay placement or colliders. */
export interface PeakPlacement {
  x: number; y: number; z: number; scale: number; yaw: number;
}
export interface PeakFlora {
  group: THREE.Group;
  addTrees(points: PeakPlacement[]): void;
  addGround(points: PeakPlacement[], kind: "bush" | "flowers"): void;
  update(camera: THREE.Camera, player: THREE.Vector3): void;
  dispose(): void;
}

// Complementary, stable screen-door intervals. At every pixel precisely one LOD
// owns the interval; no transparent overlap, z-fighting, or double-dark shadows.
const DITHER = /* glsl */ `
float peakThreshold(vec2 p) {
  vec2 q = mod(floor(p), 4.0);
  float a = mod(q.x, 2.0) * 2.0 + mod(q.y, 2.0) * 3.0;
  a = mod(a, 4.0);
  vec2 r = floor(q / 2.0);
  float b = mod(r.x * 2.0 + r.y * 3.0, 4.0);
  return (a * 4.0 + b + 0.5) / 16.0;
}
`;
const COMMON_VERTEX = /* glsl */ `
uniform float peakTime, peakFlutter;
uniform vec3 peakCamera;
attribute vec2 peakRange;
varying vec2 vPeakRange;
vec4 peakWorld;
vec3 peakDeform(vec3 p, vec3 root) {
  float h = max(p.y - root.y, 0.0);
  // A slowly advecting gust, shared by trunks, leaves, shrubs, all LODs/shadows.
  float phase = dot(root.xz, vec2(0.013, 0.017));
  float gust = sin(peakTime * 0.82 + phase) * 0.65
             + sin(peakTime * 1.37 + phase * 0.7) * 0.35;
  p.xz += vec2(0.8, 0.6) * gust * 0.00075 * h * h;
  float anchor = smoothstep(0.0, 0.65, h);
  p.xyz += peakFlutter * anchor * vec3(
    sin(peakTime * 2.1 + phase + p.y * 2.2),
    sin(peakTime * 2.4 + phase + p.x * 1.4) * 0.35,
    sin(peakTime * 2.0 + phase + p.z * 1.7) * 0.6);
  return p;
}
`;
const PROJECT = /* glsl */ `
vec4 peakRoot = modelMatrix * instanceMatrix[3];
peakWorld = modelMatrix * instanceMatrix * vec4(transformed, 1.0);
peakWorld.xyz = peakDeform(peakWorld.xyz, peakRoot.xyz);
vPeakRange = peakRange;
vec4 mvPosition = viewMatrix * peakWorld;
gl_Position = projectionMatrix * mvPosition;
`;
const FAR_VERTEX = /* glsl */ `
attribute float peakKind;
varying vec4 vPeakView;
varying vec2 vPeakBlend;
`;
const FAR_PROJECT = /* glsl */ `
vec4 peakRoot = modelMatrix * instanceMatrix[3];
float peakHeight = length((modelMatrix * instanceMatrix)[1].xyz);
vec3 peakCentre = peakRoot.xyz + vec3(0.0, peakHeight * 0.5, 0.0);
vec3 peakLook = normalize(peakCamera - peakCentre);
vec3 peakRight = cross(vec3(0.0, 1.0, 0.0), peakLook);
if (dot(peakRight, peakRight) < 0.0001) peakRight = vec3(1.0, 0.0, 0.0);
peakRight = normalize(peakRight);
vec3 peakUp = normalize(cross(peakLook, peakRight));
peakWorld = vec4(peakCentre + peakHeight * (peakRight * transformed.x + peakUp * (transformed.y - 0.5)), 1.0);
peakWorld.xyz = peakDeform(peakWorld.xyz, peakRoot.xyz);
vec3 peakLocalLook = transpose(mat3(instanceMatrix)) * peakLook;
float peakAngle = mod(atan(peakLocalLook.x, peakLocalLook.z) / 6.28318530718 * 8.0 + 8.0, 8.0);
float peakPitch = clamp(asin(clamp(peakLook.y, 0.0, 1.0)) / 0.6108652382, 0.0, 2.0);
vPeakView = vec4(floor(peakAngle), mod(floor(peakAngle) + 1.0, 8.0), floor(peakPitch) + peakKind * 3.0, min(floor(peakPitch) + 1.0, 2.0) + peakKind * 3.0);
vPeakBlend = vec2(fract(peakAngle), fract(peakPitch));
vPeakRange = peakRange;
vec4 mvPosition = viewMatrix * peakWorld;
gl_Position = projectionMatrix * mvPosition;
`;
const FAR_MAP = /* glsl */ `
#ifdef USE_MAP
  // Dither between adjacent captures rather than alpha-blending four crowns.
  float viewNoise = peakThreshold(gl_FragCoord.xy + vec2(1.0, 2.0));
  float col = mix(vPeakView.x, vPeakView.y, step(viewNoise, vPeakBlend.x));
  float row = mix(vPeakView.z, vPeakView.w, step(peakThreshold(gl_FragCoord.yx + vec2(2.0, 1.0)), vPeakBlend.y));
  vec2 atlasUv = vec2((col * 128.0 + 1.0 + vMapUv.x * 126.0) / 1024.0,
                     (row * 192.0 + 1.0 + vMapUv.y * 190.0) / 2048.0);
  vec4 sampledDiffuseColor = texture2D(map, atlasUv);
  diffuseColor *= sampledDiffuseColor;
#endif
`;

/** Color, directional/spot depth and point-distance passes use identical code. */
function animate(material: THREE.Material, camera: { value: THREE.Vector3 }, flutter: number, far = false) {
  material.customProgramCacheKey = () => `peak-botanical-v3-${far ? "views" : "mesh"}-${flutter}`;
  material.onBeforeCompile = shader => {
    shader.uniforms.peakTime = uTime;
    shader.uniforms.peakCamera = camera;
    shader.uniforms.peakFlutter = { value: flutter };
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\n${COMMON_VERTEX}${far ? FAR_VERTEX : ""}`)
      .replace("#include <project_vertex>", far ? FAR_PROJECT : PROJECT)
      // Lighting/shadow receivers/point-light distance need the deformed world pos,
      // not Three's original undeformed instance transform.
      .replace("#include <worldpos_vertex>", "vec4 worldPosition = peakWorld;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\nvarying vec2 vPeakRange;\n${DITHER}${far ? "varying vec4 vPeakView; varying vec2 vPeakBlend;" : ""}`)
      .replace("#include <alphatest_fragment>", `#include <alphatest_fragment>\nfloat peakPixel = peakThreshold(gl_FragCoord.xy);\nif (peakPixel < vPeakRange.x || peakPixel >= vPeakRange.y) discard;`);
    if (far) shader.fragmentShader = shader.fragmentShader.replace("#include <map_fragment>", FAR_MAP);
  };
}

interface PoolPart {
  mesh: THREE.InstancedMesh;
  range: THREE.InstancedBufferAttribute;
  kind?: THREE.InstancedBufferAttribute;
}
interface Pool { parts: PoolPart[]; capacity: number }
interface Tree extends PeakPlacement { id: number; kind: number; hero: number; mid: number; distance: number }
interface Slot { tree: number; weight: number }

export async function createPeakFlora(assets: AssetLibrary, signal?: AbortSignal): Promise<PeakFlora> {
  const group = new THREE.Group(); group.name = "Peak High botanical foliage";
  const cameraUniform = { value: new THREE.Vector3() };
  const customMaterials = new Set<THREE.Material>();
  const trees: Tree[] = [], heroSlots: Slot[] = [], midSlots: Slot[] = [];
  const heroes: Pool[] = [], mids: Pool[] = [], grounds: { pool: Pool; points: PeakPlacement[]; kind: string }[] = [];
  let farPool: Pool | undefined, lastTime = -1, disposed = false;
  const names = ["oak-hero", "birch-hero", "pine-hero", "oak-mid", "birch-mid", "pine-mid", "tree-far", "bush", "flowers"];
  const parts = await Promise.all(names.map(name => assets.load(`${BASE}/${name}.gltf`)));
  if (signal?.aborted) throw new DOMException("Island loading cancelled", "AbortError");
  // Keep only two shared near/mid tree materials (one bark, one leaf), not per tree.
  const bark = parts[0][0].mat as THREE.MeshStandardMaterial;
  const leaves = parts[0][1].mat as THREE.MeshStandardMaterial;
  // Sparse fine leaf alpha needs a lower far cutoff so ordinary mipmaps retain
  // kilometre-scale canopy coverage instead of erasing the 1-3 pixel trees.
  const farMaterial = new THREE.MeshBasicMaterial({ map: (parts[6][0].mat as THREE.MeshStandardMaterial).map,
    alphaTest: 0.14, side: THREE.DoubleSide, fog: true });
  const setup = (mat: THREE.MeshStandardMaterial) => {
    mat.roughness = 0.94; mat.metalness = 0; mat.transparent = false; mat.depthWrite = true;
    const leafy = mat.alphaTest > 0;
    if (leafy) { mat.alphaTest = 0.38; mat.side = THREE.DoubleSide; mat.alphaToCoverage = false; }
    mat.vertexColors = true;
    // GLTFLoader correctly marks albedo sRGB and normal maps NoColorSpace.
    animate(mat, cameraUniform, leafy ? 0.025 : 0);
    return mat;
  };
  setup(bark); setup(leaves); animate(farMaterial, cameraUniform, 0, true);
  // Two shared standard materials serve trees and ground flora; the atlas also
  // contains flowers. Do not upload redundant per-glTF copies of these textures.
  const shadows = new Map<THREE.Material, { depth: THREE.MeshDepthMaterial; distance: THREE.MeshDistanceMaterial }>();
  const shadowPair = (mat: THREE.Material) => {
    const cached = shadows.get(mat); if (cached) return cached;
    const source = mat as THREE.MeshStandardMaterial;
    const parameters = { map: source.map, alphaTest: source.alphaTest, side: source.side };
    const depth = new THREE.MeshDepthMaterial({ ...parameters, depthPacking: THREE.RGBADepthPacking });
    const distance = new THREE.MeshDistanceMaterial(parameters);
    animate(depth, cameraUniform, source.alphaTest > 0 ? 0.025 : 0);
    animate(distance, cameraUniform, source.alphaTest > 0 ? 0.025 : 0);
    customMaterials.add(depth); customMaterials.add(distance);
    const pair = { depth, distance }; shadows.set(mat, pair); return pair;
  };
  const pool = (source: Part[], capacity: number, type: "tree" | "far" | "ground"): Pool => {
    const result: Pool = { parts: [], capacity };
    source.forEach((p, index) => {
      const geo = p.geo.clone();
      const range = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 2), 2).setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute("peakRange", range);
      const mat = type === "far" ? farMaterial : (index === 0 ? bark : leaves);
      const mesh = new THREE.InstancedMesh(geo, mat, capacity); mesh.count = 0;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.receiveShadow = type !== "far"; mesh.frustumCulled = true;
      let kind: THREE.InstancedBufferAttribute | undefined;
      if (type === "far") { kind = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1).setUsage(THREE.DynamicDrawUsage); geo.setAttribute("peakKind", kind); }
      else { const pair = shadowPair(mat); mesh.customDepthMaterial = pair.depth; mesh.customDistanceMaterial = pair.distance; }
      result.parts.push({ mesh, range, kind }); group.add(mesh);
    });
    return result;
  };
  for (let k = 0; k < 3; k++) { heroes.push(pool(parts[k], HERO_LIMIT, "tree")); mids.push(pool(parts[k + 3], MID_LIMIT, "tree")); }
  const transform = new THREE.Matrix4(), rotation = new THREE.Quaternion();
  const position = new THREE.Vector3(), scale = new THREE.Vector3();
  const put = (p: Pool, point: PeakPlacement, lo: number, hi: number, kind = 0) => {
    const i = p.parts[0].mesh.count;
    if (i >= p.capacity) throw new Error("Peak foliage pool budget exceeded");
    transform.compose(position.set(point.x, point.y, point.z), rotation.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, point.yaw), scale.setScalar(point.scale));
    for (const part of p.parts) {
      part.mesh.setMatrixAt(i, transform); part.range.setXY(i, lo, hi); part.kind?.setX(i, kind); part.mesh.count++;
    }
  };
  const flush = (p: Pool, cast: boolean) => {
    for (const part of p.parts) {
      part.mesh.instanceMatrix.needsUpdate = true; part.range.needsUpdate = true;
      if (part.kind) part.kind.needsUpdate = true;
      part.mesh.visible = part.mesh.count > 0; part.mesh.castShadow = cast;
      // InstancedMesh bounds are recomputed for the current packed instances.
      // 1m comfortably exceeds sway+flutter at original max 18m height (<0.28m).
      // Billboard bounding sphere encompasses every camera-facing/pitched view.
      part.mesh.computeBoundingSphere(); if (part.mesh.boundingSphere) part.mesh.boundingSphere.radius += 1;
    }
  };
  const reset = (p: Pool) => p.parts.forEach(part => { part.mesh.count = 0; });
  const eased = (a: number, b: number, d: number) => {
    const t = THREE.MathUtils.clamp((d-a)/(b-a), 0, 1); return 1-t*t*(3-2*t);
  };
  const tickSlots = (slots: Slot[], capacity: number, wanted: Tree[], tier: "hero" | "mid", dt: number) => {
    const selected = new Set(wanted.slice(0, capacity).map(t => t.id));
    for (const slot of slots) {
      const t = trees[slot.tree];
      const target = selected.has(slot.tree) ? (tier === "hero" ? eased(70, 90, t.distance) : eased(240, 300, t.distance)) : 0;
      slot.weight = THREE.MathUtils.clamp(slot.weight + THREE.MathUtils.clamp(target-slot.weight, -dt*3, dt*3), 0, 1);
      t[tier] = slot.weight;
    }
    for (let i = slots.length-1; i >= 0; i--) if (slots[i].weight <= 0 && !selected.has(slots[i].tree)) slots.splice(i, 1);
    const occupied = new Set(slots.map(slot => slot.tree));
    for (const index of selected) {
      if (slots.length >= capacity) break;
      if (occupied.has(index)) continue;
      const t = trees[index], target = tier === "hero" ? eased(70,90,t.distance) : eased(240,300,t.distance);
      const weight = Math.min(target, dt*3); slots.push({ tree: index, weight }); t[tier] = weight;
    }
  };
  [bark, leaves].forEach(shadowPair);
  const own = () => {
    assets.own(group);
    // The shared ownership API handles resources reachable as normal materials.
    // An invisible holder registers shadow materials too, including partial-build
    // cancellation before IslandNature is returned to the world owner.
    if (!customMaterials.size) return;
    const holder = new THREE.Mesh(parts[0][0].geo, Array.from(customMaterials));
    holder.visible = false; holder.name = "Peak shadow resource ownership"; group.add(holder);
    customMaterials.clear();
    assets.own(group);
  };
  own();
  return {
    group,
    addTrees(points) {
      if (disposed) throw new Error("Peak foliage disposed");
      points.forEach(p => {
        // Position hash affects art species only; gameplay placement stays fixed.
        const shape = Math.sin(p.x * 0.731 + p.z * 1.173) * 43758.5453;
        const choice = shape - Math.floor(shape);
        trees.push({ ...p, id: trees.length, kind: choice < 0.20 ? 2 : choice < 0.54 ? 1 : 0, hero: 0, mid: 0, distance: Infinity });
      });
      if (farPool) for (const part of farPool.parts) {
        part.mesh.removeFromParent(); part.mesh.geometry.dispose(); part.mesh.dispose();
      }
      farPool = pool(parts[6], Math.max(trees.length, 1), "far");
      trees.forEach(t => put(farPool!, t, 0, 1, t.kind)); flush(farPool, false); own();
    },
    addGround(points, kind) {
      if (disposed) throw new Error("Peak foliage disposed");
      const capacity = kind === "bush" ? 96 : 256;
      const batch = pool(parts[kind === "bush" ? 7 : 8], capacity, "ground");
      // Caller supplies original requested height, not scale relative to old art.
      grounds.push({ pool: batch, points, kind }); own();
    },
    update(camera, player) {
      if (disposed) return;
      camera.getWorldPosition(cameraUniform.value);
      const now = uTime.value, dt = lastTime < 0 ? 1 : THREE.MathUtils.clamp(now-lastTime, 0, 0.1); lastTime = now;
      if (dt === 0) return;
      if (farPool) {
        for (const t of trees) { t.distance = Math.hypot(t.x-cameraUniform.value.x,t.y+t.scale*.5-cameraUniform.value.y,t.z-cameraUniform.value.z); t.hero = 0; t.mid = 0; }
        const nearby = trees.filter(t => t.distance < 300).sort((a,b) => a.distance-b.distance);
        tickSlots(midSlots, MID_LIMIT, nearby, "mid", dt);
        tickSlots(heroSlots, HERO_LIMIT, nearby.filter(t => t.distance < 90), "hero", dt);
        heroes.forEach(reset); mids.forEach(reset); reset(farPool);
        for (const t of trees) {
          const split = t.hero + (1-t.hero)*t.mid;
          if (t.hero > 0) put(heroes[t.kind],t,0,t.hero);
          if (split > t.hero) put(mids[t.kind],t,t.hero,split);
          if (split < 1) put(farPool,t,split,1,t.kind);
        }
        // Only <=96 near hero trees cast; kilometre-scale coverage and middle
        // foliage never enter shadow passes. Both shadow pass types are installed.
        const local = (p: Pool) => p.parts[0].mesh.count > 0 && player.distanceTo(cameraUniform.value) < 160;
        heroes.forEach(p => flush(p, local(p))); mids.forEach(p => flush(p, false)); flush(farPool,false);
      }
      for (const ground of grounds) {
        reset(ground.pool);
        const end = ground.kind === "bush" ? 170 : 80, start = ground.kind === "bush" ? 130 : 60;
        const limit = ground.kind === "bush" ? 96 : 256;
        const close = ground.points.map(p => ({ p, d: Math.hypot(p.x-cameraUniform.value.x,p.y-cameraUniform.value.y,p.z-cameraUniform.value.z) }))
          .filter(p => p.d < end).sort((a,b) => a.d-b.d).slice(0,limit);
        for (const { p, d } of close) put(ground.pool,p,0,eased(start,end,d));
        flush(ground.pool,false);
      }
    },
    dispose() {
      if (disposed) return; disposed = true;
      // Assets own the ordinary geometries/materials/textures. Three's generic
      // traverse does not own custom shadow materials, so explicitly release them.
      for (const material of customMaterials) material.dispose(); customMaterials.clear();
      group.traverse(o => { if (o instanceof THREE.InstancedMesh) o.dispose(); }); group.removeFromParent();
    },
  };
}
