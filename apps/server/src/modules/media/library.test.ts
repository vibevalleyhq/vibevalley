import { describe, expect, test } from "vite-plus/test";

import type * as T from "@vibevalley/protocol";
import { ApiError } from "@vibevalley/protocol/api";
import { sessionId } from "@vibevalley/protocol/schema";
import { waitFor } from "@vibevalley/testkit/until";

import { world } from "#/testing/world.ts";

import type { AddedBy } from "./library.ts";

/** What p failed with; the test fails when it did not. */
const failure = async (p: Promise<unknown>) => {
  const e = await p.then(
    () => expect.unreachable("it was not refused"),
    (e: unknown) => e,
  );
  return e instanceof ApiError ? e : expect.unreachable(String(e));
};

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

// A farm per test, on real time: the library records what it hears in the background.
describe("the library", () => {
  test("keeps what the user says with a file, and what a ready job made, once each", async () => {
    await using farm = await world();
    const { media, channel: chat, core } = farm;
    const said = await farm.attachment.attach(file("note.txt", "打卡规则"));
    const { message } = await chat.post({ _tag: "User", text: "看这个", sendKey: "k1", attachments: [said.id] });
    const uploaded = await waitFor(
      () => media.libraryItems({ origin: "uploaded" }),
      (items) => items.length === 1,
      "the uploaded file",
    );
    expect(uploaded[0]).toMatchObject({ attachment: said, origin: { kind: "uploaded", channel: message.channel, message: message.id } });

    const made = await farm.attachment.attach(file("cat.png", "not really a png", "image/png"));
    core.apply({ type: "mediaChanged", jobs: [image("job-1", made, "generating")] });
    core.apply({ type: "mediaChanged", jobs: [image("job-1", made, "ready")] });
    core.apply({ type: "mediaChanged", jobs: [image("job-1", made, "ready")] });
    const generated = await waitFor(
      () => media.libraryItems({ origin: "generated" }),
      (items) => items.length === 1,
      "the generated file",
    );
    expect(generated[0]).toMatchObject({ attachment: made, origin: { kind: "generated", job: "job-1", jobKind: "image" } });

    // The same file said again is the same item, its first origin kept.
    await chat.post({ _tag: "User", text: "再看一次", sendKey: "k2", attachments: [made.id] });
    const all = await waitFor(
      () => media.libraryItems({}),
      (items) => items[0]?.attachment.id === made.id && items[0].lastAt > items[0].addedAt,
      "the item moved up",
    );
    expect(all.map((i) => [i.attachment.id, i.origin.kind])).toEqual([
      [made.id, "generated"],
      [said.id, "uploaded"],
    ]);
    const images = await media.libraryItems({ type: "image" });
    const others = await media.libraryItems({ type: "other" });
    expect([images.length, others.length]).toEqual([1, 1]);
    // Words in the name, any case; by name and by size the other way round from the arrivals.
    const named = await media.libraryItems({ text: "CAT" });
    const byName = await media.libraryItems({ sort: "name" });
    const bySize = await media.libraryItems({ sort: "size" });
    expect(named.map((i) => i.attachment.id)).toEqual([made.id]);
    expect(byName.map((i) => i.attachment.name)).toEqual(["cat.png", "note.txt"]);
    expect(bySize.map((i) => i.attachment.id)).toEqual(made.size >= said.size ? [made.id, said.id] : [said.id, made.id]);
  });

  test("takes an item out but keeps the file a message has", async () => {
    await using farm = await world();
    const { media, attachment: files } = farm;
    const kept = await files.attach(file("a.txt", "a"));
    const item = await media.addLibraryItem({ attachment: kept.id }, { kind: "user" });
    expect(item.origin).toEqual({ kind: "uploaded" });
    const preview = await media.previewRemoveLibraryItem(kept.id);
    expect(preview.does).toHaveLength(1);
    await media.removeLibraryItem(kept.id);
    const left = await media.libraryItems({});
    const stillThere = await files.get(kept.id);
    const again = await failure(media.removeLibraryItem(kept.id));
    expect([left, stillThere === undefined, again.kind]).toEqual([[], false, "Missing"]);
  });

  test("refuses what does not name one public source, or is not the caller's to give", async () => {
    await using farm = await world();
    const { media } = farm;
    const helper: AddedBy = { kind: "agent", agent: "lab", session: sessionId("w1") };
    const notPublic = ["http://example.com/a.png", "https://127.0.0.1/a.png", "https://10.0.0.8/a.png", "https://[::1]/a.png", "file:///etc/passwd"];
    const asks: readonly (readonly [T.LibraryAddRequest, AddedBy])[] = [
      [{}, helper],
      [{ url: "https://example.com/a.png", path: "a.png" }, helper],
      [{ url: "https://example.com/a.png" }, { kind: "user" }],
      [{ attachment: "x" }, helper],
      ...notPublic.map((url) => [{ url }, helper] as const),
      // A helper with no working directory has nowhere to read a path from.
      [{ path: "a.png" }, helper],
    ];
    const tags: string[] = [];
    for (const [req, by] of asks) tags.push((await failure(media.addLibraryItem(req, by))).kind);
    expect(tags).toEqual(asks.map(() => "Refused"));
  });
});
