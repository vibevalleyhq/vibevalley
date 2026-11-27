import { z } from "zod";

import { IssueStatus as IssueStatusSchema } from "@vibevalley/protocol/schema";

import { search, searchParam } from "../../../infra/router";
import { issueScopes } from "./meta";

const statusValueSet = new Set<string>(IssueStatusSchema.options);
const statusFilterSchema = z.string().refine((raw) => raw !== "" && raw.split(",").every((part) => statusValueSet.has(part.trim())), "Invalid status filter");

export const issueSearch = search({
  repo: searchParam(z.string()).optional(),
  agent: searchParam(z.string()).optional(),
  tag: searchParam(z.string()).optional(),
  scope: searchParam(z.enum(issueScopes)).optional(),
  status: searchParam(statusFilterSchema).optional(),
});
