// Packages the macOS app (dist/VibeValley-<version>-<arch>.dmg and the .app beside it): the shell from build/, and two
// resources the shell finds under process.resourcesPath (src/main.ts): web/ is apps/web/dist, server/ is apps/server
// with its production dependencies installed as real copies. The server runs unbundled with tsx, as it does in the
// repository: PGlite's wasm, the word lists, the migrations and the agent SDKs are read from paths beside their code.

import { build, Platform } from "electron-builder";
import { $ } from "bun";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const desktop = join(import.meta.dir, "..");
const repo = join(desktop, "../..");
const stage = join(desktop, "dist/stage");
const server = join(stage, "server");

await $`bun run --filter vibevalley-web build`.cwd(repo);
await $`bun scripts/build.ts`.cwd(desktop);

rmSync(stage, { recursive: true, force: true });
mkdirSync(server, { recursive: true });
const skip = (path: string) => !/\.test\.ts$|\/testdata(\/|$)|\/testing(\/|$)/.test(path);
for (const dir of ["src", "db"]) cpSync(join(repo, "apps/server", dir), join(server, dir), { recursive: true, filter: skip });
cpSync(join(repo, "packages/protocol/src"), join(stage, "protocol/src"), { recursive: true, filter: skip });

// The workspace's own packages become local folders; --install-links copies them into node_modules, so the staged
// server needs nothing outside itself.
const protocol = JSON.parse(readFileSync(join(repo, "packages/protocol/package.json"), "utf8"));
writeFileSync(join(stage, "protocol/package.json"), JSON.stringify({ ...protocol, scripts: undefined, devDependencies: undefined }, null, 2));
const pkg = JSON.parse(readFileSync(join(repo, "apps/server/package.json"), "utf8"));
pkg.dependencies["@vibevalley/protocol"] = "file:../protocol";
writeFileSync(join(server, "package.json"), JSON.stringify({ ...pkg, scripts: undefined, devDependencies: undefined }, null, 2));
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
      },
    },
    null,
    2,
  ),
);
await $`npm install --omit=dev --install-links --no-audit --no-fund --no-package-lock`.cwd(server);

const version = (await $`git describe --tags --always`.cwd(repo).text()).trim().replace(/^v/, "");
await build({
  targets: Platform.MAC.createTarget(["dmg"]),
  config: {
    appId: "dev.vibevalley.app",
    productName: "VibeValley",
    extraMetadata: { version: /^\d+\.\d+\.\d+/.test(version) ? version : "0.0.0" },
    directories: { output: join(desktop, "dist"), buildResources: join(desktop, "resources") },
    files: ["build/**", "package.json"],
    extraResources: [{ from: join(repo, "apps/web/dist"), to: "web" }],
    // extraResources leaves out every node_modules; the server needs its own, so it is copied in whole.
    afterPack: async (ctx) => {
      cpSync(server, join(ctx.appOutDir, `${ctx.packager.appInfo.productFilename}.app/Contents/Resources/server`), { recursive: true, verbatimSymlinks: true });
    },
    mac: { category: "public.app-category.developer-tools", icon: join(desktop, "resources/icon.icns"), identity: null },
    npmRebuild: false,
  },
});
