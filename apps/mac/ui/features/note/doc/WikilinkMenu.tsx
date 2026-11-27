import { computed, effect, keymap, Scroll, signal, Text, untracked, View } from "nsh";

import { t } from "@vibevalley/i18n";
import type { Issue, IssueStatus, Note, NoteType } from "@vibevalley/protocol";

import { Icon } from "../../../design/Icon";
import type { IconName } from "../../../design/icons";
import { Dot, type DotTone } from "../../../design/Tag";
import { matches } from "../../../infra/base/search";
import type { WikilinkMode } from "./docOps";

const statusDotTone: Record<IssueStatus, DotTone> = {
  backlog: "faint",
  todo: "muted",
  in_progress: "water",
  in_review: "wheat",
  done: "leaf",
  canceled: "faint",
};

export type WikilinkSuggestion =
  | { readonly key: string; readonly kind: "note"; readonly note: Note }
  | { readonly key: string; readonly kind: "issue"; readonly issue: Issue };

export interface WikilinkMenuProps {
  readonly open: boolean;
  readonly mode: WikilinkMode;
  readonly query: string;
  readonly notes: readonly Note[];
  readonly issues: readonly Issue[];
  readonly testID?: string | undefined;
  readonly onSelect: (item: WikilinkSuggestion) => void;
  readonly onClose: () => void;
}

function noteTypeIcon(noteType: NoteType): IconName {
  switch (noteType) {
    case "doc":
      return "notes";
    case "base":
      return "catalog";
    case "canvas":
      return "idea";
    case "media":
      return "image";
  }
}

function noteTypeLabel(noteType: NoteType): string {
  switch (noteType) {
    case "doc":
      return t("web.note.types.doc");
    case "base":
      return t("web.note.types.base");
    case "canvas":
      return t("web.note.types.canvas");
    case "media":
      return t("web.note.types.media");
  }
}

export function filterWikilinkSuggestions(mode: WikilinkMode, query: string, notes: readonly Note[], issues: readonly Issue[]): readonly WikilinkSuggestion[] {
  const q = query.trim().toLowerCase();
  const out: WikilinkSuggestion[] = [];
  if (mode !== "issue") {
    for (const note of notes) {
      if (mode === "embed" && note.noteType !== "base") continue;
      if (!q || matches(q, [note.title, note.id, note.noteType])) {
        out.push({ key: `note:${note.id}`, kind: "note", note });
      }
      if (out.length >= 12) break;
    }
  }
  for (const issue of issues) {
    const numStr = `#${issue.number}`;
    if (!q || matches(q, [issue.title, numStr, String(issue.number), issue.repo, issue.id])) {
      out.push({ key: `issue:${issue.id}`, kind: "issue", issue });
    }
    if (out.length >= 20) break;
  }
  return out;
}

function asIssue(item: WikilinkSuggestion): Issue | undefined {
  return item.kind === "issue" ? item.issue : undefined;
}

function asNote(item: WikilinkSuggestion): Note | undefined {
  return item.kind === "note" ? item.note : undefined;
}

export function WikilinkMenu(props: WikilinkMenuProps) {
  const activeIndex = signal(0);

  const suggestions = computed(() => filterWikilinkSuggestions(props.mode, props.query, props.notes, props.issues));

  effect(() => {
    const len = suggestions().length;
    if (len === 0 || untracked(activeIndex) >= len) {
      activeIndex.set(0);
    }
  });

  effect(() => {
    const _q = props.query;
    const _m = props.mode;
    void _q;
    void _m;
    activeIndex.set(0);
  });

  const isNavActive = computed(() => props.open && suggestions().length > 0);
  effect(() => {
    if (!isNavActive()) return;
    return keymap.bind(
      {
        up: () => {
          const list = untracked(suggestions);
          if (list.length === 0) return;
          activeIndex.set((untracked(activeIndex) - 1 + list.length) % list.length);
        },
        down: () => {
          const list = untracked(suggestions);
          if (list.length === 0) return;
          activeIndex.set((untracked(activeIndex) + 1) % list.length);
        },
        enter: () => {
          const list = untracked(suggestions);
          const chosen = list[untracked(activeIndex)];
          if (chosen !== undefined) props.onSelect(chosen);
        },
        escape: () => props.onClose(),
      },
      { when: "always" },
    );
  });

  const isEmptyOpen = computed(() => props.open && suggestions().length === 0);
  effect(() => {
    if (!isEmptyOpen()) return;
    return keymap.bind({ escape: () => props.onClose() }, { when: "always" });
  });

  const headerLabel = () => {
    switch (props.mode) {
      case "embed":
        return "Embed Base or Issue";
      case "issue":
        return "Reference Issue";
      case "wikilink":
        return "Link Note or Issue";
    }
  };

  return (
    <If when={props.open}>
      <View testID={props.testID ?? "doc-wikilink-menu"} class="z-20 mt-1 w-80 overflow-hidden rounded-lg border border-line-strong bg-elevated shadow-float">
        <View class="flex-row items-center justify-between border-b border-line px-2.5 py-1.5">
          <Text class="text-2xs font-semibold text-muted">{headerLabel()}</Text>
          <If when={props.query.trim().length > 0}>
            <Text class="font-mono text-2xs text-accent">{props.query}</Text>
          </If>
        </View>
        <Scroll class="max-h-64" contentClass="gap-0.5 p-1.5">
          <If
            when={suggestions().length > 0}
            else={
              <View class="items-center px-3 py-4">
                <Text class="text-xs text-faint">{t("web.base.table.empty")}</Text>
              </View>
            }
          >
            <Each of={suggestions()} key={(item) => item.key}>
              {(item, idx) => {
                const isActive = () => activeIndex() === idx();
                return (
                  <View
                    role="button"
                    testID={`doc-wikilink-item-${item().key}`}
                    accessibilityState={{ selected: isActive() }}
                    onPress={() => props.onSelect(item())}
                    class={`flex-row items-center gap-2 rounded-md px-2 py-1.5 hover:bg-hover ${isActive() ? "bg-selected" : ""}`}
                  >
                    <If
                      when={asNote(item())}
                      else={
                        <If when={asIssue(item())}>
                          {(found) => (
                            <>
                              <Dot tone={statusDotTone[found().status]} size={9} ring={false} />
                              <Text class="shrink-0 font-mono text-2xs text-muted tabular-nums">{`#${found().number}`}</Text>
                              <Text class="min-w-0 flex-1 truncate text-xs font-medium text-ink">{found().title}</Text>
                            </>
                          )}
                        </If>
                      }
                    >
                      {(found) => (
                        <>
                          <View class="size-5 shrink-0 items-center justify-center rounded-xs bg-side">
                            <Icon name={noteTypeIcon(found().noteType)} size={12} tone="muted" />
                          </View>
                          <Text class="min-w-0 flex-1 truncate text-xs font-medium text-ink">{found().title}</Text>
                          <Text class="shrink-0 font-mono text-2xs text-faint">{noteTypeLabel(found().noteType)}</Text>
                        </>
                      )}
                    </If>
                  </View>
                );
              }}
            </Each>
          </If>
        </Scroll>
      </View>
    </If>
  );
}
