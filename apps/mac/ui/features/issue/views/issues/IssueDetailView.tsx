import { keymap, Scroll, Text, View, type JSX } from "nsh";

import { list, t } from "@vibevalley/i18n";
import type { Issue, Session } from "@vibevalley/protocol";

import { Icon } from "../../../../design/Icon";
import { IconButton } from "../../../../design/IconButton";
import { motionClass } from "../../../../design/motion";
import { variant } from "../../../../infra/base/dom";
import { createMemo } from "../../../../infra/solid";
import type { BoardCard } from "../../model/cards";
import { issueIs } from "../../model/issue";
import { FamilyDetail } from "../FamilyDetail";
import { IssueDetail, OrchestratorIssueDetail } from "../IssueDetail";
import { createIssueChrome, IssueChromeContext, IssueNumberPill } from "../Sheet";
import { TodoDetail } from "../TodoDetail";

/** The open card. */
export function Detail(props: {
  id: string;
  cards: () => BoardCard[];
  known: boolean;
  open: (id: string | undefined) => void;
  onClose: (issue: Issue, session: Session | undefined, review: boolean) => void;
}) {
  const card = createMemo<BoardCard | undefined>(
    // By its id, a session of it, or its number (#12 in a message links to /issues/12).
    (last) => props.cards().find((c) => c.id === props.id || issueIs(c.issue, props.id) || String(c.issue.number) === props.id) ?? last,
  );
  /** Only read inside that kind's panel: it throws once the card is another kind. */
  const cardOf = <const K extends BoardCard["kind"]>(kind: K) => {
    const c = card();
    const of = c && variant(c, "kind", kind);
    if (!of) throw new Error(`the card is no longer a ${kind}`);
    return of;
  };
  /** What a panel is keyed by (a one-row Each, as VibeValley's keyed Match): the card's kind and the thing it shows. */
  const shows = (kind: BoardCard["kind"]): string[] => {
    const c = card();
    if (c?.kind !== kind) return [];
    return [c.kind === "issue" ? `issue:${c.sessions.at(-1)?.id ?? ""}` : `${c.kind}:${c.id}`];
  };
  return (
    <If
      when={card()}
      else={
        <Scroll class="min-h-0 flex-1">
          <View class="w-full max-w-200 self-center px-6 py-8">
            <If when={props.known} else={<Text class="text-sm text-muted">{t("web.issue.reading")}</Text>}>
              <View testID="issue-not-found">
                <Text role="header" class="text-lg font-semibold text-ink">
                  {t("web.issue.page.notFound")}
                </Text>
                <Text class="mt-3 text-sm text-muted">{t("web.issue.page.notFoundLine", { id: props.id })}</Text>
              </View>
            </If>
          </View>
        </Scroll>
      }
    >
      <Each of={shows("todo")} key={(k) => k}>
        {() => <TodoDetail item={cardOf("todo").issue} onDone={props.open} />}
      </Each>
      <Each of={shows("issue")} key={(k) => k}>
        {() => (
          <IssueDetail
            issue={cardOf("issue").issue}
            sessions={cardOf("issue").sessions}
            session={cardOf("issue").session}
            onClose={(session, review) => props.onClose(cardOf("issue").issue, session, review)}
            onOpen={props.open}
            onParent={cardOf("issue").issue.parent ? () => props.open(cardOf("issue").issue.parent) : undefined}
          />
        )}
      </Each>
      <Each of={shows("orchestrator")} key={(k) => k}>
        {() => <OrchestratorIssueDetail issue={cardOf("orchestrator").issue} />}
      </Each>
      <Each of={shows("missing")} key={(k) => k}>
        {() => (
          <Scroll class="min-h-0 flex-1">
            <View class="w-full max-w-200 self-center px-6 py-8">
              <Text role="header" class="text-xl font-semibold text-ink">
                {cardOf("missing").issue.title}
              </Text>
              <Text class="mt-3 text-sm text-ink">{t("web.issue.page.missing", { what: list(cardOf("missing").missing) })}</Text>
            </View>
          </Scroll>
        )}
      </Each>
      <Each of={shows("family")} key={(k) => k}>
        {() => (
          <FamilyDetail
            issue={cardOf("family").issue}
            children={cardOf("family").children}
            onOpen={props.open}
            onClose={(review) => props.onClose(cardOf("family").issue, undefined, review)}
          />
        )}
      </Each>
    </If>
  );
}

/** An issue's own page, at its URL: Issues or Escape goes back to the board as it was left. */
export function IssueView(props: {
  onBack: () => void;
  backLabel: string;
  issueNumber?: number | undefined;
  repo?: string | undefined;
  blocked: () => boolean;
  children: JSX.Element;
}) {
  const chrome = createIssueChrome();
  // A dialog over the issue takes Escape first (blocked); on narrow screens the drawer closes before the page goes back.
  keymap.bind(
    "escape",
    () => {
      if (props.blocked()) return;
      if (!chrome.wide() && chrome.drawerOpen()) {
        chrome.closeDrawer();
        return;
      }
      props.onBack();
    },
    { when: "notEditing" },
  );
  return (
    <IssueChromeContext.Provider value={chrome}>
      <View testID="issue" class="min-h-0 flex-1">
        <View
          testID="issue-topbar"
          desktop={{ windowDrag: true }}
          class="h-11 shrink-0 flex-row items-center justify-between gap-2 border-b border-line bg-page px-4"
        >
          <View class="min-w-0 flex-1 flex-row items-center gap-2">
            <View
              role="button"
              testID="issue-close"
              onPress={() => props.onBack()}
              class={`-ml-2 h-7 shrink-0 flex-row items-center gap-1 rounded-md px-2 ${motionClass("transition-transform duration-120 ease-out")} hover:bg-hover active:translate-y-px`}
            >
              <Icon name="back" size={14} tone="muted" />
              <Text class="text-sm font-medium text-muted">{props.backLabel}</Text>
            </View>
            <If when={props.issueNumber !== undefined}>{() => <IssueNumberPill number={props.issueNumber!} />}</If>
            <If when={props.repo}>
              {(r) => (
                <View class="h-6 min-w-0 shrink flex-row items-center gap-1 rounded-md border border-line bg-side px-2">
                  <Icon name="folder" size={12} tone="muted" />
                  <Text class="min-w-0 truncate text-xs font-medium text-muted">{r()}</Text>
                </View>
              )}
            </If>
          </View>
          <If when={chrome.hasSheet()}>
            <IconButton
              testid="issue-inspector-toggle"
              icon="sidebarRight"
              size={14}
              pressed={chrome.inspectorVisible()}
              label={t("web.issue.detail.properties")}
              onClick={() => chrome.toggleInspector()}
            />
          </If>
        </View>
        <View class="min-h-0 flex-1">{props.children}</View>
      </View>
    </IssueChromeContext.Provider>
  );
}
