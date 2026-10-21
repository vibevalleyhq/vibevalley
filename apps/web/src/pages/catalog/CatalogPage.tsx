// 图鉴: every drawing the farm uses, its pointers and its sounds. /catalog is the drawings,
// /catalog/<name> one of them large, /catalog/cursors and /catalog/sounds the other shelves.

import { createEffect, createMemo, createSignal, For, Match, Show, Switch, untrack } from "solid-js";
import type { JSX } from "@solidjs/web";

import { playSound, SOUND_GROUPS, SOUND_LABEL, type SoundName } from "../../farm/sound";
import { framesOf, groupsOf, type Picture, pictureMatches, picturesOf, remakeOf, shelfOf, shelves } from "../../rules/catalog";
import { numberText } from "../../rules/time";
import { A } from "../../app/A";
import { useRouter } from "../../app/router";
import { aria } from "../../app/util";
import { ready, useQuery } from "../../data/query";
import { Button } from "../../ui/Button";
import { TextInput } from "../../ui/Field";
import { Icon } from "../../ui/Icon";
import { Segmented } from "../../ui/Segmented";
import { Card, Quiet, Toggle } from "../kit";

type Ground = "check" | "grass" | "night";
const grounds: { value: Ground; label: string }[] = [
  { value: "check", label: "格子" },
  { value: "grass", label: "草地" },
  { value: "night", label: "夜里" },
];

const groundStyle = (g: Ground): JSX.CSSProperties =>
  g === "grass"
    ? { background: "#7a9a4a" }
    : g === "night"
      ? { background: "#22283a" }
      : { "background-color": "#f3e9d2", "background-image": "repeating-conic-gradient(#e4d6b6 0% 25%, transparent 0% 50%)", "background-size": "12px 12px" };

/** Whole steps, so its pixels stay square. */
const fitScale = (p: Picture, box: number) => {
  const k = box / Math.max(p.w, p.h);
  return k >= 1 ? Math.floor(k) : k;
};

function Img(props: { p: Picture; scale: number }) {
  return (
    <img
      src={`/pixel/${props.p.name}.png`}
      alt=""
      draggable="false"
      class="max-w-none [image-rendering:pixelated]"
      style={{ width: `${Math.round(props.p.w * props.scale)}px`, height: `${Math.round(props.p.h * props.scale)}px` }}
    />
  );
}

const usePictures = () =>
  useQuery(() => ({ queryKey: ["pictures"], queryFn: async () => picturesOf(await (await fetch("/pixel/sprites.json")).json()), staleTime: Infinity }));

const shelfTabs = [
  { id: "sprites", label: "图", to: "/catalog" },
  { id: "cursors", label: "指针", to: "/catalog/cursors" },
  { id: "sounds", label: "音效", to: "/catalog/sounds" },
] as const;

/** `rest` is the path after /catalog/. */
export function CatalogPage(props: { rest: string }) {
  const shelf = () => (props.rest === "cursors" ? "cursors" : props.rest === "sounds" ? "sounds" : "sprites");
  const tabs = () => (
    <div role="tablist" aria-label="图鉴的书架" class="flex gap-0.5 rounded-lg bg-hover p-0.5">
      <For each={shelfTabs}>
        {(t) => (
          <A
            href={t.to}
            role="tab"
            aria-selected={aria(t.id === shelf())}
            class={[
              "flex h-[26px] flex-1 items-center justify-center rounded-md text-sm",
              t.id === shelf() ? "bg-page font-medium shadow-[0_1px_2px_#2f1f131a]" : "text-muted hover:bg-hover",
            ]}
          >
            {t.label}
          </A>
        )}
      </For>
    </div>
  );
  return (
    <div class="h-full p-3">
      <Switch fallback={<Sprites id={props.rest ? decodeURIComponent(props.rest) : undefined} tabs={tabs()} />}>
        <Match when={shelf() === "cursors"}>
          <Cursors tabs={tabs()} />
        </Match>
        <Match when={shelf() === "sounds"}>
          <Sounds tabs={tabs()} />
        </Match>
      </Switch>
    </div>
  );
}

/** The column every shelf has, so switching shelves never moves the picker. */
function Column(props: { tabs: JSX.Element; children: JSX.Element }) {
  return (
    <div class="flex flex-col gap-2 rounded-lg border border-line bg-page p-2">
      {props.tabs}
      {props.children}
    </div>
  );
}

function Layout(props: { left: JSX.Element; children: JSX.Element; right?: JSX.Element }) {
  return (
    <div class="flex h-full min-h-0 flex-col gap-3 overflow-y-auto lg:flex-row lg:overflow-hidden">
      <div class="shrink-0 lg:w-60 lg:overflow-y-auto">{props.left}</div>
      <Show when={props.right}>
        <div class="shrink-0 xl:order-last xl:w-88 xl:overflow-y-auto">{props.right}</div>
      </Show>
      <div class="flex min-w-0 flex-1 flex-col gap-3 lg:overflow-y-auto">{props.children}</div>
    </div>
  );
}

function Search(props: { query: string; onChange: (q: string) => void; placeholder: string; ground?: Ground; onGround?: (g: Ground) => void }) {
  return (
    <div class="flex flex-wrap items-center gap-2">
      <TextInput
        aria-label="找素材"
        class="min-w-48 flex-1"
        placeholder={props.placeholder}
        value={props.query}
        onInput={(e) => props.onChange(e.currentTarget.value)}
      />
      <Show when={props.ground && props.onGround ? props.ground : undefined}>
        {(g) => <Segmented label="底色" value={g()} options={grounds} onChange={(v) => props.onGround?.(v)} />}
      </Show>
    </div>
  );
}

function Sprites(props: { id?: string; tabs: JSX.Element }) {
  const all = usePictures();
  const router = useRouter();
  const [shelf, setShelf] = createSignal("all");
  const [query, setQuery] = createSignal("");
  const [ground, setGround] = createSignal<Ground>("check");
  const pictures = () => ready(all, undefined);
  const byName = createMemo(() => new Map((pictures() ?? []).map((p) => [p.name, p])));
  const has = (n: string) => byName().has(n);
  const selected = () => (props.id ? byName().get(props.id) : undefined);
  const counts = createMemo(() => {
    const c = new Map<string, number>();
    for (const p of pictures() ?? []) c.set(shelfOf(p.name), (c.get(shelfOf(p.name)) ?? 0) + 1);
    return c;
  });
  // Memos: there are thousands of pictures, and every shelf's card reads them.
  const shown = createMemo(() => (pictures() ?? []).filter((p) => (shelf() === "all" || shelfOf(p.name) === shelf()) && pictureMatches(p, query())));
  const groupsByShelf = createMemo(() => {
    const on = new Map<string, Picture[]>();
    for (const p of shown()) {
      const id = shelfOf(p.name);
      const list = on.get(id);
      if (list) list.push(p);
      else on.set(id, [p]);
    }
    return new Map([...on].map(([id, ps]) => [id, groupsOf(id, ps)]));
  });
  const present = () => shelves.filter((s) => (counts().get(s.id) ?? 0) > 0);
  const visible = () => (shelf() === "all" ? present() : present().filter((s) => s.id === shelf()));
  const ShelfButton = (b: { id: string; label: string; count: number }) => (
    <button
      type="button"
      aria-pressed={aria(shelf() === b.id)}
      onClick={() => setShelf(b.id)}
      class={["flex w-full cursor-pointer items-center rounded-md px-2 py-1.5 text-sm", shelf() === b.id ? "bg-selected font-semibold" : "hover:bg-hover"]}
    >
      <span class="flex-1 text-left">{b.label}</span>
      <span class="text-xs font-normal text-muted">{b.count}</span>
    </button>
  );
  return (
    <Show when={pictures()}>
      {(pics) => (
        <Layout
          left={
            <Column tabs={props.tabs}>
              <nav aria-label="分类" class="flex flex-col gap-0.5">
                <ShelfButton id="all" label="全部" count={pics().length} />
                <For each={present()}>{(s) => <ShelfButton id={s.id} label={s.label} count={counts().get(s.id) ?? 0} />}</For>
              </nav>
              <p class="px-2 pt-1 text-xs text-muted">{pics().length} 张，切自 design/pixel/raw。</p>
            </Column>
          }
          right={
            <Show when={selected()} keyed fallback={<Quiet>点一张看大图：尺寸、落脚点、会动的帧，和它是从哪张原图切出来的、怎么重画。</Quiet>}>
              {(s) => <Detail picture={s} has={has} byName={byName()} ground={ground()} />}
            </Show>
          }
        >
          <Search
            query={query()}
            onChange={setQuery}
            placeholder="找：名字、类别、动物、衣服（熊、雨衣、lang-、icon-……）"
            ground={ground()}
            onGround={setGround}
          />
          <Show when={shown().length === 0}>
            <Quiet>没有对得上的。</Quiet>
          </Show>
          <For each={visible()}>
            {(s) => {
              const groups = () => groupsByShelf().get(s.id) ?? [];
              return (
                <Show when={groups().length > 0}>
                  <Card
                    title={`${s.label} · ${groups().reduce((n, g) => n + g.pictures.length, 0)}`}
                    action={<span class="truncate text-xs text-muted">{s.hint}</span>}
                  >
                    <For each={groups()}>
                      {(g) => (
                        <div class="flex flex-col gap-1.5">
                          <Show when={g.label}>
                            <span class="text-xs font-semibold text-muted">{g.label}</span>
                          </Show>
                          <div class="grid grid-cols-[repeat(auto-fill,minmax(88px,1fr))] gap-1.5">
                            <For each={g.pictures}>
                              {(p) => (
                                <button
                                  type="button"
                                  title={`${p.name} · ${numberText(p.w)}×${numberText(p.h)}`}
                                  aria-label={p.name}
                                  aria-current={selected()?.name === p.name ? "true" : undefined}
                                  onClick={() => router.navigate(`/catalog/${encodeURIComponent(p.name)}`)}
                                  class={[
                                    "flex cursor-pointer flex-col items-center gap-1 rounded-lg p-1 focus-visible:outline-2 focus-visible:outline-focus",
                                    selected()?.name === p.name ? "bg-selected" : "hover:bg-hover",
                                  ]}
                                >
                                  <span class="relative flex size-20 items-center justify-center overflow-hidden rounded-md" style={groundStyle(ground())}>
                                    <Img p={p} scale={fitScale(p, 72)} />
                                    <Show when={framesOf(p.name, has)}>
                                      <span class="absolute top-0.5 right-0.5 rounded-[3px] bg-bark-900/70 px-1 text-[10px] leading-[14px] text-paper">动</span>
                                    </Show>
                                  </span>
                                  <span class="w-full truncate text-center font-mono text-[11.5px] text-muted">{p.name}</span>
                                </button>
                              )}
                            </For>
                          </div>
                        </div>
                      )}
                    </For>
                  </Card>
                </Show>
              );
            }}
          </For>
        </Layout>
      )}
    </Show>
  );
}

function Copy(props: { text: string }) {
  const [done, setDone] = createSignal(false);
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setDone(true);
      setTimeout(() => setDone(false), 1200);
    } catch {
      // No clipboard here: the text is on show to copy by hand.
    }
  };
  return (
    <button
      type="button"
      onClick={() => void copy(props.text)}
      class="flex shrink-0 cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted hover:bg-hover"
    >
      <Icon name={done() ? "mark-check" : "button-copy"} size={12} />
      {done() ? "复制了" : "复制"}
    </button>
  );
}

function Row(props: { label: string; children: JSX.Element }) {
  return (
    <div class="flex gap-2 text-sm">
      <span class="w-16 shrink-0 text-muted">{props.label}</span>
      <span class="flex min-w-0 flex-1 items-center gap-1">{props.children}</span>
    </div>
  );
}

function Code(props: { text: string }) {
  return (
    <>
      <code title={props.text} class="min-w-0 truncate rounded bg-hover px-1.5 py-px font-mono text-[11.5px]">
        {props.text}
      </code>
      <Copy text={props.text} />
    </>
  );
}

function Detail(props: { picture: Picture; has: (n: string) => boolean; byName: Map<string, Picture>; ground: Ground }) {
  const router = useRouter();
  const [scale, setScale] = createSignal(untrack(() => Math.min(8, Math.max(1, Math.floor(260 / Math.max(props.picture.w, props.picture.h))))));
  const [marks, setMarks] = createSignal(true);
  const [playing, setPlaying] = createSignal(true);
  const [fps, setFps] = createSignal(6);
  const [frame, setFrame] = createSignal(0);
  const frames = createMemo(() => framesOf(props.picture.name, props.has));
  createEffect(
    () => [frames()?.join(), playing(), fps()] as const,
    ([names, on, perSecond]) => {
      if (!names || !on || perSecond <= 0) return;
      const t = setInterval(() => setFrame((f) => f + 1), 1000 / perSecond);
      return () => clearInterval(t);
    },
  );
  const shown = () => {
    const f = frames();
    return (f && playing() ? props.byName.get(f[frame() % f.length]!) : undefined) ?? props.picture;
  };
  const remake = () => remakeOf(props.picture);
  const scales = () => [...new Set([1, 2, 4, 8, scale()])].sort((a, b) => a - b);
  return (
    <Card title={props.picture.name} action={<Copy text={props.picture.name} />}>
      <div class="flex max-h-88 min-h-40 items-center justify-center overflow-auto rounded-md p-3" style={groundStyle(props.ground)}>
        <span class="relative" style={{ width: `${shown().w * scale()}px`, height: `${shown().h * scale()}px` }}>
          <Img p={shown()} scale={scale()} />
          <Show when={marks()}>
            <span
              title="落脚点"
              class="absolute"
              style={{
                left: `${shown().ax * scale() - 6}px`,
                top: `${shown().ay * scale() - 6}px`,
                width: "12px",
                height: "12px",
                background: "linear-gradient(#c84a3a,#c84a3a) center/100% 2px no-repeat, linear-gradient(#c84a3a,#c84a3a) center/2px 100% no-repeat",
              }}
            />
            <Show when={shown().hx !== undefined && shown().hy !== undefined}>
              <span
                title="头"
                class="absolute border-2 border-[#0ea5e9]"
                style={{ left: `${shown().hx! * scale() - 5}px`, top: `${shown().hy! * scale() - 5}px`, width: "10px", height: "10px" }}
              />
            </Show>
          </Show>
        </span>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <Segmented
          label="放大"
          value={String(scale())}
          options={scales().map((s) => ({ value: String(s), label: `${s < 1 ? s.toFixed(2).replace(/0$/, "") : numberText(s)}×` }))}
          onChange={(v) => setScale(Number(v))}
        />
        <Toggle label="落脚点和头" checked={marks()} onChange={setMarks} />
      </div>
      <Show when={frames()}>
        {(f) => (
          <div class="flex flex-col gap-1.5 rounded-lg bg-hover p-2">
            <div class="flex items-center gap-2">
              <Button onClick={() => setPlaying(!playing())}>{playing() ? "停" : "播放"}</Button>
              <span class="text-xs text-muted">{f().length} 帧</span>
              <span class="flex-1" />
              <input
                type="range"
                aria-label="每秒几帧"
                min={1}
                max={12}
                step={1}
                value={fps()}
                onInput={(e) => setFps(Number(e.currentTarget.value))}
                class="w-24 accent-[#74a046]"
              />
              <span class="w-14 text-xs text-muted">{fps()} 帧/秒</span>
            </div>
            <div class="flex flex-wrap gap-1">
              <For each={f()}>
                {(name, i) => (
                  <Show when={props.byName.get(name)}>
                    {(p) => (
                      <button
                        type="button"
                        title={name}
                        aria-label={name}
                        onClick={() => router.navigate(`/catalog/${encodeURIComponent(name)}`)}
                        class={[
                          "flex size-11 cursor-pointer items-center justify-center overflow-hidden rounded",
                          { "ring-2 ring-focus": playing() && i() === frame() % f().length },
                        ]}
                        style={groundStyle(props.ground)}
                      >
                        <Img p={p()} scale={fitScale(p(), 38)} />
                      </button>
                    )}
                  </Show>
                )}
              </For>
            </div>
          </div>
        )}
      </Show>
      <div class="flex flex-col gap-1.5">
        <Row label="尺寸">{`${numberText(props.picture.w)} × ${numberText(props.picture.h)} 像素`}</Row>
        <Row label="落脚点">{`(${numberText(props.picture.ax)}, ${numberText(props.picture.ay)})`}</Row>
        <Show when={props.picture.hx !== undefined && props.picture.hy !== undefined}>
          <Row label="头">{`(${numberText(props.picture.hx!)}, ${numberText(props.picture.hy!)})`}</Row>
        </Show>
        <Row label="来自">
          <Show when={props.picture.sheet} fallback={<span class="text-xs text-muted">没记下来（不再用的旧图）</span>}>
            {(sheet) => <Code text={sheet()} />}
          </Show>
        </Row>
        <Show when={remake()}>
          {(r) => (
            <>
              <Row label="重画">
                <Code text={r().draw} />
              </Row>
              <Row label="重新切">
                <Code text={r().cut} />
              </Row>
            </>
          )}
        </Show>
      </div>
    </Card>
  );
}

function Cursors(props: { tabs: JSX.Element }) {
  const [ground, setGround] = createSignal<Ground>("check");
  const [query, setQuery] = createSignal("");
  const cursors = useQuery(() => ({
    queryKey: ["cursors"],
    queryFn: async () => {
      const r = await fetch("/cursors/cursors.json");
      return r.ok ? ((await r.json()) as Record<string, { hx: number; hy: number }>) : null;
    },
    staleTime: Infinity,
  }));
  const data = () => ready(cursors, undefined);
  const all = () => {
    const q = query().trim().toLowerCase();
    const d = data();
    return d ? Object.entries(d).filter(([name]) => !q || name.toLowerCase().includes(q)) : undefined;
  };
  return (
    <Layout
      left={
        <Column tabs={props.tabs}>
          <p class="px-2 pt-1 text-xs text-muted">鼠标在农场里的样子：平时、指着能点的、拿着工具时。</p>
        </Column>
      }
    >
      <Search query={query()} onChange={setQuery} placeholder="找：指针的名字（glove、water、harvest……）" ground={ground()} onGround={setGround} />
      <Card title={`指针 · ${all()?.length ?? 0}`}>
        <p class="text-sm text-muted">
          红点是点下去落在哪。平时是手套，指着能点的伸出食指；拿着工具时是那件工具，能用的带闪光，用不上的带禁止标记。切自
          design/pixel/raw/ui-cursors.png（design/pixel/process.py ui-cursors）。
        </p>
        <Show when={data() !== null} fallback={<Quiet>这个版本没有带上指针的图（assets/cursors）。</Quiet>}>
          <div class="grid grid-cols-[repeat(auto-fill,minmax(104px,1fr))] gap-1.5">
            <For each={all() ?? []}>{([name, hot]) => <CursorTile name={name} hx={hot.hx} hy={hot.hy} ground={ground()} />}</For>
          </div>
        </Show>
      </Card>
    </Layout>
  );
}

function CursorTile(props: { name: string; hx: number; hy: number; ground: Ground }) {
  const [natural, setNatural] = createSignal<{ w: number; h: number }>();
  const height = 40;
  const k = () => {
    const n = natural();
    return n ? height / n.h : undefined;
  };
  return (
    <div class="flex flex-col items-center gap-1 p-1">
      <span class="flex h-16 w-full items-center justify-center rounded-md" style={groundStyle(props.ground)}>
        <span class="relative" style={{ height: `${height}px`, width: `${natural() && k() ? natural()!.w * k()! : height}px` }}>
          <img
            src={`/cursors/${props.name}@2x.png`}
            alt=""
            class="h-10 [image-rendering:pixelated]"
            onError={(e) => (e.currentTarget.src = `/cursors/${props.name}.png`)}
          />
          <img
            src={`/cursors/${props.name}.png`}
            alt=""
            class="hidden"
            onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
          />
          <Show when={k()}>
            {(k) => (
              <span
                class="absolute size-2 rounded-full border border-bark-900 bg-berry"
                style={{ left: `${props.hx * k() - 4}px`, top: `${props.hy * k() - 4}px` }}
              />
            )}
          </Show>
        </span>
      </span>
      <span class="font-mono text-xs text-muted">{props.name}</span>
    </div>
  );
}

function Sounds(props: { tabs: JSX.Element }) {
  const [query, setQuery] = createSignal("");
  const matches = (group: string, name: SoundName) => {
    const q = query().trim().toLowerCase();
    return !q || [group, name, SOUND_LABEL[name] ?? ""].some((w) => w.toLowerCase().includes(q));
  };
  return (
    <Layout
      left={
        <Column tabs={props.tabs}>
          <p class="px-2 pt-1 text-xs text-muted">农场里的每个声音，点一下就能听。</p>
        </Column>
      }
    >
      <Search query={query()} onChange={setQuery} placeholder="找：声音的名字或分组（浇水、院子、coin……）" />
      <Card>
        <p class="text-sm text-muted">
          音效都是现合成的，没有音频文件：配方在 <code class="font-mono text-[12.5px]">apps/web/src/farm/sound.ts</code>
          。关了音效就听不到。背景音乐还没有，给 Suno 的提示词在 <code class="font-mono text-[12.5px]">design/music/suno-prompts.md</code>。
        </p>
      </Card>
      <For each={SOUND_GROUPS}>
        {(g) => {
          const names = () => g.names.filter((n) => matches(g.title, n));
          return (
            <Show when={names().length > 0}>
              <Card title={g.title}>
                <div class="flex flex-wrap gap-2">
                  <For each={names()}>
                    {(name) => (
                      <button
                        type="button"
                        aria-label={`播放 ${SOUND_LABEL[name] ?? name}`}
                        onClick={() => playSound(name)}
                        class="flex h-8 cursor-pointer items-center gap-2 rounded-md border border-line bg-page pr-3 pl-1.5 hover:bg-hover active:bg-selected"
                      >
                        <Icon name="button-play" size={16} />
                        <span class="text-sm font-medium">{SOUND_LABEL[name] ?? name}</span>
                        <span class="font-mono text-xs text-muted">{name}</span>
                      </button>
                    )}
                  </For>
                </div>
              </Card>
            </Show>
          );
        }}
      </For>
    </Layout>
  );
}
