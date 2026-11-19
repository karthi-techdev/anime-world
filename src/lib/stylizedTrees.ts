import * as THREE from "three";
import { mergeGeometries, mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { rng, windify } from "./worldShared";
import type { Part } from "./worldShared";

/**
 * Procedural stylized trees (unit height, root at origin) matching the reference art:
 *  - round   : soft broadleaf with a clustered canopy
 *  - umbrella: thick twisted trunk with flat layered canopy pads and ragged leaf edges
 *  - pine    : stacked cone conifer
 *  - cypress : tall narrow conifer
 * Each variant is [bark, canopy] parts with vertex-colour shading and wind sway.
 */
export type TreeKind = "round" | "umbrella" | "pine" | "cypress";
export interface TreeVariant { kind: TreeKind; parts: Part[] }
export interface TreeKit {
  variants: TreeVariant[];
  ofKind(kind: TreeKind): Part[][];
  dispose(): void;
}

type RGB = [number, number, number];
const lerp = THREE.MathUtils.lerp;
const noise3 = (x: number, y: number, z: number, s: number) =>
  Math.sin(x * 3.1 + s) * Math.sin(y * 3.7 + s * 1.3) * Math.sin(z * 2.9 + s * 0.7);

/** Smooth, lumpy ellipsoid with a light-to-dark vertex gradient and an "edge" factor for ragged leaves. */
function blob(
  c: [number, number, number], r: [number, number, number], seed: number,
  lo: RGB, hi: RGB, rough = 0.16, underFlat = 1, detail = 2,
) {
  let g: THREE.BufferGeometry = new THREE.IcosahedronGeometry(1, detail);
  g.deleteAttribute("normal"); g.deleteAttribute("uv");
  g = mergeVertices(g);
  const pos = g.attributes.position as THREE.BufferAttribute;
  const col = new Float32Array(pos.count * 3), edge = new Float32Array(pos.count);
  const n = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    n.fromBufferAttribute(pos, i).normalize();
    const bump = 1 + rough * noise3(n.x, n.y, n.z, seed);
    const y = n.y * bump * (n.y < 0 ? underFlat : 1);
    pos.setXYZ(i, c[0] + n.x * bump * r[0], c[1] + y * r[1], c[2] + n.z * bump * r[2]);
    const t = Math.pow(n.y * 0.5 + 0.5, 0.85), shade = 0.92 + 0.16 * noise3(n.x * 2, n.y * 2, n.z * 2, seed + 4);
    col[i * 3] = lerp(lo[0], hi[0], t) * shade; col[i * 3 + 1] = lerp(lo[1], hi[1], t) * shade; col[i * 3 + 2] = lerp(lo[2], hi[2], t) * shade;
    edge[i] = 1 - Math.abs(n.y);
  }
  g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  g.setAttribute("aEdge", new THREE.BufferAttribute(edge, 1));
  g.computeVertexNormals();
  return g.toNonIndexed();
}

/** Tapered tube along a curve with a root flare. */
function limb(points: [number, number, number][], r0: number, r1: number, colour: RGB, seg = 14, radial = 8) {
  const curve = new THREE.CatmullRomCurve3(points.map(p => new THREE.Vector3(...p)));
  const g = new THREE.TubeGeometry(curve, seg, 1, radial, false);
  const pos = g.attributes.position as THREE.BufferAttribute;
  const centre = new THREE.Vector3(), v = new THREE.Vector3();
  const col = new Float32Array(pos.count * 3), edge = new Float32Array(pos.count);
  for (let i = 0; i <= seg; i++) {
    const t = i / seg;
    curve.getPointAt(t, centre);
    const r = lerp(r0, r1, t) * (1 + 0.35 * Math.pow(1 - t, 4));
    for (let j = 0; j <= radial; j++) {
      const idx = i * (radial + 1) + j;
      v.fromBufferAttribute(pos, idx).sub(centre).multiplyScalar(r).add(centre);
      pos.setXYZ(idx, v.x, v.y, v.z);
      const shade = lerp(0.62, 1.12, t) * (0.94 + 0.12 * Math.sin(j * 2.4 + i));
      col.set([colour[0] * shade, colour[1] * shade, colour[2] * shade], idx * 3);
    }
  }
  g.deleteAttribute("uv"); g.setAttribute("color", new THREE.BufferAttribute(col, 3)); g.setAttribute("aEdge", new THREE.BufferAttribute(edge, 1));
  g.computeVertexNormals();
  return g.toNonIndexed();
}

/** One cone tier with irregular, drooping silhouette. */
function tier(y0: number, radius: number, height: number, seed: number, lo: RGB, hi: RGB) {
  let g: THREE.BufferGeometry = new THREE.ConeGeometry(radius, height, 11, 3, false);
  g.deleteAttribute("normal"); g.deleteAttribute("uv");
  g = mergeVertices(g);
  const pos = g.attributes.position as THREE.BufferAttribute;
  const col = new Float32Array(pos.count * 3), edge = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i), t = y / height + 0.5; // 0 base .. 1 tip
    const a = Math.atan2(z, x), wob = 1 + 0.16 * Math.sin(a * 5 + seed) + 0.08 * Math.sin(a * 9 + seed * 2);
    pos.setXYZ(i, x * wob, y + y0 + height / 2 - 0.02 * Math.sin(a * 3 + seed) * (1 - t), z * wob);
    col[i * 3] = lerp(lo[0], hi[0], t); col[i * 3 + 1] = lerp(lo[1], hi[1], t); col[i * 3 + 2] = lerp(lo[2], hi[2], t);
  }
  g.setAttribute("color", new THREE.BufferAttribute(col, 3)); g.setAttribute("aEdge", new THREE.BufferAttribute(edge, 1));
  g.computeVertexNormals();
  return g.toNonIndexed();
}

const merge = (gs: THREE.BufferGeometry[]) => mergeGeometries(gs, false)!;

function canopyMaterial(cut: number) {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.88, metalness: 0, side: THREE.DoubleSide });
  m.name = "canopy";
  windify(m, { bend: 0.0009, flutter: cut > 0 ? 0.03 : 0.012 });
  const wind = m.onBeforeCompile;
  m.customProgramCacheKey = () => `kit-canopy-${cut > 0 ? 1 : 0}`;
  m.onBeforeCompile = (sh, renderer) => {
    wind.call(m, sh, renderer);
    sh.uniforms.uCut = { value: cut };
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", "#include <common>\nattribute float aEdge; varying float vEdge; varying vec3 vLeafP;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvEdge = aEdge; vLeafP = position;");
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying float vEdge; varying vec3 vLeafP; uniform float uCut;")
      .replace("#include <alphatest_fragment>", `#include <alphatest_fragment>
        float leafHash = fract(sin(dot(floor(vLeafP * 34.), vec3(12.9898, 78.233, 37.719))) * 43758.5453);
        if (leafHash < vEdge * uCut) discard;`);
  };
  return m;
}
function barkMaterial() {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 });
  m.name = "bark";
  windify(m, { bend: 0.0009, flutter: 0 });
  return m;
}

export function createTreeKit(): TreeKit {
  const variants: TreeVariant[] = [];
  const mats: THREE.Material[] = [];
  const add = (kind: TreeKind, trunk: THREE.BufferGeometry[], canopy: THREE.BufferGeometry[], cut: number) => {
    const bark = barkMaterial(), leaves = canopyMaterial(cut);
    mats.push(bark, leaves);
    variants.push({ kind, parts: [{ geo: merge(trunk), mat: bark }, { geo: merge(canopy), mat: leaves }] });
  };

  // round broadleaf (soft clustered crown)
  for (let s = 1; s <= 3; s++) {
    const r = rng(100 + s), bark: RGB = [0.27, 0.18, 0.12];
    const lo: RGB = [0.07, 0.25, 0.07], hi: RGB = [0.33, 0.66, 0.15];
    const trunk = [limb([[0, 0, 0], [0.012, 0.14, 0], [-0.01, 0.28, 0.01], [0, 0.42, 0]], 0.05, 0.022, bark)];
    const canopy = [blob([0, 0.63, 0], [0.31, 0.25, 0.31], s, lo, hi, 0.14)];
    for (let i = 0; i < 4; i++) {
      const a = r() * 6.28, d = 0.17 + r() * 0.07, h = 0.5 + r() * 0.24;
      canopy.push(blob([Math.cos(a) * d, h, Math.sin(a) * d], [0.17 + r() * 0.05, 0.14 + r() * 0.04, 0.17 + r() * 0.05], s * 7 + i, lo, hi, 0.16));
      if (i < 2) trunk.push(limb([[0, 0.3, 0], [Math.cos(a) * 0.07, 0.4, Math.sin(a) * 0.07], [Math.cos(a) * d * 0.8, h - 0.04, Math.sin(a) * d * 0.8]], 0.022, 0.01, bark, 8, 6));
    }
    add("round", trunk, canopy, 0.22);
  }

  // umbrella: thick twisted trunk, flat layered canopy pads, ragged edges
  for (let s = 1; s <= 3; s++) {
    const r = rng(200 + s), bark: RGB = [0.34, 0.17, 0.2];
    const lo: RGB = [0.05, 0.2, 0.15], hi: RGB = [0.27, 0.58, 0.26];
    const lean = (r() - 0.5) * 0.08;
    const trunk = [limb([[0, 0, 0], [0.07 + lean, 0.12, 0.02], [-0.05, 0.27, -0.03], [0.04 + lean, 0.43, 0.02]], 0.078, 0.042, bark, 16, 9)];
    const canopy = [blob([0.02, 0.78, 0], [0.27, 0.085, 0.27], s * 3, lo, hi, 0.12, 0.6, 3)];
    const pads = 3 + Math.floor(r() * 2);
    for (let i = 0; i < pads; i++) {
      const a = (i / pads) * 6.28 + r(), d = 0.2 + r() * 0.08, h = 0.55 + r() * 0.14;
      canopy.push(blob([Math.cos(a) * d, h, Math.sin(a) * d], [0.19 + r() * 0.05, 0.07 + r() * 0.02, 0.19 + r() * 0.05], s * 11 + i, lo, hi, 0.12, 0.6, 3));
      trunk.push(limb([[0.04, 0.4, 0.02], [Math.cos(a) * d * 0.45, 0.46 + r() * 0.05, Math.sin(a) * d * 0.45], [Math.cos(a) * d * 0.9, h - 0.05, Math.sin(a) * d * 0.9]], 0.03, 0.012, bark, 10, 6));
    }
    add("umbrella", trunk, canopy, 0.6);
  }

  // pine: stacked cone tiers
  for (let s = 1; s <= 3; s++) {
    const r = rng(300 + s), bark: RGB = [0.25, 0.16, 0.1];
    const lo: RGB = [0.04, 0.2, 0.07], hi: RGB = [0.1, 0.44, 0.15];
    const tiers = 6 + Math.floor(r() * 2), width = 0.21 + r() * 0.05;
    const canopy: THREE.BufferGeometry[] = [];
    for (let k = 0; k < tiers; k++) {
      const t = k / (tiers - 1);
      canopy.push(tier(0.08 + t * 0.62, width * (1 - t * 0.82) + 0.03, 0.27 - t * 0.05, s * 5 + k, lo, hi));
    }
    add("pine", [limb([[0, 0, 0], [0, 0.12, 0], [0, 0.3, 0]], 0.03, 0.018, bark, 6, 6)], canopy, 0);
  }

  // cypress: tall narrow flame
  for (let s = 1; s <= 2; s++) {
    const lo: RGB = [0.04, 0.22, 0.08], hi: RGB = [0.1, 0.46, 0.16];
    add("cypress", [limb([[0, 0, 0], [0, 0.08, 0], [0, 0.18, 0]], 0.025, 0.018, [0.25, 0.16, 0.1], 5, 6)],
      [blob([0, 0.5, 0], [0.1 + s * 0.012, 0.43, 0.1 + s * 0.012], s * 13, lo, hi, 0.1), blob([0, 0.9, 0], [0.05, 0.12, 0.05], s * 17, lo, hi, 0.08)], 0);
  }

  return {
    variants,
    ofKind: kind => variants.filter(v => v.kind === kind).map(v => v.parts),
    dispose() {
      for (const v of variants) for (const p of v.parts) p.geo.dispose();
      for (const m of mats) m.dispose();
    },
  };
}
