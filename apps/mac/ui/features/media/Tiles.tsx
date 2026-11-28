import { computed, effect, Image, signal, Text, View } from "nsh";
import { Popover } from "nsh/base";

import { t } from "@vibevalley/i18n";
import { isHumanParticipant, type Issue, type LibraryItem, type MediaJob, type Note } from "@vibevalley/protocol";
import type { NoteAppletInfo } from "@vibevalley/protocol/host";

import { Button } from "../../design/Button";
import { Icon } from "../../design/Icon";
import type { IconName } from "../../design/icons";
import { Bubble } from "../../design/Tip";
import { useAttachmentUrl } from "../../infra/attachmentFile";
import { useNow } from "../../infra/base/dom";
import { ago } from "../../infra/base/format";
import { kindLabel, noteIcon } from "../note";
import { durationText, extOf, justify, kindOf, type Placed } from "./items";
import { NotePreview } from "./NotePreview";

export interface Seen {
  readonly ratio?: number;
  readonly width?: number;
  readonly height?: number;
  readonly seconds?: number;
}

export const knows = ({ had, learnt }: { readonly had: Seen; readonly learnt: Seen }) =>
  (learnt.ratio === undefined || had.ratio === learnt.ratio) &&
  (learnt.width === undefined || had.width === learnt.width) &&
  (learnt.height === undefined || had.height === learnt.height) &&
  (learnt.seconds === undefined || had.seconds === learnt.seconds);

export const tileGap = 12;
const captionPx = 22;

const kindIcon: Record<"audio" | "video" | "other", IconName> = { audio: "audio", video: "video", other: "file" };

export const ratioOf = ({ item, seen }: { readonly item: LibraryItem; readonly seen: Seen | undefined }): number => {
  if (seen?.ratio !== undefined) return seen.ratio;
  switch (kindOf(item.attachment.type)) {
    case "image":
      return 1;
    case "video":
      return 16 / 9;
    case "audio":
      return 1.5;
    case "other":
      return 0.8;
  }
};

function CardPinButton(props: { testid: string; pinned: boolean; elevated?: boolean | undefined; onToggle: () => void }) {
  const label = () => (props.pinned ? t("web.library.content.unpin") : t("web.library.content.pin"));
  return (
    <View
      role="button"
      testID={props.testid}
      accessibilityLabel={label()}
      accessibilityState={{ selected: props.pinned }}
      tooltip={<Bubble text={label()} />}
      onPress={() => props.onToggle()}
      class={`size-6 shrink-0 items-center justify-center rounded-sm focus-visible:outline-2 focus-visible:outline-focus ${
        props.pinned
          ? "border border-line bg-warn-soft"
          : props.elevated === true
            ? "border border-line bg-elevated shadow-raise hover:bg-selected"
            : "border border-transparent bg-transparent hover:bg-selected"
      }`}
    >
      <Icon name="pin" size={12} tone={props.pinned ? "warn-ink" : "muted"} />
    </View>
  );
}

export function MakingTiles(props: { jobs: readonly MediaJob[]; width: number; height: number; label: (job: MediaJob) => string }) {
  const rows = computed(() => justify({ ratios: props.jobs.map(() => 1), width: props.width, height: props.height, gap: tileGap }));
  return (
    <View class="gap-3">
      <Each of={rows()} key={(_, i) => String(i)}>
        {(row) => (
          <View class="flex-row gap-3">
            <Each of={row()} key={(p) => p.index}>
              {(p) => (
                <If when={props.jobs[p().index]}>
                  {(job) => (
                    <View testID="library-making" class="shrink-0 min-w-0" style={{ width: p().width, height: p().height + captionPx }}>
                      <View class="flex-1 min-h-0 items-center justify-center gap-2 rounded-md border border-dashed border-wheat bg-side p-2">
                        <Icon name="wait" size={20} tone="wheat" />
                        <Text class="text-center text-xs text-ink">{job().phaseText}</Text>
                      </View>
                      <Text class="pt-1.5 truncate text-xs text-muted">{props.label(job())}</Text>
                    </View>
                  )}
                </If>
              )}
            </Each>
          </View>
        )}
      </Each>
    </View>
  );
}

const stacked = ({
  rows,
  gap,
}: {
  readonly rows: readonly Placed[][];
  readonly gap: number;
}): { readonly at: ReadonlyMap<number, Placed & { readonly y: number }>; readonly height: number } => {
  const at = new Map<number, Placed & { readonly y: number }>();
  let y = 0;
  for (const [i, row] of rows.entries()) {
    for (const p of row) at.set(p.index, { ...p, y });
    y += (row[0]?.height ?? 0) + captionPx + (i < rows.length - 1 ? gap : 0);
  }
  return { at, height: y };
};

export function Tiles(props: {
  items: readonly LibraryItem[];
  rows: readonly Placed[][];
  picked: readonly string[];
  active: string | undefined;
  isPinned?: ((id: string) => boolean) | undefined;
  onTogglePin?: ((id: string) => void) | undefined;
  seen: (id: string) => Seen | undefined;
  onSeen: (id: string, seen: Seen) => void;
  onPick: (id: string, how: { readonly add: boolean; readonly range: boolean }) => void;
  onLook: (id: string) => void;
}) {
  const layout = computed(() => stacked({ rows: props.rows, gap: tileGap }));
  const pickedSet = computed(() => new Set(props.picked));
  return (
    <View class="relative" style={{ height: layout().height }}>
      <Each of={props.items} key={(item) => item.attachment.id}>
        {(item, index) => (
          <If when={layout().at.get(index())}>
            {(p) => (
              <Tile
                item={item()}
                x={p().x}
                y={p().y}
                width={p().width}
                height={p().height}
                picked={pickedSet().has(item().attachment.id)}
                active={props.active === item().attachment.id}
                pinned={props.isPinned?.(item().attachment.id) === true}
                onTogglePin={props.onTogglePin ? () => props.onTogglePin?.(item().attachment.id) : undefined}
                seen={props.seen(item().attachment.id)}
                onSeen={(s) => props.onSeen(item().attachment.id, s)}
                onPick={(how) => props.onPick(item().attachment.id, how)}
                onLook={() => props.onLook(item().attachment.id)}
              />
            )}
          </If>
        )}
      </Each>
    </View>
  );
}

function Tile(props: {
  item: LibraryItem;
  x: number;
  y: number;
  width: number;
  height: number;
  picked: boolean;
  active: boolean;
  pinned: boolean;
  onTogglePin?: (() => void) | undefined;
  seen: Seen | undefined;
  onSeen: (seen: Seen) => void;
  onPick: (how: { readonly add: boolean; readonly range: boolean }) => void;
  onLook: () => void;
}) {
  const file = () => props.item.attachment;
  const kind = () => kindOf(file().type);
  const url = useAttachmentUrl(() => file().id);

  effect(() => {
    const src = url();
    if (kind() === "image" && src && props.seen?.width === undefined) {
      void Image.getSize(src).then(
        (sz) => {
          if (sz.width > 0 && sz.height > 0) {
            props.onSeen({ ratio: sz.width / sz.height, width: sz.width, height: sz.height });
          }
        },
        () => {},
      );
    }
  });

  return (
    <View
      role="button"
      testID="library-item"
      accessibilityLabel={file().name}
      tooltip={<Bubble text={file().name} />}
      onPress={(e) => {
        if (kind() === "image" && e.clickCount >= 2) {
          props.onLook();
          return;
        }
        props.onPick({ add: e.modifiers.platform || e.modifiers.control, range: e.modifiers.shift });
      }}
      class="group absolute shrink-0 min-w-0"
      style={{ left: props.x, top: props.y, width: props.width, height: props.height + captionPx }}
    >
      <View
        class={`relative flex-1 min-h-0 items-center justify-center overflow-hidden rounded-md border bg-side ${
          props.active || props.picked ? "border-accent" : "border-line hover:border-faint"
        }`}
      >
        <If
          when={kind() === "image" ? url() : undefined}
          else={
            <View class="items-center justify-center gap-1">
              <Icon name={kindIcon[kind() === "audio" ? "audio" : kind() === "video" ? "video" : "other"]} size={24} tone="muted" />
              <If when={extOf(file().name)}>{(ext) => <Text class="font-mono text-2xs font-medium text-ink">{ext()}</Text>}</If>
              <If when={props.seen?.seconds}>{(s) => <Text class="font-mono text-2xs text-faint tabular-nums">{durationText(s())}</Text>}</If>
            </View>
          }
        >
          {(src) => <Image src={src()} style={{ width: props.width, height: props.height, objectFit: "cover" }} />}
        </If>
        <If
          when={props.onTogglePin}
          else={
            <If when={props.pinned}>
              <View class="pointer-events-none absolute top-1.5 right-1.5 size-5 items-center justify-center rounded-sm border border-line bg-warn-soft">
                <Icon name="pin" size={10} tone="warn-ink" />
              </View>
            </If>
          }
        >
          {(toggle) => (
            <View class={`absolute top-1.5 right-1.5 ${props.pinned ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-within:opacity-100"}`}>
              <CardPinButton testid={`library-media-pin-${file().id}`} pinned={props.pinned} elevated onToggle={() => toggle()()} />
            </View>
          )}
        </If>
        <If when={props.active || props.picked}>
          <View class="pointer-events-none absolute inset-0 rounded-sm border border-accent" />
        </If>
      </View>
      <Text class={`pt-1.5 truncate text-xs font-medium ${props.picked ? "text-ink" : "text-muted"}`}>{file().name}</Text>
    </View>
  );
}

const noteCardMinWidth = 256;

export function noteMetaLine(note: Note, nowMs: number): string {
  const parts: string[] = [kindLabel(note)];
  if (!isHumanParticipant(note.by) && note.byName.trim() !== "") parts.push(note.byName);
  if (note.version > 0) parts.push(t("web.library.inspector.versionBadge", { version: note.version }));
  parts.push(ago(note.updated, nowMs));
  return parts.join(" · ");
}

export function NoteTiles(props: {
  notes: readonly Note[];
  notesById?: ReadonlyMap<string, Pick<Note, "title">> | undefined;
  issuesById?: ReadonlyMap<string, Pick<Issue, "number" | "title">> | undefined;
  width?: number | undefined;
  onOpen: (id: string) => void;
  isPinned: (id: string) => boolean;
  onTogglePin: (id: string) => void;
  onDelete?: ((note: Note) => void) | undefined;
  installedApplets?: ReadonlyMap<string, NoteAppletInfo> | undefined;
  canInstallApplet?: boolean | undefined;
  onInstallApplet?: ((note: Note) => void) | undefined;
  onOpenApplet?: ((noteId: string) => void) | undefined;
}) {
  const now = useNow();
  const cardWidth = computed(() => {
    const w = props.width;
    if (w === undefined || w <= 0) return noteCardMinWidth;
    const cols = Math.max(1, Math.floor((w + tileGap) / (noteCardMinWidth + tileGap)));
    return Math.floor((w - tileGap * (cols - 1)) / cols);
  });
  const stageWidth = computed(() => Math.max(0, cardWidth() - 2));
  const stageHeight = computed(() => Math.round((stageWidth() * 10) / 16));
  return (
    <View testID="library-notes" class="flex-row flex-wrap gap-3">
      <Each of={props.notes} key={(n) => n.id}>
        {(n) => {
          const pinned = () => props.isPinned(n().id);
          const installed = () => props.installedApplets?.get(n().id);
          return (
            <View
              role="button"
              testID={`library-note-${n().id}`}
              accessibilityLabel={n().title}
              tooltip={<Bubble text={n().title} />}
              onPress={() => props.onOpen(n().id)}
              style={{ width: cardWidth() }}
              class="group relative shrink-0 overflow-hidden rounded-lg border border-line bg-page hover:border-faint focus-visible:outline-2 focus-visible:outline-focus"
            >
              <View class="relative overflow-hidden border-b border-line bg-side" style={{ width: stageWidth(), height: stageHeight() }}>
                <NotePreview note={n()} width={stageWidth()} height={stageHeight()} notesById={props.notesById} issuesById={props.issuesById} />
                <View
                  class={`absolute top-2 right-2 flex-row items-center gap-0.5 rounded-md border border-line bg-elevated p-0.5 shadow-raise ${pinned() ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-within:opacity-100"}`}
                >
                  <If
                    when={installed()}
                    else={
                      <If when={props.canInstallApplet === true}>
                        <View
                          role="button"
                          testID={`library-note-install-app-${n().id}`}
                          accessibilityLabel={t("web.note.applet.button")}
                          tooltip={<Bubble text={t("web.note.applet.button")} />}
                          onPress={() => props.onInstallApplet?.(n())}
                          class="size-6 shrink-0 items-center justify-center rounded-xs hover:bg-selected focus-visible:outline-2 focus-visible:outline-focus"
                        >
                          <Icon name="devices" size={12} tone="muted" />
                        </View>
                      </If>
                    }
                  >
                    {(info) => (
                      <View
                        role="button"
                        testID={`library-note-manage-app-${n().id}`}
                        accessibilityLabel={t("web.note.applet.manageApp")}
                        tooltip={<Bubble text={`${info().appName} · ${t("web.note.applet.manageApp")}`} />}
                        onPress={() => props.onInstallApplet?.(n())}
                        class="size-6 shrink-0 items-center justify-center rounded-xs hover:bg-selected focus-visible:outline-2 focus-visible:outline-focus"
                      >
                        <Icon name="devices" size={12} tone="ok-ink" />
                      </View>
                    )}
                  </If>
                  <CardPinButton testid={`library-note-pin-${n().id}`} pinned={pinned()} onToggle={() => props.onTogglePin(n().id)} />
                  <If when={props.onDelete}>{(onDel) => <DeleteNoteButton note={n()} onDelete={onDel()} />}</If>
                </View>
              </View>
              <View class="gap-1 px-3 py-2.5">
                <View class="flex-row items-center gap-1.5">
                  <Text class="min-w-0 flex-1 truncate text-sm font-semibold text-ink">{n().title}</Text>
                  <If when={installed()}>
                    <View
                      role="button"
                      testID={`library-note-open-app-${n().id}`}
                      accessibilityLabel={t("web.note.applet.openApp")}
                      tooltip={<Bubble text={t("web.note.applet.openApp")} />}
                      onPress={() => props.onOpenApplet?.(n().id)}
                      class="size-6 shrink-0 items-center justify-center rounded-sm border border-line bg-ok-soft hover:bg-hover focus-visible:outline-2 focus-visible:outline-focus"
                    >
                      <Icon name="open" size={12} tone="ok-ink" />
                    </View>
                  </If>
                </View>
                <View class="flex-row items-center gap-1.5">
                  <Icon name={noteIcon(n())} size={12} tone="faint" />
                  <Text class="min-w-0 flex-1 truncate text-xs text-muted tabular-nums">{noteMetaLine(n(), now())}</Text>
                </View>
              </View>
            </View>
          );
        }}
      </Each>
    </View>
  );
}

function DeleteNoteButton(props: { note: Note; onDelete: (note: Note) => void }) {
  const open = signal(false);
  return (
    <Popover
      open={open()}
      onOpenChange={(e) => open.set(e.open)}
      placement="top"
      align="end"
      offset={6}
      popupClass="w-60 rounded-lg border border-line bg-elevated p-3 shadow-float"
      trigger={
        <View
          role="button"
          testID={`library-note-delete-${props.note.id}`}
          accessibilityLabel={t("web.note.page.delete")}
          tooltip={<Bubble text={t("web.note.page.delete")} />}
          onPress={() => open.set(true)}
          class={`size-6 shrink-0 items-center justify-center rounded-sm border border-line shadow-raise focus-visible:outline-2 focus-visible:outline-focus ${
            open() ? "bg-bad-soft" : "bg-elevated hover:bg-bad-soft"
          }`}
        >
          <Icon name="delete" size={12} tone="berry" />
        </View>
      }
    >
      <View class="gap-2.5">
        <Text class="text-xs leading-relaxed text-ink">{t("web.note.page.deleteAsk", { title: props.note.title })}</Text>
        <View class="flex-row items-center justify-end gap-1.5">
          <Button size="compact" tone="quiet" onPress={() => open.set(false)}>
            {t("web.base.form.never")}
          </Button>
          <Button
            size="compact"
            tone="danger"
            icon="delete"
            testID="library-note-delete-confirm"
            onPress={() => {
              const target = props.note;
              open.set(false);
              props.onDelete(target);
            }}
          >
            {t("web.note.page.delete")}
          </Button>
        </View>
      </View>
    </Popover>
  );
}
