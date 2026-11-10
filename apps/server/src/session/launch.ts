import type { SessionOptions } from "@botiverse/oar";
import { Clock, Effect, Exit, FiberMap, Predicate, Schema } from "effect";

import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { maxRunning } from "@vibevalley/protocol";
import { ApiError as ApiErrorSchema } from "@vibevalley/protocol/api";
import { isBusy } from "@vibevalley/protocol/rules";

import { Agent } from "#/agent/agent.ts";
import { type ApiError, missing, lookIn, reasonOf, refused } from "#/base/errors.ts";
import { newId } from "#/base/ids.ts";
import { Core } from "#/core/core.ts";
import { type Started } from "#/executor/executor.ts";
import { Machine } from "#/machine/machine.ts";
import { Memory } from "#/memory/memory.ts";
import { Repo } from "#/repo/repo.ts";
import { type Merged, MergeFailure, type RepoError, type Workplace } from "#/repo/workplace.ts";

import { briefBreak, instructions, noRoom, notTakenIn, recallBlock, type SessionLimits, type Settle, toOarMcp, withRecall } from "./briefing.ts";
import { workerInstructions, channelRules, restartedContextNote, restartedNote, workplaceRules } from "./prompts.ts";
import type { Hand, SessionRegistry } from "./registry.ts";
import { isHired } from "./roster.ts";
import type { Delivered, DeliveryInput } from "./signals.ts";
import type { SessionWatch } from "./watch.ts";
import { WorkerAccess } from "./worker.ts";

/** Work that did not go in (see handOver); the session stays. */
export class NotTakenIn extends Schema.TaggedError<NotTakenIn, { readonly brand: unique symbol }>()("NotTakenIn", {
  failure: MergeFailure,
  /** What the helper is sent back with; "" when the owner settles it. */
  fix: Schema.String,
  /** What the owner is told; also the message. */
  owner: Schema.String,
  notice: Schema.String,
  short: Schema.String,
  message: Schema.String,
}) {}

/** A failure's words, whatever it is. */
export const reasonText = (e: unknown): string => (e instanceof Error ? e.message : Schema.is(ApiErrorSchema)(e) ? reasonOf(e) : String(e));
/** A turn submitted and not opened yet, counted from since: its slot is taken, as one thinking. */
const reserved = (since: number): T.Session["phase"] => ({ _tag: "working", since, doing: { action: "thinking", label: "" } });

export const sessionLaunch = (r: SessionRegistry, wt: SessionWatch) =>
  Effect.gen(function* () {
    const core = yield* Core;
    const store = yield* Agent;
    const memories = yield* Memory;
    const repos = yield* Repo;
    const machines = yield* Machine;
    const executor = machines.executions(machines.here());
    const cli = yield* (yield* WorkerAccess).pipe(Effect.orElseSucceed(() => undefined));
    const clock = yield* Clock.Clock;
    const {
      flushRuns,
      timers,
      mcpEndpoint,
      trajectories,
      admission,
      hands,
      issueToken,
      revokeToken,
      save,
      ended,
      expect,
      unexpect,
      consume,
      release,
      closeExecution,
    } = r;
    const { closedLaunch, attach } = wt;
    const revokeAccess = (hand: Hand) =>
      Effect.sync(() => revokeToken(hand)).pipe(Effect.andThen(cli ? cli.revoke(hand.id).pipe(Effect.ignore({ log: "Warn" })) : Effect.void));
    const open = Effect.fnUntraced(function* (
      agent: T.Agent,
      owner: T.Session,
      hand: Hand,
      place: Workplace,
      input: string,
      resume: string,
    ): Effect.fn.Return<Started> {
      if (!cli || !(yield* cli.executableAvailable)) return { refused: t("server.session.life.workerUnavailable"), retained: false };
      return yield* Effect.gen(function* () {
        const token = issueToken(hand);
        const access = yield* cli.prepare(hand.id, mcpEndpoint.url, token).pipe(Effect.orElseSucceed(() => undefined));
        if (access?.authenticated !== true) {
          return { refused: t("server.session.life.workerAuthenticationFailed"), retained: false };
        }
        const houseRules = owner.issue ? yield* repos.houseRules() : "";
        const text = [
          workerInstructions(access.command),
          instructions(agent, store.skills()),
          owner.issue
            ? workplaceRules(place, houseRules, owner.id, repos.usesPullRequests(place.repo))
            : channelRules(place.cwd, owner.channel ?? "", owner.id),
        ]
          .filter((s) => s !== "")
          .join("\n\n");
        const mcp = [
          { name: "vibevalley", type: "http" as const, url: mcpEndpoint.url, headers: { authorization: "Bearer " + token } },
          ...agent.mcpServers.map(toOarMcp),
        ];
        const options: Partial<SessionOptions> = {
          mcpServers: mcp,
          ...(text && agent.personaMode === "append" ? { appendSystemPrompt: text } : {}),
          ...(text && agent.personaMode === "replace" ? { systemPrompt: text } : {}),
          ...(agent.disallowedTools.length > 0 ? { disallowedTools: agent.disallowedTools } : {}),
        };
        const opened = yield* executor.start({
          agent,
          owner,
          cwd: place.cwd,
          input: text && agent.personaMode === "prompt" ? text + briefBreak + input : input,
          resume,
          options,
        });
        if (opened.retained === true) yield* core.notice("error", opened.refused);
        return opened;
      }).pipe(Effect.onExit((result) => (Exit.isFailure(result) || !result.value.execution ? revokeAccess(hand) : Effect.void)));
    });

    const leave = Effect.fn("Session.leave")(function* (h: Hand, closed: T.SessionClose, merged: number) {
      yield* FiberMap.remove(timers, `idle:${h.id}`);
      release(h);
      yield* flushRuns;
      yield* trajectories.finish(h.id);
      yield* ended(h.id, closed);
      closedLaunch(h);
      yield* revokeAccess(h);
      hands.delete(h.id);
      const session = core.session(h.id);
      if (session) yield* memories.endSession({ agent: session.agent, session: h.id, repo: h.place.repo });
      yield* core.apply({ type: "sessionLeft", id: h.id, closed, ...(merged > 0 ? { merged } : {}) });
      save();
    });

    /** Lets the oar session go, keeping its id to resume. */
    const rest = Effect.fn("Session.rest")(function* (h: Hand) {
      yield* closeExecution(h);
      release(h);
      closedLaunch(h);
      save();
    });

    const accessWorkplace = Effect.fn("Session.accessWorkplace")(function* <A, E>(id: string, use: (place: Workplace) => Effect.Effect<A, E>, idle: boolean) {
      const hand = hands.get(id);
      if (!hand) return yield* Effect.fail(missing(t("server.session.life.helperRef", { id }), [lookIn.session]));
      return yield* hand.access.withPermits(1)(
        Effect.gen(function* () {
          const session = core.session(id);
          if (hands.get(id) !== hand || !session) return yield* Effect.fail(missing(t("server.session.life.helperRef", { id }), [lookIn.session]));
          if (idle) {
            if (isBusy(session) || hand.triggers.length > 0) return yield* Effect.fail(refused(t("server.session.life.stillWorking", { name: session.name })));
            yield* rest(hand);
          }
          return yield* use(hand.place);
        }),
      );
    });

    const capacity = (): Pick<T.Session, "id" | "agent" | "runtime" | "repo" | "phase">[] => {
      const visible = core.state().sessions.filter(isHired);
      return [
        ...visible.map((s) => {
          const h = hands.get(s.id);
          const allocation = executor.find(s.id);
          const opening = allocation !== undefined && (!allocation.attached || allocation.closing);
          // A submitted turn owns its slot before oar opens it: its trigger is the reservation.
          return (opening || (h !== undefined && h.triggers.length > 0)) && !isBusy(s) ? { ...s, phase: reserved(clock.currentTimeMillisUnsafe()) } : s;
        }),
        ...executor
          .all()
          .filter((a) => !visible.some((s) => s.id === a.owner.id))
          .map((a) => ({ ...a.owner, phase: reserved(clock.currentTimeMillisUnsafe()) })),
      ];
    };

    const limits = (runtime: string): SessionLimits => ({
      space: maxRunning,
      perRepo: repos.limit,
      perRuntime: store.settings(runtime).maxWorking ?? 0,
    });

    const roomFor = (runtime: string, repo: string) => noRoom(capacity(), runtime, repo.trim(), limits(runtime));

    const remind = Effect.fn("Session.remind")(function* (agent: string, session: string, repo: string, input: string, recalled: Set<string>) {
      const found = yield* memories.recall({ agent, session, repo, text: input, skip: new Set(recalled) });
      for (const id of found.ids) recalled.add(id);
      if (found.ids.length > 0) save();
      return recallBlock(found.lines);
    });

    const wake = Effect.fn("Session.wake")(function* (h: Hand, session: T.Session, input: string, recall: string): Effect.fn.Return<Delivered> {
      const agent = store.agent(session.agent);
      if (!agent) return { kind: "refused", reason: t("server.session.life.agentGone", { name: session.name }) };
      const stopFailed = yield* rest(h).pipe(
        Effect.as(""),
        Effect.catch((e) => Effect.succeed(reasonOf(e))),
      );
      if (stopFailed) return { kind: "refused", reason: stopFailed };
      const resume = h.oarSessionId;
      let opened = yield* open(agent, session, h, h.place, withRecall(recall, input), resume);
      if (!opened.execution && !opened.retained && resume) {
        h.recalled.clear();
        const again = yield* remind(session.agent, h.id, h.place.repo, input, h.recalled);
        opened = yield* open(agent, session, h, h.place, withRecall(again, (session.issue ? restartedNote : restartedContextNote) + input), "");
      }
      if (!opened.execution) return { kind: "refused", reason: t("server.session.life.cannotWake", { name: session.name, why: opened.refused }) };
      attach(h, opened.execution, session.runtime);
      return { kind: "run", launch: h.launch || h.id, woke: true };
    });

    const deliver = Effect.fn("Session.deliver")(function* (id: string, text: string, input: DeliveryInput): Effect.fn.Return<Delivered> {
      const h = hands.get(id);
      if (!h) return { kind: "refused", reason: t("server.session.life.noHelper", { id }) };
      return yield* Effect.gen(function* (): Effect.fn.Return<Delivered> {
        const session = core.session(id);
        if (hands.get(id) !== h || !session) return { kind: "refused", reason: t("server.session.life.noHelper", { id }) };
        const execution = executor.find(id);
        if (execution?.closing === true) return { kind: "refused", reason: t("server.session.life.stillClosing", { name: session.name }) };
        const starts = !isBusy(session);
        let recall = "";
        if (starts) {
          const full = noRoom(capacity(), session.runtime, h.place.repo, limits(session.runtime), id, input.byOwnerComment);
          if (full) return { kind: "refused", reason: t("server.session.life.noRoom", { name: session.name, full }) };
          recall = yield* remind(session.agent, id, h.place.repo, text, h.recalled);
        }
        if (execution?.attached !== true || !h.launch) {
          expect(h, input);
          const d = yield* wake(h, session, text, recall);
          if (d.kind === "refused") unexpect(h);
          return d;
        }
        const launch = h.launch;
        const inputId = newId();
        h.inputs.set(inputId, input.envelopeIds);
        if (starts) expect(h, input);
        const sent = yield* executor.deliver(id, withRecall(recall, text), inputId);
        if (sent.kind === "accepted" && sent.landed === "prompted") {
          h.inputs.delete(inputId);
          return { kind: "run", launch };
        }
        if (starts) unexpect(h);
        if (sent.kind !== "accepted") {
          h.inputs.delete(inputId);
          return { kind: "refused", reason: t("server.session.life.notReceived", { name: session.name, why: sent.reason }) };
        }
        if (sent.landed === "queued") {
          if (sent.inputId === undefined) h.inputs.delete(inputId);
          expect(h, input, sent.inputId);
          return { kind: "queued", launch };
        }
        if (sent.inputId === undefined) {
          h.inputs.delete(inputId);
          consume(h, input.envelopeIds);
        }
        return { kind: "steered", launch };
      }).pipe(admission.withPermits(1), h.access.withPermits(1));
    });

    const handOver = Effect.fn("Session.handOver")(function* (
      id: string,
      closed: T.SessionClose,
      use: (place: Workplace, lastText: string) => Effect.Effect<Merged, MergeFailure | RepoError>,
      settle: Settle = "owner",
    ) {
      const h = hands.get(id);
      if (!h) return yield* Effect.fail<ApiError | NotTakenIn>(missing(t("server.session.life.helperRef", { id }), [lookIn.session]));
      return yield* h.access.withPermits(1)(
        Effect.gen(function* () {
          const current = core.session(id);
          if (hands.get(id) !== h || !current)
            return yield* Effect.fail<ApiError | NotTakenIn>(missing(t("server.session.life.helperRef", { id }), [lookIn.session]));
          if (!current.issue) return yield* Effect.fail<ApiError | NotTakenIn>(refused(t("server.session.life.noIssue")));
          if (isBusy(current) || h.triggers.length > 0)
            return yield* Effect.fail<ApiError | NotTakenIn>(refused(t("server.session.life.stillWorking", { name: current.name })));
          yield* rest(h);
          const merged = yield* use(h.place, h.lastText).pipe(
            Effect.mapError((e) => {
              const f = Predicate.isTagged(e, "MergeFailure") ? e : MergeFailure.error(reasonText(e));
              const words = notTakenIn(f, current.name, settle);
              return NotTakenIn.make({ failure: f, ...words, message: words.owner });
            }),
          );
          if (merged.pullRequest) return merged;
          yield* leave(h, closed, closed === "merged" ? merged.commits : 0);
          if (merged.warning) yield* core.notice("warn", merged.warning);
          return merged;
        }),
      );
    });
    return { open, leave, rest, revokeAccess, accessWorkplace, capacity, roomFor, remind, deliver, handOver };
  });
