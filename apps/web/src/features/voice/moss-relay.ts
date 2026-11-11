export type RelayCommand =
  | { readonly type: "connect"; readonly url: string }
  | { readonly type: "ports"; readonly capturePort: MessagePort; readonly playbackPort: MessagePort }
  | { readonly type: "mic"; readonly enabled: boolean }
  | { readonly type: "send_text"; readonly text: string }
  | { readonly type: "send_binary"; readonly bytes: ArrayBuffer }
  | { readonly type: "enqueue"; readonly chunk: string; readonly run: string; readonly turn: string; readonly pcm: ArrayBuffer }
  | { readonly type: "cut_playback"; readonly run: string; readonly turn: string }
  /** WebSocket drains bufferedAmount silently, so the page polls it on its own tick. */
  | { readonly type: "measure" }
  | { readonly type: "close" };

export type RelayEvent =
  | { readonly type: "open" }
  | { readonly type: "text"; readonly data: string; readonly bufferedAmount: number }
  | { readonly type: "binary"; readonly data: ArrayBuffer; readonly bufferedAmount: number }
  | { readonly type: "buffered"; readonly bufferedAmount: number }
  | { readonly type: "mic_sent"; readonly byteLength: number; readonly level: number; readonly bufferedAmount: number }
  | { readonly type: "sent_binary"; readonly bufferedAmount: number }
  | { readonly type: "playback"; readonly data: unknown }
  | { readonly type: "close"; readonly opened: boolean; readonly code: number; readonly reason: string }
  | { readonly type: "closed" };

/** 640 bytes of 16 kHz PCM plus 1 sequence byte. */
const micFrameBytes = 641;
/** Drop mic frames past this threshold instead of queueing stale audio. */
const micBufferMax = 65_536;
const sendBufferMax = 524_288;

export function mossRelay(post: (event: RelayEvent, transfer?: Transferable[]) => void): (command: RelayCommand) => void {
  let ws: WebSocket | undefined;
  let capturePort: MessagePort | undefined;
  let playbackPort: MessagePort | undefined;
  let micEnabled = false;
  const open = (socket: WebSocket | undefined): socket is WebSocket => socket !== undefined && socket.readyState === WebSocket.OPEN;
  return (d) => {
    switch (d.type) {
      case "connect": {
        let opened = false;
        const socket = new WebSocket(d.url);
        socket.binaryType = "arraybuffer";
        ws = socket;
        socket.onopen = () => {
          opened = true;
          post({ type: "open" });
        };
        socket.onmessage = (message: MessageEvent<unknown>) => {
          if (typeof message.data === "string") post({ type: "text", data: message.data, bufferedAmount: socket.bufferedAmount });
          else if (message.data instanceof ArrayBuffer) post({ type: "binary", data: message.data, bufferedAmount: socket.bufferedAmount }, [message.data]);
        };
        socket.onclose = (e) => {
          if (ws === socket) post({ type: "close", opened, code: e.code, reason: e.reason });
        };
        return;
      }
      case "ports":
        capturePort = d.capturePort;
        playbackPort = d.playbackPort;
        capturePort.onmessage = (event: MessageEvent<unknown>) => {
          const frame: unknown = event.data;
          if (typeof frame !== "object" || frame === null || !("type" in frame) || frame.type !== "mic_frame" || !("frame" in frame)) return;
          const bytes = frame.frame;
          const level = "level" in frame && typeof frame.level === "number" ? frame.level : 0;
          if (
            micEnabled &&
            bytes instanceof ArrayBuffer &&
            bytes.byteLength === micFrameBytes &&
            open(ws) &&
            ws.bufferedAmount + micFrameBytes <= micBufferMax
          ) {
            ws.send(bytes);
            post({ type: "mic_sent", byteLength: micFrameBytes, level, bufferedAmount: ws.bufferedAmount });
          }
        };
        playbackPort.onmessage = (event: MessageEvent<unknown>) => post({ type: "playback", data: event.data });
        return;
      case "mic":
        micEnabled = d.enabled;
        return;
      case "measure":
        if (ws !== undefined) post({ type: "buffered", bufferedAmount: ws.bufferedAmount });
        return;
      case "send_text":
        if (open(ws)) ws.send(d.text);
        return;
      case "send_binary":
        if (open(ws) && ws.bufferedAmount + d.bytes.byteLength <= sendBufferMax) ws.send(d.bytes);
        post({ type: "sent_binary", bufferedAmount: ws?.bufferedAmount ?? 0 });
        return;
      case "enqueue":
        playbackPort?.postMessage(d, [d.pcm]);
        return;
      case "cut_playback":
        playbackPort?.postMessage({ type: "cut", run: d.run, turn: d.turn });
        return;
      case "close": {
        micEnabled = false;
        capturePort?.close();
        playbackPort?.postMessage({ type: "clear" });
        playbackPort?.close();
        const socket = ws;
        ws = undefined;
        if (socket !== undefined && socket.readyState !== WebSocket.CLOSED) socket.close(1000);
        post({ type: "closed" });
        return;
      }
    }
  };
}
