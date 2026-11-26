import catalog from "./images.generated.json";
import type { Scene } from "./scene";

export interface HeroArt {
  src: string;
  srcset: string;
  portraitSrcset: string;
}

export const heroWideSizes = "(min-aspect-ratio: 16/9) 106vw, 189vh";
export const heroPortraitSizes = "(max-aspect-ratio: 9/16) 60vh, 106vw";
export const backgrounds: Readonly<Record<Scene, HeroArt>> = catalog.backgrounds;

export interface Screenshot {
  src: string;
  srcset: string;
  width: number;
  height: number;
}
const shots: Readonly<Record<string, Screenshot | undefined>> = catalog.shots;
export function screenshotOf(name: string): Screenshot {
  const shot = shots[name];
  if (!shot) throw new Error(`Missing website screenshot: ${name}`);
  return shot;
}
