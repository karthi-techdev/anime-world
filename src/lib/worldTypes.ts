import * as THREE from "three";

export interface WaterSample {
  id: string;
  level: number;
  depth: number;
}

export interface WorldHit {
  distance: number;
  point: THREE.Vector3;
  normal: THREE.Vector3;
}

export interface WorldCollider {
  id: string;
  center: THREE.Vector3;
  size: THREE.Vector3;
  yaw: number;
  kind: "wall" | "furniture" | "tree" | "rock";
}

export interface WorldSupport {
  id: string;
  center: THREE.Vector3;
  width: number;
  depth: number;
  yaw: number;
  slopeZ?: number;
}

export interface WorldContact {
  addCollider?(collider: WorldCollider): unknown;
  removeCollider?(id: string): unknown;
  sampleTerrain(x: number, z: number): number;
  sampleWater(x: number, z: number): WaterSample | null;
  supportAt(x: number, z: number, feetY: number, maxStep?: number): number;
  move(position: THREE.Vector3, delta: THREE.Vector3, radius: number, height: number): THREE.Vector3;
  traceStatic(origin: THREE.Vector3, direction: THREE.Vector3, range: number, radius?: number): WorldHit | null;
  resolveCamera(pivot: THREE.Vector3, desired: THREE.Vector3, radius?: number): THREE.Vector3;
}

export type HouseFamily = "japanese" | "cottage" | "farm" | "coastal" | "townhouse" | "shop" | "tavern" | "apartment";

export interface HouseSpot {
  x: number;
  y: number;
  z: number;
  ry: number;
  seed: number;
  family?: HouseFamily;
}

export interface IslandPlot {
  x: number;
  z: number;
  radius: number;
}

export type CivicKind = "school" | "supermarket" | "busStop" | "apartment" | "park";
export interface CivicLot {
  kind: CivicKind;
  x: number;
  y: number;
  z: number;
  ry: number;
  seed: number;
}

export interface IslandRoad {
  points: THREE.Vector2[];
  width: number;
}

export interface RoadSample {
  x: number;
  z: number;
  dx: number;
  dz: number;
  distance: number;
}

/** Sample one centripetal spline for every road-dependent world system. */
export function sampleRoadPath(points: readonly THREE.Vector2[], spacing: number): RoadSample[] {
  if (points.length < 2) return [];
  const curve = new THREE.CatmullRomCurve3(
    points.map(point => new THREE.Vector3(point.x, point.y, 0)), false, "centripetal",
  );
  const divisions = Math.max(1, Math.ceil(curve.getLength() / Math.max(spacing, 0.25)));
  const parameters = new Set<number>();
  for (let i = 0; i <= divisions; i++) parameters.add(curve.getUtoTmapping(i / divisions, 0));
  for (let i = 0; i < points.length; i++) parameters.add(i / (points.length - 1));
  const ordered = [...parameters].sort((a, b) => a - b);
  let distance = 0;
  const samples: RoadSample[] = [];
  for (let i = 0; i < ordered.length; i++) {
    const point = curve.getPoint(ordered[i]), tangent = curve.getTangent(ordered[i]);
    if (i) distance += Math.hypot(point.x - samples[i - 1].x, point.y - samples[i - 1].z);
    samples.push({ x: point.x, z: point.y, dx: tangent.x, dz: tangent.y, distance });
  }
  return samples;
}

export interface WorldLandmark {
  name: string;
  position: THREE.Vector3;
}
