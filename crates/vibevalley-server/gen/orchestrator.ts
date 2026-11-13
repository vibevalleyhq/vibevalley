// Writes the orchestrator's model-facing words from apps/server
// (vp run protocol:rust runs it on crates/vibevalley-protocol/gen/prepare.sh's copy).
// tools.json: each tool the orchestrator holds in apps/server, in its
// order, as the model sees it (name, description, JSON Schema);
// session_tools.json: a helper's, as /mcp serves them.
// prompts.json: the system prompt parts.

import { writeFileSync } from "node:fs";
import { join } from "node:path";

const VV = process.argv[2]!;
const out = process.argv[3]!;

const { toolName } = await import(`${VV}/apps/server/src/gateway/tool/schemas.ts`);
const P = await import(`${VV}/apps/server/src/modules/orchestrator/prompts.ts`);
const H = await import(`${VV}/apps/server/src/modules/session/prompts.ts`);

const { makeTool } = await import(`${VV}/apps/server/src/gateway/tool/tool.ts`);
const { endpoints } = await import(`${VV}/packages/protocol/src/api.ts`);

// The tool lists as tool.ts builds them: names, words and schemas do not touch the services, so a stand-in for every
// dependency is enough. A tool's endpoint is the one its name is made from; resource_read has none.
const anything: any = new Proxy(function () {}, { get: (_t, k) => (k === "then" ? undefined : anything), apply: () => anything });
const built = await makeTool(anything);
const who: any = () => ({ agent: "", session: "", repo: "", actor: { kind: "worker", id: "" } });
const opOf = new Map<string, string>(endpoints.map((e: { op: string }) => [toolName(e.op), e.op]));
const listed = (tools: { name: string; description: string; parameters: unknown }[]) =>
  tools.map((t) => ({ op: opOf.get(t.name) ?? t.name.replaceAll("_", "."), name: t.name, description: t.description, parameters: t.parameters }));
const tools = listed(built.orchestrator(who));
writeFileSync(join(out, "tools.json"), JSON.stringify(tools, null, 1) + "\n");
// A helper's tools, served on /mcp.
writeFileSync(join(out, "session_tools.json"), JSON.stringify(listed(built.session(who)), null, 1) + "\n");

const prompts = {
  system: P.systemPrompt,
  agent: P.agentPrompt,
  voice: P.voiceNote,
  env: H.hostWords.envSection("{cwd}"),
  skills: H.hostWords.skillsSection("{skills}"),
  memory: H.hostWords.memorySection("{memory}"),
  // A helper's rules on an issue (session/prompts.ts workplaceRules), filled by the board.
  workplace: {
    branch: H.workplaceRules({ repo: "{repo}", branch: "{branch}", cwd: "{cwd}" }, "{house}", "{id}", false),
    pullRequest: H.workplaceRules({ repo: "{repo}", branch: "{branch}", cwd: "{cwd}" }, "{house}", "{id}", true),
    folder: H.workplaceRules({ repo: "{repo}", branch: "", cwd: "{cwd}" }, "{house}", "{id}", false),
  },
};
writeFileSync(join(out, "prompts.json"), JSON.stringify(prompts, null, 1) + "\n");
console.log(`tools: ${tools.length}`);
