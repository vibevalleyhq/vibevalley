import "../../infra/polyfill";
import { expect, open, test } from "nsh/test";

import { type ArtifactId, type BlockId, type Suggestion, type SuggestionId } from "@vibevalley/protocol";

import { fakeHost } from "../../app/fakeHost";
import { responses as artifactResponses } from "../../fixtures/artifacts";
import { SCENARIO_NOW, scenarios } from "../../fixtures/scenarios";

test("BlocksView keeps block editing, suggestion lookup, and lifted keymaps responsive", async () => {
  const aid = "art-mine" as ArtifactId;
  const snapFn = artifactResponses["artifact.block.list"] as (p: { id: string }) => { blocks: Array<{ id: BlockId }> };
  const blockId1 = snapFn({ id: aid }).blocks[0]?.id ?? ("art-mine-b11" as BlockId);

  const openSuggestion: Suggestion = {
    id: "sug-resp-1" as SuggestionId,
    artifactId: aid,
    blockId: blockId1,
    author: "w1",
    baseRev: 0,
    change: { text: [{ t: "目标与核心范围", marks: {} }] },
    status: "open",
    createdAt: SCENARIO_NOW,
    cursorStart: "c:start",
    cursorEnd: "c:end",
    startOffset: 0,
    endOffset: 2,
  };

  const fake = fakeHost(scenarios.typical, { route: "/artifacts/art-mine" });
  for (const [op, handler] of Object.entries(artifactResponses)) {
    fake.respond(op, handler);
  }
  let resolved: { op: string; id: string } | undefined;
  fake.respond("artifact.suggestion.accept", (payload: { suggestion: string }) => {
    resolved = { op: "accept", id: payload.suggestion };
    return { ...openSuggestion, id: payload.suggestion as SuggestionId, status: "accepted" };
  });

  const app = await open("../../app/main.tsx", {
    width: 1200,
    height: 800,
    colorScheme: "light",
    platform: "macos",
    clock: { time: SCENARIO_NOW },
    host: fake.options,
  });
  await fake.pumpUntil(app, () => app.count("id:artifact-block-text") > 0);

  // Enter edit mode on the first block and type mid-line with lifted keymap predicates.
  await app.press("id:artifact-block-text >> nth=0");
  await fake.pumpUntil(app, () => app.count("id:artifact-block-field") > 0);
  await app.type("id:artifact-block-field", "Updated outline point");
  await fake.pump(app);
  expect(app.value("id:artifact-block-field")).toContain("Updated outline point");

  await fake.emit(app, "artifact.suggestion.follow", {
    _tag: "Suggestions",
    suggestions: [openSuggestion],
  });
  await fake.pumpUntil(app, () => app.count("id:artifact-inline-suggestion") === 1);

  await app.keyboard.press("tab");
  await fake.pumpUntil(app, () => resolved?.op === "accept");
  expect(resolved).toEqual({ op: "accept", id: "sug-resp-1" });
});
