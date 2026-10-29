import { type LiveEvent, livePath, readStream } from "@vibevalley/protocol";

type Listener = (e: LiveEvent) => void;

const listeners = new Set<Listener>();
const connections = new Set<() => void>();
let abort: AbortController | undefined;

// One live stream while anyone listens; it reconnects a second after it drops and closes with the last listener.
function connect(signal: AbortSignal) {
  readStream(
    "",
    livePath,
    (e) => listeners.forEach((l) => l(e)),
    signal,
    async (url, init) => {
      const response = await fetch(url, init);
      if (response.ok && !signal.aborted) for (const connected of connections) connected();
      return response;
    },
  ).catch(() => {
    if (!signal.aborted) setTimeout(() => !signal.aborted && connect(signal), 1000);
  });
}

/** Listens to the live stream (/api/v1/live); returns how to stop. Framework-free: the Solid side subscribes here too. */
export function subscribeLive(l: Listener, connected?: () => void) {
  listeners.add(l);
  if (connected) connections.add(connected);
  if (!abort) {
    abort = new AbortController();
    connect(abort.signal);
  }
  return () => {
    listeners.delete(l);
    if (connected) connections.delete(connected);
    if (listeners.size === 0) {
      abort?.abort();
      abort = undefined;
    }
  };
}
