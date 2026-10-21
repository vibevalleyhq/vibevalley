import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { vi } from "vite-plus/test";
import { dispatch } from "./cli.ts";
import { app } from "./http/app.ts";
import { testConfig } from "./testing/layers.ts";

/** The whole farm on a free port; the command line is pointed at it. */
const farm = Effect.gen(function* () {
  let address = "";
  yield* Layer.build(app(testConfig(), 0, (a) => Effect.sync(() => void (address = a))));
  return "http://" + address;
});

/** What dispatch printed. */
const run = (args: string[]) =>
  Effect.promise(async () => {
    const out: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
    try {
      await dispatch(args);
    } finally {
      log.mockRestore();
    }
    return out.join("\n");
  });

describe("the command line", () => {
  it.live("lists every endpoint as a command", () =>
    Effect.gen(function* () {
      const help = yield* run(["help"]);
      expect(help).toContain("issue list");
      expect(help).toContain("issue status <id> --json");
    }),
  );

  it.live("calls an endpoint and prints its answer", () =>
    Effect.gen(function* () {
      const server = yield* farm;
      const made = JSON.parse(yield* run(["issue", "create", "--server", server, "--json", JSON.stringify({ title: "试一下" })])) as {
        id: string;
        status: string;
      };
      expect(made.status).toBe("backlog");
      const got = JSON.parse(yield* run(["issue", "get", made.id, "--server", server])) as { title: string };
      expect(got.title).toBe("试一下");
      const list = JSON.parse(yield* run(["issue", "list", "--server", server])) as { id: string }[];
      expect(list.map((i) => i.id)).toContain(made.id);
      expect(JSON.parse(yield* run(["state", "--server", server]))).toHaveProperty("state");
    }),
  );

  it.live("says what is wrong with a command", () =>
    Effect.gen(function* () {
      const server = yield* farm;
      const fails = (args: string[]) => Effect.flip(Effect.tryPromise(() => dispatch(args)));
      expect(String((yield* fails(["issue", "get", "--server", server])).cause)).toContain("要 1 个参数");
      expect(String((yield* fails(["issue", "list", "--bogus", "1", "--server", server])).cause)).toContain("不认 --bogus");
      expect(String((yield* fails(["issue", "get", "nope", "--server", server])).cause)).toContain("404");
    }),
  );
});
