/** What a thrown or rejected value says: an Error's message, anything else as text. */
export const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** A failed system call's code (ENOENT, EPERM…), or undefined for anything else. */
export const errnoOf = (e: unknown): string | undefined => (e instanceof Error && "code" in e && typeof e.code === "string" ? e.code : undefined);

const withCause = (cause: unknown) => (cause === undefined ? undefined : { cause });

/** A tool that did not do what it was asked: its message is the failed result the model reads. */
export class ToolFailed extends Error {
  override readonly name = "ToolFailed";
  readonly _tag = "ToolFailed";
  constructor(message: string, cause?: unknown) {
    super(message, withCause(cause));
  }
  static make(fields: { readonly message: string; readonly cause?: unknown }): ToolFailed {
    return new ToolFailed(fields.message, fields.cause);
  }
}

/** What a tool's body threw or rejected with, or the agent it started failed with, as the failed result. */
export const toolFailed = (e: unknown): ToolFailed => new ToolFailed(messageOf(e), e);

/** A run asked of an agent that is already running one. */
export class AgentBusy extends Error {
  override readonly name = "AgentBusy";
  readonly _tag = "AgentBusy";
}

/** continue with nothing to go on from: no messages yet, or an answer and nothing steered or queued after it. */
export class CannotContinue extends Error {
  override readonly name = "CannotContinue";
  readonly _tag = "CannotContinue";
}

/** Asked of an agent that is closed. */
export class AgentClosed extends Error {
  override readonly name = "AgentClosed";
  readonly _tag = "AgentClosed";
}

/** Something of the agent's own that did not go: its tools servers, its reminders, its saved conversation. */
export class AgentFailed extends Error {
  override readonly name = "AgentFailed";
  readonly _tag = "AgentFailed";
  constructor(message: string, cause?: unknown) {
    super(message, withCause(cause));
  }
  static make(fields: { readonly message: string; readonly cause?: unknown }): AgentFailed {
    return new AgentFailed(fields.message, fields.cause);
  }
}

export const agentFailed = (cause: unknown): AgentFailed => new AgentFailed(messageOf(cause), cause);
