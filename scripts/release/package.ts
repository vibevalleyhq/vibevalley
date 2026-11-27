import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

import { createStyledDmg } from "./dmg-layout.ts";
import { shouldPackageAsset } from "./package-assets.ts";
import {
  channelBundleId,
  channelBundleName,
  channelFullIconFile,
  channelIconFile,
  compileAppIconCatalogCached,
  dmgBackgroundFile,
  minimumMacOS,
  packageArchitecture,
  requireDeveloperId,
  verifyMacExecutable,
} from "./package-platform.ts";
import { readRootVersion, scriptArgs } from "./version.ts";

const root = resolve(import.meta.dirname, "../..");

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

export function renderInfoPlist(options: { bundleId: string; bundleName: string; version: string; updateFeed?: string | undefined }): string {
  const shortVersion = options.version.split("-")[0] ?? options.version;
  const updateFeed = options.updateFeed?.trim();
  const feedLine = updateFeed ? `<key>VibeValleyUpdateFeed</key><string>${escapeXml(updateFeed)}</string>\n` : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${escapeXml(options.bundleId)}</string>
<key>CFBundleName</key><string>${escapeXml(options.bundleName)}</string>
<key>CFBundleExecutable</key><string>vibevalley-mac</string>
<key>CFBundleIconFile</key><string>icon</string>
<key>CFBundleIconName</key><string>AppIcon</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>VibeValleyVersion</key><string>${escapeXml(options.version)}</string>
<key>CFBundleShortVersionString</key><string>${escapeXml(shortVersion)}</string>
<key>CFBundleVersion</key><string>${escapeXml(shortVersion)}</string>
<key>LSMinimumSystemVersion</key><string>${escapeXml(minimumMacOS)}</string>
<key>NSHighResolutionCapable</key><true/>
<key>NSMicrophoneUsageDescription</key><string>VibeValley uses the microphone for voice conversations.</string>
${feedLine}</dict></plist>
`;
}

const run = (command: string, args: string[], cwd = root, env?: NodeJS.ProcessEnv) =>
  execFileSync(command, args, { cwd, stdio: "inherit", env: env ? { ...process.env, ...env } : process.env });
const runAsync = (command: string, args: string[], cwd = root, env?: NodeJS.ProcessEnv): Promise<void> =>
  new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { cwd, stdio: "inherit", env: env ? { ...process.env, ...env } : process.env });
    child.on("error", rejectPromise);
    child.on("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`${command} ${args.join(" ")} failed (${signal ?? `exit ${code}`})`));
    });
  });

function latestMtimeMs(path: string): number {
  if (!existsSync(path)) return 0;
  const stat = statSync(path);
  if (!stat.isDirectory()) return stat.mtimeMs;
  let newest = stat.mtimeMs;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? latestMtimeMs(child) : statSync(child).mtimeMs);
  }
  return newest;
}

function needsSwiftBuild(pkgDir: string, binPath: string): boolean {
  if (!existsSync(binPath)) return true;
  const binMtime = statSync(binPath).mtimeMs;
  const newestSource = Math.max(
    latestMtimeMs(join(pkgDir, "Package.swift")),
    latestMtimeMs(join(pkgDir, "Package.resolved")),
    latestMtimeMs(join(pkgDir, "Sources")),
  );
  return newestSource > binMtime;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: scriptArgs(),
    options: {
      version: { type: "string" },
      out: { type: "string" },
      profile: { type: "string", default: "release" },
      fast: { type: "boolean", default: false },
      "skip-build": { type: "boolean", default: false },
      "no-dmg": { type: "boolean", default: false },
      "no-zip": { type: "boolean", default: false },
      sign: { type: "string" },
      "notary-profile": { type: "string" },
      "update-feed": { type: "string" },
    },
  });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  if (process.platform !== "darwin") throw new Error("package:mac requires macOS");
  let tag = "";
  try {
    tag = git("describe", "--tags", "--exact-match", "--match", "v*");
  } catch {
    /* An untagged local build has no release feed. */
  }
  const version = values.version ?? (tag.replace(/^v/u, "") || readRootVersion(root) || "0.0.0");
  if (!/^\d+\.\d+\.\d+(?:-(?:alpha|beta)\.\d+)?$/u.test(version)) throw new Error(`Invalid package version: ${version}`);
  const versionTag = `v${version}`;
  const tagged = git("tag", "--points-at", "HEAD", "--list", versionTag) === versionTag;
  const profile = values.profile;
  if (profile !== "release" && profile !== "alpha" && profile !== "debug") throw new Error("--profile must be release, alpha, or debug");
  const identity = values.sign ?? process.env.VIBEVALLEY_SIGN_IDENTITY ?? "-";
  const notary = values["notary-profile"] ?? process.env.VIBEVALLEY_NOTARY_PROFILE;
  if (notary && identity === "-") throw new Error("Notarization requires a Developer ID signing identity");
  if (notary && values["no-zip"]) throw new Error("--no-zip cannot be combined with --notary-profile");
  const out = resolve(root, values.out ?? "apps/mac/dist");
  const bundleName = channelBundleName(version);
  const bundleId = channelBundleId(version);
  const app = join(out, `${bundleName}.app`);
  const macos = join(app, "Contents/MacOS");
  const resources = join(app, "Contents/Resources");
  const target = resolve(root, process.env.CARGO_TARGET_DIR ?? "target", profile);
  const islandBin = join(root, "apps/island/.build/release/VibeValleyIsland");
  const shimBin = join(root, "apps/shim/.build/release/VibeValleyShim");
  const copyFast = (src: string, dst: string) => {
    const res = spawnSync("cp", ["-cR", src, dst], { stdio: "ignore" });
    if (res.status !== 0) cpSync(src, dst, { recursive: true });
  };
  if (!values["skip-build"]) {
    if (!values.fast) {
      run("vp", ["run", "mac:check"]);
    }
    // Release, alpha, and `debug` + `VIBEVALLEY_EMBED_UI=1` all compile and embed UI bytecode inside `apps/mac/build.rs`.
    const cargoProfileArgs = profile === "release" ? ["--release"] : profile === "alpha" ? ["--profile", "alpha"] : [];
    const cargoFeatureArgs = profile === "release" ? [] : ["--features", "vibevalley-mac/shot"];
    const cargoEnv = profile === "release" ? { LIBGHOSTTY_VT_SYS_OPTIMIZE: "ReleaseFast" } : profile === "debug" ? { VIBEVALLEY_EMBED_UI: "1" } : undefined;
    const buildTasks: Promise<void>[] = [
      runAsync("cargo", ["build", "--locked", ...cargoProfileArgs, "-p", "vibevalley-mac", "-p", "vibevalley-cli", ...cargoFeatureArgs], root, cargoEnv),
    ];
    if (!values.fast || needsSwiftBuild(join(root, "apps/island"), islandBin)) {
      buildTasks.push(runAsync("swift", ["build", "-c", "release", "--package-path", "apps/island"], root));
    }
    if (!values.fast || needsSwiftBuild(join(root, "apps/shim"), shimBin)) {
      buildTasks.push(runAsync("swift", ["build", "-c", "release", "--package-path", "apps/shim"], root));
    }
    await Promise.all(buildTasks);
  }
  const arch = packageArchitecture(process.arch);
  const icon = join(root, channelIconFile(version));
  const fullIcon = join(root, channelFullIconFile(version));
  const dmgBackground = join(root, dmgBackgroundFile);
  for (const file of [
    join(target, "vibevalley-mac"),
    join(target, "vibevalley"),
    join(root, "apps/island/.build/release/VibeValleyIsland"),
    join(root, "apps/shim/.build/release/VibeValleyShim"),
    icon,
    fullIcon,
    dmgBackground,
  ]) {
    if (!existsSync(file)) throw new Error(`Missing package input: ${file}. Build it before --skip-build`);
  }
  for (const binary of [
    join(target, "vibevalley-mac"),
    join(target, "vibevalley"),
    join(root, "apps/island/.build/release/VibeValleyIsland"),
    join(root, "apps/shim/.build/release/VibeValleyShim"),
  ]) {
    verifyMacExecutable(binary, arch);
  }
  mkdirSync(out, { recursive: true });
  rmSync(app, { recursive: true, force: true });
  mkdirSync(macos, { recursive: true });
  mkdirSync(resources, { recursive: true });
  copyFast(join(target, "vibevalley-mac"), join(macos, "vibevalley-mac"));
  copyFast(join(target, "vibevalley"), join(macos, "vibevalley"));
  copyFast(join(root, "apps/island/.build/release/VibeValleyIsland"), join(macos, "VibeValleyIsland"));
  copyFast(join(root, "apps/shim/.build/release/VibeValleyShim"), join(macos, "VibeValleyShim"));
  const assetsRoot = join(root, "assets");
  cpSync(assetsRoot, join(resources, "assets"), {
    recursive: true,
    dereference: true,
    filter: (src) => shouldPackageAsset(relative(assetsRoot, src)),
  });
  cpSync(icon, join(resources, "icon.icns"));
  compileAppIconCatalogCached(fullIcon, join(resources, "Assets.car"), join(target, "branding-cache"));
  const sign = (path: string, microphone = false) =>
    run("codesign", [
      "--force",
      "--sign",
      identity,
      ...(identity === "-"
        ? []
        : ["--options", "runtime", "--timestamp", ...(microphone ? ["--entitlements", join(root, "apps/mac/entitlements.plist")] : [])]),
      path,
    ]);
  for (const bin of ["vibevalley", "VibeValleyIsland", "VibeValleyShim", "vibevalley-mac"]) sign(join(macos, bin), bin === "vibevalley-mac");
  writeFileSync(
    join(app, "Contents/Info.plist"),
    renderInfoPlist({
      bundleId,
      bundleName,
      version,
      updateFeed: values["update-feed"],
    }),
  );
  sign(app, true);
  run("codesign", ["--verify", "--deep", "--strict", app]);
  if (identity !== "-") {
    const result = spawnSync("codesign", ["-dvvv", app], { encoding: "utf8" });
    if (result.status !== 0) throw new Error(`Cannot inspect signed bundle: ${result.stderr}`);
    requireDeveloperId(result.stderr);
  }
  const name = `VibeValley-${version}-${arch}`;
  const zip = join(out, `${name}.zip`);
  const makeZip = () => {
    rmSync(zip, { force: true });
    run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", app, zip]);
  };
  if (!values["no-zip"]) {
    makeZip();
  }
  if (notary) {
    run("xcrun", ["notarytool", "submit", zip, "--keychain-profile", notary, "--wait"]);
    run("xcrun", ["stapler", "staple", app]);
    run("spctl", ["--assess", "--type", "execute", "--verbose", app]);
    makeZip();
  }
  if (!values["no-dmg"]) {
    const dmg = join(out, `${name}.dmg`);
    createStyledDmg({
      appPath: app,
      bundleName,
      volumeName: `${bundleName} ${version}`,
      backgroundPath: dmgBackground,
      volumeIconPath: icon,
      outputPath: dmg,
    });
    if (identity !== "-") sign(dmg);
    if (notary) {
      run("xcrun", ["notarytool", "submit", dmg, "--keychain-profile", notary, "--wait"]);
      run("xcrun", ["stapler", "staple", dmg]);
    }
  }
  if (!values["no-zip"]) {
    const notes = git("log", "-20", "--format=%s").split("\n");
    writeFileSync(
      join(out, "release.json"),
      JSON.stringify(
        {
          version,
          notes,
          page: tagged ? `https://github.com/vibevalleyhq/vibevalley/releases/tag/${versionTag}` : "",
          builds: [{ arch, file: `${name}.zip`, size: statSync(zip).size, sha512: createHash("sha512").update(readFileSync(zip)).digest("hex") }],
        },
        null,
        2,
      ) + "\n",
    );
  }
  console.log(`Packaged ${app} (${identity === "-" ? "ad-hoc signature" : "Developer ID"}${notary ? ", notarized" : ", not notarized"})`);
}

if (import.meta.main) {
  await main();
}
