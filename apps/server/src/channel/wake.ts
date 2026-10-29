// What a woken agent is told of the chat, and how much: the wake's limits and the shape of its inbox.

import { type ActorKind } from "@vibevalley/protocol";

export interface UnreadRow {
  readonly target: string;
  readonly unread: number;
  readonly mentionsYou: boolean;
  readonly latest?: string;
}

export const wakeMessages = 3;

export const summaryChannels = 20;

/** The same words from the same sender in the same place this soon again are a retry, not a new message. */
export const retryWindowMs = 60_000;

export const heldShown = 3;

/** A message as the orchestrator and a session read it. */
export interface InboxMessage {
  readonly id: string;
  readonly number: number;
  readonly target: string;
  readonly from: string;
  readonly fromKind: ActorKind;
  readonly name: string;
  readonly text: string;
  readonly replyTo?: number;
  readonly edited?: boolean;
  readonly deleted?: boolean;
  /** Files said with it, where they are on this computer. */
  readonly attachments?: readonly { readonly name: string; readonly path: string }[];
  /** The artifact it announces (artifact/): what to read it by. */
  readonly artifact?: { readonly id: string; readonly title: string; readonly version: number };
}
