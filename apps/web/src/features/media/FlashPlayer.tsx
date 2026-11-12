import { createSignal, onSettled, Show } from "solid-js";

import { t } from "@vibevalley/i18n";
import type { MediaSpeechRequest } from "@vibevalley/protocol";

import { api, reasonOf } from "#/infra/api.ts";
import { createAct } from "#/ui/act.ts";
import { Button } from "#/ui/Button.tsx";

import { playFlashStream, type FlashPlaybackProgress } from "./flash-stream.ts";

type PlaybackPhase = "idle" | "connecting" | "playing" | "draining" | "done" | "stopped" | "failed";

/** A playback's own: its transfer, and the audio and job it came to hold. */
interface Playing {
  readonly transfer: AbortController;
  audio?: AudioContext;
  job?: string;
  canceled: boolean;
}

export function FlashPlayer(props: {
  request: MediaSpeechRequest | undefined;
  valid: boolean;
  prepare: () => MediaSpeechRequest | undefined;
  onActive: (active: boolean) => void;
}) {
  const [phase, setPhase] = createSignal<PlaybackPhase>("idle");
  const [progress, setProgress] = createSignal<FlashPlaybackProgress>({ receivedSeconds: 0, playedSeconds: 0, bufferedSeconds: 0, complete: false });
  const [error, setError] = createSignal<string>();
  let disposed = false;
  const act = createAct((reason) => {
    if (!disposed) setError(reason);
  });
  const cancelAct = createAct((reason) => {
    if (!disposed) setError(reason);
  });
  /** One playback while it lasts, with what it holds: none when nothing plays. */
  let run: Playing | undefined;
  const cancelTask = (r: Playing) => {
    const id = r.job;
    if (id !== undefined && !r.canceled) {
      r.canceled = true;
      void cancelAct.run(() => api.media.job.cancel({ id }));
    }
  };
  const stop = (reason?: string) => {
    const r = run;
    if (!r) return;
    r.transfer.abort();
    cancelTask(r);
    const current = r.audio;
    if (current && current.state !== "closed")
      void current.close().catch((cause) => {
        if (!disposed) setError(reasonOf(cause));
      });
    if (!disposed) {
      setPhase("stopped");
      if (reason) setError(reason);
    }
  };
  onSettled(() => {
    const changed = () => stop(t("web.audio.flashDeviceChanged"));
    navigator.mediaDevices?.addEventListener("devicechange", changed);
    return () => {
      disposed = true;
      navigator.mediaDevices?.removeEventListener("devicechange", changed);
      stop();
    };
  });
  const start = () => {
    if (run || act.busy() || props.request || !props.valid || typeof AudioContext === "undefined") return;
    const { prepare, onActive } = props;
    const r: Playing = { transfer: new AbortController(), canceled: false };
    run = r;
    const { transfer } = r;
    setError(undefined);
    setProgress({ receivedSeconds: 0, playedSeconds: 0, bufferedSeconds: 0, complete: false });
    setPhase("connecting");
    onActive(true);
    return act
      .run(async () => {
        let completed = false;
        let audio: AudioContext | undefined;
        const stateChanged = () => {
          if (audio && audio.state !== "running") stop(t("web.audio.flashDeviceChanged"));
        };
        try {
          audio = new AudioContext();
          r.audio = audio;
          const resumed = audio.resume();
          const request = prepare();
          await resumed;
          transfer.signal.throwIfAborted();
          audio.addEventListener("statechange", stateChanged);
          if (!request) {
            if (!disposed) setPhase("stopped");
            return;
          }
          r.job = request.id;
          await api.media.speech.create(request, { signal: transfer.signal });
          await playFlashStream(request.id, audio, transfer.signal, (value) => {
            if (disposed) return;
            setProgress(value);
            setPhase(value.complete ? "draining" : "playing");
          });
          completed = true;
          if (!disposed) setPhase("done");
        } catch (cause) {
          if (!transfer.signal.aborted) {
            if (!disposed) setPhase("failed");
            throw cause;
          }
        } finally {
          transfer.abort();
          if (!completed) cancelTask(r);
          audio?.removeEventListener("statechange", stateChanged);
          try {
            if (audio && audio.state !== "closed") await audio.close();
          } finally {
            if (run === r) run = undefined;
            if (!disposed) onActive(false);
          }
        }
      })
      .finally(() => {
        if (run === r && r.job === undefined) {
          run = undefined;
          if (!disposed) {
            onActive(false);
            setPhase("failed");
          }
        }
      });
  };
  const phaseText = () => {
    switch (phase()) {
      case "idle":
        return t("web.audio.flashIdle");
      case "connecting":
        return t("web.audio.flashConnecting");
      case "playing":
        return t("web.audio.flashPlaying");
      case "draining":
        return t("web.audio.flashDraining");
      case "done":
        return t("web.audio.flashDone");
      case "stopped":
        return t("web.audio.flashStopped");
      case "failed":
        return t("web.audio.flashIncomplete");
    }
  };
  return (
    <section
      class="flex min-w-0 flex-col gap-3"
      aria-label={t("web.audio.flashTitle")}
      data-testid="flash-player"
      data-phase={phase()}
      data-received={progress().receivedSeconds}
      data-played={progress().playedSeconds}
      data-buffered={progress().bufferedSeconds}
      data-partial={(phase() === "failed" || phase() === "stopped") && progress().receivedSeconds > 0 ? "true" : "false"}
    >
      <p class="text-sm text-muted">{t("web.audio.flashNotice")}</p>
      <p role="status" class="text-sm">
        {phaseText()}
      </p>
      <Show when={progress().receivedSeconds > 0}>
        <p class="text-xs text-muted">
          {t("web.audio.flashProgress", { received: progress().receivedSeconds.toFixed(2), played: progress().playedSeconds.toFixed(2) })}
        </p>
      </Show>
      <Show
        when={typeof AudioContext !== "undefined"}
        fallback={
          <p role="alert" class="text-sm text-berry">
            {t("web.audio.flashUnsupported")}
          </p>
        }
      >
        <div class="flex flex-wrap gap-2">
          <Button data-testid="flash-start" tone="primary" disabled={act.busy() || Boolean(props.request) || !props.valid} onClick={() => void start()}>
            {t("web.audio.flashStart")}
          </Button>
          <Button data-testid="flash-stop" disabled={!act.busy()} onClick={() => stop()}>
            {t("web.audio.flashStop")}
          </Button>
        </div>
      </Show>
      <Show when={error()}>
        {(message) => (
          <p data-testid="flash-error" role="alert" class="text-sm wrap-break-word text-berry">
            {message()}
          </p>
        )}
      </Show>
    </section>
  );
}
