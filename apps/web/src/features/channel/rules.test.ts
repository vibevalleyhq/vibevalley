import { expect, test } from "vite-plus/test";
import type { Channel, WorkspaceState } from "@vibevalley/protocol";
import { orchestratorTyping } from "./rules";

const at = (id: string): Channel => ({ id, type: "channel", replies: 0, at: 0 });
const state = (orchestrator: WorkspaceState["orchestrator"], where?: string): WorkspaceState => ({
  call: "idle",
  orchestrator,
  ...(where ? { orchestratorChannel: where } : {}),
  sessions: [],
});

test("the orchestrator's dots show only in the channel it thinks or writes in", () => {
  expect(orchestratorTyping(state("thinking", "c1"), at("c1"))).toBe("thinking");
  expect(orchestratorTyping(state("speaking", "c1"), at("c1"))).toBe("speaking");
  expect(orchestratorTyping(state("thinking", "c1"), at("c2"))).toBeUndefined();
  expect(orchestratorTyping(state("thinking"), at("c1"))).toBeUndefined();
  expect(orchestratorTyping(state("listening", "c1"), at("c1"))).toBeUndefined();
  expect(orchestratorTyping(undefined, at("c1"))).toBeUndefined();
});
