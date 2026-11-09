/** @jsxImportSource @solidjs/web */
import type { JSX } from "@solidjs/web";
import { createSignal, createUniqueId, onSettled, Show } from "solid-js";

export default function Counter(props: { id: string; initial: number; children?: JSX.Element; label?: JSX.Element; extra?: JSX.Element }) {
  const [count, setCount] = createSignal(props.initial);
  const inputId = createUniqueId();
  let root: HTMLElement | undefined;
  onSettled(() => {
    const element = root!;
    element.dataset.ready = "true";
    const listener = () => {
      element.dataset.pings = String(Number(element.dataset.pings ?? 0) + 1);
    };
    window.addEventListener("probe-ping", listener);
    return () => {
      window.removeEventListener("probe-ping", listener);
      element.dataset.disposed = "true";
    };
  });
  return (
    <section
      ref={(el) => {
        root = el;
      }}
      data-testid={props.id}
    >
      <label for={inputId}>{props.label}</label>
      <input id={inputId} data-testid="input" />
      <button type="button" data-testid="increment" onClick={() => setCount((value) => value + 1)}>
        Increment
      </button>
      <output data-testid="count">{count()}</output>
      <span data-testid="initial">{props.initial}</span>
      <div data-testid="slot">{props.children}</div>
      <Show when={count() % 2 === 0}>{props.extra}</Show>
    </section>
  );
}
