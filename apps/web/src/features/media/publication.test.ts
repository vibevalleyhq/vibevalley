import { expect, test } from "vite-plus/test";

import { publicationKey } from "./publication.ts";

test("regression: image publication fits the channel send key limit and remains stable across retries", async () => {
  const job = "x".repeat(80);
  const channel = "c".repeat(80);
  const key = await publicationKey(job, channel);
  expect(key).toMatch(/^[a-f0-9]{64}$/u);
  expect(await publicationKey(job, channel)).toBe(key);
  expect(await publicationKey(job, `${channel}-other`)).not.toBe(key);
  expect(await publicationKey(`${job}-other`, channel)).not.toBe(key);
  expect(await publicationKey("a-b", "c")).not.toBe(await publicationKey("a", "b-c"));
});
