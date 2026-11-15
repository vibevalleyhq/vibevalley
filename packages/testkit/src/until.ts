export class WaitTimedOut extends Error {
  override readonly name = "WaitTimedOut";
}

const gaps = [1, 2, 5, 15, 30];
const aMoment = (asked: number, cap: number) => new Promise<void>((r) => setTimeout(r, Math.min(gaps[Math.min(asked, gaps.length - 1)] ?? 30, cap)));
const said = (what: string | (() => string)) => (typeof what === "string" ? what : what());

/** What get answers once ok holds for it. what is said if it never does (a function: read when it is given up on). */
export const waitFor = async <A>(get: () => A | Promise<A>, ok: (a: A) => boolean, what: string | (() => string), ms = 5_000): Promise<A> => {
  const deadline = performance.now() + ms;
  const timedOut = () => new WaitTimedOut(`waited for ${said(what)}`);
  for (let asked = 0; ; asked++) {
    const left = Math.max(0, deadline - performance.now());
    const a = await new Promise<A>((resolve, reject) => {
      const timer = setTimeout(() => reject(timedOut()), left);
      Promise.resolve()
        .then(get)
        .then(
          (v) => {
            clearTimeout(timer);
            resolve(v);
          },
          (e: unknown) => {
            clearTimeout(timer);
            reject(e);
          },
        );
    });
    if (ok(a)) return a;
    const rest = deadline - performance.now();
    if (rest <= 0) throw timedOut();
    await aMoment(asked, rest);
  }
};

/** The value get gives once it is something. */
export const untilGot = async <A>(get: () => A | undefined | false | Promise<A | undefined | false>, what: string | (() => string), ms = 5_000): Promise<A> => {
  const got = await waitFor(get, (g) => g !== undefined && g !== false, what, ms);
  if (got === undefined || got === false) throw new WaitTimedOut(`waited for ${said(what)}`);
  return got;
};

/** Once ok holds. */
export const until = async (ok: () => boolean | Promise<boolean>, what: string | (() => string) = "it", ms = 5_000): Promise<void> => {
  await waitFor(ok, (held) => held, what, ms);
};

/** until under the name the promise-written tests (a fake runtime, a fake model) already use. */
export const whenTrue = (ok: () => boolean | Promise<boolean>, what: string, ms = 5_000): Promise<void> => until(ok, what, ms);

/** What p settles to, or a rejection naming what took longer than ms (real time): a deadline on something the test
 * cannot see the end of otherwise. */
export const within = <A>(p: Promise<A>, ms: number, what: string): Promise<A> =>
  new Promise<A>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} took longer than ${ms} ms`)), ms);
    p.finally(() => clearTimeout(timer)).then(resolve, reject);
  });

/** A gate a fake waits at until the test opens it: a fake that should be busy is busy until the test says, not for a
 * guessed while. */
export const gate = () => {
  const { promise: opened, resolve: open } = Promise.withResolvers<void>();
  return { opened, open };
};

/** One turn of the event loop: whatever was set going before it (a publish taken by a forked reader, a promise already resolved) has run. */
export const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));
