import { computed, effect, keymap, signal, Text, View } from "nsh";
import { Input } from "nsh/base";

import { t } from "@vibevalley/i18n";
import type { Issue } from "@vibevalley/protocol";

type CriterionCheck = Issue["checks"][number];

import { Button } from "../../../design/Button";
import { TextInput } from "../../../design/Field";
import { Icon } from "../../../design/Icon";
import { IconButton } from "../../../design/IconButton";
import type { IconName } from "../../../design/icons";
import { CountPill, Tag, type TagTone } from "../../../design/Tag";
import { Bubble } from "../../../design/Tip";
import { mix } from "../../../design/tone";
import { createAct } from "../../../infra/act";
import { api } from "../../../infra/api";
import { useQueryClient } from "../../../infra/query";
import { untrack } from "../../../infra/solid";

export const criteriaList = (text: string) =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

export const parseCriterion = (line: string): { checked: boolean; text: string; proof: string } => {
  const m = /^\[([xX ])\]\s*(.*)$/u.exec(line);
  const checked = m ? m[1] === "x" || m[1] === "X" : false;
  const rawBody = (m ? (m[2] ?? "") : line).trim();
  const sep = rawBody.indexOf(" | ");
  if (sep < 0) return { checked, text: rawBody, proof: "" };
  return {
    checked,
    text: rawBody.slice(0, sep).trim(),
    proof: rawBody.slice(sep + 3).trim(),
  };
};

const serializeCriterion = (checked: boolean, text: string, proof: string): string => {
  const cleanText = text.replace(/[\r\n]+/gu, " ").trim();
  const cleanProof = proof.replace(/[\r\n]+/gu, " ").trim();
  const body = cleanProof !== "" ? `${cleanText} | ${cleanProof}` : cleanText;
  return checked ? `[x] ${body}` : body;
};

export const toggleCriterionLine = (line: string): string => {
  const { checked, text, proof } = parseCriterion(line);
  return serializeCriterion(!checked, text, proof);
};

function criterionStatusTag(
  checked: boolean,
  check: CriterionCheck | undefined,
): { readonly tone: TagTone; readonly icon: IconName | undefined; readonly label: string } {
  if (check) {
    switch (check.result) {
      case "met":
        return { tone: "ok", icon: "check", label: t("web.issue.detail.result.met") };
      case "unmet":
        return { tone: "bad", icon: "cross", label: t("web.issue.detail.result.unmet") };
      case "unsure":
        return { tone: "wait", icon: "warn", label: t("web.issue.detail.result.unsure") };
    }
  }
  return checked
    ? { tone: "ok", icon: "check", label: t("web.issue.todo.criteriaTable.statusDone") }
    : { tone: "neutral", icon: undefined, label: t("web.issue.todo.criteriaTable.statusPending") };
}

function CriterionCellInput(props: {
  initial: string;
  placeholder: string;
  testid: string;
  accessibilityLabel: string;
  onCommit: (next: string) => void;
  onCancel: () => void;
}) {
  const draft = signal(untrack(() => props.initial));
  keymap.bind("escape", () => props.onCancel(), { when: "always" });
  return (
    <Input
      submitBehavior="submit"
      autoFocus
      testID={props.testid}
      value={draft()}
      onChange={(e) => draft.set(e.value.replace(/[\r\n]+/gu, " "))}
      onSubmit={() => props.onCommit(draft())}
      onBlur={() => props.onCommit(draft())}
      placeholder={props.placeholder}
      accessibilityLabel={props.accessibilityLabel}
      class="w-full rounded-sm border border-focus bg-page px-1.5 py-0.5 text-sm leading-snug text-ink placeholder:text-faint"
    />
  );
}

export function TodoCriteriaSection(props: {
  value: string;
  criteria: readonly string[];
  checks?: readonly CriterionCheck[] | undefined;
  editable: boolean;
  busy: boolean;
  onInput: (value: string) => void;
  onToggle: (index: number) => void;
}) {
  const editing = signal(false);
  const tableStarted = signal(false);
  const editingCell = signal<{ index: number; field: "text" | "proof" } | undefined>(undefined);
  const newItem = signal("");
  const editorMinHeight = computed(() => Math.max(76, props.criteria.length * 40));
  effect(() => {
    if (editing()) return keymap.bind("escape", () => editing.set(false), { when: "always" });
  });

  const showTable = computed(() => props.criteria.length > 0 || (props.editable && tableStarted()));
  const checkFor = (idx: number) => props.checks?.find((c) => c.criterion === idx);

  const commitCell = (idx: number, field: "text" | "proof", rawVal: string) => {
    editingCell.set(undefined);
    const lines = [...props.criteria];
    const existing = lines[idx];
    if (existing === undefined) return;
    const parsed = parseCriterion(existing);
    const nextText = field === "text" ? rawVal.trim() : parsed.text;
    const nextProof = field === "proof" ? rawVal.trim() : parsed.proof;
    if (field === "text" && nextText === "") {
      lines.splice(idx, 1);
    } else {
      lines[idx] = serializeCriterion(parsed.checked, nextText, nextProof);
    }
    const nextRaw = lines.join("\n");
    if (nextRaw !== props.value) props.onInput(nextRaw);
  };

  const removeRow = (idx: number) => {
    editingCell.set(undefined);
    const lines = [...props.criteria];
    lines.splice(idx, 1);
    props.onInput(lines.join("\n"));
  };

  const addRow = () => {
    const clean = newItem()
      .replace(/[\r\n]+/gu, " ")
      .trim();
    if (clean === "") return;
    const nextLines = [...props.criteria, clean];
    newItem.set("");
    props.onInput(nextLines.join("\n"));
  };

  return (
    <View class="mt-6 border-t border-line pt-5">
      <If
        when={editing()}
        else={
          <If
            when={showTable()}
            else={
              <If when={props.editable}>
                <View class="flex-row items-center gap-2">
                  <Button size="compact" tone="quiet" icon="add" testID="todo-criterion-start-table" onPress={() => tableStarted.set(true)}>
                    {t("web.issue.todo.addCriteria")}
                  </Button>
                  <Button size="compact" tone="quiet" icon="edit" testID="issue-edit-criteria" onPress={() => editing.set(true)}>
                    {t("web.issue.todo.criteriaTable.batchEdit")}
                  </Button>
                </View>
              </If>
            }
          >
            <View testID="issue-criteria-preview">
              <View class="mb-2.5 h-6 flex-row items-center justify-between gap-2">
                <View class="flex-row items-center gap-1.5">
                  <Text class="text-xs font-semibold text-muted">{t("web.issue.todo.criteria")}</Text>
                  <If when={props.criteria.length > 0}>
                    <CountPill count={props.criteria.length} />
                  </If>
                </View>
                <If when={props.editable}>
                  <Button size="compact" tone="quiet" icon="edit" testID="issue-edit-criteria" onPress={() => editing.set(true)}>
                    {t("web.issue.todo.criteriaTable.batchEdit")}
                  </Button>
                </If>
              </View>
              <View class="overflow-hidden rounded-lg border border-line bg-page">
                <View class="flex-row items-center border-b border-line bg-side">
                  <View
                    accessibilityLabel={t("web.issue.todo.criteriaTable.colCheck")}
                    class="w-9 shrink-0 items-center justify-center border-r border-line py-1.5"
                    style={{ borderColor: mix("line", 0.55) }}
                  >
                    <Icon name="ticked" size={11} tone="muted" />
                  </View>
                  <View class="min-w-0 flex-1 flex-row items-center gap-1.5 border-r border-line px-3 py-1.5" style={{ borderColor: mix("line", 0.55) }}>
                    <Icon name="issues" size={11} tone="muted" />
                    <Text class="text-2xs font-medium text-muted">{t("web.issue.todo.criteriaTable.colItem")}</Text>
                  </View>
                  <View class="w-24 shrink-0 flex-row items-center gap-1 border-r border-line px-2.5 py-1.5" style={{ borderColor: mix("line", 0.55) }}>
                    <Icon name="check" size={11} tone="muted" />
                    <Text class="text-2xs font-medium text-muted">{t("web.issue.todo.criteriaTable.colStatus")}</Text>
                  </View>
                  <View class="w-40 shrink-0 flex-row items-center gap-1 px-3 py-1.5">
                    <Icon name="notes" size={11} tone="muted" />
                    <Text class="text-2xs font-medium text-muted">{t("web.issue.todo.criteriaTable.colProof")}</Text>
                  </View>
                  <If when={props.editable}>
                    <View class="w-8 shrink-0 py-1.5" />
                  </If>
                </View>
                <Each of={props.criteria} key="index">
                  {(c, i) => {
                    const parsed = () => parseCriterion(c());
                    const statusMeta = () => criterionStatusTag(parsed().checked, checkFor(i()));
                    const proofText = () => checkFor(i())?.proof || parsed().proof;
                    const isEditingText = () => editingCell()?.index === i() && editingCell()?.field === "text";
                    const isEditingProof = () => editingCell()?.index === i() && editingCell()?.field === "proof";
                    return (
                      <View
                        class={`flex-row items-stretch ${i() < props.criteria.length - 1 ? "border-b" : ""}`}
                        style={i() < props.criteria.length - 1 ? { borderColor: mix("line", 0.55) } : undefined}
                      >
                        <View
                          role={props.editable ? "button" : undefined}
                          testID="todo-criterion"
                          accessibilityLabel={props.editable ? t("web.issue.todo.criterionToggle", { criterion: parsed().text }) : undefined}
                          accessibilityState={props.editable ? { checked: parsed().checked, disabled: props.busy } : undefined}
                          onPress={() => props.editable && !props.busy && props.onToggle(i())}
                          class={`w-9 shrink-0 items-center justify-center border-r border-line py-2.5 ${props.editable ? "hover:bg-hover" : ""}`}
                          style={{ borderColor: mix("line", 0.55) }}
                        >
                          <View
                            testID={parsed().checked ? "todo-criterion-checked" : "todo-criterion-unchecked"}
                            class={`size-4 items-center justify-center rounded-xs border ${parsed().checked ? "border-leaf bg-leaf" : "border-idle bg-page"}`}
                          >
                            <If when={parsed().checked}>
                              <Icon name="ticked" size={12} tone="page" />
                            </If>
                          </View>
                        </View>
                        <View class="min-w-0 flex-1 justify-center border-r border-line px-3 py-2" style={{ borderColor: mix("line", 0.55) }}>
                          <If
                            when={isEditingText()}
                            else={
                              <If
                                when={props.editable}
                                else={<Text class={`text-sm leading-snug ${parsed().checked ? "text-muted line-through" : "text-ink"}`}>{parsed().text}</Text>}
                              >
                                <View
                                  role="button"
                                  testID={`todo-criterion-text-${i()}`}
                                  onPress={() => editingCell.set({ index: i(), field: "text" })}
                                  class="-mx-1.5 rounded-sm px-1.5 py-0.5 hover:bg-hover"
                                >
                                  <Text class={`text-sm leading-snug ${parsed().checked ? "text-muted line-through" : "text-ink"}`}>{parsed().text}</Text>
                                </View>
                              </If>
                            }
                          >
                            <CriterionCellInput
                              initial={parsed().text}
                              placeholder={t("web.issue.todo.criteriaTable.itemPlaceholder")}
                              testid={`todo-criterion-text-input-${i()}`}
                              accessibilityLabel={t("web.issue.todo.criteriaTable.colItem")}
                              onCommit={(val) => commitCell(i(), "text", val)}
                              onCancel={() => editingCell.set(undefined)}
                            />
                          </If>
                        </View>
                        <View class="w-24 shrink-0 justify-center border-r border-line px-2.5 py-2" style={{ borderColor: mix("line", 0.55) }}>
                          <Tag tone={statusMeta().tone} icon={statusMeta().icon} label={statusMeta().label} />
                        </View>
                        <View class="w-40 shrink-0 justify-center px-3 py-2">
                          <If
                            when={isEditingProof()}
                            else={
                              <If
                                when={props.editable}
                                else={
                                  <Text class={`text-xs leading-snug ${proofText() ? "text-muted" : "text-faint"}`}>
                                    {proofText() || t("web.issue.todo.criteriaTable.proofEmpty")}
                                  </Text>
                                }
                              >
                                <View
                                  role="button"
                                  testID={`todo-criterion-proof-${i()}`}
                                  onPress={() => editingCell.set({ index: i(), field: "proof" })}
                                  class="-mx-1.5 rounded-sm px-1.5 py-0.5 hover:bg-hover"
                                >
                                  <Text class={`text-xs leading-snug ${proofText() ? "text-muted" : "text-faint"}`}>
                                    {proofText() || t("web.issue.todo.criteriaTable.proofEmpty")}
                                  </Text>
                                </View>
                              </If>
                            }
                          >
                            <CriterionCellInput
                              initial={parsed().proof}
                              placeholder={t("web.issue.todo.criteriaTable.proofPlaceholder")}
                              testid={`todo-criterion-proof-input-${i()}`}
                              accessibilityLabel={t("web.issue.todo.criteriaTable.colProof")}
                              onCommit={(val) => commitCell(i(), "proof", val)}
                              onCancel={() => editingCell.set(undefined)}
                            />
                          </If>
                        </View>
                        <If when={props.editable}>
                          <View class="w-8 shrink-0 items-center justify-center">
                            <IconButton
                              icon="cross"
                              size={12}
                              testid={`todo-criterion-delete-${i()}`}
                              label={t("web.issue.todo.criteriaTable.removeRow")}
                              onClick={() => removeRow(i())}
                            />
                          </View>
                        </If>
                      </View>
                    );
                  }}
                </Each>
                <If when={props.editable}>
                  <View class="flex-row items-center gap-2 border-t border-line bg-side px-2.5 py-1.5" style={{ borderColor: mix("line", 0.55) }}>
                    <Input
                      submitBehavior="submit"
                      testID="todo-criterion-new-input"
                      value={newItem()}
                      onChange={(e) => newItem.set(e.value)}
                      onSubmit={() => addRow()}
                      placeholder={t("web.issue.todo.criteriaTable.itemPlaceholder")}
                      accessibilityLabel={t("web.issue.todo.criteriaTable.addRow")}
                      class="min-w-0 flex-1 rounded-sm border border-line bg-page px-2 py-1 text-xs text-ink placeholder:text-faint focus:border-focus"
                    />
                    <Button size="compact" tone="quiet" icon="add" testID="todo-criterion-add-row" disabled={!newItem().trim()} onPress={addRow}>
                      {t("web.issue.todo.criteriaTable.addRow")}
                    </Button>
                  </View>
                </If>
              </View>
            </View>
          </If>
        }
      >
        <View class="mb-2.5 h-6 flex-row items-center justify-between gap-2">
          <View class="flex-row items-center gap-1.5">
            <Text class="text-xs font-semibold text-muted">{t("web.issue.todo.criteria")}</Text>
            <If when={props.criteria.length > 0}>
              <CountPill count={props.criteria.length} />
            </If>
          </View>
          <Button size="compact" tone="quiet" icon="check" testID="issue-edit-criteria-done" onPress={() => editing.set(false)}>
            {t("web.issue.todo.doneEditing")}
          </Button>
        </View>
        <Input
          multiline
          submitBehavior="newline"
          testID="issue-criteria-input"
          autoFocus
          value={props.value}
          onChange={(e) => props.onInput(e.value)}
          placeholder={t("web.issue.todo.criteriaHint")}
          accessibilityLabel={t("web.issue.todo.criteria")}
          style={{ minHeight: editorMinHeight() }}
          class="w-full rounded-lg border border-focus bg-page px-3.5 py-2.5 text-sm leading-snug text-ink placeholder:text-faint"
        />
      </If>
    </View>
  );
}

/** Preview-first wrapping draft title with isomorphic view/edit box model (0px vertical shift). */
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
            <View class="-mx-2 w-full rounded-md border border-transparent px-2 py-1">
              <Text role="header" testID="issue-title" class="text-2xl leading-snug font-semibold text-ink">
                {props.value}
              </Text>
            </View>
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
            class="-mx-2 w-full rounded-md border border-transparent px-2 py-1 hover:border-line hover:bg-hover"
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
