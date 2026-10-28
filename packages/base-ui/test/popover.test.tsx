import { expect, test } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { Popover, type PopoverOpenChangeReason } from "../src/index.ts";
import { $, mount, settle } from "./render.tsx";

const view = (said: PopoverOpenChangeReason[], side?: "top" | "bottom") => (
  <>
    <button data-testid="elsewhere">elsewhere</button>
    <Popover.Root onOpenChange={(_, why) => said.push(why)}>
      <Popover.Trigger data-testid="trigger">display</Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side={side} data-testid="positioner">
          <Popover.Popup data-testid="popup">
            <Popover.Title>Display</Popover.Title>
            <input aria-label="filter" />
            <Popover.Close data-testid="close">done</Popover.Close>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  </>
);

test("the trigger opens it against itself, says it is open, and the focus goes inside", async () => {
  mount(() => view([]));
  const trigger = $("[data-testid=trigger]");
  expect([trigger.getAttribute("aria-expanded"), document.querySelector("[data-testid=popup]")]).toEqual(["false", null]);
  await userEvent.click(trigger);
  await settle();
  const popup = $("[data-testid=popup]");
  const positioner = $("[data-testid=positioner]");
  expect([trigger.getAttribute("aria-expanded"), trigger.getAttribute("aria-controls"), trigger.hasAttribute("data-popup-open")]).toEqual([
    "true",
    popup.id,
    true,
  ]);
  expect([popup.getAttribute("role"), popup.hasAttribute("data-open"), positioner.dataset.side]).toEqual(["dialog", true, "bottom"]);
  expect($(`#${popup.getAttribute("aria-labelledby")}`).textContent).toBe("Display");
  expect(positioner.getBoundingClientRect().top).toBeGreaterThanOrEqual(trigger.getBoundingClientRect().bottom);
  expect(document.activeElement).toBe($("input"));
});

test("Escape and the close button give the focus back to the trigger; a press outside does not take it", async () => {
  const said: PopoverOpenChangeReason[] = [];
  mount(() => view(said));
  const trigger = $("[data-testid=trigger]");
  await userEvent.click(trigger);
  await settle();
  await userEvent.keyboard("{Escape}");
  await settle();
  expect([document.querySelector("[data-testid=popup]"), document.activeElement]).toEqual([null, trigger]);

  await userEvent.click(trigger);
  await settle();
  await userEvent.click($("[data-testid=close]"));
  await settle();
  expect(document.activeElement).toBe(trigger);

  await userEvent.click(trigger);
  await settle();
  await userEvent.click($("[data-testid=elsewhere]"));
  await settle();
  expect([document.querySelector("[data-testid=popup]"), document.activeElement]).toEqual([null, $("[data-testid=elsewhere]")]);
  expect(said).toEqual(["trigger", "escape", "trigger", "close", "trigger", "outside"]);
});

test("a popup with no room below turns to the top", async () => {
  mount(() => view([]));
  const trigger = $("[data-testid=trigger]");
  trigger.style.cssText = "position: fixed; bottom: 4px; left: 40px";
  await userEvent.click(trigger);
  await settle();
  await settle();
  const positioner = $("[data-testid=positioner]");
  expect(positioner.dataset.side).toBe("top");
  expect(positioner.getBoundingClientRect().bottom).toBeLessThanOrEqual(trigger.getBoundingClientRect().top);
});

test("a controlled popover opens only when its owner says so", async () => {
  const said: boolean[] = [];
  mount(() => (
    <Popover.Root open={false} onOpenChange={(open) => said.push(open)}>
      <Popover.Trigger data-testid="trigger">display</Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner>
          <Popover.Popup data-testid="popup">inside</Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  ));
  await userEvent.click($("[data-testid=trigger]"));
  await settle();
  expect([said, document.querySelector("[data-testid=popup]")]).toEqual([[true], null]);
});
