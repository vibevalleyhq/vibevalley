import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

import { shouldPackageAsset } from "./package-assets.ts";
import { channelIconFile, minimumMacOS, packageArchitecture, requireDeveloperId, verifyMacExecutable } from "./package-platform.ts";

const root = resolve(import.meta.dirname, "../..");
const { values } = parseArgs({
  options: {
    version: { type: "string" },
    out: { type: "string" },
    profile: { type: "string", default: "release" },
    "skip-build": { type: "boolean", default: false },
    "no-dmg": { type: "boolean", default: false },
    sign: { type: "string" },
    "notary-profile": { type: "string" },
  },
});
const run = (command: string, args: string[], cwd = root, env?: NodeJS.ProcessEnv) =>
  execFileSync(command, args, { cwd, stdio: "inherit", env: env ? { ...process.env, ...env } : process.env });
const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
if (process.platform !== "darwin") throw new Error("package:mac requires macOS");
let tag = "";
try {
  tag = git("describe", "--tags", "--exact-match", "--match", "v*");
} catch {
  /* An untagged local build has no release feed. */
}
const version = values.version ?? (tag.replace(/^v/u, "") || "0.0.0");
if (!/^\d+\.\d+\.\d+(?:-(?:alpha|beta)\.\d+)?$/u.test(version)) throw new Error(`Invalid package version: ${version}`);
const versionTag = `v${version}`;
const tagged = git("tag", "--points-at", "HEAD", "--list", versionTag) === versionTag;
const profile = values.profile;
if (profile !== "release" && profile !== "debug") throw new Error("--profile must be release or debug");
const identity = values.sign ?? process.env.VIBEVALLEY_SIGN_IDENTITY ?? "-";
const notary = values["notary-profile"] ?? process.env.VIBEVALLEY_NOTARY_PROFILE;
if (notary && identity === "-") throw new Error("Notarization requires a Developer ID signing identity");
const out = resolve(root, values.out ?? "apps/mac/dist");
const app = join(out, "VibeValley.app");
const macos = join(app, "Contents/MacOS");
const resources = join(app, "Contents/Resources");
const target = resolve(root, process.env.CARGO_TARGET_DIR ?? "target", profile);
if (!values["skip-build"]) {
  run("vp", ["run", "mac:check"]);
  run(
    "cargo",
    ["build", "--locked", ...(profile === "release" ? ["--release"] : []), "-p", "vibevalley-mac", "-p", "vibevalley-cli"],
    root,
    profile === "release" ? { LIBGHOSTTY_VT_SYS_OPTIMIZE: "ReleaseFast" } : undefined,
  );
  run("swift", ["build", "-c", "release", "--package-path", "apps/island"]);
}
const arch = packageArchitecture(process.arch);
const icon = join(root, channelIconFile(version));
for (const file of [join(target, "vibevalley-mac"), join(target, "vibevalley"), join(root, "apps/island/.build/release/VibeValleyIsland"), icon]) {
  if (!existsSync(file)) throw new Error(`Missing package input: ${file}. Build it before --skip-build`);
}
for (const binary of [join(target, "vibevalley-mac"), join(target, "vibevalley"), join(root, "apps/island/.build/release/VibeValleyIsland")]) {
  verifyMacExecutable(binary, arch);
}
mkdirSync(out, { recursive: true });
rmSync(app, { recursive: true, force: true });
mkdirSync(macos, { recursive: true });
mkdirSync(resources, { recursive: true });
cpSync(join(target, "vibevalley-mac"), join(macos, "vibevalley-mac"));
cpSync(join(target, "vibevalley"), join(macos, "vibevalley"));
cpSync(join(root, "apps/island/.build/release/VibeValleyIsland"), join(macos, "VibeValleyIsland"));
const assetsRoot = join(root, "assets");
cpSync(assetsRoot, join(resources, "assets"), {
  recursive: true,
  dereference: true,
  filter: (src) => shouldPackageAsset(relative(assetsRoot, src)),
});
cpSync(icon, join(resources, "icon.icns"));
const sign = (path: string, microphone = false) =>
  run("codesign", [
    "--force",
    "--sign",
    identity,
    ...(identity === "-" ? [] : ["--options", "runtime", "--timestamp", ...(microphone ? ["--entitlements", join(root, "apps/mac/entitlements.plist")] : [])]),
    path,
  ]);
for (const bin of ["vibevalley", "VibeValleyIsland", "vibevalley-mac"]) sign(join(macos, bin), bin === "vibevalley-mac");
writeFileSync(
  join(app, "Contents/Info.plist"),
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>dev.vibevalley.app</string>
<key>CFBundleName</key><string>VibeValley</string>
<key>CFBundleExecutable</key><string>vibevalley-mac</string>
<key>CFBundleIconFile</key><string>icon</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>VibeValleyVersion</key><string>${version}</string>
<key>CFBundleShortVersionString</key><string>${version.split("-")[0]}</string>
<key>CFBundleVersion</key><string>${version.split("-")[0]}</string>
<key>LSMinimumSystemVersion</key><string>${minimumMacOS}</string>
<key>NSHighResolutionCapable</key><true/>
<key>NSMicrophoneUsageDescription</key><string>VibeValley uses the microphone for voice conversations.</string>
</dict></plist>\n`,
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
makeZip();
if (notary) {
  run("xcrun", ["notarytool", "submit", zip, "--keychain-profile", notary, "--wait"]);
  run("xcrun", ["stapler", "staple", app]);
  run("spctl", ["--assess", "--type", "execute", "--verbose", app]);
  makeZip();
}
if (!values["no-dmg"]) {
  const stage = join(out, ".dmg-stage");
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage);
  cpSync(app, join(stage, "VibeValley.app"), { recursive: true });
  symlinkSync("/Applications", join(stage, "Applications"));
  const dmg = join(out, `${name}.dmg`);
  rmSync(dmg, { force: true });
  try {
    run("hdiutil", ["create", "-volname", `VibeValley ${version}`, "-srcfolder", stage, "-format", "UDZO", dmg]);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
  if (identity !== "-") sign(dmg);
  if (notary) {
    run("xcrun", ["notarytool", "submit", dmg, "--keychain-profile", notary, "--wait"]);
    run("xcrun", ["stapler", "staple", dmg]);
  }
}
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
console.log(`Packaged ${app} (${identity === "-" ? "ad-hoc signature" : "Developer ID"}${notary ? ", notarized" : ", not notarized"})`);
