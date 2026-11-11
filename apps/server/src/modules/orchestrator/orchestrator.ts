import { Cause, Clock, Context, Effect, FiberSet, Layer, Scope, Semaphore, Stream } from "effect";

import { selfTools } from "@vibevalley/agent/self";
import { defaultModel, type ModelClient } from "@vibevalley/ai/client";
import { Llm } from "@vibevalley/ai/llm";
import { t } from "@vibevalley/i18n";
import type { OrchestratorEval } from "@vibevalley/protocol";
import { defaultOrchestrator, orchestratorRuntime, userId } from "@vibevalley/protocol";

import { orchestrator } from "#/base/actor.ts";
import { serverFile } from "#/base/assets.ts";
import { head } from "#/base/clip.ts";
import { type ApiError, BizCode, refuseIn } from "#/base/errors.ts";
import { usersLanguage } from "#/base/prompts.ts";
import { agentHome, reposDir, ServerConfig } from "#/infra/config.ts";
import { localeMinute } from "#/infra/time.ts";
import { Agent, modelClient, noDeepSeekKey } from "#/modules/agent/agent.ts";
import { traitsOf } from "#/modules/agent/prompts.ts";
import { Channel } from "#/modules/channel/channel.ts";
import { Cron } from "#/modules/cron/cron.ts";
import { nextRun } from "#/modules/cron/when.ts";
import type { Handed, Picked } from "#/modules/mailbox/envelope.ts";
import { Mailbox } from "#/modules/mailbox/mailbox.ts";
import { Pkm } from "#/modules/pkm/pkm.ts";
import { Repo } from "#/modules/repo/repo.ts";
import { runtimeLabel } from "#/modules/runtime/presets.ts";
import { Runtime } from "#/modules/runtime/runtime.ts";
import { type AgentHost, type NotAnswered } from "#/modules/session/host.ts";
import { type NotRecorded, Session } from "#/modules/session/session.ts";
import { Setting } from "#/modules/setting/setting.ts";
import { answers as toolAnswers, channelLine } from "#/modules/tool/prompts.ts";
import { Tool } from "#/modules/tool/tool.ts";

import type { Answer } from "./openai.ts";
import { agentPrompt, identityNote, lineWords, situationWords, systemPrompt, voiceNote } from "./prompts.ts";
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

export class Orchestrator extends Context.Service<
  Orchestrator,
  {
    /** Aborts the orchestrator's own turn and queued inputs without stopping helper sessions. */
    readonly stop: (agent?: string) => Effect.Effect<void>;
    readonly markWrong: (on: number, want: string, agent?: string) => Effect.Effect<OrchestratorEval, ApiError>;
    readonly answerer: (on: "api" | "phone") => (model: string) => Answer<NotAnswered> | undefined;
    readonly brief: (line: string) => Effect.Effect<string, NotAnswered>;
  }
>()("@vibevalley/server/modules/orchestrator/orchestrator") {
  static readonly layer = (options?: OrchestratorOptions) => Layer.effect(Orchestrator, make(options));
}

export interface OrchestratorOptions {
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
    const responses = makeResponses(mailbox, chat);

    const service = yield* Llm;
    const forkHere = yield* FiberSet.makeRuntime();
    const scope = yield* Effect.scope;

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
            return modelClient(deepseekModel(store.agent(id)?.model.trim() ?? "", defaultModel), settings.deepseekApiKey, service);
          };
          const wakeSoon = (withinMs: number) => {
            const by = clock.currentTimeMillisUnsafe() + withinMs;
            return cron.list().some((s) => {
              const next = nextRun(s);
              return next !== undefined && (s.agent || chat.orchestratorIn(s.channel)) === id && next <= by;
            });
          };
          const profile = store.agent(id);
          const me: Instance = {
            id,
            home,
            cannot: new Map(),
            shown: "",
            host: yield* run
              .host<HostContext>({
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
                // Append custom profile identity after the shared prefix so default orchestrator eval caches stay stable.
                instructions: systemPrompt + agentPrompt + (id === defaultOrchestrator || !profile ? "" : identityNote(profile.name, profile.persona)),
                llm: llmOf,
                tools: toolsFor(id),
                skills: [orchestratorSkills],
                wakeSoon,
                first: { channel: chat.defaultChannel(), envelope: "", source: "user" },
                quiet: () => false,
                say: (r, text, runId) => chat.post({ _tag: "Run", from: id, channel: r.channel, text: text, run: runId }),
                channel: (r) => r.channel,
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

    // Place target channel on the final line so switching channels invalidates only one line in `situationDelta`.
    const situation = (channel: string) =>
      Effect.gen(function* () {
        const sessions = yield* agentLines;
        const roster = run.hired();
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
          usersLanguage(),
        );
      });

    const situationNow = (me: Instance, busy: boolean, channel: string) =>
      Effect.map(situation(channel), (now) => {
        const shownNow = !busy && me.shown !== "" ? situationDelta(me.shown, now) : now;
        me.shown = busy ? "" : now;
        return shownNow;
      });

    const news = (me: Instance): Effect.Effect<[string, string[]], ApiError> =>
      Effect.map(mailbox.orchestratorDigest(me.id), (digest) =>
        digest.length === 0 ? ["", []] : [situationWords.news(orchestratorEnvelopeLines(digest)), digest.map((m) => m.id)],
      );

    const recall = (source: Source, line: string) =>
      source !== "user" || line.trim().length < 4
        ? Effect.succeed("")
        : Effect.map(notes.search({ text: head(line, 200), limit: notesRecalled }), (hits) => situationWords.recalled(hits.map(toolAnswers.pkm.hit)));

    const pickedNote = (picked: Pick) => {
      let note = "";
      const a = picked.agent ? store.agent(picked.agent) : undefined;
      if (a) note += lineWords.pickedAgent(a.name);
      if (picked.repo) note += lineWords.pickedRepo(picked.repo);
      return note;
    };

    const heardInChat = (n: Handed) =>
      Effect.suspend(() => {
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
        return Effect.gen(function* () {
          const me = yield* target(n.agent);
          return yield* me.host
            .submit(
              (busy, memoryNews) =>
                Effect.gen(function* () {
                  const [heard, ids] = yield* news(me);
                  const now = yield* Clock.currentTimeMillis;
                  const text = [
                    situationWords.now(localeMinute(now)),
                    yield* situationNow(me, busy, n.channel),
                    memoryNews,
                    yield* recall(source, line),
                    heard,
                    asked,
                  ]
                    .filter((p) => p !== "")
                    .join("\n\n");
                  return { text, heard: [...new Set([...ids, ...envelopes])] };
                }),
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
            )
            .pipe(
              Effect.tap(() => Effect.sync(() => me.cannot.clear())),
              Effect.as(true),
              Effect.catchTag("SubmitRefused", (refused) =>
                Effect.gen(function* () {
                  const words = refused.why === noDeepSeekKey() ? t("server.orchestrator.noKey") : t("server.orchestrator.cannotStart", { why: refused.why });
                  const again = me.cannot.get(n.channel) === words;
                  me.cannot.set(n.channel, words);
                  if (!again) yield* chat.post({ _tag: "Run", from: me.id, channel: n.channel, text: words, run: refused.run });
                  return false;
                }),
              ),
            );
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.as(
              Effect.sync(() => caller?.fail(Cause.squash(cause))).pipe(
                Effect.andThen(Effect.logError(`vibevalley: the orchestrator could not take ${source}: ${Cause.pretty(cause)}`)),
              ),
              false,
            ),
          ),
          Effect.tap((taken) => (taken ? Effect.void : Effect.forEach(n.messages, (message) => mailbox.handBack(n.agent, message.id), { discard: true }))),
        );
      });

    const logged = <E>(what: string, effect: Effect.Effect<unknown, E>) =>
      effect.pipe(
        Effect.catchCause((cause) => Effect.logError(`vibevalley: the orchestrator could not take ${what}: ${Cause.pretty(cause)}`)),
        Effect.asVoid,
      );

    if (options.listen ?? true) {
      const news = yield* mailbox.news;
      yield* Effect.forkScoped(Stream.runForEach(news, (n) => (n._tag === "Handed" ? logged("a line", heardInChat(n)) : Effect.void)));
      yield* Effect.forEach(
        store.orchestrators(),
        (a) =>
          Effect.gen(function* () {
            const me = yield* instanceOf(a.id);
            if ((options.llm !== undefined || settings.deepseekApiKey() !== undefined) && (yield* me.host.unfinished)) forkHere(me.host.resume(resumeWithinMs));
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
            ...selfTools({ home: me.home, skills: () => Effect.succeed([]), memory: true, now: () => 0 }),
          ].map((item) => item.name),
        );
      }),
      answerer: (on) => responses.answerer(on),
      brief: Effect.fn("Orchestrator.brief")((line: string) => responses.brief(line)),
    });
  });
