import { computed, Scroll, signal, Text, untracked, View } from "nsh";
import { Menu, MenuItem, MenuSeparator, Submenu } from "nsh/base";

import { t } from "@vibevalley/i18n";
import { type Note, NOTE_TYPES, type NoteId, type NoteType } from "@vibevalley/protocol";

import { createAct } from "../../design/act";
import { SearchField } from "../../design/Field";
import { Icon } from "../../design/Icon";
import { ActiveBar } from "../../design/layout";
import { motionClass, popupTransition } from "../../design/motion";
import { toast } from "../../design/toasts";
import { api, reasonOf } from "../../infra/api";
import { spelled } from "../../infra/base/search";
import { useQueryClient } from "../../infra/query";
import { noteIcon, noteTypeIcon, noteTypeLabel } from "./NoteCard";

export interface PageTreeProps {
  readonly notes: readonly Note[];
  readonly activeId?: NoteId | undefined;
  readonly noteTypeFilter?: NoteType | undefined;
  readonly embedded?: boolean | undefined;
  readonly onSelect: (id: NoteId) => void;
  readonly onCreated?: ((note: Note) => void) | undefined;
  readonly onMoved?: ((note: Note) => void) | undefined;
  readonly class?: string | undefined;
}

interface TreeRow {
  readonly note: Note;
  readonly depth: number;
  readonly hasChildren: boolean;
  readonly expanded: boolean;
  readonly siblingIndex: number;
  readonly siblingCount: number;
}

const menuPopupClass = `min-w-44 gap-0.5 rounded-lg border border-line bg-elevated p-1 shadow-float ${motionClass("transition-opacity duration-120 ease-out")}`;
const menuSeparatorClass = "my-1 h-px bg-line";

function sortNotes(list: readonly Note[]): Note[] {
  return [...list].toSorted((a, b) =>
    a.sortOrder !== b.sortOrder ? a.sortOrder - b.sortOrder : b.updated !== a.updated ? b.updated - a.updated : a.id.localeCompare(b.id),
  );
}

function isDescendant(byId: ReadonlyMap<string, Note>, candidateId: string, ancestorId: string): boolean {
  let cur: string | undefined = candidateId;
  const visited = new Set<string>();
  while (cur !== undefined) {
    if (cur === ancestorId) return true;
    if (visited.has(cur)) break;
    visited.add(cur);
    cur = byId.get(cur)?.parentId;
  }
  return false;
}

/** Collapsible hierarchical PageTree with search, 3+1 root/subpage creation, and cycle-safe `note.tree.move`. */
export function PageTree(props: PageTreeProps) {
  const queries = useQueryClient();
  const act = createAct((msg) => toast(msg, "bad"));
  const search = signal("");
  const collapsed = signal<ReadonlySet<string>>(new Set());
  const addMenuOpen = signal(false);

  const byId = computed(() => new Map(props.notes.map((n) => [String(n.id), n])));

  const childrenMap = computed(() => {
    const known = byId();
    const map = new Map<string, Note[]>();
    const roots: Note[] = [];
    for (const n of props.notes) {
      const pid = n.parentId !== undefined && known.has(n.parentId) && n.parentId !== n.id ? n.parentId : undefined;
      if (pid === undefined) {
        roots.push(n);
      } else {
        const list = map.get(pid);
        if (list) list.push(n);
        else map.set(pid, [n]);
      }
    }
    const sorted = new Map<string, readonly Note[]>();
    sorted.set("", sortNotes(roots));
    for (const [k, list] of map) sorted.set(k, sortNotes(list));
    return sorted;
  });

  const matchingIds = computed((): ReadonlySet<string> | undefined => {
    const q = search().trim().toLowerCase();
    const typeFilter = props.noteTypeFilter;
    if (!q && typeFilter === undefined) return undefined;
    const known = byId();
    const keep = new Set<string>();
    for (const n of props.notes) {
      if (typeFilter !== undefined && n.noteType !== typeFilter) continue;
      if (q && !spelled(n.title, q) && !spelled(noteTypeLabel(n.noteType), q) && !n.noteType.toLowerCase().includes(q)) continue;
      let cur: Note | undefined = n;
      const seen = new Set<string>();
      while (cur !== undefined) {
        if (seen.has(cur.id)) break;
        seen.add(cur.id);
        keep.add(cur.id);
        cur = cur.parentId !== undefined ? known.get(cur.parentId) : undefined;
      }
    }
    return keep;
  });

  const rows = computed((): readonly TreeRow[] => {
    const cmap = childrenMap();
    const filterSet = matchingIds();
    const hidden = collapsed();
    const out: TreeRow[] = [];
    const visited = new Set<string>();

    const walk = (parentKey: string, depth: number) => {
      const list = (cmap.get(parentKey) ?? []).filter((n) => filterSet === undefined || filterSet.has(n.id));
      for (let i = 0; i < list.length; i++) {
        const n = list[i];
        if (n === undefined || visited.has(n.id)) continue;
        visited.add(n.id);
        const kids = (cmap.get(n.id) ?? []).filter((k) => filterSet === undefined || filterSet.has(k.id));
        const hasChildren = kids.length > 0;
        const expanded = filterSet !== undefined ? true : !hidden.has(n.id);
        out.push({
          note: n,
          depth,
          hasChildren,
          expanded,
          siblingIndex: i,
          siblingCount: list.length,
        });
        if (hasChildren && expanded) {
          walk(n.id, depth + 1);
        }
      }
    };

    walk("", 0);
    return out;
  });

  const toggleExpand = (id: string) => {
    const next = new Set(untracked(collapsed));
    if (next.has(id)) next.delete(id);
    else next.add(id);
    collapsed.set(next);
  };

  const createPage = (noteType: NoteType, parentId?: NoteId) => {
    if (act.busy()) return;
    const siblings = childrenMap().get(parentId ?? "") ?? [];
    const sortOrder = siblings.length > 0 ? Math.max(...siblings.map((s) => s.sortOrder)) + 1 : 0;
    const title = noteTypeLabel(noteType);
    void act.run(async () => {
      const created = await api.note.create({
        title,
        noteType,
        sortOrder,
        ...(parentId !== undefined ? { parentId } : {}),
      });
      if (parentId !== undefined) {
        const nextCollapsed = new Set(untracked(collapsed));
        nextCollapsed.delete(parentId);
        collapsed.set(nextCollapsed);
      }
      await queries.invalidate({ prefix: ["notes"] });
      props.onCreated?.(created);
      props.onSelect(created.id);
    });
  };

  const moveNote = (id: NoteId, targetParentId: NoteId | undefined, sortOrder: number) => {
    if (act.busy()) return;
    void act.run(async () => {
      try {
        const moved = await api.note.tree.move({
          id,
          sortOrder,
          ...(targetParentId !== undefined ? { parentId: targetParentId } : {}),
        });
        if (targetParentId !== undefined) {
          const nextCollapsed = new Set(untracked(collapsed));
          nextCollapsed.delete(targetParentId);
          collapsed.set(nextCollapsed);
        }
        await queries.invalidate({ prefix: ["notes"] });
        props.onMoved?.(moved);
      } catch (e) {
        toast(reasonOf(e), "bad");
      }
    });
  };

  const reorderSibling = (row: TreeRow, delta: -1 | 1) => {
    const pid = row.note.parentId !== undefined && byId().has(row.note.parentId) ? row.note.parentId : undefined;
    const siblings = childrenMap().get(pid ?? "") ?? [];
    const targetIdx = row.siblingIndex + delta;
    const neighbor = siblings[targetIdx];
    if (neighbor === undefined) return;
    const nextOrder = delta < 0 ? Math.min(row.note.sortOrder - 1, neighbor.sortOrder) : Math.max(row.note.sortOrder + 1, neighbor.sortOrder);
    moveNote(row.note.id, pid, nextOrder);
  };

  const embedded = () => props.embedded === true;

  const treeBody = (
    <View class={embedded() ? "gap-1" : "min-h-0 flex-1"}>
      <View
        class={
          embedded()
            ? "h-7 shrink-0 flex-row items-center justify-between gap-1.5 px-2"
            : "h-10 shrink-0 flex-row items-center justify-between gap-1.5 border-b border-line px-2.5"
        }
      >
        <Text class="min-w-0 flex-1 truncate text-xs font-semibold text-muted">{t("web.note.tree.title")}</Text>
        <Menu
          open={addMenuOpen()}
          onOpenChange={(e) => addMenuOpen.set(e.open)}
          placement="bottom"
          align="end"
          offset={4}
          popupClass={menuPopupClass}
          popupStartingClass={popupTransition("opacity-0")}
          popupEndingClass={popupTransition("opacity-0")}
          trigger={
            <View
              role="button"
              testID="page-tree-add-root"
              accessibilityLabel={t("web.note.tree.newRoot")}
              class="size-6 shrink-0 items-center justify-center rounded-md hover:bg-hover aria-expanded:bg-selected focus-visible:outline-2 focus-visible:outline-focus"
            >
              <Icon name="add" size={14} tone="muted" />
            </View>
          }
        >
          <Each of={NOTE_TYPES} key={(nt) => nt}>
            {(nt) => (
              <MenuItem
                testID={`page-tree-add-root-${nt()}`}
                onSelect={() => createPage(nt())}
                class="h-7 flex-row items-center gap-2 rounded-md px-2 hover:bg-hover focus:bg-hover"
              >
                <Icon name={noteTypeIcon[nt()]} size={13} tone="muted" />
                <Text class="min-w-0 flex-1 truncate text-xs text-ink">{noteTypeLabel(nt())}</Text>
              </MenuItem>
            )}
          </Each>
        </Menu>
      </View>

      <View class={embedded() ? "shrink-0 px-0.5 pt-0.5 pb-1" : "shrink-0 px-2 pt-2 pb-1"}>
        <SearchField
          testid="page-tree-search"
          value={search()}
          onInput={(v) => search.set(v)}
          placeholder={t("web.note.issue.linkPlaceholder")}
          label={t("web.note.issue.linkPlaceholder")}
          class="w-full"
        />
      </View>

      <If
        when={props.embedded}
        else={
          <Scroll class="min-h-0 flex-1" contentClass="gap-0.5 p-1.5 pb-4">
            <If
              when={rows().length > 0}
              else={
                <Text testID="page-tree-empty" class="px-2 py-4 text-center text-xs text-faint">
                  {t("web.note.tree.empty")}
                </Text>
              }
            >
              <Each of={rows()} key={(r) => r.note.id}>
                {(row) => (
                  <PageTreeRow
                    row={row()}
                    active={row().note.id === props.activeId}
                    allNotes={props.notes}
                    byId={byId()}
                    busy={act.busy()}
                    onSelect={props.onSelect}
                    onToggleExpand={toggleExpand}
                    onCreateChild={(parentId, nt) => createPage(nt, parentId)}
                    onMoveToRoot={(id) => moveNote(id, undefined, 0)}
                    onMoveUnder={(id, targetId) => moveNote(id, targetId, 0)}
                    onReorder={(r, delta) => reorderSibling(r, delta)}
                  />
                )}
              </Each>
            </If>
          </Scroll>
        }
      >
        <View class="gap-0.5">
          <If
            when={rows().length > 0}
            else={
              <Text testID="page-tree-empty" class="px-2 py-3 text-center text-xs text-faint">
                {t("web.note.tree.empty")}
              </Text>
            }
          >
            <Each of={rows()} key={(r) => r.note.id}>
              {(row) => (
                <PageTreeRow
                  row={row()}
                  active={row().note.id === props.activeId}
                  allNotes={props.notes}
                  byId={byId()}
                  busy={act.busy()}
                  onSelect={props.onSelect}
                  onToggleExpand={toggleExpand}
                  onCreateChild={(parentId, nt) => createPage(nt, parentId)}
                  onMoveToRoot={(id) => moveNote(id, undefined, 0)}
                  onMoveUnder={(id, targetId) => moveNote(id, targetId, 0)}
                  onReorder={(r, delta) => reorderSibling(r, delta)}
                />
              )}
            </Each>
          </If>
        </View>
      </If>
    </View>
  );

  return (
    <View
      testID="page-tree"
      accessibilityLabel={t("web.note.tree.title")}
      class={embedded() ? `shrink-0 ${props.class ?? ""}` : `h-full w-48 shrink-0 border-r border-line bg-side ${props.class ?? ""}`}
    >
      {treeBody}
    </View>
  );
}

function PageTreeRow(props: {
  readonly row: TreeRow;
  readonly active: boolean;
  readonly allNotes: readonly Note[];
  readonly byId: ReadonlyMap<string, Note>;
  readonly busy: boolean;
  readonly onSelect: (id: NoteId) => void;
  readonly onToggleExpand: (id: string) => void;
  readonly onCreateChild: (parentId: NoteId, noteType: NoteType) => void;
  readonly onMoveToRoot: (id: NoteId) => void;
  readonly onMoveUnder: (id: NoteId, targetParentId: NoteId) => void;
  readonly onReorder: (row: TreeRow, delta: -1 | 1) => void;
}) {
  const menuOpen = signal(false);
  const reparentCandidates = computed(() =>
    props.allNotes.filter((candidate) => {
      const ownId = props.row.note.id;
      if (candidate.id === ownId || candidate.id === props.row.note.parentId) return false;
      return !isDescendant(props.byId, candidate.id, ownId);
    }),
  );

  return (
    <View
      testID={`page-tree-row-${props.row.note.id}`}
      class={`group relative h-7 flex-row items-center gap-1 rounded-md pr-1 ${props.active ? "bg-selected" : "hover:bg-hover"}`}
      style={{ paddingLeft: 6 + props.row.depth * 14 }}
    >
      <If when={props.active}>
        <ActiveBar />
      </If>
      <If when={props.row.hasChildren} else={<View class="size-4 shrink-0" />}>
        <View
          role="button"
          testID={`page-tree-toggle-${props.row.note.id}`}
          accessibilityLabel={props.row.note.title}
          accessibilityState={{ expanded: props.row.expanded }}
          onPress={() => props.onToggleExpand(props.row.note.id)}
          class="size-4 shrink-0 items-center justify-center rounded-sm hover:bg-selected"
        >
          <Icon name={props.row.expanded ? "choose" : "expand"} size={11} tone="faint" />
        </View>
      </If>

      <View
        role="button"
        testID={`page-tree-item-${props.row.note.id}`}
        accessibilityLabel={props.row.note.title}
        accessibilityState={{ selected: props.active }}
        onPress={() => props.onSelect(props.row.note.id)}
        class="min-w-0 flex-1 flex-row items-center gap-1.5 py-0.5 focus-visible:outline-2 focus-visible:outline-focus"
      >
        <Icon name={noteIcon(props.row.note)} size={13} tone={props.active ? "ink" : "muted"} />
        <Text class={`min-w-0 flex-1 truncate text-xs ${props.active ? "font-semibold text-ink" : "font-medium text-muted"}`}>{props.row.note.title}</Text>
      </View>

      <Menu
        open={menuOpen()}
        onOpenChange={(e) => menuOpen.set(e.open)}
        placement="bottom"
        align="end"
        offset={4}
        popupClass={menuPopupClass}
        popupStartingClass={popupTransition("opacity-0")}
        popupEndingClass={popupTransition("opacity-0")}
        trigger={
          <View
            role="button"
            testID={`page-tree-more-${props.row.note.id}`}
            accessibilityLabel={t("web.note.page.more")}
            class="size-5 shrink-0 items-center justify-center rounded-sm opacity-0 group-hover:opacity-100 aria-expanded:bg-selected aria-expanded:opacity-100 hover:bg-selected"
          >
            <Icon name="more" size={12} tone="muted" />
          </View>
        }
      >
        <Submenu
          offset={4}
          trigger={
            <View testID={`page-tree-add-child-${props.row.note.id}`} class="h-7 flex-row items-center gap-2 rounded-md px-2 hover:bg-hover focus:bg-hover">
              <Icon name="add" size={13} tone="muted" />
              <Text class="min-w-0 flex-1 truncate text-xs text-ink">{t("web.note.tree.newChild")}</Text>
              <Icon name="expand" size={10} tone="muted" />
            </View>
          }
        >
          <Each of={NOTE_TYPES} key={(nt) => nt}>
            {(nt) => (
              <MenuItem
                testID={`page-tree-add-child-${props.row.note.id}-${nt()}`}
                disabled={props.busy}
                onSelect={() => props.onCreateChild(props.row.note.id, nt())}
                class="h-7 flex-row items-center gap-2 rounded-md px-2 hover:bg-hover focus:bg-hover"
              >
                <Icon name={noteTypeIcon[nt()]} size={13} tone="muted" />
                <Text class="min-w-0 flex-1 truncate text-xs text-ink">{noteTypeLabel(nt())}</Text>
              </MenuItem>
            )}
          </Each>
        </Submenu>

        <If when={props.row.note.parentId !== undefined}>
          <MenuItem
            testID={`page-tree-move-root-${props.row.note.id}`}
            disabled={props.busy}
            onSelect={() => props.onMoveToRoot(props.row.note.id)}
            class="h-7 flex-row items-center gap-2 rounded-md px-2 hover:bg-hover focus:bg-hover"
          >
            <Icon name="back" size={13} tone="muted" />
            <Text class="min-w-0 flex-1 truncate text-xs text-ink">{t("web.note.tree.moveToRoot")}</Text>
          </MenuItem>
        </If>

        <If when={reparentCandidates().length > 0}>
          <Submenu
            offset={4}
            trigger={
              <View testID={`page-tree-reparent-${props.row.note.id}`} class="h-7 flex-row items-center gap-2 rounded-md px-2 hover:bg-hover focus:bg-hover">
                <Icon name="indent" size={13} tone="muted" />
                <Text class="min-w-0 flex-1 truncate text-xs text-ink">{t("web.note.tree.title")}</Text>
                <Icon name="expand" size={10} tone="muted" />
              </View>
            }
          >
            <Each of={reparentCandidates()} key={(c) => c.id}>
              {(cand) => (
                <MenuItem
                  testID={`page-tree-reparent-${props.row.note.id}-${cand().id}`}
                  disabled={props.busy}
                  onSelect={() => props.onMoveUnder(props.row.note.id, cand().id)}
                  class="h-7 flex-row items-center gap-2 rounded-md px-2 hover:bg-hover focus:bg-hover"
                >
                  <Icon name={noteIcon(cand())} size={12} tone="muted" />
                  <Text class="min-w-0 flex-1 truncate text-xs text-ink">{cand().title}</Text>
                </MenuItem>
              )}
            </Each>
          </Submenu>
        </If>

        <If when={props.row.siblingCount > 1}>
          <>
            <MenuSeparator class={menuSeparatorClass} />
            <If when={props.row.siblingIndex > 0}>
              <MenuItem
                testID={`page-tree-move-up-${props.row.note.id}`}
                disabled={props.busy}
                onSelect={() => props.onReorder(props.row, -1)}
                class="h-7 flex-row items-center gap-2 rounded-md px-2 hover:bg-hover focus:bg-hover"
              >
                <Icon name="moveUp" size={13} tone="muted" />
                <Text class="min-w-0 flex-1 truncate text-xs text-ink">{t("web.base.lightbox.prev")}</Text>
              </MenuItem>
            </If>
            <If when={props.row.siblingIndex < props.row.siblingCount - 1}>
              <MenuItem
                testID={`page-tree-move-down-${props.row.note.id}`}
                disabled={props.busy}
                onSelect={() => props.onReorder(props.row, 1)}
                class="h-7 flex-row items-center gap-2 rounded-md px-2 hover:bg-hover focus:bg-hover"
              >
                <Icon name="moveDown" size={13} tone="muted" />
                <Text class="min-w-0 flex-1 truncate text-xs text-ink">{t("web.base.lightbox.next")}</Text>
              </MenuItem>
            </If>
          </>
        </If>
      </Menu>
    </View>
  );
}
