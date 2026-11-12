import { z } from "zod";

import type { UpdateManual } from "@vibevalley/protocol/host";

export const Build = z.object({
  /** process.arch: arm64 or x64. */
  arch: z.string(),
  /** The zip of the .app, beside release.json. */
  file: z.string(),
  size: z.number(),
  /** Hex. */
  sha512: z.string(),
});
export type Build = z.infer<typeof Build>;

export const Release = z.object({
  version: z.string(),
  /** One line a change, the merged pull requests' titles. */
  notes: z.array(z.string()),
  /** The baseline hash its server makes a database from (apps/server src/infra/baseline.ts). */
  schema: z.string(),
  /** The release's page, to download it by hand. */
  page: z.string(),
  builds: z.array(Build),
});
export type Release = z.infer<typeof Release>;

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

/** A release, a beta or an alpha. */
export type Stage = "stable" | "beta" | "alpha";

/** The release, beta or alpha a version is; undefined for one that is not a version. */
export function stageOf(v: string): Stage | undefined {
  const m = versionPattern.exec(v);
  return m ? (m[4] === "alpha" ? "alpha" : m[4] === "beta" ? "beta" : "stable") : undefined;
}

/** One of GitHub's releases as its list gives it, the fields read here. */
export const ListedRelease = z.object({
  tag_name: z.string(),
  draft: z.boolean(),
  assets: z.array(z.object({ name: z.string(), browser_download_url: z.string() })),
});
export type ListedRelease = z.infer<typeof ListedRelease>;

/** The release.json of the latest release of a stage, from GitHub's list of releases: each channel's app updates only within its own (channel.ts). */
export function manifestFor(list: readonly ListedRelease[], stage: Stage): string | undefined {
  let best: { version: string; url: string } | undefined;
  for (const r of list) {
    const version = r.tag_name.replace(/^v/u, "");
    const url = r.assets.find((a) => a.name === "release.json")?.browser_download_url;
    if (r.draft || stageOf(version) !== stage || url === undefined) continue;
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
