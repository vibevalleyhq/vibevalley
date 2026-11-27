import { computed, Text, View } from "nsh";

import type { Issue, IssueId, IssueStatus, Note, NoteId } from "@vibevalley/protocol";
import { issueId, noteId } from "@vibevalley/protocol/schema";

import { Icon } from "../../../design/Icon";
import { Dot, type DotTone } from "../../../design/Tag";
import { parseInlineLinkSegments, resolveIssueRef } from "./docOps";

const statusDotTone: Record<IssueStatus, DotTone> = {
  backlog: "faint",
  todo: "muted",
  in_progress: "water",
  in_review: "wheat",
  done: "leaf",
  canceled: "faint",
};

export interface InlineRichTextProps {
  readonly text: string;
  readonly placeholder?: string | undefined;
  readonly textClass?: string | undefined;
  readonly notes: readonly Note[];
  readonly issues: readonly Issue[];
  readonly onOpenNote: (id: NoteId) => void;
  readonly onOpenIssue: (id: IssueId) => void;
  readonly onPressText?: (() => void) | undefined;
  readonly testID?: string | undefined;
}

export function InlineRichText(props: InlineRichTextProps) {
  const segments = computed(() => parseInlineLinkSegments(props.text));
  const notesById = computed(() => new Map(props.notes.map((n) => [n.id, n])));

  return (
    <If
      when={props.text.length > 0}
      else={
        <View role="button" testID={props.testID} onPress={() => props.onPressText?.()} class="min-h-6 justify-center">
          <Text class={`leading-6 text-faint ${props.textClass ?? "text-sm"}`}>{props.placeholder ?? ""}</Text>
        </View>
      }
    >
      <View
        role={props.onPressText ? "button" : undefined}
        testID={props.testID}
        onPress={() => props.onPressText?.()}
        class="min-h-6 flex-row flex-wrap items-center gap-x-1 gap-y-0.5"
      >
        <Each of={segments()} key={(_, idx) => String(idx)}>
          {(seg) => (
            <If
              when={seg().kind === "text"}
              else={
                <If
                  when={seg().kind === "note"}
                  else={
                    <If when={seg().kind === "issue" || seg().kind === "issueNumber"}>
                      <View
                        role="button"
                        testID={(() => {
                          const s = seg();
                          if (s.kind === "issue") return `doc-inline-issue-${s.id}`;
                          if (s.kind === "issueNumber") return `doc-inline-issue-${s.number}`;
                          return undefined;
                        })()}
                        onPress={() => {
                          const s = seg();
                          const raw = s.kind === "issue" ? s.id : s.kind === "issueNumber" ? String(s.number) : "";
                          const found = resolveIssueRef(props.issues, raw);
                          if (found) props.onOpenIssue(found.id);
                          else if (s.kind === "issue") props.onOpenIssue(issueId(s.id));
                        }}
                        class="flex-row items-center gap-1 rounded-sm border border-line bg-side px-1.5 py-px hover:border-faint hover:bg-hover"
                      >
                        <If
                          when={(() => {
                            const s = seg();
                            const raw = s.kind === "issue" ? s.id : s.kind === "issueNumber" ? String(s.number) : "";
                            return resolveIssueRef(props.issues, raw);
                          })()}
                          else={<Icon name="issues" size={11} tone="accent" />}
                        >
                          {(found) => <Dot tone={statusDotTone[found().status]} size={8} ring={false} />}
                        </If>
                        <Text class="text-xs font-medium text-ink">
                          {(() => {
                            const s = seg();
                            if (s.kind === "issueNumber") {
                              const found = resolveIssueRef(props.issues, String(s.number));
                              return found ? `#${found.number} ${found.title}` : `#${s.number}`;
                            }
                            if (s.kind === "issue") {
                              const found = resolveIssueRef(props.issues, s.id);
                              return found ? `#${found.number} ${found.title}` : s.label;
                            }
                            return "";
                          })()}
                        </Text>
                      </View>
                    </If>
                  }
                >
                  <View
                    role="button"
                    testID={(() => {
                      const s = seg();
                      return s.kind === "note" ? `doc-inline-note-${s.id}` : undefined;
                    })()}
                    onPress={() => {
                      const s = seg();
                      if (s.kind === "note") props.onOpenNote(noteId(s.id));
                    }}
                    class="flex-row items-center gap-1 rounded-sm border border-line bg-side px-1.5 py-px hover:border-faint hover:bg-hover"
                  >
                    <Icon name="notes" size={11} tone="accent" />
                    <Text class="text-xs font-medium text-ink">
                      {(() => {
                        const s = seg();
                        if (s.kind !== "note") return "";
                        return notesById().get(noteId(s.id))?.title ?? s.label;
                      })()}
                    </Text>
                  </View>
                </If>
              }
            >
              <Text class={`leading-6 text-ink ${props.textClass ?? "text-sm"}`}>
                {(() => {
                  const s = seg();
                  return s.kind === "text" ? s.value : "";
                })()}
              </Text>
            </If>
          )}
        </Each>
      </View>
    </If>
  );
}
