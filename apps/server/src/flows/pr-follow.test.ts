import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { scriptedRuntime, type ScriptedTurn } from "@botiverse/oar/testing";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";

import { latestSessionIdOf } from "@vibevalley/protocol/rules";

import { Agent } from "@/agent/agent.ts";
import { Ingress } from "@/ingress/ingress.ts";
import { explicitMandate } from "@/issue/creation.ts";
import { Issue } from "@/issue/issue.ts";
import { Project } from "@/project/project.ts";
import { Session } from "@/session/session.ts";
import { testConfig } from "@/testing/layers.ts";

import { await_, farm, git, lab, until } from "./farm.ts";

for (const submittedReport of [false, true]) {
  it.live(`regression: an in-flight PR follows CI after ${submittedReport ? "a submission report" : "an ordinary turn"} until explicit handoff`, () => {
    const first = Promise.withResolvers<void>();
    const reviewed = Promise.withResolvers<void>();
    const inputs: string[] = [];
    let background: ReturnType<ScriptedTurn["task"]> | undefined;
    const base = testConfig();
    const config = { ...base, project: { ...base.project, maxSessions: 1 }, github: { ...base.github, prProjects: ["follow"] } };
    const path = join(config.workRoot, "projects", "follow");
    const bare = join(config.workRoot, "origin.git");
    const f = farm({
      config,
      repos: ["follow"],
      projects: {
        gh: (...args) =>
          Effect.sync(() => {
            const ok = (out: string) => ({ out, ok: true, missing: false });
            if (args[0] === "--version") return ok("gh version 2.80.0");
            if (args[0] === "auth") return ok("Logged in to github.com account gardener (keyring)");
            if (args[0] === "repo") return ok('{"viewerPermission":"WRITE"}');
            if (args[0] === "pr" && args[1] === "list") return ok("[]");
            if (args[0] === "pr" && args[1] === "create") return ok("https://github.com/test/follow/pull/1");
            if (args[0] === "pr" && args[1] === "view") return ok('{"state":"OPEN","mergedAt":null}');
            return { out: "", ok: false, missing: false };
          }),
        push: (cwd, branch) =>
          Effect.sync(() => {
            git(cwd, "push", bare, branch);
            return true;
          }),
        fetch: () => Effect.succeed(false),
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
    return Effect.gen(function* () {
      const issues = yield* Issue;
      const sessions = yield* Session;
      const ingress = yield* Ingress;
      const sql = yield* SqlClient.SqlClient;
      yield* (yield* Agent).save(lab());
      git(config.workRoot, "init", "--bare", bare);
      git(path, "remote", "add", "origin", "https://github.com/test/follow.git");
      yield* (yield* Project).refreshGitHub();
      const issue = yield* issues.add({ title: "work", project: "follow", agent: "lab" }, explicitMandate("", true));
      yield* issues.start(issue.id, "");
      const id = latestSessionIdOf(yield* issues.get(issue.id))!;
      yield* until(() => inputs.length === 1, "the implementation committed");
      yield* issues.submitPullRequest(id);
      if (submittedReport) yield* sessions.report(id, { summary: "PR submitted", questions: [], checks: [], remember: [], prSubmit: true });
      first.resolve();
      if (background) {
        yield* until(() => {
          const phase = sessions.sessionOf(id)?.phase;
          return phase?._tag === "working" && phase.doing.action === "wait";
        }, "submission waits for background work");
        expect(sessions.noRoom("pi", "follow")).not.toBe("");
        background.end();
      }
      yield* until(() => sessions.sessionOf(id)?.phase._tag === "resting", "waiting for external review");
      expect((yield* issues.get(issue.id)).stage.state).toBe("working");
      expect((yield* issues.get(issue.id)).status).toBe("in_progress");
      expect(sessions.noRoom("pi", "follow")).toBe("");
      const event = (key: string) => ({
        source: "github" as const,
        key,
        actor: { kind: "ci" as const, id: "checks" },
        addressed: "thread_owner" as const,
        threads: [`issue:${issue.id}`],
        text: key,
        at: 1,
        meta: { kind: "ci" as const, failed: true },
      });
      const ci = (yield* ingress.accept(event("fix-first-ci")))!;
      yield* until(() => inputs.length === 2, "CI automatically woke the helper");
      expect(inputs[1]).toContain("fix-first-ci");
      yield* await_(
        () => sql<{ state: string }>`select state::text from mailbox_delivery where envelope_id = ${ci.id}`,
        (rows) => rows[0]?.state === "consumed",
        "CI entered the model",
      );
      yield* sessions.report(id, { summary: "ready for the owner", questions: [], checks: [], remember: [], prSubmit: false });
      reviewed.resolve();
      yield* until(() => sessions.sessionOf(id)?.phase._tag === "done", "explicit handoff");
      expect((yield* issues.get(issue.id)).stage.state).toBe("reviewing");
      const held = (yield* ingress.accept(event("after-handoff-ci")))!;
      expect((yield* sql<{ state: string }>`select state::text from mailbox_issue where trigger_id = ${held.id}`)[0]?.state).toBe("held");
      expect(inputs).toHaveLength(2);
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          first.resolve();
          reviewed.resolve();
        }),
      ),
      Effect.scoped,
      Effect.provide(f.layer),
    );
  });
}
