import { effect, Scroll, signal, Text, untracked, View } from "nsh";

import { t } from "@vibevalley/i18n";
import { type Agent, type Artifact, type ArtifactHistoryEntry, type ArtifactHistoryPreviewResult, userId } from "@vibevalley/protocol";

import { createAct } from "../../design/act";
import { Button } from "../../design/Button";
import { hexColor, swatches } from "../../design/domain/cast";
import { Icon } from "../../design/Icon";
import { IconButton } from "../../design/IconButton";
import { Bubble } from "../../design/Tip";
import { toast } from "../../design/toasts";
import { tone } from "../../design/tone";
import { api, reasonOf } from "../../infra/api";
import { useNow } from "../../infra/base/dom";
import { ago } from "../../infra/base/format";
import { ready, useAgents, useQueryClient } from "../../infra/query";
import { createMemo } from "../../infra/solid";

export interface TimelineBarProps {
  readonly artifact: Artifact;
  readonly activeFrontiers: string | undefined;
  readonly onPreview: (preview: ArtifactHistoryPreviewResult | undefined) => void;
  readonly onMutated: (next: Artifact) => void;
  readonly onForked: (forked: Artifact) => void;
  readonly onClose: () => void;
}

function actorDotColor(entry: ArtifactHistoryEntry, agent: Agent | undefined): string {
  if (entry.author === userId) return tone("ink");
  if (agent?.look.trim) return hexColor(agent.look.trim);
  const key = entry.sessionId ?? entry.agent ?? entry.author;
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) & 0x7fffffff;
  const trim = swatches.trim[h % swatches.trim.length];
  return trim === undefined ? tone("accent") : hexColor(trim);
}

export function TimelineBar(props: TimelineBarProps) {
  const queries = useQueryClient();
  const now = useNow();
  const allAgents = useAgents();
  const agents = createMemo(() => new Map(ready(allAgents, []).map((a) => [a.id, a])));

  const entries = signal<readonly ArtifactHistoryEntry[]>([]);
  const loading = signal(true);
  const loadError = signal<string | undefined>(undefined);
  const selectedIndex = signal<number | undefined>(undefined);
  const previewAct = createAct();
  const mutateAct = createAct();

  const chronological = createMemo(() => entries().toReversed());
  const selectedEntry = createMemo(() => {
    const idx = selectedIndex();
    const list = chronological();
    if (idx === undefined) return list.at(-1);
    return list[idx];
  });
  const isHistorical = createMemo(() => {
    const list = chronological();
    const idx = selectedIndex();
    return idx !== undefined && list.length > 0 && idx < list.length - 1;
  });

  let loadRun = 0;
  const loadHistory = async () => {
    const run = ++loadRun;
    loading.set(true);
    loadError.set(undefined);
    try {
      const list = await api.artifact.history.list({ id: props.artifact.id, limit: 100 });
      if (run !== loadRun) return;
      entries.set(list);
      const active = props.activeFrontiers;
      const rev = list.toReversed();
      const matched = active ? rev.findIndex((e) => e.frontiers === active) : -1;
      selectedIndex.set(matched >= 0 ? matched : rev.length > 0 ? rev.length - 1 : undefined);
      loading.set(false);
    } catch (e) {
      if (run !== loadRun) return;
      loadError.set(reasonOf(e));
      loading.set(false);
    }
  };

  effect(() => {
    const _id = props.artifact.id;
    const _seq = props.artifact.seq;
    const _ver = props.artifact.version;
    void _id;
    void _seq;
    void _ver;
    void loadHistory();
  });

  const selectCommit = (idx: number) => {
    const list = chronological();
    if (idx < 0 || idx >= list.length) return;
    selectedIndex.set(idx);
    if (idx === list.length - 1) {
      props.onPreview(undefined);
      return;
    }
    const target = list.at(idx);
    if (target === undefined) return;
    void previewAct.run(async () => {
      const snap = await api.artifact.history.preview({ id: props.artifact.id, frontiers: target.frontiers });
      if (untracked(selectedIndex) === idx) {
        props.onPreview(snap);
      }
    });
  };

  const backToLive = () => {
    const list = chronological();
    selectedIndex.set(list.length > 0 ? list.length - 1 : undefined);
    props.onPreview(undefined);
  };

  const restoreSelected = () => {
    const entry = selectedEntry();
    if (!entry) return;
    void mutateAct.run(async () => {
      const updated = await api.artifact.history.restore({
        id: props.artifact.id,
        frontiers: entry.frontiers,
        ...(entry.summary ? { note: entry.summary } : {}),
      });
      await queries.invalidate({ prefix: ["artifacts"] });
      props.onPreview(undefined);
      props.onMutated(updated);
      toast(t("web.artifact.timeline.restored"));
      await loadHistory();
    });
  };

  const forkSelected = () => {
    const entry = selectedEntry();
    if (!entry) return;
    void mutateAct.run(async () => {
      const forked = await api.artifact.history.fork({
        id: props.artifact.id,
        frontiers: entry.frontiers,
        title: t("web.artifact.timeline.forkTitle", { title: props.artifact.title }),
      });
      await queries.invalidate({ prefix: ["artifacts"] });
      props.onPreview(undefined);
      toast(t("web.artifact.timeline.forked", { title: forked.title }));
      props.onForked(forked);
    });
  };

  const undoSelectedOrigin = () => {
    const entry = selectedEntry();
    if (!entry?.origin) return;
    void mutateAct.run(async () => {
      const updated = await api.artifact.history.undoOrigin({
        id: props.artifact.id,
        origin: entry.origin,
      });
      await queries.invalidate({ prefix: ["artifacts"] });
      props.onPreview(undefined);
      props.onMutated(updated);
      toast(t("web.artifact.timeline.undoneOrigin"));
      await loadHistory();
    });
  };

  const compactHistory = () => {
    void mutateAct.run(async () => {
      const updated = await api.artifact.history.compact({ id: props.artifact.id });
      await queries.invalidate({ prefix: ["artifacts"] });
      props.onPreview(undefined);
      props.onMutated(updated);
      toast(t("web.artifact.timeline.compacted"));
      await loadHistory();
    });
  };

  const authorName = (entry: ArtifactHistoryEntry): string => {
    if (entry.author === userId) return t("web.artifact.blocks.user");
    const agent = agents().get(entry.agent ?? entry.author);
    return agent?.name ?? entry.agent ?? entry.author;
  };

  const currentIdx = createMemo(() => selectedIndex() ?? Math.max(0, chronological().length - 1));
  const canPrev = createMemo(() => chronological().length > 1 && currentIdx() > 0 && !previewAct.busy() && !mutateAct.busy());
  const canNext = createMemo(() => chronological().length > 1 && currentIdx() < chronological().length - 1 && !previewAct.busy() && !mutateAct.busy());

  return (
    <View testID="artifact-timeline-bar" class="shrink-0 gap-1.5 border-b border-line bg-side px-3 py-2">
      <View class="flex-row items-center gap-2">
        <View class="shrink-0 flex-row items-center gap-1.5">
          <Icon name="clock" size={14} tone="muted" />
          <Text class="text-xs font-semibold text-ink">{t("web.artifact.timeline.title")}</Text>
          <If when={chronological().length > 0}>
            <Text class="font-mono text-2xs text-muted tabular-nums">{`${currentIdx() + 1}/${chronological().length}`}</Text>
          </If>
        </View>

        <View class="shrink-0 flex-row items-center gap-0.5">
          <IconButton
            icon="previous"
            size={12}
            label={t("web.artifact.timeline.prev")}
            testid="timeline-prev"
            disabled={!canPrev()}
            onClick={() => selectCommit(currentIdx() - 1)}
          />
          <IconButton
            icon="next"
            size={12}
            label={t("web.artifact.timeline.next")}
            testid="timeline-next"
            disabled={!canNext()}
            onClick={() => selectCommit(currentIdx() + 1)}
          />
        </View>

        <View testID="timeline-track" class="min-w-0 flex-1">
          <If
            when={!loading() && loadError() === undefined && chronological().length > 0}
            else={
              <Text class="truncate text-xs text-muted">
                {loadError() ?? (loading() ? t("web.artifact.timeline.loading") : t("web.artifact.timeline.empty"))}
              </Text>
            }
          >
            <Scroll horizontal class="h-6 w-full" contentClass="flex-row items-center gap-1 px-0.5">
              <Each of={chronological()} key={(e) => e.frontiers}>
                {(entry, idx) => {
                  const active = () => idx() === currentIdx();
                  const color = () => actorDotColor(entry(), agents().get(entry().agent ?? entry().author));
                  const label = () => `${authorName(entry())} · ${entry().summary ?? entry().origin} · ${ago(entry().at, now())}`;
                  return (
                    <View
                      role="button"
                      testID={`timeline-node-${idx()}`}
                      accessibilityLabel={label()}
                      accessibilityState={{ selected: active() }}
                      tooltip={<Bubble text={label()} />}
                      onPress={() => selectCommit(idx())}
                      class={`h-5 shrink-0 items-center justify-center rounded-sm border px-1.5 focus-visible:outline-2 focus-visible:outline-focus ${
                        active() ? "border-accent bg-selected" : "border-transparent hover:bg-hover"
                      }`}
                    >
                      <View class="size-2 shrink-0 rounded-full" style={{ backgroundColor: color() }} />
                    </View>
                  );
                }}
              </Each>
            </Scroll>
          </If>
        </View>

        <View class="shrink-0 flex-row items-center gap-1">
          <If when={isHistorical()}>
            <Button size="compact" tone="plain" testID="timeline-live" onPress={backToLive}>
              {t("web.artifact.timeline.backToLive")}
            </Button>
          </If>
          <IconButton
            icon="close"
            size={12}
            label={t("web.artifact.canvas.close")}
            testid="timeline-close"
            onClick={() => {
              props.onPreview(undefined);
              props.onClose();
            }}
          />
        </View>
      </View>

      <If when={selectedEntry()}>
        {(entry) => (
          <View class="flex-row flex-wrap items-center gap-2">
            <View class="min-w-0 flex-1 flex-row flex-wrap items-center gap-1.5">
              <View class="size-2 shrink-0 rounded-full" style={{ backgroundColor: actorDotColor(entry(), agents().get(entry().agent ?? entry().author)) }} />
              <Text testID="timeline-selected-author" class="text-xs font-medium text-ink">
                {authorName(entry())}
              </Text>
              <If when={entry().turn !== undefined}>
                <View class="h-4.5 items-center justify-center rounded-xs border border-line bg-page px-1">
                  <Text class="font-mono text-2xs text-muted tabular-nums">{t("web.artifact.timeline.turn", { n: entry().turn ?? 0 })}</Text>
                </View>
              </If>
              <View class="h-4.5 items-center justify-center rounded-xs bg-hover px-1.5">
                <Text class="font-mono text-2xs text-muted">{entry().origin}</Text>
              </View>
              <If when={entry().summary}>{(summary) => <Text class="min-w-0 truncate text-xs text-muted">{summary()}</Text>}</If>
              <Text class="shrink-0 text-2xs text-faint">{ago(entry().at, now())}</Text>
            </View>

            <View class="shrink-0 flex-row items-center gap-1">
              <If when={isHistorical()}>
                <Button
                  size="compact"
                  tone="primary"
                  icon="undo"
                  testID="timeline-restore"
                  disabled={mutateAct.busy() || previewAct.busy()}
                  onPress={restoreSelected}
                >
                  {t("web.artifact.timeline.restore")}
                </Button>
              </If>
              <Button size="compact" tone="plain" icon="branch" testID="timeline-fork" disabled={mutateAct.busy() || previewAct.busy()} onPress={forkSelected}>
                {t("web.artifact.timeline.fork")}
              </Button>
              <If when={entry().origin.length > 0}>
                <Button
                  size="compact"
                  tone="plain"
                  icon="undo"
                  testID="timeline-undo-origin"
                  disabled={mutateAct.busy() || previewAct.busy()}
                  onPress={undoSelectedOrigin}
                >
                  {t("web.artifact.timeline.undoTurn")}
                </Button>
              </If>
              <If when={chronological().length > 1}>
                <Button size="compact" tone="quiet" testID="timeline-compact" disabled={mutateAct.busy() || previewAct.busy()} onPress={compactHistory}>
                  {t("web.artifact.timeline.compact")}
                </Button>
              </If>
            </View>
          </View>
        )}
      </If>
    </View>
  );
}
