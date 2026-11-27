/** Drive the native farm chat, scheduled work and bundled CLI against a loopback-only model. */

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";

import { z } from "zod";

import { captureVdpPngFile, ShellStateSchema, VdpWsClient, waitForVdpEndpoint } from "./vdp-client.ts";

const UTTERANCE = "create a field issue";
const TITLE = "Native assistant from field";
const CHANNEL_TEXT = "Native CLI receipt";
const TOOL_CALL = "offline-field-create";
const WINDOW = [1280, 820] as const;
// The farm-chat-input rectangle in window points with the handset open at this viewport.
const CHAT_INPUT = [125, 599, 732, 651] as const;

const ChatRequest = z.object({
  messages: z.array(z.looseObject({ role: z.string(), content: z.unknown().optional(), tool_call_id: z.string().optional() })),
  tools: z.array(z.object({ function: z.object({ name: z.string() }) })).optional(),
});
const ServerReceipt = z.looseObject({ pid: z.number(), url: z.string() });
const DumpState = z.object({
  diorama: z
    .object({
      kind: z.string().optional(),
      frames_seen: z.number().optional(),
      taps: z.array(z.string()).optional(),
      placed: z.unknown().optional(),
    })
    .nullable()
    .optional(),
});
const Envelope = z.object({ bizCode: z.number(), data: z.unknown().optional() });
const DoctorItem = z.object({ ok: z.boolean() });
const ChannelMessage = z.looseObject({ id: z.string(), text: z.string(), channel: z.string(), sendKey: z.string().optional() });
const SearchHit = z.object({ message: ChannelMessage });
const IssueRow = z.looseObject({ id: z.string(), title: z.string(), cron: z.string().nullable().optional() });
const RunRow = z.looseObject({ id: z.string(), outcome: z.string().optional() });
const CronRow = z.looseObject({
  id: z.string(),
  enabled: z.boolean().optional(),
  lastRun: z.string().optional(),
  when: z.looseObject({ at: z.string() }),
});

function assert(condition: unknown, message: string): asserts condition {
  if (condition === false || condition === null || condition === undefined || condition === "") {
    throw new Error(message);
  }
}

function save(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

function midpoint(bounds: readonly [number, number, number, number]): readonly [number, number] {
  return [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2];
}

function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    req.on("error", rejectBody);
  });
}

async function stopProcess(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  const exited = new Promise<void>((done) => {
    proc.once("exit", () => done());
  });
  proc.kill("SIGTERM");
  const winner = await Promise.race([exited.then(() => "exited" as const), sleep(5_000).then(() => "timeout" as const)]);
  if (winner === "timeout" && proc.exitCode === null && proc.signalCode === null) {
    proc.kill("SIGKILL");
    await exited;
  }
}

async function verify(app: string, cli: string, root: string): Promise<void> {
  const home = join(root, "home");
  const work = join(root, "work");
  const user = join(root, "user");
  for (const dir of [home, work, user]) mkdirSync(dir);

  const modelEvents: { heard: boolean; toolResultIds: (string | undefined)[]; choice: unknown }[] = [];
  let sent = false;

  const model = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "POST" || req.url !== "/chat/completions" || req.headers.authorization !== "Bearer local-fixture") {
      res.writeHead(403).end();
      return;
    }
    void readRequestBody(req)
      .then((raw) => {
        const request = ChatRequest.parse(JSON.parse(raw));
        const heard = request.messages.some(
          (m) => m.role === "user" && (typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "")).includes(UTTERANCE),
        );
        let choice: unknown;
        if (heard && !sent) {
          const toolNames = (request.tools ?? []).map((t) => t.function.name);
          assert(toolNames.includes("issue_create"), `expected issue_create in tools: ${toolNames.join(",")}`);
          sent = true;
          const args = { title: TITLE, agent: "docs", repo: "field-project", start: true };
          const call = { index: 0, id: TOOL_CALL, type: "function", function: { name: "issue_create", arguments: JSON.stringify(args) } };
          choice = { delta: { tool_calls: [call] }, finish_reason: "tool_calls" };
        } else {
          choice = { delta: { content: "Local dispatch complete." }, finish_reason: "stop" };
        }
        modelEvents.push({
          heard,
          toolResultIds: request.messages.filter((m) => m.role === "tool").map((m) => m.tool_call_id),
          choice,
        });
        save(join(root, "local-model.json"), modelEvents);
        const chunk = { choices: [choice], usage: { prompt_tokens: 9, completion_tokens: 3 } };
        const body = `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`;
        res.writeHead(200, { "Content-Type": "text/event-stream", "Content-Length": Buffer.byteLength(body) });
        res.end(body);
      })
      .catch((err: unknown) => {
        res.writeHead(500).end(String(err));
      });
  });

  await new Promise<void>((accept, reject) => {
    model.once("error", reject);
    model.listen(0, "127.0.0.1", accept);
  });
  const addr = model.address();
  assert(addr !== null && typeof addr !== "string", "expected loopback model port");
  const modelPort = addr.port;

  const env: Record<string, string> = {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: user,
    LANG: "en_US.UTF-8",
    TZ: "UTC",
    TMPDIR: root,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Acceptance",
    GIT_COMMITTER_NAME: "Acceptance",
    GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_COMMITTER_EMAIL: "test@example.invalid",
    VIBEVALLEY_HOME: home,
    VIBEVALLEY_WORK_ROOT: work,
    VIBEVALLEY_STORE: join(root, "state.db"),
    VIBEVALLEY_NO_OPENING: "1",
    VIBEVALLEY_PORT: "0",
    VIBEVALLEY_VOICE_LINE_PORT: "0",
    VIBEVALLEY_TEST_RUNTIMES: "1",
    VIBEVALLEY_TEST_MODEL_PORT: String(modelPort),
    DEEPSEEK_API_KEY: "local-fixture",
    VIBEVALLEY_AGENT_STARTERS: "docs",
    VIBEVALLEY_UPDATE_FEED: "off",
    VIBEVALLEY_PATROL_HEARTBEAT_MINUTES: "0",
    VIBEVALLEY_DEBUG_PORT: "0",
  };

  const [cx, cy] = [WINDOW[0] / 2, WINDOW[1] / 2];
  const [ix, iy] = midpoint(CHAT_INPUT);

  const policy = '(version 1)(allow default)(deny network-outbound)(allow network-outbound (remote ip "localhost:*"))';
  const logFd = openSync(join(root, "app.log"), "w");
  const proc = spawn("/usr/bin/sandbox-exec", ["-p", policy, app], { cwd: work, env, stdio: ["ignore", logFd, logFd] });
  closeSync(logFd);

  const until = async <T>(label: string, read: () => T | undefined, timeoutSec = 40): Promise<T> => {
    const deadline = Date.now() + timeoutSec * 1_000;
    while (Date.now() < deadline) {
      if (proc.exitCode !== null || proc.signalCode !== null) {
        throw new Error(`App exited during ${label}: ${String(proc.exitCode ?? proc.signalCode)}`);
      }
      const value = read();
      if (value !== undefined) return value;
      await sleep(100);
    }
    throw new Error(`Timed out waiting for ${label}`);
  };

  const ready = () => {
    try {
      const receipt = ServerReceipt.parse(JSON.parse(readFileSync(join(home, "server.json"), "utf8")));
      return receipt.pid === proc.pid ? receipt : undefined;
    } catch {
      return undefined;
    }
  };

  const tryCaptureShot = async (vdp: VdpWsClient, outPath: string): Promise<void> => {
    try {
      await captureVdpPngFile(vdp, outPath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("--features shot")) {
        throw err;
      }
    }
  };

  const driveFieldChat = async () => {
    const endpoint = await waitForVdpEndpoint({
      homeDir: home,
      ...(proc.pid !== undefined ? { expectedPid: proc.pid } : {}),
      timeoutMs: 30_000,
      appExited: () => proc.exitCode,
      logPath: join(root, "app.log"),
    });
    const vdp = await VdpWsClient.connect(endpoint, 15_000);
    try {
      const loadedDeadline = Date.now() + 25_000;
      let loaded = false;
      while (Date.now() < loadedDeadline) {
        const state = await vdp.callDecoded("Shell.getState", {}, ShellStateSchema);
        if (state.loaded) {
          loaded = true;
          break;
        }
        await sleep(100);
      }
      assert(loaded, "timed out waiting for shell loaded state");

      await vdp.call("Shell.resize", { width: WINDOW[0], height: WINDOW[1] });
      await vdp.call("Shell.openPane", { kind: "hosted", params: { module: "vv", props: { route: "/farm" } } });

      let farmPlaced: unknown;
      const farmDeadline = Date.now() + 25_000;
      while (Date.now() < farmDeadline) {
        await vdp.call("Page.draw", {});
        const state = DumpState.parse(await vdp.call("Shell.getState", {}));
        const farm = state.diorama;
        if (farm !== null && farm !== undefined && farm.kind === "farm" && (farm.frames_seen ?? 0) > 0) {
          farmPlaced = farm.placed;
          break;
        }
        await sleep(100);
      }
      assert(farmPlaced !== undefined, "timed out waiting for farm diorama frame");

      await vdp.call("Input.dispatchMouse", { kind: "click", x: cx, y: cy, button: "left" });
      await vdp.call("Input.dispatchKey", { keys: "p" });
      await vdp.call("Page.draw", {});
      await vdp.call("Page.draw", {});
      await tryCaptureShot(vdp, join(root, "chat.png"));
      await vdp.call("Input.dispatchMouse", { kind: "click", x: ix, y: iy, button: "left" });
      await vdp.call("Input.typeText", { text: UTTERANCE });
      await tryCaptureShot(vdp, join(root, "typed.png"));
      await vdp.call("Input.dispatchKey", { keys: "enter" });
      await tryCaptureShot(vdp, join(root, "sent.png"));

      return {
        viewport: WINDOW,
        focusTap: [cx, cy],
        firstAction: "key:p",
        farmViewport: farmPlaced,
        inputBounds: CHAT_INPUT,
        inputTap: [ix, iy],
        submit: "enter",
      };
    } finally {
      vdp.close();
    }
  };

  let address = "";
  const api = async (op: string, args: unknown): Promise<unknown> => {
    const response = await fetch(`${address}/api/v1/${op.replaceAll(".", "/")}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) throw new Error(`${op}: HTTP ${response.status}`);
    const envelope = Envelope.parse(await response.json());
    assert(envelope.bizCode === 0, `${op}: ${JSON.stringify(envelope)}`);
    return envelope.data;
  };

  const command = (...args: string[]): unknown => {
    const stdout = execFileSync(cli, ["--json", ...args], {
      cwd: work,
      env: { ...env, VIBEVALLEY_SERVER: address },
      encoding: "utf8",
      timeout: 35_000,
    });
    return JSON.parse(stdout);
  };

  // Async variant for polling async `api` calls without spinning synchronously.
  const untilAsync = async <T>(label: string, read: () => Promise<T | undefined>, timeoutSec = 40): Promise<T> => {
    const deadline = Date.now() + timeoutSec * 1_000;
    while (Date.now() < deadline) {
      if (proc.exitCode !== null || proc.signalCode !== null) {
        throw new Error(`App exited during ${label}: ${String(proc.exitCode ?? proc.signalCode)}`);
      }
      const value = await read();
      if (value !== undefined) return value;
      await sleep(100);
    }
    throw new Error(`Timed out waiting for ${label}`);
  };

  const waitCompleted = (issueId: string) =>
    untilAsync(`completed run for ${issueId}`, async () => {
      const runs = z.array(RunRow).parse(await api("issue.run.list", { id: issueId }));
      return runs.length === 1 && runs[0]?.outcome === "completed" ? runs : undefined;
    });

  try {
    const receipt = await until("server startup", ready);
    address = receipt.url;
    save(join(root, "server.json"), receipt);
    command("repo", "create", "field-project");
    command("runtime", "refresh", "pi");
    const doctor = z.array(DoctorItem).parse(command("doctor"));
    assert(
      doctor.every((item) => item.ok),
      `doctor failed: ${JSON.stringify(doctor)}`,
    );
    save(join(root, "doctor.json"), doctor);

    const interaction = await driveFieldChat();
    save(join(root, "interaction.json"), interaction);

    const userMessage = await until("field textarea submitted the message", () => {
      const hits = z.array(SearchHit).parse(command("channel", "message", "search", UTTERANCE));
      return hits.find((h) => h.message.text === UTTERANCE)?.message;
    });
    assert(userMessage.sendKey, "missing sendKey on userMessage");
    await until("local model received the field message", () => (modelEvents.some((e) => e.heard) ? true : undefined));
    const dispatched = await until("issue dispatched by the field chat", () => {
      const issues = z.array(IssueRow).parse(command("issue", "list"));
      return issues.find((i) => i.title === TITLE);
    });
    const fieldRun = await waitCompleted(dispatched.id);
    await until("orchestrator received issue_create result", () => (modelEvents.some((e) => e.toolResultIds.includes(TOOL_CALL)) ? true : undefined));
    save(join(root, "field.json"), { message: userMessage, issue: dispatched, runs: fieldRun });

    const channel = userMessage.channel;
    command("channel", "message", "send", channel, CHANNEL_TEXT);
    const history = z.array(ChannelMessage).parse(command("channel", "message", "list", channel));
    const found = z.array(SearchHit).parse(command("channel", "message", "search", CHANNEL_TEXT));
    assert(history.filter((m) => m.text === CHANNEL_TEXT).length === 1, "expected 1 CLI receipt in history");
    const cliMsg = found.find((h) => h.message.text === CHANNEL_TEXT)?.message;
    assert(cliMsg !== undefined, "missing cliMsg in search results");
    save(join(root, "channel.json"), cliMsg);

    const dueIso = new Date(Date.now() + 4_000).toISOString().replace(/\.\d{3}Z$/u, "Z");
    const timer = CronRow.parse(command("cron", "create", "release-check", "Scheduled worker", "--at", dueIso, "--agent", "docs", "--repo", "field-project"));
    const scheduled = await until(
      "real clock tick",
      () => {
        const issues = z.array(IssueRow).parse(command("issue", "list"));
        return issues.find((i) => i.cron === timer.id);
      },
      50,
    );
    const scheduledRun = await waitCompleted(scheduled.id);
    const recordedTimer = z
      .array(CronRow)
      .parse(command("cron", "list"))
      .find((t) => t.id === timer.id);
    assert(recordedTimer !== undefined && recordedTimer.enabled === false && (recordedTimer.lastRun ?? "") >= timer.when.at, "cron state mismatch");
    save(join(root, "cron.json"), { scheduled: timer, fired: recordedTimer, issue: scheduled, runs: scheduledRun });

    save(join(root, "result.json"), {
      ok: true,
      appSHA256: createHash("sha256").update(readFileSync(app)).digest("hex"),
      cliSHA256: createHash("sha256").update(readFileSync(cli)).digest("hex"),
      modelEndpoint: `http://127.0.0.1:${modelPort}`,
      fieldMessage: userMessage.id,
      dispatchIssue: dispatched.id,
      firstFarmAction: interaction.firstAction,
      workerRun: fieldRun[0]?.id,
      doctor: "passed",
      cliMessage: cliMsg.id,
      cron: timer.id,
      scheduledIssue: scheduled.id,
      scheduledRun: scheduledRun[0]?.id,
    });
  } finally {
    await stopProcess(proc);
    await new Promise<void>((done) => {
      model.close(() => done());
    });
  }
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { cli: { type: "string" } },
  });
  const appArg = positionals[0];
  if (!appArg) {
    throw new Error("Usage: verify-farm-dispatch.ts <VibeValley.app|binary> [--cli <path>]");
  }
  const appPath = realpathSync(resolve(appArg));
  const isDir = statSync(appPath).isDirectory();
  const binary = isDir ? join(appPath, "Contents/MacOS/vibevalley-mac") : appPath;
  const cliPath = values.cli ? realpathSync(resolve(values.cli)) : join(dirname(binary), "vibevalley");
  if (!existsSync(cliPath)) throw new Error(`Missing CLI binary: ${cliPath}`);
  const evidence = realpathSync(mkdtempSync(join(tmpdir(), "vv-native-dispatch-")));
  console.log(evidence);
  await verify(binary, cliPath, evidence);
  console.log("Passed native farm chat, scheduled dispatch and CLI diagnostics");
}
