import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { HouseFamily } from "./worldTypes";

export type HouseFinish = "plaster" | "brick" | "stone" | "wood" | "roof" | "fabric" | "metal" | "glass" | "tile" | "leaf" | "paper";
export type HouseLayer = "shell" | "interior" | "detail";
export interface HousePalette {
  wall: number;
  roof: number;
  timber: number;
  trim: number;
  accent: number;
  stone: number;
}
export type HouseFinishMaps = Partial<Record<HouseFinish, { map?: THREE.Texture; normalMap?: THREE.Texture; roughnessMap?: THREE.Texture }>>;
export interface HouseMaterialOptions { peak?: boolean; finishes?: HouseFinishMaps }
export interface HouseMaterials {
  materials: Record<HouseFinish, THREE.MeshStandardMaterial>;
  peak?: boolean;
  dispose(): void;
}

const FINISHES: HouseFinish[] = ["plaster", "brick", "stone", "wood", "roof", "fabric", "metal", "glass", "tile", "leaf", "paper"];

/** All patterns are painted locally; no image downloads or per-house texture allocations. */
function finishTexture(finish: HouseFinish): THREE.Texture {
  const size = 128;
  const canvas = typeof document === "undefined" ? null : document.createElement("canvas");
  if (canvas) { canvas.width = size; canvas.height = size; }
  const context = canvas?.getContext("2d");
  let texture: THREE.Texture;
  if (context && canvas) {
    context.fillStyle = "#ece8df";
    context.fillRect(0, 0, size, size);
    // Deterministic stipple keeps the surfaces painterly rather than photo-realistic.
    for (let i = 0; i < 420; i++) {
      const x = (i * 47 + 13) % size, y = (i * 79 + 23) % size;
      context.fillStyle = i % 3 ? "rgba(90,76,59,0.06)" : "rgba(255,255,255,0.3)";
      context.fillRect(x, y, 2 + i % 4, 1 + i % 3);
    }
    context.lineWidth = 2;
    context.strokeStyle = "rgba(68,55,43,0.24)";
    if (finish === "brick" || finish === "stone" || finish === "tile" || finish === "roof") {
      const rows = finish === "stone" ? 4 : 8;
      const row = size / rows, cell = finish === "tile" ? row : row * 2;
      for (let y = 0; y <= size; y += row) {
        context.beginPath(); context.moveTo(0, y); context.lineTo(size, y); context.stroke();
        const offset = finish === "tile" ? 0 : (y / row % 2) * cell / 2;
        for (let x = offset; x <= size; x += cell) {
          context.beginPath(); context.moveTo(x, y); context.lineTo(x, y + row); context.stroke();
          if (finish === "roof") {
            context.strokeStyle = "rgba(255,255,255,0.3)";
            context.beginPath(); context.moveTo(x + 3, y + 3); context.lineTo(x + cell - 3, y + 3); context.stroke();
            context.strokeStyle = "rgba(68,55,43,0.24)";
          }
        }
      }
    } else if (finish === "wood") {
      for (let y = 0; y < size; y += 16) {
        context.beginPath(); context.moveTo(0, y); context.lineTo(size, y); context.stroke();
        context.strokeStyle = "rgba(83,56,36,0.12)";
        for (let j = 0; j < 3; j++) {
          context.beginPath(); context.moveTo(0, y + 4 + j * 3);
          context.bezierCurveTo(32, y + 2 + j * 3, 86, y + 8 + j * 3, size, y + 4 + j * 3);
          context.stroke();
        }
        context.strokeStyle = "rgba(68,55,43,0.24)";
      }
    } else if (finish === "fabric" || finish === "paper") {
      context.lineWidth = 1;
      context.strokeStyle = "rgba(90,76,59,0.08)";
      for (let i = 0; i < size; i += 4) {
        context.beginPath(); context.moveTo(i, 0); context.lineTo(i, size);
        context.moveTo(0, i); context.lineTo(size, i); context.stroke();
      }
    }
    texture = new THREE.CanvasTexture(canvas);
  } else {
    // Geometry/contact tests also run without DOM. The fallback owns no browser resources.
    const pixels = new Uint8Array(size * size * 4);
    for (let i = 0; i < size * size; i++) {
      const tone = 225 + (i * 37 % 23);
      pixels[i * 4] = tone; pixels[i * 4 + 1] = tone; pixels[i * 4 + 2] = tone; pixels[i * 4 + 3] = 255;
    }
    texture = new THREE.DataTexture(pixels, size, size, THREE.RGBAFormat);
    texture.needsUpdate = true;
  }
  texture.name = `house-local-${finish}`;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 2;
  return texture;
}

export function createHouseMaterials(options: HouseMaterialOptions = {}): HouseMaterials {
  const materials = {} as Record<HouseFinish, THREE.MeshStandardMaterial>;
  const textures: THREE.Texture[] = [];
  for (const finish of FINISHES) {
    const supplied = options.finishes?.[finish];
    const map = supplied?.map ?? (finish === "glass" || finish === "metal" || finish === "leaf" ? null : finishTexture(finish));
    if (map && !supplied?.map) textures.push(map);
    const material = new THREE.MeshStandardMaterial({
      vertexColors: true, map,
      ...(supplied?.normalMap ? { normalMap: supplied.normalMap } : {}),
      ...(supplied?.roughnessMap ? { roughnessMap: supplied.roughnessMap } : {}),
      normalScale: new THREE.Vector2(0.38, 0.38), roughness: finish === "metal" ? 0.5 : finish === "tile" ? 0.55 : 0.9,
      metalness: finish === "metal" ? 0.3 : 0,
    });
    material.name = `house-${finish}`;
    if (finish === "glass") {
      material.transparent = true; material.opacity = 0.24; material.depthWrite = false;
      material.roughness = 0.2; material.side = THREE.DoubleSide;
      material.emissive.set(0x182d31); material.emissiveIntensity = 0.15;
    }
    materials[finish] = material;
  }
  return { materials, peak: options.peak, dispose() { textures.forEach((texture) => texture.dispose()); FINISHES.forEach((finish) => materials[finish].dispose()); } };
}

/** A separate batch per building, layer and material preserves spatial culling. */
export class HouseBatch {
  private readonly parts = new Map<string, THREE.BufferGeometry[]>();
  readonly shell = new THREE.Group();
  readonly interior = new THREE.Group();
  readonly detail = new THREE.Group();
  readonly shadowMeshes: THREE.Mesh[] = [];

  constructor(private readonly materials: HouseMaterials) {
    this.shell.name = "structure"; this.interior.name = "interior"; this.detail.name = "facade-details";
  }

  add(geometry: THREE.BufferGeometry, finish: HouseFinish, tint: number, layer: HouseLayer = "detail"): void {
    const g = geometry.index ? geometry.toNonIndexed() : geometry.clone();
    geometry.dispose();
    const position = g.getAttribute("position"), normal = g.getAttribute("normal"), uv = g.getAttribute("uv");
    const color = new THREE.Color(tint), colors = new Float32Array(position.count * 3);
    const scale = finish === "roof" ? 0.8 : finish === "wood" ? 0.65 : finish === "brick" ? 0.8 : 0.45;
    for (let i = 0; i < position.count; i++) {
      color.toArray(colors, i * 3);
      // Project after local transforms so adjacent wall segments share their mortar/grain.
      const nx = Math.abs(normal.getX(i)), ny = Math.abs(normal.getY(i)), nz = Math.abs(normal.getZ(i));
      const u = nx > nz && nx > ny ? position.getZ(i) : position.getX(i);
      const v = ny > nx && ny > nz ? position.getZ(i) : position.getY(i);
      uv.setXY(i, u * scale, v * scale);
    }
    g.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    const key = `${layer}:${finish}`, list = this.parts.get(key) ?? [];
    list.push(g); this.parts.set(key, list);
  }

  box(w: number, h: number, d: number, x: number, y: number, z: number, finish: HouseFinish, tint: number, layer: HouseLayer = "detail", yaw = 0): void {
    if (w <= 0.001 || h <= 0.001 || d <= 0.001) return;
    this.add(new THREE.BoxGeometry(w, h, d).rotateY(yaw).translate(x, y, z), finish, tint, layer);
  }

  beam(a: THREE.Vector3, b: THREE.Vector3, thickness: number, finish: HouseFinish, tint: number, layer: HouseLayer = "detail"): void {
    const delta = b.clone().sub(a), middle = a.clone().add(b).multiplyScalar(0.5);
    const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), delta.clone().normalize());
    const geometry = new THREE.BoxGeometry(thickness, delta.length(), thickness);
    geometry.applyQuaternion(quaternion).translate(middle.x, middle.y, middle.z);
    this.add(geometry, finish, tint, layer);
  }

  cylinder(radius: number, height: number, x: number, y: number, z: number, finish: HouseFinish, tint: number, layer: HouseLayer = "detail", topRadius = radius): void {
    this.add(new THREE.CylinderGeometry(topRadius, radius, height, 8).translate(x, y, z), finish, tint, layer);
  }

  finish(parent: THREE.Group): void {
    for (const [key, parts] of this.parts) {
      const [layer, finish] = key.split(":") as [HouseLayer, HouseFinish];
      const geometry = mergeGeometries(parts, false);
      parts.forEach((part) => part.dispose());
      if (!geometry) throw new Error(`Cannot batch house ${key}`);
      geometry.computeBoundingBox(); geometry.computeBoundingSphere();
      const mesh = new THREE.Mesh(geometry, this.materials.materials[finish]);
      mesh.name = key; mesh.receiveShadow = finish !== "glass";
      // Only the two large opaque shell surfaces can cast; update caps nearby casters.
      if (layer === "shell" && (finish === "plaster" || finish === "brick" || finish === "roof")) this.shadowMeshes.push(mesh);
      this[layer].add(mesh);
    }
    this.parts.clear();
    parent.add(this.shell, this.interior, this.detail);
  }
}

export interface FurnitureContext {
  batch: HouseBatch;
  palette: HousePalette;
  family: HouseFamily;
  width: number;
  depth: number;
  floor: number;
  storey: number;
  solid(w: number, h: number, d: number, x: number, y: number, z: number, yaw?: number): void;
}

/** Every suite has a real kitchen, living space, bedroom and bathroom; the centre aisle stays clear. */
export function furnishHouseFloor(context: FurnitureContext): void {
  const { batch: b, palette: p, width, depth, floor: f, family, storey, solid } = context;
  const left = -width / 2, rear = -depth / 2, front = depth / 2;
  const box = (w: number, h: number, d: number, x: number, y: number, z: number, finish: HouseFinish, tint: number) => b.box(w, h, d, x, f + y, z, finish, tint, "interior");
  const cylinder = (r: number, h: number, x: number, y: number, z: number, finish: HouseFinish, tint: number) => b.cylinder(r, h, x, f + y, z, finish, tint, "interior");
  const collider = (w: number, h: number, d: number, x: number, y: number, z: number) => solid(w, h, d, x, f + y, z);
  const kitchenZ = front - 1.85, cabinetX = left + 0.65;
  // Run of inset cupboards, stone counter, recessed sink, cooker and tiled splashback.
  box(0.85, 0.82, 2.5, cabinetX, 0.41, kitchenZ, "wood", p.trim);
  box(0.94, 0.08, 2.58, cabinetX, 0.86, kitchenZ, "stone", 0xd4cbb9);
  collider(0.94, 0.9, 2.58, cabinetX, 0.45, kitchenZ);
  for (let i = 0; i < 4; i++) {
    box(0.025, 0.61, 0.51, cabinetX + 0.44, 0.42, kitchenZ - 0.9 + i * 0.6, "wood", p.timber);
    box(0.055, 0.04, 0.16, cabinetX + 0.47, 0.65, kitchenZ - 0.9 + i * 0.6, "metal", 0xbeb7a6);
  }
  box(0.04, 0.78, 2.62, left + 0.24, 1.3, kitchenZ, "tile", 0xdde3d4);
  box(0.61, 0.025, 0.53, cabinetX, 0.909, kitchenZ - 0.65, "metal", 0x727e85);
  box(0.43, 0.03, 0.35, cabinetX, 0.923, kitchenZ - 0.65, "metal", 0x384a55);
  b.beam(new THREE.Vector3(cabinetX - 0.28, f + 0.9, kitchenZ - 0.65), new THREE.Vector3(cabinetX - 0.28, f + 1.16, kitchenZ - 0.65), 0.04, "metal", 0xc4cccd, "interior");
  b.beam(new THREE.Vector3(cabinetX - 0.28, f + 1.16, kitchenZ - 0.65), new THREE.Vector3(cabinetX, f + 1.16, kitchenZ - 0.65), 0.04, "metal", 0xc4cccd, "interior");
  for (const z of [kitchenZ + 0.5, kitchenZ + 0.95]) {
    cylinder(0.13, 0.025, cabinetX, 0.923, z, "metal", 0x323b40);
  }
  cylinder(0.14, 0.22, cabinetX, 1.02, kitchenZ + 0.5, "metal", 0x707c83);
  box(0.72, 1.82, 0.78, left + 1.47, 0.91, front - 0.7, "metal", 0xe0e4d5);
  box(0.75, 0.04, 0.04, left + 1.47, 1.22, front - 0.285, "metal", 0x6c777d);
  box(0.06, 0.32, 0.045, left + 1.73, 0.85, front - 0.285, "metal", 0x677378);
  collider(0.75, 1.82, 0.82, left + 1.47, 0.91, front - 0.7);
  box(0.48, 0.55, 1.38, left + 0.49, 2.05, kitchenZ, "wood", p.trim);
  for (const z of [kitchenZ - 0.38, kitchenZ + 0.38]) box(0.04, 0.04, 0.2, left + 0.75, 2.04, z, "metal", 0xafac97);

  // Living furniture is against the left wall, never across the entry/stair circulation.
  const sofaX = left + 0.86, sofaZ = 0.95;
  const tatami = family === "japanese";
  if (tatami) {
    box(2.7, 0.018, 2.15, left + 1.7, 0.014, sofaZ, "fabric", 0xc4cb91);
    for (const z of [sofaZ - 0.5, sofaZ + 0.5]) {
      box(0.68, 0.12, 0.68, sofaX + 0.2, 0.08, z, "fabric", p.accent);
    }
    box(0.85, 0.06, 1.1, left + 2.08, 0.36, sofaZ, "wood", p.timber);
    for (const x of [left + 1.74, left + 2.42]) for (const z of [sofaZ - 0.43, sofaZ + 0.43]) box(0.09, 0.31, 0.09, x, 0.18, z, "wood", p.timber);
    collider(0.9, 0.4, 1.12, left + 2.08, 0.2, sofaZ);
    cylinder(0.085, 0.12, left + 2.08, 0.46, sofaZ, "tile", 0xdadbc4);
  } else {
    box(0.93, 0.35, 2.18, sofaX, 0.31, sofaZ, "wood", p.timber);
    box(0.18, 0.84, 2.2, sofaX - 0.4, 0.53, sofaZ, "fabric", p.accent);
    for (const z of [sofaZ - 0.64, sofaZ, sofaZ + 0.64]) box(0.76, 0.17, 0.61, sofaX + 0.03, 0.56, z, "fabric", p.accent);
    for (const z of [sofaZ - 1.05, sofaZ + 1.05]) box(0.97, 0.5, 0.14, sofaX, 0.54, z, "fabric", p.accent);
    collider(1, 0.96, 2.32, sofaX, 0.48, sofaZ);
    box(0.72, 0.07, 1.08, left + 2.35, 0.49, sofaZ + 0.1, "wood", p.trim);
    for (const x of [left + 2.1, left + 2.6]) for (const z of [sofaZ - 0.3, sofaZ + 0.5]) box(0.075, 0.45, 0.075, x, 0.225, z, "metal", 0x50585a);
    collider(0.78, 0.54, 1.12, left + 2.35, 0.27, sofaZ + 0.1);
    box(0.24, 0.035, 0.32, left + 2.35, 0.55, sofaZ, "paper", 0xcdd1b3);
  }
  // Woven runner, wall picture, reading lamp and shelving.
  box(1.65, 0.012, 2.1, 0, 0.008, front - 1.4, "fabric", p.accent);
  box(0.045, 0.9, 1.3, left + 0.135, 1.9, sofaZ, "wood", p.trim);
  box(0.055, 0.71, 1.1, left + 0.165, 1.9, sofaZ, "paper", 0x86a6a0);
  box(0.06, 0.26, 0.47, left + 0.205, 1.78, sofaZ + 0.12, "paper", 0xcbba8a);
  cylinder(0.15, 0.05, left + 1.02, 0.025, -0.27, "metal", 0x535a53);
  cylinder(0.027, 1.4, left + 1.02, 0.75, -0.27, "metal", 0x535a53);
  b.cylinder(0.27, 0.32, left + 1.02, f + 1.49, -0.27, "paper", 0xf0deab, "interior", 0.15);

  // Bedroom at the back, clear of the rear landing and its connecting aisle.
  const bedX = -0.34, bedZ = rear + 1.42;
  box(1.54, 0.35, 2.18, bedX, 0.24, bedZ, "wood", p.timber);
  box(1.45, 0.23, 2.05, bedX, 0.53, bedZ, "fabric", 0xe6e0cb);
  box(1.47, 0.04, 1.37, bedX, 0.669, bedZ + 0.33, "fabric", p.accent);
  box(1.61, 0.82, 0.14, bedX, 0.46, bedZ - 1.08, "wood", p.trim);
  for (const x of [bedX - 0.37, bedX + 0.37]) box(0.59, 0.12, 0.37, x, 0.72, bedZ - 0.65, "fabric", 0xf0eadf);
  collider(1.62, 0.88, 2.28, bedX, 0.44, bedZ);
  box(0.53, 0.54, 0.57, bedX - 1.1, 0.27, bedZ + 0.27, "wood", p.trim);
  collider(0.55, 0.57, 0.59, bedX - 1.1, 0.285, bedZ + 0.27);
  cylinder(0.08, 0.22, bedX - 1.1, 0.65, bedZ + 0.27, "metal", 0x8c887c);
  b.cylinder(0.18, 0.22, bedX - 1.1, f + 0.86, bedZ + 0.27, "paper", 0xf2dfbb, "interior", 0.12);
  const wardrobeX = width / 2 - 3.05, wardrobeZ = rear + 0.6;
  box(1.15, 2.05, 0.65, wardrobeX, 1.025, wardrobeZ, "wood", p.trim);
  box(0.028, 1.86, 0.03, wardrobeX, 1.06, wardrobeZ + 0.34, "wood", p.timber);
  for (const x of [wardrobeX - 0.07, wardrobeX + 0.07]) box(0.04, 0.2, 0.04, x, 1.08, wardrobeZ + 0.38, "metal", 0xb3ad91);
  collider(1.18, 2.05, 0.69, wardrobeX, 1.025, wardrobeZ);

  // Bathroom: glazed shower, toilet, washbasin, mirror and towel rail.
  const bathX = left + 0.98, showerZ = rear + 0.95;
  box(1.43, 0.1, 1.45, bathX, 0.05, showerZ, "tile", 0xe3e6dc);
  box(1.43, 0.035, 0.045, bathX, 0.11, showerZ + 0.73, "metal", 0x9ba8a5);
  box(0.025, 1.95, 1.44, bathX + 0.71, 1.05, showerZ, "glass", 0xadd5d8);
  box(0.04, 2, 0.04, bathX + 0.73, 1.05, showerZ + 0.72, "metal", 0xb3c0bd);
  box(0.04, 0.04, 1.44, bathX + 0.73, 2.04, showerZ, "metal", 0xb3c0bd);
  collider(0.045, 2.1, 1.44, bathX + 0.73, 1.05, showerZ);
  box(0.055, 1.15, 0.055, left + 0.29, 1.43, showerZ - 0.2, "metal", 0xaab9b7);
  cylinder(0.17, 0.035, left + 0.47, 2.01, showerZ - 0.2, "metal", 0xb4c4c1);
  const toiletZ = rear + 2.72;
  box(0.54, 0.7, 0.24, left + 0.59, 0.35, toiletZ - 0.24, "tile", 0xe5e8df);
  box(0.5, 0.3, 0.58, left + 0.59, 0.21, toiletZ + 0.08, "tile", 0xe5e8df);
  box(0.53, 0.055, 0.59, left + 0.59, 0.39, toiletZ + 0.08, "tile", 0xf4f0df);
  collider(0.57, 0.72, 0.87, left + 0.59, 0.36, toiletZ);
  const basinZ = -1.42;
  box(0.61, 0.73, 0.73, left + 0.56, 0.365, basinZ, "wood", p.trim);
  box(0.69, 0.12, 0.79, left + 0.56, 0.78, basinZ, "tile", 0xe7e8da);
  box(0.34, 0.017, 0.48, left + 0.59, 0.849, basinZ, "metal", 0x829897);
  collider(0.72, 0.85, 0.82, left + 0.56, 0.425, basinZ);
  box(0.065, 0.82, 0.68, left + 0.16, 1.49, basinZ, "metal", p.trim);
  box(0.07, 0.69, 0.55, left + 0.2, 1.49, basinZ, "glass", 0xd4edf1);
  box(0.045, 0.04, 0.62, left + 0.26, 1.15, -2.23, "metal", 0xacb8b5);
  box(0.035, 0.46, 0.41, left + 0.3, 0.97, -2.23, "fabric", p.accent);
  // Warm ceiling shades are geometry, not hundreds of costly shadow-casting lights.
  for (const z of [front - 2.25, -2.05]) {
    cylinder(0.035, 0.2, 0, 2.92, z, "metal", 0x7b786a);
    b.cylinder(0.26, 0.16, 0, f + 2.77, z, "paper", 0xf4deab, "interior", 0.16);
  }

  if (storey === 0 && (family === "shop" || family === "tavern")) {
    // A side counter leaves the full front-to-back aisle and the stair approach open.
    const x = width / 2 - 3, z = 1.13;
    box(0.88, 0.98, 1.8, x, 0.49, z, "wood", p.timber);
    box(1, 0.08, 1.9, x, 1.02, z, "wood", p.trim);
    collider(1, 1.07, 1.92, x, 0.535, z);
    if (family === "shop") {
      box(0.38, 0.18, 0.32, x, 1.15, z + 0.45, "metal", 0x617074);
      for (let i = 0; i < 6; i++) box(0.16, 0.25 + i % 2 * 0.1, 0.17, x, 1.2, z - 0.6 + i * 0.18, "paper", [0xb8654b, 0xd8bd74, 0x7e9b83][i % 3]);
    } else {
      for (let i = 0; i < 4; i++) {
        cylinder(0.065, 0.27, x, 1.2, z - 0.6 + i * 0.35, "glass", 0x557f54);
        cylinder(0.035, 0.09, x, 1.38, z - 0.6 + i * 0.35, "glass", 0x557f54);
      }
    }
  }
}
