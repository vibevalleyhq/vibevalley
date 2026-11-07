import { frames } from "./frame";
import type { QueryClient } from "./query";
import { waitForReads } from "./query/activity";

/** Past this the page shows as it is: a read that hangs keeps its own loading words, not a cover. */
const longest = 2000;

const nextFrame = () => new Promise<void>((done) => requestAnimationFrame(() => done()));

function firstFrame(signal: AbortSignal) {
  return new Promise<void>((done) => {
    let stop: (() => void) | undefined;
    let over = false;
    const check = () => {
      const f = frames.get();
      if (over || (!signal.aborted && !f.frame && f.link !== "lost")) return;
      over = true;
      stop?.();
      signal.removeEventListener("abort", check);
      done();
    };
    stop = frames.subscribe(check);
    signal.addEventListener("abort", check, { once: true });
    check();
  });
}

async function pageReady(client: QueryClient, signal: AbortSignal) {
  await firstFrame(signal);
  // A place shown on the frame mounts now and starts its reads; one read's answer can start the next.
  for (let round = 0; round < 3; round++) {
    /* oxlint-disable eslint/no-await-in-loop -- frames come one after another, and one read's answer can start the next */
    await nextFrame();
    if (signal.aborted) return;
    await waitForReads(client, signal);
    /* oxlint-enable eslint/no-await-in-loop */
  }
  await Promise.all([...document.images].filter((i) => !i.complete).map((i) => i.decode().catch(() => undefined)));
}

/** Once the page has mounted: takes the cover away when the page is ready, in one fade. */
export async function reveal(client: QueryClient, signal: AbortSignal) {
  const cover = document.getElementById("opening");
  if (!cover) return;
  if (cover.dataset.look === "farm") return cover.remove();
  const timeout = new AbortController();
  const waiting = AbortSignal.any([signal, timeout.signal]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      pageReady(client, waiting),
      new Promise<void>((done) => {
        timer = setTimeout(done, longest);
        waiting.addEventListener("abort", () => done(), { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timer);
    timeout.abort();
  }
  if (signal.aborted) return;
  // What came in under the cover (a dialog opened by the address, a list's first rows) is already in: it shows where it ends, not coming in a second time.
  for (const a of document.getAnimations()) {
    const target = a.effect instanceof KeyframeEffect ? a.effect.target : null;
    if (target && cover.contains(target)) continue;
    if (Number.isFinite(a.effect?.getComputedTiming().endTime ?? Infinity)) a.finish();
  }
  cover.style.pointerEvents = "none";
  const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  await cover.animate([{ opacity: 1 }, { opacity: 0 }], { duration: still ? 0 : 180, easing: "cubic-bezier(0.2, 0, 0, 1)", fill: "forwards" }).finished;
  cover.remove();
}
