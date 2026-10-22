import {
  type AudienceInput,
  busyNotice,
  channelNameProblem,
  chatAudience,
  type InboxMessage,
  mentionsIn,
  parseChatTarget,
  type UnreadRow,
  wakeInput,
} from "./rules.ts";
import { expect, test } from "vite-plus/test";
import { checkCases, goldenCases } from "../testing/golden.ts";

test("the recorded cases", () => {
  const cases = goldenCases("channel");
  expect(new Set(cases.map((c) => c.fn)).size).toBe(6);
  const failed = checkCases(cases, (c) => {
    switch (c.fn) {
      case "mentionsIn":
        return mentionsIn(c.in as string);
      case "parseTarget": {
        // As Go writes it: a zero parent is left out.
        const t = parseChatTarget(c.in as string);
        return t?.kind === "thread" && t.parent === 0 ? { kind: "thread" } : (t ?? null);
      }
      case "channelNameProblem": {
        const i = c.in as { name: string; taken: string[] | null };
        return channelNameProblem(i.name, i.taken ?? []) || null;
      }
      case "audienceOf":
        return chatAudience(c.in as AudienceInput);
      case "wakeInput": {
        const i = c.in as { messages: InboxMessage[] | null; others: UnreadRow[] | null };
        return wakeInput(i.messages ?? [], i.others ?? []);
      }
      case "busyNotice":
        return busyNotice((c.in as UnreadRow[] | null) ?? []);
      default:
        throw new Error(`line ${c.line}: no rule ${c.fn}`);
    }
  });
  expect(failed).toEqual([]);
});
