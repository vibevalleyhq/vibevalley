import { expect, layer } from "@effect/vitest";
import { Array as Arr, Effect } from "effect";

import type * as T from "@vibevalley/protocol";
import { sessionId } from "@vibevalley/protocol/schema";

import { Core } from "#/core/core.ts";
import { Attachment } from "#/modules/attachment/attachment.ts";
import { Channel } from "#/modules/channel/channel.ts";
import { waitFor } from "#/testing/layers.ts";
import { world } from "#/testing/world.ts";

import { type AddedBy, Library } from "./library.ts";

const file = (name: string, words: string, type = "text/plain") => ({ name, type, data: Buffer.from(words).toString("base64") });

const image = (id: string, attachment: T.Attachment, phase: T.MediaPhase): T.MediaJob => ({
  kind: "image",
  id,
  prompt: "一只橘猫",
  model: "m",
  connection: "c",
  revision: 1,
  source: { kind: "user" },
  phase,
  phaseText: "",
  problem: "",
  canCancel: false,
  canRetryDownload: false,
  createdAt: 1,
  updatedAt: 2,
  attachment,
});

// A farm per test, on real time: the library records what it hears on its own fiber.
layer(world(), { buildPerTest: true, excludeTestServices: true })("the library", (it) => {
  it.effect("keeps what the user says with a file, and what a ready job made, once each", () =>
    Effect.gen(function* () {
      const library = yield* Library;
      const chat = yield* Channel;
      const core = yield* Core;
      const said = yield* (yield* Attachment).attach(file("note.txt", "打卡规则"));
      const { message } = yield* chat.post({ _tag: "User", text: "看这个", sendKey: "k1", attachments: [said.id] });
      const uploaded = yield* waitFor(library.list({ origin: "uploaded" }), (items) => items.length === 1, "the uploaded file");
      expect(uploaded[0]).toMatchObject({ attachment: said, origin: { kind: "uploaded", channel: message.channel, message: message.id } });

      const made = yield* (yield* Attachment).attach(file("cat.png", "not really a png", "image/png"));
      yield* core.apply({ type: "mediaChanged", jobs: [image("job-1", made, "generating")] });
      yield* core.apply({ type: "mediaChanged", jobs: [image("job-1", made, "ready")] });
      yield* core.apply({ type: "mediaChanged", jobs: [image("job-1", made, "ready")] });
      const generated = yield* waitFor(library.list({ origin: "generated" }), (items) => items.length === 1, "the generated file");
      expect(generated[0]).toMatchObject({ attachment: made, origin: { kind: "generated", job: "job-1", jobKind: "image" } });

      // The same file said again is the same item, its first origin kept.
      yield* chat.post({ _tag: "User", text: "再看一次", sendKey: "k2", attachments: [made.id] });
      const all = yield* waitFor(library.list({}), (items) => items[0]?.attachment.id === made.id && items[0].lastAt > items[0].addedAt, "the item moved up");
      expect(Arr.map(all, (i) => [i.attachment.id, i.origin.kind])).toEqual([
        [made.id, "generated"],
        [said.id, "uploaded"],
      ]);
      const images = yield* library.list({ type: "image" });
      const others = yield* library.list({ type: "other" });
      expect([images.length, others.length]).toEqual([1, 1]);
      // Words in the name, any case; by name and by size the other way round from the arrivals.
      const named = yield* library.list({ text: "CAT" });
      const byName = yield* library.list({ sort: "name" });
      const bySize = yield* library.list({ sort: "size" });
      expect(Arr.map(named, (i) => i.attachment.id)).toEqual([made.id]);
      expect(Arr.map(byName, (i) => i.attachment.name)).toEqual(["cat.png", "note.txt"]);
      expect(Arr.map(bySize, (i) => i.attachment.id)).toEqual(made.size >= said.size ? [made.id, said.id] : [said.id, made.id]);
    }),
  );

  it.effect("takes an item out but keeps the file a message has", () =>
    Effect.gen(function* () {
      const library = yield* Library;
      const files = yield* Attachment;
      const kept = yield* files.attach(file("a.txt", "a"));
      const item = yield* library.add({ attachment: kept.id }, { kind: "user" });
      expect(item.origin).toEqual({ kind: "uploaded" });
      const preview = yield* library.previewRemove(kept.id);
      expect(preview.does).toHaveLength(1);
      yield* library.remove(kept.id);
      const left = yield* library.list({});
      const stillThere = yield* files.get(kept.id);
      const again = yield* Effect.flip(library.remove(kept.id));
      expect([left, stillThere === undefined, again.kind]).toEqual([[], false, "Missing"]);
    }),
  );

  it.effect("refuses what does not name one public source, or is not the caller's to give", () =>
    Effect.gen(function* () {
      const library = yield* Library;
      const helper: AddedBy = { kind: "agent", agent: "lab", session: sessionId("w1") };
      const notPublic = ["http://example.com/a.png", "https://127.0.0.1/a.png", "https://10.0.0.8/a.png", "https://[::1]/a.png", "file:///etc/passwd"];
      const asks: readonly (readonly [T.LibraryAddRequest, AddedBy])[] = [
        [{}, helper],
        [{ url: "https://example.com/a.png", path: "a.png" }, helper],
        [{ url: "https://example.com/a.png" }, { kind: "user" }],
        [{ attachment: "x" }, helper],
        ...Arr.map(notPublic, (url) => [{ url }, helper] as const),
        // A helper with no working directory has nowhere to read a path from.
        [{ path: "a.png" }, helper],
      ];
      const tags = yield* Effect.forEach(asks, ([req, by]) => Effect.map(Effect.flip(library.add(req, by)), (e) => e.kind));
      expect(tags).toEqual(Arr.map(asks, () => "Refused"));
    }),
  );
});
