import { Switch } from "@vibevalley/base-ui";
import { t } from "@vibevalley/i18n";
// What the workbench's list-and-detail pages share: a list card of rows on the left, the open one's card on the right,
// and the few controls their forms use.

import { createSignal, omit, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { A } from "./A";
import { aria } from "@/base/util";
import { TextInput } from "./Field";
import { Icon } from "./Icon";
import { Hint } from "./Tip";

/** A list beside its detail; under md the list stacks over it. */
export function Split(props: { list: JSX.Element; children: JSX.Element }) {
  return (
    <div class="flex h-full min-h-0 flex-col gap-3 overflow-y-auto md:flex-row md:overflow-hidden">
      <div class="shrink-0 md:w-70 md:overflow-y-auto">{props.list}</div>
      <div class="min-w-0 flex-1 md:overflow-y-auto">{props.children}</div>
    </div>
  );
}

/** A titled list of rows; aria-label names it for the reader. */
export function ListCard(props: { title: string; label?: string; action?: JSX.Element; children: JSX.Element; testid?: string }) {
  return (
    <section aria-label={props.label ?? props.title} data-testid={props.testid} class="flex flex-col rounded-lg border border-line bg-page">
      <header class="flex h-10 shrink-0 items-center gap-2 border-b border-line px-3">
        <h2 class="flex-1 truncate text-sm font-semibold">{props.title}</h2>
        {props.action}
      </header>
      <ul class="flex flex-col p-1">{props.children}</ul>
    </section>
  );
}

/** A row: a link to its detail, marked when it is the open one. */
export function ListRow(props: { to: string; item?: string; active?: boolean; title: string; line?: string; leading?: JSX.Element; trailing?: JSX.Element }) {
  return (
    <li>
      <A
        href={props.to}
        data-testid="list-row"
        data-key={props.item}
        aria-current={props.active === true ? "page" : undefined}
        class={[
          "flex items-center gap-2.5 rounded-md px-2.5 py-2 hover:bg-hover focus-visible:outline-2 focus-visible:outline-focus",
          { "bg-selected": !(props.active !== true) },
        ]}
      >
        {props.leading}
        <span class="flex min-w-0 flex-1 flex-col">
          <span class="truncate text-sm font-medium">{props.title}</span>
          <Show when={props.line}>
            <span class="truncate text-xs text-muted">{props.line}</span>
          </Show>
        </span>
        {props.trailing}
      </A>
    </li>
  );
}

/** The open thing's card: a title, what sits beside it, and its body. */
export function Card(props: { title?: JSX.Element; action?: JSX.Element; children: JSX.Element; class?: string; testid?: string; item?: string }) {
  return (
    <section data-testid={props.testid} data-key={props.item} class={["flex flex-col rounded-lg border border-line bg-page", props.class]}>
      <Show when={props.title !== undefined}>
        <header class="flex min-h-12 items-center gap-2 border-b border-line px-4 py-2">
          <h2 class="min-w-0 flex-1 truncate text-base font-semibold">{props.title}</h2>
          {props.action}
        </header>
      </Show>
      <div class="flex flex-col gap-4 p-4">{props.children}</div>
    </section>
  );
}

/** Nothing to show yet, in words. */
export function Quiet(props: { children: JSX.Element }) {
  return <p class="text-sm text-muted">{props.children}</p>;
}

/** An on/off with its label, and what it means under it (hint) or behind an info icon (tip). */
export function Toggle(props: {
  label: string;
  /** What a screen reader says, where the label alone does not say which. */
  ariaLabel?: string;
  hint?: string | undefined;
  tip?: string;
  checked: boolean;
  onChange: (on: boolean) => void;
  disabled?: boolean;
  testid?: string;
}) {
  return (
    <label class={["flex items-start gap-2", props.disabled === true ? "opacity-50" : "cursor-pointer"]}>
      <Switch.Root
        data-testid={props.testid}
        checked={props.checked}
        onCheckedChange={props.onChange}
        aria-label={props.ariaLabel ?? props.label}
        disabled={props.disabled}
        class="mt-0.5 flex h-4 w-7 shrink-0 items-center rounded-full bg-selected p-0.5 transition-colors data-checked:bg-accent"
      >
        <Switch.Thumb class="block size-3 rounded-full bg-page shadow transition-transform data-checked:translate-x-3" />
      </Switch.Root>
      <span class="flex flex-col">
        <span class="flex items-center gap-1 text-sm">
          {props.label}
          <Show when={props.tip}>{(t) => <Hint text={t()} />}</Show>
        </span>
        <Show when={props.hint}>
          <span class="text-xs text-muted">{props.hint}</span>
        </Show>
      </span>
    </label>
  );
}

/** A key: hidden until the eye is pressed. */
export function SecretInput(props: JSX.InputHTMLAttributes<HTMLInputElement>) {
  const [shown, setShown] = createSignal(false);
  const rest = omit(props, "class");
  return (
    <span class="relative flex">
      <TextInput {...rest} type={shown() ? "text" : "password"} autocomplete="off" spellcheck="false" class={["pr-9 font-mono", props.class]} />
      <button
        type="button"
        data-testid="reveal"
        aria-pressed={aria(shown())}
        class="absolute inset-y-0 right-1 my-auto inline-flex size-7 cursor-pointer items-center justify-center rounded text-faint hover:bg-hover hover:text-ink"
        aria-label={shown() ? t("web.base.secret.hide") : t("web.base.secret.peek")}
        title={shown() ? t("web.base.secret.hide") : t("web.base.secret.peek")}
        onClick={() => setShown(!shown())}
      >
        <Icon name={shown() ? "hide" : "show"} size={16} />
      </button>
    </span>
  );
}

/** A quiet underlined word: a page to open in the browser, or onClick. */
export function TextLink(props: { children: JSX.Element; href?: string; onClick?: () => void; danger?: boolean }) {
  const look = () => ["cursor-pointer text-xs underline decoration-current/50 hover:text-ink", props.danger === true ? "text-berry" : "text-muted"];
  return (
    <Show
      when={props.href}
      fallback={
        <button type="button" class={look()} onClick={() => props.onClick?.()}>
          {props.children}
        </button>
      }
    >
      <a href={props.href} target="_blank" rel="noreferrer" class={look()}>
        {props.children}
      </a>
    </Show>
  );
}
