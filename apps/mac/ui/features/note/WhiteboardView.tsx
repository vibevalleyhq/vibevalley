import { computed, effect, Scroll, signal, Text, untracked, View, type Accessor } from "nsh";
import { z } from "zod";

import { currentLocale, t } from "@vibevalley/i18n";
import { type Note, type NotePresenceKind, userId, type ViewportRect } from "@vibevalley/protocol";
import { isFreeUserSession, sessionProfile } from "@vibevalley/protocol/rules";

import { createAct } from "../../design/act";
import { Button } from "../../design/Button";
import { TextInput } from "../../design/Field";
import { IconButton } from "../../design/IconButton";
import { toast } from "../../design/toasts";
import { tone } from "../../design/tone";
import { useSessionsSlice } from "../../infra/frame";
import {
  richNative,
  type VvWhiteboardBatchEvent,
  type VvWhiteboardCursorEvent,
  type VvWhiteboardExportEvent,
  type VvWhiteboardSelectionEvent,
  type VvWhiteboardViewportEvent,
} from "../../infra/rich";
import { type NoteDirectoryClient, saveBase64File, saveTextFile, useNoteDirectory, useNotePresence } from "./views/noteFiles";

const BOARD_FILE_PATH = "structure/board.json";

export interface WhiteboardViewerProps {
  readonly note: Note;
  readonly version?: number | undefined;
  readonly onOpenChat?: (() => void) | undefined;
  readonly onRefresh?: (() => void) | undefined;
  readonly frameClass?: string | undefined;
}

const WhiteboardWriteSchema = z.object({
  op: z.enum(["set", "patch", "delete", "copy"]),
  path: z.string(),
  kind: z.exactOptional(z.enum(["text", "json", "asset"])),
  value: z.exactOptional(z.string()),
  from: z.exactOptional(z.string()),
  mime: z.exactOptional(z.string()),
  ifRev: z.exactOptional(z.number().int().min(0)),
});

const BoardElementSchema = z
  .object({
    id: z.string().min(1),
    type: z.string().min(1),
    shape: z.optional(z.string()),
    title: z.optional(z.string()),
    label: z.optional(z.string()),
    text: z.optional(z.string()),
    body: z.optional(z.string()),
    x: z.optional(z.number()),
    y: z.optional(z.number()),
    w: z.optional(z.number()),
    h: z.optional(z.number()),
  })
  .loose();

type BoardElement = z.output<typeof BoardElementSchema>;

function parseBoardElement(elKey: string, rawEl: unknown, context: string): BoardElement | undefined {
  const parsed = BoardElementSchema.safeParse(rawEl);
  if (!parsed.success) {
    console.warn(`[WhiteboardView] ignored malformed board element (${context})`, { elKey, issues: parsed.error.issues });
    return undefined;
  }
  return parsed.data;
}

export interface BoardDocument {
  readonly version: number;
  readonly grid: string | boolean;
  readonly viewport: { readonly x: number; readonly y: number; readonly zoom: number };
  readonly elements: Record<string, Record<string, unknown>>;
}

interface PresenceWire {
  readonly id: string;
  readonly name: string;
  readonly color?: string | undefined;
  readonly kind?: NotePresenceKind | undefined;
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

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function parseBoardDocument(raw: string | undefined): BoardDocument {
  const empty: BoardDocument = { version: 1, grid: "architectural", viewport: { x: 0, y: 0, zoom: 1 }, elements: {} };
  if (!raw) return empty;
  const parsed = parseJsonSafe(raw);
  if (!isRecord(parsed)) return empty;
  const rawElements = isRecord(parsed.elements) ? parsed.elements : {};
  const elements: Record<string, Record<string, unknown>> = {};
  for (const [k, v] of Object.entries(rawElements)) {
    if (isRecord(v)) elements[k] = v;
  }
  const rawVp = isRecord(parsed.viewport) ? parsed.viewport : {};
  return {
    version: typeof parsed.version === "number" ? parsed.version : 1,
    grid: typeof parsed.grid === "string" || typeof parsed.grid === "boolean" ? parsed.grid : "architectural",
    viewport: {
      x: typeof rawVp.x === "number" ? rawVp.x : 0,
      y: typeof rawVp.y === "number" ? rawVp.y : 0,
      zoom: typeof rawVp.zoom === "number" ? rawVp.zoom : 1,
    },
    elements,
  };
}

/** Projects `structure/board.json` into the entry list shape expected by native `VvWhiteboard`. */
export function boardToNativeEntries(noteId: string, title: string, doc: BoardDocument, seq: number): unknown[] {
  const entries: unknown[] = [
    {
      noteId,
      path: "board/meta",
      kind: "json",
      mime: "application/json",
      size: 0,
      rev: seq,
      updatedBy: "user",
      updated: 0,
      value: JSON.stringify({ title, grid: doc.grid, viewport: doc.viewport }),
    },
  ];
  for (const [elId, el] of Object.entries(doc.elements)) {
    const value = JSON.stringify(el);
    entries.push({
      noteId,
      path: `elements/${elId}`,
      kind: "json",
      mime: "application/json",
      size: value.length,
      rev: seq,
      updatedBy: "user",
      updated: 0,
      value,
    });
  }
  return entries;
}

function labelOfElement(el: { readonly title?: string | undefined; readonly label?: string | undefined; readonly text?: string | undefined }): string {
  return el.title ?? el.label ?? el.text ?? "";
}

function escapeXml(value: string): string {
  return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;");
}

function buildHeadlessSvg(title: string, items: readonly BoardElement[]): string {
  const ink = escapeXml(tone("ink"));
  const page = escapeXml(tone("page"));
  const texts = items
    .map((el, i) => {
      const label = labelOfElement(el) || el.id;
      const y = 64 + i * 28;
      return `<text x="32" y="${y}" font-size="14" fill="${ink}">${escapeXml(label)}</text>`;
    })
    .join("");
  const height = Math.max(240, 96 + items.length * 28);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="${height}" viewBox="0 0 800 ${height}"><title>${escapeXml(title)}</title><rect width="100%" height="100%" fill="${page}"/>${texts}</svg>`;
}

export function WhiteboardView(props: WhiteboardViewerProps) {
  const reloadKey = signal(0);
  const { client, snapshot } = useNoteDirectory(
    () => props.note.id,
    () => props.version,
    () => reloadKey(),
  );
  const presence = useNotePresence(() => props.note.id, {
    enabled: () => props.version === undefined,
  });
  const sessionsSlice = useSessionsSlice();
  const act = createAct();
  const selectedIds = signal<readonly string[]>([]);

  const seq = () => (snapshot().seq > 0 ? snapshot().seq : props.note.seq);
  const boardRaw = () => snapshot().contents.get(BOARD_FILE_PATH)?.content;
  const boardDoc = computed(() => parseBoardDocument(boardRaw()));

  const presences = computed((): PresenceWire[] => {
    const out: PresenceWire[] = [];
    const seen = new Set<string>();
    const claims: BoardElement[] = [];

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
        selector: peer.selector ?? peer.nodeId,
        viewport: peer.viewport,
        updatedAt: peer.updatedAt,
      });
      seen.add(peer.id);
    }

    for (const [elKey, rawEl] of Object.entries(boardDoc().elements)) {
      const el = parseBoardElement(elKey, rawEl, "presences");
      if (el && el.type === "claim") {
        claims.push(el);
      }
    }

    const sessions = sessionsSlice()?.sessions ?? [];
    for (const sess of sessions) {
      if (isFreeUserSession(sess) || sess.phase._tag !== "working") continue;
      const id = sessionProfile(sess) ?? sess.id;
      if (seen.has(id)) continue;
      const ownClaim = claims.find((c) => c.id.includes(id) || labelOfElement(c).includes(sess.name));
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
    const raw: unknown = boardDoc().elements[firstId];
    const el = raw !== undefined ? parseBoardElement(firstId, raw, "selection") : undefined;
    presence.publish({
      id: userId,
      name: t("web.note.blocks.user"),
      color: "blue",
      kind: "selection",
      path: BOARD_FILE_PATH,
      nodeId: firstId,
      selector: firstId,
      ...(el?.x !== undefined ? { x: el.x } : {}),
      ...(el?.y !== undefined ? { y: el.y } : {}),
      ...(el?.w !== undefined ? { w: el.w } : {}),
      ...(el?.h !== undefined ? { h: el.h } : {}),
    });
  };

  const saveBoard = async (nextDoc: BoardDocument, summary?: string) => {
    await client().writeFiles(
      [{ path: BOARD_FILE_PATH, content: `${JSON.stringify(nextDoc, null, 2)}\n`, mime: "application/json" }],
      ...(summary ? [{ summary }] : []),
    );
  };

  const native = richNative();
  if (native) {
    const VvWhiteboard = native.VvWhiteboard;
    const entriesJson = computed(() => JSON.stringify(boardToNativeEntries(props.note.id, props.note.title, boardDoc(), seq())));
    const presencesJson = computed(() => JSON.stringify(presences()));

    // Presence is strictly ephemeral via `note.presence.update`; never persist `presence/*`.
    const handleNativeBatch = (ev: VvWhiteboardBatchEvent) => {
      if (props.version !== undefined) return;
      const parsed = z.array(WhiteboardWriteSchema).safeParse(parseJsonSafe(ev.writesJson));
      if (!parsed.success) {
        console.error("[WhiteboardView] dropped malformed native whiteboard batch", { issues: parsed.error.issues });
        return;
      }
      const writes = parsed.data.filter((w) => !w.path.startsWith("presence/"));
      if (writes.length === 0) return;

      const cur = untracked(boardDoc);
      const nextElements: Record<string, Record<string, unknown>> = { ...cur.elements };
      let nextGrid = cur.grid;
      let nextViewport = cur.viewport;

      for (const w of writes) {
        if (w.path === "board/meta" && w.value) {
          const meta = parseJsonSafe(w.value);
          if (isRecord(meta)) {
            if (typeof meta.grid === "string" || typeof meta.grid === "boolean") nextGrid = meta.grid;
            if (isRecord(meta.viewport)) {
              nextViewport = {
                x: typeof meta.viewport.x === "number" ? meta.viewport.x : nextViewport.x,
                y: typeof meta.viewport.y === "number" ? meta.viewport.y : nextViewport.y,
                zoom: typeof meta.viewport.zoom === "number" ? meta.viewport.zoom : nextViewport.zoom,
              };
            }
          }
          continue;
        }
        if (!w.path.startsWith("elements/")) continue;
        const elId = w.path.slice("elements/".length);
        if (w.op === "delete") {
          delete nextElements[elId];
        } else if (w.op === "set" && w.value) {
          const val = parseJsonSafe(w.value);
          if (isRecord(val)) nextElements[elId] = val;
        } else if (w.op === "patch" && w.value) {
          const patch = parseJsonSafe(w.value);
          if (isRecord(patch)) {
            const prev = { ...(nextElements[elId] ?? { id: elId }) };
            for (const [k, v] of Object.entries(patch)) {
              if (v === null) delete prev[k];
              else prev[k] = v;
            }
            nextElements[elId] = prev;
          }
        }
      }

      void act.run(() => saveBoard({ ...cur, grid: nextGrid, viewport: nextViewport, elements: nextElements }));
    };

    const handleNativeSelection = (ev: VvWhiteboardSelectionEvent) => {
      const parsed = z.array(z.string()).safeParse(parseJsonSafe(ev.idsJson));
      if (!parsed.success) {
        console.warn("[WhiteboardView] dropped malformed native selection payload", { issues: parsed.error.issues });
        return;
      }
      selectedIds.set(parsed.data);
      publishSelectionPresence(parsed.data);
    };

    const handleNativeCursorMove = (ev: VvWhiteboardCursorEvent) => {
      presence.publish({
        id: userId,
        name: t("web.note.blocks.user"),
        color: "blue",
        kind: "cursor",
        path: BOARD_FILE_PATH,
        x: ev.x,
        y: ev.y,
        viewport: { x: ev.viewportX, y: ev.viewportY, w: ev.viewportW, h: ev.viewportH, zoom: ev.zoom },
      });
    };

    const handleNativeViewportChange = (ev: VvWhiteboardViewportEvent) => {
      presence.publish({
        id: userId,
        name: t("web.note.blocks.user"),
        color: "blue",
        kind: "viewport",
        path: BOARD_FILE_PATH,
        viewport: { x: ev.x, y: ev.y, w: ev.w, h: ev.h, zoom: ev.zoom },
      });
    };

    const handleNativeExport = (ev: VvWhiteboardExportEvent) => {
      void act.run(async () => {
        switch (ev.format) {
          case "png":
            if (await saveBase64File(ev.filename, ev.mime, ev.content)) toast(t("web.note.whiteboard.exportedPng"));
            break;
          case "json-canvas":
            if (await saveTextFile(ev.filename, ev.mime, ev.content)) toast(t("web.note.whiteboard.exportedJsonCanvas"));
            break;
          case "json":
            if (await saveTextFile(ev.filename, ev.mime, ev.content)) toast(t("web.note.whiteboard.exportedJson"));
            break;
          default:
            if (await saveTextFile(ev.filename, ev.mime, ev.content)) toast(t("web.note.whiteboard.exportedSvg"));
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
          readOnly={props.version !== undefined}
          title={props.note.title}
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
      title={props.note.title}
      boardDoc={boardDoc}
      seq={seq}
      presences={presences}
      client={client}
      selectedIds={selectedIds}
      readOnly={props.version !== undefined}
      onSelectIds={(ids) => {
        selectedIds.set(ids);
        publishSelectionPresence(ids);
      }}
      onRefresh={() => {
        reloadKey.set(untracked(reloadKey) + 1);
        props.onRefresh?.();
      }}
      onOpenChat={props.onOpenChat}
    />
  );
}

interface HeadlessProps {
  readonly title: string;
  readonly boardDoc: Accessor<BoardDocument>;
  readonly seq: Accessor<number>;
  readonly presences: Accessor<readonly PresenceWire[]>;
  readonly client: Accessor<NoteDirectoryClient>;
  readonly selectedIds: {
    (): readonly string[];
    set: (next: readonly string[]) => void;
  };
  readonly readOnly: boolean;
  readonly onSelectIds: (ids: readonly string[]) => void;
  readonly onRefresh?: (() => void) | undefined;
  readonly onOpenChat?: (() => void) | undefined;
}

function WhiteboardHeadlessFallback(props: HeadlessProps) {
  const act = createAct();
  const inspectorOpen = signal(false);
  const labelDraft = signal("");
  const lastKey = signal<string | undefined>(undefined);
  const undoStack = signal<readonly BoardDocument[]>([]);

  const elements = computed((): BoardElement[] => {
    const out: BoardElement[] = [];
    for (const [elKey, rawEl] of Object.entries(props.boardDoc().elements)) {
      const el = parseBoardElement(elKey, rawEl, "elements");
      if (el) out.push(el);
    }
    return out;
  });

  const selectedElement = computed(() => {
    const first = props.selectedIds()[0];
    return first ? elements().find((e) => e.id === first) : undefined;
  });

  effect(() => {
    const el = selectedElement();
    const key = el ? `${el.id}:${props.seq()}` : undefined;
    if (key !== untracked(() => lastKey())) {
      lastKey.set(key);
      labelDraft.set(el ? labelOfElement(el) : "");
    }
  });

  const writeDoc = (nextDoc: BoardDocument, summary: string) =>
    act.run(() =>
      props.client().writeFiles([{ path: BOARD_FILE_PATH, content: `${JSON.stringify(nextDoc, null, 2)}\n`, mime: "application/json" }], { summary }),
    );

  const addNode = () => {
    if (props.readOnly) return;
    const cur = untracked(props.boardDoc);
    const id = `n-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const payload = {
      id,
      type: "shape",
      shape: "card",
      x: 120,
      y: 120,
      w: 196,
      h: 120,
      title: t("web.note.whiteboard.card"),
      fill: "sun",
    };
    const nextDoc: BoardDocument = { ...cur, elements: { ...cur.elements, [id]: payload } };
    undoStack.set([...untracked(undoStack), cur]);
    props.selectedIds.set([id]);
    void writeDoc(nextDoc, `Add node ${id}`);
  };

  const runUndo = () => {
    if (props.readOnly) return;
    const stack = untracked(undoStack);
    const prevDoc = stack[stack.length - 1];
    if (prevDoc === undefined) return;
    undoStack.set(stack.slice(0, -1));
    void writeDoc(prevDoc, "Undo whiteboard edit");
  };

  const fitView = () => {
    if (props.readOnly) return;
    const cur = untracked(props.boardDoc);
    const nextDoc: BoardDocument = { ...cur, viewport: { x: 0, y: 0, zoom: 1 } };
    void writeDoc(nextDoc, "Fit view");
  };

  const saveLabel = () => {
    if (props.readOnly) return;
    const el = selectedElement();
    if (!el) return;
    const cur = untracked(props.boardDoc);
    const textVal = labelDraft().trim();
    const existing = cur.elements[el.id] ?? { id: el.id };
    const updatedEl =
      el.type === "container" || (el.type === "shape" && (el.title !== undefined || el.shape === "card"))
        ? { ...existing, title: textVal }
        : { ...existing, label: textVal };
    const nextDoc: BoardDocument = { ...cur, elements: { ...cur.elements, [el.id]: updatedEl } };
    undoStack.set([...untracked(undoStack), cur]);
    void writeDoc(nextDoc, `Update ${el.id}`);
  };

  const exportSvg = () => {
    const safeBase = (props.title.trim() || "whiteboard").replace(/[\\/:*?"<>|]/gu, "-");
    const svg = buildHeadlessSvg(props.title, elements());
    void act.run(async () => {
      if (await saveTextFile(`${safeBase}.svg`, "image/svg+xml", svg)) toast(t("web.note.whiteboard.exportedSvg"));
    });
  };

  return (
    <View testID="whiteboard-view" class="min-h-0 min-w-0 flex-1 overflow-hidden rounded-lg border border-line bg-side">
      <View class="min-h-10 shrink-0 flex-row items-center gap-1.5 border-b border-line bg-page px-3 py-1">
        <If when={!props.readOnly}>
          <Button icon="add" testID="wb-add-node" disabled={act.busy()} onPress={addNode}>
            {t("web.note.whiteboard.sticky")}
          </Button>
          <IconButton icon="undo" label={t("web.note.whiteboard.undo")} testid="wb-undo" disabled={undoStack().length === 0 || act.busy()} onClick={runUndo} />
        </If>
        <IconButton icon="enlarge" label={t("web.note.whiteboard.fitView")} testid="wb-fit-view" disabled={act.busy()} onClick={fitView} />
        <If when={props.onRefresh}>
          <IconButton icon="refresh" label={t("web.issue.page.refresh")} testid="wb-refresh" disabled={act.busy()} onClick={() => props.onRefresh?.()} />
        </If>
        <View class="ml-auto flex-row items-center gap-1.5">
          <If when={props.presences().length > 0}>
            <View testID="wb-presence-peers" class="flex-row items-center gap-1">
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
          <Text testID="wb-count" class="font-mono text-xs text-muted tabular-nums">
            {t("web.note.whiteboard.elements", { n: elements().length })}
          </Text>
          <View class="h-4 w-px bg-line" />
          <IconButton icon="download" label={`${t("web.base.form.save")} SVG`} testid="wb-export-svg" disabled={act.busy()} onClick={exportSvg} />
          <IconButton
            icon="edit"
            label={t("web.note.whiteboard.inspector")}
            testid="wb-inspector-toggle"
            pressed={inspectorOpen()}
            onClick={() => inspectorOpen.set(!inspectorOpen())}
          />
          <If when={props.onOpenChat}>
            <Button tone="primary" icon="idea" testID="wb-chat" onPress={() => props.onOpenChat?.()}>
              {t("web.note.whiteboard.chatWithOrchestrator")}
            </Button>
          </If>
        </View>
      </View>

      <View class="min-h-0 min-w-0 flex-1 flex-row">
        <View testID="wb-canvas" accessibilityLabel={props.title} class="min-h-0 min-w-0 flex-1 bg-side p-4">
          <If
            when={elements().length > 0}
            else={
              <View class="flex-1 items-center justify-center">
                <Text class="max-w-md text-center text-xs leading-relaxed text-muted">{t("web.note.whiteboard.emptyHint")}</Text>
              </View>
            }
          >
            <View class="flex-row flex-wrap gap-3">
              <Each of={elements()} key={(el) => el.id}>
                {(el) => {
                  const selected = () => props.selectedIds().includes(el().id);
                  return (
                    <View
                      role="button"
                      testID={`wb-node-${el().id}`}
                      onPress={() => props.onSelectIds([el().id])}
                      class={`min-w-40 max-w-64 gap-1 rounded-lg border p-3 ${selected() ? "border-accent bg-selected" : "border-line bg-page hover:bg-hover"}`}
                    >
                      <Text class="text-sm font-medium text-ink">{labelOfElement(el()) || el().id}</Text>
                      <Text class="font-mono text-2xs text-faint">{el().shape ?? el().type}</Text>
                    </View>
                  );
                }}
              </Each>
            </View>
          </If>
        </View>
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
                          <Text class="min-w-0 flex-1 truncate text-xs font-medium text-ink">{labelOfElement(el()) || el().id}</Text>
                        </View>
                      )}
                    </Each>
                  </View>
                }
              >
                {() => (
                  <View class="flex-row items-center gap-1.5">
                    <TextInput
                      testID="wb-inspector-label"
                      value={labelDraft()}
                      disabled={props.readOnly}
                      onInput={(v) => labelDraft.set(v)}
                      class="min-w-0 flex-1"
                    />
                    <Button tone="primary" testID="wb-inspector-save" disabled={props.readOnly || act.busy()} onPress={saveLabel}>
                      {t("web.note.whiteboard.save")}
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
