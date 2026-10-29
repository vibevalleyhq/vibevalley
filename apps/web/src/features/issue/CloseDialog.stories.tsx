import type { Changes } from "@vibevalley/protocol";
import { stories, story } from "@vibevalley/stories";
import { ChangesBody, ChangesHead } from "./CloseDialog";

const now = Date.now();

const changes: Changes = {
  project: "vibevalley",
  base: "main",
  branch: "issue-18-login",
  behind: 0,
  conflicts: [],
  uncommitted: [],
  commits: [
    { hash: "a1b2c3d", subject: "Send an expired session back to the sign-in page", at: now - 9 * 60_000 },
    { hash: "e4f5a6b", subject: "Test the expiry on both sides of the boundary", at: now - 4 * 60_000 },
  ],
  files: [
    {
      path: "apps/web/src/base/session.ts",
      status: "M",
      added: 6,
      removed: 2,
      patch: [
        "@@ -10,7 +10,11 @@ export function session() {",
        "-  if (!s) return undefined;",
        "-  return s;",
        "+  if (!s) return undefined;",
        "+  // Expired: back to sign-in rather than a page that fails on every read.",
        "+  if (expired(s, Date.now())) {",
        "+    location.replace('/signin');",
        "+    return undefined;",
        "+  }",
        "+  return s;",
      ].join("\n"),
    },
    { path: "apps/web/src/base/session.test.ts", status: "A", added: 24, removed: 0 },
    { path: "apps/web/src/base/old-session.ts", status: "D", added: 0, removed: 31 },
  ],
};

export default stories({
  title: "界面/工单/改动",
  stories: {
    Changes: story({
      note: "合进主分支之前看的：提交、文件，点开文件看补丁（按语言上色）。",
      render: () => (
        <div class="flex w-full max-w-2xl flex-col gap-2">
          <ChangesHead changes={changes} />
          <ChangesBody changes={changes} />
        </div>
      ),
    }),
  },
});
