import { createMemo, createSignal, For, Show } from "solid-js";
import { z } from "zod";

import { t } from "@vibevalley/i18n";
import type { PkmPageSummary } from "@vibevalley/protocol";

import { createExternal } from "#/base/external.ts";
import { api } from "#/infra/api.ts";
import { localDay } from "#/infra/local-day.ts";
import { useQueryClient } from "#/infra/query.ts";
import { useRouter } from "#/infra/router.ts";
import { defineStored } from "#/state/stored.ts";
import { createAct } from "#/ui/act.ts";
import { Icon } from "#/ui/Icon.tsx";
import { IconButton } from "#/ui/IconButton.tsx";

import { dayTitle, monthTitle, monthWeeks, weekdayNames } from "./days";
import { pkmHref, refreshVault } from "./vault";

const unfolded = defineStored("pkm.calendar", z.boolean(), true);

/** open: the day of the journal open, if one is. */
export function Calendar(props: { pages: readonly PkmPageSummary[]; open: string | undefined }) {
  return (
    <section data-testid="pkm-calendar" aria-label={t("web.pkm.calendar.label")} class="flex flex-col gap-1">
      <button
        type="button"
        data-testid="pkm-calendar-fold"
        aria-expanded={unfolded.get() ? "true" : "false"}
        onClick={() => unfolded.update((open) => !open)}
        class="flex cursor-pointer items-center gap-1 text-xs font-semibold text-muted hover:text-ink"
      >
        <Icon name={unfolded.get() ? "choose" : "expand"} size={12} />
        {t("web.pkm.calendar.label")}
      </button>
      <Show when={unfolded.get()}>
        <Month pages={props.pages} open={props.open} />
      </Show>
    </section>
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
    <div class="flex flex-col gap-1">
      <div class="flex items-center">
        <span data-testid="pkm-calendar-month" data-year={month().year} data-month={month().month + 1} class="flex-1 text-xs text-muted">
          {monthTitle(month().year, month().month)}
        </span>
        <IconButton icon="previous" size={12} label={t("web.pkm.calendar.previous")} testid="pkm-calendar-previous" onClick={() => shift(-1)} />
        <IconButton icon="next" size={12} label={t("web.pkm.calendar.next")} testid="pkm-calendar-next" onClick={() => shift(1)} />
      </div>
      <div class="grid grid-cols-7 text-center text-2xs text-faint">
        <For each={weekdayNames()}>{(name) => <span>{name}</span>}</For>
      </div>
      <For each={monthWeeks(month().year, month().month)}>
        {(week) => (
          <div class="grid grid-cols-7">
            <For each={week}>
              {(d) => (
                <button
                  type="button"
                  data-testid="pkm-day-cell"
                  data-key={d.day}
                  data-today={d.day === today() ? "" : undefined}
                  data-journal={journals().has(d.day) ? "" : undefined}
                  aria-current={d.day === props.open ? "date" : undefined}
                  disabled={act.busy()}
                  onClick={() => go(d.day)}
                  class={[
                    "relative mx-auto flex w-7 h-7 cursor-pointer flex-col items-center justify-center rounded-md text-xs",
                    d.inMonth ? "text-ink" : "text-faint",
                    d.day === props.open ? "bg-selected font-semibold" : "hover:bg-hover",
                    d.day === today() ? "[box-shadow:0_0_0_1px_var(--color-accent)]" : "",
                  ]}
                >
                  {Number(d.day.slice(8))}
                  <span class="[clip-path:inset(50%)] whitespace-nowrap border-0 w-px h-px -m-px p-0 absolute overflow-hidden">{dayTitle(d.day, today())}</span>
                  <Show when={journals().has(d.day)}>
                    <span aria-hidden="true" class="absolute bottom-0.5 w-1 h-1 rounded-full bg-accent" />
                  </Show>
                </button>
              )}
            </For>
          </div>
        )}
      </For>
    </div>
  );
}
