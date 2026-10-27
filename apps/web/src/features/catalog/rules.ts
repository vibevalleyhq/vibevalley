// 图鉴's shelves: every drawing in sprites.json on a shelf by its name, a
// helper's by animal and outfit; which ones are a walk's frames; how one is drawn again.

import { catalogWording } from "./words";
import { appWording } from "../../base/words";
import { OutfitValues, SpeciesValues } from "@vibevalley/protocol";
import { outfitLabel, speciesLabel } from "../../ui/cast";

export interface Picture {
  readonly name: string;
  /** Art pixels. */
  readonly w: number;
  readonly h: number;
  readonly ax: number;
  readonly ay: number;
  readonly hx?: number;
  readonly hy?: number;
  /** From the repository's root. */
  readonly sheet?: string;
}

/** The manifest in art pixels: its sizes over the map's density against the level's width (384). */
export function picturesOf(manifest: Record<string, Record<string, unknown>>): Picture[] {
  const density = (manifest.map?.w as number) / 384;
  const art = (v: unknown) => (typeof v === "number" ? v / density : undefined);
  return Object.entries(manifest).map(([name, m]) => ({
    name,
    w: art(m.w)!,
    h: art(m.h)!,
    ax: art(m.ax)!,
    ay: art(m.ay)!,
    ...(art(m.hx) !== undefined ? { hx: art(m.hx) } : {}),
    ...(art(m.hy) !== undefined ? { hy: art(m.hy) } : {}),
    ...(typeof m.sheet === "string" ? { sheet: m.sheet } : {}),
  }));
}

const isHelper = (name: string) => SpeciesValues.some((s) => name.startsWith(`${s}-`));

export interface Shelf {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  readonly match: (name: string) => boolean;
}

export const shelves: readonly Shelf[] = [
  { id: "helpers", label: catalogWording().shelf.helpers.label, hint: catalogWording().shelf.helpers.hint, match: isHelper },
  { id: "orchestrator", label: appWording().orchestrator, hint: catalogWording().shelf.orchestrator.hint, match: (n) => n.startsWith("manager-") },
  { id: "dog", label: catalogWording().shelf.dog.label, hint: catalogWording().shelf.dog.hint, match: (n) => n.startsWith("dog-") },
  { id: "plots", label: catalogWording().shelf.plots.label, hint: catalogWording().shelf.plots.hint, match: (n) => n.startsWith("plot-") },
  {
    id: "yard",
    label: catalogWording().shelf.yard.label,
    hint: catalogWording().shelf.yard.hint,
    match: (n) => n === "map" || n === "mailbox" || /^(prop-|fg-|critter-)/.test(n),
  },
  { id: "map", label: catalogWording().shelf.map.label, hint: catalogWording().shelf.map.hint, match: (n) => /^(island|map)-/.test(n) },
  { id: "machines", label: catalogWording().shelf.machines.label, hint: catalogWording().shelf.machines.hint, match: (n) => n.startsWith("machine-") },
  { id: "icons", label: catalogWording().shelf.icons.label, hint: catalogWording().shelf.icons.hint, match: (n) => n.startsWith("icon-") },
  { id: "acts", label: catalogWording().shelf.acts.label, hint: catalogWording().shelf.acts.hint, match: (n) => n.startsWith("act-") },
  {
    id: "medals",
    label: catalogWording().shelf.medals.label,
    hint: catalogWording().shelf.medals.hint,
    match: (n) => /^(medal|emblem|stamp|coins|banner)-/.test(n),
  },
  { id: "logos", label: "Logo", hint: catalogWording().shelf.logos.hint, match: (n) => /^(logo|connector|app)-/.test(n) },
  { id: "langs", label: catalogWording().shelf.langs.label, hint: catalogWording().shelf.langs.hint, match: (n) => n.startsWith("lang-") },
  { id: "ui", label: catalogWording().shelf.ui.label, hint: catalogWording().shelf.ui.hint, match: (n) => /^(button|energy|day)-/.test(n) },
  { id: "other", label: catalogWording().shelf.other.label, hint: catalogWording().shelf.other.hint, match: () => true },
];

export const shelfOf = (name: string) => shelves.find((s) => s.match(name))!.id;

/** Case-insensitive, runs of digits by their value. */
export function naturalCompare(a: string, b: string): number {
  const parts = (s: string) => s.toLowerCase().match(/\d+|\D+/g) ?? [];
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < pa.length && i < pb.length; i++) {
    const x = pa[i]!;
    const y = pb[i]!;
    const c = /^\d+$/.test(x) && /^\d+$/.test(y) ? Number(x) - Number(y) : x < y ? -1 : x > y ? 1 : 0;
    if (c !== 0) return c;
  }
  return pa.length - pb.length || (a < b ? -1 : a > b ? 1 : 0);
}

export interface Group {
  readonly key: string;
  readonly label: string;
  readonly pictures: readonly Picture[];
}

/** A shelf's pictures in natural order; the helpers' grouped by animal and outfit. */
export function groupsOf(shelf: string, pictures: readonly Picture[]): Group[] {
  const sorted = [...pictures].sort((a, b) => naturalCompare(a.name, b.name));
  if (shelf !== "helpers") return sorted.length === 0 ? [] : [{ key: shelf, label: "", pictures: sorted }];
  return SpeciesValues.flatMap((species) =>
    OutfitValues.flatMap((outfit) => {
      const list = sorted.filter((p) => p.name.startsWith(`${species}-${outfit}-`));
      return list.length > 0 ? [{ key: `${species}-${outfit}-`, label: `${speciesLabel[species]} · ${outfitLabel[outfit]}`, pictures: list }] : [];
    }),
  );
}

/** The frames a picture moves through, or undefined: the pixel walk has two steps around a attention frame (x-1, x, x-2, x). */
export function framesOf(name: string, has: (n: string) => boolean): string[] | undefined {
  const base = /^(.*)-(\d+)$/.exec(name)?.[1] ?? name;
  const numbered: string[] = [];
  for (let n = 1; has(`${base}-${n}`); n++) numbered.push(`${base}-${n}`);
  if (numbered.length < 2) return undefined;
  const frames = has(base) && numbered.length === 2 ? [numbered[0]!, base, numbered[1]!, base] : numbered;
  return frames.includes(name) ? frames : undefined;
}

/** The commands that draw its sheet again and cut it. */
export function remakeOf(p: Picture): { draw: string; cut: string } | undefined {
  if (!p.sheet) return undefined;
  const stem = p.sheet
    .split("/")
    .at(-1)!
    .replace(/\.png$/, "");
  return { draw: `design/pixel/gen.sh ${stem}`, cut: `python3 design/pixel/process.py ${stem}` };
}

/** By its name, its shelf, or its animal and outfit in words. */
export function pictureMatches(p: Picture, query: string) {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const shelf = shelves.find((s) => s.id === shelfOf(p.name))!;
  const species = SpeciesValues.find((s) => p.name.startsWith(`${s}-`));
  const outfit = species && OutfitValues.find((o) => p.name.startsWith(`${species}-${o}-`));
  return [p.name, shelf.label, species ? speciesLabel[species] : "", outfit ? outfitLabel[outfit] : ""].some((w) => w.toLowerCase().includes(q));
}
