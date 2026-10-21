import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Conversation, SessionEvent } from "@vibevalley/protocol";
import { api } from "../../data/api";
import { useCore } from "../../data/frame";
import { useLive } from "../../data/live";
import { chatPage, type Loaded, mergeLoaded, messagesOf, newestUnread } from "../../rules/chat";
import { mergeSteps } from "../../rules/rounds";

interface History {
  loaded: Record<string, Loaded>;
  /** Reads the newest page once per conversation. */
  ensure: (id: string) => void;
  loadOlder: (id: string) => Promise<void>;
}

const HistoryContext = createContext<History>({ loaded: {}, ensure: () => {}, loadOlder: async () => {} });

/** The pages of messages read beyond what the state holds, for as long as the chat page is open. */
export function HistoryProvider({ children }: { children: ReactNode }) {
  const [loaded, setLoaded] = useState<Record<string, Loaded>>({});
  const reading = useRef(new Map<string, Promise<void>>());
  const loadedRef = useRef(loaded);
  loadedRef.current = loaded;
  const chat = useCore()?.chat;
  const chatRef = useRef(chat);
  chatRef.current = chat;

  // One read per conversation at a time: a second press while one is under way waits for it.
  const read = useCallback((id: string, before?: number) => {
    const under = reading.current.get(id);
    if (under) return under;
    const p = api.channel
      .history({ id, before, limit: chatPage })
      .then((page) => setLoaded((all) => ({ ...all, [id]: mergeLoaded(all[id], page, page.length < chatPage) })))
      .catch(() => {})
      .finally(() => reading.current.delete(id));
    reading.current.set(id, p);
    return p;
  }, []);

  const ensure = useCallback((id: string) => void (loadedRef.current[id] || read(id)), [read]);

  const loadOlder = useCallback(
    async (id: string) => {
      const more = loadedRef.current[id];
      if (more?.complete) return;
      await read(id, messagesOf(chatRef.current, id, more)[0]?.number);
    },
    [read],
  );

  return <HistoryContext.Provider value={{ loaded, ensure, loadOlder }}>{children}</HistoryContext.Provider>;
}

export const useHistory = () => useContext(HistoryContext);

/** A shown conversation is read: the newest unread number goes to the server once it is drawn. */
export function useMarkRead(conversation: Conversation | undefined) {
  const chat = useCore()?.chat;
  const number = conversation ? newestUnread(chat, conversation) : undefined;
  const id = conversation?.id;
  useEffect(() => {
    if (id && number !== undefined) api.channel.markRead({ id, body: { number } }).catch(() => {});
  }, [id, number]);
}

/** A session's log (the manager's is "manager"): the read one, with what the live stream brought since merged in by seq. */
export function useSessionEvents(id: string, enabled: boolean) {
  const read = useQuery({ queryKey: ["session-events", id], queryFn: () => api.session.events({ id }), enabled });
  const [arrived, setArrived] = useState<SessionEvent[]>([]);
  useLive((e) => {
    if (enabled && e.type === "event" && e.id === id) setArrived((a) => mergeSteps(a, [e.activity]));
  });
  return mergeSteps(read.data ?? [], arrived);
}
