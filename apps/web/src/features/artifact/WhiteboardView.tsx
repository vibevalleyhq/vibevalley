import { createMemo, createSignal, For, onSettled, Show } from "solid-js";
import { z } from "zod";

import { sanitizeWhiteboardSvg, storeMessageOf, storeViewUrl } from "@vibevalley/artifact/viewers";
import { t } from "@vibevalley/i18n";
import type { Artifact } from "@vibevalley/protocol";
import { htmlSandbox } from "@vibevalley/protocol/rules";

import { shownTheme } from "#/state/prefs.ts";
import { createAct } from "#/ui/act.ts";
import { Button } from "#/ui/Button.tsx";
import { Icon } from "#/ui/Icon.tsx";
import { IconButton } from "#/ui/IconButton.tsx";

import { useReportViewContext, useStoreEntries } from "./store";

const EndpointSchema = z.union([
  z.object({
    id: z.string(),
    side: z.exactOptional(z.enum(["top", "right", "bottom", "left", "n", "e", "s", "w"])),
  }),
  z.object({
    x: z.number(),
    y: z.number(),
  }),
]);

const WhiteboardElementSchema = z.object({
  id: z.string(),
  type: z.enum(["shape", "container", "arrow", "text", "table", "svg", "html", "claim"]),
  shape: z.exactOptional(z.string()),
  x: z.exactOptional(z.number()),
  y: z.exactOptional(z.number()),
  w: z.exactOptional(z.number()),
  h: z.exactOptional(z.number()),
  label: z.exactOptional(z.string()),
  text: z.exactOptional(z.string()),
  title: z.exactOptional(z.string()),
  fill: z.exactOptional(z.string()),
  stroke: z.exactOptional(z.string()),
  from: z.exactOptional(EndpointSchema),
  to: z.exactOptional(EndpointSchema),
  bends: z.exactOptional(z.array(z.object({ x: z.number(), y: z.number() }))),
  headers: z.exactOptional(z.array(z.string())),
  rows: z.exactOptional(z.array(z.array(z.string()))),
  svg: z.exactOptional(z.string()),
  html: z.exactOptional(z.string()),
});

type WbElement = z.output<typeof WhiteboardElementSchema> & { readonly rev: number };
type Tool = "select" | "pan" | "rect" | "sticky" | "diamond" | "text" | "container" | "arrow";

function fillClass(fill: string | undefined, shape?: string): string {
  if (shape === "sticky" && !fill) return "bg-ok-soft border-leaf text-ink";
  switch (fill) {
    case "leaf":
    case "green":
    case "ok":
      return "bg-ok-soft border-leaf text-ink";
    case "berry":
    case "red":
    case "bad":
      return "bg-bad-soft border-berry text-ink";
    case "water":
    case "blue":
      return "bg-selected border-water text-ink";
    case "wheat":
    case "amber":
    case "yellow":
      return "bg-selected border-wheat text-ink";
    case "side":
    case "muted":
      return "bg-side border-line text-ink";
    default:
      return "bg-page border-line text-ink";
  }
}

function anchorPoint(
  ep: z.output<typeof EndpointSchema> | undefined,
  byId: ReadonlyMap<string, WbElement>,
  fallbackSide: "right" | "left",
): { readonly x: number; readonly y: number } | undefined {
  if (!ep) return undefined;
  if ("x" in ep) return { x: ep.x, y: ep.y };
  const target = byId.get(ep.id);
  if (!target) return undefined;
  const x = target.x ?? 0;
  const y = target.y ?? 0;
  const w = target.w ?? 160;
  const h = target.h ?? 72;
  const side = ep.side ?? fallbackSide;
  switch (side) {
    case "top":
    case "n":
      return { x: x + w / 2, y };
    case "bottom":
    case "s":
      return { x: x + w / 2, y: y + h };
    case "left":
    case "w":
      return { x, y: y + h / 2 };
    case "right":
    case "e":
      return { x: x + w, y: y + h / 2 };
  }
}

export function WhiteboardView(props: { artifact: Artifact }) {
  const { client, snapshot } = useStoreEntries(() => props.artifact.id);
  const act = createAct();

  const [tool, setTool] = createSignal<Tool>("select");
  const [panX, setPanX] = createSignal(48);
  const [panY, setPanY] = createSignal(48);
  const [zoom, setZoom] = createSignal(1);
  const [selectedIds, setSelectedIds] = createSignal<readonly string[]>([]);
  const [arrowStart, setArrowStart] = createSignal<string>();
  const [editingId, setEditingId] = createSignal<string>();
  const [editDraft, setEditDraft] = createSignal("");
  const [dragOffset, setDragOffset] = createSignal<{ readonly id: string; readonly dx: number; readonly dy: number }>();

  let viewportEl: HTMLDivElement | undefined;

  const seq = () => (snapshot().seq > 0 ? snapshot().seq : props.artifact.seq);

  const elements = createMemo((): WbElement[] => {
    const out: WbElement[] = [];
    for (const [path, entry] of snapshot().entries) {
      if (!path.startsWith("elements/") || !entry.value) continue;
      try {
        const parsed = WhiteboardElementSchema.safeParse(JSON.parse(entry.value));
        if (parsed.success) out.push({ ...parsed.data, rev: entry.rev });
      } catch (e) {
        if (e instanceof SyntaxError) continue;
        throw e;
      }
    }
    return out;
  });

  const elementById = createMemo(() => {
    const m = new Map<string, WbElement>();
    const drag = dragOffset();
    for (const el of elements()) {
      if (drag && drag.id === el.id) {
        m.set(el.id, { ...el, x: (el.x ?? 0) + drag.dx, y: (el.y ?? 0) + drag.dy });
      } else {
        m.set(el.id, el);
      }
    }
    return m;
  });

  const boxes = createMemo(() => [...elementById().values()].filter((e) => e.type !== "arrow"));
  const arrows = createMemo(() => [...elementById().values()].filter((e) => e.type === "arrow"));

  useReportViewContext(
    () => props.artifact.id,
    () => ({
      artifactType: "whiteboard",
      title: props.artifact.title,
      seq: seq(),
      ...(selectedIds().length > 0 ? { selectedIds: [...selectedIds()] } : {}),
    }),
  );

  onSettled(() => {
    const heard = (e: MessageEvent) => {
      const msg = storeMessageOf(e.data);
      if (msg?.vibevalley !== "store-embed-save") return;
      void act.run(() =>
        client.batch([
          {
            op: "patch",
            path: `elements/${msg.elementId}`,
            value: JSON.stringify({ state: msg.state }),
          },
        ]),
      );
    };
    window.addEventListener("message", heard);
    return () => window.removeEventListener("message", heard);
  });

  const fitView = () => {
    const all = boxes();
    if (all.length === 0 || !viewportEl) {
      setPanX(48);
      setPanY(48);
      setZoom(1);
      return;
    }
    const minX = Math.min(...all.map((b) => b.x ?? 0));
    const minY = Math.min(...all.map((b) => b.y ?? 0));
    const maxX = Math.max(...all.map((b) => (b.x ?? 0) + (b.w ?? 160)));
    const maxY = Math.max(...all.map((b) => (b.y ?? 0) + (b.h ?? 80)));
    const contentW = Math.max(200, maxX - minX + 96);
    const contentH = Math.max(200, maxY - minY + 96);
    const rect = viewportEl.getBoundingClientRect();
    const nextZoom = Math.max(0.3, Math.min(1.5, Math.min(rect.width / contentW, rect.height / contentH)));
    setZoom(Math.round(nextZoom * 100) / 100);
    setPanX(Math.round(48 - minX * nextZoom));
    setPanY(Math.round(48 - minY * nextZoom));
  };

  const createAt = (worldX: number, worldY: number, kind: Exclude<Tool, "select" | "pan" | "arrow">) => {
    const id = `n-${crypto.randomUUID().slice(0, 6)}`;
    const base = {
      id,
      x: Math.round(worldX / 12) * 12,
      y: Math.round(worldY / 12) * 12,
    };
    const payload =
      kind === "container"
        ? { ...base, type: "container", w: 320, h: 220, title: "Group" }
        : kind === "text"
          ? { ...base, type: "text", w: 180, h: 40, text: "Note" }
          : kind === "sticky"
            ? { ...base, type: "shape", shape: "sticky", w: 168, h: 120, fill: "leaf", label: "Idea" }
            : kind === "diamond"
              ? { ...base, type: "shape", shape: "diamond", w: 160, h: 96, fill: "wheat", label: "Decision" }
              : { ...base, type: "shape", shape: "rect", w: 176, h: 76, label: "Node" };

    setSelectedIds([id]);
    setTool("select");
    void act.run(() => client.batch([{ op: "set", path: `elements/${id}`, kind: "json", value: JSON.stringify(payload) }]));
  };

  const deleteSelected = () => {
    const ids = selectedIds();
    if (ids.length === 0) return;
    setSelectedIds([]);
    void act.run(() => client.batch(ids.map((id) => ({ op: "delete", path: `elements/${id}` }))));
  };

  const commitLabel = (el: WbElement) => {
    const next = editDraft().trim();
    setEditingId(undefined);
    const field = el.type === "container" ? { title: next } : el.type === "text" ? { text: next } : { label: next };
    void act.run(() => client.batch([{ op: "patch", path: `elements/${el.id}`, value: JSON.stringify(field) }]));
  };

  const startNodeInteraction = (e: PointerEvent, el: WbElement) => {
    e.stopPropagation();
    if (tool() === "arrow") {
      const fromId = arrowStart();
      if (!fromId) {
        setArrowStart(el.id);
        setSelectedIds([el.id]);
      } else if (fromId !== el.id) {
        const arrowId = `a-${crypto.randomUUID().slice(0, 6)}`;
        setArrowStart(undefined);
        setTool("select");
        void act.run(() =>
          client.batch([
            {
              op: "set",
              path: `elements/${arrowId}`,
              kind: "json",
              value: JSON.stringify({
                id: arrowId,
                type: "arrow",
                from: { id: fromId, side: "right" },
                to: { id: el.id, side: "left" },
              }),
            },
          ]),
        );
      }
      return;
    }

    setSelectedIds([el.id]);
    const startX = e.clientX;
    const startY = e.clientY;
    const initialZoom = zoom();
    const move = (ev: PointerEvent) => {
      const dx = Math.round((ev.clientX - startX) / initialZoom);
      const dy = Math.round((ev.clientY - startY) / initialZoom);
      setDragOffset({ id: el.id, dx, dy });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      const off = dragOffset();
      setDragOffset(undefined);
      if (off && (Math.abs(off.dx) > 2 || Math.abs(off.dy) > 2)) {
        const nextX = Math.round(((el.x ?? 0) + off.dx) / 4) * 4;
        const nextY = Math.round(((el.y ?? 0) + off.dy) / 4) * 4;
        void act.run(() =>
          client.batch([
            {
              op: "patch",
              path: `elements/${el.id}`,
              value: JSON.stringify({ x: nextX, y: nextY }),
            },
          ]),
        );
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const onCanvasPointerDown = (e: PointerEvent) => {
    if (!viewportEl) return;
    const activeTool = tool();
    if (activeTool !== "select" && activeTool !== "pan" && activeTool !== "arrow") {
      const rect = viewportEl.getBoundingClientRect();
      const worldX = (e.clientX - rect.left - panX()) / zoom();
      const worldY = (e.clientY - rect.top - panY()) / zoom();
      createAt(worldX, worldY, activeTool);
      return;
    }
    setSelectedIds([]);
    setArrowStart(undefined);
    const startX = e.clientX;
    const startY = e.clientY;
    const initialPanX = panX();
    const initialPanY = panY();
    const move = (ev: PointerEvent) => {
      setPanX(initialPanX + (ev.clientX - startX));
      setPanY(initialPanY + (ev.clientY - startY));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const toolButton = (id: Tool, label: string) => (
    <button
      type="button"
      data-testid={`wb-tool-${id}`}
      aria-pressed={tool() === id ? "true" : "false"}
      onClick={() => {
        setTool(id);
        setArrowStart(undefined);
      }}
      class={["cursor-pointer rounded-md px-2 py-1 text-xs font-medium", tool() === id ? "bg-selected text-ink" : "text-muted hover:bg-hover hover:text-ink"]}
    >
      {label}
    </button>
  );

  return (
    <div data-testid="whiteboard-view" class="flex min-h-0 min-w-0 flex-1 flex-col rounded-lg border border-line bg-side overflow-hidden">
      <div class="flex shrink-0 flex-wrap items-center gap-1 border-b border-line bg-page px-2.5 py-1.5">
        {toolButton("select", t("web.artifact.whiteboard.select"))}
        {toolButton("pan", t("web.artifact.whiteboard.pan"))}
        <span class="mx-1 h-4 w-px bg-line" />
        {toolButton("rect", t("web.artifact.whiteboard.rect"))}
        {toolButton("sticky", t("web.artifact.whiteboard.sticky"))}
        {toolButton("diamond", t("web.artifact.whiteboard.diamond"))}
        {toolButton("container", t("web.artifact.whiteboard.container"))}
        {toolButton("text", t("web.artifact.whiteboard.text"))}
        {toolButton("arrow", t("web.artifact.whiteboard.arrow"))}
        <Show when={selectedIds().length > 0}>
          <Button tone="danger" icon="delete" data-testid="wb-delete" disabled={act.busy()} onClick={deleteSelected}>
            {t("web.artifact.whiteboard.deleteSelected")}
          </Button>
        </Show>
        <div class="ml-auto flex items-center gap-1">
          <span class="tabular-nums text-xs text-muted">{t("web.artifact.whiteboard.elements", { n: elements().length })}</span>
          <IconButton
            icon="partly"
            label={t("web.artifact.whiteboard.zoomOut")}
            testid="wb-zoom-out"
            onClick={() => setZoom((z) => Math.max(0.25, Math.round((z - 0.15) * 100) / 100))}
          />
          <span class="min-w-11 text-center tabular-nums text-xs text-muted">{Math.round(zoom() * 100)}%</span>
          <IconButton
            icon="add"
            label={t("web.artifact.whiteboard.zoomIn")}
            testid="wb-zoom-in"
            onClick={() => setZoom((z) => Math.min(2.5, Math.round((z + 0.15) * 100) / 100))}
          />
          <IconButton icon="enlarge" label={t("web.artifact.whiteboard.fitView")} testid="wb-fit" onClick={fitView} />
        </div>
      </div>

      <div
        ref={(el) => (viewportEl = el)}
        data-testid="whiteboard-canvas"
        onPointerDown={onCanvasPointerDown}
        onWheel={(e) => {
          e.preventDefault();
          if (e.ctrlKey || e.metaKey) {
            const factor = e.deltaY < 0 ? 1.08 : 0.92;
            setZoom((z) => Math.max(0.25, Math.min(2.5, Math.round(z * factor * 100) / 100)));
          } else {
            setPanX((x) => x - e.deltaX);
            setPanY((y) => y - e.deltaY);
          }
        }}
        class={[
          "relative min-h-[56vh] xl:min-h-0 flex-1 overflow-hidden select-none",
          tool() === "pan" ? "cursor-grab" : tool() === "select" ? "cursor-default" : "cursor-crosshair",
        ]}
      >
        <Show when={!snapshot().loading && elements().length === 0}>
          <div class="pointer-events-none absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-muted">
            {t("web.artifact.whiteboard.empty")}
          </div>
        </Show>

        <div
          class="absolute top-0 left-0 origin-top-left [transform:translate(var(--wb-pan-x),var(--wb-pan-y))_scale(var(--wb-zoom))]"
          style={{
            "--wb-pan-x": `${panX()}px`,
            "--wb-pan-y": `${panY()}px`,
            "--wb-zoom": String(zoom()),
          }}
        >
          <svg width={4000} height={3000} class="pointer-events-none overflow-visible">
            <defs>
              <marker id="wb-arrow-head" markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto">
                <path d="M0,1 L9,5 L0,9 Z" fill="var(--color-muted)" />
              </marker>
            </defs>
            <For each={arrows()}>
              {(arr) => {
                const start = () => anchorPoint(arr.from, elementById(), "right");
                const end = () => anchorPoint(arr.to, elementById(), "left");
                const pointsText = () => {
                  const s = start();
                  const tPt = end();
                  if (!s || !tPt) return "";
                  const midX = Math.round((s.x + tPt.x) / 2);
                  const pts = arr.bends && arr.bends.length > 0 ? [s, ...arr.bends, tPt] : [s, { x: midX, y: s.y }, { x: midX, y: tPt.y }, tPt];
                  return pts.map((p) => `${p.x},${p.y}`).join(" ");
                };
                const mid = () => {
                  const s = start();
                  const tPt = end();
                  return s && tPt ? { x: (s.x + tPt.x) / 2, y: (s.y + tPt.y) / 2 } : undefined;
                };
                return (
                  <Show when={pointsText()}>
                    <g data-testid="wb-arrow" data-key={arr.id}>
                      <polyline
                        points={pointsText()}
                        fill="none"
                        stroke="var(--color-muted)"
                        stroke-width="2"
                        stroke-linejoin="round"
                        marker-end="url(#wb-arrow-head)"
                      />
                      <Show when={arr.label ? mid() : undefined}>
                        {(m) => (
                          <text x={m().x} y={m().y - 6} text-anchor="middle" fill="var(--color-ink)" class="text-xs font-medium">
                            {arr.label}
                          </text>
                        )}
                      </Show>
                    </g>
                  </Show>
                );
              }}
            </For>
          </svg>

          <For each={boxes()}>
            {(el) => {
              const isSelected = () => selectedIds().includes(el.id);
              const labelOf = () => el.label ?? el.title ?? el.text ?? "";
              return (
                <div
                  data-testid="wb-node"
                  data-key={el.id}
                  data-type={el.type}
                  onPointerDown={(e) => startNodeInteraction(e, el)}
                  onDblClick={(e) => {
                    e.stopPropagation();
                    setEditingId(el.id);
                    setEditDraft(labelOf());
                  }}
                  style={{
                    "--el-x": `${el.x ?? 0}px`,
                    "--el-y": `${el.y ?? 0}px`,
                    "--el-w": `${el.w ?? 176}px`,
                    "--el-h": `${el.h ?? 76}px`,
                  }}
                  class={[
                    "absolute top-(--el-y) left-(--el-x) w-(--el-w) min-h-(--el-h) transition-[border-color] duration-120",
                    el.type === "container"
                      ? "rounded-xl border-2 border-dashed border-line bg-page/60 p-3"
                      : el.type === "claim"
                        ? "rounded-xl border-2 border-dashed border-wheat bg-selected/40 p-3"
                        : el.type === "text"
                          ? "p-1 text-ink"
                          : el.shape === "pill" || el.shape === "ellipse"
                            ? `flex items-center justify-center rounded-full border px-4 py-2 shadow-raise ${fillClass(el.fill, el.shape)}`
                            : `flex flex-col justify-center rounded-lg border p-3 shadow-raise ${fillClass(el.fill, el.shape)}`,
                    isSelected() && "outline-solid outline-2 outline-accent outline-offset-2",
                  ]}
                >
                  <Show
                    when={editingId() === el.id}
                    fallback={
                      <>
                        <Show when={el.type === "claim"}>
                          <span class="inline-flex items-center gap-1 text-xs font-medium text-warn-ink">
                            <Icon name="bolt" size={12} />
                            {t("web.artifact.whiteboard.agentWorking", { label: labelOf() })}
                          </span>
                        </Show>
                        <Show when={el.type === "container"}>
                          <span class="text-xs font-semibold uppercase tracking-wide text-muted">{labelOf()}</span>
                        </Show>
                        <Show when={el.type === "shape" || el.type === "text"}>
                          <span class="text-center text-sm font-medium wrap-break-word">{labelOf()}</span>
                        </Show>
                        <Show when={el.type === "table"}>
                          <table class="w-full border-collapse text-left text-xs">
                            <Show when={el.headers && el.headers.length > 0}>
                              <thead>
                                <tr class="border-b border-line text-muted">
                                  <For each={el.headers ?? []}>{(h) => <th class="px-1.5 py-1 font-semibold">{h}</th>}</For>
                                </tr>
                              </thead>
                            </Show>
                            <tbody>
                              <For each={el.rows ?? []}>
                                {(r) => (
                                  <tr class="border-b border-line last:border-b-0">
                                    <For each={r}>{(cell) => <td class="px-1.5 py-1">{cell}</td>}</For>
                                  </tr>
                                )}
                              </For>
                            </tbody>
                          </table>
                        </Show>
                        <Show when={el.type === "svg" && el.svg}>
                          {(svgRaw) => (
                            <img
                              src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(sanitizeWhiteboardSvg(svgRaw()))}`}
                              alt={labelOf() || el.id}
                              class="pointer-events-none h-full w-full object-contain"
                            />
                          )}
                        </Show>
                        <Show when={el.type === "html"}>
                          <iframe
                            title={labelOf() || el.id}
                            src={storeViewUrl(props.artifact.id, { theme: shownTheme(), seq: seq(), elementId: el.id })}
                            sandbox={htmlSandbox}
                            referrerpolicy="no-referrer"
                            class="h-(--el-h) w-full rounded-md border-0 bg-page"
                          />
                        </Show>
                      </>
                    }
                  >
                    <input
                      data-testid="wb-label-input"
                      aria-label={t("web.artifact.whiteboard.doubleClickEdit")}
                      value={editDraft()}
                      ref={(inp) => queueMicrotask(() => inp.focus())}
                      onInput={(e) => setEditDraft(e.currentTarget.value)}
                      onBlur={() => commitLabel(el)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitLabel(el);
                        if (e.key === "Escape") setEditingId(undefined);
                      }}
                      class="w-full rounded-sm border border-focus bg-page px-1.5 py-0.5 text-sm text-ink outline-none"
                    />
                  </Show>
                </div>
              );
            }}
          </For>
        </div>
      </div>
    </div>
  );
}
