import { expect, test } from "vite-plus/test";

import { hosting } from "./hosting.ts";
import { RepoError } from "./workplace.ts";

for (const platform of ["github", "gitlab"] as const) {
  test(`${platform} does not reuse a fork or a closed request`, async () => {
    for (const [fork, closed] of [
      [true, false],
      [false, true],
      [false, false],
    ] as const) {
      const url = `https://${platform}.com/team/repo/${platform === "github" ? "pull" : "-/merge_requests"}/8`;
      const item =
        platform === "github"
          ? { number: 8, url, isCrossRepository: fork, state: closed ? "CLOSED" : "OPEN" }
          : { iid: 8, web_url: url, source_project_id: fork ? 2 : 1, target_project_id: 1, state: closed ? "closed" : "opened" };
      const host = hosting({ platform, host: platform + ".com", name: "team/repo" }, () =>
        Promise.resolve({ ok: true, missing: false, out: JSON.stringify([item], null, 2) }),
      );
      const host2 = await host.find("feat/topic", "main");
      expect(host2).toEqual(fork || closed ? undefined : { number: 8, url, state: "open" });
    }
  });
}

test("GitHub creation rejects an untrusted link even when gh exits successfully", async () => {
  const host = hosting({ platform: "github", host: "github.com", name: "team/repo" }, () =>
    Promise.resolve({ ok: true, missing: false, out: "https://evil.test/7" }),
  );
  const e = await host
    .create({ cwd: "/unused", branch: "feat/topic", sha: "a".repeat(40), base: "main", title: "Title", body: "Body" })
    .catch((e: unknown) => e);
  expect(e).toBeInstanceOf(RepoError);
});
