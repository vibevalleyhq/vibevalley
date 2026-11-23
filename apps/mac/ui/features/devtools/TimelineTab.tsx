import { computed, effect, Scroll, signal, Text, View } from "nsh";

import { t } from "@vibevalley/i18n";
import type { DebugTimelineEvent, DebugTimelinePage } from "@vibevalley/protocol";

import { Button } from "../../design/Button";
import { SearchField } from "../../design/Field";
import { Banner, Empty, Toggle } from "../../design/layout";
import { Tag } from "../../design/Tag";
import { api, reasonOf } from "../../infra/api";
import { wallClockText } from "../../infra/base/format";
import { formatJson, isSlowEvent, laneLabel, laneTone, slowBadgeTone, TIMELINE_LANES, type TimelineLaneFilter } from "./format";
import { JsonPreview } from "./shared";

export function TimelineTab(props: { fallbackEvents: readonly DebugTimelineEvent[]; refreshTick: number; onCleared?: () => void }) {
  const lane = signal<TimelineLaneFilter>("all");
  const search = signal("");
  const slowOnly = signal(false);
  const page = signal<DebugTimelinePage | undefined>(undefined);
  const error = signal<string | undefined>(undefined);
  const expandedId = signal<number | undefined>(undefined);
  const clearing = signal(false);

  const load = async (currentLane: TimelineLaneFilter, currentSearch: string) => {
    try {
      const trimmed = currentSearch.trim();
      const res = await api.debug.timeline.list({
        ...(currentLane !== "all" ? { lane: currentLane } : {}),
        ...(trimmed ? { search: trimmed } : {}),
        limit: 200,
      });
      page.set(res);
      error.set(undefined);
    } catch (e) {
      error.set(reasonOf(e));
    }
  };

  effect(() => {
    const currentLane = lane();
    const currentSearch = search();
    void props.refreshTick;
    void load(currentLane, currentSearch);
  });

  const visibleEvents = computed(() => {
    const raw = page()?.events ?? props.fallbackEvents;
    const currentLane = lane();
    const q = search().trim().toLowerCase();
    const onlySlow = slowOnly();
    return raw.filter((ev) => {
      if (currentLane !== "all" && ev.lane !== currentLane) return false;
      if (onlySlow && !isSlowEvent(ev)) return false;
      if (q) {
        const hay = `${ev.kind} ${ev.summary} ${ev.lane}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  });

  const clearTimeline = async () => {
    clearing.set(true);
    try {
      await api.debug.timeline.clear();
      expandedId.set(undefined);
      await load(lane(), search());
      props.onCleared?.();
    } catch (e) {
      error.set(reasonOf(e));
    } finally {
      clearing.set(false);
    }
  };

  const dropped = () => page()?.dropped ?? 0;

  return (
    <View testID="devtools-timeline" class="min-h-0 flex-1">
      <View class="gap-2 border-b border-line bg-side px-3 py-2">
        <View class="flex-row flex-wrap items-center gap-1">
          <Each of={TIMELINE_LANES}>
            {(item) => {
              const active = () => lane() === item();
              return (
                <View
                  role="button"
                  testID={`timeline-lane-${item()}`}
                  accessibilityState={{ selected: active() }}
                  onPress={() => lane.set(item())}
                  class={`h-6 flex-row items-center rounded-sm border px-2 ${active() ? "border-accent bg-accent" : "border-line bg-page hover:bg-hover"}`}
                >
                  <Text class={`text-xs font-medium ${active() ? "text-page" : "text-ink"}`}>{laneLabel(item())}</Text>
                </View>
              );
            }}
          </Each>
        </View>

        <View class="flex-row flex-wrap items-center gap-2">
          <SearchField
            value={search()}
            onInput={(v) => search.set(v)}
            placeholder={t("web.devtools.timeline.searchPlaceholder")}
            label={t("web.devtools.timeline.searchPlaceholder")}
            testid="timeline-search"
            class="min-w-44 flex-1"
          />
          <View class="flex-row items-center gap-1.5">
            <Toggle checked={slowOnly()} onChange={(on) => slowOnly.set(on)} label={t("web.devtools.timeline.slowOnly")} testid="timeline-slow-only" />
          </View>
          <If when={dropped() > 0}>
            <Tag tone="wait" label={t("web.devtools.timeline.dropped", { count: dropped() })} />
          </If>
          <Button size="compact" tone="plain" icon="delete" testID="timeline-clear" disabled={clearing()} onPress={() => void clearTimeline()}>
            {t("web.devtools.actions.clear")}
          </Button>
        </View>
      </View>

      <If when={error()}>
        {(reason) => (
          <Banner tone="bad" edge>
            {t("web.devtools.status.error", { reason: reason() })}
          </Banner>
        )}
      </If>

      <Scroll class="min-h-0 flex-1" contentClass="gap-1.5 p-3">
        <If
          when={visibleEvents().length > 0}
          else={
            <Empty compact icon="clock" testid="timeline-empty">
              {t("web.devtools.timeline.empty")}
            </Empty>
          }
        >
          <Each of={visibleEvents()} key={(ev) => ev.id}>
            {(ev) => {
              const expanded = () => expandedId() === ev().id;
              const slow = () => isSlowEvent(ev());
              return (
                <View class="rounded-md border border-line bg-page">
                  <View
                    role="button"
                    testID={`timeline-row-${ev().id}`}
                    accessibilityState={{ expanded: expanded() }}
                    onPress={() => expandedId.set(expanded() ? undefined : ev().id)}
                    class="flex-row items-center gap-2 px-2.5 py-2 hover:bg-hover"
                  >
                    <Tag tone={laneTone(ev().lane)} label={laneLabel(ev().lane)} />
                    <Text class="shrink-0 font-mono text-2xs tabular-nums text-faint">{wallClockText(ev().time)}</Text>
                    <Text class="shrink-0 font-mono text-xs font-medium text-ink">{ev().kind}</Text>
                    <Text class="min-w-0 flex-1 truncate text-xs text-muted">{ev().summary}</Text>
                    <If when={ev().traceId !== undefined}>
                      <Tag tone="neutral" label={t("web.devtools.timeline.correlationId", { id: ev().traceId ?? 0 })} />
                    </If>
                    <If when={ev().durationUs !== undefined}>
                      <Text class="shrink-0 font-mono text-2xs tabular-nums text-muted">
                        {t("web.devtools.timeline.durationUs", { us: ev().durationUs ?? 0 })}
                      </Text>
                    </If>
                    <If when={slow()}>
                      <Tag tone={slowBadgeTone(ev())} label={t("web.devtools.timeline.slow")} />
                    </If>
                  </View>
                  <If when={expanded()}>
                    <View testID={`timeline-detail-${ev().id}`} class="gap-2 border-t border-line bg-side p-2.5">
                      <View class="flex-row flex-wrap items-center gap-2">
                        <If when={ev().traceId !== undefined}>
                          <Text class="font-mono text-2xs text-muted">{t("web.devtools.timeline.correlationId", { id: ev().traceId ?? 0 })}</Text>
                        </If>
                        <If when={ev().durationUs !== undefined}>
                          <Text class="font-mono text-2xs text-muted">{t("web.devtools.timeline.durationUs", { us: ev().durationUs ?? 0 })}</Text>
                        </If>
                      </View>
                      <If when={ev().detail !== undefined} else={<Text class="text-xs text-muted">{t("web.devtools.status.empty")}</Text>}>
                        <JsonPreview content={formatJson(ev().detail)} copyTestID={`timeline-copy-${ev().id}`} />
                      </If>
                    </View>
                  </If>
                </View>
              );
            }}
          </Each>
        </If>
      </Scroll>
    </View>
  );
}
