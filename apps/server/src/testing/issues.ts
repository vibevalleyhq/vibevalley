import type * as T from "@vibevalley/protocol";

import { explicitMandate } from "@/issue/creation.ts";
import type { Issue } from "@/issue/issue.ts";

export const testIssues = (issues: Issue["Service"]) => ({
  ...issues,
  add: (request: T.IssueRequest) => issues.add(request, explicitMandate()),
});
