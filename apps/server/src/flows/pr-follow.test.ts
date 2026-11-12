import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { scriptedRuntime, type ScriptedTurn } from "@botiverse/oar/testing";
import { expect, test } from "vite-plus/test";

import { latestSessionIdOf } from "@vibevalley/protocol/rules";

import { explicitMandate } from "#/modules/issue/creation.ts";
import { repository } from "#/modules/repo/repository.ts";
import { testConfig } from "#/testing/layers.ts";
import { sqlOf } from "#/testing/sql.ts";

import { await_, farm, git, lab, until } from "./farm.ts";

for (const submittedReport of [false, true]) {
  test(`regression: an in-flight PR follows CI after ${submittedReport ? "a submission report" : "an ordinary turn"} until explicit handoff`, async () => {
    const first = Promise.withResolvers<void>();
    const reviewed = Promise.withResolvers<void>();
    const inputs: string[] = [];
    let background: ReturnType<ScriptedTurn["task"]> | undefined;
    const base = testConfig();
    const config = { ...base, repo: { ...base.repo, maxSessions: 1 }, github: { ...base.github, prRepos: ["follow"] } };
    const path = join(config.workRoot, "repos", "follow");
    const bare = join(config.workRoot, "origin.git");
    const f = farm({
      config,
      repos: ["follow"],
      repoHooks: {
        gh: (...args) =>
          (async () => {
            const ok = (out: string) => ({ out, ok: true, missing: false });
            if (args[0] === "--version") return ok("gh version 2.80.0");
            if (args[0] === "auth") return ok("Logged in to github.com account gardener (keyring)");
            if (args[0] === "repo") return ok('{"viewerPermission":"WRITE","defaultBranchRef":{"name":"main"}}');
            if (args[0] === "pr" && args[1] === "list") return ok("[]");
            if (args[0] === "pr" && args[1] === "create") return ok("https://github.com/test/follow/pull/1");
            if (args[0] === "pr" && args[1] === "view") return ok('{"state":"OPEN","mergedAt":null}');
            return { out: "", ok: false, missing: false };
          })(),
        publication: {
          tip: () => repository(path).head(),
          fetch: () => Promise.resolve(),
          push: (cwd, _url, branch, sha) => repository(cwd).push(bare, branch, sha),
        },
        fetch: () => Promise.resolve(false),
      },
      runtime: scriptedRuntime({
        id: "pi",
        turn: async (turn) => {
          inputs.push(turn.input);
          if (inputs.length === 1) {
            if (submittedReport) background = turn.task({ taskType: "shell", background: true, description: "finish build" });
            writeFileSync(join(turn.options.cwd, "implementation.txt"), "implemented");
            git(turn.options.cwd, "add", ".");
            git(turn.options.cwd, "commit", "-m", "Implement work");
            await first.promise;
          } else await reviewed.promise;
          turn.say("ready");
        },
      }),
    });
    await using fw = await f.open();
    try {
      const issues = fw.issue;
      const sessions = fw.inside;
      const mailbox = fw.inside;
      const sql = sqlOf(fw.db);
      await fw.agent.save(lab());
      git(config.workRoot, "init", "--bare", bare);
      git(path, "remote", "add", "origin", "https://github.com/test/follow.git");
      await fw.repo.refreshGitHub();
      const issue = await issues.add({ title: "work", repo: "follow", agent: "lab" }, explicitMandate("", true));
      await issues.start(issue.id, "");
      const issue2 = await issues.get(issue.id);
      const id = latestSessionIdOf(issue2)!;
      await until(() => inputs.length === 1, "the implementation committed");
      await issues.submitPullRequest(id);
      if (submittedReport) await sessions.report(id, { summary: "PR submitted", questions: [], checks: [], remember: [], prSubmit: true });
      first.resolve();
      if (background) {
        await until(() => {
          const phase = sessions.sessionOf(id)?.phase;
          return phase?._tag === "working" && phase.doing.action === "wait";
        }, "submission waits for background work");
        expect(sessions.noRoom("pi", "follow")).not.toBe("");
        background.end();
      }
      await until(() => sessions.sessionOf(id)?.phase._tag === "resting", "waiting for external review");
      expect((await issues.get(issue.id)).stage.state).toBe("working");
      expect((await issues.get(issue.id)).status).toBe("in_progress");
      expect(sessions.noRoom("pi", "follow")).toBe("");
      const event = (key: string) => ({
        source: "github" as const,
        key,
        actor: { kind: "system" as const, id: "checks" },
        addressed: "thread_owner" as const,
        threads: [`issue:${issue.id}`],
        text: key,
        at: 1,
        meta: { kind: "ci" as const, failed: true },
      });
      const ci = (await mailbox.accept(event("fix-first-ci")))!;
      await until(() => inputs.length === 2, "CI automatically woke the helper");
      expect(inputs[1]).toContain("fix-first-ci");
      await await_(
        () => sql<{ state: string }>`select state from session_delivery where envelope_id = ${ci.id}`,
        (rows) => rows[0]?.state === "consumed",
        "CI entered the model",
      );
      await sessions.report(id, { summary: "ready for the user", questions: [], checks: [], remember: [], prSubmit: false });
      reviewed.resolve();
      await until(() => sessions.sessionOf(id)?.phase._tag === "done", "explicit handoff");
      expect((await issues.get(issue.id)).stage.state).toBe("reviewing");
      const held = (await mailbox.accept(event("after-handoff-ci")))!;
      expect((await sql<{ state: string }>`select state from session_issue_input where trigger_id = ${held.id}`)[0]?.state).toBe("held");
      expect(inputs).toHaveLength(2);
    } finally {
      first.resolve();
      reviewed.resolve();
    }
  });
}
