import { computed, signal, Text, View, type JSX } from "nsh";

import { t } from "@vibevalley/i18n";
import { type IssueId, type Note, NOTE_TYPES, type NoteLink, type NoteType } from "@vibevalley/protocol";
import { issueId as toIssueId, noteId } from "@vibevalley/protocol/schema";

import { createAct } from "../../design/act";
import { Button } from "../../design/Button";
import { Dialog } from "../../design/Dialog";
import { Field, Select, TextInput } from "../../design/Field";
import { Icon } from "../../design/Icon";
import { IconButton } from "../../design/IconButton";
import { toast } from "../../design/toasts";
import { api } from "../../infra/api";
import { defineQuery, ready, useQuery, useQueryClient } from "../../infra/query";
import { Link as A } from "../../infra/router";
import { noteSuffixOf } from "./html";
import { noteHref, noteIcon, noteTypeIcon, noteTypeLabel, useNotes } from "./NoteCard";

const issueLinksQuery = defineQuery({
  key: (id: string) => ["note-links", "issue", id],
  fetch: (id: string, context) => api.note.link.list({ entityKind: "issue", entityId: id }, context),
});

export interface IssueNotesProps {
  readonly issue?: IssueId | undefined;
  readonly issueId?: IssueId | undefined;
  readonly heading?: JSX.Element | undefined;
  readonly repo?: string | undefined;
  readonly channel?: string | undefined;
  readonly notes?: readonly Note[] | undefined;
}

/** Linked notes for an issue with searchable link picker, new linked note creation, unlink controls, and backlinks. */
export function IssueNotes(props: IssueNotesProps) {
  const queries = useQueryClient();
  const targetIssueId = (): IssueId => props.issue ?? props.issueId ?? toIssueId("");
  const linked = useNotes(() => ({ issue: targetIssueId() }));
  const workspace = useNotes(() => ({}));
  const links = useQuery(() => issueLinksQuery(targetIssueId()), { interval: () => 10_000 });
  const act = createAct();
  const newOpen = signal(false);
  const newTitle = signal("");
  const newType = signal<NoteType>("doc");

  const linkedList = computed((): readonly Note[] => {
    const base = ready(linked, undefined) ?? [];
    const extra = props.notes ?? [];
    if (extra.length === 0) return base;
    const seen = new Set(base.map((n) => n.id));
    const merged = [...base];
    for (const n of extra) {
      if (!seen.has(n.id) && n.issue === targetIssueId()) {
        seen.add(n.id);
        merged.push(n);
      }
    }
    return merged;
  });

  const backlinkNotes = computed((): readonly NoteLink[] => {
    const res = ready(links, undefined);
    if (!res) return [];
    const directIds = new Set(linkedList().map((n) => String(n.id)));
    return res.backlinks.filter((l) => l.sourceKind === "note" && !directIds.has(l.sourceId));
  });

  const unlinkedOptions = computed(() =>
    (ready(workspace, undefined) ?? [])
      .filter((n) => n.issue !== targetIssueId())
      .map((n) => ({
        value: n.id,
        label: `${n.title} · ${noteTypeLabel(n.noteType)}`,
      })),
  );
  const typeOptions = computed(() =>
    NOTE_TYPES.map((type) => ({
      value: type,
      label: noteTypeLabel(type),
    })),
  );

  const linkNote = (id: string) => {
    if (!id || act.busy()) return;
    void act.run(async () => {
      const updated = await api.note.update({ id: noteId(id), issue: targetIssueId() });
      await queries.invalidate({ prefix: ["notes"] });
      toast(t("web.note.issue.linkedToast", { title: updated.title }));
    });
  };

  const unlinkNote = (id: string, title: string) => {
    if (act.busy()) return;
    void act.run(async () => {
      await api.note.update({ id: noteId(id), issue: "" });
      await queries.invalidate({ prefix: ["notes"] });
      toast(t("web.note.issue.unlinkedToast", { title }));
    });
  };

  const openNew = () => {
    newTitle.set("");
    newType.set("doc");
    newOpen.set(true);
  };

  const createLinked = () => {
    const title = newTitle().trim();
    if (!title || act.busy()) return;
    const type = newType();
    const issue = targetIssueId();
    const channel = props.channel;
    void act.run(async () => {
      const made = await api.note.create({
        title,
        noteType: type,
        issue,
        ...(channel ? { channel } : {}),
      });
      await queries.invalidate({ prefix: ["notes"] });
      newOpen.set(false);
      toast(t("web.note.issue.linkedToast", { title: made.title }));
    });
  };

  return (
    <View accessibilityLabel={t("web.note.issue.title")} testID="issue-notes" class="gap-2">
      <If
        when={props.heading}
        else={
          <View class="mt-7 border-t border-line pt-5">
            <Text class="text-xs font-semibold text-muted">{t("web.note.issue.title")}</Text>
          </View>
        }
      >
        {(h) => h()}
      </If>
      <If
        when={linkedList().length > 0}
        else={
          <Text testID="issue-notes-empty" class="text-xs text-faint">
            {t("web.note.issue.empty")}
          </Text>
        }
      >
        <View class="gap-1.5">
          <Each of={linkedList()} key={(n) => n.id}>
            {(n) => (
              <View
                testID={`issue-note-row-${n().id}`}
                class="w-full max-w-md flex-row items-center gap-2 rounded-lg border border-line bg-page px-3 py-2 hover:border-faint"
              >
                <A
                  href={noteHref(n().id, n().version > 0 ? n().version : undefined)}
                  class="min-w-0 flex-1 flex-row items-center gap-2.5 rounded-sm focus-visible:outline-2 focus-visible:outline-focus"
                >
                  <View class="size-8 shrink-0 items-center justify-center rounded-md bg-side">
                    <Icon name={noteIcon(n())} size={16} tone="muted" />
                  </View>
                  <View class="min-w-0 flex-1 gap-0.5">
                    <View class="flex-row items-center gap-1.5">
                      <Text class="min-w-0 flex-1 truncate text-sm font-medium text-ink">{n().title}</Text>
                      <View class="shrink-0 rounded-xs bg-side px-1.5 py-px">
                        <Text class="text-2xs font-medium text-muted">{noteTypeLabel(n().noteType)}</Text>
                      </View>
                    </View>
                    <Text class="truncate font-mono text-2xs text-faint tabular-nums">
                      {[noteSuffixOf(n()), ...(n().version > 0 ? [t("web.note.card.version", { version: n().version })] : [])].join(" · ")}
                    </Text>
                  </View>
                </A>
                <IconButton
                  icon="close"
                  size={12}
                  label={t("web.note.issue.unlink", { title: n().title })}
                  testid={`issue-note-unlink-${n().id}`}
                  disabled={act.busy()}
                  onClick={() => unlinkNote(n().id, n().title)}
                />
              </View>
            )}
          </Each>
        </View>
      </If>
      <If when={backlinkNotes().length > 0}>
        <View testID="issue-note-backlinks" class="gap-1 pt-1">
          <Text class="text-2xs font-medium text-faint">{t("web.note.links.backlinks", { n: backlinkNotes().length })}</Text>
          <View class="flex-row flex-wrap gap-1.5">
            <Each of={backlinkNotes()} key={(l) => l.id}>
              {(link) => (
                <A
                  href={noteHref(link().sourceId)}
                  testID={`issue-note-backlink-${link().sourceId}`}
                  class="flex-row items-center gap-1 rounded-md border border-line bg-side px-2 py-1 hover:bg-hover"
                >
                  <Icon name={link().noteType ? noteTypeIcon[link().noteType!] : "notes"} size={12} tone="muted" />
                  <Text class="max-w-44 truncate text-xs text-ink">{link().title ?? link().sourceId}</Text>
                </A>
              )}
            </Each>
          </View>
        </View>
      </If>
      <View class="flex-row flex-wrap items-center gap-2 pt-0.5">
        <Select
          quiet
          size="control"
          searchable
          class="min-w-48 max-w-xs flex-1"
          label={t("web.note.issue.linkExisting")}
          testid="issue-note-link-picker"
          value=""
          placeholder={t("web.note.issue.linkExisting")}
          searchPlaceholder={t("web.note.issue.linkPlaceholder")}
          emptyText={t("web.note.issue.linkEmpty")}
          disabled={act.busy()}
          options={unlinkedOptions()}
          onChange={linkNote}
        />
        <Button size="compact" tone="quiet" icon="add" testID="issue-note-new" disabled={act.busy()} onPress={openNew}>
          {t("web.note.issue.new")}
        </Button>
      </View>
      <Dialog
        open={newOpen()}
        onClose={() => newOpen.set(false)}
        title={t("web.note.issue.newDialogTitle")}
        size="sm"
        height="auto"
        testid="issue-note-new-dialog"
      >
        <View class="gap-3.5 px-5 py-4">
          <Field label={t("web.note.issue.newTitle")}>
            <TextInput
              testID="issue-note-new-title"
              value={newTitle()}
              placeholder={t("web.note.issue.newTitlePlaceholder")}
              onInput={(v) => newTitle.set(v)}
              onSubmit={createLinked}
              autoFocus
            />
          </Field>
          <Field label={t("web.note.issue.newType")}>
            <Select
              label={t("web.note.issue.newType")}
              testid="issue-note-new-type"
              value={newType()}
              options={typeOptions()}
              onChange={(v) => newType.set(v)}
            />
          </Field>
          <View class="flex-row items-center justify-end gap-2 border-t border-line pt-3">
            <Button tone="quiet" testID="issue-note-new-cancel" onPress={() => newOpen.set(false)}>
              {t("web.base.form.never")}
            </Button>
            <Button tone="primary" testID="issue-note-new-submit" disabled={act.busy() || newTitle().trim() === ""} onPress={createLinked}>
              {t("web.note.issue.newCreate")}
            </Button>
          </View>
        </View>
      </Dialog>
    </View>
  );
}
