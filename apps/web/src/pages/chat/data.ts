// The chat page's reads beyond the state.

import { type Accessor, createContext, createEffect, createStore, snapshot, useContext } from "solid-js";

import type { Conversation, WorkspaceState } from "@vibevalley/protocol";
import { api } from "../../data/api";
import { chatPage, type Loaded, mergeLoaded, messagesOf, newestUnread } from "../../rules/chat";

export interface History {
  /** The pages of messages read beyond what the state holds, by conversation. */
  readonly loaded: Record<string, Loaded>;
  /** Reads the newest page once per conversation. */
  readonly ensure: (id: string) => void;
  readonly loadOlder: (id: string) => Promise<void>;
}

export const HistoryContext = createContext<History>();
export const useHistory = () => useContext(HistoryContext);

/** For as long as the chat page is open. */
export function createHistory(core: Accessor<WorkspaceState | undefined>): History {
  const [loaded, setLoaded] = createStore<Record<string, Loaded>>({});
  const reading = new Map<string, Promise<void>>();

  // One read per conversation at a time: a second press while one is under way waits for it.
  const read = (id: string, before?: number) => {
    const under = reading.get(id);
    if (under) return under;
    const p = api.channel
      .history({ id, before, limit: chatPage })
      .then((page) => {
        const next = mergeLoaded(snapshot(loaded)[id], page, page.length < chatPage);
        setLoaded((d) => {
          d[id] = next;
        });
      })
      .catch(() => {})
      .finally(() => reading.delete(id));
    reading.set(id, p);
    return p;
  };

  return {
    loaded,
    ensure: (id) => void (snapshot(loaded)[id] || read(id)),
    loadOlder: async (id) => {
      const more = snapshot(loaded)[id];
      if (more?.complete) return;
      await read(id, messagesOf(snapshot(core())?.chat, id, more)[0]?.number);
    },
  };
}

/** A shown conversation is read: the newest unread number goes to the server once it is drawn. */
export function useMarkRead(core: Accessor<WorkspaceState | undefined>, conversation: Accessor<Conversation | undefined>) {
  createEffect(
    () => {
      const c = conversation();
      const number = c ? newestUnread(core()?.chat, c) : undefined;
      // A string, so the same conversation and number again is equal and posts nothing.
      return c && number !== undefined ? JSON.stringify([c.id, number]) : undefined;
    },
    (read) => {
      if (!read) return;
      const [id, number] = JSON.parse(read) as [string, number];
      api.channel.markRead({ id, body: { number } }).catch(() => {});
    },
  );
}
