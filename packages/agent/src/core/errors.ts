import { Data } from "effect";

/** What a thrown or rejected value says: an Error's message, anything else as text. */
export const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** A tool that did not do what it was asked: its message is the failed result the model reads. */
export class ToolFailed extends Data.TaggedError("ToolFailed")<{ readonly message: string; readonly cause?: unknown }> {}

/** What a tool's body threw or rejected with, as the failed result. */
export const toolFailed = (e: unknown): ToolFailed => (e instanceof ToolFailed ? e : new ToolFailed({ message: messageOf(e), cause: e }));

/** A run asked of an agent that is already running one. */
export class AgentBusy extends Data.TaggedError("AgentBusy")<{ readonly message: string }> {}

/** continue with nothing to go on from: no messages yet, or an answer and nothing steered or queued after it. */
export class CannotContinue extends Data.TaggedError("CannotContinue")<{ readonly message: string }> {}

/** Asked of an agent that is closed. */
export class AgentClosed extends Data.TaggedError("AgentClosed")<{ readonly message: string }> {}

/** Something of the agent's own that did not go: its tools servers, its reminders, its saved conversation. */
export class AgentFailed extends Data.TaggedError("AgentFailed")<{ readonly message: string; readonly cause?: unknown }> {}

export const agentFailed = (cause: unknown): AgentFailed => new AgentFailed({ message: messageOf(cause), cause });
