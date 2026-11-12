import { Show } from "solid-js";

import { t } from "@vibevalley/i18n";

import { reasonOf } from "#/infra/api.ts";
import { ready } from "#/infra/query.ts";
import { Icon } from "#/ui/Icon.tsx";

import { bodyIcon, kindLabel, useArtifact } from "./ArtifactCard";
import { BlocksView, type QuoteTarget } from "./BlocksView";
import { HtmlFrame } from "./HtmlFrame";

export function ArtifactCanvas(props: { id: string; version?: number | undefined; onClose?: () => void; onQuote?: (block: QuoteTarget) => void }) {
  const artifact = useArtifact(() => props.id);
  const shown = () => ready(artifact, undefined);
  const pageVersion = () => {
    const a = shown();
    return props.version ?? (a?.body === "html" ? a.version : undefined);
  };
  const pageHref = () => `/artifacts/${encodeURIComponent(props.id)}${(pageVersion() ?? 0) > 0 ? `?v=${pageVersion()}` : ""}`;
  return (
    <section
      aria-label={t("web.artifact.canvas.label")}
      data-testid="artifact-canvas"
      data-key={props.id}
      class="flex min-h-0 min-w-0 flex-1 flex-col border-l border-line bg-page"
    >
      <header class="flex h-16.5 shrink-0 items-center gap-2 border-b border-line px-3">
        <Show when={shown()}>
          {(a) => (
            <>
              <span class="flex w-8 h-8 shrink-0 items-center justify-center rounded-md bg-hover text-muted">
                <Icon name={bodyIcon[a().body]} size={16} />
              </span>
              <span class="flex min-w-0 flex-1 flex-col">
                <span class="truncate text-sm font-semibold">{a().title}</span>
                <span class="truncate text-xs text-muted">
                  {kindLabel(a())}
                  <Show when={a().body === "html"}> · {t("web.artifact.card.version", { version: props.version ?? a().version })}</Show>
                </span>
              </span>
            </>
          )}
        </Show>
        <a data-testid="artifact-canvas-page" href={pageHref()} class="rounded-md px-2 py-1 text-xs text-muted hover:text-ink hover:bg-hover">
          {t("web.artifact.canvas.openPage")}
        </a>
        <Show when={props.onClose}>
          <button
            type="button"
            data-testid="artifact-canvas-close"
            aria-label={t("web.artifact.canvas.close")}
            title={t("web.artifact.canvas.close")}
            class="inline-flex w-8 h-8 shrink-0 cursor-pointer items-center justify-center rounded-md hover:bg-hover"
            onClick={() => props.onClose?.()}
          >
            <Icon name="close" size={16} />
          </button>
        </Show>
      </header>
      <Show when={artifact.error()}>
        <p class="p-3 text-sm text-berry">{reasonOf(artifact.error())}</p>
      </Show>
      <Show when={shown()}>
        {(a) => (
          <Show
            when={a().body === "blocks"}
            fallback={
              <HtmlFrame
                artifact={a()}
                version={props.version ?? a().version}
                title={t("web.artifact.page.frame", { title: a().title, version: props.version ?? a().version })}
                testId="artifact-canvas-frame"
                frameStyle={"min-h-0 w-full flex-1 border-0 bg-page"}
              />
            }
          >
            <div class="flex min-h-0 flex-1 flex-col p-3">
              <BlocksView id={a().id} {...(props.onQuote ? { onQuote: props.onQuote } : {})} />
            </div>
          </Show>
        )}
      </Show>
      <Show when={artifact.status() === "success" && artifact.data() === undefined}>
        <p class="p-3 text-sm text-muted">{t("web.artifact.page.gone")}</p>
      </Show>
    </section>
  );
}
