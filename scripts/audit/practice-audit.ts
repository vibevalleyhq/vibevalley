import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { parseSync } from "vite";

import { type Counts, type RatchetWords, grownRules, ratchetProblems, touchedFiles } from "./ratchet.ts";

/** Syntax, not text: each rule stands for a practice written in docs/style/module-design.md, the testable-boundaries Note or the vv-typescript skill. */

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
  "expect-in-floating-promise",
  "failure-without-reason",
  "shared-farm-in-test",
] as const;
const sourceRules = ["unbounded-retry", "read-modify-write", "swallow-without-record", "cause-as-string", "loose-flags", "duplicate-error-class"] as const;
export type Rule = (typeof testRules)[number] | (typeof sourceRules)[number];
export const rules: readonly Rule[] = [...testRules, ...sourceRules];
export type Finding = { readonly rule: Rule; readonly file: string; readonly line: number; readonly message: string };

const skill = ".agents/skills/vv-typescript/SKILL.md";
const why: Record<Rule, string> = {
  "turn-as-absence":
    "one turn of the event loop is not a boundary: a later run can still do what this says did not happen. " +
    "Fix: wait for a finished operation, a confirmed step of the fake or a window of the test clock (vi.advanceTimersByTimeAsync), then assert; or say in a comment why nothing can come later. " +
    "See .agents/notes/proposed/testing/2026-11-08-testable-module-boundaries.md (4.)",
  "unreleased-gate":
    "something waits at this gate but nothing in the test opens it or hands it on, so the waiter only ends when the test is torn down. " +
    "Fix: open it on the path the test means (resolve() / gate.open()), and in a finally when an expect can fail first. " +
    "See docs/style/module-design.md",
  "duplicated-setup":
    "the same setup is written out again: a change to it has to find every copy. " +
    "Fix: make it one helper next to the tests (or in src/testing) taking only what differs. " +
    "See .agents/notes/proposed/testing/2026-11-08-testable-module-boundaries.md (5.)",
  "expect-in-floating-promise":
    "an expect in a promise nothing awaits (void …, a bare .then, an async callback handed to a timer): when it fails, the rejection lands nowhere, or after the test, and the test still passes. " +
    "Fix: await it before the test ends, or collect what it sees and assert in the test's own flow. " +
    `See ${skill} (9.)`,
  "failure-without-reason":
    "this says it failed but not how: a TypeError from a bug, an abort or the wrong error passes it too. " +
    "Fix: const e = await x.catch((e: unknown) => e); expect(e).toBeInstanceOf(TheError) / toMatchObject({ bizCode: … }), or toThrow(TheError) / toThrow(/what/). " +
    `See ${skill} (11.)`,
  "shared-farm-in-test":
    "a farm, a database or a service built once at the top of a test file: state from one test leaks into the next, and nothing closes it. " +
    "Fix: build it in each test with await using; share only what is costly, in beforeAll with its afterAll, and say what is shared. " +
    `See ${skill} (9.)`,
  "unbounded-retry":
    "a retry with no upper bound turns one outage into forever. " +
    "Fix: retry(f, { retries: n, delay: exponential(…), when, signal }) from @vibevalley/async; retry only what is safe to do twice. " +
    `See ${skill} (4.)`,
  "read-modify-write":
    "a read, then an await, then a write of the same thing: another task can write between them, and its write is lost. " +
    "Fix: do the read and the write with no await between, or hold one lock around the three (Semaphore.with). " +
    `See ${skill} (4.)`,
  "swallow-without-record":
    "every failure becomes an ordinary value and nothing is noted: a broken source looks like an empty one. " +
    "Fix: catch only what is expected (instanceof) and rethrow the rest, or log it before going on; when dropping it really is right, say why in a comment there. " +
    `See ${skill} (2.)`,
  "cause-as-string":
    "the outside failure is kept only as text: its stack, status and the library's own error are gone. " +
    "Fix: pass it whole as cause (new X(message, { cause: e })); say it to the user where it is handled, with t(). " +
    `See ${skill} (2.)`,
  "loose-flags":
    "several flags kept loose in one function (let x = false…, createSignal(false)…): when they move together they are one state machine whose impossible combinations nothing stops. " +
    "Fix: one union, a tag per state with what that state holds, in one let, signal or Cell; keep a flag apart only when it is a dimension of its own (it can be true in any of the states). " +
    "See docs/style/module-design.md (显式状态)",
  "duplicate-error-class":
    "two Error subclasses share one name, so logs, the gateway's answer and a reader of instanceof cannot tell them apart across module boundaries. " +
    "Fix: give each Error subclass a distinct domain name, and its name field the same string. " +
    `See ${skill} (2.)`,
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
  // `await x`, `(x)`, `x!`, `x as T` all wait for or are x.
  while (n && ["AwaitExpression", "ParenthesizedExpression", "TSNonNullExpression", "TSAsExpression", "ChainExpression"].includes(String(n.type)))
    n = field(n, "argument") ?? field(n, "expression");
  return n;
};
const isFunction = (n: Node) => n.type === "ArrowFunctionExpression" || n.type === "FunctionExpression" || n.type === "FunctionDeclaration";
const textOf = (text: string, n: Node) => text.slice(n.start, n.end);

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

const memberName = (n: Node | undefined, object: string): string | undefined => {
  const m = memberOf(n);
  return m !== undefined && isIdent(m.object, object) ? m.name : undefined;
};

/** Whether any node under n (n too) satisfies ok; inside nested functions only when asked. */
function contains(n: Node, ok: (n: Node) => boolean, intoFunctions = true): boolean {
  const visit = (m: Node, top: boolean): boolean => {
    if (!top && !intoFunctions && isFunction(m)) return false;
    if (ok(m)) return true;
    return childrenOf(m).some((c) => visit(c, false));
  };
  return visit(n, true);
}
const isExpectCall = (n: Node) => n.type === "CallExpression" && isIdent(field(n, "callee"), "expect");
const isAwait = (n: Node) => n.type === "AwaitExpression" || (n.type === "ForOfStatement" && n.await === true);

/** The one thing a function returns: its expression body, or a body that is only `return x`. undefined: it does more. */
const onlyReturn = (fn: Node): { value: Node | undefined } | undefined => {
  const body = field(fn, "body");
  if (!body) return undefined;
  if (body.type !== "BlockStatement") return { value: body };
  const statements = list(body, "body");
  if (statements.length === 0) return { value: undefined };
  return statements.length === 1 && statements[0]!.type === "ReturnStatement" ? { value: field(statements[0]!, "argument") } : undefined;
};

/** A timer that runs its callback on a later turn, with no wait of its own. */
const turnTimers = new Set(["setImmediate", "queueMicrotask", "setTimeout"]);
const isTurnTimer = (callee: Node | undefined, args: readonly Node[]) =>
  (isIdent(callee) && turnTimers.has(String(callee.name)) && (args[1] === undefined || (args[1].type === "Literal" && args[1].value === 0))) ||
  memberName(callee, "process") === "nextTick";
const turnWaits = new Set(["aTurn", "nextTurn"]);
/** `await aTurn()`, `await Promise.resolve()`, `await new Promise((r) => setImmediate(r))` and the like. */
function isOneTurn(statement: Node): boolean {
  if (statement.type !== "ExpressionStatement") return false;
  const raw = field(statement, "expression");
  if (raw?.type !== "AwaitExpression") return false;
  const n = unwrap(raw);
  if (isIdent(n) && turnWaits.has(String(n.name))) return true;
  if (n?.type === "CallExpression" && list(n, "arguments").length === 0) {
    const callee = field(n, "callee");
    if (isIdent(callee) && turnWaits.has(String(callee.name))) return true;
    if (memberName(callee, "Promise") === "resolve") return true;
  }
  if (n?.type === "NewExpression" && isIdent(field(n, "callee"), "Promise")) {
    const [executor] = list(n, "arguments");
    if (isIdent(executor) && turnTimers.has(String(executor.name))) return true;
    const value = executor && isFunction(executor) ? onlyReturn(executor)?.value : undefined;
    const call = unwrap(value);
    if (call?.type === "CallExpression" && isTurnTimer(field(call, "callee"), list(call, "arguments"))) return true;
  }
  return false;
}

/** Reads `expect(…)[.not|.resolves|.rejects…].matcher(…)`. */
function expectation(statement: Node): { matcher: string; call: Node; negated: boolean; rejects: boolean; subject: Node | undefined } | undefined {
  if (statement.type !== "ExpressionStatement") return undefined;
  const call = unwrap(field(statement, "expression"));
  if (call?.type !== "CallExpression") return undefined;
  const matcher = memberOf(field(call, "callee"));
  if (!matcher) return undefined;
  let chain: Node | undefined = matcher.object;
  let negated = false;
  let rejects = false;
  while (chain !== undefined && chain.type !== "CallExpression") {
    const m = memberOf(chain);
    if (!m) return undefined;
    if (m.name === "not") negated = true;
    if (m.name === "rejects") rejects = true;
    chain = m.object;
  }
  return chain !== undefined && isIdent(field(chain, "callee"), "expect")
    ? { matcher: matcher.name, call, negated, rejects, subject: list(chain, "arguments")[0] }
    : undefined;
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

/** A gate: `Promise.withResolvers()` or testkit's `gate()`, whole (its members open and wait) or taken apart (its names do). */
type Gate = {
  readonly name: string;
  readonly at: Node;
  readonly scope: Node;
  readonly opens: ReadonlySet<string>;
  readonly waits: ReadonlySet<string>;
  readonly apart: boolean;
};
const gateKinds = { resolvers: { opens: ["resolve", "reject"], waits: ["promise"] }, gate: { opens: ["open"], waits: ["opened"] } } as const;

function gatesDeclaredIn(fn: Node): Gate[] {
  const gates: Gate[] = [];
  const visit = (n: Node) => {
    if (n !== fn && isFunction(n)) return;
    if (n.type === "VariableDeclarator") {
      const init = unwrap(field(n, "init"));
      const id = field(n, "id");
      const callee = init?.type === "CallExpression" ? field(init, "callee") : undefined;
      const kind = memberName(callee, "Promise") === "withResolvers" ? gateKinds.resolvers : isIdent(callee, "gate") ? gateKinds.gate : undefined;
      if (kind && id && isIdent(id))
        gates.push({ name: String(id.name), at: n, scope: fn, opens: new Set(kind.opens), waits: new Set(kind.waits), apart: false });
      if (kind && id?.type === "ObjectPattern") {
        const names: Record<string, string> = {};
        for (const p of list(id, "properties")) {
          const key = field(p, "key");
          const value = field(p, "value");
          if (isIdent(key) && isIdent(value)) names[String(key.name)] = String(value.name);
        }
        const opens = kind.opens.flatMap((k) => (names[k] === undefined ? [] : [names[k]]));
        const waits = kind.waits.flatMap((k) => (names[k] === undefined ? [] : [names[k]]));
        gates.push({ name: waits[0] ?? opens[0] ?? "gate", at: n, scope: fn, opens: new Set(opens), waits: new Set(waits), apart: true });
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
function usesOf(scope: Node, name: string, skip: Node | undefined): Use[] {
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
  if (gate.apart) {
    if (gate.opens.has(name)) return parent?.type === "CallExpression" && parent.callee === node ? "opens" : "escapes";
    return parent?.type === "AwaitExpression" || (parent?.type === "MemberExpression" && memberOf(parent)?.name === "then") ? "waits" : "escapes";
  }
  const m = parent && memberOf(parent);
  if (m && gate.opens.has(m.name)) return grand?.type === "CallExpression" && grand.callee === parent ? "opens" : "escapes";
  if (m && gate.waits.has(m.name)) return "waits";
  return "escapes";
}

function unreleasedGates(fn: Node, report: (n: Node, name: string) => void) {
  for (const gate of gatesDeclaredIn(fn)) {
    const names = gate.apart ? [...gate.opens, ...gate.waits] : [gate.name];
    const roles = new Set(names.flatMap((name) => usesOf(gate.scope, name, field(gate.at, "id")).map((u) => roleOf(gate, u, name))));
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

/** A promise that runs an expect and that nothing waits for: `void (async () => …)()`, a bare `.then(…)`, a timer's callback. */
const settles = new Set(["then", "catch", "finally"]);
function floatsAnExpect(n: Node | undefined): boolean {
  n = n?.type === "ParenthesizedExpression" ? field(n, "expression") : n;
  if (n?.type !== "CallExpression") return false;
  const callee = unwrap(field(n, "callee"));
  const args = list(n, "arguments");
  const hasExpect = (xs: readonly Node[]) => xs.some((x) => contains(x, isExpectCall));
  if (settles.has(memberOf(callee)?.name ?? "")) return hasExpect([n]);
  if (callee && isFunction(callee) && callee.async === true) return contains(callee, isExpectCall);
  if (isTurnTimer(callee, args) || isIdent(callee, "setInterval") || (isIdent(callee, "setTimeout") && args.length > 0)) return hasExpect(args);
  return false;
}
function expectInFloatingPromise(block: Node, body: Node[], report: (n: Node) => void) {
  for (const s of body) {
    if (s.type === "ExpressionStatement") {
      const e = field(s, "expression");
      if (e?.type === "UnaryExpression" && e.operator === "void" && field(e, "argument") && contains(field(e, "argument")!, isExpectCall)) report(s);
      else if (floatsAnExpect(e)) report(s);
    }
    // `const p = (async () => { expect(…) })();` and p never used again.
    if (s.type === "VariableDeclaration" && list(s, "declarations").length === 1) {
      const d = list(s, "declarations")[0]!;
      const id = field(d, "id");
      if (isIdent(id) && floatsAnExpect(field(d, "init")) && usesOf(block, String(id.name), id).length === 0) report(s);
    }
  }
}

const anyError = (n: Node | undefined) => isIdent(n, "Error");
function failureWithoutReason(statement: Node, report: (n: Node) => void) {
  const e = expectation(statement);
  if (!e || e.negated) return;
  const args = list(e.call, "arguments");
  if ((e.matcher === "toThrow" || e.matcher === "toThrowError") && (args.length === 0 || anyError(args[0]))) return report(statement);
  if (e.matcher === "toBeInstanceOf" && anyError(args[0])) return report(statement);
  if (e.rejects && ["toBeDefined", "toBeTruthy"].includes(e.matcher)) return report(statement);
}

/** A test file's top-level declaration that builds something once for every test: a top-level await, or a farm. */
const builders = new Set(["world", "moduleWorld", "testDb", "makeFarm"]);
function sharedFarmInTest(program: Node, report: (n: Node) => void) {
  const builds = (n: Node) => n.type === "AwaitExpression" || (n.type === "CallExpression" && builders.has(calleeName(field(n, "callee"))));
  for (const s of list(program, "body")) {
    const statement = s.type === "ExportNamedDeclaration" ? field(s, "declaration") : s;
    if (statement?.type === "VariableDeclaration" && contains(statement, builds, false)) report(statement);
  }
}

const isInfinite = (n: Node | undefined) =>
  isIdent(n, "Infinity") || memberName(n, "Number") === "POSITIVE_INFINITY" || memberName(n, "Number") === "MAX_SAFE_INTEGER";
const propertyNamed = (o: Node | undefined, key: string) =>
  o?.type === "ObjectExpression" ? list(o, "properties").find((p) => p.type === "Property" && isIdent(field(p, "key"), key)) : undefined;
const forever = (n: Node) =>
  ((n.type === "WhileStatement" || n.type === "DoWhileStatement") && field(n, "test")?.type === "Literal" && field(n, "test")!.value === true) ||
  (n.type === "ForStatement" && field(n, "test") === undefined);
const leaves = (n: Node) => n.type === "ThrowStatement" || n.type === "ReturnStatement" || n.type === "BreakStatement";
/** `retry(f, { retries: Infinity })`, or a loop that never ends by itself, leaves on success and only goes round again on failure. */
function unboundedRetry(n: Node, report: (n: Node) => void) {
  if (n.type === "CallExpression" && (isIdent(field(n, "callee"), "retry") || memberOf(field(n, "callee"))?.name === "retry")) {
    const retries = propertyNamed(list(n, "arguments")[1], "retries");
    if (retries && isInfinite(field(retries, "value"))) report(n);
    return;
  }
  if (!forever(n)) return;
  const body = field(n, "body");
  const statements = body?.type === "BlockStatement" ? list(body, "body") : body ? [body] : [];
  for (const s of statements) {
    if (s.type !== "TryStatement") continue;
    const tried = field(s, "block");
    const handler = field(s, "handler");
    const caught = handler && field(handler, "body");
    if (tried && caught && contains(tried, (m) => m.type === "ReturnStatement" || m.type === "BreakStatement", false) && !contains(caught, leaves, false))
      return report(n);
  }
}

/** Calls that hold a lock around what they run. */
const locked = new Set(["with", "withLock", "runExclusive", "exclusive", "locked"]);
const underLock = (parents: readonly Node[]) =>
  parents.some(
    (p) =>
      p.type === "CallExpression" && locked.has(memberOf(field(p, "callee"))?.name ?? (isIdent(field(p, "callee")) ? String(field(p, "callee")!.name) : "")),
  );
/** `const v = x.get(k)`, then an await, then `x.set(k, …v…)` in the same block: a write made from what was read before
 * the await. A write that does not use the read (a cache filled after its miss) loses nothing; a read again after the
 * await is the re-check this asks for. */
function readModifyWrite(body: Node[], text: string, parents: readonly Node[], report: (n: Node, what: string) => void) {
  if (underLock(parents)) return;
  for (let i = 0; i < body.length; i++) {
    const s = body[i]!;
    const ds = s.type === "VariableDeclaration" ? list(s, "declarations") : [];
    const read = ds.length === 1 ? unwrap(field(ds[0]!, "init")) : undefined;
    const readId = ds.length === 1 ? field(ds[0]!, "id") : undefined;
    const got = read?.type === "CallExpression" ? memberOf(field(read, "callee")) : undefined;
    if (!read || !isIdent(readId) || got?.name !== "get" || got.object.type === "ThisExpression") continue;
    const readName = String(readId.name);
    const target = textOf(text, got.object);
    const key = list(read, "arguments")[0];
    const keyText = key === undefined ? undefined : textOf(text, key);
    let awaited = false;
    for (let j = i + 1; j < body.length; j++) {
      const at = body[j]!;
      let write: Node | undefined;
      const visit = (m: Node, top: boolean) => {
        if (write || (!top && isFunction(m))) return;
        const set = m.type === "CallExpression" ? memberOf(field(m, "callee")) : undefined;
        const first = list(m, "arguments")[0];
        if (set?.name === "set" && textOf(text, set.object) === target && (keyText === undefined || (first !== undefined && textOf(text, first) === keyText))) {
          write = m;
          return;
        }
        for (const c of childrenOf(m)) visit(c, false);
      };
      visit(at, true);
      const awaitBefore = (w: Node) => contains(at, (m) => isAwait(m) && (m.start ?? 0) < (w.start ?? 0), false);
      const found: Node | undefined = write;
      if (found) {
        const fromRead = list(found, "arguments").some((a) => usesOf(a, readName, undefined).length > 0);
        if (fromRead && (awaited || awaitBefore(found))) report(found, `${target}.get(${keyText ?? ""}) … await … ${target}.set`);
        break;
      }
      const readsAgain = (m: Node) =>
        m.type === "CallExpression" && memberOf(field(m, "callee"))?.name === "get" && textOf(text, memberOf(field(m, "callee"))!.object) === target;
      if (contains(at, readsAgain, false)) awaited = false;
      else if (contains(at, isAwait, false)) awaited = true;
    }
  }
}

/** A comment in n, on the line above it or after it on its last line: a swallow that says why. */
const commented = (text: string, n: Node) => {
  const inner = textOf(text, n);
  if (inner.includes("//") || inner.includes("/*")) return true;
  const before = text.slice(0, n.start).split("\n");
  const above = (before.at(-2) ?? "").trim();
  const sameLine = (before.at(-1) ?? "").trim();
  const after = text.slice(n.end).split("\n")[0] ?? "";
  return above.startsWith("//") || above.endsWith("*/") || sameLine.startsWith("//") || after.includes("//");
};
const quiet = (v: Node | undefined): boolean =>
  v === undefined ||
  isIdent(v, "undefined") ||
  v.type === "Literal" ||
  (v.type === "ArrayExpression" && list(v, "elements").length === 0) ||
  (v.type === "ObjectExpression" && list(v, "properties").length === 0) ||
  (v.type === "UnaryExpression" && v.operator === "void");
const unusedParams = (fn: Node, params: readonly Node[]) => {
  const body = field(fn, "body");
  return params.every((p) => !isIdent(p) || !body || usesOf(body, String(p.name), p).length === 0);
};
/** `catch {}`, `catch { return undefined }`, `.catch(() => undefined)`, `.catch(() => {})` with nothing said about it. */
function swallowWithoutRecord(n: Node, text: string, report: (n: Node) => void) {
  if (n.type === "CatchClause") {
    const body = field(n, "body");
    const statements = body ? list(body, "body") : [];
    const param = field(n, "param");
    const unused = !param || !isIdent(param) || !body || usesOf(body, String(param.name), param).length === 0;
    const silent =
      statements.length === 0 || (statements.length === 1 && statements[0]!.type === "ReturnStatement" && quiet(field(statements[0]!, "argument")));
    if (unused && silent && !commented(text, n)) report(n);
    return;
  }
  if (n.type !== "CallExpression" || memberOf(field(n, "callee"))?.name !== "catch") return;
  const [handler] = list(n, "arguments");
  if (!handler || !isFunction(handler)) return;
  // A release on the way out (reader.cancel(), rollback): its own failure has nothing left to tell.
  const caught = unwrap(memberOf(field(n, "callee"))?.object);
  if (releases.has(caught?.type === "CallExpression" ? (memberOf(unwrap(field(caught, "callee")))?.name ?? "") : "")) return;
  const returned = onlyReturn(handler);
  if (returned && quiet(returned.value) && unusedParams(handler, list(handler, "params")) && !commented(text, handler)) report(n);
}

const releases = new Set(["cancel", "close", "destroy", "abort", "dispose", "kill", "rollback", "unlink", "rm", "return"]);
const asText = new Set(["String", "messageOf", "causeMessage", "errorMessage"]);
/** Whether every use of name in n is as text. */
function onlyAsText(n: Node, name: string): boolean {
  const uses = usesOf(n, name, undefined);
  if (uses.length === 0) return false;
  return uses.every(({ parent }) => {
    if (parent?.type === "TemplateLiteral") return true;
    if (parent?.type === "MemberExpression" && memberOf(parent)?.name === "message") return true;
    const callee = parent?.type === "CallExpression" ? field(parent, "callee") : undefined;
    return isIdent(callee) && asText.has(String(callee.name));
  });
}
/** In a catch (a clause, or `.catch((e) => …)`): a new error made from e's text alone, with no cause. */
function causeAsString(n: Node, report: (n: Node) => void) {
  let param: Node | undefined;
  let body: Node | undefined;
  if (n.type === "CatchClause") [param, body] = [field(n, "param"), field(n, "body")];
  else if (n.type === "CallExpression" && memberOf(field(n, "callee"))?.name === "catch") {
    const [handler] = list(n, "arguments");
    if (handler && isFunction(handler)) [param, body] = [list(handler, "params")[0], field(handler, "body")];
  }
  if (!isIdent(param) || !body) return;
  const name = String(param.name);
  const made: Node[] = [];
  const visit = (m: Node, top: boolean) => {
    if (!top && isFunction(m)) return;
    if (m.type === "ThrowStatement" || m === body) {
      const made1 = unwrap(field(m, "argument") ?? (body.type === "BlockStatement" ? undefined : body));
      if (made1?.type === "NewExpression") made.push(made1);
    }
    for (const c of childrenOf(m)) visit(c, false);
  };
  visit(body, true);
  for (const m of made) {
    const args = list(m, "arguments");
    const keepsCause = args.some(
      (a) => a.type === "ObjectExpression" && list(a, "properties").some((p) => p.type !== "Property" || isIdent(field(p, "key"), "cause")),
    );
    if (!keepsCause && onlyAsText(m, name) && !args.some((a) => isIdent(a, name))) report(m);
  }
}

type ErrorClassSite = { readonly file: string; readonly line: number; readonly className: string };
/** Classes that extend Error or another …Error, by the name they go by: their `name = "…"` field, else the class's. */
function errorClassesIn(program: Node, file: string, line: (offset: number) => number, out: Map<string, ErrorClassSite[]>) {
  const visit = (n: Node) => {
    if (n.type === "ClassDeclaration" || n.type === "ClassExpression") {
      const sup = field(n, "superClass");
      const superName = isIdent(sup) ? String(sup.name) : memberOf(sup)?.name;
      const id = field(n, "id");
      const className = isIdent(id) ? String(id.name) : undefined;
      if (className !== undefined && superName !== undefined && /Error$|^DOMException$/u.test(superName)) {
        const named = list(field(n, "body") ?? n, "body").find((m) => m.type === "PropertyDefinition" && isIdent(field(m, "key"), "name"));
        const value = named && field(named, "value");
        const name = value?.type === "Literal" && typeof value.value === "string" ? value.value : className;
        out.set(name, [...(out.get(name) ?? []), { file, line: line(n.start ?? 0), className }]);
      }
    }
    for (const c of childrenOf(n)) visit(c);
  };
  visit(program);
}

const testFile = /\.(test|spec)\.tsx?$|(^|\/)testing(\/|\.tsx?$)|(^|\/)test\//u;

export function audit(files: ReadonlyArray<{ readonly path: string; readonly text: string }>): Finding[] {
  const findings: Finding[] = [];
  const setups = new Map<string, Setup[]>();
  const errorClasses = new Map<string, ErrorClassSite[]>();
  for (const { path, text } of files) {
    const program: unknown = parseSync(path, text, { lang: path.endsWith(".tsx") ? "tsx" : "ts" }).program;
    if (!isNode(program)) continue;
    const isTest = testFile.test(path);
    const line = lineAt(text);
    const add = (rule: Rule) => (n: Node, what?: string) =>
      findings.push({ rule, file: path, line: line(n.start ?? 0), message: `${what ?? textOf(text, n).replace(/\s+/gu, " ").slice(0, 80)}: ${why[rule]}` });
    if (!isTest) errorClassesIn(program, path, line, errorClasses);
    const parents: Node[] = [];
    const check = (n: Node) => {
      const block = n.type === "BlockStatement" || n.type === "Program" ? list(n, "body") : undefined;
      if (isTest) {
        if (block) turnAsAbsence(block, (s) => add("turn-as-absence")(s));
        if (block) expectInFloatingPromise(n, block, add("expect-in-floating-promise"));
        if (isFunction(n)) unreleasedGates(n, (at, name) => add("unreleased-gate")(at, `"${name}"`));
        failureWithoutReason(n, add("failure-without-reason"));
      } else {
        looseFlags(n, add("loose-flags"));
        unboundedRetry(n, add("unbounded-retry"));
        if (block) readModifyWrite(block, text, parents, add("read-modify-write"));
        swallowWithoutRecord(n, text, add("swallow-without-record"));
        causeAsString(n, add("cause-as-string"));
      }
      for (const c of childrenOf(n)) {
        parents.push(n);
        check(c);
        parents.pop();
      }
    };
    check(program);
    if (isTest) {
      sharedFarmInTest(program, add("shared-farm-in-test"));
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
  for (const [name, sites] of errorClasses) {
    if (sites.length < 2) continue;
    const [first, ...rest] = sites;
    findings.push({
      rule: "duplicate-error-class",
      file: first!.file,
      line: first!.line,
      message: `error "${name}" (${first!.className}) declared ${sites.length} times, also at ${rest.map((s) => `${s.file}:${s.line}`).join(", ")}: ${why["duplicate-error-class"]}`,
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
    .filter((p) => scanned.test(p) && !skipped.test(p) && existsSync(p));
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
