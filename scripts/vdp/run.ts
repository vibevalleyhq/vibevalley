import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createWsVdpDriver,
  discoverVdpEndpoint,
  ensureUiBundlesBuilt,
  ensureVdpArtifactsBuilt,
  isReviewTheme,
  parsePositiveInt,
  REVIEW_THEMES,
  resolveVdpWorkspacePaths,
  type ReviewTheme,
  VdpWsClient,
  withVdpWsSandbox,
} from "../release/vdp-client.ts";
import { runScenarios, type VdpScenario, writeScenarioArtifacts } from "./dsl.ts";
import { listScenarios, SCENARIOS } from "./scenarios/index.ts";

export type VdpBuildMode = "full" | "ui-only" | "skip-build";

export interface VdpRunOptions {
  readonly scenarioIds: readonly string[];
  readonly outDir: string;
  readonly themes: readonly ReviewTheme[];
  readonly width: number;
  readonly height: number;
  readonly buildMode: VdpBuildMode;
  readonly attach?: string | undefined;
  readonly keepSandbox: boolean;
  readonly keepGoing: boolean;
  readonly open: boolean;
  readonly list: boolean;
  readonly help: boolean;
}

function parseThemes(raw: string): ReviewTheme[] {
  const parts = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (parts.length === 0) {
    throw new Error(`--themes requires at least one theme (${REVIEW_THEMES.join(", ")})`);
  }
  const out: ReviewTheme[] = [];
  for (const part of parts) {
    if (!isReviewTheme(part)) {
      throw new Error(`unsupported theme "${part}" (supported: ${REVIEW_THEMES.join(", ")})`);
    }
    if (!out.includes(part)) out.push(part);
  }
  return out;
}

export function parseVdpRunArgs(argv: readonly string[], cwd = process.cwd()): VdpRunOptions {
  const scenarioIds: string[] = [];
  let outDir = "/tmp/vv-vdp-out";
  let themes: ReviewTheme[] = [...REVIEW_THEMES];
  let width = 1440;
  let height = 900;
  let buildMode: VdpBuildMode = "full";
  let attach: string | undefined;
  let keepSandbox = false;
  let keepGoing = false;
  let open = false;
  let list = false;
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (arg === "--") continue;
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--list") {
      list = true;
    } else if (arg === "--skip-build") {
      buildMode = "skip-build";
    } else if (arg === "--ui-only") {
      buildMode = "ui-only";
    } else if (arg === "--keep-sandbox") {
      keepSandbox = true;
    } else if (arg === "--keep-going") {
      keepGoing = true;
    } else if (arg === "--open") {
      open = true;
    } else if (arg === "--out") {
      const next = argv[++i];
      if (!next) throw new Error("--out requires a directory path");
      outDir = resolve(cwd, next);
    } else if (arg.startsWith("--out=")) {
      const val = arg.slice("--out=".length);
      if (!val) throw new Error("--out requires a directory path");
      outDir = resolve(cwd, val);
    } else if (arg === "--themes") {
      const next = argv[++i];
      if (!next) throw new Error("--themes requires a comma-separated list");
      themes = parseThemes(next);
    } else if (arg.startsWith("--themes=")) {
      themes = parseThemes(arg.slice("--themes=".length));
    } else if (arg === "--width") {
      const next = argv[++i];
      if (!next) throw new Error("--width requires a pixel value");
      width = parsePositiveInt("--width", next);
    } else if (arg.startsWith("--width=")) {
      width = parsePositiveInt("--width", arg.slice("--width=".length));
    } else if (arg === "--height") {
      const next = argv[++i];
      if (!next) throw new Error("--height requires a pixel value");
      height = parsePositiveInt("--height", next);
    } else if (arg.startsWith("--height=")) {
      height = parsePositiveInt("--height", arg.slice("--height=".length));
    } else if (arg === "--attach") {
      const next = argv[++i];
      if (!next) throw new Error("--attach requires a sandbox home path or ws:// URL");
      attach = next;
    } else if (arg.startsWith("--attach=")) {
      const val = arg.slice("--attach=".length);
      if (!val) throw new Error("--attach requires a sandbox home path or ws:// URL");
      attach = val;
    } else if (arg.startsWith("-")) {
      throw new Error(`unknown option "${arg}" (run with --help for usage)`);
    } else {
      scenarioIds.push(arg);
    }
  }

  return {
    scenarioIds: scenarioIds.length > 0 ? scenarioIds : ["note"],
    outDir,
    themes,
    width,
    height,
    buildMode,
    ...(attach !== undefined ? { attach } : {}),
    keepSandbox,
    keepGoing,
    open,
    list,
    help,
  };
}

function resolveRequestedScenarios(ids: readonly string[]): VdpScenario[] {
  if (ids.length === 1 && ids[0] === "all") {
    return [...listScenarios()];
  }
  const resolved: VdpScenario[] = [];
  for (const id of ids) {
    const found = SCENARIOS[id];
    if (found === undefined) {
      const available = listScenarios()
        .map((s) => s.id)
        .join(", ");
      throw new Error(`unknown VDP scenario "${id}" (available: ${available}, all)`);
    }
    resolved.push(found);
  }
  return resolved;
}

function printHelp(): void {
  const available = listScenarios()
    .map((s) => `  ${s.id.padEnd(14)} ${s.description}`)
    .join("\n");
  console.log(`Usage: vp run vdp [scenario...] [options]

Scenarios (default: note):
${available}
  all            Run all registered scenarios sequentially on one connection

Options:
  --out <dir>          Output directory for PNGs, manifest.json, and index.html (default: /tmp/vv-vdp-out)
  --themes <list>      Comma-separated themes: light,dark (default: light,dark)
  --width <px>         Viewport width (default: 1440)
  --height <px>        Viewport height (default: 900)
  --ui-only            Rebuild only apps/mac/ui via nsh (~3s) and reuse compiled vibevalley-mac binary
  --skip-build         Skip both Cargo and nsh builds
  --attach <target>    Attach to an existing sandbox home dir or ws:// URL instead of booting a new app
  --keep-sandbox       Preserve temporary sandbox directory after completion
  --keep-going         Continue remaining scenarios if one fails
  --open               Open index.html in the default viewer/Finder after capture
  --list               Print registered scenarios and exit
  -h, --help           Show this help message`);
}

function resolveAttachedEndpoint(attach: string) {
  if (attach.startsWith("ws://") || attach.startsWith("wss://") || attach.startsWith("http://") || attach.startsWith("https://")) {
    return discoverVdpEndpoint({ url: attach });
  }
  return discoverVdpEndpoint({ home: attach });
}

async function main(argv: readonly string[]): Promise<void> {
  const opts = parseVdpRunArgs(argv);
  if (opts.help) {
    printHelp();
    return;
  }
  if (opts.list) {
    for (const s of listScenarios()) {
      console.log(`${s.id}\t${s.description}`);
    }
    return;
  }

  const scenarios = resolveRequestedScenarios(opts.scenarioIds);
  const root = resolve(import.meta.dirname, "../..");
  const paths = resolveVdpWorkspacePaths(root);
  const viewport = { width: opts.width, height: opts.height };

  if (opts.attach === undefined) {
    if (opts.buildMode === "ui-only") {
      if (!existsSync(paths.macBin)) {
        throw new Error(`--ui-only requires an already-built binary at ${paths.macBin}`);
      }
      console.log("vdp: rebuilding hosted UI bundles via nsh (--ui-only)...");
      ensureUiBundlesBuilt(paths);
    } else if (opts.buildMode === "full") {
      console.log("vdp: building UI bundles and vibevalley-mac --features shot...");
      ensureVdpArtifactsBuilt(paths, { skipBuild: false });
    } else if (!existsSync(paths.macBin)) {
      throw new Error(`--skip-build requires an already-built binary at ${paths.macBin}`);
    }
  }

  const manifest =
    opts.attach !== undefined
      ? await (async () => {
          const endpoint = resolveAttachedEndpoint(opts.attach ?? "");
          const client = await VdpWsClient.connect(endpoint, 10_000);
          try {
            const driver = createWsVdpDriver(client);
            return await runScenarios(scenarios, {
              transport: client,
              driver,
              outDir: opts.outDir,
              mode: "attached",
              themes: opts.themes,
              viewport,
              keepGoing: opts.keepGoing,
            });
          } finally {
            client.close();
          }
        })()
      : await withVdpWsSandbox(
          {
            prefix: "vv-vdp-dsl-",
            logTag: "vdp",
            paths,
            outDir: opts.outDir,
            keepSandbox: opts.keepSandbox,
            requireWorkbenchReady: true,
          },
          async ({ client, driver }) =>
            runScenarios(scenarios, {
              transport: client,
              driver,
              outDir: opts.outDir,
              mode: "sandbox",
              themes: opts.themes,
              viewport,
              keepGoing: opts.keepGoing,
            }),
        );

  const { manifestPath, htmlPath } = writeScenarioArtifacts(opts.outDir, manifest);
  const sec = (manifest.durationMs / 1000).toFixed(2);
  console.log(
    `vdp: ${manifest.summary.passedScenarios}/${manifest.summary.totalScenarios} scenario(s) passed, ` +
      `${manifest.summary.totalShots} shots, ${manifest.summary.totalErrors} shell errors in ${sec}s`,
  );
  console.log(`vdp: manifest -> ${manifestPath}`);
  console.log(`vdp: gallery  -> ${htmlPath}`);

  if (opts.open) {
    spawnSync("open", [htmlPath], { stdio: "ignore" });
  }

  if (!manifest.summary.allPassed) {
    for (const s of manifest.scenarios) {
      if (!s.passed) {
        console.error(`vdp: FAILED ${s.id}: ${s.error ?? "shell/check errors recorded"}`);
      }
    }
    process.exit(1);
  }
}

const isEntrypoint = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
