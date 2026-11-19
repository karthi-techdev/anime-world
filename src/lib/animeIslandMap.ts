import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

const BASE_STREET = "/assets/3d/environment/JapanStreetModularPackLite_glTF/JapanStreetModularPackLite/glTF";
const BASE_NATURE = "/assets/3d/environment/trees_grass_rocks/glTF";
const STONES_GLB = "/assets/3d/environment/Anime_stones.glb";
const STYLIZED_TREE = "/assets/3d/environment/stylized_tree.glb";
const CLOVER_GRASS = "/assets/3d/environment/low_poly_stylized_clover_grass.glb";
const BUSH_FLOWERS_GLB = "/assets/3d/environment/bush_flowers.glb";
const CLOVER_GLB = "/assets/3d/environment/clover.glb";
const GROUND_GRASS_TEXTURE = "/assets/3d/environment/Grounds%201-100/Ground%20(70).png";
const GROUND_DIRT_TEXTURE = "/assets/3d/environment/Grounds%201-100/Ground%20(23).png";

export const ISLAND_RADIUS = 1100; // 2.2km Island in 6km Ocean

// Winding nature trail center line function (starts at x=0 when z=0)
export function getTrailX(z: number): number {
  if (z >= 55) {
    // Approaches town along center
    return 0;
  }
  const t = Math.max(0, (z - 35) / 20); // smoothly blends into 0 as it approaches town
  const rawX = Math.sin(z * 0.035) * 11 + Math.sin(z * 0.018) * 7;
  return rawX * (1 - t);
}

// Island Heightmap function matching Ghibli / Genshin / Shinkai reference images
export function getIslandHeight(x: number, z: number): number {
  const dist = Math.sqrt(x * x + z * z);

  // Beyond island shoreline slopes into ocean
  if (dist > ISLAND_RADIUS) {
    const falloff = (dist - ISLAND_RADIUS) / 300;
    return Math.max(-6, -falloff * 8);
  }

  // Shoreline beach transition (0 to 1.5m)
  if (dist > ISLAND_RADIUS - 80) {
    const tBeach = (ISLAND_RADIUS - dist) / 80;
    return tBeach * 1.5;
  }

  // 1. Mountain Lake / Pond depression (like Image 3!)
  const lakeDist = Math.sqrt(Math.pow(x - 42, 2) + Math.pow(z + 38, 2));
  if (lakeDist < 26) {
    // Calm mountain pond basin
    return 1.4 + Math.pow(lakeDist / 26, 2) * 1.2;
  }

  // 2. Hillside Japanese Seaside Town (like Image 4!)
  if (z >= 60 && z <= 240 && Math.abs(x) <= 160) {
    const townT = (z - 60) / 180;
    // Slopes down towards the ocean harbor
    return 2.8 - townT * 2.0;
  }

  // 3. Nature Trail Corridor (Hero Zone)
  const trailX = getTrailX(z);
  const distToTrail = Math.abs(x - trailX);

  // Trail gentle elevation slope from highland woods down to town
  const trailBaseY = 2.8 - z * 0.04;

  if (distToTrail < 3.8 && z < 60) {
    // Flat, smooth earth trail
    return Math.max(1.8, trailBaseY);
  }

  // 4. Rolling Grassy Highlands & Scenic Mountain Bluffs (like Images 1 & 3!)
  const nx = x * 0.8 - z * 0.6;
  const nz = x * 0.6 + z * 0.8;

  const rollingHills = Math.sin(nx * 0.005 + 0.4) * Math.cos(nz * 0.006 + 1.1) * 12
                     + Math.sin(nz * 0.01 + nx * 0.008) * 6;

  // Mountain rise on perimeter
  const tPerim = Math.min(dist / (ISLAND_RADIUS - 120), 1.0);
  const mountainBluffs = Math.pow(tPerim, 2.5) * 44;

  // Smooth blending from trail out into rolling meadows
  const trailBlend = Math.min(Math.max((distToTrail - 3.8) / 12, 0), 1.0);

  return Math.max(1.8, trailBaseY + (rollingHills + mountainBluffs) * trailBlend);
}

interface InstanceTransform {
  pos: THREE.Vector3;
  rot?: THREE.Euler;
  scale?: THREE.Vector3;
}

// Efficient InstancedMesh creation
function createInstancedMeshes(
  root: THREE.Object3D,
  transforms: InstanceTransform[],
  castShadow = false,
  receiveShadow = true
): THREE.Group {
  const group = new THREE.Group();
  const dummy = new THREE.Object3D();
  const count = transforms.length;
  if (count === 0) return group;

  root.updateMatrixWorld(true);

  root.traverse((child) => {
    if ((child as THREE.Mesh).isMesh) {
      const mesh = child as THREE.Mesh;
      const localMatrix = mesh.matrixWorld.clone();

      if (mesh.material) {
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        mats.forEach((m) => {
          m.depthWrite = true;
          if ("alphaTest" in m && (m as THREE.MeshStandardMaterial).alphaTest === 0) {
            (m as THREE.MeshStandardMaterial).alphaTest = 0.35;
          }
        });
      }

      const inst = new THREE.InstancedMesh(mesh.geometry, mesh.material, count);
      inst.castShadow = castShadow;
      inst.receiveShadow = receiveShadow;

      for (let i = 0; i < count; i++) {
        const t = transforms[i];
        dummy.position.copy(t.pos);
        if (t.rot) dummy.rotation.copy(t.rot);
        else dummy.rotation.set(0, 0, 0);
        if (t.scale) dummy.scale.copy(t.scale);
        else dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();

        const finalMatrix = dummy.matrix.clone().multiply(localMatrix);
        inst.setMatrixAt(i, finalMatrix);
      }
      inst.instanceMatrix.needsUpdate = true;
      group.add(inst);
    }
  });

  return group;
}

export async function createAnimeIslandMap(
  scene: THREE.Scene,
  onProgress?: (text: string) => void
): Promise<THREE.Group> {
  const mapGroup = new THREE.Group();
  mapGroup.name = "AnimeIslandScene";
  scene.add(mapGroup);

  const gltfLoader = new GLTFLoader();
  const texLoader = new THREE.TextureLoader();

  // Model caching helper
  const modelCache = new Map<string, THREE.Group>();
  async function loadModel(path: string): Promise<THREE.Group | null> {
    if (modelCache.has(path)) return modelCache.get(path)!;
    try {
      const gltf = await gltfLoader.loadAsync(path);
      const root = gltf.scene;
      root.traverse((child) => {
        if ((child as THREE.Mesh).isMesh) {
          const mesh = child as THREE.Mesh;
          mesh.castShadow = false;
          mesh.receiveShadow = true;
          if (mesh.material) {
            const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
            mats.forEach((m) => {
              m.side = THREE.DoubleSide;
              if ("roughness" in m) {
                (m as THREE.MeshStandardMaterial).roughness = Math.max(
                  (m as THREE.MeshStandardMaterial).roughness ?? 0.6,
                  0.35
                );
              }
            });
          }
        }
      });

      // Fix low_poly_stylized_clover_grass: use crisp green clover texture with full alpha cutout
      if (path.includes("low_poly_stylized_clover_grass")) {
        const cloverTex = await texLoader.loadAsync("/assets/3d/environment/clover_green.png");
        cloverTex.colorSpace = THREE.SRGBColorSpace;
        root.traverse((child) => {
          if ((child as THREE.Mesh).isMesh) {
            const mesh = child as THREE.Mesh;
            const mat = new THREE.MeshStandardMaterial({
              map: cloverTex,
              transparent: true,
              alphaTest: 0.45,
              roughness: 0.65,
              metalness: 0.05,
              side: THREE.DoubleSide,
            });
            mesh.material = mat;
          }
        });
      }

      // Fix stylized_tree: baseColorFactor was [0,0,0,1] in GLB, making foliage black; restore to full color
      if (path.includes("stylized_tree")) {
        root.traverse((child) => {
          if ((child as THREE.Mesh).isMesh) {
            const mesh = child as THREE.Mesh;
            if (mesh.material) {
              const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
              mats.forEach((m) => {
                const mat = m as THREE.MeshStandardMaterial;
                mat.color.setHex(0xffffff);
                mat.emissive.setHex(0x000000);
                mat.roughness = 0.75;
                mat.metalness = 0.05;
                mat.side = THREE.DoubleSide;
                mat.needsUpdate = true;
              });
            }
          }
        });
      }
      modelCache.set(path, root);
      return root;
    } catch (e) {
      console.warn("Failed loading model:", path, e);
      return null;
    }
  }

  onProgress?.("Generating Ghibli/Genshin Island Heightmap & Textures...");

  // =========================================================================
  // 1. DUAL GROUND TEXTURES: LUSH GRASS + SUNLIT DIRT PATH
  // =========================================================================
  const grassTex = await texLoader.loadAsync(GROUND_GRASS_TEXTURE);
  grassTex.wrapS = THREE.RepeatWrapping;
  grassTex.wrapT = THREE.RepeatWrapping;
  grassTex.repeat.set(80, 80);
  grassTex.colorSpace = THREE.SRGBColorSpace;
  grassTex.anisotropy = 8;

  const dirtTex = await texLoader.loadAsync(GROUND_DIRT_TEXTURE);
  dirtTex.wrapS = THREE.RepeatWrapping;
  dirtTex.wrapT = THREE.RepeatWrapping;
  dirtTex.repeat.set(120, 120);
  dirtTex.colorSpace = THREE.SRGBColorSpace;
  dirtTex.anisotropy = 8;

  // Island Terrain Mesh
  const segments = 120;
  const terrainGeo = new THREE.PlaneGeometry(2800, 2800, segments, segments);
  terrainGeo.rotateX(-Math.PI / 2);

  const posAttr = terrainGeo.attributes.position;
  const colors: number[] = [];
  const trailColor = new THREE.Color(0xd6a35d); // Sun-baked golden dirt trail (Image 1 & 2)
  const grassBright = new THREE.Color(0x86ce5e); // Vibrant anime meadow grass
  const grassDeep = new THREE.Color(0x529944); // Deep forest green
  const rockGrey = new THREE.Color(0x90a4ae); // Mountain peak stone

  for (let i = 0; i < posAttr.count; i++) {
    const x = posAttr.getX(i);
    const z = posAttr.getZ(i);
    const y = getIslandHeight(x, z);
    posAttr.setY(i, y);

    const dist = Math.sqrt(x * x + z * z);
    const trailX = getTrailX(z);
    const distToTrail = Math.abs(x - trailX);
    const col = new THREE.Color();

    if (distToTrail < 3.4 && z < 60) {
      // On the dirt path
      col.copy(trailColor);
    } else if (distToTrail < 6.0 && z < 60) {
      // Path border transition
      const alpha = (distToTrail - 3.4) / 2.6;
      col.copy(trailColor).lerp(grassBright, alpha);
    } else if (z >= 60 && z <= 240 && Math.abs(x) <= 160) {
      // Town streets and plazas
      col.setHex(0x3e4754);
    } else {
      // Grassy rolling hills into rocky peaks
      const tPeak = Math.max(0, Math.min((dist - 750) / 450, 1.0));
      col.copy(grassBright).lerp(grassDeep, 0.35).lerp(rockGrey, tPeak);
    }
    colors.push(col.r, col.g, col.b);
  }

  terrainGeo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  terrainGeo.computeVertexNormals();

  // Custom Shader blending Grass & Dirt Path textures with vertex colors
  const terrainMat = new THREE.MeshStandardMaterial({
    map: grassTex,
    vertexColors: true,
    roughness: 0.8,
    metalness: 0.05,
  });

  terrainMat.onBeforeCompile = (shader) => {
    shader.uniforms.dirtMap = { value: dirtTex };
    shader.vertexShader = `
      varying vec3 vWorldPosition;
      ${shader.vertexShader}
    `.replace(
      `#include <worldpos_vertex>`,
      `
      #include <worldpos_vertex>
      vWorldPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;
      `
    );

    shader.fragmentShader = `
      uniform sampler2D dirtMap;
      varying vec3 vWorldPosition;
      ${shader.fragmentShader}
    `.replace(
      `#include <map_fragment>`,
      `
      #include <map_fragment>
      // Calculate distance to winding path
      float tTown = clamp((vWorldPosition.z - 35.0) / 20.0, 0.0, 1.0);
      float rawPathX = sin(vWorldPosition.z * 0.035) * 11.0 + sin(vWorldPosition.z * 0.018) * 7.0;
      float pathX = rawPathX * (1.0 - tTown);
      float distTrail = abs(vWorldPosition.x - pathX);
      float trailMask = 1.0 - smoothstep(2.6, 4.4, distTrail);
      
      if (vWorldPosition.z < 60.0 && trailMask > 0.01) {
        vec4 dirtSample = texture2D(dirtMap, vWorldPosition.xz * 0.12);
        diffuseColor = mix(diffuseColor, dirtSample, trailMask * 0.85);
      }
      `
    );
  };

  const terrainMesh = new THREE.Mesh(terrainGeo, terrainMat);
  terrainMesh.receiveShadow = true;
  terrainMesh.position.y = -0.02;
  mapGroup.add(terrainMesh);

  // =========================================================================
  // 2. SURROUNDING ANIME OCEAN WATER (6000m x 6000m)
  // =========================================================================
  onProgress?.("Creating Anime Ocean Bay & Reflections...");

  const oceanGeo = new THREE.PlaneGeometry(6000, 6000, 24, 24);
  oceanGeo.rotateX(-Math.PI / 2);
  const oceanMat = new THREE.MeshStandardMaterial({
    color: 0x00a8cc,
    roughness: 0.2,
    metalness: 0.85,
    transparent: true,
    opacity: 0.82,
  });
  const oceanMesh = new THREE.Mesh(oceanGeo, oceanMat);
  oceanMesh.position.y = 0.0;
  mapGroup.add(oceanMesh);

  // Mountain Lake / Pond Water Plane (Image 3!)
  const lakeGeo = new THREE.CircleGeometry(26, 32);
  lakeGeo.rotateX(-Math.PI / 2);
  const lakeMat = new THREE.MeshStandardMaterial({
    color: 0x26c6da,
    roughness: 0.15,
    metalness: 0.9,
    transparent: true,
    opacity: 0.78,
  });
  const lakeMesh = new THREE.Mesh(lakeGeo, lakeMat);
  lakeMesh.position.set(42, 2.3, -38);
  mapGroup.add(lakeMesh);

  // =========================================================================
  // 3. DENSE CLOVER GRASS & WILDFLOWERS (Matching Images 1 & 2!)
  // =========================================================================
  onProgress?.("Planting Dense Stylized Clover & Wildflowers...");

  const cloverGrassModel = await loadModel(CLOVER_GRASS);
  const grassSmallModel = await loadModel(`${BASE_NATURE}/Grass_Small.gltf`);
  const bushFlowersGlb = await loadModel(BUSH_FLOWERS_GLB);
  const flower1Model = await loadModel(`${BASE_NATURE}/Flower_1_Clump.gltf`);
  const flower2Model = await loadModel(`${BASE_NATURE}/Flower_2_Clump.gltf`);

  const cloverGrassTransforms: InstanceTransform[] = [];
  const grassSmallTransforms: InstanceTransform[] = [];
  const bushTransforms: InstanceTransform[] = [];
  const blueFlowerTransforms: InstanceTransform[] = [];
  const yellowFlowerTransforms: InstanceTransform[] = [];

  let seed = 42;
  function rnd(): number {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  }

  // Carpet both sides of the nature trail with dense 3D clover grass (Images 1 & 2)
  for (let z = -90; z <= 55; z += 1.6) {
    const trailX = getTrailX(z);

    // Left side grass carpet
    for (let offset = 3.4; offset <= 16; offset += 2.0) {
      const rx = trailX - offset + (rnd() - 0.5) * 1.2;
      const rz = z + (rnd() - 0.5) * 1.2;
      const y = getIslandHeight(rx, rz);
      const rot = new THREE.Euler(0, rnd() * Math.PI * 2, 0);

      const s = 0.85 + rnd() * 0.45;
      cloverGrassTransforms.push({
        pos: new THREE.Vector3(rx, y, rz),
        rot,
        scale: new THREE.Vector3(s, s, s),
      });

      // Natural grass blades mixed in
      if (rnd() > 0.45) {
        const gs = 1.0 + rnd() * 0.6;
        grassSmallTransforms.push({
          pos: new THREE.Vector3(rx + (rnd() - 0.5) * 0.6, y, rz + (rnd() - 0.5) * 0.6),
          rot,
          scale: new THREE.Vector3(gs, gs, gs),
        });
      }

      // Wildflowers along trail borders
      if (rnd() > 0.65) {
        if (rnd() > 0.5) {
          blueFlowerTransforms.push({
            pos: new THREE.Vector3(rx + (rnd() - 0.5) * 0.8, y, rz + (rnd() - 0.5) * 0.8),
            rot,
            scale: new THREE.Vector3(1.1 + rnd() * 0.5, 1.1 + rnd() * 0.5, 1.1 + rnd() * 0.5),
          });
        } else {
          yellowFlowerTransforms.push({
            pos: new THREE.Vector3(rx + (rnd() - 0.5) * 0.8, y, rz + (rnd() - 0.5) * 0.8),
            rot,
            scale: new THREE.Vector3(1.1 + rnd() * 0.5, 1.1 + rnd() * 0.5, 1.1 + rnd() * 0.5),
          });
        }
      }
    }

    // Right side grass carpet
    for (let offset = 3.4; offset <= 16; offset += 2.0) {
      const rx = trailX + offset + (rnd() - 0.5) * 1.2;
      const rz = z + (rnd() - 0.5) * 1.2;
      const y = getIslandHeight(rx, rz);
      const rot = new THREE.Euler(0, rnd() * Math.PI * 2, 0);

      const s = 0.85 + rnd() * 0.45;
      cloverGrassTransforms.push({
        pos: new THREE.Vector3(rx, y, rz),
        rot,
        scale: new THREE.Vector3(s, s, s),
      });

      if (rnd() > 0.45) {
        const gs = 1.0 + rnd() * 0.6;
        grassSmallTransforms.push({
          pos: new THREE.Vector3(rx + (rnd() - 0.5) * 0.6, y, rz + (rnd() - 0.5) * 0.6),
          rot,
          scale: new THREE.Vector3(gs, gs, gs),
        });
      }
    }
  }

  // Flower bushes lining the trail (Image 1 pink/yellow bushes)
  for (let z = -80; z <= 50; z += 6) {
    const trailX = getTrailX(z);
    const side = rnd() > 0.5 ? -1 : 1;
    const rx = trailX + side * (4.2 + rnd() * 3.5);
    const rz = z + (rnd() - 0.5) * 2;
    const y = getIslandHeight(rx, rz);
    bushTransforms.push({
      pos: new THREE.Vector3(rx, y, rz),
      rot: new THREE.Euler(0, rnd() * Math.PI * 2, 0),
      scale: new THREE.Vector3(0.85 + rnd() * 0.4, 0.85 + rnd() * 0.4, 0.85 + rnd() * 0.4),
    });
  }

  if (cloverGrassModel) mapGroup.add(createInstancedMeshes(cloverGrassModel, cloverGrassTransforms, false, true));
  if (grassSmallModel) mapGroup.add(createInstancedMeshes(grassSmallModel, grassSmallTransforms, false, true));
  if (bushFlowersGlb) mapGroup.add(createInstancedMeshes(bushFlowersGlb, bushTransforms, false, true));
  if (flower1Model) mapGroup.add(createInstancedMeshes(flower1Model, blueFlowerTransforms, false, true));
  if (flower2Model) mapGroup.add(createInstancedMeshes(flower2Model, yellowFlowerTransforms, false, true));

  // =========================================================================
  // 4. ANIME TREES & GLOWING AUTUMN MAPLE (Images 1 & 3!)
  // =========================================================================
  onProgress?.("Planting Towering Canopy & Autumn Maple Trees...");

  const stylizedTreeModel = await loadModel(STYLIZED_TREE);
  const birchModel = await loadModel(`${BASE_NATURE}/BirchTree_1.gltf`);
  const mapleModel = await loadModel(`${BASE_NATURE}/MapleTree_1.gltf`);
  const deadTreeModel = await loadModel(`${BASE_NATURE}/DeadTree_1.gltf`);

  const canopyTreeTransforms: InstanceTransform[] = [];
  const birchTransforms: InstanceTransform[] = [];
  const autumnMapleTransforms: InstanceTransform[] = [];
  const deadTreeTransforms: InstanceTransform[] = [];

  // Towering stylized trees framing the nature trail (like Image 1)
  for (let z = -90; z <= 50; z += 8) {
    const trailX = getTrailX(z);

    // Left tree
    const lx = trailX - (7.5 + rnd() * 6);
    const ly = getIslandHeight(lx, z);
    const ls = 2.2 + rnd() * 0.9; // 11m to 16m tall canopy
    canopyTreeTransforms.push({
      pos: new THREE.Vector3(lx, ly, z),
      rot: new THREE.Euler(0, rnd() * Math.PI * 2, 0),
      scale: new THREE.Vector3(ls, ls, ls),
    });

    // Right tree
    const rx = trailX + (7.5 + rnd() * 6);
    const ry = getIslandHeight(rx, z + 3);
    const rs = 2.2 + rnd() * 0.9;
    canopyTreeTransforms.push({
      pos: new THREE.Vector3(rx, ry, z + 3),
      rot: new THREE.Euler(0, rnd() * Math.PI * 2, 0),
      scale: new THREE.Vector3(rs, rs, rs),
    });
  }

  // Glowing Autumn Maple Trees (Image 1 orange tree perched on rocky bluff!)
  const mapleBluffSpots = [
    { x: 18, z: -25 },
    { x: -22, z: -45 },
    { x: 38, z: -10 },
    { x: -35, z: 20 },
    { x: 65, z: -55 },
    { x: -55, z: -70 },
  ];
  mapleBluffSpots.forEach((spot) => {
    const y = getIslandHeight(spot.x, spot.z);
    autumnMapleTransforms.push({
      pos: new THREE.Vector3(spot.x, y, spot.z),
      rot: new THREE.Euler(0, rnd() * Math.PI * 2, 0),
      scale: new THREE.Vector3(1.4, 1.4, 1.4),
    });
  });

  // Additional 380 trees across the wider island hills
  for (let i = 0; i < 380; i++) {
    const rx = (rnd() - 0.5) * 1600;
    const rz = (rnd() - 0.5) * 1600;
    const dist = Math.sqrt(rx * rx + rz * rz);
    if (dist > ISLAND_RADIUS - 60 || dist < 25) continue;
    if (rz >= 60 && rz <= 240 && Math.abs(rx) <= 150) continue; // Keep town clear

    const y = getIslandHeight(rx, rz);
    const rot = new THREE.Euler(0, rnd() * Math.PI * 2, 0);

    if (rnd() > 0.45 && stylizedTreeModel) {
      const s = 2.0 + rnd() * 1.0;
      canopyTreeTransforms.push({
        pos: new THREE.Vector3(rx, y, rz),
        rot,
        scale: new THREE.Vector3(s, s, s),
      });
    } else {
      const s = 1.0 + rnd() * 0.7;
      birchTransforms.push({
        pos: new THREE.Vector3(rx, y, rz),
        rot,
        scale: new THREE.Vector3(s, s, s),
      });
    }
  }

  // Fallen mossy deadwood log across grass near pond (Image 3!)
  if (deadTreeModel) {
    const fallenLog = deadTreeModel.clone(true);
    fallenLog.position.set(32, 2.5, -28);
    fallenLog.rotation.set(0, 0.4, Math.PI / 2); // Rotated to lie horizontally!
    fallenLog.scale.set(0.8, 0.8, 0.8);
    mapGroup.add(fallenLog);
  }

  if (stylizedTreeModel) mapGroup.add(createInstancedMeshes(stylizedTreeModel, canopyTreeTransforms, false, true));
  if (birchModel) mapGroup.add(createInstancedMeshes(birchModel, birchTransforms, false, true));

  // Clone mapleModel with vibrant glowing autumn orange leaves (Image 1 & 3)
  if (mapleModel) {
    const autumnModel = mapleModel.clone(true);
    autumnModel.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) {
        const mesh = child as THREE.Mesh;
        if (mesh.material) {
          const mat = (mesh.material as THREE.MeshStandardMaterial).clone();
          mat.color = new THREE.Color(0xff8c00); // Glowing autumn amber/orange!
          mesh.material = mat;
        }
      }
    });
    mapGroup.add(createInstancedMeshes(autumnModel, autumnMapleTransforms, false, true));
  }

  // Golden Ginkgo Trees surrounding the mountain lake & bluffs (Image 3!)
  const ginkgoModel = await loadModel(`${BASE_STREET}/SM_Street_Tree_Ginkgo_S_01.gltf`);
  if (ginkgoModel) {
    const ginkgoTransforms: InstanceTransform[] = [];
    const ginkgoSpots = [
      { x: 32, z: -48, s: 1.4 },
      { x: 50, z: -46, s: 1.5 },
      { x: 56, z: -28, s: 1.35 },
      { x: 26, z: -35, s: 1.25 },
      { x: -18, z: -30, s: 1.3 },
    ];
    ginkgoSpots.forEach((spot) => {
      const y = getIslandHeight(spot.x, spot.z);
      ginkgoTransforms.push({
        pos: new THREE.Vector3(spot.x, y, spot.z),
        rot: new THREE.Euler(0, rnd() * Math.PI * 2, 0),
        scale: new THREE.Vector3(spot.s, spot.s, spot.s),
      });
    });
    mapGroup.add(createInstancedMeshes(ginkgoModel, ginkgoTransforms, false, true));
  }

  // =========================================================================
  // 5. ANIME BOULDERS & MOSSY ROCKS (Images 1 & 3!)
  // =========================================================================
  onProgress?.("Distributing Mossy Anime Boulders...");

  try {
    const stonesGltf = await gltfLoader.loadAsync(STONES_GLB);
    const stonesRoot = stonesGltf.scene;
    const stonesTransforms: InstanceTransform[] = [];

    // Prominent anime boulders lining the nature trail (like Image 1!)
    const trailBoulders = [
      { offset: -4.5, z: -10, s: 1.1 },
      { offset: 4.8, z: -18, s: 1.2 },
      { offset: -5.0, z: -32, s: 1.3 },
      { offset: 5.2, z: -45, s: 1.4 },
      { offset: -4.6, z: 12, s: 1.0 },
      { offset: 4.5, z: 24, s: 1.1 },
      { x: 34, z: -42, s: 1.6 }, // Lake shoreline boulders
      { x: 48, z: -20, s: 1.5 },
    ];
    trailBoulders.forEach((b) => {
      const bx = "offset" in b ? getTrailX(b.z) + (b as { offset: number }).offset : (b as { x: number }).x;
      const y = getIslandHeight(bx, b.z);
      stonesTransforms.push({
        pos: new THREE.Vector3(bx, y, b.z),
        rot: new THREE.Euler(0, rnd() * Math.PI * 2, 0),
        scale: new THREE.Vector3(b.s, b.s, b.s),
      });
    });

    // 120+ boulders across hillsides and bluffs
    for (let i = 0; i < 120; i++) {
      const rx = (rnd() - 0.5) * 1200;
      const rz = (rnd() - 0.5) * 1200;
      const dist = Math.sqrt(rx * rx + rz * rz);
      if (dist < 30 || dist > ISLAND_RADIUS - 80) continue;

      const y = getIslandHeight(rx, rz);
      const s = 0.9 + rnd() * 1.6;
      stonesTransforms.push({
        pos: new THREE.Vector3(rx, y, rz),
        rot: new THREE.Euler(0, rnd() * Math.PI * 2, 0),
        scale: new THREE.Vector3(s, s, s),
      });
    }

    mapGroup.add(createInstancedMeshes(stonesRoot, stonesTransforms, false, true));
  } catch (err) {
    console.warn("Skipping anime stones:", err);
  }

  // =========================================================================
  // 6. HILLSIDE JAPANESE SEASIDE TOWN (Image 4 Makoto Shinkai Town!)
  // =========================================================================
  onProgress?.("Constructing Hillside Seaside Town...");

  const garageModel = await loadModel(`${BASE_STREET}/SM_Floor_NarrowGarage_455_01.gltf`);
  const livingModel = await loadModel(`${BASE_STREET}/SM_Floor_NarrowLiving_364_01.gltf`);
  const upperWindowModel = await loadModel(`${BASE_STREET}/SM_Floor_NarrowUpperWindow_White_455_01.gltf`);
  const upperBalconyModel = await loadModel(`${BASE_STREET}/SM_Floor_NarrowUpperBalcony_White_455_01.gltf`);
  const roofPlainModel = await loadModel(`${BASE_STREET}/SM_Roof_NarrowFlatPlain_White_455_01.gltf`);
  const vendingBlueModel = await loadModel(`${BASE_STREET}/SM_Street_Vending_HD_Blue_103_01.gltf`);
  const vendingRedModel = await loadModel(`${BASE_STREET}/SM_Street_Vending_HD_Red_103_01.gltf`);
  const trafficSignalModel = await loadModel(`${BASE_STREET}/SM_Street_TrafficSignal_Galv_300_01.gltf`);
  const tomareSignModel = await loadModel(`${BASE_STREET}/SM_Street_Sign_Tomare_01.gltf`);
  const bicycleSilverModel = await loadModel(`${BASE_STREET}/SM_Street_Bicycle_Plain_Silver_01.gltf`);

  const garageTransforms: InstanceTransform[] = [];
  const livingTransforms: InstanceTransform[] = [];
  const upperWindowTransforms: InstanceTransform[] = [];
  const upperBalconyTransforms: InstanceTransform[] = [];
  const roofTransforms: InstanceTransform[] = [];
  const streetPropsTransforms: InstanceTransform[] = [];

  // Terraced town blocks along the hillside slope towards the ocean
  for (let tx = -80; tx <= 80; tx += 28) {
    for (let tz = 80; tz <= 220; tz += 35) {
      if (Math.abs(tx) < 14) continue; // Keep central staircase street clear
      const y = getIslandHeight(tx, tz);
      const rot = new THREE.Euler(0, tx < 0 ? Math.PI / 2 : -Math.PI / 2, 0);

      garageTransforms.push({ pos: new THREE.Vector3(tx, y, tz), rot });
      upperBalconyTransforms.push({ pos: new THREE.Vector3(tx, y + 3, tz), rot });
      upperWindowTransforms.push({ pos: new THREE.Vector3(tx, y + 6, tz), rot });
      roofTransforms.push({ pos: new THREE.Vector3(tx, y + 9, tz), rot });
    }
  }

  if (garageModel) mapGroup.add(createInstancedMeshes(garageModel, garageTransforms, false, true));
  if (upperBalconyModel) mapGroup.add(createInstancedMeshes(upperBalconyModel, upperBalconyTransforms, false, true));
  if (upperWindowModel) mapGroup.add(createInstancedMeshes(upperWindowModel, upperWindowTransforms, false, true));
  if (roofPlainModel) mapGroup.add(createInstancedMeshes(roofPlainModel, roofTransforms, false, true));

  // Vending machines and street furniture at the town entrance
  if (vendingBlueModel) {
    const vBlue = vendingBlueModel.clone(true);
    vBlue.position.set(-6, getIslandHeight(-6, 68), 68);
    vBlue.rotation.y = 0.2;
    mapGroup.add(vBlue);
  }
  if (vendingRedModel) {
    const vRed = vendingRedModel.clone(true);
    vRed.position.set(-8, getIslandHeight(-8, 68), 68);
    vRed.rotation.y = 0.2;
    mapGroup.add(vRed);
  }
  if (bicycleSilverModel) {
    const bike = bicycleSilverModel.clone(true);
    bike.position.set(7, getIslandHeight(7, 72), 72);
    bike.rotation.y = -0.3;
    mapGroup.add(bike);
  }
  if (tomareSignModel) {
    const sign = tomareSignModel.clone(true);
    sign.position.set(5.5, getIslandHeight(5.5, 62), 62);
    mapGroup.add(sign);
  }

  // Red Japanese handrails along the stone staircase descending into the seaside town (Image 4!)
  const railGroup = new THREE.Group();
  railGroup.name = "ShinkaiRedStairs";

  const redMat = new THREE.MeshStandardMaterial({
    color: 0xcc2936, // Vibrant Japanese shrine red / crimson
    roughness: 0.35,
    metalness: 0.3,
  });
  const stepMat = new THREE.MeshStandardMaterial({
    color: 0xd1d5db, // Light grey stone / concrete
    roughness: 0.8,
  });

  // Steps descending from z = 52 (y = 2.8) to z = 74 (y = 0.8)
  const numSteps = 16;
  for (let s = 0; s < numSteps; s++) {
    const t = s / numSteps;
    const sz = 52 + t * 22;
    const sy = 2.8 - t * 2.0;

    // Step tread
    const stepGeo = new THREE.BoxGeometry(4.4, 0.22, 1.4);
    const stepMesh = new THREE.Mesh(stepGeo, stepMat);
    stepMesh.position.set(0, sy - 0.1, sz);
    stepMesh.receiveShadow = true;
    railGroup.add(stepMesh);

    // Left and right red vertical railing posts every 2 steps
    if (s % 2 === 0) {
      const postGeo = new THREE.CylinderGeometry(0.04, 0.04, 1.1, 8);
      const postL = new THREE.Mesh(postGeo, redMat);
      postL.position.set(-2.2, sy + 0.55, sz);
      railGroup.add(postL);

      const postR = new THREE.Mesh(postGeo, redMat);
      postR.position.set(2.2, sy + 0.55, sz);
      railGroup.add(postR);
    }
  }

  // Left and Right continuous red handrails
  const railLen = Math.sqrt(Math.pow(22, 2) + Math.pow(2.0, 2));
  const railAngle = Math.atan2(2.0, 22);
  const railBarGeo = new THREE.CylinderGeometry(0.045, 0.045, railLen, 8);
  railBarGeo.rotateX(Math.PI / 2 - railAngle);

  const barL = new THREE.Mesh(railBarGeo, redMat);
  barL.position.set(-2.2, 1.8 + 1.1, 63);
  railGroup.add(barL);

  const barR = new THREE.Mesh(railBarGeo, redMat);
  barR.position.set(2.2, 1.8 + 1.1, 63);
  railGroup.add(barR);

  mapGroup.add(railGroup);

  // Japanese utility pole with transformer overlooking the town and sea (Image 4!)
  const poleModel = await loadModel(`${BASE_STREET}/SM_Street_Pole_Transformer_01.gltf`);
  if (poleModel) {
    const pole1 = poleModel.clone(true);
    pole1.position.set(3.4, getIslandHeight(3.4, 54), 54);
    pole1.rotation.y = -0.4;
    mapGroup.add(pole1);

    const pole2 = poleModel.clone(true);
    pole2.position.set(-3.6, getIslandHeight(-3.6, 75), 75);
    pole2.rotation.y = 0.3;
    mapGroup.add(pole2);
  }

  // =========================================================================
  // 7. VOLUMETRIC SUNBEAMS / GOD RAYS (Image 1 Sunlight Shafts!)
  // =========================================================================
  const godRayGeo = new THREE.CylinderGeometry(0.2, 4.2, 34, 16, 1, true);
  const godRayMat = new THREE.MeshBasicMaterial({
    color: 0xffefb8,
    transparent: true,
    opacity: 0.055,
    blending: THREE.AdditiveBlending,
    side: THREE.FrontSide,
    depthWrite: false,
  });

  const rayPositions = [
    { x: -3.5, y: 15, z: -8 },
    { x: 4.2, y: 16, z: -22 },
    { x: -2.8, y: 15, z: -38 },
    { x: 3.5, y: 14, z: 12 },
  ];
  rayPositions.forEach((rp) => {
    const ray = new THREE.Mesh(godRayGeo, godRayMat);
    ray.position.set(rp.x, rp.y, rp.z);
    ray.rotation.set(0.38, 0, 0.32); // Angled with the golden sunlight
    mapGroup.add(ray);
  });

  // =========================================================================
  // 8. PUFFY ANIME CUMULUS CLOUDS ON SEA HORIZON (Images 2, 3, 4!)
  // =========================================================================
  const cloudMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.9,
    metalness: 0.05,
  });

  const cloudGroup = new THREE.Group();
  cloudGroup.name = "AnimeHorizonClouds";

  // Create stylized cumulus cloud clusters along the ocean horizon
  for (let c = 0; c < 18; c++) {
    const angle = (c / 18) * Math.PI * 2;
    const rCloud = 1800 + (c % 3) * 200;
    const cx = Math.cos(angle) * rCloud;
    const cz = Math.sin(angle) * rCloud;
    const cy = 240 + (c % 4) * 50;

    // Cloud puffy cluster of 5 spheres
    const cluster = new THREE.Group();
    cluster.position.set(cx, cy, cz);

    const baseR = 70 + (c % 3) * 25;
    for (let s = 0; s < 5; s++) {
      const puffGeo = new THREE.SphereGeometry(baseR * (0.6 + s * 0.1), 12, 12);
      const puff = new THREE.Mesh(puffGeo, cloudMat);
      puff.position.set((s - 2) * baseR * 0.55, Math.sin(s) * baseR * 0.25, (s % 2) * baseR * 0.3);
      puff.scale.set(1.4, 0.9, 1.2);
      cluster.add(puff);
    }
    cloudGroup.add(cluster);
  }
  mapGroup.add(cloudGroup);

  onProgress?.("Ghibli/Genshin Island Map Ready!");
  return mapGroup;
}
