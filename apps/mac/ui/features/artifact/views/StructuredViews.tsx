import { computed, Scroll, signal, Text, untracked, View } from "nsh";
import { Input } from "nsh/base";
import { z } from "zod";

import { t } from "@vibevalley/i18n";

import { Button } from "../../../design/Button";
import { Chart } from "../../../design/code/Chart";
import { Diagram } from "../../../design/code/Diagram";
import { IconButton } from "../../../design/IconButton";
import { Empty } from "../../../design/layout";
import { formatCellValue } from "../store";
import {
  asString,
  buildDashboardChartSpec,
  computeDashboardKpi,
  computeSheetNumericTotals,
  type DashboardDataset,
  type DiagramModel,
  diagramToMermaid,
} from "./previewModel";

const ChartSpecObjectSchema = z.object({}).loose();

/** Turns a raw dataset filename such as `sample.json` or `slo_metrics.json` into a clean display label. */
export function formatDatasetLabel(name: string): string {
  const base = name.replace(/\.(?:json|csv|tsv)$/iu, "").trim();
  if (!base) return name;
  const words = base.replace(/[_-]+/gu, " ").split(/\s+/u).filter(Boolean);
  if (words.length === 0) return name;
  return words.map((word) => (word === word.toUpperCase() ? word : word.charAt(0).toUpperCase() + word.slice(1))).join(" ");
}

function sizeChartSpec(spec: string | undefined, width: number): string | undefined {
  if (spec === undefined) return undefined;
  try {
    const parsed = ChartSpecObjectSchema.safeParse(JSON.parse(spec));
    if (!parsed.success) return spec;
    return JSON.stringify({ ...parsed.data, width });
  } catch (e) {
    if (e instanceof SyntaxError) return spec;
    throw e;
  }
}

export function DashboardView(props: {
  readonly panels: readonly Record<string, unknown>[];
  readonly datasets: readonly DashboardDataset[];
  readonly busy: boolean;
  readonly onExportCsv: (name: string, rows: readonly Record<string, unknown>[]) => void;
}) {
  const datasetsByPath = computed(() => new Map(props.datasets.map((d) => [d.path, d])));
  const viewportWidth = signal<number | undefined>(undefined);
  // Quantize to 16px steps so resizing does not thrash the native SVG chart cache.
  const chartWidth = computed(() => {
    const raw = viewportWidth();
    if (raw === undefined || raw <= 0) return 680;
    const inner = Math.max(360, Math.min(1280, raw - 40));
    return Math.floor(inner / 16) * 16;
  });

  return (
    <Scroll
      testID="artifact-dashboard-view"
      onLayout={(e) => {
        const w = Math.floor(e.bounds.size.width);
        if (w > 0 && w !== untracked(viewportWidth)) viewportWidth.set(w);
      }}
      class="min-h-0 flex-1"
      contentClass="gap-4 p-5"
    >
      <View class="flex-row flex-wrap gap-3">
        <Each of={props.panels} key={(p) => asString(p.id, "panel")}>
          {(panel) => {
            const kpi = () => computeDashboardKpi(panel(), datasetsByPath());
            return (
              <View testID={`dashboard-panel-${asString(panel().id, "panel")}`} class="min-w-44 flex-1 gap-1.5 rounded-lg border border-line bg-side p-3.5">
                <View class="flex-row items-center justify-between gap-2">
                  <Text class="truncate text-xs font-medium text-muted">{asString(panel().label, asString(panel().id))}</Text>
                  <View class="rounded-xs border border-line bg-page px-1.5 py-px">
                    <Text class="font-mono text-2xs text-faint">{kpi().agg}</Text>
                  </View>
                </View>
                <Text class="text-2xl font-semibold text-ink tabular-nums">{kpi().formatted}</Text>
              </View>
            );
          }}
        </Each>
      </View>

      <Each of={props.datasets} key={(ds) => ds.path}>
        {(ds) => {
          const schemaLabels = () => new Map(ds().schema.map((s) => [s.name, s.label || s.name]));
          const numericCols = () =>
            new Set(
              ds()
                .schema.filter((s) => s.type === "number")
                .map((s) => s.name),
            );
          const datasetLabel = () => formatDatasetLabel(ds().name);
          const chartSpec = () => sizeChartSpec(buildDashboardChartSpec(ds()), chartWidth());
          return (
            <View class="gap-3">
              <If when={chartSpec()}>
                {(spec) => (
                  <View testID={`dashboard-chart-${ds().name}`} class="w-full">
                    <Chart spec={spec()} title={datasetLabel()} class="my-0" />
                  </View>
                )}
              </If>
              <View class="overflow-hidden rounded-lg border border-line bg-page">
                <View class="flex-row items-center justify-between gap-2 border-b border-line bg-side px-3 py-2">
                  <Text testID={`dashboard-dataset-label-${ds().name}`} class="min-w-0 flex-1 truncate text-xs font-semibold text-ink">
                    {datasetLabel()}
                  </Text>
                  <IconButton
                    icon="download"
                    size={14}
                    label={t("web.artifact.dashboard.exportCsv")}
                    disabled={props.busy}
                    onClick={() => props.onExportCsv(ds().name, ds().rows)}
                  />
                </View>
                <View class="flex-row gap-3 border-b border-line bg-page px-3 py-1.5">
                  <Each of={ds().cols} key={(col) => col}>
                    {(col) => (
                      <Text class={`min-w-0 flex-1 truncate text-xs font-semibold text-muted ${numericCols().has(col()) ? "text-right" : ""}`}>
                        {schemaLabels().get(col()) ?? col()}
                      </Text>
                    )}
                  </Each>
                </View>
                <Each of={ds().rows.slice(0, 30)} key={(_, idx) => String(idx)}>
                  {(row) => (
                    <View class="flex-row gap-3 border-t border-line px-3 py-1.5 hover:bg-hover">
                      <Each of={ds().cols} key={(col) => col}>
                        {(col) => (
                          <Text class={`min-w-0 flex-1 truncate text-xs text-ink ${numericCols().has(col()) ? "text-right font-mono tabular-nums" : ""}`}>
                            {formatCellValue(row()[col()])}
                          </Text>
                        )}
                      </Each>
                    </View>
                  )}
                </Each>
              </View>
            </View>
          );
        }}
      </Each>
    </Scroll>
  );
}

export type DiagramMode = "visual" | "structure";

export function DiagramView(props: { readonly data: DiagramModel; readonly mode: DiagramMode; readonly mmdSource?: string | undefined }) {
  const mermaidSource = computed(() => {
    const raw = props.mmdSource?.trim();
    if (raw) return raw;
    return diagramToMermaid(props.data);
  });

  return (
    <Scroll testID="artifact-diagram-view" class="min-h-0 flex-1" contentClass="gap-4 p-5">
      <If when={props.mode === "visual" && mermaidSource().length > 0}>
        <View class="rounded-xl border border-line bg-side p-4">
          <Diagram source={mermaidSource()} interactive />
        </View>
      </If>

      <If when={props.mode === "structure" || mermaidSource().length === 0}>
        <View class="gap-3">
          <Text class="text-xs font-semibold text-muted">{`${t("web.artifact.diagram.nodes")} (${props.data.nodes.length})`}</Text>
          <View class="flex-row flex-wrap gap-2.5">
            <Each of={props.data.nodes} key={(n) => n.id}>
              {(n) => (
                <View class="min-w-36 gap-0.5 rounded-lg border border-line bg-side px-3 py-2">
                  <Text class="text-xs font-semibold text-ink">{n().label}</Text>
                  <Text class="font-mono text-2xs text-muted">{`${n().id} · ${n().kind}`}</Text>
                </View>
              )}
            </Each>
          </View>
          <If when={props.data.edges.length > 0}>
            <Text class="text-xs font-semibold text-muted">{`${t("web.artifact.diagram.edges")} (${props.data.edges.length})`}</Text>
            <View class="gap-1.5 rounded-lg border border-line bg-page p-3">
              <Each of={props.data.edges} key={(e) => e.id}>
                {(e) => (
                  <View class="flex-row items-center gap-2">
                    <Text class="font-mono text-xs font-medium text-ink">{e().from}</Text>
                    <Text class="font-mono text-2xs text-accent">{e().label ? `— ${e().label} →` : "→"}</Text>
                    <Text class="font-mono text-xs font-medium text-ink">{e().to}</Text>
                  </View>
                )}
              </Each>
            </View>
          </If>
        </View>
      </If>
    </Scroll>
  );
}

export interface SheetTab {
  readonly id: string;
  readonly title: string;
  readonly file: string;
  readonly columns: readonly { readonly key: string; readonly title: string; readonly type: string }[];
  readonly rows: readonly Record<string, unknown>[];
}

export function SheetView(props: {
  readonly sheets: readonly SheetTab[];
  readonly activeIndex: number;
  readonly filter: string;
  readonly readOnly: boolean;
  readonly onSelectSheet: (idx: number) => void;
  readonly onUpdateCell: (sheet: SheetTab, rowIndex: number, colKey: string, value: string, colType: string) => void;
}) {
  const editingCell = signal<{ readonly rowIdx: number; readonly colKey: string } | undefined>(undefined);
  const editingVal = signal("");

  const currentSheet = () => {
    if (props.sheets.length === 0) return undefined;
    const idx = Math.max(0, Math.min(props.activeIndex, props.sheets.length - 1));
    return props.sheets[idx];
  };

  const indexedRows = computed(() => {
    const sh = currentSheet();
    if (!sh) return [];
    const q = props.filter.trim().toLowerCase();
    return sh.rows
      .map((row, idx) => ({ row, idx }))
      .filter(
        (entry) =>
          !q ||
          sh.columns.some((c) =>
            formatCellValue(entry.row[c.key] ?? entry.row[c.title])
              .toLowerCase()
              .includes(q),
          ),
      );
  });

  const commitCell = (sh: SheetTab, rowIdx: number, colKey: string, colType: string) => {
    const active = untracked(editingCell);
    if (!active || active.rowIdx !== rowIdx || active.colKey !== colKey) return;
    const val = untracked(editingVal);
    editingCell.set(undefined);
    props.onUpdateCell(sh, rowIdx, colKey, val, colType);
  };

  return (
    <View testID="artifact-sheet-view" class="min-h-0 flex-1">
      <Scroll class="min-h-0 flex-1" contentClass="gap-1 p-4">
        <If when={currentSheet()} else={<Empty icon="log">{t("web.artifact.sheet.empty")}</Empty>}>
          {(sh) => {
            const numericTotals = () =>
              computeSheetNumericTotals(
                sh().columns,
                indexedRows().map((e) => e.row),
              );
            return (
              <View class="overflow-hidden rounded-lg border border-line bg-page">
                <View class="flex-row border-b border-line bg-side px-3 py-2">
                  <Text class="w-8 shrink-0 font-mono text-2xs font-semibold text-faint">#</Text>
                  <Each of={sh().columns} key={(col) => col.key}>
                    {(col) => (
                      <Text class={`min-w-0 flex-1 truncate text-xs font-semibold text-ink ${col().type === "number" ? "text-right" : ""}`}>{col().title}</Text>
                    )}
                  </Each>
                </View>
                <Each of={indexedRows()} key={(entry) => String(entry.idx)}>
                  {(entry) => (
                    <View class="flex-row items-center border-t border-line px-3 py-1.5 hover:bg-hover">
                      <Text class="w-8 shrink-0 font-mono text-2xs text-faint tabular-nums">{String(entry().idx + 1)}</Text>
                      <Each of={sh().columns} key={(col) => col.key}>
                        {(col) => {
                          const isEditing = () => editingCell()?.rowIdx === entry().idx && editingCell()?.colKey === col().key;
                          const cellText = () => formatCellValue(entry().row[col().key] ?? entry().row[col().title]);
                          return (
                            <View class="min-w-0 flex-1 px-1">
                              <If
                                when={isEditing() && !props.readOnly}
                                else={
                                  <View
                                    role="button"
                                    testID={`sheet-cell-${entry().idx}-${col().key}`}
                                    onPress={() => {
                                      if (props.readOnly) return;
                                      editingCell.set({ rowIdx: entry().idx, colKey: col().key });
                                      editingVal.set(cellText());
                                    }}
                                    class="rounded-xs px-1 py-0.5 hover:bg-selected"
                                  >
                                    <Text class={`truncate font-mono text-xs text-ink ${col().type === "number" ? "text-right tabular-nums" : ""}`}>
                                      {cellText() || "—"}
                                    </Text>
                                  </View>
                                }
                              >
                                <Input
                                  autoFocus
                                  testID={`sheet-cell-input-${entry().idx}-${col().key}`}
                                  value={editingVal()}
                                  submitBehavior="submit"
                                  onChange={(e) => editingVal.set(e.value)}
                                  onSubmit={() => commitCell(sh(), entry().idx, col().key, col().type)}
                                  onKeyPress={(e) => {
                                    if (e.key === "Escape") editingCell.set(undefined);
                                  }}
                                  onBlur={() => commitCell(sh(), entry().idx, col().key, col().type)}
                                  class="h-6 w-full rounded-xs border border-focus bg-page px-1 font-mono text-xs text-ink"
                                />
                              </If>
                            </View>
                          );
                        }}
                      </Each>
                    </View>
                  )}
                </Each>
                <If when={numericTotals().size > 0}>
                  <View class="flex-row items-center border-t border-line bg-side px-3 py-1.5">
                    <Text class="w-8 shrink-0 font-mono text-2xs font-semibold text-muted">Σ</Text>
                    <Each of={sh().columns} key={(col) => col.key}>
                      {(col) => (
                        <Text
                          class={`min-w-0 flex-1 truncate px-1 font-mono text-xs font-semibold text-ink tabular-nums ${col().type === "number" ? "text-right" : ""}`}
                        >
                          {numericTotals().get(col().key) ?? ""}
                        </Text>
                      )}
                    </Each>
                  </View>
                </If>
              </View>
            );
          }}
        </If>
      </Scroll>

      <If when={props.sheets.length > 1}>
        <View testID="sheet-tabs-bar" class="h-8 shrink-0 flex-row items-center justify-between gap-2 border-t border-line bg-side px-3">
          <View class="min-w-0 flex-1 flex-row items-center gap-1 overflow-hidden">
            <Each of={props.sheets} key={(s) => s.id}>
              {(sh, idx) => (
                <Button
                  size="compact"
                  tone={props.activeIndex === idx() ? "primary" : "plain"}
                  onPress={() => {
                    editingCell.set(undefined);
                    props.onSelectSheet(idx());
                  }}
                >
                  {sh().title}
                </Button>
              )}
            </Each>
          </View>
          <Text class="shrink-0 font-mono text-2xs text-muted tabular-nums">{t("web.artifact.sheet.rowsCount", { n: indexedRows().length })}</Text>
        </View>
      </If>
    </View>
  );
}
