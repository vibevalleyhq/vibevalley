import { t } from "@vibevalley/i18n";
import { visionLinePath } from "@vibevalley/protocol";
import { VisionSession, visionBufferedBytes } from "@vibevalley/provider/moss/vision";

import { canCapture, VisualCapture, type VisualSource } from "./visual-capture.ts";

export class VisionLine {
  version = 0;
  problem: string | undefined;
  source: VisualSource = "camera";
  private socket: WebSocket | undefined;
  private generation = 0;
  private readonly listeners = new Set<() => void>();
  private readonly capture = new VisualCapture({
    ready: () => this.session.readyForInput && (this.socket?.bufferedAmount ?? Infinity) < visionBufferedBytes,
    maxBytes: () => this.session.maxFrameBytes,
    frame: (bytes, timestamp) => {
      if (this.session.frame(bytes, timestamp)) this.changed();
    },
    failed: (problem) => this.fail(problem),
  });
  session = this.makeSession();

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private changed() {
    this.version++;
    for (const listener of this.listeners) listener();
  }

  private makeSession(): VisionSession {
    return new VisionSession({
      sendText: (json) => {
        if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(json);
      },
      sendBinary: (bytes) => {
        if (this.socket?.readyState === WebSocket.OPEN)
          this.socket.send(bytes.buffer instanceof ArrayBuffer ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) : new Uint8Array(bytes));
      },
      bufferedAmount: () => this.socket?.bufferedAmount ?? Infinity,
      onChange: () => this.changed(),
      onEnd: () => this.release(),
    });
  }

  async start(source: VisualSource) {
    if (this.socket || this.session.phase === "connecting" || this.session.phase === "ready") return;
    if (!canCapture(source)) return this.fail(t("web.voice.vision.unavailable"));
    this.problem = undefined;
    this.source = source;
    this.session = this.makeSession();
    const generation = ++this.generation;
    this.session.begin();
    document.addEventListener("visibilitychange", this.background);
    window.addEventListener("pagehide", this.stop);
    // Request screen permission in the user's click, before awaiting the relay handshake.
    if (!(await this.capture.start(source)) || generation !== this.generation) return;
    const url = new URL(visionLinePath, location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    try {
      const socket = new WebSocket(url);
      this.socket = socket;
      socket.onmessage = (event: MessageEvent<unknown>) => {
        if (generation !== this.generation) return;
        if (typeof event.data === "string") this.session.receive(event.data);
        else this.fail(t("web.voice.vision.closed"));
      };
      socket.onerror = () => {
        if (generation === this.generation) this.fail(t("web.voice.vision.closed"));
      };
      socket.onclose = () => {
        if (generation === this.generation) this.fail(t("web.voice.vision.closed"));
      };
    } catch {
      if (generation === this.generation) this.fail(t("web.voice.vision.closed"));
    }
  }

  prompt(text: string, final: boolean) {
    const accepted = this.session.prompt(text, final);
    if (accepted) this.changed();
    return accepted;
  }

  private background = () => {
    if (document.hidden) this.stop();
  };

  stop = () => {
    this.session.stop();
    this.release();
    this.changed();
  };

  private fail(problem: string) {
    this.problem = problem;
    this.session.disconnect();
    this.release();
    this.changed();
  }

  private release() {
    this.generation++;
    this.capture.stop();
    const socket = this.socket;
    this.socket = undefined;
    socket?.close(1000);
    document.removeEventListener("visibilitychange", this.background);
    window.removeEventListener("pagehide", this.stop);
  }
}
