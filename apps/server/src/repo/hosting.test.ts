import { expect, it } from "@effect/vitest";
import { Effect, Formatter } from "effect";

import { hosting } from "./hosting.ts";

for (const platform of ["github", "gitlab"] as const) {
  it.effect(`${platform} does not reuse a fork or a closed request`, () =>
    Effect.gen(function* () {
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
          Effect.succeed({ ok: true, missing: false, out: Formatter.formatJson([item]) }),
        );
        const host2 = yield* host.find("feat/topic", "main");
        expect(host2).toEqual(fork || closed ? undefined : { number: 8, url, state: "open" });
      }
    }),
  );
}

it.effect("GitHub creation rejects an untrusted link even when gh exits successfully", () =>
  Effect.gen(function* () {
    const host = hosting({ platform: "github", host: "github.com", name: "team/repo" }, () =>
      Effect.succeed({ ok: true, missing: false, out: "https://evil.test/7" }),
    );
    expect(
      (yield* Effect.flip(host.create({ cwd: "/unused", branch: "feat/topic", sha: "a".repeat(40), base: "main", title: "Title", body: "Body" })))._tag,
    ).toBe("RepoError");
  }),
);
