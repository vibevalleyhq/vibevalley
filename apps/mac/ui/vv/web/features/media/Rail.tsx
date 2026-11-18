// Ported from VibeValley apps/web/src/features/media/Rail.tsx: origin and
// file-kind facet filters with cross-filtered counts.
import { Scroll, Text, View, windowSize } from "nsh";

import { t } from "@vibevalley/i18n";

import { Select } from "../../ui/Field";
import { Icon } from "../../ui/Icon";
import type { IconName } from "../../ui/icons";
import { type Counts, type KindFilter, type Names, type Where, whereKey } from "./items";

const originIcons: Record<"generated" | "uploaded" | "fetched", IconName> = {
  generated: "generate",
  uploaded: "upload",
  fetched: "download",
};
const kindIcons: Record<KindFilter, IconName> = {
  all: "media",
  image: "image",
  audio: "audio",
  video: "video",
  other: "file",
};
const kinds: readonly KindFilter[] = ["all", "image", "audio", "video", "other"];

function Row(props: { testid: string; icon: IconName; label: string; count: number; here: boolean; onPick: () => void }) {
  return (
    <View
      role="button"
      testID={props.testid}
      accessibilityLabel={`${props.label} ${props.count}`}
      onPress={() => props.onPick()}
      class={`h-7 shrink-0 flex-row items-center gap-2 rounded-md px-2 ${props.here ? "bg-selected" : "hover:bg-hover"}`}
    >
      <Icon name={props.icon} size={14} tone="muted" />
      <Text class={`min-w-0 flex-1 truncate text-sm text-ink ${props.here ? "font-medium" : ""}`}>{props.label}</Text>
      <Text class="shrink-0 text-xs text-faint">{String(props.count)}</Text>
    </View>
  );
}

export function Rail(props: {
  counts: Counts;
  names: Names;
  where: Where;
  kind: KindFilter;
  onWhere: (where: Where) => void;
  onKind: (kind: KindFilter) => void;
}) {
  const narrow = () => windowSize().width < 640;
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
    <Row testid="library-where" icon={icon} label={label} count={n(whereKey(where))} here={here(where)} onPick={() => props.onWhere(where)} />
  );

  return (
    <If
      when={!narrow()}
      else={
        <View testID="library-rail" class="shrink-0 flex-row gap-2 border-b border-line bg-side p-2">
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
        </View>
      }
    >
      <Scroll testID="library-rail" class="w-52 shrink-0 border-r border-line bg-side" contentClass="gap-5 p-3">
        <View class="gap-0.5">
          <Text class="px-2 pb-1 text-xs font-medium text-faint">{t("web.library.rail.where")}</Text>
          {whereRow({ by: "all" }, "media", t("web.library.origin.all"))}
          <Each of={["generated", "uploaded", "fetched"] as const}>
            {(origin) => whereRow({ by: "origin", origin: origin() }, originIcons[origin()], t(`web.library.origin.${origin()}`))}
          </Each>
        </View>
        <View class="gap-0.5">
          <Text class="px-2 pb-1 text-xs font-medium text-faint">{t("web.library.rail.kind")}</Text>
          <Each of={kinds}>
            {(k) => (
              <Row
                testid="library-kind"
                icon={kindIcons[k()]}
                label={t(`web.library.kind.${k()}`)}
                count={props.counts.kind.get(k()) ?? 0}
                here={props.kind === k()}
                onPick={() => props.onKind(k())}
              />
            )}
          </Each>
        </View>
        <If when={props.counts.channels.length > 0}>
          <View class="gap-0.5">
            <Text class="px-2 pb-1 text-xs font-medium text-faint">{t("web.library.rail.channels")}</Text>
            <Each of={props.counts.channels}>{(channel) => whereRow({ by: "channel", channel: channel() }, "chat", props.names.channel(channel()))}</Each>
          </View>
        </If>
        <If when={props.counts.agents.length > 0}>
          <View class="gap-0.5">
            <Text class="px-2 pb-1 text-xs font-medium text-faint">{t("web.library.rail.agents")}</Text>
            <Each of={props.counts.agents}>{(agent) => whereRow({ by: "agent", agent: agent() }, "agents", props.names.agent(agent()))}</Each>
          </View>
        </If>
      </Scroll>
    </If>
  );
}
