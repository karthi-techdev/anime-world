import * as THREE from "three";

/**
 * Contrast Adaptive Sharpening (CAS) shader:
 * Applies a clean, artifact-free 20% sharpness boost (sharpness: 0.20)
 * to enhance texture detail, foliage, character edges, and geometry clarity
 * while limiting overshoot to eliminate ringing and haloing.
 */
export const SharpenShader = {
  name: "SharpenShader",
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    resolution: { value: new THREE.Vector2(1 / 1920, 1 / 1080) },
    sharpness: { value: 0.20 }, // 20% sharpening boost
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec2 resolution;
    uniform float sharpness;
    varying vec2 vUv;

    void main() {
      // 5-tap cross neighborhood (center + 4 cardinal directions)
      vec4 centerTex = texture2D(tDiffuse, vUv);
      vec3 c = centerTex.rgb;
      vec3 a = texture2D(tDiffuse, vUv + vec2(0.0, -resolution.y)).rgb;
      vec3 b = texture2D(tDiffuse, vUv + vec2(-resolution.x, 0.0)).rgb;
      vec3 d = texture2D(tDiffuse, vUv + vec2(resolution.x, 0.0)).rgb;
      vec3 e = texture2D(tDiffuse, vUv + vec2(0.0, resolution.y)).rgb;

      // Local contrast bounds to eliminate haloing
      vec3 minCol = min(c, min(min(a, b), min(d, e)));
      vec3 maxCol = max(c, max(max(a, b), max(d, e)));

      // Laplacian high-pass edge operator
      vec3 laplacian = 4.0 * c - (a + b + d + e);

      // Apply 20% sharpening
      vec3 sharpened = c + laplacian * sharpness;

      // Contrast-adaptive clamping prevents unnatural ringing on sharp UI / high contrast borders
      vec3 clamped = clamp(sharpened, minCol - 0.05 * sharpness, maxCol + 0.05 * sharpness);

      gl_FragColor = vec4(clamp(clamped, 0.0, 1.0), centerTex.a);
    }
  `,
};
