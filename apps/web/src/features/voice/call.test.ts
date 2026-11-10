import { afterEach, expect, it, vi } from "vite-plus/test";

import { VoiceCall } from "./call.ts";
import type { VoiceTurn } from "./contract.ts";

interface Line {
  phase: "idle" | "live";
  turns: VoiceTurn<"user" | "moss">[];
  changed: () => void;
  end: () => void;
}
const lines = vi.hoisted((): Line[] => []);
const service = vi.hoisted(() => ({
  grant: vi.fn(async () => ({ appId: "moss", channel: "call", uid: "1", token: "" })),
  start: vi.fn(async () => ({ agentId: "call-1" })),
  stop: vi.fn<(input: { agentId: string }) => Promise<void>>().mockResolvedValue(undefined),
  hear: vi.fn<(input: { agentId: string; text: string }) => Promise<void>>().mockResolvedValue(undefined),
  say: vi.fn<(input: { agentId: string; text: string }) => Promise<void>>().mockResolvedValue(undefined),
}));
vi.mock("#/infra/api.ts", () => ({
  api: { voice: { grant: { create: service.grant }, call: { start: service.start, stop: service.stop, hear: service.hear, say: service.say } } },
  reasonOf: String,
}));
vi.mock("#/infra/host.ts", () => ({ currentHost: () => ({}) }));
vi.mock("#/state/prefs.ts", () => ({ prefsNow: () => ({}) }));
vi.mock("./moss-line.ts", () => ({
  MossLine: class implements Line {
    phase: "idle" | "live" = "idle";
    turns: VoiceTurn<"user" | "moss">[] = [];
    micLevel = 0;
    mossLevel = 0;
    readonly listeners = new Set<() => void>();
    constructor() {
      lines.push(this);
    }
    subscribe(f: () => void) {
      this.listeners.add(f);
      return () => this.listeners.delete(f);
    }
    changed() {
      for (const f of this.listeners) f();
    }
    async start() {
      this.phase = "live";
      this.changed();
    }
    end() {
      if (this.phase === "idle") return;
      this.phase = "idle";
      this.changed();
    }
  },
}));

afterEach(() => {
  for (const line of lines.splice(0)) line.end();
  vi.clearAllMocks();
});

it("regression: evicting old Live transcripts does not reuse completed caption identities", async () => {
  const call = new VoiceCall();
  try {
    await call.start();
    const line = lines[0]!;
    line.turns = Array.from({ length: 200 }, (_, i) => ({ who: "user", key: String(i), text: `Request ${i}`, done: true }));
    line.changed();
    line.turns = [...line.turns.slice(1), { who: "user", key: "200", text: "Request 200", done: true }];
    line.changed();
    line.turns = [...line.turns.slice(1), { who: "moss", key: "200", text: "Answer 200", done: true }];
    line.changed();
    line.changed();
    expect(service.hear.mock.calls.map(([input]) => input.text)).toEqual(Array.from({ length: 201 }, (_, i) => `Request ${i}`));
    expect(service.say.mock.calls.map(([input]) => input.text)).toEqual(["Answer 200"]);
  } finally {
    await call.end();
  }
});

it("regression: assigning a Live turn key preserves its unfinished caption", async () => {
  const call = new VoiceCall();
  try {
    await call.start();
    const line = lines[0]!;
    line.turns = [{ who: "user", key: "", text: "A partial", done: false }];
    line.changed();
    line.turns = [{ who: "user", key: "named", text: "A complete request", done: true }];
    line.changed();
    expect(call.turns.map(({ text, done }) => ({ text, done }))).toEqual([{ text: "A complete request", done: true }]);
    expect(service.hear.mock.calls.map(([input]) => input.text)).toEqual(["A complete request"]);
  } finally {
    await call.end();
  }
});

it("regression: a terminal Live line releases the registered call and permits a fresh call", async () => {
  const call = new VoiceCall();
  try {
    await call.start();
    lines[0]!.end();
    await vi.waitFor(() => expect(call.phase).toBe("idle"));
    expect(service.stop).toHaveBeenCalledExactlyOnceWith({ agentId: "call-1" });
    await call.start();
    expect(call.phase).toBe("live");
    expect(service.start).toHaveBeenCalledTimes(2);
  } finally {
    await call.end();
  }
});

it("regression: closing Live during call registration releases a late server call", async () => {
  let complete: (() => void) | undefined;
  const registered = new Promise<{ agentId: string }>((resolve) => {
    complete = () => resolve({ agentId: "late-call" });
  });
  service.start.mockReturnValueOnce(registered);
  const call = new VoiceCall();
  const starting = call.start();
  try {
    await vi.waitFor(() => expect(service.start).toHaveBeenCalledTimes(1));
    lines[0]!.end();
    complete?.();
    await starting;
    await vi.waitFor(() => expect(call.phase).toBe("idle"));
    expect(service.stop).toHaveBeenCalledExactlyOnceWith({ agentId: "late-call" });
  } finally {
    complete?.();
    await call.end();
  }
});
