import { expect, test } from "vite-plus/test";

import type { LibraryItem, MediaJob } from "@vibevalley/protocol";
import { messageId, sessionId } from "@vibevalley/protocol/schema";

import { between, countsOf, durationText, extOf, justify, kindOf, making, neighbor, originLine, shown, understoodText, whereKey } from "./items.ts";

const item = (id: string, type: string, origin: LibraryItem["origin"]): LibraryItem => ({
  attachment: { id, name: `${id}.bin`, type, size: 1 },
  origin,
  addedAt: 0,
  lastAt: 0,
});
const picture = item("a", "image/png", { kind: "generated", job: "j1", jobKind: "image" });
const song = item("b", "audio/mpeg", { kind: "uploaded" });
const page = item("c", "text/html", { kind: "fetched", agent: "lab", from: { url: "https://example.com/a.html" } });
const said = item("d", "image/jpeg", { kind: "uploaded", channel: "c1", message: messageId("m1") });
const names = { agent: (id: string) => (id === "lab" ? "实验员" : id), channel: (id: string) => (id === "c1" ? "#general" : id) };

test("a file's kind is read off its media type", () => {
  expect(["image/webp", "audio/wav", "video/mp4", "application/pdf"].map(kindOf)).toEqual(["image", "audio", "video", "other"]);
});

test("the rail lets through what both its groups name", () => {
  const all = [picture, song, page];
  expect(shown({ items: all, where: { by: "all" }, kind: "all" })).toEqual(all);
  expect(shown({ items: all, where: { by: "origin", origin: "uploaded" }, kind: "all" })).toEqual([song]);
  expect(shown({ items: all, where: { by: "all" }, kind: "other" })).toEqual([page]);
  expect(shown({ items: all, where: { by: "origin", origin: "generated" }, kind: "audio" })).toEqual([]);
  expect(shown({ items: all, where: { by: "agent", agent: "lab" }, kind: "all" })).toEqual([page]);
  expect(shown({ items: [...all, said], where: { by: "channel", channel: "c1" }, kind: "all" })).toEqual([said]);
  expect(whereKey({ by: "channel", channel: "c1" })).toBe("channel:c1");
});

test("each group of the rail is counted with the other group's choice applied", () => {
  const counts = countsOf({ items: [picture, song, page, said], where: { by: "origin", origin: "uploaded" }, kind: "image" });
  // Over the images: one generated, one said in c1.
  expect(counts.where).toEqual(
    new Map([
      ["all", 2],
      ["generated", 1],
      ["channel:c1", 1],
      ["uploaded", 1],
    ]),
  );
  // Over the uploads: a sound and a picture.
  expect(counts.kind).toEqual(
    new Map([
      ["all", 2],
      ["audio", 1],
      ["image", 1],
    ]),
  );
  expect([counts.channels, counts.agents]).toEqual([["c1"], ["lab"]]);
});

test("rows are justified to the width, the last one left at its height", () => {
  const rows = justify({ ratios: [1, 2, 1, 1, 0.1], width: 400, height: 100, gap: 0 });
  // 1+2+1 = 4 at 100 high is exactly 400 wide; the rest is the last row, a sliver kept to half as wide as high.
  expect(rows.map((r) => r.map((p) => [p.index, p.width, p.height]))).toEqual([
    [
      [0, 100, 100],
      [1, 200, 100],
      [2, 100, 100],
    ],
    [
      [3, 100, 100],
      [4, 50, 100],
    ],
  ]);
  const scaled = justify({ ratios: [1, 1, 1], width: 250, height: 100, gap: 10 });
  // Three would be 320 wide: the row shrinks to (250 - 20) / 3 high and fills the width with its gaps.
  expect((scaled[0] ?? []).map((p) => Math.round(p.height))).toEqual([77, 77, 77]);
  expect(Math.round((scaled[0]?.at(-1)?.x ?? 0) + (scaled[0]?.at(-1)?.width ?? 0))).toBe(250);
  expect(justify({ ratios: [1], width: 0, height: 100, gap: 0 })).toEqual([]);
});

test("arrows step through the order, and up and down go to the nearest tile in the next row", () => {
  const rows = justify({ ratios: [1, 2, 1, 1, 1], width: 400, height: 100, gap: 0 });
  expect([neighbor({ rows, index: 0, key: "left" }), neighbor({ rows, index: 0, key: "right" }), neighbor({ rows, index: 4, key: "right" })]).toEqual([
    undefined,
    1,
    undefined,
  ]);
  // Index 1 spans 100..300, its middle 200: below, tile 3 (0..100, middle 50) and 4 (100..200, middle 150): 4 is nearer.
  expect([neighbor({ rows, index: 1, key: "down" }), neighbor({ rows, index: 3, key: "up" }), neighbor({ rows, index: 0, key: "up" })]).toEqual([
    4,
    0,
    undefined,
  ]);
});

test("a shift-click takes everything between, either way round", () => {
  expect(between({ ids: ["a", "b", "c", "d"], from: "b", to: "d" })).toEqual(["b", "c", "d"]);
  expect(between({ ids: ["a", "b", "c", "d"], from: "c", to: "a" })).toEqual(["a", "b", "c"]);
  expect(between({ ids: ["a", "b"], from: "gone", to: "b" })).toEqual(["b"]);
});

test("a file without a picture shows its extension and a sound its length", () => {
  expect([extOf("notes.txt"), extOf("archive.tar.gz"), extOf("README"), extOf(".env")]).toEqual(["TXT", "GZ", "", ""]);
  expect([durationText(0), durationText(65.4), durationText(3725)]).toEqual(["0:00", "1:05", "1:02:05"]);
});

test("the origin line says who and from where", () => {
  expect(originLine(names)(picture.origin)).toBe("生成的 · 生图");
  expect(originLine(names)(song.origin)).toBe("你在素材库上传的");
  expect(originLine(names)({ kind: "uploaded", channel: "c1", message: messageId("m") })).toBe("你在 #general 发的");
  expect(originLine(names)(page.origin)).toBe("实验员 从 https://example.com/a.html 拿回来的");
  expect(originLine(names)({ kind: "fetched", agent: "x", session: sessionId("w1"), from: { path: "out/a.png" } })).toBe("x 从工作目录的 out/a.png 拿回来的");
});

const job = (more: Partial<MediaJob> & Pick<MediaJob, "kind" | "phase">) => ({ id: "j", updatedAt: 0, ...more }) as MediaJob;

test("jobs still making a file come first; understanding makes none", () => {
  const jobs = [job({ kind: "image", phase: "generating" }), job({ kind: "image", phase: "ready" }), job({ kind: "understanding", phase: "generating" })];
  expect(making(jobs)).toEqual([jobs[0]]);
});

test("the inspector shows the newest understanding of its file", () => {
  const understood = (text: string, hash: string, updatedAt: number) =>
    job({ kind: "understanding", phase: "ready", updatedAt, inputs: [{ hash }], result: { text } } as unknown as Partial<MediaJob> &
      Pick<MediaJob, "kind" | "phase">);
  const jobs = [understood("old", "a", 1), understood("new", "a", 2), understood("other", "b", 3)];
  expect(understoodText("a")(jobs)).toBe("new");
  expect(understoodText("c")(jobs)).toBeUndefined();
});
