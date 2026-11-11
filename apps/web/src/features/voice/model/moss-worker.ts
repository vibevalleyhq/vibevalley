import { Predicate } from "effect";

import { mossRelay, type RelayCommand, type RelayEvent } from "./moss-relay.ts";

export interface MossRelayHandlers {
  readonly onOpen: () => void;
  readonly onText: (data: string) => void;
  readonly onBinary: (data: ArrayBuffer) => void;
  readonly onMicSent: (byteLength: number, level: number) => void;
  readonly onChunkEnded: (chunk: string, run: string, turn: string, aheadMs: number) => void;
  readonly onOutLevel: (level: number, aheadMs: number) => void;
  readonly onAudioStopped: (run: string, turn: string, partialMs: number) => void;
  readonly onClose: (opened: boolean, code: number, reason: string) => void;
}

export interface MossRelayBridge {
  readonly sendText: (text: string) => void;
  readonly sendBinary: (bytes: ArrayBuffer | Uint8Array) => void;
  readonly enqueuePlayback: (chunk: string, run: string, turn: string, pcm: ArrayBuffer) => void;
  readonly attachWorkletPorts: (capturePort: MessagePort, playbackPort: MessagePort) => void;
  readonly cutPlayback: (run: string, turn: string) => void;
  readonly bufferedAmount: () => number;
  /** Has the relay say how full the socket is now; bufferedAmount reads that once it comes. */
  readonly measure: () => void;
  readonly setMic: (enabled: boolean) => void;
  readonly close: () => void;
}

/** The relay in a worker, or on the page where there is none: the same relay (moss-relay.ts) and the same events either way. */
export function openMossRelayBridge(url: string, handlers: MossRelayHandlers): MossRelayBridge {
  const playbackMessage = (d: unknown) => {
    if (!Predicate.isObject(d)) return;
    if (
      d["type"] === "chunk_ended" &&
      typeof d["chunk"] === "string" &&
      typeof d["run"] === "string" &&
      typeof d["turn"] === "string" &&
      typeof d["aheadMs"] === "number"
    )
      handlers.onChunkEnded(d["chunk"], d["run"], d["turn"], d["aheadMs"]);
    else if (d["type"] === "out_level" && typeof d["level"] === "number" && typeof d["aheadMs"] === "number") handlers.onOutLevel(d["level"], d["aheadMs"]);
    else if (d["type"] === "cut_ack" && typeof d["run"] === "string" && typeof d["turn"] === "string" && typeof d["partialMs"] === "number")
      handlers.onAudioStopped(d["run"], d["turn"], d["partialMs"]);
  };
  let lastBuffered = 0;
  let closed = false;
  // One binary send at a time: the next waits until the relay says how full the socket is.
  let binaryPending = false;
  let ended = () => {};
  const heard = (d: RelayEvent) => {
    if (d.type === "closed") {
      ended();
      return;
    }
    if (closed) return;
    if ("bufferedAmount" in d) lastBuffered = d.bufferedAmount;
    switch (d.type) {
      case "open":
        handlers.onOpen();
        return;
      case "text":
        handlers.onText(d.data);
        return;
      case "binary":
        handlers.onBinary(d.data);
        return;
      case "mic_sent":
        handlers.onMicSent(d.byteLength, d.level);
        return;
      case "sent_binary":
        binaryPending = false;
        return;
      case "playback":
        playbackMessage(d.data);
        return;
      case "close":
        handlers.onClose(d.opened, d.code, d.reason);
        return;
      case "buffered":
        return;
    }
  };
  let send: (command: RelayCommand, transfer?: Transferable[]) => void;
  if (typeof Worker === "undefined") send = mossRelay(heard);
  else {
    const worker = new Worker(new URL("./moss-relay.worker.ts", import.meta.url), { type: "module" });
    ended = () => worker.terminate();
    worker.onmessage = (event: MessageEvent<RelayEvent>) => heard(event.data);
    worker.onerror = () => {
      if (!closed) handlers.onClose(false, 1011, "");
    };
    send = (command, transfer) => worker.postMessage(command, transfer ?? []);
  }
  send({ type: "connect", url });
  return {
    sendText: (text) => send({ type: "send_text", text }),
    sendBinary: (bytes) => {
      if (binaryPending || closed) return;
      binaryPending = true;
      const buffer = bytes instanceof Uint8Array ? bytes.slice().buffer : bytes.slice(0);
      lastBuffered += buffer.byteLength;
      send({ type: "send_binary", bytes: buffer }, [buffer]);
    },
    enqueuePlayback: (chunk, run, turn, pcm) => send({ type: "enqueue", chunk, run, turn, pcm }, [pcm]),
    attachWorkletPorts: (capturePort, playbackPort) => send({ type: "ports", capturePort, playbackPort }, [capturePort, playbackPort]),
    cutPlayback: (run, turn) => send({ type: "cut_playback", run, turn }),
    bufferedAmount: () => (binaryPending ? Infinity : lastBuffered),
    measure: () => send({ type: "measure" }),
    setMic: (enabled) => send({ type: "mic", enabled }),
    close: () => {
      closed = true;
      send({ type: "close" });
    },
  };
}
