import type { AccountUsage, Installation, Look, RuntimeInfo } from "@vibevalley/protocol";
import { stories, story, type Story } from "@vibevalley/stories";
import { Detail } from "./RuntimesPage";

const now = Date.now();
const hour = 3_600_000;

const look: Look = { species: "bear", outfit: "farmer", build: "treads", head: "terminal", body: "#b07a45", trim: "#3a2a18", hat: "#e8b84a", eye: "#22341a" };

const ready: Installation = { status: "available", via: "executable", command: "/opt/homebrew/bin/claude", version: "2.1.4" };

const info = (more: Partial<RuntimeInfo> = {}): RuntimeInfo => ({
  id: "claude",
  preset: { id: "claude", label: "Claude Code", blurb: "Anthropic 的编码 agent，在终端里干活。", look },
  facts: { steer: true, refused: {}, capabilities: ["listModels", "accountUsage", "checkUpdate", "skills", "mcpServers", "tools"], inProcess: false },
  installation: ready,
  models: [
    { id: "opus", name: "Opus", effortLevels: ["low", "medium", "high"], isDefault: true },
    { id: "sonnet", name: "Sonnet", effortLevels: ["low", "medium", "high"], isDefault: false },
  ],
  usage: {
    status: "ok",
    subscription: "Max",
    windows: [
      { label: "5 小时", usedPercent: 38, resetsAt: now + 2 * hour },
      { label: "本周", usedPercent: 61, resetsAt: now + 50 * hour },
    ],
  },
  skills: [{ name: "review", description: "按项目的规矩审一遍改动", source: "~/.claude/skills" }],
  mcpServers: [{ name: "github", description: "读写 GitHub 的工单和 PR", enabled: true }],
  tools: [{ name: "Bash" }, { name: "Edit" }, { name: "Read" }],
  settings: { enabled: true, binPath: "", defaultModel: "opus", defaultEffort: "medium", env: {} },
  checkedAt: now - 2 * 60_000,
  ...more,
});

const usage = (u: AccountUsage) => info({ usage: u });

const scene = (note: string, i: RuntimeInfo): Story =>
  story({
    fill: true,
    note,
    render: () => (
      <div class="w-full max-w-3xl">
        <Detail info={i} agents={[]} />
      </div>
    ),
  });

export default stories({
  title: "界面/农机/详情",
  stories: {
    能用: scene("装好了、登录了：用量两条窗口，模型、技能、MCP、工具都列出来。", info()),
    快用完: scene(
      "五小时窗口快满了：重置时间就是能再派活的时候。",
      usage({ status: "ok", subscription: "Pro", windows: [{ label: "5 小时", usedPercent: 94, resetsAt: now + hour / 3 }] }),
    ),
    按余额: scene(
      "按余额付钱的：剩多少钱。",
      usage({ status: "balance", provider: "DeepSeek", available: true, balances: [{ currency: "CNY", amount: 23.5 }] }),
    ),
    要登录: scene("装了没登录：在终端里登录一次。", usage({ status: "login_required" })),
    用量拿不到: scene("用量读不到时说为什么，不当成用完了。", usage({ status: "unavailable", reason: "用量接口超时" })),
    没装: scene(
      "这台电脑上没装：怎么装。",
      info({ installation: { status: "not_found" }, models: null, usage: null, skills: null, mcpServers: null, tools: null }),
    ),
    不支持: scene(
      "这个系统上用不了，原因照实说。",
      info({ installation: { status: "unsupported", reason: "只支持 macOS 和 Linux" }, models: null, usage: null }),
    ),
    在检查: scene(
      "刚开机，还在找它装在哪。",
      info({ installation: { status: "checking" }, models: null, usage: null, skills: null, mcpServers: null, tools: null }),
    ),
    停用了: scene(
      "主人停用了它：管家不会派活给它。",
      info({ settings: { enabled: false, binPath: "", defaultModel: "opus", defaultEffort: "medium", env: {} }, stop: "今天的预算花完了" }),
    ),
  },
});
