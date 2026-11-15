import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { defaultOrchestrator } from "@vibevalley/protocol";
import { tempDir } from "@vibevalley/testkit/temp";

import { keptLog } from "#/infra/log.ts";
import { wallTime } from "#/infra/time.ts";
import { GitError, run } from "#/modules/repo/git.ts";
import { type GitHubRun, makeRepo } from "#/modules/repo/repo.ts";
import { repository } from "#/modules/repo/repository.ts";
import { type TriggerInput, triggerOf } from "#/modules/session/payload.ts";
import { allOpenDeliveries } from "#/testing/deliveries.ts";
import { gitSync, repo, reposDir, write } from "#/testing/git.ts";
import { testConfig, testDb } from "#/testing/layers.ts";
import { moduleWorld, testIssues } from "#/testing/world.ts";
import * as q from "#db/pull.sql.ts";
import * as qe from "#db/pull_event.sql.ts";

import { actionsJobOf, checksVerdict, makePull, type PullHooks } from "./pull.ts";
import { makePullStore } from "./store.ts";

const gh =
  (answer: (args: string[]) => { out: string; ok?: boolean; missing?: boolean }): GitHubRun =>
  (...args) =>
    Promise.resolve().then(() => ({
      ok: true,
      missing: false,
      ...(args.includes("defaultBranchRef")
        ? { out: '{"defaultBranchRef":{"name":"main"}}' }
        : args[0] === "auth" && args.length === 4
          ? { out: "logged in" }
          : answer(args)),
    }));

const thrown = (work: Promise<unknown>): Promise<Error> =>
  work.then(
    () => expect.unreachable("it went through"),
    (e: unknown) => (e instanceof Error ? e : expect.unreachable(String(e))),
  );

const check = (status: string, conclusion = "") => ({ name: status + conclusion, status, conclusion });

describe("Pull", () => {
  test("finds the Actions job in a check's URL, and none elsewhere", () => {
    expect(actionsJobOf("https://github.com/o/r/actions/runs/1/job/127709499860")).toBe("127709499860");
    expect(actionsJobOf("https://example.test/checks/1")).toBe("");
  });

  test("a pull request's checks: the failed ones, and whether all have finished", () => {
    expect(checksVerdict([])).toEqual({ failed: [], finished: false });
    expect(checksVerdict([check("IN_PROGRESS"), check("COMPLETED", "SUCCESS")])).toEqual({ failed: [], finished: false });
    expect(checksVerdict([check("COMPLETED", "SUCCESS"), check("success")])).toEqual({ failed: [], finished: true });
    const failed = check("COMPLETED", "failure");
    expect(checksVerdict([failed, check("QUEUED")])).toEqual({ failed: [failed], finished: false });
    expect(checksVerdict([check("TIMED_OUT")]).failed).toHaveLength(1);
  });

  test("closing an issue's active open PR promotes its remaining open PR identically to a reload", async () => {
    await using w = await moduleWorld();
    const issue = await testIssues(w.issue).add({ title: "Multi PR" });
    const store = await makePullStore(w.db);
    await w.db.tx(() =>
      store.upsertInTx({
        platform: "github",
        repo: "team/app",
        number: 10,
        url: "https://github.com/team/app/pull/10",
        branch: "vibevalley/issue-1-a",
        base: "main",
        state: "open",
        issueId: issue.id,
        at: 100,
      }),
    );
    const newer = await w.db.tx(() =>
      store.upsertInTx({
        platform: "github",
        repo: "team/app",
        number: 11,
        url: "https://github.com/team/app/pull/11",
        branch: "vibevalley/issue-1-b",
        base: "main",
        state: "open",
        issueId: issue.id,
        at: 200,
      }),
    );
    expect(store.ofIssue(issue.id)).toEqual({ url: "https://github.com/team/app/pull/11", number: 11, state: "open" });

    await w.db.tx(() => store.setStateInTx(newer.id, "closed", 300));
    expect(store.ofIssue(issue.id)).toEqual({ url: "https://github.com/team/app/pull/10", number: 10, state: "open" });

    const reloaded = await makePullStore(w.db);
    expect(reloaded.ofIssue(issue.id)).toEqual(store.ofIssue(issue.id));
  });

  test("standalone PR publication persists with issue_id = null, reloads, and refreshes state without any Issue service", async () => {
    const dir = tempDir("standalone-pull-");
    const cwd = join(dir, "checkout");
    const bare = join(dir, "origin.git");
    repo(cwd, 1, 0);
    gitSync(cwd, "clone", "--bare", cwd, bare);
    gitSync(cwd, "checkout", "-b", "feat/standalone");
    write(join(cwd, "feature.ts"), "export const ok = true;\n");
    gitSync(cwd, "add", ".");
    gitSync(cwd, "commit", "-m", "standalone feature");
    gitSync(cwd, "remote", "add", "origin", "https://github.com/team/standalone.git");

    let remoteState = "OPEN";
    const hooks: PullHooks = {
      gh: gh((args) => {
        if (args[1] === "list") return { out: "[]" };
        if (args[1] === "create") return { out: "https://github.com/team/standalone/pull/12" };
        if (args[1] === "view") return { out: JSON.stringify({ state: remoteState, mergedAt: remoteState === "MERGED" ? "2026-11-16T00:00:00Z" : null }) };
        return { out: "" };
      }),
      publication: {
        tip: (_cwd, _url, branch) => repository(bare).tip(branch),
        fetch: (path, _url, branch) => repository(path).fetch(bare, branch),
        push: (path, _url, branch, sha) => repository(path).push(bare, branch, sha),
      },
    };

    const config = testConfig({ workRoot: join(dir, "space") });
    await using db = await testDb();
    const repos = await makeRepo({ config, clock: wallTime, log: keptLog() });
    try {
      const first = await makePull({ config, clock: wallTime, log: keptLog(), db, repo: repos }, hooks);
      const published = await first.publish({
        cwd,
        branch: "feat/standalone",
        sha: gitSync(cwd, "rev-parse", "HEAD"),
        base: "main",
        title: "Standalone PR",
        body: "Published without an Issue",
      });
      expect(published).toMatchObject({
        platform: "github",
        repository: "team/standalone",
        number: 12,
        url: "https://github.com/team/standalone/pull/12",
        pushed: true,
      });
      expect(first.find("team/standalone", 12)).toMatchObject({
        platform: "github",
        repo: "team/standalone",
        number: 12,
        state: "open",
      });
      expect(first.find("team/standalone", 12)?.issueId).toBeUndefined();
      const stored = await q.getPullByRepoNumber(db.sql, { repo: "team/standalone", number: 12 });
      expect(stored?.issue_id).toBeNull();
      expect(stored?.state).toBe("open");
      await first.close();

      const reloaded = await makePull({ config, clock: wallTime, log: keptLog(), db, repo: repos }, hooks);
      expect(reloaded.find("team/standalone", 12)?.state).toBe("open");
      remoteState = "MERGED";
      await reloaded.refresh();
      expect(reloaded.find("team/standalone", 12)?.state).toBe("merged");
      expect((await q.getPullByRepoNumber(db.sql, { repo: "team/standalone", number: 12 }))?.state).toBe("merged");
      await reloaded.close();
    } finally {
      await repos.close();
    }
  });

  test("regression: GitHub snapshots read all collection pages and overflowing review threads", async () => {
    const root = reposDir();
    let failReviews = false;
    const author = (login: string) => ({ login, __typename: login.endsWith("[bot]") ? "Bot" : "User" });
    const inline = Array.from({ length: 101 }, (_, i) => ({
      id: `I${i}`,
      fullDatabaseId: String(2_147_483_657 + i),
      author: author("bob"),
      body: `inline ${i}`,
      url: `https://comments/${i}`,
      createdAt: "2026-11-01T00:02:00Z",
      path: "src/a.ts",
      line: i + 1,
      originalLine: i + 1,
      diffHunk: "@@\n-old\n+new",
      pullRequestReview: { id: "R1" },
    }));
    const pullNode = (key: string, nodes: unknown[]) => ({ data: { repository: { pullRequest: { [key]: { nodes } } } } });
    repo(join(root, "sample"), 1, 0);
    gitSync(join(root, "sample"), "remote", "add", "origin", "https://github.com/test/sample.git");

    const config = testConfig({ workRoot: dirname(root) });
    await using db = await testDb();
    const repos = await makeRepo({ config, clock: wallTime, log: keptLog() });
    const pull = await makePull(
      { config, clock: wallTime, log: keptLog(), db, repo: repos },
      {
        gh: gh((args) => {
          if (args[0] === "pr") return { out: JSON.stringify({ headRefOid: "abc" }) };
          if (args[1] === "user") return { out: JSON.stringify({ login: "gardener" }) };
          expect(args).toContain("--paginate");
          expect(args).toContain("--slurp");
          const query = args.find((arg) => arg.startsWith("query="))?.slice(6) ?? "";
          expect(query).not.toContain("databaseId");
          if (query.startsWith("query PullChecks("))
            return {
              out: JSON.stringify([
                {
                  data: {
                    repository: {
                      object: {
                        statusCheckRollup: {
                          contexts: {
                            nodes: [{ __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: "https://checks/1" }],
                          },
                        },
                      },
                    },
                  },
                },
                {
                  data: {
                    repository: {
                      object: {
                        statusCheckRollup: {
                          contexts: { nodes: [{ __typename: "StatusContext", context: "legacy", state: "SUCCESS", targetUrl: "https://checks/2" }] },
                        },
                      },
                    },
                  },
                },
              ]),
            };
          if (query.startsWith("query PullReviews("))
            return failReviews
              ? { out: "not available", ok: false }
              : {
                  out: JSON.stringify(
                    [1, 2].map((i) =>
                      pullNode("reviews", [
                        {
                          id: `R${i}`,
                          author: author("review-bot[bot]"),
                          state: "CHANGES_REQUESTED",
                          body: "fix it",
                          submittedAt: "2026-11-01T00:00:00Z",
                        },
                      ]),
                    ),
                  ),
                };
          if (query.startsWith("query PullComments("))
            return {
              out: JSON.stringify(
                [1, 2].map((i) =>
                  pullNode("comments", [
                    {
                      id: `C${i}`,
                      author: author("alice"),
                      body: "general",
                      url: `https://comments/${i}`,
                      createdAt: "2026-11-01T00:01:00Z",
                    },
                  ]),
                ),
              ),
            };
          if (query.startsWith("query PullThreads("))
            return {
              out: JSON.stringify([
                pullNode("reviewThreads", [
                  {
                    id: "PRRT_9",
                    isResolved: false,
                    comments: { totalCount: 101, edges: inline.slice(0, 100).map((node, i) => ({ cursor: `edge${i}`, node })) },
                  },
                ]),
                pullNode("reviewThreads", [
                  { id: "PRRT_second", isResolved: true, comments: { totalCount: 1, edges: [{ cursor: "last", node: { ...inline[0], id: "SECOND" } }] } },
                ]),
              ]),
            };
          expect(query.startsWith("query PullThreadComments(")).toBe(true);
          expect(args).toContain("id=PRRT_9");
          expect(args).toContain("endCursor=edge99");
          return { out: JSON.stringify([{ data: { node: { comments: { nodes: [inline[100]] } } } }]) };
        }),
      },
    );
    try {
      const snapshot = await pull.snapshot("sample", 7);
      expect(snapshot.viewer).toBe("gardener");
      expect(snapshot.checks).toEqual([
        { name: "test", status: "COMPLETED", conclusion: "FAILURE", url: "https://checks/1" },
        { name: "legacy", status: "SUCCESS", conclusion: "", url: "https://checks/2" },
      ]);
      expect(snapshot.reviews.map((review) => review.id)).toEqual(["R1", "R2"]);
      expect(snapshot.comments).toHaveLength(104);
      expect(snapshot.comments.find((comment) => comment.id === "I100")).toMatchObject({
        databaseId: "2147483757",
        line: 101,
        threadId: "PRRT_9",
        reviewId: "R1",
        diffHunk: "@@\n-old\n+new",
      });
      expect(snapshot.comments.find((comment) => comment.id === "SECOND")).toMatchObject({ threadId: "PRRT_second", resolved: true });
      failReviews = true;
      expect((await thrown(pull.snapshot("sample", 7))).name).toBe("RepoError");
    } finally {
      await pull.close();
      await repos.close();
    }
  });

  test("a pull request: the check first, then the push, and one already open is found again", async () => {
    let pushes = 0;
    let calls = 0;
    let pushFails = true;
    await using w = await moduleWorld({
      repos: ["sample"],
      pullHooks: {
        command: (file, args, options) => run("sh", [file, ...args], options),
        publication: {
          tip: (cwd) => repository(cwd).tip("main"),
          fetch: () => Promise.resolve(),
          push: () => {
            pushes++;
            return pushFails ? Promise.reject(GitError.of(1, "push refused")) : Promise.resolve();
          },
        },
        gh: gh((args) => {
          calls++;
          expect(args.slice(0, 2)).toEqual(["pr", "list"]);
          return { out: `[{"url":"https://github.com/test/sample/pull/4","number":4,"isCrossRepository":false,"state":"OPEN"}]` };
        }),
      },
    });
    const issue = await testIssues(w.issue).add({ title: "sample", repo: "sample" });
    const place = await w.repo.checkout({ repo: "sample", issue: issue.number, worktree: true, base: "" });
    gitSync(join(w.repo.root, "sample"), "remote", "add", "origin", "https://github.com/test/sample.git");
    mkdirSync(join(place.cwd, ".vibevalley"));
    const checkFile = join(place.cwd, ".vibevalley/check");
    write(checkFile, "#!/bin/sh\necho check-failed\nexit 1\n", 0o755);
    gitSync(place.cwd, "add", ".vibevalley/check");
    gitSync(place.cwd, "commit", "-qm", "check");
    await thrown(w.pull.submitForIssue(place, issue, "done"));
    expect([pushes, calls]).toEqual([0, 0]);
    write(checkFile, "#!/bin/sh\nprintf changed > generated.ts\nexit 0\n", 0o755);
    gitSync(place.cwd, "commit", "-qam", "check again");
    await thrown(w.pull.submitForIssue(place, issue, "done"));
    expect([pushes, calls]).toEqual([0, 0]);
    write(checkFile, "#!/bin/sh\nexit 0\n", 0o755);
    gitSync(place.cwd, "commit", "-qam", "passing check");
    await thrown(w.pull.submitForIssue(place, issue, "done"));
    expect(calls).toBe(0);
    gitSync(place.cwd, "clean", "-fd");
    pushFails = false;
    expect((await w.pull.submitForIssue(place, issue, "done")).number).toBe(4);
    expect(calls).toBe(1);
    expect((await w.issue.get(issue.id)).pullRequest).toEqual({
      url: "https://github.com/test/sample/pull/4",
      number: 4,
      state: "open",
    });
  });

  test("an answer from gh that is not the shape asked for is refused, not taken as a pull request", async () => {
    await using w = await moduleWorld({
      repos: ["sample"],
      pullHooks: {
        publication: { tip: (cwd) => repository(cwd).tip("main"), fetch: () => Promise.resolve(), push: () => Promise.resolve() },
        gh: gh((args) => ({ out: args[1] === "list" ? `[{"html_url":"https://github.com/test/sample/pull/4"}]` : "null" })),
      },
    });
    const issue = await testIssues(w.issue).add({ title: "sample", repo: "sample" });
    const place = await w.repo.checkout({ repo: "sample", issue: issue.number, worktree: true, base: "" });
    gitSync(join(w.repo.root, "sample"), "remote", "add", "origin", "https://github.com/test/sample.git");
    expect((await thrown(w.pull.submitForIssue(place, issue, "done"))).message).toContain("已推送");
    expect((await thrown(w.pull.pullRequestState("sample", 3))).message).toBe("无法读取 PR #3 状态");
  });

  test("the pull request's body says whether the check ran", async () => {
    for (const hasCheck of [false, true]) {
      let body = "";
      await using w = await moduleWorld({
        repos: ["sample"],
        pullHooks: {
          command: (file, args, options) => run("sh", [file, ...args], options),
          publication: { tip: (cwd) => repository(cwd).tip("main"), fetch: () => Promise.resolve(), push: () => Promise.resolve() },
          gh: gh((args) => {
            if (args[1] === "list") return { out: "[]" };
            body = args.at(-1) ?? "";
            return { out: "https://github.com/test/sample/pull/1" };
          }),
        },
      });
      const issue = await testIssues(w.issue).add({ title: "sample", repo: "sample" });
      const place = await w.repo.checkout({ repo: "sample", issue: issue.number, worktree: true, base: "" });
      gitSync(join(w.repo.root, "sample"), "remote", "add", "origin", "https://github.com/test/sample.git");
      if (hasCheck) {
        mkdirSync(join(place.cwd, ".vibevalley"));
        write(join(place.cwd, ".vibevalley/check"), "#!/bin/sh\nexit 0\n", 0o755);
        gitSync(place.cwd, "add", ".vibevalley/check");
        gitSync(place.cwd, "commit", "-qm", "check");
      }
      await w.pull.submitForIssue(place, issue, "done");
      expect(body).toBe("工单 #1\n\ndone\n\n" + (hasCheck ? ".vibevalley/check 通过。" : "这个仓库没有 .vibevalley/check，没跑检查。"));
    }
  });

  test("the helper's own title and body, left in the worktree's git directory, open the pull request", async () => {
    let args: string[] = [];
    await using w = await moduleWorld({
      repos: ["sample"],
      pullHooks: {
        publication: { tip: (cwd) => repository(cwd).tip("main"), fetch: () => Promise.resolve(), push: () => Promise.resolve() },
        gh: gh((given) => {
          if (given[1] === "list") return { out: "[]" };
          args = given;
          return { out: "https://github.com/test/sample/pull/1" };
        }),
      },
    });
    const issue = await testIssues(w.issue).add({ title: "看板不乱了", repo: "sample" });
    const place = await w.repo.checkout({ repo: "sample", issue: issue.number, worktree: true, base: "" });
    gitSync(join(w.repo.root, "sample"), "remote", "add", "origin", "https://github.com/test/sample.git");
    const file = gitSync(place.cwd, "rev-parse", "--path-format=absolute", "--git-path", "vibevalley-pr.md").trim();
    writeFileSync(file, "# The board keeps its order\n\n## What changed\n\nIt does.\n");
    await w.pull.submitForIssue(place, issue, "done");
    expect(args.slice(args.indexOf("--title"))).toEqual(["--title", "The board keeps its order", "--body", "## What changed\n\nIt does."]);
    expect(gitSync(place.cwd, "status", "--porcelain").trim()).toBe("");
  });

  test("regression: a GitHub event kept twice keeps its first bot round", async () => {
    await using db = await testDb();
    const row = await q.upsertPull(db.sql, {
      id: "pull-1",
      platform: "github",
      repo: "repo",
      number: 7,
      url: "https://github.com/team/repo/pull/7",
      branch: "feat/x",
      base: "main",
      state: "open",
      issue_id: null,
      created_at: 1,
      updated_at: 1,
    });
    await qe.keepPullEvent(db.sql, { pull_id: row!.id, key: "review:R1", bot_round_key: "round-1", bot_round: 1 });
    await qe.keepPullEvent(db.sql, { pull_id: row!.id, key: "review:R1", bot_round_key: "round-2", bot_round: 2 });
    expect(await qe.knownPullEvents(db.sql, { pull_id: row!.id })).toEqual([{ key: "review:R1", bot_round_key: "round-1", bot_round: 1 }]);
  });

  test("regression: the pull check cursor and Mailbox trigger share commit and rollback without routing", async () => {
    const review: TriggerInput = {
      source: "github",
      key: "repo#7:review:42",
      actor: { kind: "system", id: "reviewer" },
      text: "original review",
      data: { detail: "original" },
      threads: ["github:repo#7"],
      addressed: "thread_owner",
      meta: { repo: "repo", pr: 7, botRound: 1, botRoundKey: "round-1" },
      at: 10,
    };
    await using farm = await moduleWorld();
    const { inside: mailbox, db, core } = farm;
    const state = core.state();
    const row = (await q.upsertPull(db.sql, {
      id: "pull-cursor",
      platform: "github",
      repo: "repo",
      number: 7,
      url: "https://github.com/team/repo/pull/7",
      branch: "feat/x",
      base: "main",
      state: "open",
      issue_id: null,
      created_at: 1,
      updated_at: 1,
    }))!;
    const id = triggerOf(review).id;
    const write = async () => {
      await q.observePullChecks(db.sql, { id: row.id, check_fingerprint: "changed", check_revision: 1, updated_at: 2 });
      return mailbox.recordTrigger(review);
    };
    const rolledBack = await db
      .tx(async () => {
        await write();
        throw new Error("rollback");
      })
      .then(
        () => "committed",
        () => "failed",
      );
    expect(rolledBack).toBe("failed");
    expect(await mailbox.readTrigger(id)).toBeUndefined();
    expect((await q.getPull(db.sql, { id: row.id }))?.check_revision).toBe(0);
    const trigger = await db.tx(write);
    expect((await q.getPull(db.sql, { id: row.id }))?.check_revision).toBe(1);
    expect((await mailbox.readTrigger(id))?.trigger).toEqual(trigger);
    expect(await mailbox.isRouted(id)).toBe(false);
    expect(await allOpenDeliveries(db)).toEqual([]);
    expect(mailbox.deliveriesOf(defaultOrchestrator)).toEqual([]);
    expect(core.state()).toBe(state);
  });
});
