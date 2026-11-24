import { computed, effect, keymap, Scroll, signal, Text, untracked, View, WebView } from "nsh";

import { t } from "@vibevalley/i18n";
import { type Artifact, type ArtifactFileContent, type ArtifactFileMeta, type ArtifactPresence, type Suggestion, userId } from "@vibevalley/protocol";

import { createAct } from "../../design/act";
import { Button } from "../../design/Button";
import { TextArea, TextInput } from "../../design/Field";
import { Icon } from "../../design/Icon";
import { IconButton } from "../../design/IconButton";
import { Banner, Empty } from "../../design/layout";
import { Segmented } from "../../design/Segmented";
import { toast } from "../../design/toasts";
import { tone } from "../../design/tone";
import { api } from "../../infra/api";
import { useQueryClient } from "../../infra/query";
import { useRouter } from "../../infra/router";
import { buildPrototypeDocument } from "./frame";
import { entryPathOf, type OutlineDocument, type OutlineNode } from "./html";
import { presenterHref } from "./slides";
import { exportCsvFile, formatCellValue, useArtifactDirectory, useArtifactPresence, useArtifactSuggestions, useReportViewContext } from "./store";
import { WhiteboardView } from "./WhiteboardView";

export interface ArtifactDirectoryViewProps {
  readonly artifact: Artifact;
  readonly version?: number | undefined;
  readonly compact?: boolean | undefined;
  readonly covered?: boolean | undefined;
  readonly onPresent?: ((on: boolean) => void) | undefined;
  readonly onOpenChat?: (() => void) | undefined;
}

type ViewTab = "preview" | "files";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseJsonObject(raw: string | undefined): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function asString(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function asNumber(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function asRecordArray(v: unknown): Record<string, unknown>[] {
  if (!Array.isArray(v)) return [];
  return v.filter(isRecord);
}

function parseOutlineDoc(raw: string | undefined): OutlineDocument {
  const obj = parseJsonObject(raw);
  if (!obj) return { version: 1, rootIds: [], nodes: {} };
  const rootIds = Array.isArray(obj.rootIds) ? obj.rootIds.filter((x): x is string => typeof x === "string") : [];
  const rawNodes = isRecord(obj.nodes) ? obj.nodes : {};
  const nodes: Record<string, OutlineNode> = {};
  for (const [id, val] of Object.entries(rawNodes)) {
    if (!isRecord(val)) continue;
    const rawKind = val.kind;
    const kind: OutlineNode["kind"] = rawKind === "heading" || rawKind === "todo" ? rawKind : "bullet";
    const children = Array.isArray(val.children) ? val.children.filter((x): x is string => typeof x === "string") : [];
    nodes[id] = {
      id: asString(val.id, id),
      text: asString(val.text),
      kind,
      ...(typeof val.checked === "boolean" ? { checked: val.checked } : {}),
      children,
    };
  }
  return { version: asNumber(obj.version, 1), rootIds, nodes };
}

function flattenOutline(doc: OutlineDocument): { readonly node: OutlineNode; readonly depth: number }[] {
  const out: { readonly node: OutlineNode; readonly depth: number }[] = [];
  const visited = new Set<string>();
  const walk = (id: string, depth: number) => {
    if (visited.has(id)) return;
    visited.add(id);
    if (!Object.hasOwn(doc.nodes, id)) return;
    const node = doc.nodes[id];
    out.push({ node, depth });
    for (const child of node.children) walk(child, depth + 1);
  };
  for (const id of doc.rootIds) walk(id, 0);
  return out;
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

  const tab = signal<ViewTab>("preview");
  const selectedPath = signal<string>(untracked(() => entryPathOf(props.artifact.artifactType)));
  const draftContent = signal("");
  const lastLoadedHash = signal<string | undefined>(undefined);
  const newFilePath = signal("");
  const addingFile = signal(false);
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
    // Also publish lightweight selection presence when switching active files.
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

  // Tab accepts and Esc rejects the active open suggestion when not typing in an input.
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
        note: "Snapshot",
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
  const docsContent = computed(() => snapshot().contents.get("structure/index.md")?.content ?? "");
  const outlineDoc = computed(() => parseOutlineDoc(snapshot().contents.get("structure/outline.json")?.content));
  const outlineRows = computed(() => flattenOutline(outlineDoc()));

  const slidesDeck = computed(() => {
    const deckObj = parseJsonObject(snapshot().contents.get("structure/deck.json")?.content);
    const slides = asRecordArray(deckObj?.slides).map((s, idx) => {
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
    const obj = parseJsonObject(snapshot().contents.get("structure/dashboard.json")?.content);
    const panels = asRecordArray(obj?.panels);
    const datasets = sortedFiles()
      .filter((f) => f.path.startsWith("structure/data/"))
      .map((f) => {
        const parsed = parseJsonObject(snapshot().contents.get(f.path)?.content);
        const rows = asRecordArray(parsed?.rows);
        const cols = rows.length > 0 ? [...new Set(rows.slice(0, 50).flatMap((r) => Object.keys(r)))] : [];
        return { path: f.path, name: f.path.slice("structure/data/".length), rows, cols };
      });
    return { title: asString(obj?.title, props.artifact.title), panels, datasets };
  });

  const motionData = computed(() => {
    const obj = parseJsonObject(snapshot().contents.get("structure/timeline.json")?.content);
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
      .map((f) => {
        const obj = parseJsonObject(snapshot().contents.get(f.path)?.content);
        return {
          path: f.path,
          id: asString(obj?.id, f.path),
          name: asString(obj?.name, f.path),
          width: asNumber(obj?.width, 1280),
          height: asNumber(obj?.height, 800),
          background: asString(obj?.background, tone("page")),
          nodes: asRecordArray(obj?.nodes),
        };
      }),
  );

  const designSystemData = computed(() => {
    const obj = parseJsonObject(snapshot().contents.get("structure/tokens.json")?.content);
    const colorObj = isRecord(obj?.color) ? obj.color : {};
    const colors = Object.entries(colorObj).map(([name, val]) => {
      if (isRecord(val)) {
        return { name, light: asString(val.light), dark: asString(val.dark) };
      }
      return { name, light: asString(val), dark: asString(val) };
    });
    const components = sortedFiles()
      .filter((f) => f.path.startsWith("structure/components/") && f.path.endsWith(".json"))
      .map((f) => {
        const c = parseJsonObject(snapshot().contents.get(f.path)?.content);
        return {
          path: f.path,
          id: asString(c?.id, f.path),
          name: asString(c?.name, f.path),
          variants: Array.isArray(c?.variants) ? c.variants.filter((x): x is string => typeof x === "string") : [],
          states: Array.isArray(c?.states) ? c.states.filter((x): x is string => typeof x === "string") : [],
        };
      });
    return {
      name: asString(obj?.name, props.artifact.title),
      version: asString(obj?.version, "1.0.0"),
      colors,
      components,
    };
  });

  const sheetData = computed(() => {
    const wb = parseJsonObject(snapshot().contents.get("structure/workbook.json")?.content);
    const sheets = asRecordArray(wb?.sheets).map((sh, idx) => {
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

  const prototypeHtml = computed(() => {
    const map = new Map<string, string>();
    for (const [path, file] of snapshot().contents) {
      map.set(path, file.content);
    }
    return buildPrototypeDocument(map);
  });

  const diagramData = computed(() => {
    const obj = parseJsonObject(snapshot().contents.get("structure/diagram.json")?.content);
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

  const storyboardData = computed(() => {
    const obj = parseJsonObject(snapshot().contents.get("structure/shots.json")?.content);
    const styleGuide = isRecord(obj?.styleGuide) ? obj.styleGuide : undefined;
    const palette = Array.isArray(styleGuide?.palette) ? styleGuide.palette.filter((x): x is string => typeof x === "string") : [];
    const shots = asRecordArray(obj?.shots).map((s, idx) => ({
      id: asString(s.id, `sh${idx + 1}`),
      scene: asString(s.scene),
      durationSec: asNumber(s.durationSec, 3),
      framing: asString(s.framing),
      camera: asString(s.camera),
      visual: asString(s.visual),
      dialogue: asString(s.dialogue),
      status: asString(s.status, "draft"),
    }));
    return {
      aspectRatio: asString(obj?.aspectRatio, "16:9"),
      fps: asNumber(obj?.fps, 30),
      visualTone: asString(styleGuide?.visualTone),
      palette,
      shots,
    };
  });

  const toggleOutlineTodo = (nodeId: string) => {
    if (props.version !== undefined) return;
    const cur = untracked(outlineDoc);
    if (!Object.hasOwn(cur.nodes, nodeId)) return;
    const target = cur.nodes[nodeId];
    const next: OutlineDocument = {
      ...cur,
      nodes: { ...cur.nodes, [nodeId]: { ...target, checked: target.checked !== true } },
    };
    void saveJsonContent("structure/outline.json", next, `Toggle ${nodeId}`);
  };

  const addOutlineItem = () => {
    if (props.version !== undefined) return;
    const cur = untracked(outlineDoc);
    const id = `n_${Date.now().toString(36)}`;
    const next: OutlineDocument = {
      ...cur,
      rootIds: [...cur.rootIds, id],
      nodes: { ...cur.nodes, [id]: { id, text: "New item", kind: "bullet", children: [] } },
    };
    void saveJsonContent("structure/outline.json", next, `Add outline item ${id}`);
  };

  const addSlide = () => {
    if (props.version !== undefined) return;
    const curDeck = parseJsonObject(untracked(() => snapshot().contents.get("structure/deck.json")?.content)) ?? {
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
          { path: "structure/deck.json", content: `${JSON.stringify(nextDeck, null, 2)}\n`, mime: "application/json" },
          { path: slidePath, content: `${JSON.stringify(slideBody, null, 2)}\n`, mime: "application/json" },
        ],
        { summary: `Add slide ${slideId}` },
      );
      slideIndex.set(prevSlides.length);
      void queries.invalidate({ prefix: ["artifacts"] });
    });
  };

  const currentSlide = computed(() => {
    const list = slidesDeck().slides;
    if (list.length === 0) return undefined;
    const idx = Math.max(0, Math.min(slideIndex(), list.length - 1));
    return list[idx];
  });

  const currentSheet = computed(() => {
    const list = sheetData().sheets;
    if (list.length === 0) return undefined;
    const idx = Math.max(0, Math.min(activeSheetIndex(), list.length - 1));
    return list[idx];
  });

  const currentFrame = computed(() => {
    const frames = designFrames();
    const chosen = activeFramePath();
    return frames.find((f) => f.path === chosen) ?? frames[0];
  });

  const isWhiteboardPreview = () => props.artifact.artifactType === "whiteboard" && tab() === "preview";

  return (
    <View testID="artifact-directory-view" class="min-h-0 min-w-0 flex-1 bg-page">
      <View testID="artifact-collab-bar" class="min-h-9 shrink-0 flex-row flex-wrap items-center gap-2 border-b border-line bg-side px-3 py-1">
        <Segmented
          testid="artifact-view-mode"
          label="View mode"
          value={tab()}
          onChange={(v) => tab.set(v)}
          options={[
            { value: "preview" as const, label: "Preview" },
            { value: "files" as const, label: `Files (${sortedFiles().length})` },
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
            <Button size="compact" tone="plain" testID="artifact-toggle-default" disabled={act.busy()} onPress={toggleDefaultDesignSystem}>
              {props.artifact.isDefault ? t("web.artifact.types.unsetDefault") : t("web.artifact.types.setDefault")}
            </Button>
          </If>
          <If when={props.version === undefined && props.compact !== true}>
            <Button size="compact" tone="plain" icon="add" testID="artifact-snapshot-version" disabled={act.busy()} onPress={createSnapshotVersion}>
              {t("web.artifact.edit.save")}
            </Button>
          </If>
          <Text testID="artifact-seq" class="font-mono text-2xs text-faint tabular-nums">
            {`seq ${seq()}`}
          </Text>
        </View>
      </View>

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
            <Scroll testID="artifact-docs-view" class="min-h-0 flex-1" contentClass="mx-auto w-full max-w-3xl gap-3 px-6 py-5">
              <If when={props.version === undefined} else={<Text class="text-sm leading-relaxed text-ink select-text">{docsContent()}</Text>}>
                <View class="gap-2">
                  <TextArea
                    testID="artifact-docs-editor"
                    accessibilityLabel={props.artifact.title}
                    rows={18}
                    value={activePath() === "structure/index.md" ? draftContent() : docsContent()}
                    onInput={(v) => {
                      if (selectedPath() !== "structure/index.md") selectedPath.set("structure/index.md");
                      draftContent.set(v);
                    }}
                  />
                  <View class="flex-row items-center justify-between gap-2">
                    <Text class="font-mono text-2xs text-muted">structure/index.md</Text>
                    <Button tone="primary" size="compact" testID="artifact-file-save" disabled={act.busy() || !dirty()} onPress={saveActiveFile}>
                      {t("web.artifact.whiteboard.save")}
                    </Button>
                  </View>
                </View>
              </If>
            </Scroll>
          </If>

          <If when={props.artifact.artifactType === "outline"}>
            <Scroll testID="artifact-outline-view" class="min-h-0 flex-1" contentClass="mx-auto w-full max-w-2xl gap-2 px-5 py-4">
              <If when={props.version === undefined}>
                <View class="flex-row items-center justify-between pb-1">
                  <Text class="font-mono text-2xs text-muted">structure/outline.json</Text>
                  <Button size="compact" icon="add" testID="outline-add-item" disabled={act.busy()} onPress={addOutlineItem}>
                    {t("web.artifact.page.new")}
                  </Button>
                </View>
              </If>
              <If when={outlineRows().length > 0} else={<Empty icon="notes">{t("web.artifact.blocks.start")}</Empty>}>
                <Each of={outlineRows()} key={(row) => row.node.id}>
                  {(row) => (
                    <View
                      testID={`outline-node-${row().node.id}`}
                      class="flex-row items-start gap-2 rounded-md px-2 py-1 hover:bg-hover"
                      style={{ paddingLeft: 8 + row().depth * 18 }}
                    >
                      <If when={row().node.kind === "todo"}>
                        <View
                          role="button"
                          testID={`outline-todo-${row().node.id}`}
                          onPress={() => toggleOutlineTodo(row().node.id)}
                          class={`mt-0.5 size-4 shrink-0 items-center justify-center rounded-xs border ${
                            row().node.checked === true ? "border-accent bg-accent" : "border-idle bg-page"
                          }`}
                        >
                          <If when={row().node.checked === true}>
                            <Icon name="ticked" size={12} tone="page" />
                          </If>
                        </View>
                      </If>
                      <If when={row().node.kind === "bullet"}>
                        <View class="mt-2 size-1.5 shrink-0 rounded-full bg-faint" />
                      </If>
                      <Text
                        class={
                          row().node.kind === "heading"
                            ? "flex-1 text-base font-semibold text-ink"
                            : row().node.checked === true
                              ? "flex-1 text-sm text-muted line-through"
                              : "flex-1 text-sm text-ink"
                        }
                      >
                        {row().node.text}
                      </Text>
                    </View>
                  )}
                </Each>
              </If>
            </Scroll>
          </If>

          <If when={props.artifact.artifactType === "slides"}>
            <View testID="artifact-slides-view" class="min-h-0 flex-1">
              <View class="min-h-0 flex-1 items-center justify-center bg-side p-6">
                <If when={currentSlide()} else={<Empty icon="present">{t("web.artifact.presenter.empty")}</Empty>}>
                  {(slide) => (
                    <View class="aspect-video w-full max-w-3xl justify-center gap-3 rounded-xl border border-line bg-page p-8 shadow-raise">
                      <Text class="font-mono text-2xs text-accent">{slide().layout.toUpperCase()}</Text>
                      <Text testID="slide-title" class="text-2xl font-semibold text-ink">
                        {slide().title}
                      </Text>
                      <If when={slide().subtitle}>
                        <Text class="text-base text-muted">{slide().subtitle}</Text>
                      </If>
                      <If when={slide().blocks.length > 0}>
                        <View class="gap-1.5 pt-2">
                          <Each of={slide().blocks} key={(_, idx) => String(idx)}>
                            {(blk) => <Text class="text-sm text-ink">{asString(blk().text, JSON.stringify(blk()))}</Text>}
                          </Each>
                        </View>
                      </If>
                      <If when={slide().notes}>
                        <View class="mt-auto border-t border-line pt-2">
                          <Text class="text-xs text-faint">{slide().notes}</Text>
                        </View>
                      </If>
                    </View>
                  )}
                </If>
              </View>
              <View class="shrink-0 flex-row items-center gap-2 border-t border-line bg-page px-3 py-2">
                <IconButton
                  icon="previous"
                  label={t("web.artifact.slides.previous")}
                  testid="slides-previous"
                  disabled={slideIndex() <= 0}
                  onClick={() => slideIndex.set(Math.max(0, slideIndex() - 1))}
                />
                <Text testID="slides-at" class="font-mono text-xs text-muted tabular-nums">
                  {`${Math.min(slideIndex() + 1, Math.max(1, slidesDeck().slides.length))} / ${slidesDeck().slides.length}`}
                </Text>
                <IconButton
                  icon="next"
                  label={t("web.artifact.slides.next")}
                  testid="slides-next"
                  disabled={slideIndex() >= slidesDeck().slides.length - 1}
                  onClick={() => slideIndex.set(Math.min(slidesDeck().slides.length - 1, slideIndex() + 1))}
                />
                <View class="flex-1" />
                <If when={props.version === undefined}>
                  <Button size="compact" icon="add" testID="slides-add" disabled={act.busy()} onPress={addSlide}>
                    {t("web.artifact.slidesStore.addSlide")}
                  </Button>
                </If>
                <If when={props.onPresent}>
                  <IconButton icon="present" label={t("web.artifact.slides.present")} testid="slides-present" onClick={() => props.onPresent?.(true)} />
                </If>
                <IconButton
                  icon="presenter"
                  label={t("web.artifact.slides.presenter")}
                  testid="slides-presenter"
                  onClick={() => router.navigate(presenterHref({ id: props.artifact.id, version: props.version ?? Math.max(1, props.artifact.version) }))}
                />
              </View>
            </View>
          </If>

          <If when={props.artifact.artifactType === "dashboard"}>
            <Scroll testID="artifact-dashboard-view" class="min-h-0 flex-1" contentClass="gap-4 p-5">
              <View class="flex-row flex-wrap gap-3">
                <Each of={dashboardData().panels} key={(p) => asString(p.id, "panel")}>
                  {(panel) => (
                    <View class="min-w-48 flex-1 gap-1 rounded-lg border border-line bg-side p-3.5">
                      <Text class="text-xs font-medium text-muted">{asString(panel().label, asString(panel().id))}</Text>
                      <Text class="font-mono text-xs text-ink">{asString(panel().kind, "kpi")}</Text>
                    </View>
                  )}
                </Each>
              </View>
              <Each of={dashboardData().datasets} key={(ds) => ds.path}>
                {(ds) => (
                  <View class="gap-2 rounded-lg border border-line bg-page p-3">
                    <View class="flex-row items-center justify-between gap-2">
                      <Text class="font-mono text-xs font-semibold text-ink">{ds().path}</Text>
                      <Button size="compact" icon="download" onPress={() => void act.run(() => exportCsvFile(ds().name, ds().rows))}>
                        {t("web.artifact.dashboard.exportCsv")}
                      </Button>
                    </View>
                    <Each of={ds().rows.slice(0, 20)} key={(_, idx) => String(idx)}>
                      {(row) => (
                        <View class="flex-row gap-3 border-t border-line py-1">
                          <Each of={ds().cols} key={(col) => col}>
                            {(col) => <Text class="min-w-0 flex-1 truncate font-mono text-xs text-ink">{`${col()}: ${formatCellValue(row()[col()])}`}</Text>}
                          </Each>
                        </View>
                      )}
                    </Each>
                  </View>
                )}
              </Each>
            </Scroll>
          </If>

          <If when={props.artifact.artifactType === "motion"}>
            <Scroll testID="artifact-motion-view" class="min-h-0 flex-1" contentClass="gap-4 p-5">
              <View class="flex-row flex-wrap items-center gap-3 rounded-lg border border-line bg-side p-3.5">
                <Text class="font-mono text-xs font-semibold text-ink">{`${motionData().width}×${motionData().height}`}</Text>
                <Text class="font-mono text-xs text-muted">{`${motionData().fps} fps`}</Text>
                <Text class="font-mono text-xs text-muted">{`${motionData().duration}s`}</Text>
              </View>
              <View class="gap-2">
                <Each of={motionData().scenes} key={(sc) => sc.id}>
                  {(sc) => (
                    <View class="gap-1.5 rounded-lg border border-line bg-page p-3">
                      <View class="flex-row items-center justify-between">
                        <Text class="text-sm font-semibold text-ink">{sc().title}</Text>
                        <Text class="font-mono text-2xs text-muted tabular-nums">{`${sc().start}s – ${sc().end}s`}</Text>
                      </View>
                      <Text class="font-mono text-2xs text-faint">{`${sc().file} · ${sc().layers.length} layers`}</Text>
                    </View>
                  )}
                </Each>
              </View>
            </Scroll>
          </If>

          <If when={props.artifact.artifactType === "design"}>
            <View testID="artifact-design-view" class="min-h-0 flex-1">
              <If when={designFrames().length > 1}>
                <Scroll horizontal class="shrink-0 border-b border-line bg-side px-3 py-1.5" contentClass="flex-row gap-1.5">
                  <Each of={designFrames()} key={(f) => f.path}>
                    {(f) => (
                      <Button size="compact" tone={currentFrame()?.path === f().path ? "primary" : "plain"} onPress={() => activeFramePath.set(f().path)}>
                        {f().name}
                      </Button>
                    )}
                  </Each>
                </Scroll>
              </If>
              <Scroll class="min-h-0 flex-1" contentClass="gap-3 p-5">
                <If when={currentFrame()} else={<Empty icon="devices">{t("web.artifact.design.noProps")}</Empty>}>
                  {(frame) => (
                    <View class="gap-3 rounded-lg border border-line bg-side p-4">
                      <View class="flex-row items-center justify-between">
                        <Text class="text-sm font-semibold text-ink">{frame().name}</Text>
                        <Text class="font-mono text-xs text-muted tabular-nums">{`${frame().width} × ${frame().height}`}</Text>
                      </View>
                      <Text class="font-mono text-2xs text-faint">{`${frame().path} · ${frame().nodes.length} nodes`}</Text>
                    </View>
                  )}
                </If>
              </Scroll>
            </View>
          </If>

          <If when={props.artifact.artifactType === "design-system"}>
            <Scroll testID="artifact-design-system-view" class="min-h-0 flex-1" contentClass="gap-4 p-5">
              <View class="flex-row items-center justify-between">
                <Text class="text-base font-semibold text-ink">{designSystemData().name}</Text>
                <Text class="font-mono text-xs text-muted">{`v${designSystemData().version}`}</Text>
              </View>
              <View class="flex-row flex-wrap gap-2.5">
                <Each of={designSystemData().colors} key={(c) => c.name}>
                  {(c) => (
                    <View class="w-40 gap-1.5 rounded-lg border border-line bg-side p-2.5">
                      <View class="flex-row gap-1.5">
                        <View class="h-8 flex-1 rounded-sm border border-line bg-page" style={c().light ? { backgroundColor: c().light } : undefined} />
                        <View class="h-8 flex-1 rounded-sm border border-line bg-ink" style={c().dark ? { backgroundColor: c().dark } : undefined} />
                      </View>
                      <Text class="truncate text-xs font-semibold text-ink">{c().name}</Text>
                      <Text class="truncate font-mono text-2xs text-muted">{`${c().light} / ${c().dark}`}</Text>
                    </View>
                  )}
                </Each>
              </View>
              <If when={designSystemData().components.length > 0}>
                <View class="gap-2">
                  <Text class="text-xs font-semibold text-muted">{t("web.artifact.designSystem.components")}</Text>
                  <Each of={designSystemData().components} key={(comp) => comp.path}>
                    {(comp) => (
                      <View class="gap-1 rounded-lg border border-line bg-page p-3">
                        <Text class="text-sm font-semibold text-ink">{comp().name}</Text>
                        <Text class="font-mono text-2xs text-muted">{comp().variants.join(" · ")}</Text>
                      </View>
                    )}
                  </Each>
                </View>
              </If>
            </Scroll>
          </If>

          <If when={props.artifact.artifactType === "sheet"}>
            <View testID="artifact-sheet-view" class="min-h-0 flex-1">
              <View class="shrink-0 flex-row items-center justify-between gap-2 border-b border-line bg-side px-3 py-1.5">
                <View class="flex-row items-center gap-1.5">
                  <Each of={sheetData().sheets} key={(s) => s.id}>
                    {(sh, idx) => (
                      <Button size="compact" tone={activeSheetIndex() === idx() ? "primary" : "plain"} onPress={() => activeSheetIndex.set(idx())}>
                        {sh().title}
                      </Button>
                    )}
                  </Each>
                </View>
                <If when={currentSheet()}>
                  {(sh) => (
                    <Button size="compact" icon="download" onPress={() => void act.run(() => exportCsvFile(sh().title, sh().rows))}>
                      {t("web.artifact.dashboard.exportCsv")}
                    </Button>
                  )}
                </If>
              </View>
              <Scroll class="min-h-0 flex-1" contentClass="gap-1 p-4">
                <If when={currentSheet()} else={<Empty icon="log">No sheets</Empty>}>
                  {(sh) => (
                    <View class="rounded-lg border border-line bg-page">
                      <View class="flex-row border-b border-line bg-side px-3 py-2">
                        <Each of={sh().columns} key={(col) => col.key}>
                          {(col) => <Text class="min-w-0 flex-1 truncate text-xs font-semibold text-ink">{col().title}</Text>}
                        </Each>
                      </View>
                      <Each of={sh().rows} key={(_, idx) => String(idx)}>
                        {(row) => (
                          <View class="flex-row border-t border-line px-3 py-1.5">
                            <Each of={sh().columns} key={(col) => col.key}>
                              {(col) => (
                                <Text class="min-w-0 flex-1 truncate font-mono text-xs text-ink">
                                  {formatCellValue(row()[col().key] ?? row()[col().title])}
                                </Text>
                              )}
                            </Each>
                          </View>
                        )}
                      </Each>
                    </View>
                  )}
                </If>
              </Scroll>
            </View>
          </If>

          <If when={props.artifact.artifactType === "prototype"}>
            {/* Strictly sandboxed WebView: incognito + strict CSP via buildPrototypeDocument (never shares host origin). */}
            <WebView
              testID="artifact-prototype-webview"
              accessibilityLabel={props.artifact.title}
              html={prototypeHtml()}
              incognito
              class="min-h-0 w-full flex-1 bg-page"
              style={props.covered === true ? { opacity: 0 } : undefined}
            />
          </If>

          <If when={props.artifact.artifactType === "diagram"}>
            <Scroll testID="artifact-diagram-view" class="min-h-0 flex-1" contentClass="gap-4 p-5">
              <View class="flex-row items-center gap-2">
                <Text class="text-sm font-semibold text-ink">{diagramData().title}</Text>
                <Text class="font-mono text-2xs text-muted">{`${diagramData().kind} · ${diagramData().direction}`}</Text>
              </View>
              <View class="flex-row flex-wrap gap-2.5">
                <Each of={diagramData().nodes} key={(n) => n.id}>
                  {(n) => (
                    <View class="min-w-36 gap-0.5 rounded-lg border border-line bg-side px-3 py-2">
                      <Text class="text-xs font-semibold text-ink">{n().label}</Text>
                      <Text class="font-mono text-2xs text-muted">{`${n().id} · ${n().kind}`}</Text>
                    </View>
                  )}
                </Each>
              </View>
              <If when={diagramData().edges.length > 0}>
                <View class="gap-1 rounded-lg border border-line bg-page p-3">
                  <Each of={diagramData().edges} key={(e) => e.id}>
                    {(e) => <Text class="font-mono text-xs text-muted">{`${e().from} → ${e().to}${e().label ? ` (${e().label})` : ""}`}</Text>}
                  </Each>
                </View>
              </If>
            </Scroll>
          </If>

          <If when={props.artifact.artifactType === "storyboard"}>
            <Scroll testID="artifact-storyboard-view" class="min-h-0 flex-1" contentClass="gap-4 p-5">
              <View class="flex-row flex-wrap items-center gap-2">
                <Text class="font-mono text-xs text-muted">{`${storyboardData().aspectRatio} · ${storyboardData().fps} fps`}</Text>
                <If when={storyboardData().visualTone}>
                  <Text class="text-xs text-ink">{storyboardData().visualTone}</Text>
                </If>
                <View class="flex-row items-center gap-1">
                  <Each of={storyboardData().palette} key={(hex) => hex}>
                    {(hex) => <View class="size-4 rounded-xs border border-line" style={{ backgroundColor: hex() }} />}
                  </Each>
                </View>
              </View>
              <View class="gap-2.5">
                <Each of={storyboardData().shots} key={(sh) => sh.id}>
                  {(sh) => (
                    <View class="gap-1.5 rounded-lg border border-line bg-side p-3">
                      <View class="flex-row items-center justify-between gap-2">
                        <Text class="text-sm font-semibold text-ink">{`${sh().id} · ${sh().scene || "Shot"}`}</Text>
                        <Text class="font-mono text-2xs text-muted tabular-nums">
                          {`${sh().durationSec}s · ${sh().framing} · ${sh().camera} · ${sh().status}`}
                        </Text>
                      </View>
                      <If when={sh().visual}>
                        <Text class="text-xs text-ink">{sh().visual}</Text>
                      </If>
                      <If when={sh().dialogue}>
                        <Text class="text-xs text-muted">{sh().dialogue}</Text>
                      </If>
                    </View>
                  )}
                </Each>
              </View>
            </Scroll>
          </If>
        </View>
      </If>

      <If when={tab() === "files"}>
        <View testID="artifact-files-view" class="min-h-0 min-w-0 flex-1 flex-row">
          <View class="w-60 shrink-0 border-r border-line bg-side">
            <View class="flex-row items-center justify-between border-b border-line px-2.5 py-1.5">
              <Text class="text-xs font-semibold text-muted">Directory</Text>
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
                  placeholder="structure/notes.md"
                  accessibilityLabel="New file path"
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
                        <IconButton
                          icon="delete"
                          size={12}
                          label={t("web.artifact.page.delete")}
                          testid={`artifact-file-delete-${f().path}`}
                          onClick={() => deleteSelectedFile(f().path)}
                        />
                      </If>
                    </View>
                  );
                }}
              </Each>
            </Scroll>
          </View>

          <View class="min-h-0 min-w-0 flex-1 p-3">
            <View class="mb-2 flex-row items-center justify-between gap-2">
              <Text testID="artifact-file-active-path" class="truncate font-mono text-xs font-semibold text-ink">
                {activePath()}
              </Text>
              <If when={props.version === undefined}>
                <Button size="compact" tone="primary" testID="artifact-file-save" disabled={act.busy() || !dirty()} onPress={saveActiveFile}>
                  {t("web.artifact.whiteboard.save")}
                </Button>
              </If>
            </View>
            <TextArea
              testID="artifact-file-editor"
              accessibilityLabel={activePath()}
              rows={20}
              value={draftContent()}
              onInput={(v) => draftContent.set(v)}
              class="min-h-0 flex-1 font-mono text-xs"
            />
          </View>
        </View>
      </If>
    </View>
  );
}
