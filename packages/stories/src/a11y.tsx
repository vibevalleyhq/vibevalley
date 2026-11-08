import * as stylex from "@stylexjs/stylex";
import type { AxeResults, Result } from "axe-core";
import { createEffect, createSignal, For, Show } from "solid-js";

const recipeStyles = stylex.create({
  a11yPanelSection: {
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
  a11yPanelDiv: {
    marginBottom: "calc(var(--spacing) * 2)",
    display: "flex",
    alignItems: "center",
    gap: "calc(var(--spacing) * 2)",
  },
  a11yPanelH2: {
    fontWeight: "var(--font-weight-semibold)",
  },
  a11yPanelSpan: {
    color: "var(--color-muted)",
  },
  a11yPanelSpan2: {
    flex: "1",
  },
  a11yPanelButton: {
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
  a11yPanelUl: {
    display: "flex",
    flexDirection: "column",
    gap: "calc(var(--spacing) * 2)",
  },
  violationLi: {
    display: "flex",
    flexDirection: "column",
    gap: "calc(var(--spacing) * .5)",
  },
  violationDiv: {
    display: "flex",
    alignItems: "baseline",
    gap: "calc(var(--spacing) * 2)",
  },
  violationSpan: {
    fontFamily: "var(--font-mono)",
  },
  violationSpanVariant1Case1: {
    color: "var(--color-berry)",
  },
  violationSpanVariant1Case3: {
    color: "var(--color-warn-ink)",
  },
  violationA: {
    fontWeight: "var(--font-weight-medium)",
    textDecorationLine: "underline",
  },
  violationCode: {
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontFamily: "var(--font-mono)",
    fontSize: "var(--text-2xs)",
    lineHeight: "var(--text-2xs--line-height)",
    color: "var(--color-muted)",
  },
});
const recipeStylesChoices1 = {
  critical: recipeStyles.violationSpanVariant1Case1,
  serious: recipeStyles.violationSpanVariant1Case1,
  moderate: recipeStyles.violationSpanVariant1Case3,
  minor: recipeStyles.a11yPanelSpan,
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
    <section data-testid="story-a11y-panel" aria-label="Accessibility" {...stylex.attrs(recipeStyles.a11yPanelSection)}>
      <div {...stylex.attrs(recipeStyles.a11yPanelDiv)}>
        <h2 {...stylex.attrs(recipeStyles.a11yPanelH2)}>Accessibility</h2>
        <span {...stylex.attrs(recipeStyles.a11yPanelSpan)}>WCAG 2 A and AA, over the frames</span>
        <span {...stylex.attrs(recipeStyles.a11yPanelSpan2)} />
        <button type="button" {...stylex.attrs(recipeStyles.a11yPanelButton)} onClick={() => props.onAgain()}>
          Check again
        </button>
      </div>
      <Show when={props.result} fallback={<p {...stylex.attrs(recipeStyles.a11yPanelSpan)}>Checking…</p>}>
        {(r) => (
          <Show
            when={r().violations.length > 0}
            fallback={
              <p
                {...stylex.attrs(recipeStyles.a11yPanelSpan)}
              >{`Nothing found; ${r().passes.length} rules pass, ${r().incomplete.length} need a look by eye.`}</p>
            }
          >
            <ul {...stylex.attrs(recipeStyles.a11yPanelUl)}>
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
    <li data-testid="story-a11y-issue" data-key={props.v.id} {...stylex.attrs(recipeStyles.violationLi)}>
      <div {...stylex.attrs(recipeStyles.violationDiv)}>
        <span {...stylex.attrs(recipeStyles.violationSpan, recipeStylesChoices1[props.v.impact ?? "minor"])}>{props.v.impact}</span>
        <a href={props.v.helpUrl} target="_blank" rel="noreferrer" {...stylex.attrs(recipeStyles.violationA)}>
          {props.v.help}
        </a>
      </div>
      <For each={props.v.nodes}>{(n) => <code {...stylex.attrs(recipeStyles.violationCode)}>{n.target.join(" ")}</code>}</For>
    </li>
  );
}
