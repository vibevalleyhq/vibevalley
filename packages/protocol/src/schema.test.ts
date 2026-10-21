// The generated schemas (schema.ts) take every fact, state, view and inbox in the golden runs (testdata), and
// the frames the rules make of them.

import { expect, test } from "vite-plus/test";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { Schema } from "effect";
import type { CoreState, Fact } from "./shapes";
import { emptyCoreState, frameOf, reduce } from "./rules";
import * as S from "./schema";

test("the golden runs and the frames made of them decode", async () => {
  const url = new URL("../testdata/reduce.jsonl.gz", import.meta.url);
  const rows = new TextDecoder()
    .decode(gunzipSync(readFileSync(url)))
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  const decode = {
    fact: Schema.decodeUnknownSync(S.Fact),
    state: Schema.decodeUnknownSync(S.CoreState),
    view: Schema.decodeUnknownSync(S.FarmView),
    inbox: Schema.decodeUnknownSync(Schema.Array(S.InboxItem)),
    frame: Schema.decodeUnknownSync(S.StateFrame),
  };
  let state: CoreState = emptyCoreState();
  let run = -1;
  for (const row of rows) {
    if (row.run !== run) [run, state] = [row.run as number, emptyCoreState()];
    const fact = decode.fact(row.fact) as Fact;
    expect(decode.state(row.state)).toEqual(row.state as CoreState);
    decode.view(row.view);
    decode.inbox(row.inbox);
    state = reduce(state, fact)[0];
    decode.frame(JSON.parse(JSON.stringify(frameOf(state))));
  }
  expect(() => decode.fact({ type: "doing", at: 1, id: "w1", action: "dance", label: "" })).toThrow(/run_command/);
});
