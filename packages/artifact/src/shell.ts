import { type ArtifactDisplay, artifactPath, type HtmlAnchor, type HtmlShellMessage } from "@vibevalley/protocol";
import * as S from "@vibevalley/protocol/schema";

/** The workbench theme the page is shown in: the frame cannot read the workbench's own setting. */
export const ShellThemeValues = ["light", "dark"] as const;
export type ShellTheme = (typeof ShellThemeValues)[number];

export const CanvasPaletteValues = ["workbench", "brutalist-red", "newsprint", "blueprint"] as const;
export const CanvasFilterValues = ["none", "torn-paper", "sticker-cutout", "halftone", "grain", "shadow"] as const;

// Keep in sync with --wb-* tokens in apps/web/src/style.css.
const themeVariables: Record<ShellTheme, string> = {
  light:
    "color-scheme:light;--vv-page:#fcfcfb;--vv-side:#f6f5f3;--vv-ink:#1c1917;--vv-muted:#5e5852;--vv-faint:#716a64;--vv-line:#1c191714;--vv-accent:#4d7a2a;--vv-leaf:#74a046;--vv-wheat:#e5a93c;--vv-berry:#a83a2c;--vv-water:#2f6fa8;",
  dark: "color-scheme:dark;--vv-page:#151413;--vv-side:#1b1a18;--vv-ink:#ecebe8;--vv-muted:#a9a49e;--vv-faint:#8b867f;--vv-line:#ecebe81a;--vv-accent:#7fae4f;--vv-leaf:#8dbb5c;--vv-wheat:#e5a93c;--vv-berry:#e47d6d;--vv-water:#6aa6dc;",
};
const typeVariables =
  '--vv-font-sans:"PingFang SC","Hiragino Sans GB","Noto Sans CJK SC","Noto Sans SC","Microsoft YaHei",system-ui,sans-serif;--vv-font-mono:Menlo,ui-monospace,monospace;--vv-radius:8px;';

const selectionScript = String.raw`(() => {
  const hidden = new Set(["HEAD", "SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT", "TEXTAREA", "TITLE"]);
  const context = 32;
  const texts = () => {
    const out = [];
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => {
        for (let p = n.parentElement; p; p = p.parentElement) if (hidden.has(p.tagName)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) out.push(n);
    return out;
  };
  const indexOf = (nodes, container, offset) => {
    const point = document.createRange();
    point.setStart(container, offset);
    let at = 0;
    for (const t of nodes) {
      if (t === container) return at + offset;
      if (point.comparePoint(t, 0) >= 0) return at;
      at += t.data.length;
    }
    return at;
  };
  const anchor = () => {
    const sel = document.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
    const range = sel.getRangeAt(0);
    const nodes = texts();
    const whole = nodes.map((t) => t.data).join("");
    const from = indexOf(nodes, range.startContainer, range.startOffset);
    const to = indexOf(nodes, range.endContainer, range.endOffset);
    const exact = whole.slice(from, to);
    if (exact.trim() === "") return null;
    return { kind: "text", exact, prefix: whole.slice(Math.max(0, from - context), from), suffix: whole.slice(to, to + context) };
  };
  let timer = 0;
  document.addEventListener("selectionchange", () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      let found = null;
      try {
        found = anchor();
      } catch {
        found = null;
      }
      if (found) parent.postMessage({ vibevalley: "selection", anchor: found }, "*");
    }, 150);
  });
})();`;

const runtimeScript = String.raw`(config) => {
  const say = (message) => parent.postMessage(Object.assign({ vibevalley: message.kind }, message.body), "*");
  const commands = {};
  addEventListener("message", (e) => {
    if (e.source !== parent) return;
    const d = e.data;
    if (!d || typeof d !== "object" || typeof d.vibevalley !== "string") return;
    const run = Object.prototype.hasOwnProperty.call(commands, d.vibevalley) ? commands[d.vibevalley] : undefined;
    if (run) run(d);
  });
  const asked = new URLSearchParams(location.search);
  const canvasRuntime = (mode) => () => {
    const board = document.querySelector("vv-board");
    if (!board) return say({ kind: "ready", body: { display: mode } });
    const root = document.documentElement;
    root.classList.add("vv-canvas");

      const svgNS = "http://www.w3.org/2000/svg";
      const defsSvg = document.createElementNS(svgNS, "svg");
      defsSvg.setAttribute("style", "position:absolute;width:0;height:0;overflow:hidden;pointer-events:none");
      defsSvg.setAttribute("aria-hidden", "true");
      defsSvg.innerHTML =
        '<defs><filter id="vv-filter-torn"><feTurbulence type="fractalNoise" baseFrequency="0.04" numOctaves="3" result="noise"/><feDisplacementMap in="SourceGraphic" in2="noise" scale="5" xChannelSelector="R" yChannelSelector="G"/></filter><filter id="vv-filter-grain"><feTurbulence type="fractalNoise" baseFrequency="0.75" numOctaves="3" stitchTiles="stitch" result="n"/><feColorMatrix in="n" type="saturate" values="0" result="g"/><feComponentTransfer in="g" result="a"><feFuncA type="linear" slope="0.18"/></feComponentTransfer><feBlend in="SourceGraphic" in2="a" mode="overlay"/></filter></defs>';
      (document.body || document.documentElement).appendChild(defsSvg);

      const grainEl = document.createElement("div");
      grainEl.setAttribute("data-vv-grain", "true");
      grainEl.setAttribute("aria-hidden", "true");
      grainEl.style.display = "none";
      board.appendChild(grainEl);

      const overlay = document.createElement("div");
      overlay.setAttribute("data-vv-overlay", "true");
      overlay.setAttribute("aria-hidden", "true");
      const handlesBox = document.createElement("div");
      handlesBox.className = "vv-handles";
      handlesBox.style.display = "none";
      const corners = [
        ["nw", "0%", "0%", "nwse-resize"],
        ["ne", "100%", "0%", "nesw-resize"],
        ["sw", "0%", "100%", "nesw-resize"],
        ["se", "100%", "100%", "nwse-resize"],
      ];
      for (const [corner, left, top, cursor] of corners) {
        const h = document.createElement("div");
        h.className = "vv-handle";
        h.setAttribute("data-corner", corner);
        h.style.left = left;
        h.style.top = top;
        h.style.cursor = cursor;
        handlesBox.appendChild(h);
      }
      overlay.appendChild(handlesBox);
      board.appendChild(overlay);

      const palettes = new Set(["workbench", "brutalist-red", "newsprint", "blueprint"]);
      const filters = new Set(["none", "torn-paper", "sticker-cutout", "halftone", "grain", "shadow"]);
      const flips = new Set(["none", "x", "y", "xy"]);
      const hiddenTags = new Set(["HEAD", "SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT", "TEXTAREA", "TITLE", "DEFS", "VV-ASSETS"]);
      const num = (el, k, def) => {
        const raw = el.getAttribute(k);
        if (raw === null || raw.trim() === "") return def;
        const n = Number(raw);
        return Number.isFinite(n) ? n : def;
      };
      const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
      const round2 = (n) => {
        const r = Math.round(n * 100) / 100;
        return r === 0 ? 0 : r;
      };
      const paletteVal = (b) => {
        const p = b.getAttribute("palette");
        return palettes.has(p) ? p : "workbench";
      };
      const flipVal = (el) => {
        const f = el.getAttribute("flip");
        return flips.has(f) ? f : "none";
      };
      const filterVal = (el) => {
        const f = el.getAttribute("filter");
        return filters.has(f) ? f : "none";
      };
      const boardSize = () => ({
        bw: Math.max(1, num(board, "width", 1200)),
        bh: Math.max(1, num(board, "height", 1600)),
      });
      const allNodes = () => Array.from(board.querySelectorAll("vv-group, vv-layer"));
      const allLayers = () => Array.from(board.querySelectorAll("vv-layer"));
      const findTarget = (id) => allNodes().find((el) => el.getAttribute("id") === id);
      const boardOffset = (el) => {
        let ox = 0;
        let oy = 0;
        for (let p = el.parentElement; p && p !== board; p = p.parentElement) {
          if (p.tagName.toLowerCase() === "vv-group") {
            ox += num(p, "x", 0);
            oy += num(p, "y", 0);
          }
        }
        return { ox, oy };
      };
      const isVisible = (el) => !el.hasAttribute("hidden") && !el.closest("vv-group[hidden]");
      const textNodesOf = (el) => {
        const out = [];
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
          acceptNode: (n) => {
            if (!n.data || n.data.trim() === "") return NodeFilter.FILTER_REJECT;
            for (let p = n.parentElement; p && p !== el; p = p.parentElement) {
              if (hiddenTags.has(p.tagName) || (p.classList && p.classList.contains("vv-asset-clone"))) return NodeFilter.FILTER_REJECT;
            }
            return NodeFilter.FILTER_ACCEPT;
          },
        });
        for (let n = walker.nextNode(); n; n = walker.nextNode()) out.push(n);
        return out;
      };
      const trackedTextNodes = (el) => {
        if (!el.__vvOrigTextNodes) el.__vvOrigTextNodes = textNodesOf(el);
        return el.__vvOrigTextNodes.filter((n) => el.contains(n));
      };
      const layerTextOf = (el) => {
        if (el.tagName.toLowerCase() === "vv-group") return "";
        const nodes = trackedTextNodes(el);
        if (nodes.length === 0) return "";
        return nodes
          .map((n) => (n.data || "").replace(/\s+/g, " ").trim())
          .join("\n")
          .replace(/\n+$/g, "")
          .slice(0, 50000);
      };

      const cloneAssets = () => {
        const assetMap = new Map();
        for (const el of document.querySelectorAll("vv-assets [id]")) {
          if (el.id) assetMap.set(el.id, el);
        }
        for (const layer of allLayers()) {
          const assetId = (layer.getAttribute("asset") || "").trim();
          if (!assetId || layer.querySelector(".vv-asset-clone")) continue;
          const src = assetMap.get(assetId) || (() => {
            const byId = document.getElementById(assetId);
            return byId && !byId.closest("vv-board") ? byId : null;
          })();
          if (!src) continue;
          const clone = src.cloneNode(true);
          clone.removeAttribute("id");
          clone.classList.add("vv-asset-clone");
          clone.style.width = "100%";
          clone.style.height = "100%";
          clone.style.objectFit = "contain";
          clone.style.display = "block";
          clone.style.pointerEvents = "none";
          layer.prepend(clone);
        }
      };

      let selectedId = null;
      let scale = 1;
      let latestIssues = [];

      const syncSelection = () => {
        for (const el of allNodes()) {
          const id = el.getAttribute("id");
          if (selectedId && id === selectedId) el.setAttribute("data-vv-selected", "true");
          else el.removeAttribute("data-vv-selected");
        }
        const sel = selectedId ? findTarget(selectedId) : null;
        if (!sel || sel.hasAttribute("locked") || !isVisible(sel)) {
          handlesBox.style.display = "none";
          return;
        }
        const { ox, oy } = boardOffset(sel);
        const x = ox + num(sel, "x", 0);
        const y = oy + num(sel, "y", 0);
        const w = Math.max(0, num(sel, "w", sel.offsetWidth || 0));
        const h = Math.max(0, num(sel, "h", sel.offsetHeight || 0));
        handlesBox.style.display = "block";
        handlesBox.style.left = x + "px";
        handlesBox.style.top = y + "px";
        handlesBox.style.width = w + "px";
        handlesBox.style.height = h + "px";
      };

        const renderEdges = () => {
          const edges = Array.from(board.querySelectorAll("vv-edge"));
          let svg = board.querySelector("svg.vv-edges");
          if (edges.length === 0) {
            if (svg) svg.remove();
            return;
          }
          const { bw, bh } = boardSize();
          if (!svg) {
            svg = document.createElementNS(svgNS, "svg");
            svg.setAttribute("class", "vv-edges");
            svg.setAttribute("aria-hidden", "true");
            board.insertBefore(svg, overlay);
          }
          svg.setAttribute("viewBox", "0 0 " + bw + " " + bh);
          svg.innerHTML =
            '<defs><marker id="vv-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 1 1 L 9 5 L 1 9 z" fill="var(--vv-canvas-accent, var(--vv-accent, #4d7a2a))"/></marker></defs>';
          const boxOf = (el) => {
            const { ox, oy } = boardOffset(el);
            const x = ox + num(el, "x", 0);
            const y = oy + num(el, "y", 0);
            const w = Math.max(24, num(el, "w", el.offsetWidth || 24));
            const h = Math.max(24, num(el, "h", el.offsetHeight || 24));
            return { x, y, w, h, cx: x + w / 2, cy: y + h / 2 };
          };
          for (const edge of edges) {
            const fromId = edge.getAttribute("from");
            const toId = edge.getAttribute("to");
            if (!fromId || !toId) continue;
            const fromEl = findTarget(fromId);
            const toEl = findTarget(toId);
            if (!fromEl || !toEl || !isVisible(fromEl) || !isVisible(toEl)) continue;
            const a = boxOf(fromEl);
            const b = boxOf(toEl);
            const dx = b.cx - a.cx;
            const dy = b.cy - a.cy;
            let sx, sy, ex, ey, c1x, c1y, c2x, c2y;
            if (Math.abs(dx) >= Math.abs(dy)) {
              const right = dx >= 0;
              sx = right ? a.x + a.w : a.x;
              sy = a.cy;
              ex = right ? b.x : b.x + b.w;
              ey = b.cy;
              const offset = Math.max(48, Math.abs(ex - sx) * 0.45);
              c1x = sx + (right ? offset : -offset);
              c1y = sy;
              c2x = ex + (right ? -offset : offset);
              c2y = ey;
            } else {
              const down = dy >= 0;
              sx = a.cx;
              sy = down ? a.y + a.h : a.y;
              ex = b.cx;
              ey = down ? b.y : b.y + b.h;
              const offset = Math.max(48, Math.abs(ey - sy) * 0.45);
              c1x = sx;
              c1y = sy + (down ? offset : -offset);
              c2x = ex;
              c2y = ey + (down ? -offset : offset);
            }
            const path = document.createElementNS(svgNS, "path");
            path.setAttribute("d", "M " + sx + " " + sy + " C " + c1x + " " + c1y + ", " + c2x + " " + c2y + ", " + ex + " " + ey);
            path.setAttribute("fill", "none");
            path.setAttribute("stroke", "var(--vv-canvas-accent, var(--vv-accent, #4d7a2a))");
            path.setAttribute("stroke-width", "2.5");
            if (edge.getAttribute("data-style") === "dashed") path.setAttribute("stroke-dasharray", "7 5");
            path.setAttribute("marker-end", "url(#vv-arrow)");
            svg.appendChild(path);

            const label = (edge.getAttribute("label") || "").trim();
            if (label !== "") {
              const mx = 0.125 * sx + 0.375 * c1x + 0.375 * c2x + 0.125 * ex;
              const my = 0.125 * sy + 0.375 * c1y + 0.375 * c2y + 0.125 * ey;
              const estW = Math.max(44, label.length * 9 + 18);
              const rect = document.createElementNS(svgNS, "rect");
              rect.setAttribute("x", String(mx - estW / 2));
              rect.setAttribute("y", String(my - 12));
              rect.setAttribute("width", String(estW));
              rect.setAttribute("height", "24");
              rect.setAttribute("rx", "12");
              rect.setAttribute("fill", "var(--vv-canvas-surface, #fffdf8)");
              rect.setAttribute("stroke", "var(--vv-canvas-border, #1c261c)");
              rect.setAttribute("stroke-width", "1.5");
              svg.appendChild(rect);
              const text = document.createElementNS(svgNS, "text");
              text.setAttribute("x", String(mx));
              text.setAttribute("y", String(my + 4));
              text.setAttribute("text-anchor", "middle");
              text.setAttribute("fill", "var(--vv-canvas-ink, #1c261c)");
              text.setAttribute("font-size", "12");
              text.setAttribute("font-weight", "600");
              text.textContent = label;
              svg.appendChild(text);
            }
          }
        };

        const syncLayout = () => {
        const { bw, bh } = boardSize();
        board.style.width = bw + "px";
        board.style.height = bh + "px";
        scale = Math.min((innerWidth - 32) / bw, (innerHeight - 32) / bh, 1.5);
        if (!Number.isFinite(scale) || scale <= 0) scale = 0.25;
        board.style.transform = "scale(" + scale + ")";
        const grain = clamp(num(board, "grain", 0), 0, 1);
        if (grain > 0) {
          grainEl.style.display = "block";
          grainEl.style.opacity = String(grain);
        } else {
          grainEl.style.display = "none";
        }
        for (const el of allNodes()) {
          const x = num(el, "x", 0);
          const y = num(el, "y", 0);
          const hasW = el.hasAttribute("w");
          const hasH = el.hasAttribute("h");
          const w = Math.max(0, num(el, "w", 0));
          const h = Math.max(0, num(el, "h", 0));
          const rotate = num(el, "rotate", 0);
          const z = num(el, "z", 0);
          const opacity = clamp(num(el, "opacity", 1), 0, 1);
          const flip = flipVal(el);
          el.style.left = x + "px";
          el.style.top = y + "px";
          if (hasW) el.style.width = w + "px";
          if (hasH) el.style.height = h + "px";
          el.style.zIndex = String(z);
          el.style.opacity = String(opacity);
          const sx = flip === "x" || flip === "xy" ? -1 : 1;
          const sy = flip === "y" || flip === "xy" ? -1 : 1;
          const tf = [];
          if (rotate !== 0) tf.push("rotate(" + rotate + "deg)");
          if (sx !== 1 || sy !== 1) tf.push("scale(" + sx + "," + sy + ")");
          el.style.transform = tf.length > 0 ? tf.join(" ") : "none";
        }
        renderEdges();
        syncSelection();
      };

      const inspectCanvas = () => {
        const { bw, bh } = boardSize();
        const bRect = board.getBoundingClientRect();
        const effScale = bRect.width > 0 ? bRect.width / bw : scale;
        const toBoardBox = (r) => ({
          x: (r.left - bRect.left) / effScale,
          y: (r.top - bRect.top) / effScale,
          w: r.width / effScale,
          h: r.height / effScale,
        });
        const entries = [];
        for (const el of allLayers()) {
          el.removeAttribute("data-vv-issue");
          const id = (el.getAttribute("id") || "").trim();
          if (!id || !isVisible(el)) continue;
          const { ox, oy } = boardOffset(el);
          const x = num(el, "x", 0);
          const y = num(el, "y", 0);
          const w = Math.max(0, num(el, "w", el.offsetWidth || 0));
          const h = Math.max(0, num(el, "h", el.offsetHeight || 0));
          const ax = ox + x;
          const ay = oy + y;
          const z = num(el, "z", 0);
          const tNodes = textNodesOf(el);
          const hasText = tNodes.length > 0;
          const isFigure = el.hasAttribute("asset") || Boolean(el.querySelector("img, svg"));
          const bleed = el.hasAttribute("bleed");
          const allowOverlap = el.hasAttribute("allow-overlap");
          entries.push({ el, id, ax, ay, w, h, z, tNodes, hasText, isFigure, bleed, allowOverlap });
        }

        const issues = [];
        const charBoxesFor = (entry) => {
          if (!entry.hasText || bRect.width <= 0) return [{ x: entry.ax, y: entry.ay, w: entry.w, h: entry.h }];
          const boxes = [];
          for (const tn of entry.tNodes) {
            const range = document.createRange();
            range.selectNodeContents(tn);
            for (const cr of Array.from(range.getClientRects())) {
              if (cr.width > 0 && cr.height > 0) boxes.push(toBoardBox(cr));
            }
          }
          return boxes.length > 0 ? boxes : [{ x: entry.ax, y: entry.ay, w: entry.w, h: entry.h }];
        };

        for (const e of entries) {
          if (!e.bleed && e.w > 0 && e.h > 0 && (e.ax < -0.5 || e.ay < -0.5 || e.ax + e.w > bw + 0.5 || e.ay + e.h > bh + 0.5)) {
            issues.push({
              kind: "bounds",
              layerId: e.id,
              message: "Layer " + e.id + " extends beyond board (" + Math.round(e.ax) + "," + Math.round(e.ay) + " " + Math.round(e.w) + "x" + Math.round(e.h) + ")",
            });
          }
          if (e.hasText && (e.el.clientHeight > 0 || e.el.clientWidth > 0) && (e.el.scrollHeight > e.el.clientHeight + 4 || e.el.scrollWidth > e.el.clientWidth + 4)) {
            issues.push({
              kind: "overflow",
              layerId: e.id,
              message: "Text in layer " + e.id + " overflows (" + e.el.scrollWidth + "x" + e.el.scrollHeight + " > " + e.el.clientWidth + "x" + e.el.clientHeight + ")",
            });
          }
        }

        for (let i = 0; i < entries.length; i++) {
          const a = entries[i];
          if (a.bleed || a.allowOverlap || a.z < 0) continue;
          for (let j = i + 1; j < entries.length; j++) {
            const b = entries[j];
            if (b.bleed || b.allowOverlap || b.z < 0) continue;
            const relevant = (a.hasText && b.hasText) || (a.isFigure && b.hasText) || (a.hasText && b.isFigure);
            if (!relevant) continue;
            const boxesA = a.hasText ? charBoxesFor(a) : [{ x: a.ax, y: a.ay, w: a.w, h: a.h }];
            const boxesB = b.hasText ? charBoxesFor(b) : [{ x: b.ax, y: b.ay, w: b.w, h: b.h }];
            let maxOverlap = 0;
            for (const ra of boxesA) {
              for (const rb of boxesB) {
                const ix = Math.max(0, Math.min(ra.x + ra.w, rb.x + rb.w) - Math.max(ra.x, rb.x));
                const iy = Math.max(0, Math.min(ra.y + ra.h, rb.y + rb.h) - Math.max(ra.y, rb.y));
                const ov = Math.min(ix, iy);
                if (ov > maxOverlap) maxOverlap = ov;
              }
            }
            if (maxOverlap > 8) {
              issues.push({
                kind: "collision",
                layerId: b.id,
                otherLayerId: a.id,
                message: "Layer " + b.id + " overlaps " + a.id + " by " + Math.round(maxOverlap) + "px",
              });
            }
          }
        }

        for (const issue of issues) {
          const target = findTarget(issue.layerId);
          if (target) target.setAttribute("data-vv-issue", "true");
        }
        latestIssues = issues.slice(0, 500);
        return latestIssues;
      };

      const getState = () => {
        const { bw, bh } = boardSize();
        const layers = [];
        for (const el of allNodes()) {
          if (layers.length >= 500) break;
          const id = (el.getAttribute("id") || "").slice(0, 200);
          layers.push({
            id,
            name: (el.getAttribute("name") || id).slice(0, 500),
            kind: el.tagName.toLowerCase() === "vv-group" ? "group" : "layer",
            x: num(el, "x", 0),
            y: num(el, "y", 0),
            w: Math.max(0, num(el, "w", el.offsetWidth || 0)),
            h: Math.max(0, num(el, "h", el.offsetHeight || 0)),
            rotate: clamp(num(el, "rotate", 0), -3600, 3600),
            z: num(el, "z", 0),
            opacity: clamp(num(el, "opacity", 1), 0, 1),
            flip: flipVal(el),
            filter: filterVal(el),
            locked: el.hasAttribute("locked"),
            hidden: el.hasAttribute("hidden"),
            hasAsset: el.hasAttribute("asset"),
            text: layerTextOf(el),
          });
        }
        const activeSelected = selectedId && findTarget(selectedId) ? selectedId : null;
        return {
          width: bw,
          height: bh,
          palette: paletteVal(board),
          grain: clamp(num(board, "grain", 0), 0, 1),
          selectedId: activeSelected,
          layers,
          issues: latestIssues,
        };
      };

      const reportState = (kind) => {
        const canvas = getState();
        say({ kind, body: kind === "ready" ? { display: mode, canvas } : { canvas } });
      };

      const applyPatch = (p) => {
        if (!p || typeof p.id !== "string") return;
        const target = findTarget(p.id);
        if (!target) return;
        for (const k of ["x", "y", "w", "h", "rotate", "z", "opacity"]) {
          if (typeof p[k] === "number" && Number.isFinite(p[k])) target.setAttribute(k, String(round2(p[k])));
        }
        if (typeof p.flip === "string" && flips.has(p.flip)) {
          if (p.flip === "none") target.removeAttribute("flip");
          else target.setAttribute("flip", p.flip);
        }
        if (typeof p.filter === "string" && filters.has(p.filter)) {
          if (p.filter === "none") target.removeAttribute("filter");
          else target.setAttribute("filter", p.filter);
        }
        if (typeof p.locked === "boolean") {
          if (p.locked) target.setAttribute("locked", "");
          else target.removeAttribute("locked");
        }
        if (typeof p.hidden === "boolean") {
          if (p.hidden) target.setAttribute("hidden", "");
          else target.removeAttribute("hidden");
        }
        if (typeof p.text === "string" && target.tagName.toLowerCase() !== "vv-group") {
          const tNodes = trackedTextNodes(target);
          if (tNodes.length === 1) {
            tNodes[0].data = p.text;
          } else if (tNodes.length > 1) {
            const lines = p.text.split("\n");
            for (let ti = 0; ti < tNodes.length; ti++) {
              tNodes[ti].data = ti < lines.length ? lines[ti] : "";
            }
          } else if (!target.querySelector("*")) {
            target.textContent = p.text;
          }
        }
      };

      commands.selectLayer = (d) => {
        selectedId = typeof d.id === "string" ? d.id : null;
        syncSelection();
        reportState("at");
      };

      commands.patchLayer = (d) => {
        applyPatch(d.patch);
        syncLayout();
        inspectCanvas();
        reportState("at");
      };

      commands.setBoard = (d) => {
        if (d.board && typeof d.board === "object") {
          if (typeof d.board.palette === "string" && palettes.has(d.board.palette)) board.setAttribute("palette", d.board.palette);
          if (typeof d.board.grain === "number" && Number.isFinite(d.board.grain)) board.setAttribute("grain", String(clamp(d.board.grain, 0, 1)));
        }
        syncLayout();
        inspectCanvas();
        reportState("at");
      };

      commands.autoFix = () => {
        const margin = 24;
        for (let pass = 0; pass < 3; pass++) {
          const issues = inspectCanvas();
          if (issues.length === 0) break;
          const { bw, bh } = boardSize();
          for (const issue of issues) {
            const el = findTarget(issue.layerId);
            if (!el) continue;
            if (issue.kind === "overflow") {
              const nextH = Math.ceil(Math.max(num(el, "h", 0), el.scrollHeight + 12));
              el.setAttribute("h", String(nextH));
            } else if (issue.kind === "bounds" && !el.hasAttribute("locked")) {
              const { ox, oy } = boardOffset(el);
              let w = Math.max(24, num(el, "w", el.offsetWidth || 24));
              let h = Math.max(24, num(el, "h", el.offsetHeight || 24));
              if (bw > margin * 2 && w > bw - margin * 2) {
                w = bw - margin * 2;
                el.setAttribute("w", String(round2(w)));
              }
              if (bh > margin * 2 && h > bh - margin * 2) {
                h = bh - margin * 2;
                el.setAttribute("h", String(round2(h)));
              }
              const ax = clamp(ox + num(el, "x", 0), margin, Math.max(margin, bw - margin - w));
              const ay = clamp(oy + num(el, "y", 0), margin, Math.max(margin, bh - margin - h));
              el.setAttribute("x", String(round2(ax - ox)));
              el.setAttribute("y", String(round2(ay - oy)));
            } else if (issue.kind === "collision" && issue.otherLayerId) {
              const other = findTarget(issue.otherLayerId);
              if (!other) continue;
              const elFig = (el.hasAttribute("asset") || Boolean(el.querySelector("img, svg"))) && textNodesOf(el).length === 0;
              const otherFig = (other.hasAttribute("asset") || Boolean(other.querySelector("img, svg"))) && textNodesOf(other).length === 0;
              const mover = otherFig && !elFig && !other.hasAttribute("locked") ? other : !el.hasAttribute("locked") ? el : !other.hasAttribute("locked") ? other : null;
              if (!mover) continue;
              const anchor = mover === el ? other : el;
              const mo = boardOffset(mover);
              const ao = boardOffset(anchor);
              const mx = mo.ox + num(mover, "x", 0);
              const my = mo.oy + num(mover, "y", 0);
              const mw = Math.max(24, num(mover, "w", mover.offsetWidth || 24));
              const mh = Math.max(24, num(mover, "h", mover.offsetHeight || 24));
              const ax = ao.ox + num(anchor, "x", 0);
              const ay = ao.oy + num(anchor, "y", 0);
              const aw = Math.max(24, num(anchor, "w", anchor.offsetWidth || 24));
              const ah = Math.max(24, num(anchor, "h", anchor.offsetHeight || 24));
              const ix = Math.max(0, Math.min(mx + mw, ax + aw) - Math.max(mx, ax));
              const iy = Math.max(0, Math.min(my + mh, ay + ah) - Math.max(my, ay));
              if (ix === 0 || iy === 0) continue;
              let nextX = mx;
              let nextY = my;
              const pad = 20;
              if (iy <= ix) {
                const downY = ay + ah + pad;
                const upY = ay - mh - pad;
                if (my + mh / 2 >= ay + ah / 2) nextY = downY + mh <= bh - margin ? downY : upY >= margin ? upY : clamp(downY, margin, Math.max(margin, bh - margin - mh));
                else nextY = upY >= margin ? upY : downY + mh <= bh - margin ? downY : clamp(upY, margin, Math.max(margin, bh - margin - mh));
              } else {
                const rightX = ax + aw + pad;
                const leftX = ax - mw - pad;
                if (mx + mw / 2 >= ax + aw / 2) nextX = rightX + mw <= bw - margin ? rightX : leftX >= margin ? leftX : clamp(rightX, margin, Math.max(margin, bw - margin - mw));
                else nextX = leftX >= margin ? leftX : rightX + mw <= bw - margin ? rightX : clamp(leftX, margin, Math.max(margin, bw - margin - mw));
              }
              mover.setAttribute("x", String(round2(clamp(nextX, margin, Math.max(margin, bw - margin - mw)) - mo.ox)));
              mover.setAttribute("y", String(round2(clamp(nextY, margin, Math.max(margin, bh - margin - mh)) - mo.oy)));
            }
          }
          syncLayout();
        }
        syncLayout();
        inspectCanvas();
        reportState("at");
      };

      commands.exportSvg = () => {
        const { bw, bh } = boardSize();
        const clone = board.cloneNode(true);
        for (const extra of clone.querySelectorAll("[data-vv-overlay]")) extra.remove();
        for (const n of clone.querySelectorAll("[data-vv-selected], [data-vv-issue]")) {
          n.removeAttribute("data-vv-selected");
          n.removeAttribute("data-vv-issue");
        }
        clone.style.transform = "none";
        clone.style.boxShadow = "none";
        const styleCss = Array.from(document.querySelectorAll("style"))
          .map((s) => s.textContent || "")
          .join("\n");
        const defsHtml = defsSvg.innerHTML;
        const boardHtml = new XMLSerializer().serializeToString(clone);
        const svgDoc =
          '<svg xmlns="' +
          svgNS +
          '" width="' +
          bw +
          '" height="' +
          bh +
          '" viewBox="0 0 ' +
          bw +
          " " +
          bh +
          '">' +
          defsHtml +
          '<foreignObject x="0" y="0" width="' +
          bw +
          '" height="' +
          bh +
          '"><div xmlns="http://www.w3.org/1999/xhtml" style="width:' +
          bw +
          "px;height:" +
          bh +
          'px;margin:0;overflow:hidden"><style>' +
          styleCss.replaceAll("</style>", "<\\/style>") +
          "</style>" +
          boardHtml +
          "</div></foreignObject></svg>";
        const blob = new Blob([svgDoc], { type: "image/svg+xml;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = "poster.svg";
        (document.body || document.documentElement).appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      };

      let drag = null;
      board.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        const target = e.target;
        if (!target || !target.closest) return;
        if (target.closest("[contenteditable='true']")) return;
        const handle = target.closest(".vv-handle");
        if (handle && selectedId) {
          const sel = findTarget(selectedId);
          if (!sel || sel.hasAttribute("locked")) return;
          e.preventDefault();
          drag = {
            kind: "resize",
            el: sel,
            corner: handle.getAttribute("data-corner") || "se",
            startX: e.clientX,
            startY: e.clientY,
            origX: num(sel, "x", 0),
            origY: num(sel, "y", 0),
            origW: Math.max(24, num(sel, "w", sel.offsetWidth || 24)),
            origH: Math.max(24, num(sel, "h", sel.offsetHeight || 24)),
            moved: false,
            selectionChanged: false,
          };
          return;
        }
        const layer = target.closest("vv-layer");
        if (!layer) {
          if (selectedId !== null) {
            selectedId = null;
            syncSelection();
            reportState("at");
          }
          return;
        }
        const id = layer.getAttribute("id") || null;
        if (!id) return;
        const selectionChanged = selectedId !== id;
        selectedId = id;
        syncSelection();
        if (layer.hasAttribute("locked")) {
          if (selectionChanged) reportState("at");
          return;
        }
        const { ox, oy } = boardOffset(layer);
        drag = {
          kind: "move",
          el: layer,
          startX: e.clientX,
          startY: e.clientY,
          origX: num(layer, "x", 0),
          origY: num(layer, "y", 0),
          w: Math.max(0, num(layer, "w", layer.offsetWidth || 0)),
          h: Math.max(0, num(layer, "h", layer.offsetHeight || 0)),
          ox,
          oy,
          moved: false,
          selectionChanged,
        };
      });

      addEventListener("pointermove", (e) => {
        if (!drag) return;
        const dx = (e.clientX - drag.startX) / scale;
        const dy = (e.clientY - drag.startY) / scale;
        if (!drag.moved && Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) <= 2) return;
        drag.moved = true;
        const { bw, bh } = boardSize();
        if (drag.kind === "move") {
          let ax = drag.ox + drag.origX + dx;
          let ay = drag.oy + drag.origY + dy;
          const snap = 6;
          for (const sx of [0, (bw - drag.w) / 2, bw - drag.w]) {
            if (Math.abs(ax - sx) <= snap) {
              ax = sx;
              break;
            }
          }
          for (const sy of [0, (bh - drag.h) / 2, bh - drag.h]) {
            if (Math.abs(ay - sy) <= snap) {
              ay = sy;
              break;
            }
          }
          drag.el.setAttribute("x", String(round2(ax - drag.ox)));
          drag.el.setAttribute("y", String(round2(ay - drag.oy)));
        } else {
          let x = drag.origX;
          let y = drag.origY;
          let w = drag.origW;
          let h = drag.origH;
          if (drag.corner.includes("e")) w = Math.max(24, drag.origW + dx);
          if (drag.corner.includes("s")) h = Math.max(24, drag.origH + dy);
          if (drag.corner.includes("w")) {
            const nextW = Math.max(24, drag.origW - dx);
            x = drag.origX + (drag.origW - nextW);
            w = nextW;
          }
          if (drag.corner.includes("n")) {
            const nextH = Math.max(24, drag.origH - dy);
            y = drag.origY + (drag.origH - nextH);
            h = nextH;
          }
          drag.el.setAttribute("x", String(round2(x)));
          drag.el.setAttribute("y", String(round2(y)));
          drag.el.setAttribute("w", String(round2(w)));
          drag.el.setAttribute("h", String(round2(h)));
        }
        syncLayout();
      });

      const endDrag = () => {
        if (!drag) return;
        const d = drag;
        drag = null;
        if (d.moved) {
          inspectCanvas();
          reportState("at");
        } else if (d.selectionChanged) {
          reportState("at");
        }
      };
      addEventListener("pointerup", endDrag);
      addEventListener("pointercancel", endDrag);

      board.addEventListener("dblclick", (e) => {
        const target = e.target;
        if (!target || !target.closest) return;
        const layer = target.closest("vv-layer");
        if (!layer || layer.hasAttribute("locked")) return;
        const tNodes = textNodesOf(layer);
        if (tNodes.length !== 1) return;
        const host = tNodes[0].parentElement && layer.contains(tNodes[0].parentElement) ? tNodes[0].parentElement : layer;
        host.setAttribute("contenteditable", "true");
        host.focus();
        const finish = () => {
          host.removeAttribute("contenteditable");
          syncLayout();
          inspectCanvas();
          reportState("at");
        };
        host.addEventListener("blur", finish, { once: true });
      });

      addEventListener("resize", syncLayout);
      cloneAssets();
      syncLayout();
      inspectCanvas();
      reportState("ready");
  };
  const displays = {
    page: () => say({ kind: "ready", body: { display: "page" } }),
    slides: () => {
      const all = Array.from(document.querySelectorAll("section")).filter((s) => !s.parentElement || !s.parentElement.closest("section"));
      if (all.length === 0) return displays.page();
      const root = document.documentElement;
      root.classList.add("vv-slides");
      const text = (el) => (el ? el.textContent.replace(/\s+/g, " ").trim().slice(0, 500) : "");
      const titles = all.map((s) => text(s.querySelector("h1, h2, h3")));
      const notes = all.map((s) => text(s.querySelector("aside.notes")));
      if (asked.get("print") === "1") {
        root.classList.add("vv-print");
        addEventListener("load", () => setTimeout(() => print(), 300));
        return say({ kind: "ready", body: { display: "slides", pages: all.length, titles, notes } });
      }
      const fit = () => {
        const k = Math.min(innerWidth / 1280, innerHeight / 720);
        for (const s of all) s.style.setProperty("--vv-scale", String(k));
      };
      let at = -1;
      const show = (n) => {
        const next = Math.max(0, Math.min(all.length - 1, n));
        if (next === at) return;
        at = next;
        all.forEach((s, i) => s.classList.toggle("vv-on", i === at));
        say({ kind: "at", body: { page: at } });
      };
      commands.goto = (d) => {
        if (Number.isInteger(d.page)) show(d.page);
      };
      addEventListener("resize", fit);
      fit();
      const first = Number(asked.get("at"));
      show(Number.isInteger(first) ? first : 0);
      if (asked.get("still") !== "1") {
        addEventListener("keydown", (e) => {
          if (e.target && e.target.closest && e.target.closest("input, textarea, select, [contenteditable]")) return;
          const step = { ArrowRight: 1, ArrowDown: 1, PageDown: 1, " ": 1, ArrowLeft: -1, ArrowUp: -1, PageUp: -1 }[e.key];
          if (step) {
            e.preventDefault();
            show(at + step);
          } else if (e.key === "Home") show(0);
          else if (e.key === "End") show(all.length - 1);
        });
        addEventListener("click", (e) => {
          if (e.target && e.target.closest && e.target.closest("a, button, input, textarea, select, summary, video, audio, [contenteditable]")) return;
          if (getSelection() && !getSelection().isCollapsed) return;
          show(at + (e.clientX < innerWidth / 4 ? -1 : 1));
        });
      }
      say({ kind: "ready", body: { display: "slides", pages: all.length, titles, notes } });
    },
    canvas: canvasRuntime("canvas"),
    dashboard: canvasRuntime("dashboard"),
    whiteboard: canvasRuntime("whiteboard"),
  };
  const start = () => (displays[config.display] || displays.page)();
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
}`;

// Zero-specificity :where() selectors let deck-authored CSS override defaults.
const slideStyles = String.raw`
:where(html.vv-slides),:where(html.vv-slides) :where(body){margin:0;height:100%;overflow:hidden;background:var(--vv-side);color:var(--vv-ink);font-family:var(--vv-font-sans);-webkit-font-smoothing:antialiased}
:where(html.vv-slides) :where(section){position:absolute;left:50%;top:50%;width:1280px;height:720px;box-sizing:border-box;padding:80px 112px;display:none;flex-direction:column;justify-content:center;gap:28px;background:var(--vv-page);transform:translate(-50%,-50%) scale(var(--vv-scale,1));transform-origin:center;overflow:hidden}
:where(html.vv-slides) :where(section.vv-on){display:flex}
:where(html.vv-slides) :where(section) :where(h1){margin:0;font-size:72px;line-height:1.1;font-weight:700;letter-spacing:-0.01em}
:where(html.vv-slides) :where(section) :where(h2){margin:0;font-size:48px;line-height:1.15;font-weight:650}
:where(html.vv-slides) :where(section) :where(h3){margin:0;font-size:32px;line-height:1.2;font-weight:600;color:var(--vv-muted)}
:where(html.vv-slides) :where(section) :where(p,li){margin:0;font-size:30px;line-height:1.5}
:where(html.vv-slides) :where(section) :where(ul,ol){margin:0;padding-left:1.2em;display:flex;flex-direction:column;gap:14px}
:where(html.vv-slides) :where(section) :where(li)::marker{color:var(--vv-leaf)}
:where(html.vv-slides) :where(section) :where(small,figcaption,.muted){font-size:22px;color:var(--vv-muted)}
:where(html.vv-slides) :where(section) :where(code){font-family:var(--vv-font-mono);font-size:0.9em;padding:0.1em 0.3em;border-radius:6px;background:var(--vv-line)}
:where(html.vv-slides) :where(section) :where(img,video,svg){max-width:100%;max-height:100%;border-radius:var(--vv-radius)}
:where(html.vv-slides) :where(section) :where(aside.notes){display:none}
:where(html.vv-slides) :where(section.title){align-items:flex-start;justify-content:flex-end;padding-bottom:112px}
:where(html.vv-slides) :where(section.title) :where(h1){font-size:88px}
:where(html.vv-slides) :where(section.title)::before{content:"";width:72px;height:6px;border-radius:3px;background:var(--vv-accent);margin-bottom:8px}
:where(html.vv-slides) :where(section.two-col){display:none;grid-template-columns:1fr 1fr;grid-template-rows:auto 1fr;column-gap:64px;row-gap:36px;align-content:center}
:where(html.vv-slides) :where(section.two-col.vv-on){display:grid}
:where(html.vv-slides) :where(section.two-col) > :where(h1,h2,h3){grid-column:1 / -1}
:where(html.vv-slides) :where(section.two-col) > :where(div){display:flex;flex-direction:column;gap:16px;min-width:0}
:where(html.vv-slides) :where(section.image){padding:56px;align-items:center;gap:20px}
:where(html.vv-slides) :where(section.image) :where(img,video,svg){flex:1;min-height:0;object-fit:contain}
:where(html.vv-slides) :where(section.quote){padding:96px 160px}
:where(html.vv-slides) :where(section.quote) :where(blockquote){margin:0;padding-left:40px;border-left:8px solid var(--vv-wheat);font-size:48px;line-height:1.4;font-weight:500}
:where(html.vv-slides) :where(section.quote) :where(cite,figcaption){font-style:normal;font-size:26px;color:var(--vv-muted)}
@page{size:1280px 720px;margin:0}
@media print{
  :where(html.vv-slides),:where(html.vv-slides) :where(body){height:auto;overflow:visible;background:none}
  :where(html.vv-slides) :where(section){position:relative;left:auto;top:auto;transform:none;display:flex;break-after:page;page-break-after:always}
  :where(html.vv-slides) :where(section.two-col){display:grid}
}`;

const canvasStyles = String.raw`
:where(html.vv-canvas),:where(html.vv-canvas) :where(body){margin:0;width:100%;height:100%;overflow:hidden;background:var(--vv-side);color:var(--vv-ink);font-family:var(--vv-font-sans);display:flex;align-items:center;justify-content:center;user-select:none}
vv-assets{display:none!important}
vv-board{position:relative;display:block;flex:0 0 auto;overflow:hidden;background:var(--vv-canvas-bg,var(--vv-page));color:var(--vv-canvas-ink,var(--vv-ink));box-shadow:0 18px 54px rgba(0,0,0,.38);transform-origin:center center;--vv-canvas-bg:#f7f4ec;--vv-canvas-surface:#fffdf8;--vv-canvas-ink:#1c261c;--vv-canvas-muted:#546152;--vv-canvas-accent:#4d7a2a;--vv-canvas-border:#1c261c}
vv-board[palette="workbench"]{--vv-canvas-bg:#f7f4ec;--vv-canvas-surface:#fffdf8;--vv-canvas-ink:#1c261c;--vv-canvas-muted:#546152;--vv-canvas-accent:#4d7a2a;--vv-canvas-border:#1c261c}
vv-board[palette="brutalist-red"]{--vv-canvas-bg:#111010;--vv-canvas-surface:#1c1919;--vv-canvas-ink:#f4f1ea;--vv-canvas-muted:#b5aea3;--vv-canvas-accent:#d93829;--vv-canvas-border:#f4f1ea}
vv-board[palette="newsprint"]{--vv-canvas-bg:#efe8d8;--vv-canvas-surface:#f7f2e7;--vv-canvas-ink:#1d1a16;--vv-canvas-muted:#645b4f;--vv-canvas-accent:#b6412b;--vv-canvas-border:#1d1a16}
vv-board[palette="blueprint"]{--vv-canvas-bg:#0f2544;--vv-canvas-surface:#163159;--vv-canvas-ink:#ebf4ff;--vv-canvas-muted:#9ab8e0;--vv-canvas-accent:#4ea8ff;--vv-canvas-border:#ebf4ff}
vv-group,vv-layer{position:absolute;display:block;box-sizing:border-box;transform-origin:center center}
vv-board [hidden],vv-group[hidden],vv-layer[hidden]{display:none!important}
vv-layer[filter="sticker-cutout"]{filter:drop-shadow(0 0 2px #fff) drop-shadow(0 0 2px #fff) drop-shadow(0 6px 14px rgba(0,0,0,.28))}
vv-layer[filter="torn-paper"]{filter:url(#vv-filter-torn)}
vv-layer[filter="halftone"]{filter:contrast(1.35) grayscale(.25)}
vv-layer[filter="shadow"]{filter:drop-shadow(0 12px 24px rgba(0,0,0,.32))}
vv-layer[filter="grain"]{filter:url(#vv-filter-grain)}
vv-layer[data-vv-selected]{outline:2px solid var(--vv-accent,#4d7a2a);outline-offset:2px}
vv-layer[data-vv-issue]{outline:2px dashed #e5484d;outline-offset:2px}
vv-layer[data-vv-selected][data-vv-issue]{outline:2px solid #e5484d;outline-offset:2px}
[contenteditable="true"]{user-select:text;outline:2px solid var(--vv-accent,#4d7a2a);cursor:text}
[data-vv-overlay]{position:absolute;inset:0;pointer-events:none;z-index:999999}
.vv-handles{position:absolute;pointer-events:none;box-sizing:border-box}
.vv-handle{position:absolute;width:10px;height:10px;border-radius:2px;background:#fff;border:2px solid var(--vv-accent,#4d7a2a);pointer-events:auto;box-sizing:border-box;transform:translate(-50%,-50%)}
[data-vv-grain]{position:absolute;inset:0;pointer-events:none;z-index:999998;background:rgba(128,128,128,.08);filter:url(#vv-filter-grain);mix-blend-mode:overlay}
vv-board[data-mode="whiteboard"]{background-image:radial-gradient(color-mix(in srgb,var(--vv-canvas-ink) 18%,transparent) 1.5px,transparent 1.5px);background-size:24px 24px}
vv-edge{display:none!important}
svg.vv-edges{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:1;overflow:visible}
.vv-wb-node{width:100%;height:100%;box-sizing:border-box;display:flex;flex-direction:column;justify-content:center;gap:6px;padding:14px 16px;border-radius:12px;border:2px solid var(--vv-canvas-border);background:var(--vv-canvas-surface);color:var(--vv-canvas-ink);box-shadow:0 4px 14px rgba(0,0,0,.08)}
vv-layer[data-node-kind="pill"] .vv-wb-node{border-radius:999px;text-align:center;align-items:center}
vv-layer[data-node-kind="note"] .vv-wb-node{border-radius:4px;background:color-mix(in srgb,var(--vv-wheat,#e5a93c) 24%,var(--vv-canvas-surface));border-color:color-mix(in srgb,var(--vv-wheat,#e5a93c) 65%,var(--vv-canvas-border))}
vv-layer[data-node-kind="group"] .vv-wb-node{justify-content:flex-start;border-style:dashed;background:color-mix(in srgb,var(--vv-canvas-ink) 4%,transparent);box-shadow:none}
vv-layer[data-tone="leaf"] .vv-wb-node{border-color:var(--vv-leaf,#74a046);background:color-mix(in srgb,var(--vv-leaf,#74a046) 14%,var(--vv-canvas-surface))}
vv-layer[data-tone="water"] .vv-wb-node{border-color:var(--vv-water,#2f6fa8);background:color-mix(in srgb,var(--vv-water,#2f6fa8) 14%,var(--vv-canvas-surface))}
vv-layer[data-tone="wheat"] .vv-wb-node{border-color:var(--vv-wheat,#e5a93c);background:color-mix(in srgb,var(--vv-wheat,#e5a93c) 16%,var(--vv-canvas-surface))}
vv-layer[data-tone="berry"] .vv-wb-node{border-color:var(--vv-berry,#a83a2c);background:color-mix(in srgb,var(--vv-berry,#a83a2c) 14%,var(--vv-canvas-surface))}
vv-layer[data-tone="accent"] .vv-wb-node{border-color:var(--vv-canvas-accent,#4d7a2a);background:color-mix(in srgb,var(--vv-canvas-accent,#4d7a2a) 14%,var(--vv-canvas-surface))}
.vv-wb-title{font-weight:700;font-size:16px;line-height:1.25}
.vv-wb-body{font-size:13px;line-height:1.4;color:var(--vv-canvas-muted)}
.vv-dash-card{width:100%;height:100%;box-sizing:border-box;display:flex;flex-direction:column;gap:8px;padding:18px 20px;border-radius:12px;border:1px solid color-mix(in srgb,var(--vv-canvas-ink) 14%,transparent);background:var(--vv-canvas-surface);color:var(--vv-canvas-ink)}
.vv-dash-kpi{font-size:38px;font-weight:800;line-height:1.05;letter-spacing:-0.02em;font-variant-numeric:tabular-nums}`;

const displayStyles: Record<ArtifactDisplay, string> = {
  page: "",
  slides: slideStyles,
  motion: "",
  canvas: canvasStyles,
  dashboard: canvasStyles,
  whiteboard: canvasStyles,
};

export const withShell = (shown: { readonly page: string; readonly display: ArtifactDisplay; readonly theme: ShellTheme }) => `${shown.page}
<style>:root{${themeVariables[shown.theme]}${typeVariables}}${displayStyles[shown.display]}</style>
<script>${selectionScript}</script>
<script>(${runtimeScript})({ display: "${shown.display}" })</script>
`;

/** Includes `display` and `theme` in the query string because version responses are cached immutable. */
export const shellPath = (
  id: string,
  version: number,
  display: ArtifactDisplay = "page",
  theme: ShellTheme = "light",
  more: { readonly at?: number; readonly still?: boolean; readonly print?: boolean } = {},
) =>
  `${artifactPath(id, version)}?shell=1&display=${display}&theme=${theme}${more.at === undefined ? "" : `&at=${more.at}`}${more.still === true ? "&still=1" : ""}${more.print === true ? "&print=1" : ""}`;

export const shellThemeOf = (asked: string | null): ShellTheme => (asked === "dark" ? "dark" : "light");

export const shellMessageOf = (data: unknown): HtmlShellMessage | undefined => {
  const got = S.HtmlShellMessage.safeParse(data);
  return got.success ? got.data : undefined;
};

const wordsMax = 10_000;
const contextMax = 64;

export function selectionOf(data: unknown): HtmlAnchor | undefined {
  const message = shellMessageOf(data);
  if (message?.vibevalley !== "selection") return undefined;
  const { anchor } = message;
  return anchor.exact.length > wordsMax || anchor.prefix.length > contextMax || anchor.suffix.length > contextMax ? undefined : anchor;
}
