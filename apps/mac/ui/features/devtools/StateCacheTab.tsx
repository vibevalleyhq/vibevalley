import { computed, Scroll, signal, Text, View } from "nsh";

import { t } from "@vibevalley/i18n";
import type { DebugStateCache } from "@vibevalley/protocol";

import { Tag } from "../../design/Tag";
import { formatJson, SLICE_NAMES } from "./format";
import { JsonPreview, MetricTile, SectionHeader } from "./shared";

export function StateCacheTab(props: { stateCache: DebugStateCache }) {
  const selectedSlice = signal<string>(SLICE_NAMES[0]);

  const sliceRows = computed(() => {
    const sc = props.stateCache;
    const known = new Set<string>(SLICE_NAMES);
    const extras = Object.keys(sc.sliceSeqs)
      .concat(Object.keys(sc.sliceWatchers))
      .filter((k) => !known.has(k));
    const ordered = [...SLICE_NAMES, ...Array.from(new Set(extras)).toSorted()];
    return ordered.map((name) => ({
      name,
      seq: sc.sliceSeqs[name] ?? 0,
      watchers: sc.sliceWatchers[name] ?? 0,
    }));
  });

  const entityCounts = computed(() => {
    const c = props.stateCache.counts;
    return [
      { key: "issues", label: t("web.devtools.state.issues"), value: c.issues },
      { key: "sessions", label: t("web.devtools.state.sessions"), value: c.sessions },
      { key: "channels", label: t("web.devtools.state.channels"), value: c.channels },
      { key: "agents", label: t("web.devtools.state.agents"), value: c.agents },
      { key: "repos", label: t("web.devtools.state.repos"), value: c.repos },
      { key: "artifacts", label: t("web.devtools.state.artifacts"), value: c.artifacts },
      { key: "inbox", label: t("web.devtools.state.inbox"), value: c.inbox },
      { key: "mediaJobs", label: t("web.devtools.state.mediaJobs"), value: c.mediaJobs },
    ] as const;
  });

  const slicePreviewJson = computed(() => {
    const sc = props.stateCache;
    const name = selectedSlice();
    return formatJson({
      slice: name,
      globalSeq: sc.seq,
      seq: sc.sliceSeqs[name] ?? 0,
      watchers: sc.sliceWatchers[name] ?? 0,
      counts: sc.counts,
    });
  });

  return (
    <Scroll testID="devtools-state" class="min-h-0 flex-1" contentClass="gap-4 p-3">
      <View class="flex-row flex-wrap gap-2">
        <MetricTile label={t("web.devtools.state.seq")} value={String(props.stateCache.seq)} testID="state-global-seq" />
      </View>

      <View class="gap-2">
        <SectionHeader title={t("web.devtools.state.slices")} count={sliceRows().length} />
        <View class="overflow-hidden rounded-md border border-line bg-page">
          <Each of={sliceRows()} key={(row) => row.name}>
            {(row, idx) => {
              const active = () => selectedSlice() === row().name;
              return (
                <View
                  role="button"
                  testID={`state-slice-${row().name}`}
                  accessibilityState={{ selected: active() }}
                  onPress={() => selectedSlice.set(row().name)}
                  class={`flex-row items-center justify-between gap-2 px-3 py-2 ${idx() > 0 ? "border-t border-line" : ""} ${
                    active() ? "bg-selected" : "hover:bg-hover"
                  }`}
                >
                  <Text class="font-mono text-xs font-medium text-ink">{row().name}</Text>
                  <View class="flex-row items-center gap-2">
                    <Text class="font-mono text-2xs tabular-nums text-muted">seq {row().seq}</Text>
                    <Tag tone={row().watchers > 0 ? "ok" : "neutral"} label={t("web.devtools.state.watchers", { count: row().watchers })} />
                  </View>
                </View>
              );
            }}
          </Each>
        </View>

        <JsonPreview content={slicePreviewJson()} testID="state-slice-preview" copyTestID="state-slice-copy" />
      </View>

      <View class="gap-2">
        <SectionHeader title={t("web.devtools.state.counts")} />
        <View class="flex-row flex-wrap gap-2">
          <Each of={entityCounts()} key={(item) => item.key}>
            {(item) => <MetricTile label={item().label} value={String(item().value)} testID={`state-count-${item().key}`} />}
          </Each>
        </View>
      </View>

      <View class="gap-2">
        <SectionHeader title={t("web.devtools.state.caches")} count={props.stateCache.caches.length} />
        <If
          when={props.stateCache.caches.length > 0}
          else={
            <View class="rounded-md border border-line bg-side px-3 py-2.5">
              <Text class="text-xs text-muted">{t("web.devtools.state.emptyCaches")}</Text>
            </View>
          }
        >
          <View class="overflow-hidden rounded-md border border-line bg-page">
            <Each of={props.stateCache.caches} key={(c) => c.name}>
              {(cache, idx) => (
                <View class={`flex-row items-center justify-between gap-2 px-3 py-2 ${idx() > 0 ? "border-t border-line" : ""}`}>
                  <View class="min-w-0 flex-1 gap-0.5">
                    <Text class="truncate font-mono text-xs font-medium text-ink">{cache().name}</Text>
                    <If when={cache().detail}>{(detail) => <Text class="truncate text-2xs text-muted">{detail()}</Text>}</If>
                  </View>
                  <Tag tone="neutral" label={t("web.devtools.state.entries", { count: cache().entries })} />
                </View>
              )}
            </Each>
          </View>
        </If>
      </View>
    </Scroll>
  );
}
