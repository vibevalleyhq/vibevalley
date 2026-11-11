import type { Actor, AgentRole, Channel, Chat } from "../shapes";

/** The channel words go to when none is named. */
export const defaultOf = (chat: Chat | undefined): Channel | undefined => chat?.channels.find((c) => c.default);

/** A channel by its id; none when no id is given. */
export const channelOf = (chat: Chat | undefined, id: string | undefined): Channel | undefined => (id ? chat?.channels.find((c) => c.id === id) : undefined);

/** The agent's role when an actor is an agent; undefined for the user or the system. */
export const actorRoleOf = (actor: Actor): AgentRole | undefined => (actor.kind === "agent" ? actor.role : undefined);

/** What an @name may follow: anything but a Latin letter, a digit, _ or @, so a@b.com names no one while cjk@w3 does (Chinese runs on without spaces). */
export const mentionLead = String.raw`(?<![\p{Script=Latin}\p{N}_@])`;
