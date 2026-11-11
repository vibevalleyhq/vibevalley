import { Effect, Schedule, Schema, Stream } from "effect";

import { t } from "@vibevalley/i18n";
import type { IssueWatch, SessionEvent } from "@vibevalley/protocol";
import { IssueWatch as WatchSchema } from "@vibevalley/protocol/schema";

import { exit, Failure, jsonText, out } from "#/base/output.ts";
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

const textOf = (row: Row): Effect.Effect<string, Failure> => {
  switch (row.kind) {
    case "event":
      return Effect.succeed(
        [
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
          .join(" "),
      );
    case "gap":
      return Effect.succeed(
        row.before === undefined
          ? t("cli.issue.watchUnavailable", { session: row.session })
          : t("cli.issue.watchGap", { session: row.session, before: row.before }),
      );
    case "missing":
      return Effect.succeed(t("cli.issue.watchMissing", { issue: row.issue }));
    case "state":
      return Effect.map(
        jsonText({
          stage: row.issue.stage,
          pullRequest: row.issue.pullRequest,
          delivered: row.issue.delivered,
          questions: row.issue.questions,
          sessions: row.sessions.map((s) => ({ id: s.id, phase: s.phase, toolConnections: s.toolConnections })),
          omittedSessions: row.omittedSessions,
        }),
        (state) => `#${row.issue.number} ${row.issue.stage.state}\n${state}`,
      );
  }
};

export const observeIssue = Effect.fn("Cli.observeIssue")(function* (base: string, id: string, follow: boolean, jsonl: boolean) {
  const cursor = eventCursor();
  const gaps = new Map<string, string>();
  let previous = "";
  const source = frames(base, `/api/v1/issue/watch/${encodeURIComponent(id)}`).pipe(
    Stream.mapEffect((data) =>
      Schema.decodeEffect(Schema.fromJsonString(WatchSchema))(data).pipe(
        Effect.mapError((e) => Failure.make({ code: exit.other, tag: "WatchProtocol", text: e.message })),
      ),
    ),
    Stream.retry(
      Schedule.spaced("1 second").pipe(
        Schedule.while(({ input: error }: { input: Failure }) => error.tag === "Unreachable" || (error.tag === "Server" && error.status === undefined)),
      ),
    ),
    Stream.repeat(Schedule.spaced("1 second")),
  );
  yield* source.pipe(
    Stream.flatMap((row) =>
      Stream.fromIterable<Row>(row.kind === "history" ? row.events.map((event) => ({ kind: "event", session: row.session, event })) : [row]),
    ),
    Stream.filterEffect((row) => {
      switch (row.kind) {
        case "event":
          return Effect.succeed(cursor.accept(row.session, row.event));
        case "gap":
          return Effect.map(jsonText(row), (fingerprint) => {
            if (gaps.get(row.session) === fingerprint) return false;
            gaps.set(row.session, fingerprint);
            return true;
          });
        case "state": {
          const ids = row.sessionIds;
          cursor.sessions(ids);
          const live = new Set<string>(ids);
          for (const id of gaps.keys()) if (!live.has(id)) gaps.delete(id);
          return Effect.map(jsonText(row), (fingerprint) => {
            if (fingerprint === previous) return false;
            previous = fingerprint;
            return true;
          });
        }
        case "missing":
          return Effect.succeed(true);
      }
    }),
    Stream.tap((row) => Effect.flatMap(jsonl ? jsonText({ version: 1, ...row }) : textOf(row), out)),
    Stream.takeUntil((row) => row.kind === "missing" || (!follow && row.kind === "state" && row.settled)),
    Stream.runDrain,
  );
});
