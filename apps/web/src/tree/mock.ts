// Made-up memories for the memory tree until the server sums them up (.agents/notes/proposed/feature/2026-10-22-memory-tree.md):
// MemoryTree is the shape memory.tree is to answer with, and moves into the protocol then. Everything here is fixed by
// a seed, so the page and its tests see the same tree on every load.

import { currentLocale } from "@vibevalley/i18n";
import { omitUndefined } from "@vibevalley/protocol/rules";
export type MemoryKind = "leaf" | "fruit" | "seed";

/** A fruit's three parts: an EverOS agent case, or the issue and its last report for a local `issue` memory. */
export interface MemoryCase {
  readonly intent: string;
  readonly approach: string;
  readonly insight: string;
}

export interface MemoryItem {
  readonly id: string;
  readonly kind: MemoryKind;
  /** A leaf's note, a fruit's key insight, a seed's skill name. */
  readonly body: string;
  /** The helper profile whose memory it is. */
  readonly agent: string;
  /** null: for every project. */
  readonly project: string | null;
  /** When it was written, ms. */
  readonly at: number;
  readonly recalled: number;
  readonly recalledAt?: number;
  /** One of the next to be forgotten (the memory's `fading`). */
  readonly fading: boolean;
  readonly case?: MemoryCase;
  /** A seed the owner has sown into the skill book. */
  readonly sown?: boolean;
}

export interface MemoryAgent {
  readonly id: string;
  readonly name: string;
}

/**
 * Two memories that belong together: `from`, the second was distilled from the first (a seed from a fruit, a fruit's
 * job wrote the leaf down: EverOS's skill sources, or one session locally); `together`, recalled into the same rounds
 * `times` times (counted from each session's recalled ids).
 */
export interface MemoryLink {
  readonly kind: "from" | "together";
  /** For `from`: the source (the fruit, the leaf). */
  readonly a: string;
  /** For `from`: what grew from it (the seed, the fruit). */
  readonly b: string;
  readonly times: number;
}

export const TreeStageValues = [1, 2, 3, 4, 5] as const;
export type TreeStage = (typeof TreeStageValues)[number];

export interface MemoryTree {
  /** The first memory, ms. */
  readonly since: number;
  /** Rounds of work ever finished, and memories ever recalled: they only grow. */
  readonly rounds: number;
  readonly recalls: number;
  /** The server's rule: how grown the tree is, and how many more rounds to the next stage. */
  readonly stage: TreeStage;
  readonly nextStageIn?: number;
  readonly agents: readonly MemoryAgent[];
  readonly projects: readonly string[];
  readonly items: readonly MemoryItem[];
  readonly links: readonly MemoryLink[];
}

const agentsZh: MemoryAgent[] = [
  { id: "fox", name: "阿郑" },
  { id: "bear", name: "老周" },
  { id: "rabbit", name: "小吴" },
  { id: "cat", name: "Kimi" },
  { id: "owl", name: "Grok" },
];

const projectsZh = ["vibevalley", "字幕面板", "官网", "billing"];

const notesZh = [
  "表名用单数：issue、issue_session",
  "改完 db/queries 要跑 vp run db:generate",
  "主人不要兼容层，旧数据直接作废",
  "页面不折事实，要新数据就加 protocol 字段",
  "提交说明一句话说改完以后的行为",
  "不要开 next dev，先 lint、typecheck 再 build",
  "注释用英文，只写为什么",
  "字幕时间轴按毫秒存，显示时再换算",
  "官网的图直接用 apps/web/public 的",
  "billing 的金额一律用分，不用浮点",
  "测试里的帮工用 scriptedRuntime",
  "Playwright 测试的家目录是临时的",
  "图标用像素贴图，不用字符代替",
  "Solid 2 的 Show 函数子节点会在分支关掉后抛错",
  "服务端只听 127.0.0.1",
  "改了 api.ts 要跑 vp run api:client",
  "中文和英文之间空一格",
  "golden 数据有意改了才重写，先看 diff",
  "字幕面板的快捷键不和播放器冲突",
  "billing 的 webhook 要验签名",
];

const casesZh: MemoryCase[] = [
  { intent: "字幕面板加拖动对齐", approach: "先写时间轴的纯函数，再接拖动", insight: "吸附阈值按像素算，不按毫秒" },
  { intent: "表名改成单数", approach: "直接改 0001_schema，重生成查询", insight: "schema.test.ts 会查出漏改的索引名" },
  { intent: "官网首页换成像素风", approach: "复用 public/pixel 的图", insight: "图片放大用整数倍，不然像素会糊" },
  { intent: "billing 补退款", approach: "先补黄金数据，再改规则", insight: "退款金额要从原单的分算，不能反推" },
  { intent: "修 SSE 断线不重连", approach: "加心跳和指数退避", insight: "代理会吞掉空闲超过 60 秒的连接" },
  { intent: "管家派活时带上项目", approach: "在工具描述里写明默认项目", insight: "改了工具描述要跑 evals" },
  { intent: "农场的时钟和真实时间对齐", approach: "日钟的速度可调，默认 600 秒一天", insight: "测试里把速度设成 0" },
  { intent: "手机壳扫码配对", approach: "一台设备一把钥匙", insight: "配对页不能放 /mcp" },
];

const skillsZh = [
  "改表结构的套路",
  "给规则补黄金数据",
  "像素图的整数倍放大",
  "Solid 2 里安全地用 Show",
  "SSE 的断线重连",
  "写一条好的提交说明",
  "billing 金额的算法",
];

const agentsEn: MemoryAgent[] = [
  { id: "fox", name: "Zheng" },
  { id: "bear", name: "Zhou" },
  { id: "rabbit", name: "Wu" },
  { id: "cat", name: "Kimi" },
  { id: "owl", name: "Grok" },
];

const projectsEn = ["vibevalley", "subtitle-panel", "site", "billing"];

const notesEn = [
  "Table names are singular: issue, issue_session",
  "After changing db/queries, run vp run db:generate",
  "The owner wants no compatibility layers; old data is dropped",
  "The page folds no facts; new data is a protocol field",
  "A commit subject says the behavior after the change",
  "No next dev: lint and typecheck, then build",
  "Comments in English, and only the why",
  "Subtitle timings are kept in ms, converted when shown",
  "The site's images come straight from apps/web/public",
  "billing amounts are in cents, never floats",
  "Helpers in tests are scriptedRuntime",
  "Playwright tests get a temporary home",
  "Icons are pixel sprites, not characters",
  "Solid 2's Show throws if a function child runs after the branch closes",
  "The server listens on 127.0.0.1 only",
  "After changing api.ts, run vp run api:client",
  "A space between Chinese and English words",
  "Rewrite golden data only on purpose, after reading the diff",
  "The subtitle panel's shortcuts never clash with the player's",
  "billing webhooks must check their signature",
];

const casesEn: MemoryCase[] = [
  { intent: "Drag to align in the subtitle panel", approach: "Pure functions for the timeline first, dragging after", insight: "Snap by pixels, not by ms" },
  {
    intent: "Make table names singular",
    approach: "Edit 0001_schema in place, regenerate the queries",
    insight: "schema.test.ts finds the index names left behind",
  },
  {
    intent: "A pixel-style home page for the site",
    approach: "Reuse the images in public/pixel",
    insight: "Scale images by whole numbers, or the pixels blur",
  },
  {
    intent: "Refunds in billing",
    approach: "Golden data first, then the rule",
    insight: "A refund is counted from the original order's cents, never worked back",
  },
  {
    intent: "SSE does not reconnect after a drop",
    approach: "A heartbeat and exponential backoff",
    insight: "Proxies drop connections idle for over 60 seconds",
  },
  {
    intent: "The orchestrator sends work with its project",
    approach: "Name the default project in the tool's description",
    insight: "Changing a tool description means running the evals",
  },
  { intent: "The farm's clock keeps real time", approach: "The day clock's speed is set, 600 seconds a day by default", insight: "Tests set the speed to 0" },
  { intent: "Pair the phone by QR code", approach: "One key per device", insight: "The pairing page never serves /mcp" },
];

const skillsEn = [
  "How to change the schema",
  "Adding golden data to a rule",
  "Whole-number scaling for pixel art",
  "Using Show safely in Solid 2",
  "Reconnecting SSE after a drop",
  "Writing a good commit subject",
  "How billing counts money",
];

/** A small seeded random: the same tree on every load. */
function random(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const day = 86_400_000;

/** The made-up tree; `stage` from the address (`/tree?stage=3`) lets the owner see each stage. */
export function mockTree(now: number, stage?: TreeStage): MemoryTree {
  const en = currentLocale() === "en";
  const [agents, projects, notes, cases, skills] = en ? [agentsEn, projectsEn, notesEn, casesEn, skillsEn] : [agentsZh, projectsZh, notesZh, casesZh, skillsZh];
  const rnd = random(20261022);
  const pick = <T>(list: readonly T[]) => list[Math.floor(rnd() * list.length)]!;
  const since = now - 46 * day;
  const at = () => since + Math.pow(rnd(), 0.8) * (now - since);
  const items: MemoryItem[] = [];
  for (let i = 0; i < 186; i++) {
    const written = at();
    const recalled = Math.floor(Math.pow(rnd(), 3) * 9);
    items.push(
      omitUndefined({
        id: `leaf-${i}`,
        kind: "leaf" as const,
        body: pick(notes),
        agent: pick(agents).id,
        project: rnd() < 0.25 ? null : pick(projects),
        at: written,
        recalled,
        recalledAt: recalled > 0 ? written + rnd() * (now - written) : undefined,
        fading: false as const,
      }),
    );
  }
  // The five least used are the next to fall.
  [...items]
    .sort((a, b) => (a.recalledAt ?? a.at) - (b.recalledAt ?? b.at))
    .slice(0, 5)
    .forEach((leaf) => {
      items[items.indexOf(leaf)] = { ...leaf, fading: true };
    });
  for (let i = 0; i < 41; i++) {
    const c = pick(cases);
    const written = at();
    const recalled = Math.floor(Math.pow(rnd(), 2) * 12);
    items.push(
      omitUndefined({
        id: `fruit-${i}`,
        kind: "fruit" as const,
        body: c.insight,
        agent: pick(agents).id,
        project: pick(projects),
        at: written,
        recalled,
        recalledAt: recalled > 0 ? written + rnd() * (now - written) : undefined,
        fading: false as const,
        case: c,
      }),
    );
  }
  // The fruit recalled last: the one that flashes.
  items.push(
    omitUndefined({
      id: "fruit-now",
      kind: "fruit" as const,
      body: cases[0]!.insight,
      agent: "fox",
      project: projects[1]!,
      at: now - 6 * day,
      recalled: 4,
      recalledAt: now - 40_000,
      fading: false as const,
      case: cases[0],
    }),
  );
  skills.forEach((name, i) => {
    items.push({
      id: `seed-${i}`,
      kind: "seed",
      body: name,
      agent: pick(agents).id,
      project: null,
      at: since + ((i + 1) / (skills.length + 1)) * (now - since),
      recalled: Math.floor(rnd() * 20),
      fading: false as const,
      sown: i < 4,
    });
  });
  const links: MemoryLink[] = [];
  const fruits = items.filter((m) => m.kind === "fruit");
  const leaves = items.filter((m) => m.kind === "leaf");
  // A seed came of three to five fruits written before it; a fruit's job noted one to three leaves, same helper, near
  // the same day.
  for (const seed of items.filter((m) => m.kind === "seed")) {
    const before = fruits.filter((f) => f.at < seed.at);
    const n = Math.min(before.length, 3 + Math.floor(rnd() * 3));
    for (let i = 0; i < n; i++) {
      const f = before[Math.floor(rnd() * before.length)]!;
      if (!links.some((l) => l.a === f.id && l.b === seed.id)) links.push({ kind: "from", a: f.id, b: seed.id, times: 1 });
    }
  }
  for (const f of fruits) {
    const near = leaves.filter((l) => l.agent === f.agent && Math.abs(l.at - f.at) < 4 * day);
    const n = Math.min(near.length, 1 + Math.floor(rnd() * 3));
    for (let i = 0; i < n; i++) {
      const l = near[Math.floor(rnd() * near.length)]!;
      if (!links.some((x) => x.a === l.id && x.b === f.id)) links.push({ kind: "from", a: l.id, b: f.id, times: 1 });
    }
  }
  // Recalled together: pairs among the memories recalled at all, the most used most often.
  const used = items.filter((m) => m.recalled > 2);
  for (let i = 0; i < 48; i++) {
    const a = used[Math.floor(rnd() * used.length)]!;
    const b = used[Math.floor(rnd() * used.length)]!;
    if (a === b || links.some((l) => l.kind === "together" && ((l.a === a.id && l.b === b.id) || (l.a === b.id && l.b === a.id)))) continue;
    links.push({ kind: "together", a: a.id, b: b.id, times: 2 + Math.floor(rnd() * Math.min(a.recalled, b.recalled)) });
  }
  return omitUndefined({
    since,
    rounds: 128,
    recalls: items.reduce((n, m) => n + m.recalled, 0),
    stage: stage ?? 5,
    nextStageIn: (stage ?? 5) < 5 ? 24 : undefined,
    agents,
    projects,
    items,
    links,
  });
}
