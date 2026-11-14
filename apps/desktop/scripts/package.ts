import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { build, Platform } from "electron-builder";

import { t } from "@vibevalley/i18n";

import { channelOf, channels } from "../src/base/channel.ts";
import { isVersion, type Release, stageOf } from "../src/base/releases.ts";

const desktop = join(import.meta.dirname, "..");
const repo = join(desktop, "../..");
const stage = join(desktop, "dist/stage");
const server = join(stage, "server");

const sh = (cwd: string, cmd: string, ...args: string[]) => execFileSync(cmd, args, { cwd, stdio: "inherit" });
sh(repo, "vp", "run", "--filter", "@vibevalley/web", "build");
sh(desktop, "pnpm", "exec", "vpx", "scripts/build.ts");
// The island, for this Mac's architecture as the rest of the package is; where SwiftPM puts it differs between its
// versions, so it is asked.
const island = join(repo, "apps/island");
sh(island, "swift", "build", "-c", "release");
const islandBinary = join(execFileSync("swift", ["build", "-c", "release", "--show-bin-path"], { cwd: island, encoding: "utf8" }).trim(), "VibeValleyIsland");

rmSync(stage, { recursive: true, force: true });
// The server and the command line are the Rust workspace's binaries (crates/vibevalley-server, crates/vibevalley-cli).
const target = process.env.CARGO_TARGET_DIR ?? join(repo, "target");
sh(repo, "cargo", "build", "--release", "-p", "vibevalley-server", "-p", "vibevalley-cli");
mkdirSync(server, { recursive: true });
for (const bin of ["vibevalley-server", "vibevalley"]) cpSync(join(target, "release", bin), join(server, bin));

// The version is the tag the release is built from (v0.2.0, v0.3.0-beta.1). between tags, 0.0.0, which no release is older than.
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
const described = git("describe", "--tags", "--always").replace(/^v/u, "");
const asked = process.env.VIBEVALLEY_VERSION ?? described;
const version = isVersion(asked) ? asked : "0.0.0";
const dist = join(desktop, "dist");
const channel = channels[channelOf(version, true)];

// The command line in the app (Resources/bin/<command>, linked into ~/.local/bin by Install CLI, src/commandLine.ts).
const launcher = join(stage, "bin", channel.command);
mkdirSync(join(stage, "bin"), { recursive: true });
writeFileSync(
  launcher,
  `#!/bin/sh
here=$0
while [ -L "$here" ]; do
  link=$(readlink "$here")
  case "$link" in
    /*) here=$link ;;
    *) here=\${here%/*}/$link ;;
  esac
done
resources=\${here%/*}/..
export VIBEVALLEY_HOME="\${VIBEVALLEY_HOME:-$HOME/.vibevalley${channel.suffix}}"
export VIBEVALLEY_APP="$resources/../.."
exec "$resources/server/vibevalley" "$@"
`,
  { mode: 0o755 },
);

await build({
  targets: Platform.MAC.createTarget(["dmg", "zip"]),
  config: {
    appId: channel.appId,
    productName: channel.name,
    extraMetadata: { version },
    directories: { output: dist, buildResources: join(desktop, "resources") },
    files: ["build/**", "package.json"],
    extraResources: [
      { from: join(repo, "apps/web/dist"), to: "web" },
      { from: islandBinary, to: "island/VibeValleyIsland" },
      { from: join(stage, "bin"), to: "bin" },
      { from: server, to: "server" },
    ],
    mac: {
      category: "public.app-category.developer-tools",
      icon: join(desktop, "resources/icon.icns"),
      identity: null,
      extendInfo: {
        NSCameraUsageDescription: t("desktop.media.camera"),
        NSMicrophoneUsageDescription: t("desktop.media.microphone"),
      },
      artifactName: "VibeValley-${version}-${arch}.${ext}",
    },
    // lzfse (ULFO) rather than zlib: made and opened faster, a little smaller; macOS has read it since 10.11.
    dmg: { format: "ULFO" },
    npmRebuild: false,
  },
});

// What the release says about itself: its build for this Mac and the merged pull requests since the tag before.
const arch = process.arch;
const zip = `VibeValley-${version}-${arch}.zip`;
// A release's notes are everything since the release before it, its alphas and betas included; a prerelease's, since the
// tag before it.
const previous = (() => {
  try {
    return git("describe", "--tags", "--abbrev=0", ...(stageOf(version) === "stable" ? ["--exclude", "*-*"] : []), "HEAD^");
  } catch {
    return undefined;
  }
})();
const notes =
  version === "0.0.0"
    ? []
    : git("log", "--format=%s", previous === undefined ? "HEAD" : `${previous}..HEAD`)
        .split("\n")
        .filter((l) => l !== "");
const release: Release = {
  version,
  notes,
  schema: "native",
  page: `https://github.com/vibevalleyhq/vibevalley/releases/tag/v${version}`,
  builds: [
    {
      arch,
      file: zip,
      size: statSync(join(dist, zip)).size,
      sha512: createHash("sha512")
        .update(readFileSync(join(dist, zip)))
        .digest("hex"),
    },
  ],
};
writeFileSync(join(dist, "release.json"), JSON.stringify(release, null, 2) + "\n");
