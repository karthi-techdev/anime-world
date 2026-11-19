import * as THREE from "three";
import {
  GLSL_NOISE, NO_FLIP_NORMAL, POND, WATER_Y, getWorldHeight, pathX, pondDist, projectWithWind,
  rng, slopeY, townDist, uTime,
} from "./worldShared";

const lin = (hex: string) => ({ value: new THREE.Color(hex) });

// ---------------------------------------------------------------- sky
export function createSky(sunDir: THREE.Vector3, moonDir: THREE.Vector3) {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: { uTime, uSun: { value: sunDir }, uMoon: { value: moonDir }, uMoonlight: { value: 0 }, uMoonVisible: { value: 0 }, uDay: { value: 1 } },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main(){ vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }`,
    fragmentShader: /* glsl */ `
      uniform float uTime, uDay, uMoonlight, uMoonVisible; uniform vec3 uSun, uMoon; varying vec3 vDir;
      ${GLSL_NOISE}
      void main(){
        vec3 d = normalize(vDir); float h = d.y;
        vec3 top = vec3(0.07,0.27,0.80), mid = vec3(0.20,0.50,0.93), hor = vec3(0.62,0.82,1.0);
        vec3 col = mix(hor, mid, smoothstep(0.,0.22,h));
        col = mix(col, top, smoothstep(0.18,0.9,h));
        float sd = max(dot(d,uSun),0.);
        float md = max(dot(d,uMoon),0.);
        col += vec3(1.,.92,.75)*(pow(sd,900.)*5. + pow(sd,10.)*0.12);
        col += vec3(.67,.77,1.)*pow(md,1400.)*uMoonVisible*(.7+uMoonlight*2.);
        // drifting cumulus
        if(h>0.02){
          vec2 uv = d.xz/(h+0.25)*1.4 + uTime*0.004;
          float c = tfbm(uv*1.5);
          float lit = tfbm(uv*1.5 + uSun.xz*0.14);
          float m = smoothstep(0.50,0.68,c)*smoothstep(0.02,0.22,h);
          vec3 cc = mix(vec3(0.66,0.78,0.96), vec3(1.), smoothstep(-0.04,0.07,c-lit+0.02));
          col = mix(col, cc, m*0.92);
        }
        // towering cloud bank on the horizon
        vec2 az = normalize(d.xz + vec2(0.00001));
        float bank = 0.03 + 0.26*tfbm(az*2.4 + uTime*0.003) + 0.05*tfbm(az*9. + h*10.);
        float bm = smoothstep(bank, bank-0.03, h);
        vec3 bc = mix(vec3(0.72,0.84,0.99), vec3(1.), smoothstep(bank-0.16, bank-0.01, h));
        col = mix(col, bc, bm);
        col = mix(col, hor, smoothstep(0.0,-0.04,h));
        gl_FragColor = vec4(col*mix(0.05,1.,uDay), 1.);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(4000, 48, 24), mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -10;
  return mesh;
}

// ---------------------------------------------------------------- terrain
export function createTerrain() {
  const geo = new THREE.PlaneGeometry(640, 640, 384, 384);
  geo.rotateX(-Math.PI / 2);
  const p = geo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) p.setY(i, getWorldHeight(p.getX(i), p.getZ(i)));
  geo.computeVertexNormals();

  const mat = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0 });
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, {
      uG1: lin("#3f9c2c"), uG2: lin("#7cc83a"), uDirt: lin("#e2d596"),
      uSand: lin("#d8cfa0"), uRock: lin("#aab0be"), uWater: { value: WATER_Y },
    });
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vWp; varying float vNy;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvWp = position; vNy = normal.y;");
    sh.fragmentShader = sh.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>\nvarying vec3 vWp; varying float vNy;
         uniform vec3 uG1,uG2,uDirt,uSand,uRock; uniform float uWater;\n${GLSL_NOISE}`
      )
      .replace(
        "#include <color_fragment>",
        /* glsl */ `#include <color_fragment>
        float n1 = tnoise(vWp.xz*0.08), n2 = tfbm(vWp.xz*0.9);
        vec3 tc = mix(uG1, uG2, n1);
        float px = 3.5*sin((vWp.z-8.5)*0.06);
        float pm = (1.-smoothstep(0.8,2.1,abs(vWp.x-px)+(n2-0.5)*1.2))*smoothstep(-50.,-44.,vWp.z);
        tc = mix(tc, uDirt*(0.86+0.28*n2), pm);
        tc = mix(tc, uSand, 1.-smoothstep(uWater+0.08,uWater+0.5,vWp.y+(n2-0.5)*0.3));
        tc = mix(tc, uRock*(0.8+0.4*n2), smoothstep(0.80,0.62,vNy));
        diffuseColor.rgb = tc;`
      );
  };
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  return mesh;
}

// ---------------------------------------------------------------- grass
function tuftGeometry() {
  const pos: number[] = [], uv: number[] = [], idx: number[] = [];
  const levels = [[0, 1], [0.4, 0.8], [0.75, 0.48], [1, 0]];
  for (let b = 0; b < 3; b++) {
    const a = b * 2.1 + 0.3, ca = Math.cos(a), sa = Math.sin(a);
    const ox = (b - 1) * 0.05, oz = (((b * 7) % 3) - 1) * 0.04;
    const hs = 0.72 + 0.14 * b;
    const base = pos.length / 3;
    for (const [t, w] of levels) {
      const lean = t * t * 0.2;
      for (const s of [-1, 1]) {
        const lx = s * w * 0.045;
        pos.push(ox + lx * ca - lean * sa, t * hs, oz + lx * sa + lean * ca);
        uv.push(s * 0.5 + 0.5, t);
      }
    }
    for (let l = 0; l < 3; l++) {
      const i = base + l * 2;
      idx.push(i, i + 1, i + 2, i + 1, i + 3, i + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(new Array(pos.length).fill(0).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  g.setIndex(idx);
  return g;
}

export function createGrass(count: number) {
  const mat = new THREE.MeshLambertMaterial({ side: THREE.DoubleSide });
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, {
      uTime, uBaseA: lin("#2f8f2a"), uBaseB: lin("#48a82e"), uTipA: lin("#8fd63f"), uTipB: lin("#c4e652"),
    });
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", "#include <common>\nuniform float uTime; varying vec3 vG;")
      .replace("#include <beginnormal_vertex>", "vec3 objectNormal = vec3(0.,1.,0.);")
      .replace(
        "#include <project_vertex>",
        projectWithWind(/* glsl */ `
          float gh = uv.y;
          float w1 = sin(uTime*1.7 + ip.x*0.30 + ip.z*0.22);
          float w2 = sin(uTime*0.9 - ip.x*0.07 + ip.z*0.13 + 1.3);
          float gust = sin(uTime*0.35 + ip.x*0.02 + ip.z*0.03)*0.5+0.5;
          vec2 wd = vec2(0.8,0.6)*(w1*0.06 + w2*0.10 + 0.05)*(0.5+gust);
          mvPosition.xz += wd*gh*gh; mvPosition.y -= length(wd)*gh*gh*0.3;
          vG = vec3(gh, mvPosition.xz);
        `)
      );
    sh.fragmentShader = sh.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>\nvarying vec3 vG; uniform vec3 uBaseA,uBaseB,uTipA,uTipB;\n${GLSL_NOISE}`
      )
      .replace("#include <normal_fragment_begin>", NO_FLIP_NORMAL)
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
        diffuseColor.rgb = mix(mix(uBaseA,uBaseB,tnoise(vG.yz*0.08)), mix(uTipA,uTipB,tnoise(vG.yz*0.035+7.)), vG.x*vG.x);`
      );
  };

  const im = new THREE.InstancedMesh(tuftGeometry(), mat, count);
  const R = 95, rand = rng(11);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), v = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  let n = 0;
  for (let tries = 0; n < count && tries < count * 4; tries++) {
    const r = R * Math.pow(rand(), 0.7), a = rand() * Math.PI * 2;
    const x = Math.cos(a) * r, z = Math.sin(a) * r - 6;
    if (z > -47 && Math.abs(x - pathX(z)) < 1.3 + rand() * 0.5) continue;
    if (townDist(x, z) < 1) continue;
    const y = getWorldHeight(x, z);
    if (y < WATER_Y + 0.3 || slopeY(x, z) < 0.72) continue;
    const far = 1 + r / 45;
    s.set((0.9 + rand() * 0.7) * far, 0.38 + rand() * 0.4, (0.9 + rand() * 0.7) * far);
    m.compose(v.set(x, y - 0.02, z), q.setFromAxisAngle(up, rand() * 6.283), s);
    im.setMatrixAt(n++, m);
  }
  im.count = n;
  im.receiveShadow = true;
  im.frustumCulled = false;
  return im;
}

// ---------------------------------------------------------------- pond
export function createPond(sunDir: THREE.Vector3) {
  const group = new THREE.Group();
  const geo = new THREE.CircleGeometry(POND.r * 1.5, 64);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: { uTime, uSun: { value: sunDir }, uPond: { value: new THREE.Vector3(POND.x, POND.z, POND.r) } },
    vertexShader: /* glsl */ `
      varying vec3 vWp;
      void main(){ vec4 w = modelMatrix*vec4(position,1.); vWp = w.xyz; gl_Position = projectionMatrix*viewMatrix*w; }`,
    fragmentShader: /* glsl */ `
      uniform float uTime; uniform vec3 uSun, uPond; varying vec3 vWp;
      ${GLSL_NOISE}
      void main(){
        vec2 p = vWp.xz, q = p - uPond.xy;
        float a = atan(q.y,q.x);
        float d = length(q)/(uPond.z*(1.+0.16*sin(3.*a+0.6)+0.09*sin(5.*a)));
        float depth = 1.-smoothstep(0.45,1.0,d);
        vec2 f = p*1.3 + vec2(uTime*0.25, uTime*0.12);
        float n0 = tnoise(f);
        vec3 N = normalize(vec3((tnoise(f+vec2(.25,0.))-n0)*1.6, 1., (tnoise(f+vec2(0.,.25))-n0)*1.6));
        vec3 V = normalize(cameraPosition - vWp);
        float fres = pow(1.-max(dot(N,V),0.),3.);
        vec3 col = mix(vec3(0.36,0.80,0.74), vec3(0.05,0.32,0.46), depth);
        col = mix(col, vec3(0.50,0.74,1.0), fres*0.75);
        float c = abs(tnoise(p*1.7 + vec2(-uTime*0.18, uTime*0.22)) - 0.5);
        col += smoothstep(0.035,0.,c)*0.16*(0.3+depth);
        col += pow(max(dot(N,normalize(V+uSun)),0.),220.)*1.6;
        float foam = smoothstep(0.90,0.975, d + sin(uTime*1.2+a*7.)*0.012 + (n0-0.5)*0.05);
        col = mix(col, vec3(1.), foam*0.75);
        gl_FragColor = vec4(col, max(mix(0.5,0.93,depth), foam));
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const water = new THREE.Mesh(geo, mat);
  water.position.set(POND.x, WATER_Y, POND.z);
  water.renderOrder = 2;
  group.add(water);

  // lily pads + blossoms
  const rand = rng(5);
  const padGeo = new THREE.CircleGeometry(0.34, 14, 0.25, 5.8);
  padGeo.rotateX(-Math.PI / 2);
  const pads = new THREE.InstancedMesh(padGeo, new THREE.MeshLambertMaterial({ color: "#3e9b3a", side: THREE.DoubleSide }), 24);
  const flowerGeo = new THREE.ConeGeometry(0.11, 0.12, 7);
  flowerGeo.rotateX(Math.PI);
  const flowers = new THREE.InstancedMesh(flowerGeo, new THREE.MeshLambertMaterial({ color: "#f7a8d4", emissive: "#5a1a3a" }), 6);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
  let n = 0, nf = 0;
  while (n < 24) {
    const x = POND.x + (rand() - 0.5) * POND.r * 1.6, z = POND.z + (rand() - 0.5) * POND.r * 1.6;
    if (pondDist(x, z) > 0.72) continue;
    const sc = 0.7 + rand() * 0.9;
    m.compose(new THREE.Vector3(x, WATER_Y + 0.015, z), q.setFromAxisAngle(up, rand() * 6.28), new THREE.Vector3(sc, 1, sc));
    pads.setMatrixAt(n++, m);
    if (nf < 6 && n % 4 === 0) {
      m.compose(new THREE.Vector3(x, WATER_Y + 0.09, z), q, new THREE.Vector3(1, 1, 1));
      flowers.setMatrixAt(nf++, m);
    }
  }
  flowers.count = nf;
  group.add(pads, flowers);
  return group;
}
