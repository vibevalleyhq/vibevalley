// Directory-backed artifacts matching the finalized 12-type protocol (`packages/protocol/src/artifact`).
import type {
  Artifact,
  ArtifactContent,
  ArtifactFileContent,
  ArtifactFileDeleteRequest,
  ArtifactFileDeleteResult,
  ArtifactFileListResult,
  ArtifactFileMeta,
  ArtifactFileWriteRequest,
  ArtifactFileWriteResult,
  ArtifactHistoryPreviewResult,
  ArtifactId,
  ArtifactType,
  IssueId,
} from "@vibevalley/protocol";

const min = 60_000;
const now = Date.now();
const id = (s: string) => s as ArtifactId;

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

const artifacts: Artifact[] = [
  {
    id: id("art-plan"),
    title: "看板拖拽的方案",
    artifactType: "docs",
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
    artifactType: "prototype",
    isDefault: false,
    channel: "general",
    said: { channel: "general", number: 2 },
    issue: "i18" as IssueId,
    by: "w1",
    byName: "老周",
    version: 2,
    seq: 2,
    versions: [version(1, "第一版", "w1", "老周", now - 50 * min, 2), version(2, "多一条测试", "w1", "老周", now - 20 * min, 4)],
    at: now - 50 * min,
    updated: now - 20 * min,
  },
  {
    id: id("art-deck"),
    title: "本周进展",
    artifactType: "slides",
    isDefault: false,
    channel: "general",
    by: "orchestrator",
    byName: "助手",
    version: 1,
    seq: 1,
    versions: [version(1, "周会用", "orchestrator", "助手", now - 3 * 60 * min)],
    at: now - 3 * 60 * min,
    updated: now - 3 * 60 * min,
  },
  {
    id: id("art-mine"),
    title: "发版前要查的",
    artifactType: "outline",
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

function simpleHash(content: string): string {
  let h = 2166136261;
  for (let i = 0; i < content.length; i++) {
    h ^= content.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function makeFile(artifactId: ArtifactId, path: string, content: string, mime = "application/json"): ArtifactFileContent {
  return {
    artifactId,
    path,
    mime,
    encoding: "utf8",
    content,
    size: content.length,
    hash: simpleHash(content),
    updatedAt: now - 5 * min,
  };
}

function metaOf(file: ArtifactFileContent): ArtifactFileMeta {
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

const initialFilesByArtifact = (): Map<string, Map<string, ArtifactFileContent>> => {
  const map = new Map<string, Map<string, ArtifactFileContent>>();
  const put = (aid: ArtifactId, list: ArtifactFileContent[]) => {
    map.set(aid, new Map(list.map((f) => [f.path, f])));
  };

  put(id("art-plan"), [
    makeFile(
      id("art-plan"),
      "manifest.json",
      JSON.stringify({ id: "art-plan", artifactType: "docs", title: "看板拖拽的方案", entry: "structure/index.md", schemaVersion: 1 }, null, 2),
    ),
    makeFile(
      id("art-plan"),
      "structure/index.md",
      "## 目标\n\n卡片拖到别的列就改状态，拖到同列就排序；松手前看得到落点。\n\n## 做法\n\n- 按下时量好每列和每张卡的位置\n- 拖动时画一张影子卡，**不动原卡**\n- 松手时发 issue.status.update\n",
      "text/markdown",
    ),
  ]);

  put(id("art-login"), [
    makeFile(
      id("art-login"),
      "manifest.json",
      JSON.stringify({ id: "art-login", artifactType: "prototype", title: "登录流程", entry: "structure/index.html", schemaVersion: 1 }, null, 2),
    ),
    makeFile(id("art-login"), "structure/index.html", page2, "text/html"),
    makeFile(id("art-login"), "structure/styles.css", ":root { --surface: #fcfcfb; --ink: #1c1917; }\n", "text/css"),
    makeFile(id("art-login"), "structure/app.js", "export const ready = true;\n", "application/javascript"),
  ]);

  put(id("art-deck"), [
    makeFile(
      id("art-deck"),
      "manifest.json",
      JSON.stringify({ id: "art-deck", artifactType: "slides", title: "本周进展", entry: "structure/deck.json", schemaVersion: 1 }, null, 2),
    ),
    makeFile(
      id("art-deck"),
      "structure/deck.json",
      JSON.stringify(
        {
          title: "本周进展",
          aspectRatio: "16:9",
          slides: [
            { id: "s01-cover", file: "structure/slides/s01-cover.json", title: "本周进展" },
            { id: "s02-done", file: "structure/slides/s02-done.json", title: "做完的" },
          ],
        },
        null,
        2,
      ),
    ),
    makeFile(
      id("art-deck"),
      "structure/slides/s01-cover.json",
      JSON.stringify({ id: "s01-cover", layout: "cover", title: "本周进展", subtitle: "田头周会", blocks: [], notes: "先说结论：看板能拖了。" }, null, 2),
    ),
    makeFile(
      id("art-deck"),
      "structure/slides/s02-done.json",
      JSON.stringify(
        {
          id: "s02-done",
          layout: "content",
          title: "做完的",
          subtitle: "",
          blocks: [{ text: "看板拖拽" }, { text: "登录过期回跳" }],
          notes: "拖拽的手感还要再调。",
        },
        null,
        2,
      ),
    ),
  ]);

  put(id("art-mine"), [
    makeFile(
      id("art-mine"),
      "manifest.json",
      JSON.stringify({ id: "art-mine", artifactType: "outline", title: "发版前要查的", entry: "structure/outline.json", schemaVersion: 1 }, null, 2),
    ),
    makeFile(
      id("art-mine"),
      "structure/outline.json",
      JSON.stringify(
        {
          version: 1,
          rootIds: ["n_1"],
          nodes: {
            n_1: { id: "n_1", text: "发版前", kind: "heading", children: ["n_2", "n_3"] },
            n_2: { id: "n_2", text: "跑一遍全部测试", kind: "todo", checked: false, children: [] },
            n_3: { id: "n_3", text: "看一眼深色主题", kind: "todo", checked: false, children: [] },
          },
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
      JSON.stringify({ id: "art-launch-board", artifactType: "whiteboard", title: "产品发布时间线", entry: "structure/board.json", schemaVersion: 1 }, null, 2),
    ),
    makeFile(id("art-launch-board"), "structure/board.json", JSON.stringify(initialBoardDoc, null, 2)),
  ]);

  return map;
};

const filesByArtifact = initialFilesByArtifact();
const seqByArtifact = new Map<string, number>(artifacts.map((a) => [a.id, a.seq]));
const versionContents: Record<string, Record<number, string>> = { "art-login": { 1: page1, 2: page2 } };

const one = (p: unknown) => artifacts.find((a) => a.id === (p as { id: string }).id);
const missing = { bizCode: 100004, message: "artifact not found" };

const listFilesFor = (req: { id: string; prefix?: string }): ArtifactFileListResult | typeof missing => {
  const a = one(req);
  if (!a) return missing;
  const map = filesByArtifact.get(a.id) ?? new Map<string, ArtifactFileContent>();
  const prefix = req.prefix;
  const files = [...map.values()].filter((f) => (prefix ? f.path.startsWith(prefix) : true)).map(metaOf);
  const seq = seqByArtifact.get(a.id) ?? a.seq;
  return { artifactId: a.id, seq, files };
};

const defaultFile: ArtifactFileContent =
  filesByArtifact.get("art-plan")?.get("structure/index.md") ?? makeFile(id("art-plan"), "structure/index.md", "# Plan\n", "text/markdown");

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
      if (!a) return missing;
      const v = p.version ?? a.version;
      const versioned = versionContents[p.id]?.[v];
      if (versioned !== undefined) return { version: v, content: versioned };
      const map = filesByArtifact.get(a.id);
      const first = map ? [...map.values()].find((f) => f.path.startsWith("structure/")) : undefined;
      return first ? { version: v, content: first.content } : missing;
    },
    { toJSON: (): ArtifactContent => ({ version: 2, content: page2 }) },
  ),
  "artifact.file.list": Object.assign((p: { id: string; prefix?: string }): ArtifactFileListResult | typeof missing => listFilesFor(p), {
    toJSON: (): ArtifactFileListResult => listFilesFor({ id: "art-launch-board" }) as ArtifactFileListResult,
  }),
  "artifact.file.get": Object.assign(
    (p: { id: string; path: string; version?: number }): ArtifactFileContent | typeof missing => {
      const a = one(p);
      if (!a) return missing;
      const versioned =
        p.version !== undefined && p.id === "art-login" && p.path === "structure/index.html" ? versionContents["art-login"]?.[p.version] : undefined;
      if (versioned !== undefined) {
        return makeFile(a.id, p.path, versioned, "text/html");
      }
      return filesByArtifact.get(a.id)?.get(p.path) ?? missing;
    },
    { toJSON: (): ArtifactFileContent => defaultFile },
  ),
  "artifact.file.write": Object.assign(
    (p: ArtifactFileWriteRequest): ArtifactFileWriteResult | typeof missing => {
      const a = one(p);
      if (!a) return missing;
      let map = filesByArtifact.get(a.id);
      if (!map) {
        map = new Map();
        filesByArtifact.set(a.id, map);
      }
      const written: ArtifactFileMeta[] = [];
      for (const item of p.files) {
        const mime = item.mime ?? (item.path.endsWith(".md") ? "text/markdown" : item.path.endsWith(".html") ? "text/html" : "application/json");
        const file = makeFile(a.id, item.path, item.content, mime);
        map.set(item.path, file);
        written.push(metaOf(file));
      }
      const nextSeq = (seqByArtifact.get(a.id) ?? a.seq) + 1;
      seqByArtifact.set(a.id, nextSeq);
      return { artifactId: a.id, seq: nextSeq, files: written };
    },
    { toJSON: (): ArtifactFileWriteResult => ({ artifactId: id("art-plan"), seq: 5, files: [metaOf(defaultFile)] }) },
  ),
  "artifact.file.delete": Object.assign(
    (p: ArtifactFileDeleteRequest): ArtifactFileDeleteResult | typeof missing => {
      const a = one(p);
      if (!a) return missing;
      filesByArtifact.get(a.id)?.delete(p.path);
      const nextSeq = (seqByArtifact.get(a.id) ?? a.seq) + 1;
      seqByArtifact.set(a.id, nextSeq);
      return { artifactId: a.id, seq: nextSeq, path: p.path };
    },
    { toJSON: (): ArtifactFileDeleteResult => ({ artifactId: id("art-plan"), seq: 6, path: "structure/extra.md" }) },
  ),
  "artifact.suggestion.list": [],
  "artifact.create": Object.assign(
    (p: { title?: string; artifactType?: ArtifactType }) => ({
      ...artifacts[3],
      id: id("art-new"),
      title: p?.title ?? "未命名",
      artifactType: p?.artifactType ?? "docs",
      seq: 0,
    }),
    { toJSON: () => ({ ...artifacts[3], id: id("art-new"), title: "未命名", artifactType: "docs" as const, seq: 0 }) },
  ),
  "artifact.version.create": Object.assign(
    (p: { id: string; note?: string }) => {
      const a = one(p) ?? artifacts[0];
      const nextVer = a.version + 1;
      return {
        ...a,
        version: nextVer,
        versions: [...a.versions, version(nextVer, p.note ?? "", "user", "用户", Date.now())],
      };
    },
    { toJSON: () => ({ ...artifacts[0], version: 1 }) },
  ),
  "artifact.update": artifacts[0],
  "artifact.delete": null,
  "artifact.presence.update": null,
  "artifact.history.list": [],
  "artifact.history.preview": {
    artifactId: id("art-plan"),
    artifactType: "docs",
    frontiers: "f0",
    files: [defaultFile],
  } satisfies ArtifactHistoryPreviewResult,
  "artifact.history.restore": artifacts[0],
  "artifact.history.fork": { ...artifacts[0], id: id("art-forked"), title: "看板拖拽的方案（分支）" },
  "artifact.history.undoOrigin": artifacts[0],
  "artifact.history.compact": artifacts[0],
};
