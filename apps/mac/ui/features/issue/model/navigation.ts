import { z } from "zod";

import { search, searchParam } from "../../../infra/router";
import { issueScopes } from "./meta";

export const issueSearch = search({
  repo: searchParam(z.string()).optional(),
  agent: searchParam(z.string()).optional(),
  tag: searchParam(z.string()).optional(),
  scope: searchParam(z.enum(issueScopes)).optional(),
});
