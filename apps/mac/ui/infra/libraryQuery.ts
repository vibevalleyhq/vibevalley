import type { LibrarySort } from "@vibevalley/protocol";

import { api } from "./api";
import { defineQuery, retryRead } from "./query";

/** The items whose names hold text, in the order sort names; the rail filters and counts them on the page. */
export const libraryQuery = defineQuery({
  key: (given: { readonly text: string; readonly sort: LibrarySort }) => ["library", given.text, given.sort],
  fetch: (given, context) => api.library.item.list({ ...(given.text === "" ? {} : { text: given.text }), sort: given.sort }, context),
  ...retryRead,
});
