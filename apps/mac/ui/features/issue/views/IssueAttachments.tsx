import { computed, Image, Picker, signal, Text, untracked, View } from "nsh";
import { Progress } from "nsh/base";

import { t } from "@vibevalley/i18n";
import type { Attachment } from "@vibevalley/protocol";

import { Button } from "../../../design/Button";
import { CompareUploadDialog, type CompareUploadResult } from "../../../design/Compare";
import { AttachmentTile, fileKind, kindIcon, sizeText } from "../../../design/domain/AttachmentTile";
import { Icon } from "../../../design/Icon";
import { IconButton } from "../../../design/IconButton";
import { Lightbox } from "../../../design/Lightbox";
import { motionClass } from "../../../design/motion";
import { readFiles } from "../../../design/picked";
import { Bubble } from "../../../design/Tip";
import { toast } from "../../../design/toasts";
import { mix } from "../../../design/tone";
import { api, newSendKey, reasonOf } from "../../../infra/api";
import { attachmentData } from "../../../infra/attachment";
import { fileUrl, openAttachment, useAttachmentFile } from "../../../infra/attachmentFile";
import { appHistory } from "../../../infra/router";
import { createEffect } from "../../../infra/solid";

export interface PendingUpload {
  readonly key: number;
  readonly name: string;
}

/** Uploads picked files into CAS via `attachment.create`, tracking in-flight items and errors. */
export function createAttachmentUploader(onAdd: (file: Attachment) => unknown) {
  const uploading = signal<readonly PendingUpload[]>([]);
  const error = signal<string | undefined>(undefined);
  let nextKey = 0;

  const uploadFiles = async (files: readonly File[]) => {
    for (const file of files) {
      const key = ++nextKey;
      const name = file.name || "file";
      error.set(undefined);
      uploading.set([...untracked(uploading), { key, name }]);
      try {
        const data = await attachmentData(file);
        const made = await api.attachment.create({ name, type: file.type || "application/octet-stream", data });
        await onAdd(made);
      } catch (e: unknown) {
        const reason = reasonOf(e);
        error.set(reason);
        toast(t("web.issue.attachments.uploadFailed", { why: reason }), "bad");
      } finally {
        uploading.set(untracked(uploading).filter((u) => u.key !== key));
      }
    }
  };

  const pick = async () => {
    const picked = await Picker.pickFiles({ multiple: true });
    const files = readFiles(picked);
    if (files.length > 0) await uploadFiles(files);
  };

  return { uploading, error, pick, uploadFiles };
}

function UploadingChip(props: { name: string }) {
  return (
    <Progress
      value={50}
      accessibilityLabel={props.name}
      testID="issue-attachment-uploading"
      class="h-10 flex-row items-center rounded-md border border-line bg-page px-2.5"
      trackClass="absolute inset-0"
      indicatorClass="h-full"
      indicatorStyle={{ backgroundColor: mix("leaf", 0.2) }}
    >
      <Text class="max-w-48 truncate text-xs text-muted">{t("web.issue.attachments.uploading", { name: props.name })}</Text>
    </Progress>
  );
}

/** Compact strip of editable `AttachmentTile` items + in-flight upload indicators (used in `NewIssue`). */
export function IssueAttachmentStrip(props: {
  files: readonly Attachment[];
  uploading?: readonly PendingUpload[] | undefined;
  onRemove?: ((id: string) => void) | undefined;
  testid?: string;
}) {
  const activeUploads = computed(() => props.uploading ?? []);
  const hasAny = computed(() => props.files.length > 0 || activeUploads().length > 0);
  return (
    <If when={hasAny()}>
      <View testID={props.testid ?? "issue-attachment-strip"} class="flex-row flex-wrap gap-1.5">
        <Each of={props.files} key={(f) => f.id}>
          {(f) => <AttachmentTile testid="issue-attachment-tile" file={f()} onRemove={props.onRemove ? () => props.onRemove?.(f().id) : undefined} />}
        </Each>
        <Each of={activeUploads()} key={(u) => u.key}>
          {(u) => <UploadingChip name={u().name} />}
        </Each>
      </View>
    </If>
  );
}

/**
 * Reusable issue attachment section:
 * - Display mode: image thumbnails opening `Lightbox`, non-image tiles opening via `openAttachment`.
 * - Editable mode: add button (`<IconButton icon="attach" />`), upload progress/error feedback, and remove controls.
 */
export function IssueAttachments(props: {
  files: readonly Attachment[];
  editable?: boolean | undefined;
  busy?: boolean | undefined;
  first?: boolean | undefined;
  onAdd?: ((file: Attachment) => unknown) | undefined;
  onAddCompare?: ((result: CompareUploadResult) => unknown) | undefined;
  onRemove?: ((id: string) => unknown) | undefined;
}) {
  const uploader = createAttachmentUploader((file) => props.onAdd?.(file));
  const compareOpen = signal(false);
  const known = signal<ReadonlyMap<string, string>>(new Map());
  const pictures = computed(() =>
    props.files.flatMap((f) => {
      const path = fileKind(f.type) === "image" ? known().get(f.id) : undefined;
      return path === undefined ? [] : [{ id: f.id, src: fileUrl(path), name: f.name, path }];
    }),
  );
  const lightboxAt = signal<number | undefined>(undefined);
  const hasItems = computed(() => props.files.length > 0 || uploader.uploading().length > 0);
  const visible = computed(() => props.editable === true || hasItems());
  const disabled = computed(() => props.busy === true);

  const handleAddCompare = async (result: CompareUploadResult) => {
    if (props.onAddCompare) {
      await props.onAddCompare(result);
      compareOpen.set(false);
      return;
    }
    for (const file of result.attachments) {
      await props.onAdd?.(file);
    }
    const routeIssueId = /^\/issues\/([^/?#]+)$/u.exec(appHistory.read().pathname)?.[1];
    if (routeIssueId) {
      if (result.attachments.length > 1) {
        const merged = [...new Set([...props.files.map((f) => f.id), ...result.attachments.map((f) => f.id)])];
        await api.issue.update({ id: routeIssueId, attachments: merged });
      }
      await api.issue.comment.create({ id: routeIssueId, text: result.block, sendKey: newSendKey() });
    }
    compareOpen.set(false);
  };

  return (
    <If when={visible()}>
      <View testID="issue-attachments" accessibilityLabel={t("web.issue.attachments.title")}>
        <Lightbox pictures={pictures()} at={lightboxAt()} onAt={(at) => lightboxAt.set(at)} />
        <If when={props.editable === true}>
          <CompareUploadDialog open={compareOpen()} onClose={() => compareOpen.set(false)} onSubmit={handleAddCompare} />
        </If>
        <If
          when={hasItems()}
          else={
            <View class={`${props.first === true ? "mt-0" : "mt-4"} flex-row items-center gap-2`}>
              <Button size="compact" tone="quiet" icon="attach" testID="issue-attach-file" disabled={disabled()} onPress={() => void uploader.pick()}>
                {t("web.issue.attachments.attachFile")}
              </Button>
              <Button size="compact" tone="quiet" icon="diff" testID="issue-add-compare" disabled={disabled()} onPress={() => compareOpen.set(true)}>
                {t("web.base.compare.addAction")}
              </Button>
            </View>
          }
        >
          <View class={`${props.first === true ? "mt-0" : "mt-6"} mb-2 flex-row items-center justify-between gap-2`}>
            <View class="flex-row items-baseline gap-2">
              <Text class="text-xs font-semibold text-muted">{t("web.issue.attachments.title")}</Text>
              <If when={props.files.length > 0}>
                <Text testID="issue-attachments-count" class="text-xs text-muted tabular-nums">
                  {String(props.files.length)}
                </Text>
              </If>
            </View>
            <If when={props.editable === true}>
              <View class="flex-row items-center gap-1">
                <IconButton
                  icon="diff"
                  size={14}
                  label={t("web.base.compare.addAction")}
                  disabled={disabled()}
                  onClick={() => compareOpen.set(true)}
                  testid="issue-add-compare"
                />
                <IconButton
                  icon="attach"
                  size={14}
                  label={t("web.issue.attachments.attachFile")}
                  disabled={disabled()}
                  onClick={() => void uploader.pick()}
                  testid="issue-attach-file"
                />
              </View>
            </If>
          </View>
          <View class="flex-row flex-wrap items-start gap-2">
            <Each of={props.files} key={(f) => f.id}>
              {(f) => (
                <IssueAttachmentItem
                  file={f()}
                  editable={props.editable === true}
                  busy={disabled()}
                  onKnown={(path) => known.set(new Map(untracked(known)).set(f().id, path))}
                  onZoom={() => {
                    const idx = pictures().findIndex((p) => p.id === f().id);
                    if (idx >= 0) lightboxAt.set(idx);
                  }}
                  onRemove={props.editable === true && props.onRemove ? () => void props.onRemove?.(f().id) : undefined}
                />
              )}
            </Each>
            <Each of={uploader.uploading()} key={(u) => u.key}>
              {(u) => <UploadingChip name={u().name} />}
            </Each>
          </View>
        </If>
        <If when={uploader.error()}>
          {(err) => (
            <Text role="alert" testID="issue-attach-error" class="mt-2 text-xs text-berry">
              {t("web.issue.attachments.uploadFailed", { why: err() })}
            </Text>
          )}
        </If>
      </View>
    </If>
  );
}

function IssueAttachmentItem(props: {
  file: Attachment;
  editable: boolean;
  busy: boolean;
  onKnown: (path: string) => void;
  onZoom: () => void;
  onRemove?: (() => void) | undefined;
}) {
  const file = useAttachmentFile(() => props.file.id);
  const removeHover = signal(false);
  createEffect(
    () => file()?.path,
    (path) => {
      if (path !== undefined) props.onKnown(path);
    },
  );
  const kind = computed(() => fileKind(props.file.type));
  const imageSrc = computed(() => {
    const f = file();
    return kind() === "image" && f ? fileUrl(f.path) : undefined;
  });
  const open = () => void openAttachment(props.file.id).catch((e: unknown) => toast(reasonOf(e), "bad"));

  return (
    <If
      when={imageSrc()}
      else={
        <View
          testID="issue-attachment-item"
          class="group max-w-64 flex-row items-center gap-1.5 rounded-md border border-line bg-page p-1.5 pr-2 hover:border-faint"
        >
          <View
            role="button"
            testID={`issue-attachment-open-${props.file.id}`}
            accessibilityLabel={props.file.name}
            onPress={open}
            class="min-w-0 flex-1 flex-row items-center gap-2 rounded-sm hover:opacity-90"
          >
            <View class="h-8 w-8 shrink-0 items-center justify-center rounded-sm border border-line bg-side">
              <Icon name={kindIcon[kind()]} size={16} tone="muted" />
            </View>
            <View class="min-w-0 flex-1 gap-0.5">
              <Text class="truncate text-xs font-medium text-ink">{props.file.name}</Text>
              <Text class="truncate text-2xs text-muted tabular-nums">{kind() === "pdf" ? t("web.base.file.pdf") : sizeText(props.file.size)}</Text>
            </View>
          </View>
          <If when={props.editable && !props.busy ? props.onRemove : undefined}>
            {(remove) => (
              <View
                role="button"
                testID={`issue-attachment-remove-${props.file.id}`}
                accessibilityLabel={t("web.issue.attachments.remove", { name: props.file.name })}
                tooltip={<Bubble text={t("web.issue.attachments.remove", { name: props.file.name })} />}
                onMouseEnter={() => removeHover.set(true)}
                onMouseLeave={() => removeHover.set(false)}
                onPress={() => remove()()}
                class={`ml-auto size-6 shrink-0 items-center justify-center rounded-sm ${motionClass("transition-transform duration-120 ease-out")} hover:bg-bad-soft active:translate-y-px`}
              >
                <Icon name="close" size={12} tone={removeHover() ? "berry" : "muted"} />
              </View>
            )}
          </If>
        </View>
      }
    >
      {(src) => (
        <View testID="issue-attachment-item" class="relative w-32 overflow-hidden rounded-md border border-line bg-page hover:border-faint">
          <View
            role="button"
            testID={`issue-attachment-open-${props.file.id}`}
            accessibilityLabel={props.file.name}
            onPress={() => props.onZoom()}
            class="hover:opacity-90"
          >
            <Image testID="issue-attachment-thumb" src={src()} class="h-20 w-32 bg-side object-cover" />
            <View class="border-t border-line px-2 py-1">
              <Text class="truncate text-2xs font-medium text-ink">{props.file.name}</Text>
            </View>
          </View>
          <If when={props.editable && !props.busy ? props.onRemove : undefined}>
            {(remove) => (
              <View
                role="button"
                testID={`issue-attachment-remove-${props.file.id}`}
                accessibilityLabel={t("web.issue.attachments.remove", { name: props.file.name })}
                tooltip={<Bubble text={t("web.issue.attachments.remove", { name: props.file.name })} />}
                onMouseEnter={() => removeHover.set(true)}
                onMouseLeave={() => removeHover.set(false)}
                onPress={() => remove()()}
                class={`absolute top-1 right-1 size-5 items-center justify-center rounded-sm border border-line bg-elevated ${motionClass("transition-transform duration-120 ease-out")} hover:bg-bad-soft active:translate-y-px`}
              >
                <Icon name="close" size={11} tone={removeHover() ? "berry" : "muted"} />
              </View>
            )}
          </If>
        </View>
      )}
    </If>
  );
}
