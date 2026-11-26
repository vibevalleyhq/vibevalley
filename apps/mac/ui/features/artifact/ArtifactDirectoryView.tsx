import { computed, effect, keymap, Scroll, signal, Text, untracked, View, WebView } from "nsh";

import { t } from "@vibevalley/i18n";
import {
  ARTIFACT_TYPE_SPECS,
  type Artifact,
  type ArtifactFileContent,
  type ArtifactFileMeta,
  type ArtifactPresence,
  type Suggestion,
  userId,
} from "@vibevalley/protocol";

import { createAct } from "../../design/act";
import { Button } from "../../design/Button";
import { TextArea, TextInput } from "../../design/Field";
import { Icon } from "../../design/Icon";
import { IconButton } from "../../design/IconButton";
import { Banner } from "../../design/layout";
import { Segmented } from "../../design/Segmented";
import { toast } from "../../design/toasts";
import { tone } from "../../design/tone";
import { api } from "../../infra/api";
import { useQueryClient } from "../../infra/query";
import { useRouter } from "../../infra/router";
import { buildPrototypeDocument } from "./frame";
import { entryPathOf, type OutlineDocument } from "./html";
import { presenterHref } from "./slides";
import { exportCsvFile, useArtifactDirectory, useArtifactPresence, useArtifactSuggestions, useReportViewContext } from "./store";
import { DesignSystemView } from "./views/DesignSystemView";
import { DesignView } from "./views/DesignView";
import { DocsView } from "./views/DocsView";
import { MotionView } from "./views/MotionView";
import { OutlineView } from "./views/OutlineView";
import {
  asNumber,
  asRecordArray,
  asString,
  parseDesignFrame,
  parseDesignSystem,
  parseJsonObject,
  parseOutlineDoc,
  parseStoryboard,
} from "./views/previewModel";
import { PrototypeView } from "./views/PrototypeView";
import { type SlideItem, SlidesView } from "./views/SlidesView";
import { StoryboardView } from "./views/StoryboardView";
import { DashboardView, DiagramView, type SheetTab, SheetView } from "./views/StructuredViews";
import { WhiteboardView } from "./WhiteboardView";

export type ArtifactViewTab = "preview" | "files";

export interface ArtifactDirectoryMeta {
  readonly fileCount: number;
  readonly seq: number;
  readonly peers: readonly ArtifactPresence[];
}

export interface ArtifactDirectoryViewProps {
  readonly artifact: Artifact;
  readonly version?: number | undefined;
  readonly compact?: boolean | undefined;
  readonly covered?: boolean | undefined;
  readonly tab?: ArtifactViewTab | undefined;
  readonly onTabChange?: ((tab: ArtifactViewTab) => void) | undefined;
  readonly hideToolbar?: boolean | undefined;
  readonly onMeta?: ((meta: ArtifactDirectoryMeta) => void) | undefined;
  readonly onPresent?: ((on: boolean) => void) | undefined;
  readonly onOpenChat?: (() => void) | undefined;
}

export function ArtifactDirectoryView(props: ArtifactDirectoryViewProps) {
  const queries = useQueryClient();
  const router = useRouter();
  const { client, snapshot } = useArtifactDirectory(
    () => props.artifact.id,
    () => props.version,
  );
  const presence = useArtifactPresence(() => props.artifact.id, {
    enabled: () => props.version === undefined,
  });
  const suggestions = useArtifactSuggestions(() => props.artifact.id);
  const act = createAct();

  const internalTab = signal<ArtifactViewTab>("preview");
  const tab = () => props.tab ?? internalTab();
  const setTab = (next: ArtifactViewTab) => {
    if (props.onTabChange) props.onTabChange(next);
    else internalTab.set(next);
  };
  const selectedPath = signal<string>(untracked(() => entryPathOf(props.artifact.artifactType)));
  const draftContent = signal("");
  const lastLoadedHash = signal<string | undefined>(undefined);
  const newFilePath = signal("");
  const addingFile = signal(false);
  const deletingPath = signal<string | undefined>(undefined);
  const fileHtmlMode = signal<"code" | "preview">("code");
  const slideIndex = signal(0);
  const activeSheetIndex = signal(0);
  const activeFramePath = signal<string | undefined>(undefined);

  const primaryEntry = computed(() => entryPathOf(props.artifact.artifactType));
  const sortedFiles = computed((): readonly ArtifactFileMeta[] => [...snapshot().files.values()].toSorted((a, b) => a.path.localeCompare(b.path)));
  const activePath = computed(() => {
    const chosen = selectedPath();
    const files = snapshot().files;
    if (files.has(chosen)) return chosen;
    const entry = primaryEntry();
    if (files.has(entry)) return entry;
    return sortedFiles()[0]?.path ?? entry;
  });
  const activeFile = computed((): ArtifactFileContent | undefined => snapshot().contents.get(activePath()));
  const dirty = computed(() => {
    const file = activeFile();
    return file !== undefined && draftContent() !== file.content;
  });
  const seq = () => (snapshot().seq > 0 ? snapshot().seq : props.artifact.seq);

  // Keep draft synced when switching files or receiving remote updates if not locally dirty.
  effect(() => {
    const file = activeFile();
    const key = file ? `${file.path}:${file.hash}` : undefined;
    if (key !== untracked(lastLoadedHash)) {
      lastLoadedHash.set(key);
      draftContent.set(file?.content ?? "");
    }
  });

  // Report live view context for Chat/Orchestrator messages (skip for whiteboard since WhiteboardView reports its own).
  effect(() => {
    if (props.artifact.artifactType === "whiteboard" && tab() === "preview") return;
    const path = activePath();
    if (props.version === undefined && path) {
      presence.publish({
        id: userId,
        name: t("web.artifact.blocks.user"),
        color: "blue",
        kind: "cursor",
        path,
      });
    }
  });

  useReportViewContext(
    () => props.artifact.id,
    () => ({
      artifactType: props.artifact.artifactType,
      title: props.artifact.title,
      activePath: activePath(),
      seq: seq(),
      ...(props.version !== undefined ? { version: props.version } : {}),
      ...(props.artifact.artifactType === "slides" ? { slideIndex: slideIndex() } : {}),
      ...(props.artifact.artifactType === "design" && activeFramePath() ? { activeArtboard: activeFramePath() } : {}),
    }),
  );

  const remotePeers = computed((): readonly ArtifactPresence[] => presence.peers().filter((p) => p.id !== userId));
  effect(() => {
    const notify = props.onMeta;
    if (!notify) return;
    notify({
      fileCount: sortedFiles().length,
      seq: seq(),
      peers: remotePeers(),
    });
  });
  const openSuggestions = computed(() => suggestions.open());
  const topSuggestion = computed((): Suggestion | undefined => {
    const list = openSuggestions();
    const path = activePath();
    return list.find((s) => s.path === path) ?? list[0];
  });

  const acceptSuggestion = (sug: Suggestion) => {
    void act.run(async () => {
      await suggestions.accept(sug.id);
      await client().load();
    });
  };

  const rejectSuggestion = (sug: Suggestion) => {
    void act.run(async () => {
      await suggestions.reject(sug.id);
    });
  };

  effect(() => {
    const sug = topSuggestion();
    if (!sug) return;
    return keymap.bind(
      {
        tab: () => acceptSuggestion(sug),
        escape: () => rejectSuggestion(sug),
      },
      { when: "notEditing" },
    );
  });

  const selectFile = (path: string) => {
    selectedPath.set(path);
    deletingPath.set(undefined);
    if (!/\.(?:html|htm)$/iu.test(path)) {
      fileHtmlMode.set("code");
    }
    if (!snapshot().contents.has(path)) {
      void client().readFile(path);
    }
  };

  const saveActiveFile = () => {
    const path = activePath();
    const content = draftContent();
    const expectedHash = activeFile()?.hash;
    void act.run(async () => {
      const res = await client().writeFiles([{ path, content, ...(expectedHash !== undefined ? { expectedHash } : {}) }], { summary: `Edit ${path}` });
      lastLoadedHash.set(`${path}:${res.files.find((f) => f.path === path)?.hash ?? ""}`);
      if (res.suggestions && res.suggestions.length > 0) {
        toast(t("web.artifact.suggestions.title", { n: res.suggestions.length }));
      } else {
        toast(t("web.artifact.blocks.saved"));
      }
      void queries.invalidate({ prefix: ["artifacts"] });
    });
  };

  const canSaveFilesShortcut = computed(() => tab() === "files" && props.version === undefined && dirty() && !act.busy());
  effect(() => {
    if (!canSaveFilesShortcut()) return;
    return keymap.bind("mod+s", () => saveActiveFile(), { when: "always" });
  });

  const createNewFile = () => {
    const raw = newFilePath().trim();
    if (!raw) return;
    const normalized = raw.startsWith("structure/") || raw.startsWith("asset/") ? raw : `structure/${raw}`;
    const initial = normalized.endsWith(".json") ? "{}\n" : "";
    void act.run(async () => {
      await client().writeFiles([{ path: normalized, content: initial }], { summary: `Create ${normalized}` });
      newFilePath.set("");
      addingFile.set(false);
      selectedPath.set(normalized);
      void queries.invalidate({ prefix: ["artifacts"] });
    });
  };

  const deleteSelectedFile = (path: string) => {
    if (path === "manifest.json" || path === primaryEntry()) return;
    deletingPath.set(undefined);
    void act.run(async () => {
      await client().deleteFile(path, { summary: `Delete ${path}` });
      if (selectedPath() === path) selectedPath.set(primaryEntry());
      void queries.invalidate({ prefix: ["artifacts"] });
    });
  };

  const createSnapshotVersion = () => {
    void act.run(async () => {
      const updated = await api.artifact.version.create({
        id: props.artifact.id,
        note: t("web.artifact.page.snapshotNote"),
      });
      await queries.invalidate({ prefix: ["artifacts"] });
      toast(t("web.artifact.edit.saved", { version: updated.version }));
    });
  };

  const toggleDefaultDesignSystem = () => {
    void act.run(async () => {
      await api.artifact.update({ id: props.artifact.id, isDefault: !props.artifact.isDefault });
      await queries.invalidate({ prefix: ["artifacts"] });
    });
  };

  const saveJsonContent = (path: string, value: unknown, summary: string) =>
    act.run(async () => {
      await client().writeFiles([{ path, content: `${JSON.stringify(value, null, 2)}\n`, mime: "application/json" }], { summary });
      void queries.invalidate({ prefix: ["artifacts"] });
    });

  // Derived structured views for the 12 artifact types.
  const docsContent = computed(() => snapshot().contents.get(ARTIFACT_TYPE_SPECS.docs.entryPath)?.content ?? "");
  const outlineDoc = computed(() => parseOutlineDoc(snapshot().contents.get(ARTIFACT_TYPE_SPECS.outline.entryPath)?.content));

  const slidesDeck = computed(() => {
    const deckObj = parseJsonObject(snapshot().contents.get(ARTIFACT_TYPE_SPECS.slides.entryPath)?.content);
    const slides: SlideItem[] = asRecordArray(deckObj?.slides).map((s, idx) => {
      const file = asString(s.file);
      const slideData = parseJsonObject(file ? snapshot().contents.get(file)?.content : undefined);
      return {
        id: asString(s.id, `slide-${idx + 1}`),
        file,
        title: asString(slideData?.title, asString(s.title, `Slide ${idx + 1}`)),
        subtitle: asString(slideData?.subtitle),
        layout: asString(slideData?.layout, "content"),
        notes: asString(slideData?.notes),
        blocks: asRecordArray(slideData?.blocks),
      };
    });
    return {
      title: asString(deckObj?.title, props.artifact.title),
      aspectRatio: asString(deckObj?.aspectRatio, "16:9"),
      slides,
    };
  });

  const dashboardData = computed(() => {
    const obj = parseJsonObject(snapshot().contents.get(ARTIFACT_TYPE_SPECS.dashboard.entryPath)?.content);
    const panels = asRecordArray(obj?.panels);
    const datasets = sortedFiles()
      .filter((f) => f.path.startsWith("structure/data/"))
      .map((f) => {
        const parsed = parseJsonObject(snapshot().contents.get(f.path)?.content);
        const schema = asRecordArray(parsed?.schema).map((s) => ({
          name: asString(s.name),
          label: asString(s.label, asString(s.name)),
          type: asString(s.type, "string"),
        }));
        const rows = asRecordArray(parsed?.rows);
        const cols =
          schema.length > 0 ? schema.map((s) => s.name).filter(Boolean) : rows.length > 0 ? [...new Set(rows.slice(0, 50).flatMap((r) => Object.keys(r)))] : [];
        return { path: f.path, name: f.path.slice("structure/data/".length), schema, rows, cols };
      });
    return { title: asString(obj?.title, props.artifact.title), panels, datasets };
  });

  const motionData = computed(() => {
    const obj = parseJsonObject(snapshot().contents.get(ARTIFACT_TYPE_SPECS.motion.entryPath)?.content);
    const scenes = asRecordArray(obj?.scenes).map((sc) => {
      const file = asString(sc.file);
      const detail = parseJsonObject(file ? snapshot().contents.get(file)?.content : undefined);
      return {
        id: asString(sc.id),
        file,
        start: asNumber(sc.start),
        end: asNumber(sc.end),
        title: asString(detail?.title, asString(sc.id)),
        layers: asRecordArray(detail?.layers),
      };
    });
    return {
      width: asNumber(obj?.width, 1920),
      height: asNumber(obj?.height, 1080),
      fps: asNumber(obj?.fps, 30),
      duration: asNumber(obj?.duration, 6),
      background: asString(obj?.background, tone("ink")),
      chapters: asRecordArray(obj?.chapters),
      scenes,
    };
  });

  const designFrames = computed(() =>
    sortedFiles()
      .filter((f) => f.path.startsWith("structure/frames/") && f.path.endsWith(".json"))
      .map((f) => parseDesignFrame(f.path, snapshot().contents.get(f.path)?.content)),
  );

  const designSystemData = computed(() =>
    parseDesignSystem(
      snapshot().contents.get(ARTIFACT_TYPE_SPECS["design-system"].entryPath)?.content,
      sortedFiles()
        .filter((f) => f.path.startsWith("structure/components/") && f.path.endsWith(".json"))
        .map((f) => ({ path: f.path, content: snapshot().contents.get(f.path)?.content })),
      props.artifact.title,
    ),
  );

  const sheetData = computed(() => {
    const wb = parseJsonObject(snapshot().contents.get(ARTIFACT_TYPE_SPECS.sheet.entryPath)?.content);
    const sheets: SheetTab[] = asRecordArray(wb?.sheets).map((sh, idx) => {
      const file = asString(sh.file);
      const data = parseJsonObject(file ? snapshot().contents.get(file)?.content : undefined);
      const columns = asRecordArray(data?.columns).map((c) => ({
        key: asString(c.key),
        title: asString(c.title, asString(c.key)),
        type: asString(c.type, "string"),
      }));
      const rows = asRecordArray(data?.rows);
      return { id: asString(sh.id, `sheet-${idx + 1}`), title: asString(sh.title, `Sheet ${idx + 1}`), file, columns, rows };
    });
    return { locale: asString(wb?.locale, "en-US"), currency: asString(wb?.currency, "USD"), sheets };
  });

  const rawFilesMap = computed(() => {
    const map = new Map<string, string>();
    for (const [path, file] of snapshot().contents) {
      map.set(path, file.content);
    }
    return map;
  });

  const isHtmlFile = computed(() => /\.(?:html|htm)$/iu.test(activePath()));
  const activeFileHtmlPreview = computed(() => {
    const map = new Map(rawFilesMap());
    const current = activePath();
    map.set(current, draftContent());
    return buildPrototypeDocument(map, current);
  });

  const diagramData = computed(() => {
    const obj = parseJsonObject(snapshot().contents.get(ARTIFACT_TYPE_SPECS.diagram.entryPath)?.content);
    return {
      title: asString(obj?.title, props.artifact.title),
      kind: asString(obj?.kind, "architecture"),
      direction: asString(obj?.direction, "LR"),
      nodes: asRecordArray(obj?.nodes).map((n) => ({
        id: asString(n.id),
        label: asString(n.label, asString(n.id)),
        kind: asString(n.kind, "node"),
      })),
      edges: asRecordArray(obj?.edges).map((e, idx) => ({
        id: asString(e.id, `e-${idx}`),
        from: asString(e.from),
        to: asString(e.to),
        label: asString(e.label),
      })),
    };
  });

  const diagramMmdSource = computed(() => {
    const mmdFile = sortedFiles().find((f) => f.path.endsWith(".mmd"));
    return mmdFile ? snapshot().contents.get(mmdFile.path)?.content : undefined;
  });

  const storyboardData = computed(() => parseStoryboard(snapshot().contents.get(ARTIFACT_TYPE_SPECS.storyboard.entryPath)?.content, props.artifact.title));

  const saveOutlineDoc = (next: OutlineDocument, summary: string) => {
    if (props.version !== undefined) return;
    void saveJsonContent(ARTIFACT_TYPE_SPECS.outline.entryPath, next, summary);
  };

  const addSlide = () => {
    if (props.version !== undefined) return;
    const curDeck = parseJsonObject(untracked(() => snapshot().contents.get(ARTIFACT_TYPE_SPECS.slides.entryPath)?.content)) ?? {
      title: props.artifact.title,
      aspectRatio: "16:9",
      designSystemId: null,
      slides: [],
    };
    const prevSlides = asRecordArray(curDeck.slides);
    const num = String(prevSlides.length + 1).padStart(2, "0");
    const slideId = `s${num}-slide`;
    const slidePath = `structure/slides/${slideId}.json`;
    const slideTitle = `Slide ${prevSlides.length + 1}`;
    const nextDeck = {
      ...curDeck,
      slides: [...prevSlides, { id: slideId, file: slidePath, title: slideTitle }],
    };
    const slideBody = { id: slideId, layout: "content", title: slideTitle, subtitle: "", blocks: [], notes: "" };
    void act.run(async () => {
      await client().writeFiles(
        [
          { path: ARTIFACT_TYPE_SPECS.slides.entryPath, content: `${JSON.stringify(nextDeck, null, 2)}\n`, mime: "application/json" },
          { path: slidePath, content: `${JSON.stringify(slideBody, null, 2)}\n`, mime: "application/json" },
        ],
        { summary: `Add slide ${slideId}` },
      );
      slideIndex.set(prevSlides.length);
      void queries.invalidate({ prefix: ["artifacts"] });
    });
  };

  const saveSlideEdit = (
    slide: SlideItem,
    next: { readonly title: string; readonly subtitle: string; readonly layout: string; readonly bullets: readonly string[]; readonly notes: string },
  ) => {
    if (props.version !== undefined || !slide.file) return;
    const curSlide = parseJsonObject(untracked(() => snapshot().contents.get(slide.file)?.content)) ?? { id: slide.id };
    const nextSlide = {
      ...curSlide,
      id: slide.id,
      layout: next.layout,
      title: next.title,
      subtitle: next.subtitle,
      blocks: next.bullets.map((text) => ({ kind: "bullet", text })),
      notes: next.notes,
    };
    const curDeck = parseJsonObject(untracked(() => snapshot().contents.get(ARTIFACT_TYPE_SPECS.slides.entryPath)?.content));
    const writes = [{ path: slide.file, content: `${JSON.stringify(nextSlide, null, 2)}\n`, mime: "application/json" }];
    if (curDeck && next.title !== slide.title) {
      const nextDeck = {
        ...curDeck,
        slides: asRecordArray(curDeck.slides).map((s) => (asString(s.id) === slide.id || asString(s.file) === slide.file ? { ...s, title: next.title } : s)),
      };
      writes.push({ path: ARTIFACT_TYPE_SPECS.slides.entryPath, content: `${JSON.stringify(nextDeck, null, 2)}\n`, mime: "application/json" });
    }
    void act.run(async () => {
      await client().writeFiles(writes, { summary: `Edit slide ${slide.id}` });
      void queries.invalidate({ prefix: ["artifacts"] });
    });
  };

  const updateSheetCell = (sheet: SheetTab, rowIndex: number, colKey: string, value: string, colType: string) => {
    if (props.version !== undefined || !sheet.file) return;
    const rawSheet = parseJsonObject(untracked(() => snapshot().contents.get(sheet.file)?.content)) ?? {
      id: sheet.id,
      title: sheet.title,
      columns: sheet.columns,
      rows: sheet.rows,
    };
    const rows = asRecordArray(rawSheet.rows);
    if (rowIndex < 0 || rowIndex >= rows.length) return;
    const parsedValue = colType === "number" && value.trim() !== "" && Number.isFinite(Number(value)) ? Number(value) : value;
    const nextRows = rows.map((r, i) => (i === rowIndex ? { ...r, [colKey]: parsedValue } : r));
    void saveJsonContent(sheet.file, { ...rawSheet, rows: nextRows }, `Edit cell ${colKey} row ${rowIndex + 1}`);
  };

  const addSheetRow = (sheet: SheetTab) => {
    if (props.version !== undefined || !sheet.file) return;
    const rawSheet = parseJsonObject(untracked(() => snapshot().contents.get(sheet.file)?.content)) ?? {
      id: sheet.id,
      title: sheet.title,
      columns: sheet.columns,
      rows: sheet.rows,
    };
    const rows = asRecordArray(rawSheet.rows);
    const emptyRow: Record<string, unknown> = {};
    for (const col of sheet.columns) {
      emptyRow[col.key] = col.type === "number" ? 0 : "";
    }
    void saveJsonContent(sheet.file, { ...rawSheet, rows: [...rows, emptyRow] }, `Add row to ${sheet.title}`);
  };

  const isWhiteboardPreview = () => props.artifact.artifactType === "whiteboard" && tab() === "preview";

  return (
    <View testID="artifact-directory-view" class="min-h-0 min-w-0 flex-1 bg-page">
      <If when={props.hideToolbar !== true}>
        <View testID="artifact-collab-bar" class="min-h-9 shrink-0 flex-row flex-wrap items-center gap-2 border-b border-line bg-side px-3 py-1">
          <Segmented
            testid="artifact-view-mode"
            label={t("web.artifact.page.viewMode")}
            value={tab()}
            onChange={(v) => setTab(v)}
            options={[
              { value: "preview" as const, label: t("web.artifact.page.previewTab") },
              {
                value: "files" as const,
                label: sortedFiles().length > 0 ? t("web.artifact.page.filesTabCount", { n: sortedFiles().length }) : t("web.artifact.page.filesTab"),
              },
            ]}
          />

          <If when={remotePeers().length > 0}>
            <View testID="artifact-presence-bar" class="flex-row flex-wrap items-center gap-1">
              <Each of={remotePeers()} key={(p) => p.id}>
                {(peer) => (
                  <View testID="artifact-presence-pill" class="h-5 flex-row items-center gap-1 rounded-full border border-line bg-page px-2">
                    <View class="size-1.5 shrink-0 rounded-full bg-accent" />
                    <Text class="max-w-32 truncate text-2xs font-medium text-ink">{peer().status ? `${peer().name} · ${peer().status}` : peer().name}</Text>
                  </View>
                )}
              </Each>
            </View>
          </If>

          <View class="ml-auto flex-row items-center gap-1.5">
            <If when={props.artifact.artifactType === "design-system" && props.version === undefined}>
              <IconButton
                icon="check"
                size={14}
                pressed={props.artifact.isDefault}
                label={props.artifact.isDefault ? t("web.artifact.types.unsetDefault") : t("web.artifact.types.setDefault")}
                testid="artifact-toggle-default"
                disabled={act.busy()}
                onClick={toggleDefaultDesignSystem}
              />
            </If>
            <If when={props.version === undefined && props.compact !== true}>
              <IconButton
                icon="add"
                size={14}
                label={t("web.artifact.edit.save")}
                testid="artifact-snapshot-version"
                disabled={act.busy()}
                onClick={createSnapshotVersion}
              />
            </If>
            <Text testID="artifact-seq" class="font-mono text-2xs text-faint tabular-nums">
              {`seq ${seq()}`}
            </Text>
          </View>
        </View>
      </If>

      <If when={snapshot().error}>{(err) => <Banner edge>{err()}</Banner>}</If>

      <If when={topSuggestion()}>
        {(sug) => (
          <View testID="artifact-inline-suggestion" class="shrink-0 flex-row flex-wrap items-center gap-2 border-b border-line bg-warn-soft px-3 py-2">
            <Icon name="edit" size={14} tone="warn-ink" />
            <View class="min-w-0 flex-1 gap-0.5">
              <View class="flex-row items-center gap-1.5">
                <Text class="text-xs font-semibold text-ink">{t("web.artifact.suggestions.by", { name: sug().author })}</Text>
                <Text class="font-mono text-2xs text-muted">{sug().path}</Text>
                <If when={openSuggestions().length > 1}>
                  <Text class="font-mono text-2xs text-faint">{`+${openSuggestions().length - 1}`}</Text>
                </If>
              </View>
              <Text class="truncate text-xs text-muted">
                {sug().change.summary ??
                  (sug().change.delete === true ? t("web.artifact.suggestions.delete") : (sug().change.content ?? sug().change.patch ?? ""))}
              </Text>
            </View>
            <View class="shrink-0 flex-row items-center gap-1">
              <Button size="compact" tone="primary" testID="inline-suggestion-accept" disabled={act.busy()} onPress={() => acceptSuggestion(sug())}>
                {t("web.artifact.suggestions.accept")}
              </Button>
              <Button size="compact" tone="quiet" testID="inline-suggestion-reject" disabled={act.busy()} onPress={() => rejectSuggestion(sug())}>
                {t("web.artifact.suggestions.reject")}
              </Button>
            </View>
          </View>
        )}
      </If>

      <If when={isWhiteboardPreview()}>
        <View class="min-h-0 flex-1 p-2">
          <WhiteboardView artifact={props.artifact} version={props.version} onOpenChat={props.onOpenChat} />
        </View>
      </If>

      <If when={tab() === "preview" && !isWhiteboardPreview()}>
        <View class="min-h-0 min-w-0 flex-1">
          <If when={props.artifact.artifactType === "docs"}>
            <DocsView
              title={props.artifact.title}
              version={props.version}
              content={docsContent()}
              draft={activePath() === "structure/index.md" ? draftContent() : docsContent()}
              dirty={activePath() === "structure/index.md" && dirty()}
              busy={act.busy()}
              onDraftChange={(v) => {
                if (selectedPath() !== "structure/index.md") selectedPath.set("structure/index.md");
                draftContent.set(v);
              }}
              onSave={() => {
                if (selectedPath() !== "structure/index.md") selectedPath.set("structure/index.md");
                saveActiveFile();
              }}
              onRevert={() => draftContent.set(docsContent())}
            />
          </If>

          <If when={props.artifact.artifactType === "outline"}>
            <OutlineView doc={outlineDoc()} version={props.version} busy={act.busy()} onSaveDoc={saveOutlineDoc} />
          </If>

          <If when={props.artifact.artifactType === "slides"}>
            <SlidesView
              artifactId={props.artifact.id}
              deckTitle={slidesDeck().title}
              slides={slidesDeck().slides}
              slideIndex={slideIndex()}
              version={props.version}
              busy={act.busy()}
              onSlideIndexChange={(idx) => slideIndex.set(idx)}
              onAddSlide={addSlide}
              onSaveSlide={saveSlideEdit}
              onPresent={props.onPresent}
              onOpenPresenter={() => router.navigate(presenterHref({ id: props.artifact.id, version: props.version ?? Math.max(1, props.artifact.version) }))}
            />
          </If>

          <If when={props.artifact.artifactType === "dashboard"}>
            <DashboardView
              panels={dashboardData().panels}
              datasets={dashboardData().datasets}
              busy={act.busy()}
              onExportCsv={(name, rows) => void act.run(() => exportCsvFile(name, rows))}
            />
          </If>

          <If when={props.artifact.artifactType === "motion"}>
            <MotionView
              width={motionData().width}
              height={motionData().height}
              fps={motionData().fps}
              duration={motionData().duration}
              background={motionData().background}
              chapters={motionData().chapters}
              scenes={motionData().scenes}
            />
          </If>

          <If when={props.artifact.artifactType === "design"}>
            <DesignView frames={designFrames()} activeFramePath={activeFramePath()} onSelectFrame={(p) => activeFramePath.set(p)} />
          </If>

          <If when={props.artifact.artifactType === "design-system"}>
            <DesignSystemView model={designSystemData()} />
          </If>

          <If when={props.artifact.artifactType === "sheet"}>
            <SheetView
              sheets={sheetData().sheets}
              activeIndex={activeSheetIndex()}
              readOnly={props.version !== undefined}
              busy={act.busy()}
              onSelectSheet={(idx) => activeSheetIndex.set(idx)}
              onExportCsv={(name, rows) => void act.run(() => exportCsvFile(name, rows))}
              onUpdateCell={updateSheetCell}
              onAddRow={addSheetRow}
            />
          </If>

          <If when={props.artifact.artifactType === "prototype"}>
            <PrototypeView artifact={props.artifact} files={rawFilesMap()} compact={props.compact} covered={props.covered} onOpenChat={props.onOpenChat} />
          </If>

          <If when={props.artifact.artifactType === "diagram"}>
            <DiagramView data={diagramData()} mmdSource={diagramMmdSource()} />
          </If>

          <If when={props.artifact.artifactType === "storyboard"}>
            <StoryboardView model={storyboardData()} />
          </If>
        </View>
      </If>

      <If when={tab() === "files"}>
        <View testID="artifact-files-view" class="min-h-0 min-w-0 flex-1 flex-row">
          <View class="w-60 shrink-0 border-r border-line bg-side">
            <View class="flex-row items-center justify-between border-b border-line px-2.5 py-1.5">
              <Text class="text-xs font-semibold text-muted">{t("web.artifact.page.directory")}</Text>
              <If when={props.version === undefined}>
                <IconButton
                  icon="add"
                  size={12}
                  label={t("web.artifact.page.new")}
                  testid="artifact-file-add-toggle"
                  onClick={() => addingFile.set(!addingFile())}
                />
              </If>
            </View>
            <If when={addingFile()}>
              <View class="gap-1.5 border-b border-line p-2">
                <TextInput
                  testID="artifact-file-new-path"
                  value={newFilePath()}
                  onInput={(v) => newFilePath.set(v)}
                  onSubmit={createNewFile}
                  placeholder="structure/notes.md"
                  accessibilityLabel={t("web.artifact.page.newFileLabel")}
                />
                <Button size="compact" tone="primary" testID="artifact-file-new-submit" disabled={act.busy()} onPress={createNewFile}>
                  {t("web.artifact.page.new")}
                </Button>
              </View>
            </If>
            <Scroll class="min-h-0 flex-1" contentClass="gap-0.5 p-1.5">
              <Each of={sortedFiles()} key={(f) => f.path}>
                {(f) => {
                  const selected = () => activePath() === f().path;
                  const deletable = () => props.version === undefined && f().path !== "manifest.json" && f().path !== primaryEntry();
                  return (
                    <View
                      role="button"
                      testID={`artifact-file-row-${f().path}`}
                      accessibilityState={{ selected: selected() }}
                      onPress={() => selectFile(f().path)}
                      class={`group flex-row items-center gap-1.5 rounded-md px-2 py-1.5 ${selected() ? "bg-selected" : "hover:bg-hover"}`}
                    >
                      <Icon name="file" size={12} tone={selected() ? "ink" : "muted"} />
                      <Text class={`min-w-0 flex-1 truncate font-mono text-2xs ${selected() ? "font-semibold text-ink" : "text-muted"}`}>{f().path}</Text>
                      <If when={deletable()}>
                        <View class="opacity-0 group-hover:opacity-100 focus-within:opacity-100">
                          <IconButton
                            icon="delete"
                            size={12}
                            label={t("web.artifact.page.delete")}
                            testid={`artifact-file-delete-${f().path}`}
                            onClick={() => deletingPath.set(f().path)}
                          />
                        </View>
                      </If>
                    </View>
                  );
                }}
              </Each>
            </Scroll>
          </View>

          <View class="min-h-0 min-w-0 flex-1 p-3">
            <If when={deletingPath()}>
              {(target) => (
                <View
                  testID="artifact-file-delete-confirm"
                  class="mb-2 flex-row flex-wrap items-center gap-2 rounded-md border border-line bg-bad-soft px-3 py-2"
                >
                  <Text class="min-w-0 flex-1 text-xs text-berry">{t("web.artifact.page.deleteFileAsk", { path: target() })}</Text>
                  <Button size="compact" tone="danger" testID="artifact-file-delete-sure" disabled={act.busy()} onPress={() => deleteSelectedFile(target())}>
                    {t("web.artifact.page.delete")}
                  </Button>
                  <Button size="compact" tone="quiet" onPress={() => deletingPath.set(undefined)}>
                    {t("web.base.form.never")}
                  </Button>
                </View>
              )}
            </If>
            <View class="mb-2 flex-row items-center justify-between gap-2">
              <View class="min-w-0 flex-1 flex-row items-center gap-2">
                <Text testID="artifact-file-active-path" class="truncate font-mono text-xs font-semibold text-ink">
                  {activePath()}
                </Text>
                <If when={activeFile()}>{(file) => <Text class="shrink-0 font-mono text-2xs text-faint tabular-nums">{`${file().size} B`}</Text>}</If>
                <If when={dirty() && props.version === undefined}>
                  <View class="flex-row items-center gap-1 rounded-sm bg-warn-soft px-1.5 py-0.5">
                    <View class="size-1.5 rounded-full bg-wheat" />
                    <Text class="text-2xs font-medium text-warn-ink">{t("web.artifact.page.unsaved")}</Text>
                  </View>
                </If>
              </View>
              <View class="shrink-0 flex-row items-center gap-1.5">
                <If when={isHtmlFile()}>
                  <Segmented
                    testid="artifact-file-html-mode"
                    label={t("web.artifact.page.viewMode")}
                    value={fileHtmlMode()}
                    onChange={(v) => fileHtmlMode.set(v)}
                    options={[
                      { value: "code" as const, label: t("web.artifact.files.codeMode") },
                      { value: "preview" as const, label: t("web.artifact.files.htmlPreviewMode") },
                    ]}
                  />
                </If>
                <If when={props.version === undefined}>
                  <View class="shrink-0 flex-row items-center gap-1.5">
                    <If when={dirty()}>
                      <Button
                        size="compact"
                        tone="quiet"
                        testID="artifact-file-revert"
                        disabled={act.busy()}
                        onPress={() => draftContent.set(activeFile()?.content ?? "")}
                      >
                        {t("web.artifact.page.discard")}
                      </Button>
                    </If>
                    <Button size="compact" tone="primary" testID="artifact-file-save" disabled={act.busy() || !dirty()} onPress={saveActiveFile}>
                      {t("web.artifact.whiteboard.save")}
                    </Button>
                  </View>
                </If>
              </View>
            </View>
            <If
              when={isHtmlFile() && fileHtmlMode() === "preview"}
              else={
                <TextArea
                  testID="artifact-file-editor"
                  accessibilityLabel={activePath()}
                  rows={20}
                  value={draftContent()}
                  onInput={(v) => draftContent.set(v)}
                  class="min-h-0 flex-1 font-mono text-xs"
                />
              }
            >
              <WebView
                testID="artifact-file-html-preview"
                accessibilityLabel={activePath()}
                html={activeFileHtmlPreview()}
                incognito
                class="min-h-0 w-full flex-1 rounded-md border border-line bg-page"
              />
            </If>
          </View>
        </View>
      </If>
    </View>
  );
}
