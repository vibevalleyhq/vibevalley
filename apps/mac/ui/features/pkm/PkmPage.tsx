import { Scroll, View } from "nsh";

import type { PkmPageSummary } from "@vibevalley/protocol";

import { createAct } from "../../design/act";
import { api } from "../../infra/api";
import { Keyed } from "../../infra/base/dom";
import { createExternal } from "../../infra/base/external";
import { ready, useQueryClient } from "../../infra/query";
import { useSearch } from "../../infra/router";
import { createEffect, createSignal } from "../../infra/solid";
import { localDay } from "./localDay";
import { Opened } from "./PageView";
import { refreshVault, usePkmVault } from "./vault";

/** `rest` is the path after /pkm/: a page's slug. */
export function PkmPage(props: { rest: string }) {
  const vault = usePkmVault();
  const search = useSearch();
  const slug = () => (props.rest ? decodeURIComponent(props.rest.split("?")[0] ?? "") : undefined);
  const pages = () => ready(vault, undefined)?.pages ?? [];
  return (
    <View testID="pkm" class="h-full min-h-0 min-w-0 flex-1 bg-page">
      <If when={slug()} else={<TodayNote pages={pages()} />}>
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
  );
}

function TodayNote(props: { pages: readonly PkmPageSummary[] }) {
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
  return (
    <Scroll testID="pkm-today-view" accessibilityState={{ busy: act.busy() }} class="min-h-0 flex-1" contentClass="min-h-full">
      <If when={opened()}>{(slug) => <Keyed key={slug()}>{() => <Opened slug={slug()} pages={props.pages} />}</Keyed>}</If>
    </Scroll>
  );
}
