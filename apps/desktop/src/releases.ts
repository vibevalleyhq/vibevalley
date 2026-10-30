// release.json is written by scripts/package.ts beside the release's files.

import { Schema } from "effect";

import type { UpdateManual } from "@vibevalley/protocol/host";

export const Build = Schema.Struct({
  /** process.arch: arm64 or x64. */
  arch: Schema.String,
  /** The zip of the .app, beside release.json. */
  file: Schema.String,
  size: Schema.Finite,
  /** Hex. */
  sha512: Schema.String,
});
export type Build = typeof Build.Type;

export const Release = Schema.Struct({
  version: Schema.String,
  /** One line a change, the merged pull requests' titles. */
  notes: Schema.Array(Schema.String),
  /** The baseline hash its server makes a database from (apps/server src/base/baseline.ts). */
  schema: Schema.String,
  /** The release's page, to download it by hand. */
  page: Schema.String,
  builds: Schema.Array(Build),
});
export type Release = typeof Release.Type;

const parts = (v: string) => /^(\d+)\.(\d+)\.(\d+)$/u.exec(v)?.slice(1).map(Number);

/** a is a later version than b; one that is not x.y.z is never later. */
export function newer(a: string, b: string): boolean {
  const x = parts(a);
  const y = parts(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
}

export const buildFor = (release: Release, arch: string) => release.builds.find((b) => b.arch === arch);

/** The .app the running executable is in: …/VibeValley.app/Contents/MacOS/VibeValley. */
export function bundleOf(exe: string): string | undefined {
  const at = exe.lastIndexOf(".app/Contents/MacOS/");
  return at < 0 ? undefined : exe.slice(0, at + ".app".length);
}

/** Why the app at bundle cannot be replaced where it is; undefined when it can. */
export function placeProblem(bundle: string, writable: boolean): UpdateManual | undefined {
  if (bundle.includes("/AppTranslocation/")) return "translocated";
  if (bundle.startsWith("/Volumes/")) return "diskImage";
  return writable ? undefined : "readOnly";
}

/** The farm's database was made from another baseline than the release's: its server would set it aside. No database
 * yet (no mark) loses nothing. */
export const startsNewFarm = (release: string, farm: string | undefined) => farm !== undefined && farm.trim() !== release;

export const plistVersion = (xml: string) => /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]*)<\/string>/u.exec(xml)?.[1];
