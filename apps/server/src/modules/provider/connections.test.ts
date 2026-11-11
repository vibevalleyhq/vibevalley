import { expect, it } from "@effect/vitest";
import { Array as Arr, Effect, Redacted } from "effect";

import type { ProviderConnectionUpdate, ProviderUpdate } from "@vibevalley/protocol";
import { BizCode } from "@vibevalley/protocol/api";

import { emptyProviders } from "#/modules/setting/provider.ts";

import { connectionsOver } from "./connections.ts";

const connection: ProviderConnectionUpdate = { id: "moss", name: "MOSS", adapter: "moss", enabled: true, key: "test-key" };
const update: ProviderUpdate = { ...emptyProviders, connections: [connection] };

it.effect.each([
  { ...update, connections: [connection, connection] },
  { ...update, connections: [{ ...connection, id: "../invalid" }] },
  { ...update, connections: [{ ...connection, name: " " }] },
  { ...update, connections: [{ ...connection, name: "x".repeat(81) }] },
  { ...update, connections: [{ ...connection, key: " " }] },
  { ...update, connections: [{ ...connection, key: "a b" }] },
  { ...update, connections: [{ ...connection, key: "x".repeat(4097) }] },
  { ...update, connections: Array.from({ length: 33 }, (_, index) => ({ ...connection, id: `connection-${index}` })) },
  { ...update, live: { connection: "missing", model: "moss-live-1.0" } },
  { ...update, speech: { connection: "missing", model: "moss-tts-1.5-flash" } },
  { ...update, speech: { connection: "moss", model: "moss-ttsd-1.0" } },
  { ...update, speech: { connection: "moss", model: "moss-tts-1.5-flash-2099-01-01" } },
  { ...update, understanding: { connection: "missing", model: "moss-vl-1.0" } },
  { ...update, understanding: { connection: "moss", model: "moss-image-base-1.0" } },
  { ...update, understanding: { connection: "moss", model: "moss-vl-1.0-2099-01-01" } },
  { ...update, dictation: { connection: "moss", model: "moss-image" } },
  { ...update, image: { connection: "missing", model: "moss-image-base-1.0" } },
  { ...update, image: { connection: "moss", model: "moss-transcribe-1.0" } },
  { ...update, image: { connection: "moss", model: "moss-image-base-1.0-2099-01-01" } },
])("invalid connection changes are refused before persistence %#", (input) =>
  Effect.gen(function* () {
    const error = yield* connectionsOver(emptyProviders, input).pipe(Effect.flip);
    expect(error.bizCode).toBe(BizCode.ProviderRefused);
    expect(error.message).not.toContain("test-key");
  }),
);

it.effect("new unconfigured connections can be saved without implying any usable default", () =>
  Effect.gen(function* () {
    const saved = yield* connectionsOver(emptyProviders, { ...update, connections: [{ id: "moss", name: " MOSS ", adapter: "moss", enabled: true }] });
    const { connections, ...uses } = saved;
    expect(Arr.map(connections, ({ key, ...rest }) => ({ ...rest, key: Redacted.value(key) }))).toEqual([
      { id: "moss", name: "MOSS", adapter: "moss", enabled: true, key: "" },
    ]);
    expect(uses).toEqual({
      revision: 1,
      dictation: null,
      image: null,
      understanding: null,
      speech: null,
      live: null,
      speakers: null,
      voiceDesign: null,
      transcription: null,
      vision: null,
    });
  }),
);
