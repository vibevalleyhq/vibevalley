import { createSignal } from "solid-js";
import { expect, test } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { Checkbox, Switch, Toggle, ToggleGroup } from "../src/index";
import { $, mount, settle } from "./render";

const has = (el: Element, attr: string) => el.hasAttribute(attr);

test("a switch turns on and off by click and Space, and says so to the root and the thumb", async () => {
  const said: boolean[] = [];
  mount(() => (
    <Switch.Root onCheckedChange={(v) => said.push(v)}>
      <Switch.Thumb />
    </Switch.Root>
  ));
  const root = $("[role=switch]");
  expect([root.getAttribute("aria-checked"), has(root, "data-unchecked"), has($("span"), "data-unchecked")]).toEqual(["false", true, true]);
  await userEvent.click(root);
  await settle();
  expect([root.getAttribute("aria-checked"), has(root, "data-checked"), has($("span"), "data-checked")]).toEqual(["true", true, true]);
  await userEvent.keyboard(" ");
  await settle();
  expect(root.getAttribute("aria-checked")).toBe("false");
  expect(said).toEqual([true, false]);
});

test("a read-only or disabled switch does not change", async () => {
  mount(() => (
    <>
      <Switch.Root readOnly data-testid="ro" />
      <Switch.Root disabled data-testid="off" />
    </>
  ));
  await userEvent.click($("[data-testid=ro]"));
  await settle();
  expect($("[data-testid=ro]").getAttribute("aria-checked")).toBe("false");
  expect(has($("[data-testid=off]"), "data-disabled")).toBe(true);
});

test("a checkbox is checked, unchecked or mixed, and its indicator shows only when there is a mark", async () => {
  const [mixed, setMixed] = createSignal(true);
  mount(() => (
    <Checkbox.Root indeterminate={mixed()} onCheckedChange={() => setMixed(false)}>
      <Checkbox.Indicator>✓</Checkbox.Indicator>
    </Checkbox.Root>
  ));
  const box = $("[role=checkbox]");
  expect([box.getAttribute("aria-checked"), has(box, "data-indeterminate"), box.textContent]).toEqual(["mixed", true, "✓"]);
  await userEvent.click(box);
  await settle();
  expect([box.getAttribute("aria-checked"), has(box, "data-checked")]).toEqual(["true", true]);
  await userEvent.click(box);
  await settle();
  expect([box.getAttribute("aria-checked"), box.textContent]).toEqual(["false", ""]);
});

test("a toggle is pressed and released", async () => {
  mount(() => <Toggle>bold</Toggle>);
  await userEvent.click($("button"));
  await settle();
  expect([$("button").getAttribute("aria-pressed"), has($("button"), "data-pressed")]).toEqual(["true", true]);
});

test("a toggle group keeps one value, moves by arrows with one tab stop, and with multiple keeps several", async () => {
  const said: string[][] = [];
  mount(() => (
    <>
      <ToggleGroup defaultValue={["b"]} onValueChange={(v) => said.push(v)} data-testid="one">
        <Toggle value="a">A</Toggle>
        <Toggle value="b">B</Toggle>
        <Toggle value="c" disabled>
          C
        </Toggle>
      </ToggleGroup>
      <ToggleGroup multiple data-testid="many">
        <Toggle value="x">X</Toggle>
        <Toggle value="y">Y</Toggle>
      </ToggleGroup>
    </>
  ));
  const one = (v: string) => $(`[data-testid=one] [data-value=${v}]`);
  expect([one("a").tabIndex, one("b").tabIndex]).toEqual([-1, 0]);
  await userEvent.click(one("a"));
  await settle();
  expect([one("a").getAttribute("aria-pressed"), one("b").getAttribute("aria-pressed")]).toEqual(["true", "false"]);
  expect(said).toEqual([["a"]]);
  // From A, right skips the disabled C and wraps back to A past B.
  one("a").focus();
  await userEvent.keyboard("{ArrowRight}");
  expect(document.activeElement).toBe(one("b"));
  await userEvent.keyboard("{ArrowRight}");
  expect(document.activeElement).toBe(one("a"));

  await userEvent.click($("[data-testid=many] [data-value=x]"));
  await userEvent.click($("[data-testid=many] [data-value=y]"));
  await settle();
  expect([...document.querySelectorAll("[data-testid=many] [data-pressed]")].map((e) => e.textContent)).toEqual(["X", "Y"]);
});
