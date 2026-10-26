// The protocol's schemas (packages/protocol/src/schema.ts) take every fact, state, view and inbox in the golden runs (testdata), and
// the frames the rules make of them.

import { expect, test } from "vite-plus/test";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { Effect, Schema } from "effect";
import { wireJson } from "../base/wire.ts";
import type { WorkspaceState } from "@vibevalley/protocol";
import { emptyWorkspaceState } from "./core.ts";
import { reduce } from "../projection/reduce.ts";
import { frameOf } from "../projection/frame.ts";
import * as S from "@vibevalley/protocol/schema";

const encodeFrame = wireJson(S.StateFrame);

test("the golden runs and the frames made of them decode", async () => {
  const url = new URL("./testdata/reduce.jsonl.gz", import.meta.url);
  const rows = new TextDecoder()
    .decode(gunzipSync(readFileSync(url)))
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  const decode = {
    fact: Schema.decodeUnknownSync(S.Fact),
    state: Schema.decodeUnknownSync(S.WorkspaceState),
    view: Schema.decodeUnknownSync(S.FarmView),
    inbox: Schema.decodeUnknownSync(Schema.Array(S.InboxItem)),
    frame: Schema.decodeUnknownSync(S.StateFrame),
  };
  let state: WorkspaceState = emptyWorkspaceState();
  let run = -1;
  for (const row of rows) {
    if (row.run !== run) [run, state] = [row.run as number, emptyWorkspaceState()];
    const fact = decode.fact(row.fact);
    expect(decode.state(row.state)).toEqual(row.state as WorkspaceState);
    decode.view(row.view);
    decode.inbox(row.inbox);
    state = reduce(state, fact)[0];
    // As /state sends it: the frame encoded by its Schema is the same JSON the plain object would make, so the Schema
    // neither refuses a frame the farm makes nor drops a field of it.
    const frame = frameOf(state);
    const sent = Effect.runSync(encodeFrame(frame));
    expect(JSON.parse(sent)).toEqual(JSON.parse(JSON.stringify(frame)));
    decode.frame(JSON.parse(sent));
  }
  expect(() => decode.fact({ type: "doing", at: 1, id: "w1", action: "dance", label: "" })).toThrow(/run_command/);
});
