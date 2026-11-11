import { afterEach, expect, it, vi } from "vite-plus/test";

import { MossLine } from "./moss-line.ts";
import { openMossRelayBridge } from "./moss-worker.ts";

vi.mock("./moss-worker.ts", () => ({
  openMossRelayBridge: vi.fn(() => ({
    sendText: vi.fn(),
    sendBinary: vi.fn(),
    enqueuePlayback: vi.fn(),
    attachWorkletPorts: vi.fn(),
    cutPlayback: vi.fn(),
    bufferedAmount: () => 0,
    measure: vi.fn(),
    setMic: vi.fn(),
    close: vi.fn(),
  })),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it("regression: a playground and call cannot own two connecting Live relays", async () => {
  vi.stubGlobal("location", { href: "http://127.0.0.1/settings/moss", hostname: "127.0.0.1" });
  vi.stubGlobal("document", new EventTarget());
  vi.stubGlobal("window", Object.assign(new EventTarget(), { setInterval: () => 0 }));
  const messages = { closed: () => "closed", noMic: () => "permission", formatError: String };
  const playground = new MossLine(messages);
  const call = new MossLine(messages);
  try {
    await playground.start({ persona: "", instructions: "" });
    await call.start({ persona: "", instructions: "" });
    expect(playground.phase).toBe("connecting");
    expect(call.phase).toBe("idle");
    expect(call.problem).toBeTruthy();
    expect(openMossRelayBridge).toHaveBeenCalledTimes(1);
    playground.end();
    await call.start({ persona: "", instructions: "" });
    expect(call.phase).toBe("connecting");
    expect(openMossRelayBridge).toHaveBeenCalledTimes(2);
  } finally {
    playground.end();
    call.end();
  }
});
