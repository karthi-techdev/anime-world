import * as THREE from "three";

export const ENV = "/assets/3d/environment";
export const STREET = `${ENV}/JapanStreetModularPackLite_glTF/JapanStreetModularPackLite`;
export const NATURE = `${ENV}/trees_grass_rocks/glTF`;

export const GROUND_Y = 5.5;
export const WATER_Y = 4.95;
export const POND = { x: -24, z: -16, r: 12 };
export const TOWN = { x: 0, z: -78, hx: 36, hz: 32 };

/** Shared clock uniform: every animated material reads this one object. */
export const uTime = { value: 0 };

export const clamp = (v: number, a: number, b: number) => Math.min(Math.max(v, a), b);
export const sstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

function hash(x: number, y: number) {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}
function vnoise(x: number, y: number) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
/** Fractal noise in -1..1 */
export function fbm(x: number, y: number, oct = 4) {
  let s = 0, a = 0.5, n = 0;
  for (let i = 0; i < oct; i++) {
    s += a * vnoise(x, y);
    n += a;
    x = x * 2.03 + 17.1;
    y = y * 2.03 + 17.1;
    a *= 0.5;
  }
  return (s / n) * 2 - 1;
}

export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Meadow trail centre line (runs along z, ends at the town edge). */
export const pathX = (z: number) => 3.5 * Math.sin((z - 8.5) * 0.06);

/** Normalised pond distance: <1 inside the water outline. */
export function pondDist(x: number, z: number) {
  const dx = x - POND.x, dz = z - POND.z;
  const a = Math.atan2(dz, dx);
  return Math.hypot(dx, dz) / (POND.r * (1 + 0.16 * Math.sin(3 * a + 0.6) + 0.09 * Math.sin(5 * a)));
}

export function townDist(x: number, z: number) {
  return Math.hypot(
    Math.max(Math.abs(x - TOWN.x) - TOWN.hx, 0),
    Math.max(Math.abs(z - TOWN.z) - TOWN.hz, 0)
  );
}

export function getWorldHeight(x: number, z: number): number {
  const dT = townDist(x, z);
  const townM = sstep(2, 45, dT);
  const dPath = Math.abs(x - pathX(z));
  const pd = pondDist(x, z);
  const pondM = sstep(1.0, 2.6, pd);
  const r = Math.hypot(x, z);

  let h = GROUND_Y;
  const hill = Math.pow(fbm(x * 0.011 + 3.1, z * 0.011 - 1.7) * 0.5 + 0.5, 1.3);
  h += hill * 18 * townM * sstep(4, 60, dPath) * pondM;
  h += fbm(x * 0.06, z * 0.06, 3) * 0.35 * sstep(3, 14, dPath) * townM * pondM;
  h += sstep(160, 300, r) * (22 + 14 * fbm(x * 0.02, z * 0.02));
  h -= 2.4 * (1 - sstep(0.55, 1.15, pd));
  h -= 0.1 * (1 - sstep(0, 4, dT));
  return h;
}

/** Up-component of the terrain normal (1 = flat). */
export function slopeY(x: number, z: number) {
  const e = 1.5;
  const nx = getWorldHeight(x - e, z) - getWorldHeight(x + e, z);
  const nz = getWorldHeight(x, z - e) - getWorldHeight(x, z + e);
  return (2 * e) / Math.hypot(nx, 2 * e, nz);
}

export const GLSL_NOISE = /* glsl */ `
float thash(vec2 p){ p=fract(p*vec2(123.34,456.21)); p+=dot(p,p+45.32); return fract(p.x*p.y); }
float tnoise(vec2 p){ vec2 i=floor(p),f=fract(p); f=f*f*(3.-2.*f);
  return mix(mix(thash(i),thash(i+vec2(1,0)),f.x),mix(thash(i+vec2(0,1)),thash(i+vec2(1,1)),f.x),f.y); }
float tfbm(vec2 p){ float s=0.,a=.5; for(int i=0;i<5;i++){ s+=a*tnoise(p); p=p*2.03+17.1; a*=.5; } return s; }
`;

/** Replaces three's project_vertex so wind runs after the instance transform (world space). */
export const projectWithWind = (windCode: string) => /* glsl */ `
vec4 mvPosition = vec4( transformed, 1.0 );
#ifdef USE_INSTANCING
  mvPosition = instanceMatrix * mvPosition;
  vec3 ip = instanceMatrix[3].xyz;
  ${windCode}
#endif
mvPosition = modelViewMatrix * mvPosition;
gl_Position = projectionMatrix * mvPosition;
`;

/** Double-sided foliage keeps one normal for both faces, so back faces are not lit from below. */
export const NO_FLIP_NORMAL = "vec3 normal = normalize( vNormal ); vec3 nonPerturbedNormal = normal;";

export interface WindOpts {
  bend: number;
  flutter: number;
  /** Centre for soft "puffy" canopy normals (model space). */
  puff?: THREE.Vector3;
}

/** Adds trunk sway + leaf flutter to a standard material used on an InstancedMesh. */
export function windify(mat: THREE.Material, o: WindOpts) {
  mat.customProgramCacheKey = () => `wind${o.puff ? 1 : 0}`;
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = uTime;
    sh.uniforms.uBend = { value: o.bend };
    sh.uniforms.uFlutter = { value: o.flutter };
    sh.uniforms.uPuff = { value: o.puff ?? new THREE.Vector3() };
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", "#include <common>\nuniform float uTime,uBend,uFlutter; uniform vec3 uPuff;")
      .replace(
        "#include <project_vertex>",
        projectWithWind(/* glsl */ `
          float relY = max(mvPosition.y - ip.y, 0.);
          float ph = ip.x*0.13 + ip.z*0.17;
          float sway = sin(uTime*0.9+ph)*0.6 + sin(uTime*1.7+ph*1.3)*0.4;
          mvPosition.xz += vec2(0.8,0.6)*sway*uBend*relY*relY;
          mvPosition.xyz += uFlutter*smoothstep(0.,1.5,relY)*vec3(
            sin(uTime*2.6+mvPosition.y*2.1+mvPosition.z*1.7),
            sin(uTime*2.1+mvPosition.x*1.9)*0.6,
            sin(uTime*2.9+mvPosition.x*2.3+mvPosition.y*1.3));
        `)
      );
    if (o.puff) {
      sh.vertexShader = sh.vertexShader.replace(
        "#include <beginnormal_vertex>",
        "#include <beginnormal_vertex>\nobjectNormal = normalize(mix(objectNormal, normalize(position - uPuff), 0.85));"
      );
      sh.fragmentShader = sh.fragmentShader.replace("#include <normal_fragment_begin>", NO_FLIP_NORMAL);
    }
  };
}

export interface Part {
  geo: THREE.BufferGeometry;
  mat: THREE.Material;
}

/** Flattens a loaded glTF scene into world-space geometry + material pairs. */
export function bakeParts(root: THREE.Object3D): Part[] {
  const parts: Part[] = [];
  root.updateMatrixWorld(true);
  root.traverse((c) => {
    const m = c as THREE.Mesh;
    if (!m.isMesh) return;
    const geo = m.geometry.clone().applyMatrix4(m.matrixWorld);
    parts.push({ geo, mat: Array.isArray(m.material) ? m.material[0] : m.material });
  });
  return parts;
}

export function instance(
  group: THREE.Group,
  parts: Part[],
  mats: THREE.Matrix4[],
  opts: { cast?: boolean; receive?: boolean; colors?: (THREE.Color | null)[]; tintPart?: (p: Part) => boolean } = {}
) {
  if (!mats.length) return;
  for (const p of parts) {
    const im = new THREE.InstancedMesh(p.geo, p.mat, mats.length);
    mats.forEach((m, i) => im.setMatrixAt(i, m));
    if (opts.colors && (!opts.tintPart || opts.tintPart(p))) {
      const white = new THREE.Color(1, 1, 1);
      opts.colors.forEach((c, i) => im.setColorAt(i, c ?? white));
    }
    im.castShadow = opts.cast ?? true;
    im.receiveShadow = opts.receive ?? true;
    im.frustumCulled = false;
    group.add(im);
  }
}
