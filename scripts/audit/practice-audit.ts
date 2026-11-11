import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { parseSync } from "vite";

import { type Counts, type RatchetWords, grownRules, ratchetProblems, touchedFiles } from "./ratchet.ts";

/** Syntax, not text: each rule stands for a practice written in docs/style/module-design.md, the testable-boundaries Note or the vv-effect cases. */

type Node = { readonly type?: unknown; readonly start?: number; readonly end?: number; readonly [key: string]: unknown };
const isNode = (v: unknown): v is Node => typeof v === "object" && v !== null && !Array.isArray(v) && "type" in v && typeof v.type === "string";
const childrenOf = (node: Node): Node[] => {
  const out: Node[] = [];
  for (const key in node) {
    if (key === "parent") continue;
    const v = node[key];
    if (Array.isArray(v)) out.push(...v.filter(isNode));
    else if (isNode(v)) out.push(v);
  }
  return out;
};
const field = (node: Node, key: string): Node | undefined => {
  const v = node[key];
  return isNode(v) ? v : undefined;
};
const list = (node: Node, key: string): Node[] => {
  const v: unknown = node[key];
  return Array.isArray(v) ? v.filter(isNode) : [];
};

const testRules = [
  "turn-as-absence",
  "unreleased-gate",
  "duplicated-setup",
  "expect-in-unjoined-fiber",
  "failure-without-reason",
  "run-in-effect-test",
  "shared-runtime-in-test",
  "live-with-test-clock",
] as const;
const sourceRules = [
  "fork-then-join",
  "span-after-result",
  "unbounded-retry",
  "ref-read-modify-write",
  "pipe-on-effect-fn",
  "logic-in-pipe",
  "option-get-or-throw",
  "die-with-plain-error",
  "swallow-without-record",
  "cause-as-string",
  "uninterruptible-wait",
  "layer-built-twice",
  "loose-flags",
  "duplicate-error-tag",
  "provide-in-loop",
  "cached-per-call",
] as const;
export type Rule = (typeof testRules)[number] | (typeof sourceRules)[number];
export const rules: readonly Rule[] = [...testRules, ...sourceRules];
export type Finding = { readonly rule: Rule; readonly file: string; readonly line: number; readonly message: string };

const why: Record<Rule, string> = {
  "turn-as-absence":
    "one turn of the event loop is not a boundary: a later run can still do what this says did not happen. " +
    "Fix: wait for a finished operation, a confirmed step of the fake or a TestClock window, then assert; or say in a comment why nothing can come later. " +
    "See .agents/notes/proposed/testing/2026-11-08-testable-module-boundaries.md (4.)",
  "unreleased-gate":
    "something waits at this gate but nothing in the test opens it or hands it on, so the waiter only ends when the scope interrupts it. " +
    "Fix: open it on the path the test means (Deferred.succeed / gate.open), and in a finalizer when an expect can fail first. " +
    "See docs/style/module-design.md",
  "duplicated-setup":
    "the same setup is written out again: a change to it has to find every copy. " +
    "Fix: make it one helper next to the tests (or in src/testing) taking only what differs. " +
    "See .agents/notes/proposed/testing/2026-11-08-testable-module-boundaries.md (5.)",
  "expect-in-unjoined-fiber":
    "an expect inside a forked fiber that is never joined: when it fails, the fiber dies on its own and the test still passes. " +
    "Fix: Fiber.join the fiber before the test ends, or collect what it sees and assert in the test's own fiber. " +
    "See .agents/skills/vv-effect/references/cases.md (26.)",
  "failure-without-reason":
    "this says it failed but not how: a defect, an interruption or the wrong error passes it too. " +
    'Fix: const error = yield* Effect.flip(x); expect(error).toMatchObject({ _tag: "…" }) (or match the Exit\'s cause). ' +
    "See .agents/skills/vv-effect/references/cases.md (8.)",
  "run-in-effect-test":
    "a test file on @effect/vitest runs an Effect by hand: it leaves the test runtime (TestClock, the test's scope and its finalizers). " +
    "Fix: write the test as it.effect / it.live and yield* the Effect. " +
    "See .agents/skills/vv-effect/references/cases.md (26.)",
  "shared-runtime-in-test":
    "a runtime or layer built once at the top of a test file: state from one test leaks into the next, and nothing closes it. " +
    "Fix: provide a fresh layer in each test; share only what is costly, with it.layer(…), and say what is shared. " +
    "See .agents/skills/vv-effect/references/cases.md (36.)",
  "live-with-test-clock":
    "it.live runs on the real clock, so TestClock here moves a clock nothing reads. " +
    "Fix: it.effect for a window of virtual time; it.live only for real I/O. " +
    "See .agents/skills/vv-effect/references/cases.md (26.)",
  "fork-then-join":
    "a fiber joined right after it is forked: nothing ran beside it. Fix: yield* the effect itself; two at once with Effect.all(…, { concurrency }). " +
    "See .agents/skills/vv-effect/references/cases.md (32.)",
  "span-after-result":
    "the span wraps an effect whose failure is already a value: the trace shows a success. " +
    "Fix: put Effect.withSpan before Effect.result / option / exit / ignore (or name the function with Effect.fn). " +
    "See .agents/skills/vv-effect/references/cases.md (28.)",
  "unbounded-retry":
    "a retry with no upper bound turns one outage into forever. " +
    "Fix: bound it (Schedule.upTo / recurs / { times }) and add Schedule.jittered; retry only what is safe to do twice. " +
    "See .agents/skills/vv-effect/references/cases.md (31.)",
  "ref-read-modify-write":
    "a Ref read, then other effects, then a write of the same Ref: another fiber can write between them. " +
    "Fix: Ref.modify / Ref.update for a pure step, SynchronizedRef.modifyEffect when the step runs effects. " +
    "See .agents/skills/vv-effect/references/cases.md (20.)",
  "pipe-on-effect-fn":
    "Effect.fn(…)(…).pipe(…) pipes the function, not the Effect each call returns. " +
    'Fix: pass the combinators as Effect.fn\'s further arguments: Effect.fn("X.m")(function* () {…}, locked). ' +
    "See .agents/skills/vv-effect/references/cases.md (4.)",
  "logic-in-pipe":
    "two or more steps of logic chained in .pipe (Effect.map, flatMap, andThen, tap…): the flow reads inside out and each step's value is nameless. " +
    "Fix: write the steps in Effect.gen (or Effect.fn), one yield* to a named const each; keep .pipe for behaviour attached to the whole (retry, timeout, catch, annotate). " +
    "See apps/server/node_modules/effect/AGENTS.md (Writing Effect code)",
  "option-get-or-throw":
    "Option.getOrThrow throws a plain exception outside the error channel: a nameless defect. " +
    "Fix: Option.match into a tagged error (or Inconsistent for a bug), Option.getOrElse for a default. " +
    "See .agents/skills/vv-effect/references/cases.md (11.)",
  "die-with-plain-error":
    "a defect as a plain Error: logs and traces cannot tell this bug from a library's failure. " +
    "Fix: Effect.die(new Inconsistent({ message })) from errors.ts. " +
    "See .agents/skills/vv-effect/references/cases.md (9.)",
  "swallow-without-record":
    "every failure becomes an ordinary value and nothing is noted: a broken source looks like an empty one. " +
    "Fix: Effect.tapError / tapCause with a log before it, catchTag only what is expected, or bestEffort(what) from infra/log.ts. " +
    "See .agents/skills/vv-effect/references/cases.md (37.)",
  "cause-as-string":
    "the outside failure is kept only as text: its stack, status and the library's own error are gone. " +
    "Fix: pass it whole as cause (cause: Schema.Defect()); say it to the user where it is handled, with t(). " +
    "See .agents/skills/vv-effect/references/cases.md (10.)",
  "uninterruptible-wait":
    "Effect.uninterruptible around a wait: no timeout, race or shutdown can stop it. " +
    "Fix: Effect.uninterruptibleMask((restore) => …) protecting only what must finish, and restore(wait). " +
    "See .agents/skills/vv-effect/references/cases.md (30.)",
  "layer-built-twice":
    "the same layer constructor is called twice with the same arguments: two layers, built twice (two databases on one file). " +
    "Fix: keep it in a constant and use that one value. " +
    "See .agents/skills/vv-effect/references/cases.md (35.)",
  "loose-flags":
    "several flags kept loose in one function (let x = false…, createSignal(false)…): when they move together they are one state machine whose impossible combinations nothing stops. " +
    "Fix: one union, a tag per state with what that state holds, in one let, signal or Ref; keep a flag apart only when it is a dimension of its own (it can be true in any of the states). " +
    "See docs/style/module-design.md (显式状态)",
  "duplicate-error-tag":
    "two TaggedError classes share one _tag string, so catchTag and Match.tag cannot tell them apart across module boundaries. " +
    "Fix: give each TaggedError a distinct domain _tag matching its class name. " +
    "See .agents/skills/vv-effect/references/cases.md (42.)",
  "provide-in-loop":
    "Effect.provide inside a loop builds and tears down its Layer on every iteration instead of sharing one instance. " +
    "Fix: hoist Effect.provide outside the loop, or build the Layer once in the enclosing scope before looping. " +
    "See .agents/skills/vv-effect/references/cases.md (44.)",
  "cached-per-call":
    "Effect.cached / cachedWithTTL called per invocation or inside a loop creates a fresh cache each time, so nothing is shared across calls. " +
    "Fix: yield* Effect.cached(...) once during Layer or service setup and reuse the returned Effect in methods. " +
    "See .agents/skills/vv-effect/references/cases.md (45.)",
};

const lineAt = (text: string) => {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  return (offset: number) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
};

const isIdent = (n: Node | undefined, name?: string): n is Node & { readonly type: "Identifier" } =>
  n?.type === "Identifier" && (name === undefined || n.name === name);
const memberOf = (n: Node | undefined): { object: Node; name: string } | undefined => {
  if (n?.type !== "MemberExpression" || n.computed === true) return undefined;
  const object = field(n, "object");
  const property = field(n, "property");
  return object && isIdent(property) ? { object, name: String(property.name) } : undefined;
};
const unwrap = (n: Node | undefined): Node | undefined => {
  // `yield* x`, `await x`, `(x)`, `x!`, `x as T` all wait for or are x.
  while (n && ["YieldExpression", "AwaitExpression", "ParenthesizedExpression", "TSNonNullExpression", "TSAsExpression"].includes(String(n.type)))
    n = field(n, "argument") ?? field(n, "expression");
  return n;
};
const isFunction = (n: Node) => n.type === "ArrowFunctionExpression" || n.type === "FunctionExpression" || n.type === "FunctionDeclaration";

const isBooleanLiteral = (n: Node | undefined) => n?.type === "Literal" && typeof n.value === "boolean";
/** Three or more `let x = true/false` or boolean signals (`createSignal(false)`) in one function body. Fields of a type are left alone: most are a shape's data or a
 * component's props, not state. */
function looseFlags(n: Node, report: (at: Node, what: string) => void) {
  if (isFunction(n)) {
    const body = field(n, "body");
    if (body?.type !== "BlockStatement") return;
    const flags = list(body, "body")
      .filter((s) => s.type === "VariableDeclaration")
      .flatMap((s) => list(s, "declarations").map((d) => ({ d, kind: s.kind })))
      .flatMap(({ d, kind }) => {
        const id = field(d, "id");
        const init = field(d, "init");
        if (kind === "let" && isBooleanLiteral(init) && isIdent(id) && typeof id.name === "string") return [id.name];
        // A Solid signal of a boolean: const [open, setOpen] = createSignal(false).
        const first = id?.type === "ArrayPattern" ? list(id, "elements")[0] : undefined;
        if (init?.type === "CallExpression" && isIdent(field(init, "callee"), "createSignal") && isBooleanLiteral(list(init, "arguments")[0]))
          return isIdent(first) && typeof first.name === "string" ? [first.name] : [];
        return [];
      });
    if (flags.length >= 3) report(n, `flags ${flags.join(", ")}`);
  }
}

const turnWaits = new Set(["aTurn", "nextTurn"]);
function isOneTurn(statement: Node): boolean {
  if (statement.type !== "ExpressionStatement") return false;
  const raw = field(statement, "expression");
  if (raw?.type !== "YieldExpression" && raw?.type !== "AwaitExpression") return false;
  let n = unwrap(raw);
  if (n?.type === "CallExpression" && list(n, "arguments").length === 0) n = field(n, "callee");
  if (isIdent(n) && turnWaits.has(String(n.name))) return true;
  const m = memberOf(n);
  return m !== undefined && isIdent(m.object, "Effect") && m.name === "yieldNow";
}

/** Reads `expect(…)[.not|.resolves…].matcher(…)`. */
function expectation(statement: Node): { matcher: string; call: Node; negated: boolean } | undefined {
  if (statement.type !== "ExpressionStatement") return undefined;
  const call = unwrap(field(statement, "expression"));
  if (call?.type !== "CallExpression") return undefined;
  const matcher = memberOf(field(call, "callee"));
  if (!matcher) return undefined;
  let chain: Node | undefined = matcher.object;
  let negated = false;
  while (chain !== undefined && chain.type !== "CallExpression") {
    const m = memberOf(chain);
    if (!m) return undefined;
    if (m.name === "not") negated = true;
    chain = m.object;
  }
  return chain !== undefined && isIdent(field(chain, "callee"), "expect") ? { matcher: matcher.name, call, negated } : undefined;
}

const absent = new Set(["toBeUndefined", "toBeNull", "toBeFalsy", "toHaveLength", "toEqual", "toStrictEqual", "toBe", "toHaveBeenCalledTimes"]);
function saysNothingHappened(statement: Node): boolean {
  const e = expectation(statement);
  if (!e) return false;
  const { call, negated } = e;
  const matcher = { name: e.matcher };
  if (negated) return true;
  if (!absent.has(matcher.name)) return false;
  const [arg] = list(call, "arguments");
  if (["toBeUndefined", "toBeNull", "toBeFalsy"].includes(matcher.name)) return true;
  if (matcher.name === "toHaveLength" || matcher.name === "toHaveBeenCalledTimes") return arg?.type === "Literal" && arg.value === 0;
  if (matcher.name === "toEqual" || matcher.name === "toStrictEqual") return arg?.type === "ArrayExpression" && list(arg, "elements").length === 0;
  return arg?.type === "Literal" && (arg.value === false || arg.value === 0);
}

function turnAsAbsence(body: Node[], report: (n: Node) => void) {
  for (let i = 0; i < body.length; i++) {
    if (!isOneTurn(body[i]!)) continue;
    // The assertions straight after the turn, up to the next statement that does anything else.
    for (let j = i + 1; j < body.length && expectation(body[j]!); j++)
      if (saysNothingHappened(body[j]!)) {
        report(body[j]!);
        break;
      }
  }
}

const opensDeferred = new Set(["succeed", "done", "complete", "completeWith", "fail", "failCause", "die", "interrupt", "interruptWith", "sync", "into"]);
const opensDeferredUnsafe = new Set(["succeedUnsafe", "doneUnsafe", "failUnsafe", "failCauseUnsafe", "dieUnsafe", "interruptUnsafe"]);
const waitsDeferred = new Set(["await", "poll", "isDone", "isDoneUnsafe"]);

type Gate = {
  readonly name: string;
  readonly kind: "deferred" | "gate";
  readonly at: Node;
  readonly scope: Node;
  readonly open?: string | undefined;
  readonly opened?: string | undefined;
};

/** `yield* Deferred.make<…>()`, `Deferred.makeUnsafe()`, testkit's `gate()` (whole, or `{ opened, open }`). */
function gatesDeclaredIn(fn: Node): Gate[] {
  const gates: Gate[] = [];
  const visit = (n: Node) => {
    if (n !== fn && isFunction(n)) return;
    if (n.type === "VariableDeclarator") {
      const init = unwrap(field(n, "init"));
      const id = field(n, "id");
      if (init?.type === "CallExpression" && id) {
        const callee = field(init, "callee");
        const m = memberOf(callee);
        if (m && isIdent(m.object, "Deferred") && (m.name === "make" || m.name === "makeUnsafe") && isIdent(id))
          gates.push({ name: String(id.name), kind: "deferred", at: n, scope: fn });
        if (isIdent(callee, "gate") && isIdent(id)) gates.push({ name: String(id.name), kind: "gate", at: n, scope: fn });
        if (isIdent(callee, "gate") && id.type === "ObjectPattern") {
          const names: Record<string, string> = {};
          for (const p of list(id, "properties")) {
            const key = field(p, "key");
            const value = field(p, "value");
            if (isIdent(key) && isIdent(value)) names[String(key.name)] = String(value.name);
          }
          gates.push({ name: names.opened ?? names.open ?? "gate", kind: "gate", at: n, scope: fn, open: names.open, opened: names.opened });
        }
      }
    }
    for (const c of childrenOf(n)) visit(c);
  };
  for (const c of childrenOf(fn)) visit(c);
  return gates;
}

const bindsName = (fn: Node, name: string): boolean => {
  const binds = (p: Node | undefined): boolean => {
    if (!p) return false;
    if (isIdent(p)) return p.name === name;
    if (p.type === "AssignmentPattern") return binds(field(p, "left"));
    if (p.type === "RestElement") return binds(field(p, "argument"));
    if (p.type === "ArrayPattern") return list(p, "elements").some(binds);
    if (p.type === "ObjectPattern") return list(p, "properties").some((q) => binds(field(q, "value") ?? field(q, "argument")));
    return false;
  };
  return list(fn, "params").some(binds);
};

type Use = { readonly node: Node; readonly parent: Node | undefined; readonly grand: Node | undefined };
function usesOf(scope: Node, name: string, skip: Node): Use[] {
  const uses: Use[] = [];
  const visit = (n: Node, parent: Node | undefined, grand: Node | undefined) => {
    if (n === skip) return;
    if (n !== scope && isFunction(n) && bindsName(n, name)) return;
    if (isIdent(n, name)) {
      const keyOfMember = parent?.type === "MemberExpression" && parent.property === n && parent.computed !== true;
      const keyOfProperty = parent?.type === "Property" && parent.key === n && parent.shorthand !== true;
      if (!keyOfMember && !keyOfProperty) uses.push({ node: n, parent, grand });
    }
    for (const c of childrenOf(n)) visit(c, n, parent);
  };
  visit(scope, undefined, undefined);
  return uses;
}

type Role = "opens" | "waits" | "escapes";
function roleOf(gate: Gate, use: Use, name: string): Role {
  const { node, parent, grand } = use;
  if (gate.kind === "deferred") {
    if (parent?.type === "CallExpression" && list(parent, "arguments")[0] === node) {
      const m = memberOf(field(parent, "callee"));
      if (m && isIdent(m.object, "Deferred")) {
        if (opensDeferred.has(m.name) || opensDeferredUnsafe.has(m.name)) return "opens";
        if (waitsDeferred.has(m.name)) return "waits";
      }
    }
    // `Effect.intoDeferred(x)` / `x.pipe(Effect.intoDeferred(d))` complete it too.
    if (parent?.type === "CallExpression") {
      const m = memberOf(field(parent, "callee"));
      if (m?.name === "intoDeferred") return "opens";
    }
    return "escapes";
  }
  if (gate.open !== undefined || gate.opened !== undefined) {
    if (name === gate.open) return parent?.type === "CallExpression" && parent.callee === node ? "opens" : "escapes";
    return parent?.type === "AwaitExpression" || (parent?.type === "MemberExpression" && memberOf(parent)?.name === "then") ? "waits" : "escapes";
  }
  const m = parent && memberOf(parent);
  if (m?.name === "open") return grand?.type === "CallExpression" && grand.callee === parent ? "opens" : "escapes";
  if (m?.name === "opened") return "waits";
  return "escapes";
}

function unreleasedGates(fn: Node, report: (n: Node, name: string) => void) {
  for (const gate of gatesDeclaredIn(fn)) {
    const names = gate.open !== undefined || gate.opened !== undefined ? [gate.open, gate.opened].filter((n): n is string => n !== undefined) : [gate.name];
    const roles = new Set(names.flatMap((name) => usesOf(gate.scope, name, field(gate.at, "id")!).map((u) => roleOf(gate, u, name))));
    if (roles.has("waits") && !roles.has("opens") && !roles.has("escapes")) report(gate.at, gate.name);
  }
}

const minProperties = 6;
/** The object's shape and values, without where it is or how it is spaced. */
function shapeOf(n: Node): string {
  switch (n.type) {
    case "Identifier":
      return `#${String(n.name)}`;
    case "Literal":
      return JSON.stringify(n.value ?? null);
    case "TemplateLiteral":
      return (
        "`" +
        list(n, "quasis")
          .map((q) => (typeof q.value === "object" && q.value !== null && "cooked" in q.value ? String(q.value.cooked) : ""))
          .join("${}") +
        "`"
      );
    default:
      return `${String(n.type)}(${childrenOf(n).map(shapeOf).join(",")}${n.type === "Property" ? (n.shorthand === true ? ":s" : "") : ""})`;
  }
}
const calleeName = (n: Node | undefined): string => {
  n = unwrap(n);
  if (n?.type === "ChainExpression") n = field(n, "expression");
  if (isIdent(n)) return String(n.name);
  const m = memberOf(n);
  return m ? `${calleeName(m.object)}.${m.name}` : "?";
};

type Setup = { readonly file: string; readonly line: number; readonly callee: string };
function setupsIn(program: Node, file: string, line: (o: number) => number, into: Map<string, Setup[]>) {
  const visit = (n: Node) => {
    if (n.type === "CallExpression")
      for (const arg of list(n, "arguments"))
        if (arg.type === "ObjectExpression" && list(arg, "properties").length >= minProperties) {
          const callee = calleeName(field(n, "callee"));
          const key = `${callee}|${shapeOf(arg)}`;
          into.set(key, [...(into.get(key) ?? []), { file, line: line(arg.start ?? 0), callee }]);
        }
    for (const c of childrenOf(n)) visit(c);
  };
  visit(program);
}

const memberName = (n: Node | undefined, object: string): string | undefined => {
  const m = memberOf(n);
  return m !== undefined && isIdent(m.object, object) ? m.name : undefined;
};
const callName = (n: Node | undefined, object: string): string | undefined =>
  n?.type === "CallExpression" ? memberName(field(n, "callee"), object) : undefined;
const refersTo = (n: Node | undefined, object: string, names: ReadonlySet<string>): boolean =>
  names.has(memberName(n, object) ?? "") || names.has(callName(n, object) ?? "");

/** Whether any node under n (n too) satisfies ok; inside nested functions only when asked. */
function contains(n: Node, ok: (n: Node) => boolean, intoFunctions = true): boolean {
  const visit = (m: Node, top: boolean): boolean => {
    if (!top && !intoFunctions && isFunction(m)) return false;
    if (ok(m)) return true;
    return childrenOf(m).some((c) => visit(c, false));
  };
  return visit(n, true);
}
const isDelegatingYield = (n: Node) => n.type === "YieldExpression" && n.delegate === true;
const isExpectCall = (n: Node) => n.type === "CallExpression" && isIdent(field(n, "callee"), "expect");

/** The arguments a pipe applies in order: `x.pipe(a, b)`, `pipe(x, a, b)`, and `Effect.fn(…)(body, a, b)`. */
function pipeSteps(n: Node): Node[] | undefined {
  if (n.type !== "CallExpression") return undefined;
  const callee = field(n, "callee");
  if (memberOf(callee)?.name === "pipe") return list(n, "arguments");
  if (isIdent(callee, "pipe")) return list(n, "arguments").slice(1);
  if (callee?.type === "CallExpression" && ["fn", "fnUntraced"].includes(callName(callee, "Effect") ?? "")) return list(n, "arguments").slice(1);
  if (["fn", "fnUntraced"].includes(callName(n, "Effect") ?? "") && list(n, "arguments")[0]?.type !== "Literal") return list(n, "arguments").slice(1);
  return undefined;
}

const textOf = (text: string, n: Node) => text.slice(n.start, n.end);
const topOf = (s: Node): Node | undefined => {
  if (s.type === "ExpressionStatement") return field(s, "expression");
  if (s.type === "ReturnStatement") return field(s, "argument");
  if (s.type === "VariableDeclaration") {
    const ds = list(s, "declarations");
    return ds.length === 1 ? field(ds[0]!, "init") : undefined;
  }
  return undefined;
};
const declared = (s: Node): { id: string; init: Node } | undefined => {
  if (s.type !== "VariableDeclaration") return undefined;
  const ds = list(s, "declarations");
  const id = ds.length === 1 ? field(ds[0]!, "id") : undefined;
  const init = ds.length === 1 ? field(ds[0]!, "init") : undefined;
  return isIdent(id) && init ? { id: String(id.name), init } : undefined;
};

const forks = new Set(["forkChild", "forkScoped", "forkDetach", "forkIn"]);

function forkThenJoin(body: Node[], report: (n: Node, what: string) => void) {
  for (let i = 0; i + 1 < body.length; i++) {
    const d = declared(body[i]!);
    if (!d || !forks.has(callName(unwrap(d.init), "Effect") ?? "")) continue;
    const next = body[i + 1]!;
    const joined = (n: Node) => ["join", "await"].includes(callName(n, "Fiber") ?? "") && isIdent(list(n, "arguments")[0], d.id);
    if (contains(next, joined, false)) report(next, d.id);
  }
}

const valueOut = new Set(["result", "option", "exit", "ignore", "ignoreCause", "orElseSucceed"]);
function spanAfterResult(n: Node, report: (n: Node) => void) {
  const steps = pipeSteps(n);
  if (!steps) return;
  const at = steps.findIndex((s) => refersTo(s, "Effect", valueOut));
  if (at < 0) return;
  for (const s of steps.slice(at + 1)) if (callName(s, "Effect") === "withSpan") report(s);
}

const bounding = new Set(["upTo", "recurs", "take", "during", "while", "until", "recurUpTo", "recurUntil", "recurWhile"]);
const scheduleNames = new Set(["Schedule", "Duration"]);
/** true: bounded or not known here; false: a schedule written here that never stops. */
function bounded(policy: Node, consts: ReadonlyMap<string, Node>, depth = 0): boolean {
  if (depth > 3) return true;
  if (isIdent(policy)) {
    const init = consts.get(String(policy.name));
    return init === undefined ? true : bounded(init, consts, depth + 1);
  }
  if (policy.type === "ObjectExpression") {
    const props = list(policy, "properties");
    const key = (p: Node) => (isIdent(field(p, "key")) ? String(field(p, "key")!.name) : "");
    if (props.some((p) => p.type !== "Property" || key(p) === "times")) return true;
    const schedule = props.find((p) => key(p) === "schedule");
    const value = schedule && field(schedule, "value");
    return value ? bounded(value, consts, depth + 1) : false;
  }
  if (!contains(policy, (n) => memberName(n, "Schedule") !== undefined)) return true;
  if (contains(policy, (n) => bounding.has(memberOf(n)?.name ?? ""))) return true;
  // Another name in it (a helper, a variable) may bound it.
  let unknown = false;
  const visit = (n: Node, parent: Node | undefined) => {
    if (isIdent(n) && !scheduleNames.has(String(n.name)) && !(parent?.type === "MemberExpression" && field(parent, "property") === n)) {
      const init = consts.get(String(n.name));
      if (init === undefined || bounded(init, consts, depth + 1)) unknown = true;
    }
    for (const c of childrenOf(n)) visit(c, n);
  };
  visit(policy, undefined);
  return unknown;
}
function unboundedRetry(n: Node, consts: ReadonlyMap<string, Node>, report: (n: Node) => void) {
  if (callName(n, "Effect") !== "retry") return;
  const args = list(n, "arguments");
  const policy = args.length === 2 ? args[1] : args[0];
  if (policy && !bounded(policy, consts)) report(n);
}

const refs = ["Ref", "SynchronizedRef", "SubscriptionRef"];
const refCall = (n: Node, names: readonly string[]) => refs.some((r) => names.includes(callName(n, r) ?? ""));
function refReadModifyWrite(body: Node[], text: string, report: (n: Node, what: string) => void) {
  for (let i = 0; i < body.length; i++) {
    const read = unwrap(topOf(body[i]!));
    if (body[i]!.type !== "VariableDeclaration" || !read || !refCall(read, ["get"])) continue;
    const target = list(read, "arguments")[0];
    if (!target) continue;
    const key = textOf(text, target);
    for (let j = i + 1; j < body.length; j++) {
      const writes = (n: Node) => refCall(n, ["set"]) && list(n, "arguments")[0] !== undefined && textOf(text, list(n, "arguments")[0]!) === key;
      if (!contains(body[j]!, writes, false)) continue;
      if (body.slice(i + 1, j).some((s) => contains(s, isDelegatingYield, false))) report(body[j]!, key);
      break;
    }
  }
}

function pipeOnEffectFn(n: Node, report: (n: Node) => void) {
  const m = memberOf(n);
  if (m?.name !== "pipe") return;
  const made = unwrap(m.object);
  if (made?.type !== "CallExpression") return;
  const callee = field(made, "callee");
  const isFn = (c: Node | undefined) => ["fn", "fnUntraced"].includes(callName(c, "Effect") ?? "");
  if (isFn(callee) || (callName(made, "Effect") === "fnUntraced" && !isFn(callee))) report(n);
}

/** The combinators that carry a step of the flow's own logic; the rest of .pipe's arguments attach behaviour. */
const logicSteps = new Set(["map", "flatMap", "andThen", "tap", "zipWith", "filterOrFail", "flatten"]);
function logicInPipe(n: Node, report: (n: Node) => void) {
  if (n.type !== "CallExpression" || memberOf(field(n, "callee"))?.name !== "pipe") return;
  if (list(n, "arguments").filter((arg) => logicSteps.has(callName(arg, "Effect") ?? "")).length >= 2) report(n);
}

const plainErrors = new Set(["Error", "TypeError", "RangeError"]);
function dieWithPlainError(n: Node, report: (n: Node) => void) {
  const name = callName(n, "Effect");
  if (name === "dieMessage") return report(n);
  if (name !== "die") return;
  const arg = list(n, "arguments")[0];
  if (arg?.type === "NewExpression" && isIdent(field(arg, "callee")) && plainErrors.has(String(field(arg, "callee")!.name))) report(n);
}

const recorded = new Set(["tapError", "tapCause", "tapErrorCause", "tapDefect", "tapErrorTag", "tapCauseIf"]);
const quietValues = new Set(["succeed", "void", "succeedNone", "succeedSome", "never"]);
const paramsUnused = (fn: Node) => list(fn, "params").every((p) => !isIdent(p) || usesOf(field(fn, "body")!, String(p.name), p).length === 0);
const returnsQuietly = (fn: Node): boolean => {
  const body = field(fn, "body");
  if (!body) return false;
  const value =
    body.type === "BlockStatement"
      ? list(body, "body").length === 1 && list(body, "body")[0]!.type === "ReturnStatement"
        ? field(list(body, "body")[0]!, "argument")
        : undefined
      : body;
  return value !== undefined && refersTo(value, "Effect", quietValues);
};
function swallowWithoutRecord(n: Node, report: (n: Node) => void) {
  const steps = pipeSteps(n);
  const check = (call: Node, before: readonly Node[]) => {
    const name = callName(call, "Effect");
    if (name !== "catch" && name !== "catchCause" && name !== "orElseSucceed") return;
    const args = list(call, "arguments");
    const handler = args[args.length - 1];
    if (name !== "orElseSucceed" && (!handler || !isFunction(handler) || !paramsUnused(handler) || !returnsQuietly(handler))) return;
    if (before.some((s) => refersTo(s, "Effect", recorded))) return;
    report(call);
  };
  if (steps) steps.forEach((s, i) => check(s, steps.slice(0, i)));
  else if (list(n, "arguments").length === 2) check(n, []);
}

function onlyAsText(fn: Node, name: string): boolean {
  const body = field(fn, "body");
  if (!body) return false;
  const uses = usesOf(body, name, fn);
  if (uses.length === 0) return false;
  return uses.every(({ parent }) => {
    if (parent?.type === "TemplateLiteral") return true;
    if (parent?.type === "MemberExpression" && memberOf(parent)?.name === "message") return true;
    const callee = parent?.type === "CallExpression" ? field(parent, "callee") : undefined;
    return isIdent(callee, "String") || isIdent(callee, "messageOf");
  });
}
function causeAsString(n: Node, report: (n: Node) => void) {
  let fn: Node | undefined;
  if (n.type === "Property" && isIdent(field(n, "key"), "catch")) fn = field(n, "value");
  else if (callName(n, "Effect") === "mapError") fn = list(n, "arguments").at(-1);
  if (!fn || !isFunction(fn)) return;
  const [param] = list(fn, "params");
  if (!isIdent(param) || !onlyAsText(fn, String(param.name))) return;
  const made = unwrap(field(fn, "body"));
  const arg = made?.type === "NewExpression" ? list(made, "arguments")[0] : undefined;
  if (arg?.type !== "ObjectExpression") return;
  const keys = new Set(list(arg, "properties").map((p) => (p.type === "Property" && isIdent(field(p, "key")) ? String(field(p, "key")!.name) : "…")));
  if (!keys.has("cause") && !keys.has("…")) report(n);
}

const waits: Record<string, readonly string[]> = {
  Deferred: ["await"],
  Queue: ["take", "takeAll", "takeN", "takeBetween"],
  Fiber: ["join", "await"],
  Effect: ["sleep", "never"],
  Latch: ["await"],
};
const isWait = (n: Node) =>
  Object.entries(waits).some(([o, names]) => names.includes(callName(n, o) ?? "") || (o === "Effect" && memberName(n, o) === "never"));
function uninterruptibleWait(n: Node, consts: ReadonlyMap<string, Node>, report: (n: Node) => void) {
  let subject: Node | undefined;
  if (callName(n, "Effect") === "uninterruptible") subject = list(n, "arguments")[0];
  const steps = pipeSteps(n);
  if (steps?.some((s) => memberName(s, "Effect") === "uninterruptible") === true) {
    const callee = field(n, "callee");
    subject = memberOf(callee)?.name === "pipe" ? memberOf(callee)!.object : list(n, "arguments")[0];
  }
  if (isIdent(subject)) subject = consts.get(String(subject.name));
  if (subject && contains(subject, isWait)) report(n);
}

function layersBuiltTwice(fn: Node, text: string, report: (n: Node, what: string) => void) {
  const seen = new Map<string, number>();
  const visit = (n: Node) => {
    if (n !== fn && isFunction(n)) return;
    if (n.type === "CallExpression" && list(n, "arguments").length > 0) {
      const callee = field(n, "callee");
      const name = memberOf(callee)?.name ?? (isIdent(callee) ? String(callee.name) : "");
      if (name.startsWith("layer")) {
        const key = `${textOf(text, callee!)}(${list(n, "arguments").map(shapeOf).join(",")})`;
        const count = (seen.get(key) ?? 0) + 1;
        seen.set(key, count);
        if (count === 2) report(n, textOf(text, n).replace(/\s+/gu, " ").slice(0, 80));
      }
    }
    for (const c of childrenOf(n)) visit(c);
  };
  for (const c of childrenOf(fn)) visit(c);
}

type TaggedErrorSite = { readonly file: string; readonly line: number; readonly className: string };
const isTaggedErrorRef = (n: Node | undefined): boolean => isIdent(n, "TaggedError") || memberOf(n)?.name === "TaggedError";
function taggedErrorsIn(program: Node, file: string, line: (offset: number) => number, out: Map<string, TaggedErrorSite[]>) {
  const visit = (n: Node) => {
    if (n.type === "ClassDeclaration" || n.type === "ClassExpression") {
      const sup = field(n, "superClass");
      const callee = sup?.type === "CallExpression" ? field(sup, "callee") : undefined;
      const matches = callee !== undefined && (isTaggedErrorRef(callee) || (callee.type === "CallExpression" && isTaggedErrorRef(field(callee, "callee"))));
      const tagArg = matches && sup ? list(sup, "arguments")[0] : undefined;
      if (tagArg?.type === "Literal" && typeof tagArg.value === "string") {
        const id = field(n, "id");
        const className = isIdent(id) ? String(id.name) : "(anonymous)";
        const sites = out.get(tagArg.value) ?? [];
        sites.push({ file, line: line(n.start ?? 0), className });
        out.set(tagArg.value, sites);
      }
    }
    for (const c of childrenOf(n)) visit(c);
  };
  visit(program);
}

const loopStatements = new Set(["ForStatement", "ForOfStatement", "ForInStatement", "WhileStatement", "DoWhileStatement"]);
function insideLoopExecution(parents: readonly Node[]): boolean {
  for (let i = parents.length - 1; i >= 0; i--) {
    const p = parents[i]!;
    if (loopStatements.has(String(p.type))) return true;
    if (isFunction(p)) {
      if (p.generator === true && callName(parents[i - 1], "Effect") === "gen") continue;
      return false;
    }
  }
  return false;
}

function provideInLoop(n: Node, parents: readonly Node[], report: (n: Node) => void) {
  if (callName(n, "Effect") !== "provide") return;
  const args = list(n, "arguments");
  const provided = args.length === 2 ? args[1] : args[0];
  if (
    provided &&
    (callName(provided, "Context") !== undefined || isIdent(memberOf(provided)?.object, "Context") || isIdent(provided, "ctx") || isIdent(provided, "context"))
  )
    return;
  if (insideLoopExecution(parents)) report(n);
}

const cachedMethods = new Set(["cached", "cachedWithTTL", "cachedInvalidateWithTTL"]);
const standaloneFnHolders = new Set(["VariableDeclarator", "Property", "MethodDefinition", "AssignmentExpression", "ExportDefaultDeclaration"]);
function cachedPerCall(n: Node, parents: readonly Node[], report: (n: Node) => void) {
  if (!cachedMethods.has(callName(n, "Effect") ?? "")) return;
  if (insideLoopExecution(parents)) return report(n);
  const fnIdx = parents.findLastIndex(isFunction);
  if (fnIdx < 0) return;
  const fn = parents[fnIdx]!;
  if (fn.generator === true) return;
  const holder = parents[fnIdx - 1];
  if (fn.type !== "FunctionDeclaration" && !standaloneFnHolders.has(String(holder?.type))) return;
  const body = field(fn, "body");
  const directBody = body === n;
  const directReturn =
    body?.type === "BlockStatement" &&
    parents[fnIdx + 1] === body &&
    parents[fnIdx + 2]?.type === "ReturnStatement" &&
    field(parents[fnIdx + 2]!, "argument") === n;
  if (directBody || directReturn) report(n);
}

function expectInUnjoinedFiber(n: Node, parents: readonly Node[], report: (n: Node) => void) {
  if (!forks.has(callName(n, "Effect") ?? "")) return;
  const subject = list(n, "arguments")[0];
  if (!subject || !contains(subject, isExpectCall)) return;
  // `const f = yield* Effect.forkChild(…)`: joined somewhere in the function that holds f.
  const [p1, p2] = [parents.at(-1), parents.at(-2)];
  const declarator = p1?.type === "YieldExpression" ? p2 : p1;
  const id = declarator?.type === "VariableDeclarator" ? field(declarator, "id") : undefined;
  if (isIdent(id)) {
    const scope = parents.toReversed().find(isFunction) ?? parents[0];
    const joins = (m: Node) => callName(m, "Fiber") === "join" && isIdent(list(m, "arguments")[0], String(id.name));
    if (scope && contains(scope, joins)) return;
  }
  report(n);
}

const failureChecks = new Set(["isFailure", "isSuccess"]);
function failureWithoutReason(statement: Node, report: (n: Node) => void) {
  const e = expectation(statement);
  if (!e) return;
  const callee = field(e.call, "callee");
  const root = memberOf(callee)?.object;
  const subject = root === undefined ? undefined : list(unwrapExpect(root), "arguments")[0];
  const [arg] = list(e.call, "arguments");
  const literal = arg?.type === "Literal" ? arg.value : undefined;
  const truth = e.matcher === "toBeTruthy" ? true : e.matcher === "toBeFalsy" ? false : e.matcher === "toBe" ? literal : undefined;
  const check = subject && (callName(subject, "Exit") ?? callName(subject, "Result"));
  if (check !== undefined && failureChecks.has(check) && typeof truth === "boolean" && (check === "isFailure") === (truth !== e.negated))
    return report(statement);
  if (memberOf(subject)?.name === "_tag" && (e.matcher === "toBe" || e.matcher === "toEqual") && literal === "Failure" && !e.negated) return report(statement);
  if (e.matcher === "toMatchObject" && arg?.type === "ObjectExpression") {
    const props = list(arg, "properties");
    const only = props.length === 1 ? props[0]! : undefined;
    const value = only && field(only, "value");
    if (only && isIdent(field(only, "key"), "_tag") && value?.type === "Literal" && value.value === "Failure") report(statement);
  }
}
/** The `expect(…)` call at the root of a matcher chain. */
function unwrapExpect(n: Node): Node {
  let chain: Node | undefined = n;
  while (chain !== undefined && chain.type !== "CallExpression") chain = memberOf(chain)?.object;
  return chain ?? n;
}

const runs = new Set(["runPromise", "runSync", "runPromiseExit", "runSyncExit", "runFork", "runCallback"]);
const importsFrom = (program: Node, from: (source: string) => boolean) =>
  list(program, "body").some((s) => s.type === "ImportDeclaration" && from(String(field(s, "source")?.value)));

function sharedRuntimeInTest(program: Node, report: (n: Node) => void) {
  const builds = (n: Node) => runs.has(callName(n, "Effect") ?? "") || callName(n, "ManagedRuntime") === "make" || callName(n, "Layer") === "build";
  for (const s of list(program, "body")) {
    const statement = s.type === "ExportNamedDeclaration" ? field(s, "declaration") : s;
    if (statement?.type === "VariableDeclaration" && contains(statement, builds, false)) report(statement);
  }
}

function liveWithTestClock(n: Node, report: (n: Node) => void) {
  if (n.type !== "CallExpression") return;
  let callee = field(n, "callee");
  if (callee?.type === "CallExpression") callee = field(callee, "callee"); // it.live.each(…)(…)
  const m = memberOf(callee);
  const live = m?.name === "live" ? m : memberOf(m?.object)?.name === "live" ? memberOf(m?.object) : undefined;
  if (!live || !isIdent(live.object, "it")) return;
  if (list(n, "arguments").some((a) => contains(a, (x) => memberName(x, "TestClock") !== undefined))) report(n);
}

const testFile = /\.(test|spec)\.tsx?$|(^|\/)testing(\/|\.tsx?$)/u;
const usesEffect = (program: Node) => importsFrom(program, (s) => s === "effect" || s.startsWith("effect/") || s.startsWith("@effect/"));

export function audit(files: ReadonlyArray<{ readonly path: string; readonly text: string }>): Finding[] {
  const findings: Finding[] = [];
  const setups = new Map<string, Setup[]>();
  const errorTags = new Map<string, TaggedErrorSite[]>();
  for (const { path, text } of files) {
    const program: unknown = parseSync(path, text, { lang: path.endsWith(".tsx") ? "tsx" : "ts" }).program;
    if (!isNode(program)) continue;
    const isTest = testFile.test(path);
    const effect = usesEffect(program);
    const line = lineAt(text);
    const add = (rule: Rule) => (n: Node, what?: string) =>
      findings.push({ rule, file: path, line: line(n.start ?? 0), message: `${what ?? textOf(text, n).replace(/\s+/gu, " ").slice(0, 80)}: ${why[rule]}` });
    if (!isTest) {
      // Components hold state without Effect too, so this one reads every source file.
      const flagsIn = (n: Node) => {
        looseFlags(n, add("loose-flags"));
        for (const c of childrenOf(n)) flagsIn(c);
      };
      flagsIn(program);
      taggedErrorsIn(program, path, line, errorTags);
    }
    if (!isTest && !effect) continue;
    const consts = new Map<string, Node>();
    const parents: Node[] = [];
    const visit = (n: Node) => {
      if (n.type === "VariableDeclarator" && isIdent(field(n, "id")) && field(n, "init")) consts.set(String(field(n, "id")!.name), field(n, "init")!);
      for (const c of childrenOf(n)) {
        parents.push(n);
        visit(c);
        parents.pop();
      }
    };
    visit(program);
    const check = (n: Node) => {
      const block = n.type === "BlockStatement" || n.type === "Program" ? list(n, "body") : undefined;
      if (isTest) {
        if (block) turnAsAbsence(block, (s) => add("turn-as-absence")(s));
        if (isFunction(n)) unreleasedGates(n, (at, name) => add("unreleased-gate")(at, `"${name}"`));
        expectInUnjoinedFiber(n, parents, add("expect-in-unjoined-fiber"));
        failureWithoutReason(n, add("failure-without-reason"));
        liveWithTestClock(n, add("live-with-test-clock"));
        if (effect && importsFrom(program, (s) => s === "@effect/vitest") && runs.has(callName(n, "Effect") ?? "")) add("run-in-effect-test")(n);
      }
      if (effect) {
        if (block) forkThenJoin(block, add("fork-then-join"));
        if (block) refReadModifyWrite(block, text, add("ref-read-modify-write"));
        pipeOnEffectFn(n, add("pipe-on-effect-fn"));
        logicInPipe(n, add("logic-in-pipe"));
      }
      if (effect && !isTest) {
        spanAfterResult(n, add("span-after-result"));
        unboundedRetry(n, consts, add("unbounded-retry"));
        if (memberName(n, "Option") === "getOrThrow" || memberName(n, "Option") === "getOrThrowWith") add("option-get-or-throw")(n);
        dieWithPlainError(n, add("die-with-plain-error"));
        swallowWithoutRecord(n, add("swallow-without-record"));
        causeAsString(n, add("cause-as-string"));
        uninterruptibleWait(n, consts, add("uninterruptible-wait"));
        if (isFunction(n) || n.type === "Program") layersBuiltTwice(n, text, add("layer-built-twice"));
        provideInLoop(n, parents, add("provide-in-loop"));
        cachedPerCall(n, parents, add("cached-per-call"));
      }
      for (const c of childrenOf(n)) {
        parents.push(n);
        check(c);
        parents.pop();
      }
    };
    check(program);
    if (isTest) {
      sharedRuntimeInTest(program, add("shared-runtime-in-test"));
      setupsIn(program, path, line, setups);
    }
  }
  for (const copies of setups.values()) {
    if (copies.length < 2) continue;
    const [first, ...rest] = copies;
    findings.push({
      rule: "duplicated-setup",
      file: first!.file,
      line: first!.line,
      message: `${first!.callee}({…}) written ${copies.length} times, also at ${rest.map((s) => `${s.file}:${s.line}`).join(", ")}: ${why["duplicated-setup"]}`,
    });
  }
  for (const [tag, sites] of errorTags) {
    if (sites.length < 2) continue;
    const [first, ...rest] = sites;
    findings.push({
      rule: "duplicate-error-tag",
      file: first!.file,
      line: first!.line,
      message: `_tag "${tag}" (${first!.className}) declared ${sites.length} times, also at ${rest.map((s) => `${s.file}:${s.line}`).join(", ")}: ${why["duplicate-error-tag"]}`,
    });
  }
  return findings.toSorted((a, b) => (a.rule !== b.rule ? a.rule.localeCompare(b.rule) : a.file !== b.file ? a.file.localeCompare(b.file) : a.line - b.line));
}

const scanned = /\.tsx?$/u;
const skipped = /(^|\/)(node_modules|dist|generated)\/|\.d\.ts$/u;

export const ratchetPath = "scripts/audit/practice.ratchet.json";
const words: RatchetWords = { write: "vp run practice:write", see: "See scripts/practice-audit.ts (each rule's message says where it is written)" };

/** Where a finding counts: apps/<app> and packages/<package>, else its top folder. */
export const areaOf = (file: string) => (/^(apps|packages)\//u.test(file) ? file.split("/").slice(0, 2).join("/") : (file.split("/")[0] ?? file));

/** Findings of each rule by area. */
export function countsOf(findings: readonly Finding[]): Counts {
  const counts: Record<string, Record<string, number>> = Object.fromEntries(rules.map((r) => [r, {}]));
  for (const f of findings) {
    const byArea = (counts[f.rule] ??= {});
    byArea[areaOf(f.file)] = (byArea[areaOf(f.file)] ?? 0) + 1;
  }
  return counts;
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { json: { type: "boolean" }, rule: { type: "string", multiple: true }, check: { type: "boolean" }, write: { type: "boolean" } },
  });
  const paths = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", ...positionals], { encoding: "utf8" })
    .split("\n")
    .filter((p) => scanned.test(p) && !skipped.test(p));
  const all = audit(paths.map((path) => ({ path, text: readFileSync(path, "utf8") })));
  if (values.check === true || values.write === true) {
    // The whole repository against the ratchet: a practice the review lists may not come back in new code.
    const now = countsOf(all);
    if (values.write === true) writeFileSync(ratchetPath, JSON.stringify(now, null, 2) + "\n");
    const kept: Counts = values.write === true ? now : JSON.parse(readFileSync(ratchetPath, "utf8"));
    const problems = ratchetProblems(kept, now, words);
    const grown = grownRules(kept, now);
    const touched = grown.size > 0 ? touchedFiles() : new Set<string>();
    for (const f of all) if (grown.has(f.rule) && touched.has(f.file)) console.error(`${f.file}:${f.line}  ${f.rule}  ${f.message}`);
    for (const p of problems) console.error(`practice: ${p}`);
    if (problems.length > 0) process.exit(1);
    console.log(`practice: ${paths.length} files, ${all.length} findings, none new`);
  } else {
    const findings = all.filter((f) => values.rule === undefined || values.rule.includes(f.rule));
    if (values.json === true) console.log(JSON.stringify(findings, null, 2));
    else {
      for (const f of findings) console.log(`${f.file}:${f.line}  ${f.rule}  ${f.message}\n`);
      const counts = new Map<Rule, number>();
      for (const f of findings) counts.set(f.rule, (counts.get(f.rule) ?? 0) + 1);
      const byRule = [...counts].map(([r, n]) => `${r} ${n}`).join(", ");
      console.log(`${paths.length} files, ${findings.length} findings${byRule === "" ? "" : ` (${byRule})`}`);
    }
  }
}
