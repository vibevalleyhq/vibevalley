// Writes what VibeValley's own memory code says for a set of inputs, so the
// Rust port can be checked against it. Run from VibeValley's checkout:
//   ./node_modules/.bin/vpx <this file> <out dir>
// Imports VibeValley's files by absolute path; writes only into <out dir>.
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const vv = process.cwd();
const gse = await import(join(vv, "apps/server/src/modules/memory/gse.ts"));
const recall = await import(join(vv, "apps/server/src/modules/memory/recall.ts"));
const redact = await import(join(vv, "apps/server/src/base/redact.ts"));

const texts = [
  "修好登录页的时钟显示，时区按用户设置",
  "我们在 db/migrations 里加了 v1.2.3 的迁移，跑 pnpm test 通过",
  "南京市长江大桥",
  "用户喜欢简短回答，不要用表情",
  "帮工把 apps/server/src/main.ts 的启动顺序改了，Redis 先于 Postgres",
  "İstanbul ÇAĞRI 和 Ünicode 测试 3.14 abc123",
  "这个仓库用 Vite+ 构建，命令是 vp run build",
  "",
];
const cuts = texts.map((t) => ({ text: t, search: gse.cutSearch(t), all: gse.cutAll(t), terms: recall.termsList(t) }));

const day = 86_400_000;
const now = 100 * day;
const mem = (id: string, kind: string, text: string, repo?: string, extra: Record<string, unknown> = {}) => ({
  id, agent: "a", kind, text, author: "agent", at: now - 10 * day, recalled: 0, fading: false,
  ...(repo === undefined ? {} : { repo }), ...extra,
});
const memories = [
  mem("m1", "note", "登录页的时钟用用户时区显示", "web"),
  mem("m2", "note", "数据库迁移放在 db/migrations，命名带版本号", "web"),
  mem("m3", "issue", "修好时钟 → 改成按用户时区", "web"),
  mem("m4", "issue", "别的仓库的时钟工单", "api"),
  mem("m5", "note", "用户喜欢简短回答", undefined, { recalledAt: now - day }),
  mem("m6", "note", "另一个仓库里登录页时钟时区用户设置的笔记", "api"),
  mem("m7", "note", "我自己这一轮写下的", "web", { session: "w1" }),
  mem("m8", "note", "很久以前的笔记，和时钟无关", "web", { at: now - 400 * day }),
];
const cue = { session: "w1", repo: "web", text: texts[0], skip: new Set(["m2"]), now, matches: { m1: 3, m3: 7 } };
const picked = recall.pick(memories, cue).map((m: { id: string }) => m.id);
const lines = memories.map((m) => recall.lineOf(m, "web"));
const likeness = recall.memoryLikeness(recall.termsOf(texts[0]), recall.termsOf("修好登录页的时钟，时区按用户设置"));
const isNew = [
  recall.memoryIsNewNote(memories, "用户喜欢简短回答", undefined),
  recall.memoryIsNewNote(memories, "用户喜欢简短的回答", undefined),
  recall.memoryIsNewNote(memories, "完全不同的一句话", undefined),
];
const secrets = [
  "key sk-abcdefghijklmnopqrstuvwx and ghp_abcdefghijklmnopqrstuvwxyz0123",
  "Authorization: Bearer abc.def-ghi_jkl",
  'api_key=supersecret123 "token": "zzzzzzzz" password: hunter22',
  "AKIAABCDEFGHIJKLMNOP and AIza" + "x".repeat(32),
  "nothing secret here, token is short: ab",
];
const redacted = secrets.map((s) => redact.redact(s));
const issueText = recall.issueMemoryText("修好登录页的时钟显示".repeat(12), "改成按用户时区", "failed");

writeFileSync(join(process.argv[2]!, "golden.json"), JSON.stringify({ cuts, memories, cue: { ...cue, skip: [...cue.skip] }, picked, lines, likeness, isNew, secrets, redacted, issueText }, null, 1));
console.log("wrote", cuts.length, "cuts,", picked.length, "picked");
