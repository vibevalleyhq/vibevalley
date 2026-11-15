import { Hub } from "@vibevalley/async";
import type * as T from "@vibevalley/protocol";
import { defaultOrchestrator } from "@vibevalley/protocol";
import { sessionId } from "@vibevalley/protocol/schema";

import { head } from "#/base/clip.ts";
import { jsonText } from "#/base/json.ts";
import type { Core } from "#/core/core.ts";
import type { ServerConfig } from "#/infra/config.ts";
import type { Db } from "#/infra/db.ts";
import type { Logger } from "#/infra/log.ts";
import type { Time } from "#/infra/time.ts";
import type { Agent } from "#/modules/agent/agent.ts";
import { restoredSession, sessionState } from "#/modules/session/history.ts";
import type { Lifecycle } from "#/modules/session/lifecycle.ts";
import { type Mailbox, makeMailbox } from "#/modules/session/mailbox.ts";
import { DeliveryRefused, newsOf, type Session, type SessionNews, sessionOver } from "#/modules/session/session.ts";
import type { Consumed, Delivered, LaunchActivity } from "#/modules/session/signals.ts";
import * as qsession from "#db/session.sql.ts";

/** Holds turns whose input contains "慢慢做" until release() when holds is true; inputs containing "必败" fail. */
export class FakeSessions {
  holds = true;
  stopped = false;
  private held = new Set<() => void>();
  release = () => {
    for (const go of [...this.held]) go();
  };
  inputs = new Map<string, string[]>();
  steers = new Map<string, string[]>();
  last = new Map<string, string>();
  running = new Map<string, string>();
  n = 0;
  private attachedCore: Core | undefined;
  get core(): Core {
    if (!this.attachedCore) throw new Error("FakeSessions used before playedSessions attached Core");
    return this.attachedCore;
  }
  set core(value: Core) {
    this.attachedCore = value;
  }
  news = new Hub<SessionNews>();
  consumed = (c: Consumed) => this.news.publish({ _tag: "Consumed", ...c });

  runsOf = (id: string) => [...(this.inputs.get(id) ?? [])];
  steersOf = (id: string) => [...(this.steers.get(id) ?? [])];
  private publish = (a: LaunchActivity) => this.news.publish(a);
  private apply = (...f: Parameters<Core["apply"]>) => this.core.apply(...f);

  deliver = (id: string, text: string, read: () => void = () => {}): Delivered | DeliveryRefused => {
    if (!this.core.session(id)) return new DeliveryRefused("不在地里");
    const launch = this.running.get(id);
    if (launch) {
      this.steers.set(id, [...this.steersOf(id), text]);
      if (!text.includes("必败")) read();
      return { kind: "steered", launch };
    }
    const fresh = `${id}-${++this.n}`;
    this.running.set(id, fresh);
    this.inputs.set(id, [...this.runsOf(id), text]);
    const channel = this.core.session(id)?.channel;
    this.apply({
      type: "sessionPhaseChanged",
      id: sessionId(id),
      ...(channel !== undefined ? { channel } : {}),
      phase: { _tag: "working", since: Date.now(), doing: { action: "thinking", label: "" } },
    });
    void this.run(id, fresh, text, read);
    return { kind: "run", launch: fresh, woke: true };
  };

  private async run(id: string, launch: string, input: string, read: () => void) {
    if (input.includes("慢慢做") && this.holds)
      await new Promise<void>((go) => {
        const done = () => {
          this.held.delete(done);
          go();
        };
        this.held.add(done);
      });
    if (this.stopped) return;
    const runs = this.runsOf(id).length;
    if (!input.includes("必败")) read();
    if (input.includes("必败")) {
      this.running.delete(id);
      this.apply({
        type: "sessionReported",
        questions: [],
        checks: [],
        id: sessionId(id),
        outcome: "failed",
        summary: "provider said no",
        runs,
      });
      this.publish({ _tag: "Ended", id, launch, outcome: "failed", spoke: false });
      return;
    }
    const line = input.split("\n").find((l) => l.startsWith("[target=")) ?? head(input, 20);
    this.last.set(id, "收到了（" + line + "）");
    this.publish({ _tag: "Spoke", id, launch });
    this.running.delete(id);
    this.apply({ type: "sessionReported", questions: [], checks: [], id: sessionId(id), outcome: "completed", summary: "收到了", runs });
    this.publish({ _tag: "Ended", id, launch, outcome: "completed", spoke: true });
  }
}

export interface PlayedSessionsDeps {
  readonly config: ServerConfig;
  readonly clock: Time;
  readonly log: Logger;
  readonly db: Db;
  readonly core: Core;
  readonly agent: Agent;
}

export interface PlayedSessions {
  readonly session: Session;
  readonly mailbox: Mailbox;
  readonly boot: () => Promise<void>;
  readonly close: () => Promise<void>;
}

export async function playedSessions(x: FakeSessions, deps: PlayedSessionsDeps): Promise<PlayedSessions> {
  const { config, clock, log, db, core, agent } = deps;
  x.core = core;
  for (const row of await qsession.activeSessions(db.sql)) core.apply({ type: "sessionChanged", session: restoredSession(row) });
  await qsession.keepSession(db.sql, {
    id: sessionId(defaultOrchestrator),
    role: "orchestrator",
    agent: defaultOrchestrator,
    name: "助手",
    runtime: "vibevalley",
    brief: "",
    repo: null,
    issue: null,
    channel: null,
    hired_at: 0,
    machine: null,
  });
  const played = {
    isReachable: (id: string) => x.core.session(id) !== undefined,
    sessionOf: (id: string) => x.core.session(id),
    hired: () => x.core.state().sessions.filter((s) => s.role === "worker"),
    deliver: async (id: string, text: string, input: Parameters<Lifecycle["deliver"]>[2]) => {
      const out = x.deliver(id, text, () => x.consumed({ session: id, envelopeIds: [...input.envelopeIds] }));
      if (out instanceof DeliveryRefused) throw out;
      return out;
    },
    runOf: () => undefined,
    lastTextOf: (id: string) => x.last.get(id) ?? "",
    cwdOf: () => undefined,
    news: () => x.news.subscribe(),
  };
  const lifecycle = played as unknown as Lifecycle;
  const mailbox = await makeMailbox({ db, clock, log, config, agent, session: lifecycle });
  const session = sessionOver({
    lifecycle,
    mailbox,
    close: () => mailbox.close(),
  });
  const { changes: moves } = core.transitions();
  const relay = (async () => {
    for await (const { fact, after } of moves) {
      if (fact.type === "sessionLeft") await qsession.endSession(db.sql, { id: fact.id, closed: fact.closed ?? "dismissed", ended_at: fact.at });
      const n = newsOf(fact, after);
      if (n) x.news.publish(n);
    }
  })();
  return {
    session,
    mailbox,
    boot: () => mailbox.boot(),
    close: async () => {
      for (const s of core.state().sessions) await qsession.keepSessionState(db.sql, sessionState(s));
      x.stopped = true;
      x.release();
      moves.close();
      await relay;
      await mailbox.close();
    },
  };
}

export const keepPlayedSession = (db: Db, session: T.Session): Promise<number> =>
  db.sql.exec(
    `insert into session (id, role, agent, name, runtime, brief, repo, issue, channel, hired_at, phase, refining, runs)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) on conflict (id) do nothing`,
    [
      session.id,
      session.role,
      session.agent,
      session.name,
      session.runtime,
      session.brief,
      session.repo ?? null,
      session.issue ?? null,
      session.channel ?? null,
      session.hiredAt,
      jsonText(session.phase),
      session.refining,
      session.runs,
    ],
  );
