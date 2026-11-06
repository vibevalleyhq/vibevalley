import {
  byTier,
  type DiffPiece,
  hasChildren,
  type NoteTarget,
  noteTargets as pkmNoteTargets,
  type Piece,
  piecesOf,
  tierOrder,
  visibleBlocks,
  wordDiff,
} from "@vibevalley/pkm/view";
import type { PkmPageSummary } from "@vibevalley/protocol";

import { spelled } from "#/base/search.ts";

export { byTier, type DiffPiece, hasChildren, type NoteTarget, type Piece, piecesOf, tierOrder, visibleBlocks, wordDiff };

/** The pages whose title (a journal's day too) has what was typed in it, the newest first; none for nothing typed. */
export const noteTargets = (pages: readonly PkmPageSummary[], query: string, max = 6): NoteTarget[] => pkmNoteTargets(pages, query, max, spelled);
