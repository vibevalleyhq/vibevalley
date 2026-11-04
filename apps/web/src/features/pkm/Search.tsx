import { createMemo, createSignal, For, Show, untrack } from "solid-js";

import { t } from "@vibevalley/i18n";
import type { PkmPageSummary, PkmSearchHit, PkmTier } from "@vibevalley/protocol";

import { autofocus } from "@/base/dom";
import { spelled } from "@/base/search";
import { api } from "@/infra/api";
import { ready } from "@/infra/query";
import { useRouter } from "@/infra/router";
import { defineAtom, useLatest } from "@/state/atom";
import { Dialog } from "@/ui/Dialog";
import { Icon } from "@/ui/Icon";

import { titleFor } from "./days";
import { tierOrder } from "./outline";
import { pkmHref, usePkmVault } from "./vault";

const opened = defineAtom<{ readonly query: string } | undefined>(undefined);

export const notesSearch = { open: (query = "") => opened.set({ query }) };

export function NotesSearch() {
  return (
    <Dialog open={opened.get() !== undefined} onClose={() => opened.set(undefined)} title={t("web.pkm.search.title")} wide testid="pkm-search">
      <SearchBody initial={untrack(() => opened.get()?.query) ?? ""} onClose={() => opened.set(undefined)} />
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
    queueMicrotask(() => document.querySelector('[data-testid="pkm-search"] [aria-selected="true"]')?.scrollIntoView({ block: "nearest" }));
  };
  return (
    <div class="flex flex-col gap-3">
      <label class="flex h-10 items-center gap-2 rounded-md border border-line bg-page px-3 focus-within:border-focus">
        <Icon name="search" size={16} class="text-muted" />
        <input
          ref={autofocus()}
          data-testid="pkm-search-input"
          value={query()}
          placeholder={t("web.pkm.search.placeholder")}
          aria-label={t("web.pkm.search.title")}
          onInput={(e) => {
            setQuery(e.currentTarget.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.isComposing) return;
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              move(e.key === "ArrowDown" ? 1 : -1);
            } else if (e.key === "Enter") {
              const row = rows()[active()];
              if (!row) return;
              e.preventDefault();
              open(row);
            }
          }}
          class="min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-faint"
        />
      </label>
      <div class="flex flex-wrap items-center gap-1" role="group" aria-label={t("web.pkm.search.filters")}>
        <Filter on={tier() === undefined} label={t("web.pkm.search.all")} testid="pkm-search-all" onToggle={() => pick(() => setTier(undefined))} />
        <For each={tierOrder}>
          {(tr) => (
            <Filter
              on={tier() === tr}
              label={t(`web.pkm.tier.${tr}`)}
              testid={`pkm-search-${tr}`}
              onToggle={() => pick(() => setTier((was) => (was === tr ? undefined : tr)))}
            />
          )}
        </For>
        <span class="mx-1 h-4 border-l border-line" />
        <Filter on={todo()} label={t("web.pkm.search.todo")} testid="pkm-search-todo" onToggle={() => pick(() => setTodo((on) => !on))} />
        <Show when={here}>
          <Filter on={linked()} label={t("web.pkm.search.linked")} testid="pkm-search-linked" onToggle={() => pick(() => setLinked((on) => !on))} />
        </Show>
      </div>
      <div role="listbox" aria-label={t("web.pkm.search.title")} class="flex max-h-[60vh] flex-col gap-3 overflow-y-auto">
        <Show when={request() && found()?.state === "done" && rows().length === 0}>
          <p class="px-2 py-4 text-sm text-muted">{t("web.pkm.search.none")}</p>
        </Show>
        <For each={groups()} keyed={(g) => g.key}>
          {(g) => (
            <section class="flex flex-col gap-0.5">
              <h3 class="px-2 text-xs font-semibold text-muted">{g().title}</h3>
              <For each={g().rows} keyed={(r) => keyOf(r.row)}>
                {(r) => (
                  <div
                    role="option"
                    data-testid="pkm-search-row"
                    data-key={keyOf(r().row)}
                    aria-selected={active() === r().index ? "true" : "false"}
                    onPointerMove={() => setActive(r().index)}
                    onClick={() => open(r().row)}
                    class="flex cursor-pointer flex-col rounded-md px-2 py-1.5 aria-selected:bg-selected"
                  >
                    <FoundRow row={r().row} words={words()} />
                  </div>
                )}
              </For>
            </section>
          )}
        </For>
      </div>
    </div>
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
    <For each={parts()}>
      {(p) => (
        <Show when={p.lit} fallback={<>{p.text}</>}>
          <mark class="rounded-xs bg-wheat/30 text-ink">{p.text}</mark>
        </Show>
      )}
    </For>
  );
}

function FoundRow(props: { row: Found; words: readonly string[] }) {
  const hit = () => (props.row.kind === "block" ? props.row.hit : undefined);
  return (
    <Show when={hit()} fallback={<span class="text-sm">{props.row.kind === "page" ? titleFor(props.row.page.title, props.row.page.day) : ""}</span>}>
      {(h) => (
        <>
          <Show when={h().path}>{(path) => <span class="truncate text-xs text-faint">{path()}</span>}</Show>
          <span class="line-clamp-2 text-sm">
            <Lit text={h().plain} words={props.words} />
          </span>
        </>
      )}
    </Show>
  );
}

function Filter(props: { on: boolean; label: string; testid: string; onToggle: () => void }) {
  return (
    <button
      type="button"
      data-testid={props.testid}
      aria-pressed={props.on ? "true" : "false"}
      onClick={() => props.onToggle()}
      class={[
        "h-6 cursor-pointer rounded-full px-2.5 text-xs transition-colors duration-120",
        props.on ? "bg-selected text-ink" : "text-muted hover:bg-hover hover:text-ink",
      ]}
    >
      {props.label}
    </button>
  );
}
