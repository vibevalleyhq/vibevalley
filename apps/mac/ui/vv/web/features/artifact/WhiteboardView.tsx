import { computed, effect, Scroll, signal, Text, untracked, View, WebView, type WebViewRef } from "nsh";
import { z } from "zod";

import { type ShellTheme, themeVariables, typeVariables } from "@vibevalley/artifact/shell";
import { sanitizeWhiteboardSvg, storeMessageOf } from "@vibevalley/artifact/viewers";
import { t } from "@vibevalley/i18n";

import { shownTheme } from "../../state/prefs";
import { createAct } from "../../ui/act";
import { Button } from "../../ui/Button";
import { TextArea, TextInput } from "../../ui/Field";
import { Icon } from "../../ui/Icon";
import { IconButton } from "../../ui/IconButton";
import { toast } from "../../ui/toasts";
import { withPolicy } from "./frame";
import { HtmlFrame } from "./HtmlFrame";
import { saveTextFile, useReportViewContext, useStoreEntries } from "./store";
import type { StoreViewerProps } from "./StoreArtifactView";

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

type WbElement = z.output<typeof WhiteboardElementSchema> & { readonly rev: number; readonly raw: string };
type Tool = "select" | "pan" | "rect" | "sticky" | "diamond" | "text" | "container" | "arrow";
type PlaceableTool = Exclude<Tool, "select" | "pan" | "arrow">;

const WhiteboardBridgeMessageSchema = z.discriminatedUnion("vibevalley", [
  z.object({ vibevalley: z.literal("wb-ready") }),
  z.object({ vibevalley: z.literal("wb-select"), ids: z.array(z.string()).max(200) }),
  z.object({ vibevalley: z.literal("wb-move"), id: z.string(), x: z.number(), y: z.number() }),
  z.object({
    vibevalley: z.literal("wb-create"),
    kind: z.enum(["rect", "sticky", "diamond", "text", "container"]),
    x: z.number(),
    y: z.number(),
  }),
  z.object({ vibevalley: z.literal("wb-arrow"), fromId: z.string(), toId: z.string() }),
  z.object({ vibevalley: z.literal("wb-label"), id: z.string(), text: z.string() }),
  z.object({ vibevalley: z.literal("wb-viewport"), zoom: z.number() }),
]);

const wbShim = String.raw`(() => {
  const allowed = new Set(["wb-ready", "wb-select", "wb-move", "wb-create", "wb-arrow", "wb-label", "wb-viewport", "store-embed-save"]);
  addEventListener("message", (e) => {
    const d = e.data;
    if (d && typeof d === "object" && typeof d.vibevalley === "string" && allowed.has(d.vibevalley)) {
      try {
        window.nsh.postMessage(JSON.stringify(d));
      } catch {}
    }
  });
})();`;

const escapeXml = (s: string) =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");

function labelOf(el: WbElement): string {
  return el.label ?? el.text ?? el.title ?? "";
}

function makeId(prefix: string): string {
  const rand = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID().slice(0, 6) : Math.random().toString(36).slice(2, 8);
  return `${prefix}-${rand}`;
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

function fillColorsForSvg(fill: string | undefined, shape?: string): { readonly bg: string; readonly border: string } {
  if (shape === "sticky" && !fill) return { bg: "#e8f0de", border: "#74a046" };
  switch (fill) {
    case "leaf":
    case "green":
    case "ok":
      return { bg: "#e8f0de", border: "#74a046" };
    case "berry":
    case "red":
    case "bad":
      return { bg: "#f8e4e0", border: "#a83a2c" };
    case "water":
    case "blue":
      return { bg: "#e7f0f8", border: "#2c6aa3" };
    case "wheat":
    case "amber":
    case "yellow":
      return { bg: "#faf2df", border: "#e5a93c" };
    case "side":
    case "muted":
      return { bg: "#f6f5f3", border: "#d4d0ca" };
    default:
      return { bg: "#fcfcfb", border: "#d4d0ca" };
  }
}

function buildWhiteboardSvg(elements: readonly WbElement[]): string {
  const byId = new Map(elements.map((e) => [e.id, e]));
  const boxes = elements.filter((e) => e.type !== "arrow");
  const arrows = elements.filter((e) => e.type === "arrow");

  const minX = boxes.length > 0 ? Math.min(...boxes.map((b) => b.x ?? 0)) - 48 : 0;
  const minY = boxes.length > 0 ? Math.min(...boxes.map((b) => b.y ?? 0)) - 48 : 0;
  const maxX = boxes.length > 0 ? Math.max(...boxes.map((b) => (b.x ?? 0) + (b.w ?? 180))) + 48 : 800;
  const maxY = boxes.length > 0 ? Math.max(...boxes.map((b) => (b.y ?? 0) + (b.h ?? 84))) + 48 : 500;
  const width = Math.max(320, Math.round(maxX - minX));
  const height = Math.max(240, Math.round(maxY - minY));

  const layers: string[] = [];

  for (const el of boxes) {
    const x = el.x ?? 0;
    const y = el.y ?? 0;
    const w = el.w ?? 176;
    const h = el.h ?? 76;
    const text = escapeXml(labelOf(el));
    if (el.type === "container" || el.type === "claim") {
      const stroke = el.type === "claim" ? "#e5a93c" : "#aca59e";
      layers.push(
        `<g><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="12" fill="#fcfcfb" fill-opacity="0.65" stroke="${stroke}" stroke-width="2" stroke-dasharray="6 4"/>` +
          `<text x="${x + 12}" y="${y + 22}" font-family="system-ui,sans-serif" font-size="12" font-weight="600" fill="#5e5852">${text}</text></g>`,
      );
    } else if (el.type === "text") {
      layers.push(
        `<text x="${x + 4}" y="${y + 22}" font-family="system-ui,sans-serif" font-size="14" font-weight="500" fill="#1c1917">${text}</text>`,
      );
    } else if (el.type === "svg" && el.svg) {
      layers.push(`<g transform="translate(${x},${y})">${sanitizeWhiteboardSvg(el.svg)}</g>`);
    } else {
      const colors = fillColorsForSvg(el.fill, el.shape);
      const rx = el.shape === "pill" || el.shape === "ellipse" ? Math.round(h / 2) : 8;
      layers.push(
        `<g><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${colors.bg}" stroke="${colors.border}" stroke-width="1.5"/>` +
          `<text x="${x + w / 2}" y="${y + h / 2 + 5}" text-anchor="middle" font-family="system-ui,sans-serif" font-size="13" font-weight="500" fill="#1c1917">${text}</text></g>`,
      );
    }
  }

  for (const arr of arrows) {
    const start = anchorPoint(arr.from, byId, "right");
    const end = anchorPoint(arr.to, byId, "left");
    if (!start || !end) continue;
    const pts = [start, ...(arr.bends ?? []), end];
    const d = pts.map((p, i) => `${i === 0 ? "M" : "L"}${Math.round(p.x)} ${Math.round(p.y)}`).join(" ");
    const mid = pts[Math.floor(pts.length / 2)] ?? end;
    const label = arr.label
      ? `<text x="${Math.round((start.x + mid.x) / 2)}" y="${Math.round((start.y + mid.y) / 2) - 6}" text-anchor="middle" font-family="system-ui,sans-serif" font-size="11" fill="#5e5852">${escapeXml(arr.label)}</text>`
      : "";
    layers.push(`<g><path d="${d}" fill="none" stroke="#5e5852" stroke-width="1.75" marker-end="url(#wb-arrow)"/>${label}</g>`);
  }

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${Math.round(minX)} ${Math.round(minY)} ${width} ${height}" width="${width}" height="${height}">` +
    `<defs><marker id="wb-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 1 L 10 5 L 0 9 z" fill="#5e5852"/></marker></defs>` +
    `<rect x="${Math.round(minX)}" y="${Math.round(minY)}" width="${width}" height="${height}" fill="#f6f5f3"/>` +
    `${layers.join("")}</svg>`
  );
}

function buildWhiteboardHtml(initialTheme: ShellTheme, emptyText: string, doubleClickHint: string): string {
  const runtime = String.raw`(() => {
    const say = (payload) => parent.postMessage(payload, "*");
    const viewport = document.getElementById("wb-viewport");
    const stage = document.getElementById("wb-stage");
    const arrowsSvg = document.getElementById("wb-arrows");
    const nodesLayer = document.getElementById("wb-nodes");
    const emptyEl = document.getElementById("wb-empty");

    let elements = [];
    let selectedIds = [];
    let tool = "select";
    let panX = 48;
    let panY = 48;
    let zoom = 1;
    let arrowStart = null;
    let editingId = null;
    let dragState = null;

    const escapeHtml = (s) => String(s ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

    const applyTransform = () => {
      stage.style.transform = "translate(" + panX + "px," + panY + "px) scale(" + zoom + ")";
    };

    const anchorPoint = (ep, byId, fallbackSide) => {
      if (!ep) return null;
      if (typeof ep.x === "number" && typeof ep.y === "number") return { x: ep.x, y: ep.y };
      const target = byId.get(ep.id);
      if (!target) return null;
      const x = target.x ?? 0;
      const y = target.y ?? 0;
      const w = target.w ?? 160;
      const h = target.h ?? 72;
      const side = ep.side || fallbackSide;
      if (side === "top" || side === "n") return { x: x + w / 2, y };
      if (side === "bottom" || side === "s") return { x: x + w / 2, y: y + h };
      if (side === "left" || side === "w") return { x, y: y + h / 2 };
      return { x: x + w, y: y + h / 2 };
    };

    const fillTone = (fill, shape) => {
      if (shape === "sticky" && !fill) return "tone-leaf";
      if (fill === "leaf" || fill === "green" || fill === "ok") return "tone-leaf";
      if (fill === "berry" || fill === "red" || fill === "bad") return "tone-berry";
      if (fill === "water" || fill === "blue") return "tone-water";
      if (fill === "wheat" || fill === "amber" || fill === "yellow") return "tone-wheat";
      if (fill === "side" || fill === "muted") return "tone-side";
      return "tone-page";
    };

    const labelOf = (el) => el.label ?? el.text ?? el.title ?? "";

    const render = () => {
      const byId = new Map();
      for (const el of elements) {
        if (dragState && dragState.kind === "node" && dragState.id === el.id) {
          byId.set(el.id, Object.assign({}, el, { x: (el.x ?? 0) + dragState.dx, y: (el.y ?? 0) + dragState.dy }));
        } else {
          byId.set(el.id, el);
        }
      }
      const all = Array.from(byId.values());
      const boxes = all.filter((e) => e.type !== "arrow");
      const arrows = all.filter((e) => e.type === "arrow");
      emptyEl.style.display = all.length === 0 ? "flex" : "none";

      let svgParts = '<defs><marker id="wb-ah" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 1 L 10 5 L 0 9 z" fill="var(--vv-muted)"/></marker></defs>';
      for (const arr of arrows) {
        const s = anchorPoint(arr.from, byId, "right");
        const e = anchorPoint(arr.to, byId, "left");
        if (!s || !e) continue;
        const pts = [s, ...(arr.bends || []), e];
        const d = pts.map((p, i) => (i === 0 ? "M" : "L") + Math.round(p.x) + " " + Math.round(p.y)).join(" ");
        const isSel = selectedIds.includes(arr.id);
        svgParts += '<path d="' + d + '" fill="none" stroke="' + (isSel ? "var(--vv-accent)" : "var(--vv-muted)") + '" stroke-width="' + (isSel ? "2.5" : "1.75") + '" marker-end="url(#wb-ah)"/>';
        if (arr.label) {
          const mid = pts[Math.floor(pts.length / 2)] || e;
          svgParts += '<text x="' + Math.round((s.x + mid.x) / 2) + '" y="' + (Math.round((s.y + mid.y) / 2) - 6) + '" text-anchor="middle" fill="var(--vv-muted)" font-size="11">' + escapeHtml(arr.label) + '</text>';
        }
      }
      arrowsSvg.innerHTML = svgParts;

      nodesLayer.innerHTML = "";
      for (const el of boxes) {
        const node = document.createElement("div");
        const isSel = selectedIds.includes(el.id);
        const isArrowSrc = arrowStart === el.id;
        let cls = "wb-node";
        if (el.type === "container") cls += " wb-container";
        else if (el.type === "claim") cls += " wb-claim";
        else if (el.type === "text") cls += " wb-text";
        else if (el.shape === "pill" || el.shape === "ellipse") cls += " wb-pill " + fillTone(el.fill, el.shape);
        else cls += " wb-box " + fillTone(el.fill, el.shape);
        if (isSel || isArrowSrc) cls += " is-selected";
        node.className = cls;
        node.style.left = (el.x ?? 0) + "px";
        node.style.top = (el.y ?? 0) + "px";
        node.style.width = (el.w ?? 176) + "px";
        node.style.minHeight = (el.h ?? 76) + "px";
        node.dataset.id = el.id;
        node.title = ${JSON.stringify(doubleClickHint)};

        if (editingId === el.id) {
          const inp = document.createElement("input");
          inp.className = "wb-inline-input";
          inp.value = labelOf(el);
          const commit = () => {
            const val = inp.value.trim();
            editingId = null;
            say({ vibevalley: "wb-label", id: el.id, text: val });
            render();
          };
          inp.addEventListener("blur", commit);
          inp.addEventListener("keydown", (ev) => {
            if (ev.key === "Enter") commit();
            if (ev.key === "Escape") { editingId = null; render(); }
          });
          node.appendChild(inp);
          queueMicrotask(() => { inp.focus(); inp.select(); });
        } else if (el.type === "table") {
          let html = '<table class="wb-table">';
          if (Array.isArray(el.headers) && el.headers.length > 0) {
            html += "<thead><tr>" + el.headers.map((h) => "<th>" + escapeHtml(h) + "</th>").join("") + "</tr></thead>";
          }
          html += "<tbody>" + (el.rows || []).map((r) => "<tr>" + r.map((c) => "<td>" + escapeHtml(c) + "</td>").join("") + "</tr>").join("") + "</tbody></table>";
          node.innerHTML = html;
        } else if (el.type === "svg" && el.sanitizedSvg) {
          const img = document.createElement("img");
          img.className = "wb-svg-img";
          img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(el.sanitizedSvg);
          img.alt = labelOf(el) || el.id;
          node.appendChild(img);
        } else if (el.type === "html") {
          node.innerHTML = '<div class="wb-embed-badge">HTML Embed · ' + escapeHtml(labelOf(el) || el.id) + "</div>";
        } else if (el.type === "claim") {
          node.innerHTML = '<div class="wb-claim-label">' + escapeHtml(labelOf(el) || el.id) + "</div>";
        } else if (el.type === "container") {
          node.innerHTML = '<div class="wb-container-label">' + escapeHtml(labelOf(el) || el.id) + "</div>";
        } else {
          const span = document.createElement("div");
          span.className = "wb-label";
          span.textContent = labelOf(el);
          node.appendChild(span);
        }

        node.addEventListener("dblclick", (ev) => {
          ev.stopPropagation();
          if (el.type === "shape" || el.type === "text" || el.type === "container") {
            editingId = el.id;
            render();
          }
        });

        node.addEventListener("pointerdown", (ev) => {
          if (editingId === el.id) return;
          ev.stopPropagation();
          if (tool === "arrow") {
            if (!arrowStart) {
              arrowStart = el.id;
              selectedIds = [el.id];
              say({ vibevalley: "wb-select", ids: selectedIds });
              render();
            } else if (arrowStart !== el.id) {
              const fromId = arrowStart;
              arrowStart = null;
              tool = "select";
              say({ vibevalley: "wb-arrow", fromId, toId: el.id });
              render();
            }
            return;
          }
          selectedIds = ev.shiftKey ? Array.from(new Set([...selectedIds, el.id])) : [el.id];
          say({ vibevalley: "wb-select", ids: selectedIds });
          dragState = { kind: "node", id: el.id, startX: ev.clientX, startY: ev.clientY, baseX: el.x ?? 0, baseY: el.y ?? 0, dx: 0, dy: 0 };
          render();
        });

        nodesLayer.appendChild(node);
      }
      applyTransform();
    };

    viewport.addEventListener("pointerdown", (ev) => {
      if (tool !== "select" && tool !== "pan" && tool !== "arrow") {
        const rect = viewport.getBoundingClientRect();
        const wx = (ev.clientX - rect.left - panX) / zoom;
        const wy = (ev.clientY - rect.top - panY) / zoom;
        say({ vibevalley: "wb-create", kind: tool, x: wx, y: wy });
        tool = "select";
        return;
      }
      selectedIds = [];
      arrowStart = null;
      say({ vibevalley: "wb-select", ids: [] });
      dragState = { kind: "pan", startX: ev.clientX, startY: ev.clientY, basePanX: panX, basePanY: panY };
      render();
    });

    window.addEventListener("pointermove", (ev) => {
      if (!dragState) return;
      if (dragState.kind === "pan") {
        panX = dragState.basePanX + (ev.clientX - dragState.startX);
        panY = dragState.basePanY + (ev.clientY - dragState.startY);
        applyTransform();
      } else if (dragState.kind === "node") {
        dragState.dx = Math.round((ev.clientX - dragState.startX) / zoom);
        dragState.dy = Math.round((ev.clientY - dragState.startY) / zoom);
        render();
      }
    });

    window.addEventListener("pointerup", () => {
      if (!dragState) return;
      const done = dragState;
      dragState = null;
      if (done.kind === "node" && (Math.abs(done.dx) > 2 || Math.abs(done.dy) > 2)) {
        const nextX = Math.round((done.baseX + done.dx) / 4) * 4;
        const nextY = Math.round((done.baseY + done.dy) / 4) * 4;
        say({ vibevalley: "wb-move", id: done.id, x: nextX, y: nextY });
      }
    });

    viewport.addEventListener("wheel", (ev) => {
      ev.preventDefault();
      if (ev.ctrlKey || ev.metaKey) {
        const delta = ev.deltaY < 0 ? 0.1 : -0.1;
        zoom = Math.max(0.25, Math.min(2.5, Math.round((zoom + delta) * 100) / 100));
        applyTransform();
        say({ vibevalley: "wb-viewport", zoom });
      } else {
        panX -= ev.deltaX;
        panY -= ev.deltaY;
        applyTransform();
      }
    }, { passive: false });

    const fitView = () => {
      const boxes = elements.filter((e) => e.type !== "arrow");
      if (boxes.length === 0) {
        panX = 48; panY = 48; zoom = 1;
      } else {
        const minX = Math.min(...boxes.map((b) => b.x ?? 0));
        const minY = Math.min(...boxes.map((b) => b.y ?? 0));
        const maxX = Math.max(...boxes.map((b) => (b.x ?? 0) + (b.w ?? 160)));
        const maxY = Math.max(...boxes.map((b) => (b.y ?? 0) + (b.h ?? 80)));
        const cw = Math.max(200, maxX - minX + 96);
        const ch = Math.max(200, maxY - minY + 96);
        const rect = viewport.getBoundingClientRect();
        zoom = Math.max(0.3, Math.min(1.5, Math.round(Math.min(rect.width / cw, rect.height / ch) * 100) / 100));
        panX = Math.round(48 - minX * zoom);
        panY = Math.round(48 - minY * zoom);
      }
      applyTransform();
      say({ vibevalley: "wb-viewport", zoom });
    };

    window.__wb = {
      sync: (next) => {
        if (Array.isArray(next.elements)) elements = next.elements;
        if (Array.isArray(next.selectedIds)) selectedIds = next.selectedIds;
        if (typeof next.tool === "string") { tool = next.tool; arrowStart = null; }
        if (next.theme === "light" || next.theme === "dark") {
          document.documentElement.setAttribute("data-theme", next.theme);
          document.documentElement.style.cssText = next.themeCss || "";
        }
        render();
      },
      zoomBy: (delta) => {
        zoom = Math.max(0.25, Math.min(2.5, Math.round((zoom + delta) * 100) / 100));
        applyTransform();
        say({ vibevalley: "wb-viewport", zoom });
      },
      fitView,
    };

    render();
    say({ vibevalley: "wb-ready" });
  })();`;

  const html = `<!doctype html>
<html lang="zh" data-theme="${initialTheme}" style="${themeVariables[initialTheme]}${typeVariables}">
<head>
<meta charset="utf-8" />
<style>
*{box-sizing:border-box}
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:var(--vv-side);color:var(--vv-ink);font-family:var(--vv-font-sans);user-select:none;-webkit-user-select:none}
#wb-viewport{position:relative;width:100%;height:100%;overflow:hidden;background-image:radial-gradient(var(--vv-line) 1px,transparent 1px);background-size:20px 20px;cursor:grab}
#wb-viewport:active{cursor:grabbing}
#wb-stage{position:absolute;left:0;top:0;transform-origin:0 0}
#wb-arrows{position:absolute;left:0;top:0;width:4000px;height:4000px;overflow:visible;pointer-events:none}
#wb-nodes{position:absolute;left:0;top:0}
#wb-empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:32px;text-align:center;color:var(--vv-muted);font-size:13px;pointer-events:none}
.wb-node{position:absolute;cursor:pointer;transition:box-shadow 120ms ease-out}
.wb-node.is-selected{outline:2px solid var(--vv-accent);outline-offset:2px}
.wb-box{display:flex;flex-direction:column;justify-content:center;border-radius:8px;border:1px solid var(--vv-line);padding:12px;box-shadow:0 1px 2px rgba(0,0,0,0.08)}
.wb-pill{display:flex;align-items:center;justify-content:center;border-radius:999px;border:1px solid var(--vv-line);padding:8px 16px;box-shadow:0 1px 2px rgba(0,0,0,0.08)}
.wb-container{border-radius:12px;border:2px dashed var(--vv-line);background:color-mix(in srgb,var(--vv-page) 60%,transparent);padding:12px}
.wb-claim{border-radius:12px;border:2px dashed var(--vv-wheat);background:color-mix(in srgb,var(--vv-wheat) 12%,transparent);padding:12px}
.wb-text{padding:4px;color:var(--vv-ink)}
.wb-label{text-align:center;font-size:13px;font-weight:500;word-break:break-word}
.wb-container-label{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;color:var(--vv-muted)}
.wb-claim-label{font-size:12px;font-weight:500;color:var(--vv-wheat)}
.wb-embed-badge{font-size:12px;font-family:var(--vv-font-mono);color:var(--vv-muted);text-align:center}
.wb-svg-img{width:100%;height:100%;object-fit:contain;pointer-events:none}
.wb-inline-input{width:100%;border-radius:4px;border:1px solid var(--vv-accent);background:var(--vv-page);color:var(--vv-ink);padding:4px 6px;font-size:13px;outline:none}
.wb-table{width:100%;border-collapse:collapse;font-size:12px;text-align:left}
.wb-table th,.wb-table td{border-bottom:1px solid var(--vv-line);padding:4px 6px}
.wb-table th{color:var(--vv-muted);font-weight:600}
.tone-page{background:var(--vv-page);border-color:var(--vv-line)}
.tone-side{background:var(--vv-side);border-color:var(--vv-line)}
.tone-leaf{background:color-mix(in srgb,var(--vv-leaf) 18%,var(--vv-page));border-color:var(--vv-leaf)}
.tone-berry{background:color-mix(in srgb,var(--vv-berry) 16%,var(--vv-page));border-color:var(--vv-berry)}
.tone-water{background:color-mix(in srgb,var(--vv-water) 16%,var(--vv-page));border-color:var(--vv-water)}
.tone-wheat{background:color-mix(in srgb,var(--vv-wheat) 18%,var(--vv-page));border-color:var(--vv-wheat)}
</style>
</head>
<body>
<div id="wb-viewport">
  <div id="wb-empty">${escapeXml(emptyText)}</div>
  <div id="wb-stage">
    <svg id="wb-arrows"></svg>
    <div id="wb-nodes"></div>
  </div>
</div>
<script>${runtime}</script>
</body>
</html>`;

  return withPolicy(html);
}

const FILL_OPTIONS = ["default", "leaf", "water", "wheat", "berry", "side"] as const;

export function WhiteboardView(props: StoreViewerProps) {
  const { client, snapshot } = useStoreEntries(() => props.artifact.id);
  const act = createAct();

  const tool = signal<Tool>("select");
  const zoom = signal(1);
  const selectedIds = signal<readonly string[]>([]);
  const inspectorOpen = signal(false);
  const webReady = signal(false);
  const labelDraft = signal("");
  const jsonDraft = signal("");
  const lastInspectedKey = signal<string | undefined>(undefined);

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

  const initialHtml = buildWhiteboardHtml(
    untracked(() => shownTheme()),
    t("web.artifact.whiteboard.empty"),
    t("web.artifact.whiteboard.doubleClickEdit"),
  );

  const pushSync = () => {
    if (!webReady() || !webRef) return;
    const th = shownTheme();
    const wireElements = elements().map((el) => ({
      ...el,
      ...(el.type === "svg" && el.svg ? { sanitizedSvg: sanitizeWhiteboardSvg(el.svg) } : {}),
    }));
    const payload = {
      elements: wireElements,
      selectedIds: [...selectedIds()],
      tool: tool(),
      theme: th,
      themeCss: `${themeVariables[th]}${typeVariables}`,
    };
    webRef.injectJavaScript(`window.__wb && window.__wb.sync(${JSON.stringify(payload)});`);
  };

  effect(() => {
    void elements();
    void selectedIds();
    void tool();
    void shownTheme();
    void webReady();
    pushSync();
  });

  const createAt = (worldX: number, worldY: number, kind: PlaceableTool) => {
    const id = makeId("n");
    const base = {
      id,
      x: Math.round(worldX / 12) * 12,
      y: Math.round(worldY / 12) * 12,
    };
    const payload =
      kind === "container"
        ? { ...base, type: "container", w: 320, h: 220, title: "Frame" }
        : kind === "text"
          ? { ...base, type: "text", w: 180, h: 40, text: "Note" }
          : kind === "sticky"
            ? { ...base, type: "shape", shape: "sticky", w: 168, h: 120, fill: "leaf", label: "Idea" }
            : kind === "diamond"
              ? { ...base, type: "shape", shape: "diamond", w: 160, h: 96, fill: "wheat", label: "Decision" }
              : { ...base, type: "shape", shape: "rect", w: 176, h: 76, label: "Node" };

    selectedIds.set([id]);
    tool.set("select");
    void act.run(() => client.batch([{ op: "set", path: `elements/${id}`, kind: "json", value: JSON.stringify(payload) }]));
  };

  const quickAdd = (kind: PlaceableTool) => {
    const count = elements().length;
    createAt(120 + (count % 5) * 48, 120 + Math.floor(count / 5) * 48, kind);
  };

  const deleteSelected = () => {
    const ids = selectedIds();
    if (ids.length === 0) return;
    selectedIds.set([]);
    void act.run(() => client.batch(ids.map((id) => ({ op: "delete", path: `elements/${id}` }))));
  };

  const patchLabel = (id: string, text: string) => {
    const el = elements().find((e) => e.id === id);
    if (!el) return;
    const field = el.type === "container" ? { title: text } : el.type === "text" ? { text } : { label: text };
    void act.run(() => client.batch([{ op: "patch", path: `elements/${id}`, value: JSON.stringify(field) }]));
  };

  const patchFill = (id: string, fill: (typeof FILL_OPTIONS)[number]) => {
    const value = fill === "default" ? { fill: null } : { fill };
    void act.run(() => client.batch([{ op: "patch", path: `elements/${id}`, value: JSON.stringify(value) }]));
  };

  const saveInspectorJson = () => {
    const el = selectedElement();
    if (!el) return;
    const raw = jsonDraft();
    void act.run(async () => {
      JSON.parse(raw);
      await client.batch([{ op: "set", path: `elements/${el.id}`, kind: "json", value: raw, ifRev: el.rev }]);
      toast("Saved element");
    });
  };

  const handleRawMessage = (raw: unknown) => {
    const embedMsg = storeMessageOf(raw);
    if (embedMsg?.vibevalley === "store-embed-save") {
      void act.run(() =>
        client.batch([
          {
            op: "patch",
            path: `elements/${embedMsg.elementId}`,
            value: JSON.stringify({ state: embedMsg.state }),
          },
        ]),
      );
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
      case "wb-move":
        void act.run(() =>
          client.batch([{ op: "patch", path: `elements/${msg.id}`, value: JSON.stringify({ x: msg.x, y: msg.y }) }]),
        );
        break;
      case "wb-create":
        createAt(msg.x, msg.y, msg.kind);
        break;
      case "wb-arrow": {
        const arrowId = makeId("a");
        tool.set("select");
        void act.run(() =>
          client.batch([
            {
              op: "set",
              path: `elements/${arrowId}`,
              kind: "json",
              value: JSON.stringify({
                id: arrowId,
                type: "arrow",
                from: { id: msg.fromId, side: "right" },
                to: { id: msg.toId, side: "left" },
              }),
            },
          ]),
        );
        break;
      }
      case "wb-label":
        patchLabel(msg.id, msg.text);
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
      const svg = buildWhiteboardSvg(elements());
      const saved = await saveTextFile(`${safeFileBase()}.svg`, "image/svg+xml", svg);
      if (saved) toast("Exported SVG");
    });
  };

  const exportJson = () => {
    void act.run(async () => {
      const metaRaw = snapshot().entries.get("board/meta")?.value;
      const payload = {
        title: props.artifact.title,
        seq: seq(),
        meta: metaRaw ? JSON.parse(metaRaw) : undefined,
        elements: elements().map(({ rev: _rev, raw: _raw, ...rest }) => rest),
      };
      const saved = await saveTextFile(`${safeFileBase()}.json`, "application/json", JSON.stringify(payload, null, 2));
      if (saved) toast("Exported JSON");
    });
  };

  const toolButton = (id: Tool, label: string) => {
    const active = () => tool() === id;
    return (
      <View
        role="button"
        testID={`wb-tool-${id}`}
        accessibilityState={{ selected: active() }}
        onPress={() => tool.set(id)}
        class={`rounded-md px-2 py-1 ${active() ? "bg-selected" : "hover:bg-hover"}`}
      >
        <Text class={`text-xs font-medium ${active() ? "text-ink" : "text-muted"}`}>{label}</Text>
      </View>
    );
  };

  return (
    <View testID="whiteboard-view" class="min-h-0 min-w-0 flex-1 overflow-hidden rounded-lg border border-line bg-side">
      <View class="shrink-0 flex-row flex-wrap items-center gap-1 border-b border-line bg-page px-2.5 py-1.5">
        {toolButton("select", t("web.artifact.whiteboard.select"))}
        {toolButton("pan", t("web.artifact.whiteboard.pan"))}
        <View class="mx-1 h-4 w-px bg-line" />
        {toolButton("rect", t("web.artifact.whiteboard.rect"))}
        {toolButton("sticky", t("web.artifact.whiteboard.sticky"))}
        {toolButton("diamond", t("web.artifact.whiteboard.diamond"))}
        {toolButton("container", t("web.artifact.whiteboard.container"))}
        {toolButton("text", t("web.artifact.whiteboard.text"))}
        {toolButton("arrow", t("web.artifact.whiteboard.arrow"))}
        <View class="mx-1 h-4 w-px bg-line" />
        <Button icon="add" testID="wb-add-node" disabled={act.busy()} onPress={() => quickAdd("rect")}>
          {t("web.artifact.whiteboard.rect")}
        </Button>
        <Button icon="add" testID="wb-add-frame" disabled={act.busy()} onPress={() => quickAdd("container")}>
          {t("web.artifact.whiteboard.container")}
        </Button>
        <If when={selectedIds().length > 0}>
          <Button tone="danger" icon="delete" testID="wb-delete" disabled={act.busy()} onPress={deleteSelected}>
            {t("web.artifact.whiteboard.deleteSelected")}
          </Button>
        </If>

        <View class="ml-auto flex-row items-center gap-1">
          <Text class="text-xs text-muted tabular-nums">{t("web.artifact.whiteboard.elements", { n: elements().length })}</Text>
          <IconButton
            icon="partly"
            label={t("web.artifact.whiteboard.zoomOut")}
            testid="wb-zoom-out"
            onClick={() => webRef?.injectJavaScript("window.__wb && window.__wb.zoomBy(-0.15);")}
          />
          <Text class="min-w-10 text-center text-xs text-muted tabular-nums">{`${Math.round(zoom() * 100)}%`}</Text>
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
            label="Inspector"
            testid="wb-inspector-toggle"
            pressed={inspectorOpen()}
            onClick={() => inspectorOpen.set(!inspectorOpen())}
          />
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
          <View testID="wb-inspector" class="w-72 shrink-0 border-l border-line bg-page">
            <Scroll class="min-h-0 flex-1" contentClass="p-3 gap-3">
              <If
                when={selectedElement()}
                else={
                  <View class="gap-2">
                    <Text class="text-xs font-semibold text-muted">{t("web.artifact.whiteboard.elements", { n: elements().length })}</Text>
                    <Each of={elements()}>
                      {(el) => (
                        <View
                          role="button"
                          onPress={() => selectedIds.set([el().id])}
                          class="flex-row items-center justify-between gap-2 rounded-md border border-line bg-side px-2.5 py-1.5 hover:bg-hover"
                        >
                          <Text class="truncate text-xs font-medium text-ink">{labelOf(el()) || el().id}</Text>
                          <Text class="font-mono text-2xs text-faint">{el().type}</Text>
                        </View>
                      )}
                    </Each>
                  </View>
                }
              >
                {(el) => (
                  <View class="gap-3">
                    <View class="flex-row items-center justify-between gap-2">
                      <View class="flex-row items-center gap-1.5">
                        <Icon name="bolt" size={12} tone="muted" />
                        <Text class="font-mono text-xs font-semibold text-ink">{el().id}</Text>
                      </View>
                      <Text class="font-mono text-2xs text-faint">{`${el().type} · rev ${el().rev}`}</Text>
                    </View>

                    <If when={el().type !== "arrow"}>
                      <View class="gap-1">
                        <Text class="text-xs font-medium text-muted">Label</Text>
                        <View class="flex-row gap-1.5">
                          <TextInput
                            testID="wb-inspector-label"
                            value={labelDraft()}
                            onInput={(v) => labelDraft.set(v)}
                            onSubmit={(v) => patchLabel(el().id, v.trim())}
                            class="min-w-0 flex-1"
                          />
                          <Button tone="primary" disabled={act.busy()} onPress={() => patchLabel(el().id, labelDraft().trim())}>
                            Save
                          </Button>
                        </View>
                      </View>
                    </If>

                    <If when={el().type === "shape"}>
                      <View class="gap-1">
                        <Text class="text-xs font-medium text-muted">Fill</Text>
                        <View class="flex-row flex-wrap gap-1">
                          <Each of={FILL_OPTIONS}>
                            {(f) => {
                              const current = () => (el().fill ?? "default") === f();
                              return (
                                <View
                                  role="button"
                                  onPress={() => patchFill(el().id, f())}
                                  class={`rounded-md border px-2 py-0.5 ${current() ? "border-accent bg-selected" : "border-line bg-side hover:bg-hover"}`}
                                >
                                  <Text class={`text-2xs font-medium ${current() ? "text-ink" : "text-muted"}`}>{f()}</Text>
                                </View>
                              );
                            }}
                          </Each>
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

                    <View class="gap-1">
                      <Text class="text-xs font-medium text-muted">Entry JSON</Text>
                      <TextArea
                        rows={8}
                        testID="wb-inspector-json"
                        value={jsonDraft()}
                        onInput={(v) => jsonDraft.set(v)}
                        class="font-mono text-xs"
                      />
                      <View class="flex-row justify-end">
                        <Button tone="primary" testID="wb-inspector-save-json" disabled={act.busy()} onPress={saveInspectorJson}>
                          Save JSON
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
