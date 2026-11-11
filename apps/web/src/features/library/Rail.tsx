import * as stylex from "@stylexjs/stylex";
import { Array as Arr } from "effect";
import { For, Show } from "solid-js";

import { t } from "@vibevalley/i18n";

import { Select } from "#/ui/Field.tsx";
import { Icon } from "#/ui/Icon.tsx";
import type { IconName } from "#/ui/icons.ts";

import { type Counts, type KindFilter, type Names, type Where, whereKey } from "./items.ts";

const styles = stylex.create({
  rail: {
    gridArea: "rail",
    display: "flex",
    flexShrink: 0,
    flexDirection: { default: "column", "@media (width < 40rem)": "row" },
    gap: { default: "1.25rem", "@media (width < 40rem)": "0.75rem" },
    width: { default: "13rem", "@media (width < 40rem)": "auto" },
    overflowX: "hidden",
    overflowY: { default: "auto", "@media (width < 40rem)": "visible" },
    borderRightWidth: { default: 1, "@media (width < 40rem)": 0 },
    borderBottomWidth: { default: 0, "@media (width < 40rem)": 1 },
    borderStyle: "solid",
    borderColor: "var(--color-line)",
    backgroundColor: "var(--color-side)",
    padding: { default: "0.75rem", "@media (width < 40rem)": "0.5rem" },
  },
  // On a phone the groups give way to two selects: a row of every choice would run past the screen's edge.
  group: {
    display: { default: "flex", "@media (width < 40rem)": "none" },
    flexShrink: 0,
    flexDirection: { default: "column", "@media (width < 40rem)": "row" },
    gap: { default: "1px", "@media (width < 40rem)": "0.25rem" },
  },
  narrow: { display: { default: "none", "@media (width < 40rem)": "flex" }, minWidth: 0, flex: 1, gap: "0.5rem" },
  select: { minWidth: 0, flex: 1 },
  heading: {
    display: { default: "block", "@media (width < 40rem)": "none" },
    paddingInline: "0.5rem",
    paddingBottom: "0.25rem",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    fontWeight: "var(--font-weight-medium)",
    color: "var(--color-faint)",
  },
  row: {
    display: "flex",
    height: "1.75rem",
    flexShrink: 0,
    cursor: "pointer",
    alignItems: "center",
    gap: "0.5rem",
    borderRadius: "var(--radius-md)",
    paddingInline: "0.5rem",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
    whiteSpace: "nowrap",
    textAlign: "start",
    color: "var(--color-ink)",
    transitionProperty: "background-color",
    transitionDuration: "120ms",
    transitionTimingFunction: "var(--ease-out)",
  },
  idle: {
    backgroundColor: { default: null, "@media (hover: hover)": { default: null, ":hover": "var(--color-hover)" } },
  },
  here: { backgroundColor: "var(--color-selected)", fontWeight: "var(--font-weight-medium)" },
  icon: { flexShrink: 0, color: "var(--color-muted)" },
  label: { minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis" },
  count: {
    flexShrink: 0,
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    fontVariantNumeric: "tabular-nums",
    color: "var(--color-faint)",
  },
});

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
      {...stylex.attrs(styles.row, props.here ? styles.here : styles.idle)}
    >
      <Icon name={props.icon} size={14} styles={styles.icon} />
      <span {...stylex.attrs(styles.label)}>{props.label}</span>
      <span {...stylex.attrs(styles.count)}>{props.count}</span>
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
      ...Arr.map(["generated", "uploaded", "fetched"] as const, (origin) => ({
        where: { by: "origin", origin } as const,
        label: t(`web.library.origin.${origin}`),
      })),
      ...Arr.map(props.counts.channels, (channel) => ({ where: { by: "channel", channel } as const, label: names.channel(channel) })),
      ...Arr.map(props.counts.agents, (agent) => ({ where: { by: "agent", agent } as const, label: names.agent(agent) })),
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
    <nav aria-label={t("web.library.rail.label")} data-testid="library-rail" {...stylex.attrs(styles.rail)}>
      <div role="group" aria-label={t("web.library.rail.where")} {...stylex.attrs(styles.group)}>
        <p {...stylex.attrs(styles.heading)}>{t("web.library.rail.where")}</p>
        {whereRow({ by: "all" }, "media", t("web.library.origin.all"))}
        <For each={["generated", "uploaded", "fetched"] as const}>
          {(origin) => whereRow({ by: "origin", origin: origin }, originIcons[origin], t(`web.library.origin.${origin}`))}
        </For>
      </div>
      <div role="group" aria-label={t("web.library.rail.kind")} {...stylex.attrs(styles.group)}>
        <p {...stylex.attrs(styles.heading)}>{t("web.library.rail.kind")}</p>
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
      <Show when={Arr.isReadonlyArrayNonEmpty(props.counts.channels)}>
        <div role="group" aria-label={t("web.library.rail.channels")} {...stylex.attrs(styles.group)}>
          <p {...stylex.attrs(styles.heading)}>{t("web.library.rail.channels")}</p>
          <For each={props.counts.channels}>{(channel) => whereRow({ by: "channel", channel: channel }, "chat", props.names.channel(channel))}</For>
        </div>
      </Show>
      <Show when={Arr.isReadonlyArrayNonEmpty(props.counts.agents)}>
        <div role="group" aria-label={t("web.library.rail.agents")} {...stylex.attrs(styles.group)}>
          <p {...stylex.attrs(styles.heading)}>{t("web.library.rail.agents")}</p>
          <For each={props.counts.agents}>{(agent) => whereRow({ by: "agent", agent: agent }, "agents", props.names.agent(agent))}</For>
        </div>
      </Show>
      <div {...stylex.attrs(styles.narrow)}>
        <Select
          label={t("web.library.rail.where")}
          testid="library-where-select"
          size="control"
          value={whereKey(props.where)}
          onChange={(key) => {
            const found = Arr.findFirst(wheres(), (w) => whereKey(w.where) === key);
            if (found._tag === "Some") props.onWhere(found.value.where);
          }}
          options={Arr.map(wheres(), (w) => ({
            value: whereKey(w.where),
            label: `${w.where.by === "all" ? t("web.library.rail.anyWhere") : w.label} · ${n(whereKey(w.where))}`,
          }))}
          styles={styles.select}
        />
        <Select
          label={t("web.library.rail.kind")}
          testid="library-kind-select"
          size="control"
          value={props.kind}
          onChange={props.onKind}
          options={Arr.map(kinds, (kind) => ({
            value: kind,
            label: `${kind === "all" ? t("web.library.rail.anyKind") : t(`web.library.kind.${kind}`)} · ${props.counts.kind.get(kind) ?? 0}`,
          }))}
          styles={styles.select}
        />
      </div>
    </nav>
  );
}
