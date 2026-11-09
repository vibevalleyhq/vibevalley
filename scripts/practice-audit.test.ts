import { describe, expect, test } from "vite-plus/test";

import { audit, type Rule } from "./practice-audit.ts";

const found = (rule: Rule, ...texts: string[]) =>
  audit(texts.map((text, i) => ({ path: `f${i}.test.ts`, text })))
    .filter((f) => f.rule === rule)
    .map((f) => `${f.file}:${f.line}`);

describe("turn-as-absence", () => {
  test("an assertion that nothing happened, straight after one turn", () => {
    expect(found("turn-as-absence", "Effect.gen(function* () {\n  yield* aTurn;\n  expect(f.pollUnsafe()).toBeUndefined();\n});")).toEqual(["f0.test.ts:3"]);
    expect(found("turn-as-absence", "async () => {\n  await nextTurn();\n  expect(a).toBe(1);\n  expect(spy).not.toHaveBeenCalled();\n}")).toEqual([
      "f0.test.ts:4",
    ]);
    expect(found("turn-as-absence", "Effect.gen(function* () {\n  yield* Effect.yieldNow;\n  expect(seen).toEqual([]);\n});")).toEqual(["f0.test.ts:3"]);
  });

  test("not a turn's wait, something done in between, or a positive assertion", () => {
    expect(found("turn-as-absence", "Effect.gen(function* () {\n  yield* aTurn;\n  expect(seen).toEqual([1]);\n});")).toEqual([]);
    expect(found("turn-as-absence", "Effect.gen(function* () {\n  yield* aTurn;\n  yield* run;\n  expect(seen).toHaveLength(0);\n});")).toEqual([]);
    expect(found("turn-as-absence", "Effect.gen(function* () {\n  yield* until(() => done);\n  expect(seen).toHaveLength(0);\n});")).toEqual([]);
    expect(found("turn-as-absence", '// yield* aTurn;\nexpect(x).toBeUndefined();\nconst s = "yield* aTurn; expect(x).toBeUndefined()";')).toEqual([]);
  });
});

describe("unreleased-gate", () => {
  test("a Deferred or gate() waited on and never opened", () => {
    expect(found("unreleased-gate", "Effect.gen(function* () {\n  const g = yield* Deferred.make<void>();\n  yield* Deferred.await(g);\n});")).toEqual([
      "f0.test.ts:2",
    ]);
    expect(found("unreleased-gate", "async () => {\n  const g = gate();\n  fake.answer = () => g.opened;\n}")).toEqual(["f0.test.ts:2"]);
    expect(found("unreleased-gate", "async () => {\n  const { opened, open } = gate();\n  await opened;\n}")).toEqual(["f0.test.ts:2"]);
  });

  test("opened anywhere in scope, in a finalizer, or handed on", () => {
    expect(
      found(
        "unreleased-gate",
        "Effect.gen(function* () {\n  const g = yield* Deferred.make<void>();\n  yield* Effect.addFinalizer(() => Deferred.succeed(g, undefined));\n  yield* Deferred.await(g);\n});",
      ),
    ).toEqual([]);
    expect(found("unreleased-gate", "async () => {\n  const g = gate();\n  fake.answer = () => g.opened;\n  g.open();\n}")).toEqual([]);
    expect(
      found("unreleased-gate", "Effect.gen(function* () {\n  const g = yield* Deferred.make<void>();\n  yield* Deferred.await(g);\n  yield* opener(g);\n});"),
    ).toEqual([]);
    expect(
      found(
        "unreleased-gate",
        "Effect.gen(function* () {\n  const g = yield* Deferred.make<void>();\n  yield* work.pipe(Effect.intoDeferred(g));\n  yield* Deferred.await(g);\n});",
      ),
    ).toEqual([]);
  });

  test("a function's own binding of the name is another gate", () => {
    const text = [
      "Effect.gen(function* () {",
      "  const g = yield* Deferred.make<void>();",
      "  const open = (g: Deferred.Deferred<void>) => Deferred.succeed(g, undefined);",
      "  yield* Deferred.await(g);",
      "});",
    ].join("\n");
    expect(found("unreleased-gate", text)).toEqual(["f0.test.ts:2"]);
  });

  test("never waited on is not this rule's", () => {
    expect(found("unreleased-gate", "Effect.gen(function* () {\n  const g = yield* Deferred.make<void>();\n});")).toEqual([]);
  });
});

describe("duplicated-setup", () => {
  const host = (name: string, spacing = " ") => `sessions.host({${spacing}a: 1, b: "x", c: () => {}, d: [1], e: config.home, f: ${name} })`;

  test("the same object to the same call, across files, however it is spaced", () => {
    expect(found("duplicated-setup", host("llm"), `\n\n${host("llm", "\n    ")}`)).toEqual(["f0.test.ts:1"]);
    const register = "function* f() { (yield* Session).register({ a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 }); }";
    expect(audit([register, register].map((text, i) => ({ path: `f${i}.test.ts`, text }))).map((f) => f.message.split(" ")[0])).toEqual([
      "Session.register({…})",
    ]);
  });

  test("a different value, another callee, or a small object", () => {
    expect(found("duplicated-setup", host("llm"), host("other"))).toEqual([]);
    expect(found("duplicated-setup", host("llm"), host("llm").replace("sessions.host", "sessions.open"))).toEqual([]);
    expect(found("duplicated-setup", "f({ a: 1, b: 2 })", "f({ a: 1, b: 2 })")).toEqual([]);
  });
});

const effectImport = 'import { Effect } from "effect";\n';
/** Hits of a rule in one source file (not a test) that imports effect; lines count after the import. */
const inSource = (rule: Rule, text: string) =>
  audit([{ path: "src.ts", text: effectImport + text }])
    .filter((f) => f.rule === rule)
    .map((f) => f.line - 1);
const inTest = (rule: Rule, text: string) =>
  audit([{ path: "a.test.ts", text: 'import { it } from "@effect/vitest";\n' + effectImport + text }])
    .filter((f) => f.rule === rule)
    .map((f) => f.line - 2);

describe("effect practices in source", () => {
  test("fork-then-join: a fiber joined by the next statement", () => {
    expect(
      inSource("fork-then-join", "Effect.gen(function* () {\n  const f = yield* Effect.forkChild(load);\n  const page = yield* Fiber.join(f);\n});"),
    ).toEqual([3]);
    expect(
      inSource("fork-then-join", "Effect.gen(function* () {\n  const f = yield* Effect.forkChild(load);\n  yield* other;\n  yield* Fiber.join(f);\n});"),
    ).toEqual([]);
  });

  test("span-after-result: the span outside a step that turns failure into a value", () => {
    expect(inSource("span-after-result", 'send.pipe(Effect.result, Effect.withSpan("Feishu.send"));')).toEqual([1]);
    expect(inSource("span-after-result", 'send.pipe(Effect.withSpan("Feishu.send"), Effect.result);')).toEqual([]);
  });

  test("unbounded-retry: a schedule written here that never stops", () => {
    expect(inSource("unbounded-retry", 'call.pipe(Effect.retry(Schedule.exponential("200 millis")));')).toEqual([1]);
    expect(inSource("unbounded-retry", "call.pipe(Effect.retry({ while: (e) => e.transient }));")).toEqual([1]);
    expect(inSource("unbounded-retry", 'const forever = Schedule.spaced("1 second");\ncall.pipe(Effect.retry(forever));')).toEqual([2]);
    expect(inSource("unbounded-retry", 'call.pipe(Effect.retry(Schedule.exponential("200 millis").pipe(Schedule.upTo({ times: 5 }))));')).toEqual([]);
    expect(inSource("unbounded-retry", "call.pipe(Effect.retry({ times: 3 }));")).toEqual([]);
    // A policy from elsewhere may be bounded: not known here, not reported.
    expect(inSource("unbounded-retry", "call.pipe(Effect.retry(transient));")).toEqual([]);
  });

  test("ref-read-modify-write: a get, other effects, then a set of the same Ref", () => {
    expect(
      inSource(
        "ref-read-modify-write",
        "Effect.gen(function* () {\n  const now = yield* Ref.get(held);\n  const next = yield* reload(now);\n  yield* Ref.set(held, next);\n});",
      ),
    ).toEqual([4]);
    expect(inSource("ref-read-modify-write", "Effect.gen(function* () {\n  const now = yield* Ref.get(held);\n  yield* Ref.set(held, now + 1);\n});")).toEqual(
      [],
    );
    expect(
      inSource(
        "ref-read-modify-write",
        "Effect.gen(function* () {\n  const now = yield* Ref.get(held);\n  yield* reload(now);\n  yield* Ref.set(other, 1);\n});",
      ),
    ).toEqual([]);
  });

  test("pipe-on-effect-fn: piping the function Effect.fn made", () => {
    expect(inSource("pipe-on-effect-fn", 'const say = Effect.fn("Channel.say")(function* () {}).pipe(locked);')).toEqual([1]);
    expect(inSource("pipe-on-effect-fn", 'const say = Effect.fn("Channel.say")(function* () {}, locked);')).toEqual([]);
  });

  test("logic-in-pipe: two steps of logic chained in .pipe, not behaviour attached to the whole", () => {
    expect(inSource("logic-in-pipe", "const x = read.pipe(Effect.map((a) => a + 1), Effect.flatMap(save));")).toEqual([1]);
    expect(inSource("logic-in-pipe", "const x = read.pipe(Effect.map((a) => a + 1), Effect.retry(policy), Effect.timeout(1000));")).toEqual([]);
  });

  test("option-get-or-throw and die-with-plain-error", () => {
    expect(inSource("option-get-or-throw", "const v = Option.getOrThrow(found);")).toEqual([1]);
    expect(inSource("option-get-or-throw", "const v = Option.getOrElse(found, () => 0);")).toEqual([]);
    expect(inSource("die-with-plain-error", 'Effect.die(new Error("missing"));')).toEqual([1]);
    expect(inSource("die-with-plain-error", 'Effect.die(new Inconsistent({ message: "missing" }));')).toEqual([]);
  });

  test("swallow-without-record: every failure turned into a value with nothing noted", () => {
    expect(inSource("swallow-without-record", "source.search(text).pipe(Effect.catch(() => Effect.succeed([])));")).toEqual([1]);
    expect(
      inSource(
        "swallow-without-record",
        'source.search(text).pipe(Effect.tapError((e) => Effect.logWarning("down", e)), Effect.catch(() => Effect.succeed([])));',
      ),
    ).toEqual([]);
    expect(inSource("swallow-without-record", "source.search(text).pipe(Effect.catch((e) => Effect.succeed([e])));")).toEqual([]);
    expect(inSource("swallow-without-record", 'source.search(text).pipe(Effect.catchTag("Missing", () => Effect.succeed([])));')).toEqual([]);
  });

  test("cause-as-string: the outside failure kept only as text", () => {
    expect(inSource("cause-as-string", "Effect.tryPromise({ try: () => call(), catch: (e) => new SourceFailed({ message: String(e) }) });")).toEqual([1]);
    expect(inSource("cause-as-string", "Effect.tryPromise({ try: () => call(), catch: (cause) => new SourceFailed({ source, cause }) });")).toEqual([]);
    expect(inSource("cause-as-string", "Effect.tryPromise({ try: () => call(), catch: (e) => new SourceFailed({ message: e.message, cause: e }) });")).toEqual(
      [],
    );
  });

  test("uninterruptible-wait: no timeout or race can stop what it waits for", () => {
    expect(inSource("uninterruptible-wait", "Effect.uninterruptible(Effect.gen(function* () {\n  yield* write;\n  yield* Deferred.await(peer);\n}));")).toEqual(
      [1],
    );
    expect(inSource("uninterruptible-wait", "Effect.uninterruptible(Effect.gen(function* () {\n  yield* write;\n}));")).toEqual([]);
  });

  test("layer-built-twice: the same constructor call twice in one function", () => {
    expect(
      inSource(
        "layer-built-twice",
        "const app = Layer.mergeAll(Issue.layer.pipe(Layer.provide(Db.layerAt(path))), Channel.layer.pipe(Layer.provide(Db.layerAt(path))));",
      ),
    ).toEqual([1]);
    expect(
      inSource(
        "layer-built-twice",
        "const db = Db.layerAt(path);\nconst app = Layer.mergeAll(Issue.layer.pipe(Layer.provide(db)), Channel.layer.pipe(Layer.provide(db)));",
      ),
    ).toEqual([]);
  });

  test("source rules leave tests and files without effect alone", () => {
    expect(inTest("die-with-plain-error", 'Effect.die(new Error("missing"));')).toEqual([]);
    expect(audit([{ path: "plain.ts", text: 'Effect.die(new Error("missing"));' }])).toEqual([]);
  });
});

describe("effect practices in tests", () => {
  test("expect-in-unjoined-fiber: an assertion that can fail where no one sees it", () => {
    expect(inTest("expect-in-unjoined-fiber", "Effect.gen(function* () {\n  yield* Effect.forkChild(Effect.sync(() => expect(1).toBe(2)));\n});")).toEqual([2]);
    expect(
      inTest(
        "expect-in-unjoined-fiber",
        "Effect.gen(function* () {\n  const f = yield* Effect.forkChild(Effect.sync(() => expect(1).toBe(1)));\n  yield* Fiber.join(f);\n});",
      ),
    ).toEqual([]);
  });

  test("failure-without-reason: failed, but not how", () => {
    expect(inTest("failure-without-reason", "expect(Exit.isFailure(exit)).toBe(true);")).toEqual([1]);
    expect(inTest("failure-without-reason", 'expect(exit._tag).toBe("Failure");')).toEqual([1]);
    expect(inTest("failure-without-reason", 'expect(exit).toMatchObject({ _tag: "Failure" });')).toEqual([1]);
    expect(inTest("failure-without-reason", "expect(Exit.isSuccess(exit)).toBe(true);")).toEqual([]);
    expect(inTest("failure-without-reason", 'expect(error).toMatchObject({ _tag: "Refused" });')).toEqual([]);
  });

  test("run-in-effect-test, shared-runtime-in-test and live-with-test-clock", () => {
    expect(inTest("run-in-effect-test", 'it("x", async () => {\n  await Effect.runPromise(work);\n});')).toEqual([2]);
    expect(inTest("shared-runtime-in-test", "const world = Effect.runSync(Layer.build(World.layer));")).toEqual([1]);
    expect(inTest("shared-runtime-in-test", 'it.effect("x", () => work.pipe(Effect.provide(World.layer)));')).toEqual([]);
    expect(inTest("live-with-test-clock", 'it.live("x", () => TestClock.adjust("1 minute"));')).toEqual([1]);
    expect(inTest("live-with-test-clock", 'it.effect("x", () => TestClock.adjust("1 minute"));')).toEqual([]);
  });
});
