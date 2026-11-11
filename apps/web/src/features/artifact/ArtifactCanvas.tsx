import * as stylex from "@stylexjs/stylex";
import { Show } from "solid-js";

import { t } from "@vibevalley/i18n";

import { reasonOf } from "#/infra/api.ts";
import { ready } from "#/infra/query.ts";
import { Icon } from "#/ui/Icon.tsx";

import { bodyIcon, kindLabel, useArtifact } from "./ArtifactCard";
import { BlocksView, type QuoteTarget } from "./BlocksView";
import { HtmlFrame } from "./HtmlFrame";

const styles = stylex.create({
  artifactCanvasSection: {
    display: "flex",
    minHeight: "0",
    minWidth: "0",
    flex: "1",
    flexDirection: "column",
    borderLeftStyle: "solid",
    borderLeftWidth: "1px",
    borderColor: "var(--color-line)",
    backgroundColor: "var(--color-page)",
  },
  artifactCanvasSpan: {
    display: "flex",
    minWidth: "0",
    flex: "1",
    flexDirection: "column",
  },
  artifactCanvasDiv: {
    display: "flex",
    minHeight: "0",
    flex: "1",
    flexDirection: "column",
    padding: "0.75rem",
  },
  artifactCanvasHeader: {
    display: "flex",
    height: "66px",
    flexShrink: "0",
    alignItems: "center",
    gap: "0.5rem",
    borderBottomStyle: "solid",
    borderBottomWidth: "1px",
    borderColor: "var(--color-line)",
    paddingInline: "0.75rem",
  },
  artifactCanvasSpan2: {
    display: "flex",
    width: "2rem",
    height: "2rem",
    flexShrink: "0",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: "var(--radius-md)",
    backgroundColor: "var(--color-hover)",
    color: "var(--color-muted)",
  },
  artifactCanvasSpan22: {
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
    fontWeight: "var(--font-weight-semibold)",
  },
  artifactCanvasSpan3: {
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    color: "var(--color-muted)",
  },
  artifactCanvasPage: {
    borderRadius: "var(--radius-md)",
    paddingInline: "0.5rem",
    paddingBlock: "0.25rem",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    color: {
      default: "var(--color-muted)",
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-ink)",
      },
    },
    backgroundColor: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-hover)",
      },
    },
  },
  artifactCanvasClose: {
    display: "inline-flex",
    width: "2rem",
    height: "2rem",
    flexShrink: "0",
    cursor: "pointer",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: "var(--radius-md)",
    backgroundColor: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-hover)",
      },
    },
  },
  artifactCanvasP: {
    padding: "0.75rem",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
    color: "var(--color-berry)",
  },
  artifactCanvasIframe: {
    minHeight: "0",
    width: "100%",
    flex: "1",
    borderStyle: "solid",
    borderWidth: "0",
    backgroundColor: "var(--color-page)",
  },
  artifactCanvasP2: {
    padding: "0.75rem",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
    color: "var(--color-muted)",
  },
});

export function ArtifactCanvas(props: { id: string; version?: number | undefined; onClose?: () => void; onQuote?: (block: QuoteTarget) => void }) {
  const artifact = useArtifact(() => props.id);
  const shown = () => ready(artifact, undefined);
  const pageVersion = () => {
    const a = shown();
    return props.version ?? (a?.body === "html" ? a.version : undefined);
  };
  const pageHref = () => `/artifacts/${encodeURIComponent(props.id)}${(pageVersion() ?? 0) > 0 ? `?v=${pageVersion()}` : ""}`;
  return (
    <section aria-label={t("web.artifact.canvas.label")} data-testid="artifact-canvas" data-key={props.id} {...stylex.attrs(styles.artifactCanvasSection)}>
      <header {...stylex.attrs(styles.artifactCanvasHeader)}>
        <Show when={shown()}>
          {(a) => (
            <>
              <span {...stylex.attrs(styles.artifactCanvasSpan2)}>
                <Icon name={bodyIcon[a().body]} size={16} />
              </span>
              <span {...stylex.attrs(styles.artifactCanvasSpan)}>
                <span {...stylex.attrs(styles.artifactCanvasSpan22)}>{a().title}</span>
                <span {...stylex.attrs(styles.artifactCanvasSpan3)}>
                  {kindLabel(a())}
                  <Show when={a().body === "html"}> · {t("web.artifact.card.version", { version: props.version ?? a().version })}</Show>
                </span>
              </span>
            </>
          )}
        </Show>
        <a data-testid="artifact-canvas-page" href={pageHref()} {...stylex.attrs(styles.artifactCanvasPage)}>
          {t("web.artifact.canvas.openPage")}
        </a>
        <Show when={props.onClose}>
          <button
            type="button"
            data-testid="artifact-canvas-close"
            aria-label={t("web.artifact.canvas.close")}
            title={t("web.artifact.canvas.close")}
            {...stylex.attrs(styles.artifactCanvasClose)}
            onClick={() => props.onClose?.()}
          >
            <Icon name="close" size={16} />
          </button>
        </Show>
      </header>
      <Show when={artifact.error()}>
        <p {...stylex.attrs(styles.artifactCanvasP)}>{reasonOf(artifact.error())}</p>
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
                frameStyle={styles.artifactCanvasIframe}
              />
            }
          >
            <div {...stylex.attrs(styles.artifactCanvasDiv)}>
              <BlocksView id={a().id} {...(props.onQuote ? { onQuote: props.onQuote } : {})} />
            </div>
          </Show>
        )}
      </Show>
      <Show when={artifact.status() === "success" && artifact.data() === undefined}>
        <p {...stylex.attrs(styles.artifactCanvasP2)}>{t("web.artifact.page.gone")}</p>
      </Show>
    </section>
  );
}
