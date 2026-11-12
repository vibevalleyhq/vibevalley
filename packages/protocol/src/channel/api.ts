import { z } from "zod";

import { type Endpoint, input } from "../endpoint";
import * as S from "../schema";
import type * as T from "../shapes";

const messageInput = input({ id: S.MessageId });
const channelInput = input({ id: z.string() });

export interface ChannelHandlers {
  readonly "channel.message.send": (a: T.SayRequest) => Promise<void>;
  readonly "channel.create": (a: T.ChannelRequest) => Promise<string>;
  readonly "channel.update": (a: { readonly id: string } & T.ChannelUpdate) => Promise<void>;
  /** The channel what names none goes to from now on: a connector's, a call's. */
  readonly "channel.default.set": (a: { readonly id: string }) => Promise<void>;
  /** What deleteTask would do, refused as it would be; nothing changes. */
  readonly "channel.message.list": (a: { readonly id: string; readonly before?: number; readonly limit?: number }) => Promise<T.ChatMessage[]>;
  readonly "channel.markRead": (a: { readonly id: string } & T.ChatReadRequest) => Promise<void>;
  /** The user's own words, changed; nobody is told again. */
  readonly "channel.message.update": (a: T.MessageEdit) => Promise<T.ChatMessage>;
  /** Any message: its words go, its number stays, and what it still had to hand is dropped. */
  readonly "channel.message.delete": (a: { readonly id: T.MessageId }) => Promise<void>;
  /** What channel.message.delete would do, refused as it would be; nothing changes. */
  readonly "channel.message.previewDelete": (a: { readonly id: T.MessageId }) => Promise<T.Preview>;
  readonly "channel.message.search": (a: T.MessageSearch) => Promise<T.MessageHit[]>;
  /** The user's reaction on or off; as it already is, nothing changes. */
  readonly "channel.reaction.set": (a: T.ReactionSet) => Promise<T.ChatMessage>;
  /** The message pinned or not; as it already is, nothing changes. */
  readonly "channel.pin.set": (a: { readonly id: T.MessageId; readonly on: boolean }) => Promise<T.ChatMessage>;
  /** A channel's pinned messages, newest pinned first. */
  readonly "channel.pin.list": (a: { readonly id: string }) => Promise<T.ChatMessage[]>;
  /** The thread under a message, made if it has none: its id. requestKey: as IssueRequest's. */
  readonly "channel.thread.create": (a: { readonly id: T.MessageId; readonly requestKey?: string }) => Promise<string>;
  /** Out of the sidebar and the thread lists (on), or back. its messages and address stay. */
  readonly "channel.archive.set": (a: T.OnSet) => Promise<void>;
  /** A channel nothing points at any more, with its threads and messages. */
  readonly "channel.delete": (a: { readonly id: string }) => Promise<void>;
  /** What channel.delete would do, refused as it would be; nothing changes. */
  readonly "channel.previewDelete": (a: { readonly id: string }) => Promise<T.Preview>;
  readonly "channel.notify.set": (a: T.NotifyRequest) => Promise<void>;
  /** The user's direct channel with a helper profile (or the orchestrator), made if there is none: its id. */
  readonly "channel.direct.create": (a: { readonly agent: string }) => Promise<string>;
  /** The user's read moved back to just before this message. */
  readonly "channel.markUnread": (a: { readonly id: string } & T.ChatReadRequest) => Promise<void>;
  /** Every channel and direct channel, the default first. */
  readonly "channel.list": () => Promise<T.Channel[]>;
  /** The places the caller has not read all of, the newest first. */
  readonly "channel.unread.list": () => Promise<T.ChannelUnread[]>;
}

export const channelEndpoints: readonly Endpoint[] = [
  {
    op: "channel.message.send",
    about: ["id"],
    input: S.SayRequest,
    result: undefined,
    can: ["user", "remote", "session"],
  },
  {
    op: "channel.create",
    about: [],
    input: S.ChannelRequest,
    result: z.string(),
    can: ["user", "remote", "orchestrator"],
  },
  {
    op: "channel.update",
    about: ["id"],
    input: input({ id: z.string() }, S.ChannelUpdate),
    result: undefined,
    can: ["user", "remote", "orchestrator"],
  },
  {
    op: "channel.default.set",
    about: ["id"],
    input: input({ id: z.string() }),
    result: undefined,
    can: ["user", "remote"],
  },
  {
    op: "channel.message.list",
    about: ["id"],
    input: input({ id: z.string(), before: z.exactOptional(z.number()), limit: z.exactOptional(z.number()) }),
    result: z.array(S.ChatMessage),
    can: ["user", "remote", "orchestrator", "session"],
  },
  {
    op: "channel.markRead",
    about: ["id"],
    input: input({ id: z.string() }, S.ChatReadRequest),
    result: undefined,
    can: ["user", "remote"],
  },
  {
    op: "channel.message.update",
    about: ["id"],
    input: S.MessageEdit,
    result: S.ChatMessage,
    can: ["user", "remote"],
  },
  {
    op: "channel.message.delete",
    about: ["id"],
    input: messageInput,
    result: undefined,
    can: ["user", "remote"],
    dryRun: "channel.message.previewDelete",
  },
  {
    op: "channel.message.previewDelete",
    about: ["id"],
    input: messageInput,
    result: S.Preview,
    can: ["user", "remote"],
  },
  {
    op: "channel.message.search",
    about: [],
    input: S.MessageSearch,
    result: z.array(S.MessageHit),
    can: ["user", "remote"],
  },
  {
    op: "channel.reaction.set",
    about: ["id"],
    input: S.ReactionSet,
    result: S.ChatMessage,
    can: ["user", "remote"],
  },
  {
    op: "channel.pin.set",
    about: ["id"],
    input: input({ id: S.MessageId, on: z.boolean() }),
    result: S.ChatMessage,
    can: ["user", "remote"],
  },
  {
    op: "channel.pin.list",
    about: ["id"],
    input: channelInput,
    result: z.array(S.ChatMessage),
    can: ["user", "remote"],
  },
  {
    op: "channel.thread.create",
    about: ["id"],
    input: input({ id: S.MessageId, requestKey: z.exactOptional(z.string()) }),
    result: z.string(),
    can: ["user", "remote"],
  },
  {
    op: "channel.archive.set",
    about: ["id"],
    input: S.OnSet,
    result: undefined,
    can: ["user", "remote"],
  },
  {
    op: "channel.delete",
    about: ["id"],
    input: channelInput,
    result: undefined,
    can: ["user", "remote"],
    dryRun: "channel.previewDelete",
  },
  {
    op: "channel.previewDelete",
    about: ["id"],
    input: channelInput,
    result: S.Preview,
    can: ["user", "remote"],
  },
  {
    op: "channel.direct.create",
    about: ["agent"],
    input: input({ agent: z.string() }),
    result: z.string(),
    can: ["user", "remote"],
  },
  {
    op: "channel.notify.set",
    about: ["id"],
    input: S.NotifyRequest,
    result: undefined,
    can: ["user", "remote"],
  },
  {
    op: "channel.markUnread",
    about: ["id"],
    input: input({ id: z.string() }, S.ChatReadRequest),
    result: undefined,
    can: ["user", "remote"],
  },
  {
    op: "channel.list",
    about: [],
    input: undefined,
    result: z.array(S.Channel),
    can: ["user", "remote", "orchestrator"],
  },
  {
    op: "channel.unread.list",
    about: [],
    input: undefined,
    result: z.array(S.ChannelUnread),
    can: ["user", "remote", "session"],
  },
];
