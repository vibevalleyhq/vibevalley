import * as stylex from "@stylexjs/stylex";
import type { AxeResults, Result } from "axe-core";
import { createEffect, createSignal, For, Show } from "solid-js";

const styles = stylex.create({
  panel: {
    maxHeight: "calc(var(--spacing) * 64)",
    flexShrink: "0",
    overflowY: "auto",
    borderTopStyle: "solid",
    borderTopWidth: "1px",
    borderColor: "var(--color-line)",
    backgroundColor: "var(--color-side)",
    paddingInline: "calc(var(--spacing) * 4)",
    paddingBlock: "calc(var(--spacing) * 3)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
  },
  header: {
    marginBottom: "calc(var(--spacing) * 2)",
    display: "flex",
    alignItems: "center",
    gap: "calc(var(--spacing) * 2)",
  },
  heading: {
    fontWeight: "var(--font-weight-semibold)",
  },
  muted: {
    color: "var(--color-muted)",
  },
  spacer: {
    flex: "1",
  },
  rerunButton: {
    borderRadius: "var(--radius-md)",
    borderStyle: "solid",
    borderWidth: "1px",
    borderColor: "var(--color-line)",
    paddingInline: "calc(var(--spacing) * 2)",
    paddingBlock: "calc(var(--spacing) * .5)",
    color: {
      default: "var(--color-muted)",
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-ink)",
      },
    },
  },
  list: {
    display: "flex",
    flexDirection: "column",
    gap: "calc(var(--spacing) * 2)",
  },
  item: {
    display: "flex",
    flexDirection: "column",
    gap: "calc(var(--spacing) * .5)",
  },
  itemHead: {
    display: "flex",
    alignItems: "baseline",
    gap: "calc(var(--spacing) * 2)",
  },
  impact: {
    fontFamily: "var(--font-mono)",
  },
  impactSevere: {
    color: "var(--color-berry)",
  },
  impactModerate: {
    color: "var(--color-warn-ink)",
  },
  helpLink: {
    fontWeight: "var(--font-weight-medium)",
    textDecorationLine: "underline",
  },
  selector: {
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontFamily: "var(--font-mono)",
    fontSize: "var(--text-2xs)",
    lineHeight: "var(--text-2xs--line-height)",
    color: "var(--color-muted)",
  },
});

const impactTones = {
  critical: styles.impactSevere,
  serious: styles.impactSevere,
  moderate: styles.impactModerate,
  minor: styles.muted,
};

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
      await Promise.allSettled(
        document
          .getAnimations()
          .filter((a) => Number.isFinite(a.effect?.getComputedTiming().endTime ?? Infinity))
          .map((a) => a.finished),
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

export function A11yPanel(props: { result: AxeResults | undefined; onAgain: () => void }) {
  return (
    <section data-testid="story-a11y-panel" aria-label="Accessibility" {...stylex.attrs(styles.panel)}>
      <div {...stylex.attrs(styles.header)}>
        <h2 {...stylex.attrs(styles.heading)}>Accessibility</h2>
        <span {...stylex.attrs(styles.muted)}>WCAG 2 A and AA, over the frames</span>
        <span {...stylex.attrs(styles.spacer)} />
        <button type="button" {...stylex.attrs(styles.rerunButton)} onClick={() => props.onAgain()}>
          Check again
        </button>
      </div>
      <Show when={props.result} fallback={<p {...stylex.attrs(styles.muted)}>Checking…</p>}>
        {(r) => (
          <Show
            when={r().violations.length > 0}
            fallback={
              <p {...stylex.attrs(styles.muted)}>{`Nothing found; ${r().passes.length} rules pass, ${r().incomplete.length} need a look by eye.`}</p>
            }
          >
            <ul {...stylex.attrs(styles.list)}>
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
    <li data-testid="story-a11y-issue" data-key={props.v.id} {...stylex.attrs(styles.item)}>
      <div {...stylex.attrs(styles.itemHead)}>
        <span {...stylex.attrs(styles.impact, impactTones[props.v.impact ?? "minor"])}>{props.v.impact}</span>
        <a href={props.v.helpUrl} target="_blank" rel="noreferrer" {...stylex.attrs(styles.helpLink)}>
          {props.v.help}
        </a>
      </div>
      <For each={props.v.nodes}>{(n) => <code {...stylex.attrs(styles.selector)}>{n.target.join(" ")}</code>}</For>
    </li>
  );
}
