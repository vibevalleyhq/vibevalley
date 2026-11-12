import { randomBytes } from "node:crypto";

import type { SubagentReport } from "@botiverse/oar/agents";

import type { Semaphore } from "@vibevalley/async";
import type * as T from "@vibevalley/protocol";

import type { Workplace } from "#/modules/repo/workplace.ts";

import type { Journal } from "./journal.ts";
import type { Tracking } from "./reaction.ts";

/** The platform's AsyncDisposableStack (Node 24), as far as a hand uses it: cleanups run last-added first, once. */
export interface HandStack extends AsyncDisposable {
  readonly defer: (cleanup: () => PromiseLike<void> | void) => void;
  readonly disposeAsync: () => Promise<void>;
  readonly disposed: boolean;
}

// The server's lib (ES2024) does not declare AsyncDisposableStack yet, though Node 24 has it; with esnext.disposable in
// apps/server/tsconfig.json this becomes `new AsyncDisposableStack()`.
const platformStack: unknown = Reflect.get(globalThis, "AsyncDisposableStack");

export function handStack(): HandStack {
  if (typeof platformStack !== "function") throw new Error("AsyncDisposableStack is missing: the server runs on Node 24");
  const made: unknown = Reflect.construct(platformStack, []);
  if (!isHandStack(made)) throw new Error("AsyncDisposableStack is not the platform's");
  return made;
}

const isHandStack = (v: unknown): v is HandStack =>
  typeof v === "object" && v !== null && typeof Reflect.get(v, "defer") === "function" && typeof Reflect.get(v, "disposeAsync") === "function";

export interface Hand {
  readonly id: T.SessionId;
  /** What closes when the hand leaves (its log, its credential): disposed once, last-deferred first. */
  readonly stack: HandStack;
  readonly place: Workplace;
  /** Retained for run attribution even while the session is between assignments. */
  readonly issue: string;
  readonly access: Semaphore;
  readonly journal: Journal;
  /** `""` between launches. */
  oarSessionId: string;
  lastText: string;
  tracking: Tracking;
  /** `<id>#<n>`, or `""` when detached. */
  launch: string;
  spoke: boolean;
  /** Cleared to `""` on leave. */
  token: string;
  recalled: Set<string>;
  triggers: { readonly trigger: T.RunTrigger; readonly envelopeIds: readonly string[]; readonly inputId?: string }[];
  readonly inputs: Map<string, readonly string[]>;
  run: string;
  /** The run a restart left under way, for the turn that goes on with it to take up rather than start another. */
  goesOn?: string;
  heard: string[];
  report: T.IssueReport | undefined;
  settling?: { readonly report: SubagentReport; readonly completedBefore: number };
}

/** Owns live `Hand` entries, MCP bearer tokens, and the `hand.access -> admission` lock order. */
export function makeHandRoster(admission: Semaphore) {
  const byId = new Map<string, Hand>();
  const tokens = new Map<string, string>();

  const revokeToken = (hand: Hand) => {
    tokens.delete(hand.token);
    hand.token = "";
  };

  const issueToken = (hand: Hand) => {
    revokeToken(hand);
    const token = "hb_" + hand.id + "_" + randomBytes(18).toString("base64url");
    hand.token = token;
    tokens.set(token, hand.id);
    return token;
  };

  /** use under the hand's lock, if the hand is still the one on the roster once the lock is held; onMissing otherwise.
   * The signal stops only the waiting for the lock. */
  const withHand = async <A>(id: string, onMissing: () => A | Promise<A>, use: (hand: Hand) => Promise<A>, signal?: AbortSignal): Promise<A> => {
    const hand = byId.get(id);
    if (!hand) return onMissing();
    return hand.access.with(async () => (byId.get(id) === hand ? use(hand) : onMissing()), 1, signal);
  };

  /** As withHand, also holding admission: always taken after the hand's lock, never before. */
  const withHandAndAdmission = async <A>(id: string, onMissing: () => A | Promise<A>, use: (hand: Hand) => Promise<A>): Promise<A> => {
    const hand = byId.get(id);
    if (!hand) return onMissing();
    return hand.access.with(() => admission.with(async () => (byId.get(id) === hand ? use(hand) : onMissing())));
  };

  return {
    get: (id: string) => byId.get(id),
    has: (id: string) => byId.has(id),
    get size() {
      return byId.size;
    },
    values: (): readonly Hand[] => [...byId.values()],
    set: (hand: Hand) => {
      byId.set(hand.id, hand);
    },
    delete: (hand: Hand) => {
      if (byId.get(hand.id) === hand) byId.delete(hand.id);
    },
    withHand,
    withHandAndAdmission,
    issueToken,
    revokeToken,
    clearTokens: () => tokens.clear(),
    who: (token: string) => tokens.get(token) ?? "",
  };
}
