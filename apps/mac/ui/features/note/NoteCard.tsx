import { Text, View } from "nsh";

import { t } from "@vibevalley/i18n";
import { type Note, type NoteCard as NoteCardData, type NoteListRequest, type NoteType } from "@vibevalley/protocol";
import { noteId } from "@vibevalley/protocol/schema";

import { Icon } from "../../design/Icon";
import type { IconName } from "../../design/icons";
import { api } from "../../infra/api";
import { defineQuery, retryRead, useQuery } from "../../infra/query";
import { Link as A, useRouter } from "../../infra/router";
import { noteSuffixOf } from "./html";

const fresh = 5_000;

const noteQuery = defineQuery({
  key: (id: string) => ["notes", "one", id],
  fetch: (id, context) => api.note.get({ id: noteId(id) }, context),
});
const notesQuery = defineQuery({
  key: (q: NoteListRequest) => ["notes", "list", q.channel ?? null, q.issue ?? null, q.noteType ?? null, q.parentId ?? null],
  fetch: (q, context) => api.note.list(q, context),
  ...retryRead,
});
export const useNote = (id: () => string) => useQuery(() => noteQuery(id()), { interval: () => fresh });
export const useNotes = (q: () => NoteListRequest) => useQuery(() => notesQuery(q()), { interval: () => fresh });

/** Where a note is looked at; a version other than the latest is in the query string. */
export const noteHref = (id: string, version?: number) => `/notes/${id}${version != null && version !== 0 ? `?v=${version}` : ""}`;

export function noteTypeLabel(type: NoteType): string {
  switch (type) {
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

export const noteTypeIcon: Record<NoteType, IconName> = {
  doc: "notes",
  base: "catalog",
  canvas: "idea",
  media: "video",
};

export const kindLabel = (n: { readonly noteType: NoteType }): string => noteTypeLabel(n.noteType);

export const noteIcon = (n: { readonly noteType: NoteType }): IconName => noteTypeIcon[n.noteType];

const noteSuffix = (n: { readonly noteType: NoteType }): string => noteSuffixOf(n);

const cardLine = (card: NoteCardData) =>
  [kindLabel(card), ...(card.version > 0 ? [t("web.note.card.version", { version: card.version })] : []), ...(card.note ? [card.note] : [])].join(" · ");

function normalizeCard(input: NoteCardData | Note): NoteCardData {
  if ("note" in input) return input;
  return {
    id: input.id,
    title: input.title,
    noteType: input.noteType,
    version: input.version,
    note: input.versions.at(-1)?.note ?? "",
  };
}

/** The card a message or issue announces a note with: the whole card opens that note or version. */
export function NoteCard(props: { readonly card?: NoteCardData | undefined; readonly note?: NoteCardData | Note | undefined }) {
  const router = useRouter();
  const resolved = (): NoteCardData | undefined => {
    const raw = props.card ?? props.note;
    return raw ? normalizeCard(raw) : undefined;
  };
  // In a chat the card opens the note beside the talk; anywhere else it goes to the note's page.
  const href = () => {
    const c = resolved();
    if (!c) return "/notes";
    const [path = ""] = router.path().split("?");
    if (!path.startsWith("/chat")) return noteHref(c.id, c.version > 0 ? c.version : undefined);
    const params = new URLSearchParams(router.path().split("?")[1] ?? "");
    params.set("note", c.id);
    return `${path}?${params.toString()}`;
  };
  return (
    <If when={resolved()}>
      {(c) => (
        <A
          href={href()}
          testID="note-card"
          accessibilityLabel={t("web.note.card.open", { title: c().title })}
          class="group mt-1 w-full max-w-md flex-row items-center gap-3 rounded-lg border border-line bg-page px-3 py-2.5 hover:border-faint hover:bg-hover focus-visible:outline-2 focus-visible:outline-focus"
        >
          <View class="size-9 shrink-0 items-center justify-center rounded-md bg-side">
            <Icon name={noteIcon(c())} size={20} tone="muted" />
          </View>
          <View class="min-w-0 flex-1 gap-0.5">
            <View class="flex-row items-center gap-1.5">
              <Text class="min-w-0 flex-1 truncate text-sm font-semibold text-ink">{c().title}</Text>
              <View class="shrink-0 rounded-xs bg-hover px-1.5 py-px">
                <Text class="font-mono text-2xs text-muted">{noteSuffix(c())}</Text>
              </View>
            </View>
            <Text class="truncate text-xs text-muted tabular-nums">{cardLine(c())}</Text>
          </View>
          <Icon name="next" size={12} tone="faint" />
        </A>
      )}
    </If>
  );
}
