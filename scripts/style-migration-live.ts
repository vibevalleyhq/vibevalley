/* oxlint-disable no-await-in-loop -- Each pass restores one stopped database and captures the same ordered interactions without concurrent mutations. */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import {
  closeSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { chromium, expect, type Browser, type Page } from "@playwright/test";
import sharp from "sharp";

import { defaultOrchestrator, readStream, statePath, VibeValleyApi, type StateFrame } from "@vibevalley/protocol";

import { buildEvidence, fileEvidence, type FileEvidence, type MigrationReceipt, type ScenarioReceipt } from "./style-migration-evidence";
import { hash, migrationInputs, migrationOutput, migrationRoot, sourceInputs } from "./style-migration-inputs";
import { comparePixels } from "./style-migration-pixels";
import { liveAreas, liveScenarios } from "./style-migration-scenes";
import { readyAddress } from "./verify-server";

const clock = "2026-11-08T12:00:00.000Z";
const browserArgs = ["--disable-skia-runtime-opts", "--disable-partial-raster", "--num-raster-threads=1", "--force-color-profile=srgb"];
const phases = ["before", "repeat", "after"] as const;
type Phase = (typeof phases)[number];
type Area = (typeof liveAreas)[number];
interface Scene {
  id: string;
  area: Area;
  theme: "light" | "dark";
  width: number;
}
interface Seed {
  repo: string;
  agent: string;
  issue: string;
  channel: string;
  artifact: string;
  image: string;
  knowledge: string;
}
interface Capture {
  image: FileEvidence;
  details: FileEvidence;
}
const scenes: Scene[] = liveAreas.flatMap((area) =>
  (["light", "dark"] as const).flatMap((theme) => [1440, 390].map((width) => ({ id: `${area}-${theme}-${width}`, area, theme, width }))),
);

function json(path: string, value: unknown): FileEvidence {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
  return fileEvidence(path);
}

function inventory(root: string) {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() || entry.isSymbolicLink())
    .map((entry) => {
      const path = join(entry.parentPath, entry.name);
      const stat = lstatSync(path);
      return { path: relative(root, path), mode: stat.mode, hash: hash(entry.isSymbolicLink() ? `symlink:${readlinkSync(path)}` : readFileSync(path)) };
    })
    .toSorted((a, b) => a.path.localeCompare(b.path));
}

async function firstFrame(api: VibeValleyApi): Promise<StateFrame> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(new Error("No live frame within 20 seconds")), 20_000);
  try {
    return await new Promise<StateFrame>((resolve, reject) => {
      void readStream(
        api.base,
        statePath,
        (frame) => {
          resolve(frame);
          abort.abort();
        },
        abort.signal,
      ).then(() => reject(new Error("State stream ended without a frame")), reject);
    });
  } finally {
    clearTimeout(timer);
    abort.abort();
  }
}

class Sandbox {
  readonly root = mkdtempSync(join(tmpdir(), "vibevalley-style-live-"));
  readonly home = join(this.root, "home");
  readonly work = join(this.root, "work");
  readonly osHome = join(this.root, "os-home");
  private child: ChildProcess | undefined;
  private exited: Promise<void> | undefined;
  private port = "0";
  private readonly evidence: string;
  constructor(evidence: string) {
    this.evidence = evidence;
    for (const path of [this.home, this.work, this.osHome]) mkdirSync(path);
  }
  async start(web: string, label: string) {
    if (this.child) throw new Error("Stop the server before restoring or restarting it");
    const server = join(migrationRoot, "apps/server");
    const starters: unknown = JSON.parse(readFileSync(join(server, "src/agent/templates/index.json"), "utf8"));
    if (!Array.isArray(starters) || !starters.every((id) => typeof id === "string")) throw new Error("Invalid starter index");
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key, value]) => value !== undefined && ["PATH", "LANG", "LC_ALL", "TMPDIR"].includes(key)),
    );
    const stdout = openSync(join(this.evidence, `${label}.stdout.log`), "w");
    const stderr = openSync(join(this.evidence, `${label}.stderr.log`), "w");
    const child = spawn(join(server, "node_modules/.bin/vpx"), ["src/main.ts", "--ready-json", "--web", web], {
      cwd: server,
      detached: true,
      stdio: ["ignore", "pipe", stderr],
      env: {
        ...env,
        HOME: this.osHome,
        XDG_CONFIG_HOME: join(this.osHome, "config"),
        XDG_CACHE_HOME: join(this.osHome, "cache"),
        XDG_DATA_HOME: join(this.osHome, "data"),
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        NODE_OPTIONS: `--import=${pathToFileURL(join(migrationRoot, "scripts/style-migration-clock.mjs")).href}`,
        TZ: "UTC",
        GIT_AUTHOR_DATE: clock,
        GIT_COMMITTER_DATE: clock,
        VIBEVALLEY_HOME: this.home,
        VIBEVALLEY_WORK_ROOT: this.work,
        VIBEVALLEY_PORT: this.port,
        VIBEVALLEY_LAN_PORT: "0",
        VIBEVALLEY_VOICE_LINE_PORT: "0",
        VIBEVALLEY_PATROL_HEARTBEAT_MINUTES: "0",
        VIBEVALLEY_TEST_RUNTIMES: "1",
        VIBEVALLEY_AGENT_STARTERS: starters.filter((id) => id !== "orchestrator").join(","),
        NO_PROXY: "127.0.0.1,localhost,::1",
        no_proxy: "127.0.0.1,localhost,::1",
      },
    });
    closeSync(stderr);
    this.child = child;
    this.exited = new Promise<void>((resolve) => {
      child.once("close", () => {
        closeSync(stdout);
        resolve();
      });
    });
    const lines = createInterface({ input: child.stdout! });
    const url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Server readiness timeout: ${label}`)), 60_000);
      const fail = (error: Error) => {
        clearTimeout(timer);
        reject(error);
      };
      child.once("error", fail);
      child.once("exit", (code) => fail(new Error(`Server exited ${code}: ${label}`)));
      lines.on("line", (line) => {
        writeFileSync(stdout, line + "\n");
        const url = child.pid === undefined ? undefined : readyAddress(line, child.pid);
        if (url) {
          clearTimeout(timer);
          json(join(this.evidence, `${label}.ready.json`), JSON.parse(line));
          resolve(url);
        }
      });
    });
    this.port = new URL(url).port;
    const api = new VibeValleyApi(url);
    const deadline = Date.now() + 30_000;
    while (true) {
      try {
        const response = await fetch(`${url}/api/v1/server/health/get`, { method: "POST", signal: AbortSignal.timeout(1000) });
        const health: unknown = await response.json();
        if (response.ok && typeof health === "object" && health !== null && "ok" in health && health.ok === true) {
          json(join(this.evidence, `${label}.health.json`), health);
          break;
        }
      } catch (error) {
        if (Date.now() >= deadline) throw error;
      }
      if (Date.now() >= deadline) throw new Error(`Health timeout: ${label}`);
      await sleep(100);
    }
    return api;
  }
  async stop() {
    const child = this.child;
    if (!child) return;
    const signal = (signal: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal);
      } catch (error) {
        if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH")) throw error;
      }
    };
    signal("SIGTERM");
    const kill = setTimeout(() => signal("SIGKILL"), 30_000);
    try {
      await this.exited;
    } finally {
      clearTimeout(kill);
    }
    if (child.pid !== undefined) {
      try {
        process.kill(-child.pid, 0);
        throw new Error(`Owned server process group ${child.pid} survived shutdown`);
      } catch (error) {
        if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH")) throw error;
      }
    }
    this.child = undefined;
    this.exited = undefined;
  }
  snapshot(destination: string) {
    if (this.child) throw new Error("Snapshot requires a stopped server");
    mkdirSync(destination);
    for (const name of ["home", "work", "os-home"])
      cpSync(join(this.root, name), join(destination, name), { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
  }
  restore(snapshot: string) {
    if (this.child) throw new Error("Restore requires a stopped server");
    for (const name of ["home", "work", "os-home"]) {
      rmSync(join(this.root, name), { recursive: true, force: true });
      cpSync(join(snapshot, name), join(this.root, name), { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
    }
  }
  remove() {
    if (this.child) throw new Error(`Server not stopped; preserving ${this.root}`);
    rmSync(this.root, { recursive: true, force: true });
  }
}

async function seed(api: VibeValleyApi, destination: string): Promise<Seed> {
  await api.setting.update({ locale: "en" });
  const repo = await api.repo.create({ name: "migration-garden" });
  const template = (await api.agent.list()).find((agent) => agent.role === "worker" && agent.runtime === "pi");
  if (!template) throw new Error("Scripted pi starter is required");
  const agent = await api.agent.create({
    ...template,
    id: "",
    name: "Migration gardener",
    effort: "",
    model: "",
    duty: "Keep the garden accessible at every screen width",
  });
  await api.memory.create({ agent: agent.id, repo: repo.name, text: "Use the same restored garden for every visual comparison." });
  await api.memory.create({ agent: defaultOrchestrator, text: "Review the migration garden before harvesting." });
  const issue = await api.issue.create({
    title: "提交打卡页",
    repo: repo.name,
    agent: agent.id,
    description: "A populated review item for migration evidence.",
  });
  await api.issue.status.update({ id: issue.id, status: "todo" });
  const deadline = Date.now() + 60_000;
  while (!(await api.issue.get({ id: issue.id })).stage.acts.some((act) => act.act === "complete")) {
    if (Date.now() >= deadline) throw new Error("Scripted helper did not hand back the review issue");
    await sleep(200);
  }
  await api.issue.create({
    title: "Document the garden paths",
    repo: repo.name,
    agent: agent.id,
    description: "Keep readable labels in the desktop and narrow layouts.",
  });
  const channelName = "migration-garden";
  const channel = await api.channel.create({ name: channelName, repo: repo.name, description: "Shared migration review, attachments and notes" });
  await api.channel.default.set({ id: channel });
  const png = await sharp(
    Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><rect width="120" height="80" fill="#d9edc5"/><path d="M60 65V20M60 40L35 25M60 48L85 30" stroke="#375b31" stroke-width="5"/></svg>',
    ),
  )
    .png()
    .toBuffer();
  const image = await api.attachment.create({ name: "garden.png", type: "image/png", data: png.toString("base64") });
  await api.channel.message.send({ id: channel, text: "Garden review: preserve these labels, attachments and spacing.", attachments: [image.id] });
  await api.channel.message.send({ id: channel, text: "Check both themes and the narrow layout before harvesting." });
  const artifact = await api.artifact.create({
    title: "Migration garden notes",
    kind: "markdown",
    content: "# Garden review\n\nPreserve readable labels and populated states.\n\n- Desktop and phone\n- Light and dark\n",
    issue: String(issue.number),
  });
  const knowledge = await api.pkm.page.save({
    title: "Migration Garden",
    tier: "project",
    props: { status: "active", deadline: "2026-12-01" },
    markdown: "- Preserve the original appearance\n- Compare the same populated garden\n  - Keep attachment bytes unchanged\n",
  });
  const connectors = await api.connector.list();
  for (const connector of connectors) await api.connector.channel.set({ id: connector.id, channel: channelName });
  await sleep(1500);
  let frame = await firstFrame(api);
  const settledBy = Date.now() + 30_000;
  while (frame.state.sessions.some((session) => session.phase._tag === "working")) {
    if (Date.now() >= settledBy) throw new Error("Seed sessions did not settle before snapshot");
    await sleep(250);
    frame = await firstFrame(api);
  }
  if (frame.inbox.length === 0) throw new Error("Seed must produce a real populated inbox");
  const data = { repo: repo.name, agent: agent.id, issue: issue.id, channel, artifact: artifact.id, image: image.id, knowledge: knowledge.slug };
  json(join(destination, "seed.json"), {
    provenance: "Public server APIs; repository scripted pi helper produces the persisted review item; no injected frames",
    data,
    frame,
    agents: await api.agent.list(),
    connectors: await api.connector.list(),
    messages: await api.channel.message.list({ id: channel }),
    memory: await api.memory.list({ agent: agent.id }),
  });
  return data;
}

function route(area: Area, data: Seed): string {
  switch (area) {
    case "workbench-issues":
      return "/issues";
    case "workbench-channel":
      return `/chat/${data.channel}`;
    case "workbench-agents":
      return "/agents";
    case "workbench-runtimes":
      return "/runtimes/pi";
    case "workbench-connectors":
      return "/settings/chat";
    case "workbench-artifacts":
      return `/artifacts/${data.artifact}`;
    case "workbench-memory":
      return `/agents/${data.agent}`;
    case "workbench-orchestrator":
      return "/orchestrator/memory";
    case "workbench-repositories":
      return "/repos";
    case "workbench-settings":
      return "/settings/general";
    case "workbench-inbox":
      return `/issues/${data.issue}`;
    case "workbench-knowledge":
      return `/pkm/${encodeURIComponent(data.knowledge)}`;
    case "workbench-pairing":
      return "/pair";
    case "farm-overlays":
      return `/farm/${data.repo}`;
    case "tree-overlays":
      return "/tree";
  }
}

async function prepare(page: Page, scene: Scene, data: Seed) {
  switch (scene.area) {
    case "workbench-issues":
      await expect(page.getByText("Document the garden paths", { exact: true }).first()).toBeVisible();
      break;
    case "workbench-channel":
      await expect(page.getByTestId("messages").getByTestId("message").filter({ hasText: "Garden review:" }).first()).toBeVisible();
      break;
    case "workbench-agents":
      await expect(page.locator(`[data-testid="agent-card"][data-key="${data.agent}"]`)).toBeVisible();
      break;
    case "workbench-runtimes":
      await expect(page.getByTestId("new-agent")).toBeVisible();
      break;
    case "workbench-connectors":
      await expect(page.getByTestId("connector-login").first()).toBeVisible();
      break;
    case "workbench-artifacts":
      await expect(page.getByTestId("artifact-blocks")).toBeVisible();
      break;
    case "workbench-memory":
      await page.locator('[role="tab"][data-key="memory"]').click();
      await expect(page.getByTestId("memory").filter({ hasText: "same restored garden" })).toBeVisible();
      break;
    case "workbench-orchestrator":
      await expect(page.getByTestId("memory").filter({ hasText: "before harvesting" })).toBeVisible();
      break;
    case "workbench-repositories":
      await expect(page.locator(`[data-testid="island"][data-key="${data.repo}"]`)).toBeVisible();
      break;
    case "workbench-settings":
      await expect(page.getByTestId("start")).toBeVisible();
      break;
    case "workbench-inbox":
      await expect(page.getByTestId("issue")).toBeVisible();
      await expect(page).toHaveTitle(/^\(\d+!/u);
      break;
    case "workbench-knowledge":
      await expect(page.getByTestId("pkm-block").first()).toBeVisible();
      break;
    case "workbench-pairing":
      await page.getByTestId("pair-name").fill("Migration garden phone");
      await expect(page.getByTestId("pair-code")).toBeVisible();
      break;
    case "farm-overlays":
      await expect(page.getByTestId("village")).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
      await page.getByTestId("phone-button").click();
      await page.getByTestId("phone-chat").click();
      await expect(page.getByTestId("farm-chat").getByTestId("message").filter({ hasText: "Garden review:" }).first()).toBeVisible();
      break;
    case "tree-overlays":
      await expect(page.getByTestId("tree-panel")).toBeVisible();
      await expect(page.getByTestId("tree-panel").locator("li").first()).toBeVisible();
      break;
  }
}

async function capture(browser: Browser, api: VibeValleyApi, scene: Scene, data: Seed, directory: string): Promise<Capture> {
  const context = await browser.newContext({
    viewport: { width: scene.width, height: scene.width === 390 ? 844 : 1000 },
    locale: "en-US",
    timezoneId: "UTC",
    deviceScaleFactor: 1,
    colorScheme: scene.theme,
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => {
    if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
  });
  page.on("requestfailed", (request) => {
    if (request.failure()?.errorText !== "net::ERR_ABORTED") errors.push(`${request.url()}: ${request.failure()?.errorText}`);
  });
  const destination = join(directory, `${scene.id}.png`);
  try {
    await page.clock.setFixedTime(new Date(clock));
    await page.addInitScript((theme) => localStorage.setItem("vibevalley.prefs", JSON.stringify({ theme, scale: 100, start: "workbench" })), scene.theme);
    const response = await page.goto(api.base + route(scene.area, data), { waitUntil: "load" });
    if (response?.status() !== 200) throw new Error(`Entry returned ${response?.status()}`);
    await expect(page.locator("#opening")).toHaveCount(0);
    await expect(page.locator("html")).toHaveAttribute("data-theme", scene.theme);
    await prepare(page, scene, data);
    await page.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all(
        [...document.querySelectorAll<HTMLImageElement>("img[src]")].map((image) => {
          image.loading = "eager";
          return image.decode();
        }),
      );
    });
    await page.waitForTimeout(1200);
    const target =
      scene.area === "farm-overlays" ? page.getByTestId("farm-chat") : scene.area === "tree-overlays" ? page.getByTestId("tree-panel") : page.locator("body");
    const text = await target.innerText();
    if (text.trim().length === 0) throw new Error("Empty live capture target");
    if (scene.area.endsWith("overlays")) await target.screenshot({ path: destination, animations: "disabled" });
    else await page.screenshot({ path: destination, animations: "disabled" });
    if (errors.length > 0) throw new Error(errors.join("\n"));
    const details = json(join(directory, `${scene.id}.json`), {
      scene,
      url: page.url(),
      target: scene.area.endsWith("overlays") ? "populated DOM overlay only; no canvas equivalence claim" : "viewport",
      provenance:
        scene.area === "tree-overlays" ? "production-built-in-demo (TreePage mockTree); no injected frames" : "public API seeded, restored real server",
      text,
      fonts: await page.evaluate(() => [...document.fonts].map((font) => ({ family: font.family, status: font.status }))),
      errors,
    });
    return { image: fileEvidence(destination), details };
  } catch (error) {
    await page.screenshot({ path: join(directory, `${scene.id}.failure.png`), animations: "disabled" }).catch(() => undefined);
    json(join(directory, `${scene.id}.failure.json`), { error: String(error), errors, url: page.url() });
    throw error;
  } finally {
    await context.close();
  }
}

const args = parseArgs({ options: { baseline: { type: "string" } } });
if (!args.values.baseline)
  throw new Error(
    "Usage: vpx scripts/style-migration-live.ts --baseline <clean original checkout>. Candidate app and all four graph builds must already exist.",
  );
if (process.platform === "win32") throw new Error("Live migration sandbox requires Unix process groups");
const baseline = resolve(args.values.baseline);
if (baseline === migrationRoot) throw new Error("Candidate cannot be its own baseline");
if (execFileSync("git", ["status", "--porcelain"], { cwd: baseline, encoding: "utf8" }).trim()) throw new Error("Baseline checkout must be clean");
const baselineInputs = sourceInputs(baseline);
const candidateInputs = migrationInputs();
const receipt: MigrationReceipt = {
  schemaVersion: 1,
  kind: "live",
  createdAt: new Date().toISOString(),
  status: "failed",
  inputs: candidateInputs,
  builds: [],
  baseline: baselineInputs,
  expected: liveScenarios,
  executed: [],
  skipped: [],
  errors: [],
};
mkdirSync(migrationOutput, { recursive: true });
const run = mkdtempSync(join(migrationOutput, "live-run-"));
const sandbox = new Sandbox(run);
const candidateWeb = join(migrationRoot, "apps/web/dist");
const baselineWeb = join(baseline, "apps/web/dist");
let browser: Browser | undefined;
let interrupted = false;
const interrupt = () => {
  interrupted = true;
  void browser?.close().catch(() => undefined);
};
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
try {
  receipt.builds = buildEvidence();
  if (!existsSync(join(candidateWeb, "index.html"))) throw new Error("Build the candidate app before live evidence");
  execFileSync("vp", ["run", "--no-cache", "--filter", "@vibevalley/web", "build"], { cwd: baseline, stdio: "inherit" });
  if (!existsSync(join(baselineWeb, "index.html"))) throw new Error(`Missing original build: ${baselineWeb}`);
  const builds = json(join(run, "web-builds.json"), {
    baseline: { inputs: baselineInputs, path: baselineWeb, files: inventory(baselineWeb) },
    candidate: { inputs: candidateInputs, path: candidateWeb, files: inventory(candidateWeb) },
    clock,
    browserArgs,
  });
  const api = await sandbox.start(candidateWeb, "seed");
  const data = await seed(api, run);
  await sandbox.stop();
  const snapshotDirectory = join(run, "snapshot");
  sandbox.snapshot(snapshotDirectory);
  const snapshot = json(join(run, "snapshot.json"), inventory(snapshotDirectory));
  const fixtures = new Map<Phase, FileEvidence>();
  const captures = new Map<string, Partial<Record<Phase, Capture>>>();
  browser = await chromium.launch({ args: browserArgs });
  for (const phase of phases) {
    if (interrupted) throw new Error("Live evidence interrupted");
    sandbox.restore(snapshotDirectory);
    const fixture = json(join(run, `${phase}.fixture.json`), inventory(sandbox.root));
    if (fixture.hash !== snapshot.hash) throw new Error(`Restored database/files differ before ${phase}`);
    fixtures.set(phase, fixture);
    const directory = join(run, phase);
    mkdirSync(directory);
    const live = await sandbox.start(phase === "after" ? candidateWeb : baselineWeb, phase);
    json(join(directory, "frame.json"), await firstFrame(live));
    for (const scene of scenes) {
      try {
        const result = await capture(browser, live, scene, data, directory);
        const captured = captures.get(scene.id) ?? {};
        captured[phase] = result;
        captures.set(scene.id, captured);
      } catch (error) {
        receipt.errors.push(`${phase}/${scene.id}: ${String(error)}`);
      }
    }
    await sandbox.stop();
  }
  for (const scene of scenes) {
    const captured = captures.get(scene.id);
    const scenario: ScenarioReceipt = { id: scene.id, status: "failed", evidence: [builds, fileEvidence(join(run, "seed.json"))] };
    if (captured?.before && captured.repeat && captured.after) {
      const aa = await comparePixels(captured.before.image.path, captured.repeat.image.path, join(run, `${scene.id}.aa-diff.png`));
      const ab = await comparePixels(captured.before.image.path, captured.after.image.path, join(run, `${scene.id}.ab-diff.png`));
      const comparison = json(join(run, `${scene.id}.comparison.json`), { aa, ab });
      scenario.visual = { before: captured.before.image, repeat: captured.repeat.image, after: captured.after.image };
      scenario.fixture = { snapshot, before: fixtures.get("before")!, repeat: fixtures.get("repeat")!, after: fixtures.get("after")! };
      scenario.evidence.push(
        comparison,
        captured.before.details,
        captured.repeat.details,
        captured.after.details,
        ...[aa.diff, ab.diff].flatMap((path) => (path === null ? [] : [fileEvidence(path)])),
      );
      scenario.status = aa.passed && ab.passed ? "passed" : "failed";
      if (!aa.passed) receipt.errors.push(`Unstable A/A: ${scene.id}`);
      if (!ab.passed) receipt.errors.push(`Changed A/B pixels: ${scene.id}`);
    } else scenario.error = "A capture failed; see phase failure JSON and server logs";
    receipt.executed.push(scenario);
  }
  if (sourceInputs(baseline).digest !== baselineInputs.digest || migrationInputs().digest !== candidateInputs.digest)
    throw new Error("Sources changed during live evidence");
  if (JSON.stringify(buildEvidence()) !== JSON.stringify(receipt.builds)) throw new Error("Build graphs changed during live evidence");
  receipt.status = receipt.errors.length === 0 && receipt.executed.every((scenario) => scenario.status === "passed") ? "passed" : "failed";
} catch (error) {
  receipt.errors.push(String(error));
} finally {
  try {
    await browser?.close();
  } catch (error) {
    receipt.status = "failed";
    receipt.errors.push(`Browser cleanup: ${String(error)}`);
  }
  try {
    await sandbox.stop();
    sandbox.remove();
  } catch (error) {
    receipt.status = "failed";
    receipt.errors.push(`Server cleanup: ${String(error)}; preserved sandbox ${sandbox.root}`);
  }
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", interrupt);
  json(join(migrationOutput, "live.json"), receipt);
  console.log(`live migration evidence: ${run}`);
  if (receipt.status !== "passed") process.exitCode = 1;
}
