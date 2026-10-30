import { expect, test } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { Tabs } from "../src/index";
import { $, mount, settle } from "./render";

const tabs = (activate = false, onValueChange?: (v: string) => void) => (
  <Tabs.Root onValueChange={onValueChange}>
    <Tabs.List activateOnFocus={activate}>
      <Tabs.Tab value="one">One</Tabs.Tab>
      <Tabs.Tab value="two">Two</Tabs.Tab>
      <Tabs.Tab value="three" disabled>
        Three
      </Tabs.Tab>
    </Tabs.List>
    <Tabs.Panel value="one">first</Tabs.Panel>
    <Tabs.Panel value="two">second</Tabs.Panel>
    <Tabs.Panel value="three">third</Tabs.Panel>
  </Tabs.Root>
);

const tab = (v: string) => $(`[role=tab][data-value=${v}]`);

test("the first tab is selected to begin with, and tabs and panels name each other", async () => {
  mount(() => tabs());
  await settle();
  expect([tab("one").getAttribute("aria-selected"), tab("one").tabIndex, tab("two").tabIndex]).toEqual(["true", 0, -1]);
  const panel = $("[role=tabpanel]");
  expect([panel.textContent, panel.id, panel.getAttribute("aria-labelledby")]).toEqual(["first", tab("one").getAttribute("aria-controls"), tab("one").id]);
});

test("arrows move the focus, skipping the disabled tab and wrapping; Enter selects", async () => {
  const said: string[] = [];
  mount(() => tabs(false, (v) => said.push(v)));
  await settle();
  tab("one").focus();
  await userEvent.keyboard("{ArrowRight}");
  expect(document.activeElement).toBe(tab("two"));
  // Focus alone does not select without activateOnFocus.
  await settle();
  expect(tab("one").getAttribute("aria-selected")).toBe("true");
  await userEvent.keyboard("{ArrowRight}");
  expect(document.activeElement).toBe(tab("one"));
  await userEvent.keyboard("{End}");
  expect(document.activeElement).toBe(tab("two"));
  await userEvent.keyboard("{Enter}");
  await settle();
  expect([tab("two").hasAttribute("data-selected"), $("[role=tabpanel]").textContent, said]).toEqual([true, "second", ["two"]]);
});

test("with activateOnFocus the arrows select as they move", async () => {
  mount(() => tabs(true));
  await settle();
  tab("one").focus();
  await userEvent.keyboard("{ArrowRight}");
  await settle();
  expect($("[role=tabpanel]").textContent).toBe("second");
});

test("tabs with no panels claim none, and a tab rendered as a link keeps its address", async () => {
  mount(() => (
    <Tabs.Root defaultValue="b">
      <Tabs.List aria-label="shelves">
        <Tabs.Tab value="a" render={(p) => <a {...p} href="#a" />}>
          a
        </Tabs.Tab>
        <Tabs.Tab value="b" render={(p) => <a {...p} href="#b" />}>
          b
        </Tabs.Tab>
      </Tabs.List>
    </Tabs.Root>
  ));
  await settle();
  const a = $("[data-value=a]");
  expect([a.tagName, a.getAttribute("href"), a.hasAttribute("aria-controls"), a.hasAttribute("type")]).toEqual(["A", "#a", false, false]);
  await userEvent.click(a);
  await settle();
  expect(a.getAttribute("aria-selected")).toBe("true");
});
