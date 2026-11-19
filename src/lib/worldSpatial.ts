import * as THREE from "three";
import type { WaterSample, WorldCollider, WorldContact, WorldHit, WorldSupport } from "./worldTypes";

const CELL_SIZE = 8;
const MAX_STEP = 0.32;
const SKIN = 0.001;
const EPSILON = 1e-8;
const FLOOR_THICKNESS = 0.05;
const MOVE_SAMPLE = 0.16;
const TERRAIN_SAMPLE = 0.25;
const UP = new THREE.Vector3(0, 1, 0);

export interface WorldSpatialOptions {
  terrain: (x: number, z: number) => number;
  water: (x: number, z: number) => WaterSample | null;
  halfExtent: number;
}

export interface WorldSpatialStats {
  colliders: number;
  supports: number;
  colliderCells: number;
  supportCells: number;
}

interface Bounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

interface Box extends Bounds {
  id: string;
  center: THREE.Vector3;
  axes: [THREE.Vector3, THREE.Vector3, THREE.Vector3];
  half: THREE.Vector3;
}

interface SupportBox extends Box {
  surface: THREE.Vector3;
  width: number;
  depth: number;
  cos: number;
  sin: number;
  slope: number;
}

interface SweepHit {
  distance: number;
  normal: THREE.Vector3;
}

/** Static, ID-addressed XZ hash; replacing an ID also removes its old cells. */
class SpatialHash<T extends Bounds & { id: string }> {
  readonly entries = new Map<string, T>();
  readonly cells = new Map<string, Set<T>>();

  visit(bounds: Bounds, visitor: (key: string) => void) {
    for (let x = Math.floor(bounds.minX / CELL_SIZE); x <= Math.floor(bounds.maxX / CELL_SIZE); x++) {
      for (let z = Math.floor(bounds.minZ / CELL_SIZE); z <= Math.floor(bounds.maxZ / CELL_SIZE); z++) {
        visitor(`${x},${z}`);
      }
    }
  }

  add(entry: T) {
    const previous = this.entries.get(entry.id);
    if (previous) {
      this.visit(previous, (key) => {
        const cell = this.cells.get(key);
        cell?.delete(previous);
        if (!cell?.size) this.cells.delete(key);
      });
    }
    this.entries.set(entry.id, entry);
    this.visit(entry, (key) => {
      let cell = this.cells.get(key);
      if (!cell) this.cells.set(key, (cell = new Set<T>()));
      cell.add(entry);
    });
  }

  query(bounds: Bounds): T[] {
    const cellCount = (Math.floor(bounds.maxX / CELL_SIZE) - Math.floor(bounds.minX / CELL_SIZE) + 1)
      * (Math.floor(bounds.maxZ / CELL_SIZE) - Math.floor(bounds.minZ / CELL_SIZE) + 1);
    const found = new Set<T>();
    // A long diagonal ray must not enumerate a map-sized rectangle of empty cells.
    if (cellCount > Math.max(64, this.cells.size * 2)) {
      for (const entry of this.entries.values()) {
        if (entry.maxX >= bounds.minX && entry.minX <= bounds.maxX
          && entry.maxZ >= bounds.minZ && entry.minZ <= bounds.maxZ) found.add(entry);
      }
    } else {
      this.visit(bounds, (key) => {
        for (const entry of this.cells.get(key) ?? []) found.add(entry);
      });
    }
    return [...found];
  }

  clear() {
    this.entries.clear();
    this.cells.clear();
  }
}

function boundsFor(center: THREE.Vector3, axes: Box["axes"], half: THREE.Vector3): Bounds {
  const x = Math.abs(axes[0].x) * half.x + Math.abs(axes[1].x) * half.y + Math.abs(axes[2].x) * half.z;
  const z = Math.abs(axes[0].z) * half.x + Math.abs(axes[1].z) * half.y + Math.abs(axes[2].z) * half.z;
  return { minX: center.x - x, maxX: center.x + x, minZ: center.z - z, maxZ: center.z + z };
}

function pathBounds(start: THREE.Vector3, end: THREE.Vector3, radius: number): Bounds {
  return {
    minX: Math.min(start.x, end.x) - radius,
    maxX: Math.max(start.x, end.x) + radius,
    minZ: Math.min(start.z, end.z) - radius,
    maxZ: Math.max(start.z, end.z) + radius,
  };
}

function localPoint(box: Box, point: THREE.Vector3): THREE.Vector3 {
  const relative = point.clone().sub(box.center);
  return new THREE.Vector3(...box.axes.map((axis) => relative.dot(axis)) as [number, number, number]);
}

function localDirection(box: Box, direction: THREE.Vector3): THREE.Vector3 {
  return new THREE.Vector3(...box.axes.map((axis) => direction.dot(axis)) as [number, number, number]);
}

function worldNormal(box: Box, normal: THREE.Vector3): THREE.Vector3 {
  return box.axes[0].clone().multiplyScalar(normal.x)
    .addScaledVector(box.axes[1], normal.y).addScaledVector(box.axes[2], normal.z).normalize();
}

function boxNormal(point: THREE.Vector3, half: THREE.Vector3, dimensions = [0, 1, 2]): THREE.Vector3 {
  const closest = point.clone().clamp(half.clone().negate(), half);
  const normal = point.clone().sub(closest);
  for (const axis of [0, 1, 2]) if (!dimensions.includes(axis)) normal.setComponent(axis, 0);
  if (normal.lengthSq() > EPSILON) return normal.normalize();
  let face = dimensions[0];
  for (const axis of dimensions) {
    if (half.getComponent(axis) - Math.abs(point.getComponent(axis))
      < half.getComponent(face) - Math.abs(point.getComponent(face))) face = axis;
  }
  return normal.setComponent(face, point.getComponent(face) < 0 ? -1 : 1);
}

function slabInterval(origin: THREE.Vector3, direction: THREE.Vector3, half: THREE.Vector3,
  range: number, dimensions = [0, 1, 2]): { enter: number; exit: number; normal: THREE.Vector3 } | null {
  let enter = 0, exit = range;
  const normal = new THREE.Vector3();
  for (const axis of dimensions) {
    const o = origin.getComponent(axis), d = direction.getComponent(axis), h = half.getComponent(axis);
    if (Math.abs(d) < EPSILON) {
      if (Math.abs(o) > h + EPSILON) return null;
      continue;
    }
    const a = (-h - o) / d, b = (h - o) / d;
    const near = Math.min(a, b), far = Math.max(a, b);
    if (near > enter - EPSILON) {
      if (near > enter + EPSILON) normal.set(0, 0, 0);
      normal.setComponent(axis, d > 0 ? -1 : 1);
      enter = Math.max(enter, near);
    }
    exit = Math.min(exit, far);
    if (enter > exit + EPSILON) return null;
  }
  if (exit < 0 || enter > range) return null;
  return { enter, exit, normal: normal.normalize() };
}

/** Exact ray vs rounded box/rectangle, not an inflated AABB at the corners. */
function roundedEntry(origin: THREE.Vector3, direction: THREE.Vector3, half: THREE.Vector3,
  radius: number, start: number, end: number, dimensions = [0, 1, 2]): number | null {
  const distanceSq = (t: number) => {
    let sum = 0;
    for (const axis of dimensions) {
      const outside = Math.max(Math.abs(origin.getComponent(axis) + direction.getComponent(axis) * t)
        - half.getComponent(axis), 0);
      sum += outside * outside;
    }
    return sum;
  };
  if (distanceSq(start) <= radius * radius + EPSILON) return start;
  const breaks = [start, end];
  for (const axis of dimensions) {
    const d = direction.getComponent(axis);
    if (Math.abs(d) < EPSILON) continue;
    for (const sign of [-1, 1]) {
      const t = (sign * half.getComponent(axis) - origin.getComponent(axis)) / d;
      if (t > start && t < end) breaks.push(t);
    }
  }
  breaks.sort((a, b) => a - b);
  for (let i = 1; i < breaks.length; i++) {
    const lo = breaks[i - 1], hi = breaks[i], middle = (lo + hi) * 0.5;
    let a = 0, b = 0, c = -radius * radius;
    for (const axis of dimensions) {
      const o = origin.getComponent(axis), d = direction.getComponent(axis), h = half.getComponent(axis);
      const p = o + d * middle;
      if (Math.abs(p) <= h) continue;
      const offset = o - (p < 0 ? -h : h);
      a += d * d;
      b += 2 * d * offset;
      c += offset * offset;
    }
    if (a < EPSILON) {
      if (c <= EPSILON) return lo;
      continue;
    }
    const discriminant = b * b - 4 * a * c;
    if (discriminant < -EPSILON) continue;
    const root = (-b - Math.sqrt(Math.max(0, discriminant))) / (2 * a);
    if (root >= lo - EPSILON && root <= hi + EPSILON) return Math.max(lo, root);
  }
  return null;
}

function sweepSphere(box: Box, origin: THREE.Vector3, direction: THREE.Vector3,
  range: number, radius: number): SweepHit | null {
  const local = localPoint(box, origin), ray = localDirection(box, direction);
  let distance: number | null;
  if (radius <= EPSILON) {
    const interval = slabInterval(local, ray, box.half, range);
    if (!interval) return null;
    distance = interval.enter;
  } else {
    distance = roundedEntry(local, ray, box.half, radius, 0, range);
  }
  if (distance === null) return null;
  const at = local.clone().addScaledVector(ray, distance);
  const normal = boxNormal(at, box.half);
  // Tangency at the start is not a hit when travelling away from the solid.
  if (distance <= EPSILON && normal.dot(ray) >= -EPSILON) {
    const closest = local.clone().clamp(box.half.clone().negate(), box.half);
    const strictlyInside = radius > EPSILON
      ? local.distanceToSquared(closest) < radius * radius - EPSILON
      : Math.abs(local.x) < box.half.x - EPSILON && Math.abs(local.y) < box.half.y - EPSILON
        && Math.abs(local.z) < box.half.z - EPSILON;
    if (!strictlyInside) return null;
  }
  return { distance, normal: worldNormal(box, normal) };
}

/** Vertical cylinder against a yaw-only box: rounded XZ edges, full body height. */
function sweepBodyCollider(box: Box, feet: THREE.Vector3, delta: THREE.Vector3,
  radius: number, height: number): SweepHit | null {
  const center = feet.clone().addScaledVector(UP, height * 0.5);
  const local = localPoint(box, center), ray = localDirection(box, delta);
  const half = box.half.clone();
  half.y += Math.max(0, height * 0.5 - SKIN);
  const interval = slabInterval(local, ray, half, 1, [1]);
  if (!interval) return null;
  const distance = radius <= EPSILON
    ? slabInterval(local, ray, half, 1)?.enter ?? null
    : roundedEntry(local, ray, half, radius, interval.enter, interval.exit, [0, 2]);
  if (distance === null) return null;
  const at = local.clone().addScaledVector(ray, distance);
  const normal = distance <= interval.enter + EPSILON && interval.normal.lengthSq() > 0
    ? interval.normal : boxNormal(at, half, [0, 2]);
  if (distance <= EPSILON && normal.dot(ray) >= -EPSILON) return null;
  return { distance, normal: worldNormal(box, normal) };
}

/** Static world collision. All positions and feetY are measured at the body's feet. */
export class WorldSpatial implements WorldContact {
  readonly halfExtent: number;
  private readonly terrain: WorldSpatialOptions["terrain"];
  private readonly water: WorldSpatialOptions["water"];
  private readonly colliders = new SpatialHash<Box>();
  private readonly supports = new SpatialHash<SupportBox>();

  constructor(options: WorldSpatialOptions) {
    if (!Number.isFinite(options.halfExtent) || options.halfExtent <= 0) {
      throw new RangeError("WorldSpatial halfExtent must be a positive finite number");
    }
    this.halfExtent = options.halfExtent;
    this.terrain = options.terrain;
    this.water = options.water;
  }

  get stats(): WorldSpatialStats {
    return {
      colliders: this.colliders.entries.size, supports: this.supports.entries.size,
      colliderCells: this.colliders.cells.size, supportCells: this.supports.cells.size,
    };
  }

  getStats(): WorldSpatialStats { return this.stats; }

  addCollider(collider: WorldCollider): this {
    const cos = Math.cos(collider.yaw), sin = Math.sin(collider.yaw);
    const axes: Box["axes"] = [new THREE.Vector3(cos, 0, -sin), UP.clone(), new THREE.Vector3(sin, 0, cos)];
    const center = collider.center.clone();
    const half = new THREE.Vector3(Math.abs(collider.size.x), Math.abs(collider.size.y), Math.abs(collider.size.z))
      .multiplyScalar(0.5);
    this.colliders.add({ id: collider.id, center, axes, half, ...boundsFor(center, axes, half) });
    return this;
  }

  addColliders(colliders: readonly WorldCollider[]): this {
    for (const collider of colliders) this.addCollider(collider);
    return this;
  }

  removeCollider(id: string): this {
    const entry = this.colliders.entries.get(id);
    if (!entry) return this;
    this.colliders.visit(entry, (key) => {
      const cell = this.colliders.cells.get(key);
      cell?.delete(entry);
      if (!cell?.size) this.colliders.cells.delete(key);
    });
    this.colliders.entries.delete(id);
    return this;
  }

  addSupport(support: WorldSupport): this {
    const cos = Math.cos(support.yaw), sin = Math.sin(support.yaw), slope = support.slopeZ ?? 0;
    const scale = Math.hypot(1, slope);
    const axes: Box["axes"] = [new THREE.Vector3(cos, 0, -sin),
      new THREE.Vector3(-sin * slope, 1, -cos * slope).divideScalar(scale),
      new THREE.Vector3(sin, slope, cos).divideScalar(scale)];
    const surface = support.center.clone();
    const center = surface.clone().addScaledVector(axes[1], -FLOOR_THICKNESS * 0.5);
    const width = Math.abs(support.width), depth = Math.abs(support.depth);
    const half = new THREE.Vector3(width * 0.5, FLOOR_THICKNESS * 0.5, depth * scale * 0.5);
    this.supports.add({ id: support.id, center, surface, axes, half, width, depth, cos, sin, slope,
      ...boundsFor(center, axes, half) });
    return this;
  }

  addSupports(supports: readonly WorldSupport[]): this {
    for (const support of supports) this.addSupport(support);
    return this;
  }

  register(value: WorldCollider | WorldSupport | {
    colliders?: readonly WorldCollider[]; supports?: readonly WorldSupport[];
  }): this {
    if ("kind" in value) return this.addCollider(value);
    if ("width" in value) return this.addSupport(value);
    this.addColliders(value.colliders ?? []);
    this.addSupports(value.supports ?? []);
    return this;
  }

  /** Clears owned registrations only; supplied samplers remain usable. */
  dispose(): void {
    this.colliders.clear();
    this.supports.clear();
  }

  sampleTerrain(x: number, z: number): number { return this.terrain(x, z); }
  sampleWater(x: number, z: number): WaterSample | null { return this.water(x, z); }

  private supportHeight(support: SupportBox, x: number, z: number): number {
    // A finite ramp ends at its landing height. Extrapolating its plane past the
    // endpoint invents a higher obstacle and lets the expanded slab catch feet
    // approaching from the top landing, even though the whole ramp is below them.
    const localZ = THREE.MathUtils.clamp((x - support.surface.x) * support.sin
      + (z - support.surface.z) * support.cos, -support.depth * 0.5, support.depth * 0.5);
    return support.surface.y + support.slope * localZ;
  }

  /**
   * Highest eligible support below feetY + maxStep, with terrain as the solid baseline.
   * Lower floors stay eligible for descending/landing; roofs above that ceiling do not.
   * This selects a ground height; it does not change the body or perform a downward snap.
   */
  supportAt(x: number, z: number, feetY: number, maxStep = MAX_STEP): number {
    return this.groundAt(x, z, feetY, maxStep, 0);
  }

  private groundAt(x: number, z: number, feetY: number, maxStep: number, radius: number): number {
    let floor = this.sampleTerrain(x, z);
    const ceiling = feetY + Math.min(MAX_STEP, Math.max(0, maxStep));
    for (const support of this.supports.query({ minX: x - radius, maxX: x + radius,
      minZ: z - radius, maxZ: z + radius })) {
      const dx = x - support.surface.x, dz = z - support.surface.z;
      const localX = dx * support.cos - dz * support.sin;
      const localZ = dx * support.sin + dz * support.cos;
      const closestX = THREE.MathUtils.clamp(localX, -support.width * 0.5, support.width * 0.5);
      const closestZ = THREE.MathUtils.clamp(localZ, -support.depth * 0.5, support.depth * 0.5);
      if (Math.hypot(localX - closestX, localZ - closestZ) > radius + EPSILON) continue;
      const y = support.surface.y + support.slope * closestZ;
      if (y <= ceiling + EPSILON && y > floor) floor = y;
    }
    return floor;
  }

  private sweepBody(feet: THREE.Vector3, delta: THREE.Vector3, radius: number, height: number,
    stepAllowance = 0): SweepHit | null {
    const end = feet.clone().add(delta), bounds = pathBounds(feet, end, radius);
    let nearest: SweepHit | null = null;
    for (const box of this.colliders.query(bounds)) {
      const hit = sweepBodyCollider(box, feet, delta, radius, height);
      if (hit && (!nearest || hit.distance < nearest.distance)) nearest = hit;
    }
    for (const support of this.supports.query(bounds)) {
      // Walkable floors/ramps are handled by supportAt, not by their slab's side faces.
      const highest = Math.max(this.supportHeight(support, feet.x, feet.z), this.supportHeight(support, end.x, end.z));
      if (highest <= Math.min(feet.y, end.y) + Math.max(SKIN, stepAllowance)) continue;
      const center = feet.clone().addScaledVector(UP, height * 0.5);
      const local = localPoint(support, center), ray = localDirection(support, delta);
      const half = support.half.clone();
      for (let axis = 0; axis < 3; axis++) {
        const a = support.axes[axis];
        half.setComponent(axis, half.getComponent(axis) + radius * Math.hypot(a.x, a.z)
          + Math.max(0, height * 0.5 - SKIN) * Math.abs(a.y));
      }
      const interval = slabInterval(local, ray, half, 1);
      if (!interval) continue;
      const normal = interval.normal.lengthSq() ? interval.normal : boxNormal(local, half);
      if (interval.enter <= EPSILON && normal.dot(ray) >= -EPSILON) continue;
      const hit = { distance: interval.enter, normal: worldNormal(support, normal) };
      if (!nearest || hit.distance < nearest.distance) nearest = hit;
    }
    return nearest;
  }

  private waterBarrier(x: number, z: number, feetY: number): number {
    const sample = this.sampleWater(x, z);
    if (!sample || sample.depth <= 0.65) return 0;
    // Registered bridge/floor surfaces above the water allow dry traversal.
    if (this.supportAt(x, z, feetY, 0) >= sample.level - SKIN) return 0;
    return sample.depth - 0.65;
  }

  private blockedGround(from: THREE.Vector3, to: THREE.Vector3, radius: number, mayStep: boolean): boolean {
    const terrainCeiling = mayStep ? Math.max(from.y + MAX_STEP, to.y) : to.y;
    if (this.sampleTerrain(to.x, to.z) > terrainCeiling + EPSILON) return true;
    for (let i = -1; i < 8; i++) {
      const angle = i * Math.PI / 4, r = i < 0 ? 0 : radius;
      const dx = Math.cos(angle) * r, dz = Math.sin(angle) * r;
      const blocked = this.waterBarrier(to.x + dx, to.z + dz, to.y);
      if (blocked <= 0) continue;
      const previous = this.waterBarrier(from.x + dx, from.z + dz, from.y);
      // A body already in deep water may escape toward shallower ground.
      if (previous <= 0 || blocked >= previous - EPSILON) return true;
    }
    return false;
  }

  private sweepGround(from: THREE.Vector3, delta: THREE.Vector3, radius: number, mayStep: boolean): SweepHit | null {
    const samples = Math.max(1, Math.ceil(Math.hypot(delta.x, delta.z) / (MOVE_SAMPLE * 0.5)));
    let previous = 0;
    for (let i = 1; i <= samples; i++) {
      const t = i / samples, target = from.clone().addScaledVector(delta, t);
      if (!this.blockedGround(from, target, radius, mayStep)) { previous = t; continue; }
      let lo = previous, hi = t;
      for (let iteration = 0; iteration < 12; iteration++) {
        const middle = (lo + hi) * 0.5;
        if (this.blockedGround(from, from.clone().addScaledVector(delta, middle), radius, mayStep)) hi = middle;
        else lo = middle;
      }
      const at = from.clone().addScaledVector(delta, hi), e = Math.max(0.05, radius * 0.25);
      const terrainBlocked = this.sampleTerrain(at.x, at.z) > (mayStep ? Math.max(from.y + MAX_STEP, at.y) : at.y);
      const field = (x: number, z: number) => terrainBlocked
        ? this.sampleTerrain(x, z) : this.waterBarrier(x, z, at.y);
      const normal = terrainBlocked && Math.hypot(delta.x, delta.z) < EPSILON ? UP.clone()
        : new THREE.Vector3(field(at.x - e, at.z) - field(at.x + e, at.z), 0,
          field(at.x, at.z - e) - field(at.x, at.z + e));
      if (normal.lengthSq() < EPSILON || normal.dot(delta) >= 0) {
        if (terrainBlocked && delta.y < 0) normal.copy(UP);
        else normal.set(-delta.x, 0, -delta.z);
      }
      return { distance: lo, normal: normal.normalize() };
    }
    return null;
  }

  private pushBodyOut(position: THREE.Vector3, radius: number, height: number): void {
    for (let iteration = 0; iteration < 6; iteration++) {
      let moved = false;
      for (const box of this.colliders.query(pathBounds(position, position, radius))) {
        if (position.y >= box.center.y + box.half.y - SKIN
          || position.y + height <= box.center.y - box.half.y + SKIN) continue;
        const local = localPoint(box, position);
        const closest = new THREE.Vector3(THREE.MathUtils.clamp(local.x, -box.half.x, box.half.x), local.y,
          THREE.MathUtils.clamp(local.z, -box.half.z, box.half.z));
        const offset = local.clone().sub(closest), distance = offset.length();
        let normal: THREE.Vector3, depth: number;
        if (distance > EPSILON) {
          if (distance >= radius - SKIN) continue;
          normal = offset.divideScalar(distance);
          depth = radius - distance;
        } else {
          normal = boxNormal(local, box.half, [0, 2]);
          const axis = Math.abs(normal.x) > 0 ? 0 : 2;
          depth = box.half.getComponent(axis) - Math.abs(local.getComponent(axis)) + radius;
        }
        // Horizontal-only recovery cannot accidentally teleport feet onto a roof.
        position.addScaledVector(worldNormal(box, normal), depth + SKIN);
        moved = true;
      }
      if (!moved) break;
    }
  }

  /**
   * Sweeps/slides a vertical body. Inputs are not mutated. Horizontal motion is
   * substepped for terrain/shorelines, and grounded nonascending bodies can step
   * up at most 0.32 per reachable rise. No downward ground snap or gravity is added;
   * the controller owns jumping/falling and uses supportAt to choose its landing.
   */
  move(position: THREE.Vector3, delta: THREE.Vector3, radius: number, height: number): THREE.Vector3 {
    radius = Math.max(0, radius);
    height = Math.max(SKIN * 2, height);
    const result = position.clone(), limit = Math.max(0, this.halfExtent - radius);
    result.x = THREE.MathUtils.clamp(result.x, -limit, limit);
    result.z = THREE.MathUtils.clamp(result.z, -limit, limit);
    this.pushBodyOut(result, radius, height);
    const destination = result.clone().add(delta);
    destination.x = THREE.MathUtils.clamp(destination.x, -limit, limit);
    destination.z = THREE.MathUtils.clamp(destination.z, -limit, limit);
    const travel = destination.sub(result);
    const count = Math.max(1, Math.ceil(Math.hypot(travel.x, travel.z) / MOVE_SAMPLE));
    const increment = travel.divideScalar(count);
    const canStep = delta.y <= EPSILON;
    for (let step = 0; step < count; step++) {
      const mayStep = canStep && Math.abs(result.y - this.groundAt(result.x, result.z, result.y, 0, radius)) <= 0.04;
      const remaining = increment.clone();
      for (let slide = 0; slide < 5 && remaining.lengthSq() > EPSILON; slide++) {
        const end = result.clone().add(remaining);
        let stepAllowance = 0;
        if (mayStep) {
          const floor = this.groundAt(end.x, end.z, result.y, MAX_STEP, radius);
          if (floor > result.y && floor <= result.y + MAX_STEP + EPSILON) {
            const rise = floor - result.y;
            // Verify headroom at the raised destination as well as above the old feet.
            // Otherwise a low ceiling can reject the rise but let feet enter its floor.
            const lift = new THREE.Vector3(0, rise, 0);
            const raised = end.clone().setY(result.y + rise);
            if (!this.sweepBody(result, lift, radius, height)
              && !this.sweepBody(raised, new THREE.Vector3(0, SKIN * 2, 0), radius, height)) {
              remaining.y = Math.max(remaining.y, rise);
              stepAllowance = rise + SKIN;
            }
          }
        }
        let hit = this.sweepBody(result, remaining, radius, height, stepAllowance);
        const ground = this.sweepGround(result, remaining, radius, mayStep);
        if (ground && (!hit || ground.distance < hit.distance)) hit = ground;
        if (!hit) { result.add(remaining); break; }
        const length = remaining.length();
        const fraction = Math.max(0, hit.distance - SKIN / Math.max(length, SKIN));
        result.addScaledVector(remaining, fraction);
        remaining.multiplyScalar(1 - fraction);
        const inward = remaining.dot(hit.normal);
        if (inward < 0) remaining.addScaledVector(hit.normal, -inward);
        else break;
      }
    }
    result.x = THREE.MathUtils.clamp(result.x, -limit, limit);
    result.z = THREE.MathUtils.clamp(result.z, -limit, limit);
    return result;
  }

  private terrainTop(x: number, z: number, radius: number): number {
    let top = this.sampleTerrain(x, z);
    if (radius > 0) {
      for (let i = 0; i < 8; i++) {
        const angle = i * Math.PI / 4;
        top = Math.max(top, this.sampleTerrain(x + Math.cos(angle) * radius, z + Math.sin(angle) * radius));
      }
    }
    // Conservative footprint clearance for a sphere on sloped terrain.
    return top + radius;
  }

  private terrainNormal(x: number, z: number): THREE.Vector3 {
    const e = 0.02;
    return new THREE.Vector3(this.sampleTerrain(x - e, z) - this.sampleTerrain(x + e, z), 2 * e,
      this.sampleTerrain(x, z - e) - this.sampleTerrain(x, z + e)).normalize();
  }

  private traceTerrain(origin: THREE.Vector3, direction: THREE.Vector3, range: number, radius: number): SweepHit | null {
    // Only the finite terrain footprint is solid; do not extend edge samples forever.
    const half = new THREE.Vector3(this.halfExtent + radius, 1, this.halfExtent + radius);
    const interval = slabInterval(origin, direction, half, range, [0, 2]);
    if (!interval) return null;
    const clearance = (distance: number) => {
      const at = origin.clone().addScaledVector(direction, distance);
      return at.y - this.terrainTop(at.x, at.z, radius);
    };
    let previous = interval.enter, gap = clearance(previous);
    if (gap <= 0) {
      const at = origin.clone().addScaledVector(direction, previous);
      if (gap < -EPSILON || direction.dot(this.terrainNormal(at.x, at.z)) < 0) {
        return { distance: previous, normal: this.terrainNormal(at.x, at.z) };
      }
    }
    const horizontal = Math.hypot(direction.x, direction.z);
    const spacing = horizontal > EPSILON ? TERRAIN_SAMPLE / horizontal : Math.max(range, SKIN);
    while (previous < interval.exit) {
      const distance = Math.min(interval.exit, previous + spacing);
      const nextGap = clearance(distance);
      if (nextGap < -EPSILON || (nextGap <= EPSILON && gap > EPSILON)) {
        let lo = previous, hi = distance;
        for (let iteration = 0; iteration < 18; iteration++) {
          const middle = (lo + hi) * 0.5;
          if (clearance(middle) > 0) lo = middle;
          else hi = middle;
        }
        const at = origin.clone().addScaledVector(direction, hi);
        return { distance: hi, normal: this.terrainNormal(at.x, at.z) };
      }
      previous = distance;
      gap = nextGap;
    }
    return null;
  }

  /**
   * Nearest static hit (OBBs, two-sided floor slabs, terrain). Direction is normalized
   * internally; distance is world-space travel. For radius > 0 point is the swept
   * sphere CENTER at impact, not a surface contact point. Water is not bullet-solid.
   */
  traceStatic(origin: THREE.Vector3, direction: THREE.Vector3, range: number, radius = 0): WorldHit | null {
    if (!Number.isFinite(range) || range <= 0 || direction.lengthSq() < EPSILON) return null;
    radius = Math.max(0, radius);
    const ray = direction.clone().normalize(), end = origin.clone().addScaledVector(ray, range);
    const bounds = pathBounds(origin, end, radius);
    let nearest: SweepHit | null = null;
    for (const box of [...this.colliders.query(bounds), ...this.supports.query(bounds)]) {
      const hit = sweepSphere(box, origin, ray, nearest?.distance ?? range, radius);
      if (hit && (!nearest || hit.distance < nearest.distance)) nearest = hit;
    }
    const terrain = this.traceTerrain(origin, ray, nearest?.distance ?? range, radius);
    if (terrain && (!nearest || terrain.distance < nearest.distance)) nearest = terrain;
    return nearest ? { ...nearest, point: origin.clone().addScaledVector(ray, nearest.distance) } : null;
  }

  private pushCameraOut(position: THREE.Vector3, radius: number): void {
    for (let iteration = 0; iteration < 8; iteration++) {
      let moved = false;
      for (const box of [...this.colliders.query(pathBounds(position, position, radius)),
        ...this.supports.query(pathBounds(position, position, radius))]) {
        const local = localPoint(box, position), closest = local.clone().clamp(box.half.clone().negate(), box.half);
        const offset = local.clone().sub(closest), distance = offset.length();
        let normal: THREE.Vector3, depth: number;
        if (distance > EPSILON) {
          if (distance >= radius + SKIN) continue;
          normal = offset.divideScalar(distance);
          depth = radius - distance;
        } else {
          normal = boxNormal(local, box.half);
          const axis = Math.abs(normal.x) > 0 ? 0 : Math.abs(normal.y) > 0 ? 1 : 2;
          depth = box.half.getComponent(axis) - Math.abs(local.getComponent(axis)) + radius;
        }
        position.addScaledVector(worldNormal(box, normal), depth + SKIN);
        moved = true;
      }
      const floor = this.terrainTop(position.x, position.z, radius) + SKIN;
      if (position.y < floor) { position.y = floor; moved = true; }
      if (!moved) break;
    }
  }

  /** Sphere sweep from a safe pivot, including interior-wall recovery and terrain clearance. */
  resolveCamera(pivot: THREE.Vector3, desired: THREE.Vector3, radius = 0.22): THREE.Vector3 {
    radius = Math.max(0, radius);
    const start = pivot.clone();
    this.pushCameraOut(start, radius);
    const result = desired.clone();
    for (let iteration = 0; iteration < 3; iteration++) {
      const direction = result.clone().sub(start), distance = direction.length();
      const hit = this.traceStatic(start, direction, distance, radius);
      if (hit) result.copy(start).addScaledVector(direction.normalize(), Math.max(0, hit.distance - SKIN));
      const floor = this.terrainTop(result.x, result.z, radius) + SKIN;
      if (result.y >= floor) break;
      result.y = floor;
      // Re-sweep the lifted target: terrain safety must not lift through a wall/ceiling.
    }
    return result;
  }
}
