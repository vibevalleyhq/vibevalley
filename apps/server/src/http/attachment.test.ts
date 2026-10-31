import { describe, expect, it } from "@effect/vitest";
import { Context, Effect, Layer } from "effect";

import { attachmentPath } from "@vibevalley/protocol";

import { Channel } from "@/channel/chat.ts";
import { testConfig } from "@/testing/layers.ts";
import { quietApp } from "@/testing/world.ts";

import { app } from "./app.ts";

const farm = Effect.gen(function* () {
  let address = "";
  const built = yield* Layer.build(app(testConfig(), 0, (a) => Effect.sync(() => void (address = a)), quietApp));
  return { address, chat: Context.get(built, Channel) };
});

describe("an attachment", () => {
  it.live("is read back by GET at its path, as what it is, and nothing else is", () =>
    Effect.gen(function* () {
      const { address, chat } = yield* farm;
      const png = yield* chat.attach({ name: "看这里.png", type: "image/png", data: Buffer.from("not really a png").toString("base64") });
      // The test reads the server as a browser does, through the platform's own fetch.
      // @effect-diagnostics-next-line globalFetchInEffect:off
      const get = (path: string) => Effect.promise(() => fetch(`http://${address}${path}`));
      const res = yield* get(attachmentPath(png.id));
      expect([res.status, res.headers.get("content-type"), res.headers.get("content-disposition")]).toEqual([
        200,
        "image/png",
        `inline; filename*=UTF-8''${encodeURIComponent("看这里.png")}`,
      ]);
      expect(yield* Effect.promise(() => res.text())).toBe("not really a png");
      const disposition = (r: Response) => [r.headers.get("content-disposition")?.split(";")[0], r.headers.get("content-security-policy")];
      const pdf = yield* chat.attach({ name: "a.pdf", type: "application/pdf", data: Buffer.from("%PDF-1.4").toString("base64") });
      const zip = yield* chat.attach({ name: "a.zip", type: "application/zip", data: Buffer.from("PK").toString("base64") });
      const mp4 = yield* chat.attach({ name: "a.mp4", type: "video/mp4", data: Buffer.from("mp4").toString("base64") });
      expect(disposition(yield* get(attachmentPath(pdf.id)))).toEqual(["inline", null]);
      expect(disposition(yield* get(attachmentPath(mp4.id)))).toEqual(["inline", "sandbox"]);
      expect(disposition(yield* get(attachmentPath(zip.id)))).toEqual(["attachment", "sandbox"]);
      expect((yield* get(attachmentPath("0".repeat(64)))).status).toBe(404);
      expect((yield* get(attachmentPath("../vibevalley.yaml"))).status).toBe(404);
      const big = yield* Effect.flip(chat.attach({ name: "big", type: "application/zip", data: Buffer.alloc(25 * 1024 * 1024 + 1).toString("base64") }));
      expect(big).toMatchObject({ _tag: "Refused" });
    }).pipe(Effect.scoped),
  );
});
