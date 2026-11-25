import { createSignal, onCleanup } from "solid-js";

import type { Copy } from "../i18n/zh";
import { Icon } from "../ui/icons";
import { Presence } from "../ui/Presence";
import { createReveal } from "../ui/scroll";
import { Section } from "../ui/ui";

interface Props {
  copy: Pick<Copy, "start" | "safety">;
  commands: string[];
  readme: string;
}

export default function Start(props: Props) {
  const root = createReveal<HTMLElement>();
  return (
    <Section ref={root.set} id="start" alt title={props.copy.start.title}>
      <div
        data-reveal
        role="note"
        class="flex items-start gap-4.5 rounded-lg border border-berry/40 bg-warn [box-shadow:var(--inset-shadow-rim),_var(--shadow-card)] p-6"
      >
        <span class="grid h-11 w-11 flex-none place-items-center rounded-md border border-berry/35 bg-card text-berry">
          <Icon name="warning" class="w-6 h-6" />
        </span>
        <div>
          <h3 class="mb-1.5 text-xl text-berry">{props.copy.safety.title}</h3>
          <p class="text-[length:15px] text-bark-900">{props.copy.safety.text}</p>
          <p class="mt-2 text-[length:15px] text-bark-800">{props.copy.safety.wip}</p>
        </div>
      </div>
      <div class="mt-7 grid grid-cols-[minmax(0,1fr)] lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)] items-start gap-7">
        <div data-reveal class="rounded-lg border border-border-soft/45 bg-card [box-shadow:var(--inset-shadow-rim),_var(--shadow-card)] p-6">
          <h3 class="text-xl">{props.copy.start.needs}</h3>
          <ul class="mt-3">
            {props.copy.start.list.map((item) => (
              <li class="flex items-start gap-2.5 py-1.5 text-[length:15px] text-bark-900">
                <Icon name="check" class="mt-1 w-4.5 h-4.5 flex-none text-leaf-600" />
                {item}
              </li>
            ))}
          </ul>
        </div>
        <div data-reveal class="rounded-lg border border-border-soft/45 bg-card [box-shadow:var(--inset-shadow-rim),_var(--shadow-card)] p-6">
          <div class="flex items-center justify-between gap-3">
            <h3 class="text-xl">{props.copy.start.build}</h3>
            <CopyButton text={props.commands.join("\n")} label={props.copy.start.copy} done={props.copy.start.copied} />
          </div>
          <pre class="mt-3.5 whitespace-pre-wrap wrap-anywhere rounded-md border border-bark-800 bg-bark-900 px-5 py-4.5 font-mono text-sm leading-[1.8] text-cream-50 shadow-card-sm">
            {props.commands.map((c) => (
              <span class="block">
                <span class="text-lantern select-none">$ </span>
                {c}
              </span>
            ))}
          </pre>
          <p class="mt-3.5 text-[length:15px] text-bark-800">
            {props.copy.start.more}{" "}
            <a href={props.readme} class="underline decoration-border-soft/60 underline-offset-4 hover:text-bark-900">
              {props.copy.start.readme}
            </a>
          </p>
        </div>
      </div>
    </Section>
  );
}

function CopyButton(props: { text: string; label: string; done: string }) {
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
      class="inline-flex h-8 cursor-pointer items-center overflow-hidden rounded-sm border border-border-soft/55 bg-cream-50 hover:bg-cream-hover px-2.5 font-sans text-xs font-semibold leading-none text-bark-900 shadow-card-sm transition-[background-color] ease-out duration-200"
    >
      <Presence
        value={copied() ? "done" : "copy"}
        initial={false}
        enter={{ y: [12, 0], opacity: [0, 1] }}
        exit={{ y: -12, opacity: 0 }}
        transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
      >
        {(value, ref) => (
          <span ref={ref} class="inline-flex items-center gap-1.5">
            <Icon name={value === "done" ? "check" : "copy"} class="w-3.5 h-3.5" />
            {value === "done" ? props.done : props.label}
          </span>
        )}
      </Presence>
      <span class="[clip-path:inset(50%)] whitespace-nowrap border-0 w-px h-px -m-px p-0 absolute overflow-hidden" aria-live="polite">
        {copied() ? props.done : ""}
      </span>
    </button>
  );
}
