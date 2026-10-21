import { useEffect, useRef } from "react";
import { type LiveEvent, livePath, readStream } from "@vibevalley/protocol";

type Listener = (e: LiveEvent) => void;

const listeners = new Set<Listener>();
let abort: AbortController | undefined;

// One live stream while anyone listens; it reconnects a second after it drops and closes with the last listener.
function connect(signal: AbortSignal) {
  readStream<LiveEvent>(livePath, (e) => listeners.forEach((l) => l(e)), signal).catch(() => {
    if (!signal.aborted) setTimeout(() => !signal.aborted && connect(signal), 1000);
  });
}

function subscribe(l: Listener) {
  listeners.add(l);
  if (!abort) {
    abort = new AbortController();
    connect(abort.signal);
  }
  return () => {
    listeners.delete(l);
    if (listeners.size === 0) {
      abort?.abort();
      abort = undefined;
    }
  };
}

/** Calls onEvent with each event of the live stream (/api/v1/live) while mounted. */
export function useLive(onEvent: Listener) {
  const ref = useRef(onEvent);
  ref.current = onEvent;
  useEffect(() => subscribe((e) => ref.current(e)), []);
}
