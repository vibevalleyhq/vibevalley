// Generated from crates/vibevalley-protocol/src/contract (vp run protocol:ts). Do not edit.

export type OrchestratorEvalRequest = { 
/**
 * The orchestrator whose log it is, by its profile id; the default one when none is given.
 */
agent?: string, on: number, want: string, };

export type OrchestratorEval = { id: string, file: string, };

export type OrchestratorStopInput = { agent?: string, };
