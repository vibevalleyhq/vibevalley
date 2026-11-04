// release.json is written by scripts/package.ts beside the release's files.

import { Schema } from "effect";

import type { UpdateChannel, UpdateManual } from "@vibevalley/protocol/host";

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
  /** The baseline hash its server makes a database from (apps/server src/infra/baseline.ts). */
  schema: Schema.String,
  /** The release's page, to download it by hand. */
  page: Schema.String,
  builds: Schema.Array(Build),
});
export type Release = typeof Release.Type;

/** x.y.z, or a prerelease of it: x.y.z-alpha.n, x.y.z-beta.n (the tag without its v; scripts/release.ts makes them). */
const versionPattern = /^(\d+)\.(\d+)\.(\d+)(?:-(alpha|beta)\.(\d+))?$/u;

/** A version's place in the order: its numbers, then its stage (alpha before beta before the release), then n. */
function rankOf(v: string): number[] | undefined {
  const m = versionPattern.exec(v);
  if (!m) return undefined;
  const stage = m[4] === "alpha" ? 0 : m[4] === "beta" ? 1 : 2;
  return [Number(m[1]), Number(m[2]), Number(m[3]), stage, Number(m[5] ?? 0)];
}

export const isVersion = (v: string) => versionPattern.test(v);

/** a is a later version than b: 0.4.0-alpha.2 < 0.4.0-beta.1 < 0.4.0 < 0.4.1; one that is neither is never later. */
export function newer(a: string, b: string): boolean {
  const x = rankOf(a);
  const y = rankOf(b);
  if (!x || !y) return false;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
}

/** The release, beta or alpha a version is; undefined for one that is not a version. */
export function stageOf(v: string): UpdateChannel | undefined {
  const m = versionPattern.exec(v);
  return m ? (m[4] === "alpha" ? "alpha" : m[4] === "beta" ? "beta" : "stable") : undefined;
}

/** What a channel takes: alpha takes betas and releases too, beta takes releases too. */
const takes: Record<UpdateChannel, readonly UpdateChannel[]> = { stable: ["stable"], beta: ["stable", "beta"], alpha: ["stable", "beta", "alpha"] };

/** One of GitHub's releases as its list gives it, the fields read here. */
export const ListedRelease = Schema.Struct({
  tag_name: Schema.String,
  draft: Schema.Boolean,
  assets: Schema.Array(Schema.Struct({ name: Schema.String, browser_download_url: Schema.String })),
});
export type ListedRelease = typeof ListedRelease.Type;

/** The release.json of the latest release a channel takes, from GitHub's list of releases; drafts are not anyone's yet. */
export function manifestFor(list: readonly ListedRelease[], channel: UpdateChannel): string | undefined {
  let best: { version: string; url: string } | undefined;
  for (const r of list) {
    const version = r.tag_name.replace(/^v/u, "");
    const stage = stageOf(version);
    const url = r.assets.find((a) => a.name === "release.json")?.browser_download_url;
    if (r.draft || stage === undefined || !takes[channel].includes(stage) || url === undefined) continue;
    if (best === undefined || newer(version, best.version)) best = { version, url };
  }
  return best?.url;
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
