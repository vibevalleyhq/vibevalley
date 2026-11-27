import { computed, signal, Text, untracked, View } from "nsh";
import { Input } from "nsh/base";

import { t } from "@vibevalley/i18n";
import type { Agent, BaseCellValue, BaseColumn, Issue, IssueId, Note, NoteId } from "@vibevalley/protocol";
import { issueId as toIssueId, noteId as toNoteId } from "@vibevalley/protocol/schema";

import { Button } from "../../../design/Button";
import { Checkbox } from "../../../design/Checkbox";
import { Combobox } from "../../../design/Combobox";
import { DatePicker } from "../../../design/DatePicker";
import { AgentFace } from "../../../design/domain/Face";
import { Select, TextInput } from "../../../design/Field";
import { Icon } from "../../../design/Icon";
import { Bubble } from "../../../design/Tip";
import { mix } from "../../../design/tone";
import { baseCellAsBool, baseCellAsNumber, baseCellAsStrings, baseCellAsText, findSelectOption, formatBaseNumber, optionToneLook } from "./baseModel";

export interface BaseCellContext {
  readonly rowId: string;
  readonly col: BaseColumn;
  readonly cell: BaseCellValue | undefined;
  readonly notesById: ReadonlyMap<string, Note>;
  readonly issuesById: ReadonlyMap<string, Issue>;
  readonly agentsById: ReadonlyMap<string, Agent>;
  readonly notes: readonly Note[];
  readonly issues: readonly Issue[];
  readonly agents: readonly Agent[];
  readonly busy: boolean;
  readonly dense?: boolean | undefined;
  readonly onCommitCell: (colId: string, next: BaseCellValue) => void;
  readonly onRunAgentRow: (colId: string, rowId: string) => void;
  readonly onOpenNote: (id: NoteId) => void;
  readonly onOpenIssue: (id: IssueId) => void;
}

function SelectPill(props: { readonly label: string; readonly color?: string | undefined }) {
  const look = () => optionToneLook(props.color);
  return (
    <View
      class={`h-5 max-w-full flex-row items-center rounded-sm px-1.5 ${look().bgClass}`}
      style={look().mixToken !== undefined ? { backgroundColor: mix(look().mixToken ?? "water", 0.14) } : undefined}
    >
      <Text class={`truncate text-2xs font-medium ${look().textClass}`}>{props.label}</Text>
    </View>
  );
}

function agentStatusTone(status: string): { readonly bg: string; readonly text: string } {
  switch (status) {
    case "done":
    case "completed":
    case "spawned":
      return { bg: "bg-ok-soft", text: "text-ok-ink" };
    case "failed":
    case "error":
      return { bg: "bg-bad-soft", text: "text-berry" };
    case "running":
    case "queued":
    case "working":
      return { bg: "bg-warn-soft", text: "text-warn-ink" };
    default:
      return { bg: "bg-hover", text: "text-muted" };
  }
}

export function BaseCellControl(props: BaseCellContext) {
  const editing = signal(false);
  const draft = signal("");

  const textVal = computed(() => baseCellAsText(props.cell));
  const numVal = computed(() => (props.cell?._tag === "number" ? formatBaseNumber(props.cell.value) : textVal()));
  const boolVal = computed(() => baseCellAsBool(props.cell));
  const stringsVal = computed(() => baseCellAsStrings(props.cell));

  const issueOptions = computed(() =>
    props.issues.map((iss) => ({
      value: String(iss.id),
      label: `#${iss.number} ${iss.title}`,
    })),
  );
  const noteOptions = computed(() =>
    props.notes.map((n) => ({
      value: String(n.id),
      label: n.title,
    })),
  );
  const agentOptions = computed(() =>
    props.agents.map((a) => ({
      value: a.id,
      label: a.name,
    })),
  );

  const startTextEdit = () => {
    draft.set(props.col.kind === "number" ? String(baseCellAsNumber(props.cell)) : textVal());
    editing.set(true);
  };

  const commitTextEdit = () => {
    if (!untracked(editing)) return;
    const raw = untracked(draft);
    editing.set(false);
    if (props.col.kind === "number") {
      const parsed = Number(raw.trim());
      props.onCommitCell(props.col.id, { _tag: "number", value: Number.isFinite(parsed) ? parsed : 0 });
      return;
    }
    props.onCommitCell(props.col.id, { _tag: "text", value: raw });
  };

  return (
    <View class="w-full min-w-0 flex-1 overflow-hidden">
      <If when={props.col.kind === "text"}>
        <If
          when={editing()}
          else={
            <View
              role="button"
              testID={`base-cell-${props.rowId}-${props.col.id}`}
              onPress={startTextEdit}
              class="min-h-6 justify-center rounded-xs px-1.5 py-0.5 hover:bg-hover"
            >
              <Text class={`truncate text-xs ${textVal() ? "text-ink" : "text-faint"}`}>{textVal() || "—"}</Text>
            </View>
          }
        >
          <Input
            autoFocus
            testID={`base-cell-input-${props.rowId}-${props.col.id}`}
            value={draft()}
            submitBehavior="submit"
            onChange={(e) => draft.set(e.value)}
            onSubmit={commitTextEdit}
            onKeyPress={(e) => {
              if (e.key === "Escape") editing.set(false);
            }}
            onBlur={commitTextEdit}
            class="h-7 w-full rounded-sm border border-focus bg-page px-2 text-xs text-ink"
          />
        </If>
      </If>

      <If when={props.col.kind === "number"}>
        <If
          when={editing()}
          else={
            <View
              role="button"
              testID={`base-cell-${props.rowId}-${props.col.id}`}
              onPress={startTextEdit}
              class="min-h-6 justify-center rounded-xs px-1.5 py-0.5 hover:bg-hover"
            >
              <Text class={`truncate font-mono text-xs tabular-nums ${props.dense === true ? "text-right" : ""} ${props.cell ? "text-ink" : "text-faint"}`}>
                {props.cell ? numVal() : "—"}
              </Text>
            </View>
          }
        >
          <Input
            autoFocus
            testID={`base-cell-input-${props.rowId}-${props.col.id}`}
            value={draft()}
            submitBehavior="submit"
            onChange={(e) => draft.set(e.value)}
            onSubmit={commitTextEdit}
            onKeyPress={(e) => {
              if (e.key === "Escape") editing.set(false);
            }}
            onBlur={commitTextEdit}
            class="h-7 w-full rounded-sm border border-focus bg-page px-2 font-mono text-xs text-ink"
          />
        </If>
      </If>

      <If when={props.col.kind === "select"}>
        <Select
          testid={`base-cell-select-${props.rowId}-${props.col.id}`}
          label={props.col.name}
          size="control"
          text="xs"
          quiet={props.dense === true}
          disabled={props.busy}
          value={textVal()}
          placeholder={t("web.base.form.unset")}
          options={(props.col.options ?? []).map((opt) => ({ value: opt.value, label: opt.label ?? opt.value }))}
          onChange={(v) => props.onCommitCell(props.col.id, { _tag: "text", value: v })}
          renderValue={(item) => {
            const opt = () => findSelectOption(props.col, item.value());
            return (
              <If when={item.value()} else={<Text class="text-xs text-faint">{t("web.base.form.unset")}</Text>}>
                <SelectPill label={opt()?.label ?? item.label()} color={opt()?.color} />
              </If>
            );
          }}
          renderOption={(entry) => {
            const opt = () => findSelectOption(props.col, entry.value);
            return (
              <If when={entry.value} else={<Text class="text-xs text-faint">{entry.title}</Text>}>
                <SelectPill label={entry.title} color={opt()?.color} />
              </If>
            );
          }}
        />
      </If>

      <If when={props.col.kind === "multiSelect"}>
        <Combobox
          multiple
          testid={`base-cell-multi-${props.rowId}-${props.col.id}`}
          label={props.col.name}
          size="control"
          text="xs"
          quiet={props.dense === true}
          disabled={props.busy}
          value={stringsVal()}
          placeholder={t("web.base.form.unset")}
          options={(props.col.options ?? []).map((opt) => ({ value: opt.value, label: opt.label ?? opt.value }))}
          onChange={(next) => props.onCommitCell(props.col.id, { _tag: "strings", items: next })}
        />
      </If>

      <If when={props.col.kind === "date"}>
        <DatePicker
          testid={`base-cell-date-${props.rowId}-${props.col.id}`}
          label={props.col.name}
          size="control"
          quiet={props.dense === true}
          disabled={props.busy}
          value={textVal() || undefined}
          onChange={(next) => {
            const iso = typeof next === "string" ? next : Array.isArray(next) ? (next[0] ?? "") : "";
            props.onCommitCell(props.col.id, { _tag: "text", value: iso });
          }}
        />
      </If>

      <If when={props.col.kind === "checkbox"}>
        <View class="h-6 flex-row items-center px-1">
          <Checkbox
            testid={`base-cell-check-${props.rowId}-${props.col.id}`}
            label={props.col.name}
            checked={boolVal()}
            disabled={props.busy}
            onChange={(checked) => props.onCommitCell(props.col.id, { _tag: "bool", value: checked })}
          />
        </View>
      </If>

      <If when={props.col.kind === "media"}>
        <If
          when={props.dense === true}
          else={
            <View class="gap-1">
              <TextInput
                testID={`base-cell-media-input-${props.rowId}-${props.col.id}`}
                value={textVal()}
                placeholder="asset/cover.png"
                disabled={props.busy}
                onInput={(v) => {
                  props.onCommitCell(props.col.id, { _tag: "text", value: v });
                }}
              />
            </View>
          }
        >
          <View
            role="button"
            testID={`base-cell-media-${props.rowId}-${props.col.id}`}
            onPress={startTextEdit}
            class="min-h-6 flex-row items-center gap-1.5 rounded-xs px-1.5 py-0.5 hover:bg-hover"
          >
            <Icon name="image" size={12} tone={textVal() ? "accent" : "faint"} />
            <Text class={`min-w-0 flex-1 truncate font-mono text-2xs ${textVal() ? "text-ink" : "text-faint"}`}>{textVal() || "—"}</Text>
          </View>
        </If>
      </If>

      <If when={props.col.kind === "issueRef"}>
        <View class={props.dense === true ? "w-full min-w-0 flex-row items-center gap-1 overflow-hidden" : "w-full min-w-0 flex-col items-stretch gap-1.5"}>
          <If when={props.cell?._tag === "issueRef" && props.cell.issueId !== "" ? props.cell.issueId : undefined}>
            {(issueId) => {
              const found = () => props.issuesById.get(issueId());
              return (
                <View
                  role="button"
                  testID={`base-cell-issue-link-${props.rowId}-${props.col.id}`}
                  onPress={() => props.onOpenIssue(issueId())}
                  class={
                    props.dense === true
                      ? "h-6 max-w-28 min-w-0 shrink flex-row items-center gap-1 rounded-sm border border-line bg-side px-1.5 hover:bg-hover"
                      : "h-6 max-w-full min-w-0 flex-row items-center gap-1 self-start rounded-sm border border-line bg-side px-1.5 hover:bg-hover"
                  }
                >
                  <Icon name="issues" size={11} tone="accent" />
                  <Text class="min-w-0 flex-1 truncate font-mono text-2xs font-medium text-ink">
                    {found() ? `#${found()?.number} ${found()?.title}` : issueId()}
                  </Text>
                </View>
              );
            }}
          </If>
          <Select
            testid={`base-cell-issue-pick-${props.rowId}-${props.col.id}`}
            label={props.col.name}
            size="control"
            text="xs"
            quiet={props.dense === true}
            searchable
            disabled={props.busy}
            value={props.cell?._tag === "issueRef" ? String(props.cell.issueId) : ""}
            placeholder={props.cell?._tag === "issueRef" && props.cell.issueId !== "" ? undefined : t("web.base.form.unset")}
            options={issueOptions()}
            onChange={(v) => props.onCommitCell(props.col.id, { _tag: "issueRef", issueId: toIssueId(v) })}
            class={props.dense === true ? "min-w-14 flex-1" : "w-full min-w-0"}
          />
        </View>
      </If>

      <If when={props.col.kind === "noteRef"}>
        <View class={props.dense === true ? "w-full min-w-0 flex-row items-center gap-1 overflow-hidden" : "w-full min-w-0 flex-col items-stretch gap-1.5"}>
          <If when={props.cell?._tag === "noteRef" && props.cell.noteId !== "" ? props.cell.noteId : undefined}>
            {(noteId) => {
              const found = () => props.notesById.get(noteId());
              return (
                <View
                  role="button"
                  testID={`base-cell-note-link-${props.rowId}-${props.col.id}`}
                  onPress={() => props.onOpenNote(noteId())}
                  class={
                    props.dense === true
                      ? "h-6 max-w-28 min-w-0 shrink flex-row items-center gap-1 rounded-sm border border-line bg-side px-1.5 hover:bg-hover"
                      : "h-6 max-w-full min-w-0 flex-row items-center gap-1 self-start rounded-sm border border-line bg-side px-1.5 hover:bg-hover"
                  }
                >
                  <Icon name="notes" size={11} tone="accent" />
                  <Text class="min-w-0 flex-1 truncate text-2xs font-medium text-ink">{found()?.title ?? noteId()}</Text>
                </View>
              );
            }}
          </If>
          <Select
            testid={`base-cell-note-pick-${props.rowId}-${props.col.id}`}
            label={props.col.name}
            size="control"
            text="xs"
            quiet={props.dense === true}
            searchable
            disabled={props.busy}
            value={props.cell?._tag === "noteRef" ? String(props.cell.noteId) : ""}
            placeholder={props.cell?._tag === "noteRef" && props.cell.noteId !== "" ? undefined : t("web.base.form.unset")}
            options={noteOptions()}
            onChange={(v) => props.onCommitCell(props.col.id, { _tag: "noteRef", noteId: toNoteId(v) })}
            class={props.dense === true ? "min-w-14 flex-1" : "w-full min-w-0"}
          />
        </View>
      </If>

      <If when={props.col.kind === "agentRef"}>
        <Select
          testid={`base-cell-agent-${props.rowId}-${props.col.id}`}
          label={props.col.name}
          size="control"
          text="xs"
          quiet={props.dense === true}
          searchable
          disabled={props.busy}
          value={props.cell?._tag === "agentRef" ? props.cell.agentId : ""}
          placeholder={t("web.base.form.unset")}
          options={agentOptions()}
          onChange={(v) => props.onCommitCell(props.col.id, { _tag: "agentRef", agentId: v })}
          renderValue={(item) => {
            const agent = () => props.agentsById.get(item.value());
            return (
              <If when={agent()} else={<Text class="text-xs text-faint">{item.value() || t("web.base.form.unset")}</Text>}>
                {(a) => (
                  <View class="flex-row items-center gap-1.5">
                    <AgentFace agentId={a().id} name={a().name} look={a().look} size={16} />
                    <Text class="truncate text-xs text-ink">{a().name}</Text>
                  </View>
                )}
              </If>
            );
          }}
        />
      </If>

      <If when={props.col.kind === "formula"}>
        <View
          testID={`base-cell-formula-${props.rowId}-${props.col.id}`}
          tooltip={<If when={props.col.formula}>{(expr) => <Bubble text={`fx: ${expr()}`} />}</If>}
          class="min-h-6 flex-row items-center gap-1.5 rounded-sm border border-line bg-side px-2 py-0.5"
        >
          <Text class="font-mono text-2xs font-semibold text-accent">fx</Text>
          <Text class="min-w-0 flex-1 truncate font-mono text-xs text-ink tabular-nums">{textVal() || "—"}</Text>
        </View>
      </If>

      <If when={props.col.kind === "agentAction"}>
        <View
          testID={`base-cell-agent-action-${props.rowId}-${props.col.id}`}
          class={props.dense === true ? "w-full min-w-0 flex-row items-center gap-1 overflow-hidden" : "flex-row flex-wrap items-center gap-1.5"}
        >
          <Button
            size="compact"
            tone="plain"
            icon="play"
            testID={`base-run-row-${props.rowId}-${props.col.id}`}
            disabled={props.busy}
            onPress={() => props.onRunAgentRow(props.col.id, props.rowId)}
          >
            {t("web.note.base.runAgentColumn")}
          </Button>
          <If when={props.cell?._tag === "agentRun" ? props.cell : undefined}>
            {(run) => {
              const st = () => agentStatusTone(run().status);
              return (
                <>
                  <View class={`h-5 items-center justify-center rounded-sm px-1.5 ${st().bg}`}>
                    <Text class={`font-mono text-2xs font-medium ${st().text}`}>{run().status}</Text>
                  </View>
                  <If when={run().summary}>{(sum) => <Text class="max-w-36 truncate text-2xs text-muted">{sum()}</Text>}</If>
                  <If when={run().spawnedIssueId}>
                    {(issId) => {
                      const linked = () => props.issuesById.get(issId());
                      return (
                        <View
                          role="button"
                          testID={`base-agent-spawned-issue-${props.rowId}-${props.col.id}`}
                          onPress={() => props.onOpenIssue(issId())}
                          class="h-5 flex-row items-center gap-1 rounded-sm border border-line bg-page px-1.5 hover:bg-hover"
                        >
                          <Icon name="issues" size={10} tone="accent" />
                          <Text class="font-mono text-2xs font-medium text-ink">{linked() ? `#${linked()?.number}` : issId()}</Text>
                        </View>
                      );
                    }}
                  </If>
                  <If when={run().sessionId}>
                    {(sid) => (
                      <Text testID={`base-agent-session-${props.rowId}-${props.col.id}`} class="font-mono text-2xs text-faint">
                        {sid().slice(0, 8)}
                      </Text>
                    )}
                  </If>
                </>
              );
            }}
          </If>
        </View>
      </If>
    </View>
  );
}
