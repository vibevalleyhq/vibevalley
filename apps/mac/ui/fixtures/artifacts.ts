// Artifacts shaped like VibeValley's protocol (packages/protocol artifact
// shapes) until the server serves `artifact.*`: a written blocks one for an
// issue, an html page with two versions said in #general, a deck of slides
// with speaker notes, and one the user made. Pages open by id, an html
// version's page by id and version; a submit is taken as it is.
import type {
  Artifact,
  ArtifactContent,
  ArtifactEntry,
  ArtifactEntryBatchRequest,
  ArtifactEntryBatchResult,
  ArtifactEntrySnapshot,
  ArtifactId,
  Block,
  BlockAck,
  BlockId,
  BlockSnapshot,
  BlockType,
  IssueId,
  TextSpan,
} from "@vibevalley/protocol";

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

const artifacts: Artifact[] = [
  {
    id: id("art-plan"),
    title: "看板拖拽的方案",
    body: "blocks",
    isDefault: false,
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
    isDefault: false,
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
    isDefault: false,
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
    isDefault: false,
    by: "user",
    byName: "用户",
    version: 0,
    seq: 1,
    versions: [],
    at: now - 26 * 60 * min,
    updated: now - 25 * 60 * min,
  },
  {
    id: id("art-launch-board"),
    title: "产品发布时间线",
    body: "store",
    artifactType: "whiteboard",
    isDefault: false,
    channel: "general",
    said: { channel: "general", number: 5 },
    issue: "i22" as IssueId,
    by: "orchestrator",
    byName: "助手",
    version: 0,
    seq: 18,
    versions: [],
    at: now - 40 * min,
    updated: now - 2 * min,
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

function storeEntry(artifact: ArtifactId, path: string, valueObj: unknown, by = "orchestrator", rev = 1): ArtifactEntry {
  const value = typeof valueObj === "string" ? valueObj : JSON.stringify(valueObj);
  return {
    artifactId: artifact,
    path,
    kind: "json",
    mime: "application/json",
    size: value.length,
    rev,
    updatedBy: by,
    updated: now - 5 * min,
    value,
  };
}

const initialBoardEntries = (): Map<string, ArtifactEntry> => {
  const aid = id("art-launch-board");
  const rows: ArtifactEntry[] = [
    storeEntry(aid, "board/meta", { title: "产品发布时间线", mode: "board", grid: true }),
    storeEntry(aid, "elements/t-title", { id: "t-title", type: "text", variant: "title", x: 72, y: 36, w: 680, h: 48, label: "产品发布时间线" }),
    storeEntry(aid, "elements/t-sub", {
      id: "t-sub",
      type: "text",
      variant: "subtitle",
      x: 72,
      y: 84,
      w: 680,
      h: 28,
      label: "从方案锁定到正式交付上线：全链路协同冲刺 12 天",
      highlight: "12 天",
    }),
    storeEntry(aid, "elements/tl-main", {
      id: "tl-main",
      type: "timeline",
      x: 72,
      y: 268,
      w: 840,
      h: 96,
      fill: "peach",
      points: [
        { x: 76, y: 356 },
        { x: 240, y: 350 },
        { x: 430, y: 312 },
        { x: 640, y: 306 },
        { x: 890, y: 264 },
      ],
      milestones: [
        { t: 0.04, label: "Day 1", kind: "major" },
        { t: 0.16, label: "Day 2", kind: "major" },
        { t: 0.27, label: "Day 3", kind: "major" },
        { t: 0.38, label: "4", kind: "minor" },
        { t: 0.49, label: "5", kind: "minor", caption: "联调冲刺 4 天" },
        { t: 0.6, label: "6", kind: "minor" },
        { t: 0.72, label: "Day 7", kind: "major" },
        { t: 0.85, label: "Day 8", kind: "major" },
        { t: 0.96, label: "9", kind: "minor" },
      ],
    }),
    storeEntry(aid, "elements/c-1", {
      id: "c-1",
      type: "shape",
      shape: "card",
      x: 64,
      y: 174,
      w: 160,
      h: 108,
      title: "锁定核心范围",
      body: "核心功能已拍板",
      fill: "sun",
      sticker: "berry-lock",
    }),
    storeEntry(aid, "elements/c-2", {
      id: "c-2",
      type: "shape",
      shape: "card",
      x: 112,
      y: 422,
      w: 168,
      h: 120,
      title: "确认发布清单",
      body: "拆解到每天交付物",
      fill: "sun",
      sticker: "chart-board",
    }),
    storeEntry(aid, "elements/c-3", {
      id: "c-3",
      type: "shape",
      shape: "card",
      x: 246,
      y: 146,
      w: 168,
      h: 110,
      title: "确定资源预算",
      body: "算力与配额已就位",
      fill: "sun",
      sticker: "price-tag",
    }),
    storeEntry(aid, "elements/c-4", {
      id: "c-4",
      type: "shape",
      shape: "card",
      x: 298,
      y: 372,
      w: 170,
      h: 108,
      title: "批产核心模块",
      body: "23 项任务并发推进",
      fill: "sun",
      sticker: "crate",
    }),
    storeEntry(aid, "elements/c-5", {
      id: "c-5",
      type: "shape",
      shape: "card",
      x: 640,
      y: 114,
      w: 176,
      h: 114,
      title: "准点抵达验收",
      body: "进入主站发布通道",
      fill: "peach",
      sticker: "storefront",
    }),
    storeEntry(aid, "elements/c-6", {
      id: "c-6",
      type: "shape",
      shape: "card",
      x: 752,
      y: 356,
      w: 176,
      h: 118,
      title: "灰度与全量验证",
      body: "先验 12 组，再放量 500",
      fill: "peach",
      sticker: "bowl",
    }),
    storeEntry(aid, "elements/s-truck", { id: "s-truck", type: "sticker", sticker: "truck", x: 462, y: 244, w: 112, h: 68, label: "运输交付" }),
    storeEntry(aid, "elements/s-mascot", { id: "s-mascot", type: "sticker", sticker: "mascot", x: 752, y: 26, w: 72, h: 72, label: "老周" }),
    storeEntry(aid, "elements/t-callout", {
      id: "t-callout",
      type: "text",
      variant: "callout",
      icon: "⚠",
      x: 492,
      y: 404,
      w: 204,
      h: 48,
      label: "合包检查需等待终版配置锁定",
    }),
    storeEntry(aid, "elements/a-1", {
      id: "a-1",
      type: "arrow",
      curve: "straight",
      head: "none",
      stroke: "#c96e52",
      from: { id: "c-1", side: "s" },
      to: { x: 112, y: 354 },
    }),
    storeEntry(aid, "elements/a-2", {
      id: "a-2",
      type: "arrow",
      curve: "straight",
      head: "none",
      stroke: "#c96e52",
      from: { id: "c-2", side: "n" },
      to: { x: 204, y: 352 },
    }),
    storeEntry(aid, "elements/a-3", {
      id: "a-3",
      type: "arrow",
      curve: "straight",
      head: "none",
      stroke: "#c96e52",
      from: { id: "c-3", side: "s" },
      to: { x: 298, y: 338 },
    }),
    storeEntry(aid, "elements/a-4", {
      id: "a-4",
      type: "arrow",
      curve: "straight",
      head: "none",
      stroke: "#c96e52",
      from: { id: "c-4", side: "n" },
      to: { x: 392, y: 320 },
    }),
    storeEntry(aid, "elements/a-5", {
      id: "a-5",
      type: "arrow",
      curve: "straight",
      head: "none",
      stroke: "#c96e52",
      from: { id: "c-5", side: "s" },
      to: { x: 676, y: 300 },
    }),
    storeEntry(aid, "elements/a-6", {
      id: "a-6",
      type: "arrow",
      curve: "straight",
      head: "none",
      stroke: "#c96e52",
      from: { id: "c-6", side: "n" },
      to: { x: 780, y: 282 },
    }),
    storeEntry(aid, "elements/a-callout", {
      id: "a-callout",
      type: "arrow",
      curve: "smooth",
      head: "arrow",
      stroke: "#c96e52",
      from: { id: "t-callout", side: "e" },
      to: { id: "c-6", side: "w" },
    }),
  ];
  return new Map(rows.map((e) => [e.path, e]));
};

const storeEntriesByArtifact = new Map<string, Map<string, ArtifactEntry>>([["art-launch-board", initialBoardEntries()]]);
const storeSeqByArtifact = new Map<string, number>([["art-launch-board", 18]]);

const listEntriesFor = (req: { id: string; prefix?: string }): ArtifactEntrySnapshot | typeof missing => {
  const a = one(req);
  if (!a) return missing;
  const map = storeEntriesByArtifact.get(a.id) ?? new Map<string, ArtifactEntry>();
  const prefix = req.prefix;
  const entries = [...map.values()].filter((e) => (prefix ? e.path.startsWith(prefix) : true));
  const seq = storeSeqByArtifact.get(a.id) ?? a.seq;
  return { artifact: { ...a, seq }, seq, entries };
};

const defaultEntry = initialBoardEntries().get("elements/c-1")!;

/** `{ op: data }`, a function of the call's payload where the answer depends on it. */
export const responses: Record<string, unknown> = {
  "artifact.list": Object.assign(
    (p: { issue?: string; channel?: string; artifactType?: string }) =>
      artifacts.filter(
        (a) =>
          (p?.issue === undefined || a.issue === p.issue) &&
          (p?.channel === undefined || a.channel === p.channel) &&
          (p?.artifactType === undefined || a.artifactType === p.artifactType),
      ),
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
    { toJSON: (): BlockSnapshot => ({ artifact: artifacts[0], blocks: blocks["art-plan"] ?? [] }) },
  ),
  "artifact.entry.list": Object.assign((p: { id: string; prefix?: string }): ArtifactEntrySnapshot | typeof missing => listEntriesFor(p), {
    toJSON: (): ArtifactEntrySnapshot => listEntriesFor({ id: "art-launch-board" }) as ArtifactEntrySnapshot,
  }),
  "artifact.entry.get": Object.assign(
    (p: { id: string; path: string }): ArtifactEntry | typeof missing => {
      const a = one(p);
      if (!a) return missing;
      return storeEntriesByArtifact.get(a.id)?.get(p.path) ?? missing;
    },
    { toJSON: (): ArtifactEntry => defaultEntry },
  ),
  "artifact.entry.batch": Object.assign(
    (p: ArtifactEntryBatchRequest): ArtifactEntryBatchResult | typeof missing => {
      const a = one(p);
      if (!a) return missing;
      let map = storeEntriesByArtifact.get(a.id);
      if (!map) {
        map = new Map();
        storeEntriesByArtifact.set(a.id, map);
      }
      const updated: ArtifactEntry[] = [];
      for (const w of p.writes) {
        if (w.op === "delete") {
          map.delete(w.path);
          continue;
        }
        const prev = map.get(w.path);
        let nextVal = w.value ?? prev?.value ?? "{}";
        if (w.op === "patch" && prev?.value && w.value) {
          const prevObj = JSON.parse(prev.value) as Record<string, unknown>;
          const patchObj = JSON.parse(w.value) as Record<string, unknown>;
          for (const [k, v] of Object.entries(patchObj)) {
            if (v === null) delete prevObj[k];
            else prevObj[k] = v;
          }
          nextVal = JSON.stringify(prevObj);
        }
        const entry = storeEntry(a.id, w.path, nextVal, "user", (prev?.rev ?? 0) + 1);
        map.set(w.path, entry);
        updated.push(entry);
      }
      const nextSeq = (storeSeqByArtifact.get(a.id) ?? a.seq) + 1;
      storeSeqByArtifact.set(a.id, nextSeq);
      return { applied: true, seq: nextSeq, entries: updated, conflicts: [] };
    },
    { toJSON: (): ArtifactEntryBatchResult => ({ applied: true, seq: 19, entries: [defaultEntry], conflicts: [] }) },
  ),
  "artifact.submit": Object.assign(
    (p: { batchId: string; lastSeq: number }): BlockAck => ({ batchId: p.batchId, seq: p.lastSeq + 1, results: [], blocks: [] }),
    { toJSON: () => ({ batchId: "", seq: 0, results: [], blocks: [] }) },
  ),
  "artifact.suggestion.list": [],
  "artifact.create": Object.assign(
    (p: { title?: string; kind?: string; artifactType?: Artifact["artifactType"] }) => ({
      ...artifacts[3],
      id: id("art-new"),
      title: p?.title ?? "未命名",
      body: p?.kind === "html" ? ("html" as const) : p?.kind === "store" ? ("store" as const) : ("blocks" as const),
      ...(p?.artifactType ? { artifactType: p.artifactType } : {}),
      seq: 0,
    }),
    { toJSON: () => ({ ...artifacts[3], id: id("art-new"), title: "未命名", seq: 0 }) },
  ),
  "artifact.update": artifacts[0],
  "artifact.delete": null,
  "artifact.html.edit": artifacts[1],
  "artifact.outline.import": Object.assign(
    (p: { title?: string; filename?: string; markdown?: string }) => ({
      ...artifacts[3],
      id: id("art-outline-imported"),
      title: p?.title?.trim() || p?.filename?.replace(/\.(?:outline\.md|md|markdown)$/iu, "") || "导入的大纲",
      body: "blocks" as const,
      artifactType: "outline" as const,
      seq: 1,
    }),
    {
      toJSON: () => ({
        ...artifacts[3],
        id: id("art-outline-imported"),
        title: "导入的大纲",
        body: "blocks" as const,
        artifactType: "outline" as const,
        seq: 1,
      }),
    },
  ),
  "artifact.presence.update": null,
  "artifact.history.list": [],
  "artifact.history.preview": { artifactId: id("art-plan"), body: "blocks", frontiers: "f0", blocks: blocks["art-plan"] ?? [] },
  "artifact.history.restore": artifacts[0],
  "artifact.history.fork": { ...artifacts[0], id: id("art-forked"), title: "看板拖拽的方案（分支）" },
  "artifact.history.undoOrigin": artifacts[0],
  "artifact.history.compact": artifacts[0],
};
