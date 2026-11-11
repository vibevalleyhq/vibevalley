import * as stylex from "@stylexjs/stylex";
import { createSignal, Show, untrack } from "solid-js";

import { t } from "@vibevalley/i18n";
import { isOneOf } from "@vibevalley/protocol/rules";

import { useNow, useViewport } from "#/base/dom.tsx";
import { useRouter, useSearch } from "#/infra/router.ts";
import { PxButton, PxWindow } from "#/ui/pixel/index.ts";
import { playSound } from "#/ui/pixel/sound.ts";
import { toast } from "#/ui/toasts.ts";

import { allOf, counts, kept, newest, type TreeFilter } from "./memories";
import { type MemoryItem, mockTree, TreeStageValues } from "./mock";
import { Scene, type SceneArea, type SceneHover } from "./Scene";
import { Filters, narrowBelow, Panel, panelWidth, Tip } from "./TreePanel";

const styles = stylex.create({
  homeCorner: {
    position: "absolute",
    top: "0.75rem",
    left: "0.75rem",
  },
  hidden: {
    display: "none",
  },
  treePageFilters: {
    minWidth: "220px",
    flex: "1",
  },
  treePageDiv: {
    position: "fixed",
    inset: "0",
    overflow: "hidden",
    backgroundColor: "var(--color-ground)",
    fontFamily: "var(--font-pixel)",
    color: "var(--color-bark-900)",
    WebkitUserSelect: "none",
    userSelect: "none",
  },
  treePagePxWindow: {
    position: "absolute",
    top: "0.75rem",
    left: "0.75rem",
    paddingInline: "0.75rem",
    paddingBlock: "0.5rem",
  },
  treePageDiv2: {
    fontFamily: "var(--font-pixel)",
    fontSize: "12px",
    lineHeight: "1.4286",
    fontWeight: "var(--font-weight-normal)",
    letterSpacing: "var(--tracking-normal)",
    fontSynthesis: "none",
  },
  treePageDiv22: {
    fontFamily: "var(--font-pixel)",
    fontSize: "12px",
    lineHeight: "1.3333",
    fontWeight: "var(--font-weight-normal)",
    letterSpacing: "var(--tracking-normal)",
    color: "var(--color-bark-500)",
    fontSynthesis: "none",
  },
  treePageSpan: {
    fontFamily: "var(--font-pixel)",
    fontSize: "12px",
    lineHeight: "1.3333",
    fontWeight: "var(--font-weight-normal)",
    letterSpacing: "var(--tracking-normal)",
    fontSynthesis: "none",
  },
  treePageSpan2: {
    width: "64px",
    textAlign: "right",
    fontFamily: "var(--font-pixel)",
    fontSize: "12px",
    lineHeight: "1.3333",
    fontWeight: "var(--font-weight-normal)",
    letterSpacing: "var(--tracking-normal)",
    fontSynthesis: "none",
  },
  controls: {
    position: "absolute",
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "0.75rem",
    paddingInline: "0.75rem",
    paddingBlock: "0.5rem",
  },
  skyControls: { insetInline: "0.75rem", bottom: "0.75rem", marginInline: "auto", maxWidth: "760px" },
  narrowControls: { insetInline: "0.5rem", top: "calc(52% - 56px)" },
  groundControls: { bottom: "0.75rem", left: "0.75rem" },
  treePageDiv3: {
    position: "absolute",
    top: "0.75rem",
    right: "0.75rem",
  },
  treePageLabel: {
    display: "flex",
    minWidth: "220px",
    flex: "1",
    alignItems: "center",
    gap: "0.5rem",
  },
  treePageInput: {
    flex: "1",
    accentColor: "var(--color-leaf-500)",
  },
});

export function TreePage() {
  const router = useRouter();
  const search = useSearch();
  const view = useViewport();
  const now = useNow(60_000);
  const asked = untrack(() => Number(search().get("stage")));
  const tree = mockTree(Date.now(), isOneOf(TreeStageValues, asked) ? asked : undefined);
  const [filter, setFilter] = createSignal<TreeFilter>(allOf);
  const [sown, setSown] = createSignal<ReadonlySet<string>>(new Set(tree.items.filter((m) => m.sown === true).map((m) => m.id)));
  const [picked, setPicked] = createSignal<MemoryItem>();
  const [hover, setHover] = createSignal<SceneHover>();
  const [sky, setSky] = createSignal(false);
  const [until, setUntil] = createSignal(1);

  const agentName = (id: string) => tree.agents.find((a) => a.id === id)?.name ?? id;
  const shown = () => tree.items.filter((m) => kept(m, filter()));
  const tally = () => counts(shown());
  const waiting = () => shown().filter((m) => m.kind === "seed" && !sown().has(m.id));

  const home = () => {
    playSound("open");
    router.navigate("/farm");
  };
  const sow = (seed: MemoryItem) => {
    playSound("open");
    setSown((s) => new Set([...s, seed.id]));
    toast(t("web.tree.sown", { body: seed.body }));
  };
  const lookUp = (up: boolean) => {
    playSound("open");
    setHover(undefined);
    setSky(up);
  };

  const narrow = () => view().w < narrowBelow;
  // Where the tree stands: left of the panel, or above it on a narrow page; the whole page while looking up.
  const area = (): SceneArea => (narrow() ? { x: 0, y: 40, w: view().w, h: view().h * 0.52 - 40 } : { x: 0, y: 0, w: view().w - panelWidth - 24, h: view().h });
  const day = () => {
    const days = Math.max(1, Math.ceil((now() - tree.since) / 86_400_000));
    return Math.max(1, Math.round(days * until()));
  };

  // Drawn: the workbench's dark theme does not reach in (style.css).
  return (
    <div data-theme="light" {...stylex.attrs(styles.treePageDiv)} data-testid="memory-tree">
      <Scene
        tree={tree}
        filter={filter()}
        until={until()}
        sky={sky()}
        area={area()}
        onHover={setHover}
        onPick={(m) => {
          playSound("tap");
          setPicked(m);
        }}
      />
      <Show
        when={sky()}
        fallback={
          <Panel
            tree={tree}
            narrow={narrow()}
            filter={filter()}
            setFilter={setFilter}
            tally={tally()}
            recent={newest(shown(), 5)}
            fading={shown().filter((m) => m.fading)}
            waiting={waiting()}
            picked={picked()}
            pick={setPicked}
            unpick={() => setPicked(undefined)}
            agentName={agentName}
            now={now()}
            onSow={sow}
            onLookUp={() => lookUp(true)}
          />
        }
      >
        <PxWindow styles={[styles.treePagePxWindow]}>
          <div {...stylex.attrs(styles.treePageDiv2)}>{t("web.tree.sky")}</div>
          <div {...stylex.attrs(styles.treePageDiv22)}>{t("web.tree.skyHint")}</div>
        </PxWindow>
        <div {...stylex.attrs(styles.treePageDiv3)}>
          <PxButton icon="icon-tree" data-testid="tree-back" onClick={() => lookUp(false)}>
            {t("web.tree.back")}
          </PxButton>
        </div>
      </Show>
      <div {...stylex.attrs(styles.homeCorner, sky() && styles.hidden)}>
        <PxButton icon="icon-map" data-testid="tree-home" onClick={home}>
          {t("web.tree.farm")}
        </PxButton>
      </div>
      <PxWindow
        styles={[styles.controls, sky() ? styles.skyControls : narrow() ? styles.narrowControls : styles.groundControls]}
        style={sky() || narrow() ? undefined : { width: `${Math.min(520, area().w - 24)}px` }}
      >
        <Show when={sky()}>
          <Filters tree={tree} filter={filter()} setFilter={setFilter} styles={[styles.treePageFilters]} />
        </Show>
        <label {...stylex.attrs(styles.treePageLabel)}>
          <span {...stylex.attrs(styles.treePageSpan)}>{t("web.tree.earliest")}</span>
          <input
            type="range"
            min="0"
            max="1"
            step="0.005"
            value={until()}
            aria-label={t("web.tree.past")}
            onInput={(e) => setUntil(Number(e.currentTarget.value))}
            {...stylex.attrs(styles.treePageInput)}
          />
          <span data-testid="tree-until" data-now={until() >= 1 ? "" : undefined} {...stylex.attrs(styles.treePageSpan2)}>
            {until() >= 1 ? t("web.tree.now") : t("web.tree.day", { n: day() })}
          </span>
        </label>
      </PxWindow>
      <Show when={hover()}>{(h) => <Tip hover={h()} tree={tree} agentName={agentName} now={now()} />}</Show>
    </div>
  );
}
