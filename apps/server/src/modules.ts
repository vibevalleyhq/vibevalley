export interface Module {
  readonly name: string;
  /** Paths under src/ ("base", "platform/setting", "modules/issue", "gateway/http", "main.ts"…). */
  readonly parts: readonly string[];
}

export const modules: readonly Module[] = [
  {
    name: "Platform",
    parts: ["base", "infra", "core", "platform/setting", "platform/user", "platform/attachment", "platform/provider"],
  },
  { name: "Agents", parts: ["modules/agent", "modules/runtime", "modules/memory"] },
  { name: "Source Control", parts: ["modules/repo"] },
  { name: "Agent Sessions", parts: ["modules/session"] },
  { name: "Collaboration", parts: ["modules/channel", "modules/media", "modules/artifact", "modules/pkm"] },
  { name: "Issues", parts: ["modules/issue"] },
  { name: "Watch", parts: ["modules/watch"] },
  { name: "Orchestrator", parts: ["modules/orchestrator"] },
  { name: "Gamification", parts: ["modules/game"] },
  {
    name: "Gateway",
    parts: [
      "gateway/http",
      "gateway/mcp",
      "gateway/tool",
      "gateway/lan",
      "gateway/connector",
      "gateway/voice",
      "gateway/projection",
      "chat",
      "main.ts",
      "services.ts",
      "modules.ts",
    ],
  },
];

/** Allowed second-level containers and test harnesses under apps/server/src/. */
export const containers = ["platform", "modules", "gateway"] as const;

const isContainer = (folder: string) => containers.some((c) => c === folder);

/** What the tests and the test farm are made of; they may use every module. */
export const outside = ["testing", "flows"];

/** The concept unit a path under src/ belongs to ("modules/issue", "gateway/http", "base", "main.ts"). */
export function unitOf(path: string): string {
  const [first = "", second = ""] = path.split("/");
  return isContainer(first) && second !== "" ? `${first}/${second}` : first;
}

/** The singular concept name ("issue", "http", "base") for SQL table ownership and service-path reporting. */
export function conceptOf(path: string): string {
  const [first = "", second = ""] = path.split("/");
  return isContainer(first) && second !== "" ? second : first;
}

/** The module a path under src/ (forward slashes) is part of; undefined outside every module. */
export function moduleOf(path: string): Module | undefined {
  const unit = unitOf(path);
  return modules.find((m) => m.parts.includes(unit));
}
