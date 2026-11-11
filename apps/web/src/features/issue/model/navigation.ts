import { Schema } from "effect";

import { search, searchParam } from "#/infra/router.ts";

export const issueSearch = search({
  repo: Schema.optional(searchParam(Schema.String)),
  agent: Schema.optional(searchParam(Schema.String)),
});
