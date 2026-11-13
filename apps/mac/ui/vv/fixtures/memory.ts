// The memory panels' answers (fakeHost answers by op, so every profile reads
// the same list): what helpers did, notes by repo (Memory.stories' kept and
// fading notes), the farm's own and an outside source, the next recall.
import type { MemoryList, RecallPreview, SessionId } from "@vibevalley/protocol";

const now = Date.now();
const day = 86_400_000;
const hour = 3_600_000;
const sid = (id: string) => id as SessionId;

export const memories: MemoryList = {
  memories: [
    {
      id: "m-issue-1",
      agent: "laozhou",
      kind: "issue",
      text: "#12 设置按用途分组：拆成三组，测试补在 settings.spec.ts。",
      author: "agent",
      repo: "vibevalley",
      session: sid("w3"),
      at: now - 5 * hour,
      recalled: 0,
      fading: false,
    },
    {
      id: "m-note-1",
      agent: "laozhou",
      kind: "note",
      text: "这个仓库的测试用 vp test；不要开 next dev。",
      author: "user",
      repo: "vibevalley",
      at: now - 3 * day,
      recalled: 4,
      recalledAt: now - day,
      fading: false,
    },
    {
      id: "m-note-2",
      agent: "laozhou",
      kind: "note",
      text: "登录态过期时回到登录页，不要弹窗。",
      author: "agent",
      session: sid("w1"),
      repo: "vibevalley",
      at: now - 12 * day,
      recalled: 0,
      fading: true,
    },
    {
      id: "m-note-3",
      agent: "laozhou",
      kind: "note",
      text: "提交信息写中文，一句话说清改了什么。",
      author: "user",
      at: now - 20 * day,
      recalled: 9,
      recalledAt: now - 2 * hour,
      fading: false,
    },
    {
      id: "m-note-4",
      agent: "laozhou",
      kind: "note",
      text: "Rust 依赖一律 cargo add 最新版。",
      author: "system",
      repo: "vibevalley",
      source: "nowledge",
      at: now - 6 * day,
      recalled: 1,
      fading: false,
    },
  ],
  sources: [
    { name: "farm", label: "农场", on: true, off: "", canList: true, canForget: true, transcripts: false },
    { name: "nowledge", label: "Nowledge Mem", on: true, off: "", canList: true, canForget: false, transcripts: true },
  ],
};

const recall: RecallPreview = {
  lines: ["- 这个仓库的测试用 vp test；不要开 next dev。", "- 提交信息写中文，一句话说清改了什么。"],
  chars: 52,
  limit: 1200,
};

export const responses: Record<string, unknown> = {
  "memory.list": memories,
  "memory.recall": recall,
  "memory.create": memories.memories[1],
  "memory.delete": null,
};
