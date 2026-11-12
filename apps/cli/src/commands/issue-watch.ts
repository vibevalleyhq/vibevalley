import { t } from "@vibevalley/i18n";
import type { IssueWatch, SessionEvent } from "@vibevalley/protocol";
import { IssueWatch as WatchSchema } from "@vibevalley/protocol/schema";

import { exit, Failure, type Io, jsonText, out } from "#/base/output.ts";
import { frames } from "#/infra/farm.ts";

export function eventCursor() {
  const held = new Map<string, { floor: number; revisions: Map<number, number> }>();
  return {
    sessions(ids: readonly string[]) {
      for (const id of held.keys()) if (!ids.includes(id)) held.delete(id);
    },
    accept(id: string, event: SessionEvent) {
      let cursor = held.get(id);
      if (!cursor) {
        cursor = { floor: -1, revisions: new Map() };
        held.set(id, cursor);
      }
      if (event.seq <= cursor.floor || (cursor.revisions.get(event.seq) ?? -1) >= event.revision) return false;
      cursor.revisions.set(event.seq, event.revision);
      if (cursor.revisions.size > 256) {
        const oldest = Math.min(...cursor.revisions.keys());
        cursor.floor = Math.max(cursor.floor, oldest);
        cursor.revisions.delete(oldest);
      }
      return true;
    },
  };
}

type Row = Exclude<IssueWatch, { kind: "history" }>;

const textOf = (row: Row): string => {
  switch (row.kind) {
    case "event":
      return [
        row.session,
        `${row.event.seq}.${row.event.revision}`,
        row.event.type,
        row.event.actionText,
        row.event.text,
        row.event.input,
        row.event.output,
        row.event.ok === undefined ? "" : String(row.event.ok),
      ]
        .filter((v) => v !== undefined && v !== "")
        .join(" ");
    case "gap":
      return row.before === undefined
        ? t("cli.issue.watchUnavailable", { session: row.session })
        : t("cli.issue.watchGap", { session: row.session, before: row.before });
    case "missing":
      return t("cli.issue.watchMissing", { issue: row.issue });
    case "state": {
      const state = jsonText({
        stage: row.issue.stage,
        pullRequest: row.issue.pullRequest,
        delivered: row.issue.delivered,
        questions: row.issue.questions,
        sessions: row.sessions.map((s) => ({ id: s.id, phase: s.phase, toolConnections: s.toolConnections })),
        omittedSessions: row.omittedSessions,
      });
      return `#${row.issue.number} ${row.issue.stage.state}\n${state}`;
    }
  }
};

const decoded = (data: string): IssueWatch => {
  let json: unknown;
  try {
    json = JSON.parse(data);
  } catch (e) {
    throw new Failure({ code: exit.other, tag: "WatchProtocol", text: e instanceof Error ? e.message : String(e) });
  }
  const got = WatchSchema.safeParse(json);
  if (!got.success) throw new Failure({ code: exit.other, tag: "WatchProtocol", text: got.error.message });
  return got.data;
};

/** A dropped connection, as opposed to a refusal or a stream not in its shape: worth connecting again. */
const transient = (e: unknown) => e instanceof Failure && (e.tag === "Unreachable" || (e.tag === "Server" && e.status === undefined));

/** The watch's rows, reconnecting a second after the stream drops or ends, for as long as it is read. */
async function* watched(io: Io, base: string, id: string, signal: AbortSignal): AsyncGenerator<IssueWatch> {
  for (;;) {
    try {
      for await (const data of frames(io, base, `/api/v1/issue/watch/${encodeURIComponent(id)}`, signal)) yield decoded(data);
    } catch (e) {
      if (!transient(e)) throw e;
    }
    await io.clock.sleep(1_000, signal);
  }
}

export async function observeIssue(io: Io, base: string, id: string, follow: boolean, jsonl: boolean, signal: AbortSignal = io.signal): Promise<void> {
  const cursor = eventCursor();
  const gaps = new Map<string, string>();
  let previous = "";
  const fresh = (row: Row): boolean => {
    switch (row.kind) {
      case "event":
        return cursor.accept(row.session, row.event);
      case "gap": {
        const fingerprint = jsonText(row);
        if (gaps.get(row.session) === fingerprint) return false;
        gaps.set(row.session, fingerprint);
        return true;
      }
      case "state": {
        const ids = row.sessionIds;
        cursor.sessions(ids);
        const live = new Set<string>(ids);
        for (const id of gaps.keys()) if (!live.has(id)) gaps.delete(id);
        const fingerprint = jsonText(row);
        if (fingerprint === previous) return false;
        previous = fingerprint;
        return true;
      }
      case "missing":
        return true;
    }
  };
  for await (const got of watched(io, base, id, signal)) {
    const rows: Row[] = got.kind === "history" ? got.events.map((event) => ({ kind: "event", session: got.session, event })) : [got];
    for (const row of rows) {
      if (!fresh(row)) continue;
      out(io, jsonl ? jsonText({ version: 1, ...row }) : textOf(row));
      if (row.kind === "missing" || (!follow && row.kind === "state" && row.settled)) return;
    }
  }
}
