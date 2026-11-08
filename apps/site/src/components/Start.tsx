/** @jsxImportSource @solidjs/web */
import * as stylex from "@stylexjs/stylex";
import { steps } from "motion";
import { createSignal, onCleanup } from "solid-js";

import { Presence } from "../animation/Presence";
import { createReveal } from "../animation/scroll";
import type { Copy } from "../i18n/zh";
import { Section } from "./ui";

const sceneStyles = stylex.create({
  warning: {
    display: "flex",
    alignItems: "flex-start",
    gap: "calc(var(--spacing) * 5)",
    borderStyle: "solid",
    borderWidth: "2px",
    borderColor: "var(--color-bark-900)",
    backgroundColor: "var(--color-warn) !important",
    boxShadow: "inset 0 0 0 2px var(--color-rim), 0 0 transparent, 0 0 transparent, 0 0 transparent, 4px 4px 0 var(--color-drop)",
    padding: "calc(var(--spacing) * 6)",
  },
});

const recipeStyles = stylex.create({
  startSpan: {
    color: "var(--color-wheat)",
    WebkitUserSelect: "none",
    userSelect: "none",
  },
});

const viewStyles = stylex.create({
  startImg: {
    width: "calc(var(--spacing) * 12)",
    height: "calc(var(--spacing) * 12)",
    flex: "none",
    objectFit: "contain",
    imageRendering: "pixelated",
  },
  startH3: {
    marginBottom: "calc(var(--spacing) * 1.5)",
    fontSize: "var(--text-2xl)",
    lineHeight: "var(--text-2xl--line-height)",
    color: "var(--color-berry)",
  },
  startP: {
    fontSize: "var(--text-base)",
    lineHeight: "var(--text-base--line-height)",
  },
  startP2: {
    marginTop: "calc(var(--spacing) * 2)",
    fontSize: "var(--text-base)",
    lineHeight: "var(--text-base--line-height)",
  },
  startDiv: {
    marginTop: "calc(var(--spacing) * 7)",
    display: "grid",
    gridTemplateColumns: {
      default: "repeat(1,minmax(0,1fr))",
      "@media (width>=64rem)": "minmax(0,1fr) minmax(0,1.3fr)",
    },
    alignItems: "flex-start",
    gap: "calc(var(--spacing) * 7)",
  },
  startDiv2: {
    borderStyle: "solid",
    borderWidth: "2px",
    borderColor: "var(--color-bark-900)",
    backgroundColor: "var(--color-cream-50)",
    boxShadow: "inset 0 0 0 2px var(--color-rim), 0 0 transparent, 0 0 transparent, 0 0 transparent, 4px 4px 0 var(--color-drop)",
    padding: "calc(var(--spacing) * 6)",
  },
  startH32: {
    fontSize: "var(--text-2xl)",
    lineHeight: "var(--text-2xl--line-height)",
  },
  startUl: {
    marginTop: "calc(var(--spacing) * 3)",
  },
  startLi: {
    display: "flex",
    alignItems: "flex-start",
    gap: "calc(var(--spacing) * 2.5)",
    paddingBlock: "calc(var(--spacing) * 1.5)",
    fontSize: "var(--text-base)",
    lineHeight: "var(--text-base--line-height)",
  },
  startImg2: {
    marginTop: "5px",
    width: "calc(var(--spacing) * 5)",
    height: "calc(var(--spacing) * 5)",
    flex: "none",
    objectFit: "contain",
    imageRendering: "pixelated",
  },
  startDiv3: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "calc(var(--spacing) * 3)",
  },
  startPre: {
    marginTop: "calc(var(--spacing) * 3.5)",
    overflowX: "auto",
    borderStyle: "solid",
    borderWidth: "2px",
    borderColor: "var(--color-bark-900)",
    backgroundColor: "var(--color-bark-900)",
    paddingInline: "calc(var(--spacing) * 5)",
    paddingBlock: "18px",
    fontFamily: "var(--font-mono)",
    fontSize: "var(--text-sm)",
    lineHeight: "1.8",
    color: "var(--color-cream-50)",
    boxShadow: "0 0 transparent, 0 0 transparent, 0 0 transparent, 0 0 transparent, inset 0 0 0 2px var(--color-bark-600)",
  },
  startSpan: {
    display: "block",
  },
  startP3: {
    marginTop: "calc(var(--spacing) * 3.5)",
    fontSize: "15px",
    color: "var(--color-bark-800)",
  },
  startA: {
    textDecorationLine: "underline",
  },
  copyCommands: {
    display: "inline-flex",
    height: "calc(var(--spacing) * 8)",
    cursor: "pointer",
    alignItems: "center",
    overflow: "hidden",
    borderStyle: "solid",
    borderWidth: "2px",
    borderColor: "var(--color-bark-900)",
    backgroundColor: {
      default: "var(--color-cream-50)",
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-cream-hover)",
      },
    },
    paddingInline: "calc(var(--spacing) * 2)",
    fontFamily: "var(--font-pixel)",
    fontSize: "var(--text-sm)",
    lineHeight: "1",
    color: "var(--color-bark-900)",
  },
  copyButtonSpan: {
    display: "inline-flex",
    alignItems: "center",
    gap: "calc(var(--spacing) * 1.5)",
  },
  copyButtonImg: {
    width: "calc(var(--spacing) * 4)",
    height: "calc(var(--spacing) * 4)",
    objectFit: "contain",
    imageRendering: "pixelated",
  },
  copyButtonSpan2: {
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
        <div data-reveal role="note" {...stylex.attrs(sceneStyles.warning)}>
          <img loading="lazy" src={props.icons.warn} alt="" {...stylex.attrs(viewStyles.startImg)} />
          <div>
            <h3 {...stylex.attrs(viewStyles.startH3)}>{props.copy.safety.title}</h3>
            <p {...stylex.attrs(viewStyles.startP)}>{props.copy.safety.text}</p>
            <p {...stylex.attrs(viewStyles.startP2)}>{props.copy.safety.wip}</p>
          </div>
        </div>
        <div {...stylex.attrs(viewStyles.startDiv)}>
          <div data-reveal {...stylex.attrs(viewStyles.startDiv2)}>
            <h3 {...stylex.attrs(viewStyles.startH32)}>{props.copy.start.needs}</h3>
            <ul {...stylex.attrs(viewStyles.startUl)}>
              {props.copy.start.list.map((item) => (
                <li {...stylex.attrs(viewStyles.startLi)}>
                  <img loading="lazy" src={props.icons.check} alt="" {...stylex.attrs(viewStyles.startImg2)} />
                  {item}
                </li>
              ))}
            </ul>
          </div>
          <div data-reveal {...stylex.attrs(viewStyles.startDiv2)}>
            <div {...stylex.attrs(viewStyles.startDiv3)}>
              <h3 {...stylex.attrs(viewStyles.startH32)}>{props.copy.start.build}</h3>
              <CopyButton
                text={props.commands.join("\n")}
                icon={props.icons.copy}
                check={props.icons.check}
                label={props.copy.start.copy}
                done={props.copy.start.copied}
              />
            </div>
            <pre {...stylex.attrs(viewStyles.startPre)}>
              {props.commands.map((c) => (
                <span {...stylex.attrs(viewStyles.startSpan)}>
                  <span {...stylex.attrs(recipeStyles.startSpan)}>$ </span>
                  {c}
                </span>
              ))}
            </pre>
            <p {...stylex.attrs(viewStyles.startP3)}>
              {props.copy.start.more}{" "}
              <a href={props.readme} {...stylex.attrs(viewStyles.startA)}>
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
      {...stylex.attrs(viewStyles.copyCommands)}
    >
      <Presence
        value={copied() ? "done" : "copy"}
        initial={false}
        enter={{ y: [14, 0], opacity: [0, 1] }}
        exit={{ y: -14, opacity: 0 }}
        transition={{ duration: 0.2, ease: steps(3) }}
      >
        {(value, ref) => (
          <span ref={ref} {...stylex.attrs(viewStyles.copyButtonSpan)}>
            <img src={value === "done" ? props.check : props.icon} alt="" {...stylex.attrs(viewStyles.copyButtonImg)} />
            {value === "done" ? props.done : props.label}
          </span>
        )}
      </Presence>
      <span {...stylex.attrs(viewStyles.copyButtonSpan2)} aria-live="polite">
        {copied() ? props.done : ""}
      </span>
    </button>
  );
}
