import { NodeFileSystem } from "@effect/platform-node";
import { expect, layer } from "@effect/vitest";
import { Effect, FileSystem } from "effect";

import { toolName } from "#/tool/schemas.ts";

import { orchestratorSkills } from "./orchestrator.ts";

layer(NodeFileSystem.layer)("the orchestrator's own skills", (it) => {
  it.effect("the imagegen skill ships with the server and names the image tool the orchestrator has", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const text = yield* fs.readFileString(`${orchestratorSkills}/imagegen/SKILL.md`);
      expect(text).toMatch(/^---\nname: imagegen\ndescription: \S/u);
      // The skill tells the model a tool by the name it is given: a renamed endpoint must take the skill with it.
      expect(text).toContain(toolName("media.image.create"));
    }),
  );
});
