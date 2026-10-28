import { artifactMax } from "@vibevalley/protocol";
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
  });

  it("serves HTML in a sandbox with no origin of its own and nothing to call, and Markdown as text", () => {
    const html = artifactHeaders("html");
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
    const md = artifactHeaders("markdown");
    expect(md["content-type"]).toBe("text/plain; charset=utf-8");
    expect(md["content-security-policy"]).toBe("sandbox; default-src 'none'");
  });
});
