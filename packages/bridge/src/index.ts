import { z } from "zod";

/** Any Schema a contract may hold: what is read is its output, and what is sent is checked by it before it goes. */
export type AnyCodec = z.ZodType;

export interface Call<I extends AnyCodec, O extends AnyCodec> {
  readonly kind: "call";
  readonly input: I;
  readonly output: O;
  /** How long the asking side waits for the answer: callTimeoutMs when left out, none when Infinity (a call that waits
   * for the person, or for a download). */
  readonly timeoutMs?: number;
}

/** A side that does not answer in this long has hung: its call is refused so the caller and its entry do not wait forever. */
export const callTimeoutMs = 15_000;

export interface Push<P extends AnyCodec> {
  readonly kind: "push";
  readonly payload: P;
}

export type Contract = Readonly<Record<string, Call<AnyCodec, AnyCodec> | Push<AnyCodec>>>;

/** A call the asking side makes and the answering side answers once. */
export const call = <I extends AnyCodec, O extends AnyCodec>(o: { readonly input: I; readonly output: O; readonly timeoutMs?: number }): Call<I, O> => ({
  kind: "call",
  ...o,
});

/** What the answering side sends on its own, as often as it happens. */
export const push = <P extends AnyCodec>(payload: P): Push<P> => ({ kind: "push", payload });

export type CallName<C extends Contract> = { [K in keyof C]: C[K] extends Call<AnyCodec, AnyCodec> ? K : never }[keyof C] & string;
export type PushName<C extends Contract> = { [K in keyof C]: C[K] extends Push<AnyCodec> ? K : never }[keyof C] & string;
export type InputOf<C extends Contract, K extends keyof C> = C[K] extends Call<infer I, AnyCodec> ? z.output<I> : never;
export type OutputOf<C extends Contract, K extends keyof C> = C[K] extends Call<AnyCodec, infer O> ? z.output<O> : never;
export type PayloadOf<C extends Contract, K extends keyof C> = C[K] extends Push<infer P> ? z.output<P> : never;

export type Handlers<C extends Contract> = { readonly [K in CallName<C>]: (input: InputOf<C, K>) => OutputOf<C, K> | Promise<OutputOf<C, K>> };

export type Calls<C extends Contract> = { readonly [K in CallName<C>]: (input: InputOf<C, K>) => Promise<OutputOf<C, K>> };

/** Input, output and payload as the contract's Schemas checked them; a void one is left out. */
export const BridgeMessage = z.union([
  z.object({ id: z.number(), call: z.string(), input: z.exactOptional(z.unknown()) }),
  z.object({ id: z.number(), ok: z.literal(true), output: z.exactOptional(z.unknown()) }),
  z.object({ id: z.number(), ok: z.literal(false), error: z.string() }),
  z.object({ push: z.string(), payload: z.exactOptional(z.unknown()) }),
]);
export type BridgeMessage = z.infer<typeof BridgeMessage>;

/** A link that carries text (a WebView) does the JSON itself. */
export interface Link {
  readonly send: (message: BridgeMessage) => void;
  readonly receive: (fn: (message: unknown) => void) => () => void;
}

/** A call the other side refused, with its reason: its input did not decode, its handler failed, or the bridge closed. */
export class BridgeError extends Error {
  override readonly name = "BridgeError";
}

const readMessage = (raw: unknown) => BridgeMessage.safeParse(raw);

/** What goes out is the value itself, once its Schema takes it: the contracts' shapes are their own wire form (plain JSON). */
const checked = (schema: AnyCodec, value: unknown): { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: z.ZodError } => {
  const got = schema.safeParse(value);
  return got.success ? { ok: true, value } : { ok: false, error: got.error };
};
const reasonOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

const entryOf = (contract: Contract, name: string) => (Object.hasOwn(contract, name) ? contract[name] : undefined);

/** Nothing is answered after close. */
export function serve<C extends Contract>(contract: C, link: Link, handlers: Handlers<C>) {
  let closed = false;
  const replyTo = async (id: number, name: string, input: unknown): Promise<BridgeMessage> => {
    const refuse = (e: unknown): BridgeMessage => ({ id, ok: false, error: reasonOf(e) });
    const entry = entryOf(contract, name);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- each handler is given what its own call's Schema decoded, below
    const byName = handlers as unknown as Readonly<Record<string, ((input: unknown) => unknown) | undefined>>;
    const handler = Object.hasOwn(byName, name) ? byName[name] : undefined;
    if (entry?.kind !== "call" || handler === undefined) return refuse(new BridgeError(`no call ${name}`));
    const read = entry.input.safeParse(input);
    if (!read.success) return refuse(read.error);
    let output: unknown;
    try {
      output = await handler(read.data);
    } catch (e) {
      return refuse(e);
    }
    const sent = checked(entry.output, output);
    return sent.ok ? { id, ok: true, output: sent.value } : refuse(sent.error);
  };
  const answer = async (id: number, name: string, input: unknown) => {
    const reply = await replyTo(id, name, input);
    if (!closed) link.send(reply);
  };
  const stop = link.receive((raw) => {
    const m = readMessage(raw);
    if (closed || !m.success || !("call" in m.data)) return;
    void answer(m.data.id, m.data.call, m.data.input);
  });
  return {
    push: <K extends PushName<C>>(name: K, payload: PayloadOf<C, K>) => {
      const entry = entryOf(contract, name);
      if (closed || entry?.kind !== "push") return;
      // A payload its own Schema does not take is the caller's mistake: it throws to the one pushing it.
      const sent = checked(entry.payload, payload);
      if (!sent.ok) throw sent.error;
      link.send({ push: name, payload: sent.value });
    },
    close: () => {
      closed = true;
      stop();
    },
  };
}

/** close rejects what is still unanswered and hears nothing after. */
export function connect<C extends Contract>(contract: C, link: Link) {
  let next = 1;
  let closed = false;
  const waiting = new Map<
    number,
    { readonly output: AnyCodec; readonly resolve: (v: unknown) => void; readonly reject: (e: Error) => void; readonly timer?: ReturnType<typeof setTimeout> }
  >();
  const listeners = new Map<string, Set<(payload: unknown) => void>>();

  const stop = link.receive((raw) => {
    const read = readMessage(raw);
    if (closed || !read.success) return;
    const m = read.data;
    if ("push" in m) {
      const entry = entryOf(contract, m.push);
      const decoded = entry?.kind === "push" ? entry.payload.safeParse(m.payload) : undefined;
      if (decoded?.success !== true) return;
      // One listener that throws does not keep the push from the others.
      for (const fn of listeners.get(m.push) ?? [])
        try {
          fn(decoded.data);
        } catch (e) {
          queueMicrotask(() => {
            throw e;
          });
        }
      return;
    }
    if (!("ok" in m)) return;
    const w = waiting.get(m.id);
    if (!w) return;
    waiting.delete(m.id);
    clearTimeout(w.timer);
    if (!m.ok) return w.reject(new BridgeError(m.error));
    const output = w.output.safeParse(m.output);
    if (!output.success) w.reject(new BridgeError(reasonOf(output.error)));
    else w.resolve(output.data);
  });

  const ask = (name: string, entry: Call<AnyCodec, AnyCodec>, input: unknown) =>
    new Promise<unknown>((resolve, reject) => {
      if (closed) return reject(new BridgeError("the bridge is closed"));
      const encoded = checked(entry.input, input);
      if (!encoded.ok) return reject(encoded.error);
      const id = next++;
      const timeoutMs = entry.timeoutMs ?? callTimeoutMs;
      const timer =
        timeoutMs === Infinity
          ? undefined
          : setTimeout(() => {
              if (!waiting.delete(id)) return;
              reject(new BridgeError(`${name} was not answered in ${timeoutMs} ms`));
            }, timeoutMs);
      waiting.set(id, { output: entry.output, resolve, reject, ...(timer ? { timer } : {}) });
      link.send({ id, call: name, input: encoded.value });
    });

  const methods = Object.fromEntries(
    Object.entries(contract).flatMap(([name, entry]) => (entry.kind === "call" ? [[name, (input: unknown) => ask(name, entry, input)]] : [])),
  );

  return {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- one method per call of the contract, each sending its input by that call's Schema and reading the answer by its output's
    call: methods as Calls<C>,
    on: <K extends PushName<C>>(name: K, fn: (payload: PayloadOf<C, K>) => void): (() => void) => {
      const heard = (payload: unknown) => {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- decoded by this push's own Schema above
        fn(payload as PayloadOf<C, K>);
      };
      const set = listeners.get(name) ?? new Set();
      listeners.set(name, set.add(heard));
      return () => void set.delete(heard);
    },
    close: () => {
      closed = true;
      stop();
      for (const w of waiting.values()) {
        clearTimeout(w.timer);
        w.reject(new BridgeError("the bridge is closed"));
      }
      waiting.clear();
    },
  };
}
