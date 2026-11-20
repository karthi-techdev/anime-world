import { createYardTest, createHouseDistance } from "./lawnMask";
import { HOUSE_FOOTPRINTS } from "./islandHouses";
import * as THREE from "three";
import { ENV, NATURE, fbm, instance, rng, windify } from "./worldShared";
import type { Part } from "./worldShared";
import { getIslandHeight, grassMask, sampleIslandWater } from "./islandTerrain";
import type { IslandLayout } from "./islandLayout";
import type { AssetLibrary, IslandNature } from "./islandFlora";
import type { PeakMaterials } from "./peakMaterials";
import { applyPeakSurface } from "./peakMaterials";
import type { WorldCollider } from "./worldTypes";

/**
 * Meadow flora around the spawn, styled after the reference art: lush broadleaf / umbrella / pine /
 * cypress trees (procedural, thick trunks), tan boulders and blue mossy stones, bushes and
 * many small wildflowers. Everything sways in the wind. The generic island nature skips this zone.
 */
export const LEGACY = { x: 10, z: 0, radius: 300 };
export const inLegacyZone = (x: number, z: number) => Math.hypot(x - LEGACY.x, z - LEGACY.z) < LEGACY.radius;

export interface LegacyFlora {
  group: THREE.Group;
  colliders: WorldCollider[];
  treeCount: number;
  rockCount: number;
  dispose(): void;
}

const normalY = (x: number, z: number) => {
  const e = 3;
  return 6 / Math.hypot(getIslandHeight(x - e, z) - getIslandHeight(x + e, z), 6, getIslandHeight(x, z - e) - getIslandHeight(x, z + e));
};

function foliage(mat: THREE.Material) {
  const m = mat as THREE.MeshStandardMaterial;
  m.transparent = false;
  m.alphaTest = 0.4;
  m.alphaToCoverage = true;
  m.depthWrite = true;
  m.side = THREE.DoubleSide;
  m.roughness = 1;
  m.metalness = 0;
}

function geoCenter(g: THREE.BufferGeometry) {
  g.computeBoundingBox();
  return g.boundingBox!.getCenter(new THREE.Vector3());
}

const mat4 = (x: number, z: number, s: number, ry: number, sink = 0, tilt = 0) =>
  new THREE.Matrix4().compose(
    new THREE.Vector3(x, getIslandHeight(x, z) - sink, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(tilt, ry, tilt * 0.6)),
    new THREE.Vector3(s, s, s),
  );

/** Stone with moss growing on up-facing surfaces (blue-grey mossy stones / tan boulders). */
function mossyRock(source: THREE.Material, tint: number, moss: number, mossColour: THREE.Color) {
  const m = (source as THREE.MeshStandardMaterial).clone();
  m.color.set(tint); m.roughness = 0.93; m.metalness = 0;
  m.customProgramCacheKey = () => "rock-moss";
  m.onBeforeCompile = sh => {
    sh.uniforms.uMoss = { value: moss };
    sh.uniforms.uMossColour = { value: mossColour };
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vRockN; varying vec3 vRockP;")
      .replace("#include <beginnormal_vertex>", `#include <beginnormal_vertex>
        vRockN = objectNormal;
        #ifdef USE_INSTANCING
          vRockN = mat3(instanceMatrix) * objectNormal;
        #endif
        vRockN = normalize(mat3(modelMatrix) * vRockN);`)
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvRockP = position;");
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vRockN; varying vec3 vRockP; uniform float uMoss; uniform vec3 uMossColour;")
      .replace("#include <map_fragment>", `#include <map_fragment>
        float mossNoise = sin(vRockP.x * 6.3 + sin(vRockP.z * 4.1) * 2.1) * sin(vRockP.y * 5.2 + vRockP.x * 2.7) * .5 + .5;
        float mossK = smoothstep(.38, .7, vRockN.y + (mossNoise - .5) * .5) * uMoss;
        diffuseColor.rgb = mix(diffuseColor.rgb, uMossColour * (.8 + .4 * mossNoise), mossK);`);
  };
  return m;
}

export async function buildLegacyFlora(
  assets: AssetLibrary, layout: IslandLayout, quality: "low" | "medium" | "high", signal?: AbortSignal,
  peak?: IslandNature, peakMaterials?: PeakMaterials,
): Promise<LegacyFlora> {
  const group = new THREE.Group();
  group.name = "Meadow trees, bushes, flowers and rocks";
  const colliders: WorldCollider[] = [];
  const check = () => { if (signal?.aborted) throw new DOMException("Island loading cancelled", "AbortError"); };
  const k = quality === "high" ? 1 : quality === "medium" ? 0.75 : 0.3; // density per quality
  const cast = quality !== "low";
  const rand = rng(42);
  // In-memory material clone reuses cached geometry without duplicate HTTP downloads of 20+ glTFs and heavy textures.
  const load = async (url: string) => {
    const parts = await assets.load(url);
    return parts.map(p => ({ geo: p.geo, mat: p.mat.clone() }));
  };
  const dry = (x: number, z: number) => getIslandHeight(x, z) > 1.4 && !sampleIslandWater(x, z);
  const free = (x: number, z: number, pad: number) => !layout.isReserved(x, z, pad);
  const green = (x: number, z: number) => grassMask(x, z) > 0.4;

  /** Rejection-samples ground points in a ring around the spawn. */
  const pick = (n: number, rMin: number, rMax: number, ok: (x: number, z: number) => boolean) => {
    const out: [number, number][] = [];
    const count = Math.round(n * k);
    for (let t = 0; out.length < count && t < count * 60; t++) {
      const r = rMin + (rMax - rMin) * Math.sqrt(rand()), a = rand() * Math.PI * 2;
      const x = LEGACY.x + Math.cos(a) * r, z = LEGACY.z + Math.sin(a) * r;
      if (ok(x, z)) out.push([x, z]);
    }
    return out;
  };

  const [bushes, flowers] = await Promise.all([
    Promise.all(["Bush", "Bush_Large", "Bush_Small", "Bush_Flowers", "Bush_Large_Flowers"].map(n => load(`${NATURE}/${n}.gltf`))),
    Promise.all(["Flower_1_Clump", "Flower_2_Clump", "Flower_3_Clump", "Flower_4_Clump", "Flower_5_Clump"].map(n => load(`${NATURE}/${n}.gltf`))),
  ]);
  check();

  let treeCount = 0, rockCount = 0;
  const treeCol = (x: number, z: number, h: number) => colliders.push({
    id: `legacy-tree-${treeCount++}`, center: new THREE.Vector3(x, getIslandHeight(x, z) + h * 0.3, z),
    size: new THREE.Vector3(Math.max(0.5, h * 0.06), h * 0.6, Math.max(0.5, h * 0.06)), yaw: 0, kind: "tree",
  });

  // ------------------------------------------------------------ trees: original birch / maple / hero tree assets
  const isLeaf = (p: Part) => /leaves|leaf/i.test(p.mat.name);
  const names = (base: string) => Array.from({ length: 5 }, (_, i) => `${NATURE}/${base}_${i + 1}.gltf`);
  const [birch, maple, hero] = await Promise.all([
    Promise.all(names("BirchTree").map(load)),
    Promise.all(names("MapleTree").map(load)),
    load(`${ENV}/stylized_tree.glb`),
  ]);
  check();
  const treeOk = (pad: number) => (x: number, z: number) =>
    dry(x, z) && free(x, z, pad) && normalY(x, z) > 0.8 && fbm(x * 0.018, z * 0.018) > -0.05;

  const heroBarkTex = new THREE.TextureLoader().load(`${ENV}/stylized_tree_bark.jpg`);
  heroBarkTex.colorSpace = THREE.SRGBColorSpace;
  heroBarkTex.wrapS = THREE.RepeatWrapping;
  heroBarkTex.wrapT = THREE.RepeatWrapping;

  for (const p of hero) {
    p.geo.deleteAttribute("color");
    const isLeaves = isLeaf(p) || /leaves/i.test(p.mat.name) || (p.mat as THREE.MeshStandardMaterial).alphaTest > 0;
    if (isLeaves) {
      const m = p.mat as THREE.MeshStandardMaterial;
      m.vertexColors = false;
      m.color.set(0xffffff);
      m.emissive?.set(0x000000);
      foliage(m);
      windify(m, { bend: 0.0025, flutter: 0.04, puff: geoCenter(p.geo) });
    } else {
      const m = p.mat as THREE.MeshStandardMaterial;
      const bTex = m.map || heroBarkTex;
      if (bTex) {
        bTex.wrapS = THREE.RepeatWrapping;
        bTex.wrapT = THREE.RepeatWrapping;
      }
      const trunkMat = new THREE.MeshStandardMaterial({
        map: bTex,
        roughness: 0.92,
        metalness: 0.0,
        color: new THREE.Color(0x4a3728),
        emissive: new THREE.Color(0x000000),
      });
      p.mat = trunkMat;
      windify(p.mat, { bend: 0.0025, flutter: 0 });
    }
  }
  const houseDist = createHouseDistance(layout);
  // crown reach from the trunk at scale 1 (m), measured from the GLB bounds
  const BIRCH_RV = [1.8, 2.3, 2.2, 1.7, 2.6], MAPLE_RV = [4.9, 5.5, 6.0, 2.1, 4.4], HERO_RV = 3.8;
  /** Largest scale (<= want) whose crown stays 0.8 m clear of every house roof; 0 = does not fit. */
  const fit = (x: number, z: number, rv: number, want: number, minS: number) => {
    const maxS = (houseDist(x, z) - 0.8) / rv;
    return maxS < minS ? 0 : Math.min(want, maxS);
  };
  const heroSpots: [number, number, number][] = [
    [9, -6, 1.7], [-11, 3, 1.4], [-38, -24, 1.9], [15, -32, 1.6], [-9, -38, 1.5], [22, 14, 1.8], [-20, 26, 1.6],
  ];
  const heroMats: THREE.Matrix4[] = [];
  heroSpots.filter(([x, z]) => dry(x, z) && free(x, z, 9)).forEach(([x, z, s0]) => {
    const s = fit(x, z, HERO_RV, s0, 0.8);
    if (s) { heroMats.push(mat4(x, z, s, rand() * 6.28, 0.1)); treeCol(x, z, 7 * s); }
  });
  pick(70, 30, 290, treeOk(8)).forEach(([x, z]) => {
    const s = fit(x, z, HERO_RV, 1.3 + rand() * 0.9, 0.8);
    if (!s) return;
    heroMats.push(mat4(x, z, s, rand() * 6.28, 0.1)); treeCol(x, z, 7 * s);
  });
    instance(group, hero, heroMats, { cast });


  type TreeItem = { x: number; z: number; v: number; s: number };
  const scatterTrees = (variants: Part[][], rvs: number[], total: number, sMin: number, sMax: number, yellow: number, seedOff: number, given?: TreeItem[], rnd: () => number = rand) => {
    if (!given) variants.forEach(v => v.forEach(p => {
      if (isLeaf(p)) { foliage(p.mat); windify(p.mat, { bend: 0.003, flutter: 0.035, puff: geoCenter(p.geo) }); }
      else windify(p.mat, { bend: 0.003, flutter: 0 });
    }));
    const items: TreeItem[] = given ?? pick(total, 16, 270, (x, z) => treeOk(7)(x, z) && fbm(x * 0.018 + seedOff, z * 0.018) > -0.05)
      .map(([x, z], i) => {
        const v = i % variants.length;
        return { x, z, v, s: fit(x, z, rvs[v], sMin + rnd() * (sMax - sMin), sMin * 0.55) };
      }).filter(it => it.s > 0);
    variants.forEach((v, vi) => {
      const mine = items.filter(it => it.v === vi);
      const colors = mine.map(() =>
        (() => { const c = rnd(); return c < yellow ? new THREE.Color(2.3, 1.75, 0.25) : c < yellow + 0.12 ? new THREE.Color(2.4, 0.8, 1.5) : c < yellow + 0.2 ? new THREE.Color(2.3, 0.85, 0.2) : null; })() ?? new THREE.Color().setHSL(0.27 + rnd() * 0.06, 0.5, 0.5).multiplyScalar(2));
      const transforms = mine.map(it => {
        treeCol(it.x, it.z, 6 * it.s);
        return mat4(it.x, it.z, it.s, rnd() * 6.28, 0.1);
      });
      instance(group, v, transforms, { colors, tintPart: isLeaf, cast });
    });
  };
  scatterTrees(birch, BIRCH_RV, 260, 1.7, 2.7, 0.2, 0);
  scatterTrees(maple, MAPLE_RV, 200, 1.4, 2.2, 0.1, 40);

  // ------------------------------------------------------------ yard trees: random per house; the WHOLE crown must clear walls, roofs, roads, door paths and other crowns
  {
    const rr = rng(9001), yardFree = createYardTest(layout, { road: 2, house: 0.8, stoop: 4.8 });
    const crownOf = (v: Part[]) => {
      let r = 0;
      for (const p of v) {
        if (!isLeaf(p) && !(p.mat as THREE.MeshStandardMaterial).alphaTest) continue;
        p.geo.computeBoundingBox(); const b = p.geo.boundingBox!;
        r = Math.max(r, Math.abs(b.min.x), Math.abs(b.max.x), Math.abs(b.min.z), Math.abs(b.max.z));
      }
      return r || 3;
    };
    const kinds = [
      { v: birch, r: birch.map(crownOf), smin: 1.1, smax: 1.7, yellow: 0.2 },
      { v: maple, r: maple.map(crownOf), smin: 1.0, smax: 1.6, yellow: 0.1 },
    ];
    const heroR = crownOf(hero);
    interface Yard { x: number; z: number; r: number; s: number; kind: number; vi: number }
    const placed: Yard[] = [];
    for (const sp of layout.spots) {
      const fp = HOUSE_FOOTPRINTS[sp.family ?? "japanese"] ?? HOUSE_FOOTPRINTS.japanese;
      const want = Math.max(1, Math.round((4 + rr() * 4) * k));
      let got = 0;
      for (let t = 0; got < want && t < 220; t++) {
        const kind = rr() < 1 / 6 ? 2 : rr() < 0.5 ? 0 : 1;
        const vi = kind === 2 ? 0 : Math.floor(rr() * 5) % kinds[kind].v.length;
        const s = kind === 2 ? 1.0 + rr() * 0.5 : kinds[kind].smin + rr() * (kinds[kind].smax - kinds[kind].smin);
        const crown = (kind === 2 ? heroR : kinds[kind].r[vi]) * s;
        const rad = Math.max(fp.width, fp.depth) / 2 + 1.5 + rr() * 16, a = rr() * Math.PI * 2;
        const x = sp.x + Math.cos(a) * rad, z = sp.z + Math.sin(a) * rad;
        if (!dry(x, z) || normalY(x, z) < 0.85 || !yardFree(x, z, crown)) continue;
        if (placed.some(p => Math.hypot(p.x - x, p.z - z) < Math.max(2.6, (p.r + crown) * 0.42))) continue;
        placed.push({ x, z, r: crown, s, kind, vi }); got++;
      }
    }
    // park trees: meadows around the plaza fountain
    {
      const parkFree = createYardTest(layout, { road: 2.5, house: 1.5, stoop: 5, plaza: 27 });
      for (let t = 0, got = 0; got < 70 && t < 1500; t++) {
        const kind = rr() < 0.15 ? 2 : rr() < 0.5 ? 0 : 1;
        const vi = kind === 2 ? 0 : Math.floor(rr() * 5) % kinds[kind].v.length;
        const s = kind === 2 ? 1.1 + rr() * 0.5 : kinds[kind].smin + 0.2 + rr() * (kinds[kind].smax - kinds[kind].smin);
        const crown = (kind === 2 ? heroR : kinds[kind].r[vi]) * s;
        const rad = 28 + rr() * 55, a = rr() * Math.PI * 2;
        const x = Math.cos(a) * rad, z = Math.sin(a) * rad;
        if (!dry(x, z) || normalY(x, z) < 0.85 || !parkFree(x, z, crown)) continue;
        if (placed.some(p => Math.hypot(p.x - x, p.z - z) < Math.max(4.5, (p.r + crown) * 0.6))) continue;
        placed.push({ x, z, r: crown, s, kind, vi }); got++;
      }
    }
    const tint = (yellow: number) => {
      const c = rr();
      return c < yellow ? new THREE.Color(2.3, 1.75, 0.25) : c < yellow + 0.12 ? new THREE.Color(2.4, 0.8, 1.5) : c < yellow + 0.2 ? new THREE.Color(2.3, 0.85, 0.2)
        : new THREE.Color().setHSL(0.27 + rr() * 0.06, 0.5, 0.5).multiplyScalar(2);
    };
    const heroYard = placed.filter(p => p.kind === 2);
    const heroYardMats = heroYard.map(p => { treeCol(p.x, p.z, 7 * p.s); return mat4(p.x, p.z, p.s, rr() * 6.28, 0.1); });
    instance(group, hero, heroYardMats, { cast });
    kinds.forEach((kd, ki) => kd.v.forEach((v, vi) => {
      const mine = placed.filter(p => p.kind === ki && p.vi === vi);
      if (!mine.length) return;
      const transforms = mine.map(p => { treeCol(p.x, p.z, 6 * p.s); return mat4(p.x, p.z, p.s, rr() * 6.28, 0.1); });
      instance(group, v, transforms, { colors: mine.map(() => tint(kd.yellow)), tintPart: isLeaf, cast });
    }));
  }
  // ------------------------------------------------------------ bushes & flowers
  const peakBushes: { x: number; y: number; z: number; scale: number; yaw: number }[] = [];
  const peakFlowers: { x: number; y: number; z: number; scale: number; yaw: number }[] = [];
  bushes.forEach((b, bi) => {
    b.forEach(p => { foliage(p.mat); windify(p.mat, { bend: 0.012, flutter: 0.02, puff: geoCenter(p.geo) }); });
    const bp = pick(70, 6, 190, (x, z) => dry(x, z) && free(x, z, 1.5) && green(x, z) && normalY(x, z) > 0.8);
    const transforms = bp.map(([x, z]) => {
      const scale = (bi % 3 === 2 ? 1.6 : 1.1) + rand() * 1.1, yaw = rand() * 6.28;
      if (quality === "high" && peak?.peakEnabled) peakBushes.push({ x, y: getIslandHeight(x, z) - 0.1, z, scale: 1.5 * scale, yaw });
      return mat4(x, z, scale, yaw, 0.1);
    });
    if (quality !== "high" || !peak?.peakEnabled) instance(group, b, transforms, { cast });
  });

  // wildflowers scattered through the grass (many small clumps, pink / white / yellow)
  flowers.forEach((f, fi) => {
    f.forEach(p => { foliage(p.mat); windify(p.mat, { bend: 0.25, flutter: 0.01 }); });
    const fp = pick(420, 3, 110, (x, z) =>
      dry(x, z) && free(x, z, 0.6) && green(x, z) && normalY(x, z) > 0.85 && fbm(x * 0.05 + fi * 9, z * 0.05) > -0.05);
    const transforms = fp.map(([x, z]) => {
      const scale = 0.8 + rand() * 0.9, yaw = rand() * 6.28;
      if (quality === "high" && peak?.peakEnabled) peakFlowers.push({ x, y: getIslandHeight(x, z) - 0.025, z, scale: 0.35 * scale, yaw });
      return mat4(x, z, scale, yaw);
    });
    if (quality !== "high" || !peak?.peakEnabled) instance(group, f, transforms, { cast: false });
  });
  if (peakBushes.length && peak?.peakEnabled) peak.addPeakGround?.(peakBushes, "bush");
  if (peakFlowers.length && peak?.peakEnabled) peak.addPeakGround?.(peakFlowers, "flowers");

  // ------------------------------------------------------------ rocks
  const rockGltf = await load(`${ENV}/free_pack_rocks_stylized_gltf/scene.gltf`);
  check();
  const tanMoss = new THREE.Color(0.28, 0.5, 0.14), blueMoss = new THREE.Color(0.22, 0.52, 0.2);
  const rocks = rockGltf.map(p => {
    p.geo.computeBoundingBox();
    const b = p.geo.boundingBox!, c = b.getCenter(new THREE.Vector3()), size = b.getSize(new THREE.Vector3());
    p.geo.translate(-c.x, -b.min.y, -c.z);
    // two looks per rock model: tan boulders (open hillside) and blue-grey mossy stones (damp patches)
    const rm = p.mat as THREE.MeshStandardMaterial; rm.roughness = 0.95; rm.metalness = 0;
    if (quality === "high" && peakMaterials) applyPeakSurface(rm, peakMaterials.surfaces.rock);
    const tan = quality === "high"
      ? { geo: p.geo, mat: mossyRock(rm, 0xb5a78b, 0.14, tanMoss) }
      : { geo: p.geo, mat: rm };
    const blue = quality === "high"
      ? { geo: p.geo, mat: mossyRock(rm, 0x727e83, 0.32, blueMoss) }
      : tan;
    return { tan, blue, size: Math.max(size.x, size.y, size.z, 0.1) };
  });
  const tanLists: THREE.Matrix4[][] = rocks.map(() => []), blueLists: THREE.Matrix4[][] = rocks.map(() => []);
  const addRock = (x: number, z: number, target: number, sinkK: number) => {
    const i = Math.floor(rand() * rocks.length), s = target / rocks[i].size, yaw = rand() * 6.28;
    const bluish = fbm(x * 0.02 + 11, z * 0.02) > 0.1;
    (bluish ? blueLists : tanLists)[i].push(mat4(x, z, s, yaw, target * sinkK, (rand() - 0.5) * 0.3));
    if (target > 1.2) {
      colliders.push({
        id: `legacy-rock-${rockCount}`, center: new THREE.Vector3(x, getIslandHeight(x, z) + target * 0.23, z),
        size: new THREE.Vector3(target * 0.66, target * 0.7, target * 0.66), yaw, kind: "rock",
      });
    }
    rockCount++;
  };
  pick(140, 5, 160, (x, z) => !sampleIslandWater(x, z) && getIslandHeight(x, z) > -0.3 && free(x, z, 1.5))
    .forEach(([x, z]) => addRock(x, z, 0.6 + rand() * 2.2, 0.15));
  // big standing stones and cliff outcrops where the ground is steep
  pick(46, 40, 290, (x, z) => dry(x, z) && free(x, z, 6) && normalY(x, z) < 0.92)
    .forEach(([x, z]) => addRock(x, z, 7 + rand() * 16, 0.28));
  rocks.forEach((r, i) => {
    instance(group, [r.tan], tanLists[i], { cast });
    instance(group, [r.blue], blueLists[i], { cast });
  });

  assets.own(group);
  return { group, colliders, treeCount, rockCount, dispose() { group.removeFromParent(); } };
}
