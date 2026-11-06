import { Effect, Schema } from "effect";

import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";

import { jsonOrNone } from "#/base/json.ts";

import { run } from "./git.ts";
import type { GitHubRun } from "./github.ts";
import { RepoError } from "./workplace.ts";

export interface HostedRepo {
  readonly platform: T.PublishPlatform;
  readonly host: string;
  readonly name: string;
}

export function hostedOrigin(url: string): HostedRepo | undefined {
  const match = /^(?:https:\/\/|ssh:\/\/git@|git@)(github\.com|gitlab\.com)[/:]([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+)\/?$/u.exec(url);
  if (!match?.[1] || !match[2]) return undefined;
  const host = match[1];
  const name = match[2].replace(/\.git$/u, "");
  const parts = name.split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..") || (host === "github.com" && parts.length !== 2)) return undefined;
  return { platform: host === "github.com" ? "github" : "gitlab", host, name };
}

export const runGitLab: GitHubRun = (...args) =>
  Effect.map(run("glab", args, { env: { ...process.env, GITLAB_HOST: "gitlab.com", GLAB_PROMPT_DISABLED: "1" }, timeoutMs: 15_000 }), (r) => ({
    out: r.stdout,
    ok: r.code === 0,
    missing: r.missing,
  }));

const githubRepo = jsonOrNone(Schema.Struct({ defaultBranchRef: Schema.Struct({ name: Schema.String }) }));
const gitlabRepo = jsonOrNone(Schema.Struct({ default_branch: Schema.String }));
const githubPulls = jsonOrNone(Schema.Array(Schema.Struct({ number: Schema.Int, url: Schema.String })));
const gitlabPulls = jsonOrNone(Schema.Array(Schema.Struct({ iid: Schema.Int, web_url: Schema.String })));
const gitlabPull = jsonOrNone(Schema.Struct({ iid: Schema.Int, web_url: Schema.String }));

const failure = (stage: string) => new RepoError({ message: t("server.repo.publish.platformFailed", { stage }) });

export const hosting = (repo: HostedRepo, command: GitHubRun) => {
  const github = repo.platform === "github";
  const project = `projects/${encodeURIComponent(repo.name)}`;
  const receipt = (number: number, url: string) => {
    const prefix = `https://${repo.host}/${repo.name}/${github ? "pull" : "-/merge_requests"}/`;
    return Number.isSafeInteger(number) && number > 0 && url === prefix + number ? Effect.succeed({ number, url }) : Effect.fail(failure("receipt"));
  };
  const request = Effect.fnUntraced(function* (...args: string[]) {
    const result = yield* command(...args);
    if (!result.ok) return yield* failure(result.missing ? (github ? "gh missing" : "glab missing") : args.slice(0, 2).join(" "));
    return result.out;
  });
  const find = Effect.fnUntraced(function* (branch: string, base: string) {
    if (github) {
      const parsed = githubPulls(
        yield* request("pr", "list", "--repo", repo.name, "--head", branch, "--base", base, "--state", "open", "--json", "url,number"),
      );
      if (!parsed || parsed.length > 1) return yield* failure("list decode");
      const first = parsed[0];
      return first ? yield* receipt(first.number, first.url) : undefined;
    }
    const parsed = gitlabPulls(
      yield* request(
        "api",
        `${project}/merge_requests?state=opened&source_branch=${encodeURIComponent(branch)}&target_branch=${encodeURIComponent(base)}&per_page=2`,
      ),
    );
    if (!parsed || parsed.length > 1) return yield* failure("list decode");
    const first = parsed[0];
    return first ? yield* receipt(first.iid, first.web_url) : undefined;
  });
  return {
    inspect: Effect.fnUntraced(function* () {
      yield* request("auth", "status", "--hostname", repo.host);
      const out = yield* github ? request("repo", "view", repo.name, "--json", "defaultBranchRef") : request("api", project);
      const base = github ? githubRepo(out)?.defaultBranchRef.name : gitlabRepo(out)?.default_branch;
      if (!base) return yield* failure("repository decode");
      return base;
    }),
    find,
    create: Effect.fnUntraced(function* (req: T.SubmitBranch) {
      if (github) {
        const out = yield* request("pr", "create", "--repo", repo.name, "--head", req.branch, "--base", req.base, "--title", req.title, "--body", req.body);
        const url = out.trim();
        return yield* receipt(Number(url.slice(url.lastIndexOf("/") + 1)), url);
      }
      const out = yield* request(
        "api",
        `${project}/merge_requests`,
        "--method",
        "POST",
        "--raw-field",
        `source_branch=${req.branch}`,
        "--raw-field",
        `target_branch=${req.base}`,
        "--raw-field",
        `title=${req.title}`,
        "--raw-field",
        `description=${req.body}`,
      );
      const parsed = gitlabPull(out);
      if (!parsed) return yield* failure("create decode");
      return yield* receipt(parsed.iid, parsed.web_url);
    }),
  };
};
