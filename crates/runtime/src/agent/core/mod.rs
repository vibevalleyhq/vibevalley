//! Layer 1 durable execution core: typed documents, events, pipeline,
//! inbox scheduling, extensions, and the 6-phase state machine.

pub mod doc;
pub mod engine;
pub mod events;
pub mod extension;
pub mod inbox;
pub mod pipeline;
pub mod tool;

#[cfg(test)]
mod tests;

pub use doc::{
    AgentDoc, AgentState, BudgetConfig, BudgetSnapshot, CONVERSATION_SCOPE, DocSpec, FileOpsDoc, GovernanceDoc, GovernanceState, InboxDoc, InboxState, LiveDoc,
    LiveState, OarSessionDoc, OarSessionState, PendingApproval, PermissionEvaluation, StandInDoc, StandInState, TASK_SCOPE, TodoDoc, TodoDocState, TodoItem,
    TodoState, UsageDoc, UsageTotals, read_doc, read_doc_opt, update_doc, write_doc,
};
pub use engine::{
    ATTACHED_SIGNAL, BrainProvider, Engine, KIND, PHASE_FOLLOW_UP_CHECK, PHASE_GENERATE, PHASE_PREPARE, PHASE_TOOL_DISPATCH, PHASE_TOOL_JOIN,
    PHASE_YIELD_CHECK, Request, TOOL_KIND, TOOL_RUN,
};
pub use events::{AgentEvent, AgentMessage, Brain, TurnOutcome};
pub use extension::{
    CompactCtx, DurableHookCtx, Extension, ExtensionRunner, HookOutcome, OutcomeReview, ReviewRequest, Rubric, RubricVerdict, RunEndCtx, ToolCallHookCtx,
};
pub use inbox::{
    KIND_FOLLOW_UP, KIND_PROMPT, KIND_STEER, WhenBusy, submit_follow_up, submit_prompt, submit_steer, take_pending_follow_ups, take_pending_steers,
};
pub use pipeline::{PromptSection, Transcript, convert_to_llm, model_payload, system_delta, transform_context};
pub use tool::{ReplayPolicy, Tool, ToolContext, ToolOutput, ToolUpdate, TypedTool, TypedToolAdapter, TypedToolOutput, typed_execute, typed_spec};
