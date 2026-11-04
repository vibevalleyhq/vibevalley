// `vibevalley issue …`: what an agent does with issues, a command a thing to do. What an issue can do now is the
// server's word (its stage's acts, as its page has them); a verb asks for one of them and says which others there are
// when it is not one of them.

import { Effect, Schema, Stream } from "effect";
import { Argument, Command, Flag } from "effect/cli";

import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { IssueStatusValues, PriorityValues, statePath } from "@vibevalley/protocol";
import { issueVerbs } from "@vibevalley/protocol/api";
import * as S from "@vibevalley/protocol/schema";

import { DryRunFlag, frames, ServerFlag } from "./api.ts";
import { ask, change, given, show } from "./farm.ts";
import { exit, Failure, err, stdinText } from "./output.ts";

const issueArg = Argument.String("issue").pipe(Argument.withDescription(t("cli.arg.issue")));
const wordsArg = (name: string) => Argument.String(name).pipe(Argument.variadic(), Argument.withDescription(t("cli.arg.words")));
const optionalText = (name: string) => Flag.String(name).pipe(Flag.optional);

/** #12 or 12: the issue's number, as the server takes it. */
const ref = (said: string) => said.replace(/^#/u, "");

/** Whose it is: the profile of its latest assignment. */
const agentOf = (i: T.Issue) => i.assignments.at(-1)?.agent;

/** One line an issue: what to name it by first, then where it stands, its title, who has it and where. */
const issueLine = (i: T.Issue) =>
  [`#${i.number}`, i.stage.state, i.title, agentOf(i) === undefined ? "" : `@${agentOf(i)}`, i.project === undefined ? "" : `[${i.project}]`]
    .filter((p) => p !== "")
    .join("  ");

/** What can be done with it now, as commands: the lead first, as the server orders them. */
const nextOf = (i: T.Issue) => [...new Set(i.stage.acts.map((a) => issueVerbs[a.act]))].map((verb) => ({ say: verb, run: ["issue", verb, String(i.number)] }));

const issueText = (i: T.Issue) =>
  [
    `#${i.number}  ${i.title}`,
    `${i.stage.state}${i.stage.stuck ? ` (${i.stage.stuck})` : ""}  ${i.priority}${i.project ? `  [${i.project}]` : ""}${agentOf(i) ? `  @${agentOf(i)}` : ""}`,
    ...(i.description.trim() === "" ? [] : ["", i.description.trim()]),
    ...(i.criteria.length === 0 ? [] : ["", t("cli.issue.criteria"), ...i.criteria.map((c, n) => `  ${n + 1}. ${c}`)]),
    ...(i.questions.length === 0
      ? []
      : ["", t("cli.issue.questions"), ...i.questions.map((q) => `  ? ${q.question}${q.options.length > 0 ? `  (${q.options.join(" | ")})` : ""}`)]),
    "",
    t("cli.issue.can", {
      verbs:
        nextOf(i)
          .map((n) => n.say)
          .join(", ") || "-",
    }),
  ].join("\n");

/** The first act the issue offers of those wanted, done: a move, a word to its helper, or stopping its helper. Quiet, it
 * prints nothing (issue work answers with the changes it waits for). */
const act = (name: string, said: string, wanted: readonly T.IssueAct[], words: string | undefined, quiet = false) =>
  Effect.gen(function* () {
    const issue = yield* ask((api) => api.issue.get({ id: ref(said) }));
    const action: T.IssueAction | undefined = issue.stage.acts.find((a) => wanted.includes(a.act));
    if (!action)
      return yield* new Failure({
        code: exit.refused,
        tag: "Refused",
        text: t("cli.issue.cannot", { issue: `#${issue.number}`, state: issue.stage.state, verb: name }),
        next: nextOf(issue),
      });
    const id = issue.id;
    switch (action.does) {
      case "move": {
        if (action.words === "required" && !words)
          return yield* new Failure({ code: exit.usage, tag: "MissingArgument", text: t("cli.issue.needsWords", { verb: name }) });
        const request = { id, status: action.status, ...(words ? { text: words } : {}) };
        return yield* change({
          name: `issue ${name}`,
          preview: (api) => api.issue.status.previewUpdate(request),
          does: (api) => api.issue.status.update(request),
          said: (i) => issueLine(i),
          quiet,
        });
      }
      case "say": {
        if (!words) return yield* new Failure({ code: exit.usage, tag: "MissingArgument", text: t("cli.issue.needsWords", { verb: name }) });
        return yield* change({
          name: `issue ${name}`,
          does: (api) => api.issue.comment.create({ id, text: words }),
          said: () => t("cli.issue.told", { issue: `#${issue.number}` }),
        });
      }
      case "stop": {
        const session = issue.assignments.at(-1)?.executions.at(-1)?.session;
        if (session === undefined)
          return yield* new Failure({ code: exit.refused, tag: "Refused", text: t("cli.issue.noHelper", { issue: `#${issue.number}` }) });
        return yield* change({
          name: `issue ${name}`,
          does: (api) => api.session.stop({ id: session }),
          said: () => t("cli.issue.stopped", { issue: `#${issue.number}` }),
        });
      }
    }
  });

const joined = (words: readonly string[]) => (words.length > 0 ? words.join(" ") : undefined);

const listCommand = Command.make(
  "list",
  {
    status: Flag.Literals("status", IssueStatusValues).pipe(Flag.optional, Flag.withDescription(t("cli.flag.issueStatus"))),
    project: optionalText("project").pipe(Flag.withDescription(t("cli.flag.project"))),
    text: optionalText("text").pipe(Flag.withDescription(t("cli.flag.text"))),
    waiting: Flag.Boolean("waiting").pipe(Flag.withDefault(false), Flag.withDescription(t("cli.flag.waiting"))),
    limit: Flag.Int("limit").pipe(Flag.withDefault(20), Flag.withDescription(t("cli.flag.limit"))),
  },
  (o) =>
    Effect.gen(function* () {
      const status = given(o.status);
      const project = given(o.project);
      const text = given(o.text);
      const issues = yield* ask((api) =>
        api.issue.list({
          limit: o.limit + 1,
          ...(status ? { status } : {}),
          ...(project ? { project } : {}),
          ...(text ? { text } : {}),
          ...(o.waiting ? { wantsOwner: true } : {}),
        }),
      );
      const shown = issues.slice(0, o.limit);
      yield* show(
        shown,
        (list) =>
          [...list.map(issueLine), ...(issues.length > o.limit ? [t("cli.more", { flag: `--limit ${o.limit * 2}` })] : [])].join("\n") || t("cli.issue.none"),
      );
    }),
).pipe(
  Command.withDescription(t("cli.command.issue.list")),
  Command.withExamples([
    { command: "vibevalley issue list", description: t("cli.example.issueList.about") },
    { command: "vibevalley issue list --waiting", description: t("cli.example.issueWaiting.about") },
  ]),
);

const showCommand = Command.make("show", { issue: issueArg }, (o) =>
  Effect.flatMap(
    ask((api) => api.issue.get({ id: ref(o.issue) })),
    (i) => show(i, issueText),
  ),
).pipe(
  Command.withDescription(t("cli.command.issue.show")),
  Command.withExamples([{ command: "vibevalley issue show 12", description: t("cli.example.issueShow.about") }]),
);

const newCommand = Command.make(
  "new",
  {
    title: wordsArg("title"),
    body: optionalText("body").pipe(Flag.withDescription(t("cli.flag.body"))),
    project: optionalText("project").pipe(Flag.withDescription(t("cli.flag.project"))),
    agent: optionalText("agent").pipe(Flag.withDescription(t("cli.flag.agent"))),
    priority: Flag.Literals("priority", PriorityValues).pipe(Flag.optional, Flag.withDescription(t("cli.flag.priority"))),
    criterion: Flag.String("criterion").pipe(Flag.atLeast(0), Flag.withDescription(t("cli.flag.criterion"))),
    key: optionalText("key").pipe(Flag.withDescription(t("cli.flag.key"))),
  },
  (o) =>
    Effect.gen(function* () {
      const said = given(o.body);
      const description = said === "-" ? yield* stdinText.pipe(Effect.orElseSucceed(() => "")) : said;
      const fields = { project: given(o.project), agent: given(o.agent), priority: given(o.priority), requestKey: given(o.key) };
      const request = {
        title: o.title.join(" "),
        ...(description ? { description } : {}),
        ...(fields.project ? { project: fields.project } : {}),
        ...(fields.agent ? { agent: fields.agent } : {}),
        ...(fields.priority ? { priority: fields.priority } : {}),
        ...(fields.requestKey ? { requestKey: fields.requestKey } : {}),
      };
      yield* change({
        name: "issue new",
        // Criteria are the issue's to keep once it is made: set right after, in the same command.
        does: (api) =>
          api.issue.create(request).then((made) => (o.criterion.length > 0 ? api.issue.update({ id: made.id, criteria: [...o.criterion] }) : made)),
        said: (i) => issueLine(i),
      });
    }),
).pipe(
  Command.withDescription(t("cli.command.issue.new")),
  Command.withExamples([{ command: t("cli.example.issueNew.run"), description: t("cli.example.issueNew.about") }]),
);

const editCommand = Command.make(
  "edit",
  {
    issue: issueArg,
    title: optionalText("title"),
    body: optionalText("body").pipe(Flag.withDescription(t("cli.flag.body"))),
    project: optionalText("project").pipe(Flag.withDescription(t("cli.flag.project"))),
    agent: optionalText("agent").pipe(Flag.withDescription(t("cli.flag.agent"))),
    priority: Flag.Literals("priority", PriorityValues).pipe(Flag.optional, Flag.withDescription(t("cli.flag.priority"))),
  },
  (o) => {
    const title = given(o.title);
    const description = given(o.body);
    const project = given(o.project);
    const agent = given(o.agent);
    const priority = given(o.priority);
    return change({
      name: "issue edit",
      does: (api) =>
        api.issue.update({
          id: ref(o.issue),
          ...(title ? { title } : {}),
          ...(description ? { description } : {}),
          ...(project ? { project } : {}),
          ...(agent ? { agent } : {}),
          ...(priority ? { priority } : {}),
        }),
      said: (i) => issueLine(i),
    });
  },
).pipe(
  Command.withDescription(t("cli.command.issue.edit")),
  Command.withExamples([{ command: "vibevalley issue edit 12 --priority high", description: t("cli.example.issueEdit.about") }]),
);

/** Only what `issue work` reads of a frame; the rest is left as it came. */
const IssuesOfFrame = Schema.fromJsonString(
  Schema.Struct({ state: Schema.Struct({ issues: Schema.Array(Schema.Struct({ id: Schema.String, status: S.IssueStatus })) }) }),
);
const settled = new Set<string>(["in_review", "done", "canceled"] satisfies (typeof IssueStatusValues)[number][]);

const changesText = (c: T.Changes) =>
  [
    ...c.commits.map((x) => `${x.hash.slice(0, 7)}  ${x.subject}`),
    ...c.files.map((f) => `  ${f.status}  ${f.path}  +${f.added} -${f.removed}`),
    ...(c.conflicts.length > 0 ? [t("cli.issue.conflicts", { files: c.conflicts.join(", ") })] : []),
  ].join("\n") || t("cli.issue.noChanges");

const workActs: readonly T.IssueAct[] = ["start", "resume", "cure", "resolve"];

/** `issue work 12`: starts it (or sends it on when it is stuck), then, unless --no-wait, follows it in the core state until
 * it is handed back, done or canceled, each status on stderr, and prints its changes. */
const workCommand = Command.make(
  "work",
  {
    issue: issueArg,
    noWait: Flag.Boolean("no-wait").pipe(Flag.withDefault(false), Flag.withDescription(t("cli.flag.noWait"))),
    timeout: Flag.Int("timeout").pipe(Flag.optional, Flag.withDescription(t("cli.flag.timeout"))),
  },
  (o) =>
    Effect.gen(function* () {
      const before = yield* ask((api) => api.issue.get({ id: ref(o.issue) }));
      // Already at work, followed as it is; handed back or done, said as it stands: asked again, work does no harm.
      const active = before.stage.state === "queued" || before.stage.state === "working";
      const startable = before.stage.acts.some((a) => workActs.includes(a.act));
      const waits = !(yield* DryRunFlag) && !o.noWait;
      if (!active && startable) yield* act("work", o.issue, workActs, undefined, waits);
      if (!waits) return;
      const base = yield* ServerFlag;
      const follow = frames(base, statePath).pipe(
        Stream.mapEffect((data) =>
          Schema.decodeEffect(IssuesOfFrame)(data).pipe(Effect.mapError((e) => new Failure({ code: exit.other, tag: "Server", text: e.message }))),
        ),
        Stream.mapEffect((frame) => {
          const now = frame.state.issues.find((i) => i.id === before.id);
          return now
            ? Effect.succeed(now.status)
            : Effect.fail(new Failure({ code: exit.missing, tag: "Missing", text: t("cli.failure.gone", { n: before.number }) }));
        }),
        Stream.changes,
        Stream.tap((status) => err(JSON.stringify({ issue: before.number, status }))),
        Stream.takeUntil((status) => settled.has(status)),
        Stream.runDrain,
      );
      const timeout = given(o.timeout);
      yield* timeout === undefined
        ? follow
        : follow.pipe(
            Effect.timeoutOrElse({
              duration: `${timeout} seconds`,
              orElse: () => new Failure({ code: exit.other, tag: "Timeout", text: t("cli.issue.timeout", { issue: `#${before.number}`, seconds: timeout }) }),
            }),
          );
      const after = yield* ask((api) => api.issue.get({ id: before.id }));
      yield* err(issueLine(after));
      yield* Effect.flatMap(
        ask((api) => api.issue.diff.get({ id: before.id })),
        (c) => show(c, changesText),
      );
    }),
).pipe(
  Command.withDescription(t("cli.command.issue.work")),
  Command.withExamples([
    { command: "vibevalley issue work 12", description: t("cli.example.issueWork.about") },
    { command: "vibevalley issue work 12 --no-wait", description: t("cli.example.issueWorkNoWait.about") },
  ]),
);

const actCommand = (
  verb: "say" | "answer" | "accept" | "reject" | "stop" | "cancel" | "reopen",
  wanted: readonly T.IssueAct[],
  words: "none" | "optional" | "required",
) =>
  Command.make(verb, { issue: issueArg, words: wordsArg("words") }, (o) => {
    const said = joined(o.words);
    if (words === "required" && !said) return Effect.fail(new Failure({ code: exit.usage, tag: "MissingArgument", text: t("cli.issue.needsWords", { verb }) }));
    return act(verb, o.issue, wanted, said);
  }).pipe(
    Command.withDescription(t(`cli.command.issue.${verb}`)),
    Command.withExamples([{ command: t(`cli.example.issue.${verb}.run`), description: t(`cli.example.issue.${verb}.about`) }]),
  );

const diffCommand = Command.make("diff", { issue: issueArg }, (o) =>
  Effect.flatMap(
    ask((api) => api.issue.diff.get({ id: ref(o.issue) })),
    (c) => show(c, changesText),
  ),
).pipe(
  Command.withDescription(t("cli.command.issue.diff")),
  Command.withExamples([{ command: "vibevalley issue diff 12", description: t("cli.example.issueDiff.about") }]),
);

const logCommand = Command.make("log", { issue: issueArg }, (o) =>
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
  Command.withDescription(t("cli.command.issue.log")),
  Command.withExamples([{ command: "vibevalley issue log 12", description: t("cli.example.issueLog.about") }]),
);

export const issueCommand = Command.make("issue").pipe(
  Command.withSubcommands([
    listCommand,
    showCommand,
    newCommand,
    editCommand,
    workCommand,
    actCommand("say", ["tell"], "required"),
    actCommand("answer", ["answer"], "required"),
    actCommand("accept", ["complete", "acknowledge"], "none"),
    actCommand("reject", ["reject"], "required"),
    actCommand("stop", ["stop"], "none"),
    actCommand("cancel", ["close"], "optional"),
    actCommand("reopen", ["reopen"], "optional"),
    diffCommand,
    logCommand,
  ]),
  Command.withDescription(t("cli.group.issue.about")),
);
