import * as stylex from "@stylexjs/stylex";
import { createSignal, For, onSettled, Show } from "solid-js";

import { t } from "@vibevalley/i18n";
import type { PkmPageSummary } from "@vibevalley/protocol";

import { Keyed } from "#/base/dom.tsx";
import { api } from "#/infra/api.ts";
import { ready, useQueryClient } from "#/infra/query.ts";
import { useSearch, Link as A } from "#/infra/router.ts";
import { createAct } from "#/ui/act.ts";
import { Icon } from "#/ui/Icon.tsx";

import { Calendar } from "./Calendar";
import { dayKey } from "./days";
import { Opened } from "./PageView";
import { Sidebar } from "./Sidebar";
import { refreshVault, usePkmVault } from "./vault";

const viewStyles = stylex.create({
  pkmPageDiv: {
    display: "flex",
    height: "100%",
    minHeight: "0",
    flexDirection: {
      default: "column",
      "@media (width>=64rem)": "row",
    },
  },
  daysDiv: {
    marginInline: "auto",
    display: "flex",
    width: "100%",
    maxWidth: "var(--container-3xl)",
    minWidth: "0",
    flexDirection: "column",
    gap: "calc(var(--spacing) * 6)",
    paddingInline: "calc(var(--spacing) * 4)",
    paddingBlock: "calc(var(--spacing) * 4)",
  },
  daysDiv2: {
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
      "@media (width>=80rem)": "calc(var(--spacing) * 72)",
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
    borderColor: "var(--wb-line)",
    paddingInline: "calc(var(--spacing) * 4)",
    paddingBlock: "calc(var(--spacing) * 4)",
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
    <div {...stylex.attrs(viewStyles.pkmPageDiv)}>
      <nav
        aria-label={t("web.pkm.list.label")}
        data-testid="pkm-nav"
        class={[nav() ? "flex" : "hidden lg:flex", "min-h-0 shrink-0 flex-col border-line bg-side p-3 lg:w-64 lg:border-r"]}
      >
        <Sidebar slug={slug()} pages={pages()} error={vault.error} />
      </nav>
      <main class={[nav() ? "hidden lg:flex" : "flex", "min-h-0 min-w-0 flex-1 flex-col"]}>
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
  const today = dayKey(Date.now());
  const act = createAct();
  const [opened, setOpened] = createSignal<string>();
  onSettled(() => {
    void act.run(async () => {
      setOpened((await api.pkm.journal.open({ day: today })).slug);
      void refreshVault(queries);
    });
  });
  const before = () =>
    props.pages
      .filter((p) => p.day !== undefined && p.day < today)
      .toSorted((a, b) => (b.day ?? "").localeCompare(a.day ?? ""))
      .slice(0, daysShown);
  return (
    <div data-testid="pkm-days" class="flex min-h-0 flex-1 flex-col overflow-y-auto xl:flex-row xl:items-start">
      <div {...stylex.attrs(viewStyles.daysDiv)}>
        <div {...stylex.attrs(viewStyles.daysDiv2)}>
          <A href="/pkm?nav" class="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-sm text-muted hover:bg-hover hover:text-ink">
            <Icon name="calendar" size={14} />
            {t("web.pkm.list.label")}
          </A>
        </div>
        <Show when={opened()}>{(slug) => <Opened slug={slug()} pages={props.pages} compact />}</Show>
        <For each={before()} keyed={(p) => p.slug}>
          {(p) => <Opened slug={p().slug} pages={props.pages} compact />}
        </For>
      </div>
      <aside aria-label={t("web.pkm.rail.label")} {...stylex.attrs(viewStyles.daysAside)}>
        <Calendar pages={props.pages} open={today} />
      </aside>
    </div>
  );
}
