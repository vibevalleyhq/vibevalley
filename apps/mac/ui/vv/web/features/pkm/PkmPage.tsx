import { Scroll, Text, View } from "nsh";

import { t } from "@vibevalley/i18n";
import type { PkmPageSummary } from "@vibevalley/protocol";

import { createEffect, createSignal } from "../../../solid";
import { Keyed } from "../../base/dom";
import { createExternal } from "../../base/external";
import { api } from "../../infra/api";
import { localDay } from "../../infra/localDay";
import { ready, useQueryClient } from "../../infra/query";
import { Link, useSearch } from "../../infra/router";
import { createAct } from "../../ui/act";
import { Icon } from "../../ui/Icon";
import { Calendar } from "./Calendar";
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
    <View testID="pkm" class="h-full min-h-0 flex-1 lg:flex-row">
      <View
        accessibilityLabel={t("web.pkm.list.label")}
        testID="pkm-nav"
        class={`min-h-0 shrink-0 border-line bg-side p-3 lg:flex lg:w-64 lg:border-r ${nav() ? "flex-1" : "hidden"}`}
      >
        <Sidebar slug={slug()} pages={pages()} error={vault.error()} />
      </View>
      <View class={`min-h-0 min-w-0 flex-1 bg-page ${nav() ? "hidden lg:flex" : ""}`}>
        <If when={slug()} else={<Days pages={pages()} />}>
          {(s) => (
            <Keyed key={s()}>
              {() => (
                <Scroll class="min-h-0 flex-1" contentClass="min-h-full">
                  <Opened slug={s()} pages={pages()} point={search().get("b") ?? undefined} />
                </Scroll>
              )}
            </Keyed>
          )}
        </If>
      </View>
    </View>
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
    <Scroll testID="pkm-days" accessibilityState={{ busy: act.busy() }} class="min-h-0 flex-1" contentClass="min-h-full xl:flex-row xl:items-stretch">
      <View class="mx-auto w-full max-w-3xl min-w-0 gap-6 px-5 py-5 xl:flex-1">
        <View class="lg:hidden">
          <Link
            href="/pkm?nav"
            class="group h-7 flex-row items-center gap-1.5 self-start rounded-md border border-line bg-page px-2.5 transition duration-120 ease-out hover:border-faint hover:bg-hover active:translate-y-px"
          >
            <Icon name="calendar" size={14} tone="muted" />
            <Text class="text-sm text-muted group-hover:text-ink">{t("web.pkm.list.label")}</Text>
          </Link>
        </View>
        <If when={opened()}>{(slug) => <Opened slug={slug()} pages={props.pages} compact />}</If>
        <Each of={before()} key={(p) => p.slug}>
          {(p) => <Opened slug={p().slug} pages={props.pages} compact />}
        </Each>
      </View>
      <View
        accessibilityLabel={t("web.pkm.rail.label")}
        class="mx-auto w-full max-w-3xl border-t border-line bg-side px-4 py-4 xl:mx-0 xl:w-72 xl:shrink-0 xl:border-t-0 xl:border-l"
      >
        <Calendar pages={props.pages} open={today()} />
      </View>
    </Scroll>
  );
}
