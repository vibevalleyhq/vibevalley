export interface Module {
  readonly name: string;
  /** Folders and files directly under src/. */
  readonly parts: readonly string[];
}

export const modules: readonly Module[] = [
  { name: "Platform", parts: ["base", "infra", "core", "setting", "user", "storage", "attachment", "provider"] },
  { name: "Agents", parts: ["agent", "runtime", "memory"] },
  { name: "Source Control", parts: ["repo"] },
  { name: "Agent Sessions", parts: ["executor", "machine", "session"] },
  { name: "Mailbox", parts: ["mailbox"] },
  { name: "Collaboration", parts: ["channel", "media", "library", "artifact", "pkm"] },
  { name: "Issues", parts: ["issue", "cron"] },
  { name: "Ingress", parts: ["ingress"] },
  { name: "Resource", parts: ["resource"] },
  { name: "Inbox", parts: ["inbox"] },
  { name: "Orchestrator", parts: ["orchestrator", "tool"] },
  { name: "Gamification", parts: ["game"] },
  {
    name: "Gateway",
    parts: ["http", "mcp", "lan", "connector", "voice", "chat", "projection", "main.ts", "services.ts", "modules.ts"],
  },
];

/** What the tests and the test farm are made of; they may use every module. */
export const outside = ["testing", "flows"];

/** The module a path under src/ (forward slashes) is part of; undefined outside every module. */
export function moduleOf(path: string): Module | undefined {
  const top = path.split("/")[0] ?? "";
  return modules.find((m) => m.parts.includes(top));
}
