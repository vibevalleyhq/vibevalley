import { type ArtifactDisplay, artifactPath, type HtmlAnchor, type HtmlShellMessage } from "@vibevalley/protocol";
import * as S from "@vibevalley/protocol/schema";

/** The workbench theme the page is shown in: the frame cannot read the workbench's own setting. */
export const ShellThemeValues = ["light", "dark"] as const;
export type ShellTheme = (typeof ShellThemeValues)[number];

// Keep in sync with --wb-* tokens in apps/web/src/style.css.
export const themeVariables: Record<ShellTheme, string> = {
  light:
    "color-scheme:light;--vv-page:#fcfcfb;--vv-side:#f6f5f3;--vv-ink:#1c1917;--vv-muted:#5e5852;--vv-faint:#716a64;--vv-line:#1c191714;--vv-accent:#4d7a2a;--vv-leaf:#74a046;--vv-wheat:#e5a93c;--vv-berry:#a83a2c;--vv-water:#2f6fa8;",
  dark: "color-scheme:dark;--vv-page:#151413;--vv-side:#1b1a18;--vv-ink:#ecebe8;--vv-muted:#a9a49e;--vv-faint:#8b867f;--vv-line:#ecebe81a;--vv-accent:#7fae4f;--vv-leaf:#8dbb5c;--vv-wheat:#e5a93c;--vv-berry:#e47d6d;--vv-water:#6aa6dc;",
};
export const typeVariables =
  '--vv-font-sans:"PingFang SC","Hiragino Sans GB","Noto Sans CJK SC","Noto Sans SC","Microsoft YaHei",system-ui,sans-serif;--vv-font-mono:Menlo,ui-monospace,monospace;--vv-radius:8px;';

export const selectionScript = String.raw`(() => {
  const hidden = new Set(["HEAD", "SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT", "TEXTAREA", "TITLE"]);
  const context = 32;
  const texts = (root) => {
    const out = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
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
    const startEl = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
    const scoped = startEl && startEl.closest ? startEl.closest("[data-entry-path]") : null;
    const root = scoped || document.body || document.documentElement;
    const nodes = texts(root);
    const whole = nodes.map((t) => t.data).join("");
    const from = indexOf(nodes, range.startContainer, range.startOffset);
    const to = indexOf(nodes, range.endContainer, range.endOffset);
    const exact = whole.slice(from, to);
    if (exact.trim() === "") return null;
    const path = scoped ? scoped.getAttribute("data-entry-path") || undefined : undefined;
    return {
      anchor: { kind: "text", exact, prefix: whole.slice(Math.max(0, from - context), from), suffix: whole.slice(to, to + context) },
      path,
    };
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
      if (found) parent.postMessage(Object.assign({ vibevalley: "selection", anchor: found.anchor }, found.path ? { path: found.path } : {}), "*");
    }, 150);
  });
})();`;

export const motionRecorderHelper = String.raw`
  const toBase64 = async (blob) => {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let out = "";
    const step = 0x8000;
    for (let i = 0; i < bytes.length; i += step) out += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
    return btoa(out);
  };
  const paintStageToCanvas = async (target, rootEl) => {
    const ctx = target.getContext("2d");
    const w = target.width;
    const h = target.height;
    const bg = getComputedStyle(rootEl || document.body || document.documentElement).backgroundColor || "#151413";
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);
    const directCanvas = (rootEl || document).querySelector("canvas:not([data-vv-recorder])");
    if (directCanvas && directCanvas.width > 0 && directCanvas.height > 0) {
      ctx.drawImage(directCanvas, 0, 0, w, h);
      return true;
    }
    const directSvg = (rootEl || document).querySelector("svg");
    if (directSvg) {
      const clone = directSvg.cloneNode(true);
      if (!clone.getAttribute("xmlns")) clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
      if (!clone.getAttribute("width")) clone.setAttribute("width", String(w));
      if (!clone.getAttribute("height")) clone.setAttribute("height", String(h));
      const xml = new XMLSerializer().serializeToString(clone);
      const img = new Image();
      await new Promise((res, rej) => {
        img.onload = res;
        img.onerror = rej;
        img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(xml);
      });
      ctx.drawImage(img, 0, 0, w, h);
      return true;
    }
    const host = rootEl || document.body;
    if (!host) return false;
    const clone = host.cloneNode(true);
    const wrapper = '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '">' +
      '<foreignObject width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml" style="width:' + w + 'px;height:' + h + 'px;overflow:hidden">' +
      new XMLSerializer().serializeToString(clone) +
      "</div></foreignObject></svg>";
    const img = new Image();
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = rej;
      img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(wrapper);
    });
    ctx.drawImage(img, 0, 0, w, h);
    return true;
  };
  const recordTimeline = async (opts) => {
    const { duration, fps, width, height, seekTo, stageEl, say } = opts;
    if (!(duration > 0) || duration > 60) {
      say({ kind: "recorded", body: { ok: false, reason: "duration-out-of-range" } });
      return;
    }
    if (typeof MediaRecorder === "undefined") {
      say({ kind: "recorded", body: { ok: false, reason: "mediarecorder-unavailable" } });
      return;
    }
    const recCanvas = document.createElement("canvas");
    recCanvas.setAttribute("data-vv-recorder", "1");
    recCanvas.width = width;
    recCanvas.height = height;
    const supportedMime = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm", "video/mp4"].find(
      (m) => typeof MediaRecorder.isTypeSupported === "function" && MediaRecorder.isTypeSupported(m),
    );
    const recorderOptions = supportedMime ? { mimeType: supportedMime, videoBitsPerSecond: 4_000_000 } : { videoBitsPerSecond: 4_000_000 };
    try {
      const stream = recCanvas.captureStream(fps);
      const track = stream.getVideoTracks()[0];
      const chunks = [];
      const recorder = new MediaRecorder(stream, recorderOptions);
      recorder.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) chunks.push(ev.data);
      };
      const done = new Promise((resolve, reject) => {
        recorder.onstop = resolve;
        recorder.onerror = (ev) => reject(ev.error || new Error("MediaRecorder failed"));
      });
      recorder.start();
      const totalFrames = Math.max(1, Math.ceil(duration * fps));
      for (let f = 0; f <= totalFrames; f++) {
        const t = Math.min(duration, f / fps);
        seekTo(t);
        await paintStageToCanvas(recCanvas, stageEl);
        if (track && typeof track.requestFrame === "function") track.requestFrame();
        await new Promise((r) => setTimeout(r, Math.max(8, Math.round(1000 / Math.min(fps, 60) / 2))));
      }
      recorder.stop();
      await done;
      const outMime = (recorder.mimeType || supportedMime || "video/webm").split(";")[0] || "video/webm";
      const blob = new Blob(chunks, { type: outMime });
      const base64 = await toBase64(blob);
      say({ kind: "recorded", body: { ok: true, mimeType: outMime, base64 } });
    } catch (err) {
      say({ kind: "recorded", body: { ok: false, reason: err instanceof Error ? err.message : String(err) } });
    }
  };
`;

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
  ${motionRecorderHelper}
  const asked = new URLSearchParams(location.search);
  let registeredMotion = null;
  window.vv = {
    timeline(durationOrTl, renderAt) {
      if (durationOrTl && typeof durationOrTl === "object" && typeof durationOrTl.duration === "function" && typeof durationOrTl.seek === "function") {
        const tl = durationOrTl;
        if (typeof tl.pause === "function") tl.pause();
        registeredMotion = {
          duration: Math.max(0.1, Number(tl.duration()) || 5),
          fps: 30,
          render: (t) => tl.seek(t),
        };
      } else {
        const d = Math.max(0.1, Number(durationOrTl) || 5);
        registeredMotion = {
          duration: d,
          fps: 30,
          render: typeof renderAt === "function" ? renderAt : () => {},
        };
      }
      if (typeof registeredMotion.boot === "function") registeredMotion.boot();
    },
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
      const fragsOf = (s) => Array.from(s.querySelectorAll(".fragment"));
      const fragments = all.map((s) => fragsOf(s).length);
      if (asked.get("print") === "1") {
        root.classList.add("vv-print");
        all.forEach((s) => fragsOf(s).forEach((f) => f.classList.add("visible")));
        addEventListener("load", () => setTimeout(() => print(), 300));
        return say({ kind: "ready", body: { display: "slides", pages: all.length, titles, notes, fragments } });
      }
      const fit = () => {
        const k = Math.min(innerWidth / 1280, innerHeight / 720);
        for (const s of all) s.style.setProperty("--vv-scale", String(k));
      };
      let at = -1;
      let frag = 0;
      const applyFragments = (slideEl, count) => {
        const list = fragsOf(slideEl);
        list.forEach((el, idx) => el.classList.toggle("visible", idx < count));
      };
      const show = (n, nextFrag) => {
        const next = Math.max(0, Math.min(all.length - 1, n));
        const maxFrag = fragments[next] || 0;
        const targetFrag = typeof nextFrag === "number" ? Math.max(0, Math.min(maxFrag, nextFrag)) : next !== at ? 0 : frag;
        if (next === at && targetFrag === frag) return;
        at = next;
        frag = targetFrag;
        all.forEach((s, i) => {
          s.classList.toggle("vv-on", i === at);
          if (i === at) applyFragments(s, frag);
        });
        say({ kind: "at", body: { page: at, fragment: frag } });
      };
      const advance = (dir) => {
        const maxFrag = fragments[at] || 0;
        if (dir > 0 && frag < maxFrag) return show(at, frag + 1);
        if (dir < 0 && frag > 0) return show(at, frag - 1);
        const nextPage = at + dir;
        if (nextPage < 0 || nextPage >= all.length) return;
        show(nextPage, dir < 0 ? fragments[nextPage] || 0 : 0);
      };
      commands.goto = (d) => {
        if (Number.isInteger(d.page)) show(d.page, Number.isInteger(d.fragment) ? d.fragment : 0);
      };
      commands.step = (d) => {
        if (typeof d.delta === "number") advance(d.delta >= 0 ? 1 : -1);
      };
      addEventListener("resize", fit);
      fit();
      const first = Number(asked.get("at"));
      show(Number.isInteger(first) ? first : 0, 0);
      if (asked.get("still") !== "1") {
        addEventListener("keydown", (e) => {
          if (e.target && e.target.closest && e.target.closest("input, textarea, select, [contenteditable]")) return;
          const step = { ArrowRight: 1, ArrowDown: 1, PageDown: 1, " ": 1, ArrowLeft: -1, ArrowUp: -1, PageUp: -1 }[e.key];
          if (step) {
            e.preventDefault();
            advance(step);
          } else if (e.key === "Home") show(0, 0);
          else if (e.key === "End") show(all.length - 1, fragments[all.length - 1] || 0);
        });
        addEventListener("click", (e) => {
          if (e.target && e.target.closest && e.target.closest("a, button, input, textarea, select, summary, video, audio, [contenteditable]")) return;
          if (getSelection() && !getSelection().isCollapsed) return;
          advance(e.clientX < innerWidth / 4 ? -1 : 1);
        });
      }
      say({ kind: "ready", body: { display: "slides", pages: all.length, titles, notes, fragments } });
    },
    motion: () => {
      let booted = false;
      const bootMotion = () => {
        if (booted || !registeredMotion) return;
        booted = true;
        const spec = registeredMotion;
        const duration = spec.duration;
        const fps = spec.fps || 30;
        let current = 0;
        let playing = false;
        let raf = 0;
        let lastTs = 0;
        const seekTo = (t, quiet) => {
          current = Math.max(0, Math.min(duration, Number(t) || 0));
          spec.render(current);
          if (!quiet) say({ kind: "at", body: { time: Math.round(current * 1000) / 1000, playing } });
        };
        const tick = (ts) => {
          if (!playing) return;
          if (!lastTs) lastTs = ts;
          const dt = Math.min(0.1, (ts - lastTs) / 1000);
          lastTs = ts;
          const next = current + dt;
          if (next >= duration) {
            playing = false;
            seekTo(duration, false);
            return;
          }
          seekTo(next, false);
          raf = requestAnimationFrame(tick);
        };
        commands.seek = (d) => {
          playing = false;
          cancelAnimationFrame(raf);
          seekTo(d.time, false);
        };
        commands.step = (d) => {
          playing = false;
          cancelAnimationFrame(raf);
          seekTo(current + (Number(d.delta) || 0) / fps, false);
        };
        commands.play = () => {
          if (playing) return;
          if (current >= duration) current = 0;
          playing = true;
          lastTs = 0;
          say({ kind: "at", body: { time: Math.round(current * 1000) / 1000, playing: true } });
          raf = requestAnimationFrame(tick);
        };
        commands.pause = () => {
          playing = false;
          cancelAnimationFrame(raf);
          say({ kind: "at", body: { time: Math.round(current * 1000) / 1000, playing: false } });
        };
        commands.record = async (d) => {
          playing = false;
          cancelAnimationFrame(raf);
          const recFps = Math.max(10, Math.min(60, Number(d.fps) || fps));
          const w = Math.max(320, Math.min(1920, innerWidth || 1280));
          const h = Math.max(240, Math.min(1080, innerHeight || 720));
          await recordTimeline({
            duration,
            fps: recFps,
            width: w,
            height: h,
            seekTo: (t) => seekTo(t, true),
            stageEl: document.body,
            say,
          });
          seekTo(current, false);
        };
        const firstAt = Number(asked.get("at"));
        seekTo(Number.isFinite(firstAt) && firstAt >= 0 ? firstAt : 0, true);
        say({ kind: "ready", body: { display: "motion", duration, fps } });
        say({ kind: "at", body: { time: current, playing: false } });
      };
      if (registeredMotion) {
        bootMotion();
      } else {
        registeredMotion = null;
        const prev = window.vv.timeline;
        window.vv.timeline = (a, b) => {
          prev(a, b);
          bootMotion();
        };
        setTimeout(() => {
          if (!booted) displays.page();
        }, 600);
      }
    },
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
:where(html.vv-slides) :where(section) :where(.fragment){opacity:0;transform:translateY(12px);transition:opacity 180ms ease,transform 180ms ease}
:where(html.vv-slides) :where(section) :where(.fragment.visible){opacity:1;transform:none}
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
  :where(html.vv-slides) :where(section) :where(.fragment){opacity:1;transform:none}
}`;

const motionStyles = String.raw`
:where(html),:where(body){margin:0;height:100%;overflow:hidden;background:var(--vv-page);color:var(--vv-ink);font-family:var(--vv-font-sans)}
`;

const displayStyles: Record<ArtifactDisplay, string> = { page: "", slides: slideStyles, motion: motionStyles };

const preloadScript = String.raw`window.__vvEarly = null; window.vv = { timeline: (a, b) => { window.__vvEarly = [a, b]; } };`;

function injectMotionPreload(page: string): string {
  if (/<head\b[^>]*>/iu.test(page)) return page.replace(/<head\b[^>]*>/iu, (m) => `${m}<script>${preloadScript}</script>`);
  if (/^<!doctype\b[^>]*>/iu.test(page)) return page.replace(/^<!doctype\b[^>]*>/iu, (m) => `${m}<script>${preloadScript}</script>`);
  return `<script>${preloadScript}</script>${page}`;
}

export const withShell = (shown: { readonly page: string; readonly display: ArtifactDisplay; readonly theme: ShellTheme }) => {
  const base = shown.display === "motion" ? injectMotionPreload(shown.page) : shown.page;
  const boot =
    shown.display === "motion"
      ? `(() => { const early = window.__vvEarly; (${runtimeScript})({ display: "motion" }); if (early) window.vv.timeline(early[0], early[1]); })()`
      : `(${runtimeScript})({ display: "${shown.display}" })`;
  return `${base}
<style>:root{${themeVariables[shown.theme]}${typeVariables}}${displayStyles[shown.display]}</style>
<script>${selectionScript}</script>
<script>${boot}</script>
`;
};

/** Includes `display` and `theme` in the query string because version responses are cached immutable. */
export const shellPath = (
  id: string,
  version: number,
  display: ArtifactDisplay = "page",
  theme: ShellTheme = "light",
  more: { readonly at?: number; readonly still?: boolean; readonly print?: boolean } = {},
) =>
  `${artifactPath(id, version)}?shell=1&display=${display}&theme=${theme}${more.at === undefined ? "" : `&at=${more.at}`}${more.still === true ? "&still=1" : ""}${more.print === true ? "&print=1" : ""}`;

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
