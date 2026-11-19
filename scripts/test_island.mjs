// Offline regression checks. Run: node --experimental-vm-modules scripts/test_island.mjs
// Only reviewed island modules are transpiled in memory; no generated JS, asset
// scripts, browser, network services, or files on disk are changed by this test.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, SourceTextModule, SyntheticModule } from "node:vm";
import ts from "typescript";
import * as THREE from "three";
import * as geometryUtils from "three/examples/jsm/utils/BufferGeometryUtils.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = path.join(root, "src", "lib");
const reviewed = new Set([
  "worldTypes.ts", "worldSpatial.ts", "worldShared.ts", "islandHouses.ts",
  "houseDetails.ts", "peakHouseDetails.ts", "peakMaterials.ts", "islandLayout.ts", "islandTerrain.ts", "islandMaterials.ts", "celestial.ts",
]);
const assetRoot = "/assets/3d/environment/island/";
const elevationUrl = `${assetRoot}island_rpg_elev_512.bin`;
const sourceSide = 512;
const fixtures = { buffer: null, status: 200, requests: 0, gate: null };
const canvases = new Set();
const images = new Set();
const cleanups = [];
let passed = 0;
let failed = 0;
let houseAttempts = 0;
let houseChecks = 0;
let roomChecks = 0;
let ascentChecks = 0;
let stairChecks = 0;

function near(actual, expected, tolerance = 1e-5, label = "numeric value") {
  assert.ok(Number.isFinite(actual), `${label} is not finite`);
  assert.ok(Math.abs(actual - expected) <= tolerance,
    `${label}: expected ${expected}, got ${actual} (tolerance ${tolerance})`);
}
function nearPoint(actual, expected, tolerance = 0.025, label = "position") {
  assert.ok(actual.distanceTo(expected) <= tolerance,
    `${label}: expected [${expected.toArray()}], got [${actual.toArray()}]`);
}
async function check(name, run) {
  try {
    await run();
    passed++;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL ${name}: ${error.message}`);
  }
}
function own(resource) {
  cleanups.push(() => resource.dispose());
  return resource;
}

// A small deterministic RGBA canvas, sufficient for the reviewed material code.
// It supports pixel copies and local paint operations, not browser rendering or
// font/GPU acceptance. Unknown DOM elements and asset URLs fail closed.
function rgba(style) {
  if (style.startsWith("#")) {
    const value = style.slice(1);
    assert.equal(value.length, 6, "mock canvas expects six-digit colors");
    return [0, 2, 4].map(offset => Number.parseInt(value.slice(offset, offset + 2), 16)).concat(255);
  }
  const match = /^rgba\((\d+),(\d+),(\d+),([\d.]+)\)$/.exec(style);
  assert.ok(match, `unsupported paint ${style}`);
  return [Number(match[1]), Number(match[2]), Number(match[3]), Math.round(Number(match[4]) * 255)];
}
class MemoryCanvas {
  constructor() {
    this._width = 1;
    this._height = 1;
    this.pixels = new Uint8ClampedArray(4);
    this.context = new MemoryContext(this);
    canvases.add(this);
  }
  get width() { return this._width; }
  set width(value) { this._width = value; this.reset(); }
  get height() { return this._height; }
  set height(value) { this._height = value; this.reset(); }
  reset() { this.pixels = new Uint8ClampedArray(this.width * this.height * 4); }
  getContext(kind) {
    assert.equal(kind, "2d");
    return this.context;
  }
}
class MemoryContext {
  constructor(canvas) {
    this.canvas = canvas;
    this.fillStyle = "#000000";
    this.strokeStyle = "#000000";
    this.lineWidth = 1;
    this.lines = [];
    this.cursor = null;
  }
  fillRect(x, y, width, height) {
    this.paintRect(x, y, width, height, rgba(this.fillStyle));
  }
  paintRect(x, y, width, height, color) {
    const c = this.canvas;
    for (let py = Math.max(0, Math.floor(y)); py < Math.min(c.height, Math.ceil(y + height)); py++) {
      for (let px = Math.max(0, Math.floor(x)); px < Math.min(c.width, Math.ceil(x + width)); px++) {
        const index = (py * c.width + px) * 4, alpha = color[3] / 255;
        for (let channel = 0; channel < 3; channel++) {
          c.pixels[index + channel] = color[channel] * alpha + c.pixels[index + channel] * (1 - alpha);
        }
        c.pixels[index + 3] = color[3] + c.pixels[index + 3] * (1 - alpha);
      }
    }
  }
  beginPath() { this.lines = []; this.cursor = null; }
  moveTo(x, y) { this.cursor = [x, y]; }
  lineTo(x, y) {
    if (this.cursor) this.lines.push([this.cursor, [x, y]]);
    this.cursor = [x, y];
  }
  bezierCurveTo(ax, ay, bx, by, x, y) {
    assert.ok(this.cursor, "curve requires a starting point");
    const [sx, sy] = this.cursor;
    for (let i = 1; i <= 12; i++) {
      const t = i / 12, u = 1 - t;
      this.lineTo(u ** 3 * sx + 3 * u ** 2 * t * ax + 3 * u * t ** 2 * bx + t ** 3 * x,
        u ** 3 * sy + 3 * u ** 2 * t * ay + 3 * u * t ** 2 * by + t ** 3 * y);
    }
  }
  stroke() {
    const color = rgba(this.strokeStyle), w = this.lineWidth;
    for (const [[x0, y0], [x1, y1]] of this.lines) {
      const count = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0)));
      for (let i = 0; i <= count; i++) {
        this.paintRect(x0 + (x1 - x0) * i / count - w / 2,
          y0 + (y1 - y0) * i / count - w / 2, w, w, color);
      }
    }
  }
  drawImage(image, x, y) {
    assert.equal(x, 0); assert.equal(y, 0);
    assert.equal(this.canvas.width, image.naturalWidth);
    assert.equal(this.canvas.height, image.naturalHeight);
    this.canvas.pixels.set(image.pixels);
  }
  getImageData(x, y, width, height) {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let row = 0; row < height; row++) for (let col = 0; col < width; col++) {
      const index = ((row + y) * this.canvas.width + col + x) * 4;
      data.set(this.canvas.pixels.subarray(index, index + 4), (row * width + col) * 4);
    }
    return { width, height, data };
  }
}
class FixtureImage {
  constructor() { images.add(this); }
  async decode() {
    assert.ok(["island_rpg_splatmap.png", "land_green.png", "land_sand.png", "land_rock.png"]
      .some(name => this.src === `${assetRoot}${name}`), `unapproved image URL ${this.src}`);
    this.naturalWidth = this.naturalHeight = 8;
    this.pixels = new Uint8ClampedArray(8 * 8 * 4);
    for (let z = 0; z < 8; z++) for (let x = 0; x < 8; x++) {
      this.pixels.set([50 + x * 9, 40 + x * 12 + z * 17, 110 + z * 8, 255], (z * 8 + x) * 4);
    }
  }
}
async function fixtureFetch(url) {
  assert.equal(url, elevationUrl, `unapproved fetch URL ${url}`);
  fixtures.requests++;
  const buffer = fixtures.buffer;
  const status = fixtures.status;
  if (fixtures.gate) await fixtures.gate;
  assert.ok(buffer instanceof ArrayBuffer, "elevation fixture was not set");
  return { ok: status === 200, status, async arrayBuffer() { return buffer.slice(0); } };
}

const context = createContext({
  console, document: { createElement(name) { assert.equal(name, "canvas"); return new MemoryCanvas(); } },
  Image: FixtureImage, fetch: fixtureFetch, DOMException, AbortController,
  ArrayBuffer, DataView, Uint8Array, Uint8ClampedArray, Uint16Array, Uint32Array, Float32Array,
}, { codeGeneration: { strings: false, wasm: false } });
const modules = new Map();
function external(name, namespace) {
  const vmModule = new SyntheticModule(Object.keys(namespace), function () {
    for (const [key, value] of Object.entries(namespace)) this.setExport(key, value);
  }, { context, identifier: name });
  modules.set(name, Promise.resolve(vmModule));
}
external("three", THREE);
external("three/examples/jsm/utils/BufferGeometryUtils.js", geometryUtils);
async function getModule(identifier) {
  if (modules.has(identifier)) return modules.get(identifier);
  assert.equal(path.dirname(identifier), sourceRoot, "imports must stay in reviewed island directory");
  assert.ok(reviewed.has(path.basename(identifier)), `unreviewed module ${identifier}`);
  const promise = (async () => {
    const source = await readFile(identifier, "utf8");
    const result = ts.transpileModule(source, {
      fileName: identifier, reportDiagnostics: true,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
        isolatedModules: true, verbatimModuleSyntax: false },
    });
    const errors = (result.diagnostics ?? []).filter(d => d.category === ts.DiagnosticCategory.Error);
    assert.equal(errors.length, 0, errors.map(d => ts.flattenDiagnosticMessageText(d.messageText, "\n")).join("\n"));
    return new SourceTextModule(result.outputText, { context, identifier });
  })();
  modules.set(identifier, promise);
  return promise;
}
async function link(specifier, parent) {
  if (specifier === "three" || specifier === "three/examples/jsm/utils/BufferGeometryUtils.js") {
    return getModule(specifier);
  }
  assert.ok(specifier.startsWith("./"), `unapproved import ${specifier}`);
  const identifier = path.resolve(path.dirname(parent.identifier), `${specifier}.ts`);
  return getModule(identifier);
}
async function load(name) {
  const vmModule = await getModule(path.join(sourceRoot, `${name}.ts`));
  if (vmModule.status === "unlinked") await vmModule.link(link);
  if (vmModule.status !== "evaluated") await vmModule.evaluate();
  return vmModule.namespace;
}
function affineGrid() {
  const buffer = new ArrayBuffer(sourceSide * sourceSide * 2), view = new DataView(buffer);
  for (let z = 0; z < sourceSide; z++) for (let x = 0; x < sourceSide; x++) {
    view.setUint16((z * sourceSide + x) * 2, 2000 + x * 2 + z * 3, true);
  }
  return buffer;
}
function bufferOf(bytes) { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); }
function space(WorldSpatial, options = {}) {
  return own(new WorldSpatial({ terrain: () => 0, water: () => null, halfExtent: 100, ...options }));
}
function collider(id, x, y, z, w, h, d, yaw = 0) {
  return { id, center: new THREE.Vector3(x, y, z), size: new THREE.Vector3(w, h, d), yaw, kind: "wall" };
}
function support(id, x, y, z, width, depth, yaw = 0, slopeZ) {
  return { id, center: new THREE.Vector3(x, y, z), width, depth, yaw, slopeZ };
}
function localPoint(house, x, z, storey = 0, y = house.floorHeight + storey * house.storeyHeight) {
  const c = Math.cos(house.spot.ry), s = Math.sin(house.spot.ry);
  return new THREE.Vector3(house.spot.x + c * x + s * z, y, house.spot.z - s * x + c * z);
}
function registrationsByHouse(entries) {
  const grouped = new Map();
  for (const entry of entries) {
    const id = entry.id.slice(0, entry.id.lastIndexOf("-"));
    const list = grouped.get(id) ?? [];
    list.push(entry); grouped.set(id, list);
  }
  return grouped;
}
function walk(world, start, targets, label, descend = false, stairAscent = false) {
  let feet = start.clone();
  for (const [index, target] of targets.entries()) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const delta = target.clone().sub(feet);
      // Movement and controller-owned gravity are separate: a diagonal
      // downward request from a landing would drive feet into its slab.
      delta.y = 0;
      feet = world.move(feet, delta, 0.32, 1.8);
      if (feet.y > target.y + 0.001 && feet.y < target.y + 0.32) {
        feet = world.move(feet, new THREE.Vector3(0, target.y - feet.y - 0.002, 0), 0.32, 1.8);
      }
      if (Math.hypot(feet.x - target.x, feet.z - target.z) <= 0.035) break;
    }
    if (stairAscent || descend) {
      // A cylinder can acquire the top landing within its radius before its
      // centre reaches the ramp end. Permit at most one visual tread of lift.
      near(feet.x, target.x, 0.04, `${label} waypoint ${index} X`);
      near(feet.z, target.z, 0.04, `${label} waypoint ${index} Z`);
      assert.ok(feet.y >= target.y - 0.035 && feet.y <= target.y + 0.18,
        `${label} waypoint ${index} unexpected feet height ${feet.y}, expected ${target.y}`);
    } else nearPoint(feet, target, 0.035, `${label} waypoint ${index}`);
  }
  return feet;
}
function assertWalkable(world, point, label) {
  near(world.supportAt(point.x, point.z, point.y), point.y, 1e-4, `${label} support`);
  nearPoint(world.move(point, new THREE.Vector3(), 0.32, 1.8), point, 1e-5, `${label} body clearance`);
  assert.equal(world.traceStatic(point.clone().add(new THREE.Vector3(0, 0.01, 0)),
    new THREE.Vector3(0, 1, 0), 1.78), null, `${label} headroom`);
}
function testHouses(batch, WorldSpatial) {
  const errors = [];
  const colliders = registrationsByHouse(batch.colliders), supports = registrationsByHouse(batch.supports);
  assert.equal(new Set(batch.houses.map(h => h.id)).size, batch.houses.length, "unique house IDs");
  assert.equal(new Set(batch.colliders.map(c => c.id)).size, batch.colliders.length, "unique collider IDs");
  assert.equal(new Set(batch.supports.map(s => s.id)).size, batch.supports.length, "unique support IDs");
  for (const house of batch.houses) {
    houseAttempts++;
    const world = new WorldSpatial({ terrain: () => house.spot.y, water: () => null, halfExtent: 10000 });
    try {
      world.register({ colliders: colliders.get(house.id), supports: supports.get(house.id) });
      const label = house.id;
      assert.equal(house.stairs.length, house.storeys - 1, `${label} stair count`);
      assert.equal(house.roomWalkPoints.length, house.rooms.length);
      assert.ok(house.bounds.containsPoint(house.doorway), `${label} doorway bounds`);
      assert.ok(house.doorwayWidth >= 1.9 && house.doorwayHeight >= 2.4);
      nearPoint(house.doorway, localPoint(house, 0, house.depth / 2), 1e-6, `${label} rotated entry`);
      assertWalkable(world, house.doorway, `${label} doorway`);
      const outside = localPoint(house, 0, house.depth / 2 + 3.2, 0, house.spot.y);
      const hall = localPoint(house, 0, house.depth / 2 - 1.1);
      walk(world, outside, [house.doorway, hall], `${label} entry`);
      walk(world, hall, [house.doorway, localPoint(house, 0, house.depth / 2 + 1)], `${label} exit`);
      for (const room of house.rooms) {
        assert.ok(house.bounds.containsPoint(room.walkPoint), `${label} ${room.kind} bounds`);
        assertWalkable(world, room.walkPoint, `${label} ${room.storey} ${room.kind}`);
        const floorHall = localPoint(house, 0, house.depth / 2 - 1.1, room.storey);
        const pathToRoom = room.kind === "bedroom" || room.kind === "bathroom"
          ? [localPoint(house, 1.1, -0.5, room.storey), localPoint(house, 1.1, -2.35, room.storey), room.walkPoint]
          : [room.walkPoint];
        walk(world, floorHall, pathToRoom, `${label} room ${room.id}`);
        walk(world, room.walkPoint, [...pathToRoom.slice(0, -1).reverse(), floorHall], `${label} return ${room.id}`);
        roomChecks++;
      }
      const stairErrors = [];
      for (const stair of house.stairs) {
        try {
          assert.ok(supports.get(house.id).some(s => s.id === stair.supportId), `${label} ramp registration`);
          assert.equal(stair.toStorey, stair.fromStorey + 1);
          assert.ok(stair.rise / stair.stepCount <= 0.32 && stair.width > 1.5);
          near(stair.bottom.distanceTo(stair.top), Math.hypot(stair.run, stair.rise));
          assert.equal(stair.walkPoints.length, stair.stepCount + 4);
          for (const point of stair.walkPoints) assertWalkable(world, point, `${label} stair point`);
          const startHall = localPoint(house, 0, house.depth / 2 - 1.1, stair.fromStorey);
          const approach = localPoint(house, house.width / 2 - 1.32, house.depth / 2 - 1.1, stair.fromStorey);
          walk(world, startHall, [approach, stair.bottomLanding], `${label} stair approach`);
          const top = walk(world, stair.bottomLanding, stair.walkPoints.slice(1), `${label} ascent`, false, true);
          const crossing = localPoint(house, 1.1, -3.75, stair.toStorey);
          const upstairsHall = localPoint(house, 0, house.depth / 2 - 1.1, stair.toStorey);
          walk(world, top, [crossing, localPoint(house, 1.1, -0.5, stair.toStorey), upstairsHall], `${label} upper-floor access`);
          ascentChecks++;
          walk(world, stair.topLanding, [...stair.walkPoints].reverse().slice(1), `${label} descent`, true);
          stairChecks++;
        } catch (error) { stairErrors.push(error.message); }
      }
      assert.ok(stairErrors.length === 0, stairErrors.join("; "));
      houseChecks++;
    } catch (error) {
      errors.push(error.message);
    } finally { world.dispose(); }
  }
  assert.ok(errors.length === 0, `${errors.length}/${batch.houses.length} house failures; ${errors.slice(0, 3).join("; ")}`);
}
function recordSnapshot(batch) {
  return JSON.stringify({ houses: batch.houses, colliders: batch.colliders, supports: batch.supports });
}
function textureBilinear(texture, x, z, channel, half) {
  const { data, width: n } = texture.image;
  const fx = (x + half) / (2 * half) * (n - 1), fz = (z + half) / (2 * half) * (n - 1);
  const ix = Math.min(Math.floor(fx), n - 2), iz = Math.min(Math.floor(fz), n - 2);
  const tx = fx - ix, tz = fz - iz;
  const sample = (dx, dz) => data[((iz + dz) * n + ix + dx) * 2 + channel];
  return (sample(0, 0) * (1 - tx) + sample(1, 0) * tx) * (1 - tz)
    + (sample(0, 1) * (1 - tx) + sample(1, 1) * tx) * tz;
}
function assertTerrainJoins(terrain, island) {
  const chunkSize = island.SIZE / 16, step = island.SIZE / 1024;
  const edges = new Map();
  const counts = new Set();
  for (const mesh of terrain.children) {
    const [cx, cz] = mesh.name.slice("Terrain ".length).split(",").map(Number);
    const x0 = -island.HALF + cx * chunkSize, z0 = -island.HALF + cz * chunkSize;
    const pos = mesh.geometry.getAttribute("position"), normal = mesh.geometry.getAttribute("normal");
    const index = mesh.geometry.index;
    counts.add(pos.count);
    const boundary = new Map();
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      assert.ok(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z), `${mesh.name} finite vertices`);
      if (x !== x0 && x !== x0 + chunkSize && z !== z0 && z !== z0 + chunkSize) continue;
      const key = `${x},${z}`;
      const previous = boundary.get(key);
      if (!previous || y > previous.y) boundary.set(key, { y, normal: [normal.getX(i), normal.getY(i), normal.getZ(i)] });
    }
    let area = 0;
    for (let i = 0; i < index.count; i += 3) {
      const a = index.getX(i), b = index.getX(i + 1), c = index.getX(i + 2);
      assert.ok(a < pos.count && b < pos.count && c < pos.count, `${mesh.name} valid indices`);
      const cross = (pos.getZ(b) - pos.getZ(a)) * (pos.getX(c) - pos.getX(a))
        - (pos.getX(b) - pos.getX(a)) * (pos.getZ(c) - pos.getZ(a));
      assert.ok(cross >= 0, `${mesh.name} upward terrain winding`);
      area += cross / 2;
    }
    near(area, chunkSize ** 2, 1e-4, `${mesh.name} complete zipper area`);
    for (let i = 0; i <= 64; i++) {
      for (const [x, z] of [[x0, z0 + i * step], [x0 + chunkSize, z0 + i * step],
        [x0 + i * step, z0], [x0 + i * step, z0 + chunkSize]]) {
        const entry = boundary.get(`${x},${z}`);
        assert.ok(entry, `${mesh.name} full-resolution boundary`);
        near(entry.y, island.getIslandHeight(x, z), 1e-4, `${mesh.name} CPU boundary height`);
        const previous = edges.get(`${x},${z}`);
        if (previous) {
          near(entry.y, previous.y, 1e-6, "joined boundary heights");
          entry.normal.forEach((value, axis) => near(value, previous.normal[axis], 1e-6, "joined boundary normals"));
        } else edges.set(`${x},${z}`, entry);
      }
    }
  }
  assert.equal(counts.size, 3, "test must exercise all three terrain LOD resolutions");
}

async function main() {
  if (typeof SourceTextModule !== "function") throw new Error("Run with node --experimental-vm-modules scripts/test_island.mjs");
  const island = await load("islandTerrain");
  const { WorldSpatial } = await load("worldSpatial");
  const { createHouses, HOUSE_FOOTPRINTS } = await load("islandHouses");
  const { createIslandLayout } = await load("islandLayout");
  const { sampleRoadPath } = await load("worldTypes");
  const { getCelestialState, formatIST } = await load("celestial");
  cleanups.push(() => island.disposeIslandData());

  await check("awaited load, invalid grid/HTTP retry, shared cancellation", async () => {
    const aborted = new AbortController(); aborted.abort();
    await assert.rejects(island.loadIslandData(aborted.signal), { name: "AbortError" });
    assert.equal(fixtures.requests, 0, "pre-aborted loads must not fetch");
    fixtures.buffer = new ArrayBuffer(6);
    await assert.rejects(island.loadIslandData(), /Invalid island elevation grid size/);
    fixtures.buffer = affineGrid(); fixtures.status = 503;
    await assert.rejects(island.loadIslandData(), /Island elevation HTTP 503/);
    fixtures.status = 200;
    let release;
    fixtures.gate = new Promise(resolve => { release = resolve; });
    const controller = new AbortController(), before = fixtures.requests;
    const cancelled = island.loadIslandData(controller.signal), survivor = island.loadIslandData();
    controller.abort();
    await assert.rejects(cancelled, { name: "AbortError" });
    release(); fixtures.gate = null;
    await survivor;
    assert.equal(fixtures.requests, before + 1, "concurrent callers share the load");
    await island.loadIslandData();
    assert.equal(fixtures.requests, before + 1, "completed loads are cached");
  });

  await check("source scale, little-endian bilinear grid, north/south orientation and bounds", () => {
    assert.equal(island.SOURCE_SCALE, 2.1); assert.equal(island.SIZE, 5000);
    near(island.HALF, island.SIZE / 2);
    for (const [sx, sz] of [[0, 0], [720.5, -830.25], [-1190, 1180]]) {
      const world = island.sourceToWorld(sx, sz), source = island.worldToSource(world.x, world.y);
      near(world.x, sx * island.SOURCE_SCALE); near(world.y, sz * island.SOURCE_SCALE);
      near(source.x, sx); near(source.y, sz);
      const expected = 10 + 0.02 * (sx / island.SOURCE_SIZE + 0.5) * 511
        + 0.03 * (sz / island.SOURCE_SIZE + 0.5) * 511;
      near(island.getIslandHeight(world.x, world.y), expected, 3e-6, "affine source interpolation");
    }
    for (const x of [-island.HALF, island.HALF]) for (const z of [-island.HALF, island.HALF]) {
      const expected = 10 + 0.02 * (x / (island.SOURCE_SIZE * island.SOURCE_SCALE) + 0.5) * 511
        + 0.03 * (z / (island.SOURCE_SIZE * island.SOURCE_SCALE) + 0.5) * 511;
      near(island.getIslandHeight(x, z), expected, 3e-6, "inclusive map edge");
    }
    for (const [x, z] of [[island.HALF + 0.01, 0], [0, -island.HALF - 0.01], [NaN, 0], [0, Infinity]]) {
      assert.equal(island.getIslandHeight(x, z), -10, "height outside finite world");
    }
    assert.equal(island.grassMask(island.HALF + 1, 0), 0);
  });

  await check("baked height/mask parity, clear footprints, water and stable rebake texture", () => {
    const step = island.SIZE / 1024, grid = n => Math.round(n / step) * step;
    const clear = { x: grid(800), z: grid(600), radius: 18 };
    const plot = { x: grid(1050), z: grid(850), radius: 20 };
    const road = { points: [new THREE.Vector2(grid(1300), grid(800)), new THREE.Vector2(grid(1500), grid(800))], width: 8 };
    island.configureIslandLayout([plot], [road]);
    const texture = island.bakeIsland([clear]);
    assert.equal(texture.image.width, 1025); assert.equal(texture.image.height, 1025);
    assert.equal(texture.minFilter, THREE.NearestFilter); assert.equal(texture.magFilter, THREE.NearestFilter);
    const samples = [[0, 0], [1200.31, 911.7], [-island.HALF, island.HALF], [island.HALF, -island.HALF],
      [clear.x, clear.z], [plot.x, plot.z], [road.points[0].x, road.points[0].y]];
    for (const lake of island.LAKES) samples.push([lake.x, lake.z]);
    for (const [x, z] of samples) {
      near(island.getIslandHeight(x, z), textureBilinear(texture, x, z, 0, island.HALF));
      near(island.grassMask(x, z), textureBilinear(texture, x, z, 1, island.HALF));
      assert.ok(island.grassMask(x, z) >= 0 && island.grassMask(x, z) <= 1);
    }
    near(island.grassMask(clear.x + 10, clear.z), 0, 1e-6, "clear disk interior");
    near(island.grassMask(plot.x, plot.z), 0, 1e-6, "plot grass exclusion");
    near(island.grassMask(grid(1400), grid(800)), 0, 1e-6, "road grass exclusion");
    assert.ok(island.grassMask(1700, 700) > 0.5, "unreserved source grass survives");
    for (const lake of island.LAKES) {
      const water = island.sampleIslandWater(lake.x, lake.z);
      assert.ok(water && water.depth > 3, "carved lake remains wet");
      near(water.depth, water.level - island.getIslandHeight(lake.x, lake.z));
      near(island.grassMask(lake.x, lake.z), 0, 1e-6, "lake grass exclusion");
    }
    for (let i = 1; i < island.RIVER_LEVELS.length; i++) {
      assert.ok(island.RIVER_LEVELS[i] <= island.RIVER_LEVELS[i - 1] + 1e-6, "river cannot climb");
    }
    near(island.RIVER_LEVELS.at(-1), island.SEA_LEVEL);
    const previousData = texture.image.data;
    assert.equal(island.bakeIsland([clear]), texture, "rebake retains the shared GPU texture");
    assert.notEqual(texture.image.data, previousData);
  });

  await check("terrain chunk zipper coverage and mixed-LOD joins", () => {
    const texture = island.bakeIsland([]);
    const terrain = own(island.createIslandTerrain(texture));
    assert.equal(terrain.children.length, 256);
    assertTerrainJoins(terrain, island);
    terrain.update(new THREE.Vector3(1700, 80, 1700));
    assertTerrainJoins(terrain, island);
    let disposed = 0;
    const geometry = terrain.children[0].geometry;
    geometry.addEventListener("dispose", () => disposed++);
    terrain.dispose(); terrain.dispose();
    assert.equal(disposed, 1, "terrain disposal is idempotent");
  });

  await check("floors, landing, step limit, headroom and spatial registration replacement", () => {
    const world = space(WorldSpatial);
    world.addSupports([support("lower", 0, 2, 0, 6, 6), support("upper", 0, 5.2, 0, 6, 6)]);
    near(world.supportAt(0, 0, 0), 0, 1e-6, "no roof snap from terrain");
    near(world.supportAt(0, 0, 2), 2); near(world.supportAt(0, 0, 5.2), 5.2);
    near(world.supportAt(0, 0, 0, 20), 0, 1e-6, "caller cannot override max step");
    near(world.move(new THREE.Vector3(0, 8, 0), new THREE.Vector3(0, -10, 0), 0.32, 1.8).y, 5.2, 0.003, "fall lands on upper floor");
    const steps = space(WorldSpatial);
    steps.addSupports([support("small", 3, 0.3, 0, 2, 4), support("tall", 8, 0.6, 0, 2, 4)]);
    nearPoint(steps.move(new THREE.Vector3(), new THREE.Vector3(3, 0, 0), 0.32, 1.8), new THREE.Vector3(3, 0.3, 0));
    const stopped = steps.move(new THREE.Vector3(5, 0, 0), new THREE.Vector3(3, 0, 0), 0.32, 1.8);
    assert.ok(stopped.x < 6.7 && stopped.y < 0.01, "over-height step blocks instead of lifting");
    const low = space(WorldSpatial);
    low.addSupports([support("step", 3, 0.3, 0, 2, 4), support("ceiling", 3, 1.95, 0, 2, 4)]);
    assert.ok(low.move(new THREE.Vector3(), new THREE.Vector3(3, 0, 0), 0.32, 1.8).x < 2, "step needs headroom");
    const replaced = space(WorldSpatial);
    replaced.addCollider(collider("same", 0, 1.5, 0, 1, 3, 1));
    replaced.addCollider(collider("same", 30, 1.5, 0, 1, 3, 1));
    assert.equal(replaced.stats.colliders, 1);
    assert.equal(replaced.traceStatic(new THREE.Vector3(-3, 1, 0), new THREE.Vector3(1, 0, 0), 6), null);
    replaced.addSupport(support("floor", 0, 0.2, 0, 2, 2));
    replaced.addSupport(support("floor", 30, 0.3, 0, 2, 2));
    assert.equal(replaced.stats.supports, 1); near(replaced.supportAt(0, 0, 0), 0);
    replaced.dispose();
    assert.deepEqual({ ...replaced.stats }, { colliders: 0, supports: 0, colliderCells: 0, supportCells: 0 });
    near(replaced.sampleTerrain(0, 0), 0);
  });

  await check("wall sliding, rotated collisions, no tunnelling, bounds and immutable inputs", () => {
    for (const yaw of [0, Math.PI / 2, 0.61]) {
      const world = space(WorldSpatial);
      world.addCollider(collider("wall", 0, 1.5, 0, 0.2, 3, 12, yaw));
      const rotate = value => value.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
      const start = rotate(new THREE.Vector3(-3, 0, -2)), delta = rotate(new THREE.Vector3(8, 0, 4));
      const originalStart = start.clone(), originalDelta = delta.clone();
      const result = world.move(start, delta, 0.32, 1.8);
      const local = rotate(new THREE.Vector3()).copy(result).applyAxisAngle(new THREE.Vector3(0, 1, 0), -yaw);
      assert.ok(local.x <= -0.419 && local.x > -0.44, "swept wall clearance");
      near(local.z, 2, 0.025, "wall sliding preserves tangential travel");
      nearPoint(start, originalStart, 0, "input feet are immutable"); nearPoint(delta, originalDelta, 0, "input delta is immutable");
      const fast = world.move(rotate(new THREE.Vector3(-8, 0, 0)), rotate(new THREE.Vector3(16, 0, 0)), 0.32, 1.8)
        .applyAxisAngle(new THREE.Vector3(0, 1, 0), -yaw);
      assert.ok(fast.x < -0.419, "long frame cannot tunnel through thin wall");
      const recovery = world.move(new THREE.Vector3(0, 0, 0), new THREE.Vector3(), 0.32, 1.8);
      near(recovery.y, 0, 1e-6, "overlap recovery does not teleport onto a roof");
      assert.ok(recovery.length() >= 0.42, "overlap is recovered horizontally");
    }
    const bounded = space(WorldSpatial, { halfExtent: 10 });
    nearPoint(bounded.move(new THREE.Vector3(9, 0, -9), new THREE.Vector3(100, 0, -100), 0.32, 1.8),
      new THREE.Vector3(9.68, 0, -9.68));
    assert.throws(() => new WorldSpatial({ terrain: () => 0, water: () => null, halfExtent: Infinity }), /halfExtent/);
  });

  await check("nearest/non-unit rays, rounded sphere corners, two-sided floors and terrain", () => {
    const world = space(WorldSpatial);
    world.addCollider(collider("wall", 0, 1.5, 0, 0.2, 3, 8));
    world.addCollider(collider("far", 10, 1.5, 0, 1, 3, 8));
    const origin = new THREE.Vector3(-3, 1, 0), direction = new THREE.Vector3(7, 0, 0);
    const hit = world.traceStatic(origin, direction, 20);
    assert.ok(hit); near(hit.distance, 2.9); nearPoint(hit.point, new THREE.Vector3(-0.1, 1, 0));
    nearPoint(hit.normal, new THREE.Vector3(-1, 0, 0));
    near(world.traceStatic(origin, direction, 20, 0.3).distance, 2.6);
    assert.equal(world.traceStatic(origin, direction, 2), null);
    assert.equal(world.traceStatic(origin, new THREE.Vector3(), 20), null);
    assert.equal(world.traceStatic(origin, direction, Infinity), null);
    nearPoint(direction, new THREE.Vector3(7, 0, 0), 0);
    const corners = space(WorldSpatial, { terrain: () => -10 });
    corners.addCollider(collider("box", 0, 1, 0, 2, 2, 2));
    const rounded = corners.traceStatic(new THREE.Vector3(-3, 1, 1.25), new THREE.Vector3(1, 0, 0), 6, 0.3);
    assert.ok(rounded); near(rounded.distance, 2 - Math.sqrt(0.3 ** 2 - 0.25 ** 2));
    assert.equal(corners.traceStatic(new THREE.Vector3(-3, 1, 1.31), new THREE.Vector3(1, 0, 0), 6, 0.3), null);
    const floor = space(WorldSpatial);
    floor.addSupport(support("floor", 0, 3, 0, 6, 6));
    near(floor.traceStatic(new THREE.Vector3(0, 5, 0), new THREE.Vector3(0, -1, 0), 10).distance, 2);
    near(floor.traceStatic(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 1, 0), 5).distance, 1.95);
    near(floor.traceStatic(new THREE.Vector3(10, 2, 10), new THREE.Vector3(0, -1, 0), 3).distance, 2, 2e-5);
    assert.equal(floor.traceStatic(new THREE.Vector3(110, 2, 0), new THREE.Vector3(0, -1, 0), 5), null, "terrain has finite extent");
    const slope = space(WorldSpatial, { terrain: (x, z) => 1 + x * 0.1 + z * 0.2 });
    const terrainHit = slope.traceStatic(new THREE.Vector3(0, 4, 0), new THREE.Vector3(0, -1, 0), 10);
    near(terrainHit.distance, 3, 5e-5);
    nearPoint(terrainHit.normal, new THREE.Vector3(-0.1, 1, -0.2).normalize(), 1e-5);
  });

  await check("deep-water blocking, shallow travel, bridge support and escape", () => {
    const coast = { terrain: x => x >= 0 ? -2 : 0,
      water: x => x >= 0 ? { id: "sea", level: 0, depth: 2 } : null };
    const world = space(WorldSpatial, coast);
    const stopped = world.move(new THREE.Vector3(-2, 0, 0), new THREE.Vector3(6, 0, 0), 0.32, 1.8);
    assert.ok(stopped.x < -0.319 && stopped.x > -0.35, "body footprint stops before deep water");
    world.addSupport(support("bridge", 2, 0.2, 0, 6, 2));
    nearPoint(world.move(new THREE.Vector3(-2, 0, 0), new THREE.Vector3(6, 0, 0), 0.32, 1.8), new THREE.Vector3(4, 0.2, 0));
    assert.equal(world.traceStatic(new THREE.Vector3(0, 1, 5), new THREE.Vector3(1, 0, 0), 5), null, "water is not bullet-solid");
    const shallow = space(WorldSpatial, { terrain: () => -0.5, water: () => ({ id: "shallows", level: 0, depth: 0.5 }) });
    nearPoint(shallow.move(new THREE.Vector3(0, -0.5, 0), new THREE.Vector3(4, 0, 0), 0.32, 1.8), new THREE.Vector3(4, -0.5, 0));
    const escape = space(WorldSpatial, { terrain: x => -0.1 - Math.max(0, x) * 0.2,
      water: x => ({ id: "slope", level: 0, depth: 0.1 + Math.max(0, x) * 0.2 }) });
    const trapped = new THREE.Vector3(8, -1.7, 0);
    nearPoint(escape.move(trapped, new THREE.Vector3(-6, 0, 0), 0.32, 1.8), new THREE.Vector3(2, -0.5, 0), 0.04, "escape toward shallower water");
    assert.ok(escape.move(trapped, new THREE.Vector3(3, 0, 0), 0.32, 1.8).x < 8.01, "cannot swim farther into deep water");
  });

  await check("camera sphere sweep, interior recovery and terrain clearance", () => {
    const world = space(WorldSpatial);
    world.addCollider(collider("wall", 0, 1.5, 0, 0.2, 3, 8));
    const pivot = new THREE.Vector3(-2, 1.5, 0), desired = new THREE.Vector3(4, 1.5, 0);
    const result = world.resolveCamera(pivot, desired, 0.22);
    assert.ok(result.x < -0.32 && result.x > -0.34, "camera remains on pivot side of the wall");
    nearPoint(pivot, new THREE.Vector3(-2, 1.5, 0), 0); nearPoint(desired, new THREE.Vector3(4, 1.5, 0), 0);
    const interior = world.resolveCamera(new THREE.Vector3(0, 1.5, 0), new THREE.Vector3(-3, 1.5, 0), 0.22);
    assert.ok(Math.abs(interior.x) >= 0.32, "camera recovers from an interior-wall pivot");
    const terrain = space(WorldSpatial, { terrain: () => 2 });
    const clear = terrain.resolveCamera(new THREE.Vector3(0, 4, 0), new THREE.Vector3(3, -1, 0), 0.22);
    assert.ok(clear.y >= 2.22 && clear.y <= 2.24, "camera clears terrain");
    assert.equal(terrain.traceStatic(new THREE.Vector3(0, 2, 0), new THREE.Vector3(0, 1, 0), 2), null, "outward terrain tangency is not a hit");
  });

  let layout;
  await check("real source coast fits SOURCE_SCALE; deterministic shared layout and reservations", async () => {
    island.disposeIslandData();
    const bytes = await readFile(path.join(root, "public", "assets", "3d", "environment", "island", "island_rpg_elev_512.bin"));
    assert.equal(bytes.length, sourceSide ** 2 * 2, "checked-in elevation grid byte size");
    fixtures.buffer = bufferOf(bytes);
    const view = new DataView(fixtures.buffer);
    let land = 0;
    for (let z = 0; z < sourceSide; z++) for (let x = 0; x < sourceSide; x++) {
      if (view.getUint16((z * sourceSide + x) * 2, true) / 100 - 10 <= 0.8) continue;
      land++;
      const p = island.sourceToWorld((x / 511 - 0.5) * island.SOURCE_SIZE, (z / 511 - 0.5) * island.SOURCE_SIZE);
      assert.ok(Math.abs(p.x) < island.HALF && Math.abs(p.y) < island.HALF, "source dry coast must fit the finite world");
    }
    assert.ok(land > 1000, "fixture is the nonempty local island, not a blank grid");
    await island.loadIslandData();
    for (const [x, z] of [[-island.HALF, 0], [island.HALF, 0], [0, -island.HALF], [0, island.HALF]]) {
      assert.equal(island.sampleIslandWater(x, z)?.id, "ocean", "ocean margin on every side");
    }
    layout = createIslandLayout();
    assert.equal(JSON.stringify(layout), JSON.stringify(createIslandLayout()), "layout is deterministic");
    assert.ok(layout.spots.length >= 90, `layout adds island-wide homes, got ${layout.spots.length}`);
    assert.ok(layout.addedHomes.length >= 30, `at least 30 extra road-side homes are placed, got ${layout.addedHomes.length}`);
    const civicCounts = Object.fromEntries(["school", "supermarket", "apartment", "park", "busStop"].map(kind =>
      [kind, layout.civicLots.filter(lot => lot.kind === kind).length]));
    for (const kind of ["school", "supermarket", "apartment", "park"]) assert.equal(civicCounts[kind], 1, `one ${kind} lot`);
    assert.ok(civicCounts.busStop >= 3, `at least three bus stops, got ${civicCounts.busStop}`);
    const distribution = [
      { name: "town", x: 0, z: 0, radius: 420 },
      { name: "northwest", x: -500, z: -290, radius: 240 },
      { name: "east", x: 440, z: 360, radius: 300 },
      { name: "south", x: 180, z: 1250, radius: 380 },
      { name: "southwest", x: -300, z: 1100, radius: 400 },
      { name: "northeast", x: 700, z: -600, radius: 420 },
    ].map(region => ({ ...region, count: layout.spots.filter(spot => Math.hypot(spot.x - region.x, spot.z - region.z) < region.radius).length }));
    assert.ok(distribution.filter(region => region.name !== "town" && region.count > 0).length >= 4,
      `homes reach multiple outer regions: ${distribution.map(region => `${region.name}=${region.count}`).join(", ")}`);
    for (const spot of layout.addedHomes) {
      const roadDistance = layout.distanceToRoad(spot.x, spot.z);
      assert.ok(roadDistance >= 8 && roadDistance <= 36, `new home access-road distance ${roadDistance.toFixed(1)}m`);
    }
    for (const spot of layout.spots) {
      assert.ok(layout.fields.every(field => {
        const dx = spot.x - field.x, dz = spot.z - field.z, c = Math.cos(field.yaw), s = Math.sin(field.yaw);
        return Math.abs(dx * c - dz * s) >= field.width / 2 + 1 || Math.abs(dx * s + dz * c) >= field.depth / 2 + 1;
      }), "homes stay clear of farm plots");
    }
    const poleBases = layout.roads.filter(road => road.kind !== "trail" && road.name !== "Plot access")
      .flatMap(road => sampleRoadPath(road.points, road.kind === "street" ? 44 : 90).flatMap(sample => {
        const x = sample.x - sample.dz * (road.width / 2 + 1.65);
        const z = sample.z + sample.dx * (road.width / 2 + 1.65);
        if (island.getIslandHeight(x, z) < 1 || island.sampleIslandWater(x, z) ||
            layout.spots.some(home => Math.hypot(home.x - x, home.z - z) < 8)) return [];
        return [{ x, z }];
      }));
    for (const stop of layout.civicLots.filter(lot => lot.kind === "busStop")) {
      assert.ok(layout.distanceToRoad(stop.x, stop.z) <= 7, "bus stop stays by a road");
      assert.equal(island.sampleIslandWater(stop.x, stop.z), null, "bus stop stays on dry ground");
      const c = Math.cos(stop.ry), s = Math.sin(stop.ry);
      for (const pole of poleBases) {
        const dx = pole.x - stop.x, dz = pole.z - stop.z;
        const localX = c * dx - s * dz, localZ = s * dx + c * dz;
        assert.ok(Math.abs(localX) > 3.15 || Math.abs(localZ) > 1.35,
          "bus shelter clears roadside pole bases");
      }
    }
    const apartmentLot = layout.civicLots.find(lot => lot.kind === "apartment");
    const civicHomes = layout.spots.filter(spot => spot.family === "apartment" &&
      Math.hypot(spot.x - apartmentLot.x, spot.z - apartmentLot.z) < 1e-6);
    assert.equal(civicHomes.length, 1, "apartment lot creates one enterable apartment");
    nearPoint(new THREE.Vector3(civicHomes[0].x, civicHomes[0].y, civicHomes[0].z),
      new THREE.Vector3(apartmentLot.x, apartmentLot.y, apartmentLot.z), 1e-6, "apartment lot and interior home align");
    assert.deepEqual([...new Set(layout.spots.map(s => s.family))].sort(), Object.keys(HOUSE_FOOTPRINTS).sort());
    assert.equal(new Set(layout.spots.map(s => s.seed)).size, layout.spots.length, "unique stable seeds");
    for (const [i, spot] of layout.spots.entries()) {
      near(spot.y, island.getIslandHeight(spot.x, spot.z));
      assert.equal(island.sampleIslandWater(spot.x, spot.z), null, "houses are on dry plots");
      assert.ok(layout.isReserved(spot.x, spot.z));
      for (const earlier of layout.spots.slice(0, i)) assert.ok(Math.hypot(spot.x - earlier.x, spot.z - earlier.z) >= 19);
    }
    for (const road of layout.roads) for (const point of road.points) {
      assert.ok(layout.distanceToRoad(point.x, point.y) <= -road.width / 2 + 1e-6,
        `${road.name} control point (${point.x}, ${point.y}) clearance ${layout.distanceToRoad(point.x, point.y)}`);
      assert.ok(layout.isReserved(point.x, point.y));
    }
    for (const field of layout.fields) assert.ok(layout.isReserved(field.x, field.z));
    assert.equal(layout.isReserved(2400, 2400), false, "distant ocean is not reserved");
    nearPoint(new THREE.Vector3(layout.centres.harbour.x, 0, layout.centres.harbour.y),
      new THREE.Vector3(-230 * island.SOURCE_SCALE, 0, -140 * island.SOURCE_SCALE), 1e-6);
  });

  await check("house culling and disposal lifecycle", () => {
    assert.ok(layout, "real layout initialization must pass first");
    const batch = own(createHouses(layout.spots.slice(0, 2)));
    batch.update(0.13, batch.houses[0].doorway);
    assert.ok(batch.group.children[0].getObjectByName("interior").visible, "entered interiors stay visible");
    let disposed = 0;
    batch.group.children[0].getObjectByName("structure").children[0].geometry.addEventListener("dispose", () => disposed++);
    batch.dispose(); batch.dispose();
    assert.equal(disposed, 1, "house disposal is idempotent"); assert.equal(batch.group.children.length, 0);
  });

  await check("every generated layout house: doorway, room round trips and stairs both ways", () => {
    assert.ok(layout, "real layout initialization must pass first");
    const batch = own(createHouses(layout.spots));
    try { testHouses(batch, WorldSpatial); } finally { batch.dispose(); }
  });

  await check("eight families across two seeds/four rotations", () => {
    const families = Object.keys(HOUSE_FOOTPRINTS), spots = [];
    for (const family of families) for (const seed of [-17, 1801]) for (const ry of [0, Math.PI / 2, Math.PI, 0.61]) {
      const index = spots.length;
      spots.push({ x: (index % 8) * 35 - 120, y: 7.25, z: Math.floor(index / 8) * 35 - 120, family, seed, ry });
    }
    const batch = own(createHouses(spots));
    try { testHouses(batch, WorldSpatial); } finally { batch.dispose(); }
  });

  await check("deterministic house IDs/contact metadata and seed-selected families", () => {
    const spots = [0, 1, 2, 3, 4, 5, 6, 7].map(index => ({
      x: index * 35, y: 7.25, z: 0, family: Object.keys(HOUSE_FOOTPRINTS)[index], seed: 1801 + index, ry: 0.61,
    }));
    const repeatA = own(createHouses(spots)), repeatB = own(createHouses(spots));
    assert.equal(recordSnapshot(repeatA), recordSnapshot(repeatB), "same input yields same IDs, dimensions and contacts");
    repeatA.houses.forEach((house, index) => assert.equal(house.id, `house-${index}-${spots[index].family}-${spots[index].seed}`));
    const fallbackSpots = [-1, 0, 7, 8].map((seed, index) => ({ x: index * 40, y: 0, z: 0, ry: 0, seed }));
    const fallback = own(createHouses(fallbackSpots));
    const fallbackOrder = ["japanese", "cottage", "farm", "coastal", "townhouse", "shop", "tavern", "apartment"];
    fallback.houses.forEach((house, index) => assert.equal(house.family, fallbackOrder[((fallbackSpots[index].seed % 8) + 8) % 8]));
  });

  await check("IST clock and solar/lunar state", () => {
    const utc = new Date("2026-11-19T00:00:00.000Z");
    assert.equal(formatIST(utc), "05:30:00");
    const midnight = getCelestialState(new Date("2026-11-18T18:30:00.000Z"));
    const noon = getCelestialState(new Date("2026-11-19T06:30:00.000Z"));
    for (const state of [midnight, noon]) {
      near(state.sun.length(), 1, 1e-8, "sun direction length");
      near(state.moon.length(), 1, 1e-8, "moon direction length");
      assert.ok(state.daylight >= 0 && state.daylight <= 1);
      assert.ok(state.moonlight >= 0 && state.moonlight <= 1);
    }
    assert.ok(noon.daylight > midnight.daylight + 0.7, "IST noon brighter than midnight");
    assert.ok(noon.sun.y > midnight.sun.y, "sun rises above the horizon by noon");
  });

  await check("animated door collider follows leaf and clears on close/dispose", () => {
    const batch = own(createHouses([{ x: 0, y: 0, z: 0, ry: 0.61, family: "cottage", seed: 91 }]));
    const world = space(WorldSpatial);
    world.addColliders(batch.colliders);
    world.addSupports(batch.supports);
    batch.attachCollision(world);
    const id = `${batch.houses[0].id}-door-leaf`;
    const closed = world.colliders.entries.get(id);
    assert.ok(closed, "closed door collider registered");
    near(Math.hypot(closed.center.x - batch.houses[0].doorway.x, closed.center.z - batch.houses[0].doorway.z),
      0.05, 0.03, "closed leaf sits at threshold");
    assert.equal(batch.toggleNearestDoor(batch.houses[0].doorway), true);
    for (let i = 0; i < 50; i++) batch.update(0.05, batch.houses[0].doorway);
    const opened = world.colliders.entries.get(id);
    assert.ok(opened, "open door collider remains registered");
    assert.ok(opened.center.distanceTo(closed.center) > 0.55, "open leaf collider follows hinge arc");
    assert.ok(opened.axes[0].distanceTo(closed.axes[0]) > 0.25, "open leaf collider turns with mesh");
    assert.equal(batch.nearestDoor(batch.houses[0].doorway).open, true);
    batch.dispose();
    assert.equal(world.stats.colliders, batch.colliders.length, "dispose removes door collider but keeps static house walls");
    world.dispose();
  });
  console.log(`Island tests: ${passed} passed, ${failed} failed; ${houseChecks}/${houseAttempts} complete houses, ${roomChecks} room round trips, ${ascentChecks} stair ascents, ${stairChecks} stair round trips.`);
  if (failed) process.exitCode = 1;
}

try { await main(); }
catch (error) { console.error(`FAIL test initialization: ${error.message}`); process.exitCode = 1; }
finally {
  // Dispose worlds before shared data; only in-memory resources were created.
  for (const cleanup of cleanups.reverse()) {
    try { cleanup(); } catch (error) { console.error(`FAIL cleanup: ${error.message}`); process.exitCode = 1; }
  }
  fixtures.buffer = fixtures.gate = null;
  for (const canvas of canvases) canvas.pixels = new Uint8ClampedArray();
  for (const image of images) image.pixels = null;
  canvases.clear(); images.clear(); modules.clear();
}
