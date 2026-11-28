import { z } from "zod";

import type { Codec } from "../codec";
import { ModelEntry, RuntimeCapability } from "../runtime/schema";
import * as T from "./shapes.gen";

export const MachinePlatform = z.enum(T.MachinePlatformValues) satisfies Codec<T.MachinePlatform>;

export const MachineStatus = z.enum(T.MachineStatusValues) satisfies Codec<T.MachineStatus>;

export const RuntimeRef = z.object({
  machineId: z.string(),
  runtimeId: z.string(),
}) satisfies Codec<T.RuntimeRef>;

export const MachineRuntimeSummary = z.object({
  id: z.string(),
  label: z.string(),
  models: z.array(ModelEntry),
  capabilities: z.array(RuntimeCapability),
  available: z.boolean(),
}) satisfies Codec<T.MachineRuntimeSummary>;

export const MachineInfo = z.object({
  id: z.string(),
  name: z.string(),
  platform: MachinePlatform,
  status: MachineStatus,
  here: z.boolean(),
  ephemeral: z.boolean(),
  joinedAt: z.number(),
  lastSeenAt: z.exactOptional(z.number()),
  runtimes: z.array(MachineRuntimeSummary),
}) satisfies Codec<T.MachineInfo>;

export const MachineInputKind = z.enum(T.MachineInputKindValues) satisfies Codec<T.MachineInputKind>;

const MachineHello = z.object({
  type: z.literal("machine.hello"),
  machineId: z.string(),
  name: z.string(),
  platform: MachinePlatform,
  ephemeral: z.boolean(),
  runtimes: z.array(MachineRuntimeSummary),
}) satisfies Codec<T.MachineHello>;

const MachineHelloAck = z.object({
  type: z.literal("machine.helloAck"),
  machineId: z.string(),
  serverVersion: z.string(),
  heartbeatMs: z.number(),
}) satisfies Codec<T.MachineHelloAck>;

const MachineInventory = z.object({
  type: z.literal("machine.inventory"),
  machineId: z.string(),
  runtimes: z.array(MachineRuntimeSummary),
}) satisfies Codec<T.MachineInventory>;

const MachinePing = z.object({
  type: z.literal("machine.ping"),
  ts: z.number(),
}) satisfies Codec<T.MachinePing>;

const MachinePong = z.object({
  type: z.literal("machine.pong"),
  ts: z.number(),
}) satisfies Codec<T.MachinePong>;

const MachineSessionOpen = z.object({
  type: z.literal("session.open"),
  requestId: z.string(),
  sessionId: z.string(),
  runtimeId: z.string(),
  repoRef: z.exactOptional(z.string()),
  workdir: z.exactOptional(z.string()),
  systemPrompt: z.exactOptional(z.string()),
  model: z.exactOptional(z.string()),
  effort: z.exactOptional(z.string()),
  mcpSessionToken: z.exactOptional(z.string()),
  env: z.record(z.string(), z.string()),
}) satisfies Codec<T.MachineSessionOpen>;

const MachineSessionOpened = z.object({
  type: z.literal("session.opened"),
  requestId: z.string(),
  sessionId: z.string(),
  ok: z.boolean(),
  workdir: z.exactOptional(z.string()),
  error: z.exactOptional(z.string()),
}) satisfies Codec<T.MachineSessionOpened>;

const MachineSessionInput = z.object({
  type: z.literal("session.input"),
  requestId: z.string(),
  sessionId: z.string(),
  inputId: z.string(),
  kind: MachineInputKind,
  text: z.exactOptional(z.string()),
  model: z.exactOptional(z.string()),
  effort: z.exactOptional(z.string()),
}) satisfies Codec<T.MachineSessionInput>;

const MachineSessionAck = z.object({
  type: z.literal("session.ack"),
  requestId: z.string(),
  sessionId: z.string(),
  inputId: z.string(),
  ok: z.boolean(),
  error: z.exactOptional(z.string()),
}) satisfies Codec<T.MachineSessionAck>;

const MachineSessionRespond = z.object({
  type: z.literal("session.respond"),
  requestId: z.string(),
  sessionId: z.string(),
  targetId: z.string(),
  allow: z.boolean(),
  answer: z.exactOptional(z.string()),
}) satisfies Codec<T.MachineSessionRespond>;

const MachineSessionAttach = z.object({
  type: z.literal("session.attach"),
  requestId: z.string(),
  sessionId: z.string(),
  afterSeq: z.number(),
}) satisfies Codec<T.MachineSessionAttach>;

const MachineSessionEvent = z.object({
  type: z.literal("session.event"),
  sessionId: z.string(),
  seq: z.number(),
  at: z.number(),
  eventJson: z.string(),
  terminal: z.boolean(),
}) satisfies Codec<T.MachineSessionEvent>;

const MachineSessionRecord = z.object({
  type: z.literal("session.record"),
  sessionId: z.string(),
  seq: z.number(),
  recordJson: z.string(),
}) satisfies Codec<T.MachineSessionRecord>;

const MachineMcpRequest = z.object({
  type: z.literal("mcp.request"),
  requestId: z.string(),
  sessionId: z.string(),
  sessionToken: z.string(),
  method: z.string(),
  path: z.string(),
  body: z.string(),
}) satisfies Codec<T.MachineMcpRequest>;

const MachineMcpResponse = z.object({
  type: z.literal("mcp.response"),
  requestId: z.string(),
  status: z.number(),
  contentType: z.string(),
  body: z.string(),
}) satisfies Codec<T.MachineMcpResponse>;

const MachineAttachmentFetch = z.object({
  type: z.literal("attachment.fetch"),
  requestId: z.string(),
  attachmentId: z.string(),
}) satisfies Codec<T.MachineAttachmentFetch>;

const MachineAttachmentData = z.object({
  type: z.literal("attachment.data"),
  requestId: z.string(),
  ok: z.boolean(),
  mime: z.exactOptional(z.string()),
  bytesB64: z.exactOptional(z.string()),
  error: z.exactOptional(z.string()),
}) satisfies Codec<T.MachineAttachmentData>;

const MachineWireError = z.object({
  type: z.literal("error"),
  requestId: z.exactOptional(z.string()),
  code: z.string(),
  message: z.string(),
}) satisfies Codec<T.MachineWireError>;

export const MachineWireFrame = z.discriminatedUnion("type", [
  MachineHello,
  MachineHelloAck,
  MachineInventory,
  MachinePing,
  MachinePong,
  MachineSessionOpen,
  MachineSessionOpened,
  MachineSessionInput,
  MachineSessionAck,
  MachineSessionRespond,
  MachineSessionAttach,
  MachineSessionEvent,
  MachineSessionRecord,
  MachineMcpRequest,
  MachineMcpResponse,
  MachineAttachmentFetch,
  MachineAttachmentData,
  MachineWireError,
]) satisfies Codec<T.MachineWireFrame>;
