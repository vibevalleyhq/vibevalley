// The agents, runtimes and repos pages' part of the workbench fixture
// (merged by workbench.ts): answers by op, as vibevalley_bridge::fake reads
// responses.json. From VibeValley's own story data: the profile card
// (features/agent/AgentsPage.stories.tsx) and the runtime detail
// (features/runtime/RuntimesPage.stories.tsx); the helpers are the
// issues fixture's 老周 and 小林.
import type { Agent, AgentTemplate, AgentValidation, Look, RepoActivity, RepoLanguages, RepoSummary, RuntimeInfo, Skill } from "@vibevalley/protocol";

const now = Date.now();
const hour = 3_600_000;
const day = 24 * hour;

const look = (more: Partial<Look> = {}): Look => ({
  species: "bear",
  outfit: "farmer",
  orchestrator: null,
  build: "biped",
  head: "rounded",
  body: "#f3e9da",
  trim: "#d9774f",
  hat: "#f2b53a",
  eye: "#a6f4ff",
  ...more,
});

const agent = (more: Partial<Agent> & Pick<Agent, "id" | "name">): Agent => ({
  role: "worker",
  duty: "",
  enabled: true,
  runtime: "claude",
  model: "",
  effort: "",
  persona: "",
  personaMode: "append",
  skills: [],
  mcpServers: [],
  disallowedTools: [],
  env: {},
  workdir: "",
  worktree: true,
  tags: [],
  look: look(),
  ...more,
});

const agents: Agent[] = [
  agent({
    id: "orchestrator",
    name: "老村长",
    role: "orchestrator",
    runtime: "vibevalley",
    worktree: false,
    duty: "听你说要什么，拆成工单，派给合适的帮工",
    look: look({ species: null, outfit: null, orchestrator: "farmer", hat: "" }),
  }),
  agent({
    id: "laozhou",
    name: "老周",
    duty: "写接口、改 server、跑测试",
    model: "opus",
    effort: "medium",
    skills: ["review"],
    tags: ["后端", "接口", "测试"],
    workdir: "/Users/farmer/code/vibevalley",
    persona: "你是后端老周：先读测试，再改代码，改完把测试跑一遍。",
    mcpServers: [{ type: "stdio", name: "github", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: {} }],
    from: { template: "backend", version: 1 },
  }),
  agent({
    id: "xiaolin",
    name: "小林",
    duty: "做页面、调样式、补组件的故事",
    runtime: "codex",
    tags: ["前端", "样式"],
    look: look({ species: "rabbit", outfit: "gardener", hat: "#4f86d9" }),
  }),
  agent({
    id: "ahua",
    name: "阿花",
    duty: "写文档和发版说明",
    runtime: "opencode",
    enabled: false,
    tags: ["文档"],
    look: look({ species: "fox", outfit: "rain", hat: "#ff8fb1" }),
  }),
];

const ready = (command: string, version: string) => ({ status: "available" as const, via: "executable" as const, command, version });

const runtime = (more: Partial<RuntimeInfo> & Pick<RuntimeInfo, "id" | "preset">): RuntimeInfo => ({
  stop: "",
  support: { steer: true, refused: {}, capabilities: ["listModels", "accountUsage", "checkUpdate", "skills", "mcpServers", "tools"], inProcess: false },
  installation: ready(`/opt/homebrew/bin/${more.id}`, "1.0.0"),
  models: null,
  usage: null,
  skills: null,
  mcpServers: null,
  tools: null,
  settings: { enabled: true, binPath: "", defaultModel: "", defaultEffort: "", env: {} },
  checkedAt: now - 2 * 60_000,
  ...more,
});

const runtimes: RuntimeInfo[] = [
  runtime({
    id: "claude",
    preset: {
      id: "claude",
      label: "Claude Code",
      blurb: "Anthropic 的编码 agent，在终端里干活。",
      look: look({ build: "treads", head: "terminal", body: "#b07a45", trim: "#3a2a18", hat: "#e8b84a" }),
    },
    installation: ready("/opt/homebrew/bin/claude", "2.1.4"),
    models: [
      { id: "opus", name: "Opus", effortLevels: ["low", "medium", "high"], isDefault: true },
      { id: "sonnet", name: "Sonnet", effortLevels: ["low", "medium", "high"], isDefault: false },
      { id: "haiku", name: "Haiku", effortLevels: [], isDefault: false },
    ],
    usage: {
      status: "ok",
      subscription: "Max",
      windows: [
        { label: "5 小时", usedPercent: 38, resetsAt: now + 2 * hour },
        { label: "本周", usedPercent: 61, resetsAt: now + 50 * hour },
      ],
    },
    quota: { left: 39, text: "本周还剩 39%" },
    skills: [{ name: "review", description: "按仓库的规矩审一遍改动", source: "~/.claude/skills", enabled: true }],
    mcpServers: [{ name: "github", description: "读写 GitHub 的工单和 PR", source: "", enabled: true }],
    tools: [
      { name: "Bash", description: "", source: "", enabled: true },
      { name: "Edit", description: "", source: "", enabled: true },
      { name: "Read", description: "", source: "", enabled: true },
    ],
    settings: { enabled: true, binPath: "", defaultModel: "opus", defaultEffort: "medium", env: {} },
  }),
  runtime({
    id: "codex",
    preset: { id: "codex", label: "Codex", blurb: "OpenAI 的编码 agent。", look: look() },
    installation: ready("/opt/homebrew/bin/codex", "0.167.0"),
    support: {
      steer: true,
      refused: { appendSystemPrompt: "Codex 只收开发者说明，不收追加的系统提示" },
      capabilities: ["listModels", "accountUsage", "skills"],
      inProcess: false,
    },
    models: [{ id: "gpt-5", name: "GPT-5", effortLevels: ["minimal", "low", "medium", "high"], isDefault: true }],
    usage: { status: "ok", subscription: "Pro", windows: [{ label: "5 小时", usedPercent: 94, resetsAt: now + hour / 3 }] },
    quota: { left: 6, text: "5 小时窗口还剩 6%" },
    skills: [{ name: "review", description: "按仓库的规矩审一遍改动", source: "~/.codex/skills", enabled: true }],
  }),
  runtime({
    id: "opencode",
    preset: { id: "opencode", label: "OpenCode", blurb: "开源的终端编码 agent。", look: look() },
    installation: { status: "not_found" },
  }),
  runtime({
    id: "vibevalley",
    preset: { id: "vibevalley", label: "VibeValley", blurb: "农场自己的 agent，跑在服务里。", look: look() },
    installation: { status: "available", via: "bundled", command: "vibevalley", version: null },
    support: { steer: true, refused: {}, capabilities: ["accountUsage"], inProcess: true },
    usage: { status: "balance", provider: "DeepSeek", available: true, balances: [{ currency: "CNY", amount: 23.5 }] },
    spentToday: 1.2,
    settings: { enabled: true, binPath: "", defaultModel: "", defaultEffort: "", env: {}, dailyBudget: 5 },
  }),
];

const templates: AgentTemplate[] = [
  {
    id: "backend",
    version: 2,
    role: "worker",
    name: "后端",
    duty: "写接口、改 server、跑测试",
    tags: ["后端", "接口", "测试"],
    runtime: "claude",
    model: "opus",
    effort: "medium",
    personaMode: "append",
    worktree: true,
    look: look(),
    persona: "先读测试，再改代码，改完把测试跑一遍。",
    source: "builtIn",
    skills: ["review"],
    installed: ["laozhou"],
  },
  {
    id: "foreman",
    version: 1,
    role: "orchestrator",
    name: "工头",
    duty: "盯进度、催交付",
    tags: [],
    runtime: "vibevalley",
    model: "",
    effort: "",
    personaMode: "append",
    worktree: false,
    look: look({ species: null, outfit: null, orchestrator: "foreman" }),
    persona: "",
    source: "builtIn",
    skills: [],
    installed: [],
  },
  {
    id: "writer",
    version: 1,
    role: "worker",
    name: "写手",
    duty: "写文档和发版说明",
    tags: ["文档"],
    runtime: "opencode",
    model: "",
    effort: "",
    personaMode: "prompt",
    worktree: true,
    look: look({ species: "owl", hat: "#9580e6" }),
    persona: "",
    source: "added",
    skills: [],
    installed: [],
  },
];

const skills: Skill[] = [
  {
    id: "review",
    name: "审改动",
    description: "按仓库的规矩审一遍改动",
    body: "## 审改动\n\n1. 读 diff\n2. 对照 `docs/style`\n3. 列出要改的地方",
    builtIn: true,
  },
  { id: "release-notes", name: "发版说明", description: "从合并的工单写一段发版说明", body: "按用户看得见的变化分组，一句话一条。" },
];

export const repos: RepoSummary[] = [
  { name: "vibevalley", path: "/Users/farmer/code/vibevalley", git: true, last: now - 3 * hour, maxSessions: 3, pullRequest: { available: true, reason: "" } },
  {
    name: "site",
    path: "/Users/farmer/code/site",
    git: true,
    last: now - 5 * day,
    maxSessions: 2,
    pullRequest: { available: false, reason: "没有远端" },
  },
  { name: "notes", path: "/Users/farmer/notes", git: false, maxSessions: 1, pullRequest: { available: false, reason: "不是 git 仓库" } },
];

const two = (n: number) => String(n).padStart(2, "0");
const dayKey = (d: Date) => `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
/** A steady year of work: weekdays busier, a quiet stretch in the middle. */
const days = Array.from({ length: 300 }, (_, i) => {
  const at = new Date(now - i * day);
  const weekday = at.getDay() !== 0 && at.getDay() !== 6;
  const commits = i > 120 && i < 150 ? 0 : (((i * 7) % 11) + (weekday ? 3 : 0)) % 9;
  return { day: dayKey(at), commits };
}).filter((d) => d.commits > 0);

const activity: RepoActivity = {
  repo: "vibevalley",
  at: now - 10 * 60_000,
  days,
  authors: [
    { name: "farmer", commits: 812 },
    { name: "老周", commits: 344 },
    { name: "小林", commits: 129 },
  ],
  total: days.reduce((n, d) => n + d.commits, 0),
  first: now - 420 * day,
  last: now - 3 * hour,
};

const languages: RepoLanguages = {
  repo: "vibevalley",
  at: now - 10 * 60_000,
  languages: [
    { name: "TypeScript", files: 1210, code: 98_000, comments: 6_100, blanks: 9_000 },
    { name: "TSX", files: 480, code: 41_000, comments: 1_900, blanks: 4_000 },
    { name: "Rust", files: 60, code: 9_400, comments: 800, blanks: 1_100 },
    { name: "CSS", files: 12, code: 2_100, comments: 90, blanks: 300 },
    { name: "Markdown", files: 140, code: 0, comments: 12_000, blanks: 2_000 },
    { name: "Shell", files: 18, code: 600, comments: 80, blanks: 90 },
  ],
};

const validations: AgentValidation[] = [
  { id: "ahua", problems: [{ field: "runtime", level: "error", text: "OpenCode 没装" }] },
  { id: "xiaolin", problems: [{ field: "persona", level: "warn", text: "还没写人设" }] },
];

export const responses: Record<string, unknown> = {
  "agent.list": agents,
  "orchestrator.approval.list": [],
  "agent.template.list": templates,
  "agent.validate": validations,
  "runtime.list": runtimes,
  "skill.list": skills,
  "repo.list": repos,
  "repo.language.list": languages,
  "repo.activity.get": activity,
};
