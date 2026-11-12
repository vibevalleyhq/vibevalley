import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { scriptedRuntime } from "@botiverse/oar/testing";
import { describe, expect, test } from "vite-plus/test";
import { z } from "zod";

import type * as T from "@vibevalley/protocol";
import { latestSessionIdOf } from "@vibevalley/protocol/rules";

import { user } from "#/base/actor.ts";
import { explicitMandate } from "#/modules/issue/creation.ts";
import { repository } from "#/modules/repo/repository.ts";
import { gitIn } from "#/testing/git.ts";
import { testConfig } from "#/testing/layers.ts";
import { sqlOf } from "#/testing/sql.ts";

import { await_, farm, git, lab, until, watch } from "./farm.ts";

const parsed = (text: string): unknown => JSON.parse(text);

const quiet = (cwd: string, ...args: string[]) => {
  try {
    gitIn(cwd, "-c", "user.name=session", "-c", "user.email=session@vibevalley.test", ...args);
    return true;
  } catch {
    return false;
  }
};

describe("a pull request", () => {
  for (const ending of ["MERGED", "CLOSED", "ACCEPTED", "SUBMITTED"] as const) {
    test(`merges by PR, and closes when the PR is ${ending.toLowerCase()}`, async () => {
      const base = testConfig();
      const config = {
        ...base,
        db: join(base.home, "db"),
        github: { ...base.github, prRepos: ["clock"] },
      };
      const work = config.workRoot;
      const path = join(work, "repos", "clock");
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
        (async () => {
          const ok = (out: string) => ({ out, ok: true, missing: false });
          if (args[0] === "--version") return ok("gh version 2.80.0");
          if (args[0] === "auth") return ok("Logged in to github.com account gardener (keyring)");
          if (args[0] === "repo") return ok(`{"viewerPermission":"WRITE","defaultBranchRef":{"name":"main"}}`);
          if (args[0] === "pr" && args[1] === "list")
            return ok(creates > 0 ? '[{"url":"https://github.com/test/clock/pull/7","number":7,"isCrossRepository":false,"state":"OPEN"}]' : "[]");
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
            if (query.startsWith("query PullChecks("))
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
            if (query.startsWith("query PullReviews("))
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
            if (query.startsWith("query PullComments("))
              return ok(
                JSON.stringify([pull("comments", [{ id: "SELF", author: author("GARDENER"), body: "own", url: "", createdAt: "2026-11-01T00:00:00Z" }])]),
              );
            if (query.startsWith("query PullThreads(")) {
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
        })();
      const hooks = {
        gh,
        publication: {
          tip: () => repository(path).head(),
          fetch: () => Promise.resolve(),
          push: (cwd: string, _url: string, branch: string, sha: string) => {
            pushes++;
            return repository(cwd).push(bare, branch, sha);
          },
        },
        fetch: (cwd: string, b: string) => (async () => quiet(cwd, "fetch", bare, b))(),
      };
      let ready = false;
      let first = true;
      let release: () => void = () => {};
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
      const before = farm({ config, repoHooks: hooks, runtime });
      let id = "";
      let cwd = "";
      {
        await using fw = await before.open();
        {
          const w = watch(fw);
          const issues = fw.issue;
          const sessions = fw.inside;
          const repos = fw.repo;
          handoff = () => sessions.report(id, { summary: "ready for review", questions: [], checks: [], remember: [], prSubmit: false });
          await fw.agent.save(lab());
          issue = await issues.add({ title: "写版本A", repo: "clock", agent: "lab" }, explicitMandate("", true));
          await issues.start(issue.id, "");
          await until(() => ready, "the working branch committed");
          issue = await issues.get(issue.id);
          id = latestSessionIdOf(issue)!;
          [branch, cwd] = [sessions.sessionOf(id)!.branch!, sessions.cwdOf(id)!];
          git(work, "init", "--bare", bare);
          git(path, "remote", "add", "origin", "https://github.com/test/clock.git");
          const main = git(path, "rev-parse", "main");
          await repos.refreshGitHub();
          const running = sessions.runOf(id);
          expect(sessions.sessionOf(id)?.phase._tag).toBe("working");
          if (ending !== "SUBMITTED") await issues.submitPullRequest(id);
          expect(sessions.sessionOf(id)?.phase._tag).toBe("working");
          expect(sessions.runOf(id)).toBe(running);
          expect((await issues.get(issue.id)).pullRequest?.state).toBe(ending === "SUBMITTED" ? undefined : "open");
          if (ending === "ACCEPTED" || ending === "SUBMITTED") await issues.edit(issue.id, { deliver: "pull_request" }, user);
          release();
          await w.nextReport();
          if (ending === "ACCEPTED" || ending === "SUBMITTED") {
            if (ending === "ACCEPTED") writeFileSync(join(cwd, "uncommitted.txt"), "retain this work");
            const accepted = await issues.setStatus(issue.id, "done", "", "", user);
            expect([accepted.status, accepted.delivered, accepted.pullRequest?.state]).toEqual(["done", "submitted", "open"]);
            expect(existsSync(join(cwd, "uncommitted.txt"))).toBe(ending === "ACCEPTED");
            expect(git(path, "rev-parse", "main")).toBe(main);
            state = "MERGED";
            await issues.refreshPullRequests();
            const refreshed = await issues.get(issue.id);
            expect([refreshed.status, refreshed.pullRequest?.state]).toEqual(["done", "merged"]);
            expect(existsSync(join(cwd, "uncommitted.txt"))).toBe(ending === "ACCEPTED");
            return;
          }
          issue = await issues.setStatus(issue.id, "done", "", "", user);
          expect(issue.pullRequest).toMatchObject({
            number: 7,
            state: "open",
            url: "https://github.com/test/clock/pull/7",
          });
          expect(issue.status).toBe("in_review");
          expect(git(path, "rev-parse", "main")).toBe(main);
          expect(git(bare, "rev-parse", branch)).toBe(git(cwd, "rev-parse", "HEAD"));
          await issues.setStatus(issue.id, "todo", "再写版本B", "", user);
          await w.nextReport();
          issue = await issues.setStatus(issue.id, "done", "", "", user);
          expect([creates, pushes]).toEqual([1, 3]);
          const chat = fw.channel;
          const thread = await chat.issueThread(issue.id, issue.title);
          expect(
            (await chat.history(thread)).filter((message) => message.kind === "notice" && message.text.includes("https://github.com/test/clock/pull/7")),
          ).toHaveLength(1);
          expect(git(bare, "rev-parse", branch)).toBe(git(cwd, "rev-parse", "HEAD"));
        }
      }

      const after = farm({ config, repoHooks: hooks });
      {
        await using fw = await after.open();
        const issues = fw.issue;
        const sessions = fw.inside;
        await fw.repo.refreshGitHub();
        const restored = await issues.get(issue.id);
        expect(restored.pullRequest?.number).toBe(7);
        const mailbox = fw.inside;
        await mailbox.record({
          source: "github",
          key: "clock#7:review:R1",
          actor: { kind: "system", id: "review-bot[bot]", name: "review-bot[bot]" },
          addressed: "thread_owner",
          threads: [`issue:${restored.id}`, "github:clock#7"],
          text: "review-bot[bot] CHANGES_REQUESTED\nround 1",
          at: 1,
          meta: { repo: "clock", pr: 7, kind: "review", botRound: 1, botRoundKey: "review-bot[bot]:review:R1" },
        });
        await issues.pollGitHub();
        await issues.pollGitHub();
        const sql = sqlOf(fw.db);
        const inputs = await sql<{ key: string; kind: string; reason: string | null }>`
            select t.source_key as key, t.trigger_json::jsonb->'meta'->>'kind' as kind, m.reason
            from session_trigger t join session_issue_input m on m.trigger_id = t.id
            where m.issue_id = ${restored.id} and t.source = 'github'
            order by (t.trigger_json::jsonb->'meta'->>'botRound')::int nulls last`;
        expect(inputs.filter((input) => input.kind === "ci")).toHaveLength(1);
        expect(inputs.filter((input) => input.kind === "review").map((input) => input.reason)).toEqual(["human", "human", "human", "budget"]);
        expect(inputs.some((input) => input.key.includes("SELF"))).toBe(false);
        expect((await sql<{ n: number }>`select count(*) as n from channel_message where body like '%round 1%'`)[0]?.n).toBe(0);
        const inline = await sql<{ data: string }>`
            select (payload_json::jsonb->'data')::text as data from session_trigger where source_key = 'clock#7:comment:PRRC_9'`;
        const inlineData = await parsed(inline[0]?.data ?? "null");
        expect(inlineData).toMatchObject({ path: "src/a.ts", line: 12, diffHunk: "@@\n-old\n+new", threadId: "PRRT_9" });
        const rounds = await sql<{ round: number; reason: string }>`select (t.trigger_json::jsonb->'meta'->>'botRound')::int as round, m.reason
            from session_trigger t join session_issue_input m on m.trigger_id = t.id where t.trigger_json::jsonb->'meta'->>'kind' = 'comment'`;
        expect(rounds).toHaveLength(6);
        expect(rounds.every((row) => row.round === 1 && row.reason === "human")).toBe(true);
        const resource = await fw.tool.readResource(id, { uri: "vv://github/clock/pulls/7/thread/9", limit: 16_000 });
        const thread = z.object({ threadId: z.string(), comments: z.array(z.unknown()) }).parse(JSON.parse(resource.text));
        expect(thread.threadId).toBe("PRRT_9");
        expect(thread.comments).toHaveLength(6);
        head = "head-8";
        await issues.pollGitHub();
        const late = await sql<{
          round: number;
        }>`select (trigger_json::jsonb->'meta'->>'botRound')::int as round from session_trigger where source_key = 'clock#7:comment:PRRC_15'`;
        expect(late[0]?.round).toBe(1);
        expect(resolvedThreads).toEqual([]);
        conclusion = "SUCCESS";
        await issues.pollGitHub();
        conclusion = "FAILURE";
        await issues.pollGitHub();
        expect((await sql<{ n: number }>`select count(*) as n from session_trigger where trigger_json::jsonb->'meta'->>'kind' = 'ci'`)[0]?.n).toBe(4);
        expect(resolvedThreads).toEqual([]);
        const released = (await mailbox.accept({
          source: "connector",
          key: "user-review-release",
          actor: { kind: "user", id: "user" },
          addressed: "thread_owner",
          threads: ["github:clock#7"],
          text: "处理剩余评审",
          at: 10,
        }))!;
        expect(
          (
            await sql<{ state: string }>`select m.state from session_issue_input m join session_trigger t on t.id = m.trigger_id
            where m.issue_id = ${restored.id} and t.trigger_json::jsonb->'meta'->>'kind' = 'review'`
          ).every((row) => row.state === "forwarded"),
        ).toBe(true);
        await await_(
          () => sql<{ state: string }>`select state from session_delivery where session_id = ${id} and envelope_id = ${released.id}`,
          (rows) => rows[0]?.state === "consumed",
          "the user's release consumed",
        );
        await until(() => sessions.sessionOf(id)?.phase._tag === "resting", "the review followup waiting for external events");
        state = ending;
        await issues.refreshPullRequests();
        const closed = await issues.get(issue.id);
        expect([closed.delivered, closed.canceled]).toEqual(ending === "MERGED" ? ["pull_request", undefined] : [undefined, "dismissed"]);
        expect(sessions.sessionOf(id)).toBeUndefined();
        expect(existsSync(cwd)).toBe(false);
        expect(quiet(path, "show-ref", "--verify", "refs/heads/" + branch)).toBe(false);
      }
    });
  }
});
