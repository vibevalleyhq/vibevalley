// The file tree: nsh's Tree over the frame Rust keeps (directories load as
// they expand), with git status colors.
import { Clipboard, computed, keymap, signal, Text, View } from "nsh";
import { Button, ContextMenu, MenuItem, MenuSeparator, Tree, type TreeItem } from "nsh/base";
import { z } from "zod";

import { t } from "@vibevalley/i18n";

import { Icon } from "../design/Icon";
import { IconButton } from "../design/IconButton";
import { motionClass } from "../design/motion";
import { SkeletonBar, SkeletonLines, useDelayedBusy } from "../design/Skeleton";
import { act, hostApi } from "../infra/bridge";
import { gitToneIconTone, gitToneTextClass, menuItemClass, menuPopupClass, menuSeparatorClass, PanelEmpty, SectionHead, ShellIconButton } from "./chrome";

export type FileItem = TreeItem & { tone?: string; hidden?: boolean; loading?: boolean; children?: FileItem[] };
export type FilesFrame = { root?: string; name?: string; items: FileItem[]; expanded?: string[]; selected?: string | null; loading?: boolean };

const UNSUPPORTED_PREVIEW_EXTENSIONS = new Set([
  "pdf",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "pages",
  "numbers",
  "key",
  "epub",
  "rtf",
  "zip",
  "tar",
  "gz",
  "tgz",
  "bz2",
  "xz",
  "7z",
  "rar",
  "dmg",
  "iso",
  "pkg",
  "deb",
  "rpm",
  "mp3",
  "wav",
  "flac",
  "aac",
  "ogg",
  "m4a",
  "opus",
  "aiff",
  "mp4",
  "mov",
  "mkv",
  "avi",
  "webm",
  "m4v",
  "wmv",
  "ttf",
  "otf",
  "woff",
  "woff2",
  "eot",
  "db",
  "sqlite",
  "sqlite3",
  "wasm",
  "bin",
  "exe",
  "dll",
  "so",
  "dylib",
  "a",
  "o",
  "obj",
  "lib",
  "rlib",
  "class",
  "jar",
  "war",
  "pyc",
  "pyo",
  "node",
  "apk",
  "ipa",
  "psd",
  "ai",
  "sketch",
  "fig",
  "xd",
  "blend",
  "glb",
  "gltf",
  "fbx",
  "usdz",
  "stl",
  "3ds",
]);

function isUnsupportedPreviewFile(path: string): boolean {
  const base = path.split("/").pop() ?? path;
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return false;
  return UNSUPPORTED_PREVIEW_EXTENSIONS.has(base.slice(dot + 1).toLowerCase());
}

const fileItemSchema: z.ZodType<FileItem> = z.lazy(() =>
  z.object({
    id: z.string(),
    label: z.string(),
    tone: z.exactOptional(z.string()),
    hidden: z.exactOptional(z.boolean()),
    loading: z.exactOptional(z.boolean()),
    children: z.exactOptional(z.array(fileItemSchema)),
  }),
);

export const filesFrameSchema: z.ZodType<FilesFrame> = z.object({
  root: z.exactOptional(z.string()),
  name: z.exactOptional(z.string()),
  items: z.array(fileItemSchema),
  expanded: z.exactOptional(z.array(z.string())),
  selected: z.exactOptional(z.string().nullable()),
  loading: z.exactOptional(z.boolean()),
});

function index(items: FileItem[], into: Map<string, FileItem>) {
  for (const i of items) {
    into.set(i.id, i);
    if (i.children) index(i.children, into);
  }
  return into;
}

export function FileTree(props: { frame: FilesFrame | null }) {
  const byId = computed(() => index(props.frame?.items ?? [], new Map()));
  const expandedIds = computed(() => new Set(props.frame?.expanded ?? []));
  const hasItems = computed(() => (props.frame?.items.length ?? 0) > 0);
  const isLoadingTree = computed(() => !props.frame || (props.frame.items.length === 0 && props.frame.loading === true));
  const showLoading = useDelayedBusy(isLoadingTree);
  const unsupportedChoice = signal<{ readonly path: string; readonly label: string } | null>(null);
  keymap.bind(
    "escape",
    () => {
      if (unsupportedChoice() !== null) unsupportedChoice.set(null);
    },
    { when: "always" },
  );
  const relPath = (abs: string) => {
    const root = props.frame?.root?.replace(/\/+$/u, "");
    return root && abs.startsWith(`${root}/`) ? abs.slice(root.length + 1) : abs;
  };
  const dirOf = (abs: string, folder: boolean) => {
    if (folder) return abs;
    const i = abs.lastIndexOf("/");
    return i > 0 ? abs.slice(0, i) : (props.frame?.root ?? abs);
  };
  const handleFileSelect = (path: string) => {
    const item = byId().get(path);
    if (!item || item.children || item.tone === "placeholder" || item.loading === true) return;
    if (isUnsupportedPreviewFile(path)) {
      unsupportedChoice.set({ path, label: item.label });
      return;
    }
    unsupportedChoice.set(null);
    act({ type: "open_file", path });
  };
  return (
    <View class="flex-1">
      <SectionHead
        title={props.frame?.name ?? t("web.shell.fileTree.title")}
        borderBottom
        right={
          <If when={(props.frame?.expanded?.length ?? 0) > 0}>
            <ShellIconButton
              label={t("web.shell.fileTree.collapseAllDirs")}
              icon="collapseAll"
              onPress={() => {
                for (const dir of [...(props.frame?.expanded ?? [])].toReversed()) {
                  act({ type: "collapse_dir", path: dir });
                }
              }}
            />
          </If>
        }
      />
      <If
        when={hasItems()}
        else={
          <If when={isLoadingTree()} else={<PanelEmpty text={t("web.shell.fileTree.empty")} />}>
            <If when={showLoading()} else={<View class="flex-1" />}>
              <SkeletonLines
                testID="file-tree-skeleton"
                accessibilityLabel={t("web.shell.fileTree.loading")}
                surface="side"
                rows={["58%", "74%", "64%", "48%", "70%"]}
                indent={[0, 14, 14, 28, 0]}
                class="px-3 py-2.5"
              />
            </If>
          </If>
        }
      >
        <Tree
          items={props.frame?.items ?? []}
          expanded={props.frame?.expanded ?? []}
          selected={props.frame?.selected ?? null}
          accessibilityLabel={t("web.shell.fileTree.title")}
          class="flex-1"
          listClass="px-1.5 py-1.5"
          itemClass="group h-6.5 rounded-md hover:bg-hover selected:bg-selected focus-visible:outline-2 focus-visible:outline-focus"
          onExpand={({ id }) => act({ type: "expand_dir", path: id })}
          onCollapse={({ id }) => act({ type: "collapse_dir", path: id })}
          onSelectedChange={({ selected }) => handleFileSelect(selected)}
          onAction={({ id }) => handleFileSelect(id)}
          renderItem={(entry) => {
            const item = () => byId().get(entry.id);
            const isPlaceholder = () => item()?.tone === "placeholder";
            const isLoadingRow = () => item()?.loading === true || (isPlaceholder() && entry.id.endsWith("/__loading"));
            const labelClass = () => {
              const cur = item();
              if (cur?.tone === "placeholder") return "text-xs italic text-faint";
              const weight = entry.folder ? "font-medium" : "font-normal";
              if (cur?.hidden === true && cur.tone === "clean") return `text-sm ${weight} text-muted`;
              return `text-sm ${weight} ${gitToneTextClass(cur?.tone)}`;
            };
            const iconTone = () => {
              const tone = item()?.tone;
              if (entry.folder) {
                if (tone === "dirty") return "warn-ink";
                if (tone === "ignored") return "faint";
                return "muted";
              }
              if (tone && tone !== "clean") return gitToneIconTone(tone);
              return "muted";
            };
            const renderRow = () => (
              <View class="h-6.5 flex-row items-center gap-1.5 pr-2" style={{ paddingLeft: 6 + entry.depth * 14 }}>
                <View class="h-4 w-4 shrink-0 items-center justify-center">
                  <If when={entry.folder}>
                    <Icon name={expandedIds().has(entry.id) ? "choose" : "expand"} size={14} tone="muted" />
                  </If>
                </View>
                <If when={!isPlaceholder() && !isLoadingRow()}>
                  <View class="size-3.5 shrink-0 items-center justify-center">
                    <Icon name={entry.folder ? "folder" : "file"} size={13} tone={iconTone()} />
                  </View>
                </If>
                <If when={isLoadingRow()} else={<Text class={`min-w-0 flex-1 truncate ${labelClass()}`}>{entry.label}</Text>}>
                  <SkeletonBar testID="file-tree-row-skeleton" surface="side" class="h-3 w-24" />
                </If>
                <If when={entry.folder && item()?.tone === "dirty"}>
                  <View class="size-1.5 shrink-0 rounded-full bg-wheat" />
                </If>
              </View>
            );
            return (
              <If
                when={isPlaceholder() || isLoadingRow()}
                else={
                  <ContextMenu trigger={renderRow()} popupClass={menuPopupClass}>
                    <If when={!entry.folder}>
                      <MenuItem
                        testID="file-menu-open-default"
                        onSelect={() => {
                          unsupportedChoice.set(null);
                          void hostApi.openFile(entry.id);
                        }}
                        class={menuItemClass}
                      >
                        <Text class="text-xs text-ink">{t("web.shell.fileTree.openWithDefault")}</Text>
                      </MenuItem>
                      <MenuSeparator class={menuSeparatorClass} />
                    </If>
                    <MenuItem onSelect={() => void Clipboard.writeText(relPath(entry.id))} class={menuItemClass}>
                      <Text class="text-xs text-ink">{t("web.shell.fileTree.copyRelPath")}</Text>
                    </MenuItem>
                    <MenuItem onSelect={() => void Clipboard.writeText(entry.id)} class={menuItemClass}>
                      <Text class="text-xs text-ink">{t("web.shell.fileTree.copyAbsPath")}</Text>
                    </MenuItem>
                    <MenuSeparator class={menuSeparatorClass} />
                    <MenuItem onSelect={() => void hostApi.reveal(entry.id)} class={menuItemClass}>
                      <Text class="text-xs text-ink">{t("web.shell.fileTree.revealInFinder")}</Text>
                    </MenuItem>
                    <MenuItem onSelect={() => act({ type: "new_terminal_at", path: dirOf(entry.id, entry.folder) })} class={menuItemClass}>
                      <Text class="text-xs text-ink">{t("web.shell.fileTree.newTerminalInDir")}</Text>
                    </MenuItem>
                  </ContextMenu>
                }
              >
                {renderRow()}
              </If>
            );
          }}
        />
      </If>
      <If when={unsupportedChoice()}>
        {(choice) => (
          <View testID="file-unsupported-popover" class="shrink-0 gap-2 border-t border-line bg-elevated p-2.5">
            <View class="flex-row items-start gap-2">
              <View class="min-w-0 flex-1 gap-0.5">
                <Text class="truncate text-xs font-semibold text-ink">{choice().label}</Text>
                <Text class="text-2xs leading-snug text-muted">{t("web.shell.fileTree.unsupportedHint")}</Text>
              </View>
              <IconButton
                icon="close"
                size={12}
                label={t("web.shell.git.cancel")}
                testid="file-unsupported-close"
                onClick={() => unsupportedChoice.set(null)}
              />
            </View>
            <View class="flex-row items-center gap-1.5">
              <Button
                testID="file-open-default"
                onPress={() => {
                  const target = choice().path;
                  unsupportedChoice.set(null);
                  void hostApi.openFile(target);
                }}
                class={`h-7 flex-1 flex-row items-center justify-center gap-1.5 rounded-md bg-accent px-2 ${motionClass("transition-transform duration-120 ease-out")} hover:opacity-90 active:translate-y-px focus-visible:outline-2 focus-visible:outline-focus`}
              >
                <Icon name="open" size={12} tone="page" />
                <Text class="truncate text-xs font-medium text-page">{t("web.shell.fileTree.openWithDefault")}</Text>
              </Button>
              <Button
                testID="file-open-in-app"
                onPress={() => {
                  const target = choice().path;
                  unsupportedChoice.set(null);
                  act({ type: "open_file", path: target });
                }}
                class={`h-7 flex-1 flex-row items-center justify-center gap-1.5 rounded-md border border-line bg-page px-2 ${motionClass("transition-transform duration-120 ease-out")} hover:bg-hover active:translate-y-px focus-visible:outline-2 focus-visible:outline-focus`}
              >
                <Icon name="file" size={12} tone="muted" />
                <Text class="truncate text-xs font-medium text-ink">{t("web.shell.fileTree.openInApp")}</Text>
              </Button>
            </View>
          </View>
        )}
      </If>
    </View>
  );
}
