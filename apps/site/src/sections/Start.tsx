import { steps } from "motion";
import { createSignal, onCleanup } from "solid-js";

import type { Copy } from "../i18n/zh";
import { Presence } from "../ui/Presence";
import { createReveal } from "../ui/scroll";
import { Section } from "../ui/ui";

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
        <div
          data-reveal
          role="note"
          class="flex items-start gap-5 border-2 border-bark-900 bg-(--color-warn) [box-shadow:inset_0_0_0_2px_var(--color-rim),_4px_4px_0_var(--color-drop)] p-6"
        >
          <img loading="lazy" src={props.icons.warn} alt="" class="w-12 h-12 flex-none object-contain [image-rendering:pixelated]" />
          <div>
            <h3 class="mb-1.5 text-2xl text-berry">{props.copy.safety.title}</h3>
            <p class="text-base">{props.copy.safety.text}</p>
            <p class="mt-2 text-base">{props.copy.safety.wip}</p>
          </div>
        </div>
        <div class="mt-7 grid grid-cols-[minmax(0,1fr)] lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)] items-start gap-7">
          <div data-reveal class="border-2 border-bark-900 bg-cream-50 [box-shadow:inset_0_0_0_2px_var(--color-rim),_4px_4px_0_var(--color-drop)] p-6">
            <h3 class="text-2xl">{props.copy.start.needs}</h3>
            <ul class="mt-3">
              {props.copy.start.list.map((item) => (
                <li class="flex items-start gap-2.5 py-1.5 text-base">
                  <img loading="lazy" src={props.icons.check} alt="" class="mt-1.25 w-5 h-5 flex-none object-contain [image-rendering:pixelated]" />
                  {item}
                </li>
              ))}
            </ul>
          </div>
          <div data-reveal class="border-2 border-bark-900 bg-cream-50 [box-shadow:inset_0_0_0_2px_var(--color-rim),_4px_4px_0_var(--color-drop)] p-6">
            <div class="flex items-center justify-between gap-3">
              <h3 class="text-2xl">{props.copy.start.build}</h3>
              <CopyButton
                text={props.commands.join("\n")}
                icon={props.icons.copy}
                check={props.icons.check}
                label={props.copy.start.copy}
                done={props.copy.start.copied}
              />
            </div>
            <pre class="mt-3.5 overflow-x-auto border-2 border-bark-900 bg-bark-900 px-5 py-4.5 font-mono text-sm leading-[1.8] text-cream-50 [box-shadow:inset_0_0_0_2px_var(--color-bark-600)]">
              {props.commands.map((c) => (
                <span class="block">
                  <span class="text-wheat select-none">$ </span>
                  {c}
                </span>
              ))}
            </pre>
            <p class="mt-3.5 text-[length:15px] text-bark-800">
              {props.copy.start.more}{" "}
              <a href={props.readme} class="underline">
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
      class="inline-flex h-8 cursor-pointer items-center overflow-hidden border-2 border-bark-900 bg-cream-50 hover:bg-cream-hover px-2 font-pixel text-sm leading-none text-bark-900"
    >
      <Presence
        value={copied() ? "done" : "copy"}
        initial={false}
        enter={{ y: [14, 0], opacity: [0, 1] }}
        exit={{ y: -14, opacity: 0 }}
        transition={{ duration: 0.2, ease: steps(3) }}
      >
        {(value, ref) => (
          <span ref={ref} class="inline-flex items-center gap-1.5">
            <img src={value === "done" ? props.check : props.icon} alt="" class="w-4 h-4 object-contain [image-rendering:pixelated]" />
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
