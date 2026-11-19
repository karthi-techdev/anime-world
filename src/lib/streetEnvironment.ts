import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

const BASE_PATH = "/assets/3d/environment/JapanStreetModularPackLite_glTF/JapanStreetModularPackLite/glTF";
const NATURE_PATH = "/assets/3d/environment/trees_grass_rocks/glTF";
const STONES_PATH = "/assets/3d/environment/Anime_stones.glb";

interface ModelInstanceDef {
  file: string;
  pos: [number, number, number];
  rot?: [number, number, number];
  scale?: [number, number, number];
  receiveOnly?: boolean;
}

export async function createStreetEnvironment(scene: THREE.Scene, onProgress?: (msg: string) => void): Promise<THREE.Group> {
  const envGroup = new THREE.Group();
  envGroup.name = "AnimeStreetEnvironment";
  scene.add(envGroup);

  const loader = new GLTFLoader();

  // Cache loaded glTF scenes so we can clone them for modular tiling
  const modelCache = new Map<string, THREE.Group>();

  async function loadCached(path: string): Promise<THREE.Group | null> {
    if (modelCache.has(path)) {
      return modelCache.get(path)!.clone(true);
    }
    try {
      const gltf = await loader.loadAsync(path);
      const root = gltf.scene;

      root.traverse((child) => {
        if ((child as THREE.Mesh).isMesh) {
          const mesh = child as THREE.Mesh;
          mesh.castShadow = true;
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
      return root.clone(true);
    } catch (err) {
      console.warn("Failed to load environment asset:", path, err);
      return null;
    }
  }

  onProgress?.("Constructing Japanese Street Environment...");

  // 1. ROADS (Asphalt, markings, crosswalk)
  // Crosswalk at center (size 4m x 7m)
  const roadDefs: ModelInstanceDef[] = [
    // Crosswalk at origin
    { file: `${BASE_PATH}/SM_Ground_RoadCrosswalk_700x400_01.gltf`, pos: [-2, 0, -3.5], receiveOnly: true },
    // Stop line tiles
    { file: `${BASE_PATH}/SM_Ground_RoadStop_700x200_R_01.gltf`, pos: [-4, 0, -3.5], receiveOnly: true },
    // Westbound road stretches
    { file: `${BASE_PATH}/SM_Ground_Road_700x1000_Yellow_01.gltf`, pos: [-14, 0, -3.5], receiveOnly: true },
    { file: `${BASE_PATH}/SM_Ground_Road_700x1000_Yellow_01.gltf`, pos: [-24, 0, -3.5], receiveOnly: true },
    // Eastbound road stretches
    { file: `${BASE_PATH}/SM_Ground_Road_700x1000_Yellow_01.gltf`, pos: [2, 0, -3.5], receiveOnly: true },
    { file: `${BASE_PATH}/SM_Ground_Road_700x1000_Yellow_01.gltf`, pos: [12, 0, -3.5], receiveOnly: true },
  ];

  // 2. SIDEWALKS (North side z = -5.5 to -3.5; South side z = 3.5 to 5.5)
  const sidewalkDefs: ModelInstanceDef[] = [];
  // North sidewalk (-24 to +22 in 2m intervals)
  for (let x = -24; x <= 20; x += 2) {
    const isTactile = x >= -3 && x <= 3;
    sidewalkDefs.push({
      file: isTactile
        ? `${BASE_PATH}/SM_Ground_Sidewalk_200x200_Yellow_01.gltf`
        : `${BASE_PATH}/SM_Ground_Sidewalk_200x200_01.gltf`,
      pos: [x, 0, -5.5],
      receiveOnly: true,
    });
  }

  // South sidewalk (-24 to +22 in 2m intervals, rotated 180 deg so curb faces road)
  for (let x = -24; x <= 20; x += 2) {
    const isTactile = x >= -3 && x <= 3;
    sidewalkDefs.push({
      file: isTactile
        ? `${BASE_PATH}/SM_Ground_Sidewalk_200x200_Yellow_01.gltf`
        : `${BASE_PATH}/SM_Ground_Sidewalk_200x200_01.gltf`,
      pos: [x + 2, 0, 5.5],
      rot: [0, Math.PI, 0],
      receiveOnly: true,
    });
  }

  // 3. BACKGROUND JAPANESE RESIDENTIAL / COMMERCIAL BUILDINGS (North behind sidewalk at z = -5.5)
  const buildingDefs: ModelInstanceDef[] = [
    // House 1: Narrow Garage + Upper Balcony + Roof
    { file: `${BASE_PATH}/SM_Floor_NarrowGarage_455_01.gltf`, pos: [-11.5, 0, -5.5] },
    { file: `${BASE_PATH}/SM_Floor_NarrowUpperBalcony_White_455_01.gltf`, pos: [-11.5, 3, -5.5] },
    { file: `${BASE_PATH}/SM_Roof_NarrowFlatPlain_White_455_01.gltf`, pos: [-11.5, 6, -5.5] },

    // House 2: Living 364 + Upper Window + Roof
    { file: `${BASE_PATH}/SM_Floor_NarrowLiving_364_01.gltf`, pos: [-6.95, 0, -5.5] },
    { file: `${BASE_PATH}/SM_Floor_NarrowUpperWindow_White_364_01.gltf`, pos: [-6.95, 3, -5.5] },
    { file: `${BASE_PATH}/SM_Roof_NarrowFlatPlain_White_364_01.gltf`, pos: [-6.95, 6, -5.5] },

    // House 3: Garage Wide 455 + Upper Window + Roof
    { file: `${BASE_PATH}/SM_Floor_NarrowGarageWide_455_01.gltf`, pos: [-3.3, 0, -5.5] },
    { file: `${BASE_PATH}/SM_Floor_NarrowUpperWindow_White_455_01.gltf`, pos: [-3.3, 3, -5.5] },
    { file: `${BASE_PATH}/SM_Roof_NarrowFlatPlain_White_455_01.gltf`, pos: [-3.3, 6, -5.5] },

    // House 4: Living 364 + Upper Balcony + Roof
    { file: `${BASE_PATH}/SM_Floor_NarrowLiving_364_01.gltf`, pos: [1.25, 0, -5.5] },
    { file: `${BASE_PATH}/SM_Floor_NarrowUpperBalcony_White_364_01.gltf`, pos: [1.25, 3, -5.5] },
    { file: `${BASE_PATH}/SM_Roof_NarrowFlatPlain_White_364_01.gltf`, pos: [1.25, 6, -5.5] },

    // House 5: Garage 455 + Upper Window + Roof
    { file: `${BASE_PATH}/SM_Floor_NarrowGarage_455_01.gltf`, pos: [4.9, 0, -5.5] },
    { file: `${BASE_PATH}/SM_Floor_NarrowUpperWindow_White_455_01.gltf`, pos: [4.9, 3, -5.5] },
    { file: `${BASE_PATH}/SM_Roof_NarrowFlatPlain_White_455_01.gltf`, pos: [4.9, 6, -5.5] },

    // House 6: Garage Wide 455 + Upper Window + Roof
    { file: `${BASE_PATH}/SM_Floor_NarrowGarageWide_455_01.gltf`, pos: [9.45, 0, -5.5] },
    { file: `${BASE_PATH}/SM_Floor_NarrowUpperWindow_White_455_01.gltf`, pos: [9.45, 3, -5.5] },
    { file: `${BASE_PATH}/SM_Roof_NarrowFlatPlain_White_455_01.gltf`, pos: [9.45, 6, -5.5] },
  ];

  // 4. JAPANESE STREET PROPS & FURNITURE
  const propDefs: ModelInstanceDef[] = [
    // Vending Machines on sidewalk
    { file: `${BASE_PATH}/SM_Street_Vending_HD_Blue_103_01.gltf`, pos: [2.5, 0.15, -4.5], rot: [0, 0, 0] },
    { file: `${BASE_PATH}/SM_Street_Vending_HD_Red_103_01.gltf`, pos: [3.7, 0.15, -4.5], rot: [0, 0, 0] },

    // Japanese Cherry Blossom (Sakura) trees
    { file: `${BASE_PATH}/SM_Street_Tree_Sakura_S_01.gltf`, pos: [-3.8, 0.15, -4.5] },
    { file: `${BASE_PATH}/SM_Street_Tree_Sakura_S_01.gltf`, pos: [6.8, 0.15, -4.5] },

    // Japanese Ginkgo trees
    { file: `${BASE_PATH}/SM_Street_Tree_Ginkgo_S_01.gltf`, pos: [-8.8, 0.15, -4.5] },
    { file: `${BASE_PATH}/SM_Street_Tree_Ginkgo_S_01.gltf`, pos: [11.2, 0.15, -4.5] },

    // Traffic Signal Cantilever Post
    { file: `${BASE_PATH}/SM_Street_TrafficSignal_Galv_300_01.gltf`, pos: [-2.1, 0.15, -3.6], rot: [0, Math.PI / 2, 0] },

    // Japanese STOP ("止まれ") Sign
    { file: `${BASE_PATH}/SM_Street_Sign_Tomare_01.gltf`, pos: [2.2, 0.15, 3.6], rot: [0, Math.PI, 0] },

    // Round Curved Road Mirror
    { file: `${BASE_PATH}/SM_Street_CurveMirror_Round_Single_01.gltf`, pos: [-3.6, 0.15, -3.6], rot: [0, Math.PI / 4, 0] },

    // Parked Silver Bicycle
    { file: `${BASE_PATH}/SM_Street_Bicycle_Plain_Silver_01.gltf`, pos: [1.3, 0.15, -4.4], rot: [0, -0.2, 0] },

    // Bollards along pedestrian crossing curbs
    { file: `${BASE_PATH}/SM_Street_Bollard_Fixed_01.gltf`, pos: [-2.1, 0.15, -3.55] },
    { file: `${BASE_PATH}/SM_Street_Bollard_Fixed_01.gltf`, pos: [2.1, 0.15, -3.55] },
    { file: `${BASE_PATH}/SM_Street_Bollard_Fixed_01.gltf`, pos: [-2.1, 0.15, 3.55] },
    { file: `${BASE_PATH}/SM_Street_Bollard_Fixed_01.gltf`, pos: [2.1, 0.15, 3.55] },

    // Traffic cone near curb
    { file: `${BASE_PATH}/SM_Street_Cone_01.gltf`, pos: [0.9, 0, -3.2] },
    { file: `${BASE_PATH}/SM_Street_Cone_01.gltf`, pos: [1.3, 0, -3.2] },

    // Flowering bushes from trees_grass_rocks
    { file: `${NATURE_PATH}/Bush_Flowers.gltf`, pos: [-3.8, 0.15, -4.1], scale: [1.2, 1.2, 1.2] },
    { file: `${NATURE_PATH}/Bush_Flowers.gltf`, pos: [6.8, 0.15, -4.1], scale: [1.2, 1.2, 1.2] },
    { file: `${NATURE_PATH}/Bush_Large.gltf`, pos: [-8.8, 0.15, -4.1], scale: [1.0, 1.0, 1.0] },
    { file: `${NATURE_PATH}/Grass_Large.gltf`, pos: [-4.2, 0.15, -4.4], scale: [1.4, 1.4, 1.4] },
    { file: `${NATURE_PATH}/Grass_Large.gltf`, pos: [7.2, 0.15, -4.4], scale: [1.4, 1.4, 1.4] },
  ];

  const allDefs = [...roadDefs, ...sidewalkDefs, ...buildingDefs, ...propDefs];

  // Load instances in batches
  for (const def of allDefs) {
    const model = await loadCached(def.file);
    if (!model) continue;

    model.position.set(...def.pos);
    if (def.rot) model.rotation.set(...def.rot);
    if (def.scale) model.scale.set(...def.scale);

    if (def.receiveOnly) {
      model.traverse((child) => {
        if ((child as THREE.Mesh).isMesh) {
          child.castShadow = false;
          child.receiveShadow = true;
        }
      });
    }

    envGroup.add(model);
  }

  // Load Anime Stones on South sidewalk / green boundary
  try {
    const stonesGltf = await loader.loadAsync(STONES_PATH);
    const stones = stonesGltf.scene;
    stones.position.set(-6, 0.15, 4.5);
    stones.scale.set(0.7, 0.7, 0.7);
    stones.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) {
        child.castShadow = true;
        child.receiveShadow = true;
      }
    });
    envGroup.add(stones);

    const stones2 = stones.clone(true);
    stones2.position.set(7, 0.15, 4.6);
    stones2.rotation.y = Math.PI;
    stones2.scale.set(0.6, 0.6, 0.6);
    envGroup.add(stones2);
  } catch (err) {
    console.warn("Anime stones skipped:", err);
  }

  return envGroup;
}

