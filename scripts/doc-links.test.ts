import { expect, test } from "vite-plus/test";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

function checkDocs(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "vibevalley-doc-links-"));
  try {
    mkdirSync(join(root, "scripts"), { recursive: true });
    const script = join(root, "scripts", "doc-links.ts");
    copyFileSync(join(import.meta.dirname, "doc-links.ts"), script);
    for (const [file, text] of Object.entries(files)) {
      const path = join(root, file);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
    }
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["add", "."], { cwd: root });
    return spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("a maintained doc missing from the document map fails the check", () => {
  const result = checkDocs({
    "docs/README.md": "[架构](docs/architecture.md)\n",
    "docs/architecture.md": "# 架构\n",
    "docs/subsystems/notice.md": "# 通知\n",
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("docs/subsystems/notice.md");
  expect(result.stderr).toContain("docs/README.md");
});

test("a maintained doc linked with an anchor passes the check", () => {
  const result = checkDocs({
    "docs/README.md": "[写法](docs/subsystems/README.md#一篇怎么写)\n",
    "docs/subsystems/README.md": "# 子系统\n\n## 一篇怎么写\n",
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
});
