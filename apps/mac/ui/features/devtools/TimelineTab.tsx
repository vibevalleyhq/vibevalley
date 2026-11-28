import { computed, effect, Scroll, signal, Text, untracked, View } from "nsh";

import { t } from "@vibevalley/i18n";
import type { DebugTimelineEvent, DebugTimelinePage } from "@vibevalley/protocol";

import { SearchField } from "../../design/Field";
import { Icon } from "../../design/Icon";
import { IconButton } from "../../design/IconButton";
import { Banner, Empty, Toggle } from "../../design/layout";
import { Tag } from "../../design/Tag";
import { api, reasonOf } from "../../infra/api";
import { wallClockText } from "../../infra/base/format";
import { formatJson, isSlowEvent, laneLabel, laneTone, slowBadgeTone, TIMELINE_LANES, type TimelineJumpFocus, type TimelineLaneFilter } from "./format";
import { JsonPreview } from "./shared";

const TIMELINE_LIMIT = 60;
const TIMELINE_JUMP_LIMIT = 200;

export function TimelineTab(props: {
  fallbackEvents: () => readonly DebugTimelineEvent[];
  refreshTick: () => number;
  onCleared?: () => void;
  focus?: () => TimelineJumpFocus | undefined;
  onJumpToTrajectory?: (target: { traceId?: number | undefined; timestampMs: number; summary: string }) => void;
}) {
  const lane = signal<TimelineLaneFilter>("all");
  const search = signal("");
  const slowOnly = signal(false);
  const page = signal<DebugTimelinePage | undefined>(undefined);
  const error = signal<string | undefined>(undefined);
  const expandedId = signal<number | undefined>(undefined);
  const highlightedId = signal<number | undefined>(undefined);
  const clearing = signal(false);

  let inFlight = false;
  let activeLane: TimelineLaneFilter | undefined;
  let pendingLane: TimelineLaneFilter | undefined;
  let loadSeq = 0;
  let handledFocusKey = -1;

  const findMatchingEvent = (events: readonly DebugTimelineEvent[], focus: TimelineJumpFocus): DebugTimelineEvent | undefined => {
    if (focus.traceId !== undefined) {
      const byTrace = events.find((ev) => ev.traceId === focus.traceId);
      if (byTrace) return byTrace;
    }
    if (focus.timestampMs !== undefined && events.length > 0) {
      let best = events[0];
      let bestDist = Math.abs((best?.time ?? 0) - focus.timestampMs);
      for (const ev of events) {
        const dist = Math.abs(ev.time - focus.timestampMs);
        if (dist < bestDist) {
          best = ev;
          bestDist = dist;
        }
      }
      return best;
    }
    return undefined;
  };

  const load = async (targetLane: TimelineLaneFilter, force = false, limit = TIMELINE_LIMIT, applyFocus?: TimelineJumpFocus) => {
    if (inFlight && !applyFocus) {
      if (force || pendingLane !== undefined || targetLane !== activeLane) {
        pendingLane = targetLane;
      }
      return;
    }
    let nextLane: TimelineLaneFilter | undefined = targetLane;
    inFlight = true;
    try {
      while (nextLane !== undefined) {
        const current = nextLane;
        activeLane = current;
        pendingLane = undefined;
        const seq = ++loadSeq;
        try {
          const res = await api.debug.timeline.list({
            ...(current !== "all" ? { lane: current } : {}),
            limit,
          });
          if (seq === loadSeq) {
            page.set(res);
            error.set(undefined);
            if (applyFocus) {
              const matched = findMatchingEvent(res.events, applyFocus);
              if (matched) {
                expandedId.set(matched.id);
                highlightedId.set(matched.id);
              }
            }
          }
        } catch (e) {
          if (seq === loadSeq) error.set(reasonOf(e));
        }
        nextLane = pendingLane;
      }
    } finally {
      inFlight = false;
      activeLane = undefined;
    }
  };

  effect(() => {
    const currentLane = lane();
    void props.refreshTick();
    untracked(() => {
      void load(currentLane);
    });
  });

  effect(() => {
    const f = props.focus?.();
    if (!f || f.key === handledFocusKey) return;
    handledFocusKey = f.key;
    untracked(() => {
      lane.set("all");
      slowOnly.set(false);
      search.set(f.traceId !== undefined ? "" : (f.search ?? ""));
      const localMatch = findMatchingEvent(page()?.events ?? props.fallbackEvents(), f);
      if (localMatch) {
        expandedId.set(localMatch.id);
        highlightedId.set(localMatch.id);
      }
      void load("all", true, TIMELINE_JUMP_LIMIT, f);
    });
  });

  const visibleEvents = computed(() => {
    const raw = page()?.events ?? props.fallbackEvents();
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
      loadSeq += 1;
      expandedId.set(undefined);
      page.set({ events: [], latestId: 0, dropped: 0 });
      await load(lane(), true);
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
          <Each of={TIMELINE_LANES} key={(item) => item}>
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
          <IconButton
            icon="delete"
            size={14}
            label={t("web.devtools.actions.clear")}
            testid="timeline-clear"
            disabled={clearing()}
            onClick={() => void clearTimeline()}
          />
        </View>
      </View>

      <If when={error() !== undefined}>
        <Banner tone="bad" edge>
          {t("web.devtools.status.error", { reason: error() ?? "" })}
        </Banner>
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
              const highlighted = () => highlightedId() === ev().id;
              const slow = () => isSlowEvent(ev());
              return (
                <View class={`rounded-md border bg-page ${highlighted() ? "border-focus" : "border-line"}`}>
                  <View
                    role="button"
                    testID={`timeline-row-${ev().id}`}
                    accessibilityState={{ expanded: expanded() }}
                    onPress={() => {
                      highlightedId.set(undefined);
                      expandedId.set(expanded() ? undefined : ev().id);
                    }}
                    class={`flex-row items-center gap-2 px-2.5 py-2 ${highlighted() ? "bg-selected" : "hover:bg-hover"}`}
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
                      <View class="flex-row flex-wrap items-center justify-between gap-2">
                        <View class="flex-row flex-wrap items-center gap-2">
                          <If when={ev().traceId !== undefined}>
                            <Text class="font-mono text-2xs text-muted">{t("web.devtools.timeline.correlationId", { id: ev().traceId ?? 0 })}</Text>
                          </If>
                          <If when={ev().durationUs !== undefined}>
                            <Text class="font-mono text-2xs text-muted">{t("web.devtools.timeline.durationUs", { us: ev().durationUs ?? 0 })}</Text>
                          </If>
                        </View>
                        <If when={props.onJumpToTrajectory !== undefined}>
                          <View
                            role="button"
                            testID={`timeline-jump-trajectory-${ev().id}`}
                            onPress={() =>
                              props.onJumpToTrajectory?.({
                                ...(ev().traceId !== undefined ? { traceId: ev().traceId } : {}),
                                timestampMs: ev().time,
                                summary: ev().summary,
                              })
                            }
                            class="flex-row items-center gap-1 rounded-sm border border-line bg-page px-2 py-0.5 hover:bg-hover"
                          >
                            <Icon name="log" size={11} tone="accent" />
                            <Text class="text-2xs font-medium text-ink">{t("web.devtools.actions.jumpToTrajectory")}</Text>
                          </View>
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
