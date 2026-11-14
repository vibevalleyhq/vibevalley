import type { Tool as LoopTool } from "@vibevalley/agent/core/tool";
import { selfTools } from "@vibevalley/agent/self";
import { Semaphore, TaskGroup } from "@vibevalley/async";
import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { defaultOrchestrator, orchestratorRuntime, userId } from "@vibevalley/protocol";

import { type Caller, orchestrator } from "#/base/actor.ts";
import { serverFile } from "#/base/assets.ts";
import { head } from "#/base/clip.ts";
import { BizCode, refuseIn } from "#/base/errors.ts";
import { usersLanguage } from "#/base/prompts.ts";
import { agentHome, reposDir, type ServerConfig } from "#/infra/config.ts";
import { bestEffort, type Logger } from "#/infra/log.ts";
import { localeMinute, type Time } from "#/infra/time.ts";
import type { Agent } from "#/modules/agent/agent.ts";
import { defaultModel } from "#/modules/agent/durable.ts";
import { runtimeLabel } from "#/modules/agent/presets.ts";
import { noDeepSeekKey } from "#/modules/agent/profile.ts";
import { traitsOf } from "#/modules/agent/prompts.ts";
import type { Channel } from "#/modules/channel/channel.ts";
import type { Issue } from "#/modules/issue/issue.ts";
import { nextRun } from "#/modules/issue/when.ts";
import type { Pkm } from "#/modules/pkm/pkm.ts";
import type { Repo } from "#/modules/repo/repo.ts";
import type { Handed, Picked } from "#/modules/session/envelope.ts";
import { type AgentHost, SubmitRefused } from "#/modules/session/host.ts";
import type { ToolStart } from "#/modules/session/reaction.ts";
import type { Session } from "#/modules/session/session.ts";

import type { Answer } from "./openai.ts";
import { agentPrompt, channelLine, identityNote, lineWords, pkmHitLine, situationWords, systemPrompt, voiceNote } from "./prompts.ts";
import { makeResponses } from "./response.ts";
import { deepseekModel, intake, orchestratorEnvelopeLines, quotaText, situationDelta, type Source } from "./situation.ts";

const refused = refuseIn(BizCode.OrchestratorRefused);

export const orchestratorSkills = serverFile("src/modules/orchestrator/skills");
const keepEvents = 1000;
const notesShown = 8;
const notesRecalled = 3;
const resumeWithinMs = 30 * 60_000;

export type Pick = Picked;

interface HostContext {
  readonly channel: string;
  readonly envelope: string;
  readonly agent?: string;
  readonly source: Source;
  readonly issue?: string;
  /** True when user-authored messages are in the batch; required by `actsForUser` for issue mutations. */
  readonly user?: boolean;
}

/** What an assistant's host is made with, but for its model, its tools and where it speaks: the same for the farm and
 * its evals (testing/evals.ts). */
export const orchestratorHost = (config: ServerConfig, id: string, profile: T.Agent | undefined) => ({
  session: {
    id,
    role: "orchestrator" as const,
    agent: id,
    name: profile?.name || t("server.orchestrator.label"),
    runtime: orchestratorRuntime,
    brief: profile?.duty ?? "",
  },
  inputType: orchestratorInput,
  home: agentHome(config, id),
  cwd: reposDir(config),
  // Append custom profile identity after the shared prefix so default orchestrator eval caches stay stable.
  instructions: systemPrompt + agentPrompt + (id === defaultOrchestrator || !profile ? "" : identityNote(profile.name, profile.persona)),
  skills: [orchestratorSkills],
  keepEvents,
});

/** The kind of entry an input to the assistant is kept as. */
export const orchestratorInput = "orchestratorInput";

export interface Orchestrator {
  /** Aborts the orchestrator's own turn and queued inputs without stopping helper sessions. */
  readonly stop: (agent?: string) => Promise<void>;
  readonly markWrong: (on: number, want: string, agent?: string) => Promise<T.OrchestratorEval>;
  readonly answerer: (on: "api" | "phone") => (model: string) => Answer | undefined;
  /** Throws NotAnswered. */
  readonly brief: (line: string, signal?: AbortSignal) => Promise<string>;
  /** Stops hearing the farm and closes each orchestrator's host, then the open responses. */
  readonly close: () => Promise<void>;
}

export interface OrchestratorOptions {
  /** Whether it hears the farm; a test without a model does not, so nothing reaches a model. */
  readonly listen?: boolean;
}

/** The farm's tools as the orchestrator holds them. gateway/tool serves them and reaches every module, the orchestrator
 * among them, so they are built after the modules and handed in at assembly (services.ts), like Core's Projection. */
export interface OrchestratorTools {
  /** Its tools, in the order its prompt has always listed them: the order is part of the prompt's prefix. */
  readonly orchestrator: (who: () => Caller) => LoopTool[];
  /** How a tool call reads in its trajectory: its label and the first naming argument. */
  readonly start: (name: string, args: unknown) => ToolStart;
  readonly sessionLine: (session: T.Session) => string;
}

export interface OrchestratorDeps {
  readonly clock: Time;
  readonly log: Logger;
  readonly config: ServerConfig;
  readonly agent: Agent;
  readonly repo: Repo;
  readonly pkm: Pkm;
  readonly session: Session;
  readonly channel: Channel;
  readonly issue: Issue;
  readonly tools: OrchestratorTools;
}

export async function makeOrchestrator(deps: OrchestratorDeps, options: OrchestratorOptions = {}): Promise<Orchestrator> {
  const { clock, config, agent: store, repo: repos, pkm: notes, session: run, channel: chat, issue: issues, tools: tool } = deps;
  const log = deps.log.child("orchestrator");
  const responses = makeResponses(run, issues, chat, clock);
  const tasks = new TaskGroup({ name: "orchestrator", onError: (task, e) => log.error(`vibevalley: the orchestrator's ${task} failed`, e) });

  const toolsFor = (id: string) => (current: () => HostContext) =>
    tool.orchestrator(() => {
      const at = current();
      return { agent: id, session: "", repo: "", here: at.channel, picked: at.agent ?? "", envelope: at.envelope, actor: orchestrator(at.user ?? false) };
    });

  interface Instance {
    readonly id: string;
    readonly home: string;
    readonly host: AgentHost<HostContext>;
    /** What it last said it cannot start for, per channel: said once, not to every line, until it starts. */
    readonly cannot: Map<string, string>;
    shown: string;
  }
  const instances = new Map<string, Instance>();
  /** One instance per orchestrator, however many inputs ask for it at once. */
  const making = new Semaphore(1);

  const instanceOf = (id: string): Promise<Instance> =>
    making.with(async () => {
      const had = instances.get(id);
      if (had) return had;
      const home = agentHome(config, id);
      // Read as the conversation starts, so a model the profile names meanwhile is taken up; the key is read at each request.
      const modelOf = () => deepseekModel(store.agent(id)?.model.trim() ?? "", defaultModel);
      const wakeSoon = (withinMs: number) => {
        const by = clock.now() + withinMs;
        return issues.crons().some((s) => {
          const next = nextRun(s);
          return next !== undefined && (s.agent || chat.orchestratorIn(s.channel)) === id && next <= by;
        });
      };
      const host = await run.host<HostContext>({
        ...orchestratorHost(config, id, store.agent(id)),
        model: modelOf,
        tools: toolsFor(id),
        wakeSoon,
        first: { channel: chat.defaultChannel(), envelope: "", source: "user" },
        quiet: () => false,
        say: async (r, text, runId) => {
          // A run's words are best kept, never a reason the run fails; nothing said is nothing written.
          if (text.trim()) await bestEffort(log, "a run's words", () => chat.post({ from: id, channel: r.channel, text: text, run: runId }));
        },
        channel: (r) => r.channel,
        fresh: () => {
          me.shown = "";
        },
        restored: (r) => ({ ...(r.issue ? { issue: r.issue } : {}), by: { kind: intake[r.source].trigger, channel: r.channel } }),
        toolStart: tool.start,
      });
      const me: Instance = { id, home, cannot: new Map(), shown: "", host };
      instances.set(id, me);
      return me;
    });
  const target = (id: string | undefined) => instanceOf(id && store.isOrchestrator(id) ? id : defaultOrchestrator);

  const agentLines = async () => {
    const lines: string[] = [];
    for (const a of store.agents()) {
      const assessed = await store.assess(a);
      const p = assessed.agent;
      let line = situationWords.agent(p.name, p.id, runtimeLabel(p.runtime), traitsOf(p));
      if (p.enabled && assessed.blocking.length === 0) line += situationWords.quota(quotaText(assessed.info));
      else if (assessed.blocking[0]) line += situationWords.blocked(assessed.blocking[0].text);
      else line += situationWords.disabled;
      lines.push(line);
    }
    return lines;
  };

  // Place target channel on the final line so switching channels invalidates only one line in `situationDelta`.
  const situation = async (channel: string) => {
    const sessions = await agentLines();
    const roster = run.hired();
    const here = await chat.addressOf(channel);
    const byChannel = (await chat.channels()).map((c) => {
      const theirs = roster.filter((session) => (session.channel ?? chat.defaultChannel()) === c.id).map((session) => tool.sessionLine(session));
      const head = channelLine(c);
      return head + "\n" + (theirs.length > 0 ? theirs.join("\n") : situationWords.noHelpers);
    });
    const all = await repos.list();
    const folders = all.length > 0 ? situationWords.repos(all.map((p) => p.name)) : situationWords.noRepos;
    const working = (await notes.list()).pages.filter((p) => p.tier === "project").slice(0, notesShown);
    return situationWords.whole(
      repos.root,
      folders,
      situationWords.notes(working.map((p) => situationWords.noteRepo(p.title, p.tldr, p.open))),
      sessions.join("\n"),
      byChannel.join("\n"),
      here.direct ? situationWords.direct(here.target) : here.target,
      usersLanguage(),
    );
  };

  const situationNow = async (me: Instance, busy: boolean, channel: string) => {
    const now = await situation(channel);
    const shownNow = !busy && me.shown !== "" ? situationDelta(me.shown, now) : now;
    me.shown = busy ? "" : now;
    return shownNow;
  };

  const news = async (me: Instance): Promise<[string, string[]]> => {
    const digest = await run.digest(me.id);
    return digest.length === 0 ? ["", []] : [situationWords.news(orchestratorEnvelopeLines(digest)), digest.map((m) => m.id)];
  };

  const recall = async (source: Source, line: string) => {
    if (source !== "user" || line.trim().length < 4) return "";
    const hits = await notes.search({ text: head(line, 200), limit: notesRecalled });
    return situationWords.recalled(hits.map(pkmHitLine));
  };

  const pickedNote = (picked: Pick) => {
    let note = "";
    const a = picked.agent ? store.agent(picked.agent) : undefined;
    if (a) note += lineWords.pickedAgent(a.name);
    if (picked.repo) note += lineWords.pickedRepo(picked.repo);
    return note;
  };

  /** Whether the orchestrator took the line in; one it did not is handed back to the run. */
  const heardInChat = async (n: Handed): Promise<void> => {
    const fromPerson = n.messages.every((m) => m.from === userId);
    const user = n.messages.some((m) => m.from === userId);
    const picked: Pick = n.messages.findLast((m) => m.picked)?.picked ?? {};
    const response = n.messages.findLast((message) => message.responsePort);
    const voice = n.messages.findLast((message) => message.voiceMode);
    const caller = response?.responsePort ? responses.take(response.responsePort) : undefined;
    const source: Source = n.source ?? (fromPerson ? "user" : "chat");
    const rule = intake[source];
    const line = n.source
      ? n.messages.map((message) => message.text.replace(new RegExp(`^@${n.agent}\\s*`, "u"), "")).join("\n")
      : voice?.voiceMode === "dictated"
        ? pickedNote(picked) + lineWords.dictated + lineWords.user(n.messages.map((message) => message.text).join("\n"))
        : voice?.voiceMode === "conversation"
          ? voiceNote + "\n" + lineWords.user(n.messages.map((message) => message.text).join("\n"))
          : n.messages.every((message) => message.number === 0)
            ? pickedNote(picked) + lineWords.events(orchestratorEnvelopeLines(n.messages))
            : fromPerson && (n.type === "direct" || n.channel === chat.defaultChannel())
              ? pickedNote(picked) + lineWords.user(n.messages.map((m) => m.text).join("\n"))
              : pickedNote(picked) + lineWords.chat(n.target, orchestratorEnvelopeLines(n.messages));
    const asked = rule.head + line;
    const envelopes = n.messages.map((message) => message.id);
    const envelope =
      n.messages.findLast((message) => message.from === userId)?.originTrigger ??
      n.messages.findLast((message) => message.from === userId)?.id ??
      n.messages.at(-1)?.originTrigger ??
      n.messages.at(-1)?.id ??
      "";
    let taken: boolean;
    try {
      const me = await target(n.agent);
      try {
        await me.host.submit(
          async (busy, memoryNews) => {
            const [heard, ids] = await news(me);
            const now = clock.now();
            const text = [situationWords.now(localeMinute(now)), await situationNow(me, busy, n.channel), memoryNews, await recall(source, line), heard, asked]
              .filter((p) => p !== "")
              .join("\n\n");
            return { text, heard: [...new Set([...ids, ...envelopes])] };
          },
          {
            route: {
              channel: n.channel,
              envelope,
              ...(picked.agent ? { agent: picked.agent } : {}),
              source,
              ...(n.issue ? { issue: n.issue } : {}),
              ...(user ? { user: true } : {}),
            },
            run: { ...(n.issue ? { issue: n.issue } : {}), by: { ...(n.by ?? { kind: rule.trigger }), channel: n.channel }, asked },
            ...(caller ? { caller } : {}),
          },
          rule.now,
        );
        me.cannot.clear();
        taken = true;
      } catch (e) {
        if (!(e instanceof SubmitRefused)) throw e;
        const words = e.why === noDeepSeekKey() ? t("server.orchestrator.noKey") : t("server.orchestrator.cannotStart", { why: e.why });
        const again = me.cannot.get(n.channel) === words;
        me.cannot.set(n.channel, words);
        if (!again) await bestEffort(log, "a run's words", () => chat.post({ from: me.id, channel: n.channel, text: words, run: e.run }));
        taken = false;
      }
    } catch (e) {
      caller?.fail(e);
      log.error(`vibevalley: the orchestrator could not take ${source}:`, e);
      taken = false;
    }
    if (!taken) for (const message of n.messages) await run.handBack(n.agent, message.id);
  };

  if (options.listen ?? true) {
    // Subscribed now, before anything the modules after it start can hand a line over.
    const heard = run.deliveries();
    tasks.run("hearing", async (signal) => {
      try {
        for (;;) {
          const next = await heard.next(signal);
          if (next.done === true) return;
          const n = next.value;
          if (n._tag !== "Handed") continue;
          try {
            await heardInChat(n);
          } catch (e) {
            log.error("vibevalley: the orchestrator could not take a line:", e);
          }
        }
      } finally {
        heard.close();
      }
    });
    // Every host first, then the resumes: the first resume lets the harness go on with every conversation left mid-run,
    // and each needs its host's extension installed by then.
    const unfinished: Instance[] = [];
    for (const a of store.orchestrators()) {
      const me = await instanceOf(a.id);
      if (await me.host.unfinished()) unfinished.push(me);
    }
    for (const me of unfinished) tasks.run(`resume ${me.id}`, () => me.host.resume(resumeWithinMs));
  }

  const modelId = (id: string) => {
    try {
      return deepseekModel(store.agent(id)?.model.trim() ?? "", defaultModel);
    } catch {
      // No model to ask (no key): the eval is named by the profile's model as written.
      return store.agent(id)?.model ?? "";
    }
  };

  return {
    stop: async (agent) => {
      const id = agent && store.isOrchestrator(agent) ? agent : defaultOrchestrator;
      const me = instances.get(id);
      if (me) await me.host.stop();
    },
    markWrong: async (on, want, agent) => {
      let me: Instance;
      try {
        me = await target(agent);
      } catch (e) {
        throw refused(e instanceof Error ? e.message : String(e));
      }
      return me.host.markWrong(
        on,
        want,
        modelId(me.id),
        [...toolsFor(me.id)(() => me.host.current().route), ...selfTools({ home: me.home, skills: async () => [], memory: true, now: () => 0 })].map(
          (item) => item.name,
        ),
      );
    },
    answerer: (on) => responses.answerer(on),
    brief: (line, signal) => responses.brief(line, signal),
    close: async () => {
      // The hosts close while the tasks stop: a resume in a task ends with its host.
      const stopping = tasks.close();
      await Promise.all([...instances.values()].map((me) => me.host.close()));
      await stopping;
      responses.closeAll();
    },
  };
}
