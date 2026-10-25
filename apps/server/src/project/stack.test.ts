import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "vite-plus/test";
import { stackOf } from "./stack.ts";

const scripts = `{"scripts":{"test":"vitest run","build":"vite build"}}`;
const go = {
  name: "go",
  label: "Go",
  test: "go test ./...",
  lint: "go vet ./...",
  build: "go build ./...",
};

test.each([
  ["nothing", { "README.md": "hi" }, { name: "", label: "" }],
  ["go", { "go.mod": "module x" }, go],
  ["go before node", { "go.mod": "module x", "package.json": scripts }, go],
  ["rust", { "Cargo.toml": "[package]" }, { name: "rust", label: "Rust", test: "cargo test", lint: "cargo clippy", build: "cargo build" }],
  [
    "flutter",
    { "pubspec.yaml": "dependencies:\n  flutter:\n    sdk: flutter\n" },
    { name: "flutter", label: "Flutter", test: "flutter test", lint: "flutter analyze" },
  ],
  ["dart", { "pubspec.yaml": "name: tool\n" }, { name: "dart", label: "Dart", test: "dart test", lint: "dart analyze" }],
  ["npm without a lockfile", { "package.json": scripts }, { name: "node", label: "Node（npm）", test: "npm run test", build: "npm run build" }],
  ["bun.lock", { "package.json": scripts, "bun.lock": "" }, { name: "node", label: "Node（bun）", test: "bun run test", build: "bun run build" }],
  ["bun.lockb", { "package.json": scripts, "bun.lockb": "" }, { name: "node", label: "Node（bun）", test: "bun run test", build: "bun run build" }],
  ["pnpm", { "package.json": scripts, "pnpm-lock.yaml": "" }, { name: "node", label: "Node（pnpm）", test: "pnpm run test", build: "pnpm run build" }],
  ["yarn", { "package.json": scripts, "yarn.lock": "" }, { name: "node", label: "Node（yarn）", test: "yarn run test", build: "yarn run build" }],
  ["node without scripts", { "package.json": `{"name":"x"}` }, { name: "node", label: "Node（npm）" }],
  ["node with a lint script", { "package.json": `{"scripts":{"lint":"eslint ."}}` }, { name: "node", label: "Node（npm）", lint: "npm run lint" }],
  ["unreadable package.json", { "package.json": "{" }, { name: "node", label: "Node（npm）" }],
  ["pyproject with ruff", { "pyproject.toml": "[tool.ruff]\n" }, { name: "python", label: "Python", test: "pytest", lint: "ruff check ." }],
  ["requirements.txt", { "requirements.txt": "requests\n" }, { name: "python", label: "Python", test: "pytest" }],
  ["a marker in a subfolder only", { "server/go.mod": "module x" }, { name: "", label: "" }],
])("the stack is read off the marker at the root: %s", (_name, files, want) => {
  const dir = mkdtempSync(join(tmpdir(), "vibevalley-stack-"));
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), body);
  }
  expect(stackOf(dir)).toEqual(want);
});
