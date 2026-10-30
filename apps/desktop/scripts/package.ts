// Packages the macOS app (dist/VibeValley-<version>-<arch>.dmg and the .app beside it): the shell from build/, and three
// resources the shell finds under process.resourcesPath (src/main.ts): web/ is apps/web/dist, island/ the island's
// release build, server/ is apps/server with its production dependencies installed as real copies. The server runs unbundled with tsx, as it does in the
// repository: PGlite's wasm, the word lists, the migrations and the agent SDKs are read from paths beside their code.

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import { build, Platform } from "electron-builder";

import { workspaceClosure } from "../src/workspace.ts";

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
mkdirSync(server, { recursive: true });
const skip = (path: string) => !/\.test\.ts$|\/testdata(\/|$)|\/testing(\/|$)/u.test(path);
for (const dir of ["src", "db"]) cpSync(join(repo, "apps/server", dir), join(server, dir), { recursive: true, filter: skip });
// Each workspace package the server runs on sits beside it as stage/<folder>, its src only: the code runs from source.
const packages = workspaceClosure(repo, join(repo, "apps/server"));
for (const dir of packages.values()) cpSync(join(dir, "src"), join(stage, basename(dir), "src"), { recursive: true, filter: skip });

// npm does not read pnpm's catalog: each "catalog:" becomes the version pnpm installed for the package, as the lockfile has it.
const installed = (dir: string): Record<string, string> => {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- pnpm list --json's shape
  const [listed] = JSON.parse(execFileSync("pnpm", ["list", "--prod", "--depth", "0", "--json"], { cwd: dir, encoding: "utf8" })) as {
    dependencies?: Record<string, { version: string }>;
  }[];
  return Object.fromEntries(Object.entries(listed?.dependencies ?? {}).map(([name, d]) => [name, d.version]));
};
const staged = (dir: string, dependencies: Record<string, string>) => {
  const versions = installed(dir);
  return Object.fromEntries(
    Object.entries(dependencies).map(([name, spec]) => {
      if (!spec.startsWith("catalog:")) return [name, spec];
      const version = versions[name];
      if (version === undefined) throw new Error(`${name} is not installed in ${dir}`);
      return [name, version];
    }),
  );
};

// The workspace's own packages become local folders (npm does not read workspace:); --install-links copies them into
// node_modules, so the staged server needs nothing outside itself.
const local = (dependencies: Record<string, string>) =>
  Object.fromEntries(
    Object.entries(dependencies).map(([name, spec]) => [name, spec.startsWith("workspace:") ? `file:../${basename(packages.get(name)!)}` : spec]),
  );
const stageManifest = (dir: string, to: string) => {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a workspace package's own package.json
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
  const dependencies = local(staged(dir, pkg.dependencies ?? {}));
  writeFileSync(join(to, "package.json"), JSON.stringify({ ...pkg, dependencies, scripts: undefined, devDependencies: undefined }, null, 2));
};
for (const dir of packages.values()) stageManifest(dir, join(stage, basename(dir)));
stageManifest(join(repo, "apps/server"), server);
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
sh(server, "npm", "install", "--omit=dev", "--install-links", "--no-audit", "--no-fund", "--no-package-lock");

const version = execFileSync("git", ["describe", "--tags", "--always"], { cwd: repo, encoding: "utf8" }).trim().replace(/^v/u, "");
await build({
  targets: Platform.MAC.createTarget(["dmg"]),
  config: {
    appId: "dev.vibevalley.app",
    productName: "VibeValley",
    extraMetadata: { version: /^\d+\.\d+\.\d+/u.test(version) ? version : "0.0.0" },
    directories: { output: join(desktop, "dist"), buildResources: join(desktop, "resources") },
    files: ["build/**", "package.json"],
    extraResources: [
      { from: join(repo, "apps/web/dist"), to: "web" },
      { from: islandBinary, to: "island/VibeValleyIsland" },
    ],
    // extraResources leaves out every node_modules; the server needs its own, so it is copied in whole.
    afterPack: async (ctx) => {
      cpSync(server, join(ctx.appOutDir, `${ctx.packager.appInfo.productFilename}.app/Contents/Resources/server`), { recursive: true, verbatimSymlinks: true });
    },
    mac: { category: "public.app-category.developer-tools", icon: join(desktop, "resources/icon.icns"), identity: null },
    npmRebuild: false,
  },
});
