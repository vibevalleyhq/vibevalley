import { computed, Scroll, signal, Text, View } from "nsh";

import { t } from "@vibevalley/i18n";
import type { Agent, BaseCellValue, BaseColumn, BaseRow, Issue, IssueId, Note, NoteId } from "@vibevalley/protocol";

import { Button } from "../../../design/Button";
import { Icon } from "../../../design/Icon";
import { IconButton } from "../../../design/IconButton";
import { VdpAnchor } from "../../../infra/vdpProbe";
import { BaseCellControl } from "./BaseCell";
import { cleanWikilinkText, columnKindIcon, rowTitleOf } from "./baseModel";

export interface BaseRowDrawerProps {
  readonly row: BaseRow | undefined;
  readonly columns: readonly BaseColumn[];
  readonly notes: readonly Note[];
  readonly issues: readonly Issue[];
  readonly agents: readonly Agent[];
  readonly notesById: ReadonlyMap<string, Note>;
  readonly issuesById: ReadonlyMap<string, Issue>;
  readonly agentsById: ReadonlyMap<string, Agent>;
  readonly busy: boolean;
  readonly canCreatePage: boolean;
  readonly onClose: () => void;
  readonly onCommitCell: (row: BaseRow, colId: string, next: BaseCellValue) => void;
  readonly onRunAgentRow: (colId: string, rowId: string) => void;
  readonly onOpenNote: (id: NoteId) => void;
  readonly onOpenIssue: (id: IssueId) => void;
  readonly onCreatePageForRow?: ((row: BaseRow) => Promise<NoteId | undefined>) | undefined;
}

function docExcerptOf(page: Note): string | undefined {
  return page.preview?._tag === "doc" ? page.preview.excerpt : undefined;
}

/** Side-peek drawer for inspecting and editing a Base row along with its linked `Row = Page` doc note. */
export function BaseRowDrawer(props: BaseRowDrawerProps) {
  const creatingPage = signal(false);

  const title = computed(() => (props.row ? rowTitleOf(props.row, props.columns) : ""));
  const linkedNote = computed(() => {
    const pageId = props.row?.pageNoteId;
    return pageId ? props.notesById.get(pageId) : undefined;
  });

  const handleCreatePage = () => {
    const targetRow = props.row;
    const creator = props.onCreatePageForRow;
    if (!targetRow || !creator) return;
    creatingPage.set(true);
    void Promise.resolve(creator(targetRow)).finally(() => {
      creatingPage.set(false);
    });
  };

  return (
    <If when={props.row}>
      {(row) => (
        <>
          <VdpAnchor testId="base-row-drawer-title" role="heading" text={() => title()} />
          <View testID="base-row-drawer" accessibilityLabel={title()} class="w-96 shrink-0 border-l border-line bg-side">
            <View class="h-11 shrink-0 flex-row items-center justify-between gap-2 border-b border-line bg-page px-3.5">
              <View class="min-w-0 flex-1 flex-row items-center gap-2">
                <Icon name="notes" size={14} tone="accent" />
                <Text testID="base-row-drawer-title" class="min-w-0 flex-1 truncate text-sm font-semibold text-ink">
                  {title()}
                </Text>
              </View>
              <View class="shrink-0 flex-row items-center gap-1">
                <If when={row().pageNoteId}>
                  {(pageId) => (
                    <Button size="compact" tone="primary" icon="open" testID="base-row-open-page" onPress={() => props.onOpenNote(pageId())}>
                      {t("web.note.canvas.openPage")}
                    </Button>
                  )}
                </If>
                <IconButton icon="close" size={14} label={t("web.note.canvas.close")} testid="base-row-drawer-close" onClick={props.onClose} />
              </View>
            </View>

            <Scroll class="min-h-0 flex-1" contentClass="gap-4 p-4">
              <View testID="base-row-page-section" class="gap-2 rounded-lg border border-line bg-page p-3">
                <Text class="text-xs font-semibold text-muted">{t("web.note.types.doc")}</Text>

                <If
                  when={row().pageNoteId}
                  else={
                    <View class="flex-row items-center justify-between gap-2">
                      <Text class="min-w-0 flex-1 text-xs text-muted">{t("web.note.doc.empty")}</Text>
                      <If when={props.canCreatePage}>
                        <Button
                          size="compact"
                          tone="plain"
                          icon="add"
                          testID="base-row-create-page"
                          disabled={props.busy || creatingPage()}
                          onPress={handleCreatePage}
                        >
                          {t("web.note.issue.new")}
                        </Button>
                      </If>
                    </View>
                  }
                >
                  {() => (
                    <If when={linkedNote()} else={<Text class="text-xs text-muted">{title()}</Text>}>
                      {(page) => (
                        <View class="gap-1">
                          <Text class="text-sm font-medium text-ink">{page().title}</Text>
                          <If when={docExcerptOf(page())}>
                            {(excerpt) => {
                              const cleaned = () => cleanWikilinkText(excerpt(), props.notesById);
                              return <If when={cleaned()}>{(txt) => <Text class="line-clamp-3 text-xs leading-relaxed text-muted">{txt()}</Text>}</If>;
                            }}
                          </If>
                        </View>
                      )}
                    </If>
                  )}
                </If>
              </View>

              <View class="gap-2.5">
                <Text class="text-xs font-semibold text-muted">{t("web.issue.detail.properties")}</Text>
                <View class="gap-2 rounded-lg border border-line bg-page p-3">
                  <Each of={props.columns} key={(col) => col.id}>
                    {(col) => (
                      <View testID={`base-drawer-field-${col().id}`} class="flex-row items-start gap-2.5 border-b border-line pb-2 last:border-b-0 last:pb-0">
                        <View class="w-24 shrink-0 flex-row items-center gap-1.5 pt-1">
                          <Icon name={columnKindIcon(col().kind)} size={12} tone="muted" />
                          <Text class="min-w-0 flex-1 truncate text-xs font-medium text-muted">{col().name}</Text>
                        </View>
                        <View class="min-w-0 flex-1 overflow-hidden">
                          <BaseCellControl
                            rowId={row().id}
                            col={col()}
                            cell={row().cells[col().id]}
                            notesById={props.notesById}
                            issuesById={props.issuesById}
                            agentsById={props.agentsById}
                            notes={props.notes}
                            issues={props.issues}
                            agents={props.agents}
                            busy={props.busy}
                            onCommitCell={(colId, next) => props.onCommitCell(row(), colId, next)}
                            onRunAgentRow={props.onRunAgentRow}
                            onOpenNote={props.onOpenNote}
                            onOpenIssue={props.onOpenIssue}
                          />
                        </View>
                      </View>
                    )}
                  </Each>
                </View>
              </View>
            </Scroll>
          </View>
        </>
      )}
    </If>
  );
}
