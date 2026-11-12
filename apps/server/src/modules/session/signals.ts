import type * as T from "@vibevalley/protocol";

export interface SessionIdentity {
  readonly id: string;
  readonly role: T.AgentRole;
  readonly agent: string;
  readonly name: string;
  readonly runtime: string;
  readonly brief: string;
}

/** A message the helper was not handed; reason is what the sender is told. */
export class DeliveryRefused extends Error {
  override readonly name = "DeliveryRefused";
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.reason = reason;
  }
}

/** What came of handing a helper a message. */
export interface Delivered {
  readonly kind: "run" | "steered" | "queued";
  readonly launch: string;
  readonly woke?: boolean;
}

/** What a helper's launch did: it spoke, its turn ended or closed, it compacts. */
export type LaunchActivity =
  | { readonly _tag: "Spoke"; readonly id: string; readonly launch: string }
  | { readonly _tag: "Ended"; readonly id: string; readonly launch: string; readonly outcome: T.Outcome; readonly spoke: boolean }
  | { readonly _tag: "HandedOff"; readonly id: string; readonly launch: string; readonly outcome: T.Outcome; readonly spoke: boolean }
  | { readonly _tag: "Settling"; readonly id: string; readonly launch: string }
  | { readonly _tag: "Closed"; readonly id: string; readonly launch: string }
  | { readonly _tag: "Compacting"; readonly id: string; readonly on: boolean };

export interface RunFinished {
  readonly id: string;
  readonly issues: T.IssueId[];
  readonly outcome: T.Outcome;
}

/** The messages a helper took as input: they are seen. */
export interface Consumed {
  readonly session: string;
  readonly envelopeIds: readonly string[];
}

/** Inputs returned before the runtime consumed them. */
export interface Returned {
  readonly session: string;
  readonly envelopeIds: readonly string[];
}

export interface DeliveryInput {
  readonly trigger: T.RunTrigger;
  readonly envelopeIds: readonly string[];
  readonly byUserComment: boolean;
}

/** Everything Session tells, in the order it happened: a helper hired, reported or gone (with the session as it stood
 * after; none once it left), a run started on an issue or finished, its inputs taken or given back, and what its
 * launch did. */
export type SessionNews =
  | { readonly _tag: "Hired"; readonly session: T.Session }
  | { readonly _tag: "Reported"; readonly report: Extract<T.Fact, { type: "sessionReported" }>; readonly session: T.Session | undefined }
  | { readonly _tag: "Left"; readonly left: Extract<T.Fact, { type: "sessionLeft" }> }
  | { readonly _tag: "IssueStarted"; readonly issue: string }
  | ({ readonly _tag: "RunFinished" } & RunFinished)
  | ({ readonly _tag: "Consumed" } & Consumed)
  | ({ readonly _tag: "Returned" } & Returned)
  | LaunchActivity;
