import { describe, expect, it } from "vite-plus/test";

import type { ChatMessage, Channel } from "@vibevalley/protocol";

import { forOwner } from "@/inbox/away.ts";
import { checkCases, goldenCases } from "@/testing/golden.ts";

import { flushText, isPairing, ownerLine, plainText, shortId, splitText } from "./digest.ts";

describe("the connector's words", () => {
  it("are as recorded", () => {
    const failed = checkCases(goldenCases("connector"), (c) => {
      switch (c.fn) {
        case "plainText":
          return plainText(c.in as string);
        case "splitText": {
          const given = c.in as { text: string; max: number };
          return splitText(given.text, given.max);
        }
        case "flushText":
          return flushText((c.in as string[] | null) ?? []);
        case "isPairing": {
          const given = c.in as { Text?: string; text?: string; Code?: string; code?: string };
          return isPairing(given.Text ?? given.text ?? "", given.Code ?? given.code ?? "");
        }
        case "shortId":
          return shortId(c.in as string);
        case "ownerLine": {
          const given = c.in as { m: ChatMessage; where: Channel | null };
          return {
            line: ownerLine(given.m, given.where ?? undefined),
            forOwner: forOwner(given.m),
          };
        }
      }
      throw new Error(`unknown fn ${c.fn}`);
    });
    expect(failed).toEqual([]);
  });
});
