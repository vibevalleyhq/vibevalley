import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, globSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { z } from "zod";

const MAX_DESKTOP_BINARY_BYTES = 41_943_040;
const versionPattern = /^(\d+)\.(\d+)\.(\d+)(?:-(alpha|beta)\.(\d+))?$/u;
const HeadlessCheckSchema = z.object({ ok: z.boolean() });

export type ReleaseChannel = "stable" | "beta" | "alpha" | "dev";

export interface ReleaseBuild {
  readonly arch: string;
  readonly file: string;
  readonly size: number;
  readonly sha512: string;
}

export interface ReleaseManifest {
  readonly version: string;
  readonly notes: readonly string[];
  readonly schema: string;
  readonly page: string;
  readonly builds: readonly ReleaseBuild[];
}

interface BundleInputs {
  readonly outDir: string;
  readonly version: string;
  readonly desktopBinary: string;
  readonly cliBinary: string;
  readonly iconPath: string;
  readonly webDistDir: string;
}

interface BundleOutputs {
  readonly appPath: string;
  readonly executablePath: string;
  readonly cliPath: string;
  readonly webDir: string;
  readonly infoPlistPath: string;
  readonly distDesktopBinary: string;
}

export function resolveReleaseVersion(asked: string | undefined, describedTag?: string): string {
  const candidate = (asked?.trim() || describedTag?.trim() || "").replace(/^v/u, "");
  return versionPattern.test(candidate) ? candidate : "0.0.0";
}

export function channelForVersion(version: string): ReleaseChannel {
  if (version === "0.0.0") return "dev";
  const match = versionPattern.exec(version);
  if (!match) return "dev";
  if (match[4] === "alpha") return "alpha";
  if (match[4] === "beta") return "beta";
  return "stable";
}

export function bundleIdentifierForChannel(channel: ReleaseChannel): string {
  switch (channel) {
    case "stable":
      return "dev.vibevalley.app";
    case "beta":
      return "dev.vibevalley.app.beta";
    case "alpha":
      return "dev.vibevalley.app.alpha";
    case "dev":
      return "dev.vibevalley.app.dev";
  }
}

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

export function renderInfoPlist(version: string): string {
  const bundleId = escapeXml(bundleIdentifierForChannel(channelForVersion(version)));
  const safeVersion = escapeXml(version);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleDisplayName</key>
  <string>VibeValley</string>
  <key>CFBundleExecutable</key>
  <string>vibe-desktop</string>
  <key>CFBundleIconFile</key>
  <string>icon.icns</string>
  <key>CFBundleIdentifier</key>
  <string>${bundleId}</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>VibeValley</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>${safeVersion}</string>
  <key>CFBundleVersion</key>
  <string>${safeVersion}</string>
  <key>LSApplicationCategoryType</key>
  <string>public.app-category.developer-tools</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSCameraUsageDescription</key>
  <string>Use the camera only when you start realtime visual understanding. Frames are sent to your selected AI provider.</string>
  <key>NSMicrophoneUsageDescription</key>
  <string>Use the microphone only when you start dictation or a call. Audio is sent to your selected AI provider.</string>
</dict>
</plist>
`;
}

export function computeSchemaHash(repoRoot: string): string {
  const migrationFiles = globSync("pkg/db/migrations/*.up.sql", { cwd: repoRoot })
    .map((file) => file.replaceAll("\\", "/"))
    .toSorted();
  if (migrationFiles.length === 0) {
    throw new Error(`No migration files matched pkg/db/migrations/*.up.sql under ${repoRoot}`);
  }
  const hash = createHash("sha256");
  for (const relPath of migrationFiles) {
    hash.update(`${relPath}\0`);
    hash.update(readFileSync(join(repoRoot, relPath)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function assembleAppBundle(inputs: BundleInputs): BundleOutputs {
  if (!existsSync(inputs.desktopBinary)) throw new Error(`Missing desktop binary: ${inputs.desktopBinary}`);
  if (!existsSync(inputs.cliBinary)) throw new Error(`Missing CLI binary: ${inputs.cliBinary}`);
  if (!existsSync(inputs.iconPath)) throw new Error(`Missing desktop icon: ${inputs.iconPath}`);
  if (!existsSync(join(inputs.webDistDir, "index.html"))) throw new Error(`Missing built web dist index.html under ${inputs.webDistDir}`);

  mkdirSync(inputs.outDir, { recursive: true });
  const distDesktopBinary = join(inputs.outDir, "vibe-desktop");
  if (resolve(inputs.desktopBinary) !== resolve(distDesktopBinary)) {
    cpSync(inputs.desktopBinary, distDesktopBinary);
  }
  chmodSync(distDesktopBinary, 0o755);

  const appPath = join(inputs.outDir, "VibeValley.app");
  rmSync(appPath, { recursive: true, force: true });

  const contentsDir = join(appPath, "Contents");
  const macOSDir = join(contentsDir, "MacOS");
  const resourcesDir = join(contentsDir, "Resources");
  const webDir = join(resourcesDir, "web");
  const binDir = join(resourcesDir, "bin");
  mkdirSync(macOSDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });

  const infoPlistPath = join(contentsDir, "Info.plist");
  writeFileSync(infoPlistPath, renderInfoPlist(inputs.version));

  const executablePath = join(macOSDir, "vibe-desktop");
  cpSync(distDesktopBinary, executablePath);
  chmodSync(executablePath, 0o755);

  cpSync(inputs.iconPath, join(resourcesDir, "icon.icns"));
  cpSync(inputs.webDistDir, webDir, { recursive: true });

  const cliPath = join(binDir, "vibe");
  cpSync(inputs.cliBinary, cliPath);
  chmodSync(cliPath, 0o755);

  return { appPath, executablePath, cliPath, webDir, infoPlistPath, distDesktopBinary };
}

export function buildArtifactEntry(zipPath: string, arch: string): ReleaseBuild {
  const sha512 = createHash("sha512").update(readFileSync(zipPath)).digest("hex");
  return {
    arch,
    file: basename(zipPath),
    size: statSync(zipPath).size,
    sha512,
  };
}

export function createReleaseManifest(params: {
  readonly version: string;
  readonly notes: readonly string[];
  readonly schema: string;
  readonly builds: readonly ReleaseBuild[];
}): ReleaseManifest {
  return {
    version: params.version,
    notes: [...params.notes],
    schema: params.schema,
    page: `https://github.com/vibevalleyhq/vibevalley/releases/tag/v${params.version}`,
    builds: [...params.builds],
  };
}

function goBuildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, CGO_ENABLED: "0" };
  delete env.GOROOT;
  return env;
}

function runInherit(command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv = process.env): void {
  const result = spawnSync(command, args, { cwd, env, stdio: "inherit", shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status ?? 1}`);
  }
}

function gitOutput(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

function resolveReleaseNotes(repoRoot: string, version: string): string[] {
  if (version === "0.0.0") return [];
  const channel = channelForVersion(version);
  let previous: string | undefined;
  try {
    previous = gitOutput(repoRoot, "describe", "--tags", "--abbrev=0", ...(channel === "stable" ? ["--exclude", "*-*"] : []), "HEAD^");
  } catch {
    // First release on a line with no prior matching tag.
    previous = undefined;
  }
  const range = previous !== undefined && previous !== "" ? `${previous}..HEAD` : "HEAD";
  return gitOutput(repoRoot, "log", "--format=%s", range)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

function runHeadlessCheck(executablePath: string): void {
  const tempHome = mkdtempSync(join(tmpdir(), "vibevalley-pack-check-"));
  try {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: tempHome,
      VIBEVALLEY_HOME: join(tempHome, ".vibevalley"),
    };
    const stdout = execFileSync(executablePath, ["--headless-check"], { env, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
    const parsed = HeadlessCheckSchema.parse(JSON.parse(stdout));
    if (!parsed.ok) {
      throw new Error(`Desktop --headless-check returned ok=false: ${stdout.trim()}`);
    }
  } finally {
    rmSync(tempHome, { recursive: true, force: true });
  }
}

function main(): void {
  const { values } = parseArgs({
    options: {
      "skip-web-build": { type: "boolean", default: false },
    },
    strict: true,
  });

  const repoRoot = resolve(import.meta.dirname, "../..");
  const distDir = join(repoRoot, "dist");
  const webDistDir = join(repoRoot, "apps", "web", "dist");
  const iconPath = join(repoRoot, "cmd", "vibe-desktop", "resources", "icon.icns");

  let described = "";
  try {
    described = gitOutput(repoRoot, "describe", "--tags", "--always");
  } catch {
    // Unborn or non-git environments fall back to 0.0.0.
    described = "";
  }
  const version = resolveReleaseVersion(process.env.VIBEVALLEY_RELEASE_VERSION || process.env.VIBEVALLEY_VERSION, described);

  if (!values["skip-web-build"]) {
    runInherit("vp", ["run", "--filter", "@vibevalley/web", "build"], repoRoot);
  } else if (!existsSync(join(webDistDir, "index.html"))) {
    throw new Error(`--skip-web-build passed, but ${join(webDistDir, "index.html")} does not exist`);
  }

  mkdirSync(distDir, { recursive: true });
  const env = goBuildEnv();
  const ldflags = version === "0.0.0" ? "-s -w" : `-s -w -X main.desktopVersion=${version}`;
  const desktopBinary = join(distDir, "vibe-desktop");
  runInherit("go", ["build", "-trimpath", `-ldflags=${ldflags}`, "-o", desktopBinary, "./cmd/vibe-desktop"], repoRoot, env);

  const desktopSize = statSync(desktopBinary).size;
  if (desktopSize >= MAX_DESKTOP_BINARY_BYTES) {
    throw new Error(`Stripped vibe-desktop binary (${desktopSize} bytes) exceeds ${MAX_DESKTOP_BINARY_BYTES} byte limit`);
  }

  const stageDir = mkdtempSync(join(tmpdir(), "vibevalley-mac-stage-"));
  try {
    const cliBinary = join(stageDir, "vibe");
    runInherit("go", ["build", "-trimpath", "-ldflags=-s -w", "-o", cliBinary, "./cmd/vibe"], repoRoot, env);

    const bundle = assembleAppBundle({
      outDir: distDir,
      version,
      desktopBinary,
      cliBinary,
      iconPath,
      webDistDir,
    });

    const builds: ReleaseBuild[] = [];
    if (process.platform === "darwin") {
      runInherit("codesign", ["--force", "--deep", "--sign", "-", bundle.appPath], repoRoot);
      runHeadlessCheck(bundle.executablePath);

      const arch = process.arch;
      const zipName = `VibeValley-${version}-${arch}.zip`;
      const dmgName = `VibeValley-${version}-${arch}.dmg`;
      const zipPath = join(distDir, zipName);
      const dmgPath = join(distDir, dmgName);
      rmSync(zipPath, { force: true });
      rmSync(dmgPath, { force: true });

      runInherit("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", "VibeValley.app", zipName], distDir);

      const dmgStageDir = join(stageDir, "dmg");
      mkdirSync(dmgStageDir, { recursive: true });
      runInherit("ditto", [bundle.appPath, join(dmgStageDir, "VibeValley.app")], repoRoot);
      runInherit("hdiutil", ["create", "-volname", "VibeValley", "-srcfolder", dmgStageDir, "-ov", "-format", "ULFO", dmgPath], repoRoot);

      builds.push(buildArtifactEntry(zipPath, arch));
    }

    const manifest = createReleaseManifest({
      version,
      notes: resolveReleaseNotes(repoRoot, version),
      schema: computeSchemaHash(repoRoot),
      builds,
    });
    writeFileSync(join(distDir, "release.json"), JSON.stringify(manifest, null, 2) + "\n");
    console.log(`Packaged VibeValley ${version} (${desktopSize} bytes desktop binary) in ${distDir}`);
  } finally {
    rmSync(stageDir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  main();
}
