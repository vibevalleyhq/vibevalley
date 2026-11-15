export type MossErrorReason = "Credentials" | "InvalidInput" | "Network" | "Timeout" | "HttpStatus" | "InvalidResponse" | "TooLarge";
export type MossErrorOutcome = "NotSubmitted" | "Rejected" | "Unknown";

/** The fields every MOSS error carries: what failed, whether the request may have taken effect, the HTTP status and vendor code. */
export interface MossErrorFields {
  readonly reason: MossErrorReason;
  readonly outcome: MossErrorOutcome;
  readonly status?: number;
  readonly code?: string;
}

/** Failure from any MOSS HTTP or stream call, carrying structured reason, submission outcome, and optional HTTP status/vendor code. */
export class MossError extends Error {
  override readonly name = "MossError";
  readonly reason: MossErrorReason;
  readonly outcome: MossErrorOutcome;
  declare readonly status?: number;
  declare readonly code?: string;

  constructor(fields: MossErrorFields) {
    super(`MOSS: ${fields.reason}`);
    this.reason = fields.reason;
    this.outcome = fields.outcome;
    if (fields.status !== undefined) this.status = fields.status;
    if (fields.code !== undefined) this.code = fields.code;
  }
}
