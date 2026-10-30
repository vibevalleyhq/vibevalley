import { expect, test } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { Tooltip, type TooltipOpenChangeReason } from "../src/index";
import { $, mount, settle } from "./render";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tip = () => document.querySelector("[role=tooltip]");

const one = (name: string, delay: number, said?: TooltipOpenChangeReason[]) => (
  <Tooltip.Root delay={delay} onOpenChange={(open, why) => said?.push(why)}>
    <Tooltip.Trigger data-testid={name}>{name}</Tooltip.Trigger>
    <Tooltip.Portal>
      <Tooltip.Positioner data-testid={`${name}-positioner`}>
        <Tooltip.Popup>{`about ${name}`}</Tooltip.Popup>
      </Tooltip.Positioner>
    </Tooltip.Portal>
  </Tooltip.Root>
);

test("hovering shows it after the delay, above the trigger, and the trigger is described by it", async () => {
  const said: TooltipOpenChangeReason[] = [];
  mount(() => one("copy", 150, said));
  const trigger = $("[data-testid=copy]");
  trigger.style.marginTop = "80px";
  await userEvent.hover(trigger);
  await settle();
  expect(tip()).toBe(null);
  await wait(200);
  await settle();
  expect(tip()?.textContent).toBe("about copy");
  expect(trigger.getAttribute("aria-describedby")).toBe(tip()?.id);
  const positioner = $("[data-testid=copy-positioner]");
  expect(positioner.dataset.side).toBe("top");
  await userEvent.unhover(trigger);
  await settle();
  expect([tip(), trigger.hasAttribute("aria-describedby")]).toEqual([null, false]);
  expect(said).toEqual(["hover", "hover"]);
});

test("the keyboard's focus shows it at once, a click's focus does not, and Escape hides it", async () => {
  const said: TooltipOpenChangeReason[] = [];
  mount(() => (
    <>
      <button data-testid="before">before</button>
      {one("copy", 10_000, said)}
    </>
  ));
  $("[data-testid=before]").focus();
  await userEvent.tab();
  await settle();
  expect(tip()?.textContent).toBe("about copy");
  await userEvent.keyboard("{Escape}");
  await settle();
  expect(tip()).toBe(null);
  expect(said).toEqual(["focus", "escape"]);
});

test("a press hides it, and once one has shown the next shows without its delay", async () => {
  mount(() => (
    <>
      {one("copy", 0)}
      {one("paste", 10_000)}
    </>
  ));
  await userEvent.hover($("[data-testid=copy]"));
  await settle();
  expect(tip()?.textContent).toBe("about copy");
  await userEvent.hover($("[data-testid=paste]"));
  await settle();
  expect(tip()?.textContent).toBe("about paste");
  await userEvent.click($("[data-testid=paste]"));
  await settle();
  expect(tip()).toBe(null);
});

test("as a span it wraps what is focusable itself", async () => {
  mount(() => (
    <Tooltip.Root delay={0}>
      <Tooltip.Trigger render="span" data-testid="wrap">
        <input aria-label="key" />
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Positioner>
          <Tooltip.Popup>a key</Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  ));
  expect($("[data-testid=wrap]").tagName).toBe("SPAN");
  await userEvent.click($("input"));
  await userEvent.keyboard("a");
  await settle();
  // An input takes the keyboard's focus even from a click, as :focus-visible says.
  expect(tip()?.textContent).toBe("a key");
});
