import * as stylex from "@stylexjs/stylex";
import { createSignal, For, Show } from "solid-js";

import { t } from "@vibevalley/i18n";
import type { PkmPageSummary, PkmTier } from "@vibevalley/protocol";

import { reasonOf } from "#/infra/api.ts";
import { ready } from "#/infra/query.ts";
import { Link as A } from "#/infra/router.ts";
import { Icon } from "#/ui/Icon.tsx";
import type { IconName } from "#/ui/icons.ts";

import { tierOrder } from "./outline";
import { tierLabel } from "./PageView";
import { notesSearch } from "./Search";
import { pkmHref, usePkmRadar } from "./vault";

const viewStyles = stylex.create({
  sidebarSpan: {
    flex: "1",
    textAlign: "left",
  },
  sidebarDiv: {
    display: "flex",
    flexDirection: "column",
    gap: "1px",
  },
  sidebarSpan2: {
    flex: "1",
  },
  sidebarP: {
    paddingInline: "calc(var(--spacing) * 2)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--wb-berry)",
  },
  sidebarSpan3: {
    minWidth: "0",
    flex: "1",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
  },
  sidebarSpan4: {
    flexShrink: "0",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--wb-faint)",
    fontVariantNumeric: "tabular-nums",
  },
  pkmRadar: {
    display: "contents",
  },
  radarSpan: {
    flexShrink: "0",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--wb-faint)",
  },
  radarSpan2: {
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
  },
  radarSpan3: {
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--wb-berry)",
  },
});

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
    <div class="flex min-h-0 flex-1 flex-col gap-4">
      <button
        type="button"
        data-testid="pkm-find"
        onClick={() => notesSearch.open()}
        class="flex h-8 cursor-pointer items-center gap-2 rounded-md border border-line bg-page px-2 text-sm text-faint transition-colors duration-120 hover:border-faint/40 hover:text-muted"
      >
        <Icon name="search" size={14} />
        <span {...stylex.attrs(viewStyles.sidebarSpan)}>{t("web.pkm.list.find")}</span>
      </button>
      <div {...stylex.attrs(viewStyles.sidebarDiv)}>
        <A href="/pkm" data-testid="pkm-today" aria-current={props.slug === undefined ? "page" : undefined} class={row(props.slug === undefined)}>
          <Icon name="calendar" size={14} class={props.slug === undefined ? "text-ink" : "text-faint"} />
          <span {...stylex.attrs(viewStyles.sidebarSpan2)}>{t("web.pkm.list.today")}</span>
        </A>
        <Radar />
      </div>
      <Show when={props.error}>{(e) => <p {...stylex.attrs(viewStyles.sidebarP)}>{reasonOf(e())}</p>}</Show>
      <div class="-mx-2 flex min-h-0 scroll-fade-y flex-col gap-4 overflow-y-auto px-2 pb-2" data-testid="pkm-list">
        <For each={tierOrder.filter((tier) => tier !== "journal" && listed(tier).length > 0)}>
          {(tier) => (
            <section data-testid="pkm-tier" data-key={tier} {...stylex.attrs(viewStyles.sidebarDiv)}>
              <button
                type="button"
                aria-expanded={shut().has(tier) ? "false" : "true"}
                onClick={() => toggle(tier)}
                class="group flex h-6 cursor-pointer items-center gap-1 rounded-md px-2 text-xs font-medium text-faint hover:text-muted"
              >
                {tierLabel(tier)}
                {/* Folded, the arrow stays to say so; open, it comes only when pointed at. */}
                <Icon
                  name={shut().has(tier) ? "next" : "choose"}
                  size={10}
                  class={shut().has(tier) ? "" : "opacity-0 transition-opacity duration-120 group-hover:opacity-100 group-focus-visible:opacity-100"}
                />
              </button>
              <Show when={!shut().has(tier)}>
                <ul {...stylex.attrs(viewStyles.sidebarDiv)}>
                  <For each={listed(tier)} keyed={(p) => p.slug}>
                    {(p) => (
                      <li>
                        <A
                          href={pkmHref(p().slug)}
                          data-testid="pkm-row"
                          data-key={p().slug}
                          aria-current={p().slug === props.slug ? "page" : undefined}
                          class={[row(p().slug === props.slug), "pl-7.5"]}
                        >
                          <span {...stylex.attrs(viewStyles.sidebarSpan3)}>{p().title}</span>
                          <Show when={p().open > 0}>
                            <span {...stylex.attrs(viewStyles.sidebarSpan4)} title={t("web.pkm.list.open", { n: p().open })}>
                              {p().open}
                            </span>
                          </Show>
                        </A>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
            </section>
          )}
        </For>
      </div>
    </div>
  );
}

const row = (here: boolean) => [
  "flex h-7 items-center gap-2 rounded-md px-2 text-sm transition-colors duration-120",
  here ? "bg-selected text-ink" : "text-ink hover:bg-hover",
];

function Radar() {
  const radar = usePkmRadar();
  const [which, setWhich] = createSignal<"stale" | "overdue">();
  const flip = (to: "stale" | "overdue") => setWhich((was) => (was === to ? undefined : to));
  const look = (props: { icon: IconName; label: string; n: number; open?: boolean | undefined; tone?: string; testid: string; click: () => void }) => (
    <button
      type="button"
      data-testid={props.testid}
      aria-expanded={props.open === undefined ? undefined : props.open ? "true" : "false"}
      onClick={() => props.click()}
      class={[row(props.open === true), "cursor-pointer text-left"]}
    >
      <Icon name={props.icon} size={14} class="text-faint" />
      <span {...stylex.attrs(viewStyles.sidebarSpan2)}>{props.label}</span>
      <span class={["text-xs tabular-nums", props.tone ?? "text-faint"]}>{props.n}</span>
    </button>
  );
  return (
    <Show when={ready(radar, undefined)}>
      {(r) => (
        <div data-testid="pkm-radar" {...stylex.attrs(viewStyles.pkmRadar)}>
          <Show when={r().inbox > 0}>
            {look({
              icon: "inbox",
              label: t("web.pkm.radar.inbox"),
              n: r().inbox,
              testid: "pkm-radar-inbox",
              click: () => document.querySelector('[data-testid="pkm-tier"][data-key="inbox"]')?.scrollIntoView({ block: "nearest" }),
            })}
          </Show>
          <Show when={r().stale.length > 0}>
            {look({
              icon: "wait",
              label: t("web.pkm.radar.stale"),
              n: r().stale.length,
              open: which() === "stale",
              testid: "pkm-radar-stale",
              click: () => flip("stale"),
            })}
          </Show>
          <Show when={which() === "stale"}>
            <ul {...stylex.attrs(viewStyles.sidebarDiv)}>
              <For each={r().stale} keyed={(s) => s.slug}>
                {(s) => (
                  <li>
                    <A href={pkmHref(s().slug)} class={[row(false), "pl-7.5"]}>
                      <span {...stylex.attrs(viewStyles.sidebarSpan3)}>{s().title}</span>
                      <span {...stylex.attrs(viewStyles.radarSpan)}>{t("web.pkm.radar.days", { n: s().days })}</span>
                    </A>
                  </li>
                )}
              </For>
            </ul>
          </Show>
          <Show when={r().overdue.length > 0}>
            {look({
              icon: "clock",
              label: t("web.pkm.radar.overdue"),
              n: r().overdue.length,
              open: which() === "overdue",
              // The one count that is a fault, in its colour.
              tone: "text-berry",
              testid: "pkm-radar-overdue",
              click: () => flip("overdue"),
            })}
          </Show>
          <Show when={which() === "overdue"}>
            <ul {...stylex.attrs(viewStyles.sidebarDiv)}>
              <For each={r().overdue} keyed={(o) => o.block}>
                {(o) => (
                  <li>
                    <A href={pkmHref(o().page, o().block)} class="flex flex-col rounded-md py-1 pr-2 pl-7.5 hover:bg-hover">
                      <span {...stylex.attrs(viewStyles.radarSpan2)}>{o().plain}</span>
                      <span {...stylex.attrs(viewStyles.radarSpan3)}>{o().deadline}</span>
                    </A>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </div>
      )}
    </Show>
  );
}
