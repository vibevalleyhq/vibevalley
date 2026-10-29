import { artifactMax } from "./rules.ts";
import { describe, expect, it } from "vite-plus/test";
import { artifactHeaders, artifactProblem, htmlPolicy } from "./rules.ts";

describe("what an artifact may be", () => {
  it("takes a title, a kind it knows and a size within bounds; a version alone is judged by its size", () => {
    expect(artifactProblem({ title: "两种详情", kind: "html", size: 10 })).toBe("");
    expect(artifactProblem({ size: artifactMax })).toBe("");
    expect(artifactProblem({ title: "  ", kind: "html", size: 10 })).not.toBe("");
    expect(artifactProblem({ title: "长".repeat(81), kind: "html", size: 10 })).not.toBe("");
    expect(artifactProblem({ title: "长".repeat(80), kind: "markdown", size: 10 })).toBe("");
    expect(artifactProblem({ title: "a", kind: "pdf", size: 10 })).not.toBe("");
    expect(artifactProblem({ size: 0 })).not.toBe("");
    expect(artifactProblem({ size: artifactMax + 1 })).not.toBe("");
    // The owner's new one: a title and nothing in it yet.
    expect(artifactProblem({ title: "周报" })).toBe("");
  });

  it("serves HTML in a sandbox with no origin of its own and nothing to call", () => {
    const html = artifactHeaders;
    expect(html["content-type"]).toBe("text/html; charset=utf-8");
    expect(html["content-security-policy"]).toBe(htmlPolicy);
    const sandbox = htmlPolicy.split("; ")[0]!;
    expect(sandbox.startsWith("sandbox ")).toBe(true);
    expect(sandbox).not.toContain("allow-same-origin");
    expect(sandbox).not.toContain("allow-top-navigation");
    expect(sandbox).not.toContain("allow-forms");
    expect(htmlPolicy).toContain("connect-src 'none'");
    expect(htmlPolicy).toContain("form-action 'none'");
    expect(html["x-content-type-options"]).toBe("nosniff");
  });
});
