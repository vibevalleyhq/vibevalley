import { computed, effect, Image, Picker, signal, Text, untracked, View } from "nsh";

import { t } from "@vibevalley/i18n";
import type { Attachment } from "@vibevalley/protocol";

import { Button } from "../Button";
import { formatCompareBlock, type CompareAnnotation, type CompareAnnotationSide, type CompareAnnotationTone, type CompareSpec } from "../compareModel";
import { Dialog } from "../Dialog";
import { Field, Select, TextInput } from "../Field";
import { useDesignAttachmentUrl, useDesignHost } from "../host";
import { Icon } from "../Icon";
import { IconButton } from "../IconButton";
import { readFiles } from "../picked";
import { toast } from "../toasts";
import { defaultAnnotationRect } from "./shared";

export interface CompareUploadResult {
  readonly spec: CompareSpec;
  readonly block: string;
  readonly attachments: readonly Attachment[];
}

interface CompareUploadDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onSubmit: (result: CompareUploadResult) => void | Promise<void>;
  readonly testid?: string | undefined;
}

interface DraftAnnotationRow {
  readonly id: number;
  readonly side: CompareAnnotationSide;
  readonly tone: CompareAnnotationTone;
  readonly note: string;
}

function UploadSlot(props: {
  readonly side: "before" | "after";
  readonly title: string;
  readonly attachment: Attachment | undefined;
  readonly uploading: boolean;
  readonly onPick: () => void;
  readonly onDropUri: (uri: string) => void;
  readonly onClear: () => void;
}) {
  const dragOver = signal(false);
  const thumbUrl = useDesignAttachmentUrl(() => props.attachment?.id ?? "");

  return (
    <View
      testID={`compare-slot-${props.side}`}
      onFileDragEnter={() => dragOver.set(true)}
      onFileDragLeave={() => dragOver.set(false)}
      onFileDrop={(e) => {
        dragOver.set(false);
        const uri = e.uris[0];
        if (uri !== undefined) props.onDropUri(uri);
      }}
      class="min-w-0 flex-1 gap-1.5"
    >
      <View class="flex-row items-center justify-between gap-2">
        <Text class="text-xs font-medium text-muted">{props.title}</Text>
        <If when={props.attachment !== undefined}>
          <View class="flex-row items-center gap-0.5">
            <IconButton
              icon="upload"
              size={12}
              label={t("web.base.compare.replace")}
              disabled={props.uploading}
              onClick={() => props.onPick()}
              testid={`compare-replace-${props.side}`}
            />
            <IconButton
              icon="close"
              size={12}
              label={t("web.base.compare.clear")}
              disabled={props.uploading}
              onClick={() => props.onClear()}
              testid={`compare-clear-${props.side}`}
            />
          </View>
        </If>
      </View>

      <If
        when={props.attachment}
        else={
          <View
            role="button"
            testID={`compare-pick-${props.side}`}
            accessibilityLabel={props.title}
            disabled={props.uploading}
            onPress={() => props.onPick()}
            class={`h-36 items-center justify-center gap-1.5 rounded-md border border-dashed px-3 ${
              dragOver() ? "border-accent bg-selected" : "border-line bg-side hover:border-faint hover:bg-hover"
            } ${props.uploading ? "opacity-50" : ""}`}
          >
            <Icon name="image" size={20} tone={dragOver() ? "accent" : "muted"} />
            <Text class="text-xs font-medium text-ink">{props.uploading ? t("web.base.compare.uploading") : t("web.base.compare.pickHint")}</Text>
          </View>
        }
      >
        {(att) => (
          <View class="overflow-hidden rounded-md border border-line bg-page">
            <View class="h-28 w-full items-center justify-center bg-side">
              <If when={thumbUrl()} else={<Icon name="image" size={20} tone="muted" />}>
                {(src) => (
                  <Image testID={`compare-slot-thumb-${props.side}`} src={src()} accessibilityLabel={att().name} class="h-full w-full object-contain" />
                )}
              </If>
            </View>
            <View class="border-t border-line px-2 py-1">
              <Text testID={`compare-slot-name-${props.side}`} class="truncate text-2xs font-medium text-ink">
                {att().name}
              </Text>
            </View>
          </View>
        )}
      </If>
    </View>
  );
}

/** Modal dialog for uploading Before/After images and optional annotations into a ` ```compare ` block. */
export function CompareUploadDialog(props: CompareUploadDialogProps) {
  const designHost = useDesignHost();
  const title = signal("");
  const before = signal<Attachment | undefined>(undefined);
  const after = signal<Attachment | undefined>(undefined);
  const uploadingBefore = signal(false);
  const uploadingAfter = signal(false);
  const submitting = signal(false);
  const error = signal<string | undefined>(undefined);
  const rows = signal<readonly DraftAnnotationRow[]>([]);
  let nextRowId = 1;

  effect(() => {
    if (!props.open) return;
    title.set("");
    before.set(undefined);
    after.set(undefined);
    uploadingBefore.set(false);
    uploadingAfter.set(false);
    submitting.set(false);
    error.set(undefined);
    rows.set([]);
  });

  const setSlot = (side: "before" | "after", att: Attachment | undefined) => {
    if (side === "before") before.set(att);
    else after.set(att);
  };
  const setUploading = (side: "before" | "after", busy: boolean) => {
    if (side === "before") uploadingBefore.set(busy);
    else uploadingAfter.set(busy);
  };

  const uploadPickedFile = async (side: "before" | "after") => {
    const picked = await Picker.pickFiles({ multiple: false });
    const files = readFiles(picked);
    const file = files.at(0);
    if (file === undefined) return;
    setUploading(side, true);
    error.set(undefined);
    try {
      const made = await designHost.uploadAttachmentBlob(file, `${side}.png`);
      setSlot(side, made);
    } catch (e: unknown) {
      const reason = designHost.formatError(e);
      error.set(reason);
      toast(t("web.base.compare.uploadFailed", { why: reason }), "bad");
    } finally {
      setUploading(side, false);
    }
  };

  const uploadDroppedUri = async (side: "before" | "after", uri: string) => {
    setUploading(side, true);
    error.set(undefined);
    try {
      const made = await designHost.importLocalAttachment(uri);
      setSlot(side, made);
    } catch (e: unknown) {
      const reason = designHost.formatError(e);
      error.set(reason);
      toast(t("web.base.compare.uploadFailed", { why: reason }), "bad");
    } finally {
      setUploading(side, false);
    }
  };

  const addAnnotationRow = () => {
    rows.set([...untracked(rows), { id: nextRowId++, side: "both", tone: "note", note: "" }]);
  };

  const updateRow = (id: number, patch: Partial<Omit<DraftAnnotationRow, "id">>) => {
    rows.set(untracked(rows).map((r) => (r.id === id ? { ...r, ...patch } : r)));
  };

  const removeRow = (id: number) => {
    rows.set(untracked(rows).filter((r) => r.id !== id));
  };

  const busy = computed(() => uploadingBefore() || uploadingAfter() || submitting());
  const canSubmit = computed(() => !busy() && (before() !== undefined || after() !== undefined));

  const toneOptions = computed(() => [
    { value: "issue" as const, label: t("web.base.compare.toneIssue") },
    { value: "fixed" as const, label: t("web.base.compare.toneFixed") },
    { value: "note" as const, label: t("web.base.compare.toneNote") },
  ]);

  const sideOptions = computed(() => [
    { value: "both" as const, label: t("web.base.compare.sideBoth") },
    { value: "before" as const, label: t("web.base.compare.before") },
    { value: "after" as const, label: t("web.base.compare.after") },
  ]);

  const submit = async () => {
    const b = untracked(before);
    const a = untracked(after);
    if (!b && !a) return;
    submitting.set(true);
    error.set(undefined);
    try {
      const cleanTitle = untracked(title).trim();
      const nonEmptyAnnotations: CompareAnnotation[] = untracked(rows)
        .map((r) => ({ ...r, note: r.note.trim() }))
        .filter((r) => r.note !== "")
        .map((r, idx) => ({
          n: idx + 1,
          ...(b && a ? { side: r.side } : {}),
          rect: defaultAnnotationRect(idx),
          tone: r.tone,
          note: r.note,
        }));

      const spec: CompareSpec =
        b && a
          ? {
              ...(cleanTitle !== "" ? { title: cleanTitle } : {}),
              before: { attachment: b.id },
              after: { attachment: a.id },
              ...(nonEmptyAnnotations.length > 0 ? { annotations: nonEmptyAnnotations } : {}),
            }
          : {
              ...(cleanTitle !== "" ? { title: cleanTitle } : {}),
              image: {
                attachment: (b ?? a)!.id,
                label: b ? t("web.base.compare.before") : t("web.base.compare.after"),
              },
              ...(nonEmptyAnnotations.length > 0 ? { annotations: nonEmptyAnnotations } : {}),
            };

      const attachments: Attachment[] = [];
      if (b) attachments.push(b);
      if (a && a.id !== b?.id) attachments.push(a);

      await props.onSubmit({ spec, block: formatCompareBlock(spec), attachments });
    } catch (e: unknown) {
      const reason = designHost.formatError(e);
      error.set(reason);
      toast(reason, "bad");
    } finally {
      submitting.set(false);
    }
  };

  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      title={t("web.base.compare.dialogTitle")}
      size="md"
      testid={props.testid ?? "compare-upload-dialog"}
      footer={
        <View class="flex-row items-center justify-end gap-2">
          <Button testID="compare-upload-cancel" tone="plain" disabled={submitting()} onPress={() => props.onClose()}>
            {t("web.base.compare.cancel")}
          </Button>
          <Button testID="compare-upload-submit" tone="primary" icon="diff" disabled={!canSubmit()} onPress={() => void submit()}>
            {t("web.base.compare.submit")}
          </Button>
        </View>
      }
    >
      <View class="gap-4">
        <Field label={t("web.base.compare.titleLabel")}>
          <TextInput
            testID="compare-upload-title"
            value={title()}
            placeholder={t("web.base.compare.titlePlaceholder")}
            accessibilityLabel={t("web.base.compare.titleLabel")}
            onInput={(v) => title.set(v)}
          />
        </Field>

        <View class="flex-row gap-3">
          <UploadSlot
            side="before"
            title={t("web.base.compare.before")}
            attachment={before()}
            uploading={uploadingBefore()}
            onPick={() => void uploadPickedFile("before")}
            onDropUri={(uri) => void uploadDroppedUri("before", uri)}
            onClear={() => before.set(undefined)}
          />
          <UploadSlot
            side="after"
            title={t("web.base.compare.after")}
            attachment={after()}
            uploading={uploadingAfter()}
            onPick={() => void uploadPickedFile("after")}
            onDropUri={(uri) => void uploadDroppedUri("after", uri)}
            onClear={() => after.set(undefined)}
          />
        </View>

        <If when={error()}>
          {(err) => (
            <Text role="alert" testID="compare-upload-error" class="text-xs text-berry">
              {t("web.base.compare.uploadFailed", { why: err() })}
            </Text>
          )}
        </If>

        <View class="gap-2 border-t border-line pt-3">
          <View class="flex-row items-center justify-between gap-2">
            <Text class="text-xs font-medium text-muted">{t("web.base.compare.annotations")}</Text>
            <Button size="compact" tone="quiet" icon="add" testID="compare-add-annotation" onPress={addAnnotationRow}>
              {t("web.base.compare.addAnnotation")}
            </Button>
          </View>
          <If when={rows().length > 0}>
            <View class="gap-2">
              <Each of={rows()} key={(r) => r.id}>
                {(row, i) => (
                  <View testID={`compare-draft-annotation-${i() + 1}`} class="flex-row items-center gap-1.5">
                    <Text class="w-6 shrink-0 font-mono text-xs text-muted tabular-nums">{`#${i() + 1}`}</Text>
                    <Select
                      testid={`compare-draft-tone-${i() + 1}`}
                      size="control"
                      text="xs"
                      class="w-24 shrink-0"
                      label={t("web.base.compare.toneLabel")}
                      value={row().tone}
                      options={toneOptions()}
                      onChange={(next) => updateRow(row().id, { tone: next })}
                    />
                    <Select
                      testid={`compare-draft-side-${i() + 1}`}
                      size="control"
                      text="xs"
                      class="w-20 shrink-0"
                      label={t("web.base.compare.sideLabel")}
                      value={row().side}
                      options={sideOptions()}
                      onChange={(next) => updateRow(row().id, { side: next })}
                    />
                    <TextInput
                      testID={`compare-draft-note-${i() + 1}`}
                      class="h-7 min-w-0 flex-1"
                      wide={false}
                      value={row().note}
                      placeholder={t("web.base.compare.annotationNotePlaceholder")}
                      accessibilityLabel={t("web.base.compare.annotationNote")}
                      onInput={(v) => updateRow(row().id, { note: v })}
                    />
                    <IconButton
                      icon="delete"
                      size={12}
                      label={t("web.base.compare.removeAnnotation")}
                      onClick={() => removeRow(row().id)}
                      testid={`compare-draft-remove-${i() + 1}`}
                    />
                  </View>
                )}
              </Each>
            </View>
          </If>
        </View>
      </View>
    </Dialog>
  );
}
