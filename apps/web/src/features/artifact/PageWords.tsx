import * as stylex from "@stylexjs/stylex";
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

const styles = stylex.create({
  pageWordsBlockquote: {
    WebkitLineClamp: "3",
    WebkitBoxOrient: "vertical",
    display: "-webkit-box",
    overflow: "hidden",
    borderLeftStyle: "solid",
    borderLeftWidth: "2px",
    borderColor: "var(--color-wheat)",
    paddingLeft: "0.5rem",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    color: "var(--color-muted)",
  },
  artifactWords: {
    display: "flex",
    flexDirection: "column",
    gap: "0.375rem",
  },
  pageWordsH2: {
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    fontWeight: "var(--font-weight-semibold)",
    color: "var(--color-muted)",
  },
  pageWordsP: {
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    color: "var(--color-faint)",
  },
  pageWordsDiv: {
    display: "flex",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: "0.5rem",
  },
});

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
      <div data-testid="artifact-words" {...stylex.attrs(styles.artifactWords)}>
        <h2 {...stylex.attrs(styles.pageWordsH2)}>{t("web.artifact.edit.title")}</h2>
        <Show when={latest() ? picked() : undefined} fallback={<p {...stylex.attrs(styles.pageWordsP)}>{t("web.artifact.edit.older")}</p>}>
          {(p) => (
            <>
              <blockquote data-testid="artifact-words-quote" {...stylex.attrs(styles.pageWordsBlockquote)}>
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
              <div {...stylex.attrs(styles.pageWordsDiv)}>
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
