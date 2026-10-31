// What the owner asked for and the page has not seen happen yet: a move, a line said. An intent is kept by its request
// key in an atom family, so it outlives the component that made it (a retry after leaving the channel reuses the key);
// it goes when what the owner sees shows the change (the frame whose seq is at least the reply's, or the kind's own
// check), never when the reply comes or a timer runs out. A timeout or a refusal leaves it failed and in sight, to retry
// with the same key or let go. A feature shows its intents through a pure overlay of its own that sets only the field the
// owner set (features/issue/moves.ts); the page still folds no facts.

import { Atom, type AtomRegistry } from "effect/reactivity";
import { type Accessor } from "solid-js";

import { t } from "@vibevalley/i18n";
import type { StateFrame } from "@vibevalley/protocol";
import { same } from "@vibevalley/protocol/rules";

import { newSendKey, reasonOf } from "@/infra/api";
import type { Frames, Link } from "@/infra/frames";

import { framesAtom, useAtom, useRegistry } from "./atom";

export type IntentStatus = "pending" | "failed";

export interface Intent<I, R> {
  /** The request key: every send of this intent carries it, so the server acts on it once. */
  readonly key: string;
  readonly input: I;
  readonly status: IntentStatus;
  /** Held back while the link was lost; sent once it is back. */
  readonly queued: boolean;
  /** The server's answer, boxed so that an answer of nothing still counts: the change is in, and waits to be shown. */
  readonly replied?: { readonly reply: R };
  /** Why it failed, in the owner's words. */
  readonly reason?: string;
}

export interface IntentKind<I, R> {
  /** Sends it with its key; a repeat with the same key is the same request. */
  readonly send: (input: I, key: string) => Promise<R>;
  /**
   * What the owner sees shows the change; asked on every frame, whenever `watch` says, and when the server answers.
   * A kind whose change carries its key (a line's sendKey) may say so before any reply, a lost one included.
   */
  readonly confirmed: (frame: StateFrame | undefined, intent: Intent<I, R>) => boolean;
  /** A source the check reads besides the frame (a channel's messages): watched while the intent is kept. */
  readonly watch?: (input: I, changed: () => void) => () => void;
  /** While the state stream is lost a keyed kind queues and sends once it is back; one that is not safe to repeat refuses. */
  readonly whileLost: "queue" | "refuse";
  /** No sign of it this long after it was sent: failed, kept for a retry. */
  readonly timeoutMs: number;
}

/** A reply that carries the seq of the fold with its change (an issue moved): shown once a frame has caught up. */
export const bySeq = <I>(frame: StateFrame | undefined, intent: Intent<I, { readonly seq: number }>) =>
  intent.replied !== undefined && frame !== undefined && frame.seq >= intent.replied.reply.seq;

export interface IntentType<I, R> {
  readonly kind: IntentKind<I, R>;
  readonly one: (key: string) => Atom.Writable<Intent<I, R> | undefined>;
  readonly keys: Atom.Writable<readonly string[]>;
  readonly all: Atom.Atom<readonly Intent<I, R>[]>;
  readonly runners: WeakMap<AtomRegistry.AtomRegistry, Intents<I, R>>;
}

export function defineIntent<I, R>(kind: IntentKind<I, R>): IntentType<I, R> {
  // Not kept alive: a runner mounts each while it keeps the intent, so a settled one leaves nothing behind.
  const one = Atom.family((_key: string) => Atom.make<Intent<I, R> | undefined>(undefined));
  const keys = Atom.keepAlive(Atom.make<readonly string[]>([]));
  const all = Atom.make((get) => get(keys).flatMap((k) => get(one(k)) ?? []));
  return { kind, one, keys, all, runners: new WeakMap() };
}

/** An intent on its way: `done` is the intent once the server answered (`replied`) or it failed (`status`), undefined
 * when it was let go first. A retry answers for itself. */
export interface Sent<I, R> {
  readonly key: string;
  readonly done: Promise<Intent<I, R> | undefined>;
}

export interface Intents<I, R> {
  readonly send: (input: I) => Sent<I, R>;
  /** A failed one again, with its key. */
  readonly retry: (key: string) => Promise<Intent<I, R> | undefined>;
  /** Lets one go, failed or not; returns it, for its words to go back in the box. */
  readonly drop: (key: string) => Intent<I, R> | undefined;
  readonly get: (key: string) => Intent<I, R> | undefined;
  readonly all: () => readonly Intent<I, R>[];
}

/**
 * An intent made by a button rather than typed (a suggestion, the project map's sow, an artifact's reply): pressed again
 * while one with the same input is kept, it is that one, sent again with its key if it failed.
 */
export function sendOnce<I, R>(intents: Intents<I, R>, input: I): Promise<Intent<I, R> | undefined> {
  const kept = intents.all().find((i) => same(i.input, input));
  if (!kept) return intents.send(input).done;
  return kept.status === "failed" ? intents.retry(kept.key) : Promise.resolve(kept);
}

/**
 * A setting the owner changes again before the first change showed (a reaction off and on, a level picked twice): the
 * newer is the one kept, and the older is let go, so the overlay shows the last choice and one failure at most.
 */
export function sendReplacing<I, R>(intents: Intents<I, R>, input: I, sameTarget: (a: I, b: I) => boolean): Sent<I, R> {
  for (const kept of intents.all()) if (sameTarget(kept.input, input)) intents.drop(kept.key);
  return intents.send(input);
}

/** A type's intents in one registry; the same object for every caller, so its timers and watches are kept once. */
export function intentsIn<I, R>(registry: AtomRegistry.AtomRegistry, type: IntentType<I, R>): Intents<I, R> {
  const made = type.runners.get(registry);
  if (made) return made;
  const runner = makeRunner(registry, type);
  type.runners.set(registry, runner);
  return runner;
}

/** A type's intents in the page's registry, with the list as an accessor. */
export function useIntents<I, R>(type: IntentType<I, R>): Intents<I, R> & { readonly list: Accessor<readonly Intent<I, R>[]> } {
  const registry = useRegistry();
  return { ...intentsIn(registry, type), list: useAtom(type.all, registry) };
}

function makeRunner<I, R>(registry: AtomRegistry.AtomRegistry, type: IntentType<I, R>): Intents<I, R> {
  const { kind } = type;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const watches = new Map<string, () => void>();
  // A retry starts a new attempt: what an earlier one comes back with no longer decides the intent.
  const attempts = new Map<string, number>();
  const waiting = new Map<string, ((answered: Intent<I, R> | undefined) => void)[]>();
  const mounts = new Map<string, () => void>();
  let unframe: (() => void) | undefined;
  let link: Link | undefined;

  const get = (key: string) => registry.get(type.one(key));
  const frames = (): Frames => registry.get(framesAtom);
  const put = (key: string, intent: Intent<I, R>) => {
    if (!mounts.has(key)) mounts.set(key, registry.mount(type.one(key)));
    registry.set(type.one(key), intent);
    if (!registry.get(type.keys).includes(key)) registry.update(type.keys, (all) => [...all, key]);
  };
  const answer = (key: string, answered: Intent<I, R> | undefined) => {
    for (const resolve of waiting.get(key) ?? []) resolve(answered);
    waiting.delete(key);
  };
  const waitFor = (key: string) => new Promise<Intent<I, R> | undefined>((resolve) => waiting.set(key, [...(waiting.get(key) ?? []), resolve]));

  const remove = (key: string) => {
    clearTimeout(timers.get(key));
    timers.delete(key);
    watches.get(key)?.();
    watches.delete(key);
    attempts.delete(key);
    answer(key, undefined);
    registry.update(type.keys, (all) => all.filter((k) => k !== key));
    registry.set(type.one(key), undefined);
    mounts.get(key)?.();
    mounts.delete(key);
    if (registry.get(type.keys).length === 0) {
      unframe?.();
      unframe = undefined;
    }
  };

  const check = (key: string) => {
    const intent = get(key);
    // Failed ones too: replied and then timed out waiting, or a reply lost after the change went in.
    if (intent && !intent.queued && kind.confirmed(frames().frame, intent)) remove(key);
  };

  const failed = (key: string, reason: string) => {
    const intent = get(key);
    if (!intent) return;
    clearTimeout(timers.get(key));
    timers.delete(key);
    const now: Intent<I, R> = { ...intent, status: "failed", reason };
    put(key, now);
    answer(key, now);
  };

  const arm = (key: string) => {
    clearTimeout(timers.get(key));
    timers.set(
      key,
      setTimeout(() => failed(key, t("web.base.intent.timedOut")), kind.timeoutMs),
    );
  };

  // While any intent is kept the frames are read, so the stream stays open even when the page that made it is gone.
  const follow = () => {
    if (unframe) return;
    link = frames().link;
    unframe = registry.subscribe(framesAtom, (now) => {
      const back = now.link === "open" && link !== "open";
      link = now.link;
      for (const key of registry.get(type.keys)) {
        if (back && get(key)?.queued === true) dispatch(key);
        else check(key);
      }
    });
  };

  const dispatch = (key: string) => {
    const intent = get(key);
    if (!intent) return;
    const attempt = (attempts.get(key) ?? 0) + 1;
    attempts.set(key, attempt);
    put(key, { key, input: intent.input, status: "pending", queued: false, ...(intent.replied === undefined ? {} : { replied: intent.replied }) });
    arm(key);
    void kind.send(intent.input, key).then(
      (reply) => {
        const now = get(key);
        if (!now) return;
        // A late reply after a timeout still counts: the change went in.
        const replied: Intent<I, R> = { key, input: now.input, status: "pending", queued: false, replied: { reply } };
        put(key, replied);
        if (now.status === "failed") arm(key);
        answer(key, replied);
        check(key);
      },
      (e: unknown) => {
        if (attempts.get(key) !== attempt) return;
        failed(key, reasonOf(e));
        check(key);
      },
    );
  };

  const start = (key: string, input: I) => {
    follow();
    if (kind.watch && !watches.has(key))
      watches.set(
        key,
        kind.watch(input, () => check(key)),
      );
    const lost = frames().link === "lost";
    if (lost && kind.whileLost === "refuse") {
      const refused: Intent<I, R> = { key, input, status: "failed", queued: false, reason: t("web.base.intent.offline") };
      put(key, refused);
      return Promise.resolve(refused);
    }
    const done = waitFor(key);
    if (lost) put(key, { key, input, status: "pending", queued: true });
    else {
      put(key, { key, input, status: "pending", queued: false });
      dispatch(key);
    }
    return done;
  };

  return {
    send: (input) => {
      const key = newSendKey();
      return { key, done: start(key, input) };
    },
    retry: (key) => {
      const intent = get(key);
      if (intent?.status !== "failed") return Promise.resolve(undefined);
      return start(key, intent.input);
    },
    drop: (key) => {
      const intent = get(key);
      if (intent) remove(key);
      return intent;
    },
    get,
    all: () => registry.get(type.all),
  };
}
