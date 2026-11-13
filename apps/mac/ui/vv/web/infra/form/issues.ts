import type { z } from "zod";

export type FormIssue = {
  readonly path: readonly (string | number)[];
  readonly code: "missing" | "type" | "invalid" | "union" | "forbidden";
  readonly params: Readonly<Record<string, string | number>>;
  readonly branches?: readonly (readonly FormIssue[])[];
};

const keysOf = (path: readonly PropertyKey[]) => path.filter((key): key is string | number => typeof key !== "symbol");

/** Zod's issues as the form tells them; read with `reportInput`, so a missing key is told apart from a wrong type. The
 * input itself is not kept: it may be a secret. */
export function formIssues(issues: readonly z.core.$ZodIssue[], path: readonly (string | number)[] = []): FormIssue[] {
  return issues.flatMap((issue): FormIssue[] => {
    const at = [...path, ...keysOf(issue.path)];
    switch (issue.code) {
      case "invalid_type":
        return [{ path: at, code: issue.input === undefined ? "missing" : "type", params: {} }];
      case "invalid_union":
        return [{ path: at, code: "union", params: {}, branches: issue.errors.map((branch) => formIssues(branch, at)) }];
      case "invalid_key":
      case "invalid_element":
        return formIssues(issue.issues, at);
      case "too_big":
      case "too_small":
      case "invalid_format":
      case "not_multiple_of":
      case "unrecognized_keys":
      case "invalid_value":
      case "custom":
        return [{ path: at, code: "invalid", params: {} }];
    }
  });
}
