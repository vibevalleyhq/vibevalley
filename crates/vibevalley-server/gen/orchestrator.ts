// Writes the orchestrator's model-facing words from apps/server
// (vp run protocol:rust runs it on crates/vibevalley-protocol/gen/prepare.sh's copy).
// prompts.json: the system prompt parts. The tools' words are the Rust
// server's own (assets/tools).

import { writeFileSync } from "node:fs";
import { join } from "node:path";

const VV = process.argv[2]!;
const out = process.argv[3]!;

const P = await import(`${VV}/apps/server/src/modules/orchestrator/prompts.ts`);
const H = await import(`${VV}/apps/server/src/modules/session/prompts.ts`);

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
  // A helper talking in a channel without an issue (channelRules).
  talk: H.channelRules("{cwd}", "{channel}", "{id}"),
};
writeFileSync(join(out, "prompts.json"), JSON.stringify(prompts, null, 1) + "\n");
