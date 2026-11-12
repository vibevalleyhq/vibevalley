import type { Event } from "@botiverse/oar";
import type { SubagentReport } from "@botiverse/oar/agents";

import { t } from "@vibevalley/i18n";
import { omitUndefined } from "@vibevalley/protocol/rules";

import { worker as sessionActor } from "#/base/actor.ts";
import type { Core } from "#/core/core.ts";
import type { ServerConfig } from "#/infra/config.ts";
import { bestEffort, type Logger } from "#/infra/log.ts";
import type { Time } from "#/infra/time.ts";
import type { Memory } from "#/modules/memory/memory.ts";
import type { Runtime } from "#/modules/runtime/runtime.ts";

import { type Execution, type StartFailure } from "./executor.ts";
import { type Journal } from "./journal.ts";
import type { Machine } from "./machine.ts";
import { reactionTo, phaseFact, type Op, since } from "./reaction.ts";
import type { Hand, SessionRegistry } from "./registry.ts";
import { handsToUser, readReport } from "./report.ts";
import type { LaunchActivity } from "./signals.ts";

export interface WatchDeps {
  readonly config: ServerConfig;
  readonly clock: Time;
  readonly log: Logger;
  readonly core: Core;
  readonly memory: Memory;
  readonly runtime: Runtime;
  readonly machine: Machine;
}

// oar's observer callbacks are synchronous: each fact is applied (synchronously) in callback order.
export function makeWatch(r: SessionRegistry, deps: WatchDeps) {
  const { config, core, clock, log } = deps;
  const memories = deps.memory;
  const runtimes = deps.runtime;
  const machines = deps.machine;
  const executor = machines.executions(machines.here());
  const { fire, signal, launchOf, save, startRun, inputChanged, endRun } = r;
  const apply: Core["apply"] = (...facts) => core.apply(...facts);
  const notice: Core["notice"] = (level, text) => core.notice(level, text);
  const stallMs = config.session.stallSeconds * 1000;

  const closedLaunch = (h: Hand) => {
    if (h.launch) signal({ _tag: "Closed", id: h.id, launch: h.launch });
    h.launch = "";
  };

  const record = (j: Journal, op: Op) => {
    switch (op.type) {
      case "prompt":
        return j.asked(op.text, op.from);
      case "response":
        return j.said(op.text, op.from);
      case "thought":
        return j.thought(op.text, op.from);
      case "toolStarted":
        return j.toolStarted(op.callId, op.start, op.from);
      case "toolInput":
        return j.toolInput(op.callId, op.input, op.text, op.from);
      case "toolEnded":
        return j.toolEnded(op.callId, op.output, op.ok, op.from);
      case "note":
        return j.note(op.kind, op.text, op.from);
    }
  };

  const watch = (h: Hand, launch: string, runtime: string) => (event: Event) => {
    if (event.kind === "task_ended" && h.settling && event.status !== "completed") {
      const pending = h.settling;
      h.settling = {
        ...pending,
        report: {
          ...pending.report,
          outcome: event.status === "stopped" ? { kind: "aborted" } : { kind: "failed", failure: "unknown", reason: event.summary ?? event.taskId },
        },
      };
    }
    let opened = false;
    const signals: LaunchActivity[] = [];
    if (h.launch && h.launch === launch && event.agentPath.length === 0) {
      if (event.kind === "turn_started") {
        if (h.settling) {
          const pending = h.settling;
          delete h.settling;
          finishReport(h, pending.report, pending.completedBefore);
        }
        h.spoke = false;
        opened = true;
      } else if (event.kind === "reasoning" || event.kind === "text_delta" || event.kind === "tool_call_started") {
        if (!h.spoke) {
          h.spoke = true;
          signals.push({ _tag: "Spoke", id: h.id, launch: h.launch });
        }
      } else if (event.kind === "compaction_started") signals.push({ _tag: "Compacting", id: h.id, on: true });
      else if (event.kind === "compaction_ended") signals.push({ _tag: "Compacting", id: h.id, on: false });
    }
    const reaction = reactionTo(event, core.session(h.id), h.tracking, { id: h.id, runtime, cwd: h.place.cwd });
    h.tracking = reaction.tracking;
    if (reaction.model) h.tracking = omitUndefined({ ...h.tracking, rate: runtimes.quote(runtime, reaction.model) });
    if (opened) startRun(h);
    for (const a of signals) signal(a);
    for (const op of reaction.journal) record(h.journal, op);
    for (const fact of reaction.facts) {
      if (fact.type === "sessionReported") {
        const report = h.run ? { ...fact, run: h.run } : fact;
        apply(report);
        endRun(h, report.outcome, report.summary, report.spent);
      } else apply(fact);
    }
    if (reaction.spentCny !== 0) runtimes.spend(runtime, reaction.spentCny);
    if (reaction.warn) notice("warn", reaction.warn);
    if (event.kind === "exited") {
      delete h.settling;
      closedLaunch(h);
    }
  };

  const applyReport = (h: Hand, report: SubagentReport, completedBefore: number) => {
    if (report.outcome.kind === "completed" && !handsToUser(h.report) && (executor.find(h.id)?.pendingTasks ?? 0) > 0) {
      h.settling = { report, completedBefore };
      const channel = core.session(h.id)?.channel;
      apply({
        type: "sessionPhaseChanged",
        id: h.id,
        ...(channel !== undefined ? { channel } : {}),
        phase: { _tag: "working", since: clock.now(), doing: { action: "wait", label: "" } },
      });
      signal({ _tag: "Settling", id: h.id, launch: h.launch });
      return;
    }
    delete h.settling;
    finishReport(h, report, completedBefore);
  };

  const finishReport = (h: Hand, report: SubagentReport, completedBefore: number) => {
    const session = core.session(h.id);
    if (!session) return;
    const read = readReport(report.outcome, report.text);
    const declared = h.report;
    const canRest = read.outcome === "completed" && session.issue !== undefined && !handsToUser(declared);
    h.report = undefined;
    const summary = declared?.summary.trim() || read.summary;
    const spent = session.spent ? since(session.spent, h.tracking.runFrom) : undefined;
    h.lastText = read.text;
    h.tracking = omitUndefined({ ...h.tracking, runFrom: undefined });
    const { launch, spoke } = h;
    apply({
      type: "sessionReported",
      id: h.id,
      outcome: read.outcome,
      ...(canRest ? { phase: { _tag: "resting" as const } } : {}),
      summary,
      runs: completedBefore + report.turn,
      ...(spent ? { spent } : {}),
      ...(h.run ? { run: h.run } : {}),
      questions: declared?.questions ?? read.questions,
      checks: declared?.checks ?? read.checks,
      ...(declared?.answer ? { answer: declared.answer } : {}),
    });
    // reduce folds the fact synchronously; the reported phase tells whether the session rests.
    const waiting = core.session(h.id)?.phase._tag === "resting";
    endRun(h, read.outcome, summary, spent);
    fire(`memories of ${h.id}'s run`, () =>
      memories.keep({
        agent: session.agent,
        session: h.id,
        ...(session.issue ? { issue: session.issue } : {}),
        repo: h.place.repo,
        brief: session.brief,
        outcome: read.outcome,
        said: read.text,
        summary,
      }),
    );
    if (declared && declared.remember.length > 0)
      fire(`declared memories of ${h.id}`, () =>
        bestEffort(log, `vibevalley: ${h.id}'s declared memories were not kept`, async () => {
          for (const memory of declared.remember)
            await memories.write({ agent: session.agent, text: memory.text, repo: memory.scope === "all" ? "" : h.place.repo, by: sessionActor(h.id) });
        }),
      );
    if (read.needsYou) notice("error", t("server.session.life.stoppedNeedsYou", { name: session.name, why: read.failure }));
    if (launch) signal({ _tag: read.outcome === "completed" && !waiting ? "HandedOff" : "Ended", id: h.id, launch, outcome: read.outcome, spoke });
    runtimes.usageSoon(session.runtime);
    save();
  };

  const stalled = (h: Hand, silentForMs: number, at: number) => {
    const session = core.session(h.id);
    if (session?.phase._tag !== "working") return;
    h.tracking = { ...h.tracking, quiet: true };
    apply(phaseFact(session, { ...session.phase, quietSince: at - silentForMs }));
    const quiet =
      silentForMs < 60_000
        ? t("server.session.life.seconds", { n: Math.round(silentForMs / 1000) })
        : t("server.session.life.minutes", { n: Math.round(silentForMs / 60_000) });
    const last = session.phase.doing.label ? t("server.session.log.quietLast", { label: session.phase.doing.label }) : "";
    h.journal.note("run/error", t("server.session.log.quiet", { span: quiet, last }));
    notice("warn", t("server.session.life.quietNotice", { name: session.name, span: quiet, last }));
  };

  const attach = (h: Hand, s: Execution, runtime: string, launch = launchOf(h.id)) => {
    h.launch = launch;
    h.spoke = false;
    if (s.sessionId) h.oarSessionId = s.sessionId;
    h.tracking = omitUndefined({ ...h.tracking, oarTokens: undefined });
    apply({ type: "sessionToolsReset", id: h.id });
    const completedBefore = core.session(h.id)?.runs ?? 0;
    executor.observe(h.id, {
      event: watch(h, launch, runtime),
      connection: (connection) => {
        h.journal.connection(connection);
        apply({ type: "sessionToolChanged", id: h.id, connection });
      },
      input: (input) => inputChanged(h, input),
      report: (report) => applyReport(h, report, completedBefore),
      tasksChanged: (pending) => {
        if (pending === 0 && h.settling) {
          const waiting = h.settling;
          delete h.settling;
          finishReport(h, waiting.report, waiting.completedBefore);
        }
      },
      stalled: (silentForMs, at) => stalled(h, silentForMs, at),
      stallMs,
    });
    save();
  };

  const failedOpening = async (id: string, why: string): Promise<StartFailure> => {
    const failure = await executor.failed(id, why);
    if (failure.retained) core.notice("error", failure.refused);
    return failure;
  };
  return { closedLaunch, finishReport, attach, failedOpening };
}

export type SessionWatch = ReturnType<typeof makeWatch>;
