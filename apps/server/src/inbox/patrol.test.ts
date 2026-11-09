import { describe, expect, it } from "vite-plus/test";

import { type ChatMessage, ownerId, type SpaceState } from "@vibevalley/protocol";
import { messageId } from "@vibevalley/protocol/schema";

import { emptySpaceState } from "#/core/core.ts";
import { checkCases, goldenCases } from "#/testing/golden.ts";

import { forOwner, inboxEntries } from "./items.ts";
import { emptyPatrol, type PatrolNote, patrolStep } from "./patrol.ts";

describe("the patrol", () => {
  // Every fifth round the farm is empty: what was hanging is forgotten.
  it("find for the patrol what was recorded", () => {
    const failed = checkCases(goldenCases("inbox"), (c) => {
      if (c.fn !== "patrol") throw new Error(`unknown fn ${c.fn}`);
      const given = c.in as { state: SpaceState; nows: number[] };
      let memory = emptyPatrol();
      return given.nows.map((now, r) => {
        let report: PatrolNote[];
        [report, memory] = patrolStep(r % 5 === 4 ? emptySpaceState() : given.state, now, memory);
        return {
          now,
          report: report.map((n) => ({ Key: n.key, Channel: n.channel ?? null, Text: n.text })),
          firstSeen: memory.firstSeen,
          reported: memory.reported,
        };
      });
    });
    expect(failed).toEqual([]);
  });

  it("gives a seen owner two hours before another reminder", () => {
    const at = 1_000;
    const message: ChatMessage = {
      id: messageId("seen-message"),
      number: 1,
      outcome: null,
      channel: "seen-channel",
      from: "w1",
      fromKind: "agent",
      fromRole: "worker",
      name: "帮工",
      kind: "chat",
      text: "请主人决定",
      mentions: [ownerId],
      spoken: false,
      at,
      revision: 1,
      reactions: [],
      attachments: [],
      embeds: [],
    };
    const state: SpaceState = {
      ...emptySpaceState(),
      chat: {
        channels: [
          {
            id: "seen-channel",
            type: "channel",
            default: true,
            name: "田头",
            category: "",
            description: "",
            title: "",
            at: 0,
            replies: 0,
            notify: "all",
            subjectKind: null,
          },
        ],
        ownerMentions: [{ message, channel: "seen-channel", address: "#田头:1" }],
      },
    };
    const mention = inboxEntries(state)[0]!;
    const now = at + 16 * 60_000;
    expect(patrolStep(state, now, emptyPatrol())[0].some((note) => note.key === mention.item.id)).toBe(true);
    expect(patrolStep(state, now, emptyPatrol(), { [mention.item.id]: now - 2 * 60_000 })[0]).toEqual([]);
  });
});

describe("what reaches the owner off the farm", () => {
  const said = (more: Partial<ChatMessage>): ChatMessage => ({
    id: messageId("m"),
    number: 1,
    channel: "c",
    from: "orchestrator",
    fromKind: "agent",
    fromRole: "orchestrator",
    name: "管家",
    kind: "chat",
    text: "好",
    at: 0,
    revision: 1,
    mentions: [],
    spoken: false,
    reactions: [],
    attachments: [],
    embeds: [],
    ...more,
    outcome: more.outcome ?? null,
  });
  it("follows how much the place it is said in counts", () => {
    const named = said({ mentions: [ownerId] });
    expect([forOwner(said({})), forOwner(said({}), "mentions"), forOwner(named, "mentions"), forOwner(named, "none")]).toEqual([true, false, true, false]);
  });
});
