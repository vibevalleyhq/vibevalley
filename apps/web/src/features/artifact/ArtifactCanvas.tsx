import * as stylex from "@stylexjs/stylex";
import { Show } from "solid-js";

import { t } from "@vibevalley/i18n";

import { reasonOf } from "#/infra/api.ts";
import { ready } from "#/infra/query.ts";
import { Icon } from "#/ui/Icon.tsx";

import { bodyIcon, bodyLabel, useArtifact } from "./ArtifactCard";
import { BlocksView, type QuoteTarget } from "./BlocksView";
import { HtmlFrame } from "./HtmlFrame";

const variantStyles = stylex.create({
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
    padding: "calc(var(--spacing) * 3)",
  },
});

const viewStyles = stylex.create({
  artifactCanvasHeader: {
    display: "flex",
    height: "66px",
    flexShrink: "0",
    alignItems: "center",
    gap: "calc(var(--spacing) * 2)",
    borderBottomStyle: "solid",
    borderBottomWidth: "1px",
    borderColor: "var(--color-line)",
    paddingInline: "calc(var(--spacing) * 3)",
  },
  artifactCanvasSpan: {
    display: "flex",
    width: "calc(var(--spacing) * 8)",
    height: "calc(var(--spacing) * 8)",
    flexShrink: "0",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: "var(--radius-md)",
    backgroundColor: "var(--color-hover)",
    color: "var(--color-muted)",
  },
  artifactCanvasSpan2: {
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    fontWeight: "var(--font-weight-semibold)",
  },
  artifactCanvasSpan3: {
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--color-muted)",
  },
  artifactCanvasPage: {
    borderRadius: "var(--radius-md)",
    paddingInline: "calc(var(--spacing) * 2)",
    paddingBlock: "var(--spacing)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
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
    width: "calc(var(--spacing) * 8)",
    height: "calc(var(--spacing) * 8)",
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
    padding: "calc(var(--spacing) * 3)",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
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
    padding: "calc(var(--spacing) * 3)",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
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
    <section
      aria-label={t("web.artifact.canvas.label")}
      data-testid="artifact-canvas"
      data-key={props.id}
      {...stylex.attrs(variantStyles.artifactCanvasSection)}
    >
      <header {...stylex.attrs(viewStyles.artifactCanvasHeader)}>
        <Show when={shown()}>
          {(a) => (
            <>
              <span {...stylex.attrs(viewStyles.artifactCanvasSpan)}>
                <Icon name={bodyIcon[a().body]} size={16} />
              </span>
              <span {...stylex.attrs(variantStyles.artifactCanvasSpan)}>
                <span {...stylex.attrs(viewStyles.artifactCanvasSpan2)}>{a().title}</span>
                <span {...stylex.attrs(viewStyles.artifactCanvasSpan3)}>
                  {bodyLabel[a().body]}
                  <Show when={a().body === "html"}> · {t("web.artifact.card.version", { version: props.version ?? a().version })}</Show>
                </span>
              </span>
            </>
          )}
        </Show>
        <a data-testid="artifact-canvas-page" href={pageHref()} {...stylex.attrs(viewStyles.artifactCanvasPage)}>
          {t("web.artifact.canvas.openPage")}
        </a>
        <Show when={props.onClose}>
          <button
            type="button"
            data-testid="artifact-canvas-close"
            aria-label={t("web.artifact.canvas.close")}
            title={t("web.artifact.canvas.close")}
            {...stylex.attrs(viewStyles.artifactCanvasClose)}
            onClick={() => props.onClose?.()}
          >
            <Icon name="close" size={16} />
          </button>
        </Show>
      </header>
      <Show when={artifact.error()}>
        <p {...stylex.attrs(viewStyles.artifactCanvasP)}>{reasonOf(artifact.error())}</p>
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
                frameStyle={viewStyles.artifactCanvasIframe}
              />
            }
          >
            <div {...stylex.attrs(variantStyles.artifactCanvasDiv)}>
              <BlocksView id={a().id} {...(props.onQuote ? { onQuote: props.onQuote } : {})} />
            </div>
          </Show>
        )}
      </Show>
      <Show when={artifact.status() === "success" && artifact.data() === undefined}>
        <p {...stylex.attrs(viewStyles.artifactCanvasP2)}>{t("web.artifact.page.gone")}</p>
      </Show>
    </section>
  );
}
