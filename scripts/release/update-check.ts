import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";

import { z } from "zod";

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
const dir = await mkdtemp(join(tmpdir(), "vibevalley-update-"));
const app = join(dir, "VibeValley.app");
const version = (bundle: string) =>
  execFileSync("/usr/libexec/PlistBuddy", ["-c", "Print :VibeValleyVersion", join(bundle, "Contents/Info.plist")], { encoding: "utf8" }).trim();
const before = version(source);
if (before === release.version) throw new Error("Use two different package versions");
await cp(source, app, { recursive: true });
await mkdir(join(dir, "home"));
await mkdir(join(dir, "work"));
const steps = join(dir, "steps.jsonl");
await writeFile(steps, '{"shell":"wait_update"}\n{"shell":"quit"}\n');
const server = createServer((req, res) => {
  const path = req.url === "/release.json" ? manifest : req.url === `/${build.file}` ? zip : undefined;
  if (!path) {
    res.writeHead(404).end();
    return;
  }
  createReadStream(path)
    .on("error", () => res.destroy())
    .pipe(res);
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
  VIBEVALLEY_HOME: join(dir, "home"),
  VIBEVALLEY_WORK_ROOT: join(dir, "work"),
  VIBEVALLEY_STORE: join(dir, "state.db"),
  VIBEVALLEY_NO_OPENING: "1",
  VIBEVALLEY_PORT: "0",
  VIBEVALLEY_UPDATE_FEED: `http://127.0.0.1:${address.port}/release.json`,
  VIBEVALLEY_DEBUG_SCRIPT: steps,
  VIBEVALLEY_DEBUG_DUMP: join(dir, "dump.json"),
});
let child: ChildProcess | undefined;
let log = "";
async function launch(timeout: number) {
  child = spawn(join(app, "Contents/MacOS/VibeValley"), [], { cwd: join(dir, "work"), env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout?.on("data", (b: Buffer) => {
    log += b.toString();
  });
  child.stderr?.on("data", (b: Buffer) => {
    log += b.toString();
  });
  await new Promise<void>((accept, reject) => {
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
}
try {
  await launch(150_000);
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
    [{ shell: 'hosted:vv {"route":"/issues"}' }, { shell: "wait:1500" }, { shell: "quit" }].map((step) => JSON.stringify(step)).join("\n") + "\n",
  );
  env.VIBEVALLEY_UPDATE_FEED = "off";
  await launch(30_000);
  const dump = z
    .object({ loaded: z.boolean(), load_error: z.string().nullish() })
    .loose()
    .parse(JSON.parse(await readFile(join(dir, "dump.json"), "utf8")));
  if (!dump.loaded || dump.load_error != null) throw new Error("The updated app did not load its workspace");
  await stat(join(app, "Contents/Resources/ui/bundle.js"));
  await writeFile(join(dir, "result.json"), JSON.stringify({ ok: true, before, after, restarted: true, signatureVerified: true, evidence: dir }, null, 2));
  console.log(`Update and restart passed: ${before} -> ${after}\nEvidence: ${dir}`);
} finally {
  if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  server.closeAllConnections();
  await new Promise<void>((accept) => server.close(() => accept()));
  await writeFile(join(dir, "app.log"), log);
  console.log(`Update evidence retained at ${dir}`);
}
