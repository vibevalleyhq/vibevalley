import { Cause, Clock, Context, Effect, FiberSet, Layer, Scope, Semaphore, Stream } from "effect";

import { selfTools } from "@vibevalley/agent/self";
import { defaultModel, type ModelClient } from "@vibevalley/ai/client";
import { Llm } from "@vibevalley/ai/llm";
import { t } from "@vibevalley/i18n";
import type { OrchestratorEval, RunTrigger } from "@vibevalley/protocol";
import { defaultOrchestrator, orchestratorRuntime, ownerId } from "@vibevalley/protocol";

import { Agent, modelClient, noDeepSeekKey } from "#/agent/agent.ts";
import { traitsOf } from "#/agent/prompts.ts";
import { orchestrator } from "#/base/actor.ts";
import { head } from "#/base/clip.ts";
import { type ApiError, refused } from "#/base/errors.ts";
import { ownersLanguage } from "#/base/prompts.ts";
import { Channel } from "#/channel/channel.ts";
import { Cron } from "#/cron/cron.ts";
import { nextRun } from "#/cron/when.ts";
import { agentHome, reposDir, ServerConfig } from "#/infra/config.ts";
import { localeMinute } from "#/infra/time.ts";
import { Ingress } from "#/ingress/ingress.ts";
import type { Handed, Picked } from "#/mailbox/envelope.ts";
import { Mailbox } from "#/mailbox/mailbox.ts";
import { Pkm } from "#/pkm/pkm.ts";
import { Repo } from "#/repo/repo.ts";
import { runtimeLabel } from "#/runtime/presets.ts";
import { Runtime } from "#/runtime/runtime.ts";
import { type AgentHost, type Caller, type NotAnswered } from "#/session/host.ts";
import { type NotRecorded, Session } from "#/session/session.ts";
import { Setting } from "#/setting/setting.ts";
import { answers as toolAnswers, channelLine } from "#/tool/prompts.ts";
import { Tool } from "#/tool/tool.ts";

import type { Answer } from "./openai.ts";
import { agentPrompt, identityNote, lineWords, situationWords, systemPrompt, voiceNote } from "./prompts.ts";
import { makeResponses } from "./response.ts";
import { deepseekModel, intake, orchestratorInboxLines, quotaText, situationDelta, type Source } from "./situation.ts";

const keepEvents = 1000;
const notesShown = 8;
const notesRecalled = 3;
/** A run cut off longer ago than this is left: what it was for has likely moved on. */
const resumeWithinMs = 30 * 60_000;

/** What the owner chose beside the words (the sowing form, the chat's profile pick); empty for none. */
export type Pick = Picked;

/** Where an input's answer goes and what it is worth; kept with it in the transcript. */
interface Route {
  readonly channel: string;
  readonly envelope: string;
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
  readonly envelopes: readonly string[];
  /** The orchestrator it is for, by its profile id; the default one when none is named. */
  readonly to?: string;
  readonly source: Source;
  readonly line: string;
  readonly channel: string;
  readonly agent?: string;
  readonly owner?: boolean;
  readonly issue?: string;
  readonly envelope?: string;
  /** What started its run, when the producer knows better than its source (an issue's trigger, a missed cron). */
  readonly by?: RunTrigger;
  readonly caller?: Caller;
}

export class Orchestrator extends Context.Service<
  Orchestrator,
  {
    /** The lines waiting for an orchestrator (the default one when none is named) are dropped with its run; the sessions
     * it sent keep working. */
    readonly stop: (agent?: string) => Effect.Effect<void>;
    readonly markWrong: (on: number, want: string, agent?: string) => Effect.Effect<OrchestratorEval, ApiError>;
    readonly answerer: (on: "api" | "phone") => (model: string) => Answer<NotAnswered> | undefined;
    readonly brief: (line: string) => Effect.Effect<string, NotAnswered>;
  }
>()("@vibevalley/server/orchestrator/orchestrator") {
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
    const store = yield* Agent;
    const settings = yield* Setting;
    const runtimes = yield* Runtime;
    const repos = yield* Repo;
    const notes = yield* Pkm;
    const run = yield* Session;
    const chat = yield* Channel;
    const mailbox = yield* Mailbox;
    const cron = yield* Cron;
    const tool = yield* Tool;
    const ingress = yield* Ingress;
    const responses = makeResponses(ingress, chat);

    // Fibers started from callbacks belong to this service: they end with it and keep its services (the logger).
    const service = yield* Llm;
    const forkHere = yield* FiberSet.makeRuntime();
    const scope = yield* Effect.scope;

    const toolsFor = (id: string) => (current: () => Route) =>
      tool.orchestrator(() => {
        const at = current();
        return { agent: id, session: "", repo: "", here: at.channel, picked: at.agent ?? "", envelope: at.envelope, actor: orchestrator(at.owner ?? false) };
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

    const instanceOf = (id: string): Effect.Effect<Instance, NotRecorded> =>
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
                session: {
                  id,
                  role: "orchestrator",
                  agent: id,
                  name: profile?.name || t("server.orchestrator.label"),
                  runtime: orchestratorRuntime,
                  brief: profile?.duty ?? "",
                },
                inputType: "orchestratorInput",
                home,
                cwd: reposDir(config),
                // The default orchestrator's prefix is the one its evals hold; another says who it is after it.
                instructions: systemPrompt + agentPrompt + (id === defaultOrchestrator || !profile ? "" : identityNote(profile.name, profile.persona)),
                llm: llmOf,
                tools: toolsFor(id),
                wakeSoon,
                first: { channel: chat.defaultChannel(), envelope: "", source: "owner" },
                quiet: (r) => r.quiet ?? false,
                say: (r, text, runId) => chat.orchestratorSays(r.channel, text, runId, id),
                // The chat shows where it thinks or writes; what it answers off the chat (the local chat/completions) shows nowhere.
                channel: (r) => (r.quiet === true ? undefined : r.channel),
                fresh: () => {
                  me.shown = "";
                },
                restored: (r) => ({ ...(r.issue ? { issue: r.issue } : {}), by: { kind: intake[r.source].trigger, channel: r.channel } }),
                keepEvents,
                toolStart: tool.start,
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
      yield* Effect.forEach(
        store.agents(),
        (a) =>
          Effect.gen(function* () {
            const assessed = yield* runtimes.assess(a);
            const p = assessed.agent;
            let line = situationWords.agent(p.name, p.id, runtimeLabel(p.runtime), traitsOf(p));
            if (p.enabled && assessed.blocking.length === 0) line += situationWords.quota(quotaText(assessed.info));
            else if (assessed.blocking[0]) line += situationWords.blocked(assessed.blocking[0].text);
            else line += situationWords.disabled;
            lines.push(line);
          }),
        { discard: true },
      );
      return lines;
    });

    // channel is where the input it goes with will be answered. Said last and on a line of its own, so that
    // answering in another channel changes one line of it.
    const situation = (channel: string) =>
      Effect.gen(function* () {
        const sessions = yield* agentLines;
        const roster = run.presentSessions();
        const here = yield* chat.addressOf(channel);
        const byChannel = (yield* chat.channels()).map((c) => {
          const theirs = roster.filter((session) => (session.channel ?? chat.defaultChannel()) === c.id).map((session) => tool.sessionLine(session));
          const head = channelLine(c);
          return head + "\n" + (theirs.length > 0 ? theirs.join("\n") : situationWords.noHelpers);
        });
        const all = yield* repos.list();
        const folders = all.length > 0 ? situationWords.repos(all.map((p) => p.name)) : situationWords.noRepos;
        const working = (yield* notes.list()).pages.filter((p) => p.tier === "project").slice(0, notesShown);
        return situationWords.whole(
          repos.root,
          folders,
          situationWords.notes(working.map((p) => situationWords.noteRepo(p.title, p.tldr, p.open))),
          sessions.join("\n"),
          byChannel.join("\n"),
          here.direct ? situationWords.direct(here.target) : here.target,
          ownersLanguage(),
        );
      });

    // The situation for the next input: the whole of it, or what changed since the input before.
    const situationNow = (me: Instance, busy: boolean, channel: string) =>
      Effect.map(situation(channel), (now) => {
        const shownNow = !busy && me.shown !== "" ? situationDelta(me.shown, now) : now;
        me.shown = busy ? "" : now;
        return shownNow;
      });

    const news = (me: Instance): Effect.Effect<[string, string[]], ApiError> =>
      Effect.map(mailbox.orchestratorDigest(me.id), (digest) =>
        digest.length === 0 ? ["", []] : [situationWords.news(orchestratorInboxLines(digest)), digest.map((m) => m.id)],
      );

    const recall = (i: Intake) =>
      i.source !== "owner" || i.line.trim().length < 4
        ? Effect.succeed("")
        : Effect.map(notes.search({ text: head(i.line, 200), limit: notesRecalled }), (hits) => situationWords.recalled(hits.map(toolAnswers.pkm.hit)));

    const taking = (i: Intake) =>
      Effect.gen(function* () {
        const me = yield* target(i.to);
        const rule = intake[i.source];
        const asked = rule.head + i.line;
        const route: Route = {
          channel: i.channel,
          envelope: i.envelope ?? "",
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
              const now = yield* Clock.currentTimeMillis;
              const text = [situationWords.now(localeMinute(now)), yield* situationNow(me, busy, i.channel), memoryNews, yield* recall(i), heard, asked]
                .filter((p) => p !== "")
                .join("\n\n");
              return { text, heard: [...new Set([...ids, ...i.envelopes])] };
            }),
          {
            route,
            run: { ...(i.issue ? { issue: i.issue } : {}), by: { ...(i.by ?? { kind: rule.trigger }), channel: i.channel }, asked },
            ...(i.caller ? { caller: i.caller } : {}),
          },
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

    /** Every input comes in here. false: the orchestrator could not start, and the channel was told why, once. */
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
      if (picked.repo) note += lineWords.pickedRepo(picked.repo);
      return note;
    };

    const heardInChat = (n: Handed) =>
      Effect.suspend(() => {
        const fromPerson = n.messages.every((m) => m.from === ownerId);
        const owner = n.messages.some((m) => m.from === ownerId);
        // The latest pick among them: it goes with its message.
        const picked: Pick = n.messages.findLast((m) => m.picked)?.picked ?? {};
        const response = n.messages.findLast((message) => message.responsePort);
        const voice = n.messages.findLast((message) => message.voiceMode);
        const caller = response?.responsePort ? responses.take(response.responsePort) : undefined;
        const line = n.source
          ? n.messages.map((message) => message.text.replace(new RegExp(`^@${n.agent}\\s*`, "u"), "")).join("\n")
          : voice?.voiceMode === "dictated"
            ? pickedNote(picked) + lineWords.dictated + lineWords.owner(n.messages.map((message) => message.text).join("\n"))
            : voice?.voiceMode === "conversation"
              ? voiceNote + "\n" + lineWords.owner(n.messages.map((message) => message.text).join("\n"))
              : n.messages.every((message) => message.number === 0)
                ? pickedNote(picked) + lineWords.events(orchestratorInboxLines(n.messages))
                : fromPerson && (n.type === "direct" || n.channel === chat.defaultChannel())
                  ? pickedNote(picked) + lineWords.owner(n.messages.map((m) => m.text).join("\n"))
                  : pickedNote(picked) + lineWords.chat(n.target, orchestratorInboxLines(n.messages));
        return take({
          envelopes: n.messages.map((message) => message.id),
          to: n.agent,
          source: n.source ?? (fromPerson ? "owner" : "chat"),
          line,
          channel: n.channel,
          ...(picked.agent ? { agent: picked.agent } : {}),
          envelope:
            n.messages.findLast((message) => message.from === ownerId)?.originTrigger ??
            n.messages.findLast((message) => message.from === ownerId)?.id ??
            n.messages.at(-1)?.originTrigger ??
            n.messages.at(-1)?.id ??
            "",
          owner,
          ...(n.issue ? { issue: n.issue } : {}),
          ...(n.by ? { by: n.by } : {}),
          ...(caller ? { caller } : {}),
        }).pipe(
          Effect.tap((taken) => (taken ? Effect.void : Effect.forEach(n.messages, (message) => mailbox.handBack(n.agent, message.id), { discard: true }))),
        );
      });

    const logged = <E>(what: string, effect: Effect.Effect<unknown, E>) =>
      effect.pipe(
        Effect.catchCause((cause) => Effect.logError(`vibevalley: the orchestrator could not take ${what}: ${Cause.pretty(cause)}`)),
        Effect.asVoid,
      );

    // A test that gave the orchestrator no model hears nothing: the other services run as without it, and nothing reaches a model.
    if (options.listen ?? true) {
      const news = yield* mailbox.news;
      yield* Effect.forkScoped(Stream.runForEach(news, (n) => (n._tag === "Handed" ? logged("a line", heardInChat(n)) : Effect.void)));
      // Each orchestrator goes on with the run a stop cut off.
      yield* Effect.forEach(
        store.orchestrators(),
        (a) =>
          Effect.gen(function* () {
            const me = yield* instanceOf(a.id);
            if ((options.llm || settings.deepseekApiKey()) && (yield* me.host.unfinished)) forkHere(me.host.resume(resumeWithinMs));
          }),
        { discard: true },
      );
    }

    yield* Effect.addFinalizer(() =>
      Effect.forEach([...instances.values()], (me) => me.host.close, { concurrency: "unbounded", discard: true }).pipe(
        Effect.andThen(Effect.sync(() => responses.closeAll())),
      ),
    );

    const modelId = (id: string) => {
      try {
        return options.llm ? options.llm().model.id : deepseekModel(store.agent(id)?.model.trim() ?? "", defaultModel);
      } catch {
        return store.agent(id)?.model ?? "";
      }
    };

    return Orchestrator.of({
      stop: Effect.fn("Orchestrator.stop")(function* (agent) {
        const id = agent && store.isOrchestrator(agent) ? agent : defaultOrchestrator;
        const me = instances.get(id);
        if (me) yield* me.host.stop;
      }),
      markWrong: Effect.fn("Orchestrator.markWrong")(function* (on, want, agent) {
        const me = yield* target(agent).pipe(Effect.mapError((error) => refused(error.message)));
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
      answerer: (on) => responses.answerer(on),
      brief: Effect.fn("Orchestrator.brief")((line: string) => responses.brief(line)),
    });
  });
