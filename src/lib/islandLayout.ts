import * as THREE from "three";
import { getIslandHeight, sampleIslandWater, sourceToWorld } from "./islandTerrain";
import { sampleRoadPath } from "./worldTypes";
import type { CivicLot, HouseFamily, HouseSpot, IslandPlot, IslandRoad } from "./worldTypes";

export interface WorldRoad extends IslandRoad {
  kind: "street" | "lane" | "trail";
  name: string;
}
export interface IslandField { x: number; z: number; width: number; depth: number; yaw: number }
export interface IslandLayout {
  roads: WorldRoad[];
  plots: IslandPlot[];
  spots: HouseSpot[];
  civicLots: CivicLot[];
  fields: IslandField[];
  addedHomes: HouseSpot[];
  centres: Record<"town" | "harbour" | "forest" | "farms" | "mountains" | "lake", THREE.Vector2>;
  distanceToRoad(x: number, z: number): number;
  isReserved(x: number, z: number, padding?: number): boolean;
}

const point = (x: number, z: number) => sourceToWorld(x, z);

/** One shared, metre-scale plan drives terrain flattening, buildings, roads and vegetation. */
export function createIslandLayout(): IslandLayout {
  const roads: WorldRoad[] = [], plots: IslandPlot[] = [], spots: HouseSpot[] = [], civicLots: CivicLot[] = [];
  const centres = {
    town: point(0, 0), harbour: point(-230, -140), forest: point(210, 170),
    farms: point(110, 330), mountains: point(420, -350), lake: point(-340, 240),
  };
  const addRoad = (name: string, points: THREE.Vector2[], width: number, kind: WorldRoad["kind"]) => {
    roads.push({ name, points, width, kind });
  };
  const families: HouseFamily[] = ["japanese", "townhouse", "shop", "cottage", "apartment", "coastal", "tavern", "farm"];
  const route = (name: string, coordinates: [number, number][], width = 6, kind: WorldRoad["kind"] = "lane") =>
    addRoad(name, coordinates.map(([x, z]) => point(x, z)), width, kind);
  const addHouse = (x: number, z: number, ry: number, family: HouseFamily) => {
    const y = getIslandHeight(x, z);
    if (y < 1.25 || sampleIslandWater(x, z)) return;
    if (spots.some(s => Math.hypot(s.x - x, s.z - z) < 19)) return;
    spots.push({ x, y, z, ry, family, seed: 1801 + spots.length * 137 });
    plots.push({ x, z, radius: 14 });
  };
  const yAt = (x: number, z: number) => getIslandHeight(x, z);
  const reserve = (x: number, z: number, radius: number) => {
    if (yAt(x, z) < 1.25 || sampleIslandWater(x, z) || distanceToRoad(x, z) < radius + 3) return false;
    if (spots.some(s => Math.hypot(s.x - x, s.z - z) < radius + 13) || civicLots.some(l => Math.hypot(l.x - x, l.z - z) < radius + 18)) return false;
    for (const field of fields) {
      const dx = x - field.x, dz = z - field.z, c = Math.cos(field.yaw), s = Math.sin(field.yaw);
      if (Math.abs(dx * c - dz * s) < field.width / 2 + radius && Math.abs(dx * s + dz * c) < field.depth / 2 + radius) return false;
    }
    plots.push({ x, z, radius });
    return true;
  };
  const addCivic = (kind: CivicLot["kind"], x: number, z: number, ry: number, radius: number) => {
    if (!reserve(x, z, radius)) return null;
    const lot = { kind, x, y: yAt(x, z), z, ry, seed: 9413 + civicLots.length * 271 };
    civicLots.push(lot);
    return lot;
  };
  const addBusStop = (x: number, z: number, ry: number) => {
    if (sampleIslandWater(x, z) || yAt(x, z) < 1.25 || distanceToRoad(x, z) > 7 ||
        spots.some(s => Math.hypot(s.x - x, s.z - z) < 9) ||
        civicLots.some(l => Math.hypot(l.x - x, l.z - z) < (l.kind === "busStop" ? 100 : 10))) return null;
    const lot = { kind: "busStop" as const, x, y: yAt(x, z), z, ry, seed: 9413 + civicLots.length * 271 };
    civicLots.push(lot);
    return lot;
  };
  // A curved, irregular street grid keeps the central town readable but avoids perfect rows.
  for (const z of [-82, -28, 28, 82]) {
    addRoad(`Town street ${z}`, [-132, -65, 0, 66, 132].map((x, i) => new THREE.Vector2(x, z + Math.sin((x / 132) * Math.PI) * (i % 2 ? 2 : -2))), 8, "street");
    for (const side of [-1, 1]) for (let column = 0; column < 8; column++) {
      const jitterX = Math.sin((column + 1) * 17 + z) * 3.4, jitterZ = Math.cos((column + 2) * 9 + z) * 2.2;
      const x = -93 + column * 26 + jitterX, hz = z + side * (15 + jitterZ);
      if (Math.abs(x) < 22 && Math.abs(hz) < 22) continue;
      const familyIndex = Math.abs(Math.floor((x + hz) * 0.41)) % families.length;
      addHouse(x, hz, side < 0 ? 0 : Math.PI, families[familyIndex]);
    }
  }
  addRoad("Town west", [-110, -48, 18, 96].map(z => new THREE.Vector2(-132, z)), 8, "street");
  addRoad("Town east", [-110, -48, 18, 96].map(z => new THREE.Vector2(132, z)), 8, "street");
  addRoad("Market square", [-32, -8, 30].map(z => new THREE.Vector2(0, z)), 8, "street");
  plots.push({ x: 0, z: 0, radius: 24 });

  route("Harbour road", [[-58, -37], [-90, -55], [-145, -70], [-205, -110], [-230, -140], [-270, -140]], 8);
  route("Northern ridge", [[-58, -37], [-90, -110], [-65, -230], [-35, -340], [-80, -470], [-120, -630]], 5);
  route("Eastern forest road", [[58, 37], [115, 55], [165, 115], [210, 170], [280, 185], [345, 260]], 7);
  route("Farm road", [[0, 37], [10, 100], [65, 205], [110, 330], [160, 360], [225, 350], [330, 380], [370, 490], [440, 650], [380, 800]], 7);
  route("Southwest lane", [[-58, 37], [-130, 120], [-180, 225], [-160, 330], [-120, 430], [-90, 565], [-150, 730]], 5);
  route("Farm loop", [[-160, 330], [-100, 365], [0, 370], [110, 330]], 5);
  route("Southern coast lane", [[-150, 730], [-40, 780], [80, 745], [190, 700], [280, 690], [380, 800]], 5);
  route("Forest footpath", [[210, 170], [260, 60], [285, -90], [330, -180], [420, -350], [400, -510]], 2.5, "trail");
  route("Lake walk", [[-180, 225], [-230, 230], [-285, 280], [-340, 300], [-400, 275]], 2.5, "trail");

  const village = (centre: THREE.Vector2, count: number, name: string, families: HouseFamily[]) => {
    const half = count / 2;
    addRoad(name, [new THREE.Vector2(centre.x - half * 13 - 16, centre.y), new THREE.Vector2(centre.x + half * 13 + 16, centre.y)], 7, "lane");
    for (let i = 0; i < half; i++) for (const side of [-1, 1]) {
      addHouse(centre.x + (i - (half - 1) / 2) * 26, centre.y + side * 16, side < 0 ? 0 : Math.PI, families[i % families.length]);
    }
  };
  village(centres.harbour, 12, "Harbour frontage", ["coastal", "shop", "japanese", "tavern"]);
  village(centres.forest, 10, "Forest hamlet", ["cottage", "japanese", "coastal"]);
  village(centres.farms, 12, "Farm hamlet", ["farm", "cottage", "shop"]);

  // Road-connected isolated plots, facing their own short access lanes.
  for (const [sx, sz] of [[-70, -230], [-35, -340], [-180, 225], [345, 260], [-120, 430], [-90, 565], [190, 700], [330, 380]]) {
    const p = point(sx, sz), x = p.x + 23, z = p.y;
    addHouse(x, z, -Math.PI / 2, sz > 300 ? "farm" : "cottage");
    addRoad("Plot access", [p, new THREE.Vector2(x - 7, z)], 3, "trail");
  }
  const fields: IslandField[] = [
    [80, 420, 120, 90, 0.3], [210, 460, 110, 85, 0.3], [330, 510, 110, 85, 0.35],
    [40, 550, 130, 95, 0.3], [180, 600, 120, 90, 0.32], [-80, 650, 110, 85, 0.25],
  ].map(([x, z, w, d, yaw]) => {
    const p = point(x, z), scale = point(1, 0).x;
    return { x: p.x, z: p.y, width: w * scale, depth: d * scale, yaw };
  });
  const segments = roads.flatMap(road => {
    const samples = sampleRoadPath(road.points, 0.5);
    return samples.slice(1).map((b, i) => ({ a: samples[i], b, width: road.width }));
  });
  const distanceToRoad = (x: number, z: number) => {
    let best = Infinity;
    for (const { a, b, width } of segments) {
      const dx = b.x - a.x, dz = b.z - a.z;
      const t = THREE.MathUtils.clamp(((x - a.x) * dx + (z - a.z) * dz) / (dx * dx + dz * dz || 1), 0, 1);
      best = Math.min(best, Math.hypot(x - a.x - t * dx, z - a.z - t * dz) - width / 2);
    }
    return best;
  };
  const isReserved = (x: number, z: number, padding = 0) => {
    if (distanceToRoad(x, z) < padding + 2) return true;
    if (plots.some(p => Math.hypot(x - p.x, z - p.z) < p.radius + padding)) return true;
    for (const f of fields) {
      const dx = x - f.x, dz = z - f.z, c = Math.cos(f.yaw), s = Math.sin(f.yaw);
      if (Math.abs(dx * c - dz * s) < f.width / 2 + padding && Math.abs(dx * s + dz * c) < f.depth / 2 + padding) return true;
    }
    return false;
  };
  // The town plaza is the island's public park and fountain square.
  civicLots.push({ kind: "park", x: 0, y: yAt(0, 0), z: 0, ry: 0, seed: 76001 });

  // Public buildings sit near, not on, their access roads; candidates are tried in stable order.
  for (const [kind, candidates, yaw, radius] of [
    ["school", [[-145, -205], [-115, -190], [-175, -180], [120, 90]], 0, 32],
    ["supermarket", [[85, -120], [155, -80], [-70, 105], [260, 220]], Math.PI / 2, 24],
    ["apartment", [[-30, -130], [90, 120], [300, 280], [-200, 400]], Math.PI, 17],
  ] as const) {
    for (const [sx, sz] of candidates) {
      const p = point(sx, sz), lot = addCivic(kind, p.x, p.y, yaw, radius);
      if (!lot) continue;
      if (kind === "apartment") {
        spots.push({ x: lot.x, y: lot.y, z: lot.z, ry: lot.ry, family: "apartment", seed: lot.seed });
      }
      break;
    }
  }
  const housingRoutes = roads.filter(road =>
    ["Harbour road", "Northern ridge", "Eastern forest road", "Farm road", "Southwest lane", "Farm loop", "Southern coast lane"].includes(road.name));
  const routeCandidates = housingRoutes.map((road, roadIndex) => sampleRoadPath(road.points, 58).slice(1, -1).flatMap((sample, sampleIndex) =>
    [-1, 1].map(side => {
      const tangentYaw = Math.atan2(sample.dx, sample.dz);
      const offset = road.width / 2 + 30 + ((roadIndex * 7 + sampleIndex * 3) % 6);
      return {
        x: sample.x - sample.dz * offset * side,
        z: sample.z + sample.dx * offset * side,
        ry: tangentYaw - side * Math.PI / 2,
        sampleIndex,
        side,
      };
    })));
  const addedHomes: HouseSpot[] = [];
  let added = 0;
  for (let round = 0; added < 48 && round < Math.max(...routeCandidates.map(points => points.length / 2)); round++) {
    for (let roadIndex = 0; roadIndex < housingRoutes.length && added < 48; roadIndex++) {
      for (const side of [0, 1]) {
        const candidate = routeCandidates[roadIndex][round * 2 + side];
        if (!candidate) continue;
        const { x, z, ry, sampleIndex } = candidate;
        const y = yAt(x, z), grade = Math.hypot(yAt(x - 4, z) - yAt(x + 4, z), yAt(x, z - 4) - yAt(x, z + 4)) / 8;
        const clearOfHomes = spots.every(home => Math.hypot(home.x - x, home.z - z) >= 27);
        const clearOfCivic = civicLots.every(lot => Math.hypot(lot.x - x, lot.z - z) >= (lot.kind === "park" ? 38 : 42));
        if (y <= 1.25 || sampleIslandWater(x, z) || distanceToRoad(x, z) < 9 || distanceToRoad(x, z) > 36 ||
            grade > 0.16 || isReserved(x, z, 1) || !clearOfHomes || !clearOfCivic) continue;
        const familyIndex = (roadIndex * 5 + sampleIndex * 3 + side) % families.length;
        const before = spots.length;
        addHouse(x, z, ry, z > 950 ? "farm" : families[familyIndex]);
        if (spots.length > before) { addedHomes.push(spots[spots.length - 1]); added++; }
      }
    }
  }

  const busStopRoads = roads.filter(road => road.kind !== "trail");
  for (const road of busStopRoads) {
    const samples = sampleRoadPath(road.points, 52);
    for (let i = 0; i < samples.length; i += 2) {
      const sample = samples[i];
      const side = (road.name.length + i) % 2 ? 1 : -1;
      const tangentYaw = Math.atan2(sample.dx, sample.dz);
      const yaw = tangentYaw + side * Math.PI / 2;
      const offset = road.width / 2 + 6.6;
      const x = sample.x - sample.dz * offset * side;
      const z = sample.z + sample.dx * offset * side;
      if (addBusStop(x, z, yaw)) break;
    }
  }
  return { roads, plots, spots, civicLots, fields, addedHomes, centres, distanceToRoad, isReserved };
}
