import { Schema } from "effect";
import { createSignal, For, Match, Show, Switch } from "solid-js";

import { t } from "@vibevalley/i18n";
import type { PkmBacklink, PkmComment, PkmPageSummary, PkmPageView, PkmTier } from "@vibevalley/protocol";

import { api } from "#/infra/api.ts";
import { ready } from "#/infra/query.ts";
import { useRouter } from "#/infra/router.ts";
import { defineStored } from "#/state/stored.ts";
import { A } from "#/ui/A.tsx";
import { createAct } from "#/ui/act.ts";
import { Button } from "#/ui/Button.tsx";
import { Select } from "#/ui/Field.tsx";
import { IconButton } from "#/ui/IconButton.tsx";
import { Empty } from "#/ui/layout.tsx";
import { type MoreItem, MoreMenu } from "#/ui/MoreMenu.tsx";
import { Dot, type DotTone } from "#/ui/Tag.tsx";
import { toast } from "#/ui/toasts.ts";

import { Body } from "./Body";
import { Calendar } from "./Calendar";
import { daysUntil, dayKey, titleFor } from "./days";
import { tierOrder, wordDiff } from "./outline";
import { Outline } from "./OutlineView";
import { pkmHref, refreshPkm, usePkmPage } from "./vault";

/** A tier as a group of pages (the sidebar's heads): Repos. */
export const tierLabel = (tier: PkmTier) => t(`web.pkm.tier.${tier}`);
/** A tier as where one page is: Repo. */
const tierOfOne = (tier: PkmTier) => t(`web.pkm.tierOne.${tier}`);

const rail = defineStored("pkm.rail", Schema.Boolean, true);

/** compact: in the stream of days, the column alone, its title a link to the day's own page. */
export function Opened(props: { slug: string; pages: readonly PkmPageSummary[]; point?: string | undefined; compact?: boolean }) {
  const [editing, setEditing] = createSignal(false);
  const found = usePkmPage(() => props.slug, editing);
  return (
    <Show
      when={ready(found, undefined)}
      fallback={
        <Show when={found.isError}>
          <Empty icon="file">{t("web.pkm.gone")}</Empty>
        </Show>
      }
    >
      {(view) => (
        <Shown
          view={view()}
          summary={props.pages.find((p) => p.slug === props.slug)}
          pages={props.pages}
          point={props.point}
          compact={props.compact === true}
          onEditing={setEditing}
        />
      )}
    </Show>
  );
}

function Shown(props: {
  view: PkmPageView;
  summary: PkmPageSummary | undefined;
  pages: readonly PkmPageSummary[];
  point: string | undefined;
  compact: boolean;
  onEditing: (on: boolean) => void;
}) {
  const page = () => props.view.page;
  const outline = () => <Outline view={props.view} pages={props.pages} point={props.point} onEditing={props.onEditing} />;
  return (
    <Show
      when={!props.compact}
      fallback={
        <article data-testid="pkm-day" data-key={page().slug} class="flex flex-col gap-2">
          <h2 class="text-lg font-semibold">
            <A href={pkmHref(page().slug)} class="hover:underline">
              {titleFor(page().title, props.summary?.day)}
            </A>
          </h2>
          {outline()}
        </article>
      }
    >
      <div data-testid="pkm-page" data-key={page().slug} class="flex min-h-0 flex-1 flex-col overflow-y-auto xl:flex-row xl:items-start">
        <article class="mx-auto flex w-full max-w-3xl min-w-0 flex-col gap-4 px-4 py-4">
          <Header view={props.view} summary={props.summary} />
          {outline()}
        </article>
        <Show when={rail.get()}>
          <aside
            aria-label={t("web.pkm.rail.label")}
            data-testid="pkm-rail"
            class="mx-auto flex w-full max-w-3xl flex-col gap-5 border-t border-line px-4 py-4 xl:sticky xl:top-0 xl:mx-0 xl:max-h-full xl:w-72 xl:shrink-0 xl:overflow-y-auto xl:border-t-0 xl:border-l"
          >
            <Calendar pages={props.pages} open={props.summary?.day} />
            <Comments view={props.view} />
            <Backlinks view={props.view} pages={props.pages} />
            <Contents view={props.view} />
          </aside>
        </Show>
      </div>
    </Show>
  );
}

function Header(props: { view: PkmPageView; summary: PkmPageSummary | undefined }) {
  const router = useRouter();
  const page = () => props.view.page;
  const act = createAct();
  const move = (tier: PkmTier) => {
    const { slug, tier: was } = page();
    if (tier === was) return undefined;
    return act.run(async () => {
      await api.pkm.page.move({ page: slug, tier });
      toast(t("web.pkm.page.moved", { tier: tierOfOne(tier) }));
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
  const copyFile = () => {
    const { file } = page();
    return act.run(async () => {
      await navigator.clipboard.writeText(file);
      toast(t("web.pkm.page.copiedFile"));
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
    { key: "path", label: t("web.pkm.page.copyFile", { file: page().file }), icon: "file", onSelect: () => void copyFile() },
    { key: "undo", label: t("web.pkm.page.undo"), icon: "undo", onSelect: () => void undo() },
  ];
  return (
    <header class="flex flex-col gap-2">
      <div class="lg:hidden">
        <Button icon="back" onClick={() => router.navigate("/pkm")}>
          {t("web.pkm.list.today")}
        </Button>
      </div>
      <div class="flex items-center gap-2">
        <h1 data-testid="pkm-title" class="min-w-0 flex-1 truncate text-xl leading-8 font-semibold">
          {titleFor(page().title, props.summary?.day)}
        </h1>
        <Select
          testid="pkm-tier-select"
          label={t("web.pkm.page.tier")}
          size="control"
          value={page().tier}
          options={tierOrder.map((tier) => ({ value: tier, label: tierOfOne(tier) }))}
          onChange={(tier) => void move(tier)}
        />
        <IconButton
          icon="thread"
          label={rail.get() ? t("web.pkm.rail.hide") : t("web.pkm.rail.show")}
          testid="pkm-rail-toggle"
          pressed={rail.get()}
          onClick={() => rail.update((open) => !open)}
        />
        <MoreMenu label={t("web.pkm.page.more")} testid="pkm-more" items={more()} />
      </div>
      <Props view={props.view} />
      <Show when={page().tldr}>
        <p class="text-sm text-muted">{page().tldr}</p>
      </Show>
    </header>
  );
}

/** The properties that say how the page stands, said in a line; the rest folded under a count. */
const leading = new Set(["status", "deadline", "area", "areas", "tags"]);
const hidden = new Set(["title", "tldr", "alias", "para"]);

const statusTone = (status: string): DotTone => {
  const s = status.trim().toLowerCase();
  if (["active", "doing", "now", "in-progress"].includes(s)) return "leaf";
  if (["waiting", "paused", "blocked", "someday"].includes(s)) return "wheat";
  if (["done", "completed", "archived"].includes(s)) return "faint";
  return "idle";
};

function Props(props: { view: PkmPageView }) {
  const [all, setAll] = createSignal(false);
  const entries = () => Object.entries(props.view.page.props).filter(([k]) => !hidden.has(k));
  const rest = () => entries().filter(([k]) => !leading.has(k));
  const value = (k: string) => props.view.page.props[k];
  const deadline = () => {
    const d = value("deadline");
    const left = d === undefined ? undefined : daysUntil(d, dayKey(Date.now()));
    return d === undefined ? undefined : { day: d, left };
  };
  return (
    <Show when={entries().length > 0}>
      <div data-testid="pkm-props" class="flex flex-col gap-1.5">
        <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <Show when={value("status")}>
            {(s) => (
              <span data-testid="pkm-prop" data-key="status" class="inline-flex items-center gap-1.5">
                <Dot tone={statusTone(s())} />
                {s()}
              </span>
            )}
          </Show>
          <Show when={deadline()}>
            {(d) => (
              <span
                data-testid="pkm-prop"
                data-key="deadline"
                class={[(d().left ?? 1) < 0 ? "text-berry" : (d().left ?? 99) <= 3 ? "text-warn-ink" : "text-muted"]}
              >
                <Switch fallback={t("web.pkm.props.deadline", { day: d().day })}>
                  <Match when={d().left !== undefined && (d().left ?? 0) < 0}>{t("web.pkm.props.overdue", { day: d().day, n: -(d().left ?? 0) })}</Match>
                  <Match when={d().left === 0}>{t("web.pkm.props.dueToday", { day: d().day })}</Match>
                  <Match when={d().left !== undefined}>{t("web.pkm.props.left", { day: d().day, n: d().left ?? 0 })}</Match>
                </Switch>
              </span>
            )}
          </Show>
          <For each={["area", "areas"].filter((k) => value(k))}>
            {(k) => (
              <span data-testid="pkm-prop" data-key={k} class="text-muted">
                {t("web.pkm.props.area")} <Body text={value(k) ?? ""} refs={props.view.transclusions} />
              </span>
            )}
          </For>
          <For
            each={(value("tags") ?? "")
              .split(",")
              .map((tag) => tag.trim())
              .filter(Boolean)}
          >
            {(tag) => (
              <span data-testid="pkm-prop" data-key="tags" class="rounded-full bg-hover px-2 py-0.5 text-xs">
                <Body text={tag.startsWith("#") || tag.startsWith("[[") ? tag : `[[${tag}]]`} refs={props.view.transclusions} />
              </span>
            )}
          </For>
          <Show when={rest().length > 0}>
            <button type="button" data-testid="pkm-props-more" onClick={() => setAll((a) => !a)} class="cursor-pointer text-xs text-muted hover:text-ink">
              {all() ? t("web.pkm.props.fewer") : t("web.pkm.props.more", { n: rest().length })}
            </button>
          </Show>
        </div>
        <Show when={all()}>
          <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
            <For each={rest()} keyed={([k]) => k}>
              {(entry) => (
                <>
                  <dt class="text-muted">{entry()[0]}</dt>
                  <dd data-testid="pkm-prop" data-key={entry()[0]}>
                    <Body text={entry()[1]} refs={props.view.transclusions} />
                  </dd>
                </>
              )}
            </For>
          </dl>
        </Show>
      </div>
    </Show>
  );
}

function Comments(props: { view: PkmPageView }) {
  const bodyOf = (block: string) => props.view.page.blocks.find((b) => b.id === block)?.body ?? "";
  return (
    <Show when={props.view.comments.length > 0}>
      <section data-testid="pkm-comments" class="flex flex-col gap-2">
        <h2 class="text-xs font-semibold text-muted">{t("web.pkm.comments.title", { n: props.view.comments.length })}</h2>
        <For each={props.view.comments} keyed={(c) => c.id}>
          {(c) => <CommentCard comment={c()} body={bodyOf(c().block)} slug={props.view.page.slug} />}
        </For>
      </section>
    </Show>
  );
}

function CommentCard(props: { comment: PkmComment; body: string; slug: string }) {
  const router = useRouter();
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
      id={`comment-${props.comment.block}`}
      data-testid="pkm-comment"
      data-key={props.comment.id}
      data-status={props.comment.status}
      class="flex flex-col gap-1.5 rounded-lg border border-line p-2.5"
    >
      <button
        type="button"
        data-testid="pkm-comment-at"
        onClick={() => router.navigate(pkmHref(props.slug, props.comment.block), { replace: true })}
        class="cursor-pointer truncate text-left text-xs text-muted hover:text-ink"
      >
        {t("web.pkm.comments.on", { span: props.comment.span ?? props.body })}
      </button>
      <p class="text-sm">{props.comment.body}</p>
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

const backlinkGroups = ["repos", "journals", "areas", "archives"] as const;

function Backlinks(props: { view: PkmPageView; pages: readonly PkmPageSummary[] }) {
  const count = () => {
    const b = props.view.backlinks;
    return b.repos.length + b.journals.length + b.areas.length + b.archives.length;
  };
  return (
    <section data-testid="pkm-backlinks" class="flex flex-col gap-2">
      <h2 class="text-xs font-semibold text-muted">{t("web.pkm.backlinks.title", { n: count() })}</h2>
      <Show when={count() > 0} fallback={<p class="text-xs text-faint">{t("web.pkm.backlinks.none")}</p>}>
        <For each={backlinkGroups.filter((g) => props.view.backlinks[g].length > 0)}>
          {(g) => (
            <div class="flex flex-col gap-0.5">
              <h3 class="text-2xs text-faint">{t(`web.pkm.backlinks.${g}`)}</h3>
              <For each={props.view.backlinks[g]} keyed={(l) => l.block}>
                {(l) => <BacklinkRow link={l()} refs={props.view.transclusions} day={props.pages.find((p) => p.slug === l().page)?.day} />}
              </For>
            </div>
          )}
        </For>
      </Show>
    </section>
  );
}

/** The page and path are the link to the block; the body's own links stay links (an anchor cannot hold another). */
function BacklinkRow(props: { link: PkmBacklink; refs: PkmPageView["transclusions"]; day: string | undefined }) {
  return (
    <div data-testid="pkm-backlink" data-key={props.link.block} class="flex flex-col rounded-md px-2 py-1.5 hover:bg-hover">
      <A href={pkmHref(props.link.page, props.link.block)} data-testid="pkm-backlink-page" class="truncate text-xs text-muted hover:text-ink hover:underline">
        {titleFor(props.link.pageTitle, props.day)}
        <Show when={props.link.path}> › {props.link.path}</Show>
      </A>
      <span class="text-sm">
        <Body text={props.link.body} refs={props.refs} />
      </span>
    </div>
  );
}

function Contents(props: { view: PkmPageView }) {
  const router = useRouter();
  const tops = () => props.view.page.blocks.filter((b) => b.depth === 0 && b.body.trim() !== "");
  return (
    <Show when={tops().length >= 3}>
      <section data-testid="pkm-contents" class="flex flex-col gap-0.5">
        <h2 class="text-xs font-semibold text-muted">{t("web.pkm.rail.contents")}</h2>
        <For each={tops()} keyed={(b) => b.id}>
          {(b) => (
            <div
              role="link"
              tabindex="0"
              data-key={b().id}
              onClick={() => router.navigate(pkmHref(props.view.page.slug, b().id), { replace: true })}
              onKeyDown={(e) => e.key === "Enter" && router.navigate(pkmHref(props.view.page.slug, b().id), { replace: true })}
              class="cursor-pointer truncate rounded-md px-2 py-0.5 text-xs text-muted hover:bg-hover hover:text-ink"
            >
              {/* A heading's #s come off: the list is one size. */}
              <Body text={(b().body.split("\n")[0] ?? "").replace(/^#+\s*/u, "")} refs={props.view.transclusions} />
            </div>
          )}
        </For>
      </section>
    </Show>
  );
}
