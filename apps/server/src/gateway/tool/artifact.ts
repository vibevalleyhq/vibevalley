import { artifactMax, htmlCheck } from "@vibevalley/artifact/html";
import type * as T from "@vibevalley/protocol";
import { isApiError } from "@vibevalley/protocol/api";
import { issueScopeOf } from "@vibevalley/protocol/rules";
import * as S from "@vibevalley/protocol/schema";

import type { Caller, Who } from "#/base/actor.ts";
import { BizCode, reasonOf, refuseIn } from "#/base/errors.ts";
import { NotWorkFile } from "#/modules/session/session.ts";

import { answers, blockLine } from "./prompts.ts";
import { answered, type Orchestrator, type SessionInput, refuse, callerOf, tool, sessionSchemaTool } from "./schemas.ts";
import type { ToolDeps } from "./tool.ts";

const refused = refuseIn(BizCode.ArtifactRefused);

/** A refusal of the artifact service's is the answer; anything else fails the call. */
const refusalAnswered = async (work: () => Promise<string>): Promise<string> => {
  try {
    return await work();
  } catch (e) {
    if (isApiError(e)) return answers.failed(reasonOf(e));
    throw e;
  }
};

export function artifactTools(deps: Pick<ToolDeps, "session" | "channel" | "artifact" | "log">, findIssue: (key: string) => Promise<T.Issue>) {
  const { session: run, channel: chat, artifact: artifacts } = deps;
  const log = deps.log.child("tool");
  /** The run a maker is in, for the message that announces what it made. */
  const runOf = (who: string): { readonly run?: string } => {
    const now = run.live(who).run;
    return now ? { run: now } : {};
  };

  /** What a kept page will not do that its maker should hear about: the check let it through, the CSP stops it. */
  const warnings = (made: T.Artifact, content: string) => (made.body === "html" ? answers.artifact.warned(htmlCheck(content).warned) : "");

  const sessionArtifactScope = (session: string): { readonly channel?: string; readonly issue?: string } => {
    const own = run.live(session).session;
    const issue = own ? issueScopeOf(own) : undefined;
    return issue ? { issue } : own?.channel ? { channel: own.channel } : {};
  };

  /** A version's words: given as they are, or read from a file in the session's working directory. The path is resolved with its links, so neither .. */
  const artifactWords = async (c: Caller, content: string | undefined, file: string | undefined): Promise<string> => {
    if (content !== undefined && file !== undefined) throw refused(answers.artifact.both);
    if (content !== undefined) return content;
    if (file === undefined || file.trim() === "") throw refused(answers.artifact.noContent);
    if (!c.session) throw refused(answers.artifact.noPlace);
    try {
      const f = await run.workFile(c.session, file, artifactMax);
      return new TextDecoder().decode(f.bytes);
    } catch (e) {
      if (!(e instanceof NotWorkFile)) throw e;
      // A bigger one is refused by its size as artifact.create would.
      if (e.reason === "tooBig") return "x".repeat(artifactMax + 1);
      throw refused(
        e.reason === "noPlace"
          ? answers.artifact.noPlace
          : e.reason === "outside"
            ? answers.artifact.outside(file)
            : e.reason === "notFile"
              ? answers.artifact.notFile(file)
              : e.message,
      );
    }
  };

  const listedText = async (where: T.ArtifactListRequest) => {
    const all = await artifacts.list(where);
    return all.length === 0 ? answers.artifact.none : all.map(answers.artifact.line).join("\n");
  };

  /** The channel a caller names, or its refusal as the answer. */
  const placed = async (from: string, channel: string, then: (channel: string) => Promise<string>) => {
    let place: string;
    try {
      place = await chat.placeOf(from, channel);
    } catch (e) {
      if (!isApiError(e)) throw e;
      return answers.failed(reasonOf(e));
    }
    return then(place);
  };

  const artifactList = (who: Who) =>
    tool("artifact.list", (p: Orchestrator<"artifact.list">) =>
      answered(async () => {
        callerOf(who);
        const issueId = p.issue ? (await findIssue(p.issue)).id : undefined;
        const listed = (channel?: string) =>
          listedText({
            ...(issueId ? { issue: issueId } : {}),
            ...(channel ? { channel } : {}),
            ...(p.artifactType ? { artifactType: p.artifactType } : {}),
          });
        if (!p.channel) return listed();
        return placed("", p.channel, listed);
      }),
    );

  const sessionArtifactList = (who: Who) =>
    sessionSchemaTool("artifact.list", async (p: SessionInput<"artifact.list">) => {
      const c = callerOf(who);
      const typeFilter = p.artifactType ? { artifactType: p.artifactType } : {};
      if (!p.channel) return listedText({ ...sessionArtifactScope(c.session), ...typeFilter });
      return placed(c.session, p.channel, (channel) => listedText({ channel, ...typeFilter }));
    });

  const artifactGet = (table: "orchestrator" | "session") => (who: Who) =>
    (table === "orchestrator" ? tool : sessionSchemaTool)("artifact.get", (p: { readonly id: T.ArtifactId }) => {
      callerOf(who);
      return refusalAnswered(async () => answers.artifact.detail(await artifacts.get(p.id)));
    });

  const artifactContent = (table: "orchestrator" | "session") => (who: Who) =>
    (table === "orchestrator" ? tool : sessionSchemaTool)("artifact.content.get", (p: { readonly id: T.ArtifactId; readonly version?: number }) => {
      callerOf(who);
      return refusalAnswered(async () => {
        const a = await artifacts.get(p.id);
        if (a.body === "blocks") {
          const snap = await artifacts.blocks(a.id);
          return [answers.block.header(a.title, snap.blocks.length), ...snap.blocks.map(blockLine)].join("\n");
        }
        const c = await artifacts.content(a.id, p.version);
        return answers.artifact.content(a.title, c.version, c.content);
      });
    });

  const isStoreCreate = (p: {
    readonly artifactType?: T.ArtifactType | undefined;
    readonly kind?: "html" | "markdown" | "store" | undefined;
    readonly entries?: readonly T.ArtifactEntryWriteInput[] | undefined;
    readonly content?: string | undefined;
    readonly file?: string | undefined;
  }) =>
    (p.artifactType !== undefined && p.artifactType !== "docs") ||
    p.kind === "store" ||
    (p.entries !== undefined && p.content === undefined && p.file === undefined);

  const artifactCreate = (who: Who) =>
    tool("artifact.create", (p: Orchestrator<"artifact.create">) =>
      answered(async () => {
        const c = callerOf(who);
        const issueId = p.issue ? (await findIssue(p.issue)).id : undefined;
        return refusalAnswered(async () => {
          if (isStoreCreate(p) || (p.artifactType === "docs" && p.content === undefined)) {
            const made = await artifacts.create(
              { from: c.agent, by: c.agent, ...runOf(c.agent) },
              {
                title: p.title,
                ...(p.kind !== undefined ? { kind: p.kind } : {}),
                ...(p.artifactType !== undefined ? { artifactType: p.artifactType } : {}),
                ...(p.display !== undefined ? { display: p.display } : {}),
                ...(p.entries !== undefined ? { entries: p.entries } : {}),
                ...(p.isDefault !== undefined ? { isDefault: p.isDefault } : {}),
                ...(p.announce !== undefined ? { announce: p.announce } : {}),
                ...(p.note ? { note: p.note } : {}),
                channel: p.channel ?? c.here,
                ...(issueId ? { issue: issueId } : {}),
              },
            );
            return answers.artifact.made(made);
          }
          const content = await artifactWords(c, p.content, undefined);
          const made = await artifacts.create(
            { from: c.agent, by: c.agent, ...runOf(c.agent) },
            {
              title: p.title,
              kind: p.kind ?? "markdown",
              ...(p.artifactType !== undefined ? { artifactType: p.artifactType } : {}),
              ...(p.display !== undefined ? { display: p.display } : {}),
              ...(p.isDefault !== undefined ? { isDefault: p.isDefault } : {}),
              content,
              ...(p.note ? { note: p.note } : {}),
              channel: p.channel ?? c.here,
              ...(issueId ? { issue: issueId } : {}),
            },
          );
          return answers.artifact.made(made) + warnings(made, content);
        });
      }),
    );

  const sessionArtifactCreate = (who: Who) =>
    sessionSchemaTool("artifact.create", (p: SessionInput<"artifact.create">) => {
      const c = callerOf(who);
      return refusalAnswered(async () => {
        if (isStoreCreate(p) || (p.artifactType === "docs" && p.content === undefined && (p.file === undefined || p.file.trim() === ""))) {
          if (p.content !== undefined && p.file !== undefined) throw refused(answers.artifact.both);
          const made = await artifacts.create(
            { from: c.session, by: c.agent, ...runOf(c.session) },
            {
              title: p.title,
              ...(p.kind !== undefined ? { kind: p.kind } : {}),
              ...(p.artifactType !== undefined ? { artifactType: p.artifactType } : {}),
              ...(p.display !== undefined ? { display: p.display } : {}),
              ...(p.entries !== undefined ? { entries: p.entries } : {}),
              ...(p.isDefault !== undefined ? { isDefault: p.isDefault } : {}),
              ...(p.announce !== undefined ? { announce: p.announce } : {}),
              ...(p.note ? { note: p.note } : {}),
              ...sessionArtifactScope(c.session),
            },
          );
          return answers.artifact.made(made);
        }
        const content = await artifactWords(c, p.content, p.file);
        const made = await artifacts.create(
          { from: c.session, by: c.agent, ...runOf(c.session) },
          {
            title: p.title,
            kind: p.kind ?? "markdown",
            ...(p.artifactType !== undefined ? { artifactType: p.artifactType } : {}),
            ...(p.display !== undefined ? { display: p.display } : {}),
            ...(p.isDefault !== undefined ? { isDefault: p.isDefault } : {}),
            content,
            ...(p.note ? { note: p.note } : {}),
            ...sessionArtifactScope(c.session),
          },
        );
        return answers.artifact.made(made) + warnings(made, content);
      });
    });

  const artifactVersion = (table: "orchestrator" | "session") => (who: Who) =>
    (table === "orchestrator" ? tool : sessionSchemaTool)(
      "artifact.version.create",
      (p: { readonly id: T.ArtifactId; readonly content?: string; readonly file?: string; readonly note?: string }) => {
        const c = callerOf(who);
        return refusalAnswered(async () => {
          const content = await artifactWords(c, p.content, p.file);
          const made = await artifacts.version(
            { from: c.session || c.agent, by: c.agent, ...runOf(c.session || c.agent) },
            { id: p.id, content, ...(p.note ? { note: p.note } : {}) },
          );
          return answers.artifact.versioned(made) + warnings(made, content);
        });
      },
    );

  // A blocks artifact: the orchestrator's and a session's insert, rewrite and delete a block through the same op pipeline the user's editor uses, written as the agent's profile.
  const writer = (c: Caller) => c.agent || c.session;

  interface BlockCreateInput {
    readonly id: T.ArtifactId;
    readonly type?: string;
    readonly level?: number;
    readonly checked?: boolean;
    readonly language?: string;
    readonly text: string;
    readonly afterBlock?: T.BlockId;
    readonly parentId?: T.BlockId;
  }

  interface BlockUpdateInput {
    readonly id: T.ArtifactId;
    readonly block: T.BlockId;
    readonly baseRev: number;
    readonly text?: string;
    readonly type?: string;
    readonly level?: number;
    readonly checked?: boolean;
    readonly language?: string;
  }

  const insert = async (c: Caller, p: BlockCreateInput) => {
    const r = await artifacts.insertBlock(p.id, writer(c), {
      text: p.text,
      ...(p.type !== undefined ? { type: p.type } : {}),
      ...(p.level !== undefined ? { level: p.level } : {}),
      ...(p.checked !== undefined ? { checked: p.checked } : {}),
      ...(p.language !== undefined ? { language: p.language } : {}),
      ...(p.afterBlock !== undefined ? { afterBlock: p.afterBlock } : {}),
      ...(p.parentId !== undefined && p.parentId.trim() !== "" ? { parentId: S.blockId(p.parentId.trim()) } : {}),
    });
    if (r.status !== "applied") throw refuse(r.reason ?? "");
    return answers.block.appended(r.blockId, r.rev ?? 0);
  };

  const update = async (c: Caller, p: BlockUpdateInput) => {
    const r = await artifacts.updateBlock(p.id, writer(c), {
      block: p.block,
      baseRev: p.baseRev,
      ...(p.text !== undefined ? { text: p.text } : {}),
      ...(p.type !== undefined ? { type: p.type } : {}),
      ...(p.level !== undefined ? { level: p.level } : {}),
      ...(p.checked !== undefined ? { checked: p.checked } : {}),
      ...(p.language !== undefined ? { language: p.language } : {}),
    });
    if (r.status === "applied") return answers.block.updated(r.blockId, r.rev);
    if (r.status === "conflict") {
      let now: T.BlockSnapshot | undefined;
      try {
        now = await artifacts.blocks(p.id);
      } catch (e) {
        // The conflict is answered without the block as it is now.
        log.warn("artifact.block.update: no blocks for", p.id, e);
      }
      const x = now?.blocks.find((b) => b.id === r.blockId);
      return answers.block.notUpdated(r.reason, r.rev, x ? blockLine(x) : "");
    }
    throw refuse(r.reason ?? "");
  };

  const remove = async (c: Caller, p: { readonly id: T.ArtifactId; readonly block: T.BlockId }) => {
    const r = await artifacts.deleteBlock(p.id, writer(c), { block: p.block });
    if (r.status === "applied") return answers.block.deleted(r.blockId);
    if (r.status === "noop") return answers.block.alreadyDeleted(r.blockId);
    throw refuse(r.reason ?? "");
  };

  const blockCreate = (who: Who) => sessionSchemaTool("artifact.block.create", (p: SessionInput<"artifact.block.create">) => insert(callerOf(who), p));
  const orchestratorBlockCreate = (who: Who) => tool("artifact.block.create", (p: Orchestrator<"artifact.block.create">) => insert(callerOf(who), p));
  const blockUpdate = (who: Who) => sessionSchemaTool("artifact.block.update", (p: SessionInput<"artifact.block.update">) => update(callerOf(who), p));
  const orchestratorBlockUpdate = (who: Who) => tool("artifact.block.update", (p: Orchestrator<"artifact.block.update">) => update(callerOf(who), p));
  const blockDelete = (who: Who) => sessionSchemaTool("artifact.block.delete", (p: SessionInput<"artifact.block.delete">) => remove(callerOf(who), p));
  const orchestratorBlockDelete = (who: Who) => tool("artifact.block.delete", (p: Orchestrator<"artifact.block.delete">) => remove(callerOf(who), p));

  const artifactTypeList = (table: "orchestrator" | "session") => (who: Who) =>
    (table === "orchestrator" ? tool : sessionSchemaTool)("artifact.type.list", () => {
      callerOf(who);
      return refusalAnswered(async () => answers.artifact.types(await artifacts.listTypes()));
    });

  const artifactTypeRead = (table: "orchestrator" | "session") => (who: Who) =>
    (table === "orchestrator" ? tool : sessionSchemaTool)("artifact.type.read", (p: { readonly type: T.ArtifactType; readonly reference?: string }) => {
      callerOf(who);
      return refusalAnswered(async () =>
        answers.artifact.typeGuide(await artifacts.readType({ type: p.type, ...(p.reference ? { reference: p.reference } : {}) })),
      );
    });

  const artifactEntryList = (table: "orchestrator" | "session") => (who: Who) =>
    (table === "orchestrator" ? tool : sessionSchemaTool)(
      "artifact.entry.list",
      (p: { readonly id: T.ArtifactId; readonly prefix?: string; readonly includeValues?: boolean }) => {
        callerOf(who);
        return refusalAnswered(async () =>
          answers.artifact.entryList(
            await artifacts.listEntries({
              id: p.id,
              ...(p.prefix !== undefined ? { prefix: p.prefix } : {}),
              ...(p.includeValues !== undefined ? { includeValues: p.includeValues } : {}),
            }),
          ),
        );
      },
    );

  const artifactEntryGet = (table: "orchestrator" | "session") => (who: Who) =>
    (table === "orchestrator" ? tool : sessionSchemaTool)("artifact.entry.get", (p: { readonly id: T.ArtifactId; readonly path: string }) => {
      callerOf(who);
      return refusalAnswered(async () => answers.artifact.entryDetail(await artifacts.getEntry({ id: p.id, path: p.path })));
    });

  const artifactEntryBatch = (table: "orchestrator" | "session") => (who: Who) =>
    (table === "orchestrator" ? tool : sessionSchemaTool)("artifact.entry.batch", (p: T.ArtifactEntryBatchRequest) => {
      const c = callerOf(who);
      const from = c.session || c.agent;
      return refusalAnswered(async () => answers.artifact.entryBatch(await artifacts.batchEntries({ from, by: c.agent, ...runOf(from) }, p)));
    });

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
    artifactTypeList,
    artifactTypeRead,
    artifactEntryList,
    artifactEntryGet,
    artifactEntryBatch,
  };
}
