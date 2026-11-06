import { type Effect, Schema } from "effect";

import { type ApiError, type Endpoint, input } from "../endpoint";
import * as S from "../schema";
import type * as T from "../shapes";

const messageInput = input({ id: S.MessageId });
const channelInput = input({ id: Schema.String });

export interface ChannelHandlers<R = never> {
  readonly "channel.message.send": (a: T.SayRequest) => Effect.Effect<void, ApiError, R>;
  readonly "channel.create": (a: T.ChannelRequest) => Effect.Effect<string, ApiError, R>;
  readonly "channel.update": (a: { readonly id: string } & T.ChannelUpdate) => Effect.Effect<void, ApiError, R>;
  /** The channel what names none goes to from now on: a connector's, a call's. */
  readonly "channel.default.set": (a: { readonly id: string }) => Effect.Effect<void, ApiError, R>;
  /** What deleteTask would do, refused as it would be; nothing changes. */
  readonly "channel.message.list": (a: {
    readonly id: string;
    readonly before?: number;
    readonly limit?: number;
  }) => Effect.Effect<T.ChatMessage[], ApiError, R>;
  readonly "channel.markRead": (a: { readonly id: string } & T.ChatReadRequest) => Effect.Effect<void, ApiError, R>;
  /** The owner's own words, changed; nobody is told again. */
  readonly "channel.message.update": (a: T.MessageEdit) => Effect.Effect<T.ChatMessage, ApiError, R>;
  /** Any message: its words go, its number stays, and what it still had to hand is dropped. */
  readonly "channel.message.delete": (a: { readonly id: T.MessageId }) => Effect.Effect<void, ApiError, R>;
  /** What channel.message.delete would do, refused as it would be; nothing changes. */
  readonly "channel.message.previewDelete": (a: { readonly id: T.MessageId }) => Effect.Effect<T.Preview, ApiError, R>;
  readonly "channel.message.search": (a: T.MessageSearch) => Effect.Effect<T.MessageHit[], ApiError, R>;
  /** The owner's reaction on or off; as it already is, nothing changes. */
  readonly "channel.reaction.set": (a: T.ReactionSet) => Effect.Effect<T.ChatMessage, ApiError, R>;
  /** The message pinned or not; as it already is, nothing changes. */
  readonly "channel.pin.set": (a: { readonly id: T.MessageId; readonly on: boolean }) => Effect.Effect<T.ChatMessage, ApiError, R>;
  /** A channel's pinned messages, newest pinned first. */
  readonly "channel.pin.list": (a: { readonly id: string }) => Effect.Effect<T.ChatMessage[], ApiError, R>;
  /** The thread under a message, made if it has none: its id. requestKey: as IssueRequest's. */
  readonly "channel.thread.create": (a: { readonly id: T.MessageId; readonly requestKey?: string }) => Effect.Effect<string, ApiError, R>;
  readonly "channel.attachment.create": (a: T.AttachmentUpload) => Effect.Effect<T.Attachment, ApiError, R>;
  /** Out of the sidebar and the thread lists (on), or back. its messages and address stay. */
  readonly "channel.archive.set": (a: T.OnSet) => Effect.Effect<void, ApiError, R>;
  /** A channel nothing points at any more, with its threads and messages. */
  readonly "channel.delete": (a: { readonly id: string }) => Effect.Effect<void, ApiError, R>;
  /** What channel.delete would do, refused as it would be; nothing changes. */
  readonly "channel.previewDelete": (a: { readonly id: string }) => Effect.Effect<T.Preview, ApiError, R>;
  readonly "channel.notify.set": (a: T.NotifyRequest) => Effect.Effect<void, ApiError, R>;
  /** The owner's direct channel with a helper profile (or the orchestrator), made if there is none: its id. */
  readonly "channel.direct.create": (a: { readonly agent: string }) => Effect.Effect<string, ApiError, R>;
  /** The owner's read moved back to just before this message. */
  readonly "channel.markUnread": (a: { readonly id: string } & T.ChatReadRequest) => Effect.Effect<void, ApiError, R>;
  /** Every channel and direct channel, the default first. */
  readonly "channel.list": () => Effect.Effect<T.Channel[], ApiError, R>;
  /** The places the caller has not read all of, the newest first. */
  readonly "channel.unread.list": () => Effect.Effect<T.ChannelUnread[], ApiError, R>;
}

export const channelEndpoints: readonly Endpoint[] = [
  {
    op: "channel.message.send",
    about: ["id"],
    input: S.SayRequest,
    result: undefined,
    can: ["owner", "remote", "session"],
  },
  {
    op: "channel.create",
    about: [],
    input: S.ChannelRequest,
    result: Schema.String,
    can: ["owner", "remote", "orchestrator"],
  },
  {
    op: "channel.update",
    about: ["id"],
    input: input({ id: Schema.String }, S.ChannelUpdate),
    result: undefined,
    can: ["owner", "remote", "orchestrator"],
  },
  {
    op: "channel.default.set",
    about: ["id"],
    input: input({ id: Schema.String }),
    result: undefined,
    can: ["owner", "remote"],
  },
  {
    op: "channel.message.list",
    about: ["id"],
    input: input({ id: Schema.String, before: Schema.optionalKey(Schema.Finite), limit: Schema.optionalKey(Schema.Finite) }),
    result: Schema.mutable(Schema.Array(S.ChatMessage)),
    can: ["owner", "remote", "orchestrator", "session"],
  },
  {
    op: "channel.markRead",
    about: ["id"],
    input: input({ id: Schema.String }, S.ChatReadRequest),
    result: undefined,
    can: ["owner", "remote"],
  },
  {
    op: "channel.message.update",
    about: ["id"],
    input: S.MessageEdit,
    result: S.ChatMessage,
    can: ["owner", "remote"],
  },
  {
    op: "channel.message.delete",
    about: ["id"],
    input: messageInput,
    result: undefined,
    can: ["owner", "remote"],
    dryRun: "channel.message.previewDelete",
  },
  {
    op: "channel.message.previewDelete",
    about: ["id"],
    input: messageInput,
    result: S.Preview,
    can: ["owner", "remote"],
  },
  {
    op: "channel.message.search",
    about: [],
    input: S.MessageSearch,
    result: Schema.mutable(Schema.Array(S.MessageHit)),
    can: ["owner", "remote"],
  },
  {
    op: "channel.reaction.set",
    about: ["id"],
    input: S.ReactionSet,
    result: S.ChatMessage,
    can: ["owner", "remote"],
  },
  {
    op: "channel.pin.set",
    about: ["id"],
    input: input({ id: S.MessageId, on: Schema.Boolean }),
    result: S.ChatMessage,
    can: ["owner", "remote"],
  },
  {
    op: "channel.pin.list",
    about: ["id"],
    input: channelInput,
    result: Schema.mutable(Schema.Array(S.ChatMessage)),
    can: ["owner", "remote"],
  },
  {
    op: "channel.thread.create",
    about: ["id"],
    input: input({ id: S.MessageId, requestKey: Schema.optionalKey(Schema.String) }),
    result: Schema.String,
    can: ["owner", "remote"],
  },
  {
    op: "channel.archive.set",
    about: ["id"],
    input: S.OnSet,
    result: undefined,
    can: ["owner", "remote"],
  },
  {
    op: "channel.delete",
    about: ["id"],
    input: channelInput,
    result: undefined,
    can: ["owner", "remote"],
    dryRun: "channel.previewDelete",
  },
  {
    op: "channel.previewDelete",
    about: ["id"],
    input: channelInput,
    result: S.Preview,
    can: ["owner", "remote"],
  },
  {
    op: "channel.direct.create",
    about: ["agent"],
    input: input({ agent: Schema.String }),
    result: Schema.String,
    can: ["owner", "remote"],
  },
  {
    op: "channel.notify.set",
    about: ["id"],
    input: S.NotifyRequest,
    result: undefined,
    can: ["owner", "remote"],
  },
  {
    op: "channel.markUnread",
    about: ["id"],
    input: input({ id: Schema.String }, S.ChatReadRequest),
    result: undefined,
    can: ["owner", "remote"],
  },
  {
    op: "channel.list",
    about: [],
    input: undefined,
    result: Schema.mutable(Schema.Array(S.Channel)),
    can: ["owner", "remote", "orchestrator"],
  },
  {
    op: "channel.unread.list",
    about: [],
    input: undefined,
    result: Schema.mutable(Schema.Array(S.ChannelUnread)),
    can: ["owner", "remote", "session"],
  },
  {
    op: "channel.attachment.create",
    about: [],
    input: S.AttachmentUpload,
    result: S.Attachment,
    can: ["owner", "remote"],
  },
];
