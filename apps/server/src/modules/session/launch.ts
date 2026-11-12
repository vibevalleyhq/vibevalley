import type { SessionOptions } from "@botiverse/oar";

import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { maxRunning } from "@vibevalley/protocol";
import { isBusy } from "@vibevalley/protocol/rules";

import { BizCode, lookIn, messageOf, missing, refuseIn } from "#/base/errors.ts";
import { newId } from "#/base/ids.ts";
import type { Core } from "#/core/core.ts";
import type { Logger } from "#/infra/log.ts";
import type { Time } from "#/infra/time.ts";
import type { Agent } from "#/modules/agent/agent.ts";
import { type Started } from "#/modules/machine/executor.ts";
import type { Machine } from "#/modules/machine/machine.ts";
import type { Memory } from "#/modules/memory/memory.ts";
import type { Repo } from "#/modules/repo/repo.ts";
import { type Merged, MergeFailure, type Workplace } from "#/modules/repo/workplace.ts";

import { briefBreak, instructions, noRoom, notTakenIn, recallBlock, type SessionLimits, type Settle, toOarMcp, withRecall } from "./briefing.ts";
import { workerInstructions, channelRules, restartedContextNote, restartedNote, workplaceRules } from "./prompts.ts";
import type { Hand, SessionRegistry } from "./registry.ts";
import { isHired } from "./roster.ts";
import { type Delivered, type DeliveryInput, DeliveryRefused } from "./signals.ts";
import type { SessionWatch } from "./watch.ts";
import type { WorkerAccess } from "./worker.ts";

const refused = refuseIn(BizCode.SessionRefused);

/** Work that did not go in (see handOver); the session stays. */
export class NotTakenIn extends Error {
  override readonly name = "NotTakenIn";
  readonly failure: MergeFailure;
  /** What the helper is sent back with; "" when the user settles it. */
  readonly fix: string;
  /** What the user is told; also the message. */
  readonly user: string;
  readonly notice: string;
  readonly short: string;
  constructor(failure: MergeFailure, words: { readonly fix: string; readonly user: string; readonly notice: string; readonly short: string }) {
    super(words.user);
    this.failure = failure;
    this.fix = words.fix;
    this.user = words.user;
    this.notice = words.notice;
    this.short = words.short;
  }
}

/** A failure's words, whatever it is. */
export const reasonText = (e: unknown): string => messageOf(e);
/** A turn submitted and not opened yet, counted from since: its slot is taken, as one thinking. */
const reserved = (since: number): T.Session["phase"] => ({ _tag: "working", since, doing: { action: "thinking", label: "" } });

export interface LaunchDeps {
  readonly clock: Time;
  readonly log: Logger;
  readonly core: Core;
  readonly agent: Agent;
  readonly memory: Memory;
  readonly repo: Repo;
  readonly machine: Machine;
}

/** cli is how helpers reach the worker CLI; none when it could not be set up, and then no helper starts. */
export function makeLaunch(r: SessionRegistry, wt: SessionWatch, cli: WorkerAccess | undefined, deps: LaunchDeps) {
  const { core, clock, log } = deps;
  const store = deps.agent;
  const memories = deps.memory;
  const repos = deps.repo;
  const machines = deps.machine;
  const executor = machines.executions(machines.here());
  const { flushRuns, tasks, mcpEndpoint, roster, save, ended, expect, unexpect, consume, release, closeExecution } = r;
  const { closedLaunch, attach } = wt;
  const revokeAccess = async (hand: Hand) => {
    roster.revokeToken(hand);
    if (cli) await cli.revoke(hand.id).catch((e: unknown) => log.warn(`vibevalley: ${hand.id}'s worker credential was not removed`, e));
  };

  const opening = async (agent: T.Agent, owner: T.Session, hand: Hand, place: Workplace, input: string, resume: string): Promise<Started> => {
    if (!cli) return { refused: t("server.session.life.workerUnavailable"), retained: false };
    const token = roster.issueToken(hand);
    let access: { readonly authenticated: boolean; readonly command: string } | undefined;
    try {
      access = await cli.prepare(hand.id, mcpEndpoint.url, token);
    } catch (e) {
      // Taken as not let in: the hire is refused with workerAuthenticationFailed.
      log.warn(`vibevalley: ${hand.id}'s worker credential was not prepared`, e);
    }
    if (access?.authenticated !== true) {
      return { refused: t("server.session.life.workerAuthenticationFailed"), retained: false };
    }
    const houseRules = owner.issue ? await repos.houseRules() : "";
    const text = [
      workerInstructions(access.command),
      instructions(agent, store.skills()),
      owner.issue ? workplaceRules(place, houseRules, owner.id, repos.usesPullRequests(place.repo)) : channelRules(place.cwd, owner.channel ?? "", owner.id),
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
    const opened = await executor.start({
      agent,
      owner,
      cwd: place.cwd,
      input: text && agent.personaMode === "prompt" ? text + briefBreak + input : input,
      resume,
      options,
    });
    if (opened.retained === true) core.notice("error", opened.refused);
    return opened;
  };

  /** An execution opened for the hand; its credential revoked again when none opened, however that ended. */
  const open = async (agent: T.Agent, owner: T.Session, hand: Hand, place: Workplace, input: string, resume: string): Promise<Started> => {
    if (!cli || !(await cli.executableAvailable())) return { refused: t("server.session.life.workerUnavailable"), retained: false };
    let opened: Started | undefined;
    try {
      opened = await opening(agent, owner, hand, place, input, resume);
      return opened;
    } finally {
      if (!opened?.execution) await revokeAccess(hand);
    }
  };

  const leave = async (h: Hand, closed: T.SessionClose, merged: number) => {
    await tasks.stop(`idle:${h.id}`);
    release(h);
    await flushRuns();
    await h.stack.disposeAsync();
    await ended(h.id, closed);
    closedLaunch(h);
    roster.delete(h);
    const session = core.session(h.id);
    if (session) await memories.endSession({ agent: session.agent, session: h.id, repo: h.place.repo });
    core.apply({ type: "sessionLeft", id: h.id, closed, ...(merged > 0 ? { merged } : {}) });
    save();
  };

  /** Lets the oar session go, keeping its id to resume. */
  const rest = async (h: Hand) => {
    await closeExecution(h);
    release(h);
    closedLaunch(h);
    save();
  };

  const missingHelper = (id: string) => missing(t("server.session.life.helperRef", { id }), [lookIn.session]);

  const accessWorkplace = async <A>(id: string, use: (place: Workplace) => Promise<A>, idle: boolean): Promise<A> =>
    roster.withHand(
      id,
      () => {
        throw missingHelper(id);
      },
      async (hand) => {
        const session = core.session(id);
        if (!session) throw missingHelper(id);
        if (idle) {
          if (isBusy(session) || hand.triggers.length > 0) throw refused(t("server.session.life.stillWorking", { name: session.name }));
          await rest(hand);
        }
        return use(hand.place);
      },
    );

  const capacity = (): Pick<T.Session, "id" | "agent" | "runtime" | "repo" | "phase">[] => {
    const visible = core.state().sessions.filter(isHired);
    return [
      ...visible.map((s) => {
        const h = roster.get(s.id);
        const allocation = executor.find(s.id);
        const opening = allocation !== undefined && (!allocation.attached || allocation.closing);
        // A submitted turn owns its slot before oar opens it: its trigger is the reservation.
        return (opening || (h !== undefined && h.triggers.length > 0)) && !isBusy(s) ? { ...s, phase: reserved(clock.now()) } : s;
      }),
      ...executor
        .all()
        .filter((a) => !visible.some((s) => s.id === a.owner.id))
        .map((a) => ({ ...a.owner, phase: reserved(clock.now()) })),
    ];
  };

  const limits = (runtime: string): SessionLimits => ({
    space: maxRunning,
    perRepo: repos.limit,
    perRuntime: store.settings(runtime).maxWorking ?? 0,
  });

  const roomFor = (runtime: string, repo: string) => noRoom(capacity(), runtime, repo.trim(), limits(runtime));

  const remind = async (agent: string, session: string, repo: string, input: string, recalled: Set<string>) => {
    const found = await memories.recall({ agent, session, repo, text: input, skip: new Set(recalled) });
    for (const id of found.ids) recalled.add(id);
    if (found.ids.length > 0) save();
    return recallBlock(found.lines);
  };

  const wake = async (h: Hand, session: T.Session, input: string, recall: string): Promise<Delivered> => {
    const agent = store.agent(session.agent);
    if (!agent) throw new DeliveryRefused(t("server.session.life.agentGone", { name: session.name }));
    try {
      await rest(h);
    } catch (e) {
      throw new DeliveryRefused(messageOf(e), { cause: e });
    }
    const resume = h.oarSessionId;
    let opened = await open(agent, session, h, h.place, withRecall(recall, input), resume);
    if (!opened.execution && !opened.retained && resume) {
      h.recalled.clear();
      const again = await remind(session.agent, h.id, h.place.repo, input, h.recalled);
      opened = await open(agent, session, h, h.place, withRecall(again, (session.issue ? restartedNote : restartedContextNote) + input), "");
    }
    if (!opened.execution) {
      throw new DeliveryRefused(t("server.session.life.cannotWake", { name: session.name, why: opened.refused }));
    }
    attach(h, opened.execution, session.runtime);
    return { kind: "run", launch: h.launch || h.id, woke: true };
  };

  const noHelperDelivered = (id: string) => new DeliveryRefused(t("server.session.life.noHelper", { id }));

  const deliver = async (id: string, text: string, input: DeliveryInput): Promise<Delivered> =>
    roster.withHandAndAdmission(
      id,
      () => {
        throw noHelperDelivered(id);
      },
      async (h): Promise<Delivered> => {
        const session = core.session(id);
        if (!session) throw noHelperDelivered(id);
        const execution = executor.find(id);
        if (execution?.closing === true) throw new DeliveryRefused(t("server.session.life.stillClosing", { name: session.name }));
        const starts = !isBusy(session);
        let recall = "";
        if (starts) {
          const full = noRoom(capacity(), session.runtime, h.place.repo, limits(session.runtime), id, input.byUserComment);
          if (full) throw new DeliveryRefused(t("server.session.life.noRoom", { name: session.name, full }));
          recall = await remind(session.agent, id, h.place.repo, text, h.recalled);
        }
        if (execution?.attached !== true || !h.launch) {
          expect(h, input);
          try {
            return await wake(h, session, text, recall);
          } catch (e) {
            unexpect(h);
            throw e;
          }
        }
        const launch = h.launch;
        const inputId = newId();
        h.inputs.set(inputId, input.envelopeIds);
        if (starts) expect(h, input);
        let sent: Awaited<ReturnType<typeof executor.deliver>>;
        try {
          sent = await executor.deliver(id, withRecall(recall, text), inputId);
        } catch (e) {
          h.inputs.delete(inputId);
          if (starts) unexpect(h);
          throw e;
        }
        if (sent.kind === "accepted" && sent.landed === "prompted") {
          h.inputs.delete(inputId);
          return { kind: "run", launch };
        }
        if (starts) unexpect(h);
        if (sent.kind !== "accepted") {
          h.inputs.delete(inputId);
          throw new DeliveryRefused(t("server.session.life.notReceived", { name: session.name, why: sent.reason }));
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
      },
    );

  /** The work taken in by use; NotTakenIn (the session stays) when use fails, whatever it failed with. */
  const handOver = async (
    id: string,
    closed: T.SessionClose,
    use: (place: Workplace, lastText: string) => Promise<Merged>,
    settle: Settle = "user",
  ): Promise<Merged> =>
    roster.withHand(
      id,
      () => {
        throw missingHelper(id);
      },
      async (h) => {
        const current = core.session(id);
        if (!current) throw missingHelper(id);
        if (!current.issue) throw refused(t("server.session.life.noIssue"));
        if (isBusy(current) || h.triggers.length > 0) throw refused(t("server.session.life.stillWorking", { name: current.name }));
        await rest(h);
        let merged: Merged;
        try {
          merged = await use(h.place, h.lastText);
        } catch (e) {
          const f = e instanceof MergeFailure ? e : MergeFailure.error(reasonText(e));
          throw new NotTakenIn(f, notTakenIn(f, current.name, settle));
        }
        if (merged.pullRequest) return merged;
        await leave(h, closed, closed === "merged" ? merged.commits : 0);
        if (merged.warning) core.notice("warn", merged.warning);
        return merged;
      },
    );
  return { open, leave, rest, revokeAccess, accessWorkplace, capacity, roomFor, remind, deliver, handOver };
}
