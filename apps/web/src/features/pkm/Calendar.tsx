import * as stylex from "@stylexjs/stylex";
import { Schema } from "effect";
import { createMemo, createSignal, For, Show } from "solid-js";

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

const styles = stylex.create({
  monthButton: {
    position: "relative",
    marginInline: "auto",
    display: "flex",
    width: "calc(var(--spacing) * 7)",
    height: "calc(var(--spacing) * 7)",
    cursor: "pointer",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: "var(--radius-md)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
  },
  monthButtonPrimary: {
    color: "var(--color-faint)",
  },
  monthButtonSecondary: {
    color: "var(--color-ink)",
  },
  monthButtonStateA: {
    backgroundColor: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-hover)",
      },
    },
    fontWeight: null,
  },
  monthButtonStateB: {
    backgroundColor: "var(--color-selected)",
    fontWeight: "var(--font-weight-semibold)",
  },
  monthButtonModeA: {
    boxShadow: null,
  },
  monthButtonModeB: {
    boxShadow: "0 0 0 1px var(--color-accent)",
  },
  pkmCalendar: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--spacing)",
  },
  pkmCalendarFold: {
    display: "flex",
    cursor: "pointer",
    alignItems: "center",
    gap: "var(--spacing)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    fontWeight: "var(--font-weight-semibold)",
    color: {
      default: "var(--color-muted)",
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-ink)",
      },
    },
  },
  monthDiv: {
    display: "flex",
    alignItems: "center",
  },
  monthSpan: {
    flex: "1",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--color-muted)",
  },
  monthDiv2: {
    display: "grid",
    gridTemplateColumns: "repeat(7,minmax(0,1fr))",
    textAlign: "center",
    fontSize: "var(--text-2xs)",
    lineHeight: "var(--text-2xs--line-height)",
    color: "var(--color-faint)",
  },
  monthDiv3: {
    display: "grid",
    gridTemplateColumns: "repeat(7,minmax(0,1fr))",
  },
  monthSpan2: {
    clipPath: "inset(50%)",
    whiteSpace: "nowrap",
    borderWidth: "0",
    width: "1px",
    height: "1px",
    margin: "-1px",
    padding: "0",
    position: "absolute",
    overflow: "hidden",
  },
  monthSpan3: {
    position: "absolute",
    bottom: "calc(var(--spacing) * .5)",
    width: "var(--spacing)",
    height: "var(--spacing)",
    borderRadius: "2147483647px",
    backgroundColor: "var(--color-accent)",
  },
});

const unfolded = defineStored("pkm.calendar", Schema.Boolean, true);

/** open: the day of the journal open, if one is. */
export function Calendar(props: { pages: readonly PkmPageSummary[]; open: string | undefined }) {
  return (
    <section data-testid="pkm-calendar" aria-label={t("web.pkm.calendar.label")} {...stylex.attrs(styles.pkmCalendar)}>
      <button
        type="button"
        data-testid="pkm-calendar-fold"
        aria-expanded={unfolded.get() ? "true" : "false"}
        onClick={() => unfolded.update((open) => !open)}
        {...stylex.attrs(styles.pkmCalendarFold)}
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
    <div {...stylex.attrs(styles.pkmCalendar)}>
      <div {...stylex.attrs(styles.monthDiv)}>
        <span data-testid="pkm-calendar-month" data-year={month().year} data-month={month().month + 1} {...stylex.attrs(styles.monthSpan)}>
          {monthTitle(month().year, month().month)}
        </span>
        <IconButton icon="previous" size={12} label={t("web.pkm.calendar.previous")} testid="pkm-calendar-previous" onClick={() => shift(-1)} />
        <IconButton icon="next" size={12} label={t("web.pkm.calendar.next")} testid="pkm-calendar-next" onClick={() => shift(1)} />
      </div>
      <div {...stylex.attrs(styles.monthDiv2)}>
        <For each={weekdayNames()}>{(name) => <span>{name}</span>}</For>
      </div>
      <For each={monthWeeks(month().year, month().month)}>
        {(week) => (
          <div {...stylex.attrs(styles.monthDiv3)}>
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
                  {...stylex.attrs(
                    styles.monthButton,
                    d.inMonth ? styles.monthButtonSecondary : styles.monthButtonPrimary,
                    d.day === props.open ? styles.monthButtonStateB : styles.monthButtonStateA,
                    d.day === today() ? styles.monthButtonModeB : styles.monthButtonModeA,
                  )}
                >
                  {Number(d.day.slice(8))}
                  <span {...stylex.attrs(styles.monthSpan2)}>{dayTitle(d.day, today())}</span>
                  <Show when={journals().has(d.day)}>
                    <span aria-hidden="true" {...stylex.attrs(styles.monthSpan3)} />
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
