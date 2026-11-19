// Offline check of the Mixamo -> VRM retarget. Run: npx tsx scripts/verify_anims.mts
// Builds a normalized VRM rig from male-1.gltf, retargets each clip, samples it and
// measures foot sliding / ground penetration / pose sanity.
import fs from "fs";
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

// normalized rig: identity rotations, translations = world offsets between bones
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

const strides: Record<string, number> = {};
const rest = new Map<THREE.Object3D, THREE.Vector3>();
model.traverse((o) => rest.set(o, o.position.clone()));
const loader = new FBXLoader();
const CAND = process.env.CAND; const dir = CAND ?? "public/assets/3d/animations/mixamo";
const LOOPS = new Set([
  "Idle", "Walking", "Running", "Crouch_Idle", "Crouched_Walking", "Prone_Idle", "Prone_Crawl",
]);
const MOVING = new Set(["Walking", "Running", "Crouched_Walking", "Prone_Crawl"]);

const foot = (n: string) => model.getObjectByName(n)!;
const hips = foot("Normalized_J_Bip_C_Hips");
const restHipsY = hips.position.y;
console.log("rig hips rest y =", restHipsY.toFixed(3), "m");

const jumps: Record<string, any> = {};
for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".fbx"))) {
  const id = f.replace(".fbx", "");
  const b = fs.readFileSync(`${dir}/${f}`);
  const asset = loader.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), "");
  let seamDegG = 0;
  for (const t of asset.animations[0].tracks) {
    if (!t.name.endsWith(".quaternion")) continue;
    const n = t.times.length;
    seamDegG = Math.max(seamDegG, (new THREE.Quaternion().fromArray(t.values, 0).angleTo(new THREE.Quaternion().fromArray(t.values, (n - 1) * 4)) * 180) / Math.PI);
  }
  // fresh rest pose each clip
  model.traverse((o) => {
    const r = rest.get(o)!;
    o.position.copy(r); o.quaternion.identity();
  });
  model.updateMatrixWorld(true);
  const rig = retargetMixamoAsset(asset, model, { loop: (CAND ? true : LOOPS.has(id)), unitScale: 1, vrmMetaVersion: "1" }, f);
  const mixer = new THREE.AnimationMixer(model);
  const act = mixer.clipAction(rig.clip);
  act.play();
  if (process.env.JUMPRANK || id === "Jumping" || id === "Running_Jump") {
    const M = 400, dur = rig.clip.duration, dtc = dur / M;
    const tl = model.getObjectByName("Normalized_J_Bip_L_ToeBase")!, tr = model.getObjectByName("Normalized_J_Bip_R_ToeBase")!;
    const tv = new THREE.Vector3(), ty: number[] = [], hh: number[] = [];
    for (let k = 0; k <= M; k++) {
      mixer.setTime(k * dtc); model.updateMatrixWorld(true);
      ty.push(Math.min(tl.getWorldPosition(tv).y, tr.getWorldPosition(tv).y));
      hh.push(hips.getWorldPosition(tv).y);
    }
    const ground = Math.min(...ty), air = ty.map((y) => y > ground + 0.06);
    const it = air.indexOf(true), il = air.lastIndexOf(true);
    if (it < 0 || il - it < 8) { console.log(id.padEnd(22), "noflight"); if (process.env.JUMPRANK) continue; else throw new Error("no flight in " + id); }
    // quadratic least squares of hips height over flight: y = a t^2 + b t + c
    const n = il - it + 1; let s = [0, 0, 0, 0, 0], r = [0, 0, 0];
    for (let k = it; k <= il; k++) { const t = (k - it) * dtc, y = hh[k]; for (let p = 0; p < 5; p++) s[p] += t ** p; for (let p = 0; p < 3; p++) r[p] += y * t ** p; }
    const A = [[s[4], s[3], s[2]], [s[3], s[2], s[1]], [s[2], s[1], s[0]]];
    const det = (m: number[][]) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    const D = det(A), col = (c: number) => A.map((row, i) => row.map((v, j) => (j === c ? [r[2], r[1], r[0]][i] : v)));
    const [qa, qb, qc] = [det(col(0)) / D, det(col(1)) / D, det(col(2)) / D];
    let ssr = 0, sst = 0; const mean = hh.slice(it, il + 1).reduce((x, y) => x + y, 0) / n;
    for (let k = it; k <= il; k++) { const t = (k - it) * dtc; ssr += (hh[k] - (qa * t * t + qb * t + qc)) ** 2; sst += (hh[k] - mean) ** 2; }
    const apex = Math.max(...hh.slice(it, il + 1)), base = (hh[it] + hh[il]) / 2;
    // forward travel in flight from the raw root motion (cm)
    const ht = asset.animations[0].tracks.find((t: any) => /Hips\.position$/.test(t.name)) as any;
    let fwd = 0;
    if (ht) { const at = (tt: number) => { let i = 0; while (i < ht.times.length - 2 && ht.times[i + 1] < tt) i++; return [ht.values[i * 3], ht.values[i * 3 + 2]]; }; const p0 = at(it * dtc), p1 = at(il * dtc); fwd = (Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) / 100 * restHipsY) / ((il - it) * dtc); }
    console.log(id.padEnd(22), `dur ${dur.toFixed(2)} take ${(it * dtc).toFixed(2)} land ${(il * dtc).toFixed(2)} flight ${((il - it) * dtc).toFixed(2)} recover ${(dur - il * dtc).toFixed(2)} | rise ${(apex - base).toFixed(2)} R2 ${(1 - ssr / sst).toFixed(3)} g ${(-2 * qa).toFixed(1)} v0 ${qb.toFixed(2)} | fwd ${fwd.toFixed(2)} m/s | hipsEnd-Start ${(hh[M] - hh[0]).toFixed(2)}`);
    if (process.env.JUMPRANK) continue;
    const flight = (il - it) * dtc, g = -2 * qa;
    jumps[id] = { takeoff: +(it * dtc).toFixed(3), land: +(il * dtc).toFixed(3), flight: +flight.toFixed(3), dur: +dur.toFixed(3), g: +g.toFixed(2), v: +(g * flight / 2).toFixed(3), rise: +(g * flight * flight / 8).toFixed(3) };
    console.log("jump profile", id, jumps[id]);
  }
  const N = 60;
  const lf = foot("Normalized_J_Bip_L_Foot"), rf = foot("Normalized_J_Bip_R_Foot");
  const v = new THREE.Vector3();
  const samples: { lz: number; rz: number; ly: number; ry: number; hy: number; hx: number; sep: number }[] = [];
  for (let k = 0; k < N; k++) {
    mixer.setTime((k / N) * rig.clip.duration);
    model.updateMatrixWorld(true);
    lf.getWorldPosition(v); const lz = v.z, ly = v.y, lx = v.x;
    rf.getWorldPosition(v); const rz = v.z, ry = v.y, rx = v.x;
    const hp = hips.getWorldPosition(v); samples.push({ lz, rz, ly, ry, hy: hp.y, hx: hp.x, sep: Math.abs(lx - rx) });
  }
  const minY = Math.min(...samples.map((s) => Math.min(s.ly, s.ry)));
  if (false as boolean) {
    // find takeoff / apex / landing from pelvis height so physics air time can drive the clip
    // flight = both toes clearly off the ground
    const M = 240, ty: number[] = [];
    const tl = model.getObjectByName("Normalized_J_Bip_L_ToeBase")!, tr = model.getObjectByName("Normalized_J_Bip_R_ToeBase")!;
    for (let k = 0; k <= M; k++) {
      mixer.setTime((k / M) * rig.clip.duration); model.updateMatrixWorld(true);
      ty.push(Math.min(tl.getWorldPosition(v).y, tr.getWorldPosition(v).y));
    }
    const ground = Math.min(...ty);
    const air = ty.map((y) => y > ground + 0.08);
    const it = air.indexOf(true), il = air.lastIndexOf(true);
    const dtc = rig.clip.duration / M;
    (strides as any)._jump = { takeoff: +(it * dtc).toFixed(3), land: +(il * dtc).toFixed(3), flight: +((il - it) * dtc).toFixed(3) };
    console.log("jump timing", (strides as any)._jump);
  }
  // foot-plant based speed: the character must move so the planted toe stays still
  let vOpt = 0, resid = 0, jinfo = "";
  if (CAND || MOVING.has(id)) {
    const lt = model.getObjectByName("Normalized_J_Bip_L_ToeBase")!, rt = model.getObjectByName("Normalized_J_Bip_R_ToeBase")!;
    const T: { z: number; y: number }[][] = [[], []];
    const dtc = rig.clip.duration / N;
    for (let k = 0; k <= N; k++) {
      mixer.setTime((k / N) * rig.clip.duration); model.updateMatrixWorld(true);
      lt.getWorldPosition(v); T[0].push({ z: v.z, y: v.y });
      rt.getWorldPosition(v); T[1].push({ z: v.z, y: v.y });
    }
    const minToe = Math.min(...T.flat().map((p) => p.y));
    const est: number[] = [];
    for (const side of T) for (let k = 0; k < N; k++) {
      if (side[k].y < minToe + 0.025 && side[k + 1].y < minToe + 0.025) est.push(-(side[k + 1].z - side[k].z) / dtc);
    }
    est.sort((a, b) => a - b);
    vOpt = est.length ? est[Math.floor(est.length / 2)] : 0;
    resid = est.length ? est.reduce((s, e) => s + Math.abs(e - vOpt), 0) / est.length : 0;
    strides[id] = +vOpt.toFixed(3);
    {
      const air = T[0].map((p, k) => Math.min(p.y, T[1][k].y) > minToe + 0.08);
      const first = air.indexOf(true), last = air.lastIndexOf(true);
      const clear = Math.max(...T[0].map((p, k) => Math.min(p.y, T[1][k].y))) - minToe;
      jinfo = first < 0 ? "noflight" : `flight ${((last - first) * dtc).toFixed(2)}s from ${(first * dtc).toFixed(2)} clear ${clear.toFixed(2)}`;
    }
  }
  const hy = samples.map((s) => s.hy);
  let slide = "n/a";
  if (MOVING.has(id) && rig.strideSpeed > 0) {
    const dt = rig.clip.duration / N;
    let tot = 0, cnt = 0;
    for (let k = 0; k < N; k++) {
      const a = samples[k], c = samples[(k + 1) % N];
      for (const [z0, z1, y0] of [[a.lz, c.lz, a.ly], [a.rz, c.rz, a.ry]]) {
        if (y0 < minY + 0.06) { tot += Math.abs(rig.strideSpeed + (z1 - z0) / dt); cnt++; }
      }
    }
    slide = (tot / Math.max(cnt, 1)).toFixed(2) + " m/s";
  }
  console.log(
    id.padEnd(18),
    "stride", rig.strideSpeed.toFixed(2).padStart(5),
    "| tracks", String(rig.clip.tracks.length).padStart(2),
    "| dur", rig.clip.duration.toFixed(2),
    "| footMinY", minY.toFixed(3),
    "| hipsY", Math.min(...hy).toFixed(2) + ".." + Math.max(...hy).toFixed(2),
    "| hipsTravelSpeed", slide, "| plantSpeed", vOpt.toFixed(2), "resid", resid.toFixed(2), "| sway", (Math.max(...samples.map(s=>s.hx))-Math.min(...samples.map(s=>s.hx))).toFixed(2), "minFeetGap", Math.min(...samples.map(s=>s.sep)).toFixed(2), "seam", seamDegG.toFixed(1), "|", jinfo
  );
}
if (!CAND && Object.keys(jumps).length) fs.writeFileSync(`${dir}/jumps.json`, JSON.stringify(jumps, null, 2));
if (!CAND) fs.writeFileSync(`${dir}/strides.json`, JSON.stringify(strides, null, 2));
console.log("wrote strides.json", strides);
