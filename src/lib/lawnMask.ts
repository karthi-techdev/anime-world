import * as THREE from "three";
import { HOUSE_FOOTPRINTS } from "./islandHouses";
import type { IslandLayout } from "./islandLayout";

/**
 * Camera-following fine lawn mask (0.29 m per texel, 300 m wide).
 * 255 = grass may grow, 0 = roads, sidewalks, house bodies, plaza, crop fields.
 * The coarse island texture (4.9 m cells) cannot keep yards up to the kerb, this can.
 */
export const LAWN_SIZE = 300, LAWN_RES = 1024;

export class LawnMask {
  readonly texture: THREE.DataTexture;
  readonly win = new THREE.Vector3(1e9, 1e9, LAWN_SIZE); // centre x, centre z, size
  private readonly data = new Uint8Array(LAWN_RES * LAWN_RES);
  constructor(private readonly layout: IslandLayout, private readonly roadPad = 1.5, private readonly housePad = 0.7) {
    this.texture = new THREE.DataTexture(this.data, LAWN_RES, LAWN_RES, THREE.RedFormat, THREE.UnsignedByteType);
    this.texture.minFilter = this.texture.magFilter = THREE.LinearFilter;
    this.texture.wrapS = this.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.texture.generateMipmaps = false;
    this.texture.needsUpdate = true;
  }

  update(x: number, z: number): void {
    if (Math.hypot(x - this.win.x, z - this.win.y) < 22) return;
    this.win.set(x, z, LAWN_SIZE);
    const S = LAWN_SIZE, cell = S / LAWN_RES, ox = x - S / 2, oz = z - S / 2, d = this.data;
    d.fill(255);
    const stamp = (minX: number, maxX: number, minZ: number, maxZ: number, hit: (px: number, pz: number) => boolean) => {
      const x0 = Math.max(0, Math.floor((minX - ox) / cell)), x1 = Math.min(LAWN_RES - 1, Math.ceil((maxX - ox) / cell));
      const z0 = Math.max(0, Math.floor((minZ - oz) / cell)), z1 = Math.min(LAWN_RES - 1, Math.ceil((maxZ - oz) / cell));
      for (let iz = z0; iz <= z1; iz++) for (let ix = x0; ix <= x1; ix++) {
        if (hit(ox + (ix + 0.5) * cell, oz + (iz + 0.5) * cell)) d[iz * LAWN_RES + ix] = 0;
      }
    };
    for (const road of this.layout.roads) {
      const pad = road.width / 2 + (road.kind === "trail" ? 0.3 : this.roadPad);
      for (let i = 1; i < road.points.length; i++) {
        const a = road.points[i - 1], b = road.points[i];
        const minX = Math.min(a.x, b.x) - pad, maxX = Math.max(a.x, b.x) + pad, minZ = Math.min(a.y, b.y) - pad, maxZ = Math.max(a.y, b.y) + pad;
        if (maxX < ox || minX > ox + S || maxZ < oz || minZ > oz + S) continue;
        const dx = b.x - a.x, dz = b.y - a.y, len2 = Math.max(dx * dx + dz * dz, 1e-4);
        stamp(minX, maxX, minZ, maxZ, (px, pz) => {
          const t = Math.min(1, Math.max(0, ((px - a.x) * dx + (pz - a.y) * dz) / len2));
          return Math.hypot(px - a.x - dx * t, pz - a.y - dz * t) < pad;
        });
      }
    }
    for (const s of this.layout.spots) {
      const fp = HOUSE_FOOTPRINTS[s.family ?? "japanese"] ?? HOUSE_FOOTPRINTS.japanese;
      const hw = fp.width / 2 + this.housePad, hd = fp.depth / 2 + this.housePad, r = Math.max(hw, hd) + 9;
      if (s.x + r < ox || s.x - r > ox + S || s.z + r < oz || s.z - r > oz + S) continue;
      const c = Math.cos(s.ry), sn = Math.sin(s.ry);
      stamp(s.x - r, s.x + r, s.z - r, s.z + r, (px, pz) => {
        const dx = px - s.x, dz = pz - s.z;
        const lx = dx * c - dz * sn, lz = dx * sn + dz * c;
        if (Math.abs(lx) < hw && Math.abs(lz) < hd) return true;
        return Math.abs(lx) < 3.6 && lz > hd - 1.5 && lz < fp.depth / 2 + 5.4; // front door stoop and steps
      });
    }
    for (const f of this.layout.fields) {
      const r = Math.hypot(f.width, f.depth) / 2 + 1.5, c = Math.cos(f.yaw), sn = Math.sin(f.yaw);
      stamp(f.x - r, f.x + r, f.z - r, f.z + r, (px, pz) => {
        const dx = px - f.x, dz = pz - f.z;
        return Math.abs(dx * c - dz * sn) < f.width / 2 + 1.5 && Math.abs(dx * sn + dz * c) < f.depth / 2 + 1.5;
      });
    }
    stamp(-25, 25, -25, 25, (px, pz) => Math.hypot(px, pz) < 25); // central plaza
    this.texture.needsUpdate = true;
  }

  dispose(): void { this.texture.dispose(); }
}

/**
 * Exact "may a tree trunk stand here" test for residential yards.
 * false = blocked by a road/sidewalk, a house body (rotated footprint), the front stoop, a crop field or the plaza.
 */
export function createYardTest(layout: IslandLayout, o: { road: number; house: number; stoop: number; plaza?: number }) {
  return (x: number, z: number, crown = 0): boolean => {
    if (Math.hypot(x, z) < (o.plaza ?? 28) + crown) return false;
    if (layout.distanceToRoad(x, z) < o.road + crown * 0.3) return false;
    for (const s of layout.spots) {
      const dx = x - s.x, dz = z - s.z;
      if (dx * dx + dz * dz > 900) continue;
      const fp = HOUSE_FOOTPRINTS[s.family ?? "japanese"] ?? HOUSE_FOOTPRINTS.japanese;
      const c = Math.cos(s.ry), sn = Math.sin(s.ry), lx = dx * c - dz * sn, lz = dx * sn + dz * c;
      if (Math.hypot(Math.max(Math.abs(lx) - fp.width / 2, 0), Math.max(Math.abs(lz) - fp.depth / 2, 0)) < o.house + crown) return false; // whole crown clears walls and roof
      if (Math.abs(lx) < o.stoop && lz > 0 && lz < fp.depth / 2 + 9) return false; // path from the door
    }
    for (const f of layout.fields) {
      const dx = x - f.x, dz = z - f.z, c = Math.cos(f.yaw), sn = Math.sin(f.yaw);
      if (Math.abs(dx * c - dz * sn) < f.width / 2 + 2 && Math.abs(dx * sn + dz * c) < f.depth / 2 + 2) return false;
    }
    return true;
  };
}
/** Distance (m) from a point to the nearest house footprint including roof eaves; 0 = under a house. */
export function createHouseDistance(layout: IslandLayout, eave = 0.9) {
  return (x: number, z: number): number => {
    let best = 1e9;
    for (const s of layout.spots) {
      const dx = x - s.x, dz = z - s.z;
      if (dx * dx + dz * dz > 3600) continue;
      const fp = HOUSE_FOOTPRINTS[s.family ?? "japanese"] ?? HOUSE_FOOTPRINTS.japanese;
      const c = Math.cos(s.ry), sn = Math.sin(s.ry), lx = dx * c - dz * sn, lz = dx * sn + dz * c;
      const ox = Math.max(Math.abs(lx) - (fp.width / 2 + eave), 0), oz = Math.max(Math.abs(lz) - (fp.depth / 2 + eave), 0);
      best = Math.min(best, Math.hypot(ox, oz));
    }
    return best;
  };
}