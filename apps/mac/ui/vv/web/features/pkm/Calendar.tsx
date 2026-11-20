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
import { tone } from "../../ui/tone";
import { dayTitle, monthTitle, monthWeeks, weekdayNames } from "./days";
import { pkmHref, refreshVault } from "./vault";

const unfolded = defineStored("pkm.calendar", z.boolean(), true);

/** open: the day of the journal open, if one is. */
export function Calendar(props: { pages: readonly PkmPageSummary[]; open: string | undefined }) {
  return (
    <View testID="pkm-calendar" accessibilityLabel={t("web.pkm.calendar.label")} class="gap-1">
      <View
        role="button"
        testID="pkm-calendar-fold"
        accessibilityState={{ expanded: unfolded.get() }}
        onPress={() => unfolded.update((open) => !open)}
        class="group flex-row items-center gap-1"
      >
        <Icon name={unfolded.get() ? "choose" : "expand"} size={12} tone="muted" />
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
    <View class="gap-1">
      <View class="flex-row items-center">
        <Text testID="pkm-calendar-month" class="flex-1 text-xs text-muted">
          {monthTitle(month().year, month().month)}
        </Text>
        <IconButton icon="previous" size={12} label={t("web.pkm.calendar.previous")} testid="pkm-calendar-previous" onClick={() => shift(-1)} />
        <IconButton icon="next" size={12} label={t("web.pkm.calendar.next")} testid="pkm-calendar-next" onClick={() => shift(1)} />
      </View>
      <View class="flex-row">
        <Each of={weekdayNames()}>{(name) => <Text class="flex-1 text-center text-2xs text-faint">{name()}</Text>}</Each>
      </View>
      <Each of={monthWeeks(month().year, month().month)}>
        {(week) => (
          <View class="flex-row">
            <Each of={week()}>
              {(d) => {
                const here = () => d().day === props.open;
                const isToday = () => d().day === today();
                return (
                  <View class="flex-1 items-center">
                    <View
                      role="button"
                      testID="pkm-day-cell"
                      accessibilityLabel={dayTitle(d().day, today())}
                      accessibilityState={{ selected: here(), disabled: act.busy() }}
                      disabled={act.busy()}
                      onPress={() => go(d().day)}
                      class={`h-7 w-7 items-center justify-center rounded-md ${here() ? "bg-selected" : "hover:bg-hover"}`}
                      style={isToday() ? { borderWidth: 1, borderColor: tone("accent") } : undefined}
                    >
                      <Text class={`text-xs ${d().inMonth ? "text-ink" : "text-faint"} ${here() ? "font-semibold" : ""}`}>
                        {String(Number(d().day.slice(8)))}
                      </Text>
                      <If when={journals().has(d().day)}>
                        <View testID="pkm-journal-dot" class="absolute bottom-0.5 h-1 w-1 rounded-full bg-accent" />
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
  );
}
