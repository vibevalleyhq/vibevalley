import { For, Show } from "solid-js";

import { t } from "@vibevalley/i18n";

import { Select } from "#/ui/Field.tsx";
import { Icon } from "#/ui/Icon.tsx";
import type { IconName } from "#/ui/icons.ts";

import { type Counts, type KindFilter, type Names, type Where, whereKey } from "./items.ts";

const originIcons: Record<"generated" | "uploaded" | "fetched", IconName> = { generated: "generate", uploaded: "upload", fetched: "download" };
const kindIcons: Record<KindFilter, IconName> = { all: "media", image: "image", audio: "audio", video: "video", other: "file" };
const kinds: readonly KindFilter[] = ["all", "image", "audio", "video", "other"];

function Row(props: { testid: string; dataKey: string; icon: IconName; label: string; count: number; here: boolean; onPick: () => void }) {
  return (
    <button
      type="button"
      data-testid={props.testid}
      data-key={props.dataKey}
      aria-pressed={props.here ? "true" : "false"}
      onClick={() => props.onPick()}
      class={[
        "flex h-7 shrink-0 cursor-pointer items-center gap-2 rounded-md px-2 text-sm whitespace-nowrap text-start text-ink transition-[background-color] duration-120 ease-out",
        props.here ? "bg-selected font-medium" : "hover:bg-hover",
      ]}
    >
      <Icon name={props.icon} size={14} class="shrink-0 text-muted" />
      <span class="min-w-0 flex-1 overflow-hidden text-ellipsis">{props.label}</span>
      <span class="shrink-0 text-xs tabular-nums text-faint">{props.count}</span>
    </button>
  );
}

/** The library's filters, Eagle-like: where a file came from and what kind it is, each with how many it holds. The
 * quietest column of the page; on a phone a row that scrolls sideways. */
export function Rail(props: {
  counts: Counts;
  names: Names;
  where: Where;
  kind: KindFilter;
  onWhere: (where: Where) => void;
  onKind: (kind: KindFilter) => void;
}) {
  const here = (where: Where) => whereKey(where) === whereKey(props.where);
  const wheres = (): readonly { readonly where: Where; readonly label: string }[] => {
    const names = props.names;
    return [
      { where: { by: "all" }, label: t("web.library.origin.all") },
      ...(["generated", "uploaded", "fetched"] as const).map((origin) => ({
        where: { by: "origin", origin } as const,
        label: t(`web.library.origin.${origin}`),
      })),
      ...props.counts.channels.map((channel) => ({ where: { by: "channel", channel } as const, label: names.channel(channel) })),
      ...props.counts.agents.map((agent) => ({ where: { by: "agent", agent } as const, label: names.agent(agent) })),
    ];
  };
  const n = (key: string) => props.counts.where.get(key) ?? 0;
  const whereRow = (where: Where, icon: IconName, label: string) => (
    <Row
      testid="library-where"
      dataKey={whereKey(where)}
      icon={icon}
      label={label}
      count={n(whereKey(where))}
      here={here(where)}
      onPick={() => props.onWhere(where)}
    />
  );
  return (
    <nav
      aria-label={t("web.library.rail.label")}
      data-testid="library-rail"
      class="[grid-area:rail] flex shrink-0 flex-col max-sm:flex-row gap-5 max-sm:gap-3 w-52 max-sm:w-auto overflow-x-hidden overflow-y-auto max-sm:overflow-y-visible border-r max-sm:border-r-0 border-b-0 max-sm:border-b border-line bg-side p-3 max-sm:p-2"
    >
      <div role="group" aria-label={t("web.library.rail.where")} class="flex max-sm:hidden shrink-0 flex-col max-sm:flex-row gap-px max-sm:gap-1">
        <p class="block max-sm:hidden px-2 pb-1 text-xs font-medium text-faint">{t("web.library.rail.where")}</p>
        {whereRow({ by: "all" }, "media", t("web.library.origin.all"))}
        <For each={["generated", "uploaded", "fetched"] as const}>
          {(origin) => whereRow({ by: "origin", origin: origin }, originIcons[origin], t(`web.library.origin.${origin}`))}
        </For>
      </div>
      <div role="group" aria-label={t("web.library.rail.kind")} class="flex max-sm:hidden shrink-0 flex-col max-sm:flex-row gap-px max-sm:gap-1">
        <p class="block max-sm:hidden px-2 pb-1 text-xs font-medium text-faint">{t("web.library.rail.kind")}</p>
        <For each={kinds}>
          {(kind) => (
            <Row
              testid="library-kind"
              dataKey={kind}
              icon={kindIcons[kind]}
              label={t(`web.library.kind.${kind}`)}
              count={props.counts.kind.get(kind) ?? 0}
              here={props.kind === kind}
              onPick={() => props.onKind(kind)}
            />
          )}
        </For>
      </div>
      <Show when={props.counts.channels.length > 0}>
        <div role="group" aria-label={t("web.library.rail.channels")} class="flex max-sm:hidden shrink-0 flex-col max-sm:flex-row gap-px max-sm:gap-1">
          <p class="block max-sm:hidden px-2 pb-1 text-xs font-medium text-faint">{t("web.library.rail.channels")}</p>
          <For each={props.counts.channels}>{(channel) => whereRow({ by: "channel", channel: channel }, "chat", props.names.channel(channel))}</For>
        </div>
      </Show>
      <Show when={props.counts.agents.length > 0}>
        <div role="group" aria-label={t("web.library.rail.agents")} class="flex max-sm:hidden shrink-0 flex-col max-sm:flex-row gap-px max-sm:gap-1">
          <p class="block max-sm:hidden px-2 pb-1 text-xs font-medium text-faint">{t("web.library.rail.agents")}</p>
          <For each={props.counts.agents}>{(agent) => whereRow({ by: "agent", agent: agent }, "agents", props.names.agent(agent))}</For>
        </div>
      </Show>
      <div class="hidden max-sm:flex min-w-0 flex-1 gap-2">
        <Select
          label={t("web.library.rail.where")}
          testid="library-where-select"
          size="control"
          value={whereKey(props.where)}
          onChange={(key) => {
            const found = wheres().find((w) => whereKey(w.where) === key);
            if (found) props.onWhere(found.where);
          }}
          options={wheres().map((w) => ({
            value: whereKey(w.where),
            label: `${w.where.by === "all" ? t("web.library.rail.anyWhere") : w.label} · ${n(whereKey(w.where))}`,
          }))}
          class="min-w-0 flex-1"
        />
        <Select
          label={t("web.library.rail.kind")}
          testid="library-kind-select"
          size="control"
          value={props.kind}
          onChange={props.onKind}
          options={kinds.map((kind) => ({
            value: kind,
            label: `${kind === "all" ? t("web.library.rail.anyKind") : t(`web.library.kind.${kind}`)} · ${props.counts.kind.get(kind) ?? 0}`,
          }))}
          class="min-w-0 flex-1"
        />
      </div>
    </nav>
  );
}
