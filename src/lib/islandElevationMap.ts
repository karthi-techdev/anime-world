import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

// Paths to the user-uploaded terrain assets & RPG island maps
const HEIGHTMAP_BIN = "/assets/3d/environment/island/island_rpg_elev_512.bin";
const SPLATMAP_TEXTURE = "/assets/3d/environment/island/island_rpg_splatmap.png";
const LAND_GREEN_TEXTURE = "/assets/3d/environment/island/land_green.png";
const LAND_SAND_TEXTURE = "/assets/3d/environment/island/land_sand.png";
const LAND_ROCK_TEXTURE = "/assets/3d/environment/island/land_rock.png";

// Environment 3D models
const BASE_STREET = "/assets/3d/environment/JapanStreetModularPackLite_glTF/JapanStreetModularPackLite/glTF";
const BASE_NATURE = "/assets/3d/environment/trees_grass_rocks/glTF";
const STONES_GLB = "/assets/3d/environment/Anime_stones.glb";
const STYLIZED_TREE = "/assets/3d/environment/stylized_tree.glb";
const CLOVER_GRASS = "/assets/3d/environment/low_poly_stylized_clover_grass.glb";
const BUSH_FLOWERS_GLB = "/assets/3d/environment/bush_flowers.glb";
const CLOVER_GREEN_TEXTURE = "/assets/3d/environment/clover_green.png";

export const MAP_SIZE = 3000; // 3km x 3km Terrain
const GRID_SIZE = 512;
const OFFSET_X = 0.0;
const OFFSET_Z = 0.0; // Exact center is the central town fountain

// Cached elevation grid in memory
let elevationGrid: Uint16Array | null = null;

// Synchronous / async elevation sampling
export async function loadElevationData(): Promise<Uint16Array> {
  if (elevationGrid) return elevationGrid;
  try {
    const res = await fetch(HEIGHTMAP_BIN);
    const buf = await res.arrayBuffer();
    elevationGrid = new Uint16Array(buf);
    return elevationGrid;
  } catch (err) {
    console.error("Failed loading heightmap binary:", err);
    elevationGrid = new Uint16Array(GRID_SIZE * GRID_SIZE);
    return elevationGrid;
  }
}

// Bilinear height lookup in world coordinates (x, z)
export function getIslandElevation(x: number, z: number): number {
  if (!elevationGrid) {
    // Fallback: Town Square Plaza elevation
    return 5.50;
  }

  const gx = x + OFFSET_X;
  const gz = z + OFFSET_Z;

  const u = Math.min(Math.max((gx + MAP_SIZE / 2) / MAP_SIZE, 0), 1);
  const v = Math.min(Math.max((gz + MAP_SIZE / 2) / MAP_SIZE, 0), 1);

  const c = u * (GRID_SIZE - 1);
  const r = v * (GRID_SIZE - 1);

  const c0 = Math.floor(c);
  const r0 = Math.floor(r);
  const c1 = Math.min(c0 + 1, GRID_SIZE - 1);
  const r1 = Math.min(r0 + 1, GRID_SIZE - 1);

  const fc = c - c0;
  const fr = r - r0;

  const i00 = r0 * GRID_SIZE + c0;
  const i01 = r0 * GRID_SIZE + c1;
  const i10 = r1 * GRID_SIZE + c0;
  const i11 = r1 * GRID_SIZE + c1;

  const h00 = elevationGrid[i00] / 100.0 - 10.0;
  const h01 = elevationGrid[i01] / 100.0 - 10.0;
  const h10 = elevationGrid[i10] / 100.0 - 10.0;
  const h11 = elevationGrid[i11] / 100.0 - 10.0;

  const hTop = h00 * (1 - fc) + h01 * fc;
  const hBot = h10 * (1 - fc) + h11 * fc;

  return hTop * (1 - fr) + hBot * fr;
}

interface InstanceTransform {
  pos: THREE.Vector3;
  rot?: THREE.Euler;
  scale?: THREE.Vector3;
}

// Matrix-aware InstancedMesh generator
function createInstancedMeshes(
  root: THREE.Object3D,
  transforms: InstanceTransform[],
  castShadow = false,
  receiveShadow = true
): THREE.Group {
  const group = new THREE.Group();
  if (transforms.length === 0) return group;

  root.updateMatrixWorld(true);

  root.traverse((child) => {
    if ((child as THREE.Mesh).isMesh) {
      const mesh = child as THREE.Mesh;
      const localMatrix = mesh.matrixWorld.clone();

      const instancedMesh = new THREE.InstancedMesh(
        mesh.geometry,
        mesh.material,
        transforms.length
      );
      instancedMesh.castShadow = castShadow;
      instancedMesh.receiveShadow = receiveShadow;

      const dummy = new THREE.Object3D();
      const parentDummy = new THREE.Object3D();

      for (let i = 0; i < transforms.length; i++) {
        const t = transforms[i];
        dummy.position.copy(t.pos);
        if (t.rot) dummy.rotation.copy(t.rot);
        else dummy.rotation.set(0, 0, 0);
        if (t.scale) dummy.scale.copy(t.scale);
        else dummy.scale.set(1, 1, 1);

        dummy.updateMatrix();
        parentDummy.matrix.copy(dummy.matrix).multiply(localMatrix);
        instancedMesh.setMatrixAt(i, parentDummy.matrix);
      }

      instancedMesh.instanceMatrix.needsUpdate = true;
      group.add(instancedMesh);
    }
  });

  return group;
}

// Main 3D Island World Builder
export async function createIslandElevationMap(
  scene: THREE.Scene,
  onProgress?: (text: string) => void
): Promise<THREE.Group> {
  const mapGroup = new THREE.Group();
  mapGroup.name = "IslandElevationScene";
  scene.add(mapGroup);

  const gltfLoader = new GLTFLoader();
  const texLoader = new THREE.TextureLoader();

  onProgress?.("Loading Island Heightmap & Splat Map...");
  await loadElevationData();

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

      // Fix low_poly_stylized_clover_grass: use crisp green clover texture
      if (path.includes("low_poly_stylized_clover_grass")) {
        const cloverTex = await texLoader.loadAsync(CLOVER_GREEN_TEXTURE);
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

      // Fix stylized_tree: clear corrupt black vertex colors
      if (path.includes("stylized_tree")) {
        root.traverse((child) => {
          if ((child as THREE.Mesh).isMesh) {
            const mesh = child as THREE.Mesh;
            if (mesh.geometry && mesh.geometry.attributes.color) {
              mesh.geometry.deleteAttribute("color");
            }
            if (mesh.material) {
              const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
              mats.forEach((m) => {
                const mat = m as THREE.MeshStandardMaterial;
                mat.vertexColors = false;
                if (mat.color && typeof mat.color.setHex === "function") {
                  mat.color.setHex(0xffffff);
                }
                if (mat.emissive && typeof mat.emissive.setHex === "function") {
                  mat.emissive.setHex(0x000000);
                }
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

  // =========================================================================
  // 1. LOAD USER LAND TEXTURES & ISLAND SPLAT MAP
  // =========================================================================
  onProgress?.("Loading Land Textures & Island Splat Map...");

  const [texGreen, texSand, texRock, texSplat] = await Promise.all([
    texLoader.loadAsync(LAND_GREEN_TEXTURE),
    texLoader.loadAsync(LAND_SAND_TEXTURE),
    texLoader.loadAsync(LAND_ROCK_TEXTURE),
    texLoader.loadAsync(SPLATMAP_TEXTURE),
  ]);

  [texGreen, texSand, texRock].forEach((t) => {
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
  });

  texSplat.wrapS = THREE.ClampToEdgeWrapping;
  texSplat.wrapT = THREE.ClampToEdgeWrapping;
  texSplat.minFilter = THREE.LinearFilter;
  texSplat.magFilter = THREE.LinearFilter;
  texSplat.colorSpace = THREE.NoColorSpace;

  // =========================================================================
  // 2. DISPLACE 3D TERRAIN MESH WITH RPG ISLAND ELEVATION
  // =========================================================================
  onProgress?.("Elevating Island Terrain from RPG Heightmap...");

  const segments = 280; // Crisp mountain silhouettes with smooth 60+ FPS performance
  const terrainGeo = new THREE.PlaneGeometry(MAP_SIZE, MAP_SIZE, segments, segments);
  terrainGeo.rotateX(-Math.PI / 2);

  const posAttr = terrainGeo.attributes.position;
  for (let i = 0; i < posAttr.count; i++) {
    const x = posAttr.getX(i);
    const z = posAttr.getZ(i);
    const y = getIslandElevation(x, z);
    posAttr.setY(i, y);
  }
  terrainGeo.computeVertexNormals();

  // Splatting Material: Only using the 3 user land textures!
  const terrainMat = new THREE.MeshStandardMaterial({
    map: texGreen,
    roughness: 0.82,
    metalness: 0.08,
  });

  terrainMat.onBeforeCompile = (shader) => {
    shader.uniforms.mapGreen = { value: texGreen };
    shader.uniforms.mapSand = { value: texSand };
    shader.uniforms.mapRock = { value: texRock };
    shader.uniforms.mapSplat = { value: texSplat };
    shader.uniforms.uMapSize = { value: MAP_SIZE };

    shader.vertexShader = `
      varying vec3 vWorldPosition;
      varying vec3 vNormalWorld;
      ${shader.vertexShader}
    `.replace(
      `#include <worldpos_vertex>`,
      `
      #include <worldpos_vertex>
      vWorldPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;
      vNormalWorld = normalize((modelMatrix * vec4(normal, 0.0)).xyz);
      `
    );

    shader.fragmentShader = `
      uniform sampler2D mapGreen;
      uniform sampler2D mapSand;
      uniform sampler2D mapRock;
      uniform sampler2D mapSplat;
      uniform float uMapSize;
      varying vec3 vWorldPosition;
      varying vec3 vNormalWorld;
      ${shader.fragmentShader}
    `.replace(
      `#include <map_fragment>`,
      `
      // Map world position to [0, 1] splat UV with inverted Z for OpenGL top-left alignment
      vec2 splatUv = vec2(
        (vWorldPosition.x + uMapSize * 0.5) / uMapSize,
        1.0 - (vWorldPosition.z + uMapSize * 0.5) / uMapSize
      );
      vec4 splat = texture2D(mapSplat, splatUv);

      // Seamless high-frequency sampling using the 3 user-uploaded textures only
      vec2 uvGreen = vWorldPosition.xz * 0.08;
      vec2 uvSand = vWorldPosition.xz * 0.08;
      vec2 uvRock = vWorldPosition.xz * 0.05;

      vec4 sampleGreen = texture2D(mapGreen, uvGreen);
      vec4 sampleSand = texture2D(mapSand, uvSand);
      vec4 sampleRock = texture2D(mapRock, uvRock);

      // Slope for steep vertical cliffs & mountain bluffs
      float slope = 1.0 - abs(vNormalWorld.y);
      float cliffSlope = smoothstep(0.32, 0.55, slope);

      // Weights from splat map:
      // R = Sand (roads, central plaza, farmland fields, beaches, docks)
      // G = Green (lush grass, meadows, forest floor)
      // B = Rock (perimeter cliffs, bluffs, islets, mountain crags)
      float wSand = splat.r;
      float wGreen = splat.g;
      float wRock = max(splat.b, cliffSlope * 0.95);

      // High mountain cliffs & ridges transition to rugged rock
      if (vWorldPosition.y > 30.0) {
        float alpineCliff = cliffSlope * smoothstep(30.0, 80.0, vWorldPosition.y);
        wRock = max(wRock, alpineCliff * 0.95);
      }
      if (vWorldPosition.y > 90.0) {
        float summitRock = smoothstep(90.0, 111.0, vWorldPosition.y) * cliffSlope * 1.2;
        wRock = max(wRock, summitRock);
      }

      // In ocean seabed (underwater y < 1.0m), ensure sandy shelf
      if (vWorldPosition.y < 1.0) {
        wSand = max(wSand, 0.95);
        wGreen = 0.0;
      }

      float totalW = max(wSand + wGreen + wRock, 0.001);
      wSand /= totalW;
      wGreen /= totalW;
      wRock /= totalW;

      vec3 blended = sampleGreen.rgb * wGreen + sampleSand.rgb * wSand + sampleRock.rgb * wRock;
      diffuseColor = vec4(blended, 1.0);
      `
    );
  };

  const terrainMesh = new THREE.Mesh(terrainGeo, terrainMat);
  terrainMesh.receiveShadow = true;
  mapGroup.add(terrainMesh);

  // =========================================================================
  // 3. SURROUNDING TURQUOISE ANIME OCEAN (6km x 6km)
  // =========================================================================
  onProgress?.("Generating Turquoise Island Ocean Bay...");

  const oceanGeo = new THREE.PlaneGeometry(6000, 6000, 16, 16);
  oceanGeo.rotateX(-Math.PI / 2);
  const oceanMat = new THREE.MeshStandardMaterial({
    color: 0x009ec8,
    roughness: 0.16,
    metalness: 0.75,
    transparent: true,
    opacity: 0.86,
    depthWrite: false,
  });
  const oceanMesh = new THREE.Mesh(oceanGeo, oceanMat);
  oceanMesh.position.y = 0.0;
  mapGroup.add(oceanMesh);

  // =========================================================================
  // 4. CENTRAL TOWN PLAZA FOUNTAIN (At exact origin [0, 5.50, 0])
  // =========================================================================
  onProgress?.("Constructing Central Plaza Fountain...");

  const fountainGroup = new THREE.Group();
  fountainGroup.name = "CentralPlazaFountain";
  fountainGroup.position.set(0, 5.50, 0);

  const stoneMat = new THREE.MeshStandardMaterial({
    color: 0xe2e8f0,
    roughness: 0.7,
    metalness: 0.15,
  });
  const waterPoolMat = new THREE.MeshStandardMaterial({
    color: 0x38bdf8,
    roughness: 0.1,
    metalness: 0.85,
    transparent: true,
    opacity: 0.9,
  });

  // Outer circular stone pool wall
  const outerWallGeo = new THREE.CylinderGeometry(5.8, 6.2, 0.65, 32);
  const outerWall = new THREE.Mesh(outerWallGeo, stoneMat);
  outerWall.position.y = 0.32;
  fountainGroup.add(outerWall);

  // Inner water pool disk
  const poolWaterGeo = new THREE.CylinderGeometry(5.3, 5.3, 0.1, 32);
  const poolWater = new THREE.Mesh(poolWaterGeo, waterPoolMat);
  poolWater.position.y = 0.52;
  fountainGroup.add(poolWater);

  // Middle tiered stone pedestal
  const tier1Geo = new THREE.CylinderGeometry(2.6, 3.0, 0.75, 24);
  const tier1 = new THREE.Mesh(tier1Geo, stoneMat);
  tier1.position.y = 0.85;
  fountainGroup.add(tier1);

  // Upper basin
  const upperBasinGeo = new THREE.CylinderGeometry(1.9, 1.4, 0.45, 24);
  const upperBasin = new THREE.Mesh(upperBasinGeo, stoneMat);
  upperBasin.position.y = 1.45;
  fountainGroup.add(upperBasin);

  // Upper water pool
  const upperWaterGeo = new THREE.CylinderGeometry(1.7, 1.7, 0.1, 24);
  const upperWater = new THREE.Mesh(upperWaterGeo, waterPoolMat);
  upperWater.position.y = 1.68;
  fountainGroup.add(upperWater);

  // Top spire
  const spireGeo = new THREE.ConeGeometry(0.35, 1.2, 16);
  const spire = new THREE.Mesh(spireGeo, stoneMat);
  spire.position.y = 2.45;
  fountainGroup.add(spire);

  // Water jet stream
  const jetGeo = new THREE.CylinderGeometry(0.12, 0.28, 1.5, 12);
  const jetMat = new THREE.MeshStandardMaterial({
    color: 0xbae6fd,
    roughness: 0.05,
    transparent: true,
    opacity: 0.85,
  });
  const jet = new THREE.Mesh(jetGeo, jetMat);
  jet.position.y = 3.2;
  fountainGroup.add(jet);

  mapGroup.add(fountainGroup);

  // =========================================================================
  // 5. TOWN BUILDINGS & ROADS
  // =========================================================================
  onProgress?.("Placing Town Buildings, Stores & Street Furniture...");

  const garageModel = await loadModel(`${BASE_STREET}/SM_Floor_NarrowGarage_455_01.gltf`);
  const livingModel = await loadModel(`${BASE_STREET}/SM_Floor_NarrowLiving_364_01.gltf`);
  const upperWindowModel = await loadModel(`${BASE_STREET}/SM_Floor_NarrowUpperWindow_White_455_01.gltf`);
  const upperBalconyModel = await loadModel(`${BASE_STREET}/SM_Floor_NarrowUpperBalcony_White_455_01.gltf`);
  const roofPlainModel = await loadModel(`${BASE_STREET}/SM_Roof_NarrowFlatPlain_White_455_01.gltf`);
  const vendingBlueModel = await loadModel(`${BASE_STREET}/SM_Street_Vending_HD_Blue_103_01.gltf`);
  const vendingRedModel = await loadModel(`${BASE_STREET}/SM_Street_Vending_HD_Red_103_01.gltf`);
  const bicycleSilverModel = await loadModel(`${BASE_STREET}/SM_Street_Bicycle_Plain_Silver_01.gltf`);
  const poleModel = await loadModel(`${BASE_STREET}/SM_Street_Pole_Transformer_01.gltf`);

  const garageTransforms: InstanceTransform[] = [];
  const upperBalconyTransforms: InstanceTransform[] = [];
  const upperWindowTransforms: InstanceTransform[] = [];
  const roofTransforms: InstanceTransform[] = [];

  // Positions of houses lining the plaza and roads:
  const townHouseSpots = [
    // Around central plaza:
    { x: -38, z: -28, rot: 0.4 },
    { x: -46, z: 8, rot: 1.2 },
    { x: -28, z: 38, rot: 2.1 },
    { x: 18, z: 42, rot: 2.8 },
    { x: 44, z: 20, rot: -2.2 },
    { x: 48, z: -16, rot: -1.3 },
    { x: 24, z: -40, rot: -0.6 },
    { x: -8, z: -46, rot: 0.1 },
    // Along harbor road (west to docks):
    { x: -75, z: -20, rot: 0.3 },
    { x: -108, z: -32, rot: 0.5 },
    { x: -140, z: -55, rot: 0.8 },
    { x: -175, z: -80, rot: 0.9 },
    { x: -90, z: 15, rot: -0.4 },
    { x: -125, z: 18, rot: -0.5 },
    { x: -160, z: 5, rot: -0.2 },
    // Along north road:
    { x: -20, z: -90, rot: 0.1 },
    { x: 18, z: -95, rot: -0.2 },
    { x: 40, z: -135, rot: -0.4 },
    { x: -10, z: -150, rot: 0.2 },
    // Along east road:
    { x: 80, z: 10, rot: 1.5 },
    { x: 115, z: 25, rot: 1.8 },
    { x: 150, z: 55, rot: 2.0 },
    { x: 95, z: -25, rot: -1.2 },
    { x: 130, z: -35, rot: -1.4 },
    // Along south road:
    { x: -18, z: 75, rot: 3.1 },
    { x: 22, z: 85, rot: 3.0 },
    { x: -30, z: 120, rot: 2.9 },
    { x: 32, z: 135, rot: 3.1 },
  ];

  townHouseSpots.forEach((spot) => {
    const y = getIslandElevation(spot.x, spot.z);
    if (y >= 1.5) {
      const rot = new THREE.Euler(0, spot.rot, 0);
      garageTransforms.push({ pos: new THREE.Vector3(spot.x, y, spot.z), rot });
      upperBalconyTransforms.push({ pos: new THREE.Vector3(spot.x, y + 3, spot.z), rot });
      upperWindowTransforms.push({ pos: new THREE.Vector3(spot.x, y + 6, spot.z), rot });
      roofTransforms.push({ pos: new THREE.Vector3(spot.x, y + 9, spot.z), rot });
    }
  });

  if (garageModel) mapGroup.add(createInstancedMeshes(garageModel, garageTransforms, false, true));
  if (upperBalconyModel) mapGroup.add(createInstancedMeshes(upperBalconyModel, upperBalconyTransforms, false, true));
  if (upperWindowModel) mapGroup.add(createInstancedMeshes(upperWindowModel, upperWindowTransforms, false, true));
  if (roofPlainModel) mapGroup.add(createInstancedMeshes(roofPlainModel, roofTransforms, false, true));

  // Plaza street furniture
  if (vendingBlueModel) {
    const vBlue = vendingBlueModel.clone(true);
    vBlue.position.set(-12, getIslandElevation(-12, -8), -8);
    vBlue.rotation.y = 0.5;
    mapGroup.add(vBlue);
  }
  if (vendingRedModel) {
    const vRed = vendingRedModel.clone(true);
    vRed.position.set(-14, getIslandElevation(-14, -8), -8);
    vRed.rotation.y = 0.5;
    mapGroup.add(vRed);
  }
  if (bicycleSilverModel) {
    const bike = bicycleSilverModel.clone(true);
    bike.position.set(10, getIslandElevation(10, 8), 8);
    bike.rotation.y = -0.4;
    mapGroup.add(bike);
  }
  if (poleModel) {
    const p1 = poleModel.clone(true);
    p1.position.set(-16, getIslandElevation(-16, 12), 12);
    p1.rotation.y = -0.3;
    mapGroup.add(p1);

    const p2 = poleModel.clone(true);
    p2.position.set(18, getIslandElevation(18, -14), -14);
    p2.rotation.y = 0.4;
    mapGroup.add(p2);
  }

  // =========================================================================
  // 6. NORTHWEST HARBOR WOODEN PIERS & DOCKS
  // =========================================================================
  onProgress?.("Constructing Northwest Harbor Docks...");

  const woodMat = new THREE.MeshStandardMaterial({
    color: 0x85583b,
    roughness: 0.85,
    metalness: 0.05,
  });

  const dockPiers = [
    { startX: -220, startZ: -95, endX: -260, endZ: -125, width: 3.8 },
    { startX: -240, startZ: -130, endX: -285, endZ: -165, width: 4.2 },
    { startX: -210, startZ: -70, endX: -245, endZ: -95, width: 3.5 },
  ];

  dockPiers.forEach((pier) => {
    const dx = pier.endX - pier.startX;
    const dz = pier.endZ - pier.startZ;
    const len = Math.sqrt(dx * dx + dz * dz);
    const angle = Math.atan2(dz, dx);

    const pierGeo = new THREE.BoxGeometry(len, 0.4, pier.width);
    const pierMesh = new THREE.Mesh(pierGeo, woodMat);
    pierMesh.position.set(
      (pier.startX + pier.endX) / 2,
      1.35, // Floats safely above sea level 0.0m
      (pier.startZ + pier.endZ) / 2
    );
    pierMesh.rotation.y = -angle;
    pierMesh.receiveShadow = true;
    mapGroup.add(pierMesh);

    // Pilings into water
    const numPilings = 6;
    for (let p = 0; p <= numPilings; p++) {
      const t = p / numPilings;
      const px = pier.startX + dx * t;
      const pz = pier.startZ + dz * t;
      const pilingGeo = new THREE.CylinderGeometry(0.2, 0.2, 3.5, 8);
      const pilingL = new THREE.Mesh(pilingGeo, woodMat);
      pilingL.position.set(px - Math.sin(angle) * (pier.width / 2), 0.2, pz + Math.cos(angle) * (pier.width / 2));
      mapGroup.add(pilingL);
      const pilingR = new THREE.Mesh(pilingGeo, woodMat);
      pilingR.position.set(px + Math.sin(angle) * (pier.width / 2), 0.2, pz - Math.cos(angle) * (pier.width / 2));
      mapGroup.add(pilingR);
    }
  });

  // =========================================================================
  // 7. DENSE EAST FOREST (450+ Trees across the Eastern Plateau)
  // =========================================================================
  onProgress?.("Planting Dense Eastern Forest & Hillside Woodlands...");

  const stylizedTreeModel = await loadModel(STYLIZED_TREE);
  const birchModel = await loadModel(`${BASE_NATURE}/BirchTree_1.gltf`);
  const mapleModel = await loadModel(`${BASE_NATURE}/MapleTree_1.gltf`);
  const deadTreeModel = await loadModel(`${BASE_NATURE}/DeadTree_1.gltf`);

  const canopyTreeTransforms: InstanceTransform[] = [];
  const birchTransforms: InstanceTransform[] = [];
  const autumnMapleTransforms: InstanceTransform[] = [];
  const deadTreeTransforms: InstanceTransform[] = [];

  let seed = 12345;
  function rnd(): number {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  }

  // 1. Dense forest canopy cluster in the Northeast / East (matching reference map!)
  for (let i = 0; i < 420; i++) {
    const rx = 120 + rnd() * 520;
    const rz = -540 + rnd() * 750;
    const y = getIslandElevation(rx, rz);
    if (y < 2.0) continue; // Keep on land above water

    const s = 1.6 + rnd() * 1.1;
    const rot = new THREE.Euler(0, rnd() * Math.PI * 2, 0);

    if (rnd() > 0.45 && stylizedTreeModel) {
      canopyTreeTransforms.push({
        pos: new THREE.Vector3(rx, y, rz),
        rot,
        scale: new THREE.Vector3(s, s, s),
      });
    } else {
      birchTransforms.push({
        pos: new THREE.Vector3(rx, y, rz),
        rot,
        scale: new THREE.Vector3(s * 0.7, s * 0.7, s * 0.7),
      });
    }
  }

  // 2. Scenic Autumn Maple Trees on hills and ridgelines
  const mapleSpots = [
    { x: -50, z: -80 },
    { x: 60, z: -70 },
    { x: -85, z: 80 },
    { x: 120, z: -150 },
    { x: 80, z: 220 },
    { x: -120, z: 260 },
  ];
  mapleSpots.forEach((spot) => {
    const y = getIslandElevation(spot.x, spot.z);
    if (y >= 2.0) {
      autumnMapleTransforms.push({
        pos: new THREE.Vector3(spot.x, y, spot.z),
        rot: new THREE.Euler(0, rnd() * Math.PI * 2, 0),
        scale: new THREE.Vector3(1.5, 1.5, 1.5),
      });
    }
  });

  // 3. Trees in the southern countryside
  for (let i = 0; i < 90; i++) {
    const rx = -200 + rnd() * 450;
    const rz = 250 + rnd() * 600;
    const y = getIslandElevation(rx, rz);
    if (y < 2.0) continue;
    // Don't plant inside the flat farm fields
    if (rz > 380 && rz < 700 && rx > 20 && rx < 360) continue;

    const s = 1.3 + rnd() * 0.8;
    const rot = new THREE.Euler(0, rnd() * Math.PI * 2, 0);
    canopyTreeTransforms.push({
      pos: new THREE.Vector3(rx, y, rz),
      rot,
      scale: new THREE.Vector3(s, s, s),
    });
  }

  // 4. Dramatic dead trees on high cliff edges and rocky peaks
  const cliffEdgeSpots = [
    { x: -300, z: -750 },
    { x: -280, z: -800 },
    { x: 380, z: -400 },
    { x: 550, z: -200 },
    { x: 620, z: 200 },
    { x: -500, z: -50 },
    { x: -480, z: 120 },
    { x: -380, z: 420 },
  ];
  cliffEdgeSpots.forEach((spot) => {
    const y = getIslandElevation(spot.x, spot.z);
    if (y >= 3.0) {
      deadTreeTransforms.push({
        pos: new THREE.Vector3(spot.x, y, spot.z),
        rot: new THREE.Euler(0, rnd() * Math.PI * 2, 0),
        scale: new THREE.Vector3(1.3, 1.3, 1.3),
      });
    }
  });

  if (stylizedTreeModel) mapGroup.add(createInstancedMeshes(stylizedTreeModel, canopyTreeTransforms, false, true));
  if (birchModel) mapGroup.add(createInstancedMeshes(birchModel, birchTransforms, false, true));
  if (deadTreeModel) mapGroup.add(createInstancedMeshes(deadTreeModel, deadTreeTransforms, false, true));

  if (mapleModel) {
    const autumnModel = mapleModel.clone(true);
    autumnModel.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) {
        const mesh = child as THREE.Mesh;
        if (mesh.material) {
          const mat = (mesh.material as THREE.MeshStandardMaterial).clone();
          mat.color = new THREE.Color(0xff8c00);
          mesh.material = mat;
        }
      }
    });
    mapGroup.add(createInstancedMeshes(autumnModel, autumnMapleTransforms, false, true));
  }

  // =========================================================================
  // 8. DENSE 3D CLOVERS & WILDFLOWERS
  // =========================================================================
  onProgress?.("Planting 3D Clovers & Wildflowers in Town & Countryside...");

  const cloverGrassModel = await loadModel(CLOVER_GRASS);
  const grassSmallModel = await loadModel(`${BASE_NATURE}/Grass_Small.gltf`);
  const flowerClumpModel = await loadModel(`${BASE_NATURE}/Flower_1_Clump.gltf`);
  const bushFlowersGlb = await loadModel(BUSH_FLOWERS_GLB);

  const cloverTransforms: InstanceTransform[] = [];
  const grassTransforms: InstanceTransform[] = [];
  const flowerTransforms: InstanceTransform[] = [];
  const bushTransforms: InstanceTransform[] = [];

  // Clovers around the town plaza & roads
  for (let a = 0; a < Math.PI * 2; a += 0.22) {
    const rad = 28 + (rnd() - 0.5) * 8;
    const cx = Math.cos(a) * rad;
    const cz = Math.sin(a) * rad;
    const cy = getIslandElevation(cx, cz);
    if (cy >= 2.0) {
      cloverTransforms.push({
        pos: new THREE.Vector3(cx, cy, cz),
        rot: new THREE.Euler(0, rnd() * Math.PI * 2, 0),
        scale: new THREE.Vector3(0.9, 0.9, 0.9),
      });
      if (rnd() > 0.6) {
        bushTransforms.push({
          pos: new THREE.Vector3(cx + 1.2, cy, cz + 1.2),
          rot: new THREE.Euler(0, rnd() * Math.PI * 2, 0),
          scale: new THREE.Vector3(0.55, 0.55, 0.55),
        });
      }
    }
  }

  // Clovers, small grass tufts & wildflowers along roadsides and near buildings
  for (let i = 0; i < 220; i++) {
    const rx = (rnd() - 0.5) * 500;
    const rz = (rnd() - 0.5) * 500;
    const y = getIslandElevation(rx, rz);
    if (y < 2.0) continue;
    cloverTransforms.push({
      pos: new THREE.Vector3(rx, y, rz),
      rot: new THREE.Euler(0, rnd() * Math.PI * 2, 0),
      scale: new THREE.Vector3(0.85, 0.85, 0.85),
    });
    if (rnd() > 0.4) {
      grassTransforms.push({
        pos: new THREE.Vector3(rx + (rnd() - 0.5) * 2, y, rz + (rnd() - 0.5) * 2),
        rot: new THREE.Euler(0, rnd() * Math.PI * 2, 0),
        scale: new THREE.Vector3(0.9, 0.9, 0.9),
      });
    }
    if (rnd() > 0.75) {
      flowerTransforms.push({
        pos: new THREE.Vector3(rx + (rnd() - 0.5) * 3, y, rz + (rnd() - 0.5) * 3),
        rot: new THREE.Euler(0, rnd() * Math.PI * 2, 0),
        scale: new THREE.Vector3(0.7, 0.7, 0.7),
      });
    }
  }

  if (cloverGrassModel) mapGroup.add(createInstancedMeshes(cloverGrassModel, cloverTransforms, false, true));
  if (grassSmallModel) mapGroup.add(createInstancedMeshes(grassSmallModel, grassTransforms, false, true));
  if (flowerClumpModel) mapGroup.add(createInstancedMeshes(flowerClumpModel, flowerTransforms, false, true));
  if (bushFlowersGlb) mapGroup.add(createInstancedMeshes(bushFlowersGlb, bushTransforms, false, true));

  // =========================================================================
  // 9. ANIME BOULDERS, MOUNTAIN CRAGS & ROCK PINNACLES
  // =========================================================================
  onProgress?.("Sculpting Mountain Crags, Rocky Cliffs & Valley Boulders...");

  try {
    const stonesGltf = await gltfLoader.loadAsync(STONES_GLB);
    const stonesRoot = stonesGltf.scene;

    // Apply bright anime stone material textured with land_rock.png and clear corrupt black vertex colors
    const stoneMat = new THREE.MeshStandardMaterial({
      map: texRock,
      color: 0xdae2eb,
      roughness: 0.82,
      metalness: 0.05,
      side: THREE.DoubleSide,
    });
    stonesRoot.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) {
        const mesh = child as THREE.Mesh;
        if (mesh.geometry && mesh.geometry.attributes.color) {
          mesh.geometry.deleteAttribute("color");
        }
        mesh.material = stoneMat;
      }
    });

    const stonesTransforms: InstanceTransform[] = [];

    // A. Offshore Islet rock clusters:
    const isletSpots = [
      { x: -340, z: -860, count: 16 }, // North Rock
      { x: -680, z: -140, count: 14 }, // West Rock
      { x: 710, z: 1000, count: 18 },  // Southeast Reef
    ];

    isletSpots.forEach((islet) => {
      for (let i = 0; i < islet.count; i++) {
        const ix = islet.x + (rnd() - 0.5) * 45;
        const iz = islet.z + (rnd() - 0.5) * 45;
        const iy = getIslandElevation(ix, iz);
        const s = 2.0 + rnd() * 2.2;
        stonesTransforms.push({
          pos: new THREE.Vector3(ix, Math.max(iy, 0.8), iz),
          rot: new THREE.Euler(rnd() * 0.4, rnd() * Math.PI * 2, rnd() * 0.2),
          scale: new THREE.Vector3(s, s, s),
        });
      }
    });

    // B. Dramatic Mountain Peak Pinnacles & Rugged Crags
    const mountainCrags = [
      { x: 420, z: -350, count: 28, rad: 80, sMin: 2.8, sMax: 6.0 }, // Mount Rusticus (111m)
      { x: 520, z: 50,   count: 22, rad: 70, sMin: 2.4, sMax: 5.0 }, // East Summit (95m)
      { x: 580, z: -180, count: 18, rad: 60, sMin: 2.2, sMax: 4.5 }, // Eastern Sea Ridge (85m)
      { x: -120, z: -640, count: 20, rad: 65, sMin: 2.2, sMax: 4.8 }, // North Peninsula Peak (75m)
      { x: -440, z: 60,   count: 18, rad: 60, sMin: 2.0, sMax: 4.5 }, // West Coast Bluffs (58m)
      { x: 460, z: 320,  count: 16, rad: 55, sMin: 1.8, sMax: 4.0 }, // Southeast Highland (58m)
      { x: 300, z: -180, count: 14, rad: 50, sMin: 1.8, sMax: 3.8 }, // Foothill Ridge
      { x: -260, z: 650, count: 12, rad: 45, sMin: 1.6, sMax: 3.5 }, // Southwest Hill
      { x: 360, z: 680,  count: 14, rad: 50, sMin: 1.8, sMax: 3.8 }, // Southeast Hill
    ];

    mountainCrags.forEach((crag) => {
      for (let i = 0; i < crag.count; i++) {
        const cx = crag.x + (rnd() - 0.5) * crag.rad * 2;
        const cz = crag.z + (rnd() - 0.5) * crag.rad * 2;
        const cy = getIslandElevation(cx, cz);
        const s = crag.sMin + rnd() * (crag.sMax - crag.sMin);
        stonesTransforms.push({
          pos: new THREE.Vector3(cx, cy - 0.3, cz),
          rot: new THREE.Euler(rnd() * 0.5, rnd() * Math.PI * 2, rnd() * 0.3),
          scale: new THREE.Vector3(s, s * (0.9 + rnd() * 0.4), s),
        });
      }
    });

    // C. Valley, Meadow & Roadside Boulders (Ghibli / anime path style)
    for (let i = 0; i < 85; i++) {
      const a = rnd() * Math.PI * 2;
      const dist = 75 + rnd() * 220; // Around town outskirts & along outgoing roads
      const rx = Math.cos(a) * dist;
      const rz = Math.sin(a) * dist;
      const ry = getIslandElevation(rx, rz);
      if (ry >= 2.0) {
        const s = 1.0 + rnd() * 1.8;
        stonesTransforms.push({
          pos: new THREE.Vector3(rx, ry - 0.15, rz),
          rot: new THREE.Euler(rnd() * 0.2, rnd() * Math.PI * 2, rnd() * 0.1),
          scale: new THREE.Vector3(s, s, s),
        });
      }
    }

    // D. Perimeter Coastal Cliffs & Sea Stacks
    for (let i = 0; i < 140; i++) {
      const a = rnd() * Math.PI * 2;
      const rad = 650 + rnd() * 260;
      const bx = Math.cos(a) * rad;
      const bz = Math.sin(a) * rad;
      const by = getIslandElevation(bx, bz);
      if (by >= 0.2) {
        const s = 1.6 + rnd() * 2.2;
        stonesTransforms.push({
          pos: new THREE.Vector3(bx, Math.max(by - 0.2, 0.4), bz),
          rot: new THREE.Euler(rnd() * 0.3, rnd() * Math.PI * 2, 0),
          scale: new THREE.Vector3(s, s, s),
        });
      }
    }

    mapGroup.add(createInstancedMeshes(stonesRoot, stonesTransforms, false, true));
  } catch (err) {
    console.warn("Skipping anime stones:", err);
  }

  // =========================================================================
  // 10. SOUTHERN FARMLAND FENCES & CROPS
  // =========================================================================
  onProgress?.("Constructing Farmland Fences & Crop Fields...");

  const fenceGroup = new THREE.Group();
  fenceGroup.name = "FarmlandFences";
  const fenceMat = new THREE.MeshStandardMaterial({
    color: 0x926c48,
    roughness: 0.8,
  });

  const fields = [
    { cx: 80, cz: 420, w: 90, h: 70 },
    { cx: 200, cz: 460, w: 85, h: 65 },
    { cx: 310, cz: 500, w: 85, h: 65 },
    { cx: 45, cz: 550, w: 95, h: 75 },
    { cx: 170, cz: 590, w: 90, h: 70 },
    { cx: -70, cz: 630, w: 85, h: 65 },
  ];

  fields.forEach((f) => {
    const hw = f.w / 2;
    const hh = f.h / 2;
    const corners = [
      { x: f.cx - hw, z: f.cz - hh },
      { x: f.cx + hw, z: f.cz - hh },
      { x: f.cx + hw, z: f.cz + hh },
      { x: f.cx - hw, z: f.cz + hh },
    ];

    for (let c = 0; c < 4; c++) {
      const p1 = corners[c];
      const p2 = corners[(c + 1) % 4];
      const dx = p2.x - p1.x;
      const dz = p2.z - p1.z;
      const len = Math.sqrt(dx * dx + dz * dz);
      const angle = Math.atan2(dz, dx);
      const y = getIslandElevation((p1.x + p2.x) / 2, (p1.z + p2.z) / 2);

      const railGeo = new THREE.BoxGeometry(len, 0.12, 0.08);
      const rail = new THREE.Mesh(railGeo, fenceMat);
      rail.position.set((p1.x + p2.x) / 2, y + 0.5, (p1.z + p2.z) / 2);
      rail.rotation.y = -angle;
      fenceGroup.add(rail);

      // Corner posts
      const postGeo = new THREE.CylinderGeometry(0.08, 0.08, 0.9, 8);
      const post = new THREE.Mesh(postGeo, fenceMat);
      post.position.set(p1.x, getIslandElevation(p1.x, p1.z) + 0.45, p1.z);
      fenceGroup.add(post);
    }
  });
  mapGroup.add(fenceGroup);

  // =========================================================================
  // 11. VOLUMETRIC SUNBEAMS / GOD RAYS INTO TOWN SQUARE
  // =========================================================================
  const godRayGeo = new THREE.CylinderGeometry(0.2, 5.0, 45, 16, 1, true);
  const godRayMat = new THREE.MeshBasicMaterial({
    color: 0xffefb8,
    transparent: true,
    opacity: 0.05,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    depthWrite: false,
  });

  const godRayPositions = [
    { x: 10, y: 22, z: -10, rotZ: 0.35, rotX: -0.25 },
    { x: -15, y: 24, z: 12, rotZ: 0.38, rotX: -0.22 },
    { x: 5, y: 26, z: 25, rotZ: 0.32, rotX: -0.28 },
  ];

  godRayPositions.forEach((pos) => {
    const ray = new THREE.Mesh(godRayGeo, godRayMat);
    ray.position.set(pos.x, pos.y, pos.z);
    ray.rotation.z = pos.rotZ;
    ray.rotation.x = pos.rotX;
    mapGroup.add(ray);
  });

  // Stylized Fluffy Clouds on the Horizon
  const cloudMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.9,
    metalness: 0.0,
    flatShading: true,
  });

  for (let c = 0; c < 18; c++) {
    const angle = (c / 18) * Math.PI * 2;
    const dist = 2400 + Math.sin(c * 2.3) * 300;
    const cx = Math.cos(angle) * dist;
    const cz = Math.sin(angle) * dist;
    const cy = 200 + Math.sin(c * 1.7) * 50;

    const cloudCluster = new THREE.Group();
    const numPuffs = 4 + Math.floor(rnd() * 3);
    for (let p = 0; p < numPuffs; p++) {
      const puffGeo = new THREE.DodecahedronGeometry(55 + rnd() * 40, 1);
      const puffMesh = new THREE.Mesh(puffGeo, cloudMat);
      puffMesh.position.set(
        (rnd() - 0.5) * 120,
        (rnd() - 0.5) * 30,
        (rnd() - 0.5) * 120
      );
      puffMesh.scale.set(1.4, 0.75, 1.2);
      cloudCluster.add(puffMesh);
    }
    cloudCluster.position.set(cx, cy, cz);
    mapGroup.add(cloudCluster);
  }

  onProgress?.("RPG Island Map Ready!");
  return mapGroup;
}
