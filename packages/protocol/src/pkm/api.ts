import { z } from "zod";

import { type Endpoint, input } from "../endpoint";
import * as S from "../schema";
import type * as T from "../shapes";

export interface PkmHandlers {
  /** Every page in the vault, newest first; files changed on disk are read again first. */
  readonly "pkm.page.list": () => Promise<T.PkmVault>;
  /** The page with its ((refs)) read out, the blocks linking to it and its open remarks; read again from its file when that changed. */
  readonly "pkm.page.get": (a: T.PkmPageRef) => Promise<T.PkmPageView>;
  /** Makes the page, or sets the props and tier of the one with that title (its file moves to the tier's folder). */
  readonly "pkm.page.save": (a: T.PkmPageRequest) => Promise<T.PkmPage>;
  readonly "pkm.page.move": (a: T.PkmMoveRequest) => Promise<T.PkmPage>;
  readonly "pkm.page.rename": (a: T.PkmRenameRequest) => Promise<T.PkmRename>;
  /** The page as plain Markdown: refs read out, links and remarks taken off. */
  readonly "pkm.page.export": (a: T.PkmPageRef) => Promise<T.PkmMarkdown>;
  /** The ops in order on the page as its file is now, written back once. */
  readonly "pkm.block.apply": (a: T.PkmMutation) => Promise<T.PkmPage>;
  readonly "pkm.search": (a: T.PkmSearchRequest) => Promise<T.PkmSearchHit[]>;
  /** Into today's journal as LATER lines tagged #inbox (an agent's says who noted it), or at the end of a page. */
  readonly "pkm.capture": (a: T.PkmCaptureRequest) => Promise<T.PkmPage>;
  /** The page's file as written, ids and all, with when it was written. */
  readonly "pkm.source.get": (a: T.PkmPageRef) => Promise<T.PkmSource>;
  /** The page written anew from its file's text; refused when the file changed after it was read. */
  readonly "pkm.source.update": (a: T.PkmSourceUpdate) => Promise<T.PkmPage>;
  /** The journal of a day, made empty when it has none yet. */
  readonly "pkm.journal.open": (a: T.PkmJournalRequest) => Promise<T.PkmPage>;
  readonly "pkm.radar.get": (a: { readonly staleDays?: number }) => Promise<T.PkmRadar>;
  readonly "pkm.comment.list": (a: { readonly page?: string }) => Promise<T.PkmComment[]>;
  /** A rewrite of a block for the user to accept: it keeps every [[link]] and ((ref)) the block had. */
  readonly "pkm.comment.suggest": (a: T.PkmProposalRequest) => Promise<T.PkmProposal>;
  /** Accepted, the suggested text replaces the block's and its remarks come off; rejected, the block stays. */
  readonly "pkm.comment.resolve": (a: T.PkmResolveRequest) => Promise<T.PkmPage>;
  readonly "pkm.clip.create": (a: T.PkmClipRequest) => Promise<T.PkmClip>;
  /** A resource page of ((refs)) to the inbox, journal and resource blocks about the topic. */
  readonly "pkm.cluster.create": (a: T.PkmClusterRequest) => Promise<T.PkmCluster>;
  /** Puts back the file the last change wrote. */
  readonly "pkm.undo": () => Promise<T.PkmUndo>;
  /** Reads again every file that changed on disk. */
  readonly "pkm.scan": () => Promise<T.PkmScan>;
}

export const pkmEndpoints: readonly Endpoint[] = [
  {
    op: "pkm.page.list",
    about: [],
    input: undefined,
    result: S.PkmVault,
    can: ["user", "remote"],
  },
  {
    op: "pkm.page.get",
    about: ["page"],
    input: S.PkmPageRef,
    result: S.PkmPageView,
    can: ["user", "remote", "orchestrator", "session"],
  },
  {
    op: "pkm.page.save",
    about: [],
    input: S.PkmPageRequest,
    result: S.PkmPage,
    can: ["user", "remote"],
  },
  {
    op: "pkm.page.move",
    about: ["page"],
    input: S.PkmMoveRequest,
    result: S.PkmPage,
    can: ["user", "remote"],
  },
  {
    op: "pkm.page.rename",
    about: [],
    input: S.PkmRenameRequest,
    result: S.PkmRename,
    can: ["user", "remote"],
  },
  {
    op: "pkm.page.export",
    about: ["page"],
    input: S.PkmPageRef,
    result: S.PkmMarkdown,
    can: ["user", "remote"],
  },
  {
    op: "pkm.block.apply",
    about: ["page"],
    input: S.PkmMutation,
    result: S.PkmPage,
    can: ["user", "remote"],
  },
  {
    op: "pkm.search",
    about: [],
    input: S.PkmSearchRequest,
    result: z.array(S.PkmSearchHit),
    can: ["user", "remote", "orchestrator", "session"],
  },
  {
    op: "pkm.capture",
    about: [],
    input: S.PkmCaptureRequest,
    result: S.PkmPage,
    can: ["user", "remote", "orchestrator", "session"],
  },
  {
    op: "pkm.source.get",
    about: ["page"],
    input: S.PkmPageRef,
    result: S.PkmSource,
    can: ["user", "remote"],
  },
  {
    op: "pkm.source.update",
    about: ["page"],
    input: S.PkmSourceUpdate,
    result: S.PkmPage,
    can: ["user", "remote"],
  },
  {
    op: "pkm.journal.open",
    about: ["day"],
    input: S.PkmJournalRequest,
    result: S.PkmPage,
    can: ["user", "remote"],
  },
  {
    op: "pkm.radar.get",
    about: [],
    input: input({ staleDays: z.exactOptional(z.number().int()) }),
    result: S.PkmRadar,
    can: ["user", "remote"],
  },
  {
    op: "pkm.comment.list",
    about: [],
    input: input({ page: z.exactOptional(z.string()) }),
    result: z.array(S.PkmComment),
    can: ["user", "remote"],
  },
  {
    op: "pkm.comment.suggest",
    about: ["block"],
    input: S.PkmProposalRequest,
    result: S.PkmProposal,
    can: ["user", "remote", "orchestrator", "session"],
  },
  {
    op: "pkm.comment.resolve",
    about: ["id"],
    input: S.PkmResolveRequest,
    result: S.PkmPage,
    can: ["user", "remote"],
  },
  {
    op: "pkm.clip.create",
    about: [],
    input: S.PkmClipRequest,
    result: S.PkmClip,
    can: ["user", "remote"],
  },
  {
    op: "pkm.cluster.create",
    about: [],
    input: S.PkmClusterRequest,
    result: S.PkmCluster,
    can: ["user", "remote"],
  },
  {
    op: "pkm.undo",
    about: [],
    input: undefined,
    result: S.PkmUndo,
    can: ["user"],
  },
  {
    op: "pkm.scan",
    about: [],
    input: undefined,
    result: S.PkmScan,
    can: ["user", "remote"],
  },
];
