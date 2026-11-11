import { t } from "@vibevalley/i18n";
import { visionFrameBytes, visionFrameIntervalMs } from "@vibevalley/provider/moss/vision";

import { currentHost } from "#/infra/host.ts";

export type VisualSource = "camera" | "screen";

type VisualCaptureSink = {
  ready(): boolean;
  maxBytes(): number;
  frame(bytes: Uint8Array, timestamp: number): void;
  failed(problem: string): void;
};

export function localRelayHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

export function canCapture(source: VisualSource): boolean {
  const host = currentHost().name;
  if (!localRelayHost(location.hostname) || !window.isSecureContext || host === "mobile" || (host === "desktop" && source === "screen")) return false;
  return source === "camera" ? typeof navigator.mediaDevices?.getUserMedia === "function" : typeof navigator.mediaDevices?.getDisplayMedia === "function";
}

export class VisualCapture {
  private generation = 0;
  private stream: MediaStream | undefined;
  private video: HTMLVideoElement | undefined;
  private timer: number | undefined;
  private encoding = false;

  private readonly sink: VisualCaptureSink;

  constructor(sink: VisualCaptureSink) {
    this.sink = sink;
  }

  async start(source: VisualSource): Promise<boolean> {
    this.stop();
    const generation = this.generation;
    if (!canCapture(source)) {
      this.sink.failed(t("web.voice.vision.unavailable"));
      return false;
    }
    let stream: MediaStream | undefined;
    try {
      stream = await (source === "camera"
        ? navigator.mediaDevices.getUserMedia({ audio: false, video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 1, max: 1 } } })
        : navigator.mediaDevices.getDisplayMedia({ audio: false, video: { frameRate: { ideal: 1, max: 1 } } }));
      if (generation !== this.generation) {
        stream.getTracks().forEach((track) => track.stop());
        return false;
      }
      this.stream = stream;
      const track = stream.getVideoTracks()[0];
      if (!track || track.readyState === "ended") throw new Error(t("web.voice.vision.deviceLost"));
      track.addEventListener(
        "ended",
        () => {
          if (generation !== this.generation) return;
          this.stop();
          this.sink.failed(t("web.voice.vision.deviceLost"));
        },
        { once: true },
      );
      const video = document.createElement("video");
      this.video = video;
      video.muted = true;
      video.playsInline = true;
      video.srcObject = stream;
      await video.play();
      if (generation !== this.generation) return false;
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d");
      if (!context) throw new Error(t("web.voice.vision.captureFailed"));
      const started = performance.now();
      const next = () => {
        if (generation === this.generation) this.timer = window.setTimeout(() => void capture(), visionFrameIntervalMs);
      };
      const capture = async () => {
        if (generation !== this.generation) return;
        if (this.encoding || !this.sink.ready() || video.readyState < 2) return next();
        const scale = Math.min(1, 640 / video.videoWidth, (source === "camera" ? 480 : 640) / video.videoHeight);
        canvas.width = Math.max(1, Math.floor(video.videoWidth * scale));
        canvas.height = Math.max(1, Math.floor(video.videoHeight * scale));
        this.encoding = true;
        try {
          context.drawImage(video, 0, 0, canvas.width, canvas.height);
          const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.75));
          if (generation !== this.generation) return;
          if (!blob) throw new Error(t("web.voice.vision.captureFailed"));
          if (blob.size <= Math.min(visionFrameBytes, this.sink.maxBytes()) && this.sink.ready()) {
            const bytes = new Uint8Array(await blob.arrayBuffer());
            if (generation === this.generation && this.sink.ready()) this.sink.frame(bytes, (performance.now() - started) / 1000);
          }
          next();
        } catch {
          if (generation !== this.generation) return;
          this.stop();
          this.sink.failed(t("web.voice.vision.captureFailed"));
        } finally {
          this.encoding = false;
        }
      };
      void capture();
      return true;
    } catch (error) {
      stream?.getTracks().forEach((track) => track.stop());
      if (generation !== this.generation) return false;
      this.stop();
      this.sink.failed(error instanceof Error && error.name === "NotAllowedError" ? t("web.voice.vision.denied") : t("web.voice.vision.captureFailed"));
      return false;
    }
  }

  stop(): void {
    this.generation++;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = undefined;
    if (this.video) {
      this.video.pause();
      this.video.srcObject = null;
      this.video = undefined;
    }
  }
}
