// Generated from crates/protocol/src/contract (vp run protocol:ts). Do not edit.

import type { ModelEntry, RuntimeCapability } from "../runtime/shapes.gen";

export const MachinePlatformValues = ["macos", "linux", "container", "other"] as const;
export type MachinePlatform = (typeof MachinePlatformValues)[number];

export const MachineStatusValues = ["online", "offline", "draining"] as const;
export type MachineStatus = (typeof MachineStatusValues)[number];

/**
 * Composite routing target `<machine_id>/<runtime_id>`.
 */
export type RuntimeRef = { machineId: string, runtimeId: string, };

export type MachineRuntimeSummary = { id: string, label: string, models: Array<ModelEntry>, capabilities: Array<RuntimeCapability>, available: boolean, };

export type MachineInfo = { id: string, name: string, platform: MachinePlatform, status: MachineStatus, here: boolean, ephemeral: boolean, joinedAt: number, lastSeenAt?: number, runtimes: Array<MachineRuntimeSummary>, };

export const MachineInputKindValues = ["prompt", "steer", "queue", "abort", "setConfig", "dispose"] as const;
export type MachineInputKind = (typeof MachineInputKindValues)[number];

export type MachineHello = { "type": "machine.hello", machineId: string, name: string, platform: MachinePlatform, ephemeral: boolean, runtimes: Array<MachineRuntimeSummary>, };

export type MachineHelloAck = { "type": "machine.helloAck", machineId: string, serverVersion: string, heartbeatMs: number, };

export type MachineInventory = { "type": "machine.inventory", machineId: string, runtimes: Array<MachineRuntimeSummary>, };

export type MachinePing = { "type": "machine.ping", ts: number, };

export type MachinePong = { "type": "machine.pong", ts: number, };

export type MachineSessionOpen = { "type": "session.open", requestId: string, sessionId: string, runtimeId: string, repoRef?: string, workdir?: string, systemPrompt?: string, model?: string, effort?: string, mcpSessionToken?: string, env: { [key in string]: string }, };

export type MachineSessionOpened = { "type": "session.opened", requestId: string, sessionId: string, ok: boolean, workdir?: string, error?: string, };

export type MachineSessionInput = { "type": "session.input", requestId: string, sessionId: string, inputId: string, kind: MachineInputKind, text?: string, model?: string, effort?: string, };

export type MachineSessionAck = { "type": "session.ack", requestId: string, sessionId: string, inputId: string, ok: boolean, error?: string, };

export type MachineSessionRespond = { "type": "session.respond", requestId: string, sessionId: string, targetId: string, allow: boolean, answer?: string, };

export type MachineSessionAttach = { "type": "session.attach", requestId: string, sessionId: string, afterSeq: number, };

export type MachineSessionEvent = { "type": "session.event", sessionId: string, seq: number, at: number, eventJson: string, terminal: boolean, };

export type MachineSessionRecord = { "type": "session.record", sessionId: string, seq: number, recordJson: string, };

export type MachineMcpRequest = { "type": "mcp.request", requestId: string, sessionId: string, sessionToken: string, method: string, path: string, body: string, };

export type MachineMcpResponse = { "type": "mcp.response", requestId: string, status: number, contentType: string, body: string, };

export type MachineAttachmentFetch = { "type": "attachment.fetch", requestId: string, attachmentId: string, };

export type MachineAttachmentData = { "type": "attachment.data", requestId: string, ok: boolean, mime?: string, bytesB64?: string, error?: string, };

export type MachineWireError = { "type": "error", requestId?: string, code: string, message: string, };

/**
 * Bidirectional WebSocket wire frame for `/api/v1/machine/ws`; told apart by `type`.
 */
export type MachineWireFrame = MachineHello | MachineHelloAck | MachineInventory | MachinePing | MachinePong | MachineSessionOpen | MachineSessionOpened | MachineSessionInput | MachineSessionAck | MachineSessionRespond | MachineSessionAttach | MachineSessionEvent | MachineSessionRecord | MachineMcpRequest | MachineMcpResponse | MachineAttachmentFetch | MachineAttachmentData | MachineWireError;
