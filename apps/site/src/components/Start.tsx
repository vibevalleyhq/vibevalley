/** @jsxImportSource @solidjs/web */
import * as stylex from "@stylexjs/stylex";
import { steps } from "motion";
import { createSignal, onCleanup } from "solid-js";

import { Presence } from "../animation/Presence";
import { createReveal } from "../animation/scroll";
import type { Copy } from "../i18n/zh";
import { colors, fonts, leading, media, text } from "../styles/tokens.stylex";
import { Section } from "./ui";

const styles = stylex.create({
  warningBanner: {
    display: "flex",
    alignItems: "flex-start",
    gap: "1.25rem",
    borderStyle: "solid",
    borderWidth: "2px",
    borderColor: colors.bark,
    backgroundColor: colors.warn,
    boxShadow: "inset 0 0 0 2px var(--color-rim), 4px 4px 0 var(--color-drop)",
    padding: "1.5rem",
  },
  warningIcon: {
    width: "3rem",
    height: "3rem",
    flex: "none",
    objectFit: "contain",
    imageRendering: "pixelated",
  },
  warningTitle: {
    marginBottom: "0.375rem",
    fontSize: text["2xl"],
    lineHeight: leading["2xl"],
    color: colors.berry,
  },
  bodyText: {
    fontSize: text.base,
    lineHeight: leading.base,
  },
  followupText: {
    marginTop: "0.5rem",
    fontSize: text.base,
    lineHeight: leading.base,
  },
  columns: {
    marginTop: "1.75rem",
    display: "grid",
    gridTemplateColumns: {
      default: "minmax(0, 1fr)",
      [media.lg]: "minmax(0, 1fr) minmax(0, 1.3fr)",
    },
    alignItems: "flex-start",
    gap: "1.75rem",
  },
  card: {
    borderStyle: "solid",
    borderWidth: "2px",
    borderColor: colors.bark,
    backgroundColor: colors.creamSoft,
    boxShadow: "inset 0 0 0 2px var(--color-rim), 4px 4px 0 var(--color-drop)",
    padding: "1.5rem",
  },
  cardTitle: {
    fontSize: text["2xl"],
    lineHeight: leading["2xl"],
  },
  checklist: {
    marginTop: "0.75rem",
  },
  checklistItem: {
    display: "flex",
    alignItems: "flex-start",
    gap: "0.625rem",
    paddingBlock: "0.375rem",
    fontSize: text.base,
    lineHeight: leading.base,
  },
  checkIcon: {
    marginTop: "5px",
    width: "1.25rem",
    height: "1.25rem",
    flex: "none",
    objectFit: "contain",
    imageRendering: "pixelated",
  },
  cardHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "0.75rem",
  },
  commandBlock: {
    marginTop: "0.875rem",
    overflowX: "auto",
    borderStyle: "solid",
    borderWidth: "2px",
    borderColor: colors.bark,
    backgroundColor: colors.bark,
    paddingInline: "1.25rem",
    paddingBlock: "18px",
    fontFamily: fonts.mono,
    fontSize: text.sm,
    lineHeight: "1.8",
    color: colors.creamSoft,
    boxShadow: "inset 0 0 0 2px var(--color-bark-600)",
  },
  commandLine: {
    display: "block",
  },
  promptPrefix: {
    color: colors.wheat,
    WebkitUserSelect: "none",
    userSelect: "none",
  },
  readmeNote: {
    marginTop: "0.875rem",
    fontSize: "15px",
    color: "var(--color-bark-800)",
  },
  readmeLink: {
    textDecorationLine: "underline",
  },
  copyButton: {
    display: "inline-flex",
    height: "2rem",
    cursor: "pointer",
    alignItems: "center",
    overflow: "hidden",
    borderStyle: "solid",
    borderWidth: "2px",
    borderColor: colors.bark,
    backgroundColor: {
      default: colors.creamSoft,
      [media.hover]: {
        default: null,
        ":hover": colors.creamHover,
      },
    },
    paddingInline: "0.5rem",
    fontFamily: fonts.pixel,
    fontSize: text.sm,
    lineHeight: "1",
    color: colors.bark,
  },
  copyLabel: {
    display: "inline-flex",
    alignItems: "center",
    gap: "0.375rem",
  },
  copyIcon: {
    width: "1rem",
    height: "1rem",
    objectFit: "contain",
    imageRendering: "pixelated",
  },
  srOnly: {
    clipPath: "inset(50%)",
    whiteSpace: "nowrap",
    borderWidth: "0",
    width: "1px",
    height: "1px",
    margin: "-1px",
    padding: "0",
    position: "absolute",
    overflow: "hidden",
  },
});

interface Props {
  copy: Pick<Copy, "start" | "safety">;
  commands: string[];
  readme: string;
  icons: {
    warn: string;
    check: string;
    copy: string;
  };
}
export default function Start(props: Props) {
  const root = createReveal<HTMLElement>();
  return (
    <>
      <Section ref={root.set} id="start" alt title={props.copy.start.title}>
        <div data-reveal role="note" {...stylex.attrs(styles.warningBanner)}>
          <img loading="lazy" src={props.icons.warn} alt="" {...stylex.attrs(styles.warningIcon)} />
          <div>
            <h3 {...stylex.attrs(styles.warningTitle)}>{props.copy.safety.title}</h3>
            <p {...stylex.attrs(styles.bodyText)}>{props.copy.safety.text}</p>
            <p {...stylex.attrs(styles.followupText)}>{props.copy.safety.wip}</p>
          </div>
        </div>
        <div {...stylex.attrs(styles.columns)}>
          <div data-reveal {...stylex.attrs(styles.card)}>
            <h3 {...stylex.attrs(styles.cardTitle)}>{props.copy.start.needs}</h3>
            <ul {...stylex.attrs(styles.checklist)}>
              {props.copy.start.list.map((item) => (
                <li {...stylex.attrs(styles.checklistItem)}>
                  <img loading="lazy" src={props.icons.check} alt="" {...stylex.attrs(styles.checkIcon)} />
                  {item}
                </li>
              ))}
            </ul>
          </div>
          <div data-reveal {...stylex.attrs(styles.card)}>
            <div {...stylex.attrs(styles.cardHeader)}>
              <h3 {...stylex.attrs(styles.cardTitle)}>{props.copy.start.build}</h3>
              <CopyButton
                text={props.commands.join("\n")}
                icon={props.icons.copy}
                check={props.icons.check}
                label={props.copy.start.copy}
                done={props.copy.start.copied}
              />
            </div>
            <pre {...stylex.attrs(styles.commandBlock)}>
              {props.commands.map((c) => (
                <span {...stylex.attrs(styles.commandLine)}>
                  <span {...stylex.attrs(styles.promptPrefix)}>$ </span>
                  {c}
                </span>
              ))}
            </pre>
            <p {...stylex.attrs(styles.readmeNote)}>
              {props.copy.start.more}{" "}
              <a href={props.readme} {...stylex.attrs(styles.readmeLink)}>
                {props.copy.start.readme}
              </a>
            </p>
          </div>
        </div>
      </Section>
    </>
  );
}
function CopyButton(props: { text: string; icon: string; check: string; label: string; done: string }) {
  const [copied, setCopied] = createSignal(false);
  let timer = 0;
  let disposed = false;
  onCleanup(() => {
    disposed = true;
    clearTimeout(timer);
  });
  async function copy() {
    try {
      await navigator.clipboard.writeText(props.text);
      if (disposed) return;
      setCopied(true);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setCopied(false), 1600);
    } catch (error) {
      console.error("Clipboard write failed", error);
    }
  }
  return (
    <button
      type="button"
      data-testid="copy-commands"
      data-copied={copied() ? "true" : "false"}
      onClick={() => void copy()}
      {...stylex.attrs(styles.copyButton)}
    >
      <Presence
        value={copied() ? "done" : "copy"}
        initial={false}
        enter={{ y: [14, 0], opacity: [0, 1] }}
        exit={{ y: -14, opacity: 0 }}
        transition={{ duration: 0.2, ease: steps(3) }}
      >
        {(value, ref) => (
          <span ref={ref} {...stylex.attrs(styles.copyLabel)}>
            <img src={value === "done" ? props.check : props.icon} alt="" {...stylex.attrs(styles.copyIcon)} />
            {value === "done" ? props.done : props.label}
          </span>
        )}
      </Presence>
      <span {...stylex.attrs(styles.srOnly)} aria-live="polite">
        {copied() ? props.done : ""}
      </span>
    </button>
  );
}
