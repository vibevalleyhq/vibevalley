// Light on a pixel stage, worked out for every art pixel from the way it faces: the sky (ambient, and the sun or
// the moon from a direction, with cloud shadows drifting over), up to MAX_LIGHTS point lights (lamps, lanterns,
// fireflies, a flash), the morning mist, and then the sky's grade over the whole picture (exposure, saturation, haze,
// tinted shadows and highlights, a vignette). Two passes a frame: the world with every sprite's picture swapped for
// its normal map, into a texture the size of the world; then the world as painted, through a filter that lights it.
// The light is smooth, as in Eastward; it is still worked out per art pixel, so it stays on the grid.
//
// Normal maps come from the pictures (normals.ts); `normalTexture` makes one for a loaded texture. A sprite without
// one, and anything that is not a sprite (shapes, particles), is lit as the ground behind it.

import { type Container, defaultFilterVert, Filter, GlProgram, Rectangle, RenderTexture, Sprite, Texture, UniformGroup, ViewContainer } from "pixi.js";
import type { PixelStage } from "./index";
import { mirrorNormals, normalsOf, type NormalOptions } from "./normals";
import type { Sky } from "./sky";

export const MAX_LIGHTS = 32;

export interface PointLight {
  readonly x: number;
  readonly y: number;
  /** Height above what it lights, in art pixels: a low light grazes, a high one falls straight on. */
  readonly z: number;
  /** How far it reaches, in art pixels. */
  readonly radius: number;
  /** 0xRRGGBB. */
  readonly color: number;
  readonly intensity: number;
}

/** A sprite's normal map, and the one for drawing it mirrored. */
export interface Normals {
  readonly normal: Texture;
  readonly mirrored: Texture;
}

export interface Lighting {
  /** The light from now on: the sky, the point lights (the strongest MAX_LIGHTS of them), and the time, in seconds. */
  readonly set: (sky: Sky, lights: readonly PointLight[], time: number) => void;
  readonly destroy: () => void;
}

export interface LightingOptions {
  /** A texture's normal maps; undefined: the sprite is lit as the ground behind it. */
  readonly normalsOf: (texture: Texture) => Normals | undefined;
}

/** A loaded texture's picture as RGBA, its own pixels (at its resolution), read through a canvas: call once, when it loads. */
const isDrawable = (r: unknown): r is CanvasImageSource =>
  r instanceof HTMLImageElement || r instanceof HTMLCanvasElement || r instanceof ImageBitmap || r instanceof OffscreenCanvas || r instanceof HTMLVideoElement;

export function pixelsOf(texture: Texture): { readonly rgba: Uint8ClampedArray; readonly w: number; readonly h: number } | undefined {
  const res = texture.source.resolution;
  const w = Math.round(texture.frame.width * res);
  const h = Math.round(texture.frame.height * res);
  const resource: unknown = texture.source.resource;
  if (!isDrawable(resource) || w === 0 || h === 0) return undefined;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return undefined;
  ctx.drawImage(resource, Math.round(texture.frame.x * res), Math.round(texture.frame.y * res), w, h, 0, 0, w, h);
  return { rgba: ctx.getImageData(0, 0, w, h).data, w, h };
}

/** A texture of `source`'s pixels taken at `resolution`: as many pixels per art pixel as the picture it goes with. */
export function atResolution(texture: Texture, resolution: number): Texture {
  if (resolution === 1) return texture;
  texture.source.resolution = resolution;
  return new Texture({ source: texture.source });
}

/** The normal maps of a loaded texture's picture. */
export function normalTexture(texture: Texture, options: NormalOptions): Normals | undefined {
  const picture = pixelsOf(texture);
  if (!picture) return undefined;
  const { w, h } = picture;
  const normals = normalsOf(picture.rgba, w, h, options);
  const toTexture = (pixels: Uint8ClampedArray) => {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    c.getContext("2d")?.putImageData(new ImageData(new Uint8ClampedArray(pixels), w, h), 0, 0);
    // At the picture's own resolution, so a normal lands on the pixel it was made from.
    return atResolution(Texture.from(c), texture.source.resolution);
  };
  return { normal: toTexture(normals), mirrored: toTexture(mirrorNormals(normals)) };
}

/** A pixel picture made point by point: `alpha(dx, dy)` with dx, dy from the middle in -1..1, in one colour. */
function painted(w: number, h: number, color: number, alpha: (dx: number, dy: number) => number): Texture {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return Texture.EMPTY;
  const img = ctx.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      img.data.set(
        [
          (color >> 16) & 255,
          (color >> 8) & 255,
          color & 255,
          Math.round(255 * Math.max(0, Math.min(1, alpha(((x + 0.5) / w) * 2 - 1, ((y + 0.5) / h) * 2 - 1)))),
        ],
        i,
      );
    }
  }
  ctx.putImageData(img, 0, 0);
  return Texture.from(canvas);
}

/** A soft round glow, `radius` art pixels: for what shines by itself (a lamp's glass, a lantern, a firefly). Draw it added. */
export const glowTexture = (radius: number, color: number, strength = 0.55) =>
  painted(radius * 2, radius * 2, color, (dx, dy) => {
    const d = Math.hypot(dx, dy);
    return d < 1 ? strength * (1 - d) * (1 - d) : 0;
  });

/**
 * A shadow on the ground under something attention, `w` by `h`: an ellipse in two hard steps, like the rest of the
 * pixel art, darker in the middle. A soft edge would read as haze beside the feet, not as ground under them.
 */
export const shadowTexture = (w: number, h: number, color = 0x1f160c) =>
  painted(w, h, color, (dx, dy) => {
    const d = Math.hypot(dx, dy);
    return d < 0.6 ? 1 : d < 1 ? 0.55 : 0;
  });

/** Lights the stage's world from now on: its filters are this light's. */
export function pixelLighting(stage: PixelStage, { normalsOf }: LightingOptions): Lighting {
  const { app, world } = stage;
  const { w, h } = stage.view;
  const normals = RenderTexture.create({ width: w, height: h });

  const uniforms = new UniformGroup({
    uWorldSize: { value: new Float32Array([w, h]), type: "vec2<f32>" },
    uAmbient: { value: new Float32Array(3), type: "vec3<f32>" },
    uSunDir: { value: new Float32Array([0, 0, 1]), type: "vec3<f32>" },
    uSun: { value: new Float32Array(3), type: "vec3<f32>" },
    uMist: { value: new Float32Array(4), type: "vec4<f32>" },
    uClouds: { value: 0, type: "f32" },
    uGrade: { value: new Float32Array([1, 1, 0, 0]), type: "vec4<f32>" },
    uShadowTint: { value: new Float32Array(3), type: "vec3<f32>" },
    uHighlightTint: { value: new Float32Array(3), type: "vec3<f32>" },
    uTime: { value: 0, type: "f32" },
    uLightCount: { value: 0, type: "f32" },
    uLightPos: { value: new Float32Array(MAX_LIGHTS * 4), type: "vec4<f32>", size: MAX_LIGHTS },
    uLightColor: { value: new Float32Array(MAX_LIGHTS * 4), type: "vec4<f32>", size: MAX_LIGHTS },
  });
  const filter = new Filter({
    glProgram: GlProgram.from({ vertex: defaultFilterVert, fragment: FRAGMENT, name: "pixel-light-filter" }),
    resources: { lightUniforms: uniforms, uNormals: normals.source, uNormalsSampler: normals.source.style },
    // At the scene's resolution (a filter's own is 1 by default): pictures drawn denser keep their detail.
    resolution: "inherit",
  });
  // The whole world, empty corners too, in the world's own terms (it moves with the camera): whatever part of it is
  // in view is lit.
  world.filterArea = new Rectangle(0, 0, stage.size.w, stage.size.h);
  world.filters = [filter];

  // The normal pass: just before the frame is drawn, after everything has moved.
  const drawNormals = () => {
    const undo: (() => void)[] = [];
    const visit = (node: Container, mirrored: boolean) => {
      const flipped = node.scale.x < 0 ? !mirrored : mirrored;
      // Pixi gives null for a node that never had filters, whatever its type says.
      const filters: Container["filters"] | null = node.filters;
      if (filters !== null && filters.length > 0) {
        const kept = [...filters];
        node.filters = [];
        undo.push(() => (node.filters = kept));
      }
      if (node instanceof Sprite) {
        const found = normalsOf(node.texture);
        if (found) {
          const painted = node.texture;
          node.texture = flipped ? found.mirrored : found.normal;
          undo.push(() => (node.texture = painted));
        } else hide(node);
      } else if (node instanceof ViewContainer) hide(node);
      for (const child of node.children) visit(child, flipped);
    };
    const hide = (node: Container) => {
      if (!node.visible) return;
      node.visible = false;
      undo.push(() => (node.visible = true));
    };
    visit(world, false);
    app.renderer.render({ container: world, target: normals, clear: true, clearColor: [0.5, 0.5, 1, 1] });
    for (let i = undo.length - 1; i >= 0; i--) undo[i]?.();
  };
  // After the game's own updates (NORMAL, 0), before the frame is drawn (LOW, -25).
  app.ticker.add(drawNormals, undefined, -10);

  const u = uniforms.uniforms as {
    uAmbient: Float32Array;
    uSunDir: Float32Array;
    uSun: Float32Array;
    uMist: Float32Array;
    uClouds: number;
    uGrade: Float32Array;
    uShadowTint: Float32Array;
    uHighlightTint: Float32Array;
    uTime: number;
    uLightCount: number;
    uLightPos: Float32Array;
    uLightColor: Float32Array;
  };

  return {
    set: (sky, lights, time) => {
      u.uAmbient.set(sky.ambient);
      u.uSunDir.set(sky.sunDir);
      u.uSun.set(sky.sun);
      u.uMist.set([...sky.mist.color, sky.mist.amount]);
      u.uClouds = sky.clouds;
      const { grade } = sky;
      u.uGrade.set([grade.exposure, grade.saturation, grade.lift, grade.vignette]);
      u.uShadowTint.set(grade.shadows);
      u.uHighlightTint.set(grade.highlights);
      u.uTime = time;
      const shown = lights
        .filter((l) => l.intensity > 0.01 && l.radius > 0)
        .toSorted((a, b) => b.intensity * b.radius - a.intensity * a.radius)
        .slice(0, MAX_LIGHTS);
      // Lights are in the world; the filter works on the canvas, where the camera has moved the world.
      shown.forEach((l, i) => {
        u.uLightPos.set([l.x + world.x, l.y + world.y, l.z, l.radius], i * 4);
        u.uLightColor.set(
          [(((l.color >> 16) & 255) / 255) * l.intensity, (((l.color >> 8) & 255) / 255) * l.intensity, ((l.color & 255) / 255) * l.intensity, 0],
          i * 4,
        );
      });
      u.uLightCount = shown.length;
      uniforms.update();
    },
    destroy: () => {
      app.ticker.remove(drawNormals);
      world.filters = [];
      normals.destroy(true);
    },
  };
}

// GLSL ES 3.0 (WebGL 2): Pixi compiles a program as 3.0 only when its fragment says so.
const FRAGMENT = /* glsl */ `#version 300 es
precision highp float;

in vec2 vTextureCoord;
out vec4 finalColor;

uniform sampler2D uTexture;
uniform sampler2D uNormals;
uniform vec4 uInputSize;
uniform vec4 uOutputFrame;

uniform vec2 uWorldSize;
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
uniform vec4 uLightPos[${MAX_LIGHTS}];
uniform vec4 uLightColor[${MAX_LIGHTS}];

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
  vec4 color = texture(uTexture, vTextureCoord);
  // The art pixel this is, in the world.
  vec2 pos = floor(vTextureCoord * uInputSize.xy + uOutputFrame.xy);
  vec3 n = normalize(texture(uNormals, (pos + 0.5) / uWorldSize).xyz * 2.0 - 1.0);

  // The sun, dimmed where the shadow of a cloud drifts over.
  float cloud = noise(pos * 0.011 + vec2(uTime * 0.018, uTime * 0.007)) * 0.7 + noise(pos * 0.027 - vec2(uTime * 0.01, 0.0)) * 0.3;
  float shade = 1.0 - uClouds * smoothstep(0.42, 0.68, cloud);
  vec3 sky = uAmbient + uSun * shade * max(dot(n, uSunDir), 0.0);

  vec3 lamps = vec3(0.0);
  for (int i = 0; i < ${MAX_LIGHTS}; i++) {
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

  finalColor = vec4(clamp(rgb, 0.0, 1.0) * color.a, color.a);
}
`;
