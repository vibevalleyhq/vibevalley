import { expect, test } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { ContextMenu, PreviewCard } from "../src/index";
import { $, expectAccessible, mount, settle } from "./render";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("a right click opens the menu at the pointer; an item runs and the focus goes back to the area", async () => {
  const ran: string[] = [];
  mount(() => (
    <ContextMenu.Root>
      <ContextMenu.Trigger data-testid="area" tabindex={0} style={{ width: "300px", height: "200px" }}>
        right click here
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Positioner data-testid="positioner">
          <ContextMenu.Popup aria-label="message" data-testid="menu">
            <ContextMenu.Item data-key="copy" onClick={() => ran.push("copy")}>
              Copy
            </ContextMenu.Item>
            <ContextMenu.Item data-key="pin">Pin</ContextMenu.Item>
          </ContextMenu.Popup>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  ));
  const area = $("[data-testid=area]");
  const box = area.getBoundingClientRect();
  await userEvent.click(area, { button: "right", position: { x: 120, y: 80 } });
  await settle();
  await settle();
  const placed = $("[data-testid=positioner]").getBoundingClientRect();
  expect([Math.round(placed.left - box.left), Math.round(placed.top - box.top) >= 80, document.activeElement]).toEqual([120, true, $("[data-testid=menu]")]);
  await expectAccessible();
  await userEvent.keyboard("{ArrowDown}{Enter}");
  await settle();
  expect([ran, document.querySelector("[data-testid=menu]"), document.activeElement]).toEqual([["copy"], null, area]);

  area.focus();
  await userEvent.keyboard("{Shift>}{F10}{/Shift}");
  await settle();
  expect((document.activeElement as HTMLElement).dataset.key).toBe("copy");
});

const card = (said: string[] = []) => (
  <>
    <button data-testid="before">before</button>
    <PreviewCard.Root delay={50} closeDelay={50} onOpenChange={(open, why) => said.push(`${open}:${why}`)}>
      <PreviewCard.Trigger href="#issue-12" data-testid="link" style={{ "margin-top": "40px", display: "inline-block" }}>
        #12
      </PreviewCard.Trigger>
      <PreviewCard.Portal>
        <PreviewCard.Positioner>
          <PreviewCard.Popup data-testid="card" style={{ width: "200px", height: "80px" }}>
            <a href="#open">open it</a>
          </PreviewCard.Popup>
        </PreviewCard.Positioner>
      </PreviewCard.Portal>
    </PreviewCard.Root>
  </>
);

const shown = () => document.querySelector("[data-testid=card]") !== null;

test("a preview card shows after the pointer rests on its link, and stays while the pointer moves onto it", async () => {
  const said: string[] = [];
  mount(() => card(said));
  await userEvent.hover($("[data-testid=link]"));
  await settle();
  expect(shown()).toBe(false);
  await wait(100);
  await settle();
  expect(shown()).toBe(true);
  await userEvent.hover($("[data-testid=card]"));
  await wait(100);
  await settle();
  expect(shown()).toBe(true);
  await userEvent.hover($("[data-testid=before]"));
  await wait(100);
  await settle();
  expect([shown(), said]).toEqual([false, ["true:hover", "false:hover"]]);
});

test("the keyboard's focus shows it, and Escape hides it", async () => {
  mount(() => card());
  $("[data-testid=before]").focus();
  await userEvent.tab();
  await wait(100);
  await settle();
  expect(shown()).toBe(true);
  await expectAccessible();
  await userEvent.keyboard("{Escape}");
  await settle();
  expect(shown()).toBe(false);
});
