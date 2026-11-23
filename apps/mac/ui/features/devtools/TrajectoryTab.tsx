import { effect, Scroll, signal, Text, untracked, View } from "nsh";

import { t } from "@vibevalley/i18n";
import type { DebugTrajectoryDetail, DebugTrajectorySummary, DebugTrajectoryTurn } from "@vibevalley/protocol";

import { Button } from "../../design/Button";
import { Icon } from "../../design/Icon";
import { Banner, Empty } from "../../design/layout";
import { CountPill, Tag } from "../../design/Tag";
import { api, reasonOf } from "../../infra/api";
import { wallClockText } from "../../infra/base/format";
import { formatBytes, formatDurationMs, formatTokenBreakdown, formatTokenCompact, trajectoryKindLabel, trajectoryKindTone } from "./format";
import { CopyButton, JsonPreview, SectionHeader } from "./shared";

export function TrajectoryTab(props: { refreshTick: () => number }) {
  const list = signal<readonly DebugTrajectorySummary[]>([]);
  const loadingList = signal(true);
  const listError = signal<string | undefined>(undefined);
  const selectedKey = signal<string | undefined>(undefined);
  const detail = signal<DebugTrajectoryDetail | undefined>(undefined);
  const loadingDetail = signal(false);
  const detailError = signal<string | undefined>(undefined);
  const showSystemPrompt = signal(false);

  let listInFlight = false;
  let detailInFlight = false;
  let detailReq = 0;
  let lastDetail: DebugTrajectoryDetail | undefined;

  const currentDetail = () => {
    const d = detail();
    if (d !== undefined) lastDetail = d;
    return d ?? lastDetail!;
  };

  const keyOf = (item: Pick<DebugTrajectorySummary, "id" | "kind">) => `${item.kind}:${item.id}`;

  const loadDetail = async (item: Pick<DebugTrajectorySummary, "id" | "kind">) => {
    const req = ++detailReq;
    detailInFlight = true;
    loadingDetail.set(true);
    detailError.set(undefined);
    try {
      const res = await api.debug.trajectory.get({ id: item.id, kind: item.kind });
      if (req !== detailReq) return;
      lastDetail = res;
      detail.set(res);
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

  const loadList = async () => {
    if (listInFlight) return;
    listInFlight = true;
    try {
      const items = await api.debug.trajectory.list();
      list.set(items);
      listError.set(undefined);
      const current = selectedKey();
      if (current !== undefined && !detailInFlight) {
        const matched = items.find((item) => keyOf(item) === current);
        if (matched) void loadDetail(matched);
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

  const selectItem = (item: DebugTrajectorySummary) => {
    const nextKey = keyOf(item);
    if (selectedKey() !== nextKey) detail.set(undefined);
    selectedKey.set(nextKey);
    showSystemPrompt.set(false);
    void loadDetail(item);
  };

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
              <View class="flex-row flex-wrap items-center gap-2">
                <Tag tone={trajectoryKindTone(currentDetail().summary.kind)} label={trajectoryKindLabel(currentDetail().summary.kind)} />
                <Text class="min-w-0 flex-1 truncate text-sm font-semibold text-ink">{currentDetail().summary.title}</Text>
                <If when={currentDetail().summary.hasSilentError}>
                  <Tag tone="bad" icon="warn" label={t("web.devtools.trajectory.silentError")} />
                </If>
              </View>
              <View class="flex-row flex-wrap items-center gap-2">
                <Text class="font-mono text-2xs text-muted">{currentDetail().summary.runtime}</Text>
                <Tag tone="neutral" label={currentDetail().summary.status} />
                <Tag tone="info" label={`${t("web.devtools.trajectory.voyageRecords")}: ${currentDetail().voyageRecordCount}`} />
                <Tag tone="neutral" label={`${t("web.devtools.trajectory.turns")}: ${currentDetail().turns.length}`} />
              </View>
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
              <SectionHeader title={t("web.devtools.trajectory.turns")} count={currentDetail().turns.length} />
              <If when={currentDetail().turns.length > 0} else={<Text class="text-xs text-muted">{t("web.devtools.status.empty")}</Text>}>
                <Each of={currentDetail().turns} key={(turn) => turn.index}>
                  {(turn) => <TurnCard turn={turn} />}
                </Each>
              </If>
            </View>
          </View>
        </If>
      </Scroll>
    </View>
  );
}

function TurnCard(props: { turn: () => DebugTrajectoryTurn }) {
  const expandedRawSeq = signal<number | undefined>(undefined);
  const turn = () => props.turn();

  return (
    <View testID={`trajectory-turn-${turn().index}`} class="gap-2 rounded-md border border-line bg-page p-3">
      <View class="flex-row flex-wrap items-center justify-between gap-2">
        <View class="flex-row items-center gap-2">
          <Text class="text-xs font-semibold text-ink">{t("web.devtools.trajectory.turnIndex", { index: turn().index })}</Text>
          <Text class="font-mono text-2xs tabular-nums text-faint">{wallClockText(turn().startedAt)}</Text>
          <If when={turn().durationMs !== undefined}>
            <Tag tone="neutral" label={formatDurationMs(turn().durationMs)} />
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
                const open = () => expandedRawSeq() === entry().seq;
                return (
                  <View class="rounded-sm border border-line bg-side">
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
                      <Text class="font-mono text-2xs tabular-nums text-faint">{formatBytes(entry().originalBytes)}</Text>
                      <If when={entry().truncated}>
                        <Tag tone="wait" label={t("web.devtools.trajectory.truncated", { bytes: entry().originalBytes })} />
                      </If>
                    </View>
                    <If when={open()}>
                      <View testID={`trajectory-raw-payload-${turn().index}-${entry().seq}`} class="gap-1.5 border-t border-line bg-page p-2">
                        <View class="flex-row items-center justify-between gap-2">
                          <Text class="text-2xs font-medium text-muted">{t("web.devtools.trajectory.rawPayload")}</Text>
                          <Button
                            size="compact"
                            tone="quiet"
                            onPress={() => expandedRawSeq.set(undefined)}
                            accessibilityLabel={t("web.devtools.actions.close")}
                          >
                            {t("web.devtools.actions.close")}
                          </Button>
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
