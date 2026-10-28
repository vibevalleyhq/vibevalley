import { expect, test } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { Menu, type MenuOpenChangeReason } from "../src/index";
import { $, mount, settle } from "./render";

const view = (ran: string[], said: MenuOpenChangeReason[] = []) => (
  <>
    <button data-testid="elsewhere">elsewhere</button>
    <Menu.Root onOpenChange={(_, why) => said.push(why)}>
      <Menu.Trigger data-testid="trigger">more</Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner>
          <Menu.Popup data-testid="menu">
            <Menu.Item data-key="reply" onClick={() => ran.push("reply")}>
              Reply
            </Menu.Item>
            <Menu.Item data-key="copy" onClick={() => ran.push("copy")}>
              Copy
            </Menu.Item>
            <Menu.Item data-key="pin" disabled onClick={() => ran.push("pin")}>
              Pin
            </Menu.Item>
            <Menu.Separator />
            <Menu.Group>
              <Menu.GroupLabel>Danger</Menu.GroupLabel>
              <Menu.Item data-key="delete" onClick={() => ran.push("delete")}>
                Delete
              </Menu.Item>
            </Menu.Group>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  </>
);

const focused = () => (document.activeElement as HTMLElement | null)?.dataset.key;

test("a click opens it with the focus on the menu, named by its trigger; an item runs and closes it", async () => {
  const ran: string[] = [];
  const said: MenuOpenChangeReason[] = [];
  mount(() => view(ran, said));
  const trigger = $("[data-testid=trigger]");
  expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
  await userEvent.click(trigger);
  await settle();
  const menu = $("[data-testid=menu]");
  expect([document.activeElement, menu.getAttribute("aria-labelledby"), trigger.getAttribute("aria-controls")]).toEqual([menu, trigger.id, menu.id]);
  await userEvent.click($("[data-key=copy]"));
  await settle();
  expect([ran, document.querySelector("[data-testid=menu]"), document.activeElement]).toEqual([["copy"], null, trigger]);
  expect(said).toEqual(["trigger", "item"]);
});

test("from the keyboard the arrows move along the items, past disabled ones, wrapping; Enter runs one", async () => {
  const ran: string[] = [];
  mount(() => view(ran));
  $("[data-testid=trigger]").focus();
  await userEvent.keyboard("{ArrowDown}");
  await settle();
  expect(focused()).toBe("reply");
  expect($("[data-key=reply]").hasAttribute("data-highlighted")).toBe(true);
  await userEvent.keyboard("{ArrowDown}{ArrowDown}");
  expect(focused()).toBe("delete");
  await userEvent.keyboard("{ArrowDown}");
  expect(focused()).toBe("reply");
  await userEvent.keyboard("{End}{ArrowUp}");
  expect(focused()).toBe("copy");
  await userEvent.keyboard("{Enter}");
  await settle();
  expect(ran).toEqual(["copy"]);
});

test("ArrowUp opens on the last item, letters jump, a disabled item does nothing, Escape and Tab give the focus back", async () => {
  const ran: string[] = [];
  mount(() => view(ran));
  const trigger = $("[data-testid=trigger]");
  trigger.focus();
  await userEvent.keyboard("{ArrowUp}");
  await settle();
  expect(focused()).toBe("delete");
  await userEvent.keyboard("c");
  expect(focused()).toBe("copy");
  // Playwright will not click what says it is disabled; the DOM will.
  $("[data-key=pin]").click();
  await settle();
  expect([ran, document.querySelector("[data-testid=menu]") !== null]).toEqual([[], true]);
  await userEvent.keyboard("{Escape}");
  await settle();
  expect([document.querySelector("[data-testid=menu]"), document.activeElement]).toEqual([null, trigger]);

  await userEvent.keyboard("{Enter}");
  await settle();
  expect(focused()).toBe("reply");
  await userEvent.keyboard("{Tab}");
  await settle();
  expect(document.querySelector("[data-testid=menu]")).toBe(null);
});

test("the pointer highlights what it is over, and a press outside closes it without taking the focus back", async () => {
  mount(() => view([]));
  await userEvent.click($("[data-testid=trigger]"));
  await settle();
  await userEvent.hover($("[data-key=delete]"));
  await settle();
  expect($("[data-key=delete]").hasAttribute("data-highlighted")).toBe(true);
  await userEvent.click($("[data-testid=elsewhere]"));
  await settle();
  expect([document.querySelector("[data-testid=menu]"), document.activeElement]).toEqual([null, $("[data-testid=elsewhere]")]);
});
