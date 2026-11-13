// Artifacts shaped like VibeValley's protocol (packages/protocol artifact
// shapes) until the server serves `artifact.*`: a written blocks one for an
// issue, an html page with two versions said in #general, a deck of slides
// with speaker notes, and one the user made. Pages open by id, an html
// version's page by id and version; a submit is taken as it is.
import type { Artifact, ArtifactContent, ArtifactId, Block, BlockAck, BlockId, BlockSnapshot, BlockType, IssueId, TextSpan } from "@vibevalley/protocol";

const min = 60_000;
const now = Date.now();
const id = (s: string) => s as ArtifactId;

const page1 = String.raw`<!doctype html>
<html><head><meta charset="utf-8"><title>登录流程</title>
<style>body{font:16px/1.6 var(--vv-font-sans, system-ui);margin:0;padding:32px 40px;background:var(--vv-page);color:var(--vv-ink)}h1{margin:0 0 12px}ol{padding-left:1.2em}.box{border:1px solid var(--vv-line);border-radius:8px;padding:12px 16px;margin-top:16px}</style>
</head><body>
<h1>登录流程</h1>
<p>登录过期时，回到登录页并记住要去的地方。</p>
<ol><li>打开任一页</li><li>会话过期：跳到 /login?next=…</li><li>登录后回到原页</li></ol>
<div class="box">两条测试：过期跳转、登录后回跳。</div>
</body></html>`;

const page2 = page1.replace("两条测试：过期跳转、登录后回跳。", "三条测试：过期跳转、登录后回跳、next 只收站内地址。");

const deck = String.raw`<!doctype html>
<html><head><meta charset="utf-8"><title>本周进展</title></head><body>
<section class="title"><h1>本周进展</h1><small>田头周会</small><aside class="notes">先说结论：看板能拖了。</aside></section>
<section><h2>做完的</h2><ul><li>看板拖拽</li><li>登录过期回跳</li><li>设置按用途分组</li></ul><aside class="notes">拖拽的手感还要再调。</aside></section>
<section><h2>下周</h2><ul><li>灵动岛动画</li><li>首页加载条</li></ul></section>
</body></html>`;

const version = (v: number, note: string, by: string, byName: string, at: number, number?: number) => ({
  version: v,
  size: 1200,
  note,
  by,
  byName,
  at,
  channel: "general",
  ...(number !== undefined ? { number } : {}),
});

export const artifacts: Artifact[] = [
  {
    id: id("art-plan"),
    title: "看板拖拽的方案",
    body: "blocks",
    channel: "general",
    said: { channel: "general", number: 3 },
    issue: "i22" as IssueId,
    by: "w1",
    byName: "老周",
    version: 0,
    seq: 4,
    versions: [],
    at: now - 90 * min,
    updated: now - 6 * min,
  },
  {
    id: id("art-login"),
    title: "登录流程",
    body: "html",
    display: "page",
    channel: "general",
    said: { channel: "general", number: 2 },
    issue: "i18" as IssueId,
    by: "w1",
    byName: "老周",
    version: 2,
    seq: 0,
    versions: [version(1, "第一版", "w1", "老周", now - 50 * min, 2), version(2, "多一条测试", "w1", "老周", now - 20 * min, 4)],
    at: now - 50 * min,
    updated: now - 20 * min,
  },
  {
    id: id("art-deck"),
    title: "本周进展",
    body: "html",
    display: "slides",
    channel: "general",
    by: "orchestrator",
    byName: "助手",
    version: 1,
    seq: 0,
    versions: [version(1, "周会用", "orchestrator", "助手", now - 3 * 60 * min)],
    at: now - 3 * 60 * min,
    updated: now - 3 * 60 * min,
  },
  {
    id: id("art-mine"),
    title: "发版前要查的",
    body: "blocks",
    by: "user",
    byName: "用户",
    version: 0,
    seq: 1,
    versions: [],
    at: now - 26 * 60 * min,
    updated: now - 25 * 60 * min,
  },
];

const contents: Record<string, Record<number, string>> = { "art-login": { 1: page1, 2: page2 }, "art-deck": { 1: deck } };

const spans = (t: string): TextSpan[] => (t ? [{ t, marks: {} }] : []);
let order = 0;
const block = (artifact: string, type: BlockType, text: string, by: string, attrs: Block["attrs"] = {}, more: TextSpan[] = []): Block => ({
  id: `${artifact}-b${++order}` as BlockId,
  orderKey: `a${String(order).padStart(4, "0")}`,
  type,
  attrs,
  text: [...spans(text), ...more],
  artifactId: id(artifact),
  rev: 1,
  updatedBy: by,
  updated: now - order * min,
});

const blocks: Record<string, Block[]> = {
  "art-plan": [
    block("art-plan", "heading", "目标", "w1", { level: 2 }),
    block("art-plan", "paragraph", "卡片拖到别的列就改状态，拖到同列就排序；松手前看得到落点。", "w1"),
    block("art-plan", "heading", "做法", "w1", { level: 2 }),
    block("art-plan", "bulleted", "按下时量好每列和每张卡的位置", "w1"),
    block("art-plan", "bulleted", "拖动时画一张影子卡，", "w1", {}, [{ t: "不动原卡", marks: { bold: true } }]),
    block("art-plan", "bulleted", "松手时发 issue.status.update", "user"),
    block("art-plan", "todo", "量列宽", "w1", { checked: true }),
    block("art-plan", "todo", "落点线", "w1", { checked: false }),
    block("art-plan", "code", "const lane = lanes.find((l) => x >= l.left && x < l.right);", "w1", { language: "ts" }),
    block("art-plan", "quote", "手感比动画重要。", "user"),
  ],
  "art-mine": [
    block("art-mine", "heading", "发版前", "user", { level: 2 }),
    block("art-mine", "todo", "跑一遍全部测试", "user", { checked: false }),
    block("art-mine", "todo", "看一眼深色主题", "user", { checked: false }),
  ],
};

const one = (p: unknown) => artifacts.find((a) => a.id === (p as { id: string }).id);
const missing = { bizCode: 100004, message: "artifact not found" };

/** `{ op: data }`, a function of the call's payload where the answer depends on it. */
export const responses: Record<string, unknown> = {
  "artifact.list": Object.assign(
    (p: { issue?: string; channel?: string }) =>
      artifacts.filter((a) => (p?.issue === undefined || a.issue === p.issue) && (p?.channel === undefined || a.channel === p.channel)),
    { toJSON: () => artifacts },
  ),
  "artifact.get": Object.assign((p: unknown) => one(p) ?? missing, { toJSON: () => artifacts[0] }),
  "artifact.content.get": Object.assign(
    (p: { id: string; version?: number }): ArtifactContent | typeof missing => {
      const a = one(p);
      const v = p.version ?? a?.version ?? 0;
      const content = contents[p.id]?.[v];
      return content === undefined ? missing : { version: v, content };
    },
    { toJSON: (): ArtifactContent => ({ version: 2, content: page2 }) },
  ),
  "artifact.block.list": Object.assign(
    (p: unknown): BlockSnapshot | typeof missing => {
      const a = one(p);
      return a ? { artifact: a, blocks: blocks[a.id] ?? [] } : missing;
    },
    { toJSON: (): BlockSnapshot => ({ artifact: artifacts[0] as Artifact, blocks: blocks["art-plan"] ?? [] }) },
  ),
  "artifact.submit": Object.assign(
    (p: { batchId: string; lastSeq: number }): BlockAck => ({ batchId: p.batchId, seq: p.lastSeq + 1, results: [], blocks: [] }),
    { toJSON: () => ({ batchId: "", seq: 0, results: [], blocks: [] }) },
  ),
  "artifact.suggestion.list": [],
  "artifact.create": { ...artifacts[3], id: id("art-new"), title: "未命名", seq: 0 },
  "artifact.update": artifacts[0],
  "artifact.delete": null,
  "artifact.html.edit": artifacts[1],
  "artifact.demo": null,
};
