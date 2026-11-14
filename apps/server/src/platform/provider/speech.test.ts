import { expect, test } from "vite-plus/test";

import type { ProviderUpdate } from "@vibevalley/protocol";
import { ApiError, BizCode, endpoints } from "@vibevalley/protocol/api";
import { mossSpeechModels } from "@vibevalley/provider/moss/speech-models";

import { providerHandlers } from "#/gateway/http/handlers/provider.ts";
import { keptLog } from "#/infra/log.ts";
import { wallTime } from "#/infra/time.ts";
import { makeSetting } from "#/platform/setting/setting.ts";
import { testConfig } from "#/testing/layers.ts";

import { type Account, type Dictation, makeProvider } from "./provider.ts";

const notIn = (value: unknown, secret: string) => {
  expect(JSON.stringify(value)).not.toContain(secret);
};
/** A refusal by the providers; the test fails when p was not refused. */
const refusedBy = async (p: Promise<unknown>) => {
  const e = await p.then(
    () => expect.unreachable("it was not refused"),
    (e: unknown) => e,
  );
  expect(e).toBeInstanceOf(ApiError);
  expect(e).toMatchObject({ bizCode: BizCode.ProviderRefused });
  return e instanceof ApiError ? e : expect.unreachable(String(e));
};

const config: ProviderUpdate = {
  revision: 0,
  connections: [
    { id: "first", name: "First", adapter: "moss", enabled: true, key: "test-first-private" },
    { id: "second", name: "Second", adapter: "moss", enabled: true, key: "test-second-private" },
  ],
  dictation: { connection: "first", model: "moss-transcribe-1.0" },
  image: null,
  understanding: null,
  speech: { connection: "second", model: "moss-tts-1.5-flash" },
  live: { connection: "first", model: "moss-live-1.0" },
  speakers: null,
  voiceDesign: null,
  transcription: null,
  vision: null,
};
/** The settings and providers over a fresh home, the vendor answering as http does; closed when the test is done. */
const farmOver = async (http: typeof fetch) => {
  const log = keptLog();
  const setting = await makeSetting({ config: testConfig(), clock: wallTime, log });
  const provider = await makeProvider({ setting, fetch: http, clock: wallTime, log });
  return { setting, provider, [Symbol.asyncDispose]: () => setting.close() };
};
/** A vendor answered by answer, as a Request the call would send. */
const vendor =
  (answer: (request: Request) => Response | Promise<Response>): typeof fetch =>
  async (input, init) =>
    answer(new Request(input, init));
/** A vendor that answers 503 and keeps each request's key: what a bound account's call sends, run once. */
const recording = () => {
  const keys: string[] = [];
  const http = vendor((request) => {
    keys.push(request.headers.get("authorization") ?? "");
    return new Response("", { status: 503 });
  });
  const keyUsedBy = async (account: Account | Dictation) => {
    await (
      "tasks" in account
        ? account.tasks.get("task")
        : account.transcriber("wav").then((model) => model.doGenerate({ audio: new Uint8Array([1]), mediaType: "audio/wav" }))
    ).catch(() => "whatever the vendor answers");
    return keys.at(-1) ?? "";
  };
  return { http, keyUsedBy };
};
const page = {
  object: "list",
  data: [{ id: "voice-one", object: "audio.voice", name: "One", created_at: 1 }],
  first_id: "voice-one",
  last_id: "voice-one",
  has_more: true,
  next_cursor: "next-page",
};

test.each(mossSpeechModels)("speech binding %s is independent, immutable and protected while in use", async (model) => {
  const { http, keyUsedBy } = recording();
  await using farm = await farmOver(http);
  const { provider } = farm;
  await refusedBy(provider.speech());
  const input = { ...config, speech: { connection: "second", model } };
  const saved = await provider.update(input);
  expect(saved.speechModels).toEqual(mossSpeechModels);
  const frozen = await provider.speech();
  expect(frozen).toMatchObject({ connection: "second", revision: 1, model });
  const frozenKey = await keyUsedBy(frozen);
  expect(frozenKey).toBe("Bearer test-second-private");
  notIn(frozen, "test-second-private");
  const dictation = await provider.dictation();
  const live = await provider.live();
  const others = [await keyUsedBy(dictation), await keyUsedBy(live)];
  expect(others).toEqual(["Bearer test-first-private", "Bearer test-first-private"]);
  notIn(saved, "test-second-private");
  if (saved.speech) saved.speech.model = "caller-mutated";
  expect(provider.status().speech?.model).toBe(model);
  for (const connections of [
    config.connections.slice(0, 1),
    config.connections.map((c) => (c.id === "second" ? { ...c, key: null } : c)),
    config.connections.map((c) => (c.id === "second" ? { ...c, enabled: false } : c)),
  ]) {
    await refusedBy(provider.update({ ...input, revision: 1, connections }));
    expect(provider.status().revision).toBe(1);
  }
  await provider.update({
    ...input,
    revision: 1,
    connections: config.connections.map((c) => (c.id === "second" ? { ...c, key: "test-rotated-private" } : c)),
  });
  const rotated = await provider.speech();
  const keys = [await keyUsedBy(rotated), await keyUsedBy(frozen)];
  expect(keys).toEqual(["Bearer test-rotated-private", "Bearer test-second-private"]);
  await provider.update({ ...input, revision: 2, speech: null });
  await refusedBy(provider.speech());
});

test("voice listing uses only the selected account and forwards one page, not the default binding", async () => {
  const keys: (string | null)[] = [];
  const http = vendor((request) => {
    const url = new URL(request.url);
    expect(url.origin + url.pathname).toBe("https://api.mosi.cn/v1/audio/voices");
    keys.push(request.headers.get("authorization"));
    if (keys.length === 2) expect([...url.searchParams]).toContainEqual(["after", "next-page"]);
    return Response.json(page);
  });
  await using farm = await farmOver(http);
  const { provider } = farm;
  const api = providerHandlers({ provider });
  expect(endpoints.find((endpoint) => endpoint.op === "provider.voice.list")?.can).toEqual(["user"]);
  await provider.update(config);
  const first = await api["provider.voice.list"]({ connection: "first", revision: 1 });
  expect(first).toEqual({
    connection: "first",
    revision: 1,
    voices: [{ id: "voice-one", name: "One", createdAtSeconds: 1 }],
    hasMore: true,
    nextCursor: "next-page",
  });
  const second = await api["provider.voice.list"]({ connection: "second", revision: 1, after: "next-page", limit: 1 });
  expect(second.connection).toBe("second");
  expect(keys).toEqual(["Bearer test-first-private", "Bearer test-second-private"]);
  notIn([first, second], "private");
  for (const request of [
    { connection: "first", revision: 0 },
    { connection: "missing", revision: 1 },
    { connection: "first", revision: 1, after: "next-page", offset: 0 },
  ]) {
    await refusedBy(api["provider.voice.list"](request));
  }
  expect(keys).toHaveLength(2);
});

test("regression: an in-flight voice listing cannot outlive the configuration revision that authorized it", async () => {
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  let calls = 0;
  const http = vendor(async () => {
    calls++;
    started.resolve();
    await finish.promise;
    return Response.json(page);
  });
  await using farm = await farmOver(http);
  const { provider } = farm;
  await provider.update(config);
  const listing = provider.voices({ connection: "second", revision: 1 }).then(
    () => expect.unreachable("it was not refused"),
    (e: unknown) => e,
  );
  await started.promise;
  await provider.update({ ...config, revision: 1, speech: null, connections: config.connections.slice(0, 1) });
  finish.resolve();
  const outlived = await listing;
  expect(outlived).toMatchObject({ name: "ApiError", bizCode: BizCode.ProviderRefused });
  await refusedBy(provider.voices({ connection: "second", revision: 2 }));
  expect(calls).toBe(1);
});

test("voice listing errors never expose the account secret or vendor response", async () => {
  await using farm = await farmOver(vendor(() => Response.json({ error: { message: "test-second-private", code: "private" } }, { status: 403 })));
  const { provider } = farm;
  await provider.update(config);
  const error = await refusedBy(provider.voices({ connection: "second", revision: 1 }));
  expect(error.bizCode).toBe(BizCode.ProviderRefused);
  notIn(error, "private");
});
