// Light on the pixel village, worked out for every art pixel from the way it faces (a port of @heybro/engine/pixi
// light.ts): the sky (ambient, and the sun or the moon from a direction, with cloud shadows drifting over), up to 32
// point lights, the morning mist, then the sky's grade over the whole picture (exposure, saturation, haze, tinted
// shadows and highlights, a vignette). uTexture is the village as painted, at the screen's pixels; uNormals the same
// with every sprite's picture swapped for its normal map. The uniforms are set by index, in this order.

#version 460 core
#include <flutter/runtime_effect.glsl>

precision highp float;

uniform vec2 uSize;
uniform vec2 uWorldSize;
uniform vec2 uColorSize;
uniform vec3 uAmbient;
uniform vec3 uSunDir;
uniform vec3 uSun;
uniform vec4 uMist;
uniform float uClouds;
// exposure, saturation, lift, vignette
uniform vec4 uGrade;
uniform vec3 uShadowTint;
uniform vec3 uHighlightTint;
uniform float uTime;
uniform float uLightCount;
uniform vec4 uLightPos[32];
uniform vec4 uLightColor[32];

uniform sampler2D uTexture;
uniform sampler2D uNormals;

out vec4 fragColor;

// Lamps add up, but never past this: a crowd of lanterns lights a place, it does not bleach it.
const float LAMP_MAX = 1.1;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}

float luma(vec3 c) {
  return dot(c, vec3(0.299, 0.587, 0.114));
}

void main() {
  vec2 uv = FlutterFragCoord().xy / uSize;
  // The painted pixel this is, at its centre: the picture stays crisp.
  vec4 color = texture(uTexture, (floor(uv * uColorSize) + 0.5) / uColorSize);
  // The art pixel this is, in the world: the light is worked out per art pixel, so it stays on the grid.
  vec2 pos = floor(uv * uWorldSize);
  vec3 n = normalize(texture(uNormals, (pos + 0.5) / uWorldSize).xyz * 2.0 - 1.0);

  // The sun, dimmed where the shadow of a cloud drifts over.
  float cloud = noise(pos * 0.011 + vec2(uTime * 0.018, uTime * 0.007)) * 0.7 + noise(pos * 0.027 - vec2(uTime * 0.01, 0.0)) * 0.3;
  float shade = 1.0 - uClouds * smoothstep(0.42, 0.68, cloud);
  vec3 sky = uAmbient + uSun * shade * max(dot(n, uSunDir), 0.0);

  vec3 lamps = vec3(0.0);
  for (int i = 0; i < 32; i++) {
    if (float(i) >= uLightCount) break;
    vec4 at = uLightPos[i];
    vec3 to = vec3(at.xy - pos, at.z);
    float reach = clamp(1.0 - length(to.xy) / at.w, 0.0, 1.0);
    lamps += uLightColor[i].rgb * reach * reach * max(dot(n, normalize(to)), 0.0);
  }
  float bright = max(max(lamps.r, lamps.g), lamps.b);
  if (bright > LAMP_MAX) lamps *= LAMP_MAX / bright;

  vec3 rgb = color.a > 0.0 ? color.rgb / color.a : vec3(0.0);
  rgb *= sky + lamps;

  // Mist drifts across.
  if (uMist.a > 0.0) {
    float thick = noise(pos * vec2(0.022, 0.045) + vec2(uTime * 0.35, 0.0)) * 0.65 + noise(pos * 0.07 - vec2(uTime * 0.2, uTime * 0.05)) * 0.35;
    rgb = mix(rgb, uMist.rgb, clamp(thick * uMist.a * 1.4, 0.0, 1.0));
  }

  // The grade: exposure, saturation, the colours the darks and the lights lean to, the haze, the vignette.
  rgb *= uGrade.x;
  float l = luma(rgb);
  rgb = mix(vec3(l), rgb, uGrade.y);
  rgb += uShadowTint * (1.0 - smoothstep(0.0, 0.6, l)) + uHighlightTint * smoothstep(0.4, 1.0, l);
  rgb = uGrade.z + rgb * (1.0 - uGrade.z);
  vec2 off = (pos + 0.5) / uWorldSize - 0.5;
  rgb *= 1.0 - uGrade.w * smoothstep(0.3, 0.75, length(off * vec2(1.0, 0.8)));

  fragColor = vec4(clamp(rgb, 0.0, 1.0) * color.a, color.a);
}
