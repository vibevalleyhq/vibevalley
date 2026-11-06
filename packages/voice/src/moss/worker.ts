import { decodeMossFrame, levelOf, unpackPcm16 } from "./protocol.ts";

/**
 * Dedicated Web Worker script (`mossRelayWorkerCode`):
 * - Owns the `WebSocket` connection to `/api/v1/voice/moss/line`.
 * - Connects directly to `CaptureWorklet` and `PlaybackWorklet` via transferred `MessagePort`s.
 * - Uplink 641-byte `tagged-v1` frames flow `CaptureWorklet -> Worker -> WebSocket` without touching the UI main thread.
 * - Downlink 48 kHz PCM `ArrayBuffer` chunks flow `WebSocket -> Worker -> PlaybackWorklet` via zero-copy transferable buffers,
 *   while only lightweight numeric metadata (`byteLength`, `samples`, `level`, `bufferedAmount`) goes to the UI main thread.
 */
export const mossRelayWorkerCode = `
let ws = null;
let opened = false;
let capturePort = null;
let playbackPort = null;
let pendingPiece = null;

function parseAudioContext(text) {
  try {
    const m = JSON.parse(text);
    if (m && m.action === "response.audio.context" && m.data) {
      return {
        chunk: String(m.data.chunk_id || ""),
        run: String(m.data.run_id || ""),
        turn: String(m.data.turn_id || ""),
      };
    }
  } catch {}
  return null;
}

function calcLevel(pcm) {
  if (pcm.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) {
    const v = pcm[i] / 0x8000;
    sum += v * v;
  }
  return Math.min(100, Math.round(Math.sqrt(sum / pcm.length) * 300));
}

self.onmessage = (e) => {
  const d = e.data;
  if (!d || typeof d !== "object") return;
  if (d.type === "connect") {
    opened = false;
    pendingPiece = null;
    const sock = new WebSocket(d.url);
    sock.binaryType = "arraybuffer";
    ws = sock;
    sock.onopen = () => {
      opened = true;
      self.postMessage({ type: "open" });
    };
    sock.onmessage = (msg) => {
      if (typeof msg.data === "string") {
        const ctx = parseAudioContext(msg.data);
        if (ctx) pendingPiece = ctx;
        self.postMessage({ type: "text", data: msg.data, bufferedAmount: sock.bufferedAmount });
      } else if (msg.data instanceof ArrayBuffer) {
        const byteLength = msg.data.byteLength;
        const pcm = new Int16Array(msg.data, 0, Math.floor(byteLength / 2));
        const samples = pcm.length;
        const level = calcLevel(pcm);
        const piece = pendingPiece;
        pendingPiece = null;
        if (playbackPort && piece) {
          playbackPort.postMessage(
            { type: "enqueue", chunk: piece.chunk, run: piece.run, turn: piece.turn, pcm: msg.data },
            [msg.data],
          );
          self.postMessage({
            type: "audio_meta",
            byteLength,
            samples,
            level,
            bufferedAmount: sock.bufferedAmount,
          });
        } else {
          self.postMessage(
            { type: "binary", data: msg.data, bufferedAmount: sock.bufferedAmount },
            [msg.data],
          );
        }
      }
    };
    sock.onclose = (ev) => {
      if (ws !== sock) return;
      self.postMessage({ type: "close", opened, code: ev.code, reason: ev.reason || "" });
    };
  } else if (d.type === "ports") {
    if (d.capturePort) {
      capturePort = d.capturePort;
      capturePort.onmessage = (ev) => {
        const m = ev.data;
        if (m && m.type === "mic_frame" && m.frame instanceof ArrayBuffer) {
          const byteLength = m.frame.byteLength;
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(m.frame);
            self.postMessage({
              type: "mic_sent",
              byteLength,
              level: Number(m.level || 0),
              bufferedAmount: ws.bufferedAmount,
            });
          }
        }
      };
    }
    if (d.playbackPort) {
      playbackPort = d.playbackPort;
      playbackPort.onmessage = (ev) => {
        const m = ev.data;
        if (!m || typeof m !== "object") return;
        self.postMessage(m);
      };
    }
  } else if (d.type === "send_text") {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(d.text);
      self.postMessage({ type: "buffered", bufferedAmount: ws.bufferedAmount });
    }
  } else if (d.type === "send_binary" && d.bytes instanceof ArrayBuffer) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(d.bytes);
      self.postMessage({ type: "buffered", bufferedAmount: ws.bufferedAmount });
    }
  } else if (d.type === "cut_playback") {
    if (playbackPort) {
      playbackPort.postMessage({ type: "cut", run: d.run, turn: d.turn });
    }
  } else if (d.type === "close") {
    if (playbackPort) {
      playbackPort.postMessage({ type: "clear" });
      playbackPort = null;
    }
    capturePort = null;
    const sock = ws;
    ws = null;
    if (sock && sock.readyState !== WebSocket.CLOSED) sock.close(1000);
  }
};
`;

let workerBlobUrl: string | undefined;

export interface MossRelayHandlers {
  readonly onOpen: () => void;
  readonly onText: (data: string) => void;
  readonly onBinary: (data: ArrayBuffer) => void;
  readonly onAudioMeta: (byteLength: number, samples: number, level: number) => void;
  readonly onMicSent: (byteLength: number, level: number) => void;
  readonly onChunkEnded: (chunk: string, run: string, turn: string, aheadMs: number) => void;
  readonly onOutLevel: (level: number, aheadMs: number) => void;
  readonly onClose: (opened: boolean, code: number, reason: string) => void;
}

export interface MossRelayBridge {
  readonly sendText: (text: string) => void;
  readonly sendBinary: (bytes: ArrayBuffer | Uint8Array) => void;
  readonly attachWorkletPorts: (capturePort: MessagePort, playbackPort: MessagePort) => void;
  readonly cutPlayback: (run: string, turn: string) => void;
  readonly bufferedAmount: () => number;
  readonly close: () => void;
}

function isObject(value: unknown): value is { readonly [key: string]: unknown } {
  return typeof value === "object" && value !== null;
}

/**
 * Spawns a dedicated Web Worker (or falls back to in-process WebSocket if Worker is unavailable)
 * to run the MOSS WebSocket and connect directly to the Capture and Playback AudioWorklets.
 */
export function openMossRelayBridge(url: string, handlers: MossRelayHandlers): MossRelayBridge {
  if (typeof Worker !== "undefined" && typeof Blob !== "undefined" && typeof URL.createObjectURL === "function") {
    workerBlobUrl ??= URL.createObjectURL(new Blob([mossRelayWorkerCode], { type: "text/javascript" }));
    const worker: Worker = new Worker(workerBlobUrl);
    let lastBuffered = 0;
    worker.onmessage = (e: MessageEvent<unknown>) => {
      const d = e.data;
      if (!isObject(d) || typeof d["type"] !== "string") return;
      if (typeof d["bufferedAmount"] === "number") lastBuffered = d["bufferedAmount"];
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
        case "audio_meta":
          handlers.onAudioMeta(
            typeof d["byteLength"] === "number" ? d["byteLength"] : 0,
            typeof d["samples"] === "number" ? d["samples"] : 0,
            typeof d["level"] === "number" ? d["level"] : 0,
          );
          break;
        case "mic_sent":
          handlers.onMicSent(
            typeof d["byteLength"] === "number" ? d["byteLength"] : 0,
            typeof d["level"] === "number" ? d["level"] : 0,
          );
          break;
        case "chunk_ended":
          handlers.onChunkEnded(
            typeof d["chunk"] === "string" ? d["chunk"] : "",
            typeof d["run"] === "string" ? d["run"] : "",
            typeof d["turn"] === "string" ? d["turn"] : "",
            typeof d["aheadMs"] === "number" ? d["aheadMs"] : 0,
          );
          break;
        case "out_level":
          handlers.onOutLevel(
            typeof d["level"] === "number" ? d["level"] : 0,
            typeof d["aheadMs"] === "number" ? d["aheadMs"] : 0,
          );
          break;
        case "close":
          handlers.onClose(
            Boolean(d["opened"]),
            typeof d["code"] === "number" ? d["code"] : 1006,
            typeof d["reason"] === "string" ? d["reason"] : "",
          );
          break;
        default:
          break;
      }
    };
    worker.postMessage({ type: "connect", url });
    return {
      sendText: (text) => worker.postMessage({ type: "send_text", text }),
      sendBinary: (bytes) => {
        const copy = bytes instanceof Uint8Array ? bytes.slice().buffer : bytes.slice(0);
        worker.postMessage({ type: "send_binary", bytes: copy }, [copy]);
      },
      attachWorkletPorts: (capturePort, playbackPort) => {
        worker.postMessage({ type: "ports", capturePort, playbackPort }, [capturePort, playbackPort]);
      },
      cutPlayback: (run, turn) => worker.postMessage({ type: "cut_playback", run, turn }),
      bufferedAmount: () => lastBuffered,
      close: () => {
        worker.postMessage({ type: "close" });
        worker.terminate();
      },
    };
  }

  // Fallback when Web Worker is not available in the current environment.
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  let opened = false;
  let playbackPort: MessagePort | undefined;
  let pendingPiece: { readonly chunk: string; readonly run: string; readonly turn: string } | undefined;

  ws.onopen = () => {
    opened = true;
    handlers.onOpen();
  };
  ws.onmessage = (e: MessageEvent<string | ArrayBuffer>) => {
    if (typeof e.data === "string") {
      const decoded = decodeMossFrame(e.data);
      if (decoded._tag === "Some" && decoded.value.action === "response.audio.context") {
        const d = decoded.value.data ?? {};
        pendingPiece = { chunk: d.chunk_id ?? "", run: d.run_id ?? "", turn: d.turn_id ?? "" };
      }
      handlers.onText(e.data);
    } else if (e.data instanceof ArrayBuffer) {
      const piece = pendingPiece;
      pendingPiece = undefined;
      if (playbackPort && piece) {
        const pcm = unpackPcm16(e.data);
        const lvl = levelOf(pcm);
        playbackPort.postMessage({ type: "enqueue", chunk: piece.chunk, run: piece.run, turn: piece.turn, pcm: e.data }, [e.data]);
        handlers.onAudioMeta(e.data.byteLength, pcm.length, lvl);
      } else {
        handlers.onBinary(e.data);
      }
    }
  };
  ws.onclose = (e) => handlers.onClose(opened, e.code, e.reason);

  return {
    sendText: (text) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(text);
    },
    sendBinary: (bytes) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(bytes);
    },
    attachWorkletPorts: (capture, playback) => {
      playbackPort = playback;
      capture.onmessage = (e: MessageEvent<unknown>) => {
        const d = e.data;
        if (isObject(d) && d["type"] === "mic_frame" && d["frame"] instanceof ArrayBuffer) {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(d["frame"]);
            handlers.onMicSent(d["frame"].byteLength, typeof d["level"] === "number" ? d["level"] : 0);
          }
        }
      };
      playback.onmessage = (e: MessageEvent<unknown>) => {
        const d = e.data;
        if (!isObject(d) || typeof d["type"] !== "string") return;
        if (d["type"] === "chunk_ended") {
          handlers.onChunkEnded(
            typeof d["chunk"] === "string" ? d["chunk"] : "",
            typeof d["run"] === "string" ? d["run"] : "",
            typeof d["turn"] === "string" ? d["turn"] : "",
            typeof d["aheadMs"] === "number" ? d["aheadMs"] : 0,
          );
        } else if (d["type"] === "out_level") {
          handlers.onOutLevel(
            typeof d["level"] === "number" ? d["level"] : 0,
            typeof d["aheadMs"] === "number" ? d["aheadMs"] : 0,
          );
        }
      };
    },
    cutPlayback: (run, turn) => playbackPort?.postMessage({ type: "cut", run, turn }),
    bufferedAmount: () => ws.bufferedAmount,
    close: () => {
      playbackPort?.postMessage({ type: "clear" });
      if (ws.readyState !== WebSocket.CLOSED) ws.close(1000);
    },
  };
}
