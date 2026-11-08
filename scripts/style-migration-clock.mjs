const NativeDate = globalThis.Date;
const now = NativeDate.parse("2026-11-08T12:00:00.000Z");

// Timers keep running; only wall-clock reads are frozen in the isolated evidence server.
globalThis.Date = new Proxy(NativeDate, {
  apply: () => new NativeDate(now).toString(),
  construct: (target, args, newTarget) => Reflect.construct(target, args.length === 0 ? [now] : args, newTarget),
  get: (target, property, receiver) => (property === "now" ? () => now : Reflect.get(target, property, receiver)),
});
