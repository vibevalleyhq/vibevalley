import { Scroll, signal, Text, View, windowSize, type JSX } from "nsh";

import { t } from "@vibevalley/i18n";

import { Select } from "../../design/Field";
import { Icon } from "../../design/Icon";
import type { IconName } from "../../design/icons";
import { ActiveBar, SidebarSection } from "../../design/layout";
import { CountPill } from "../../design/Tag";
import { type ArtifactCounts, artifactFilterKinds, type ArtifactKindFilter, type Counts, type KindFilter, type Names, type Where, whereKey } from "./items";

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
const artifactKindIcons: Record<ArtifactKindFilter, IconName> = {
  all: "artifacts",
  canvas: "appearance",
  slides: "present",
  dashboard: "catalog",
  whiteboard: "idea",
  page: "web",
};
const artifactKinds: readonly ArtifactKindFilter[] = ["all", ...artifactFilterKinds];

function FacetSection(props: { id: string; title: string; count: number; hasActive?: boolean; children: JSX.Element }) {
  const open = signal(true);
  return (
    <SidebarSection
      testID={`library-section-${props.id}`}
      toggleTestID={`library-section-toggle-${props.id}`}
      title={props.title}
      open={open()}
      onToggle={() => open.set(!open())}
      count={open() ? undefined : props.count}
      collapsedBadge={
        <If when={props.hasActive === true}>
          <View class="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
        </If>
      }
    >
      {props.children}
    </SidebarSection>
  );
}

function Row(props: { testid: string; icon: IconName; label: string; count: number; here: boolean; onPick: () => void }) {
  return (
    <View
      role="button"
      testID={props.testid}
      accessibilityLabel={`${props.label} ${props.count}`}
      accessibilityState={{ selected: props.here }}
      onPress={() => props.onPick()}
      class={`relative h-7 shrink-0 flex-row items-center gap-2 rounded-md px-2 transition duration-120 ease-out focus-visible:outline-2 focus-visible:outline-focus ${props.here ? "bg-selected" : "hover:bg-hover"}`}
    >
      <If when={props.here}>
        <ActiveBar />
      </If>
      <View class="w-3.5 shrink-0 items-center justify-center">
        <Icon name={props.icon} size={14} tone={props.here ? "ink" : "muted"} />
      </View>
      <Text class={`min-w-0 flex-1 truncate text-sm font-medium ${props.here ? "text-ink" : "text-muted"}`}>{props.label}</Text>
      <CountPill count={props.count} active={props.here} quiet hoverBright />
    </View>
  );
}

export function Rail(props: {
  counts: Counts;
  names: Names;
  where: Where;
  kind: KindFilter;
  artifactKind?: ArtifactKindFilter | undefined;
  artifactCounts?: ArtifactCounts | undefined;
  onWhere: (where: Where) => void;
  onKind: (kind: KindFilter) => void;
  onArtifactKind?: ((kind: ArtifactKindFilter | undefined) => void) | undefined;
}) {
  const narrow = () => windowSize().width < 640;
  const inArtifacts = () => props.artifactKind !== undefined;
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
  const artifactCount = (k: ArtifactKindFilter) => (k === "all" ? (props.artifactCounts?.all ?? 0) : (props.artifactCounts?.byKind[k] ?? 0));
  const whereRow = (where: Where, icon: IconName, label: string) => (
    <Row testid="library-where" icon={icon} label={label} count={n(whereKey(where))} here={here(where)} onPick={() => props.onWhere(where)} />
  );

  return (
    <If
      when={!narrow()}
      else={
        <View testID="library-rail" class="shrink-0 flex-row items-center gap-2 border-b border-line bg-side px-3 py-2">
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
            value={inArtifacts() ? `artifact:${props.artifactKind}` : props.kind}
            onChange={(v) => {
              if (v.startsWith("artifact:")) {
                const ak = artifactKinds.find((item) => item === v.slice("artifact:".length));
                if (ak !== undefined) props.onArtifactKind?.(ak);
              } else {
                const k = kinds.find((item) => item === v);
                if (k !== undefined) {
                  props.onArtifactKind?.(undefined);
                  props.onKind(k);
                }
              }
            }}
            options={[
              ...kinds.map((kind) => ({
                value: kind,
                label: `${kind === "all" ? t("web.library.rail.anyKind") : t(`web.library.kind.${kind}`)} · ${props.counts.kind.get(kind) ?? 0}`,
              })),
              ...(props.onArtifactKind !== undefined
                ? artifactKinds.map((ak) => ({
                    value: `artifact:${ak}`,
                    label: `${t(`web.library.artifactKind.${ak}`)} · ${artifactCount(ak)}`,
                  }))
                : []),
            ]}
            class="min-w-0 flex-1"
          />
        </View>
      }
    >
      <Scroll testID="library-rail" class="w-56 shrink-0 border-r border-line bg-side" contentClass="gap-3 px-3 pt-3 pb-3">
        <FacetSection id="where" title={t("web.library.rail.where")} count={n("all")} hasActive={props.where.by === "origin"}>
          {whereRow({ by: "all" }, "media", t("web.library.origin.all"))}
          <Each of={["generated", "uploaded", "fetched"] as const}>
            {(origin) => whereRow({ by: "origin", origin: origin() }, originIcons[origin()], t(`web.library.origin.${origin()}`))}
          </Each>
        </FacetSection>
        <FacetSection id="kind" title={t("web.library.rail.kind")} count={props.counts.kind.get("all") ?? 0} hasActive={!inArtifacts() && props.kind !== "all"}>
          <Each of={kinds}>
            {(k) => (
              <Row
                testid="library-kind"
                icon={kindIcons[k()]}
                label={t(`web.library.kind.${k()}`)}
                count={props.counts.kind.get(k()) ?? 0}
                here={!inArtifacts() && props.kind === k()}
                onPick={() => {
                  props.onArtifactKind?.(undefined);
                  props.onKind(k());
                }}
              />
            )}
          </Each>
        </FacetSection>
        <If when={props.onArtifactKind !== undefined}>
          <FacetSection id="artifacts" title={t("web.library.rail.artifacts")} count={artifactCount("all")} hasActive={inArtifacts()}>
            <Each of={artifactKinds}>
              {(ak) => (
                <Row
                  testid={`library-artifact-kind-${ak()}`}
                  icon={artifactKindIcons[ak()]}
                  label={t(`web.library.artifactKind.${ak()}`)}
                  count={artifactCount(ak())}
                  here={props.artifactKind === ak()}
                  onPick={() => props.onArtifactKind?.(ak())}
                />
              )}
            </Each>
          </FacetSection>
        </If>
        <If when={props.counts.channels.length > 0}>
          <FacetSection id="channels" title={t("web.library.rail.channels")} count={props.counts.channels.length} hasActive={props.where.by === "channel"}>
            <Each of={props.counts.channels}>{(channel) => whereRow({ by: "channel", channel: channel() }, "chat", props.names.channel(channel()))}</Each>
          </FacetSection>
        </If>
        <If when={props.counts.agents.length > 0}>
          <FacetSection id="agents" title={t("web.library.rail.agents")} count={props.counts.agents.length} hasActive={props.where.by === "agent"}>
            <Each of={props.counts.agents}>{(agent) => whereRow({ by: "agent", agent: agent() }, "agents", props.names.agent(agent()))}</Each>
          </FacetSection>
        </If>
      </Scroll>
    </If>
  );
}
