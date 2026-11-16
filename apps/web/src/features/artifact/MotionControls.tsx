import { createEffect, createSignal, For, onSettled, Show } from "solid-js";

import { shellMessageOf } from "@vibevalley/artifact/shell";
import { Slider } from "@vibevalley/base-ui";
import { t } from "@vibevalley/i18n";

import { createAct } from "#/ui/act.ts";
import { Button } from "#/ui/Button.tsx";
import { IconButton } from "#/ui/IconButton.tsx";
import { toast } from "#/ui/toasts.ts";

import { type Controls, sendTo } from "./frame";
import { saveVideoToLibrary, useReportViewContext } from "./store";

export function MotionControls(props: Controls) {
  const duration = () => Math.max(0.1, props.shown().ready?.duration ?? 6);
  const fps = () => props.shown().ready?.fps ?? 30;
  const chapters = () => props.shown().ready?.chapters ?? [];
  const time = () => props.shown().at?.time ?? 0;
  const playing = () => props.shown().at?.playing === true;
  const [loop, setLoop] = createSignal(false);
  const [recording, setRecording] = createSignal(false);
  const saveAct = createAct();

  useReportViewContext(
    () => props.artifact.id,
    () => ({
      ...(props.artifact.artifactType ? { artifactType: props.artifact.artifactType } : {}),
      title: props.artifact.title,
      ...(props.artifact.body === "store" ? { seq: props.version } : { version: props.version }),
      time: Math.round(time() * 100) / 100,
    }),
  );

  createEffect(
    () => [loop(), playing(), time(), duration()] as const,
    ([isLoop, isPlaying, atTime, total]) => {
      if (isLoop && !isPlaying && total > 0 && atTime >= total - 0.02) {
        const send = sendTo(props.frame());
        send({ vibevalley: "seek", time: 0 });
        send({ vibevalley: "play" });
      }
    },
  );

  onSettled(() => {
    const heard = (e: MessageEvent) => {
      if (e.source === null || e.source !== props.frame()?.contentWindow) return;
      const msg = shellMessageOf(e.data);
      if (msg?.vibevalley !== "recorded") return;
      setRecording(false);
      if (!msg.ok || !msg.base64) {
        toast(t("web.artifact.motion.exportFailed", { why: msg.reason ?? "unknown" }), "bad");
        return;
      }
      const base64 = msg.base64;
      const mimeType = msg.mimeType ?? "video/webm";
      const title = props.artifact.title;
      void saveAct.run(async () => {
        await saveVideoToLibrary(title, base64, mimeType);
        toast(t("web.artifact.motion.exported"));
      });
    };
    window.addEventListener("message", heard);
    return () => window.removeEventListener("message", heard);
  });

  const togglePlay = () => sendTo(props.frame())({ vibevalley: playing() ? "pause" : "play" });
  const stepFrame = (delta: -1 | 1) => sendTo(props.frame())({ vibevalley: "step", delta });
  const seek = (nextTime: number) => sendTo(props.frame())({ vibevalley: "seek", time: nextTime });

  const exportVideo = () => {
    if (recording() || saveAct.busy()) return;
    if (duration() > 60) {
      toast(t("web.artifact.motion.tooLong"), "bad");
      return;
    }
    setRecording(true);
    sendTo(props.frame())({ vibevalley: "record", fps: fps() });
  };

  return (
    <div data-testid="motion-controls" class="flex shrink-0 flex-col gap-2 border-t border-line bg-page px-3 py-2">
      <div class="flex flex-wrap items-center gap-1.5">
        <IconButton
          icon={playing() ? "stop" : "play"}
          label={playing() ? t("web.artifact.motion.pause") : t("web.artifact.motion.play")}
          testid="motion-play-pause"
          onClick={togglePlay}
        />
        <IconButton icon="previous" label={t("web.artifact.motion.prevFrame")} testid="motion-prev-frame" onClick={() => stepFrame(-1)} />
        <IconButton icon="next" label={t("web.artifact.motion.nextFrame")} testid="motion-next-frame" onClick={() => stepFrame(1)} />
        <Slider.Root min={0} max={duration()} step={0.01} value={time()} onValueChange={seek} class="min-w-28 flex-1">
          <Slider.Control class="relative flex h-5 cursor-pointer items-center">
            <Slider.Track class="relative h-1.5 w-full rounded-full bg-selected">
              <Slider.Indicator class="h-full rounded-full bg-accent" />
              <Slider.Thumb
                aria-label={t("web.artifact.motion.time", { at: time().toFixed(2), duration: duration().toFixed(2) })}
                data-testid="motion-scrub"
                class="absolute top-[calc(50%_-_0.375rem)] h-3 w-3 rounded-full border border-line bg-page shadow-raise"
              />
            </Slider.Track>
          </Slider.Control>
        </Slider.Root>
        <span data-testid="motion-time" class="tabular-nums text-xs text-muted">
          {t("web.artifact.motion.time", { at: time().toFixed(2), duration: duration().toFixed(2) })} · {fps()} fps
        </span>
        <IconButton icon="refresh" label={t("web.artifact.motion.loop")} testid="motion-loop" pressed={loop()} onClick={() => setLoop((v) => !v)} />
        <Button icon="video" data-testid="motion-export" disabled={recording() || saveAct.busy()} onClick={exportVideo}>
          {recording() || saveAct.busy() ? t("web.artifact.motion.exporting") : t("web.artifact.motion.exportVideo")}
        </Button>
      </div>
      <Show when={chapters().length > 0}>
        <div role="group" aria-label={t("web.artifact.motion.chapters")} data-testid="motion-chapters" class="flex flex-wrap items-center gap-1.5">
          <For each={chapters()}>
            {(ch) => (
              <button
                type="button"
                data-testid="motion-chapter"
                onClick={() => seek(ch.at)}
                class="cursor-pointer rounded-full border border-line bg-side hover:bg-hover px-2.5 py-0.5 text-2xs text-muted hover:text-ink"
              >
                {ch.label} ({ch.at.toFixed(1)}s)
              </button>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
