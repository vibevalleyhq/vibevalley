import { z } from "zod";

import type { Handlers } from "./api";
import { pathOf, type VoiceFix, VoiceFixValues } from "./shapes";

export { pathOf };

export type Caller = "user" | "remote" | "orchestrator" | "session";

/** One thing to do next after a refusal: what to do, and, when it is a command, the command line's words for it (without
 * the program's name), runnable as they are. */
export interface Next {
  readonly say: string;
  readonly run?: readonly string[];
}

/** A Settings section a voice problem is fixed in (the page's /settings/<section>). */
export type { VoiceFix } from "./shapes";

/** Six-digit numeric business error codes grouped by subsystem (100xxx..700xxx), with 0 reserved for success envelopes. */
export const BizCode = {
  Ok: 0,
  InvalidInput: 100001,
  PayloadTooLarge: 100002,
  UnsupportedMediaType: 100003,
  MethodNotAllowed: 100004,
  RouteNotFound: 100005,
  RequestKeyTooLong: 100006,
  InternalError: 100007,
  BadGateway: 100008,
  ServiceUnavailable: 100009,
  NotFound: 100010,
  Refused: 100011,
  Unauthorized: 200001,
  Forbidden: 200002,
  AuthRefused: 200003,
  UserNotFound: 200004,
  LanForbidden: 200005,
  LanUnavailable: 200006,
  IssueNotFound: 300001,
  IssueRefused: 300002,
  RepoNotFound: 300003,
  RepoRefused: 300004,
  SessionNotFound: 400001,
  SessionRefused: 400002,
  AgentNotFound: 400003,
  AgentRefused: 400004,
  RuntimeNotFound: 400005,
  RuntimeRefused: 400006,
  OrchestratorRefused: 400007,
  OrchestratorNotFound: 400008,
  ChannelNotFound: 500001,
  ChannelRefused: 500002,
  ConnectorRefused: 500003,
  CronNotFound: 500004,
  CronRefused: 500005,
  GameRefused: 500006,
  ArtifactNotFound: 600001,
  ArtifactRefused: 600002,
  PkmNotFound: 600003,
  PkmRefused: 600004,
  MemoryNotFound: 600005,
  MemoryRefused: 600006,
  LibraryNotFound: 600007,
  LibraryRefused: 600008,
  AttachmentRefused: 600009,
  VoiceUnavailable: 700001,
  VoiceCallFailed: 700002,
  VoiceRefused: 700003,
  MediaNotFound: 700004,
  MediaRefused: 700005,
  ProviderRefused: 700006,
  SettingRefused: 700007,
} as const;

const BizErrorCodeValues = [
  BizCode.InvalidInput,
  BizCode.PayloadTooLarge,
  BizCode.UnsupportedMediaType,
  BizCode.MethodNotAllowed,
  BizCode.RouteNotFound,
  BizCode.RequestKeyTooLong,
  BizCode.InternalError,
  BizCode.BadGateway,
  BizCode.ServiceUnavailable,
  BizCode.NotFound,
  BizCode.Refused,
  BizCode.Unauthorized,
  BizCode.Forbidden,
  BizCode.AuthRefused,
  BizCode.UserNotFound,
  BizCode.LanForbidden,
  BizCode.LanUnavailable,
  BizCode.IssueNotFound,
  BizCode.IssueRefused,
  BizCode.RepoNotFound,
  BizCode.RepoRefused,
  BizCode.SessionNotFound,
  BizCode.SessionRefused,
  BizCode.AgentNotFound,
  BizCode.AgentRefused,
  BizCode.RuntimeNotFound,
  BizCode.RuntimeRefused,
  BizCode.OrchestratorRefused,
  BizCode.OrchestratorNotFound,
  BizCode.ChannelNotFound,
  BizCode.ChannelRefused,
  BizCode.ConnectorRefused,
  BizCode.CronNotFound,
  BizCode.CronRefused,
  BizCode.GameRefused,
  BizCode.ArtifactNotFound,
  BizCode.ArtifactRefused,
  BizCode.PkmNotFound,
  BizCode.PkmRefused,
  BizCode.MemoryNotFound,
  BizCode.MemoryRefused,
  BizCode.LibraryNotFound,
  BizCode.LibraryRefused,
  BizCode.AttachmentRefused,
  BizCode.VoiceUnavailable,
  BizCode.VoiceCallFailed,
  BizCode.VoiceRefused,
  BizCode.MediaNotFound,
  BizCode.MediaRefused,
  BizCode.ProviderRefused,
  BizCode.SettingRefused,
] as const;

export type BizErrorCode = (typeof BizErrorCodeValues)[number];
const _allBizCodesCovered: Exclude<(typeof BizCode)[keyof typeof BizCode], 0 | BizErrorCode> extends never ? true : never = true;
void _allBizCodesCovered;

export type ApiErrorKind =
  | "InvalidInput"
  | "Unauthorized"
  | "Forbidden"
  | "Missing"
  | "Refused"
  | "VoiceUnavailable"
  | "VoiceCallFailed"
  | "InternalError"
  | "BadGateway"
  | "ServiceUnavailable";

/** HTTP status, semantic category, and retryability for every six-digit business error code. */
export const bizCodeMeta: Readonly<Record<BizErrorCode, { readonly status: number; readonly kind: ApiErrorKind; readonly retryable: boolean }>> = {
  [BizCode.InvalidInput]: { status: 400, kind: "InvalidInput", retryable: false },
  [BizCode.PayloadTooLarge]: { status: 413, kind: "InvalidInput", retryable: false },
  [BizCode.UnsupportedMediaType]: { status: 415, kind: "InvalidInput", retryable: false },
  [BizCode.MethodNotAllowed]: { status: 405, kind: "InvalidInput", retryable: false },
  [BizCode.RouteNotFound]: { status: 404, kind: "Missing", retryable: false },
  [BizCode.RequestKeyTooLong]: { status: 409, kind: "Refused", retryable: false },
  [BizCode.InternalError]: { status: 500, kind: "InternalError", retryable: true },
  [BizCode.BadGateway]: { status: 502, kind: "BadGateway", retryable: true },
  [BizCode.ServiceUnavailable]: { status: 503, kind: "ServiceUnavailable", retryable: true },
  [BizCode.NotFound]: { status: 404, kind: "Missing", retryable: false },
  [BizCode.Refused]: { status: 409, kind: "Refused", retryable: false },
  [BizCode.Unauthorized]: { status: 401, kind: "Unauthorized", retryable: false },
  [BizCode.Forbidden]: { status: 403, kind: "Forbidden", retryable: false },
  [BizCode.AuthRefused]: { status: 403, kind: "Forbidden", retryable: false },
  [BizCode.UserNotFound]: { status: 404, kind: "Missing", retryable: false },
  [BizCode.LanForbidden]: { status: 403, kind: "Forbidden", retryable: false },
  [BizCode.LanUnavailable]: { status: 503, kind: "ServiceUnavailable", retryable: true },
  [BizCode.IssueNotFound]: { status: 404, kind: "Missing", retryable: false },
  [BizCode.IssueRefused]: { status: 409, kind: "Refused", retryable: false },
  [BizCode.RepoNotFound]: { status: 404, kind: "Missing", retryable: false },
  [BizCode.RepoRefused]: { status: 409, kind: "Refused", retryable: false },
  [BizCode.SessionNotFound]: { status: 404, kind: "Missing", retryable: false },
  [BizCode.SessionRefused]: { status: 409, kind: "Refused", retryable: false },
  [BizCode.AgentNotFound]: { status: 404, kind: "Missing", retryable: false },
  [BizCode.AgentRefused]: { status: 409, kind: "Refused", retryable: false },
  [BizCode.RuntimeNotFound]: { status: 404, kind: "Missing", retryable: false },
  [BizCode.RuntimeRefused]: { status: 409, kind: "Refused", retryable: false },
  [BizCode.OrchestratorRefused]: { status: 409, kind: "Refused", retryable: false },
  [BizCode.OrchestratorNotFound]: { status: 404, kind: "Missing", retryable: false },
  [BizCode.ChannelNotFound]: { status: 404, kind: "Missing", retryable: false },
  [BizCode.ChannelRefused]: { status: 409, kind: "Refused", retryable: false },
  [BizCode.ConnectorRefused]: { status: 409, kind: "Refused", retryable: false },
  [BizCode.CronNotFound]: { status: 404, kind: "Missing", retryable: false },
  [BizCode.CronRefused]: { status: 409, kind: "Refused", retryable: false },
  [BizCode.GameRefused]: { status: 409, kind: "Refused", retryable: false },
  [BizCode.ArtifactNotFound]: { status: 404, kind: "Missing", retryable: false },
  [BizCode.ArtifactRefused]: { status: 409, kind: "Refused", retryable: false },
  [BizCode.PkmNotFound]: { status: 404, kind: "Missing", retryable: false },
  [BizCode.PkmRefused]: { status: 409, kind: "Refused", retryable: false },
  [BizCode.MemoryNotFound]: { status: 404, kind: "Missing", retryable: false },
  [BizCode.MemoryRefused]: { status: 409, kind: "Refused", retryable: false },
  [BizCode.LibraryNotFound]: { status: 404, kind: "Missing", retryable: false },
  [BizCode.LibraryRefused]: { status: 409, kind: "Refused", retryable: false },
  [BizCode.AttachmentRefused]: { status: 409, kind: "Refused", retryable: false },
  [BizCode.VoiceUnavailable]: { status: 503, kind: "VoiceUnavailable", retryable: false },
  [BizCode.VoiceCallFailed]: { status: 502, kind: "VoiceCallFailed", retryable: true },
  [BizCode.VoiceRefused]: { status: 409, kind: "Refused", retryable: false },
  [BizCode.MediaNotFound]: { status: 404, kind: "Missing", retryable: false },
  [BizCode.MediaRefused]: { status: 409, kind: "Refused", retryable: false },
  [BizCode.ProviderRefused]: { status: 409, kind: "Refused", retryable: false },
  [BizCode.SettingRefused]: { status: 409, kind: "Refused", retryable: false },
};

const NextSchema: z.ZodType<Next> = z.object({
  say: z.string(),
  run: z.exactOptional(z.array(z.string()).readonly()),
});

const BizErrorCodeSchema: z.ZodType<BizErrorCode> = z.literal(BizErrorCodeValues);

/** Structured remediation metadata carried inside an error envelope's optional `error` field. */
export interface ApiErrorDetail {
  readonly next?: readonly Next[];
  readonly settings?: VoiceFix;
}

const ApiErrorDetailSchema: z.ZodType<ApiErrorDetail> = z.object({
  next: z.exactOptional(z.array(NextSchema).readonly()),
  settings: z.exactOptional(z.enum(VoiceFixValues)),
});

export interface ApiErrorEnvelopeShape {
  readonly bizCode: BizErrorCode;
  readonly message: string;
  readonly error?: ApiErrorDetail;
}

/** Wire envelope for every failed JSON HTTP response: `{ bizCode, message, error? }`. */
export const ApiErrorEnvelope: z.ZodType<ApiErrorEnvelopeShape> = z.object({
  bizCode: BizErrorCodeSchema,
  message: z.string(),
  error: z.exactOptional(ApiErrorDetailSchema),
});

/** Wire envelope for successful JSON HTTP responses with no payload: `{ bizCode: 0, message: "ok" }`. */
export const ApiVoidEnvelope = z.object({
  bizCode: z.literal(0),
  message: z.string(),
});

/** Wire envelope for successful JSON HTTP responses carrying `data`: `{ bizCode: 0, message: "ok", data }`. */
export const apiSuccessEnvelope = <A, I>(data: z.ZodType<A, I>) =>
  z.object({
    bizCode: z.literal(0),
    message: z.string(),
    data,
  });

export interface ApiErrorOptions {
  readonly next?: readonly Next[];
  readonly settings?: VoiceFix;
  readonly cause?: unknown;
}

/** What a route refuses with: thrown by a service, and written as ApiErrorEnvelope on the wire. */
export class ApiError extends Error {
  override readonly name = "ApiError";
  readonly bizCode: BizErrorCode;
  readonly next?: readonly Next[];
  readonly settings?: VoiceFix;

  constructor(bizCode: BizErrorCode, message: string, options: ApiErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.bizCode = bizCode;
    if (options.next !== undefined) this.next = options.next;
    if (options.settings !== undefined) this.settings = options.settings;
  }

  /** The envelope read back as the error it says. */
  static of(envelope: ApiErrorEnvelopeShape): ApiError {
    return new ApiError(envelope.bizCode, envelope.message, {
      ...(envelope.error?.next === undefined ? {} : { next: envelope.error.next }),
      ...(envelope.error?.settings === undefined ? {} : { settings: envelope.error.settings }),
    });
  }

  get status(): number {
    return bizCodeMeta[this.bizCode].status;
  }
  get kind(): ApiErrorKind {
    return bizCodeMeta[this.bizCode].kind;
  }
  get retryable(): boolean {
    return bizCodeMeta[this.bizCode].retryable;
  }
  get reason(): string {
    return this.message;
  }
  toEnvelope(): ApiErrorEnvelopeShape {
    const hasNext = this.next !== undefined && this.next.length > 0;
    const hasSettings = this.settings !== undefined;
    return {
      bizCode: this.bizCode,
      message: this.message,
      ...(hasNext || hasSettings
        ? {
            error: {
              ...(hasNext ? { next: this.next } : {}),
              ...(hasSettings ? { settings: this.settings } : {}),
            },
          }
        : {}),
    };
  }
}

export const isApiError = (e: unknown): e is ApiError => e instanceof ApiError;

export interface Endpoint {
  readonly op: keyof Handlers;
  /** The input's fields that say what it is about (the issue's id…): the command line takes them as its arguments. */
  readonly about: readonly string[];
  /** The one argument, ids and all, sent as the POST's JSON body; none when it takes nothing. */
  readonly input: z.ZodObject | undefined;
  readonly result: z.ZodType | undefined;
  readonly can: readonly Caller[];
  /** It changes what cannot be taken back (deletes, merges, closes, sends helpers home). */
  readonly dryRun?: keyof Handlers;
}

/** An endpoint's input: the ids it is about, and its body's fields beside them. */
export const input = (ids: z.ZodRawShape, body?: z.ZodObject): z.ZodObject => z.object({ ...ids, ...(body ? body.shape : {}) });

/** The fields an endpoint's input takes, what it is about among them; none when it takes nothing. */
export const fieldsOf = (e: Endpoint): readonly string[] => (e.input === undefined ? [] : Object.keys(e.input.shape));
