import { Scroll, signal, Text, View, type JSX } from "nsh";

import { t } from "@vibevalley/i18n";

import { SearchField } from "../../design/Field";
import { Icon } from "../../design/Icon";
import { Banner } from "../../design/layout";
import { motionClass } from "../../design/motion";
import { playSound, SOUND_GROUPS, SOUND_LABEL, type SoundName } from "../../design/pixel/sound";
import { Segmented } from "../../design/Segmented";
import { Tabs } from "../../design/Tabs";
import { CountPill } from "../../design/Tag";
import { Bubble } from "../../design/Tip";
import { numberText } from "../../infra/base/format";
import { spelled } from "../../infra/base/search";
import { useTimeout } from "../../infra/base/timer";
import { cursorsQuery, ready, useQuery, useSprites } from "../../infra/query";
import { useRouter } from "../../infra/router";
import { createMemo } from "../../infra/solid";
import { CursorTile, Detail, fitScale, type Ground, GroundBox, grounds, Img } from "./CatalogDetail";
import { framesOf, groupsOf, type Picture, pictureMatches, picturesOf, shelfOf, shelves } from "./shelves";

const usePictures = () => {
  const query = useSprites();
  return createMemo(() => {
    const manifest = ready(query, undefined);
    return manifest ? picturesOf(manifest) : undefined;
  });
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
    <View class="gap-2.5">
      <View class="border-b border-line pb-2.5">{props.tabs}</View>
      {props.children}
    </View>
  );
}

function Layout(props: { left: JSX.Element; children: JSX.Element; right?: JSX.Element; hasRight?: boolean }) {
  const showRight = () => props.right !== undefined && props.hasRight !== false;
  return (
    // The shelves are the page's side column, against the rail as the chat's and the notes' are (ui/layout.tsx Split edge).
    <View class="h-full min-h-0 flex-1 lg:flex-row">
      <Scroll class="max-h-60 shrink-0 border-b border-line bg-side lg:max-h-none lg:w-60 lg:border-r lg:border-b-0" contentClass="px-2.5 py-3">
        {props.left}
      </Scroll>
      <Scroll class="min-h-0 min-w-0 flex-1" contentClass="gap-3 p-3.5">
        <If when={showRight()}>
          <View class="xl:hidden">{props.right}</View>
        </If>
        {props.children}
      </Scroll>
      <If when={showRight()}>
        <Scroll class="hidden shrink-0 xl:flex xl:w-92" contentClass="w-92 py-3.5 pr-3.5">
          {props.right}
        </Scroll>
      </If>
    </View>
  );
}

function Search(props: {
  query: string;
  onChange: (q: string) => void;
  placeholder: string;
  countText?: string | undefined;
  ground?: Ground;
  onGround?: (g: Ground) => void;
}) {
  return (
    <View class="flex-row flex-wrap items-center gap-2">
      <SearchField
        testid="catalog-search"
        value={props.query}
        onInput={props.onChange}
        placeholder={props.placeholder}
        label={t("web.catalog.find")}
        class="min-w-48 flex-1"
      />
      <If when={props.countText}>
        {(text) => (
          <View class="h-7 shrink-0 items-center justify-center rounded-md bg-side px-2">
            <Text class="font-mono text-2xs font-medium text-muted tabular-nums">{text()}</Text>
          </View>
        )}
      </If>
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
      class={`group h-7.5 w-full flex-row items-center gap-2 rounded-md px-2 focus-visible:outline-2 focus-visible:outline-focus ${
        props.on ? "bg-selected" : "hover:bg-hover"
      }`}
    >
      <Text class={`min-w-0 flex-1 truncate text-sm text-ink ${props.on ? "font-semibold" : "font-normal"}`}>{props.label}</Text>
      <CountPill count={props.count} active={props.on} hoverBright />
    </View>
  );
}

function ShelfSection(props: { title: string; count: string; hint?: string; children: JSX.Element }) {
  const open = signal(true);
  return (
    <View class="overflow-hidden rounded-lg border border-line bg-page">
      <View
        role="button"
        accessibilityState={{ expanded: open() }}
        onPress={() => open.set(!open())}
        class={`group min-h-10.5 flex-row items-center gap-2 px-3.5 py-2 hover:bg-hover focus-visible:outline-2 focus-visible:outline-focus ${
          open() ? "border-b border-line" : ""
        }`}
      >
        <View
          class={`size-3.5 shrink-0 items-center justify-center ${motionClass("transition-transform duration-120 ease-out")}`}
          style={{ transform: [{ rotate: open() ? "90deg" : "0deg" }] }}
        >
          <Icon name="expand" size={10} tone="muted" />
        </View>
        <Text role="header" class="shrink-0 text-sm font-semibold text-ink">
          {props.title}
        </Text>
        <CountPill count={props.count} />
        <If when={props.hint}>
          {(hint) => (
            <View tooltip={<Bubble text={hint()} />} class="min-w-0 flex-1 items-end">
              <Text class="max-w-full truncate text-xs text-faint group-hover:text-muted">{hint()}</Text>
            </View>
          )}
        </If>
      </View>
      <If when={open()}>
        <View class="gap-3.5 p-3.5">{props.children}</View>
      </If>
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
      class={`group w-23 items-center gap-1.5 rounded-lg border p-1 focus-visible:outline-2 focus-visible:outline-focus ${
        props.selected ? "border-accent bg-selected" : "border-transparent hover:bg-hover"
      }`}
    >
      <GroundBox ground={props.ground} class="h-20 w-20 items-center justify-center rounded-md border border-line">
        <Img p={props.p} scale={fitScale(props.p, 72)} />
        <If when={framesOf(props.p.name, props.has)}>
          <View class="absolute top-[3px] right-[3px] rounded-xs bg-catalog-shade px-1 py-px">
            <Text class="text-2xs font-medium text-paper">{t("web.catalog.moves")}</Text>
          </View>
        </If>
      </GroundBox>
      <Text class={`w-full truncate text-center font-mono text-2xs font-medium ${props.selected ? "text-ink" : "text-muted group-hover:text-ink"}`}>
        {props.p.name}
      </Text>
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
  const selected = createMemo(() => (props.id ? byName().get(props.id) : undefined));
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
  const present = createMemo(() => shelves.filter((s) => (counts().get(s.id) ?? 0) > 0));
  const visible = createMemo(() => (shelf() === "all" ? present() : present().filter((s) => s.id === shelf())));
  const filtering = createMemo(() => query().trim() !== "");
  return (
    <If when={pictures()}>
      {(pics) => (
        <Layout
          hasRight={selected() !== undefined}
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
              <Text class="border-t border-line px-2 pt-2.5 text-xs leading-relaxed text-faint tabular-nums">
                {t("web.catalog.count", { n: pics().length })}
              </Text>
            </Column>
          }
          right={
            <Each
              of={(() => {
                const s = selected();
                return s ? [s] : [];
              })()}
              key={(p) => p.name}
            >
              {(s) => <Detail picture={s()} has={has} byName={byName()} ground={ground()} />}
            </Each>
          }
        >
          <Search
            query={query()}
            onChange={(q) => query.set(q)}
            placeholder={t("web.catalog.findHint")}
            countText={filtering() ? `${shown().length} / ${pics().length}` : undefined}
            ground={ground()}
            onGround={(g) => ground.set(g)}
          />
          <If when={!selected() && shown().length > 0}>
            <Banner tone="info" size="sm">
              {t("web.catalog.pick")}
            </Banner>
          </If>
          <If when={shown().length === 0}>
            <Banner tone="info" size="sm">
              {t("web.catalog.noMatch")}
            </Banner>
          </If>
          <Each of={visible()} key={(s) => s.id}>
            {(s) => {
              const groups = () => groupsByShelf().get(s().id) ?? [];
              const shownCount = () => groups().reduce((n, g) => n + g.pictures.length, 0);
              const totalCount = () => counts().get(s().id) ?? shownCount();
              const badge = () => (shownCount() < totalCount() ? `${shownCount()} / ${totalCount()}` : String(shownCount()));
              return (
                <If when={groups().length > 0}>
                  <ShelfSection title={s().label} count={badge()} hint={s().hint}>
                    <Each of={groups()} key={(g) => g.key}>
                      {(g) => (
                        <View class="gap-2">
                          <If when={g().label}>
                            <View class="flex-row items-center gap-2">
                              <Text class="shrink-0 text-xs font-semibold text-muted">{g().label}</Text>
                              <Text class="shrink-0 font-mono text-2xs text-faint tabular-nums">{String(g().pictures.length)}</Text>
                              <View class="h-px flex-1 bg-line" />
                            </View>
                          </If>
                          <View class="flex-row flex-wrap gap-1.5">
                            <Each of={g().pictures} key={(p) => p.name}>
                              {(p) => <Tile p={p()} selected={selected()?.name === p().name} has={has} ground={ground()} />}
                            </Each>
                          </View>
                        </View>
                      )}
                    </Each>
                  </ShelfSection>
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
  const data = createMemo(() => ready(cursors, undefined));
  const total = createMemo(() => Object.keys(data() ?? {}).length);
  const all = createMemo(() => {
    const q = query().trim().toLowerCase();
    const d = data();
    return d ? Object.entries(d).filter(([name]) => !q || spelled(name, q)) : undefined;
  });
  const countBadge = createMemo(() => {
    const n = all()?.length ?? 0;
    return total() > 0 && n < total() ? `${n} / ${total()}` : String(n);
  });
  return (
    <Layout
      left={
        <Column tabs={props.tabs}>
          <Text class="px-2 text-xs leading-relaxed text-muted">{t("web.catalog.cursorsIntro")}</Text>
        </Column>
      }
    >
      <Search
        query={query()}
        onChange={(q) => query.set(q)}
        placeholder={t("web.catalog.cursorsFind")}
        countText={query().trim() !== "" && total() > 0 ? `${all()?.length ?? 0} / ${total()}` : undefined}
        ground={ground()}
        onGround={(g) => ground.set(g)}
      />
      <ShelfSection title={t("web.catalog.tab.cursors")} count={countBadge()}>
        <Text class="text-xs leading-relaxed text-muted">{t("web.catalog.cursorsNote")}</Text>
        <If
          when={data() !== null}
          else={
            <Banner tone="info" size="sm">
              {t("web.catalog.noCursors")}
            </Banner>
          }
        >
          <If when={all()?.length === 0}>
            <Banner tone="info" size="sm">
              {t("web.catalog.noMatch")}
            </Banner>
          </If>
          <If when={(all()?.length ?? 0) > 0}>
            <View class="flex-row flex-wrap gap-1.5">
              <Each of={all() ?? []} key={([name]) => name}>
                {(c) => <CursorTile name={c()[0]} hx={c()[1].hx} hy={c()[1].hy} ground={ground()} />}
              </Each>
            </View>
          </If>
        </If>
      </ShelfSection>
    </Layout>
  );
}

function Sounds(props: { tabs: JSX.Element }) {
  const query = signal("");
  const recent = signal<SoundName | undefined>(undefined);
  const clearRecent = useTimeout();
  const matches = (group: string, name: SoundName) => {
    const q = query().trim().toLowerCase();
    return !q || [group, name, SOUND_LABEL[name]].some((w) => spelled(w, q));
  };
  const total = SOUND_GROUPS.reduce((n, g) => n + g.names.length, 0);
  const matchedTotal = createMemo(() => SOUND_GROUPS.reduce((n, g) => n + g.names.filter((name) => matches(g.title, name)).length, 0));
  const trigger = (name: SoundName) => {
    playSound(name);
    recent.set(name);
    clearRecent(() => recent.set(undefined), 700);
  };
  return (
    <Layout
      left={
        <Column tabs={props.tabs}>
          <Text class="px-2 text-xs leading-relaxed text-muted">{t("web.catalog.soundsIntro")}</Text>
        </Column>
      }
    >
      <Search
        query={query()}
        onChange={(q) => query.set(q)}
        placeholder={t("web.catalog.soundsFind")}
        countText={query().trim() !== "" ? `${matchedTotal()} / ${total}` : undefined}
      />
      <Banner tone="info" size="sm" icon="audio">
        <Text class="text-xs leading-relaxed text-muted">
          {t("web.catalog.soundsRecipes")} <Text class="font-mono text-2xs text-ink">ui/design/pixel/sound.ts</Text>
          {t("web.catalog.soundsMuted")}
        </Text>
      </Banner>
      <If when={matchedTotal() === 0}>
        <Banner tone="info" size="sm">
          {t("web.catalog.noMatch")}
        </Banner>
      </If>
      <Each of={SOUND_GROUPS}>
        {(g) => {
          const names = createMemo(() => g().names.filter((n) => matches(g().title, n)));
          const badge = createMemo(() => (names().length < g().names.length ? `${names().length} / ${g().names.length}` : String(names().length)));
          return (
            <If when={names().length > 0}>
              <ShelfSection title={g().title} count={badge()}>
                <View class="flex-row flex-wrap gap-2">
                  <Each of={names()}>
                    {(name) => {
                      const active = () => recent() === name();
                      return (
                        <View
                          role="button"
                          testID="sound"
                          accessibilityLabel={t("web.catalog.playSound", { name: SOUND_LABEL[name()] })}
                          tooltip={<Bubble text={t("web.catalog.playSound", { name: SOUND_LABEL[name()] })} />}
                          onPress={() => trigger(name())}
                          class={`h-8 flex-row items-center gap-2 rounded-md border px-2.5 ${motionClass("transition-transform duration-120 ease-out")} active:translate-y-px focus-visible:outline-2 focus-visible:outline-focus ${
                            active() ? "border-accent bg-ok-soft" : "border-line bg-page hover:bg-hover active:bg-selected"
                          }`}
                        >
                          <Icon name="play" size={14} tone={active() ? "ok-ink" : "muted"} />
                          <Text class={`text-sm font-medium ${active() ? "text-ok-ink" : "text-ink"}`}>{SOUND_LABEL[name()]}</Text>
                          <Text class={`font-mono text-2xs ${active() ? "text-ok-ink" : "text-faint"}`}>{name()}</Text>
                        </View>
                      );
                    }}
                  </Each>
                </View>
              </ShelfSection>
            </If>
          );
        }}
      </Each>
    </Layout>
  );
}
