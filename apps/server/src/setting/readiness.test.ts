import { describe, expect, it } from "vite-plus/test";

import { emptyProviders, type ProviderSettings } from "./provider.ts";
import { type ReadinessInput, readinessOf } from "./readiness.ts";

const moss = { id: "moss", name: "MOSS", adapter: "moss" as const, enabled: true, key: "k" };
const bound = { connection: "moss", model: "m" };
const providers = (change: Partial<ProviderSettings> = {}): ProviderSettings => ({ ...emptyProviders, connections: [moss], ...change });
const input = (change: Partial<ReadinessInput> = {}): ReadinessInput => ({
  providers: providers(),
  deepseekKey: true,
  agora: true,
  dictation: { via: "moss", url: "" },
  callAnswer: "orchestrator",
  ...change,
});

describe("what each feature lacks", () => {
  it("a MOSS use lacks an account first, then its binding, then the account turned on, then its key", () => {
    expect(readinessOf(input({ providers: emptyProviders })).image).toEqual({ ready: false, missing: "mossAccount" });
    expect(readinessOf(input()).image).toEqual({ ready: false, missing: "binding" });
    expect(readinessOf(input({ providers: providers({ image: { connection: "gone", model: "m" } }) })).image).toEqual({ ready: false, missing: "binding" });
    expect(readinessOf(input({ providers: providers({ image: bound, connections: [{ ...moss, enabled: false }] }) })).image).toEqual({
      ready: false,
      missing: "mossOff",
    });
    expect(readinessOf(input({ providers: providers({ image: bound, connections: [{ ...moss, key: "" }] }) })).image).toEqual({
      ready: false,
      missing: "mossKey",
    });
    expect(readinessOf(input({ providers: providers({ image: bound }) })).image).toEqual({ ready: true });
  });

  it("the orchestrator needs the DeepSeek key; dictation its own address or its MOSS use", () => {
    expect(readinessOf(input({ deepseekKey: false })).orchestrator).toEqual({ ready: false, missing: "deepseekKey" });
    expect(readinessOf(input({ dictation: { via: "own", url: "" } })).dictation).toEqual({ ready: false, missing: "dictationUrl" });
    expect(readinessOf(input({ dictation: { via: "own", url: "http://127.0.0.1:9000" } })).dictation).toEqual({ ready: true });
    expect(readinessOf(input()).dictation).toEqual({ ready: false, missing: "binding" });
  });

  it("a call answered by MOSS Live needs what Live needs; any other answer needs Agora's credentials", () => {
    expect(readinessOf(input({ callAnswer: "moss" })).call).toEqual({ ready: false, missing: "binding" });
    expect(readinessOf(input({ callAnswer: "moss", agora: false, providers: providers({ live: bound }) })).call).toEqual({ ready: true });
    expect(readinessOf(input({ agora: false })).call).toEqual({ ready: false, missing: "agora" });
  });
});
