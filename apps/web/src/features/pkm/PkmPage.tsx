import { createSignal, For, onSettled, Show } from "solid-js";

import { t } from "@vibevalley/i18n";
import type { PkmPageSummary } from "@vibevalley/protocol";

import { Keyed } from "@/base/dom";
import { api } from "@/infra/api";
import { ready } from "@/infra/query";
import { useSearch } from "@/infra/router";
import { A } from "@/ui/A";
import { createAct } from "@/ui/act";
import { Icon } from "@/ui/Icon";

import { Calendar } from "./Calendar";
import { dayKey } from "./days";
import { Opened } from "./PageView";
import { Sidebar } from "./Sidebar";
import { refreshVault, usePkmVault } from "./vault";

/** `rest` is the path after /pkm/: a page's slug. */
export function PkmPage(props: { rest: string }) {
  const vault = usePkmVault();
  const search = useSearch();
  const slug = () => (props.rest ? decodeURIComponent(props.rest.split("?")[0] ?? "") : undefined);
  const pages = () => ready(vault, undefined)?.pages ?? [];
  const nav = () => search().has("nav");
  return (
    <div class="flex h-full min-h-0 flex-col lg:flex-row">
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
  const today = dayKey(Date.now());
  const act = createAct();
  const [opened, setOpened] = createSignal<string>();
  onSettled(() => {
    void act.run(async () => {
      setOpened((await api.pkm.journal.open({ day: today })).slug);
      void refreshVault();
    });
  });
  const before = () =>
    props.pages
      .filter((p) => p.day !== undefined && p.day < today)
      .toSorted((a, b) => (b.day ?? "").localeCompare(a.day ?? ""))
      .slice(0, daysShown);
  return (
    <div data-testid="pkm-days" class="flex min-h-0 flex-1 flex-col overflow-y-auto xl:flex-row xl:items-start">
      <div class="mx-auto flex w-full max-w-3xl min-w-0 flex-col gap-6 px-4 py-4">
        <div class="lg:hidden">
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
      <aside
        aria-label={t("web.pkm.rail.label")}
        class="mx-auto w-full max-w-3xl border-t border-line px-4 py-4 xl:sticky xl:top-0 xl:mx-0 xl:w-72 xl:shrink-0 xl:border-t-0 xl:border-l"
      >
        <Calendar pages={props.pages} open={today} />
      </aside>
    </div>
  );
}
