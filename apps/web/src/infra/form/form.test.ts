import { Effect, Schema, SchemaGetter } from "effect";
import { afterEach, expect, expectTypeOf, test, vi } from "vite-plus/test";

import { createForm, type Submission } from "./form";
import type { Path, PathValue } from "./paths";

const messages = { issue: () => "invalid", unavailable: "unavailable", unknown: "unknown" };
const cleanup: (() => void)[] = [];
const keep = <T extends { dispose: () => void }>(form: T) => {
  cleanup.push(form.dispose);
  return form;
};
afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose();
  vi.useRealTimers();
});
const Input = Schema.Struct({
  name: Schema.Trim.check(Schema.isMinLength(1)),
  age: Schema.Trim.check(Schema.isMinLength(1)).pipe(Schema.decodeTo(Schema.FiniteFromString)),
});

test("encoded fields retain input while decoded values reach submission", async () => {
  const submitted = vi.fn((value: typeof Input.Type): Promise<Submission<number>> => Promise.resolve({ kind: "accepted", receipt: value.age }));
  const form = keep(createForm({ schema: Input, defaultValues: { name: " Ada ", age: "42" }, messages, onSubmit: submitted }));
  expectTypeOf(form.field(["age"]).value()).toEqualTypeOf<string>();
  expectTypeOf<number>().not.toExtend<Parameters<ReturnType<typeof form.field<readonly ["age"]>>["setValue"]>[0]>();
  expectTypeOf<readonly ["missing"]>().not.toExtend<Path<typeof Input.Encoded>>();
  expectTypeOf<PathValue<{ rows: readonly { name: string }[] }, readonly ["rows", number, "name"]>>().toEqualTypeOf<string>();
  const result = await form.submit();
  expect(result.kind).toBe("accepted");
  expect(submitted.mock.calls[0]?.[0]).toEqual({ name: "Ada", age: 42 });
  expect(form.values()).toEqual({ name: " Ada ", age: "42" });
  expect(form.field(["name"]).id).toBe(form.field(["name"]).id);
});

test("structured field and root failures contain no raw secret and show after touch or submit", async () => {
  const form = keep(
    createForm({
      schema: Input,
      defaultValues: { name: "", age: "secret-value" },
      messages,
      onSubmit: () => Promise.resolve({ kind: "accepted", receipt: undefined }),
    }),
  );
  await form.validate();
  expect(form.issues().map((issue) => issue.path)).toEqual([["name"], ["age"]]);
  expect(form.field(["age"]).issues()).toEqual([]);
  expect(JSON.stringify(form.issues())).not.toContain("secret-value");
  expect(await form.submit()).toEqual({ kind: "invalid" });
  expect(form.field(["age"]).messages()).toEqual(["invalid"]);
  const cross = Schema.Struct({ left: Schema.String, right: Schema.String }).check(Schema.makeFilter((value) => value.left === value.right));
  const root = keep(
    createForm({ schema: cross, defaultValues: { left: "a", right: "b" }, messages, onSubmit: () => Promise.resolve({ kind: "accepted", receipt: 1 }) }),
  );
  await root.submit();
  expect(root.issues()[0]?.path).toEqual([]);
});

test("regression: late receipts cannot reset edits, double clicks cannot repeat a write, and void success remains explicit", async () => {
  let acknowledge: ((value: Submission<void>) => void) | undefined;
  const sent = vi.fn(
    () =>
      new Promise<Submission<void>>((resolve) => {
        acknowledge = resolve;
      }),
  );
  const form = keep(createForm({ schema: Input, defaultValues: { name: "Ada", age: "42" }, messages, onSubmit: sent }));
  const old = form.revision();
  const first = form.submit();
  await vi.waitFor(() => expect(sent).toHaveBeenCalledOnce());
  expect(await form.submit()).toEqual({ kind: "busy" });
  form.field(["name"]).setValue("New edit");
  acknowledge?.({ kind: "accepted", receipt: undefined });
  expect((await first).kind).toBe("accepted");
  expect(form.reset({ name: "Ada", age: "42" }, { ifRevision: old })).toBe(false);
  expect(form.values().name).toBe("New edit");
  expect(form.dirty()).toBe(true);
});

test("regression: unknown and rejected delivery keep values and never retry", async () => {
  const send = vi.fn((): Promise<Submission<void>> => Promise.reject(new Error("private credential")));
  const form = keep(createForm({ schema: Input, defaultValues: { name: "Ada", age: "42" }, messages, onSubmit: send }));
  expect((await form.submit()).kind).toBe("unknown");
  expect(form.submitError()).toBe("unknown");
  expect(form.values().name).toBe("Ada");
  expect(send).toHaveBeenCalledOnce();
  const reject = keep(
    createForm({
      schema: Input,
      defaultValues: { name: "Ada", age: "42" },
      messages,
      onSubmit: () => Promise.resolve({ kind: "rejected", message: "refused" }),
    }),
  );
  expect((await reject.submit()).kind).toBe("rejected");
  expect(reject.submitError()).toBe("refused");
});

test("regression: async validation cannot submit an obsolete revision and dispose interrupts it", async () => {
  vi.useFakeTimers();
  let aborted = 0;
  const delayed = Schema.String.pipe(
    Schema.decodeTo(Schema.String, {
      decode: SchemaGetter.transformEffect((_value: string): Effect.Effect<string> =>
        Effect.never.pipe(
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              aborted++;
            }),
          ),
        ),
      ),
      encode: SchemaGetter.passthrough(),
    }),
  );
  const submit = vi.fn((): Promise<Submission<void>> => Promise.resolve({ kind: "accepted", receipt: undefined }));
  const form = keep(createForm({ schema: Schema.Struct({ name: delayed }), defaultValues: { name: "old" }, messages, onSubmit: submit }));
  const pending = form.submit();
  await vi.advanceTimersByTimeAsync(0);
  form.field(["name"]).setValue("new");
  await vi.advanceTimersByTimeAsync(25);
  expect(await pending).toEqual({ kind: "outdated" });
  expect(submit).not.toHaveBeenCalled();
  const last = form.validate();
  await vi.advanceTimersByTimeAsync(0);
  const changed = vi.fn();
  form.subscribe(changed);
  form.dispose();
  await vi.advanceTimersByTimeAsync(25);
  expect(await last).toEqual({ kind: "disposed" });
  expect(changed).not.toHaveBeenCalled();
  expect(aborted).toBeGreaterThanOrEqual(2);
});

test("asynchronous decoding succeeds only for its revision and empty numeric input is not zero", async () => {
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
  const form = keep(createForm({ schema, defaultValues: "first", messages, onSubmit: (value) => Promise.resolve({ kind: "accepted", receipt: value }) }));
  const one = form.validate();
  form.setValue([], "second");
  const two = form.validate();
  gates[1]?.();
  gates[0]?.();
  expect(await two).toEqual({ kind: "valid", value: "SECOND" });
  expect(await one).toEqual({ kind: "outdated" });
  expect(form.values()).toBe("second");
  const numeric = keep(
    createForm({ schema: Input, defaultValues: { name: "Ada", age: "" }, messages, onSubmit: () => Promise.resolve({ kind: "accepted", receipt: 0 }) }),
  );
  expect(await numeric.submit()).toEqual({ kind: "invalid" });
});

test("union branches, nested array failures and validation defects remain distinct and redacted", async () => {
  const schema = Schema.Struct({
    rows: Schema.Array(Schema.Struct({ value: Schema.Union([Schema.String.check(Schema.isMinLength(3)), Schema.String.check(Schema.isPattern(/^\d+$/u))]) })),
  });
  const form = keep(
    createForm({ schema, defaultValues: { rows: [{ value: "x" }] }, messages, onSubmit: () => Promise.resolve({ kind: "accepted", receipt: 1 }) }),
  );
  await form.validate();
  expect(form.issues()[0]).toMatchObject({ path: ["rows", 0, "value"], code: "union" });
  expect(form.issues()[0]?.branches).toHaveLength(2);
  const broken = Schema.String.pipe(
    Schema.decodeTo(Schema.String, { decode: SchemaGetter.transformEffect(() => Effect.die("private secret")), encode: SchemaGetter.passthrough() }),
  );
  const failure = keep(createForm({ schema: broken, defaultValues: "input", messages, onSubmit: () => Promise.resolve({ kind: "accepted", receipt: 1 }) }));
  expect(await failure.submit()).toEqual({ kind: "unavailable" });
  expect(failure.issues()).toEqual([]);
  expect(failure.submitError()).toBe("unavailable");
});

test("null values and absent optional keys remain distinct in the editing baseline", () => {
  const schema = Schema.Struct({ value: Schema.NullOr(Schema.String), optional: Schema.optional(Schema.String) });
  const form = keep(createForm({ schema, defaultValues: { value: null }, messages, onSubmit: () => Promise.resolve({ kind: "accepted", receipt: 1 }) }));
  form.field(["value"]).setValue("changed");
  expect(form.dirty()).toBe(true);
  form.field(["value"]).setValue(null);
  expect(form.dirty()).toBe(false);
  form.setValue([], { value: null, optional: undefined });
  expect(form.dirty()).toBe(true);
});

test("composition blocks submission and nested updates preserve arrays and conditional values", async () => {
  const schema = Schema.Struct({ rows: Schema.Array(Schema.Struct({ name: Schema.String })), extra: Schema.optionalKey(Schema.String) });
  const form = keep(
    createForm({
      schema,
      defaultValues: { rows: [{ name: "one" }], extra: "kept" },
      messages,
      onSubmit: () => Promise.resolve({ kind: "accepted", receipt: 1 }),
    }),
  );
  form.composition(true);
  expect(await form.submit()).toEqual({ kind: "composing" });
  form.field(["rows", 0, "name"]).setValue("two");
  expect(form.values()).toEqual({ rows: [{ name: "two" }], extra: "kept" });
  form.composition(false);
  expect((await form.submit()).kind).toBe("accepted");
  const record = keep(
    createForm({
      schema: Schema.Record(Schema.String, Schema.String),
      defaultValues: {},
      messages,
      onSubmit: () => Promise.resolve({ kind: "accepted", receipt: 1 }),
    }),
  );
  expect(() => record.field(["__proto__"])).toThrow("Unsafe");
  expect(() => form.field(["rows", -1, "name"])).toThrow("Unsafe");
});
