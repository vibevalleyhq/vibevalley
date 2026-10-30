import { dayMs, type Memory, memoryKeep } from "@vibevalley/protocol";
import { expect, test } from "vite-plus/test";
import { checkCases, goldenCases } from "@/testing/golden.ts";
import { lineOf, memoryNotesOf, nextForgotten, pick, type PickCue, relevance } from "./recall.ts";
import { termsOf } from "./terms.ts";
import { sessionId } from "@vibevalley/protocol/schema";

// Go's math.Exp on arm64 (where the cases were recorded) is its own assembly, with fused multiply-adds; V8's is fdlibm's.
// They can differ in the last bit, so a relevance within 1e-12 of the Go's is the same one; the picks must agree exactly.
const near = (got: number | null, want: number | null) => got === want || (got !== null && want !== null && Math.abs(got - want) <= 1e-12 * Math.abs(want));

test("the recorded recalls: the terms, each memory's relevance, the pick", () => {
  const failed = checkCases(goldenCases("memory"), (c) => {
    const want = (c.out as { relevance: (number | null)[] }).relevance;
    const input = c.in as { memories: Memory[]; cue: Omit<PickCue, "skip"> & { skip?: string[] } };
    const cue: PickCue = { ...input.cue, skip: new Set(input.cue.skip ?? []) };
    const terms = termsOf(cue.text);
    return {
      terms: [...terms].toSorted(),
      relevance: input.memories.map((m, i) => {
        const got = relevance(m, cue, terms) ?? null;
        return near(got, want[i] ?? null) ? (want[i] ?? null) : got;
      }),
      pick: pick(input.memories, cue).map((m) => m.id),
    };
  });
  expect(failed).toEqual([]);
});

const now = 1_800_000_000_000;
const memory = (id: string, text: string, change: Partial<Memory> = {}): Memory => ({
  id,
  agent: "lab",
  kind: "note",
  text,
  at: now - dayMs,
  recalled: 0,
  fading: false,
  ...change,
});
const cue = (text: string, change: Partial<PickCue> = {}): PickCue => ({ session: "w9", project: "clock", text, skip: new Set(), now, ...change });
const ids = (ms: readonly Memory[]) => ms.map((m) => m.id);

test("terms leave out the too common", () => {
  expect([...termsOf("用 pnpm test 跑测试")].toSorted()).toEqual(["pnpm", "test", "测试"].toSorted());
  expect(termsOf("我们需要一个接口").has("一个")).toBe(false);
});

test("notes: this project's, everyone's, and another's only when it plainly shares the words", () => {
  const memories = [
    memory("here", "迁移文件在 db/migrations，改表先写迁移", { project: "clock" }),
    memory("everywhere", "主人要提交信息写中文"),
    memory("other", "博客用 hugo 生成", { project: "blog" }),
    memory("other-related", "分页接口用 limit 和 offset 参数，默认 20 条", { project: "blog" }),
  ];
  expect(ids(pick(memories, cue("打卡记录的接口加个分页")))).toEqual(["here", "everywhere"]);
  expect(ids(pick(memories, cue("分页接口加上 limit 和 offset 参数")))).toEqual(["other-related", "here", "everywhere"]);
});

test("jobs: this project's only, three at most, not its own session's", () => {
  const memories = [
    ...Array.from({ length: 5 }, (_, i) =>
      memory(`job${i}`, `第 ${i} 件活 → 做好了`, { kind: "issue", project: "clock", session: sessionId(`w${i}`), at: now - i * dayMs }),
    ),
    memory("note", "迁移文件在 db/migrations", { project: "clock" }),
    memory("job-blog", "博客的活 → 做好了", { kind: "issue", project: "blog", session: sessionId("w8") }),
  ];
  expect(ids(pick(memories, cue("随便做点什么")))).toEqual(["note", "job0", "job1", "job2"]);
  expect(ids(pick(memories, cue("随便做点什么", { session: "w0", skip: new Set(["note"]) })))).toEqual(["job1", "job2", "job3"]);
  const many = Array.from({ length: 20 }, (_, i) => memory(`n${i}`, `这个项目的第 ${i} 条约定`, { project: "clock" }));
  expect(pick(many, cue("做点什么"))).toHaveLength(8);
});

test("lines, and what goes first when there are too many", () => {
  expect(lineOf(memory("1", "迁移文件在 db/migrations", { project: "clock" }), "clock")).toBe("- （这个项目）迁移文件在 db/migrations");
  expect(lineOf(memory("2", "主人要提交信息写中文"), "clock")).toBe("- （所有项目）主人要提交信息写中文");
  const many = Array.from({ length: memoryKeep - 1 }, (_, i) => memory(`n${i}`, `第 ${i} 条`, { at: now - i * dayMs }));
  expect(nextForgotten(many, 1)).toEqual([]);
  const recalled = many.map((m) => (m.id === `n${memoryKeep - 2}` ? { ...m, recalledAt: now } : m));
  expect(nextForgotten(recalled, 3)).toEqual([`n${memoryKeep - 3}`, `n${memoryKeep - 4}`]);
});

test("the 记住 lines a run said", () => {
  expect(memoryNotesOf("做完了。\n- **记住**：测试用 pnpm test\n记住（所有项目）: 提交信息写中文\n记住：测试用 pnpm test")).toEqual([
    { text: "测试用 pnpm test", everywhere: false },
    { text: "提交信息写中文", everywhere: true },
  ]);
});
