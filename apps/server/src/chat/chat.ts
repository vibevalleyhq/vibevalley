import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

import type { Event, McpServer as OarMcpServer, Session } from "@botiverse/oar";
import { promptAndWait } from "@botiverse/oar/observe";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";

import { type McpServer, readMcpConfig } from "@vibevalley/agent/mcp";
import { fileMemory } from "@vibevalley/agent/memory";
import { defaultSkillDirs, scanSkills } from "@vibevalley/agent/skills";
import { memoryStore } from "@vibevalley/agent/todoStore";
import { Queue, TaskGroup } from "@vibevalley/async";
import { homeOf } from "@vibevalley/home";
import { currentLocale, t } from "@vibevalley/i18n";

import { messageOf } from "#/base/errors.ts";
import { loadConfig } from "#/infra/config.ts";
import { HomeTaken, leaseHome } from "#/infra/lease.ts";
import { makeLogger } from "#/infra/log.ts";
import { wallTime } from "#/infra/time.ts";
import { dshRuntime } from "#/modules/runtime/dsh.ts";
import { deepseekAccess, openDurable } from "#/modules/runtime/durable.ts";
import { makeHelpers } from "#/modules/runtime/helperExtension.ts";
import { registryOf } from "#/modules/runtime/runtime.ts";
import { helperKey, vibevalleyRuntimeOf } from "#/modules/runtime/vibevalley.ts";

import { instructions } from "./prompts.ts";

/** What the user should be told went wrong: said on stderr, and the conversation ends. */
class ChatRefused extends Error {
  override readonly name = "ChatRefused";
}

const dim = (s: string) => "\x1b[2m" + s + "\x1b[0m";
const short = (s: string) => {
  const r = [...s];
  return (r.length > 120 ? r.slice(0, 120).join("") + "…" : s).split(/\s+/u).filter(Boolean).join(" ");
};
const write = (s: string) => process.stdout.write(s);

type Typed = { readonly kind: "line"; readonly text: string } | { readonly kind: "interrupt" };

/** Lines typed and Ctrl+C, until the input ends or the reader stops. */
async function* terminal(): AsyncGenerator<Typed> {
  const typed = new Queue<Typed>();
  const rl = createInterface({ input: process.stdin, terminal: false });
  rl.on("line", (l) => typed.offer({ kind: "line", text: l.trim() }));
  rl.on("close", () => typed.end());
  const interrupt = () => typed.offer({ kind: "interrupt" });
  process.on("SIGINT", interrupt);
  try {
    yield* typed;
  } finally {
    process.off("SIGINT", interrupt);
    rl.close();
  }
}

/** Each thing typed, handled in order, until handle says the user is done (/exit, Ctrl+C with nothing under way) or the input ends. */
async function typed(handle: (t: Typed) => Promise<"quit" | void>): Promise<void> {
  for await (const typedIn of terminal()) if ((await handle(typedIn)) === "quit") return;
}

interface OwnChat {
  /** The folder it works in; the current one when empty. */
  readonly cwd: string;
  /** Its home under ~/.vibevalley/agent. */
  readonly name: string;
  /** DeepSeek's default when empty. */
  readonly model: string;
  /** The MCP config; <home>/mcp.json when empty. */
  readonly mcp: string;
  /** One question and its answer. */
  readonly p?: string;
}

const toOarMcp = (s: McpServer): OarMcpServer[] =>
  s.url !== undefined
    ? [{ name: s.name, type: "http", url: s.url, ...(s.headers ? { headers: s.headers } : {}) }]
    : s.command !== undefined
      ? [{ name: s.name, command: s.command, ...(s.args ? { args: s.args } : {}), ...(s.env ? { env: s.env } : {}) }]
      : [];

/** The conversation with VibeValley's own agent: the runtime a helper runs on, on a harness of its own in its home. It
 * goes on with the same conversation each time, until /reset. */
export async function ownChat(values: OwnChat): Promise<void> {
  const config = await loadConfig();
  // The key of the config and the environment (the app's settings are the server's), and the global fetch: no farm here.
  const models = deepseekAccess({ key: () => config.deepseek.apiKey, fetch: globalThis.fetch, clock: wallTime });
  const cannot = models.cannotAsk();
  if (cannot !== undefined) throw new ChatRefused(cannot);
  const cwd = values.cwd ? resolve(values.cwd) : process.cwd();
  const home = join(homeOf(), "agent", values.name);
  const servers = await readMcpConfig(values.mcp || join(home, "mcp.json")).catch((e: unknown) => {
    throw new ChatRefused(messageOf(e), { cause: e });
  });
  await mkdir(home, { recursive: true });
  // pi-durable has no lock between processes, and the server's durable.db is the server's: this conversation keeps its
  // own file, leased while it runs. A second one under the same name keeps its conversation in memory.
  let release: (() => void) | undefined;
  try {
    release = leaseHome(home);
  } catch (e) {
    if (!(e instanceof HomeTaken)) throw e;
    process.stderr.write(dim(t("server.chat.notKept", { home })) + "\n");
  }
  const log = makeLogger({ name: "chat", level: "warn", write: (_level, _name, line) => process.stderr.write(dim(line) + "\n") });
  try {
    const helpers = makeHelpers({ memory: fileMemory(home, () => wallTime.now()), todos: () => memoryStore(), time: wallTime, log });
    const durable = await openDurable({ file: release ? join(home, "durable.db") : undefined, clock: wallTime, log, models, extensions: [helpers.extension] });
    const owner = new TaskGroup({ name: "chat" });
    try {
      const runtime = vibevalleyRuntimeOf({ durable, helpers, owner, log });
      const id = `chat.${values.name}`;
      const session = await runtime.session(
        { kind: "available", via: "bundled" },
        {
          cwd,
          resume: id,
          model: values.model || config.agent.model,
          systemPrompt: instructions(currentLocale()),
          mcpServers: servers.flatMap(toOarMcp),
        },
      );
      const skills = (await scanSkills(defaultSkillDirs(cwd))).length;
      const reset = async () => {
        await (await durable.existing(helperKey(id)))?.reset(undefined, BACKGROUND_CONTEXT);
        write(dim(t("server.chat.forgot")) + "\n");
      };
      await talk(session, values.p === undefined ? `vibevalley agent · ${cwd} · ${home}\n` + t("server.chat.hello", { skills }) : undefined, values.p, reset);
    } finally {
      await owner.close();
      await durable.close();
    }
  } finally {
    release?.();
  }
}

/** What a runtime said, as lines. */
function render(e: Event): string | undefined {
  switch (e.kind) {
    case "text_delta":
      write(e.text);
      return undefined;
    case "reasoning":
      return e.content.kind === "text" ? dim(e.content.text) : undefined;
    case "tool_call_started":
      return dim("→ " + e.tool + " " + short(e.input ?? ""));
    case "tool_call_ended":
      return dim((e.result === "failed" ? "✗ " : "✓ ") + short((e.content ?? []).map((c) => ("text" in c ? c.text : "")).join("")));
    case "turn_ended":
      return e.outcome.kind === "failed" ? t("server.chat.error", { why: e.outcome.reason }) : "";
    default:
      break;
  }
  return undefined;
}

interface RuntimeChat {
  readonly model?: string;
  readonly effort?: string;
  /** A runtime session to go on with. */
  readonly resume?: string;
  readonly cwd?: string;
  readonly p?: string;
}

/** A conversation with one runtime on this machine: no issue, any folder, and nothing in the core state, trajectories or spending. */
export async function runtimeChat(id: string, values: RuntimeChat): Promise<void> {
  if (id === "vibevalley")
    return ownChat({ cwd: values.cwd ?? "", name: "vibevalley", model: values.model ?? "", mcp: "", ...(values.p !== undefined ? { p: values.p } : {}) });
  const registry = registryOf([dshRuntime]);
  const runtime = registry.get(id);
  if (!runtime) throw new ChatRefused(t("server.chat.noRuntime", { id }));
  const installation = runtime.installation;
  if (!installation) throw new ChatRefused(t("server.chat.unknownInstall", { id }));
  const found = await installation();
  if (found.kind !== "available") throw new ChatRefused(t("server.chat.unusable", { id, kind: found.kind }));
  const cwd = values.cwd ? resolve(values.cwd) : process.cwd();
  const session: Session = await runtime.session(found, {
    cwd,
    ...(values.model ? { model: values.model } : {}),
    ...(values.effort ? { effort: values.effort } : {}),
    ...(values.resume ? { resume: values.resume } : {}),
  });
  await talk(session, `${id} · ${session.id}${values.resume ? t("server.chat.resumed") : ""}\n` + t("server.chat.direct"), values.p);
}

/** The lines typed, one turn at a time, until /exit or Ctrl+C when nothing is under way; header is said first. The
 * session is let go of at the end. */
async function talk(session: Session, header: string | undefined, p: string | undefined, reset?: () => Promise<void>): Promise<void> {
  try {
    if (header !== undefined) write(dim(header) + "\n");
    session.events(
      (e) => {
        const line = render(e);
        if (line !== undefined) write(line + "\n");
      },
      { cursor: { sessionId: session.id, afterSeq: -1 } },
    );
    const said = (r: unknown, words: "rejected" | "notSent") => {
      const why = typeof r === "object" && r !== null && "reason" in r && typeof r.reason === "string" ? r.reason : "";
      if (typeof r === "object" && r !== null && "kind" in r && r.kind === "rejected") write(dim(t(`server.chat.${words}`, { why })) + "\n");
    };
    // One turn at a time: a line typed while it runs is steered into it or queued after it. Stopping the turn's task
    // aborts the prompt (its signal).
    const turnOf = async (text: string, signal?: AbortSignal) => {
      try {
        said(await promptAndWait(session, text, signal ? { signal } : {}), "rejected");
      } finally {
        if (p === undefined) write("› ");
      }
    };
    if (p !== undefined) return await turnOf(p);
    await using turns = new TaskGroup({ name: "chat", onError: (_, e) => write(dim(messageOf(e)) + "\n") });
    write("› ");
    await typed(async (typedIn) => {
      const busy = turns.has("turn");
      if (typedIn.kind === "interrupt") {
        if (!busy) {
          write("\n");
          return "quit";
        }
        return turns.stop("turn");
      }
      const text = typedIn.text;
      if (text === "/exit") return "quit";
      // A reset asked during a turn is kept for its end.
      if (text === "/reset" && reset) {
        await reset();
        if (!busy) write("› ");
        return;
      }
      if (!text) {
        if (!busy) write("› ");
        return;
      }
      if (!busy) {
        turns.keyed("turn", (signal) => turnOf(text, signal));
        return;
      }
      try {
        said(await (session.steer ? session.steer(text) : session.queue(text)), "notSent");
      } catch (e) {
        write(dim(messageOf(e)) + "\n");
      }
    });
  } finally {
    await session.dispose();
  }
}
