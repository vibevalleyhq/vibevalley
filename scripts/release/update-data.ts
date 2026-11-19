import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { z } from "zod";

import { pathOf } from "@vibevalley/protocol";

const reply = "Upgrade receipt 写版本B";
const sendKey = "retained-upgrade-reply";
const issue = z.object({ id: z.string(), title: z.string(), status: z.string() });
const runs = z.array(z.object({ id: z.string(), session: z.string(), outcome: z.string().nullish(), summary: z.string() }));
const message = z.object({
  from: z.string(),
  id: z.string(),
  channel: z.string(),
  kind: z.string(),
  run: z.string().nullish(),
  text: z.string(),
  sendKey: z.string().nullish(),
});
const projects = z.object({ projects: z.array(z.object({ id: z.number(), root: z.string() })) });

async function call(url: string, op: string, input: Record<string, unknown>): Promise<unknown> {
  const response = await fetch(url + pathOf(op), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(10_000),
  });
  const result = z.object({ bizCode: z.number(), data: z.unknown().optional(), message: z.string() }).parse(await response.json());
  if (!response.ok || result.bizCode !== 0) throw new Error(`${op}: ${response.status} ${result.message}`);
  return result.data;
}

async function until<T>(what: string, read: () => Promise<T | undefined>): Promise<T> {
  const untilMs = Date.now() + 20_000;
  while (Date.now() < untilMs) {
    const result = await read();
    if (result !== undefined) return result;
    await delay(100);
  }
  throw new Error(`Upgrade data not ready: ${what}`);
}

export async function seedUpdateIssue(url: string) {
  await call(url, "repo.create", { name: "upgrade-repo" });
  const { id } = issue.parse(await call(url, "issue.create", { title: "Upgrade sample 写版本A", repo: "upgrade-repo", agent: "docs" }));
  await call(url, "issue.status.update", { id, status: "todo" });
  await until("first run completed", async () => runs.parse(await call(url, "issue.run.list", { id })).find((r) => r.outcome === "completed"));
  await call(url, "issue.comment.create", { id, text: reply, sendKey });
  return id;
}

export async function retainedUpdateData(url: string, id: string, dir: string) {
  const recorded = await until("two completed runs", async () => {
    const all = runs.parse(await call(url, "issue.run.list", { id }));
    if (all.length > 2) throw new Error(`Issue ${id} ran ${all.length} times`);
    return all.length === 2 && all.every((r) => r.outcome === "completed") ? all : undefined;
  });
  const messages = await until("the user's reply and both worker reports", async () => {
    const hits = z.array(z.object({ message })).parse(await call(url, "channel.message.search", { text: reply }));
    const input = hits.find((hit) => hit.message.sendKey === sendKey)?.message;
    if (!input) return undefined;
    const history = z.array(message).parse(await call(url, "channel.message.list", { id: input.channel }));
    const reports = history.filter((m) => m.kind === "report" && recorded.some((r) => m.from === r.session && (m.run == null || m.run === r.id)));
    if (reports.length > 2 || history.filter((m) => m.sendKey === sendKey).length !== 1) throw new Error("Duplicate update-test reply or report");
    return reports.length === 2 ? [input, ...reports] : undefined;
  });
  const session = z.object({ id: z.string(), worktree: z.string(), branch: z.string() }).parse(await call(url, "session.get", { id: recorded[0]!.session }));
  const git = (args: string[]) => execFileSync("git", ["-C", session.worktree, ...args], { encoding: "utf8" }).trim();
  const commits = git(["log", "--format=%H %s", "-2"]);
  if (!(commits.includes("版本 A") && commits.includes("版本 B"))) throw new Error(`Missing worker commits: ${commits}`);
  const contents = git(["show", "HEAD:same.ts"]);
  if (!contents.includes("'B'")) throw new Error("Missing final worker edit");
  const project = await until("retained workspace open in the native app", async () => {
    const dump = await readFile(join(dir, "dump.json"), "utf8").catch((e: unknown) => {
      if (e instanceof Error && "code" in e && e.code === "ENOENT") return undefined;
      throw e;
    });
    return dump === undefined ? undefined : projects.parse(JSON.parse(dump)).projects.find((p) => p.root === join(dir, "retained-project"));
  });
  return { issue: issue.parse(await call(url, "issue.get", { id })), recorded, session, messages, commits, contents, project };
}
