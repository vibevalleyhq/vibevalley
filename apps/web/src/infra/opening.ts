import type { Opening } from "@vibevalley/protocol/host";

import { frames } from "./frame";
import { currentHost } from "./host";
import type { QueryClient } from "./query";
import { waitForReads } from "./query/activity";

type Phase = Opening["phase"];
type Report = (phase: Phase, progress?: number) => void;

function until(check: () => boolean, subscribe: (check: () => void) => () => void, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  if (check()) return Promise.resolve(true);
  return new Promise((done) => {
    let stop: (() => void) | undefined;
    let finished = false;
    const finish = (ready: boolean) => {
      if (finished) return;
      finished = true;
      stop?.();
      signal.removeEventListener("abort", aborted);
      done(ready);
    };
    const aborted = () => finish(false);
    signal.addEventListener("abort", aborted, { once: true });
    stop = subscribe(() => {
      if (check()) finish(true);
    });
    if (finished) stop();
    else if (signal.aborted) aborted();
    else if (check()) finish(true);
  });
}

async function limited(ms: number, signal: AbortSignal, run: (signal: AbortSignal) => Promise<boolean>): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await run(AbortSignal.any([signal, controller.signal]));
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

async function pageReady(client: QueryClient, report: Report, signal: AbortSignal) {
  report("connecting", 10);
  if (!(await until(() => !!frames.get().frame || frames.get().link === "lost", frames.subscribe, signal)) || !frames.get().frame) return false;
  report("reading", 30);
  for (let round = 0; round < 3; round++) {
    /* oxlint-disable eslint/no-await-in-loop -- a mounted read can start another read on the next frame */
    let painted = false;
    if (
      !(await until(
        () => painted,
        (check) => {
          const frame = requestAnimationFrame(() => {
            painted = true;
            check();
          });
          return () => cancelAnimationFrame(frame);
        },
        signal,
      ))
    )
      return false;
    await waitForReads(client, signal);
    if (signal.aborted) return false;
    /* oxlint-enable eslint/no-await-in-loop */
  }
  report("loading", 50);
  const pictures = [...document.images].filter((image) => image.loading !== "lazy");
  const loaded = await until(
    () => {
      const done = pictures.filter((image) => image.complete).length;
      report("loading", pictures.length === 0 ? 70 : 50 + (20 * done) / pictures.length);
      return done === pictures.length;
    },
    (check) => {
      for (const image of pictures) {
        image.addEventListener("load", check);
        image.addEventListener("error", check);
      }
      return () => {
        for (const image of pictures) {
          image.removeEventListener("load", check);
          image.removeEventListener("error", check);
        }
      };
    },
    signal,
  );
  return loaded && pictures.every((image) => image.naturalWidth > 0);
}

async function contentReady(report: Report, signal: AbortSignal) {
  const ready = await until(
    () => {
      const pending = document.querySelectorAll<HTMLElement>('[data-opening="pending"]');
      if (pending.length === 0) return true;
      const progress = Math.min(...[...pending].map((node) => Number(node.dataset.openingProgress ?? 0)));
      report("loading", 70 + 25 * Math.max(0, Math.min(1, Number.isFinite(progress) ? progress : 0)));
      return false;
    },
    (check) => {
      const observer = new MutationObserver(check);
      observer.observe(document.getElementById("root") ?? document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["data-opening", "data-opening-progress"],
      });
      return () => observer.disconnect();
    },
    signal,
  );
  return ready && document.querySelector('[data-opening="failed"]') === null;
}

export async function reveal(client: QueryClient, signal: AbortSignal) {
  const cover = document.getElementById("opening");
  if (!cover || signal.aborted) return;
  const hosted = currentHost().opening;
  let reported = Promise.resolve();
  const report: Report = (phase, progress) => {
    cover.dataset.phase = phase;
    if (progress !== undefined) cover.dataset.progress = String(Math.round(Math.max(Number(cover.dataset.progress ?? 0), progress)));
    cover.dispatchEvent(new Event("opening-update"));
    if (hosted) {
      reported = hosted({ phase, progress: Number(cover.dataset.progress ?? 0) });
      void reported.catch((error: unknown) => console.error("vibevalley: opening progress could not reach its host:", error));
    }
  };
  const page = await limited(2000, signal, (waiting) => pageReady(client, report, waiting));
  if (signal.aborted) return;
  const content = await limited(15_000, signal, (waiting) => contentReady(report, waiting));
  if (signal.aborted) return;
  const failed = document.querySelector('[data-opening="failed"]') !== null || client.hasActiveErrors();
  const phase = failed ? "failed" : page && content ? "ready" : "waiting";
  // Finish entrance animations underneath before uncovering the mounted page.
  for (const animation of document.getAnimations()) {
    const target = animation.effect instanceof KeyframeEffect ? animation.effect.target : null;
    if (target && cover.contains(target)) continue;
    if (Number.isFinite(animation.effect?.getComputedTiming().endTime ?? Infinity)) animation.finish();
  }
  report(phase, phase === "ready" ? 100 : undefined);
  if (hosted) {
    await reported;
    cover.remove();
    return;
  }
  cover.style.pointerEvents = "none";
  const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  await cover.animate([{ opacity: 1 }, { opacity: 0 }], { duration: still ? 0 : 240, easing: "cubic-bezier(0.2, 0, 0, 1)", fill: "forwards" }).finished;
  cover.remove();
}
