import { computed, effect, Scroll, signal, Text, untracked, View, WebView, type WebViewRef } from "nsh";

import { t } from "@vibevalley/i18n";
import type { ArtifactEntryWriteInput } from "@vibevalley/protocol";

import { createAct } from "../../design/act";
import { Button } from "../../design/Button";
import { TextArea, TextInput } from "../../design/Field";
import { Icon } from "../../design/Icon";
import { IconButton } from "../../design/IconButton";
import { toast } from "../../design/toasts";
import { useCore } from "../../infra/frame";
import { shownTheme } from "../../infra/state/prefs";
import { withPolicy } from "./frame";
import { HtmlFrame } from "./HtmlFrame";
import { type ShellTheme, themeVariables, typeVariables } from "./shell";
import { saveTextFile, useReportViewContext, useStoreEntries } from "./store";
import type { StoreViewerProps } from "./StoreArtifactView";
import { storeMessageOf } from "./viewers";
import {
  autoAnchorSides,
  bodyOf,
  buildArchitectureTemplate,
  buildTimelineTemplate,
  buildWhiteboardHtml,
  buildWhiteboardSvg,
  createUndoStack,
  FILL_OPTIONS,
  labelOf,
  makeElementId,
  simplifyStroke,
  STICKER_IDS,
  type ArchitectureTemplateCopy,
  type PlaceableTool,
  type StickerId,
  type TimelineTemplateCopy,
  type WbElement,
  type WbFill,
  type WbPresence,
  type WbTool,
  WhiteboardBridgeMessageSchema,
  WhiteboardElementSchema,
  WhiteboardPresenceSchema,
} from "./whiteboard";

const wbShim = String.raw`(() => {
  const allowed = new Set([
    "wb-ready",
    "wb-select",
    "wb-move",
    "wb-resize",
    "wb-create",
    "wb-path",
    "wb-arrow",
    "wb-label",
    "wb-delete",
    "wb-duplicate",
    "wb-tool",
    "wb-undo",
    "wb-redo",
    "wb-chat",
    "wb-template",
    "wb-viewport",
    "store-embed-save",
  ]);
  addEventListener("message", (e) => {
    const d = e.data;
    if (d && typeof d === "object" && typeof d.vibevalley === "string" && allowed.has(d.vibevalley)) {
      window.nsh?.postMessage(JSON.stringify(d));
    }
  });
})();`;

const fillDotClass: Record<WbFill, string> = {
  default: "border border-line bg-page",
  sun: "bg-wheat",
  peach: "bg-warn-soft border border-wheat",
  leaf: "bg-leaf",
  water: "bg-water",
  lavender: "bg-selected border border-faint",
  berry: "bg-berry",
  side: "bg-idle",
};

function fillLabel(fill: WbFill): string {
  switch (fill) {
    case "default":
      return t("web.artifact.whiteboard.fillDefault");
    case "sun":
      return t("web.artifact.whiteboard.fillSun");
    case "peach":
      return t("web.artifact.whiteboard.fillPeach");
    case "leaf":
      return t("web.artifact.whiteboard.fillLeaf");
    case "water":
      return t("web.artifact.whiteboard.fillWater");
    case "lavender":
      return t("web.artifact.whiteboard.fillLavender");
    case "berry":
      return t("web.artifact.whiteboard.fillBerry");
    case "side":
      return t("web.artifact.whiteboard.fillSide");
  }
}

function timelineTemplateCopy(): TimelineTemplateCopy {
  return {
    title: t("web.artifact.whiteboard.tplTimeTitle"),
    subtitle: t("web.artifact.whiteboard.tplTimeSubtitle"),
    highlight: t("web.artifact.whiteboard.tplTimeHighlight"),
    day1: t("web.artifact.whiteboard.tplTimeDay1"),
    day2: t("web.artifact.whiteboard.tplTimeDay2"),
    day3: t("web.artifact.whiteboard.tplTimeDay3"),
    day7: t("web.artifact.whiteboard.tplTimeDay7"),
    day8: t("web.artifact.whiteboard.tplTimeDay8"),
    roadCaption: t("web.artifact.whiteboard.tplTimeRoad"),
    step1Title: t("web.artifact.whiteboard.tplTimeStep1Title"),
    step1Body: t("web.artifact.whiteboard.tplTimeStep1Body"),
    step2Title: t("web.artifact.whiteboard.tplTimeStep2Title"),
    step2Body: t("web.artifact.whiteboard.tplTimeStep2Body"),
    step3Title: t("web.artifact.whiteboard.tplTimeStep3Title"),
    step3Body: t("web.artifact.whiteboard.tplTimeStep3Body"),
    step4Title: t("web.artifact.whiteboard.tplTimeStep4Title"),
    step4Body: t("web.artifact.whiteboard.tplTimeStep4Body"),
    step5Title: t("web.artifact.whiteboard.tplTimeStep5Title"),
    step5Body: t("web.artifact.whiteboard.tplTimeStep5Body"),
    step6Title: t("web.artifact.whiteboard.tplTimeStep6Title"),
    step6Body: t("web.artifact.whiteboard.tplTimeStep6Body"),
    callout: t("web.artifact.whiteboard.tplTimeCallout"),
    userLabel: t("web.artifact.whiteboard.tplUser"),
    orchLabel: t("web.artifact.whiteboard.tplAgentOrch"),
    helperLabel: t("web.artifact.whiteboard.tplAgentHelper"),
  };
}

function architectureTemplateCopy(): ArchitectureTemplateCopy {
  return {
    title: t("web.artifact.whiteboard.tplArchTitle"),
    subtitle: t("web.artifact.whiteboard.tplArchSubtitle"),
    highlight: t("web.artifact.whiteboard.tplArchHighlight"),
    zoneCore: t("web.artifact.whiteboard.tplArchZoneCore"),
    zoneStore: t("web.artifact.whiteboard.tplArchZoneStore"),
    clientTitle: t("web.artifact.whiteboard.tplArchClient"),
    clientBody: t("web.artifact.whiteboard.tplArchClientBody"),
    apiTitle: t("web.artifact.whiteboard.tplArchApi"),
    apiBody: t("web.artifact.whiteboard.tplArchApiBody"),
    coreTitle: t("web.artifact.whiteboard.tplArchCore"),
    coreBody: t("web.artifact.whiteboard.tplArchCoreBody"),
    sqliteTitle: t("web.artifact.whiteboard.tplArchSqlite"),
    sqliteBody: t("web.artifact.whiteboard.tplArchSqliteBody"),
    callout: t("web.artifact.whiteboard.tplArchCallout"),
  };
}

function defaultElementPayload(id: string, x: number, y: number, kind: PlaceableTool, sticker?: string): Record<string, unknown> {
  const base = { id, x: Math.round(x / 12) * 12, y: Math.round(y / 12) * 12 };
  switch (kind) {
    case "container":
      return { ...base, type: "container", w: 340, h: 220, title: t("web.artifact.whiteboard.tplDefaultFrame"), fill: "side" };
    case "text":
      return { ...base, type: "text", variant: "body", w: 220, h: 42, label: t("web.artifact.whiteboard.tplDefaultHeading") };
    case "sticky":
      return {
        ...base,
        type: "shape",
        shape: "card",
        w: 184,
        h: 112,
        fill: "sun",
        title: t("web.artifact.whiteboard.tplDefaultTitle"),
        body: t("web.artifact.whiteboard.tplDefaultBody"),
      };
    case "sticker":
      return { ...base, type: "sticker", w: 72, h: 72, sticker: sticker || "sparkles", label: t("web.artifact.whiteboard.sticker") };
    case "timeline":
      return {
        ...base,
        type: "timeline",
        w: 620,
        h: 88,
        fill: "peach",
        points: [
          { x: base.x, y: base.y + 44 },
          { x: base.x + 310, y: base.y + 20 },
          { x: base.x + 620, y: base.y + 44 },
        ],
        milestones: [
          { t: 0.08, label: t("web.artifact.whiteboard.tplDefaultTimelineStart"), kind: "major" },
          { t: 0.5, label: t("web.artifact.whiteboard.tplDefaultTimelineMid"), kind: "major" },
          { t: 0.92, label: t("web.artifact.whiteboard.tplDefaultTimelineEnd"), kind: "major" },
        ],
      };
    case "rect":
      return { ...base, type: "shape", shape: "rect", w: 184, h: 80, label: t("web.artifact.whiteboard.tplDefaultNote") };
  }
}

export function WhiteboardView(props: StoreViewerProps) {
  const { client, snapshot } = useStoreEntries(() => props.artifact.id);
  const core = useCore();
  const act = createAct();
  const undoStack = createUndoStack();

  const tool = signal<WbTool>("select");
  const zoom = signal(1);
  const selectedIds = signal<readonly string[]>([]);
  const inspectorOpen = signal(false);
  const webReady = signal(false);
  const labelDraft = signal("");
  const bodyDraft = signal("");
  const highlightDraft = signal("");
  const jsonDraft = signal("");
  const lastInspectedKey = signal<string | undefined>(undefined);
  const historyTick = signal(0);

  let webRef: WebViewRef | undefined;

  const seq = () => (snapshot().seq > 0 ? snapshot().seq : props.artifact.seq);

  const elements = computed((): WbElement[] => {
    const out: WbElement[] = [];
    for (const [path, entry] of snapshot().entries) {
      if (!path.startsWith("elements/") || !entry.value) continue;
      try {
        const parsed = WhiteboardElementSchema.safeParse(JSON.parse(entry.value));
        if (parsed.success) out.push({ ...parsed.data, rev: entry.rev, raw: entry.value });
      } catch (e) {
        if (e instanceof SyntaxError) continue;
        throw e;
      }
    }
    return out;
  });

  const presences = computed((): WbPresence[] => {
    const out: WbPresence[] = [];
    const seen = new Set<string>();
    for (const [path, entry] of snapshot().entries) {
      if (!path.startsWith("presence/") || !entry.value) continue;
      try {
        const parsed = WhiteboardPresenceSchema.safeParse(JSON.parse(entry.value));
        if (parsed.success) {
          out.push(parsed.data);
          seen.add(parsed.data.id);
        }
      } catch (e) {
        if (e instanceof SyntaxError) continue;
        throw e;
      }
    }
    const claims = elements().filter((el) => el.type === "claim");
    const sessions = core()?.sessions ?? [];
    for (const sess of sessions) {
      if (sess.phase._tag !== "working" || seen.has(sess.agent)) continue;
      const ownClaim = claims.find((c) => c.id.includes(sess.agent) || labelOf(c).includes(sess.name));
      if (ownClaim) {
        out.push({
          id: sess.agent,
          name: sess.name,
          color: "coral",
          x: (ownClaim.x ?? 80) + (ownClaim.w ?? 200) - 18,
          y: (ownClaim.y ?? 80) + (ownClaim.h ?? 100) - 12,
        });
      }
    }
    return out;
  });

  const selectedElement = computed(() => {
    const first = selectedIds()[0];
    return first ? elements().find((e) => e.id === first) : undefined;
  });

  effect(() => {
    const el = selectedElement();
    const key = el ? `${el.id}:${el.rev}` : undefined;
    if (key !== untracked(() => lastInspectedKey())) {
      lastInspectedKey.set(key);
      labelDraft.set(el ? labelOf(el) : "");
      bodyDraft.set(el ? bodyOf(el) : "");
      highlightDraft.set(el?.highlight ?? "");
      jsonDraft.set(el ? el.raw : "");
    }
  });

  useReportViewContext(
    () => props.artifact.id,
    () => ({
      artifactType: "whiteboard",
      title: props.artifact.title,
      seq: seq(),
      ...(selectedIds().length > 0 ? { selectedIds: [...selectedIds()] } : {}),
    }),
  );

  const runtimeLabels = () => ({
    emptyHint: t("web.artifact.whiteboard.emptyHint") || t("web.artifact.whiteboard.empty"),
    doubleClickEdit: t("web.artifact.whiteboard.doubleClickEdit"),
    chatWithOrchestrator: t("web.artifact.whiteboard.chatWithOrchestrator"),
    templateTimeline: t("web.artifact.whiteboard.templateTimeline"),
    templateArchitecture: t("web.artifact.whiteboard.templateArchitecture"),
    select: t("web.artifact.whiteboard.select"),
    pan: t("web.artifact.whiteboard.pan"),
    text: t("web.artifact.whiteboard.text"),
    container: t("web.artifact.whiteboard.container"),
    sticky: t("web.artifact.whiteboard.card"),
    pen: t("web.artifact.whiteboard.pen"),
    rect: t("web.artifact.whiteboard.rect"),
    sticker: t("web.artifact.whiteboard.sticker"),
    arrow: t("web.artifact.whiteboard.arrow"),
    timeline: t("web.artifact.whiteboard.timeline"),
  });

  const initialHtml = withPolicy(
    buildWhiteboardHtml(
      untracked(() => shownTheme()),
      runtimeLabels(),
    ),
  );

  const pushSync = () => {
    if (!webReady() || !webRef) return;
    const th: ShellTheme = shownTheme();
    const wireElements = elements().map((el) => ({
      ...el,
      ...(el.type === "svg" && el.svg ? { sanitizedSvg: el.svg } : {}),
    }));
    const payload = {
      elements: wireElements,
      presences: presences(),
      selectedIds: [...selectedIds()],
      tool: tool(),
      theme: th,
      themeCss: `${themeVariables[th]}${typeVariables}`,
    };
    webRef.injectJavaScript(`window.__wb && window.__wb.sync(${JSON.stringify(payload)});`);
  };

  effect(() => {
    void elements();
    void presences();
    void selectedIds();
    void tool();
    void shownTheme();
    void webReady();
    pushSync();
  });

  const commitBatch = (writes: ArtifactEntryWriteInput[], recordUndo = true) => {
    if (writes.length === 0) return;
    if (recordUndo) {
      const entries = snapshot().entries;
      const undoWrites: ArtifactEntryWriteInput[] = [];
      for (const w of writes) {
        const prev = entries.get(w.path);
        if (w.op === "delete" || w.op === "patch" || w.op === "set") {
          if (prev?.value !== undefined) {
            undoWrites.push({ op: "set", path: w.path, kind: prev.kind, value: prev.value });
          } else {
            undoWrites.push({ op: "delete", path: w.path });
          }
        }
      }
      undoStack.push({ undo: undoWrites, redo: writes });
      historyTick.set(untracked(historyTick) + 1);
    }
    void act.run(() => client.batch(writes));
  };

  const canUndo = () => {
    void historyTick();
    return undoStack.canUndo();
  };

  const canRedo = () => {
    void historyTick();
    return undoStack.canRedo();
  };

  const runUndo = () => {
    const step = undoStack.popUndo();
    if (!step) return;
    historyTick.set(untracked(historyTick) + 1);
    void act.run(() => client.batch([...step.undo]));
  };

  const runRedo = () => {
    const step = undoStack.popRedo();
    if (!step) return;
    historyTick.set(untracked(historyTick) + 1);
    void act.run(() => client.batch([...step.redo]));
  };

  const createAt = (worldX: number, worldY: number, kind: PlaceableTool, sticker?: string) => {
    const id = makeElementId(kind === "timeline" ? "tl" : kind === "sticker" ? "st" : "n");
    const payload = defaultElementPayload(id, worldX, worldY, kind, sticker);
    selectedIds.set([id]);
    tool.set("select");
    commitBatch([{ op: "set", path: `elements/${id}`, kind: "json", value: JSON.stringify(payload) }]);
  };

  const quickAdd = (kind: PlaceableTool) => {
    const count = elements().length;
    createAt(108 + (count % 5) * 44, 108 + Math.floor(count / 5) * 44, kind);
  };

  const applyTemplate = (kind: "timeline" | "architecture") => {
    const writes = kind === "timeline" ? buildTimelineTemplate(timelineTemplateCopy()) : buildArchitectureTemplate(architectureTemplateCopy());
    selectedIds.set([]);
    commitBatch(writes);
    queueMicrotask(() => webRef?.injectJavaScript("window.__wb && window.__wb.fitView();"));
  };

  const deleteByIds = (ids: readonly string[]) => {
    if (ids.length === 0) return;
    selectedIds.set(selectedIds().filter((id) => !ids.includes(id)));
    commitBatch(ids.map((id) => ({ op: "delete" as const, path: `elements/${id}` })));
  };

  const duplicateByIds = (ids: readonly string[]) => {
    const byId = new Map(elements().map((e) => [e.id, e]));
    const writes: ArtifactEntryWriteInput[] = [];
    const created: string[] = [];
    for (const srcId of ids) {
      const el = byId.get(srcId);
      if (!el) continue;
      const newId = makeElementId("n");
      const { rev: _r, raw: _raw, ...rest } = el;
      const cloned: Record<string, unknown> = {
        ...rest,
        id: newId,
        ...(el.x !== undefined ? { x: el.x + 28 } : {}),
        ...(el.y !== undefined ? { y: el.y + 28 } : {}),
        ...(el.points ? { points: el.points.map((p) => ({ x: p.x + 28, y: p.y + 28 })) } : {}),
      };
      writes.push({ op: "set", path: `elements/${newId}`, kind: "json", value: JSON.stringify(cloned) });
      created.push(newId);
    }
    if (writes.length > 0) {
      selectedIds.set(created);
      commitBatch(writes);
    }
  };

  const patchLabel = (id: string, text: string, body?: string) => {
    const el = elements().find((e) => e.id === id);
    if (!el) return;
    const patch: Record<string, unknown> =
      el.type === "container"
        ? { title: text }
        : el.type === "shape" && (el.title !== undefined || el.shape === "card" || body !== undefined)
          ? { title: text, ...(body !== undefined ? { body } : {}) }
          : { label: text, ...(el.title !== undefined ? { title: text } : {}), ...(el.text !== undefined ? { text } : {}) };
    commitBatch([{ op: "patch", path: `elements/${id}`, value: JSON.stringify(patch) }]);
  };

  const patchFields = (id: string, patch: Record<string, unknown>) => {
    commitBatch([{ op: "patch", path: `elements/${id}`, value: JSON.stringify(patch) }]);
  };

  const patchFill = (id: string, fill: WbFill) => {
    patchFields(id, fill === "default" ? { fill: null } : { fill });
  };

  const saveInspectorJson = () => {
    const el = selectedElement();
    if (!el) return;
    const raw = jsonDraft();
    void act.run(async () => {
      JSON.parse(raw);
      await client.batch([{ op: "set", path: `elements/${el.id}`, kind: "json", value: raw, ifRev: el.rev }]);
      toast(t("web.artifact.whiteboard.savedElement"));
    });
  };

  const handleRawMessage = (raw: unknown) => {
    const embedMsg = storeMessageOf(raw);
    if (embedMsg?.vibevalley === "store-embed-save") {
      commitBatch([{ op: "patch", path: `elements/${embedMsg.elementId}`, value: JSON.stringify({ state: embedMsg.state }) }], false);
      return;
    }

    const parsed = WhiteboardBridgeMessageSchema.safeParse(raw);
    if (!parsed.success) return;
    const msg = parsed.data;
    switch (msg.vibevalley) {
      case "wb-ready":
        webReady.set(true);
        break;
      case "wb-select":
        selectedIds.set(msg.ids);
        break;
      case "wb-move": {
        const byId = new Map(elements().map((e) => [e.id, e]));
        const writes: ArtifactEntryWriteInput[] = msg.moves.map((m) => {
          const prev = byId.get(m.id);
          const dx = m.x - (prev?.x ?? 0);
          const dy = m.y - (prev?.y ?? 0);
          const movedPoints = prev?.points ? prev.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) : undefined;
          return {
            op: "patch" as const,
            path: `elements/${m.id}`,
            value: JSON.stringify({ x: m.x, y: m.y, ...(movedPoints ? { points: movedPoints } : {}) }),
          };
        });
        commitBatch(writes);
        break;
      }
      case "wb-resize":
        patchFields(msg.id, { x: msg.x, y: msg.y, w: msg.w, h: msg.h });
        break;
      case "wb-create":
        createAt(msg.x, msg.y, msg.kind, msg.sticker);
        break;
      case "wb-path": {
        const pts = simplifyStroke(msg.points);
        const xs = pts.map((p) => p.x);
        const ys = pts.map((p) => p.y);
        const minX = Math.min(...xs);
        const minY = Math.min(...ys);
        const maxX = Math.max(...xs);
        const maxY = Math.max(...ys);
        const id = makeElementId("p");
        const pathEl = {
          id,
          type: "path",
          x: minX,
          y: minY,
          w: Math.max(16, maxX - minX),
          h: Math.max(16, maxY - minY),
          points: pts,
          stroke: "#c25140",
          strokeWidth: 3,
        };
        commitBatch([{ op: "set", path: `elements/${id}`, kind: "json", value: JSON.stringify(pathEl) }]);
        break;
      }
      case "wb-arrow": {
        const arrowId = makeIdForArrow(elements(), msg.fromId, msg.toId, msg.fromSide, msg.toSide);
        tool.set("select");
        commitBatch([
          {
            op: "set",
            path: `elements/${arrowId.id}`,
            kind: "json",
            value: JSON.stringify(arrowId),
          },
        ]);
        break;
      }
      case "wb-label":
        patchLabel(msg.id, msg.text, msg.body);
        break;
      case "wb-delete":
        deleteByIds(msg.ids);
        break;
      case "wb-duplicate":
        duplicateByIds(msg.ids);
        break;
      case "wb-tool":
        tool.set(msg.tool);
        break;
      case "wb-undo":
        runUndo();
        break;
      case "wb-redo":
        runRedo();
        break;
      case "wb-chat":
        props.onOpenChat?.();
        break;
      case "wb-template":
        applyTemplate(msg.template);
        break;
      case "wb-viewport":
        zoom.set(msg.zoom);
        break;
    }
  };

  const handleWebViewMessage = (data: string) => {
    try {
      handleRawMessage(JSON.parse(data));
    } catch {
      return;
    }
  };

  const safeFileBase = () => (props.artifact.title.trim() || "whiteboard").replace(/[\\/:*?"<>|]/gu, "-");

  const exportSvg = () => {
    void act.run(async () => {
      const svg = buildWhiteboardSvg(elements(), presences(), shownTheme());
      const saved = await saveTextFile(`${safeFileBase()}.svg`, "image/svg+xml", svg);
      if (saved) toast(t("web.artifact.whiteboard.exportedSvg"));
    });
  };

  const exportJson = () => {
    void act.run(async () => {
      const metaRaw = snapshot().entries.get("board/meta")?.value;
      const meta: unknown = metaRaw ? JSON.parse(metaRaw) : undefined;
      const payload = {
        title: props.artifact.title,
        seq: seq(),
        meta,
        elements: elements().map(({ rev: _rev, raw: _raw, ...rest }) => rest),
      };
      const saved = await saveTextFile(`${safeFileBase()}.json`, "application/json", JSON.stringify(payload, null, 2));
      if (saved) toast(t("web.artifact.whiteboard.exportedJson"));
    });
  };

  const toolButton = (id: WbTool, label: string) => {
    const active = () => tool() === id;
    return (
      <View
        role="button"
        testID={`wb-tool-${id}`}
        accessibilityState={{ selected: active() }}
        onPress={() => tool.set(id)}
        class={`h-7 justify-center rounded-md px-2 transition duration-120 ease-out focus-visible:outline-2 focus-visible:outline-focus ${
          active() ? "bg-selected" : "hover:bg-hover"
        }`}
      >
        <Text class={`text-xs font-medium ${active() ? "text-ink" : "text-muted"}`}>{label}</Text>
      </View>
    );
  };

  return (
    <View testID="whiteboard-view" class="min-h-0 min-w-0 flex-1 overflow-hidden rounded-lg border border-line bg-side">
      <View class="min-h-11 shrink-0 flex-row flex-wrap items-center gap-1 border-b border-line bg-page px-2.5 py-1.5">
        {toolButton("select", t("web.artifact.whiteboard.select"))}
        {toolButton("pan", t("web.artifact.whiteboard.pan"))}
        <View class="mx-1 h-4 w-px bg-line" />
        {toolButton("sticky", t("web.artifact.whiteboard.card"))}
        {toolButton("rect", t("web.artifact.whiteboard.rect"))}
        {toolButton("text", t("web.artifact.whiteboard.text"))}
        {toolButton("container", t("web.artifact.whiteboard.container"))}
        {toolButton("pen", t("web.artifact.whiteboard.pen"))}
        {toolButton("sticker", t("web.artifact.whiteboard.sticker"))}
        {toolButton("arrow", t("web.artifact.whiteboard.arrow"))}
        {toolButton("timeline", t("web.artifact.whiteboard.timeline"))}
        <View class="mx-1 h-4 w-px bg-line" />
        <IconButton icon="undo" label={t("web.artifact.whiteboard.undo")} testid="wb-undo" disabled={!canUndo() || act.busy()} onClick={runUndo} />
        <IconButton icon="retry" label={t("web.artifact.whiteboard.redo")} testid="wb-redo" disabled={!canRedo() || act.busy()} onClick={runRedo} />
        <Button icon="add" testID="wb-add-node" disabled={act.busy()} onPress={() => quickAdd("sticky")}>
          {t("web.artifact.whiteboard.sticky")}
        </Button>
        <Button icon="add" testID="wb-add-frame" disabled={act.busy()} onPress={() => quickAdd("container")}>
          {t("web.artifact.whiteboard.container")}
        </Button>
        <Button icon="calendar" testID="wb-template-timeline" disabled={act.busy()} onPress={() => applyTemplate("timeline")}>
          {t("web.artifact.whiteboard.templateTimeline")}
        </Button>
        <If when={selectedIds().length > 0}>
          <IconButton
            icon="copy"
            label={t("web.artifact.whiteboard.duplicate")}
            testid="wb-duplicate"
            disabled={act.busy()}
            onClick={() => duplicateByIds(selectedIds())}
          />
          <Button tone="danger" icon="delete" testID="wb-delete" disabled={act.busy()} onPress={() => deleteByIds(selectedIds())}>
            {t("web.artifact.whiteboard.deleteSelected")}
          </Button>
        </If>

        <View class="ml-auto flex-row items-center gap-1">
          <Text testID="wb-count" class="pr-1 font-mono text-xs text-muted tabular-nums">
            {t("web.artifact.whiteboard.elements", { n: elements().length })}
          </Text>
          <IconButton
            icon="minus"
            label={t("web.artifact.whiteboard.zoomOut")}
            testid="wb-zoom-out"
            onClick={() => webRef?.injectJavaScript("window.__wb && window.__wb.zoomBy(-0.15);")}
          />
          <Text class="min-w-11 text-center font-mono text-xs text-muted tabular-nums">{`${Math.round(zoom() * 100)}%`}</Text>
          <IconButton
            icon="add"
            label={t("web.artifact.whiteboard.zoomIn")}
            testid="wb-zoom-in"
            onClick={() => webRef?.injectJavaScript("window.__wb && window.__wb.zoomBy(0.15);")}
          />
          <IconButton
            icon="enlarge"
            label={t("web.artifact.whiteboard.fitView")}
            testid="wb-fit"
            onClick={() => webRef?.injectJavaScript("window.__wb && window.__wb.fitView();")}
          />
          <View class="mx-1 h-4 w-px bg-line" />
          <Button icon="download" testID="wb-export-svg" disabled={act.busy()} onPress={exportSvg}>
            SVG
          </Button>
          <Button icon="download" testID="wb-export-json" disabled={act.busy()} onPress={exportJson}>
            JSON
          </Button>
          <IconButton
            icon="edit"
            label={t("web.artifact.whiteboard.inspector")}
            testid="wb-inspector-toggle"
            pressed={inspectorOpen()}
            onClick={() => inspectorOpen.set(!inspectorOpen())}
          />
          <If when={props.onOpenChat}>
            <Button tone="primary" icon="idea" testID="wb-chat" onPress={() => props.onOpenChat?.()}>
              {t("web.artifact.whiteboard.chatWithOrchestrator")}
            </Button>
          </If>
        </View>
      </View>

      <View class="min-h-0 min-w-0 flex-1 flex-row">
        <View class="min-h-0 min-w-0 flex-1">
          <WebView
            ref={(r) => {
              webRef = r;
            }}
            testID="wb-canvas"
            accessibilityLabel={props.artifact.title}
            html={initialHtml}
            incognito
            injectedJavaScriptBeforeContentLoaded={wbShim}
            onMessage={(e) => handleWebViewMessage(e.data)}
            class={`min-h-0 min-w-0 flex-1 ${props.frameClass ?? ""}`}
            style={props.covered === true ? { opacity: 0 } : undefined}
          />
        </View>

        <If when={inspectorOpen()}>
          <View testID="wb-inspector" class="w-76 shrink-0 border-l border-line bg-page">
            <View class="shrink-0 flex-row items-center justify-between gap-2 border-b border-line bg-side px-3 py-2">
              <Text class="min-w-0 flex-1 truncate text-xs font-semibold text-muted">
                {selectedElement()?.id ?? t("web.artifact.whiteboard.elements", { n: elements().length })}
              </Text>
              <IconButton icon="close" size={14} label={t("web.artifact.canvas.close")} onClick={() => inspectorOpen.set(false)} />
            </View>
            <Scroll class="min-h-0 flex-1" contentClass="p-3 gap-3">
              <If
                when={selectedElement()}
                else={
                  <View class="gap-1.5">
                    <Each of={elements()}>
                      {(el) => (
                        <View
                          role="button"
                          testID={`wb-inspector-item-${el().id}`}
                          onPress={() => selectedIds.set([el().id])}
                          class="h-8 flex-row items-center justify-between gap-2 rounded-md border border-line bg-side px-2.5 transition duration-120 ease-out hover:border-faint hover:bg-hover focus-visible:outline-2 focus-visible:outline-focus"
                        >
                          <Text class="min-w-0 flex-1 truncate text-xs font-medium text-ink">{labelOf(el()) || el().id}</Text>
                          <Text class="shrink-0 font-mono text-2xs text-faint">{el().type}</Text>
                        </View>
                      )}
                    </Each>
                  </View>
                }
              >
                {(el) => (
                  <View class="gap-3">
                    <View class="flex-row items-center justify-between gap-2">
                      <View class="min-w-0 flex-1 flex-row items-center gap-1.5">
                        <Icon name="bolt" size={12} tone="muted" />
                        <Text class="truncate font-mono text-xs font-semibold text-ink">{el().id}</Text>
                      </View>
                      <Text class="shrink-0 font-mono text-2xs text-faint tabular-nums">{`${el().type} · rev ${el().rev}`}</Text>
                    </View>

                    <If when={el().type !== "path"}>
                      <View class="gap-1">
                        <Text class="text-xs font-medium text-muted">{t("web.artifact.whiteboard.label")}</Text>
                        <View class="flex-row items-center gap-1.5">
                          <TextInput
                            testID="wb-inspector-label"
                            value={labelDraft()}
                            onInput={(v) => labelDraft.set(v)}
                            onSubmit={(v) => patchLabel(el().id, v.trim(), el().type === "shape" ? bodyDraft().trim() : undefined)}
                            class="min-w-0 flex-1"
                          />
                          <Button
                            tone="primary"
                            testID="wb-inspector-save"
                            disabled={act.busy()}
                            onPress={() => patchLabel(el().id, labelDraft().trim(), el().type === "shape" ? bodyDraft().trim() : undefined)}
                          >
                            {t("web.artifact.whiteboard.save")}
                          </Button>
                        </View>
                      </View>
                    </If>

                    <If when={el().type === "shape"}>
                      <View class="gap-1">
                        <View class="flex-row flex-wrap gap-1">
                          {(
                            [
                              ["card", t("web.artifact.whiteboard.card")],
                              ["sticky", t("web.artifact.whiteboard.sticky")],
                              ["rect", t("web.artifact.whiteboard.rect")],
                              ["diamond", t("web.artifact.whiteboard.diamond")],
                            ] as const
                          ).map(([sk, label]) => {
                            const active = () => (el().shape ?? "rect") === sk;
                            return (
                              <View
                                role="button"
                                accessibilityState={{ selected: active() }}
                                onPress={() => patchFields(el().id, { shape: sk })}
                                class={`h-6 items-center justify-center rounded-md border px-2 ${
                                  active() ? "border-accent bg-selected" : "border-line bg-side hover:bg-hover"
                                }`}
                              >
                                <Text class={`text-2xs font-medium ${active() ? "text-ink" : "text-muted"}`}>{label}</Text>
                              </View>
                            );
                          })}
                        </View>
                      </View>

                      <View class="gap-1">
                        <Text class="text-xs font-medium text-muted">{t("web.artifact.whiteboard.body")}</Text>
                        <View class="flex-row items-center gap-1.5">
                          <TextInput
                            testID="wb-inspector-body"
                            value={bodyDraft()}
                            onInput={(v) => bodyDraft.set(v)}
                            onSubmit={(v) => patchFields(el().id, { body: v.trim() })}
                            class="min-w-0 flex-1"
                          />
                        </View>
                      </View>

                      <View class="gap-1">
                        <Text class="text-xs font-medium text-muted">{t("web.artifact.whiteboard.fill")}</Text>
                        <View class="flex-row flex-wrap gap-1">
                          <Each of={FILL_OPTIONS}>
                            {(f) => {
                              const current = () => (el().fill ?? "default") === f();
                              return (
                                <View
                                  role="button"
                                  accessibilityState={{ selected: current() }}
                                  onPress={() => patchFill(el().id, f())}
                                  class={`h-6 flex-row items-center gap-1.5 rounded-md border px-2 transition duration-120 ease-out focus-visible:outline-2 focus-visible:outline-focus ${
                                    current() ? "border-accent bg-selected" : "border-line bg-side hover:border-faint hover:bg-hover"
                                  }`}
                                >
                                  <View class={`size-2 shrink-0 rounded-full ${fillDotClass[f()]}`} />
                                  <Text class={`text-2xs font-medium ${current() ? "text-ink" : "text-muted"}`}>{fillLabel(f())}</Text>
                                </View>
                              );
                            }}
                          </Each>
                        </View>
                      </View>

                      <View class="gap-1">
                        <Text class="text-xs font-medium text-muted">{t("web.artifact.whiteboard.stickers")}</Text>
                        <View class="flex-row flex-wrap gap-1">
                          <View
                            role="button"
                            accessibilityState={{ selected: !el().sticker }}
                            onPress={() => patchFields(el().id, { sticker: null })}
                            class={`h-6 items-center justify-center rounded-md border px-2 ${
                              !el().sticker ? "border-accent bg-selected" : "border-line bg-side hover:bg-hover"
                            }`}
                          >
                            <Text class="text-2xs font-medium text-muted">{t("web.artifact.whiteboard.noSticker")}</Text>
                          </View>
                          <Each of={STICKER_IDS}>
                            {(sid) => {
                              const picked = () => el().sticker === sid();
                              return (
                                <View
                                  role="button"
                                  accessibilityState={{ selected: picked() }}
                                  onPress={() => patchFields(el().id, { sticker: sid() satisfies StickerId })}
                                  class={`h-6 items-center justify-center rounded-md border px-1.5 ${
                                    picked() ? "border-accent bg-selected" : "border-line bg-side hover:bg-hover"
                                  }`}
                                >
                                  <Text class="font-mono text-2xs text-ink">{sid()}</Text>
                                </View>
                              );
                            }}
                          </Each>
                        </View>
                      </View>
                    </If>

                    <If when={el().type === "text"}>
                      <View class="gap-1">
                        <Text class="text-xs font-medium text-muted">{t("web.artifact.whiteboard.variant")}</Text>
                        <View class="flex-row flex-wrap gap-1">
                          {(
                            [
                              ["body", t("web.artifact.whiteboard.variantBody")],
                              ["title", t("web.artifact.whiteboard.variantTitle")],
                              ["subtitle", t("web.artifact.whiteboard.variantSubtitle")],
                              ["callout", t("web.artifact.whiteboard.variantCallout")],
                            ] as const
                          ).map(([v, label]) => {
                            const active = () => (el().variant ?? "body") === v;
                            return (
                              <View
                                role="button"
                                accessibilityState={{ selected: active() }}
                                onPress={() => patchFields(el().id, { variant: v })}
                                class={`h-6 items-center justify-center rounded-md border px-2 ${
                                  active() ? "border-accent bg-selected" : "border-line bg-side hover:bg-hover"
                                }`}
                              >
                                <Text class={`text-2xs font-medium ${active() ? "text-ink" : "text-muted"}`}>{label}</Text>
                              </View>
                            );
                          })}
                        </View>
                        <Text class="mt-1 text-xs font-medium text-muted">{t("web.artifact.whiteboard.highlight")}</Text>
                        <View class="flex-row items-center gap-1.5">
                          <TextInput
                            value={highlightDraft()}
                            onInput={(v) => highlightDraft.set(v)}
                            onSubmit={(v) => patchFields(el().id, { highlight: v.trim() || null })}
                            class="min-w-0 flex-1"
                          />
                        </View>
                      </View>
                    </If>

                    <If when={el().type === "arrow"}>
                      <View class="gap-2">
                        <View class="gap-1">
                          <Text class="text-xs font-medium text-muted">{t("web.artifact.whiteboard.curve")}</Text>
                          <View class="flex-row flex-wrap gap-1">
                            {(
                              [
                                ["smooth", t("web.artifact.whiteboard.curveSmooth")],
                                ["orthogonal", t("web.artifact.whiteboard.curveOrthogonal")],
                                ["straight", t("web.artifact.whiteboard.curveStraight")],
                              ] as const
                            ).map(([c, label]) => {
                              const active = () => (el().curve ?? "smooth") === c;
                              return (
                                <View
                                  role="button"
                                  accessibilityState={{ selected: active() }}
                                  onPress={() => patchFields(el().id, { curve: c })}
                                  class={`h-6 items-center justify-center rounded-md border px-2 ${
                                    active() ? "border-accent bg-selected" : "border-line bg-side hover:bg-hover"
                                  }`}
                                >
                                  <Text class={`text-2xs font-medium ${active() ? "text-ink" : "text-muted"}`}>{label}</Text>
                                </View>
                              );
                            })}
                          </View>
                        </View>
                        <View class="gap-1">
                          <Text class="text-xs font-medium text-muted">{t("web.artifact.whiteboard.style")}</Text>
                          <View class="flex-row flex-wrap gap-1">
                            {(
                              [
                                ["solid", t("web.artifact.whiteboard.styleSolid")],
                                ["dashed", t("web.artifact.whiteboard.styleDashed")],
                              ] as const
                            ).map(([st, label]) => {
                              const active = () => (el().style ?? "solid") === st;
                              return (
                                <View
                                  role="button"
                                  accessibilityState={{ selected: active() }}
                                  onPress={() => patchFields(el().id, { style: st })}
                                  class={`h-6 items-center justify-center rounded-md border px-2 ${
                                    active() ? "border-accent bg-selected" : "border-line bg-side hover:bg-hover"
                                  }`}
                                >
                                  <Text class={`text-2xs font-medium ${active() ? "text-ink" : "text-muted"}`}>{label}</Text>
                                </View>
                              );
                            })}
                          </View>
                        </View>
                      </View>
                    </If>

                    <If when={el().type === "html"}>
                      <View class="h-52 overflow-hidden rounded-md border border-line bg-side">
                        <HtmlFrame
                          artifact={props.artifact}
                          version={props.artifact.version}
                          title={labelOf(el()) || el().id}
                          viewElementId={el().id}
                          viewSeq={seq()}
                          hideControls
                          covered={props.covered}
                          frameClass="min-h-0 min-w-0 flex-1"
                          onMessage={handleRawMessage}
                        />
                      </View>
                    </If>

                    <View class="gap-1.5">
                      <Text class="text-xs font-medium text-muted">{t("web.artifact.whiteboard.entryJson")}</Text>
                      <TextArea rows={8} testID="wb-inspector-json" value={jsonDraft()} onInput={(v) => jsonDraft.set(v)} class="font-mono text-xs" />
                      <View class="flex-row justify-end">
                        <Button tone="primary" testID="wb-inspector-save-json" disabled={act.busy()} onPress={saveInspectorJson}>
                          {t("web.artifact.whiteboard.saveJson")}
                        </Button>
                      </View>
                    </View>
                  </View>
                )}
              </If>
            </Scroll>
          </View>
        </If>
      </View>
    </View>
  );
}

function makeIdForArrow(
  elements: readonly WbElement[],
  fromId: string,
  toId: string,
  explicitFrom?: "n" | "e" | "s" | "w",
  explicitTo?: "n" | "e" | "s" | "w",
): Record<string, unknown> & { readonly id: string } {
  const fromEl = elements.find((e) => e.id === fromId);
  const toEl = elements.find((e) => e.id === toId);
  const inferred = fromEl && toEl ? autoAnchorSides(fromEl, toEl) : { fromSide: "e" as const, toSide: "w" as const };
  return {
    id: makeElementId("a"),
    type: "arrow",
    curve: "smooth",
    head: "arrow",
    from: { id: fromId, side: explicitFrom ?? inferred.fromSide },
    to: { id: toId, side: explicitTo ?? inferred.toSide },
  };
}
