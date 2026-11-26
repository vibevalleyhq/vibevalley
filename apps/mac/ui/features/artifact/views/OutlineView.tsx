import { computed, effect, keymap, Scroll, signal, Text, untracked, View, type InputRef } from "nsh";
import { Input, Menu, MenuItem, MenuSeparator } from "nsh/base";

import { t } from "@vibevalley/i18n";

import { Checkbox } from "../../../design/Checkbox";
import { Icon } from "../../../design/Icon";
import { Empty } from "../../../design/layout";
import { motionClass, popupTransition } from "../../../design/motion";
import { Bubble } from "../../../design/Tip";
import type { OutlineDocument, OutlineNode } from "../html";
import {
  adjacentOutlineRowId,
  canIndentOutlineNode,
  canOutdentOutlineNode,
  deleteEmptyOutlineNode,
  flushOutlineDraftText,
  indentOutlineWithFocus,
  insertOutlineSibling,
  moveOutlineNodeVertical,
  outdentOutlineWithFocus,
  outlineRowPaddingLeft,
  visibleOutlineRows,
} from "./outlineEditor";
import { addOutlineChild, addOutlineRootItem, deleteOutlineNode, toggleOutlineTodo } from "./previewModel";

export interface OutlineViewProps {
  readonly doc: OutlineDocument;
  readonly version?: number | undefined;
  readonly hideDone?: boolean | undefined;
  readonly addRequest?: number | undefined;
  readonly onSaveDoc: (next: OutlineDocument, summary: string) => void;
}

const rowMenuPopupClass = `min-w-40 gap-0.5 rounded-lg border border-line bg-elevated p-1 shadow-float ${motionClass("transition-opacity duration-120 ease-out")}`;
const rowMenuItemClass = "h-7 flex-row items-center gap-2 rounded-md px-2 hover:bg-hover focus:bg-hover";
const rowMenuSeparatorClass = "my-1 h-px bg-line";

const OUTLINE_KINDS: readonly OutlineNode["kind"][] = ["heading", "bullet", "todo"];

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

function setOutlineNodeKind(doc: OutlineDocument, nodeId: string, kind: OutlineNode["kind"]): OutlineDocument {
  if (!Object.hasOwn(doc.nodes, nodeId)) return doc;
  const node = doc.nodes[nodeId];
  if (node.kind === kind) return doc;
  return {
    ...doc,
    nodes: {
      ...doc.nodes,
      [nodeId]: {
        id: node.id,
        text: node.text,
        kind,
        children: node.children,
        ...(kind === "todo" ? { checked: node.checked === true } : {}),
      },
    },
  };
}

export function OutlineView(props: OutlineViewProps) {
  const editingId = signal<string | undefined>(undefined);
  const editingText = signal("");
  const collapsedIds = signal<ReadonlySet<string>>(new Set());
  const quickText = signal("");
  const quickKind = signal<"bullet" | "todo">("bullet");

  let activeInputRef: InputRef | undefined;
  let nextNodeSeq = 0;
  const makeNodeId = () => `n_${Date.now().toString(36)}_${++nextNodeSeq}`;

  const readOnly = () => props.version !== undefined;
  const rows = computed(() => visibleOutlineRows(props.doc, { collapsed: collapsedIds(), hideDone: props.hideDone }));

  const refocusEditingInput = (targetId: string) => {
    queueMicrotask(() => {
      if (untracked(editingId) === targetId) {
        activeInputRef?.focus();
      }
    });
  };

  const toggleCollapse = (id: string) => {
    const prev = untracked(collapsedIds);
    const next = new Set(prev);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    collapsedIds.set(next);
  };

  const commitEdit = (nodeId: string, addSiblingAfter: boolean) => {
    if (untracked(editingId) !== nodeId) return;
    const baseDoc = flushOutlineDraftText(props.doc, nodeId, untracked(editingText).trim());
    if (addSiblingAfter) {
      const siblingId = makeNodeId();
      const res = insertOutlineSibling(baseDoc, nodeId, siblingId, "");
      editingId.set(res.focusId);
      editingText.set("");
      props.onSaveDoc(res.doc, `Add outline item ${res.focusId}`);
      return;
    }
    editingId.set(undefined);
    if (baseDoc !== props.doc) {
      props.onSaveDoc(baseDoc, `Edit ${nodeId}`);
    }
  };

  const beginEdit = (node: OutlineNode) => {
    if (readOnly()) return;
    const prevId = untracked(editingId);
    if (prevId !== undefined && prevId !== node.id) {
      commitEdit(prevId, false);
    }
    editingId.set(node.id);
    editingText.set(node.text);
  };

  const cancelEdit = () => {
    editingId.set(undefined);
  };

  const handleIndent = (direction: "in" | "out") => {
    const nodeId = untracked(editingId);
    if (nodeId === undefined || readOnly()) return;
    const baseDoc = flushOutlineDraftText(props.doc, nodeId, untracked(editingText));
    const prevCollapsed = untracked(collapsedIds);
    const res = direction === "in" ? indentOutlineWithFocus(baseDoc, nodeId, prevCollapsed) : outdentOutlineWithFocus(baseDoc, nodeId, prevCollapsed);
    if (res.collapsed !== prevCollapsed) {
      collapsedIds.set(res.collapsed);
    }
    if (res.changed) {
      editingId.set(res.focusId);
      props.onSaveDoc(res.doc, `${direction === "in" ? "Indent" : "Outdent"} ${nodeId}`);
      refocusEditingInput(res.focusId);
    } else if (baseDoc !== props.doc) {
      props.onSaveDoc(baseDoc, `Edit ${nodeId}`);
    }
  };

  const handleMoveRowFocus = (direction: "up" | "down") => {
    const nodeId = untracked(editingId);
    if (nodeId === undefined || readOnly()) return;
    const nextId = adjacentOutlineRowId(untracked(rows), nodeId, direction);
    if (nextId === undefined) return;
    const baseDoc = flushOutlineDraftText(props.doc, nodeId, untracked(editingText).trim());
    const nextText = Object.hasOwn(baseDoc.nodes, nextId) ? baseDoc.nodes[nextId].text : "";
    editingId.set(nextId);
    editingText.set(nextText);
    if (baseDoc !== props.doc) {
      props.onSaveDoc(baseDoc, `Edit ${nodeId}`);
    }
  };

  const handleMoveNodeVertical = (direction: "up" | "down") => {
    const nodeId = untracked(editingId);
    if (nodeId === undefined || readOnly()) return;
    const baseDoc = flushOutlineDraftText(props.doc, nodeId, untracked(editingText));
    const res = moveOutlineNodeVertical(baseDoc, nodeId, direction);
    if (res.changed) {
      editingId.set(res.focusId);
      props.onSaveDoc(res.doc, `Move ${nodeId} ${direction}`);
      refocusEditingInput(res.focusId);
    } else if (baseDoc !== props.doc) {
      props.onSaveDoc(baseDoc, `Edit ${nodeId}`);
    }
  };

  const handleDeleteEmpty = () => {
    const nodeId = untracked(editingId);
    if (nodeId === undefined || readOnly()) return;
    const draft = untracked(editingText);
    const res = deleteEmptyOutlineNode(props.doc, untracked(rows), nodeId, draft);
    if (!res.deleted) return;
    if (res.focusId !== undefined && Object.hasOwn(res.doc.nodes, res.focusId)) {
      editingId.set(res.focusId);
      editingText.set(res.doc.nodes[res.focusId].text);
    } else {
      editingId.set(undefined);
      editingText.set("");
    }
    props.onSaveDoc(res.doc, `Delete ${nodeId}`);
  };

  const handleAddRoot = () => {
    if (readOnly()) return;
    const id = makeNodeId();
    const next = addOutlineRootItem(props.doc, id, "", "bullet");
    editingId.set(id);
    editingText.set("");
    props.onSaveDoc(next, `Add outline item ${id}`);
  };

  let handledAddRequest = untracked(() => props.addRequest ?? 0);
  effect(() => {
    const req = props.addRequest ?? 0;
    if (req <= handledAddRequest) return;
    handledAddRequest = req;
    untracked(() => handleAddRoot());
  });

  // Guard keymap bindings with low-frequency computed booleans so keystrokes never rebind listeners.
  const isEditingAny = computed(() => !readOnly() && editingId() !== undefined);
  effect(() => {
    if (!isEditingAny()) return;
    return keymap.bind(
      {
        tab: () => handleIndent("in"),
        "shift+tab": () => handleIndent("out"),
        up: () => handleMoveRowFocus("up"),
        down: () => handleMoveRowFocus("down"),
        "alt+up": () => handleMoveNodeVertical("up"),
        "alt+down": () => handleMoveNodeVertical("down"),
        escape: () => cancelEdit(),
      },
      { when: "always" },
    );
  });

  const isEditingEmpty = computed(() => !readOnly() && editingId() !== undefined && editingText() === "");
  effect(() => {
    if (!isEditingEmpty()) return;
    return keymap.bind(
      {
        backspace: () => handleDeleteEmpty(),
      },
      { when: "always" },
    );
  });

  const handleQuickSubmit = () => {
    const text = untracked(quickText).trim();
    if (!text || readOnly()) return;
    const id = makeNodeId();
    const next = addOutlineRootItem(props.doc, id, text, untracked(quickKind));
    quickText.set("");
    props.onSaveDoc(next, `Add outline item ${id}`);
  };

  return (
    <Scroll testID="artifact-outline-view" class="min-h-0 flex-1 bg-page" contentClass="mx-auto w-full max-w-2xl gap-2.5 px-5 py-4">
      <If when={rows().length > 0} else={<Empty icon="notes">{t("web.artifact.blocks.start")}</Empty>}>
        <View class="gap-0.5">
          <Each of={rows()} key={(row) => row.node.id}>
            {(row, idx) => {
              const id = () => row().node.id;
              const isEditing = () => editingId() === id();
              const isCollapsed = () => collapsedIds().has(id());
              const canOutdent = () => !readOnly() && canOutdentOutlineNode(props.doc, id());
              const canIndent = () => !readOnly() && canIndentOutlineNode(props.doc, id());
              const isHeading = () => row().node.kind === "heading";
              return (
                <View
                  testID={`outline-node-${id()}`}
                  class={`group relative flex-row items-start gap-1 rounded-md py-1 pr-2 ${isEditing() ? "" : "hover:bg-hover"} ${
                    isHeading() && idx() > 0 ? "mt-2" : ""
                  }`}
                  style={{ paddingLeft: outlineRowPaddingLeft(row().depth) }}
                >
                  <If when={row().hasChildren} else={<View class="mt-px h-6 w-5 shrink-0" />}>
                    <View
                      role="button"
                      testID={`outline-collapse-${id()}`}
                      accessibilityState={{ expanded: !isCollapsed() }}
                      onPress={() => toggleCollapse(id())}
                      class="mt-px h-6 w-5 shrink-0 items-center justify-center rounded-xs hover:bg-selected"
                    >
                      <Icon name={isCollapsed() ? "expand" : "choose"} size={12} tone="muted" />
                    </View>
                  </If>

                  <If when={!isHeading()}>
                    <View class="mt-px h-6 w-5 shrink-0 items-center justify-center">
                      <If when={row().node.kind === "todo"} else={<View class="size-1.5 rounded-full bg-faint" />}>
                        <Checkbox
                          checked={row().node.checked === true}
                          disabled={readOnly()}
                          label={row().node.text || t("web.artifact.outline.untitled")}
                          testid={`outline-todo-${id()}`}
                          onChange={() => {
                            if (readOnly()) return;
                            props.onSaveDoc(toggleOutlineTodo(props.doc, id()), `Toggle ${id()}`);
                          }}
                        />
                      </If>
                    </View>
                  </If>

                  <View class="min-w-0 flex-1">
                    <If
                      when={isEditing()}
                      else={
                        <View
                          role="button"
                          testID={`outline-text-${id()}`}
                          onPress={() => beginEdit(row().node)}
                          class="w-full rounded-sm border border-transparent px-1.5"
                        >
                          <Text
                            class={
                              isHeading()
                                ? row().node.text
                                  ? "text-base leading-6 font-semibold text-ink"
                                  : "text-base leading-6 font-semibold text-faint"
                                : row().node.checked === true
                                  ? "text-sm leading-6 text-muted line-through"
                                  : row().node.text
                                    ? "text-sm leading-6 text-ink"
                                    : "text-sm leading-6 text-faint"
                            }
                          >
                            {row().node.text || t("web.artifact.outline.untitled")}
                          </Text>
                        </View>
                      }
                    >
                      <Input
                        ref={(el) => {
                          activeInputRef = el;
                        }}
                        autoFocus
                        multiline
                        scrollbar={false}
                        testID={`outline-node-input-${id()}`}
                        accessibilityLabel={row().node.text || t("web.artifact.outline.untitled")}
                        placeholder={t("web.artifact.outline.untitled")}
                        value={editingText()}
                        submitBehavior="submit"
                        onChange={(e) => {
                          if (untracked(editingText) !== e.value) editingText.set(e.value);
                        }}
                        onSubmit={() => commitEdit(id(), true)}
                        onBlur={() => commitEdit(id(), false)}
                        class={`w-full rounded-sm border border-transparent bg-hover px-1.5 leading-6 text-ink placeholder:text-faint ${
                          isHeading() ? "text-base font-semibold" : "text-sm"
                        }`}
                      />
                    </If>
                  </View>

                  <If when={!readOnly() && !isEditing()}>
                    <View class="absolute top-1.5 right-1.5 z-10">
                      <Menu
                        placement="bottom"
                        align="end"
                        offset={4}
                        popupClass={rowMenuPopupClass}
                        popupStartingClass={popupTransition("opacity-0")}
                        popupEndingClass={popupTransition("opacity-0")}
                        trigger={
                          <View
                            testID={`outline-more-${id()}`}
                            accessibilityLabel={t("web.artifact.page.more")}
                            class="size-5 shrink-0 items-center justify-center rounded-xs opacity-0 group-hover:opacity-100 hover:bg-selected focus-within:opacity-100 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-focus aria-expanded:bg-selected aria-expanded:opacity-100"
                          >
                            <Icon name="more" size={14} tone="muted" />
                          </View>
                        }
                      >
                        <Each of={OUTLINE_KINDS} key={(kind) => kind}>
                          {(kind) => (
                            <MenuItem
                              testID={`outline-kind-${kind()}-${id()}`}
                              onSelect={() => {
                                const next = setOutlineNodeKind(props.doc, id(), kind());
                                if (next !== props.doc) props.onSaveDoc(next, `Set kind ${kind()} ${id()}`);
                              }}
                              class={rowMenuItemClass}
                            >
                              <Text class="min-w-0 flex-1 truncate text-sm text-ink">{kindLabelFor(kind())}</Text>
                              <If when={row().node.kind === kind()}>
                                <Icon name="check" size={12} tone="accent" />
                              </If>
                            </MenuItem>
                          )}
                        </Each>
                        <MenuSeparator class={rowMenuSeparatorClass} />
                        <MenuItem
                          testID={`outline-child-${id()}`}
                          onSelect={() => {
                            const childId = makeNodeId();
                            const prevCollapsed = untracked(collapsedIds);
                            if (prevCollapsed.has(id())) {
                              const nextCollapsed = new Set(prevCollapsed);
                              nextCollapsed.delete(id());
                              collapsedIds.set(nextCollapsed);
                            }
                            const next = addOutlineChild(props.doc, id(), childId, "");
                            editingId.set(childId);
                            editingText.set("");
                            props.onSaveDoc(next, `Add child ${childId}`);
                          }}
                          class={rowMenuItemClass}
                        >
                          <View class="size-3.5 shrink-0 items-center justify-center">
                            <Icon name="add" size={14} tone="muted" />
                          </View>
                          <Text class="min-w-0 flex-1 truncate text-sm text-ink">{t("web.artifact.outline.addChild")}</Text>
                        </MenuItem>
                        <If when={canIndent()}>
                          <MenuItem
                            testID={`outline-indent-${id()}`}
                            onSelect={() => {
                              const prevCollapsed = untracked(collapsedIds);
                              const res = indentOutlineWithFocus(props.doc, id(), prevCollapsed);
                              if (res.collapsed !== prevCollapsed) collapsedIds.set(res.collapsed);
                              if (res.changed) props.onSaveDoc(res.doc, `Indent ${id()}`);
                            }}
                            class={rowMenuItemClass}
                          >
                            <View class="size-3.5 shrink-0 items-center justify-center">
                              <Icon name="indent" size={14} tone="muted" />
                            </View>
                            <Text class="min-w-0 flex-1 truncate text-sm text-ink">{t("web.artifact.outline.indent")}</Text>
                          </MenuItem>
                        </If>
                        <If when={canOutdent()}>
                          <MenuItem
                            testID={`outline-outdent-${id()}`}
                            onSelect={() => {
                              const prevCollapsed = untracked(collapsedIds);
                              const res = outdentOutlineWithFocus(props.doc, id(), prevCollapsed);
                              if (res.changed) props.onSaveDoc(res.doc, `Outdent ${id()}`);
                            }}
                            class={rowMenuItemClass}
                          >
                            <View class="size-3.5 shrink-0 items-center justify-center">
                              <Icon name="back" size={14} tone="muted" />
                            </View>
                            <Text class="min-w-0 flex-1 truncate text-sm text-ink">{t("web.artifact.outline.outdent")}</Text>
                          </MenuItem>
                        </If>
                        <MenuSeparator class={rowMenuSeparatorClass} />
                        <MenuItem
                          testID={`outline-delete-${id()}`}
                          onSelect={() => props.onSaveDoc(deleteOutlineNode(props.doc, id()), `Delete ${id()}`)}
                          class="h-7 flex-row items-center gap-2 rounded-md px-2 hover:bg-bad-soft focus:bg-bad-soft"
                        >
                          <View class="size-3.5 shrink-0 items-center justify-center">
                            <Icon name="delete" size={14} tone="berry" />
                          </View>
                          <Text class="min-w-0 flex-1 truncate text-sm text-berry">{t("web.artifact.page.delete")}</Text>
                        </MenuItem>
                      </Menu>
                    </View>
                  </If>
                </View>
              );
            }}
          </Each>
        </View>
      </If>

      <If when={!readOnly()}>
        <View
          testID="outline-quick-bar"
          class="mt-1 flex-row items-center gap-1 rounded-md py-1 pr-2 hover:bg-hover focus-within:bg-hover"
          style={{ paddingLeft: outlineRowPaddingLeft(0) }}
        >
          <View class="h-6 w-5 shrink-0 items-center justify-center">
            <Icon name="add" size={12} tone="faint" />
          </View>
          <View
            role="button"
            testID="outline-quick-kind"
            accessibilityLabel={t("web.artifact.outline.cycleKind", { kind: kindLabelFor(quickKind()) })}
            tooltip={<Bubble text={t("web.artifact.outline.cycleKind", { kind: kindLabelFor(quickKind()) })} />}
            onPress={() => quickKind.set(quickKind() === "bullet" ? "todo" : "bullet")}
            class="h-6 w-5 shrink-0 items-center justify-center rounded-xs hover:bg-selected focus-visible:outline-2 focus-visible:outline-focus"
          >
            <If when={quickKind() === "todo"} else={<View class="size-1.5 rounded-full bg-faint" />}>
              <View class="size-3.5 items-center justify-center rounded-xs border border-idle bg-page" />
            </If>
          </View>
          <Input
            testID="outline-quick-add"
            value={quickText()}
            placeholder={t("web.artifact.outline.quickAdd")}
            accessibilityLabel={t("web.artifact.outline.quickAdd")}
            submitBehavior="submit"
            onFocus={() => {
              const prevId = untracked(editingId);
              if (prevId !== undefined) commitEdit(prevId, false);
            }}
            onChange={(e) => {
              if (untracked(quickText) !== e.value) quickText.set(e.value);
            }}
            onSubmit={handleQuickSubmit}
            class="min-w-0 flex-1 rounded-sm border border-transparent bg-transparent px-1.5 text-sm leading-6 text-ink placeholder:text-faint"
          />
        </View>
      </If>
    </Scroll>
  );
}
