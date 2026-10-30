// Calls between two programs that share no types at run time (a page and its desktop or phone shell), written once as a
// contract: each call's input and output, each push's payload, as Schemas. The side that answers decodes what comes in;
// the side that asks gets typed methods. What carries the messages is a Link, which knows nothing of the contract.

import { Schema } from "effect";

/** Any Schema a contract may hold: its type and its encoded form, needing no services. */
export type AnyCodec = Schema.Codec<unknown, unknown>;

export interface Call<I extends AnyCodec, O extends AnyCodec> {
  readonly kind: "call";
  readonly input: I;
  readonly output: O;
}

export interface Push<P extends AnyCodec> {
  readonly kind: "push";
  readonly payload: P;
}

export type Contract = Readonly<Record<string, Call<AnyCodec, AnyCodec> | Push<AnyCodec>>>;

/** A call the asking side makes and the answering side answers once. */
export const call = <I extends AnyCodec, O extends AnyCodec>(o: { readonly input: I; readonly output: O }): Call<I, O> => ({ kind: "call", ...o });

/** What the answering side sends on its own, as often as it happens. */
export const push = <P extends AnyCodec>(payload: P): Push<P> => ({ kind: "push", payload });

export type CallName<C extends Contract> = { [K in keyof C]: C[K] extends Call<AnyCodec, AnyCodec> ? K : never }[keyof C] & string;
export type PushName<C extends Contract> = { [K in keyof C]: C[K] extends Push<AnyCodec> ? K : never }[keyof C] & string;
export type InputOf<C extends Contract, K extends keyof C> = C[K] extends Call<infer I, AnyCodec> ? I["Type"] : never;
export type OutputOf<C extends Contract, K extends keyof C> = C[K] extends Call<AnyCodec, infer O> ? O["Type"] : never;
export type PayloadOf<C extends Contract, K extends keyof C> = C[K] extends Push<infer P> ? P["Type"] : never;

/** The answering side's handlers: one for each call, and no call left out. */
export type Handlers<C extends Contract> = { readonly [K in CallName<C>]: (input: InputOf<C, K>) => OutputOf<C, K> | Promise<OutputOf<C, K>> };

/** The asking side's methods: one for each call. */
export type Calls<C extends Contract> = { readonly [K in CallName<C>]: (input: InputOf<C, K>) => Promise<OutputOf<C, K>> };

/** What goes over a link: a call by its id, its answer by the same id, and a push. Input, output and payload are
 * encoded by the contract's Schemas; a void one is left out. */
export const BridgeMessage = Schema.Union([
  Schema.Struct({ id: Schema.Finite, call: Schema.String, input: Schema.optionalKey(Schema.Unknown) }),
  Schema.Struct({ id: Schema.Finite, ok: Schema.Literal(true), output: Schema.optionalKey(Schema.Unknown) }),
  Schema.Struct({ id: Schema.Finite, ok: Schema.Literal(false), error: Schema.String }),
  Schema.Struct({ push: Schema.String, payload: Schema.optionalKey(Schema.Unknown) }),
]);
export type BridgeMessage = typeof BridgeMessage.Type;

/** A way to the other side: send a message, and hear each one that comes back until the returned function is called. A
 * link that carries text (a WebView) does the JSON itself. */
export interface Link {
  readonly send: (message: BridgeMessage) => void;
  readonly receive: (fn: (message: unknown) => void) => () => void;
}

/** A call the other side refused, with its reason: its input did not decode, its handler failed, or the bridge closed. */
export class BridgeError extends Error {
  override readonly name = "BridgeError";
}

const readMessage = Schema.decodeUnknownOption(BridgeMessage);
const reasonOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

const entryOf = (contract: Contract, name: string) => (Object.hasOwn(contract, name) ? contract[name] : undefined);

/** Answers the calls that come over link with handlers, and sends pushes. Nothing is answered after close. */
export function serve<C extends Contract>(contract: C, link: Link, handlers: Handlers<C>) {
  let closed = false;
  const answer = async (id: number, name: string, input: unknown) => {
    const entry = entryOf(contract, name);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- each handler is given what its own call's Schema decoded, below
    const byName = handlers as unknown as Readonly<Record<string, ((input: unknown) => unknown) | undefined>>;
    const handler = Object.hasOwn(byName, name) ? byName[name] : undefined;
    let reply: BridgeMessage;
    try {
      if (entry?.kind !== "call" || handler === undefined) throw new BridgeError(`no call ${name}`);
      const read = Schema.decodeUnknownSync(entry.input)(input);
      const output: unknown = await handler(read);
      reply = { id, ok: true, output: Schema.encodeUnknownSync(entry.output)(output) };
    } catch (e) {
      reply = { id, ok: false, error: reasonOf(e) };
    }
    if (!closed) link.send(reply);
  };
  const stop = link.receive((raw) => {
    const m = readMessage(raw);
    if (closed || m._tag === "None" || !("call" in m.value)) return;
    void answer(m.value.id, m.value.call, m.value.input);
  });
  return {
    push: <K extends PushName<C>>(name: K, payload: PayloadOf<C, K>) => {
      const entry = entryOf(contract, name);
      if (closed || entry?.kind !== "push") return;
      link.send({ push: name, payload: Schema.encodeUnknownSync(entry.payload)(payload) });
    },
    close: () => {
      closed = true;
      stop();
    },
  };
}

/** The asking side: a method for each call, answered over link, and the pushes it hears. close rejects what is still
 * unanswered and hears nothing after. */
export function connect<C extends Contract>(contract: C, link: Link) {
  let next = 1;
  let closed = false;
  const waiting = new Map<number, { readonly output: AnyCodec; readonly resolve: (v: unknown) => void; readonly reject: (e: Error) => void }>();
  const listeners = new Map<string, Set<(payload: unknown) => void>>();

  const stop = link.receive((raw) => {
    const read = readMessage(raw);
    if (closed || read._tag === "None") return;
    const m = read.value;
    if ("push" in m) {
      const entry = entryOf(contract, m.push);
      const decoded = entry?.kind === "push" ? Schema.decodeUnknownOption(entry.payload)(m.payload) : undefined;
      if (decoded?._tag === "Some") for (const fn of listeners.get(m.push) ?? []) fn(decoded.value);
      return;
    }
    if (!("ok" in m)) return;
    const w = waiting.get(m.id);
    if (!w) return;
    waiting.delete(m.id);
    if (!m.ok) return w.reject(new BridgeError(m.error));
    try {
      w.resolve(Schema.decodeUnknownSync(w.output)(m.output));
    } catch (e) {
      w.reject(new BridgeError(reasonOf(e)));
    }
  });

  const ask = (name: string, entry: Call<AnyCodec, AnyCodec>, input: unknown) =>
    new Promise<unknown>((resolve, reject) => {
      if (closed) return reject(new BridgeError("the bridge is closed"));
      const encoded = Schema.encodeUnknownSync(entry.input)(input);
      const id = next++;
      waiting.set(id, { output: entry.output, resolve, reject });
      link.send({ id, call: name, input: encoded });
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
      for (const w of waiting.values()) w.reject(new BridgeError("the bridge is closed"));
      waiting.clear();
    },
  };
}
