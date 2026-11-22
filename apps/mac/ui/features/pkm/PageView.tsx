import { Clipboard, effect, keymap, Text, View } from "nsh";
import { Input } from "nsh/base";

import { t } from "@vibevalley/i18n";
import type { PkmBacklink, PkmComment, PkmPageSummary, PkmPageView, PkmSearchHit } from "@vibevalley/protocol";

import { createAct } from "../../design/act";
import { Button } from "../../design/Button";
import { Icon } from "../../design/Icon";
import { Empty } from "../../design/layout";
import { type MoreItem, MoreMenu } from "../../design/MoreMenu";
import { motionClass, motionDuration, motionOff } from "../../design/motion";
import { Dot, type DotTone } from "../../design/Tag";
import { Bubble } from "../../design/Tip";
import { toast } from "../../design/toasts";
import { mix } from "../../design/tone";
import { api, faultOf } from "../../infra/api";
import { ready, useQueryClient } from "../../infra/query";
import { Link, useRouter } from "../../infra/router";
import { createSignal } from "../../infra/solid";
import { useLatest } from "../../infra/state/atom";
import { isPinned, togglePinned } from "../content/navigation";
import { Body } from "./Body";
import { daysUntil, dayKey, titleFor } from "./days";
import { wordDiff } from "./outline";
import { Outline } from "./OutlineView";
import { pkmHref, refreshPkm as refreshQueries, usePkmPage } from "./vault";

const titleFromSlug = (slug: string) => slug.replace(/__/gu, "/").replace(/-/gu, " ");

export function Opened(props: { slug: string; pages: readonly PkmPageSummary[]; point?: string | undefined }) {
  const [editing, setEditing] = createSignal(false);
  const found = usePkmPage(() => props.slug, editing);
  const notFound = () => found.status() === "error" && faultOf(found.error()).tag === "Missing";
  return (
    <If
      when={ready(found, undefined)}
      else={
        <If when={found.status() === "error"}>
          <If when={notFound()} else={<Empty icon="file">{t("web.pkm.gone")}</Empty>}>
            <FreshPage slug={props.slug} pages={props.pages} />
          </If>
        </If>
      }
    >
      {(view) => (
        <Shown view={view()} summary={props.pages.find((p) => p.slug === props.slug)} pages={props.pages} point={props.point} onEditing={setEditing} />
      )}
    </If>
  );
}

/** Not created yet: the file is written on the first edit. */
function FreshPage(props: { slug: string; pages: readonly PkmPageSummary[] }) {
  const client = useQueryClient();
  const router = useRouter();
  const act = createAct();
  const [draft, setDraft] = createSignal("");
  const title = () => titleFromSlug(props.slug);
  const inbound = useLatest(
    () => props.slug,
    (linkedTo) => api.pkm.search({ linkedTo, limit: 20 }),
  );
  const hits = (): readonly PkmSearchHit[] => {
    const a = inbound();
    return a?.state === "done" ? a.value : [];
  };
  const create = () => {
    const body = draft().trim();
    const markdown = body ? `- ${body.replace(/\n/gu, "\n  ")}\n` : "-\n";
    return act.run(async () => {
      const page = await api.pkm.page.save({ title: title(), tier: "inbox", markdown });
      await refreshQueries(client);
      if (page.slug !== props.slug) router.navigate(pkmHref(page.slug), { replace: true });
    });
  };
  return (
    <View testID="pkm-fresh" accessibilityLabel={props.slug} class="mx-auto w-full max-w-3xl min-w-0 gap-4 px-5 py-5">
      <View class="gap-2">
        <View class="flex-row items-center gap-2">
          <Text role="header" testID="pkm-title" class="min-w-0 flex-1 truncate text-xl font-semibold text-ink">
            {title()}
          </Text>
          <Button tone="primary" icon="add" testID="pkm-create-page" disabled={act.busy()} onPress={() => void create()}>
            {t("web.pkm.page.create")}
          </Button>
        </View>
        <Text class="text-sm text-muted">{t("web.pkm.page.freshHint")}</Text>
      </View>
      <View class="flex-row items-start gap-1 rounded-sm py-px">
        <View class="mt-1 h-4 w-4 shrink-0 items-center justify-center">
          <View class="h-1.5 w-1.5 rounded-full bg-muted" />
        </View>
        <View class="min-w-0 flex-1">
          <Input
            autoFocus
            testID="pkm-fresh-input"
            value={draft()}
            placeholder={t("web.pkm.page.freshPlaceholder")}
            onChange={(e) => setDraft(e.value)}
            onSubmit={() => void create()}
            class="min-h-6 w-full rounded-sm bg-hover px-1 py-0.5 text-sm text-ink"
          />
        </View>
      </View>
      <View testID="pkm-backlinks" class="mt-4 gap-2 border-t border-line pt-4">
        <Text role="header" class="text-xs font-semibold text-muted">
          {t("web.pkm.backlinks.title", { n: hits().length })}
        </Text>
        <If when={hits().length > 0} else={<Text class="text-xs text-faint">{t("web.pkm.backlinks.none")}</Text>}>
          <Each of={hits()} key={(h) => h.block}>
            {(h) => (
              <BacklinkRow
                link={{ page: h().page, pageTitle: h().pageTitle, tier: h().tier, block: h().block, path: h().path, body: h().body }}
                refs={[]}
                day={props.pages.find((p) => p.slug === h().page)?.day}
              />
            )}
          </Each>
        </If>
      </View>
    </View>
  );
}

function Shown(props: {
  view: PkmPageView;
  summary: PkmPageSummary | undefined;
  pages: readonly PkmPageSummary[];
  point: string | undefined;
  onEditing: (on: boolean) => void;
}) {
  const page = () => props.view.page;
  const [commentsOpen, setCommentsOpen] = createSignal(false);
  const hasComments = () => props.view.comments.length > 0;
  return (
    <View testID="pkm-page" accessibilityLabel={page().slug} class="mx-auto w-full max-w-3xl min-w-0 gap-4 px-5 py-5">
      <Header view={props.view} summary={props.summary} commentsOpen={commentsOpen()} onToggleComments={() => setCommentsOpen((open) => !open)} />
      <If when={hasComments() && commentsOpen()}>
        <View testID="pkm-comments-panel" class="rounded-lg border border-line bg-side p-3">
          <Comments view={props.view} />
        </View>
      </If>
      <Outline view={props.view} pages={props.pages} point={props.point} onEditing={props.onEditing} />
      <View class="mt-4 border-t border-line pt-4">
        <Backlinks view={props.view} pages={props.pages} />
      </View>
    </View>
  );
}

function Header(props: { view: PkmPageView; summary: PkmPageSummary | undefined; commentsOpen: boolean; onToggleComments: () => void }) {
  const client = useQueryClient();
  const refreshPkm = () => refreshQueries(client);
  const router = useRouter();
  const page = () => props.view.page;
  const act = createAct();
  const canRename = () => props.summary?.day === undefined && page().tier !== "journal";
  const [renaming, setRenaming] = createSignal(false);
  const [titleDraft, setTitleDraft] = createSignal("");
  let cancelled = false;
  const startRename = () => {
    if (!canRename()) return;
    cancelled = false;
    setTitleDraft(page().title);
    setRenaming(true);
  };
  const cancelRename = () => {
    cancelled = true;
    setRenaming(false);
  };
  const commitRename = () => {
    if (cancelled) return undefined;
    const to = titleDraft().trim();
    const from = page().title;
    setRenaming(false);
    if (!to || to === from) return undefined;
    return act.run(async () => {
      const done = await api.pkm.page.rename({ from, to });
      toast(t("web.pkm.page.renamed", { title: to }));
      await refreshPkm();
      router.navigate(pkmHref(done.into), { replace: true });
    });
  };
  effect(() => {
    if (!renaming()) return;
    return keymap.bind("escape", cancelRename, { when: "always" });
  });

  const pinKey = () => `note:${page().slug}`;
  const pinned = () => isPinned(pinKey());
  const onTogglePin = () => {
    const next = togglePinned(pinKey());
    toast(next ? t("web.library.content.pinnedToast") : t("web.library.content.unpinnedToast"));
  };

  const exportIt = () => {
    const { slug } = page();
    return act.run(async () => {
      const { markdown } = await api.pkm.page.export({ page: slug });
      await Clipboard.writeText(markdown);
      toast(t("web.pkm.page.exported"));
    });
  };
  const copyFile = () => {
    const { file } = page();
    return act.run(async () => {
      await Clipboard.writeText(file);
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
    ...(canRename() ? [{ key: "rename", label: t("web.pkm.page.rename"), icon: "edit" as const, onSelect: startRename }] : []),
    { key: "export", label: t("web.pkm.page.export"), icon: "copy", onSelect: () => void exportIt() },
    { key: "path", label: t("web.pkm.page.copyFile", { file: page().file }), icon: "file", onSelect: () => void copyFile() },
    { key: "undo", label: t("web.pkm.page.undo"), icon: "undo", onSelect: () => void undo() },
  ];
  return (
    <View class="gap-2 border-b border-line pb-3">
      <View class="flex-row items-center gap-2">
        <If
          when={renaming()}
          else={
            <If
              when={canRename()}
              else={
                <Text role="header" testID="pkm-title" class="min-w-0 flex-1 truncate text-xl font-semibold text-ink">
                  {titleFor(page().title, props.summary?.day)}
                </Text>
              }
            >
              <View
                role="button"
                tooltip={<Bubble text={t("web.pkm.page.rename")} />}
                onPress={startRename}
                class="-mx-1 min-w-0 flex-1 rounded-sm px-1 hover:bg-hover"
              >
                <Text role="header" testID="pkm-title" class="truncate text-xl font-semibold text-ink">
                  {titleFor(page().title, props.summary?.day)}
                </Text>
              </View>
            </If>
          }
        >
          <Input
            autoFocus
            testID="pkm-title-input"
            accessibilityLabel={t("web.pkm.page.rename")}
            value={titleDraft()}
            onChange={(e) => setTitleDraft(e.value)}
            onSubmit={() => void commitRename()}
            onBlur={() => void commitRename()}
            class="-mx-1 min-w-0 flex-1 rounded-sm border border-focus bg-page px-1.5 text-xl font-semibold text-ink"
          />
        </If>
        <View
          role="button"
          testID="pkm-pin"
          accessibilityLabel={pinned() ? t("web.library.content.unpin") : t("web.library.content.pin")}
          accessibilityState={{ selected: pinned() }}
          tooltip={<Bubble text={pinned() ? t("web.library.content.unpin") : t("web.library.content.pin")} />}
          onPress={onTogglePin}
          class={`size-7 shrink-0 items-center justify-center rounded-md ${motionClass("transition-transform duration-120 ease-out")} active:translate-y-px focus-visible:outline-2 focus-visible:outline-focus ${
            pinned() ? "bg-selected" : "hover:bg-hover"
          }`}
        >
          <Icon name="pin" size={16} tone={pinned() ? "wheat" : "muted"} />
        </View>
        <If when={props.view.comments.length > 0}>
          <View
            role="button"
            testID="pkm-comments-toggle"
            accessibilityLabel={t("web.pkm.comments.count", { n: props.view.comments.length })}
            accessibilityState={{ expanded: props.commentsOpen }}
            tooltip={<Bubble text={t("web.pkm.comments.count", { n: props.view.comments.length })} />}
            onPress={() => props.onToggleComments()}
            class={`h-7 shrink-0 flex-row items-center gap-1 rounded-md px-2 ${motionClass("transition-transform duration-120 ease-out")} active:translate-y-px focus-visible:outline-2 focus-visible:outline-focus ${
              props.commentsOpen ? "bg-selected" : "hover:bg-hover"
            }`}
          >
            <Icon name="thread" size={14} tone={props.commentsOpen ? "ink" : "muted"} />
            <Text class={`font-mono text-xs tabular-nums ${props.commentsOpen ? "font-medium text-ink" : "text-muted"}`}>
              {String(props.view.comments.length)}
            </Text>
          </View>
        </If>
        <MoreMenu label={t("web.pkm.page.more")} testid="pkm-more" items={more()} />
      </View>
      <Text testID="pkm-notes-hint" class="text-xs text-faint">
        {t("web.library.content.notesHint")}
      </Text>
      <Props view={props.view} />
      <If when={page().tldr}>
        <Text class="text-sm text-muted">{page().tldr}</Text>
      </If>
    </View>
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
  const deadlineText = (d: { day: string; left: number | undefined }) =>
    d.left === undefined
      ? t("web.pkm.props.deadline", { day: d.day })
      : d.left < 0
        ? t("web.pkm.props.overdue", { day: d.day, n: -d.left })
        : d.left === 0
          ? t("web.pkm.props.dueToday", { day: d.day })
          : t("web.pkm.props.left", { day: d.day, n: d.left });
  const tags = () =>
    (value("tags") ?? "")
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean);
  return (
    <If when={entries().length > 0}>
      <View testID="pkm-props" class="gap-1.5">
        <View class="flex-row flex-wrap items-center gap-x-3 gap-y-1">
          <If when={value("status")}>
            {(s) => (
              <View testID="pkm-prop-status" class="flex-row items-center gap-1.5">
                <Dot tone={statusTone(s())} />
                <Text class="text-sm text-ink">{s()}</Text>
              </View>
            )}
          </If>
          <If when={deadline()}>
            {(d) => (
              <Text testID="pkm-prop-deadline" class={`text-sm ${(d().left ?? 1) < 0 ? "text-berry" : (d().left ?? 99) <= 3 ? "text-warn-ink" : "text-muted"}`}>
                {deadlineText(d())}
              </Text>
            )}
          </If>
          <Each of={["area", "areas"].filter((k) => value(k))}>
            {(k) => (
              <View testID={`pkm-prop-${k()}`} class="flex-row items-center gap-1">
                <Text class="text-sm text-muted">{t("web.pkm.props.area")}</Text>
                <Body text={value(k()) ?? ""} refs={props.view.transclusions} class="text-sm text-muted" />
              </View>
            )}
          </Each>
          <Each of={tags()}>
            {(tag) => (
              <View testID="pkm-prop-tag" class="rounded-full bg-hover px-2 py-0.5">
                <Body
                  text={tag().startsWith("#") || tag().startsWith("[[") ? tag() : `[[${tag()}]]`}
                  refs={props.view.transclusions}
                  class="text-xs text-ink"
                />
              </View>
            )}
          </Each>
          <If when={rest().length > 0}>
            <View role="button" testID="pkm-props-more" onPress={() => setAll((a) => !a)} class="group rounded-sm px-1.5 py-0.5 hover:bg-hover">
              <Text class="text-xs text-muted group-hover:text-ink">{all() ? t("web.pkm.props.fewer") : t("web.pkm.props.more", { n: rest().length })}</Text>
            </View>
          </If>
        </View>
        <If when={all()}>
          <View class="gap-1 rounded-md bg-side px-2.5 py-2">
            <Each of={rest()} key={([k]) => k}>
              {(entry) => (
                <View class="flex-row gap-3">
                  <Text class="w-20 shrink-0 text-xs font-medium text-muted">{entry()[0]}</Text>
                  <View testID={`pkm-prop-${entry()[0]}`} class="min-w-0 flex-1">
                    <Body text={entry()[1]} refs={props.view.transclusions} class="text-xs text-ink" />
                  </View>
                </View>
              )}
            </Each>
          </View>
        </If>
      </View>
    </If>
  );
}

function Comments(props: { view: PkmPageView }) {
  const bodyOf = (block: string) => props.view.page.blocks.find((b) => b.id === block)?.body ?? "";
  return (
    <If when={props.view.comments.length > 0}>
      <View testID="pkm-comments" class="gap-2">
        <Text role="header" class="text-xs font-semibold text-muted">
          {t("web.pkm.comments.title", { n: props.view.comments.length })}
        </Text>
        <Each of={props.view.comments} key={(c) => c.id}>
          {(c) => <CommentCard comment={c()} body={bodyOf(c().block)} slug={props.view.page.slug} />}
        </Each>
      </View>
    </If>
  );
}

function CommentCard(props: { comment: PkmComment; body: string; slug: string }) {
  const client = useQueryClient();
  const refreshPkm = () => refreshQueries(client);
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
    <View testID="pkm-comment" accessibilityLabel={props.comment.id} class="gap-1.5 rounded-lg border border-line bg-page p-2.5">
      <View role="button" testID="pkm-comment-at" onPress={() => router.navigate(pkmHref(props.slug, props.comment.block), { replace: true })} class="group">
        <Text class="truncate text-xs text-muted group-hover:text-ink">{t("web.pkm.comments.on", { span: props.comment.span ?? props.body })}</Text>
      </View>
      <Text class="text-sm text-ink">{props.comment.body}</Text>
      <If when={props.comment.suggested}>
        {(s) => (
          <Text testID="pkm-diff" class="text-sm text-ink">
            {wordDiff(props.body, s()).map((d) =>
              d.kind === "del" ? (
                <Text class="text-berry line-through" style={{ backgroundColor: mix("bad-soft", 1) }}>
                  {d.text}
                </Text>
              ) : d.kind === "add" ? (
                <Text class="text-ok-ink" style={{ backgroundColor: mix("ok-soft", 1) }}>
                  {d.text}
                </Text>
              ) : (
                d.text
              ),
            )}
          </Text>
        )}
      </If>
      <View class="flex-row gap-1.5 self-end">
        <If when={props.comment.suggested}>
          <Button tone="primary" icon="check" testID="pkm-accept" disabled={act.busy()} onPress={() => void resolve(true)}>
            {t("web.pkm.comments.accept")}
          </Button>
        </If>
        <Button icon="close" testID="pkm-reject" disabled={act.busy()} onPress={() => void resolve(false)}>
          {t("web.pkm.comments.reject")}
        </Button>
      </View>
    </View>
  );
}

const backlinkGroups = ["projects", "journals", "areas", "archives"] as const;

function Backlinks(props: { view: PkmPageView; pages: readonly PkmPageSummary[] }) {
  const count = () => {
    const b = props.view.backlinks;
    return b.projects.length + b.journals.length + b.areas.length + b.archives.length;
  };
  const [open, setOpen] = createSignal(false);
  return (
    <View testID="pkm-backlinks" class="gap-2">
      <View
        role="button"
        testID="pkm-backlinks-toggle"
        accessibilityState={{ expanded: open() }}
        onPress={() => setOpen((was) => !was)}
        class="group -mx-1.5 h-7 flex-row items-center gap-1.5 self-start rounded-md px-1.5 hover:bg-hover focus-visible:outline-2 focus-visible:outline-focus"
      >
        <View
          class="w-3.5 shrink-0 items-center justify-center"
          style={{
            transform: [{ rotate: open() ? "90deg" : "0deg" }],
            ...(motionOff() ? {} : { transitionProperty: "transform", transitionDuration: motionDuration(120) }),
          }}
        >
          <Icon name="expand" size={10} tone="muted" />
        </View>
        <Text role="header" class="text-xs font-semibold text-muted group-hover:text-ink">
          {t("web.pkm.backlinks.title", { n: count() })}
        </Text>
      </View>
      <If when={open()}>
        <If when={count() > 0} else={<Text class="px-1 text-xs text-faint">{t("web.pkm.backlinks.none")}</Text>}>
          <Each of={backlinkGroups.filter((g) => props.view.backlinks[g].length > 0)}>
            {(g) => (
              <View class="gap-0.5">
                <Text class="text-2xs text-faint">{t(`web.pkm.backlinks.${g()}`)}</Text>
                <Each of={props.view.backlinks[g()]} key={(l) => l.block}>
                  {(l) => <BacklinkRow link={l()} refs={props.view.transclusions} day={props.pages.find((p) => p.slug === l().page)?.day} />}
                </Each>
              </View>
            )}
          </Each>
        </If>
      </If>
    </View>
  );
}

/** The page and path are the link to the block; the body's own links stay links. */
function BacklinkRow(props: { link: PkmBacklink; refs: PkmPageView["transclusions"]; day: string | undefined }) {
  return (
    <View testID="pkm-backlink" class="rounded-md px-2 py-1.5 hover:bg-hover">
      <Link href={pkmHref(props.link.page, props.link.block)} testID="pkm-backlink-page" class="group">
        <Text class="truncate text-xs text-muted group-hover:text-ink group-hover:underline">
          {titleFor(props.link.pageTitle, props.day) + (props.link.path ? ` › ${props.link.path}` : "")}
        </Text>
      </Link>
      <Body text={props.link.body} refs={props.refs} />
    </View>
  );
}
