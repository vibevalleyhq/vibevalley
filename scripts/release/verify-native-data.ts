/** Exercise a cold, paired backup across two native app versions. Only loopback connections are allowed. */

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { crc32, deflateSync } from "node:zlib";

import { z } from "zod";

import { VdpWsClient, waitForVdpEndpoint } from "./vdp-client.ts";

const Envelope = z.object({ bizCode: z.number(), message: z.string().optional(), data: z.unknown().optional() });
const ReadyReceipt = z.object({ pid: z.number(), url: z.string() });
const WindowView = z.object({
  loaded: z.boolean(),
  load_error: z.unknown().nullable().optional(),
  projects: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        layout: z.looseObject({ root: z.looseObject({ node: z.string() }) }),
      }),
    )
    .optional(),
});
const IdObj = z.object({ id: z.string() });
const RepoList = z.array(z.object({ path: z.string() }));
const IssueShow = z.object({
  status: z.string().optional(),
  delivered: z.string().optional(),
  stage: z.object({ state: z.string() }),
});
const IssueRun = z.looseObject({
  id: z.string(),
  outcome: z.string().optional(),
  heard: z.array(z.string()).default([]),
});
const IssueDiff = z.object({
  files: z.array(z.object({ path: z.string() })),
  revision: z.object({ baseCommit: z.string(), tree: z.string() }),
});
const ChannelRow = z.object({ id: z.string(), type: z.string() });
const ChannelMsg = z.object({ text: z.string() });
const AgentRow = z.object({ id: z.string(), name: z.string().optional() });
const MemoryList = z.object({ memories: z.array(IdObj) });
const NoteShow = z.object({ title: z.string() });
const NoteRead = z.object({ content: z.string() });
const AttachmentGet = z.object({ data: z.string() });
const LibraryRow = z.object({ attachment: IdObj });
const MediaInput = z.object({ id: z.string(), hash: z.string().optional() });
const MediaJob = z.object({ id: z.string(), phase: z.string(), attachment: IdObj.optional() });
const StateOut = z.object({ state: z.object({ issues: z.array(IdObj) }) });
const ConnectorRow = z.looseObject({ id: z.string(), state: z.string(), pending: z.number() });
const ConnectorFixture = z.object({
  tables: z.object({
    connector_account: z.array(z.record(z.string(), z.unknown())),
    connector_inbound: z.array(z.record(z.string(), z.unknown())),
    connector_outbox: z.array(z.record(z.string(), z.unknown())),
  }),
});

function assert(condition: unknown, message: string): asserts condition {
  if (condition === false || condition === null || condition === undefined || condition === "") {
    throw new Error(message);
  }
}

async function waitFor<T>(label: string, read: () => T | undefined | false, timeoutSec = 50): Promise<T> {
  const until = Date.now() + timeoutSec * 1_000;
  while (Date.now() < until) {
    const value = read();
    if (value !== undefined && value !== false) return value;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function digest(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink() || entry.isFile()) {
      out.push(full);
    } else if (entry.isDirectory()) {
      out.push(...walkFiles(full));
    }
  }
  return out;
}

function manifest(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of walkFiles(root).toSorted()) {
    const rel = relative(root, p);
    out[rel] = lstatSync(p).isSymbolicLink() ? `link ${readlinkSync(p)}` : digest(p);
  }
  return out;
}

function assertEqualJson(actual: unknown, expected: unknown, label: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${label} mismatch:\nactual:   ${a}\nexpected: ${b}`);
}

function readDb<T>(path: string, query: string, parseRow: (row: unknown) => T, ...params: SQLInputValue[]): T[] {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db
      .prepare(query)
      .all(...params)
      .map(parseRow);
  } finally {
    db.close();
  }
}

function pngChunk(kind: string, data: Uint8Array): Buffer {
  const type = Buffer.from(kind, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([type, data])) >>> 0, 0);
  return Buffer.concat([len, type, data, crc]);
}

function samplePng(): Buffer {
  const ihdr = Buffer.from([0, 0, 1, 0, 0, 0, 1, 0, 8, 2, 0, 0, 0]);
  const raw = Buffer.alloc((1 + 256 * 3) * 256);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function git(path: string, ...args: string[]): string {
  return execFileSync("/usr/bin/git", ["-C", path, ...args], { encoding: "utf8" }).trim();
}

class Client {
  readonly url: string;
  readonly exe: string;
  readonly env: Record<string, string>;

  constructor(url: string, exe: string, env: Record<string, string>) {
    this.url = url;
    this.exe = exe;
    this.env = env;
  }

  async call(op: string, payload: unknown = null): Promise<unknown> {
    const response = await fetch(`${this.url}/api/v1/${op.replaceAll(".", "/")}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) throw new Error(`${op}: HTTP ${response.status}`);
    const envelope = Envelope.parse(await response.json());
    if (envelope.bizCode !== 0) {
      throw new Error(`${op} refused: ${envelope.message ?? JSON.stringify(envelope)}`);
    }
    return envelope.data;
  }

  cli(...args: string[]): unknown {
    const stdout = execFileSync(this.exe, ["--json", ...args], {
      encoding: "utf8",
      timeout: 30_000,
      env: { ...this.env, VIBEVALLEY_SERVER: this.url },
    });
    return JSON.parse(stdout);
  }
}

async function stopProcess(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  const exited = new Promise<void>((done) => {
    proc.once("exit", () => done());
  });
  proc.kill("SIGTERM");
  const winner = await Promise.race([exited.then(() => "exited" as const), sleep(12_000).then(() => "timeout" as const)]);
  if (winner === "timeout" && proc.exitCode === null && proc.signalCode === null) {
    proc.kill("SIGKILL");
    await exited;
  }
}

interface NativeLaunchStep {
  readonly method: string;
  readonly params: Record<string, unknown>;
}

async function withLaunch<T>(
  bundle: string,
  live: string,
  evidence: string,
  stage: string,
  steps: readonly NativeLaunchStep[],
  run: (client: Client, vdp: VdpWsClient) => Promise<T>,
): Promise<T> {
  const isDir = statSync(bundle).isDirectory();
  const binaries = isDir ? join(bundle, "Contents/MacOS") : dirname(bundle);
  const app = isDir ? join(binaries, "vibevalley-mac") : bundle;
  const host = join(live, "host");
  const home = join(live, "home");
  const work = join(live, "work");
  const user = join(live, "user");
  for (const dir of [host, home, work, user]) mkdirSync(dir, { recursive: true });

  const dump = join(evidence, `${stage}-window.json`);

  const env: Record<string, string> = {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    SHELL: "/bin/sh",
    HOME: user,
    LANG: "en_US.UTF-8",
    TMPDIR: evidence,
    VIBEVALLEY_HOME: home,
    VIBEVALLEY_WORK_ROOT: work,
    VIBEVALLEY_STORE: join(host, "state.db"),
    VIBEVALLEY_PORT: "0",
    VIBEVALLEY_NO_OPENING: "1",
    VIBEVALLEY_UPDATE_FEED: "off",
    VIBEVALLEY_VOICE_LINE_PORT: "0",
    VIBEVALLEY_TEST_RUNTIMES: "1",
    VIBEVALLEY_AGENT_STARTERS: "docs",
    VIBEVALLEY_PATROL_HEARTBEAT_MINUTES: "0",
    VIBEVALLEY_DEBUG_PORT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Native compatibility",
    GIT_COMMITTER_NAME: "Native compatibility",
    GIT_AUTHOR_EMAIL: "local@example.invalid",
    GIT_COMMITTER_EMAIL: "local@example.invalid",
  };

  const policy = join(evidence, "isolated.sb");
  const realHome = homedir();
  const protectedPaths = ["Library/Application Support/VibeValley", ".vibevalley", "vibevalley-dev", ".codex", ".claude"];
  writeFileSync(
    policy,
    '(version 1)(allow default)(deny network-outbound (remote ip "*:*"))(allow network-outbound (remote ip "localhost:*"))' +
      protectedPaths.map((entry) => `(deny file-read* file-write* (subpath ${JSON.stringify(join(realHome, entry))}))`).join(""),
  );

  const logFd = openSync(join(evidence, `${stage}.log`), "w");
  const startedNs = process.hrtime.bigint();
  const proc = spawn("/usr/bin/sandbox-exec", ["-f", policy, app], {
    env,
    stdio: ["ignore", logFd, logFd],
    cwd: join(work, "workspace-project"),
  });
  closeSync(logFd);

  let vdp: VdpWsClient | undefined;
  try {
    const readyUrl = await waitFor(stage, () => {
      if (proc.exitCode !== null || proc.signalCode !== null) {
        throw new Error(`${stage}: app exited ${String(proc.exitCode ?? proc.signalCode)}`);
      }
      try {
        const ready = ReadyReceipt.parse(JSON.parse(readFileSync(join(home, "server.json"), "utf8")));
        return ready.pid === proc.pid ? ready.url : undefined;
      } catch {
        return undefined;
      }
    });

    const client = new Client(readyUrl, join(binaries, "vibevalley"), env);
    const serviceMs = Number((process.hrtime.bigint() - startedNs) / 1_000_000n);

    const endpoint = await waitForVdpEndpoint({
      homeDir: home,
      ...(proc.pid !== undefined ? { expectedPid: proc.pid } : {}),
      timeoutMs: 30_000,
      appExited: () => proc.exitCode,
      logPath: join(evidence, `${stage}.log`),
    });
    vdp = await VdpWsClient.connect(endpoint, 15_000);

    const loadedDeadline = Date.now() + 30_000;
    let loadedRaw: unknown;
    while (Date.now() < loadedDeadline) {
      const raw = await vdp.call("Shell.getState", {});
      const view = WindowView.safeParse(raw);
      if (view.success && view.data.loaded && view.data.load_error == null) {
        loadedRaw = raw;
        break;
      }
      await sleep(50);
    }
    if (loadedRaw === undefined) {
      throw new Error(`${stage}: timed out waiting for loaded native window`);
    }

    for (const step of steps) {
      await vdp.call(step.method, step.params);
    }
    const finalState = await vdp.call("Shell.getState", {});
    writeFileSync(dump, JSON.stringify(finalState, null, 2) + "\n");

    const times = { serviceReadyMs: serviceMs, windowReadyMs: Number((process.hrtime.bigint() - startedNs) / 1_000_000n) };
    writeFileSync(join(evidence, `${stage}-startup.json`), JSON.stringify(times));
    return await run(client, vdp);
  } finally {
    vdp?.close();
    await stopProcess(proc);
  }
}

async function waitForWindowState(label: string, vdp: VdpWsClient, dumpPath: string, timeoutSec = 50): Promise<{ id: string; layout: unknown }> {
  const until = Date.now() + timeoutSec * 1_000;
  while (Date.now() < until) {
    try {
      const raw = await vdp.call("Shell.getState", {});
      writeFileSync(dumpPath, JSON.stringify(raw, null, 2) + "\n");
      const view = WindowView.parse(raw);
      if (view.loaded && view.load_error == null) {
        const project = (view.projects ?? []).find((p) => p.name === "workspace-project");
        if (project && project.layout.root.node === "split") {
          return { id: project.id, layout: project.layout };
        }
      }
    } catch {
      // Keep polling until the split layout finishes persisting.
    }
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${label}`);
}

interface SeedIds {
  issue: string;
  run: string;
  repo: string;
  base: string;
  channel: string;
  agent: string;
  memory: string;
  note: string;
  attachment: string;
  mediaInput: string;
  mediaJob: string;
  mediaPhase: string;
  generatedAttachment: string;
  cron: string;
}

async function seedOld(c: Client): Promise<SeedIds> {
  c.cli("repo", "create", "demo");
  const issue = IdObj.parse(c.cli("issue", "create", "写打卡并提交", "--repo", "demo", "--agent", "docs")).id;
  c.cli("issue", "status", issue, "todo");
  await waitFor("old helper report", () => IssueShow.parse(c.cli("issue", "show", issue)).stage.state === "reviewing");

  const channels = z.array(ChannelRow).parse(c.cli("channel", "list"));
  const general = channels.find((ch) => ch.type === "channel")?.id;
  assert(general !== undefined, "missing default channel");
  c.cli("channel", "message", "send", general, "checkpoint-old", "--send-key", "checkpoint-old");

  const profile = z.array(AgentRow).parse(c.cli("agent", "list"));
  const agent = profile.find((p) => p.id === "docs" || p.name === "docs")?.id;
  assert(agent !== undefined, "missing docs agent");
  const memory = IdObj.parse(c.cli("memory", "create", agent, "retain old note", "--key", "legacy-note"));
  const note = IdObj.parse(
    c.cli(
      "note",
      "create",
      "Checkpoint",
      "--type",
      "doc",
      "--content",
      JSON.stringify({ version: 1, blocks: [{ id: "b1", type: "prose", text: "old note" }] }),
    ),
  );

  const tmpDir = c.env.TMPDIR;
  assert(tmpDir !== undefined, "missing TMPDIR");
  const pngFile = join(tmpDir, "old.png");
  writeFileSync(pngFile, samplePng());
  const attachment = IdObj.parse(c.cli("attachment", "upload", pngFile, "--name", "old.png", "--mime", "image/png"));
  c.cli("library", "add", "--attachment", attachment.id);
  const mediaInput = MediaInput.parse(await c.call("media.input.adopt", { attachment: attachment.id }));

  await c.call("provider.update", {
    revision: 0,
    connections: [{ id: "offline", name: "Offline fixture", adapter: "moss", enabled: true, key: "local-fixture-only" }],
    image: { connection: "offline", model: "moss-image-base-1.0" },
    speech: null,
    understanding: null,
    live: null,
    speakers: null,
    voiceDesign: null,
    transcription: null,
    vision: null,
  });

  const due = new Date(Date.now() + 86_400_000).toISOString().replace(/\.\d{3}Z$/u, "Z");
  const cron = IdObj.parse(c.cli("cron", "create", "checkpoint schedule", "Review fixture", "--agent", "docs", "--repo", "demo", "--at", due));
  const job = IdObj.parse(
    await c.call("media.image.create", {
      id: "offline-image",
      prompt: "offline fixture",
      format: "text",
      width: 256,
      height: 256,
      enhance: false,
      watermark: true,
    }),
  );

  const media = await waitFor("offline media outcome", () => {
    const result = MediaJob.parse(c.cli("media", "job", "show", job.id));
    return result.phase !== "queued" && result.phase !== "generating" && result.phase !== "downloading" ? result : undefined;
  });
  assert(media.phase === "ready" && media.attachment !== undefined, `unexpected media phase: ${media.phase}`);
  const repo = RepoList.parse(c.cli("repo", "list"))[0]?.path;
  assert(repo !== undefined, "missing repo");
  const runs = z.array(IssueRun).parse(await c.call("issue.run.list", { id: issue }));
  const runId = runs[0]?.id;
  assert(runId !== undefined, "missing run");

  return {
    issue,
    run: runId,
    repo,
    base: git(repo, "rev-parse", "HEAD"),
    channel: general,
    agent,
    memory: memory.id,
    note: note.id,
    attachment: attachment.id,
    mediaInput: mediaInput.id,
    mediaJob: job.id,
    mediaPhase: media.phase,
    generatedAttachment: media.attachment.id,
    cron: cron.id,
  };
}

async function verifyOldContent(c: Client, ids: SeedIds): Promise<void> {
  const state = StateOut.parse(c.cli("state"));
  assert(
    state.state.issues.some((i) => i.id === ids.issue),
    "missing issue in state",
  );
  assert(IssueShow.parse(c.cli("issue", "show", ids.issue)).stage.state === "reviewing", "expected reviewing stage");
  const runs = z.array(IssueRun).parse(await c.call("issue.run.list", { id: ids.issue }));
  assert(runs[0]?.id === ids.run, "run id mismatch");
  assert(git(ids.repo, "rev-parse", "HEAD") === ids.base, "base commit mismatch");
  const diff = IssueDiff.parse(c.cli("issue", "diff", ids.issue));
  assert(
    diff.files.some((f) => f.path === "clock.ts"),
    "missing clock.ts in diff",
  );

  const messages = z.array(ChannelMsg).parse(c.cli("channel", "message", "list", ids.channel));
  assert(messages.filter((m) => m.text === "checkpoint-old").length === 1, "expected 1 checkpoint-old message");
  const memories = MemoryList.parse(c.cli("memory", "list", ids.agent)).memories;
  assert(
    memories.some((m) => m.id === ids.memory),
    "missing old memory",
  );
  assert(NoteShow.parse(c.cli("note", "show", ids.note)).title === "Checkpoint", "note title mismatch");
  assert(NoteRead.parse(c.cli("note", "read", ids.note, "--version", "1")).content.includes("old note"), "note content mismatch");

  const lib = z.array(LibraryRow).parse(c.cli("library", "list"));
  assert(
    lib.some((i) => i.attachment.id === ids.attachment),
    "missing attachment in library",
  );
  const downloaded = Buffer.from(AttachmentGet.parse(c.cli("attachment", "get", ids.attachment)).data, "base64");
  assert(createHash("sha256").update(downloaded).digest("hex") === ids.attachment, "attachment sha256 mismatch");
  const mediaInputs = z.array(MediaInput).parse(c.cli("media", "input", "list"));
  const mediaInput = mediaInputs.find((item) => item.id === ids.mediaInput);
  assert(mediaInput !== undefined && mediaInput.hash === ids.attachment, "mediaInput hash mismatch");
  const job = MediaJob.parse(c.cli("media", "job", "show", ids.mediaJob));
  assert(job.phase === ids.mediaPhase && job.attachment?.id === ids.generatedAttachment, "mediaJob mismatch");
  const crons = z.array(IdObj).parse(c.cli("cron", "list"));
  assert(
    crons.some((item) => item.id === ids.cron),
    "missing cron",
  );
  const rows = z.array(LibraryRow).parse(c.cli("library", "list", "--origin", "generated"));
  assert(
    rows.some((item) => item.attachment.id === ids.generatedAttachment),
    "missing generated attachment in library",
  );
}

function seedConnectorFixture(dbPath: string): void {
  const fixturePath = join(import.meta.dirname, "fixtures", "connector-275732ef1.json");
  const fixture = ConnectorFixture.parse(JSON.parse(readFileSync(fixturePath, "utf8")));
  const stamp = Date.now();
  const db = new DatabaseSync(dbPath);
  try {
    for (const table of ["connector_account", "connector_inbound", "connector_outbox"] as const) {
      for (const sourceRow of fixture.tables[table]) {
        const row: Record<string, SQLInputValue> = {};
        for (const [k, v] of Object.entries(sourceRow)) {
          if (v === null || typeof v === "string" || typeof v === "number" || typeof v === "bigint") {
            row[k] = v;
          }
        }
        for (const key of ["connected_at", "created_at", "sent_at"]) {
          const cur = row[key];
          if (typeof cur === "number") row[key] = cur + stamp;
        }
        if (row.paused_until !== undefined && row.paused_until !== null && row.paused_until !== 0) {
          row.paused_until = stamp + 86_400_000;
        }
        if (table === "connector_outbox" && row.message_id === "paused-message") {
          const msgRow = z.object({ id: z.string() }).parse(db.prepare("SELECT id FROM channel_message WHERE kind='report' ORDER BY created_at LIMIT 1").get());
          row.message_id = msgRow.id;
        }
        const cols = Object.keys(row);
        const binds = cols.map(() => "?").join(", ");
        const vals = cols.map((c) => row[c] ?? null);
        db.prepare(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${binds})`).run(...vals);
      }
    }
  } finally {
    db.close();
  }
}

async function verifyConnector(c: Client, live: string): Promise<void> {
  const collab = z.object({ connectors: z.array(ConnectorRow) }).parse(c.cli("state", "--slice", "collab"));
  const qq = collab.connectors.find((x) => x.id === "qq");
  assert(qq !== undefined && qq.state === "paused" && qq.pending === 1, JSON.stringify(qq));
  const path = join(live, "home/server.db");
  const reportRow = readDb(path, "SELECT id FROM channel_message WHERE kind='report' ORDER BY created_at LIMIT 1", (r) =>
    z.object({ id: z.string() }).parse(r),
  )[0];
  assert(reportRow !== undefined, "missing report channel_message");
  const outbox = readDb(path, "SELECT message_id, state FROM connector_outbox ORDER BY seq", (r) =>
    z.object({ message_id: z.string(), state: z.string() }).parse(r),
  );
  assertEqualJson(
    outbox,
    [
      { message_id: "legacy-sent", state: "sent" },
      { message_id: "legacy-old", state: "dropped" },
      { message_id: reportRow.id, state: "pending" },
    ],
    "connector_outbox",
  );
  const inbound = readDb(path, "SELECT ext_id, message_id, delivered FROM connector_inbound", (r) =>
    z.object({ ext_id: z.string(), message_id: z.string(), delivered: z.number() }).parse(r),
  );
  assertEqualJson(inbound, [{ ext_id: "old-in", message_id: "farm-old", delivered: 1 }], "connector_inbound");
}

function sqliteVersions(c: Client, live: string, agent: string, stage: string) {
  const path = join(live, "home/server.db");
  const db = new DatabaseSync(path);
  try {
    db.exec(`CREATE TABLE compat_engine(version TEXT, source_id TEXT);
      CREATE TRIGGER sample_engine AFTER INSERT ON memory
      BEGIN INSERT INTO compat_engine VALUES(sqlite_version(),sqlite_source_id()); END;`);
  } finally {
    db.close();
  }

  let version = "";
  let source = "";
  try {
    const row = IdObj.parse(c.cli("memory", "create", agent, `engine probe ${stage}`));
    const probed = readDb(path, "SELECT version, source_id FROM compat_engine", (r) => z.object({ version: z.string(), source_id: z.string() }).parse(r))[0];
    assert(probed !== undefined, "missing compat_engine probe row");
    version = probed.version;
    source = probed.source_id;
    c.cli("memory", "delete", agent, row.id);
  } finally {
    const cleanupDb = new DatabaseSync(path);
    try {
      cleanupDb.exec("DROP TRIGGER sample_engine; DROP TABLE compat_engine;");
    } finally {
      cleanupDb.close();
    }
  }

  const hostUserVersion = readDb(join(live, "host/state.db"), "PRAGMA user_version", (r) => z.object({ user_version: z.number() }).parse(r))[0]?.user_version;
  const serverUserVersion = readDb(path, "PRAGMA user_version", (r) => z.object({ user_version: z.number() }).parse(r))[0]?.user_version;
  return {
    sqliteVersion: version,
    sqliteSourceId: source,
    hostUserVersion,
    serverUserVersion,
  };
}

function identify(bundle: string) {
  const isDir = statSync(bundle).isDirectory();
  const macos = isDir ? join(bundle, "Contents/MacOS") : dirname(bundle);
  const version = isDir
    ? execFileSync("/usr/libexec/PlistBuddy", ["-c", "Print :VibeValleyVersion", join(bundle, "Contents/Info.plist")], {
        encoding: "utf8",
      }).trim()
    : "debug";
  return {
    path: bundle,
    version,
    appSha256: digest(join(macos, "vibevalley-mac")),
    cliSha256: digest(join(macos, "vibevalley")),
  };
}

async function verify(oldBundle: string, newBundle: string, root: string): Promise<void> {
  const live = join(root, "live");
  const backup = join(root, "paired-backup");
  mkdirSync(join(live, "work/workspace-project"), { recursive: true });
  git(join(live, "work/workspace-project"), "init", "-b", "main");

  const save = (name: string, obj: unknown): void => {
    writeFileSync(join(root, `${name}.json`), JSON.stringify(obj, null, 2) + "\n");
  };

  let ids!: SeedIds;
  let oldWindow!: { id: string; layout: unknown };
  const engines: Record<string, unknown> = {};

  const oldSteps: readonly NativeLaunchStep[] = [
    { method: "Shell.dispatchAction", params: { action: { type: "activate_path", path: join(live, "work/workspace-project") } } },
    { method: "Shell.dispatchAction", params: { action: { type: "palette_select", id: "pane.split_right" } } },
    { method: "Shell.save", params: {} },
    { method: "Page.draw", params: {} },
  ];
  const drawSteps: readonly NativeLaunchStep[] = [{ method: "Page.draw", params: {} }];

  await withLaunch(oldBundle, live, root, "old", oldSteps, async (c, vdp) => {
    ids = await seedOld(c);
    engines.old = sqliteVersions(c, live, ids.agent, "old");
    oldWindow = await waitForWindowState("old split layout", vdp, join(root, "old-window.json"));
    await verifyOldContent(c, ids);
  });

  seedConnectorFixture(join(live, "home/server.db"));
  await withLaunch(oldBundle, live, root, "old-connector", drawSteps, async (c) => {
    await verifyConnector(c, live);
  });
  save("old-records", ids);
  const original = manifest(live);
  cpSync(live, backup, { recursive: true, verbatimSymlinks: true });
  assertEqualJson(manifest(backup), original, "backup manifest");
  save("backup-files", original);

  let upgradedCommit = "";
  let marker!: { id: string };
  let followup = "";

  await withLaunch(newBundle, live, root, "upgraded", drawSteps, async (c, vdp) => {
    engines.upgraded = sqliteVersions(c, live, ids.agent, "upgraded");
    const upgradedLayout = await waitForWindowState("upgraded layout", vdp, join(root, "upgraded-window.json"));
    assertEqualJson(upgradedLayout, oldWindow, "upgraded layout");
    await verifyOldContent(c, ids);
    await verifyConnector(c, live);
    c.cli("channel", "message", "send", ids.channel, "checkpoint-old", "--send-key", "checkpoint-old");
    await verifyOldContent(c, ids);

    marker = IdObj.parse(c.cli("memory", "create", ids.agent, "upgraded-only note", "--key", "new-only"));
    c.cli("note", "update", ids.note, "--title", "New title");
    const revision = IssueDiff.parse(c.cli("issue", "diff", ids.issue)).revision;
    c.cli("issue", "review", ids.issue, "--pass", "--base-commit", revision.baseCommit, "--tree", revision.tree);
    const result = IssueShow.parse(c.cli("issue", "status", ids.issue, "done"));
    assert(result.delivered === "merged" && git(ids.repo, "show", "HEAD:clock.ts"), "expected merged clock.ts");
    upgradedCommit = git(ids.repo, "rev-parse", "HEAD");

    followup = IdObj.parse(c.cli("issue", "create", "先问清楚，给选项", "--repo", "demo", "--agent", "docs")).id;
    c.cli("issue", "status", followup, "todo");
    await waitFor("new helper question", () => IssueShow.parse(c.cli("issue", "show", followup)).stage.state === "asking");
    await c.call("issue.comment.create", { id: followup, text: "用 8797", sendKey: "upgrade-followup" });
    await waitFor("new helper response", () => IssueShow.parse(c.cli("issue", "show", followup)).stage.state === "reviewing");
  });

  let submitted: readonly [string, string][] = [];
  await withLaunch(newBundle, live, root, "upgraded-reopen", drawSteps, async (c) => {
    assert(IssueShow.parse(c.cli("issue", "show", ids.issue)).status === "done", "expected done issue");
    const completedRuns = z.array(IssueRun).parse(await c.call("issue.run.list", { id: followup }));
    const requests = readDb(
      join(live, "home/server.db"),
      "SELECT id FROM channel_message WHERE sender_id='user' AND body=?",
      (r) => z.object({ id: z.string() }).parse(r).id,
      "用 8797",
    );
    assert(requests.length === 1 && requests[0] !== undefined, JSON.stringify(requests));
    const reqId = requests[0];
    const matches = completedRuns.filter((r) => r.heard.includes(reqId));
    assert(matches.length === 1 && matches[0]?.outcome === "completed", JSON.stringify(matches));
    const durableRows = readDb(
      join(live, "home/server.db"),
      "SELECT request_id, status FROM durable_submission WHERE conversation_id=? AND request_id=?",
      (r) => z.object({ request_id: z.string(), status: z.string() }).parse(r),
      `issue:${followup}`,
      reqId,
    );
    submitted = durableRows.map((r) => [r.request_id, r.status]);
    assertEqualJson(submitted, [[reqId, "done"]], "durable_submission");

    assert(NoteShow.parse(c.cli("note", "show", ids.note)).title === "New title", "updated note title missing");
    assert(
      MemoryList.parse(c.cli("memory", "list", ids.agent)).memories.some((m) => m.id === marker.id),
      "new memory missing",
    );
  });

  renameSync(live, join(root, "upgraded-cohort"));
  cpSync(backup, live, { recursive: true, verbatimSymlinks: true });
  assertEqualJson(manifest(live), original, "restored backup manifest");

  await withLaunch(oldBundle, live, root, "rollback", drawSteps, async (c, vdp) => {
    engines.rollback = sqliteVersions(c, live, ids.agent, "rollback");
    const issues = z.array(IdObj).parse(c.cli("issue", "list"));
    assert(
      issues.every((issue) => issue.id !== followup),
      "followup issue leaked into rollback",
    );
    const rollbackLayout = await waitForWindowState("rollback layout", vdp, join(root, "rollback-window.json"));
    assertEqualJson(rollbackLayout, oldWindow, "rollback layout");
    await verifyOldContent(c, ids);
    await verifyConnector(c, live);
    assert(
      MemoryList.parse(c.cli("memory", "list", ids.agent)).memories.every((m) => m.id !== marker.id),
      "new memory leaked into rollback",
    );
  });

  const archivedRepo = join(root, "upgraded-cohort", relative(live, ids.repo));
  assert(git(archivedRepo, "rev-parse", "HEAD") === upgradedCommit, "archived repo HEAD mismatch");
  for (const cohort of [live, backup, join(root, "upgraded-cohort")]) {
    for (const file of [join(cohort, "home/server.db"), join(cohort, "host/state.db")]) {
      const check = readDb(file, "PRAGMA integrity_check", (r) => z.object({ integrity_check: z.string() }).parse(r).integrity_check);
      assertEqualJson(check, ["ok"], `PRAGMA integrity_check ${file}`);
    }
  }

  save("result", {
    old: identify(oldBundle),
    new: identify(newBundle),
    backupFileCount: Object.keys(original).length,
    sqlite: engines,
    startup: Object.fromEntries(
      (["old", "upgraded", "upgraded-reopen", "rollback"] as const).map((stage) => [
        stage,
        JSON.parse(readFileSync(join(root, `${stage}-startup.json`), "utf8")) as unknown,
      ]),
    ),
    restoredOldBase: ids.base,
    preservedNewCommit: upgradedCommit,
    restoredWindow: oldWindow,
    newNote: marker.id,
    newIssue: followup,
    newDurableSubmission: submitted,
    seeds: {
      oldPackage: [
        "profile",
        "cron",
        "repo",
        "issue",
        "session",
        "channel",
        "memory",
        "note",
        "attachment",
        "library",
        "media_input",
        "media_job",
        "layout",
        "terminals",
      ],
      oldConnectorStore: ["paused account", "replayed inbox", "sent, dropped and pending outbox"],
      newPackage: ["review receipt", "Git merge", "durable reply", "new memory", "note title"],
    },
    ok: true,
  });
  console.log("Old application data, upgraded delivery, and paired old-package rollback passed.");
}

if (import.meta.main) {
  const { positionals } = parseArgs({ allowPositionals: true });
  const oldArg = positionals[0];
  const newArg = positionals[1];
  if (!oldArg || !newArg) {
    throw new Error("Usage: verify-native-data.ts <old.app|binary> <new.app|binary>");
  }
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vv-data-rollback-")));
  console.log(root);
  await verify(realpathSync(resolve(oldArg)), realpathSync(resolve(newArg)), root);
}
