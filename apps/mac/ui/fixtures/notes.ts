// Directory-backed notes matching the 3+1 protocol (`packages/protocol/src/note`).
import type {
  BaseRunAgentColumnResult,
  BaseUpsertRowRequest,
  BaseViewSnapshot,
  DocBlock,
  DocView,
  IssueId,
  Note,
  NoteContent,
  NoteDocAppendBlockRequest,
  NoteFileContent,
  NoteFileDeleteRequest,
  NoteFileDeleteResult,
  NoteFileListResult,
  NoteFileMeta,
  NoteFileWriteRequest,
  NoteFileWriteResult,
  NoteHistoryPreviewResult,
  NoteId,
  NoteLinkListResult,
  NoteTreeMoveRequest,
  NoteType,
} from "@vibevalley/protocol";

const min = 60_000;
const now = Date.now();
const id = (s: string) => s as NoteId;

const page1 = String.raw`<!doctype html>
<html><head><meta charset="utf-8"><title>登录流程</title>
<style>body{font:16px/1.6 system-ui;margin:0;padding:32px 40px;background:#fcfcfb;color:#1c1917}h1{margin:0 0 12px}ol{padding-left:1.2em}.box{border:1px solid #e5e5e5;border-radius:8px;padding:12px 16px;margin-top:16px}</style>
</head><body>
<h1>登录流程</h1>
<p>登录过期时，回到登录页并记住要去的地方。</p>
<ol><li>打开任一页</li><li>会话过期：跳到 /login?next=…</li><li>登录后回到原页</li></ol>
<div class="box">两条测试：过期跳转、登录后回跳。</div>
</body></html>`;

const page2 = page1.replace("两条测试：过期跳转、登录后回跳。", "三条测试：过期跳转、登录后回跳、next 只收站内地址。");

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

const baseColumns = [
  { id: "c_title", name: "任务", kind: "text" as const, width: 240 },
  {
    id: "c_status",
    name: "状态",
    kind: "select" as const,
    width: 140,
    options: [
      { value: "todo", label: "待办", color: "stone" },
      { value: "doing", label: "进行中", color: "amber" },
      { value: "done", label: "完成", color: "green" },
    ],
  },
];

const initialBaseRows = [
  {
    id: "r1",
    cells: { c_title: { _tag: "text" as const, value: "跑一遍全部测试" }, c_status: { _tag: "text" as const, value: "doing" } },
    createdAt: now - 26 * 60 * min,
    updatedAt: now - 25 * 60 * min,
  },
  {
    id: "r2",
    cells: { c_title: { _tag: "text" as const, value: "看一眼深色主题" }, c_status: { _tag: "text" as const, value: "todo" } },
    createdAt: now - 26 * 60 * min,
    updatedAt: now - 25 * 60 * min,
  },
];

const notes: Note[] = [
  {
    id: id("art-plan"),
    title: "看板拖拽的方案",
    noteType: "doc",
    sortOrder: 1,
    channel: "general",
    said: { channel: "general", number: 3 },
    issue: "i22" as IssueId,
    by: "w1",
    byName: "老周",
    version: 0,
    seq: 4,
    versions: [],
    preview: {
      _tag: "doc",
      heading: "目标",
      excerpt: "卡片拖到别的列就改状态，拖到同列就排序；松手前看得到落点。",
      blockCount: 4,
      slideCount: 1,
      outline: [{ depth: 0, text: "目标", kind: "heading" }],
    },
    at: now - 90 * min,
    updated: now - 6 * min,
  },
  {
    id: id("art-login"),
    title: "登录流程",
    noteType: "doc",
    parentId: id("art-plan"),
    sortOrder: 1,
    channel: "general",
    said: { channel: "general", number: 2 },
    issue: "i18" as IssueId,
    by: "w1",
    byName: "老周",
    version: 2,
    seq: 2,
    versions: [version(1, "第一版", "w1", "老周", now - 50 * min, 2), version(2, "多一条测试", "w1", "老周", now - 20 * min, 4)],
    preview: {
      _tag: "doc",
      heading: "登录流程",
      excerpt: "登录过期时，回到登录页并记住要去的地方。",
      blockCount: 2,
      slideCount: 1,
      outline: [{ depth: 0, text: "登录流程", kind: "heading" }],
    },
    at: now - 50 * min,
    updated: now - 20 * min,
  },
  {
    id: id("art-deck"),
    title: "本周进展",
    noteType: "doc",
    sortOrder: 2,
    channel: "general",
    by: "orchestrator",
    byName: "助手",
    version: 1,
    seq: 1,
    versions: [version(1, "周会用", "orchestrator", "助手", now - 3 * 60 * min)],
    preview: {
      _tag: "doc",
      heading: "本周进展",
      excerpt: "田头周会",
      blockCount: 5,
      slideCount: 2,
      outline: [
        { depth: 0, text: "本周进展", kind: "heading" },
        { depth: 0, text: "做完的", kind: "heading" },
      ],
    },
    at: now - 3 * 60 * min,
    updated: now - 3 * 60 * min,
  },
  {
    id: id("art-mine"),
    title: "发版前要查的",
    noteType: "base",
    sortOrder: 3,
    by: "user",
    byName: "用户",
    version: 0,
    seq: 1,
    versions: [],
    preview: {
      _tag: "base",
      sheetName: "发版前要查的",
      columns: ["任务", "状态"],
      rows: [
        ["跑一遍全部测试", "doing"],
        ["看一眼深色主题", "todo"],
      ],
      totalRows: 2,
      totalCols: 2,
    },
    at: now - 26 * 60 * min,
    updated: now - 25 * 60 * min,
  },
  {
    id: id("art-launch-board"),
    title: "产品发布时间线",
    noteType: "canvas",
    sortOrder: 4,
    channel: "general",
    said: { channel: "general", number: 5 },
    issue: "i22" as IssueId,
    by: "orchestrator",
    byName: "助手",
    version: 0,
    seq: 18,
    versions: [],
    preview: {
      _tag: "canvas",
      shapes: [
        { x: 0.08, y: 0.2, w: 0.26, h: 0.24, kind: "card", label: "锁定核心范围" },
        { x: 0.42, y: 0.16, w: 0.28, h: 0.24, kind: "card", label: "确定资源预算" },
        { x: 0.18, y: 0.62, w: 0.28, h: 0.24, kind: "card", label: "确认发布清单" },
      ],
      nodeCount: 5,
    },
    at: now - 40 * min,
    updated: now - 2 * min,
  },
  {
    id: id("art-reel"),
    title: "灵动岛交互演示",
    noteType: "media",
    sortOrder: 5,
    issue: "i23" as IssueId,
    by: "orchestrator",
    byName: "助手",
    version: 0,
    seq: 1,
    versions: [],
    preview: {
      _tag: "media",
      mediaKind: "video",
      caption: "灵动岛展开、收起与通知提示演示",
      durationSec: 9,
    },
    at: now - 15 * min,
    updated: now - 10 * min,
  },
];

function simpleHash(content: string): string {
  let h = 2166136261;
  for (let i = 0; i < content.length; i++) {
    h ^= content.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function makeFile(noteIdValue: NoteId, path: string, content: string, mime = "application/json"): NoteFileContent {
  return {
    noteId: noteIdValue,
    path,
    mime,
    encoding: "utf8",
    content,
    size: content.length,
    hash: simpleHash(content),
    updatedAt: now - 5 * min,
  };
}

function metaOf(file: NoteFileContent): NoteFileMeta {
  return { path: file.path, mime: file.mime, size: file.size, hash: file.hash, updatedAt: file.updatedAt };
}

const initialBoardDoc = {
  version: 1,
  grid: "architectural",
  viewport: { x: 0, y: 0, zoom: 1 },
  elements: {
    "t-title": { id: "t-title", type: "text", variant: "title", x: 72, y: 36, w: 680, h: 48, label: "产品发布时间线" },
    "t-sub": {
      id: "t-sub",
      type: "text",
      variant: "subtitle",
      x: 72,
      y: 84,
      w: 680,
      h: 28,
      label: "从方案锁定到正式交付上线：全链路协同冲刺 12 天",
      highlight: "12 天",
    },
    "c-1": { id: "c-1", type: "shape", shape: "card", x: 64, y: 174, w: 160, h: 108, title: "锁定核心范围", body: "核心功能已拍板", fill: "sun" },
    "c-2": { id: "c-2", type: "shape", shape: "card", x: 112, y: 422, w: 168, h: 120, title: "确认发布清单", body: "拆解到每天交付物", fill: "sun" },
    "c-3": { id: "c-3", type: "shape", shape: "card", x: 246, y: 146, w: 168, h: 110, title: "确定资源预算", body: "算力与配额已就位", fill: "sun" },
    "a-1": { id: "a-1", type: "arrow", curve: "smooth", head: "arrow", from: { id: "c-1", side: "e" }, to: { id: "c-3", side: "w" } },
  },
};

const planDocBlocks: DocBlock[] = [
  { id: "b1", type: "heading", level: 2, text: "目标" },
  { id: "b2", type: "prose", text: "卡片拖到别的列就改状态，拖到同列就排序；松手前看得到落点。" },
  { id: "b3", type: "heading", level: 2, text: "做法" },
  {
    id: "b4",
    type: "list",
    ordered: false,
    items: ["按下时量好每列和每张卡的位置", "拖动时画一张影子卡，不动原卡", "松手时发 issue.status.update"],
  },
];

const loginDocBlocks: DocBlock[] = [
  { id: "b1", type: "heading", level: 1, text: "登录流程" },
  { id: "b2", type: "preview", entry: "structure/index.html", height: 420, title: "登录流程" },
];

const deckDocBlocks: DocBlock[] = [
  { id: "s1_h", type: "heading", level: 1, text: "本周进展" },
  { id: "s1_p", type: "prose", text: "田头周会" },
  { id: "pb_1", type: "pageBreak", title: "做完的", speakerNotes: "拖拽的手感还要再调。" },
  { id: "s2_h", type: "heading", level: 2, text: "做完的" },
  { id: "s2_l", type: "list", ordered: false, items: ["看板拖拽", "登录过期回跳"] },
];

const initialFilesByNote = (): Map<string, Map<string, NoteFileContent>> => {
  const map = new Map<string, Map<string, NoteFileContent>>();
  const put = (nid: NoteId, list: NoteFileContent[]) => {
    map.set(nid, new Map(list.map((f) => [f.path, f])));
  };

  put(id("art-plan"), [
    makeFile(
      id("art-plan"),
      "manifest.json",
      JSON.stringify({ id: "art-plan", noteType: "doc", title: "看板拖拽的方案", entry: "structure/doc.json", schemaVersion: 1 }, null, 2),
    ),
    makeFile(id("art-plan"), "structure/doc.json", JSON.stringify({ version: 1, blocks: planDocBlocks }, null, 2)),
  ]);

  put(id("art-login"), [
    makeFile(
      id("art-login"),
      "manifest.json",
      JSON.stringify({ id: "art-login", noteType: "doc", title: "登录流程", entry: "structure/doc.json", schemaVersion: 1 }, null, 2),
    ),
    makeFile(id("art-login"), "structure/doc.json", JSON.stringify({ version: 1, blocks: loginDocBlocks }, null, 2)),
    makeFile(id("art-login"), "structure/index.html", page2, "text/html"),
    makeFile(id("art-login"), "structure/styles.css", ":root { --surface: #fcfcfb; --ink: #1c1917; }\n", "text/css"),
    makeFile(id("art-login"), "structure/app.js", "export const ready = true;\n", "application/javascript"),
  ]);

  put(id("art-deck"), [
    makeFile(
      id("art-deck"),
      "manifest.json",
      JSON.stringify({ id: "art-deck", noteType: "doc", title: "本周进展", entry: "structure/doc.json", schemaVersion: 1 }, null, 2),
    ),
    makeFile(id("art-deck"), "structure/doc.json", JSON.stringify({ version: 1, blocks: deckDocBlocks }, null, 2)),
  ]);

  put(id("art-mine"), [
    makeFile(
      id("art-mine"),
      "manifest.json",
      JSON.stringify({ id: "art-mine", noteType: "base", title: "发版前要查的", entry: "structure/base.json", schemaVersion: 1 }, null, 2),
    ),
    makeFile(
      id("art-mine"),
      "structure/base.json",
      JSON.stringify(
        {
          version: 1,
          sheets: [
            {
              id: "sheet1",
              name: "发版前要查的",
              columns: baseColumns,
              rows: initialBaseRows,
              views: [
                { id: "v_table", name: "Table", kind: "table" },
                { id: "v_board", name: "Board", kind: "board", groupBy: "c_status" },
              ],
            },
          ],
        },
        null,
        2,
      ),
    ),
  ]);

  put(id("art-launch-board"), [
    makeFile(
      id("art-launch-board"),
      "manifest.json",
      JSON.stringify({ id: "art-launch-board", noteType: "canvas", title: "产品发布时间线", entry: "structure/board.json", schemaVersion: 1 }, null, 2),
    ),
    makeFile(id("art-launch-board"), "structure/board.json", JSON.stringify(initialBoardDoc, null, 2)),
  ]);

  put(id("art-reel"), [
    makeFile(
      id("art-reel"),
      "manifest.json",
      JSON.stringify({ id: "art-reel", noteType: "media", title: "灵动岛交互演示", entry: "structure/media.json", schemaVersion: 1 }, null, 2),
    ),
    makeFile(
      id("art-reel"),
      "structure/media.json",
      JSON.stringify(
        { version: 1, title: "灵动岛交互演示", mediaKind: "video", caption: "灵动岛展开、收起与通知提示演示", durationSec: 9, posterAsset: null, items: [] },
        null,
        2,
      ),
    ),
  ]);

  return map;
};

const filesByNote = initialFilesByNote();
const seqByNote = new Map<string, number>(notes.map((n) => [n.id, n.seq]));
const versionContents: Record<string, Record<number, string>> = { "art-login": { 1: page1, 2: page2 } };

const one = (p: unknown) => notes.find((n) => n.id === (p as { id: string }).id);
const missing = { bizCode: 100004, message: "note not found" };

const listFilesFor = (req: { id: string; prefix?: string }): NoteFileListResult | typeof missing => {
  const n = one(req);
  if (!n) return missing;
  const map = filesByNote.get(n.id) ?? new Map<string, NoteFileContent>();
  const prefix = req.prefix;
  const files = [...map.values()].filter((f) => (prefix ? f.path.startsWith(prefix) : true)).map(metaOf);
  const seq = seqByNote.get(n.id) ?? n.seq;
  return { noteId: n.id, seq, files };
};

const docViewFor = (n: Note): DocView => {
  const raw = filesByNote.get(n.id)?.get("structure/doc.json")?.content;
  let blocks: DocBlock[] = [];
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as { blocks?: DocBlock[] };
      if (Array.isArray(parsed.blocks)) blocks = parsed.blocks;
    } catch {
      blocks = [];
    }
  }
  const slideCount = 1 + blocks.filter((b) => b.type === "pageBreak").length;
  return {
    noteId: n.id,
    title: n.title,
    blocks,
    slideCount,
    wordCount: 42,
    extractedLinks: [],
  };
};

const baseSnapFor = (n: Note, sheetId?: string, viewId?: string): BaseViewSnapshot => ({
  noteId: n.id,
  sheets: [{ id: "sheet1", name: "发版前要查的", rowCount: initialBaseRows.length }],
  activeSheetId: sheetId ?? "sheet1",
  activeViewId: viewId ?? "v_table",
  activeViewKind: viewId === "v_board" ? "board" : "table",
  columns: baseColumns,
  rows: initialBaseRows,
  groups: [],
  summaries: [],
  totalRows: initialBaseRows.length,
});

const defaultFile: NoteFileContent =
  filesByNote.get("art-plan")?.get("structure/doc.json") ??
  makeFile(id("art-plan"), "structure/doc.json", JSON.stringify({ version: 1, blocks: planDocBlocks }, null, 2));

/** `{ op: data }`, a function of the call's payload where the answer depends on it. */
export const responses: Record<string, unknown> = {
  "note.list": Object.assign(
    (p: { issue?: string; channel?: string; noteType?: string; parentId?: string }) =>
      notes.filter(
        (n) =>
          (p?.issue === undefined || n.issue === p.issue) &&
          (p?.channel === undefined || n.channel === p.channel) &&
          (p?.noteType === undefined || n.noteType === p.noteType) &&
          (p?.parentId === undefined || n.parentId === p.parentId),
      ),
    { toJSON: () => notes },
  ),
  "note.get": Object.assign((p: unknown) => one(p) ?? missing, { toJSON: () => notes[0] }),
  "note.content.get": Object.assign(
    (p: { id: string; version?: number }): NoteContent | typeof missing => {
      const n = one(p);
      if (!n) return missing;
      const v = p.version ?? n.version;
      const versioned = versionContents[p.id]?.[v];
      if (versioned !== undefined) return { version: v, content: versioned };
      const map = filesByNote.get(n.id);
      const first = map ? [...map.values()].find((f) => f.path.startsWith("structure/")) : undefined;
      return first ? { version: v, content: first.content } : missing;
    },
    { toJSON: (): NoteContent => ({ version: 2, content: page2 }) },
  ),
  "note.doc.view": Object.assign(
    (p: { id: string }): DocView | typeof missing => {
      const n = one(p);
      return n ? docViewFor(n) : missing;
    },
    { toJSON: (): DocView => docViewFor(notes[0]) },
  ),
  "note.doc.appendBlock": Object.assign(
    (p: NoteDocAppendBlockRequest): DocView | typeof missing => {
      const n = one(p);
      if (!n) return missing;
      const cur = docViewFor(n);
      const blocks = [...cur.blocks, p.block];
      const map = filesByNote.get(n.id);
      if (map) map.set("structure/doc.json", makeFile(n.id, "structure/doc.json", JSON.stringify({ version: 1, blocks }, null, 2)));
      return { ...cur, blocks };
    },
    { toJSON: (): DocView => docViewFor(notes[0]) },
  ),
  "note.base.view": Object.assign(
    (p: { id: string; sheetId?: string; viewId?: string }): BaseViewSnapshot | typeof missing => {
      const n = one(p);
      return n ? baseSnapFor(n, p.sheetId, p.viewId) : missing;
    },
    { toJSON: (): BaseViewSnapshot => baseSnapFor(notes[3]) },
  ),
  "note.base.upsertRow": Object.assign(
    (p: BaseUpsertRowRequest): BaseViewSnapshot | typeof missing => {
      const n = one(p);
      return n ? baseSnapFor(n, p.sheetId) : missing;
    },
    { toJSON: (): BaseViewSnapshot => baseSnapFor(notes[3]) },
  ),
  "note.base.runAgentColumn": Object.assign(
    (p: { id: string; sheetId?: string; columnId: string }): BaseRunAgentColumnResult => ({
      noteId: id(p.id),
      sheetId: p.sheetId ?? "sheet1",
      columnId: p.columnId,
      executed: 1,
      updatedRowIds: ["r1"],
      spawnedIssueIds: [],
    }),
    {
      toJSON: (): BaseRunAgentColumnResult => ({
        noteId: id("art-mine"),
        sheetId: "sheet1",
        columnId: "c_status",
        executed: 1,
        updatedRowIds: ["r1"],
        spawnedIssueIds: [],
      }),
    },
  ),
  "note.tree.move": Object.assign(
    (p: NoteTreeMoveRequest): Note | typeof missing => {
      const n = one(p);
      if (!n) return missing;
      return {
        ...n,
        ...(p.parentId ? { parentId: p.parentId } : { parentId: undefined }),
        ...(p.sortOrder !== undefined ? { sortOrder: p.sortOrder } : {}),
      };
    },
    { toJSON: (): Note => notes[1] },
  ),
  "note.link.list": Object.assign((): NoteLinkListResult => ({ outgoing: [], backlinks: [] }), {
    toJSON: (): NoteLinkListResult => ({ outgoing: [], backlinks: [] }),
  }),
  "note.file.list": Object.assign((p: { id: string; prefix?: string }): NoteFileListResult | typeof missing => listFilesFor(p), {
    toJSON: (): NoteFileListResult => listFilesFor({ id: "art-launch-board" }) as NoteFileListResult,
  }),
  "note.file.get": Object.assign(
    (p: { id: string; path: string; version?: number }): NoteFileContent | typeof missing => {
      const n = one(p);
      if (!n) return missing;
      const versioned =
        p.version !== undefined && p.id === "art-login" && p.path === "structure/index.html" ? versionContents["art-login"]?.[p.version] : undefined;
      if (versioned !== undefined) return makeFile(n.id, p.path, versioned, "text/html");
      return filesByNote.get(n.id)?.get(p.path) ?? missing;
    },
    { toJSON: (): NoteFileContent => defaultFile },
  ),
  "note.file.write": Object.assign(
    (p: NoteFileWriteRequest): NoteFileWriteResult | typeof missing => {
      const n = one(p);
      if (!n) return missing;
      let map = filesByNote.get(n.id);
      if (!map) {
        map = new Map();
        filesByNote.set(n.id, map);
      }
      const written: NoteFileMeta[] = [];
      for (const item of p.files) {
        const mime = item.mime ?? (item.path.endsWith(".md") ? "text/markdown" : item.path.endsWith(".html") ? "text/html" : "application/json");
        const file = makeFile(n.id, item.path, item.content, mime);
        map.set(item.path, file);
        written.push(metaOf(file));
      }
      const nextSeq = (seqByNote.get(n.id) ?? n.seq) + 1;
      seqByNote.set(n.id, nextSeq);
      return { noteId: n.id, seq: nextSeq, files: written };
    },
    { toJSON: (): NoteFileWriteResult => ({ noteId: id("art-plan"), seq: 5, files: [metaOf(defaultFile)] }) },
  ),
  "note.file.delete": Object.assign(
    (p: NoteFileDeleteRequest): NoteFileDeleteResult | typeof missing => {
      const n = one(p);
      if (!n) return missing;
      filesByNote.get(n.id)?.delete(p.path);
      const nextSeq = (seqByNote.get(n.id) ?? n.seq) + 1;
      seqByNote.set(n.id, nextSeq);
      return { noteId: n.id, seq: nextSeq, path: p.path };
    },
    { toJSON: (): NoteFileDeleteResult => ({ noteId: id("art-plan"), seq: 6, path: "structure/extra.md" }) },
  ),
  "note.suggestion.list": [],
  "note.create": Object.assign(
    (p: { title?: string; noteType?: NoteType; parentId?: NoteId }) => ({
      ...notes[3],
      id: id("art-new"),
      title: p?.title ?? "未命名",
      noteType: p?.noteType ?? "doc",
      ...(p?.parentId !== undefined ? { parentId: p.parentId } : {}),
      seq: 0,
    }),
    { toJSON: () => ({ ...notes[3], id: id("art-new"), title: "未命名", noteType: "doc" as const, seq: 0 }) },
  ),
  "note.version.create": Object.assign(
    (p: { id: string; note?: string }) => {
      const n = one(p) ?? notes[0];
      const nextVer = n.version + 1;
      return {
        ...n,
        version: nextVer,
        versions: [...n.versions, version(nextVer, p.note ?? "", "user", "用户", Date.now())],
      };
    },
    { toJSON: () => ({ ...notes[0], version: 1 }) },
  ),
  "note.update": notes[0],
  "note.delete": null,
  "note.cover.set": Object.assign(
    (p: { id: string; seq: number; mime: string; width?: number; height?: number }) => ({
      path: `/tmp/${p.id}-cover-${p.seq}.png`,
      url: `/api/v1/note/${p.id}/cover?seq=${p.seq}`,
      mime: p.mime,
      seq: p.seq,
      ...(p.width !== undefined ? { width: p.width } : {}),
      ...(p.height !== undefined ? { height: p.height } : {}),
      updatedAt: Date.now(),
    }),
    {
      toJSON: () => ({
        path: "/tmp/art-login-cover-2.png",
        url: "/api/v1/note/art-login/cover?seq=2",
        mime: "image/png",
        seq: 2,
        width: 640,
        height: 400,
        updatedAt: now,
      }),
    },
  ),
  "note.presence.update": null,
  "note.history.list": [],
  "note.history.preview": {
    noteId: id("art-plan"),
    noteType: "doc",
    frontiers: "f0",
    files: [defaultFile],
  } satisfies NoteHistoryPreviewResult,
  "note.history.restore": notes[0],
  "note.history.fork": { ...notes[0], id: id("art-forked"), title: "看板拖拽的方案（分支）" },
  "note.history.undoOrigin": notes[0],
  "note.history.compact": notes[0],
};
