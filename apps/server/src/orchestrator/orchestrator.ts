import { Cause, Clock, Context, Effect, FiberSet, Layer, Scope, Semaphore, Stream } from "effect";

import { selfTools } from "@vibevalley/agent/self";
import { defaultModel, type ModelClient } from "@vibevalley/ai/client";
import { Llm } from "@vibevalley/ai/llm";
import { t } from "@vibevalley/i18n";
import type { OrchestratorEval, RunTrigger } from "@vibevalley/protocol";
import { defaultOrchestrator, ownerId } from "@vibevalley/protocol";

import { Agent } from "@/agent/agent.ts";
import { modelClient, noDeepSeekKey } from "@/agent/model.ts";
import { traitsOf } from "@/agent/prompts.ts";
import { orchestrator } from "@/base/actor.ts";
import { Channel, type OrchestratorNews, type SayMore } from "@/channel/chat.ts";
import type { Picked } from "@/channel/wake.ts";
import { Core } from "@/core/core.ts";
import { Cron } from "@/cron/cron.ts";
import { nextRun } from "@/cron/when.ts";
import type { ApiError } from "@/errors.ts";
import { Inbox, type Overdue } from "@/inbox/inbox.ts";
import { agentHome, projectsDir, ServerConfig } from "@/infra/config.ts";
import { localeMinute } from "@/infra/time.ts";
import { Issue, type OrchestratorWork } from "@/issue/issue.ts";
import { Project } from "@/project/project.ts";
import { ownersLanguage } from "@/prompts.ts";
import { runtimeLabel } from "@/runtime/presets.ts";
import { Runtime } from "@/runtime/runtime.ts";
import { type AgentHost, Caller, type NotAnswered } from "@/session/host.ts";
import { Session } from "@/session/session.ts";
import { Setting } from "@/setting/setting.ts";
import { isOpen } from "@/task/graph.ts";
import { graphText } from "@/task/prompts.ts";
import { Task } from "@/task/task.ts";
import { channelLine } from "@/tool/prompts.ts";
import { Tool } from "@/tool/tool.ts";

import { intake, type Source } from "./intake.ts";
import { deepseekModel, orchestratorModel } from "./model.ts";
import type { Answer } from "./openai.ts";
import { agentPrompt, identityNote, lineWords, patrolText, situationWords, systemPrompt, voiceNote } from "./prompts.ts";
import { orchestratorInboxLines, quotaText, situationDelta } from "./situation.ts";

const keepEvents = 1000;
/** A run cut off longer ago than this is left: what it was for has likely moved on. */
const resumeWithinMs = 30 * 60_000;

/** What the owner chose beside the words (the sowing form, the chat's profile pick); empty for none. */
export type Pick = Picked;

/** Where an input's answer goes and what it is worth; kept with it in the transcript. */
interface Route {
  readonly channel: string;
  /** The profile the owner picked beside the words. */
  readonly agent?: string;
  readonly quiet?: boolean;
  readonly source: Source;
  /** The issue handed to the orchestrator that this input is; its run ends when the orchestrator's settles. */
  readonly issue?: string;
  /** The owner's own words are in this input: only then may the orchestrator complete an issue or change one. */
  readonly owner?: boolean;
}

/** One input as its producer gives it: the intake table fills in the rest by its source. */
interface Intake {
  /** The orchestrator it is for, by its profile id; the default one when none is named. */
  readonly to?: string;
  readonly source: Source;
  readonly line: string;
  readonly channel: string;
  readonly agent?: string;
  readonly owner?: boolean;
  readonly issue?: string;
  /** What started its run, when the producer knows better than its source (an issue's trigger, a missed cron). */
  readonly by?: RunTrigger;
  readonly caller?: Caller;
}

export class Orchestrator extends Context.Service<
  Orchestrator,
  {
    /** The owner's words in a channel, from any door (the page, a chat app); the owner speaking opens the farm. sendKey:
     * the client's key for this send, a retry with the same key is the message already said. */
    readonly say: (text: string, pick: Pick, channel: string | undefined, sendKey: string, more?: SayMore) => Effect.Effect<void, ApiError>;
    /** A voice transcript the owner chose for the orchestrator to overhear. */
    readonly heard: (text: string, agent: string, sendKey: string) => Effect.Effect<void, ApiError>;
    /** Something to tell the owner on the phone: given as from an issue, after what the orchestrator is on, it answers in the default channel
     * as always; the whole answer comes back to be read out. Interrupting ends only this wait, not the shared run. */
    readonly brief: (line: string) => Effect.Effect<string, NotAnswered>;
    /** The orchestrator as orchestratorModel on a chat/completions endpoint: what is asked there is the owner's, as in the chat.
     * On the phone (the voice line) the words are said in the default channel too, and the answer is one to be read out. */
    readonly answerer: (on: "phone" | "api") => (model: string) => Answer<NotAnswered> | undefined;
    /** The lines waiting for an orchestrator (the default one when none is named) are dropped with its run; the sessions
     * it sent keep working. */
    readonly stop: (agent?: string) => Effect.Effect<void>;
    readonly markWrong: (on: number, want: string, agent?: string) => Effect.Effect<OrchestratorEval, ApiError>;
  }
>()("vibevalley/Orchestrator") {
  static readonly layer = (options?: OrchestratorOptions) => Layer.effect(Orchestrator, make(options));
}

export interface OrchestratorOptions {
  /** The model; absent, DeepSeek with the key in settings. */
  readonly llm?: () => ModelClient;
  /** Whether it hears the farm; a test without a model does not, so nothing reaches a model. */
  readonly listen?: boolean;
}

const make = (options: OrchestratorOptions = {}) =>
  Effect.gen(function* () {
    const clock = yield* Clock.Clock;
    const config = yield* ServerConfig;
    const core = yield* Core;
    const store = yield* Agent;
    const settings = yield* Setting;
    const runtimes = yield* Runtime;
    const projects = yield* Project;
    const run = yield* Session;
    const issue = yield* Issue;
    const chat = yield* Channel;
    const tasks = yield* Task;
    const cron = yield* Cron;
    const tool = yield* Tool;
    const inbox = yield* Inbox;

    // Fibers started from callbacks belong to this service: they end with it and keep its services (the logger).
    const service = yield* Llm;
    const forkHere = yield* FiberSet.makeRuntime();
    const scope = yield* Effect.scope;

    const toolsFor = (id: string) => (current: () => Route) =>
      tool.orchestrator(() => {
        const at = current();
        return { agent: id, session: "", project: "", here: at.channel, picked: at.agent ?? "", actor: orchestrator(at.owner ?? false) };
      });

    /** One orchestrator: its own host (conversation, queue, run), home, model, and what it was last shown and told. */
    interface Instance {
      readonly id: string;
      readonly home: string;
      readonly host: AgentHost<Route>;
      /** What it last said it cannot start for, per channel: said once, not to every line, until it starts. */
      readonly cannot: Map<string, string>;
      /** The farm's situation as its model last saw it in an input; "" when it should see the whole of it next. */
      shown: string;
    }
    const instances = new Map<string, Instance>();
    /** One instance per orchestrator, however many inputs ask for it at once. */
    const making = yield* Semaphore.make(1);
    /** The caller the last spoken answer streams to (a call, chat/completions): a newer one ends it. */
    let latestCall: Caller | undefined;

    const instanceOf = (id: string): Effect.Effect<Instance> =>
      making.withPermits(1)(
        Effect.gen(function* () {
          const had = instances.get(id);
          if (had) return had;
          const home = agentHome(config, id);
          const llmOf = (): ModelClient => {
            if (options.llm) return options.llm();
            // The key saved in settings, asked before each request: one saved while the orchestrator runs is used at once.
            return modelClient(deepseekModel(store.agent(id)?.model.trim() ?? "", defaultModel), () => settings.deepseekApiKey() || undefined, service);
          };
          // One of its own crons (not a helper's) comes due within that long: it will be woken then.
          const wakeSoon = (withinMs: number) => {
            const by = clock.currentTimeMillisUnsafe() + withinMs;
            return cron.list().some((s) => {
              const next = nextRun(s);
              return next !== undefined && (s.agent || chat.orchestratorOf(s.channel)) === id && next <= by;
            });
          };
          const profile = store.agent(id);
          const me: Instance = {
            id,
            home,
            cannot: new Map(),
            shown: "",
            host: yield* run
              .host<Route>({
                name: id,
                label: profile?.name || t("server.orchestrator.label"),
                inputType: "orchestratorInput",
                home,
                cwd: projectsDir(config),
                // The default orchestrator's prefix is the one its evals hold; another says who it is after it.
                instructions: systemPrompt + agentPrompt + (id === defaultOrchestrator || !profile ? "" : identityNote(profile.name, profile.persona)),
                llm: llmOf,
                tools: toolsFor(id),
                wakeSoon,
                first: { channel: chat.defaultChannel(), source: "owner" },
                quiet: (r) => r.quiet ?? false,
                say: (r, text, runId) => chat.orchestratorSays(r.channel, text, runId, id),
                // The chat shows where it thinks or writes; what it answers off the chat (the local chat/completions) shows nowhere.
                state: (s, r) => core.setOrchestrator(id, s, r && (s === "thinking" || s === "speaking") && r.quiet !== true ? r.channel : undefined),
                fresh: () => {
                  me.shown = "";
                },
                restored: (r) => ({ ...(r.issue ? { issue: r.issue } : {}), by: { kind: intake[r.source].trigger } }),
                keepEvents,
                toolStart: tool.start,
                notice: (level, text) => core.notice(level, text),
              })
              .pipe(Scope.provide(scope)),
          };
          instances.set(id, me);
          return me;
        }),
      );
    /** The orchestrator an input goes to: the one named while it is an orchestrator, else the default one. */
    const target = (id: string | undefined) => instanceOf(id && store.isOrchestrator(id) ? id : defaultOrchestrator);

    const agentLines = Effect.gen(function* () {
      const lines: string[] = [];
      for (const a of store.agents()) {
        const assessed = yield* runtimes.assess(a);
        const p = assessed.agent;
        let line = situationWords.agent(p.name, p.id, runtimeLabel(p.runtime), traitsOf(p));
        if (p.enabled && assessed.blocking.length === 0) line += situationWords.quota(quotaText(assessed.info));
        else if (assessed.blocking.length > 0) line += situationWords.blocked(assessed.blocking[0]!.text);
        else line += situationWords.disabled;
        lines.push(line);
      }
      return lines;
    });

    // channel is where the input it goes with will be answered. Said last and on a line of its own, so that
    // answering in another channel changes one line of it.
    const situation = (channel: string) =>
      Effect.gen(function* () {
        const sessions = yield* agentLines;
        const roster = run.roster();
        const here = yield* chat.addressOf(channel);
        const byChannel = (yield* chat.channels()).map((c) => {
          const theirs = roster.filter((w) => (w.session.channel ?? chat.defaultChannel()) === c.id).map((w) => tool.sessionLine(w));
          const head = channelLine(c);
          return head + "\n" + (theirs.length > 0 ? theirs.join("\n") : situationWords.noHelpers);
        });
        const all = yield* projects.list();
        const folders = all.length > 0 ? situationWords.projects(all.map((p) => p.name)) : situationWords.noProjects;
        const open = tasks.graphs().filter(isOpen).map(graphText);
        const graphs = open.length > 0 ? situationWords.graphs(open) : "";
        return situationWords.whole(
          projects.root,
          folders,
          sessions.join("\n"),
          byChannel.join("\n"),
          graphs,
          here.direct ? situationWords.direct(here.target) : here.target,
          ownersLanguage(),
        );
      });

    // The situation for the next input: the whole of it, or what changed since the input before. An input given while
    // the agent is busy may be taken after one given later, so it carries the whole, and the one after it does too.
    const situationNow = (me: Instance, busy: boolean, channel: string) =>
      Effect.map(situation(channel), (now) => {
        const shownNow = !busy && me.shown !== "" ? situationDelta(me.shown, now) : now;
        me.shown = busy ? "" : now;
        return shownNow;
      });

    const news = (me: Instance): Effect.Effect<[string, string[]], ApiError> =>
      Effect.map(chat.orchestratorDigest(me.id), (digest) =>
        digest.length === 0 ? ["", []] : [situationWords.news(orchestratorInboxLines(digest)), digest.map((m) => m.id)],
      );

    const taking = (i: Intake) =>
      Effect.gen(function* () {
        const me = yield* target(i.to);
        const rule = intake[i.source];
        const asked = rule.head + i.line;
        const route: Route = {
          channel: i.channel,
          ...(i.agent ? { agent: i.agent } : {}),
          source: i.source,
          ...(i.issue ? { issue: i.issue } : {}),
          ...(i.owner === true ? { owner: true } : {}),
        };
        const taken = yield* me.host.submit(
          (busy, memoryNews) =>
            Effect.gen(function* () {
              const [heard, ids] = yield* news(me);
              // The log shows the line; the model also gets the time, the farm and the news before it.
              const text = [
                situationWords.now(localeMinute(new Date(yield* Clock.currentTimeMillis))),
                yield* situationNow(me, busy, i.channel),
                memoryNews,
                heard,
                asked,
              ]
                .filter((p) => p !== "")
                .join("\n\n");
              return { text, heard: ids };
            }),
          { route, run: { ...(i.issue ? { issue: i.issue } : {}), by: i.by ?? { kind: rule.trigger }, asked }, ...(i.caller ? { caller: i.caller } : {}) },
          rule.now,
        );
        if (taken.ok) {
          me.cannot.clear();
          return true;
        }
        const words = taken.why === noDeepSeekKey() ? t("server.orchestrator.noKey") : t("server.orchestrator.cannotStart", { why: taken.why });
        const again = me.cannot.get(i.channel) === words;
        me.cannot.set(i.channel, words);
        if (!again) yield* chat.orchestratorSays(i.channel, words, taken.run, me.id);
        return false;
      });

    /** Every input comes in here. false: the orchestrator could not start, and the channel was told why, once. It
     * never fails: an input that could not be taken is logged, and a caller waiting on it is failed instead of left open. */
    const take = (i: Intake): Effect.Effect<boolean> =>
      taking(i).pipe(
        Effect.catchCause((cause) =>
          Effect.as(
            Effect.sync(() => i.caller?.fail(Cause.squash(cause))).pipe(
              Effect.andThen(Effect.logError(`vibevalley: the orchestrator could not take ${i.source}: ${Cause.pretty(cause)}`)),
            ),
            false,
          ),
        ),
      );

    const pickedNote = (picked: Pick) => {
      let note = "";
      const a = picked.agent ? store.agent(picked.agent) : undefined;
      if (a) note += lineWords.pickedAgent(a.name);
      if (picked.project) note += lineWords.pickedProject(picked.project);
      return note;
    };

    const heardInChat = (n: OrchestratorNews) =>
      Effect.suspend(() => {
        const fromPerson = n.messages.every((m) => m.from === ownerId);
        const owner = n.messages.some((m) => m.from === ownerId);
        // The latest pick among them: it goes with its message.
        const picked: Pick = n.messages.findLast((m) => m.picked)?.picked ?? {};
        const line =
          fromPerson && (n.type === "direct" || n.channel === chat.defaultChannel())
            ? pickedNote(picked) + lineWords.owner(n.messages.map((m) => m.text).join("\n"))
            : pickedNote(picked) + lineWords.chat(n.target, orchestratorInboxLines(n.messages));
        return take({ to: n.agent, source: fromPerson ? "owner" : "chat", line, channel: n.channel, ...(picked.agent ? { agent: picked.agent } : {}), owner });
      });

    // A run of an issue for the orchestrator lasts until the orchestrator's run that takes the line settles.
    const onWork = (w: OrchestratorWork) =>
      Effect.gen(function* () {
        const channel = yield* chat.topOf(w.channel);
        const again = w.said ? lineWords.again(w.said) : "";
        let line = lineWords.issue(w.issue.title, w.issue.description, again, channel.name);
        const s = w.cron;
        if (s) {
          const missed = w.by.missed === true ? lineWords.missed : "";
          line = lineWords.cron(s.name, missed, s.text, channel.name, s.id);
        }
        // The issue's assignee is the orchestrator it is for; a cron that names none is its channel's orchestrator's.
        const to = w.issue.assignee || chat.orchestratorOf(channel.id);
        return yield* take({ to, source: s ? "cron" : "issue", line, channel: channel.id, issue: w.issue.id, by: w.by });
      });

    // One answer streams at a time, the call's or chat/completions', from the default orchestrator: a newer line ends the
    // one before.
    // The caller is made when the stream is first read: one that left before that starts no run. Its stream ending,
    // or being interrupted (the caller hung up), ends it.
    const answer = (line: string): Stream.Stream<string, NotAnswered> =>
      Stream.unwrap(
        Effect.sync(() => {
          const me = new Caller();
          latestCall?.end();
          latestCall = me;
          forkHere(take({ source: "owner", line, channel: chat.defaultChannel(), owner: true, caller: me }));
          return me.words.pipe(
            Stream.ensuring(
              Effect.sync(() => {
                me.end();
                if (latestCall === me) latestCall = undefined;
              }),
            ),
          );
        }),
      );

    const logged = <E>(what: string, effect: Effect.Effect<unknown, E>) =>
      effect.pipe(
        Effect.catchCause((cause) => Effect.logError(`vibevalley: the orchestrator could not take ${what}: ${Cause.pretty(cause)}`)),
        Effect.asVoid,
      );

    // A test that gave the orchestrator no model hears nothing: the other services run as without it, and nothing reaches a model.
    if (options.listen ?? true) {
      yield* Effect.forkScoped(Stream.runForEach(yield* chat.forOrchestrator, (n) => logged("a line", heardInChat(n))));
      yield* Effect.forkScoped(Stream.runForEach(yield* issue.forOrchestrator, (w) => logged("an issue", onWork(w))));
      yield* Effect.forkScoped(
        Stream.runForEach(yield* inbox.overdue, (o: Overdue) =>
          logged(
            "the patrol",
            Effect.flatMap(chat.topOf(o.channel), (c) =>
              take({ to: chat.orchestratorOf(o.channel), source: "patrol", line: patrolText(c.name, o.notes), channel: o.channel }),
            ),
          ),
        ),
      );
      yield* Effect.forkScoped(
        Stream.runForEach(yield* tasks.news, (line) => logged("a task graph's line", take({ source: "graph", line, channel: chat.defaultChannel() }))),
      );
      // Each orchestrator goes on with the run a stop cut off.
      for (const a of store.orchestrators()) {
        const me = yield* instanceOf(a.id);
        if ((options.llm || settings.deepseekApiKey()) && (yield* me.host.unfinished)) forkHere(me.host.resume(resumeWithinMs));
      }
    }

    yield* Effect.addFinalizer(() => Effect.forEach([...instances.values()], (me) => me.host.close, { concurrency: "unbounded", discard: true }));

    const modelId = (id: string) => {
      try {
        return options.llm ? options.llm().model.id : deepseekModel(store.agent(id)?.model.trim() ?? "", defaultModel);
      } catch {
        return store.agent(id)?.model ?? "";
      }
    };

    return Orchestrator.of({
      say: Effect.fn("Orchestrator.say")(function* (text, pick, channel, sendKey, more) {
        const a = pick.agent ? store.agent(pick.agent) : undefined;
        const picked: Pick = { ...(a ? { agent: a.id } : {}), ...((pick.project ?? "").trim() ? { project: pick.project!.trim() } : {}) };
        yield* core.open();
        yield* chat.say(text, channel, sendKey, { ...more, ...(picked.agent || picked.project ? { picked } : {}) });
      }),
      heard: Effect.fn("Orchestrator.heard")(function* (text, agent, sendKey) {
        yield* core.open();
        if (yield* chat.spoken(ownerId, text, sendKey)) return;
        const picked = agent ? store.agent(agent)?.id : undefined;
        forkHere(
          take({
            source: "owner",
            line: pickedNote(picked ? { agent: picked } : {}) + lineWords.dictated + lineWords.owner(text),
            channel: chat.defaultChannel(),
            ...(picked ? { agent: picked } : {}),
            owner: true,
          }),
        );
      }),
      brief: Effect.fn("Orchestrator.brief")(function* (line) {
        const me = new Caller();
        forkHere(take({ source: "issue", line, channel: chat.defaultChannel(), caller: me }));
        // An interrupted brief ends its caller: its words stop being kept for nobody.
        return yield* Stream.mkString(me.words).pipe(
          Effect.map((said) => said.trim()),
          Effect.ensuring(Effect.sync(() => me.end())),
        );
      }),
      answerer: (on) => (model) => {
        if (model !== orchestratorModel) return undefined;
        if (on === "api") return (text) => answer(lineWords.owner(text));
        return (text) =>
          Stream.unwrap(
            Effect.sync(() => {
              forkHere(Effect.ignore(chat.spoken(ownerId, text, ""), { log: "Warn", message: "vibevalley: voice: the owner's spoken words were not kept" }));
              return answer(voiceNote + "\n" + lineWords.owner(text));
            }),
          );
      },
      stop: Effect.fn("Orchestrator.stop")(function* (agent) {
        const me = yield* target(agent);
        return yield* me.host.stop;
      }),
      markWrong: Effect.fn("Orchestrator.markWrong")(function* (on, want, agent) {
        const me = yield* target(agent);
        return yield* me.host.markWrong(
          on,
          want,
          modelId(me.id),
          [
            ...toolsFor(me.id)(() => me.host.current().route),
            ...selfTools({ home: me.home, skills: () => Promise.resolve([]), memory: true, now: () => 0 }),
          ].map((item) => item.name),
        );
      }),
    });
  });
