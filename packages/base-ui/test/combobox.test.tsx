import { createSignal, For } from "solid-js";
import { expect, test } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { Combobox } from "../src/index";
import { $, expectAccessible, mount, settle } from "./render";

const runtimes = ["Pi", "Codex", "Claude Code", "Gemini"];

function View(props: { picked: string[] }) {
  const [text, setText] = createSignal("");
  const shown = () => runtimes.filter((r) => r.toLowerCase().includes(text().toLowerCase()));
  return (
    <Combobox.Root inputValue={text()} onInputValueChange={setText} onValueChange={(v) => props.picked.push(v)}>
      <Combobox.Input aria-label="runtime" data-testid="input" />
      <Combobox.Portal>
        <Combobox.Positioner>
          <Combobox.Popup aria-label="runtimes" data-testid="list">
            <For each={shown()}>
              {(r) => (
                <Combobox.Item value={r} disabled={r === "Gemini"}>
                  {r}
                </Combobox.Item>
              )}
            </For>
            <Combobox.Empty data-testid="empty">none</Combobox.Empty>
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  );
}

const active = () => {
  const input = $("[data-testid=input]");
  const id = input.getAttribute("aria-activedescendant");
  return id ? document.getElementById(id)?.dataset.value : undefined;
};

test("typing opens the list on the first match; arrows move the highlight while the focus stays in the input; Enter picks", async () => {
  const picked: string[] = [];
  mount(() => <View picked={picked} />);
  const input = $<HTMLInputElement>("[data-testid=input]");
  await userEvent.click(input);
  await userEvent.keyboard("c");
  await settle();
  expect([input.getAttribute("aria-expanded"), active(), document.activeElement]).toEqual(["true", "Codex", input]);
  await userEvent.keyboard("{ArrowDown}");
  await settle();
  expect(active()).toBe("Claude Code");
  expect(document.getElementById(input.getAttribute("aria-activedescendant")!)!.hasAttribute("data-highlighted")).toBe(true);
  await expectAccessible();
  await userEvent.keyboard("{Enter}");
  await settle();
  expect([picked, input.value, document.querySelector("[data-testid=list]"), document.activeElement]).toEqual([["Claude Code"], "Claude Code", null, input]);
});

test("arrows skip disabled options, a click picks without taking the focus, and nothing matching shows Empty", async () => {
  const picked: string[] = [];
  mount(() => <View picked={picked} />);
  const input = $<HTMLInputElement>("[data-testid=input]");
  input.focus();
  await userEvent.keyboard("{ArrowUp}");
  await settle();
  expect(active()).toBe("Claude Code");
  await userEvent.click($("[data-value=Pi]"));
  await settle();
  expect([picked, input.value, document.activeElement]).toEqual([["Pi"], "Pi", input]);
  await userEvent.clear(input);
  await userEvent.keyboard("zz");
  await settle();
  expect([document.querySelector("[data-testid=empty]") !== null, active()]).toEqual([true, undefined]);
  await userEvent.keyboard("{Escape}");
  await settle();
  expect(document.querySelector("[data-testid=list]")).toBe(null);
});
