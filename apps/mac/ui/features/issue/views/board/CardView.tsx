import { computed, Image, PanResponder, Text, View, type JSX, type ViewRef } from "nsh";

import { t } from "@vibevalley/i18n";
import type { Issue } from "@vibevalley/protocol";

import { Icon } from "../../../../design/Icon";
import type { IconName } from "../../../../design/icons";
import { motionClass, motionDuration, motionOff } from "../../../../design/motion";
import { Bubble } from "../../../../design/Tip";
import { mix, tone } from "../../../../design/tone";
import { fileUrl, useAttachmentFile } from "../../../../infra/attachmentFile";
import { createEffect } from "../../../../infra/solid";
import { useVdpNode } from "../../../../infra/vdpProbe";
import {
  type BoardCard,
  cardAgent,
  cardLook,
  type CardPreview,
  cardPreviewOf,
  cardRepo,
  cardUrgencyTone,
  type Lane,
  laneLabel,
  laneStatus,
  ownStatus,
} from "../../model/cards";
import { type BoardDensity, defaultFields, formatCompactDateLabel, type HierarchyMode, type IssueFieldVisibility } from "../../model/display";
import { useIssues, useNameOf } from "../../model/history";
import { blockerIssuesOf, childIssuesOf } from "../../model/meta";
import { BlockedByChips, CardChildRows, OwnerMark, ParentBadge, TagPills } from "../IssueMetaControls";
import { CardFace, FlagChip, PriorityMark, ProgressMark, StatusMark } from "../Marks";
import type { Drag } from "./dragFsm";

export function DropPlaceholder(props: { lane: Lane; number?: string | undefined; title: string; height: number; compact?: boolean | undefined }) {
  const h = computed(() => Math.max(48, Math.round(props.height)));
  const isCompact = computed(() => props.compact === true);
  return (
    <View
      testID={`drop-placeholder-${props.lane}`}
      class={`pointer-events-none justify-between overflow-hidden rounded-lg border border-dashed border-leaf ${isCompact() ? "mb-1.5 px-2.5 py-1.5" : "mb-2 px-3 py-2.5"}`}
      style={{ height: h(), backgroundColor: mix("leaf", 0.08) }}
    >
      <View class="flex-row items-center justify-between gap-2 opacity-75">
        <View class="min-w-0 flex-1 flex-row items-center gap-1.5">
          <StatusMark status={laneStatus[props.lane]} size={12} />
          <If when={props.number}>{(num) => <Text class="shrink-0 font-mono text-2xs font-medium text-leaf tabular-nums">{num()}</Text>}</If>
        </View>
        <Text class="shrink-0 text-2xs font-medium text-leaf">{laneLabel[props.lane]}</Text>
      </View>
      <Text class={`mt-1 line-clamp-2 ${isCompact() ? "text-xs leading-4" : "text-sm leading-[19px]"} font-medium text-ink opacity-55`}>{props.title}</Text>
    </View>
  );
}

function SmallIconButton(props: { label: string; icon: IconName; onPress: () => void; testID?: string }): JSX.Element {
  return (
    <View
      onPress={props.onPress}
      role="button"
      testID={props.testID}
      accessibilityLabel={props.label}
      tooltip={<Bubble text={props.label} />}
      class={`h-6 w-6 shrink-0 items-center justify-center rounded-md ${motionClass("transition-transform duration-120 ease-out")} hover:bg-selected active:translate-y-px`}
    >
      <Icon name={props.icon} size={14} tone="muted" />
    </View>
  );
}

function CardThumbnail(props: { preview: CardPreview }) {
  const file = useAttachmentFile(() => props.preview.attachmentId ?? "");
  const src = computed(() => {
    if (props.preview.url !== undefined && props.preview.url !== "") return props.preview.url;
    const f = file();
    return f ? fileUrl(f.path) : undefined;
  });
  return (
    <If when={src()}>
      {(url) => (
        <View testID="card-preview" class="relative mt-2 h-24 w-full overflow-hidden rounded-md border border-line bg-side">
          <Image testID="card-preview-image" src={url()} class="h-full w-full object-cover" />
          <If when={props.preview.isCompare}>
            <View
              testID="card-preview-compare"
              class="pointer-events-none absolute right-1.5 bottom-1.5 flex-row items-center gap-1 rounded-sm border border-line px-1.5 py-0.5"
              style={{ backgroundColor: mix("elevated", 0.9) }}
            >
              <Icon name="diff" size={10} tone="ink" />
              <Text class="text-2xs font-medium text-ink">{t("web.issue.peek.compareBadge")}</Text>
            </View>
          </If>
        </View>
      )}
    </If>
  );
}

export function CardSurface(props: {
  card: BoardCard;
  hierarchy?: HierarchyMode | undefined;
  density?: BoardDensity | undefined;
  fields?: IssueFieldVisibility | undefined;
  allIssues?: readonly Issue[] | undefined;
  interactive?: boolean | undefined;
  onOpen?: ((id: string) => void) | undefined;
  onBeforeNestedPress?: (() => void) | undefined;
}) {
  const nameOf = useNameOf();
  const issues = useIssues();
  const resolvedIssues = computed(() => [...(props.allIssues ?? issues())]);
  const look = computed(() => cardLook(props.card, nameOf(), resolvedIssues(), Date.now()));
  const repo = computed(() => cardRepo(props.card));
  const preview = computed(() => cardPreviewOf(props.card));
  const fields = computed(() => props.fields ?? defaultFields);
  const compact = computed(() => props.density === "compact");
  const isInteractive = computed(() => props.interactive !== false);
  const showNumber = computed(() => fields().number && Boolean(look().number));
  const showRepo = computed(() => fields().repo && Boolean(repo()));
  const loud = computed(() => {
    if (!fields().priority) return undefined;
    const pr = look().priority;
    return pr === "urgent" || pr === "high" ? pr : undefined;
  });
  const hasFace = computed(() => fields().agent && (Boolean(cardAgent(props.card)) || props.card.kind === "orchestrator"));
  const showOwner = computed(() => {
    if (!fields().owner || props.card.issue.owner === undefined) return false;
    if (hasFace() && props.card.issue.owner.kind === "agent" && props.card.issue.owner.id === cardAgent(props.card)) return false;
    return true;
  });
  const hasTopRow = computed(() => Boolean(showNumber() || showRepo() || loud() || hasFace() || showOwner()));
  const showsStatus = computed(() => ownStatus(props.card.lane, look().status));
  const unassignedTodo = computed(
    () => fields().agent && props.card.kind === "todo" && props.card.lane === "todo" && props.card.issue.status !== "backlog" && !cardAgent(props.card),
  );
  const parentIssue = computed(() => (props.card.issue.parent ? resolvedIssues().find((item) => item.id === props.card.issue.parent) : undefined));
  const blockerIssues = computed(() => blockerIssuesOf(props.card.issue, resolvedIssues()));
  const childIssues = computed(() =>
    props.hierarchy === "top_level" || props.hierarchy === "parents_only" ? childIssuesOf(props.card.issue.id, resolvedIssues()) : [],
  );
  const tags = computed(() => (fields().tags ? (props.card.issue.tags ?? []) : []));
  const dateLabel = computed(() => (fields().dates ? formatCompactDateLabel(props.card.issue) : undefined));
  const showProgress = computed(() => (fields().progress ? look().progress : undefined));
  const showPreview = computed(() => (fields().preview ? preview() : undefined));
  const attachmentCount = computed(() => props.card.issue.attachments?.length ?? 0);
  const marks = computed(
    () =>
      showsStatus() ||
      unassignedTodo() ||
      Boolean(showProgress()) ||
      Boolean(parentIssue()) ||
      blockerIssues().length > 0 ||
      tags().length > 0 ||
      Boolean(dateLabel()) ||
      attachmentCount() > 0 ||
      look().flags.length > 0,
  );
  const urgency = computed(() => cardUrgencyTone(props.card));
  const noop = () => {};
  const openTarget = (id: string) => {
    if (isInteractive()) props.onOpen?.(id);
  };
  return (
    <>
      <If when={urgency()}>{(u) => <View class="pointer-events-none absolute inset-y-0 left-0 w-0.75" style={{ backgroundColor: tone(u()) }} />}</If>
      <If when={hasTopRow()}>
        <View class="flex-row items-center justify-between gap-2">
          <View class="min-w-0 flex-1 flex-row items-center gap-1">
            <If when={showNumber() ? look().number : undefined}>
              {(num) => <Text class="shrink-0 font-mono text-2xs font-medium text-faint tabular-nums">{num()}</Text>}
            </If>
            <If when={showNumber() && showRepo()}>
              <Text class="shrink-0 text-2xs text-faint">·</Text>
            </If>
            <If when={showRepo() ? repo() : undefined}>{(r) => <Text class="min-w-0 flex-1 truncate text-2xs text-faint">{r()}</Text>}</If>
          </View>
          <If when={loud() || hasFace() || showOwner()}>
            <View class="max-w-[65%] shrink flex-row items-center gap-1.5">
              <If when={loud()}>{(pr) => <PriorityMark priority={pr()} size={12} />}</If>
              <If when={showOwner() ? props.card.issue.owner : undefined}>
                {(owner) => (
                  <View testID={isInteractive() ? "card-owner" : undefined} class="min-w-0 shrink">
                    <OwnerMark owner={owner()} size={16} showIdentity={owner().kind === "agent"} />
                  </View>
                )}
              </If>
              <If when={hasFace()}>
                <CardFace card={props.card} size={18} showIdentity />
              </If>
            </View>
          </If>
        </View>
      </If>
      <Text
        class={`${hasTopRow() ? (compact() ? "mt-1 " : "mt-1.5 ") : ""}line-clamp-2 ${compact() ? "text-xs leading-4" : "text-sm leading-[19px]"} font-medium text-ink`}
      >
        {look().title}
      </Text>
      <If when={look().wait}>{(wait) => <Text class="mt-1 line-clamp-1 text-xs text-water">{wait()}</Text>}</If>
      <If when={showPreview()}>{(pv) => <CardThumbnail preview={pv()} />}</If>
      {/* Only what differs from the lane's default: its own status, unassigned todo, progress, attachments, flags. */}
      <If when={marks()}>
        <View testID={isInteractive() ? "card-marks" : undefined} class={`${compact() ? "mt-1 gap-1" : "mt-2 gap-1.5"} flex-row flex-wrap items-center`}>
          <If when={showsStatus()}>
            <StatusMark status={look().status} tone={look().statusTone} size={13} />
          </If>
          <If when={unassignedTodo()}>
            <View
              testID={isInteractive() ? "card-unassigned" : undefined}
              accessibilityLabel={t("web.issue.card.assignHelper")}
              class="flex-row items-center gap-1 rounded-sm border border-dashed border-line bg-side px-1.5 py-px"
            >
              <Icon name="agents" size={11} tone="muted" />
              <Text class="text-2xs leading-3.5 font-medium text-muted">{t("web.issue.card.assignHelper")}</Text>
            </View>
          </If>
          <If when={showProgress()}>{(pg) => <ProgressMark done={pg().done} total={pg().total} />}</If>
          <If when={parentIssue()}>{(p) => <ParentBadge parent={p()} onOpen={openTarget} testid={isInteractive() ? "card-parent-badge" : undefined} />}</If>
          <BlockedByChips
            blockers={blockerIssues()}
            onOpen={openTarget}
            onBeforePress={isInteractive() ? props.onBeforeNestedPress : noop}
            testid={isInteractive() ? "card-blocked-by" : undefined}
          />
          <TagPills tags={tags()} max={3} testid={isInteractive() ? "card-tags" : undefined} />
          <If when={dateLabel()}>
            {(dt) => (
              <View
                testID={isInteractive() ? "card-date" : undefined}
                class="flex-row items-center gap-1 rounded-sm border border-transparent bg-side px-1.5 py-px"
              >
                <Icon name="calendar" size={10} tone="muted" />
                <Text class="font-mono text-2xs leading-3.5 text-faint tabular-nums">{dt()}</Text>
              </View>
            )}
          </If>
          <If when={attachmentCount() > 0}>
            <View
              testID={isInteractive() ? "card-attachments" : undefined}
              accessibilityLabel={t("web.issue.attachments.count", { n: attachmentCount() })}
              tooltip={<Bubble text={t("web.issue.attachments.count", { n: attachmentCount() })} />}
              class="flex-row items-center gap-0.5"
            >
              <Icon name="attach" size={12} tone="muted" />
              <Text class="text-2xs text-muted tabular-nums">{String(attachmentCount())}</Text>
            </View>
          </If>
          <Each of={look().flags} key={(f) => `${f.tone}:${f.text}`}>
            {(f) => <FlagChip text={f().text} tone={f().tone} />}
          </Each>
        </View>
      </If>
      <If when={childIssues().length > 0}>
        <CardChildRows children={childIssues()} onBeforeChildPress={isInteractive() ? props.onBeforeNestedPress : noop} onOpenChild={openTarget} />
      </If>
    </>
  );
}

export function CardView(props: {
  card: BoardCard;
  lane: Lane;
  laneKey: string;
  selected: boolean;
  hierarchy?: HierarchyMode | undefined;
  density?: BoardDensity | undefined;
  fields?: IssueFieldVisibility | undefined;
  allIssues?: readonly Issue[] | undefined;
  onOpen: (id: string) => void;
  onRetry: (card: BoardCard) => void;
  onPutBack: (card: BoardCard) => void;
  drag: Drag;
  placeable: boolean;
}) {
  const nameOf = useNameOf();
  const issues = useIssues();
  const resolvedIssues = computed(() => [...(props.allIssues ?? issues())]);
  const look = computed(() => cardLook(props.card, nameOf(), resolvedIssues(), Date.now()));
  const compact = computed(() => props.density === "compact");
  const draggable = computed(() => props.card.kind !== "orchestrator" && props.card.kind !== "missing" && props.card.move?.state !== "moving");
  // Dragging sends a synthetic press on mouse-up; suppress opening the card right after a drag ends.
  let suppressPressUntil = 0;
  let cardEl: ViewRef | undefined;
  createEffect(
    () => props.selected,
    (sel) => {
      if (sel && cardEl) {
        requestAnimationFrame(() => {
          cardEl?.reveal({ vertical: "nearest" });
        });
      }
    },
    { defer: true },
  );
  const pan = PanResponder.create({
    // A press opens the card; only a move of a few points starts a drag.
    onMoveShouldSetPanResponder: (_, g) => draggable() && Math.abs(g.dx) + Math.abs(g.dy) > 4,
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: (_, g) => {
      suppressPressUntil = Number.POSITIVE_INFINITY;
      void props.drag.start(props.card, look().number, look().title, g.x0, g.y0);
    },
    onPanResponderMove: (_, g) => props.drag.move(g.moveX, g.moveY),
    onPanResponderRelease: (_, g) => {
      suppressPressUntil = Date.now() + 300;
      const pt = g.moveX !== 0 || g.moveY !== 0 ? { x: g.moveX, y: g.moveY } : { x: g.x0 + g.dx, y: g.y0 + g.dy };
      props.drag.end(true, pt);
    },
    onPanResponderTerminate: () => {
      suppressPressUntil = Date.now() + 300;
      props.drag.end(false);
    },
  });
  // Keep the source card mounted while dragging so its PanResponder never terminates, collapsing its footprint to 0px once measured.
  const isCollapsed = computed(() => props.drag.ghost()?.card.id === props.card.id);
  const beforeGhost = computed(() => {
    const g = props.drag.ghost();
    if (!g || g.card.id === props.card.id) return undefined;
    return props.drag.overKey() === props.laneKey && props.drag.before() === props.card.id ? g : undefined;
  });
  const cardStyle = () => (motionOff() ? undefined : { transitionProperty: "shadow", transitionDuration: motionDuration(180) });
  useVdpNode({
    testId: `issue-card-${props.card.id}`,
    role: "button",
    text: () => look().title,
    getRef: () => cardEl,
    onPress: () => props.onOpen(props.card.id),
  });

  return (
    <View class={isCollapsed() ? "mb-0 overflow-hidden" : ""} style={isCollapsed() ? { height: 0, opacity: 0 } : undefined}>
      <If when={beforeGhost()}>{(g) => <DropPlaceholder lane={props.lane} number={g().number} title={g().title} height={g().h} compact={compact()} />}</If>
      <View
        ref={(r) =>
          props.drag.card(
            props.card.id,
            () => props.card.lane,
            () => props.laneKey,
            r,
            () => props.placeable,
          )
        }
        class={isCollapsed() ? "mb-0" : compact() ? "mb-1.5" : "mb-2"}
      >
        <View
          {...pan.panHandlers}
          ref={(el) => {
            cardEl = el;
            if (props.selected)
              requestAnimationFrame(() => {
                el.reveal({ vertical: "nearest" });
                el.focus();
              });
          }}
          onPress={() => {
            if (props.drag.dragging() !== undefined || Date.now() < suppressPressUntil) return;
            props.onOpen(props.card.id);
          }}
          role="button"
          testID="issue-card"
          accessibilityLabel={look().title}
          accessibilityState={{ selected: props.selected, busy: props.card.move?.state === "moving" }}
          class={[
            "group relative overflow-hidden rounded-lg border focus-visible:outline-2 focus-visible:outline-focus",
            compact() ? "px-2.5 py-1.5" : "px-3 py-2.5",
            props.selected ? "border-accent bg-selected" : "border-line bg-elevated hover:border-line-strong hover:shadow-raise",
            props.card.move?.state === "moving" ? "opacity-70" : "",
          ].join(" ")}
          style={cardStyle()}
        >
          <CardSurface
            card={props.card}
            hierarchy={props.hierarchy}
            density={props.density}
            fields={props.fields}
            allIssues={props.allIssues}
            interactive
            onOpen={props.onOpen}
            onBeforeNestedPress={() => {
              suppressPressUntil = Date.now() + 250;
            }}
          />
        </View>
        <If when={props.card.move?.state === "failed" ? props.card.move : undefined}>
          {(m) => (
            <View testID="move-failed" class="mt-1 flex-row items-center gap-1 px-1">
              <Text class="min-w-0 flex-1 truncate text-xs text-berry">{m().reason ?? t("web.issue.board.moveFailed")}</Text>
              <SmallIconButton testID="move-retry" label={t("web.issue.board.retryMove")} icon="retry" onPress={() => props.onRetry(props.card)} />
              <SmallIconButton testID="move-put-back" label={t("web.issue.board.putBack")} icon="undo" onPress={() => props.onPutBack(props.card)} />
            </View>
          )}
        </If>
      </View>
    </View>
  );
}
