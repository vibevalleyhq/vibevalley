import { z } from "zod";

import { search, searchParam } from "#/infra/router.ts";

export const issueSearch = search({
  repo: searchParam(z.string()).optional(),
  agent: searchParam(z.string()).optional(),
});
