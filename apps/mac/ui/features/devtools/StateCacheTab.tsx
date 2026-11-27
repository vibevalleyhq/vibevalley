import { computed, Scroll, signal, Text, View } from "nsh";

import { t } from "@vibevalley/i18n";
import type { DebugCollabNoteState, DebugStateCache } from "@vibevalley/protocol";

import { Tag } from "../../design/Tag";
import { formatBytes, formatJson, SLICE_NAMES } from "./format";
import { CopyButton, JsonPreview, MetricTile, SectionHeader } from "./shared";

export function StateCacheTab(props: { stateCache: () => DebugStateCache }) {
  const sc = () => props.stateCache();
  const selectedSlice = signal<string>(SLICE_NAMES[0]);
  const selectedCollabId = signal<string | undefined>(undefined);

  const sliceRows = computed(() => {
    const current = sc();
    const known = new Set<string>(SLICE_NAMES);
    const extras = Object.keys(current.sliceSeqs)
      .concat(Object.keys(current.sliceWatchers))
      .filter((k) => !known.has(k));
    const ordered = [...SLICE_NAMES, ...Array.from(new Set(extras)).toSorted()];
    return ordered.map((name) => ({
      name,
      seq: current.sliceSeqs[name] ?? 0,
      watchers: current.sliceWatchers[name] ?? 0,
    }));
  });

  const entityCounts = computed(() => {
    const c = sc().counts;
    return [
      { key: "issues", label: t("web.devtools.state.issues"), value: c.issues },
      { key: "sessions", label: t("web.devtools.state.sessions"), value: c.sessions },
      { key: "channels", label: t("web.devtools.state.channels"), value: c.channels },
      { key: "agents", label: t("web.devtools.state.agents"), value: c.agents },
      { key: "repos", label: t("web.devtools.state.repos"), value: c.repos },
      { key: "notes", label: t("web.devtools.state.notes"), value: c.notes },
      { key: "inbox", label: t("web.devtools.state.inbox"), value: c.inbox },
      { key: "mediaJobs", label: t("web.devtools.state.mediaJobs"), value: c.mediaJobs },
    ] as const;
  });

  const slicePreviewJson = computed(() => {
    const current = sc();
    const name = selectedSlice();
    return formatJson({
      slice: name,
      globalSeq: current.seq,
      seq: current.sliceSeqs[name] ?? 0,
      watchers: current.sliceWatchers[name] ?? 0,
      counts: current.counts,
    });
  });

  const selectedCollab = computed<DebugCollabNoteState | undefined>(() => {
    const items = sc().collab;
    if (items.length === 0) return undefined;
    const id = selectedCollabId();
    return items.find((item) => item.noteId === id) ?? items[0];
  });

  const collabPreviewJson = computed(() => {
    const c = selectedCollab();
    if (!c) return "";
    return formatJson({
      noteId: c.noteId,
      title: c.title,
      noteType: c.noteType,
      seq: c.seq,
      snapshotBytes: c.snapshotBytes,
      frontiers: c.frontiers,
      frontierIds: c.frontierIds,
      versionVector: c.versionVector,
      vvEntries: c.vvEntries,
      ephemeralTtlMs: c.ephemeralTtlMs,
      presence: c.presence,
    });
  });

  return (
    <Scroll testID="devtools-state" class="min-h-0 flex-1" contentClass="gap-4 p-3">
      <View class="flex-row flex-wrap gap-2">
        <MetricTile label={t("web.devtools.state.seq")} value={String(sc().seq)} testID="state-global-seq" />
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
        <SectionHeader title={t("web.devtools.state.caches")} count={sc().caches.length} />
        <If
          when={sc().caches.length > 0}
          else={
            <View class="rounded-md border border-line bg-side px-3 py-2.5">
              <Text class="text-xs text-muted">{t("web.devtools.state.emptyCaches")}</Text>
            </View>
          }
        >
          <View class="overflow-hidden rounded-md border border-line bg-page">
            <Each of={sc().caches} key={(c) => c.name}>
              {(cache, idx) => (
                <View class={`flex-row items-center justify-between gap-2 px-3 py-2 ${idx() > 0 ? "border-t border-line" : ""}`}>
                  <View class="min-w-0 flex-1 gap-0.5">
                    <Text class="truncate font-mono text-xs font-medium text-ink">{cache().name}</Text>
                    <If when={Boolean(cache().detail)}>
                      <Text class="truncate text-2xs text-muted">{cache().detail}</Text>
                    </If>
                  </View>
                  <Tag tone="neutral" label={t("web.devtools.state.entries", { count: cache().entries })} />
                </View>
              )}
            </Each>
          </View>
        </If>
      </View>

      <View testID="state-collab-section" class="gap-2">
        <SectionHeader title={t("web.devtools.state.collab")} count={sc().collab.length} />
        <If
          when={sc().collab.length > 0}
          else={
            <View testID="state-collab-empty" class="rounded-md border border-line bg-side px-3 py-2.5">
              <Text class="text-xs text-muted">{t("web.devtools.state.emptyCollab")}</Text>
            </View>
          }
        >
          <View class="overflow-hidden rounded-md border border-line bg-page">
            <Each of={sc().collab} key={(c) => c.noteId}>
              {(item, idx) => {
                const active = () => selectedCollab()?.noteId === item().noteId;
                return (
                  <View
                    role="button"
                    testID={`state-collab-${item().noteId}`}
                    accessibilityState={{ selected: active() }}
                    onPress={() => selectedCollabId.set(item().noteId)}
                    class={`gap-1.5 px-3 py-2.5 ${idx() > 0 ? "border-t border-line" : ""} ${active() ? "bg-selected" : "hover:bg-hover"}`}
                  >
                    <View class="flex-row flex-wrap items-center justify-between gap-2">
                      <View class="min-w-0 flex-1 flex-row items-center gap-1.5">
                        <Text class="truncate text-xs font-medium text-ink">{item().title || item().noteId}</Text>
                        <Tag tone="neutral" label={item().noteType} />
                      </View>
                      <View class="flex-row items-center gap-1.5">
                        <Tag tone="info" label={`seq ${item().seq}`} />
                        <Tag tone="neutral" label={formatBytes(item().snapshotBytes)} />
                        <Tag tone={item().presenceCount > 0 ? "ok" : "neutral"} label={`${item().presenceCount} peers`} />
                      </View>
                    </View>
                    <View class="flex-row flex-wrap items-center gap-2">
                      <Text class="font-mono text-2xs text-muted">
                        {t("web.devtools.state.frontiers")}:{" "}
                        {item()
                          .frontierIds.map((id) => `${id.peerId}:${id.counter}`)
                          .join(", ") ||
                          item().frontiers ||
                          "∅"}
                      </Text>
                      <Text class="font-mono text-2xs text-faint">
                        VV:{" "}
                        {item()
                          .vvEntries.map((vv) => `${vv.peerId}=${vv.counter}`)
                          .join(" ") ||
                          item().versionVector ||
                          "∅"}
                      </Text>
                      <Tag tone="neutral" label={t("web.devtools.state.ttl", { ms: item().ephemeralTtlMs })} />
                    </View>
                  </View>
                );
              }}
            </Each>
          </View>

          <If when={selectedCollab() !== undefined}>
            <View testID="state-collab-detail" class="gap-2 rounded-md border border-line bg-side p-3">
              <View class="flex-row flex-wrap items-center justify-between gap-2">
                <Text class="text-xs font-semibold text-ink">{t("web.devtools.state.presence")}</Text>
                <View class="flex-row items-center gap-1.5">
                  <If when={Boolean(selectedCollab()!.frontiers)}>
                    <CopyButton text={selectedCollab()!.frontiers} label={t("web.devtools.state.frontiers")} testID="state-collab-copy-frontiers" />
                  </If>
                  <If when={Boolean(selectedCollab()!.versionVector)}>
                    <CopyButton text={selectedCollab()!.versionVector} label="VV" testID="state-collab-copy-vv" />
                  </If>
                </View>
              </View>
              <If when={selectedCollab()!.presence.length > 0} else={<Text class="text-xs text-muted">{t("web.devtools.state.noPeers")}</Text>}>
                <View class="gap-1">
                  <Each of={selectedCollab()!.presence} key={(peer) => peer.id}>
                    {(peer) => (
                      <View
                        testID={`state-collab-peer-${peer().id}`}
                        class="flex-row flex-wrap items-center gap-2 rounded-sm border border-line bg-page px-2.5 py-1.5"
                      >
                        <Tag tone="ok" label={peer().kind} />
                        <Text class="text-xs font-medium text-ink">{peer().name}</Text>
                        <Text class="font-mono text-2xs text-muted">{peer().id}</Text>
                        <If when={Boolean(peer().path)}>
                          <Text class="font-mono text-2xs text-water">{peer().path}</Text>
                        </If>
                        <If when={Boolean(peer().nodeId)}>
                          <Text class="font-mono text-2xs text-muted">#{peer().nodeId}</Text>
                        </If>
                        <If when={peer().offset !== undefined}>
                          <Text class="font-mono text-2xs text-faint">
                            @{peer().offset}
                            {peer().endOffset !== undefined ? `..${peer().endOffset}` : ""}
                          </Text>
                        </If>
                      </View>
                    )}
                  </Each>
                </View>
              </If>
              <JsonPreview content={collabPreviewJson()} testID="state-collab-json" copyTestID="state-collab-copy" />
            </View>
          </If>
        </If>
      </View>
    </Scroll>
  );
}
