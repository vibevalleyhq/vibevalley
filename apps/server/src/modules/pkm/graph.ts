import {
  backlinks,
  blockOf,
  clipOf,
  clustered,
  exportMarkdown,
  keepLinks,
  pageOf,
  plainOf,
  queryWords as pkmQueryWords,
  radar,
  refsInto,
  renameLinks,
  search as pkmSearch,
  summaryOf,
  transclusions,
  type Vault,
  wireOf,
} from "@vibevalley/pkm/graph";
import type * as T from "@vibevalley/protocol";

import { termsList } from "#/modules/memory/recall.ts";

export {
  backlinks,
  blockOf,
  clipOf,
  clustered,
  exportMarkdown,
  keepLinks,
  pageOf,
  plainOf,
  radar,
  refsInto,
  renameLinks,
  summaryOf,
  transclusions,
  type Vault,
  wireOf,
};

/** The words a search matches on: the whole query, its space-separated words and the words memory cuts it into. */
export const queryWords = (text: string) => pkmQueryWords(text, termsList);

/** The blocks that match, best first, times the tier's weight. */
export const search = (vault: Vault, req: T.PkmSearchRequest, ranked?: ReadonlyMap<string, number>): T.PkmSearchHit[] =>
  pkmSearch(vault, req, ranked, termsList);
