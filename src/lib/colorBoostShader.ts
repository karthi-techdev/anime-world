/**
 * Color boost shader: increases saturation by 30%+ with rich anime vibrance and contrast.
 */
export const ColorBoostShader = {
  name: "ColorBoostShader",
  uniforms: {
    tDiffuse: { value: null },
    saturation: { value: 1.45 }, // Rich color saturation boost
    contrast: { value: 1.06 },
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
    uniform float saturation;
    uniform float contrast;
    varying vec2 vUv;
    void main() {
      vec4 tex = texture2D(tDiffuse, vUv);
      float luma = dot(tex.rgb, vec3(0.2126, 0.7152, 0.0722));
      vec3 col = mix(vec3(luma), tex.rgb, saturation);
      float maxC = max(col.r, max(col.g, col.b));
      float minC = min(col.r, min(col.g, col.b));
      col = mix(col, mix(vec3(luma), col, 1.15), 1.0 - (maxC - minC));
      col = (col - 0.5) * contrast + 0.5;
      gl_FragColor = vec4(clamp(col, 0.0, 1.0), tex.a);
    }
  `,
};
