import { Predicate } from "effect";

const mossRelayWorkerCode = `
let ws = null;
let capturePort = null;
let playbackPort = null;
let micEnabled = false;
const meter = setInterval(() => {
  if (ws) self.postMessage({ type: "buffered", bufferedAmount: ws.bufferedAmount });
}, 1000);
self.onmessage = (event) => {
  const d = event.data;
  if (d.type === "connect") {
    let opened = false;
    const socket = new WebSocket(d.url);
    socket.binaryType = "arraybuffer";
    ws = socket;
    socket.onopen = () => { opened = true; self.postMessage({ type: "open" }); };
    socket.onmessage = (message) => {
      if (typeof message.data === "string") self.postMessage({ type: "text", data: message.data, bufferedAmount: socket.bufferedAmount });
      else if (message.data instanceof ArrayBuffer) self.postMessage({ type: "binary", data: message.data, bufferedAmount: socket.bufferedAmount }, [message.data]);
    };
    socket.onclose = (e) => {
      if (ws === socket) self.postMessage({ type: "close", opened, code: e.code, reason: e.reason });
    };
  } else if (d.type === "ports") {
    capturePort = d.capturePort;
    playbackPort = d.playbackPort;
    capturePort.onmessage = (event) => {
      const frame = event.data;
      if (micEnabled && frame.type === "mic_frame" && frame.frame instanceof ArrayBuffer && frame.frame.byteLength === 641 &&
          ws && ws.readyState === WebSocket.OPEN && ws.bufferedAmount + 641 <= 65536) {
        ws.send(frame.frame);
        self.postMessage({ type: "mic_sent", byteLength: 641, level: frame.level, bufferedAmount: ws.bufferedAmount });
      }
    };
    playbackPort.onmessage = (event) => self.postMessage(event.data);
  } else if (d.type === "mic") {
    micEnabled = d.enabled;
  } else if (d.type === "send_text") {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(d.text);
  } else if (d.type === "send_binary") {
    if (ws && ws.readyState === WebSocket.OPEN && ws.bufferedAmount + d.bytes.byteLength <= 524288) ws.send(d.bytes);
    self.postMessage({ type: "sent_binary", bufferedAmount: ws ? ws.bufferedAmount : 0 });
  } else if (d.type === "enqueue") {
    if (playbackPort) playbackPort.postMessage(d, [d.pcm]);
  } else if (d.type === "cut_playback") {
    if (playbackPort) playbackPort.postMessage({ type: "cut", run: d.run, turn: d.turn });
  } else if (d.type === "close") {
    micEnabled = false;
    clearInterval(meter);
    if (capturePort) capturePort.close();
    if (playbackPort) { playbackPort.postMessage({ type: "clear" }); playbackPort.close(); }
    const socket = ws;
    ws = null;
    if (socket && socket.readyState !== WebSocket.CLOSED) socket.close(1000);
    self.postMessage({ type: "closed" });
  }
};
`;

let workerBlobUrl: string | undefined;

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
  readonly setMic: (enabled: boolean) => void;
  readonly close: () => void;
}

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
  if (typeof Worker !== "undefined" && typeof URL.createObjectURL === "function") {
    workerBlobUrl ??= URL.createObjectURL(new Blob([mossRelayWorkerCode], { type: "text/javascript" }));
    const worker = new Worker(workerBlobUrl);
    let lastBuffered = 0;
    let closed = false;
    let binaryPending = false;
    worker.onmessage = (event: MessageEvent<unknown>) => {
      const d = event.data;
      if (!Predicate.isObject(d)) return;
      if (d["type"] === "closed") {
        worker.terminate();
        return;
      }
      if (closed) return;
      if (typeof d["bufferedAmount"] === "number") lastBuffered = d["bufferedAmount"];
      if (d["type"] === "sent_binary") binaryPending = false;
      switch (d["type"]) {
        case "open":
          handlers.onOpen();
          break;
        case "text":
          if (typeof d["data"] === "string") handlers.onText(d["data"]);
          break;
        case "binary":
          if (d["data"] instanceof ArrayBuffer) handlers.onBinary(d["data"]);
          break;
        case "mic_sent":
          if (typeof d["byteLength"] === "number" && typeof d["level"] === "number") handlers.onMicSent(d["byteLength"], d["level"]);
          break;
        case "close":
          if (typeof d["opened"] === "boolean" && typeof d["code"] === "number" && typeof d["reason"] === "string")
            handlers.onClose(d["opened"], d["code"], d["reason"]);
          break;
        default:
          playbackMessage(d);
      }
    };
    worker.onerror = () => {
      if (!closed) handlers.onClose(false, 1011, "");
    };
    worker.postMessage({ type: "connect", url });
    return {
      sendText: (text) => worker.postMessage({ type: "send_text", text }),
      sendBinary: (bytes) => {
        if (binaryPending || closed) return;
        binaryPending = true;
        const buffer = bytes instanceof Uint8Array ? bytes.slice().buffer : bytes.slice(0);
        lastBuffered += buffer.byteLength;
        worker.postMessage({ type: "send_binary", bytes: buffer }, [buffer]);
      },
      enqueuePlayback: (chunk, run, turn, pcm) => worker.postMessage({ type: "enqueue", chunk, run, turn, pcm }, [pcm]),
      attachWorkletPorts: (capturePort, playbackPort) => worker.postMessage({ type: "ports", capturePort, playbackPort }, [capturePort, playbackPort]),
      cutPlayback: (run, turn) => worker.postMessage({ type: "cut_playback", run, turn }),
      bufferedAmount: () => (binaryPending ? Infinity : lastBuffered),
      setMic: (enabled) => worker.postMessage({ type: "mic", enabled }),
      close: () => {
        closed = true;
        worker.postMessage({ type: "close" });
      },
    };
  }

  const socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";
  let opened = false;
  let micEnabled = false;
  let capturePort: MessagePort | undefined;
  let playbackPort: MessagePort | undefined;
  socket.onopen = () => {
    opened = true;
    handlers.onOpen();
  };
  socket.onmessage = (event: MessageEvent<unknown>) => {
    if (typeof event.data === "string") handlers.onText(event.data);
    else if (event.data instanceof ArrayBuffer) handlers.onBinary(event.data);
  };
  socket.onclose = (event) => handlers.onClose(opened, event.code, event.reason);
  return {
    sendText: (text) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(text);
    },
    sendBinary: (bytes) => {
      if (socket.readyState !== WebSocket.OPEN || socket.bufferedAmount + bytes.byteLength > 524288) return;
      if (bytes instanceof ArrayBuffer) socket.send(bytes);
      else socket.send(bytes.buffer instanceof ArrayBuffer ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) : new Uint8Array(bytes));
    },
    enqueuePlayback: (chunk, run, turn, pcm) => playbackPort?.postMessage({ type: "enqueue", chunk, run, turn, pcm }, [pcm]),
    attachWorkletPorts: (capture, playback) => {
      capturePort = capture;
      playbackPort = playback;
      capture.onmessage = (event: MessageEvent<unknown>) => {
        const d = event.data;
        if (
          Predicate.isObject(d) &&
          d["type"] === "mic_frame" &&
          d["frame"] instanceof ArrayBuffer &&
          d["frame"].byteLength === 641 &&
          micEnabled &&
          socket.readyState === WebSocket.OPEN &&
          socket.bufferedAmount + 641 <= 65536
        ) {
          socket.send(d["frame"]);
          handlers.onMicSent(641, typeof d["level"] === "number" ? d["level"] : 0);
        }
      };
      playback.onmessage = (event: MessageEvent<unknown>) => playbackMessage(event.data);
    },
    cutPlayback: (run, turn) => playbackPort?.postMessage({ type: "cut", run, turn }),
    bufferedAmount: () => socket.bufferedAmount,
    setMic: (enabled) => {
      micEnabled = enabled;
    },
    close: () => {
      micEnabled = false;
      capturePort?.close();
      playbackPort?.postMessage({ type: "clear" });
      playbackPort?.close();
      if (socket.readyState !== WebSocket.CLOSED) socket.close(1000);
    },
  };
}
