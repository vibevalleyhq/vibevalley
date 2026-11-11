import type { JSX } from "@solidjs/web";
import * as stylex from "@stylexjs/stylex";
import { createSignal, For, Show } from "solid-js";

import { t } from "@vibevalley/i18n";

import { ago } from "#/base/format.ts";
import { PxButton, PxPick, PxWindow, SpriteIcon } from "#/ui/pixel/index.ts";
import { styleProps } from "#/ui/positioner.ts";

import { stageName, type TreeFilter } from "./memories";
import { type MemoryItem, type MemoryKind, type MemoryTree, TreeStageValues } from "./mock";
import type { SceneHover } from "./Scene";
import { type Ties, tiesOf } from "./sky";

const styles = stylex.create({
  lookUp: { marginTop: "auto", width: "100%" },
  panelPxWindow: {
    position: "absolute",
    display: "flex",
    flexDirection: "column",
    gap: "0.75rem",
    overflowY: "auto",
    padding: "1rem",
  },
  panelPxWindowPrimary: {
    top: "0.75rem",
    right: "0.75rem",
    bottom: "0.75rem",
    insetInline: null,
    height: null,
  },
  panelPxWindowSecondary: {
    top: null,
    right: null,
    bottom: "0.5rem",
    insetInline: "0.5rem",
    height: "48%",
  },
  tipPxWindow: {
    pointerEvents: "none",
    position: "fixed",
    zIndex: 40,
    width: "256px",
    paddingInline: "0.625rem",
    paddingBlock: "0.5rem",
  },
  panelH1: {
    fontFamily: "var(--font-pixel)",
    fontSize: "24px",
    lineHeight: "1.5556",
    fontWeight: "var(--font-weight-normal)",
    letterSpacing: "var(--tracking-normal)",
    fontSynthesis: "none",
  },
  panelP: {
    fontFamily: "var(--font-pixel)",
    fontSize: "12px",
    lineHeight: "1.3333",
    fontWeight: "var(--font-weight-normal)",
    letterSpacing: "var(--tracking-normal)",
    color: "var(--color-bark-500)",
    fontSynthesis: "none",
  },
  panelSpan: {
    fontFamily: "var(--font-pixel)",
    fontSize: "12px",
    lineHeight: "1.4286",
    fontWeight: "var(--font-weight-normal)",
    letterSpacing: "var(--tracking-normal)",
    fontSynthesis: "none",
  },
  panelSpan2: {
    marginLeft: "auto",
    fontFamily: "var(--font-pixel)",
    fontSize: "12px",
    lineHeight: "1.3333",
    fontWeight: "var(--font-weight-normal)",
    letterSpacing: "var(--tracking-normal)",
    color: "var(--color-bark-500)",
    fontSynthesis: "none",
  },
  panelSpan3: {
    minWidth: "0",
    flex: "1",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontFamily: "var(--font-pixel)",
    fontSize: "12px",
    lineHeight: "1.4286",
    fontWeight: "var(--font-weight-normal)",
    letterSpacing: "var(--tracking-normal)",
    fontSynthesis: "none",
  },
  panelSpan4: {
    flexShrink: "0",
    fontFamily: "var(--font-pixel)",
    fontSize: "12px",
    lineHeight: "1.3333",
    fontWeight: "var(--font-weight-normal)",
    letterSpacing: "var(--tracking-normal)",
    color: "var(--color-bark-500)",
    fontSynthesis: "none",
  },
  panelLi: {
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontFamily: "var(--font-pixel)",
    fontSize: "12px",
    lineHeight: "1.4286",
    fontWeight: "var(--font-weight-normal)",
    letterSpacing: "var(--tracking-normal)",
    fontSynthesis: "none",
  },
  panelSpan5: {
    minWidth: "0",
    flex: "1",
    fontFamily: "var(--font-pixel)",
    fontSize: "12px",
    lineHeight: "1.4286",
    fontWeight: "var(--font-weight-normal)",
    letterSpacing: "var(--tracking-normal)",
    fontSynthesis: "none",
  },
  tipSpan: {
    fontFamily: "var(--font-pixel)",
    fontSize: "12px",
    lineHeight: "1.3333",
    fontWeight: "var(--font-weight-normal)",
    letterSpacing: "var(--tracking-normal)",
    fontSynthesis: "none",
  },
  tipP: {
    marginTop: "0.25rem",
    fontFamily: "var(--font-pixel)",
    fontSize: "12px",
    lineHeight: "1.4286",
    fontWeight: "var(--font-weight-normal)",
    letterSpacing: "var(--tracking-normal)",
    fontSynthesis: "none",
  },
  tipP2: {
    marginTop: "0.25rem",
    fontFamily: "var(--font-pixel)",
    fontSize: "12px",
    lineHeight: "1.3333",
    fontWeight: "var(--font-weight-normal)",
    letterSpacing: "var(--tracking-normal)",
    color: "var(--color-bark-500)",
    fontSynthesis: "none",
  },
  tipP3: {
    marginTop: "0.125rem",
    fontFamily: "var(--font-pixel)",
    fontSize: "12px",
    lineHeight: "1.3333",
    fontWeight: "var(--font-weight-normal)",
    letterSpacing: "var(--tracking-normal)",
    color: "var(--color-leaf-700)",
    fontSynthesis: "none",
  },
  filters: { display: "flex", gap: "0.5rem" },
  panelHeader: {
    textAlign: "center",
  },
  panelDiv: {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    borderStyle: "solid",
    borderWidth: "2px",
    borderColor: "var(--color-cream-300)",
    backgroundColor: "var(--color-cream-100)",
    paddingInline: "0.5rem",
    paddingBlock: "0.375rem",
  },
  memoryCounts: {
    display: "grid",
    gridTemplateColumns: "repeat(3,minmax(0,1fr))",
    gap: "0.5rem",
  },
  panelDl: {
    display: "grid",
    gridTemplateColumns: "auto 1fr",
    columnGap: "0.75rem",
    rowGap: "0.25rem",
  },
  panelUl: {
    display: "flex",
    flexDirection: "column",
    gap: "0.25rem",
  },
  panelLi2: {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
  },
  panelUl2: {
    display: "flex",
    flexDirection: "column",
    gap: "0.5rem",
  },
  tieListDiv: {
    display: "flex",
    flexDirection: "column",
    gap: "0.125rem",
  },
  tieListButton: {
    display: "flex",
    cursor: "pointer",
    alignItems: "center",
    gap: "0.375rem",
    textAlign: "left",
    backgroundColor: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-cream-200)",
      },
    },
  },
  countDiv: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "0.375rem",
    borderStyle: "solid",
    borderWidth: "2px",
    borderColor: "var(--color-cream-300)",
    backgroundColor: "var(--color-cream-100)",
    paddingBlock: "0.375rem",
  },
  sectionSection: {
    display: "flex",
    flexDirection: "column",
    gap: "0.375rem",
    borderTopStyle: "dashed",
    borderTopWidth: "2px",
    borderStyle: "dashed",
    borderColor: "var(--color-cream-300)",
    paddingTop: "0.5rem",
  },
  sectionDiv: {
    display: "flex",
    alignItems: "center",
    gap: "0.375rem",
  },
  sectionSpan: {
    marginLeft: "auto",
  },
});

export const panelWidth = 340;
export const narrowBelow = 760;

const kindIcon: Record<MemoryKind, string> = { leaf: "icon-leaf", fruit: "icon-fruit", seed: "icon-seed" };
const kindName = (kind: MemoryKind) => t(`web.tree.kind.${kind}`);

/** A tie's words, by the kind of memory it is about: what it grew from, what grew from it, what it is used with. */
function tieWords(kind: MemoryKind, ties: Ties): string[] {
  const words: string[] = [];
  if (ties.from.length > 0) words.push(kind === "seed" ? t("web.tree.distilled", { n: ties.from.length }) : t("web.tree.noted", { n: ties.from.length }));
  if (ties.grew.length > 0) words.push(kind === "fruit" ? t("web.tree.seeds", { n: ties.grew.length }) : t("web.tree.grew", { n: ties.grew.length }));
  if (ties.together.length > 0) words.push(t("web.tree.together", { n: ties.together.length }));
  return words;
}

export function Filters(props: { tree: MemoryTree; filter: TreeFilter; setFilter: (f: TreeFilter) => void; styles?: stylex.StyleXStyles }) {
  return (
    <div {...styleProps([styles.filters, props.styles])}>
      <PxPick
        label={t("web.tree.byHelper")}
        testid="tree-by-helper"
        placeholder={t("web.tree.allHelpers")}
        clearable
        value={props.filter.agent}
        options={props.tree.agents.map((a) => ({ value: a.id, label: a.name }))}
        onChange={(agent) => props.setFilter({ ...props.filter, agent })}
      />
      <PxPick
        label={t("web.tree.byRepo")}
        testid="tree-by-repo"
        placeholder={t("web.tree.allRepos")}
        clearable
        value={props.filter.repo}
        options={props.tree.repos.map((p) => ({ value: p, label: p }))}
        onChange={(repo) => props.setFilter({ ...props.filter, repo })}
      />
    </div>
  );
}

export function Panel(props: {
  tree: MemoryTree;
  narrow: boolean;
  filter: TreeFilter;
  setFilter: (f: TreeFilter) => void;
  tally: Record<MemoryKind | "fading", number>;
  recent: readonly MemoryItem[];
  fading: readonly MemoryItem[];
  waiting: readonly MemoryItem[];
  picked: MemoryItem | undefined;
  pick: (m: MemoryItem) => void;
  unpick: () => void;
  agentName: (id: string) => string;
  now: number;
  onSow: (seed: MemoryItem) => void;
  onLookUp: () => void;
}) {
  const [showFading, setShowFading] = createSignal(false);
  const days = () => Math.max(1, Math.ceil((props.now - props.tree.since) / 86_400_000));
  // Stages count from 1: the one after stage n is at index n.
  const growth = () => {
    const next = TreeStageValues.at(props.tree.stage);
    return props.tree.nextStageIn !== undefined && next !== undefined
      ? t("web.tree.nextStage", { rounds: props.tree.nextStageIn, stage: stageName(next) })
      : t("web.tree.grown");
  };
  return (
    <PxWindow
      testid="tree-panel"
      styles={[styles.panelPxWindow, props.narrow ? styles.panelPxWindowSecondary : styles.panelPxWindowPrimary]}
      style={props.narrow ? undefined : { width: `${panelWidth}px` }}
    >
      <header {...stylex.attrs(styles.panelHeader)}>
        <h1 {...stylex.attrs(styles.panelH1)}>{t("web.tree.title")}</h1>
        <p {...stylex.attrs(styles.panelP)}>{t("web.tree.stats", { days: days(), rounds: props.tree.rounds, recalls: props.tree.recalls })}</p>
      </header>
      <div {...stylex.attrs(styles.panelDiv)}>
        <SpriteIcon name="icon-rings" size={20} />
        <span {...stylex.attrs(styles.panelSpan)}>{stageName(props.tree.stage)}</span>
        <span {...stylex.attrs(styles.panelSpan2)}>{growth()}</span>
      </div>
      <div {...stylex.attrs(styles.memoryCounts)} data-testid="memory-counts">
        <Count icon="icon-leaf" label={t("web.tree.kind.leaf")} n={props.tally.leaf} />
        <Count icon="icon-fruit" label={t("web.tree.kind.fruit")} n={props.tally.fruit} />
        <Count icon="icon-seed" label={t("web.tree.kind.seed")} n={props.tally.seed} />
      </div>
      <Filters tree={props.tree} filter={props.filter} setFilter={props.setFilter} />
      <Show when={props.picked}>
        {(m) => (
          <Section
            title={m().kind === "fruit" ? t("web.tree.experience") : kindName(m().kind)}
            icon={kindIcon[m().kind]}
            aside={<PxButton size="sm" label={t("web.tree.fold")} icon="button-close" onClick={props.unpick} />}
          >
            <p {...stylex.attrs(styles.panelP)}>
              {props.agentName(m().agent)} · {m().repo ?? t("web.tree.everyRepo")} · {ago(m().at, props.now)}
            </p>
            <Show when={m().case} fallback={<p {...stylex.attrs(styles.panelSpan)}>{m().body}</p>}>
              {(c) => (
                <dl {...stylex.attrs(styles.panelDl)}>
                  <dt {...stylex.attrs(styles.panelP)}>{t("web.tree.intent")}</dt>
                  <dd {...stylex.attrs(styles.panelSpan)}>{c().intent}</dd>
                  <dt {...stylex.attrs(styles.panelP)}>{t("web.tree.approach")}</dt>
                  <dd {...stylex.attrs(styles.panelSpan)}>{c().approach}</dd>
                  <dt {...stylex.attrs(styles.panelP)}>{t("web.tree.insight")}</dt>
                  <dd {...stylex.attrs(styles.panelSpan)}>{c().insight}</dd>
                </dl>
              )}
            </Show>
            <p {...stylex.attrs(styles.panelP)}>{t("web.tree.recalled", { n: m().recalled })}</p>
            <TieList tree={props.tree} item={m()} pick={props.pick} />
          </Section>
        )}
      </Show>
      <Section title={t("web.tree.recent")}>
        <ul {...stylex.attrs(styles.panelUl)}>
          <For each={props.recent}>
            {(m) => (
              <li {...stylex.attrs(styles.panelLi2)}>
                <SpriteIcon name={kindIcon[m.kind]} size={16} label={kindName(m.kind)} />
                <span {...stylex.attrs(styles.panelSpan3)} title={m.body}>
                  {m.body}
                </span>
                <span {...stylex.attrs(styles.panelSpan4)}>{props.agentName(m.agent)}</span>
              </li>
            )}
          </For>
        </ul>
      </Section>
      <Section
        title={t("web.tree.fading", { n: props.fading.length })}
        icon="icon-leaf-fall"
        aside={
          <Show when={props.fading.length > 0}>
            <PxButton size="sm" onClick={() => setShowFading((v) => !v)}>
              {showFading() ? t("web.tree.fold") : t("web.tree.look")}
            </PxButton>
          </Show>
        }
      >
        <Show when={showFading()} fallback={<p {...stylex.attrs(styles.panelP)}>{t("web.tree.fadingNote")}</p>}>
          <ul {...stylex.attrs(styles.panelUl)}>
            <For each={props.fading}>
              {(m) => (
                <li {...stylex.attrs(styles.panelLi)} title={m.body}>
                  {m.body}
                </li>
              )}
            </For>
          </ul>
        </Show>
      </Section>
      <Section title={t("web.tree.waiting")} icon="icon-seed-gold">
        <Show when={props.waiting.length > 0} fallback={<p {...stylex.attrs(styles.panelP)}>{t("web.tree.noSeeds")}</p>}>
          <ul {...stylex.attrs(styles.panelUl2)}>
            <For each={props.waiting}>
              {(seed) => (
                <li {...stylex.attrs(styles.panelLi2)}>
                  <SpriteIcon name="icon-seed" size={20} />
                  <span {...stylex.attrs(styles.panelSpan5)}>{seed.body}</span>
                  <PxButton size="sm" tone="primary" data-testid="tree-sow" onClick={() => props.onSow(seed)}>
                    {t("web.tree.sow")}
                  </PxButton>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </Section>
      <PxButton tone="accent" icon="icon-stars" data-testid="tree-sky" styles={styles.lookUp} onClick={props.onLookUp}>
        {t("web.tree.lookUp")}
      </PxButton>
    </PxWindow>
  );
}

/** A picked memory's ties, each a row to pick in turn: what it grew from, what grew from it, what it is used with. */
function TieList(props: { tree: MemoryTree; item: MemoryItem; pick: (m: MemoryItem) => void }) {
  const ties = () => tiesOf(props.tree.links, props.item.id);
  const find = (id: string) => props.tree.items.find((m) => m.id === id);
  const groups = () =>
    [
      { title: props.item.kind === "seed" ? t("web.tree.from") : t("web.tree.notedBy"), ids: ties().from },
      { title: props.item.kind === "fruit" ? t("web.tree.grewInto") : t("web.tree.grewTo"), ids: ties().grew },
      {
        title: t("web.tree.often"),
        ids: ties()
          .together.slice(0, 4)
          .map((t) => t.id),
      },
    ].filter((g) => g.ids.length > 0);
  return (
    <For each={groups()}>
      {(g) => (
        <div {...stylex.attrs(styles.tieListDiv)}>
          <span {...stylex.attrs(styles.panelP)}>{g.title}</span>
          <For each={g.ids}>
            {(id) => (
              <Show when={find(id)}>
                {(m) => (
                  <button type="button" onClick={() => props.pick(m())} {...stylex.attrs(styles.tieListButton)}>
                    <SpriteIcon name={kindIcon[m().kind]} size={14} />
                    <span {...stylex.attrs(styles.panelSpan3)}>{m().body}</span>
                  </button>
                )}
              </Show>
            )}
          </For>
        </div>
      )}
    </For>
  );
}

function Count(props: { icon: string; label: string; n: number }) {
  return (
    <div {...stylex.attrs(styles.countDiv)} title={props.label}>
      <SpriteIcon name={props.icon} size={20} label={props.label} />
      <span {...stylex.attrs(styles.panelSpan)}>{props.n}</span>
    </div>
  );
}

function Section(props: { title: string; icon?: string; aside?: JSX.Element; children: JSX.Element }) {
  return (
    <section {...stylex.attrs(styles.sectionSection)}>
      <div {...stylex.attrs(styles.sectionDiv)}>
        <Show when={props.icon}>{(icon) => <SpriteIcon name={icon()} size={16} />}</Show>
        <h2 {...stylex.attrs(styles.panelSpan)}>{props.title}</h2>
        <span {...stylex.attrs(styles.sectionSpan)}>{props.aside}</span>
      </div>
      {props.children}
    </section>
  );
}

export function Tip(props: { hover: SceneHover; tree: MemoryTree; agentName: (id: string) => string; now: number }) {
  const m = () => props.hover.item;
  const ties = () => tieWords(m().kind, tiesOf(props.tree.links, m().id));
  const left = () => Math.min(props.hover.x + 14, window.innerWidth - 270);
  const top = () => Math.min(props.hover.y + 14, window.innerHeight - 110);
  return (
    <PxWindow styles={[styles.tipPxWindow]} style={{ left: `${left()}px`, top: `${top()}px` }}>
      <div {...stylex.attrs(styles.sectionDiv)}>
        <SpriteIcon name={kindIcon[m().kind]} size={14} />
        <span {...stylex.attrs(styles.tipSpan)}>
          {props.agentName(m().agent)} · {m().repo ?? t("web.tree.everyRepo")}
        </span>
      </div>
      <p {...stylex.attrs(styles.tipP)}>{m().body}</p>
      <p {...stylex.attrs(styles.tipP2)}>
        {ago(m().at, props.now)} · {t("web.tree.recalled", { n: m().recalled })}
        {m().fading ? t("web.tree.aboutToFall") : ""}
      </p>
      <Show when={ties().length > 0}>
        <p {...stylex.attrs(styles.tipP3)}>{ties().join(" · ")}</p>
      </Show>
    </PxWindow>
  );
}
