// What a painted pixel looks like it is made of, from its colour alone: water, leaves (grass, bushes, trees), soil,
// stone, or something else (roofs, wood, cloth). Rough on purpose: it picks how a click answers (a splash, leaves,
// dust), not anything that matters. Pure.

export type Material = "water" | "leaves" | "soil" | "stone" | "other";

export function materialOf(r: number, g: number, b: number): Material {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const saturation = max === 0 ? 0 : (max - min) / max;
  const value = max / 255;
  if (saturation < 0.18) return "stone";
  const hue = hueOf(r, g, b, max, min);
  if (hue >= 165 && hue < 250) return "water";
  if (hue >= 45 && hue < 165) return "leaves";
  if (hue >= 20 && hue < 45 && saturation > 0.45 && value > 0.6) return "soil";
  return "other";
}

function hueOf(r: number, g: number, b: number, max: number, min: number): number {
  const d = max - min;
  if (d === 0) return 0;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}
