import { describe, expect, it } from "vite-plus/test";

import { type ChatMessage, userId, type SpaceState } from "@vibevalley/protocol";
import { messageId } from "@vibevalley/protocol/schema";

import { emptySpaceState } from "#/core/core.ts";

import { forUser, inboxEntries } from "./items.ts";
import { emptyPatrol, patrolStep } from "./patrol.ts";

describe("the patrol", () => {
  it("gives a seen user two hours before another reminder", () => {
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
      text: "请用户决定",
      mentions: [userId],
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
        userMentions: [{ message, channel: "seen-channel", address: "#田头:1" }],
      },
    };
    const mention = inboxEntries(state)[0]!;
    const now = at + 16 * 60_000;
    expect(patrolStep(state, now, emptyPatrol())[0].some((note) => note.key === mention.item.id)).toBe(true);
    expect(patrolStep(state, now, emptyPatrol(), { [mention.item.id]: now - 2 * 60_000 })[0]).toEqual([]);
  });
});

describe("what reaches the user off the farm", () => {
  const said = (more: Partial<ChatMessage>): ChatMessage => ({
    id: messageId("m"),
    number: 1,
    channel: "c",
    from: "orchestrator",
    fromKind: "agent",
    fromRole: "orchestrator",
    name: "助手",
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
    const named = said({ mentions: [userId] });
    expect([forUser(said({})), forUser(said({}), "mentions"), forUser(named, "mentions"), forUser(named, "none")]).toEqual([true, false, true, false]);
  });
});
