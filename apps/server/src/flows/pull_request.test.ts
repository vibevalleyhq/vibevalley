import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import type { Issue } from "@vibevalley/protocol";
import { Effect } from "effect";
import { Agents } from "../agent/agent.ts";
import { Issues } from "../issue/issue.ts";
import { Projects } from "../project/project.ts";
import { Sessions, type SessionsInside } from "../session/session.ts";
import { testConfig } from "../testing/layers.ts";
import { farm, git, lab, watch } from "./farm.ts";

const quiet = (cwd: string, ...args: string[]) => {
  try {
    execFileSync("git", ["-c", "user.name=session", "-c", "user.email=session@vibevalley.test", ...args], { cwd, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

describe("a pull request", () => {
  // In a project that harvests by pull request, done pushes the branch and opens one; the issue waits in review. A second
  // round only pushes. After a restart the PR is still the issue's; once GitHub merges or closes it, the issue closes and
  // its helper, worktree and branch go.
  for (const ending of ["MERGED", "CLOSED"] as const) {
    it.live(`harvests, and closes when the PR is ${ending.toLowerCase()}`, () => {
      const base = testConfig();
      const config = { ...base, db: join(base.home, "db"), github: { ...base.github, prProjects: ["clock"] } };
      const work = config.workRoot;
      const path = join(work, "projects", "clock");
      const bare = join(work, "origin.git");
      let creates = 0;
      let pushes = 0;
      let state = "OPEN";
      let issue: Issue | undefined;
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
          if (args[0] === "pr" && args[1] === "view") return ok(JSON.stringify({ state, mergedAt: null }));
          return { out: "", ok: false, missing: false };
        });
      const hooks = {
        gh,
        push: (cwd: string, b: string) => Effect.sync(() => (pushes++, quiet(cwd, "push", "-u", "origin", b))),
        fetch: (cwd: string, b: string) => Effect.sync(() => quiet(cwd, "fetch", bare, b)),
      };
      const before = farm({ config, projects: hooks });
      let id = "";
      let cwd = "";
      return Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const w = yield* watch;
          const issues = yield* Issues;
          const sessions = yield* Sessions;
          const projects = yield* Projects;
          yield* (yield* Agents).saveAgent(lab());
          issue = yield* issues.add({ title: "写版本A", project: "clock", assignee: "lab" });
          yield* issues.start(issue.id, "");
          yield* w.nextReport;
          issue = yield* issues.get(issue.id);
          id = issue.sessions!.at(-1)!;
          const place = (sessions as SessionsInside).place(id)!;
          [branch, cwd] = [place.branch!, place.cwd];
          git(work, "init", "--bare", bare);
          git(path, "remote", "add", "origin", "https://github.com/test/clock.git");
          git(path, "remote", "set-url", "--push", "origin", bare);
          const main = git(path, "rev-parse", "main");
          yield* projects.refreshGitHub();
          issue = yield* issues.setStatus(issue.id, "done", "", "");
          expect(issue.pullRequest).toMatchObject({ number: 7, state: "open", url: "https://github.com/test/clock/pull/7" });
          expect(issue.status).toBe("in_review");
          expect(git(path, "rev-parse", "main")).toBe(main);
          expect(git(bare, "rev-parse", branch)).toBe(git(cwd, "rev-parse", "HEAD"));
          yield* issues.setStatus(issue.id, "todo", "再写版本B", "");
          yield* w.nextReport;
          issue = yield* issues.setStatus(issue.id, "done", "", "");
          expect([creates, pushes]).toEqual([1, 2]);
          expect(git(bare, "rev-parse", branch)).toBe(git(cwd, "rev-parse", "HEAD"));
        }).pipe(Effect.scoped, Effect.provide(before.layer));

        const after = farm({ config, projects: hooks });
        yield* Effect.gen(function* () {
          const issues = yield* Issues;
          const sessions = yield* Sessions;
          yield* (yield* Projects).refreshGitHub();
          const restored = yield* issues.get(issue!.id);
          expect(restored.pullRequest?.number).toBe(7);
          state = ending;
          yield* issues.refreshPullRequests;
          const closed = yield* issues.get(issue!.id);
          expect(closed.closed).toBe(ending === "MERGED" ? "merged" : "dismissed");
          expect(sessions.find(id)).toBeUndefined();
          expect(existsSync(cwd)).toBe(false);
          expect(quiet(path, "show-ref", "--verify", "refs/heads/" + branch)).toBe(false);
        }).pipe(Effect.scoped, Effect.provide(after.layer));
      });
    });
  }
});
