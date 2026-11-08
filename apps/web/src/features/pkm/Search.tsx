import * as stylex from "@stylexjs/stylex";
import { createMemo, createSignal, For, Show, untrack } from "solid-js";

import { t } from "@vibevalley/i18n";
import type { PkmPageSummary, PkmSearchHit, PkmTier } from "@vibevalley/protocol";

import { autofocus } from "#/base/dom.tsx";
import { spelled } from "#/base/search.ts";
import { api } from "#/infra/api.ts";
import { ready } from "#/infra/query.ts";
import { useRouter } from "#/infra/router.ts";
import { defineAtom, useLatest } from "#/state/atom.ts";
import { Dialog } from "#/ui/Dialog.tsx";
import { Icon } from "#/ui/Icon.tsx";

import { titleFor } from "./days";
import { tierOrder } from "./outline";
import { pkmHref, usePkmVault } from "./vault";

const viewStyles = stylex.create({
  searchBodyDiv: {
    display: "flex",
    flexDirection: "column",
    gap: "calc(var(--spacing) * 3)",
  },
  searchBodyLabel: {
    display: "flex",
    height: "calc(var(--spacing) * 10)",
    alignItems: "center",
    gap: "calc(var(--spacing) * 2)",
    borderRadius: "var(--radius-md)",
    borderStyle: "solid",
    borderWidth: "1px",
    borderColor: {
      default: "var(--wb-line)",
      ":focus-within": "var(--wb-focus)",
    },
    backgroundColor: "var(--wb-page)",
    paddingInline: "calc(var(--spacing) * 3)",
  },
  pkmSearchInput: {
    minWidth: "0",
    flex: "1",
    backgroundColor: "transparent",
    fontSize: "var(--text-base)",
    lineHeight: "var(--text-base--line-height)",
    outlineStyle: "none",
    color: {
      default: null,
      "::placeholder": "var(--wb-faint)",
    },
  },
  searchBodyDiv2: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "var(--spacing)",
  },
  searchBodySpan: {
    marginInline: "var(--spacing)",
    height: "calc(var(--spacing) * 4)",
    borderLeftStyle: "solid",
    borderLeftWidth: "1px",
    borderColor: "var(--wb-line)",
  },
  searchBodyDiv3: {
    display: "flex",
    maxHeight: "60vh",
    flexDirection: "column",
    gap: "calc(var(--spacing) * 3)",
    overflowY: "auto",
  },
  searchBodyP: {
    paddingInline: "calc(var(--spacing) * 2)",
    paddingBlock: "calc(var(--spacing) * 4)",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    color: "var(--wb-muted)",
  },
  searchBodySection: {
    display: "flex",
    flexDirection: "column",
    gap: "calc(var(--spacing) * .5)",
  },
  searchBodyH3: {
    paddingInline: "calc(var(--spacing) * 2)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    fontWeight: "var(--font-weight-semibold)",
    color: "var(--wb-muted)",
  },
  litMark: {
    borderRadius: "var(--radius-xs)",
    backgroundColor: {
      default: "var(--wb-wheat)",
      "@supports (color:color-mix(in lab, red, red))": "color-mix(in oklab, var(--wb-wheat) 30%, transparent)",
    },
    color: "var(--wb-ink)",
  },
  foundRowSpan: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
  },
  foundRowSpan2: {
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--wb-faint)",
  },
});

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
    <div {...stylex.attrs(viewStyles.searchBodyDiv)}>
      <label {...stylex.attrs(viewStyles.searchBodyLabel)}>
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
          {...stylex.attrs(viewStyles.pkmSearchInput)}
        />
      </label>
      <div {...stylex.attrs(viewStyles.searchBodyDiv2)} role="group" aria-label={t("web.pkm.search.filters")}>
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
        <span {...stylex.attrs(viewStyles.searchBodySpan)} />
        <Filter on={todo()} label={t("web.pkm.search.todo")} testid="pkm-search-todo" onToggle={() => pick(() => setTodo((on) => !on))} />
        <Show when={here}>
          <Filter on={linked()} label={t("web.pkm.search.linked")} testid="pkm-search-linked" onToggle={() => pick(() => setLinked((on) => !on))} />
        </Show>
      </div>
      <div role="listbox" aria-label={t("web.pkm.search.title")} {...stylex.attrs(viewStyles.searchBodyDiv3)}>
        <Show when={request() && found()?.state === "done" && rows().length === 0}>
          <p {...stylex.attrs(viewStyles.searchBodyP)}>{t("web.pkm.search.none")}</p>
        </Show>
        <For each={groups()} keyed={(g) => g.key}>
          {(g) => (
            <section {...stylex.attrs(viewStyles.searchBodySection)}>
              <h3 {...stylex.attrs(viewStyles.searchBodyH3)}>{g().title}</h3>
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
          <mark {...stylex.attrs(viewStyles.litMark)}>{p.text}</mark>
        </Show>
      )}
    </For>
  );
}

function FoundRow(props: { row: Found; words: readonly string[] }) {
  const hit = () => (props.row.kind === "block" ? props.row.hit : undefined);
  return (
    <Show
      when={hit()}
      fallback={<span {...stylex.attrs(viewStyles.foundRowSpan)}>{props.row.kind === "page" ? titleFor(props.row.page.title, props.row.page.day) : ""}</span>}
    >
      {(h) => (
        <>
          <Show when={h().path}>{(path) => <span {...stylex.attrs(viewStyles.foundRowSpan2)}>{path()}</span>}</Show>
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
