import type { JSX } from "@solidjs/web";
import * as stylex from "@stylexjs/stylex";
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
import { styleProps } from "#/ui/positioner.ts";
import { Segmented } from "#/ui/Segmented.tsx";
import { Tabs } from "#/ui/Tabs.tsx";

import { CursorTile, Detail, fitScale, type Ground, grounds, groundStyle, Img } from "./CatalogDetail";
import { framesOf, groupsOf, type Picture, pictureMatches, picturesOf, shelfOf, shelves } from "./shelves";

const styles = stylex.create({
  layoutDiv: {
    display: "flex",
    height: "100%",
    minHeight: "0",
    flexDirection: {
      default: "column",
      "@media (width>=64rem)": "row",
    },
    overflowY: {
      default: "auto",
      "@media (width>=64rem)": "hidden",
    },
    overflowX: {
      default: null,
      "@media (width>=64rem)": "hidden",
    },
  },
  layoutDiv2: {
    flexShrink: "0",
    paddingTop: "0.75rem",
    paddingRight: "0.75rem",
    paddingBottom: "0.75rem",
    paddingLeft: {
      default: "0.75rem",
      "@media (width>=80rem)": "0",
    },
    order: {
      default: null,
      "@media (width>=80rem)": "9999",
    },
    width: {
      default: null,
      "@media (width>=80rem)": "22rem",
    },
    overflowY: {
      default: null,
      "@media (width>=80rem)": "auto",
    },
  },
  spritesSpan: {
    position: "absolute",
    top: "0.125rem",
    right: "0.125rem",
    borderRadius: "var(--radius-xs)",
    backgroundColor: {
      default: "var(--color-catalog-shade)",
      "@supports (color:color-mix(in lab, red, red))": "color-mix(in oklab, var(--color-bark-900) 70%, transparent)",
    },
    paddingInline: "0.25rem",
    fontSize: "var(--text-2xs)",
    lineHeight: "14px",
    color: "var(--color-paper)",
  },
  searchTextInput: {
    minWidth: "12rem",
    flex: "1",
  },
  layoutDiv3: {
    display: "flex",
    minWidth: "0",
    flex: "1",
    flexDirection: "column",
    gap: "0.75rem",
    padding: "0.75rem",
    overflowY: {
      default: null,
      "@media (width>=64rem)": "auto",
    },
  },
  spritesButton: {
    display: "flex",
    width: "100%",
    cursor: "pointer",
    alignItems: "center",
    borderRadius: "var(--radius-md)",
    paddingInline: "0.5rem",
    paddingBlock: "0.375rem",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
  },
  spritesButtonTone: {
    backgroundColor: "var(--color-selected)",
    fontWeight: "var(--font-weight-semibold)",
  },
  spritesButtonAlt: {
    backgroundColor: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-hover)",
      },
    },
  },
  spritesButton2: {
    display: "flex",
    cursor: "pointer",
    flexDirection: "column",
    alignItems: "center",
    gap: "0.25rem",
    borderRadius: "var(--radius-lg)",
    padding: "0.25rem",
    outlineStyle: {
      default: null,
      ":focus-visible": "solid",
    },
    outlineWidth: {
      default: null,
      ":focus-visible": "2px",
    },
    outlineColor: {
      default: null,
      ":focus-visible": "var(--color-focus)",
    },
  },
  spritesButtonAccent: {
    backgroundColor: "var(--color-selected)",
  },
  catalogPageDiv: {
    height: "100%",
  },
  columnDiv: {
    display: "flex",
    flexDirection: "column",
    gap: "0.5rem",
  },
  layoutDiv4: {
    flexShrink: "0",
    borderBottomStyle: {
      default: "solid",
      "@media (width>=64rem)": "solid",
    },
    borderBottomWidth: {
      default: "1px",
      "@media (width>=64rem)": "0",
    },
    borderColor: "var(--color-line)",
    backgroundColor: "var(--color-side)",
    paddingInline: "0.5rem",
    paddingBlock: "0.75rem",
    width: {
      default: null,
      "@media (width>=64rem)": "15rem",
    },
    overflowY: {
      default: null,
      "@media (width>=64rem)": "auto",
    },
    borderRightStyle: {
      default: null,
      "@media (width>=64rem)": "solid",
    },
    borderRightWidth: {
      default: null,
      "@media (width>=64rem)": "1px",
    },
  },
  searchDiv: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "0.5rem",
  },
  shelfButtonSpan: {
    flex: "1",
    textAlign: "left",
  },
  shelfButtonSpan2: {
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    fontWeight: "var(--font-weight-normal)",
    color: "var(--color-muted)",
  },
  catalogShelves: {
    display: "flex",
    flexDirection: "column",
    gap: "0.125rem",
  },
  spritesP: {
    paddingInline: "0.5rem",
    paddingTop: "0.25rem",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    color: "var(--color-muted)",
  },
  spritesSpan2: {
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    color: "var(--color-muted)",
  },
  spritesDiv: {
    display: "flex",
    flexDirection: "column",
    gap: "0.375rem",
  },
  spritesSpan22: {
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    fontWeight: "var(--font-weight-semibold)",
    color: "var(--color-muted)",
  },
  spritesDiv2: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill,minmax(88px,1fr))",
    gap: "0.375rem",
  },
  spritesSpan3: {
    position: "relative",
    display: "flex",
    width: "5rem",
    height: "5rem",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    borderRadius: "var(--radius-md)",
  },
  spritesSpan4: {
    width: "100%",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textAlign: "center",
    fontFamily: "var(--font-mono)",
    fontSize: "var(--text-2xs)",
    lineHeight: "var(--leading-2xs)",
    color: "var(--color-muted)",
  },
  cursorsP: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
    color: "var(--color-muted)",
  },
  cursorsDiv: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill,minmax(104px,1fr))",
    gap: "0.375rem",
  },
  soundsCode: {
    fontFamily: "var(--font-mono)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
  },
  soundsDiv: {
    display: "flex",
    flexWrap: "wrap",
    gap: "0.5rem",
  },
  sound: {
    display: "flex",
    height: "2rem",
    cursor: "pointer",
    alignItems: "center",
    gap: "0.5rem",
    borderRadius: "var(--radius-md)",
    borderStyle: "solid",
    borderWidth: "1px",
    borderColor: "var(--color-line)",
    backgroundColor: {
      default: "var(--color-page)",
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-hover)",
      },
      ":active": "var(--color-selected)",
    },
    paddingRight: "0.75rem",
    paddingLeft: "0.375rem",
  },
  soundsSpan: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
    fontWeight: "var(--font-weight-medium)",
  },
  soundsSpan2: {
    fontFamily: "var(--font-mono)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    color: "var(--color-muted)",
  },
});

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
    <div {...stylex.attrs(styles.catalogPageDiv)}>
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
    <div {...stylex.attrs(styles.columnDiv)}>
      {props.tabs}
      {props.children}
    </div>
  );
}

function Layout(props: { left: JSX.Element; children: JSX.Element; right?: JSX.Element }) {
  return (
    // The shelves are the page's side column, against the rail as the chat's and the notes' are (ui/layout.tsx Split edge).
    <div {...stylex.attrs(styles.layoutDiv)}>
      <div {...stylex.attrs(styles.layoutDiv4)}>{props.left}</div>
      <Show when={props.right}>
        <div {...stylex.attrs(styles.layoutDiv2)}>{props.right}</div>
      </Show>
      <div {...stylex.attrs(styles.layoutDiv3)}>{props.children}</div>
    </div>
  );
}

function Search(props: { query: string; onChange: (q: string) => void; placeholder: string; ground?: Ground; onGround?: (g: Ground) => void }) {
  return (
    <div {...stylex.attrs(styles.searchDiv)}>
      <TextInput
        data-testid="catalog-search"
        aria-label={t("web.catalog.find")}
        styles={styles.searchTextInput}
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
      {...stylex.attrs(styles.spritesButton, shelf() === b.id ? styles.spritesButtonTone : styles.spritesButtonAlt)}
    >
      <span {...stylex.attrs(styles.shelfButtonSpan)}>{b.label}</span>
      <span {...stylex.attrs(styles.shelfButtonSpan2)}>{b.count}</span>
    </button>
  );
  return (
    <Show when={pictures()}>
      {(pics) => (
        <Layout
          left={
            <Column tabs={props.tabs}>
              <nav aria-label={t("web.catalog.categories")} data-testid="catalog-shelves" {...stylex.attrs(styles.catalogShelves)}>
                <ShelfButton id="all" label={t("web.catalog.all")} count={pics().length} />
                <For each={present()}>{(s) => <ShelfButton id={s.id} label={s.label} count={counts().get(s.id) ?? 0} />}</For>
              </nav>
              <p {...stylex.attrs(styles.spritesP)}>{t("web.catalog.count", { n: pics().length })}</p>
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
                    action={<span {...stylex.attrs(styles.spritesSpan2)}>{s.hint}</span>}
                  >
                    <For each={groups()}>
                      {(g) => (
                        <div {...stylex.attrs(styles.spritesDiv)}>
                          <Show when={g.label}>
                            <span {...stylex.attrs(styles.spritesSpan22)}>{g.label}</span>
                          </Show>
                          <div {...stylex.attrs(styles.spritesDiv2)}>
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
                                  {...stylex.attrs(
                                    styles.spritesButton2,
                                    selected()?.name === p.name ? styles.spritesButtonAccent : styles.spritesButtonAlt,
                                  )}
                                >
                                  <span {...styleProps([styles.spritesSpan3, groundStyle(ground())])}>
                                    <Img p={p} scale={fitScale(p, 72)} />
                                    <Show when={framesOf(p.name, has)}>
                                      <span {...stylex.attrs(styles.spritesSpan)}>{t("web.catalog.moves")}</span>
                                    </Show>
                                  </span>
                                  <span {...stylex.attrs(styles.spritesSpan4)}>{p.name}</span>
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
          <p {...stylex.attrs(styles.spritesP)}>{t("web.catalog.cursorsIntro")}</p>
        </Column>
      }
    >
      <Search query={query()} onChange={setQuery} placeholder={t("web.catalog.cursorsFind")} ground={ground()} onGround={setGround} />
      <Card title={t("web.catalog.cursors", { n: all()?.length ?? 0 })}>
        <p {...stylex.attrs(styles.cursorsP)}>{t("web.catalog.cursorsNote")}</p>
        <Show when={data() !== null} fallback={<Quiet>{t("web.catalog.noCursors")}</Quiet>}>
          <div {...stylex.attrs(styles.cursorsDiv)}>
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
          <p {...stylex.attrs(styles.spritesP)}>{t("web.catalog.soundsIntro")}</p>
        </Column>
      }
    >
      <Search query={query()} onChange={setQuery} placeholder={t("web.catalog.soundsFind")} />
      <Card>
        <p {...stylex.attrs(styles.cursorsP)}>
          {t("web.catalog.soundsRecipes")} <code {...stylex.attrs(styles.soundsCode)}>apps/web/src/ui/pixel/sound.ts</code>
          {t("web.catalog.soundsMusic")} <code {...stylex.attrs(styles.soundsCode)}>design/music/suno-prompts.md</code>
          {t("web.catalog.period")}
        </p>
      </Card>
      <For each={SOUND_GROUPS}>
        {(g) => {
          const names = () => g.names.filter((n) => matches(g.title, n));
          return (
            <Show when={names().length > 0}>
              <Card title={g.title}>
                <div {...stylex.attrs(styles.soundsDiv)}>
                  <For each={names()}>
                    {(name) => (
                      <button
                        type="button"
                        data-testid="sound"
                        data-key={name}
                        aria-label={t("web.catalog.playSound", { name: SOUND_LABEL[name] })}
                        onClick={() => playSound(name)}
                        {...stylex.attrs(styles.sound)}
                      >
                        <Icon name="play" size={16} />
                        <span {...stylex.attrs(styles.soundsSpan)}>{SOUND_LABEL[name]}</span>
                        <span {...stylex.attrs(styles.soundsSpan2)}>{name}</span>
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
