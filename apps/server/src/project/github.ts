import { Clock, Effect, Schema } from "effect";

import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";

import { jsonOrNone } from "#/base/json.ts";

import { run } from "./git.ts";

export const cloneTimeoutMs = 3 * 60_000;

// What the gh commands below print with --json; anything else is not taken as their answer.
export const repoView = jsonOrNone(Schema.Struct({ viewerPermission: Schema.optional(Schema.NullOr(Schema.String)) }));
export const openPullRequests = jsonOrNone(Schema.Array(Schema.Struct({ url: Schema.String, number: Schema.Int })));
export const pullRequestView = jsonOrNone(Schema.Struct({ state: Schema.String, mergedAt: Schema.optional(Schema.NullOr(Schema.String)) }));

const ghVersion = /^gh version ([0-9]+\.[0-9]+\.[0-9]+)/mu;
const ghAccount = /Logged in to github\.com account ([A-Za-z0-9-]+)(?:\s|$)/u;
const ghOrigin = /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+)\/?$/u;

export function githubOrigin(origin: string): string {
  const m = ghOrigin.exec(origin.trim());
  if (!m?.[1] || !m[2]) return "";
  const repo = m[2].replace(/\.git$/u, "");
  return repo === "" || repo === "." || repo === ".." ? "" : `${m[1]}/${repo}`;
}

/** gh's combined output; failed when it exits non-zero or is not there. */
export type GitHubRun = (...args: string[]) => Effect.Effect<{ readonly out: string; readonly ok: boolean; readonly missing: boolean }>;

export const runGitHub: GitHubRun = (...args) =>
  Effect.map(
    // Auth status writes to stderr; raw output must never escape the probe.
    run("gh", args, {
      env: { ...process.env, GH_HOST: "github.com", GH_PROMPT_DISABLED: "1" },
      timeoutMs: args[0] === "repo" && args[1] === "clone" ? cloneTimeoutMs : 15_000,
    }),
    (r) => ({ out: r.stdout + r.stderr, ok: r.code === 0, missing: r.missing }),
  );

export const probeGitHub = Effect.fn("Project.probeGitHub")(function* (gh: GitHubRun) {
  const s: T.GitHubStatus = { checkedAt: yield* Clock.currentTimeMillis, installed: false, loggedIn: false, reason: "" };
  const version = yield* gh("--version");
  if (!version.ok) return { ...s, reason: version.missing ? t("server.project.gh.missing") : t("server.project.gh.failed") };
  const v = ghVersion.exec(version.out)?.[1];
  const installed: T.GitHubStatus = { ...s, installed: true, ...(v ? { version: v } : {}) };
  const auth = yield* gh("auth", "status", "--hostname", "github.com", "--active");
  if (!auth.ok) return { ...installed, reason: t("server.project.gh.signedOut") };
  const account = ghAccount.exec(auth.out)?.[1];
  if (!account) return { ...installed, reason: t("server.project.gh.noAccount") };
  return { ...installed, loggedIn: true, account };
});
