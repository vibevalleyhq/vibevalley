import type { JSX } from "@solidjs/web";
import { createMemo, createSignal, For, Match, Show, Switch } from "solid-js";

import { t } from "@vibevalley/i18n";

import { aria } from "#/base/dom.tsx";
import { numberText } from "#/base/format.ts";
import { spelled } from "#/base/search.ts";
import { cursorsQuery, ready, useQuery, useSprites } from "#/infra/query.ts";
import { useRouter } from "#/infra/router.ts";
import { TextInput } from "#/ui/Field.tsx";
import { Icon } from "#/ui/Icon.tsx";
import { Card, Quiet } from "#/ui/layout.tsx";
import { playSound, SOUND_GROUPS, SOUND_LABEL, type SoundName } from "#/ui/pixel/sound.ts";
import { Segmented } from "#/ui/Segmented.tsx";
import { Tabs } from "#/ui/Tabs.tsx";

import { CursorTile, Detail, fitScale, type Ground, grounds, groundStyle, Img } from "./CatalogDetail";
import { framesOf, groupsOf, type Picture, pictureMatches, picturesOf, shelfOf, shelves } from "./shelves";

const usePictures = () => {
  const query = useSprites();
  return {
    ...query,
    data: () => {
      const manifest = query.data();
      return manifest ? picturesOf(manifest) : undefined;
    },
  };
};

const shelfTabs = [
  { id: "sprites", label: t("web.catalog.tab.sprites"), to: "/catalog" },
  { id: "cursors", label: t("web.catalog.tab.cursors"), to: "/catalog/cursors" },
  { id: "sounds", label: t("web.catalog.tab.sounds"), to: "/catalog/sounds" },
] as const;

/** `rest` is the path after /catalog/. */
export function CatalogPage(props: { rest: string }) {
  const shelf = () => (props.rest === "cursors" || props.rest === "sounds" ? props.rest : "sprites");
  const tabs = () => <Tabs label={t("web.catalog.shelves")} value={shelf()} items={shelfTabs.map((s) => ({ value: s.id, label: s.label, href: s.to }))} />;
  return (
    <div class="h-full">
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

/** The column every shelf has, so switching shelves never moves the picker: the page's side column (Layout). */
function Column(props: { tabs: JSX.Element; children: JSX.Element }) {
  return (
    <div class="flex flex-col gap-2">
      {props.tabs}
      {props.children}
    </div>
  );
}

function Layout(props: { left: JSX.Element; children: JSX.Element; right?: JSX.Element }) {
  return (
    // The shelves are the page's side column, against the rail as the chat's and the notes' are (ui/layout.tsx Split edge).
    <div class="flex h-full min-h-0 flex-col lg:flex-row overflow-y-auto lg:overflow-y-hidden lg:overflow-x-hidden">
      <div class="shrink-0 lg:[border-bottom-style:solid] border-b lg:border-b-0 border-line bg-side px-2 py-3 lg:w-60 lg:overflow-y-auto lg:[border-right-style:solid] lg:border-r">
        {props.left}
      </div>
      <Show when={props.right}>
        <div class="shrink-0 pt-3 pr-3 pb-3 pl-3 xl:pl-0 xl:order-9999 xl:w-88 xl:overflow-y-auto">{props.right}</div>
      </Show>
      <div class="flex min-w-0 flex-1 flex-col gap-3 p-3 lg:overflow-y-auto">{props.children}</div>
    </div>
  );
}

function Search(props: { query: string; onChange: (q: string) => void; placeholder: string; ground?: Ground; onGround?: (g: Ground) => void }) {
  return (
    <div class="flex flex-wrap items-center gap-2">
      <TextInput
        data-testid="catalog-search"
        aria-label={t("web.catalog.find")}
        class="min-w-48 flex-1"
        placeholder={props.placeholder}
        value={props.query}
        onInput={(e) => props.onChange(e.currentTarget.value)}
      />
      <Show when={props.ground && props.onGround ? props.ground : undefined}>
        {(g) => <Segmented label={t("web.catalog.background")} value={g()} options={grounds} onChange={(v) => props.onGround?.(v)} />}
      </Show>
    </div>
  );
}

function Sprites(props: { id?: string | undefined; tabs: JSX.Element }) {
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
      data-key={b.id}
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
              <nav aria-label={t("web.catalog.categories")} data-testid="catalog-shelves" class="flex flex-col gap-0.5">
                <ShelfButton id="all" label={t("web.catalog.all")} count={pics().length} />
                <For each={present()}>{(s) => <ShelfButton id={s.id} label={s.label} count={counts().get(s.id) ?? 0} />}</For>
              </nav>
              <p class="px-2 pt-1 text-xs text-muted">{t("web.catalog.count", { n: pics().length })}</p>
            </Column>
          }
          right={
            <Show when={selected()} keyed fallback={<Quiet>{t("web.catalog.pick")}</Quiet>}>
              {(s) => <Detail picture={s} has={has} byName={byName()} ground={ground()} />}
            </Show>
          }
        >
          <Search query={query()} onChange={setQuery} placeholder={t("web.catalog.findHint")} ground={ground()} onGround={setGround} />
          <Show when={shown().length === 0}>
            <Quiet>{t("web.catalog.noMatch")}</Quiet>
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
                                  data-testid="picture"
                                  data-key={p.name}
                                  aria-current={selected()?.name === p.name ? "true" : undefined}
                                  onClick={() => router.navigate(`/catalog/${encodeURIComponent(p.name)}`)}
                                  class={[
                                    "flex cursor-pointer flex-col items-center gap-1 rounded-lg p-1 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-focus",
                                    selected()?.name === p.name ? "bg-selected" : "hover:bg-hover",
                                  ]}
                                >
                                  <span class={["relative flex w-20 h-20 items-center justify-center overflow-hidden rounded-md", groundStyle(ground())]}>
                                    <Img p={p} scale={fitScale(p, 72)} />
                                    <Show when={framesOf(p.name, has)}>
                                      <span class="absolute top-0.5 right-0.5 rounded-xs bg-bark-900/70 px-1 text-2xs text-paper">
                                        {t("web.catalog.moves")}
                                      </span>
                                    </Show>
                                  </span>
                                  <span class="w-full truncate text-center font-mono text-2xs text-muted">{p.name}</span>
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

function Cursors(props: { tabs: JSX.Element }) {
  const [ground, setGround] = createSignal<Ground>("check");
  const [query, setQuery] = createSignal("");
  const cursors = useQuery(cursorsQuery);
  const data = () => ready(cursors, undefined);
  const all = () => {
    const q = query().trim().toLowerCase();
    const d = data();
    return d ? Object.entries(d).filter(([name]) => !q || spelled(name, q)) : undefined;
  };
  return (
    <Layout
      left={
        <Column tabs={props.tabs}>
          <p class="px-2 pt-1 text-xs text-muted">{t("web.catalog.cursorsIntro")}</p>
        </Column>
      }
    >
      <Search query={query()} onChange={setQuery} placeholder={t("web.catalog.cursorsFind")} ground={ground()} onGround={setGround} />
      <Card title={t("web.catalog.cursors", { n: all()?.length ?? 0 })}>
        <p class="text-sm text-muted">{t("web.catalog.cursorsNote")}</p>
        <Show when={data() !== null} fallback={<Quiet>{t("web.catalog.noCursors")}</Quiet>}>
          <div class="grid grid-cols-[repeat(auto-fill,minmax(104px,1fr))] gap-1.5">
            <For each={all() ?? []}>{([name, hot]) => <CursorTile name={name} hx={hot.hx} hy={hot.hy} ground={ground()} />}</For>
          </div>
        </Show>
      </Card>
    </Layout>
  );
}

function Sounds(props: { tabs: JSX.Element }) {
  const [query, setQuery] = createSignal("");
  const matches = (group: string, name: SoundName) => {
    const q = query().trim().toLowerCase();
    return !q || [group, name, SOUND_LABEL[name]].some((w) => spelled(w, q));
  };
  return (
    <Layout
      left={
        <Column tabs={props.tabs}>
          <p class="px-2 pt-1 text-xs text-muted">{t("web.catalog.soundsIntro")}</p>
        </Column>
      }
    >
      <Search query={query()} onChange={setQuery} placeholder={t("web.catalog.soundsFind")} />
      <Card>
        <p class="text-sm text-muted">
          {t("web.catalog.soundsRecipes")} <code class="font-mono text-xs">apps/web/src/ui/pixel/sound.ts</code>
          {t("web.catalog.soundsMuted")}
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
                        data-testid="sound"
                        data-key={name}
                        aria-label={t("web.catalog.playSound", { name: SOUND_LABEL[name] })}
                        onClick={() => playSound(name)}
                        class="flex h-8 cursor-pointer items-center gap-2 rounded-md border border-line bg-page hover:bg-hover active:bg-selected pr-3 pl-1.5"
                      >
                        <Icon name="play" size={16} />
                        <span class="text-sm font-medium">{SOUND_LABEL[name]}</span>
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
