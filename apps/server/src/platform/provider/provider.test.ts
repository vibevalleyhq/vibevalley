import { describe, expect, test } from "vite-plus/test";

import type { ProviderUpdate } from "@vibevalley/protocol";
import { ApiError, BizCode, endpoints } from "@vibevalley/protocol/api";

import { providerHandlers } from "#/gateway/http/handlers/provider.ts";
import { keptLog } from "#/infra/log.ts";
import { wallTime } from "#/infra/time.ts";
import { makeSetting } from "#/platform/setting/setting.ts";
import { testConfig } from "#/testing/layers.ts";

import { type Account, type Dictation, makeProvider } from "./provider.ts";
import type { ImageRequest } from "./vendors.ts";

const notIn = (value: unknown, secret: string) => {
  expect(JSON.stringify(value)).not.toContain(secret);
};
/** What p failed with; the test fails when it did not. */
const failure = (p: Promise<unknown>) =>
  p.then(
    () => expect.unreachable("it was not refused"),
    (e: unknown) => e,
  );
/** A refusal by the providers. */
const refusedBy = async (p: Promise<unknown>) => {
  const e = await failure(p);
  expect(e).toBeInstanceOf(ApiError);
  expect(e).toMatchObject({ bizCode: BizCode.ProviderRefused });
  return e instanceof ApiError ? e : expect.unreachable(String(e));
};

/** Every request the Provider's calls have sent, last one last: its key and address. */
const sent: { readonly key: string; readonly url: string }[] = [];
/** A vendor that answers each request with answer. */
const vendor =
  (answer: (request: Request) => Response | Promise<Response>): typeof fetch =>
  async (input, init) => {
    const request = new Request(input, init);
    sent.push({ key: request.headers.get("authorization") ?? "", url: request.url });
    return answer(request);
  };
/** The settings and providers over a fresh home, the vendor answering as http does; closed when the test is done. */
const farmOver = async (http: typeof fetch) => {
  const log = keptLog();
  const setting = await makeSetting({ config: testConfig(), clock: wallTime, log });
  const provider = await makeProvider({ setting, fetch: http, clock: wallTime, log });
  return { setting, provider, log, [Symbol.asyncDispose]: () => setting.close() };
};
/** The key a call sent, run once whatever the vendor answers. */
const keyUsedBy = async (call: () => Promise<unknown>) => {
  await call().catch(() => "whatever the vendor answers");
  return sent.at(-1)?.key ?? "";
};
/** One recording transcribed by a dictation. */
const dictated = async (dictation: Dictation) => {
  const model = await dictation.transcriber("wav");
  return model.doGenerate({ audio: new Uint8Array([1]), mediaType: "audio/wav" });
};
/** The key a bound account's or a dictation's calls send. */
const keyOf = (bound: Account | Dictation) => keyUsedBy(() => ("tasks" in bound ? bound.tasks.get("task") : dictated(bound)));
/** The key the use's binding sends now. */
const keyNow = async (bound: Promise<Account | Dictation>) => keyOf(await bound);
const configured = (key = "test-first-key"): ProviderUpdate => ({
  revision: 0,
  connections: [{ id: "moss", name: "MOSS", adapter: "moss", enabled: true, key }],
  dictation: { connection: "moss", model: "moss-transcribe-1.0" },
  image: null,
  understanding: null,
  speech: null,
  speakers: null,
  voiceDesign: null,
  transcription: null,
  vision: null,
  live: { connection: "moss", model: "moss-live-1.0" },
});

const drawing: ImageRequest = { prompt: "A quiet farm", width: 256, height: 256, enhance: false, watermark: true };
/** A vendor that answers every call 503. */
const unavailable = vendor(() => new Response("", { status: 503 }));
/** A vendor that must not be called. */
const untouched = (why: string) =>
  vendor(() => {
    throw new Error(why);
  });

test.each(["moss-transcribe-1.0-2026-07-22", "moss-transcribe-diarize-pro-2026-07-03"])(
  "regression: dictation accepts the explicit snapshot %s without substituting its stable alias",
  async (model) => {
    await using farm = await farmOver(untouched("Selecting a snapshot must not invoke the vendor"));
    const { provider } = farm;
    await provider.update({ ...configured(), dictation: { connection: "moss", model } });
    const dictation2 = await provider.dictation();
    expect(dictation2.model).toBe(model);
    const key = await keyOf(dictation2);
    expect(key).toBe("Bearer test-first-key");
    expect(sent.at(-1)?.url).toBe("https://api.mosi.cn/v1/audio/transcriptions");
  },
);

test.each(["moss-vl-1.0", "moss-vl-1.0-2026-07-08"])("understanding binding %s is independent, private and frozen per call", async (model) => {
  await using farm = await farmOver(unavailable);
  const { provider } = farm;
  await refusedBy(provider.understanding());
  const vision = { id: "vision", name: "Vision", adapter: "moss", enabled: true, key: "vision-private-key" } as const;
  const config: ProviderUpdate = { ...configured(), connections: [...configured().connections, vision], understanding: { connection: "vision", model } };
  const saved = await provider.update(config);
  expect(saved.understanding).toEqual({ connection: "vision", model });
  expect(saved.understandingModels).toEqual(["moss-vl-1.0", "moss-vl-1.0-2026-07-08"]);
  notIn(saved, "vision-private-key");
  const frozen = await provider.understanding();
  expect(frozen).toMatchObject({ connection: "vision", revision: 1, model });
  const frozenKey = await keyOf(frozen);
  expect(frozenKey).toBe("Bearer vision-private-key");
  notIn(frozen, "vision-private-key");
  const liveKey1 = await keyNow(provider.live());
  expect(liveKey1).toBe("Bearer test-first-key");
  const dictationKey2 = await keyNow(provider.dictation());
  expect(dictationKey2).toBe("Bearer test-first-key");
  if (saved.understanding) saved.understanding.model = "changed-by-caller";
  expect(provider.status().understanding?.model).toBe(model);
  for (const connections of [
    configured().connections,
    [...configured().connections, { ...vision, enabled: false }],
    [...configured().connections, { ...vision, key: null }],
  ]) {
    await refusedBy(provider.update({ ...config, revision: 1, connections }));
    expect(provider.status().revision).toBe(1);
  }
  await provider.update({ ...config, revision: 1, connections: [...configured().connections, { ...vision, key: "rotated-vision-key" }] });
  const rotated = await provider.understanding();
  const keys = [await keyOf(rotated), await keyOf(frozen)];
  expect(keys).toEqual(["Bearer rotated-vision-key", "Bearer vision-private-key"]);
  await provider.update({ ...config, revision: 2, understanding: null });
  await refusedBy(provider.understanding());
});

test("cleanup resolves the original connection rather than the current default binding", async () => {
  await using farm = await farmOver(unavailable);
  const { provider } = farm;
  const config: ProviderUpdate = {
    ...configured(),
    dictation: null,
    live: null,
    connections: [...configured().connections, { id: "other", name: "Other", adapter: "moss", enabled: true, key: "other-key" }],
    understanding: { connection: "other", model: "moss-vl-1.0" },
  };
  await provider.update(config);
  const original = await provider.account({ connection: "moss", model: "" });
  expect(original).toMatchObject({ connection: "moss", revision: 1 });
  const originalKey = await keyOf(original);
  expect(originalKey).toBe("Bearer test-first-key");
  expect((await provider.understanding()).connection).toBe("other");
  await provider.update({
    ...config,
    revision: 1,
    connections: config.connections.map((connection) => (connection.id === "moss" ? { ...connection, enabled: false } : connection)),
  });
  await refusedBy(provider.account({ connection: "moss", model: "" }));
  await refusedBy(provider.account({ connection: "missing", model: "" }));
  const keptKey = await keyOf(original);
  expect(keptKey).toBe("Bearer test-first-key");
});

const catalog = { object: "list", data: [{ id: "unknown-model", object: "model", created: 1, owned_by: "MOSS" }] };
const http = vendor(() => Response.json(catalog));

test("connections and uses share credentials; replacing and clearing observe revisions", async () => {
  const keys: (string | null)[] = [];
  // Only the model catalog's requests: the others here are the test asking which key a binding sends.
  const capture = vendor((request) => {
    if (request.url.endsWith("/models")) keys.push(request.headers.get("authorization"));
    return Response.json(catalog);
  });
  await using farm = await farmOver(capture);
  const { provider, setting } = farm;
  const api = providerHandlers({ provider });
  await refusedBy(api["provider.model.list"]({ connection: "moss", revision: 0 }));
  expect(keys).toEqual([]);
  const saved = await api["provider.update"](configured());
  expect(saved.connections[0]?.key).toEqual({ source: "settings", hint: "…-key" });
  notIn(saved, "test-first-key");
  expect(setting.status()).toMatchObject({ readiness: { live: { ready: true }, dictation: { ready: true } } });
  const liveKey3 = await keyNow(provider.live());
  expect(liveKey3).toBe("Bearer test-first-key");
  const dictation2 = await provider.dictation();
  expect(dictation2.model).toBe("moss-transcribe-1.0");
  const dictationKey = await keyOf(dictation2);
  expect(dictationKey).toBe("Bearer test-first-key");
  expect(sent.at(-1)?.url).toBe("https://api.mosi.cn/v1/audio/transcriptions");
  const modelList = await api["provider.model.list"]({ connection: "moss", revision: 1 });
  expect(modelList).toEqual({
    connection: "moss",
    revision: 1,
    models: [{ id: "unknown-model", owner: "MOSS" }],
  });
  await provider.update({ ...configured("test-second-key"), revision: 1 });
  await provider.models({ connection: "moss", revision: 2 });
  expect(keys).toEqual(["Bearer test-first-key", "Bearer test-second-key"]);
  const cleared = await provider.update({
    revision: 2,
    connections: [{ id: "moss", name: "MOSS", adapter: "moss", enabled: true, key: null }],
    dictation: null,
    image: null,
    understanding: null,
    speech: null,
    speakers: null,
    voiceDesign: null,
    transcription: null,
    vision: null,
    live: null,
  });
  expect(cleared.connections[0]?.key).toEqual({ source: null });
  await refusedBy(provider.live());
  expect(setting.status()).toMatchObject({ readiness: { live: { ready: false, missing: "binding" }, dictation: { ready: false, missing: "binding" } } });
  await refusedBy(provider.models({ connection: "moss", revision: 3 }));
  expect(keys).toHaveLength(2);
  for (const endpoint of endpoints.filter((row) => row.op.startsWith("provider."))) expect(endpoint.can).toEqual(["user"]);
});

test("deletion, disabling and clearing require explicit unbinding and unsupported models are refused", async () => {
  await using farm = await farmOver(http);
  const { provider } = farm;
  await provider.update(configured());
  const kept = { id: "moss", name: "renamed", adapter: "moss", enabled: true } as const;
  for (const connections of [[], [{ ...kept, enabled: false }], [{ ...kept, key: null }]]) {
    await refusedBy(provider.update({ ...configured(), revision: 1, connections }));
    expect(provider.status().revision).toBe(1);
  }
  await refusedBy(provider.update({ ...configured(), revision: 1, dictation: { connection: "moss", model: "unknown-model" } }));
  await provider.update({ ...configured(), revision: 1, connections: [kept] });
  const liveKey4 = await keyNow(provider.live());
  expect(liveKey4).toBe("Bearer test-first-key");
  expect(provider.status().connections[0]?.name).toBe("renamed");
  await provider.update({
    ...configured(),
    revision: 2,
    connections: [],
    dictation: null,
    live: null,
  });
  expect(provider.status().connections).toEqual([]);
});

test("stale updates cannot overwrite another writer and general settings saves do not lose provider changes", async () => {
  await using farm = await farmOver(http);
  const { provider, setting } = farm;
  const results = await Promise.all(
    [configured("first-key"), configured("second-key")].map((input) =>
      provider.update(input).then(
        () => "saved",
        () => "refused",
      ),
    ),
  );
  expect(results.toSorted()).toEqual(["refused", "saved"]);
  expect(provider.status().revision).toBe(1);
  await Promise.all([provider.update({ ...configured("third-key"), revision: 1 }), setting.save({ deepseekApiKey: "test-deepseek" })]);
  const liveKey5 = await keyNow(provider.live());
  expect(liveKey5).toBe("Bearer third-key");
  const deepseek = setting.deepseekApiKey();
  expect(deepseek === undefined ? undefined : deepseek.reveal()).toBe("test-deepseek");
});

test("discovery rejects an old revision both before and after an in-flight query", async () => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let calls = 0;
  const delayed = vendor(async () => {
    calls++;
    started.resolve();
    await release.promise;
    return Response.json(catalog);
  });
  await using farm = await farmOver(delayed);
  const { provider } = farm;
  await provider.update(configured());
  await refusedBy(provider.models({ connection: "moss", revision: 0 }));
  expect(calls).toBe(0);
  const pending = failure(provider.models({ connection: "moss", revision: 1 }));
  await started.promise;
  await provider.update({ ...configured("replacement"), revision: 1 });
  release.resolve();
  const pending2 = await pending;
  expect(pending2).toMatchObject({ name: "ApiError", bizCode: BizCode.ProviderRefused });
  expect(calls).toBe(1);
});

test("each use resolves its own account without key fallback", async () => {
  await using farm = await farmOver(http);
  const { provider } = farm;
  await provider.update({
    ...configured("dictation-key"),
    connections: [
      { id: "moss", name: "dictation", adapter: "moss", enabled: true, key: "dictation-key" },
      { id: "live", name: "live", adapter: "moss", enabled: true, key: "live-key" },
    ],
    live: { connection: "live", model: "moss-live-1.0" },
  });
  const liveKey6 = await keyNow(provider.live());
  expect(liveKey6).toBe("Bearer live-key");
  const dictationKey7 = await keyNow(provider.dictation());
  expect(dictationKey7).toBe("Bearer dictation-key");
});

test.each(["moss-image-base-1.0", "moss-image-sft-1.0", "moss-image-base-1.0-2026-10-09", "moss-image-sft-1.0-2026-10-09"])(
  "image binding %s saves and resolves without making any network request",
  async (model) => {
    await using farm = await farmOver(untouched("Saving or resolving must not call the provider"));
    const { provider } = farm;
    await refusedBy(provider.image(drawing));
    const saved = await provider.update({ ...configured(), image: { connection: "moss", model } });
    expect(saved.image).toEqual({ connection: "moss", model });
    expect(saved.imageModels).toContain(model);
    notIn(saved, "test-first-key");
    const image2 = await provider.image(drawing);
    expect(image2).toMatchObject({ connection: "moss", revision: 1, model });
    if (saved.image) saved.image.model = "changed-by-caller";
    saved.imageModels.length = 0;
    expect(provider.status().image?.model).toBe(model);
    expect(provider.status().imageModels).toHaveLength(4);
  },
);

test("image references protect their account, allow atomic rebinding, and freeze credentials for a started task", async () => {
  await using farm = await farmOver(unavailable);
  const { provider } = farm;
  const first = configured().connections[0];
  if (!first) throw new Error("Missing test connection");
  const image = { id: "image", name: "Images", adapter: "moss", enabled: true, key: "test-image-key" } as const;
  const config: ProviderUpdate = { ...configured(), connections: [first, image], image: { connection: "image", model: "moss-image-sft-1.0" } };
  await provider.update(config);
  const frozen = await provider.image(drawing);
  const frozenKey = await keyUsedBy(() => frozen.run());
  expect(frozenKey).toBe("Bearer test-image-key");
  const liveKey8 = await keyNow(provider.live());
  expect(liveKey8).toBe("Bearer test-first-key");
  const dictationKey9 = await keyNow(provider.dictation());
  expect(dictationKey9).toBe("Bearer test-first-key");
  for (const connections of [[first], [first, { ...image, enabled: false }], [first, { ...image, key: null }]]) {
    await refusedBy(provider.update({ ...config, revision: 1, connections }));
    expect(provider.status().revision).toBe(1);
  }
  await provider.update({ ...configured("rotated-key"), revision: 1, image: { connection: "moss", model: "moss-image-sft-1.0-2026-10-09" } });
  const image2 = await provider.image(drawing);
  expect(image2).toMatchObject({ connection: "moss", revision: 2, model: "moss-image-sft-1.0-2026-10-09" });
  expect(frozen).toMatchObject({ connection: "image", revision: 1, model: "moss-image-sft-1.0" });
  // A started task keeps the key it was asked with, whatever the account has now.
  const keys = [await keyUsedBy(() => image2.run()), await keyUsedBy(() => frozen.run())];
  expect(keys).toEqual(["Bearer rotated-key", "Bearer test-image-key"]);
  await provider.update({ ...configured("rotated-key"), revision: 2 });
  await refusedBy(provider.image(drawing));
  const liveKey10 = await keyNow(provider.live());
  expect(liveKey10).toBe("Bearer rotated-key");
});

test("model discovery distinguishes account errors without returning upstream secrets", async () => {
  let status = 401;
  const failed = vendor(() => new Response("test-private-key", { status }));
  await using farm = await farmOver(failed);
  const { provider } = farm;
  await provider.update(configured("test-private-key"));
  const reasons: string[] = [];
  for (const code of [401, 403, 429, 503]) {
    status = code;
    const error = await refusedBy(provider.models({ connection: "moss", revision: 1 }));
    notIn(error, "test-private-key");
    reasons.push(error.reason);
  }
  expect(new Set(reasons).size).toBe(4);
});

test.each([
  { use: "speakers", model: "moss-ttsd-1.0" },
  { use: "voiceDesign", model: "moss-voice-generator-1.0" },
  { use: "transcription", model: "moss-transcribe-diarize-pro" },
  { use: "vision", model: "moss-vl-realtime-1.0" },
  { use: "live", model: "moss-live-1.0" },
] as const)("$use protects and freezes its own account independently of other bindings", async ({ use, model }) => {
  await using farm = await farmOver(unavailable);
  const { provider } = farm;
  const bound = (): Promise<Account> => provider[use]();
  await refusedBy(bound());
  const connection = { id: "separate", name: "Separate", adapter: "moss", enabled: true, key: "separate-private-key" } as const;
  const input = { ...configured(), connections: [...configured().connections, connection], [use]: { connection: connection.id, model } };
  const saved = await provider.update(input);
  const frozen = await bound();
  expect(frozen).toMatchObject({ connection: connection.id, revision: 1, model });
  const frozenKey = await keyOf(frozen);
  expect(frozenKey).toBe(`Bearer ${connection.key}`);
  const dictationKey11 = await keyNow(provider.dictation());
  expect(dictationKey11).toBe("Bearer test-first-key");
  if (saved[use]) saved[use].model = "caller-mutated";
  expect((await bound()).model).toBe(model);
  for (const patch of [
    { connections: configured().connections },
    { connections: [...configured().connections, { ...connection, enabled: false }] },
    { connections: [...configured().connections, { ...connection, key: null }] },
    { [use]: { connection: connection.id, model: "unsupported-model" } },
  ]) {
    await refusedBy(provider.update({ ...input, revision: 1, ...patch }));
  }
  await provider.update({ ...input, revision: 1, connections: [...configured().connections, { ...connection, key: "rotated-private-key" }] });
  const rotated = await bound();
  const keys = [await keyOf(rotated), await keyOf(frozen)];
  expect(keys).toEqual(["Bearer rotated-private-key", "Bearer separate-private-key"]);
  await provider.update({ ...input, revision: 2, [use]: null, connections: configured().connections });
  await refusedBy(bound());
});

describe("a failed vendor call", () => {
  test("is logged once with the vendor and the call, never with the key", async () => {
    await using farm = await farmOver(unavailable);
    const { provider, log } = farm;
    const count = (words: string) => log.lines.filter((l) => l.line.includes(words)).length;
    const image = { id: "image", name: "Images", adapter: "moss", enabled: true, key: "test-logged-key" } as const;
    await provider.update({
      ...configured(),
      connections: [...configured().connections, image],
      image: { connection: "image", model: "moss-image-sft-1.0" },
    });
    const bound = await provider.image(drawing);
    await keyUsedBy(() => bound.run());
    expect(count("provider: moss image.generate failed")).toBe(1);
    expect(count("test-logged-key")).toBe(0);
  });
});
