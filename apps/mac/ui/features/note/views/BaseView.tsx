import { computed, Scroll, signal, Text, untracked, View } from "nsh";

import { t } from "@vibevalley/i18n";
import type {
  BaseCellValue,
  BaseColumn,
  BaseGroupSnapshot,
  BaseRow,
  BaseRunAgentColumnRequest,
  BaseRunAgentColumnResult,
  BaseUpsertRowRequest,
  BaseViewKind,
  BaseViewSnapshot,
  Issue,
  IssueId,
  Note,
  NoteId,
} from "@vibevalley/protocol";

import { Button } from "../../../design/Button";
import { TextInput } from "../../../design/Field";
import { Icon } from "../../../design/Icon";
import { IconButton } from "../../../design/IconButton";
import { Empty } from "../../../design/layout";
import { Segmented } from "../../../design/Segmented";
import { CountPill } from "../../../design/Tag";
import { toast } from "../../../design/toasts";
import { ready, useAgents } from "../../../infra/query";
import { createEffect } from "../../../infra/solid";
import { BaseCellControl } from "./BaseCell";
import {
  baseCellAsText,
  columnKindIcon,
  defaultCellForColumn,
  findSelectOption,
  firstMediaOfRow,
  optionToneLook,
  projectBaseTimeline,
  rowTitleOf,
} from "./baseModel";
import { BaseRowDrawer } from "./BaseRowDrawer";

export interface BaseViewProps {
  readonly note: Note;
  readonly snapshot?: BaseViewSnapshot | undefined;
  readonly notes: readonly Note[];
  readonly issues: readonly Issue[];
  readonly activeSheetId?: string | undefined;
  readonly activeViewId?: string | undefined;
  readonly busy?: boolean | undefined;
  readonly onSelectView: (sheetId: string, viewId: string) => void;
  readonly onUpsertRow: (req: BaseUpsertRowRequest) => Promise<void> | void;
  readonly onRunAgentColumn: (req: BaseRunAgentColumnRequest) => Promise<BaseRunAgentColumnResult | void>;
  readonly onOpenNote: (id: NoteId) => void;
  readonly onOpenIssue: (id: IssueId) => void;
  readonly onCreatePageForRow?: ((row: BaseRow) => Promise<NoteId | undefined>) | undefined;
}

export function BaseView(props: BaseViewProps) {
  const allAgents = useAgents();
  const filterText = signal("");
  const selectedRowId = signal<string | undefined>(undefined);
  const localViewKind = signal<BaseViewKind | undefined>(undefined);
  const timelineScale = signal<"week" | "month">("week");
  const runningColumnId = signal<string | undefined>(undefined);

  const agents = computed(() => ready(allAgents, []));
  const agentsById = computed(() => new Map(agents().map((a) => [a.id, a])));
  const notesById = computed(() => new Map(props.notes.map((n) => [n.id, n])));
  const issuesById = computed(() => new Map(props.issues.map((i) => [i.id, i])));

  createEffect(
    () => [props.snapshot?.activeSheetId, props.snapshot?.activeViewId, props.snapshot?.activeViewKind] as const,
    () => {
      localViewKind.set(undefined);
    },
    { defer: true },
  );

  const sheetId = computed(() => props.activeSheetId ?? props.snapshot?.activeSheetId ?? "");
  const viewKind = computed((): BaseViewKind => localViewKind() ?? props.snapshot?.activeViewKind ?? "table");
  const columns = computed(() => props.snapshot?.columns ?? []);
  const rows = computed(() => props.snapshot?.rows ?? []);
  const summaries = computed(() => props.snapshot?.summaries ?? []);
  const sheets = computed(() => props.snapshot?.sheets ?? []);

  const columnsById = computed(() => new Map(columns().map((c) => [c.id, c])));
  const summaryByCol = computed(() => new Map(summaries().map((s) => [s.columnId, s])));

  const filteredRows = computed(() => {
    const q = filterText().trim().toLowerCase();
    const all = rows();
    if (!q) return all;
    const cols = columns();
    return all.filter((row) => cols.some((col) => baseCellAsText(row.cells[col.id]).toLowerCase().includes(q)));
  });

  const rowsById = computed(() => new Map(filteredRows().map((r) => [r.id, r])));
  const drawerRow = computed(() => {
    const id = selectedRowId();
    if (!id) return undefined;
    return rows().find((r) => r.id === id);
  });

  const isBusy = () => props.busy === true || runningColumnId() !== undefined;

  const commitCell = (row: BaseRow, colId: string, nextValue: BaseCellValue) => {
    const nextCells: Record<string, BaseCellValue> = { ...row.cells, [colId]: nextValue };
    void Promise.resolve(
      props.onUpsertRow({
        id: props.note.id,
        ...(sheetId() ? { sheetId: sheetId() } : {}),
        rowId: row.id,
        cells: nextCells,
        origin: "user",
      }),
    );
  };

  const addRow = () => {
    const cells: Record<string, BaseCellValue> = {};
    for (const col of columns()) {
      if (col.kind === "formula") continue;
      cells[col.id] = defaultCellForColumn(col);
    }
    const titleCol = columns().find((c) => c.kind === "text");
    if (titleCol) {
      cells[titleCol.id] = { _tag: "text", value: `${t("web.note.base.addRow")} ${rows().length + 1}` };
    }
    void Promise.resolve(
      props.onUpsertRow({
        id: props.note.id,
        ...(sheetId() ? { sheetId: sheetId() } : {}),
        cells,
        origin: "user",
      }),
    );
  };

  const runAgentColumn = (columnId: string, rowIds?: readonly string[]) => {
    runningColumnId.set(columnId);
    void Promise.resolve(
      props.onRunAgentColumn({
        id: props.note.id,
        ...(sheetId() ? { sheetId: sheetId() } : {}),
        columnId,
        ...(rowIds ? { rowIds: [...rowIds] } : {}),
        origin: "user",
      }),
    )
      .then((res) => {
        if (res && typeof res === "object" && "executed" in res) {
          toast(t("web.note.base.agentRanToast", { n: res.executed }));
        }
      })
      .finally(() => {
        if (untracked(runningColumnId) === columnId) runningColumnId.set(undefined);
      });
  };

  const groupColumn = computed((): BaseColumn | undefined => {
    return columns().find((c) => c.kind === "select") ?? columns().find((c) => c.kind === "agentRef");
  });

  const boardGroups = computed((): readonly BaseGroupSnapshot[] => {
    const snapGroups = props.snapshot?.groups ?? [];
    const allowed = new Set(filteredRows().map((r) => r.id));
    if (snapGroups.length > 0) {
      return snapGroups.map((g) => {
        const ids = g.rowIds.filter((id) => allowed.has(id));
        return { ...g, rowIds: ids, count: ids.length };
      });
    }
    const gCol = groupColumn();
    if (!gCol) {
      const ids = filteredRows().map((r) => r.id);
      return [{ key: "_all", label: props.note.title, rowIds: ids, count: ids.length }];
    }
    const buckets = new Map<string, string[]>();
    const labels = new Map<string, string>();
    for (const opt of gCol.options ?? []) {
      buckets.set(opt.value, []);
      labels.set(opt.value, opt.label ?? opt.value);
    }
    for (const row of filteredRows()) {
      const raw = baseCellAsText(row.cells[gCol.id]).trim();
      const key = raw || "_uncategorized";
      const list = buckets.get(key) ?? [];
      list.push(row.id);
      buckets.set(key, list);
    }
    const out: BaseGroupSnapshot[] = [];
    for (const [key, rowIds] of buckets) {
      out.push({
        key,
        label: key === "_uncategorized" ? "Uncategorized" : (labels.get(key) ?? key),
        rowIds,
        count: rowIds.length,
      });
    }
    return out;
  });

  const timelineData = computed(() => projectBaseTimeline(filteredRows(), columns(), timelineScale()));

  const previewColumns = computed(() =>
    columns()
      .filter((c) => c.kind !== "media")
      .slice(0, 4),
  );

  const switchViewKind = (next: BaseViewKind) => {
    localViewKind.set(next);
    props.onSelectView(sheetId(), next);
  };

  return (
    <View testID="note-base-view" class="min-h-0 min-w-0 flex-1 bg-page">
      <View class="shrink-0 flex-row flex-wrap items-center justify-between gap-2 border-b border-line bg-side px-3 py-2">
        <View class="min-w-0 flex-row flex-wrap items-center gap-1.5">
          <If when={sheets().length > 0}>
            <View testID="base-sheet-tabs" class="flex-row items-center gap-1">
              <Each of={sheets()} key={(s) => s.id}>
                {(sh) => {
                  const active = () => sh().id === sheetId();
                  return (
                    <View
                      role="tab"
                      testID={`base-sheet-tab-${sh().id}`}
                      accessibilityState={{ selected: active() }}
                      onPress={() => {
                        localViewKind.set(undefined);
                        props.onSelectView(sh().id, "");
                      }}
                      class={`h-7 flex-row items-center gap-1.5 rounded-md border px-2.5 ${
                        active() ? "border-line bg-elevated shadow-raise" : "border-transparent bg-transparent hover:bg-hover"
                      }`}
                    >
                      <Text class={`text-xs font-medium ${active() ? "text-ink" : "text-muted"}`}>{sh().name}</Text>
                      <CountPill count={sh().rowCount} active={active()} />
                    </View>
                  );
                }}
              </Each>
            </View>
          </If>

          <Segmented
            testid="base-view-switcher"
            label={t("web.note.page.viewMode")}
            value={viewKind()}
            onChange={switchViewKind}
            options={[
              { value: "table", label: t("web.note.base.table"), icon: "log" },
              { value: "board", label: t("web.note.base.board"), icon: "catalog" },
              { value: "gallery", label: t("web.note.base.gallery"), icon: "image" },
              { value: "timeline", label: t("web.note.base.timeline"), icon: "clock" },
            ]}
          />
        </View>

        <View class="flex-row flex-wrap items-center gap-1.5">
          <TextInput
            testID="base-filter-input"
            value={filterText()}
            onInput={(v) => filterText.set(v)}
            placeholder={t("web.note.base.filterPlaceholder")}
            accessibilityLabel={t("web.note.base.filterPlaceholder")}
            wide={false}
            class="h-7 w-40 py-1 text-xs"
          />
          <Text testID="base-rows-count" class="font-mono text-2xs text-muted tabular-nums">
            {t("web.note.base.rowsCount", { n: filteredRows().length })}
          </Text>
          <Button size="compact" tone="primary" icon="add" testID="base-add-row" disabled={isBusy()} onPress={addRow}>
            {t("web.note.base.addRow")}
          </Button>
        </View>
      </View>

      <If when={summaries().length > 0}>
        <View testID="base-summary-strip" class="shrink-0 flex-row flex-wrap items-center gap-2 border-b border-line bg-page px-3 py-1.5">
          <Each of={summaries()} key={(s) => `${s.columnId}:${s.op}`}>
            {(s) => {
              const colName = () => columnsById().get(s().columnId)?.name ?? s().columnId;
              return (
                <View class="h-5 flex-row items-center gap-1 rounded-sm border border-line bg-side px-2">
                  <Text class="text-2xs text-muted">{`${colName()} · ${s().op}`}</Text>
                  <Text class="font-mono text-2xs font-semibold text-ink tabular-nums">{s().value}</Text>
                </View>
              );
            }}
          </Each>
        </View>
      </If>

      <View class="min-h-0 min-w-0 flex-1 flex-row">
        <View class="min-h-0 min-w-0 flex-1">
          <If when={props.snapshot !== undefined} else={<Empty icon="log">{t("web.note.base.empty")}</Empty>}>
            <If when={viewKind() === "table"}>
              <Scroll testID="base-table-view" class="min-h-0 flex-1" contentClass="p-3">
                <If when={filteredRows().length > 0} else={<Empty icon="log">{t("web.note.base.empty")}</Empty>}>
                  <Scroll horizontal contentClass="min-w-full">
                    <View class="min-w-full overflow-hidden rounded-lg border border-line bg-page">
                      <View class="flex-row items-center border-b border-line bg-side px-2 py-2">
                        <View class="w-10 shrink-0 items-center justify-center">
                          <Text class="font-mono text-2xs font-semibold text-faint">#</Text>
                        </View>
                        <Each of={columns()} key={(col) => col.id}>
                          {(col) => (
                            <View class="min-w-40 flex-1 flex-row items-center justify-between gap-1.5 px-2">
                              <View class="min-w-0 flex-1 flex-row items-center gap-1.5">
                                <Icon name={columnKindIcon(col().kind)} size={12} tone="muted" />
                                <Text class="min-w-0 truncate text-xs font-semibold text-ink">{col().name}</Text>
                              </View>
                              <If when={col().kind === "agentAction"}>
                                <Button
                                  size="compact"
                                  tone="plain"
                                  icon="play"
                                  testID={`base-run-column-${col().id}`}
                                  disabled={isBusy()}
                                  onPress={() => runAgentColumn(col().id)}
                                >
                                  {runningColumnId() === col().id ? t("web.note.base.runningAgentColumn") : t("web.note.base.runAgentColumn")}
                                </Button>
                              </If>
                            </View>
                          )}
                        </Each>
                        <View class="w-16 shrink-0" />
                      </View>

                      <Each of={filteredRows()} key={(r) => r.id}>
                        {(row, idx) => {
                          const selected = () => selectedRowId() === row().id;
                          return (
                            <View
                              testID={`base-table-row-${row().id}`}
                              class={`flex-row items-center border-t border-line px-2 py-1.5 ${selected() ? "bg-selected" : "bg-page hover:bg-hover"}`}
                            >
                              <View
                                role="button"
                                testID={`base-row-open-${row().id}`}
                                onPress={() => selectedRowId.set(row().id)}
                                class="w-10 shrink-0 items-center justify-center rounded-xs py-1 hover:bg-selected"
                              >
                                <Text class="font-mono text-2xs text-faint tabular-nums">{String(idx() + 1)}</Text>
                              </View>

                              <Each of={columns()} key={(col) => col.id}>
                                {(col) => (
                                  <View class="min-w-40 flex-1 px-2">
                                    <BaseCellControl
                                      rowId={row().id}
                                      col={col()}
                                      cell={row().cells[col().id]}
                                      notesById={notesById()}
                                      issuesById={issuesById()}
                                      agentsById={agentsById()}
                                      notes={props.notes}
                                      issues={props.issues}
                                      agents={agents()}
                                      busy={isBusy()}
                                      dense
                                      onCommitCell={(colId, next) => commitCell(row(), colId, next)}
                                      onRunAgentRow={(colId, rId) => runAgentColumn(colId, [rId])}
                                      onOpenNote={props.onOpenNote}
                                      onOpenIssue={props.onOpenIssue}
                                    />
                                  </View>
                                )}
                              </Each>

                              <View class="w-16 shrink-0 flex-row items-center justify-end gap-1">
                                <If when={row().pageNoteId}>
                                  <Icon name="notes" size={12} tone="accent" />
                                </If>
                                <IconButton
                                  icon="open"
                                  size={12}
                                  label={t("web.issue.peek.expand")}
                                  testid={`base-row-peek-${row().id}`}
                                  onClick={() => selectedRowId.set(row().id)}
                                />
                              </View>
                            </View>
                          );
                        }}
                      </Each>

                      <If when={summaries().length > 0}>
                        <View class="flex-row items-center border-t border-line bg-side px-2 py-1.5">
                          <View class="w-10 shrink-0 items-center justify-center">
                            <Text class="font-mono text-2xs font-semibold text-muted">Σ</Text>
                          </View>
                          <Each of={columns()} key={(col) => col.id}>
                            {(col) => {
                              const sum = () => summaryByCol().get(col().id);
                              return (
                                <View class="min-w-40 flex-1 px-2">
                                  <If when={sum()}>
                                    {(res) => <Text class="font-mono text-xs font-semibold text-ink tabular-nums">{`${res().op}: ${res().value}`}</Text>}
                                  </If>
                                </View>
                              );
                            }}
                          </Each>
                          <View class="w-16 shrink-0" />
                        </View>
                      </If>
                    </View>
                  </Scroll>
                </If>
              </Scroll>
            </If>

            <If when={viewKind() === "board"}>
              <Scroll horizontal testID="base-board-view" class="min-h-0 flex-1" contentClass="gap-3 p-3 items-start">
                <Each of={boardGroups()} key={(g) => g.key}>
                  {(group) => {
                    const gCol = () => groupColumn();
                    const opt = () => (gCol() ? findSelectOption(gCol()!, group().key) : undefined);
                    const toneLook = () => optionToneLook(opt()?.color);
                    return (
                      <View testID={`base-board-lane-${group().key}`} class="w-72 shrink-0 gap-2 rounded-xl border border-line bg-side p-2.5">
                        <View class="flex-row items-center justify-between gap-2 px-1">
                          <View class="min-w-0 flex-1 flex-row items-center gap-1.5">
                            <View class={`h-5 items-center justify-center rounded-sm px-2 ${toneLook().bgClass}`}>
                              <Text class={`truncate text-xs font-semibold ${toneLook().textClass}`}>{group().label}</Text>
                            </View>
                          </View>
                          <CountPill count={group().count} />
                        </View>

                        <View class="gap-2">
                          <Each of={group().rowIds} key={(id) => id}>
                            {(rowId) => {
                              const row = () => rowsById().get(rowId());
                              return (
                                <If when={row()}>
                                  {(r) => (
                                    <View
                                      role="button"
                                      testID={`base-board-card-${r().id}`}
                                      onPress={() => selectedRowId.set(r().id)}
                                      class={`gap-2 rounded-lg border p-2.5 ${
                                        selectedRowId() === r().id ? "border-accent bg-selected" : "border-line bg-page hover:bg-hover"
                                      }`}
                                    >
                                      <View class="flex-row items-center justify-between gap-2">
                                        <Text class="min-w-0 flex-1 truncate text-sm font-medium text-ink">{rowTitleOf(r(), columns())}</Text>
                                        <If when={r().pageNoteId}>
                                          <Icon name="notes" size={12} tone="accent" />
                                        </If>
                                      </View>
                                      <View class="gap-1">
                                        <Each of={previewColumns()} key={(c) => c.id}>
                                          {(col) => (
                                            <View class="flex-row items-center justify-between gap-2">
                                              <Text class="w-20 shrink-0 truncate text-2xs text-faint">{col().name}</Text>
                                              <Text class="min-w-0 flex-1 truncate text-right text-2xs text-muted">
                                                {baseCellAsText(r().cells[col().id]) || "—"}
                                              </Text>
                                            </View>
                                          )}
                                        </Each>
                                      </View>
                                    </View>
                                  )}
                                </If>
                              );
                            }}
                          </Each>
                        </View>
                      </View>
                    );
                  }}
                </Each>
              </Scroll>
            </If>

            <If when={viewKind() === "gallery"}>
              <Scroll testID="base-gallery-view" class="min-h-0 flex-1" contentClass="p-3">
                <If when={filteredRows().length > 0} else={<Empty icon="image">{t("web.note.base.empty")}</Empty>}>
                  <View class="flex-row flex-wrap gap-3">
                    <Each of={filteredRows()} key={(r) => r.id}>
                      {(row) => {
                        const cover = () => firstMediaOfRow(row(), columns(), notesById());
                        const selected = () => selectedRowId() === row().id;
                        return (
                          <View
                            role="button"
                            testID={`base-gallery-card-${row().id}`}
                            onPress={() => selectedRowId.set(row().id)}
                            class={`min-w-64 max-w-80 flex-1 overflow-hidden rounded-xl border ${
                              selected() ? "border-accent bg-selected" : "border-line bg-page hover:bg-hover"
                            }`}
                          >
                            <View class="h-28 items-center justify-center border-b border-line bg-side px-3">
                              <If
                                when={cover()}
                                else={
                                  <View class="items-center gap-1">
                                    <Icon name={row().pageNoteId ? "notes" : "image"} size={24} tone="faint" />
                                    <Text class="font-mono text-2xs text-faint">{row().pageNoteId ? t("web.note.types.doc") : row().id}</Text>
                                  </View>
                                }
                              >
                                {(asset) => (
                                  <View class="items-center gap-1">
                                    <Icon name="image" size={20} tone="accent" />
                                    <Text class="max-w-full truncate font-mono text-2xs text-muted">{asset()}</Text>
                                  </View>
                                )}
                              </If>
                            </View>
                            <View class="gap-2 p-3">
                              <View class="flex-row items-center justify-between gap-2">
                                <Text class="min-w-0 flex-1 truncate text-sm font-semibold text-ink">{rowTitleOf(row(), columns())}</Text>
                                <If when={row().pageNoteId}>
                                  <Icon name="notes" size={12} tone="accent" />
                                </If>
                              </View>
                              <View class="gap-1">
                                <Each of={previewColumns()} key={(c) => c.id}>
                                  {(col) => (
                                    <View class="flex-row items-center justify-between gap-2">
                                      <Text class="w-20 shrink-0 truncate text-2xs text-faint">{col().name}</Text>
                                      <Text class="min-w-0 flex-1 truncate text-right text-2xs text-ink">{baseCellAsText(row().cells[col().id]) || "—"}</Text>
                                    </View>
                                  )}
                                </Each>
                              </View>
                            </View>
                          </View>
                        );
                      }}
                    </Each>
                  </View>
                </If>
              </Scroll>
            </If>

            <If when={viewKind() === "timeline"}>
              <Scroll testID="base-timeline-view" class="min-h-0 flex-1" contentClass="gap-3 p-3">
                <View class="flex-row items-center justify-between gap-2">
                  <Text class="text-xs font-medium text-muted">
                    {timelineData().dateColumnId
                      ? (columnsById().get(timelineData().dateColumnId ?? "")?.name ?? t("web.note.base.timeline"))
                      : t("web.note.base.timeline")}
                  </Text>
                  <Segmented
                    testid="base-timeline-scale"
                    label={t("web.issue.timeline.scale.label")}
                    value={timelineScale()}
                    onChange={(s) => timelineScale.set(s)}
                    options={[
                      { value: "week", label: t("web.issue.timeline.scale.week") },
                      { value: "month", label: t("web.issue.timeline.scale.month") },
                    ]}
                  />
                </View>

                <If when={timelineData().bars.length > 0} else={<Empty icon="clock">{t("web.note.base.empty")}</Empty>}>
                  <View class="overflow-hidden rounded-lg border border-line bg-page">
                    <View class="flex-row items-center border-b border-line bg-side px-3 py-2">
                      <View class="w-48 shrink-0">
                        <Text class="text-xs font-semibold text-muted">{t("web.note.page.title")}</Text>
                      </View>
                      <View class="relative h-5 min-w-0 flex-1 flex-row items-center">
                        <Each of={timelineData().ticks} key={(tk) => tk.key}>
                          {(tk) => (
                            <Text class="absolute font-mono text-2xs text-faint tabular-nums" style={{ left: `${tk().leftPct}%` }}>
                              {tk().label}
                            </Text>
                          )}
                        </Each>
                      </View>
                    </View>

                    <Each of={timelineData().bars} key={(b) => b.row.id}>
                      {(bar) => {
                        const selected = () => selectedRowId() === bar().row.id;
                        return (
                          <View
                            role="button"
                            testID={`base-timeline-row-${bar().row.id}`}
                            onPress={() => selectedRowId.set(bar().row.id)}
                            class={`flex-row items-center border-t border-line px-3 py-2 ${selected() ? "bg-selected" : "bg-page hover:bg-hover"}`}
                          >
                            <View class="w-48 shrink-0 flex-row items-center gap-1.5 pr-3">
                              <Text class="min-w-0 flex-1 truncate text-xs font-medium text-ink">{bar().title}</Text>
                              <If when={bar().row.pageNoteId}>
                                <Icon name="notes" size={11} tone="accent" />
                              </If>
                            </View>
                            <View class="relative h-7 min-w-0 flex-1 justify-center rounded-sm bg-side">
                              <View
                                class="absolute h-5 flex-row items-center rounded-sm border border-accent bg-ok-soft px-2"
                                style={{ left: `${bar().leftPct}%`, width: `${bar().widthPct}%` }}
                              >
                                <Text class="truncate font-mono text-2xs font-medium text-ok-ink tabular-nums">{bar().dateLabel}</Text>
                              </View>
                            </View>
                          </View>
                        );
                      }}
                    </Each>
                  </View>
                </If>
              </Scroll>
            </If>
          </If>
        </View>

        <BaseRowDrawer
          row={drawerRow()}
          columns={columns()}
          notes={props.notes}
          issues={props.issues}
          agents={agents()}
          notesById={notesById()}
          issuesById={issuesById()}
          agentsById={agentsById()}
          busy={isBusy()}
          canCreatePage={props.onCreatePageForRow !== undefined}
          onClose={() => selectedRowId.set(undefined)}
          onCommitCell={commitCell}
          onRunAgentRow={(colId, rowId) => runAgentColumn(colId, [rowId])}
          onOpenNote={props.onOpenNote}
          onOpenIssue={props.onOpenIssue}
          onCreatePageForRow={props.onCreatePageForRow}
        />
      </View>
    </View>
  );
}
