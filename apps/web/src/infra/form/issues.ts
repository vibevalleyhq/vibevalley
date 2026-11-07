import type { SchemaIssue } from "effect";

export type FormIssue = {
  readonly path: readonly (string | number)[];
  readonly code: "missing" | "type" | "invalid" | "union" | "forbidden";
  readonly params: Readonly<Record<string, string | number>>;
  readonly branches?: readonly (readonly FormIssue[])[];
};
export function formIssues(issue: SchemaIssue.Issue, path: readonly (string | number)[] = []): FormIssue[] {
  switch (issue._tag) {
    case "Pointer":
      return formIssues(issue.issue, [...path, ...issue.path.filter((key): key is string | number => typeof key !== "symbol")]);
    case "Composite":
      return issue.issues.flatMap((child) => formIssues(child, path));
    case "Filter":
    case "Encoding":
      return formIssues(issue.issue, path);
    case "AnyOf":
      return [{ path, code: "union", params: {}, branches: issue.issues.map((branch) => formIssues(branch, path)) }];
    case "OneOf":
      return [{ path, code: "union", params: {} }];
    case "MissingKey":
      return [{ path, code: "missing", params: {} }];
    case "InvalidType":
      return [{ path, code: "type", params: {} }];
    case "Forbidden":
      return [{ path, code: "forbidden", params: {} }];
    case "UnexpectedKey":
    case "InvalidValue":
      return [{ path, code: "invalid", params: {} }];
  }
}
