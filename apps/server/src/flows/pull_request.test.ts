import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { scriptedRuntime } from "@botiverse/oar/testing";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";

import type * as T from "@vibevalley/protocol";
import { latestSessionIdOf } from "@vibevalley/protocol/rules";

import { Agent } from "@/agent/agent.ts";
import { owner } from "@/base/actor.ts";
import { Ingress } from "@/ingress/ingress.ts";
import { explicitMandate } from "@/issue/creation.ts";
import { Issue } from "@/issue/issue.ts";
import { Project } from "@/project/project.ts";
import { Resource } from "@/resource/resource.ts";
import { Session } from "@/session/session.ts";
import { gitIn } from "@/testing/git.ts";
import { testConfig } from "@/testing/layers.ts";

import { await_, farm, git, lab, until, watch } from "./farm.ts";

const quiet = (cwd: string, ...args: string[]) => {
  try {
    gitIn(cwd, "-c", "user.name=session", "-c", "user.email=session@vibevalley.test", ...args);
    return true;
  } catch {
    return false;
  }
};

describe("a pull request", () => {
  // In a project that merges by pull request, done pushes the branch and opens one; the issue waits in review. A second
  // round only pushes. After a restart the PR is still the issue's; once GitHub merges or closes it, the issue closes and
  // its helper, worktree and branch go.
  for (const ending of ["MERGED", "CLOSED"] as const) {
    it.live(`merges by PR, and closes when the PR is ${ending.toLowerCase()}`, () => {
      const base = testConfig();
      const config = {
        ...base,
        db: join(base.home, "db"),
        github: { ...base.github, prProjects: ["clock"] },
      };
      const work = config.workRoot;
      const path = join(work, "projects", "clock");
      const bare = join(work, "origin.git");
      let creates = 0;
      let pushes = 0;
      let state = "OPEN";
      let head = "head-7";
      let conclusion = "FAILURE";
      const resolvedThreads: string[] = [];
      let issue: T.Issue | undefined;
      let branch = "";
      const gh = (...args: string[]) =>
        Effect.sync(() => {
          const ok = (out: string) => ({ out, ok: true, missing: false });
          if (args[0] === "--version") return ok("gh version 2.80.0");
          if (args[0] === "auth") return ok("Logged in to github.com account gardener (keyring)");
          if (args[0] === "repo") return ok(`{"viewerPermission":"WRITE"}`);
          if (args[0] === "pr" && args[1] === "list") return ok("[]");
          if (args[0] === "pr" && args[1] === "create") {
            creates++;
            for (const word of ["--head", branch, "--base", "main", "--title", issue!.title]) expect(args).toContain(word);
            const body = args[args.indexOf("--body") + 1]!;
            for (const want of [`#${issue!.number}`, "写版本A", "检查"]) expect(body).toContain(want);
            return ok("https://github.com/test/clock/pull/7\n");
          }
          if (args[0] === "pr" && args[1] === "view") return ok(JSON.stringify({ state, mergedAt: null, headRefOid: head }));
          if (args[0] === "api" && args[1] === "user") return ok(JSON.stringify({ login: "gardener" }));
          if (args[0] === "api" && args[1] === "graphql") {
            const thread = args.find((arg) => arg.startsWith("thread="))?.slice("thread=".length);
            if (thread) {
              resolvedThreads.push(thread);
              return ok(JSON.stringify({ data: { resolveReviewThread: { thread: { id: thread, isResolved: true } } } }));
            }
            expect(args).toContain("--paginate");
            expect(args).toContain("--slurp");
            const query = args.find((arg) => arg.startsWith("query="))?.slice(6) ?? "";
            const author = (login: string) => ({ login, __typename: login.endsWith("[bot]") ? "Bot" : "User" });
            const pull = (key: string, nodes: unknown[]) => ({ data: { repository: { pullRequest: { [key]: { nodes } } } } });
            if (query.startsWith("query IngressChecks("))
              return ok(
                JSON.stringify([
                  {
                    data: {
                      repository: {
                        object: {
                          statusCheckRollup: {
                            contexts: { nodes: [{ __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion, detailsUrl: "https://checks/7" }] },
                          },
                        },
                      },
                    },
                  },
                ]),
              );
            if (query.startsWith("query IngressReviews("))
              return ok(
                JSON.stringify(
                  [
                    [1, 2],
                    [3, 4],
                  ].map((rounds) =>
                    pull(
                      "reviews",
                      rounds.map((n) => ({
                        id: `R${n}`,
                        author: author("review-bot[bot]"),
                        state: "CHANGES_REQUESTED",
                        body: `round ${n}`,
                        submittedAt: `2026-11-01T00:0${n}:00Z`,
                      })),
                    ),
                  ),
                ),
              );
            if (query.startsWith("query IngressComments("))
              return ok(
                JSON.stringify([pull("comments", [{ id: "SELF", author: author("GARDENER"), body: "own", url: "", createdAt: "2026-11-01T00:00:00Z" }])]),
              );
            if (query.startsWith("query IngressThreads(")) {
              const nodes = Array.from({ length: head === "head-8" ? 7 : 6 }, (_, i) => ({
                id: `PRRC_${9 + i}`,
                fullDatabaseId: String(9 + i),
                author: author("review-bot[bot]"),
                body: "fix this line",
                url: `https://comments/${9 + i}`,
                createdAt: "2026-11-01T00:05:00Z",
                path: "src/a.ts",
                line: 12 + i,
                originalLine: 12 + i,
                diffHunk: "@@\n-old\n+new",
                pullRequestReview: { id: "R1" },
              }));
              return ok(
                JSON.stringify([
                  pull("reviewThreads", [
                    {
                      id: "PRRT_9",
                      isResolved: resolvedThreads.includes("PRRT_9"),
                      comments: { totalCount: nodes.length, edges: nodes.map((node, i) => ({ cursor: `edge${i}`, node })) },
                    },
                  ]),
                ]),
              );
            }
          }
          return { out: "", ok: false, missing: false };
        });
      const hooks = {
        gh,
        push: (cwd: string, b: string) => Effect.sync(() => (pushes++, quiet(cwd, "push", "-u", "origin", b))),
        fetch: (cwd: string, b: string) => Effect.sync(() => quiet(cwd, "fetch", bare, b)),
      };
      let ready = false;
      let first = true;
      let release = () => {};
      let handoff = () => Promise.resolve();
      const runtime = scriptedRuntime({
        id: "pi",
        turn: async (turn) => {
          const version = turn.input.includes("版本B") ? "B" : "A";
          writeFileSync(join(turn.options.cwd, "same.ts"), `export const v = '${version}'\n`);
          git(turn.options.cwd, "add", "same.ts");
          git(turn.options.cwd, "-c", "user.name=session", "-c", "user.email=session@vibevalley.test", "commit", "-qm", `version ${version}`);
          if (first) {
            first = false;
            await new Promise<void>((resolve) => {
              release = resolve;
              turn.signal.addEventListener("abort", () => resolve(), { once: true });
              ready = true;
            });
          }
          turn.say(`写版本${version}`);
          await handoff();
        },
      });
      const before = farm({ config, projects: hooks, runtime });
      let id = "";
      let cwd = "";
      return Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const w = yield* watch;
          const issues = yield* Issue;
          const sessions = yield* Session;
          const projects = yield* Project;
          const run = Effect.runPromiseWith(yield* Effect.context());
          handoff = () => run(sessions.report(id, { summary: "ready for review", questions: [], checks: [], remember: [], prSubmit: false }));
          yield* (yield* Agent).save(lab());
          issue = yield* issues.add({ title: "写版本A", project: "clock", agent: "lab" }, explicitMandate("", true));
          yield* issues.start(issue.id, "");
          yield* until(() => ready, "the working branch committed");
          issue = yield* issues.get(issue.id);
          id = latestSessionIdOf(issue)!;
          [branch, cwd] = [sessions.sessionOf(id)!.branch!, sessions.cwdOf(id)!];
          git(work, "init", "--bare", bare);
          git(path, "remote", "add", "origin", "https://github.com/test/clock.git");
          git(path, "remote", "set-url", "--push", "origin", bare);
          const main = git(path, "rev-parse", "main");
          yield* projects.refreshGitHub();
          const running = sessions.runOf(id);
          expect(sessions.sessionOf(id)?.phase._tag).toBe("working");
          yield* issues.submitPullRequest(id);
          expect(sessions.sessionOf(id)?.phase._tag).toBe("working");
          expect(sessions.runOf(id)).toBe(running);
          expect((yield* issues.get(issue.id)).pullRequest?.state).toBe("open");
          release();
          yield* w.nextReport;
          issue = yield* issues.setStatus(issue.id, "done", "", "", owner);
          expect(issue.pullRequest).toMatchObject({
            number: 7,
            state: "open",
            url: "https://github.com/test/clock/pull/7",
          });
          expect(issue.status).toBe("in_review");
          expect(git(path, "rev-parse", "main")).toBe(main);
          expect(git(bare, "rev-parse", branch)).toBe(git(cwd, "rev-parse", "HEAD"));
          yield* issues.setStatus(issue.id, "todo", "再写版本B", "", owner);
          yield* w.nextReport;
          issue = yield* issues.setStatus(issue.id, "done", "", "", owner);
          expect([creates, pushes]).toEqual([1, 3]);
          expect(git(bare, "rev-parse", branch)).toBe(git(cwd, "rev-parse", "HEAD"));
        }).pipe(Effect.scoped, Effect.provide(before.layer));

        const after = farm({ config, projects: hooks });
        yield* Effect.gen(function* () {
          const issues = yield* Issue;
          const sessions = yield* Session;
          yield* (yield* Project).refreshGitHub();
          const restored = yield* issues.get(issue!.id);
          expect(restored.pullRequest?.number).toBe(7);
          const ingress = yield* Ingress;
          yield* ingress.record({
            source: "github",
            key: "clock#7:review:R1",
            actor: { kind: "bot", id: "review-bot[bot]", name: "review-bot[bot]" },
            addressed: "thread_owner",
            threads: [`issue:${restored.id}`, "github:clock#7"],
            text: "review-bot[bot] CHANGES_REQUESTED\nround 1",
            at: 1,
            meta: { project: "clock", pr: 7, kind: "review", botRound: 1, botRoundKey: "review-bot[bot]:review:R1" },
          });
          yield* ingress.refreshGitHub;
          yield* ingress.refreshGitHub;
          const sql = yield* SqlClient.SqlClient;
          const inputs = yield* sql<{ key: string; kind: string; reason: string | null }>`
            select t.source_key as key, t.trigger_json->'meta'->>'kind' as kind, m.reason
            from mailbox_trigger t join mailbox_issue m on m.trigger_id = t.id
            where m.issue_id = ${restored.id} and t.source = 'github'
            order by (t.trigger_json->'meta'->>'botRound') nulls last`;
          expect(inputs.filter((input) => input.kind === "ci")).toHaveLength(1);
          expect(inputs.filter((input) => input.kind === "review").map((input) => input.reason)).toEqual(["human", "human", "human", "budget"]);
          expect(inputs.some((input) => input.key.includes("SELF"))).toBe(false);
          expect((yield* sql<{ n: number }>`select count(*) as n from channel_message where body like '%round 1%'`)[0]?.n).toBe(0);
          const inline = yield* sql<{ data: string }>`
            select payload_json->'data' as data from mailbox_trigger where source_key = 'clock#7:comment:PRRC_9'`;
          expect(JSON.parse(inline[0]?.data ?? "null")).toMatchObject({ path: "src/a.ts", line: 12, diffHunk: "@@\n-old\n+new", threadId: "PRRT_9" });
          const rounds = yield* sql<{ round: number; reason: string }>`select (t.trigger_json->'meta'->>'botRound') as round, m.reason
            from mailbox_trigger t join mailbox_issue m on m.trigger_id = t.id where t.trigger_json->'meta'->>'kind' = 'comment'`;
          expect(rounds).toHaveLength(6);
          expect(rounds.every((row) => row.round === 1 && row.reason === "human")).toBe(true);
          const resource = yield* (yield* Resource).read(id, { uri: "vv://github/clock/pulls/7/thread/9", limit: 16_000 });
          expect(JSON.parse(resource.text)).toMatchObject({ threadId: "PRRT_9", comments: expect.any(Array) });
          expect(JSON.parse(resource.text).comments).toHaveLength(6);
          head = "head-8";
          yield* ingress.refreshGitHub;
          const late = yield* sql<{
            round: number;
          }>`select (trigger_json->'meta'->>'botRound') as round from mailbox_trigger where source_key = 'clock#7:comment:PRRC_15'`;
          expect(late[0]?.round).toBe(1);
          expect(resolvedThreads).toEqual([]);
          conclusion = "SUCCESS";
          yield* ingress.refreshGitHub;
          conclusion = "FAILURE";
          yield* ingress.refreshGitHub;
          expect((yield* sql<{ n: number }>`select count(*) as n from mailbox_trigger where trigger_json->'meta'->>'kind' = 'ci'`)[0]?.n).toBe(4);
          expect(resolvedThreads).toEqual([]);
          const released = (yield* ingress.accept({
            source: "connector",
            key: "owner-review-release",
            actor: { kind: "owner", id: "owner" },
            addressed: "thread_owner",
            threads: ["github:clock#7"],
            text: "处理剩余评审",
            at: 10,
          }))!;
          expect(
            (yield* sql<{ state: string }>`select m.state from mailbox_issue m join mailbox_trigger t on t.id = m.trigger_id
            where m.issue_id = ${restored.id} and t.trigger_json->'meta'->>'kind' = 'review'`).every((row) => row.state === "forwarded"),
          ).toBe(true);
          yield* await_(
            () => sql<{ state: string }>`select state from mailbox_delivery where session_id = ${id} and envelope_id = ${released.id}`,
            (rows) => rows[0]?.state === "consumed",
            "the owner's release consumed",
          );
          yield* until(() => sessions.sessionOf(id)?.phase._tag === "resting", "the review followup waiting for external events");
          state = ending;
          yield* issues.refreshPullRequests;
          const closed = yield* issues.get(issue!.id);
          expect([closed.delivered, closed.canceled]).toEqual(ending === "MERGED" ? ["pull_request", undefined] : [undefined, "dismissed"]);
          expect(sessions.sessionOf(id)).toBeUndefined();
          expect(existsSync(cwd)).toBe(false);
          expect(quiet(path, "show-ref", "--verify", "refs/heads/" + branch)).toBe(false);
        }).pipe(Effect.scoped, Effect.provide(after.layer));
      });
    });
  }
});
