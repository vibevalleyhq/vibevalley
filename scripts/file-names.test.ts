// Named for what it decides, never for a word that would fit any module (docs/style/naming.md).

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { expect, test } from "vite-plus/test";

const root = resolve(import.meta.dirname, "..");
const vague = ["rules", "state", "data", "utils", "helpers", "common", "misc", "lib", "text", "hooks"];

test("no source file under apps/ or packages/ has a name that would fit any module", () => {
  const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "apps", "packages"], { cwd: root, encoding: "utf8" }).split(
    "\n",
  );
  const named = new RegExp(`/(?:${vague.join("|")})(?:\\.test|\\.stories)?\\.tsx?$`, "u");
  expect(files.filter((f) => named.test(f))).toEqual([]);
});
