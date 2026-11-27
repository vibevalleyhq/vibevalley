import { computed, Scroll, signal, Text, View, windowSize } from "nsh";

import { t } from "@vibevalley/i18n";
import type { BoardSummary, Issue, Priority } from "@vibevalley/protocol";

import { Button } from "../../../design/Button";
import { Icon } from "../../../design/Icon";
import { IconButton } from "../../../design/IconButton";
import { motionClass } from "../../../design/motion";
import { Dot, type DotTone } from "../../../design/Tag";
import { Bubble } from "../../../design/Tip";
import { mix } from "../../../design/tone";
import { useNow } from "../../../infra/base/dom";
import type { BoardCard } from "../model/cards";
import { formatIsoDate } from "../model/meta";
import { buildMonthGrid, buildScheduleForCards, groupScheduledByDay, monthDateParts, type ScheduledCardRow, shiftMonth } from "../model/schedule";
import { EmptyNote } from "./Board";
import type { NewIssueAt } from "./NewIssue";

const MAX_PILLS_PER_DAY = 3;
const weekdayKeys = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

const priorityDotTone: Record<Priority, DotTone> = {
  urgent: "berry",
  high: "wheat",
  medium: "water",
  low: "faint",
};

function pillBackground(row: ScheduledCardRow): string | undefined {
  if (row.issue.status === "done") return mix("leaf", 0.14);
  if (row.issue.status === "canceled") return mix("idle", 0.14);
  if (row.span.overdue) return mix("berry", 0.14);
  if (row.issue.status === "in_progress") return mix("water", 0.14);
  if (row.issue.status === "in_review") return mix("wheat", 0.16);
  return undefined;
}

function pillTooltip(row: ScheduledCardRow): string {
  const start = formatIsoDate(row.span.startMs);
  const end = formatIsoDate(row.span.endMs);
  const range = start === end ? start : `${start} → ${end}`;
  return [`#${row.issue.number} ${row.issue.title}`, `${t(`shared.status.${row.issue.status}`)} · ${range}`].join("\n");
}

/** Interactive Mon–Sun Calendar view showing scheduled issues by active/due dates with quick day creation. */
export function IssueCalendar(props: {
  cards: BoardCard[];
  allIssues: readonly Issue[];
  summary?: BoardSummary | undefined;
  filtered?: boolean | undefined;
  loading: boolean;
  selected?: string | undefined;
  onOpen: (id: string) => void;
  onNew: (at: NewIssueAt) => void;
  onClearFilter?: (() => void) | undefined;
}) {
  const now = useNow(60_000);
  const compactHeight = () => windowSize().height < 780;
  const initial = monthDateParts(now());
  const cursor = signal<{ year: number; month: number }>(initial);
  const expandedDays = signal<ReadonlySet<string>>(new Set());

  const grid = computed(() => buildMonthGrid(cursor().year, cursor().month, now()));
  const timeline = computed(() => buildScheduleForCards(props.cards, props.allIssues, "month", now(), props.summary));
  const byDay = computed(() => groupScheduledByDay(grid(), timeline().rows));

  const goMonth = (delta: number) => {
    const cur = cursor();
    cursor.set(shiftMonth(cur.year, cur.month, delta));
  };
  const goToday = () => {
    cursor.set(monthDateParts(now()));
  };

  const toggleExpandDay = (dateKey: string) => {
    const next = new Set(expandedDays());
    if (next.has(dateKey)) next.delete(dateKey);
    else next.add(dateKey);
    expandedDays.set(next);
  };

  return (
    <If when={!props.loading} else={<EmptyNote>{t("web.issue.reading")}</EmptyNote>}>
      <View testID="issue-calendar" class="min-h-0 flex-1 bg-page">
        <View testID="calendar-header" class="h-10 shrink-0 flex-row items-center justify-between gap-2 border-b border-line bg-side px-4">
          <View class="flex-row items-center gap-2.5">
            <Text testID="calendar-month-label" class="text-sm font-semibold text-ink tabular-nums">
              {t("web.issue.calendar.monthTitle", { year: grid().year, month: grid().month })}
            </Text>
            <Text class="text-xs text-faint tabular-nums">{t("web.issue.timeline.scheduledCount", { n: timeline().rows.length })}</Text>
          </View>
          <View class="flex-row items-center gap-1">
            <IconButton testid="calendar-prev" icon="previous" size={14} label={t("web.issue.calendar.prevMonth")} onClick={() => goMonth(-1)} />
            <Button size="compact" tone="plain" testID="calendar-today" onPress={goToday}>
              {t("web.issue.timeline.today")}
            </Button>
            <IconButton testid="calendar-next" icon="next" size={14} label={t("web.issue.calendar.nextMonth")} onClick={() => goMonth(1)} />
          </View>
        </View>

        <If when={props.filtered === true && props.cards.length === 0}>
          <View testID="calendar-empty-filtered" class="flex-row items-center justify-between gap-2 border-b border-line bg-page px-4 py-2">
            <Text class="text-xs text-muted">{t("web.issue.list.emptyFiltered")}</Text>
            <If when={props.onClearFilter}>
              {(clear) => (
                <Button size="compact" tone="plain" icon="close" testID="calendar-clear-filter" onPress={() => clear()()}>
                  {t("web.issue.page.clear")}
                </Button>
              )}
            </If>
          </View>
        </If>

        {/* Mon-Sun weekday header */}
        <View class="shrink-0 flex-row border-b border-line bg-side">
          <Each of={weekdayKeys} key={(k) => k}>
            {(k, idx) => (
              <View class={`min-w-0 flex-1 px-2 py-1.5 ${idx() < 6 ? "border-r border-line" : ""}`}>
                <Text class={`text-2xs font-semibold ${idx() >= 5 ? "text-faint" : "text-muted"}`}>{t(`web.issue.timeline.weekday.${k()}`)}</Text>
              </View>
            )}
          </Each>
        </View>

        {/* 7-column month grid */}
        <Scroll testID="calendar-grid-scroll" class="min-h-0 flex-1" contentClass="grow">
          <View class="grow">
            <Each of={grid().weeks} key={(week) => week[0]?.dateKey ?? ""}>
              {(week, weekIdx) => (
                <View
                  testID={`calendar-week-${weekIdx()}`}
                  class={`${compactHeight() ? "min-h-20" : "min-h-28"} grow flex-row ${weekIdx() < grid().weeks.length - 1 ? "border-b border-line" : ""}`}
                >
                  <Each of={week()} key={(cell) => cell.dateKey}>
                    {(cell, colIdx) => {
                      const items = computed(() => byDay().get(cell().dateKey) ?? []);
                      const expanded = computed(() => expandedDays().has(cell().dateKey));
                      const shown = computed(() => (expanded() ? items() : items().slice(0, MAX_PILLS_PER_DAY)));
                      const hiddenCount = computed(() => Math.max(0, items().length - MAX_PILLS_PER_DAY));
                      return (
                        <View
                          testID={`calendar-day-${cell().dateKey}`}
                          class={`group min-w-0 flex-1 gap-1 p-1.5 ${colIdx() < 6 ? "border-r border-line" : ""} ${
                            cell().inMonth ? "bg-page" : "bg-side opacity-65"
                          }`}
                          style={cell().isWeekend && cell().inMonth ? { backgroundColor: mix("side", 0.45) } : undefined}
                        >
                          {/* Day number + quick create button */}
                          <View class="flex-row items-center justify-between gap-1">
                            <If
                              when={cell().isToday}
                              else={
                                <Text
                                  testID={`calendar-day-num-${cell().dateKey}`}
                                  class={`px-1 font-mono text-2xs tabular-nums ${cell().inMonth ? "font-medium text-ink" : "text-faint"}`}
                                >
                                  {String(cell().day)}
                                </Text>
                              }
                            >
                              <View testID="calendar-today-badge" class="rounded-full border border-accent bg-accent px-1.5 py-px">
                                <Text testID={`calendar-day-num-${cell().dateKey}`} class="font-mono text-2xs font-semibold text-page tabular-nums">
                                  {String(cell().day)}
                                </Text>
                              </View>
                            </If>
                            <View
                              role="button"
                              testID="calendar-day-add"
                              accessibilityLabel={t("web.issue.calendar.newOnDate", { date: cell().dateKey })}
                              tooltip={<Bubble text={t("web.issue.calendar.newOnDate", { date: cell().dateKey })} />}
                              onPress={() => props.onNew({ startAt: cell().dayMs, dueAt: cell().dayMs })}
                              class={`size-5 items-center justify-center rounded-sm opacity-0 group-hover:opacity-100 hover:bg-hover focus:opacity-100 ${motionClass(
                                "transition-transform duration-120 ease-out",
                              )} active:translate-y-px focus-visible:outline-2 focus-visible:outline-focus`}
                            >
                              <Icon name="add" size={11} tone="muted" />
                            </View>
                          </View>

                          {/* Day issue pills */}
                          <View class="gap-1">
                            <Each of={shown()} key={(r) => r.card.id}>
                              {(r) => {
                                const bg = () => pillBackground(r());
                                const isSelected = () => props.selected === r().card.id;
                                return (
                                  <View
                                    role="button"
                                    testID="calendar-pill"
                                    accessibilityLabel={`#${r().issue.number} ${r().issue.title}`}
                                    accessibilityState={{ selected: isSelected() }}
                                    tooltip={<Bubble text={pillTooltip(r())} />}
                                    onPress={() => props.onOpen(r().card.id)}
                                    class={`flex-row items-center gap-1 rounded-sm border px-1.5 py-0.5 hover:bg-hover focus-visible:outline-2 focus-visible:outline-focus ${
                                      isSelected() ? "border-accent bg-selected" : "border-line bg-side"
                                    }`}
                                    style={bg() && !isSelected() ? { backgroundColor: bg() } : undefined}
                                  >
                                    <Dot tone={priorityDotTone[r().issue.priority]} size={6} ring={false} />
                                    <Text class="shrink-0 font-mono text-2xs text-faint tabular-nums">{`#${r().issue.number}`}</Text>
                                    <Text class="min-w-0 flex-1 truncate text-2xs font-medium text-ink">{r().issue.title}</Text>
                                  </View>
                                );
                              }}
                            </Each>
                            <If when={hiddenCount() > 0}>
                              <View
                                role="button"
                                testID="calendar-day-more"
                                onPress={() => toggleExpandDay(cell().dateKey)}
                                class="self-start rounded-sm px-1.5 py-0.5 hover:bg-hover focus-visible:outline-2 focus-visible:outline-focus"
                              >
                                <Text class="text-2xs font-medium text-water">
                                  {expanded() ? t("web.issue.calendar.collapseDay") : t("web.issue.calendar.moreItems", { n: hiddenCount() })}
                                </Text>
                              </View>
                            </If>
                          </View>
                        </View>
                      );
                    }}
                  </Each>
                </View>
              )}
            </Each>
          </View>
        </Scroll>
      </View>
    </If>
  );
}
