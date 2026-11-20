// scripts/bake_mixamo_anims.mts
// 1. Reads each Mixamo FBX from public/assets/3d/animations/mixamo/
// 2. Normalizes onto male-1.gltf VRM rig with rest-pose compensation
// 3. Analyzes jump physics (Jumping, Walking_Jump, Running_Jump) for takeoff, flight, land, g, v0, rise
// 4. Applies jumpArc physics subtraction to jump clips
// 5. Measures exact foot-plant speed (strides.json) to eliminate foot sliding
// 6. Bakes the retargeted clips into public/assets/3d/animations/vrm-json/${id}.json

import fs from "fs";
import path from "path";
import * as THREE from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { retargetMixamoAsset } from "../src/lib/mixamoRetarget";

const glb = fs.readFileSync("public/assets/3d/characters/character-2/male-1.gltf");
const json = JSON.parse(glb.slice(20, 20 + glb.readUInt32LE(12)).toString("utf8"));
const nodes: any[] = json.nodes;
const parent = new Map<number, number>();
nodes.forEach((n, i) => (n.children || []).forEach((c: number) => parent.set(c, i)));

const local = (n: any) =>
  new THREE.Matrix4().compose(
    new THREE.Vector3().fromArray(n.translation || [0, 0, 0]),
    new THREE.Quaternion().fromArray(n.rotation || [0, 0, 0, 1]),
    new THREE.Vector3().fromArray(n.scale || [1, 1, 1])
  );
const worldCache = new Map<number, THREE.Matrix4>();
const world = (i: number): THREE.Matrix4 => {
  if (worldCache.has(i)) return worldCache.get(i)!;
  const m = parent.has(i) ? world(parent.get(i)!).clone().multiply(local(nodes[i])) : local(nodes[i]);
  worldCache.set(i, m);
  return m;
};

// Normalized rig: identity rotations, translations = world offsets between bones
const isBip = (i: number) => /^J_Bip_/.test(nodes[i].name || "");
const model = new THREE.Group();
const made = new Map<number, THREE.Object3D>();
const wpos = (i: number) => new THREE.Vector3().setFromMatrixPosition(world(i));
const bipIdx = nodes.map((_, i) => i).filter(isBip);
const nearestBipParent = (i: number): number | undefined => {
  let p = parent.get(i);
  while (p !== undefined && !isBip(p)) p = parent.get(p);
  return p;
};
for (const i of bipIdx) {
  const o = new THREE.Object3D();
  o.name = "Normalized_" + nodes[i].name;
  made.set(i, o);
}
for (const i of bipIdx) {
  const p = nearestBipParent(i);
  const o = made.get(i)!;
  if (p === undefined) {
    o.position.copy(wpos(i));
    model.add(o);
  } else {
    o.position.copy(wpos(i).sub(wpos(p)));
    made.get(p)!.add(o);
  }
}
model.updateMatrixWorld(true);

const rest = new Map<THREE.Object3D, THREE.Vector3>();
model.traverse((o) => rest.set(o, o.position.clone()));
const resetRig = () => {
  model.traverse((o) => {
    const r = rest.get(o);
    if (r) {
      o.position.copy(r);
      o.quaternion.identity();
    }
  });
  model.updateMatrixWorld(true);
};

const foot = (n: string) => model.getObjectByName(n)!;
const hips = foot("Normalized_J_Bip_C_Hips");
const restHipsY = hips.position.y;
console.log("VRM Rig Hips Rest Y =", restHipsY.toFixed(3), "m");

const LOOPS = new Set([
  "Idle",
  "Walking",
  "Running",
  "Crouch_Idle",
  "Crouched_Walking",
  "Prone_Idle",
  "Prone_Crawl",
  "Sitting",
  "Sleeping",
  "Hip_Hop_Dancing",
]);
const MOVING = new Set(["Walking", "Running", "Crouched_Walking", "Prone_Crawl"]);
const JUMPS = new Set(["Jumping", "Walking_Jump", "Running_Jump"]);

const dir = "public/assets/3d/animations/mixamo";
const outDir = "public/assets/3d/animations/vrm-json";
fs.mkdirSync(outDir, { recursive: true });

const loader = new FBXLoader();
const strides: Record<string, number> = {};
const jumps: Record<string, any> = {};

// 1. Pass 1: Analyze jump profiles for all jump clips
for (const jumpId of ["Jumping", "Walking_Jump", "Running_Jump"]) {
  const fbxPath = `${dir}/${jumpId}.fbx`;
  if (!fs.existsSync(fbxPath)) continue;
  const b = fs.readFileSync(fbxPath);
  const asset = loader.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), "");
  resetRig();
  const rawRig = retargetMixamoAsset(asset, model, { loop: false, unitScale: 1, vrmMetaVersion: "1" }, jumpId);
  const mixer = new THREE.AnimationMixer(model);
  const act = mixer.clipAction(rawRig.clip);
  act.play();

  const M = 400, dur = rawRig.clip.duration, dtc = dur / M;
  const tl = model.getObjectByName("Normalized_J_Bip_L_ToeBase")!, tr = model.getObjectByName("Normalized_J_Bip_R_ToeBase")!;
  const tv = new THREE.Vector3(), ty: number[] = [], hh: number[] = [];
  for (let k = 0; k <= M; k++) {
    mixer.setTime(k * dtc);
    model.updateMatrixWorld(true);
    ty.push(Math.min(tl.getWorldPosition(tv).y, tr.getWorldPosition(tv).y));
    hh.push(hips.getWorldPosition(tv).y);
  }
  const ground = Math.min(...ty), air = ty.map((y) => y > ground + 0.05);
  let it = air.indexOf(true), il = air.lastIndexOf(true);
  if (it < 0 || il - it < 6) {
    it = Math.floor(M * 0.1);
    il = Math.floor(M * 0.7);
  }
  const n = il - it + 1;
  let s = [0, 0, 0, 0, 0], r = [0, 0, 0];
  for (let k = it; k <= il; k++) {
    const t = (k - it) * dtc, y = hh[k];
    for (let p = 0; p < 5; p++) s[p] += t ** p;
    for (let p = 0; p < 3; p++) r[p] += y * t ** p;
  }
  const A = [[s[4], s[3], s[2]], [s[3], s[2], s[1]], [s[2], s[1], s[0]]];
  const det = (m: number[][]) =>
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const D = det(A);
  const col = (c: number) => A.map((row, i) => row.map((v, j) => (j === c ? [r[2], r[1], r[0]][i] : v)));
  const [qa, qb] = [det(col(0)) / D, det(col(1)) / D];
  const flight = (il - it) * dtc;
  const rawG = -2 * qa;
  const g = rawG > 4 && rawG < 25 ? rawG : (jumpId === "Running_Jump" ? 10.5 : 12.0);
  const v0 = g * flight / 2;
  const rise = (g * flight * flight) / 8;

  jumps[jumpId] = {
    takeoff: +(it * dtc).toFixed(3),
    land: +(il * dtc).toFixed(3),
    flight: +flight.toFixed(3),
    dur: +dur.toFixed(3),
    g: +g.toFixed(2),
    v: +v0.toFixed(3),
    rise: +rise.toFixed(3),
  };
  console.log(`Jump Profile [${jumpId}]:`, jumps[jumpId]);
}

// 2. Pass 2: Retarget all FBX clips, compute foot-plant strides, and bake to JSON
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".fbx"));
for (const f of files) {
  const id = f.replace(".fbx", "");
  const b = fs.readFileSync(`${dir}/${f}`);
  const asset = loader.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), "");
  resetRig();

  const isJump = JUMPS.has(id);
  const jp = jumps[id];
  const jumpArc = isJump && jp ? { takeoff: jp.takeoff, land: jp.land, v: jp.v, g: jp.g } : undefined;

  const rig = retargetMixamoAsset(
    asset,
    model,
    {
      loop: LOOPS.has(id),
      unitScale: 1,
      vrmMetaVersion: "1",
      jumpArc,
    },
    f
  );

  const mixer = new THREE.AnimationMixer(model);
  const act = mixer.clipAction(rig.clip);
  act.play();

  // Measure stride speed for moving animations
  if (MOVING.has(id)) {
    const N = 60;
    const lt = model.getObjectByName("Normalized_J_Bip_L_ToeBase")!, rt = model.getObjectByName("Normalized_J_Bip_R_ToeBase")!;
    const T: { z: number; y: number }[][] = [[], []];
    const dtc = rig.clip.duration / N;
    const v = new THREE.Vector3();
    for (let k = 0; k <= N; k++) {
      mixer.setTime((k / N) * rig.clip.duration);
      model.updateMatrixWorld(true);
      lt.getWorldPosition(v); T[0].push({ z: v.z, y: v.y });
      rt.getWorldPosition(v); T[1].push({ z: v.z, y: v.y });
    }
    const minToe = Math.min(...T.flat().map((p) => p.y));
    const est: number[] = [];
    for (const side of T) {
      for (let k = 0; k < N; k++) {
        if (side[k].y < minToe + 0.035 && side[k + 1].y < minToe + 0.035) {
          est.push(-(side[k + 1].z - side[k].z) / dtc);
        }
      }
    }
    est.sort((a, b) => a - b);
    const vOpt = est.length ? est[Math.floor(est.length / 2)] : rig.strideSpeed;
    strides[id] = +(vOpt > 0.3 ? vOpt : rig.strideSpeed || 1.6).toFixed(3);
    console.log(`Locomotion Stride [${id}]: groundSpeed=${strides[id]} m/s (dur=${rig.clip.duration.toFixed(2)}s)`);
  }

  // Bake AnimationClip to standard JSON
  rig.clip.name = id;
  const clipJson = rig.clip.toJSON();
  fs.writeFileSync(`${outDir}/${id}.json`, JSON.stringify(clipJson));
  console.log(`Bake OK -> ${outDir}/${id}.json (${(fs.statSync(`${outDir}/${id}.json`).size / 1024).toFixed(1)} KB)`);
}

// 3. Save strides and jumps metadata
fs.writeFileSync(`${dir}/jumps.json`, JSON.stringify(jumps, null, 2));
fs.writeFileSync(`${dir}/strides.json`, JSON.stringify(strides, null, 2));
console.log("\nDone! Updated strides.json and jumps.json successfully.");
