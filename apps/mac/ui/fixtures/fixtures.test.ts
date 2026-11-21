import "../infra/polyfill";
import { expect, test } from "nsh/test";

import { endpoints } from "@vibevalley/protocol/api";
import { StateFrame as StateFrameSchema } from "@vibevalley/protocol/schema";

import { scenarios } from "./scenarios";
import { responses, state } from "./workbench";

test("workbench fixture as JSON", () => {
  expect(state.state.issues.length).toBe(7);
  console.log(`@@state.json ${JSON.stringify(state)}`);
  console.log(`@@responses.json ${JSON.stringify(responses)}`);
});

test("scenario frames and workbench responses match protocol schemas", () => {
  expect(() => StateFrameSchema.parse(state)).not.toThrow();

  for (const [density, entry] of Object.entries(scenarios)) {
    expect(() => StateFrameSchema.parse(entry.state)).not.toThrow();
    expect(entry.state.seq).toBeGreaterThanOrEqual(0);
    expect(density.length).toBeGreaterThan(0);
  }

  const byOp = new Map(endpoints.map((ep) => [ep.op, ep]));
  let validatedOps = 0;

  for (const [op, raw] of Object.entries(responses)) {
    const endpoint = byOp.get(op as (typeof endpoints)[number]["op"]);
    if (!endpoint) continue;

    let sample: unknown = raw;
    if (typeof raw === "function") {
      if ("toJSON" in raw && typeof raw.toJSON === "function") {
        sample = (raw as { toJSON: () => unknown }).toJSON();
      } else {
        continue;
      }
    }

    if (sample !== null && typeof sample === "object" && "bizCode" in sample) {
      continue;
    }

    if (endpoint.result !== undefined) {
      const parsed = endpoint.result.safeParse(sample);
      if (!parsed.success) {
        throw new Error(`fixture response "${op}" failed schema validation: ${JSON.stringify(parsed.error.issues)}`);
      }
    } else {
      expect(sample === null || sample === undefined).toBe(true);
    }
    validatedOps++;
  }

  expect(validatedOps).toBeGreaterThan(20);
});
