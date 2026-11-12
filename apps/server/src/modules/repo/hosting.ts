import { z } from "zod";

import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";

import { jsonOrNone } from "#/base/json.ts";

import { run } from "./git.ts";
import type { GitHubRun } from "./github.ts";
import { RepoError } from "./workplace.ts";

export interface HostedRepo {
  readonly platform: T.BranchPublication["platform"];
  readonly host: string;
  readonly name: string;
}

export function hostedOrigin(url: string): HostedRepo | undefined {
  const match =
    /^(?:https:\/\/(github\.com|gitlab\.com)\/|ssh:\/\/git@(github\.com|gitlab\.com)\/|git@(github\.com|gitlab\.com):)([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+)\/?$/u.exec(
      url,
    );
  const host = match?.[1] ?? match?.[2] ?? match?.[3];
  if (!host || !match?.[4]) return undefined;
  const name = match[4].replace(/\.git$/u, "");
  const parts = name.split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..") || (host === "github.com" && parts.length !== 2)) return undefined;
  return { platform: host === "github.com" ? "github" : "gitlab", host, name };
}

export const runGitLab: GitHubRun = async (...args) => {
  const r = await run("glab", args, { env: { ...process.env, GITLAB_HOST: "gitlab.com", GLAB_PROMPT_DISABLED: "1" }, timeoutMs: 15_000 });
  return { out: r.stdout, ok: r.code === 0, missing: r.missing };
};

const githubRepo = jsonOrNone(z.object({ defaultBranchRef: z.object({ name: z.string() }) }));
const gitlabRepo = jsonOrNone(z.object({ default_branch: z.string() }));
const githubPulls = jsonOrNone(
  z.array(z.object({ number: z.number().int(), url: z.string(), isCrossRepository: z.boolean(), state: z.enum(["OPEN", "MERGED", "CLOSED"]) })),
);
const gitlabMerge = z.object({
  iid: z.number().int(),
  web_url: z.string(),
  source_project_id: z.number().int(),
  target_project_id: z.number().int(),
  state: z.enum(["opened", "merged", "closed", "locked"]),
});
const gitlabPulls = jsonOrNone(z.array(gitlabMerge));
const gitlabPull = jsonOrNone(gitlabMerge);
const received = z.object({ number: z.number().int(), url: z.string().regex(/^https:\/\//u) });

/** A request open on the platform, as it answered. */
export interface Receipt {
  readonly number: number;
  readonly url: string;
  readonly state: "open";
}

const failure = (stage: string) => new RepoError(t("server.repo.publish.platformFailed", { stage }));

export const hosting = (repo: HostedRepo, command: GitHubRun) => {
  const github = repo.platform === "github";
  const project = `projects/${encodeURIComponent(repo.name)}`;
  const receipt = (number: number, url: string): Receipt => {
    if (!received.safeParse({ number, url }).success) throw failure("receipt decode");
    const prefix = `https://${repo.host}/${repo.name}/${github ? "pull" : "-/merge_requests"}/`;
    if (number <= 0 || url !== prefix + number) throw failure("receipt");
    return { number, url, state: "open" as const };
  };
  const request = async (...args: string[]) => {
    const result = await command(...args);
    if (!result.ok) throw failure(result.missing ? (github ? "gh missing" : "glab missing") : args.slice(0, 2).join(" "));
    return result.out;
  };
  const find = async (branch: string, base: string): Promise<Receipt | undefined> => {
    if (github) {
      const response2 = await request(
        "pr",
        "list",
        "--repo",
        repo.name,
        "--head",
        branch,
        "--base",
        base,
        "--state",
        "open",
        "--json",
        "url,number,isCrossRepository,state",
      );
      const parsed = githubPulls(response2);
      if (!parsed || parsed.length > 1) throw failure("list decode");
      const first = parsed.find((pr) => !pr.isCrossRepository && pr.state === "OPEN");
      return first ? receipt(first.number, first.url) : undefined;
    }
    const response = await request(
      "api",
      `${project}/merge_requests?state=opened&source_branch=${encodeURIComponent(branch)}&target_branch=${encodeURIComponent(base)}&per_page=2`,
    );
    const parsed = gitlabPulls(response);
    if (!parsed || parsed.length > 1) throw failure("list decode");
    const first = parsed.find((mr) => mr.source_project_id === mr.target_project_id && (mr.state === "opened" || mr.state === "locked"));
    return first ? receipt(first.iid, first.web_url) : undefined;
  };
  return {
    inspect: async () => {
      await request("auth", "status", "--hostname", repo.host);
      const out = await (github ? request("repo", "view", repo.name, "--json", "defaultBranchRef") : request("api", project));
      const base = github ? githubRepo(out)?.defaultBranchRef.name : gitlabRepo(out)?.default_branch;
      if (!base) throw failure("repository decode");
      return base;
    },
    find,
    create: async (req: T.SubmitBranch): Promise<Receipt> => {
      if (github) {
        const out = await request("pr", "create", "--repo", repo.name, "--head", req.branch, "--base", req.base, "--title", req.title, "--body", req.body);
        const url = out.trim();
        return receipt(Number(url.slice(url.lastIndexOf("/") + 1)), url);
      }
      const out = await request(
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
      if (!parsed || parsed.source_project_id !== parsed.target_project_id || (parsed.state !== "opened" && parsed.state !== "locked"))
        throw failure("create decode");
      return receipt(parsed.iid, parsed.web_url);
    },
  };
};
