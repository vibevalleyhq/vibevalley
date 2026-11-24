/** Exercise three delegated issues in an isolated native app, including a real process interruption. */

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { arch, release, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";

import { z } from "zod";

const ServerAnnounce = z.object({ pid: z.number(), url: z.string() });
const Envelope = z.object({ bizCode: z.number(), data: z.unknown().optional() });
const IdItem = z.object({ id: z.string() });
const IssueShow = z.object({
  id: z.string(),
  status: z.string().optional(),
  delivered: z.string().optional(),
  deliveryEvidence: z.looseObject({ mergedCommit: z.string() }).optional(),
  stage: z.object({ state: z.string() }),
});
const SessionRow = z.object({
  issue: z.string().nullable().optional(),
  worktree: z.string().optional(),
  phase: z.object({ _tag: z.string() }),
});
const RunRow = z.looseObject({
  id: z.string().optional(),
  outcome: z.string().optional(),
  needsReconciliation: z.boolean().optional(),
});
const DiffOut = z.object({
  files: z.array(z.object({ path: z.string() })),
  revision: z.object({ baseCommit: z.string(), tree: z.string() }),
});
const RepoRow = z.object({ path: z.string() });

function assert(condition: unknown, message: string): asserts condition {
  if (condition === false || condition === null || condition === undefined || condition === "") {
    throw new Error(message);
  }
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/u.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function waitFor<T>(label: string, read: () => T | undefined): Promise<T> {
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await sleep(40);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function stopProcess(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  const exited = new Promise<void>((done) => {
    proc.once("exit", () => done());
  });
  proc.kill("SIGTERM");
  const winner = await Promise.race([exited.then(() => "exited" as const), sleep(10_000).then(() => "timeout" as const)]);
  if (winner === "timeout" && proc.exitCode === null && proc.signalCode === null) {
    proc.kill("SIGKILL");
    await exited;
  }
}

async function verify(app: string, cli: string, root: string, prepareTrial: boolean): Promise<void> {
  const home = join(root, "home");
  const work = join(root, "work");
  const user = join(root, "user");
  for (const dir of [home, work, user]) mkdirSync(dir);

  const env: Record<string, string> = {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: user,
    TMPDIR: root,
    LANG: "en_US.UTF-8",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Native acceptance",
    GIT_COMMITTER_NAME: "Native acceptance",
    GIT_AUTHOR_EMAIL: "local@example.invalid",
    GIT_COMMITTER_EMAIL: "local@example.invalid",
    VIBEVALLEY_HOME: home,
    VIBEVALLEY_WORK_ROOT: work,
    VIBEVALLEY_STORE: join(root, "state.db"),
    VIBEVALLEY_PORT: "0",
    VIBEVALLEY_NO_OPENING: "1",
    VIBEVALLEY_TEST_RUNTIMES: "1",
    VIBEVALLEY_AGENT_STARTERS: "docs",
  };

  const save = (name: string, value: unknown): void => {
    writeFileSync(join(root, `${name}.json`), JSON.stringify(value, null, 2) + "\n");
  };

  const launch = async (): Promise<{ proc: ChildProcess; address: string }> => {
    const logFd = openSync(join(root, "app.log"), "a");
    const proc = spawn(app, [], { cwd: work, env, stdio: ["ignore", logFd, logFd] });
    closeSync(logFd);

    const ready = (): string | undefined => {
      if (proc.exitCode !== null || proc.signalCode !== null) {
        throw new Error(`app exited with ${String(proc.exitCode ?? proc.signalCode)}`);
      }
      try {
        const announced = ServerAnnounce.parse(JSON.parse(readFileSync(join(home, "server.json"), "utf8")));
        return announced.pid === proc.pid ? announced.url : undefined;
      } catch {
        return undefined;
      }
    };

    try {
      const address = await waitFor("app service", ready);
      return { proc, address };
    } catch (error) {
      await stopProcess(proc);
      throw error;
    }
  };

  let address = "";
  const command = (...args: string[]): unknown => {
    const stdout = execFileSync(cli, ["--json", ...args], {
      env: { ...env, VIBEVALLEY_SERVER: address },
      encoding: "utf8",
      timeout: 30_000,
    });
    return JSON.parse(stdout);
  };

  const call = async (op: string, payload: unknown): Promise<unknown> => {
    const response = await fetch(`${address}/api/v1/${op.replaceAll(".", "/")}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) throw new Error(`${op}: HTTP ${response.status}`);
    const reply = Envelope.parse(await response.json());
    if (reply.bizCode !== 0) throw new Error(`${op}: ${JSON.stringify(reply)}`);
    return reply.data;
  };

  const createIssue = (title: string): string => IdItem.parse(command("issue", "create", title, "--repo", "demo", "--agent", "docs")).id;

  const waitStage = (issueId: string, expected: string) =>
    waitFor(expected, () => {
      const item = IssueShow.parse(command("issue", "show", issueId));
      return item.stage.state === expected ? item : undefined;
    });

  const git = (directory: string, ...args: string[]): string => execFileSync("git", ["-C", directory, ...args], { encoding: "utf8", env }).trim();

  let worktree = "";
  let pendingCommit = "";
  let question = "";
  let review = "";
  let interrupted = "";

  const first = await launch();
  address = first.address;
  try {
    command("repo", "create", "demo");
    question = createIssue("先问清楚，给选项");
    review = createIssue("写打卡并提交");
    interrupted = createIssue("写版本B 发呆");
    for (const issueId of [question, review]) command("issue", "status", issueId, "todo");
    save("asking", await waitStage(question, "asking"));
    save("reviewing", await waitStage(review, "reviewing"));
    command("issue", "status", interrupted, "todo");

    worktree = await waitFor("third issue to commit before its round ends", () => {
      const sessions = z.array(SessionRow).parse(command("session", "list"));
      const worker = sessions.find((s) => s.issue === interrupted && s.phase._tag === "working");
      if (worker?.worktree !== undefined && git(worker.worktree, "log", "-1", "--format=%s") === "版本 B") {
        return worker.worktree;
      }
      return undefined;
    });
    pendingCommit = git(worktree, "rev-parse", "HEAD");
    const killed = new Promise<void>((done) => {
      if (first.proc.exitCode !== null || first.proc.signalCode !== null) {
        done();
        return;
      }
      first.proc.once("exit", () => done());
    });
    first.proc.kill("SIGKILL");
    await Promise.race([killed, sleep(10_000)]);
  } finally {
    await stopProcess(first.proc);
  }

  const second = await launch();
  address = second.address;
  try {
    const runs = z.array(RunRow).parse(await call("issue.run.list", { id: interrupted }));
    assert(runs.length === 1 && runs[0]?.outcome === "interrupted" && runs[0].needsReconciliation === true, JSON.stringify(runs));
    assert(git(worktree, "rev-parse", "HEAD") === pendingCommit, "pending commit mismatch after restart");

    if (prepareTrial) {
      await waitStage(question, "asking");
      await waitStage(review, "reviewing");
      save("trial-start", { question, review, interrupted, retainedCommit: pendingCommit });
      const launcher = join(root, "open-trial.command");
      const launchArgs = ["env", "-i", ...Object.entries(env).map(([k, v]) => `${k}=${v}`), app];
      writeFileSync(launcher, `#!/bin/sh\ncd ${shellQuote(work)} || exit 1\nexec ${launchArgs.map(shellQuote).join(" ")}\n`);
      chmodSync(launcher, 0o700);

      const infoPlist = join(dirname(dirname(app)), "Info.plist");
      let version = "开发构建";
      if (existsSync(infoPlist)) {
        try {
          version = execFileSync("/usr/libexec/PlistBuddy", ["-c", "Print :VibeValleyVersion", infoPlist], { encoding: "utf8" }).trim();
        } catch {
          version = "未标记";
        }
      }

      const template = readFileSync(join(import.meta.dirname, "fixtures", "native-trial-card.txt"), "utf8");
      const cliVersion = execFileSync(cli, ["--version"], { env, encoding: "utf8", timeout: 10_000 }).trim();
      const macVer = process.platform === "darwin" ? execFileSync("sw_vers", ["-productVersion"], { encoding: "utf8" }).trim() : release();
      const card = join(root, "trial-card.txt");
      const cardText = template.replaceAll("{device}", `macOS ${macVer} / ${arch()}`).replaceAll("{version}", version).replaceAll("{cli_version}", cliVersion);
      writeFileSync(card, cardText, "utf8");
      chmodSync(card, 0o600);
      console.log(`试用卡（可用文本编辑填写）：${card}`);
      console.log(`打开三张工单：${launcher}`);
      return;
    }

    command("issue", "comment", question, "用 8797");
    save("answered", await waitStage(question, "reviewing"));
    const diff = DiffOut.parse(command("issue", "diff", review));
    assert(
      diff.files.some((f) => f.path === "clock.ts"),
      "expected clock.ts in diff",
    );
    const rev = diff.revision;
    command("issue", "review", review, "--pass", "--base-commit", rev.baseCommit, "--tree", rev.tree);
    const done = IssueShow.parse(command("issue", "status", review, "done"));
    assert(done.status === "done" && done.delivered === "merged", JSON.stringify(done));
    const receipt = done.deliveryEvidence;
    assert(receipt !== undefined, "missing deliveryEvidence");
    const repo = z.array(RepoRow).parse(command("repo", "list"))[0]?.path;
    assert(repo !== undefined, "missing repo");
    assert(git(repo, "rev-parse", "HEAD") === receipt.mergedCommit, "HEAD mismatch after merge");
    assert(git(repo, "show", "HEAD:clock.ts"), "clock.ts missing from HEAD");
    assert(
      git(worktree, "log", "--format=%s")
        .split("\n")
        .filter((s) => s === "版本 B").length === 1,
      "expected exactly one 版本 B commit",
    );
    save("result", {
      question,
      review,
      interrupted,
      reconciliation: runs[0],
      retainedCommit: pendingCommit,
      delivery: receipt,
      ok: true,
    });
  } finally {
    await stopProcess(second.proc);
  }
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      cli: { type: "string" },
      "prepare-trial": { type: "boolean", default: false },
    },
  });
  const appArg = positionals[0];
  if (!appArg) {
    throw new Error("Usage: verify-native-work.ts <VibeValley.app|binary> [--cli <path>] [--prepare-trial]");
  }
  const appPath = realpathSync(resolve(appArg));
  const isDir = statSync(appPath).isDirectory();
  const binaries = isDir ? join(appPath, "Contents/MacOS") : dirname(appPath);
  const cliPath = values.cli ? realpathSync(resolve(values.cli)) : join(binaries, "vibevalley");
  if (!existsSync(cliPath)) throw new Error(`Missing CLI binary: ${cliPath}`);
  const appBin = isDir ? join(binaries, "vibevalley-mac") : appPath;
  const evidence = realpathSync(mkdtempSync(join(tmpdir(), "vv-native-three-issues-")));
  console.log(evidence);
  await verify(appBin, cliPath, evidence, values["prepare-trial"]);
  if (!values["prepare-trial"]) {
    console.log("Passed question, reviewed Git delivery and interrupted work recovery");
  }
}
