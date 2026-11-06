import { Effect, Schema, Stream } from "effect";
import { Argument, Command, Flag } from "effect/cli";

import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { IssueStatusValues, PriorityValues, statePath } from "@vibevalley/protocol";
import { actCommand } from "@vibevalley/protocol/api";
import { latestSessionIdOf, stageWantsOwner } from "@vibevalley/protocol/rules";
import * as S from "@vibevalley/protocol/schema";

import { ask, change, frames, given, nameArg, optionalText, ServerFlag, show, words } from "#/farm.ts";
import { err, exit, Failure, stdinText } from "#/output.ts";

const issueArg = nameArg("issue", "cli.arg.issue");
const priorityFlag = Flag.Literals("priority", PriorityValues).pipe(Flag.optional, Flag.withDescription(t("cli.flag.priority")));

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

const listCommand = Command.make(
  "list",
  {
    status: Flag.Literals("status", IssueStatusValues).pipe(Flag.optional, Flag.withDescription(t("cli.flag.issueStatus"))),
    repo: optionalText("repo", "cli.flag.repo"),
    text: optionalText("text", "cli.flag.text"),
    wantsOwner: Flag.Boolean("wants-owner").pipe(Flag.withDefault(false), Flag.withDescription(t("cli.flag.wantsOwner"))),
    closed: Flag.Boolean("closed").pipe(Flag.withDefault(false), Flag.withDescription(t("cli.flag.closed"))),
    limit: Flag.Int("limit").pipe(Flag.withDefault(20), Flag.withDescription(t("cli.flag.limit"))),
  },
  (o) =>
    Effect.gen(function* () {
      const status = given(o.status);
      const repo = given(o.repo);
      const text = given(o.text);
      const issues = yield* ask((api) =>
        api.issue.list({
          limit: o.limit + 1,
          ...(status ? { status } : {}),
          ...(repo ? { repo } : {}),
          ...(text ? { text } : {}),
          ...(o.wantsOwner ? { wantsOwner: true } : {}),
          ...(o.closed ? { closed: true } : {}),
        }),
      );
      yield* show(
        issues.slice(0, o.limit),
        (list) =>
          [...list.map(issueLine), ...(issues.length > o.limit ? [t("cli.more", { flag: `--limit ${o.limit * 2}` })] : [])].join("\n") || t("cli.issue.none"),
      );
    }),
).pipe(
  Command.withDescription(t("cli.command.issue.list")),
  Command.withExamples([
    { command: "vibevalley issue list", description: t("cli.example.issueList.about") },
    { command: "vibevalley issue list --wants-owner", description: t("cli.example.issueWantsOwner.about") },
  ]),
);

/** --description: as given, or `-` for what comes on stdin. */
const descriptionOf = (said: string | undefined) => (said === "-" ? stdinText.pipe(Effect.orElseSucceed(() => "")) : Effect.succeed(said));

const createCommand = Command.make(
  "create",
  {
    title: words("cli.arg.title"),
    description: optionalText("description", "cli.flag.description"),
    repo: optionalText("repo", "cli.flag.repo"),
    agent: optionalText("agent", "cli.flag.agent"),
    priority: priorityFlag,
    criterion: Flag.String("criterion").pipe(Flag.atLeast(0), Flag.withDescription(t("cli.flag.criterion"))),
    key: optionalText("key", "cli.flag.key"),
  },
  (o) =>
    Effect.gen(function* () {
      const description = yield* descriptionOf(given(o.description));
      const fields = { repo: given(o.repo), agent: given(o.agent), priority: given(o.priority), requestKey: given(o.key) };
      const request: T.IssueRequest = {
        title: o.title.join(" "),
        ...(description ? { description } : {}),
        ...(fields.repo ? { repo: fields.repo } : {}),
        ...(fields.agent ? { agent: fields.agent } : {}),
        ...(fields.priority ? { priority: fields.priority } : {}),
        ...(o.criterion.length > 0 ? { criteria: [...o.criterion] } : {}),
        ...(fields.requestKey ? { requestKey: fields.requestKey } : {}),
      };
      yield* change({ name: "issue create", does: (api) => api.issue.create(request), said: issueLine });
    }),
).pipe(
  Command.withDescription(t("cli.command.issue.create")),
  Command.withExamples([{ command: t("cli.example.issueCreate.run"), description: t("cli.example.issueCreate.about") }]),
);

const editCommand = Command.make(
  "edit",
  {
    issue: issueArg,
    title: optionalText("title", "cli.flag.title"),
    description: optionalText("description", "cli.flag.description"),
    repo: optionalText("repo", "cli.flag.repo"),
    agent: optionalText("agent", "cli.flag.agent"),
    priority: priorityFlag,
    criterion: Flag.String("criterion").pipe(Flag.atLeast(0), Flag.withDescription(t("cli.flag.criteria"))),
  },
  (o) =>
    Effect.gen(function* () {
      const description = yield* descriptionOf(given(o.description));
      const fields = { title: given(o.title), repo: given(o.repo), agent: given(o.agent), priority: given(o.priority) };
      const update: T.IssueUpdate = {
        ...(fields.title ? { title: fields.title } : {}),
        ...(description ? { description } : {}),
        ...(fields.repo ? { repo: fields.repo } : {}),
        ...(fields.agent ? { agent: fields.agent } : {}),
        ...(fields.priority ? { priority: fields.priority } : {}),
        ...(o.criterion.length > 0 ? { criteria: [...o.criterion] } : {}),
      };
      yield* change({ name: "issue edit", does: (api) => api.issue.update({ id: ref(o.issue), ...update }), said: issueLine });
    }),
).pipe(
  Command.withDescription(t("cli.command.issue.edit")),
  Command.withExamples([{ command: "vibevalley issue edit 12 --priority high", description: t("cli.example.issueEdit.about") }]),
);

/** `issue status 12 todo`: the issue moved to a status (sending it out, another round, done, canceled…), as the server allows from where it stands. */
const statusCommand = Command.make(
  "status",
  {
    issue: issueArg,
    status: Argument.Literals("status", IssueStatusValues).pipe(Argument.withDescription(t("cli.arg.status"))),
    comment: optionalText("comment", "cli.flag.statusComment"),
  },
  (o) => {
    const text = given(o.comment);
    const request = { id: ref(o.issue), status: o.status, ...(text ? { text } : {}) };
    return change({
      name: "issue status",
      preview: (api) => api.issue.status.previewUpdate(request),
      does: (api) => api.issue.status.update(request),
      said: issueLine,
    });
  },
).pipe(
  Command.withDescription(t("cli.command.issue.status")),
  Command.withExamples([
    { command: "vibevalley issue status 12 todo", description: t("cli.example.issueStatus.about") },
    { command: "vibevalley issue status 12 done --dry-run", description: t("cli.example.issueDone.about") },
  ]),
);

const commentCommand = Command.make("comment", { issue: issueArg, words: words("cli.arg.comment") }, (o) =>
  change({
    name: "issue comment",
    does: (api) => api.issue.comment.create({ id: ref(o.issue), text: o.words.join(" ") }),
    said: () => t("cli.issue.commented", { issue: `#${ref(o.issue)}` }),
  }),
).pipe(
  Command.withDescription(t("cli.command.issue.comment")),
  Command.withExamples([{ command: t("cli.example.issue.comment.run"), description: t("cli.example.issue.comment.about") }]),
);

/** `issue review 12 --pass`: the verdict on what was handed back; completing it is `issue status 12 done`. */
const reviewCommand = Command.make(
  "review",
  {
    issue: issueArg,
    pass: Flag.Boolean("pass").pipe(Flag.withDefault(false), Flag.withDescription(t("cli.flag.pass"))),
    fail: Flag.Boolean("fail").pipe(Flag.withDefault(false), Flag.withDescription(t("cli.flag.fail"))),
    finding: Flag.String("finding").pipe(Flag.atLeast(0), Flag.withDescription(t("cli.flag.finding"))),
    comment: optionalText("comment", "cli.flag.reviewComment"),
  },
  (o) => {
    if (o.pass === o.fail) return Effect.fail(new Failure({ code: exit.usage, tag: "InvalidValue", text: t("cli.issue.passOrFail") }));
    const text = given(o.comment);
    return change({
      name: "issue review",
      does: (api) =>
        api.issue.review({ id: ref(o.issue), pass: o.pass, ...(o.finding.length > 0 ? { findings: [...o.finding] } : {}), ...(text ? { text } : {}) }),
      said: issueLine,
    });
  },
).pipe(
  Command.withDescription(t("cli.command.issue.review")),
  Command.withExamples([
    { command: "vibevalley issue review 12 --pass", description: t("cli.example.issueReviewPass.about") },
    { command: t("cli.example.issueReviewFail.run"), description: t("cli.example.issueReviewFail.about") },
  ]),
);

const changesText = (c: T.Changes) =>
  [
    ...c.commits.map((x) => `${x.hash.slice(0, 7)}  ${x.subject}`),
    ...c.files.map((f) => `  ${f.status}  ${f.path}  +${f.added} -${f.removed}`),
    ...(c.conflicts.length > 0 ? [t("cli.issue.conflicts", { files: c.conflicts.join(", ") })] : []),
  ].join("\n") || t("cli.issue.noChanges");

const diffCommand = Command.make("diff", { issue: issueArg }, (o) =>
  Effect.flatMap(
    ask((api) => api.issue.diff.get({ id: ref(o.issue) })),
    (c) => show(c, changesText),
  ),
).pipe(
  Command.withDescription(t("cli.command.issue.diff")),
  Command.withExamples([{ command: "vibevalley issue diff 12", description: t("cli.example.issueDiff.about") }]),
);

const timelineCommand = Command.make("timeline", { issue: issueArg }, (o) =>
  Effect.flatMap(
    ask((api) => api.issue.timeline.get({ id: ref(o.issue) })),
    (tl) =>
      show(tl, (x) =>
        [
          ...x.milestones.map((m) => `${new Date(m.at).toISOString().slice(0, 16).replace("T", " ")}  ${m.kind}${m.who ? `  ${m.who}` : ""}  ${m.text}`),
          ...(x.spent ? [t("cli.issue.spent", { tokens: x.spent.tokens, cny: x.spent.cny?.toFixed(2) ?? "-" })] : []),
        ].join("\n"),
      ),
  ),
).pipe(
  Command.withDescription(t("cli.command.issue.timeline")),
  Command.withExamples([{ command: "vibevalley issue timeline 12", description: t("cli.example.issueTimeline.about") }]),
);

const deleteCommand = Command.make("delete", { issue: issueArg }, (o) =>
  change({
    name: "issue delete",
    preview: (api) => api.issue.previewDelete({ id: ref(o.issue) }),
    does: (api) => api.issue.delete({ id: ref(o.issue) }),
    said: () => t("cli.issue.deleted", { issue: `#${ref(o.issue)}` }),
  }),
).pipe(
  Command.withDescription(t("cli.command.issue.delete")),
  Command.withExamples([{ command: "vibevalley issue delete 12 --dry-run", description: t("cli.example.issueDelete.about") }]),
);

/** Only what `issue show --watch` reads of a frame; the rest is left as it came. */
const IssuesOfFrame = Schema.fromJsonString(
  Schema.Struct({
    state: Schema.Struct({
      issues: Schema.Array(Schema.Struct({ id: Schema.String, status: S.IssueStatus, stage: Schema.Struct({ state: S.IssueStageKind }) })),
    }),
  }),
);
/** Where it waits on the owner or is over: what --watch waits for. */
const settled = new Set<T.IssueStatus>(["in_review", "done", "canceled"]);

/** Follows the issue in the core state until it waits on the owner or is over, each status on stderr; one that already
 * does is not waited for. */
const followed = Effect.fn("Cli.followed")(function* (issue: T.Issue, timeout: number | undefined) {
  const base = yield* ServerFlag;
  const follow = frames(base, statePath).pipe(
    Stream.mapEffect((data) =>
      Schema.decodeEffect(IssuesOfFrame)(data).pipe(Effect.mapError((e) => new Failure({ code: exit.other, tag: "Server", text: e.message }))),
    ),
    Stream.mapEffect((frame) => {
      const now = frame.state.issues.find((i) => i.id === issue.id);
      return now ? Effect.succeed(now) : Effect.fail(new Failure({ code: exit.missing, tag: "Missing", text: t("cli.failure.gone", { n: issue.number }) }));
    }),
    Stream.changesWith((a, b) => a.status === b.status && a.stage.state === b.stage.state),
    Stream.tap((now) => err(JSON.stringify({ issue: issue.number, status: now.status, stage: now.stage.state }))),
    Stream.takeUntil((now) => settled.has(now.status) || stageWantsOwner(now.stage.state)),
    Stream.runDrain,
  );
  yield* timeout === undefined
    ? follow
    : follow.pipe(
        Effect.timeoutOrElse({
          duration: `${timeout} seconds`,
          orElse: () => new Failure({ code: exit.other, tag: "Timeout", text: t("cli.issue.timeout", { issue: `#${issue.number}`, seconds: timeout }) }),
        }),
      );
});

/** `issue show 12`: the issue; --watch follows it first, until it waits on the owner or is over (as `kubectl get -w`). */
const showCommand = Command.make(
  "show",
  {
    issue: issueArg,
    watch: Flag.Boolean("watch").pipe(Flag.withDefault(false), Flag.withDescription(t("cli.flag.issueWatch"))),
    timeout: Flag.Int("timeout").pipe(Flag.optional, Flag.withDescription(t("cli.flag.timeout"))),
  },
  (o) =>
    Effect.gen(function* () {
      const issue = yield* ask((api) => api.issue.get({ id: ref(o.issue) }));
      if (!o.watch) return yield* show(issue, issueText);
      yield* followed(issue, given(o.timeout));
      yield* show(yield* ask((api) => api.issue.get({ id: issue.id })), issueText);
    }),
).pipe(
  Command.withDescription(t("cli.command.issue.show")),
  Command.withExamples([
    { command: "vibevalley issue show 12", description: t("cli.example.issueShow.about") },
    { command: "vibevalley issue show 12 --watch --timeout 600", description: t("cli.example.issueWatch.about") },
  ]),
);

export const issueCommand = Command.make("issue").pipe(
  Command.withSubcommands([
    listCommand,
    showCommand,
    createCommand,
    editCommand,
    statusCommand,
    commentCommand,
    reviewCommand,
    diffCommand,
    timelineCommand,
    deleteCommand,
  ]),
  Command.withDescription(t("cli.group.issue.about")),
);
