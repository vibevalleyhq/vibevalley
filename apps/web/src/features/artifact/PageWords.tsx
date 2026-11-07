import { createSignal, onSettled, Show } from "solid-js";

import { t } from "@vibevalley/i18n";
import type { Artifact, HtmlAnchor } from "@vibevalley/protocol";

import { api } from "#/infra/api.ts";
import { useQueryClient } from "#/infra/query.ts";
import { useRouter } from "#/infra/router.ts";
import { createAct } from "#/ui/act.ts";
import { Button } from "#/ui/Button.tsx";
import { TextArea } from "#/ui/Field.tsx";
import { toast } from "#/ui/toasts.ts";

import { artifactHref } from "./ArtifactCard";
import { selectionOf } from "./shell";

/** One version's frame: made again when another version is shown, so the words picked are always this version's. */
export function PageWords(props: { artifact: Artifact; version: number; frame: HTMLIFrameElement }) {
  const queries = useQueryClient();
  const router = useRouter();
  const [picked, setPicked] = createSignal<HtmlAnchor>();
  const [text, setText] = createSignal("");
  onSettled(() => {
    const heard = (e: MessageEvent) => {
      if (e.source !== props.frame.contentWindow) return;
      const anchor = selectionOf(e.data);
      if (!anchor) return;
      setPicked(anchor);
      setText(anchor.exact.trim());
    };
    window.addEventListener("message", heard);
    return () => window.removeEventListener("message", heard);
  });
  const latest = () => props.version === props.artifact.version;
  const act = createAct();
  const save = async () => {
    const anchor = picked();
    const words = text();
    if (!anchor || act.busy()) return;
    const { id } = props.artifact;
    const version = props.version;
    const made = await act.run(() => api.artifact.html.edit({ id, version, anchor, text: words }));
    if (!made) return;
    setPicked(undefined);
    void queries.invalidate({ prefix: ["artifacts"] });
    router.navigate(artifactHref(id), { replace: true });
    toast(t("web.artifact.edit.saved", { version: made.version }));
  };
  return (
    <Show when={picked()}>
      <div data-testid="artifact-words" class="flex flex-col gap-1.5">
        <h2 class="text-xs font-semibold text-muted">{t("web.artifact.edit.title")}</h2>
        <Show when={latest() ? picked() : undefined} fallback={<p class="text-xs text-faint">{t("web.artifact.edit.older")}</p>}>
          {(p) => (
            <>
              <blockquote data-testid="artifact-words-quote" class="line-clamp-3 border-l-2 border-wheat pl-2 text-xs text-muted">
                {p().exact.trim()}
              </blockquote>
              <TextArea
                data-testid="artifact-words-text"
                aria-label={t("web.artifact.edit.to")}
                rows={3}
                value={text()}
                onInput={(e) => setText(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void save();
                  if (e.key === "Escape") setPicked(undefined);
                }}
              />
              <div class="flex items-center justify-end gap-2">
                <Button onClick={() => setPicked(undefined)}>{t("web.base.form.never")}</Button>
                <Button tone="primary" data-testid="artifact-words-save" disabled={act.busy()} onClick={() => void save()}>
                  {t("web.artifact.edit.save")}
                </Button>
              </div>
            </>
          )}
        </Show>
      </div>
    </Show>
  );
}
