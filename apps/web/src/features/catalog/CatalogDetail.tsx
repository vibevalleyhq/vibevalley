import type { JSX } from "@solidjs/web";
import * as stylex from "@stylexjs/stylex";
import { createEffect, createMemo, createSignal, For, Show, untrack } from "solid-js";

import { Slider } from "@vibevalley/base-ui";
import { t } from "@vibevalley/i18n";

import { aria } from "#/base/dom.tsx";
import { numberText } from "#/base/format.ts";
import { useTimeout } from "#/base/timer.ts";
import { useRouter } from "#/infra/router.ts";
import { Button } from "#/ui/Button.tsx";
import { Icon } from "#/ui/Icon.tsx";
import { Card, Toggle } from "#/ui/layout.tsx";
import { styleProps } from "#/ui/positioner.ts";
import { Segmented } from "#/ui/Segmented.tsx";

import { framesOf, type Picture, remakeOf } from "./shelves";

const groundStyles = stylex.create({
  grass: {
    backgroundColor: "var(--color-catalog-grass)",
    backgroundImage: "none",
    backgroundSize: "auto",
  },
  night: {
    backgroundColor: "var(--color-catalog-night)",
    backgroundImage: "none",
    backgroundSize: "auto",
  },
  check: {
    backgroundColor: "var(--color-catalog-paper)",
    backgroundImage: "repeating-conic-gradient(var(--color-catalog-check) 0% 25%, transparent 0% 50%)",
    backgroundSize: "12px 12px",
  },
});

const variantStyles2 = stylex.create({
  detailSliderRoot: {
    width: "calc(var(--spacing) * 24)",
  },
  detailSliderControl: {
    position: "relative",
    display: "flex",
    height: "calc(var(--spacing) * 4)",
    cursor: "pointer",
    alignItems: "center",
  },
  detailSliderTrack: {
    position: "relative",
    height: "var(--spacing)",
    width: "100%",
    borderRadius: "2147483647px",
    backgroundColor: "var(--color-selected)",
  },
  detailSliderIndicator: {
    height: "100%",
    borderRadius: "2147483647px",
    backgroundColor: "var(--color-leaf)",
  },
  detailSliderThumb: {
    top: "50%",
    width: "calc(var(--spacing) * 3)",
    height: "calc(var(--spacing) * 3)",
    translate: "0 calc(calc(1 / 2 * 100%) * -1)",
    borderRadius: "2147483647px",
    borderStyle: "solid",
    borderWidth: "1px",
    borderColor: "var(--color-leaf)",
    backgroundColor: "var(--color-page)",
    boxShadow: "var(--shadow-raise)",
    outlineStyle: {
      default: "none",
      ":focus-visible": "none",
    },
    outlineWidth: {
      default: null,
      ":focus-visible": "2px",
    },
    outlineColor: {
      default: null,
      ":focus-visible": "var(--color-focus)",
    },
  },
});

const variantStyles = stylex.create({
  detailButton: {
    display: "flex",
    width: "calc(var(--spacing) * 11)",
    height: "calc(var(--spacing) * 11)",
    cursor: "pointer",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    borderRadius: "var(--radius-sm)",
  },
  detailButtonVariant: {
    boxShadow: "0 0 0 calc(2px + 0) var(--color-focus)",
  },
  detailButtonVariant2: {},
});

const viewStyles = stylex.create({
  imgImg: {
    maxWidth: "none",
    imageRendering: "pixelated",
  },
  copyButton: {
    display: "flex",
    flexShrink: "0",
    cursor: "pointer",
    alignItems: "center",
    gap: "var(--spacing)",
    borderRadius: "var(--radius-sm)",
    paddingInline: "calc(var(--spacing) * 1.5)",
    paddingBlock: "calc(var(--spacing) * .5)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--color-muted)",
    backgroundColor: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-hover)",
      },
    },
  },
  rowDiv: {
    display: "flex",
    gap: "calc(var(--spacing) * 2)",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
  },
  rowSpan: {
    width: "calc(var(--spacing) * 16)",
    flexShrink: "0",
    color: "var(--color-muted)",
  },
  rowSpan2: {
    display: "flex",
    minWidth: "0",
    flex: "1",
    alignItems: "center",
    gap: "var(--spacing)",
  },
  codeCode: {
    minWidth: "0",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    borderRadius: "var(--radius-sm)",
    backgroundColor: "var(--color-hover)",
    paddingInline: "calc(var(--spacing) * 1.5)",
    paddingBlock: "1px",
    fontFamily: "var(--font-mono)",
    fontSize: "var(--text-2xs)",
    lineHeight: "var(--text-2xs--line-height)",
  },
  detailDiv: {
    display: "flex",
    maxHeight: "calc(var(--spacing) * 88)",
    minHeight: "calc(var(--spacing) * 40)",
    alignItems: "center",
    justifyContent: "center",
    overflow: "auto",
    borderRadius: "var(--radius-md)",
    padding: "calc(var(--spacing) * 3)",
  },
  detailSpan: {
    position: "relative",
  },
  detailSpan2: {
    width: 12,
    height: 12,
    backgroundImage: "linear-gradient(var(--color-berry-500),var(--color-berry-500)), linear-gradient(var(--color-berry-500),var(--color-berry-500))",
    backgroundPosition: "center, center",
    backgroundSize: "100% 2px, 2px 100%",
    backgroundRepeat: "no-repeat",
    position: "absolute",
  },
  detailSpan3: {
    width: 10,
    height: 10,
    position: "absolute",
    borderStyle: "solid",
    borderWidth: "2px",
    borderColor: "var(--color-water)",
  },
  detailDiv2: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "calc(var(--spacing) * 2)",
  },
  detailDiv3: {
    display: "flex",
    flexDirection: "column",
    gap: "calc(var(--spacing) * 1.5)",
    borderRadius: "var(--radius-lg)",
    backgroundColor: "var(--color-hover)",
    padding: "calc(var(--spacing) * 2)",
  },
  detailDiv4: {
    display: "flex",
    alignItems: "center",
    gap: "calc(var(--spacing) * 2)",
  },
  detailSpan4: {
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--color-muted)",
  },
  detailSpan5: {
    flex: "1",
  },
  detailSpan6: {
    width: "calc(var(--spacing) * 14)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--color-muted)",
  },
  detailDiv5: {
    display: "flex",
    flexWrap: "wrap",
    gap: "var(--spacing)",
  },
  detailDiv6: {
    display: "flex",
    flexDirection: "column",
    gap: "calc(var(--spacing) * 1.5)",
  },
  cursor: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "var(--spacing)",
    padding: "var(--spacing)",
  },
  cursorTileSpan: {
    display: "flex",
    height: "calc(var(--spacing) * 16)",
    width: "100%",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: "var(--radius-md)",
  },
  cursorTileImg: {
    height: "calc(var(--spacing) * 10)",
    imageRendering: "pixelated",
  },
  cursorTileImg2: {
    display: "none",
  },
  cursorTileSpan2: {
    position: "absolute",
    width: "calc(var(--spacing) * 2)",
    height: "calc(var(--spacing) * 2)",
    borderRadius: "2147483647px",
    borderStyle: "solid",
    borderWidth: "1px",
    borderColor: "var(--color-bark-900)",
    backgroundColor: "var(--color-berry)",
  },
  cursorTileSpan3: {
    fontFamily: "var(--font-mono)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--color-muted)",
  },
});

export type Ground = "check" | "grass" | "night";
export const grounds: { value: Ground; label: string }[] = [
  { value: "check", label: t("web.catalog.ground.check") },
  { value: "grass", label: t("web.catalog.ground.grass") },
  { value: "night", label: t("web.catalog.ground.night") },
];

export const groundStyle = (g: Ground): stylex.StyleXStyles => groundStyles[g];

/** Whole steps, so its pixels stay square. */
export const fitScale = (p: Picture, box: number) => {
  const k = box / Math.max(p.w, p.h);
  return k >= 1 ? Math.floor(k) : k;
};

export function Img(props: { p: Picture; scale: number }) {
  return (
    <img
      src={`/pixel/${props.p.name}.png`}
      alt=""
      draggable="false"
      {...stylex.attrs(viewStyles.imgImg)}
      style={{ width: `${Math.round(props.p.w * props.scale)}px`, height: `${Math.round(props.p.h * props.scale)}px` }}
    />
  );
}

const headOf = (p: { readonly hx?: number | undefined; readonly hy?: number | undefined }) =>
  p.hx !== undefined && p.hy !== undefined ? { x: p.hx, y: p.hy } : undefined;

function Copy(props: { text: string }) {
  const [done, setDone] = createSignal(false);
  const later = useTimeout();
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setDone(true);
      later(() => setDone(false), 1200);
    } catch {
      // No clipboard here: the text is on show to copy by hand.
    }
  };
  return (
    <button type="button" onClick={() => void copy(props.text)} {...stylex.attrs(viewStyles.copyButton)}>
      <Icon name={done() ? "check" : "copy"} size={12} />
      {done() ? t("web.catalog.copied") : t("web.catalog.copy")}
    </button>
  );
}

function Row(props: { label: string; children: JSX.Element }) {
  return (
    <div {...stylex.attrs(viewStyles.rowDiv)}>
      <span {...stylex.attrs(viewStyles.rowSpan)}>{props.label}</span>
      <span {...stylex.attrs(viewStyles.rowSpan2)}>{props.children}</span>
    </div>
  );
}

function Code(props: { text: string }) {
  return (
    <>
      <code title={props.text} {...stylex.attrs(viewStyles.codeCode)}>
        {props.text}
      </code>
      <Copy text={props.text} />
    </>
  );
}

export function Detail(props: { picture: Picture; has: (n: string) => boolean; byName: Map<string, Picture>; ground: Ground }) {
  const router = useRouter();
  const [scale, setScale] = createSignal(untrack(() => Math.min(8, Math.max(1, Math.floor(260 / Math.max(props.picture.w, props.picture.h))))));
  const [marks, setMarks] = createSignal(true);
  const [playing, setPlaying] = createSignal(true);
  const [fps, setFps] = createSignal(6);
  const [frame, setFrame] = createSignal(0);
  const frames = createMemo(() => framesOf(props.picture.name, props.has));
  createEffect(
    () => [frames()?.join(), playing(), fps()] as const,
    ([names, on, perSecond]) => {
      if (!names || !on || perSecond <= 0) return;
      const t = setInterval(() => setFrame((f) => f + 1), 1000 / perSecond);
      return () => clearInterval(t);
    },
  );
  const shown = () => {
    const f = frames();
    const frameName = f && playing() ? f[frame() % f.length] : undefined;
    return (frameName ? props.byName.get(frameName) : undefined) ?? props.picture;
  };
  const remake = () => remakeOf(props.picture);
  const scales = () => [...new Set([1, 2, 4, 8, scale()])].toSorted((a, b) => a - b);
  return (
    <Card title={props.picture.name} action={<Copy text={props.picture.name} />} testid="picture-detail" item={props.picture.name}>
      <div {...styleProps([viewStyles.detailDiv, groundStyle(props.ground)])}>
        <span {...stylex.attrs(viewStyles.detailSpan)} style={{ width: `${shown().w * scale()}px`, height: `${shown().h * scale()}px` }}>
          <Img p={shown()} scale={scale()} />
          <Show when={marks()}>
            <span
              title={t("web.catalog.anchor")}
              {...stylex.attrs(viewStyles.detailSpan2)}
              style={{
                left: `${shown().ax * scale() - 6}px`,
                top: `${shown().ay * scale() - 6}px`,
              }}
            />
            <Show when={headOf(shown())}>
              {(head) => (
                <span
                  title={t("web.catalog.head")}
                  {...stylex.attrs(viewStyles.detailSpan3)}
                  style={{ left: `${head().x * scale() - 5}px`, top: `${head().y * scale() - 5}px` }}
                />
              )}
            </Show>
          </Show>
        </span>
      </div>
      <div {...stylex.attrs(viewStyles.detailDiv2)}>
        <Segmented
          label={t("web.catalog.zoom")}
          value={String(scale())}
          options={scales().map((s) => ({ value: String(s), label: `${s < 1 ? s.toFixed(2).replace(/0$/u, "") : numberText(s)}×` }))}
          onChange={(v) => setScale(Number(v))}
        />
        <Toggle label={t("web.catalog.marks")} checked={marks()} onChange={setMarks} />
      </div>
      <Show when={frames()}>
        {(f) => (
          <div {...stylex.attrs(viewStyles.detailDiv3)}>
            <div {...stylex.attrs(viewStyles.detailDiv4)}>
              <Button data-testid="play" aria-pressed={aria(playing())} onClick={() => setPlaying(!playing())}>
                {playing() ? t("web.catalog.stop") : t("web.catalog.play")}
              </Button>
              <span {...stylex.attrs(viewStyles.detailSpan4)}>{t("web.catalog.frames", { n: f().length })}</span>
              <span {...stylex.attrs(viewStyles.detailSpan5)} />
              <Slider.Root min={1} max={12} value={fps()} onValueChange={setFps} {...stylex.attrs(variantStyles2.detailSliderRoot)}>
                <Slider.Control {...stylex.attrs(variantStyles2.detailSliderControl)}>
                  <Slider.Track {...stylex.attrs(variantStyles2.detailSliderTrack)}>
                    <Slider.Indicator {...stylex.attrs(variantStyles2.detailSliderIndicator)} />
                    <Slider.Thumb aria-label={t("web.catalog.fps")} {...stylex.attrs(variantStyles2.detailSliderThumb)} />
                  </Slider.Track>
                </Slider.Control>
              </Slider.Root>
              <span {...stylex.attrs(viewStyles.detailSpan6)}>{t("web.catalog.perSecond", { n: fps() })}</span>
            </div>
            <div {...stylex.attrs(viewStyles.detailDiv5)}>
              <For each={f()}>
                {(name, i) => (
                  <Show when={props.byName.get(name)}>
                    {(p) => (
                      <button
                        type="button"
                        title={name}
                        aria-label={name}
                        onClick={() => router.navigate(`/catalog/${encodeURIComponent(name)}`)}
                        {...styleProps([
                          variantStyles.detailButton,
                          playing() && i() === frame() % f().length ? variantStyles.detailButtonVariant : variantStyles.detailButtonVariant2,
                          groundStyle(props.ground),
                        ])}
                      >
                        <Img p={p()} scale={fitScale(p(), 38)} />
                      </button>
                    )}
                  </Show>
                )}
              </For>
            </div>
          </div>
        )}
      </Show>
      <div {...stylex.attrs(viewStyles.detailDiv6)}>
        <Row label={t("web.catalog.size")}>{t("web.catalog.pixels", { w: numberText(props.picture.w), h: numberText(props.picture.h) })}</Row>
        <Row label={t("web.catalog.anchor")}>{`(${numberText(props.picture.ax)}, ${numberText(props.picture.ay)})`}</Row>
        <Show when={headOf(props.picture)}>{(head) => <Row label={t("web.catalog.head")}>{`(${numberText(head().x)}, ${numberText(head().y)})`}</Row>}</Show>
        <Row label={t("web.catalog.from")}>
          <Show when={props.picture.sheet} fallback={<span {...stylex.attrs(viewStyles.detailSpan4)}>{t("web.catalog.unrecorded")}</span>}>
            {(sheet) => <Code text={sheet()} />}
          </Show>
        </Row>
        <Show when={remake()}>
          {(r) => (
            <>
              <Row label={t("web.catalog.redraw")}>
                <Code text={r().draw} />
              </Row>
              <Row label={t("web.catalog.recut")}>
                <Code text={r().cut} />
              </Row>
            </>
          )}
        </Show>
      </div>
    </Card>
  );
}

export function CursorTile(props: { name: string; hx: number; hy: number; ground: Ground }) {
  const [natural, setNatural] = createSignal<{ w: number; h: number }>();
  const height = 40;
  const k = () => {
    const n = natural();
    return n ? height / n.h : undefined;
  };
  const widthPx = () => {
    const n = natural();
    const ratio = k();
    return n && ratio != null && ratio !== 0 ? n.w * ratio : height;
  };
  return (
    <div data-testid="cursor" data-key={props.name} {...stylex.attrs(viewStyles.cursor)}>
      <span {...styleProps([viewStyles.cursorTileSpan, groundStyle(props.ground)])}>
        <span {...stylex.attrs(viewStyles.detailSpan)} style={{ height: `${height}px`, width: `${widthPx()}px` }}>
          <img
            src={`/cursors/${props.name}@2x.png`}
            alt=""
            {...stylex.attrs(viewStyles.cursorTileImg)}
            onError={(e) => (e.currentTarget.src = `/cursors/${props.name}.png`)}
          />
          <img
            src={`/cursors/${props.name}.png`}
            alt=""
            {...stylex.attrs(viewStyles.cursorTileImg2)}
            onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
          />
          <Show when={k()}>
            {(ratio) => (
              <span {...stylex.attrs(viewStyles.cursorTileSpan2)} style={{ left: `${props.hx * ratio() - 4}px`, top: `${props.hy * ratio() - 4}px` }} />
            )}
          </Show>
        </span>
      </span>
      <span {...stylex.attrs(viewStyles.cursorTileSpan3)}>{props.name}</span>
    </div>
  );
}
