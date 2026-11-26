import { computed, keymap, signal, Text, View } from "nsh";
import { Input } from "nsh/base";

import { t } from "@vibevalley/i18n";

import { createAct } from "../../../design/act";
import { Button } from "../../../design/Button";
import { TextArea, TextInput } from "../../../design/Field";
import { Icon } from "../../../design/Icon";
import { CountPill } from "../../../design/Tag";
import { Bubble } from "../../../design/Tip";
import { mix } from "../../../design/tone";
import { api } from "../../../infra/api";
import { useQueryClient } from "../../../infra/query";
import { untrack } from "../../../infra/solid";

export const criteriaList = (text: string) =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

const parseCriterion = (line: string): { checked: boolean; text: string } => {
  const m = /^\[([xX ])\]\s*(.*)$/u.exec(line);
  if (!m) return { checked: false, text: line };
  return { checked: m[1] === "x" || m[1] === "X", text: (m[2] ?? "").trim() };
};

export const toggleCriterionLine = (line: string): string => {
  const { checked, text } = parseCriterion(line);
  return checked ? text : `[x] ${text}`;
};

/** Interactive acceptance-criteria checklist with inline multiline markdown-list editing. */
export function TodoCriteriaSection(props: {
  value: string;
  criteria: readonly string[];
  editable: boolean;
  busy: boolean;
  onInput: (value: string) => void;
  onToggle: (index: number) => void;
}) {
  const editing = signal(false);
  return (
    <View class="mt-5">
      <If
        when={editing()}
        else={
          <If
            when={props.criteria.length > 0}
            else={
              <If when={props.editable}>
                <Button size="compact" tone="quiet" icon="add" testID="issue-edit-criteria" class="self-start" onPress={() => editing.set(true)}>
                  {t("web.issue.todo.addCriteria")}
                </Button>
              </If>
            }
          >
            <View testID="issue-criteria-preview">
              <View class="mb-2 flex-row items-center justify-between gap-2">
                <View class="flex-row items-center gap-1.5">
                  <Text class="text-xs font-semibold text-muted">{t("web.issue.todo.criteria")}</Text>
                  <CountPill count={props.criteria.length} />
                </View>
                <If when={props.editable}>
                  <Button size="compact" tone="quiet" icon="edit" testID="issue-edit-criteria" onPress={() => editing.set(true)}>
                    {t("web.issue.todo.edit")}
                  </Button>
                </If>
              </View>
              <View class="overflow-hidden rounded-lg border border-line bg-page">
                <Each of={props.criteria} key="index">
                  {(c, i) => {
                    const parsed = () => parseCriterion(c());
                    return (
                      <View
                        role={props.editable ? "button" : undefined}
                        testID="todo-criterion"
                        accessibilityLabel={props.editable ? t("web.issue.todo.criterionToggle", { criterion: parsed().text }) : undefined}
                        accessibilityState={props.editable ? { checked: parsed().checked, disabled: props.busy } : undefined}
                        onPress={() => props.editable && !props.busy && props.onToggle(i())}
                        class={`flex-row items-start gap-2.5 px-3.5 py-2.5 ${props.editable ? "hover:bg-hover" : ""} ${i() < props.criteria.length - 1 ? "border-b" : ""}`}
                        style={i() < props.criteria.length - 1 ? { borderColor: mix("line", 0.55) } : undefined}
                      >
                        <View
                          testID={parsed().checked ? "todo-criterion-checked" : "todo-criterion-unchecked"}
                          class={`mt-0.5 size-4 shrink-0 items-center justify-center rounded-xs border ${
                            parsed().checked ? "border-leaf bg-leaf" : "border-idle bg-page"
                          }`}
                        >
                          <If when={parsed().checked}>
                            <Icon name="ticked" size={12} tone="page" />
                          </If>
                        </View>
                        <Text class={`min-w-0 flex-1 text-sm leading-snug ${parsed().checked ? "text-muted line-through" : "text-ink"}`}>{parsed().text}</Text>
                      </View>
                    );
                  }}
                </Each>
              </View>
            </View>
          </If>
        }
      >
        <View class="mb-2 flex-row items-center justify-between gap-2">
          <Text class="text-xs font-semibold text-muted">{t("web.issue.todo.criteria")}</Text>
          <Button size="compact" tone="quiet" icon="check" testID="issue-edit-criteria-done" onPress={() => editing.set(false)}>
            {t("web.issue.todo.doneEditing")}
          </Button>
        </View>
        <TextArea
          testID="issue-criteria-input"
          autoFocus
          rows={3}
          value={props.value}
          onInput={(v) => props.onInput(v)}
          placeholder={t("web.issue.todo.criteriaHint")}
          accessibilityLabel={t("web.issue.todo.criteria")}
        />
      </If>
    </View>
  );
}

/** Preview-first wrapping draft title: click toggles inline multiline input; Return/blur commits, Escape cancels. */
export function TodoTitle(props: { value: string; editable: boolean; onCommit: (title: string) => void }) {
  const editing = signal(false);
  let typed = "";
  const finish = (keep: boolean) => {
    if (!editing()) return;
    editing.set(false);
    const next = typed.replace(/[\r\n]+/gu, " ").trim();
    if (keep && next !== "" && next !== props.value) props.onCommit(next);
  };
  return (
    <If
      when={editing()}
      else={
        <If
          when={props.editable}
          else={
            <Text role="header" testID="issue-title" class="text-2xl leading-snug font-semibold text-ink">
              {props.value}
            </Text>
          }
        >
          <View
            role="button"
            testID="issue-title-trigger"
            accessibilityLabel={t("web.issue.detail.rename")}
            tooltip={<Bubble text={t("web.issue.detail.rename")} />}
            onPress={() => {
              typed = props.value;
              editing.set(true);
            }}
            class="-mx-1 max-w-full self-start rounded-sm px-1 hover:bg-hover"
          >
            <Text role="header" testID="issue-title" class="text-2xl leading-snug font-semibold text-ink">
              {props.value || t("web.issue.todo.titleHint")}
            </Text>
          </View>
        </If>
      }
    >
      <TodoTitleInput initial={props.value} onInput={(v) => (typed = v)} onFinish={finish} />
    </If>
  );
}

function TodoTitleInput(props: { initial: string; onInput: (v: string) => void; onFinish: (keep: boolean) => void }) {
  const draft = signal(untrack(() => props.initial));
  keymap.bind("escape", () => props.onFinish(false), { when: "always" });
  return (
    <Input
      multiline
      submitBehavior="submit"
      autoFocus
      testID="issue-title-input"
      value={draft()}
      onChange={(e) => {
        const clean = e.value.replace(/[\r\n]+/gu, " ");
        draft.set(clean);
        props.onInput(clean);
      }}
      onSubmit={() => props.onFinish(true)}
      onBlur={() => props.onFinish(true)}
      placeholder={t("web.issue.todo.titleHint")}
      accessibilityLabel={t("web.issue.todo.title")}
      class="-mx-2 w-full rounded-md border border-focus bg-page px-2 py-1 text-2xl leading-snug font-semibold text-ink placeholder:text-faint"
    />
  );
}

export function NewRepoPopoverBody(props: { onClose: () => void; onMade: (name: string) => void }) {
  const queries = useQueryClient();
  const name = signal("");
  const act = createAct();
  const canCreate = computed(() => Boolean(name().trim()) && !act.busy());
  const make = async () => {
    const wanted = name().trim();
    if (!wanted) return;
    const made = await act.run(() => api.repo.create({ name: wanted }));
    if (!made) return;
    await queries.invalidate({ prefix: ["repos"] });
    props.onMade(made.name);
  };
  return (
    <View testID="new-repo-dialog" class="gap-2.5">
      <Text class="text-xs font-semibold text-ink">{t("web.issue.todo.newRepo")}</Text>
      <TextInput
        autoFocus
        value={name()}
        onInput={(v) => name.set(v)}
        onSubmit={() => void make()}
        placeholder={t("web.issue.todo.repoHint")}
        accessibilityLabel={t("web.issue.todo.repoName")}
      />
      <View class="flex-row justify-end gap-1.5">
        <Button size="compact" tone="quiet" onPress={() => props.onClose()}>
          {t("web.issue.never")}
        </Button>
        <Button size="compact" tone="primary" disabled={!canCreate()} onPress={() => void make()}>
          {t("web.issue.todo.create")}
        </Button>
      </View>
    </View>
  );
}
