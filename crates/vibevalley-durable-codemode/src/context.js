(function (native, now, random, count, fail, compile, { tickName, stringName, maxVars, maxString, maxMemory }) {
  const define = Object.defineProperty,
    keys = Object.keys,
    parse = JSON.parse,
    stringify = JSON.stringify;
  const apply = Reflect.apply,
    construct = Reflect.construct,
    rawEval = eval;
  const lock = (target, name, value) => define(target, name, { value, writable: false, configurable: false });
  let steps = 0,
    memoryCharged = 0,
    initialKeys;
  function tick() {
    count();
    if (++steps % 16 === 0) checkGlobals();
  }
  function checkGlobals() {
    if (keys(globalThis).length - initialKeys > maxVars) fail("script quota exceeded: global variable limit");
  }
  function charge(n) {
    if (n > 0) memoryCharged += n;
    if (memoryCharged > maxMemory) fail("script quota exceeded: memory");
  }
  function checked(value) {
    if (typeof value === "string") {
      if (value.length > maxString) fail("script quota exceeded: string length");
      charge(value.length);
    }
    return value;
  }
  function call(name, args) {
    if (typeof name !== "string" || !name) throw new TypeError("call requires a tool name");
    const reply = parse(native("call", name, stringify(args === undefined ? null : args)));
    if (reply.error !== undefined) throw new Error(reply.error);
    return reply.value;
  }
  function sleep(duration) {
    const n = Number(duration);
    if (n === Infinity || n >= 9223372036854) throw new RangeError("sleep duration overflow");
    native("sleep", "", stringify(n > 0 ? Math.trunc(n) : 0));
  }
  Object.assign(globalThis, { call, callTool: call, sleep, rand: random, clock: { now }, vibe: { call, sleep, now, random } });
  const NativeDate = Date;
  const date = new Proxy(NativeDate, {
    construct(target, args, newTarget) {
      return construct(target, args.length ? args : [now()], newTarget);
    },
    apply() {
      return new NativeDate(now()).toString();
    },
  });
  lock(date, "now", now);
  define(NativeDate.prototype, "constructor", { value: date });
  globalThis.Date = date;
  lock(Math, "random", random);

  globalThis.eval = (source) => (typeof source === "string" ? rawEval(compile(source)) : source);
  for (const [ctor, prefix] of [
    [Function, "function"],
    [async function () {}.constructor, "async function"],
    [function* () {}.constructor, "function*"],
    [async function* () {}.constructor, "async function*"],
  ]) {
    function build(args) {
      const body = String(args.pop() ?? "");
      return rawEval(compile("(" + prefix + "(" + args.map(String).join(",") + "){\n" + body + "\n})"));
    }
    const checkedCtor = new Proxy(ctor, {
      apply(_target, _self, args) {
        return build(args);
      },
      construct(_target, args) {
        return build(args);
      },
    });
    define(ctor.prototype, "constructor", { value: checkedCtor });
    if (ctor === Function) globalThis.Function = checkedCtor;
  }
  function guard(proto, name, check) {
    const original = proto[name];
    define(proto, name, {
      value: function (...args) {
        check(this, args);
        return checked(apply(original, this, args));
      },
    });
  }
  guard(String.prototype, "repeat", (s, a) => {
    if (String(s).length * Number(a[0]) > maxString) fail("script quota exceeded: repeat");
  });
  for (const name of ["padStart", "padEnd"])
    guard(String.prototype, name, (_s, a) => {
      if (Number(a[0]) > maxString) fail("script quota exceeded: pad");
    });
  guard(Array.prototype, "join", (a, args) => {
    if ((a.length - 1) * String(args[0] === undefined ? "," : args[0]).length > maxString) fail("script quota exceeded: join");
  });
  guard(String.prototype, "concat", (s, args) => {
    let length = String(s).length;
    for (const part of args) length += String(part).length;
    if (length > maxString) fail("script quota exceeded: concat");
  });
  guard(Array.prototype, "fill", (a) => charge(a.length * 16));
  for (const op of ["push", "unshift", "splice"]) guard(Array.prototype, op, (_a, args) => charge(16 * (args.length + 1)));
  function guardConstructor(name, before) {
    const original = globalThis[name];
    if (typeof original !== "function") return;
    const proxy = new Proxy(original, {
      construct(target, args, newTarget) {
        before(args);
        return construct(target, args, newTarget);
      },
      apply(target, receiver, args) {
        before(args);
        return apply(target, receiver, args);
      },
    });
    globalThis[name] = proxy;
    define(original.prototype, "constructor", { value: proxy });
  }
  guardConstructor("Array", (a) => {
    if (a.length > 1) charge(16 * a.length);
  });
  guardConstructor("ArrayBuffer", (a) => charge(Number(a[0])));
  for (const name of ["slice", "resize", "transfer", "transferToFixedLength"]) {
    if (typeof ArrayBuffer.prototype[name] === "function")
      guard(ArrayBuffer.prototype, name, (buffer, args) => {
        const requested = name === "slice" ? Math.max(0, Number(args[1] ?? buffer.byteLength) - Number(args[0] ?? 0)) : Number(args[0] ?? buffer.byteLength);
        charge(requested);
      });
  }
  for (const name of [
    "Int8Array",
    "Uint8Array",
    "Uint8ClampedArray",
    "Int16Array",
    "Uint16Array",
    "Int32Array",
    "Uint32Array",
    "Float32Array",
    "Float64Array",
    "BigInt64Array",
    "BigUint64Array",
  ]) {
    const size = globalThis[name]?.BYTES_PER_ELEMENT;
    if (size)
      guardConstructor(name, (a) => {
        const data = a[0];
        if (typeof data === "number") charge(size * data);
        else if (data != null && !(data instanceof ArrayBuffer)) charge(size * Number(data.length ?? 0));
      });
  }
  guard(JSON, "stringify", () => {});
  lock(globalThis, tickName, tick);
  lock(globalThis, stringName, checked);
  initialKeys = keys(globalThis).length;
  return checkGlobals;
});
