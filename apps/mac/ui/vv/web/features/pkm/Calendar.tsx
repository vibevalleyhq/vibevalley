import { Text, View } from "nsh";
import { z } from "zod";

import { t } from "@vibevalley/i18n";
import type { PkmPageSummary } from "@vibevalley/protocol";

import { createMemo, createSignal } from "../../../solid";
import { createExternal } from "../../base/external";
import { api } from "../../infra/api";
import { localDay } from "../../infra/localDay";
import { useQueryClient } from "../../infra/query";
import { useRouter } from "../../infra/router";
import { defineStored } from "../../state/stored";
import { createAct } from "../../ui/act";
import { Icon } from "../../ui/Icon";
import { IconButton } from "../../ui/IconButton";
import { Bubble } from "../../ui/Tip";
import { mix, tone } from "../../ui/tone";
import { dayTitle, monthTitle, monthWeeks, weekdayNames } from "./days";
import { pkmHref, refreshVault } from "./vault";

const unfolded = defineStored("pkm.calendar", z.boolean(), true);

/** open: the day of the journal open, if one is. */
export function Calendar(props: { pages: readonly PkmPageSummary[]; open: string | undefined }) {
  return (
    <View testID="pkm-calendar" accessibilityLabel={t("web.pkm.calendar.label")} class="gap-2">
      <View
        role="button"
        testID="pkm-calendar-fold"
        accessibilityState={{ expanded: unfolded.get() }}
        onPress={() => unfolded.update((open) => !open)}
        class="group -mx-1.5 h-7 flex-row items-center gap-1.5 rounded-md px-1.5 transition duration-120 ease-out hover:bg-hover"
      >
        <View
          class="w-3.5 shrink-0 items-center justify-center"
          style={{
            transform: [{ rotate: unfolded.get() ? "90deg" : "0deg" }],
            transitionProperty: "transform",
            transitionDuration: 120,
          }}
        >
          <Icon name="expand" size={10} tone="muted" />
        </View>
        <Text class="text-xs font-semibold text-muted group-hover:text-ink">{t("web.pkm.calendar.label")}</Text>
      </View>
      <If when={unfolded.get()}>
        <Month pages={props.pages} open={props.open} />
      </If>
    </View>
  );
}

function Month(props: { pages: readonly PkmPageSummary[]; open: string | undefined }) {
  const queries = useQueryClient();
  const router = useRouter();
  const act = createAct();
  const today = createExternal(localDay.subscribe, localDay.get);
  const [chosen, setChosen] = createSignal<{ year: number; month: number }>();
  const month = createMemo(() => chosen() ?? { year: Number(today().slice(0, 4)), month: Number(today().slice(5, 7)) - 1 });
  const journals = createMemo(() => new Map(props.pages.flatMap((p) => (p.day ? [[p.day, p.slug] as const] : []))));
  const shift = (by: number) => {
    const current = month();
    const d = new Date(current.year, current.month + by, 1);
    setChosen({ year: d.getFullYear(), month: d.getMonth() });
  };
  const go = (day: string) => {
    const slug = journals().get(day);
    if (slug) return router.navigate(pkmHref(slug));
    void act.run(async () => {
      const page = await api.pkm.journal.open({ day });
      void refreshVault(queries);
      router.navigate(pkmHref(page.slug));
    });
  };
  return (
    <View class="gap-1.5">
      <View class="h-7 flex-row items-center gap-0.5">
        <Text testID="pkm-calendar-month" class="flex-1 text-xs font-medium text-ink" style={{ fontVariant: ["tabular-nums"] }}>
          {monthTitle(month().year, month().month)}
        </Text>
        <IconButton icon="previous" size={12} label={t("web.pkm.calendar.previous")} testid="pkm-calendar-previous" onClick={() => shift(-1)} />
        <IconButton icon="next" size={12} label={t("web.pkm.calendar.next")} testid="pkm-calendar-next" onClick={() => shift(1)} />
      </View>
      <View class="flex-row py-0.5">
        <Each of={weekdayNames()}>{(name) => <Text class="flex-1 text-center text-2xs font-medium text-faint">{name()}</Text>}</Each>
      </View>
      <View class="gap-0.5">
        <Each of={monthWeeks(month().year, month().month)}>
          {(week) => (
            <View class="flex-row">
              <Each of={week()}>
                {(d) => {
                  const here = () => d().day === props.open;
                  const isToday = () => d().day === today();
                  const hasJournal = () => journals().has(d().day);
                  return (
                    <View class="flex-1 items-center">
                      <View
                        role="button"
                        testID="pkm-day-cell"
                        accessibilityLabel={dayTitle(d().day, today())}
                        accessibilityState={{ selected: here(), disabled: act.busy() }}
                        tooltip={<Bubble text={dayTitle(d().day, today()) ?? d().day} />}
                        disabled={act.busy()}
                        onPress={() => go(d().day)}
                        class={`relative h-7 w-7 items-center justify-center rounded-md transition duration-120 ease-out focus-visible:outline-2 focus-visible:outline-focus ${here() ? "bg-selected" : "hover:bg-hover"}`}
                        style={isToday() && !here() ? { backgroundColor: mix("accent", 0.08) } : undefined}
                      >
                        <If when={isToday()}>
                          <View class="pointer-events-none absolute inset-0 rounded-md" style={{ borderWidth: 1.5, borderColor: tone("accent") }} />
                        </If>
                        <Text
                          class={`text-xs font-medium ${isToday() && !here() ? "text-accent" : d().inMonth ? "text-ink" : "text-faint"}`}
                          style={{ fontVariant: ["tabular-nums"] }}
                        >
                          {String(Number(d().day.slice(8)))}
                        </Text>
                        <If when={hasJournal()}>
                          <View testID="pkm-journal-dot" class={`absolute bottom-0.5 h-1 w-1 rounded-full ${d().inMonth ? "bg-accent" : "bg-faint"}`} />
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
    </View>
  );
}
