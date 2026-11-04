// The endpoints of the owner's notes: their answers (PkmHandlers) and their lines in the table (api.ts puts the
// concepts together).

import { type Effect, Schema } from "effect";

import { type ApiError, type Endpoint, input } from "../endpoint";
import * as S from "../schema";
import type * as T from "../shapes";

export interface PkmHandlers<R = never> {
  /** Every page in the vault, newest first; files changed on disk are read again first. */
  readonly "pkm.page.list": () => Effect.Effect<T.PkmVault, ApiError, R>;
  /** The page with its ((refs)) read out, the blocks linking to it and its open remarks; read again from its file when that changed. */
  readonly "pkm.page.get": (a: T.PkmPageRef) => Effect.Effect<T.PkmPageView, ApiError, R>;
  /** Makes the page, or sets the props and tier of the one with that title (its file moves to the tier's folder). */
  readonly "pkm.page.save": (a: T.PkmPageRequest) => Effect.Effect<T.PkmPage, ApiError, R>;
  readonly "pkm.page.move": (a: T.PkmMoveRequest) => Effect.Effect<T.PkmPage, ApiError, R>;
  readonly "pkm.page.rename": (a: T.PkmRenameRequest) => Effect.Effect<T.PkmRename, ApiError, R>;
  /** The page as plain Markdown: refs read out, links and remarks taken off. */
  readonly "pkm.page.export": (a: T.PkmPageRef) => Effect.Effect<T.PkmMarkdown, ApiError, R>;
  /** The ops in order on the page as its file is now, written back once. */
  readonly "pkm.block.apply": (a: T.PkmMutation) => Effect.Effect<T.PkmPage, ApiError, R>;
  readonly "pkm.search": (a: T.PkmSearchRequest) => Effect.Effect<T.PkmSearchHit[], ApiError, R>;
  /** A LATER line in today's journal, tagged #inbox. */
  readonly "pkm.capture": (a: T.PkmCaptureRequest) => Effect.Effect<T.PkmPage, ApiError, R>;
  readonly "pkm.radar.get": (a: { readonly staleDays?: number }) => Effect.Effect<T.PkmRadar, ApiError, R>;
  readonly "pkm.comment.list": (a: { readonly page?: string }) => Effect.Effect<T.PkmComment[], ApiError, R>;
  /** A rewrite of a block for the owner to accept: it keeps every [[link]] and ((ref)) the block had. */
  readonly "pkm.comment.suggest": (a: T.PkmProposalRequest) => Effect.Effect<T.PkmProposal, ApiError, R>;
  /** Accepted, the suggested text replaces the block's and its remarks come off; rejected, the block stays. */
  readonly "pkm.comment.resolve": (a: T.PkmResolveRequest) => Effect.Effect<T.PkmPage, ApiError, R>;
  readonly "pkm.clip.create": (a: T.PkmClipRequest) => Effect.Effect<T.PkmClip, ApiError, R>;
  /** A resource page of ((refs)) to the inbox, journal and resource blocks about the topic. */
  readonly "pkm.cluster.create": (a: T.PkmClusterRequest) => Effect.Effect<T.PkmCluster, ApiError, R>;
  /** Puts back the file the last change wrote. */
  readonly "pkm.undo": () => Effect.Effect<T.PkmUndo, ApiError, R>;
  /** Reads again every file that changed on disk. */
  readonly "pkm.scan": () => Effect.Effect<T.PkmScan, ApiError, R>;
}

export const pkmEndpoints: readonly Endpoint[] = [
  {
    op: "pkm.page.list",
    about: [],
    input: undefined,
    result: S.PkmVault,
    can: ["owner", "remote"],
  },
  {
    op: "pkm.page.get",
    about: ["page"],
    input: S.PkmPageRef,
    result: S.PkmPageView,
    can: ["owner", "remote"],
  },
  {
    op: "pkm.page.save",
    about: [],
    input: S.PkmPageRequest,
    result: S.PkmPage,
    can: ["owner", "remote"],
  },
  {
    op: "pkm.page.move",
    about: ["page"],
    input: S.PkmMoveRequest,
    result: S.PkmPage,
    can: ["owner", "remote"],
  },
  {
    op: "pkm.page.rename",
    about: [],
    input: S.PkmRenameRequest,
    result: S.PkmRename,
    can: ["owner", "remote"],
  },
  {
    op: "pkm.page.export",
    about: ["page"],
    input: S.PkmPageRef,
    result: S.PkmMarkdown,
    can: ["owner", "remote"],
  },
  {
    op: "pkm.block.apply",
    about: ["page"],
    input: S.PkmMutation,
    result: S.PkmPage,
    can: ["owner", "remote"],
  },
  {
    op: "pkm.search",
    about: [],
    input: S.PkmSearchRequest,
    result: Schema.mutable(Schema.Array(S.PkmSearchHit)),
    can: ["owner", "remote"],
  },
  {
    op: "pkm.capture",
    about: [],
    input: S.PkmCaptureRequest,
    result: S.PkmPage,
    can: ["owner", "remote"],
  },
  {
    op: "pkm.radar.get",
    about: [],
    input: input({ staleDays: Schema.optionalKey(Schema.Int) }),
    result: S.PkmRadar,
    can: ["owner", "remote"],
  },
  {
    op: "pkm.comment.list",
    about: [],
    input: input({ page: Schema.optionalKey(Schema.String) }),
    result: Schema.mutable(Schema.Array(S.PkmComment)),
    can: ["owner", "remote"],
  },
  {
    op: "pkm.comment.suggest",
    about: ["block"],
    input: S.PkmProposalRequest,
    result: S.PkmProposal,
    can: ["owner", "remote"],
  },
  {
    op: "pkm.comment.resolve",
    about: ["id"],
    input: S.PkmResolveRequest,
    result: S.PkmPage,
    can: ["owner", "remote"],
  },
  {
    op: "pkm.clip.create",
    about: [],
    input: S.PkmClipRequest,
    result: S.PkmClip,
    can: ["owner", "remote"],
  },
  {
    op: "pkm.cluster.create",
    about: [],
    input: S.PkmClusterRequest,
    result: S.PkmCluster,
    can: ["owner", "remote"],
  },
  {
    op: "pkm.undo",
    about: [],
    input: undefined,
    result: S.PkmUndo,
    can: ["owner"],
  },
  {
    op: "pkm.scan",
    about: [],
    input: undefined,
    result: S.PkmScan,
    can: ["owner", "remote"],
  },
];
