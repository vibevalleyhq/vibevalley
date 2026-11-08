import catalog from "./images.generated.json";
import type { Scene } from "./scene";

export const titleArt: Readonly<Record<string, string>> = catalog.title;
export const backgrounds: Readonly<Record<Scene, string>> = catalog.backgrounds;

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
