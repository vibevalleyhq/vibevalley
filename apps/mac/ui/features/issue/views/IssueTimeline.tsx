import { cleanup, computed, PanResponder, Scroll, signal, Text, untracked, View, type ScrollRef } from "nsh";

import { t } from "@vibevalley/i18n";
import type { Issue } from "@vibevalley/protocol";

import { Button } from "../../../design/Button";
import { Icon } from "../../../design/Icon";
import { IconButton } from "../../../design/IconButton";
import { motionClass } from "../../../design/motion";
import { Segmented } from "../../../design/Segmented";
import { CountPill } from "../../../design/Tag";
import { Bubble } from "../../../design/Tip";
import { mix, tone } from "../../../design/tone";
import { useNow } from "../../../infra/base/dom";
import type { BoardCard, Tone } from "../model/cards";
import { formatIsoDate } from "../model/meta";
import {
  addUtcDays,
  buildScheduleForCards,
  computeTimelineDrag,
  type ScheduledCardRow,
  type TimelineDragMode,
  type TimelineScale,
  timelineScales,
  timelineScaleSpec,
  utcDayDiff,
  utcDayStart,
} from "../model/schedule";
import { EmptyNote } from "./Board";
import { PriorityMark, StatusMark } from "./Marks";
import type { NewIssueAt } from "./NewIssue";

const ROW_HEIGHT = 38;
const HEADER_HEIGHT = 42;
const LEFT_COL_WIDTH = 272;
const MONTH_LABEL_RESERVE = 104;
const DRAG_ACTIVATION_PX = 4;

const weekdayKeys = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

const scaleOptions = (): { value: TimelineScale; label: string }[] =>
  timelineScales.map((s) => ({
    value: s,
    label: t(`web.issue.timeline.scale.${s}`),
  }));

function barToneOf(row: ScheduledCardRow): Tone {
  if (row.issue.status === "done") return "leaf";
  if (row.issue.status === "canceled") return "faint";
  if (row.span.overdue) return "berry";
  if (row.issue.status === "in_review") return "wheat";
  if (row.issue.status === "in_progress") return "water";
  if (row.issue.priority === "urgent") return "berry";
  if (row.issue.priority === "high") return "wheat";
  return "water";
}

function barFillColor(tName: Tone): string {
  switch (tName) {
    case "leaf":
      return mix("leaf", 0.22);
    case "wheat":
      return mix("wheat", 0.22);
    case "berry":
      return mix("berry", 0.2);
    case "water":
      return mix("water", 0.2);
    case "muted":
    case "faint":
      return mix("idle", 0.18);
  }
}

function barBorderColor(tName: Tone, selected: boolean): string {
  if (selected) return tone("accent");
  switch (tName) {
    case "leaf":
      return mix("leaf", 0.65);
    case "wheat":
      return mix("wheat", 0.65);
    case "berry":
      return mix("berry", 0.65);
    case "water":
      return mix("water", 0.6);
    case "muted":
    case "faint":
      return tone("line-strong");
  }
}

function formatDateSpan(startMs: number, endMs: number): string {
  const start = formatIsoDate(startMs);
  const end = formatIsoDate(endMs);
  return start === end ? start : `${start} -> ${end}`;
}

function barTooltipText(row: ScheduledCardRow): string {
  const parts = [`#${row.issue.number} ${row.issue.title}`, `${t(`shared.status.${row.issue.status}`)} · ${formatDateSpan(row.span.startMs, row.span.endMs)}`];
  if (row.span.overdue) parts.push(t("web.issue.timeline.overdue"));
  if (row.span.rolledUp) parts.push(t("web.issue.timeline.rolledUp"));
  return parts.join("\n");
}

/** Tracks pending `requestAnimationFrame` callbacks under the active reactive owner and cancels them on cleanup. */
export function createFrameQueue() {
  let disposed = false;
  const pending = new Set<number>();
  const schedule = (fn: () => void) => {
    if (disposed) return;
    const id = requestAnimationFrame(() => {
      pending.delete(id);
      if (!disposed) fn();
    });
    pending.add(id);
  };
  const cancelAll = () => {
    disposed = true;
    for (const id of pending) cancelAnimationFrame(id);
    pending.clear();
  };
  cleanup(cancelAll);
  return { schedule, cancelAll };
}

interface ActiveDragState {
  readonly issueId: string;
  readonly mode: TimelineDragMode;
  readonly deltaDays: number;
}

/** Interactive Gantt / Timeline view with zoom scales, parent-child rollup, today marker, sticky month labels, and direct drag/resize bars. */
export function IssueTimeline(props: {
  cards: BoardCard[];
  allIssues: readonly Issue[];
  filtered?: boolean | undefined;
  loading: boolean;
  selected?: string | undefined;
  onOpen: (id: string) => void;
  onUpdateDates: (id: string, dates: { startAt?: number; dueAt?: number }) => Promise<void> | void;
  onNew: (at: NewIssueAt) => void;
  onClearFilter?: (() => void) | undefined;
}) {
  const scale = signal<TimelineScale>("month");
  const showUnscheduled = signal(false);
  const gridViewportWidth = signal(0);
  const scrollX = signal(0);
  const activeDrag = signal<ActiveDragState | undefined>(undefined);
  const now = useNow(60_000);
  let timelineScroll: ScrollRef | undefined;
  let disposed = false;
  const frames = createFrameQueue();

  const timeline = computed(() => buildScheduleForCards(props.cards, props.allIssues, scale(), now()));
  const dayWidth = computed(() => timelineScaleSpec[scale()].dayWidth);
  const totalGridWidth = computed(() => timeline().totalDays * dayWidth());
  const todayIndex = computed(() => utcDayDiff(timeline().rangeStartMs, timeline().todayDayMs));
  const todayX = computed(() => todayIndex() * dayWidth());

  const scrollToToday = (animated = true) => {
    if (disposed || !timelineScroll) return;
    const w = gridViewportWidth();
    const vw = w > 0 ? w : 720;
    const maxScroll = Math.max(0, totalGridWidth() - vw);
    const x = Math.min(maxScroll, Math.max(0, todayX() - Math.round(vw * 0.32)));
    scrollX.set(x);
    timelineScroll.scrollTo({ x, animated });
  };

  const scheduleScrollToToday = (animated = false) => {
    frames.schedule(() => scrollToToday(animated));
  };

  cleanup(() => {
    disposed = true;
    timelineScroll = undefined;
  });

  const scheduleToday = (issue: Issue) => {
    const startAt = utcDayStart(now());
    const dueAt = addUtcDays(startAt, 2);
    void props.onUpdateDates(issue.id, { startAt, dueAt });
  };

  const unscheduledVisible = computed(() => showUnscheduled() || (timeline().rows.length === 0 && timeline().unscheduled.length > 0));

  return (
    <If when={!props.loading} else={<EmptyNote>{t("web.issue.reading")}</EmptyNote>}>
      <View testID="issue-timeline" class="min-h-0 flex-1 bg-page">
        <View testID="timeline-header" class="h-10 shrink-0 flex-row items-center justify-between gap-2 border-b border-line bg-side px-4">
          <View class="flex-row items-center gap-2">
            <Segmented
              label={t("web.issue.timeline.scale.label")}
              testid="timeline-scale"
              value={scale()}
              onChange={(next) => {
                scale.set(next);
                scheduleScrollToToday(false);
              }}
              options={scaleOptions()}
            />
            <Button size="compact" tone="plain" icon="calendar" testID="timeline-today" onPress={() => scrollToToday(true)}>
              {t("web.issue.timeline.today")}
            </Button>
          </View>
          <View class="flex-row items-center gap-2">
            <Text testID="timeline-scheduled-count" class="text-xs text-faint tabular-nums">
              {t("web.issue.timeline.scheduledCount", { n: timeline().rows.length })}
            </Text>
            <If when={timeline().unscheduled.length > 0}>
              <View
                role="button"
                testID="timeline-unscheduled-toggle"
                accessibilityState={{ selected: unscheduledVisible() }}
                onPress={() => showUnscheduled.set(!showUnscheduled())}
                class={`h-6 flex-row items-center gap-1.5 rounded-md border px-2 ${motionClass("transition-transform duration-120 ease-out")} active:translate-y-px ${
                  unscheduledVisible() ? "border-accent bg-selected" : "border-line bg-page hover:bg-hover"
                }`}
              >
                <Icon name="clock" size={12} tone={unscheduledVisible() ? "ink" : "muted"} />
                <Text class={`text-xs font-medium tabular-nums ${unscheduledVisible() ? "text-ink" : "text-muted"}`}>
                  {t("web.issue.timeline.unscheduled", { n: timeline().unscheduled.length })}
                </Text>
              </View>
            </If>
          </View>
        </View>

        <If
          when={props.cards.length > 0}
          else={
            <View testID="timeline-empty" class="items-start gap-2 px-5 py-6">
              <Text class="text-xs text-muted">{props.filtered === true ? t("web.issue.list.emptyFiltered") : t("web.issue.list.empty")}</Text>
              <If when={props.filtered === true ? props.onClearFilter : undefined}>
                {(clear) => (
                  <Button size="compact" tone="plain" icon="close" testID="timeline-clear-filter" onPress={() => clear()()}>
                    {t("web.issue.page.clear")}
                  </Button>
                )}
              </If>
            </View>
          }
        >
          <View class="min-h-0 flex-1">
            <If
              when={timeline().rows.length > 0}
              else={
                <View testID="timeline-no-scheduled" class="items-start gap-1.5 border-b border-line bg-page px-5 py-5">
                  <Text class="text-sm font-medium text-ink">{t("web.issue.timeline.emptyScheduled")}</Text>
                  <Text class="text-xs text-muted">{t("web.issue.timeline.emptyScheduledHint")}</Text>
                </View>
              }
            >
              <Scroll class="min-h-0 flex-1">
                <View class="min-w-0 flex-row items-start">
                  {/* Fixed left issue column synchronized vertically via outer Scroll */}
                  <View class="shrink-0 border-r border-line bg-page" style={{ width: LEFT_COL_WIDTH }}>
                    <View class="flex-row items-center justify-between border-b border-line bg-side px-3" style={{ height: HEADER_HEIGHT }}>
                      <Text class="text-xs font-semibold text-muted">{t("web.issue.timeline.issuesColumn")}</Text>
                      <CountPill count={timeline().rows.length} />
                    </View>
                    <Each of={timeline().rows} key={(r) => r.card.id}>
                      {(r) => {
                        const selected = () => props.selected === r().card.id;
                        return (
                          <View
                            role="button"
                            testID="timeline-row"
                            accessibilityLabel={`#${r().issue.number} ${r().issue.title}`}
                            accessibilityState={{ selected: selected() }}
                            onPress={() => props.onOpen(r().card.id)}
                            class={`flex-row items-center gap-1.5 border-b pr-2.5 ${selected() ? "bg-selected" : "hover:bg-hover"}`}
                            style={{
                              height: ROW_HEIGHT,
                              paddingLeft: 10 + r().depth * 14,
                              borderColor: mix("line", 0.55),
                            }}
                          >
                            <If when={r().depth > 0}>
                              <Icon name="indent" size={11} tone="faint" />
                            </If>
                            <StatusMark status={r().issue.status} size={13} />
                            <Text class="shrink-0 font-mono text-2xs text-faint tabular-nums">{`#${r().issue.number}`}</Text>
                            <Text class="min-w-0 flex-1 truncate text-xs font-medium text-ink">{r().issue.title}</Text>
                            <If when={r().span.overdue}>
                              <View class="size-1.5 shrink-0 rounded-full bg-berry" />
                            </If>
                            <If when={r().issue.priority === "urgent" || r().issue.priority === "high" ? r().issue.priority : undefined}>
                              {(pr) => <PriorityMark priority={pr()} size={11} />}
                            </If>
                          </View>
                        );
                      }}
                    </Each>
                  </View>

                  {/* Horizontally scrollable time header + Gantt bars */}
                  <Scroll
                    horizontal
                    testID="timeline-grid-scroll"
                    class="min-w-0 flex-1"
                    onScroll={(e) => scrollX.set(Math.max(0, e.offset.x))}
                    onLayout={(e) => {
                      const w = e.bounds.size.width;
                      if (w > 0 && gridViewportWidth() === 0) {
                        gridViewportWidth.set(w);
                        scheduleScrollToToday(false);
                      } else {
                        gridViewportWidth.set(w);
                      }
                    }}
                    ref={(r) => {
                      timelineScroll = r;
                    }}
                  >
                    <View class="relative" style={{ width: totalGridWidth() }}>
                      {/* Time axis header */}
                      <View class="border-b border-line bg-side" style={{ height: HEADER_HEIGHT, width: totalGridWidth() }}>
                        {/* Top month band with sticky-clamped labels */}
                        <View class="relative h-5 flex-row items-center border-b" style={{ borderColor: mix("line", 0.5) }}>
                          <Each of={timeline().months} key={(m) => m.key}>
                            {(m) => {
                              const bandLeft = () => m().startIndex * dayWidth();
                              const bandWidth = () => m().spanDays * dayWidth();
                              const stickyOffset = () => {
                                const w = bandWidth();
                                const reserve = Math.min(w, MONTH_LABEL_RESERVE);
                                return Math.max(0, Math.min(scrollX() - bandLeft(), w - reserve));
                              };
                              return (
                                <View
                                  class="absolute top-0 bottom-0 flex-row items-center overflow-hidden border-r"
                                  style={{
                                    left: bandLeft(),
                                    width: bandWidth(),
                                    borderColor: mix("line", 0.65),
                                  }}
                                >
                                  <View class="h-full flex-row items-center px-2" style={{ marginLeft: stickyOffset() }}>
                                    <Text testID="timeline-month-label" class="truncate text-2xs font-semibold text-muted tabular-nums">
                                      {t("web.issue.calendar.monthTitle", { year: m().year, month: m().month })}
                                    </Text>
                                  </View>
                                </View>
                              );
                            }}
                          </Each>
                        </View>
                        {/* Bottom day / week ticks */}
                        <View class="relative flex-1 flex-row items-center">
                          <Each of={timeline().ticks} key={(tk) => tk.dateKey}>
                            {(tk, idx) => {
                              const showTickLabel = () =>
                                scale() === "week"
                                  ? true
                                  : scale() === "month"
                                    ? tk().isToday || tk().isMonday || tk().isFirstOfMonth || idx() % 2 === 0
                                    : tk().isToday || tk().isMonday || tk().isFirstOfMonth;
                              const labelText = () =>
                                scale() === "week"
                                  ? `${t(`web.issue.timeline.weekday.${weekdayKeys[tk().weekdayIndex] ?? "mon"}`)} ${tk().dayOfMonth}`
                                  : String(tk().dayOfMonth);
                              return (
                                <View
                                  class="absolute top-0 bottom-0 items-center justify-center border-r"
                                  style={{
                                    left: idx() * dayWidth(),
                                    width: dayWidth(),
                                    borderColor: mix("line", 0.45),
                                    backgroundColor: tk().isToday ? mix("water", 0.14) : tk().isWeekend ? mix("line", 0.18) : undefined,
                                  }}
                                >
                                  <If when={showTickLabel()}>
                                    <Text
                                      class={`text-2xs tabular-nums ${
                                        tk().isToday ? "font-semibold text-water" : tk().isWeekend ? "text-faint" : "text-muted"
                                      }`}
                                    >
                                      {labelText()}
                                    </Text>
                                  </If>
                                </View>
                              );
                            }}
                          </Each>
                        </View>
                      </View>

                      {/* Grid body + vertical Today marker + schedule bars */}
                      <View class="relative" style={{ height: timeline().rows.length * ROW_HEIGHT, width: totalGridWidth() }}>
                        {/* Day/week vertical lines */}
                        <Each of={timeline().ticks} key={(tk) => tk.dateKey}>
                          {(tk, idx) => (
                            <If when={scale() !== "quarter" || tk().isMonday || tk().isFirstOfMonth || tk().isToday}>
                              <View
                                class="pointer-events-none absolute top-0 bottom-0 border-r"
                                style={{
                                  left: idx() * dayWidth(),
                                  width: dayWidth(),
                                  borderColor: mix("line", tk().isMonday ? 0.55 : 0.28),
                                  backgroundColor: tk().isWeekend && scale() !== "quarter" ? mix("line", 0.14) : undefined,
                                }}
                              />
                            </If>
                          )}
                        </Each>

                        {/* Today vertical marker line */}
                        <View
                          testID="timeline-today-line"
                          class="pointer-events-none absolute top-0 bottom-0 z-10 w-0.5 bg-water"
                          style={{ left: todayX() + Math.floor(dayWidth() / 2) }}
                        />

                        {/* Schedule rows */}
                        <Each of={timeline().rows} key={(r) => r.card.id}>
                          {(r, rowIdx) => {
                            let suppressNextPress = false;
                            let dragOrigin: ScheduledCardRow | undefined;
                            const beginDrag = (mode: TimelineDragMode) => {
                              suppressNextPress = true;
                              dragOrigin = untracked(r);
                              activeDrag.set({ issueId: dragOrigin.issue.id, mode, deltaDays: 0 });
                            };
                            const updateDrag = (mode: TimelineDragMode, dx: number) => {
                              if (!dragOrigin) return;
                              const deltaDays = Math.round(dx / untracked(dayWidth));
                              const current = untracked(activeDrag);
                              if (current?.issueId === dragOrigin.issue.id && current.mode === mode && current.deltaDays === deltaDays) return;
                              activeDrag.set({ issueId: dragOrigin.issue.id, mode, deltaDays });
                            };
                            const endDrag = (mode: TimelineDragMode, dx: number, commit: boolean) => {
                              const origin = dragOrigin;
                              dragOrigin = undefined;
                              frames.schedule(() => {
                                suppressNextPress = false;
                              });
                              activeDrag.set(undefined);
                              if (!commit || !origin) return;
                              const deltaDays = Math.round(dx / untracked(dayWidth));
                              const next = computeTimelineDrag(origin.issue, origin.span, mode, deltaDays);
                              if (next.startMs !== origin.span.startMs || next.endMs !== origin.span.endMs) {
                                void props.onUpdateDates(origin.issue.id, next.dates);
                              }
                            };

                            const bodyPan = PanResponder.create({
                              onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dx) >= DRAG_ACTIVATION_PX,
                              onPanResponderTerminationRequest: () => false,
                              onPanResponderGrant: () => beginDrag("move"),
                              onPanResponderMove: (_e, g) => updateDrag("move", g.dx),
                              onPanResponderRelease: (_e, g) => endDrag("move", g.dx, true),
                              onPanResponderTerminate: (_e, g) => endDrag("move", g.dx, false),
                            });

                            const makeResizePan = (mode: "resize-start" | "resize-end") =>
                              PanResponder.create({
                                onStartShouldSetPanResponder: () => true,
                                onMoveShouldSetPanResponder: () => true,
                                onPanResponderTerminationRequest: () => false,
                                onPanResponderGrant: () => beginDrag(mode),
                                onPanResponderMove: (_e, g) => updateDrag(mode, g.dx),
                                onPanResponderRelease: (_e, g) => endDrag(mode, g.dx, true),
                                onPanResponderTerminate: (_e, g) => endDrag(mode, g.dx, false),
                              });

                            const startResizePan = makeResizePan("resize-start");
                            const endResizePan = makeResizePan("resize-end");

                            const draggingThis = () => {
                              const d = activeDrag();
                              return d !== undefined && d.issueId === r().issue.id ? d : undefined;
                            };
                            const preview = computed(() => {
                              const d = draggingThis();
                              return d ? computeTimelineDrag(r().issue, r().span, d.mode, d.deltaDays) : undefined;
                            });
                            const shownStartMs = () => preview()?.startMs ?? r().span.startMs;
                            const shownDurationDays = () => preview()?.durationDays ?? r().span.durationDays;
                            const barStartIdx = () => utcDayDiff(timeline().rangeStartMs, shownStartMs());
                            const barLeft = () => barStartIdx() * dayWidth() + 2;
                            const barWidth = () => Math.max(Math.max(18, dayWidth() - 4), shownDurationDays() * dayWidth() - 4);
                            const barTone = () => barToneOf(r());
                            const selected = () => props.selected === r().card.id || preview() !== undefined;
                            const showCompactNumber = () => barWidth() >= 36;
                            const showFullTitle = () => barWidth() >= 92;

                            return (
                              <View
                                testID={`timeline-lane-${r().issue.id}`}
                                class="absolute right-0 left-0 flex-row items-center border-b"
                                style={{
                                  top: rowIdx() * ROW_HEIGHT,
                                  height: ROW_HEIGHT,
                                  borderColor: mix("line", 0.45),
                                }}
                              >
                                <View
                                  {...bodyPan.panHandlers}
                                  role="button"
                                  testID="timeline-bar"
                                  accessibilityLabel={`#${r().issue.number} ${r().issue.title}`}
                                  tooltip={<Bubble text={barTooltipText(r())} />}
                                  onPress={() => {
                                    if (suppressNextPress || untracked(activeDrag) !== undefined) {
                                      suppressNextPress = false;
                                      return;
                                    }
                                    props.onOpen(r().card.id);
                                  }}
                                  class={`group absolute flex-row items-center rounded-md border ${showFullTitle() ? "gap-1.5 px-2" : "px-1.5"} ${
                                    r().span.rolledUp && !r().span.hasExplicitStart && !r().span.hasExplicitDue ? "border-dashed" : ""
                                  } ${motionClass("transition-transform duration-120 ease-out")} focus-visible:outline-2 focus-visible:outline-focus`}
                                  style={{
                                    left: barLeft(),
                                    width: barWidth(),
                                    height: 24,
                                    backgroundColor: barFillColor(barTone()),
                                    borderColor: barBorderColor(barTone(), selected()),
                                  }}
                                >
                                  <View
                                    {...startResizePan.panHandlers}
                                    testID="timeline-resize-start"
                                    class="absolute top-0 bottom-0 left-0 z-10 w-1.5 cursor-col-resize items-center justify-center rounded-l-md"
                                  >
                                    <View
                                      class={`h-3 w-0.5 rounded-full ${
                                        draggingThis()?.mode === "resize-start" ? "bg-accent" : "bg-transparent group-hover:bg-line-strong"
                                      }`}
                                    />
                                  </View>

                                  <If when={showCompactNumber()}>
                                    <Text class="shrink-0 font-mono text-2xs font-medium text-ink tabular-nums">{`#${r().issue.number}`}</Text>
                                    <If when={showFullTitle()}>
                                      <Text class="min-w-0 flex-1 truncate text-2xs font-medium text-ink">{r().issue.title}</Text>
                                    </If>
                                  </If>

                                  <View
                                    {...endResizePan.panHandlers}
                                    testID="timeline-resize-end"
                                    class="absolute top-0 right-0 bottom-0 z-10 w-1.5 cursor-col-resize items-center justify-center rounded-r-md"
                                  >
                                    <View
                                      class={`h-3 w-0.5 rounded-full ${
                                        draggingThis()?.mode === "resize-end" ? "bg-accent" : "bg-transparent group-hover:bg-line-strong"
                                      }`}
                                    />
                                  </View>
                                </View>

                                <If when={preview()}>
                                  {(p) => (
                                    <View
                                      testID="timeline-drag-pill"
                                      class="pointer-events-none absolute z-20 rounded-md border border-accent bg-elevated px-1.5 py-0.5 shadow-float"
                                      style={{ left: barLeft() + barWidth() + 6 }}
                                    >
                                      <Text class="font-mono text-2xs font-medium text-ink tabular-nums">{formatDateSpan(p().startMs, p().endMs)}</Text>
                                    </View>
                                  )}
                                </If>
                              </View>
                            );
                          }}
                        </Each>
                      </View>
                    </View>
                  </Scroll>
                </View>
              </Scroll>
            </If>

            {/* Collapsible Unscheduled Issues Drawer */}
            <If when={unscheduledVisible() && timeline().unscheduled.length > 0}>
              <View testID="timeline-unscheduled-list" class="max-h-52 shrink-0 border-t border-line bg-side">
                <View class="h-8 flex-row items-center justify-between border-b border-line px-4">
                  <View class="flex-row items-center gap-1.5">
                    <Text class="text-xs font-semibold text-muted">{t("web.issue.timeline.unscheduledTitle")}</Text>
                    <CountPill count={timeline().unscheduled.length} />
                  </View>
                  <If when={timeline().rows.length > 0}>
                    <IconButton
                      testid="timeline-unscheduled-close"
                      icon="close"
                      size={12}
                      label={t("web.issue.sheet.less")}
                      onClick={() => showUnscheduled.set(false)}
                    />
                  </If>
                </View>
                <Scroll class="min-h-0 max-h-44 shrink">
                  <View class="px-2 py-1">
                    <Each of={timeline().unscheduled} key={(c) => c.id}>
                      {(c) => (
                        <View testID="timeline-unscheduled-item" class="flex-row items-center justify-between gap-2 rounded-md px-2 py-1.5 hover:bg-hover">
                          <View role="button" onPress={() => props.onOpen(c().id)} class="min-w-0 flex-1 flex-row items-center gap-2">
                            <StatusMark status={c().issue.status} size={13} />
                            <Text class="shrink-0 font-mono text-2xs text-faint tabular-nums">{`#${c().issue.number}`}</Text>
                            <Text class="min-w-0 flex-1 truncate text-xs font-medium text-ink">{c().issue.title}</Text>
                          </View>
                          <Button
                            size="compact"
                            tone="plain"
                            icon="calendar"
                            testID={`timeline-schedule-today-${c().issue.id}`}
                            onPress={() => scheduleToday(c().issue)}
                          >
                            {t("web.issue.timeline.scheduleToday")}
                          </Button>
                        </View>
                      )}
                    </Each>
                  </View>
                </Scroll>
              </View>
            </If>
          </View>
        </If>
      </View>
    </If>
  );
}
