import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { mapConcurrent, Semaphore, TaskGroup } from "@vibevalley/async";
import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { latestSessionIdOf } from "@vibevalley/protocol/rules";

import { ApiError } from "#/base/errors.ts";
import { jsonText } from "#/base/json.ts";
import { compareText, or } from "#/base/order.ts";
import type { ServerConfig } from "#/infra/config.ts";
import type { Db } from "#/infra/db.ts";
import { bestEffort, type Logger } from "#/infra/log.ts";
import type { Time } from "#/infra/time.ts";
import type { Channel } from "#/modules/channel/channel.ts";
import type { Issue } from "#/modules/issue/issue.ts";
import { finishesWithPullRequest } from "#/modules/issue/landing.ts";
import { GitError, gitQuiet, reason, run } from "#/modules/repo/git.ts";
import { type GitHubRun, runGitHub } from "#/modules/repo/github.ts";
import { issueBranch, type Repo } from "#/modules/repo/repo.ts";
import { repository } from "#/modules/repo/repository.ts";
import { lexists } from "#/modules/repo/stats.ts";
import {
  MergeFailure,
  type PullRequest,
  pullRequestFile,
  type PullRequestState,
  pullRequestText,
  RepoError,
  type Workplace,
} from "#/modules/repo/workplace.ts";
import type { TriggerInput } from "#/modules/session/payload.ts";
import { NotTakenIn, type Session } from "#/modules/session/session.ts";
import type { Trigger } from "#/modules/session/shapes.ts";
import * as qe from "#db/pull_event.sql.ts";

import { type HostedRepo, hostedOrigin, remotePullState, runGitLab } from "./hosting.ts";
import { publisher, type PublishNetwork } from "./publish.ts";
import { actionsJobOf, type GitHubPullSnapshot, makeGithubSnapshot } from "./pullSnapshot.ts";
import { makePullStore, type PullRecord } from "./store.ts";

export { actionsJobOf, type GitHubPullSnapshot, hostedOrigin, type PublishNetwork, type PullRecord };

const failedChecks = new Set(["FAILURE", "ERROR", "CANCELLED", "CANCELED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE"]);
const finishedChecks = new Set(["COMPLETED", "SUCCESS", "FAILURE", "ERROR"]);

export function checksVerdict<C extends { readonly status: string; readonly conclusion: string }>(
  checks: readonly C[],
): { readonly failed: C[]; readonly finished: boolean } {
  return {
    failed: checks.filter((check) => failedChecks.has((check.conclusion || check.status).toUpperCase())),
    finished: checks.length > 0 && checks.every((check) => check.conclusion !== "" || finishedChecks.has(check.status.toUpperCase())),
  };
}

export interface PullHooks {
  readonly gh?: GitHubRun;
  readonly glab?: GitHubRun;
  readonly publication?: PublishNetwork;
  readonly command?: typeof run;
}

export interface PublishRequest extends T.SubmitBranch {
  readonly issueId?: T.IssueId;
}

export interface PullDeps {
  readonly config: ServerConfig;
  readonly clock: Time;
  readonly log: Logger;
  readonly db: Db;
  readonly repo: Repo;
  readonly session?: Session;
  readonly channel?: Channel;
  readonly issue?: Issue;
}

export interface Pull {
  readonly ofIssue: (issueId: T.IssueId) => PullRequest | undefined;
  readonly find: (repo: string, number: number) => PullRecord | undefined;
  readonly list: () => readonly PullRecord[];
  readonly publish: (req: PublishRequest, signal?: AbortSignal) => Promise<T.BranchPublication>;
  readonly submitForIssue: (place: Workplace, issue: T.Issue, conclusion: string, signal?: AbortSignal) => Promise<PullRequest>;
  readonly pullRequestState: (repo: string, number: number, platform?: T.BranchPublication["platform"]) => Promise<PullRequestState>;
  readonly snapshot: (repo: string, number: number) => Promise<GitHubPullSnapshot>;
  readonly failedJobLog: (repo: string, checkUrl: string) => Promise<string>;
  readonly refresh: () => Promise<void>;
  readonly poll: () => Promise<void>;
  readonly boot: () => Promise<void>;
  readonly close: () => Promise<void>;
}

const asRepoError = async <A>(work: Promise<A>): Promise<A> => {
  try {
    return await work;
  } catch (e) {
    if (e instanceof GitError) throw new RepoError(reason(e), { cause: e });
    throw e;
  }
};

export async function makePull(deps: PullDeps, hooks: PullHooks = {}): Promise<Pull> {
  const { config, clock, db, repo: repos, session: sessions, channel: chat, issue: issues } = deps;
  const log = deps.log.child("pull");
  const tasks = new TaskGroup({ name: "pull", onError: (task, e) => log.error(`${task} failed:`, e) });
  const refreshLock = new Semaphore(1);
  const pollLock = new Semaphore(1);
  const gh = hooks.gh ?? runGitHub;
  const glab = hooks.glab ?? runGitLab;
  const checkTimeoutMs = config.repo.checkTimeoutSeconds * 1000;
  const store = await makePullStore(db);

  const publishRaw = publisher({
    gh,
    glab,
    timeoutMs: checkTimeoutMs,
    command: hooks.command ?? run,
    network: hooks.publication,
    serially: repos.serially,
  });

  const inferFarmRepo = async (cwd: string): Promise<string | undefined> => {
    try {
      const [rootReal, cwdReal] = await Promise.all([realpath(repos.root), realpath(cwd)]);
      const { common } = await repository(cwdReal).location();
      if (!common) return undefined;
      const mainDir = basename(common) === ".git" ? dirname(common) : common;
      if (dirname(mainDir) !== rootReal) return undefined;
      const candidate = basename(mainDir);
      return (await repos.list()).some((p) => p.name === candidate) ? candidate : undefined;
    } catch {
      // External checkouts are tracked under their remote repository slug.
      return undefined;
    }
  };

  const hostedRepoOf = async (name: string, platform?: T.BranchPublication["platform"]): Promise<HostedRepo> => {
    if (name.includes("/")) {
      const chosen = platform ?? "github";
      const host = chosen === "github" ? "github.com" : "gitlab.com";
      const hosted = hostedOrigin(`https://${host}/${name}`);
      if (!hosted) throw new RepoError(t("server.repo.github.notGithub"));
      return hosted;
    }
    const origin = await repository(join(repos.root, name)).origin();
    const hosted = hostedOrigin(origin.trim());
    if (!hosted || (platform !== undefined && hosted.platform !== platform)) throw new RepoError(t("server.repo.github.notGithub"));
    return hosted;
  };

  const githubRemote = async (name: string): Promise<string> => (await hostedRepoOf(name, "github")).name;
  const snapshot = makeGithubSnapshot(gh, githubRemote);

  const failedJobLog = async (name: string, checkUrl: string): Promise<string> => {
    const job = actionsJobOf(checkUrl);
    if (!job) return "";
    let remote: string;
    try {
      remote = await githubRemote(name);
    } catch (e) {
      if (!(e instanceof RepoError)) throw e;
      log.debug(`no GitHub remote for ${name}: ${e.message}`);
      return "";
    }
    if (!remote) return "";
    const said = await gh("run", "view", "--job", job, "--log-failed", "--repo", remote);
    if (!said.ok) return "";
    return said.out.trim().split("\n").slice(-40).join("\n").slice(-4000);
  };

  const pullRequestState = async (name: string, number: number, platform?: T.BranchPublication["platform"]): Promise<PullRequestState> => {
    const hosted = await hostedRepoOf(name, platform);
    return remotePullState(hosted, number, hosted.platform === "github" ? gh : glab);
  };

  const publishInternal = async (req: PublishRequest, signal?: AbortSignal, repoName?: string): Promise<T.BranchPublication> => {
    const result = await publishRaw(req, signal);
    if (req.dryRun !== true && result.url !== undefined && result.number !== undefined) {
      const url = result.url;
      const number = result.number;
      const trackedRepo = repoName ?? (await inferFarmRepo(req.cwd)) ?? result.repository;
      await db.tx(() =>
        store.upsertInTx({
          platform: result.platform,
          repo: trackedRepo,
          number,
          url,
          branch: result.branch,
          base: result.base,
          state: "open",
          ...(req.issueId === undefined ? {} : { issueId: req.issueId }),
          at: clock.now(),
        }),
      );
    }
    return result;
  };

  const publish = (req: PublishRequest, signal?: AbortSignal) => publishInternal(req, signal);

  const submitForIssue = async (place: Workplace, issue: T.Issue, conclusion: string, signal?: AbortSignal): Promise<PullRequest> => {
    const branch = place.branch;
    if (!branch || branch !== issueBranch(issue.number)) throw new RepoError(t("server.repo.github.wrongBranch"));
    const path = join(repos.root, place.repo);
    const sha = await asRepoError(repository(place.cwd, signal).head());
    const base = await asRepoError(repository(path, signal).main());
    const written = await gitQuiet(place.cwd, "rev-parse", "--path-format=absolute", "--git-path", pullRequestFile);
    let given: ReturnType<typeof pullRequestText>;
    if (written !== "") {
      let raw = "";
      try {
        raw = await readFile(written, "utf8");
      } catch {
        // No file left by the helper: the issue's own title and body open the pull request.
        raw = "";
      }
      given = pullRequestText(raw);
    }
    const check = (await lexists(join(place.cwd, ".vibevalley/check"))) ? t("server.repo.github.checked") : t("server.repo.github.noCheck");
    const result = await publishInternal(
      {
        cwd: place.cwd,
        branch,
        sha,
        base,
        title: given?.title ?? issue.title,
        body: given?.body || t("server.repo.github.body", { n: issue.number, conclusion, check }),
        issueId: issue.id,
      },
      signal,
      place.repo,
    );
    if (!result.url || result.number === undefined) throw new RepoError(t("server.repo.github.urlUnread"));
    const pr: PullRequest = { url: result.url, number: result.number, state: "open" };
    if (chat) {
      let thread: string;
      try {
        thread = await chat.openThreadAbout("issue", issue.id, issue.title);
      } catch (e) {
        throw e instanceof ApiError ? MergeFailure.error(e.message) : e;
      }
      await chat.notice({
        channel: thread,
        text: t("server.issue.prDelivered", { url: pr.url }),
        code: "issue_pr_delivery",
        sendKey: `issue-pr:${issue.id}:${pr.url}`,
      });
    }
    if (issues) {
      if (result.platform === "github") await issues.subscribe(issue.id, [`github:${place.repo}#${pr.number}`]);
      await issues.refreshPull(issue.id);
    }
    return pr;
  };

  if (issues) {
    await issues.usePull({
      usesPullRequests: (name) => repos.usesPullRequests(name),
      ofIssue: (id) => store.ofIssue(id),
      submitForIssue,
    });
    const onBoard = new Set(issues.onBoard().map((item) => item.id));
    for (const row of store.all()) {
      if (row.platform === "github" && row.issueId && onBoard.has(row.issueId)) {
        await issues.subscribe(row.issueId, [`github:${row.repo}#${row.number}`]);
      }
    }
  }

  const refresh = (): Promise<void> =>
    refreshLock.with(async () => {
      for (const row of store.open()) {
        try {
          const state = await pullRequestState(row.repo, row.number, row.platform);
          if (state === "open") continue;
          const linked = row.issueId && issues ? await issues.find(row.issueId) : undefined;
          if (linked && issues && finishesWithPullRequest(linked)) {
            const closed = state === "closed" ? "dismissed" : "merged";
            const sessionId = latestSessionIdOf(linked);
            if (sessionId && sessions?.live(sessionId).reachable === true) {
              try {
                await sessions.handOver(sessionId, closed, (place) => repos.finishPullRequest(place.repo, linked.number));
              } catch (e) {
                if (e instanceof NotTakenIn) throw new RepoError(e.failure.reasonText, { cause: e });
                throw e;
              }
            } else if (linked.repo) {
              await repos.finishPullRequest(linked.repo, linked.number);
            }
            await db.tx(async () => {
              await store.setStateInTx(row.id, state, clock.now());
              await issues.settlePull(linked.id, state);
            });
          } else {
            await db.tx(() => store.setStateInTx(row.id, state, clock.now()));
            if (linked && issues) await issues.refreshPull(linked.id);
          }
        } catch (e) {
          // One pull request that cannot be read or finished now is tried again on the next round; the rest go on.
          if (!(e instanceof RepoError || e instanceof ApiError || e instanceof MergeFailure)) throw e;
          log.warn(`vibevalley: refresh pull requests: ${row.repo}#${row.number}: ${e.message}`);
        }
      }
    });

  const pollOne = async (row: PullRecord) => {
    if (row.platform !== "github" || row.state !== "open") return;
    const current = await snapshot(row.repo, row.number);
    const at = clock.now();
    const threadKey = `github:${row.repo}#${row.number}`;
    const linked = row.issueId && issues ? await issues.find(row.issueId) : undefined;
    const subscribers = issues ? await issues.subscribed([threadKey]) : [];
    const hasRecipient = issues !== undefined && (linked !== undefined || subscribers.length > 0);
    const threads = linked ? [`issue:${linked.id}`, threadKey] : [threadKey];

    const checks = current.checks.toSorted((a, b) => or(compareText(a.name, b.name), compareText(a.url, b.url)));
    const fingerprint = createHash("sha256")
      .update(jsonText({ head: current.head, checks }))
      .digest("hex");
    if (fingerprint !== row.checkFingerprint) {
      const revision = row.checkRevision + 1;
      const { failed, finished } = checksVerdict(checks);
      let ciTrigger: Trigger | undefined;
      if (hasRecipient && sessions !== undefined && (failed.length > 0 || finished)) {
        const failedText = await mapConcurrent(failed, 3, async (check) => {
          const job = await failedJobLog(row.repo, check.url);
          return `${check.name}: ${check.conclusion || check.status}${job ? "\n" + job : ""}`;
        });
        const input: TriggerInput = {
          source: "github",
          addressed: "thread_owner",
          threads,
          at,
          key: `${row.repo}#${row.number}:ci:${revision}`,
          actor: { kind: "system", id: threadKey },
          text: (failed.length > 0 ? failedText : checks.map((check) => `${check.name}: ${check.conclusion || check.status}`)).join("\n"),
          data: { head: current.head, checks },
          meta: { repo: row.repo, pr: row.number, kind: "ci", head: current.head, fingerprint, failed: failed.length > 0 },
        };
        ciTrigger = await db.tx(async () => {
          const recorded = await sessions.recordTrigger(input);
          await store.observeChecksInTx(row.id, fingerprint, revision, at);
          return recorded;
        });
      } else {
        await db.tx(() => store.observeChecksInTx(row.id, fingerprint, revision, at));
      }
      if (ciTrigger && issues) await issues.route(ciTrigger);
    }

    const known = await qe.knownPullEvents(db.sql, { pull_id: row.id });
    const keys = new Set(known.map((event) => event.key));
    const rounds = new Map(
      known.flatMap((event) => (event.bot_round_key !== null && event.bot_round !== null ? [[event.bot_round_key, event.bot_round] as const] : [])),
    );
    let botRound = 0;
    for (const round of rounds.values()) botRound = Math.max(botRound, round);
    const events = [
      ...current.reviews.map((review) => ({
        key: `${row.repo}#${row.number}:review:${review.id}`,
        author: review.author,
        bot: review.bot,
        round: `${review.author}:review:${review.id}`,
        occurred: review.at,
        text: `${review.author} ${review.state}\n${review.body}`.trim(),
        data: review,
        kind: "review" as const,
      })),
      ...current.comments.map((comment) => ({
        key: `${row.repo}#${row.number}:comment:${comment.id}`,
        author: comment.author,
        bot: comment.bot,
        round: comment.reviewId ? `${comment.author}:review:${comment.reviewId}` : `${comment.author}:comment:${comment.id}`,
        occurred: comment.at,
        text: [
          comment.author,
          comment.path ? `${comment.path}${comment.line === undefined ? "" : `:${comment.line}`}` : "",
          comment.diffHunk?.split("\n").slice(-3).join("\n"),
          comment.body,
        ]
          .filter(Boolean)
          .join("\n"),
        data: comment,
        kind: "comment" as const,
      })),
    ].toSorted((a, b) => or(compareText(a.occurred, b.occurred), compareText(a.key, b.key)));
    for (const event of events) {
      if (keys.has(event.key) || event.author.toLowerCase() === current.viewer.toLowerCase()) continue;
      const round = event.bot ? (rounds.get(event.round) ?? botRound + 1) : undefined;
      let recorded: Trigger | undefined;
      if (hasRecipient && sessions !== undefined) {
        const input: TriggerInput = {
          source: "github",
          addressed: "thread_owner",
          threads,
          at,
          key: event.key,
          actor: { kind: "system", id: event.author || "deleted", name: event.author },
          text: event.text,
          data: event.data,
          meta: {
            repo: row.repo,
            pr: row.number,
            kind: event.kind,
            ...(round === undefined ? {} : { botRound: round, botRoundKey: event.round }),
          },
        };
        recorded = await db.tx(async () => {
          const trigger = await sessions.recordTrigger(input);
          await qe.keepPullEvent(db.sql, {
            pull_id: row.id,
            key: event.key,
            bot_round_key: round === undefined ? null : event.round,
            bot_round: round ?? null,
          });
          return trigger;
        });
      } else {
        await qe.keepPullEvent(db.sql, {
          pull_id: row.id,
          key: event.key,
          bot_round_key: round === undefined ? null : event.round,
          bot_round: round ?? null,
        });
      }
      keys.add(event.key);
      if (round !== undefined) {
        rounds.set(event.round, round);
        botRound = Math.max(botRound, round);
      }
      if (recorded && issues) await issues.route(recorded);
    }
  };

  const poll = (): Promise<void> =>
    pollLock.with(async () => {
      for (const row of store.open().filter((item) => item.platform === "github")) {
        await bestEffort(log, `pull: GitHub ${row.repo}#${row.number}`, () => pollOne(row));
      }
    });

  return {
    ofIssue: (issueId) => store.ofIssue(issueId),
    find: (repo, number) => store.find(repo, number),
    list: () => store.all(),
    publish,
    submitForIssue,
    pullRequestState,
    snapshot,
    failedJobLog,
    refresh,
    poll,
    boot: () => {
      const pollEvery = config.github.prPollSeconds > 0 ? config.github.prPollSeconds * 1000 : 180_000;
      tasks.run("pull: poll", async (signal) => {
        for (;;) {
          await clock.sleep(pollEvery, signal);
          await bestEffort(log, "vibevalley: refresh pull requests", () => refresh());
          await poll();
        }
      });
      return Promise.resolve();
    },
    close: () => tasks.close(),
  };
}
