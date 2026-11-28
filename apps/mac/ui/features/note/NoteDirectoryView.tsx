import { computed, effect, keymap, Scroll, signal, Text, untracked, View, WebView } from "nsh";

import { t } from "@vibevalley/i18n";
import { type NoteFileContent, type NoteFileMeta, type NoteId } from "@vibevalley/protocol";
import { noteId as toNoteId } from "@vibevalley/protocol/schema";

import { Button } from "../../design/Button";
import { TextArea, TextInput } from "../../design/Field";
import { Icon } from "../../design/Icon";
import { IconButton } from "../../design/IconButton";
import { Banner } from "../../design/layout";
import { Segmented } from "../../design/Segmented";
import { toast } from "../../design/toasts";
import { createAct } from "../../infra/act";
import { useQueryClient } from "../../infra/query";
import { buildSandboxedHtml, useNoteDirectory } from "./views/noteFiles";

interface NoteDirectoryViewProps {
  readonly noteId: NoteId;
  readonly version?: number | undefined;
  readonly onOpenNote?: ((id: NoteId) => void) | undefined;
  readonly onChanged?: (() => void) | undefined;
}

const NOTE_LINK_RE = /\[\[note:([a-zA-Z0-9_-]+)(?:\|([^\]]+))?\]\]/gu;

function extractNoteRefs(raw: string): { readonly id: NoteId; readonly label: string }[] {
  const out: { id: NoteId; label: string }[] = [];
  const seen = new Set<string>();
  NOTE_LINK_RE.lastIndex = 0;
  for (const m of raw.matchAll(NOTE_LINK_RE)) {
    const id = m[1];
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id: toNoteId(id), label: m[2]?.trim() || id });
  }
  return out;
}

/** Directory file browser and editor over `note.file.*` for the Note page's Files tab. */
export function NoteDirectoryView(props: NoteDirectoryViewProps) {
  const queries = useQueryClient();
  const { client, snapshot } = useNoteDirectory(
    () => props.noteId,
    () => props.version,
  );
  const act = createAct();

  const selectedPath = signal<string>("manifest.json");
  const draftContent = signal("");
  const lastLoadedHash = signal<string | undefined>(undefined);
  const newFilePath = signal("");
  const addingFile = signal(false);
  const deletingPath = signal<string | undefined>(undefined);
  const fileHtmlMode = signal<"preview" | "code">("preview");

  const sortedFiles = computed((): readonly NoteFileMeta[] => [...snapshot().files.values()].toSorted((a, b) => a.path.localeCompare(b.path)));

  const activePath = computed(() => {
    const chosen = selectedPath();
    const files = snapshot().files;
    if (files.has(chosen)) return chosen;
    const structureFirst = sortedFiles().find((f) => f.path.startsWith("structure/"))?.path;
    return structureFirst ?? sortedFiles()[0]?.path ?? "manifest.json";
  });

  const activeFile = computed((): NoteFileContent | undefined => snapshot().contents.get(activePath()));
  const dirty = computed(() => {
    const file = activeFile();
    return file !== undefined && draftContent() !== file.content;
  });

  effect(() => {
    const file = activeFile();
    const key = file ? `${file.path}:${file.hash}` : undefined;
    if (key !== untracked(lastLoadedHash)) {
      lastLoadedHash.set(key);
      draftContent.set(file?.content ?? "");
    }
  });

  const selectFile = (path: string) => {
    const changed = path !== selectedPath();
    selectedPath.set(path);
    deletingPath.set(undefined);
    if (changed) {
      fileHtmlMode.set(/\.(?:html|htm)$/iu.test(path) ? "preview" : "code");
    }
    if (!snapshot().contents.has(path)) {
      void client().readFile(path);
    }
  };

  const saveActiveFile = () => {
    const path = activePath();
    const content = draftContent();
    const expectedHash = activeFile()?.hash;
    void act.run(async () => {
      const res = await client().writeFiles([{ path, content, ...(expectedHash !== undefined ? { expectedHash } : {}) }], { summary: `Edit ${path}` });
      lastLoadedHash.set(`${path}:${res.files.find((f) => f.path === path)?.hash ?? ""}`);
      if (res.suggestions && res.suggestions.length > 0) {
        toast(t("web.note.suggestions.title", { n: res.suggestions.length }));
      } else {
        toast(t("web.note.blocks.saved"));
      }
      props.onChanged?.();
      void queries.invalidate({ prefix: ["notes"] });
    });
  };

  const canSaveShortcut = computed(() => props.version === undefined && dirty() && !act.busy());
  effect(() => {
    if (!canSaveShortcut()) return;
    return keymap.bind("mod+s", () => saveActiveFile(), { when: "always" });
  });

  const createNewFile = () => {
    const raw = newFilePath().trim();
    if (!raw) return;
    const normalized = raw.startsWith("structure/") || raw.startsWith("asset/") ? raw : `structure/${raw}`;
    const initial = normalized.endsWith(".json") ? "{}\n" : "";
    void act.run(async () => {
      await client().writeFiles([{ path: normalized, content: initial }], { summary: `Create ${normalized}` });
      newFilePath.set("");
      addingFile.set(false);
      selectedPath.set(normalized);
      props.onChanged?.();
      void queries.invalidate({ prefix: ["notes"] });
    });
  };

  const deleteSelectedFile = (path: string) => {
    if (path === "manifest.json") return;
    deletingPath.set(undefined);
    void act.run(async () => {
      await client().deleteFile(path, { summary: `Delete ${path}` });
      if (selectedPath() === path) selectedPath.set("manifest.json");
      props.onChanged?.();
      void queries.invalidate({ prefix: ["notes"] });
    });
  };

  const rawFilesMap = computed(() => {
    const map = new Map<string, string>();
    for (const [path, file] of snapshot().contents) {
      map.set(path, file.content);
    }
    return map;
  });

  const isHtmlFile = computed(() => /\.(?:html|htm)$/iu.test(activePath()));
  const activeFileHtmlPreview = computed(() => {
    const map = new Map(rawFilesMap());
    const current = activePath();
    map.set(current, draftContent());
    return buildSandboxedHtml(map, current);
  });

  const referencedNotes = computed(() => extractNoteRefs(draftContent()));

  return (
    <View testID="note-directory-view" class="min-h-0 min-w-0 flex-1 bg-page">
      <If when={snapshot().error}>{(err) => <Banner edge>{err()}</Banner>}</If>

      <View class="min-h-0 min-w-0 flex-1 flex-row">
        <View class="w-60 shrink-0 border-r border-line bg-side">
          <View class="flex-row items-center justify-between border-b border-line px-2.5 py-1.5">
            <Text class="text-xs font-semibold text-muted">{t("web.note.page.directory")}</Text>
            <If when={props.version === undefined}>
              <IconButton icon="add" size={12} label={t("web.note.page.new")} testid="note-file-add-toggle" onClick={() => addingFile.set(!addingFile())} />
            </If>
          </View>
          <If when={addingFile()}>
            <View class="gap-1.5 border-b border-line p-2">
              <TextInput
                testID="note-file-new-path"
                value={newFilePath()}
                onInput={(v) => newFilePath.set(v)}
                onSubmit={createNewFile}
                placeholder="structure/notes.md"
                accessibilityLabel={t("web.note.page.newFileLabel")}
              />
              <Button size="compact" tone="primary" testID="note-file-new-submit" disabled={act.busy()} onPress={createNewFile}>
                {t("web.note.page.new")}
              </Button>
            </View>
          </If>
          <Scroll class="min-h-0 flex-1" contentClass="gap-0.5 p-1.5">
            <Each of={sortedFiles()} key={(f) => f.path}>
              {(f) => {
                const selected = () => activePath() === f().path;
                const deletable = () => props.version === undefined && f().path !== "manifest.json";
                return (
                  <View
                    role="button"
                    testID={`note-file-row-${f().path}`}
                    accessibilityState={{ selected: selected() }}
                    onPress={() => selectFile(f().path)}
                    class={`group relative flex-row items-center gap-1.5 rounded-md border px-2 py-1.5 pr-7 ${
                      selected() ? "border-accent bg-selected" : "border-transparent hover:bg-hover"
                    }`}
                  >
                    <Icon name="file" size={12} tone={selected() ? "ink" : "muted"} />
                    <Text class={`min-w-0 flex-1 truncate font-mono text-2xs font-medium ${selected() ? "text-ink" : "text-muted"}`}>{f().path}</Text>
                    <If when={deletable()}>
                      <View class="absolute top-1 right-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100">
                        <IconButton
                          icon="delete"
                          size={12}
                          label={t("web.note.page.delete")}
                          testid={`note-file-delete-${f().path}`}
                          onClick={() => deletingPath.set(f().path)}
                        />
                      </View>
                    </If>
                  </View>
                );
              }}
            </Each>
          </Scroll>
        </View>

        <View class="min-h-0 min-w-0 flex-1 p-3">
          <If when={deletingPath()}>
            {(target) => (
              <View testID="note-file-delete-confirm" class="mb-2 flex-row flex-wrap items-center gap-2 rounded-md border border-line bg-bad-soft px-3 py-2">
                <Text class="min-w-0 flex-1 text-xs text-berry">{t("web.note.page.deleteFileAsk", { path: target() })}</Text>
                <Button size="compact" tone="danger" testID="note-file-delete-sure" disabled={act.busy()} onPress={() => deleteSelectedFile(target())}>
                  {t("web.note.page.delete")}
                </Button>
                <Button size="compact" tone="quiet" onPress={() => deletingPath.set(undefined)}>
                  {t("web.base.form.never")}
                </Button>
              </View>
            )}
          </If>

          <View class="mb-2 flex-row items-center justify-between gap-2">
            <View class="min-w-0 flex-1 flex-row items-center gap-2">
              <Text testID="note-file-active-path" class="truncate font-mono text-xs font-semibold text-ink">
                {activePath()}
              </Text>
              <If when={activeFile()}>{(file) => <Text class="shrink-0 font-mono text-2xs text-faint tabular-nums">{`${file().size} B`}</Text>}</If>
              <If when={dirty() && props.version === undefined}>
                <View class="flex-row items-center gap-1 rounded-sm bg-warn-soft px-1.5 py-0.5">
                  <View class="size-1.5 rounded-full bg-wheat" />
                  <Text class="text-2xs font-medium text-warn-ink">{t("web.note.page.unsaved")}</Text>
                </View>
              </If>
            </View>
            <View class="shrink-0 flex-row items-center gap-1.5">
              <If when={isHtmlFile()}>
                <Segmented
                  testid="note-file-html-mode"
                  label={t("web.note.page.viewMode")}
                  value={fileHtmlMode()}
                  onChange={(v) => fileHtmlMode.set(v)}
                  options={[
                    { value: "preview" as const, label: t("web.note.files.htmlPreviewMode") },
                    { value: "code" as const, label: t("web.note.files.codeMode") },
                  ]}
                />
              </If>
              <If when={props.version === undefined}>
                <View class="shrink-0 flex-row items-center gap-1.5">
                  <If when={dirty()}>
                    <Button
                      size="compact"
                      tone="quiet"
                      testID="note-file-revert"
                      disabled={act.busy()}
                      onPress={() => draftContent.set(activeFile()?.content ?? "")}
                    >
                      {t("web.note.page.discard")}
                    </Button>
                  </If>
                  <Button size="compact" tone="primary" testID="note-file-save" disabled={act.busy() || !dirty()} onPress={saveActiveFile}>
                    {t("web.note.whiteboard.save")}
                  </Button>
                </View>
              </If>
            </View>
          </View>

          <If when={props.onOpenNote !== undefined && referencedNotes().length > 0}>
            <View class="mb-2 flex-row flex-wrap items-center gap-1.5">
              <Each of={referencedNotes()} key={(ref) => ref.id}>
                {(ref) => (
                  <Button size="compact" tone="plain" icon="notes" onPress={() => props.onOpenNote?.(ref().id)}>
                    {ref().label}
                  </Button>
                )}
              </Each>
            </View>
          </If>

          <If
            when={isHtmlFile() && fileHtmlMode() === "preview"}
            else={
              <TextArea
                testID="note-file-editor"
                accessibilityLabel={activePath()}
                rows={20}
                value={draftContent()}
                onInput={(v) => draftContent.set(v)}
                class="min-h-0 flex-1 font-mono text-xs"
              />
            }
          >
            <WebView
              testID="note-file-html-preview"
              accessibilityLabel={activePath()}
              html={activeFileHtmlPreview()}
              incognito
              class="min-h-0 w-full flex-1 rounded-md border border-line bg-page"
            />
          </If>
        </View>
      </View>
    </View>
  );
}
