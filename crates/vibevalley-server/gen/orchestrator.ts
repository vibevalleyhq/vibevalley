// Writes the orchestrator's model-facing words from apps/server
// (vp run protocol:rust runs it on crates/vibevalley-protocol/gen/prepare.sh's copy).
// tools.json: each tool the orchestrator holds in apps/server, in its
// order, as the model sees it (name, description, JSON Schema).
// prompts.json: the system prompt parts.

import { writeFileSync } from "node:fs";
import { join } from "node:path";

const VV = process.argv[2]!;
const out = process.argv[3]!;

const { schemas, toolName } = await import(`${VV}/apps/server/src/gateway/tool/schemas.ts`);
const { descriptions } = await import(`${VV}/apps/server/src/gateway/tool/prompts.ts`);
const P = await import(`${VV}/apps/server/src/modules/orchestrator/prompts.ts`);
const H = await import(`${VV}/apps/server/src/modules/session/prompts.ts`);

// tool.ts `orchestrator`, the modules VibeValley serves so far.
const ops = [
  "issue.list",
  "issue.get",
  "issue.create",
  "issue.update",
  "issue.status.update",
  "issue.comment.create",
  "issue.review",
  "issue.diff.get",
  "session.list",
  "session.stop",
  "channel.message.list",
  "channel.list",
  "channel.create",
  "channel.update",
  "repo.list",
  "cron.create",
  "cron.list",
  "cron.delete",
  "memory.search",
  "memory.create",
  "pkm.search",
  "pkm.page.get",
  "pkm.capture",
  "pkm.comment.suggest",
  "media.image.create",
  "media.job.get",
  "media.job.list",
  "media.job.cancel",
  "media.job.download",
  "library.item.list",
  "library.item.add",
  "artifact.list",
  "artifact.get",
  "artifact.content.get",
  "artifact.create",
  "artifact.version.create",
  "artifact.block.create",
  "artifact.block.update",
  "artifact.block.delete",
];

const tools = ops.map((op) => {
  if (!(op in schemas) || !(op in descriptions)) throw new Error(`no tool for ${op}`);
  return { op, name: toolName(op), description: descriptions[op], parameters: schemas[op] };
});
writeFileSync(join(out, "tools.json"), JSON.stringify(tools, null, 1) + "\n");

const prompts = {
  system: P.systemPrompt,
  agent: P.agentPrompt,
  voice: P.voiceNote,
  env: H.hostWords.envSection("{cwd}"),
  skills: H.hostWords.skillsSection("{skills}"),
  memory: H.hostWords.memorySection("{memory}"),
};
writeFileSync(join(out, "prompts.json"), JSON.stringify(prompts, null, 1) + "\n");
console.log(`tools: ${tools.length}`);
