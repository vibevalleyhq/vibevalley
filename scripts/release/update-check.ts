import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";

import { z } from "zod";

import { pathOf } from "@vibevalley/protocol";

import { retainedUpdateData, seedUpdateIssue } from "./update-data.ts";

const { values } = parseArgs({ options: { from: { type: "string" }, to: { type: "string" } } });
if (!values.from || !values.to) throw new Error("update-check --from <old/VibeValley.app> --to <new/release.json>");
const source = resolve(values.from);
const manifest = resolve(values.to);
const release = z
  .object({ version: z.string(), builds: z.array(z.object({ arch: z.string(), file: z.string(), size: z.number(), sha512: z.string() })) })
  .parse(JSON.parse(await readFile(manifest, "utf8")));
const build = release.builds.find((b) => b.arch === (process.arch === "arm64" ? "arm64" : "x64"));
if (!build || basename(build.file) !== build.file) throw new Error("No local architecture in release.json");
const zip = resolve(manifest, "..", build.file);
const bytes = await readFile(zip);
if (bytes.length !== build.size || createHash("sha512").update(bytes).digest("hex") !== build.sha512) throw new Error("release.json does not match its zip");
const dir = await realpath(await mkdtemp(join(tmpdir(), "vibevalley-update-")));
const app = join(dir, "VibeValley.app");
const version = (bundle: string) =>
  execFileSync("/usr/libexec/PlistBuddy", ["-c", "Print :VibeValleyVersion", join(bundle, "Contents/Info.plist")], { encoding: "utf8" }).trim();
const before = version(source);
if (before === release.version) throw new Error("Use two different package versions");
await cp(source, app, { recursive: true });
await mkdir(join(dir, "home"));
await mkdir(join(dir, "work"));
await mkdir(join(dir, "user"));
const steps = join(dir, "steps.jsonl");
const project = join(dir, "retained-project");
await mkdir(project);
await writeFile(
  steps,
  [{ type: "activate_path", path: project }, { shell: "save" }, { shell: "wait_update" }, { shell: "quit" }].map((step) => JSON.stringify(step)).join("\n") +
    "\n",
);
let allowUpdateFeed: (() => void) | undefined;
const oldDataReady = new Promise<void>((resolve) => {
  allowUpdateFeed = resolve;
});
const server = createServer((req, res) => {
  const path = req.url === "/release.json" ? manifest : req.url === `/${build.file}` ? zip : undefined;
  if (!path) {
    res.writeHead(404).end();
    return;
  }
  void oldDataReady.then(() => {
    if (!res.destroyed)
      createReadStream(path)
        .on("error", () => res.destroy())
        .pipe(res);
  });
});
await new Promise<void>((accept, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", accept);
});
const address = server.address();
if (address === null || typeof address === "string") throw new Error("No loopback update server");
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith("VIBEVALLEY_") && !/API_KEY|TOKEN|SECRET|PASSWORD|CERTIFICATE/u.test(key)),
);
Object.assign(env, {
  HOME: join(dir, "user"),
  VIBEVALLEY_HOME: join(dir, "home"),
  VIBEVALLEY_WORK_ROOT: join(dir, "work"),
  VIBEVALLEY_STORE: join(dir, "state.db"),
  VIBEVALLEY_NO_OPENING: "1",
  VIBEVALLEY_PORT: "0",
  VIBEVALLEY_VOICE_LINE_PORT: "0",
  VIBEVALLEY_TEST_RUNTIMES: "1",
  VIBEVALLEY_AGENT_STARTERS: "docs",
  VIBEVALLEY_PATROL_HEARTBEAT_MINUTES: "0",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Upgrade test",
  GIT_COMMITTER_NAME: "Upgrade test",
  GIT_AUTHOR_EMAIL: "upgrade@example.invalid",
  GIT_COMMITTER_EMAIL: "upgrade@example.invalid",
  VIBEVALLEY_UPDATE_FEED: `http://127.0.0.1:${address.port}/release.json`,
  VIBEVALLEY_DEBUG_SCRIPT: steps,
  VIBEVALLEY_DEBUG_DUMP: join(dir, "dump.json"),
});
let child: ChildProcess | undefined;
let log = "";
async function launch(timeout: number, onReady: (url: string) => Promise<void>) {
  child = spawn(join(app, "Contents/MacOS/vibevalley-mac"), [], { cwd: join(dir, "work"), env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout?.on("data", (b: Buffer) => {
    log += b.toString();
  });
  child.stderr?.on("data", (b: Buffer) => {
    log += b.toString();
  });
  const exited = new Promise<void>((accept, reject) => {
    const timer = setTimeout(() => {
      child?.kill("SIGKILL");
      reject(new Error("Packaged app did not exit before deadline"));
    }, timeout);
    child?.once("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child?.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) accept();
      else reject(new Error(`Packaged app exited ${code}/${signal}`));
    });
  });
  const healthy = async () => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      let url: string | undefined;
      try {
        const receipt = z.object({ pid: z.number(), url: z.url() }).parse(JSON.parse(await readFile(join(dir, "home/server.json"), "utf8")));
        if (receipt.pid === child?.pid && new URL(receipt.url).hostname === "127.0.0.1") {
          const response = await fetch(receipt.url + pathOf("server.health.get"), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
            signal: AbortSignal.timeout(1000),
          });
          const health = z.object({ data: z.object({ ok: z.literal(true) }) }).safeParse(await response.json());
          if (response.ok && health.success) {
            await writeFile(join(dir, "health.json"), JSON.stringify({ ...health.data, pid: receipt.pid, url: receipt.url }));
            url = receipt.url;
          }
        }
      } catch {
        /* The new process has not announced its server yet. */
      }
      if (url !== undefined) return onReady(url);
      if (child?.exitCode !== null) throw new Error("Packaged app exited before its server became healthy");
      await delay(100);
    }
    throw new Error("Updated app server never became healthy");
  };
  await Promise.all([exited, healthy()]);
}
try {
  let retained: Awaited<ReturnType<typeof retainedUpdateData>> | undefined;
  await launch(150_000, async (url) => {
    const id = await seedUpdateIssue(url);
    retained = await retainedUpdateData(url, id, dir);
    await writeFile(join(dir, "before-data.json"), JSON.stringify(retained, null, 2));
    allowUpdateFeed?.();
  });
  if (!retained) throw new Error("The old package did not save the update test data");
  const expected = retained;
  if (!log.includes('"_tag":"ready"') || !log.includes("update ready=true")) throw new Error("The old package never staged its update");
  const deadline = Date.now() + 20_000;
  let after = before;
  while (Date.now() < deadline) {
    try {
      after = version(app);
    } catch {
      /* The old directory is being renamed. */
    }
    if (after === release.version) break;
    await delay(100);
  }
  if (after !== release.version) throw new Error("The updater did not replace the installed copy");
  execFileSync("codesign", ["--verify", "--deep", "--strict", app]);
  await writeFile(
    steps,
    [{ shell: 'hosted:vv {"route":"/issues"}' }, { shell: "wait:5000" }, { shell: "quit" }].map((step) => JSON.stringify(step)).join("\n") + "\n",
  );
  env.VIBEVALLEY_UPDATE_FEED = "off";
  await rm(join(dir, "dump.json"));
  await launch(40_000, async (url) => {
    const restored = await retainedUpdateData(url, expected.issue.id, dir);
    await writeFile(join(dir, "after-data.json"), JSON.stringify(restored, null, 2));
    if (JSON.stringify(restored) !== JSON.stringify(expected))
      throw new Error("Upgrade changed issue, conversation, workspace or Git data; compare before-data.json and after-data.json");
  });
  const view = z.object({
    view: z.string(),
    ready: z.boolean(),
    errors: z.array(z.string()),
    applied: z.array(z.object({ topic: z.string(), rev: z.number() })),
  });
  const dump = z
    .object({ loaded: z.boolean(), load_error: z.string().nullish(), workbench: view, sidebar: view })
    .parse(JSON.parse(await readFile(join(dir, "dump.json"), "utf8")));
  if (!dump.loaded || dump.load_error != null) throw new Error("The updated app did not load its workspace");
  if (
    !dump.workbench.ready ||
    dump.workbench.errors.length > 0 ||
    dump.sidebar.errors.length > 0 ||
    !dump.workbench.applied.some((frame) => frame.topic === "state")
  )
    throw new Error("The updated workspace did not apply a state frame without errors");
  await stat(join(app, "Contents/Resources/ui/bundle.js"));
  await writeFile(
    join(dir, "result.json"),
    JSON.stringify(
      {
        ok: true,
        before,
        after,
        restarted: true,
        serverHealthy: true,
        signatureVerified: true,
        retainedIssue: expected.issue.id,
        retainedRuns: expected.recorded.length,
        retainedProject: expected.project.id,
        evidence: dir,
      },
      null,
      2,
    ),
  );
  console.log(`Update and restart passed: ${before} -> ${after}\nEvidence: ${dir}`);
} finally {
  if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  allowUpdateFeed?.();
  server.closeAllConnections();
  await new Promise<void>((accept) => server.close(() => accept()));
  await writeFile(join(dir, "app.log"), log);
  console.log(`Update evidence retained at ${dir}`);
}
