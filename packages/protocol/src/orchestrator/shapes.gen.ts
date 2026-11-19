// Generated from crates/vibevalley-protocol/src/contract (vp run protocol:ts). Do not edit.

export type OrchestratorEvalRequest = {
/**
 * The orchestrator whose log it is, by its profile id; the default one when none is given.
 */
agent?: string, on: number, want: string, };

export type OrchestratorEval = { id: string, file: string, };

export type OrchestratorStopInput = { agent?: string, };

export type OrchestratorApprovalListInput = { conversationId?: string, };

export type OrchestratorApproval = { conversationId: string, taskId: string, toolCallId: string, toolName: string, argumentsJson: string, reason: string, requestedAtMs: number, };

export type OrchestratorApprovalResolveInput = { conversationId: string, taskId: string, toolCallId: string, approved: boolean, reason?: string, };
