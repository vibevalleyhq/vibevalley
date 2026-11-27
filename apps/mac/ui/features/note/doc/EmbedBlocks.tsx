import { computed, Image, signal, Text, untracked, View, WebView } from "nsh";
import { Input } from "nsh/base";

import { t } from "@vibevalley/i18n";
import type { DocBlock, DocKpiItem, Issue, IssueId, IssueStatus, Note, NoteId } from "@vibevalley/protocol";

import { Button } from "../../../design/Button";
import { Chart } from "../../../design/code/Chart";
import { Diagram } from "../../../design/code/Diagram";
import { TextArea, TextInput } from "../../../design/Field";
import { useDesignHost } from "../../../design/host";
import { Icon } from "../../../design/Icon";
import { IconButton } from "../../../design/IconButton";
import type { Picture } from "../../../design/Lightbox";
import { Segmented } from "../../../design/Segmented";
import { Dot, type DotTone } from "../../../design/Tag";
import { buildChartSpecJson, filterIssuesForList, resolveIssueRef, updateKpiItem } from "./docOps";

export type KpiBlockData = Extract<DocBlock, { type: "kpi" }>;
export type ChartBlockData = Extract<DocBlock, { type: "chart" }>;
export type DiagramBlockData = Extract<DocBlock, { type: "diagram" }>;
export type CompareBlockData = Extract<DocBlock, { type: "compare" }>;
export type MediaBlockData = Extract<DocBlock, { type: "media" }>;
export type PreviewBlockData = Extract<DocBlock, { type: "preview" }>;
export type BaseEmbedBlockData = Extract<DocBlock, { type: "baseEmbed" }>;
export type IssueCardBlockData = Extract<DocBlock, { type: "issueCard" }>;
export type IssueListBlockData = Extract<DocBlock, { type: "issueList" }>;

const SANDBOX_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'";

const statusDotTone: Record<IssueStatus, DotTone> = {
  backlog: "faint",
  todo: "muted",
  in_progress: "water",
  in_review: "wheat",
  done: "leaf",
  canceled: "faint",
};

function sandboxHtmlForPreview(entry: string, title?: string): string {
  const safeEntry = entry.replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const safeTitle = (title || "Preview").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return `<!doctype html><html><head><meta charset="utf-8" /><meta http-equiv="Content-Security-Policy" content="${SANDBOX_CSP}" /></head><body style="font-family:system-ui;padding:16px;margin:0;"><div style="font-weight:600;margin-bottom:6px;">${safeTitle}</div><div style="font-family:monospace;font-size:12px;opacity:0.75;">${safeEntry}</div></body></html>`;
}

function statusLabel(status: IssueStatus): string {
  switch (status) {
    case "backlog":
      return t("shared.status.backlog");
    case "todo":
      return t("shared.status.todo");
    case "in_progress":
      return t("shared.status.in_progress");
    case "in_review":
      return t("shared.status.in_review");
    case "done":
      return t("shared.status.done");
    case "canceled":
      return t("shared.status.canceled");
  }
}

function kpiToneClass(tone: string | undefined): string {
  switch (tone) {
    case "ok":
      return "text-ok-ink";
    case "bad":
      return "text-berry";
    case "warn":
      return "text-warn-ink";
    default:
      return "text-muted";
  }
}

export function KpiBlockView(props: { readonly block: KpiBlockData; readonly onUpdate: (next: KpiBlockData) => void }) {
  const editing = signal(false);

  return (
    <View testID={`doc-kpi-${props.block.id}`} class="gap-2 rounded-lg border border-line bg-page p-2.5">
      <View class="flex-row items-center justify-between gap-2">
        <Text class="text-2xs font-semibold text-muted">KPI</Text>
        <View class="flex-row items-center gap-1">
          <Button
            size="compact"
            tone="quiet"
            icon="add"
            testID={`doc-kpi-add-${props.block.id}`}
            onPress={() => {
              const nextItem: DocKpiItem = { label: "Metric", value: "0", delta: "+0%", tone: "ok" };
              props.onUpdate({ ...props.block, items: [...props.block.items, nextItem] });
              editing.set(true);
            }}
          >
            Add
          </Button>
          <IconButton icon={editing() ? "check" : "edit"} size={14} label="Toggle edit KPI" onClick={() => editing.set(!editing())} />
        </View>
      </View>
      <View class="flex-row flex-wrap gap-2.5">
        <Each of={props.block.items} key={(_, idx) => String(idx)}>
          {(item, idx) => (
            <View class="min-w-36 flex-1 gap-1 rounded-md border border-line bg-side p-2.5">
              <If
                when={editing()}
                else={
                  <>
                    <Text class="truncate text-2xs font-medium text-muted">{item().label}</Text>
                    <View class="flex-row items-baseline justify-between gap-2">
                      <Text class="text-xl font-semibold text-ink tabular-nums">{item().value}</Text>
                      <If when={item().delta}>
                        {(d) => <Text class={`font-mono text-2xs font-medium tabular-nums ${kpiToneClass(item().tone)}`}>{d()}</Text>}
                      </If>
                    </View>
                  </>
                }
              >
                <View class="gap-1">
                  <Input
                    value={item().label}
                    placeholder="Label"
                    onChange={(e) => props.onUpdate({ ...props.block, items: updateKpiItem(props.block.items, idx(), { label: e.value }) })}
                    class="h-6 rounded-xs border border-line bg-page px-1.5 text-2xs text-ink"
                  />
                  <Input
                    value={item().value}
                    placeholder="Value"
                    onChange={(e) => props.onUpdate({ ...props.block, items: updateKpiItem(props.block.items, idx(), { value: e.value }) })}
                    class="h-6 rounded-xs border border-line bg-page px-1.5 font-mono text-xs text-ink"
                  />
                  <Input
                    value={item().delta ?? ""}
                    placeholder="Delta"
                    onChange={(e) => props.onUpdate({ ...props.block, items: updateKpiItem(props.block.items, idx(), { delta: e.value || undefined }) })}
                    class="h-6 rounded-xs border border-line bg-page px-1.5 font-mono text-2xs text-muted"
                  />
                </View>
              </If>
            </View>
          )}
        </Each>
      </View>
    </View>
  );
}

export function ChartBlockView(props: { readonly block: ChartBlockData; readonly onUpdate: (next: ChartBlockData) => void }) {
  const editing = signal(false);
  const specJson = computed(() => buildChartSpecJson(props.block));

  return (
    <View testID={`doc-chart-${props.block.id}`} class="gap-2 rounded-lg border border-line bg-side p-3">
      <View class="flex-row items-center justify-between gap-2">
        <Text class="truncate text-xs font-semibold text-ink">{props.block.title || "Chart"}</Text>
        <View class="flex-row items-center gap-1">
          <Each of={["bar", "line", "area"] as const} key={(kind) => kind}>
            {(kind) => (
              <View
                role="button"
                onPress={() => props.onUpdate({ ...props.block, kind: kind() })}
                class={`rounded-xs px-1.5 py-0.5 ${props.block.kind === kind() ? "bg-selected" : "hover:bg-hover"}`}
              >
                <Text class="font-mono text-2xs text-muted">{kind()}</Text>
              </View>
            )}
          </Each>
          <IconButton icon={editing() ? "show" : "edit"} size={14} label="Edit chart" onClick={() => editing.set(!editing())} />
        </View>
      </View>
      <If when={editing()}>
        <View class="gap-2 rounded-md border border-line bg-page p-2">
          <TextInput value={props.block.title ?? ""} placeholder="Chart title" onInput={(v) => props.onUpdate({ ...props.block, title: v || undefined })} />
          <TextInput
            value={props.block.labels.join(", ")}
            placeholder="Labels (comma-separated)"
            onInput={(v) =>
              props.onUpdate({
                ...props.block,
                labels: v
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean),
              })
            }
          />
        </View>
      </If>
      <Chart spec={specJson()} title={props.block.title} class="my-0" />
    </View>
  );
}

export function DiagramBlockView(props: { readonly block: DiagramBlockData; readonly onUpdate: (next: DiagramBlockData) => void }) {
  const editing = signal(untracked(() => props.block.source.trim() === ""));

  return (
    <View testID={`doc-diagram-${props.block.id}`} class="gap-2 rounded-lg border border-line bg-side p-3">
      <View class="flex-row items-center justify-between gap-2">
        <Text class="truncate text-xs font-semibold text-ink">{props.block.title || t("web.base.rich.diagram")}</Text>
        <Button size="compact" tone="quiet" icon={editing() ? "show" : "edit"} onPress={() => editing.set(!editing())}>
          {editing() ? t("web.base.rich.viewDiagram") : t("web.base.rich.viewSource")}
        </Button>
      </View>
      <If when={editing()} else={<Diagram source={props.block.source} interactive class="my-0" />}>
        <View class="gap-2">
          <TextInput value={props.block.title ?? ""} placeholder="Diagram title" onInput={(v) => props.onUpdate({ ...props.block, title: v || undefined })} />
          <TextArea
            rows={4}
            value={props.block.source}
            placeholder="flowchart LR..."
            onInput={(v) => props.onUpdate({ ...props.block, source: v })}
            class="font-mono text-xs"
          />
        </View>
      </If>
    </View>
  );
}

export function CompareBlockView(props: { readonly block: CompareBlockData; readonly onUpdate: (next: CompareBlockData) => void }) {
  const editing = signal(false);
  const mode = signal<"side" | "focus">("side");

  return (
    <View testID={`doc-compare-${props.block.id}`} class="gap-2 rounded-lg border border-line bg-side p-3">
      <View class="flex-row items-center justify-between gap-2">
        <View class="min-w-0 flex-1 flex-row items-center gap-1.5">
          <Icon name="diff" size={14} tone="muted" />
          <Text class="truncate text-xs font-semibold text-ink">{props.block.title || t("web.base.compare.title")}</Text>
        </View>
        <View class="flex-row items-center gap-1.5">
          <Segmented
            label={t("web.base.compare.modeLabel")}
            value={mode()}
            onChange={(m) => mode.set(m)}
            options={[
              { value: "side", label: t("web.base.compare.sideBySide") },
              { value: "focus", label: t("web.base.compare.after") },
            ]}
          />
          <IconButton icon={editing() ? "show" : "edit"} size={14} label="Edit compare" onClick={() => editing.set(!editing())} />
        </View>
      </View>
      <If when={editing()}>
        <View class="gap-2 rounded-md border border-line bg-page p-2">
          <TextInput value={props.block.title ?? ""} placeholder="Compare title" onInput={(v) => props.onUpdate({ ...props.block, title: v || undefined })} />
          <View class="flex-row gap-2">
            <TextInput
              wide={false}
              class="flex-1"
              value={props.block.beforeLabel}
              placeholder="Before label"
              onInput={(v) => props.onUpdate({ ...props.block, beforeLabel: v })}
            />
            <TextInput
              wide={false}
              class="flex-1"
              value={props.block.beforeAsset}
              placeholder="Before asset/url"
              onInput={(v) => props.onUpdate({ ...props.block, beforeAsset: v })}
            />
          </View>
          <View class="flex-row gap-2">
            <TextInput
              wide={false}
              class="flex-1"
              value={props.block.afterLabel}
              placeholder="After label"
              onInput={(v) => props.onUpdate({ ...props.block, afterLabel: v })}
            />
            <TextInput
              wide={false}
              class="flex-1"
              value={props.block.afterAsset}
              placeholder="After asset/url"
              onInput={(v) => props.onUpdate({ ...props.block, afterAsset: v })}
            />
          </View>
        </View>
      </If>
      <View class="flex-row gap-2">
        <If when={mode() === "side"}>
          <View class="min-w-0 flex-1 gap-1 rounded-md border border-line bg-page p-2">
            <Text class="text-2xs font-semibold text-muted">{props.block.beforeLabel || t("web.base.compare.before")}</Text>
            <If when={props.block.beforeAsset.trim().length > 0} else={<Text class="text-2xs text-faint">No before asset</Text>}>
              <Image src={props.block.beforeAsset} accessibilityLabel={props.block.beforeLabel} class="h-32 w-full rounded-sm object-contain" />
            </If>
          </View>
        </If>
        <View class="min-w-0 flex-1 gap-1 rounded-md border border-line bg-page p-2">
          <Text class="text-2xs font-semibold text-ok-ink">{props.block.afterLabel || t("web.base.compare.after")}</Text>
          <If when={props.block.afterAsset.trim().length > 0} else={<Text class="text-2xs text-faint">No after asset</Text>}>
            <Image src={props.block.afterAsset} accessibilityLabel={props.block.afterLabel} class="h-32 w-full rounded-sm object-contain" />
          </If>
        </View>
      </View>
    </View>
  );
}

export function MediaBlockView(props: {
  readonly block: MediaBlockData;
  readonly onUpdate: (next: MediaBlockData) => void;
  readonly onOpenLightbox?: ((pic: Picture) => void) | undefined;
}) {
  const host = useDesignHost();
  const editing = signal(untracked(() => props.block.src.trim() === ""));

  return (
    <View testID={`doc-media-${props.block.id}`} class="gap-2 rounded-lg border border-line bg-side p-3">
      <View class="flex-row items-center justify-between gap-2">
        <View class="flex-row items-center gap-1.5">
          <Icon name={props.block.mediaKind === "audio" ? "audio" : props.block.mediaKind === "video" ? "video" : "image"} size={14} tone="muted" />
          <Text class="font-mono text-2xs text-muted">{props.block.mediaKind || "image"}</Text>
        </View>
        <IconButton icon={editing() ? "show" : "edit"} size={14} label="Edit media" onClick={() => editing.set(!editing())} />
      </View>
      <If when={editing()}>
        <View class="gap-2 rounded-md border border-line bg-page p-2">
          <View class="flex-row gap-1">
            <Each of={["image", "audio", "video"] as const} key={(mk) => mk}>
              {(mk) => (
                <Button
                  size="compact"
                  tone={props.block.mediaKind === mk() ? "primary" : "plain"}
                  onPress={() => props.onUpdate({ ...props.block, mediaKind: mk() })}
                >
                  {mk()}
                </Button>
              )}
            </Each>
          </View>
          <TextInput value={props.block.src} placeholder="asset/hero.png or https://..." onInput={(v) => props.onUpdate({ ...props.block, src: v })} />
          <TextInput
            value={props.block.caption ?? ""}
            placeholder="Caption (optional)"
            onInput={(v) => props.onUpdate({ ...props.block, caption: v || undefined })}
          />
        </View>
      </If>
      <If when={props.block.src.trim().length > 0}>
        <If
          when={props.block.mediaKind === "image" || props.block.mediaKind === ""}
          else={
            <View
              role="button"
              onPress={() => void host.openExternal(props.block.src)}
              class="flex-row items-center gap-2 rounded-md border border-line bg-page px-3 py-2 hover:bg-hover"
            >
              <Icon name={props.block.mediaKind === "audio" ? "audio" : "video"} size={16} tone="accent" />
              <Text class="min-w-0 flex-1 truncate text-xs text-ink">{props.block.caption || props.block.src}</Text>
              <Icon name="open" size={12} tone="muted" />
            </View>
          }
        >
          <View
            role="button"
            onPress={() => props.onOpenLightbox?.({ src: props.block.src, name: props.block.caption || props.block.src })}
            class="overflow-hidden rounded-md border border-line bg-page hover:opacity-90"
          >
            <Image src={props.block.src} accessibilityLabel={props.block.caption || props.block.src} class="h-48 w-full object-contain" />
          </View>
        </If>
      </If>
      <If when={props.block.caption}>{(cap) => <Text class="text-xs text-muted">{cap()}</Text>}</If>
    </View>
  );
}

export function PreviewBlockView(props: { readonly block: PreviewBlockData; readonly onUpdate: (next: PreviewBlockData) => void }) {
  const editing = signal(false);
  const frameHeight = () => Math.max(120, Math.min(720, props.block.height ?? 260));
  const html = computed(() => sandboxHtmlForPreview(props.block.entry, props.block.title));

  return (
    <View testID={`doc-preview-${props.block.id}`} class="overflow-hidden rounded-lg border border-line bg-side">
      <View class="flex-row items-center justify-between gap-2 border-b border-line px-3 py-1.5">
        <View class="min-w-0 flex-1 flex-row items-center gap-1.5">
          <Icon name="web" size={14} tone="muted" />
          <Text class="truncate text-xs font-semibold text-ink">{props.block.title || "Sandbox Preview"}</Text>
          <Text class="truncate font-mono text-2xs text-faint">{props.block.entry}</Text>
        </View>
        <IconButton icon={editing() ? "show" : "edit"} size={14} label="Edit preview" onClick={() => editing.set(!editing())} />
      </View>
      <If when={editing()}>
        <View class="gap-2 border-b border-line bg-page p-2">
          <TextInput value={props.block.title ?? ""} placeholder="Preview title" onInput={(v) => props.onUpdate({ ...props.block, title: v || undefined })} />
          <TextInput value={props.block.entry} placeholder="structure/index.html" onInput={(v) => props.onUpdate({ ...props.block, entry: v })} />
        </View>
      </If>
      <WebView
        testID={`doc-preview-webview-${props.block.id}`}
        accessibilityLabel={props.block.title || props.block.entry}
        html={html()}
        incognito
        class="w-full bg-page"
        style={{ height: frameHeight() }}
      />
    </View>
  );
}

export function BaseEmbedBlockView(props: {
  readonly block: BaseEmbedBlockData;
  readonly notes: readonly Note[];
  readonly onUpdate: (next: BaseEmbedBlockData) => void;
  readonly onOpenNote: (id: NoteId) => void;
}) {
  const baseNotes = computed(() => props.notes.filter((n) => n.noteType === "base"));
  const target = computed(() => props.notes.find((n) => n.id === props.block.noteId));
  const editing = signal(false);

  return (
    <View testID={`doc-base-embed-${props.block.id}`} class="gap-2 rounded-lg border border-line bg-side p-3">
      <View class="flex-row items-center justify-between gap-2">
        <View
          role="button"
          testID={`doc-base-embed-open-${props.block.id}`}
          onPress={() => {
            if (props.block.noteId !== "") props.onOpenNote(props.block.noteId);
          }}
          class="min-w-0 flex-1 flex-row items-center gap-2 rounded-sm hover:opacity-80"
        >
          <View class="size-6 shrink-0 items-center justify-center rounded-sm bg-page">
            <Icon name="catalog" size={14} tone="accent" />
          </View>
          <View class="min-w-0 flex-1">
            <Text class="truncate text-sm font-semibold text-ink">
              {target()?.title ?? (props.block.noteId !== "" ? props.block.noteId : "Select a Base note")}
            </Text>
            <Text class="font-mono text-2xs text-muted">{t("web.note.types.base")}</Text>
          </View>
        </View>
        <IconButton icon={editing() ? "check" : "edit"} size={14} label="Pick Base" onClick={() => editing.set(!editing())} />
      </View>
      <If when={editing()}>
        <View class="gap-1 rounded-md border border-line bg-page p-2">
          <Each of={baseNotes()} key={(n) => n.id}>
            {(n) => (
              <View
                role="button"
                onPress={() => {
                  props.onUpdate({ ...props.block, noteId: n().id });
                  editing.set(false);
                }}
                class="flex-row items-center justify-between rounded-sm px-2 py-1 hover:bg-hover"
              >
                <Text class="truncate text-xs text-ink">{n().title}</Text>
                <If when={n().id === props.block.noteId}>
                  <Icon name="check" size={12} tone="accent" />
                </If>
              </View>
            )}
          </Each>
        </View>
      </If>
      <If when={target()?.preview?._tag === "base" ? target()?.preview : undefined}>
        {(preview) => {
          const basePreview = () => {
            const p = preview();
            return p._tag === "base" ? p : undefined;
          };
          return (
            <If when={basePreview()}>
              {(bp) => (
                <View class="overflow-hidden rounded-md border border-line bg-page">
                  <View class="flex-row border-b border-line bg-side px-2.5 py-1">
                    <Each of={bp().columns.slice(0, 4)} key={(col) => col}>
                      {(col) => <Text class="min-w-0 flex-1 truncate text-2xs font-semibold text-muted">{col()}</Text>}
                    </Each>
                  </View>
                  <Each of={bp().rows.slice(0, 3)} key={(_, idx) => String(idx)}>
                    {(row) => (
                      <View class="flex-row border-t border-line px-2.5 py-1">
                        <Each of={row().slice(0, 4)} key={(_, cIdx) => String(cIdx)}>
                          {(cell) => <Text class="min-w-0 flex-1 truncate text-2xs text-ink">{cell() || "—"}</Text>}
                        </Each>
                      </View>
                    )}
                  </Each>
                </View>
              )}
            </If>
          );
        }}
      </If>
    </View>
  );
}

export function IssueCardBlockView(props: {
  readonly block: IssueCardBlockData;
  readonly issues: readonly Issue[];
  readonly onUpdate: (next: IssueCardBlockData) => void;
  readonly onOpenIssue: (id: IssueId) => void;
}) {
  const resolved = computed(() => resolveIssueRef(props.issues, props.block.issueId));
  const picking = signal(false);

  return (
    <View testID={`doc-issue-card-${props.block.id}`} class="gap-2 rounded-lg border border-line bg-side p-3">
      <View class="flex-row items-center justify-between gap-2">
        <If
          when={resolved()}
          else={
            <View role="button" onPress={() => picking.set(!picking())} class="min-w-0 flex-1 flex-row items-center gap-2">
              <Icon name="issues" size={14} tone="muted" />
              <Text class="truncate text-xs text-muted">{props.block.issueId !== "" ? `Issue ${props.block.issueId}` : "Select an issue"}</Text>
            </View>
          }
        >
          {(issue) => (
            <View
              role="button"
              testID={`doc-issue-card-open-${issue().id}`}
              onPress={() => props.onOpenIssue(issue().id)}
              class="min-w-0 flex-1 flex-row items-center gap-2 rounded-sm hover:opacity-80"
            >
              <Dot tone={statusDotTone[issue().status]} size={9} ring={false} />
              <Text class="shrink-0 font-mono text-xs text-muted tabular-nums">{`#${issue().number}`}</Text>
              <Text class="min-w-0 flex-1 truncate text-sm font-semibold text-ink">{issue().title}</Text>
              <View class="shrink-0 rounded-sm bg-page px-1.5 py-0.5">
                <Text class="text-2xs font-medium text-muted">{statusLabel(issue().status)}</Text>
              </View>
            </View>
          )}
        </If>
        <IconButton icon="edit" size={14} label="Select issue" onClick={() => picking.set(!picking())} />
      </View>
      <If when={picking()}>
        <View class="max-h-40 gap-0.5 rounded-md border border-line bg-page p-1.5">
          <Each of={props.issues.slice(0, 12)} key={(iss) => iss.id}>
            {(iss) => (
              <View
                role="button"
                onPress={() => {
                  props.onUpdate({ ...props.block, issueId: iss().id });
                  picking.set(false);
                }}
                class="flex-row items-center gap-2 rounded-sm px-2 py-1 hover:bg-hover"
              >
                <Dot tone={statusDotTone[iss().status]} size={8} ring={false} />
                <Text class="font-mono text-2xs text-muted">{`#${iss().number}`}</Text>
                <Text class="min-w-0 flex-1 truncate text-xs text-ink">{iss().title}</Text>
              </View>
            )}
          </Each>
        </View>
      </If>
    </View>
  );
}

export function IssueListBlockView(props: {
  readonly block: IssueListBlockData;
  readonly issues: readonly Issue[];
  readonly onUpdate: (next: IssueListBlockData) => void;
  readonly onOpenIssue: (id: IssueId) => void;
}) {
  const editing = signal(false);
  const matched = computed(() =>
    filterIssuesForList(props.issues, {
      repo: props.block.repo,
      status: props.block.status,
      tag: props.block.tag,
      limit: props.block.limit,
    }),
  );

  return (
    <View testID={`doc-issue-list-${props.block.id}`} class="gap-2 rounded-lg border border-line bg-side p-3">
      <View class="flex-row items-center justify-between gap-2">
        <View class="flex-row items-center gap-1.5">
          <Icon name="issues" size={14} tone="muted" />
          <Text class="text-xs font-semibold text-ink">{`Issues (${matched().length})`}</Text>
          <If when={props.block.repo}>{(r) => <Text class="font-mono text-2xs text-faint">{r()}</Text>}</If>
          <If when={props.block.status}>{(s) => <Text class="font-mono text-2xs text-faint">{s()}</Text>}</If>
          <If when={props.block.tag}>{(tg) => <Text class="font-mono text-2xs text-faint">{`#${tg()}`}</Text>}</If>
        </View>
        <IconButton icon={editing() ? "check" : "filter"} size={14} label="Filter issues" onClick={() => editing.set(!editing())} />
      </View>
      <If when={editing()}>
        <View class="flex-row gap-2 rounded-md border border-line bg-page p-2">
          <TextInput
            wide={false}
            class="flex-1"
            value={props.block.repo ?? ""}
            placeholder="Repo filter"
            onInput={(v) => props.onUpdate({ ...props.block, repo: v || undefined })}
          />
          <TextInput
            wide={false}
            class="flex-1"
            value={props.block.status ?? ""}
            placeholder="Status (e.g. todo)"
            onInput={(v) => props.onUpdate({ ...props.block, status: v || undefined })}
          />
          <TextInput
            wide={false}
            class="flex-1"
            value={props.block.tag ?? ""}
            placeholder="Tag"
            onInput={(v) => props.onUpdate({ ...props.block, tag: v || undefined })}
          />
        </View>
      </If>
      <If when={matched().length > 0} else={<Text class="text-xs text-faint">{t("web.base.table.empty")}</Text>}>
        <View class="overflow-hidden rounded-md border border-line bg-page">
          <Each of={matched()} key={(iss) => iss.id}>
            {(iss) => (
              <View
                role="button"
                testID={`doc-issue-list-row-${iss().id}`}
                onPress={() => props.onOpenIssue(iss().id)}
                class="flex-row items-center gap-2 border-b border-line px-2.5 py-1.5 last:border-b-0 hover:bg-hover"
              >
                <Dot tone={statusDotTone[iss().status]} size={8} ring={false} />
                <Text class="shrink-0 font-mono text-2xs text-muted tabular-nums">{`#${iss().number}`}</Text>
                <Text class="min-w-0 flex-1 truncate text-xs font-medium text-ink">{iss().title}</Text>
                <Text class="shrink-0 text-2xs text-faint">{statusLabel(iss().status)}</Text>
              </View>
            )}
          </Each>
        </View>
      </If>
    </View>
  );
}
