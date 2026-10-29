import { createEffect, createSignal, For, Show } from "solid-js";
import type { AxeResults, Result } from "axe-core";

export interface Axe {
  /** What axe found; undefined while it looks. */
  readonly count: () => number | undefined;
  readonly result: () => AxeResults | undefined;
  readonly again: () => void;
}

// One run at a time: axe refuses a second while one is going.
let queue: Promise<unknown> = Promise.resolve();

export function useAxe(target: () => HTMLElement | undefined, deps: () => unknown[]): Axe {
  const [result, setResult] = createSignal<AxeResults>();
  const [tick, setTick] = createSignal(0);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = () => {
    const el = target();
    if (!el) return;
    setResult(undefined);
    queue = queue.then(async () => {
      await Promise.all(
        document
          .getAnimations()
          .filter((a) => Number.isFinite(a.effect?.getComputedTiming().endTime ?? Infinity))
          .map((a) => a.finished.catch(() => undefined)),
      );
      const { default: axe } = await import("axe-core");
      setResult(await axe.run(el, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] } }));
    });
  };
  createEffect(
    () => [tick(), ...deps()],
    () => {
      clearTimeout(timer);
      timer = setTimeout(run, 400);
      return () => clearTimeout(timer);
    },
  );
  return {
    count: () => result()?.violations.length,
    result,
    again: () => setTick((n) => n + 1),
  };
}

const impactTone: Record<string, string> = { critical: "text-berry", serious: "text-berry", moderate: "text-warn-ink", minor: "text-muted" };

export function A11yPanel(props: { result: AxeResults | undefined; onAgain: () => void }) {
  return (
    <section data-testid="story-a11y-panel" aria-label="Accessibility" class="max-h-64 shrink-0 overflow-y-auto border-t border-line bg-side px-4 py-3 text-xs">
      <div class="mb-2 flex items-center gap-2">
        <h2 class="font-semibold">Accessibility</h2>
        <span class="text-muted">WCAG 2 A and AA, over the frames</span>
        <span class="flex-1" />
        <button type="button" class="rounded-md border border-line px-2 py-0.5 text-muted hover:text-ink" onClick={() => props.onAgain()}>
          Check again
        </button>
      </div>
      <Show when={props.result} fallback={<p class="text-muted">Checking…</p>}>
        {(r) => (
          <Show
            when={r().violations.length > 0}
            fallback={<p class="text-muted">{`Nothing found; ${r().passes.length} rules pass, ${r().incomplete.length} need a look by eye.`}</p>}
          >
            <ul class="flex flex-col gap-2">
              <For each={r().violations}>{(v) => <Violation v={v} />}</For>
            </ul>
          </Show>
        )}
      </Show>
    </section>
  );
}

function Violation(props: { v: Result }) {
  return (
    <li data-testid="story-a11y-issue" data-key={props.v.id} class="flex flex-col gap-0.5">
      <div class="flex items-baseline gap-2">
        <span class={["font-mono", impactTone[props.v.impact ?? "minor"]]}>{props.v.impact}</span>
        <a href={props.v.helpUrl} target="_blank" rel="noreferrer" class="font-medium underline">
          {props.v.help}
        </a>
      </div>
      <For each={props.v.nodes}>{(n) => <code class="truncate font-mono text-2xs text-muted">{n.target.join(" ")}</code>}</For>
    </li>
  );
}
