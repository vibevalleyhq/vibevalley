import { computed, Scroll, signal, Text, untracked, View } from "nsh";

import { t } from "@vibevalley/i18n";

import { Button } from "../../../design/Button";
import { IconButton } from "../../../design/IconButton";
import { Toggle } from "../../../design/layout";
import { tone } from "../../../design/tone";
import { useInterval } from "../../../infra/base/timer";
import { asString, evaluateMotionLayer } from "./previewModel";

export interface MotionSceneItem {
  readonly id: string;
  readonly file: string;
  readonly start: number;
  readonly end: number;
  readonly title: string;
  readonly layers: readonly Record<string, unknown>[];
}

export function MotionView(props: {
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly duration: number;
  readonly background: string;
  readonly chapters: readonly Record<string, unknown>[];
  readonly scenes: readonly MotionSceneItem[];
}) {
  const playhead = signal(0);
  const playing = signal(false);
  const loop = signal(true);
  const totalDur = () => Math.max(0.1, props.duration);

  const clampedHead = computed(() => Math.max(0, Math.min(totalDur(), playhead())));

  const activeScene = computed((): MotionSceneItem | undefined => {
    const tSec = clampedHead();
    return props.scenes.find((sc) => tSec >= sc.start && tSec < sc.end) ?? props.scenes.at(-1) ?? props.scenes.at(0);
  });

  const sceneProgress = computed(() => {
    const sc = activeScene();
    if (!sc) return 1;
    const len = Math.max(0.1, sc.end - sc.start);
    return Math.max(0, Math.min(1, (clampedHead() - sc.start) / len));
  });

  useInterval(() => {
    if (!untracked(playing)) return;
    const stepSec = 0.05;
    const next = untracked(playhead) + stepSec;
    const max = totalDur();
    if (next >= max) {
      if (untracked(loop)) {
        playhead.set(0);
      } else {
        playhead.set(max);
        playing.set(false);
      }
    } else {
      playhead.set(Number(next.toFixed(2)));
    }
  }, 50);

  const seekTo = (sec: number) => {
    playhead.set(Math.max(0, Math.min(totalDur(), Number(sec.toFixed(2)))));
  };

  return (
    <Scroll testID="artifact-motion-view" class="min-h-0 flex-1" contentClass="gap-4 p-5">
      <View
        testID="motion-stage"
        class="mx-auto h-72 w-full max-w-3xl items-center justify-center overflow-hidden rounded-xl border border-line p-6 shadow-raise"
        style={{ backgroundColor: props.background }}
      >
        <If when={activeScene()}>
          {(sc) => (
            <View class="w-full max-w-xl items-center gap-3">
              <Each of={sc().layers} key={(l, idx) => asString(l.id, String(idx))}>
                {(layer, idx) => {
                  const staggered = () => Math.max(0, Math.min(1, sceneProgress() - idx() * 0.08));
                  const anim = () => evaluateMotionLayer(layer(), staggered());
                  const kind = () => asString(layer().kind, "text");
                  const text = () => asString(layer().text, asString(layer().label, sc().title));
                  const sub = () => asString(layer().subtitle, asString(layer().body));
                  const fill = (): string | undefined => {
                    const v = layer().fill;
                    return typeof v === "string" && v !== "" ? v : undefined;
                  };
                  const textColor = (): string => {
                    const v = layer().color;
                    return typeof v === "string" && v !== "" ? v : tone("ink");
                  };
                  return (
                    <View
                      class={
                        kind() === "badge"
                          ? "rounded-full border border-line bg-selected px-3 py-1"
                          : kind() === "card"
                            ? "w-full rounded-lg border border-line bg-side p-3.5"
                            : kind() === "bar"
                              ? "h-2.5 w-48 overflow-hidden rounded-full bg-side"
                              : "items-center"
                      }
                      style={{
                        opacity: anim().opacity,
                        backgroundColor: fill(),
                        transform: [{ translateY: anim().offsetY }, { scale: anim().scale }],
                      }}
                    >
                      <If when={kind() === "bar"}>
                        <View class="h-full rounded-full bg-accent" style={{ width: `${Math.round(sceneProgress() * 100)}%` }} />
                      </If>
                      <If when={kind() !== "bar"}>
                        <Text
                          class={
                            kind() === "badge"
                              ? "font-mono text-xs font-semibold text-ink"
                              : kind() === "card"
                                ? "text-sm font-semibold text-ink"
                                : "text-center text-2xl font-bold"
                          }
                          style={kind() === "text" ? { color: textColor() } : undefined}
                        >
                          {text()}
                        </Text>
                        <If when={sub().length > 0}>
                          <Text class="mt-0.5 text-xs text-muted">{sub()}</Text>
                        </If>
                      </If>
                    </View>
                  );
                }}
              </Each>
            </View>
          )}
        </If>
      </View>

      <View class="mx-auto w-full max-w-3xl gap-2 rounded-xl border border-line bg-side p-3">
        <View class="h-1.5 w-full overflow-hidden rounded-full bg-page">
          <View class="h-full rounded-full bg-accent" style={{ width: `${Math.round((clampedHead() / totalDur()) * 100)}%` }} />
        </View>
        <View class="flex-row flex-wrap items-center justify-between gap-2">
          <View class="flex-row items-center gap-1.5">
            <IconButton
              icon="refresh"
              size={14}
              label={t("web.artifact.motion.restart")}
              testid="motion-restart"
              onClick={() => {
                playing.set(false);
                seekTo(0);
              }}
            />
            <IconButton icon="previous" size={14} label={t("web.artifact.motion.prevStep")} onClick={() => seekTo(clampedHead() - 0.5)} />
            <Button
              size="compact"
              tone={playing() ? "danger" : "primary"}
              icon={playing() ? "stop" : "play"}
              testID="motion-play-toggle"
              onPress={() => {
                if (!playing() && clampedHead() >= totalDur()) seekTo(0);
                playing.set(!playing());
              }}
            >
              {playing() ? t("web.artifact.motion.stop") : t("web.artifact.motion.play")}
            </Button>
            <IconButton icon="next" size={14} label={t("web.artifact.motion.nextStep")} onClick={() => seekTo(clampedHead() + 0.5)} />
          </View>

          <View class="flex-row items-center gap-3">
            <Toggle testid="motion-loop-toggle" label={t("web.artifact.motion.loop")} checked={loop()} onChange={(v) => loop.set(v)} />
            <Text testID="motion-timecode" class="font-mono text-xs text-muted tabular-nums">
              {`${clampedHead().toFixed(1)}s / ${totalDur().toFixed(1)}s · ${props.width}×${props.height} · ${props.fps} fps`}
            </Text>
          </View>
        </View>
      </View>

      <If when={props.chapters.length > 0}>
        <View class="mx-auto w-full max-w-3xl flex-row flex-wrap items-center gap-1.5">
          <Text class="text-2xs font-semibold text-muted">{t("web.artifact.motion.chapters")}</Text>
          <Each of={props.chapters} key={(ch, idx) => `${asString(ch.label, "ch")}-${idx}`}>
            {(ch) => {
              const atSec = () => {
                const v = ch().at;
                return typeof v === "number" ? v : 0;
              };
              return (
                <Button size="compact" tone="plain" onPress={() => seekTo(atSec())}>
                  {`${asString(ch().label, "Chapter")} · ${atSec().toFixed(1)}s`}
                </Button>
              );
            }}
          </Each>
        </View>
      </If>

      <If when={props.scenes.length > 0}>
        <View class="mx-auto w-full max-w-3xl gap-2">
          <Text class="text-xs font-semibold text-muted">{t("web.artifact.motion.timeline")}</Text>
          <View class="h-10 flex-row items-center gap-1 rounded-lg border border-line bg-side p-1.5">
            <Each of={props.scenes} key={(sc) => sc.id}>
              {(sc) => {
                const span = () => Math.max(0.4, sc().end - sc().start);
                const selected = () => activeScene()?.id === sc().id;
                return (
                  <View
                    role="button"
                    onPress={() => seekTo(sc().start)}
                    class={`h-full justify-center rounded-sm border px-2 ${selected() ? "border-accent bg-selected" : "border-line bg-page hover:bg-hover"}`}
                    style={{ flexGrow: Math.round((span() / totalDur()) * 100) }}
                  >
                    <Text class="truncate text-2xs font-medium text-ink">{sc().title}</Text>
                  </View>
                );
              }}
            </Each>
          </View>
        </View>
      </If>

      <View class="mx-auto w-full max-w-3xl gap-2">
        <Each of={props.scenes} key={(sc) => sc.id}>
          {(sc) => {
            const active = () => activeScene()?.id === sc().id;
            return (
              <View
                role="button"
                onPress={() => seekTo(sc().start)}
                class={`gap-1.5 rounded-lg border p-3 ${active() ? "border-accent bg-selected" : "border-line bg-page hover:bg-hover"}`}
              >
                <View class="flex-row items-center justify-between">
                  <Text class="text-sm font-semibold text-ink">{sc().title}</Text>
                  <Text class="font-mono text-2xs text-muted tabular-nums">{`${sc().start}s – ${sc().end}s`}</Text>
                </View>
                <Text class="font-mono text-2xs text-faint">{`${sc().file} · ${t("web.artifact.motion.layers", { n: sc().layers.length })}`}</Text>
              </View>
            );
          }}
        </Each>
      </View>
    </Scroll>
  );
}
