import { readFile, realpath, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";

import { Effect } from "effect";

import type * as T from "@vibevalley/protocol";
import * as S from "@vibevalley/protocol/schema";

import { Artifact } from "@/artifact/artifact.ts";
import { artifactMax } from "@/artifact/policy.ts";
import { Channel } from "@/channel/chat.ts";
import { messageOf, type ApiError, reasonOf, refused } from "@/errors.ts";
import { Session } from "@/session/session.ts";

import { type Caller, type Who, type Orchestrator, type SessionInput, refuse, callerOf, tool, sessionSchemaTool } from "./definition.ts";
import { answers, blockLine } from "./prompts.ts";

export const artifactTools = (findIssue: (key: string) => Effect.Effect<T.Issue | string>) =>
  Effect.gen(function* () {
    const run = yield* Session;
    const chat = yield* Channel;
    const artifacts = yield* Artifact;

    // Artifacts (artifact/): the orchestrator's and a session's take the same endpoints; a session's are made for its issue
    // and announced in its issue thread, the orchestrator's where it is answering.
    const artifactSaid = (e: Effect.Effect<string, ApiError>) => Effect.catch(e, (err) => Effect.succeed(answers.failed(reasonOf(err))));

    /** A version's words: given as they are, or read from a file in the session's working directory. The path is resolved
     * with its links, so neither .. nor a link leads out of the directory. */
    const artifactWords = (c: Caller, content: string | undefined, file: string | undefined) =>
      Effect.gen(function* () {
        if (content !== undefined && file !== undefined) return yield* Effect.fail(refused(answers.artifact.both));
        if (content !== undefined) return content;
        if (file === undefined || file.trim() === "") return yield* Effect.fail(refused(answers.artifact.noContent));
        const cwd = c.session ? run.find(c.session)?.place.cwd : undefined;
        if (!cwd) return yield* Effect.fail(refused(answers.artifact.noPlace));
        const unread = (e: unknown) => refused(messageOf(e));
        const root = yield* Effect.tryPromise({ try: () => realpath(cwd), catch: unread });
        const full = yield* Effect.tryPromise({ try: () => realpath(resolve(root, file)), catch: () => refused(answers.artifact.notFile(file)) });
        if (full !== root && !full.startsWith(root + sep)) return yield* Effect.fail(refused(answers.artifact.outside(file)));
        const info = yield* Effect.tryPromise({ try: () => stat(full), catch: unread });
        if (!info.isFile()) return yield* Effect.fail(refused(answers.artifact.notFile(file)));
        // Read whole only when it may be kept; a bigger one is refused by its size as artifact.create would.
        if (info.size > artifactMax) return "x".repeat(artifactMax + 1);
        return yield* Effect.tryPromise({ try: () => readFile(full, "utf8"), catch: unread });
      });

    const artifactList = (who: Who) =>
      tool(
        "artifact.list",
        Effect.fn("Tool.artifactList")(function* (p: Orchestrator<"artifact.list">) {
          yield* callerOf(who);
          let issueId: string | undefined;
          if (p.issue) {
            const item = yield* findIssue(p.issue);
            if (typeof item === "string") return item;
            issueId = item.id;
          }
          const listed = (channel?: string) =>
            Effect.map(artifacts.list({ ...(issueId ? { issue: issueId } : {}), ...(channel ? { channel } : {}) }), (all) =>
              all.length === 0 ? answers.artifact.none : all.map(answers.artifact.line).join("\n"),
            );
          if (!p.channel) return yield* listed();
          return yield* chat
            .placeOf("", p.channel)
            .pipe(Effect.matchEffect({ onFailure: (e) => Effect.succeed(answers.failed(reasonOf(e))), onSuccess: listed }));
        }),
      );

    const sessionArtifactList = (who: Who) =>
      sessionSchemaTool(
        "artifact.list",
        Effect.fn("Tool.artifactList")(function* (p: SessionInput<"artifact.list">) {
          const c = yield* callerOf(who);
          const own = run.sessionOf(c.session)?.issue;
          const listed = (where: { readonly channel?: string; readonly issue?: string }) =>
            Effect.map(artifacts.list(where), (all) => (all.length === 0 ? answers.artifact.none : all.map(answers.artifact.line).join("\n")));
          if (!p.channel) return yield* listed(own ? { issue: own } : {});
          return yield* chat
            .placeOf(c.session, p.channel)
            .pipe(Effect.matchEffect({ onFailure: (e) => Effect.succeed(answers.failed(reasonOf(e))), onSuccess: (channel) => listed({ channel }) }));
        }),
      );

    const artifactGet = (table: "orchestrator" | "session") => (who: Who) =>
      (table === "orchestrator" ? tool : sessionSchemaTool)(
        "artifact.get",
        Effect.fn("Tool.artifactGet")(function* (p: { readonly id: string }) {
          yield* callerOf(who);
          return yield* artifactSaid(Effect.map(artifacts.get(S.artifactId(p.id.trim())), answers.artifact.detail));
        }),
      );

    const artifactContent = (table: "orchestrator" | "session") => (who: Who) =>
      (table === "orchestrator" ? tool : sessionSchemaTool)(
        "artifact.content.get",
        Effect.fn("Tool.artifactContent")(function* (p: { readonly id: string; readonly version?: number }) {
          yield* callerOf(who);
          return yield* artifactSaid(
            Effect.flatMap(artifacts.get(S.artifactId(p.id.trim())), (a) =>
              a.body === "blocks"
                ? Effect.map(artifacts.blocks(a.id), (snap) => [answers.block.header(a.title, snap.blocks.length), ...snap.blocks.map(blockLine)].join("\n"))
                : Effect.map(artifacts.content(a.id, p.version), (c) => answers.artifact.content(a.title, c.version, c.content)),
            ),
          );
        }),
      );

    const artifactCreate = (who: Who) =>
      tool(
        "artifact.create",
        Effect.fn("Tool.artifactCreate")(function* (p: Orchestrator<"artifact.create">) {
          const c = yield* callerOf(who);
          let issueId: string | undefined;
          if (p.issue) {
            const item = yield* findIssue(p.issue);
            if (typeof item === "string") return item;
            issueId = item.id;
          }
          return yield* artifactSaid(
            Effect.gen(function* () {
              const content = yield* artifactWords(c, p.content, undefined);
              const made = yield* artifacts.create(
                { from: c.agent, by: c.agent },
                {
                  title: p.title,
                  kind: p.kind,
                  content,
                  ...(p.note ? { note: p.note } : {}),
                  channel: p.channel ?? c.here,
                  ...(issueId ? { issue: issueId } : {}),
                },
              );
              return answers.artifact.made(made);
            }),
          );
        }),
      );

    const sessionArtifactCreate = (who: Who) =>
      sessionSchemaTool(
        "artifact.create",
        Effect.fn("Tool.artifactCreate")(function* (p: SessionInput<"artifact.create">) {
          const c = yield* callerOf(who);
          const own = run.sessionOf(c.session)?.issue;
          return yield* artifactSaid(
            Effect.gen(function* () {
              const content = yield* artifactWords(c, p.content, p.file);
              const made = yield* artifacts.create(
                { from: c.session, by: c.agent },
                { title: p.title, kind: p.kind, content, ...(p.note ? { note: p.note } : {}), ...(own ? { issue: own } : {}) },
              );
              return answers.artifact.made(made);
            }),
          );
        }),
      );

    const artifactVersion = (table: "orchestrator" | "session") => (who: Who) =>
      (table === "orchestrator" ? tool : sessionSchemaTool)(
        "artifact.version.create",
        Effect.fn("Tool.artifactVersion")(function* (p: { readonly id: string; readonly content?: string; readonly file?: string; readonly note?: string }) {
          const c = yield* callerOf(who);
          return yield* artifactSaid(
            Effect.gen(function* () {
              const content = yield* artifactWords(c, p.content, p.file);
              const made = yield* artifacts.version(
                { from: c.session || c.agent, by: c.agent },
                { id: S.artifactId(p.id.trim()), content, ...(p.note ? { note: p.note } : {}) },
              );
              return answers.artifact.versioned(made);
            }),
          );
        }),
      );

    // A blocks artifact: the orchestrator's and a session's insert, rewrite and delete a block through the same op
    // pipeline the owner's editor uses, written as the agent's profile (its session id when it has none).
    const writer = (c: Caller) => c.agent || c.session;

    interface BlockCreateInput {
      readonly id: string;
      readonly type?: string;
      readonly level?: number;
      readonly checked?: boolean;
      readonly language?: string;
      readonly text: string;
      readonly afterBlock?: string;
      readonly parentId?: string;
    }

    interface BlockUpdateInput {
      readonly id: string;
      readonly block: string;
      readonly baseRev: number;
      readonly text?: string;
      readonly type?: string;
      readonly level?: number;
      readonly checked?: boolean;
      readonly language?: string;
    }

    const insert = (c: Caller, p: BlockCreateInput) =>
      Effect.gen(function* () {
        const r = yield* artifacts.insertBlock(S.artifactId(p.id.trim()), writer(c), {
          text: p.text,
          ...(p.type !== undefined ? { type: p.type } : {}),
          ...(p.level !== undefined ? { level: p.level } : {}),
          ...(p.checked !== undefined ? { checked: p.checked } : {}),
          ...(p.language !== undefined ? { language: p.language } : {}),
          ...(p.afterBlock !== undefined ? { afterBlock: S.blockId(p.afterBlock) } : {}),
          ...(p.parentId !== undefined && p.parentId.trim() !== "" ? { parentId: S.blockId(p.parentId) } : {}),
        });
        if (r.status !== "applied") return yield* refuse(r.reason ?? "");
        return answers.block.appended(r.blockId, r.rev ?? 0);
      });

    const update = (c: Caller, p: BlockUpdateInput) =>
      Effect.gen(function* () {
        const r = yield* artifacts.updateBlock(S.artifactId(p.id.trim()), writer(c), {
          block: S.blockId(p.block),
          baseRev: p.baseRev,
          ...(p.text !== undefined ? { text: p.text } : {}),
          ...(p.type !== undefined ? { type: p.type } : {}),
          ...(p.level !== undefined ? { level: p.level } : {}),
          ...(p.checked !== undefined ? { checked: p.checked } : {}),
          ...(p.language !== undefined ? { language: p.language } : {}),
        });
        if (r.status === "applied") return answers.block.updated(r.blockId, r.rev);
        if (r.status === "conflict") {
          const now = yield* Effect.orElseSucceed(artifacts.blocks(S.artifactId(p.id.trim())), () => undefined);
          const x = now?.blocks.find((b) => b.id === r.blockId);
          return answers.block.notUpdated(r.reason, r.rev, x ? blockLine(x) : "");
        }
        return yield* refuse(r.reason ?? "");
      });

    const remove = (c: Caller, p: { readonly id: string; readonly block: string }) =>
      Effect.gen(function* () {
        const r = yield* artifacts.deleteBlock(S.artifactId(p.id.trim()), writer(c), { block: S.blockId(p.block) });
        if (r.status === "applied") return answers.block.deleted(r.blockId);
        if (r.status === "noop") return answers.block.alreadyDeleted(r.blockId);
        return yield* refuse(r.reason ?? "");
      });

    const blockCreate = (who: Who) =>
      sessionSchemaTool(
        "artifact.block.create",
        Effect.fn("Tool.blockCreate")(function* (p: SessionInput<"artifact.block.create">) {
          return yield* insert(yield* callerOf(who), p);
        }),
      );

    const orchestratorBlockCreate = (who: Who) =>
      tool(
        "artifact.block.create",
        Effect.fn("Tool.blockCreate")(function* (p: Orchestrator<"artifact.block.create">) {
          return yield* insert(yield* callerOf(who), p);
        }),
      );

    const blockUpdate = (who: Who) =>
      sessionSchemaTool(
        "artifact.block.update",
        Effect.fn("Tool.blockUpdate")(function* (p: SessionInput<"artifact.block.update">) {
          return yield* update(yield* callerOf(who), p);
        }),
      );

    const orchestratorBlockUpdate = (who: Who) =>
      tool(
        "artifact.block.update",
        Effect.fn("Tool.blockUpdate")(function* (p: Orchestrator<"artifact.block.update">) {
          return yield* update(yield* callerOf(who), p);
        }),
      );

    const blockDelete = (who: Who) =>
      sessionSchemaTool(
        "artifact.block.delete",
        Effect.fn("Tool.blockDelete")(function* (p: SessionInput<"artifact.block.delete">) {
          return yield* remove(yield* callerOf(who), p);
        }),
      );

    const orchestratorBlockDelete = (who: Who) =>
      tool(
        "artifact.block.delete",
        Effect.fn("Tool.blockDelete")(function* (p: Orchestrator<"artifact.block.delete">) {
          return yield* remove(yield* callerOf(who), p);
        }),
      );

    return {
      artifactList,
      sessionArtifactList,
      artifactGet,
      artifactContent,
      artifactCreate,
      sessionArtifactCreate,
      artifactVersion,
      blockCreate,
      orchestratorBlockCreate,
      blockUpdate,
      orchestratorBlockUpdate,
      blockDelete,
      orchestratorBlockDelete,
    };
  });
