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
const GROUND_ASPHALT_TEXTURE = "/assets/3d/environment/Grounds%201-100/Ground%20(1).png";

export const MAP_SIZE = 3000; // 3km x 3km (-1500 to +1500)
export const CITY_RADIUS = 340; // Central city zone is 680m x 680m

// Height function for the 3km terrain with carved highway corridors
export function getTerrainHeight(x: number, z: number): number {
  const dist = Math.sqrt(x * x + z * z);
  if (dist < CITY_RADIUS) {
    return 0; // Flat city basin
  }

  // Carve flat highway corridors for the 4 cardinal highways (18m wide)
  const isEastWestHighway = Math.abs(z) < 9;
  const isNorthSouthHighway = Math.abs(x) < 9;
  if (isEastWestHighway || isNorthSouthHighway) {
    return 0.05;
  }

  const t = Math.min((dist - CITY_RADIUS) / (1500 - CITY_RADIUS), 1.0);

  // Rotate coordinates 37 degrees to break axis alignment & eliminate linear corrugated stripes
  const nx = x * 0.8 - z * 0.6;
  const nz = x * 0.6 + z * 0.8;

  // Multi-frequency organic rolling hills without artificial horizontal bands
  const hill1 = Math.sin(nx * 0.0035 + 0.5) * Math.cos(nz * 0.0042 + 1.2) * 18;
  const hill2 = Math.sin(nz * 0.007 + nx * 0.005) * 8;
  const hill3 = Math.cos(nx * 0.014 - nz * 0.011) * 3;

  const totalHills = (hill1 + hill2 + hill3) * t;
  const mountainRise = Math.pow(t, 2.2) * 46;

  return Math.max(0, totalHills + mountainRise);
}

interface InstanceTransform {
  pos: THREE.Vector3;
  rot?: THREE.Euler;
  scale?: THREE.Vector3;
}

// Efficiently build InstancedMesh with performance optimizations for low-end GPUs
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

  root.traverse((child) => {
    if ((child as THREE.Mesh).isMesh) {
      const mesh = child as THREE.Mesh;

      // Enable Early-Z and disable alpha sorting stalls on foliage
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
      // Disable shadow casting for distant instanced meshes to eliminate shadow-map bottlenecks on low-end GPUs
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
        inst.setMatrixAt(i, dummy.matrix);
      }
      inst.instanceMatrix.needsUpdate = true;
      group.add(inst);
    }
  });

  return group;
}

export async function create3kForestCityMap(
  scene: THREE.Scene,
  onProgress?: (text: string) => void
): Promise<THREE.Group> {
  const mapGroup = new THREE.Group();
  mapGroup.name = "Map3K_ForestCity";
  scene.add(mapGroup);

  const gltfLoader = new GLTFLoader();
  const texLoader = new THREE.TextureLoader();

  // Helper to load and cache models
  const modelCache = new Map<string, THREE.Group>();
  async function loadModel(path: string): Promise<THREE.Group | null> {
    if (modelCache.has(path)) return modelCache.get(path)!;
    try {
      const gltf = await gltfLoader.loadAsync(path);
      const root = gltf.scene;
      root.traverse((child) => {
        if ((child as THREE.Mesh).isMesh) {
          const mesh = child as THREE.Mesh;
          mesh.castShadow = false; // Fast default
          mesh.receiveShadow = true;
          if (mesh.material) {
            const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
            mats.forEach((m) => {
              m.side = THREE.DoubleSide;
              if ("roughness" in m) {
                (m as THREE.MeshStandardMaterial).roughness = Math.max(
                  (m as THREE.MeshStandardMaterial).roughness ?? 0.6,
                  0.4
                );
              }
            });
          }
        }
      });
      modelCache.set(path, root);
      return root;
    } catch (e) {
      console.warn("Failed loading model:", path, e);
      return null;
    }
  }

  onProgress?.("Loading Seamless Ground Textures...");

  // =========================================================================
  // 1. 3KM x 3KM TERRAIN WITH REAL GROUND TEXTURE
  // =========================================================================
  let groundTexture: THREE.Texture | null = null;
  try {
    groundTexture = await texLoader.loadAsync(GROUND_GRASS_TEXTURE);
    groundTexture.wrapS = THREE.RepeatWrapping;
    groundTexture.wrapT = THREE.RepeatWrapping;
    groundTexture.repeat.set(75, 75);
    groundTexture.colorSpace = THREE.SRGBColorSpace;
    groundTexture.generateMipmaps = true;
    groundTexture.anisotropy = 8;
    groundTexture.minFilter = THREE.LinearMipmapLinearFilter;
    groundTexture.magFilter = THREE.LinearFilter;
  } catch (err) {
    console.warn("Failed to load ground grass texture:", err);
  }

  // Optimized segment count (100x100 = 10k vertices) for high 60fps performance on low-end devices
  const segments = 100;
  const terrainGeo = new THREE.PlaneGeometry(MAP_SIZE, MAP_SIZE, segments, segments);
  terrainGeo.rotateX(-Math.PI / 2);

  const posAttr = terrainGeo.attributes.position;
  const colors: number[] = [];
  const cityColor = new THREE.Color(0x2a323d); // Dark urban asphalt
  const meadowGreen = new THREE.Color(0x82c870); // Lush bright anime meadow
  const forestDark = new THREE.Color(0x5a9e4e); // Deep forest green
  const mountainRock = new THREE.Color(0x8a9ba8); // Mountain stone ridge

  for (let i = 0; i < posAttr.count; i++) {
    const x = posAttr.getX(i);
    const z = posAttr.getZ(i);
    const y = getTerrainHeight(x, z);
    posAttr.setY(i, y);

    const dist = Math.sqrt(x * x + z * z);
    const col = new THREE.Color();

    const onHighway = (Math.abs(z) < 8.5 && Math.abs(x) >= CITY_RADIUS) ||
                      (Math.abs(x) < 8.5 && Math.abs(z) >= CITY_RADIUS);

    if (dist < CITY_RADIUS - 30) {
      col.copy(cityColor);
    } else if (onHighway) {
      col.copy(cityColor);
    } else if (dist < CITY_RADIUS + 60) {
      const alpha = (dist - (CITY_RADIUS - 30)) / 90;
      col.copy(cityColor).lerp(meadowGreen, alpha);
    } else {
      // Smooth organic gradient from meadow into mountain peaks without sharp elevation bands
      const tPeak = Math.max(0, Math.min((dist - 900) / 550, 1.0));
      col.copy(meadowGreen).lerp(forestDark, 0.4).lerp(mountainRock, tPeak);
    }
    colors.push(col.r, col.g, col.b);
  }

  terrainGeo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  terrainGeo.computeVertexNormals();

  const terrainMat = new THREE.MeshStandardMaterial({
    map: groundTexture,
    vertexColors: true,
    roughness: 0.8,
    metalness: 0.05,
  });
  const terrainMesh = new THREE.Mesh(terrainGeo, terrainMat);
  terrainMesh.receiveShadow = true;
  terrainMesh.position.y = -0.04;
  mapGroup.add(terrainMesh);

  // =========================================================================
  // 2. CITY ROAD NETWORK (Center 680m x 680m + 4 Main Highways to Borders)
  // =========================================================================
  onProgress?.("Constructing Highways & Street Grid...");

  const roadCrosswalkModel = await loadModel(`${BASE_STREET}/SM_Ground_RoadCrosswalk_700x400_01.gltf`);
  const roadYellowModel = await loadModel(`${BASE_STREET}/SM_Ground_Road_700x1000_Yellow_01.gltf`);
  const roadStopModel = await loadModel(`${BASE_STREET}/SM_Ground_RoadStop_700x200_R_01.gltf`);
  const roadJunctionModel = await loadModel(`${BASE_STREET}/SM_Ground_RoadJunction_700x400_01.gltf`);
  const sidewalkPlainModel = await loadModel(`${BASE_STREET}/SM_Ground_Sidewalk_200x200_01.gltf`);
  const sidewalkYellowModel = await loadModel(`${BASE_STREET}/SM_Ground_Sidewalk_200x200_Yellow_01.gltf`);

  const roadYellowTransforms: InstanceTransform[] = [];
  const roadCrosswalkTransforms: InstanceTransform[] = [];
  const roadStopTransforms: InstanceTransform[] = [];
  const roadJunctionTransforms: InstanceTransform[] = [];
  const sidewalkPlainTransforms: InstanceTransform[] = [];
  const sidewalkYellowTransforms: InstanceTransform[] = [];

  // Main East-West Boulevard (Z = 0) spanning from X = -340 to +340
  for (let x = -340; x <= 340; x += 10) {
    if (x === 0) {
      // Main Center Crosswalk where hero stands
      roadCrosswalkTransforms.push({ pos: new THREE.Vector3(-2, 0, -3.5) });
      roadStopTransforms.push({ pos: new THREE.Vector3(-4, 0, -3.5) });
      roadStopTransforms.push({ pos: new THREE.Vector3(2, 0, -3.5), rot: new THREE.Euler(0, Math.PI, 0) });
    } else if (Math.abs(x) === 120 || Math.abs(x) === 240) {
      if (roadJunctionModel) {
        roadJunctionTransforms.push({ pos: new THREE.Vector3(x, 0, -3.5) });
      }
    } else {
      roadYellowTransforms.push({ pos: new THREE.Vector3(x, 0, -3.5) });
    }
  }

  // North-South Boulevard (X = 0) spanning from Z = -340 to +340
  for (let z = -340; z <= 340; z += 10) {
    if (Math.abs(z) > 10) {
      roadYellowTransforms.push({
        pos: new THREE.Vector3(3.5, 0, z),
        rot: new THREE.Euler(0, Math.PI / 2, 0),
      });
    }
  }

  // Secondary City Avenues: Z = -120 and Z = +120
  for (let x = -280; x <= 280; x += 10) {
    roadYellowTransforms.push({ pos: new THREE.Vector3(x, 0, -120 - 3.5) });
    roadYellowTransforms.push({ pos: new THREE.Vector3(x, 0, 120 - 3.5) });
  }

  // Secondary Cross Streets: X = -120 and X = +120
  for (let z = -280; z <= 280; z += 10) {
    if (Math.abs(z) > 15 && Math.abs(z) !== 120) {
      roadYellowTransforms.push({
        pos: new THREE.Vector3(-120 + 3.5, 0, z),
        rot: new THREE.Euler(0, Math.PI / 2, 0),
      });
      roadYellowTransforms.push({
        pos: new THREE.Vector3(120 + 3.5, 0, z),
        rot: new THREE.Euler(0, Math.PI / 2, 0),
      });
    }
  }

  // 4 Grand Highways reaching outwards from the City into the 3km Forest:
  // West Highway (X: -340 to -1480)
  for (let x = -350; x >= -1480; x -= 10) {
    roadYellowTransforms.push({ pos: new THREE.Vector3(x, 0.05, -3.5) });
  }
  // East Highway (X: 340 to 1480)
  for (let x = 350; x <= 1480; x += 10) {
    roadYellowTransforms.push({ pos: new THREE.Vector3(x, 0.05, -3.5) });
  }
  // North Highway (Z: -340 to -1480)
  for (let z = -350; z >= -1480; z -= 10) {
    roadYellowTransforms.push({
      pos: new THREE.Vector3(3.5, 0.05, z),
      rot: new THREE.Euler(0, Math.PI / 2, 0),
    });
  }
  // South Highway (Z: 340 to 1480)
  for (let z = 350; z <= 1480; z += 10) {
    roadYellowTransforms.push({
      pos: new THREE.Vector3(3.5, 0.05, z),
      rot: new THREE.Euler(0, Math.PI / 2, 0),
    });
  }

  // Sidewalks lining the Central Grand Avenue (X: -160 to +160)
  for (let x = -160; x <= 160; x += 2) {
    const isTactile = (x >= -4 && x <= 4) || (Math.abs(x - 120) <= 4) || (Math.abs(x + 120) <= 4);
    if (isTactile) {
      sidewalkYellowTransforms.push({ pos: new THREE.Vector3(x, 0, -5.5) });
      sidewalkYellowTransforms.push({
        pos: new THREE.Vector3(x + 2, 0, 5.5),
        rot: new THREE.Euler(0, Math.PI, 0),
      });
    } else {
      sidewalkPlainTransforms.push({ pos: new THREE.Vector3(x, 0, -5.5) });
      sidewalkPlainTransforms.push({
        pos: new THREE.Vector3(x + 2, 0, 5.5),
        rot: new THREE.Euler(0, Math.PI, 0),
      });
    }
  }

  if (roadYellowModel) mapGroup.add(createInstancedMeshes(roadYellowModel, roadYellowTransforms, false, true));
  if (roadCrosswalkModel) mapGroup.add(createInstancedMeshes(roadCrosswalkModel, roadCrosswalkTransforms, false, true));
  if (roadStopModel) mapGroup.add(createInstancedMeshes(roadStopModel, roadStopTransforms, false, true));
  if (roadJunctionModel) mapGroup.add(createInstancedMeshes(roadJunctionModel, roadJunctionTransforms, false, true));
  if (sidewalkPlainModel) mapGroup.add(createInstancedMeshes(sidewalkPlainModel, sidewalkPlainTransforms, false, true));
  if (sidewalkYellowModel) mapGroup.add(createInstancedMeshes(sidewalkYellowModel, sidewalkYellowTransforms, false, true));

  // =========================================================================
  // 3. CITY BUILDINGS & MULTI-STOREY JAPANESE METROPOLIS
  // =========================================================================
  onProgress?.("Loading City Buildings...");

  const garageModel = await loadModel(`${BASE_STREET}/SM_Floor_NarrowGarage_455_01.gltf`);
  const garageWideModel = await loadModel(`${BASE_STREET}/SM_Floor_NarrowGarageWide_455_01.gltf`);
  const livingModel = await loadModel(`${BASE_STREET}/SM_Floor_NarrowLiving_364_01.gltf`);
  const upperWindowModel = await loadModel(`${BASE_STREET}/SM_Floor_NarrowUpperWindow_White_455_01.gltf`);
  const upperBalconyModel = await loadModel(`${BASE_STREET}/SM_Floor_NarrowUpperBalcony_White_455_01.gltf`);
  const roofPlainModel = await loadModel(`${BASE_STREET}/SM_Roof_NarrowFlatPlain_White_455_01.gltf`);

  const garageTransforms: InstanceTransform[] = [];
  const garageWideTransforms: InstanceTransform[] = [];
  const livingTransforms: InstanceTransform[] = [];
  const upperWindowTransforms: InstanceTransform[] = [];
  const upperBalconyTransforms: InstanceTransform[] = [];
  const roofTransforms: InstanceTransform[] = [];

  function placeBuilding(x: number, z: number, rotY = 0, storeys = 2, variant = 0) {
    const rot = new THREE.Euler(0, rotY, 0);

    if (variant === 0) {
      garageTransforms.push({ pos: new THREE.Vector3(x, 0, z), rot });
    } else if (variant === 1) {
      garageWideTransforms.push({ pos: new THREE.Vector3(x, 0, z), rot });
    } else {
      livingTransforms.push({ pos: new THREE.Vector3(x, 0, z), rot });
    }

    for (let s = 1; s < storeys; s++) {
      const y = s * 3;
      if (s % 2 === 1) {
        upperBalconyTransforms.push({ pos: new THREE.Vector3(x, y, z), rot });
      } else {
        upperWindowTransforms.push({ pos: new THREE.Vector3(x, y, z), rot });
      }
    }

    roofTransforms.push({ pos: new THREE.Vector3(x, storeys * 3, z), rot });
  }

  // Row A: North of Grand Avenue (Z = -5.5, along the sidewalk)
  const northStreetBuildings = [
    { x: -11.5, storeys: 3, v: 0 },
    { x: -6.95, storeys: 2, v: 2 },
    { x: -3.3, storeys: 2, v: 1 },
    { x: 1.25, storeys: 3, v: 2 },
    { x: 4.9, storeys: 2, v: 0 },
    { x: 9.45, storeys: 3, v: 1 },
    { x: 14.5, storeys: 2, v: 0 },
    { x: -16.5, storeys: 2, v: 1 },
    { x: -21.5, storeys: 3, v: 0 },
    { x: 19.5, storeys: 3, v: 2 },
    { x: 24.5, storeys: 2, v: 1 },
    { x: -26.5, storeys: 2, v: 0 },
  ];
  northStreetBuildings.forEach((b) => placeBuilding(b.x, -5.5, 0, b.storeys, b.v));

  // Row B: South of Grand Avenue (Z = 5.5, facing the street)
  const southStreetBuildings = [
    { x: -14.5, storeys: 2, v: 1 },
    { x: -9.5, storeys: 3, v: 0 },
    { x: -4.5, storeys: 2, v: 2 },
    { x: 2.5, storeys: 2, v: 0 },
    { x: 7.5, storeys: 3, v: 1 },
    { x: 12.5, storeys: 2, v: 2 },
    { x: 17.5, storeys: 3, v: 0 },
    { x: -19.5, storeys: 2, v: 1 },
    { x: 22.5, storeys: 2, v: 1 },
    { x: -24.5, storeys: 3, v: 0 },
  ];
  southStreetBuildings.forEach((b) => placeBuilding(b.x, 5.5, Math.PI, b.storeys, b.v));

  // Downtown blocks across the city grid (-180m to +180m)
  for (let bx = -160; bx <= 160; bx += 38) {
    for (let bz = -160; bz <= 160; bz += 40) {
      if (Math.abs(bz) < 18 || Math.abs(bx) < 18) continue;
      if (Math.abs(bz - 120) < 18 || Math.abs(bz + 120) < 18) continue;
      if (Math.abs(bx - 120) < 18 || Math.abs(bx + 120) < 18) continue;

      const storeys = ((Math.abs(bx * 7 + bz * 13)) % 3) + 2;
      const variant = ((Math.abs(bx * 3 + bz * 5)) % 3);
      const rotY = ((bx + bz) % 2 === 0) ? 0 : Math.PI / 2;
      placeBuilding(bx, bz, rotY, storeys, variant);
    }
  }

  if (garageModel) mapGroup.add(createInstancedMeshes(garageModel, garageTransforms, false, true));
  if (garageWideModel) mapGroup.add(createInstancedMeshes(garageWideModel, garageWideTransforms, false, true));
  if (livingModel) mapGroup.add(createInstancedMeshes(livingModel, livingTransforms, false, true));
  if (upperWindowModel) mapGroup.add(createInstancedMeshes(upperWindowModel, upperWindowTransforms, false, true));
  if (upperBalconyModel) mapGroup.add(createInstancedMeshes(upperBalconyModel, upperBalconyTransforms, false, true));
  if (roofPlainModel) mapGroup.add(createInstancedMeshes(roofPlainModel, roofTransforms, false, true));

  // =========================================================================
  // 4. CITY STREET FURNITURE & PROPS (Vending Machines, Signals, Bikes, Signs)
  // =========================================================================
  onProgress?.("Deploying Street Props & Furniture...");

  const vendingBlueModel = await loadModel(`${BASE_STREET}/SM_Street_Vending_HD_Blue_103_01.gltf`);
  const vendingRedModel = await loadModel(`${BASE_STREET}/SM_Street_Vending_HD_Red_103_01.gltf`);
  const trafficSignalModel = await loadModel(`${BASE_STREET}/SM_Street_TrafficSignal_Galv_300_01.gltf`);
  const tomareSignModel = await loadModel(`${BASE_STREET}/SM_Street_Sign_Tomare_01.gltf`);
  const bicycleSilverModel = await loadModel(`${BASE_STREET}/SM_Street_Bicycle_Plain_Silver_01.gltf`);
  const bollardModel = await loadModel(`${BASE_STREET}/SM_Street_Bollard_Fixed_01.gltf`);
  const mirrorModel = await loadModel(`${BASE_STREET}/SM_Street_CurveMirror_Round_Single_01.gltf`);
  const coneModel = await loadModel(`${BASE_STREET}/SM_Street_Cone_01.gltf`);

  const vendingBlueTransforms: InstanceTransform[] = [];
  const vendingRedTransforms: InstanceTransform[] = [];
  const trafficSignalTransforms: InstanceTransform[] = [];
  const tomareSignTransforms: InstanceTransform[] = [];
  const bicycleTransforms: InstanceTransform[] = [];
  const bollardTransforms: InstanceTransform[] = [];
  const mirrorTransforms: InstanceTransform[] = [];
  const coneTransforms: InstanceTransform[] = [];

  // Hero player area vending machines (these cast shadows right in front of the camera!)
  vendingBlueTransforms.push({ pos: new THREE.Vector3(2.5, 0.15, -4.5) });
  vendingRedTransforms.push({ pos: new THREE.Vector3(3.7, 0.15, -4.5) });
  vendingBlueTransforms.push({ pos: new THREE.Vector3(-8.5, 0.15, -4.5) });
  vendingRedTransforms.push({ pos: new THREE.Vector3(12.5, 0.15, -4.5) });

  // Additional vending machines at downtown corners
  for (let x = -140; x <= 140; x += 45) {
    if (x === 0) continue;
    vendingBlueTransforms.push({ pos: new THREE.Vector3(x, 0.15, -4.5) });
    vendingRedTransforms.push({ pos: new THREE.Vector3(x + 1.2, 0.15, -4.5) });
  }

  // Traffic signals & stop signs
  trafficSignalTransforms.push({
    pos: new THREE.Vector3(-2.1, 0.15, -3.6),
    rot: new THREE.Euler(0, Math.PI / 2, 0),
  });
  trafficSignalTransforms.push({
    pos: new THREE.Vector3(118, 0.15, -3.6),
    rot: new THREE.Euler(0, Math.PI / 2, 0),
  });
  trafficSignalTransforms.push({
    pos: new THREE.Vector3(-122, 0.15, -3.6),
    rot: new THREE.Euler(0, Math.PI / 2, 0),
  });

  tomareSignTransforms.push({ pos: new THREE.Vector3(2.2, 0.15, 3.6), rot: new THREE.Euler(0, Math.PI, 0) });
  tomareSignTransforms.push({ pos: new THREE.Vector3(-2.2, 0.15, -3.6) });
  mirrorTransforms.push({ pos: new THREE.Vector3(-3.6, 0.15, -3.6), rot: new THREE.Euler(0, Math.PI / 4, 0) });

  // Parked bicycles
  bicycleTransforms.push({ pos: new THREE.Vector3(1.3, 0.15, -4.4), rot: new THREE.Euler(0, -0.2, 0) });
  bicycleTransforms.push({ pos: new THREE.Vector3(-5.2, 0.15, -4.4), rot: new THREE.Euler(0, 0.3, 0) });

  // Bollards along pedestrian crossing curbs
  const heroBollards = [-2.1, 2.1];
  heroBollards.forEach((bx) => {
    bollardTransforms.push({ pos: new THREE.Vector3(bx, 0.15, -3.55) });
    bollardTransforms.push({ pos: new THREE.Vector3(bx, 0.15, 3.55) });
  });

  // Cones near hero area
  coneTransforms.push({ pos: new THREE.Vector3(0.9, 0, -3.2) });
  coneTransforms.push({ pos: new THREE.Vector3(1.3, 0, -3.2) });

  // Only hero area props cast shadow for maximum 60fps performance on low-end
  if (vendingBlueModel) mapGroup.add(createInstancedMeshes(vendingBlueModel, vendingBlueTransforms, true, true));
  if (vendingRedModel) mapGroup.add(createInstancedMeshes(vendingRedModel, vendingRedTransforms, true, true));
  if (trafficSignalModel) mapGroup.add(createInstancedMeshes(trafficSignalModel, trafficSignalTransforms, true, true));
  if (tomareSignModel) mapGroup.add(createInstancedMeshes(tomareSignModel, tomareSignTransforms, true, true));
  if (bicycleSilverModel) mapGroup.add(createInstancedMeshes(bicycleSilverModel, bicycleTransforms, true, true));
  if (bollardModel) mapGroup.add(createInstancedMeshes(bollardModel, bollardTransforms, false, true));
  if (mirrorModel) mapGroup.add(createInstancedMeshes(mirrorModel, mirrorTransforms, false, true));
  if (coneModel) mapGroup.add(createInstancedMeshes(coneModel, coneTransforms, false, true));

  // =========================================================================
  // 5. CITY SAKURA & GINKGO TREES
  // =========================================================================
  const sakuraModel = await loadModel(`${BASE_STREET}/SM_Street_Tree_Sakura_S_01.gltf`);
  const ginkgoModel = await loadModel(`${BASE_STREET}/SM_Street_Tree_Ginkgo_S_01.gltf`);

  const sakuraTransforms: InstanceTransform[] = [];
  const ginkgoTransforms: InstanceTransform[] = [];

  for (let x = -200; x <= 200; x += 24) {
    if (Math.abs(x) < 2) continue;
    const isSakura = Math.abs(x) % 48 === 0 || Math.abs(x) < 14;
    if (isSakura) {
      sakuraTransforms.push({ pos: new THREE.Vector3(x, 0.15, -4.5) });
      sakuraTransforms.push({ pos: new THREE.Vector3(x, 0.15, 4.5) });
    } else {
      ginkgoTransforms.push({ pos: new THREE.Vector3(x, 0.15, -4.5) });
      ginkgoTransforms.push({ pos: new THREE.Vector3(x, 0.15, 4.5) });
    }
  }

  if (sakuraModel) mapGroup.add(createInstancedMeshes(sakuraModel, sakuraTransforms, false, true));
  if (ginkgoModel) mapGroup.add(createInstancedMeshes(ginkgoModel, ginkgoTransforms, false, true));

  // =========================================================================
  // 6. VAST 3KM FOREST: USING THE NEW STYLIZED ANIME TREES & LOW-POLY TREES
  // =========================================================================
  onProgress?.("Planting Stylized Trees & 3km Forest...");

  const stylizedTreeModel = await loadModel(STYLIZED_TREE);
  const birchModel = await loadModel(`${BASE_NATURE}/BirchTree_1.gltf`);
  const mapleModel = await loadModel(`${BASE_NATURE}/MapleTree_1.gltf`);
  const deadTreeModel = await loadModel(`${BASE_NATURE}/DeadTree_1.gltf`);

  const stylizedTreeTransforms: InstanceTransform[] = [];
  const birchTransforms: InstanceTransform[] = [];
  const mapleTransforms: InstanceTransform[] = [];
  const deadTreeTransforms: InstanceTransform[] = [];

  let seed = 42;
  function rnd(): number {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  }

  // Optimized tree count: ~850 trees across the 3km map for smooth 60fps on low-end
  const totalTrees = 850;
  for (let i = 0; i < totalTrees; i++) {
    const rx = (rnd() - 0.5) * (MAP_SIZE - 90);
    const rz = (rnd() - 0.5) * (MAP_SIZE - 90);
    const dist = Math.sqrt(rx * rx + rz * rz);

    if (dist < CITY_RADIUS + 20) continue;
    if (Math.abs(rz) < 14 && Math.abs(rx) > CITY_RADIUS) continue;
    if (Math.abs(rx) < 14 && Math.abs(rz) > CITY_RADIUS) continue;

    const y = getTerrainHeight(rx, rz);
    const rot = new THREE.Euler(0, rnd() * Math.PI * 2, 0);
    const treeChoice = rnd();

    if (treeChoice > 0.45 && stylizedTreeModel) {
      // User's stylized anime tree! (scale ~0.014 to 0.02)
      const s = 0.014 + rnd() * 0.008;
      stylizedTreeTransforms.push({
        pos: new THREE.Vector3(rx, y, rz),
        rot,
        scale: new THREE.Vector3(s, s, s),
      });
    } else if (treeChoice > 0.22) {
      const s = 1.0 + rnd() * 0.7;
      birchTransforms.push({
        pos: new THREE.Vector3(rx, y, rz),
        rot,
        scale: new THREE.Vector3(s, s, s),
      });
    } else if (treeChoice > 0.08) {
      const s = 1.0 + rnd() * 0.7;
      mapleTransforms.push({
        pos: new THREE.Vector3(rx, y, rz),
        rot,
        scale: new THREE.Vector3(s, s, s),
      });
    } else {
      const s = 1.2 + rnd() * 0.5;
      deadTreeTransforms.push({
        pos: new THREE.Vector3(rx, y, rz),
        rot,
        scale: new THREE.Vector3(s, s, s),
      });
    }
  }

  if (stylizedTreeModel) mapGroup.add(createInstancedMeshes(stylizedTreeModel, stylizedTreeTransforms, false, true));
  if (birchModel) mapGroup.add(createInstancedMeshes(birchModel, birchTransforms, false, true));
  if (mapleModel) mapGroup.add(createInstancedMeshes(mapleModel, mapleTransforms, false, true));
  if (deadTreeModel) mapGroup.add(createInstancedMeshes(deadTreeModel, deadTreeTransforms, false, true));

  // =========================================================================
  // 7. LUSH STYLIZED CLOVER GRASS & FLOWERING BUSHES (User's Uploaded Assets)
  // =========================================================================
  onProgress?.("Distributing Stylized Clover Grass & Flowers...");

  const cloverGrassModel = await loadModel(CLOVER_GRASS);
  const cloverModel = await loadModel(CLOVER_GLB);
  const bushFlowersGlb = await loadModel(BUSH_FLOWERS_GLB);

  const cloverGrassTransforms: InstanceTransform[] = [];
  const cloverTransforms: InstanceTransform[] = [];
  const bushTransforms: InstanceTransform[] = [];

  // Hero area clover grass & flower bushes along the sidewalks
  if (cloverGrassModel) {
    cloverGrassTransforms.push({ pos: new THREE.Vector3(-3.8, 0.15, -4.2), scale: new THREE.Vector3(0.015, 0.015, 0.015) });
    cloverGrassTransforms.push({ pos: new THREE.Vector3(6.8, 0.15, -4.2), scale: new THREE.Vector3(0.015, 0.015, 0.015) });
    cloverGrassTransforms.push({ pos: new THREE.Vector3(-1.8, 0.15, 4.3), scale: new THREE.Vector3(0.015, 0.015, 0.015) });
    cloverGrassTransforms.push({ pos: new THREE.Vector3(4.8, 0.15, 4.3), scale: new THREE.Vector3(0.015, 0.015, 0.015) });
  }

  if (cloverModel) {
    cloverTransforms.push({ pos: new THREE.Vector3(-2.8, 0.15, -4.3), scale: new THREE.Vector3(0.8, 0.8, 0.8) });
    cloverTransforms.push({ pos: new THREE.Vector3(5.8, 0.15, -4.3), scale: new THREE.Vector3(0.8, 0.8, 0.8) });
  }

  if (bushFlowersGlb) {
    bushTransforms.push({ pos: new THREE.Vector3(-3.8, 0.15, -4.1), scale: new THREE.Vector3(0.9, 0.9, 0.9) });
    bushTransforms.push({ pos: new THREE.Vector3(6.8, 0.15, -4.1), scale: new THREE.Vector3(0.9, 0.9, 0.9) });
    bushTransforms.push({ pos: new THREE.Vector3(-8.8, 0.15, -4.1), scale: new THREE.Vector3(0.8, 0.8, 0.8) });
  }

  // Optimized distribution across the forest transition (~550 instances for light GPU load)
  for (let i = 0; i < 550; i++) {
    const rx = (rnd() - 0.5) * (MAP_SIZE - 120);
    const rz = (rnd() - 0.5) * (MAP_SIZE - 120);
    const dist = Math.sqrt(rx * rx + rz * rz);

    if (dist < CITY_RADIUS + 10) continue;
    if (Math.abs(rz) < 10 || Math.abs(rx) < 10) continue;

    const y = getTerrainHeight(rx, rz);
    const rot = new THREE.Euler(0, rnd() * Math.PI * 2, 0);
    const choice = rnd();

    if (choice < 0.45 && cloverGrassModel) {
      const s = 0.012 + rnd() * 0.012;
      cloverGrassTransforms.push({
        pos: new THREE.Vector3(rx, y, rz),
        rot,
        scale: new THREE.Vector3(s, s, s),
      });
    } else if (choice < 0.75 && bushFlowersGlb) {
      const s = 0.8 + rnd() * 0.6;
      bushTransforms.push({
        pos: new THREE.Vector3(rx, y, rz),
        rot,
        scale: new THREE.Vector3(s, s, s),
      });
    } else if (cloverModel) {
      const s = 0.7 + rnd() * 0.7;
      cloverTransforms.push({
        pos: new THREE.Vector3(rx, y, rz),
        rot,
        scale: new THREE.Vector3(s, s, s),
      });
    }
  }

  if (cloverGrassModel) mapGroup.add(createInstancedMeshes(cloverGrassModel, cloverGrassTransforms, false, true));
  if (bushFlowersGlb) mapGroup.add(createInstancedMeshes(bushFlowersGlb, bushTransforms, false, true));
  if (cloverModel) mapGroup.add(createInstancedMeshes(cloverModel, cloverTransforms, false, true));

  // =========================================================================
  // 8. ANIME BOULDERS & ROCK FORMATIONS
  // =========================================================================
  onProgress?.("Placing Anime Boulders & Highlands...");

  try {
    const stonesGltf = await gltfLoader.loadAsync(STONES_GLB);
    const stonesRoot = stonesGltf.scene;
    const stonesTransforms: InstanceTransform[] = [];

    // Hero area boulders
    stonesTransforms.push({
      pos: new THREE.Vector3(-6, 0.15, 4.5),
      scale: new THREE.Vector3(0.7, 0.7, 0.7),
    });
    stonesTransforms.push({
      pos: new THREE.Vector3(7, 0.15, 4.6),
      rot: new THREE.Euler(0, Math.PI, 0),
      scale: new THREE.Vector3(0.6, 0.6, 0.6),
    });

    // ~160 anime boulders on rolling hills across 3km
    for (let i = 0; i < 160; i++) {
      const rx = (rnd() - 0.5) * (MAP_SIZE - 120);
      const rz = (rnd() - 0.5) * (MAP_SIZE - 120);
      const dist = Math.sqrt(rx * rx + rz * rz);

      if (dist < CITY_RADIUS + 15) continue;
      const y = getTerrainHeight(rx, rz);
      const s = 0.8 + rnd() * 1.6;

      stonesTransforms.push({
        pos: new THREE.Vector3(rx, y, rz),
        rot: new THREE.Euler(0, rnd() * Math.PI * 2, 0),
        scale: new THREE.Vector3(s, s, s),
      });
    }

    mapGroup.add(createInstancedMeshes(stonesRoot, stonesTransforms, false, true));
  } catch (err) {
    console.warn("Skipping anime stones instancing:", err);
  }

  onProgress?.("Optimized 3km Forest & City Map Ready!");
  return mapGroup;
}
