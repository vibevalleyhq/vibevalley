import * as stylex from "@stylexjs/stylex";
import { createEffect, createSignal, For, Show } from "solid-js";

import { t } from "@vibevalley/i18n";
import type { PkmPageSummary } from "@vibevalley/protocol";

import { Keyed } from "#/base/dom.tsx";
import { createExternal } from "#/base/external.ts";
import { api } from "#/infra/api.ts";
import { localDay } from "#/infra/local-day.ts";
import { ready, useQueryClient } from "#/infra/query.ts";
import { useSearch, Link as A } from "#/infra/router.ts";
import { createAct } from "#/ui/act.ts";
import { Icon } from "#/ui/Icon.tsx";

import { Calendar } from "./Calendar";
import { Opened } from "./PageView";
import { Sidebar } from "./Sidebar";
import { refreshVault, usePkmVault } from "./vault";

const styles = stylex.create({
  daysA: {
    display: "inline-flex",
    alignItems: "center",
    gap: "0.375rem",
    borderRadius: "var(--radius-md)",
    paddingInline: "0.5rem",
    paddingBlock: "0.25rem",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
    color: {
      default: "var(--color-muted)",
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-ink)",
      },
    },
    backgroundColor: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-hover)",
      },
    },
  },
  pkmPageNav: {
    minHeight: "0",
    flexShrink: "0",
    flexDirection: "column",
    borderColor: "var(--color-line)",
    backgroundColor: "var(--color-side)",
    padding: "0.75rem",
    width: {
      default: null,
      "@media (width>=64rem)": "16rem",
    },
    borderRightStyle: {
      default: null,
      "@media (width>=64rem)": "solid",
    },
    borderRightWidth: {
      default: null,
      "@media (width>=64rem)": "1px",
    },
  },
  pkmPageNavTone: {
    display: "flex",
  },
  pkmPageNavAlt: {
    display: {
      default: "none",
      "@media (width>=64rem)": "flex",
    },
  },
  pkmPageMain: {
    minHeight: "0",
    minWidth: "0",
    flex: "1",
    flexDirection: "column",
  },
  daysDiv: {
    display: "flex",
    minHeight: "0",
    flex: "1",
    flexDirection: {
      default: "column",
      "@media (width>=80rem)": "row",
    },
    overflowY: "auto",
    alignItems: {
      default: null,
      "@media (width>=80rem)": "flex-start",
    },
  },
  pkmPageDiv: {
    display: "flex",
    height: "100%",
    minHeight: "0",
    flexDirection: {
      default: "column",
      "@media (width>=64rem)": "row",
    },
  },
  daysDiv2: {
    marginInline: "auto",
    display: "flex",
    width: "100%",
    maxWidth: "var(--container-3xl)",
    minWidth: "0",
    flexDirection: "column",
    gap: "1.5rem",
    paddingInline: "1rem",
    paddingBlock: "1rem",
  },
  daysDiv22: {
    display: {
      default: null,
      "@media (width>=64rem)": "none",
    },
  },
  daysAside: {
    marginInline: {
      default: "auto",
      "@media (width>=80rem)": "0",
    },
    width: {
      default: "100%",
      "@media (width>=80rem)": "18rem",
    },
    maxWidth: "var(--container-3xl)",
    borderTopStyle: {
      default: "solid",
      "@media (width>=80rem)": "solid",
    },
    borderTopWidth: {
      default: "1px",
      "@media (width>=80rem)": "0",
    },
    borderColor: "var(--color-line)",
    paddingInline: "1rem",
    paddingBlock: "1rem",
    position: {
      default: null,
      "@media (width>=80rem)": "sticky",
    },
    top: {
      default: null,
      "@media (width>=80rem)": "0",
    },
    flexShrink: {
      default: null,
      "@media (width>=80rem)": "0",
    },
    borderLeftStyle: {
      default: null,
      "@media (width>=80rem)": "solid",
    },
    borderLeftWidth: {
      default: null,
      "@media (width>=80rem)": "1px",
    },
  },
});

/** `rest` is the path after /pkm/: a page's slug. */
export function PkmPage(props: { rest: string }) {
  const vault = usePkmVault();
  const search = useSearch();
  const slug = () => (props.rest ? decodeURIComponent(props.rest.split("?")[0] ?? "") : undefined);
  const pages = () => ready(vault, undefined)?.pages ?? [];
  const nav = () => search().has("nav");
  return (
    <div {...stylex.attrs(styles.pkmPageDiv)}>
      <nav
        aria-label={t("web.pkm.list.label")}
        data-testid="pkm-nav"
        {...stylex.attrs(styles.pkmPageNav, nav() ? styles.pkmPageNavTone : styles.pkmPageNavAlt)}
      >
        <Sidebar slug={slug()} pages={pages()} error={vault.error} />
      </nav>
      <main {...stylex.attrs(styles.pkmPageMain, nav() ? styles.pkmPageNavAlt : styles.pkmPageNavTone)}>
        <Show when={slug()} fallback={<Days pages={pages()} />}>
          {(s) => <Keyed key={s()}>{() => <Opened slug={s()} pages={pages()} point={search().get("b") ?? undefined} />}</Keyed>}
        </Show>
      </main>
    </div>
  );
}

/** How many days before today the stream shows. */
const daysShown = 5;

/** Today's journal first (made if there is none), to write in at once; then the earlier days that have one. */
function Days(props: { pages: readonly PkmPageSummary[] }) {
  const queries = useQueryClient();
  const today = createExternal(localDay.subscribe, localDay.get);
  const act = createAct();
  const [opened, setOpened] = createSignal<string>();
  createEffect(
    () => today(),
    (day) => {
      let active = true;
      setOpened(undefined);
      void act.run(async () => {
        const page = await api.pkm.journal.open({ day });
        if (!active) return;
        setOpened(page.slug);
        void refreshVault(queries);
      });
      return () => {
        active = false;
      };
    },
  );
  const before = () =>
    props.pages
      .filter((p) => p.day !== undefined && p.day < today())
      .toSorted((a, b) => (b.day ?? "").localeCompare(a.day ?? ""))
      .slice(0, daysShown);
  return (
    <div data-testid="pkm-days" aria-busy={act.busy() ? "true" : "false"} {...stylex.attrs(styles.daysDiv)}>
      <div {...stylex.attrs(styles.daysDiv2)}>
        <div {...stylex.attrs(styles.daysDiv22)}>
          <A href="/pkm?nav" {...stylex.attrs(styles.daysA)}>
            <Icon name="calendar" size={14} />
            {t("web.pkm.list.label")}
          </A>
        </div>
        <Show when={opened()}>{(slug) => <Opened slug={slug()} pages={props.pages} compact />}</Show>
        <For each={before()} keyed={(p) => p.slug}>
          {(p) => <Opened slug={p().slug} pages={props.pages} compact />}
        </For>
      </div>
      <aside aria-label={t("web.pkm.rail.label")} {...stylex.attrs(styles.daysAside)}>
        <Calendar pages={props.pages} open={today()} />
      </aside>
    </div>
  );
}
