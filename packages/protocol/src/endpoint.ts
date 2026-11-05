import { Schema } from "effect";

import type { Handlers } from "./api";
import { type VoiceFix, VoiceFixValues } from "./shapes";

export type Caller = "owner" | "remote" | "orchestrator" | "session";

/** One thing to do next after a refusal: what to do, and, when it is a command, the command line's words for it (without
 * the program's name), runnable as they are. */
export interface Next {
  readonly say: string;
  readonly run?: readonly string[];
}

export interface Refused {
  readonly _tag: "Refused";
  readonly reason: string;
  /** What can be done instead, as the refusing service knows it (an issue's acts and moves now). */
  readonly next?: readonly Next[];
}

export interface Missing {
  readonly _tag: "Missing";
  readonly what: string;
  readonly next?: readonly Next[];
}

/** A Settings section a voice problem is fixed in (the page's /settings/<section>). */
export type { VoiceFix } from "./shapes";

export interface VoiceUnavailable {
  readonly _tag: "VoiceUnavailable";
  readonly reason: string;
  /** Where in Settings the owner fixes it, when a setting does. */
  readonly settings?: VoiceFix;
}

export interface VoiceCallFailed {
  readonly _tag: "VoiceCallFailed";
  readonly reason: string;
}

export interface ConnectorRefused {
  readonly _tag: "ConnectorRefused";
  readonly reason: string;
}

export interface LanRefused {
  readonly _tag: "LanRefused";
  readonly reason: string;
}

/** What a route may refuse with: written as JSON with its _tag, at its status. */
export type ApiError = Refused | Missing | VoiceUnavailable | VoiceCallFailed | ConnectorRefused | LanRefused;

const NextSchema: Schema.Codec<Next> = Schema.Struct({
  say: Schema.String,
  run: Schema.optionalKey(Schema.Array(Schema.String)),
});
const reasonOf = <Tag extends string>(tag: Tag) => Schema.Struct({ _tag: Schema.tag(tag), reason: Schema.String });

/** The error as a route writes it, for a client to read back (the command line's failures). */
export const ApiError: Schema.Codec<ApiError> = Schema.Union([
  Schema.Struct({
    _tag: Schema.tag("Refused"),
    reason: Schema.String,
    next: Schema.optionalKey(Schema.Array(NextSchema)),
  }),
  Schema.Struct({
    _tag: Schema.tag("Missing"),
    what: Schema.String,
    next: Schema.optionalKey(Schema.Array(NextSchema)),
  }),
  Schema.Struct({
    _tag: Schema.tag("VoiceUnavailable"),
    reason: Schema.String,
    settings: Schema.optionalKey(Schema.Literals(VoiceFixValues)),
  }),
  reasonOf("VoiceCallFailed"),
  reasonOf("ConnectorRefused"),
  reasonOf("LanRefused"),
]);

export const errorStatus: Readonly<Record<ApiError["_tag"], number>> = {
  Refused: 409,
  Missing: 404,
  VoiceUnavailable: 503,
  VoiceCallFailed: 502,
  ConnectorRefused: 409,
  LanRefused: 403,
};

export interface Endpoint {
  readonly op: keyof Handlers;
  /** The input's fields that say what it is about (the issue's id…): the command line takes them as its arguments. */
  readonly about: readonly string[];
  /** The one argument, ids and all, sent as the POST's JSON body; none when it takes nothing. */
  readonly input: Schema.Codec<unknown> | undefined;
  readonly result: Schema.Codec<unknown> | undefined;
  readonly can: readonly Caller[];
  /** It changes what cannot be taken back (deletes, merges, closes, sends helpers home). */
  readonly dryRun?: keyof Handlers;
}

export const input = (ids: Schema.Struct.Fields, body?: Schema.Codec<unknown>): Schema.Codec<unknown> =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- every body is a Struct in schema.ts, typed Codec<T.X> there to tie it to its shape
  Schema.Struct({ ...ids, ...(body ? (body as unknown as Schema.Struct<Schema.Struct.Fields>).fields : {}) }) as unknown as Schema.Codec<unknown>;
