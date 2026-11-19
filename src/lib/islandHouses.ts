import * as THREE from "three";
import { createHouseMaterials, furnishHouseFloor, HouseBatch } from "./houseDetails";
import type { HouseFinish, HouseLayer, HousePalette, HouseMaterials } from "./houseDetails";
import type { HouseFamily, HouseSpot, WorldCollider, WorldContact, WorldSupport } from "./worldTypes";
import { rng } from "./worldShared";
import { createPeakHouseDetails } from "./peakHouseDetails";
import type { PeakMaterials } from "./peakMaterials";
import { applyPeakSurface } from "./peakMaterials";

export type { HouseFamily, HouseSpot } from "./worldTypes";

export interface HouseRoom {
  id: string;
  kind: "living" | "kitchen" | "bedroom" | "bathroom" | "hall" | "balcony";
  storey: number;
  /** World-space, furniture-free feet position, not the room's geometric centre. */
  walkPoint: THREE.Vector3;
}

export interface HouseStair {
  id: string;
  fromStorey: number;
  toStorey: number;
  width: number;
  run: number;
  rise: number;
  stepCount: number;
  bottom: THREE.Vector3;
  top: THREE.Vector3;
  bottomLanding: THREE.Vector3;
  topLanding: THREE.Vector3;
  walkPoints: THREE.Vector3[];
  supportId: string;
}

export interface HouseRecord {
  id: string;
  family: HouseFamily;
  spot: HouseSpot;
  width: number;
  depth: number;
  storeys: number;
  /** Always faces the spot's rotated local +Z direction. Position is at threshold/feet height. */
  doorway: THREE.Vector3;
  doorwayWidth: number;
  doorwayHeight: number;
  floorHeight: number;
  storeyHeight: number;
  /** World AABB for plot/debug selection only; NEVER a solid building collider. */
  bounds: THREE.Box3;
  rooms: HouseRoom[];
  stairs: HouseStair[];
  roomWalkPoints: THREE.Vector3[];
  stairWalkPoints: THREE.Vector3[];
}

export interface IslandHouses {
  group: THREE.Group;
  colliders: WorldCollider[];
  supports: WorldSupport[];
  houses: HouseRecord[];
  nearestDoor(playerPosition: THREE.Vector3, maxDistance?: number): { houseId: string; distance: number; open: boolean } | null;
  toggleNearestDoor(playerPosition: THREE.Vector3): boolean;
  attachCollision(world: WorldContact): void;
  update(dt: number, playerPosition: THREE.Vector3, viewPosition?: THREE.Vector3): void;
  dispose(): void;
}

/** Builders may use these conservative plot sizes BEFORE constructing/flattening terrain. */
export const HOUSE_FOOTPRINTS: Readonly<Record<HouseFamily, { width: number; depth: number; storeys: number; plotRadius: number }>> = {
  japanese: { width: 12, depth: 12.8, storeys: 1, plotRadius: 11.3 },
  cottage: { width: 11, depth: 12, storeys: 2, plotRadius: 10.7 },
  farm: { width: 13, depth: 13.5, storeys: 2, plotRadius: 12 },
  coastal: { width: 11.6, depth: 12.8, storeys: 2, plotRadius: 11.2 },
  townhouse: { width: 10.8, depth: 12.4, storeys: 3, plotRadius: 10.9 },
  shop: { width: 12, depth: 12.8, storeys: 2, plotRadius: 11.3 },
  tavern: { width: 13, depth: 13.5, storeys: 2, plotRadius: 12 },
  apartment: { width: 13.4, depth: 14, storeys: 3, plotRadius: 12.5 },
};

const FAMILIES: HouseFamily[] = ["japanese", "cottage", "farm", "coastal", "townhouse", "shop", "tavern", "apartment"];
const FOUNDATION = 0.18, STOREY = 3.2, WALL = 0.22, FLOOR = 0.14;
const DOOR_WIDTH = 2.1, DOOR_HEIGHT = 2.52;
const STAIR_WIDTH = 1.9, STAIR_RUN = 5.6, STAIR_START = 2.7, STAIR_END = STAIR_START - STAIR_RUN;

const PALETTES: Record<HouseFamily, HousePalette> = {
  japanese: { wall: 0xe7d8b9, roof: 0x414e5a, timber: 0x46392f, trim: 0x976a47, accent: 0x98604b, stone: 0x909087 },
  cottage: { wall: 0xe5d5b7, roof: 0x57656d, timber: 0x6b493d, trim: 0x768166, accent: 0xb77563, stone: 0xa29a86 },
  farm: { wall: 0xb6664f, roof: 0x525d63, timber: 0x73543d, trim: 0xe8dfc3, accent: 0x8b9a67, stone: 0xa29b8a },
  coastal: { wall: 0xa5c4c0, roof: 0x607f89, timber: 0x997c58, trim: 0xe6e5d6, accent: 0x527e93, stone: 0xb6b4a0 },
  townhouse: { wall: 0xb47b62, roof: 0x445468, timber: 0x675045, trim: 0xe1cfae, accent: 0x7f8e7a, stone: 0x9c9286 },
  shop: { wall: 0xebd2a1, roof: 0x587a77, timber: 0x695243, trim: 0xa96349, accent: 0x70907c, stone: 0xb0a58d },
  tavern: { wall: 0xe4c996, roof: 0x914d3e, timber: 0x554235, trim: 0x846445, accent: 0x768353, stone: 0x989183 },
  apartment: { wall: 0xd5cdc0, roof: 0x627679, timber: 0x79624e, trim: 0x7e9396, accent: 0xba8361, stone: 0xa3a299 },
};

interface Opening {
  center: number;
  width: number;
  bottom: number;
  top: number;
  kind: "door" | "window" | "passage";
}
interface DoorRuntime {
  hinges: THREE.Group[];
  colliderId: string;
  width: number;
  height: number;
  depth: number;
  hingeX: number;
  hingeZ: number;
  angle: number;
  target: number;
}
interface HouseRuntime {
  root: THREE.Group;
  batch: HouseBatch;
  record: HouseRecord;
  distance: number;
  door: DoorRuntime;
  doorMaterials: THREE.Material[];
  updateDoorCollider?: () => void;
  removeDoorCollider?: () => void;
}

/** The only transform for render geometry, supports, collision and metadata. */
function worldPoint(spot: HouseSpot, x: number, y: number, z: number): THREE.Vector3 {
  const c = Math.cos(spot.ry), s = Math.sin(spot.ry);
  return new THREE.Vector3(spot.x + c * x + s * z, spot.y + y, spot.z - s * x + c * z);
}

class HouseBuilder {
  readonly batch: HouseBatch;
  readonly root = new THREE.Group();
  readonly record: HouseRecord;
  readonly palette: HousePalette;
  readonly stairX: number;
  readonly stairLeft: number;
  private readonly materials: HouseMaterials;
  private readonly doorMaterial: THREE.MeshStandardMaterial;
  private readonly doorTrimMaterial: THREE.MeshStandardMaterial;
  private readonly doorMaterials: THREE.Material[] = [];
  private colliderIndex = 0;
  private supportIndex = 0;
  readonly doors: THREE.Group[] = [];

  constructor(readonly spot: HouseSpot, index: number, materials: HouseMaterials, readonly colliders: WorldCollider[], readonly supports: WorldSupport[]) {
    this.materials = materials;
    this.doorMaterial = materials.materials.wood.clone();
    this.doorTrimMaterial = materials.materials.wood.clone();
    this.doorMaterials.push(this.doorMaterial, this.doorTrimMaterial);
    const rand = rng(spot.seed), familyIndex = ((Math.floor(spot.seed) % FAMILIES.length) + FAMILIES.length) % FAMILIES.length;
    const family = spot.family ?? FAMILIES[familyIndex];
    const footprint = HOUSE_FOOTPRINTS[family];
    // All variants retain generous circulation; randomisation never shrinks a doorway or stair.
    const width = footprint.width - rand() * 0.75, depth = footprint.depth - rand() * 0.8;
    const storeys = family === "cottage" && rand() < 0.38 ? 1 : footprint.storeys;
    this.palette = { ...PALETTES[family] };
    const tint = new THREE.Color(this.palette.wall).offsetHSL((rand() - 0.5) * 0.024, 0, (rand() - 0.5) * 0.06);
    this.palette.wall = tint.getHex();
    this.stairX = width / 2 - 1.32;
    this.stairLeft = this.stairX - STAIR_WIDTH / 2;
    const id = `house-${index}-${family}-${spot.seed}`;
    this.record = {
      id, family, spot: { ...spot, family }, width, depth, storeys,
      doorway: worldPoint(spot, 0, FOUNDATION, depth / 2), doorwayWidth: DOOR_WIDTH - 0.14,
      doorwayHeight: DOOR_HEIGHT - 0.08, floorHeight: spot.y + FOUNDATION, storeyHeight: STOREY,
      bounds: new THREE.Box3(), rooms: [], stairs: [], roomWalkPoints: [], stairWalkPoints: [],
    };
    this.root.name = id;
    this.root.position.set(spot.x, spot.y, spot.z); this.root.rotation.y = spot.ry;
    this.root.userData.houseId = id; this.root.userData.family = family;
    this.batch = new HouseBatch(materials);
  }

  point(x: number, y: number, z: number): THREE.Vector3 { return worldPoint(this.spot, x, y, z); }

  solid(w: number, h: number, d: number, x: number, y: number, z: number, yaw = 0, kind: WorldCollider["kind"] = "wall"): void {
    if (w <= 0.001 || h <= 0.001 || d <= 0.001) return;
    this.colliders.push({ id: `${this.record.id}-c${this.colliderIndex++}`, center: this.point(x, y, z), size: new THREE.Vector3(w, h, d), yaw: this.spot.ry + yaw, kind });
  }

  support(w: number, d: number, x: number, y: number, z: number, slopeZ?: number): string {
    const id = `${this.record.id}-s${this.supportIndex++}`;
    this.supports.push({ id, center: this.point(x, y, z), width: w, depth: d, yaw: this.spot.ry, ...(slopeZ === undefined ? {} : { slopeZ }) });
    return id;
  }

  box(w: number, h: number, d: number, x: number, y: number, z: number, finish: HouseFinish, tint: number, layer: HouseLayer = "detail", collide = false): void {
    this.batch.box(w, h, d, x, y, z, finish, tint, layer);
    if (collide) this.solid(w, h, d, x, y, z);
  }

  room(kind: HouseRoom["kind"], storey: number, x: number, z: number): void {
    const room = { id: `${this.record.id}-${storey}-${kind}`, kind, storey, walkPoint: this.point(x, FOUNDATION + storey * STOREY, z) };
    this.record.rooms.push(room); this.record.roomWalkPoints.push(room.walkPoint);
  }

  /** Segment actual walls around every opening. No facade plane or fallback bbox seals them. */
  wall(alongX: boolean, fixed: number, start: number, end: number, floor: number, height: number, openings: Opening[], finish: HouseFinish, tint: number, layer: HouseLayer = "shell"): void {
    const segment = (a: number, b: number, low: number, high: number) => {
      if (b - a <= 0.001 || high - low <= 0.001) return;
      const u = (a + b) / 2, y = floor + (low + high) / 2;
      this.box(alongX ? b - a : WALL, high - low, alongX ? WALL : b - a, alongX ? u : fixed, y, alongX ? fixed : u, finish, tint, layer, true);
    };
    let cursor = start;
    for (const opening of [...openings].sort((a, b) => a.center - b.center)) {
      const a = Math.max(start, opening.center - opening.width / 2), b = Math.min(end, opening.center + opening.width / 2);
      segment(cursor, a, 0, height);
      segment(a, b, 0, opening.bottom); segment(a, b, opening.top, height);
      if (opening.kind !== "passage") this.frame(alongX, fixed, floor, opening, layer);
      cursor = b;
    }
    segment(cursor, end, 0, height);
  }

  frame(alongX: boolean, fixed: number, floor: number, opening: Opening, layer: HouseLayer): void {
    const p = this.palette, { center: u, width: w, bottom: low, top: high, kind } = opening;
    const h = high - low;
    const piece = (a: number, y: number, uw: number, uh: number, thickness: number, finish: HouseFinish, color: number, offset = 0) => {
      this.box(alongX ? uw : thickness, uh, alongX ? thickness : uw, alongX ? a : fixed + offset, floor + y, alongX ? fixed + offset : a, finish, color, layer === "interior" ? "interior" : "detail");
    };
    for (const a of [u - w / 2 + 0.035, u + w / 2 - 0.035]) piece(a, (low + high) / 2, 0.07, h, WALL + 0.12, "wood", p.trim);
    piece(u, high - 0.035, w, 0.07, WALL + 0.12, "wood", p.trim);
    if (kind === "door") {
      const leafX = alongX ? u - w / 2 : fixed + 0.04;
      const leafZ = alongX ? fixed + 0.04 : u - w / 2;
      const leafWidth = w - 0.12, leafDepth = 0.1;
      const hinge = new THREE.Group();
      hinge.name = "house-door";
      hinge.position.set(leafX, floor, leafZ); this.root.add(hinge);
      if (floor <= FOUNDATION + 0.001) this.doors.push(hinge);
      const leaf = new THREE.Mesh(new THREE.BoxGeometry(alongX ? leafWidth : leafDepth, h - 0.09, alongX ? leafDepth : leafWidth), this.doorMaterial);
      leaf.position.set(alongX ? leafWidth / 2 : 0, h / 2, alongX ? 0 : leafWidth / 2);
      leaf.castShadow = true; leaf.receiveShadow = true; hinge.add(leaf);
      for (const y of [0.6, 1.55]) {
        const panel = new THREE.Mesh(new THREE.BoxGeometry(alongX ? leafWidth * 0.76 : leafDepth * 1.05, 0.57, alongX ? leafDepth * 1.05 : leafWidth * 0.76), this.doorTrimMaterial);
        panel.position.set(alongX ? leafWidth / 2 : 0.01, y, alongX ? 0.055 : leafWidth / 2);
        hinge.add(panel);
      }
      return;
    }
    piece(u, low + 0.02, w + 0.15, 0.09, WALL + 0.28, "stone", p.trim);
    piece(u, (low + high) / 2, 0.055, h, WALL + 0.03, "wood", p.trim);
    piece(u, low + h * 0.55, w, 0.055, WALL + 0.03, "wood", p.trim);
    // Four independent glass panes, inset into real masonry cutouts.
    for (const a of [u - w / 4, u + w / 4]) for (const row of [0, 1]) {
      const paneLow = low + h * row * 0.55 + 0.07, paneHigh = row ? high - 0.07 : low + h * 0.55 - 0.04;
      piece(a, (paneLow + paneHigh) / 2, w / 2 - 0.11, paneHigh - paneLow, 0.022, "glass", 0xaacbd0);
    }
    // Glass blocks the camera but does not seal the doorway.
    this.solid(alongX ? w : 0.04, h, alongX ? 0.04 : w, alongX ? u : fixed, floor + (low + high) / 2, alongX ? fixed : u);
    if (this.record.family === "japanese") {
      for (let i = 1; i < 4; i++) piece(u - w / 2 + w * i / 4, (low + high) / 2, 0.026, h, 0.05, "wood", p.timber);
    }
  }

  floor(storey: number): void {
    const { width: w, depth: d, storeys } = this.record, y = FOUNDATION + storey * STOREY;
    const finish: HouseFinish = "wood";
    if (storey === 0) {
      this.box(w + 0.44, 1.6, d + 0.44, 0, FOUNDATION - 0.8, 0, "stone", this.palette.stone, "shell");
      this.box(w - WALL, 0.045, d - WALL, 0, FOUNDATION - 0.0225, 0, finish, this.palette.trim, "interior");
      this.support(w + 0.44, d + 0.44, 0, y, 0);
    } else {
      // Cut the WHOLE flight, not just the top few steps. A player has headroom all the way up.
      const a = this.stairLeft - 0.1, b = this.stairX + STAIR_WIDTH / 2 + 0.1;
      const front = STAIR_START + 0.08, back = STAIR_END - 0.08;
      const slab = (x0: number, x1: number, z0: number, z1: number) => {
        this.box(x1 - x0, FLOOR, z1 - z0, (x0 + x1) / 2, y - FLOOR / 2, (z0 + z1) / 2, finish, this.palette.trim, "shell");
        this.support(x1 - x0, z1 - z0, (x0 + x1) / 2, y, (z0 + z1) / 2);
      };
      slab(-w / 2, a, -d / 2, d / 2);
      slab(b, w / 2, -d / 2, d / 2);
      slab(a, b, -d / 2, back);
      slab(a, b, front, d / 2);
      // These slabs are already ray/camera-solid in WorldSpatial via their supports.
      // Duplicate box colliders would catch a body's toes at the last ramp tread.
    }
    if (storey === storeys - 1) this.box(w, 0.12, d, 0, y + STOREY - 0.06, 0, "plaster", 0xe9e0c9, "shell", true);
  }

  stairs(storey: number): void {
    const f = FOUNDATION + storey * STOREY, x = this.stairX, p = this.palette;
    const steps = 18, tread = STAIR_RUN / steps, rise = STOREY / steps;
    const points: THREE.Vector3[] = [this.point(x, f, STAIR_START + 0.85), this.point(x, f, STAIR_START)];
    for (let i = 0; i < steps; i++) {
      const z = STAIR_START - (i + 0.5) * tread, height = (i + 1) * rise;
      this.box(STAIR_WIDTH, 0.08, tread + 0.015, x, f + height - 0.04, z, "wood", p.trim, "interior");
      this.box(STAIR_WIDTH, rise, 0.035, x, f + height - rise / 2, z + tread / 2, "wood", p.timber, "interior");
      points.push(this.point(x, f + (i + 0.5) * rise, z));
    }
    const supportId = this.support(STAIR_WIDTH, STAIR_RUN, x, f + STOREY / 2, (STAIR_START + STAIR_END) / 2, -STOREY / STAIR_RUN);
    // The analytic support differs from stair nosings by <= 0.178m; no invisible rooftop lift.
    const bottom = this.point(x, f, STAIR_START), top = this.point(x, f + STOREY, STAIR_END);
    const bottomLanding = this.point(x, f, STAIR_START + 0.85), topLanding = this.point(x, f + STOREY, STAIR_END - 0.85);
    points.push(top, topLanding);
    this.record.stairs.push({ id: `${this.record.id}-stairs-${storey}`, fromStorey: storey, toStorey: storey + 1, width: STAIR_WIDTH, run: STAIR_RUN, rise: STOREY, stepCount: steps, bottom, top, bottomLanding, topLanding, walkPoints: points, supportId });
    this.record.stairWalkPoints.push(...points);
    for (const side of [-1, 1]) {
      const railX = x + side * (STAIR_WIDTH / 2 + 0.045);
      for (let i = 0; i <= 6; i++) {
        const z = STAIR_START - STAIR_RUN * i / 6, y = f + STOREY * i / 6;
        this.box(0.055, 0.95, 0.055, railX, y + 0.48, z, "wood", p.timber, "interior");
      }
      this.batch.beam(new THREE.Vector3(railX, f + 1, STAIR_START), new THREE.Vector3(railX, f + STOREY + 1, STAIR_END), 0.075, "wood", p.trim, "interior");
      this.batch.beam(new THREE.Vector3(railX, f - 0.04, STAIR_START), new THREE.Vector3(railX, f + STOREY - 0.04, STAIR_END), 0.1, "wood", p.timber, "interior");
    }
    // Corridor-side guard protects the floor cutout. It ends BEFORE the rear landing crossing.
    this.rail(this.stairLeft - 0.13, f + STOREY, STAIR_END + 0.1, STAIR_START + 0.08, false, "interior");
  }

  rail(fixed: number, floor: number, start: number, end: number, alongX: boolean, layer: HouseLayer = "detail"): void {
    const length = end - start, p = this.palette, count = Math.max(2, Math.ceil(length / 0.35));
    for (let i = 0; i <= count; i++) {
      const u = start + length * i / count;
      this.box(0.045, 0.98, 0.045, alongX ? u : fixed, floor + 0.49, alongX ? fixed : u, "wood", p.trim, layer);
    }
    this.box(alongX ? length : 0.085, 0.085, alongX ? 0.085 : length, alongX ? (start + end) / 2 : fixed, floor + 1.03, alongX ? fixed : (start + end) / 2, "wood", p.timber, layer);
    this.solid(alongX ? length : 0.08, 1.08, alongX ? 0.08 : length, alongX ? (start + end) / 2 : fixed, floor + 0.54, alongX ? fixed : (start + end) / 2);
  }

  balcony(storey: number): void {
    const { width: w, depth: d, family } = this.record, f = FOUNDATION + storey * STOREY;
    const width = family === "apartment" ? w - 1.3 : Math.min(4.3, w - 2);
    const front = d / 2 + 1.8;
    this.box(width, 0.16, 1.95, 0, f - 0.08, d / 2 + 0.87, "wood", this.palette.trim, "shell");
    this.support(width, 1.95, 0, f, d / 2 + 0.87);
    this.rail(front, f, -width / 2, width / 2, true);
    this.rail(-width / 2, f, d / 2, front, false); this.rail(width / 2, f, d / 2, front, false);
    this.room("balcony", storey, -0.3, d / 2 + 0.72);
    for (const x of [-width / 2 + 0.35, width / 2 - 0.35]) {
      this.batch.cylinder(0.21, 0.32, x, f + 0.16, front - 0.3, "stone", this.palette.stone);
      this.batch.add(new THREE.IcosahedronGeometry(0.28, 0).scale(1, 1.5, 1).translate(x, f + 0.53, front - 0.3), "leaf", 0x799765);
    }
  }

  rooms(storey: number): void {
    const { width: w, depth: d } = this.record, f = FOUNDATION + storey * STOREY, p = this.palette;
    const back = -d / 2, bathWall = -w / 2 + 2.2;
    this.wall(true, -0.5, -w / 2, this.stairLeft - 0.46, f, STOREY - 0.12, [{ center: 1.1, width: 2.05, bottom: 0, top: 2.5, kind: "passage" }], "plaster", p.wall, "interior");
    this.wall(false, bathWall, back, -0.5, f, STOREY - 0.12, [{ center: -2.35, width: 1.95, bottom: 0, top: 2.5, kind: "passage" }], "plaster", 0xe1decf, "interior");
    // Passage jambs only, never an invisible/closed interior door.
    for (const z of [-3.325, -1.375]) this.box(0.3, 2.5, 0.07, bathWall, f + 1.25, z, "wood", p.trim, "interior");
    this.box(0.3, 0.08, 1.95, bathWall, f + 2.5, -2.35, "wood", p.trim, "interior");
    furnishHouseFloor({ batch: this.batch, palette: p, family: this.record.family, width: w, depth: d, floor: f, storey,
      solid: (fw, fh, fd, x, y, z, yaw = 0) => this.solid(fw, fh, fd, x, y, z, yaw, "furniture"),
    });
    this.room("hall", storey, 0, d / 2 - 1.1);
    this.room("living", storey, -w / 2 + 3.45, 0.95);
    this.room("kitchen", storey, -w / 2 + 2.45, d / 2 - 2.25);
    this.room("bedroom", storey, -0.34, -2.35);
    this.room("bathroom", storey, -w / 2 + 1.65, -2.35);
  }

  shell(): void {
    const { width: w, depth: d, family, storeys } = this.record, p = this.palette;
    const wallFinish: HouseFinish = family === "townhouse" ? "brick" : family === "coastal" || family === "farm" ? "wood" : "plaster";
    for (let s = 0; s < storeys; s++) {
      const f = FOUNDATION + s * STOREY, balcony = s > 0 && ["coastal", "townhouse", "apartment", "tavern"].includes(family);
      this.floor(s);
      const windowWidth = family === "shop" && s === 0 ? 2.42 : family === "japanese" ? 2.25 : 1.68;
      const win = (center: number): Opening => ({ center, width: windowWidth, bottom: 0.89, top: 2.43, kind: "window" });
      const front: Opening[] = [win(-w * 0.31), win(w * 0.31)];
      if (s === 0 || balcony) front.push({ center: 0, width: DOOR_WIDTH, bottom: 0, top: DOOR_HEIGHT, kind: "door" });
      else front.push(win(0));
      this.wall(true, d / 2, -w / 2, w / 2, f, STOREY, front, wallFinish, p.wall);
      this.wall(true, -d / 2, -w / 2, w / 2, f, STOREY, [win(-w * 0.29), win(w * 0.25)], wallFinish, p.wall);
      this.wall(false, -w / 2, -d / 2, d / 2, f, STOREY, [win(-d * 0.29), win(d * 0.28)], wallFinish, p.wall);
      // Right stair band: low panes on ground, high windows elsewhere; walls never cut across the flight.
      this.wall(false, w / 2, -d / 2, d / 2, f, STOREY, [win(-d * 0.3), win(d * 0.3)], wallFinish, p.wall);
      // Belt courses and corner pilasters stay outside the wall plane/openings.
      for (const x of [-w / 2 - 0.035, w / 2 + 0.035]) for (const z of [-d / 2 - 0.035, d / 2 + 0.035]) this.box(0.22, STOREY, 0.22, x, f + STOREY / 2, z, "wood", p.trim);
      for (const z of [-d / 2 - 0.075, d / 2 + 0.075]) this.box(w + 0.4, 0.13, 0.12, 0, f + STOREY - 0.18, z, "wood", p.trim);
      if (balcony) this.balcony(s);
      this.rooms(s);
      if (s < storeys - 1) this.stairs(s);
    }
  }

  porch(): void {
    const { width: w, depth: d, family } = this.record, p = this.palette;
    const width = family === "japanese" || family === "coastal" ? w + 0.4 : family === "farm" || family === "tavern" ? 5.9 : 3.7;
    this.box(width, 0.12, 1.5, 0, FOUNDATION - 0.06, d / 2 + 0.77, "stone", p.stone, "shell");
    this.support(width, 1.5, 0, FOUNDATION, d / 2 + 0.77);
    // Broad, low apron bridges flattened terrain to threshold in two <= 0.1m steps.
    this.box(Math.max(3.8, width - 0.2), 0.08, 1.3, 0, 0.04, d / 2 + 2.1, "stone", p.stone, "shell");
    this.support(Math.max(3.8, width - 0.2), 1.3, 0, 0.08, d / 2 + 2.1);
    const canopyWidth = Math.min(width, family === "japanese" ? w + 0.2 : 6.2), roofY = FOUNDATION + 2.8;
    if (family !== "apartment" && family !== "townhouse") {
      this.box(canopyWidth + 0.25, 0.12, 1.8, 0, roofY, d / 2 + 0.77, "roof", p.roof, "shell");
      this.box(canopyWidth + 0.3, 0.16, 0.12, 0, roofY - 0.02, d / 2 + 1.67, "wood", p.trim);
      for (const x of [-canopyWidth / 2 + 0.16, canopyWidth / 2 - 0.16]) {
        this.box(0.15, 2.63, 0.15, x, FOUNDATION + 1.315, d / 2 + 1.32, "wood", p.timber, "detail", true);
        this.batch.beam(new THREE.Vector3(x, roofY - 0.65, d / 2 + 1.32), new THREE.Vector3(x * 0.72, roofY - 0.12, d / 2 + 1.32), 0.1, "wood", p.trim);
      }
    } else {
      this.box(3.1, 0.13, 1.22, 0, roofY, d / 2 + 0.56, "metal", p.trim, "shell");
    }
    // Exterior pots and lanterns deliberately sit outside the 2m entry passage.
    for (const x of [-1.62, 1.72]) {
      this.batch.cylinder(0.22, 0.37, x, FOUNDATION + 0.185, d / 2 + 0.5, "stone", p.trim);
      this.batch.add(new THREE.IcosahedronGeometry(0.27, 0).scale(1, 1.4, 1).translate(x, FOUNDATION + 0.57, d / 2 + 0.5), "leaf", 0x668a66);
      this.box(0.09, 0.38, 0.09, x, FOUNDATION + 2.09, d / 2 + 0.26, "metal", 0x55584e);
      this.box(0.21, 0.28, 0.19, x, FOUNDATION + 2.1, d / 2 + 0.33, "paper", 0xf2dba6);
      this.box(0.25, 0.045, 0.23, x, FOUNDATION + 2.27, d / 2 + 0.33, "metal", p.timber);
    }
  }

  /** Solid sloped roof skins + filled gable triangles, not cones intersecting upper rooms. */
  roofProfile(profile: [number, number][], depth: number, z: number, base: number, finish: HouseFinish = "roof", color = this.palette.roof): void {
    const vertices: number[] = [];
    for (let i = 0; i < profile.length - 1; i++) {
      const [x0, y0] = profile[i], [x1, y1] = profile[i + 1], a = z - depth / 2, b = z + depth / 2;
      vertices.push(x0, base + y0, a, x0, base + y0, b, x1, base + y1, a, x1, base + y1, a, x0, base + y0, b, x1, base + y1, b);
      // Eave underside adds real thickness along the slope without filling the room.
      vertices.push(x0, base + y0 - 0.12, a, x1, base + y1 - 0.12, a, x0, base + y0 - 0.12, b, x1, base + y1 - 0.12, a, x1, base + y1 - 0.12, b, x0, base + y0 - 0.12, b);
      for (const end of [a, b]) this.batch.beam(new THREE.Vector3(x0, base + y0, end), new THREE.Vector3(x1, base + y1, end), 0.14, "wood", this.palette.trim);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
    geometry.setAttribute("uv", new THREE.Float32BufferAttribute(new Float32Array(vertices.length / 3 * 2), 2));
    geometry.computeVertexNormals(); this.batch.add(geometry, finish, color, "shell");
    // Gable infill belongs entirely ABOVE the ceiling; no exterior-kit face can block a suite.
    for (const front of [false, true]) {
      const face: number[] = [];
      const end = z + (front ? 1 : -1) * (depth / 2 - 0.45);
      for (let i = 0; i < profile.length - 1; i++) {
        const [x0, y0] = profile[i], [x1, y1] = profile[i + 1];
        const quad = [x0, base, end, x1, base, end, x0, base + y0, end, x1, base, end, x1, base + y1, end, x0, base + y0, end];
        if (!front) {
          for (let t = 0; t < quad.length; t += 9) face.push(...quad.slice(t + 6, t + 9), ...quad.slice(t + 3, t + 6), ...quad.slice(t, t + 3));
        } else face.push(...quad);
      }
      const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(face, 3));
      g.setAttribute("uv", new THREE.Float32BufferAttribute(new Float32Array(face.length / 3 * 2), 2)); g.computeVertexNormals();
      this.batch.add(g, "plaster", this.palette.wall, "shell");
    }
    for (const [x, y] of [profile[0], profile[profile.length - 1]]) this.box(0.13, 0.17, depth, x, base + y - 0.07, z, "wood", this.palette.trim);
  }

  roof(): void {
    const { width: w, depth: d, storeys, family } = this.record, p = this.palette, top = FOUNDATION + storeys * STOREY;
    const half = w / 2 + 0.75;
    if (family === "japanese") {
      this.roofProfile([[-half - 0.12, 0.18], [-half + 0.7, 0.13], [-w * 0.2, 1.45], [0, 1.94], [w * 0.2, 1.45], [half - 0.7, 0.13], [half + 0.12, 0.18]], d + 1.6, 0, top);
      this.box(0.19, 0.2, d + 1.8, 0, top + 2.01, 0, "roof", p.roof);
      for (const z of [-d / 2 - 0.6, d / 2 + 0.6]) this.box(0.28, 0.35, 0.48, 0, top + 2.11, z, "roof", p.roof);
    } else if (family === "farm" || family === "tavern") {
      this.roofProfile([[-half, 0.06], [-w * 0.27, 1.85], [0, 2.58], [w * 0.27, 1.85], [half, 0.06]], d + 1.3, 0, top);
      this.box(0.16, 0.15, d + 1.45, 0, top + 2.6, 0, "metal", p.roof);
      if (family === "farm") {
        this.box(1.22, 1.12, 1.28, -1.2, top + 2.54, -d * 0.1, "wood", p.trim, "shell");
        this.roofProfile([[-1.98, 0], [-1.2, 0.64], [-0.42, 0]], 1.55, -d * 0.1, top + 3.1);
        for (const x of [-1.52, -0.91]) this.box(0.34, 0.45, 0.025, x, top + 2.75, -d * 0.1 + 0.65, "metal", p.roof);
      }
    } else if (family === "townhouse") {
      this.roofProfile([[-half, 0.07], [-w * 0.3, 1.95], [w * 0.3, 1.95], [half, 0.07]], d + 1.1, 0, top);
      for (const x of [-w * 0.24, w * 0.24]) this.dormer(x, d / 2 - 0.25, top + 0.75, 1.42);
    } else if (family === "shop") {
      this.roofProfile([[-half, 0.1], [half, 1.12]], d + 1.2, 0, top, "metal");
      this.box(w + 0.42, 0.55, 0.25, 0, top + 0.27, d / 2 + 0.1, "plaster", p.trim, "shell");
    } else if (family === "apartment") {
      this.box(w + 0.45, 0.23, d + 0.5, 0, top + 0.1, 0, "stone", p.trim, "shell");
      for (const z of [-d / 2, d / 2]) this.box(w + 0.3, 0.77, 0.18, 0, top + 0.48, z, "plaster", p.trim, "shell");
      for (const x of [-w / 2, w / 2]) this.box(0.18, 0.77, d + 0.3, x, top + 0.48, 0, "plaster", p.trim, "shell");
      this.box(3, 0.4, 2.8, -w * 0.23, top + 0.3, -d * 0.22, "metal", p.roof);
      this.batch.cylinder(0.85, 1.4, w * 0.24, top + 0.91, -d * 0.23, "metal", 0xb0b7a9, "shell");
      this.batch.cylinder(0.9, 0.15, w * 0.24, top + 1.67, -d * 0.23, "metal", p.roof);
      for (let i = 0; i < 2; i++) this.box(1.1, 0.45, 0.86, -w * 0.2 + i * 1.3, top + 0.44, d * 0.17, "metal", 0xa0aba3);
    } else if (family === "coastal") {
      this.roofProfile([[-half, 0.05], [-w * 0.16, 1.67], [half, 0.05]], d + 1.45, 0, top);
      this.box(0.14, 0.17, d + 1.6, -w * 0.16, top + 1.7, 0, "wood", p.trim);
    } else {
      this.roofProfile([[-half, 0.03], [0, 2.8], [half, 0.03]], d + 1.3, 0, top);
      this.dormer(-w * 0.23, d / 2 - 0.36, top + 0.75, 1.72);
    }
    if (["cottage", "farm", "tavern", "townhouse"].includes(family)) {
      const x = w * 0.3, z = -d * 0.22;
      this.box(0.83, 2.6, 0.86, x, top + 1.3, z, "brick", p.stone, "shell");
      this.box(1.01, 0.18, 1.04, x, top + 2.69, z, "stone", p.trim);
      for (const cx of [x - 0.2, x + 0.2]) this.batch.cylinder(0.12, 0.35, cx, top + 2.95, z, "brick", p.roof);
    }
  }

  dormer(x: number, z: number, y: number, width: number): void {
    const p = this.palette;
    this.box(width, 1.04, 0.68, x, y + 0.5, z, "wood", p.trim);
    this.box(width - 0.33, 0.72, 0.028, x, y + 0.52, z + 0.354, "glass", 0xb1ccd0);
    this.box(0.055, 0.75, 0.045, x, y + 0.52, z + 0.38, "wood", p.timber);
    this.box(width - 0.26, 0.055, 0.045, x, y + 0.52, z + 0.38, "wood", p.timber);
    this.roofProfile([[x - width / 2 - 0.12, 0], [x, 0.53], [x + width / 2 + 0.12, 0]], 1.08, z, y + 1.04);
  }

  details(): void {
    const { width: w, depth: d, family, storeys } = this.record, p = this.palette;
    const front = d / 2;
    if (family === "tavern" || family === "japanese" || family === "farm") {
      // Half-timber cross braces skirt windows, never span openings or entrances.
      for (let s = 0; s < storeys; s++) for (const side of [-1, 1]) {
        const x = side * (w / 2 - 0.57), f = FOUNDATION + s * STOREY;
        this.box(0.12, STOREY - 0.1, 0.1, x, f + STOREY / 2, front + 0.16, "wood", p.timber);
        this.batch.beam(new THREE.Vector3(x - 0.34, f + 0.18, front + 0.17), new THREE.Vector3(x + 0.34, f + 2.7, front + 0.17), 0.085, "wood", p.timber);
      }
    }
    if (family === "cottage" || family === "coastal" || family === "farm") {
      for (let s = 0; s < storeys; s++) for (const x of [-w * 0.31, w * 0.31]) {
        const f = FOUNDATION + s * STOREY;
        for (const dx of [-1.04, 1.04]) {
          this.box(0.35, 1.46, 0.085, x + dx, f + 1.66, front + 0.17, "wood", p.trim);
          for (let i = 0; i < 6; i++) this.box(0.36, 0.055, 0.1, x + dx, f + 1.05 + i * 0.23, front + 0.21, "wood", p.timber);
        }
        this.box(1.87, 0.22, 0.36, x, f + 0.67, front + 0.32, "wood", p.trim);
        for (let i = 0; i < 6; i++) {
          this.batch.add(new THREE.IcosahedronGeometry(0.14, 0).translate(x - 0.7 + i * 0.28, f + 0.86, front + 0.34), "leaf", 0x70885c);
          this.batch.add(new THREE.IcosahedronGeometry(0.07, 0).translate(x - 0.7 + i * 0.28, f + 1, front + 0.35), "fabric", i % 2 ? 0xe4bb70 : 0xc07c79);
        }
      }
    }
    if (family === "shop" || family === "tavern") {
      const signY = FOUNDATION + 2.88;
      this.box(family === "shop" ? 4.3 : 3.3, 0.44, 0.17, 0, signY, front + 0.2, "wood", p.timber);
      // Locally drawn heraldic shop/tavern motifs avoid font/network dependencies.
      for (let i = 0; i < 5; i++) {
        const x = -1.35 + i * 0.67;
        this.box(0.085, 0.24, 0.035, x, signY, front + 0.3, "paper", 0xe5d3a0);
        this.box(0.29, 0.045, 0.035, x + 0.1, signY + 0.075, front + 0.3, "paper", 0xe5d3a0);
      }
      if (family === "shop") {
        // Individual striped awning panels above the entrance head clearance.
        for (let i = 0; i < 14; i++) {
          const x = -3.08 + i * 0.47;
          this.box(0.465, 0.08, 1.45, x, FOUNDATION + 2.77, front + 0.77, "fabric", i % 2 ? 0xe7dec6 : p.accent);
          this.box(0.465, 0.25, 0.065, x, FOUNDATION + 2.62, front + 1.46, "fabric", i % 2 ? 0xe7dec6 : p.accent);
        }
        for (const x of [-w / 2 + 0.8, w / 2 - 0.8]) {
          this.box(0.77, 0.62, 0.68, x, FOUNDATION + 0.31, front + 0.62, "wood", p.trim);
          for (let i = 0; i < 6; i++) this.batch.add(new THREE.IcosahedronGeometry(0.09, 0).translate(x - 0.24 + i % 3 * 0.23, FOUNDATION + 0.68, front + 0.48 + Math.floor(i / 3) * 0.22), "leaf", i % 2 ? 0xd69b55 : 0x86a15e);
        }
      } else {
        const x = -w / 2 - 0.3;
        this.batch.beam(new THREE.Vector3(x, FOUNDATION + 2.9, front - 0.15), new THREE.Vector3(x, FOUNDATION + 2.9, front + 1.1), 0.09, "metal", p.timber);
        this.box(0.09, 0.72, 0.78, x, FOUNDATION + 2.45, front + 0.72, "wood", p.trim);
        for (const cx of [-w / 2 + 0.66, w / 2 - 0.66]) {
          this.batch.cylinder(0.38, 0.82, cx, FOUNDATION + 0.41, front + 0.67, "wood", p.timber);
          for (const y of [0.18, 0.66]) this.batch.cylinder(0.39, 0.055, cx, FOUNDATION + y, front + 0.67, "metal", 0x62635b);
        }
      }
    }
    if (family === "apartment") {
      for (let s = 0; s < storeys; s++) {
        const y = FOUNDATION + s * STOREY + 1.5;
        this.box(0.44, 0.5, 0.69, w / 2 + 0.28, y, d * 0.27, "metal", 0xbbc3b7);
        for (let i = 0; i < 5; i++) this.box(0.015, 0.032, 0.5, w / 2 + 0.51, y - 0.15 + i * 0.075, d * 0.27, "metal", p.roof);
      }
      this.box(0.38, 1.1, 0.1, -1.38, FOUNDATION + 1.2, front + 0.2, "metal", p.trim);
      for (let i = 0; i < 4; i++) this.box(0.24, 0.035, 0.03, -1.38, FOUNDATION + 0.83 + i * 0.25, front + 0.265, "metal", 0xd7d4be);
    }
    // Gutters/downpipes and readable foundation courses provide silhouette at medium distance.
    for (const x of [-w / 2 - 0.18, w / 2 + 0.18]) {
      this.box(0.075, storeys * STOREY - 0.2, 0.075, x, FOUNDATION + storeys * STOREY / 2, -d / 2 - 0.17, "metal", p.roof);
      this.box(0.26, 0.12, d + 0.5, x, FOUNDATION + storeys * STOREY - 0.14, 0, "metal", p.roof);
    }
    // Narrow skirting follows room sides without putting a plinth across the open ground doorway.
    for (const side of [-1, 1]) this.box((w - DOOR_WIDTH) / 2, 0.15, 0.1, side * (w + DOOR_WIDTH) / 4, FOUNDATION + 0.08, front + 0.13, "stone", p.stone);
  }

  build(peakDetails?: HouseMaterials): HouseRuntime {
    this.shell(); this.porch(); this.roof(); this.details();
    this.batch.finish(this.root);
    if (peakDetails) this.batch.detail.add(createPeakHouseDetails(this.record, this.palette, peakDetails));
    this.root.updateMatrixWorld(true);
    this.record.bounds.setFromObject(this.root);
    return {
      root: this.root, batch: this.batch, record: this.record, distance: Number.POSITIVE_INFINITY,
      door: {
        hinges: this.doors,
        colliderId: `${this.record.id}-door-leaf`,
        width: DOOR_WIDTH - 0.12,
        height: DOOR_HEIGHT - 0.09,
        depth: 0.1,
        hingeX: -DOOR_WIDTH / 2 + 0.035,
        hingeZ: this.record.depth / 2 + 0.04,
        angle: 0,
        target: 0,
      },
      doorMaterials: this.doorMaterials,
    };
  }
}

/** Eight locally generated, genuinely enterable families. Caller controls placement, terrain and quality. */
export function createHouses(spots: readonly HouseSpot[], peakMaterials?: PeakMaterials): IslandHouses {
  const group = new THREE.Group(); group.name = "island-houses";
  const colliders: WorldCollider[] = [], supports: WorldSupport[] = [], houses: HouseRecord[] = [];
  const materials = createHouseMaterials();
  if (peakMaterials) {
    const finish = materials.materials;
    applyPeakSurface(finish.plaster, peakMaterials.surfaces.plaster);
    applyPeakSurface(finish.brick, peakMaterials.surfaces.brick);
    applyPeakSurface(finish.roof, peakMaterials.surfaces.roof);
    applyPeakSurface(finish.tile, peakMaterials.surfaces.roof);
    applyPeakSurface(finish.stone, peakMaterials.surfaces.rock);
    applyPeakSurface(finish.wood, peakMaterials.surfaces.bark);
  }
  const runtimes: HouseRuntime[] = [];
  for (const [index, spot] of spots.entries()) {
    const runtime = new HouseBuilder(spot, index, materials, colliders, supports).build(peakMaterials ? materials : undefined);
    group.add(runtime.root); runtimes.push(runtime); houses.push(runtime.record);
  }
  let disposed = false, cullTime = 0;
  const doorRange = 3.4;
  const nearestDoor = (playerPosition: THREE.Vector3, maxDistance = doorRange) => {
    let best: { runtime: HouseRuntime; distance: number } | null = null;
    for (const runtime of runtimes) {
      const distance = playerPosition.distanceTo(runtime.record.doorway);
      if (distance <= maxDistance && (!best || distance < best.distance)) best = { runtime, distance };
    }
    return best;
  };
  return {
    group, colliders, supports, houses,
    nearestDoor(playerPosition, maxDistance = doorRange) {
      const nearest = nearestDoor(playerPosition, maxDistance);
      if (!nearest) return null;
      return {
        houseId: nearest.runtime.record.id,
        distance: nearest.distance,
        open: nearest.runtime.door.target > 0.6,
      };
    },
    toggleNearestDoor(playerPosition) {
      const nearest = nearestDoor(playerPosition);
      if (!nearest || nearest.runtime.door.hinges.length !== 1) return false;
      nearest.runtime.door.target = nearest.runtime.door.target > 0.6 ? 0 : Math.PI * 0.48;
      return true;
    },
    attachCollision(world) {
      for (const runtime of runtimes) {
        const record = runtime.record;
        if (runtime.door.hinges.length !== 1) continue;
        const add = world.addCollider?.bind(world);
        const remove = world.removeCollider?.bind(world);
        if (!add || !remove) continue;
        let colliderAngle = Number.NaN;
        runtime.updateDoorCollider = () => {
          if (Math.abs(runtime.door.angle - colliderAngle) < 0.003) return;
          colliderAngle = runtime.door.angle;
          remove(runtime.door.colliderId);
          const { width, height, depth, hingeX, hingeZ, angle } = runtime.door;
          const leafX = hingeX + Math.cos(angle) * width / 2;
          const leafZ = hingeZ - Math.sin(angle) * width / 2;
          const leafCenter = worldPoint(record.spot, leafX, FOUNDATION + DOOR_HEIGHT / 2, leafZ);
          add({ id: runtime.door.colliderId, center: leafCenter,
            size: new THREE.Vector3(width, height, depth),
            yaw: record.spot.ry + angle, kind: "wall" });
        };
        runtime.removeDoorCollider = () => remove(runtime.door.colliderId);
        runtime.updateDoorCollider();
      }
    },
    update(dt, playerPosition, viewPosition = playerPosition) {
      if (disposed) return;
      const doorBlend = 1 - Math.exp(-Math.max(0, dt) * 9);
      for (const runtime of runtimes) {
        runtime.door.angle += (runtime.door.target - runtime.door.angle) * doorBlend;
        runtime.door.hinges.forEach(hinge => { hinge.rotation.y = runtime.door.angle; });
        runtime.updateDoorCollider?.();
      }
      cullTime += Math.max(0, dt);
      // Cadence cap is independent of render FPS; a newly entered house cannot have hidden rooms.
      const refresh = cullTime >= 0.12;
      if (refresh) cullTime = 0;
      for (const runtime of runtimes) {
        const { record, root, batch } = runtime;
        const dx = playerPosition.x - record.spot.x, dz = playerPosition.z - record.spot.z;
        const c = Math.cos(record.spot.ry), s = Math.sin(record.spot.ry);
        const lx = c * dx - s * dz, lz = s * dx + c * dz;
        const nearby = Math.abs(lx) < record.width / 2 + 4 && Math.abs(lz) < record.depth / 2 + 4;
        if (!refresh && !nearby) continue;
        runtime.distance = Math.hypot(dx, dz);
        const viewDistance = Math.hypot(viewPosition.x - record.spot.x, viewPosition.z - record.spot.z);
        const visibleDistance = Math.min(runtime.distance, viewDistance);
        root.visible = visibleDistance < (root.visible ? 560 : 520) || nearby;
        batch.interior.visible = nearby || visibleDistance < (batch.interior.visible ? 78 : 68);
        batch.detail.visible = nearby || visibleDistance < (batch.detail.visible ? 190 : 175);
      }
      if (refresh) {
        // Bounded shadow draw calls: nearest six buildings, at most two shell batches each.
        const nearest = [...runtimes].filter((runtime) => runtime.distance < 85).sort((a, b) => a.distance - b.distance).slice(0, 6);
        const casters = new Set(nearest);
        for (const runtime of runtimes) runtime.batch.shadowMeshes.forEach((mesh, index) => { mesh.castShadow = index < 2 && casters.has(runtime); });
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const runtime of runtimes) runtime.removeDoorCollider?.();
      group.traverse((object) => { if (object instanceof THREE.Mesh) object.geometry.dispose(); });
      for (const runtime of runtimes) runtime.doorMaterials.forEach(material => material.dispose());
      materials.dispose(); group.clear(); group.removeFromParent();
    },
  };
}
