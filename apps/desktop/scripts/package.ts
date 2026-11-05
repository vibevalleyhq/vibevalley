// Packages the macOS app (dist/VibeValley-<version>-<arch>.dmg for a first install, .zip for the app's own updates, and
// release.json that says what they are: src/releases.ts): the shell from build/, and three
// resources the shell finds under process.resourcesPath (src/main.ts): web/ is apps/web/dist, island/ the island's
// release build, server/ is apps/server's bundle (its `vp pack`, dist/main.mjs and dist/chat.mjs) with the dependencies
// it leaves out in node_modules and the few files it reads at run time (apps/server/src/assets.ts), at the paths it reads
// them from; cli/ is the command line's bundle (apps/cli, everything in it) with its guide beside it (apps/cli/src/assets.ts).

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { build, Platform } from "electron-builder";

import { cliFiles } from "@vibevalley/cli/assets";
import { serverFiles } from "@vibevalley/server/assets";
import { baselineHash } from "@vibevalley/server/baseline";

import { channelOf, channels } from "../src/channel.ts";
import { isVersion, type Release, stageOf } from "../src/releases.ts";

const desktop = join(import.meta.dirname, "..");
const repo = join(desktop, "../..");
const stage = join(desktop, "dist/stage");
const server = join(stage, "server");
const cli = join(stage, "cli");

const sh = (cwd: string, cmd: string, ...args: string[]) => execFileSync(cmd, args, { cwd, stdio: "inherit" });
sh(repo, "vp", "run", "--filter", "@vibevalley/web", "build");
sh(desktop, "pnpm", "exec", "vpx", "scripts/build.ts");
// The island, for this Mac's architecture as the rest of the package is; where SwiftPM puts it differs between its
// versions, so it is asked.
const island = join(repo, "apps/island");
sh(island, "swift", "build", "-c", "release");
const islandBinary = join(execFileSync("swift", ["build", "-c", "release", "--show-bin-path"], { cwd: island, encoding: "utf8" }).trim(), "VibeValleyIsland");

rmSync(stage, { recursive: true, force: true });
// Everything at the versions the lockfile pins, the workspace packages copied in: npm without the lockfile let a
// transitive dependency float past what the rest is pinned to.
sh(repo, "pnpm", "--filter", "@vibevalley/server", "deploy", "--prod", server);
// The server is its bundle: src/main.ts and the workspace packages in one module, the other dependencies left as they are.
sh(join(repo, "apps/server"), "vp", "pack", "--out-dir", join(server, "dist"));
// Of what pnpm deployed beside it only those dependencies and the files the server reads stay: no sources, no tests, no
// workspace packages (they are in the bundle).
const assets = join(stage, "assets");
for (const path of serverFiles) cpSync(join(server, path), join(assets, path), { recursive: true });
for (const name of readdirSync(server))
  if (!["dist", "node_modules", "package.json"].includes(name)) rmSync(join(server, name), { recursive: true, force: true });
cpSync(assets, server, { recursive: true });
rmSync(assets, { recursive: true, force: true });
rmSync(join(server, "node_modules", "@vibevalley"), { recursive: true, force: true });
// The command line is one bundle with nothing beside it but its guide: it loads none of the server.
sh(join(repo, "apps/cli"), "vp", "pack", "--out-dir", join(cli, "dist"));
for (const path of cliFiles) cpSync(join(repo, "apps/cli", path), join(cli, path), { recursive: true });
// Nor what only an editor reads: the dependencies' source maps and type declarations, a third of the server's files.
// Neither is loaded at run time (a missing map only leaves a stack trace unmapped); docs and licences stay, as an agent's
// SDK may read its own.
const devOnly = /\.(?:js|mjs|cjs|ts|mts|cts)\.map$|\.d\.(?:ts|mts|cts)$/u;
for (const name of readdirSync(join(server, "node_modules", ".pnpm"), { recursive: true, encoding: "utf8" }))
  if (devOnly.test(name)) rmSync(join(server, "node_modules", ".pnpm", name), { force: true });

// The version is the tag the release is built from (v0.2.0, v0.3.0-beta.1); between tags, 0.0.0, which no release is
// older than.
// VIBEVALLEY_VERSION gives one outright (scripts/update-check.ts builds two in a row).
// What git says when it finds nothing (no tag before) is not the package's to print.
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
const described = git("describe", "--tags", "--always").replace(/^v/u, "");
const asked = process.env.VIBEVALLEY_VERSION ?? described;
const version = isVersion(asked) ? asked : "0.0.0";
const dist = join(desktop, "dist");
const channel = channels[channelOf(version, true)];

// The command line in the app (Resources/bin/<command>, linked into ~/.local/bin by 「安装命令行」, src/commandLine.ts):
// the app's own Node runs cli/dist/main.mjs, on this channel's farm unless VIBEVALLEY_HOME says otherwise.
// VIBEVALLEY_APP lets `app open` start the app when it is not running; VIBEVALLEY_CHAT is the server's conversation
// program, which the command line hands its terminal to (apps/cli src/chat.ts).
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
export VIBEVALLEY_CHAT="$resources/server/dist/chat.mjs"
ELECTRON_RUN_AS_NODE=1 exec "$resources/../MacOS/${channel.name}" "$resources/cli/dist/main.mjs" "$@"
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
      { from: cli, to: "cli" },
    ],
    // extraResources leaves out every node_modules; the server needs its own, so it is copied in whole.
    afterPack: async (ctx) => {
      cpSync(server, join(ctx.appOutDir, `${ctx.packager.appInfo.productFilename}.app/Contents/Resources/server`), { recursive: true, verbatimSymlinks: true });
    },
    mac: {
      category: "public.app-category.developer-tools",
      icon: join(desktop, "resources/icon.icns"),
      identity: null,
      artifactName: "VibeValley-${version}-${arch}.${ext}",
    },
    // lzfse (ULFO) rather than zlib: made and opened faster, a little smaller; macOS has read it since 10.11.
    dmg: { format: "ULFO" },
    npmRebuild: false,
  },
});

// What the release says about itself: its build for this Mac, the merged pull requests since the tag before (their
// titles are main's commit subjects), and the baseline its server makes a database from.
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
  schema: baselineHash(),
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
