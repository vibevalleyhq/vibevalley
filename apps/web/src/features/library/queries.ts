import * as S from "@vibevalley/protocol/schema";

import { api } from "#/infra/api.ts";
import { defineQuery, retryRead } from "#/infra/query.ts";

/** Every item, newest first; the page filters them itself. */
export const libraryQuery = defineQuery({
  schema: S.LibraryItems,
  key: () => ["library"],
  fetch: (_: void, context) => api.library.item.list({}, context),
  ...retryRead,
});
