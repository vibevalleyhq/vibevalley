import { dayKey } from "@vibevalley/pkm/days";
import { applied } from "@vibevalley/pkm/editing";
// The notes (pkm) as a small vault served in memory: fakeHost and the story
// transport call a response that is a function with the call's payload, so
// pages open by slug, blocks apply (VibeValley's own `applied`), journals
// open by day. JSON (the app's fake server) gets each answer's `toJSON`:
// the vault, the project page and the radar.
import type { PkmBlock, PkmBlockOp, PkmComment, PkmPage, PkmPageSummary, PkmPageView, PkmSearchHit, PkmTier } from "@vibevalley/protocol";

const day = 86_400_000;
const now = Date.now();
const today = dayKey(now);
const ago = (n: number) => dayKey(now - n * day);

type Row = [depth: number, body: string, extra?: Partial<PkmBlock>];

let ids = 0;
function blocksOf(slug: string, rows: readonly Row[]): PkmBlock[] {
  const stack: PkmBlock[] = [];
  return rows.map(([depth, body, extra]) => {
    stack.length = depth;
    const parent = stack.at(depth - 1);
    const block: PkmBlock = {
      id: extra?.id ?? `${slug}-${++ids}`,
      depth,
      body,
      props: {},
      path: stack.map((b) => b.body.split("\n")[0] ?? "").join(" › "),
      ...(depth > 0 && parent ? { parent: parent.id } : {}),
      ...extra,
    };
    stack[depth] = block;
    return block;
  });
}

interface Stored {
  page: PkmPage;
  day?: string;
}

const pages = new Map<string, Stored>();
/** A block id as the files write them (refs match hex ids only). */
const goal = "6f1d2c3a-90ab";

function put(title: string, tier: PkmTier, rows: readonly Row[], more: { props?: Record<string, string>; tldr?: string; day?: string; slug?: string } = {}) {
  const slug = more.slug ?? title.toLowerCase().replace(/\s+/gu, "-");
  const folder = tier === "journal" ? "journals" : `${tier}s`;
  pages.set(slug, {
    page: {
      slug,
      title,
      tier,
      file: `${folder}/${slug}.md`,
      props: more.props ?? {},
      tldr: more.tldr ?? "",
      blocks: blocksOf(slug, rows),
      updated: now - pages.size * 3_600_000,
    },
    ...(more.day ? { day: more.day } : {}),
  });
}

put(
  "VibeValley 原生移植",
  "project",
  [
    [0, "## 目标"],
    [1, "VibeValley 整个搬进 VibeValley，页面用 nsh 画，服务端换成 Rust", { id: goal }],
    [1, "终端是 VibeValley 加的：每个工作树都能开一个"],
    [0, "## 这周"],
    [1, "笔记页的大纲编辑器", { marker: "DOING" }],
    [2, "Tab 缩进、Alt+↑↓ 挪动、Enter 拆块"],
    [2, "[[[[", { marker: "TODO" }],
    [1, "素材库和 Artifact 页", { marker: "TODO", props: { deadline: ago(-3) } }],
    [1, "图鉴的音效，离线合成成 WAV", { marker: "DONE" }],
    [1, "拖文件进聊天", { marker: "WAITING" }],
    [0, "## 记下的"],
    [1, "nsh 的 Text 不从 View 继承字号，每个字都要自己的 class"],
    [1, "像素图按点放大，不要平滑 #nsh"],
    [1, `目标写在 ((${goal})) 里`],
  ].map(([d, b, e]) => [d, b === "[[[[" ? "[[健康]] 这一块先不动" : b, e] as Row),
  {
    props: { status: "active", deadline: ago(-12), area: "[[工作]]", tags: "vibevalley, nsh", owner: "lucas", started: ago(20) },
    tldr: "把 VibeValley 的每一页搬到 nsh 上，看起来和原来一样。",
  },
);
put("健康", "area", [
  [0, "每天走八千步", { marker: "LATER" }],
  [0, "体检约在月底"],
]);
put("工作", "area", [[0, "VibeValley 和 VibeValley 的事都在这里"]]);
put("Rust 笔记", "resource", [
  [0, 'serde 的 `rename_all = "camelCase"` 对上协议的字段名'],
  [0, "flume 的接收端每次 state() 都给一个新的"],
]);
put("想到的", "inbox", [
  [0, "图鉴里加一个调色板", { marker: "LATER" }],
  [0, "日历能不能拖着选一周"],
]);
put("旧的网页壳", "archive", [[0, "Electron 那一套不再用了"]]);
put(
  today.replace(/-/gu, "_"),
  "journal",
  [
    [0, "早上看了 [[VibeValley 原生移植]] 的进度"],
    [0, "下午", { marker: undefined }],
    [1, "大纲的选中和复制", { marker: "TODO" }],
    [1, "日历", { marker: "DONE" }],
  ],
  { day: today, slug: `journal-${today}` },
);
put(
  ago(1).replace(/-/gu, "_"),
  "journal",
  [
    [0, "图鉴的音效接上了 #vibevalley"],
    [0, "和 [[健康]] 有关：晚上跑了五公里"],
  ],
  { day: ago(1), slug: `journal-${ago(1)}` },
);
put(ago(3).replace(/-/gu, "_"), "journal", [[0, "读了一遍 VibeValley 的 pkm 包"]], { day: ago(3), slug: `journal-${ago(3)}` });

const comments: PkmComment[] = [
  {
    id: "c1",
    page: "vibevalley-原生移植",
    block: goal,
    span: "页面用 nsh 画",
    by: "orchestrator",
    body: "说清楚是重写，不是包一层网页。",
    status: "suggested",
    suggested: "VibeValley 整个搬进 VibeValley，页面用 nsh 重写，服务端换成 Rust",
    created: now - 2 * 3_600_000,
  },
];

const summaryOf = ({ page, day: d }: Stored): PkmPageSummary => ({
  slug: page.slug,
  title: page.title,
  tier: page.tier,
  file: page.file,
  tldr: page.tldr,
  updated: page.updated,
  open: page.blocks.filter((b) => b.marker === "TODO" || b.marker === "DOING" || b.marker === "LATER" || b.marker === "NOW").length,
  ...(d ? { day: d } : {}),
});

const vault = () => ({ root: "~/notes", pages: [...pages.values()].map(summaryOf).toSorted((a, b) => b.updated - a.updated) });

const linksTo = (title: string, body: string) => body.includes(`[[${title}]]`) || body.includes(`#${title}`);

function view(slug: string): PkmPageView | undefined {
  const s = pages.get(slug);
  if (!s) return undefined;
  const all = [...pages.values()].flatMap(({ page }) => page.blocks.map((b) => ({ page, b })));
  const back = all
    .filter(({ page, b }) => page.slug !== slug && linksTo(s.page.title, b.body))
    .map(({ page, b }) => ({ block: b.id, page: page.slug, pageTitle: page.title, tier: page.tier, path: b.path, body: b.body }));
  const refs = s.page.blocks.flatMap((b) => [...b.body.matchAll(/\(\(([^)]+)\)\)/gu)].map((m) => m[1] ?? ""));
  return {
    page: s.page,
    transclusions: refs.map((id) => {
      const hit = all.find(({ b }) => b.id === id);
      return hit
        ? { block: id, found: true, circular: false, page: hit.page.slug, pageTitle: hit.page.title, body: hit.b.body }
        : { block: id, found: false, circular: false, body: "" };
    }),
    backlinks: {
      projects: back.filter((l) => l.tier === "project"),
      journals: back.filter((l) => l.tier === "journal"),
      areas: back.filter((l) => l.tier === "area" || l.tier === "resource" || l.tier === "inbox"),
      archives: back.filter((l) => l.tier === "archive"),
    },
    comments: comments.filter((c) => c.page === slug && (c.status === "open" || c.status === "suggested")),
  };
}

const refused = (message: string) => ({ bizCode: 100005, message });

/** A response the fakes call with the payload; JSON gets `snapshot`. */
function served<P>(answer: (payload: P) => unknown, snapshot: unknown) {
  return Object.assign((payload: P) => answer(payload), { toJSON: () => snapshot });
}

function search(r: { text?: string; tier?: PkmTier; marker?: string; limit?: number }): PkmSearchHit[] {
  const words = (r.text ?? "").toLowerCase().split(/\s+/u).filter(Boolean);
  return [...pages.values()]
    .flatMap(({ page }) => page.blocks.map((b) => ({ page, b })))
    .filter(({ page, b }) => (!r.tier || page.tier === r.tier) && (!r.marker || b.marker === r.marker) && words.every((w) => b.body.toLowerCase().includes(w)))
    .slice(0, r.limit ?? 10)
    .map(({ page, b }) => ({
      block: b.id,
      page: page.slug,
      pageTitle: page.title,
      tier: page.tier,
      path: b.path,
      body: b.body,
      plain: b.body.replace(/\[\[|\]\]/gu, ""),
      score: 1,
      children: [],
      ...(b.marker ? { marker: b.marker } : {}),
    }));
}

const project = "vibevalley-原生移植";

export const responses: Record<string, unknown> = {
  "pkm.page.list": served(vault, vault()),
  "pkm.page.get": served((p: { page: string }) => view(p.page) ?? refused(`no page ${p.page}`), view(project)),
  "pkm.journal.open": served(
    (p: { day: string }) => {
      const slug = `journal-${p.day}`;
      if (!pages.has(slug)) put(p.day.replace(/-/gu, "_"), "journal", [], { day: p.day, slug });
      return pages.get(slug)?.page;
    },
    pages.get(`journal-${today}`)?.page,
  ),
  "pkm.block.apply": served((p: { page: string; ops: PkmBlockOp[] }) => {
    const s = pages.get(p.page);
    if (!s) return refused(`no page ${p.page}`);
    s.page = { ...s.page, blocks: applied(s.page.blocks, p.ops), updated: Date.now() };
    return s.page;
  }, null),
  "pkm.page.move": served((p: { page: string; tier: PkmTier }) => {
    const s = pages.get(p.page);
    if (!s) return refused(`no page ${p.page}`);
    s.page = { ...s.page, tier: p.tier };
    return s.page;
  }, null),
  "pkm.page.export": served(
    (p: { page: string }) => ({ markdown: (pages.get(p.page)?.page.blocks ?? []).map((b) => `${"  ".repeat(b.depth)}- ${b.body}`).join("\n") }),
    { markdown: "" },
  ),
  "pkm.radar.get": {
    inbox: 2,
    stale: [{ slug: "健康", title: "健康", days: 18, todo: 0, doing: 0, done: 0 }],
    overdue: [{ block: "x1", page: project, body: "素材库和 Artifact 页", plain: "素材库和 Artifact 页", deadline: ago(2) }],
  },
  "pkm.search": served(search, []),
  "pkm.comment.resolve": served((p: { id: string; accept: boolean }) => {
    const c = comments.find((x) => x.id === p.id);
    if (!c) return refused(`no comment ${p.id}`);
    c.status = p.accept ? "accepted" : "rejected";
    const s = pages.get(c.page);
    if (s && p.accept && c.suggested) s.page = { ...s.page, blocks: applied(s.page.blocks, [{ op: "update", block: c.block, body: c.suggested }]) };
    return s?.page;
  }, null),
  "pkm.undo": { undone: false },
};
