// 笔记 (docs/subsystems/pkm.md): the vault's pages on the left, by PARA tier, with a line to jot into today's journal and a
// search; the page open on the right as an outline edited block by block, its backlinks and the rewrites suggested for it.

import type { JSX } from "@solidjs/web";
import { createSignal, For, Match, Show, Switch, untrack } from "solid-js";

import { t } from "@vibevalley/i18n";
import type { PkmBacklink, PkmBlock, PkmBlockOp, PkmComment, PkmPageView, PkmSearchHit, PkmTier, PkmTransclusion } from "@vibevalley/protocol";

import { Keyed } from "@/base/dom";
import { api, reasonOf } from "@/infra/api";
import { queries, ready } from "@/infra/query";
import { useRouter } from "@/infra/router";
import { useLatest } from "@/state/atom";
import { A } from "@/ui/A";
import { createAct } from "@/ui/act";
import { Button } from "@/ui/Button";
import { Select, TextArea } from "@/ui/Field";
import { Icon } from "@/ui/Icon";
import { Empty } from "@/ui/layout";
import { type MoreItem, MoreMenu } from "@/ui/MoreMenu";
import { toast } from "@/ui/toasts";

import { byTier, hasChildren, keyOp, type Piece, piecesOf, tierOrder, visibleBlocks, wordDiff } from "./outline";
import { pkmHref, refreshPkm, usePkmPage, usePkmRadar, usePkmVault } from "./queries";

const tierLabel = (tier: PkmTier) => t(`web.pkm.tier.${tier}`);

/** `rest` is the path after /pkm/: a page's slug. */
export function PkmPage(props: { rest: string }) {
  const vault = usePkmVault();
  const slug = () => (props.rest ? decodeURIComponent(props.rest) : undefined);
  const pages = () => ready(vault, undefined)?.pages ?? [];
  return (
    <div class="flex h-full min-h-0 flex-col gap-3 p-3 lg:flex-row">
      <nav
        aria-label={t("web.pkm.list.label")}
        data-testid="pkm-list"
        class={[slug() ? "hidden lg:flex" : "flex", "min-h-0 shrink-0 flex-col gap-2 rounded-lg border border-line bg-page p-2 lg:w-72"]}
      >
        <Capture />
        <Finder>
          <Show when={vault.error}>
            <p class="px-2 text-xs text-berry">{reasonOf(vault.error)}</p>
          </Show>
          <Radar />
          <div class="-mx-2 flex min-h-0 scroll-fade-y flex-col gap-2 overflow-y-auto px-2">
            <For each={byTier(pages())} keyed={(g) => g.tier}>
              {(group) => (
                <section class="flex flex-col gap-0.5" data-testid="pkm-tier" data-key={group().tier}>
                  <h2 class="px-2 pt-1 text-xs font-semibold text-muted">{tierLabel(group().tier)}</h2>
                  <ul class="flex flex-col gap-0.5">
                    <For each={group().pages} keyed={(p) => p.slug}>
                      {(p) => (
                        <li>
                          <A
                            href={pkmHref(p().slug)}
                            data-testid="pkm-row"
                            data-key={p().slug}
                            aria-current={p().slug === slug() ? "page" : undefined}
                            class={[
                              "flex items-center gap-2 rounded-md px-2 py-1 transition-colors duration-120",
                              p().slug === slug() ? "bg-selected" : "hover:bg-hover",
                            ]}
                          >
                            <span class="min-w-0 flex-1 truncate text-sm">{p().title}</span>
                            <Show when={p().open > 0}>
                              <span class="shrink-0 text-xs text-muted">{t("web.pkm.list.open", { n: p().open })}</span>
                            </Show>
                          </A>
                        </li>
                      )}
                    </For>
                  </ul>
                </section>
              )}
            </For>
          </div>
        </Finder>
      </nav>
      <div class={[slug() ? "flex" : "hidden lg:flex", "min-h-0 min-w-0 flex-1 flex-col gap-2"]}>
        <Show
          when={slug()}
          fallback={
            <Show when={vault.isSuccess}>
              <Empty icon="file" testid="pkm-empty">
                {pages().length === 0 ? t("web.pkm.empty", { root: ready(vault, undefined)?.root ?? "" }) : t("web.pkm.pick")}
              </Empty>
            </Show>
          }
        >
          {(s) => <Keyed key={s()}>{() => <Opened slug={s()} />}</Keyed>}
        </Show>
      </div>
    </div>
  );
}

/** A line into today's journal: Enter sends it and opens the journal. */
function Capture() {
  const router = useRouter();
  const [text, setText] = createSignal("");
  const act = createAct();
  const send = () => {
    const said = text().trim();
    if (!said) return undefined;
    return act.run(async () => {
      const page = await api.pkm.capture({ text: said });
      setText("");
      toast(t("web.pkm.list.captured"));
      void refreshPkm();
      router.navigate(pkmHref(page.slug));
    });
  };
  return (
    <input
      data-testid="pkm-capture"
      value={text()}
      disabled={act.busy()}
      onInput={(e) => setText(e.currentTarget.value)}
      onKeyDown={(e) => {
        if (e.isComposing || e.key !== "Enter") return;
        e.preventDefault();
        void send();
      }}
      placeholder={t("web.pkm.list.capture")}
      aria-label={t("web.pkm.list.capture")}
      class="h-8 min-w-0 rounded-md border border-line bg-page px-2 text-sm outline-none placeholder:text-faint focus:border-focus"
    />
  );
}

/** The search box: while it has words, the hits stand in for the list. */
function Finder(props: { children: JSX.Element }) {
  const [query, setQuery] = createSignal("");
  const found = useLatest(
    () => query().trim() || undefined,
    (text) => api.pkm.search({ text, limit: 20 }),
    200,
  );
  const hits = (): readonly PkmSearchHit[] | undefined => {
    const a = found();
    return a?.state === "done" ? a.value : undefined;
  };
  const failed = () => {
    const a = found();
    return a?.state === "failed" ? a.reason : undefined;
  };
  return (
    <>
      <label class="flex h-7 min-w-0 items-center gap-1.5 rounded-md border border-line bg-page px-2 focus-within:border-focus">
        <Icon name="search" size={14} class="shrink-0 text-muted" />
        <input
          data-testid="pkm-search"
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
          placeholder={t("web.pkm.list.find")}
          aria-label={t("web.pkm.list.find")}
          class="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-faint"
        />
      </label>
      <Show when={query().trim()} fallback={props.children}>
        <Switch>
          <Match when={failed()}>{(reason) => <p class="px-2 text-xs text-berry">{reason()}</p>}</Match>
          <Match when={hits()?.length === 0}>
            <p class="px-2 text-xs text-muted">{t("web.pkm.list.nothingFound")}</p>
          </Match>
        </Switch>
        <ul class="-mx-2 flex min-h-0 scroll-fade-y flex-col gap-0.5 overflow-y-auto px-2">
          <For each={hits() ?? []} keyed={(h) => h.block}>
            {(h) => (
              <li>
                <A href={pkmHref(h().page)} data-testid="pkm-hit" data-key={h().block} class="flex flex-col rounded-md px-2 py-1.5 hover:bg-hover">
                  <span class="truncate text-xs text-muted">
                    {h().pageTitle}
                    <Show when={h().path}> › {h().path}</Show>
                  </span>
                  <span class="line-clamp-2 text-sm">{h().body}</span>
                </A>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </>
  );
}

function Radar() {
  const radar = usePkmRadar();
  return (
    <Show when={ready(radar, undefined)}>
      {(r) => (
        <p data-testid="pkm-radar" class="px-2 text-xs text-muted">
          {t("web.pkm.list.radar", { inbox: r().inbox, stale: r().stale.length, overdue: r().overdue.length })}
        </p>
      )}
    </Show>
  );
}

function Opened(props: { slug: string }) {
  const found = usePkmPage(() => props.slug);
  return (
    <Show
      when={ready(found, undefined)}
      fallback={
        <Show when={found.isError}>
          <Empty icon="file">{t("web.pkm.gone")}</Empty>
        </Show>
      }
    >
      {(view) => <Shown view={view()} />}
    </Show>
  );
}

function Shown(props: { view: PkmPageView }) {
  const router = useRouter();
  const page = () => props.view.page;
  const act = createAct();
  const move = (tier: PkmTier) => {
    const { slug, tier: was } = page();
    if (tier === was) return undefined;
    return act.run(async () => {
      await api.pkm.page.move({ page: slug, tier });
      toast(t("web.pkm.page.moved", { tier: tierLabel(tier) }));
      void refreshPkm();
    });
  };
  const exportIt = () => {
    const { slug } = page();
    return act.run(async () => {
      const { markdown } = await api.pkm.page.export({ page: slug });
      await navigator.clipboard.writeText(markdown);
      toast(t("web.pkm.page.exported"));
    });
  };
  const undo = () =>
    act.run(async () => {
      const done = await api.pkm.undo();
      toast(done.undone ? t("web.pkm.page.undone", { what: done.what ?? "" }) : t("web.pkm.page.nothingToUndo"));
      void refreshPkm();
    });
  const more = (): MoreItem[] => [
    { key: "export", label: t("web.pkm.page.export"), icon: "copy", onSelect: () => void exportIt() },
    { key: "undo", label: t("web.pkm.page.undo"), icon: "undo", onSelect: () => void undo() },
  ];
  const props_ = () => Object.entries(page().props).filter(([k]) => k !== "title" && k !== "tldr");
  return (
    <div data-testid="pkm-page" data-key={page().slug} class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto lg:pl-2">
      <header class="flex flex-col gap-1.5 pt-1">
        <div class="lg:hidden">
          <Button icon="back" onClick={() => router.navigate("/pkm")}>
            {t("web.pkm.list.all")}
          </Button>
        </div>
        <div class="flex items-center gap-2">
          <h1 class="min-w-0 flex-1 truncate text-xl leading-8 font-semibold">{page().title}</h1>
          <Select
            testid="pkm-tier-select"
            label={t("web.pkm.page.tier")}
            size="control"
            value={page().tier}
            options={tierOrder.map((tier) => ({ value: tier, label: tierLabel(tier) }))}
            onChange={(tier) => void move(tier)}
          />
          <MoreMenu label={t("web.pkm.page.more")} testid="pkm-more" items={more()} />
        </div>
        <p class="text-xs text-faint">{t("web.pkm.page.file", { file: page().file })}</p>
        <Show when={props_().length > 0}>
          <div class="flex flex-wrap gap-1">
            <For each={props_()} keyed={([k]) => k}>
              {(entry) => (
                <span class="rounded-md bg-hover px-1.5 py-0.5 text-xs" data-testid="pkm-prop" data-key={entry()[0]}>
                  <span class="text-muted">{entry()[0]}:: </span>
                  <Body text={entry()[1]} refs={props.view.transclusions} />
                </span>
              )}
            </For>
          </div>
        </Show>
        <Show when={page().tldr}>
          <p class="border-l-2 border-line pl-2 text-sm text-muted">{page().tldr}</p>
        </Show>
      </header>
      <Outline view={props.view} />
      <Comments view={props.view} />
      <Backlinks view={props.view} />
    </div>
  );
}

/** A block's text with its [[links]] and #tags as links and its ((refs)) read out. refs: the page's read-out ((refs));
 * without them (a backlink) a ref is a short chip of its id. */
function Body(props: { text: string; refs?: readonly PkmTransclusion[] }) {
  const heading = () => /^#{1,3}\s/u.exec(props.text);
  const shown = () => props.text.slice(heading()?.[0].length ?? 0);
  const drawn = (p: Piece): JSX.Element => {
    switch (p.kind) {
      case "text":
        return <>{p.text}</>;
      case "link":
      case "tag":
        return (
          <A href={pkmHref(p.page)} data-testid="pkm-link" class="text-water hover:underline" onClick={(e: MouseEvent) => e.stopPropagation()}>
            {p.text}
          </A>
        );
      case "remark":
        return (
          <mark data-testid="pkm-remark" title={p.remark} class="rounded-xs bg-transparent text-ink underline decoration-wheat decoration-2 underline-offset-2">
            {p.text}
          </mark>
        );
      case "ref": {
        if (!props.refs)
          return (
            <span data-testid="pkm-ref" title={p.id} class="rounded-xs bg-hover px-1 font-mono text-xs text-muted">
              (({p.id.slice(0, 8)}))
            </span>
          );
        const ref = props.refs.find((x) => x.block === p.id);
        return (
          <span
            data-testid="pkm-ref"
            title={ref?.pageTitle}
            class={["rounded-sm border-l-2 border-water bg-hover px-1", ref?.found === false ? "text-berry" : ""]}
          >
            {ref?.body ?? t("web.pkm.page.missingRef")}
          </span>
        );
      }
    }
  };
  return (
    <span class={["whitespace-pre-wrap", heading() ? "text-base font-semibold" : ""]}>
      <For each={piecesOf(shown())}>{(p) => drawn(p)}</For>
    </span>
  );
}

const markerTone: Record<string, string> = {
  DONE: "text-ok-ink bg-ok-soft",
  CANCELED: "text-faint line-through",
  DOING: "text-warn-ink",
  NOW: "text-warn-ink",
};

function Outline(props: { view: PkmPageView }) {
  const slug = () => props.view.page.slug;
  const [collapsed, setCollapsed] = createSignal<ReadonlySet<string>>(new Set());
  const [editing, setEditing] = createSignal<string>();
  const act = createAct();
  const send = async (ops: PkmBlockOp[]) => {
    if (ops.length === 0) return;
    const at = slug();
    await act.run(async () => {
      const page = await api.pkm.block.apply({ page: at, ops });
      queries.setQueryData<PkmPageView>(["pkm", "page", at], (v) => (v ? { ...v, page } : v));
      void refreshPkm();
    });
  };
  const blocks = () => props.view.page.blocks;
  const shown = () => visibleBlocks(blocks(), collapsed());
  const toggle = (id: string) =>
    setCollapsed((was) => {
      const next = new Set(was);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const append = () => {
    const id = crypto.randomUUID();
    void send([{ op: "append", id, body: "" }]).then(() => setEditing(id));
  };
  return (
    <section data-testid="pkm-outline" class="flex flex-col">
      <For each={shown()} keyed={(b) => b.id}>
        {(b) => (
          <Row
            block={b()}
            view={props.view}
            folded={collapsed().has(b().id)}
            parent={hasChildren(
              blocks(),
              blocks().findIndex((x) => x.id === b().id),
            )}
            editing={editing() === b().id}
            onToggle={() => toggle(b().id)}
            onEdit={(on) => (on ? setEditing(b().id) : setEditing((was) => (was === b().id ? undefined : was)))}
            onFocus={(id) => setEditing(id)}
            send={send}
          />
        )}
      </For>
      <button
        type="button"
        data-testid="pkm-append"
        onClick={append}
        class="mt-1 inline-flex w-fit cursor-pointer items-center gap-1 rounded-md px-2 py-1 text-xs text-muted hover:bg-hover hover:text-ink"
      >
        <Icon name="add" size={12} />
        {t("web.pkm.page.append")}
      </button>
    </section>
  );
}

function Row(props: {
  block: PkmBlock;
  view: PkmPageView;
  folded: boolean;
  parent: boolean;
  editing: boolean;
  onToggle: () => void;
  onEdit: (on: boolean) => void;
  onFocus: (id: string) => void;
  send: (ops: PkmBlockOp[]) => Promise<void>;
}) {
  return (
    <div
      data-testid="pkm-block"
      data-key={props.block.id}
      data-marker={props.block.marker}
      class="group flex items-start gap-1 py-0.5"
      style={{ "padding-left": `${props.block.depth * 20}px` }}
    >
      <button
        type="button"
        aria-label={props.folded ? t("web.pkm.page.expand") : t("web.pkm.page.collapse")}
        aria-expanded={props.parent ? (props.folded ? "false" : "true") : undefined}
        disabled={!props.parent}
        onClick={() => props.onToggle()}
        class="mt-1 flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-xs text-muted hover:bg-hover disabled:cursor-default"
      >
        <Show when={props.parent} fallback={<span class="size-1.5 rounded-full bg-muted" />}>
          <Icon name={props.folded ? "next" : "expand"} size={12} />
        </Show>
      </button>
      <Show when={props.block.marker}>
        {(m) => (
          <button
            type="button"
            data-testid="pkm-marker"
            aria-label={t("web.pkm.page.marker")}
            onClick={() => void props.send([{ op: "toggle_marker", block: props.block.id }])}
            class={["mt-0.5 shrink-0 cursor-pointer rounded-xs px-1 font-mono text-xs hover:bg-hover", markerTone[m()] ?? "text-muted"]}
          >
            {m()}
          </button>
        )}
      </Show>
      <div class="min-w-0 flex-1">
        <Show
          when={props.editing}
          fallback={
            <div
              role="button"
              tabindex="0"
              aria-label={t("web.pkm.page.edit")}
              onClick={() => props.onEdit(true)}
              onKeyDown={(e) => e.key === "Enter" && props.onEdit(true)}
              class={["min-h-6 cursor-text rounded-sm px-1 text-sm leading-6 hover:bg-hover", props.block.marker === "DONE" ? "text-muted line-through" : ""]}
            >
              <Show when={props.block.body} fallback={<span class="text-faint">{t("web.pkm.page.empty")}</span>}>
                <Body text={props.block.body} refs={props.view.transclusions} />
              </Show>
            </div>
          }
        >
          <Editor block={props.block} onEdit={props.onEdit} onFocus={props.onFocus} send={props.send} />
        </Show>
      </div>
    </div>
  );
}

/** One block's text in a box: leaving it or Escape saves; Enter at the end starts the next block; Tab, Shift+Tab, Alt+↑↓
 * and ⌘Enter move or mark it. */
function Editor(props: { block: PkmBlock; onEdit: (on: boolean) => void; onFocus: (id: string) => void; send: (ops: PkmBlockOp[]) => Promise<void> }) {
  const [draft, setDraft] = createSignal(untrack(() => props.block.body));
  const changed = (): PkmBlockOp[] => (draft() !== props.block.body ? [{ op: "update", block: props.block.id, body: draft() }] : []);
  return (
    <TextArea
      data-testid="pkm-editor"
      ref={(el) =>
        queueMicrotask(() => {
          el.focus();
          el.setSelectionRange(el.value.length, el.value.length);
        })
      }
      rows={Math.max(1, draft().split("\n").length)}
      value={draft()}
      onInput={(e) => setDraft(e.currentTarget.value)}
      onBlur={() => {
        void props.send(changed());
        props.onEdit(false);
      }}
      onKeyDown={(e) => {
        if (e.isComposing) return;
        const id = props.block.id;
        const op = keyOp(e, id);
        if (op) {
          e.preventDefault();
          void props.send([...changed(), op]).then(() => props.onFocus(id));
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          e.currentTarget.blur();
          return;
        }
        const el = e.currentTarget;
        if (e.key === "Enter" && !e.shiftKey && el.selectionStart === el.value.length) {
          e.preventDefault();
          const next = crypto.randomUUID();
          void props.send([...changed(), { op: "insert_after", block: id, id: next, body: "" }]).then(() => props.onFocus(next));
        }
      }}
      class="min-h-6 py-0.5 text-sm leading-6"
    />
  );
}

function Comments(props: { view: PkmPageView }) {
  const bodyOf = (block: string) => props.view.page.blocks.find((b) => b.id === block)?.body ?? "";
  return (
    <Show when={props.view.comments.length > 0}>
      <section data-testid="pkm-comments" class="flex flex-col gap-2">
        <h2 class="text-xs font-semibold text-muted">{t("web.pkm.comments.title")}</h2>
        <For each={props.view.comments} keyed={(c) => c.id}>
          {(c) => <CommentCard comment={c()} body={bodyOf(c().block)} slug={props.view.page.slug} />}
        </For>
      </section>
    </Show>
  );
}

function CommentCard(props: { comment: PkmComment; body: string; slug: string }) {
  const act = createAct();
  const resolve = (accept: boolean) => {
    const { id } = props.comment;
    return act.run(async () => {
      await api.pkm.comment.resolve({ id, accept });
      toast(accept ? t("web.pkm.comments.accepted") : t("web.pkm.comments.rejected"));
      void refreshPkm();
    });
  };
  return (
    <div
      data-testid="pkm-comment"
      data-key={props.comment.id}
      data-status={props.comment.status}
      class="flex flex-col gap-1.5 rounded-lg border border-line p-2.5"
    >
      <p class="text-xs text-muted">
        <Show when={props.comment.span}>{(s) => <>{t("web.pkm.comments.on", { span: s() })} · </>}</Show>
        {props.comment.body}
      </p>
      <Show when={props.comment.suggested}>
        {(s) => (
          <p data-testid="pkm-diff" class="text-sm whitespace-pre-wrap">
            <For each={wordDiff(props.body, s())}>
              {(d) => (
                <Switch fallback={<span>{d.text}</span>}>
                  <Match when={d.kind === "del"}>
                    <del class="bg-bad-soft text-berry">{d.text}</del>
                  </Match>
                  <Match when={d.kind === "add"}>
                    <ins class="bg-ok-soft text-ok-ink no-underline">{d.text}</ins>
                  </Match>
                </Switch>
              )}
            </For>
          </p>
        )}
      </Show>
      <div class="flex gap-1.5 self-end">
        <Show when={props.comment.suggested}>
          <Button tone="primary" icon="check" data-testid="pkm-accept" disabled={act.busy()} onClick={() => void resolve(true)}>
            {t("web.pkm.comments.accept")}
          </Button>
        </Show>
        <Button icon="close" data-testid="pkm-reject" disabled={act.busy()} onClick={() => void resolve(false)}>
          {t("web.pkm.comments.reject")}
        </Button>
      </div>
    </div>
  );
}

const backlinkGroups = ["projects", "journals", "areas", "archives"] as const;

function Backlinks(props: { view: PkmPageView }) {
  const any = () => backlinkGroups.some((g) => props.view.backlinks[g].length > 0);
  return (
    <section data-testid="pkm-backlinks" class="flex flex-col gap-2 border-t border-line pt-3">
      <h2 class="text-xs font-semibold text-muted">{t("web.pkm.backlinks.title")}</h2>
      <Show when={any()} fallback={<p class="text-xs text-faint">{t("web.pkm.backlinks.none")}</p>}>
        <For each={backlinkGroups.filter((g) => props.view.backlinks[g].length > 0)}>
          {(g) => (
            <div class="flex flex-col gap-1">
              <h3 class="text-xs text-muted">{t(`web.pkm.backlinks.${g}`)}</h3>
              <For each={props.view.backlinks[g]} keyed={(l) => l.block}>
                {(l) => <BacklinkRow link={l()} />}
              </For>
            </div>
          )}
        </For>
      </Show>
    </section>
  );
}

/** The page and path are the link to it; the body's own links stay links (an anchor cannot hold another). */
function BacklinkRow(props: { link: PkmBacklink }) {
  return (
    <div data-testid="pkm-backlink" data-key={props.link.block} class="flex flex-col rounded-md px-2 py-1.5 hover:bg-hover">
      <A href={pkmHref(props.link.page)} data-testid="pkm-backlink-page" class="truncate text-xs text-muted hover:text-ink hover:underline">
        {props.link.pageTitle}
        <Show when={props.link.path}> › {props.link.path}</Show>
      </A>
      <span class="text-sm">
        <Body text={props.link.body} />
      </span>
    </div>
  );
}
