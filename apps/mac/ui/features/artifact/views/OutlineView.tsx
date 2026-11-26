import { computed, Scroll, signal, Text, untracked, View } from "nsh";
import { Input } from "nsh/base";

import { t } from "@vibevalley/i18n";

import { Button } from "../../../design/Button";
import { Icon } from "../../../design/Icon";
import { IconButton } from "../../../design/IconButton";
import { Empty } from "../../../design/layout";
import { Bubble } from "../../../design/Tip";
import type { OutlineDocument, OutlineNode } from "../html";
import {
  addOutlineChild,
  addOutlineRootItem,
  addOutlineSibling,
  countOutlineTodos,
  cycleOutlineKind,
  deleteOutlineNode,
  flattenOutline,
  indentOutlineNode,
  outdentOutlineNode,
  toggleOutlineTodo,
  updateOutlineText,
} from "./previewModel";

export interface OutlineViewProps {
  readonly doc: OutlineDocument;
  readonly version?: number | undefined;
  readonly busy: boolean;
  readonly onSaveDoc: (next: OutlineDocument, summary: string) => void;
}

function kindLabelFor(kind: OutlineNode["kind"]): string {
  switch (kind) {
    case "heading":
      return t("web.artifact.outline.kindHeading");
    case "bullet":
      return t("web.artifact.outline.kindBullet");
    case "todo":
      return t("web.artifact.outline.kindTodo");
  }
}

export function OutlineView(props: OutlineViewProps) {
  const editingId = signal<string | undefined>(undefined);
  const editingText = signal("");
  const collapsedIds = signal<ReadonlySet<string>>(new Set());
  const hideDone = signal(false);
  const quickText = signal("");
  const quickKind = signal<"bullet" | "todo">("bullet");

  const readOnly = () => props.version !== undefined;
  const todoStats = computed(() => countOutlineTodos(props.doc));
  const rows = computed(() => {
    const all = flattenOutline(props.doc, collapsedIds());
    if (!hideDone()) return all;
    return all.filter((r) => !(r.node.kind === "todo" && r.node.checked === true));
  });

  const toggleCollapse = (id: string) => {
    const prev = untracked(collapsedIds);
    const next = new Set(prev);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    collapsedIds.set(next);
  };

  const beginEdit = (node: OutlineNode) => {
    if (readOnly()) return;
    editingId.set(node.id);
    editingText.set(node.text);
  };

  const commitEdit = (nodeId: string, addSiblingAfter: boolean) => {
    if (untracked(editingId) !== nodeId) return;
    const text = untracked(editingText).trim();
    editingId.set(undefined);
    if (!Object.hasOwn(props.doc.nodes, nodeId)) return;
    const existing = props.doc.nodes[nodeId];

    let nextDoc = text !== existing.text ? updateOutlineText(props.doc, nodeId, text || existing.text) : props.doc;
    if (addSiblingAfter) {
      const siblingId = `n_${Date.now().toString(36)}_${Math.floor(Math.random() * 1000)}`;
      nextDoc = addOutlineSibling(nextDoc, nodeId, siblingId, "");
      editingId.set(siblingId);
      editingText.set("");
      props.onSaveDoc(nextDoc, `Add outline item ${siblingId}`);
      return;
    }
    if (nextDoc !== props.doc) {
      props.onSaveDoc(nextDoc, `Edit ${nodeId}`);
    }
  };

  const handleAddRoot = () => {
    if (readOnly()) return;
    const id = `n_${Date.now().toString(36)}`;
    const next = addOutlineRootItem(props.doc, id, t("web.artifact.outline.untitled"), "bullet");
    props.onSaveDoc(next, `Add outline item ${id}`);
    editingId.set(id);
    editingText.set("");
  };

  const handleQuickSubmit = () => {
    const text = untracked(quickText).trim();
    if (!text || readOnly()) return;
    const id = `n_${Date.now().toString(36)}`;
    const next = addOutlineRootItem(props.doc, id, text, untracked(quickKind));
    quickText.set("");
    props.onSaveDoc(next, `Add outline item ${id}`);
  };

  return (
    <Scroll testID="artifact-outline-view" class="min-h-0 flex-1 bg-page" contentClass="mx-auto w-full max-w-2xl gap-2.5 px-5 py-4">
      <View class="flex-row flex-wrap items-center justify-between gap-2 pb-1">
        <View class="flex-row items-center gap-2">
          <If when={todoStats().total > 0}>
            <View testID="outline-progress" class="flex-row items-center gap-2">
              <View class="h-1.5 w-20 overflow-hidden rounded-full bg-selected">
                <View class="h-full rounded-full bg-accent" style={{ width: `${Math.round((todoStats().done / Math.max(1, todoStats().total)) * 100)}%` }} />
              </View>
              <Text class="font-mono text-2xs text-muted tabular-nums">
                {t("web.artifact.outline.progress", { done: todoStats().done, total: todoStats().total })}
              </Text>
              <Button size="compact" tone="quiet" testID="outline-toggle-done" onPress={() => hideDone.set(!hideDone())}>
                {hideDone() ? t("web.artifact.outline.showDone") : t("web.artifact.outline.hideDone")}
              </Button>
            </View>
          </If>
        </View>
        <If when={!readOnly()}>
          <Button size="compact" icon="add" testID="outline-add-item" disabled={props.busy} onPress={handleAddRoot}>
            {t("web.artifact.page.new")}
          </Button>
        </If>
      </View>

      <If when={rows().length > 0} else={<Empty icon="notes">{t("web.artifact.blocks.start")}</Empty>}>
        <View class="gap-0.5">
          <Each of={rows()} key={(row) => row.node.id}>
            {(row) => {
              const id = () => row().node.id;
              const isEditing = () => editingId() === id();
              const isCollapsed = () => collapsedIds().has(id());
              const canOutdent = () => !readOnly() && row().parentId !== undefined;
              return (
                <View
                  testID={`outline-node-${id()}`}
                  class="group flex-row items-start gap-1.5 rounded-md py-1 pr-1.5 hover:bg-hover"
                  style={{ paddingLeft: 6 + row().depth * 18 }}
                >
                  <If when={row().hasChildren} else={<View class="mt-0.5 size-4 shrink-0" />}>
                    <View
                      role="button"
                      testID={`outline-collapse-${id()}`}
                      accessibilityState={{ expanded: !isCollapsed() }}
                      onPress={() => toggleCollapse(id())}
                      class="mt-0.5 size-4 shrink-0 items-center justify-center rounded-xs hover:bg-selected"
                    >
                      <Icon name={isCollapsed() ? "expand" : "choose"} size={12} tone="muted" />
                    </View>
                  </If>

                  <If when={row().node.kind === "todo"}>
                    <View
                      role="button"
                      testID={`outline-todo-${id()}`}
                      onPress={() => {
                        if (readOnly()) return;
                        props.onSaveDoc(toggleOutlineTodo(props.doc, id()), `Toggle ${id()}`);
                      }}
                      class={`mt-0.5 size-4 shrink-0 items-center justify-center rounded-xs border ${
                        row().node.checked === true ? "border-accent bg-accent" : "border-idle bg-page"
                      }`}
                    >
                      <If when={row().node.checked === true}>
                        <Icon name="ticked" size={12} tone="page" />
                      </If>
                    </View>
                  </If>

                  <If when={row().node.kind === "bullet"}>
                    <View class="mt-2 size-1.5 shrink-0 rounded-full bg-faint" />
                  </If>

                  <View class="min-w-0 flex-1">
                    <If
                      when={isEditing()}
                      else={
                        <View
                          role="button"
                          testID={`outline-text-${id()}`}
                          onPress={() => beginEdit(row().node)}
                          class="min-h-5 justify-center rounded-xs px-1"
                        >
                          <Text
                            class={
                              row().node.kind === "heading"
                                ? "text-base font-semibold text-ink"
                                : row().node.checked === true
                                  ? "text-sm text-muted line-through"
                                  : "text-sm text-ink"
                            }
                          >
                            {row().node.text || t("web.artifact.outline.untitled")}
                          </Text>
                        </View>
                      }
                    >
                      <Input
                        autoFocus
                        testID={`outline-node-input-${id()}`}
                        accessibilityLabel={row().node.text || t("web.artifact.outline.untitled")}
                        value={editingText()}
                        submitBehavior="submit"
                        onChange={(e) => editingText.set(e.value)}
                        onSubmit={() => commitEdit(id(), true)}
                        onKeyPress={(e) => {
                          if (e.key === "Escape") editingId.set(undefined);
                        }}
                        onBlur={() => commitEdit(id(), false)}
                        class={`h-6 w-full rounded-sm border border-focus bg-page px-1.5 text-ink ${
                          row().node.kind === "heading" ? "text-base font-semibold" : "text-sm"
                        }`}
                      />
                    </If>
                  </View>

                  <If when={!readOnly() && !isEditing()}>
                    <View class="shrink-0 flex-row items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100">
                      <View
                        role="button"
                        testID={`outline-kind-${id()}`}
                        tooltip={<Bubble text={t("web.artifact.outline.cycleKind", { kind: kindLabelFor(row().node.kind) })} />}
                        onPress={() => props.onSaveDoc(cycleOutlineKind(props.doc, id()), `Cycle kind ${id()}`)}
                        class="h-5 items-center justify-center rounded-xs px-1 hover:bg-selected"
                      >
                        <Text class="font-mono text-2xs text-muted">{kindLabelFor(row().node.kind)}</Text>
                      </View>
                      <If when={canOutdent()}>
                        <IconButton
                          icon="back"
                          size={12}
                          label={t("web.artifact.outline.outdent")}
                          testid={`outline-outdent-${id()}`}
                          onClick={() => props.onSaveDoc(outdentOutlineNode(props.doc, id()), `Outdent ${id()}`)}
                        />
                      </If>
                      <IconButton
                        icon="indent"
                        size={12}
                        label={t("web.artifact.outline.indent")}
                        testid={`outline-indent-${id()}`}
                        onClick={() => props.onSaveDoc(indentOutlineNode(props.doc, id()), `Indent ${id()}`)}
                      />
                      <IconButton
                        icon="add"
                        size={12}
                        label={t("web.artifact.outline.addChild")}
                        testid={`outline-child-${id()}`}
                        onClick={() => {
                          const childId = `n_${Date.now().toString(36)}`;
                          const next = addOutlineChild(props.doc, id(), childId, "");
                          props.onSaveDoc(next, `Add child ${childId}`);
                          editingId.set(childId);
                          editingText.set("");
                        }}
                      />
                      <IconButton
                        icon="delete"
                        size={12}
                        label={t("web.artifact.page.delete")}
                        testid={`outline-delete-${id()}`}
                        onClick={() => props.onSaveDoc(deleteOutlineNode(props.doc, id()), `Delete ${id()}`)}
                      />
                    </View>
                  </If>
                </View>
              );
            }}
          </Each>
        </View>
      </If>

      <If when={!readOnly()}>
        <View class="mt-1 flex-row items-center gap-2 rounded-md border border-line bg-side px-2.5 py-1.5">
          <View
            role="button"
            testID="outline-quick-kind"
            onPress={() => quickKind.set(quickKind() === "bullet" ? "todo" : "bullet")}
            class="h-5 shrink-0 items-center justify-center rounded-xs border border-line bg-page px-1.5 hover:bg-hover"
          >
            <Text class="font-mono text-2xs text-muted">{kindLabelFor(quickKind())}</Text>
          </View>
          <Input
            testID="outline-quick-add"
            value={quickText()}
            placeholder={t("web.artifact.outline.quickAdd")}
            accessibilityLabel={t("web.artifact.outline.quickAdd")}
            submitBehavior="submit"
            onChange={(e) => quickText.set(e.value)}
            onSubmit={handleQuickSubmit}
            class="min-w-0 flex-1 bg-transparent text-sm text-ink placeholder:text-faint"
          />
        </View>
      </If>
    </Scroll>
  );
}
