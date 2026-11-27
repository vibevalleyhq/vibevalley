import { effect, Scroll, signal, Text, untracked, View } from "nsh";

import { t } from "@vibevalley/i18n";
import { type Agent, type Note, type NoteHistoryEntry, type NoteHistoryPreviewResult, type NoteId, userId } from "@vibevalley/protocol";

import { createAct } from "../../design/act";
import { Button } from "../../design/Button";
import { hexColor, swatches } from "../../design/domain/cast";
import { Icon } from "../../design/Icon";
import { IconButton } from "../../design/IconButton";
import { CountPill } from "../../design/Tag";
import { toast } from "../../design/toasts";
import { tone } from "../../design/tone";
import { api, reasonOf } from "../../infra/api";
import { useNow } from "../../infra/base/dom";
import { ago } from "../../infra/base/format";
import { ready, useAgents, useQueryClient } from "../../infra/query";
import { createMemo } from "../../infra/solid";

export interface HistoryPanelProps {
  readonly noteId: NoteId;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onChanged?: ((note: Note) => void) | undefined;
  readonly onForked?: ((forked: Note) => void) | undefined;
  readonly selectedVersion?: number | undefined;
  readonly onPickVersion?: ((version: number | undefined) => void) | undefined;
  readonly onPreview?: ((preview: NoteHistoryPreviewResult | undefined) => void) | undefined;
}

function actorDotColor(entry: NoteHistoryEntry, agent: Agent | undefined): string {
  if (entry.author === userId) return tone("ink");
  if (agent?.look.trim) return hexColor(agent.look.trim);
  const key = entry.sessionId ?? entry.agent ?? entry.author;
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) & 0x7fffffff;
  const trim = swatches.trim[h % swatches.trim.length];
  return trim === undefined ? tone("accent") : hexColor(trim);
}

/** Right-side collaborative history panel over `note.history.*` with preview, restore, fork, and selective `undoOrigin`. */
export function HistoryPanel(props: HistoryPanelProps) {
  const queries = useQueryClient();
  const now = useNow();
  const allAgents = useAgents();
  const agents = createMemo(() => new Map(ready(allAgents, []).map((a) => [a.id, a])));

  const noteMeta = signal<Note | undefined>(undefined);
  const entries = signal<readonly NoteHistoryEntry[]>([]);
  const previewResult = signal<NoteHistoryPreviewResult | undefined>(undefined);
  const loading = signal(false);
  const loadError = signal<string | undefined>(undefined);
  const selectedIndex = signal<number | undefined>(undefined);
  const previewAct = createAct();
  const mutateAct = createAct();

  const currentIdx = createMemo(() => {
    const idx = selectedIndex();
    const list = entries();
    if (list.length === 0) return -1;
    if (idx === undefined || idx < 0 || idx >= list.length) return 0;
    return idx;
  });
  const selectedEntry = createMemo(() => {
    const idx = currentIdx();
    return idx >= 0 ? entries()[idx] : undefined;
  });
  const isHistorical = createMemo(() => props.selectedVersion === undefined && entries().length > 0 && currentIdx() > 0);
  const busy = () => previewAct.busy() || mutateAct.busy();

  let loadRun = 0;
  const loadHistory = async () => {
    const run = ++loadRun;
    loading.set(true);
    loadError.set(undefined);
    try {
      const [note, list] = await Promise.all([api.note.get({ id: props.noteId }), api.note.history.list({ id: props.noteId, limit: 100 })]);
      if (run !== loadRun) return;
      noteMeta.set(note);
      entries.set(list);
      selectedIndex.set(list.length > 0 ? 0 : undefined);
      loading.set(false);
    } catch (e) {
      if (run !== loadRun) return;
      loadError.set(reasonOf(e));
      loading.set(false);
    }
  };

  effect(() => {
    if (!props.open) return;
    const _id = props.noteId;
    void _id;
    previewResult.set(undefined);
    void loadHistory();
  });

  const selectCommit = (idx: number) => {
    const list = entries();
    if (idx < 0 || idx >= list.length) return;
    selectedIndex.set(idx);
    props.onPickVersion?.(undefined);
    if (idx === 0) {
      previewResult.set(undefined);
      props.onPreview?.(undefined);
      return;
    }
    const target = list[idx];
    if (target === undefined) return;
    void previewAct.run(async () => {
      const snap = await api.note.history.preview({ id: props.noteId, frontiers: target.frontiers });
      if (untracked(selectedIndex) === idx) {
        previewResult.set(snap);
        props.onPreview?.(snap);
      }
    });
  };

  const backToLive = () => {
    selectedIndex.set(entries().length > 0 ? 0 : undefined);
    previewResult.set(undefined);
    props.onPreview?.(undefined);
    props.onPickVersion?.(undefined);
  };

  const createSnapshot = () => {
    void mutateAct.run(async () => {
      const updated = await api.note.version.create({
        id: props.noteId,
        note: t("web.note.page.snapshotNote"),
      });
      await queries.invalidate({ prefix: ["notes"] });
      noteMeta.set(updated);
      props.onChanged?.(updated);
      toast(t("web.note.edit.saved", { version: updated.version }));
      await loadHistory();
    });
  };

  const restoreSelected = () => {
    const entry = selectedEntry();
    if (!entry) return;
    void mutateAct.run(async () => {
      const updated = await api.note.history.restore({
        id: props.noteId,
        frontiers: entry.frontiers,
        ...(entry.summary ? { note: entry.summary } : {}),
      });
      await queries.invalidate({ prefix: ["notes"] });
      previewResult.set(undefined);
      props.onPreview?.(undefined);
      noteMeta.set(updated);
      props.onChanged?.(updated);
      toast(t("web.note.timeline.restored"));
      await loadHistory();
    });
  };

  const forkSelected = () => {
    const entry = selectedEntry();
    if (!entry) return;
    const baseTitle = noteMeta()?.title ?? props.noteId;
    void mutateAct.run(async () => {
      const forked = await api.note.history.fork({
        id: props.noteId,
        frontiers: entry.frontiers,
        title: t("web.note.timeline.forkTitle", { title: baseTitle }),
      });
      await queries.invalidate({ prefix: ["notes"] });
      previewResult.set(undefined);
      props.onPreview?.(undefined);
      toast(t("web.note.timeline.forked", { title: forked.title }));
      props.onForked?.(forked);
      props.onChanged?.(forked);
    });
  };

  const undoSelectedOrigin = () => {
    const entry = selectedEntry();
    if (!entry?.origin) return;
    void mutateAct.run(async () => {
      const updated = await api.note.history.undoOrigin({
        id: props.noteId,
        origin: entry.origin,
      });
      await queries.invalidate({ prefix: ["notes"] });
      previewResult.set(undefined);
      props.onPreview?.(undefined);
      noteMeta.set(updated);
      props.onChanged?.(updated);
      toast(t("web.note.timeline.undoneOrigin"));
      await loadHistory();
    });
  };

  const compactHistory = () => {
    void mutateAct.run(async () => {
      const updated = await api.note.history.compact({ id: props.noteId });
      await queries.invalidate({ prefix: ["notes"] });
      previewResult.set(undefined);
      props.onPreview?.(undefined);
      noteMeta.set(updated);
      props.onChanged?.(updated);
      toast(t("web.note.timeline.compacted"));
      await loadHistory();
    });
  };

  const authorName = (entry: NoteHistoryEntry): string => {
    if (entry.author === userId) return t("web.note.blocks.user");
    const agent = agents().get(entry.agent ?? entry.author);
    return agent?.name ?? entry.agent ?? entry.author;
  };

  const savedVersions = createMemo(() => (noteMeta()?.versions ?? []).toReversed());

  return (
    <If when={props.open}>
      <View testID="note-history-panel" class="w-80 min-h-0 shrink-0 border-l border-line bg-side">
        <View desktop={{ windowDrag: true }} class="h-11 shrink-0 flex-row items-center justify-between gap-1.5 border-b border-line px-3">
          <View class="min-w-0 flex-1 flex-row items-center gap-1.5">
            <Icon name="clock" size={14} tone="muted" />
            <Text role="header" class="min-w-0 flex-1 truncate text-sm font-semibold text-ink">
              {t("web.note.timeline.title")}
            </Text>
          </View>
          <View class="shrink-0 flex-row items-center gap-0.5">
            <If when={props.selectedVersion === undefined && !isHistorical()}>
              <IconButton icon="add" size={14} label={t("web.note.edit.save")} testid="history-save-snapshot" disabled={busy()} onClick={createSnapshot} />
            </If>
            <If when={entries().length > 1}>
              <IconButton
                icon="collapse"
                size={14}
                label={t("web.note.timeline.compact")}
                testid="history-compact"
                disabled={busy()}
                onClick={compactHistory}
              />
            </If>
            <IconButton
              icon="close"
              size={14}
              label={t("web.note.canvas.close")}
              testid="history-close"
              onClick={() => {
                previewResult.set(undefined);
                props.onPreview?.(undefined);
                props.onClose();
              }}
            />
          </View>
        </View>

        <Scroll class="min-h-0 flex-1" contentClass="gap-4 p-3">
          <View
            role="button"
            testID="history-live-row"
            accessibilityState={{ selected: props.selectedVersion === undefined && !isHistorical() }}
            onPress={backToLive}
            class={`flex-row items-center gap-2 rounded-lg border px-2.5 py-2 focus-visible:outline-2 focus-visible:outline-focus ${
              props.selectedVersion === undefined && !isHistorical() ? "border-accent bg-selected" : "border-line bg-page hover:bg-hover"
            }`}
          >
            <View class="size-2 shrink-0 rounded-full bg-leaf" />
            <View class="min-w-0 flex-1">
              <Text class="truncate text-sm font-medium text-ink">{t("web.note.page.liveVersion")}</Text>
              <Text class="font-mono text-2xs text-muted tabular-nums">{`seq ${noteMeta()?.seq ?? 0}`}</Text>
            </View>
            <If when={props.selectedVersion === undefined && !isHistorical()}>
              <Icon name="check" size={12} tone="accent" />
            </If>
          </View>

          <If when={savedVersions().length > 0}>
            <View class="gap-1.5">
              <View class="flex-row items-center justify-between px-0.5">
                <Text class="text-xs font-semibold text-muted">{t("web.note.timeline.savedVersions")}</Text>
                <CountPill count={savedVersions().length} />
              </View>
              <View class="gap-1">
                <Each of={savedVersions()} key={(v) => v.version}>
                  {(v) => {
                    const selected = () => props.selectedVersion === v().version;
                    return (
                      <View
                        role="button"
                        testID={`note-version-${v().version}`}
                        accessibilityState={{ selected: selected() }}
                        onPress={() => {
                          previewResult.set(undefined);
                          props.onPreview?.(undefined);
                          props.onPickVersion?.(v().version);
                        }}
                        class={`flex-row items-center gap-2 rounded-md border px-2.5 py-2 focus-visible:outline-2 focus-visible:outline-focus ${
                          selected() ? "border-accent bg-selected" : "border-transparent bg-page hover:border-line hover:bg-hover"
                        }`}
                      >
                        <View class="min-w-0 flex-1 gap-0.5">
                          <View class="flex-row items-center gap-1.5">
                            <Text class="font-mono text-xs font-semibold text-ink tabular-nums">{t("web.note.card.version", { version: v().version })}</Text>
                            <Text class="text-2xs text-faint tabular-nums">{ago(v().at, now())}</Text>
                          </View>
                          <If when={v().note}>{(note) => <Text class="truncate text-xs text-muted">{note()}</Text>}</If>
                        </View>
                        <If when={selected()}>
                          <Icon name="check" size={12} tone="accent" />
                        </If>
                      </View>
                    );
                  }}
                </Each>
              </View>
            </View>
          </If>

          <View testID="history-commits" class="gap-1.5">
            <View class="flex-row items-center justify-between px-0.5">
              <Text class="text-xs font-semibold text-muted">{t("web.note.timeline.commits")}</Text>
              <CountPill count={entries().length} />
            </View>
            <If
              when={!loading() && loadError() === undefined && entries().length > 0}
              else={
                <Text class="px-1 py-2 text-xs text-muted">{loadError() ?? (loading() ? t("web.note.timeline.loading") : t("web.note.timeline.empty"))}</Text>
              }
            >
              <View class="gap-1">
                <Each of={entries()} key={(e) => e.frontiers}>
                  {(entry, idx) => {
                    const selected = () => props.selectedVersion === undefined && idx() === currentIdx();
                    const color = () => actorDotColor(entry(), agents().get(entry().agent ?? entry().author));
                    return (
                      <View
                        role="button"
                        testID={`history-commit-${idx()}`}
                        accessibilityState={{ selected: selected() }}
                        onPress={() => selectCommit(idx())}
                        class={`gap-1 rounded-md border px-2.5 py-2 focus-visible:outline-2 focus-visible:outline-focus ${
                          selected() ? "border-accent bg-selected" : "border-transparent bg-page hover:border-line hover:bg-hover"
                        }`}
                      >
                        <View class="flex-row items-center gap-1.5">
                          <View class="size-2 shrink-0 rounded-full" style={{ backgroundColor: color() }} />
                          <Text class="min-w-0 flex-1 truncate text-xs font-medium text-ink">{authorName(entry())}</Text>
                          <If when={entry().turn !== undefined}>
                            <View class="h-4 items-center justify-center rounded-xs border border-line bg-side px-1">
                              <Text class="font-mono text-2xs text-muted tabular-nums">{t("web.note.timeline.turn", { n: entry().turn ?? 0 })}</Text>
                            </View>
                          </If>
                          <Text class="shrink-0 text-2xs text-faint tabular-nums">{ago(entry().at, now())}</Text>
                        </View>
                        <Text class="line-clamp-2 text-xs text-muted">{entry().summary ?? entry().origin}</Text>
                      </View>
                    );
                  }}
                </Each>
              </View>
            </If>
          </View>

          <If when={previewResult()}>
            {(snap) => (
              <View testID="history-preview-files" class="gap-1.5 rounded-lg border border-line bg-page p-2.5">
                <Text class="text-xs font-semibold text-ink">
                  {t("web.note.timeline.previewBanner", { summary: snap().entry?.summary ?? snap().frontiers.slice(0, 8) })}
                </Text>
                <Each of={snap().files} key={(f) => f.path}>
                  {(file) => (
                    <View class="gap-0.5 rounded-sm border border-line bg-side px-2 py-1.5">
                      <Text class="font-mono text-2xs font-medium text-ink">{file().path}</Text>
                      <Text class="line-clamp-3 font-mono text-2xs text-muted">{file().content}</Text>
                    </View>
                  )}
                </Each>
              </View>
            )}
          </If>
        </Scroll>

        <If when={props.selectedVersion === undefined ? selectedEntry() : undefined}>
          {(entry) => (
            <View class="shrink-0 gap-2 border-t border-line bg-page px-3 py-2.5">
              <If when={isHistorical()}>
                <Button size="compact" tone="primary" icon="undo" testID="history-restore" disabled={busy()} onPress={restoreSelected}>
                  {t("web.note.timeline.restore")}
                </Button>
              </If>
              <View class="flex-row flex-wrap items-center gap-1.5">
                <Button size="compact" tone="plain" icon="branch" testID="history-fork" disabled={busy()} onPress={forkSelected}>
                  {t("web.note.timeline.fork")}
                </Button>
                <If when={entry().origin.length > 0}>
                  <Button size="compact" tone="plain" icon="undo" testID="history-undo-origin" disabled={busy()} onPress={undoSelectedOrigin}>
                    {t("web.note.timeline.undoTurn")}
                  </Button>
                </If>
                <If when={isHistorical()}>
                  <Button size="compact" tone="quiet" testID="history-live" onPress={backToLive}>
                    {t("web.note.timeline.backToLive")}
                  </Button>
                </If>
              </View>
            </View>
          )}
        </If>
      </View>
    </If>
  );
}
