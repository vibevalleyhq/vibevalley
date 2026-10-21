// The light from the sky at a time of day: the ambient light, the sun (by day) or the moon (by night) from a
// direction, cloud shadows drifting over, the morning mist, and the grade the whole picture gets: its exposure,
// saturation, the haze that lifts the blacks, and the colours its shadows and highlights lean to. Pure numbers for
// light.ts. The look aims at Eastward's: every time of day has a colour (bright and sunny, amber at dusk, a deep
// readable blue at night), shadows are tinted rather than grey, nothing goes black.

import { duskOf, sunOf } from "../clock";

export type Rgb = readonly [number, number, number];
export type Vec3 = readonly [number, number, number];

/** How the lit picture is graded, after the light. */
export interface Grade {
  readonly exposure: number;
  /** 1 as painted; more is more colourful. */
  readonly saturation: number;
  /** The haze: how far the blacks are lifted (0..1). */
  readonly lift: number;
  /** Added to the dark parts and to the bright parts: the colours they lean to. */
  readonly shadows: Rgb;
  readonly highlights: Rgb;
  /** How much the corners darken (0..1). */
  readonly vignette: number;
}

export interface Sky {
  /** Light everywhere, whatever a pixel faces. */
  readonly ambient: Rgb;
  /** Towards the sun or the moon: x right, y down the screen, z out of it; length 1. */
  readonly sunDir: Vec3;
  /** The sun's or the moon's light: its colour times its strength. */
  readonly sun: Rgb;
  /** How much of the sun the shadows of passing clouds take away (0: a clear sky). */
  readonly clouds: number;
  /** Mist over everything: its colour, and how thick (0: none). */
  readonly mist: { readonly color: Rgb; readonly amount: number };
  readonly grade: Grade;
  /** How dark it is: 0 by day, 1 at night. Lamps follow it. */
  readonly night: number;
}

const DAY_AMBIENT: Rgb = [0.62, 0.64, 0.68];
const DUSK_AMBIENT: Rgb = [0.66, 0.5, 0.46];
const NIGHT_AMBIENT: Rgb = [0.26, 0.32, 0.52];
const SUN: Rgb = [1, 0.96, 0.86];
const LOW_SUN: Rgb = [1, 0.62, 0.34];
const MOON: Rgb = [0.55, 0.68, 1];
/** The moon stands high, over the right of the picture. */
const MOON_DIR: Vec3 = normal([0.35, -0.55, 0.75]);
const MOONLIGHT = 0.3;
const MIST: Rgb = [0.9, 0.92, 0.94];

const DAY_GRADE: Grade = { exposure: 1.06, saturation: 1.18, lift: 0.04, shadows: [0.02, 0.06, 0.1], highlights: [0.05, 0.035, -0.01], vignette: 0.16 };
const DUSK_GRADE: Grade = { exposure: 1.06, saturation: 1.22, lift: 0.05, shadows: [0.14, 0.05, 0.02], highlights: [0.1, 0.04, -0.05], vignette: 0.22 };
const NIGHT_GRADE: Grade = { exposure: 1.08, saturation: 1.2, lift: 0.045, shadows: [0.01, 0.05, 0.14], highlights: [0.03, 0.05, 0.06], vignette: 0.3 };

/** How bright flat ground is at midday before the grade: as painted. */
const NOON = 1;

export function skyAt(tod: number): Sky {
  const day = sunOf(tod);
  const dusk = duskOf(tod);
  // From 6:00 to 18:00 the sun crosses from the left of the picture to the right, highest at noon, a little up the
  // screen (the light falls from the top, as painted).
  const crossed = clamp01((tod - 0.25) / 0.5);
  const sunDir = normal([-Math.cos(Math.PI * crossed), -0.5, 0.2 + 0.8 * Math.sin(Math.PI * crossed)]);
  const dayAmbient = mix(DAY_AMBIENT, DUSK_AMBIENT, dusk);
  // What the ambient leaves to reach NOON on flat ground, the sun gives; a low sun gives it at a slant.
  const gain = (NOON - average(dayAmbient)) / Math.max(sunDir[2], 0.3);
  const sunColor = scale(mix(SUN, LOW_SUN, dusk), gain);
  return {
    ambient: mix(NIGHT_AMBIENT, dayAmbient, day),
    sunDir: normal(mix(MOON_DIR, sunDir, day)),
    sun: mix(scale(MOON, MOONLIGHT), sunColor, day),
    clouds: 0.22 * day,
    // Mist lies in the early morning and lifts as the sun climbs.
    mist: { color: MIST, amount: 0.3 * bump(tod, 0.29, 0.07) },
    grade: mixGrade(NIGHT_GRADE, mixGrade(DAY_GRADE, DUSK_GRADE, dusk), day),
    night: 1 - day,
  };
}

/** How bright flat ground comes out under a sky before the grade (no lamps, no clouds): the ambient and the sun straight on. */
export const flatLight = (sky: Sky): Rgb => [
  sky.ambient[0] + sky.sun[0] * sky.sunDir[2],
  sky.ambient[1] + sky.sun[1] * sky.sunDir[2],
  sky.ambient[2] + sky.sun[2] * sky.sunDir[2],
];

function normal(v: Vec3): Vec3 {
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const mix = (a: Rgb, b: Rgb, k: number): Rgb => [lerp(a[0], b[0], k), lerp(a[1], b[1], k), lerp(a[2], b[2], k)];
const mixGrade = (a: Grade, b: Grade, k: number): Grade => ({
  exposure: lerp(a.exposure, b.exposure, k),
  saturation: lerp(a.saturation, b.saturation, k),
  lift: lerp(a.lift, b.lift, k),
  shadows: mix(a.shadows, b.shadows, k),
  highlights: mix(a.highlights, b.highlights, k),
  vignette: lerp(a.vignette, b.vignette, k),
});
const scale = (a: Rgb, k: number): Rgb => [a[0] * k, a[1] * k, a[2] * k];
const average = (a: Rgb) => (a[0] + a[1] + a[2]) / 3;
/** 1 at `at`, falling to 0 at `width` either side. */
const bump = (x: number, at: number, width: number) => Math.max(0, 1 - Math.abs(x - at) / width);
