// Packages the macOS app (dist/VibeValley-<version>-<arch>.dmg for a first install, .zip for the app's own updates, and
// release.json that says what they are: src/releases.ts): the shell from build/, and three
// resources the shell finds under process.resourcesPath (src/main.ts): web/ is apps/web/dist, island/ the island's
// release build, server/ is apps/server deployed with its production dependencies. The server runs unbundled with tsx, as it does in the
// repository: PGlite's wasm, the word lists, the migrations and the agent SDKs are read from paths beside their code.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { build, Platform } from "electron-builder";

import { baselineHash } from "../../server/src/base/baseline.ts";
import type { Release } from "../src/releases.ts";

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
// The server with exactly the versions the lockfile has, its workspace packages copied in: pnpm deploy. (npm without
// the lockfile let a transitive dependency float past the effect the rest is pinned to.)
sh(repo, "pnpm", "--filter", "@vibevalley/server", "deploy", "--prod", server);
// What only the tests read does not ship: test files, golden data, test helpers, in the server and its packages.
const testOnly = /\.test\.tsx?$|(^|\/)(testdata|testing)$/u;
const prune = (dir: string) => {
  for (const name of readdirSync(dir, { recursive: true, encoding: "utf8" }))
    if (testOnly.test(name) && !name.includes("node_modules/.pnpm/node_modules")) rmSync(join(dir, name), { recursive: true, force: true });
};
prune(join(server, "src"));
for (const name of readdirSync(join(server, "node_modules", "@vibevalley"))) prune(join(server, "node_modules", "@vibevalley", name, "src"));
// tsx reads the nearest tsconfig; the repository's extends a file the app does not carry.
writeFileSync(
  join(server, "tsconfig.json"),
  JSON.stringify(
    {
      compilerOptions: {
        target: "ES2024",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        resolveJsonModule: true,
        allowImportingTsExtensions: true,
        noEmit: true,
        // @/ is src/, as in apps/server/tsconfig.json.
        paths: { "@/*": ["./src/*"] },
      },
    },
    null,
    2,
  ),
);

// The version is the tag the release is built from (v0.2.0); between tags, 0.0.0, which no release is older than.
// What git says when it finds nothing (no tag before) is not the package's to print.
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
const described = git("describe", "--tags", "--always").replace(/^v/u, "");
const version = /^\d+\.\d+\.\d+$/u.test(described) ? described : "0.0.0";
const dist = join(desktop, "dist");
await build({
  targets: Platform.MAC.createTarget(["dmg", "zip"]),
  config: {
    appId: "dev.vibevalley.app",
    productName: "VibeValley",
    extraMetadata: { version },
    directories: { output: dist, buildResources: join(desktop, "resources") },
    files: ["build/**", "package.json"],
    extraResources: [
      { from: join(repo, "apps/web/dist"), to: "web" },
      { from: islandBinary, to: "island/VibeValleyIsland" },
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
    npmRebuild: false,
  },
});

// What the release says about itself: its build for this Mac, the merged pull requests since the tag before (their
// titles are main's commit subjects), and the baseline its server makes a database from.
const arch = process.arch;
const zip = `VibeValley-${version}-${arch}.zip`;
const previous = (() => {
  try {
    return git("describe", "--tags", "--abbrev=0", "HEAD^");
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
