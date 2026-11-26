import { computed, Text, View } from "nsh";
import {
  Calendar as BaseCalendar,
  DatePicker as BaseDatePicker,
  type Align,
  type CalendarEntry,
  type CalendarValue as BaseCalendarValue,
  type DateMatcher,
  type DatePickerValue as BaseDatePickerValue,
  type DateRangePreset,
  type OpenChangeReason,
  type Placement,
} from "nsh/base";

import { t } from "@vibevalley/i18n";

import { Icon } from "./Icon";
import { motionClass, popupTransition } from "./motion";

const DAY_MS = 86_400_000;
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/u;

const WEEKDAY_KEYS = ["0", "1", "2", "3", "4", "5", "6"] as const;
type WeekdayKey = (typeof WEEKDAY_KEYS)[number];

function weekdayKey(dayIndex: number): WeekdayKey {
  return WEEKDAY_KEYS[((dayIndex % 7) + 7) % 7] ?? "0";
}

export type DateRangeIso = readonly [string | undefined, string | undefined];
export type DateInputValue = string | DateRangeIso;

/** Formats Unix epoch milliseconds (positive finite) as UTC `YYYY-MM-DD`, or `undefined` when unset. */
export function epochMsToIsoDate(ms: number | undefined): string | undefined {
  if (ms === undefined || !Number.isFinite(ms) || ms <= 0) return undefined;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return undefined;
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Parses `YYYY-MM-DD` (or `YYYY-MM-DDTHH:mm` prefix) into UTC midnight epoch ms, or `undefined` if empty/invalid. */
export function isoDateToEpochMs(iso: string | undefined): number | undefined {
  if (iso === undefined) return undefined;
  const datePart = iso.trim().split("T")[0] ?? "";
  if (datePart === "") return undefined;
  const match = ISO_DATE_RE.exec(datePart);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  const ms = Date.UTC(year, month - 1, day);
  const check = new Date(ms);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() + 1 !== month || check.getUTCDate() !== day) return undefined;
  return ms;
}

/** Parses `YYYY-MM-DD` into UTC midnight epoch ms, returning `0` when unset/cleared (matches issue date mutation API). */
export function isoDateToCommitMs(iso: string | undefined): number {
  return isoDateToEpochMs(iso) ?? 0;
}

/** Returns today's UTC `YYYY-MM-DD` ISO date string. */
export function todayIsoDate(nowMs = Date.now()): string {
  return epochMsToIsoDate(nowMs) ?? "1970-01-01";
}

/** Shifts an ISO `YYYY-MM-DD` date by `days` UTC calendar days. */
export function addIsoDays(iso: string, days: number): string {
  const base = isoDateToEpochMs(iso);
  if (base === undefined) return iso;
  return epochMsToIsoDate(base + days * DAY_MS) ?? iso;
}

/** Builds `[startIso, endIso]` range adapter from epoch-ms timestamps. */
export function epochMsRangeToIso(startAt: number | undefined, dueAt: number | undefined): DateRangeIso {
  return [epochMsToIsoDate(startAt), epochMsToIsoDate(dueAt)];
}

/** Converts a `DateInputValue` (single ISO string or `[startIso, endIso]`) into epoch-ms `{ startAt, dueAt }`. */
export function isoRangeToEpochMs(value: DateInputValue | undefined): { startAt: number | undefined; dueAt: number | undefined } {
  if (value === undefined) return { startAt: undefined, dueAt: undefined };
  if (typeof value === "string") {
    const ms = isoDateToEpochMs(value);
    return { startAt: ms, dueAt: ms };
  }
  return {
    startAt: isoDateToEpochMs(value[0]),
    dueAt: isoDateToEpochMs(value[1]),
  };
}

function toBaseValue(value: DateInputValue | undefined): BaseDatePickerValue {
  if (value === undefined) return null;
  if (typeof value === "string") return value.trim() || null;
  const start = value[0]?.trim() || null;
  const end = value[1]?.trim() || null;
  return [start, end];
}

function fromBaseValue(value: BaseDatePickerValue): DateInputValue | undefined {
  if (value === null) return undefined;
  if (typeof value === "string") return value.trim() || undefined;
  const start = value[0]?.trim() || undefined;
  const end = value[1]?.trim() || undefined;
  if (start === undefined && end === undefined) return undefined;
  return [start, end];
}

function formatTriggerText(value: DateInputValue | undefined, placeholder: string): { text: string; hasValue: boolean } {
  if (value === undefined) return { text: placeholder, hasValue: false };
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? { text: trimmed, hasValue: true } : { text: placeholder, hasValue: false };
  }
  const [start, end] = value;
  if (start !== undefined && end !== undefined) return { text: start === end ? start : `${start} -> ${end}`, hasValue: true };
  if (start !== undefined) return { text: `${start} -> …`, hasValue: true };
  if (end !== undefined) return { text: `… -> ${end}`, hasValue: true };
  return { text: placeholder, hasValue: false };
}

/** Default Papertrails quick presets: Today / +3d / +1w / Clear. */
export function defaultDatePresets(options?: { readonly range?: boolean | undefined; readonly nowMs?: number | undefined }): DateRangePreset[] {
  const baseIso = todayIsoDate(options?.nowMs);
  const plus3Iso = addIsoDays(baseIso, 3);
  const plus7Iso = addIsoDays(baseIso, 7);
  const clearLabel = t("web.issue.dates.clearDate");
  const todayLabel = t("web.base.time.today");
  if (options?.range === true) {
    return [
      { label: todayLabel, value: [baseIso, baseIso] },
      { label: "+3d", value: [baseIso, plus3Iso] },
      { label: "+1w", value: [baseIso, plus7Iso] },
      { label: clearLabel, value: [null, null] },
    ];
  }
  return [
    { label: todayLabel, value: baseIso },
    { label: "+3d", value: plus3Iso },
    { label: "+1w", value: plus7Iso },
    // nsh-base's JsObject rejects `null` on required field `value`; `[null, null]` decodes as Range(None, None) and clears cleanly.
    { label: clearLabel, value: [null, null] },
  ];
}

function renderCalendarEntry(entry: CalendarEntry) {
  switch (entry.kind) {
    case "previous":
      return <Icon name="previous" size={12} tone="muted" />;
    case "next":
      return <Icon name="next" size={12} tone="muted" />;
    case "monthToggle":
      return (
        <Text class="text-xs font-semibold text-ink tabular-nums">{t("web.base.time.month", { month: entry.month > 0 ? entry.month : entry.value })}</Text>
      );
    case "yearToggle":
      return <Text class="text-xs font-semibold text-ink tabular-nums">{String(entry.year !== 0 ? entry.year : entry.value)}</Text>;
    case "weekday":
      return <Text class="text-2xs font-medium text-faint">{t(`web.base.time.weekdays.${weekdayKey(entry.value)}`)}</Text>;
    case "day":
      return (
        <View class="relative size-full items-center justify-center">
          <Text class="text-xs text-ink tabular-nums group-disabled:text-faint group-data-outside:text-faint group-selected:font-semibold group-selected:text-page group-data-range-middle:text-ink">
            {String(entry.value)}
          </Text>
          <If when={entry.today}>
            <View class="absolute bottom-0.5 size-1 rounded-full bg-accent group-selected:bg-page" />
          </If>
        </View>
      );
    case "month":
      return <Text class="text-xs text-ink group-selected:font-semibold group-selected:text-page">{t("web.base.time.month", { month: entry.value })}</Text>;
    case "year":
      return <Text class="text-xs text-ink tabular-nums group-selected:font-semibold group-selected:text-page">{String(entry.value)}</Text>;
  }
}

const CALENDAR_CLASSES = {
  headerClass: "flex-row items-center justify-between gap-1 pb-2",
  bodyClass: "flex-row gap-3",
  monthClass: "min-w-56 gap-1",
  rowClass: "flex-row items-center gap-0.5",
  itemClass:
    "group h-7 min-w-7 items-center justify-center rounded-md px-1 hover:bg-hover selected:bg-accent data-range-middle:rounded-none data-range-middle:bg-selected data-range-preview-middle:rounded-none data-range-preview-middle:bg-selected disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-focus",
} as const;

export interface CalendarProps {
  readonly value?: DateInputValue | undefined;
  readonly defaultValue?: DateInputValue | undefined;
  readonly range?: boolean | undefined;
  readonly numberOfMonths?: number | undefined;
  readonly firstDayOfWeek?: number | undefined;
  readonly disabledMatcher?: DateMatcher | undefined;
  readonly yearRange?: [number, number] | undefined;
  readonly onChange?: ((value: DateInputValue | undefined) => void) | undefined;
  readonly testid?: string | undefined;
  readonly class?: string | undefined;
}

/** Papertrails-styled standalone calendar wrapping `nsh/base`'s `Calendar`. */
export function Calendar(props: CalendarProps) {
  const controlledValue = (): BaseCalendarValue | undefined => {
    if (props.value !== undefined) return toBaseValue(props.value);
    return props.onChange !== undefined ? null : undefined;
  };
  return (
    <BaseCalendar
      testID={props.testid}
      value={controlledValue()}
      defaultValue={props.defaultValue !== undefined ? toBaseValue(props.defaultValue) : undefined}
      range={props.range}
      numberOfMonths={props.numberOfMonths ?? 1}
      firstDayOfWeek={props.firstDayOfWeek ?? 1}
      disabledMatcher={props.disabledMatcher}
      yearRange={props.yearRange}
      previousAccessibilityLabel={t("web.issue.calendar.prevMonth")}
      nextAccessibilityLabel={t("web.issue.calendar.nextMonth")}
      headerClass={CALENDAR_CLASSES.headerClass}
      bodyClass={CALENDAR_CLASSES.bodyClass}
      monthClass={CALENDAR_CLASSES.monthClass}
      rowClass={CALENDAR_CLASSES.rowClass}
      itemClass={CALENDAR_CLASSES.itemClass}
      renderItem={renderCalendarEntry}
      onChange={(e) => props.onChange?.(fromBaseValue(e.value))}
      class={props.class}
    />
  );
}

export interface DatePickerProps {
  readonly value?: DateInputValue | undefined;
  readonly defaultValue?: DateInputValue | undefined;
  readonly range?: boolean | undefined;
  readonly open?: boolean | undefined;
  readonly defaultOpen?: boolean | undefined;
  readonly onOpenChange?: ((open: boolean, reason: OpenChangeReason) => void) | undefined;
  readonly onChange?: ((value: DateInputValue | undefined) => void) | undefined;
  readonly disabled?: boolean | undefined;
  readonly cleanable?: boolean | undefined;
  readonly presets?: DateRangePreset[] | false | undefined;
  readonly disabledMatcher?: DateMatcher | undefined;
  readonly yearRange?: [number, number] | undefined;
  readonly numberOfMonths?: number | undefined;
  readonly firstDayOfWeek?: number | undefined;
  readonly placeholder?: string | undefined;
  readonly label: string;
  readonly testid?: string | undefined;
  readonly size?: "control" | "field" | undefined;
  readonly quiet?: boolean | undefined;
  readonly showIcon?: boolean | undefined;
  readonly placement?: Placement | undefined;
  readonly align?: Align | undefined;
  readonly class?: string | undefined;
  readonly popupClass?: string | undefined;
  readonly nowMs?: number | undefined;
}

/** Papertrails-styled date picker wrapping `nsh/base`'s `DatePicker` with downward popup and Today/+3d/+1w/Clear presets. */
export function DatePicker(props: DatePickerProps) {
  const disabled = () => props.disabled === true;
  const placeholder = () => props.placeholder ?? t("web.issue.dates.notSet");
  const controlledValue = (): BaseDatePickerValue | undefined => {
    if (props.value !== undefined) return toBaseValue(props.value);
    return props.onChange !== undefined ? null : undefined;
  };
  const resolvedPresets = computed((): DateRangePreset[] => {
    if (props.presets === false) return [];
    if (props.presets !== undefined) return props.presets;
    return defaultDatePresets({ range: props.range, nowMs: props.nowMs });
  });
  const display = computed(() => formatTriggerText(props.value ?? props.defaultValue, placeholder()));
  const textSizeClass = () => (props.size === "control" ? "text-xs" : "text-sm");
  const triggerSurface = () => {
    if (props.quiet === true) return disabled() ? "border-transparent bg-transparent" : "border-transparent bg-transparent hover:border-line hover:bg-page";
    return disabled() ? "border-line bg-page" : "border-line bg-page hover:border-faint hover:bg-hover";
  };

  return (
    <BaseDatePicker
      testID={props.testid}
      accessibilityLabel={props.label}
      value={controlledValue()}
      defaultValue={props.defaultValue !== undefined ? toBaseValue(props.defaultValue) : undefined}
      range={props.range}
      open={props.open}
      defaultOpen={props.defaultOpen}
      disabled={props.disabled}
      cleanable={props.cleanable !== false && !disabled()}
      presets={resolvedPresets()}
      numberOfMonths={props.numberOfMonths ?? 1}
      firstDayOfWeek={props.firstDayOfWeek ?? 1}
      disabledMatcher={props.disabledMatcher}
      yearRange={props.yearRange}
      placement={props.placement ?? "bottom"}
      align={props.align ?? "start"}
      offset={4}
      previousAccessibilityLabel={t("web.issue.calendar.prevMonth")}
      nextAccessibilityLabel={t("web.issue.calendar.nextMonth")}
      popupClass={`rounded-lg border border-line bg-elevated p-2.5 shadow-float ${motionClass("transition-opacity duration-120 ease-out")} ${props.popupClass ?? ""}`}
      popupStartingClass={popupTransition("opacity-0")}
      popupEndingClass={popupTransition("opacity-0")}
      contentClass="flex-row items-start gap-2.5"
      presetsClass="w-20 shrink-0 gap-1 border-r border-line pr-2"
      presetClass="h-7 items-start justify-center rounded-md px-2 text-xs font-medium text-ink hover:bg-hover focus-visible:outline-2 focus-visible:outline-focus"
      headerClass={CALENDAR_CLASSES.headerClass}
      bodyClass={CALENDAR_CLASSES.bodyClass}
      monthClass={CALENDAR_CLASSES.monthClass}
      rowClass={CALENDAR_CLASSES.rowClass}
      itemClass={CALENDAR_CLASSES.itemClass}
      renderItem={renderCalendarEntry}
      clearButtonClass="size-6 shrink-0 items-center justify-center rounded-md hover:bg-hover focus-visible:outline-2 focus-visible:outline-focus"
      clearButtonAccessibilityLabel={t("web.issue.dates.clearDate")}
      clearButton={
        <View testID={props.testid ? `${props.testid}-clear` : undefined} class="items-center justify-center">
          <Icon name="close" size={12} tone="muted" />
        </View>
      }
      onChange={(e) => props.onChange?.(fromBaseValue(e.value))}
      onOpenChange={(e) => props.onOpenChange?.(e.open, e.reason)}
      class={`min-w-0 flex-row items-center gap-1 ${props.class ?? ""}`}
      trigger={
        <View
          testID={props.testid ? `${props.testid}-trigger` : undefined}
          class={[
            "min-w-0 flex-1 flex-row items-center gap-1.5 rounded-md border",
            props.size === "control" ? "h-7 px-2" : "h-8 px-2.5",
            triggerSurface(),
            disabled() ? "opacity-50" : "aria-expanded:border-focus focus-visible:outline-2 focus-visible:outline-focus",
          ].join(" ")}
        >
          <If when={props.showIcon !== false}>
            <Icon
              name="calendar"
              size={12}
              tone={disabled() || !display().hasValue ? "faint" : "muted"}
              testID={props.testid ? `${props.testid}-icon` : undefined}
            />
          </If>
          <Text class={`min-w-0 flex-1 truncate ${textSizeClass()} ${display().hasValue ? "font-mono text-ink tabular-nums" : "text-faint"}`}>
            {display().text}
          </Text>
          <Icon name="choose" size={12} tone="muted" />
        </View>
      }
    />
  );
}

export interface EpochDatePickerProps extends Omit<DatePickerProps, "value" | "defaultValue" | "onChange" | "range"> {
  readonly value: number | undefined;
  readonly onChange: (ms: number) => void;
  readonly minMs?: number | undefined;
  readonly maxMs?: number | undefined;
}

/** Epoch-millisecond adapter over `DatePicker`: reads `number | undefined` and emits UTC midnight ms (or `0` when cleared). */
export function EpochDatePicker(props: EpochDatePickerProps) {
  const isoValue = computed(() => epochMsToIsoDate(props.value));
  const matcher = computed((): DateMatcher | undefined => {
    if (props.disabledMatcher !== undefined) return props.disabledMatcher;
    const before = epochMsToIsoDate(props.minMs);
    const after = epochMsToIsoDate(props.maxMs);
    if (before === undefined && after === undefined) return undefined;
    return {
      ...(before !== undefined ? { before } : {}),
      ...(after !== undefined ? { after } : {}),
    };
  });

  return (
    <DatePicker
      label={props.label}
      value={isoValue()}
      onChange={(next) => {
        const single = typeof next === "string" ? next : undefined;
        props.onChange(isoDateToCommitMs(single));
      }}
      open={props.open}
      defaultOpen={props.defaultOpen}
      onOpenChange={props.onOpenChange}
      disabled={props.disabled}
      cleanable={props.cleanable}
      presets={props.presets}
      disabledMatcher={matcher()}
      yearRange={props.yearRange}
      numberOfMonths={props.numberOfMonths}
      firstDayOfWeek={props.firstDayOfWeek}
      placeholder={props.placeholder}
      testid={props.testid}
      size={props.size}
      quiet={props.quiet}
      showIcon={props.showIcon}
      placement={props.placement}
      align={props.align}
      class={props.class}
      popupClass={props.popupClass}
      nowMs={props.nowMs}
    />
  );
}
