// Ported from VibeValley apps/web/src/features/catalog/CatalogPage.tsx: the
// sprites by shelf with search and grounds, one picture's detail, and the
// cursors and the sounds. The pictures and cursors are the app's art
// (ui/pixel/atlas.ts), the manifests ship with the views; the sounds are
// rendered offline (ui/pixel/synth.ts). Below xl the detail sits over the
// grid, as VibeValley's column does before it moves to the right.
import { Scroll, signal, Text, View, type JSX } from "nsh";

import { t } from "@vibevalley/i18n";

import { createMemo } from "../../../solid";
import { numberText } from "../../base/format";
import { spelled } from "../../base/search";
import { cursorsQuery, ready, useQuery, useSprites } from "../../infra/query";
import { useRouter } from "../../infra/router";
import { TextInput } from "../../ui/Field";
import { Icon } from "../../ui/Icon";
import { Card, Quiet } from "../../ui/layout";
import { playSound, SOUND_GROUPS, SOUND_LABEL, type SoundName } from "../../ui/pixel/sound";
import { Segmented } from "../../ui/Segmented";
import { Tabs } from "../../ui/Tabs";
import { Bubble } from "../../ui/Tip";
import { CursorTile, Detail, fitScale, type Ground, GroundBox, grounds, Img } from "./CatalogDetail";
import { framesOf, groupsOf, type Picture, pictureMatches, picturesOf, shelfOf, shelves } from "./shelves";

const usePictures = () => {
  const query = useSprites();
  return () => {
    const manifest = ready(query, undefined);
    return manifest ? picturesOf(manifest as Record<string, Record<string, unknown>>) : undefined;
  };
};

type ShelfTab = "sprites" | "cursors" | "sounds";
const shelfTabs: { id: ShelfTab; label: string; to: string }[] = [
  { id: "sprites", label: t("web.catalog.tab.sprites"), to: "/catalog" },
  { id: "cursors", label: t("web.catalog.tab.cursors"), to: "/catalog/cursors" },
  { id: "sounds", label: t("web.catalog.tab.sounds"), to: "/catalog/sounds" },
];

/** `rest` is the path after /catalog/. */
export function CatalogPage(props: { rest: string }) {
  const shelf = (): ShelfTab => (props.rest === "cursors" || props.rest === "sounds" ? props.rest : "sprites");
  const tabs = () => <Tabs label={t("web.catalog.shelves")} value={shelf()} items={shelfTabs.map((s) => ({ value: s.id, label: s.label, href: s.to }))} />;
  return (
    <View testID="catalog-page" class="h-full min-h-0 flex-1">
      <If
        when={shelf() === "cursors"}
        else={
          <If when={shelf() === "sounds"} else={<Sprites id={props.rest ? decodeURIComponent(props.rest) : undefined} tabs={tabs()} />}>
            <Sounds tabs={tabs()} />
          </If>
        }
      >
        <Cursors tabs={tabs()} />
      </If>
    </View>
  );
}

/** The column every shelf has, so switching shelves never moves the picker. */
function Column(props: { tabs: JSX.Element; children: JSX.Element }) {
  return (
    <View class="gap-2">
      {props.tabs}
      {props.children}
    </View>
  );
}

function Layout(props: { left: JSX.Element; children: JSX.Element; right?: JSX.Element }) {
  return (
    // The shelves are the page's side column, against the rail as the chat's and the notes' are (ui/layout.tsx Split edge).
    <View class="h-full min-h-0 flex-1 lg:flex-row">
      <Scroll class="max-h-60 shrink-0 border-b border-line bg-side lg:max-h-none lg:w-60 lg:border-r lg:border-b-0" contentClass="px-2 py-3">
        {props.left}
      </Scroll>
      <Scroll class="min-h-0 min-w-0 flex-1" contentClass="gap-3 p-3">
        <If when={props.right}>
          <View class="xl:hidden">{props.right}</View>
        </If>
        {props.children}
      </Scroll>
      <If when={props.right}>
        <Scroll class="hidden shrink-0 xl:flex xl:w-88" contentClass="w-88 py-3 pr-3">
          {props.right}
        </Scroll>
      </If>
    </View>
  );
}

function Search(props: { query: string; onChange: (q: string) => void; placeholder: string; ground?: Ground; onGround?: (g: Ground) => void }) {
  return (
    <View class="flex-row flex-wrap items-center gap-2">
      <View class="min-w-48 flex-1">
        <TextInput
          testID="catalog-search"
          accessibilityLabel={t("web.catalog.find")}
          placeholder={props.placeholder}
          value={props.query}
          onInput={props.onChange}
        />
      </View>
      <If when={props.ground && props.onGround ? props.ground : undefined}>
        {(g) => <Segmented label={t("web.catalog.background")} value={g()} options={grounds} onChange={(v) => props.onGround?.(v)} />}
      </If>
    </View>
  );
}

function ShelfButton(props: { id: string; label: string; count: number; on: boolean; onPress: () => void }) {
  return (
    <View
      role="button"
      testID={`shelf-${props.id}`}
      accessibilityState={{ selected: props.on }}
      onPress={props.onPress}
      class={`w-full flex-row items-center rounded-md px-2 py-1.5 ${props.on ? "bg-selected" : "hover:bg-hover"}`}
    >
      <Text class={`flex-1 text-sm text-ink ${props.on ? "font-semibold" : ""}`}>{props.label}</Text>
      <Text class="text-xs text-muted">{props.count}</Text>
    </View>
  );
}

function Tile(props: { p: Picture; selected: boolean; has: (n: string) => boolean; ground: Ground }) {
  const router = useRouter();
  return (
    <View
      role="button"
      testID="picture"
      accessibilityLabel={props.p.name}
      accessibilityState={{ selected: props.selected }}
      tooltip={<Bubble text={`${props.p.name} · ${numberText(props.p.w)}×${numberText(props.p.h)}`} />}
      onPress={() => router.navigate(`/catalog/${encodeURIComponent(props.p.name)}`)}
      class={`w-22 items-center gap-1 rounded-lg p-1 ${props.selected ? "bg-selected" : "hover:bg-hover"}`}
    >
      <GroundBox ground={props.ground} class="h-20 w-20 items-center justify-center rounded-md">
        <Img p={props.p} scale={fitScale(props.p, 72)} />
        <If when={framesOf(props.p.name, props.has)}>
          <View class="rounded-xs bg-catalog-shade px-1" style={{ position: "absolute", top: 2, right: 2 }}>
            <Text class="text-2xs text-paper">{t("web.catalog.moves")}</Text>
          </View>
        </If>
      </GroundBox>
      <Text class="w-full truncate text-center font-mono text-2xs text-muted">{props.p.name}</Text>
    </View>
  );
}

function Sprites(props: { id?: string | undefined; tabs: JSX.Element }) {
  const pictures = usePictures();
  const shelf = signal("all");
  const query = signal("");
  const ground = signal<Ground>("check");
  const byName = createMemo(() => new Map((pictures() ?? []).map((p) => [p.name, p])));
  const has = (n: string) => byName().has(n);
  const selected = () => (props.id ? byName().get(props.id) : undefined);
  const counts = createMemo(() => {
    const c = new Map<string, number>();
    for (const p of pictures() ?? []) c.set(shelfOf(p.name), (c.get(shelfOf(p.name)) ?? 0) + 1);
    return c;
  });
  // Memos: there are hundreds of pictures, and every shelf's card reads them.
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
  return (
    <If when={pictures()}>
      {(pics) => (
        <Layout
          left={
            <Column tabs={props.tabs}>
              <View accessibilityLabel={t("web.catalog.categories")} testID="catalog-shelves" class="gap-0.5">
                <ShelfButton id="all" label={t("web.catalog.all")} count={pics().length} on={shelf() === "all"} onPress={() => shelf.set("all")} />
                <Each of={present()}>
                  {(s) => (
                    <ShelfButton id={s().id} label={s().label} count={counts().get(s().id) ?? 0} on={shelf() === s().id} onPress={() => shelf.set(s().id)} />
                  )}
                </Each>
              </View>
              <Text class="px-2 pt-1 text-xs text-muted">{t("web.catalog.count", { n: pics().length })}</Text>
            </Column>
          }
          right={
            <Each of={selected() ? [selected() as Picture] : []} key={(p) => p.name}>
              {(s) => <Detail picture={s()} has={has} byName={byName()} ground={ground()} />}
            </Each>
          }
        >
          <Search query={query()} onChange={(q) => query.set(q)} placeholder={t("web.catalog.findHint")} ground={ground()} onGround={(g) => ground.set(g)} />
          <If when={!selected()}>
            <View class="xl:hidden">
              <Quiet>{t("web.catalog.pick")}</Quiet>
            </View>
          </If>
          <If when={shown().length === 0}>
            <Quiet>{t("web.catalog.noMatch")}</Quiet>
          </If>
          <Each of={visible()} key={(s) => s.id}>
            {(s) => {
              const groups = () => groupsByShelf().get(s().id) ?? [];
              return (
                <If when={groups().length > 0}>
                  <Card
                    title={`${s().label} · ${groups().reduce((n, g) => n + g.pictures.length, 0)}`}
                    action={<Text class="truncate text-xs text-muted">{s().hint}</Text>}
                  >
                    <Each of={groups()} key={(g) => g.key}>
                      {(g) => (
                        <View class="gap-1.5">
                          <If when={g().label}>
                            <Text class="text-xs font-semibold text-muted">{g().label}</Text>
                          </If>
                          <View class="flex-row flex-wrap gap-1.5">
                            <Each of={g().pictures} key={(p) => p.name}>
                              {(p) => <Tile p={p()} selected={selected()?.name === p().name} has={has} ground={ground()} />}
                            </Each>
                          </View>
                        </View>
                      )}
                    </Each>
                  </Card>
                </If>
              );
            }}
          </Each>
        </Layout>
      )}
    </If>
  );
}

function Cursors(props: { tabs: JSX.Element }) {
  const ground = signal<Ground>("check");
  const query = signal("");
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
          <Text class="px-2 pt-1 text-xs text-muted">{t("web.catalog.cursorsIntro")}</Text>
        </Column>
      }
    >
      <Search query={query()} onChange={(q) => query.set(q)} placeholder={t("web.catalog.cursorsFind")} ground={ground()} onGround={(g) => ground.set(g)} />
      <Card title={t("web.catalog.cursors", { n: all()?.length ?? 0 })}>
        <Text class="text-sm text-muted">{t("web.catalog.cursorsNote")}</Text>
        <If when={data() !== null} else={<Quiet>{t("web.catalog.noCursors")}</Quiet>}>
          <View class="flex-row flex-wrap gap-1.5">
            <Each of={all() ?? []} key={([name]) => name}>
              {(c) => <CursorTile name={c()[0]} hx={c()[1].hx} hy={c()[1].hy} ground={ground()} />}
            </Each>
          </View>
        </If>
      </Card>
    </Layout>
  );
}

function Sounds(props: { tabs: JSX.Element }) {
  const query = signal("");
  const matches = (group: string, name: SoundName) => {
    const q = query().trim().toLowerCase();
    return !q || [group, name, SOUND_LABEL[name]].some((w) => spelled(w, q));
  };
  return (
    <Layout
      left={
        <Column tabs={props.tabs}>
          <Text class="px-2 pt-1 text-xs text-muted">{t("web.catalog.soundsIntro")}</Text>
        </Column>
      }
    >
      <Search query={query()} onChange={(q) => query.set(q)} placeholder={t("web.catalog.soundsFind")} />
      <Card>
        <Text class="text-sm text-muted">
          {t("web.catalog.soundsRecipes")} <Text class="font-mono text-xs">ui/vv/web/ui/pixel/sound.ts</Text>
          {t("web.catalog.soundsMuted")}
        </Text>
      </Card>
      <Each of={SOUND_GROUPS}>
        {(g) => {
          const names = () => g().names.filter((n) => matches(g().title, n));
          return (
            <If when={names().length > 0}>
              <Card title={g().title}>
                <View class="flex-row flex-wrap gap-2">
                  <Each of={names()}>
                    {(name) => (
                      <View
                        role="button"
                        testID="sound"
                        accessibilityLabel={t("web.catalog.playSound", { name: SOUND_LABEL[name()] })}
                        onPress={() => playSound(name())}
                        class="h-8 flex-row items-center gap-2 rounded-md border border-line bg-page pr-3 pl-1.5 hover:bg-hover active:bg-selected"
                      >
                        <Icon name="play" size={16} tone="ink" />
                        <Text class="text-sm font-medium text-ink">{SOUND_LABEL[name()]}</Text>
                        <Text class="font-mono text-xs text-muted">{name()}</Text>
                      </View>
                    )}
                  </Each>
                </View>
              </Card>
            </If>
          );
        }}
      </Each>
    </Layout>
  );
}
