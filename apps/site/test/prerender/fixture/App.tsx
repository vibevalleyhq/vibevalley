/** @jsxImportSource @solidjs/web */
import { getRequestEvent } from "@solidjs/web";
import { createSignal, Show } from "solid-js";

import Counter from "./Counter";

import "./page.css";

export default function App() {
  const path = new URL(getRequestEvent()?.request.url ?? window.location.href).pathname;
  const [visible, setVisible] = createSignal(true);
  return (
    <main data-testid="page">
      <h1>{path === "/404.html" ? "Not found" : path === "/en/" ? "English home" : "Chinese home"}</h1>
      <button data-testid="toggle" onClick={() => setVisible((value) => !value)}>
        Toggle
      </button>
      <Show when={visible()}>
        <Counter id="top" initial={3} label="Name" extra={<span data-testid="extra">Even count</span>}>
          <span data-testid="child">Server content</span>
        </Counter>
      </Show>
      <div class="below">
        <Counter id="bottom" initial={7} label="Second name" />
      </div>
      <a href="/en/" data-testid="language">
        English
      </a>
    </main>
  );
}
