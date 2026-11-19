import * as THREE from "three";
import { Reflector } from "three/examples/jsm/objects/Reflector.js";
import { LAKES, type IslandWaters } from "./islandTerrain";

/** One small, throttled lake reflection. It never owns terrain or water levels. */
export function createPeakWater(waters: IslandWaters, renderer: THREE.WebGLRenderer, scene: THREE.Scene) {
  const reflector = new Reflector(new THREE.PlaneGeometry(1, 1), {
    textureWidth: 512, textureHeight: 512, multisample: 0, clipBias: 0.003,
  });
  reflector.rotation.x = -Math.PI / 2;
  const shader = reflector.material as THREE.ShaderMaterial;
  const textureMatrix = shader.uniforms.textureMatrix.value as THREE.Matrix4;
  const projected = new THREE.Matrix4(), inverse = new THREE.Matrix4();
  const lakes = LAKES.map(lake => ({ lake, mesh: waters.children.find(child => child.name === lake.id) as THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial> }));
  let elapsed = 0, selected = "", disposed = false;
  const hidden: THREE.Object3D[] = [], renderGroup = new THREE.Group();
  return {
    update(dt: number, camera: THREE.Camera) {
      if (disposed) return;
      elapsed += dt;
      let nearest: typeof lakes[number] | undefined, best = Infinity;
      for (const item of lakes) {
        const { lake } = item;
        const distance = Math.hypot(camera.position.x - lake.x, camera.position.z - lake.z) - lake.r;
        if (distance < best && camera.position.y > lake.y + 0.15 && camera.position.y < lake.y + 100) {
          nearest = item; best = distance;
        }
      }
      if (!nearest || best > 140) {
        lakes.forEach(({ mesh }) => { mesh.material.uniforms.uReflect.value = 0; });
        selected = ""; return;
      }
      if (elapsed < 0.12 && selected === nearest.lake.id) return;
      elapsed = 0; selected = nearest.lake.id;
      reflector.position.set(0, nearest.lake.y, 0); reflector.updateMatrixWorld(true);
      scene.updateMatrixWorld(); camera.updateMatrixWorld();
      hidden.length = 0;
      scene.traverse(object => {
        if (object.visible && (object === waters || object.name === "Island near/far curved grass" || object.name === "interior")) {
          hidden.push(object); object.visible = false;
        }
      });
      try {
        reflector.onBeforeRender(renderer, scene, camera, reflector.geometry, shader, renderGroup);
        // Reflector's matrix addresses its own mesh; water uses world-space positions.
        projected.copy(textureMatrix).multiply(inverse.copy(reflector.matrixWorld).invert());
        lakes.forEach(({ mesh }) => { mesh.material.uniforms.uReflect.value = 0; });
        nearest.mesh.material.uniforms.uReflection.value = reflector.getRenderTarget().texture;
        nearest.mesh.material.uniforms.uReflectMatrix.value.copy(projected);
        nearest.mesh.material.uniforms.uReflect.value = 1;
      } finally { hidden.forEach(object => { object.visible = true; }); }
    },
    dispose() {
      if (disposed) return; disposed = true;
      lakes.forEach(({ mesh }) => { mesh.material.uniforms.uReflect.value = 0; });
      reflector.geometry.dispose(); reflector.dispose();
    },
  };
}
