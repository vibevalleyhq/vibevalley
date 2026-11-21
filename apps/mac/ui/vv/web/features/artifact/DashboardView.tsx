import { Scroll, Text, View } from "nsh";

import { type StoreProvenanceMark, storeMessageOf } from "@vibevalley/artifact/viewers";
import { t } from "@vibevalley/i18n";

import { createEffect, createMemo, createSignal } from "../../../solid";
import { createAct } from "../../ui/act";
import { Button } from "../../ui/Button";
import { TextArea } from "../../ui/Field";
import { Icon } from "../../ui/Icon";
import { IconButton } from "../../ui/IconButton";
import { toast } from "../../ui/toasts";
import type { Frame } from "./frame";
import { HtmlFrame } from "./HtmlFrame";
import { exportCsvFile, formatCellValue, useReportViewContext, useStoreEntries } from "./store";
import type { StoreViewerProps } from "./StoreArtifactView";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseDatasetRows(raw: string | undefined): Record<string, unknown>[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter(isRecord);
    if (isRecord(parsed) && Array.isArray(parsed.rows)) return parsed.rows.filter(isRecord);
    return [];
  } catch (e) {
    if (e instanceof SyntaxError) return [];
    throw e;
  }
}

type DrawerState = { readonly tag: "closed" } | { readonly tag: "browse" } | { readonly tag: "editJson"; readonly draft: string };

export function DashboardView(props: StoreViewerProps) {
  const { client, snapshot } = useStoreEntries(() => props.artifact.id);
  const [frame, setFrame] = createSignal<Frame>();
  const [drawer, setDrawer] = createSignal<DrawerState>({ tag: "closed" });
  const [highlight, setHighlight] = createSignal(false);
  const [selectedDataset, setSelectedDataset] = createSignal<string>();
  const [marks, setMarks] = createSignal<readonly StoreProvenanceMark[]>([]);
  const [verified, setVerified] = createSignal(0);
  const [mismatches, setMismatches] = createSignal(0);
  const act = createAct();

  const drawerOpen = () => drawer().tag !== "closed";
  const seq = () => (snapshot().seq > 0 ? snapshot().seq : props.artifact.seq);

  const datasetNames = createMemo(() =>
    [...snapshot().entries.keys()]
      .filter((p) => p.startsWith("datasets/"))
      .map((p) => p.slice("datasets/".length))
      .toSorted(),
  );
  const activeDataset = () => {
    const chosen = selectedDataset();
    const all = datasetNames();
    return chosen && all.includes(chosen) ? chosen : all[0];
  };
  const activeRows = createMemo(() => {
    const ds = activeDataset();
    if (!ds) return [];
    return parseDatasetRows(snapshot().entries.get(`datasets/${ds}`)?.value);
  });
  const activeCols = createMemo(() => [
    ...new Set(
      activeRows()
        .slice(0, 50)
        .flatMap((r) => Object.keys(r)),
    ),
  ]);

  useReportViewContext(
    () => props.artifact.id,
    () => {
      const ds = activeDataset();
      return {
        artifactType: "dashboard",
        title: props.artifact.title,
        seq: seq(),
        ...(ds ? { activeDataset: ds } : {}),
      };
    },
  );

  createEffect(
    () => [highlight(), activeDataset(), drawerOpen()] as const,
    ([on, ds, open]) => {
      frame()?.send({ vibevalley: "dash-highlight", on, source: open && ds ? ds : "" });
    },
  );

  const handleMessage = (raw: unknown) => {
    const msg = storeMessageOf(raw);
    if (!msg) return;
    if (msg.vibevalley === "store-provenance") {
      setMarks(msg.marks);
      setVerified(msg.verified);
      setMismatches(msg.mismatches);
    } else if (msg.vibevalley === "store-mark-click") {
      if (msg.source) setSelectedDataset(msg.source);
      setDrawer({ tag: "browse" });
    } else if (msg.vibevalley === "store-params") {
      const nextJson = JSON.stringify(msg.params);
      if (snapshot().entries.get("dash/params")?.value !== nextJson && !act.busy()) {
        void act.run(() => client.batch([{ op: "set", path: "dash/params", kind: "json", value: nextJson }]));
      }
    }
  };

  const resetParams = () => {
    frame()?.send({ vibevalley: "dash-reset-params" });
    void act.run(() => client.batch([{ op: "set", path: "dash/params", kind: "json", value: "{}" }]));
  };

  const openJsonEditor = () => {
    const ds = activeDataset();
    if (!ds) return;
    setDrawer({ tag: "editJson", draft: snapshot().entries.get(`datasets/${ds}`)?.value ?? "[]" });
  };

  const saveDatasetJson = () => {
    const ds = activeDataset();
    const cur = drawer();
    if (!ds || cur.tag !== "editJson") return;
    const raw = cur.draft;
    void act.run(async () => {
      await client.batch([{ op: "set", path: `datasets/${ds}`, kind: "json", value: raw }]);
      setDrawer({ tag: "browse" });
      toast(t("web.artifact.dashboard.savedDataset"));
    });
  };

  const editDraft = () => {
    const s = drawer();
    return s.tag === "editJson" ? s.draft : undefined;
  };

  return (
    <View testID="dashboard-view" class="min-h-0 min-w-0 flex-1">
      <View class="min-h-11 shrink-0 flex-row flex-wrap items-center gap-2 border-b border-line bg-page px-3 py-2">
        <If when={marks().length > 0}>
          <View
            testID="dashboard-provenance-badge"
            class={`h-6 flex-row items-center gap-1.5 rounded-full px-2.5 ${mismatches() > 0 ? "bg-bad-soft" : "bg-ok-soft"}`}
          >
            <Icon name={mismatches() > 0 ? "cross" : "check"} size={12} />
            <Text class={`text-xs font-medium tabular-nums ${mismatches() > 0 ? "text-berry" : "text-ok-ink"}`}>
              {mismatches() > 0
                ? t("web.artifact.dashboard.mismatches", { n: mismatches() })
                : t("web.artifact.dashboard.verified", { ok: verified(), total: marks().length })}
            </Text>
          </View>
        </If>

        <View class="ml-auto flex-row flex-wrap items-center gap-1.5">
          <Button icon="understand" testID="dashboard-highlight" onPress={() => setHighlight((v) => !v)}>
            {t("web.artifact.dashboard.highlightMarks")}
          </Button>
          <Button icon="undo" testID="dashboard-reset-params" disabled={act.busy()} onPress={resetParams}>
            {t("web.artifact.dashboard.resetParams")}
          </Button>
          <Button
            icon="catalog"
            testID="dashboard-sources-toggle"
            onPress={() => setDrawer((s) => (s.tag === "closed" ? { tag: "browse" } : { tag: "closed" }))}
          >
            {drawerOpen() ? t("web.artifact.dashboard.hideSources") : t("web.artifact.dashboard.sources")}
          </Button>
        </View>
      </View>

      <If when={snapshot().error}>
        {(err) => (
          <View class="border-b border-line bg-bad-soft px-3 py-2">
            <Text class="text-xs font-medium text-berry">{err()}</Text>
          </View>
        )}
      </If>

      <View class="min-h-0 flex-1 lg:flex-row">
        <HtmlFrame
          artifact={props.artifact}
          version={seq()}
          viewSeq={seq()}
          title={props.artifact.title}
          testId="dashboard-frame"
          frameClass={props.frameClass ?? "min-h-0 w-full flex-1 bg-page"}
          hideControls
          covered={props.covered}
          onFrame={(f) => setFrame(f)}
          onMessage={handleMessage}
          onPresent={props.onPresent}
        />

        <If when={drawerOpen()}>
          <View testID="dashboard-sources" class="max-h-96 shrink-0 border-t border-line bg-side lg:max-h-none lg:w-96 lg:border-t-0 lg:border-l">
            <View class="shrink-0 flex-row items-center justify-between gap-2 border-b border-line bg-page px-3 py-2">
              <View class="flex-row items-center gap-1.5">
                <Text class="text-xs font-semibold text-muted">{t("web.artifact.dashboard.sources")}</Text>
                <If when={datasetNames().length > 0}>
                  <View class="rounded-full bg-hover px-1.5 py-px">
                    <Text class="font-mono text-2xs text-muted tabular-nums">{String(datasetNames().length)}</Text>
                  </View>
                </If>
              </View>
              <IconButton icon="close" size={14} label={t("web.artifact.dashboard.hideSources")} onClick={() => setDrawer({ tag: "closed" })} />
            </View>
            <Scroll class="min-h-0 flex-1" contentClass="gap-3 p-3">
              <If
                when={datasetNames().length > 0}
                else={
                  <View class="rounded-md bg-page px-3 py-2.5">
                    <Text class="text-xs text-muted">{t("web.artifact.dashboard.noDatasets")}</Text>
                  </View>
                }
              >
                <View class="flex-row flex-wrap items-center gap-1">
                  <Each of={datasetNames()}>
                    {(ds) => {
                      const active = () => ds() === activeDataset();
                      return (
                        <View
                          role="button"
                          testID="dashboard-dataset-tab"
                          accessibilityState={{ selected: active() }}
                          onPress={() => {
                            setSelectedDataset(ds());
                            setDrawer({ tag: "browse" });
                          }}
                          class={`h-7 justify-center rounded-md px-2.5 transition duration-120 ease-out focus-visible:outline-2 focus-visible:outline-focus ${
                            active() ? "bg-selected" : "hover:bg-hover"
                          }`}
                        >
                          <Text class={`text-xs font-medium ${active() ? "text-ink" : "text-muted"}`}>{ds()}</Text>
                        </View>
                      );
                    }}
                  </Each>
                </View>

                <If when={activeDataset()}>
                  {(ds) => (
                    <View class="gap-3">
                      <View class="flex-row items-center justify-between gap-2">
                        <Text class="font-mono text-xs text-muted tabular-nums">{t("web.artifact.dashboard.rows", { n: activeRows().length })}</Text>
                        <View class="flex-row items-center gap-1.5">
                          <Button
                            icon="download"
                            size="compact"
                            testID="dashboard-export-csv"
                            disabled={act.busy()}
                            onPress={() => void act.run(() => exportCsvFile(ds(), activeRows()))}
                          >
                            {t("web.artifact.dashboard.exportCsv")}
                          </Button>
                          <Button icon="edit" size="compact" testID="dashboard-edit-json" onPress={openJsonEditor}>
                            {t("web.artifact.dashboard.editJson")}
                          </Button>
                        </View>
                      </View>

                      <If when={editDraft()}>
                        {(draft) => (
                          <View class="gap-2 rounded-md border border-line bg-page p-2.5">
                            <TextArea rows={7} value={draft()} onInput={(val) => setDrawer({ tag: "editJson", draft: val })} class="font-mono text-xs" />
                            <View class="flex-row items-center justify-end gap-1.5">
                              <Button tone="quiet" onPress={() => setDrawer({ tag: "browse" })}>
                                {t("web.base.form.never")}
                              </Button>
                              <Button tone="primary" testID="dashboard-save-json" disabled={act.busy()} onPress={saveDatasetJson}>
                                {t("web.artifact.dashboard.saveDataset")}
                              </Button>
                            </View>
                          </View>
                        )}
                      </If>

                      <If when={activeCols().length > 0}>
                        <View class="overflow-hidden rounded-md border border-line bg-page">
                          <Scroll horizontal>
                            <View>
                              <View class="min-h-8 flex-row items-center bg-side">
                                <Each of={activeCols()}>
                                  {(col) => (
                                    <View class="w-28 shrink-0 px-2.5 py-1.5">
                                      <Text class="truncate text-xs font-semibold text-muted">{col()}</Text>
                                    </View>
                                  )}
                                </Each>
                              </View>
                              <Each of={activeRows().slice(0, 30)}>
                                {(row) => (
                                  <View class="min-h-8 flex-row items-center border-t border-line bg-page transition duration-120 ease-out hover:bg-hover">
                                    <Each of={activeCols()}>
                                      {(col) => (
                                        <View class="w-28 shrink-0 px-2.5 py-1.5">
                                          <Text class="truncate font-mono text-xs text-ink tabular-nums">{formatCellValue(row()[col()])}</Text>
                                        </View>
                                      )}
                                    </Each>
                                  </View>
                                )}
                              </Each>
                            </View>
                          </Scroll>
                        </View>
                      </If>
                    </View>
                  )}
                </If>
              </If>
            </Scroll>
          </View>
        </If>
      </View>
    </View>
  );
}
