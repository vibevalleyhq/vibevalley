import { effect, keymap, Scroll, Text, View, type ViewRef } from "nsh";
import { Input } from "nsh/base";

import { t } from "@vibevalley/i18n";
import type { PkmPageSummary, PkmTier } from "@vibevalley/protocol";

import { createAct } from "../../design/act";
import { Icon } from "../../design/Icon";
import type { IconName } from "../../design/icons";
import { ActiveBar, SidebarSection } from "../../design/layout";
import { CountPill } from "../../design/Tag";
import { Bubble } from "../../design/Tip";
import { api, reasonOf } from "../../infra/api";
import { ready, useQueryClient } from "../../infra/query";
import { Link, useRouter } from "../../infra/router";
import { createSignal } from "../../infra/solid";
import { tierOrder } from "./outline";
import { tierLabel } from "./PageView";
import { notesSearch } from "./Search";
import { pkmHref, refreshVault, usePkmRadar } from "./vault";

const row = (here: boolean) =>
  `relative h-7 flex-row items-center gap-2 rounded-md px-2 transition duration-120 ease-out focus-visible:outline-2 focus-visible:outline-focus ${here ? "bg-selected" : "hover:bg-hover"}`;

/** slug: the page open, if any. */
export function Sidebar(props: { slug: string | undefined; pages: readonly PkmPageSummary[]; error?: unknown }) {
  const queries = useQueryClient();
  const router = useRouter();
  const act = createAct();
  const [shut, setShut] = createSignal<ReadonlySet<PkmTier>>(new Set());
  const [creating, setCreating] = createSignal(false);
  const [newTitle, setNewTitle] = createSignal("");
  effect(() => {
    if (!creating()) return;
    return keymap.bind(
      "escape",
      () => {
        setCreating(false);
        setNewTitle("");
      },
      { when: "always" },
    );
  });
  const createPage = () => {
    const title = newTitle().trim();
    if (!title) {
      setCreating(false);
      return undefined;
    }
    return act.run(async () => {
      const page = await api.pkm.page.save({ title, tier: "inbox", markdown: "-\n" });
      setCreating(false);
      setNewTitle("");
      await refreshVault(queries);
      router.navigate(pkmHref(page.slug));
    });
  };
  const listed = (tier: PkmTier) => props.pages.filter((p) => p.tier === tier);
  const shownTiers = () => tierOrder.filter((tier) => tier !== "journal" && listed(tier).length > 0);
  const toggle = (tier: PkmTier) =>
    setShut((was) => {
      const next = new Set(was);
      if (next.has(tier)) next.delete(tier);
      else next.add(tier);
      return next;
    });
  let inbox: ViewRef | undefined;
  return (
    <View class="min-h-0 flex-1 gap-3.5">
      <View class="gap-2">
        <View class="flex-row items-center gap-1.5">
          <View
            role="button"
            testID="pkm-find"
            onPress={() => notesSearch.open()}
            class="group h-8 min-w-0 flex-1 flex-row items-center gap-2 rounded-md border border-line bg-page px-2.5 transition duration-120 ease-out hover:border-faint"
          >
            <Icon name="search" size={14} tone="faint" />
            <Text class="flex-1 truncate text-sm text-faint group-hover:text-muted">{t("web.pkm.list.find")}</Text>
          </View>
          <View
            role="button"
            testID="pkm-new-page"
            accessibilityLabel={t("web.pkm.list.newPage")}
            tooltip={<Bubble text={t("web.pkm.list.newPage")} />}
            onPress={() => {
              setCreating((on) => !on);
              setNewTitle("");
            }}
            class={`h-8 w-8 shrink-0 items-center justify-center rounded-md border transition duration-120 ease-out active:translate-y-px ${creating() ? "border-faint bg-selected" : "border-line bg-page hover:border-faint hover:bg-hover"}`}
          >
            <Icon name="add" size={14} tone={creating() ? "ink" : "muted"} />
          </View>
        </View>
        <If when={creating()}>
          <View class="h-8 flex-row items-center rounded-md border border-focus bg-page px-2.5">
            <Input
              autoFocus
              testID="pkm-new-page-input"
              accessibilityLabel={t("web.pkm.list.newPage")}
              value={newTitle()}
              placeholder={t("web.pkm.list.newPagePlaceholder")}
              onChange={(e) => setNewTitle(e.value)}
              onSubmit={() => void createPage()}
              onBlur={() => {
                if (newTitle().trim() === "") setCreating(false);
              }}
              class="min-w-0 flex-1 text-sm text-ink"
            />
          </View>
        </If>
      </View>
      <View class="gap-px">
        <Link href="/pkm" testID="pkm-today" accessibilityState={{ selected: props.slug === undefined }} class={row(props.slug === undefined)}>
          <If when={props.slug === undefined}>
            <ActiveBar />
          </If>
          <View class="w-3.5 shrink-0 items-center justify-center">
            <Icon name="calendar" size={14} tone={props.slug === undefined ? "ink" : "faint"} />
          </View>
          <Text class="min-w-0 flex-1 truncate text-sm font-medium text-ink">{t("web.pkm.list.today")}</Text>
        </Link>
        <Radar onInbox={() => inbox?.reveal({ vertical: "nearest" })} />
      </View>
      <If when={props.error}>{(e) => <Text class="rounded-md px-2 py-1 text-xs text-berry">{reasonOf(e())}</Text>}</If>
      <Scroll testID="pkm-list" class="-mx-2 min-h-0 flex-1" contentClass="gap-3 px-2 pb-2">
        <If when={shownTiers().length === 0 && props.error === undefined}>
          <Text class="px-2 py-2 text-xs text-faint">{t("web.pkm.list.newPagePlaceholder")}</Text>
        </If>
        <Each of={shownTiers()}>
          {(tier) => {
            const pages = () => listed(tier());
            const folded = () => shut().has(tier());
            return (
              <View ref={(r) => tier() === "inbox" && (inbox = r)} testID={`pkm-tier-${tier()}`} class="gap-px">
                <SidebarSection title={tierLabel(tier())} count={pages().length} open={!folded()} onToggle={() => toggle(tier())} listClass="gap-px">
                  <Each of={pages()} key={(p) => p.slug}>
                    {(p) => {
                      const active = () => p().slug === props.slug;
                      return (
                        <Link
                          href={pkmHref(p().slug)}
                          testID="pkm-row"
                          accessibilityLabel={p().title}
                          accessibilityState={{ selected: active() }}
                          class={`${row(active())} pl-7.5`}
                        >
                          <If when={active()}>
                            <ActiveBar />
                          </If>
                          <Text class="min-w-0 flex-1 truncate text-sm font-medium text-ink">{p().title}</Text>
                          <If when={p().open > 0}>
                            <Text
                              class="shrink-0 text-2xs font-medium text-faint"
                              style={{ fontVariant: ["tabular-nums"] }}
                              accessibilityHint={t("web.pkm.list.open", { n: p().open })}
                            >
                              {String(p().open)}
                            </Text>
                          </If>
                        </Link>
                      );
                    }}
                  </Each>
                </SidebarSection>
              </View>
            );
          }}
        </Each>
      </Scroll>
    </View>
  );
}

function Look(props: { icon: IconName; label: string; n: number; open?: boolean | undefined; danger?: boolean; testid: string; click: () => void }) {
  return (
    <View
      role="button"
      testID={props.testid}
      accessibilityState={props.open === undefined ? undefined : { expanded: props.open }}
      onPress={() => props.click()}
      class={row(props.open === true)}
    >
      <View class="w-3.5 shrink-0 items-center justify-center">
        <Icon name={props.icon} size={14} tone={props.danger === true ? "berry" : props.open === true ? "ink" : "faint"} />
      </View>
      <Text class="min-w-0 flex-1 truncate text-sm font-medium text-ink">{props.label}</Text>
      <If when={props.open !== undefined}>
        <View
          class="shrink-0 items-center justify-center"
          style={{
            transform: [{ rotate: props.open === true ? "90deg" : "0deg" }],
            transitionProperty: "transform",
            transitionDuration: 120,
          }}
        >
          <Icon name="expand" size={10} tone="faint" />
        </View>
      </If>
      <If
        when={props.danger === true}
        else={
          <Text class="shrink-0 text-2xs font-medium text-faint" style={{ fontVariant: ["tabular-nums"] }}>
            {String(props.n)}
          </Text>
        }
      >
        <CountPill count={props.n} tone="bad" />
      </If>
    </View>
  );
}

function Radar(props: { onInbox: () => void }) {
  const radar = usePkmRadar();
  const [which, setWhich] = createSignal<"stale" | "overdue">();
  const flip = (to: "stale" | "overdue") => setWhich((was) => (was === to ? undefined : to));
  return (
    <If when={ready(radar, undefined)}>
      {(r) => (
        <View testID="pkm-radar" class="gap-px">
          <If when={r().inbox > 0}>
            <Look icon="inbox" label={t("web.pkm.radar.inbox")} n={r().inbox} testid="pkm-radar-inbox" click={() => props.onInbox()} />
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
            <View class="gap-px py-0.5">
              <Each of={r().stale} key={(s) => s.slug}>
                {(s) => (
                  <Link href={pkmHref(s().slug)} class={`${row(false)} pl-7.5`}>
                    <Text class="min-w-0 flex-1 truncate text-sm text-ink">{s().title}</Text>
                    <Text class="shrink-0 text-2xs text-faint" style={{ fontVariant: ["tabular-nums"] }}>
                      {t("web.pkm.radar.days", { n: s().days })}
                    </Text>
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
              danger
              testid="pkm-radar-overdue"
              click={() => flip("overdue")}
            />
          </If>
          <If when={which() === "overdue"}>
            <View class="gap-0.5 py-0.5">
              <Each of={r().overdue} key={(o) => o.block}>
                {(o) => (
                  <Link href={pkmHref(o().page, o().block)} class="gap-0.5 rounded-md py-1.5 pr-2 pl-7.5 transition duration-120 ease-out hover:bg-hover">
                    <Text class="truncate text-sm text-ink">{o().plain}</Text>
                    <Text class="text-2xs font-medium text-berry" style={{ fontVariant: ["tabular-nums"] }}>
                      {o().deadline}
                    </Text>
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
