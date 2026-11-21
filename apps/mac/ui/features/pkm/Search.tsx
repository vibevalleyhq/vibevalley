import { keymap, Scroll, Text, View, windowSize } from "nsh";
import { Input } from "nsh/base";

import { t } from "@vibevalley/i18n";
import type { PkmPageSummary, PkmSearchHit, PkmTier } from "@vibevalley/protocol";

import { Dialog } from "../../design/Dialog";
import { Icon } from "../../design/Icon";
import { mix } from "../../design/tone";
import { api } from "../../infra/api";
import { spelled } from "../../infra/base/search";
import { ready } from "../../infra/query";
import { useRouter } from "../../infra/router";
import { createMemo, createSignal, untrack } from "../../infra/solid";
import { defineAtom, useLatest } from "../../infra/state/atom";
import { titleFor } from "./days";
import { tierOrder } from "./outline";
import { pkmHref, usePkmVault } from "./vault";

const opened = defineAtom<{ readonly query: string } | undefined>(undefined);

export const notesSearch = { open: (query = "") => opened.set({ query }) };

export function NotesSearch() {
  return (
    <Dialog open={opened.get() !== undefined} onClose={() => opened.set(undefined)} title={t("web.pkm.search.title")} wide testid="pkm-search">
      <If when={opened.get()}>{(o) => <SearchBody initial={untrack(() => o().query)} onClose={() => opened.set(undefined)} />}</If>
    </Dialog>
  );
}

type Found = { readonly kind: "page"; readonly page: PkmPageSummary } | { readonly kind: "block"; readonly hit: PkmSearchHit };

const keyOf = (f: Found) => (f.kind === "page" ? `page:${f.page.slug}` : `block:${f.hit.block}`);

const pageAt = (path: string) => {
  const m = /^\/pkm\/([^?]+)/u.exec(path);
  return m ? decodeURIComponent(m[1] ?? "") : undefined;
};

function SearchBody(props: { initial: string; onClose: () => void }) {
  const router = useRouter();
  const vault = usePkmVault();
  const [query, setQuery] = createSignal(untrack(() => props.initial));
  const [tier, setTier] = createSignal<PkmTier>();
  const [todo, setTodo] = createSignal(false);
  const [linked, setLinked] = createSignal(false);
  const [active, setActive] = createSignal(0);
  const here = untrack(() => pageAt(router.path()));
  const request = () => {
    const text = query().trim();
    if (!text && !tier() && !todo() && !linked()) return undefined;
    return { text, tier: tier(), todo: todo(), linked: linked() };
  };
  const found = useLatest(
    request,
    (r) =>
      api.pkm.search({
        ...(r.text ? { text: r.text } : {}),
        ...(r.tier ? { tier: r.tier } : {}),
        ...(r.todo ? { marker: "TODO" as const } : {}),
        ...(r.linked && here ? { linkedTo: here } : {}),
        limit: 40,
      }),
    150,
  );
  const words = () =>
    query()
      .trim()
      .toLowerCase()
      .split(/\s+/u)
      .filter((w) => w !== "");
  const rows = createMemo((): Found[] => {
    const typed = query().trim().toLowerCase();
    const pages = (ready(vault, undefined)?.pages ?? [])
      .filter((p) => typed !== "" && (!tier() || p.tier === tier()) && spelled(p.title, typed))
      .slice(0, 6)
      .map((page): Found => ({ kind: "page", page }));
    const a = found();
    const hits = a?.state === "done" ? a.value : [];
    return [...pages, ...hits.map((hit): Found => ({ kind: "block", hit }))];
  });
  const days = createMemo(() => new Map((ready(vault, undefined)?.pages ?? []).flatMap((p) => (p.day ? [[p.slug, p.day] as const] : []))));
  const groups = createMemo(() => {
    const out: { readonly key: string; readonly title: string; readonly rows: { readonly row: Found; readonly index: number }[] }[] = [];
    for (const [index, row] of rows().entries()) {
      const key = row.kind === "page" ? "pages" : row.hit.page;
      const title = row.kind === "page" ? t("web.pkm.search.pages") : titleFor(row.hit.pageTitle, days().get(row.hit.page));
      const last = out.at(-1);
      if (last?.key === key) last.rows.push({ row, index });
      else out.push({ key, title, rows: [{ row, index }] });
    }
    return out;
  });
  const open = (row: Found) => {
    props.onClose();
    router.navigate(row.kind === "page" ? pkmHref(row.page.slug) : pkmHref(row.hit.page, row.hit.block));
  };
  const pick = (change: () => void) => {
    change();
    setActive(0);
  };
  const move = (by: number) => {
    const n = rows().length;
    if (n === 0) return;
    setActive((i) => (i + by + n) % n);
  };
  keymap.bind({ up: () => move(-1), down: () => move(1) }, { when: "always" });
  return (
    <View class="gap-3">
      <View class="h-10 flex-row items-center gap-2 rounded-md border border-line bg-page px-3 transition duration-120 ease-out hover:border-faint focus-within:border-focus">
        <Icon name="search" size={16} tone="muted" />
        <Input
          autoFocus
          testID="pkm-search-input"
          value={query()}
          placeholder={t("web.pkm.search.placeholder")}
          accessibilityLabel={t("web.pkm.search.title")}
          submitBehavior="submit"
          onChange={(e) => {
            setQuery(e.value);
            setActive(0);
          }}
          onSubmit={() => {
            const row = active() >= 0 ? rows().at(active()) : undefined;
            if (row) open(row);
          }}
          class="min-w-0 flex-1 text-base text-ink"
        />
        <If when={query().length > 0}>
          <View
            role="button"
            accessibilityLabel={t("web.issue.page.clear")}
            onPress={() => {
              setQuery("");
              setActive(0);
            }}
            class="size-5 shrink-0 items-center justify-center rounded-sm hover:bg-hover"
          >
            <Icon name="close" size={12} tone="muted" />
          </View>
        </If>
      </View>
      <View class="flex-row flex-wrap items-center gap-1" accessibilityLabel={t("web.pkm.search.filters")}>
        <Filter on={tier() === undefined} label={t("web.pkm.search.all")} testid="pkm-search-all" onToggle={() => pick(() => setTier(undefined))} />
        <Each of={tierOrder}>
          {(tr) => (
            <Filter
              on={tier() === tr()}
              label={t(`web.pkm.tier.${tr()}`)}
              testid={`pkm-search-${tr()}`}
              onToggle={() => pick(() => setTier((was) => (was === tr() ? undefined : tr())))}
            />
          )}
        </Each>
        <View class="mx-1 h-4 border-l border-line" />
        <Filter on={todo()} label={t("web.pkm.search.todo")} testid="pkm-search-todo" onToggle={() => pick(() => setTodo((on) => !on))} />
        <If when={here}>
          <Filter on={linked()} label={t("web.pkm.search.linked")} testid="pkm-search-linked" onToggle={() => pick(() => setLinked((on) => !on))} />
        </If>
      </View>
      <Scroll accessibilityLabel={t("web.pkm.search.title")} style={{ maxHeight: windowSize().height * 0.6 }} contentClass="gap-3">
        <If when={request() && found()?.state === "done" && rows().length === 0}>
          <Text class="px-2 py-4 text-sm text-muted">{t("web.pkm.search.none")}</Text>
        </If>
        <Each of={groups()} key={(g) => g.key}>
          {(g) => (
            <View class="gap-0.5">
              <Text class="px-2 text-xs font-semibold text-muted">{g().title}</Text>
              <Each of={g().rows} key={(r) => keyOf(r.row)}>
                {(r) => (
                  <View
                    role="button"
                    testID="pkm-search-row"
                    accessibilityState={{ selected: active() === r().index }}
                    onMouseEnter={() => setActive(r().index)}
                    onPress={() => open(r().row)}
                    class={`rounded-md px-2.5 py-1.5 transition duration-120 ease-out ${active() === r().index ? "bg-selected" : "hover:bg-hover"}`}
                  >
                    <FoundRow row={r().row} words={words()} />
                  </View>
                )}
              </Each>
            </View>
          )}
        </Each>
      </Scroll>
      <View class="flex-row items-center gap-3 border-t border-line pt-2">
        <View class="flex-row items-center gap-1">
          <View class="rounded-xs bg-hover px-1.5 py-px">
            <Text class="font-mono text-2xs text-muted">↑↓</Text>
          </View>
          <Text class="text-2xs text-faint">{t("web.base.shortcuts.say.move")}</Text>
        </View>
        <View class="flex-row items-center gap-1">
          <View class="rounded-xs bg-hover px-1.5 py-px">
            <Text class="font-mono text-2xs text-muted">⏎</Text>
          </View>
          <Text class="text-2xs text-faint">{t("web.base.shortcuts.say.pick")}</Text>
        </View>
        <View class="flex-row items-center gap-1">
          <View class="rounded-xs bg-hover px-1.5 py-px">
            <Text class="font-mono text-2xs text-muted">Esc</Text>
          </View>
          <Text class="text-2xs text-faint">{t("web.base.lightbox.close")}</Text>
        </View>
      </View>
    </View>
  );
}

function Lit(props: { text: string; words: readonly string[] }) {
  const parts = () => {
    if (props.words.length === 0) return [{ text: props.text, lit: false }];
    const escaped = props.words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"));
    return props.text
      .split(new RegExp(`(${escaped.join("|")})`, "giu"))
      .filter((p) => p !== "")
      .map((p) => ({ text: p, lit: props.words.includes(p.toLowerCase()) }));
  };
  return (
    <Text class="line-clamp-2 text-sm text-ink">
      {parts().map((p) => (p.lit ? <Text style={{ backgroundColor: mix("wheat", 0.3) }}>{p.text}</Text> : p.text))}
    </Text>
  );
}

function FoundRow(props: { row: Found; words: readonly string[] }) {
  const hit = () => (props.row.kind === "block" ? props.row.hit : undefined);
  return (
    <If when={hit()} else={<Text class="text-sm text-ink">{props.row.kind === "page" ? titleFor(props.row.page.title, props.row.page.day) : ""}</Text>}>
      {(h) => (
        <>
          <If when={h().path}>{(path) => <Text class="truncate text-xs text-faint">{path()}</Text>}</If>
          <Lit text={h().plain} words={props.words} />
        </>
      )}
    </If>
  );
}

function Filter(props: { on: boolean; label: string; testid: string; onToggle: () => void }) {
  return (
    <View
      role="button"
      testID={props.testid}
      accessibilityState={{ selected: props.on }}
      onPress={() => props.onToggle()}
      class={`group h-6 justify-center rounded-full border px-2.5 transition duration-120 ease-out focus-visible:outline-2 focus-visible:outline-focus ${props.on ? "border-accent bg-selected" : "border-transparent hover:bg-hover"}`}
    >
      <Text class={`text-xs font-medium ${props.on ? "text-ink" : "text-muted group-hover:text-ink"}`}>{props.label}</Text>
    </View>
  );
}
