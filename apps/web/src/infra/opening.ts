import { frames } from "./frame";
import { queries } from "./query";

type Phase = "connecting" | "reading" | "loading" | "ready" | "waiting" | "failed";
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

async function limited(ms: number, run: (signal: AbortSignal) => Promise<boolean>): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

async function pageReady(report: Report, signal: AbortSignal) {
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
    if (
      !(await until(
        () => queries.isFetching() === 0,
        (check) => queries.getQueryCache().subscribe(check),
        signal,
      ))
    )
      return false;
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

export async function reveal() {
  const cover = document.getElementById("opening");
  if (!cover) return;
  const report: Report = (phase, progress) => {
    cover.dataset.phase = phase;
    if (progress !== undefined) cover.dataset.progress = String(Math.round(Math.max(Number(cover.dataset.progress ?? 0), progress)));
    cover.dispatchEvent(new Event("opening-update"));
  };
  const page = await limited(2000, (signal) => pageReady(report, signal));
  const content = await limited(15_000, (signal) => contentReady(report, signal));
  const failed =
    document.querySelector('[data-opening="failed"]') !== null ||
    queries
      .getQueryCache()
      .findAll({ type: "active" })
      .some((query) => query.state.status === "error");
  const phase = failed ? "failed" : page && content ? "ready" : "waiting";
  report(phase, phase === "ready" ? 100 : undefined);
  // Finish entrance animations underneath before uncovering the mounted page.
  for (const animation of document.getAnimations()) {
    const target = animation.effect instanceof KeyframeEffect ? animation.effect.target : null;
    if (target && cover.contains(target)) continue;
    if (Number.isFinite(animation.effect?.getComputedTiming().endTime ?? Infinity)) animation.finish();
  }
  cover.style.pointerEvents = "none";
  const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  await cover.animate([{ opacity: 1 }, { opacity: 0 }], { duration: still ? 0 : 240, easing: "cubic-bezier(0.2, 0, 0, 1)", fill: "forwards" }).finished;
  cover.remove();
}
