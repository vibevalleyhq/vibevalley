import { computed, effect, Scroll, signal, Text, untracked, View, type Accessor } from "nsh";
import { z } from "zod";

import { currentLocale, t } from "@vibevalley/i18n";
import { type ArtifactEntry, type ArtifactEntryWriteInput, type ArtifactPresenceKind, userId, type ViewportRect } from "@vibevalley/protocol";
import { isFreeUserSession, sessionProfile } from "@vibevalley/protocol/rules";

import { createAct } from "../../design/act";
import { Button } from "../../design/Button";
import { TextInput } from "../../design/Field";
import { IconButton } from "../../design/IconButton";
import { toast } from "../../design/toasts";
import { useSessionsSlice } from "../../infra/frame";
import {
  richNative,
  type VvWhiteboardBatchEvent,
  type VvWhiteboardCursorEvent,
  type VvWhiteboardExportEvent,
  type VvWhiteboardSelectionEvent,
  type VvWhiteboardViewportEvent,
} from "../../infra/rich";
import { saveBase64File, saveTextFile, type StoreEntryClient, useArtifactPresence, useReportViewContext, useStoreEntries } from "./store";
import type { StoreViewerProps } from "./StoreArtifactView";

const WhiteboardWriteSchema = z.object({
  op: z.enum(["set", "patch", "delete", "copy"]),
  path: z.string(),
  kind: z.exactOptional(z.enum(["text", "json", "asset"])),
  value: z.exactOptional(z.string()),
  from: z.exactOptional(z.string()),
  mime: z.exactOptional(z.string()),
  ifRev: z.exactOptional(z.number().int().min(0)),
});

const FallbackElementSchema = z
  .object({
    id: z.string().min(1),
    type: z.string().min(1),
    shape: z.optional(z.string()),
    title: z.optional(z.string()),
    label: z.optional(z.string()),
    text: z.optional(z.string()),
    x: z.optional(z.number()),
    y: z.optional(z.number()),
    w: z.optional(z.number()),
    h: z.optional(z.number()),
  })
  .loose();

type FallbackElement = z.output<typeof FallbackElementSchema> & { readonly rev: number };

interface PresenceWire {
  readonly id: string;
  readonly name: string;
  readonly color?: string | undefined;
  readonly kind?: ArtifactPresenceKind | undefined;
  readonly x?: number | undefined;
  readonly y?: number | undefined;
  readonly w?: number | undefined;
  readonly h?: number | undefined;
  readonly status?: string | undefined;
  readonly selector?: string | undefined;
  readonly viewport?: ViewportRect | undefined;
  readonly updatedAt?: number | undefined;
}

function parseJsonSafe(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (e) {
    if (e instanceof SyntaxError) return undefined;
    throw e;
  }
}

function labelOfFallback(el: { readonly title?: string | undefined; readonly label?: string | undefined; readonly text?: string | undefined }): string {
  return el.title ?? el.label ?? el.text ?? "";
}

function escapeXml(value: string): string {
  return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;");
}

function buildHeadlessSvg(title: string, items: readonly FallbackElement[]): string {
  const texts = items
    .map((el, i) => {
      const label = labelOfFallback(el) || el.id;
      const y = 64 + i * 28;
      return `<text x="32" y="${y}" font-size="14" fill="#1c1917">${escapeXml(label)}</text>`;
    })
    .join("");
  const height = Math.max(240, 96 + items.length * 28);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="${height}" viewBox="0 0 800 ${height}"><title>${escapeXml(title)}</title><rect width="100%" height="100%" fill="#fcfcfb"/>${texts}</svg>`;
}

export function WhiteboardView(props: StoreViewerProps) {
  const { client, snapshot } = useStoreEntries(() => props.artifact.id);
  const presence = useArtifactPresence(() => props.artifact.id);
  const sessionsSlice = useSessionsSlice();
  const act = createAct();
  const selectedIds = signal<readonly string[]>([]);

  const seq = () => (snapshot().seq > 0 ? snapshot().seq : props.artifact.seq);

  const entriesList = computed((): readonly ArtifactEntry[] => [...snapshot().entries.values()].filter((entry) => !entry.path.startsWith("presence/")));

  const presences = computed((): PresenceWire[] => {
    const out: PresenceWire[] = [];
    const seen = new Set<string>();
    const claims: FallbackElement[] = [];

    for (const peer of presence.peers()) {
      if (peer.id === userId) continue;
      out.push({
        id: peer.id,
        name: peer.name,
        color: peer.color,
        kind: peer.kind,
        x: peer.x,
        y: peer.y,
        w: peer.w,
        h: peer.h,
        status: peer.status,
        selector: peer.selector,
        viewport: peer.viewport,
        updatedAt: peer.updatedAt,
      });
      seen.add(peer.id);
    }

    for (const [path, entry] of snapshot().entries) {
      if (!entry.value || !path.startsWith("elements/")) continue;
      const parsed = FallbackElementSchema.safeParse(parseJsonSafe(entry.value));
      if (parsed.success && parsed.data.type === "claim") {
        claims.push({ ...parsed.data, rev: entry.rev });
      }
    }

    const sessions = sessionsSlice()?.sessions ?? [];
    for (const sess of sessions) {
      if (isFreeUserSession(sess) || sess.phase._tag !== "working") continue;
      const id = sessionProfile(sess) ?? sess.id;
      if (seen.has(id)) continue;
      const ownClaim = claims.find((c) => c.id.includes(id) || labelOfFallback(c).includes(sess.name));
      out.push({
        id,
        name: sess.name,
        color: "coral",
        kind: "cursor",
        x: ownClaim ? (ownClaim.x ?? 80) + (ownClaim.w ?? 200) - 18 : 120,
        y: ownClaim ? (ownClaim.y ?? 80) + (ownClaim.h ?? 100) - 12 : 120,
      });
      seen.add(id);
    }
    return out;
  });

  const publishSelectionPresence = (ids: readonly string[]) => {
    const firstId = ids[0];
    if (!firstId) {
      presence.clear(userId);
      return;
    }
    const raw = snapshot().entries.get(`elements/${firstId}`)?.value;
    const parsed = raw ? FallbackElementSchema.safeParse(parseJsonSafe(raw)) : undefined;
    const el = parsed?.success === true ? parsed.data : undefined;
    presence.publish({
      id: userId,
      name: t("web.artifact.blocks.user"),
      color: "blue",
      kind: "selection",
      selector: firstId,
      ...(el?.x !== undefined ? { x: el.x } : {}),
      ...(el?.y !== undefined ? { y: el.y } : {}),
      ...(el?.w !== undefined ? { w: el.w } : {}),
      ...(el?.h !== undefined ? { h: el.h } : {}),
    });
  };

  useReportViewContext(
    () => props.artifact.id,
    () => ({
      artifactType: "whiteboard",
      title: props.artifact.title,
      seq: seq(),
      ...(selectedIds().length > 0 ? { selectedIds: [...selectedIds()] } : {}),
    }),
  );

  const native = richNative();
  if (native) {
    const VvWhiteboard = native.VvWhiteboard;
    const entriesJson = computed(() => JSON.stringify(entriesList()));
    const presencesJson = computed(() => JSON.stringify(presences()));

    // Presence is strictly ephemeral via `artifact.presence.update`; never persist `presence/*` entries.
    const handleNativeBatch = (ev: VvWhiteboardBatchEvent) => {
      const parsed = z.array(WhiteboardWriteSchema).safeParse(parseJsonSafe(ev.writesJson));
      if (!parsed.success) return;
      const writes: ArtifactEntryWriteInput[] = parsed.data.filter((w) => !w.path.startsWith("presence/"));
      if (writes.length === 0) return;
      void act.run(async () => {
        await client.batch(writes);
      });
    };

    const handleNativeSelection = (ev: VvWhiteboardSelectionEvent) => {
      const parsed = z.array(z.string()).safeParse(parseJsonSafe(ev.idsJson));
      if (parsed.success) {
        selectedIds.set(parsed.data);
        publishSelectionPresence(parsed.data);
      }
    };

    const handleNativeCursorMove = (ev: VvWhiteboardCursorEvent) => {
      presence.publish({
        id: userId,
        name: t("web.artifact.blocks.user"),
        color: "blue",
        kind: "cursor",
        x: ev.x,
        y: ev.y,
        viewport: { x: ev.viewportX, y: ev.viewportY, w: ev.viewportW, h: ev.viewportH, zoom: ev.zoom },
      });
    };

    const handleNativeViewportChange = (ev: VvWhiteboardViewportEvent) => {
      presence.publish({
        id: userId,
        name: t("web.artifact.blocks.user"),
        color: "blue",
        kind: "viewport",
        viewport: { x: ev.x, y: ev.y, w: ev.w, h: ev.h, zoom: ev.zoom },
      });
    };

    const handleNativeExport = (ev: VvWhiteboardExportEvent) => {
      void act.run(async () => {
        switch (ev.format) {
          case "png":
            if (await saveBase64File(ev.filename, ev.mime, ev.content)) toast(t("web.artifact.whiteboard.exportedPng"));
            break;
          case "json-canvas":
            if (await saveTextFile(ev.filename, ev.mime, ev.content)) toast(t("web.artifact.whiteboard.exportedJsonCanvas"));
            break;
          case "json":
            if (await saveTextFile(ev.filename, ev.mime, ev.content)) toast(t("web.artifact.whiteboard.exportedJson"));
            break;
          default:
            if (await saveTextFile(ev.filename, ev.mime, ev.content)) toast(t("web.artifact.whiteboard.exportedSvg"));
            break;
        }
      });
    };

    return (
      <View testID="whiteboard-view" class="min-h-0 min-w-0 flex-1 overflow-hidden rounded-lg border border-line bg-side">
        <VvWhiteboard
          entriesJson={entriesJson()}
          presencesJson={presencesJson()}
          seq={seq()}
          title={props.artifact.title}
          locale={currentLocale()}
          onBatch={handleNativeBatch}
          onSelectionChange={handleNativeSelection}
          onCursorMove={handleNativeCursorMove}
          onViewportChange={handleNativeViewportChange}
          onOpenChat={() => props.onOpenChat?.()}
          onExport={handleNativeExport}
          class={`min-h-0 min-w-0 flex-1 ${props.frameClass ?? ""}`}
        />
      </View>
    );
  }

  return (
    <WhiteboardHeadlessFallback
      title={props.artifact.title}
      entries={entriesList}
      presences={presences}
      client={client}
      selectedIds={selectedIds}
      onSelectIds={(ids) => {
        selectedIds.set(ids);
        publishSelectionPresence(ids);
      }}
      onOpenChat={props.onOpenChat}
    />
  );
}

interface HeadlessProps {
  readonly title: string;
  readonly entries: Accessor<readonly ArtifactEntry[]>;
  readonly presences: Accessor<readonly PresenceWire[]>;
  readonly client: StoreEntryClient;
  readonly selectedIds: {
    (): readonly string[];
    set: (next: readonly string[]) => void;
  };
  readonly onSelectIds: (ids: readonly string[]) => void;
  readonly onOpenChat?: (() => void) | undefined;
}

function WhiteboardHeadlessFallback(props: HeadlessProps) {
  const act = createAct();
  const inspectorOpen = signal(false);
  const labelDraft = signal("");
  const lastKey = signal<string | undefined>(undefined);
  const undoStack = signal<readonly (readonly ArtifactEntryWriteInput[])[]>([]);

  const elements = computed((): FallbackElement[] => {
    const out: FallbackElement[] = [];
    for (const entry of props.entries()) {
      if (!entry.path.startsWith("elements/") || !entry.value) continue;
      const parsed = FallbackElementSchema.safeParse(parseJsonSafe(entry.value));
      if (parsed.success) out.push({ ...parsed.data, rev: entry.rev });
    }
    return out;
  });

  const selectedElement = computed(() => {
    const first = props.selectedIds()[0];
    return first ? elements().find((e) => e.id === first) : undefined;
  });

  effect(() => {
    const el = selectedElement();
    const key = el ? `${el.id}:${el.rev}` : undefined;
    if (key !== untracked(() => lastKey())) {
      lastKey.set(key);
      labelDraft.set(el ? labelOfFallback(el) : "");
    }
  });

  const addNode = () => {
    const id = `n-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const payload = {
      id,
      type: "shape",
      shape: "card",
      x: 108,
      y: 108,
      w: 196,
      h: 120,
      title: t("web.artifact.whiteboard.card"),
      fill: "sun",
    };
    const path = `elements/${id}`;
    undoStack.set([...untracked(undoStack), [{ op: "delete", path }]]);
    props.selectedIds.set([id]);
    void act.run(() => props.client.batch([{ op: "set", path, kind: "json", value: JSON.stringify(payload) }]));
  };

  const runUndo = () => {
    const stack = untracked(undoStack);
    const step = stack[stack.length - 1];
    if (step === undefined) return;
    undoStack.set(stack.slice(0, -1));
    void act.run(() => props.client.batch([...step]));
  };

  const saveLabel = () => {
    const el = selectedElement();
    if (!el) return;
    const textVal = labelDraft().trim();
    const patch = el.type === "container" || (el.type === "shape" && (el.title !== undefined || el.shape === "card")) ? { title: textVal } : { label: textVal };
    const path = `elements/${el.id}`;
    const prevRaw = props.entries().find((e) => e.path === path)?.value;
    if (prevRaw !== undefined) {
      undoStack.set([...untracked(undoStack), [{ op: "set", path, kind: "json", value: prevRaw }]]);
    }
    void act.run(() => props.client.batch([{ op: "patch", path, value: JSON.stringify(patch) }]));
  };

  const exportSvg = () => {
    const safeBase = (props.title.trim() || "whiteboard").replace(/[\\/:*?"<>|]/gu, "-");
    const svg = buildHeadlessSvg(props.title, elements());
    void act.run(async () => {
      if (await saveTextFile(`${safeBase}.svg`, "image/svg+xml", svg)) toast(t("web.artifact.whiteboard.exportedSvg"));
    });
  };

  return (
    <View testID="whiteboard-view" class="min-h-0 min-w-0 flex-1 overflow-hidden rounded-lg border border-line bg-side">
      <View class="min-h-9 shrink-0 flex-row items-center gap-1 border-b border-line bg-page px-2.5 py-0.5">
        <Button icon="add" testID="wb-add-node" disabled={act.busy()} onPress={addNode}>
          {t("web.artifact.whiteboard.sticky")}
        </Button>
        <IconButton
          icon="undo"
          label={t("web.artifact.whiteboard.undo")}
          testid="wb-undo"
          disabled={undoStack().length === 0 || act.busy()}
          onClick={runUndo}
        />
        <View class="ml-auto flex-row items-center gap-1">
          <If when={props.presences().length > 0}>
            <View testID="wb-presence-peers" class="flex-row items-center gap-1 pr-1">
              <Each of={props.presences()} key={(p) => p.id}>
                {(peer) => (
                  <View testID="wb-presence-peer" class="h-5 flex-row items-center gap-1 rounded-sm border border-line bg-side px-1.5">
                    <View class="size-1.5 shrink-0 rounded-full bg-accent" />
                    <Text class="max-w-28 truncate text-2xs font-medium text-ink">{peer().status ? `${peer().name} · ${peer().status}` : peer().name}</Text>
                  </View>
                )}
              </Each>
            </View>
          </If>
          <Text testID="wb-count" class="pr-1 font-mono text-xs text-muted tabular-nums">
            {t("web.artifact.whiteboard.elements", { n: elements().length })}
          </Text>
          <Button icon="download" testID="wb-export-svg" disabled={act.busy()} onPress={exportSvg}>
            SVG
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
        <View testID="wb-canvas" accessibilityLabel={props.title} class="min-h-0 min-w-0 flex-1 bg-side" />
        <If when={inspectorOpen()}>
          <View testID="wb-inspector" class="w-76 shrink-0 border-l border-line bg-page">
            <Scroll class="min-h-0 flex-1" contentClass="p-3 gap-3">
              <If
                when={selectedElement()}
                else={
                  <View class="gap-1.5">
                    <Each of={elements()} key={(el) => el.id}>
                      {(el) => (
                        <View
                          role="button"
                          testID={`wb-inspector-item-${el().id}`}
                          onPress={() => props.onSelectIds([el().id])}
                          class="h-8 flex-row items-center justify-between gap-2 rounded-md border border-line bg-side px-2.5"
                        >
                          <Text class="min-w-0 flex-1 truncate text-xs font-medium text-ink">{labelOfFallback(el()) || el().id}</Text>
                        </View>
                      )}
                    </Each>
                  </View>
                }
              >
                {() => (
                  <View class="flex-row items-center gap-1.5">
                    <TextInput testID="wb-inspector-label" value={labelDraft()} onInput={(v) => labelDraft.set(v)} class="min-w-0 flex-1" />
                    <Button tone="primary" testID="wb-inspector-save" disabled={act.busy()} onPress={saveLabel}>
                      {t("web.artifact.whiteboard.save")}
                    </Button>
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
