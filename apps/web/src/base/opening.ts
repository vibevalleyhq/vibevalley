// The cover a page starts under (public/opening.html, written into index.html) and how it goes (docs/style/design.md,
// 打开和刷新). The workbench's cover is its own ground, and it stays until the page has what it first shows: the first
// state frame, the reads its places started and their pictures. Then the page shows once, whole, instead of passing
// through an empty shell, zero counts and a dialog popping in again. The farm's cover hands over to its own bar at once.

import { frames } from "./frames";
import { queries } from "./query";

/** Past this the page shows as it is: a read that hangs keeps its own loading words, not a cover. */
const longest = 2000;

const nextFrame = () => new Promise<void>((done) => requestAnimationFrame(() => done()));

function firstFrame() {
  return new Promise<void>((done) => {
    let stop: (() => void) | undefined;
    let over = false;
    const check = () => {
      const f = frames.get();
      if (over || (!f.frame && f.link !== "lost")) return;
      over = true;
      stop?.();
      done();
    };
    stop = frames.subscribe(check);
    check();
  });
}

function readsDone() {
  return new Promise<void>((done) => {
    if (queries.isFetching() === 0) return done();
    const stop = queries.getQueryCache().subscribe(() => {
      if (queries.isFetching() > 0) return;
      stop();
      done();
    });
  });
}

async function pageReady() {
  await firstFrame();
  // A place shown on the frame mounts now and starts its reads; one read's answer can start the next.
  for (let round = 0; round < 3; round++) {
    /* oxlint-disable eslint/no-await-in-loop -- frames come one after another, and one read's answer can start the next */
    await nextFrame();
    await readsDone();
    /* oxlint-enable eslint/no-await-in-loop */
  }
  await Promise.all([...document.images].filter((i) => !i.complete).map((i) => i.decode().catch(() => undefined)));
}

/** Once the page has mounted: takes the cover away when the page is ready, in one fade. */
export async function reveal() {
  const cover = document.getElementById("opening");
  if (!cover) return;
  if (cover.dataset.look === "farm") return cover.remove();
  await Promise.race([pageReady(), new Promise((done) => setTimeout(done, longest))]);
  // What came in under the cover (a dialog opened by the address, a list's first rows) is already in: it shows where
  // it ends, not coming in a second time. Loops (the thinking dots) go on.
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
