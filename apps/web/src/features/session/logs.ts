import type { LiveEvent, SessionEvent } from "@vibevalley/protocol";

import { mergeSteps } from "./rounds";

interface Log {
  readonly id: string;
  steps: SessionEvent[];
  readonly listeners: Set<(steps: SessionEvent[]) => void>;
  reading: { during: SessionEvent[]; again: boolean } | undefined;
}

/** One current log per observed session. Snapshots replace the retained window; live revisions arriving during the read
 * are merged into it. Reconnecting re-reads every observed log, including a run that ended while disconnected. */
export class SessionLogs {
  private readonly logs = new Map<string, Log>();
  private stop: (() => void) | undefined;

  private readonly read: (id: string) => Promise<SessionEvent[]>;
  private readonly follow: (event: (e: LiveEvent) => void, connected: () => void) => () => void;
  constructor(read: (id: string) => Promise<SessionEvent[]>, follow: (event: (e: LiveEvent) => void, connected: () => void) => () => void) {
    this.read = read;
    this.follow = follow;
  }

  subscribe(id: string, listener: (steps: SessionEvent[]) => void): () => void {
    let log = this.logs.get(id);
    if (!log) {
      log = { id, steps: [], listeners: new Set(), reading: undefined };
      this.logs.set(id, log);
    }
    log.listeners.add(listener);
    listener(log.steps);
    this.stop ??= this.follow(
      (event) => {
        if (event.type !== "event") return;
        const current = this.logs.get(event.id);
        if (!current) return;
        if (current.reading) current.reading.during = mergeSteps(current.reading.during, [event.activity]);
        this.publish(current, mergeSteps(current.steps, [event.activity]));
      },
      () => {
        for (const current of this.logs.values()) void this.refresh(current);
      },
    );
    if (log.listeners.size === 1) void this.refresh(log);
    return () => {
      log.listeners.delete(listener);
      if (log.listeners.size > 0) return;
      this.logs.delete(id);
      if (this.logs.size === 0) {
        this.stop?.();
        this.stop = undefined;
      }
    };
  }

  private publish(log: Log, steps: SessionEvent[]) {
    if (steps.length === log.steps.length && steps.every((s, i) => s.seq === log.steps[i]!.seq && s.revision === log.steps[i]!.revision)) return;
    log.steps = steps;
    for (const listener of log.listeners) listener(steps);
  }

  private async refresh(log: Log): Promise<void> {
    if (log.reading) {
      log.reading.again = true;
      return;
    }
    const reading = { during: [] as SessionEvent[], again: false };
    log.reading = reading;
    try {
      const snapshot = await this.read(log.id);
      if (this.logs.get(log.id) === log) this.publish(log, mergeSteps(snapshot, reading.during));
    } catch {
      // The query retries a failed read. Keep the received steps; a reconnect or a new observer tries again.
    } finally {
      log.reading = undefined;
      if (reading.again && this.logs.get(log.id) === log) void this.refresh(log);
    }
  }
}
