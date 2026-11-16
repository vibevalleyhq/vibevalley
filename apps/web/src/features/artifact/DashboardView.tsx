import type { JSX } from "@solidjs/web";
import { createEffect, createMemo, createSignal, For, onSettled, Show } from "solid-js";

import { type StoreProvenanceMark, storeMessageOf, storeViewUrl } from "@vibevalley/artifact/viewers";
import { t } from "@vibevalley/i18n";
import type { Artifact } from "@vibevalley/protocol";
import { htmlSandbox } from "@vibevalley/protocol/rules";

import { shownTheme } from "#/state/prefs.ts";
import { createAct } from "#/ui/act.ts";
import { Button } from "#/ui/Button.tsx";
import { TextArea } from "#/ui/Field.tsx";
import { Icon } from "#/ui/Icon.tsx";
import { toast } from "#/ui/toasts.ts";

import { exportCsvFile, formatCellValue, useReportViewContext, useStoreEntries } from "./store";

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

export function DashboardView(props: { artifact: Artifact; frameStyle?: JSX.ClassValue }) {
  const { client, snapshot } = useStoreEntries(() => props.artifact.id);
  const [frame, setFrame] = createSignal<HTMLIFrameElement>();
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
      frame()?.contentWindow?.postMessage({ vibevalley: "dash-highlight", on, source: open && ds ? ds : "" }, "*");
    },
  );

  onSettled(() => {
    const heard = (e: MessageEvent) => {
      if (e.source === null || e.source !== frame()?.contentWindow) return;
      const msg = storeMessageOf(e.data);
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
    window.addEventListener("message", heard);
    return () => window.removeEventListener("message", heard);
  });

  const resetParams = () => {
    frame()?.contentWindow?.postMessage({ vibevalley: "dash-reset-params" }, "*");
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

  return (
    <div data-testid="dashboard-view" class="flex min-h-0 min-w-0 flex-1 flex-col">
      <div class="flex shrink-0 flex-wrap items-center gap-2 border-b border-line bg-page px-3 py-2">
        <Show when={marks().length > 0}>
          <span
            data-testid="dashboard-provenance-badge"
            class={[
              "inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium",
              mismatches() > 0 ? "bg-bad-soft text-berry" : "bg-ok-soft text-ok-ink",
            ]}
          >
            <Icon name={mismatches() > 0 ? "warn" : "check"} size={12} />
            {mismatches() > 0
              ? t("web.artifact.dashboard.mismatches", { n: mismatches() })
              : t("web.artifact.dashboard.verified", { ok: verified(), total: marks().length })}
          </span>
        </Show>
        <div class="ml-auto flex flex-wrap items-center gap-1.5">
          <Button icon="understand" data-testid="dashboard-highlight" onClick={() => setHighlight((v) => !v)}>
            {t("web.artifact.dashboard.highlightMarks")}
          </Button>
          <Button icon="undo" data-testid="dashboard-reset-params" disabled={act.busy()} onClick={resetParams}>
            {t("web.artifact.dashboard.resetParams")}
          </Button>
          <Button
            icon="catalog"
            data-testid="dashboard-sources-toggle"
            onClick={() => setDrawer((s) => (s.tag === "closed" ? { tag: "browse" } : { tag: "closed" }))}
          >
            {drawerOpen() ? t("web.artifact.dashboard.hideSources") : t("web.artifact.dashboard.sources")}
          </Button>
        </div>
      </div>

      <div class="flex min-h-0 flex-1 flex-col lg:flex-row">
        <iframe
          ref={setFrame}
          data-testid="dashboard-frame"
          title={props.artifact.title}
          src={storeViewUrl(props.artifact.id, { theme: shownTheme(), seq: seq() })}
          sandbox={htmlSandbox}
          referrerpolicy="no-referrer"
          class={props.frameStyle ?? "min-h-[54vh] xl:min-h-0 w-full flex-1 border-0 bg-page"}
        />

        <Show when={drawerOpen()}>
          <aside
            data-testid="dashboard-sources"
            class="flex max-h-96 lg:max-h-none lg:w-96 shrink-0 flex-col gap-3 overflow-y-auto border-t lg:border-t-0 lg:border-l border-line bg-side p-3"
          >
            <Show when={datasetNames().length > 0} fallback={<p class="text-xs text-muted">{t("web.artifact.dashboard.noDatasets")}</p>}>
              <div class="flex flex-wrap items-center gap-1">
                <For each={datasetNames()}>
                  {(ds) => (
                    <button
                      type="button"
                      data-testid="dashboard-dataset-tab"
                      data-key={ds}
                      onClick={() => {
                        setSelectedDataset(ds);
                        setDrawer({ tag: "browse" });
                      }}
                      class={[
                        "cursor-pointer rounded-md px-2.5 py-1 text-xs font-medium",
                        ds === activeDataset() ? "bg-selected text-ink" : "text-muted hover:bg-hover hover:text-ink",
                      ]}
                    >
                      {ds}
                    </button>
                  )}
                </For>
              </div>

              <Show when={activeDataset()}>
                {(ds) => (
                  <>
                    <div class="flex items-center justify-between gap-2">
                      <span class="tabular-nums text-xs text-muted">{t("web.artifact.dashboard.rows", { n: activeRows().length })}</span>
                      <div class="flex items-center gap-1.5">
                        <Button icon="download" data-testid="dashboard-export-csv" onClick={() => exportCsvFile(ds(), activeRows())}>
                          {t("web.artifact.dashboard.exportCsv")}
                        </Button>
                        <Button icon="edit" data-testid="dashboard-edit-json" onClick={openJsonEditor}>
                          {t("web.artifact.dashboard.editJson")}
                        </Button>
                      </div>
                    </div>

                    <Show
                      when={(() => {
                        const s = drawer();
                        return s.tag === "editJson" ? s.draft : undefined;
                      })()}
                    >
                      {(draft) => (
                        <div class="flex flex-col gap-2 rounded-md border border-line bg-page p-2">
                          <TextArea
                            rows={7}
                            value={draft()}
                            onInput={(e) => setDrawer({ tag: "editJson", draft: e.currentTarget.value })}
                            class="font-mono text-xs"
                          />
                          <div class="flex justify-end gap-1.5">
                            <Button onClick={() => setDrawer({ tag: "browse" })}>{t("web.base.form.never")}</Button>
                            <Button tone="primary" data-testid="dashboard-save-json" disabled={act.busy()} onClick={saveDatasetJson}>
                              {t("web.artifact.dashboard.saveDataset")}
                            </Button>
                          </div>
                        </div>
                      )}
                    </Show>

                    <Show when={activeCols().length > 0}>
                      <div class="overflow-x-auto rounded-md border border-line bg-page">
                        <table class="w-full border-collapse text-left text-xs tabular-nums">
                          <thead>
                            <tr class="border-b border-line bg-side text-muted">
                              <For each={activeCols()}>{(col) => <th class="px-2 py-1.5 font-semibold">{col}</th>}</For>
                            </tr>
                          </thead>
                          <tbody>
                            <For each={activeRows().slice(0, 30)}>
                              {(row) => (
                                <tr class="border-b border-line last:border-b-0">
                                  <For each={activeCols()}>{(col) => <td class="max-w-36 truncate px-2 py-1 text-ink">{formatCellValue(row[col])}</td>}</For>
                                </tr>
                              )}
                            </For>
                          </tbody>
                        </table>
                      </div>
                    </Show>
                  </>
                )}
              </Show>
            </Show>
          </aside>
        </Show>
      </div>
    </div>
  );
}
