import { Effect, Schema, SchemaGetter } from "effect";
import { afterEach, expect, expectTypeOf, test, vi } from "vite-plus/test";

import { createQueryClient, defineQuery } from "./cache";

const clients: ReturnType<typeof createQueryClient>[] = [];
const client = () => {
  const value = createQueryClient();
  clients.push(value);
  return value;
};
afterEach(() => {
  for (const value of clients.splice(0)) value.dispose();
});

test("query results derive from the schema output, not the fetch signature", async () => {
  const query = defineQuery({ schema: Schema.FiniteFromString, key: () => ["decoded"], fetch: (): Promise<unknown> => Promise.resolve("42") });
  const c = client();
  const value = await c.fetch(query());
  expectTypeOf(value).toEqualTypeOf<number>();
  expectTypeOf<string>().not.toExtend<typeof value>();
  expect(value).toBe(42);
  c.setData(query(), () => ({ value: 17 }));
  expect(c.read(query()).record?.value).toBe(17);
  expect(() => c.setData(query(), () => ({ value: Number.NaN }))).toThrow();
  expect(c.read(query()).record?.value).toBe(17);
});

test("regression: bad responses cannot replace valid cached data, expose raw values or retry decoding", async () => {
  let response: unknown = { count: 1 };
  const fetch = vi.fn(() => Promise.resolve(response));
  const query = defineQuery({ schema: Schema.Struct({ count: Schema.Finite }), key: () => ["checked"], fetch, retry: 3, retryWhen: () => true });
  const c = client();
  await c.fetch(query());
  response = { count: "private-credential" };
  await expect(c.fetch(query(), true)).rejects.toMatchObject({ _tag: "QueryDecodeError" });
  expect(c.read(query()).status).toBe("error");
  expect(c.read(query()).record?.value).toEqual({ count: 1 });
  expect(JSON.stringify(c.read(query()).error)).not.toContain("private-credential");
  expect(c.read(query()).error?.message).not.toContain("private-credential");
  expect(fetch).toHaveBeenCalledTimes(2);
  c.clear();
  await expect(c.fetch(query())).rejects.toMatchObject({ _tag: "QueryDecodeError" });
  expect(c.read(query()).record).toBeUndefined();
});

test("regression: equivalent decoded responses preserve cached identity across refresh and confirmed writes", async () => {
  let id = "same";
  const query = defineQuery({ schema: Schema.Array(Schema.Struct({ id: Schema.String })), key: () => ["identity"], fetch: () => Promise.resolve([{ id }]) });
  const c = client();
  const initial = await c.fetch(query());
  expect(await c.fetch(query(), true)).toBe(initial);
  c.setData(query(), () => ({ value: [{ id }] }));
  expect(c.read(query()).record?.value).toBe(initial);
  id = "changed";
  const changed = await c.fetch(query(), true);
  expect(changed).not.toBe(initial);
  expect(changed).toEqual([{ id: "changed" }]);
});

test("refetch returns an explicit failure snapshot while imperative fetch rejects", async () => {
  let value: unknown = "valid";
  const query = defineQuery({ schema: Schema.String, key: () => ["refetch"], fetch: () => Promise.resolve(value) });
  const c = client();
  await c.fetch(query());
  value = 10;
  const result = await c.refetch(query());
  expect(result).toMatchObject({ status: "error", error: { _tag: "QueryDecodeError" }, record: { value: "valid" }, fetching: false });
  await expect(c.fetch(query(), true)).rejects.toMatchObject({ _tag: "QueryDecodeError" });
});

test("regression: invalidating during async decoding waits for a new decoded result", async () => {
  const gates: (() => void)[] = [];
  const schema = Schema.String.pipe(
    Schema.decodeTo(Schema.String, {
      decode: SchemaGetter.transformEffect((value: string) =>
        Effect.callback<string>((resume) => {
          gates.push(() => resume(Effect.succeed(value.toUpperCase())));
        }),
      ),
      encode: SchemaGetter.passthrough(),
    }),
  );
  let count = 0;
  const query = defineQuery({ schema, key: () => ["async"], fetch: () => Promise.resolve(`read-${++count}`) });
  const c = client();
  const first = c.fetch(query());
  await vi.waitFor(() => expect(gates).toHaveLength(1));
  const refresh = c.invalidate();
  gates[0]?.();
  await vi.waitFor(() => expect(gates).toHaveLength(2));
  expect(c.read(query()).record).toBeUndefined();
  gates[1]?.();
  expect(await first).toBe("READ-2");
  await refresh;
  expect(count).toBe(2);
});

test("regression: confirmed data interrupts decoding and an ignored late completion cannot overwrite it", async () => {
  let finish: (() => void) | undefined;
  let interrupted = false;
  const schema = Schema.String.pipe(
    Schema.decodeTo(Schema.String, {
      decode: SchemaGetter.transformEffect((value: string) =>
        Effect.callback<string>((resume) => {
          finish = () => resume(Effect.succeed(value));
        }).pipe(
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              interrupted = true;
            }),
          ),
        ),
      ),
      encode: SchemaGetter.passthrough(),
    }),
  );
  const query = defineQuery({ schema, key: () => ["cancel-decode"], fetch: () => Promise.resolve("old") });
  const c = client();
  const pending = c.fetch(query());
  const failure = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  await vi.waitFor(() => expect(finish).toBeDefined());
  c.setData(query(), () => ({ value: "confirmed" }));
  await failure;
  await vi.waitFor(() => expect(interrupted).toBe(true));
  finish?.();
  expect(c.read(query()).record?.value).toBe("confirmed");
  expect(c.fetching()).toBe(0);
});
