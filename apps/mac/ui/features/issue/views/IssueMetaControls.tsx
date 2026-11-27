import { computed, signal, Text, View } from "nsh";
import { Input } from "nsh/base";

import { t } from "@vibevalley/i18n";
import { type ActorRef, type Issue, type IssueRelation, type IssueRelationKind, IssueRelationKindValues, type Priority } from "@vibevalley/protocol";
import { issueId } from "@vibevalley/protocol/schema";

import { Combobox } from "../../../design/Combobox";
import { EpochDatePicker } from "../../../design/DatePicker";
import { AgentCodeBadge, AgentModeBadge, UserAvatar } from "../../../design/domain/Face";
import { initialOf, runtimeName } from "../../../design/domain/RuntimeBadge";
import { Select } from "../../../design/Field";
import { Icon } from "../../../design/Icon";
import { IconButton } from "../../../design/IconButton";
import { motionDuration, motionOff } from "../../../design/motion";
import { CountPill } from "../../../design/Tag";
import { Bubble } from "../../../design/Tip";
import { mix } from "../../../design/tone";
import { ready, useAgents, useRuntimes, useSettings } from "../../../infra/query";
import { decodeActorRef, encodeActorRef, type GroupBy } from "../model/display";
import { childIssuesOf, eligibleBlockerOptions, eligibleParentOptions, eligibleRelationOptions, issueTagPresets, normalizeTagList } from "../model/meta";
import { AgentFaceOf, NoFaceMark, PriorityMark, StatusMark } from "./Marks";
import { Pick } from "./Sheet";

/** Restrained hairline tag pills for Kanban cards and List rows. */
export function TagPills(props: { tags: readonly string[]; max?: number | undefined; testid?: string | undefined }) {
  const max = () => props.max ?? 3;
  const shown = computed(() => props.tags.slice(0, max()));
  const extra = computed(() => Math.max(0, props.tags.length - max()));
  return (
    <If when={props.tags.length > 0}>
      <View testID={props.testid} class="flex-row flex-wrap items-center gap-1">
        <Each of={shown()} key={(tag) => tag}>
          {(tag) => (
            <View testID="issue-tag-pill" class="rounded-sm border border-line bg-side px-1.5 py-px">
              <Text class="line-clamp-1 text-2xs leading-3.5 text-muted">{tag()}</Text>
            </View>
          )}
        </Each>
        <If when={extra() > 0}>
          <View class="rounded-sm border border-line bg-side px-1 py-px">
            <Text class="text-2xs leading-3.5 text-faint tabular-nums">{`+${extra()}`}</Text>
          </View>
        </If>
      </View>
    </If>
  );
}

/** Clickable parent issue reference badge (`↳ #10` or `↳ #10 标题`) for cards and list rows. */
export function ParentBadge(props: { parent: Issue; showTitle?: boolean | undefined; onOpen: (id: string) => void; testid?: string | undefined }) {
  const text = () => (props.showTitle === true ? `↳ #${props.parent.number} ${props.parent.title}` : `↳ #${props.parent.number}`);
  return (
    <View
      role="button"
      testID={props.testid ?? "issue-parent-badge"}
      accessibilityLabel={`#${props.parent.number} ${props.parent.title}`}
      tooltip={<Bubble text={`#${props.parent.number} ${props.parent.title}`} />}
      onPress={() => {
        props.onOpen(props.parent.id);
      }}
      class="max-w-44 shrink-0 flex-row items-center rounded-sm border border-line bg-side px-1.5 py-px hover:border-line-strong hover:bg-hover"
    >
      <Text class="truncate font-mono text-2xs leading-3.5 text-water">{text()}</Text>
    </View>
  );
}

/** Crisp tag editor with preset chips and custom tag input. */
export function TagEditor(props: {
  tags: readonly string[];
  disabled?: boolean | undefined;
  compact?: boolean | undefined;
  onChange: (tags: string[]) => void;
  testid?: string | undefined;
}) {
  const draft = signal("");
  const current = () => props.tags;
  const presets = () => issueTagPresets();
  const toggle = (tag: string) => {
    if (props.disabled === true) return;
    if (current().includes(tag)) props.onChange(current().filter((x) => x !== tag));
    else props.onChange(normalizeTagList([...current(), tag]));
  };
  const addCustom = (raw = draft()) => {
    if (props.disabled === true) return;
    const tag = raw.trim();
    if (tag !== "" && !current().includes(tag)) props.onChange(normalizeTagList([...current(), tag]));
    draft.set("");
  };
  const customTags = computed(() => {
    const known = presets();
    return current().filter((tag) => !known.includes(tag));
  });
  return (
    <View testID={props.testid ?? "issue-tag-editor"} class="gap-1.5">
      <If when={props.disabled === true}>
        <If when={current().length > 0} else={<Text class="text-xs text-faint">{t("web.issue.tags.empty")}</Text>}>
          <TagPills tags={current()} max={12} />
        </If>
      </If>
      <If when={props.disabled !== true}>
        <If when={customTags().length > 0}>
          <View class="flex-row flex-wrap items-center gap-1">
            <Each of={customTags()} key={(tag) => tag}>
              {(tag) => (
                <View class="flex-row items-center gap-1 rounded-sm border border-accent bg-selected px-1.5 py-0.5">
                  <Text class="text-2xs font-medium text-ink">{tag()}</Text>
                  <View
                    role="button"
                    testID={`tag-remove-${tag()}`}
                    accessibilityLabel={t("web.issue.tags.remove", { tag: tag() })}
                    onPress={() => toggle(tag())}
                    class="size-3.5 items-center justify-center rounded-xs hover:bg-hover"
                  >
                    <Icon name="close" size={9} tone="muted" />
                  </View>
                </View>
              )}
            </Each>
          </View>
        </If>
        <View class="flex-row flex-wrap items-center gap-1">
          <Each of={presets()} key={(preset) => preset}>
            {(preset) => {
              const active = () => current().includes(preset());
              return (
                <View
                  role="button"
                  testID={`tag-preset-${preset()}`}
                  accessibilityState={{ selected: active() }}
                  onPress={() => toggle(preset())}
                  class={`rounded-sm border px-1.5 py-0.5 ${
                    active() ? "border-accent bg-selected" : "border-line bg-page hover:border-line-strong hover:bg-hover"
                  }`}
                >
                  <Text class={`text-2xs font-medium ${active() ? "text-ink" : "text-muted"}`}>{preset()}</Text>
                </View>
              );
            }}
          </Each>
        </View>
        <Input
          testID={props.testid ? `${props.testid}-input` : "issue-tag-input"}
          accessibilityLabel={t("web.issue.tags.add")}
          value={draft()}
          placeholder={t("web.issue.tags.placeholder")}
          onChange={(e) => {
            if (e.value.endsWith(",") || e.value.endsWith("\uFF0C")) addCustom(e.value.slice(0, -1));
            else draft.set(e.value);
          }}
          onSubmit={() => addCustom()}
          class={`${props.compact === true ? "h-6.5" : "h-7"} w-full rounded-md border border-line bg-page px-2 text-xs text-ink placeholder:text-faint hover:border-faint focus:border-focus`}
        />
      </If>
    </View>
  );
}

/** Cycle-safe parent issue selector + clear button for right inspector and new-issue dialog. */
export function ParentPicker(props: {
  issueId: string;
  parentId: string;
  allIssues: readonly Issue[];
  disabled?: boolean | undefined;
  state?: "pending" | "failed" | undefined;
  testid?: string | undefined;
  onChange: (parentId: string) => void;
}) {
  const options = computed(() => eligibleParentOptions(props.issueId, props.allIssues));
  const testid = () => props.testid ?? "issue-parent-picker";
  const clearTestid = () => (props.testid ? `${props.testid}-clear` : "issue-parent-clear");
  return (
    <View class="flex-row items-center gap-1">
      <View class="min-w-0 flex-1">
        <Pick
          label={t("web.issue.family.parent")}
          testid={testid()}
          value={props.parentId}
          placeholder={t("web.issue.family.noParent")}
          disabled={props.disabled}
          state={props.state}
          options={options()}
          searchable
          searchPlaceholder={t("web.shell.palette.mode.search")}
          emptyText={t("web.issue.list.emptyFiltered")}
          onChange={props.onChange}
        />
      </View>
      <If when={props.parentId !== "" && props.disabled !== true}>
        <IconButton testid={clearTestid()} icon="close" size={12} label={t("web.issue.family.clearParent")} onClick={() => props.onChange("")} />
      </If>
    </View>
  );
}

/** Clickable `"Blocked by #N"` chips for Kanban cards, List rows, Timeline rows, and Detail headers. */
export function BlockedByChips(props: {
  blockers: readonly Issue[];
  max?: number | undefined;
  compact?: boolean | undefined;
  onOpen: (id: string) => void;
  onBeforePress?: (() => void) | undefined;
  testid?: string | undefined;
}) {
  const max = () => props.max ?? 3;
  const shown = computed(() => props.blockers.slice(0, max()));
  const extra = computed(() => Math.max(0, props.blockers.length - max()));
  const isActive = (issue: Issue) => issue.status !== "done" && issue.status !== "canceled";
  return (
    <If when={props.blockers.length > 0}>
      <View testID={props.testid ?? "issue-blocked-by-chips"} class="flex-row flex-wrap items-center gap-1">
        <Each of={shown()} key={(b) => b.id}>
          {(b) => {
            const active = () => isActive(b());
            const chipText = () => t("web.issue.deps.blockedByChip", { n: b().number });
            return (
              <View
                role="button"
                testID={props.testid ? `${props.testid}-${b().id}` : `issue-blocker-chip-${b().id}`}
                accessibilityLabel={`#${b().number} ${b().title}`}
                tooltip={<Bubble text={`#${b().number} ${b().title} · ${t(`shared.status.${b().status}`)}`} />}
                onPress={() => {
                  props.onBeforePress?.();
                  props.onOpen(b().id);
                }}
                class={`shrink-0 flex-row items-center gap-1 rounded-sm border px-1.5 py-px ${
                  active() ? "bg-warn-soft hover:border-line-strong" : "border-line bg-side opacity-75 hover:border-line-strong hover:bg-hover"
                }`}
                style={active() ? { borderColor: mix("wheat", 0.45) } : undefined}
              >
                <Icon name="lock" size={props.compact === true ? 9 : 10} tone={active() ? "warn-ink" : "muted"} />
                <Text class={`truncate font-mono text-2xs leading-3.5 ${active() ? "font-medium text-warn-ink" : "text-muted line-through"}`}>
                  {chipText()}
                </Text>
              </View>
            );
          }}
        </Each>
        <If when={extra() > 0}>
          <View class="rounded-sm border border-line bg-side px-1 py-px">
            <Text class="text-2xs leading-3.5 text-faint tabular-nums">{`+${extra()}`}</Text>
          </View>
        </If>
      </View>
    </If>
  );
}

/** Cycle-safe searchable multi-select blocker picker for IssueDetail, TodoDetail, and FamilyDetail. */
export function BlockedByPicker(props: {
  issueId: string;
  blockedBy: readonly string[];
  allIssues: readonly Issue[];
  disabled?: boolean | undefined;
  state?: "pending" | "failed" | undefined;
  testid?: string | undefined;
  onOpen?: ((id: string) => void) | undefined;
  onChange: (blockedBy: string[]) => void;
}) {
  const testid = () => props.testid ?? "issue-blocked-by-picker";
  const options = computed(() => {
    const eligible = eligibleBlockerOptions(props.issueId, props.allIssues);
    const known = new Set(eligible.map((o) => o.value));
    const extra = props.blockedBy
      .filter((id) => !known.has(id))
      .map((id) => {
        const found = props.allIssues.find((item) => item.id === id);
        return { value: id, label: found ? `#${found.number} ${found.title}` : id };
      });
    return [...eligible, ...extra];
  });
  const selectedIssues = computed(() => {
    const byId = new Map<string, Issue>(props.allIssues.map((item) => [item.id, item]));
    return props.blockedBy.flatMap((id) => {
      const found = byId.get(id);
      return found ? [found] : [];
    });
  });
  return (
    <If
      when={props.disabled === true}
      else={
        <Combobox
          multiple
          clearable
          quiet
          size="control"
          label={t("web.issue.deps.blockedBy")}
          testid={testid()}
          value={props.blockedBy}
          placeholder={t("web.issue.deps.pick")}
          emptyText={t("web.issue.list.emptyFiltered")}
          clearLabel={t("web.issue.deps.clear")}
          state={props.state}
          options={options()}
          onChange={props.onChange}
          onClear={() => props.onChange([])}
        />
      }
    >
      <If when={selectedIssues().length > 0} else={<Text class="px-2 py-1 text-xs text-faint">{t("web.issue.deps.none")}</Text>}>
        <View class="px-1 py-0.5">
          <BlockedByChips blockers={selectedIssues()} max={12} onOpen={(id) => props.onOpen?.(id)} testid={`${testid()}-readonly`} />
        </View>
      </If>
    </If>
  );
}

/** Clickable non-blocking relation chips (`Related #N` / `Duplicate #N`). */
export function RelationChips(props: {
  relations: readonly { readonly relation: IssueRelation; readonly issue: Issue }[];
  max?: number | undefined;
  compact?: boolean | undefined;
  onOpen: (id: string) => void;
  testid?: string | undefined;
}) {
  const max = () => props.max ?? 6;
  const shown = computed(() => props.relations.slice(0, max()));
  const extra = computed(() => Math.max(0, props.relations.length - max()));
  return (
    <If when={props.relations.length > 0}>
      <View testID={props.testid ?? "issue-relation-chips"} class="flex-row flex-wrap items-center gap-1">
        <Each of={shown()} key={(r) => `${r.relation.kind}:${r.issue.id}`}>
          {(entry) => {
            const chipText = () =>
              entry().relation.kind === "duplicate"
                ? t("web.issue.relations.duplicateChip", { n: entry().issue.number })
                : t("web.issue.relations.relatedChip", { n: entry().issue.number });
            return (
              <View
                role="button"
                testID={props.testid ? `${props.testid}-${entry().issue.id}` : `issue-relation-chip-${entry().issue.id}`}
                accessibilityLabel={`#${entry().issue.number} ${entry().issue.title}`}
                tooltip={<Bubble text={`#${entry().issue.number} ${entry().issue.title}`} />}
                onPress={() => props.onOpen(entry().issue.id)}
                class="shrink-0 flex-row items-center gap-1 rounded-sm border border-line bg-side px-1.5 py-px hover:border-line-strong hover:bg-hover"
              >
                <Icon name="branch" size={props.compact === true ? 9 : 10} tone="muted" />
                <Text class="truncate font-mono text-2xs leading-3.5 text-water">{chipText()}</Text>
              </View>
            );
          }}
        </Each>
        <If when={extra() > 0}>
          <View class="rounded-sm border border-line bg-side px-1 py-px">
            <Text class="text-2xs leading-3.5 text-faint tabular-nums">{`+${extra()}`}</Text>
          </View>
        </If>
      </View>
    </If>
  );
}

/** Bidirectional non-blocking relations (`related` / `duplicate`) editor for IssueDetail & TodoDetail. */
export function RelationsPicker(props: {
  issueId: string;
  relations: readonly IssueRelation[];
  allIssues: readonly Issue[];
  disabled?: boolean | undefined;
  state?: "pending" | "failed" | undefined;
  testid?: string | undefined;
  onOpen?: ((id: string) => void) | undefined;
  onChange: (relations: IssueRelation[]) => void;
}) {
  const testid = () => props.testid ?? "issue-relations-picker";
  const activeKind = signal<IssueRelationKind>("related");
  const kindOptions = computed(() => IssueRelationKindValues.map((k) => ({ value: k, label: t(`web.issue.relations.${k}`) })));
  const options = computed(() => eligibleRelationOptions(props.issueId, props.allIssues));
  const selectedForKind = computed(() => props.relations.filter((r) => r.kind === activeKind()).map((r) => r.issue));
  const resolvedAll = computed(() => {
    const byId = new Map<string, Issue>(props.allIssues.map((item) => [item.id, item]));
    return props.relations.flatMap((relation) => {
      const found = byId.get(relation.issue);
      return found ? [{ relation, issue: found }] : [];
    });
  });
  const setForKind = (ids: string[]) => {
    const kind = activeKind();
    const otherKinds = props.relations.filter((r) => r.kind !== kind);
    const nextForKind: IssueRelation[] = ids.map((id) => ({ kind, issue: issueId(id) }));
    props.onChange([...otherKinds, ...nextForKind]);
  };
  return (
    <If
      when={props.disabled === true}
      else={
        <View class="gap-1.5">
          <Select
            label={t("web.issue.relations.title")}
            testid={`${testid()}-kind`}
            size="control"
            quiet
            value={activeKind()}
            options={kindOptions()}
            onChange={(next) => activeKind.set(next)}
          />
          <Combobox
            multiple
            clearable
            quiet
            size="control"
            label={t("web.issue.relations.title")}
            testid={testid()}
            value={selectedForKind()}
            placeholder={t("web.issue.relations.pick")}
            emptyText={t("web.issue.list.emptyFiltered")}
            clearLabel={t("web.issue.relations.clear")}
            state={props.state}
            options={options()}
            onChange={setForKind}
            onClear={() => props.onChange([])}
          />
        </View>
      }
    >
      <If when={resolvedAll().length > 0} else={<Text class="px-2 py-1 text-xs text-faint">{t("web.issue.relations.none")}</Text>}>
        <View class="px-1 py-0.5">
          <RelationChips relations={resolvedAll()} max={12} onOpen={(id) => props.onOpen?.(id)} testid={`${testid()}-readonly`} />
        </View>
      </If>
    </If>
  );
}

/** Interactive calendar date picker for `startAt` and `dueAt` schedule fields (#25, #68). */
export function DatePropertyEditor(props: {
  label: string;
  value: number | undefined;
  disabled?: boolean | undefined;
  testid: string;
  placeholder?: string | undefined;
  minMs?: number | undefined;
  maxMs?: number | undefined;
  quiet?: boolean | undefined;
  showIcon?: boolean | undefined;
  onCommit: (ms: number) => void;
}) {
  return (
    <EpochDatePicker
      label={props.label}
      value={props.value}
      disabled={props.disabled}
      testid={props.testid}
      placeholder={props.placeholder}
      size="control"
      quiet={props.quiet ?? true}
      showIcon={props.showIcon ?? props.quiet === false}
      minMs={props.minMs}
      maxMs={props.maxMs}
      onChange={(ms) => {
        const current = props.value ?? 0;
        if (ms !== current) props.onCommit(ms);
      }}
    />
  );
}

/** Sub-issues section with progress bar, shown in IssueDetail, TodoDetail, and FamilyDetail whenever children exist. */
export function SubIssuesSection(props: { issueId: string; allIssues: readonly Issue[]; onOpen: (id: string) => void; bordered?: boolean | undefined }) {
  const children = computed(() => childIssuesOf(props.issueId, props.allIssues));
  const doneCount = computed(() => children().filter((c) => c.status === "done" || c.status === "canceled").length);
  const barPx = computed(() => (children().length === 0 ? 0 : Math.round((doneCount() / children().length) * 96)));
  return (
    <If when={children().length > 0}>
      <View testID="issue-sub-issues" class={props.bordered === false ? "" : "mt-7 border-t border-line pt-5"}>
        <View class="mb-2.5 flex-row items-center justify-between gap-2">
          <Text class="text-xs font-semibold text-muted">{t("web.issue.family.children")}</Text>
          <View class="flex-row items-center gap-2">
            <Text testID="issue-sub-progress-text" class="text-xs text-muted tabular-nums">
              {t("web.issue.family.subProgress", { done: doneCount(), total: children().length })}
            </Text>
            <View testID="issue-sub-progress-bar" class="h-1.5 w-24 overflow-hidden rounded-full bg-line">
              <View class="h-full rounded-full bg-leaf" style={{ width: barPx() }} />
            </View>
          </View>
        </View>
        <View class="overflow-hidden rounded-lg border border-line bg-page">
          <Each of={children()} key={(child) => child.id}>
            {(child, i) => (
              <View
                role="button"
                testID="sub-issue-row"
                accessibilityLabel={child().title}
                onPress={() => props.onOpen(child().id)}
                class={`w-full flex-row items-center gap-2.5 px-3.5 py-2 hover:bg-hover ${i() < children().length - 1 ? "border-b border-line" : ""}`}
              >
                <StatusMark status={child().status} size={13} />
                <Text class="w-10 shrink-0 font-mono text-xs text-faint tabular-nums">{`#${child().number}`}</Text>
                <Text class="min-w-0 flex-1 truncate text-sm font-medium text-ink">{child().title}</Text>
                <TagPills tags={child().tags ?? []} max={2} />
                <Text class="shrink-0 text-xs text-muted">{t(`shared.status.${child().status}`)}</Text>
              </View>
            )}
          </Each>
        </View>
      </View>
    </If>
  );
}

/** Compact avatar/icon for an `ActorRef` owner (`user:self`, collaborator `user`, or `agent`). */
export function OwnerMark(props: {
  owner: ActorRef | undefined;
  size?: number | undefined;
  showIdentity?: boolean | undefined;
  showMode?: boolean | undefined;
}) {
  const size = () => props.size ?? 16;
  const owner = () => props.owner;
  return (
    <If when={owner()} else={<NoFaceMark size={Math.max(12, size() - 2)} />}>
      {(ref) => (
        <If
          when={ref().kind === "agent"}
          else={
            <If
              when={ref().id === "self"}
              else={
                <View class="shrink-0 items-center justify-center rounded-full bg-selected" style={{ width: size(), height: size() }}>
                  <Text class="font-semibold text-ink" style={{ fontSize: Math.max(8, Math.round(size() * 0.48)), lineHeight: size() }}>
                    {initialOf(ref().id)}
                  </Text>
                </View>
              }
            >
              <UserAvatar size={size()} rounded="full" />
            </If>
          }
        >
          <AgentFaceOf agent={ref().id} size={size()} showIdentity={props.showIdentity} showMode={props.showMode} />
        </If>
      )}
    </If>
  );
}

/** Resolves a human-readable display label for an `ActorRef` owner. */
function useOwnerLabel(): () => (owner: ActorRef | undefined) => string {
  const settings = useSettings();
  const agents = useAgents();
  return computed(() => {
    const profileName = ready(settings, undefined)?.profile?.displayName?.trim();
    const agentList = ready(agents, []);
    return (owner: ActorRef | undefined) => {
      if (!owner) return t("web.issue.owner.unassigned");
      if (owner.kind === "user") {
        if (owner.id === "self") {
          return profileName ? t("web.issue.owner.selfNamed", { name: profileName }) : t("web.issue.owner.self");
        }
        return owner.id;
      }
      return agentList.find((a) => a.id === owner.id)?.name ?? owner.id;
    };
  });
}

/** Shared searchable option list for `OwnerPicker` and `BatchTriageBar`. */
export function useOwnerOptions(
  allIssues: () => readonly Issue[],
  currentOwner?: () => ActorRef | undefined,
): () => { value: string; label: string; group: string }[] {
  const settings = useSettings();
  const agents = useAgents();
  return computed(() => {
    const peopleGroup = t("web.issue.owner.peopleGroup");
    const expertsGroup = t("web.issue.owner.expertsGroup");
    const profileName = ready(settings, undefined)?.profile?.displayName?.trim();
    const selfLabel = profileName ? t("web.issue.owner.selfNamed", { name: profileName }) : t("web.issue.owner.self");
    const items: { value: string; label: string; group: string }[] = [{ value: "user:self", label: selfLabel, group: peopleGroup }];

    const collaboratorIds = new Set<string>();
    for (const issue of allIssues()) {
      if (issue.owner?.kind === "user" && issue.owner.id !== "self" && issue.owner.id.trim() !== "") {
        collaboratorIds.add(issue.owner.id);
      }
    }
    const cur = currentOwner?.();
    if (cur?.kind === "user" && cur.id !== "self" && cur.id.trim() !== "") {
      collaboratorIds.add(cur.id);
    }
    for (const userId of [...collaboratorIds].toSorted()) {
      items.push({ value: `user:${userId}`, label: userId, group: peopleGroup });
    }

    const agentList = ready(agents, [])
      .filter((a) => a.enabled)
      .toSorted((a, b) => {
        const roleDiff = Number(a.role === "orchestrator") - Number(b.role === "orchestrator");
        if (roleDiff !== 0) return roleDiff;
        const modeDiff = Number(a.mode === "external") - Number(b.mode === "external");
        if (modeDiff !== 0) return modeDiff;
        const codeDiff = (a.code ?? "").localeCompare(b.code ?? "");
        return codeDiff !== 0 ? codeDiff : a.name.localeCompare(b.name);
      });
    const seenAgents = new Set<string>();
    for (const a of agentList) {
      seenAgents.add(a.id);
      const searchLabel = [a.code, a.name, a.runtime].filter(Boolean).join(" · ");
      items.push({ value: `agent:${a.id}`, label: searchLabel, group: expertsGroup });
    }
    if (cur?.kind === "agent" && cur.id.trim() !== "" && !seenAgents.has(cur.id)) {
      items.push({ value: `agent:${cur.id}`, label: cur.id, group: expertsGroup });
    }
    return items;
  });
}

/** Searchable owner selector (`Select` with `cover={false}`) for assigning self, collaborators, or a teammate. */
export function OwnerPicker(props: {
  owner: ActorRef | undefined;
  allIssues: readonly Issue[];
  disabled?: boolean | undefined;
  quiet?: boolean | undefined;
  size?: "control" | "field" | undefined;
  state?: "pending" | "failed" | undefined;
  clearable?: boolean | undefined;
  testid?: string | undefined;
  class?: string | undefined;
  onChange: (owner: ActorRef | undefined) => void;
}) {
  const ownerLabel = useOwnerLabel();
  const agents = useAgents();
  const runtimes = useRuntimes();
  const testid = () => props.testid ?? "issue-owner-picker";
  const clearTestid = () => `${testid()}-clear`;
  const encodedValue = computed(() => encodeActorRef(props.owner));
  const agentById = computed(() => new Map(ready(agents, []).map((a) => [a.id, a])));
  const selectedAgent = computed(() => (props.owner?.kind === "agent" ? agentById().get(props.owner.id) : undefined));
  const runtimeOf = (id: string) => runtimeName(ready(runtimes, []), id);

  const options = useOwnerOptions(
    () => props.allIssues,
    () => props.owner,
  );

  const shownLabel = computed(() => ownerLabel()(props.owner));

  return (
    <View class={`flex-row items-center gap-1 ${props.class ?? ""}`}>
      <View class={props.clearable === false ? "min-w-0 shrink-0" : "min-w-0 flex-1"}>
        <If
          when={props.disabled === true}
          else={
            <Select
              quiet={props.quiet ?? true}
              size={props.size ?? "control"}
              label={t("web.issue.owner.label")}
              testid={testid()}
              value={encodedValue()}
              placeholder={t("web.issue.owner.pick")}
              state={props.state}
              options={options()}
              searchable
              searchPlaceholder={t("web.issue.owner.search")}
              emptyText={t("web.base.table.empty")}
              renderOption={(entry) => {
                const ref = decodeActorRef(entry.value);
                const found = ref?.kind === "agent" ? agentById().get(ref.id) : undefined;
                return (
                  <View testID={`${testid()}-option-${entry.value}`} class="min-w-0 flex-1 flex-row items-center gap-1.5">
                    <OwnerMark owner={ref} size={16} />
                    <If when={found}>{(a) => <AgentCodeBadge code={a().code} external={a().mode === "external"} compact />}</If>
                    <Text class="min-w-0 flex-1 truncate text-sm text-ink group-selected:font-medium">{found?.name ?? entry.title}</Text>
                    <If when={found}>
                      {(a) => (
                        <>
                          <AgentModeBadge mode={a().mode} compact />
                          <Text class="shrink-0 text-2xs text-muted">{runtimeOf(a().runtime)}</Text>
                        </>
                      )}
                    </If>
                  </View>
                );
              }}
              renderValue={() => (
                <View class="min-w-0 flex-row items-center gap-1.5">
                  <If when={props.owner}>{(o) => <OwnerMark owner={o()} size={14} />}</If>
                  <If when={selectedAgent()}>{(a) => <AgentCodeBadge code={a().code} external={a().mode === "external"} compact />}</If>
                  <Text class={`min-w-0 shrink truncate text-sm ${props.owner ? "text-ink" : "text-faint"}`}>
                    {props.owner ? shownLabel() : t("web.issue.owner.pick")}
                  </Text>
                  <If when={selectedAgent()}>{(a) => <AgentModeBadge mode={a().mode} compact />}</If>
                </View>
              )}
              onChange={(raw) => props.onChange(decodeActorRef(raw))}
            />
          }
        >
          <View testID={testid()} accessibilityLabel={t("web.issue.owner.label")} class="min-h-7 flex-row items-center gap-1.5 px-2">
            <If when={props.owner}>{(o) => <OwnerMark owner={o()} size={14} />}</If>
            <If when={selectedAgent()}>{(a) => <AgentCodeBadge code={a().code} external={a().mode === "external"} compact />}</If>
            <Text class={`min-w-0 truncate text-sm ${props.owner ? "text-ink" : "text-faint"}`}>{shownLabel()}</Text>
            <If when={selectedAgent()}>{(a) => <AgentModeBadge mode={a().mode} compact />}</If>
          </View>
        </If>
      </View>
      <If when={props.clearable !== false && props.owner !== undefined && props.disabled !== true}>
        <IconButton testid={clearTestid()} icon="close" size={12} label={t("web.issue.owner.clear")} onClick={() => props.onChange(undefined)} />
      </If>
    </View>
  );
}

/** Compact clickable child rows rendered directly inside parent cards in `top_level` / `parents_only` modes. */
export function CardChildRows(props: { children: readonly Issue[]; onOpenChild: (id: string) => void; onBeforeChildPress?: (() => void) | undefined }) {
  const doneCount = computed(() => props.children.filter((c) => c.status === "done" || c.status === "canceled").length);
  const totalCount = () => props.children.length;
  const barWidth = computed(() => (totalCount() === 0 ? 0 : Math.round((doneCount() / totalCount()) * 44)));
  return (
    <If when={props.children.length > 0}>
      <View testID="card-children" class="mt-2 rounded-md border border-line bg-side/70 p-1.5">
        <View class="mb-1 flex-row items-center justify-between gap-2 px-1">
          <Text class="text-2xs font-medium text-muted">{t("web.issue.family.children")}</Text>
          <View class="flex-row items-center gap-1.5">
            <Text testID="card-children-progress" class="text-2xs text-muted tabular-nums">
              {t("web.issue.family.compactProgress", { done: doneCount(), total: totalCount() })}
            </Text>
            <View class="h-1 w-11 overflow-hidden rounded-full bg-line">
              <View class="h-full rounded-full bg-leaf" style={{ width: barWidth() }} />
            </View>
          </View>
        </View>
        <View class="gap-0.5">
          <Each of={props.children} key={(child) => child.id}>
            {(child) => (
              <View
                role="button"
                testID={`card-child-${child().id}`}
                accessibilityLabel={`#${child().number} ${child().title}`}
                onPress={() => {
                  props.onBeforeChildPress?.();
                  props.onOpenChild(child().id);
                }}
                class="flex-row items-center gap-1.5 rounded-sm px-1.5 py-1 hover:bg-hover active:bg-selected"
              >
                <StatusMark status={child().status} size={11} />
                <Text class="shrink-0 font-mono text-2xs text-faint tabular-nums">{`#${child().number}`}</Text>
                <Text class="min-w-0 flex-1 truncate text-xs text-ink">{child().title}</Text>
              </View>
            )}
          </Each>
        </View>
      </View>
    </If>
  );
}

/** Shared collapsible group header for both Kanban swimlanes and List groups. */
export function IssueGroupHeader(props: {
  testid: string;
  label: string;
  count: number;
  expanded: boolean;
  empty?: boolean | undefined;
  groupBy: GroupBy;
  groupKey: string;
  owner?: ActorRef | undefined;
  priority?: Priority | undefined;
  onToggle: () => void;
  leading?: unknown;
}) {
  return (
    <View
      role="button"
      testID={props.testid}
      onPress={props.onToggle}
      accessibilityLabel={props.expanded ? t("web.issue.list.fold", { group: props.label }) : t("web.issue.list.unfold", { group: props.label })}
      accessibilityState={{ expanded: props.expanded }}
      class="h-full min-w-0 flex-1 flex-row items-center gap-2 px-2.5 hover:bg-hover"
    >
      <View
        class="w-4 shrink-0 items-center justify-center"
        style={{
          transform: [{ rotate: props.expanded ? "90deg" : "0deg" }],
          ...(motionOff() ? {} : { transitionProperty: "transform", transitionDuration: motionDuration(120) }),
        }}
      >
        <Icon name="expand" size={10} tone="muted" />
      </View>
      <If when={props.groupBy !== "none" || props.leading !== undefined}>
        <View class="w-4 shrink-0 items-center justify-center">
          <If when={props.groupBy === "repo"}>
            <Icon name="folder" size={14} tone="muted" />
          </If>
          <If when={props.groupBy === "owner"}>
            <OwnerMark owner={props.owner} size={15} />
          </If>
          <If when={props.groupBy === "agent"}>
            <If when={props.groupKey} else={<NoFaceMark size={14} />}>
              {(key) => <AgentFaceOf agent={key()} size={16} />}
            </If>
          </If>
          <If when={props.groupBy === "priority" ? props.priority : undefined}>{(pr) => <PriorityMark priority={pr()} size={14} />}</If>
          <If when={props.groupBy === "parent"}>
            <Icon name="indent" size={14} tone="muted" />
          </If>
        </View>
      </If>
      <Text class={`truncate text-xs font-semibold ${props.empty === true ? "text-muted" : "text-ink"}`}>{props.label}</Text>
      <CountPill count={props.count} />
    </View>
  );
}

/** Shared label lookup for multi-dimensional `GroupBy` headers across Kanban and List views. */
export function useGroupLabel(): () => (groupBy: GroupBy, key: string, parent?: Issue, owner?: ActorRef) => string {
  const ownerLabel = useOwnerLabel();
  const agents = useAgents();
  return computed(() => {
    const agentList = ready(agents, []);
    const resolveOwner = ownerLabel();
    return (groupBy: GroupBy, key: string, parent?: Issue, owner?: ActorRef): string => {
      switch (groupBy) {
        case "none":
          return t("web.issue.list.all");
        case "repo":
          return key || t("web.issue.list.noRepo");
        case "owner":
          return resolveOwner(owner);
        case "agent":
          return key ? (agentList.find((a) => a.id === key)?.name ?? key) : t("web.issue.noHelper");
        case "priority":
          switch (key) {
            case "urgent":
            case "high":
            case "medium":
            case "low":
              return t(`shared.priority.${key}`);
            default:
              return key;
          }
        case "parent":
          if (!key) return t("web.issue.groupBy.noParent");
          return parent ? `#${parent.number} ${parent.title}` : key;
      }
    };
  });
}
