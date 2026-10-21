// The server's ten modules, lowest first: a module uses the ones before it and never one after
// (.agents/notes/proposed/architecture/2026-10-22-ten-modules.md). Each entry is the folders and root files under src/ it
// is made of; modules.test.ts reads every import against this table, and services.ts assembles the modules in this order.

export interface Module {
  readonly name: string;
  /** Folders and files directly under src/. */
  readonly parts: readonly string[];
}

export const modules: readonly Module[] = [
  { name: "Platform", parts: ["base", "core", "setting", "errors.ts"] },
  { name: "Agents", parts: ["agent", "runtime", "memory", "ai"] },
  { name: "Source Control", parts: ["project"] },
  { name: "Collaboration", parts: ["channel", "doc"] },
  { name: "Agent Sessions", parts: ["session"] },
  { name: "Issues", parts: ["issue", "task", "schedule"] },
  { name: "Notifications", parts: ["notice"] },
  { name: "Assistant", parts: ["manager", "tool"] },
  { name: "Gamification", parts: ["game"] },
  { name: "Gateway", parts: ["http", "mcp", "lan", "connector", "voice", "handlers.ts", "cli.ts", "main.ts", "services.ts", "modules.ts"] },
];

/** What the tests and the test farm are made of; they may use every module. */
export const outside = ["testing", "flows"];

/** The module a path under src/ (forward slashes) is part of; undefined outside every module. */
export function moduleOf(path: string): Module | undefined {
  const top = path.split("/")[0]!;
  return modules.find((m) => m.parts.includes(top));
}
