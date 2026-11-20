// @ts-nocheck
// Offline jump check: npx tsx scripts/verify_jump.mts
import * as THREE from "three";
import fs from "node:fs";
const L: Record<string, (e: any) => void> = {};
(globalThis as any).window = { addEventListener: (n: string, f: any) => (L[n] = f), removeEventListener() {} };
(globalThis as any).document = { activeElement: null };
const { ThirdPersonController } = await import("../src/lib/characterController.ts");
const jumps = JSON.parse(fs.readFileSync("public/assets/3d/animations/mixamo/jumps.json", "utf8"));
const S = 1.15; // model unit scale

function run(fps: number, mode: "idle" | "walk" | "run") {
  const log: { s: string; st: string; t: number }[] = [];
  const c = new ThirdPersonController({
    spawnX: 0, spawnZ: 8.5,
    onLocomotionChange: (s: string, _ts: number, j: any) => { if (j) log.push({ s, st: j.stage, t: j.stage === "windup" ? j.windup > 0 ? j.t : 0 : j.t }); },
  });
  c.setJumpProfiles(jumps, S);
  c.setStrideSpeeds({ Running: 4.24, Walking: 1.62 });
  const cam = new THREE.PerspectiveCamera(); cam.position.set(0, 3, 10);
  const ctl: any = { target: new THREE.Vector3(0, 1.4, 8.5), update() {} };
  const g = new THREE.Group();
  const dt = 1 / fps;
  const step = () => c.update(dt, g, cam, ctl, true);
  if (mode === "run") { L.keydown({ code: "KeyS", repeat: false, preventDefault() {} }); L.keydown({ code: "ShiftLeft", repeat: false, preventDefault() {} }); }
  else if (mode === "walk") { L.keydown({ code: "KeyS", repeat: false, preventDefault() {} }); }
  for (let i = 0; i < fps; i++) step();
  const y0 = c.position.y, sp = Math.hypot(c.velocity.x, c.velocity.z);
  L.keydown({ code: "Space", repeat: false, preventDefault() {} }); L.keyup({ code: "Space" });
  let t = 0, apex = 0, tFly0 = -1, tFly1 = -1;
  for (let i = 0; i < fps * 3; i++) {
    step(); t += dt;
    const h = c.position.y - y0;
    if (h > apex) apex = h;
    if (h > 0.0005 && tFly0 < 0) tFly0 = t;
    if (tFly0 >= 0 && h <= 0.0005 && tFly1 < 0) tFly1 = t;
  }
  const kind = log.find((l) => l.st === "air")?.s;
  const p = jumps[kind];
  const air = log.filter((l) => l.st === "air").map((l) => l.t);
  const mono = air.every((v, i) => i === 0 || v >= air[i - 1] - 1e-9);
  const stages = [...new Set(log.map((l) => l.st))].join(">");
  const wind = log.filter((l) => l.st === "windup");
  console.log(`${fps}fps ${mode.padEnd(5)} speed ${sp.toFixed(2)} kind ${kind} stages ${stages} | windup ${wind.length ? (wind.length * dt).toFixed(2) : "0"}s | flight ${(tFly1 - tFly0).toFixed(3)}s (clip ${p.flight}) | rise ${apex.toFixed(3)} m (clip ${(p.rise * S).toFixed(3)}) | airPhase ${air[0]?.toFixed(2)}..${air[air.length - 1]?.toFixed(2)} mono=${mono}`);
}
for (const fps of [30, 60, 144]) { run(fps, "idle"); run(fps, "walk"); run(fps, "run"); }
