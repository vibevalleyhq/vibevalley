// /tree: the farm's memory tree, every helper's and every project's memories summed up for the owner, showing only how
// the farm grows (.agents/notes/proposed/feature/2026-10-22-memory-tree.md). Full-bleed like the farm, outside the
// workbench's shell; the farm's HUD has its button. One canvas (Scene.tsx) draws the tree grown from the memories and,
// looking up, the same memories as a sky; the panel to the right. The memories are made up (mock.ts) until the server
// sums them up.

import { createSignal, For, Show, untrack } from "solid-js";
import type { JSX } from "@solidjs/web";
import { PxButton, PxPick, PxWindow, pxText, SpriteIcon } from "../farm/kit";
import { playSound } from "../farm/sound";
import { useRouter, useSearch } from "../app/router";
import { useNow, useViewport } from "../app/util";
import { ago } from "../rules/time";
import { toast } from "../ui/toasts";
import { type MemoryItem, type MemoryKind, type MemoryTree, mockTree, type TreeStage } from "./mock";
import { allOf, counts, kept, newest, stageName, type Ties, tiesOf, type TreeFilter } from "./rules";
import { type SceneArea, type SceneHover, Scene } from "./Scene";

const kindIcon: Record<MemoryKind, string> = { leaf: "icon-leaf", fruit: "icon-fruit", seed: "icon-seed" };
const kindName: Record<MemoryKind, string> = { leaf: "叶", fruit: "果", seed: "种子" };

/** A tie's words, by the kind of memory it is about: what it grew from, what grew from it, what it is used with. */
function tieWords(kind: MemoryKind, ties: Ties): string[] {
  const words: string[] = [];
  if (ties.from.length > 0) words.push(kind === "seed" ? `提炼自 ${ties.from.length} 次经验` : `这件活记下了 ${ties.from.length} 片叶`);
  if (ties.grew.length > 0) words.push(kind === "fruit" ? `长出了 ${ties.grew.length} 颗种子` : `长成了 ${ties.grew.length} 次经验`);
  if (ties.together.length > 0) words.push(`常和 ${ties.together.length} 条一起想起`);
  return words;
}

/** The panel's width beside the tree; under it on a narrow page. */
const panelWidth = 340;
const narrowBelow = 760;

export function TreePage() {
  const router = useRouter();
  const search = useSearch();
  const view = useViewport();
  const now = useNow(60_000);
  const asked = untrack(() => Number(search().get("stage")));
  const tree = mockTree(Date.now(), asked >= 1 && asked <= 5 ? (asked as TreeStage) : undefined);
  const [filter, setFilter] = createSignal<TreeFilter>(allOf);
  const [sown, setSown] = createSignal<ReadonlySet<string>>(new Set(tree.items.filter((m) => m.sown).map((m) => m.id)));
  const [picked, setPicked] = createSignal<MemoryItem | null>(null);
  const [hover, setHover] = createSignal<SceneHover | null>(null);
  const [sky, setSky] = createSignal(false);
  const [until, setUntil] = createSignal(1);

  const agentName = (id: string) => tree.agents.find((a) => a.id === id)?.name ?? id;
  const shown = () => tree.items.filter((m) => kept(m, filter()));
  const tally = () => counts(shown());
  const waiting = () => shown().filter((m) => m.kind === "seed" && !sown().has(m.id));

  const home = () => {
    playSound("open");
    router.navigate("/");
  };
  const sow = (seed: MemoryItem) => {
    playSound("open");
    setSown((s) => new Set([...s, seed.id]));
    toast(`「${seed.body}」播进了技能书（还是假的，接上服务端以后才真写进去）`);
  };
  const lookUp = (up: boolean) => {
    playSound("open");
    setHover(null);
    setSky(up);
  };

  const narrow = () => view().w < narrowBelow;
  // Where the tree stands: left of the panel, or above it on a narrow page; the whole page while looking up.
  const area = (): SceneArea => (narrow() ? { x: 0, y: 40, w: view().w, h: view().h * 0.52 - 40 } : { x: 0, y: 0, w: view().w - panelWidth - 24, h: view().h });
  const day = () => {
    const days = Math.max(1, Math.ceil((now() - tree.since) / 86_400_000));
    return Math.max(1, Math.round(days * until()));
  };

  return (
    <div class="fixed inset-0 overflow-hidden bg-ground font-pixel text-bark-900 select-none" data-testid="memory-tree">
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
            unpick={() => setPicked(null)}
            agentName={agentName}
            now={now()}
            onSow={sow}
            onLookUp={() => lookUp(true)}
          />
        }
      >
        <PxWindow class="absolute top-3 left-3 px-3 py-2">
          <div class={pxText.sm}>农场的记忆星空</div>
          <div class={[pxText.xs, "text-bark-500"]}>中间是种子，往外是果和叶，越远越旧；拖动可以转</div>
        </PxWindow>
        <div class="absolute top-3 right-3">
          <PxButton icon="icon-tree" onClick={() => lookUp(false)}>
            回到树下
          </PxButton>
        </div>
      </Show>
      <div class={["absolute top-3 left-3", { hidden: sky() }]}>
        <PxButton icon="icon-map" onClick={home}>
          回农场
        </PxButton>
      </div>
      <PxWindow
        class={[
          "absolute flex flex-wrap items-center gap-3 px-3 py-2",
          sky() ? "inset-x-3 bottom-3 mx-auto max-w-[760px]" : narrow() ? "inset-x-2 top-[calc(52%-56px)]" : "bottom-3 left-3",
        ]}
        style={sky() || narrow() ? undefined : { width: `${Math.min(520, area().w - 24)}px` }}
      >
        <Show when={sky()}>
          <Filters tree={tree} filter={filter()} setFilter={setFilter} class="min-w-[220px] flex-1" />
        </Show>
        <label class="flex min-w-[220px] flex-1 items-center gap-2">
          <span class={pxText.xs}>最早</span>
          <input
            type="range"
            min="0"
            max="1"
            step="0.005"
            value={until()}
            aria-label="看看从前：拖到哪天，树就长回那天的样子"
            onInput={(e) => setUntil(Number(e.currentTarget.value))}
            class="flex-1 accent-[var(--color-leaf-500)]"
          />
          <span class={[pxText.xs, "w-[64px] text-right"]}>{until() >= 1 ? "现在" : `第 ${day()} 天`}</span>
        </label>
      </PxWindow>
      <Show when={hover()}>{(h) => <Tip hover={h()} tree={tree} agentName={agentName} now={now()} />}</Show>
    </div>
  );
}

function Filters(props: { tree: MemoryTree; filter: TreeFilter; setFilter: (f: TreeFilter) => void; class?: string }) {
  return (
    <div class={["flex gap-2", props.class]}>
      <PxPick
        label="只看哪个帮工的"
        placeholder="全部帮工"
        clearable
        value={props.filter.agent}
        options={props.tree.agents.map((a) => ({ value: a.id, label: a.name }))}
        onChange={(agent) => props.setFilter({ ...props.filter, agent })}
      />
      <PxPick
        label="只看哪个项目的"
        placeholder="全部项目"
        clearable
        value={props.filter.project}
        options={props.tree.projects.map((p) => ({ value: p, label: p }))}
        onChange={(project) => props.setFilter({ ...props.filter, project })}
      />
    </div>
  );
}

function Panel(props: {
  tree: MemoryTree;
  narrow: boolean;
  filter: TreeFilter;
  setFilter: (f: TreeFilter) => void;
  tally: Record<MemoryKind | "fading", number>;
  recent: readonly MemoryItem[];
  fading: readonly MemoryItem[];
  waiting: readonly MemoryItem[];
  picked: MemoryItem | null;
  pick: (m: MemoryItem) => void;
  unpick: () => void;
  agentName: (id: string) => string;
  now: number;
  onSow: (seed: MemoryItem) => void;
  onLookUp: () => void;
}) {
  const [showFading, setShowFading] = createSignal(false);
  const days = () => Math.max(1, Math.ceil((props.now - props.tree.since) / 86_400_000));
  return (
    <PxWindow
      class={["absolute flex flex-col gap-3 overflow-y-auto p-4", props.narrow ? "inset-x-2 bottom-2 h-[48%]" : "top-3 right-3 bottom-3"]}
      style={props.narrow ? undefined : { width: `${panelWidth}px` }}
    >
      <header class="text-center">
        <h1 class={pxText.lg}>农场的记忆树</h1>
        <p class={[pxText.xs, "text-bark-500"]}>
          第 {days()} 天 · {props.tree.rounds} 轮 · 想起 {props.tree.recalls} 次
        </p>
      </header>
      <div class="flex items-center gap-2 border-2 border-cream-300 bg-cream-100 px-2 py-1.5">
        <SpriteIcon name="icon-rings" size={20} />
        <span class={pxText.sm}>{stageName[props.tree.stage]}</span>
        <span class={[pxText.xs, "ml-auto text-bark-500"]}>
          {props.tree.nextStageIn !== undefined ? `再干 ${props.tree.nextStageIn} 轮长成${stageName[(props.tree.stage + 1) as TreeStage]}` : "长成了"}
        </span>
      </div>
      <div class="grid grid-cols-3 gap-2" data-testid="memory-counts">
        <Count icon="icon-leaf" label="叶" n={props.tally.leaf} />
        <Count icon="icon-fruit" label="果" n={props.tally.fruit} />
        <Count icon="icon-seed" label="种子" n={props.tally.seed} />
      </div>
      <Filters tree={props.tree} filter={props.filter} setFilter={props.setFilter} />
      <Show when={props.picked}>
        {(m) => (
          <Section
            title={m().kind === "fruit" ? "一次经验" : kindName[m().kind]}
            icon={kindIcon[m().kind]}
            aside={<PxButton size="sm" label="收起" icon="button-close" onClick={props.unpick} />}
          >
            <p class={[pxText.xs, "text-bark-500"]}>
              {props.agentName(m().agent)} · {m().project ?? "所有项目"} · {ago(m().at, props.now)}
            </p>
            <Show when={m().case} fallback={<p class={pxText.sm}>{m().body}</p>}>
              {(c) => (
                <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                  <dt class={[pxText.xs, "text-bark-500"]}>想做什么</dt>
                  <dd class={pxText.sm}>{c().intent}</dd>
                  <dt class={[pxText.xs, "text-bark-500"]}>怎么做的</dt>
                  <dd class={pxText.sm}>{c().approach}</dd>
                  <dt class={[pxText.xs, "text-bark-500"]}>关键心得</dt>
                  <dd class={pxText.sm}>{c().insight}</dd>
                </dl>
              )}
            </Show>
            <p class={[pxText.xs, "text-bark-500"]}>想起过 {m().recalled} 次</p>
            <TieList tree={props.tree} item={m()} pick={props.pick} />
          </Section>
        )}
      </Show>
      <Section title="最近长出的">
        <ul class="flex flex-col gap-1">
          <For each={props.recent}>
            {(m) => (
              <li class="flex items-center gap-2">
                <SpriteIcon name={kindIcon[m.kind]} size={16} label={kindName[m.kind]} />
                <span class={[pxText.sm, "min-w-0 flex-1 truncate"]} title={m.body}>
                  {m.body}
                </span>
                <span class={[pxText.xs, "shrink-0 text-bark-500"]}>{props.agentName(m.agent)}</span>
              </li>
            )}
          </For>
        </ul>
      </Section>
      <Section
        title={`快落的叶 ${props.fading.length}`}
        icon="icon-leaf-fall"
        aside={
          <Show when={props.fading.length > 0}>
            <PxButton size="sm" onClick={() => setShowFading((v) => !v)}>
              {showFading() ? "收起" : "看看"}
            </PxButton>
          </Show>
        }
      >
        <Show when={showFading()} fallback={<p class={[pxText.xs, "text-bark-500"]}>最久没想起的会先落；落了就忘了。</p>}>
          <ul class="flex flex-col gap-1">
            <For each={props.fading}>
              {(m) => (
                <li class={[pxText.sm, "truncate"]} title={m.body}>
                  {m.body}
                </li>
              )}
            </For>
          </ul>
        </Show>
      </Section>
      <Section title="待播种的手艺" icon="icon-seed-gold">
        <Show when={props.waiting.length > 0} fallback={<p class={[pxText.xs, "text-bark-500"]}>没有新的手艺；好几次经验说的是一件事时，会提炼出一颗种子。</p>}>
          <ul class="flex flex-col gap-2">
            <For each={props.waiting}>
              {(seed) => (
                <li class="flex items-center gap-2">
                  <SpriteIcon name="icon-seed" size={20} />
                  <span class={[pxText.sm, "min-w-0 flex-1"]}>{seed.body}</span>
                  <PxButton size="sm" tone="primary" onClick={() => props.onSow(seed)}>
                    播种
                  </PxButton>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </Section>
      <PxButton tone="accent" icon="icon-stars" class="mt-auto w-full" onClick={props.onLookUp}>
        抬头看星空
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
      { title: props.item.kind === "seed" ? "提炼自" : "这件活记下的", ids: ties().from },
      { title: props.item.kind === "fruit" ? "长出了" : "长成了", ids: ties().grew },
      {
        title: "常一起想起",
        ids: ties()
          .together.slice(0, 4)
          .map((t) => t.id),
      },
    ].filter((g) => g.ids.length > 0);
  return (
    <For each={groups()}>
      {(g) => (
        <div class="flex flex-col gap-0.5">
          <span class={[pxText.xs, "text-bark-500"]}>{g.title}</span>
          <For each={g.ids}>
            {(id) => (
              <Show when={find(id)}>
                {(m) => (
                  <button type="button" onClick={() => props.pick(m())} class="flex cursor-pointer items-center gap-1.5 text-left hover:bg-cream-200">
                    <SpriteIcon name={kindIcon[m().kind]} size={14} />
                    <span class={[pxText.sm, "min-w-0 flex-1 truncate"]}>{m().body}</span>
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
    <div class="flex items-center justify-center gap-1.5 border-2 border-cream-300 bg-cream-100 py-1.5" title={props.label}>
      <SpriteIcon name={props.icon} size={20} label={props.label} />
      <span class={pxText.sm}>{props.n}</span>
    </div>
  );
}

function Section(props: { title: string; icon?: string; aside?: JSX.Element; children: JSX.Element }) {
  return (
    <section class="flex flex-col gap-1.5 border-t-2 border-dashed border-cream-300 pt-2">
      <div class="flex items-center gap-1.5">
        <Show when={props.icon}>{(icon) => <SpriteIcon name={icon()} size={16} />}</Show>
        <h2 class={pxText.sm}>{props.title}</h2>
        <span class="ml-auto">{props.aside}</span>
      </div>
      {props.children}
    </section>
  );
}

/** What is under the pointer: whose, which project, what it says. */
function Tip(props: { hover: SceneHover; tree: MemoryTree; agentName: (id: string) => string; now: number }) {
  const m = () => props.hover.item;
  const ties = () => tieWords(m().kind, tiesOf(props.tree.links, m().id));
  const left = () => Math.min(props.hover.x + 14, window.innerWidth - 270);
  const top = () => Math.min(props.hover.y + 14, window.innerHeight - 110);
  return (
    <PxWindow class="pointer-events-none fixed z-40 w-[256px] px-2.5 py-2" style={{ left: `${left()}px`, top: `${top()}px` }}>
      <div class="flex items-center gap-1.5">
        <SpriteIcon name={kindIcon[m().kind]} size={14} />
        <span class={pxText.xs}>
          {props.agentName(m().agent)} · {m().project ?? "所有项目"}
        </span>
      </div>
      <p class={[pxText.sm, "mt-1"]}>{m().body}</p>
      <p class={[pxText.xs, "mt-1 text-bark-500"]}>
        {ago(m().at, props.now)} · 想起过 {m().recalled} 次{m().fading ? " · 快落了" : ""}
      </p>
      <Show when={ties().length > 0}>
        <p class={[pxText.xs, "mt-0.5 text-leaf-700"]}>{ties().join(" · ")}</p>
      </Show>
    </PxWindow>
  );
}
