import { computed, signal, Text, View } from "nsh";
import { Input } from "nsh/base";

import { t } from "@vibevalley/i18n";
import type { Issue } from "@vibevalley/protocol";

import { EpochDatePicker } from "../../../design/DatePicker";
import { Icon } from "../../../design/Icon";
import { IconButton } from "../../../design/IconButton";
import { Bubble } from "../../../design/Tip";
import { childIssuesOf, eligibleParentOptions, issueTagPresets, normalizeTagList } from "../model/meta";
import { StatusMark } from "./Marks";
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
