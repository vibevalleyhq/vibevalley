import { execFileSync } from "node:child_process";
import { existsSync, renameSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { applyLocalGitReleaseActions } from "./bump.ts";
import { channelBundleName, packageArchitecture } from "./package-platform.ts";
import {
  bumpVersion,
  channelOfVersion,
  formatVersion,
  normalizeChannel,
  parseVersion,
  readRootVersion,
  resolveExplicitIncrement,
  scriptArgs,
  writeRootVersion,
  type ReleaseChannelName,
} from "./version.ts";

export function localUpdateFeedUrl(outDir: string): string {
  return pathToFileURL(join(outDir, "release.json")).href;
}

export function resolvePackageOptions(options: {
  channel: ReleaseChannelName;
  targetVersion: string;
  outDir: string;
  outArg?: string | undefined;
  noDmg: boolean;
  noZip: boolean;
  noLocalFeed: boolean;
  verify: boolean;
  skipVerify: boolean;
  skipBuild: boolean;
  sign?: string | undefined;
  notaryProfile?: string | undefined;
}): {
  profile: "alpha" | "release";
  fast: boolean;
  runVerify: boolean;
  makeDmg: boolean;
  makeZip: boolean;
  localFeed: string | undefined;
  packageArgs: string[];
} {
  const profile = options.channel === "alpha" ? "alpha" : "release";
  const fast = options.channel === "alpha";
  const runVerify = options.channel === "alpha" ? options.verify && !options.skipVerify : !options.skipVerify;
  const makeDmg = !options.noDmg;
  const makeZip = !options.noZip;
  const localFeed = options.channel === "alpha" && !options.noLocalFeed ? localUpdateFeedUrl(options.outDir) : undefined;
  const packageArgs = [
    "scripts/release/package.ts",
    "--version",
    options.targetVersion,
    "--profile",
    profile,
    ...(fast ? ["--fast"] : []),
    ...(options.skipBuild ? ["--skip-build"] : []),
    ...(makeDmg ? [] : ["--no-dmg"]),
    ...(makeZip ? [] : ["--no-zip"]),
    ...(options.outArg ? ["--out", options.outArg] : []),
    ...(options.sign ? ["--sign", options.sign] : []),
    ...(options.notaryProfile ? ["--notary-profile", options.notaryProfile] : []),
    ...(localFeed ? ["--update-feed", localFeed] : []),
  ];
  return { profile, fast, runVerify, makeDmg, makeZip, localFeed, packageArgs };
}

function installAppBundle(sourceApp: string, bundleName: string): string {
  const targetApp = join("/Applications", `${bundleName}.app`);
  const stagingApp = join("/Applications", `.${bundleName}-install-${process.pid}.app`);
  rmSync(stagingApp, { recursive: true, force: true });
  try {
    execFileSync("/usr/bin/ditto", [sourceApp, stagingApp], { stdio: "inherit" });
    rmSync(targetApp, { recursive: true, force: true });
    renameSync(stagingApp, targetApp);
  } catch (error) {
    rmSync(stagingApp, { recursive: true, force: true });
    throw error;
  }
  return targetApp;
}

function formatSizeMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function printArtifactSummary(outDir: string, version: string, makeDmg: boolean, makeZip: boolean): void {
  const arch = packageArchitecture(process.arch);
  const bundleName = channelBundleName(version);
  const stem = `VibeValley-${version}-${arch}`;
  const candidates = [
    join(outDir, `${bundleName}.app`),
    ...(makeDmg ? [join(outDir, `${stem}.dmg`)] : []),
    ...(makeZip ? [join(outDir, `${stem}.zip`), join(outDir, "release.json")] : []),
  ];
  console.log("\nBuild artifacts:");
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    const stat = statSync(file);
    const size = stat.isFile() ? ` (${formatSizeMb(stat.size)})` : "";
    console.log(`  ${file}${size}`);
  }
}

if (import.meta.main) {
  const root = resolve(import.meta.dirname, "../..");
  const { values, positionals } = parseArgs({
    args: scriptArgs(),
    allowPositionals: true,
    options: {
      bump: { type: "boolean", default: false },
      patch: { type: "boolean", default: false },
      minor: { type: "boolean", default: false },
      major: { type: "boolean", default: false },
      set: { type: "string" },
      version: { type: "string" },
      "no-dmg": { type: "boolean", default: false },
      zip: { type: "boolean", default: false },
      "no-zip": { type: "boolean", default: false },
      "no-local-feed": { type: "boolean", default: false },
      install: { type: "boolean", default: false },
      verify: { type: "boolean", default: false },
      "skip-verify": { type: "boolean", default: false },
      "skip-build": { type: "boolean", default: false },
      out: { type: "string" },
      sign: { type: "string" },
      "notary-profile": { type: "string" },
      commit: { type: "boolean", default: false },
      tag: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
    },
  });

  const rawChannel = positionals[0];
  if (!rawChannel) {
    throw new Error(
      "Usage: vp run build:<alpha|beta|release> [-- --bump] [--patch|--minor|--major] [--set <ver>] [--version <ver>] [--install] [--no-local-feed] [--commit] [--tag] [--dry-run]",
    );
  }
  const channel: ReleaseChannelName | undefined = normalizeChannel(rawChannel);
  if (!channel) {
    throw new Error(`Unknown build channel "${rawChannel}". Expected alpha, beta, or release.`);
  }

  if (values.zip && values["no-zip"]) throw new Error("Cannot pass both --zip and --no-zip");
  if (values.verify && values["skip-verify"]) throw new Error("Cannot pass both --verify and --skip-verify");

  const explicitIncrement = resolveExplicitIncrement(values);
  if (values.set !== undefined && (values.bump || explicitIncrement !== null || values.version !== undefined)) {
    throw new Error("--set cannot be combined with --bump, --patch/--minor/--major, or --version");
  }
  if (values.version !== undefined && (values.bump || explicitIncrement !== null)) {
    throw new Error("--version cannot be combined with --bump, --patch, --minor, or --major");
  }

  const current = readRootVersion(root) ?? "0.0.0";
  let targetVersion: string;
  let mutatesPackageJson = false;

  if (values.version !== undefined) {
    const parsed = parseVersion(values.version);
    if (!parsed) throw new Error(`Invalid --version "${values.version}".`);
    const normalized = formatVersion(parsed);
    if (channelOfVersion(normalized) !== channel) {
      throw new Error(`Version "${normalized}" does not belong to channel "${channel}".`);
    }
    targetVersion = normalized;
  } else if (values.set !== undefined) {
    const parsed = parseVersion(values.set);
    if (!parsed) throw new Error(`Invalid --set version "${values.set}".`);
    const normalized = formatVersion(parsed);
    if (channelOfVersion(normalized) !== channel) {
      throw new Error(`Version "${normalized}" does not belong to channel "${channel}".`);
    }
    targetVersion = normalized;
    mutatesPackageJson = true;
  } else if (values.bump || explicitIncrement !== null) {
    targetVersion = bumpVersion(current, channel, explicitIncrement ?? "auto");
    mutatesPackageJson = true;
  } else {
    if (channelOfVersion(current) !== channel) {
      throw new Error(
        `Current version ${current} is not a ${channel} version. Fix: pass --bump (e.g. vp run build:${channel} -- --bump) or run vp run bump -- ${channel} first.`,
      );
    }
    targetVersion = current;
  }

  const outDir = resolve(root, values.out ?? "apps/mac/dist");
  const { profile, fast, runVerify, makeDmg, makeZip, localFeed, packageArgs } = resolvePackageOptions({
    channel,
    targetVersion,
    outDir,
    outArg: values.out,
    noDmg: values["no-dmg"],
    noZip: values["no-zip"],
    noLocalFeed: values["no-local-feed"],
    verify: values.verify,
    skipVerify: values["skip-verify"],
    skipBuild: values["skip-build"],
    sign: values.sign,
    notaryProfile: values["notary-profile"],
  });
  const bundleName = channelBundleName(targetVersion);
  const builtApp = join(outDir, `${bundleName}.app`);

  console.log(
    [
      `channel=${channel}`,
      `version=${mutatesPackageJson ? `${current} -> ${targetVersion}` : targetVersion}`,
      `profile=${profile}`,
      `fast=${fast}`,
      `verify=${runVerify}`,
      `dmg=${makeDmg}`,
      `zip=${makeZip}`,
    ].join("  "),
  );

  if (values["dry-run"]) {
    if (runVerify) console.log("[dry-run] make verify");
    if (mutatesPackageJson) console.log(`[dry-run] write package.json version=${targetVersion}`);
    console.log(`[dry-run] vpx ${packageArgs.join(" ")}`);
    if (values.install) console.log(`[dry-run] install ${builtApp} -> /Applications/${bundleName}.app`);
    if (values.commit) console.log(`[dry-run] git commit --only package.json -m "Bump version to ${targetVersion}"`);
    if (values.tag) console.log(`[dry-run] git tag v${targetVersion} (local only)`);
    process.exit(0);
  }

  if (runVerify) {
    execFileSync("make", ["verify"], { cwd: root, stdio: "inherit" });
  }
  if (mutatesPackageJson) {
    writeRootVersion(root, targetVersion);
  }
  execFileSync("vpx", packageArgs, { cwd: root, stdio: "inherit" });
  if (values.commit || values.tag) {
    applyLocalGitReleaseActions(root, targetVersion, { commit: values.commit, tag: values.tag });
  }
  printArtifactSummary(outDir, targetVersion, makeDmg, makeZip);
  if (values.install) {
    const installedApp = installAppBundle(builtApp, bundleName);
    console.log(`\nInstalled ${installedApp}`);
    if (channel === "alpha" && localFeed) {
      console.log('Tip: Next time, run `vp run build:alpha -- --bump` and click "检查更新" inside VibeValley-Alpha to self-update locally.');
    }
  }
}
