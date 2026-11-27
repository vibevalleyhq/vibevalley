import { computed, Text, View } from "nsh";

import type { Issue, IssueId, IssueStatus, Note, NoteId } from "@vibevalley/protocol";
import { issueId, noteId } from "@vibevalley/protocol/schema";

import { Icon } from "../../../design/Icon";
import { Dot, type DotTone } from "../../../design/Tag";
import { type InlineSegment, parseInlineLinkSegments, resolveIssueRef } from "./docOps";

const statusDotTone: Record<IssueStatus, DotTone> = {
  backlog: "faint",
  todo: "muted",
  in_progress: "water",
  in_review: "wheat",
  done: "leaf",
  canceled: "faint",
};

export type InlineDisplayItem =
  | { readonly kind: "text"; readonly value: string }
  | { readonly kind: "pill"; readonly segment: Exclude<InlineSegment, { readonly kind: "text" }>; readonly trailingPunct: string };

const TRAILING_PUNCT_RE = /^([，。、；：！？,.!?;:)\]）】」』》"”’]+)/u;

/** Attaches immediate trailing punctuation to link pills so punctuation never wraps to an orphan line. */
export function groupInlineDisplayRuns(segments: readonly InlineSegment[]): readonly InlineDisplayItem[] {
  const out: InlineDisplayItem[] = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg === undefined) continue;
    if (seg.kind === "text") {
      if (seg.value.length > 0) out.push({ kind: "text", value: seg.value });
      continue;
    }
    let trailingPunct = "";
    const next = segments[i + 1];
    if (next !== undefined && next.kind === "text") {
      const m = TRAILING_PUNCT_RE.exec(next.value);
      if (m?.[1] !== undefined && m[1].length > 0) {
        trailingPunct = m[1];
        const rest = next.value.slice(m[1].length);
        out.push({ kind: "pill", segment: seg, trailingPunct });
        if (rest.length > 0) out.push({ kind: "text", value: rest });
        i += 1;
        continue;
      }
    }
    out.push({ kind: "pill", segment: seg, trailingPunct: "" });
  }
  return out;
}

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
  const runs = computed(() => groupInlineDisplayRuns(parseInlineLinkSegments(props.text)));
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
        class="min-h-6 flex-row flex-wrap items-center gap-y-0.5"
      >
        <Each of={runs()} key={(_, idx) => String(idx)}>
          {(run) => (
            <If
              when={run().kind === "text"}
              else={
                <If when={run().kind === "pill" ? run() : undefined}>
                  {(pillRun) => {
                    const seg = () => {
                      const r = pillRun();
                      return r.kind === "pill" ? r.segment : undefined;
                    };
                    const punct = () => {
                      const r = pillRun();
                      return r.kind === "pill" ? r.trailingPunct : "";
                    };
                    return (
                      <View class="max-w-full flex-row items-center">
                        <If
                          when={seg()?.kind === "note"}
                          else={
                            <If when={seg()?.kind === "issue" || seg()?.kind === "issueNumber"}>
                              <View
                                role="button"
                                testID={(() => {
                                  const s = seg();
                                  if (!s) return undefined;
                                  if (s.kind === "issue") return `doc-inline-issue-${s.id}`;
                                  if (s.kind === "issueNumber") return `doc-inline-issue-${s.number}`;
                                  return undefined;
                                })()}
                                onPress={() => {
                                  const s = seg();
                                  if (!s) return;
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
                                    if (!s) return undefined;
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
                                    if (!s) return "";
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
                              return s?.kind === "note" ? `doc-inline-note-${s.id}` : undefined;
                            })()}
                            onPress={() => {
                              const s = seg();
                              if (s?.kind === "note") props.onOpenNote(noteId(s.id));
                            }}
                            class="flex-row items-center gap-1 rounded-sm border border-line bg-side px-1.5 py-px hover:border-faint hover:bg-hover"
                          >
                            <Icon name="notes" size={11} tone="accent" />
                            <Text class="text-xs font-medium text-ink">
                              {(() => {
                                const s = seg();
                                if (s?.kind !== "note") return "";
                                return notesById().get(noteId(s.id))?.title ?? s.label;
                              })()}
                            </Text>
                          </View>
                        </If>
                        <If when={punct().length > 0}>
                          <Text class={`leading-6 text-ink ${props.textClass ?? "text-sm"}`}>{punct()}</Text>
                        </If>
                      </View>
                    );
                  }}
                </If>
              }
            >
              <Text class={`leading-6 text-ink ${props.textClass ?? "text-sm"}`}>
                {(() => {
                  const r = run();
                  return r.kind === "text" ? r.value : "";
                })()}
              </Text>
            </If>
          )}
        </Each>
      </View>
    </If>
  );
}
