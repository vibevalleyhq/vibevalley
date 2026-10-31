import type { Agent, AgentTally, Installation, Look, RuntimeInfo } from "@vibevalley/protocol";
import { stories, story } from "@vibevalley/stories";

import { AgentCard } from "./AgentsPage";

const look: Look = { species: "bear", outfit: "farmer", build: "biped", head: "rounded", body: "", trim: "", hat: "", eye: "" };

const agent = (more: Partial<Agent> = {}): Agent => ({
  id: "backend",
  name: "后端老周",
  role: "helper",
  duty: "写接口、改 server、跑测试",
  enabled: true,
  runtime: "claude",
  model: "opus",
  effort: "medium",
  persona: "",
  personaMode: "append",
  skills: ["review"],
  mcpServers: [],
  disallowedTools: [],
  env: {},
  workdir: "",
  worktree: true,
  tags: ["后端", "接口", "测试"],
  look,
  ...more,
});

const runtime = (installation: Installation): RuntimeInfo => ({
  stop: "",
  id: "claude",
  preset: { id: "claude", label: "Claude Code", blurb: "", look },
  facts: { steer: true, refused: {}, capabilities: [], inProcess: false },
  installation,
  models: null,
  usage: null,
  skills: null,
  mcpServers: null,
  tools: null,
  settings: { enabled: true, binPath: "", defaultModel: "opus", defaultEffort: "medium", env: {} },
  checkedAt: Date.now(),
});

const installed = runtime({ status: "available", via: "executable", command: "claude", version: "2.1.4" });
const tally: AgentTally = { hired: 14, harvested: 11, failed: 2 };

export default stories({
  title: "组件/帮工/档案卡",
  stories: {
    States: story({
      note: "档案页上的一张卡：在干活的、闲着的、停用的（管家不派）、农机没装的、配置有问题的（列出会挡住派活的）。",
      args: { state: "working" },
      grid: { rows: ["state", ["working", "idle", "disabled", "no runtime", "problems"]], cols: "pseudo" },
      render: (a) => (
        <div class="w-72">
          <AgentCard
            agent={agent({ enabled: a.state !== "disabled" })}
            runtime={a.state === "no runtime" ? runtime({ status: "not_found" }) : installed}
            tally={tally}
            here={a.state === "working" ? 2 : 0}
            skillName={new Map([["review", "审改动"]])}
            errors={a.state === "problems" ? ["工作目录不存在：~/code/api", "技能 deploy 没装"] : []}
          />
        </div>
      ),
    }),
  },
});
