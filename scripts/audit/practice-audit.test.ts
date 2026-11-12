import { describe, expect, test } from "vite-plus/test";

import { audit, type Rule } from "./practice-audit.ts";

const found = (rule: Rule, ...texts: string[]) =>
  audit(texts.map((text, i) => ({ path: `f${i}.test.ts`, text })))
    .filter((f) => f.rule === rule)
    .map((f) => `${f.file}:${f.line}`);
/** Lines of a rule's hits in one source file (not a test). */
const inSource = (rule: Rule, text: string, path = "src.ts") =>
  audit([{ path, text }])
    .filter((f) => f.rule === rule)
    .map((f) => f.line);
const inTest = (rule: Rule, text: string) =>
  audit([{ path: "a.test.ts", text }])
    .filter((f) => f.rule === rule)
    .map((f) => f.line);

describe("turn-as-absence", () => {
  test("an assertion that nothing happened, straight after one turn", () => {
    expect(found("turn-as-absence", "async () => {\n  await aTurn();\n  expect(f.result).toBeUndefined();\n}")).toEqual(["f0.test.ts:3"]);
    expect(found("turn-as-absence", "async () => {\n  await nextTurn();\n  expect(a).toBe(1);\n  expect(spy).not.toHaveBeenCalled();\n}")).toEqual([
      "f0.test.ts:4",
    ]);
    expect(found("turn-as-absence", "async () => {\n  await Promise.resolve();\n  expect(seen).toEqual([]);\n}")).toEqual(["f0.test.ts:3"]);
    expect(found("turn-as-absence", "async () => {\n  await new Promise((r) => setImmediate(r));\n  expect(seen).toHaveLength(0);\n}")).toEqual([
      "f0.test.ts:3",
    ]);
    expect(found("turn-as-absence", "async () => {\n  await new Promise((r) => setTimeout(r, 0));\n  expect(seen).toHaveLength(0);\n}")).toEqual([
      "f0.test.ts:3",
    ]);
  });

  test("not a turn's wait, something done in between, a real wait or a positive assertion", () => {
    expect(found("turn-as-absence", "async () => {\n  await aTurn();\n  expect(seen).toEqual([1]);\n}")).toEqual([]);
    expect(found("turn-as-absence", "async () => {\n  await aTurn();\n  await run();\n  expect(seen).toHaveLength(0);\n}")).toEqual([]);
    expect(found("turn-as-absence", "async () => {\n  await until(() => done);\n  expect(seen).toHaveLength(0);\n}")).toEqual([]);
    expect(found("turn-as-absence", "async () => {\n  await new Promise((r) => setTimeout(r, 50));\n  expect(seen).toHaveLength(0);\n}")).toEqual([]);
    expect(found("turn-as-absence", '// await aTurn();\nexpect(x).toBeUndefined();\nconst s = "await aTurn(); expect(x).toBeUndefined()";')).toEqual([]);
  });
});

describe("unreleased-gate", () => {
  test("a withResolvers or gate() waited on and never opened", () => {
    expect(found("unreleased-gate", "async () => {\n  const g = Promise.withResolvers<void>();\n  await g.promise;\n}")).toEqual(["f0.test.ts:2"]);
    expect(found("unreleased-gate", "async () => {\n  const { promise, resolve } = Promise.withResolvers<void>();\n  await promise;\n}")).toEqual([
      "f0.test.ts:2",
    ]);
    expect(found("unreleased-gate", "async () => {\n  const g = gate();\n  fake.answer = () => g.opened;\n}")).toEqual(["f0.test.ts:2"]);
    expect(found("unreleased-gate", "async () => {\n  const { opened, open } = gate();\n  await opened;\n}")).toEqual(["f0.test.ts:2"]);
  });

  test("opened anywhere in scope, in a finally, or handed on", () => {
    expect(
      found(
        "unreleased-gate",
        "async () => {\n  const g = Promise.withResolvers<void>();\n  try {\n    await g.promise;\n  } finally {\n    g.resolve();\n  }\n}",
      ),
    ).toEqual([]);
    expect(found("unreleased-gate", "async () => {\n  const g = gate();\n  fake.answer = () => g.opened;\n  g.open();\n}")).toEqual([]);
    expect(
      found("unreleased-gate", "async () => {\n  const { promise, resolve } = Promise.withResolvers<void>();\n  fake.onDone = resolve;\n  await promise;\n}"),
    ).toEqual([]);
    expect(found("unreleased-gate", "async () => {\n  const g = Promise.withResolvers<void>();\n  await g.promise;\n  opener(g);\n}")).toEqual([]);
  });

  test("a function's own binding of the name is another gate", () => {
    const text = ["async () => {", "  const g = gate();", "  const open = (g: Gate) => g.open();", "  await g.opened;", "}"].join("\n");
    expect(found("unreleased-gate", text)).toEqual(["f0.test.ts:2"]);
  });

  test("never waited on is not this rule's", () => {
    expect(found("unreleased-gate", "async () => {\n  const g = Promise.withResolvers<void>();\n}")).toEqual([]);
  });
});

describe("duplicated-setup", () => {
  const host = (name: string, spacing = " ") => `sessions.host({${spacing}a: 1, b: "x", c: () => {}, d: [1], e: config.home, f: ${name} })`;

  test("the same object to the same call, across files, however it is spaced", () => {
    expect(found("duplicated-setup", host("llm"), `\n\n${host("llm", "\n    ")}`)).toEqual(["f0.test.ts:1"]);
    const register = "async function f() { (await farm()).session.register({ a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 }); }";
    expect(audit([register, register].map((text, i) => ({ path: `f${i}.test.ts`, text }))).map((f) => f.message.split(" ")[0])).toEqual([
      "?.session.register({…})",
    ]);
  });

  test("a different value, another callee, or a small object", () => {
    expect(found("duplicated-setup", host("llm"), host("other"))).toEqual([]);
    expect(found("duplicated-setup", host("llm"), host("llm").replace("sessions.host", "sessions.open"))).toEqual([]);
    expect(found("duplicated-setup", "f({ a: 1, b: 2 })", "f({ a: 1, b: 2 })")).toEqual([]);
  });
});

describe("practices in tests", () => {
  test("expect-in-floating-promise: an assertion that can fail where no one sees it", () => {
    expect(inTest("expect-in-floating-promise", 'test("x", async () => {\n  void (async () => expect(await f()).toBe(2))();\n});')).toEqual([2]);
    expect(inTest("expect-in-floating-promise", 'test("x", async () => {\n  load().then((v) => expect(v).toBe(1));\n});')).toEqual([2]);
    expect(inTest("expect-in-floating-promise", 'test("x", () => {\n  setTimeout(() => expect(seen).toEqual([1]), 10);\n});')).toEqual([2]);
    expect(inTest("expect-in-floating-promise", 'test("x", async () => {\n  const p = (async () => expect(await f()).toBe(1))();\n});')).toEqual([2]);
    expect(inTest("expect-in-floating-promise", 'test("x", async () => {\n  await load().then((v) => expect(v).toBe(1));\n});')).toEqual([]);
    expect(inTest("expect-in-floating-promise", 'test("x", async () => {\n  const p = (async () => expect(await f()).toBe(1))();\n  await p;\n});')).toEqual(
      [],
    );
    expect(inTest("expect-in-floating-promise", 'test("x", async () => {\n  expect(await f()).toBe(1);\n});')).toEqual([]);
  });

  test("failure-without-reason: failed, but not how", () => {
    expect(inTest("failure-without-reason", "expect(() => decode(x)).toThrow();")).toEqual([1]);
    expect(inTest("failure-without-reason", "await expect(load()).rejects.toThrow();")).toEqual([1]);
    expect(inTest("failure-without-reason", "await expect(load()).rejects.toThrow(Error);")).toEqual([1]);
    expect(inTest("failure-without-reason", "await expect(load()).rejects.toBeDefined();")).toEqual([1]);
    expect(inTest("failure-without-reason", "expect(e).toBeInstanceOf(Error);")).toEqual([1]);
    expect(inTest("failure-without-reason", "expect(() => decode(x)).toThrow(ZodError);")).toEqual([]);
    expect(inTest("failure-without-reason", "await expect(load()).rejects.toThrow(/not found/);")).toEqual([]);
    expect(inTest("failure-without-reason", "expect(e).toBeInstanceOf(ApiError);")).toEqual([]);
    expect(inTest("failure-without-reason", "expect(() => decode(x)).not.toThrow();")).toEqual([]);
  });

  test("shared-farm-in-test: built once at the top of the file", () => {
    expect(inTest("shared-farm-in-test", "const farm = await world();")).toEqual([1]);
    expect(inTest("shared-farm-in-test", "const db = testDb();")).toEqual([1]);
    expect(inTest("shared-farm-in-test", 'test("x", async () => {\n  await using farm = await world();\n});')).toEqual([]);
    expect(inTest("shared-farm-in-test", "const options = { issues: 2 };")).toEqual([]);
  });
});

describe("practices in source", () => {
  test("unbounded-retry: a retry that never gives up", () => {
    expect(inSource("unbounded-retry", "await retry(call, { retries: Infinity, delay: exponential(200) });")).toEqual([1]);
    expect(inSource("unbounded-retry", "await retry(call, { retries: Number.POSITIVE_INFINITY });")).toEqual([1]);
    expect(
      inSource(
        "unbounded-retry",
        "async function f() {\n  while (true) {\n    try {\n      return await call();\n    } catch {\n      await sleep(1000);\n    }\n  }\n}",
      ),
    ).toEqual([2]);
    expect(inSource("unbounded-retry", "await retry(call, { retries: 3, delay: exponential(200) });")).toEqual([]);
    expect(
      inSource(
        "unbounded-retry",
        "async function f() {\n  for (let n = 0; ; n++) {\n    try {\n      return await call();\n    } catch (e) {\n      if (n >= 3) throw e;\n    }\n  }\n}",
      ),
    ).toEqual([]);
    // A loop that goes round on success too is a patrol, not a retry.
    expect(
      inSource("unbounded-retry", "async function f() {\n  for (;;) {\n    try {\n      await tick();\n    } catch (e) {\n      log.warn(e);\n    }\n  }\n}"),
    ).toEqual([]);
  });

  test("read-modify-write: a get, an await, then a set made from what was read", () => {
    expect(inSource("read-modify-write", "async function f() {\n  const n = counts.get(k);\n  await save(k);\n  counts.set(k, n + 1);\n}")).toEqual([4]);
    expect(inSource("read-modify-write", "async function f() {\n  const n = counts.get(k);\n  counts.set(k, n + 1);\n  await save(k);\n}")).toEqual([]);
    // A cache filled after its miss writes nothing it read.
    expect(
      inSource(
        "read-modify-write",
        "async function f() {\n  const kept = done.get(k);\n  if (kept) return kept;\n  const got = await load(k);\n  done.set(k, got);\n}",
      ),
    ).toEqual([]);
    // Read again after the await: the re-check.
    expect(
      inSource(
        "read-modify-write",
        "async function f() {\n  const n = counts.get(k);\n  await save(k);\n  const m = counts.get(k);\n  counts.set(k, m + n);\n}",
      ),
    ).toEqual([]);
    expect(
      inSource(
        "read-modify-write",
        "async function f() {\n  await lock.with(async () => {\n    const n = counts.get(k);\n    await save(k);\n    counts.set(k, n + 1);\n  });\n}",
      ),
    ).toEqual([]);
    expect(inSource("read-modify-write", "async function f() {\n  const n = counts.get(k);\n  await save(k);\n  other.set(k, n + 1);\n}")).toEqual([]);
  });

  test("loose-flags: three let flags in one function, in any source file", () => {
    const flags = "function start() {\n  let starting = false;\n  let ending = false;\n  let gone = false;\n}";
    expect(inSource("loose-flags", flags)).toEqual([1]);
    expect(inSource("loose-flags", flags, "Page.tsx")).toEqual([1]);
    expect(inSource("loose-flags", 'function start() {\n  let phase = "idle";\n  let open = false;\n}')).toEqual([]);
    expect(inTest("loose-flags", flags)).toEqual([]);
    const signals =
      "function Page() {\n  const [open, setOpen] = createSignal(false);\n  const [busy, setBusy] = createSignal<boolean>(false);\n  let shown = true;\n}";
    expect(inSource("loose-flags", signals, "Page.tsx")).toEqual([1]);
  });

  test("swallow-without-record: every failure turned into a value with nothing said", () => {
    expect(inSource("swallow-without-record", "try {\n  return JSON.parse(text);\n} catch {\n  return undefined;\n}")).toEqual([3]);
    expect(inSource("swallow-without-record", "try {\n  work();\n} catch {}")).toEqual([3]);
    expect(inSource("swallow-without-record", "const hits = await source.search(text).catch(() => []);")).toEqual([1]);
    expect(inSource("swallow-without-record", "const hits = await source.search(text).catch(() => {});")).toEqual([1]);
    expect(inSource("swallow-without-record", "try {\n  work();\n} catch {\n  // Not there yet: the next poll sees it.\n}")).toEqual([]);
    expect(inSource("swallow-without-record", "// A missing file is an empty list.\nconst hits = await read(path).catch(() => []);")).toEqual([]);
    expect(inSource("swallow-without-record", "try {\n  work();\n} catch (e) {\n  log.warn(e);\n}")).toEqual([]);
    expect(inSource("swallow-without-record", "const hits = await source.search(text).catch((e) => [e]);")).toEqual([]);
    expect(inSource("swallow-without-record", "await reader.cancel().catch(() => undefined);")).toEqual([]);
    expect(inTest("swallow-without-record", "try {\n  work();\n} catch {}")).toEqual([]);
  });

  test("cause-as-string: the outside failure kept only as text", () => {
    expect(inSource("cause-as-string", "try {\n  await call();\n} catch (e) {\n  throw new SourceFailed(String(e));\n}")).toEqual([4]);
    expect(inSource("cause-as-string", "await call().catch((e) => {\n  throw new SourceFailed(`down: ${e.message}`);\n});")).toEqual([2]);
    expect(inSource("cause-as-string", "try {\n  await call();\n} catch (e) {\n  throw new SourceFailed(messageOf(e), { cause: e });\n}")).toEqual([]);
    expect(inSource("cause-as-string", "try {\n  await call();\n} catch (e) {\n  throw new SourceFailed(e);\n}")).toEqual([]);
    expect(inSource("cause-as-string", 'try {\n  await call();\n} catch (e) {\n  throw new SourceFailed("down");\n}')).toEqual([]);
  });

  test("duplicate-error-class: two Error subclasses going by one name", () => {
    const a = 'export class Missing extends Error {\n  override readonly name = "Missing";\n}';
    const b = 'export class SessionMissing extends ApiError {\n  override readonly name = "Missing";\n}';
    const c = "export class Missing extends Error {}";
    const distinct = 'export class SessionMissing extends Error {\n  override readonly name = "SessionMissing";\n}';
    const hits = (...texts: [string, string][]) =>
      audit(texts.map(([path, text]) => ({ path, text })))
        .filter((f) => f.rule === "duplicate-error-class")
        .map((f) => `${f.file}:${f.line}`);
    expect(hits(["a.ts", a], ["b.ts", b])).toEqual(["a.ts:1"]);
    expect(hits(["a.ts", a], ["c.ts", c])).toEqual(["a.ts:1"]);
    expect(hits(["a.ts", a], ["b.ts", distinct])).toEqual([]);
    expect(hits(["a.ts", a], ["b.test.ts", b])).toEqual([]);
    expect(hits(["a.ts", "class Missing extends Base {}"], ["c.ts", c])).toEqual([]);
  });
});
