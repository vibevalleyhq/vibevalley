import { computed, effect, Scroll, signal, Text, untracked, View } from "nsh";

import { t } from "@vibevalley/i18n";
import type {
  DebugTrajectoryDetail,
  DebugTrajectoryExportResult,
  DebugTrajectorySubagentNode,
  DebugTrajectorySummary,
  DebugTrajectoryTurn,
} from "@vibevalley/protocol";

import { Button } from "../../design/Button";
import { Icon } from "../../design/Icon";
import { IconButton } from "../../design/IconButton";
import { Banner, Empty } from "../../design/layout";
import { CountPill, Tag } from "../../design/Tag";
import { api, reasonOf } from "../../infra/api";
import { wallClockText } from "../../infra/base/format";
import {
  formatBytes,
  formatDurationMs,
  formatTokenBreakdown,
  formatTokenCompact,
  trajectoryKindLabel,
  trajectoryKindTone,
  type TrajectoryJumpFocus,
} from "./format";
import { CopyButton, JsonPreview, SectionHeader } from "./shared";

function subagentTone(status?: string): "ok" | "info" | "bad" | "neutral" {
  switch (status) {
    case "completed":
      return "ok";
    case "running":
    case "pending_init":
      return "info";
    case "errored":
    case "interrupted":
      return "bad";
    default:
      return "neutral";
  }
}

function indentClass(depth: number): string {
  if (depth <= 0) return "";
  if (depth === 1) return "pl-4";
  if (depth === 2) return "pl-8";
  return "pl-12";
}

function SubagentTreeNode(props: {
  node: () => DebugTrajectorySubagentNode;
  childrenOf: (id: string) => readonly DebugTrajectorySubagentNode[];
  depth: number;
  selectedId: () => string | undefined;
  onSelect: (id: string | undefined) => void;
}) {
  const collapsed = signal(false);
  const children = computed(() => props.childrenOf(props.node().id));
  const selected = () => props.selectedId() === props.node().id;

  return (
    <View class={`gap-1 ${indentClass(props.depth)}`}>
      <View
        class={`flex-row items-center gap-1.5 rounded-sm border px-2 py-1.5 ${selected() ? "border-focus bg-selected" : "border-line bg-side hover:bg-hover"}`}
      >
        <If when={children().length > 0} else={<View class="w-3" />}>
          <View
            role="button"
            testID={`trajectory-subagent-toggle-${props.node().id}`}
            onPress={() => collapsed.set(!collapsed())}
            class="items-center justify-center p-0.5"
          >
            <Icon name={collapsed() ? "expand" : "collapse"} size={10} tone="muted" />
          </View>
        </If>
        <View
          role="button"
          testID={`trajectory-subagent-node-${props.node().id}`}
          accessibilityState={{ selected: selected() }}
          onPress={() => props.onSelect(selected() ? undefined : props.node().id)}
          class="min-w-0 flex-1 flex-row flex-wrap items-center gap-1.5"
        >
          <Text class="font-mono text-xs font-medium text-ink">{props.node().label}</Text>
          <If when={Boolean(props.node().status)}>
            <Tag tone={subagentTone(props.node().status)} label={props.node().status ?? ""} />
          </If>
          <Text class="font-mono text-2xs text-muted">{props.node().path}</Text>
          <Text class="font-mono text-2xs text-faint">
            {props.node().turnCount}r · {props.node().eventCount + props.node().rawCount}e
          </Text>
        </View>
      </View>
      <If when={children().length > 0 && !collapsed()}>
        <View class="gap-1">
          <Each of={children()} key={(child) => child.id}>
            {(child) => (
              <SubagentTreeNode node={child} childrenOf={props.childrenOf} depth={props.depth + 1} selectedId={props.selectedId} onSelect={props.onSelect} />
            )}
          </Each>
        </View>
      </If>
    </View>
  );
}

export function TrajectoryTab(props: {
  refreshTick: () => number;
  focus?: () => TrajectoryJumpFocus | undefined;
  onJumpToTimeline?: (target: { traceId?: number | undefined; timestampMs: number }) => void;
}) {
  const list = signal<readonly DebugTrajectorySummary[]>([]);
  const loadingList = signal(true);
  const listError = signal<string | undefined>(undefined);
  const selectedKey = signal<string | undefined>(undefined);
  const detail = signal<DebugTrajectoryDetail | undefined>(undefined);
  const loadingDetail = signal(false);
  const detailError = signal<string | undefined>(undefined);
  const showSystemPrompt = signal(false);
  const selectedSubagentId = signal<string | undefined>(undefined);
  const highlightedTurnIndex = signal<number | undefined>(undefined);
  const highlightedRawSeq = signal<number | undefined>(undefined);
  const exporting = signal(false);
  const exportResult = signal<DebugTrajectoryExportResult | undefined>(undefined);
  const exportError = signal<string | undefined>(undefined);

  let listInFlight = false;
  let detailInFlight = false;
  let detailReq = 0;
  let lastDetail: DebugTrajectoryDetail | undefined;
  let handledFocusKey = -1;

  const currentDetail = () => {
    const d = detail();
    if (d !== undefined) lastDetail = d;
    return d ?? lastDetail!;
  };

  const keyOf = (item: Pick<DebugTrajectorySummary, "id" | "kind">) => `${item.kind}:${item.id}`;

  const matchTurnForFocus = (d: DebugTrajectoryDetail, focus: TrajectoryJumpFocus): { turnIndex?: number; rawSeq?: number } => {
    if (focus.traceId !== undefined) {
      for (const turn of d.turns) {
        const raw = turn.rawEntries.find((r) => r.traceId === focus.traceId);
        if (raw) return { turnIndex: turn.index, rawSeq: raw.seq };
        if (turn.traceIds.includes(focus.traceId)) return { turnIndex: turn.index };
      }
    }
    if (focus.timestampMs !== undefined && d.turns.length > 0) {
      let bestTurn = d.turns[0];
      let bestDist = Math.abs((bestTurn?.startedAt ?? 0) - focus.timestampMs);
      for (const turn of d.turns) {
        const end = turn.endedAt ?? turn.startedAt;
        const dist =
          focus.timestampMs >= turn.startedAt && focus.timestampMs <= end
            ? 0
            : Math.min(Math.abs(turn.startedAt - focus.timestampMs), Math.abs(end - focus.timestampMs));
        if (dist < bestDist) {
          bestTurn = turn;
          bestDist = dist;
        }
      }
      if (bestTurn !== undefined) {
        return { turnIndex: bestTurn.index };
      }
    }
    return {};
  };

  const applyFocusToDetail = (d: DebugTrajectoryDetail, focus?: TrajectoryJumpFocus) => {
    if (!focus) return;
    const hit = matchTurnForFocus(d, focus);
    highlightedTurnIndex.set(hit.turnIndex);
    highlightedRawSeq.set(hit.rawSeq);
  };

  const loadDetail = async (item: Pick<DebugTrajectorySummary, "id" | "kind">, pendingFocus?: TrajectoryJumpFocus) => {
    const req = ++detailReq;
    detailInFlight = true;
    loadingDetail.set(true);
    detailError.set(undefined);
    try {
      const res = await api.debug.trajectory.get({ id: item.id, kind: item.kind });
      if (req !== detailReq) return;
      lastDetail = res;
      detail.set(res);
      applyFocusToDetail(res, pendingFocus);
    } catch (e) {
      if (req !== detailReq) return;
      detailError.set(reasonOf(e));
    } finally {
      if (req === detailReq) {
        detailInFlight = false;
        loadingDetail.set(false);
      }
    }
  };

  const resolveJumpTarget = async (items: readonly DebugTrajectorySummary[], focus: TrajectoryJumpFocus) => {
    if (focus.sessionId !== undefined) {
      const bySession = items.find((item) => item.id === focus.sessionId);
      if (bySession) {
        selectedKey.set(keyOf(bySession));
        await loadDetail(bySession, focus);
        return;
      }
    }
    const cur = detail();
    if (cur && matchTurnForFocus(cur, focus).rawSeq !== undefined) {
      applyFocusToDetail(cur, focus);
      return;
    }
    if (focus.traceId !== undefined) {
      for (const item of items.slice(0, 6)) {
        try {
          const probe = await api.debug.trajectory.get({ id: item.id, kind: item.kind });
          if (probe.turns.some((t) => t.traceIds.includes(focus.traceId!))) {
            selectedKey.set(keyOf(item));
            lastDetail = probe;
            detail.set(probe);
            applyFocusToDetail(probe, focus);
            return;
          }
        } catch {
          // Continue probing remaining trajectories.
        }
      }
    }
    const fallback = (selectedKey() !== undefined ? items.find((i) => keyOf(i) === selectedKey()) : undefined) ?? items[0];
    if (fallback !== undefined) {
      selectedKey.set(keyOf(fallback));
      await loadDetail(fallback, focus);
    }
  };

  const loadList = async (pendingFocus?: TrajectoryJumpFocus) => {
    if (listInFlight && !pendingFocus) return;
    listInFlight = true;
    try {
      const items = await api.debug.trajectory.list();
      list.set(items);
      listError.set(undefined);
      if (pendingFocus) {
        await resolveJumpTarget(items, pendingFocus);
      } else {
        const current = selectedKey();
        if (current !== undefined && !detailInFlight) {
          const matched = items.find((item) => keyOf(item) === current);
          if (matched) void loadDetail(matched);
        }
      }
    } catch (e) {
      listError.set(reasonOf(e));
    } finally {
      listInFlight = false;
      loadingList.set(false);
    }
  };

  effect(() => {
    void props.refreshTick();
    untracked(() => {
      void loadList();
    });
  });

  effect(() => {
    const f = props.focus?.();
    if (!f || f.key === handledFocusKey) return;
    handledFocusKey = f.key;
    untracked(() => {
      const currentItems = list();
      if (currentItems.length > 0) {
        void resolveJumpTarget(currentItems, f);
      } else {
        void loadList(f);
      }
    });
  });

  const selectItem = (item: DebugTrajectorySummary) => {
    const nextKey = keyOf(item);
    if (selectedKey() !== nextKey) {
      detail.set(undefined);
      selectedSubagentId.set(undefined);
      exportResult.set(undefined);
      exportError.set(undefined);
    }
    selectedKey.set(nextKey);
    highlightedTurnIndex.set(undefined);
    highlightedRawSeq.set(undefined);
    showSystemPrompt.set(false);
    void loadDetail(item);
  };

  const exportEvalBundle = async () => {
    const cur = detail();
    if (!cur || exporting()) return;
    exporting.set(true);
    exportError.set(undefined);
    try {
      const res = await api.debug.trajectory.export({ id: cur.summary.id, kind: cur.summary.kind });
      exportResult.set(res);
    } catch (e) {
      exportError.set(reasonOf(e));
    } finally {
      exporting.set(false);
    }
  };

  const subagentTreeRoots = computed(() => {
    const nodes = detail()?.subagentNodes ?? [];
    const byId = new Set(nodes.map((n) => n.id));
    return nodes.filter((n) => !n.parentId || !byId.has(n.parentId));
  });

  const subagentChildrenOf = (parentId: string) => {
    const nodes = detail()?.subagentNodes ?? [];
    return nodes.filter((n) => n.parentId === parentId);
  };

  const visibleTurns = computed(() => {
    const d = detail();
    if (!d) return [];
    const subId = selectedSubagentId();
    if (!subId) return d.turns;
    const node = d.subagentNodes.find((n) => n.id === subId);
    const matchPath = node?.path ?? subId;
    return d.turns.filter(
      (turn) =>
        turn.events.some((ev) => ev.threadId === subId || ev.threadId === matchPath) ||
        turn.rawEntries.some((raw) => raw.agentPath.join("/").startsWith(matchPath)),
    );
  });

  return (
    <View testID="devtools-trajectory" class="min-h-0 flex-1 md:flex-row">
      <Scroll class="max-h-56 shrink-0 border-b border-line bg-side md:max-h-none md:w-72 md:border-r md:border-b-0" contentClass="gap-1.5 p-2.5">
        <If when={listError() !== undefined}>
          <Banner tone="bad" size="sm">
            {t("web.devtools.status.error", { reason: listError() ?? "" })}
          </Banner>
        </If>
        <If
          when={list().length > 0}
          else={
            <If when={!loadingList()} else={<Text class="p-2 text-xs text-muted">{t("web.devtools.status.loading")}</Text>}>
              <Empty compact icon="log" testid="trajectory-empty-list">
                {t("web.devtools.trajectory.emptyList")}
              </Empty>
            </If>
          }
        >
          <Each of={list()} key={(item) => keyOf(item)}>
            {(item) => {
              const selected = () => selectedKey() === keyOf(item());
              return (
                <View
                  role="button"
                  testID={`trajectory-item-${item().id}`}
                  accessibilityState={{ selected: selected() }}
                  onPress={() => selectItem(item())}
                  class={`gap-1 rounded-md border px-2.5 py-2 ${selected() ? "border-focus bg-selected" : "border-line bg-page hover:bg-hover"}`}
                >
                  <View class="flex-row items-center gap-1.5">
                    <Tag tone={trajectoryKindTone(item().kind)} label={trajectoryKindLabel(item().kind)} />
                    <Text class="min-w-0 flex-1 truncate text-xs font-medium text-ink">{item().title}</Text>
                    <If when={item().hasSilentError}>
                      <Tag tone="bad" icon="warn" label={t("web.devtools.trajectory.silentError")} />
                    </If>
                  </View>
                  <View class="flex-row flex-wrap items-center gap-2">
                    <Text class="font-mono text-2xs text-muted">{item().runtime}</Text>
                    <Text class="font-mono text-2xs text-faint">{item().status}</Text>
                    <Text class="font-mono text-2xs tabular-nums text-faint">
                      {t("web.devtools.trajectory.events")}: {item().eventCount}
                    </Text>
                    <If when={item().tokens !== undefined}>
                      <Text class="font-mono text-2xs tabular-nums text-muted">
                        {t("web.devtools.trajectory.tokens")}: {item().tokens ? formatTokenCompact(item().tokens!) : ""}
                      </Text>
                    </If>
                  </View>
                </View>
              );
            }}
          </Each>
        </If>
      </Scroll>

      <Scroll testID="trajectory-detail-pane" class="min-h-0 min-w-0 flex-1" contentClass="gap-3 p-3">
        <If when={detailError() !== undefined}>
          <Banner tone="bad" size="sm">
            {t("web.devtools.status.error", { reason: detailError() ?? "" })}
          </Banner>
        </If>

        <If
          when={detail() !== undefined}
          else={
            <If
              when={loadingDetail()}
              else={
                <Empty compact icon="log" testid="trajectory-select-prompt">
                  {t("web.devtools.trajectory.selectPrompt")}
                </Empty>
              }
            >
              <Text class="p-3 text-xs text-muted">{t("web.devtools.status.loading")}</Text>
            </If>
          }
        >
          <View class="gap-3">
            <View class="gap-1.5 rounded-md border border-line bg-page p-3">
              <View class="flex-row flex-wrap items-center justify-between gap-2">
                <View class="min-w-0 flex-1 flex-row flex-wrap items-center gap-2">
                  <Tag tone={trajectoryKindTone(currentDetail().summary.kind)} label={trajectoryKindLabel(currentDetail().summary.kind)} />
                  <Text class="min-w-0 flex-1 truncate text-sm font-semibold text-ink">{currentDetail().summary.title}</Text>
                  <If when={currentDetail().summary.hasSilentError}>
                    <Tag tone="bad" icon="warn" label={t("web.devtools.trajectory.silentError")} />
                  </If>
                </View>
                <Button size="compact" tone="plain" icon="download" testID="trajectory-export" disabled={exporting()} onPress={() => void exportEvalBundle()}>
                  {exporting() ? t("web.devtools.actions.exporting") : t("web.devtools.actions.exportTrajectory")}
                </Button>
              </View>
              <View class="flex-row flex-wrap items-center gap-2">
                <Text class="font-mono text-2xs text-muted">{currentDetail().summary.runtime}</Text>
                <Tag tone="neutral" label={currentDetail().summary.status} />
                <Tag tone="info" label={`${t("web.devtools.trajectory.voyageRecords")}: ${currentDetail().voyageRecordCount}`} />
                <Tag tone="neutral" label={`${t("web.devtools.trajectory.turns")}: ${currentDetail().turns.length}`} />
              </View>
              <If when={exportError() !== undefined}>
                <Banner tone="bad" size="sm" testID="trajectory-export-error">
                  {t("web.devtools.status.error", { reason: exportError() ?? "" })}
                </Banner>
              </If>
              <If when={exportResult() !== undefined}>
                <View testID="trajectory-export-result" class="gap-1.5 rounded-sm border border-line bg-side p-2.5">
                  <View class="flex-row flex-wrap items-center justify-between gap-2">
                    <Text class="text-xs font-medium text-ink">{t("web.devtools.trajectory.exported", { dir: exportResult()!.dir })}</Text>
                    <Tag tone="ok" label={`${exportResult()!.conversationsExported} conv · ${exportResult()!.entriesExported} entries`} />
                  </View>
                  <View class="flex-row flex-wrap items-center gap-2">
                    <Text class="font-mono text-2xs text-muted">{exportResult()!.inspectCmd}</Text>
                    <CopyButton text={exportResult()!.inspectCmd} label={t("web.devtools.trajectory.inspectCmd")} testID="trajectory-export-copy-inspect" />
                    <CopyButton text={exportResult()!.replayCmd} label={t("web.devtools.trajectory.replayCmd")} testID="trajectory-export-copy-replay" />
                  </View>
                </View>
              </If>
              <If
                when={currentDetail().subagentNodes.length > 0}
                else={
                  <If when={currentDetail().subagentPaths.length > 0}>
                    <View class="flex-row flex-wrap items-center gap-1 pt-1">
                      <Text class="text-2xs font-medium text-muted">{t("web.devtools.trajectory.subagents")}:</Text>
                      <Each of={currentDetail().subagentPaths}>
                        {(subPath) => (
                          <View class="rounded-xs border border-line bg-side px-1.5 py-px">
                            <Text class="font-mono text-2xs text-ink">{subPath()}</Text>
                          </View>
                        )}
                      </Each>
                    </View>
                  </If>
                }
              >
                <View testID="trajectory-subagent-tree" class="gap-1.5 pt-1">
                  <View class="flex-row items-center justify-between gap-2">
                    <Text class="text-2xs font-semibold text-muted">{t("web.devtools.trajectory.subagentTree")}</Text>
                    <If when={selectedSubagentId() !== undefined}>
                      <Button size="compact" tone="quiet" testID="trajectory-subagent-clear" onPress={() => selectedSubagentId.set(undefined)}>
                        {t("web.devtools.trajectory.allAgents")}
                      </Button>
                    </If>
                  </View>
                  <View class="gap-1">
                    <Each of={subagentTreeRoots()} key={(node) => node.id}>
                      {(node) => (
                        <SubagentTreeNode
                          node={node}
                          childrenOf={subagentChildrenOf}
                          depth={0}
                          selectedId={() => selectedSubagentId()}
                          onSelect={(id) => selectedSubagentId.set(id)}
                        />
                      )}
                    </Each>
                  </View>
                </View>
              </If>
            </View>

            <If when={Boolean(currentDetail().systemPrompt)}>
              <View class="rounded-md border border-line bg-page">
                <View
                  role="button"
                  testID="trajectory-system-prompt-toggle"
                  accessibilityState={{ expanded: showSystemPrompt() }}
                  onPress={() => showSystemPrompt.set(!showSystemPrompt())}
                  class="flex-row items-center justify-between gap-2 px-3 py-2 hover:bg-hover"
                >
                  <View class="flex-row items-center gap-1.5">
                    <Icon name={showSystemPrompt() ? "collapse" : "expand"} size={12} tone="muted" />
                    <Text class="text-xs font-medium text-ink">{t("web.devtools.trajectory.systemPrompt")}</Text>
                  </View>
                  <CopyButton text={currentDetail().systemPrompt ?? ""} testID="trajectory-system-prompt-copy" />
                </View>
                <If when={showSystemPrompt()}>
                  <View testID="trajectory-system-prompt-body" class="border-t border-line bg-side p-2.5">
                    <Text class="font-mono text-2xs leading-relaxed text-ink">{currentDetail().systemPrompt}</Text>
                  </View>
                </If>
              </View>
            </If>

            <View class="gap-2">
              <SectionHeader title={t("web.devtools.trajectory.turns")} count={visibleTurns().length} />
              <If when={visibleTurns().length > 0} else={<Text class="text-xs text-muted">{t("web.devtools.status.empty")}</Text>}>
                <Each of={visibleTurns()} key={(turn) => turn.index}>
                  {(turn) => (
                    <TurnCard
                      turn={turn}
                      highlighted={() => highlightedTurnIndex() === turn().index}
                      highlightedRawSeq={() => highlightedRawSeq()}
                      onJumpToTimeline={props.onJumpToTimeline}
                    />
                  )}
                </Each>
              </If>
            </View>
          </View>
        </If>
      </Scroll>
    </View>
  );
}

function TurnCard(props: {
  turn: () => DebugTrajectoryTurn;
  highlighted?: () => boolean;
  highlightedRawSeq?: () => number | undefined;
  onJumpToTimeline?: ((target: { traceId?: number | undefined; timestampMs: number }) => void) | undefined;
}) {
  const expandedRawSeq = signal<number | undefined>(undefined);
  const turn = () => props.turn();
  const isHighlighted = () => props.highlighted?.() === true;

  return (
    <View testID={`trajectory-turn-${turn().index}`} class={`gap-2 rounded-md border bg-page p-3 ${isHighlighted() ? "border-focus" : "border-line"}`}>
      <View class="flex-row flex-wrap items-center justify-between gap-2">
        <View class="flex-row flex-wrap items-center gap-2">
          <Text class="text-xs font-semibold text-ink">{t("web.devtools.trajectory.turnIndex", { index: turn().index })}</Text>
          <Text class="font-mono text-2xs tabular-nums text-faint">{wallClockText(turn().startedAt)}</Text>
          <If when={turn().durationMs !== undefined}>
            <Tag tone="neutral" label={formatDurationMs(turn().durationMs)} />
          </If>
          <If when={props.onJumpToTimeline !== undefined}>
            <View
              role="button"
              testID={`trajectory-jump-timeline-${turn().index}`}
              onPress={() =>
                props.onJumpToTimeline?.({
                  ...(turn().traceIds[0] !== undefined ? { traceId: turn().traceIds[0] } : {}),
                  timestampMs: turn().startedAt,
                })
              }
              class="flex-row items-center gap-1 rounded-sm border border-line bg-side px-2 py-0.5 hover:bg-hover"
            >
              <Icon name="clock" size={11} tone="accent" />
              <Text class="text-2xs font-medium text-ink">{t("web.devtools.actions.jumpToTimeline")}</Text>
            </View>
          </If>
        </View>
        <If when={turn().tokens !== undefined}>
          <View testID={`trajectory-turn-tokens-${turn().index}`} class="flex-row flex-wrap items-center gap-1">
            <Text class="text-2xs font-medium text-muted">{t("web.devtools.trajectory.tokens")}:</Text>
            <Each of={turn().tokens ? formatTokenBreakdown(turn().tokens!) : []}>
              {(part) => (
                <View class="rounded-xs bg-hover px-1.5 py-px">
                  <Text class="font-mono text-2xs tabular-nums text-ink">{part()}</Text>
                </View>
              )}
            </Each>
          </View>
        </If>
      </View>

      <If when={Boolean(turn().prompt)}>
        <View class="gap-1 rounded-sm border border-line bg-side px-2.5 py-2">
          <Text class="text-2xs font-medium text-muted">{t("web.devtools.trajectory.prompt")}</Text>
          <Text class="text-xs text-ink">{turn().prompt}</Text>
        </View>
      </If>

      <If when={turn().silentErrors.length > 0}>
        <Banner tone="bad" size="sm" testID={`trajectory-silent-errors-${turn().index}`}>
          <View class="gap-1">
            <Text class="text-xs font-semibold text-berry">{t("web.devtools.trajectory.silentError")}</Text>
            <Each of={turn().silentErrors}>{(errText) => <Text class="font-mono text-2xs text-berry">{errText()}</Text>}</Each>
          </View>
        </Banner>
      </If>

      <View class="gap-1">
        <View class="flex-row items-center gap-1.5">
          <Text class="text-2xs font-semibold text-muted">{t("web.devtools.trajectory.events")}</Text>
          <CountPill count={turn().events.length} />
        </View>
        <If when={turn().events.length > 0} else={<Text class="text-2xs text-faint">{t("web.devtools.status.empty")}</Text>}>
          <View class="gap-1">
            <Each of={turn().events} key={(ev) => ev.seq}>
              {(ev) => (
                <View class="flex-row items-center gap-2 rounded-sm bg-side px-2 py-1">
                  <Text class="shrink-0 font-mono text-2xs tabular-nums text-faint">#{ev().seq}</Text>
                  <Tag tone={ev().ok === false || ev().type === "run/error" ? "bad" : "neutral"} label={ev().type} />
                  <If when={Boolean(ev().tool)}>
                    <Text class="shrink-0 font-mono text-2xs text-water">{ev().tool}</Text>
                  </If>
                  <Text class="min-w-0 flex-1 truncate text-xs text-ink">{ev().text || ev().output || "—"}</Text>
                </View>
              )}
            </Each>
          </View>
        </If>
      </View>

      <View class="gap-1">
        <View class="flex-row items-center gap-1.5">
          <Text class="text-2xs font-semibold text-muted">{t("web.devtools.trajectory.rawEntries")}</Text>
          <CountPill count={turn().rawEntries.length} />
        </View>
        <If when={turn().rawEntries.length > 0} else={<Text class="text-2xs text-faint">{t("web.devtools.status.empty")}</Text>}>
          <View class="gap-1">
            <Each of={turn().rawEntries} key={(entry) => entry.seq}>
              {(entry) => {
                const open = () => expandedRawSeq() === entry().seq || props.highlightedRawSeq?.() === entry().seq;
                const rawHighlighted = () => props.highlightedRawSeq?.() === entry().seq;
                return (
                  <View class={`rounded-sm border bg-side ${rawHighlighted() ? "border-focus" : "border-line"}`}>
                    <View
                      role="button"
                      testID={`trajectory-raw-${turn().index}-${entry().seq}`}
                      accessibilityState={{ expanded: open() }}
                      onPress={() => expandedRawSeq.set(open() ? undefined : entry().seq)}
                      class="flex-row flex-wrap items-center gap-1.5 px-2 py-1.5 hover:bg-hover"
                    >
                      <Icon name={open() ? "collapse" : "expand"} size={10} tone="muted" />
                      <Text class="font-mono text-2xs tabular-nums text-faint">#{entry().seq}</Text>
                      <Tag tone="info" label={entry().kind} />
                      <If when={Boolean(entry().frameType)}>
                        <Tag tone="neutral" label={entry().frameType ?? ""} />
                      </If>
                      <Text class="min-w-0 flex-1 truncate text-xs text-ink">{entry().summary}</Text>
                      <If when={entry().traceId !== undefined}>
                        <Tag tone="neutral" label={t("web.devtools.timeline.correlationId", { id: entry().traceId ?? 0 })} />
                      </If>
                      <If when={props.onJumpToTimeline !== undefined && entry().traceId !== undefined}>
                        <View
                          role="button"
                          testID={`trajectory-raw-jump-${turn().index}-${entry().seq}`}
                          onPress={() =>
                            props.onJumpToTimeline?.({
                              ...(entry().traceId !== undefined ? { traceId: entry().traceId } : {}),
                              timestampMs: entry().time,
                            })
                          }
                          class="rounded-xs border border-line bg-page px-1.5 py-px hover:bg-hover"
                        >
                          <Icon name="clock" size={10} tone="accent" />
                        </View>
                      </If>
                      <Text class="font-mono text-2xs tabular-nums text-faint">{formatBytes(entry().originalBytes)}</Text>
                      <If when={entry().truncated}>
                        <Tag tone="wait" label={t("web.devtools.trajectory.truncated", { bytes: entry().originalBytes })} />
                      </If>
                    </View>
                    <If when={open()}>
                      <View testID={`trajectory-raw-payload-${turn().index}-${entry().seq}`} class="gap-1.5 border-t border-line bg-page p-2">
                        <View class="flex-row items-center justify-between gap-2">
                          <Text class="text-2xs font-medium text-muted">{t("web.devtools.trajectory.rawPayload")}</Text>
                          <IconButton icon="close" size={14} label={t("web.devtools.actions.close")} onClick={() => expandedRawSeq.set(undefined)} />
                        </View>
                        <If when={Boolean(entry().payload)} else={<Text class="text-xs text-muted">{t("web.devtools.status.empty")}</Text>}>
                          <JsonPreview content={entry().payload ?? ""} copyTestID={`trajectory-raw-copy-${turn().index}-${entry().seq}`} />
                        </If>
                      </View>
                    </If>
                  </View>
                );
              }}
            </Each>
          </View>
        </If>
      </View>
    </View>
  );
}
