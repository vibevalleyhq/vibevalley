import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { readStream, statePath, type StateFrame } from "@vibevalley/protocol";

export type Link = "connecting" | "open" | "lost";

interface Frames {
  frame: StateFrame | undefined;
  link: Link;
  /** Frames received since the page opened: the tests watch it to know a change came through the stream. */
  count: number;
}

const FrameContext = createContext<Frames>({ frame: undefined, link: "connecting", count: 0 });

/** One state stream for the whole page; it reconnects a second after it drops. */
export function FrameProvider({ children }: { children: ReactNode }) {
  const [frames, setFrames] = useState<Frames>({ frame: undefined, link: "connecting", count: 0 });
  useEffect(() => {
    const abort = new AbortController();
    let retry: ReturnType<typeof setTimeout> | undefined;
    const connect = () =>
      readStream<StateFrame>(statePath, (frame) => setFrames((f) => ({ frame, link: "open", count: f.count + 1 })), abort.signal).catch(() => {
        if (abort.signal.aborted) return;
        setFrames((f) => ({ ...f, link: "lost" }));
        retry = setTimeout(connect, 1000);
      });
    void connect();
    return () => {
      abort.abort();
      clearTimeout(retry);
    };
  }, []);
  return <FrameContext.Provider value={frames}>{children}</FrameContext.Provider>;
}

export const useFrames = () => useContext(FrameContext);

/** The folded state; undefined until the first frame. */
export const useCore = () => useContext(FrameContext).frame?.state;
