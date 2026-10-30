import { createSignal } from "solid-js";
import { expect, test } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { Collapsible } from "../src/index";
import { $, mount, settle } from "./render";

test("the trigger opens and closes its panel, saying so in ARIA and data attributes", async () => {
  mount(() => (
    <Collapsible.Root data-testid="root">
      <Collapsible.Trigger>more</Collapsible.Trigger>
      <Collapsible.Panel>the rest</Collapsible.Panel>
    </Collapsible.Root>
  ));
  const trigger = $("button");
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(document.body.textContent).not.toContain("the rest");
  expect($("[data-testid=root]").hasAttribute("data-closed")).toBe(true);
  await userEvent.click(trigger);
  await settle();
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  expect(trigger.hasAttribute("data-panel-open")).toBe(true);
  const panel = $(`#${trigger.getAttribute("aria-controls")}`);
  expect(panel.textContent).toBe("the rest");
  expect($("[data-testid=root]").hasAttribute("data-open")).toBe(true);
  await userEvent.keyboard("{Enter}");
  await settle();
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
});

test("an owner controls it, and a kept panel is only hidden", async () => {
  const [open, setOpen] = createSignal(true);
  const said: boolean[] = [];
  mount(() => (
    <Collapsible.Root open={open()} onOpenChange={(v) => said.push(v)}>
      <Collapsible.Trigger>more</Collapsible.Trigger>
      <Collapsible.Panel keepMounted>kept</Collapsible.Panel>
    </Collapsible.Root>
  ));
  await userEvent.click($("button"));
  await settle();
  // Asked, but the owner did not change it.
  expect(said).toEqual([false]);
  expect($("button").getAttribute("aria-expanded")).toBe("true");
  setOpen(false);
  await settle();
  expect(document.body.textContent).toContain("kept");
  expect($("[data-closed][hidden]").textContent).toBe("kept");
});
