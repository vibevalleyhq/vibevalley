import { Queue } from "./queue.ts";

/** The values of every source as they come, until all have ended; returning early ends each source. A source that throws
 * ends the merge with its error. */
export async function* merge<A>(...sources: readonly AsyncIterable<A>[]): AsyncGenerator<A> {
  const out = new Queue<{ readonly ok: true; readonly value: A } | { readonly ok: false; readonly error: unknown }>();
  const iterators = sources.map((s) => s[Symbol.asyncIterator]());
  let open = iterators.length;
  const pump = async (it: AsyncIterator<A>) => {
    try {
      for (let r = await it.next(); r.done !== true; r = await it.next()) out.offer({ ok: true, value: r.value });
    } catch (error) {
      out.offer({ ok: false, error });
    } finally {
      open--;
      if (open === 0) out.end();
    }
  };
  for (const it of iterators) void pump(it);
  try {
    for await (const item of out) {
      if (!item.ok) throw item.error;
      yield item.value;
    }
  } finally {
    await Promise.allSettled(iterators.map(async (it) => it.return?.()));
  }
}

export async function* map<A, B>(source: AsyncIterable<A>, f: (a: A) => B | Promise<B>): AsyncGenerator<B> {
  for await (const a of source) yield await f(a);
}

export async function* filter<A>(source: AsyncIterable<A>, keep: (a: A) => boolean): AsyncGenerator<A> {
  for await (const a of source) if (keep(a)) yield a;
}

/** Text split into lines (\n or \r\n), the last kept only if the text ended with it or it is not empty. */
export async function* lines(source: AsyncIterable<string | Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let rest = "";
  for await (const chunk of source) {
    rest += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    let at = rest.indexOf("\n");
    while (at >= 0) {
      yield rest.slice(0, at).replace(/\r$/u, "");
      rest = rest.slice(at + 1);
      at = rest.indexOf("\n");
    }
  }
  rest += decoder.decode();
  if (rest !== "") yield rest.replace(/\r$/u, "");
}

/** Everything a source gives, collected. */
export async function collect<A>(source: AsyncIterable<A>): Promise<A[]> {
  const out: A[] = [];
  for await (const a of source) out.push(a);
  return out;
}

/** f over every item, at most `concurrency` at once, results in the items' order; the first failure rejects (the others
 * still started are left to finish). */
export async function mapConcurrent<A, B>(items: readonly A[], concurrency: number, f: (a: A, i: number) => Promise<B>): Promise<B[]> {
  const out = Array.from<B>({ length: items.length });
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < items.length; i = next++) out[i] = await f(items[i]!, i);
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker));
  return out;
}
