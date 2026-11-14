import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vite-plus/test";

import { toolName } from "#/gateway/tool/schemas.ts";

import { orchestratorSkills } from "./orchestrator.ts";

describe("the orchestrator's own skills", () => {
  it("the imagegen skill ships with the server and names the image tool the orchestrator has", async () => {
    const text = await readFile(`${orchestratorSkills}/imagegen/SKILL.md`, "utf8");
    expect(text).toMatch(/^---\nname: imagegen\ndescription: \S/u);
    // The skill tells the model a tool by the name it is given: a renamed endpoint must take the skill with it.
    expect(text).toContain(toolName("media.image.create"));
  });

  it("the slides skill ships with the server, names the artifact tool and the display its runtime lays out", async () => {
    const text = await readFile(`${orchestratorSkills}/slides/SKILL.md`, "utf8");
    expect(text).toMatch(/^---\nname: slides\ndescription: \S/u);
    expect(text).toContain(toolName("artifact.create"));
    expect(text).toMatch(/display` 填 `slides`/u);
  });
});
