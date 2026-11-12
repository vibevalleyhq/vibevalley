import { z } from "zod";

import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { IssueStatusValues, PriorityValues, statePath } from "@vibevalley/protocol";
import { actCommand } from "@vibevalley/protocol/api";
import { latestSessionIdOf, stageWantsUser } from "@vibevalley/protocol/rules";
import * as S from "@vibevalley/protocol/schema";

import { type Ctx, show } from "#/base/format.ts";
import { err, exit, Failure, jsonText, stdinTextOrEmpty } from "#/base/output.ts";
import { arg, command, group, opt } from "#/infra/command.ts";
import { ask, change, frames } from "#/infra/farm.ts";

import { observeIssue } from "./issue-watch.ts";

const issueArg = arg.text("issue", "cli.arg.issue");
const priorityFlag = opt.choice("priority", PriorityValues, "cli.flag.priority");

/** #12 or 12: the issue's number, as the server takes it. */
const ref = (said: string) => said.replace(/^#/u, "");

/** Whose it is: the profile of its latest assignment. */
const agentOf = (i: T.Issue) => i.assignments.at(-1)?.agent;

/** One line an issue: its number first, then its status, its title, whose it is and where. */
const issueLine = (i: T.Issue) =>
  [`#${i.number}`, i.status, i.title, agentOf(i) === undefined ? "" : `@${agentOf(i)}`, i.repo === undefined ? "" : `[${i.repo}]`]
    .filter((p) => p !== "")
    .join("  ");

/** What can be done with it now, as the commands that do it (the server's acts, the one it waits on first). */
const doable = (i: T.Issue) =>
  i.stage.acts.flatMap((a) => {
    const c = actCommand(i, a, latestSessionIdOf(i));
    if (c === undefined) return [];
    const after = c.words !== "required" ? [] : a.does === "move" ? ["--comment", "…"] : ["…"];
    return [[...c.run, ...after].join(" ")];
  });

const issueText = (i: T.Issue) =>
  [
    `#${i.number}  ${i.title}`,
    [i.status, i.priority, i.repo ? `[${i.repo}]` : "", agentOf(i) ? `@${agentOf(i)}` : ""].filter((p) => p !== "").join("  "),
    t("cli.issue.stage", { stage: i.stage.stuck ? `${i.stage.state} (${i.stage.stuck})` : i.stage.state }),
    ...(i.description.trim() === "" ? [] : ["", i.description.trim()]),
    ...(i.criteria.length === 0 ? [] : ["", t("cli.issue.criteria"), ...i.criteria.map((c, n) => `  ${n + 1}. ${c}`)]),
    ...(i.questions.length === 0
      ? []
      : ["", t("cli.issue.questions"), ...i.questions.map((q) => `  ? ${q.question}${q.options.length > 0 ? `  (${q.options.join(" | ")})` : ""}`)]),
    ...(doable(i).length === 0 ? [] : ["", t("cli.issue.can"), ...doable(i).map((c) => `  vibevalley ${c}`)]),
  ].join("\n");

const listCommand = command("list", {
  about: t("cli.command.issue.list"),
  examples: [
    { command: "vibevalley issue list", description: t("cli.example.issueList.about") },
    { command: "vibevalley issue list --wants-user", description: t("cli.example.issueWantsUser.about") },
  ],
  params: {
    status: opt.choice("status", IssueStatusValues, "cli.flag.issueStatus"),
    repo: opt.text("repo", "cli.flag.repo"),
    text: opt.text("text", "cli.flag.text"),
    wantsUser: opt.bool("wants-user", "cli.flag.wantsUser"),
    closed: opt.bool("closed", "cli.flag.closed"),
    limit: opt.intOr("limit", 20, "cli.flag.limit"),
  },
  run: async (o, ctx) => {
    const issues = await ask(ctx, (api) =>
      api.issue.list({
        limit: o.limit + 1,
        ...(o.status ? { status: o.status } : {}),
        ...(o.repo ? { repo: o.repo } : {}),
        ...(o.text ? { text: o.text } : {}),
        ...(o.wantsUser ? { wantsUser: true } : {}),
        ...(o.closed ? { closed: true } : {}),
      }),
    );
    show(
      ctx,
      issues.slice(0, o.limit),
      (list) =>
        [...list.map(issueLine), ...(issues.length > o.limit ? [t("cli.more", { flag: `--limit ${o.limit * 2}` })] : [])].join("\n") || t("cli.issue.none"),
    );
  },
});

/** --description: as given, or `-` for what comes on stdin. */
const descriptionOf = async (ctx: Ctx, said: string | undefined) => (said === "-" ? stdinTextOrEmpty(ctx) : said);

const createCommand = command("create", {
  about: t("cli.command.issue.create"),
  examples: [{ command: t("cli.example.issueCreate.run"), description: t("cli.example.issueCreate.about") }],
  params: {
    title: arg.words("cli.arg.title"),
    description: opt.text("description", "cli.flag.description"),
    repo: opt.text("repo", "cli.flag.repo"),
    agent: opt.text("agent", "cli.flag.agent"),
    priority: priorityFlag,
    criterion: opt.many("criterion", "cli.flag.criterion"),
    key: opt.text("key", "cli.flag.key"),
  },
  run: async (o, ctx) => {
    const description = await descriptionOf(ctx, o.description);
    const request: T.IssueRequest = {
      title: o.title.join(" "),
      ...(description ? { description } : {}),
      ...(o.repo ? { repo: o.repo } : {}),
      ...(o.agent ? { agent: o.agent } : {}),
      ...(o.priority ? { priority: o.priority } : {}),
      ...(o.criterion.length > 0 ? { criteria: [...o.criterion] } : {}),
      ...(o.key ? { requestKey: o.key } : {}),
    };
    await change(ctx, { name: "issue create", does: (api) => api.issue.create(request), said: issueLine });
  },
});

const editCommand = command("edit", {
  about: t("cli.command.issue.edit"),
  examples: [{ command: "vibevalley issue edit 12 --priority high", description: t("cli.example.issueEdit.about") }],
  params: {
    issue: issueArg,
    title: opt.text("title", "cli.flag.title"),
    description: opt.text("description", "cli.flag.description"),
    repo: opt.text("repo", "cli.flag.repo"),
    agent: opt.text("agent", "cli.flag.agent"),
    priority: priorityFlag,
    criterion: opt.many("criterion", "cli.flag.criteria"),
  },
  run: async (o, ctx) => {
    const description = await descriptionOf(ctx, o.description);
    const update: T.IssueUpdate = {
      ...(o.title ? { title: o.title } : {}),
      ...(description ? { description } : {}),
      ...(o.repo ? { repo: o.repo } : {}),
      ...(o.agent ? { agent: o.agent } : {}),
      ...(o.priority ? { priority: o.priority } : {}),
      ...(o.criterion.length > 0 ? { criteria: [...o.criterion] } : {}),
    };
    await change(ctx, { name: "issue edit", does: (api) => api.issue.update({ id: ref(o.issue), ...update }), said: issueLine });
  },
});

/** `issue status 12 todo`: the issue moved to a status (sending it out, another round, done, canceled…), as the server allows from where it stands. */
const statusCommand = command("status", {
  about: t("cli.command.issue.status"),
  examples: [
    { command: "vibevalley issue status 12 todo", description: t("cli.example.issueStatus.about") },
    { command: "vibevalley issue status 12 done --dry-run", description: t("cli.example.issueDone.about") },
  ],
  params: {
    issue: issueArg,
    status: arg.choice("status", IssueStatusValues, "cli.arg.status"),
    comment: opt.text("comment", "cli.flag.statusComment"),
  },
  run: (o, ctx) => {
    const request = { id: ref(o.issue), status: o.status, ...(o.comment ? { text: o.comment } : {}) };
    return change(ctx, {
      name: "issue status",
      preview: (api) => api.issue.status.previewUpdate(request),
      does: (api) => api.issue.status.update(request),
      said: issueLine,
    });
  },
});

const commentCommand = command("comment", {
  about: t("cli.command.issue.comment"),
  examples: [{ command: t("cli.example.issue.comment.run"), description: t("cli.example.issue.comment.about") }],
  params: { issue: issueArg, words: arg.words("cli.arg.comment") },
  run: (o, ctx) =>
    change(ctx, {
      name: "issue comment",
      does: (api) => api.issue.comment.create({ id: ref(o.issue), text: o.words.join(" ") }),
      said: () => t("cli.issue.commented", { issue: `#${ref(o.issue)}` }),
    }),
});

/** `issue review 12 --pass`: the verdict on what was handed back; completing it is `issue status 12 done`. */
const reviewCommand = command("review", {
  about: t("cli.command.issue.review"),
  examples: [
    { command: "vibevalley issue review 12 --pass", description: t("cli.example.issueReviewPass.about") },
    { command: t("cli.example.issueReviewFail.run"), description: t("cli.example.issueReviewFail.about") },
  ],
  params: {
    issue: issueArg,
    pass: opt.bool("pass", "cli.flag.pass"),
    fail: opt.bool("fail", "cli.flag.fail"),
    finding: opt.many("finding", "cli.flag.finding"),
    comment: opt.text("comment", "cli.flag.reviewComment"),
  },
  run: (o, ctx) => {
    if (o.pass === o.fail) throw new Failure({ code: exit.usage, tag: "InvalidValue", text: t("cli.issue.passOrFail") });
    return change(ctx, {
      name: "issue review",
      does: (api) =>
        api.issue.review({
          id: ref(o.issue),
          pass: o.pass,
          ...(o.finding.length > 0 ? { findings: [...o.finding] } : {}),
          ...(o.comment ? { text: o.comment } : {}),
        }),
      said: issueLine,
    });
  },
});

const changesText = (c: T.Changes) =>
  [
    ...c.commits.map((x) => `${x.hash.slice(0, 7)}  ${x.subject}`),
    ...c.files.map((f) => `  ${f.status}  ${f.path}  +${f.added} -${f.removed}`),
    ...(c.conflicts.length > 0 ? [t("cli.issue.conflicts", { files: c.conflicts.join(", ") })] : []),
  ].join("\n") || t("cli.issue.noChanges");

const diffCommand = command("diff", {
  about: t("cli.command.issue.diff"),
  examples: [{ command: "vibevalley issue diff 12", description: t("cli.example.issueDiff.about") }],
  params: { issue: issueArg },
  run: async (o, ctx) => show(ctx, await ask(ctx, (api) => api.issue.diff.get({ id: ref(o.issue) })), changesText),
});

/** A moment as the timeline says it: YYYY-MM-DD HH:MM, in UTC. */
const minuteOf = (at: number) => new Date(at).toISOString().slice(0, 16).replace("T", " ");

const timelineCommand = command("timeline", {
  about: t("cli.command.issue.timeline"),
  examples: [{ command: "vibevalley issue timeline 12", description: t("cli.example.issueTimeline.about") }],
  params: { issue: issueArg },
  run: async (o, ctx) => {
    const tl = await ask(ctx, (api) => api.issue.timeline.get({ id: ref(o.issue) }));
    show(ctx, tl, (x) =>
      [
        ...x.milestones.map((m) => `${minuteOf(m.at)}  ${m.kind}${m.who ? `  ${m.who}` : ""}  ${m.text}`),
        ...(x.spent ? [t("cli.issue.spent", { tokens: x.spent.tokens, cny: x.spent.cny?.toFixed(2) ?? "-" })] : []),
      ].join("\n"),
    );
  },
});

const deleteCommand = command("delete", {
  about: t("cli.command.issue.delete"),
  examples: [{ command: "vibevalley issue delete 12 --dry-run", description: t("cli.example.issueDelete.about") }],
  params: { issue: issueArg },
  run: (o, ctx) =>
    change(ctx, {
      name: "issue delete",
      preview: (api) => api.issue.previewDelete({ id: ref(o.issue) }),
      does: (api) => api.issue.delete({ id: ref(o.issue) }),
      said: () => t("cli.issue.deleted", { issue: `#${ref(o.issue)}` }),
    }),
});

/** Only what `issue show --watch` reads of a frame; the rest is left as it came. */
const IssuesOfFrame = z.object({
  state: z.object({
    issues: z.array(z.object({ id: z.string(), status: S.IssueStatus, stage: z.object({ state: S.IssueStageKind }) })),
  }),
});
/** Where it waits on the user or is over: what --watch waits for. */
const settled = new Set<T.IssueStatus>(["in_review", "done", "canceled"]);

const frameOf = (data: string) => {
  try {
    return IssuesOfFrame.parse(JSON.parse(data));
  } catch (e) {
    throw new Failure({ code: exit.other, tag: "Server", text: e instanceof Error ? e.message : String(e) });
  }
};

/** Follows the issue in the core state until it waits on the user or is over, each status on stderr; one that already
 * does is not waited for. */
async function followed(ctx: Ctx, issue: T.Issue, timeout: number | undefined): Promise<void> {
  const held = new AbortController();
  const stop = () => held.abort(ctx.signal.reason);
  ctx.signal.addEventListener("abort", stop, { once: true });
  let timedOut = false;
  const timer = new AbortController();
  const ticking =
    timeout === undefined
      ? undefined
      : ctx.clock.sleep(timeout * 1000, timer.signal).then(
          () => {
            timedOut = true;
            held.abort();
          },
          // The follow ended first and stopped the timer: nothing to time out.
          () => undefined,
        );
  try {
    let last: { status: T.IssueStatus; stage: T.IssueStageKind } | undefined;
    for await (const data of frames(ctx, ctx.flags.server, statePath, held.signal)) {
      const now = frameOf(data).state.issues.find((i) => i.id === issue.id);
      if (!now) throw new Failure({ code: exit.missing, tag: "Missing", text: t("cli.failure.gone", { n: issue.number }) });
      if (last?.status === now.status && last.stage === now.stage.state) continue;
      last = { status: now.status, stage: now.stage.state };
      err(ctx, jsonText({ issue: issue.number, status: now.status, stage: now.stage.state }));
      if (settled.has(now.status) || stageWantsUser(now.stage.state)) return;
    }
  } catch (e) {
    if (timedOut && !ctx.signal.aborted)
      throw new Failure({ code: exit.other, tag: "Timeout", text: t("cli.issue.timeout", { issue: `#${issue.number}`, seconds: timeout ?? 0 }) });
    throw e;
  } finally {
    timer.abort();
    await ticking;
    ctx.signal.removeEventListener("abort", stop);
  }
  if (timedOut) throw new Failure({ code: exit.other, tag: "Timeout", text: t("cli.issue.timeout", { issue: `#${issue.number}`, seconds: timeout ?? 0 }) });
}

/** `issue show 12`: the issue; --watch follows it first, until it waits on the user or is over (as `kubectl get -w`). */
const showCommand = command("show", {
  about: t("cli.command.issue.show"),
  examples: [
    { command: "vibevalley issue show 12", description: t("cli.example.issueShow.about") },
    { command: "vibevalley issue show 12 --watch --timeout 600", description: t("cli.example.issueWatch.about") },
  ],
  params: {
    issue: issueArg,
    watch: opt.bool("watch", "cli.flag.issueWatch"),
    timeout: opt.int("timeout", "cli.flag.timeout"),
  },
  run: async (o, ctx) => {
    const issue = await ask(ctx, (api) => api.issue.get({ id: ref(o.issue) }));
    if (!o.watch) return show(ctx, issue, issueText);
    await followed(ctx, issue, o.timeout);
    const answer = await ask(ctx, (api) => api.issue.get({ id: issue.id }));
    show(ctx, answer, issueText);
  },
});

const watchCommand = command("watch", {
  about: t("cli.command.issue.watch"),
  examples: [{ command: "vibevalley issue watch 12 --jsonl", description: t("cli.example.issueObserve.about") }],
  params: {
    issue: issueArg,
    follow: opt.bool("follow", "cli.flag.follow"),
    jsonl: opt.bool("jsonl", "cli.flag.jsonl"),
  },
  run: async (o, ctx) => {
    if (ctx.flags.format === "json") throw new Failure({ code: exit.usage, tag: "WatchFormat", text: t("cli.issue.watchFormat") });
    const issue = await ask(ctx, (api) => api.issue.get({ id: ref(o.issue) }));
    await observeIssue(ctx, ctx.flags.server, issue.id, o.follow, o.jsonl);
  },
});

export const issueCommand = group("issue", t("cli.group.issue.about"), [
  listCommand,
  showCommand,
  watchCommand,
  createCommand,
  editCommand,
  statusCommand,
  commentCommand,
  reviewCommand,
  diffCommand,
  timelineCommand,
  deleteCommand,
]);
