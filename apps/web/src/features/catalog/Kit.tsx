import { t } from "@vibevalley/i18n";
// 界面: the workbench's tokens and atoms, drawn from the same classes and components the pages use, in both themes side
// by side (docs/style/design.md). A token or an atom added there shows up here, so this shelf is how the system looks.

import { createSignal, For, onSettled, Show } from "solid-js";
import type { JSX } from "@solidjs/web";

import { Button } from "../../ui/Button";
import { ConfirmButton } from "../../ui/ConfirmButton";
import { Dot, type DotTone } from "../../ui/Dot";
import { Field, Select, TextInput } from "../../ui/Field";
import { Icon, type IconSize } from "../../ui/Icon";
import { IconButton } from "../../ui/IconButton";
import { Segmented } from "../../ui/Segmented";
import { Tag, type TagTone } from "../../ui/Tag";
import { AttachmentTile } from "../../ui/AttachmentTile";
import { Toggle } from "../../ui/layout";
import { PxButton, type PxTone } from "../../ui/pixel";

// Whole class names, so Tailwind sees each one.
const colours: [string, string][] = [
  ["page", "bg-page"],
  ["side", "bg-side"],
  ["hover", "bg-hover"],
  ["selected", "bg-selected"],
  ["line", "bg-line"],
  ["faint", "bg-faint"],
  ["muted", "bg-muted"],
  ["ink", "bg-ink"],
  ["accent", "bg-accent"],
  ["focus", "bg-focus"],
  ["leaf", "bg-leaf"],
  ["wheat", "bg-wheat"],
  ["berry", "bg-berry"],
  ["water", "bg-water"],
  ["bark", "bg-bark"],
  ["idle", "bg-idle"],
  ["ok-soft", "bg-ok-soft"],
  ["ok-ink", "bg-ok-ink"],
  ["bad-soft", "bg-bad-soft"],
  ["warn-ink", "bg-warn-ink"],
  ["rail", "bg-rail"],
  ["code-bg", "bg-code-bg"],
];

const sizes: [string, string][] = [
  ["text-2xs", "text-2xs"],
  ["text-xs", "text-xs"],
  ["text-sm", "text-sm"],
  ["text-base", "text-base"],
  ["text-lg", "text-lg"],
  ["text-xl", "text-xl"],
];

const radii: [string, string][] = [
  ["xs", "rounded-xs"],
  ["sm", "rounded-sm"],
  ["md", "rounded-md"],
  ["lg", "rounded-lg"],
  ["xl", "rounded-xl"],
];

const shadows: [string, string][] = [
  ["raise", "shadow-raise"],
  ["float", "shadow-float"],
];

const eases: [string, string][] = [
  ["out", "ease-out"],
  ["in", "ease-in"],
  ["in-out", "ease-in-out"],
  ["spring", "ease-spring"],
];

const ladder: IconSize[] = [10, 12, 14, 16, 20, 24, 48];

const dotTones: DotTone[] = ["leaf", "wheat", "berry", "water", "idle", "faint", "muted"];
const tagTones: TagTone[] = ["ok", "bad", "wait"];
const pxTones: PxTone[] = ["plain", "primary", "accent", "danger"];

// The pixel skin's families, darkest last; the skin does not follow the theme.
const pixel: [string, string[]][] = [
  ["cream", ["bg-cream-50", "bg-cream-100", "bg-cream-200", "bg-cream-300"]],
  ["bark", ["bg-bark-400", "bg-bark-500", "bg-bark-600", "bg-bark-800", "bg-bark-900"]],
  ["leaf", ["bg-leaf-300", "bg-leaf-500", "bg-leaf-600", "bg-leaf-700"]],
  ["wheat · berry · water", ["bg-hat", "bg-wheat-700", "bg-berry-500", "bg-berry-800", "bg-water-500"]],
  ["ink", ["bg-ink-100", "bg-ink-300", "bg-ink-500", "bg-ink-700", "bg-ink-900"]],
  ["lcd · dusk · glow", ["bg-lcd-pale", "bg-lcd-paper", "bg-lcd-light", "bg-dusk-800", "bg-glow"]],
];

/** cubic-bezier(a, b, c, d) as its four numbers. */
const bezier = (v: string) => {
  const n = v.match(/-?[\d.]+/g)?.map(Number) ?? [];
  return n.length === 4 ? (n as [number, number, number, number]) : undefined;
};

function Section(props: { title: string; children: JSX.Element }) {
  return (
    <section class="flex flex-col gap-2">
      <h3 class="text-xs font-semibold text-muted">{props.title}</h3>
      {props.children}
    </section>
  );
}

function Name(props: { children: string }) {
  return <span class="font-mono text-2xs text-muted">{props.children}</span>;
}

/** The curve on a 0–1 square, with room above and below for spring's overshoot. It is read off an element wearing the
 * class, so the curve drawn is the one the pages get (Tailwind writes only the easings in use into the stylesheet). */
function Curve(props: { name: string; class: string }) {
  let probe!: HTMLSpanElement;
  const [p, setP] = createSignal<[number, number, number, number]>();
  onSettled(() => {
    setP(bezier(getComputedStyle(probe).transitionTimingFunction));
  });
  const y = (v: number) => 44 - v * 32;
  return (
    <div class="flex flex-col items-center gap-1">
      <span ref={(el) => (probe = el)} class={["hidden", props.class]} />
      <svg viewBox="0 0 48 56" class="size-12 text-line" aria-hidden="true">
        <rect x="8" y="12" width="32" height="32" fill="none" stroke="currentColor" />
        <Show when={p()}>
          {(c) => (
            <path
              d={`M8 ${y(0)} C${8 + c()[0] * 32} ${y(c()[1])} ${8 + c()[2] * 32} ${y(c()[3])} 40 ${y(1)}`}
              fill="none"
              stroke="var(--color-accent)"
              stroke-width="2"
              data-testid="ease"
            />
          )}
        </Show>
      </svg>
      <Name>{props.name}</Name>
    </div>
  );
}

function Kit(props: { theme: "light" | "dark" }) {
  const [seg, setSeg] = createSignal<"list" | "board">("list");
  const [on, setOn] = createSignal(true);
  const [pick, setPick] = createSignal("");
  const [replay, setReplay] = createSignal(0);
  return (
    <div
      data-theme={props.theme}
      data-testid={`kit-${props.theme}`}
      class="flex min-w-0 flex-1 flex-col gap-5 rounded-lg border border-line bg-page p-4 text-ink"
    >
      <h2 class="text-sm font-semibold">{props.theme === "light" ? t("web.catalog.kit.light") : t("web.catalog.kit.dark")}</h2>

      <Section title={t("web.catalog.kit.colour")}>
        <div class="grid grid-cols-[repeat(auto-fill,minmax(5.5rem,1fr))] gap-2">
          <For each={colours}>
            {([name, cls]) => (
              <div class="flex flex-col gap-1">
                <span class={["h-8 rounded-md border border-line", cls]} />
                <Name>{name}</Name>
              </div>
            )}
          </For>
        </div>
      </Section>

      <Section title={t("web.catalog.kit.type")}>
        <div class="flex flex-col gap-1">
          <For each={sizes}>
            {([name, cls]) => (
              <div class="flex items-baseline gap-3">
                <span class="w-16 shrink-0">
                  <Name>{name}</Name>
                </span>
                <span class={["truncate", cls]}>{t("web.catalog.kit.sample")}</span>
              </div>
            )}
          </For>
        </div>
      </Section>

      <Section title={t("web.catalog.kit.shape")}>
        <div class="flex flex-wrap items-end gap-3">
          <For each={radii}>
            {([name, cls]) => (
              <div class="flex flex-col items-center gap-1">
                <span class={["size-10 border border-line bg-side", cls]} />
                <Name>{name}</Name>
              </div>
            )}
          </For>
          <For each={shadows}>
            {([name, cls]) => (
              <div class="flex flex-col items-center gap-1">
                <span class={["size-10 rounded-md border border-line bg-page", cls]} />
                <Name>{name}</Name>
              </div>
            )}
          </For>
        </div>
      </Section>

      <Section title={t("web.catalog.kit.motion")}>
        <div class="flex flex-wrap items-end gap-3">
          <For each={eases}>{([name, cls]) => <Curve name={name} class={cls} />}</For>
          {/* Keyed by the count, so each press mounts them again and they play again. */}
          <For each={[replay()]}>
            {() => (
              <div class="flex items-end gap-3">
                <div class="flex flex-col items-center gap-1">
                  <span class="size-10 animate-pop-in rounded-md bg-accent" />
                  <Name>pop-in</Name>
                </div>
                <div class="flex flex-col items-center gap-1">
                  <span class="size-10 animate-fade-in rounded-md bg-accent" />
                  <Name>fade-in</Name>
                </div>
              </div>
            )}
          </For>
          <Button tone="quiet" icon="refresh" onClick={() => setReplay((n) => n + 1)}>
            {t("web.catalog.kit.replay")}
          </Button>
        </div>
      </Section>

      <Section title={t("web.catalog.kit.icons")}>
        <div class="flex flex-wrap items-end gap-4">
          <For each={ladder}>
            {(size) => (
              <div class="flex flex-col items-center gap-1">
                <Icon name="issues" size={size} />
                <Name>{String(size)}</Name>
              </div>
            )}
          </For>
        </div>
      </Section>

      <Section title={t("web.catalog.kit.atoms")}>
        <div class="flex flex-col gap-3">
          <div class="flex flex-wrap items-center gap-2">
            <Button tone="primary" icon="add">
              {t("web.catalog.kit.primary")}
            </Button>
            <Button>{t("web.catalog.kit.plain")}</Button>
            <Button tone="quiet">{t("web.catalog.kit.quiet")}</Button>
            <Button tone="danger">{t("web.catalog.kit.danger")}</Button>
            <Button disabled>{t("web.catalog.kit.disabled")}</Button>
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <IconButton icon="search" label={t("web.catalog.kit.plain")} onClick={() => undefined} />
            <IconButton icon="pin" label={t("web.catalog.kit.pressed")} pressed onClick={() => undefined} />
            <IconButton icon="delete" label={t("web.catalog.kit.danger")} tone="danger" onClick={() => undefined} />
            <ConfirmButton label={t("web.catalog.kit.delete")} question={t("web.catalog.kit.question")} tone="danger" onConfirm={() => undefined} />
          </div>
          <div class="flex flex-wrap items-center gap-3">
            <Segmented
              label={t("web.catalog.kit.view")}
              value={seg()}
              onChange={setSeg}
              options={[
                { value: "list", label: t("web.catalog.kit.list") },
                { value: "board", label: t("web.catalog.kit.board") },
              ]}
            />
            <Toggle label={t("web.catalog.kit.toggle")} checked={on()} onChange={setOn} />
          </div>
          <div class="flex flex-wrap items-center gap-3">
            <For each={dotTones}>
              {(tone) => (
                <span class="flex items-center gap-1">
                  <Dot tone={tone} ring={false} />
                  <Name>{tone}</Name>
                </span>
              )}
            </For>
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <Tag tone="ok" icon="check" label={t("web.catalog.kit.done")} />
            <Tag tone="bad" icon="close" label={t("web.catalog.kit.failed")} />
            <Tag tone="wait" icon="send" label={t("web.catalog.kit.sent")} />
            <For each={tagTones}>{(tone) => <Name>{tone}</Name>}</For>
          </div>
          <div class="grid gap-3 sm:grid-cols-2">
            <Field label={t("web.catalog.kit.field")} hint={t("web.catalog.kit.hint")}>
              <TextInput placeholder={t("web.catalog.kit.placeholder")} />
            </Field>
            <Field label={t("web.catalog.kit.select")}>
              <Select
                label={t("web.catalog.kit.select")}
                value={pick()}
                onChange={setPick}
                placeholder={t("web.catalog.kit.placeholder")}
                options={[
                  { value: "a", label: t("web.catalog.kit.list") },
                  { value: "b", label: t("web.catalog.kit.board") },
                ]}
              />
            </Field>
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <AttachmentTile file={{ id: "kit", name: "notes.md", type: "text/markdown", size: 2048 }} onRemove={() => undefined} />
            <span class="flex items-center gap-1 text-xs text-muted">
              <kbd class="min-w-6 rounded-xs border border-line bg-hover px-1.5 text-center font-mono text-2xs leading-5 text-ink">⌘K</kbd>
              <kbd class="min-w-6 rounded-xs border border-line bg-hover px-1.5 text-center font-mono text-2xs leading-5 text-ink">?</kbd>
            </span>
          </div>
        </div>
      </Section>
    </div>
  );
}

/** The pixel skin keeps its own colours in either theme, so it is drawn once. */
function Pixel() {
  return (
    <div data-theme="light" data-testid="kit-pixel" class="flex flex-col gap-4 rounded-lg border border-line bg-cream-100 p-4 font-pixel text-bark-900">
      <h2 class="text-xs">{t("web.catalog.kit.pixel")}</h2>
      <div class="flex flex-wrap gap-4">
        <For each={pixel}>
          {([name, list]) => (
            <div class="flex flex-col gap-1">
              <div class="flex border-2 border-bark-500">
                <For each={list}>{(cls) => <span class={["size-7", cls]} />}</For>
              </div>
              <span class="font-mono text-2xs text-bark-600">{name}</span>
            </div>
          )}
        </For>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <For each={pxTones}>
          {(tone) => (
            <PxButton tone={tone} onClick={() => undefined}>
              {tone}
            </PxButton>
          )}
        </For>
      </div>
    </div>
  );
}

export function KitShelf(props: { tabs: JSX.Element }) {
  return (
    <div class="flex h-full min-h-0 flex-col gap-3 overflow-y-auto lg:flex-row">
      <div class="shrink-0 lg:w-60">
        <div class="flex flex-col gap-2 rounded-lg border border-line bg-page p-2">
          {props.tabs}
          <p class="px-2 pt-1 text-xs text-muted">{t("web.catalog.kit.intro")}</p>
        </div>
      </div>
      <div class="flex min-w-0 flex-1 flex-col gap-3">
        <div class="flex flex-col gap-3 xl:flex-row">
          <Kit theme="light" />
          <Kit theme="dark" />
        </div>
        <Pixel />
      </div>
    </div>
  );
}
