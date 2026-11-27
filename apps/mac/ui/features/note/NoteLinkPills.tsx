import { Text, View } from "nsh";

import type { Note as NoteDoc, NoteType } from "@vibevalley/protocol";

import { Icon } from "../../design/Icon";
import { Link as A } from "../../infra/router";
import { noteHref, noteTypeIcon } from "./NoteCard";

interface ResolvedNoteLink {
  readonly id: string;
  readonly label: string;
  readonly noteType?: NoteType | undefined;
}

const NOTE_WIKILINK_RE = /!?\[\[note:([^\]|\n]+?)(?:\|([^\]\n]*))?\]\]/gu;

function rewriteInlineNoteLinks(segment: string, notesById: ReadonlyMap<string, NoteDoc>, seen: Map<string, ResolvedNoteLink>): string {
  return segment.replace(NOTE_WIKILINK_RE, (_full, rawId: string, rawAlias?: string) => {
    const id = rawId.trim();
    if (!id) return _full;
    const target = notesById.get(id);
    const label = rawAlias?.trim() || target?.title || id;
    if (!seen.has(id)) {
      seen.set(id, { id, label, ...(target ? { noteType: target.noteType } : {}) });
    }
    return `[${label}](${noteHref(id)})`;
  });
}

/** Rewrites `[[note:<id>]]` wikilinks outside code blocks into `/notes/<id>` Markdown links and collects unique targets. */
export function resolveDescriptionNoteLinks(
  text: string,
  notes: readonly NoteDoc[],
): { readonly markdown: string; readonly links: readonly ResolvedNoteLink[] } {
  if (!text.includes("[[note:")) return { markdown: text, links: [] };
  const notesById = new Map(notes.map((n) => [n.id, n]));
  const seen = new Map<string, ResolvedNoteLink>();
  let inFence = false;
  const outLines = text.split("\n").map((line) => {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      inFence = !inFence;
      return line;
    }
    if (inFence || !line.includes("[[note:")) return line;
    return line
      .split(/(`[^`]*`)/gu)
      .map((part) => (part.startsWith("`") && part.endsWith("`") ? part : rewriteInlineNoteLinks(part, notesById, seen)))
      .join("");
  });
  return { markdown: outLines.join("\n"), links: [...seen.values()] };
}

/** Clickable Note pills rendered for `[[note:<id>]]` references in Markdown content. */
export function NoteLinkPills(props: { readonly links: readonly ResolvedNoteLink[] }) {
  return (
    <If when={props.links.length > 0}>
      <View testID="issue-note-links" class="mt-2 flex-row flex-wrap items-center gap-1.5">
        <Each of={props.links} key={(n) => n.id}>
          {(n) => (
            <A
              href={noteHref(n().id)}
              testID={`issue-note-link-${n().id}`}
              class="flex-row items-center gap-1.5 rounded-full border border-line bg-side px-2.5 py-0.5 hover:border-faint hover:bg-hover focus-visible:outline-2 focus-visible:outline-focus"
            >
              <Icon name={n().noteType ? noteTypeIcon[n().noteType!] : "notes"} size={12} tone="muted" />
              <Text class="max-w-56 truncate text-xs font-medium text-ink">{n().label}</Text>
            </A>
          )}
        </Each>
      </View>
    </If>
  );
}
