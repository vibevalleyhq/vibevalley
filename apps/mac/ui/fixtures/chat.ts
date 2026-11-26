// The chat and settings pages' part of the workbench fixture (merged by
// workbench.ts): answers by op, as vibevalley_bridge::fake reads responses.json,
// and the chat for the state frame (`chatState`, `crons`). The messages are
// VibeValley's MessageList.stories.tsx rows (talk, reports, rich, edited /
// pinned / deleted), the cron its Tabs.stories.tsx card.
import {
  type Actor,
  type Channel,
  type ChatMessage,
  type CronView,
  type Feature,
  FeatureValues,
  type GitHubStatus,
  type Readiness,
  type SettingsStatus,
} from "@vibevalley/protocol";
import { messageId } from "@vibevalley/protocol/schema";

const now = Date.now();
const min = 60_000;
let n = 0;

const msg = (actor: Actor, from: string, name: string, text: string, more: Partial<ChatMessage> = {}): ChatMessage => ({
  id: messageId(`m${++n}`),
  number: n,
  channel: "general",
  from,
  actor,
  name,
  kind: "chat",
  text,
  at: now - (40 - n) * min,
  revision: 1,
  mentions: [],
  spoken: false,
  reactions: [],
  attachments: [],
  embeds: [],
  ...more,
  outcome: more.outcome ?? null,
});

const user = (text: string, more: Partial<ChatMessage> = {}) => msg({ kind: "user", id: "user", name: "用户" }, "user", "用户", text, more);
const orchestrator = (text: string, more: Partial<ChatMessage> = {}) =>
  msg({ kind: "agent", id: "orchestrator", role: "orchestrator", name: "助手" }, "orchestrator", "助手", text, more);
const helper = (text: string, more: Partial<ChatMessage> = {}) =>
  msg({ kind: "agent", id: "w1", role: "worker", name: "老周" }, "w1", "老周", text, { agent: "laozhou", ...more });

const messages: ChatMessage[] = [
  user("登录过期的问题谁来修？"),
  orchestrator("派给老周了，在工单 #18 里。"),
  orchestrator("他说半小时左右。"),
  helper("收到，先看 session.ts。", {
    artifact: { id: "art-login", title: "登录流程", artifactType: "prototype", version: 2, note: "多一条测试" } as ChatMessage["artifact"],
  }),
  helper("改好了：过期回到登录页，加了两条测试。", { kind: "report", run: "run-1", outcome: "completed", spent: { tokens: 32_800, cny: 0.42 } }),
  helper("测试起不来：缺一个环境变量。", { kind: "report", outcome: "failed", spent: { tokens: 9_100, cny: 0.11 } }),
  user("设计稿和录屏在这，参考 https://example.com/design", {
    attachments: [
      { id: "a1", name: "design-review.pdf", type: "application/pdf", size: 1_400_000 },
      { id: "a2", name: "bug.mov", type: "video/quicktime", size: 48_000_000 },
      { id: "a3", name: "login.png", type: "image/png", size: 182_000 },
      { id: "a4", name: "voice.m4a", type: "audio/mp4", size: 96_000 },
    ],
    embeds: [{ url: "https://example.com/design", image: "", site: "example.com", title: "登录页改版", description: "过期提示、重新登录、记住我" }],
    reactions: [
      { emoji: "👍", by: ["orchestrator", "w1"] },
      { emoji: "👀", by: ["user"] },
    ],
  }),
  helper(["## 改了什么", "", "- `session.ts`：过期判断", "- `Login.tsx`：提示文案"].join("\n")),
  user("周五之前合进去。", { edited: now - 2 * min }),
  orchestrator("记下了：周五之前。", { pinned: now - min }),
  helper("（这条删了）", { deleted: now - min }),
] as ChatMessage[];

const channel = (id: string, name: string, more: Partial<Channel> = {}): Channel => ({
  id,
  type: "channel",
  default: false,
  category: "",
  notify: "all",
  name,
  description: "",
  subjectKind: null,
  replies: 0,
  title: name,
  at: now - 60 * min,
  ...more,
});

const last = messages.at(-2);

export const chatState = {
  channels: [
    channel("general", "general", {
      default: true,
      description: "田头的大家",
      repo: "vibevalley",
      lastNumber: messages.length,
      read: messages.length - 3,
      unread: 3,
      ...(last ? { last: { from: last.from, name: last.name, text: last.text, at: last.at } } : {}),
    }),
    channel("design", "设计", { category: "产品", unread: 2, lastNumber: 4, read: 2 }),
    channel("release", "发版", { category: "产品", notify: "mentions" }),
    channel("t-login", "修好登录", {
      type: "thread",
      parent: "general",
      root: messages[1]?.id,
      rootNumber: 2,
      subjectKind: "issue",
      subjectId: "i18",
      replies: 4,
      title: "修好登录",
      lastNumber: 4,
      read: 4,
      last: { from: "w1", name: "老周", text: "先看 session.ts。", at: now - 10 * min },
    }),
    { ...channel("d-xiaolin", "小林"), type: "direct", peer: "xiaolin", title: "小林" } as Channel,
  ],
  userMentions: [],
};

export const crons: CronView[] = [
  {
    id: "c1",
    name: "每天的站会",
    text: "看一眼昨天交的活，写三行进展发到这里。",
    channel: "general",
    when: { kind: "daily", time: "09:30" },
    tz: "Asia/Shanghai",
    enabled: true,
    created: now - 7 * 86_400_000,
    lastRun: now - 86_400_000,
    by: "user",
    pending: false,
    whenText: "每天 09:30",
    nextText: "明天 09:30",
  },
];

const voice = {
  persona: "",
  greeting: "你好！今天种点什么？",
};

const features: readonly Feature[] = FeatureValues;
const readiness = Object.fromEntries(features.map((f): [Feature, Readiness] => [f, { ready: true }])) as Record<Feature, Readiness>;

const settings: SettingsStatus = {
  file: "~/.vibevalley/settings.json",
  home: "~/.vibevalley",
  paths: { repos: "~/.vibevalley/repos", worktrees: "~/.vibevalley/worktrees" },
  version: "0.42.0",
  locale: "zh",
  deepseekApiKey: { source: "settings", hint: "…3f9a" },
  voice,
  voiceDefaults: voice,
  readiness,
  memorySources: [{ kind: "nowledge", url: "http://127.0.0.1:14242/mcp/", enabled: true, read: true, write: true, everything: false, key: { source: null } }],
};

const github: GitHubStatus = { installed: true, version: "2.62.0", loggedIn: true, account: "lucas", reason: "", checkedAt: now };

export const responses: Record<string, unknown> = {
  "channel.message.list": messages,
  "channel.pin.list": messages.filter((m) => m.pinned !== undefined),
  "channel.message.search": [],
  "channel.markRead": null,
  "channel.message.send": null,
  "setting.get": settings,
  "setting.update": settings,
  "github.get": github,
  "github.refresh": github,
  // VibeValley's own: where the server keeps an attachment (every id answers the same file here).
  "attachment.file": { path: "/Users/farmer/.vibevalley/attachments/login.png", type: "image/png" },
  "host.readFile": { data: "aGVsbG8=", type: "text/plain", name: "notes.txt" },
  "attachment.create": { id: "a9", name: "notes.txt", type: "text/plain", size: 5 },
  // The app plays sounds itself (nsh has no audio on GPUI).
  "host.playAudio": null,
  "host.stopAudio": null,
  "host.openFile": null,
};
