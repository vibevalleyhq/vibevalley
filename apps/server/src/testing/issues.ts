import type * as T from "@vibevalley/protocol";

import type { Issue } from "@/issue/issue.ts";
import { explicitMandate } from "@/issue/mandate.ts";

export const testIssues = (issues: Issue["Service"]) => ({
  ...issues,
  add: (request: T.IssueRequest) => issues.add(request, explicitMandate()),
});
