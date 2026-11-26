import { computed, effect, Scroll, signal, Text, untracked, View } from "nsh";

import { t } from "@vibevalley/i18n";

import { Button } from "../../../design/Button";
import { Icon } from "../../../design/Icon";
import { IconButton } from "../../../design/IconButton";
import { mix } from "../../../design/tone";
import { type StoryboardModel } from "./previewModel";

export type StoryboardMode = "grid" | "animatic";

function FramingGuide(props: { readonly framing: string; readonly color?: string | undefined }) {
  return (
    <View class="h-full w-full items-center justify-center p-3">
      <If when={props.framing === "extreme-wide" || props.framing === "wide"}>
        <View class="h-full w-full justify-between rounded-sm border border-line px-3 py-2" style={{ borderColor: mix("ink", 0.18) }}>
          <View class="h-1.5 w-10 rounded-full opacity-45" style={{ backgroundColor: props.color ?? mix("ink", 0.35) }} />
          <View class="h-px w-full" style={{ backgroundColor: mix("ink", 0.2) }} />
          <View class="flex-row items-end justify-between">
            <View class="h-5 w-10 rounded-xs opacity-60" style={{ backgroundColor: props.color ?? mix("accent", 0.4) }} />
            <View class="h-3 w-14 rounded-xs opacity-35" style={{ backgroundColor: mix("ink", 0.25) }} />
          </View>
        </View>
      </If>
      <If when={props.framing === "screen-ui"}>
        <View class="h-full w-4/5 overflow-hidden rounded-md border bg-page" style={{ borderColor: mix("ink", 0.22) }}>
          <View class="h-3 flex-row items-center gap-1 border-b border-line bg-side px-2">
            <View class="size-1 rounded-full bg-berry" />
            <View class="size-1 rounded-full bg-wheat" />
            <View class="size-1 rounded-full bg-leaf" />
          </View>
          <View class="flex-1 justify-center gap-1.5 px-3 py-2">
            <View class="h-1.5 w-1/2 rounded-xs bg-accent opacity-70" />
            <View class="h-1.5 w-3/4 rounded-xs bg-faint opacity-45" />
            <View class="h-1.5 w-2/3 rounded-xs bg-faint opacity-35" />
          </View>
        </View>
      </If>
      <If when={props.framing === "close-up" || props.framing === "extreme-close-up"}>
        <View
          class="size-14 items-center justify-center rounded-full border-2"
          style={{ borderColor: props.color ?? mix("accent", 0.65), backgroundColor: mix("accent", 0.16) }}
        >
          <View class="size-5 rounded-full" style={{ backgroundColor: props.color ?? mix("accent", 0.7) }} />
        </View>
      </If>
      <If
        when={
          props.framing !== "extreme-wide" &&
          props.framing !== "wide" &&
          props.framing !== "screen-ui" &&
          props.framing !== "close-up" &&
          props.framing !== "extreme-close-up"
        }
      >
        <View class="h-12 w-24 items-center justify-center rounded-md border" style={{ borderColor: mix("ink", 0.24), backgroundColor: mix("water", 0.14) }}>
          <View class="h-2 w-12 rounded-xs bg-ink opacity-40" />
        </View>
      </If>
    </View>
  );
}

export function StoryboardView(props: { readonly model: StoryboardModel; readonly mode: StoryboardMode }) {
  const activeIdx = signal(0);
  const playing = signal(false);

  const safeIdx = computed(() => {
    if (props.model.shots.length === 0) return 0;
    return Math.max(0, Math.min(activeIdx(), props.model.shots.length - 1));
  });
  const currentShot = computed(() => props.model.shots[safeIdx()]);
  const totalSec = computed(() => props.model.shots.reduce((acc, s) => acc + s.durationSec, 0));

  effect(() => {
    if (!playing() || props.mode !== "animatic" || props.model.shots.length === 0) return;
    const shot = currentShot();
    const waitMs = Math.max(900, Math.round((shot?.durationSec ?? 3) * 1000));
    const timer = setTimeout(() => {
      const next = untracked(safeIdx) + 1;
      if (next >= props.model.shots.length) {
        playing.set(false);
        activeIdx.set(0);
      } else {
        activeIdx.set(next);
      }
    }, waitMs);
    return () => clearTimeout(timer);
  });

  const frameAccent = (idx: number) => props.model.palette[idx % Math.max(1, props.model.palette.length)];

  return (
    <Scroll testID="artifact-storyboard-view" class="min-h-0 flex-1" contentClass="gap-4 p-5">
      <View class="flex-row flex-wrap items-center gap-2.5">
        <Text class="font-mono text-xs text-muted">{`${props.model.aspectRatio} · ${props.model.fps} fps`}</Text>
        <Text class="font-mono text-xs text-muted tabular-nums">{t("web.artifact.storyboard.totalDuration", { sec: totalSec().toFixed(1) })}</Text>
        <If when={props.model.visualTone}>
          <Text class="text-xs text-ink">{props.model.visualTone}</Text>
        </If>
        <View class="flex-row items-center gap-1">
          <Each of={props.model.palette} key={(hex) => hex}>
            {(hex) => <View class="size-3.5 rounded-xs border border-line" style={{ backgroundColor: hex() }} />}
          </Each>
        </View>
      </View>

      <If when={props.mode === "animatic" && currentShot() !== undefined}>
        <View testID="storyboard-animatic" class="mx-auto w-full max-w-3xl gap-3">
          <If when={currentShot()}>
            {(sh) => (
              <View class="overflow-hidden rounded-xl border border-line bg-side shadow-raise">
                <View class="relative h-64 w-full bg-page">
                  <FramingGuide framing={sh().framing} color={frameAccent(safeIdx())} />
                  <View class="absolute top-3 left-3 flex-row items-center gap-1.5 rounded-sm border border-line bg-side px-2 py-0.5">
                    <Text class="font-mono text-2xs font-semibold text-ink">{`${sh().id.toUpperCase()} · ${sh().scene}`}</Text>
                  </View>
                  <View class="absolute top-3 right-3 flex-row items-center gap-1.5 rounded-sm border border-line bg-side px-2 py-0.5">
                    <Text class="font-mono text-2xs text-muted">{`${sh().framing} · ${sh().camera} · ${sh().durationSec}s`}</Text>
                  </View>
                  <If when={sh().dialogue}>
                    <View class="absolute right-6 bottom-3 left-6 items-center rounded-md border border-line bg-side px-3 py-1.5 opacity-95">
                      <Text class="text-center text-xs font-medium text-ink">{sh().dialogue}</Text>
                    </View>
                  </If>
                </View>

                <View class="gap-2 border-t border-line bg-side p-3.5">
                  <If when={sh().visual}>
                    <Text class="text-xs leading-relaxed text-ink">{sh().visual}</Text>
                  </If>
                  <View class="flex-row flex-wrap items-center justify-between gap-2 pt-1">
                    <View class="flex-row items-center gap-1.5">
                      <IconButton
                        icon="previous"
                        size={14}
                        label={t("web.artifact.slides.previous")}
                        disabled={safeIdx() <= 0}
                        onClick={() => {
                          playing.set(false);
                          activeIdx.set(Math.max(0, safeIdx() - 1));
                        }}
                      />
                      <Button
                        size="compact"
                        tone={playing() ? "danger" : "primary"}
                        icon={playing() ? "stop" : "play"}
                        testID="storyboard-play-toggle"
                        onPress={() => playing.set(!playing())}
                      >
                        {playing() ? t("web.artifact.motion.stop") : t("web.artifact.motion.play")}
                      </Button>
                      <IconButton
                        icon="next"
                        size={14}
                        label={t("web.artifact.slides.next")}
                        disabled={safeIdx() >= props.model.shots.length - 1}
                        onClick={() => {
                          playing.set(false);
                          activeIdx.set(Math.min(props.model.shots.length - 1, safeIdx() + 1));
                        }}
                      />
                    </View>
                    <Text class="font-mono text-2xs text-muted tabular-nums">
                      {t("web.artifact.storyboard.shotOf", { n: safeIdx() + 1, total: props.model.shots.length })}
                    </Text>
                  </View>
                </View>
              </View>
            )}
          </If>

          <Scroll horizontal contentClass="flex-row gap-2 pb-1">
            <Each of={props.model.shots} key={(sh) => sh.id}>
              {(sh, idx) => (
                <View
                  role="button"
                  onPress={() => {
                    playing.set(false);
                    activeIdx.set(idx());
                  }}
                  class={`w-36 shrink-0 gap-1 rounded-md border p-2 ${
                    idx() === safeIdx() ? "border-accent bg-selected" : "border-line bg-page hover:bg-hover"
                  }`}
                >
                  <Text class="truncate font-mono text-2xs font-semibold text-ink">{`${sh().id} · ${sh().scene}`}</Text>
                  <Text class="font-mono text-2xs text-faint">{`${sh().durationSec}s · ${sh().framing}`}</Text>
                </View>
              )}
            </Each>
          </Scroll>
        </View>
      </If>

      <If when={props.mode === "grid"}>
        <View class="flex-row flex-wrap gap-3">
          <Each of={props.model.shots} key={(sh) => sh.id}>
            {(sh, idx) => {
              const statusTone = () =>
                sh().status === "approved" || sh().status === "done" || sh().status === "locked" ? "leaf" : sh().status === "ready" ? "water" : "muted";
              return (
                <View class="min-w-68 flex-1 gap-2 rounded-xl border border-line bg-side p-3">
                  <View class="relative h-28 w-full overflow-hidden rounded-md border border-line bg-page">
                    <FramingGuide framing={sh().framing} color={frameAccent(idx())} />
                    <View class="absolute top-1.5 left-1.5 rounded-xs border border-line bg-side px-1.5 py-0.5">
                      <Text class="font-mono text-2xs font-semibold text-ink">{sh().id.toUpperCase()}</Text>
                    </View>
                    <View class="absolute top-1.5 right-1.5 rounded-xs px-1.5 py-0.5" style={{ backgroundColor: mix(statusTone(), 0.16) }}>
                      <Text class="font-mono text-2xs font-medium text-ink">{sh().status}</Text>
                    </View>
                  </View>

                  <View class="flex-row items-center justify-between gap-2">
                    <Text class="truncate text-sm font-semibold text-ink">{sh().scene || "Shot"}</Text>
                    <Text class="shrink-0 font-mono text-2xs text-muted tabular-nums">{`${sh().durationSec}s`}</Text>
                  </View>

                  <View class="flex-row flex-wrap gap-1">
                    <If when={sh().framing}>
                      <Text class="rounded-xs bg-page px-1.5 py-0.5 font-mono text-2xs text-muted">{sh().framing}</Text>
                    </If>
                    <If when={sh().camera}>
                      <Text class="rounded-xs bg-page px-1.5 py-0.5 font-mono text-2xs text-muted">{sh().camera}</Text>
                    </If>
                    <If when={sh().transitionOut}>
                      <Text class="rounded-xs bg-page px-1.5 py-0.5 font-mono text-2xs text-faint">{`${t("web.artifact.storyboard.transition")}: ${sh().transitionOut}`}</Text>
                    </If>
                  </View>

                  <If when={sh().visual}>
                    <Text class="text-xs leading-relaxed text-ink">{sh().visual}</Text>
                  </If>
                  <If when={sh().dialogue}>
                    <View class="rounded-sm border border-line bg-page px-2.5 py-1.5">
                      <Text class="text-xs text-muted">{sh().dialogue}</Text>
                    </View>
                  </If>
                  <If when={sh().sfx}>
                    <View class="flex-row items-center gap-1">
                      <Icon name="audio" size={12} tone="faint" />
                      <Text class="text-2xs text-faint">{`${t("web.artifact.storyboard.sfx")}: ${sh().sfx}`}</Text>
                    </View>
                  </If>
                </View>
              );
            }}
          </Each>
        </View>
      </If>
    </Scroll>
  );
}
