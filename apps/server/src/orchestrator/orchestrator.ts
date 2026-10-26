// The orchestrator (管家): the owner's agent that takes the work in, hands it to helpers, follows it and tells the owner.
// Every input comes in through take, with its source; the intake table (rules.ts) says, per source, its first words,
// whether it joins the run under way and what its run is triggered by. Each input carries the time, the farm (whole, or
// what changed since the model last saw it), what memory gained, the channels' news and the line, and a route: where its
// answer goes. Running the agent (starting it, queuing inputs, streaming words, recording runs, going on after a restart)
// is the host's (session/host.ts).

import { orchestratorWording } from "./words.ts";
import { agentPrompt, lineWords, patrolText, situationWords, systemPrompt, voiceNote } from "./prompts.ts";
import { orchestrator } from "../base/actor.ts";
import type { OrchestratorEval, RunTrigger } from "@vibevalley/protocol";
import { orchestratorAgent, ownerId } from "@vibevalley/protocol";
import { runtimeLabel } from "../agent/seed.ts";
import { nextRun } from "../recurrence/when.ts";
import { isOpen } from "../task/graph.ts";
import { graphText } from "../task/prompts.ts";
import { Clock, Context, Effect, FiberSet, Layer, Stream } from "effect";
import { Agents } from "../agent/agent.ts";
import { traitsOf } from "../agent/prompts.ts";
import { deepseek, defaultModel, type LLM, noDeepSeekKey } from "../agent/brain/config.ts";
import { localeMinute } from "../base/time.ts";
import { selfTools } from "../agent/brain/self.ts";
import { projectsDir, Settings } from "../base/config.ts";
import { Channels, type OrchestratorNews } from "../channel/chat.ts";
import { Core } from "../core/core.ts";
import type { ApiError } from "../errors.ts";
import { Issues, type OrchestratorWork } from "../issue/issue.ts";
import { orchestratorHome } from "../memory/memory.ts";
import { Notices, type Overdue } from "../notice/notice.ts";
import { Projects } from "../project/project.ts";
import { Runtimes } from "../runtime/runtime.ts";
import { Recurrences } from "../recurrence/recurrence.ts";
import type { Answer } from "../agent/brain/openai.ts";
import { Caller } from "../session/host.ts";
import { Sessions } from "../session/session.ts";
import { Setting } from "../setting/setting.ts";
import { Tasks } from "../task/task.ts";
import { Tools } from "../tool/tool.ts";
import { channelLine } from "../tool/prompts.ts";
import { deepseekModel, intake, orchestratorInboxLines, orchestratorModel, quotaText, situationDelta, type Source } from "./rules.ts";
import { callbackLog } from "../base/log.ts";

const keepEvents = 1000;
/** A run cut off longer ago than this is left: what it was for has likely moved on. */
const resumeWithinMs = 30 * 60_000;

/** What the owner chose beside the words (the sowing form, the chat's profile pick); empty for none. */
export interface Pick {
  readonly agent?: string;
  readonly project?: string;
}

/** Where an input's answer goes and what it is worth; kept with it in the transcript. */
interface Route {
  readonly conversation: string;
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
  readonly source: Source;
  readonly line: string;
  readonly conversation: string;
  readonly agent?: string;
  readonly owner?: boolean;
  readonly issue?: string;
  /** What started its run, when the producer knows better than its source (an issue's trigger, a missed recurrence). */
  readonly by?: RunTrigger;
  readonly caller?: Caller;
}

export interface OrchestratorShape {
  /** The owner's words in a conversation, from any door (the page, a chat app); the owner speaking opens the farm. sendKey:
   * the client's key for this send, a retry with the same key is the message already said. */
  readonly say: (text: string, pick: Pick, conversation: string | undefined, sendKey: string) => Effect.Effect<void, ApiError>;
  /** A voice transcript the owner chose for the orchestrator to overhear. */
  readonly heard: (text: string, agent: string, sendKey: string) => Effect.Effect<void, ApiError>;
  /** Something to tell the owner on the phone: given as from an issue, after what the orchestrator is on, it answers in 田头
   * as always; the whole answer comes back to be read out. Aborting ends only this wait, not the shared run. */
  readonly brief: (line: string, signal?: AbortSignal) => Promise<string>;
  /** The orchestrator as orchestratorModel on a chat/completions endpoint: what is asked there is the owner's, as in 田头.
   * On the phone (the voice line) the words are said in 田头 too, and the answer is one to be read out. */
  readonly answerer: (on: "phone" | "api") => (model: string) => Answer | undefined;
  /** The lines waiting for the orchestrator are dropped with the run; the sessions it sent keep working. */
  readonly stop: () => Effect.Effect<void>;
  readonly markWrong: (on: number, want: string) => Effect.Effect<OrchestratorEval, ApiError>;
}

export class Orchestrator extends Context.Service<Orchestrator, OrchestratorShape>()("vibevalley/Orchestrator") {}

export interface OrchestratorOptions {
  /** The model; absent, DeepSeek with the key in settings. */
  readonly llm?: () => LLM;
  /** Whether it hears the farm; a test without a model does not, so nothing reaches a model. */
  readonly listen?: boolean;
}

export const make = (options: OrchestratorOptions = {}) =>
  Effect.gen(function* () {
    const clock = yield* Clock.Clock;
    const logs = yield* callbackLog;
    const config = yield* Settings;
    const core = yield* Core;
    const store = yield* Agents;
    const settings = yield* Setting;
    const runtimes = yield* Runtimes;
    const projects = yield* Projects;
    const run = yield* Sessions;
    const issue = yield* Issues;
    const chat = yield* Channels;
    const tasks = yield* Tasks;
    const recurrence = yield* Recurrences;
    const tool = yield* Tools;
    const notices = yield* Notices;

    // Fibers started from callbacks belong to this service: they end with it and keep its services (the logger).
    const go = yield* FiberSet.makeRuntimePromise<never>();
    const forkHere = yield* FiberSet.makeRuntime<never>();
    const notice = (level: "info" | "warn" | "error", text: string) => void forkHere(core.notice(level, text));
    const general = chat.general();
    const home = orchestratorHome(config.home);

    const selected = new Map<string, Pick>();
    let latestCall: Caller | undefined;
    /** What the orchestrator last said it cannot start for, per conversation: said once, not to every line, until it starts. */
    const cannot = new Map<string, string>();
    /** The farm's situation as the model last saw it in an input; "" when it should see the whole of it next. */
    let shown = "";

    const llmOf = (): LLM => {
      if (options.llm) return options.llm();
      // The key saved in settings, asked before each request: one saved while the orchestrator runs is used at once.
      return deepseek(deepseekModel(store.agent(orchestratorAgent)?.model.trim() ?? "", defaultModel), () => settings.deepseekApiKey() || undefined);
    };

    const toolsFor = (current: () => Route) =>
      tool.orchestrator(() => {
        const at = current();
        return { agent: orchestratorAgent, session: "", project: "", here: at.conversation, picked: at.agent ?? "", actor: orchestrator(at.owner ?? false) };
      });

    // One of its own recurrences (not a helper's) comes due within that long: it will be woken then.
    const wakeSoon = (withinMs: number) => {
      const by = clock.currentTimeMillisUnsafe() + withinMs;
      return recurrence.list().some((s) => {
        const next = nextRun(s);
        return next !== undefined && (!s.agent || s.agent === orchestratorAgent) && next <= by;
      });
    };

    const host = run.host<Route>({
      name: orchestratorAgent,
      label: orchestratorWording().label,
      inputType: "orchestratorInput",
      home,
      cwd: projectsDir(config),
      instructions: systemPrompt + agentPrompt,
      llm: llmOf,
      tools: toolsFor,
      wakeSoon,
      first: { conversation: general, source: "owner" },
      quiet: (r) => r.quiet ?? false,
      say: (r, key, text, final, runId) => go(chat.orchestratorSays(r.conversation, key, text, final, runId)),
      state: (s) => go(core.setOrchestrator(s)),
      fresh: () => {
        shown = "";
      },
      restored: (r) => ({ ...(r.issue ? { issue: r.issue } : {}), by: { kind: intake[r.source].trigger } }),
      keepEvents,
      toolStart: tool.start,
      notice,
      log: (level, text) => (level === "error" ? logs.error(text) : logs.info(text)),
      go,
    });

    const agentLines = async () => {
      const lines: string[] = [];
      for (const a of store.agents()) {
        const assessed = await go(runtimes.assess(a));
        const p = assessed.agent;
        let line = situationWords.agent(p.name, p.id, runtimeLabel(p.runtime), traitsOf(p));
        if (p.enabled && assessed.blocking.length === 0) line += "；" + quotaText(assessed.info);
        else if (assessed.blocking.length > 0) line += situationWords.blocked(assessed.blocking[0]!.text);
        else line += situationWords.disabled;
        lines.push(line);
      }
      return lines;
    };

    // conversation is where the input it goes with will be answered. Said last and on a line of its own, so that
    // answering in another channel changes one line of it.
    const situation = async (conversation: string) => {
      const sessions = await agentLines();
      const roster = run.roster();
      const here = await go(chat.channelOf(conversation));
      const byChannel = (await go(chat.channels())).map((c) => {
        const theirs = roster.filter((w) => (w.session.channel ?? general) === c.id).map((w) => tool.sessionLine(w));
        const head = channelLine(c);
        return head + "\n" + (theirs.length > 0 ? theirs.join("\n") : situationWords.noHelpers);
      });
      const all = await go(projects.list());
      const folders = all.length > 0 ? situationWords.projects(all.map((p) => p.name)) : situationWords.noProjects;
      const open = tasks.graphs().filter(isOpen).map(graphText);
      const graphs = open.length > 0 ? situationWords.graphs(open) : "";
      return situationWords.whole(projects.root, folders, sessions.join("\n"), byChannel.join("\n"), graphs, here.name);
    };

    // The situation for the next input: the whole of it, or what changed since the input before. An input given while
    // the agent is busy may be taken after one given later, so it carries the whole, and the one after it does too.
    const situationNow = async (busy: boolean, conversation: string) => {
      const now = await situation(conversation);
      const shownNow = !busy && shown !== "" ? situationDelta(shown, now) : now;
      shown = busy ? "" : now;
      return shownNow;
    };

    const news = async (): Promise<[string, string[]]> => {
      const digest = await go(chat.orchestratorDigest());
      if (digest.length === 0) return ["", []];
      return [situationWords.news(orchestratorInboxLines(digest)), digest.map((m) => m.id)];
    };

    /** Every input comes in here. false: the orchestrator could not start, and the conversation was told why, once. It
     * never rejects: an input that could not be taken is logged, and a caller waiting on it is failed instead of left open. */
    const take = (i: Intake): Promise<boolean> =>
      taking(i).catch((err: unknown) => {
        i.caller?.fail(err);
        logs.error(`vibevalley: the orchestrator could not take ${i.source}:`, err);
        return false;
      });

    const taking = async (i: Intake): Promise<boolean> => {
      const rule = intake[i.source];
      const asked = rule.head + i.line;
      const route: Route = {
        conversation: i.conversation,
        ...(i.agent ? { agent: i.agent } : {}),
        source: i.source,
        ...(i.issue ? { issue: i.issue } : {}),
        ...(i.owner ? { owner: true } : {}),
      };
      const taken = await host.submit(
        async (busy, memoryNews) => {
          const [heard, ids] = await news();
          // The log shows the line; the model also gets the time, the farm and the news before it.
          const text = [
            situationWords.now(localeMinute(new Date(clock.currentTimeMillisUnsafe()))),
            await situationNow(busy, i.conversation),
            memoryNews,
            heard,
            asked,
          ]
            .filter((p) => p !== "")
            .join("\n\n");
          return { text, heard: ids };
        },
        { route, run: { ...(i.issue ? { issue: i.issue } : {}), by: i.by ?? { kind: rule.trigger }, asked }, ...(i.caller ? { caller: i.caller } : {}) },
        rule.now,
      );
      if (taken.ok) {
        cannot.clear();
        return true;
      }
      const words = taken.why === noDeepSeekKey() ? orchestratorWording().noKey : orchestratorWording().cannotStart(taken.why);
      const again = cannot.get(i.conversation) === words;
      cannot.set(i.conversation, words);
      if (!again) await go(chat.orchestratorSays(i.conversation, `failed${clock.currentTimeMillisUnsafe()}`, words, true, taken.run));
      return false;
    };

    const pickedNote = (picked: Pick) => {
      let note = "";
      const a = picked.agent ? store.agent(picked.agent) : undefined;
      if (a) note += lineWords.pickedAgent(a.name);
      if (picked.project) note += lineWords.pickedProject(picked.project);
      return note;
    };

    const heardInChat = async (n: OrchestratorNews) => {
      const fromPerson = n.messages.every((m) => m.from === ownerId);
      const owner = n.messages.some((m) => m.from === ownerId);
      let picked: Pick = {};
      for (const m of n.messages) {
        const p = selected.get(m.id);
        if (p) {
          picked = p;
          selected.delete(m.id);
        }
      }
      const line =
        fromPerson && n.conversation === general
          ? pickedNote(picked) + lineWords.owner(n.messages.map((m) => m.text).join("\n"))
          : pickedNote(picked) + lineWords.chat(n.target, orchestratorInboxLines(n.messages));
      await take({ source: fromPerson ? "owner" : "chat", line, conversation: n.conversation, ...(picked.agent ? { agent: picked.agent } : {}), owner });
    };

    // A run of an issue for the orchestrator lasts until the orchestrator's run that takes the line settles.
    const onWork = async (w: OrchestratorWork) => {
      const channel = await go(chat.channelOf(w.channel));
      const again = w.said ? lineWords.again(w.said) : "";
      let line = lineWords.issue(w.issue.title, w.issue.description ?? "", again, channel.name);
      const s = w.recurrence;
      if (s) {
        const missed = (w.by as RunTrigger & { missed?: boolean }).missed ? lineWords.missed : "";
        line = lineWords.recurrence(s.name, missed, s.text, channel.name, s.id);
      }
      await take({ source: s ? "recurrence" : "issue", line, conversation: channel.id, issue: w.issue.id, by: w.by });
    };

    // One answer streams at a time, the call's or chat/completions': a newer line ends the one before.
    const answer = (line: string, signal?: AbortSignal): AsyncIterable<string> => {
      const me = new Caller();
      // A caller that already left (the request was cancelled before this ran) is not answered: no run starts for it.
      if (signal?.aborted) {
        me.end();
        return me.words(signal);
      }
      latestCall?.end();
      latestCall = me;
      signal?.addEventListener(
        "abort",
        () => {
          me.end();
          if (latestCall === me) latestCall = undefined;
        },
        { once: true },
      );
      void take({ source: "owner", line, conversation: general, owner: true, caller: me });
      return me.words(signal);
    };

    const handled =
      <A>(what: string, f: (a: A) => Promise<unknown>) =>
      (a: A) =>
        Effect.promise(() => f(a).catch((err) => logs.error(`vibevalley: the orchestrator could not take ${what}:`, err)));

    // A test that gave the orchestrator no model hears nothing: the other services run as without it, and nothing reaches a model.
    if (options.listen ?? true) {
      yield* Effect.forkScoped(Stream.runForEach(yield* chat.forOrchestrator, handled("a line", heardInChat)));
      yield* Effect.forkScoped(Stream.runForEach(yield* issue.forOrchestrator, handled("an issue", onWork)));
      yield* Effect.forkScoped(
        Stream.runForEach(yield* notices.overdue, (o: Overdue) =>
          Effect.flatMap(chat.channelOf(o.channel), (c) =>
            handled("the patrol", (line: string) => take({ source: "patrol", line, conversation: o.channel }))(patrolText(c.name, o.notes)),
          ),
        ),
      );
      yield* Effect.forkScoped(
        Stream.runForEach(
          yield* tasks.news,
          handled("a task graph's line", (line: string) => take({ source: "graph", line, conversation: general })),
        ),
      );
      if (host.unfinished() && (options.llm || settings.deepseekApiKey())) void host.resume(resumeWithinMs);
    }

    yield* Effect.addFinalizer(() => Effect.promise(() => host.close()));

    const modelId = () => {
      try {
        return llmOf().model.id;
      } catch {
        return store.agent(orchestratorAgent)?.model ?? "";
      }
    };

    return Orchestrator.of({
      say: Effect.fn("Orchestrator.say")(function* (text, pick, conversation, sendKey) {
        const a = pick.agent ? store.agent(pick.agent) : undefined;
        const picked: Pick = { ...(a ? { agent: a.id } : {}), ...((pick.project ?? "").trim() ? { project: pick.project!.trim() } : {}) };
        yield* core.open();
        const { message, again } = yield* chat.say(text, conversation, sendKey);
        if (!again && (picked.agent || picked.project)) selected.set(message.id, picked);
      }),
      heard: Effect.fn("Orchestrator.heard")(function* (text, agent, sendKey) {
        yield* core.open();
        if (yield* chat.spoken(ownerId, text, sendKey)) return;
        const picked = agent ? store.agent(agent)?.id : undefined;
        void take({
          source: "owner",
          line: pickedNote(picked ? { agent: picked } : {}) + lineWords.dictated + lineWords.owner(text),
          conversation: general,
          ...(picked ? { agent: picked } : {}),
          owner: true,
        });
      }),
      brief: async (line, signal) => {
        if (signal?.aborted) return "";
        const me = new Caller();
        const stop = () => me.end();
        signal?.addEventListener("abort", stop, { once: true });
        try {
          if (!signal?.aborted) void take({ source: "issue", line, conversation: general, caller: me });
          let said = "";
          for await (const w of me.words(signal)) said += w;
          return said.trim();
        } finally {
          signal?.removeEventListener("abort", stop);
          me.end();
        }
      },
      answerer: (on) => (model) => {
        if (model !== orchestratorModel) return undefined;
        if (on === "api") return (text, signal) => answer(lineWords.owner(text), signal);
        return (text, signal) => {
          void go(Effect.ignore(chat.spoken(ownerId, text, "")));
          return answer(voiceNote + "\n" + lineWords.owner(text), signal);
        };
      },
      stop: () => Effect.promise(() => host.stop()),
      markWrong: (on, want) =>
        host.markWrong(
          on,
          want,
          modelId(),
          [...toolsFor(() => host.current().route), ...selfTools({ home, skills: () => [], memory: true, now: () => 0 })].map((t) => t.name),
        ),
    });
  });

export const layer = (options?: OrchestratorOptions) => Layer.effect(Orchestrator, make(options));
