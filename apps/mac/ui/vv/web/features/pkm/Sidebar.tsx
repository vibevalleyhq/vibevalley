// Ported from VibeValley apps/web/src/features/pkm/Sidebar.tsx: find, today,
// the radar (inbox, stale pages, overdue blocks), the pages by tier, each
// tier folding. The list's fading edges are not ported (no mask images).
import { Scroll, Text, View } from "nsh";

import { t } from "@vibevalley/i18n";
import type { PkmPageSummary, PkmTier } from "@vibevalley/protocol";

import { createSignal } from "../../../solid";
import { reasonOf } from "../../infra/api";
import { ready } from "../../infra/query";
import { Link } from "../../infra/router";
import { Icon } from "../../ui/Icon";
import type { IconName } from "../../ui/icons";
import { tierOrder } from "./outline";
import { tierLabel } from "./PageView";
import { notesSearch } from "./Search";
import { pkmHref, usePkmRadar } from "./vault";

const row = (here: boolean) => `h-7 flex-row items-center gap-2 rounded-md px-2 ${here ? "bg-selected" : "hover:bg-hover"}`;

/** slug: the page open, if any. */
export function Sidebar(props: { slug: string | undefined; pages: readonly PkmPageSummary[]; error?: unknown }) {
  const [shut, setShut] = createSignal<ReadonlySet<PkmTier>>(new Set());
  const listed = (tier: PkmTier) => props.pages.filter((p) => p.tier === tier);
  const toggle = (tier: PkmTier) =>
    setShut((was) => {
      const next = new Set(was);
      if (next.has(tier)) next.delete(tier);
      else next.add(tier);
      return next;
    });
  return (
    <View class="min-h-0 flex-1 gap-4">
      <View
        role="button"
        testID="pkm-find"
        onPress={() => notesSearch.open()}
        class="group h-8 flex-row items-center gap-2 rounded-md border border-line bg-page px-2 hover:border-faint"
      >
        <Icon name="search" size={14} tone="faint" />
        <Text class="flex-1 text-sm text-faint group-hover:text-muted">{t("web.pkm.list.find")}</Text>
      </View>
      <View class="gap-px">
        <Link href="/pkm" testID="pkm-today" accessibilityState={{ selected: props.slug === undefined }} class={row(props.slug === undefined)}>
          <Icon name="calendar" size={14} tone={props.slug === undefined ? "ink" : "faint"} />
          <Text class="flex-1 text-sm text-ink">{t("web.pkm.list.today")}</Text>
        </Link>
        <Radar />
      </View>
      <If when={props.error}>{(e) => <Text class="px-2 text-xs text-berry">{reasonOf(e())}</Text>}</If>
      <Scroll testID="pkm-list" class="-mx-2 min-h-0 flex-1" contentClass="gap-4 px-2 pb-2">
        <Each of={tierOrder.filter((tier) => tier !== "journal" && listed(tier).length > 0)}>
          {(tier) => (
            <View testID={`pkm-tier-${tier()}`} class="gap-px">
              <View
                role="button"
                accessibilityState={{ expanded: !shut().has(tier()) }}
                onPress={() => toggle(tier())}
                class="group h-6 flex-row items-center gap-1 rounded-md px-2"
              >
                <Text class="text-xs font-medium text-faint group-hover:text-muted">{tierLabel(tier())}</Text>
                {/* Folded, the arrow stays to say so; open, it comes only when pointed at. */}
                <View class={shut().has(tier()) ? "" : "opacity-0 group-hover:opacity-100"}>
                  <Icon name={shut().has(tier()) ? "next" : "choose"} size={10} tone="faint" />
                </View>
              </View>
              <If when={!shut().has(tier())}>
                <View class="gap-px">
                  <Each of={listed(tier())} key={(p) => p.slug}>
                    {(p) => (
                      <Link
                        href={pkmHref(p().slug)}
                        testID="pkm-row"
                        accessibilityLabel={p().title}
                        accessibilityState={{ selected: p().slug === props.slug }}
                        class={`${row(p().slug === props.slug)} pl-7.5`}
                      >
                        <Text class="min-w-0 flex-1 truncate text-sm text-ink">{p().title}</Text>
                        <If when={p().open > 0}>
                          <Text class="shrink-0 text-xs text-faint" accessibilityHint={t("web.pkm.list.open", { n: p().open })}>
                            {String(p().open)}
                          </Text>
                        </If>
                      </Link>
                    )}
                  </Each>
                </View>
              </If>
            </View>
          )}
        </Each>
      </Scroll>
    </View>
  );
}

function Look(props: { icon: IconName; label: string; n: number; open?: boolean | undefined; tone?: string; testid: string; click: () => void }) {
  return (
    <View
      role="button"
      testID={props.testid}
      accessibilityState={props.open === undefined ? undefined : { expanded: props.open }}
      onPress={() => props.click()}
      class={row(props.open === true)}
    >
      <Icon name={props.icon} size={14} tone="faint" />
      <Text class="flex-1 text-sm text-ink">{props.label}</Text>
      <Text class={`text-xs ${props.tone ?? "text-faint"}`}>{String(props.n)}</Text>
    </View>
  );
}

function Radar() {
  const radar = usePkmRadar();
  const [which, setWhich] = createSignal<"stale" | "overdue">();
  const flip = (to: "stale" | "overdue") => setWhich((was) => (was === to ? undefined : to));
  return (
    <If when={ready(radar, undefined)}>
      {(r) => (
        <View testID="pkm-radar" class="gap-px">
          <If when={r().inbox > 0}>
            <Look icon="inbox" label={t("web.pkm.radar.inbox")} n={r().inbox} testid="pkm-radar-inbox" click={() => undefined} />
          </If>
          <If when={r().stale.length > 0}>
            <Look
              icon="wait"
              label={t("web.pkm.radar.stale")}
              n={r().stale.length}
              open={which() === "stale"}
              testid="pkm-radar-stale"
              click={() => flip("stale")}
            />
          </If>
          <If when={which() === "stale"}>
            <View class="gap-px">
              <Each of={r().stale} key={(s) => s.slug}>
                {(s) => (
                  <Link href={pkmHref(s().slug)} class={`${row(false)} pl-7.5`}>
                    <Text class="min-w-0 flex-1 truncate text-sm text-ink">{s().title}</Text>
                    <Text class="shrink-0 text-xs text-faint">{t("web.pkm.radar.days", { n: s().days })}</Text>
                  </Link>
                )}
              </Each>
            </View>
          </If>
          <If when={r().overdue.length > 0}>
            <Look
              icon="clock"
              label={t("web.pkm.radar.overdue")}
              n={r().overdue.length}
              open={which() === "overdue"}
              // The one count that is a fault, in its colour.
              tone="text-berry"
              testid="pkm-radar-overdue"
              click={() => flip("overdue")}
            />
          </If>
          <If when={which() === "overdue"}>
            <View class="gap-px">
              <Each of={r().overdue} key={(o) => o.block}>
                {(o) => (
                  <Link href={pkmHref(o().page, o().block)} class="rounded-md py-1 pr-2 pl-7.5 hover:bg-hover">
                    <Text class="truncate text-sm text-ink">{o().plain}</Text>
                    <Text class="text-xs text-berry">{o().deadline}</Text>
                  </Link>
                )}
              </Each>
            </View>
          </If>
        </View>
      )}
    </If>
  );
}
