import { Text, View } from "nsh";

import { shellMessageOf } from "@vibevalley/artifact/shell";
import { t } from "@vibevalley/i18n";

import { createEffect, createSignal } from "../../../solid";
import { createAct } from "../../ui/act";
import { Button } from "../../ui/Button";
import { IconButton } from "../../ui/IconButton";
import { Slider } from "../../ui/Slider";
import { toast } from "../../ui/toasts";
import type { Controls } from "./HtmlFrame";
import { saveVideoToLibrary, useReportViewContext } from "./store";

export function MotionControls(props: Controls) {
  const duration = () => Math.max(0.1, props.frame.shown().ready?.duration ?? 6);
  const fps = () => props.frame.shown().ready?.fps ?? 30;
  const chapters = () => props.frame.shown().ready?.chapters ?? [];
  const time = () => props.frame.shown().at?.time ?? 0;
  const playing = () => props.frame.shown().at?.playing === true;
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
        props.frame.send({ vibevalley: "seek", time: 0 });
        props.frame.send({ vibevalley: "play" });
      }
    },
  );

  createEffect(
    () => props.frame,
    (f) =>
      f.onMessage((raw) => {
        const msg = shellMessageOf(raw);
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
      }),
  );

  const togglePlay = () => props.frame.send({ vibevalley: playing() ? "pause" : "play" });
  const stepFrame = (delta: -1 | 1) => props.frame.send({ vibevalley: "step", delta });
  const seek = (nextTime: number) => props.frame.send({ vibevalley: "seek", time: nextTime });

  const exportVideo = () => {
    if (recording() || saveAct.busy()) return;
    if (duration() > 60) {
      toast(t("web.artifact.motion.tooLong"), "bad");
      return;
    }
    setRecording(true);
    props.frame.send({ vibevalley: "record", fps: fps() });
  };

  const timeLabel = () => t("web.artifact.motion.time", { at: time().toFixed(2), duration: duration().toFixed(2) });

  return (
    <View testID="motion-controls" class="shrink-0 gap-2 border-t border-line bg-page px-3 py-2">
      <View class="flex-row flex-wrap items-center gap-1.5">
        <IconButton
          icon={playing() ? "stop" : "play"}
          label={playing() ? t("web.artifact.motion.pause") : t("web.artifact.motion.play")}
          testid="motion-play-pause"
          onClick={togglePlay}
        />
        <IconButton icon="previous" label={t("web.artifact.motion.prevFrame")} testid="motion-prev-frame" onClick={() => stepFrame(-1)} />
        <IconButton icon="next" label={t("web.artifact.motion.nextFrame")} testid="motion-next-frame" onClick={() => stepFrame(1)} />
        <Slider min={0} max={duration()} step={0.01} value={time()} onChange={seek} label={timeLabel()} testid="motion-scrub" class="min-w-28 flex-1" />
        <Text testID="motion-time" class="text-xs text-muted tabular-nums">
          {`${timeLabel()} · ${fps()} fps`}
        </Text>
        <IconButton icon="refresh" label={t("web.artifact.motion.loop")} testid="motion-loop" pressed={loop()} onClick={() => setLoop((v) => !v)} />
        <Button icon="video" testID="motion-export" disabled={recording() || saveAct.busy()} onPress={exportVideo}>
          {recording() || saveAct.busy() ? t("web.artifact.motion.exporting") : t("web.artifact.motion.exportVideo")}
        </Button>
      </View>

      <If when={chapters().length > 0}>
        <View accessibilityLabel={t("web.artifact.motion.chapters")} testID="motion-chapters" class="flex-row flex-wrap items-center gap-1.5">
          <Each of={chapters()}>
            {(ch) => (
              <View
                role="button"
                testID="motion-chapter"
                onPress={() => seek(ch().at)}
                class="rounded-full border border-line bg-side px-2.5 py-0.5 hover:bg-hover"
              >
                <Text class="text-2xs text-muted">{`${ch().label} (${ch().at.toFixed(1)}s)`}</Text>
              </View>
            )}
          </Each>
        </View>
      </If>
    </View>
  );
}
