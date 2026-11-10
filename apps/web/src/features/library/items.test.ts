import { Array as Arr } from "effect";
import { expect, test } from "vite-plus/test";

import type { LibraryItem, MediaJob } from "@vibevalley/protocol";

import { kindOf, making, originLine, shown, understoodText } from "./items.ts";

const item = (id: string, type: string, origin: LibraryItem["origin"]): LibraryItem => ({
  attachment: { id, name: `${id}.bin`, type, size: 1 },
  origin,
  addedAt: 0,
  lastAt: 0,
});
const picture = item("a", "image/png", { kind: "generated", job: "j1", jobKind: "image" });
const song = item("b", "audio/mpeg", { kind: "uploaded" });
const page = item("c", "text/html", { kind: "fetched", agent: "lab", from: { url: "https://example.com/a.html" } });
const names = { agent: (id: string) => (id === "lab" ? "实验员" : id), channel: (id: string) => (id === "c1" ? "#general" : id) };

test("a file's kind is read off its media type", () => {
  expect(Arr.map(["image/webp", "audio/wav", "video/mp4", "application/pdf"], kindOf)).toEqual(["image", "audio", "video", "other"]);
});

test("the filters let through what both name", () => {
  const all = [picture, song, page];
  expect(shown({ items: all, origin: "all", kind: "all" })).toEqual(all);
  expect(shown({ items: all, origin: "uploaded", kind: "all" })).toEqual([song]);
  expect(shown({ items: all, origin: "all", kind: "other" })).toEqual([page]);
  expect(shown({ items: all, origin: "generated", kind: "audio" })).toEqual([]);
});

test("the origin line says who and from where", () => {
  expect(originLine(names)(picture.origin)).toBe("生成的 · 生图");
  expect(originLine(names)(song.origin)).toBe("你在素材库上传的");
  expect(originLine(names)({ kind: "uploaded", channel: "c1", message: "m" })).toBe("你在 #general 发的");
  expect(originLine(names)(page.origin)).toBe("实验员 从 https://example.com/a.html 拿回来的");
  expect(originLine(names)({ kind: "fetched", agent: "x", session: "w1", from: { path: "out/a.png" } })).toBe("x 从工作目录的 out/a.png 拿回来的");
});

const job = (more: Partial<MediaJob> & Pick<MediaJob, "kind" | "phase">) => ({ id: "j", updatedAt: 0, ...more }) as MediaJob;

test("jobs still making a file come first; understanding makes none", () => {
  const jobs = [job({ kind: "image", phase: "generating" }), job({ kind: "image", phase: "ready" }), job({ kind: "understanding", phase: "generating" })];
  expect(making(jobs)).toEqual([jobs[0]]);
});

test("a card shows the newest understanding of its file", () => {
  const understood = (text: string, hash: string, updatedAt: number) =>
    job({ kind: "understanding", phase: "ready", updatedAt, inputs: [{ hash }], result: { text } } as unknown as Partial<MediaJob> &
      Pick<MediaJob, "kind" | "phase">);
  const jobs = [understood("old", "a", 1), understood("new", "a", 2), understood("other", "b", 3)];
  expect(understoodText("a")(jobs)).toBe("new");
  expect(understoodText("c")(jobs)).toBeUndefined();
});
