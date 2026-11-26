import "./polyfill";
import { host } from "nsh";
import { afterEach, describe, expect, test } from "nsh/test";

import { farmCallsSchema, readFarmPhoneParams } from "./hostParams";

const origParams = Object.getOwnPropertyDescriptor(host, "params");

function makeValidInboxItem(id: string, who = "Helper Fox") {
  return {
    id,
    kind: "review",
    from: { kind: "session", id: "sess-1", name: who, agent: "builder" },
    who,
    text: `Check ${id}`,
    at: 1_764_000_000_000,
    target: { kind: "issue", id: "issue-1" },
    words: {
      label: "Review",
      title: `Review ${id}`,
      body: `Body for ${id}`,
      tray: `Tray ${id}`,
    },
  };
}

afterEach(() => {
  if (origParams) Object.defineProperty(host, "params", origParams);
});

describe("infra/hostParams farmCallsSchema", () => {
  test("preserves open state and valid InboxItems when individual items or ringing fail Zod validation", () => {
    const validMissed = makeValidInboxItem("missed-1", "Builder Bear");
    const validLog = makeValidInboxItem("log-1", "Verifier Owl");

    const parsed = farmCallsSchema.parse({
      open: true,
      narrow: "invalid-bool",
      ringing: { id: "bad-ring", kind: "unknown_kind" },
      missed: [validMissed, { id: "bad-missed", who: 123 }, null],
      log: [
        { call: validLog, answered: true },
        { call: { id: "bad-log" }, answered: false },
        { call: validMissed, answered: "not-a-bool" },
      ],
    });

    expect(parsed.open).toBe(true);
    expect(parsed.narrow).toBe(false);
    expect(parsed.ringing).toBeNull();
    expect(parsed.missed).toHaveLength(1);
    expect(parsed.missed[0]?.id).toBe("missed-1");
    expect(parsed.log).toHaveLength(1);
    expect(parsed.log[0]?.call.id).toBe("log-1");
    expect(parsed.log[0]?.answered).toBe(true);
  });

  test("readFarmPhoneParams keeps valid calls even when missed/log are non-arrays or partial", () => {
    const validRinging = makeValidInboxItem("ring-1", "Orchestrator");
    Object.defineProperty(host, "params", {
      configurable: true,
      enumerable: true,
      writable: true,
      value: {
        unfolded: true,
        calls: {
          open: true,
          ringing: validRinging,
          missed: "corrupted",
          log: 42,
        },
      },
    });

    const params = readFarmPhoneParams();
    expect(params.unfolded).toBe(true);
    expect(params.calls.open).toBe(true);
    expect(params.calls.narrow).toBe(false);
    expect(params.calls.ringing?.id).toBe("ring-1");
    expect(params.calls.missed).toEqual([]);
    expect(params.calls.log).toEqual([]);
  });

  test("readFarmPhoneParams falls back to closed emptyCalls when calls itself is not an object", () => {
    Object.defineProperty(host, "params", {
      configurable: true,
      enumerable: true,
      writable: true,
      value: { unfolded: false, calls: "corrupted" },
    });

    const params = readFarmPhoneParams();
    expect(params).toEqual({
      unfolded: false,
      calls: { open: false, narrow: false, ringing: null, missed: [], log: [] },
    });
  });
});
