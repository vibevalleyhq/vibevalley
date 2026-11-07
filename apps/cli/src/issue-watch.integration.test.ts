import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber, Schema } from "effect";

import { VibeValleyApi } from "@vibevalley/protocol";
import { IssueWatch } from "@vibevalley/protocol/schema";

import { cli, workingFarm } from "./testing.ts";

const rowsOf = (body: string) =>
  body
    .split("\n")
    .filter(Boolean)
    .map((line) => Schema.decodeSync(Schema.fromJsonString(IssueWatch))(line));

describe("issue watch command", () => {
  it.live("regression: watch emits history then settled state and leaves global JSON a single document", () =>
    Effect.gen(function* () {
      const server = yield* workingFarm;
      const at = (...args: string[]) => [...args, "--server", server];
      const agent = (yield* cli(at("agent", "create", "fox", "--runtime", "pi"))).out.split("  ")[0]!;
      yield* cli(at("repo", "create", "clock"));
      const made = yield* cli(at("issue", "create", "打卡页提交", "--repo", "clock", "--agent", agent));
      const id = /^#(\d+)/u.exec(made.out)?.[1] ?? "";
      const started = yield* cli(at("issue", "status", id, "todo"));
      expect(started, started.err).toMatchObject({ code: 0 });
      const watched = yield* cli(at("issue", "watch", id, "--jsonl"));
      expect(watched.code).toBe(0);
      const rows = rowsOf(watched.out);
      expect(rows.some((r) => r.kind === "event" && r.event.type === "tool/result")).toBe(true);
      expect(rows.at(-1)).toMatchObject({ kind: "state", settled: true });
      const again = yield* cli(at("issue", "watch", id, "--jsonl"));
      expect(again.code).toBe(0);
      expect(rowsOf(again.out).at(-1)).toMatchObject({ kind: "state", settled: true });
      const json = yield* cli(at("issue", "watch", id, "--format", "json"));
      expect(json.code).toBe(2);
      expect(json.out).toBe("");
      expect((yield* cli(at("issue", "show", id, "--watch", "--format", "json"))).code).toBe(0);
      const follower = yield* cli(at("issue", "watch", id, "--follow", "--jsonl")).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(follower);
      const api = new VibeValleyApi(server);
      const after = yield* Effect.promise(() => api.issue.get({ id }));
      expect(after.status).toBe("in_review");
      expect((yield* cli(at("issue", "status", id, "canceled"))).code).toBe(0);
      expect(rowsOf((yield* cli(at("issue", "watch", id, "--jsonl"))).out).at(-1)).toMatchObject({
        kind: "state",
        settled: true,
        issue: { status: "canceled" },
      });
    }),
  );
});
