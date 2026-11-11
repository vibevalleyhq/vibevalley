import type { JSX } from "@solidjs/web";
/** @jsxImportSource @solidjs/web */
import * as stylex from "@stylexjs/stylex";
import { createSignal, onCleanup, onSettled } from "solid-js";

import { createImageTransition } from "../animation/image";
import { Presence } from "../animation/Presence";
import { createElementRef, createReveal, createScrollAnimation } from "../animation/scroll";
import type { Copy } from "../i18n/zh";
import { Section, domAttrs } from "./ui";

const sceneStyles = stylex.create({
  dialogBackdrop: {
    position: "fixed",
    inset: "0",
    zIndex: 50,
    display: "grid",
    placeItems: "center",
    backgroundColor: {
      default: "var(--color-shade-80)",
      "@supports (color:color-mix(in lab, red, red))": "color-mix(in oklab, var(--color-shade) 80%, transparent)",
    },
    padding: {
      default: "1rem",
      "@media (width>=40rem)": "2rem",
    },
  },
});

const viewStyles = stylex.create({
  tall: { gridRow: { default: null, "@media (width >= 64rem)": "span 2 / span 2" } },
  offset: { marginTop: { default: null, "@media (width >= 64rem)": "60px" } },
  screensDiv: {
    display: "grid",
    gridTemplateColumns: {
      default: "minmax(0, 1fr)",
      "@media (width>=64rem)": "minmax(0,1.4fr) minmax(0,1fr)",
    },
    alignItems: "flex-start",
    gap: "1.75rem",
  },
  screensFigure: {
    margin: "0",
    borderStyle: "solid",
    borderWidth: "2px",
    borderColor: "var(--color-bark-900)",
    backgroundColor: "var(--color-cream-50)",
    boxShadow: "inset 0 0 0 2px var(--color-rim), 4px 4px 0 var(--color-drop)",
    padding: "0.625rem",
  },
  screensButton: {
    display: "block",
    width: "100%",
    cursor: "zoom-in",
  },
  screensImg: {
    display: "block",
    height: "auto",
    width: "100%",
    borderStyle: "solid",
    borderWidth: "2px",
    borderColor: "var(--color-bark-900)",
  },
  screensFigcaption: {
    paddingInline: "0.25rem",
    paddingTop: "0.625rem",
    paddingBottom: "0.125rem",
    fontSize: "15px",
    color: "var(--color-bark-800)",
  },
  largeFigure: {
    position: "relative",
    margin: "0",
    borderStyle: "solid",
    borderWidth: "2px",
    borderColor: "var(--color-bark-900)",
    backgroundColor: "var(--color-cream-50)",
    boxShadow: "inset 0 0 0 2px var(--color-rim), 4px 4px 0 var(--color-drop)",
    padding: "0.625rem",
  },
  largeImg: {
    display: "block",
    height: "auto",
    maxHeight: "80svh",
    width: "auto",
    maxWidth: "100%",
    borderStyle: "solid",
    borderWidth: "2px",
    borderColor: "var(--color-bark-900)",
  },
  screenshotClose: {
    position: "absolute",
    top: "-1rem",
    right: "-1rem",
    display: "grid",
    width: "2.75rem",
    height: "2.75rem",
    cursor: "pointer",
    placeItems: "center",
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
    boxShadow: "inset 2px 2px 0 var(--color-rim), 3px 3px 0 var(--color-drop)",
  },
  largeImg2: {
    width: "1.5rem",
    height: "1.5rem",
    imageRendering: "pixelated",
  },
});

interface Shot {
  src: string;
  srcset: string;
  width: number;
  height: number;
  caption: string;
}
interface Props {
  copy: Copy["screens"];
  shots: Shot[];
  close: string;
}
const SIZES = [
  "(min-width: 1024px) 640px, calc(100vw - 48px)",
  "(min-width: 1024px) 460px, calc(100vw - 48px)",
  "(min-width: 1024px) 460px, calc(100vw - 48px)",
];
const DRIFT = [0.04, -0.05, -0.09];

export default function Screens(props: Props) {
  const root = createReveal<HTMLElement>();
  const [open, setOpen] = createSignal<{ shot: Shot; source: HTMLImageElement } | undefined>(undefined);
  return (
    <>
      <Section ref={root.set} id="screens" title={props.copy.title}>
        <div {...stylex.attrs(viewStyles.screensDiv)}>
          {props.shots.map((shot, i) => (
            <Drift rate={DRIFT[i] ?? 0} styles={[i === 0 && viewStyles.tall, i === 1 && viewStyles.offset]}>
              <figure data-reveal {...stylex.attrs(viewStyles.screensFigure)}>
                <button
                  type="button"
                  data-testid={`screenshot-${i}`}
                  title={props.copy.open}
                  {...stylex.attrs(viewStyles.screensButton)}
                  onClick={(event) => {
                    const source = event.currentTarget.querySelector("img");
                    if (source) setOpen({ shot, source });
                  }}
                >
                  <img
                    src={shot.src}
                    srcset={shot.srcset}
                    sizes={SIZES[i]}
                    alt={shot.caption}
                    loading="lazy"
                    decoding="async"
                    width={shot.width}
                    height={shot.height}
                    {...stylex.attrs(viewStyles.screensImg)}
                  />
                </button>
                <figcaption {...stylex.attrs(viewStyles.screensFigcaption)}>{shot.caption}</figcaption>
              </figure>
            </Drift>
          ))}
        </div>
      </Section>
      <Presence value={open()} enter={{ opacity: [0, 1] }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}>
        {(value, ref) => (
          <Large shot={value.shot} source={value.source} label={props.copy.close} icon={props.close} onClose={() => setOpen(undefined)} ref={ref} />
        )}
      </Presence>
    </>
  );
}

function Drift(props: { rate: number; styles?: stylex.StyleXStyles; children: JSX.Element }) {
  const ref = createScrollAnimation<HTMLDivElement>("self", ["start end", "end start"], () => [
    { keyframes: { transform: [`translateY(${600 * props.rate}px)`, `translateY(${-600 * props.rate}px)`] } },
  ]);
  return (
    <div ref={ref.set} {...domAttrs(props.styles)}>
      {props.children}
    </div>
  );
}

function Large(props: { shot: Shot; source: HTMLImageElement; label: string; icon: string; onClose: () => void; ref: (element: HTMLElement) => void }) {
  const button = createElementRef<HTMLButtonElement>();
  const image = createElementRef<HTMLImageElement>();
  let cancel = () => {};
  const close = () => {
    cancel();
    const element = image.get();
    if (element) cancel = createImageTransition(element, props.source, true);
    props.onClose();
  };
  onCleanup(() => cancel());
  onSettled(() => {
    const before = document.activeElement;
    button.get()?.focus();
    const element = image.get();
    if (element) cancel = createImageTransition(element, props.source);
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
      if (event.key === "Tab") {
        event.preventDefault();
        button.get()?.focus();
      }
    };
    addEventListener("keydown", key);
    const overflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";
    return () => {
      removeEventListener("keydown", key);
      document.documentElement.style.overflow = overflow;
      if (before instanceof HTMLElement && before.isConnected) before.focus({ preventScroll: true });
    };
  });
  return (
    <div
      ref={props.ref}
      role="dialog"
      aria-modal="true"
      aria-label={props.shot.caption}
      data-testid="screenshot-dialog"
      onClick={close}
      {...stylex.attrs(sceneStyles.dialogBackdrop)}
    >
      <figure onClick={(event) => event.stopPropagation()} {...stylex.attrs(viewStyles.largeFigure)}>
        <img ref={image.set} src={props.shot.src} alt={props.shot.caption} {...stylex.attrs(viewStyles.largeImg)} />
        <figcaption {...stylex.attrs(viewStyles.screensFigcaption)}>{props.shot.caption}</figcaption>
        <button
          ref={button.set}
          type="button"
          data-testid="screenshot-close"
          onClick={close}
          aria-label={props.label}
          {...stylex.attrs(viewStyles.screenshotClose)}
        >
          <img src={props.icon} alt="" {...stylex.attrs(viewStyles.largeImg2)} />
        </button>
      </figure>
    </div>
  );
}
