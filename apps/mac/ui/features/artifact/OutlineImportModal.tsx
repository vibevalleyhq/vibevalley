import { computed, signal, Text, untracked, View } from "nsh";

import { t } from "@vibevalley/i18n";
import type { Artifact, VibeValleyApi } from "@vibevalley/protocol";

import { createAct } from "../../design/act";
import { Button } from "../../design/Button";
import { Dialog } from "../../design/Dialog";
import { Field, TextArea, TextInput } from "../../design/Field";
import { Icon } from "../../design/Icon";
import { Banner } from "../../design/layout";
import { toast } from "../../design/toasts";
import { api } from "../../infra/api";
import { hostApi } from "../../infra/bridge";
import { type QueryClient, useQueryClient } from "../../infra/query";
import { useRouter } from "../../infra/router";
import type { RouterController } from "../../infra/router/context";
import { defineAtom } from "../../infra/state/atom";
import { artifactHref } from "./ArtifactCard";

const outlineImportOpen = defineAtom<boolean>(false);

export function openOutlineImport(): void {
  outlineImportOpen.set(true);
}

function closeOutlineImport(): void {
  outlineImportOpen.set(false);
}

export function decodeBase64Utf8(b64: string): string {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

async function importOutlineMarkdown(deps: {
  readonly api: Pick<VibeValleyApi, "artifact">;
  readonly queries: QueryClient;
  readonly router: RouterController;
  readonly markdown: string;
  readonly title?: string | undefined;
  readonly filename?: string | undefined;
}): Promise<Artifact> {
  const title = deps.title?.trim();
  const filename = deps.filename?.trim();
  const created = await deps.api.artifact.outline.import({
    markdown: deps.markdown,
    ...(title ? { title } : {}),
    ...(filename ? { filename } : {}),
  });
  await deps.queries.invalidate({ prefix: ["artifacts"] });
  deps.router.navigate(artifactHref(created.id));
  return created;
}

export function OutlineImportModal() {
  return (
    <Dialog open={outlineImportOpen.get()} onClose={closeOutlineImport} title={t("web.artifact.outline.importTitle")} wide testid="outline-import-modal">
      <If when={outlineImportOpen.get()}>
        <OutlineImportBody />
      </If>
    </Dialog>
  );
}

function OutlineImportBody() {
  const queries = useQueryClient();
  const router = useRouter();
  const title = signal("");
  const filename = signal<string | undefined>(undefined);
  const markdown = signal("");
  const error = signal<string | undefined>(undefined);
  const act = createAct((reason) => error.set(reason));

  const loadFromPath = (path: string, fallbackName?: string) =>
    act.run(async () => {
      error.set(undefined);
      const res = await hostApi.readFile(path);
      if (res.bizCode !== 0 || !res.data) {
        error.set(res.message);
        return;
      }
      const name = res.data.name || fallbackName || path.split("/").pop() || "note.md";
      filename.set(name);
      markdown.set(decodeBase64Utf8(res.data.data));
    });

  const pickMarkdownFile = () =>
    act.run(async () => {
      error.set(undefined);
      const picked = await hostApi.pickFile();
      if (picked.bizCode !== 0) {
        error.set(picked.message);
        return;
      }
      if (!picked.data) return;
      const res = await hostApi.readFile(picked.data.path);
      if (res.bizCode !== 0 || !res.data) {
        error.set(res.message);
        return;
      }
      filename.set(res.data.name || picked.data.name);
      markdown.set(decodeBase64Utf8(res.data.data));
    });

  const canSubmit = computed(() => !act.busy() && markdown().trim().length > 0);
  const titlePlaceholder = computed(() => filename()?.replace(/\.(?:outline\.md|md|markdown)$/iu, "") ?? t("web.library.content.artifactType.outline"));

  const submit = () => {
    const raw = untracked(markdown);
    if (raw.trim().length === 0 || act.busy()) return;
    error.set(undefined);
    void act.run(async () => {
      const created = await importOutlineMarkdown({
        api,
        queries,
        router,
        markdown: raw,
        title: untracked(title),
        filename: untracked(filename),
      });
      closeOutlineImport();
      toast(created.title);
    });
  };

  return (
    <View
      class="gap-3.5"
      onFileDrop={(e) => {
        const first = e.uris[0];
        if (first) void loadFromPath(first);
      }}
    >
      <View class="flex-row flex-wrap items-center gap-2">
        <Button icon="upload" testID="outline-import-pick-file" disabled={act.busy()} onPress={() => void pickMarkdownFile()}>
          {t("web.artifact.outline.pickFile")}
        </Button>
        <If when={filename()}>
          {(name) => (
            <View testID="outline-import-filename" class="h-7 flex-row items-center gap-1.5 rounded-md border border-line bg-side px-2.5">
              <Icon name="file" size={12} tone="muted" />
              <Text class="font-mono text-xs text-ink">{name()}</Text>
            </View>
          )}
        </If>
      </View>

      <Field label={t("web.artifact.page.title")}>
        <TextInput
          testID="outline-import-title"
          accessibilityLabel={t("web.artifact.page.title")}
          value={title()}
          onInput={(v) => title.set(v)}
          placeholder={titlePlaceholder()}
        />
      </Field>

      <Field label={t("web.artifact.outline.markdownLabel")}>
        <TextArea
          testID="outline-import-markdown"
          accessibilityLabel={t("web.artifact.outline.markdownLabel")}
          rows={10}
          value={markdown()}
          onInput={(v) => markdown.set(v)}
          placeholder={t("web.artifact.blocks.start")}
        />
      </Field>

      <If when={error()}>
        {(why) => (
          <Banner testID="outline-import-error" role="alert">
            {why()}
          </Banner>
        )}
      </If>

      <View class="flex-row items-center justify-end gap-2 border-t border-line pt-3">
        <Button testID="outline-import-cancel" disabled={act.busy()} onPress={closeOutlineImport}>
          {t("web.base.form.never")}
        </Button>
        <Button tone="primary" icon="upload" testID="outline-import-submit" disabled={!canSubmit()} onPress={submit}>
          {t("web.artifact.outline.submit")}
        </Button>
      </View>
    </View>
  );
}
