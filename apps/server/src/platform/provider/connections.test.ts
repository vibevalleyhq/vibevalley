import { expect, test } from "vite-plus/test";

import type { ProviderConnectionUpdate, ProviderUpdate } from "@vibevalley/protocol";
import { ApiError, BizCode } from "@vibevalley/protocol/api";

import { emptyProviders } from "#/platform/setting/provider.ts";

import { connectionsOver } from "./connections.ts";

const connection: ProviderConnectionUpdate = { id: "moss", name: "MOSS", adapter: "moss", enabled: true, key: "test-key" };
const update: ProviderUpdate = { ...emptyProviders, connections: [connection] };

test.each([
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
])("invalid connection changes are refused before persistence %#", (input) => {
  const error = (() => {
    try {
      connectionsOver(emptyProviders, input);
    } catch (e) {
      return e;
    }
    return undefined;
  })();
  expect(error).toBeInstanceOf(ApiError);
  expect(error).toMatchObject({ bizCode: BizCode.ProviderRefused });
  expect(error instanceof Error ? error.message : "").not.toContain("test-key");
});

test("new unconfigured connections can be saved without implying any usable default", () => {
  const saved = connectionsOver(emptyProviders, { ...update, connections: [{ id: "moss", name: " MOSS ", adapter: "moss", enabled: true }] });
  const { connections, ...uses } = saved;
  expect(connections.map(({ key, ...rest }) => ({ ...rest, key: key.reveal() }))).toEqual([
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
});
