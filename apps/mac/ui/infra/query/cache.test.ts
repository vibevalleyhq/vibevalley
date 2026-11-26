import "../polyfill";
import { describe, expect, test } from "nsh/test";
import { z } from "zod";

import { createQueryClient, defineQuery } from "./cache";
import { QueryDecodeError } from "./schema";

describe("defineQuery", () => {
  test("with schema decodes valid payloads, fails on invalid payloads without retrying, and validates setData", async () => {
    const client = createQueryClient();
    let calls = 0;
    let payload: unknown = { path: "/tmp/assets" };

    const assetsQuery = defineQuery({
      schema: z.object({ path: z.string() }),
      key: () => ["test", "assets"],
      fetch: () => {
        calls += 1;
        return Promise.resolve(payload);
      },
      retry: 2,
      retryWhen: () => true,
    });

    const first = await client.fetch(assetsQuery());
    expect(first).toEqual({ path: "/tmp/assets" });
    expect(calls).toBe(1);

    client.setData(assetsQuery(), () => ({ value: { path: "/tmp/other" } }));
    expect(client.read(assetsQuery()).record?.value).toEqual({ path: "/tmp/other" });

    payload = { path: 123 };
    let caught: unknown;
    try {
      await client.fetch(assetsQuery(), true);
    } catch (error) {
      caught = error;
    }
    expect(caught instanceof QueryDecodeError).toBe(true);
    expect(calls).toBe(2);

    let writeError: unknown;
    try {
      const invalidWrite = JSON.parse('{"path":42}') as { path: string };
      client.setData(assetsQuery(), () => ({ value: invalidWrite }));
    } catch (error) {
      writeError = error;
    }
    expect(writeError instanceof QueryDecodeError).toBe(true);
    client.dispose();
  });

  test("without schema trusts typed fetch responses, preserves unchanged references, and supports setData", async () => {
    const client = createQueryClient();
    let nextCount = 1;

    const countQuery = defineQuery({
      key: (id: string) => ["test", "count", id],
      fetch: (id) => Promise.resolve({ id, count: nextCount }),
    });

    const first = await client.fetch(countQuery("a"));
    expect(first).toEqual({ id: "a", count: 1 });

    const sameRef = await client.fetch(countQuery("a"), true);
    expect(sameRef === first).toBe(true);

    nextCount = 2;
    const updated = await client.fetch(countQuery("a"), true);
    expect(updated).toEqual({ id: "a", count: 2 });

    client.setData(countQuery("a"), (old) => (old ? { value: { ...old.value, count: 99 } } : undefined));
    expect(client.read(countQuery("a")).record?.value).toEqual({ id: "a", count: 99 });
    client.dispose();
  });
});
